# claude-box decomposition — execution breadcrumb

**The canonical plan is NOT here.** It lives in `bounded-systems/.github-private`:

- Plan / hand-off: [`docs/handoffs/claude-box-decomposition.md`](https://github.com/bounded-systems/.github-private/blob/main/docs/handoffs/claude-box-decomposition.md)
- Interface rule (the contract method): [`docs/contracts-and-interfaces.md`](https://github.com/bounded-systems/.github-private/blob/main/docs/contracts-and-interfaces.md)
- Tracked under **epic #5**; overlaps **keeperd #10**. No dedicated issue tree filed yet (skipped).

This file is only the **claude-box-side execution breadcrumb** — the actual file-moves happen
in *this* repo, so a future claude-box-scoped session starts here. Beads mirror: epic
`prx-ii01` (+ tasks).

## Canonical slugs (validated 2026-06-16)

Convention: daemon `<role>d` ↔ door/image/repo `door-<role>` ↔ room `<agent>-room`. Every door
repo slug == its existing GHCR image slug.

| Piece | Canonical slug | Notes |
|---|---|---|
| `contract/` | **`ocap-provenance`** (exists) | `contract/` IS ocap-provenance (vendored) → **de-vendor into the existing repo**, NOT a new "door-kit" |
| `lib/` | **`door-kit`** | door-client SDK — `lib/` **only** (the earlier "door-kit = contract+lib" was wrong) |
| `keeperd.ts` | **`door-keeper`** | #10 template |
| `netd/` | **`door-net`** | `peercred/` Rust helper travels here |
| `scoutd.ts` | **`door-scout`** | distinct from prx's `packages/scout` + `cas` (prx-523); `door-` prefix disambiguates |
| `concierged.ts` | **`door-concierge`** | "after naming" flag resolved — keep concierge |
| `peercred/` crate | **`door-peercred`** (verify crates.io) | `peercred` is generic / flat-namespace collision risk |
| `spike/doors.capnp` | fold into **`guest-room`** | engine owns the protocol; no separate repo |
| `launcherd.ts` | part of **`claude-room`** | the launcher, not a door |
| room + `claude-image` | **`claude-room`** | rename `prx-3beu` |
| host overlay | **`claude-room-host`** | not `claude-box-host` |

## Execution order, card-by-card (rationale in the hand-off)

1. **contract** — ✅ **DONE**: `contract/`→**`ocap-provenance`** (ocap-provenance#1 merged) + `lib/`→**`door-kit`** (created); claude-box re-vendors both as pinned mirrors (claude-box#134, `640f3fd`).
2. **doors** — ✅ **DONE** (all four extracted, public, image-publishing, re-pointed):
   - **`door-keeper`** (template) — image `door-keeper/keeperd` · re-point claude-box#136
   - **`door-net`** — image `door-net/netd` · re-point claude-box#137
   - **`door-scout`** — image `door-scout/scoutd` · re-point claude-box#138
   - **`door-concierge`** — image `door-concierge/concierged` · re-point claude-box#139 (`a63f82d`)
   - Each: own repo + flake (eval-validated) + sha-pinned CI + published image; claude-box vendors the daemon source as a pinned mirror and still builds the image locally (image-consumption swap is card 3).
3. **core (card 3 — remaining)** — (a) swap claude-box from *building* the 4 door images to *pulling* the published ones (hermetic pull by digest; the one new bit of machinery, mind the doors VM test); (b) rename `claude-box` → **`claude-room`** (`prx-3beu`); (c) decouple **`peercred`** → its own crate with the launcher (it's a launcherd SO_PEERCRED helper, NOT a door — was mis-assigned to door-net in earlier notes).

## Door-extraction constraints (found during card-2 scoping)

- **Test ownership:** each door's *unit* tests move with it (e.g. `keeperd.test.ts`), but the
  **cross-door integration + redteam harness** (`ocap.test.ts`, `door.test.ts`, `tests/redteam/`)
  **stays in claude-box** — claude-box becomes the integrator that pins the door images and runs
  system-level tests against them.
- **Image flake not box-verifiable:** door image builds target Linux; from a darwin box only
  `nix eval` (does-it-evaluate) is possible — the real build is validated by each door's
  `publish-ghcr` CI. (Contrast card 1's mirror-checks, which build on darwin.)
- **Each door is a multi-PR effort:** extract source + flake + image + sha-pinned CI → new repo →
  claude-box re-points to the published image. Best done one door per focused session.

Pairs with [REPOD.md](REPOD.md) and the keeperd/netd/scoutd/concierged door docs.
