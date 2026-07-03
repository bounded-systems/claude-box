# CONCIERGE — service-oriented capability routing (replaces spawn/child delegation)

> Status: **design record** (no code yet). Supersedes the launcherd
> spawn/child-inheritance delegation model (reverted in #109). The load-bearing
> primitives it builds on — `attenuate` and `checkCaveats` — already ship in the
> guest-room engine.

## 1. Why — the spawn model was the wrong shape

Delegation was modeled as **launch a child box that statically inherits a
subset of my doors** (`child ⊆ parent`, checked over a door *set* at spawn).
That hierarchy was the one outlier in a system that is otherwise already
message-oriented: a DOOR is a socket brokered by a daemon, and `protocol.ts`'s
`call(socket, method, params)` is request/response message passing. keeperd,
netd, scoutd are *services you message*, not things you fork.

So delegation should follow the same grain: **don't fork yourself with less
authority — message a peer room, handing it an attenuated capability when it
must act on your behalf.** This is the canonical object-capability pattern
(capabilities are *introduced*, then *invoked*), and the hotel metaphor already
in the codebase (`guest-room`, `hotel-safe`, `room-service`) names the missing
piece exactly: a **concierge** — you don't clone yourself to get room service,
you ask the concierge, who routes you to the room that serves it.

The analogy is **etcd**: a registry of who-serves-what, with liveness leases,
that resolves a request to a live provider.

## 2. The model — concierge as INTRODUCER (not broker)

Two ways a concierge could route. We choose the introducer.

| Style | Concierge sits on… | Verdict |
|---|---|---|
| **Introducer** (chosen) | the **control plane** only — returns an *attenuated door reference*; caller then messages the serving room directly | Canonical ocap "introduction"; concierge is not a data-path bottleneck or SPOF; `attenuate` at handoff + `checkCaveats` at the target broker are the enforcement. Most etcd-like (etcd hands you the address; you connect). |
| Broker/proxy | the **data plane** — forwards every message and relays the reply | Simpler, but every call traverses the concierge — chokepoint, and it must understand every room's methods. Rejected. |

Flow:

```
   room A (caller)                concierge                 room B (provider)
        │  resolve("scout")           │                            │
        │ ───────────────────────────▶│   (registry lookup +       │
        │                             │    policy + attenuate)     │
        │  ◀───────────────────────── │                            │
        │   door ref: {socket, env,   │                            │
        │     caveats:[host=gh.com]}  │                            │
        │                                                          │
        │  call(socket, "fetch", …)  ── peer-to-peer ─────────────▶│
        │                                          checkCaveats() ─┤ DENY if outside caveat
```

The concierge never sees the `fetch` payload. It governs **who may be
introduced to what, and how narrowed** — then gets out of the way.

**Where enforcement lives (see §7):** a **door only determines availability**
(live/reachable); the door ref is **signed** by the issuer, and the **serving
room verifies that signature** (then `checkCaveats`) before honoring the call.
So *socket reachability is not authority* — a room that reaches a provider
socket without a valid signed grant is refused. That is what makes the
path-based reference safe.

## 3. The concierge door protocol

The concierge is itself a daemon behind a door (`createDoorHandlers` from
`protocol.ts`), reached at `/run/doors/concierge.sock` (`$CONCIERGE_SOCK`). Its
methods:

```ts
// A provider room announces a capability it serves.
register(params: {
  capability: string;       // logical name, e.g. "scout", "egress", "vcs-write"
  door: string;             // the provider's door socket path
  env: string;              // env var name the consumer should bind it to
  grants: string;           // one-line description (for the rulebook)
  caveats?: string[];       // ceiling: the most authority this provider will ever hand out
  lease?: number;           // TTL seconds; must re-register (heartbeat) before expiry
}) -> { ttl: number }

// A consumer asks to be introduced to a capability.
resolve(params: {
  capability: string;
  want?: string[];          // caveats the consumer requests (only ever NARROWER)
}) -> { door: DoorGrant }    // a SIGNED, attenuated grant: socket + env + grants
                             // + caveats + signature (audience/exp/nonce-bound)

// Discovery / introspection.
list() -> { capabilities: { capability: string; grants: string; live: boolean }[] }
```

`resolve` returns a **signed** `DoorGrant` (the engine type + a signature) — the
consumer hands it to `call(grant.guest, …)`. The `caveats` are
`attenuate(providerCeiling, callerPolicy ∪ want)` — the provider's ceiling,
narrowed by policy and the caller's request, **never widened**. Enforcement is
two steps at the serving room: (1) **verify the signature** (issued by prx's
signer — see §7/§9; reachability alone is not authority), then (2) `checkCaveats`
over the now-trusted caveats. The door itself only answers availability.

## 3b. tcp/"bellhop" mode — the bootstrap-trust step for a bare box (2026-07-03)

A unix caller is always trusted — the mounted socket IS authority, same as
every door in this codebase. `concierged serve --port N` additionally listens
on tcp, for a BARE box (a bastion — no `--repo`/`--auth`/etc. baked in at
launch) that has no concierge socket mounted but does have the `net` door, so
it can reach concierge the same way it reaches `authd`/`repod` over TCP.

TCP has no kernel peer identity, so `resolve` over tcp needs a credential
concierge can check — a **room**. The launcher registers one (`register-room`,
unix-only, at box-creation time), naming an audience (the box's `ROOM_ID`) and
exactly which capabilities that room may ever `resolve`:

```ts
// unix-only — the launcher calls this, never the box itself.
"register-room"(params: {
  roomId: string;           // the box's ROOM_ID (used as `audience` in resolve)
  capabilities: string[];   // e.g. ["repo"] — the room's resolve allowlist
  lease?: number;           // TTL seconds (default 3600, max 86400)
}) -> { ttl: number }
```

This is an **introduction ticket, not the capability**: registering a room
grants nothing by itself — no door details cross until the box later calls
`resolve` with a live provider present, and even then only for capabilities
in its own room's allowlist. `register`/`register-room`/`list` are refused
outright over tcp (`FORBIDDEN`) — a box must never announce a fake provider,
mint itself a room, or enumerate the registry. `resolve` over tcp with an
unknown/expired room → `ROOM_UNKNOWN`; a capability outside the room's
allowlist → `ROOM_NOT_AUTHORIZED`. `keys` (public, non-sensitive) is
unrestricted on both transports, same as today.

This is the piece that makes "launch bare, request a capability on demand"
possible at all: `repod`'s own tcp+grant mode (REPOD.md) is the *fetching*
half; this room mechanism is the *bootstrap-trust* half a bare box needs
before it can ask concierge for anything in the first place. The in-box
skill/slash-command that actually drives this end-to-end is not built yet —
see REPOD.md's Status section.

## 4. Registry + liveness (etcd-shaped)

- The registry maps `capability → provider record {door, env, grants, caveats, expiresAt}`.
- **Lease/heartbeat:** a provider re-`register`s within its TTL or its entry
  expires (etcd lease model). `list`/`resolve` skip expired entries → a dead
  room is undiscoverable, fail-closed.
- **No ambient discovery:** a consumer cannot reach a provider it was never
  introduced to. Knowing a capability *name* is not authority; the concierge
  decides whether to introduce, and how narrowed.
- Multiple providers for one capability ⇒ the concierge picks (round-robin /
  policy). [NEEDS CLARIFICATION — see §7.]

## 5. launcherd's role — lifecycle + local reference-delegation

> Refined by [ADR-CAPABILITY-TRANSPORT.md](./ADR-CAPABILITY-TRANSPORT.md): the
> blanket "launcherd does no delegation, authority only by concierge
> introduction" is softened to a **transport split**. The concierge-introduction
> model below is the **transit** (`vsock`/`tcp`) path; on the **local** (`unix`)
> path launcherd legitimately delegates by **reference-passing spawn** (it hands a
> child the parent's *actual* references from the caller's `LaunchRecord`,
> cgroup-anchored — `prx-8k08`/`prx-p4vb`).

The `child ⊆ parent` door-set check, `_parentDoors`, and the name-based
spawn-time attenuation **are gone** (`prx-e232`) — but not because launcherd
stopped delegating; because over-granting became *unsayable* (a child can only be
handed references its launch holds) rather than rejected by a check. For the
transit path, a freshly booted room still has **no** authority until it
`resolve`s capabilities through the concierge — authority is acquired by
introduction, not inherited at birth.

## 6. How a box uses it (`lib/concierge.ts`, replacing `lib/spawn.ts`'s role)

```ts
import { resolve } from "./lib/concierge";
import { call } from "./guest-room/protocol.ts";

const scout = await resolve("scout", { want: ["host=github.com"] }); // → DoorGrant
const body  = await call(scout.guest, "fetch", { url: "https://api.github.com/…" });
// A host outside host=github.com is refused by scoutd's checkCaveats — the live DENY.
```

The box learns nothing it wasn't introduced to; the door it gets is already
narrowed; enforcement is the target's `checkCaveats` (already shipped, #99).

## 7. Open questions — `[NEEDS CLARIFICATION]`

- **Engine vs product home.** The introducer protocol (register/resolve/lease)
  is guest-agnostic — does it graduate into the public `guest-room` engine
  (like `protocol.ts`/`daemon.ts`), with claude-box running a concierged
  instance? Leaning yes; it's a generic capability-introduction service.
- **Reference strength — DECIDED: capability strength is chosen by transport
  (ocap locally, signed grants in transit).** See
  [ADR-CAPABILITY-TRANSPORT.md](./ADR-CAPABILITY-TRANSPORT.md) (2026-06-26),
  which supersedes the earlier blanket "signed grants, not fd-passing" framing
  this bullet originally recorded. The split:
  - **`unix` transport (local):** the **held reference is the authority** — the
    socket fd / bind-mount *is* the grant, delegated by `SCM_RIGHTS`. Pure ocap;
    the mounted set is the capability set (`prx-sfr0`). No verify step.
  - **`vsock`/`tcp` transport (in transit):** a **door only determines
    availability** (am I live/reachable); **authority rides in a signed grant the
    serving room validates** on every call — *"do you hold a valid signed
    grant?"*, not *"can you reach the socket?"*. `SCM_RIGHTS` can't cross the
    boundary, so the signed grant is the transport-agnostic substitute over the
    `vsock`/`tcp` transports `DoorTransport` models.
  - **Signer.** Signing currently lives in **prx** (not yet extracted — likely
    its own repo). The issuer signs the grant; the serving room verifies against
    the issuer's public key. (Not keeperd.) Until extraction, the verify path is
    stubbed/deferred behind that boundary.
  - **Bind it.** A signed grant is a bearer token — bind an `audience` (which
    room may present it) and `exp`/`nonce`, or a leaked/shared grant is
    replayable. Same macaroon shape `checkCaveats` already enforces; this also
    subsumes the revocation item below (a short-lived, nonce-bound grant *is*
    the revocation story for an already-issued ref).
- **Revocation.** Lease expiry revokes *discovery*. Revoking an *already-issued*
  door ref needs more (broker-side caveat with a nonce/expiry, or the provider
  rotating its socket). Macaroon-style time/nonce caveats fit `checkCaveats`.
- **Provider selection** when several register the same capability (policy?
  health? caller affinity?).
- **Bootstrap / concierge trust.** The concierge door itself is the root
  introduction — how a box gets the `concierge.sock` ref (mounted at launch by
  launcherd's lifecycle role; it is the one ambient door, deliberately).

## 8. What this reuses (nothing wasted from the prior work)

- `attenuate` — narrows the grant at introduction time (§3).
- `checkCaveats` — the target broker enforces the introduced caveats (#99, scoutd).
- `DoorGrant` / `protocol.ts` `call` / `createDoorHandlers` — the concierge is
  just another door; `resolve` returns the engine's own grant type.
- `attenuatesDoors` — still available in the mirror; useful if a consumer
  re-introduces a *bundle* of doors onward and we want to verify the bundle
  only narrows. Not on the critical path.

## 9. Dependencies / phasing

The enforcement model (§7) leans on **signed grants**, and signing currently
lives in **prx** — not yet extracted (likely its own repo). So the security
property is *gated on that extraction*, which gives a clean build order:

- **Phase 1 (buildable now):** the introducer protocol (`register` / `resolve` /
  `list` + leases), the registry, launcherd demoted to lifecycle-only, and the
  path-addressed `DoorGrant` handoff. The signature field exists but verify is a
  **stub** — so this phase is functional plumbing, *not yet* a security boundary
  (call it out, the way #90 was "plumbing, not a boundary change").
- **Phase 2 (gated on prx-signing extraction):** wire the issuer (prx's signer)
  + the serving room's **verify** step, and bind grants (`audience`/`exp`/`nonce`).
  This is when "authority = a valid signed grant" goes live and the boundary
  actually holds.

Until Phase 2, do not claim non-bypassable introduction — Phase 1 is addressing
+ liveness only.
