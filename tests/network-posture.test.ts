/**
 * network-posture tests (ADR-NETWORK-POSTURE.md / issue #236) — the single
 * source of truth for a box's network posture. Assert:
 *   1. networkPosture() over the full (netOpen × net-door × transport × doors)
 *      truth table.
 *   2. capabilityJson() reports the posture honestly — including the #236 case
 *      where a --keeper-only box in TCP mode is "open", NOT "none".
 *   3. The manifest↔flags invariant: networkArgv(posture) produces exactly the
 *      podman flags each posture implies, so what the box is TOLD equals what
 *      it GETS.
 *
 *   nix run nixpkgs#bun -- test tests/network-posture.test.ts
 */
import { test, expect, describe } from "bun:test";
import {
  planLaunch,
  buildManifest,
  capabilityJson,
  networkPosture,
  networkArgv,
} from "../claude-box.ts";

const UNIX = { HOME: "/tmp" } as Record<string, string | undefined>;
const TCP = { HOME: "/tmp", DOORS_TCP: "1" } as Record<string, string | undefined>;

const posture = (args: string[], env: Record<string, string | undefined>) =>
  networkPosture(planLaunch(args, env), env);

describe("networkPosture: the truth table (ADR)", () => {
  test("--net-open ⇒ open/ambient, on either transport", () => {
    expect(posture(["--net-open"], UNIX)).toEqual({ egress: "open", boundary: "ambient" });
    expect(posture(["--net-open"], TCP)).toEqual({ egress: "open", boundary: "ambient" });
  });

  test("net door on unix ⇒ policed/route (hard boundary — the intended posture)", () => {
    expect(posture(["--net"], UNIX)).toEqual({ egress: "policed", boundary: "route" });
  });

  test("net door on TCP ⇒ policed/proxy (advisory only — macOS reality)", () => {
    expect(posture(["--net"], TCP)).toEqual({ egress: "policed", boundary: "proxy" });
  });

  test("no egress grant on unix ⇒ none/route (truly no route)", () => {
    expect(posture([], UNIX)).toEqual({ egress: "none", boundary: "route" });
    expect(posture(["--keeper"], UNIX)).toEqual({ egress: "none", boundary: "route" });
    expect(posture(["--scout"], UNIX)).toEqual({ egress: "none", boundary: "route" });
  });

  test("#236: a non-net door on TCP ⇒ open/ambient (the hole, reported honestly)", () => {
    expect(posture(["--keeper"], TCP)).toEqual({ egress: "open", boundary: "ambient" });
    expect(posture(["--scout"], TCP)).toEqual({ egress: "open", boundary: "ambient" });
    expect(posture(["--beads"], TCP)).toEqual({ egress: "open", boundary: "ambient" });
  });

  test("zero doors on TCP ⇒ none/route (nothing forces the default network)", () => {
    expect(posture([], TCP)).toEqual({ egress: "none", boundary: "route" });
  });
});

describe("capabilityJson reports the posture (not a symbolic guess)", () => {
  const netOf = (args: string[], env: Record<string, string | undefined>) => {
    const j = JSON.parse(capabilityJson(buildManifest(planLaunch(args, env), env)));
    return { network: j.network, networkBoundary: j.networkBoundary };
  };

  test("unix scout-only stays honestly none/route", () => {
    expect(netOf(["--scout"], UNIX)).toEqual({ network: "none", networkBoundary: "route" });
  });

  test("#236 regression: TCP keeper-only reports OPEN, not none", () => {
    // The exact lie this whole change removes: the old symbolic manifest said
    // "none" here while the box actually had full internet egress.
    expect(netOf(["--keeper"], TCP)).toEqual({ network: "open", networkBoundary: "ambient" });
  });

  test("TCP net door is policed but ADVISORY (proxy), not a hard boundary", () => {
    expect(netOf(["--net"], TCP)).toEqual({ network: "policed", networkBoundary: "proxy" });
  });

  test("unix net door is policed AND route-enforced", () => {
    expect(netOf(["--net"], UNIX)).toEqual({ network: "policed", networkBoundary: "route" });
  });
});

describe("networkArgv: the manifest↔flags invariant (one source of truth)", () => {
  const PROXY = "http://host.containers.internal:3128";

  test("route + none ⇒ --network=none, no proxy env (hard-isolated, no egress)", () => {
    const argv = networkArgv({ egress: "none", boundary: "route" }, PROXY);
    expect(argv).toContain("--network=none");
    expect(argv.join(" ")).not.toContain("HTTPS_PROXY");
  });

  test("route + policed ⇒ --network=none + the in-box loopback relay proxy", () => {
    const argv = networkArgv({ egress: "policed", boundary: "route" }, PROXY);
    expect(argv).toContain("--network=none");
    expect(argv).toContain("HTTPS_PROXY=http://127.0.0.1:3128"); // NETD_PROXY, not the tcp url
  });

  test("proxy ⇒ NO --network=none (needs the default net) + HTTPS_PROXY to the given url", () => {
    const argv = networkArgv({ egress: "policed", boundary: "proxy" }, PROXY);
    expect(argv).not.toContain("--network=none");
    expect(argv).toContain(`HTTPS_PROXY=${PROXY}`);
  });

  test("ambient ⇒ no flags at all (open network, no proxy nudge)", () => {
    expect(networkArgv({ egress: "open", boundary: "ambient" }, PROXY)).toEqual([]);
  });

  test("end-to-end: for every combo, capabilityJson.network === networkArgv's egress reality", () => {
    // The invariant that makes drift impossible: the manifest's egress and the
    // flags networkArgv produces are the SAME posture, so a reader of the
    // manifest and the actual box can never disagree again.
    for (const env of [UNIX, TCP]) {
      for (const args of [[], ["--net"], ["--net-open"], ["--keeper"], ["--scout"], ["--keeper", "--net"]]) {
        const p = networkPosture(planLaunch(args, env), env);
        const j = JSON.parse(capabilityJson(buildManifest(planLaunch(args, env), env)));
        expect(j.network).toBe(p.egress);
        expect(j.networkBoundary).toBe(p.boundary);
        // ambient ⇒ no --network=none; route ⇒ --network=none present.
        const argv = networkArgv(p, "http://host.containers.internal:3128");
        if (p.boundary === "route") expect(argv).toContain("--network=none");
        else expect(argv).not.toContain("--network=none");
      }
    }
  });
});
