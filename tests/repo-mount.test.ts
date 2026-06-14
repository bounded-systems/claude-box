/**
 * planRepoMount tests — assert the REAL launcher's repo bind-mount plan, not a
 * hand-rolled replica. tests/ocap.test.ts runs the built image under podman and
 * asserts the .git :ro posture *behaviourally*, but it reconstructs the podman
 * command itself, and its `git init` fixture only ever hits the "normal repo"
 * branch (.git inside /work). The worktree branch — where .git is a *file*
 * pointing at a common dir OUTSIDE /work, so the launcher mounts
 * `${common}:${common}:ro` instead of overlaying `/work/.git` — was untested,
 * yet it's the more security-relevant path (a dropped :ro there is a host-RCE
 * escape). These unit-test the launcher's actual mount-planning function, so a
 * regression in claude-box.ts's --repo logic fails here without needing podman.
 *
 *   nix run nixpkgs#bun -- test tests/repo-mount.test.ts
 */
import { test, expect } from "bun:test";
import { planRepoMount } from "../claude-box.ts";

const REPO = "/home/u/repo";
// A worktree's common dir lives OUTSIDE the worktree (a bare repo or the main
// checkout's .git) — i.e. it does NOT start with `${REPO}/`.
const EXTERNAL_GIT = "/home/u/bare.git";

/** Pull out the `-v` mount specs (the value after each "-v" flag). */
function mounts(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "-v") out.push(argv[i + 1]!);
  return out;
}

const base = {
  mountPath: REPO,
  repoRw: false,
  repoClone: false,
  narrowWritable: false,
  writableRels: [] as string[],
  common: `${REPO}/.git`,
  external: false,
};

// ── invariants shared by every mode ──────────────────────────────────────────
test("always maps host uid → in-box claude uid and works at /work", () => {
  const argv = planRepoMount(base);
  expect(argv).toContain("--userns=keep-id:uid=1000,gid=1000");
  expect(argv).toContain("-w");
  expect(argv).toContain("/work");
});

// ── --repo, normal repo: .git lives inside /work → overlay it :ro ─────────────
test("--repo (normal repo): worktree writable, .git overlaid read-only", () => {
  const m = mounts(planRepoMount(base));
  expect(m).toContain(`${REPO}:/work`); // worktree writable (no :ro on the base)
  expect(m).toContain(`${REPO}/.git:/work/.git:ro`); // host-RCE boundary
  // The :ro overlay must come AFTER the writable /work base (podman: later wins).
  expect(m.indexOf(`${REPO}/.git:/work/.git:ro`)).toBeGreaterThan(m.indexOf(`${REPO}:/work`));
});

// ── --repo, worktree: .git is external → mount the common dir :ro, no overlay ──
test("--repo (worktree): external .git common dir mounted read-only, no /work overlay", () => {
  const m = mounts(planRepoMount({ ...base, common: EXTERNAL_GIT, external: true }));
  expect(m).toContain(`${REPO}:/work`);
  expect(m).toContain(`${EXTERNAL_GIT}:${EXTERNAL_GIT}:ro`); // the real escape path
  // Must NOT also overlay /work/.git (that path doesn't hold the git dir here).
  expect(m).not.toContain(`${REPO}/.git:/work/.git:ro`);
});

// ── --repo-rw: the UNSAFE escape — .git stays writable ────────────────────────
test("--repo-rw (normal repo): no read-only overlay anywhere", () => {
  const m = mounts(planRepoMount({ ...base, repoRw: true }));
  expect(m).toContain(`${REPO}:/work`);
  expect(m.some((x) => x.endsWith(":ro"))).toBe(false);
  // .git is inside the already-writable /work; nothing extra to mount.
  expect(m).not.toContain(`${REPO}/.git:/work/.git:ro`);
});

test("--repo-rw (worktree): external .git mounted WRITABLE (not :ro)", () => {
  const m = mounts(planRepoMount({ ...base, repoRw: true, common: EXTERNAL_GIT, external: true }));
  expect(m).toContain(`${EXTERNAL_GIT}:${EXTERNAL_GIT}`); // writable host .git — the documented escape
  expect(m).not.toContain(`${EXTERNAL_GIT}:${EXTERNAL_GIT}:ro`);
});

// ── --repo-clone: self-contained /work, no host .git touched at all ───────────
test("--repo-clone: writable /work, no .git overlay", () => {
  const m = mounts(planRepoMount({ ...base, repoClone: true, common: undefined }));
  expect(m).toContain(`${REPO}:/work`);
  expect(m.some((x) => x.endsWith(":ro"))).toBe(false);
  expect(m.some((x) => x.includes("/.git"))).toBe(false);
});

// ── --writable: /work read-only base + writable subtrees, .git still :ro ───────
test("--writable: read-only /work base, subtree writable, .git overlay last", () => {
  const m = mounts(
    planRepoMount({ ...base, narrowWritable: true, writableRels: ["src", "docs"] }),
  );
  expect(m).toContain(`${REPO}:/work:ro`); // base is read-only when narrowing
  expect(m).toContain(`${REPO}/src:/work/src`); // writable subtree
  expect(m).toContain(`${REPO}/docs:/work/docs`);
  expect(m).toContain(`${REPO}/.git:/work/.git:ro`); // .git stays read-only
  // Ordering: subtree mounts after the base, .git :ro overlay after the subtrees
  // (later mount wins, so the read-only .git can't be shadowed by a subtree).
  expect(m.indexOf(`${REPO}/src:/work/src`)).toBeGreaterThan(m.indexOf(`${REPO}:/work:ro`));
  expect(m.indexOf(`${REPO}/.git:/work/.git:ro`)).toBeGreaterThan(
    m.indexOf(`${REPO}/docs:/work/docs`),
  );
});
