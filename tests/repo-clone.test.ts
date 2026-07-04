/**
 * --repo-clone tests — the isolated-clone mode (write-model increment 1).
 *
 * `--repo-clone` mounts a standalone clone with its OWN writable .git: the box
 * gets full in-box git (commit/branch/rebase) and the real repo is never even
 * mounted, so it can't be corrupted. Commits are reconciled to the source via
 * the keeper door (increment 2). These cover the parser + the honest surface;
 * the mount + in-box-git behavior is verified live against a throwaway repo.
 *
 *   nix run nixpkgs#bun -- test tests/repo-clone.test.ts
 */
import { test, expect } from "bun:test";
import {
  planLaunch,
  buildManifest,
  capabilityJson,
  capabilityPrompt,
} from "../claude-box.ts";

const ENV = { HOME: "/tmp" } as Record<string, string | undefined>;

test("planLaunch sets repoClone + repo for --repo-clone", () => {
  const l = planLaunch(["--repo-clone", ".", "--keeper"], ENV);
  expect(l.repoClone).toBe(true);
  expect(l.repo).toBe(".");
});

test("--repo / --repo-rw / --repo-ephemeral do NOT set repoClone", () => {
  expect(planLaunch(["--repo", "."], ENV).repoClone).toBe(false);
  expect(planLaunch(["--repo-rw", "."], ENV).repoClone).toBe(false);
  expect(planLaunch(["--repo-ephemeral", "."], ENV).repoClone).toBe(false);
});

test("manifest JSON reports repoClone=true and repoGit ro (real .git unmounted)", () => {
  const m = buildManifest(planLaunch(["--repo-clone", "."], ENV), ENV);
  const json = JSON.parse(capabilityJson(m));
  expect(json.granted.repoClone).toBe(true);
  // the SOURCE .git is never mounted, so the surface stays "ro" (not the unsafe rw)
  expect(json.granted.repoGit).toBe("ro");
});

test("in-box rulebook tells the agent it has full in-box git on a throwaway", () => {
  const m = buildManifest(planLaunch(["--repo-clone", "."], ENV), ENV);
  const prompt = capabilityPrompt(m);
  expect(prompt).toContain("ISOLATED CLONE");
  expect(prompt).toContain("FULL in-box git");
  expect(prompt).toContain("keeper door");
});

test("no --repo-clone ⇒ surface omits it (repoClone false)", () => {
  const m = buildManifest(planLaunch(["--repo", "."], ENV), ENV);
  expect(JSON.parse(capabilityJson(m)).granted.repoClone).toBe(false);
  expect(capabilityPrompt(m)).not.toContain("ISOLATED CLONE");
});
