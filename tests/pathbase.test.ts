/**
 * --pathbase profile tests — pure unit tests over the launcher, same shape as
 * tests/remote-control.test.ts's rcEgressAllow/planLaunch coverage. Assert the
 * opt-in profile widens ONLY its own scoped netd (never the shared one, never
 * the default box), and that a plain launch never sees pathbase.dev. No
 * podman needed — the live "path ships + works offline + has no ambient
 * Pathbase credential" checks live in tests/ocap.test.ts.
 *
 *   nix run nixpkgs#bun -- test tests/pathbase.test.ts
 */
import { test, expect, describe } from "bun:test";
import { planLaunch, pathbaseEgressAllow, PATHBASE_NETD_ALLOW } from "../claude-box.ts";

const EMPTY = { HOME: "/tmp" } as Record<string, string | undefined>;

describe("--pathbase: planLaunch", () => {
  test("sets the pathbase flag (and not on a default launch)", () => {
    expect(planLaunch(["--pathbase"], EMPTY).pathbase).toBe(true);
    expect(planLaunch([], EMPTY).pathbase).toBe(false);
    expect(planLaunch(["--remote-control"], EMPTY).pathbase).toBe(false);
  });

  test("implies the net door", () => {
    const doors = planLaunch(["--pathbase"], EMPTY).doors;
    expect(doors.some((d) => d.name === "net")).toBe(true);
  });

  test("composes with an explicit --net without doubling the door", () => {
    const doors = planLaunch(["--net", "--pathbase"], EMPTY).doors;
    expect(doors.filter((d) => d.name === "net").length).toBe(1);
  });

  test("does not consume the next token as an argument", () => {
    const launch = planLaunch(["--pathbase", "--repo", "."], EMPTY);
    expect(launch.pathbase).toBe(true);
    expect(launch.repo).toBe(".");
  });
});

describe("pathbaseEgressAllow: the --pathbase profile's scoped-netd allowlist", () => {
  test("a --pathbase launch widens the default anthropic allowlist with pathbase.dev", () => {
    const allow = pathbaseEgressAllow(planLaunch(["--pathbase"], EMPTY));
    expect(allow).toContain("api.anthropic.com"); // the default base is kept
    expect(allow).toEqual(expect.arrayContaining(PATHBASE_NETD_ALLOW));
  });

  test("a DEFAULT launch returns [] — it keeps the shared netd, allowlist untouched", () => {
    expect(pathbaseEgressAllow(planLaunch(["--net"], EMPTY))).toEqual([]);
    expect(pathbaseEgressAllow(planLaunch(["--repo", "."], EMPTY))).toEqual([]);
  });

  test("an RC launch (no --pathbase) never sees pathbase.dev, and vice versa", () => {
    expect(pathbaseEgressAllow(planLaunch(["--remote-control"], EMPTY))).toEqual([]);
    const rcAllow = pathbaseEgressAllow(planLaunch(["--pathbase"], EMPTY));
    expect(rcAllow).not.toContain("statsig.anthropic.com");
  });

  test("the widening is pathbase-only: the default never sees pathbase.dev", () => {
    expect(pathbaseEgressAllow(planLaunch([], EMPTY))).not.toContain("pathbase.dev");
  });
});
