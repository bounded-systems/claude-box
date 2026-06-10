# netd — the egress door

`netd` is the daemon behind claude-box's **`--net`** grant: the box's *only* way
onto the network. It is the egress twin of **keeperd** (git writes) and
**beadsd** (beads) — a **door, not a credential or a NIC in the box**. The box
runs `--network=none` and holds no egress capability of its own; it can only
*ask* netd, which **owns the allowlist** and decides what's reachable.

This file is the **contract** netd implements. The daemon itself is external
(like keeperd/beadsd); claude-box only forwards its socket and points in-box
clients at it.

## The shape

```
  in-box client ──HTTPS_PROXY──▶ 127.0.0.1:3128 ──socat──▶ /run/netd.sock ══▶ netd ──▶ allowlisted host
  (claude, git, curl)              (entrypoint relay)        (the door)       (policy)     (api.anthropic.com)
```

- The box mounts the door at **`/run/netd.sock`** (launcher: `-v <sock>:/run/netd.sock`).
- The image entrypoint runs `socat TCP-LISTEN:3128 → UNIX-CONNECT:/run/netd.sock`,
  because standard tooling can't proxy straight to a unix socket. The launcher
  sets `HTTPS_PROXY/HTTP_PROXY/ALL_PROXY=http://127.0.0.1:3128`.
- Over the socket, **netd speaks the HTTP forward-proxy protocol** — `CONNECT
  host:443` for HTTPS (the common case), absolute-URI `GET http://…` for plain
  HTTP. So netd is just "an HTTP forward proxy listening on a unix socket."

## The contract

1. **Transport.** A stream (`AF_UNIX`, `SOCK_STREAM`) socket carrying the HTTP
   forward-proxy protocol. *How* netd is built behind that socket is its own
   business — a unix-socket-native proxy, or any TCP proxy (Squid/tinyproxy)
   fronted by `socat UNIX-LISTEN:/run/netd.sock,fork TCP:127.0.0.1:<port>`. The
   unix socket is the portable door that crosses the container/VM boundary
   (see CAPABILITIES.md "Transport is interchangeable").

2. **Allowlist by destination, not payload.** netd decides on the **CONNECT
   target host** (and `Host:` for plain HTTP) — *not* by inspecting traffic. It
   does **no TLS interception**: it opens a TCP tunnel to an allowed host and
   blindly relays bytes, so end-to-end TLS is preserved and netd never sees
   plaintext or holds a MITM CA. It is a *destination gate*, not a wiretap.

3. **Allowed ⇒ tunnel. Denied ⇒ refuse.**
   - allowed host → `HTTP/1.1 200 Connection established`, then relay.
   - denied host → `HTTP/1.1 403 Forbidden`, close. (Plain-HTTP denied → 403.)
   - There is no other path off the box, so a denial is final — `evil.com` is
     unreachable, full stop.

4. **Matching.** Exact host, or a leading-dot suffix for subtrees
   (`.anthropic.com` matches `api.anthropic.com`). Case-insensitive. Ports: 443
   and 80 only unless an entry says otherwise (`host:port`). No wildcards beyond
   the dot-suffix — keep it boring and auditable.

5. **Audit.** Every decision is logged: `ts, account, host:port, ALLOW|DENY`.
   Auditability is a first-class property of a door (cf. keeperd's signed-write
   log). A box's whole network reach is reconstructable from netd's log.

6. **Fail closed.** No allowlist loaded, socket error, or unknown verb ⇒ deny.
   A misconfigured netd must never degrade to open egress.

## The default allowlist

Deliberately tight — egress is a grant, so the default grants only what Claude
needs to *function*, and workloads widen it explicitly.

| Host | Why | Default |
|---|---|---|
| `api.anthropic.com` | the model API — Claude can't do anything without it | **on** |
| `.anthropic.com` | OAuth/`/login`, console endpoints | **on** |
| `statsig.anthropic.com` | telemetry/feature flags | off (opt-in) |
| `registry.npmjs.org`, `.npmjs.org` | `npm`/`bun` installs | off (per task) |
| `github.com`, `codeload.github.com`, `objects.githubusercontent.com` | clone/fetch | off (per task) |
| `pypi.org`, `files.pythonhosted.org` | `pip`/`uv` | off (per task) |

Profiles widen the set per launch (design, not yet wired):

```
claude-box work --net                 # default profile (anthropic only)
claude-box work --net --net-profile js   # + npm/github (a JS workload)
```

`--net-open` bypasses netd entirely (full ambient egress) — the loud, explicit,
**unsafe** escape hatch, for when no netd is running.

### Allowlist hygiene — fetch hosts, never write sinks (GH-6)

The allowlist is **security-critical**: the box can read its own OAuth token
(plaintext in the config volume), so egress is only safe while there's no
**writable sink** to POST it (or the repo) to. The rule for every default
profile:

- allow **fetch/read** hosts only — `codeload.github.com`,
  `objects.githubusercontent.com`, `registry.npmjs.org`, `files.pythonhosted.org`;
- **never** put a write API or upload target in a default profile —
  **`api.github.com`** (gists/PRs), pastebins, generic object stores, webhook
  catchers. Those turn a sanctioned door into an exfil channel.

`github.com:443` for `git clone`/`fetch` over HTTPS is a *fetch* use, but it is
also reachable for pushes — so pushes still go through **keeperd**, not netd, and
netd's job is only to let reads through. If a workload truly needs a write API,
that's an explicit, named, non-default grant — never folded into `js`/`clone`.

## Reference implementation

Recommended: **Squid** in allowlist-only mode (chosen in design review), fronted
by a `socat` unix-socket bridge, shipped as a **pinned OCI image in the pod**
(`prx-zj8`) so the door is a direct local mount — same lifecycle as the
claude-box image. A minimal allowlist-only `squid.conf`:

```
acl box   src all
acl ok    dstdomain api.anthropic.com .anthropic.com
http_access allow box CONNECT ok
http_access allow box ok
http_access deny all
http_port /run/squid.sock   # or a TCP port fronted by socat → /run/netd.sock
```

netd is intentionally small: a destination allowlist + an audit log. Everything
that makes claude-box safe on the *write* side (keeperd: keys never in the box)
it mirrors on the *reach* side — the box can only ask, and a daemon that holds
the policy answers.

## Status

Contract only. The launcher already forwards the door and sets the proxy env;
the image already relays loopback→`/run/netd.sock`. **netd-the-daemon is not yet
running**, so the `--net` end-to-end path (and its `test.todo` in
`tests/ocap.test.ts`) is pending the pod (`prx-asr`). Until then, the verified
guarantee is the *default*: no door ⇒ `--network=none` ⇒ no egress.
