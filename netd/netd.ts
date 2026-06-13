#!/usr/bin/env bun
/**
 * netd.ts — allowlist-only egress proxy for the claude-box `--net` door.
 *
 * A pinned, nix-native replacement for the squid + socat reference: ONE bun
 * process that enforces a DESTINATION allowlist via HTTP CONNECT, with NO TLS
 * MITM (it only ever sees the host:port of the CONNECT line and tunnels raw
 * bytes — end-to-end TLS is preserved), FAILS CLOSED (anything not allowed →
 * 403), and AUDITS every decision. Contract: ../NETD.md.
 *
 *   nix run .#netd -- serve                     # listen on default socket
 *   nix run .#netd -- serve --socket /path.sock # custom socket path
 *   nix run .#netd -- serve --port 3128         # listen on TCP (for testing)
 *   NETD_ALLOW="api.anthropic.com,.anthropic.com" nix run .#netd -- serve
 *
 * Verify on a host (no container/VM needed):
 *   nix run .#netd -- serve --port 3128 &
 *   curl -x http://127.0.0.1:3128 https://api.anthropic.com   # allowed (tunnels)
 *   curl -x http://127.0.0.1:3128 https://example.com         # 403 (refused)
 *
 * In a pod (prx-zj8) it listens on the shared /run/netd.sock and the box reaches
 * it via the door; the door's host-socket-into-VM mount only works once netd and
 * the box are co-located in one runtime (a host unix socket cannot be bind-
 * mounted into the podman-machine VM on macOS — `statfs: operation not
 * supported`), which is exactly what the pod provides.
 */
import { connect, listen, type Socket } from "bun";
import { unlinkSync, mkdirSync } from "node:fs";

const DEFAULT_ALLOW = ["api.anthropic.com", ".anthropic.com"];

function defaultSocketPath(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) return `${runtime}/netd.sock`;
  const home = process.env.HOME ?? "/tmp";
  // Auto-create ~/.claude-box/run on macOS (no XDG_RUNTIME_DIR)
  const runDir = `${home}/.claude-box/run`;
  try { mkdirSync(runDir, { recursive: true, mode: 0o700 }); } catch {}
  return `${runDir}/netd.sock`;
}

/** Allowlist entry: exact host, or ".suffix" (matches the apex + any subdomain). */
function allowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase();
  return allow.some((a) => (a.startsWith(".") ? h === a.slice(1) || h.endsWith(a) : h === a));
}

function log(decision: "ALLOW" | "DENY" | "ERR" | "INFO", detail: string): void {
  process.stdout.write(`netd ${new Date().toISOString()} ${decision} ${detail}\n`);
}

/** Per-connection state: pre-tunnel header buffer, the upstream socket, tunnel flag. */
type Cx = { head: Uint8Array; up?: Socket<unknown>; tunnel: boolean };

const ALLOW = (process.env.NETD_ALLOW?.split(",").map((s) => s.trim()).filter(Boolean) ?? [])
  .length
  ? process.env.NETD_ALLOW!.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_ALLOW;

/** Parse the CONNECT request head and, if allowed, open the upstream tunnel. */
function onHead(client: Socket<Cx>, headEnd: number): void {
  const text = Buffer.from(client.data.head).toString("latin1");
  const leftover = client.data.head.slice(headEnd + 4); // bytes after \r\n\r\n
  const firstLine = text.slice(0, text.indexOf("\r\n"));
  const [method, target] = firstLine.split(" ");

  if (method !== "CONNECT") {
    log("DENY", `non-CONNECT ${method ?? "?"} ${target ?? ""}`);
    client.write("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
    client.end();
    return;
  }
  const [host, portStr] = (target ?? "").split(":");
  const port = Number(portStr || "443");
  if (!host || !allowed(host, ALLOW)) {
    log("DENY", `${host ?? "?"}:${port}`);
    client.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    client.end();
    return;
  }

  connect({
    hostname: host,
    port,
    socket: {
      open(up) {
        client.data.up = up as Socket<unknown>;
        client.data.tunnel = true;
        log("ALLOW", `${host}:${port}`);
        client.write("HTTP/1.1 200 Connection established\r\n\r\n");
        if (leftover.length) up.write(leftover); // flush any early client bytes
      },
      data(_up, chunk) {
        client.write(chunk);
      },
      close() {
        client.end();
      },
      error(_up, e) {
        log("ERR", `upstream ${host}:${port} ${e}`);
        client.end();
      },
    },
  }).catch((e) => {
    log("ERR", `connect ${host}:${port} ${e}`);
    client.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    client.end();
  });
}

const handlers = {
  open(client: Socket<Cx>) {
    client.data = { head: new Uint8Array(0), tunnel: false };
  },
  data(client: Socket<Cx>, chunk: Uint8Array) {
    if (client.data.tunnel) {
      client.data.up?.write(chunk); // raw passthrough once tunnelled
      return;
    }
    const merged = new Uint8Array(client.data.head.length + chunk.length);
    merged.set(client.data.head);
    merged.set(chunk, client.data.head.length);
    client.data.head = merged;
    const end = Buffer.from(merged).toString("latin1").indexOf("\r\n\r\n");
    if (end !== -1) onHead(client, end);
    else if (merged.length > 16384) client.end(); // oversized head → drop
  },
  close(client: Socket<Cx>) {
    client.data?.up?.end();
  },
  error(client: Socket<Cx>, e: Error) {
    log("ERR", `client ${e}`);
    client.data?.up?.end();
  },
};

// ── CLI ──────────────────────────────────────────────────────────────────────
// Aligned with keeperd/scoutd: `netd serve --socket PATH` (--unix kept as alias).
const args = Bun.argv.slice(2);
const cmd = args[0];

function showUsage(): void {
  console.log(`netd — allowlist egress proxy for the claude-box --net door

Usage:
  netd serve                     start daemon (foreground, unix socket)
  netd serve --port PORT         listen on TCP (for host→VM relay)
  netd serve --socket PATH       custom socket path (--unix is alias)
  netd help                      show this help

Environment:
  NETD_SOCK      default unix socket path (fallback: ~/.claude-box/run/netd.sock)
  NETD_ALLOW     comma-separated allowlist (default: api.anthropic.com,.anthropic.com)
`);
}

if (cmd === "serve") {
  let socketPath = defaultSocketPath();
  let port: number | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--socket" || args[i] === "-s" || args[i] === "--unix") {
      socketPath = args[++i]!;
    } else if (args[i] === "--port") {
      port = Number(args[++i]);
    }
  }
  if (port) {
    listen<Cx>({ hostname: "127.0.0.1", port, socket: handlers });
    log("INFO", `listening tcp 127.0.0.1:${port} allow=${ALLOW.join(",")} (fail-closed)`);
  } else {
    try { unlinkSync(socketPath); } catch {}
    listen<Cx>({ unix: socketPath, socket: handlers });
    log("INFO", `listening unix ${socketPath} allow=${ALLOW.join(",")} (fail-closed)`);
  }
} else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  showUsage();
} else if (cmd === undefined) {
  // Backward compat: no subcommand → serve with legacy flag parsing
  let socketPath = defaultSocketPath();
  let port: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") port = Number(args[++i]);
    else if (args[i] === "--unix" || args[i] === "--socket" || args[i] === "-s") socketPath = args[++i]!;
  }
  if (port) {
    listen<Cx>({ hostname: "127.0.0.1", port, socket: handlers });
    log("INFO", `listening tcp 127.0.0.1:${port} allow=${ALLOW.join(",")} (fail-closed)`);
  } else {
    try { unlinkSync(socketPath); } catch {}
    listen<Cx>({ unix: socketPath, socket: handlers });
    log("INFO", `listening unix ${socketPath} allow=${ALLOW.join(",")} (fail-closed)`);
  }
} else {
  console.error(`netd: unknown command "${cmd}"`);
  showUsage();
  process.exit(1);
}
