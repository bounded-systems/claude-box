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

import { resolve } from "node:path";

const IMAGE = "localhost/claude-personal:dev";
const VOLUME_RE = /^claude-(.*)-config$/;
const META_PATH = `${process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`}/claude-box/accounts.json`;

type Env = Record<string, string | undefined>;

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
      hostDefault: env.KEEPERD_SOCK ?? "/tmp/keeperd.sock",
      grants: "signed git writes (commit/push/refs) via keeperd",
      use: "Route every git write through keeperd at /run/keeperd.sock ($KEEPERD_SOCK). You hold NO git credentials and NO signing key — request a signed write and keeperd performs it. A raw `git push` cannot work; there is nothing in the box to push with.",
      deny: "No git-write authority in this box. Do not push, mutate refs, or claim a commit landed on a remote — it will fail. If the task needs it, it must be RELAUNCHED with --keeper.",
    },
    beads: {
      flag: "--beads",
      inBox: "/run/beadsd.sock",
      env: "BEADSD_SOCK",
      hostDefault: env.BEADSD_SOCK ?? "/tmp/beadsd.sock",
      grants: "beads reads/writes via beadsd",
      use: "Route beads operations through beadsd at /run/beadsd.sock ($BEADSD_SOCK).",
      deny: "No beads access in this box. Do not attempt bd reads/writes; relaunch with --beads if the task needs them.",
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
    host: host ?? `/tmp/${name}.sock`,
    grants: `service door "${name}"`,
    use: `Reach the ${name} service at ${inBox} ($${ENV}). You hold the door, not the service's keys.`,
  };
}

const HELP = `claude-box [account] [claude args…] — pinned, isolated Claude, one account per volume

  claude-box                  personal account
  claude-box work             'work' account (own auth/history)
  claude-box work --resume    flags pass through to claude
  claude-box work --repo .    mount the current worktree at /work (work on a repo)
  claude-box work --keeper    forward the keeperd door (signed git writes)
  claude-box work --beads     forward the beadsd door (beads reads/writes)
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

type Launch = { repo?: string; doors: DoorGrant[]; claudeArgs: string[] };

/** Split a launch's tail into claude-box flags (--repo / --keeper / --beads /
 *  --door) and the claude passthrough args. */
function planLaunch(tail: string[], env: Env = process.env): Launch {
  let repo: string | undefined;
  const doors = new Map<string, DoorGrant>();
  const claudeArgs: string[] = [];
  const add = (d: DoorGrant) => doors.set(d.name, d);
  for (let i = 0; i < tail.length; i++) {
    const t = tail[i]!;
    if (t === "--repo") {
      repo = tail[++i];
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
  return { repo, doors: [...doors.values()], claudeArgs };
}

type Manifest = {
  account: string;
  repo?: string;
  doors: DoorGrant[];
  denied: { name: string; flag: string; deny: string }[];
};

/** The honest surface for THIS launch: what's granted AND what's denied. Built
 *  from the actual grants, so it cannot drift from reality. */
function buildManifest(account: string, launch: Launch, env: Env = process.env): Manifest {
  const granted = new Set(launch.doors.map((d) => d.name));
  const denied = Object.entries(knownDoors(env))
    .filter(([name]) => !granted.has(name))
    .map(([name, p]) => ({ name, flag: p.flag, deny: p.deny }));
  return { account, repo: launch.repo, doors: launch.doors, denied };
}

/** Machine-readable manifest (exported into the box as $CLAUDE_BOX_CAPABILITIES)
 *  — the surface the in-box runtime (prx) will gate its tools on. */
function capabilityJson(m: Manifest): string {
  return JSON.stringify({
    workcell: "claude-box",
    account: m.account,
    granted: {
      config: true,
      repo: m.repo ?? null,
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
    lines.push(`- repo: ${m.repo} mounted read-write at /work. Only this worktree is writable; nothing else on the host is.`);
  }
  for (const d of m.doors) {
    lines.push(`- ${d.name}: ${d.grants}. ${d.use}`);
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
  const { repo, doors, claudeArgs } = launch;
  const manifest = buildManifest(account, launch, env);
  const argv = [
    "podman", "run", "-it", "--rm",
    "-v", `claude-${account}-config:/home/claude/.config/claude:U`,
  ];
  // Forward each granted door (host socket → fixed in-box path) and export its
  // env so the box finds it — never the daemon's keys.
  for (const d of doors) {
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
    // A worktree's git dir lives in a bare repo outside the worktree; mount that
    // common dir at its host path so `git` resolves inside the box.
    const common = await gitCommonDir(abs);
    if (common && !common.startsWith(`${abs}/`)) {
      argv.push("-v", `${common}:${common}`);
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
