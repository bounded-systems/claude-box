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

import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
// The guest-agnostic room+door engine. claude-box is its first consumer: it
// supplies the door catalog (knownDoors) and room bundles (knownRooms); the
// engine resolves grants, derives the honest granted/denied surface, and renders
// the rulebook. See guest-room/README.md.
import {
  type DoorGrant,
  type DoorCatalog,
  type RoomCatalog,
  type DoorTransport,
  resolveDoor as resolveDoorIn,
  expandRoom,
  deniedDoors,
  capabilityPreamble,
  grantedDoorLines,
  deniedDoorSection,
  transportString,
  unix,
  attenuate,
} from "./guest-room/mod.ts";

const IMAGE = "localhost/claude-personal:dev";
const VOLUME_RE = /^claude-(.*)-config$/;

// ── Guest catalog ─────────────────────────────────────────────────────────────
// A *guest* is a runtime identity: which image runs, what entrypoint, and what
// default room (capability surface). The room+door model is guest-agnostic; the
// guest catalog is the product-specific binding of "who runs" to "what they get."
// `claude` is the default; tool guests (bun, node, python) run with minimal caps.

type GuestPreset = {
  image: string;
  entrypoint?: string[];  // override image entrypoint
  defaultRoom?: string;   // room to apply if none specified
  needsConfig?: boolean;  // mount the account's config volume (default: true for claude)
};

/** claude-box's guest catalog. Tool guests default to the "tool" room (read-only
 *  repo, no network, no doors). */
function knownGuests(): Record<string, GuestPreset> {
  return {
    claude: {
      image: IMAGE,
      needsConfig: true,
      // No defaultRoom — claude gets explicit room/door flags
    },
    bun: {
      image: "oven/bun:1",
      entrypoint: ["bun"],
      defaultRoom: "tool",
      needsConfig: false,
    },
    node: {
      image: "node:22-slim",
      entrypoint: ["node"],
      defaultRoom: "tool",
      needsConfig: false,
    },
    deno: {
      image: "denoland/deno:2",
      entrypoint: ["deno"],
      defaultRoom: "tool",
      needsConfig: false,
    },
    python: {
      image: "python:3.12-slim",
      entrypoint: ["python"],
      defaultRoom: "tool",
      needsConfig: false,
    },
  };
}
const META_PATH = `${process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`}/claude-box/accounts.json`;
// The loopback proxy the in-box relay exposes; the image entrypoint forwards it
// to the netd door (/run/netd.sock). Egress clients route here (HTTPS_PROXY=…).
const NETD_PROXY = "http://127.0.0.1:3128";

type Env = Record<string, string | undefined>;

/** Account names land in a volume name and a `-v` mount spec, so a stray `:` or
 *  `/` could malform or redirect the mount. Keep them boring. */
function assertAccount(account: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(account)) {
    console.error(
      `claude-box: invalid account name ${JSON.stringify(account)} — use [A-Za-z0-9._-]`,
    );
    process.exit(2);
  }
}

/** Get the runtime directory for door sockets, auto-creating on macOS. */
function getRunDir(env: Env): string {
  if (env.XDG_RUNTIME_DIR) {
    return env.XDG_RUNTIME_DIR;
  }
  // macOS/fallback: use ~/.claude-box/run (create with safe perms if needed)
  const home = env.HOME;
  if (!home) {
    console.error(
      "claude-box: HOME environment variable not set and XDG_RUNTIME_DIR unavailable.\n" +
      "  Set HOME or XDG_RUNTIME_DIR to a private directory for door sockets.",
    );
    process.exit(2);
  }
  const fallback = `${home}/.claude-box/run`;
  if (!existsSync(fallback)) {
    mkdirSync(fallback, { recursive: true, mode: 0o700 });
  }
  return fallback;
}

/** Default host socket for a daemon, private-dir-first. */
function defaultHostSock(daemon: string, env: Env): string {
  return `${getRunDir(env)}/${daemon}.sock`;
}

/** Extract the path from a unix transport; throws if not unix (podman substrate
 *  only supports unix sockets — vsock/tcp would need a different substrate). */
function unixPath(t: DoorTransport): string {
  if (t.kind !== "unix") {
    throw new Error(`podman substrate requires unix sockets, got ${t.kind}`);
  }
  return t.path;
}

/** Daemon start hints for each door (shown when socket missing). */
const DAEMON_HINTS: Record<string, string> = {
  keeper: "nix run .#keeperd -- serve",
  net: "nix run .#netd -- serve",
  scout: "nix run .#scoutd -- serve",
  launcher: "nix run .#launcherd -- serve",
};
/** A door socket's dir must not be world-writable, or another host user can
 *  pre-create the socket and MITM the door. Enforced at launch (fail closed),
 *  for EVERY door — so the /tmp default is refused unless a private path is set.
 *  Also checks the socket itself exists and gives a helpful start hint. */
function assertSocketDir(sock: string, doorName?: string): void {
  const dir = dirname(sock);
  let mode: number;
  try {
    mode = statSync(dir).mode;
  } catch {
    console.error(`claude-box: door socket dir ${dir} does not exist`);
    process.exit(2);
  }
  if (mode & 0o002) {
    console.error(
      `claude-box: refusing door socket in world-writable ${dir} (hijack risk) — set a private path (e.g. under $XDG_RUNTIME_DIR)`,
    );
    process.exit(2);
  }
  // Check if the socket itself exists — give a helpful hint if not
  try {
    statSync(sock);
  } catch {
    const hint = doorName && DAEMON_HINTS[doorName];
    const startCmd = hint ? `\n  Start it with: ${hint}` : "";
    console.error(
      `claude-box: door socket ${sock} does not exist (daemon not running?)${startCmd}`,
    );
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

/** claude-box's door catalog. Host socket paths are overridable via env so the
 *  identical launch works whether the door is a direct socket or one relayed
 *  across the two-VM gap (see CAPABILITIES.md). The DoorPreset shape lives in
 *  guest-room; this is the claude-box-specific *content* fed to the engine. */
function knownDoors(env: Env = process.env): DoorCatalog {
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
      grants:
        "read external artifacts (repos/PRs/URLs) via scoutd (you hold no read tokens)",
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
    // The launcher door — spawn sub-boxes without holding podman. The box asks
    // launcherd to spawn; launcherd owns the runtime and enforces policy. This
    // enables the self-hosting loop (Claude launching Claude) without privilege
    // escalation. See LAUNCHERD.md.
    launcher: {
      flag: "--launcher",
      inBox: "/run/launcherd.sock",
      env: "LAUNCHERD_SOCK",
      hostDefault: env.LAUNCHERD_SOCK ?? defaultHostSock("launcherd", env),
      grants: "spawn sub-boxes via launcherd (you hold no runtime)",
      use: "Spawn sub-boxes by requesting through launcherd at /run/launcherd.sock ($LAUNCHERD_SOCK). You hold NO podman, NO runtime — request a spawn with a capability profile and launcherd performs it. Send JSON requests: {op:'spawn', profile:'work', doors:['keeper','net']}. The sub-box inherits doors you specify (if policy permits).",
      deny: "No spawn authority in this box. Do not attempt to launch containers or claim spawns succeeded — there is nothing in the box to spawn with. If the task needs sub-boxes, it must be RELAUNCHED with --launcher.",
    },
  };
}

// ── Rooms: named bundles of doors ────────────────────────────────────────────
// A *room* is the layer above the door registry the way a preset is the layer
// above the door primitive: a named set of doors for a KIND of work, so a launch
// reads as "the dev room" instead of a remembered pile of flags. The manifest
// still falls out of the granted doors, so a room cannot drift from what it
// grants. Doors only — `--repo <path>` stays explicit (it needs a path), and
// flags after `--room` compose (add/override) over the bundle. See ROOM.md.
function knownRooms(): RoomCatalog {
  return {
    // Minimal tool room: no doors at all. For running untrusted tools (test
    // runners, linters, type checkers) over a read-only repo. Parallel-safe.
    tool: {
      doors: [],
      about: "no doors — isolated tool execution over read-only repo",
    },
    // Read-only research: reads via scout, no write key, no NIC of its own.
    read: {
      doors: ["scout"],
      about: "external reads only (scout) — no writes, no egress NIC",
    },
    // The development room (e.g. claude-box working on claude-box): read + write
    // + policed egress. Pair with `--repo <path>` to mount a worktree.
    dev: {
      doors: ["keeper", "net", "scout"],
      about:
        "keeper + net + scout — edit, commit (via keeper), read & policed egress",
    },
  };
}

/** Resolve a door against claude-box's catalog. Thin product binding over the
 *  engine's resolveDoor (guest-room/mod.ts): known names get their canonical
 *  path + rulebook; any other name becomes a generic service door. */
function resolveDoor(name: string, host: string | undefined, env: Env = process.env): DoorGrant {
  return resolveDoorIn(knownDoors(env), name, host, env);
}

const HELP = `claude-box [account] [flags…] [-- guest-args…] — pinned, isolated workloads

  # Claude (default guest)
  claude-box                  personal account, claude guest
  claude-box work             'work' account (own auth/history)
  claude-box work --resume    flags pass through to claude
  claude-box work --repo .    mount the worktree at /work (.git read-only; commits via --keeper)

  # Tool guests (sandboxed tool execution)
  claude-box --guest bun --repo . -- test           run bun test in a box
  claude-box --guest node --repo . -- script.js    run node in a box
  claude-box --guest python --repo . -- -m pytest  run pytest in a box
  claude-box --guest deno --repo . -- test         run deno test in a box

  # Capability flags (work with any guest)
  --guest NAME        select runtime (claude | bun | node | deno | python)
  --repo PATH         mount worktree at /work (.git read-only)
  --repo-ephemeral .  ephemeral worktree (parallel-safe, cleaned up on exit)
  --repo-rw PATH      UNSAFE: worktree AND .git writable
  --net               forward the netd door — policed egress
  --net-open          UNSAFE: full ambient egress, no allowlist
  --keeper            forward the keeperd door (signed git writes)
  --beads             forward the beadsd door (beads reads/writes)
  --scout             forward the scoutd door (external reads)
  --launcher          forward the launcherd door (spawn sub-boxes)
  --room NAME         forward a door bundle (tool | read | dev)
  --door NAME[:CAV...][@SOCK]  attach door with optional caveats

  # Management
  claude-box ls               list accounts
  claude-box name <a> <desc>  label an account
  claude-box doors init       one-shot setup (build images, install units)
  claude-box doors status     show door service status
  claude-box status           show launcherd status
  claude-box ps               list running boxes
  claude-box kill <id>        terminate a running box`;

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
  const names = [
    ...new Set([...(await volumeAccounts()), ...Object.keys(meta)]),
  ].sort();
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
    [
      "git",
      "-C",
      repo,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out || undefined;
}

// ── Launch planning + the capability manifest ────────────────────────────────

type Launch = {
  guest: string;
  repo?: string;
  repoRw: boolean;
  repoEphemeral: boolean;
  doors: DoorGrant[];
  netOpen: boolean;
  guestArgs: string[];  // renamed: args passed to the guest (claude or tool)
};

/** Split a launch's tail into claude-box flags (--guest / --repo / --net[-open]
 *  / --keeper / --beads / --scout / --room / --door) and the guest passthrough
 *  args. `--net` takes an optional socket path (bare ⇒ the default netd door);
 *  `--net-open` is the unsafe ambient-egress escape (no door); `--room` expands a
 *  named door bundle that later flags compose over. `--guest` selects a runtime;
 *  tool guests (bun, node, python) apply their defaultRoom if no explicit room. */
function planLaunch(tail: string[], env: Env = process.env): Launch {
  let guest = "claude";
  let explicitRoom = false;
  let repo: string | undefined;
  let repoRw = false;
  let repoEphemeral = false;
  let netOpen = false;
  const doors = new Map<string, DoorGrant>();
  const guestArgs: string[] = [];
  const add = (d: DoorGrant) => doors.set(d.name, d);
  for (let i = 0; i < tail.length; i++) {
    const t = tail[i]!;
    if (t === "--guest") {
      const name = tail[++i] ?? "";
      const guests = knownGuests();
      if (!guests[name]) {
        throw new Error(`unknown guest "${name}" (known: ${Object.keys(guests).join(", ")})`);
      }
      guest = name;
      continue;
    }
    if (t === "--repo") {
      repo = tail[++i];
      continue;
    }
    if (t === "--repo-ephemeral") {
      // Ephemeral worktree: create a temp worktree at HEAD, mount that instead
      // of the live worktree. Parallel-safe (each box gets its own copy), and
      // the worktree is removed on exit. Shares the same .git (still :ro).
      repo = tail[++i];
      repoEphemeral = true;
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
      const host =
        next !== undefined && !next.startsWith("-") ? tail[++i] : undefined;
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
    if (t === "--launcher") {
      add(resolveDoor("launcher", undefined, env));
      continue;
    }
    if (t === "--room") {
      const name = tail[++i] ?? "";
      // Expand to the bundle's doors; later flags compose over them (the Map
      // dedupes by name, so `--room dev --door dolt=…` just adds dolt). Unknown
      // room ⇒ throw (fail closed, not a silent empty launch).
      for (const d of expandRoom(knownRooms(), knownDoors(env), name, env)) add(d);
      explicitRoom = true;
      continue;
    }
    if (t === "--door") {
      // Syntax: NAME[:CAVEAT...][@HOST_SOCK]
      // Examples: net, net:host=github.com, net:host=a.com:host=b.com@/sock
      const spec = tail[++i] ?? "";
      const atIdx = spec.lastIndexOf("@");
      const hostPart = atIdx >= 0 ? spec.slice(atIdx + 1) : undefined;
      const nameCaveatPart = atIdx >= 0 ? spec.slice(0, atIdx) : spec;
      const parts = nameCaveatPart.split(":");
      const name = parts[0]!;
      const caveats = parts.slice(1).filter(Boolean);
      let grant = resolveDoor(name, hostPart, env);
      if (caveats.length) {
        grant = attenuate(grant, caveats);
      }
      add(grant);
      continue;
    }
    guestArgs.push(t);
  }
  // Apply guest's defaultRoom if no explicit --room was given and no doors were
  // explicitly added. Tool guests get their defaultRoom automatically.
  const guestPreset = knownGuests()[guest];
  if (!explicitRoom && doors.size === 0 && guestPreset?.defaultRoom) {
    for (const d of expandRoom(knownRooms(), knownDoors(env), guestPreset.defaultRoom, env)) {
      add(d);
    }
  }
  return {
    guest,
    repo,
    repoRw,
    repoEphemeral,
    doors: [...doors.values()],
    netOpen,
    guestArgs,
  };
}

type Manifest = {
  account: string;
  guest: string;
  repo?: string;
  repoRw: boolean;
  repoEphemeral: boolean;
  doors: DoorGrant[];
  netOpen: boolean;
  denied: { name: string; flag: string; deny: string }[];
};

/** The honest surface for THIS launch: what's granted AND what's denied. Built
 *  from the actual grants, so it cannot drift from reality. `--net-open` opens
 *  ambient egress WITHOUT the net door, so it suppresses the "net" denial — the
 *  manifest must not claim there's no network when there is. */
function buildManifest(
  account: string,
  launch: Launch,
  env: Env = process.env,
): Manifest {
  const granted = new Set(launch.doors.map((d) => d.name));
  // --net-open opens ambient egress WITHOUT the net door, so suppress the "net"
  // denial — the manifest must not claim there's no network when there is.
  const suppress = launch.netOpen ? new Set(["net"]) : new Set<string>();
  const denied = deniedDoors(knownDoors(env), granted, suppress);
  return { account, guest: launch.guest, repo: launch.repo, repoRw: launch.repoRw, repoEphemeral: launch.repoEphemeral, doors: launch.doors, netOpen: launch.netOpen, denied };
}

/** Machine-readable manifest (exported into the box as $CLAUDE_BOX_CAPABILITIES)
 *  — the surface the in-box runtime (prx) will gate its tools on. */
function capabilityJson(m: Manifest): string {
  const netDoor = m.doors.some((d) => d.name === "net");
  return JSON.stringify({
    workcell: "claude-box",
    account: m.account,
    guest: m.guest,
    // Network posture is explicit: policed (netd door), open (unsafe escape), or
    // none (--network=none, the default). Egress is a capability, not ambient.
    network: m.netOpen ? "open" : netDoor ? "policed" : "none",
    granted: {
      config: true,
      repo: m.repo ?? null,
      // Honest about the .git posture: read-only (writes via keeper) unless the
      // unsafe --repo-rw escape was used.
      repoGit: m.repo ? (m.repoRw ? "rw" : "ro") : null,
      // Ephemeral worktree: parallel-safe, edits are isolated per-box.
      repoEphemeral: m.repoEphemeral,
      doors: m.doors.map((d) => ({
        name: d.name,
        socket: transportString(d.guest),
        env: d.env,
        grants: d.grants,
        caveats: d.caveats ?? [],
      })),
    },
    denied: m.denied.map((d) => ({ name: d.name, flag: d.flag })),
  });
}

/** Human-readable surface injected into the agent's context every launch. The
 *  room hands the man a rulebook keyed to exactly the doors present. */
function capabilityPrompt(m: Manifest): string {
  const lines: string[] = [
    ...capabilityPreamble("claude-box"),
    "",
    "GRANTED:",
    "- config: your own account's auth/history (a private volume).",
  ];
  if (m.repo) {
    if (m.repoRw) {
      lines.push(
        `- repo: ${m.repo} at /work — worktree AND .git WRITABLE (--repo-rw, unsafe). Only this worktree on the host is writable.`,
      );
    } else if (m.repoEphemeral) {
      lines.push(
        `- repo: ${m.repo} at /work — EPHEMERAL worktree (--repo-ephemeral). This is an isolated copy; your edits are local to this box and do not affect the original or other boxes. .git is READ-ONLY. Route commits through the keeper door.`,
      );
    } else {
      lines.push(
        `- repo: ${m.repo} at /work — worktree files are writable, but .git is READ-ONLY: you cannot commit/rewrite history in-box. Route commits through the keeper door. Do not try to edit .git/config or hooks; it will fail.`,
      );
    }
  }
  // The room hands the guest a card per granted door (engine-rendered).
  lines.push(...grantedDoorLines(m.doors));
  if (m.netOpen) {
    lines.push(
      "- network: UNRESTRICTED ambient egress (--net-open) — NO allowlist. Unsafe escape hatch; anything you send can reach any host.",
    );
  }
  lines.push("");
  // And a card per denied door (a symbol with no rule).
  lines.push(...deniedDoorSection(m.denied));
  return lines.join("\n");
}

/** Create an ephemeral git worktree at a temp path. Returns the path to the
 *  worktree. The caller is responsible for removing it with `git worktree remove`. */
async function createEphemeralWorktree(repo: string): Promise<string> {
  const id = crypto.randomUUID().slice(0, 8);
  const tmpDir = process.env.TMPDIR ?? "/tmp";
  const worktreePath = `${tmpDir}/claude-box-${id}`;

  // Get the current HEAD commit to check out
  const headProc = Bun.spawn(["git", "-C", repo, "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const headOut = (await new Response(headProc.stdout).text()).trim();
  const headErr = (await new Response(headProc.stderr).text()).trim();
  const headCode = await headProc.exited;
  if (headCode !== 0) {
    throw new Error(`failed to get HEAD: ${headErr}`);
  }

  // Create the worktree at the detached HEAD (no branch, just the commit)
  const proc = Bun.spawn(
    ["git", "-C", repo, "worktree", "add", "--detach", worktreePath, headOut],
    { stdout: "pipe", stderr: "pipe" },
  );
  const err = (await new Response(proc.stderr).text()).trim();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`failed to create ephemeral worktree: ${err}`);
  }
  return worktreePath;
}

/** Remove an ephemeral git worktree. */
async function removeEphemeralWorktree(
  repo: string,
  worktreePath: string,
): Promise<void> {
  const proc = Bun.spawn(
    ["git", "-C", repo, "worktree", "remove", "--force", worktreePath],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
  // Ignore errors — best effort cleanup
}

async function run(
  account: string,
  launch: Launch,
  env: Env = process.env,
): Promise<number> {
  assertAccount(account);
  const { guest, repo, repoRw, repoEphemeral, doors, netOpen, guestArgs } = launch;
  const guestPreset = knownGuests()[guest]!;
  const manifest = buildManifest(account, launch, env);
  const argv = [
    "podman",
    "run",
    "-it",
    "--rm",
    // Defense-in-depth floor (not a grant): the box needs no Linux caps and
    // never escalates, so cap a runaway/forky agent from fork-bombing or
    // privilege-escalating the host.
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "all",
    "--pids-limit",
    "2048",
  ];
  // Only mount the account's config volume for guests that need it (claude).
  // Tool guests don't need or want claude's auth/history.
  if (guestPreset.needsConfig) {
    argv.push("-v", `claude-${account}-config:/home/claude/.config/claude:U`);
  }
  // Network is a DOOR, not a NIC. Default to NO interface (nothing to exfiltrate
  // through, even with a repo mounted); the netd door (below) is the only
  // policed way out. `--net-open` is the loud, explicit, unsafe ambient-egress
  // escape — used only when no netd is running.
  const netDoor = doors.find((d) => d.name === "net");
  if (netOpen) {
    console.error(
      "claude-box: --net-open — UNPOLICED full network egress (no netd allowlist)",
    );
  } else {
    argv.push("--network=none");
    if (netDoor) {
      // The image entrypoint relays 127.0.0.1:3128 → the netd door; point every
      // egress client at it. The box holds no egress of its own — it can only
      // ASK netd, which owns the allowlist.
      argv.push(
        "--env",
        `HTTPS_PROXY=${NETD_PROXY}`,
        "--env",
        `HTTP_PROXY=${NETD_PROXY}`,
        "--env",
        `ALL_PROXY=${NETD_PROXY}`,
        "--env",
        "NO_PROXY=localhost,127.0.0.1",
      );
    }
  }
  // Forward each granted door (host socket → fixed in-box path) and export its
  // env so the box finds it — never the daemon's keys. Fail closed if the host
  // socket sits in a world-writable dir (hijack risk), for EVERY door.
  for (const d of doors) {
    const hostPath = unixPath(d.host);
    const guestPath = unixPath(d.guest);
    assertSocketDir(hostPath, d.name);
    argv.push("-v", `${hostPath}:${guestPath}`, "--env", `${d.env}=${guestPath}`);
  }
  // The machine-readable surface for the in-box runtime (prx tool-gating).
  argv.push("--env", `CLAUDE_BOX_CAPABILITIES=${capabilityJson(manifest)}`);

  // Track ephemeral worktree for cleanup
  let ephemeralWorktree: string | undefined;
  let originalRepo: string | undefined;

  if (repo) {
    const abs = resolve(repo);
    originalRepo = abs;

    // Ephemeral worktree: create a temp worktree at HEAD, mount that instead of
    // the live worktree. Parallel-safe (each box gets its own copy), and the
    // worktree is removed on exit. Still shares the same .git (read-only).
    let mountPath = abs;
    if (repoEphemeral) {
      try {
        ephemeralWorktree = await createEphemeralWorktree(abs);
        mountPath = ephemeralWorktree;
        console.error(
          `claude-box: --repo-ephemeral — created ephemeral worktree at ${ephemeralWorktree}`,
        );
      } catch (e) {
        console.error(`claude-box: failed to create ephemeral worktree: ${e}`);
        process.exit(2);
      }
    }

    // Mount the worktree RW at /work; map the host user → the in-box `claude`
    // uid so host-owned files line up (writable + no git "dubious ownership"),
    // WITHOUT chowning the repo.
    argv.push(
      "-v",
      `${mountPath}:/work`,
      "-w",
      "/work",
      "--userns=keep-id:uid=1000,gid=1000",
    );
    // Tell the box what the host path is, so keeperd requests can translate
    // /work → the actual host path (keeperd runs on the host, not in the box).
    // For ephemeral worktrees, use the original repo path so commits apply there.
    argv.push("--env", `CLAUDE_BOX_HOST_REPO=${abs}`);
    // A worktree's git dir lives in a bare repo OUTSIDE the worktree; mount that
    // common dir at its host path so `git` resolves inside the box.
    const common = await gitCommonDir(mountPath);
    const external = common && !common.startsWith(`${mountPath}/`);
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
        argv.push("-v", `${mountPath}/.git:/work/.git:ro`);
      }
    }
  }
  // Use the guest's image and entrypoint.
  argv.push(guestPreset.image);
  // For claude guest, inject the honest surface into the agent's context
  // (granted AND denied), so the box KNOWS its powers and limits. Tool guests
  // don't need or parse system prompts — they just run their command.
  if (guest === "claude") {
    argv.push("--append-system-prompt", capabilityPrompt(manifest));
  }
  // Add entrypoint override if the guest specifies one, then the args.
  if (guestPreset.entrypoint) {
    argv.push(...guestPreset.entrypoint);
  }
  argv.push(...guestArgs);
  const proc = Bun.spawn(argv, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;

  // Clean up ephemeral worktree on exit
  if (ephemeralWorktree && originalRepo) {
    console.error(
      `claude-box: cleaning up ephemeral worktree ${ephemeralWorktree}`,
    );
    await removeEphemeralWorktree(originalRepo, ephemeralWorktree);
  }

  return exitCode;
}

// ── Launcherd client ─────────────────────────────────────────────────────────

function launcherdSocketPath(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) return `${runtime}/launcherd.sock`;
  const home = process.env.HOME ?? "/tmp";
  return `${home}/.claude-box/launcherd.sock`;
}

async function launcherdRequest(
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const socketPath = launcherdSocketPath();
  const id = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    let buffer = "";
    Bun.connect({
      unix: socketPath,
      socket: {
        open(sock) {
          sock.write(JSON.stringify({ id, method, params }) + "\n");
        },
        data(_sock, data) {
          buffer += data.toString();
          const newline = buffer.indexOf("\n");
          if (newline >= 0) {
            const line = buffer.slice(0, newline);
            try {
              const resp = JSON.parse(line) as {
                id: string;
                ok: boolean;
                result?: unknown;
                error?: { message: string };
              };
              if (resp.ok) {
                resolve(resp.result);
              } else {
                reject(new Error(resp.error?.message ?? "launcherd error"));
              }
            } catch {
              reject(new Error("invalid response from launcherd"));
            }
          }
        },
        error(_sock, err) {
          reject(err);
        },
        close() {},
      },
    }).catch(reject);
  });
}

// ── Keeperd client ────────────────────────────────────────────────────────────

function keeperdSocketPath(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) return `${runtime}/keeperd.sock`;
  const home = process.env.HOME ?? "/tmp";
  return `${home}/.claude-box/keeperd.sock`;
}

async function keeperdRequest(
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const socketPath = keeperdSocketPath();
  const id = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    let buffer = "";
    Bun.connect({
      unix: socketPath,
      socket: {
        open(sock) {
          sock.write(JSON.stringify({ id, method, params }) + "\n");
        },
        data(_sock, data) {
          buffer += data.toString();
          const newline = buffer.indexOf("\n");
          if (newline >= 0) {
            const line = buffer.slice(0, newline);
            try {
              const resp = JSON.parse(line) as {
                id: string;
                ok: boolean;
                result?: unknown;
                error?: { message: string };
              };
              if (resp.ok) {
                resolve(resp.result);
              } else {
                reject(new Error(resp.error?.message ?? "keeperd error"));
              }
            } catch {
              reject(new Error("invalid response from keeperd"));
            }
          }
        },
        error(_sock, err) {
          reject(err);
        },
        close() {},
      },
    }).catch(reject);
  });
}

async function cmdKeeperStatus(): Promise<number> {
  try {
    const status = (await keeperdRequest("status")) as Record<string, unknown>;
    console.log("keeperd status:");
    console.log(`  version: ${status.version}`);
    console.log(`  uptime: ${status.uptime}s`);
    if (status.signing) {
      const signing = status.signing as { enabled: boolean; keyId?: string };
      console.log(
        `  signing: ${signing.enabled ? `enabled (${signing.keyId})` : "disabled"}`,
      );
    }
    return 0;
  } catch (e) {
    console.error(`keeperd not running: ${e}`);
    return 1;
  }
}

async function cmdKeeperKey(): Promise<number> {
  try {
    const result = (await keeperdRequest("getPublicKey")) as {
      publicKey: string;
      keyId: string;
    };
    console.log(result.publicKey);
    return 0;
  } catch (e) {
    console.error(`keeperd not running: ${e}`);
    return 1;
  }
}

async function cmdStatus(): Promise<number> {
  try {
    const status = (await launcherdRequest("status")) as Record<
      string,
      unknown
    >;
    console.log("launcherd status:");
    console.log(`  version: ${status.version}`);
    console.log(`  uptime: ${status.uptime}s`);
    console.log(`  active launches: ${status.launches}`);
    if (status.signing) {
      const signing = status.signing as { enabled: boolean; keyId?: string };
      console.log(
        `  signing: ${signing.enabled ? `enabled (${signing.keyId?.slice(0, 16)}...)` : "disabled"}`,
      );
    }
    if (status.policy) {
      const pol = status.policy as {
        enabled: boolean;
        defaultAllow?: string[];
        rulesCount?: number;
      };
      if (pol.enabled) {
        console.log(
          `  policy: enabled (${pol.rulesCount} rules, default: [${pol.defaultAllow?.join(", ") ?? "none"}])`,
        );
      } else {
        console.log("  policy: disabled (all rooms permitted)");
      }
    }
    console.log("  doors:");
    const doors = status.doors as Record<
      string,
      { socket: string; reachable: boolean }
    >;
    for (const [name, info] of Object.entries(doors)) {
      console.log(
        `    ${name}: ${info.reachable ? "reachable" : "unreachable"} (${info.socket})`,
      );
    }
    if (status.rooms) {
      console.log("  rooms:");
      const rooms = status.rooms as Record<string, string>;
      for (const [name, desc] of Object.entries(rooms)) {
        console.log(`    ${name}: ${desc}`);
      }
    }
    return 0;
  } catch (e) {
    console.error(`launcherd not running: ${e}`);
    return 1;
  }
}

async function cmdPs(): Promise<number> {
  try {
    const result = (await launcherdRequest("list")) as {
      launches: Array<{
        launchId: string;
        account: string;
        pid: number;
        startedAt: string;
        doors: string[];
        repo?: string;
        status: string;
      }>;
    };

    if (result.launches.length === 0) {
      console.log("no running boxes");
      return 0;
    }

    console.log(
      "LAUNCH ID                    ACCOUNT     PID    DOORS              REPO",
    );
    for (const l of result.launches) {
      const doors = l.doors.join(",") || "-";
      const repo = l.repo ?? "-";
      console.log(
        `${l.launchId.padEnd(28)} ${l.account.padEnd(11)} ${String(l.pid).padEnd(6)} ${doors.padEnd(18)} ${repo}`,
      );
    }
    return 0;
  } catch (e) {
    console.error(`launcherd not running: ${e}`);
    return 1;
  }
}

async function cmdKill(launchId: string): Promise<number> {
  if (!launchId) {
    console.error("usage: claude-box kill <launch-id>");
    return 1;
  }
  try {
    await launcherdRequest("kill", { launchId });
    console.log(`killed ${launchId}`);
    return 0;
  } catch (e) {
    console.error(`failed to kill ${launchId}: ${e}`);
    return 1;
  }
}

// ── Door management (Quadlet services) ────────────────────────────────────────

const DOOR_SERVICES = ["keeperd", "netd", "scoutd"] as const;

/** Run a command in the podman machine VM. */
async function podmanMachineExec(
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["podman", "machine", "ssh", "--", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Check if we're running with podman machine (macOS). */
async function hasPodmanMachine(): Promise<boolean> {
  const proc = Bun.spawn(
    ["podman", "machine", "list", "--format", "{{.Name}}"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.trim().length > 0;
}

/** Get the quadlet directory (relative to this script). */
function getQuadletDir(): string {
  return `${import.meta.dir}/quadlet`;
}

/** Build and load a daemon image. */
async function buildAndLoadImage(
  name: string,
): Promise<{ ok: boolean; error?: string }> {
  console.log(`  building ${name}-image...`);
  const build = Bun.spawn(["nix", "build", `.#${name}-image`, "--no-link", "--print-out-paths"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const buildOut = await new Response(build.stdout).text();
  const buildErr = await new Response(build.stderr).text();
  if ((await build.exited) !== 0) {
    return { ok: false, error: `nix build failed: ${buildErr}` };
  }
  const imagePath = buildOut.trim();
  if (!imagePath) {
    return { ok: false, error: "nix build produced no output" };
  }

  console.log(`  loading ${name}-image...`);
  const load = Bun.spawn(["podman", "load", "-i", imagePath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const loadErr = await new Response(load.stderr).text();
  if ((await load.exited) !== 0) {
    return { ok: false, error: `podman load failed: ${loadErr}` };
  }
  return { ok: true };
}

async function cmdDoors(subcmd: string, services: string[]): Promise<number> {
  const useMachine = await hasPodmanMachine();

  const runSystemctl = async (
    args: string[],
  ): Promise<{ ok: boolean; stdout: string; stderr: string }> => {
    if (useMachine) {
      return podmanMachineExec(["systemctl", "--user", ...args]);
    } else {
      const proc = Bun.spawn(["systemctl", "--user", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const code = await proc.exited;
      return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
    }
  };

  const targets =
    services.length > 0
      ? services.filter((s): s is (typeof DOOR_SERVICES)[number] =>
          DOOR_SERVICES.includes(s as any),
        )
      : [...DOOR_SERVICES];

  if (services.length > 0 && targets.length !== services.length) {
    console.error(
      `claude-box: unknown service(s). Known: ${DOOR_SERVICES.join(", ")}`,
    );
    return 1;
  }

  switch (subcmd) {
    case "status": {
      const mode = useMachine ? "podman-machine" : "native";
      console.log(`door status (${mode}):\n`);
      for (const svc of targets) {
        const result = await runSystemctl(["is-active", svc]);
        const status = result.ok ? "active" : result.stdout || "inactive";
        console.log(`  ${svc.padEnd(10)} ${status}`);
      }
      return 0;
    }
    case "start": {
      for (const svc of targets) {
        const result = await runSystemctl(["start", svc]);
        if (result.ok) {
          console.log(`started ${svc}`);
        } else {
          console.error(`failed to start ${svc}: ${result.stderr}`);
        }
      }
      return 0;
    }
    case "stop": {
      for (const svc of targets) {
        const result = await runSystemctl(["stop", svc]);
        if (result.ok) {
          console.log(`stopped ${svc}`);
        } else {
          console.error(`failed to stop ${svc}: ${result.stderr}`);
        }
      }
      return 0;
    }
    case "restart": {
      for (const svc of targets) {
        const result = await runSystemctl(["restart", svc]);
        if (result.ok) {
          console.log(`restarted ${svc}`);
        } else {
          console.error(`failed to restart ${svc}: ${result.stderr}`);
        }
      }
      return 0;
    }
    case "logs": {
      const svc = targets[0];
      if (!svc) {
        console.error("usage: claude-box doors logs <service>");
        return 1;
      }
      if (useMachine) {
        const proc = Bun.spawn(
          [
            "podman",
            "machine",
            "ssh",
            "--",
            "journalctl",
            "--user",
            "-u",
            svc,
            "-f",
          ],
          { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
        );
        return proc.exited;
      } else {
        const proc = Bun.spawn(["journalctl", "--user", "-u", svc, "-f"], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        return proc.exited;
      }
    }
    case "ensure": {
      // Start any door services that aren't running (doesn't rebuild/reinstall)
      console.log("Ensuring door services are running...\n");
      let allOk = true;
      for (const svc of DOOR_SERVICES) {
        const check = await runSystemctl(["is-active", svc]);
        if (check.ok) {
          console.log(`  ${svc.padEnd(10)} already active`);
        } else {
          const start = await runSystemctl(["start", svc]);
          if (start.ok) {
            console.log(`  ${svc.padEnd(10)} started`);
          } else {
            console.error(`  ${svc.padEnd(10)} failed: ${start.stderr}`);
            allOk = false;
          }
        }
      }
      if (!allOk) {
        console.log("\nSome services failed. Try 'claude-box doors init' to reinstall.");
      }
      return allOk ? 0 : 1;
    }
    case "init": {
      // One-shot setup: build images, install quadlet units, start services
      const quadletDir = getQuadletDir();
      const mode = useMachine ? "podman-machine" : "native";
      console.log(`Initializing door services (${mode})...\n`);

      // 1. Build and load images
      console.log("Step 1: Building and loading images...");
      for (const svc of DOOR_SERVICES) {
        const result = await buildAndLoadImage(svc);
        if (!result.ok) {
          console.error(`  ${svc}: ${result.error}`);
          return 1;
        }
        console.log(`  ${svc}: loaded`);
      }

      // 2. Install quadlet units
      console.log("\nStep 2: Installing quadlet units...");
      const unitFiles = [
        "claude-doors.volume",
        "claude-keys.volume",
        "keeperd.container",
        "netd.container",
        "scoutd.container",
      ];
      if (useMachine) {
        // Create systemd directory in VM
        await podmanMachineExec([
          "mkdir",
          "-p",
          "/var/home/core/.config/containers/systemd",
        ]);
        // Copy each unit file using stdin piping
        for (const file of unitFiles) {
          const content = await Bun.file(`${quadletDir}/${file}`).text();
          const dest = `/var/home/core/.config/containers/systemd/${file}`;
          const proc = Bun.spawn(
            ["podman", "machine", "ssh", "--", "sh", "-c", `cat > '${dest}'`],
            { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
          );
          proc.stdin.write(content);
          proc.stdin.end();
          await proc.exited;
          console.log(`  ${file}`);
        }
        // Reload systemd
        await podmanMachineExec(["systemctl", "--user", "daemon-reload"]);
      } else {
        // Native Linux: copy to ~/.config/containers/systemd/
        const home = process.env.HOME ?? "/tmp";
        const systemdDir = `${home}/.config/containers/systemd`;
        await Bun.spawn(["mkdir", "-p", systemdDir]).exited;
        for (const file of unitFiles) {
          await Bun.spawn(["cp", `${quadletDir}/${file}`, systemdDir]).exited;
          console.log(`  ${file}`);
        }
        // Reload systemd
        await Bun.spawn(["systemctl", "--user", "daemon-reload"]).exited;
      }
      console.log("  daemon-reload done");

      // 3. Start services
      console.log("\nStep 3: Starting services...");
      for (const svc of DOOR_SERVICES) {
        const result = await runSystemctl(["start", svc]);
        if (result.ok) {
          console.log(`  ${svc}: started`);
        } else {
          console.error(`  ${svc}: failed - ${result.stderr}`);
        }
      }

      // 4. Show status
      console.log("\nDone! Status:");
      for (const svc of DOOR_SERVICES) {
        const result = await runSystemctl(["is-active", svc]);
        const status = result.ok ? "active" : result.stdout || "inactive";
        console.log(`  ${svc.padEnd(10)} ${status}`);
      }
      console.log("\nRun 'claude-box --room dev --repo .' to launch with all doors.");
      return 0;
    }
    default:
      console.log(`claude-box doors — manage door services

Usage:
  claude-box doors init              one-shot setup (build images, install units, start)
  claude-box doors ensure            start any stopped services (fast, no rebuild)
  claude-box doors status [svc...]   show status of door services
  claude-box doors start [svc...]    start door services
  claude-box doors stop [svc...]     stop door services
  claude-box doors restart [svc...]  restart door services
  claude-box doors logs <svc>        follow logs for a service

Services: ${DOOR_SERVICES.join(", ")}

Examples:
  claude-box doors init              first-time setup (run once)
  claude-box doors ensure            quick restart after reboot
  claude-box doors status            status of all doors
  claude-box doors start keeperd     start just keeperd
  claude-box doors logs netd         follow netd logs`);
      return subcmd === "-h" || subcmd === "--help" ? 0 : 1;
  }
}

async function cmdAttach(launchId: string): Promise<number> {
  if (!launchId) {
    console.error("usage: claude-box attach <launch-id>");
    return 1;
  }
  try {
    const result = (await launcherdRequest("attach", { launchId })) as {
      launchId: string;
      container: string;
      command: string;
      hint: string;
    };
    console.log(result.hint);
    console.log(`\n  ${result.command}\n`);
    // Optionally, we could exec the command directly:
    // const proc = Bun.spawn(["podman", "attach", result.container], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    // return proc.exited;
    return 0;
  } catch (e) {
    console.error(`failed to attach: ${e}`);
    return 1;
  }
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
    case "status":
      return cmdStatus();
    case "ps":
      return cmdPs();
    case "kill":
      return cmdKill(rest[0] ?? "");
    case "attach":
      return cmdAttach(rest[0] ?? "");
    case "doors":
      return cmdDoors(rest[0] ?? "", rest.slice(1));
    case "keeper-status":
      return cmdKeeperStatus();
    case "keeper-key":
      return cmdKeeperKey();
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
export {
  knownDoors,
  knownRooms,
  knownGuests,
  resolveDoor,
  planLaunch,
  buildManifest,
  capabilityJson,
  capabilityPrompt,
  transportString,
  unix,
  unixPath,
};
export type { DoorGrant, DoorTransport, Manifest, Launch, GuestPreset };

if (import.meta.main) {
  process.exit(await main());
}
