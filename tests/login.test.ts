/**
 * `claude-box login` planner tests — pure unit tests over planLogin (no podman).
 *
 * login is the auth front door: a repo-less box bound to the account's config
 * volume, used to authenticate once and persist into claude-<account>-config.
 * These assert the synthesized Launch and the REQUIRED --scope contract:
 *   full      → the --remote-control auth posture (omit the inference-only token)
 *               + net door, for a full-scope `claude auth login` (RC's front door)
 *   inference → just the net door (the default setup-token posture)
 * --scope is mandatory (minting a credential is an explicit choice), and there is
 * never a repo (authority is the credential, not a worktree).
 *
 *   nix run nixpkgs#bun -- test tests/login.test.ts
 */
import { test, expect, describe } from "bun:test";
import { planLogin } from "../claude-box.ts";

const EMPTY = { HOME: "/tmp" } as Record<string, string | undefined>;

describe("claude-box login: planLogin", () => {
  test("scope=full → remote-control auth posture + net door, no repo", () => {
    const { account, scope, launch } = planLogin(["work", "--scope", "full"], EMPTY);
    expect(account).toBe("work");
    expect(scope).toBe("full");
    expect(launch.remoteControl).toBe(true);
    expect(launch.doors.map((d) => d.name)).toContain("net");
    expect(launch.repo).toBeUndefined();
  });

  test("scope=inference → net door only, default (non-RC) auth posture", () => {
    const { account, scope, launch } = planLogin(["--scope", "inference"], EMPTY);
    expect(account).toBe("personal"); // defaults when no account token given
    expect(scope).toBe("inference");
    expect(launch.remoteControl).toBe(false);
    expect(launch.doors.map((d) => d.name)).toContain("net");
    expect(launch.repo).toBeUndefined();
  });

  test("account token is optional and order-independent before/after --scope", () => {
    expect(planLogin(["--scope", "full", "acme"], EMPTY).account).toBe("acme");
    expect(planLogin(["acme", "--scope", "full"], EMPTY).account).toBe("acme");
  });

  test("--scope is REQUIRED (no implicit default) — fail closed", () => {
    expect(() => planLogin(["work"], EMPTY)).toThrow(/--scope is required/);
    expect(() => planLogin([], EMPTY)).toThrow(/--scope is required/);
  });

  test("an unknown scope is rejected", () => {
    expect(() => planLogin(["--scope", "root"], EMPTY)).toThrow(/unknown --scope/);
  });

  test("a stray extra argument is rejected (fail closed, not silently dropped)", () => {
    expect(() => planLogin(["work", "extra", "--scope", "full"], EMPTY)).toThrow(/unexpected argument/);
    expect(() => planLogin(["--scope", "full", "--repo", "."], EMPTY)).toThrow(/unexpected argument/);
  });

  test("login never carries a repo regardless of scope", () => {
    expect(planLogin(["--scope", "full"], EMPTY).launch.repo).toBeUndefined();
    expect(planLogin(["--scope", "inference"], EMPTY).launch.repo).toBeUndefined();
  });
});
