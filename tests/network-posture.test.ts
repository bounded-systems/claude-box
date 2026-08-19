/**
 * network-posture tests (ADR-NETWORK-POSTURE.md / issues #236, #257) — the
 * single source of truth for a box's network posture. Assert:
 *   1. networkPosture() over the full (netOpen × net-door × transport × doors)
 *      truth table, on BOTH sides of the DOORS_TCP_RELAY switch.
 *   2. capabilityJson() reports the posture honestly — including the #236 case,
 *      which is now closed by default and survives only behind the opt-out.
 *   3. The manifest↔flags invariant: networkArgv(posture) produces exactly the
 *      podman flags each posture implies, so what the box is TOLD equals what
 *      it GETS.
 *
 * The #236 case is why this file exists, so watch what changed: it used to
 * assert that a --keeper-only TCP box HAS full egress. It now asserts the
 * opposite by default, and keeps the old assertion under DOORS_TCP_RELAY=0 —
 * because that is still a launch someone can ask for, and it must still report
 * itself honestly when they do.
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
  type NetworkPosture,
} from "../claude-box.ts";
import { planRelay, type StartedRelay } from "../door-relay.ts";

const UNIX = { HOME: "/tmp" } as Record<string, string | undefined>;
const TCP = { HOME: "/tmp", DOORS_TCP: "1" } as Record<string, string | undefined>;
/** The pre-#257 posture, still reachable on purpose (and still honest). */
const TCP_SOFT = { ...TCP, DOORS_TCP_RELAY: "0" };

const posture = (args: string[], env: Record<string, string | undefined>) =>
  networkPosture(planLaunch(args, env), env);

/** A stand-in for a started relay — the pure flag map never touches podman. */
const RELAY: StartedRelay = {
  plan: planRelay("test", [3001, 3128]),
  ip: "10.89.7.2",
  stop: () => {},
};

describe("networkPosture: the truth table (ADR)", () => {
  test("--net-open ⇒ open/ambient on the default network, on either transport", () => {
    const open: NetworkPosture = { egress: "open", boundary: "ambient", mechanism: "default" };
    expect(posture(["--net-open"], UNIX)).toEqual(open);
    expect(posture(["--net-open"], TCP)).toEqual(open);
  });

  test("net door on unix ⇒ policed/route via the netns (no NIC at all)", () => {
    expect(posture(["--net"], UNIX)).toEqual({
      egress: "policed", boundary: "route", mechanism: "netns",
    });
  });

  test("#257: net door on TCP ⇒ policed/route via the relay — netd is a real boundary now", () => {
    // The ADR's other wrong cell: netd used to be advisory on TCP because the
    // box sat on the default network and a raw socket could skip it. On the
    // internal network, the relay's netd port is the only thing there is.
    expect(posture(["--net"], TCP)).toEqual({
      egress: "policed", boundary: "route", mechanism: "relay",
    });
  });

  test("no egress grant on unix ⇒ none/route (truly no route)", () => {
    const none: NetworkPosture = { egress: "none", boundary: "route", mechanism: "netns" };
    expect(posture([], UNIX)).toEqual(none);
    expect(posture(["--keeper"], UNIX)).toEqual(none);
    expect(posture(["--scout"], UNIX)).toEqual(none);
  });

  test("#236 CLOSED: a non-net door on TCP ⇒ none/route — door reachability only", () => {
    // The finding itself: --keeper alone used to mean full internet egress. The
    // relay forwards the keeper port and nothing else, so the box reaches its
    // door and has no route to anything beyond it.
    const none: NetworkPosture = { egress: "none", boundary: "route", mechanism: "relay" };
    expect(posture(["--keeper"], TCP)).toEqual(none);
    expect(posture(["--scout"], TCP)).toEqual(none);
    expect(posture(["--beads"], TCP)).toEqual(none);
  });

  test("zero doors on TCP ⇒ none/route via the netns (nothing needs a NIC)", () => {
    expect(posture([], TCP)).toEqual({ egress: "none", boundary: "route", mechanism: "netns" });
  });

  test("--pod ⇒ the pod's own default network, reported as such on either transport", () => {
    // The box shares one netns with the pod's netd, so neither transport's
    // boundary applies; claiming one here would be #236 in a new place.
    expect(posture(["--pod", "--keeper"], TCP)).toEqual({
      egress: "open", boundary: "ambient", mechanism: "default",
    });
    expect(posture(["--pod", "--net"], UNIX)).toEqual({
      egress: "policed", boundary: "proxy", mechanism: "default",
    });
  });
});

describe("DOORS_TCP_RELAY=0: the opt-out keeps the old posture, and still tells the truth", () => {
  test("#236's hole is exactly what you get back", () => {
    expect(posture(["--keeper"], TCP_SOFT)).toEqual({
      egress: "open", boundary: "ambient", mechanism: "default",
    });
  });

  test("a net door is advisory again (proxy, not route)", () => {
    expect(posture(["--net"], TCP_SOFT)).toEqual({
      egress: "policed", boundary: "proxy", mechanism: "default",
    });
  });

  test("it cannot weaken a box that never needed a NIC", () => {
    expect(posture([], TCP_SOFT)).toEqual({ egress: "none", boundary: "route", mechanism: "netns" });
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

  test("#236 regression: TCP keeper-only reports none/route — and now IS none/route", () => {
    // The manifest said "none" here before #237 and was lying; #237 made it say
    // "open" truthfully; #257 makes "none" true. The value is back where it
    // started and the box's reality moved to meet it — which is the whole arc.
    expect(netOf(["--keeper"], TCP)).toEqual({ network: "none", networkBoundary: "route" });
  });

  test("the opt-out still reports the open box as open", () => {
    expect(netOf(["--keeper"], TCP_SOFT)).toEqual({ network: "open", networkBoundary: "ambient" });
  });

  test("TCP net door is policed AND route-enforced", () => {
    expect(netOf(["--net"], TCP)).toEqual({ network: "policed", networkBoundary: "route" });
  });

  test("unix net door is policed AND route-enforced", () => {
    expect(netOf(["--net"], UNIX)).toEqual({ network: "policed", networkBoundary: "route" });
  });
});

describe("networkArgv: the manifest↔flags invariant (one source of truth)", () => {
  const PROXY = "http://host.containers.internal:3128";

  test("netns + none ⇒ --network=none, no proxy env (hard-isolated, no egress)", () => {
    const argv = networkArgv({ egress: "none", boundary: "route", mechanism: "netns" }, PROXY);
    expect(argv).toContain("--network=none");
    expect(argv.join(" ")).not.toContain("HTTPS_PROXY");
  });

  test("netns + policed ⇒ --network=none + the in-box loopback relay proxy", () => {
    const argv = networkArgv({ egress: "policed", boundary: "route", mechanism: "netns" }, PROXY);
    expect(argv).toContain("--network=none");
    expect(argv).toContain("HTTPS_PROXY=http://127.0.0.1:3128"); // NETD_PROXY, not the tcp url
  });

  test("relay + none ⇒ the internal network, the door host pinned to the relay, no proxy", () => {
    const argv = networkArgv(
      { egress: "none", boundary: "route", mechanism: "relay" }, PROXY, RELAY,
    );
    expect(argv).toContain(`--network=${RELAY.plan.network}`);
    expect(argv).toContain(`host.containers.internal:${RELAY.ip}`);
    // No second network anywhere: a box that also held the default network
    // would have the #236 hole straight back.
    expect(argv.filter((a) => a.startsWith("--network=")).length).toBe(1);
    expect(argv.join(" ")).not.toContain("HTTPS_PROXY");
  });

  test("relay + policed ⇒ the internal network + HTTPS_PROXY to netd's usual name", () => {
    // The name is unchanged on purpose — it now resolves to the relay, which is
    // why no door plumbing had to learn the relay exists.
    const argv = networkArgv(
      { egress: "policed", boundary: "route", mechanism: "relay" }, PROXY, RELAY,
    );
    expect(argv).toContain(`--network=${RELAY.plan.network}`);
    expect(argv).toContain(`HTTPS_PROXY=${PROXY}`);
  });

  test("relay WITHOUT a started relay throws — it never falls back to the open network", () => {
    // Fail closed: a silent fallback here is precisely the bug this closes.
    expect(() =>
      networkArgv({ egress: "none", boundary: "route", mechanism: "relay" }, PROXY),
    ).toThrow(/needs a started relay/);
  });

  test("default + proxy ⇒ NO --network=none (needs the default net) + HTTPS_PROXY", () => {
    const argv = networkArgv({ egress: "policed", boundary: "proxy", mechanism: "default" }, PROXY);
    expect(argv).not.toContain("--network=none");
    expect(argv).toContain(`HTTPS_PROXY=${PROXY}`);
  });

  test("default + ambient ⇒ no flags at all (open network, no proxy nudge)", () => {
    expect(
      networkArgv({ egress: "open", boundary: "ambient", mechanism: "default" }, PROXY),
    ).toEqual([]);
  });

  test("end-to-end: for every combo, capabilityJson.network === networkArgv's egress reality", () => {
    // The invariant that makes drift impossible: the manifest's egress and the
    // flags networkArgv produces are the SAME posture, so a reader of the
    // manifest and the actual box can never disagree again.
    for (const env of [UNIX, TCP, TCP_SOFT]) {
      for (const args of [[], ["--net"], ["--net-open"], ["--keeper"], ["--scout"], ["--keeper", "--net"]]) {
        const p = networkPosture(planLaunch(args, env), env);
        const j = JSON.parse(capabilityJson(buildManifest(planLaunch(args, env), env)));
        expect(j.network).toBe(p.egress);
        expect(j.networkBoundary).toBe(p.boundary);
        const argv = networkArgv(p, "http://host.containers.internal:3128", RELAY);
        // A route boundary means no ambient NIC, by one of its two mechanisms;
        // anything softer means the box is left on the default network.
        if (p.boundary === "route") {
          expect(
            argv.includes("--network=none") || argv.includes(`--network=${RELAY.plan.network}`),
          ).toBe(true);
        } else {
          expect(argv.join(" ")).not.toContain("--network=");
        }
      }
    }
  });
});
