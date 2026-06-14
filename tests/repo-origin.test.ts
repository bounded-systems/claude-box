/**
 * --repo-origin tests — clone-in-box from origin (no host mount at all).
 *
 * The box clones the URL into a writable container-internal /work (tmpfs) and
 * runs the guest there: the repo enters as CONTENT through the net door, the
 * host filesystem is never exposed, and no worktree/clone is created on the host.
 * These cover the parser (incl. URL safety) and the honest surface; the
 * clone-then-exec wrapper is verified live against a public repo.
 *
 *   nix run nixpkgs#bun -- test tests/repo-origin.test.ts
 */
import { test, expect } from "bun:test";
import {
  planLaunch,
  buildManifest,
  capabilityJson,
  capabilityPrompt,
} from "../claude-box.ts";

const ENV = { HOME: "/tmp" } as Record<string, string | undefined>;
const URL = "https://github.com/octocat/Hello-World";

test("planLaunch sets repoOrigin and does NOT set a host mount (repo)", () => {
  const l = planLaunch(["--repo-origin", URL, "--net"], ENV);
  expect(l.repoOrigin).toBe(URL);
  expect(l.repo).toBeUndefined(); // no host path is mounted
});

test("accepts https and ssh git URLs", () => {
  expect(planLaunch(["--repo-origin", "https://x/y.git"], ENV).repoOrigin).toBe("https://x/y.git");
  expect(planLaunch(["--repo-origin", "git@github.com:o/r.git"], ENV).repoOrigin).toBe("git@github.com:o/r.git");
  expect(planLaunch(["--repo-origin", "ssh://git@h/r"], ENV).repoOrigin).toBe("ssh://git@h/r");
});

test("rejects non-URLs / shell-injection attempts (fail closed)", () => {
  expect(() => planLaunch(["--repo-origin", "; rm -rf /"], ENV)).toThrow();
  expect(() => planLaunch(["--repo-origin", "--upload-pack=evil"], ENV)).toThrow();
  expect(() => planLaunch(["--repo-origin", "/etc/passwd"], ENV)).toThrow();
  expect(() => planLaunch(["--repo-origin", ""], ENV)).toThrow();
});

test("manifest surface reports the origin (json + in-box rulebook)", () => {
  const m = buildManifest("personal", planLaunch(["--repo-origin", URL, "--net"], ENV), ENV);
  expect(JSON.parse(capabilityJson(m)).granted.repoOrigin).toBe(URL);
  const prompt = capabilityPrompt(m);
  expect(prompt).toContain("FRESH CLONE FROM ORIGIN");
  expect(prompt).toContain("NO host mount");
});

test("no --repo-origin ⇒ surface reports null (not an origin-clone launch)", () => {
  const m = buildManifest("personal", planLaunch(["--repo", "."], ENV), ENV);
  expect(JSON.parse(capabilityJson(m)).granted.repoOrigin).toBeNull();
  expect(capabilityPrompt(m)).not.toContain("FRESH CLONE FROM ORIGIN");
});
