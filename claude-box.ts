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
 * docs/prx/claude-runtime.md, epic prx-d4o). Run via pinned Bun.
 */

import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const IMAGE = "localhost/claude-personal:dev";
const VOLUME_RE = /^claude-(.*)-config$/;
const META_PATH = `${process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`}/claude-box/accounts.json`;
// The loopback proxy the in-box relay exposes; the image entrypoint forwards it
// to the netd door (/run/netd.sock). Egress clients route here (HTTPS_PROXY=…).
const NETD_PROXY = "http://127.0.0.1:3128";

type Env = Record<string, string | undefined>;

/** Account names land in a volume name and a `-v` mount spec, so a stray `:` or
 *  `/` could malform or redirect the mount. Keep them boring. */
function assertAccount(account: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(account)) {
    console.error(`claude-box: invalid account name ${JSON.stringify(account)} — use [A-Za-z0-9._-]`);
    process.exit(2);
  }
}

/** Default host socket for a daemon, private-dir-first. Pure (no I/O) so door
 *  resolution stays testable; run() enforces the fail-closed check below. */
function defaultHostSock(daemon: string, env: Env): string {
  return `${env.XDG_RUNTIME_DIR ?? "/tmp"}/${daemon}.sock`;
}

/** A door socket's dir must not be world-writable, or another host user can
 *  pre-create the socket and MITM the door. Enforced at launch (fail closed),
 *  for EVERY door — so the /tmp default is refused unless a private path is set. */
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
    console.error(`claude-box: refusing door socket in world-writable ${dir} (hijack risk) — set a private path (e.g. under $XDG_RUNTIME_DIR)`);
    process.exit(2);
  }
}

// ── The OCAP surface ─────────────────────────────────────────────────────────
// A *door* is the whole capability mechanism: a single (name, socket) pair. The
// box holds no keys — only doors. We mount the host socket at a fixed in-box
// path and export its env var; the box can REQUEST what the daemon behind the
// door enforces, never hold the daemon's keys. There is exactly ONE door
// primitive; `--keeper` / `--beads` are named presets over it (canonical paths
// + a rulebook), and `--door <name>[=<sock>]` attaches any other service. One
// image, services attached per launch by socket — and one registry, so mounts,
// env, manifest, help and docs cannot drift (the drift that let `--keeper` be
// "documented but unimplemented" is now structurally impossible).

/** A door the box knows by name: canonical in-box path, env, and rulebook. */
type DoorPreset = {
  flag: string; // the launcher sugar flag (e.g. "--keeper")
  inBox: string; // where the box looks for the socket
  env: string; // env var pointing the box at the in-box socket
  hostDefault: string; // host socket path (overridable so the same launch works across transports)
  grants: string; // one-line capability, for the manifest
  use: string; // rulebook when GRANTED — how the man translates this symbol
  deny: string; // rulebook when DENIED — there is no rule; do not attempt
};

/** The known doors. Host socket paths are overridable via env so the identical
 *  launch works whether the door is a direct socket or one relayed across the
 *  two-VM gap (see CAPABILITIES.md). */
function knownDoors(env: Env = process.env): Record<string, DoorPreset> {
  return {
    keeper: {
      flag: "--keeper",
      inBox: "/run/keeperd.sock",
      env: "KEEPERD_SOCK",
      hostDefault: env.KEEPERD_SOCK ?? defaultHostSock("keeperd", env),
      grants: "signed git writes (commit/push/refs) via keeperd",
      use: "Route every git write through keeperd at /run/keeperd.sock ($KEEPERD_SOCK). You hold NO git credentials and NO signing key — request a signed write and keeperd performs it. A raw `git push` cannot work; there is nothing in the box to push with.",
      deny: "No git-write authority in this box. Do not push, mutate refs, or claim a commit landed on a remote — it will fail. If the task needs it, it must be RELAUNCHED with --keeper.",
    },
    beads: {
      flag: "--beads",
      inBox: "/run/beadsd.sock",
      env: "BEADSD_SOCK",
      hostDefault: env.BEADSD_SOCK ?? defaultHostSock("beadsd", env),
      grants: "beads reads/writes via beadsd",
      use: "Route beads operations through beadsd at /run/beadsd.sock ($BEADSD_SOCK).",
      deny: "No beads access in this box. Do not attempt bd reads/writes; relaunch with --beads if the task needs them.",
    },
    // The read door (GH-5). Dropping `gh` unbundled its powers: writes → keeper,
    // raw egress → net, and READS → scout. scoutd holds the read tokens + fetch
    // policy and returns CONTENT, never a credential or live socket — a box can
    // read repos/PRs/URLs with no token and even no NIC (--network=none). See
    // SCOUT.md; the read twin of keeperd (writes).
    scout: {
      flag: "--scout",
      inBox: "/run/scoutd.sock",
      env: "SCOUTD_SOCK",
      hostDefault: env.SCOUTD_SOCK ?? defaultHostSock("scoutd", env),
      grants: "read external artifacts (repos/PRs/URLs) via scoutd (you hold no read tokens)",
      use: "Read external content through the scout door at /run/scoutd.sock ($SCOUTD_SOCK): ask scoutd to fetch a repo/PR/issue/URL and it returns CONTENT, never a token or live socket. You hold NO read credentials and NO network for reads — scoutd owns the read tokens + allowlist. A host/scope it refuses is final; do not retry or tunnel around it.",
      deny: "No external reads in this box — do not assume you can clone, fetch, or browse; there is no token and no read route. Do not claim a fetch succeeded. If the task needs external reads, relaunch with --scout.",
    },
    // The egress door. Unlike the others it carries LAUNCH EFFECTS: the box runs
    // --network=none and routes HTTPS_PROXY → the relay → this socket, so netd's
    // allowlist is the only way out (see run() + CAPABILITIES.md "Network is a
    // door — not a NIC"). The daemon is the network twin of keeperd/beadsd.
    net: {
      flag: "--net",
      inBox: "/run/netd.sock",
      env: "NETD_SOCK",
      hostDefault: env.NETD_SOCK ?? defaultHostSock("netd", env),
      grants: "policed network egress via the netd allowlist proxy",
      use: "All egress goes through the netd door at /run/netd.sock ($NETD_SOCK); HTTPS_PROXY is set for you. You can reach ONLY hosts netd's allowlist permits — there is no other route off the box. A blocked host is final; do not retry or tunnel around it.",
      deny: "No network. This box runs --network=none with no egress door — you cannot reach any host. Do not attempt network calls or claim they worked; relaunch with --net for policed egress (or --net-open for unrestricted, unsafe egress).",
    },
  };
}

/** A door actually granted to this launch (preset or generic). */
type DoorGrant = {
  name: string;
  inBox: string;
  env: string;
  host: string;
  grants: string;
  use: string;
};

const DOOR_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Resolve a door by name to a concrete grant. Known names get their canonical
 *  path + rulebook; any other name becomes a generic service door at
 *  /run/<name>.sock. An explicit host socket overrides the default. */
function resolveDoor(name: string, host: string | undefined, env: Env = process.env): DoorGrant {
  if (!DOOR_NAME_RE.test(name)) {
    throw new Error(`invalid door name "${name}" (expected [a-z0-9][a-z0-9-]*)`);
  }
  const known = knownDoors(env)[name];
  if (known) {
    return { name, inBox: known.inBox, env: known.env, host: host ?? known.hostDefault, grants: known.grants, use: known.use };
  }
  const ENV = `${name.toUpperCase().replace(/-/g, "_")}_SOCK`;
  const inBox = `/run/${name}.sock`;
  return {
    name,
    inBox,
    env: ENV,
    host: host ?? env[ENV] ?? defaultHostSock(name, env),
    grants: `service door "${name}"`,
    use: `Reach the ${name} service at ${inBox} ($${ENV}). You hold the door, not the service's keys.`,
  };
}

const HELP = `claude-box [account] [claude args…] — pinned, isolated Claude, one account per volume

  claude-box                  personal account
  claude-box work             'work' account (own auth/history)
  claude-box work --resume    flags pass through to claude
  claude-box work --repo .    mount the worktree at /work (.git read-only; commits via --keeper)
  claude-box work --repo-rw . UNSAFE: worktree AND host .git writable (no-keeper escape)
  claude-box work --net       forward the netd door — policed egress (default: no network)
  claude-box work --net-open  UNSAFE: full ambient egress, no allowlist
  claude-box work --keeper    forward the keeperd door (signed git writes)
  claude-box work --beads     forward the beadsd door (beads reads/writes)
  claude-box work --scout     forward the scoutd door (external reads: repos/PRs/URLs)
  claude-box work --door NAME[=HOST_SOCK]   attach any service by socket (generic door)
  claude-box ls               list accounts (+ descriptions)
  claude-box name <acct> <description…>   set a friendly label`;

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

// ── Launch planning + the capability manifest ────────────────────────────────

type Launch = { repo?: string; repoRw: boolean; doors: DoorGrant[]; netOpen: boolean; claudeArgs: string[] };

/** Split a launch's tail into claude-box flags (--repo / --net[-open] / --keeper
 *  / --beads / --scout / --door) and the claude passthrough args. `--net` takes
 *  an optional socket path (bare ⇒ the default netd door); `--net-open` is the
 *  unsafe ambient-egress escape (no door). */
function planLaunch(tail: string[], env: Env = process.env): Launch {
  let repo: string | undefined;
  let repoRw = false;
  let netOpen = false;
  const doors = new Map<string, DoorGrant>();
  const claudeArgs: string[] = [];
  const add = (d: DoorGrant) => doors.set(d.name, d);
  for (let i = 0; i < tail.length; i++) {
    const t = tail[i]!;
    if (t === "--repo") {
      repo = tail[++i];
      continue;
    }
    if (t === "--repo-rw") {
      // The unsafe escape: the host .git is WRITABLE in the box (today's
      // behaviour). For when there's no keeperd and you must commit in-box.
      repo = tail[++i];
      repoRw = true;
      continue;
    }
    if (t === "--net-open") {
      netOpen = true;
      continue;
    }
    if (t === "--net") {
      const next = tail[i + 1];
      const host = next !== undefined && !next.startsWith("-") ? tail[++i] : undefined;
      add(resolveDoor("net", host, env));
      continue;
    }
    if (t === "--keeper") {
      add(resolveDoor("keeper", undefined, env));
      continue;
    }
    if (t === "--beads") {
      add(resolveDoor("beads", undefined, env));
      continue;
    }
    if (t === "--scout") {
      add(resolveDoor("scout", undefined, env));
      continue;
    }
    if (t === "--door") {
      const spec = tail[++i] ?? "";
      const eq = spec.indexOf("=");
      const name = eq < 0 ? spec : spec.slice(0, eq);
      const host = eq < 0 ? undefined : spec.slice(eq + 1);
      add(resolveDoor(name, host, env));
      continue;
    }
    claudeArgs.push(t);
  }
  return { repo, repoRw, doors: [...doors.values()], netOpen, claudeArgs };
}

type Manifest = {
  account: string;
  repo?: string;
  repoRw: boolean;
  doors: DoorGrant[];
  netOpen: boolean;
  denied: { name: string; flag: string; deny: string }[];
};

/** The honest surface for THIS launch: what's granted AND what's denied. Built
 *  from the actual grants, so it cannot drift from reality. `--net-open` opens
 *  ambient egress WITHOUT the net door, so it suppresses the "net" denial — the
 *  manifest must not claim there's no network when there is. */
function buildManifest(account: string, launch: Launch, env: Env = process.env): Manifest {
  const granted = new Set(launch.doors.map((d) => d.name));
  const denied = Object.entries(knownDoors(env))
    .filter(([name]) => !granted.has(name) && !(name === "net" && launch.netOpen))
    .map(([name, p]) => ({ name, flag: p.flag, deny: p.deny }));
  return { account, repo: launch.repo, repoRw: launch.repoRw, doors: launch.doors, netOpen: launch.netOpen, denied };
}

/** Machine-readable manifest (exported into the box as $CLAUDE_BOX_CAPABILITIES)
 *  — the surface the in-box runtime (prx) will gate its tools on. */
function capabilityJson(m: Manifest): string {
  const netDoor = m.doors.some((d) => d.name === "net");
  return JSON.stringify({
    workcell: "claude-box",
    account: m.account,
    // Network posture is explicit: policed (netd door), open (unsafe escape), or
    // none (--network=none, the default). Egress is a capability, not ambient.
    network: m.netOpen ? "open" : netDoor ? "policed" : "none",
    granted: {
      config: true,
      repo: m.repo ?? null,
      // Honest about the .git posture: read-only (writes via keeper) unless the
      // unsafe --repo-rw escape was used.
      repoGit: m.repo ? (m.repoRw ? "rw" : "ro") : null,
      doors: m.doors.map((d) => ({ name: d.name, socket: d.inBox, env: d.env, grants: d.grants })),
    },
    denied: m.denied.map((d) => ({ name: d.name, flag: d.flag })),
  });
}

/** Human-readable surface injected into the agent's context every launch. The
 *  room hands the man a rulebook keyed to exactly the doors present. */
function capabilityPrompt(m: Manifest): string {
  const lines: string[] = [
    "[claude-box — capability surface for THIS launch]",
    "You are running inside claude-box, a credential-free OCAP workcell. Your authority is EXACTLY the capabilities listed below — nothing is ambient. This list is generated from the actual mounts of this launch, so it is ground truth: if something is not GRANTED, you do not have it — do not attempt it and do not claim it succeeded.",
    "",
    "GRANTED:",
    "- config: your own account's auth/history (a private volume).",
  ];
  if (m.repo) {
    lines.push(
      m.repoRw
        ? `- repo: ${m.repo} at /work — worktree AND .git WRITABLE (--repo-rw, unsafe). Only this worktree on the host is writable.`
        : `- repo: ${m.repo} at /work — worktree files are writable, but .git is READ-ONLY: you cannot commit/rewrite history in-box. Route commits through the keeper door. Do not try to edit .git/config or hooks; it will fail.`,
    );
  }
  for (const d of m.doors) {
    lines.push(`- ${d.name}: ${d.grants}. ${d.use}`);
  }
  if (m.netOpen) {
    lines.push("- network: UNRESTRICTED ambient egress (--net-open) — NO allowlist. Unsafe escape hatch; anything you send can reach any host.");
  }
  lines.push("");
  if (m.denied.length) {
    lines.push("DENIED (the capability is physically absent from this box — do not attempt):");
    for (const d of m.denied) {
      lines.push(`- ${d.name}: ${d.deny}`);
    }
  } else {
    lines.push("DENIED: nothing named — but authority is still ONLY what is GRANTED above.");
  }
  return lines.join("\n");
}

async function run(account: string, launch: Launch, env: Env = process.env): Promise<number> {
  assertAccount(account);
  const { repo, repoRw, doors, netOpen, claudeArgs } = launch;
  const manifest = buildManifest(account, launch, env);
  const argv = [
    "podman", "run", "-it", "--rm",
    // Defense-in-depth floor (not a grant): the box needs no Linux caps and
    // never escalates, so cap a runaway/forky agent from fork-bombing or
    // privilege-escalating the host.
    "--security-opt", "no-new-privileges",
    "--cap-drop", "all",
    "--pids-limit", "2048",
    "-v", `claude-${account}-config:/home/claude/.config/claude:U`,
  ];
  // Network is a DOOR, not a NIC. Default to NO interface (nothing to exfiltrate
  // through, even with a repo mounted); the netd door (below) is the only
  // policed way out. `--net-open` is the loud, explicit, unsafe ambient-egress
  // escape — used only when no netd is running.
  const netDoor = doors.find((d) => d.name === "net");
  if (netOpen) {
    console.error("claude-box: --net-open — UNPOLICED full network egress (no netd allowlist)");
  } else {
    argv.push("--network=none");
    if (netDoor) {
      // The image entrypoint relays 127.0.0.1:3128 → the netd door; point every
      // egress client at it. The box holds no egress of its own — it can only
      // ASK netd, which owns the allowlist.
      argv.push(
        "--env", `HTTPS_PROXY=${NETD_PROXY}`, "--env", `HTTP_PROXY=${NETD_PROXY}`,
        "--env", `ALL_PROXY=${NETD_PROXY}`, "--env", "NO_PROXY=localhost,127.0.0.1",
      );
    }
  }
  // Forward each granted door (host socket → fixed in-box path) and export its
  // env so the box finds it — never the daemon's keys. Fail closed if the host
  // socket sits in a world-writable dir (hijack risk), for EVERY door.
  for (const d of doors) {
    assertSocketDir(d.host);
    argv.push("-v", `${d.host}:${d.inBox}`, "--env", `${d.env}=${d.inBox}`);
  }
  // The machine-readable surface for the in-box runtime (prx tool-gating).
  argv.push("--env", `CLAUDE_BOX_CAPABILITIES=${capabilityJson(manifest)}`);
  if (repo) {
    const abs = resolve(repo);
    // Mount the worktree RW at /work; map the host user → the in-box `claude`
    // uid so host-owned files line up (writable + no git "dubious ownership"),
    // WITHOUT chowning the repo.
    argv.push("-v", `${abs}:/work`, "-w", "/work", "--userns=keep-id:uid=1000,gid=1000");
    // A worktree's git dir lives in a bare repo OUTSIDE the worktree; mount that
    // common dir at its host path so `git` resolves inside the box.
    const common = await gitCommonDir(abs);
    const external = common && !common.startsWith(`${abs}/`);
    if (repoRw) {
      // UNSAFE escape: leave .git WRITABLE (today's behaviour). A box that writes
      // .git/hooks or .git/config gets host code execution when you next run git.
      console.error(
        "claude-box: --repo-rw — host .git is WRITABLE in the box; a planted hook/config runs on YOUR host. Prefer --repo (read-only .git) + --keeper.",
      );
      if (external) argv.push("-v", `${common}:${common}`);
    } else {
      // SAFE default: worktree files stay writable (the agent edits code), but
      // .git is READ-ONLY — the box can't plant a hook or rewrite config that
      // executes on the host. History writes go through the keeper door, not the
      // mount. (Closes the host-RCE escape; see REPOD.md for the overlay that
      // restores in-box git ergonomics.)
      if (external) {
        // worktree: the bare/common dir (config + hooks + this worktree's gitdir)
        // is outside /work — mount it read-only at its host path.
        argv.push("-v", `${common}:${common}:ro`);
      } else {
        // normal repo: .git is inside the worktree — overlay it :ro over /work.
        argv.push("-v", `${abs}/.git:/work/.git:ro`);
      }
    }
  }
  // Inject the honest surface into the agent's context (granted AND denied), so
  // the box KNOWS its powers and limits rather than assuming them.
  argv.push(IMAGE, "--append-system-prompt", capabilityPrompt(manifest), ...claudeArgs);
  const proc = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

async function main(): Promise<number> {
  const [first, ...rest] = Bun.argv.slice(2);

  switch (first) {
    case "ls":
    case "list":
    case "--list":
      return listAccounts();
    case "name":
    case "label":
      return setName(rest[0] ?? "", rest.slice(1).join(" "));
    case "-h":
    case "--help":
      console.log(HELP);
      return 0;
  }

  // A leading non-flag token is the account; otherwise default to `personal` and
  // treat everything as claude args (so `claude-box --resume` works too).
  const named = first !== undefined && !first.startsWith("-");
  const account = named ? first : "personal";
  const tail = named ? rest : first !== undefined ? [first, ...rest] : [];

  const launch = planLaunch(tail);
  return run(account, launch);
}

// Importable by tests (planLaunch / resolveDoor / buildManifest / capability*),
// runnable as a script.
export { knownDoors, resolveDoor, planLaunch, buildManifest, capabilityJson, capabilityPrompt };
export type { DoorGrant, Manifest, Launch };

if (import.meta.main) {
  process.exit(await main());
}
