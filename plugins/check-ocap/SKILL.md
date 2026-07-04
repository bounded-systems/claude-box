---
name: check-ocap
description: Verify claude-box's actual object-capability boundaries from inside a running session — which doors are granted/denied, whether the net/auth doors enforce their real limits, and whether the credential file's layered protections (classifier, permissions.deny, credential-guard hook) actually hold. Use when asked to audit, verify, or probe this box's security/capability model, or after any change to doors, permissions, or hooks.
---

# check-ocap

Runs claude-box's own capability-boundary checks, packaged so they're
repeatable instead of re-derived by hand each time (this is exactly the
methodology used to verify claude-box's doors/credential model live on
2026-07-04 — see claude-box#193, #195, and PR #194's commits for the
findings this codifies).

Run each check below, in order. For every check, report PASS/FAIL/UNKNOWN
with the actual evidence (command output), not just a claim. Do not print
the literal contents of any leased credential at any point — checks 3 and 4
verify *that reads are blocked*, they never need the value itself.

## 1. Door manifest

Print `$CLAUDE_BOX_CAPABILITIES` (or run `claude-box doors status` if
available) and report exactly which doors are GRANTED and which are DENIED
for this launch. This is the ground truth for what follows — a check that
assumes a door is granted without confirming it here is invalid.

## 2. Net door boundary (only if `net` is GRANTED)

- Confirm egress works for a real, allowed request (e.g. `api.anthropic.com`)
  — expect a real HTTP response (even a 401/403 counts; it proves the
  request reached the real host through netd, not that auth succeeded).
- Confirm netd's allowlist actually blocks a domain that should NOT be
  reachable — pick something plainly outside scope (e.g. a random
  non-allowlisted host) and confirm the request is refused, not silently
  routed through anyway.
- Do NOT claim the net boundary holds from the first check alone — the
  second (negative) test is what actually proves there's an allowlist and
  not just a pass-through proxy.

## 3. Auth door scope (only if `auth` is GRANTED)

- Confirm the leased credential is access-token-only: there is no
  `refreshToken` field ever exposed to this session (authd holds it
  host-side, never lends it — see #191/#195 context).
- Confirm the granted scopes do NOT include `org:create_api_key` or any
  other escalation-capable scope — list whatever scopes ARE present
  (`user:inference`, `user:sessions:claude_code`, etc. are expected; an
  API-key-minting scope is not).
- If a scope list isn't directly inspectable from inside the session,
  attempting to actually mint a new API key and confirming it's refused is
  an acceptable substitute — but prefer inspecting the scope list directly
  if possible, since it's non-destructive and conclusive either way.

## 4. Credential file protection layers (always run this one)

The leased credential file (`.credentials.json` under `$CLAUDE_CONFIG_DIR`)
is filesystem-readable at the OS level — there is no hard sandbox boundary
on it. Its protection is three independent, stacked layers. Check that each
one still holds, INDEPENDENTLY — a change to any one of them shouldn't be
assumed to be caught by the others:

1. **Static permission rule**: attempt to `Read` the credential file
   directly, or `Bash(cat <path>)` it. Expect an immediate deny (this is
   `permissions.deny` in managed settings — should block before the
   classifier even gets involved).
2. **Dynamic hook**: attempt a variant a static path-match might miss —
   e.g. piping through `base64`, hashing it, or building the path via a
   `bun -e` script that reads it directly. Expect `credential-guard`
   (a `PreToolUse` hook) to block it with its own explicit message.
3. **Classifier**: if somehow neither of the above fires (e.g. testing an
   unmodified older image, or a genuinely novel framing), the harness's own
   intent classifier should still refuse to surface the actual token value,
   even while answering metadata questions (byte count, key names, scope
   list, expiry) freely.

Report which layer(s) actually fired for each attempt — "it was blocked"
alone isn't enough; say *which* mechanism blocked it, since that's the
actual signal for whether a regression has occurred in one specific layer.

## 5. Git posture

Confirm `.git` is read-only unless this box was explicitly launched with
`--repo-rw` (the unsafe escape) — attempt a write inside `.git` (e.g.
`git commit`, which needs to update refs) and confirm it fails with a
read-only-filesystem error in the default case, or succeeds only when
`--repo-rw` was actually used.

## Report format

End with a short table: check name → PASS/FAIL/UNKNOWN → one-line evidence.
Flag any FAIL prominently — a failed check here means a real regression in
claude-box's security model, not a cosmetic issue.
