/**
 * --writable subtree tests — the narrowed-writable-surface flag.
 *
 * `--writable PATH` mounts /work READ-ONLY and bind-mounts only the named
 * subtrees writable, so an errant agent can touch nothing outside its lane
 * (smaller blast radius; .git stays read-only, writes still via keeper). These
 * test the pure path-validation (escape rejection) and that planLaunch threads
 * the flag into the manifest's honest surface.
 *
 *   nix run nixpkgs#bun -- test tests/writable-subtree.test.ts
 */
import { test, expect } from "bun:test";
import {
  resolveWritableSubtree,
  planLaunch,
  buildManifest,
  capabilityJson,
  capabilityPrompt,
} from "../claude-box.ts";

const ENV = { HOME: "/tmp" } as Record<string, string | undefined>;
const REPO = "/home/me/project";

// ── path validation: subtrees in, escapes out ──
test("accepts a normal subtree (returns repo-relative path)", () => {
  expect(resolveWritableSubtree(REPO, "src")).toBe("src");
  expect(resolveWritableSubtree(REPO, "src/app")).toBe("src/app");
  expect(resolveWritableSubtree(REPO, "./tests")).toBe("tests");
});

test("rejects the repo root itself", () => {
  expect(() => resolveWritableSubtree(REPO, ".")).toThrow();
  expect(() => resolveWritableSubtree(REPO, "")).toThrow();
});

test("rejects '..' escapes", () => {
  expect(() => resolveWritableSubtree(REPO, "..")).toThrow();
  expect(() => resolveWritableSubtree(REPO, "../etc")).toThrow();
  expect(() => resolveWritableSubtree(REPO, "src/../..")).toThrow();
});

test("rejects an absolute path outside the repo", () => {
  expect(() => resolveWritableSubtree(REPO, "/etc/passwd")).toThrow();
});

test("a subtree that resolves back inside is fine", () => {
  expect(resolveWritableSubtree(REPO, "src/../tests")).toBe("tests");
});

// ── planLaunch threads --writable into the surface ──
test("planLaunch collects repeatable --writable into the launch", () => {
  const l = planLaunch(["--repo", ".", "--writable", "src", "--writable", "tests"], ENV);
  expect(l.writable).toEqual(["src", "tests"]);
});

test("no --writable ⇒ empty (whole worktree writable, unchanged default)", () => {
  const l = planLaunch(["--repo", "."], ENV);
  expect(l.writable).toEqual([]);
});

test("manifest surface reflects the narrowed writable set (json + prompt)", () => {
  const l = planLaunch(["--repo", ".", "--writable", "src", "--keeper"], ENV);
  const m = buildManifest("personal", l, ENV);
  const json = JSON.parse(capabilityJson(m));
  expect(json.granted.writable).toEqual(["src"]);
  expect(capabilityPrompt(m)).toContain("READ-ONLY except: src");
});

test("manifest: no --writable ⇒ writable is null (whole worktree writable)", () => {
  const l = planLaunch(["--repo", "."], ENV);
  const json = JSON.parse(capabilityJson(buildManifest("personal", l, ENV)));
  expect(json.granted.writable).toBeNull();
});
