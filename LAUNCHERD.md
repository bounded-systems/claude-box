# launcherd — the launch door (spawning a room is a capability too)

The host/box split in [ROOM.md](./ROOM.md) — "edit code in the room, but run
`podman` on the host" — exists for exactly one reason: spawning a container needs
the podman socket, and a room's cap-drop floor (`--cap-drop all`,
`--security-opt no-new-privileges`, no nested podman) forbids holding it. So
*claude-box working on claude-box* can't run a real launch, or the `ocap` tests
that spin up the image, from inside — those bounce to the host.

The fix is the move the rest of the design already makes: don't hand the room the
podman socket — put **launch behind a door**. launcherd *owns* podman (and the
pinned image set) and serves a small request/response protocol; a room asks it to
launch a **sibling room**, launcherd enforces policy and returns a handle. The
room spawns rooms while holding no podman socket — the launch twin of keeperd
(writes), netd (egress), scoutd (reads), repod (the repo).

## Why launch is the most dangerous door — and the invariant that tames it

podman is effectively root on the VM, so a naïve "launch" door is a
**privilege-escalation** door: a room with launch could spawn a room with
`--keeper` it was never granted, or a `--repo-rw` / `--net-open` escape, or a
mount of an arbitrary host path — laundering authority it doesn't hold through a
child. launcherd's defining invariant rules that out:

> **Attenuation — a child room's authority is a subset of the parent's.**
> launcherd never grants a door (or an escape, or a mount) the requesting room
> doesn't already hold. Launch can only *narrow*, never widen.

This is the OCAP delegation rule: you may pass on a capability you hold
(attenuated), but you cannot mint one you lack. With attenuation, launch is safe
to delegate — the worst a room can do is spawn a **weaker copy of itself**.
Without it, launch is a master key. Concretely launcherd enforces:

- **door attenuation** — child doors ⊆ parent doors; the parent's
  `$CLAUDE_BOX_CAPABILITIES` is the ceiling. No `--keeper` for a child unless the
  parent held keeper.
- **no escape minting** — `--repo-rw` / `--net-open` only if the parent held
  them; otherwise refused.
- **pinned images only** — launches from a content-addressed allowlist (same
  provenance posture as the box image), never an arbitrary image ref.
- **the cap floor on every child** — `--cap-drop all`,
  `--security-opt no-new-privileges`, `--pids-limit`, `--network=none` by default
  — copied to children, non-negotiable.
- **depth + resource limits** — a max nesting depth and per-room caps, so launch
  can't fork-bomb rooms.
- **audit** — every launch logged `ts, parent, image, doors, ALLOW|DENY`.

## The contract (sketch)

launcherd serves a typed request/response over the unix socket — the room asks,
launcherd enforces and returns a **handle, never the runtime**:

| Request | Returns | Policy |
|---|---|---|
| `launch <image> --door … [--repo …]` | a room handle (id) + its capability manifest | image allowlist; door-set **attenuated** to the parent's; cap floor forced |
| `wait <id>` / `logs <id>` | exit code / output | only rooms this parent launched |
| `stop <id>` | termination ack | only this parent's rooms |

No podman socket, no `docker.sock`, no privileged fd crosses back. The child is
itself a room (doors + rulebook); the parent observes it through the handle.

Framing **reuses keeperd's** — a 4-byte big-endian length prefix + UTF-8 JSON,
each request validated against a typed schema before it touches podman — so
launcherd is the same daemon *shape* as keeperd / scoutd, not a new protocol.
One framing, one set of socket-server primitives, across the whole door family.

## Why this collapses the self-hosting split

With launcherd in the pod (alongside keeperd / netd / scoutd / repod, all in the
VM post-`prx-zj8`), *claude-box working on claude-box* becomes **one room**: it
edits the launcher (read/overlay via repod), commits via keeperd, reads via
scoutd, reaches the model via netd — and runs the **real launch + `ocap` tests**
by asking the launch door, holding no podman socket. The "tier-1 in-box / tier-2
on the host" split in ROOM.md dissolves: tier-2 was host-bound *only* because
launch was ambient. Behind a door, it's just another grant.

It also closes the **provenance** loop. A launch is the natural place to record
"room X (manifest M) launched room Y (manifest N)" — the delegation edge in the
capability-provenance chain ([CAPABILITIES.md](./CAPABILITIES.md),
[contract/CHAIN.md](./contract/CHAIN.md)). Attenuation makes that edge sound:
Y's authority is provably ⊆ X's.

## Launcher shape (design)

```
claude-box work --room dev --launcher   # dev room + the launch door
# → -v <launcherd.sock>:/run/launcherd.sock  --env LAUNCHERD_SOCK=/run/launcherd.sock
```

A `--launcher` preset forwards the launcherd socket like every other door.
Granted ⇒ "spawn sibling rooms via launcherd, **attenuated to your own
authority**; you hold no podman socket." Denied ⇒ "no launch — you cannot spawn
rooms; relaunch with `--launcher`." Wire it into `knownDoors()` once launcherd
exists (the claude-box-side follow-up, same as scout).

## Status

Design. launcherd is an external daemon (lives with keeperd / netd / scoutd /
repod in the pod, `prx-zj8`); the `--launcher` preset is not yet wired. The room
profile ([ROOM.md](./ROOM.md) move 1) is **implemented**; this is **move 2** —
the one that makes self-hosting a single room. Pairs with ROOM.md (the topology +
why), CAPABILITIES.md (the model + provenance), and NETD.md / SCOUT.md / REPOD.md
(the sibling doors).
