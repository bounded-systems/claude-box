# Capability contract — invariants (v0.1)

`capabilities.contract.json` is the single declarative source of truth for the
door/room/store surface. Both implementations are validated against it, so they
cannot drift:

- **TypeScript** — `claude-box.ts` `knownDoors()` and `launcherd.ts` `ROOMS`,
  checked by `tests/contract.test.ts`.
- **Rust** — `launcherd-rs` `doors.rs` `DOORS` and `rooms.rs` `DISPATCHABLE`,
  checked by the parity tests in those modules (they `include_str!` this
  contract and compare).

The invariants below are stated as predicates over the contract. Today they are
enforced by the validators; they are written this way deliberately so a later
**Lean** model of the Rust bindings can discharge them formally (pure data +
explicit predicates, no imperative hiding).

Let `D` = `doors`, `R` = `rooms`, `A` = `autoDoors`, `S` = `stores`.
`mount(d)` ≝ `d.mountable`. `boot(d)` ≝ `d.bootRequired`.

## I1 — every room door is a known door
```
∀ r ∈ R. ∀ n ∈ r.doors. ∃ d ∈ D. d.name = n
```
No room can name a door the catalog doesn't define.

## I2 — dispatchable rooms are safe
```
∀ r ∈ R. r.dispatchable ⇒
    (∀ n ∈ r.doors. ∃ d ∈ D. d.name = n ∧ mount(d))   // only mountable doors
  ∧ ¬r.netOpen                                          // never ambient egress
```
A dispatched box structurally cannot hold a control-plane door (`launcher`,
`dispatch` — non-mountable) nor open unrestricted egress. This is why
`dev-spawn` (holds `launcher`) and `bootstrap` (`netOpen`) are non-dispatchable.

## I3 — every dispatched box gets the auto doors
```
∀ n ∈ A. ∃ d ∈ D. d.name = n ∧ mount(d)
```
`autoDoors` (`net`, `auth`) are appended to every dispatched box's door set (it
runs its own RC server and leases its own credential). They must be mountable.
The Rust `Room::door_specs()` and the TS `handleDispatch` both realize this.

## I4 — the boot gate is core, mountable doors only
```
∀ d ∈ D. boot(d) ⇒ mount(d)
```
`bootRequired` doors are the always-on core fleet `launcherd-rs` asserts present
before it will serve. A non-core mountable door (e.g. `beads`) stays fully
resolvable for dispatch but does **not** gate boot — a beadsd outage degrades
only the `planning` room (at dispatch time), never the whole dispatch lane.

## I5 — one writer per store
```
∀ s ∈ S. |{ writer of s }| = 1  ∧  writer(s) ∉ readers(s)
```
Each persistent volume has exactly one writer. For `prx-dolt-data` that is the
`dolt` Quadlet unit; `beadsd` reaches the data over dolt's netns as a client, not
as a second SQL server. Enforced operationally by the single-writer guard on
`dolt.container` and by the deployment validator that fails if more than one unit
binds the volume writable. The retired prx-pod `dolt` must never start a
competing server on this volume.

## I6 — every door resolves to an interface  *(target — enforced once doors carry verbspec interfaces)*
```
∀ d ∈ D. mount(d) ⇒ ∃ iface. d.interface = iface ∧ iface ∈ VerbspecInterfaces
```
This contract is the **topology** layer — it says which doors *exist* and how
they're wired (socket, env, room membership, boot). It does **not** say what you
can *say* to a door — that is the **interface** layer, owned by
[`@bounded-systems/verbspec`](https://github.com/bounded-systems/verbspec): each
door's methods are verbspec verbs (typed Zod input/output), projected to the
door's NDJSON JSON-RPC transport (`dispatchNdjson`) and its published interface
doc (`toOpenRpcDocument`). Same "single source, many projections, cannot drift"
principle as this contract — one level up the stack (verbs, not nouns).

I6 links the two levels: a `door` entry gains an `interface` reference (e.g.
`"interface": "beadsd@v1"`), and the validator asserts every mountable door
resolves to a real verbspec interface — the same drift-check I1 does for room
doors, now spanning topology → interface. **Not yet enforced**: doors don't carry
verbspec interfaces yet. Enforcement lands with the first door migrated to
verbspec (beadsd); until then I6 is the stated target, not a green test.

## Scope (v0.1)
Models the launcherd **dispatch** door/room surface (`knownDoors` + `ROOMS`) and
the store single-writer map. Out of scope for now: the claude-box.ts launch-side
room bundles (`knownRooms`: `tool`/`read`/`dev`) — a natural v0.2 extension.
