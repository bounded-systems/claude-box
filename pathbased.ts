#!/usr/bin/env bun
/**
 * pathbased — the Pathbase broker daemon for claude-box (the `pathbase` door,
 * `--pathbase`/`--door pathbase`).
 *
 * Listens on a unix socket, execs the operator's OWN already-authenticated
 * `path` binary (toolpath's CLI) on the box's behalf for exactly three
 * effects: whoami, export (push a document to Pathbase), import (pull one).
 *
 * The box never holds a Pathbase session token — it only asks. pathbased
 * holds the session on the HOST (wherever `$HOME/.toolpath` resolves for the
 * operator running this daemon, populated by a one-time, out-of-box `path
 * auth login`) and performs the actual authenticated call itself. This is
 * the keeperd pattern (broker performs the discrete effect), not authd's
 * (lease a scoped credential into the box) — see PATHBASED.md for why that
 * distinction matters here.
 *
 * Usage:
 *   pathbased serve                     # foreground, default socket
 *   pathbased serve --socket /path.sock # custom socket path
 *   pathbased serve --bin /path/to/path # override the `path` binary to exec
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createPublicKey, verify as edVerify } from "node:crypto";
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

const log = createLogger("pathbased");

const VERSION = "0.1.0";

// The `path` binary to exec. PATHBASED_BIN overrides for tests / a non-PATH
// install; otherwise resolved from PATH exactly like an operator typing
// `path` themselves — no bundled copy, no version pin here (toolpath's own
// release cadence is out of scope for this door).
function pathBin(): string {
  return process.env.PATHBASED_BIN || "path";
}

// ── path CLI exec ────────────────────────────────────────────────────────────
// pathbased's only real logic: run a FIXED, narrow `path` invocation as a host
// subprocess and relay its stdout/exit code. No box-supplied string is ever
// interpolated into a shell — argv is an array (execve, not a shell line), and
// a document body travels via a temp FILE path in argv, never concatenated.

async function execPath(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn([pathBin(), ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

// ── whoami parsing ───────────────────────────────────────────────────────────
// `path auth whoami` (cmd_auth.rs, path-cli 0.14.0) prints, on success:
//   <username> (<id>)
//   email: <email>        (optional line)
//   server: <url>
// and exits non-zero with "Error: Not logged in. Run `path auth login`." (or
// similar) otherwise. This is plain-text CLI output, not a stable wire
// contract — parsing is best-effort; `raw` always carries the untouched text
// so a format drift degrades to "less structured," never to a wrong answer.
function parseWhoami(stdout: string): { user?: string; id?: string; email?: string; server?: string } {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const result: { user?: string; id?: string; email?: string; server?: string } = {};
  const first = lines[0]?.match(/^(.+) \(([^()]+)\)$/);
  if (first) {
    result.user = first[1];
    result.id = first[2];
  }
  for (const line of lines.slice(1)) {
    const email = line.match(/^email:\s*(.+)$/);
    if (email) result.email = email[1];
    const server = line.match(/^server:\s*(.+)$/);
    if (server) result.server = server[1];
  }
  return result;
}

// ── Method handlers ──────────────────────────────────────────────────────────

const startedAt = new Date();

async function handleStatus(_params: Record<string, unknown>): Promise<unknown> {
  const who = await execPath(["auth", "whoami"]);
  return {
    version: VERSION,
    uptime: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    loggedIn: who.code === 0,
  };
}

async function handleWhoami(_params: Record<string, unknown>): Promise<unknown> {
  const r = await execPath(["auth", "whoami"]);
  if (r.code !== 0) {
    throw { code: "NOT_LOGGED_IN", message: r.stderr.trim() || "not logged in — run `path auth login` on the host" };
  }
  return { raw: r.stdout.trim(), ...parseWhoami(r.stdout) };
}

/** Export a toolpath document to Pathbase. The document travels as a JSON
 *  param and is staged to a throwaway temp file — `export pathbase --input`
 *  accepts a cache id OR a path to a toolpath JSON file (cmd_export.rs), and
 *  a temp file needs no shared cache between the box and this daemon. */
async function handleExport(params: Record<string, unknown>): Promise<unknown> {
  const document = params.document;
  if (!document || typeof document !== "object") {
    throw { code: "INVALID_PARAMS", message: "document (object) required" };
  }
  const dir = mkdtempSync(join(tmpdir(), "pathbased-export-"));
  const file = join(dir, "document.json");
  try {
    writeFileSync(file, JSON.stringify(document));
    const args = ["p", "export", "pathbase", "--input", file];
    if (typeof params.repo === "string") args.push("--repo", params.repo);
    if (typeof params.name === "string") args.push("--name", params.name);
    if (params.public === true) args.push("--public");
    if (typeof params.url === "string") args.push("--url", params.url);
    const r = await execPath(args);
    if (r.code !== 0) {
      throw { code: "EXPORT_FAILED", message: r.stderr.trim() || `path exited ${r.code}` };
    }
    const url = r.stdout.trim();
    log("ALLOW", `export → ${url}`);
    return { url };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Import a toolpath document from Pathbase. `--no-cache` makes `path` print
 *  the document JSON straight to stdout instead of only writing the cache
 *  (cmd_import.rs's shared `run()`), so pathbased never touches a cache path
 *  shared with the box. */
async function handleImport(params: Record<string, unknown>): Promise<unknown> {
  const ref = params.ref;
  if (typeof ref !== "string" || !ref) {
    throw { code: "INVALID_PARAMS", message: "ref (string) required" };
  }
  const args = ["p", "import", "pathbase", ref, "--no-cache"];
  if (typeof params.url === "string") args.push("--url", params.url);
  const r = await execPath(args);
  if (r.code !== 0) {
    throw { code: "IMPORT_FAILED", message: r.stderr.trim() || `path exited ${r.code}` };
  }
  let document: unknown;
  try {
    document = JSON.parse(r.stdout);
  } catch {
    throw { code: "PARSE_ERROR", message: "path printed non-JSON output" };
  }
  log("ALLOW", `import ← ${ref}`);
  return { document };
}

type PathbasedMethodHandler = (params: Record<string, unknown>) => Promise<unknown>;

const METHODS: Record<string, PathbasedMethodHandler> = {
  status: handleStatus,
  whoami: handleWhoami,
  export: handleExport,
  import: handleImport,
};

// ── Transit-grant gate (tcp/vsock only) ──────────────────────────────────────
// Same shape as scoutd/keeperd: a unix door's held reference IS authority (no
// per-request check); tcp/vsock has no kernel peer identity, so a caller must
// present a signed grant the concierge minted, verified against the
// concierge's published keys. See CONCIERGE.md §7.
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

const verifyWith = (data: string, signature: string, publicKeyPem: string): boolean =>
  edVerify(null, Buffer.from(data), createPublicKey(publicKeyPem), Buffer.from(signature, "base64"));

async function gateGrant(req: RequestEnvelope): Promise<{ ok: boolean; reason?: string }> {
  if (!grantRequired) return { ok: true }; // unix: reference is authority
  const grant = req.grant;
  if (!grant) return { ok: false, reason: "no-grant" };
  if (grant.name !== "pathbase") return { ok: false, reason: "wrong-door" };
  const ctx = { audience: process.env.ROOM_ID ?? "", now: Date.now() };
  let v = verifyGrantWithKeys(grant, ctx, await fetchIssuerKeys(), verifyWith);
  if (!v.ok && v.reason === "unknown-key") {
    v = verifyGrantWithKeys(grant, ctx, await fetchIssuerKeys(true), verifyWith); // rotation
  }
  return v;
}

// ── Request handling ─────────────────────────────────────────────────────────

async function handleRequest(line: string): Promise<ResponseEnvelope> {
  let req: RequestEnvelope;
  try {
    req = JSON.parse(line);
  } catch {
    return err("", "PARSE_ERROR", "invalid JSON");
  }

  const { id, method, params } = req;
  if (!id || !method) {
    return err(id ?? "", "INVALID_REQUEST", "id and method required");
  }

  const gate = await gateGrant(req);
  if (!gate.ok) {
    return err(id, "UNAUTHORIZED", `signed grant rejected: ${gate.reason}`);
  }

  const handler = METHODS[method];
  if (!handler) {
    return err(id, "UNKNOWN_METHOD", `unknown method: ${method}`);
  }

  try {
    const result = await handler(params ?? {});
    return ok(id, result);
  } catch (e) {
    const error = e as { code?: string; message?: string };
    return err(id, error.code ?? "INTERNAL_ERROR", error.message ?? String(e));
  }
}

// ── Socket server ────────────────────────────────────────────────────────────

const socketHandler = {
  async data(socket: Socket, data: Buffer) {
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      const resp = await handleRequest(line);
      socket.write(JSON.stringify(resp) + "\n");
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
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  prepareSocket(socketPath);
  log("INFO", `listening unix ${socketPath}`);

  Bun.listen({
    unix: socketPath,
    socket: socketHandler,
  });

  await new Promise(() => {});
}

// Bind to 0.0.0.0 so podman machine VM can reach us via host.containers.internal
async function serveTcp(port: number, host: string = "0.0.0.0"): Promise<void> {
  grantRequired = true;
  log("INFO", `listening tcp ${host}:${port} (signed-grant gate, fail-closed)`);

  Bun.listen({
    hostname: host,
    port,
    socket: socketHandler,
  });

  await new Promise(() => {});
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = Bun.argv.slice(2);
  const cmd = args[0];

  if (cmd === "serve") {
    let socketPath = defaultSocketPath("pathbased");
    let port: number | undefined;

    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--socket" || args[i] === "-s") {
        socketPath = args[++i]!;
      } else if (args[i] === "--port" || args[i] === "-p") {
        port = Number(args[++i]);
      } else if (args[i] === "--bin") {
        process.env.PATHBASED_BIN = args[++i]!;
      }
    }

    if (port) {
      await serveTcp(port);
    } else {
      await serveUnix(socketPath);
    }
    return 0;
  }

  console.log(`pathbased — Pathbase broker daemon for claude-box

Usage:
  pathbased serve                     start daemon (foreground, unix socket)
  pathbased serve --port PORT         listen on TCP (for testing / host→VM relay)
  pathbased serve --socket PATH       custom socket path
  pathbased serve --bin PATH          override the \`path\` binary to exec

The daemon listens for NDJSON requests:
  - status      health check (+ whether the host session is logged in)
  - whoami      the logged-in Pathbase user (never the token itself)
  - export      push a toolpath document to Pathbase; returns its URL
  - import      pull a toolpath document from Pathbase by ref

Environment:
  PATHBASED_SOCK   default unix socket path
  PATHBASED_BIN    the \`path\` binary to exec (default: resolved from PATH)

The box never holds a Pathbase session — pathbased execs the operator's own,
already-logged-in \`path\` binary on the host. See PATHBASED.md.`);

  return cmd === "-h" || cmd === "--help" ? 0 : 1;
}

// ── Exports for testing ──────────────────────────────────────────────────────

export {
  handleRequest,
  handleStatus,
  handleWhoami,
  handleExport,
  handleImport,
  parseWhoami,
  execPath,
  gateGrant,
  socketHandler,
  VERSION,
};

/** Test seams: drive the tcp/vsock grant gate without a live concierge. */
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
