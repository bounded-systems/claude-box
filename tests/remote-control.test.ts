/**
 * --remote-control profile tests (prx-9s14 / prx-z4c6) — pure unit tests over the
 * launcher. They assert the opt-in profile relaxes exactly two box defaults, and
 * ONLY for this launch:
 *   1. omits the inference-only CLAUDE_CODE_OAUTH_TOKEN (so a full-scope in-box
 *      `claude auth login`, persisted in the config volume, drives Remote
 *      Control — RC rejects inference-only tokens, and the env token would
 *      otherwise win per the auth precedence table), and
 *   2. unsets the image-baked CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC so the RC
 *      feature-flag gate (tengu_ccr_bridge, via GrowthBook) can evaluate.
 * The default box posture must be byte-for-byte unchanged. No podman needed.
 *
 *   nix run nixpkgs#bun -- test tests/remote-control.test.ts
 */
import { test, expect, describe } from "bun:test";
import {
  planLaunch,
  authEnvArgs,
  buildManifest,
  remoteServeArgs,
  rcEgressAllow,
  RC_NETD_ALLOW,
  bastionName,
  bastionAlreadyRunning,
} from "../claude-box.ts";

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

  test("unsets the umbrella but re-asserts the RC-safe nonessential blocks", () => {
    // The umbrella var = AUTOUPDATER + FEEDBACK + ERROR_REPORTING + TELEMETRY.
    // Only TELEMETRY breaks RC (it also kills GrowthBook). So we unset the
    // umbrella (to recover GrowthBook) and re-assert the other three granularly,
    // so a pinned box never re-enables the auto-updater / Sentry / feedback.
    const l = planLaunch(["--remote-control"], WITH_TOKEN);
    expect(authEnvArgs(l, WITH_TOKEN)).toEqual([
      "--unsetenv",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "--env",
      "DISABLE_UPDATES=1",
      "--env",
      "DISABLE_ERROR_REPORTING=1",
      "--env",
      "DISABLE_FEEDBACK_COMMAND=1",
    ]);
  });

  test("never sets a telemetry-class var (would re-break RC's GrowthBook gate)", () => {
    const joined = authEnvArgs(planLaunch(["--remote-control"], WITH_TOKEN), WITH_TOKEN).join(" ");
    expect(joined).not.toContain("DISABLE_TELEMETRY");
    expect(joined).not.toContain("DO_NOT_TRACK");
    expect(joined).not.toContain("DISABLE_GROWTHBOOK");
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
    const m = buildManifest(planLaunch(["--remote-control"], EMPTY), EMPTY);
    expect(m.doors.map((d) => d.name)).toContain("net");
    expect(m.netOpen).toBe(false);
  });
});

describe("rcEgressAllow: the RC profile's scoped-netd allowlist", () => {
  test("an RC launch widens the default anthropic allowlist with the RC hosts", () => {
    const allow = rcEgressAllow(planLaunch(["--remote-control"], EMPTY));
    expect(allow).toContain("api.anthropic.com"); // the default base is kept
    expect(allow).toContain("statsig.anthropic.com"); // + the RC feature-flag/telemetry host
    expect(allow).toEqual(expect.arrayContaining(RC_NETD_ALLOW));
  });

  test("--remote-serve shares the same RC allowlist", () => {
    expect(rcEgressAllow(planLaunch(["--remote-serve"], EMPTY))).toContain("statsig.anthropic.com");
  });

  test("a DEFAULT launch returns [] — it keeps the shared netd, allowlist untouched", () => {
    expect(rcEgressAllow(planLaunch(["--net"], EMPTY))).toEqual([]);
    expect(rcEgressAllow(planLaunch(["--repo", "."], WITH_TOKEN))).toEqual([]);
  });

  test("the widening is RC-only: the default never sees statsig", () => {
    expect(rcEgressAllow(planLaunch([], EMPTY))).not.toContain("statsig.anthropic.com");
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

  test("implies the dispatch door, but never the launcher door", () => {
    const l = planLaunch(["--remote-serve"], EMPTY);
    const names = l.doors.map((d) => d.name);
    expect(names).toContain("dispatch");
    expect(names).not.toContain("launcher");
  });

  test("composes with an explicit --launcher without doubling dispatch or dropping launcher", () => {
    const l = planLaunch(["--remote-serve", "--launcher"], EMPTY);
    const names = l.doors.map((d) => d.name);
    expect(names.filter((n) => n === "dispatch").length).toBe(1);
    expect(names).toContain("launcher");
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

  test("rejects --pod (not wired into that launch path)", () => {
    expect(() => planLaunch(["--remote-serve", "--pod"], EMPTY)).toThrow(/--pod/);
  });

  test("--repo-origin IS wired (2026-07-03): no throw, repoOrigin carries through", () => {
    const l = planLaunch(["--remote-serve", "--repo-origin", "https://x/y.git"], EMPTY);
    expect(l.remoteServe).toBe(true);
    expect(l.repoOrigin).toBe("https://x/y.git");
  });
});

describe("--remote-serve: shares the remote-control auth posture", () => {
  test("same granular nonessential-traffic posture as --remote-control", () => {
    // remote-serve is remote-control in server mode, so authEnvArgs treats them
    // identically: unset the umbrella, re-assert the three RC-safe blocks.
    const l = planLaunch(["--remote-serve"], WITH_TOKEN);
    expect(authEnvArgs(l, WITH_TOKEN)).toEqual([
      "--unsetenv",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "--env",
      "DISABLE_UPDATES=1",
      "--env",
      "DISABLE_ERROR_REPORTING=1",
      "--env",
      "DISABLE_FEEDBACK_COMMAND=1",
    ]);
    expect(authEnvArgs(l, WITH_TOKEN).join(" ")).not.toContain("DISABLE_TELEMETRY");
  });
});

describe("remoteServeArgs: the server-mode entrypoint prefix", () => {
  test("boots `claude remote-control` in --spawn session mode, named 'dispatch' (no repo)", () => {
    const l = planLaunch(["--remote-serve"], EMPTY);
    expect(remoteServeArgs(l)).toEqual([
      "remote-control",
      "--name",
      "dispatch",
      "--remote-control-session-name-prefix",
      "claude-box",
      "--spawn",
      "session",
    ]);
  });

  test("still uses --spawn session even with a repo mounted (no more worktree/same-dir split)", () => {
    const l = planLaunch(["--remote-serve", "--repo", "."], EMPTY);
    expect(remoteServeArgs(l)).toEqual([
      "remote-control",
      "--name",
      "dispatch",
      "--remote-control-session-name-prefix",
      "claude-box",
      "--spawn",
      "session",
    ]);
  });

  test("is empty for a non-serve launch (interactive entrypoint unchanged)", () => {
    expect(remoteServeArgs(planLaunch([], EMPTY))).toEqual([]);
    expect(remoteServeArgs(planLaunch(["--remote-control"], EMPTY))).toEqual([]);
  });
});

describe("bastionName: the one-persistent-bastion-per-machine guard", () => {
  test("is a stable, fixed name (not podman's random default)", () => {
    expect(bastionName()).toBe("claude-box-remote-serve");
  });
});

describe("bastionAlreadyRunning: real podman liveness (skips without podman)", () => {
  const PODMAN_READY = Bun.spawnSync(["sh", "-c", "command -v podman >/dev/null 2>&1"]).exitCode === 0;
  const podmanTest = test.skipIf(!PODMAN_READY);

  podmanTest("returns undefined or the running bastion's name", () => {
    const result = bastionAlreadyRunning();
    expect(result === undefined || typeof result === "string").toBe(true);
  });
});
