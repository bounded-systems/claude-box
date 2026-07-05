# ADR — dispatch a planning box from a project-board ticket

> Status: **proposed** (2026-07-05). Tracking: the front of the workflow the
> dispatch substrate is being built for (ADR-DISPATCH-PATH-NAMESPACES,
> ADR-RC-EGRESS-SNI, ADR-DISPATCH-REPO-ACCESS). This is the entry point: a ticket
> on the project board → a dispatched **planning** box that turns it into a plan.

## The assumption we're capturing

Work starts from a **ticket on the project board** — a `GH-NNN` work unit
(GitHub issue identity is canonical; mirrored in prx beads). We need to hand that
ticket to a dispatched **planning** claude-box, which reads it and produces a plan
(a beads epic + subtasks), matching the established planning↔execution split
(plan in one session, execute in another).

## The invariant (same as repo access — ADR-DISPATCH-REPO-ACCESS)

> **Give the box access through a socket; never bake the payload in.**

The dispatch RPC stays doors-blind `{room, label}`. So the ticket reaches the box
in two socket-mediated halves, nothing baked in:

- **Which ticket** = the dispatch **`label`** — set to the work-unit id, e.g.
  `label: "GH-456"`. That's an *identity string*, not the ticket contents; it
  travels fine through the doors-blind channel (it's already the human-facing RC
  session title, so the box shows up as **"GH-456"** in the app — exactly the
  session you'd attach to for that ticket).
- **The ticket contents** = read at runtime **through a door**: `bd show GH-456`
  over the **beads door** (the canonical work-unit record), and/or the GitHub
  issue + acceptance criteria over the **scout door** (external reads, no token in
  the box). The ticket body never enters the box except through those sockets.

## Decision

1. **A new dispatchable `planning` room** = doors `["scout", "beads"]` (read the
   ticket, write the plan) — deliberately **no `keeper`** (planning writes no
   code), **no `net-open`**, **no `launcher`**. Add it to `ROOMS` with
   `dispatchable: true` alongside `dev`/`readonly`/`offline`. (Egress: `net` is
   implied for the box's own RC, via the SNI gateway; `scout`'s reads go through
   its own scout-netd, unchanged.)
2. **Dispatch flow**: attach to the dispatcher ("dispatch" in the app) and ask it
   to plan `GH-456`. It issues `dispatch {room: "planning", label: "GH-456"}` →
   launcherd-rs spawns a confined planning box named `GH-456`, which appears as
   its own session in the app.
3. **In the box**, the model:
   - reads the work unit: `bd show GH-456` (beads door) for the canonical record;
     scout for the GitHub issue thread + acceptance criteria if needed;
   - produces the plan **as beads records** through the beads door — an **epic**
     from the ticket, a **P0 context task**, and TDD-ordered subtasks with
     dependencies (the standard epic shape). It does NOT execute; planning and
     execution stay separate sessions.
4. **Handoff to execution**: once the plan exists, execution boxes are dispatched
   per ready task (`bd ready`) — each into `dev` (or the right room), and, once
   ADR-DISPATCH-REPO-ACCESS lands, with a repo materialized through the repod door.

The dispatcher never sees the ticket; it only relays a `{room, label}` request.
The planning box holds a capability to *read* the board and *write* task records —
nothing more (no code write, no push, no spawn).

## Why beads is the plan sink (not "leave a plan in the box")

The plan must **outlive the planning session** (planning↔execution separation is
the whole point) and be **discoverable by the execution boxes** that come next.
beads is the shared, git-backed work-unit store keyed on the same `GH-NNN`
identity — so the epic + subtasks the planning box writes are exactly what a later
`bd ready` in an execution box reads. A plan left only in the planning box's
transcript would die with the session and be invisible to the executors.

## Consequences

- `launcherd.ts`: add the `planning` room (`["scout","beads"]`, `dispatchable:
  true`); mirror into `launcherd-rs`'s room table.
- launcherd-rs dispatch already mounts the room's doors — `scout`/`beads` sockets
  need to be reachable (beadsd + scoutd running; beadsd isn't in the current VM
  fleet yet — a deploy step).
- No change to the dispatch RPC (stays `{room, label}`). No ticket payload ever
  crosses it.
- Composes cleanly with ADR-DISPATCH-REPO-ACCESS: a planning box may also want
  **read-only** repo access (plan against the actual code) via a `readonly` repod
  grant — same socket-only invariant.

## Open questions

- **Does the planning box need repo read?** Likely yes for non-trivial planning
  (understand the code before breaking down the ticket). Add `repo` (readonly) to
  the `planning` room once repod access lands — planning gets a read-only worktree
  through repod, never a bind-mount.
- **Ticket source of truth in the box**: beads (`bd show`) vs scout (GitHub
  issue). beads is canonical for the work unit; scout for the richer issue thread /
  acceptance criteria if they live on GitHub. Probably both, beads first.
- **beadsd deployment**: the beads door daemon isn't in the current VM Quadlet
  fleet — standing it up (pointed at the repo's beads store) is a prerequisite.
- **Board → dispatch trigger**: for now a human attaches to the dispatcher and
  asks it to plan `GH-NNN`. A later automation (a board webhook / `prx` hook that
  dispatches a planning box when a ticket enters a "ready to plan" column) is a
  natural extension — out of scope here.

## Provenance chain
- The planning↔execution split, GH-NNN identity, and beads epic shape are the
  project's own workflow rules (core project rules / `prx beads`).
- Depends on the dispatch substrate (ADR-DISPATCH-PATH-NAMESPACES,
  ADR-RC-EGRESS-SNI) and composes with ADR-DISPATCH-REPO-ACCESS (repo via repod).
