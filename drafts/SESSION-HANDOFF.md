# Session Handoff — "The Guest Room"

**Date:** 2026-06-13 · **Repo:** `bounded-systems/claude-box` · **main:** `6ed51f4`
**Suite:** `bun test` → 192 pass, 0 fail

## TL;DR

Took the essay *The Guest Room* and turned its thesis into code: extracted the
guest-agnostic capability engine out of `claude-box`, made the docs executable,
enforced the seam, and cleaned up a merge collision. Five PRs landed.

## What shipped (all merged)

| PR | Title | Substance |
|----|-------|-----------|
| **#25** | guest-room: extract the engine (+ essay & executable docs) | Carved the capability engine (door → room → rulebook) out of `claude-box.ts` into **`guest-room/mod.ts`**, a self-contained module with no guest identity. `claude-box` is its first consumer (supplies `knownDoors` catalog + `knownRooms` bundles). Public exports unchanged. Added the essay `drafts/the-guest-room.md`. |
| **#26** | enforce the seam | A test fails if any guest identity (`claude`/`anthropic`/`podman`/daemon names) appears in the engine source. "The room doesn't know it's Claude" is now mechanical. |
| **#27** | feat: improve install/build experience | _(owner's PR)_ `getRunDir` → `~/.claude-box/run` default sockets, `doors init`, daemon hints, `tsconfig.json`, README Quick Start. |
| **#28** | guest-room extraction handoff | `guest-room/HANDOFF.md` — module-level pickup brief. |
| **#29** | fix the #27 merge collision | #27 merged on top of the extraction and left main messy-but-passing. Removed a duplicate `defaultHostSock` (import + local redef), untracked a committed `.bun/…​.pile` binary + gitignored `.bun/`, added `guest-room/**` to tsconfig. |

## Architecture now

```
claude-box.ts            ← PRODUCT: image, accounts, podman run(), repo flags,
  │ imports                 daemon clients, getRunDir, + the door CATALOG/rooms
  ▼
guest-room/mod.ts        ← ENGINE (guest-agnostic): resolveDoor / expandRoom /
                            deniedDoors / rulebook renderers. Names no guest.
guest-room/features/*.feature  ← executable Gherkin specs (each Scenario a bun test)
guest-room/gherkin.ts          ← tiny Gherkin runner
guest-room/guest-room.test.ts  ← wires steps to the engine + the seam guard
```

Extraction to `bounded-systems/guest-room` is now a **move + flip-the-import**,
not a refactor.

## Open follow-ups (none blocking)

1. **Make `bunx tsc --noEmit` real.** #27's `tsconfig` sets `types: ["bun-types"]`
   but it isn't installed, so tsc exits before checking code — the README's
   type-check command is currently a no-op. Needs a dep-install step (touches
   nix/bun build). _Highest priority — #27 advertised it._
2. **Generic `--door` socket path.** Known doors use the safe `~/.claude-box/run`;
   generic `--door` still falls back to world-writable `/tmp` (refused on macOS).
   Fix by injecting claude-box's run-dir into the engine's generic-door fallback.
3. **Publish the essay.** `drafts/the-guest-room.md` is publish-ready pending a
   cross-check of Quadlet key names against live `podman-systemd.unit.5` docs.
4. **Finish the extraction / rename / repo split.** Move `planLaunch` +
   `capabilityJson`'s generic parts into the engine; bundle a `claude-box →
   claude-guest`(?) rename with the eventual repo extraction so the provenance
   chain churns once.
5. **Provenance thread** (the essay's sequel / separate root `HANDOFF.md`):
   attest _which doors a launch held_ — `contract/` already has the
   `CapabilityProvenance` schema.

## Gotchas for the next session

- **Gate is `bun test`, not `tsc`** (see follow-up #1). Repo relies on Bun's
  ambient types; plain `tsc` reports false errors without setup.
- **Don't recouple the engine.** Adding a guest name to `guest-room/mod.ts` or
  `gherkin.ts` turns the seam test red — by design.
- **Squash-merge "Unverified" warnings** from the stop-hook are GitHub's merge
  artifacts (committer `noreply@github.com`), not rewritable local commits.
- **Three handoffs exist:** root `HANDOFF.md` = the _provenance_ thread
  (pre-existing); `guest-room/HANDOFF.md` = the extraction; this file = the
  session-level summary.
