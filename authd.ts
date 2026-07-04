#!/usr/bin/env bun
/**
 * authd — the Remote Control auth door for claude-box (spec: AUTHD.md, prx-6194).
 *
 * A box with `--remote-control` needs the user's full-scope claude.ai OAuth login
 * to drive a Remote Control session, but must NOT *hold* it. authd owns the
 * refresh token host-side and lends the box only a short-lived, ACCESS-TOKEN-
 * ONLY credential — never the refresh token. It is a keeperd sibling: the box
 * proves who it is the same way it does at every other door — a
 * concierge-minted SIGNED GRANT, here scoped to door="auth" (the door-model
 * identity unification, prx-6194). authd→Anthropic is OAuth2 refresh_token
 * (the broker holds the one standing secret).
 *
 * The refresh token's storage is EPHEMERAL, in-memory only — seeded from a
 * JSON credential line piped on stdin at boot — like an OIDC session:
 * nothing ever touches disk, gone the instant this process exits, portable to
 * any OS. A --remote-serve bastion refreshes normally for as long as it stays
 * up; only a RESTART needs a fresh login. (A Keychain-backed store and an op
 * fallback were both tried and dropped: Keychain is macOS-only, so it didn't
 * port to a Linux server, and op required a Touch ID prompt per lease;
 * ephemeral covers the actual need — refresh within a boot's lifetime — with
 * a strictly stronger, OS-agnostic security posture and no external
 * dependency at all.)
 *
 *   authd serve                  # unix socket (mount = authority)
 *   authd serve --port 3003      # tcp (host→VM relay; signed-grant gated)
 *
 * SCAFFOLD STATUS (Phase 1): the live OAuth refresh is GUARDED behind
 * AUTHD_REFRESH_LIVE=1 — AUTHD.md Phase 0 must confirm the refresh spec + the
 * continuity behaviour first-hand before it goes live (a live rotation is
 * single-use and would invalidate the in-use token). Verified live
 * end-to-end, 2026-07-03: a dedicated claude-box login → ephemeral store →
 * lease → real access token → rotated refresh token → write-back confirmed.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { verify, createPublicKey } from "node:crypto";
import type { Socket } from "bun";
import {
  defaultSocketPath,
  prepareSocket,
  createLogger,
  call,
  type RequestEnvelope,
  type ResponseEnvelope,
  ok,
  err,
} from "./lib/runtime";
import { verifyGrantWithKeys, type IssuerKeys } from "./guest-room/mod.ts";

const log = createLogger("authd");
const VERSION = "0.1.0";
const startedAt = new Date();

type MethodHandler = (params: Record<string, unknown>) => Promise<unknown>;

// ── Credential shape (AUTHD.md §"Credential shape") ──────────────────────────
export interface ClaudeCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken?: string; // authd keeps this host-side; the box never gets it
    expiresAt: number;
    scopes: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
  // `claude remote-control`'s org-eligibility check reads oauthAccount from
  // .claude.json, NOT .credentials.json — it's not part of the OAuth token
  // exchange at all, but a separate profile/org lookup `claude` caches after
  // login (org UUID, name, subscription info). A box that only gets a leased
  // access token but never populated this itself fails RC with "Unable to
  // determine your organization," even with a perfectly valid credential
  // (confirmed live). Captured once at check-in time (see claude-box.ts's
  // cmdCheckIn) and passed through opaquely — it doesn't rotate/expire like
  // the access token, so it's not part of the lease/refresh logic at all.
  oauthAccount?: unknown;
}

/** Strip the refreshToken: the box gets an ACCESS-TOKEN-ONLY credential it can
 *  run RC on but never refresh (validated in the spike — access-token-only runs
 *  RC). oauthAccount passes through unchanged — it's not secret, and the box
 *  needs it to pass RC's org-eligibility check. Pure. */
export function toAccessTokenOnly(creds: ClaudeCredentials): ClaudeCredentials {
  const { refreshToken: _dropped, ...rest } = creds.claudeAiOauth;
  return { claudeAiOauth: { ...rest }, oauthAccount: creds.oauthAccount };
}

// ── OAuth2 refresh (authd → Anthropic) ───────────────────────────────────────
// Spec CONFIRMED first-hand from the claude-code client (AUTHD.md Phase 0 / Risk
// #2 — by reading the client, NOT by a live rotation): POST
// `platform.claude.com/v1/oauth/token`, body `application/x-www-form-urlencoded`
// = { grant_type=refresh_token, refresh_token, client_id, scope }. There is NO
// `code_verifier`/PKCE on refresh (PKCE is only the initial auth flow). `fetchImpl`
// is injectable so tests mock it.
const TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
// The PUBLIC claude-code OAuth client id (not a secret; app=claude-code). Overridable.
const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export async function refreshAccessToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ creds: ClaudeCredentials; rotatedRefreshToken: string }> {
  // [Phase 0 GATE] The refresh spec is confirmed, but a live rotation is single-use
  // and the continuity behaviour is still unverified — so the live exchange stays
  // OFF unless the operator opts in. A misconfigured launch must not rotate a live
  // token. (Tests pass a fetchImpl AND set the flag; production waits on Phase 0.)
  if (process.env.AUTHD_REFRESH_LIVE !== "1") {
    throw {
      code: "REFRESH_GATED",
      message: "live OAuth refresh disabled until AUTHD.md Phase 0 verifies continuity (set AUTHD_REFRESH_LIVE=1)",
    };
  }
  // No `scope` param: per RFC 6749 §6, omitting it on a refresh_token grant
  // means "same scopes as the original grant" — sending a hand-maintained
  // list here drifted from reality the moment Anthropic added a scope this
  // login already had (user:sessions:claude_code, user:file_upload) that an
  // earlier hardcoded DEFAULT_SCOPES didn't know about, and the token
  // endpoint rejected the mismatch with invalid_scope. Omitting it entirely
  // means this can't go stale again.
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: process.env.AUTHD_CLIENT_ID ?? CLAUDE_CODE_CLIENT_ID,
  });
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    // OAuth error responses are {error, error_description} (RFC 6749) — plain
    // non-secret diagnostic fields, safe to surface (unlike the body of a
    // successful exchange, which carries live tokens and must never be logged).
    let errCode = `http ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; error_description?: string };
      if (body.error) errCode = body.error_description ? `${body.error}: ${body.error_description}` : body.error;
    } catch {}
    throw { code: "REFRESH_FAILED", message: `token endpoint rejected the refresh: ${errCode}` };
  }
  const r = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
  };
  const creds: ClaudeCredentials = {
    claudeAiOauth: {
      accessToken: r.access_token,
      refreshToken: r.refresh_token, // kept host-side; stripped before the box sees it
      expiresAt: Date.now() + r.expires_in * 1000,
      scopes: r.scope?.split(" ") ?? [],
    },
  };
  return { creds, rotatedRefreshToken: r.refresh_token };
}

// ── Ephemeral credential store — the ONLY source authd reads from: like an
// OIDC session, the refresh token lives ONLY in this process's memory,
// seeded once at boot from a single JSON line on stdin (stdin, never a CLI
// arg — an argv value shows up in `ps`, stdin doesn't), and is gone the
// instant this process exits. Nothing at rest, ever, on any OS. Within the
// process's life it refreshes and rotates normally, so a long-running
// --remote-serve bastion keeps working for as long as it stays up; only a
// RESTART requires a fresh login (see bellhop's login flow).
let ephemeralCred: ClaudeCredentials | null = null;

function readEphemeral(): { refreshToken: string; nativeBlob: ClaudeCredentials } {
  if (!ephemeralCred?.claudeAiOauth?.refreshToken) {
    throw { code: "EPHEMERAL_NOT_SEEDED", message: "authd was never seeded a credential on stdin at boot" };
  }
  return { refreshToken: ephemeralCred.claudeAiOauth.refreshToken, nativeBlob: ephemeralCred };
}

function writeEphemeral(creds: ClaudeCredentials): void {
  ephemeralCred = creds;
}

/** Runtime validation for the untrusted JSON piped on stdin at boot — see
 *  schemas/claude-credentials.schema.json for the canonical shape (and how
 *  it was derived). No Zod: this repo ships zero npm dependencies by
 *  design, so this is a small hand-rolled check instead, covering exactly
 *  the fields authd actually reads (accessToken/expiresAt/scopes) rather
 *  than a full schema walk. Throws a clear SEED_INVALID error instead of a
 *  cryptic property-access crash three calls later. */
function assertClaudeCredentials(raw: unknown): asserts raw is ClaudeCredentials {
  if (typeof raw !== "object" || raw === null) {
    throw { code: "SEED_INVALID", message: "credential JSON must be an object" };
  }
  const oauth = (raw as Record<string, unknown>).claudeAiOauth;
  if (typeof oauth !== "object" || oauth === null) {
    throw { code: "SEED_INVALID", message: "credential JSON missing a claudeAiOauth object" };
  }
  const o = oauth as Record<string, unknown>;
  if (typeof o.accessToken !== "string") {
    throw { code: "SEED_INVALID", message: "claudeAiOauth.accessToken must be a string" };
  }
  if (typeof o.expiresAt !== "number") {
    throw { code: "SEED_INVALID", message: "claudeAiOauth.expiresAt must be a number" };
  }
  if (!Array.isArray(o.scopes) || !o.scopes.every((s) => typeof s === "string")) {
    throw { code: "SEED_INVALID", message: "claudeAiOauth.scopes must be a string array" };
  }
}

/** Parse + validate a raw JSON credential blob (the shape `claude-box
 *  check-in`'s throwaway-login-container flow produces). Exported so the
 *  CLI's stdin-read and tests share one entry point. */
export function parseClaudeCredentials(rawJson: string): ClaudeCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    throw { code: "SEED_PARSE_ERROR", message: `credential JSON is not valid JSON: ${(e as Error).message}` };
  }
  assertClaudeCredentials(parsed);
  return parsed;
}

/** Seed the ephemeral store from a raw JSON credential blob. */
export function seedEphemeral(rawJson: string): void {
  const parsed = parseClaudeCredentials(rawJson);
  if (!parsed.claudeAiOauth?.refreshToken) {
    throw { code: "SEED_NO_REFRESH_TOKEN", message: "seeded credential has no claudeAiOauth.refreshToken" };
  }
  writeEphemeral(parsed);
}

// ── Ops ──────────────────────────────────────────────────────────────────────
async function handleStatus(): Promise<unknown> {
  return { status: "ok", version: VERSION, since: startedAt.toISOString(), refreshLive: process.env.AUTHD_REFRESH_LIVE === "1" };
}

/** How much slack before expiresAt still counts as "fresh enough to reuse
 *  without a live refresh." Generous on purpose: every live refresh ROTATES
 *  the refresh token server-side, so each one is a chance for the write-back
 *  to fail and strand the source item — a lease should only pay that cost
 *  when the current access token is actually running out, not on every call. */
const STALE_BUFFER_MS = 5 * 60 * 1000;

/** Pure: does this credential's access token still have enough life left to
 *  hand out as-is, no refresh needed? */
export function isStillFresh(creds: ClaudeCredentials, now: number = Date.now()): boolean {
  return creds.claudeAiOauth.expiresAt - now > STALE_BUFFER_MS;
}

/** lease: return a fresh ACCESS-TOKEN-ONLY credential for the box — reusing
 *  the current access token as-is when it still has life left (e.g. right
 *  after a login, or shortly after a prior lease), only paying for a live
 *  OAuth refresh (which ROTATES the host-side refresh token) when it's
 *  actually stale.
 *
 *  Write-back: a live refresh's rotation invalidates the OLD refresh token
 *  the instant it succeeds. The rotated credential replaces the in-memory
 *  ephemeral copy, so this process keeps refreshing off the new token for
 *  the rest of its life — gone the moment it exits; only a restart needs a
 *  fresh login. */
async function handleLease(): Promise<unknown> {
  const { refreshToken, nativeBlob } = readEphemeral();
  if (isStillFresh(nativeBlob)) {
    return toAccessTokenOnly(nativeBlob);
  }
  const { creds, rotatedRefreshToken } = await refreshAccessToken(refreshToken);
  // oauthAccount doesn't come back from a token refresh (it's not part of the
  // OAuth exchange at all) — carry the seeded copy forward across rotations.
  const rotated: ClaudeCredentials = {
    claudeAiOauth: { ...creds.claudeAiOauth, refreshToken: rotatedRefreshToken },
    oauthAccount: nativeBlob.oauthAccount,
  };
  writeEphemeral(rotated);
  return toAccessTokenOnly(rotated);
}

const METHODS: Record<string, MethodHandler> = {
  status: handleStatus,
  lease: handleLease,
};

// ── Transit-grant gate (tcp/vsock only) — door="auth" (prx-6194 OIDC identity) ─
// On a unix door the mounted socket IS authority. On tcp/vsock the caller presents
// the concierge-minted signed grant for the "auth" door, verified against the
// concierge's published keys (keyless, fetched + cached, re-fetched once on an
// unknown key). Identical to keeperd's gate, scoped to "auth". Set by serveTcp.
let grantRequired = false;

function conciergeSocket(): string {
  if (process.env.CONCIERGE_SOCK) return process.env.CONCIERGE_SOCK;
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) return `${runtime}/concierged.sock`;
  return `${process.env.HOME ?? "/tmp"}/.claude-box/concierged.sock`;
}

let issuerKeys: IssuerKeys | null = null;
/** Grant verification needs the issuer's public key. The concierge model
 *  (register-room + fetch-published-keys) isn't wired into claude-box.ts's
 *  direct CLI launch path yet, so AUTHD_ISSUER_KEYS_PATH is the deliberately
 *  simple stand-in: a static IssuerKeys JSON file on disk (see
 *  lib/box-keys.ts), read directly — no daemon round-trip, no rotation.
 *  Falls back to the concierge socket when that env var isn't set, so a
 *  future concierge-backed deployment needs no change here. */
async function fetchIssuerKeys(force = false): Promise<IssuerKeys> {
  if (issuerKeys && !force) return issuerKeys;
  const localPath = process.env.AUTHD_ISSUER_KEYS_PATH;
  if (localPath) {
    issuerKeys = JSON.parse(readFileSync(localPath, "utf-8")) as IssuerKeys;
    return issuerKeys;
  }
  issuerKeys = await call<IssuerKeys>(conciergeSocket(), "keys");
  return issuerKeys;
}

const grantVerifyWith = (data: string, signature: string, publicKeyPem: string): boolean =>
  verify(null, Buffer.from(data), createPublicKey(publicKeyPem), Buffer.from(signature, "base64"));

/** Gate a request on a tcp/vsock door: the presented signed grant must verify
 *  against the concierge's published keys for this room and the "auth" door. */
async function gateGrant(req: RequestEnvelope): Promise<{ ok: boolean; reason?: string }> {
  if (!grantRequired) return { ok: true }; // unix: reference is authority
  const grant = req.grant;
  if (!grant) return { ok: false, reason: "no-grant" };
  if (grant.name !== "auth") return { ok: false, reason: "wrong-door" };
  const ctx = { audience: process.env.ROOM_ID ?? "", now: Date.now() };
  let v = verifyGrantWithKeys(grant, ctx, await fetchIssuerKeys(), grantVerifyWith);
  if (!v.ok && v.reason === "unknown-key") {
    v = verifyGrantWithKeys(grant, ctx, await fetchIssuerKeys(true), grantVerifyWith);
  }
  return v;
}

async function handleRequest(line: string): Promise<ResponseEnvelope> {
  let req: RequestEnvelope;
  try {
    req = JSON.parse(line);
  } catch {
    return err("", "PARSE_ERROR", "invalid JSON");
  }
  const { id, method, params } = req;
  if (!id || !method) return err(id ?? "", "INVALID_REQUEST", "id and method required");

  // Transit-grant gate: on tcp/vsock, no valid signed grant ⇒ no handler reached.
  const gate = await gateGrant(req);
  if (!gate.ok) return err(id, "UNAUTHORIZED", `signed grant rejected: ${gate.reason}`);

  const handler = METHODS[method];
  if (!handler) return err(id, "UNKNOWN_METHOD", `unknown method: ${method}`);
  try {
    return ok(id, await handler(params ?? {}));
  } catch (e) {
    const error = e as { code?: string; message?: string };
    return err(id, error.code ?? "INTERNAL_ERROR", error.message ?? String(e));
  }
}

// ── Socket server ────────────────────────────────────────────────────────────
const socketHandler = {
  async data(socket: Socket, data: Buffer) {
    for (const line of data.toString().split("\n").filter(Boolean)) {
      socket.write(JSON.stringify(await handleRequest(line)) + "\n");
    }
  },
  open(_socket: Socket) {},
  close(_socket: Socket) {},
  error(_socket: Socket, error: Error) {
    log("ERR", `socket error: ${error}`);
  },
};

async function serveUnix(socketPath: string): Promise<void> {
  const dir = dirname(socketPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  prepareSocket(socketPath);
  log("INFO", `listening on ${socketPath}`);
  Bun.listen({ unix: socketPath, socket: socketHandler });
  await new Promise(() => {});
}

// Bind to 0.0.0.0 so the podman machine VM can reach us via host.containers.internal
async function serveTcp(port: number, host: string = "0.0.0.0"): Promise<void> {
  grantRequired = true; // tcp/vsock has no kernel peer identity ⇒ require a signed grant
  log("INFO", `listening tcp ${host}:${port} (signed-grant gate, fail-closed)`);
  Bun.listen({ hostname: host, port, socket: socketHandler });
  await new Promise(() => {});
}

// ── CLI ──────────────────────────────────────────────────────────────────────
async function main(): Promise<number> {
  const args = Bun.argv.slice(2);
  const cmd = args[0];
  if (cmd === "serve") {
    let socketPath = defaultSocketPath("authd");
    let port: number | undefined;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--socket" || args[i] === "-s") socketPath = args[++i]!;
      else if (args[i] === "--port" || args[i] === "-p") port = Number(args[++i]);
    }
    // Seed from a single JSON credential line on stdin BEFORE listening — a
    // lease requested before this resolves would otherwise race an unseeded
    // store. stdin, never an argv value: an argv value shows up in `ps`.
    //
    // Read chunks and stop at the first newline — NOT `Response(stream).text()`,
    // which buffers until the stream fully CLOSES. That's wrong for a FIFO
    // (`claude-box authd-up`'s detached-daemon path feeds the credential
    // through one): a plain pipe's EOF arrives as soon as the writer closes,
    // but reading a FIFO's whole stream to completion doesn't reliably behave
    // the same way, so `serve` would hang forever after a perfectly good
    // write+close (confirmed live — empty log, never became reachable).
    // Reading only up to the first line is also just more correct: this only
    // ever needs one line, never the writer's full close.
    let line: string | undefined;
    {
      let buf = "";
      const reader = Bun.stdin.stream().getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          line = buf.slice(0, nl).trim();
          break;
        }
      }
      if (line === undefined) line = buf.trim() || undefined;
      reader.releaseLock();
    }
    if (!line) {
      log("ERR", "no credential JSON was piped on stdin (see bellhop's login flow)");
      return 1;
    }
    seedEphemeral(line);
    log("INFO", "credential store seeded from stdin (in-memory only, nothing written to disk)");
    if (port) await serveTcp(port);
    else await serveUnix(socketPath);
    return 0;
  }
  console.log(`authd — Remote Control auth door for claude-box (AUTHD.md, prx-6194)

Usage:
  authd serve                start daemon (foreground, unix socket)
  authd serve --port PORT    listen on TCP (host→VM relay; signed-grant gated,
                             ALWAYS — see AUTHD_ISSUER_KEYS_PATH below)
  authd serve --socket PATH  custom socket path

A single JSON credential line (the ClaudeCredentials shape, from
\`claude-box check-in\`) must be piped on stdin at boot — the refresh token
lives ONLY in this process's memory from then on, gone the instant it exits.
Nothing ever touches disk. A restart requires a fresh login. Portable to any OS.

ROOM_ID=name                 the audience a presented grant must match (the
                              gate checks grant.binding.audience === ROOM_ID).
                              For a direct \`claude-box --remote-serve\` launch
                              (no concierge, no real rooms), this must be the
                              fixed bastion name: ROOM_ID=claude-box-remote-serve.

AUTHD_ISSUER_KEYS_PATH=path   verify tcp grants against a static local
                              IssuerKeys JSON file (see claude-box's
                              lib/box-keys.ts / \`claude-box auth-keys-path\`)
                              instead of a concierge round-trip. Required for
                              a direct \`claude-box --remote-serve\` launch,
                              which isn't concierge-mediated.

Ops (NDJSON): status, lease (access-token-only credential; refresh GUARDED
until AUTHD.md Phase 0 — set AUTHD_REFRESH_LIVE=1). Box identity = signed grant
for door="auth". See AUTHD.md.`);
  return cmd === "-h" || cmd === "--help" ? 0 : 1;
}

// ── Exports for testing ──────────────────────────────────────────────────────
export { handleRequest, handleStatus, handleLease, gateGrant, VERSION };
export function __setGrantRequired(v: boolean): void {
  grantRequired = v;
}
export function __setIssuerKeys(k: IssuerKeys | null): void {
  issuerKeys = k;
}
export function __resetEphemeral(): void {
  ephemeralCred = null;
}
export type { RequestEnvelope, ResponseEnvelope };

if (import.meta.main) {
  process.exit(await main());
}
