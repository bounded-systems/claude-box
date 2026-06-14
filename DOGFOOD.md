# DOGFOOD.md — running claude-box on real work, locally

How to actually *use* claude-box day-to-day on this Mac, what works today, and
what's still being built toward the north star (**open a PR from inside the box**).
Honest about the edges — see [ROADMAP.md](./ROADMAP.md) for the full state and
[DOORS.md](./DOORS.md) / [CAPABILITIES.md](./CAPABILITIES.md) for the model.

## TL;DR

```sh
cbox --repo . --net          # Claude on THIS repo: edit + test in-box, policed egress
```

Edit freely; `/work` is your worktree (writable), `.git` is read-only. Exit, then
commit from the host. That loop works **today**, solo, on macOS.

## Prerequisites

- **rootless podman** + the image loaded: `localhost/claude-personal:dev`.
- **`cbox`** on PATH — the home-manager wrapper that reads the OAuth token from
  1Password (`op`) and sets `DOORS_TCP=1`, then runs the live `claude-box.ts`
  source. (So `cbox` is always current; the packaged CLI can lag `main`.)
  - `op` must be unlocked (`op read` will block on an unlock prompt otherwise).
- **the doors running** (for `--net` / `--scout` / `--keeper` in TCP mode):
  `claude-box doors serve` brings up keeperd (3001), scoutd (3002), netd (3128) on
  `127.0.0.1`. Check: `nc -z 127.0.0.1 3128`. (`--pod` is self-contained and needs
  no host doors — see below.)

## What works today

| Command | What you get |
|---|---|
| `cbox --repo . --net` | edit + `bun test` in-box on the live worktree; `.git` `:ro`; commit from host |
| `cbox --repo-clone . --room dev` | a throwaway clone with **full in-box git** (commit/branch freely) |
| `cbox --repo . --pod` | box + its **own netd sidecar** in a pod — egress off-host, nothing on the host |
| `cbox --guest bun --repo-origin <PUBLIC-url> --pod` | **credential-free public clone-in-box**, then run the guest |
| `cbox --writable src --repo .` | narrow the writable surface to a subtree |

In-box, run tools directly (`bun test`, `git status`) — **not** `nix run` (that's a
host-side convention; the box image has the runtimes).

## What does NOT work yet (and why)

- **Private `--repo-origin` clone-in-box** — fails *fast* with a clear message (no
  credential in the box, by design). Needs the scout `bundle` op (SCOUT-POD.md
  increment 2). Until then, use `--repo .` / `--repo-clone .` for private repos.
- **Commit/push *from inside* the box (keeper)** — the box can't yet *dial* the
  keeper door end-to-end. The transport-agnostic client just landed in `prx`
  (`prx-o92`); wiring the keeper client + a `KEEPERD_SOCK` consumer are the next
  slices. For now: edit in-box, **commit from the host**.
- **Open a PR from inside** — no `open-PR` capability exists yet (it's a *write*,
  so it belongs on keeperd as a `pr` op). This is the north star; see the loop map
  in [ROADMAP.md](./ROADMAP.md).

## Picking a repo to dogfood — `prx repos`

`prx` already indexes every repo on this machine — use it instead of guessing
paths:

```sh
prx repos                    # bare root + worktrees + remotes for every local repo
```

Then point a box at one:

```sh
cbox --repo ~/path/to/repo --net                       # a local worktree
cbox --repo-origin https://github.com/owner/repo --pod # a PUBLIC repo, clone-in-box
```

This is the **prx ↔ claude-box** seam: `prx repos` is discovery (which repos
exist, their remotes), `cbox` is the sealed runtime. The future direction is
multi-repo boxes (several `--repo` mounts at once, each its own scoped door — see
ROADMAP "Future directions") fed directly from the `prx repos` index.

## Verify it end-to-end (the smoke tests)

```sh
# pod egress + credential-free public clone-in-box (no host TCP, nothing host-exposed):
cbox --guest bun --repo-origin https://github.com/octocat/Hello-World --pod \
  -- -e 'console.log("clone ok:", require("fs").existsSync("/work/README"))'

# a private origin FAILS FAST (expected — no creds in the box, no scout yet):
cbox --guest bun --repo-origin https://github.com/bounded-systems/claude-box --pod -- -e 1
#   → "clone failed — --repo-origin clones with NO credentials … use the scout read-door"
```

The OCAP containment harness is a deeper check (Claude as adversary, deterministic
oracle): `tests/redteam/` (`bun tests/redteam/run.ts`).

## Troubleshooting

- **`command not found: cbox`** — the home-manager switch hasn't applied; the
  stopgap is `~/.local/bin/cbox`. Ensure `~/.local/bin` is on PATH.
- **Hang on `Username for 'https://github.com':`** — fixed (a private clone now
  fails fast). If you see it, you're on an old build; `cbox` runs live source so
  just re-run.
- **"net works but scout/keeper don't" in TCP mode** — the in-box guidance is
  honest now (claude-box #53) and the transport-agnostic dial landed in `prx`
  (`prx-o92`); full keeper/scout-from-box still needs the client-wiring slices.
- **A box launched while the doors are down** fails fast at preflight with a hint —
  run `claude-box doors serve` (or use `--pod`).

## Reference

- [ROADMAP.md](./ROADMAP.md) — full state + the PR-from-inside north-star map
- [DOORS.md](./DOORS.md) — the door / actor model
- [POD.md](./POD.md) — pod-per-box ("a VPC per workload")
- [SCOUT-POD.md](./SCOUT-POD.md) — credential-free private reads (the build queue)
- [CAPABILITIES.md](./CAPABILITIES.md) — the transport tiers + ocap contract
