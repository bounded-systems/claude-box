# Handoff — guest-room extraction

Pickup brief for the guest-room work. The room+door capability engine is
**extracted, tested, documented, and merged to `main`**. What remains is
optional follow-on (finish the extraction, package it, rename, extract the
repo). A fresh session can continue from here cold.

**Owner:** (you) · **Refreshed:** 2026-06-13

---

## What this is

The thesis: *a good sandbox isn't a box around a program — it's a **room** you
furnish with exactly the capabilities a guest needs, and the room shouldn't know
or care who the guest is.* claude-box was built for one guest (Claude); the
general thing underneath it is **guest-room**. The model is a **hotel**:
independent rooms joined by **adjoining doors**, each door reaching one brokered
service, never the keys or the building.

## Status

| Thing | State |
|---|---|
| **PR #25** — extract `guest-room/` engine; `claude-box` consumes it; Gherkin docs; the *Guest Room* essay | **merged** |
| **PR #26** — enforce the seam (engine source names no guest) | **merged** |
| Essay `drafts/the-guest-room.md` (grounded in real Quadlet units) | merged, draft — not yet on Medium |
| Repo extraction to `bounded-systems/guest-room` | **not started** (concept now, extraction later) |
| Rename `claude-box` → `claude-guest`(?) | **not started** (deferred; see below) |

Both PRs are squash-merged; the work is durable on GitHub. Full suite: **192
tests, 0 fail** (`bun test`).

## The architecture (where things sit)

```
claude-box.ts              ← the PRODUCT (Claude launcher): image, accounts,
  │                          podman run(), repo flags, daemon clients, and the
  │                          door CATALOG (knownDoors) + room bundles (knownRooms)
  │  imports
  ▼
guest-room/mod.ts          ← the ENGINE (guest-agnostic): door resolution →
                             room expansion → the honest granted/denied rulebook.
                             Parameterized over a catalog. Names NO guest.
```

- A **door** = one `(name, socket)` grant; the room holds the socket, never the
  daemon's keys. `resolveDoor(catalog, name, host, env)`.
- A **room** = a named bundle of doors. `expandRoom(rooms, catalog, name, env)`
  (throws on unknown — fail closed).
- The **rulebook** = `capabilityPreamble(workcell)` + `grantedDoorLines(doors)` +
  `deniedDoorSection(deniedDoors(catalog, granted, suppress))`. The product
  (`claude-box.ts`) composes these with its own repo/network framing.

## Invariants — do not break

- **The engine names no guest.** `guest-room/mod.ts` and `gherkin.ts` must not
  contain `claude`/`anthropic`/`podman`/any claude-box daemon name. A test
  asserts this (`guest-room.test.ts` → "the engine stays guest-agnostic"). If it
  goes red, a guest leaked into the room. This is the extraction seam.
- **claude-box's public exports are unchanged** by the extraction —
  `resolveDoor` / `planLaunch` / `buildManifest` / `capabilityJson` /
  `capabilityPrompt` keep their old signatures (thin bindings over the engine),
  so `tests/door.test.ts` (28 tests) stays green. Don't "simplify" by changing
  those signatures without updating the tests.
- **Docs originate from the code.** `guest-room/features/*.feature` are executed
  against the engine (each Scenario is a `bun test`). Add behavior the engine
  lacks → red. Keep them executable; don't let them rot into prose.
- **The fixture catalog is deliberately non-Claude** (a "hotel" with
  keeper/net/scout). That's the proof the engine works for any guest — don't
  replace it with claude-box's real catalog (that would couple the test to the
  product and weaken the point).

## Key files

- `guest-room/mod.ts` — the engine (types + `resolveDoor` / `expandRoom` /
  `deniedDoors` / rulebook renderers).
- `guest-room/gherkin.ts` — tiny Gherkin-subset runner (parser + step registry).
- `guest-room/features/*.feature` — executable specs (doors / rooms / rulebook).
- `guest-room/guest-room.test.ts` — wires steps to the engine; the seam guard.
- `guest-room/README.md` — the hotel model + the layering table.
- `claude-box.ts` — the consumer: `knownDoors` (catalog), `knownRooms` (bundles),
  and the launch mechanics that stay product-side.
- `drafts/the-guest-room.md` — the essay (Act I houseguest problem → Act II the
  room in Podman/Quadlet → Act III the room doesn't know it's Claude → provenance
  hook).
- `ROOM.md` / `CAPABILITIES.md` — the topology + OCAP narrative this builds on.

## Next steps (optional, unstarted — pick by appetite)

1. **Finish the extraction.** `planLaunch` (flag parsing) and `capabilityJson`
   (manifest schema) still live in `claude-box.ts` and are partly generic. Move
   the genuinely guest-agnostic parts into `guest-room`, leaving only product
   flags (`--repo*`, `--net-open`) and the workcell label behind. Medium size;
   keep the 28 door tests green by preserving claude-box's export signatures.
2. **Make `guest-room` a real package.** Add `guest-room/package.json` with an
   `exports` map so it's a declared internal dependency. Small, but touches the
   nix/bun build — validate `nix build .#claude-box` / `bun test` still work.
3. **Extract the repo.** Lift `guest-room/` to `bounded-systems/guest-room`
   as-is and flip claude-box's import to the package. The seam test means this is
   a *move*, not a refactor. Bundle the **rename** (`claude-box` → e.g.
   `claude-guest`) here so the command/nix-attr/provenance chain churn once.
3. **Publish the essay.** `drafts/the-guest-room.md` is publish-ready pending a
   cross-check of Quadlet key names against the live `podman-systemd.unit.5`
   docs. It sets up the provenance post (the `contract/` / `ocap-provenance`
   thread — see the *other* `HANDOFF.md`).

## Gotchas

- This repo has **no `tsconfig.json`** and relies on Bun's ambient types; plain
  `tsc` reports false errors (missing `Bun`/`process`/`.ts` imports). The gate is
  `bun test`, not `tsc`.
- Merges to `main` are **GitHub squash-merges** (committer `noreply@github.com`),
  which a stop-hook flags as "Unverified." That's the merge artifact, not a
  rewritable local commit — don't amend merged history to satisfy it. Set
  `git config user.email noreply@anthropic.com` for your own future commits.
