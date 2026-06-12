# the room — claude-box's nested boundaries (host / VM / room)

[CAPABILITIES.md](./CAPABILITIES.md) names the model: the box is a **room**, the
agent is the **man**, capabilities are **doors**, and the per-launch manifest is
the **rulebook** the room hands the man (the Chinese Room — he translates only
via the cards for the symbols he holds). This doc is the **topology** under that
metaphor: *where the room sits, where the keys sit, and the gap between them* —
the gap that explains the macOS door wall and the reason the pod (`prx-zj8`) is
not optional.

**Two senses of "room."** The name does double duty, and both describe the same
property. In Searle's **Chinese Room**, the man manipulates symbols by a rulebook
without understanding — the box likewise acts *only* through the cards (doors) it
holds, with no ambient authority to fall back on; a symbol with no card has no
rule, so it "cannot think it can." And a **guest room** is a space you lend a
guest in your house: they get a key to *that* room and the doors you open for
them — never the master key, the safe, or the other rooms. The box is both: a
**Chinese Room** (acts via the rulebook, can't fake comprehension or authority)
*and* a **guest room** (hosted, bounded, holds no house keys). The host keeps the
keys; the guest gets doors.

## Three nested boundaries

```
┌─ your Mac (host) ───────────────────────────────────┐
│  holds the KEYS: keeperd's git creds, netd's          │
│  allowlist token; runs the `podman` CLI               │
│                                                       │
│  ┌─ the Lima / podman-machine VM (Linux) ──────────┐  │
│  │  where podman ACTUALLY runs containers          │  │
│  │  host→VM gap = virtiofs (can't carry unix       │  │
│  │  sockets → the `statfs: not supported` wall)    │  │
│  │                                                 │  │
│  │   ┌─ the container = the ROOM ───────────────┐  │  │
│  │   │  Claude runs here, cap-dropped, creds-    │  │  │
│  │   │  free. Doors + rulebook = the room's      │  │  │
│  │   │  surface.                                 │  │  │
│  │   └───────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────┘
```

| Boundary | Holds | Never holds |
|---|---|---|
| **host** (your Mac) | the **keys** — keeperd's git creds, netd's allowlist token, 1Password upstream; the `podman` CLI | — |
| **VM** (Lima / podman-machine) | the podman runtime that *runs* the container; (today, also the daemons — see below) | — |
| **room** (the container) | only **doors** (`/run/<name>.sock`) + the injected **rulebook** | no key, no token, no NIC by default |

The room is credential-free **by construction**: the keys are a whole boundary
away (the host), reachable only as doors. Least authority isn't a policy the box
obeys — it's the topology. The box *cannot* hold what was never put in it.

## Why the middle boundary is the whole story

A door is a host **unix socket** bind-mounted to a fixed in-box path
(`-v <host>.sock:/run/<name>.sock`); possessing the socket *fd* is the grant (see
CAPABILITIES.md "the box always sees a unix socket"). On a single Linux host
that's a direct mount — done. On **macOS** the socket must cross host→VM, and
that edge is **virtiofs**: a *file* transport. It carries files, not live socket
fds, so bind-mounting a host socket into the VM fails —
`statfs: operation not supported`. **That error is the macOS door wall**, and it
is why a door whose daemon runs on the host is unreachable from a room in the VM.

Two ways across, one real:

- **interim (relay).** Relay the daemon's socket to a host-local socket *on the
  podman-machine host* (`socat` / `ssh -L`), **outside the box** — the room still
  sees a plain `/run/<name>.sock`, never the wire. Stopgap for the current split.
- **end-state (the pod, `prx-zj8`).** Run the daemons as **pinned OCI images in
  the same podman pod as the box**, inside the VM. Then the door is a **local
  mount within the VM** — no host→VM hop, no relay, nothing on the wire. In the
  diagram, the middle box becomes the home of **both** the daemons **and** the
  room. claude-box was the template for that pinned-image workcell; keeperd /
  netd / scoutd / repod are its siblings.

> Today is actually worse than the diagram: it's a **two-VM split** — the box in
> the podman-machine VM, the daemons in a separate **Lima devshell** VM, so a door
> hops container → host → Lima-VM. The pod **collapses both VMs into this single
> one**, then collapses the gap to zero. The diagram is the post-pod mental model.

## The fail-closed corollary (what `--keeper --net` hits on a Mac today)

Even *before* the virtiofs wall there's a closer guard. A door's host-socket dir
must not be world-writable, or another host user can pre-create the socket and
MITM the door (`assertSocketDir`, enforced for **every** door). macOS leaves
`$XDG_RUNTIME_DIR` unset, so the default door socket lands in `/tmp` (mode
`1777`) and the launcher **refuses**:

```
claude-box: refusing door socket in world-writable /tmp (hijack risk)
  — set a private path (e.g. under $XDG_RUNTIME_DIR)
```

That's fail-closed doing its job. To actually stand a policed door on macOS you
need **all three**: a private socket dir (e.g. `KEEPERD_SOCK=~/.local/run/...`),
a **daemon serving there**, and — to cross the VM gap — **the pod**. Lacking the
pod, the policed doors are unreachable solo, so the loud unsafe interim is:

```
nix run .#claude-box -- work --repo-rw . --net-open   # no doors ⇒ no socket
                                                       # mounts, no gap, no guard
```

— exactly what the bootstrap box uses until the pod lands.

## The room as a first-class idea

The topology suggests two moves above the door registry:

1. **room = a named bundle of doors** — *implemented* (`knownRooms()`, `--room`).
   A launch was a pile of flags (`--keeper --net --scout`); a *room* is the layer
   above the door registry the way `--keeper` is a preset over the door primitive:
   `claude-box work --room dev` expands to a named door-set for a *kind* of work
   (`dev` = keeper + net + scout; `read` = scout only). Doors only — `--repo
   <path>` stays explicit (it needs a path) — and flags after `--room` compose
   over the bundle (the door Map dedupes by name). The manifest still falls out of
   the granted doors, so a room can't drift from what it grants.

2. **launch itself as a door (`launcherd`) — collapses the host/box split.**
   "Edit code in the room, but run `podman` on the host" is a split forced by one
   thing: spawning containers needs the podman socket, which the room's cap-floor
   forbids nesting. Put podman **behind a door** — a `launcherd` daemon (in the
   VM, post-pod) that launches *sibling rooms* under policy, the way keeperd owns
   git writes. Then a room can launch and test rooms **while holding no podman
   socket**, and *claude-box working on claude-box* becomes **one room**, not a
   host/box tier split. The same OCAP move that put writes behind keeperd and
   egress behind netd, applied to launch itself.

## `guest-rooms` — the name for the model, when it's extracted

"Guest room" is the right name for the *abstraction*, not necessarily this repo.
The layering already separates a runtime-agnostic core from a Claude-specific
product:

| Layer | Generic primitive | Named preset |
|---|---|---|
| capability | the **door** | `--keeper` / `--net` / `--scout` |
| launch | the **room** (`--room`) | `dev` / `read` |
| **product** | **`guest-rooms`** (the workcell framework) | **`claude-box`** (its first consumer) |

So `bounded-systems/guest-rooms` is the eventual home for the generic room+door
runtime (no mention of Claude); `claude-box` becomes one launcher built on it,
the way `--keeper` is one preset over the door primitive. **No rename now** — the
existing `claude-box` command / nix package / prx image build / provenance chain
reference it; the model graduates to `guest-rooms` *if* the core is extracted.
Concept now, extraction later.

## Status

This doc is the **mental model**. The `room` profile (move 1) is **implemented**;
the work that makes the middle boundary the home of the doors is the **pod
(`prx-zj8`)** — the highest-leverage next step, because it's what makes every door
(starting with `--net`) reachable on macOS. The `launcherd` door (move 2) is a
**design sketch**, recorded so the topology has a home. Pairs with
CAPABILITIES.md (the model) and NETD.md / SCOUT.md / REPOD.md (the doors).
