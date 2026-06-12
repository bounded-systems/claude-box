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
 *   nix run .#netd                     # listen on $NETD_SOCK or /run/netd.sock
 *   nix run .#netd -- --port 3128      # listen on TCP 127.0.0.1:3128 (host/pod)
 *   NETD_ALLOW="api.anthropic.com,.anthropic.com" nix run .#netd
 *
 * Verify on a host (no container/VM needed):
 *   nix run .#netd -- --port 3128 &
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
import { unlinkSync } from "node:fs";

const DEFAULT_ALLOW = ["api.anthropic.com", ".anthropic.com"];

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
let unix = process.env.NETD_SOCK || "/run/netd.sock";
let port: number | undefined;
const argv = Bun.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--port") port = Number(argv[++i]);
  else if (argv[i] === "--unix") unix = argv[++i]!;
}

if (port) {
  listen<Cx>({ hostname: "127.0.0.1", port, socket: handlers });
  log("INFO", `listening tcp 127.0.0.1:${port} allow=${ALLOW.join(",")} (fail-closed)`);
} else {
  try {
    unlinkSync(unix);
  } catch {}
  listen<Cx>({ unix, socket: handlers });
  log("INFO", `listening unix ${unix} allow=${ALLOW.join(",")} (fail-closed)`);
}
