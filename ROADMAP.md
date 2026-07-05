# claude-box — roadmap & handoff

Where the door / room / pod effort stands and what's next. Pairs with
[CAPABILITIES.md](./CAPABILITIES.md) (the model), [ROOM.md](./ROOM.md) (the
host/VM/room topology), the per-door specs (NETD / SCOUT / REPOD / LAUNCHERD),
[HANDOFF.md](./HANDOFF.md) (provenance L2/L3), and
[PRX-DAEMON-HANDOFF.md](./PRX-DAEMON-HANDOFF.md) (the bridge to the prx daemons).

## 2026-07-05 — Remote Control dispatch substrate (current focus)

The effort has moved from doors/rooms to a **Remote Control dispatch substrate**:
a persistent **dispatcher** ("dispatch" in the Claude app) you drive from your
phone, which dispatches independent, SELinux-confined worker sessions. The goal:
**claude-box as the substrate for the whole prx anchored chain** — a `GH-NNN`
ticket, driven from the app, planned and executed in credential-free boxes.

**Built & live** (merged): Rust **launcherd-rs** (VM-native static binary) serving
the dispatch lane; **SNI-passthrough egress** (no-MITM) that lets RC boxes
register (netd's CONNECT-only proxy can't carry RC's forward-proxy bridge POST);
a foreground **dispatcher** service that resumes one stable session; workers as
independent transient systemd units, confined, grants off-argv. `install.sh` +
a nix `launchd.agents.claude-box-machine` (ai-home) make it reproducible +
reboot-durable.

**Designed, not built** (the ticket→PR path — all door-mediated, nothing baked
into a box):
- `USER-STORY.md` — the primary spec (persona, 7 acceptance criteria, unknowns).
- `ADR-DISPATCH-PATH-NAMESPACES` (launcherd→Rust), `ADR-RC-EGRESS-SNI` (two-tier
  egress), `ADR-DISPATCH-REPO-ACCESS` (repo via the repod door — **never a
  bind-mount**), `ADR-DISPATCH-PLANNING-FROM-TICKET` (planning box → beads plan),
  `ADR-DISPATCH-APPROVAL-GATES` (Delegate→Review→Own: permission-mode + no
  auto-execute + PR-open-not-merge).
- Auth model confirmed solid: authd (RC cred) / ghappd (`GHAPPD.md`, GH token) /
  keeper (git writes) — borrow a scoped, self-expiring token, never hold the root.

**We are at the design→build boundary.** The remaining build (deploy
beadsd/repod/ghappd; add the `planning` room + per-room `permissionMode`; the
`/request-repo` command; grant caveats) is tracked in **beads** — no more ADRs.

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
| **repo** | `--repo` (worktree RW, `.git` **:ro**) / `--repo-ephemeral` (parallel-safe) / `--writable PATH` (narrow the RW surface, #41) / `--repo-clone` (isolated clone, full in-box git, no daemon, #42) / `--repo-origin URL` (clone-in-box, zero host mount, #43–#45) / `--repo-rw` (unsafe escape) |
| **egress** | `--net` (netd door) / `--net-open` (unsafe ambient escape) |
| **pod** | `--pod` (#48) — box + its netd door as sidecars in one off-host podman pod |
| **transport** | unix sockets (Linux) **and** TCP mode (`DOORS_TCP=1`, macOS) — daemons on host ports, box reaches `host.containers.internal:PORT` |
| **auth** | `CLAUDE_CODE_OAUTH_TOKEN` forwarded into the box (#49); `cbox` wrapper pulls it from 1Password (headless, stays on Max billing) |
| **netd** | daemon built (`nix run .#netd`), allowlist proxy, fail-closed (lives in prx) |
| **ops** | `claude-box doctor` (flag stale-image boxes, #38) + fail-fast door preflight (#40) |
| **red-team** | headless-Claude OCAP containment harness (`tests/redteam/`) — Claude fuzzes, a deterministic oracle judges (#39/#46/#50) |
| **provenance** | L1 image attestation + pinned contract; L2/L3 pending (HANDOFF.md) |
| **design docs** | **DOORS** / **POD** / NETD / SCOUT / REPOD / **LAUNCHERD** / ROOM / CAPABILITIES |

## The macOS gap — and the two answers that closed it

A door is a host unix socket; on macOS the box runs in a podman-machine VM
(applehv/Lima) and the host→VM **virtiofs** hop can't carry a socket (`statfs:
operation not supported`). That gap used to make policed doors unusable solo on
macOS — it now has **two working answers, both shipped this session:**

- **TCP mode (`DOORS_TCP=1`) — works today.** The daemons listen on host TCP ports
  and the box reaches them at `host.containers.internal:PORT`. This is what makes
  `cbox` (policed doors, solo, on macOS) work *right now* — no pod required. The
  socket→TCP swap is wired per-door; #53 fixed the last gap (in-box guidance that
  still named the absent `/run/doors/*.sock`). The fuller unification — one
  transport-agnostic `dispatch(guest, op, params)` client so a unix-only in-box
  client can dial TCP — is tracked as `prx-o92` (see [DOORS.md](./DOORS.md), "The
  TCP-mode door gap").
- **`--pod` (#48) — off-host, self-contained.** Runs the box plus its netd door as
  sidecars in one podman pod sharing a netns, so the door is a pod-local endpoint
  with no host port and no LAN exposure. netd lands first; keeper/scout sidecars
  are the next increment. See [POD.md](./POD.md).

The fuller `prx-zj8` pod (all daemons as pinned images alongside the box in the VM,
every door a direct local mount) remains the clean end-state. See ROOM.md.

## Remaining work — split by where it can be done

**In `bounded-systems/claude-box` (this repo):**
- Un-`todo` the `ocap.test.ts` cases (`--net`, `--scout`, `--repo`, `--repo-rw`,
  `--keeper`, `--beads`) and assert acceptance — **blocked on** a podman host
  running the daemons (ideally the pod).
- Wire the `--launcher` preset in `knownDoors()` — **blocked on** launcherd.
- Migrate `--repo` to the repod **read door + in-box overlay** (REPOD.md step 2),
  retiring the `:ro` ergonomics hit — **blocked on** repod. (Daemon-free isolation
  already ships: `--repo-clone` gives full in-box git, `--repo-origin` zero host
  mount; repod is the overlay *upgrade*, not a prerequisite for isolated work.)
- Later: extract the generic core as `bounded-systems/guest-rooms` (ROOM.md);
  `claude-box` becomes its first consumer. Concept now, extraction later.

**In `bounded-systems/prx` (different repo):**
- `repod` daemon (read projection + overlay).
- `launcherd` daemon (LAUNCHERD.md — attenuation is the core invariant).
- The uniform `dispatch(guest, op, params)` client — **`prx-o92`** / **`prx-435`**
  (one transport-agnostic facade; retires the per-door wiring behind the TCP gap).
- **The pod (`prx-zj8`)** — run all daemons + the box as pinned images in one
  podman pod.

**Completed — daemons & images (in `prx`):**
- **scoutd daemon** — external read door (repos/PRs/issues/URLs), implemented
- **netd-image** — allowlist egress proxy as OCI image
- **scoutd-image** — read daemon as OCI image
- **Quadlet units** — systemd service files for all doors

**On a host / macOS:**
- Build/refresh the image, run the pod, verify policed doors end-to-end, then
  un-`todo` the ocap tests on a real host. `scripts/bringup-macos.sh` is the
  checklist.

## Future directions (the actor model)

These fall straight out of treating every capability as a **dispatch to a guest
that holds it** ([DOORS.md](./DOORS.md)) rather than something baked in or fetched
ad-hoc. Not scheduled; recorded so they aren't lost.

- **Multi-repo / multi-subtree boxes.** Make `--repo` / `--repo-origin` (and
  `--writable`) **repeatable**: a box holds N repo-actors, each at its own mount
  (`/work/<name>`), each with its **own** scoped keeper + git-pull door (the
  per-origin scoping #45 already built, generalized to one per repo). A commit to
  repo A dispatches to A's door and *cannot* reach B — authority is per-repo, not
  ambient. `--repo-origin URL:subtree` (sparse checkout) gives subtrees-from-many-
  repos in one box. This is a small extension of the shipped write-model ladder
  (#42–#45), not a new paradigm — `--repo` becomes repeatable, mounts get names,
  the git-pull door is minted per origin.
- **Tooling as a door, not an egress hole.** A box needing a tool it must fetch
  (e.g. `tsc` pulling TypeScript from npm — which correctly 403s against the netd
  allowlist) should reach it through a **dedicated capability/actor** (a vendored
  toolchain in the image, or a scoped fetch door), never by widening egress. The
  allowlist 403 is the system working; the fix is a door, not a hole.
- **Doors in Go/Rust (not bun).** The doors are small, long-lived,
  security-sensitive network daemons holding keys/tokens — exactly where a single
  static binary with no runtime and a tighter memory story fits better than a bun
  process. Candidate once the actor-door interface (`prx-o92`) is settled, so all
  doors port to one shape. Not scheduled.

## North star — open a PR from inside the box

The end-to-end write chain, and where each rung stands (the goal that exercises the
whole door model):

| Rung | Capability | State |
|---|---|---|
| clone repo in-box | `--repo-origin` / `--repo-clone` | ✅ public; private needs scout `bundle` (SCOUT-POD increment 2) |
| edit | filesystem | ✅ |
| commit (signed) | keeperd `commit` (+ L3 attestation) | ✅ |
| push branch | keeperd `push` (holds the write cred) | ✅ |
| **open the PR** | `POST /repos/.../pulls` | ❌ **no capability** — scoutd only *reads* PRs; keeperd has no pr-create. A **write**, so it belongs on keeperd (a `pr` op). |
| box → keeper transport | in-box client dials the door | ❌ **`prx-o92`** (transport-agnostic client, in `prx`) — the linchpin |

So the loop is gated on two things: a keeperd **`pr` op** (buildable here) and
**`prx-o92`** (the in-box client, in `prx`). Until `prx-o92` lands, the full loop
can't be dogfooded from claude-box alone.

## Suggested order

1. **Finish the pod** — `--pod` (#48) runs the box + a netd sidecar off-host today;
   add keeper/scout sidecars so `--room dev` runs fully in-pod. (TCP mode already
   makes `--net`/`--scout`/`--keeper` reachable solo on macOS in the interim.)
2. **Un-`todo` the ocap tests** (`--net`, `--scout`, `--keeper`) once doors run.
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

2. **isolated clone / origin clone — DONE:** `--repo-clone` (#42) makes a throwaway
   `git clone --local --no-hardlinks` with its **own writable `.git`** (full in-box
   git; the real repo is never mounted, so it can't be corrupted). `--repo-origin`
   (#43–#45) clones from the origin URL into a tmpfs `/work` through a **separate**
   git-pull door scoped to only the origin host — zero host mount. Neither needs a
   repod daemon; reconcile commits back via the keeper door.

3. **repod overlay** (REPOD.md) — full `.git` isolation as a read-projection overlay
   over the live repo. A future ergonomics upgrade, not a blocker for isolated work.

## Dogfooding today

- **Develop** claude-box (edit + test) on the host: `nix run nixpkgs#bun -- test
  tests/` — no container needed.
- **Policed dogfood — works today** (no unsafe escapes, no pod required). With the
  doors running in TCP mode and the OAuth token forwarded (#49), `cbox` launches
  Claude on this repo through policed doors:

  ```
  cbox --repo . --net             # edit + test in-box; .git :ro, commit from host
  cbox --repo-clone . --room dev  # full in-box git, commit via the keeper door
  cbox --repo . --pod             # box + its own netd sidecar, off-host
  ```

  `cbox` is the home-manager wrapper: it reads the token from 1Password and sets
  `DOORS_TCP=1`. The old `--repo-rw . --net-open` bootstrap (unsafe escapes) is
  retired — policed doors reach the box on macOS now.
- **Caveat:** `cbox` runs the *host* `claude-box.ts`, so to test changes to
  `claude-box.ts` itself, run it from the repo source inside the box (`bun
  claude-box.ts …`), not via `cbox` (which is pinned to the host copy).

## State pointers

- `main` @ `7530776` (post-#53). This session added: ops — **#38** (`doctor`),
  **#40** (door preflight); repo write-model — **#41** (`--writable`), **#42**
  (`--repo-clone`), **#43–#45** (`--repo-origin` + a separate scoped git-pull door);
  the pod — **#48** (`--pod`); auth — **#49** (OAuth-token forwarding); red-team —
  **#39/#46/#50** (containment harness); design — **#47** (DOORS.md/POD.md), **#51**
  (actor-model vocabulary), **#52/#53** (the TCP-mode door-gap: repro + in-box-
  guidance honesty fix). Earlier: #14/#15 (`--scout`, `--room`), #12–#13, #1–#11
  (OCAP surface, provenance, contract pin).
- Open trackers: the uniform `dispatch(guest, op, params)` client — **`prx-o92`** /
  **`prx-435`** (in `prx`); keeper/scout pod sidecars; launcherd + repod daemons.
- After pulling: `cbox` runs the live source (no `nix profile upgrade` needed); the
  packaged `claude-box` CLI still lags `main` (nix eval cache).
