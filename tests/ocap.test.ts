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
  const p = Bun.spawnSync(
    ["podman", "run", "--rm", "--entrypoint", "sh", IMAGE, "-c", script],
    { stdout: "pipe", stderr: "pipe" },
  );
  return {
    code: p.exitCode,
    out: `${p.stdout.toString()}${p.stderr.toString()}`.trim(),
  };
}

// ── least authority: the box runs unprivileged with no escalation ──
test("runs non-root (uid 1000)", () => {
  expect(box("id -u").out).toBe("1000");
});

test("no privilege-escalation / container tooling (sudo, docker, podman, kubectl)", () => {
  const found = box(
    "for c in sudo docker podman kubectl nsenter; do command -v $c >/dev/null 2>&1 && echo $c; done",
  ).out;
  expect(found).toBe(""); // none present
});

test("no docker socket, no ambient daemon", () => {
  expect(box("test -S /var/run/docker.sock && echo present || echo absent").out).toBe("absent");
});

// ── the sanctioned tool surface IS present ──
test("prx + claude are the sanctioned tools", () => {
  expect(box("command -v prx >/dev/null && command -v claude >/dev/null && echo ok").out).toBe("ok");
});

test("prx is really prx (not bare bun — patchelf-corruption regression guard)", () => {
  expect(box("prx --version").out).toContain("v0.8");
});

// ── grant profiles — pending the pod (prx-asr) ──
// --repo: the mounted worktree is RW; nothing else on the host is writable.
test.todo("--repo: only the mounted worktree is writable");
// --keeper: the keeperd door is reachable; a RAW git push fails (no creds in
// the box); a keeperd-mediated signed write succeeds.
test.todo("--keeper: signed writes via the keeperd door, raw push refused");
// --beads: the beadsd door is reachable; bd writes route through it.
test.todo("--beads: beads ops via the beadsd door");
