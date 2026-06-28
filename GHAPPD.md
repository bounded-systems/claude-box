# ghappd — the GitHub App door (the box borrows a token, never holds the app key)

> **Status: design (draft).** Pairs with [DOORS.md](DOORS.md) (the model),
> [KEEPERD.md](KEEPERD.md) (the zero-knowledge sibling that *performs* git
> writes), and [AUTHD.md](AUTHD.md) (the sibling that *lends* a short-lived
> token). ghappd is the **easy case of the authd pattern**.

ghappd is the GitHub-credential counterpart to keeperd/authd. prx's GitHub
operations (open/merge PRs, post checks, file issues) need to authenticate to
`api.github.com`. Today that authority is a personal `gh` login or — with the
merged token broker — the `bounded-systems-prx` **App private key** injected into
the agent. ghappd owns the App key on a trusted host and lends the agent only a
short-lived, attenuated **installation token**. The agent never holds the key.

## The problem the current broker leaves open

The GitHub App token broker (prx `src/github-app/*`) is the right primitive, but
in its cloud-agent shape the long-lived **App private key (PEM)** is injected
into the agent as the `PRX_GH_APP_PRIVATE_KEY` env secret. We hardened that path
(env-scrub after read; per-call attenuation) — but the agent is still, for an
instant, the **home-of-record for a high-value org-wide root credential**. That
is the same critique AUTHD.md makes of the in-box `claude` login: a box should
*borrow* authority, not *hold* it. ghappd closes it.

A leaked App PEM is org-wide write (the manifest scopes) until rotation; a leaked
installation token is ≤1h and (with attenuation) one repo / a read scope. ghappd
collapses the blast radius from the former to the latter.

## Which pattern — keeperd (zero-knowledge) or authd (lend a token)?

KEEPERD.md works because a git write is a **discrete effect**: the box asks,
keeperd signs+pushes, the box never sees the key. A pure keeperd-style GitHub
door would mean reimplementing **every** GitHub operation prx performs behind the
door (a wide, ever-growing surface) — impractical.

So ghappd follows the **authd "lend a short-lived token" pattern**: the door
holds the root credential and hands out a scoped, self-expiring token the caller
uses directly. The installation token *is* the right-sized lent capability.

**And ghappd is strictly easier than authd**, because GitHub installation tokens
lack authd's two hard problems:

| | authd (claude.ai OAuth) | **ghappd (GitHub App)** |
|---|---|---|
| Lent token lifetime | access token ~8h | installation token ~1h |
| Refresh hazard | refresh token **rotates single-use** → concurrency conflict, must persist the rotation chain | **no refresh token** — re-mint freely from the key; no chain, no conflict |
| Continuity unknown | does `claude` re-read the rewritten creds file? (AUTHD Risk #1) | **moot** — `gh`/octokit read `GH_TOKEN` per call; re-mint is trivial |
| Attenuation | scope fixed in the access token | **per-lease** `repositories` + `permissions` (already wired in the broker) |

authd's whole phased build is gated on its continuity + rotation unknowns;
ghappd has neither. It is the clean instance of the door pattern.

## The design: host-owned App key, installation-token-only lease

```
            ┌─ op / agenix ─────┐        the home-of-record
            │ App private key    │        (the PEM lives here)
            └─────────┬─────────┘
                      │ read (ref from config)
                ┌─────▼─────┐  App JWT (RS256) → POST /app/installations/<id>/access_tokens
                │  ghappd   │ ───────────────────────────────────────►  api.github.com
                │  (host)   │ ◄──────────── short-lived installation token ───────────
                └─────┬─────┘     (optionally attenuated to repos/permissions)
                      │ lease: token only (≤1h), NEVER the PEM
                ┌─────▼─────┐
                │ the agent │  sets GH_TOKEN=<lease>; runs gh / octokit; re-leases before expiry
                └───────────┘
```

- **ghappd owns the App PEM on the host** (sourced from op/agenix — see Config).
- It signs the App JWT and calls `access_tokens` itself, optionally **attenuating
  the lease** to the repos/permissions the caller requests.
- It returns **only the installation token** (token + `expiresAt` + granted
  `permissions`), never the PEM, never the JWT.
- The agent sets `GH_TOKEN` from the lease and re-leases before the ~1h expiry.
  No rotation chain to persist; the door is the sole holder of the key.

This reuses the merged primitives end-to-end: `mintInstallationToken` /
`appJwt` run **inside** ghappd; the agent-side broker (`createBroker` /
`applyBrokeredGhToken`) gains a second backend — **lease-from-door** instead of
**mint-from-local-PEM** — chosen by config (below). The broker we shipped is the
client; ghappd is the server that holds the key.

## Door contract (DOORS.md `dispatch`)

One op, over the uniform `dispatch(guest, op, params)` / `DoorTransport`
(framed unix socket locally; TCP / cloud transport in transit):

```
dispatch(guest, "lease", { repositories?: string[], permissions?: Record<string,string> })
  → { token: string, expiresAt: string, permissions: Record<string,string> }
```

The grant (which guests may lease, default attenuation, the installation) is the
door's **persistent capability** (DOORS.md property 2); the credential is
**proxy-injected** by ghappd (property 3); the guest holds only a **reference**
to the door (property 1). Per-guest attenuation can floor the lease (a guest can
only narrow, never widen — Miller/E lineage, the capability-transport ADR).

## Config — refs from config, never hardcoded (AUTHD.md rule)

```
GHAPPD_OP_REF=op://<vault>/<item>/<field>   # the App private-key PEM, host-owned
GHAPPD_APP_ID=<app-id-or-client-id>
GHAPPD_INSTALLATION_ID=138039680            # default: the bounded-systems org
```

No vault path / app id / host fingerprint in ghappd's code — only the operator's
config layer (home-manager / env), matching the repo's single-source-of-truth
rule. On a self-hosted host the PEM may instead be an agenix/sops file
(`PRX_GH_APP_KEY_FILE`), read into ghappd at start (podman-secret → tmpfs).

## What it buys (threat model)

- **The agent never holds the App PEM.** Compromise of an agent (cloud or box)
  yields at most a ≤1h, optionally single-repo token — not the org root key.
- **No PEM in the cloud agent env.** This is the real answer to "better cloud
  secrets": the key never enters the Claude-cloud sandbox at all; the agent
  reaches ghappd over the door transport and receives only a lease. (ghappd runs
  on a trusted host, not in the sandbox.)
- **Every lease is an auditable door event** — a natural attestation point,
  fitting the trust-ledger ethos (who leased what scope, when).
- **Least-privilege by default** — the door can floor every lease to the minimum
  via the attenuation already built into the broker.

## Phased build (keeperd/authd sibling)

- **Phase 1 — `ghappd serve` (host-side, holds the PEM).** Build as a keeperd
  sibling: framed unix socket / TCP-mode port, registered in `knownDoors`. One
  op `lease` → read the PEM from `GHAPPD_OP_REF`, mint via the existing
  `mintInstallationToken` (with requested attenuation), return token-only. Egress:
  ghappd needs `api.github.com` (its own net posture, not the guest's allowlist).
  - **Gate:** `ghappd lease` returns a working installation token; a guest handed
    that token runs a `gh` op. ghappd is plumbing here, not yet a boundary.
- **Phase 2 — wire the agent broker's door backend.** `applyBrokeredGhToken`
  gains a `door` backend: when `PRX_GH_APP_DOOR=<ref>` is set, it leases from
  ghappd instead of reading a local PEM; sets `GH_TOKEN`; re-leases before expiry.
  Precedence stays: explicit `GH_TOKEN` (CI) > door lease > local PEM mint >
  personal `gh`.
  - **Gate:** an agent with **no `PRX_GH_APP_PRIVATE_KEY` / key file** runs GitHub
    ops by leasing from ghappd across a token expiry. The boundary goes live.
- **Phase 3 — cutover: remove the PEM from agents.** Drop `PRX_GH_APP_PRIVATE_KEY`
  from cloud-agent secret config and `PRX_GH_APP_KEY_FILE` from box/agent volumes;
  the PEM lives only behind ghappd.
  - **Gate:** `grep -r PRX_GH_APP_PRIVATE_KEY` finds nothing in any agent/box
    config, and a fresh agent with only a ghappd reference drives GitHub ops.

Until Phase 2, do not claim agents "don't hold the App key" — the hardened
env-injection broker (shipped) is still the home-of-record.

## Relationship to the door family

keeperd *performs* the git effect (zero-knowledge); authd *lends* the claude.ai
access token; **ghappd *lends* the GitHub installation token.** authd and ghappd
are both "token-lease" doors — once both exist, a shared *token-lease door*
abstraction (lease an attenuated, self-expiring credential from a host-held root)
is the natural generalization. Umbrella: the credential-isolation thesis
(prx-9s14 / AUTHD.md) extended to GitHub.
