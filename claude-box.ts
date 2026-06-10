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

import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const IMAGE = "localhost/claude-personal:dev";
const VOLUME_RE = /^claude-(.*)-config$/;
const META_PATH = `${process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`}/claude-box/accounts.json`;
// The localhost proxy the in-box relay exposes; the image entrypoint forwards
// it to /run/netd.sock. Clients route egress here (HTTPS_PROXY=…).
const NETD_PROXY = "http://127.0.0.1:3128";

/** Default path for a door socket (netd/keeperd). FAIL CLOSED: a world-writable
 *  fallback like /tmp lets another host user pre-create the socket and MITM the
 *  door, so we require XDG_RUNTIME_DIR (a private, 0700 dir) and refuse to guess. */
function doorSock(name: string): string {
  const rt = process.env.XDG_RUNTIME_DIR;
  if (!rt) {
    console.error(
      `claude-box: XDG_RUNTIME_DIR unset — refusing to put the ${name} door in a world-writable /tmp (hijack risk). Set XDG_RUNTIME_DIR or pass an explicit socket path.`,
    );
    process.exit(2);
  }
  return `${rt}/${name}.sock`;
}

/** A door socket's directory must not be world-writable, or another user can
 *  pre-create the socket and MITM the door. Validates explicit paths too. */
function assertSocketDir(sock: string): void {
  const dir = dirname(sock);
  let mode: number;
  try {
    mode = statSync(dir).mode;
  } catch {
    console.error(`claude-box: door socket dir ${dir} does not exist`);
    process.exit(2);
  }
  if (mode & 0o002) {
    console.error(`claude-box: refusing door socket in world-writable ${dir} (hijack risk) — use a private dir`);
    process.exit(2);
  }
}

const HELP = `claude-box [account] [claude args…] — pinned, isolated Claude, one account per volume

  claude-box                  personal account (no network — see --net)
  claude-box work             'work' account (own auth/history)
  claude-box work --resume    flags pass through to claude
  claude-box work --repo .    mount the current worktree at /work (work on a repo)
  claude-box work --net       policed egress via the netd door ($XDG_RUNTIME_DIR/netd.sock)
  claude-box work --net <sock> netd door at a custom socket path
  claude-box work --net-open  UNSAFE: full ambient egress, no allowlist
  claude-box work --keeper    git writes via the keeperd door (no creds in the box)
  claude-box ls               list accounts (+ descriptions)
  claude-box name <acct> <description…>   set a friendly label`;

type Meta = Record<string, { desc?: string }>;

/** Account names land in a volume name and a `-v` mount spec, so a stray `:`
 *  or `/` could malform or redirect the mount. Keep them boring. */
function assertAccount(account: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(account)) {
    console.error(`claude-box: invalid account name ${JSON.stringify(account)} — use [A-Za-z0-9._-]`);
    process.exit(2);
  }
}

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
  assertAccount(account);
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

/** Network grant: a door, not a NIC. `undefined` = offline; `{open}` = the
 *  unsafe ambient-egress escape; otherwise the netd door at `sock`. */
type Net = { open: true } | { sock: string };

/** The per-launch capability grants (each opt-in; see CAPABILITIES.md). */
type Grants = { repo?: string; net?: Net; keeper?: string };

async function run(account: string, args: string[], grants: Grants): Promise<number> {
  assertAccount(account);
  const { repo, net, keeper } = grants;
  const argv = [
    "podman", "run", "-it", "--rm",
    // Defense-in-depth: the box needs no Linux caps and never escalates; cap a
    // runaway/forky agent so it can't fork-bomb or privilege-escalate the host.
    "--security-opt", "no-new-privileges",
    "--cap-drop", "all",
    "--pids-limit", "2048",
    "-v", `claude-${account}-config:/home/claude/.config/claude:U`,
  ];
  // Network is a DOOR, not a NIC (CAPABILITIES.md). The box gets NO ambient
  // egress; its only way out is the forwarded netd door, whose daemon enforces
  // the egress allowlist. No grant ⇒ offline — a runaway box has nothing to
  // exfiltrate THROUGH, even with the repo mounted.
  if (net && "open" in net) {
    // Explicit, unsafe escape hatch: full ambient egress (the pre-door behaviour).
    console.error("claude-box: --net-open — UNPOLICED full network egress (no netd allowlist)");
  } else {
    argv.push("--network=none");
    if (net) {
      // Forward the netd door + point in-box clients at the relay it exposes.
      // The box holds no egress capability of its own — it can only ASK netd,
      // which owns the allowlist (the network twin of keeperd/beadsd).
      assertSocketDir(net.sock);
      argv.push("-v", `${net.sock}:/run/netd.sock`);
      argv.push(
        "-e", `HTTPS_PROXY=${NETD_PROXY}`, "-e", `HTTP_PROXY=${NETD_PROXY}`,
        "-e", `ALL_PROXY=${NETD_PROXY}`, "-e", "NO_PROXY=localhost,127.0.0.1",
      );
    }
  }
  // Git writes are a DOOR too: the box holds no keys, so commit/push routes
  // through keeperd (which owns the keys + signs). Forward the door, not creds.
  if (keeper) {
    assertSocketDir(keeper);
    argv.push("-v", `${keeper}:/run/keeperd.sock`);
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

/** Split claude-box grant flags out of the arg list; the rest pass through to
 *  claude. `--net`/`--keeper` take an optional socket path — bare (or followed
 *  by another flag) means the default door socket under $XDG_RUNTIME_DIR. */
function parseGrants(tokens: string[]): { grants: Grants; claudeArgs: string[] } {
  const grants: Grants = {};
  const claudeArgs: string[] = [];
  // Optional socket arg: the next token, unless it's missing or another flag.
  const sockArg = (tokens: string[], i: number, name: string): { sock: string; consumed: boolean } => {
    const next = tokens[i + 1];
    return next !== undefined && !next.startsWith("-")
      ? { sock: next, consumed: true }
      : { sock: doorSock(name), consumed: false };
  };
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i]!;
    if (a === "--repo") {
      grants.repo = tokens[++i];
    } else if (a === "--net-open") {
      grants.net = { open: true };
    } else if (a === "--net") {
      const { sock, consumed } = sockArg(tokens, i, "netd");
      grants.net = { sock };
      if (consumed) i++;
    } else if (a === "--keeper") {
      const { sock, consumed } = sockArg(tokens, i, "keeperd");
      grants.keeper = sock;
      if (consumed) i++;
    } else {
      claudeArgs.push(a);
    }
  }
  return { grants, claudeArgs };
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

// `--repo <path>` / `--net [sock]` / `--net-open` / `--keeper [sock]` are
// claude-box grant flags; everything else passes through to claude.
const { grants, claudeArgs } = parseGrants(tail);

process.exit(await run(account, claudeArgs, grants));
