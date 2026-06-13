# guest-room

A **guest-agnostic room+door capability runtime**. It is the general thing
claude-box turned out to be built on: nothing in here knows or cares who the
guest is.

> **The hotel.** A guest room is part of a *hotel* — a building of many
> independent rooms. Housekeeping resets each room at checkout; the front desk
> runs the building; guests never hold the master keyring. Between some rooms
> there are **adjoining doors** — a connecting door opens only when the desk
> unlocked it for *this* stay, and even then it reaches just the one room next
> door, not the corridor. That is exactly a capability: the guest holds a door
> to one brokered service, never the keys behind it, and never the building.

## The model

| Hotel | guest-room | claude-box (first consumer) |
|---|---|---|
| a room | walls + a furnished set of doors | a hardened container |
| an adjoining door | a **door** — one `(name, socket)` grant | `--keeper` / `--net` / `--scout` sockets |
| the service next door | a broker daemon holding the keys | `keeperd` / `netd` / `scoutd` |
| a kind of suite | a **room preset** — a named door bundle | `--room dev` / `--room read` |
| the room's house rules | the **rulebook** (granted + denied) | the injected capability manifest |
| the front desk | the supervisor | systemd / Quadlet |

A **door** is the unit of authority: the guest holds the socket, never the keys
the daemon behind it holds. A **room** is a named bundle of doors for a kind of
stay. The room hands its guest a **rulebook** keyed to exactly the doors present
— a how-to card per granted door, and a *no-rule* card per absent one — so the
surface is honest about what is **denied**, not only what is granted.

A door can be **attenuated**: narrowed by opaque *caveats* the broker behind it
enforces (a single host, a read-only mode). Attenuation is append-only, so
authority only ever decreases — a holder can hand a door onward equally or more
restricted, never wider (`attenuate(grant, caveats)`). The rulebook states the
restriction on a narrowed door, so the honest surface extends to it. The caveat
*grammar* is the consumer's; the engine carries and renders, never interprets —
the same seam that keeps it guest-agnostic. (This is the object-capability
attenuation rule; the caveats are macaroon-shaped.)

## What's here

```
guest-room/
├── mod.ts              # the engine — door resolution, room expansion, rulebook
├── gherkin.ts          # a tiny Gherkin-subset runner
├── features/           # behavior specs, EXECUTED against mod.ts
│   ├── doors.feature
│   ├── rooms.feature
│   └── rulebook.feature
├── guest-room.test.ts  # wires the steps to the engine; each Scenario is a test
└── README.md
```

The engine is parameterized over a **catalog** (the doors a kind of room can
furnish) and **room bundles** — both supplied by the consumer. `mod.ts` contains
no product identity: no image, no account model, no container runtime. Those are
the *guest*, and they stay in the consumer (see `../CAPABILITIES.md`,
`../claude-box.ts`).

## Docs that originate from the code

The `features/*.feature` files are **not prose about the engine — they run
against it**. Each Scenario is registered as a `bun test` whose steps call
`mod.ts` directly:

```sh
bun test guest-room/guest-room.test.ts
```

So the documentation can't drift: describe a behavior the engine doesn't have,
and the suite goes red. The fixture catalog in the test is a deliberately
*non-Claude* hotel — proof the engine works for any guest.

## Extraction

This directory is a self-contained internal dependency. When it graduates to
its own repo (`bounded-systems/guest-room`), it moves as-is and consumers flip
the import path — nothing here references claude-box. Concept now (the seam is
real), extraction later (see `../ROOM.md`).
