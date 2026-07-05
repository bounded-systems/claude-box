# ADR — human-in-the-loop approval gates for dispatched work

> Status: **proposed** (2026-07-05). Closes the one genuinely-undesigned gap the
> USER-STORY surfaced (unknown #4). The auth model (authd/ghappd/keeper —
> borrow-a-scoped-token, never hold) is settled and out of scope here; this is
> about *where a human approves*, not *how a box authenticates*.

## The doctrine this encodes

The project's own **Delegate → Review → Own**: delegate mechanical work to boxes,
**review at natural breakpoints**, and keep **judgment — what ships — human**.
This ADR names the breakpoints for the ticket→PR flow and the mechanism at each,
so approval is a designed contract, not an accident of whoever's watching.

## The three gates (and only three)

A dispatched box operates at **one of three trust levels**, chosen by the room it
was dispatched into, plus two workflow gates a human owns:

### Gate 0 — in-box tool approval (per box, continuous)
`claude remote-control --permission-mode <mode>` is the fine-grained gate: while
attached from the app, the human approves/declines tool calls interactively. Each
**room fixes a default permission mode**:
- `planning` → **read-heavy, auto-approve reads** (bd/scout/repod-readonly), no
  writes to approve — it produces a plan, touches nothing.
- `dev` (execution) → **approve writes** (edits, keeper commits, ghappd PR-open)
  unless the human opts into a more autonomous mode for a trusted task.
This is the moment-to-moment gate; the two below are the structural ones.

### Gate 1 — plan review, before execution is dispatched
A planning box writes an **epic + subtasks to beads** and then **stops**. It does
NOT dispatch execution. A **human reviews the beads plan** (in the session or via
`bd`) and only then dispatches execution boxes (or approves an auto-dispatch).
Rationale: the plan is the highest-leverage decision; catching a wrong breakdown
here is far cheaper than after N execution boxes ran. Planning↔execution stay
separate sessions precisely so this gate exists.

### Gate 2 — merge, always human
Execution boxes **open a PR (via ghappd) and stop — they never merge.** Merge to a
protected branch is a human action on GitHub. This is already the house rule
("Never merge into protected branches locally; use GitHub PRs"; "CI pending is a
HARD BLOCK") — this ADR just makes it a *structural property of the substrate*:
boxes are dispatched into rooms that grant **PR-open (ghappd) but not
merge**, so a box *cannot* merge even if it tries.

## Decision

1. **Rooms carry a permission mode** (Gate 0). Add `permissionMode` to the room
   record; launcherd-rs passes it as `--permission-mode` on the worker's
   `remote-control` invocation. `planning` = accept-reads; `dev` = prompt-on-write
   (default).
2. **Planning never auto-executes** (Gate 1). The `planning` room grants no
   `dispatch`/`launcher` door, so a planning box **cannot** dispatch execution —
   the human must. (A later opt-in "auto-dispatch after plan approval" is a
   deliberate escalation, not the default.)
3. **No box can merge** (Gate 2). Execution rooms grant **ghappd scoped to
   PR-open/comment, not merge** (the ghappd installation token's scope is the
   enforcement point — see GHAPPD.md's attenuation). Protected-branch rules on
   the repo are the backstop.

Net: a box's *maximum* authority is fixed by its room at dispatch time; the two
human gates (approve-the-plan, merge-the-PR) are structural, not discretionary.

## Consequences

- `launcherd.ts` + launcherd-rs room table: add `permissionMode` per room; wire
  `--permission-mode` into the worker spawn (a small `spawn.rs` addition).
- `planning` room: no dispatch/launcher door (already the case in
  ADR-DISPATCH-PLANNING-FROM-TICKET); make the "planning does not execute"
  property explicit + tested.
- ghappd deployment (GHAPPD.md) must support **scope = PR-open, not merge** on the
  lent installation token for execution rooms — the caveat that makes Gate 2
  structural. (Depends on ghappd's per-call attenuation, its stated design.)
- Nothing here needs new auth machinery — it's *room composition* + *token
  scoping* over the doors that already exist/are designed.

## Non-goals / open questions

- **Not** re-approving every tool call by policy — Gate 0's `permission-mode` is
  the knob; the human sets the box's autonomy per task, we don't hard-code it.
- **Auto-dispatch after plan approval**: an explicit future escalation (a human
  marks the plan "approved" → an automation dispatches ready tasks). Out of scope;
  the default stays human-triggered.
- **Where "plan approved" is recorded**: a beads state on the epic? A label? So an
  auto-dispatcher (later) has a signal. `[NEEDS CLARIFICATION]`.
- **Merge automation**: even with green CI, auto-merge stays off by default
  (house rule). Whether a *human-approved* PR may auto-merge on green is a
  separate, opt-in decision.

## Provenance chain
- Delegate→Review→Own + the "never merge to protected branches / CI-pending is a
  hard block" house rules (core project rules).
- Composes with ADR-DISPATCH-PLANNING-FROM-TICKET (Gate 1), GHAPPD.md (Gate 2
  token scope), and the RC `--permission-mode` flag (Gate 0). Completes the
  USER-STORY's approval contract.
