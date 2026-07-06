# pathbased — the Pathbase door (boxes never hold the Pathbase token)

> **Status: design (not yet built).** This doc records the design so the build
> can start cold. Pairs with [DOORS.md](DOORS.md) (the model),
> [KEEPERD.md](KEEPERD.md) (the sibling this borrows its shape from),
> [AUTHD.md](AUTHD.md) (the sibling this deliberately does NOT borrow its
> shape from, and why), and [CAPABILITIES.md](CAPABILITIES.md) (the
> `--pathbase` profile this hardens).

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
- **`--pathbase` no longer needs netd widened at all** — with pathbased
  wired in, the box has zero reason to reach pathbase.dev itself. The
  netd-gated design (already merged) becomes the fallback for operators who
  haven't stood up pathbased yet, not the primary path.

## Wire protocol — NDJSON over unix socket (keeperd's framing, verbatim)

### `status` — health check
```json
{"id":"1","method":"status"}
→ {"id":"1","ok":true,"result":{"version":"0.1.0","loggedIn":true,"user":"alex"}}
```

### `whoami` — who pathbased is authenticated as (never the token itself)
```json
{"id":"2","method":"whoami"}
→ {"id":"2","ok":true,"result":{"url":"https://pathbase.dev","user":"alex"}}
→ {"id":"2","ok":false,"error":"not logged in — run `path auth login` on the host"}
```

### `export` — push a toolpath document to Pathbase
```json
{
  "id": "3",
  "method": "export",
  "params": { "document": { "graph": {...}, "paths": [...] } }
}
→ {"id":"3","ok":true,"result":{"url":"https://pathbase.dev/alex/repo/path-pr-42"}}
```

### `import` — pull a toolpath document from Pathbase
```json
{"id":"4","method":"import","params":{"ref":"alex/repo/path-pr-42"}}
→ {"id":"4","ok":true,"result":{"document":{"graph":{...},"paths":[...]}}}
```

No `login`/`logout` method: session lifecycle is the operator's, managed
directly on the host with `path auth login`/`logout` — pathbased only ever
*reads* the resulting session, never mutates it on the box's behalf. A box
cannot log pathbased out or into a different account.

## The grant

```
claude-box work --pathbase --repo .
# → -v <pathbased.sock>:/run/doors/pathbased.sock  --env PATHBASED_SOCK=...
# No netd widening needed: the box never reaches pathbase.dev itself.
# The box asks pathbased to export/import; pathbased execs the host's own,
# already-logged-in `path` binary and relays the result.
```

`knownDoors` entry (mirrors `keeper`'s shape in `claude-box.ts`):

```ts
pathbase: {
  flag: "--pathbase",
  inBox: "/run/doors/pathbased.sock",
  env: "PATHBASED_SOCK",
  hostDefault: env.PATHBASED_SOCK ?? defaultHostSock("pathbased", env),
  grants: "toolpath provenance export/import via pathbased (you hold no Pathbase token)",
  use: "Route `path p export pathbase` / `path p import pathbase` through pathbased at /run/doors/pathbased.sock ($PATHBASED_SOCK). You hold NO Pathbase session — request the effect and pathbased performs it host-side. Local git/agent-log provenance (`path p import git`, `render md|dot`) needs no door at all.",
  deny: "No Pathbase access in this box. `path auth login`/`export`/`import` will fail — there is no session to use and no egress to reach pathbase.dev. Local provenance (`path p import git`) still works unconditionally; relaunch with --pathbase if Pathbase push/pull is needed.",
},
```

Port allocation (`TCP_PORTS` in `claude-box.ts`, next free slot after
`beadsd: 3004`): `pathbased: 3005`.

## Migration from the merged `--pathbase` netd-gated design

`pathbaseEgressAllow`/`PATHBASE_NETD_ALLOW`/the scoped-netd wiring in
`claude-box.ts` stay as-is — they remain the correct fallback for an operator
who wants `--pathbase` without standing up the pathbased daemon (same
relationship `claude-box login --scope full` has to authd: the CLI surface
doesn't change, the custody does, and the simpler path keeps working
alongside the hardened one). Once pathbased exists, `--pathbase` prefers
mounting the pathbased door; only falls back to the scoped-netd egress grant
if `PATHBASED_SOCK`/the door isn't available — mirroring `--remote-control`'s
eventual authd cutover (AUTHD.md's Phase 2/3), not a hard breaking change.

## Open questions — resolve before/while building

1. **Does pathbased need its own egress allowlist?** pathbased itself (the
   *daemon*, host-side) still needs to reach `pathbase.dev` — that's fine and
   expected (it's the credential owner, same as keeperd reaching GitHub for a
   push). This is a *different* netd posture question than the box's — worth
   being explicit that "the box needs no egress" and "pathbased needs egress"
   are two separate claims, so neither gets silently conflated with the other
   (cf. NETD.md's "instances carry the reason" — this would be a third named
   reason: pathbased's own, egress-for-a-daemon posture, not a box's).
2. **Multi-account.** `~/.toolpath` on the host is a single session (one
   Pathbase account). If an operator uses multiple claude-box accounts
   (`claude-box ls`), does pathbased serve them all from one login, or does
   it need per-account session files? Punt until it's a real need (YAGNI) —
   flag it rather than guess.
3. **Document size / transport.** `export`'s `params.document` embeds the
   full toolpath JSON inline over the socket. Fine for a session/PR-sized
   document; revisit (e.g. a temp-file handoff) only if real documents prove
   too large for a single NDJSON line.
4. **Concurrent export races.** Two boxes exporting concurrently through one
   pathbased is just two sequential subprocess execs (no shared mutable state
   pathbased itself owns beyond the host's `~/.toolpath` file, which `path`
   already manages safely) — likely a non-issue, but worth a quick check once
   built rather than assumed.

## Build sketch (keeperd-sibling, lighter than authd)

- `pathbased serve` (Unix socket / TCP-mode port `3005`), registered in
  `knownDoors` so `--pathbase` mounts it.
- Three ops: `status`, `whoami`, `export`, `import` — each execs the host
  `path` binary with a fixed, narrow argv (no shell interpolation of
  box-supplied strings beyond a `--ref`/document blob passed via stdin), reads
  its stdout, and returns it as the NDJSON result.
- `--pathbase` sources the door from `pathbased` when available; falls back
  to the existing scoped-netd `pathbaseEgressAllow` grant otherwise (see
  "Migration" above) — never both at once for one launch.
- No new credential format, no refresh logic, no op/1Password integration —
  the entire auth lifecycle stays exactly what an operator already does by
  running `path auth login` on their own machine.

## Status

**Design only.** Nothing in this doc is built. The `--pathbase` netd-gated
profile (CAPABILITIES.md, merged) is the shipping interim state; this is the
hardening move, exactly as AUTHD.md is to `--remote-control`'s box-local
login.
