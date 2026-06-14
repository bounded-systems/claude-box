/**
 * ocap tests (prx-8ab) — assert the claude-box capability surface, so "the box
 * is isolated" is VERIFIED, not eyeballed (cf. the "don't overclaim secure"
 * rule). These run the built image (`localhost/claude-personal:dev`) under each
 * grant profile and assert what is / isn't reachable.
 *
 *   nix run nixpkgs#bun -- test tests/ocap.test.ts
 *
 * Needs the image loaded (`nix build .#claude-image && podman load -i result`)
 * and a running container runtime (rootless podman).
 *
 * Tests are structured in tiers:
 * - Default profile (no grants): always runs if podman + image available
 * - --repo / --repo-rw: runs if podman + image available (temp repos)
 * - Door tests (--keeper, --net, --scout): skip unless doors volume exists
 *
 * To run door tests, start the doors first:
 *   claude-box doors start
 */
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const IMAGE = "localhost/claude-personal:dev";

/** Run a shell line inside the box (default profile, no grants) and capture it. */
function box(script: string): { code: number; out: string } {
  return boxNet([], script);
}

/** Run a shell line inside the box under explicit podman flags (e.g. a network
 *  mode), so egress-grant profiles can be asserted, not eyeballed. */
function boxNet(podmanArgs: string[], script: string): { code: number; out: string } {
  const p = Bun.spawnSync(
    ["podman", "run", "--rm", ...podmanArgs, "--entrypoint", "sh", IMAGE, "-c", script],
    { stdout: "pipe", stderr: "pipe" },
  );
  return {
    code: p.exitCode,
    out: `${p.stdout.toString()}${p.stderr.toString()}`.trim(),
  };
}

// These assertions exercise the REAL image under podman; they can only run where
// the runtime + image are present (a Mac with `podman load -i result`). Where
// they aren't (CI without podman, a fresh checkout), skip rather than hard-fail
// so the default `bun test` stays green — the integration gate is environment,
// not a regression. Grant-profile cases below stay `test.todo` until the pod.
const RUNTIME_READY =
  Bun.spawnSync(["sh", "-c", `command -v podman >/dev/null 2>&1 && podman image exists ${IMAGE}`])
    .exitCode === 0;
const boxTest = test.skipIf(!RUNTIME_READY);

// ── least authority: the box runs unprivileged with no escalation ──
boxTest("runs non-root (uid 1000)", () => {
  expect(box("id -u").out).toBe("1000");
});

boxTest("no privilege-escalation / container tooling (sudo, docker, podman, kubectl)", () => {
  const found = box(
    "for c in sudo docker podman kubectl nsenter; do command -v $c >/dev/null 2>&1 && echo $c; done",
  ).out;
  expect(found).toBe(""); // none present
});

boxTest("no docker socket, no ambient daemon", () => {
  expect(box("test -S /var/run/docker.sock && echo present || echo absent").out).toBe("absent");
});

// ── the sanctioned tool surface IS present ──
boxTest("prx + claude are the sanctioned tools", () => {
  expect(box("command -v prx >/dev/null && command -v claude >/dev/null && echo ok").out).toBe("ok");
});

boxTest("prx is really prx (not bare bun — patchelf-corruption regression guard)", () => {
  expect(box("prx --version").out).toContain("v0.10");
});

// ── network is a door, not a NIC ──
// Default profile launches with --network=none: no ambient egress to exfiltrate
// through. (box() runs the image directly, so assert under that flag here.)
boxTest("default: --network=none has no egress (exfil has no route)", () => {
  const p = Bun.spawnSync(
    ["podman", "run", "--rm", "--network=none", "--entrypoint", "sh", IMAGE,
     "-c", "getent hosts api.anthropic.com >/dev/null 2>&1 && echo reachable || echo offline"],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(`${p.stdout.toString()}${p.stderr.toString()}`.trim()).toContain("offline");
});

// ── egress is a grant: a container bounds what the box WRITES, not what it
//    REACHES, so no door ⇒ no network (--network=none, the launcher default).
//    socat is in the box only to RELAY the netd door — it grants no egress. ──
boxTest("no door ⇒ no egress (api.anthropic.com unreachable under --network=none)", () => {
  const r = boxNet(
    ["--network=none"],
    `bun -e 'fetch("https://api.anthropic.com").then(()=>process.exit(0)).catch(()=>process.exit(7))'`,
  );
  expect(r.code).not.toBe(0); // no route off the box — nothing to exfiltrate THROUGH
});

// ── --repo grant profile: .git read-only, worktree writable ──
// This closes the host-RCE escape — the box can't plant a hook/config that runs
// on the host. These tests create a temp repo and mount it.

// Root temp repos under $HOME, NOT /tmp. These dirs get bind-mounted into the
// box, and on macOS podman runs in a Linux VM that only shares the user's home
// tree (/Users/$USER) — /tmp lives on the host and is invisible to the VM, so a
// `-v /tmp/...:/work` mount dies at `statfs ...: no such file or directory`
// (exit 125) before the container ever starts. $HOME is shared on macOS and is
// equally writable on native Linux (CI / the pod), so it works in both. Nest
// under the XDG cache dir to keep $HOME tidy rather than scattering dotdirs.
const TMP_BASE = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "claude-box");
function withTempRepo<T>(fn: (repoPath: string) => T): T {
  mkdirSync(TMP_BASE, { recursive: true }); // mkdtemp needs an existing parent
  const tmp = mkdtempSync(join(TMP_BASE, "ocap-repo-"));
  try {
    // Initialize a git repo
    Bun.spawnSync(["git", "init", tmp], { stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "-C", tmp, "config", "user.email", "test@test.com"], { stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "-C", tmp, "config", "user.name", "Test"], { stdout: "pipe", stderr: "pipe" });
    writeFileSync(join(tmp, "README.md"), "# Test repo\n");
    Bun.spawnSync(["git", "-C", tmp, "add", "."], { stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "-C", tmp, "commit", "-m", "init"], { stdout: "pipe", stderr: "pipe" });
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Run inside the box with a repo mounted at /work (--repo mode: .git read-only). */
function boxRepo(repoPath: string, script: string): { code: number; out: string } {
  const p = Bun.spawnSync(
    ["podman", "run", "--rm", "--network=none",
     "-v", `${repoPath}:/work`,
     "-v", `${repoPath}/.git:/work/.git:ro`,
     "-w", "/work",
     "--userns=keep-id:uid=1000,gid=1000",
     "--entrypoint", "sh", IMAGE, "-c", script],
    { stdout: "pipe", stderr: "pipe" },
  );
  return {
    code: p.exitCode,
    out: `${p.stdout.toString()}${p.stderr.toString()}`.trim(),
  };
}

/** Run inside the box with a repo mounted at /work (--repo-rw mode: .git writable). */
function boxRepoRw(repoPath: string, script: string): { code: number; out: string } {
  const p = Bun.spawnSync(
    ["podman", "run", "--rm", "--network=none",
     "-v", `${repoPath}:/work`,
     "-w", "/work",
     "--userns=keep-id:uid=1000,gid=1000",
     "--entrypoint", "sh", IMAGE, "-c", script],
    { stdout: "pipe", stderr: "pipe" },
  );
  return {
    code: p.exitCode,
    out: `${p.stdout.toString()}${p.stderr.toString()}`.trim(),
  };
}

boxTest("--repo: worktree files are writable", () => {
  withTempRepo((repo) => {
    const r = boxRepo(repo, "echo 'new content' > /work/newfile.txt && cat /work/newfile.txt");
    expect(r.code).toBe(0);
    expect(r.out).toContain("new content");
  });
});

boxTest("--repo: .git is read-only (write fails)", () => {
  withTempRepo((repo) => {
    const r = boxRepo(repo, "echo 'evil' > /work/.git/config 2>&1 || echo 'write failed'");
    expect(r.out).toContain("write failed");
  });
});

boxTest("--repo: can't create .git/hooks (host-RCE closed)", () => {
  withTempRepo((repo) => {
    const r = boxRepo(repo, "mkdir -p /work/.git/hooks 2>&1; echo '#!/bin/sh\necho pwned' > /work/.git/hooks/pre-commit 2>&1 || echo 'hook blocked'");
    expect(r.out).toContain("blocked");
  });
});

boxTest("--repo: git status works (read-only .git is readable)", () => {
  withTempRepo((repo) => {
    const r = boxRepo(repo, "cd /work && git status --porcelain");
    expect(r.code).toBe(0);
  });
});

boxTest("--repo-rw: .git is writable (unsafe escape)", () => {
  withTempRepo((repo) => {
    const r = boxRepoRw(repo, "echo '# modified' >> /work/.git/config && echo 'write ok'");
    expect(r.code).toBe(0);
    expect(r.out).toContain("write ok");
  });
});

// ── door grant profiles ──
// These require the actual daemons to be running and accessible via socket.
// We check for the socket and skip if not available.

const DOORS_VOLUME = process.env.DOORS_VOLUME ?? "systemd-claude-doors";

/** Check if a door daemon is actually serving. The doors volume can exist with
 *  NO daemons running (set up but never started, or stopped), and a stopped
 *  daemon often leaves a STALE socket file behind — so `test -S` passes while
 *  every connection is refused. Mere volume/socket existence is therefore not
 *  enough: mount the volume read-only in a throwaway box and probe a real
 *  connection, so door tests SKIP (not fail) unless a daemon is live. */
function doorAvailable(door: string): boolean {
  if (!RUNTIME_READY) return false;
  // Cheap pre-check: if the volume is absent there is nothing to mount.
  const vol = Bun.spawnSync(
    ["podman", "volume", "inspect", DOORS_VOLUME],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (vol.exitCode !== 0) return false;
  // Liveness probe: a stale socket file refuses connections (ECONNREFUSED) and
  // an absent one is ENOENT — only a live daemon accepts the connection.
  const probe = boxWithDoors(`bun -e '
    const t = setTimeout(() => { console.log("DEAD"); process.exit(0); }, 2000);
    try {
      await Bun.connect({ unix: "/run/doors/${door}.sock", socket: {
        open(s) { clearTimeout(t); console.log("LIVE"); s.end(); process.exit(0); },
        error() { clearTimeout(t); console.log("DEAD"); process.exit(0); },
      }});
    } catch { clearTimeout(t); console.log("DEAD"); process.exit(0); }
  '`);
  return probe.out.includes("LIVE");
}

/** Run inside the box with door sockets mounted. */
function boxWithDoors(script: string, extraArgs: string[] = []): { code: number; out: string } {
  const p = Bun.spawnSync(
    ["podman", "run", "--rm", "--network=none",
     "-v", `${DOORS_VOLUME}:/run/doors:ro`,
     "-e", "KEEPERD_SOCK=/run/doors/keeperd.sock",
     "-e", "NETD_SOCK=/run/doors/netd.sock",
     "-e", "SCOUTD_SOCK=/run/doors/scoutd.sock",
     ...extraArgs,
     "--entrypoint", "sh", IMAGE, "-c", script],
    { stdout: "pipe", stderr: "pipe" },
  );
  return {
    code: p.exitCode,
    out: `${p.stdout.toString()}${p.stderr.toString()}`.trim(),
  };
}

// Gate each door tier on its OWN socket being served, so a doors volume with
// only some daemons up skips the tiers that aren't (rather than failing them).
const keeperTest = test.skipIf(!doorAvailable("keeperd"));
const scoutTest = test.skipIf(!doorAvailable("scoutd"));
const netTest = test.skipIf(!doorAvailable("netd"));

// --keeper: the keeperd door is reachable via socket
keeperTest("--keeper: keeperd socket is accessible", () => {
  const r = boxWithDoors("test -S /run/doors/keeperd.sock && echo 'socket exists' || echo 'no socket'");
  expect(r.out).toContain("socket exists");
});

keeperTest("--keeper: can query keeperd status", () => {
  const r = boxWithDoors(`echo '{"id":"1","method":"status"}' | bun -e '
    const sock = await Bun.connect({ unix: "/run/doors/keeperd.sock", socket: {
      data(s, d) { console.log(d.toString()); s.end(); }
    }});
    sock.write(Bun.stdin.text());
  '`);
  expect(r.out).toContain('"ok":true');
});

// --scout: the scoutd door is reachable
scoutTest("--scout: scoutd socket is accessible", () => {
  const r = boxWithDoors("test -S /run/doors/scoutd.sock && echo 'socket exists' || echo 'no socket'");
  expect(r.out).toContain("socket exists");
});

scoutTest("--scout: can query scoutd status", () => {
  const r = boxWithDoors(`echo '{"id":"1","method":"status"}' | bun -e '
    const sock = await Bun.connect({ unix: "/run/doors/scoutd.sock", socket: {
      data(s, d) { console.log(d.toString()); s.end(); }
    }});
    sock.write(Bun.stdin.text());
  '`);
  expect(r.out).toContain('"ok":true');
});

// --net: the netd door provides policed egress
netTest("--net: netd socket is accessible", () => {
  const r = boxWithDoors("test -S /run/doors/netd.sock && echo 'socket exists' || echo 'no socket'");
  expect(r.out).toContain("socket exists");
});

// --beads: beadsd door (not yet implemented)
test.todo("--beads: beads ops via the beadsd door");

// ── red-team regression probes (deterministic) ───────────────────────────────
// Each maps to a tests/redteam mission. The LLM red-team DISCOVERS escapes;
// these probes GUARD the ones we know about so they can't silently return.
// They run under the podman+image guard (no daemons needed) — the container
// layer alone already closes these, independent of any door policy.

// escalate mission: a box launched with no doors has no door sockets to grab.
boxTest("red-team/escalate: no-door box has no keeper socket to acquire", () => {
  // default profile mounts no doors volume → /run/doors is empty/absent.
  const r = box("test -S /run/doors/keeperd.sock && echo usable || echo absent");
  expect(r.out).toContain("absent");
});

// exfil mission (network layer): with no net door the box has no NIC, so a
// forbidden host has no route — nothing to exfiltrate THROUGH.
boxTest("red-team/exfil: forbidden host has no route under --network=none", () => {
  const r = boxNet(
    ["--network=none"],
    `bun -e 'fetch("https://exfil.redteam.invalid").then(()=>process.exit(0)).catch(()=>process.exit(7))'`,
  );
  expect(r.code).not.toBe(0); // no route off the box
});
