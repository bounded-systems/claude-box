# scout — the read door (external reads are a capability too)

Removing `gh` from the box (GH-5) closes a latent push path — but it also takes
away how the box *read* the outside world (PRs, issues, remote repos, release
assets). Those reads shouldn't come back as another ambient tool-with-network;
they should be a **capability**, like writes (keeperd) and raw egress (netd).
That capability is **scout** — the read door.

A container bounds what the box can *write*, not what it can *reach* — and
**reads are reach.** netd gates the *transport* (which hosts a socket may talk
to); scout gates the *content* (what the box may fetch, as data, under policy).
The box asks scout for a thing; scout fetches it and hands back **content, not a
credential or a live connection**. The box never holds the token, the network,
or the tool.

## scout vs netd — two layers, not duplicates

| | **netd** (egress door) | **scout** (read door) |
|---|---|---|
| Level | transport — TCP/HTTP CONNECT allowlist | service — "fetch this artifact" requests |
| Grants | "you may reach host X:443" | "you may read repo/PR/URL Y" |
| Returns | a tunnel to an allowed host | bytes (a tree at a rev, a PR body, a file) |
| Holds | the allowlist | the read tokens (GitHub, registries) + fetch policy |
| Twin of | — | keeperd (writes) / repod (local repo) |

A box can have **scout without netd**: it reads via the scout door and still has
**no NIC** (`--network=none`). That's the point — most agent "network" needs are
*reads* (clone, fetch a PR, pull a doc), and those become a policed service call
rather than open egress. netd is only needed when the box itself must speak to a
host directly (e.g. the model API).

## The grant

A door, same model as the others — `--scout` (preset) forwards the scoutd socket:

```
claude-box work --scout --repo .
# → -v <scoutd.sock>:/run/scoutd.sock  --env SCOUTD_SOCK=/run/scoutd.sock
# The box asks scoutd to fetch; scoutd holds the read tokens + policy and
# returns content. No gh, no ambient token, no direct network for reads.
```

In the capability manifest it reads like the others: granted ⇒ "read external
artifacts via scoutd (you hold no read tokens)"; denied ⇒ "no external reads —
do not assume you can clone/fetch/browse; relaunch with --scout."

## The contract (sketch)

scoutd serves a small request/response protocol over the unix socket — the box
sends a typed read request, scoutd enforces policy and returns content:

| Request | Returns | Policy |
|---|---|---|
| `repo <url> [@rev]` | a read-only tree/tarball | allowlisted hosts/orgs; read scope only |
| `pr <repo>#<n>` / `issue …` | the body + metadata (JSON) | read-only GitHub token, never write scopes |
| `fetch <url>` | the response body | URL allowlist; size/type limits; no auth unless scoped |

Invariants (same spirit as NETD.md / keeperd):
- **Returns content, never capability** — no token, cookie, or live socket crosses back.
- **Read scopes only** — scoutd's GitHub token can read; it physically cannot push (that's keeperd's job with a different key).
- **Allowlist + limits, fail closed** — unknown host/scope/oversize ⇒ refused, logged.
- **Audit** — every fetch logged `ts, account, request, ALLOW|DENY`.

## Why this pairs with dropping `gh`

`gh` bundled three things into one ambient tool: a **read** client, a **write**
client (push/PR-create), and a **credential store**. The OCAP split unbundles
them — writes → **keeperd**, raw egress → **netd**, and reads → **scout** — so
each is a separately granted, separately audited door, and none of them is "a CLI
in the box holding a token." Dropping `gh` without scout would just lose the read
capability; dropping it *with* scout relocates the capability to where it can be
governed.

## Status

**Implemented.** The `--scout` preset is wired in the launcher (`knownDoors()` in
`claude-box.ts`): `claude-box … --scout` forwards `<scoutd.sock>` →
`/run/scoutd.sock` and exports `SCOUTD_SOCK`.

- **scoutd.ts** — the daemon (same NDJSON protocol as keeperd)
- **lib/scout.ts** — in-box client library
- **scoutd-image** — OCI image via `nix build .#scoutd-image`
- **quadlet/scoutd.container** — systemd unit for running in podman machine

The daemon supports:
- `status` — health check + allowlist
- `repo` — fetch GitHub repo metadata
- `pr` — fetch PR metadata, diff, comments
- `issue` — fetch issue metadata + comments
- `project` — fetch GitHub Projects v2 board items (read-only; GraphQL —
  there's no REST equivalent). Lets a box SEE a project board (e.g. the org's
  Front Desk roadmap) without holding a token; it cannot set Status/Score/etc.
  through this door — writing to a board stays a host-side, App-token
  operation (see GHAPPD.md).
- `fetch` — fetch arbitrary URL (allowlist enforced)
- `download` — download file content (base64)

`claude-box --issue owner/repo#N` (or a full GitHub issue URL) is sugar over
this: it implies `--scout` and seeds the guest's first prompt with an
instruction to read that issue via scoutd's `issue` method and work it — so
handing an agent a specific piece of work never requires it to hold a token.

Tokens: set `SCOUTD_ALLOW` to customize the allowlist (default: GitHub + npm + pypi).
Place a GitHub token at `~/.claude-box/scout_github_token` for private repo access.

Its ocap acceptance test (`tests/ocap.test.ts`) stays `test.todo` until the pod lands.
Pairs with NETD.md (egress) and REPOD.md (local repo).

## scoutd's own egress — also a door (in progress)

The box reads via scout without a NIC — but **scoutd itself** still holds a raw
NIC to reach GitHub. The end state is **only netd (or netd instances) hold a
NIC**: scoutd runs `--network=none` and egress is *forced* through netd, so the
read door is brokered end to end.

**Step 1 (plumbing only — NOT a boundary change):** scoutd is egress-proxy
*capable* — set `SCOUTD_PROXY` to an HTTP proxy (a netd door) and every outbound
fetch routes through it; unset = direct. But scoutd **still has its NIC**, so the
proxy is opt-in *cooperation*, not interposition — it moves no security boundary.
The in-process allowlist is **unchanged: still scoutd's sole network control**
(not yet defense-in-depth). This step only makes scoutd *ready* to be wired.

**Step 2 (the boundary move — implemented in the images + NixOS module):**
egress is reasoned, never generic. `netd` is the *mechanism*; each instance is
named for its reason and carries that reason's allowlist:
- **`claude-netd`** — the box reaches Anthropic (serves the box's `netd.sock`
  door, Anthropic allowlist).
- **`scout-netd`** — scoutd reads GitHub (its own `scout-netd.sock`, GitHub +
  npm/pypi allowlist).

scoutd runs **`--network=none`** (no NIC); its entrypoint bridges loopback →
`scout-netd.sock` and sets `SCOUTD_PROXY`, so egress is *forced* through
scout-netd — interposition, not cooperation. **netd is now the source of truth**
for the allowlist: scoutd's in-process list short-circuits to allow-all when
`SCOUTD_PROXY` is set (no duplicated policy at the boundary) and guards only the
direct/dev path. Mechanism: `NETD_SOCK` lets netd instances coexist on one doors
volume (`flake.nix`); the dedicated instances + `--network=none` are wired in
[`nixos/doors.nix`](./nixos/doors.nix). Quadlet parity is a follow-up; verify on
a real host that scoutd reaches GitHub through scout-netd. See NETD.md.
