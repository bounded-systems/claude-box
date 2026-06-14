/**
 * Clone-in-box must never block on a credential prompt.
 *
 * `--repo-origin` clones over netd with NO git credentials (it works for public
 * repos; private repos need the scout read-door). A private/401 origin makes git
 * print `Username for 'https://github.com':` — and the box has no TTY, so under
 * `podman run -it` that prompt is an **infinite hang** (observed live: the clone
 * sat forever until ^C). `GIT_TERMINAL_PROMPT=0` turns that into a clean fast-fail.
 *
 * This is a source-seam guard (cf. guest-room's "engine names no guest" test): the
 * entrypoint clone scripts are built inline and handed to podman, so we assert the
 * invariant on the source rather than spinning a container.
 *
 *   nix run nixpkgs#bun -- test tests/clone-no-tty.test.ts
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(`${import.meta.dir}/../claude-box.ts`, "utf8");
const cloneLines = src.split("\n").filter((l) => l.includes("git clone --depth 1"));

test("there are clone-in-box sites to guard (pod + non-pod --repo-origin)", () => {
  expect(cloneLines.length).toBeGreaterThanOrEqual(2);
});

test("every clone-in-box disables the credential prompt (no Username: hang)", () => {
  for (const line of cloneLines) {
    expect(line).toContain("GIT_TERMINAL_PROMPT=0");
  }
});

test("every clone-in-box fails fast with guidance instead of proceeding blindly", () => {
  for (const line of cloneLines) {
    // a `|| { … exit 1; }` guard, not a bare `&&` chain that would swallow failure
    expect(line).toMatch(/git clone --depth 1[^|]*\|\|/);
    expect(line).toContain("scout");
  }
});
