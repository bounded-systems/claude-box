/**
 * @module
 * scout.ts — in-box client for scoutd
 *
 * A box with the `--scout` door can use this to fetch external content.
 * The box holds no tokens — it asks scoutd to fetch.
 *
 * Usage:
 *   import { fetchPr, fetchIssue, fetchRepo, fetchUrl } from "./lib/scout";
 *
 *   const pr = await fetchPr({ repo: "owner/repo", number: 123 });
 *   console.log(pr.title);
 *
 *   const content = await fetchUrl({ url: "https://..." });
 *   console.log(content.body);
 */

// Bun.connect via the global (no `import … from "bun"`) so the package resolves
// on JSR/Deno publish — the same way the guest-room protocol uses Bun globals.
const connect = Bun.connect;

import { heldGrant } from "./concierge.ts";
import type { SignedGrant } from "../guest-room/mod.ts";

// ── Types ────────────────────────────────────────────────────────────────────

/** Options for fetching repository metadata via scoutd. */
export type RepoOptions = {
  /** GitHub repo URL or owner/repo */
  url: string;
  /** Git ref (default: HEAD) */
  ref?: string;
};

/** Repository metadata fetched via scoutd. */
export type RepoResult = {
  owner: string;
  repo: string;
  ref: string;
  defaultBranch: string;
  description: string | null;
  tarballUrl: string;
};

/** Options for fetching a pull request via scoutd. */
export type PrOptions = {
  /** GitHub repo (owner/repo or URL) */
  repo: string;
  /** PR number */
  number: number;
  /** Include diff */
  diff?: boolean;
  /** Include review comments */
  comments?: boolean;
};

/** Pull request details fetched via scoutd. */
export type PrResult = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  diff?: string;
  comments?: Array<{
    user: string;
    body: string;
    path?: string;
    createdAt: string;
  }>;
};

/** Options for fetching a GitHub issue via scoutd. */
export type IssueOptions = {
  /** GitHub repo (owner/repo or URL) */
  repo: string;
  /** Issue number */
  number: number;
  /** Include comments */
  comments?: boolean;
};

/** GitHub issue details fetched via scoutd. */
export type IssueResult = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  comments?: Array<{
    user: string;
    body: string;
    createdAt: string;
  }>;
};

/** Options for fetching a URL via scoutd. */
export type FetchOptions = {
  /** URL to fetch */
  url: string;
  /** Return as base64 (for binary) */
  binary?: boolean;
  /** Max size in bytes (default 10MB) */
  maxSize?: number;
};

/** Response from fetching a URL via scoutd. */
export type FetchResult = {
  url: string;
  status: number;
  contentType: string | null;
  size: number;
  body: string;
};

/** Options for downloading a file via scoutd. */
export type DownloadOptions = {
  /** URL to download */
  url: string;
  /** Max size in bytes (default 100MB) */
  maxSize?: number;
};

/** Downloaded file content via scoutd (base64 encoded). */
export type DownloadResult = {
  url: string;
  size: number;
  contentType: string | null;
  sha256: string;
  data: string; // base64
};

/** Health and status information from scoutd. */
export type ScoutStatus = {
  version: string;
  uptime: number;
  hasToken: boolean;
  allowlist: string[];
};

/** Error from scoutd operations, with an error code for pattern matching. */
export class ScoutError extends Error {
  /** Machine-readable error code for pattern matching. */
  code: string;
  /** Create a ScoutError with a `code` and human-readable `message`. */
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ScoutError";
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

type ScoutTarget =
  | { type: "unix"; path: string }
  | { type: "tcp"; host: string; port: number };

/** Get scoutd connection target from environment or default. */
function getTarget(): ScoutTarget {
  // TCP mode: SCOUTD_HOST=host:port
  const tcpHost = process.env.SCOUTD_HOST;
  if (tcpHost) {
    const [host, portStr] = tcpHost.split(":");
    return { type: "tcp", host: host || "127.0.0.1", port: Number(portStr) || 3129 };
  }

  // Unix socket mode: SCOUTD_SOCK=/path/to/socket
  const sockPath = process.env.SCOUTD_SOCK;
  if (sockPath) return { type: "unix", path: sockPath };

  // In-box default: socket at /run/scoutd.sock
  if (Bun.file("/run/scoutd.sock").size !== undefined) {
    return { type: "unix", path: "/run/scoutd.sock" };
  }

  // Fallback for testing outside a box
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) return { type: "unix", path: `${runtime}/scoutd.sock` };
  const home = process.env.HOME ?? "/tmp";
  return { type: "unix", path: `${home}/.claude-box/scoutd.sock` };
}

type RequestEnvelope = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
  /** The signed grant this box holds for "scout", presented so a tcp/vsock
   *  serving room can verify it (no-op on a unix door). */
  grant?: SignedGrant;
};

type ResponseEnvelope = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

/** Send a request to scoutd and wait for response. */
async function request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const target = getTarget();
  const id = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    let buffer = "";
    let resolved = false;

    const socketHandler = {
      open(sock: ReturnType<typeof connect> extends Promise<infer S> ? S : never) {
        const grant = heldGrant("scout"); // present it iff resolved (tcp/vsock gate)
        const req: RequestEnvelope = { id, method, params, ...(grant ? { grant } : {}) };
        sock.write(JSON.stringify(req) + "\n");
      },
      data(sock: ReturnType<typeof connect> extends Promise<infer S> ? S : never, data: Buffer) {
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
              reject(new ScoutError(
                resp.error?.code ?? "UNKNOWN",
                resp.error?.message ?? "scoutd error"
              ));
            }
          } catch (e) {
            reject(new ScoutError("PARSE_ERROR", "invalid response from scoutd"));
          }
        }
      },
      error(_sock: unknown, err: Error) {
        if (!resolved) {
          resolved = true;
          reject(new ScoutError("CONNECTION_ERROR", `failed to connect to scoutd: ${err}`));
        }
      },
      close() {
        if (!resolved) {
          resolved = true;
          reject(new ScoutError("CONNECTION_CLOSED", "connection closed before response"));
        }
      },
    };

    const connectPromise = target.type === "unix"
      ? connect({ unix: target.path, socket: socketHandler })
      : connect({ hostname: target.host, port: target.port, socket: socketHandler });

    connectPromise.catch((err) => {
      if (!resolved) {
        resolved = true;
        reject(new ScoutError("CONNECTION_ERROR", `failed to connect to scoutd: ${err}`));
      }
    });
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch a GitHub repository's metadata.
 *
 * Requires the `--scout` door. The box holds no tokens — scoutd fetches.
 */
export async function fetchRepo(options: RepoOptions): Promise<RepoResult> {
  return request<RepoResult>("repo", {
    url: options.url,
    ref: options.ref,
  });
}

/**
 * Fetch a GitHub PR.
 *
 * Requires the `--scout` door.
 */
export async function fetchPr(options: PrOptions): Promise<PrResult> {
  return request<PrResult>("pr", {
    repo: options.repo,
    number: options.number,
    diff: options.diff ?? false,
    comments: options.comments ?? false,
  });
}

/**
 * Fetch a GitHub issue.
 *
 * Requires the `--scout` door.
 */
export async function fetchIssue(options: IssueOptions): Promise<IssueResult> {
  return request<IssueResult>("issue", {
    repo: options.repo,
    number: options.number,
    comments: options.comments ?? false,
  });
}

/**
 * Fetch a URL (allowlist enforced).
 *
 * Requires the `--scout` door.
 */
export async function fetchUrl(options: FetchOptions): Promise<FetchResult> {
  return request<FetchResult>("fetch", {
    url: options.url,
    binary: options.binary ?? false,
    maxSize: options.maxSize,
  });
}

/**
 * Download file content (base64 encoded).
 *
 * Requires the `--scout` door.
 */
export async function download(options: DownloadOptions): Promise<DownloadResult> {
  return request<DownloadResult>("download", {
    url: options.url,
    maxSize: options.maxSize,
  });
}

/**
 * Get scoutd status (health check).
 */
export async function status(): Promise<ScoutStatus> {
  return request<ScoutStatus>("status");
}

/**
 * Check if scoutd is reachable.
 */
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
    case "repo": {
      const url = args[0];
      if (!url) {
        console.error("usage: scout repo <owner/repo>");
        return 1;
      }
      const result = await fetchRepo({ url, ref: args[1] });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    case "pr": {
      const repo = args[0];
      const number = parseInt(args[1]);
      if (!repo || !number) {
        console.error("usage: scout pr <owner/repo> <number>");
        return 1;
      }
      const result = await fetchPr({ repo, number, diff: args.includes("--diff"), comments: args.includes("--comments") });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    case "issue": {
      const repo = args[0];
      const number = parseInt(args[1]);
      if (!repo || !number) {
        console.error("usage: scout issue <owner/repo> <number>");
        return 1;
      }
      const result = await fetchIssue({ repo, number, comments: args.includes("--comments") });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    case "fetch": {
      const url = args[0];
      if (!url) {
        console.error("usage: scout fetch <url>");
        return 1;
      }
      const result = await fetchUrl({ url });
      console.log(result.body);
      return 0;
    }
    default:
      console.log(`scout — in-box client for scoutd

Usage:
  scout status               show scoutd status
  scout repo <owner/repo>    fetch repo metadata
  scout pr <repo> <n>        fetch PR (--diff, --comments)
  scout issue <repo> <n>     fetch issue (--comments)
  scout fetch <url>          fetch URL content

This command only works inside a box with the --scout door.`);
      return cmd === "-h" || cmd === "--help" ? 0 : 1;
  }
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (e) {
    if (e instanceof ScoutError) {
      console.error(`error: ${e.code}: ${e.message}`);
    } else {
      console.error(`error: ${e}`);
    }
    process.exit(1);
  }
}
