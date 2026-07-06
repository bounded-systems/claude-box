#!/usr/bin/env bun
/**
 * claude-box [claude args…] — a pinned, isolated Claude runtime.
 *
 * One image (localhost/claude-personal:dev) + one podman volume (claude-config)
 * holding auth/history/projects. The volume is the isolation boundary; `:U`
 * keeps it writable by the in-image `claude` user so `/login` persists.
 * First run → `/login` once, and it sticks in the volume.
 *
 *   claude-box                  claude runtime
 *   claude-box --resume         flags pass through to claude
 *   claude-box --repo .         mount the worktree at /work
 *
 * Built from prx.git/claude-runtime:nix/claude-container (ADR
 * docs/prx/claude-runtime.md, epic prx-d4o). Run via pinned Bun.
 */

import { existsSync, mkdirSync, statSync, rmSync, mkdtempSync, readFileSync, openSync, closeSync, writeSync } from "node:fs";
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
  type SignedGrant,
  resolveDoor as resolveDoorIn,
  expandRoom,
  deniedDoors,
  capabilityPreamble,
  grantedDoorLines,
  deniedDoorSection,
  transportString,
  transportToEndpoint,
  unix,
  tcp,
  attenuate,
  signGrant,
} from "./guest-room/mod.ts";
import { DEFAULT_ALLOW } from "./netd/netd.ts";
import { loadOrCreateBoxKey, issuerKeysPath } from "./lib/box-keys.ts";
import {
  type RemoteControlFlags,
  CLAUDE_BOX_DEFAULT_FLAGS,
  renderRemoteControlArgs,
} from "./lib/remote-control-flags.ts";

const IMAGE = "localhost/claude-personal:dev";

// ── TCP mode ports (for macOS ↔ podman machine) ──────────────────────────────
// When daemons run on the macOS host with --port, containers reach them via
// host.containers.internal:PORT. These are the canonical ports for TCP mode.
const TCP_PORTS: Record<string, number> = {
  keeperd: 3001,
  netd: 3128,  // HTTP proxy port
  scoutd: 3002,
  authd: 3003, // RC credential-broker door (prx-6194)
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
  needsConfig?: boolean;  // mount the config volume (default: true for claude)
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
// The in-box config dir = the volume's mount point, where claude keeps
// auth/settings/history (incl. `claude auth login`). It MUST equal the image's
// CLAUDE_CONFIG_DIR / $XDG_CONFIG_HOME/claude (flake.nix). One path, both sides;
// tests/xdg.test.ts pins this against flake.nix so they can't drift.
const BOX_CONFIG_DIR = "/home/claude/.config/claude";
// --remote-serve's workspace: NOT $HOME, because Claude Code never persists
// workspace-trust acceptance for a home-directory workspace (it re-prompts
// "Workspace not trusted" every launch — confirmed live). This dir is
// ephemeral (container rootfs), recreated each launch; trust is pre-seeded
// for it in .claude.json (the persistent config volume) instead. Named
// "claude-box" (not "workspace") because the pre-created RC session's
// display name is this directory's basename — a generic "workspace" name
// was indistinguishable from any other tool's bastion in the RC list.
export const RC_WORKSPACE = "/home/claude/claude-box";
// The loopback proxy the in-box relay exposes; the image entrypoint forwards it
// to the netd door (/run/netd.sock). Egress clients route here (HTTPS_PROXY=…).
const NETD_PROXY = "http://127.0.0.1:3128";

// In TCP mode (DOORS_TCP=1), the proxy points directly to netd on the host.
const NETD_TCP_PROXY = `http://host.containers.internal:${TCP_PORTS.netd}`;

// Extra egress hosts the --remote-control profile needs ON TOP of the default
// anthropic allowlist: the GrowthBook/statsig feature-flag + telemetry endpoint
// that delivers the `tengu_ccr_bridge` RC flag. authEnvArgs() un-suppresses the
// flag fetch; without these the shared netd (anthropic-only) blocks it as the
// fail-closed boundary, so RC never activates. Minimal + enumerated — never
// --net-open. [Spike S1] enumerates any further hosts via netd's DENY log.
//
// claude.ai + platform.claude.com added 2026-07-03: the `/login` OAuth flow
// (needed the FIRST time the box does a full-scope `claude auth login`
// for RC, since RC rejects the inference-only setup-token — see
// authEnvArgs) hits both hosts, not just *.anthropic.com — both are on
// Anthropic's own documented required-domains list (code.claude.com/docs/en/
// network-config) alongside api.anthropic.com. Without them netd 403s the
// CONNECT (confirmed live: `curl -x http://127.0.0.1:3128 https://claude.ai`
// and `...platform.claude.com` were both denied before this) and the login
// dialog fails with an opaque "OAuth error: Request failed with status code
// 403" — easy to misread as a credentials problem when it's an egress block.
export const RC_NETD_ALLOW = ["statsig.anthropic.com", "claude.ai", "platform.claude.com"];

// Extra egress host the --pathbase profile needs: toolpath's `path auth
// login` / `path p export|import pathbase` talk to a single origin
// (https://pathbase.dev by default, overridable client-side via
// $PATHBASE_URL — see empathic/toolpath's cmd_auth.rs `resolve_url`). This is
// a WRITE-capable host (session push/pull + an auth token), so — same as
// GH-6's "fetch hosts only" hygiene for the default profile — it is never
// folded into DEFAULT_ALLOW; a box only reaches it via the explicit,
// named --pathbase profile, through its OWN scoped netd (never the shared
// one), exactly like --remote-control's statsig/claude.ai widening below.
export const PATHBASE_NETD_ALLOW = ["pathbase.dev"];


/** Detect if we're in TCP mode (daemons running on TCP ports, not sockets).
 *  Pure/env-driven only (no ambient process.platform read) so every caller —
 *  including tests, which build their own synthetic envs — stays fully
 *  deterministic regardless of which OS is actually running them. The
 *  platform-based default (automatic on macOS) is applied once, at the real
 *  CLI entrypoint, by defaulting process.env.DOORS_TCP before main() reads
 *  anything — see main()'s own comment. */
function isTcpMode(env: Env): boolean {
  return env.DOORS_TCP === "1" || env.DOORS_TCP === "true";
}

type Env = Record<string, string | undefined>;

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
  auth: "bun authd.ts serve", // RC credential-broker door (prx-6194; .#authd image is Phase 2)
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

/** The podman argv fragment that wires a box's granted doors. Pure (no I/O — the
 *  existence/reachability/hijack preflight stays in run()), so the capability
 *  boundary is unit-testable.
 *
 *  UNIX mode mounts each granted socket INDIVIDUALLY (host socket → its guest
 *  path): the mounted set IS the capability set (prx-sfr0). The old whole-run-dir
 *  mount (`${runDir}:/run/doors`) exposed EVERY daemon socket regardless of
 *  grant, so a scout-only box could still reach keeperd/netd; the per-door env
 *  vars were only hints, not the boundary. Per-socket mounts make a non-granted
 *  door physically unreachable inside the box — on the unix transport the held
 *  reference IS the authority (see ADR-CAPABILITY-TRANSPORT).
 *
 *  TCP mode mounts nothing; the door is reached over the host gateway, so it only
 *  points each env var at the guest TCP endpoint. */
function planDoorMounts(doors: DoorGrant[], tcpMode: boolean): string[] {
  const argv: string[] = [];
  for (const d of doors) {
    if (tcpMode) {
      // transportToEndpoint (bare "host:port"), NOT transportString ("tcp:host:port"
      // — meant for logs): the env var's value is what door-kit's call()/connectTarget
      // parses client-side, and the "tcp:" prefix doesn't match its host:port regex.
      argv.push("--env", `${d.env}=${transportToEndpoint(d.guest)}`);
    } else {
      const guestPath = unixPath(d.guest);
      argv.push("-v", `${unixPath(d.host)}:${guestPath}`);
      argv.push("--env", `${d.env}=${guestPath}`);
    }
  }
  return argv;
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
    auth: {
      flag: "--auth",
      inBox: "/run/doors/authd.sock",
      env: "AUTHD_SOCK",
      hostDefault: env.AUTHD_SOCK ?? defaultHostSock("authd", env),
      grants: "a leased, access-token-only Claude credential via authd (Remote Control)",
      use: "Lease the Remote Control credential from authd at /run/doors/authd.sock ($AUTHD_SOCK). You hold NO refresh token — authd owns it host-side and lends you only a short-lived access token (it re-leases before expiry). Do not persist or refresh it yourself.",
      deny: "No Remote Control credential in this box. Do not attempt `claude auth login` or expect a full-scope token; relaunch with --remote-control (which mounts authd) if RC is needed.",
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
    // The dispatch door — deliberately NOT the launcher door. A box holding
    // ONLY "dispatch" mounts a socket that speaks nothing but launcherd's
    // narrow `dispatch` method (see launcherd.ts's DISPATCH_METHODS): no
    // launch/kill/list/attach/status, no way to name a door/repo/escape
    // flag. You send {room, label}; if the room is on launcherd's
    // dispatchable allow-list, an entirely independent, separately-
    // attachable `claude remote-control --spawn session` box is started —
    // otherwise the request is refused. There is no ongoing connection to
    // what gets started: no attach, no kill, no status feed. See --remote-serve.
    dispatch: {
      flag: "--dispatch",
      inBox: "/run/doors/dispatch.sock",
      env: "DISPATCH_SOCK",
      hostDefault: env.DISPATCH_SOCK ?? defaultHostSock("dispatch", env),
      grants: "request an independent, separately-attachable task session via launcherd's dispatch lane",
      use: "Send exactly {room, label} to /run/doors/dispatch.sock ($DISPATCH_SOCK), one JSON line at a time: {\"id\":\"1\",\"method\":\"dispatch\",\"params\":{\"room\":\"dev\",\"label\":\"fix-auth-bug\"}}. `room` must be one of launcherd's dispatchable rooms (ask via a normal launcherd `rooms` call if unsure, or default to \"dev\"/\"readonly\"/\"offline\"). You will NEVER see, attach to, or manage what comes back — a new, independently-credentialed remote-control session appears as its OWN entry in the Claude app's session list, named for `label`. One task, one box: dispatch a fresh one per task rather than trying to reuse one.",
      deny: "No dispatch authority in this box. Do not attempt to request sub-sessions or claim one was started; relaunch with --remote-serve (which grants this automatically) if the task needs it.",
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

const HELP = `claude-box [flags…] [-- guest-args…] — pinned, isolated workloads

  # Claude (default guest)
  claude-box                  claude runtime
  claude-box --resume         flags pass through to claude
  claude-box --repo .         mount the worktree at /work (.git read-only; commits via --keeper)

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
  --remote-serve      boot straight into RC SERVER mode: entrypoint becomes
                      'claude remote-control', so the box is a headless RC server
                      (no manual /remote-control). Same posture as --remote-control.
  --pathbase          opt-in: let toolpath ('path') reach Pathbase (implies --net;
                      routed through its own scoped netd allowlisting pathbase.dev —
                      never the shared netd; local git/agent-log provenance needs
                      no egress at all and works without this flag)
  --pod               run the box + its netd door in an isolated pod (off-host)
  --keeper            forward the keeperd door (signed git writes)
  --beads             forward the beadsd door (beads reads/writes)
  --scout             forward the scoutd door (external reads)
  --issue owner/repo#N or a GitHub issue URL
                      implies --scout; seeds the guest with a prompt to read
                      and work that issue (no token in the box — read via
                      scoutd's issue method)
  --launcher          forward the launcherd door (spawn sub-boxes)
  --room NAME         forward a door bundle (tool | read | dev)
  --door NAME[:CAV...][@SOCK]  attach door with optional caveats

  # Management
  claude-box login            auth-only box (no repo): run the login flow,
                              persist to the config volume, exit. Always a
                              full-scope 'claude auth login' — the one scope
                              claude-box runs, since it covers both plain
                              inference and Remote Control.
  claude-box check-in         throwaway login for authd's ephemeral store —
                              nothing persists; prints the credential JSON
                              to stdout for piping into 'authd serve'.
  claude-box authd-up         one-shot: check-in, then start authd DETACHED
                              (survives this terminal closing), seeded with
                              that credential. No-op if authd's already up.
  claude-box auth-keys-path   path to claude-box's grant-signing public key —
                              feed to authd: AUTHD_ISSUER_KEYS_PATH=$(claude-box
                              auth-keys-path) authd serve --port 3003
  claude-box internal-mint-auth-grant --audience NAME
                              host-only: mint a fresh signed "auth" door grant
                              for NAME, base64-encoded to stdout — for a
                              systemd/Quadlet-managed bastion's ExecStartPre=
                              (no CLI invocation exists there to mint one
                              inline the way run() does). See
                              quadlet/remote-serve.container.
  claude-box internal-print-rc-boot-script
                              host-only: prints the RC bootstrap script a
                              Quadlet-managed bastion runs as its entrypoint
                              (env-sourced grant, not baked in) — written to
                              a file by ExecStartPre=, bind-mounted in, so
                              the unit's Exec= never embeds it directly.
  claude-box remote-serve-status
                              is the singleton RC bastion running, which
                              container backs it, since when, and has it been
                              crash-looping recently — wraps the systemctl/
                              podman/journalctl checks into one command. Does
                              NOT confirm which app-visible RC session it
                              corresponds to (that id is Anthropic-assigned,
                              not derived from this container).
  claude-box doors init       one-shot setup (build images, install units)
  claude-box doors status     show door service status
  claude-box status           show launcherd status
  claude-box ps               list running boxes
  claude-box doctor           flag boxes pinned to a stale image (after a rebuild)
  claude-box kill <id>        terminate a running box`;


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
  /** --repo-door PATH: a HOST bare repo, materialized via the repod sidecar
   *  (prx-8uf2 continuation) — NO bind-mount and NO .git of any kind in
   *  claude-room. repod alone gets read access to the bare repo; it runs
   *  `git worktree add` (same-machine, no network/credentials needed) and
   *  hands claude-room a plain checkout path on a shared pod-internal volume.
   *  Reached over a unix socket on the pod's fabric — never TCP, since repod
   *  and claude-room are co-located sidecars sharing one VM kernel (no
   *  virtiofs crossing to avoid). Implies --pod (needs the shared fabric). */
  repoDoor?: string;
  /** --repo-door-ref NAME: the branch to request from repod (default "main").
   *  A branch already checked out elsewhere on the host (e.g. the operator's
   *  own worktree) can't ALSO be checked out by repod — git refuses two
   *  worktrees on one branch — so a real launch usually wants a dedicated
   *  session branch here, not the shared default. */
  repoDoorRef: string;
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
   *  full-scope in-box `claude auth login`, persisted in the config volume, wins
   *  — RC rejects inference-only tokens), and (2) unsets the image's
   *  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC so the RC feature-flag gate can
   *  evaluate. Implies the net door (RC needs egress). See prx-9s14. */
  remoteControl: boolean;
  /** --remote-serve: like --remote-control (same auth/egress posture), but the
   *  box boots STRAIGHT INTO Remote Control SERVER mode — the claude entrypoint
   *  becomes `claude remote-control` instead of an interactive session, so the
   *  box IS a persistent, headless RC server you attach to from the app (no
   *  manual `/remote-control` step).
   *
   *  ONE persistent bastion per machine, not per-box-on-one-login: a second
   *  --remote-serve launch refuses to start while one is already running
   *  (bastionAlreadyRunning), since two servers sharing ONE login fight over
   *  the single-use refresh-token rotation (prx-qba1 spike). Because the server
   *  is long-lived, the AUTHD.md "continuity across expiry" risk applies — does
   *  claude re-read an authd-refreshed credential mid-session — resolve with
   *  prx-6194 (authd). claude guest only. See prx-v9wn. */
  remoteServe: boolean;
  /** --pathbase: opt-in profile to let toolpath (`path`) talk to Pathbase
   *  (session push/pull, `path auth login`). Implies the net door, routed
   *  through its OWN scoped netd allowlisting pathbase.dev on top of the
   *  default anthropic hosts (pathbaseEgressAllow) — never the shared netd,
   *  and never folded into a default profile (GH-6: it's a write-capable
   *  host). Any guest may set this, not just claude — toolpath runs under
   *  tool guests too. */
  pathbase: boolean;
  guestArgs: string[];  // renamed: args passed to the guest (claude or tool)
};

/** Parse "owner/repo#N" or a GitHub issue URL into its parts, for `--issue`. */
function parseIssueRef(input: string): { owner: string; repo: string; number: number } | null {
  const urlMatch = input.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/);
  if (urlMatch) {
    return { owner: urlMatch[1]!, repo: urlMatch[2]!, number: parseInt(urlMatch[3]!, 10) };
  }
  const shortMatch = input.match(/^([^/]+)\/([^/]+)#(\d+)$/);
  if (shortMatch) {
    return { owner: shortMatch[1]!, repo: shortMatch[2]!, number: parseInt(shortMatch[3]!, 10) };
  }
  return null;
}

/** The seed prompt `--issue` prepends to guestArgs — read via the scout door,
 *  never a directly-held token (see scoutd.ts's `issue` method). */
function seedPromptForIssue(ref: { owner: string; repo: string; number: number }): string {
  return `Use the scout door (lib/scout.ts's fetchIssue) to read ` +
    `${ref.owner}/${ref.repo}#${ref.number} (with comments: true), then implement it. ` +
    `Follow that repo's own contribution norms (CLAUDE.md, existing PR conventions) for how to ship the change.`;
}

/** Split a launch's tail into claude-box flags (--guest / --repo / --net[-open]
 *  / --keeper / --beads / --scout / --issue / --room / --door) and the guest
 *  passthrough args. `--net` takes an optional socket path (bare ⇒ the default
 *  netd door); `--net-open` is the unsafe ambient-egress escape (no door);
 *  `--issue owner/repo#N` implies --scout and prepends a seed prompt onto
 *  guestArgs; `--room` expands a named door bundle that later flags compose
 *  over. `--guest` selects a runtime; tool guests (bun, node, python) apply
 *  their defaultRoom if no explicit room. */
function planLaunch(tail: string[], env: Env = process.env): Launch {
  let guest = "claude";
  let explicitRoom = false;
  let repo: string | undefined;
  let repoRw = false;
  let repoEphemeral = false;
  let repoClone = false;
  let repoOrigin: string | undefined;
  let repoDoor: string | undefined;
  let repoDoorRef = "main";
  let pod = false;
  let netOpen = false;
  let remoteControl = false;
  let remoteServe = false;
  let pathbase = false;
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
    if (t === "--repo-door") {
      // A HOST bare repo, materialized via the repod sidecar — no bind-mount,
      // no .git in claude-room (see Launch.repoDoor). Implies --pod.
      const path = tail[++i];
      if (!path) throw new Error("--repo-door requires a path to a bare repo");
      repoDoor = path;
      pod = true;
      continue;
    }
    if (t === "--repo-door-ref") {
      const ref = tail[++i];
      if (!ref) throw new Error("--repo-door-ref requires a branch name");
      repoDoorRef = ref;
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
    if (t === "--remote-serve") {
      // Boot straight into RC server mode (see Launch.remoteServe). Same egress
      // need as --remote-control, so imply the net door (Map dedupes). Also
      // imply the auth door: a long-lived bastion leases its RC credential
      // from authd (ephemeral, access-token-only) instead of holding a
      // persisted refresh token in a volume — see the lease step in run().
      // Also imply the dispatch door (NOT launcher — see knownDoors' comment
      // on "dispatch"): a --remote-serve bastion's whole purpose is to be the
      // one singleton you can ask to start independent task sessions, and
      // dispatch is deliberately safe-by-construction to grant automatically
      // (it can only ever trigger a root-resolved, allow-listed room launch,
      // never an arbitrary door grant) — unlike launcher, which stays an
      // explicit, separate opt-in.
      remoteServe = true;
      add(resolveDoor("net", undefined, env));
      add(resolveDoor("auth", undefined, env));
      add(resolveDoor("dispatch", undefined, env));
      continue;
    }
    if (t === "--pathbase") {
      // Opt-in: let toolpath reach Pathbase. Imply the net door (Map dedupes
      // if --net is also given) — the actual host widening happens via
      // pathbaseEgressAllow's OWN scoped netd, same shape as --remote-control.
      pathbase = true;
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
    if (t === "--issue") {
      // Seed the guest with a specific GitHub issue to work: implies --scout
      // (the box has no web access of its own — it reads the issue, and later
      // a project board, only through the scout door, never holding a token
      // itself) and prepends a seed prompt as the guest's first positional
      // arg, ahead of anything else already collected in guestArgs.
      const spec = tail[++i] ?? "";
      const ref = parseIssueRef(spec);
      if (!ref) {
        throw new Error(
          `--issue needs "owner/repo#N" or a GitHub issue URL, got: ${JSON.stringify(spec)}`,
        );
      }
      add(resolveDoor("scout", undefined, env));
      guestArgs.unshift(seedPromptForIssue(ref));
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
  // --remote-serve rewrites the claude entrypoint into server mode, so it is
  // meaningless for tool guests and not wired into the pod launch path (which
  // builds its own entrypoint). Fail closed on that combo rather than silently
  // dropping the server mode. --repo-origin IS wired (2026-07-03): the
  // clone-then-exec script also prepends remoteServeArgs when set — see
  // run()'s repoOrigin branch.
  if (remoteServe) {
    if (guest !== "claude") {
      throw new Error(`--remote-serve is only valid for the claude guest (got "${guest}")`);
    }
    if (pod) {
      throw new Error("--remote-serve is not supported with --pod yet (separate launch path)");
    }
  }
  return {
    guest,
    repo,
    repoRw,
    repoEphemeral,
    repoClone,
    repoOrigin,
    repoDoor,
    repoDoorRef,
    pod,
    writable,
    doors: [...doors.values()],
    netOpen,
    remoteControl,
    remoteServe,
    pathbase,
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
 *  persists in the config volume). Also unset the image-baked
 *  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC so the RC feature-flag gate
 *  (tengu_ccr_bridge, delivered via GrowthBook) can evaluate.
 *
 *  But that umbrella var is the equivalent of FOUR switches — DISABLE_AUTOUPDATER
 *  + DISABLE_FEEDBACK_COMMAND + DISABLE_ERROR_REPORTING + DISABLE_TELEMETRY — and
 *  only the last one breaks RC (it also kills GrowthBook feature-flag fetching).
 *  Unsetting the whole umbrella to recover GrowthBook collaterally re-enables the
 *  AUTO-UPDATER on a PINNED image (and /feedback + Sentry). So we unset the
 *  umbrella and immediately RE-ASSERT the three RC-compatible blocks granularly,
 *  leaving only telemetry/GrowthBook reachable. DISABLE_UPDATES (stricter than
 *  DISABLE_AUTOUPDATER) is right for a pinned box — it blocks manual updates too.
 *  We deliberately do NOT set DISABLE_TELEMETRY / DO_NOT_TRACK / DISABLE_GROWTHBOOK
 *  here — those would re-break RC; netd's allowlist drops the residual telemetry
 *  egress instead (the fail-closed boundary, independent of these source switches).
 *  Making the posture self-contained here means it no longer relies on the image
 *  incidentally baking the granular vars. All relaxations are scoped to this one
 *  launch — the default box is unchanged.
 *
 *  --remote-serve shares this exact posture: it is --remote-control in server
 *  mode, so it needs the same full-scope login (not the inference-only token) and
 *  the same nonessential-traffic handling, differing ONLY in the entrypoint
 *  (run()). Hence the condition covers both flags. */
function authEnvArgs(launch: Launch, env: Env = process.env): string[] {
  if (launch.remoteControl || launch.remoteServe) {
    return [
      "--unsetenv", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "--env", "DISABLE_UPDATES=1",
      "--env", "DISABLE_ERROR_REPORTING=1",
      "--env", "DISABLE_FEEDBACK_COMMAND=1",
    ];
  }
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    return ["--env", `CLAUDE_CODE_OAUTH_TOKEN=${env.CLAUDE_CODE_OAUTH_TOKEN}`];
  }
  return [];
}

/** The egress allowlist for a launch's scoped netd. The --remote-control profile
 *  widens the default anthropic allowlist with the RC feature-flag/telemetry
 *  hosts (RC_NETD_ALLOW); EVERY other launch returns [] — it keeps using the
 *  shared netd, unchanged. So the wider allowlist is scoped to this one launch's
 *  own netd; the default box's egress boundary is untouched. */
export function rcEgressAllow(launch: Launch): string[] {
  if (!(launch.remoteControl || launch.remoteServe)) return [];
  return [...DEFAULT_ALLOW, ...RC_NETD_ALLOW];
}

/** Pure: the --pathbase profile's scoped-netd allowlist — same shape as
 *  rcEgressAllow (PATHBASE_NETD_ALLOW's comment has the "why"). Every other
 *  launch returns [] — toolpath's local-only usage (`path p import git` /
 *  `render md|dot`) needs no egress at all and is unaffected. */
export function pathbaseEgressAllow(launch: Launch): string[] {
  if (!launch.pathbase) return [];
  return [...DEFAULT_ALLOW, ...PATHBASE_NETD_ALLOW];
}

/** Pure: the claude SERVER-mode entrypoint prefix for --remote-serve. The image
 *  entrypoint is `claude`, so prepending these args boots it as
 *  `claude remote-control` — a headless RC server the app attaches to,
 *  instead of an interactive session. Flags come from
 *  lib/remote-control-flags.ts (see schemas/remote-control-flags.schema.json
 *  for the full rationale) — one definition instead of ad hoc argv pushes.
 *  `--spawn session` needs no repo, so unlike the old `worktree`/`same-dir`
 *  split this applies unconditionally, whether or not `launch.repo` is set.
 *  Empty for any non-serve launch, so the interactive entrypoint is
 *  byte-for-byte unchanged. */
function remoteServeArgs(launch: Launch): string[] {
  if (!launch.remoteServe) return [];
  // --spawn session needs no repo (unlike the old --spawn worktree default),
  // so there's no repo-conditional fallback to same-dir anymore — this is
  // the one, unconditional posture. --name distinguishes the bastion itself
  // in the Claude app's session list from every task session it dispatches
  // (see the "dispatch" door) — those get their OWN --name from the
  // caller-supplied label, never this one.
  const flags: RemoteControlFlags = { ...CLAUDE_BOX_DEFAULT_FLAGS, name: "dispatch" };
  return ["remote-control", ...renderRemoteControlArgs(flags)];
}

/** Mint a signed grant for the "auth" door using claude-box's own local
 *  signing key (lib/box-keys.ts) — the deliberately simple stand-in for a
 *  concierge round-trip (see box-keys.ts's doc comment): authd's tcp gate
 *  ALWAYS requires a grant, no opt-out, so a direct CLI launch has to mint
 *  one itself. Generous expiry (24h): the SAME grant is reused by every
 *  re-lease call in the bastion's background loop (see run()), since the box
 *  itself holds no signing key to mint a fresh one — a bastion outliving this
 *  needs a restart. Real per-launch/short-lived issuance is future hardening. */
export function mintAuthGrant(authDoor: DoorGrant, audience: string): SignedGrant {
  const key = loadOrCreateBoxKey();
  return signGrant(
    authDoor,
    { audience, exp: Date.now() + 24 * 60 * 60 * 1000, nonce: crypto.randomUUID(), keyId: key.keyId },
    key.sign,
  );
}

/** In-box `bun -e` one-liner: lease an access-token-only credential from authd
 *  over $AUTHD_SOCK (unix path, or "tcp:host:port" in TCP mode — the same
 *  format the "auth" door's env carries) and write it to
 *  $CLAUDE_CONFIG_DIR/.credentials.json. This is a --remote-serve bastion's
 *  ONLY source of credentials — it never runs its own `claude auth login`
 *  (see run()'s tmpfs config mount for remoteServe). Node's `net`, not
 *  Bun.connect: this script has no source tree mounted to import from, so it
 *  has to be self-contained, and node:net is available in any bun runtime.
 *  `grant` (mintAuthGrant's output) rides along in the request — authd's tcp
 *  gate always requires one, no opt-out.
 *
 *  Also merges the leased `oauthAccount` (org/subscription identity, carried
 *  by authd alongside the credential — see schemas/claude-json.schema.json)
 *  into .claude.json: `claude remote-control`'s org-eligibility check reads
 *  THAT, not .credentials.json, and fails ("Unable to determine your
 *  organization") without it even with a fully valid access token (confirmed
 *  live, 2026-07-04) — this file never ran its own `claude auth login`, which
 *  is normally what populates it.
 *
 *  Whether claude itself notices a rewritten .credentials.json mid-session
 *  (vs. only reading it at process start) is the still-open AUTHD.md
 *  "continuity across expiry" question — this only guarantees the FILE is
 *  always current; a re-lease loop wraps this for a long-lived bastion (see
 *  run()). */
export function authLeaseCmd(grant?: SignedGrant): string {
  const req: Record<string, unknown> = { id: "1", method: "lease", params: {} };
  if (grant) req.grant = grant;
  // A JS string literal (via JSON.stringify) whose value IS the exact NDJSON
  // line to write — computed here so the inner script never has to
  // re-serialize the grant itself.
  const wireLine = JSON.stringify(JSON.stringify(req) + "\n");
  return (
    `bun -e '` +
    `const net=require("net"),fs=require("fs"),d=process.env.CLAUDE_CONFIG_DIR;` +
    `const raw=process.env.AUTHD_SOCK;` +
    `const opts=raw.startsWith("tcp:")?(()=>{const r=raw.slice(4),i=r.lastIndexOf(":");return{host:r.slice(0,i),port:Number(r.slice(i+1))};})():{path:raw};` +
    `const s=net.createConnection(opts,()=>{s.write(${wireLine})});` +
    `let buf="";` +
    `s.on("data",d2=>{buf+=d2.toString();if(buf.indexOf("\\n")>=0){s.end();const resp=JSON.parse(buf.split("\\n")[0]);` +
    `if(!resp.ok){console.error("authd lease failed: "+(resp.error&&resp.error.message));process.exit(1)}` +
    `fs.writeFileSync(d+"/.credentials.json",JSON.stringify({claudeAiOauth:resp.result.claudeAiOauth}));` +
    `if(resp.result.oauthAccount){const cp=d+"/.claude.json";let cj={};try{cj=JSON.parse(fs.readFileSync(cp,"utf8"))}catch{};cj.oauthAccount=resp.result.oauthAccount;fs.writeFileSync(cp,JSON.stringify(cj))}` +
    `}});` +
    `s.on("error",e=>{console.error("authd connect failed: "+e.message);process.exit(1)});` +
    `'`
  );
}

/** Same lease request as authLeaseCmd, but for a box that never had a CLI
 *  process mint its own grant inline (a systemd/Quadlet-managed bastion —
 *  see `internal-mint-auth-grant` and quadlet/remote-serve.container's
 *  ExecStartPre=). The grant instead arrives via `envVar`, base64-encoded
 *  JSON (an EnvironmentFile= value), and is decoded at RUNTIME inside the
 *  container rather than being baked into the script at build time.
 *
 *  This deliberately duplicates authLeaseCmd's connect/response-handling
 *  body rather than threading a "where does the grant come from" branch
 *  through one shared string-builder — each generates a small, complete,
 *  independently-readable script; a conditional embedded in a string of
 *  generated JS is harder to get right (and to verify by reading) than two
 *  parallel scripts that differ in exactly one line. */
export function authLeaseFromEnvCmd(envVar: string): string {
  return (
    `bun -e '` +
    `const net=require("net"),fs=require("fs"),d=process.env.CLAUDE_CONFIG_DIR;` +
    `const raw=process.env.AUTHD_SOCK;` +
    `const opts=raw.startsWith("tcp:")?(()=>{const r=raw.slice(4),i=r.lastIndexOf(":");return{host:r.slice(0,i),port:Number(r.slice(i+1))};})():{path:raw};` +
    `const g=process.env.${envVar};` +
    `const req={id:"1",method:"lease",params:{}};` +
    `if(g)req.grant=JSON.parse(Buffer.from(g,"base64").toString("utf8"));` +
    `const s=net.createConnection(opts,()=>{s.write(JSON.stringify(req)+"\\n")});` +
    `let buf="";` +
    `s.on("data",d2=>{buf+=d2.toString();if(buf.indexOf("\\n")>=0){s.end();const resp=JSON.parse(buf.split("\\n")[0]);` +
    `if(!resp.ok){console.error("authd lease failed: "+(resp.error&&resp.error.message));process.exit(1)}` +
    `fs.writeFileSync(d+"/.credentials.json",JSON.stringify({claudeAiOauth:resp.result.claudeAiOauth}));` +
    `if(resp.result.oauthAccount){const cp=d+"/.claude.json";let cj={};try{cj=JSON.parse(fs.readFileSync(cp,"utf8"))}catch{};cj.oauthAccount=resp.result.oauthAccount;fs.writeFileSync(cp,JSON.stringify(cj))}` +
    `}});` +
    `s.on("error",e=>{console.error("authd connect failed: "+e.message);process.exit(1)});` +
    `'`
  );
}

/** The shell script that boots ANY box (the --remote-serve bastion, or a
 *  dispatched task session launched via launcherd's `dispatch` RPC) into a
 *  real, credentialed `claude remote-control` session: mkdir the workspace
 *  if nothing else already mounted one, lease the RC credential (and keep
 *  re-leasing it every 10 minutes for as long as the box stays up), pre-seed
 *  that workspace's trust-dialog acceptance, then exec claude with "$@" —
 *  the remote-control argv passed as this script's own positional params by
 *  the caller (never string-interpolated). Shared by claude-box.ts's own
 *  `run()` and launcherd.ts's `handleDispatch` so the two never drift. */
export function buildRemoteServeScript(opts: {
  repo?: string;
  rcWorkspace: string;
  leaseCmd: string;
  /** In unix-socket mode (no TCP relay to a host-exposed port), the box's
   *  own HTTPS_PROXY=http://127.0.0.1:3128 points at nothing unless
   *  SOMETHING bridges that loopback port to the mounted netd unix socket
   *  — normally an in-box `socat` relay run()'s own pod/repo-origin
   *  branches already start (see netdRelayCmd), but NOT this script's own
   *  callers until now. Confirmed live: without this, the feature-flag
   *  check `claude remote-control` does at boot fails ("the feature-flag
   *  service was unreachable"). Omit when the caller doesn't hold/need the
   *  net door, or is in TCP mode (where NETD_SOCK already points at a real
   *  host-reachable address and no relay is needed). */
  netdRelay?: string;
}): string {
  const rcCwd = opts.repo ? "/work" : opts.rcWorkspace;
  const relay = opts.netdRelay ? `${opts.netdRelay} ` : "";
  return `${relay}${opts.repo ? "" : `mkdir -p ${rcCwd}; `}${opts.leaseCmd}; (while true; do sleep 600; ${opts.leaseCmd}; done &); cfg="$CLAUDE_CONFIG_DIR/.claude.json"; mkdir -p "$(dirname "$cfg")"; bun -e 'const fs=require("fs"),p="${rcCwd}",c=process.env.CLAUDE_CONFIG_DIR+"/.claude.json";let j={};try{j=JSON.parse(fs.readFileSync(c,"utf8"))}catch{};j.projects=j.projects||{};j.projects[p]=j.projects[p]||{};j.projects[p].hasTrustDialogAccepted=true;fs.writeFileSync(c,JSON.stringify(j))'; cd ${rcCwd} && exec claude "$@"`;
}

/** Pure planner for `claude-box login` — the auth front door. Synthesizes a
 *  repo-less Launch whose only job is to host the login flow against the
 *  config volume: the --remote-control auth posture (OMIT the inference-only
 *  setup-token so a full-scope in-box `claude auth login` is what persists) +
 *  the net door, since OAuth needs egress.
 *
 *  There is only ONE scope: full. An inference-only posture used to be a
 *  separate `--scope inference` choice, but a full-scope credential is a
 *  strict superset (it drives ordinary inference AND Remote Control) and
 *  configuration should come from what's actually leased at runtime (see
 *  authd), not from a CLI-time fork in what kind of box this is. No repo, no
 *  room — authority here is the credential, not a worktree.
 *  Eventually this login moves behind authd (see AUTHD.md); today it is box-local. */
function planLogin(
  args: string[],
  env: Env = process.env,
): { launch: Launch } {
  for (const a of args) {
    throw new Error(`claude-box login: unexpected argument "${a}"`);
  }
  const launch = planLaunch(["--remote-control"], env);
  return { launch };
}

type Manifest = {
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
  /** Spawn depth of THIS box (0 = root). Threaded so the in-box runtime can
   *  increment it on nested spawns and launcherd's maxDepth ceiling holds. */
  depth: number;
};

/** The honest surface for THIS launch: what's granted AND what's denied. Built
 *  from the actual grants, so it cannot drift from reality. `--net-open` opens
 *  ambient egress WITHOUT the net door, so it suppresses the "net" denial — the
 *  manifest must not claim there's no network when there is. */
function buildManifest(
  launch: Launch,
  env: Env = process.env,
  depth = 0,
): Manifest {
  const granted = new Set(launch.doors.map((d) => d.name));
  // --net-open opens ambient egress WITHOUT the net door, so suppress the "net"
  // denial — the manifest must not claim there's no network when there is.
  const suppress = launch.netOpen ? new Set(["net"]) : new Set<string>();
  const denied = deniedDoors(knownDoors(env), granted, suppress);
  return { guest: launch.guest, repo: launch.repo, repoRw: launch.repoRw, repoEphemeral: launch.repoEphemeral, repoClone: launch.repoClone ?? false, repoOrigin: launch.repoOrigin, writable: launch.writable ?? [], doors: launch.doors, netOpen: launch.netOpen, denied, depth };
}

/** Machine-readable manifest (exported into the box as $CLAUDE_BOX_CAPABILITIES)
 *  — the surface the in-box runtime (prx) will gate its tools on. */
function capabilityJson(m: Manifest): string {
  const netDoor = m.doors.some((d) => d.name === "net");
  return JSON.stringify({
    workcell: "claude-box",
    guest: m.guest,
    // Spawn depth of this box (0 = root). lib/spawn.ts reads this to increment
    // the child's depth so launcherd's maxDepth ceiling holds across nesting.
    depth: m.depth,
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
    "- config: your auth/history (a private volume).",
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
      // NETD_REQUIRE_GRANT=0: this is a LOCAL, co-located scoped netd the box
      // reaches over the host loopback — trusted like a mount, so it opts out of
      // the tcp signed-grant gate (which is for an untrusted REMOTE netd). Without
      // this it would 407 the ungranted box it exists to serve.
      env: { ...process.env, NETD_ALLOW: allow.join(","), NETD_REQUIRE_GRANT: "0" },
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
async function runPod(launch: Launch): Promise<number> {
  const { guest, repo, repoOrigin, repoDoor, repoDoorRef, guestArgs } = launch;
  if (repo) {
    console.error(
      "claude-box: --pod v1 supports --repo-origin/--repo-door or no repo; host-mount --repo in a pod is a follow-up (POD.md).",
    );
    process.exit(2);
  }
  const guestPreset = knownGuests()[guest]!;
  const manifest = buildManifest(launch);

  // The pod's netd door: anthropic egress + (if cloning in-box) the origin host.
  // --repo-door needs NO egress at all (repod's clone is same-machine, no
  // network) — it isn't added to the allowlist.
  const allow = ["api.anthropic.com", ".anthropic.com"];
  if (repoOrigin) allow.push(originHostOf(repoOrigin));

  const id = crypto.randomUUID().slice(0, 8);
  const podName = `claude-box-${id}`;
  const netdName = `${podName}-netd`;
  const netdSharedVolume = `${podName}-netd-shared`;
  const repodName = `${podName}-repod`;
  const repodSharedVolume = `${podName}-repod-shared`;
  const sh = (a: string[]) => Bun.spawnSync(a, { stdout: "pipe", stderr: "pipe" });

  const created = sh(["podman", "pod", "create", "--name", podName]);
  if (created.exitCode !== 0) {
    console.error(`claude-box: pod create failed: ${created.stderr.toString().trim()}`);
    process.exit(2);
  }

  try {
    // netd SIDECAR — the egress door, in the pod's netns. Runs the netd script
    // from this source tree via the image's bun (no separate daemon image yet).
    // UNIX SOCKET, not TCP: pod sidecars share one VM kernel (no virtiofs
    // crossing, exactly like repod's shared-volume socket), so netd gets real
    // kernel-enforced SO_PEERCRED identity for free — the same authority model
    // keeperd/scoutd already use — instead of needing a signed-grant dance
    // for a transport (TCP) that has no peer identity at all. claude-room's
    // own launch below runs an in-box `socat` relay (already baked into the
    // image, the SAME pattern the standalone launch's "Unix socket mode"
    // already documents) so claude/git/npm can still speak ordinary
    // HTTPS_PROXY=http://localhost:3128 — that TCP hop never leaves
    // claude-room's own netns; the real authority boundary is netd's socket.
    const netd = sh([
      "podman", "run", "-d", "--pod", podName, "--name", netdName,
      "-v", `${import.meta.dir}:/src:ro`,
      "-v", `${netdSharedVolume}:/shared`,
      "-e", `NETD_ALLOW=${allow.join(",")}`,
      "--entrypoint", "bun", IMAGE, "/src/netd/netd.ts", "serve", "--socket", "/shared/netd.sock",
    ]);
    if (netd.exitCode !== 0) {
      console.error(`claude-box: netd sidecar failed: ${netd.stderr.toString().trim()}`);
      process.exit(2);
    }
    console.error(`claude-box: --pod — netd door in pod ${podName} (allow=${allow.join(",")}); doors are OFF the host`);

    // Wait for netd's unix socket to appear inside the pod.
    let up = false;
    for (let i = 0; i < 40; i++) {
      if (sh(["podman", "exec", netdName, "test", "-S", "/shared/netd.sock"]).exitCode === 0) {
        up = true;
        break;
      }
      await Bun.sleep(300);
    }
    if (!up) {
      console.error("claude-box: netd door did not come up in the pod");
      process.exit(2);
    }

    // repod SIDECAR (--repo-door only): the ONE place real git access to the
    // host bare repo lives. The bare repo mount is READ-WRITE for repod —
    // `git worktree add -b <newBranch>` writes a new ref into the bare
    // repo's own refs/heads/ and its worktrees/ administrative area, so :ro
    // isn't sufficient even though repod never touches tracked FILE CONTENT
    // beyond what git itself manages. claude-room, which never mounts the
    // bare repo at all, is unaffected either way — this is repod's own
    // access, not a widening of what the agent can reach. READ-WRITE on a
    // shared pod-internal volume ALSO mounted into claude-room, so whatever
    // path repod returns is immediately valid there too. Reached over a unix
    // socket on that same shared volume — pod-internal only, no TCP, no
    // netd egress needed (a same-machine `git worktree add` needs no network).
    if (repoDoor) {
      const repod = sh([
        "podman", "run", "-d", "--pod", podName, "--name", repodName,
        "-v", `${import.meta.dir}:/src:ro`,
        "-v", `${resolve(repoDoor)}:/bare-repo`,
        "-v", `${repodSharedVolume}:/shared`,
        "-e", "REPOD_BARE_REPO=/bare-repo",
        "-e", "REPOD_OUT_DIR=/shared/checkouts",
        "--entrypoint", "bun", IMAGE, "/src/repod.ts", "serve", "--socket", "/shared/repod.sock",
      ]);
      if (repod.exitCode !== 0) {
        console.error(`claude-box: repod sidecar failed: ${repod.stderr.toString().trim()}`);
        process.exit(2);
      }
      console.error(`claude-box: --repo-door — repod sidecar in pod ${podName}, bare repo ${repoDoor}; claude-room gets no .git, no bind-mount, only a materialized checkout`);

      let repodUp = false;
      for (let i = 0; i < 40; i++) {
        if (sh(["podman", "exec", repodName, "test", "-S", "/shared/repod.sock"]).exitCode === 0) {
          repodUp = true;
          break;
        }
        await Bun.sleep(300);
      }
      if (!repodUp) {
        console.error("claude-box: repod door did not come up in the pod");
        process.exit(2);
      }
    }

    // The BOX in the same pod reaches netd via an in-box `socat` relay (baked
    // into the image), NOT directly — netd itself listens on a unix socket
    // (see above); this relay is the ONE place TCP touches the box, and it
    // never leaves claude-room's own netns. `& sleep 0.3` gives it a moment
    // to bind before anything tries to use the proxy.
    const proxy = "http://localhost:3128";
    // Runs unconditionally for every guest today — none of the current guests
    // (claude, git, npm) support a unix-socket proxy target natively, so
    // there's no case yet where skipping this would work. FILED, not built: if
    // a future guest DID support unix-socket proxying directly, it'd be a
    // legitimate optimization to detect that and skip the relay for it.
    const netdRelayCmd = `socat TCP-LISTEN:3128,fork,reuseaddr,bind=127.0.0.1 UNIX-CONNECT:/shared-netd/netd.sock & sleep 0.3;`;
    const argv = [
      "podman", "run", "-it", "--rm", "--pod", podName,
      "--security-opt", "no-new-privileges", "--cap-drop", "all", "--pids-limit", "2048",
      "-v", `${netdSharedVolume}:/shared-netd`,
    ];
    if (guestPreset.needsConfig) {
      argv.push("-v", `claude-config:${BOX_CONFIG_DIR}:U`);
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
        `${netdRelayCmd} export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true; git clone --depth 1 "$1" /work || { echo "claude-box: clone failed — --repo-origin clones over netd with NO credentials (works for PUBLIC repos). For a private repo, use the scout read-door, which injects the token. There is no TTY to prompt on." >&2; exit 1; }; git config --global --add safe.directory /work && cd /work && shift && exec ${guestCmd} "$@"`,
        "claude-box", repoOrigin,
      );
      if (guest === "claude") argv.push("--append-system-prompt", capabilityPrompt(manifest));
      argv.push(...guestArgs);
    } else if (repoDoor) {
      // Ask repod (over the shared unix socket, pod-internal) for a checkout,
      // then cd into whatever path it hands back and exec the guest — same
      // shared volume mounted at the same path in both containers, so the
      // path repod returns is immediately valid here. NO .git, NO bind-mount
      // of the real repo — claude-room never touches git at all. Both -v
      // mounts must precede the image (podman treats anything after it as
      // the container's own argv, not options).
      // $1=ref, passed POSITIONALLY (never interpolated into the script), so
      // an unusual branch name can't inject shell syntax; repod's own
      // assertSafeRef is still the enforcement point, this is defense in depth.
      argv.push(
        "-v", `${repodSharedVolume}:/shared`,
        "-v", `${import.meta.dir}:/src:ro`,
        "-w", "/shared", "--entrypoint", "sh", IMAGE,
        "-c",
        `${netdRelayCmd} ref="$1"; shift; dir="$(bun /src/repod-client.ts /shared/repod.sock "$ref")" || { echo "claude-box: repod prepare failed" >&2; exit 1; }; cd "$dir" && exec ${guestCmd} "$@"`,
        "claude-box",
        repoDoorRef,
      );
      if (guest === "claude") argv.push("--append-system-prompt", capabilityPrompt(manifest));
      argv.push(...guestArgs);
    } else {
      // No repo: still needs the netd relay started before the guest runs, so
      // this now wraps in `sh -c` too (previously ran the image's own default
      // entrypoint directly, since no startup step was needed pre-socat). The
      // real command + its args are passed as trailing positional params
      // (after `--`), never string-interpolated, so arbitrary guestArgs
      // content can't inject shell syntax — `exec "$@"` just runs them.
      const cmdTokens = guestPreset.entrypoint ?? [guestCmd];
      argv.push("--entrypoint", "sh", IMAGE, "-c", `${netdRelayCmd} exec "$@"`, "claude-box");
      argv.push(...cmdTokens);
      if (guest === "claude") argv.push("--append-system-prompt", capabilityPrompt(manifest));
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

/** The stable name a --remote-serve bastion runs under.
 *  Every OTHER launch mode leaves podman to assign a random name (they're
 *  one-shot and torn down with the session) — a bastion is meant to be the
 *  ONE long-running box, so it gets a name worth checking for. */
function bastionName(): string {
  return "claude-box-remote-serve";
}

/** Is a bastion already running? Real liveness, not just a stale name —
 *  `podman ps` (not `ps -a`) only lists running containers. */
function bastionAlreadyRunning(): string | undefined {
  const p = Bun.spawnSync(
    ["podman", "ps", "--filter", `name=^${bastionName()}$`, "--format", "{{.Names}}"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const name = p.stdout.toString().trim();
  return name || undefined;
}

async function run(
  launch: Launch,
  env: Env = process.env,
): Promise<number> {
  // --pod: the box and its doors live in their own pod, off the host (POD.md).
  if (launch.pod) return runPod(launch);
  // --remote-serve is meant to be the ONE persistent bastion per machine —
  // launching a second one silently (no --name, a random podman name) is
  // exactly how this session ended up with 3+ orphaned duplicate sessions.
  // Refuse rather than pile on another one; the existing session is still
  // reachable at its own claude.ai/code URL.
  if (launch.remoteServe) {
    const existing = bastionAlreadyRunning();
    if (existing) {
      console.error(
        `claude-box: a --remote-serve bastion is already running (container "${existing}"). ` +
          `Attach to it from claude.ai/code or the Claude app instead of launching another — ` +
          `or stop it first with: podman kill ${existing}`,
      );
      return 1;
    }
  }
  const { guest, repo, repoRw, repoEphemeral, repoClone, repoOrigin, writable, doors, netOpen, guestArgs } = launch;
  const guestPreset = knownGuests()[guest]!;
  const manifest = buildManifest(launch, env);
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
  if (launch.remoteServe) {
    argv.push("--name", bastionName());
  }
  // Only mount config for guests that need it (claude). Tool guests don't
  // need or want claude's auth/history. --remote-serve is the one exception:
  // its credential is LEASED from authd at boot (and re-leased periodically —
  // see the lease step below), never a persisted refresh token, so it gets a
  // throwaway tmpfs instead of the shared volume — nothing about a bastion's
  // identity lives at rest anywhere.
  if (guestPreset.needsConfig) {
    if (launch.remoteServe) {
      // mode=1777 (world-writable + sticky, like /tmp): podman's --tmpfs has
      // no uid/gid option (confirmed: "invalid mount option"), and a bare
      // tmpfs defaults to root:root ownership — the in-image `claude` user
      // (uid 1000) could write during login but couldn't read it back
      // afterward. 1777 lets claude create+own its own files in a
      // root-owned dir; the sticky bit still stops other users in this
      // single-user throwaway container from deleting/renaming them.
      argv.push("--tmpfs", `${BOX_CONFIG_DIR}:rw,mode=1777`);
    } else {
      argv.push("-v", `claude-config:${BOX_CONFIG_DIR}:U`);
    }
  }
  // Auth: by default forward a pre-minted, inference-only `claude setup-token`
  // (no in-box browser flow). --remote-control omits the token so a full-scope
  // in-box `claude auth login` (paste-code flow, persisted in the config
  // volume) can drive Remote Control. --remote-serve ALSO omits it, but never
  // does its own login — its credential comes from authd (see the lease step
  // below), not a paste-code flow in this box. See authEnvArgs.
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
        "claude-box: --repo-origin needs TCP mode for its scoped git-pull door — automatic on macOS; on Linux set DOORS_TCP=1.",
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

  // Profiles that need MORE than the shared netd's default anthropic-only
  // allowlist (--remote-control/--remote-serve's statsig/claude.ai widening,
  // --pathbase's pathbase.dev widening) each route through this ONE scoped
  // netd instead of the shared one — its allowlist is the union of whichever
  // profiles this launch actually set (rcEgressAllow / pathbaseEgressAllow
  // both return [] unless their own flag is set, so a plain launch never
  // widens anything). Like --repo-origin, it needs TCP mode (the box reaches
  // the scoped netd over the host gateway). The scoped netd opts out of the
  // grant gate (it's local).
  let scopedNetd: { port: number; stop: () => void } | undefined;
  const scopedAllow = [...new Set([...rcEgressAllow(launch), ...pathbaseEgressAllow(launch)])];
  if (scopedAllow.length > 0 && !netOpen) {
    if (!tcpMode) {
      console.error(
        "claude-box: --remote-control/--remote-serve/--pathbase need TCP mode for their scoped egress door — automatic on macOS; on Linux set DOORS_TCP=1.",
      );
      process.exit(2);
    }
    scopedNetd = await startScopedNetd(scopedAllow);
    console.error(
      `claude-box: scoped egress door allowlists [${scopedAllow.join(", ")}] (netd :${scopedNetd.port})`,
    );
  }

  if (netOpen) {
    console.error(
      "claude-box: --net-open — UNPOLICED full network egress (no netd allowlist)",
    );
  } else if (tcpMode && doors.length > 0) {
    // TCP mode: use default network so container can reach host.containers.internal
    // netd's allowlist is the security boundary (HTTPS_PROXY → netd). For an RC
    // launch, point at its OWN scoped netd (wider allowlist) instead of the shared.
    if (netDoor) {
      const proxy = scopedNetd ? `http://host.containers.internal:${scopedNetd.port}` : NETD_TCP_PROXY;
      argv.push(
        "--env",
        `HTTPS_PROXY=${proxy}`,
        "--env",
        `HTTP_PROXY=${proxy}`,
        "--env",
        `ALL_PROXY=${proxy}`,
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

  // Forward doors: preflight (side effects: existence / reachability / hijack
  // check), then append the pure mount+env argv from planDoorMounts.
  if (doors.length > 0) {
    if (tcpMode) {
      // Preflight each door's daemon so a down door fails here with a hint,
      // not later inside the box with an opaque connection error.
      for (const d of doors) {
        await assertTcpDoorReachable(d.name);
      }
    } else {
      // Each granted socket must exist (daemon up) and sit in a non-world-
      // writable dir (or another host user could pre-create the socket and MITM
      // the door). planDoorMounts then mounts each granted socket INDIVIDUALLY.
      for (const d of doors) {
        const hostPath = unixPath(d.host);
        assertSocketExists(hostPath, d.name);
        assertSocketDir(hostPath, d.name); // hijack-risk check on the source dir
      }
    }
    argv.push(...planDoorMounts(doors, tcpMode));
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
  // remoteServeArgs() prepends "remote-control" when --remote-serve is set —
  // a fixed, known-safe literal, so it's safe to splice into the shell script
  // below.
  const guestCmd = [
    guestPreset.entrypoint?.[0] ?? (guest === "claude" ? "claude" : "sh"),
    ...remoteServeArgs(launch),
  ].join(" ");
  if (repoOrigin) {
    argv.push("--tmpfs", "/work:rw,mode=1777", "-w", "/work", "--entrypoint", "sh");
  } else if (launch.remoteServe && guest === "claude") {
    // Remote Control's workspace is the bare $HOME (no --repo mount), and
    // Claude Code deliberately never persists trust-dialog acceptance for a
    // home-directory workspace — it re-prompts "Workspace not trusted" on
    // every single launch (confirmed live). Fix: run in a stable NON-home
    // subdir instead, and pre-seed that dir's hasTrustDialogAccepted=true in
    // .claude.json (which lives in the persistent config volume) before
    // exec'ing claude. See RC_WORKSPACE below.
    argv.push("--entrypoint", "sh");
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
      // Both http(s)_proxy pairs are set — a plain http:// origin only honors
      // http_proxy/HTTP_PROXY; an https:// remote only honors the https pair.
      // Setting both is a no-op for whichever scheme isn't in play. --depth 1
      // is tried first (shallow, fast, what a real smart-HTTP/SSH remote wants)
      // and falls back to a full clone if it fails — dumb-HTTP (a bare static
      // file server, no CGI) can't negotiate a shallow fetch at all.
      `url="$1"; gp="$2"; shift 2; export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true; export http_proxy="$gp" HTTP_PROXY="$gp" https_proxy="$gp" HTTPS_PROXY="$gp"; git clone --depth 1 "$url" /work 2>/dev/null || git clone "$url" /work || { echo "claude-box: clone failed — --repo-origin clones with NO credentials (works for PUBLIC repos). Private repos need the scout read-door. No TTY to prompt on." >&2; exit 1; }; git config --global --add safe.directory /work && cd /work && exec ${guestCmd} "$@"`,
      "claude-box",
      repoOrigin,
      gitDoorProxy,
    );
    // `claude remote-control` has no --append-system-prompt equivalent (see the
    // matching skip in the non-origin branch below) — omit it for RC server mode.
    if (guest === "claude" && !launch.remoteServe) {
      argv.push("--append-system-prompt", capabilityPrompt(manifest));
    }
    argv.push(...guestArgs);
  } else {
    // For claude guest, inject the honest surface into the agent's context
    // (granted AND denied), so the box KNOWS its powers and limits. Tool guests
    // don't need or parse system prompts — they just run their command.
    // --remote-serve prepends the RC server-mode subcommand so the box boots as
    // `claude remote-control` (see remoteServeArgs); empty otherwise, leaving
    // the interactive entrypoint untouched.
    if (guest === "claude" && launch.remoteServe) {
      console.error(
        "claude-box: --remote-serve — booting as a headless Remote Control server (attach from the Claude app/mobile)",
      );
      // If a repo is mounted, RC runs THERE (/work, already the podman -w) —
      // not the synthetic no-repo workspace. Either way the workspace still
      // needs its trust pre-seeded — see buildRemoteServeScript, which also
      // skips the mkdir when a repo is mounted since planRepoMount already
      // bind-mounted it.
      // Lease the RC credential from authd BEFORE claude ever starts (the tmpfs
      // config mount above starts with no .credentials.json at all), then keep
      // it fresh with a backgrounded re-lease every 10 minutes for as long as
      // this bastion stays up — see authLeaseCmd's doc comment for the one
      // open question (does claude re-read it mid-session). authd's tcp gate
      // always requires a grant (no opt-out — see mintAuthGrant); audience is
      // the fixed bastion name, since there's only ever ONE per machine.
      const authDoor = doors.find((d) => d.name === "auth");
      const grant = authDoor ? mintAuthGrant(authDoor, bastionName()) : undefined;
      const leaseCmd = authLeaseCmd(grant);
      // sh -c '<script>' claude-box <remoteServeArgs…> : "$@" is exactly the
      // remote-control invocation (remoteServeArgs), never string-interpolated.
      argv.push(
        "-c",
        buildRemoteServeScript({ repo, rcWorkspace: RC_WORKSPACE, leaseCmd }),
        "claude-box",
        ...remoteServeArgs(launch),
      );
    } else {
      if (guest === "claude") {
        argv.push("--append-system-prompt", capabilityPrompt(manifest));
      }
      // Add entrypoint override if the guest specifies one, then the args.
      if (guestPreset.entrypoint) {
        argv.push(...guestPreset.entrypoint);
      }
      argv.push(...guestArgs);
    }
  }
  const proc = Bun.spawn(argv, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  // --remote-serve: the RC session list shows a hex string under the display
  // name (claude.ai/code reads it from the container's own id, likely via
  // $HOSTNAME) — that hex is otherwise only discoverable by hunting through
  // `podman ps` after the fact, which is exactly how this session ended up
  // needing several rounds of manual correlation to find stale entries.
  // Surface it up front instead: poll (the container needs a moment to
  // exist) without blocking the interactive attach above.
  if (launch.remoteServe) {
    void (async () => {
      const name = bastionName();
      for (let i = 0; i < 20; i++) {
        const p = Bun.spawnSync(["podman", "inspect", name, "--format", "{{.Id}}"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const id = p.stdout.toString().trim();
        if (p.exitCode === 0 && id) {
          console.error(
            `claude-box: this bastion's container id is ${id.slice(0, 12)} — the hex string shown under its name in the Remote Control list`,
          );
          return;
        }
        await Bun.sleep(250);
      }
    })();
  }
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

  // Tear down the per-launch scoped egress door (RC and/or --pathbase).
  if (scopedNetd) {
    console.error(`claude-box: stopping scoped egress door (netd :${scopedNetd.port})`);
    scopedNetd.stop();
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
      "LAUNCH ID                    PID    DOORS              REPO",
    );
    for (const l of result.launches) {
      const doors = l.doors.join(",") || "-";
      const repo = l.repo ?? "-";
      console.log(
        `${l.launchId.padEnd(28)} ${String(l.pid).padEnd(6)} ${doors.padEnd(18)} ${repo}`,
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

/** Containers (other than our own `dolt`) currently holding the prx-dolt-data
 *  volume — a violation of the single-writer invariant (capability contract I5).
 *  A second dolt sql-server can't corrupt the store (dolt's own working-set lock
 *  stops it), but it wedges it; beads writers must go through beadsd, never open
 *  their own server. Empty in the healthy single-writer case. */
async function competingDoltWriters(): Promise<string[]> {
  const proc = Bun.spawn(
    ["podman", "ps", "--format", "{{.Names}}", "--filter", "volume=prx-dolt-data"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !out) return [];
  return out.split("\n").map((s) => s.trim()).filter((n) => n && n !== "dolt");
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

  // Single-writer check (contract I5): flag any competing holder of the beads
  // store, independent of box/image state.
  const doltIntruders = await competingDoltWriters();
  const doltBad = doltIntruders.length > 0;
  if (doltBad) {
    console.error(
      `⚠ single-writer violation (I5): prx-dolt-data is held by ${doltIntruders.join(", ")} ` +
        `besides the 'dolt' door backend.\n` +
        `  The beads store must have exactly ONE writer; other actors reach beads through\n` +
        `  beadsd. Stop the competing writer:  podman stop ${doltIntruders.join(" ")}\n`,
    );
  }

  const boxes = await runningBoxes();
  const stale = findStaleBoxes(boxes, cur);

  console.log(`current image: ${normImageId(cur).slice(0, 12)} (${IMAGE})`);
  console.log(`running boxes: ${boxes.length}\n`);

  if (boxes.length === 0) {
    console.log("no running boxes — nothing to check.");
    return doltBad ? 1 : 0;
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
    return doltBad ? 1 : 0;
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
      `  # then relaunch, e.g.:  claude-box`,
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

/** Run a one-shot, output-capturing command against wherever systemd/journald
 *  actually live: inside the podman machine VM (macOS — routed through
 *  podmanMachineExec) or directly (Linux, no VM in the way). Plain `podman`
 *  commands (ps/inspect/...) never need this — the podman CLI itself already
 *  proxies to the machine's remote API on its own; this is only for the
 *  VM-side OS commands (systemctl, journalctl) that podman doesn't proxy. */
async function runOnDoorHost(
  useMachine: boolean,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  if (useMachine) return podmanMachineExec(args);
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
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

TCP Mode (automatic on macOS):
  'doors serve' runs daemons on TCP ports (not Unix sockets) because virtiofs
  can't share sockets between macOS and the podman machine VM. claude-box
  detects macOS and uses TCP mode automatically — nothing to set. Containers
  reach daemons via host.containers.internal:PORT. On Linux (no VM, plain
  unix sockets work) set DOORS_TCP=1 to force it on anyway if ever needed.

  TCP ports: keeperd=${TCP_PORTS.keeperd}, netd=${TCP_PORTS.netd}, scoutd=${TCP_PORTS.scoutd}

Examples:
  claude-box doors serve      run daemons on TCP (Ctrl+C to stop)
  claude-box --room dev       launch box with TCP doors (macOS: automatic)
  claude-box doors init       first-time setup (containerized, for Linux)
  claude-box doors status     status of all doors`);
    return subcmd === "-h" || subcmd === "--help" ? 0 : 1;
  }

  const useMachine = await hasPodmanMachine();

  const runSystemctl = (args: string[]) =>
    runOnDoorHost(useMachine, ["systemctl", "--user", ...args]);

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
      console.log("\nRun 'claude-box' to launch.");
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
      console.log("\nLaunch a box (TCP mode is automatic on macOS):");
      console.log("  claude-box\n");

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

/** `claude-box login` — launch a minimal, repo-less box bound to the config
 *  volume so you can authenticate once and persist it. Log in inside
 *  (`/login`); the full-scope credential lands in `claude-config`, and it is
 *  then the front door for `--remote-control`. See planLogin. */
async function cmdLogin(args: string[]): Promise<number> {
  let plan;
  try {
    plan = planLogin(args);
  } catch (e) {
    console.error((e as Error).message);
    console.error("usage: claude-box login");
    return 1;
  }
  const { launch } = plan;
  console.error(
    "claude-box: login box (no repo). Run /login inside to do a full-scope " +
      "login, then exit — it persists in claude-config.",
  );
  return run(launch);
}

/** `claude-box check-in` — the human-backed login authd's ephemeral store
 *  needs, run as a real guest-room: the SAME sandbox floor every other box
 *  gets (uid 1000, no-new-privileges, cap-drop all), a THROWAWAY tmpfs config
 *  dir (nothing persists in any long-lived volume — a fresh check-in every
 *  time, no shared `claude-config` volume involved at all), and a real
 *  interactive TTY so the human does the OAuth browser/paste flow themselves
 *  (`claude auth login`), exactly like every other guest-room interaction —
 *  this was previously an ad hoc host-side script; this is that same flow as
 *  an actual claude-box launch mode.
 *
 *  On success, prints the resulting ClaudeCredentials JSON to stdout — one
 *  line, meant to be piped straight into authd's stdin:
 *    claude-box check-in | authd serve
 *  The short-lived host tmpdir used to ferry the credential out of the
 *  --rm'd container is deleted immediately after, whether or not the read
 *  succeeded — this session's authd door is `check-out`: no persistence,
 *  no lingering plaintext, one guest-room per stay. */
/** Runs the throwaway login guest-room and returns the resulting credential
 *  JSON line — or undefined if the login didn't succeed. Never prints it;
 *  callers decide whether it goes to stdout (cmdCheckIn) or straight into
 *  another process's stdin (cmdAuthdUp). See cmdCheckIn's doc comment for
 *  the full rationale (throwaway tmpfs, /dev/tty, oauthAccount bundling). */
async function runCheckIn(): Promise<string | undefined> {
  const guestPreset = knownGuests().claude!;
  const outDir = mkdtempSync(join(boxTempBase(), "check-in-"));
  try {
    const argv = [
      "podman", "run", "-it", "--rm",
      "--security-opt", "no-new-privileges", "--cap-drop", "all", "--pids-limit", "2048",
      // mode=1777 (world-writable + sticky, like /tmp): podman's --tmpfs has
      // no uid/gid option, and a bare tmpfs defaults to root:root ownership —
      // the in-image `claude` user (uid 1000) could write during login but
      // couldn't read its own file back afterward without this.
      "--tmpfs", `${BOX_CONFIG_DIR}:rw,mode=1777`,
      "-v", `${outDir}:/check-in-out`,
      "--entrypoint", "sh", guestPreset.image,
      "-c",
      // `claude auth status` after login forces the org/profile lookup that
      // populates .claude.json's oauthAccount — `claude remote-control`'s
      // eligibility check reads THAT, not anything in .credentials.json, and
      // fails ("Unable to determine your organization") without it even with
      // an otherwise-valid credential (confirmed live). Bundle both into one
      // JSON blob matching authd's ClaudeCredentials shape (see
      // schemas/claude-credentials.schema.json, schemas/claude-json.schema.json).
      `claude auth login && (claude auth status --json >/dev/null 2>&1 || true) && bun -e 'const fs=require("fs"),d=process.env.CLAUDE_CONFIG_DIR;const creds=JSON.parse(fs.readFileSync(d+"/.credentials.json","utf8"));let cj={};try{cj=JSON.parse(fs.readFileSync(d+"/.claude.json","utf8"))}catch{};fs.writeFileSync("/check-in-out/cred.json",JSON.stringify({claudeAiOauth:creds.claudeAiOauth,oauthAccount:cj.oauthAccount??null}))'`,
    ];
    console.error("claude-box: check-in — a throwaway guest-room, nothing persists. Complete the login, then exit.");
    // The interactive login (URL, paste prompt) must always render on the
    // REAL terminal, even when this command's own stdout is piped/redirected
    // elsewhere (`check-in | authd serve`) — "inherit" would otherwise send
    // that interactive output down the same pipe, silently starving both the
    // user (no visible prompt) and authd (which blocks reading stdin until
    // EOF). /dev/tty bypasses the outer process's stdio entirely.
    // A single read-write fd (not two separate opens) so a real terminal's
    // stdin/stdout/stderr all reference the SAME tty device, as they would
    // for an ordinary interactive process.
    let tty: number | undefined;
    try {
      tty = openSync("/dev/tty", "r+");
    } catch {
      // No controlling terminal (e.g. a non-interactive CI run) — best effort.
    }
    const proc = Bun.spawn(argv, {
      stdin: tty ?? "inherit",
      stdout: tty ?? "inherit",
      stderr: tty ?? "inherit",
    });
    const code = await proc.exited;
    if (tty !== undefined) closeSync(tty);
    if (code !== 0) return undefined;
    const credPath = join(outDir, "cred.json");
    if (!existsSync(credPath)) {
      console.error("claude-box: check-in — login exited 0 but no credential was produced");
      return undefined;
    }
    return readFileSync(credPath, "utf-8").trim();
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

async function cmdCheckIn(): Promise<number> {
  const cred = await runCheckIn();
  if (cred === undefined) return 1;
  console.log(cred);
  return 0;
}

/** `claude-box internal-mint-auth-grant --audience NAME` — host-only. Mints
 *  a fresh signed "auth" door grant (same signing key + mechanism as the
 *  inline mint inside run()'s --remote-serve branch, mintAuthGrant) and
 *  prints it, base64-encoded, to stdout — nothing else on that line, so a
 *  shell can capture it directly:
 *
 *    echo "CLAUDE_BOX_RC_GRANT=$(claude-box internal-mint-auth-grant \
 *      --audience claude-box-remote-serve)" > grant.env
 *
 *  This is the missing piece for a systemd/Quadlet-managed bastion (see
 *  quadlet/remote-serve.container's header comment): there is no CLI
 *  invocation moment for such a container to mint its own grant inline, so
 *  a Quadlet unit's `ExecStartPre=` runs this instead, writing an
 *  EnvironmentFile= that hands the container's boot script
 *  (authLeaseFromEnvCmd) the grant to decode at runtime. The signing key
 *  itself never leaves the host — only the signed grant object does,
 *  exactly as when a CLI-invoked bastion mints one for itself. */
function cmdMintAuthGrant(args: string[]): number {
  const audIdx = args.indexOf("--audience");
  const audience = audIdx >= 0 ? args[audIdx + 1] : undefined;
  if (!audience) {
    console.error("claude-box: internal-mint-auth-grant requires --audience NAME");
    return 1;
  }
  const authDoor = resolveDoor("auth", undefined, process.env);
  const grant = mintAuthGrant(authDoor, audience);
  console.log(Buffer.from(JSON.stringify(grant), "utf-8").toString("base64"));
  return 0;
}

/** `claude-box internal-print-rc-boot-script` — host-only. Prints the exact
 *  RC bootstrap script (buildRemoteServeScript) a Quadlet-managed bastion
 *  should run as its entrypoint, using authLeaseFromEnvCmd so the lease step
 *  reads its grant from $CLAUDE_BOX_RC_GRANT at runtime instead of having it
 *  baked in (see cmdMintAuthGrant / quadlet/remote-serve.container).
 *
 *  This exists so the Quadlet unit's `Exec=` never has to embed the script's
 *  quote-heavy content directly in systemd unit-file syntax (which has its
 *  own argv-splitting rules, distinct from POSIX shell, and is easy to get
 *  subtly wrong for a script this size) — instead `ExecStartPre=` writes
 *  this output to a host file once at start, the unit bind-mounts that file
 *  in read-only, and `Exec=` just runs it by path. */
function cmdPrintRcBootScript(): number {
  console.log(
    buildRemoteServeScript({
      rcWorkspace: RC_WORKSPACE,
      leaseCmd: authLeaseFromEnvCmd("CLAUDE_BOX_RC_GRANT"),
      // A Quadlet-managed bastion is always unix-socket mode (never TCP —
      // that's the macOS/virtiofs-only accommodation), so HTTPS_PROXY=
      // http://127.0.0.1:3128 needs this relay bridging to the mounted
      // /run/doors/netd.sock, the same way run()'s pod/repo-origin
      // branches already bridge it for their own launch shapes.
      netdRelay: "socat TCP-LISTEN:3128,fork,reuseaddr,bind=127.0.0.1 UNIX-CONNECT:/run/doors/netd.sock & sleep 0.3;",
    }),
  );
  return 0;
}

const REMOTE_SERVE_CONTAINER = "claude-box-remote-serve";
const REMOTE_SERVE_SERVICE = "remote-serve";

/** `claude-box remote-serve-status` — wraps the ad hoc `podman ps` /
 *  `systemctl --user status` / `journalctl` dance used to sanity-check the
 *  singleton RC bastion into one command, run either directly (Linux) or
 *  routed into the podman machine VM (macOS — see runOnDoorHost).
 *
 *  IMPORTANT scope limit, spelled out here so it isn't assumed away by a
 *  future reader: the identifier the Claude app's Remote Control picker
 *  shows next to a session (a short hex string) is assigned by Anthropic's
 *  backend when `claude remote-control` registers the session — it is NOT
 *  derived from, or guaranteed to match, this container's own id/hostname.
 *  This command can tell you "is the bastion running, which container backs
 *  it, since when" — it cannot tell you "is THIS the session the app is
 *  showing," short of restarting the bastion and watching whether the app's
 *  entry changes to a new identifier right after (a real but disruptive
 *  test, deliberately not automated here — it kills whatever's attached). */
async function cmdRemoteServeStatus(): Promise<number> {
  const useMachine = await hasPodmanMachine();

  const svc = await runOnDoorHost(useMachine, [
    "systemctl", "--user", "is-active", REMOTE_SERVE_SERVICE,
  ]);
  console.log(`remote-serve.service: ${svc.stdout || svc.stderr || "unknown"}`);

  const inspect = Bun.spawnSync(
    ["podman", "inspect", REMOTE_SERVE_CONTAINER, "--format", "{{.Id}}|{{.State.StartedAt}}|{{.State.Running}}"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (inspect.exitCode !== 0) {
    console.log(`container: not found (${new TextDecoder().decode(inspect.stderr).trim() || "no such container"})`);
    return svc.ok ? 0 : 1;
  }
  const [fullId, startedAt, running] = new TextDecoder().decode(inspect.stdout).trim().split("|");
  console.log(`container: ${REMOTE_SERVE_CONTAINER}`);
  console.log(`  id: ${fullId?.slice(0, 12)} (full: ${fullId})`);
  console.log(`  running: ${running}`);
  console.log(`  started: ${startedAt}`);

  // How many times has this unit (re)started recently? A tight cluster of
  // "Take this session with you" banners is the crash-loop signature this
  // exact command was built to catch (see this session's own debugging:
  // RestartSec=5 means ~7 restarts in 40s reads as "it was crash-looping",
  // not "seven people opened seven sessions").
  const journal = await runOnDoorHost(useMachine, [
    "journalctl", "--user", "-u", REMOTE_SERVE_SERVICE, "--no-pager",
    "--since", "-15min", "-o", "cat",
  ]);
  const banners = journal.stdout.split("\n").filter((l) => l.includes("Take this session with you")).length;
  console.log(`  RC session starts in the last 15min: ${banners}${banners >= 4 ? "  ⚠ crash-loop pattern — check journalctl --user -u remote-serve" : ""}`);

  console.log(
    `\nNote: the id the Claude app shows in its Remote Control picker is assigned\n` +
    `by Anthropic's backend, not derived from this container — it will not\n` +
    `necessarily match the "id" line above. To confirm causally, restart this\n` +
    `service and check whether the app's entry changes right after (this\n` +
    `interrupts whatever's currently attached):\n` +
    `  ${useMachine ? "podman machine ssh -- " : ""}systemctl --user restart ${REMOTE_SERVE_SERVICE}`,
  );
  return svc.ok && running === "true" ? 0 : 1;
}

/** `claude-box authd-up` — the one-command version of the check-in → seed →
 *  serve dance this session did by hand across several terminals: runs
 *  check-in interactively, then starts `authd serve` DETACHED (nohup'd,
 *  survives this terminal closing) seeded with that credential, and returns
 *  once it's listening. No-op if authd is already reachable.
 *
 *  The credential never touches disk, an argv, or an env var (all three are
 *  inspectable via `ps`/`/proc` by other processes on this machine) — it's
 *  fed through a named pipe (the same technique used earlier this session
 *  for driving a backgrounded podman login's stdin), opened read-write so
 *  neither side blocks on open order. */
async function cmdAuthdUp(): Promise<number> {
  const port = TCP_PORTS.authd;
  if (await tcpReachable("127.0.0.1", port)) {
    console.log(`claude-box: authd already reachable at 127.0.0.1:${port} — nothing to do.`);
    return 0;
  }

  const cred = await runCheckIn();
  if (cred === undefined) {
    console.error("claude-box: authd-up — check-in did not produce a credential, aborting.");
    return 1;
  }

  const key = loadOrCreateBoxKey();
  const stateDir = `${process.env.XDG_STATE_HOME ?? `${process.env.HOME}/.local/state`}/claude-box`;
  mkdirSync(stateDir, { recursive: true });
  const logPath = join(stateDir, "authd.log");
  const runDir = mkdtempSync(join(boxTempBase(), "authd-up-"));
  const fifoPath = join(runDir, "cred.fifo");
  try {
    Bun.spawnSync(["mkfifo", fifoPath]);

    const scriptPath = `${dirname(Bun.main)}/authd.ts`;
    const env = {
      ROOM_ID: bastionName(),
      AUTHD_ISSUER_KEYS_PATH: issuerKeysPath(),
      AUTHD_REFRESH_LIVE: "1",
    };
    const envAssign = Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
    // nohup ignores SIGHUP so this survives the launching terminal closing;
    // `disown`ing it from THIS shell (not the launching one) is redundant —
    // nohup + backgrounding is what actually matters here. `< fifo` in the
    // backgrounded job's own redirection blocks THAT job's open, not this
    // sh -c, so `echo $!` returns immediately with the real pid.
    const startCmd = `nohup env ${envAssign} ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} serve --port ${port} < ${JSON.stringify(fifoPath)} > ${JSON.stringify(logPath)} 2>&1 & disown; echo $!`;
    const started = Bun.spawnSync(["sh", "-c", startCmd], { stdout: "pipe", stderr: "pipe" });
    const pid = started.stdout.toString().trim();
    if (started.exitCode !== 0 || !pid) {
      console.error(`claude-box: authd-up — failed to start authd: ${started.stderr.toString().trim()}`);
      return 1;
    }

    // Feed the credential through the fifo (read-write open avoids blocking
    // on open order against authd's own read-only open in the command above).
    const fifoFd = openSync(fifoPath, "r+");
    writeSync(fifoFd, `${cred}\n`);
    closeSync(fifoFd);

    // Confirm it actually came up before declaring success.
    let up = false;
    for (let i = 0; i < 20; i++) {
      if (await tcpReachable("127.0.0.1", port)) {
        up = true;
        break;
      }
      await Bun.sleep(250);
    }
    if (!up) {
      console.error(`claude-box: authd-up — started (pid ${pid}) but never became reachable; check ${logPath}`);
      return 1;
    }
    console.log(`claude-box: authd is up (pid ${pid}), listening on 127.0.0.1:${port}, logs: ${logPath}`);
    console.log(`claude-box: grant-signing key: ${issuerKeysPath()} (keyId ${key.keyId})`);
    return 0;
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  // TCP mode is automatic on macOS (podman there always runs through a VM;
  // virtiofs can't share unix sockets across that boundary) — nothing to
  // remember to set. An explicit DOORS_TCP (from the shell or the env this
  // process was launched with) always wins; this only fills in the default
  // when it's truly unset. isTcpMode() itself stays pure/env-driven so tests
  // are unaffected by whatever OS actually runs them.
  if (process.env.DOORS_TCP === undefined && process.platform === "darwin") {
    process.env.DOORS_TCP = "1";
  }

  const [first, ...rest] = Bun.argv.slice(2);

  switch (first) {
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
    case "login":
      return cmdLogin(rest);
    case "check-in":
      return cmdCheckIn();
    case "authd-up":
      return cmdAuthdUp();
    case "internal-mint-auth-grant":
      return cmdMintAuthGrant(rest);
    case "internal-print-rc-boot-script":
      return cmdPrintRcBootScript();
    case "remote-serve-status":
      return cmdRemoteServeStatus();
    case "auth-keys-path":
      // Prints the path to claude-box's own grant-signing public key (see
      // lib/box-keys.ts) — feed it to authd so it can verify grants a
      // --remote-serve launch mints: `AUTHD_ISSUER_KEYS_PATH=$(claude-box
      // auth-keys-path) authd serve --port 3003`. Generates the keypair on
      // first call if it doesn't exist yet.
      loadOrCreateBoxKey();
      console.log(issuerKeysPath());
      return 0;
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

  // Everything else is claude args passed straight through (so
  // `claude-box --resume` works, same as `claude --resume`).
  const tail = first !== undefined ? [first, ...rest] : [];

  const launch = planLaunch(tail);
  return run(launch);
}

// Importable by tests (planLaunch / resolveDoor / buildManifest / capability*),
// runnable as a script.
export {
  knownDoors,
  knownRooms,
  knownGuests,
  resolveDoor,
  planDoorMounts,
  planLaunch,
  planLogin,
  authEnvArgs,
  remoteServeArgs,
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
  bastionName,
  bastionAlreadyRunning,
  cmdMintAuthGrant,
  cmdPrintRcBootScript,
};
export type { DoorGrant, DoorTransport, Manifest, Launch, GuestPreset, RunningBox };

if (import.meta.main) {
  process.exit(await main());
}
