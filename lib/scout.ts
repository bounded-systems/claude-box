/**
 * @module
 * scout.ts — in-box client for scoutd
 *
 * A box with the `--scout` door can use this to fetch external content.
 * The box holds no tokens — it asks scoutd to fetch.
 *
 * Usage:
 *   import { fetchPr, fetchIssue, fetchProject, fetchRepo, fetchUrl } from "./lib/scout";
 *
 *   const pr = await fetchPr({ repo: "owner/repo", number: 123 });
 *   console.log(pr.title);
 *
 *   const board = await fetchProject({ org: "bounded-systems", number: 2 });
 *   console.log(board.items.filter((i) => i.fields.Status === "Todo"));
 *
 *   const content = await fetchUrl({ url: "https://..." });
 *   console.log(content.body);
 */

import { heldGrant } from "./concierge.ts";
import { call, DoorCallError } from "../guest-room/protocol.ts";

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

/** Options for fetching a GitHub Projects v2 board via scoutd. */
export type ProjectOptions = {
  /** Org login, e.g. "bounded-systems" */
  org: string;
  /** Project number, e.g. 2 for Front Desk */
  number: number;
  /** Page size (default 50, max 100) */
  first?: number;
  /** Pagination cursor from a previous page's `pageInfo.endCursor` */
  after?: string;
};

/** One item on a Projects v2 board. */
export type ProjectItem = {
  number: number;
  title: string;
  url: string;
  repo: string;
  contentType: "Issue" | "PullRequest";
  state: string;
  /** Custom field values keyed by field name (e.g. Status, Kind, Score). */
  fields: Record<string, string | number>;
};

/** A page of Projects v2 board items fetched via scoutd. */
export type ProjectResult = {
  title: string;
  items: ProjectItem[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
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

/** Get scoutd's connection endpoint — a unix path or a `host:port` TCP
 *  target (either shape parses through call()'s connectTarget). */
function scoutEndpoint(): string {
  // Back-compat: SCOUTD_HOST=host:port is still honored if set explicitly.
  // claude-box itself only ever sets SCOUTD_SOCK, whose value may be a unix
  // path OR a host:port TCP endpoint (TCP mode).
  const tcpHost = process.env.SCOUTD_HOST;
  if (tcpHost) return tcpHost;

  const sockPath = process.env.SCOUTD_SOCK;
  if (sockPath) return sockPath;

  // In-box default: socket at /run/scoutd.sock
  if (Bun.file("/run/scoutd.sock").size !== undefined) return "/run/scoutd.sock";

  // Fallback for testing outside a box
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) return `${runtime}/scoutd.sock`;
  const home = process.env.HOME ?? "/tmp";
  return `${home}/.claude-box/scoutd.sock`;
}

/** Send a request to scoutd and wait for response. */
async function request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  try {
    return await call<T>(scoutEndpoint(), method, params, { grant: heldGrant("scout") });
  } catch (e) {
    if (e instanceof DoorCallError) throw new ScoutError(e.code, e.message);
    throw e;
  }
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
 * Fetch items from a GitHub Projects v2 board (e.g. Front Desk,
 * bounded-systems project #2). Read-only — the box can SEE the board but
 * cannot set Status/Score/etc. through this door (that stays a host-side,
 * App-token write via a lease-token door, e.g. prx's forge-d). The board's
 * own ranked-view sort isn't queryable through this API, so sort `items`
 * client-side (e.g. by `fields.Score`) once fetched.
 *
 * Requires the `--scout` door.
 */
export async function fetchProject(options: ProjectOptions): Promise<ProjectResult> {
  return request<ProjectResult>("project", {
    org: options.org,
    number: options.number,
    first: options.first ?? 50,
    after: options.after,
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
    case "project": {
      const org = args[0];
      const number = parseInt(args[1]);
      if (!org || !number) {
        console.error("usage: scout project <org> <number> [--first N] [--after CURSOR]");
        return 1;
      }
      const firstIdx = args.indexOf("--first");
      const afterIdx = args.indexOf("--after");
      const result = await fetchProject({
        org,
        number,
        first: firstIdx >= 0 ? parseInt(args[firstIdx + 1]) : undefined,
        after: afterIdx >= 0 ? args[afterIdx + 1] : undefined,
      });
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
  scout project <org> <n>    fetch a Projects v2 board (--first, --after)
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
