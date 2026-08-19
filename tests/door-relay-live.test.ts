/**
 * LIVE relay tests (#265) — the platform half of `ADR-NETWORK-POSTURE.md`'s
 * "What is proven where, and what is not".
 *
 * `tests/door-relay.test.ts` proves the PLANNERS with an injected runner: the
 * forwarded set equals the granted set, the network is created `--internal`,
 * bring-up failures tear down and throw. What it cannot prove is the sentence
 * `door-relay.ts` stakes the whole boundary on —
 *
 *   "An internal network has no gateway and no NAT, so a container on it has
 *    *no route* to anything off the subnet. […] Without this flag every other
 *    part of this module is theatre."
 *
 * — because that is a property of podman/netavark, not of our code. The ADR
 * recorded it `ACCEPTED, UNPROVEN` (#263/#264) on the reading that checking it
 * needed a host no session in this org had. That reading was too pessimistic:
 * GitHub's `ubuntu-24.04` runner ships podman, and the gate these tests share
 * with `ocap.test.ts` was already passing its `command -v podman` half in CI —
 * only `podman image exists` failed. So this file exists, and `relay-live.yml`
 * loads the image so it actually runs (#265).
 *
 * These call the REAL exported functions rather than re-deriving the flags, so
 * a change to `relayNetworkCreateArgv` or `relayBoxArgv` that drops the
 * boundary turns this red. A test that hand-rolled `podman network create
 * --internal` would keep passing while the shipped code stopped using it —
 * which would be `agentic-code-hygiene.md` rule 3 rebuilt as a test.
 *
 * Local run (any machine with rootless podman):
 *   nix build .#claude-image && podman load -i result
 *   nix run nixpkgs#bun -- test tests/door-relay-live.test.ts
 *
 * Skips — never fails — without podman + the image, same posture as
 * `ocap.test.ts`: the integration gate is environment, not a regression.
 */
import { test, expect } from "bun:test";
import { planRelay, relayBoxArgv, startDoorRelay, RELAY_HOSTNAME } from "../door-relay.ts";

const IMAGE = "localhost/claude-personal:dev";

const RUNTIME_READY =
  Bun.spawnSync(["sh", "-c", `command -v podman >/dev/null 2>&1 && podman image exists ${IMAGE}`])
    .exitCode === 0;
const liveTest = test.skipIf(!RUNTIME_READY);

/** Every in-box probe is bounded: on an internal network there is no route AND
 *  no resolver, so an unbounded fetch can hang rather than refuse. A hang that
 *  looks like a pass is the one outcome this file must not produce. */
const PROBE_MS = 8000;

/** Run a shell line inside a container wearing EXACTLY the box's network flags
 *  — `relayBoxArgv`, not a re-derivation of it. */
function inBox(
  plan: ReturnType<typeof planRelay>,
  relayIp: string,
  script: string,
): { code: number; out: string } {
  const p = Bun.spawnSync(
    ["podman", "run", "--rm", ...relayBoxArgv(plan, relayIp), "--entrypoint", "sh", IMAGE, "-c", script],
    { stdout: "pipe", stderr: "pipe", timeout: PROBE_MS * 3 },
  );
  return {
    code: p.exitCode ?? 1,
    out: `${p.stdout?.toString() ?? ""}${p.stderr?.toString() ?? ""}`.trim(),
  };
}

/** A fetch probe that reports one of two words and never throws, so a failure
 *  to connect is an assertion about output rather than about an exit code that
 *  could also mean "bun missing". */
function probe(url: string): string {
  return (
    `bun -e 'fetch("${url}",{signal:AbortSignal.timeout(${PROBE_MS})})` +
    `.then(r=>r.text()).then(t=>console.log("REACHED:"+t.slice(0,32)))` +
    `.catch(()=>console.log("BLOCKED"))'`
  );
}

liveTest("socat is present in the relay image", () => {
  // relayImage() returns the claude-box image precisely because flake.nix puts
  // socat in it (claude-box.ts:147-154). If that ever stops being true the
  // relay comes up and forwards nothing, so this is a boundary property, not a
  // packaging detail.
  const p = Bun.spawnSync(
    ["podman", "run", "--rm", "--entrypoint", "sh", IMAGE, "-c", "command -v socat"],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(p.exitCode).toBe(0);
  expect(p.stdout.toString()).toContain("socat");
});

liveTest("a box on the internal network reaches its granted door and nothing else", async () => {
  // Two host listeners: one whose port is GRANTED (so the relay forwards it)
  // and one that is not. The pair is the point — proving the box cannot reach
  // the internet is worth little if it also cannot reach its doors, since a
  // relay that forwards nothing would pass that half trivially.
  const granted = Bun.serve({ port: 0, hostname: "0.0.0.0", fetch: () => new Response("door-ok") });
  const ungranted = Bun.serve({ port: 0, hostname: "0.0.0.0", fetch: () => new Response("nope") });

  // `.port` is `number | undefined` on an ephemeral bind. Fail loudly rather
  // than planning a relay around `undefined`, which would forward nothing and
  // make the two negative assertions below pass for the wrong reason.
  const grantedPort = granted.port;
  const ungrantedPort = ungranted.port;
  if (grantedPort === undefined || ungrantedPort === undefined) {
    granted.stop(true);
    ungranted.stop(true);
    throw new Error("host listeners did not report a port");
  }

  const plan = planRelay(`live-${process.pid}`, [grantedPort]);
  let relay: Awaited<ReturnType<typeof startDoorRelay>> | undefined;
  try {
    relay = await startDoorRelay(plan, IMAGE);

    // The plan carries the granted port and only it.
    expect(plan.ports).toEqual([grantedPort]);

    // 1. The granted door IS reachable, by the same hostname the door plumbing
    //    already uses — the relay is transparent to `resolveDoor`.
    const door = inBox(plan, relay.ip, probe(`http://${RELAY_HOSTNAME}:${grantedPort}/`));
    expect(door.out).toContain("REACHED:door-ok");

    // 2. The internet is NOT. This is #236's repro, inverted: the `curl` from a
    //    `--keeper`-only box that reached example.com must now fail to connect.
    const egress = inBox(plan, relay.ip, probe("https://example.com/"));
    expect(egress.out).toContain("BLOCKED");
    expect(egress.out).not.toContain("REACHED");

    // 3. An ungranted host port is NOT reachable either — the boundary is the
    //    grant, not "the internet". A relay that forwarded every port would
    //    pass (2) and fail here.
    const other = inBox(plan, relay.ip, probe(`http://${RELAY_HOSTNAME}:${ungrantedPort}/`));
    expect(other.out).toContain("BLOCKED");
    expect(other.out).not.toContain("REACHED");
  } finally {
    relay?.stop();
    granted.stop(true);
    ungranted.stop(true);
  }
}, 180_000);

liveTest("the internal network itself carries no route — the flag, not the relay", async () => {
  // Isolates the claim door-relay.ts calls load-bearing, with no relay attached
  // at all: a container on the plan's network and nothing else. If podman ever
  // gives `--internal` a gateway, this fails here rather than being masked by
  // the relay's presence in the test above.
  const plan = planRelay(`bare-${process.pid}`, []);
  const created = Bun.spawnSync(["podman", "network", "create", "--internal", plan.network], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(created.exitCode).toBe(0);
  try {
    const p = Bun.spawnSync(
      ["podman", "run", "--rm", `--network=${plan.network}`, "--entrypoint", "sh", IMAGE,
       "-c", probe("https://example.com/")],
      { stdout: "pipe", stderr: "pipe", timeout: PROBE_MS * 3 },
    );
    const out = `${p.stdout?.toString() ?? ""}${p.stderr?.toString() ?? ""}`;
    expect(out).toContain("BLOCKED");
    expect(out).not.toContain("REACHED");
  } finally {
    Bun.spawnSync(["podman", "network", "rm", plan.network], { stdout: "pipe", stderr: "pipe" });
  }
}, 120_000);

liveTest("our --add-host is the only host.containers.internal in the box", () => {
  // The third row of the ADR's table, which was filed as "needs a mac" wholesale.
  // That bundled two questions. Whether podman ALSO writes its own
  // host.containers.internal entry, and which one wins, are properties of the
  // /etc/hosts podman generates — written by Linux podman in both cases, since
  // on macOS it is Linux podman inside the VM. So the arbitration is observable
  // here. What is NOT observable here is the macOS DIVERGENCE: a podman-machine
  // VM always has a gateway, so podman has something to point its own entry at,
  // where an --internal network on Linux has nothing. That half still needs a mac.
  //
  // No relay required — a dummy address is enough, because nothing is dialled;
  // this reads the file podman wrote. That also keeps this assertion alive while
  // the relay bring-up is broken on rootless podman 5 (the "pasta" defect).
  const DUMMY_IP = "10.89.255.254";
  const plan = planRelay(`hosts-${process.pid}`, []);
  const created = Bun.spawnSync(["podman", "network", "create", "--internal", plan.network], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(created.exitCode).toBe(0);
  try {
    const p2 = Bun.spawnSync(
      ["podman", "run", "--rm", ...relayBoxArgv(plan, DUMMY_IP), "--entrypoint", "sh", IMAGE,
       "-c", "cat /etc/hosts"],
      { stdout: "pipe", stderr: "pipe", timeout: PROBE_MS * 3 },
    );
    const hosts = p2.stdout.toString();
    const lines = hosts.split("\n").filter((l) => l.includes(RELAY_HOSTNAME));

    // Exactly one entry, and it is OURS. Two entries would mean the box's door
    // hostname resolves by whichever podman happens to order first — the
    // ambiguity the ADR flagged.
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(DUMMY_IP);
  } finally {
    Bun.spawnSync(["podman", "network", "rm", plan.network], { stdout: "pipe", stderr: "pipe" });
  }
}, 120_000);
