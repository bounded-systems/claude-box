#!/usr/bin/env bun
/**
 * authd-continuity.ts — AUTHD.md Phase 0 / Risk #1 experiment harness (prx-6194).
 *
 * THE QUESTION: when authd rewrites the box's `.credentials.json` with a fresh
 * access token, does the box's `claude` RE-READ the file, or CACHE the token in
 * memory (only refreshing on a 401)? The answer sets Phase 2's scope:
 *   re-read → Phase 2 is a file-rewrite-on-a-timer (seamless).
 *   cache   → Phase 2 must also nudge/restart the RC session at each refresh.
 *
 * HOW IT STAYS SAFE: it manipulates ONLY the client-side `expiresAt` on a
 * credential YOU supply. It never triggers a live OAuth rotation (single-use —
 * that would invalidate your in-use token), and never prints the token. An access
 * token is valid ~8h SERVER-side, so the SAME token keeps being accepted by the
 * API while we move its client-side `expiresAt` — that is exactly what lets us
 * probe re-read vs cache with one token and no rotation.
 *
 * PROCEDURE (you drive the interactive `claude`; the harness stages + rewrites):
 *   1. bun tools/authd-continuity.ts stage <your .credentials.json> [--target DIR]
 *        → writes an ACCESS-TOKEN-ONLY copy with expiresAt = now + 90s (the authd
 *          shape: no refreshToken). DIR defaults to $CLAUDE_CONFIG_DIR.
 *   2. Start `claude` (interactive, same CLAUDE_CONFIG_DIR) and send a prompt → works.
 *   3. Wait > 90s; `… status` shows EXPIRED (client-side).
 *   4. (control) send a prompt now — if it FAILS, claude gates on `expiresAt`, so
 *      the test is meaningful (it noticed the expiry). If it still works, claude
 *      ignores client-side expiry → the continuity question is moot (re-read wins
 *      trivially); note that and stop.
 *   5. bun tools/authd-continuity.ts rewrite-fresh
 *        → expiresAt = now + 8h (SAME token; what authd's re-lease would write).
 *   6. In the SAME `claude` session, send a prompt:
 *        works → RE-READ  (Phase 2 = timer rewrite; seamless)
 *        fails → CACHE    (Phase 2 = also nudge/restart the session at refresh)
 *
 * FIDELITY: an interactive `claude` is the proxy here; for the highest-fidelity
 * answer, run the same stage→wait→rewrite against an actual `claude remote-control`
 * session driven from the app. The credential mechanics are identical.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toAccessTokenOnly, type ClaudeCredentials } from "../authd.ts";

const NEAR_EXPIRY_MS = 90_000; // 90s — long enough to start a session, short enough to wait out
const FRESH_TTL_MS = 8 * 60 * 60 * 1000; // ~8h, what a real lease grants

/** Stage: an access-token-only copy of `source` with a near-future expiry — the
 *  shape authd hands the box, primed to expire (client-side) during the test. */
export function stageCredential(source: ClaudeCredentials, now: number, ttlMs = NEAR_EXPIRY_MS): ClaudeCredentials {
  const out = toAccessTokenOnly(source);
  out.claudeAiOauth.expiresAt = now + ttlMs;
  return out;
}

/** Rewrite: bump only `expiresAt` to now + ttl (same token) — what authd's
 *  re-lease writes when it refreshes the access token before expiry. */
export function bumpExpiry(creds: ClaudeCredentials, now: number, ttlMs = FRESH_TTL_MS): ClaudeCredentials {
  return { claudeAiOauth: { ...creds.claudeAiOauth, expiresAt: now + ttlMs } };
}

// ── CLI (impure: file I/O; never logs the token) ─────────────────────────────
function configDir(args: string[]): string {
  const i = args.indexOf("--target");
  if (i >= 0 && args[i + 1]) return args[i + 1]!;
  return process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? "/tmp", ".config", "claude");
}
function credPath(dir: string): string {
  return join(dir, ".credentials.json");
}
function readCreds(path: string): ClaudeCredentials {
  const c = JSON.parse(readFileSync(path, "utf-8")) as ClaudeCredentials;
  if (!c.claudeAiOauth?.accessToken) throw new Error(`${path}: not a claudeAiOauth credential`);
  return c;
}
function writeCreds(path: string, c: ClaudeCredentials): void {
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(c, null, 2), { mode: 0o600 });
}
const stamp = (ms: number): string => new Date(ms).toISOString();

function main(): number {
  const [cmd, ...rest] = Bun.argv.slice(2);
  const now = Date.now();
  const dir = configDir(rest);
  const target = credPath(dir);

  if (cmd === "stage") {
    const source = rest.find((a) => !a.startsWith("--"));
    if (!source) {
      console.error("usage: stage <path-to-.credentials.json> [--target DIR]");
      return 2;
    }
    const staged = stageCredential(readCreds(source), now);
    writeCreds(target, staged);
    console.error(
      `staged access-token-only credential → ${target}\n` +
        `  refreshToken: stripped (the box never holds it)\n` +
        `  expiresAt:    ${stamp(staged.claudeAiOauth.expiresAt)} (in ${NEAR_EXPIRY_MS / 1000}s)\n` +
        `Next: start \`claude\` with CLAUDE_CONFIG_DIR=${dir}, send a prompt, then wait it out.`,
    );
    return 0;
  }

  if (cmd === "rewrite-fresh") {
    const fresh = bumpExpiry(readCreds(target), now);
    writeCreds(target, fresh);
    console.error(
      `rewrote expiresAt → ${stamp(fresh.claudeAiOauth.expiresAt)} (in 8h); same token, still no refreshToken.\n` +
        `Now send a prompt in the SAME claude session: works → RE-READ, fails → CACHE.`,
    );
    return 0;
  }

  if (cmd === "status") {
    const c = readCreds(target);
    const exp = c.claudeAiOauth.expiresAt;
    console.error(
      `${target}\n  expiresAt: ${stamp(exp)} — ${exp <= now ? "EXPIRED (client-side)" : `valid for ${Math.round((exp - now) / 1000)}s`}\n` +
        `  refreshToken: ${c.claudeAiOauth.refreshToken ? "PRESENT (not the authd shape!)" : "absent (access-token-only ✓)"}`,
    );
    return 0;
  }

  console.error(
    "authd-continuity — AUTHD.md Phase 0 / Risk #1 (re-read vs cache). See the header.\n" +
      "  stage <.credentials.json> [--target DIR]   write access-token-only, expiry in 90s\n" +
      "  rewrite-fresh [--target DIR]               bump expiresAt to +8h (same token)\n" +
      "  status [--target DIR]                      show expiry vs now",
  );
  return cmd === "-h" || cmd === "--help" ? 0 : 1;
}

if (import.meta.main) {
  process.exit(main());
}
