# User story — drive prx work from a ticket, through claude-box, from anywhere

> Status: **draft spec** (2026-07-05). The primary artifact the dispatch substrate
> serves. The ADRs (path-namespaces, RC-egress-SNI, repo-access, planning) are the
> *how*; this is the *what* and *why*, with acceptance criteria and explicit
> unknowns. Spec-first: if a box has to guess to satisfy this, the spec is
> incomplete — fix the spec, mark the gap `[NEEDS CLARIFICATION]`.

## Persona & goal

**Robert**, working across the **prx anchored chain** (prx, ai-home,
anchored-chain, …), often away from the desk. He wants to move a work item from
"ticket" to "PR" by **talking to claude-box from his phone or laptop**, without
ever handing a box his repos or credentials.

> *As a developer on the prx anchored chain, I want to hand a `GH-NNN` ticket to
> claude-box from the Claude app and have it planned and executed in isolated,
> credential-free boxes — so I can drive multi-repo work from anywhere, and a
> compromised box can leak nothing (no repo, no token, no ticket payload) because
> every capability arrives through a socket, never baked in.*

## The story (happy path)

1. **Robert opens the Claude app** (mobile or claude.ai/code) and attaches to the
   always-present **`dispatch`** session.
2. He says: *"Plan `GH-456`."* The dispatcher issues `dispatch {room: planning,
   label: "GH-456"}`. A **`GH-456` planning session** appears in his list.
3. He attaches to `GH-456`. It has already **read the ticket through its doors**
   (`bd show GH-456` + the GitHub issue via scout) and drafted a **beads epic +
   TDD subtasks**. He reviews/adjusts the plan in the session; it's written to
   **beads**, so it outlives the session.
4. From the dispatcher (or automatically), an **execution box is dispatched per
   `bd ready` task** — e.g. `dispatch {room: dev, label: "GH-456.3"}`.
5. He attaches to `GH-456.3`. It has a **read-write worktree of the right repo at
   `/work`, materialized through the repod door** — never a host bind-mount, no
   `.git`, no git binary, no token in the box. He directs the work; the box edits
   code in `/work`.
6. The box **commits through the keeper door** (signed) and **opens a PR**. Robert
   reviews the PR on GitHub, still from his phone.
7. Done: the ticket moved to PR. No repo, credential, or ticket body ever entered
   a box except through a socket; every box was SELinux-confined and disposable.

## Acceptance criteria

- **AC1 — drive from the app.** Attaching to `dispatch` and asking it to plan a
  ticket by id dispatches a planning box named for that ticket, visible in the
  app. *(Substrate for this exists today — dispatcher + labeled workers.)*
- **AC2 — planning reads through doors, writes to beads.** The planning box
  obtains the ticket only via `bd show GH-NNN` (beads door) and/or the GitHub
  issue (scout door), and writes an epic + subtasks to beads. No ticket payload is
  passed on the dispatch RPC.
- **AC3 — execution boxes per task.** Ready tasks (`bd ready`) can be dispatched
  as their own labeled, confined sessions.
- **AC4 — repo only through repod.** An execution box's `/work` is a repod-
  materialized worktree; asserting the box has **no host repo bind-mount and no
  `.git`** passes. Writes reconcile via keeper; a PR is opened.
- **AC5 — nothing baked in.** For every box, an audit confirms: no repo mount, no
  git/auth token in env or files, no ticket body on the dispatch argv/journald;
  all of repo/ticket/egress/credential access is via a door socket.
- **AC6 — confined & disposable.** Every worker runs `container_t` (SELinux
  confined), on SNI egress (no-MITM, Anthropic-only), and leaves no host state
  when it exits.
- **AC7 — survives a reboot.** After a Mac reboot, `dispatch` is back in the app
  without manual steps (launchd + VM linger).

## Non-goals (for this story)

- A bespoke UI — the Claude app IS the interface.
- The dispatcher managing/attaching to what it spawns — boxes are independent
  sessions; the dispatcher only relays `{room, label}`.
- Giving boxes standing credentials — everything is leased/scoped/ephemeral.

## Explicit unknowns — `[NEEDS CLARIFICATION]`

1. **Ticket → repo(s) mapping.** How does an execution box know *which* repo(s) a
   `GH-NNN` task touches? Options: encoded in the beads task the planner writes
   (e.g. a `repo=` field); inferred from the ticket; or the model asks
   `/request-repo <repo> <ref>` explicitly. Anchored-chain tickets may span
   several repos. **Needs a decision — likely the planner records it.**
2. **PR creation mechanism.** Keeper signs commits, but opening a GitHub PR needs
   `gh`/an API call with a token the box must not hold. Does keeper (or a new
   "forge" door) open the PR on the box's behalf? **Needs design — a door, not a
   token in the box.**
3. **Planning box repo read.** Does the planner need a read-only worktree (via
   repod) to plan against real code, or is the ticket + `bd` enough? (ADR-DISPATCH-
   PLANNING-FROM-TICKET leans "add readonly repod to the `planning` room.")
4. **Human-in-the-loop gates.** Where does Robert approve — plan before execution?
   PR before merge? The `permission-mode` per room? **Needs the approval contract
   defined** (execution boxes probably not auto-merge).
5. **Board → dispatch trigger.** Manual ("plan GH-456") for now; a later
   board-webhook auto-dispatch is out of scope but shapes the room/allow-list
   design.
6. **Which rooms for which work.** `planning` = `[scout, beads]`. Execution =
   `dev` (+ repo via repod). Do some tasks need `readonly`/`offline`? The planner
   choosing the room per task is an open question.

## Mapping to the build

| Story step | ADR / task | State |
|---|---|---|
| Dispatcher + labeled workers (AC1, AC6, AC7) | path-namespaces, RC-egress-SNI | **done, live** |
| Planning box from a ticket (AC2) | ADR-DISPATCH-PLANNING-FROM-TICKET / #23 | designed |
| Repo via repod (AC4, AC5) | ADR-DISPATCH-REPO-ACCESS / #22 | designed |
| PR creation without a token (unknown #2) | — | **undesigned** |
| Approval gates (unknown #4) | — | **undesigned** |

The story surfaces two genuinely-new design gaps (PR-via-door, approval gates)
that the current ADRs don't cover — those are the next specs to write before the
build closes.
