#!/usr/bin/env bun
/**
 * launcherd — the launch-controller daemon for claude-box.
 *
 * Listens on a unix socket, handles launch/list/kill/attach/status requests.
 * Owns: launch lifecycle, door prerequisite checking, L2 attestation, rooms.
 *
 * Usage:
 *   launcherd serve                     # foreground, default socket
 *   launcherd serve --socket /path.sock # custom socket path
 *   launcherd serve --key /path/to/key  # L2 signing key (Ed25519)
 */

import { statSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, sign, generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";
import type { Socket, UnixSocketListener } from "bun";
import {
  knownDoors,
  resolveDoor,
  planLaunch,
  buildManifest,
  capabilityJson,
  capabilityPrompt,
  transportString,
  unixPath,
  type DoorGrant,
  type Manifest,
  type Launch,
} from "./claude-box";
import {
  defaultSocketPath as runtimeSocketPath,
  prepareSocket,
  createLogger,
  type RequestEnvelope,
  type ResponseEnvelope,
  ok,
  err,
} from "./lib/runtime";
import {
  statement,
  PREDICATE_TYPE,
  IN_TOTO_STATEMENT_TYPE,
  type CapabilityProvenanceStatement,
  type DigestSet,
} from "./contract/types";
import {
  toSLSA,
  type SLSAStatement,
  SLSA_PROVENANCE_V1,
} from "./contract/slsa";

// ── Config ───────────────────────────────────────────────────────────────────

const VERSION = "0.1.0";
const IMAGE = "localhost/claude-personal:dev";
const NETD_PROXY = "http://127.0.0.1:3128";

const log = createLogger("launcherd");

function defaultSocketPath(): string {
  return runtimeSocketPath("launcherd");
}

function defaultKeyPath(): string {
  const home = process.env.HOME ?? "/tmp";
  return `${home}/.claude-box/launcherd.key`;
}

function defaultPolicyPath(): string {
  const home = process.env.HOME ?? "/tmp";
  return `${home}/.claude-box/policy.json`;
}

// ── Policy ───────────────────────────────────────────────────────────────────

type PolicyRule = {
  // Match conditions (all must match)
  uid?: number;           // Unix UID of the caller (via peercred SO_PEERCRED injection)
  token?: string;         // Caller token (for in-box callers without peercred)
  // Permissions
  allow: string[];        // Rooms/profiles this caller may request
  maxConcurrent?: number; // Max concurrent boxes this caller can have
};

/** Caller info injected by peercred proxy (SO_PEERCRED) */
type CallerInfo = {
  uid: number;
  gid: number;
  pid: number;
};

type Policy = {
  defaultAllow?: string[];  // Rooms allowed if no rule matches (default: none)
  maxConcurrent?: number;   // Global max concurrent boxes (default: unlimited)
  maxDepth?: number;        // Max spawn depth (nested boxes) - default: 3
  rateLimit?: {             // Rate limiting
    window: number;         // Time window in seconds
    max: number;            // Max launches in window
  };
  rules: PolicyRule[];
};

let policy: Policy | null = null;

// Rate limiting state
const launchTimes: number[] = [];  // Timestamps of recent launches

function loadPolicy(path: string): Policy | null {
  try {
    if (!existsSync(path)) {
      return null;
    }
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content) as Policy;
    // Validate structure
    if (!Array.isArray(parsed.rules)) {
      log("ERR", "invalid policy file (rules must be an array)");
      return null;
    }
    return parsed;
  } catch (e) {
    log("ERR", `failed to load policy: ${e}`);
    return null;
  }
}

/** Check if a room is allowed for the given caller. Returns true if allowed. */
function isRoomAllowed(roomName: string, caller?: CallerInfo, token?: string): boolean {
  // No policy = allow all (permissive default for development)
  if (!policy) {
    return true;
  }

  // Check rules in order (first matching rule wins)
  for (const rule of policy.rules) {
    // Match by UID (from peercred SO_PEERCRED injection)
    if (rule.uid !== undefined && caller?.uid === rule.uid) {
      return rule.allow.includes(roomName);
    }
    // Match by token (for in-box callers)
    if (rule.token !== undefined && token === rule.token) {
      return rule.allow.includes(roomName);
    }
  }

  // Check default allow
  if (policy.defaultAllow?.includes(roomName)) {
    return true;
  }

  // No matching rule and no default = deny
  return false;
}

/** Check rate limit. Returns true if launch is allowed. */
function checkRateLimit(): { allowed: boolean; reason?: string } {
  if (!policy?.rateLimit) {
    return { allowed: true };
  }

  const now = Date.now();
  const windowMs = policy.rateLimit.window * 1000;
  const cutoff = now - windowMs;

  // Remove old timestamps
  while (launchTimes.length > 0 && launchTimes[0]! < cutoff) {
    launchTimes.shift();
  }

  if (launchTimes.length >= policy.rateLimit.max) {
    const oldest = launchTimes[0]!;
    const waitSec = Math.ceil((oldest + windowMs - now) / 1000);
    return {
      allowed: false,
      reason: `rate limit exceeded (${policy.rateLimit.max} per ${policy.rateLimit.window}s). Try again in ${waitSec}s`,
    };
  }

  return { allowed: true };
}

/** Record a launch for rate limiting. */
function recordLaunch(): void {
  launchTimes.push(Date.now());
}

/** Check concurrent launch limit. Returns true if launch is allowed. */
function checkConcurrentLimit(): { allowed: boolean; reason?: string } {
  if (!policy?.maxConcurrent) {
    return { allowed: true };
  }

  // Count active launches
  let active = 0;
  for (const rec of launches.values()) {
    if (rec.proc.exitCode === null) {
      active++;
    }
  }

  if (active >= policy.maxConcurrent) {
    return {
      allowed: false,
      reason: `concurrent limit exceeded (max ${policy.maxConcurrent} boxes)`,
    };
  }

  return { allowed: true };
}

/** Check spawn depth (for nested boxes). Returns true if allowed. */
function checkDepthLimit(requestedDepth: number): { allowed: boolean; reason?: string } {
  const maxDepth = policy?.maxDepth ?? 3;  // Default max depth

  if (requestedDepth > maxDepth) {
    return {
      allowed: false,
      reason: `spawn depth exceeded (max ${maxDepth} levels)`,
    };
  }

  return { allowed: true };
}

/**
 * Check attenuation: child doors must be a subset of parent doors.
 * This is a core OCAP security invariant — a box cannot grant itself
 * capabilities it doesn't have. Returns true if allowed.
 */
function checkAttenuation(
  requestedDoors: string[],
  parentDoors: string[] | undefined,
  depth: number,
): { allowed: boolean; reason?: string; violations?: string[] } {
  // Root launches (depth 0) have no parent — no attenuation check needed
  if (depth === 0 || parentDoors === undefined) {
    return { allowed: true };
  }

  // Child launches must have doors ⊆ parent doors
  const parentSet = new Set(parentDoors);
  const violations = requestedDoors.filter((d) => !parentSet.has(d));

  if (violations.length > 0) {
    return {
      allowed: false,
      reason: `attenuation violation: child requested doors [${violations.join(", ")}] not in parent [${parentDoors.join(", ")}]`,
      violations,
    };
  }

  return { allowed: true };
}

// ── L2 Attestation + Key Management ──────────────────────────────────────────

type SigningKey = {
  privateKey: ReturnType<typeof createPrivateKey>;
  publicKeyPem: string;
  keyId: string; // sha256 of the public key (for identification)
};

let signingKey: SigningKey | null = null;

/** sha256 hex digest of arbitrary data. */
function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Set the module's signing key (for testing). */
function setSigningKey(key: SigningKey | null): void {
  signingKey = key;
}

/** Load or generate an Ed25519 signing key. Sets the module-level signingKey. */
function loadOrCreateKey(keyPath: string): SigningKey {
  const dir = dirname(keyPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  let privateKeyPem: string;
  let publicKeyPem: string;

  if (existsSync(keyPath)) {
    privateKeyPem = readFileSync(keyPath, "utf-8");
    const privateKey = createPrivateKey(privateKeyPem);
    publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }) as string;
  } else {
    // Generate a new Ed25519 key pair
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;

    // Write with restrictive permissions
    writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
    writeFileSync(`${keyPath}.pub`, publicKeyPem, { mode: 0o644 });
    log("INFO", `generated new signing key at ${keyPath}`);
  }

  const privateKey = createPrivateKey(privateKeyPem);
  const keyId = sha256(publicKeyPem);
  const key = { privateKey, publicKeyPem, keyId };

  // Set the module-level key for signing
  signingKey = key;

  return key;
}

/** Sign data with the daemon's Ed25519 key. Returns base64 signature. */
function signData(data: string): string {
  if (!signingKey) {
    throw new Error("signing key not loaded");
  }
  const sig = sign(null, Buffer.from(data), signingKey.privateKey);
  return sig.toString("base64");
}

type L2Attestation = {
  statement: SLSAStatement;  // SLSA Provenance v1 format
  statementDigest: string;
  signature: string;
  keyId: string;
};

/** Build and sign an L2 launch attestation (SLSA Provenance v1 format). */
function buildL2Attestation(
  launchId: string,
  imageDigest: string,
  manifest: Manifest,
  manifestJson: string,
): L2Attestation {
  const manifestDigest = sha256(manifestJson);
  const now = new Date().toISOString();

  // Build the L2 statement per contract/CHAIN.md (OCAP format first)
  const ocapStmt = statement(
    // Subject: the launch (identified by launchId, tied to image)
    [{ name: launchId, digest: { sha256: sha256(launchId) } }],
    {
      level: "launch",
      producer: {
        kind: "keeperd", // launcherd uses keeperd's role in the chain
        id: `launcherd:${signingKey?.keyId ?? "unknown"}`,
      },
      image: {
        name: IMAGE,
        digest: { sha256: imageDigest.replace(/^sha256:/, "") },
      },
      capabilities: {
        workcell: "claude-box",
        manifestDigest: { sha256: manifestDigest },
        doors: manifest.doors.map((d) => ({
          name: d.name,
          socket: transportString(d.guest),
          env: d.env,
          grants: d.grants,
        })),
        denied: manifest.denied.map((d) => ({ name: d.name })),
      },
      links: [
        // Link back to L1 image
        { level: "image", digest: { sha256: imageDigest.replace(/^sha256:/, "") } },
      ],
      metadata: {
        invocationId: launchId,
        startedOn: now,
      },
    },
  );

  // Convert to SLSA Provenance v1 format
  const stmt = toSLSA(ocapStmt);

  // Canonicalize and sign
  const stmtJson = JSON.stringify(stmt);
  const stmtDigest = sha256(stmtJson);
  const signature = signData(stmtJson);

  return {
    statement: stmt,
    statementDigest: stmtDigest,
    signature,
    keyId: signingKey?.keyId ?? "unknown",
  };
}

/** Get the current image digest (from podman). Returns sha256:hex or null. */
async function getImageDigest(): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      ["podman", "image", "inspect", IMAGE, "--format", "{{.Digest}}"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out || null;
  } catch {
    return null;
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

type LaunchRecord = {
  launchId: string;
  account: string;
  pid: number;
  startedAt: Date;
  doors: string[];
  repo?: string;
  depth: number;
  caller?: CallerInfo;  // SO_PEERCRED info from peercred proxy
  manifest: Manifest;
  attestation?: L2Attestation;
  proc: ReturnType<typeof Bun.spawn>;
};

// ── Rooms ────────────────────────────────────────────────────────────────────

type Room = {
  doors: string[];
  netOpen?: boolean;
  description: string;
};

const ROOMS: Record<string, Room> = {
  dev: {
    doors: ["keeper", "net", "scout"],
    description: "full dev: signed commits, policed egress, external reads",
  },
  "dev-spawn": {
    doors: ["keeper", "net", "scout", "launcher"],
    description: "full dev + spawn: can launch sub-boxes via launcherd",
  },
  readonly: {
    doors: ["net", "scout"],
    description: "read-only research: egress + reads, no writes",
  },
  offline: {
    doors: [],
    description: "air-gapped: no network, no external access",
  },
  bootstrap: {
    doors: [],
    netOpen: true,
    description: "UNSAFE bootstrap: full ambient egress, no doors (for bringup)",
  },
};

// ── Daemon state ─────────────────────────────────────────────────────────────

const launches = new Map<string, LaunchRecord>();
const startedAt = new Date();

function generateLaunchId(): string {
  return `box-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Door checking ────────────────────────────────────────────────────────────

async function checkDoorReachable(socketPath: string): Promise<boolean> {
  try {
    const sock = await Bun.connect({
      unix: socketPath,
      socket: {
        data() {},
        open(sock) { sock.end(); },
        error() {},
        close() {},
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function checkDoors(doors: DoorGrant[]): Promise<{ name: string; reachable: boolean }[]> {
  return Promise.all(
    doors.map(async (d) => ({
      name: d.name,
      reachable: await checkDoorReachable(unixPath(d.host)),
    }))
  );
}

// ── Method handlers ──────────────────────────────────────────────────────────

type MethodHandler = (params: Record<string, unknown>) => Promise<unknown>;

async function handleStatus(_params: Record<string, unknown>): Promise<unknown> {
  const known = knownDoors();
  const doorStatus: Record<string, { socket: string; reachable: boolean }> = {};

  for (const [name, preset] of Object.entries(known)) {
    doorStatus[name] = {
      socket: preset.hostDefault,
      reachable: await checkDoorReachable(preset.hostDefault),
    };
  }

  // Count active launches
  let activeLaunches = 0;
  for (const rec of launches.values()) {
    if (rec.proc.exitCode === null) activeLaunches++;
  }

  return {
    version: VERSION,
    uptime: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    launches: activeLaunches,
    signing: signingKey
      ? { enabled: true, keyId: signingKey.keyId }
      : { enabled: false },
    policy: policy
      ? {
          enabled: true,
          defaultAllow: policy.defaultAllow ?? [],
          rulesCount: policy.rules.length,
          maxConcurrent: policy.maxConcurrent ?? null,
          maxDepth: policy.maxDepth ?? 3,
          rateLimit: policy.rateLimit ?? null,
        }
      : { enabled: false },
    doors: doorStatus,
    rooms: Object.fromEntries(
      Object.entries(ROOMS).map(([name, room]) => [name, room.description])
    ),
  };
}

async function handleList(params: Record<string, unknown>): Promise<unknown> {
  const accountFilter = params.account as string | undefined;

  // Clean up exited processes
  for (const [id, rec] of launches) {
    if (rec.proc.exitCode !== null) {
      launches.delete(id);
    }
  }

  const result = [...launches.values()]
    .filter((rec) => !accountFilter || rec.account === accountFilter)
    .map((rec) => ({
      launchId: rec.launchId,
      account: rec.account,
      pid: rec.pid,
      startedAt: rec.startedAt.toISOString(),
      doors: rec.doors,
      repo: rec.repo,
      depth: rec.depth,
      caller: rec.caller,  // SO_PEERCRED info (uid/gid/pid of spawner)
      status: rec.proc.exitCode === null ? "running" : "exited",
    }));

  return { launches: result };
}

async function handleKill(params: Record<string, unknown>): Promise<unknown> {
  const launchId = params.launchId as string;
  const signal = (params.signal as string) ?? "SIGTERM";

  if (!launchId) {
    throw { code: "INVALID_PARAMS", message: "launchId required" };
  }

  const rec = launches.get(launchId);
  if (!rec) {
    throw { code: "NOT_FOUND", message: `launch ${launchId} not found` };
  }

  try {
    rec.proc.kill(signal === "SIGKILL" ? 9 : 15);
    launches.delete(launchId);
    return { killed: true };
  } catch (e) {
    throw { code: "KILL_FAILED", message: String(e) };
  }
}

async function handleAttach(params: Record<string, unknown>): Promise<unknown> {
  const launchId = params.launchId as string;

  if (!launchId) {
    throw { code: "INVALID_PARAMS", message: "launchId required" };
  }

  const rec = launches.get(launchId);
  if (!rec) {
    throw { code: "NOT_FOUND", message: `launch ${launchId} not found` };
  }

  if (rec.proc.exitCode !== null) {
    throw { code: "EXITED", message: `launch ${launchId} has exited (code ${rec.proc.exitCode})` };
  }

  // The container name matches the launchId (set in buildPodmanArgv)
  return {
    launchId,
    container: launchId,
    command: `podman attach ${launchId}`,
    hint: "Run the command above in your terminal to attach to the running box",
  };
}

async function handleLaunch(params: Record<string, unknown>): Promise<unknown> {
  const account = (params.account as string) ?? "personal";
  const repo = params.repo as string | undefined;
  const repoRw = (params.repoRw as boolean) ?? false;
  const roomName = params.room as string | undefined;
  const netOpen = (params.netOpen as boolean) ?? false;
  const claudeArgs = (params.claudeArgs as string[]) ?? [];
  const depth = (params.depth as number) ?? 0;  // Spawn depth (0 = root, 1 = first child, etc.)
  let doorSpecs = (params.doors as string[]) ?? [];

  // Extract caller info (injected by peercred proxy via SO_PEERCRED)
  const callerRaw = params._caller as { uid?: number; gid?: number; pid?: number } | undefined;
  const caller: CallerInfo | undefined = callerRaw?.uid !== undefined
    ? { uid: callerRaw.uid, gid: callerRaw.gid ?? 0, pid: callerRaw.pid ?? 0 }
    : undefined;
  const token = params._token as string | undefined;

  // Parent doors (for attenuation check on nested launches)
  // In-box callers pass their manifest's doors so we can enforce child ⊆ parent
  const parentDoors = params._parentDoors as string[] | undefined;

  // Validate account
  if (!/^[A-Za-z0-9._-]+$/.test(account)) {
    throw { code: "INVALID_ACCOUNT", message: `invalid account name: ${account}` };
  }

  // Check rate limit
  const rateCheck = checkRateLimit();
  if (!rateCheck.allowed) {
    throw { code: "RATE_LIMITED", message: rateCheck.reason };
  }

  // Check concurrent limit
  const concurrentCheck = checkConcurrentLimit();
  if (!concurrentCheck.allowed) {
    throw { code: "CONCURRENT_LIMIT", message: concurrentCheck.reason };
  }

  // Check depth limit
  const depthCheck = checkDepthLimit(depth);
  if (!depthCheck.allowed) {
    throw { code: "DEPTH_LIMIT", message: depthCheck.reason };
  }

  // Expand room to doors
  if (roomName) {
    const room = ROOMS[roomName];
    if (!room) {
      throw { code: "UNKNOWN_ROOM", message: `unknown room: ${roomName}. Available: ${Object.keys(ROOMS).join(", ")}` };
    }
    // Check policy (using caller UID from peercred or token)
    if (!isRoomAllowed(roomName, caller, token)) {
      throw { code: "POLICY_DENIED", message: `room '${roomName}' not permitted by policy` };
    }
    doorSpecs = [...room.doors, ...doorSpecs];
    if (room.netOpen && !netOpen) {
      // Room implies netOpen
      (params as Record<string, unknown>).netOpen = true;
    }
  }

  // Check attenuation: child doors must be subset of parent doors
  // This is checked AFTER room expansion so the full door set is validated
  const attenuationCheck = checkAttenuation(doorSpecs, parentDoors, depth);
  if (!attenuationCheck.allowed) {
    throw {
      code: "ATTENUATION_VIOLATION",
      message: attenuationCheck.reason,
      violations: attenuationCheck.violations,
    };
  }

  // Resolve doors
  const doors: DoorGrant[] = [];
  for (const spec of doorSpecs) {
    const eq = spec.indexOf("=");
    const name = eq < 0 ? spec : spec.slice(0, eq);
    const host = eq < 0 ? undefined : spec.slice(eq + 1);
    doors.push(resolveDoor(name, host));
  }

  // Check door prerequisites
  const doorChecks = await checkDoors(doors);
  const unreachable = doorChecks.filter((d) => !d.reachable);
  if (unreachable.length > 0) {
    throw {
      code: "DOORS_UNREACHABLE",
      message: `doors not reachable: ${unreachable.map((d) => d.name).join(", ")}. Start the daemons first.`,
    };
  }

  // Build the launch (reuse planLaunch logic structure)
  const launch: Launch = { repo, repoRw, doors, netOpen: (params.netOpen as boolean) ?? netOpen, claudeArgs };
  const manifest = buildManifest(account, launch);
  const manifestJson = capabilityJson(manifest);
  const launchId = generateLaunchId();

  // Build L2 attestation if signing is enabled
  let attestation: L2Attestation | undefined;
  if (signingKey) {
    const imageDigest = await getImageDigest();
    if (imageDigest) {
      attestation = buildL2Attestation(launchId, imageDigest, manifest, manifestJson);
    }
  }

  // Build podman argv
  const argv = await buildPodmanArgv(account, launch, manifest, launchId);

  // Spawn
  const proc = Bun.spawn(argv, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const record: LaunchRecord = {
    launchId,
    account,
    pid: proc.pid,
    startedAt: new Date(),
    doors: doors.map((d) => d.name),
    repo,
    depth,
    caller,
    manifest,
    attestation,
    proc,
  };
  launches.set(launchId, record);

  // Record for rate limiting
  recordLaunch();

  // Clean up when process exits
  proc.exited.then(() => {
    // Could emit an event or log here
  });

  return {
    launchId,
    pid: proc.pid,
    manifest: {
      account: manifest.account,
      repo: manifest.repo,
      doors: manifest.doors.map((d) => d.name),
      denied: manifest.denied.map((d) => d.name),
      netOpen: manifest.netOpen,
    },
    attestation: attestation
      ? {
          statementDigest: attestation.statementDigest,
          signature: attestation.signature,
          keyId: attestation.keyId,
        }
      : undefined,
  };
}

async function buildPodmanArgv(account: string, launch: Launch, manifest: Manifest, launchId: string): Promise<string[]> {
  const { repo, repoRw, doors, netOpen, claudeArgs } = launch;

  const argv = [
    "podman", "run", "-it", "--rm",
    "--name", launchId,  // Name the container for attach support
    "--security-opt", "no-new-privileges",
    "--cap-drop", "all",
    "--pids-limit", "2048",
    "-v", `claude-${account}-config:/home/claude/.config/claude:U`,
  ];

  // Network handling
  const netDoor = doors.find((d) => d.name === "net");
  if (netOpen) {
    // Ambient egress — no --network=none
  } else {
    argv.push("--network=none");
    if (netDoor) {
      argv.push(
        "--env", `HTTPS_PROXY=${NETD_PROXY}`,
        "--env", `HTTP_PROXY=${NETD_PROXY}`,
        "--env", `ALL_PROXY=${NETD_PROXY}`,
        "--env", "NO_PROXY=localhost,127.0.0.1",
      );
    }
  }

  // Mount doors
  for (const d of doors) {
    const hostPath = unixPath(d.host);
    const guestPath = unixPath(d.guest);
    argv.push("-v", `${hostPath}:${guestPath}`, "--env", `${d.env}=${guestPath}`);
  }

  // Capability manifest
  argv.push("--env", `CLAUDE_BOX_CAPABILITIES=${capabilityJson(manifest)}`);

  // Repo handling
  if (repo) {
    const abs = await Bun.resolve(repo, process.cwd());
    argv.push("-v", `${abs}:/work`, "-w", "/work", "--userns=keep-id:uid=1000,gid=1000");

    const common = await gitCommonDir(abs);
    const external = common && !common.startsWith(`${abs}/`);

    if (repoRw) {
      if (external) argv.push("-v", `${common}:${common}`);
    } else {
      if (external) {
        argv.push("-v", `${common}:${common}:ro`);
      } else {
        argv.push("-v", `${abs}/.git:/work/.git:ro`);
      }
    }
  }

  // Image + claude args
  argv.push(IMAGE, "--append-system-prompt", capabilityPrompt(manifest), ...claudeArgs);

  return argv;
}

async function gitCommonDir(repo: string): Promise<string | undefined> {
  const proc = Bun.spawn(
    ["git", "-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out || undefined;
}

async function handleRooms(_params: Record<string, unknown>): Promise<unknown> {
  return {
    rooms: Object.fromEntries(
      Object.entries(ROOMS).map(([name, room]) => [
        name,
        { doors: room.doors, netOpen: room.netOpen ?? false, description: room.description },
      ])
    ),
  };
}

const METHODS: Record<string, MethodHandler> = {
  status: handleStatus,
  list: handleList,
  kill: handleKill,
  attach: handleAttach,
  launch: handleLaunch,
  rooms: handleRooms,
};

// ── Socket server ────────────────────────────────────────────────────────────

async function handleRequest(line: string): Promise<ResponseEnvelope> {
  let req: RequestEnvelope;
  try {
    req = JSON.parse(line);
  } catch {
    return err("", "PARSE_ERROR", "invalid JSON");
  }

  const { id, method, params } = req;
  if (!id || !method) {
    return err(id ?? "", "INVALID_REQUEST", "id and method required");
  }

  const handler = METHODS[method];
  if (!handler) {
    return err(id, "UNKNOWN_METHOD", `unknown method: ${method}`);
  }

  try {
    const result = await handler(params ?? {});
    return ok(id, result);
  } catch (e) {
    const error = e as { code?: string; message?: string };
    return err(id, error.code ?? "INTERNAL_ERROR", error.message ?? String(e));
  }
}

function assertSocketDir(sock: string): void {
  const dir = dirname(sock);
  let mode: number;
  try {
    mode = statSync(dir).mode;
  } catch {
    log("ERR", `socket dir ${dir} does not exist`);
    process.exit(2);
  }
  if (mode & 0o002) {
    log("ERR", `refusing socket in world-writable ${dir} (hijack risk)`);
    process.exit(2);
  }
}

async function serve(socketPath: string): Promise<void> {
  assertSocketDir(socketPath);
  prepareSocket(socketPath);
  log("INFO", `listening on ${socketPath}`);

  const server = Bun.listen<{ buffer: string }>({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.data = { buffer: "" };
      },
      async data(socket, data) {
        socket.data.buffer += data.toString();
        const lines = socket.data.buffer.split("\n");
        socket.data.buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const response = await handleRequest(line);
          socket.write(JSON.stringify(response) + "\n");
        }
      },
      close(_socket) {},
      error(_socket, e) {
        log("ERR", `socket error: ${e}`);
      },
    },
  });

  // Handle shutdown
  process.on("SIGINT", () => {
    log("INFO", "shutting down...");
    server.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    server.stop();
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const HELP = `launcherd — launch-controller daemon for claude-box

Usage:
  launcherd serve                     start daemon (foreground)
  launcherd serve --socket PATH       custom socket path
  launcherd serve --key PATH          signing key path (Ed25519, auto-generated if absent)
  launcherd serve --policy PATH       policy file path (JSON, optional)
  launcherd serve --no-sign           disable L2 attestation signing

Options:
  --socket PATH    socket path (default: $XDG_RUNTIME_DIR/launcherd.sock)
  --key PATH       signing key (default: ~/.claude-box/launcherd.key)
  --policy PATH    policy file (default: ~/.claude-box/policy.json)
  --no-sign        skip key loading, disable attestation
  -h, --help       show this help

Policy file format (JSON):
  {
    "defaultAllow": ["dev", "readonly"],  // rooms allowed by default
    "rules": [
      { "uid": 1000, "allow": ["dev", "dev-spawn"] },
      { "socket": "/run/launcherd.sock", "allow": ["readonly"] }
    ]
  }`;

async function main(): Promise<number> {
  const args = Bun.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);
    return 0;
  }

  const cmd = args[0];
  if (cmd !== "serve") {
    log("ERR", "usage: launcherd serve [--socket PATH] [--key PATH] [--policy PATH] [--no-sign]");
    return 1;
  }

  let socketPath = defaultSocketPath();
  const sockIdx = args.indexOf("--socket");
  if (sockIdx >= 0 && args[sockIdx + 1]) {
    socketPath = args[sockIdx + 1]!;
  }

  // Key loading
  const noSign = args.includes("--no-sign");
  if (!noSign) {
    let keyPath = defaultKeyPath();
    const keyIdx = args.indexOf("--key");
    if (keyIdx >= 0 && args[keyIdx + 1]) {
      keyPath = args[keyIdx + 1]!;
    }
    try {
      signingKey = loadOrCreateKey(keyPath);
      log("INFO", `signing enabled (keyId: ${signingKey.keyId.slice(0, 16)}...)`);
    } catch (e) {
      log("ERR", `failed to load signing key: ${e}`);
      log("WARN", "continuing without signing (use --no-sign to suppress)");
    }
  } else {
    log("INFO", "signing disabled (--no-sign)");
  }

  // Policy loading
  let policyPath = defaultPolicyPath();
  const policyIdx = args.indexOf("--policy");
  if (policyIdx >= 0 && args[policyIdx + 1]) {
    policyPath = args[policyIdx + 1]!;
  }
  policy = loadPolicy(policyPath);
  if (policy) {
    log("INFO", `policy enabled (${policy.rules.length} rules, default: [${policy.defaultAllow?.join(", ") ?? "none"}])`);
  } else {
    log("INFO", "no policy file (all rooms permitted)");
  }

  await serve(socketPath);
  return 0;
}

// For testing: set the active policy directly
function setPolicy(p: Policy | null): void {
  policy = p;
}

// Exports for testing
export {
  ROOMS,
  handleRequest,
  checkDoorReachable,
  generateLaunchId,
  sha256,
  loadOrCreateKey,
  setSigningKey,
  buildL2Attestation,
  loadPolicy,
  setPolicy,
  isRoomAllowed,
  checkRateLimit,
  checkConcurrentLimit,
  checkDepthLimit,
  checkAttenuation,
  recordLaunch,
};
export type { RequestEnvelope, ResponseEnvelope, LaunchRecord, Room, L2Attestation, SigningKey, Policy, PolicyRule, CallerInfo };

if (import.meta.main) {
  process.exit(await main());
}
