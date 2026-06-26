# ADR — capability strength is chosen by transport: ocap locally, signed grants in transit

> Status: **accepted** (2026-06-26). Tracking: epic `prx-86g9`
> (object-anchored capabilities). Supersedes the blanket "signed grants, **not**
> fd-passing" decision recorded in [CONCIERGE.md](./CONCIERGE.md) §7, which
> assumed a single model had to span every transport. Settles the hinge that
> gates re-scoping the `prx-86g9` children (`prx-sfr0`, `prx-8k08`, `prx-yweb`,
> `prx-e232`, `prx-qbvx`) and fixes the verify-contract target for the signer
> work.

## Problem

What *is* a box's authority to use a door? Two models were on the table, and the
project had been treating it as a single global choice:

- **A — object-anchored (the `prx-86g9` framing).** Authority is exactly the set
  of references the box physically holds. The capability *is* the unforgeable
  socket reference; possessing it is the grant; you cannot pass a reference you
  do not hold, so over-granting is *unsayable*. This is the classic ocap model
  [OCAP.md](./OCAP.md) already claims as claude-box's lineage (Capsicum /
  seL4 / Genode). Its delegation primitive is `SCM_RIGHTS` fd-passing.
- **B — signed grants ([CONCIERGE.md](./CONCIERGE.md) §7).** Authority rides in
  a signed grant the serving room verifies on *every* call. A door only answers
  "am I live/reachable"; reachability is **not** authority. The question is "do
  you hold a valid signed grant?", not "can you reach the socket?". Already
  partly shipped: `checkCaveats` (#99), the concierge introducer.

§7 chose B *and rejected A* — explicitly because `SCM_RIGHTS` is **unix-local
only**, whereas a signed grant is transport-agnostic across the `vsock`/`tcp`
transports `DoorTransport` already models. That reasoning is correct but the
conclusion overreached: it discarded the strongest, simplest ocap primitive on
the one transport where it is *available and superior*.

## Decision

**The capability primitive is chosen by `DoorTransport`, not globally.** Both
models are canonical; each owns the transport where it is the honest answer.

| `DoorTransport` | Authority primitive | Why |
|---|---|---|
| **`unix`** (local, same kernel) | **The held reference is the authority.** Possession of the socket fd / bind-mount *is* the grant. Delegation by `SCM_RIGHTS`. The mounted set *is* the capability set; over-granting is unsayable. | Pure ocap — Capsicum-style rights-limited fds. The strongest model, and `SCM_RIGHTS` is available precisely here. No verification step to stub, nothing to forge. |
| **`vsock` / `tcp`** (across a VM/network boundary) | **Authority rides in a signed grant**, verified per-call by the serving room. Reachability ≠ authority. Grant is a macaroon-shaped bearer token bound to `audience` + `exp`/`nonce`. | You physically cannot pass an fd across the boundary, so the reference can't *be* the authority. A signed grant is the transport-agnostic substitute, enforced by the `checkCaveats` machinery already shipped. |

The two are not a compromise — they are the same ocap thesis ("authority is a
specific unforgeable thing you hold, never ambient") expressed in the strongest
form each transport admits. Locally the unforgeable thing is the fd; in transit
it is a signature. Neither leans on ambient authority; neither trusts a
self-reported ceiling.

### What this settles for the `prx-86g9` children

- **`prx-sfr0` — mount only held doors** (stop bind-mounting the whole
  `/run/doors`, claude-box.ts:1417). On the `unix` transport this is **the real
  boundary**, not defense-in-depth: the mounted set becomes the capability set.
  High value, low cost — do it first.
- **`prx-8k08` — reference-passing spawn.** Split by transport. Local spawn
  delegates the **held reference** (`SCM_RIGHTS` fd-passing / per-launch proxy
  socket); cross-boundary spawn delegates an **attenuated signed grant**. Drop
  the name-based `params.doors` strings + `_parentDoors` either way.
- **`prx-yweb` — caveat enforcement via interposition.** Two enforcement points:
  locally, an interposing proxy that holds the upstream ref and enforces caveats
  on traffic (a delegated-and-narrowed door becomes a genuinely weaker
  capability); in transit, `checkCaveats` over the signed grant (already
  shipped). Same caveat vocabulary on both.
- **`prx-e232` — retire the lineage authz path** (`attenuatesDoors` ⊆ check,
  `_parentDoors`, depth/`maxDepth`). Becomes vestigial under *both* primitives —
  locally because you can't pass a ref you don't hold, in transit because the
  signed grant is self-describing and verified. Retire only **after** the
  unix-mount boundary (`prx-sfr0`) and signed-grant verify are both live;
  `prx-irs5` stays as the stopgap until then.
- **`prx-qbvx` — policy at the root mint only.** Unchanged and reinforced:
  launcherd policy gates the *initial* grant at root launch; post-root
  delegation is unchecked by construction (local: can't pass what you don't
  hold; transit: can only attenuate a signed grant, never widen it).

## ocap fit

This *strengthens* the [OCAP.md](./OCAP.md) lineage claim rather than diluting
it. OCAP.md maps "capability = unforgeable reference" onto the unix-socket fd —
that mapping is now **literally true on the `unix` transport** instead of being
softened to "name hint + env var." The `vsock`/`tcp` case is where the canon's
*designation-vs-authority* distinction earns its keep: a path you can reach is
mere designation; the signed grant is the authority. Naming the lineage commits
us to unforgeability on every transport — this ADR is how we honor that commit
when an fd can't cross the wire.

## Concerns (the honest tradeoffs)

1. **Two enforcement paths to keep in lockstep.** A caveat must mean the same
   thing whether enforced by a local interposer or by `checkCaveats` over a
   signed grant. Mitigation: one caveat vocabulary, one `checkCaveats`
   implementation, shared by both paths — the interposer enforces the *same*
   predicates.
2. **The transit path depends on the signer, which isn't extracted yet.** Verify
   is stubbed/deferred behind the prx boundary (CONCIERGE §7). Until the signer
   ships, `vsock`/`tcp` doors fall back to today's posture. The **local** model
   has no such dependency and can land immediately — another reason to lead with
   `prx-sfr0`.
3. **"Local" must be unforgeable too.** The held-reference model is only sound if
   the box cannot reach a socket it wasn't mounted — which is exactly why
   `prx-sfr0` (mount only held doors) is load-bearing, not optional. Today's
   whole-dir mount makes the local model a fiction; fixing it makes it real.
4. **Transport is a security-relevant choice now.** Picking `tcp` over `unix`
   silently changes which primitive enforces authority. The launcher must make
   the active transport (and therefore the active primitive) explicit in the
   manifest and in [CAPABILITIES.md](./CAPABILITIES.md) / [DOORS.md](./DOORS.md).

## Consequences

- `prx-86g9` is re-scoped per the table above rather than implemented as
  fd-passing-everywhere; CONCIERGE §7's "not fd-passing" is corrected to
  "not fd-passing **in transit**."
- The signer/verifier extraction (CONCIERGE §7 "Signer") is the linchpin for the
  **transit** half and for `authd` (`prx-6194`, the remote-control credential
  broker) — one substrate, two consumers. The **local** half (`prx-sfr0`,
  local `prx-8k08`/`prx-yweb`) does not wait on it.
- [CAPABILITIES.md](./CAPABILITIES.md) and [DOORS.md](./DOORS.md) gain a
  per-door note: which transport, therefore which authority primitive.

## Open questions

- **Where the interposing proxy lives** (`prx-yweb`) — in launcherd, or a
  per-door sidecar? Affects how a narrowed local door is handed to a child.
- **Signer home and key custody** — its own repo vs prx-internal; root-key
  custody (the macaroon root key) likely belongs with a keeperd-sibling signer,
  *not* keeperd itself (CONCIERGE §7 is explicit: "Not keeperd").
- **Mixed-transport delegation** — a box holding a local `unix` door that spawns
  a child *across* a `vsock` boundary must mint a signed grant from a held fd.
  Where does that local→transit conversion happen, and who signs it?
