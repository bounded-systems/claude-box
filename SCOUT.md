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

Design. `scoutd` is an external daemon (lives with keeperd/beadsd/netd in the
pod, `prx-zj8`); the `--scout` preset is not yet wired in the launcher. This doc
is the target so the read capability has a home the moment `gh` leaves the image.
Pairs with NETD.md (egress) and REPOD.md (local repo).
