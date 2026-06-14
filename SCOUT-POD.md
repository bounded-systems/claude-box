# SCOUT-POD.md — private reads in the pod: credential-free, host-free, cloud-portable

How a box clones/reads a **private** `--repo-origin` from inside its pod while
holding **no credential** — *and while no per-box door holds a standing secret
either* — with **no host assumption**, so the same pod lifts into the cloud
unchanged. Pairs with [DOORS.md](./DOORS.md) (the door/actor model),
[POD.md](./POD.md) (pod-per-box), [SCOUT.md](./SCOUT.md) (the read door).

## Shape — scout is a read actor in the pod; the credential is *brokered*

scout runs as a **sidecar in the box's pod** (like netd). The box **dispatches a
read** to it over pod-local transport. scout does **not** hold a standing GitHub
token — it obtains the credential from the **broker** (`keymaker`) per request, and
returns content. The box never sees the token, the network, or a live remote. The
pod is the boundary (the "VPC"); pod membership is the grant.

## The rule: standing secret vs. ephemeral capability

Putting a long-lived token in the scout door would just **relocate** the ambient
secret from the box to the door — not eliminate it. So:

- A **standing secret** (a long-lived bearer token, a signing key, an App private
  key) lives in **exactly one broker** — the trust root (`keymaker`). Never in the
  box, never standing in a per-box door.
- A **door holds at most an ephemeral, attenuated derivative**: a token scoped to
  *one repo*, expiring in minutes — or **nothing at rest**, with the broker
  **injecting** auth into the single request (the door makes a naked call; the broker
  adds the credential at the last hop). A scoped, expiring, one-repo token *is* a
  capability, not a secret.

This is the [DOORS.md](./DOORS.md) model verbatim ("standing secrets in one broker;
doors hold attenuated ephemeral derivatives; the proxy injects credentials").

## Decisions

### Credential: brokered, not door-held — and `gh auth` is a *broker source*

The scout door obtains its GitHub credential from `keymaker` per read, in one of two
faithful forms:

| Source | What it is | Where the standing secret lives | Tier |
|---|---|---|---|
| `gh auth token` (PAT/OAuth) | a **broad, un-attenuable** token | the **broker**, injected per-request — the door holds nothing at rest | interim / local |
| **GitHub App** | broker holds the App key; **mints per-repo installation tokens** (scoped, ~1h TTL) | the door gets the *minted* scoped token | cloud / end-state |

- `gh auth` **can't** be attenuated (PATs don't mint sub-tokens), so it never lives in
  a door — it lives in the broker and is injected. Local-dev shim only.
- The attenuated end-state is a **GitHub App in the keymaker** minting per-repo,
  short-TTL tokens — those *are* capabilities, safe for the door to hold ephemerally.
- Either way: **box holds nothing; door holds no standing secret; one broker holds
  the root.** No host path, no `gh`/`op` binary inside the daemon.

> scoutd today loads a token from a file (it *is* a standing-token-holding door).
> That is the **interim** this spec retires — the door becomes a broker client.

### Lowest-risk, redactable form — the pick

Two faithful forms exist (door holds a *minted scoped token* vs. door holds
*nothing* and the broker injects in-path). Judged on **risk + redactability**, the
pick is: keymaker (GitHub App) mints a **read-only, single-repo, short-TTL
installation token**, hands it to scout as an **`Authorization` header /
credential-helper — never a URL** — scout builds a **bundle** (content only) and
discards the token.

**Lowest risk.** The purist "broker injects, door holds nothing" form needs a
**TLS-terminating proxy in the fetch path** — more moving parts, and it forfeits
"provably GitHub." The minted-token form is an ordinary authenticated mirror-clone
with a scoped token. Blast radius: **one repo, read-only, minutes.**

**Most redactable.**
- **Revocable at the source** — an App installation token can be revoked instantly
  *and* auto-expires. Redaction = revoke / stop minting; no long-lived thing to chase.
- **Scoped** — one repo, read-only: a leak is bounded.
- **Never enters a transcript** — header-injected, *not* a `https://TOKEN@github.com/…`
  URL (which lands in `git remote -v`, process args, error text). The box receives a
  **content-only bundle** and never sees a credential, so the box's logs/transcript
  *cannot* contain one; scout scrubs the header from its own logs.

So the **GitHub App is the primary**, not merely the cloud end-state — it is the
primitive that makes the credential scoped + revocable + non-leaking at once. The
`gh auth` PAT is the **un-redactable** fallback (broad, can't scope, can't granularly
revoke): local-dev only, and it must never reach a transcript.

### Clone semantics: git **bundle**, to preserve history + commit-back

scout's `repo` op returns a **tarball snapshot** — no `.git`, no commit-back.
`--repo-origin`'s point is in-box git + **commit via keeper**, so scout gains a
**`bundle`** op:

1. scout `git clone --mirror`s the repo (authenticated via the brokered credential),
2. `git bundle`s it, streams the bundle to the box,
3. the box `git clone`s **from the bundle** → full history, branches, commit-back
   through the keeper door.

The tarball op stays for read-only / CI boxes that don't need history.

### Transport: pod-local, nothing host-exposed

scout listens on a **pod-local TCP port** in the pod's shared netns (mirroring
netd's `--port`). No host port, no `host.containers.internal`, no `/run/doors` host
path. (scoutd is unix-socket-only today; it gains `--port`.)

## The cloud-portability invariant

No step may assume a host. No host file paths, no host ports, no `gh`/`op` binary in
a daemon. The **broker** is the only standing-secret holder, and it too takes its
root by injection (op locally; a cloud secret/KMS in prod) — it is not host-bound.
Everything else is minted/injected per request. The pod is a self-contained workload
that runs identically on a laptop or a cloud scheduler. Host TCP (`DOORS_TCP`) is the
opposite of this and is retired once the pod reaches parity.

## Increments

1. **broker-client token path in scoutd** — scoutd requests a credential from
   `keymaker` per read (or accepts an injected per-request token), replacing the
   file-load. Door stops holding a standing secret.
2. **scout `bundle` op** — authenticated `git clone --mirror` → `git bundle` →
   stream; typed request/response, policy-gated.
3. **runPod scout sidecar** — start scoutd in the pod as a broker client; the box's
   private `--repo-origin` clones **via scout** (the bundle) instead of a naked netd
   clone (which can't auth and now fails fast — see the clone-no-tty fix).
4. **keymaker GitHub App** — mint per-repo, short-TTL installation tokens (the
   attenuated end-state); `gh auth` remains the un-attenuated local fallback.
5. **retire host TCP** — once the pod covers net + scout (+ later keeper), delete
   `DOORS_TCP` and the host-port doors. The pod is the only transport.

## cbox, evolved

Today: `op read` on the host + `DOORS_TCP=1`. Cloud-portable form: the launcher
points the **broker** at a credential source (`gh auth token` / `op` locally; a cloud
secret in prod); the scout sidecar is a broker client; the box runs `--pod`. No host
ports, no in-box credential, no standing secret in any per-box door.

## Tracking

`keymaker` (the broker / mint — `prx-5u1` prior art), `prx-o92` (transport-agnostic
dispatch client), the scout/keeper pod sidecars, and the future-directions note in
[ROADMAP.md](./ROADMAP.md).
