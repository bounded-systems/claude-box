# authd — the Remote Control auth door (the box borrows a login, never holds one)

> **Status: design (spike prx-qba1 complete, not yet built).** This doc records
> what the spike resolved so the build can start cold. Pairs with
> [DOORS.md](DOORS.md) (the model), [KEEPERD.md](KEEPERD.md) (the sibling that
> brokers git-writes), and [CAPABILITIES.md](CAPABILITIES.md).

authd is the auth counterpart to keeperd. A box with the `--remote-control`
profile needs the user's **full-scope claude.ai OAuth login** to drive a Remote
Control session from the Claude app — but the box must not *hold* that
credential. authd owns the credential on the host and lends the box only a
short-lived access token.

## The problem RC creates

The merged `--remote-control` profile works today, but it relies on a full-scope
`claude auth login` that **persists into the box's `claude-<account>-config`
volume**. That makes the box the home-of-record for a powerful credential — the
opposite of the credential-isolation the box exists for. authd fixes that.

> **Today's front door: `claude-box login <account> --scope full`.** This launches
> a minimal, repo-less box bound only to the account's config volume so you can
> `claude auth login` once and persist it (the prerequisite for
> `--remote-control`). It is **box-local** — the credential still lands in the
> account volume, i.e. exactly the home-of-record problem above. authd is the
> planned move: the same login flow, but the refresh token lives host-side and
> the box is lent an access-token only. `claude-box login` is the seam that
> migration slots into (the CLI surface stays; the custody moves).

## Why not the keeperd pattern (broker performs the effect)

keeperd works because a git write is a **discrete effect**: the box asks, keeperd
signs+pushes, the box never sees the key. **Remote Control is not a discrete
effect — it is the session itself.** To drive the *boxed* session from the app,
the RC process *must be the box's own `claude`*. So a pure "authd performs RC on
the box's behalf" is impossible: there is no RC to perform elsewhere; the box is
the endpoint. Running RC host-side instead (host `claude` reaching into `/work`)
throws away the box's isolation — pinned image, netd allowlist, doors — so it is
not the boxed session at all.

**Conclusion: zero-knowledge brokering (box never sees any token) is infeasible
for RC.** The achievable ceiling is: the box holds only a *short-lived access
token*, never the refresh token, and never persists anything.

## The design (B): host-owned refresh, access-token-only injection

```
            ┌─ op (1Password) ──┐         the home-of-record
            │ full-scope login  │         (refreshToken lives here)
            └─────────┬─────────┘
                      │ op read (ref from config)
                ┌─────▼─────┐  OAuth2 refresh_token grant
                │   authd   │ ───────────────────────────►  platform.claude.com
                │  (host)   │ ◄─── rotated refreshToken ──   /v1/oauth/token
                └─────┬─────┘     (persisted back to op)
                      │ inject accessToken-only (tmpfs, no refreshToken)
                ┌─────▼─────┐
                │  the box  │  runs `claude remote-control`; never sees refreshToken
                └───────────┘
```

- **authd owns the refresh token on the host** (sourced from op — see "Config").
- It performs the OAuth2 `grant_type=refresh_token` itself, **persisting each
  rotated refresh token** back to op (rotation is single-use).
- It writes **only a short-lived `accessToken`** (no `refreshToken`) into the
  box's **tmpfs** credentials file, and re-writes it before the ~8h expiry.
- The box runs RC on that. It never holds the refresh token and never refreshes.

### Why this is sound (validated, not assumed)

RC's eligibility checks (from `/doctor`) — provider, `OAuth token present`,
`user:profile` scope, feature-flag gate — all key off the **access token**, not
the refresh token (the scope is *inside* the access token; the gate is an API
call). **Verified empirically:** stripping the `refreshToken` from a credentials
file and running `claude -p` returned a normal response — claude authenticates
and runs on an access-token-only credential. So the box does not need the refresh
token to start or run an RC session; it only needs the access token kept fresh,
which is authd's job.

### Bonus: this also removes the concurrency hazard

Refresh tokens **rotate (single-use)** — so two independent refreshers (box +
host) would invalidate each other. In design B the box **never refreshes**;
authd is the sole writer of the rotation chain. (Caveat still stands: a *separate*
host `claude` session logged into the same account would fight authd over
rotation — the RC credential wants exclusive use, or its own dedicated login.)

## Config — refs come from config, never hardcoded

authd takes its credential **reference** from config/env, the same way the
launcher takes its token via `CLAUDE_CODE_OAUTH_TOKEN` and `cbox` takes its op
ref from `CLAUDE_BOX_OP_TOKEN_REF` (env.nix, single source of truth). e.g.:

```
AUTHD_OP_REF=op://<vault>/<item>/<field>   # the full-scope login, host-owned
```

No vault path, account name, or host home appears in authd's code — only in the
operator's config layer (home-manager / env). This matches the repo's
"one explicit source of truth, no host fingerprints in the codebase" rule.

## Credential shape (for the file authd writes)

The full-scope login persisted by `claude auth login` (Linux
`$CLAUDE_CONFIG_DIR/.credentials.json`) is, with secrets redacted:

```json
{ "claudeAiOauth": {
    "accessToken":  "<short-lived, ~8h>",
    "refreshToken": "<rotates single-use>",   // authd keeps this; box never gets it
    "expiresAt": <unix-ms>,
    "scopes": ["user:profile", "user:inference", "user:mcp_servers", ...],
    "subscriptionType": "max",
    "rateLimitTier": "..." } }
```

authd writes the same shape into the box **minus `refreshToken`**, refreshing
`accessToken`/`expiresAt` before expiry.

## Open risks — verify before/while building

1. **Continuity across expiry (the key unknown).** When the box's access token
   nears expiry, does the box's `claude` **re-read** the (authd-refreshed)
   credentials file, or does it cache the token and only attempt a
   `refreshToken`-based refresh on 401? If it re-reads, B is seamless. If it
   caches, authd must nudge/restart the session at refresh. Hard to test quickly
   (8h token life) — treat as the build's primary risk.
2. **OAuth refresh specifics — RESOLVED (confirmed first-hand from the claude-code
   client, no live rotation, prx-6194 Phase 0).** POST
   `https://platform.claude.com/v1/oauth/token`, body **`application/x-www-form-urlencoded`**
   = `grant_type=refresh_token` · `refresh_token` · `client_id` · `scope`. The public
   client id is **`9d1c250a-e61b-44d9-88ed-5944d1962f5e`** (app=claude-code); default
   scopes `org:create_api_key user:inference user:mcp_servers user:profile`. **No
   `code_verifier`/PKCE on refresh** (PKCE is only the initial auth flow — the
   suspected conflation, confirmed). authd's `refreshAccessToken` implements exactly
   this; it stays gated behind `AUTHD_REFRESH_LIVE=1` only on Risk #1 (continuity)
   now, not the spec.
3. **Exclusive use.** The RC credential should not be shared with a concurrent
   host `claude` session (rotation conflict). Consider a dedicated login.

## Build sketch (keeperd-sibling)

- `authd serve` (Unix socket / TCP-mode port like the others), registered in the
  door catalog (`knownDoors`) so `--remote-control` mounts it.
- Ops: `lease` (refresh if needed, return a fresh access-token-only credential),
  done on a timer + on demand; refresh-token rotation persisted to op.
- `--remote-control` sources the credential from the authd door **instead of**
  mounting `claude-<account>-config` — the box's config volume goes
  credential-free.
- Migrate the existing in-box-login full-scope credential out of the box volume
  into op (the host home-of-record) as part of cutover.

## Status of the umbrella epic

prx-9s14 (the `--remote-control` profile): the interim profile + spike are done;
authd is the hardening that makes the box stop holding the credential.

## Build plan (phased — gated on the continuity unknown)

The design (B) is settled; the build order is driven by **Open Risk #1
(continuity across expiry)**, because the answer to it decides how much authd has
to do. Same discipline as CONCIERGE.md §9: each phase has a verification gate, and
nothing downstream is claimed as a security boundary until the credential
actually stops living in the box (Phase 3).

- **Phase 0 — resolve the continuity unknown (do this *first*, before any
  daemon).** Answer: when authd rewrites `accessToken`/`expiresAt` in the box's
  credentials file, does the box's `claude` **re-read** it, or cache the token and
  only refresh on a 401? Cheap experiment (don't wait 8h, don't trigger a live
  rotation): hand a box an access-token-only credential with a **near-future
  `expiresAt`**, let it idle past that, rewrite the file with a fresh
  access-token, and observe whether the next request succeeds without a restart.
  - **Gate:** *re-reads* → Phase 2 is a file-rewrite-on-a-timer (seamless);
    *caches* → Phase 2 must also nudge/restart the RC session at refresh. This
    single bit sets Phase 2's scope, so it's the cheapest thing to learn early.
  - The OAuth refresh spec (Risk #2) is **DONE** — confirmed first-hand from the
    claude-code client (see Risk #2 above): form-encoded, `client_id`
    `9d1c250a-…`, no PKCE on refresh. `refreshAccessToken` implements it. So Phase 0
    reduces to the **continuity** bit; the live exchange stays gated on it.

- **Phase 1 — `authd serve` (host-side, NOT yet wired into `--remote-control`).**
  Build the daemon as a keeperd sibling: Unix socket / TCP-mode port, registered
  in `knownDoors`. One op: `lease` → read the refresh token from op
  (`AUTHD_OP_REF`), perform the `grant_type=refresh_token` exchange, **persist the
  rotated refresh token back to op** (single-use chain, authd is sole writer),
  return an **access-token-only** credential (the §"Credential shape" minus
  `refreshToken`). Egress: authd needs `platform.claude.com` (its own net posture,
  not the box's allowlist).
  - **Gate:** `authd lease` returns a fresh access-token-only credential, and a
    box handed *that* (manually mounted) starts an RC session — reusing the
    already-verified fact that access-token-only runs RC. authd is **plumbing
    here, not yet a boundary**: the box volume still holds a credential until
    Phase 2/3.

- **Phase 2 — wire `--remote-control` to source from the authd door.** The box
  gets its credential from `lease` (written to **tmpfs**, no `refreshToken`)
  **instead of** mounting `claude-<account>-config`; authd re-leases before the
  ~8h expiry, applying the Phase-0 continuity mechanism (timer rewrite, +
  nudge/restart iff caching). Add the **exclusive-use guard** (Risk #3): refuse /
  warn if a concurrent host `claude` shares the same account login (rotation
  conflict), or require a dedicated login.
  - **Gate:** an RC box runs across a token expiry with **no `refreshToken`
    anywhere in the box** and no manual re-login. This is where "the box borrows a
    login, never holds one" becomes true — the boundary goes live.

- **Phase 3 — cutover: move the home-of-record out of the box.** Migrate the
  existing in-box-login full-scope credential from `claude-<account>-config` into
  op (host). `claude-box login --scope full` becomes the **seam**: it persists to
  op via authd instead of the box volume (CLI surface unchanged, custody moves —
  exactly the migration AUTHD.md's intro promises). The box config volume is now
  **credential-free** for RC.
  - **Gate:** a fresh machine with only the op ref + `claude-box login` can drive
    RC, and `grep -r refreshToken` finds nothing in any box volume.

Until Phase 2, do not claim the box "doesn't hold the credential" — Phases 0–1
are de-risking + plumbing; the box-local login (`claude-box login`, shipped) is
still the home-of-record.

