/**
 * door-relay tests (#236/#257, ADR-NETWORK-POSTURE.md "Follow-up") — the
 * route-level boundary for TCP mode.
 *
 * The property under test is narrow and load-bearing: **the box can reach the
 * granted doors' ports and nothing else.** That decomposes into four claims,
 * all checkable without podman:
 *   1. The forwarded port set IS the granted set (`relayPorts`) — the OCAP half.
 *   2. The network is created `--internal` — the boundary itself. Everything
 *      else here is scaffolding around that one flag.
 *   3. The box joins that network and ONLY that network, with the door hostname
 *      pinned to the relay.
 *   4. Bring-up is fail-closed: any failed step tears down what it created and
 *      throws, so no launch continues onto the default network.
 *
 * What these tests do NOT prove: that podman's `--internal` really removes the
 * route on a given host. That is a property of podman/netavark, verified once
 * against a live macOS box, not re-derived here — see the ADR.
 *
 *   nix run nixpkgs#bun -- test tests/door-relay.test.ts
 */
import { test, expect, describe } from "bun:test";
import { tcp, unix, type DoorGrant } from "../guest-room/mod.ts";
import {
  RELAY_HOSTNAME,
  planRelay,
  relayBoxArgv,
  relayForwardScript,
  HOST_SIDE_NETWORK,
  relayIpInspectArgv,
  relayNetworkCreateArgv,
  relayPorts,
  relayRunArgv,
  relayTeardownArgv,
  startDoorRelay,
} from "../door-relay.ts";

const door = (name: string, port?: number): DoorGrant => ({
  name,
  host: port ? tcp("127.0.0.1", port) : unix(`/run/doors/${name}d.sock`),
  guest: port ? tcp(RELAY_HOSTNAME, port) : unix(`/run/doors/${name}d.sock`),
  env: `${name.toUpperCase()}D_SOCK`,
  grants: "",
  use: "",
  caveats: [],
});

describe("relayPorts: the forwarded set IS the granted set", () => {
  test("one port per TCP door, plus the per-launch scoped netds", () => {
    expect(relayPorts([door("keeper", 3001), door("net", 3128)], [49152])).toEqual([
      3001, 3128, 49152,
    ]);
  });

  test("a door that kept a unix transport contributes nothing", () => {
    // Room-expanded doors keep unix transports even in TCP mode; they are not
    // reached over the network, so they must not open a port on the relay.
    expect(relayPorts([door("launcher"), door("keeper", 3001)])).toEqual([3001]);
  });

  test("no doors ⇒ no ports (a doorless box never gets a relay at all)", () => {
    expect(relayPorts([])).toEqual([]);
  });
});

describe("planRelay: a canonical, podman-safe plan", () => {
  test("ports are de-duplicated and sorted, so the plan is a value", () => {
    expect(planRelay("abc", [3128, 3001, 3001]).ports).toEqual([3001, 3128]);
  });

  test("out-of-range junk is dropped rather than forwarded", () => {
    expect(planRelay("abc", [0, -1, 70000, 3.5, 3001]).ports).toEqual([3001]);
  });

  test("names are per-launch and podman-safe", () => {
    const plan = planRelay("1234-ab/cd$", [3001]);
    expect(plan.network).toBe("claude-box-1234-abcd");
    expect(plan.container).toBe("claude-box-relay-1234-abcd");
  });

  test("an id that sanitizes away still yields a usable name", () => {
    expect(planRelay("///", [3001]).network).toBe("claude-box-box");
  });
});

describe("the podman argv", () => {
  const plan = planRelay("t1", [3001, 3128]);

  test("the network is INTERNAL — the flag the whole boundary rests on", () => {
    expect(relayNetworkCreateArgv(plan)).toEqual([
      "podman", "network", "create", "--internal", "claude-box-t1",
    ]);
  });

  test("the relay forwards each granted port to the same port on the host", () => {
    const script = relayForwardScript(plan.ports);
    expect(script).toContain(`socat TCP-LISTEN:3001,fork,reuseaddr TCP:${RELAY_HOSTNAME}:3001`);
    expect(script).toContain(`socat TCP-LISTEN:3128,fork,reuseaddr TCP:${RELAY_HOSTNAME}:3128`);
    expect(script.trimEnd().endsWith("wait")).toBe(true);
  });

  test("the relay listens on the granted ports and NOTHING else", () => {
    const listens = [...relayForwardScript([3001]).matchAll(/TCP-LISTEN:(\d+)/g)].map((m) => m[1]);
    expect(listens).toEqual(["3001"]);
  });

  test("the relay carries no door, no mount and no config volume", () => {
    const argv = relayRunArgv(plan, "localhost/claude-personal:dev");
    expect(argv.join(" ")).not.toContain("-v ");
    expect(argv.join(" ")).not.toContain("claude-config");
    expect(argv).toContain("--entrypoint");
    expect(argv[argv.indexOf("--name") + 1]).toBe(plan.container);
  });

  test("the relay is dual-homed AT CREATION — both networks, no attach step", () => {
    // #265: podman network connect refuses a pasta-mode container, which is
    // rootless podman 5's default, so a start-then-connect relay could never
    // come up on Linux. Both homes must be named on the run itself.
    const argv = relayRunArgv(plan, "img");
    const nets = argv.filter((a) => a.startsWith("--network="));
    expect(nets).toEqual([
      `--network=${HOST_SIDE_NETWORK}`,
      `--network=${plan.network}:alias=${RELAY_HOSTNAME}`,
    ]);
  });

  test("the HOST-side network is named first, so /etc/hosts resolves to the host", () => {
    // Load-bearing, not cosmetic. podman writes host.containers.internal from
    // the network carrying a gateway; an --internal network has none. Listing
    // the internal net first would leave every socat target undialable while
    // bring-up still reported success — a silent failure where the pasta bug
    // was at least a loud one.
    const nets = relayRunArgv(plan, "img").filter((a) => a.startsWith("--network="));
    expect(nets[0]).toBe(`--network=${HOST_SIDE_NETWORK}`);
    expect(nets[0]).not.toContain(plan.network);
  });

  test("the host-side network is podman's default bridge, not a hardcoded name", () => {
    // containers.conf can rename the default network; "bridge" is the mode
    // name that always resolves to it. A literal "podman" would silently
    // CREATE a network on a host that renamed it.
    expect(HOST_SIDE_NETWORK).toBe("bridge");
  });

  test("the box joins the internal network and pins the door host to the relay", () => {
    const argv = relayBoxArgv(plan, "10.89.0.2");
    expect(argv).toContain(`--network=${plan.network}`);
    expect(argv).toContain(`${RELAY_HOSTNAME}:10.89.0.2`);
    expect(argv.filter((a) => a.startsWith("--network=")).length).toBe(1);
  });

  test("the address read is the one ON the internal network, not the relay's host-side one", () => {
    // Reading the default-network address here would hand the box a route it
    // must not have — the two interfaces are the entire point of the relay.
    expect(relayIpInspectArgv(plan).join(" ")).toContain(`index .NetworkSettings.Networks "${plan.network}"`);
  });

  test("teardown removes the container before the network it is attached to", () => {
    expect(relayTeardownArgv(plan)).toEqual([
      ["podman", "rm", "-f", plan.container],
      ["podman", "network", "rm", plan.network],
    ]);
  });
});

describe("startDoorRelay: fail-closed bring-up", () => {
  const plan = planRelay("t2", [3001]);
  const ok = { exitCode: 0, stdout: "", stderr: "" };
  const nap = async () => {};

  /** Records the podman calls, failing whichever verb the test names. */
  const runner = (fail?: string, ip = "10.89.0.2") => {
    const calls: string[][] = [];
    const run = (argv: string[]) => {
      calls.push(argv);
      const verb = argv.slice(1).join(" ");
      if (fail && verb.startsWith(fail)) return { exitCode: 1, stdout: "", stderr: "boom" };
      if (argv.includes("inspect")) return { ...ok, stdout: ip };
      return ok;
    };
    return { calls, run };
  };

  test("happy path: creates the network, starts the relay, attaches it, reports the address", () => {
    const { calls, run } = runner();
    return startDoorRelay(plan, "img", run, nap).then((relay) => {
      expect(relay.ip).toBe("10.89.0.2");
      const verbs = calls.map((c) => c.slice(1, 3).join(" "));
      expect(verbs.slice(0, 2)).toEqual(["network create", "run -d"]);
      // The attach step is gone, not reordered (#265).
      expect(verbs).not.toContain("network connect");
    });
  });

  test("a failed network create throws and starts nothing", async () => {
    const { calls, run } = runner("network create");
    await expect(startDoorRelay(plan, "img", run, nap)).rejects.toThrow(/internal network/);
    expect(calls.some((c) => c.includes("run"))).toBe(false);
  });

  test("a failed relay start tears down the network it created", async () => {
    const { calls, run } = runner("run -d");
    await expect(startDoorRelay(plan, "img", run, nap)).rejects.toThrow(/door relay/);
    expect(calls.some((c) => c.join(" ") === `podman network rm ${plan.network}`)).toBe(true);
  });

  test("no attach step exists to fail — the relay is dual-homed at creation", async () => {
    // Replaces "a failed attach tears down BOTH". That test could only pass
    // because bring-up HAD an attach step; #265 removed it, and the property
    // worth keeping is that nothing calls network connect at all.
    const { calls, run } = runner();
    await startDoorRelay(plan, "img", run, nap);
    expect(calls.some((c) => c.join(" ").includes("network connect"))).toBe(false);
  });

  test("a relay that never gets an address tears down BOTH — no half-built relay", async () => {
    // The teardown-on-partial-failure property the attach test used to carry,
    // rehomed onto the failure mode that still exists.
    const { calls, run } = runner(undefined, "");
    await expect(startDoorRelay(plan, "img", run, nap)).rejects.toThrow(/never got an address/);
    const done = calls.map((c) => c.join(" "));
    expect(done).toContain(`podman rm -f ${plan.container}`);
    expect(done).toContain(`podman network rm ${plan.network}`);
  });

  test("no address ever appearing throws rather than launching a box with no door", async () => {
    const { run } = runner(undefined, "");
    await expect(startDoorRelay(plan, "img", run, nap)).rejects.toThrow(/never got an address/);
  });
});
