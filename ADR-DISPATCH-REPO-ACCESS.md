# ADR — dispatched workers get repos through the repod door, never a bind-mount

> Status: **proposed** (2026-07-05). Tracking: builds on the working dispatch
> path (ADR-DISPATCH-PATH-NAMESPACES, ADR-RC-EGRESS-SNI) toward the goal of
> using claude-box as the substrate for the whole prx anchored chain — dispatched
> workers that can actually check out and work on prx repos. Depends on `repod`
> (REPOD.md — daemon side done, client side "NOT STARTED") and `concierged`.

## The invariant (load-bearing, from the project owner)

> **Never add the repo to the box. Give access through the socket.**

A dispatched worker MUST NOT bind-mount a host repository. No `--repo`, no host
worktree, no `.git`, no git credentials, no git binary reach into the box.
Repo access is **entirely mediated by the `repod` door** (a unix socket), exactly
as egress is mediated by netd and git-writes by keeper. This is the OCAP model
applied to the repo: the box holds a *reference to a capability*, not the thing.

Concretely: `repod` holds the bare repos and, on request, **materializes an
ephemeral worktree into a volume it owns**; the worker works in that worktree.
The host repo and its `.git` are never exposed; a compromised worker can corrupt
only its throwaway worktree, and history writes still go through the keeper door
(signed). This is strictly stronger than today's `--repo` bind-mount (which, even
with `.git` read-only, still puts the host worktree in the box).

## Context

Dispatch is doors-blind (`{room, label}`), so a dispatched worker is **repo-less**
by construction — the empty `/home/claude/claude-box` the project owner saw. To
make workers useful for prx work they need a repo, but under the invariant above
that repo can only arrive through a door.

The machinery mostly exists (REPOD.md): repod's **pod-internal unix door**
(checkout-on-demand, no `.git`/git in the consumer) and its **TCP + signed-grant
"bellhop" mode** are both built and verified live; `concierged` (capability
introducer) and `bellhop.ts` (the client) exist. What's missing (REPOD.md step 5,
"NOT STARTED"): nothing inside a box actually *calls* bellhop, repod isn't
packaged/deployed, and dispatch doesn't register a room or mount a repo door.

One fit-check that decides the transport: our dispatched workers use **SNI egress
(Anthropic-only)** and hold no `net`/netd door, so they **cannot reach repod's TCP
endpoint**. The **unix door** is therefore the only option — which is also the
more secure one (no repo-egress hole; SNI stays Anthropic-only).

## Decision

Repo access for dispatched workers is **repod's unix door**, wired into dispatch:

1. **Deploy `repod` + `concierged`** as VM services (Quadlet), alongside the door
   fleet. repod is pointed at a **repo root of bare mirrors** of the prx
   anchored-chain repos (prx, ai-home, anchored-chain, …). `concierged` already
   has a published image; `repod` needs a `repod-image` in the flake.
2. **repod registers its `repo` capability** with concierge (provider
   registration, liveness lease/heartbeat — CONCIERGE.md).
3. **At dispatch**, launcherd-rs additionally:
   - registers a **room** for the worker with concierge (`register-room`,
     `roomId = <launch_id>`, `capabilities = {repo}`) — the allow-list of what
     that box's audience may ever resolve;
   - mounts the **concierge** door socket and the **repod** door socket into the
     worker (`:z`, confined — same as the auth door), plus the repod **output
     volume** at `/work` (where materialized worktrees land). No host repo, no
     `.git`.
4. **Client side** — a `bellhop` / `/request-repo <repo> <ref>` command baked into
   the worker image so the *model* can pull a repo on demand: it resolves a
   `repo` grant from concierge (audience = its ROOM_ID), calls repod's `prepare`
   with it, and repod materializes `<repo>@<ref>` as a worktree in the output
   volume the worker already has at `/work`. Reports the checkout path.
5. **Writes reconcile via keeper**, not a writable `.git` — a worker that needs to
   push is dispatched into a room that also grants `keeper` (like `dev`), and
   commits go through the keeper door. repod's worktree `.git` is repod's, never
   the box's.

The dispatch RPC stays doors-blind `{room, label}` — it does NOT gain a `repo`
param. *Which* repo/ref is a **runtime request the model makes** via bellhop
(scoped by the room's `repo` capability), not something the dispatcher names.

## Multi-repo (the prx anchored chain)

repod's `prepare` today takes only `{ref}` against a single `REPOD_BARE_REPO`.
The anchored chain is many repos, so one of:
- **(preferred) extend `prepare` to `{repo, ref}`** — repod serves a repo *root*
  of bare mirrors and picks `<repo>` (validated against an allow-list of mirror
  names, same `assertSafeRef` discipline). One repod, one `repo` capability, many
  repos.
- one repod instance + capability per repo (`repo:prx`, `repo:ai-home`, …) — more
  units, simpler per-instance, but a combinatorial fleet.

Recommend the first. The bare mirrors are kept fresh by a separate sync (repod
materializes worktrees locally — no network in the box — so mirror freshness is a
host-side concern, e.g. `prx repo refresh`).

## Grant scoping — a prerequisite, not an afterthought

repod/concierge `gateGrant` today only checks `grant.name === "repo"` — a grant is
"any prepare on any served repo, forever" (REPOD.md step 6, **caveats NOT
STARTED**). Before workers start minting `repo` grants people expect to be narrow,
grants SHOULD carry caveats scoping them to `repo=<name>`, `ref=<name>`, and
`before=<expiry>`. This ADR makes caveat support a **blocker for step 4**
(client-side minting), not optional polish: a broad grant leaked from a worker
otherwise reads on any prx repo indefinitely.

## Consequences (build order)

1. `repod-image` in the flake; `prepare` extended to `{repo, ref}` + a mirror
   allow-list.
2. Real caveats in concierge/repod `gateGrant` (`repo`/`ref`/`before`).
3. Quadlet units: `concierged.container`, `repod.container`, a repod-output
   volume, a bare-mirror volume/dir + its refresh.
4. launcherd-rs dispatch: register-room with concierge + mount concierge/repod
   sockets + the output volume; the `repo` capability implied by the room.
5. Worker image: a `/request-repo <repo> <ref>` command (bellhop) + its door
   `use` text (VerbSpec-projected, so it can't drift — see verbspec.ts).
6. Prove end-to-end: dispatch a `dev` worker → from it, `/request-repo prx main`
   → work in `/work` → commit via keeper → confirm the host repo/`.git` never
   entered the box.

## Tradeoffs / open questions

- **No direct host repo in the box** (the invariant) means the worktree is
  repod's materialization, not the live host checkout — reconcile is via keeper,
  and a worker can't see uncommitted host-side changes. Correct per the model,
  but a different workflow than "open my repo in an agent."
- **repod output volume mounted at `/work`**: shared-but-per-worker (each worker's
  worktree is its own subdir / its own ephemeral volume) so workers can't read
  each other's checkouts. Decide sub-pathing vs per-worker volume.
- **Room lifecycle**: the room registered at dispatch should expire with the
  worker (lease/heartbeat), so a dead worker's audience becomes unresolvable —
  fail closed. launcherd-rs (or the worker) must not leave stale room entries.
- **Provenance**: repod materializing prx repos ties into the anchored-chain /
  provenance story — out of scope here, but the mirror-freshness + which refs are
  servable is where that connects.

## Provenance chain
- REPOD.md (repod daemon status — steps 3/4 done, 5/6 not started),
  CONCIERGE.md (register/resolve/room allow-list), bellhop.ts (the client),
  ADR-RC-EGRESS-SNI (why unix, not TCP, for these workers),
  ADR-DISPATCH-PATH-NAMESPACES (the dispatch substrate this extends).
