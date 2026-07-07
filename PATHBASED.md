# pathbased — the Pathbase door (boxes never hold the Pathbase token)

> **Status: implemented.** `pathbased.ts` + `--pathbase`'s door mount are
> built and tested (see "Status" at the bottom). Pairs with
> [DOORS.md](DOORS.md) (the model), [KEEPERD.md](KEEPERD.md) (the sibling
> this borrows its shape from), [AUTHD.md](AUTHD.md) (the sibling this
> deliberately does NOT borrow its shape from, and why), and
> [CAPABILITIES.md](CAPABILITIES.md) (the `--pathbase` profile this hardens).

pathbased is the Pathbase counterpart to keeperd. A box with the `--pathbase`
profile can request toolpath provenance push/pull through pathbased, which
holds the Pathbase session. The box never holds a Pathbase token — it only
asks.

## The problem the merged `--pathbase` profile leaves open

`--pathbase` (merged, see CAPABILITIES.md) gates Pathbase egress behind an
explicit, netd-scoped grant instead of a default-on allowlist entry — that
part is sound and stays. But within that grant, the box still talks to
`pathbase.dev` **directly**: `path auth login` persists a real Pathbase
session token wherever `$HOME/.toolpath` lives inside the box (its config/home
volume), and the box's own egress reaches pathbase.dev to use it. That makes
the box a second home-of-record for a credential, and a second, if narrow,
egress surface to a host that can receive writes (GH-6: pathbase.dev is
write-capable, same reasoning that keeps it out of every *default* profile).
pathbased removes both: the box gets neither the token nor the network path.

## Why the keeperd pattern (broker performs the effect) DOES fit here

AUTHD.md rules out keeperd's pattern for Remote Control because RC is not a
discrete effect — it *is* the session, so there is nothing to broker; the box
must be the endpoint holding some credential. Pathbase is the opposite shape:
every toolpath↔Pathbase interaction is a **discrete, one-shot effect** —
`login`, `whoami`, `export` (push a document), `import` (pull a document) —
exactly like a git commit or push. There is no continuous session the box
must itself drive. So unlike RC, **zero-knowledge brokering is fully
achievable**: pathbased performs the effect, the box never sees any token, not
even a short-lived one (authd's ceiling for RC). This is a strictly tighter
result than `--pathbase`'s current netd-gated design.

## The design: a thin exec-broker over the operator's own `path` CLI

Unlike authd — which had to reimplement Anthropic's OAuth refresh flow
byte-for-byte because Claude Code's credential format demanded it — pathbased
does not need to reimplement toolpath's auth lifecycle at all. `path auth
login`/`whoami`/`export`/`import` already fully own their session's storage
and refresh (wherever `$HOME/.toolpath` resolves on the **host**, populated by
the operator running `path auth login` once, outside any box, the same "log
in on the host, never in the box" shape as `claude-box login`/authd's op-owned
refresh token). pathbased is therefore just a narrow NDJSON-over-unix-socket
wrapper that execs the host's own already-authenticated `path` binary for
exactly three subcommands and relays stdin/stdout — no OAuth code, no token
parsing, no credential-shape coupling to toolpath's internals.

```
            ┌─ operator's host ~/.toolpath ──┐   the home-of-record
            │  (from a one-time, out-of-box  │   (Pathbase session token
            │   `path auth login`)           │    lives here, never in a box)
            └───────────────┬────────────────┘
                             │ pathbased execs the host `path` binary
                       ┌─────▼─────┐
                       │ pathbased │  NDJSON / unix socket (keeperd's framing)
                       │  (host)   │
                       └─────┬─────┘
                             │ /run/doors/pathbased.sock ($PATHBASED_SOCK)
                       ┌─────▼─────┐
                       │  the box  │  --pathbase mounts the door; NO net egress
                       └───────────┘  to pathbase.dev needed at all
```

- **pathbased owns the Pathbase session on the host** — nothing new to seed;
  it reads the same `~/.toolpath` an operator already has from using `path`
  themselves.
- It execs `path auth whoami` / `path p export pathbase` / `path p import
  pathbase` as host subprocesses on the box's behalf, piping the document
  JSON in/out over the socket.
- `--pathbase` mounts the pathbased door AND keeps its netd-gated fallback
  (see "Migration" below for why this stayed a mount-both, not a
  probe-and-prefer) — but with pathbased actually running, the box has no
  practical reason to use its own direct egress; export/import go through
  the door instead.

## Wire protocol — NDJSON over unix socket (keeperd's framing, verbatim)

### `status` — health check
```json
{"id":"1","method":"status"}
→ {"id":"1","ok":true,"result":{"version":"0.1.0","uptime":42,"loggedIn":true}}
```

### `whoami` — who pathbased is authenticated as (never the token itself)
```json
{"id":"2","method":"whoami"}
→ {"id":"2","ok":true,"result":{"raw":"alex (u-123)\nserver: https://pathbase.dev","user":"alex","id":"u-123","server":"https://pathbase.dev"}}
→ {"id":"2","ok":false,"error":{"code":"NOT_LOGGED_IN","message":"Error: Not logged in. Run `path auth login`."}}
```
`user`/`id`/`email`/`server` are parsed best-effort from `path auth whoami`'s
plain-text CLI output (not a stable wire contract upstream) — `raw` always
carries the untouched text, so a format drift degrades gracefully rather than
silently returning a wrong field.

### `export` — push a toolpath document to Pathbase
```json
{
  "id": "3",
  "method": "export",
  "params": { "document": { "graph": {...}, "paths": [...] }, "repo": "alex/pathstash", "name": "pr-42", "public": false }
}
→ {"id":"3","ok":true,"result":{"url":"https://pathbase.dev/u/alex/pathstash/graphs/..."}}
```
`document` is staged to a throwaway temp file and passed as `export
pathbase --input <file>` (that flag accepts a cache id OR a file path —
cmd_export.rs); `repo`/`name`/`public`/`url` forward to the matching `path`
flags when present. **Not logged in on the host is not an error** — toolpath
itself falls through to Pathbase's public anonymous-upload endpoint (verified
live: an anonymous, unlisted graph uploaded successfully with no session
present).

### `import` — pull a toolpath document from Pathbase
```json
{"id":"4","method":"import","params":{"ref":"alex/repo/path-pr-42"}}
→ {"id":"4","ok":true,"result":{"document":{"graph":{...},"paths":[...]}}}
```
Runs `path p import pathbase <ref> --no-cache`, which prints the document
JSON straight to stdout instead of only writing the cache.

No `login`/`logout` method: session lifecycle is the operator's, managed
directly on the host with `path auth login`/`logout` — pathbased only ever
*reads* the resulting session, never mutates it on the box's behalf. A box
cannot log pathbased out or into a different account.

## The grant

```
claude-box work --pathbase --repo .
# → -v <pathbased.sock>:/run/doors/pathbased.sock  --env PATHBASED_SOCK=...
# → ALSO mounts the net door + a scoped netd allowlisting pathbase.dev
#   (the pre-existing fallback — see "Migration" below for why both mount).
# The box asks pathbased to export/import; pathbased execs the host's own,
# already-logged-in `path` binary and relays the result.
```

`knownDoors` entry (`claude-box.ts`, matches `keeper`'s shape):

```ts
pathbase: {
  flag: "--pathbase",
  inBox: "/run/doors/pathbased.sock",
  env: "PATHBASED_SOCK",
  hostDefault: env.PATHBASED_SOCK ?? defaultHostSock("pathbased", env),
  grants: "toolpath provenance export/import via pathbased (you hold no Pathbase token)",
  use: "Route `path p export pathbase` / `path p import pathbase` through pathbased at /run/doors/pathbased.sock ($PATHBASED_SOCK) — send {method:'whoami'|'export'|'import', params:...}. You hold NO Pathbase session; request the effect and pathbased performs it host-side. Local git/agent-log provenance (`path p import git`, `render md|dot`) needs no door at all and always works.",
  deny: "No Pathbase door in this box. `path auth login`/`export`/`import` will fail — there is no session to use here. Local provenance (`path p import git`) still works unconditionally; relaunch with --pathbase if Pathbase push/pull is needed.",
},
```

Port allocation (`TCP_PORTS` in `claude-box.ts`, next free slot after
`authd: 3003`): `pathbased: 3004` (there was no `beadsd` TCP port to follow —
beads doesn't run a TCP relay).

## Migration from the merged `--pathbase` netd-gated design

`pathbaseEgressAllow`/`PATHBASE_NETD_ALLOW`/the scoped-netd wiring in
`claude-box.ts` stay exactly as merged — `--pathbase` now mounts **both** the
pathbased door and the scoped-netd fallback, unconditionally, every launch.
This is a deliberate simplification from the original "prefer the door, fall
back to netd" idea: `planLaunch` is a synchronous, pure function (every
existing profile — including `--remote-control` implying the `auth` door
whether or not authd is actually running — mounts unconditionally, with no
liveness probe at plan time), and introducing an async socket-liveness check
there would be a much larger, more invasive refactor than this door's actual
value justifies. Mounting both costs nothing when pathbased isn't running
(the socket mount is just inert), and an operator who wants the netd path
gone entirely can drop `--pathbase`'s netd half by hand (`--door pathbase`
alone, without `--net`) — full auto-preference is a follow-up, not required
for this door to be useful today.

## Open questions — resolutions

1. **Does pathbased need its own egress allowlist?** Resolved: yes, and it's
   ordinary/unmediated, not netd-gated. `pathbased-image` in `flake.nix` runs
   with normal container networking (no `--network=none`) — it's the
   credential-holding broker itself, the same posture keeperd has reaching
   GitHub with a real SSH key. This is a *different* claim than "the box
   needs no egress" (still true) — the two are deliberately not conflated.
2. **Multi-account.** Still open, punted (YAGNI) — `~/.toolpath` on the
   pathbased host/container is a single session. Not needed until a real
   multi-account-with-Pathbase workflow shows up.
3. **Document size / transport.** Resolved differently than sketched:
   `export`'s `document` param IS staged to a throwaway temp file inside
   pathbased (not embedded inline in the `path` invocation) before exec —
   `export pathbase --input` accepts a file path, so this was the natural
   shape once the real CLI flag was checked (cmd_export.rs), not an
   NDJSON-line-length workaround.
4. **Concurrent export races.** Not hit in testing; still just sequential
   subprocess execs, each with its own throwaway temp dir (cleaned up in a
   `finally`) — no shared mutable state to race on beyond `path`'s own
   `~/.toolpath`, which it already manages safely.

## Build sketch → what's actually built

- `pathbased.ts`: `serve` (unix socket / TCP-mode port `3004`), registered in
  `knownDoors`. Four ops: `status`, `whoami`, `export`, `import` — each execs
  the `path` binary (`PATHBASED_BIN` override, else resolved from PATH) with
  a fixed argv (never a shell string), relays stdout/exit code. Same
  transit-grant gate as keeperd/scoutd for tcp/vsock reachability.
  `tests/pathbased.test.ts` covers all four handlers + the NDJSON envelope
  against a fake `path` script (no real Pathbase session/network needed).
- `pathbased-image` in `flake.nix`: a `dockerTools.buildLayeredImage`
  reusing the SAME pinned `toolpath` derivation the box ships (one pin, two
  consumers) — `nix build .#pathbased-image && podman load -i result`.
  Live-verified: a container with an empty `~/.toolpath` correctly reports
  `loggedIn: false`/`NOT_LOGGED_IN`, and `export`/`import` round-tripped a
  real (anonymous, unlisted) document against the actual pathbase.dev
  service end-to-end through the daemon.
- `--pathbase` mounts BOTH the pathbase door and its netd-gated fallback,
  unconditionally (see "Migration" above for why this stayed simpler than
  the original "prefer door, fall back to netd" sketch). `--door pathbase`
  alone (bypassing the `--pathbase` sugar flag) already gets the
  zero-egress ideal today — mounts the broker, implies no net door, and
  `pathbaseEgressAllow` stays `[]` (`tests/pathbase.test.ts`).
- Contract parity: `pathbase` added to `contract/capabilities.contract.json`
  (`mountable: true, bootRequired: false`, matching `beads`'s shape) and to
  the Rust `DOORS` table in `launcherd-rs/src/doors.rs` — both parity tests
  (TS `tests/contract.test.ts`, Rust `doors_match_the_capability_contract`)
  pass.
- No new credential format, no refresh logic, no op/1Password integration —
  the entire auth lifecycle stays exactly what an operator already does by
  running `path auth login` on their own machine (or inside the
  `pathbased-image` container, against its own `/app/.toolpath` volume).

## Status

**Implemented.** `pathbased.ts` (daemon + tests), the `pathbase` door
(`knownDoors`, contract + Rust parity), and `pathbased-image` (nix package,
build- and live-verified against the real pathbase.dev) are all built. Not
yet done: NixOS quadlet/module wiring to run pathbased long-lived alongside
the other doors (KEEPERD.md's "Mode 2: VM-native container" is the template
this would follow) — today it's `podman run` by hand, same as keeperd's
"Mode 1" before its own quadlet unit landed.
