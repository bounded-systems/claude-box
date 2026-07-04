/**
 * `claude-box login` planner tests — pure unit tests over planLogin (no podman).
 *
 * login is the auth front door: a repo-less box bound to the config volume,
 * used to authenticate once and persist into claude-config. There is only ONE
 * scope: full — the --remote-control auth posture (omit the inference-only
 * token) + net door, for a full-scope `claude auth login` (RC's front door).
 * There is never a repo (authority is the credential, not a worktree).
 *
 *   nix run nixpkgs#bun -- test tests/login.test.ts
 */
import { test, expect, describe } from "bun:test";
import { planLogin } from "../claude-box.ts";

const EMPTY = { HOME: "/tmp" } as Record<string, string | undefined>;

describe("claude-box login: planLogin", () => {
  test("always the remote-control auth posture + net door, no repo", () => {
    const { launch } = planLogin([], EMPTY);
    expect(launch.remoteControl).toBe(true);
    expect(launch.doors.map((d) => d.name)).toContain("net");
    expect(launch.repo).toBeUndefined();
  });

  test("a stray argument is rejected (fail closed, not silently dropped)", () => {
    expect(() => planLogin(["work"], EMPTY)).toThrow(/unexpected argument/);
    expect(() => planLogin(["--scope", "full"], EMPTY)).toThrow(/unexpected argument/);
  });
});
