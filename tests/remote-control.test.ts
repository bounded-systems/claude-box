/**
 * --remote-control profile tests (prx-9s14 / prx-z4c6) — pure unit tests over the
 * launcher. They assert the opt-in profile relaxes exactly two box defaults, and
 * ONLY for this launch:
 *   1. omits the inference-only CLAUDE_CODE_OAUTH_TOKEN (so a full-scope in-box
 *      `claude auth login`, persisted in the account volume, drives Remote
 *      Control — RC rejects inference-only tokens, and the env token would
 *      otherwise win per the auth precedence table), and
 *   2. unsets the image-baked CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC so the RC
 *      feature-flag gate (tengu_ccr_bridge, via GrowthBook) can evaluate.
 * The default box posture must be byte-for-byte unchanged. No podman needed.
 *
 *   nix run nixpkgs#bun -- test tests/remote-control.test.ts
 */
import { test, expect, describe } from "bun:test";
import { planLaunch, authEnvArgs, buildManifest, remoteServeArgs } from "../claude-box.ts";

const EMPTY = { HOME: "/tmp" } as Record<string, string | undefined>;
const WITH_TOKEN = { HOME: "/tmp", CLAUDE_CODE_OAUTH_TOKEN: "tok-abc" } as Record<
  string,
  string | undefined
>;

describe("--remote-control: planLaunch", () => {
  test("sets the remoteControl flag", () => {
    expect(planLaunch(["--remote-control"], EMPTY).remoteControl).toBe(true);
    expect(planLaunch([], EMPTY).remoteControl).toBe(false);
  });

  test("implies the net door (RC needs egress)", () => {
    const l = planLaunch(["--remote-control"], EMPTY);
    expect(l.doors.map((d) => d.name)).toContain("net");
  });

  test("composes with an explicit --net without doubling the door", () => {
    const l = planLaunch(["--remote-control", "--net"], EMPTY);
    expect(l.doors.filter((d) => d.name === "net").length).toBe(1);
  });

  test("does not consume the next token as an argument", () => {
    const l = planLaunch(["--remote-control", "--resume"], EMPTY);
    expect(l.guestArgs).toEqual(["--resume"]);
  });
});

describe("authEnvArgs: remote-control posture", () => {
  test("omits the inference-only token even when one is present", () => {
    const l = planLaunch(["--remote-control"], WITH_TOKEN);
    const args = authEnvArgs(l, WITH_TOKEN);
    expect(args.join(" ")).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("unsets CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC (feature-flag gate)", () => {
    const l = planLaunch(["--remote-control"], WITH_TOKEN);
    expect(authEnvArgs(l, WITH_TOKEN)).toEqual([
      "--unsetenv",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    ]);
  });
});

describe("authEnvArgs: default posture is unchanged", () => {
  test("forwards the setup-token when present and NOT remote-control", () => {
    const l = planLaunch(["--repo", "."], WITH_TOKEN);
    expect(authEnvArgs(l, WITH_TOKEN)).toEqual([
      "--env",
      "CLAUDE_CODE_OAUTH_TOKEN=tok-abc",
    ]);
  });

  test("never unsets nonessential-traffic on a default launch", () => {
    const l = planLaunch(["--net"], WITH_TOKEN);
    expect(authEnvArgs(l, WITH_TOKEN)).not.toContain(
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    );
  });

  test("emits nothing when no token is set and not remote-control", () => {
    const l = planLaunch(["--net"], EMPTY);
    expect(authEnvArgs(l, EMPTY)).toEqual([]);
  });
});

describe("--remote-control: manifest still reflects policed egress", () => {
  test("network posture is policed (net door), not open", () => {
    const m = buildManifest("personal", planLaunch(["--remote-control"], EMPTY), EMPTY);
    expect(m.doors.map((d) => d.name)).toContain("net");
    expect(m.netOpen).toBe(false);
  });
});

describe("--remote-serve: planLaunch", () => {
  test("sets the remoteServe flag (and not on a default launch)", () => {
    expect(planLaunch(["--remote-serve"], EMPTY).remoteServe).toBe(true);
    expect(planLaunch([], EMPTY).remoteServe).toBe(false);
    expect(planLaunch(["--remote-control"], EMPTY).remoteServe).toBe(false);
  });

  test("implies the net door (RC needs egress)", () => {
    const l = planLaunch(["--remote-serve"], EMPTY);
    expect(l.doors.map((d) => d.name)).toContain("net");
  });

  test("composes with an explicit --net without doubling the door", () => {
    const l = planLaunch(["--remote-serve", "--net"], EMPTY);
    expect(l.doors.filter((d) => d.name === "net").length).toBe(1);
  });

  test("passes through guest args without consuming them", () => {
    const l = planLaunch(["--remote-serve", "--resume"], EMPTY);
    expect(l.guestArgs).toEqual(["--resume"]);
  });

  test("rejects non-claude guests (server mode is claude-only)", () => {
    expect(() => planLaunch(["--guest", "bun", "--remote-serve"], EMPTY)).toThrow(
      /only valid for the claude guest/,
    );
  });

  test("rejects --pod and --repo-origin (not wired into those launch paths)", () => {
    expect(() => planLaunch(["--remote-serve", "--pod"], EMPTY)).toThrow(/--pod/);
    expect(() =>
      planLaunch(["--remote-serve", "--repo-origin", "https://x/y.git"], EMPTY),
    ).toThrow(/--repo-origin/);
  });
});

describe("--remote-serve: shares the remote-control auth posture", () => {
  test("omits the inference-only token and unsets the feature-flag gate", () => {
    const l = planLaunch(["--remote-serve"], WITH_TOKEN);
    expect(authEnvArgs(l, WITH_TOKEN)).toEqual([
      "--unsetenv",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    ]);
  });
});

describe("remoteServeArgs: the server-mode entrypoint prefix", () => {
  test("boots `claude remote-control --name <account>` for a serve launch", () => {
    const l = planLaunch(["--remote-serve"], EMPTY);
    expect(remoteServeArgs(l, "work")).toEqual(["remote-control", "--name", "work"]);
  });

  test("is empty for a non-serve launch (interactive entrypoint unchanged)", () => {
    expect(remoteServeArgs(planLaunch([], EMPTY), "personal")).toEqual([]);
    expect(remoteServeArgs(planLaunch(["--remote-control"], EMPTY), "personal")).toEqual([]);
  });
});
