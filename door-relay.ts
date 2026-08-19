/**
 * door-relay — route-level door reachability for TCP mode (issue #236, the
 * follow-up tracked in #257; design in ADR-NETWORK-POSTURE.md).
 *
 * ## The hole this closes
 *
 * In TCP mode the daemons behind a box's doors live on the *host*, so the box
 * has to be able to route to `host.containers.internal:PORT`. The only way
 * run() had to grant that was podman's **default network** — which also carries
 * full outbound NAT. So granting *door reachability* incidentally granted
 * *internet egress*: a `--keeper`-only box on macOS could reach any host on the
 * internet, with no netd allowlist and no netd audit entry (#236). The
 * transport widened egress as a side effect of a capability that has nothing to
 * do with egress. That is the bug.
 *
 * ## The mechanism
 *
 * Reconstruct unix-socket mode's "only the granted sockets are reachable" over
 * TCP, per the ADR's first-choice mechanism:
 *
 *   ┌── internal network (no gateway, no NAT) ──┐
 *   │  box ───────────────▶ relay :3001 :3128 ──┼──▶ host.containers.internal:PORT
 *   └───────────────────────────────────────────┘        (default network)
 *
 * - A **per-launch `--internal` podman network.** An internal network has no
 *   gateway and no NAT, so a container on it has *no route* to anything off the
 *   subnet. That is the route-level boundary: it holds against a malicious
 *   in-box process, not merely a cooperative one that honors `HTTPS_PROXY`.
 * - A **launcher-owned relay container**, dual-homed on that internal network
 *   and on the default network. It listens on exactly the granted doors' ports
 *   and forwards each to the same port on `host.containers.internal`. It is the
 *   box's only path off the subnet, and it is a *port-for-port forwarder*, not
 *   a router — nothing it does not listen on is reachable through it.
 * - The box joins **only** the internal network, with `host.containers.internal`
 *   pinned to the relay. So every existing door URL and proxy URL keeps working
 *   byte-for-byte — `planDoorMounts`, `resolveDoor` and `NETD_TCP_PROXY` need no
 *   changes at all; the name simply resolves to the relay instead of the host
 *   gateway.
 *
 * The set of forwarded ports IS the set of granted doors. That is what makes
 * this an OCAP mechanism rather than a firewall: reachability is derived from
 * the grant, so "what the box is told it holds" and "what the box can reach"
 * are the same list by construction — the property `networkPosture()` already
 * enforces for the manifest, now extended to the route itself.
 *
 * Everything here except `startDoorRelay` is pure and unit-tested
 * (tests/door-relay.test.ts); `startDoorRelay` is the thin imperative shell.
 */

import type { DoorGrant } from "./guest-room/mod.ts";

/** The ports a launch's relay must forward: one per granted door with a TCP
 *  transport, plus `extra` for the per-launch scoped netds (`--repo-origin`'s
 *  git-pull door, `--remote-control`/`--pathbase`'s widened egress door) whose
 *  ports are allocated at launch time and so cannot come from the catalog.
 *
 *  This is the OCAP-critical derivation: the forwarded set IS the granted set,
 *  so what the box is told it holds and what the box can reach are the same
 *  list by construction. Doors that kept a unix transport contribute nothing —
 *  they are not reached over the network in the first place. */
export function relayPorts(doors: DoorGrant[], extra: number[] = []): number[] {
  const ports = doors.flatMap((d) => (d.guest.kind === "tcp" ? [d.guest.port] : []));
  return [...ports, ...extra];
}

/** A per-launch relay: the internal network, the relay container, and the
 *  host ports it forwards — exactly the granted doors' ports, nothing else. */
export type RelayPlan = {
  /** Per-launch internal podman network. */
  network: string;
  /** Per-launch relay container. */
  container: string;
  /** Host ports forwarded, ascending and de-duplicated. The box can reach these
   *  and nothing else; this list is derived from the grants, never widened. */
  ports: number[];
};

/** The name the box reaches its doors by. Unchanged from non-relay TCP mode —
 *  the point of pinning it to the relay is that no door plumbing has to know
 *  the relay exists. */
export const RELAY_HOSTNAME = "host.containers.internal";

/** Podman refuses a container/network name that isn't [a-zA-Z0-9_.-]+, and the
 *  launch id reaches us from a caller-controlled place, so normalize rather
 *  than trusting it. Also bounded, because podman name limits are not generous. */
function safeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 32);
  return cleaned || "box";
}

/** Plan a launch's relay. Pure. `ports` is the granted doors' host ports (plus
 *  any per-launch scoped netd); it is sorted and de-duplicated so the plan is a
 *  canonical value — two launches with the same grants plan identically, which
 *  is what makes the plan comparable in tests and in the manifest. */
export function planRelay(id: string, ports: number[]): RelayPlan {
  const clean = [...new Set(ports)].filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  clean.sort((a, b) => a - b);
  const slug = safeId(id);
  return { network: `claude-box-${slug}`, container: `claude-box-relay-${slug}`, ports: clean };
}

/** `podman network create` argv for the plan's internal network.
 *
 *  `--internal` is the whole boundary: no gateway is configured, so a container
 *  on this network has no route off the subnet. Without this flag every other
 *  part of this module is theatre. */
export function relayNetworkCreateArgv(plan: RelayPlan): string[] {
  return ["podman", "network", "create", "--internal", plan.network];
}

/** The relay's forwarding script: one `socat` listener per granted port,
 *  forwarding to the SAME port on the host. Ports are integers by construction
 *  (planRelay filters), so they cannot inject shell.
 *
 *  `fork` so each listener serves concurrent connections; `reuseaddr` so a
 *  relaunch after an unclean exit doesn't hit TIME_WAIT. `wait` keeps PID 1
 *  alive; if any listener dies the container stays up but that port stops
 *  answering — a door that fails CLOSED, which is the correct direction. */
export function relayForwardScript(ports: number[]): string {
  const lines = ports.map(
    (p) => `socat TCP-LISTEN:${p},fork,reuseaddr TCP:${RELAY_HOSTNAME}:${p} &`,
  );
  return [...lines, "wait"].join("\n");
}

/** The host-side network the relay is born on. `bridge` is podman's name for
 *  the default bridge network, deliberately in preference to hardcoding
 *  `podman`: the default's actual name is configurable in containers.conf, and
 *  a wrong guess would silently create a network rather than joining one. */
export const HOST_SIDE_NETWORK = "bridge";

/** `podman run` argv for the relay container.
 *
 *  DUAL-HOMED AT CREATION, both networks named here (#265). The relay needs the
 *  bridge to reach the host and the internal network to be reachable by the
 *  box, and it must have both before its entrypoint runs.
 *
 *  Order matters, and not for style. podman writes the container's /etc/hosts
 *  at creation, and `host.containers.internal` — which every socat target in
 *  `relayForwardScript` dials — comes from the network that has a gateway. The
 *  internal network has none, by construction. So the bridge is listed FIRST
 *  and the relay resolves that name to the HOST, while the box (a different
 *  container, on the internal network only) resolves the same name to the
 *  RELAY via `relayBoxArgv`'s `--add-host`. Two containers, one hostname, two
 *  answers: that split is the whole mechanism.
 *
 *  This replaced a start-then-`podman network connect` sequence, which was not
 *  merely uglier — it was BROKEN on rootless podman 5.x, whose default network
 *  mode is `pasta`, and `podman network connect` refuses a pasta-mode
 *  container ("invalid network mode"). Fail-closed meant the launch aborted
 *  rather than widening, so no box ever got a bad boundary; but no box could
 *  start either. Found by tests/door-relay-live.test.ts on its first CI run.
 *
 *  Inverting the old order instead — internal first, then connect the bridge —
 *  would have swapped a loud failure for a silent one: the relay would be born
 *  where `host.containers.internal` resolves to nothing, so every forward would
 *  fail to dial while bring-up reported success. */
export function relayRunArgv(plan: RelayPlan, image: string): string[] {
  return [
    "podman", "run", "-d", "--rm",
    "--name", plan.container,
    // Host side first — see the ordering note above.
    `--network=${HOST_SIDE_NETWORK}`,
    // Box side, carrying the door hostname as a DNS alias so in-box resolution
    // works even where /etc/hosts is managed differently.
    `--network=${plan.network}:alias=${RELAY_HOSTNAME}`,
    // No doors, no mounts, no config volume: the relay holds no capability of
    // its own. It moves bytes between two ports it was told about.
    "--entrypoint", "sh",
    image,
    "-c", relayForwardScript(plan.ports),
  ];
}

/** The box's own network flags: join ONLY the internal network, and pin the
 *  door hostname to the relay's address on it.
 *
 *  This is the half that has to be exactly right — a box that also got the
 *  default network would have the #236 hole back, so the caller must not add
 *  any other `--network`. */
export function relayBoxArgv(plan: RelayPlan, relayIp: string): string[] {
  return [
    `--network=${plan.network}`,
    "--add-host", `${RELAY_HOSTNAME}:${relayIp}`,
  ];
}

/** `podman inspect` argv for the relay's address ON the internal network (not
 *  its default-network address, which the box must never learn or reach). */
export function relayIpInspectArgv(plan: RelayPlan): string[] {
  return [
    "podman", "inspect", plan.container,
    "--format", `{{(index .NetworkSettings.Networks "${plan.network}").IPAddress}}`,
  ];
}

/** Teardown argv, in order. `-f` because the relay is still serving when the
 *  box exits; the network can only be removed once nothing is attached. */
export function relayTeardownArgv(plan: RelayPlan): string[][] {
  return [
    ["podman", "rm", "-f", plan.container],
    ["podman", "network", "rm", plan.network],
  ];
}

/** A started relay: where the box should point `host.containers.internal`, and
 *  how to tear the whole thing down. */
export type StartedRelay = { plan: RelayPlan; ip: string; stop: () => void };

type Runner = (argv: string[]) => { exitCode: number; stdout: string; stderr: string };

const podman: Runner = (argv) => {
  const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: p.exitCode ?? 1,
    stdout: p.stdout.toString().trim(),
    stderr: p.stderr.toString().trim(),
  };
};

/** Bring up a launch's relay, or throw.
 *
 *  Throwing is the point: there is no fallback path. If the relay cannot be
 *  brought up we must NOT quietly hand the box the default network — that is
 *  precisely the silent widening #236 was. The caller turns this into a failed
 *  launch, so a box either gets the boundary it is promised or does not start.
 *
 *  `run` is injectable so the sequencing can be tested without podman. */
export async function startDoorRelay(
  plan: RelayPlan,
  image: string,
  run: Runner = podman,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<StartedRelay> {
  const created = run(relayNetworkCreateArgv(plan));
  if (created.exitCode !== 0) {
    throw new Error(`could not create the internal network ${plan.network}: ${created.stderr}`);
  }
  const stop = () => {
    for (const argv of relayTeardownArgv(plan)) run(argv);
  };
  try {
    const started = run(relayRunArgv(plan, image));
    if (started.exitCode !== 0) {
      throw new Error(`could not start the door relay: ${started.stderr}`);
    }
    // No attach step: relayRunArgv names both networks, so the relay is
    // dual-homed the moment it exists (#265). One fewer sequenced call in the
    // fail-closed path is one fewer partial state to unwind.
    //
    // The poll stays, now as defence rather than necessity: the address is
    // assigned at creation, but podman has reported it a beat late, and a box
    // launched against an empty address would have no door.
    for (let i = 0; i < 40; i++) {
      const ip = run(relayIpInspectArgv(plan));
      if (ip.exitCode === 0 && ip.stdout) return { plan, ip: ip.stdout, stop };
      await sleep(250);
    }
    throw new Error(`the door relay never got an address on ${plan.network}`);
  } catch (e) {
    stop();
    throw e;
  }
}
