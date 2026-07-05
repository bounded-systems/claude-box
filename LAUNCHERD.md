# launcherd — the launch door (boxes spawn through a daemon, not raw podman)

Today `claude-box` shells out to `podman run` — the launcher is a CLI that holds
the runtime. That works for a human at a terminal, but it means a **box cannot
spawn another box** without holding podman itself (a privilege escalation) or
shelling out to the host (an escape). The self-hosting loop — Claude launching
Claude, each with its own capability grant — requires the launch to be a
**request**, not a command.

The fix is to make launch a **door**, the spawn twin of keeperd (git writes),
netd (egress), scoutd (reads), and repod (the repo): the box asks **launcherd**
to spawn a new box with a declared capability profile; launcherd owns the
runtime and enforces policy. The box never holds podman, never escapes to the
host, and the spawn is auditable.

## Why a daemon, not a CLI

| | **CLI (`claude-box`)** | **Door (`launcherd`)** |
|---|---|---|
| Caller | human at a terminal, or a script with host access | any holder of the launcherd socket — including a box |
| Runtime | the CLI shells out to `podman run` | launcherd owns the runtime; the caller only *asks* |
| Policy | implicit (the CLI user is trusted) | explicit — launcherd enforces what profiles/doors a caller may request |
| Audit | none (or shell history) | every spawn logged: `ts, caller, profile, doors[], ALLOW|DENY` |
| Self-hosting | impossible without privilege escalation | native — a box with the launcherd door can spawn sub-boxes |

The CLI remains for human use; launcherd is the policed service behind it. In
the consolidated pod (`prx-zj8`) the CLI becomes a thin client that talks to
launcherd rather than invoking podman directly.

## Why launch is the most dangerous door — and the invariant that tames it

podman is effectively root on the VM, so a naïve "launch" door is a
**privilege-escalation** door: a box with launch could spawn a box with
`--keeper` it was never granted, or a `--repo-rw` / `--net-open` escape, or a
mount of an arbitrary host path — laundering authority it doesn't hold through a
child. launcherd's defining invariant rules that out:

> **Attenuation — a child box's authority is a subset of the parent's.**
> launcherd never grants a door (or an escape, or a mount) the requesting box
> doesn't already hold. Launch can only *narrow*, never widen.

This is the OCAP delegation rule: you may pass on a capability you hold
(attenuated), but you cannot mint one you lack. With attenuation, launch is safe
to delegate — the worst a box can do is spawn a **weaker copy of itself**.
Without it, launch is a master key. Concretely launcherd enforces:

- **door attenuation** — child doors ⊆ parent doors; the parent's
  `$CLAUDE_BOX_CAPABILITIES` is the ceiling. No `--keeper` for a child unless the
  parent held keeper.
- **no escape minting** — `--repo-rw` / `--net-open` only if the parent held
  them; otherwise refused.
- **pinned images only** — launches from a content-addressed allowlist (same
  provenance posture as the box image), never an arbitrary image ref.
- **the cap floor on every child** — `--cap-drop all`,
  `--security-opt no-new-privileges`, `--pids-limit`, `--network=none` by default
  — copied to children, non-negotiable.
- **depth + resource limits** — a max nesting depth and per-caller caps, so
  launch can't fork-bomb boxes.
- **audit** — every launch logged `ts, caller, image, doors, ALLOW|DENY`.


## The grant

A door, same model as the others — `--launcher` (preset) forwards the launcherd
socket:

```
claude-box work --launcher --repo .
# → -v <launcherd.sock>:/run/launcherd.sock  --env LAUNCHERD_SOCK=/run/launcherd.sock
# The box asks launcherd to spawn; launcherd owns the runtime + enforces policy.
# No podman binary in the box, no escape to the host.
```

In the capability manifest it reads like the others: granted ⇒ "spawn sub-boxes
via launcherd (you hold no runtime)"; denied ⇒ "no spawn authority — do not
attempt to launch containers; relaunch with --launcher."

> **Note on `--room`.** `--room NAME` is an **in-process** door bundle expanded
> by `claude-box` itself (see [ROOM.md](./ROOM.md)) — it does *not* route through
> launcherd. The daemon keeps its own internal room presets for the profiles it
> can spawn; those are independent of the CLI `--room` flag.


## The wire protocol — reuse keeperd's framing

launcherd speaks the **same IPC framing as keeperd**: length-prefixed JSON
messages over the unix socket. One request, one response. The box holds the
socket fd (the capability); the daemon holds the runtime and policy.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  4-byte big-endian length ║ JSON payload (UTF-8)                             │
└──────────────────────────────────────────────────────────────────────────────┘
```

Reusing keeperd's framing means:
- One IPC primitive across all door daemons (keeperd, launcherd, scoutd, …).
- The in-box client code is the same shape everywhere.
- No new protocol to audit; the wire is already pinned.

### Request: `spawn`

```jsonc
{
  "op": "spawn",
  "profile": "work",           // named capability profile (see below)
  "repo": "/host/path",        // optional: the repo to mount
  "repoRw": false,             // optional: the unsafe .git-writable escape
  "doors": ["keeper", "net"],  // additional doors to grant (names only)
  "args": ["--resume"]         // passthrough args to claude
}
```

### Response

```jsonc
// success
{ "ok": true, "boxId": "abc123", "pid": 4567 }

// denied by policy
{ "ok": false, "error": "profile 'admin' not permitted for this caller" }
```

launcherd MAY stream status (`{"status": "pulling image"}`, `{"status":
"starting"}`) before the final response; the client reads until it gets `ok` or
`error`.

## Policy — capability profiles

A **profile** is a named bundle of doors + constraints. launcherd's policy file
declares which profiles exist and which callers may request them:

```yaml
profiles:
  work:
    doors: [keeper, net, scout]
    repo: rw: false            # .git read-only by default
  admin:
    doors: [keeper, net, scout, launcher]  # can spawn sub-boxes
    repo: rw: true

callers:
  # The human CLI (uid 1000 on the host) may request any profile.
  - uid: 1000
    allow: [work, admin]
  # A box with the launcherd door may only spawn 'work' sub-boxes.
  - socket: /run/launcherd.sock
    allow: [work]
```

Policy lives in a file launcherd reads at startup (not baked into the image),
so it's auditable and changeable without rebuilding.

## The self-hosting loop — one box

With launcherd, the bootstrap becomes:

1. Human launches a **root box** with `--launcher --keeper --net --repo .`
2. Root box asks launcherd to spawn a **worker box** with profile `work`.
3. Worker does the task; commits go through keeperd (it holds no keys).
4. Worker exits; root box (or launcherd) collects the result.

Each spawn is a **request** launcherd audits and enforces — and **attenuation**
makes the delegation edge sound: the worker's authority is provably ⊆ the root's.
The root box never holds podman; it holds only the launcherd *door*. And
launcherd can cap recursion, rate-limit spawns, or refuse profiles — all without
the box knowing or caring. This also closes the **provenance** loop: a launch is
the natural place to record "box X (manifest M) launched box Y (manifest N)" —
the delegation edge in the capability-provenance chain
([CAPABILITIES.md](./CAPABILITIES.md), [contract/CHAIN.md](./contract/CHAIN.md)).

## Status

**Implemented** (`launcherd.ts`). The daemon is fully functional:

- Socket server (NDJSON over unix socket or TCP for VM relay)
- Methods: `status`, `list`, `kill`, `attach`, `launch`, `rooms`
- Daemon-internal room presets: `dev`, `dev-spawn`, `readonly`, `offline`,
  `planning`, `bootstrap`
- Door prerequisite checking (fail-fast if keeperd/netd not reachable)
- L2 launch attestation (Ed25519 signing, `CapabilityProvenance/v0.1` statements)
- Key management (auto-generate at `~/.claude-box/launcherd.key`)
- `--launcher` door preset (spawn sub-boxes without holding podman)
- PTY attach support (named containers, `podman attach` command)
- Policy file support (JSON, controls which rooms callers may request)
- CLI thin-client in `claude-box.ts` (`status`, `ps`, `kill`, `attach`)

**Run it:**
```sh
launcherd serve                           # start daemon
launcherd serve --key /path/to/key        # custom signing key
launcherd serve --policy /path/to/policy  # load policy file
launcherd serve --no-sign                 # disable L2 attestation

claude-box status                         # daemon health + door/policy status
claude-box ps                             # list running boxes
claude-box attach <id>                    # get attach command for a box
claude-box kill <id>                      # terminate a box
claude-box work --launcher --repo .       # grant spawn authority to the box
```

**Policy file format** (`~/.claude-box/policy.json`):
```json
{
  "defaultAllow": ["dev", "readonly"],
  "rules": [
    { "uid": 1000, "allow": ["dev", "dev-spawn"] },
    { "socket": "/run/launcherd.sock", "allow": ["readonly"] }
  ]
}
```

**peercred — SO_PEERCRED helper (Rust)**

launcherd can't get peer credentials directly (Bun doesn't expose SO_PEERCRED).
The `peercred` binary is a tiny Rust proxy that sits in front of launcherd:

```sh
# peercred wraps the launcherd socket, injecting _caller info
peercred --frontend /run/launcherd.sock --backend /tmp/launcherd-backend.sock
```

When a client connects, peercred:
1. Gets the caller's UID/GID/PID via SO_PEERCRED
2. Injects `{"_caller":{"uid":1000,"gid":1000,"pid":12345},...}` into the request
3. Forwards to the real launcherd backend
4. Returns the response unchanged

This enables policy rules like `{"uid": 1000, "allow": ["dev", "dev-spawn"]}`.

**Not yet implemented:**
- Streaming status during launch

Pairs with CAPABILITIES.md (the door model), ROOM.md (the topology + why),
PRX-DAEMON-HANDOFF.md (the daemon work), and `contract/CHAIN.md`.
