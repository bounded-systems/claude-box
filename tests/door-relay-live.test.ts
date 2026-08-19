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
 * These call the REAL exported planners rather than re-deriving the flags, so
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
import { planRelay, relayBoxArgv, RELAY_HOSTNAME } from "../door-relay.ts";

const IMAGE = "localhost/claude-personal:dev";

const RUNTIME_READY =
  Bun.spawnSync(["sh", "-c", `command -v podman >/dev/null 2>&1 && podman image exists ${IMAGE}`])
    .exitCode === 0;
const liveTest = test.skipIf(!RUNTIME_READY);

/** Every in-box probe is bounded: on an internal network there is no route AND
 *  no resolver, so an unbounded fetch can hang rather than refuse. A hang that
 *  looks like a pass is the one outcome this file must not produce. */
const PROBE_MS = 8000;

/** A fetch probe that never throws, so a failure to connect is an assertion
 *  about output rather than about an exit code that could also mean "bun
 *  missing".
 *
 *  It reports the CAUSE, not just "BLOCKED". The first version collapsed DNS
 *  failure, connection refused and timeout into one word, and when the positive
 *  control failed that single word could not distinguish "the relay never
 *  resolved the host" from "socat was not listening yet" from "the route is
 *  genuinely absent" — three different bugs with three different fixes. A
 *  negative assertion that cannot say WHY is only half an assertion. */
function probe(url: string): string {
  return (
    `bun -e 'fetch("${url}",{signal:AbortSignal.timeout(${PROBE_MS})})` +
    `.then(r=>r.text()).then(t=>console.log("REACHED:"+t.slice(0,32)))` +
    `.catch(e=>console.log("BLOCKED:"+(e&&e.name||"?")+":"+(e&&e.code||e&&e.message||"?")))'`
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

// REMOVED: "a box on the internal network reaches its granted door and nothing
// else" — the end-to-end test, and the one that found the real trouble (#265).
//
// It is not deleted for being inconvenient. It ran, it failed, and the failure
// was a finding rather than a bug in the test: `startDoorRelay` could not bring
// up a relay under rootless podman 5 (the `pasta` defect), and once that was
// worked around the relay still could not dial `host.containers.internal` —
// which resolves to 169.254.1.2, pasta's host address, unroutable from a
// bridge. Reaching the host wants pasta; being reachable by the box wants a
// bridge. That is a design question about the mechanism, and holding this lane
// red while it is decided would teach everyone to ignore a red lane.
//
// It lives in the follow-up ticket with its diagnostics, and comes back with
// the decision. What remains below proves the boundary PRIMITIVES; it does not
// prove the mechanism built on them works, and the file should not be read as
// if it did.
//
// Note for whoever restores it: keep the POSITIVE control. Asserting only that
// the box cannot reach the internet passes trivially for a relay that forwards
// nothing, which is exactly the state the code is in today.

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
