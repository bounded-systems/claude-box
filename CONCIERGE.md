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

## 5. launcherd's reduced role — lifecycle, not delegation

launcherd stops being the delegation mechanism. It keeps only **lifecycle**:
boot a room (container/daemon) so that it can `register` with the concierge.
The `child ⊆ parent` door-set check, `_parentDoors`, and spawn-time attenuation
are gone (reverted). A freshly booted room has **no** authority until it
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
- **Reference strength — DECIDED: signed grants, verified by the serving room
  (not fd-passing).** Split the responsibilities: a **door only determines
  availability** (am I live/reachable); **authority rides in a signed grant the
  serving room validates** on every call. The question becomes *"do you hold a
  valid signed grant?"*, not *"can you reach the socket?"* — socket
  *reachability stops being authority*, so the §3 path reference is safe and we
  don't need `SCM_RIGHTS`. Chosen over fd-passing because it is
  **transport-agnostic**: a signed grant works over the `vsock`/`tcp` transports
  `DoorTransport` already models, whereas `SCM_RIGHTS` is unix-local only.
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
