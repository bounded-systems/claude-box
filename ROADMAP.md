# claude-box — roadmap & handoff

Where the door / room / pod effort stands and what's next. Pairs with
[CAPABILITIES.md](./CAPABILITIES.md) (the model), [ROOM.md](./ROOM.md) (the
host/VM/room topology), the per-door specs (NETD / SCOUT / REPOD / LAUNCHERD),
[HANDOFF.md](./HANDOFF.md) (provenance L2/L3), and
[PRX-DAEMON-HANDOFF.md](./PRX-DAEMON-HANDOFF.md) (the bridge to the prx daemons).

## The model in one line

A **room** is a credential-free container; its authority is exactly the **doors**
(`(name, socket)` pairs) mounted into it, described by a per-launch **rulebook**.
The box holds no keys — only doors. One registry (`knownDoors()` /
`knownRooms()` in `claude-box.ts`) drives mounts, env, manifest, help, and docs,
so they can't drift.

## Where we are (merged on `main`)

| Surface | State |
|---|---|
| **doors** | `keeper`, `beads`, `net`, `scout` presets + generic `--door NAME[=SOCK]` |
| **rooms** | `--room dev` (keeper+net+scout), `--room read` (scout) — named door bundles |
| **repo** | `--repo` (worktree RW, `.git` **:ro**) / `--repo-ephemeral` (parallel-safe) / `--repo-rw` (unsafe escape) |
| **egress** | `--net` (netd door) / `--net-open` (unsafe ambient escape) |
| **netd** | daemon built (`nix run .#netd`), allowlist proxy, fail-closed (lives in prx) |
| **provenance** | L1 image attestation + pinned contract; L2/L3 pending (HANDOFF.md) |
| **design docs** | NETD / SCOUT / REPOD / **LAUNCHERD** / ROOM / CAPABILITIES |

## The keystone — the pod (`prx-zj8`)

Everything *policed* depends on it. A door is a host unix socket; on macOS the box
runs in a podman-machine VM (applehv/Lima) and the host→VM **virtiofs** hop can't
carry a socket (`statfs: operation not supported`). The pod runs the daemons as
pinned OCI images **in the VM alongside the box**, so every door becomes a direct
local mount — no gap. Until then, policed doors are unusable solo on macOS and the
unsafe escapes (`--repo-rw` / `--net-open`) are the interim. See ROOM.md.

## Remaining work — split by where it can be done

**In `bounded-systems/claude-box` (this repo):**
- Un-`todo` the `ocap.test.ts` cases (`--net`, `--scout`, `--repo`, `--repo-rw`,
  `--keeper`, `--beads`) and assert acceptance — **blocked on** a podman host
  running the daemons (ideally the pod).
- Wire the `--launcher` preset in `knownDoors()` — **blocked on** launcherd.
- Migrate `--repo` to the repod **read door + in-box overlay** (REPOD.md step 2),
  retiring the `:ro` ergonomics hit — **blocked on** repod.
- Later: extract the generic core as `bounded-systems/guest-rooms` (ROOM.md);
  `claude-box` becomes its first consumer. Concept now, extraction later.

**In `bounded-systems/prx` (out of this session's scope — needs that repo):**
- `repod` daemon (read projection + overlay).
- `launcherd` daemon (LAUNCHERD.md — attenuation is the core invariant).
- **The pod (`prx-zj8`)** — run all daemons + the box as pinned images in one
  podman pod.

**Recently completed (this session):**
- **scoutd daemon** — external read door (repos/PRs/issues/URLs), now implemented
- **netd-image** — allowlist egress proxy as OCI image
- **scoutd-image** — read daemon as OCI image
- **Quadlet units** — systemd service files for all doors

**On a host / macOS:**
- Build/refresh the image, run the pod, verify policed doors end-to-end, then
  un-`todo` the ocap tests on a real host. `scripts/bringup-macos.sh` is the
  checklist.

## Suggested order

1. **The pod** — run keeperd + netd + scoutd in the pod. All images now exist;
   the pod makes `--net`/`--scout` work on macOS (direct socket mount).
2. **Un-`todo` the ocap tests** (`--net`, `--scout`, `--keeper`) once the pod runs.
3. **repod** → migrate `--repo` to read projection + overlay, un-`todo` `--repo` cases.
4. **launcherd** → wire `--launcher`; self-hosting collapses to one room.
5. **Provenance L2/L3** (HANDOFF.md) once the doors are real.

## Spike — `wip/launcherd` (reference, do NOT merge)

A box wrote a launcherd daemon directly into a checkout (a live instance of the
working-tree-isolation gap below); it's preserved on the **`wip/launcherd`**
branch. **Do not merge the branch** — its base is `d675eec` (pre-#12), so it has
no scout/room/`--launcher` and a wholesale merge would revert #14/#15. The
salvage is just `launcherd.ts` (~745 lines) + `tests/launcherd.test.ts`, which
wire launch + door checks + L2 attestation + rooms — a useful reference. Before
hardening it into a real daemon, resolve three things:

- **Attenuation is missing (the safety blocker).** It `Bun.spawn`s `podman run`
  with no parent/subset/ceiling check. That invariant — a child room's authority
  ⊆ the parent's — is what makes a launch door safe rather than a
  privilege-escalation hole (LAUNCHERD.md). Must be added.
- **Location** — LAUNCHERD.md targets `prx`; the spike lives in claude-box (like
  netd). Decide where launcherd belongs.
- **L2 overlap** — the spike signs L2 launch attestations, but HANDOFF.md
  earmarks L2 for keeperd. Decide who owns it.

## Working-tree isolation (launcher gap)

`--repo .` bind-mounts the **live host worktree** RW at `/work` (only `.git` is
`:ro`), so in-box edits mutate your real checkout and parallel boxes collide.
Two layers fix this:

1. **ephemeral host worktree — DONE:** `--repo-ephemeral` does `git worktree add`
   a temp tree at HEAD, mounts that, `worktree remove` on exit. Parallel-safe
   (each box gets its own copy), still shares the one `.git` (read-only), commits
   via keeperd apply to the original repo. No daemon needed.

2. **repod overlay** (REPOD.md) — full `.git` isolation, needs the daemon. Future.

## Dogfooding today

- **Develop** claude-box (edit + test) on the host: `nix run nixpkgs#bun -- test
  tests/` — no container needed.
- **Bootstrap dogfood** (Claude in the box, on this repo), once the image +
  podman machine are up: `claude-box work --repo-rw . --net-open`.
- **Policed dogfood** (`claude-box work --room dev --repo .`): awaits the pod.

## State pointers

- `main` @ `47119ee` (post-#15). Merged this session: **#14** (`--scout` + ROOM.md),
  **#15** (`--room` profile). Earlier: #12 (#4 `.git` :ro, #5 drop-gh, #6 netd
  reference), #13 (netd daemon), #1–#3/#8–#11 (OCAP surface, provenance, contract pin).
- Open trackers: issues **#4 / #5 / #6** (each carries a pickup brief).
- After pulling: `nix profile upgrade claude-box` to refresh the installed CLI
  (older installs predate `--scout` / `--room`).
