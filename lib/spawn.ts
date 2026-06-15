/**
 * spawn.ts — in-box client for launcherd
 *
 * A box with the `--launcher` door can use this to spawn sub-boxes.
 * The box holds no podman, no runtime — it asks launcherd to spawn.
 *
 * Usage:
 *   import { spawn, SpawnOptions } from "./lib/spawn";
 *
 *   const result = await spawn({
 *     room: "dev",
 *     repo: "/work",
 *     doors: ["keeper", "net"],
 *   });
 *   console.log(`Spawned ${result.launchId} (pid ${result.pid})`);
 */

import { connect } from "bun";

// ── Types ────────────────────────────────────────────────────────────────────

export type SpawnOptions = {
  /** Account name (default: "personal") */
  account?: string;
  /** Room preset (e.g., "dev", "readonly") */
  room?: string;
  /** Repo path to mount (host path) */
  repo?: string;
  /** Mount repo with .git writable (unsafe) */
  repoRw?: boolean;
  /** Doors to grant (by name) */
  doors?: string[];
  /** Ambient egress (unsafe, no allowlist) */
  netOpen?: boolean;
  /** Args to pass through to claude */
  claudeArgs?: string[];
  /** Spawn depth (auto-incremented from current box) */
  depth?: number;
};

export type SpawnResult = {
  launchId: string;
  pid: number;
  manifest: {
    account: string;
    repo?: string;
    doors: string[];
    denied: string[];
    netOpen: boolean;
  };
  attestation?: {
    statementDigest: string;
    signature: string;
    keyId: string;
  };
};

export type LauncherdStatus = {
  version: string;
  uptime: number;
  launches: number;
  signing: { enabled: boolean; keyId?: string };
  policy: {
    enabled: boolean;
    defaultAllow?: string[];
    rulesCount?: number;
    maxConcurrent?: number | null;
    maxDepth?: number;
    rateLimit?: { window: number; max: number } | null;
  };
  doors: Record<string, { socket: string; reachable: boolean }>;
  rooms: Record<string, string>;
};

export type BoxInfo = {
  launchId: string;
  account: string;
  pid: number;
  startedAt: string;
  doors: string[];
  repo?: string;
  depth: number;
  status: "running" | "exited";
};

export class LauncherdError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "LauncherdError";
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

/** Get the launcherd socket path from environment or default. */
function getSocketPath(): string {
  // In-box: the socket is mounted at /run/launcherd.sock
  const envPath = process.env.LAUNCHERD_SOCK;
  if (envPath) return envPath;

  // Fallback for testing outside a box
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) return `${runtime}/launcherd.sock`;
  const home = process.env.HOME ?? "/tmp";
  return `${home}/.claude-box/launcherd.sock`;
}

/** Get current spawn depth from environment (set by launcherd in the manifest). */
export function getCurrentDepth(): number {
  const caps = process.env.CLAUDE_BOX_CAPABILITIES;
  if (!caps) return 0;
  try {
    const parsed = JSON.parse(caps);
    return parsed.depth ?? 0;
  } catch {
    return 0;
  }
}

type RequestEnvelope = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

type ResponseEnvelope = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

/** Send a request to launcherd and wait for response. */
async function request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const socketPath = getSocketPath();
  const id = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    let buffer = "";
    let resolved = false;

    connect({
      unix: socketPath,
      socket: {
        open(sock) {
          const req: RequestEnvelope = { id, method, params };
          sock.write(JSON.stringify(req) + "\n");
        },
        data(sock, data) {
          buffer += data.toString();
          const newline = buffer.indexOf("\n");
          if (newline >= 0 && !resolved) {
            resolved = true;
            const line = buffer.slice(0, newline);
            sock.end();
            try {
              const resp = JSON.parse(line) as ResponseEnvelope;
              if (resp.ok) {
                resolve(resp.result as T);
              } else {
                reject(new LauncherdError(
                  resp.error?.code ?? "UNKNOWN",
                  resp.error?.message ?? "launcherd error"
                ));
              }
            } catch (e) {
              reject(new LauncherdError("PARSE_ERROR", "invalid response from launcherd"));
            }
          }
        },
        error(_sock, err) {
          if (!resolved) {
            resolved = true;
            reject(new LauncherdError("CONNECTION_ERROR", `failed to connect to launcherd: ${err}`));
          }
        },
        close() {
          if (!resolved) {
            resolved = true;
            reject(new LauncherdError("CONNECTION_CLOSED", "connection closed before response"));
          }
        },
      },
    }).catch((err) => {
      if (!resolved) {
        resolved = true;
        reject(new LauncherdError("CONNECTION_ERROR", `failed to connect to launcherd: ${err}`));
      }
    });
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Spawn a sub-box via launcherd.
 *
 * Requires the `--launcher` door. The box holds no podman — this is a request
 * to launcherd, which owns the runtime and enforces policy.
 *
 * The spawn depth is automatically incremented from the current box's depth.
 */
export async function spawn(options: SpawnOptions = {}): Promise<SpawnResult> {
  const currentDepth = getCurrentDepth();

  const params: Record<string, unknown> = {
    account: options.account ?? "personal",
    room: options.room,
    repo: options.repo,
    repoRw: options.repoRw ?? false,
    doors: options.doors ?? [],
    netOpen: options.netOpen ?? false,
    claudeArgs: options.claudeArgs ?? [],
    depth: (options.depth ?? currentDepth) + 1,  // Increment depth
  };

  return request<SpawnResult>("launch", params);
}

/** Get launcherd status (health, doors, policy, etc.). */
export async function status(): Promise<LauncherdStatus> {
  return request<LauncherdStatus>("status");
}

/** List running boxes. */
export async function list(account?: string): Promise<{ launches: BoxInfo[] }> {
  return request<{ launches: BoxInfo[] }>("list", account ? { account } : {});
}

/** Kill a running box. */
export async function kill(launchId: string, signal?: string): Promise<{ killed: boolean }> {
  return request<{ killed: boolean }>("kill", { launchId, signal });
}

/** Get attach command for a running box. */
export async function attach(launchId: string): Promise<{
  launchId: string;
  container: string;
  command: string;
  hint: string;
}> {
  return request("attach", { launchId });
}

/** List available rooms. */
export async function rooms(): Promise<{
  rooms: Record<string, { doors: string[]; netOpen: boolean; description: string }>;
}> {
  return request("rooms");
}

/** Check if launcherd is reachable. */
export async function isAvailable(): Promise<boolean> {
  try {
    await status();
    return true;
  } catch {
    return false;
  }
}

// ── CLI (for testing) ────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const [cmd, ...args] = Bun.argv.slice(2);

  switch (cmd) {
    case "status": {
      const s = await status();
      console.log(JSON.stringify(s, null, 2));
      return 0;
    }
    case "list":
    case "ps": {
      const result = await list();
      if (result.launches.length === 0) {
        console.log("no running boxes");
      } else {
        console.log("LAUNCH ID                    ACCOUNT     DEPTH  STATUS");
        for (const l of result.launches) {
          console.log(`${l.launchId.padEnd(28)} ${l.account.padEnd(11)} ${String(l.depth).padEnd(6)} ${l.status}`);
        }
      }
      return 0;
    }
    case "spawn": {
      const room = args[0];
      if (!room) {
        console.error("usage: spawn <room> [--repo PATH]");
        return 1;
      }
      const repoIdx = args.indexOf("--repo");
      const repo = repoIdx >= 0 ? args[repoIdx + 1] : undefined;
      const result = await spawn({ room, repo });
      console.log(`spawned ${result.launchId} (pid ${result.pid})`);
      return 0;
    }
    case "kill": {
      const launchId = args[0];
      if (!launchId) {
        console.error("usage: spawn kill <launch-id>");
        return 1;
      }
      await kill(launchId);
      console.log(`killed ${launchId}`);
      return 0;
    }
    case "rooms": {
      const r = await rooms();
      for (const [name, info] of Object.entries(r.rooms)) {
        console.log(`${name}: ${info.description}`);
        console.log(`  doors: ${info.doors.join(", ") || "(none)"}`);
        if (info.netOpen) console.log("  netOpen: true");
      }
      return 0;
    }
    default:
      console.log(`spawn — in-box client for launcherd

Usage:
  spawn status              show launcherd status
  spawn ps                  list running boxes
  spawn <room>              spawn a sub-box with room preset
  spawn <room> --repo PATH  spawn with repo mounted
  spawn kill <id>           kill a running box
  spawn rooms               list available rooms

This command only works inside a box with the --launcher door.`);
      return cmd === "-h" || cmd === "--help" ? 0 : 1;
  }
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (e) {
    if (e instanceof LauncherdError) {
      console.error(`error: ${e.code}: ${e.message}`);
    } else {
      console.error(`error: ${e}`);
    }
    process.exit(1);
  }
}
