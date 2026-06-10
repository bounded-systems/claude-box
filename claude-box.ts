#!/usr/bin/env bun
/**
 * claude-box [account] [claude args…] — a pinned, isolated Claude, one account per volume.
 *
 * One image (localhost/claude-personal:dev) + one podman volume per account
 * (claude-<account>-config) holding THAT account's auth/history/projects. The
 * volume is the isolation boundary; `:U` keeps it writable by the in-image
 * `claude` user so `/login` persists. First run of a new account → `/login`
 * once, and it sticks in that account's volume.
 *
 *   claude-box                  personal account
 *   claude-box work             'work' account — own auth/history
 *   claude-box work --resume    flags pass through to claude
 *   claude-box ls               list accounts (+ descriptions)
 *   claude-box name work "Acme, Inc. — billing@acme"   label an account
 *
 * Built from prx.git/claude-runtime:nix/claude-container (ADR
 * docs/prx/claude-runtime.md, epic prx-d4o). Compiled to a binary by nix (Bun).
 */

import { resolve } from "node:path";

const IMAGE = "localhost/claude-personal:dev";
const VOLUME_RE = /^claude-(.*)-config$/;
const META_PATH = `${process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`}/claude-box/accounts.json`;

// The doors (CAPABILITIES.md). The box holds no git creds / signing key and no
// beads access; it routes git writes through keeperd and beads ops through
// beadsd. We forward the door (the host socket) — never the keys. The host
// socket path is overridable so the same launcher works across transports
// (a direct socket today; a host-gateway/ssh-forwarded socket across the gap).
const KEEPERD_SOCK = process.env.KEEPERD_SOCK ?? "/tmp/keeperd.sock";
const BEADSD_SOCK = process.env.BEADSD_SOCK ?? "/tmp/beadsd.sock";
const KEEPERD_DOOR = "/run/keeperd.sock"; // where the box looks for it
const BEADSD_DOOR = "/run/beadsd.sock";

const HELP = `claude-box [account] [claude args…] — pinned, isolated Claude, one account per volume

  claude-box                  personal account
  claude-box work             'work' account (own auth/history)
  claude-box work --resume    flags pass through to claude
  claude-box work --repo .    mount the current worktree at /work (work on a repo)
  claude-box work --keeper    forward the keeperd door (signed git writes)
  claude-box work --beads     forward the beadsd door (beads reads/writes)
  claude-box ls               list accounts (+ descriptions)
  claude-box name <acct> <description…>   set a friendly label`;

type Doors = { keeper?: boolean; beads?: boolean };

type Meta = Record<string, { desc?: string }>;

async function loadMeta(): Promise<Meta> {
  try {
    return (await Bun.file(META_PATH).json()) as Meta;
  } catch {
    return {};
  }
}

async function saveMeta(meta: Meta): Promise<void> {
  await Bun.write(META_PATH, `${JSON.stringify(meta, null, 2)}\n`);
}

/** Accounts that have a podman volume (claude-<name>-config). */
async function volumeAccounts(): Promise<string[]> {
  const proc = Bun.spawn(["podman", "volume", "ls", "--format", "{{.Name}}"], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out
    .split("\n")
    .map((l) => l.match(VOLUME_RE)?.[1])
    .filter((x): x is string => Boolean(x));
}

async function listAccounts(): Promise<number> {
  const meta = await loadMeta();
  const names = [...new Set([...(await volumeAccounts()), ...Object.keys(meta)])].sort();
  for (const name of names) {
    const desc = meta[name]?.desc;
    console.log(desc ? `${name}  —  ${desc}` : name);
  }
  return 0;
}

async function setName(account: string, desc: string): Promise<number> {
  if (!account) {
    console.error("usage: claude-box name <account> <description…>");
    return 1;
  }
  const meta = await loadMeta();
  meta[account] = { ...meta[account], desc };
  await saveMeta(meta);
  console.log(`${account}  —  ${desc}`);
  return 0;
}

/** The real git dir (a worktree's lives in a bare repo OUTSIDE the worktree). */
async function gitCommonDir(repo: string): Promise<string | undefined> {
  const proc = Bun.spawn(
    ["git", "-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out || undefined;
}

async function run(account: string, args: string[], repo?: string, doors: Doors = {}): Promise<number> {
  const argv = [
    "podman", "run", "-it", "--rm",
    "-v", `claude-${account}-config:/home/claude/.config/claude:U`,
  ];
  // Forward the doors (sockets) the launch granted — never keys. The box looks
  // for each at a fixed in-box path (exported so prx finds it).
  if (doors.keeper) {
    argv.push("-v", `${KEEPERD_SOCK}:${KEEPERD_DOOR}`, "--env", `KEEPERD_SOCK=${KEEPERD_DOOR}`);
  }
  if (doors.beads) {
    argv.push("-v", `${BEADSD_SOCK}:${BEADSD_DOOR}`, "--env", `BEADSD_SOCK=${BEADSD_DOOR}`);
  }
  if (repo) {
    const abs = resolve(repo);
    // Mount the worktree RW at /work; map the host user → the in-box `claude`
    // uid so host-owned files line up (writable + no git "dubious ownership"),
    // WITHOUT chowning the repo.
    argv.push("-v", `${abs}:/work`, "-w", "/work", "--userns=keep-id:uid=1000,gid=1000");
    // A worktree's git dir lives in a bare repo outside the worktree; mount that
    // common dir at its host path so `git` resolves inside the box.
    const common = await gitCommonDir(abs);
    if (common && !common.startsWith(`${abs}/`)) {
      argv.push("-v", `${common}:${common}`);
    }
  }
  argv.push(IMAGE, ...args);
  const proc = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

const [first, ...rest] = Bun.argv.slice(2);

switch (first) {
  case "ls":
  case "list":
  case "--list":
    process.exit(await listAccounts());
    break;
  case "name":
  case "label":
    process.exit(await setName(rest[0] ?? "", rest.slice(1).join(" ")));
    break;
  case "-h":
  case "--help":
    console.log(HELP);
    process.exit(0);
}

// A leading non-flag token is the account; otherwise default to `personal` and
// treat everything as claude args (so `claude-box --resume` works too).
const named = first !== undefined && !first.startsWith("-");
const account = named ? first : "personal";
const tail = named ? rest : first !== undefined ? [first, ...rest] : [];

// claude-box flags: `--repo <path>` (mount a worktree at /work), `--keeper` /
// `--beads` (forward a door). Everything else passes through to claude.
let repo: string | undefined;
const doors: Doors = {};
const claudeArgs: string[] = [];
for (let i = 0; i < tail.length; i++) {
  if (tail[i] === "--repo") {
    repo = tail[++i];
    continue;
  }
  if (tail[i] === "--keeper") {
    doors.keeper = true;
    continue;
  }
  if (tail[i] === "--beads") {
    doors.beads = true;
    continue;
  }
  claudeArgs.push(tail[i]!);
}

process.exit(await run(account, claudeArgs, repo, doors));
