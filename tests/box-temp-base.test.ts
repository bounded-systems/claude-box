/**
 * boxTempBase tests — assert the single chokepoint for box-mounted temp dirs is
 * rooted under $HOME, NEVER /tmp.
 *
 * Why this matters: on macOS the podman VM only shares $HOME, not /tmp. A box
 * bind-mount sourced from a /tmp-rooted dir fails the launch with exit 125. Both
 * createEphemeralWorktree (--repo ephemeral worktree) and createIsolatedClone
 * (--repo-clone) build their temp paths from boxTempBase(), so locking its
 * rooting here makes the /tmp regression a CI failure rather than a memory note a
 * future session has to recall and re-apply. (Replaces the box-mount-temp-under-
 * home memory shard — the code now can't get it wrong.)
 *
 *   nix run nixpkgs#bun -- test tests/box-temp-base.test.ts
 */
import { test, expect, afterEach } from "bun:test";
import { homedir } from "node:os";
import { boxTempBase } from "../claude-box.ts";

const ORIG_XDG = process.env.XDG_CACHE_HOME;
afterEach(() => {
  if (ORIG_XDG === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = ORIG_XDG;
});

test("never roots under /tmp", () => {
  delete process.env.XDG_CACHE_HOME;
  expect(boxTempBase().startsWith("/tmp")).toBe(false);
});

test("falls back to ~/.cache/claude-box when XDG_CACHE_HOME is unset", () => {
  delete process.env.XDG_CACHE_HOME;
  expect(boxTempBase()).toBe(`${homedir()}/.cache/claude-box`);
});

test("honors an absolute XDG_CACHE_HOME under $HOME", () => {
  process.env.XDG_CACHE_HOME = `${homedir()}/.xdg-cache`;
  expect(boxTempBase()).toBe(`${homedir()}/.xdg-cache/claude-box`);
});

test("ignores a relative XDG_CACHE_HOME (must be absolute) and falls back", () => {
  process.env.XDG_CACHE_HOME = "relative/cache";
  expect(boxTempBase()).toBe(`${homedir()}/.cache/claude-box`);
});

test("is always an absolute path under $HOME", () => {
  delete process.env.XDG_CACHE_HOME;
  const base = boxTempBase();
  expect(base.startsWith("/")).toBe(true);
  expect(base.startsWith(homedir())).toBe(true);
});
