/**
 * ocap tests (prx-8ab) — assert the claude-box capability surface, so "the box
 * is isolated" is VERIFIED, not eyeballed (cf. the "don't overclaim secure"
 * rule). These run the built image (`localhost/claude-personal:dev`) under each
 * grant profile and assert what is / isn't reachable.
 *
 *   nix run nixpkgs#bun -- test tests/ocap.test.ts
 *
 * Needs the image loaded (`nix build .#claude-image && podman load -i result`)
 * and a running container runtime (rootless podman). The default profile
 * (config volume only) is tested here; the --repo / --keeper / --beads grant
 * profiles are `test.todo` until the pod lands (prx-asr).
 */
import { test, expect } from "bun:test";

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

// ── grant profiles — pending the pod (prx-asr) ──
// --net: the netd door is the ONLY egress; an allowlisted host is reachable
// THROUGH it (loopback relay → /run/netd.sock), an arbitrary host (evil.com) is
// refused by netd. Pending netd + the pod.
test.todo("--net: egress only via the netd door (allowlist enforced, arbitrary host refused)");
// --net: the netd door is the ONLY egress; the allowlist permits api.anthropic.com
// but a curl to an off-allowlist host is refused (netd policy, no other route).
test.todo("--net: egress only via the netd door, off-allowlist host refused");
// --repo (default): worktree files are writable, but .git is READ-ONLY — the box
// can't plant a hook / rewrite config that would run on the host (the host-RCE
// escape is closed). Writing /work/.git/* must fail; editing /work/<file> works.
test.todo("--repo: .git is read-only (no host-RCE), worktree files writable");
// --repo-rw: the unsafe escape — .git is writable again (today's behaviour).
test.todo("--repo-rw: .git is writable (escape hatch, warned)");
// --keeper: the keeperd door is reachable; a RAW git push fails (no creds in
// the box); a keeperd-mediated signed write succeeds.
test.todo("--keeper: signed writes via the keeperd door, raw push refused");
// --beads: the beadsd door is reachable; bd writes route through it.
test.todo("--beads: beads ops via the beadsd door");
// --scout: the scoutd door is reachable; the box reads external artifacts
// (repos/PRs/URLs) through it while holding NO read token and NO NIC — scoutd
// returns CONTENT, never a credential, and nothing write-capable is exposed.
test.todo("--scout: external reads via the scoutd door, no credential in the box");
