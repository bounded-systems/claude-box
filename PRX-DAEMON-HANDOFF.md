# Handoff — prx door daemons (netd / scoutd / repod / pod)

For the agent running **inside claude-box** (or any session scoped to
`bounded-systems/prx`). The claude-box side of the OCAP/egress hardening is
**done and merged** (`main` @ `99c0d68`); what remains is implementing the
**door daemons** whose specs live in claude-box. This brief is the bridge.

## Where you are / environment

- You're in a **bootstrap box**: `/work` = the `prx` repo, egress via
  `--net-open` (full ambient egress — fine for trusted bootstrap), `.git`
  writable via `--repo-rw`.
- **Caution:** `--repo-rw` reopens the #4 host-RCE (a planted `.git/hooks`
  runs on the host). Don't paste untrusted prompts here; once keeperd serves,
  relaunch with `--repo --keeper`.
- You have network, so **pull the authoritative specs** rather than trusting
  this summary:
  ```
  git clone https://github.com/bounded-systems/claude-box /tmp/cb
  ```
  Specs: `/tmp/cb/NETD.md`, `/tmp/cb/netd/squid.conf`, `/tmp/cb/SCOUT.md`,
  `/tmp/cb/REPOD.md`. Capability model: `/tmp/cb/CAPABILITIES.md`.

## The model (already shipped in claude-box — don't rebuild it)

A **door** is a `(name, socket)` pair: the launcher mounts a host unix socket at
`/run/<name>.sock` in the box and exports `<NAME>_SOCK`. The box holds **no
keys** — only doors. Presets (`--keeper`, `--beads`, `--net`, generic `--door`)
all come from one registry in `claude-box.ts` (`knownDoors()`), so mounts, env,
manifest, help, and docs can't drift. **keeperd already exists in prx** (`prx
keeperd` / `keeper serve`) — it's the template for the daemons below.

The `--net` door already has its **launch effects wired** in claude-box:
`--network=none` + `HTTPS_PROXY=http://127.0.0.1:3128`, and the image entrypoint
relays `127.0.0.1:3128 → /run/netd.sock` via socat (`flake.nix`). So netd only
has to **serve an HTTP proxy on the unix socket** — the box plumbing is done.

## Task 1 — netd (#6)  ·  ✅ DONE (daemon) — `netd/netd.ts`, `nix run .#netd`

Implemented as a **pinned bun process**: allowlist-by-destination via `CONNECT`,
**no TLS MITM**, **fail-closed**, **audit log**. Default allowlist
`api.anthropic.com,.anthropic.com` (override with `NETD_ALLOW`). **Verified
host-side** — allow → tunnels to a real `404`, deny (`example.com`) → refused.
It replaces the squid+socat reference (`netd/squid.conf` + `run-netd.sh`), which
kept dying on macOS (squid container exits, fragile published-port hop).

**Remaining (pod-side):**
- Package `netd.ts` as a **pinned OCI image** in the pod (`prx-zj8`) — it runs
  from source today; the pod wants a content-addressed image like the box.
- **The `--net` door itself only works once netd + the box share the pod.** On
  macOS a host unix socket can't be bind-mounted into the box's VM (`statfs:
  operation not supported`), so `--net` is unusable solo — `--net-open` is the
  interim. The pod makes `/run/netd.sock` a shared local mount; that's the door's
  real fix, and the concrete reason the pod isn't optional.
- Un-`todo` the two `--net` cases in `tests/ocap.test.ts` once the pod runs netd.
- Optional: add the `js`/clone allowlist profiles (fetch hosts only: never
  `api.github.com`/gists/pastebins — #6).

## Task 2 — scoutd (#5)  ·  spec: `SCOUT.md`

The **read door** — #5 removed `gh` from the image and split its powers
(writes→keeperd, egress→netd, **reads→scout**). scoutd performs read-only
GitHub/web reads on the box's behalf so the box holds **no token**.
- Read `SCOUT.md` for the exact surface (what reads are permitted).
- **Acceptance:** the box can do its sanctioned reads via the `--scout` door
  while holding no credential; nothing write-capable is exposed.

## Task 3 — repod (#4-proper)  ·  spec: `REPOD.md`

The proper fix for #4 (today `--repo` just mounts `.git` `:ro`, which degrades
in-box git). repod = **read-projection of the repo + an in-box writable
overlay** so the tree feels writable while the host `.git` stays protected;
history writes route through keeperd.
- Read `REPOD.md` for the overlay/projection design.
- **Acceptance:** in-box edits feel normal; the host `.git` is never mutated by
  the box; commits land via keeperd; multiple consumers share one read door.

## Task 4 — the pod (`prx-zj8`)

Run keeperd / netd / scoutd / repod as **pinned OCI images in a podman pod** and
launch claude-box **into that pod**, so every door is a **direct local mount**
(no host→VM virtiofs socket hop — retires the flaky macOS transport). claude-box
was the template for a pinned-image workcell; these are its siblings.

## The claude-box follow-ups each daemon needs (file as separate PRs)

For every new daemon, a small change back in `bounded-systems/claude-box`:
1. **Wire its preset** in `knownDoors()` in `claude-box.ts` (e.g. a `--scout`
   flag with `inBox: /run/scoutd.sock`, `env: SCOUTD_SOCK`, grant/deny text).
   Check whether `--scout` is already present before adding.
2. **Un-`todo` its ocap test** in `tests/ocap.test.ts` (the `--net`, `--scout`,
   `--repo`, `--keeper` cases are `test.todo` until the daemon + image exist),
   and assert the acceptance criteria above on a real host.
3. Keep `CAPABILITIES.md` / the relevant spec doc in sync (one registry → docs
   fall out of it).

## Suggested order

netd is **done** (the daemon). Next: **the pod (`prx-zj8`)** — it's the highest
leverage, because it's what makes the `--net` door actually work (co-locate netd
+ box) *and* the template for scoutd/repod. So: pod (package netd as a pinned
image, run box + netd in it) → un-todo `--net` tests → scoutd (#5) → repod
(#4-proper). Then revisit the provenance chain (L2 binds
`$CLAUDE_BOX_CAPABILITIES`) in `ocap-provenance` once the doors are real — see
`/tmp/cb/contract/CHAIN.md`.

## State pointers

- claude-box `main` @ `99c0d68`. Merged: #1 (OCAP surface), #2 (provenance
  contract + L1), #3 (egress door + hardening), #8/#11 (contract pin), #12 (#4
  `.git` :ro + #5 drop-gh + #6 netd reference), #9/#10 (handoff + bring-up).
- Open trackers: issues **#4 / #5 / #6** (each carries a pickup brief comment).
- `scripts/bringup-macos.sh` stands a box up on a Mac (image → machine →
  keeperd → run → check).
