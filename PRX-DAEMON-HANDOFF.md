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

## Task 1 — netd (#6)  ·  spec: `NETD.md` + `netd/squid.conf`

An HTTP forward-proxy on a unix socket (`/run/netd.sock`):
- **allowlist-by-destination**, **no TLS MITM** (CONNECT-tunnel to allowlisted
  hosts; do not decrypt), **fail-closed**, **audit log** of every allow/deny.
- **Default allowlist = fetch hosts only:** `api.anthropic.com`, `.anthropic.com`;
  a `js`/clone profile may add `codeload.github.com`,
  `objects.githubusercontent.com`, `registry.npmjs.org` — **never**
  `api.github.com` / gists / pastebins by default (issue #6: no writable sinks).
- Reference impl in the repo: Squid allowlist-only + `socat
  UNIX-LISTEN:/run/netd.sock,fork → TCP:127.0.0.1:<squid>`.
- **Acceptance:** with a box's `--net` door pointed at netd, `api.anthropic.com`
  is reachable; `curl https://evil.com` is refused; no other route off the box.

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

netd (#6, smallest + plumbing already wired) → un-todo `--net` tests → scoutd
(#5) → repod (#4-proper) → the pod (`prx-zj8`). Then revisit the provenance
chain (L2 binds `$CLAUDE_BOX_CAPABILITIES`) in `ocap-provenance` once the doors
are real — see `/tmp/cb/contract/CHAIN.md`.

## State pointers

- claude-box `main` @ `99c0d68`. Merged: #1 (OCAP surface), #2 (provenance
  contract + L1), #3 (egress door + hardening), #8/#11 (contract pin), #12 (#4
  `.git` :ro + #5 drop-gh + #6 netd reference), #9/#10 (handoff + bring-up).
- Open trackers: issues **#4 / #5 / #6** (each carries a pickup brief comment).
- `scripts/bringup-macos.sh` stands a box up on a Mac (image → machine →
  keeperd → run → check).
