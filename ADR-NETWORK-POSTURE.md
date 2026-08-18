# ADR — network posture is one derived capability, and it reports what it enforces

> Status: **accepted** (2026-07-07) · **implemented** — the single derivation +
> honest manifest landed first (#237); the route-level TCP enforcement the
> follow-up named landed second (#257), and the truth table below is now the
> table of what is *enforced*, with no wrong cells left. Tracking:
> [#236](https://github.com/bounded-systems/claude-box/issues/236). Pairs with
> [CAPABILITIES.md](./CAPABILITIES.md) ("Network is a door — not a NIC"),
> [NETD.md](./NETD.md) (the egress door), and
> [ADR-CAPABILITY-TRANSPORT.md](./ADR-CAPABILITY-TRANSPORT.md) (the sibling
> "capability strength is chosen by transport" decision — this is its network
> analogue).

## Problem

A box's network posture was computed in **two independent places with no shared
derivation**, and they disagreed:

| Where | Derives from | Says for `--keeper`-only in TCP mode |
|---|---|---|
| `capabilityJson()` — the manifest (`$CLAUDE_BOX_CAPABILITIES`, the operator, the in-box agent) | `netOpen ? "open" : netDoor ? "policed" : "none"` | **`"none"`** |
| `run()` — the actual `podman` flags | `tcpMode && doors.length > 0` ⇒ default network; proxy env only `if (netDoor)` | **open** (full internet) |

The manifest's own comment claims *"Built from the actual grants, so it cannot
drift from reality"* and *"Egress is a capability, not ambient."* Both were
false: a box holding **any** door other than `net` (e.g. `--keeper` alone,
`--scout` alone) on macOS (TCP mode, the platform default) gets podman's default
network — full, unNAT-restricted internet egress, no netd allowlist, no netd
audit entry — while the manifest reports `network: "none"`. Verified live
([#236](https://github.com/bounded-systems/claude-box/issues/236)):
`planLaunch(["--keeper"], {DOORS_TCP:"1"})` grants only the keeper door, yet a
container under those exact conditions reached `https://example.com/` directly
(status 200).

This is not a missing line — it is an **abstraction failure**. The transport
choice (TCP vs unix socket) and the egress grant (net door vs not) are two
orthogonal axes that the code conflated:

1. **Door reachability** — the box must reach `host.containers.internal:PORT`
   to talk to the daemons behind its granted doors (keeper→3001, scout→3002…).
2. **Internet egress** — the box may reach outside hosts only via netd, or not
   at all.

In unix-socket mode these are cleanly separate: `--network=none` grants **zero**
ambient network, and each door is an individually **mounted socket**. Door
reachability is per-socket; internet egress is impossible except through the
netd socket relay. In TCP mode, granting axis 1 (a default network, so the box
can route to the host gateway) **incidentally grants axis 2** (that network has
internet NAT). The transport widens egress as a side effect of granting door
reachability. That side effect is the whole bug.

This is the exact **"granted == enforced, one source of truth"** principle the
codebase already upholds for the scout door's host allowlist (`scoutd.ts`:
*"what the agent is TOLD it may reach is exactly what scoutd ENFORCES"*) — network
posture was the one capability where it wasn't applied.

## A second, broader finding: on TCP mode, netd was advisory, not a boundary

> Resolved by #257 (below): the door relay makes netd route-enforced on TCP too.
> Kept as written because it is *why* `boundary` exists as a reported axis at
> all — and because `DOORS_TCP_RELAY=0` still buys you exactly this.

Unifying the derivation forced an honest look at every cell, and surfaced a
finding wider than #236: **in TCP mode, netd is an *advisory* egress proxy, not
a hard boundary, for every box — `--net` or not.** The container sits on
podman's default network with a real route to the internet gateway;
`HTTPS_PROXY=…netd` only constrains clients that *honor* the proxy env. A
malicious or compromised in-box process can `connect()` to any host on a raw
socket and never touch netd. The hard, route-level boundary
(`--network=none` + a mounted socket as the *only* egress path) exists **only in
unix-socket mode** (Linux / native hosts). The docs' "netd is the security
boundary" claim silently held only there.

So posture has two axes, and honesty requires reporting both:

- **egress** — what the box can actually reach: `none` / `policed` / `open`.
- **boundary** — *how* that's enforced, so `policed` cannot overclaim:
  - **`route`** — kernel/netns level: no route exists to a non-granted host.
    Holds against a *malicious* in-box process. (unix-socket `--network=none`.)
  - **`proxy`** — advisory: only `HTTPS_PROXY`-honoring clients are constrained;
    a raw socket escapes. Holds only against a *cooperative* process. (TCP-mode
    default network + proxy env.)
  - **`ambient`** — no constraint at all. (`--net-open`, and the #236 hole.)

## Decision

**Network posture is a single value, derived once from `(doors, netOpen,
transport)`, and every surface reads that one value.** The transport may not
widen egress as a side effect of granting door reachability; where it currently
does (TCP mode), the manifest reports the *enforced* reality, never the intended
one.

```ts
type NetworkPosture = {
  egress: "none" | "policed" | "open";
  boundary: "route" | "proxy" | "ambient";
};

// The ONE derivation. Pure; tested exhaustively over the truth table below.
function networkPosture(launch: Launch, env: Env): NetworkPosture;
```

The truth table (every cell reproduces `run()`'s *actual* podman behavior).
`mechanism` is the third field the posture carries: *how* the boundary is
realized, so `route` can have two realizations and `networkArgv` stays a total
function of the one value.

| netOpen | net door | transport | doors | egress | boundary | mechanism | note |
|---|---|---|---|---|---|---|---|
| yes | — | any | any | open | ambient | default | `--net-open` (deliberate, unsafe) |
| no | yes | unix | any | policed | route | netns | hard boundary — no NIC, mounted socket |
| no | yes | tcp | any | policed | route | relay | **was `proxy`** — netd is a real boundary now |
| no | no | unix | any | none | route | netns | truly no route |
| no | no | tcp | **≥1** | **none** | **route** | **relay** | **#236 closed** — doors reachable, nothing else |
| no | no | tcp | 0 | none | route | netns | 0 doors ⇒ `--network=none` |

Two rows are outside the transport axis, because their networking is somebody
else's:

| case | egress | boundary | mechanism | note |
|---|---|---|---|---|
| `--pod` | policed / open | proxy / ambient | default | the pod's own netns + its in-pod netd; giving the pod path a real boundary is its own change |
| `DOORS_TCP_RELAY=0` | policed / open | proxy / ambient | default | the deliberate opt-out — the pre-#257 posture, still reported honestly |

Consumers:

- `buildManifest()` (has `env`) computes the posture once and stores it on the
  `Manifest`.
- `capabilityJson()` emits `network` (= `egress`, unchanged key for the in-box
  prx consumer) **and a new `networkBoundary`** (= `boundary`) — so a reader on
  macOS learns their egress control is advisory, and a `--keeper`-only TCP box
  honestly reports `network: "open"`, not `"none"`.
- `run()` derives its `--network` / proxy-env decision from the same posture (a
  clear switch on `boundary`, replacing the `if (netOpen) … else if (tcpMode &&
  doors.length) … else …` tangle). Behaviour is **byte-for-byte identical** for
  every case that already worked; the only change is that the manifest now tells
  `run()`'s truth.
- An invariant test asserts `manifest.network` matches what `run()` enforces for
  every `(doors × transport)` combination — so the two can never silently
  diverge again.

### Why report the hole instead of fixing it first (the #237 decision)

An honest manifest is strictly better than a lying one, and it is the
*prerequisite* for a real fix: once posture is a single derived value, genuine
enforcement is added in **one** place (and the invariant test proves the
manifest still matches). Shipping the honest manifest now closes the
"documentation actively misleads the operator/agent" half of #236 immediately,
and turns the remaining route-level hole into a visible, tracked follow-up
rather than a silent contradiction. This mirrors the repo's ethic throughout:
never claim "hard isolation" when the mechanism is a cooperative proxy (cf.
`scoutd.ts`'s "interposition, not cooperation" distinction).

It also paid off exactly as predicted: the fix below changed **two functions**
(`networkPosture`, `networkArgv`) and added one module, because there was only
ever one place where the decision lived.

## Route-level enforcement in TCP mode (#257) — the follow-up, now landed

The goal this section set: make a non-`net` TCP box actually unable to reach the
internet (boundary `route`, not `ambient`), and make `--net` in TCP mode a real
boundary rather than advisory. The mechanisms it weighed, in its own order of
preference:

1. **Internal podman network + a per-launch door-forwarding relay.** Put the box
   on an `--internal` network (no gateway NAT) and reach each granted door
   daemon through a pod-shared bridge / a loopback forwarder the launcher owns —
   reconstructing unix-socket mode's "only the granted sockets are reachable"
   over TCP. This is the cleanest analogue of the hard-isolation mode.
2. **`pasta` outbound restrictions.** If rootless `pasta` can bound outbound
   destinations to just the door host:port set, that's a lighter mechanism.
3. **Host `pf` rules per launch.** A firewall rule scoping the container's
   egress; heaviest and most host-specific, last resort.

**Mechanism 1 is what shipped** (`door-relay.ts`). Per launch:

- `podman network create --internal claude-box-<id>` — no gateway, no NAT, so a
  container on it has **no route off the subnet**. That one flag is the boundary;
  everything else is scaffolding around it.
- A relay container, dual-homed on that network and on the default one, running
  one `socat` listener per **granted** door port, each forwarding to the same
  port on `host.containers.internal`. It forwards ports; it does not route. The
  forwarded set is derived from the grants (`relayPorts`), which is what makes
  this an OCAP mechanism rather than a firewall: what the box is told it holds
  and what the box can reach are the same list *by construction*.
- The box joins **only** the internal network, with `host.containers.internal`
  pinned to the relay. Every door URL, `$NETD_SOCK`-style env and proxy URL is
  unchanged — `resolveDoor`, `planDoorMounts` and `NETD_TCP_PROXY` never learn
  the relay exists; the name simply resolves somewhere else.

It plugs into the single `networkPosture()` derivation (as a `relay` mechanism
under a `route` boundary) and is proven by the same invariant test — the point of
this ADR. Bring-up is **fail-closed**: any failed step tears down what it built
and the launch aborts, because falling back to the default network is precisely
the silent widening #236 was, and the manifest has by then already promised a
route boundary. `DOORS_TCP_RELAY=0` is the deliberate opt-out for a host that
cannot provide an internal network — it restores the old posture *and reports it*
as `proxy`/`ambient`, so the escape hatch cannot become a quiet lie.

### What is proven where, and what is not

Per `docs/agentic-code-hygiene.md`'s rule that a gate's own claim about itself is
not evidence, the split is worth stating plainly:

- **Unit-proven** (`tests/door-relay.test.ts`, `tests/network-posture.test.ts`,
  no podman needed): the forwarded set equals the granted set; the network is
  created `--internal`; the box gets that network and only that network; the
  manifest matches the flags for every cell; bring-up failures tear down and
  throw rather than continuing.
- **Not proven by those tests**: that podman/netavark's `--internal` really
  removes the route on a given host, and that `socat` is present in the relay
  image. Those are properties of the platform, checked once against a live macOS
  box (the `curl` from a `--keeper`-only box that #236 filmed reaching
  `example.com` should now fail to connect), not re-derived on every run.

### The mechanisms not taken

Options 2 (`pasta` outbound restrictions) and 3 (host `pf` rules) remain the
fallbacks if the relay proves unworkable on some host. Either would replace
`door-relay.ts` wholesale without touching anything else: the posture is one
derivation, `networkArgv` is one map, and both already model "route, by some
mechanism" — which was the reason to unify them before fixing anything.
