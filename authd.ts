#!/usr/bin/env bun
/**
 * authd — the Remote Control auth door for claude-box (spec: AUTHD.md, prx-6194).
 *
 * A box with `--remote-control` needs the user's full-scope claude.ai OAuth login
 * to drive a Remote Control session, but must NOT *hold* it. authd owns the
 * refresh token host-side (from op via AUTHD_OP_REF) and lends the box only a
 * short-lived, ACCESS-TOKEN-ONLY credential — never the refresh token. It is a
 * keeperd sibling: the box proves who it is the same way it does at every other
 * door — a concierge-minted SIGNED GRANT, here scoped to door="auth" (the
 * door-model identity unification, prx-6194). authd→Anthropic is OAuth2
 * refresh_token (the broker holds the one standing secret).
 *
 *   authd serve                  # unix socket (mount = authority)
 *   authd serve --port 3003      # tcp (host→VM relay; signed-grant gated)
 *
 * SCAFFOLD STATUS (Phase 1): the live OAuth refresh is GUARDED behind
 * AUTHD_REFRESH_LIVE=1 — AUTHD.md Phase 0 must confirm the refresh spec + the
 * continuity behaviour first-hand before it goes live (a live rotation is
 * single-use and would invalidate the in-use token). This module is the door +
 * identity + lease scaffold; it does NOT yet make the box credential-free
 * (AUTHD.md: that is Phase 2).
 */

import { existsSync, mkdirSync } from "node:fs";
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
}

/** Strip the refreshToken: the box gets an ACCESS-TOKEN-ONLY credential it can
 *  run RC on but never refresh (validated in the spike — access-token-only runs
 *  RC). Pure. */
export function toAccessTokenOnly(creds: ClaudeCredentials): ClaudeCredentials {
  const { refreshToken: _dropped, ...rest } = creds.claudeAiOauth;
  return { claudeAiOauth: { ...rest } };
}

// ── OAuth2 refresh (authd → Anthropic) ───────────────────────────────────────
// AUTHD.md Risk #2: the endpoint / client_id / whether PKCE is required ON REFRESH
// are community-sourced and must be CONFIRMED FIRST-HAND (Phase 0) before this is
// enabled — a live rotation is single-use and would invalidate the in-use token,
// so do NOT verify by triggering one. `fetchImpl` is injectable so tests mock it.
const TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";

export async function refreshAccessToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ creds: ClaudeCredentials; rotatedRefreshToken: string }> {
  // [Phase 0 GATE] The spec is unconfirmed, so a live refresh stays OFF unless the
  // operator opts in after confirming it — a misconfigured launch must not rotate
  // a live token. (Tests pass a fetchImpl AND set the flag; production waits on Phase 0.)
  if (process.env.AUTHD_REFRESH_LIVE !== "1") {
    throw {
      code: "REFRESH_GATED",
      message: "live OAuth refresh disabled until AUTHD.md Phase 0 confirms the spec (set AUTHD_REFRESH_LIVE=1)",
    };
  }
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) throw { code: "REFRESH_FAILED", message: `token endpoint returned ${res.status}` };
  const body = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
  };
  const creds: ClaudeCredentials = {
    claudeAiOauth: {
      accessToken: body.access_token,
      refreshToken: body.refresh_token, // kept host-side; stripped before the box sees it
      expiresAt: Date.now() + body.expires_in * 1000,
      scopes: body.scope?.split(" ") ?? [],
    },
  };
  return { creds, rotatedRefreshToken: body.refresh_token };
}

/** Read the host-owned refresh token from op (AUTHD_OP_REF = op://vault/item/field).
 *  The ref is config, never a host path in code (AUTHD.md §Config). */
async function readRefreshToken(): Promise<string> {
  const ref = process.env.AUTHD_OP_REF;
  if (!ref) throw { code: "NO_OP_REF", message: "AUTHD_OP_REF unset (expected op://vault/item/field)" };
  const proc = Bun.spawn(["op", "read", ref], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (proc.exitCode !== 0 || !out) throw { code: "OP_READ_FAILED", message: `op read ${ref} failed` };
  return out;
}

// ── Ops ──────────────────────────────────────────────────────────────────────
async function handleStatus(): Promise<unknown> {
  return { status: "ok", version: VERSION, since: startedAt.toISOString(), refreshLive: process.env.AUTHD_REFRESH_LIVE === "1" };
}

/** lease: refresh the access token (rotating the host-side refresh token) and
 *  return an ACCESS-TOKEN-ONLY credential for the box. Persisting the rotated
 *  refresh token back to op (sole-writer rotation chain) is Phase 2. */
async function handleLease(): Promise<unknown> {
  const refreshToken = await readRefreshToken();
  const { creds } = await refreshAccessToken(refreshToken);
  return toAccessTokenOnly(creds);
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
async function fetchIssuerKeys(force = false): Promise<IssuerKeys> {
  if (issuerKeys && !force) return issuerKeys;
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
    if (port) await serveTcp(port);
    else await serveUnix(socketPath);
    return 0;
  }
  console.log(`authd — Remote Control auth door for claude-box (AUTHD.md, prx-6194)

Usage:
  authd serve                start daemon (foreground, unix socket)
  authd serve --port PORT    listen on TCP (host→VM relay; signed-grant gated)
  authd serve --socket PATH  custom socket path

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
export type { RequestEnvelope, ResponseEnvelope };

if (import.meta.main) {
  process.exit(await main());
}
