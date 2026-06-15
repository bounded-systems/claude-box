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

import { existsSync, mkdirSync, statSync, rmSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
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
  tcp,
  attenuate,
} from "./guest-room/mod.ts";

const IMAGE = "localhost/claude-personal:dev";
const VOLUME_RE = /^claude-(.*)-config$/;

// ── TCP mode ports (for macOS ↔ podman machine) ──────────────────────────────
// When daemons run on the macOS host with --port, containers reach them via
// host.containers.internal:PORT. These are the canonical ports for TCP mode.
const TCP_PORTS: Record<string, number> = {
  keeperd: 3001,
  netd: 3128,  // HTTP proxy port
  scoutd: 3002,
};

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
// The in-box config dir = the account volume's mount point, where claude keeps
// auth/settings/history (incl. `claude auth login`). It MUST equal the image's
// CLAUDE_CONFIG_DIR / $XDG_CONFIG_HOME/claude (flake.nix). One path, both sides;
// tests/xdg.test.ts pins this against flake.nix so they can't drift.
const BOX_CONFIG_DIR = "/home/claude/.config/claude";
// The loopback proxy the in-box relay exposes; the image entrypoint forwards it
// to the netd door (/run/netd.sock). Egress clients route here (HTTPS_PROXY=…).
const NETD_PROXY = "http://127.0.0.1:3128";

// In TCP mode (DOORS_TCP=1), the proxy points directly to netd on the host.
const NETD_TCP_PROXY = `http://host.containers.internal:${TCP_PORTS.netd}`;


/** Detect if we're in TCP mode (daemons running on TCP ports, not sockets).
 *  Set DOORS_TCP=1 or run `doors serve` to enable TCP mode. */
function isTcpMode(env: Env): boolean {
  return env.DOORS_TCP === "1" || env.DOORS_TCP === "true";
}

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

/** Resolve a --writable subtree to a repo-relative path, rejecting escapes.
 *  Returned rel is used to bind-mount repo/<rel> writable over a read-only /work,
 *  so it must stay strictly inside the repo (no "", ".", "..", or absolute path). */
function resolveWritableSubtree(repoAbs: string, sub: string): string {
  const rel = relative(repoAbs, resolve(repoAbs, sub));
  if (rel === "" || rel === "." || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`--writable must be a subtree of the repo, got: ${sub}`);
  }
  return rel;
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
 *  for EVERY door — so the /tmp default is refused unless a private path is set. */
function assertSocketDir(sock: string, _doorName?: string): void {
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
}

/** Check socket file exists (daemon running). Uses existsSync to avoid statfs
 *  issues with virtiofs-shared sockets on macOS ↔ podman machine. */
function assertSocketExists(sock: string, doorName?: string): void {
  if (!existsSync(sock)) {
    const hint = doorName && DAEMON_HINTS[doorName];
    const startCmd = hint ? `\n  Start it with: ${hint}` : "";
    console.error(
      `claude-box: door socket ${sock} does not exist (daemon not running?)${startCmd}`,
    );
    process.exit(2);
  }
}

/** True if a TCP listener accepts a connection at host:port within the timeout.
 *  The TCP-mode counterpart to assertSocketExists's existsSync check. */
async function tcpReachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    await Promise.race([
      Bun.connect({
        hostname: host,
        port,
        socket: { open(s) { s.end(); }, data() {}, error() {} },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** TCP-mode preflight: fail fast with a hint if a door's daemon isn't listening.
 *  Without this the box launches fine and the in-box agent dies later with an
 *  opaque "API Error: Connection error" the moment it touches the door — because
 *  the unix-socket path has assertSocketExists but the TCP path had no check.
 *
 *  Keyed off TCP_PORTS, not the door's transport: room-expanded doors keep unix
 *  transports even in TCP mode (TCP egress is wired separately via HTTPS_PROXY),
 *  so we check the daemon's actual listen port on the host loopback. Doors with
 *  no TCP daemon (e.g. launcher) are skipped. */
async function assertTcpDoorReachable(doorName: string): Promise<void> {
  const port = TCP_PORTS[`${doorName}d`];
  if (port === undefined) return;
  if (await tcpReachable("127.0.0.1", port)) return;
  const hint = DAEMON_HINTS[doorName];
  console.error(
    `claude-box: door '${doorName}' daemon not reachable at 127.0.0.1:${port} — are the doors running?\n` +
      `  Start all doors with: claude-box doors serve` +
      (hint ? `\n  (or just ${doorName}: ${hint})` : ""),
  );
  process.exit(2);
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
      inBox: "/run/doors/keeperd.sock",
      env: "KEEPERD_SOCK",
      hostDefault: env.KEEPERD_SOCK ?? defaultHostSock("keeperd", env),
      grants: "signed git writes (commit/push/refs) via keeperd",
      use: "Route every git write through keeperd at /run/doors/keeperd.sock ($KEEPERD_SOCK). You hold NO git credentials and NO signing key — request a signed write and keeperd performs it. A raw `git push` cannot work; there is nothing in the box to push with.",
      deny: "No git-write authority in this box. Do not push, mutate refs, or claim a commit landed on a remote — it will fail. If the task needs it, it must be RELAUNCHED with --keeper.",
    },
    beads: {
      flag: "--beads",
      inBox: "/run/doors/beadsd.sock",
      env: "BEADSD_SOCK",
      hostDefault: env.BEADSD_SOCK ?? defaultHostSock("beadsd", env),
      grants: "beads reads/writes via beadsd",
      use: "Route beads operations through beadsd at /run/doors/beadsd.sock ($BEADSD_SOCK).",
      deny: "No beads access in this box. Do not attempt bd reads/writes; relaunch with --beads if the task needs them.",
    },
    // The read door (GH-5). Dropping `gh` unbundled its powers: writes → keeper,
    // raw egress → net, and READS → scout. scoutd holds the read tokens + fetch
    // policy and returns CONTENT, never a credential or live socket — a box can
    // read repos/PRs/URLs with no token and even no NIC (--network=none). See
    // SCOUT.md; the read twin of keeperd (writes).
    scout: {
      flag: "--scout",
      inBox: "/run/doors/scoutd.sock",
      env: "SCOUTD_SOCK",
      hostDefault: env.SCOUTD_SOCK ?? defaultHostSock("scoutd", env),
      grants:
        "read external artifacts (repos/PRs/URLs) via scoutd (you hold no read tokens)",
      use: "Read external content through the scout door at /run/doors/scoutd.sock ($SCOUTD_SOCK): ask scoutd to fetch a repo/PR/issue/URL and it returns CONTENT, never a token or live socket. You hold NO read credentials and NO network for reads — scoutd owns the read tokens + allowlist. A host/scope it refuses is final; do not retry or tunnel around it.",
      deny: "No external reads in this box — do not assume you can clone, fetch, or browse; there is no token and no read route. Do not claim a fetch succeeded. If the task needs external reads, relaunch with --scout.",
    },
    // The egress door. Unlike the others it carries LAUNCH EFFECTS: the box runs
    // --network=none and routes HTTPS_PROXY → the relay → this socket, so netd's
    // allowlist is the only way out (see run() + CAPABILITIES.md "Network is a
    // door — not a NIC"). The daemon is the network twin of keeperd/beadsd.
    net: {
      flag: "--net",
      inBox: "/run/doors/netd.sock",
      env: "NETD_SOCK",
      hostDefault: env.NETD_SOCK ?? defaultHostSock("netd", env),
      grants: "policed network egress via the netd allowlist proxy",
      use: "All egress goes through the netd door at /run/doors/netd.sock ($NETD_SOCK); HTTPS_PROXY is set for you. You can reach ONLY hosts netd's allowlist permits — there is no other route off the box. A blocked host is final; do not retry or tunnel around it.",
      deny: "No network. This box runs --network=none with no egress door — you cannot reach any host. Do not attempt network calls or claim they worked; relaunch with --net for policed egress (or --net-open for unrestricted, unsafe egress).",
    },
    // The launcher door — spawn sub-boxes without holding podman. The box asks
    // launcherd to spawn; launcherd owns the runtime and enforces policy. This
    // enables the self-hosting loop (Claude launching Claude) without privilege
    // escalation. See LAUNCHERD.md.
    launcher: {
      flag: "--launcher",
      inBox: "/run/doors/launcherd.sock",
      env: "LAUNCHERD_SOCK",
      hostDefault: env.LAUNCHERD_SOCK ?? defaultHostSock("launcherd", env),
      grants: "spawn sub-boxes via launcherd (you hold no runtime)",
      use: "Spawn sub-boxes by requesting through launcherd at /run/doors/launcherd.sock ($LAUNCHERD_SOCK). You hold NO podman, NO runtime — request a spawn with a capability profile and launcherd performs it. Send JSON requests: {op:'spawn', profile:'work', doors:['keeper','net']}. The sub-box inherits doors you specify (if policy permits).",
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
 *  path + rulebook; any other name becomes a generic service door.
 *
 *  In TCP mode (DOORS_TCP=1), doors use TCP transports:
 *  - host: tcp("127.0.0.1", port) — where daemons listen
 *  - guest: tcp("host.containers.internal", port) — where containers connect */
function resolveDoor(name: string, host: string | undefined, env: Env = process.env): DoorGrant {
  const base = resolveDoorIn(knownDoors(env), name, host, env);

  // In TCP mode, override transports for known doors with TCP ports
  if (isTcpMode(env)) {
    const daemonName = `${name}d`;  // net → netd, keeper → keeperd, etc.
    const port = TCP_PORTS[daemonName];
    if (port !== undefined) {
      // TCP mode mounts NO /run/doors — the door is reached over the host gateway.
      // The transport override below is correct, but base.use still names the unix
      // path, which is the exact "wired but undiallable" lie a live box hit (net
      // worked via HTTPS_PROXY; scout's guidance pointed at an absent socket). Keep
      // the guidance honest by swapping the unix path for the real TCP endpoint —
      // the same value $${ENV} carries. (The full transport-agnostic client is
      // prx-o92; this just stops the guidance from misleading the agent.)
      const endpoint = `host.containers.internal:${port}`;
      const unixHint = `/run/doors/${daemonName}.sock`;
      return {
        ...base,
        host: tcp("127.0.0.1", port),
        guest: tcp("host.containers.internal", port),
        use: base.use.split(unixHint).join(endpoint),
      };
    }
  }
  return base;
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
  --repo-clone PATH   isolated clone w/ own writable .git (full in-box git,
                      real repo never mounted; reconcile via --keeper)
  --repo-origin URL   NO host mount: box clones URL into a tmpfs /work itself
                      (auto scoped-egress door to the origin host; needs DOORS_TCP)
  --repo-rw PATH      UNSAFE: worktree AND .git writable
  --writable PATH     narrow the writable surface: /work read-only except PATH
                      (repeatable; .git stays read-only; writes via --keeper)
  --net               forward the netd door — policed egress
  --net-open          UNSAFE: full ambient egress, no allowlist
  --remote-control    opt-in: drive this boxed session from the Claude app/mobile
                      (implies --net; uses a full-scope in-box 'claude auth login'
                      instead of the inference-only token; first run: log in once)
  --pod               run the box + its netd door in an isolated pod (off-host)
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
  claude-box doctor           flag boxes pinned to a stale image (after a rebuild)
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

/** Pure: assemble the repo bind-mount argv fragment for a launch. Extracted from
 *  run() so the .git posture — read-only host-RCE boundary (--repo) vs the unsafe
 *  writable-.git escape (--repo-rw) — is unit-testable WITHOUT spawning podman.
 *  The caller does the side-effecting work first: resolve `common`/`external`
 *  (the async git query) and validate `writableRels` (escape + existence). This
 *  is then a pure function of its inputs. Mount ORDER matters: the /work base
 *  comes first, then writable subtrees, then the .git overlay — later mount wins
 *  (podman), so the .git :ro overlay always lands on top of the writable base. */
function planRepoMount(opts: {
  mountPath: string;
  repoRw: boolean;
  repoClone: boolean;
  narrowWritable: boolean;
  writableRels: string[];
  common?: string;
  external: boolean;
}): string[] {
  const { mountPath, repoRw, repoClone, narrowWritable, writableRels, common, external } = opts;
  // Map the host user → the in-box `claude` uid so host-owned files line up
  // (writable + no git "dubious ownership") WITHOUT chowning the repo. RO base
  // when narrowing; subtree mounts follow.
  const argv: string[] = [
    "-v",
    narrowWritable ? `${mountPath}:/work:ro` : `${mountPath}:/work`,
    "-w",
    "/work",
    "--userns=keep-id:uid=1000,gid=1000",
  ];
  if (narrowWritable) {
    // Bind each validated subtree writable over the read-only /work base.
    for (const rel of writableRels) {
      argv.push("-v", `${mountPath}/${rel}:/work/${rel}`);
    }
  }
  if (repoClone) {
    // The clone IS /work, self-contained with its OWN writable .git. A throwaway
    // (real repo never mounted), so a planted hook only runs inside the disposable
    // clone — no host-RCE. No .git overlay.
    return argv;
  }
  if (repoRw) {
    // UNSAFE escape: .git stays WRITABLE. A box that writes .git/hooks or
    // .git/config gets host code execution when you next run git. For a worktree
    // the common dir lives outside /work — mount it (writable) at its host path;
    // for a normal repo it's already inside the writable /work.
    if (external && common) argv.push("-v", `${common}:${common}`);
    return argv;
  }
  // SAFE default (--repo): worktree files stay writable (the agent edits code),
  // but .git is READ-ONLY so the box can't plant a hook/config that executes on
  // the host. History writes go through the keeper door, not the mount.
  if (external && common) {
    // worktree: the bare/common dir (config + hooks + this worktree's gitdir) is
    // outside /work — mount it read-only at its host path.
    argv.push("-v", `${common}:${common}:ro`);
  } else {
    // normal repo: .git is inside the worktree — overlay it :ro over /work.
    argv.push("-v", `${mountPath}/.git:/work/.git:ro`);
  }
  return argv;
}

// ── Launch planning + the capability manifest ────────────────────────────────

type Launch = {
  guest: string;
  repo?: string;
  repoRw: boolean;
  repoEphemeral: boolean;
  /** --repo-clone: mount an isolated clone with its OWN writable .git (real repo
   *  never mounted). Full in-box git; reconcile to the source via keeper. */
  repoClone: boolean;
  /** --repo-origin URL: NO host mount at all. The box clones URL into a writable
   *  container-internal /work (tmpfs) and runs the guest there. The repo enters
   *  as content through the net door (netd must allow the origin host). */
  repoOrigin?: string;
  /** --pod: launch the box in its OWN podman pod with a netd sidecar (doors off
   *  the host, pod-local, isolated). See POD.md / DOORS.md. v1 = net egress. */
  pod: boolean;
  /** --writable subtrees: when non-empty, /work is mounted READ-ONLY and only
   *  these paths are bind-mounted writable (narrowed blast radius). */
  writable: string[];
  doors: DoorGrant[];
  netOpen: boolean;
  /** --remote-control: opt-in profile to drive THIS boxed session from the Claude
   *  app / mobile (`claude remote-control`). Relaxes two box defaults, scoped to
   *  this launch only: (1) does NOT forward the inference-only setup-token (so a
   *  full-scope in-box `claude auth login`, persisted in the account volume, wins
   *  — RC rejects inference-only tokens), and (2) unsets the image's
   *  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC so the RC feature-flag gate can
   *  evaluate. Implies the net door (RC needs egress). See prx-9s14. */
  remoteControl: boolean;
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
  let repoClone = false;
  let repoOrigin: string | undefined;
  let pod = false;
  let netOpen = false;
  let remoteControl = false;
  const writable: string[] = [];
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
    if (t === "--repo-clone") {
      // Isolated clone with its OWN writable .git (the real repo is never
      // mounted). Full in-box git; reconcile commits to the source via keeper.
      repo = tail[++i];
      repoClone = true;
      continue;
    }
    if (t === "--repo-origin") {
      // No host mount: the box clones URL into a tmpfs /work itself. The repo
      // enters as content through the net door (netd must allow the origin host).
      const url = tail[++i] ?? "";
      if (!/^(https?:\/\/|git@[\w.-]+:|ssh:\/\/)/.test(url)) {
        throw new Error(
          `--repo-origin needs an https/ssh git URL, got: ${JSON.stringify(url)}`,
        );
      }
      repoOrigin = url;
      continue;
    }
    if (t === "--writable") {
      // Repeatable: narrow the writable surface to these subtrees (the rest of
      // /work is read-only). Validated against the repo at launch.
      const p = tail[++i];
      if (p) writable.push(p);
      continue;
    }
    if (t === "--pod") {
      // Launch in an isolated pod with a netd sidecar — doors off the host.
      pod = true;
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
    if (t === "--remote-control") {
      // Opt-in: drive this boxed session from the Claude app (see Launch.remoteControl).
      // RC needs egress, so imply the net door (the Map dedupes if --net is also given).
      remoteControl = true;
      add(resolveDoor("net", undefined, env));
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
    repoClone,
    repoOrigin,
    pod,
    writable,
    doors: [...doors.values()],
    netOpen,
    remoteControl,
    guestArgs,
  };
}

/** Pure: the auth-related --env / --unsetenv podman fragment for a launch.
 *
 *  Default posture (headless): forward a pre-minted `claude setup-token` from
 *  CLAUDE_CODE_OAUTH_TOKEN — inference-only, no in-box browser flow needed.
 *
 *  --remote-control posture: do NOT forward the token (it is inference-only and
 *  CANNOT establish Remote Control; and as env it would override, per the auth
 *  precedence table, the full-scope `claude auth login` credential the user
 *  persists in the account volume). Also unset the image-baked
 *  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC so the RC feature-flag gate
 *  (tengu_ccr_bridge, delivered via GrowthBook) can evaluate. Both relaxations
 *  are scoped to this one launch — the default box is unchanged. */
function authEnvArgs(launch: Launch, env: Env = process.env): string[] {
  if (launch.remoteControl) {
    return ["--unsetenv", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"];
  }
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    return ["--env", `CLAUDE_CODE_OAUTH_TOKEN=${env.CLAUDE_CODE_OAUTH_TOKEN}`];
  }
  return [];
}

type Manifest = {
  account: string;
  guest: string;
  repo?: string;
  repoRw: boolean;
  repoEphemeral: boolean;
  repoClone: boolean;
  repoOrigin?: string;
  writable: string[];
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
  return { account, guest: launch.guest, repo: launch.repo, repoRw: launch.repoRw, repoEphemeral: launch.repoEphemeral, repoClone: launch.repoClone ?? false, repoOrigin: launch.repoOrigin, writable: launch.writable ?? [], doors: launch.doors, netOpen: launch.netOpen, denied };
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
      // Isolated clone: full in-box git on a throwaway .git; the real repo is
      // never mounted — reconcile commits to the source via the keeper door.
      repoClone: m.repoClone,
      // Origin clone: NO host mount; the box cloned this URL into a container-
      // internal /work through the net door. null ⇒ not an origin-clone launch.
      repoOrigin: m.repoOrigin ?? null,
      // Narrowed writable surface: when set, /work is read-only except these
      // subtrees (null ⇒ the whole worktree is writable).
      writable: m.writable.length ? m.writable : null,
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
  if (m.repoOrigin) {
    lines.push(
      `- repo: ${m.repoOrigin} at /work — a FRESH CLONE FROM ORIGIN. There is NO host mount; the box cloned the repo into a container-internal /work through a git-pull door scoped to ONLY the origin host (separate from your anthropic egress, and used only for that one clone). Full in-box git with no further egress; this is a throwaway checkout, so push back through the keeper door. The host filesystem is not exposed at all.`,
    );
  }
  if (m.repo) {
    if (m.repoRw) {
      lines.push(
        `- repo: ${m.repo} at /work — worktree AND .git WRITABLE (--repo-rw, unsafe). Only this worktree on the host is writable.`,
      );
    } else if (m.repoEphemeral) {
      lines.push(
        `- repo: ${m.repo} at /work — EPHEMERAL worktree (--repo-ephemeral). This is an isolated copy; your edits are local to this box and do not affect the original or other boxes. .git is READ-ONLY. Route commits through the keeper door.`,
      );
    } else if (m.repoClone) {
      lines.push(
        `- repo: ${m.repo} at /work — ISOLATED CLONE (--repo-clone). You have FULL in-box git: commit, branch, rebase freely. This is a throwaway clone; nothing reaches the real repo until you reconcile through the keeper door. The real repo is not mounted, so you cannot corrupt it.`,
      );
    } else if (m.writable.length) {
      lines.push(
        `- repo: ${m.repo} at /work — /work is READ-ONLY except: ${m.writable.join(", ")}. Edits outside those subtrees will fail. .git is READ-ONLY; route commits through the keeper door.`,
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

/** The single source of truth for box-mounted temp dirs. Rooted under $HOME
 *  (XDG_CACHE_HOME, else ~/.cache) — NEVER /tmp. On macOS the podman VM only
 *  shares $HOME, so a /tmp-rooted bind mount fails the box launch with exit 125.
 *  Centralizing temp creation here makes that mistake structurally impossible for
 *  any current or future mount path, rather than a rule humans/agents must recall.
 *  The directory is created (recursive) before returning. */
function boxTempBase(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const cache = xdg?.startsWith("/") ? xdg : join(homedir(), ".cache");
  const base = join(cache, "claude-box");
  mkdirSync(base, { recursive: true });
  return base;
}

/** Create an ephemeral git worktree at a temp path. Returns the path to the
 *  worktree. The caller is responsible for removing it with `git worktree remove`. */
async function createEphemeralWorktree(repo: string): Promise<string> {
  const id = crypto.randomUUID().slice(0, 8);
  const worktreePath = join(boxTempBase(), `worktree-${id}`);

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

/** Create an isolated clone of the repo at a temp path: a STANDALONE repo with
 *  its OWN writable .git (origin → the source). The box gets full in-box git
 *  (commit/branch) and the writes land in the throwaway clone, never the real
 *  .git — so in-box git ergonomics WITHOUT the host-RCE risk of --repo-rw.
 *  `--local` hardlinks objects (fast, cheap); git objects are immutable so the
 *  source is never mutated. Reconcile the clone's commits to the source via the
 *  keeper door (increment 2). Caller removes the dir when done. */
async function createIsolatedClone(repo: string): Promise<string> {
  const id = crypto.randomUUID().slice(0, 8);
  const clonePath = join(boxTempBase(), `clone-${id}`);
  const proc = Bun.spawn(
    ["git", "clone", "--local", "--no-hardlinks", repo, clonePath],
    { stdout: "pipe", stderr: "pipe" },
  );
  const err = (await new Response(proc.stderr).text()).trim();
  if ((await proc.exited) !== 0) {
    throw new Error(`failed to create isolated clone: ${err}`);
  }
  return clonePath;
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

/** The egress host a git URL connects to — used to scope a --repo-origin door
 *  to exactly that host (plus anthropic), nothing wider. */
function originHostOf(url: string): string {
  const https = /^https?:\/\/([^/]+)/.exec(url);
  if (https) return https[1].split("@").pop()!.split(":")[0].toLowerCase();
  const ssh = /^(?:ssh:\/\/)?[^@/]+@([^:/]+)/.exec(url);
  if (ssh) return ssh[1].toLowerCase();
  throw new Error(`cannot derive origin host from ${url}`);
}

/** Start a per-launch netd scoped to `allow`, on a free port. Returns the port +
 *  a stop(). Lets --repo-origin reach its origin host through a POLICED door
 *  without widening the shared netd or resorting to --net-open. */
async function startScopedNetd(
  allow: string[],
): Promise<{ port: number; stop: () => void }> {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
  const port = probe.port;
  probe.stop();
  // Run the netd script via the cached nixpkgs#bun (fast) rather than building
  // the .#netd derivation (slow cold-start on every launch). Same netd code.
  const proc = Bun.spawn(
    ["nix", "run", "nixpkgs#bun", "--", `${import.meta.dir}/netd/netd.ts`, "serve", "--port", String(port)],
    {
      env: { ...process.env, NETD_ALLOW: allow.join(",") },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  for (let i = 0; i < 150; i++) {
    if (await tcpReachable("127.0.0.1", port, 400)) return { port, stop: () => proc.kill() };
    await Bun.sleep(200);
  }
  proc.kill();
  throw new Error("scoped netd failed to start");
}

/**
 * --pod: launch the box in its OWN podman pod, with a netd door as a SIDECAR
 * sharing the pod's network namespace (POD.md / DOORS.md). The box reaches netd
 * at `localhost:3128` — no host port, no `host.containers.internal`, nothing the
 * operator or another box can disturb. The netd's lifetime = the pod's (the
 * default door window). v1: net egress only; `--repo-origin` (clone-in-box) or
 * no repo. Host-mount `--repo` in a pod is a follow-up.
 */
async function runPod(account: string, launch: Launch): Promise<number> {
  const { guest, repo, repoOrigin, guestArgs } = launch;
  if (repo) {
    console.error(
      "claude-box: --pod v1 supports --repo-origin or no repo; host-mount --repo in a pod is a follow-up (POD.md).",
    );
    process.exit(2);
  }
  const guestPreset = knownGuests()[guest]!;
  const manifest = buildManifest(account, launch);

  // The pod's netd door: anthropic egress + (if cloning in-box) the origin host.
  const allow = ["api.anthropic.com", ".anthropic.com"];
  if (repoOrigin) allow.push(originHostOf(repoOrigin));

  const id = crypto.randomUUID().slice(0, 8);
  const podName = `claude-box-${account}-${id}`;
  const netdName = `${podName}-netd`;
  const sh = (a: string[]) => Bun.spawnSync(a, { stdout: "pipe", stderr: "pipe" });

  const created = sh(["podman", "pod", "create", "--name", podName]);
  if (created.exitCode !== 0) {
    console.error(`claude-box: pod create failed: ${created.stderr.toString().trim()}`);
    process.exit(2);
  }

  try {
    // netd SIDECAR — the egress door, in the pod's netns. Runs the netd script
    // from this source tree via the image's bun (no separate daemon image yet).
    const netd = sh([
      "podman", "run", "-d", "--pod", podName, "--name", netdName,
      "-v", `${import.meta.dir}:/src:ro`,
      "-e", `NETD_ALLOW=${allow.join(",")}`,
      "--entrypoint", "bun", IMAGE, "/src/netd/netd.ts", "serve", "--port", "3128",
    ]);
    if (netd.exitCode !== 0) {
      console.error(`claude-box: netd sidecar failed: ${netd.stderr.toString().trim()}`);
      process.exit(2);
    }
    console.error(`claude-box: --pod — netd door in pod ${podName} (allow=${allow.join(",")}); doors are OFF the host`);

    // Wait for netd to bind inside the pod (the image's sh has /dev/tcp).
    let up = false;
    for (let i = 0; i < 40; i++) {
      if (sh(["podman", "exec", netdName, "sh", "-c", "(exec 3<>/dev/tcp/localhost/3128) 2>/dev/null"]).exitCode === 0) {
        up = true;
        break;
      }
      await Bun.sleep(300);
    }
    if (!up) {
      console.error("claude-box: netd door did not come up in the pod");
      process.exit(2);
    }

    // The BOX in the same pod reaches netd at pod-localhost.
    const proxy = "http://localhost:3128";
    const argv = [
      "podman", "run", "-it", "--rm", "--pod", podName,
      "--security-opt", "no-new-privileges", "--cap-drop", "all", "--pids-limit", "2048",
    ];
    if (guestPreset.needsConfig) {
      argv.push("-v", `claude-${account}-config:${BOX_CONFIG_DIR}:U`);
    }
    // Auth: inference-only setup-token by default; --remote-control omits it for
    // a full-scope in-box login (see authEnvArgs).
    argv.push(...authEnvArgs(launch, process.env));
    argv.push(
      "--env", `HTTPS_PROXY=${proxy}`, "--env", `HTTP_PROXY=${proxy}`,
      "--env", `ALL_PROXY=${proxy}`, "--env", `https_proxy=${proxy}`,
      "--env", `http_proxy=${proxy}`, "--env", "NO_PROXY=localhost,127.0.0.1",
      "--env", `CLAUDE_BOX_CAPABILITIES=${capabilityJson(manifest)}`,
    );
    const guestCmd = guestPreset.entrypoint?.[0] ?? (guest === "claude" ? "claude" : "sh");
    if (repoOrigin) {
      // Clone-in-box via the pod's netd (localhost proxy is inherited), then run.
      argv.push(
        "--tmpfs", "/work:rw,mode=1777", "-w", "/work", "--entrypoint", "sh", IMAGE,
        "-c",
        // GIT_TERMINAL_PROMPT=0 + GIT_ASKPASS: a private/401 origin must FAIL FAST,
        // never block on a `Username:` prompt — the box has no TTY and no git creds,
        // so a prompt is an infinite hang (POD.md). Clone over netd is credential-
        // free: it works for PUBLIC repos; private repos need a read door (scout).
        `export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true; git clone --depth 1 "$1" /work || { echo "claude-box: clone failed — --repo-origin clones over netd with NO credentials (works for PUBLIC repos). For a private repo, use the scout read-door, which injects the token. There is no TTY to prompt on." >&2; exit 1; }; git config --global --add safe.directory /work && cd /work && shift && exec ${guestCmd} "$@"`,
        "claude-box", repoOrigin,
      );
      if (guest === "claude") argv.push("--append-system-prompt", capabilityPrompt(manifest));
      argv.push(...guestArgs);
    } else {
      argv.push(IMAGE);
      if (guest === "claude") argv.push("--append-system-prompt", capabilityPrompt(manifest));
      if (guestPreset.entrypoint) argv.push(...guestPreset.entrypoint);
      argv.push(...guestArgs);
    }

    const boxProc = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await boxProc.exited;
  } finally {
    // Tear down the pod — kills the netd door (its grant's default lifetime).
    console.error(`claude-box: tearing down pod ${podName}`);
    sh(["podman", "pod", "rm", "-f", podName]);
  }
}

async function run(
  account: string,
  launch: Launch,
  env: Env = process.env,
): Promise<number> {
  assertAccount(account);
  // --pod: the box and its doors live in their own pod, off the host (POD.md).
  if (launch.pod) return runPod(account, launch);
  const { guest, repo, repoRw, repoEphemeral, repoClone, repoOrigin, writable, doors, netOpen, guestArgs } = launch;
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
    argv.push("-v", `claude-${account}-config:${BOX_CONFIG_DIR}:U`);
  }
  // Auth: by default forward a pre-minted, inference-only `claude setup-token`
  // (no in-box browser flow). --remote-control instead omits the token so a
  // full-scope in-box `claude auth login` (paste-code flow — works in
  // containers per the auth docs, persisted in the account volume) can drive
  // Remote Control. See authEnvArgs.
  argv.push(...authEnvArgs(launch, env));
  // Network posture: TCP mode vs Unix socket mode
  //
  // TCP mode (DOORS_TCP=1): Daemons run on TCP ports on the macOS host. The
  // container uses the default network and reaches daemons via
  // host.containers.internal:PORT. netd's allowlist is the security boundary.
  //
  // Unix socket mode: Daemons run on Unix sockets. The container uses
  // --network=none and mounts the socket directory. An in-box socat relay
  // bridges 127.0.0.1:3128 → the netd socket. This provides hard network
  // isolation but doesn't work over virtiofs (macOS ↔ podman machine).
  const tcpMode = isTcpMode(env);
  const netDoor = doors.find((d) => d.name === "net");

  // The git-pull door is SEPARATE from the guest's egress: a per-launch netd
  // scoped to ONLY the origin host (never anthropic), used SOLELY for the clone.
  // The guest's own egress (claude → anthropic) is a different door (--net). This
  // is built in, not configurable — there is no flag to widen the git door or
  // skip it; the only escape is --net-open (which drops policing entirely).
  let gitDoor: { port: number; stop: () => void } | undefined;
  let gitDoorProxy = ""; // empty ⇒ clone uses the container's ambient/no proxy
  if (repoOrigin && !netOpen) {
    if (!tcpMode) {
      console.error(
        "claude-box: --repo-origin needs TCP mode for its scoped git-pull door — set DOORS_TCP=1.",
      );
      process.exit(2);
    }
    const host = originHostOf(repoOrigin);
    gitDoor = await startScopedNetd([host]); // ONLY the origin host
    gitDoorProxy = `http://host.containers.internal:${gitDoor.port}`;
    console.error(
      `claude-box: --repo-origin — git-pull door scoped to ONLY ${host} (netd :${gitDoor.port}); the guest's egress is a separate door`,
    );
  }

  if (netOpen) {
    console.error(
      "claude-box: --net-open — UNPOLICED full network egress (no netd allowlist)",
    );
  } else if (tcpMode && doors.length > 0) {
    // TCP mode: use default network so container can reach host.containers.internal
    // netd's allowlist is the security boundary (HTTPS_PROXY → netd)
    if (netDoor) {
      argv.push(
        "--env",
        `HTTPS_PROXY=${NETD_TCP_PROXY}`,
        "--env",
        `HTTP_PROXY=${NETD_TCP_PROXY}`,
        "--env",
        `ALL_PROXY=${NETD_TCP_PROXY}`,
        "--env",
        "NO_PROXY=localhost,127.0.0.1",
      );
    }
  } else {
    // Unix socket mode: hard network isolation, relay via mounted socket
    argv.push("--network=none");
    if (netDoor) {
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

  // Forward doors: TCP mode vs Unix socket mode
  if (doors.length > 0) {
    if (tcpMode) {
      // TCP mode: no socket mounts needed, just set env vars to TCP endpoints.
      // Preflight each door's daemon so a down door fails here with a hint,
      // not later inside the box with an opaque connection error.
      for (const d of doors) {
        await assertTcpDoorReachable(d.name);
        const endpoint = transportString(d.guest);
        argv.push("--env", `${d.env}=${endpoint}`);
      }
    } else {
      // Unix socket mode: mount socket directory, set env vars to socket paths
      const hostDir = getRunDir(env);
      assertSocketDir(`${hostDir}/placeholder`, undefined);
      argv.push("-v", `${hostDir}:/run/doors`);
      for (const d of doors) {
        const hostPath = unixPath(d.host);
        const guestPath = unixPath(d.guest);
        assertSocketExists(hostPath, d.name);
        argv.push("--env", `${d.env}=${guestPath}`);
      }
    }
  }
  // The machine-readable surface for the in-box runtime (prx tool-gating).
  argv.push("--env", `CLAUDE_BOX_CAPABILITIES=${capabilityJson(manifest)}`);

  // Track ephemeral worktree / isolated clone for cleanup
  let ephemeralWorktree: string | undefined;
  let cloneDir: string | undefined;
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
    } else if (repoClone) {
      // Isolated clone with its OWN writable .git. The real repo is never
      // mounted, so the box gets full in-box git ergonomics with zero risk to
      // the source. Reconcile via the keeper door; the clone is removed on exit.
      try {
        cloneDir = await createIsolatedClone(abs);
        mountPath = cloneDir;
        console.error(
          `claude-box: --repo-clone — isolated clone at ${cloneDir} (full in-box git; real repo untouched)`,
        );
      } catch (e) {
        console.error(`claude-box: failed to create isolated clone: ${e}`);
        process.exit(2);
      }
    }

    // Narrowed writable surface (--writable): mount /work READ-ONLY and bind
    // only the named subtrees writable on top, so an errant agent can touch
    // nothing outside its lane. --repo-rw / --repo-clone are fully-writable
    // modes, so the two don't combine. Ignored without --repo.
    const narrowWritable = writable.length > 0 && !repoRw && !repoClone;

    // Validate any --writable subtrees first (escape + existence), exiting on bad
    // input; planRepoMount() below is pure and assumes already-validated rels.
    const writableRels: string[] = [];
    if (narrowWritable) {
      for (const sub of writable) {
        let rel: string;
        try {
          rel = resolveWritableSubtree(mountPath, sub);
        } catch (e) {
          console.error(`claude-box: ${(e as Error).message}`);
          process.exit(2);
        }
        if (!existsSync(`${mountPath}/${rel}`)) {
          console.error(`claude-box: --writable path does not exist in the repo: ${sub}`);
          process.exit(2);
        }
        writableRels.push(rel);
      }
      console.error(
        `claude-box: --writable — /work is READ-ONLY except: ${writable.join(", ")}`,
      );
    }
    // A worktree's git dir lives in a bare repo OUTSIDE the worktree; resolve it
    // so the mount plan can bind it at its host path. Skipped for --repo-clone
    // (the clone is self-contained).
    const common = repoClone ? undefined : await gitCommonDir(mountPath);
    const external = !!(common && !common.startsWith(`${mountPath}/`));
    if (repoRw) {
      console.error(
        "claude-box: --repo-rw — host .git is WRITABLE in the box; a planted hook/config runs on YOUR host. Prefer --repo (read-only .git) + --keeper.",
      );
    }
    argv.push(
      ...planRepoMount({ mountPath, repoRw, repoClone, narrowWritable, writableRels, common, external }),
    );
    // Tell the box what the host path is, so keeperd requests can translate
    // /work → the actual host path (keeperd runs on the host, not in the box).
    // For ephemeral worktrees, use the original repo path so commits apply there.
    // For an isolated clone, point at the clone — that's what /work IS, and
    // reconciliation reads the clone's commits.
    argv.push("--env", `CLAUDE_BOX_HOST_REPO=${repoClone ? mountPath : abs}`);
  }
  // --repo-origin: no host mount. /work is a writable container-internal tmpfs;
  // override the entrypoint to clone the origin into it, then exec the guest in
  // the checkout. The URL is passed POSITIONALLY ($1), never interpolated into
  // the script, so it can't inject shell. Egress is the net door (netd must
  // allow the origin host). These podman opts must precede the image.
  const guestCmd = guestPreset.entrypoint?.[0] ?? (guest === "claude" ? "claude" : "sh");
  if (repoOrigin) {
    argv.push("--tmpfs", "/work:rw,mode=1777", "-w", "/work", "--entrypoint", "sh");
  }

  // Use the guest's image and entrypoint.
  argv.push(guestPreset.image);

  if (repoOrigin) {
    // sh -c '<script>' <arg0> <URL> <guest args…> : $1=URL (clone target), then
    // shift so "$@" is exactly the guest args handed to the guest command.
    argv.push(
      "-c",
      // $1=URL, $2=git-pull-door proxy (used ONLY for the clone, so the guest's
      // own egress door is untouched). safe.directory: the tmpfs /work root is
      // root-owned but git runs as the box user, so mark it safe.
      // GIT_TERMINAL_PROMPT=0 + GIT_ASKPASS: fail fast on a 401/private origin,
      // never block on a `Username:` prompt (no TTY, no git creds in the box).
      `url="$1"; gp="$2"; shift 2; export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true; https_proxy="$gp" HTTPS_PROXY="$gp" git clone --depth 1 "$url" /work || { echo "claude-box: clone failed — --repo-origin clones with NO credentials (works for PUBLIC repos). Private repos need the scout read-door. No TTY to prompt on." >&2; exit 1; }; git config --global --add safe.directory /work && cd /work && exec ${guestCmd} "$@"`,
      "claude-box",
      repoOrigin,
      gitDoorProxy,
    );
    if (guest === "claude") {
      argv.push("--append-system-prompt", capabilityPrompt(manifest));
    }
    argv.push(...guestArgs);
  } else {
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
  }
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

  // Tear down the per-launch scoped origin door.
  if (gitDoor) {
    console.error(`claude-box: stopping git-pull door (netd :${gitDoor.port})`);
    gitDoor.stop();
  }

  // Clean up the isolated clone on exit (a plain temp dir, not a worktree).
  // NOTE (increment 2): reconcile the clone's commits to the source via keeper
  // BEFORE this removal once that path lands; today the clone is discarded.
  if (cloneDir) {
    console.error(`claude-box: cleaning up isolated clone ${cloneDir}`);
    try {
      rmSync(cloneDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }

  return exitCode;
}

// ── Launcherd client ─────────────────────────────────────────────────────────

function launcherdSocketPath(): string {
  // One run dir: getRunDir is the single XDG_RUNTIME_DIR-first resolver (with the
  // world-writable refusal + 0700 mkdir hardening), shared with the door sockets.
  return `${getRunDir(process.env)}/launcherd.sock`;
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
  // Shares the one run dir with launcherd + the door sockets (see getRunDir).
  return `${getRunDir(process.env)}/keeperd.sock`;
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

// ── doctor: detect boxes pinned to a stale image ─────────────────────────────
// A container is a live process booted from one immutable image id and holds it
// for life. `nix run .#setup` rebuilds the image and moves the mutable `:dev`
// tag, but already-running boxes keep the id they started from — so a box can
// silently outlive the fix that's already on the new image (e.g. #34's statsig
// switch). The image ids let us DETECT the drift; doctor acts on that detection.

/** A running box reduced to what the staleness check needs. */
type RunningBox = { id: string; imageId: string; status?: string };

/** Normalize a podman image id for comparison (drop the sha256: prefix). */
function normImageId(id: string): string {
  return id.replace(/^sha256:/, "");
}

/**
 * Pure staleness check: which running boxes are NOT on the current image.
 * podman reports ids in short or long form, so two ids match when either is a
 * prefix of the other. Boxes with an empty/unknown image id are treated as
 * stale (we can't prove they're current).
 */
function findStaleBoxes(
  boxes: RunningBox[],
  currentImageId: string,
): RunningBox[] {
  const cur = normImageId(currentImageId);
  if (!cur) return [...boxes]; // no baseline → can't prove any box is current
  return boxes.filter((b) => {
    const bid = normImageId(b.imageId);
    if (!bid) return true;
    return !(cur.startsWith(bid) || bid.startsWith(cur));
  });
}

/** Current image id behind the `:dev` tag, or "" if the image isn't loaded. */
async function currentImageId(): Promise<string> {
  const proc = Bun.spawn(
    ["podman", "image", "inspect", IMAGE, "--format", "{{.Id}}"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  return (await proc.exited) === 0 ? out : "";
}

/** Running boxes launched under the `:dev` tag, with their pinned image ids. */
async function runningBoxes(): Promise<RunningBox[]> {
  const proc = Bun.spawn(
    [
      "podman",
      "ps",
      "--filter",
      `ancestor=${IMAGE}`,
      "--format",
      "{{.ID}}\t{{.ImageID}}\t{{.Status}}",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !out) return [];
  return out.split("\n").map((line) => {
    const [id, imageId, status] = line.split("\t");
    return { id, imageId, status };
  });
}

async function cmdDoctor(): Promise<number> {
  const cur = await currentImageId();
  if (!cur) {
    console.error(
      `claude-box doctor: image ${IMAGE} is not loaded.\n` +
        `Run 'nix run .#setup' to build and load it.`,
    );
    return 1;
  }

  const boxes = await runningBoxes();
  const stale = findStaleBoxes(boxes, cur);

  console.log(`current image: ${normImageId(cur).slice(0, 12)} (${IMAGE})`);
  console.log(`running boxes: ${boxes.length}\n`);

  if (boxes.length === 0) {
    console.log("no running boxes — nothing to check.");
    return 0;
  }

  for (const b of boxes) {
    const isStale = stale.includes(b);
    const tag = isStale ? "STALE" : "current";
    console.log(
      `  ${b.id.slice(0, 12)}  img=${normImageId(b.imageId).slice(0, 12)}  ${tag}  ${b.status ?? ""}`.trimEnd(),
    );
  }

  if (stale.length === 0) {
    console.log("\nall boxes are on the current image. ✓");
    return 0;
  }

  // Detection only — never auto-kill. A box may hold a live session or unsaved
  // work, so recreating is the operator's call. We print the exact commands.
  const ids = stale.map((b) => b.id.slice(0, 12)).join(" ");
  console.log(
    `\n${stale.length} box(es) pinned to an older image — they won't pick up\n` +
      `changes that are already in the current image (rebuild moved the tag,\n` +
      `but a running container keeps the image id it booted from).\n\n` +
      `Recreate them to pick up the latest image (this stops their session —\n` +
      `commit or stash any in-box work first):\n\n` +
      `  podman stop ${ids}\n` +
      `  podman rm   ${ids}\n` +
      `  # then relaunch, e.g.:  DOORS_TCP=1 claude-box --room dev --repo .`,
  );
  // Non-zero so scripts/CI can gate on drift.
  return 1;
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
  // Handle help first (no podman check needed)
  if (subcmd === "-h" || subcmd === "--help" || !subcmd) {
    console.log(`claude-box doors — manage door services

Usage:
  claude-box doors serve             run all daemons in foreground (TCP mode, for macOS)
  claude-box doors init              one-shot setup (build images, install units, start)
  claude-box doors ensure            start any stopped services (fast, no rebuild)
  claude-box doors status [svc...]   show status of door services
  claude-box doors start [svc...]    start door services
  claude-box doors stop [svc...]     stop door services
  claude-box doors restart [svc...]  restart door services
  claude-box doors logs <svc>        follow logs for a service

Services: ${DOOR_SERVICES.join(", ")}

TCP Mode (macOS):
  'doors serve' runs daemons on TCP ports (not Unix sockets) because virtiofs
  can't share sockets between macOS and the podman machine VM. Containers reach
  daemons via host.containers.internal:PORT. To launch a box in TCP mode:

    DOORS_TCP=1 claude-box --room dev --repo .

  TCP ports: keeperd=${TCP_PORTS.keeperd}, netd=${TCP_PORTS.netd}, scoutd=${TCP_PORTS.scoutd}

Examples:
  claude-box doors serve             run daemons on TCP (Ctrl+C to stop)
  DOORS_TCP=1 claude-box --room dev  launch box with TCP doors
  claude-box doors init              first-time setup (containerized, for Linux)
  claude-box doors status            status of all doors`);
    return subcmd === "-h" || subcmd === "--help" ? 0 : 1;
  }

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
    case "serve": {
      // Run all door daemons in foreground with TCP ports (for macOS host).
      // TCP mode is required because Unix sockets don't work over virtiofs
      // (macOS ↔ podman machine boundary). Containers reach daemons via
      // host.containers.internal:PORT.
      console.log("claude-box doors serve — starting daemons on host (TCP mode)...\n");

      const daemons: Array<{ name: string; script: string; port: number }> = [
        { name: "keeperd", script: "keeperd.ts", port: TCP_PORTS.keeperd },
        { name: "netd", script: "netd/netd.ts", port: TCP_PORTS.netd },
        { name: "scoutd", script: "scoutd.ts", port: TCP_PORTS.scoutd },
      ];

      // Find the repo root (where this script lives)
      const scriptDir = dirname(Bun.main);

      const children: Array<{ name: string; proc: ReturnType<typeof Bun.spawn> }> = [];

      // Use the current bun executable (works inside nix run)
      const bunPath = process.execPath;

      for (const d of daemons) {
        const scriptPath = `${scriptDir}/${d.script}`;
        // Start daemon in TCP mode with --port
        const proc = Bun.spawn([bunPath, scriptPath, "serve", "--port", String(d.port)], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env },
        });
        children.push({ name: d.name, proc });

        // Stream stdout with prefix
        (async () => {
          const reader = proc.stdout.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const lines = decoder.decode(value).split("\n");
            for (const line of lines) {
              if (line.trim()) console.log(`[${d.name}] ${line}`);
            }
          }
        })();

        // Stream stderr with prefix
        (async () => {
          const reader = proc.stderr.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const lines = decoder.decode(value).split("\n");
            for (const line of lines) {
              if (line.trim()) console.error(`[${d.name}] ${line}`);
            }
          }
        })();

        console.log(`  ${d.name}: started on port ${d.port} (pid ${proc.pid})`);
      }

      console.log("\nAll daemons running on TCP. Press Ctrl+C to stop.");
      console.log("\nTo launch a box with TCP mode, set DOORS_TCP=1:");
      console.log("  DOORS_TCP=1 claude-box --room dev --repo .\n");

      // Handle SIGINT to clean up
      process.on("SIGINT", () => {
        console.log("\nStopping daemons...");
        for (const { name, proc } of children) {
          proc.kill();
          console.log(`  ${name}: stopped`);
        }
        process.exit(0);
      });

      // Wait for any child to exit (shouldn't happen normally)
      await Promise.race(children.map(async ({ name, proc }) => {
        const code = await proc.exited;
        console.error(`[${name}] exited with code ${code}`);
        return { name, code };
      }));

      // If one exits, kill the others and exit
      console.error("A daemon exited unexpectedly. Stopping others...");
      for (const { name, proc } of children) {
        proc.kill();
        console.log(`  ${name}: stopped`);
      }
      return 1;
    }
    default:
      console.error(`claude-box: unknown doors subcommand '${subcmd}'`);
      console.error("Run 'claude-box doors --help' for usage.");
      return 1;
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
    case "doctor":
      return cmdDoctor();
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
  authEnvArgs,
  BOX_CONFIG_DIR,
  planRepoMount,
  boxTempBase,
  buildManifest,
  capabilityJson,
  capabilityPrompt,
  transportString,
  unix,
  tcp,
  unixPath,
  isTcpMode,
  TCP_PORTS,
  findStaleBoxes,
  normImageId,
  tcpReachable,
  resolveWritableSubtree,
  originHostOf,
};
export type { DoorGrant, DoorTransport, Manifest, Launch, GuestPreset, RunningBox };

if (import.meta.main) {
  process.exit(await main());
}
