#!/usr/bin/env bun
/**
 * repod — the repo-materialization daemon for claude-box (the --repod door,
 * prx-8uf2 continuation, 2026-07-03).
 *
 * Owns the ONE thing claude-room must never touch directly: real git access
 * to a host bare repo. claude-room holds NO .git, NO bind-mount of the host
 * repo, and NO git binary capability of its own — it asks repod (over a unix
 * socket, pod-internal, never TCP — no virtiofs crossing since repod and
 * claude-room are co-located sidecars in the SAME pod) for a fresh checkout of
 * a ref, and repod hands back a path under the shared output volume both
 * containers mount. This is the read/write split this session's door
 * architecture already uses (keeperd holds git WRITE credentials, scoutd holds
 * external READ tokens): repod holds git WORKTREE capability, nothing else.
 *
 * repod's own capability is narrow and asymmetric from claude-room's:
 *   - READ-ONLY on the host bare repo (the one bind-mount claude-room never gets).
 *   - READ-WRITE on the shared output volume (where it materializes checkouts;
 *     claude-room also mounts this, read-write, to edit the checked-out files —
 *     but claude-room never sees the bare repo path itself).
 *   - NO network, NO other host paths, NO credentials of any kind. A same-
 *     machine `git worktree add` against a local bare repo needs neither.
 *
 * Wire protocol: one operation, newline-delimited JSON (no framing library
 * needed — a single small request/response per connection, then close):
 *   → {"op":"prepare","ref":"<branch>"}
 *   ← {"ok":true,"path":"<absolute path under REPOD_OUT_DIR>"}
 *   ← {"ok":false,"error":"<message>"}
 *
 * Usage:
 *   repod serve                              # foreground, default socket
 *   repod serve --socket /path.sock          # custom socket path
 *   REPOD_BARE_REPO=/bare-repo REPOD_OUT_DIR=/checkouts repod serve
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Socket } from "bun";

import { defaultSocketPath, prepareSocket, createLogger } from "./lib/runtime";

const log = createLogger("repod");

const BARE_REPO = process.env.REPOD_BARE_REPO;
const OUT_DIR = process.env.REPOD_OUT_DIR ?? "/checkouts";

/** A ref name safe to use as both a git branch/worktree-add argument and a
 *  directory component — rejects anything that could path-traverse or inject
 *  shell/argv syntax (mirrors assertAccount's discipline in claude-box.ts). */
export function assertSafeRef(ref: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.includes("..")) {
    throw new Error(`invalid ref: ${ref}`);
  }
}

function runGit(args: string[], cwd: string): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** Materialize `ref` as a worktree under `outDir`, self-healing a stale/broken
 *  prior registration (mirrors prx's runKeeperEnsureWorktree self-heal, see
 *  packages/prx/src/pr-state/keeper.ts). Idempotent: a healthy existing
 *  worktree is reused, not recreated. Purely local — no network, no SSH, no
 *  credentials — since `bareRepo` is a real bind-mounted bare repo on the same
 *  machine, not a remote. `bareRepo`/`outDir` are injectable (tests point them
 *  at a throwaway fixture); the CLI dispatch below passes the module-level
 *  env-derived defaults. */
export function prepareCheckout(
  ref: string,
  bareRepo: string | undefined,
  outDir: string,
): { ok: true; path: string } | { ok: false; error: string } {
  if (!bareRepo) {
    return { ok: false, error: "repod: REPOD_BARE_REPO not configured" };
  }
  try {
    assertSafeRef(ref);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const target = resolve(join(outDir, ref.replace(/\//g, "__")));

  runGit(["worktree", "prune"], bareRepo);
  const registered = runGit(
    ["worktree", "list", "--porcelain"],
    bareRepo,
  ).stdout.includes(`worktree ${target}`);
  if (registered && existsSync(join(target, ".git"))) {
    return { ok: true, path: target };
  }
  if (registered) {
    runGit(["worktree", "remove", "--force", target], bareRepo);
  }
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
  runGit(["worktree", "prune"], bareRepo);

  const branchExists =
    runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${ref}`], bareRepo).exitCode === 0;
  // repod operates directly on the bare repo (not a clone-with-a-remote), so a
  // new branch's base is the bare repo's OWN default branch — refs/heads/<x>,
  // never origin/<x> (there is no "origin" remote from inside the repo that
  // IS the origin). Derived from HEAD rather than hardcoding "main"/"master".
  const headRef = runGit(["symbolic-ref", "HEAD"], bareRepo).stdout.trim();
  const defaultBranch = headRef.replace(/^refs\/heads\//, "") || "main";
  const addArgs = branchExists
    ? ["worktree", "add", target, ref]
    : ["worktree", "add", "-b", ref, target, defaultBranch];
  const added = runGit(addArgs, bareRepo);
  if (added.exitCode !== 0) {
    return { ok: false, error: `git worktree add failed: ${added.stderr.trim()}` };
  }
  return { ok: true, path: target };
}

type Cx = { buffer: string };

function handleLine(client: Socket<Cx>, line: string): void {
  let req: { op?: string; ref?: string };
  try {
    req = JSON.parse(line);
  } catch {
    client.write(`${JSON.stringify({ ok: false, error: "invalid JSON request" })}\n`);
    client.end();
    return;
  }
  if (req.op !== "prepare" || typeof req.ref !== "string") {
    client.write(`${JSON.stringify({ ok: false, error: "expected {op:'prepare',ref:string}" })}\n`);
    client.end();
    return;
  }
  const result = prepareCheckout(req.ref, BARE_REPO, OUT_DIR);
  if (result.ok) {
    log("INFO", `prepared ${req.ref} -> ${result.path}`);
  } else {
    log("ERR", `prepare ${req.ref} failed: ${result.error}`);
  }
  client.write(`${JSON.stringify(result)}\n`);
  client.end();
}

const handlers = {
  open(client: Socket<Cx>) {
    client.data = { buffer: "" };
  },
  data(client: Socket<Cx>, chunk: Buffer) {
    client.data.buffer += chunk.toString();
    const nl = client.data.buffer.indexOf("\n");
    if (nl === -1) return;
    const line = client.data.buffer.slice(0, nl);
    handleLine(client, line);
  },
  error(client: Socket<Cx>, e: Error) {
    log("ERR", `client ${e}`);
    client.end();
  },
};

function showUsage(): void {
  console.log(`repod — repo-materialization daemon for the claude-box --repod door

Usage:
  repod serve                     start daemon (foreground, unix socket)
  repod serve --socket PATH       custom socket path
  repod help                      show this help

Environment:
  REPOD_SOCK        default unix socket path (fallback: ~/.claude-box/run/repod.sock)
  REPOD_BARE_REPO   path to the host bare repo (read-only mount; required)
  REPOD_OUT_DIR     shared output volume for materialized checkouts (default: /checkouts)
`);
}

const args = Bun.argv.slice(2);
const cmd = args[0];

if (!import.meta.main) {
  // Imported as a module (tests) — skip CLI dispatch.
} else if (cmd === "serve") {
  let socketPath = defaultSocketPath("repod");
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--socket" || args[i] === "-s") socketPath = args[++i]!;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  if (BARE_REPO) {
    // The bare repo is a host bind-mount; its on-disk UID won't match the
    // container's, so git's dubious-ownership guard blocks every operation
    // until explicitly marked safe. repod is the ONE trusted component with
    // real access to it — this is exactly the place that trust should be
    // asserted (mirrors --repo-origin's identical safe.directory call for its
    // own throwaway clone).
    Bun.spawnSync(["git", "config", "--global", "--add", "safe.directory", BARE_REPO]);
  }
  prepareSocket(socketPath);
  Bun.listen<Cx>({ unix: socketPath, socket: handlers });
  log("INFO", `listening unix ${socketPath} bareRepo=${BARE_REPO ?? "(unset)"} outDir=${OUT_DIR}`);
} else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  showUsage();
} else {
  log("ERR", `unknown command "${cmd}"`);
  showUsage();
  process.exit(1);
}
