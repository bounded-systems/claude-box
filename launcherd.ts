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
  mintAuthGrant,
  authLeaseCmd,
  buildRemoteServeScript,
  RC_WORKSPACE,
  BOX_CONFIG_DIR,
  type DoorGrant,
  type Manifest,
  type Launch,
} from "./claude-box";
import {
  type Interposer,
  frontDoorsWithInterposers,
  teardownInterposers,
} from "./door-interpose.ts";
import {
  CLAUDE_BOX_DEFAULT_FLAGS,
  renderRemoteControlArgs,
} from "./lib/remote-control-flags.ts";
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

function defaultDispatchSocketPath(): string {
  return runtimeSocketPath("dispatch");
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
  // dispatch has its OWN limits, independent of the ones above — see
  // checkDispatchRateLimit/checkDispatchConcurrentLimit. Unlike `launch`'s
  // limits (no-op until an operator opts in with a policy file), dispatch's
  // limits are non-permissive BY DEFAULT (see DEFAULT_* below): the caller
  // is, by design, an always-on box with no other authority, so "no policy
  // file = unlimited spawns" is not an acceptable default here.
  maxConcurrentDispatched?: number;
  dispatchRateLimit?: {
    window: number;
    max: number;
  };
  rules: PolicyRule[];
};

let policy: Policy | null = null;

// Rate limiting state
const launchTimes: number[] = [];  // Timestamps of recent launches

// Dispatch has no LaunchRecord bookkeeping (see handleDispatch's doc comment
// — deliberately no ongoing relationship to what gets dispatched), so its
// concurrency count is a plain incr/decr counter rather than something
// derived from the `launches` map the way checkConcurrentLimit works.
const dispatchTimes: number[] = [];
let activeDispatchCount = 0;
const DEFAULT_MAX_CONCURRENT_DISPATCHED = 5;
const DEFAULT_DISPATCH_RATE_LIMIT = { window: 3600, max: 20 };

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

/** Rate-limit dispatch requests. UNLIKE checkRateLimit (opt-in via
 *  policy.rateLimit, unlimited by default), this is non-permissive out of
 *  the box: DEFAULT_DISPATCH_RATE_LIMIT applies whether or not a policy file
 *  exists, overridable via policy.dispatchRateLimit. */
function checkDispatchRateLimit(): { allowed: boolean; reason?: string } {
  const limit = policy?.dispatchRateLimit ?? DEFAULT_DISPATCH_RATE_LIMIT;
  const now = Date.now();
  const windowMs = limit.window * 1000;
  const cutoff = now - windowMs;

  while (dispatchTimes.length > 0 && dispatchTimes[0]! < cutoff) {
    dispatchTimes.shift();
  }

  if (dispatchTimes.length >= limit.max) {
    const oldest = dispatchTimes[0]!;
    const waitSec = Math.ceil((oldest + windowMs - now) / 1000);
    return {
      allowed: false,
      reason: `dispatch rate limit exceeded (${limit.max} per ${limit.window}s). Try again in ${waitSec}s`,
    };
  }

  return { allowed: true };
}

function recordDispatch(): void {
  dispatchTimes.push(Date.now());
}

/** Concurrency ceiling for dispatch. UNLIKE checkConcurrentLimit (opt-in via
 *  policy.maxConcurrent, unlimited by default), this is non-permissive out
 *  of the box: DEFAULT_MAX_CONCURRENT_DISPATCHED applies whether or not a
 *  policy file exists, overridable via policy.maxConcurrentDispatched. */
function checkDispatchConcurrentLimit(): { allowed: boolean; reason?: string } {
  const max = policy?.maxConcurrentDispatched ?? DEFAULT_MAX_CONCURRENT_DISPATCHED;
  if (activeDispatchCount >= max) {
    return {
      allowed: false,
      reason: `dispatch concurrent limit exceeded (max ${max} boxes)`,
    };
  }
  return { allowed: true };
}

// For testing: reset dispatch rate/concurrency state between test cases.
function __resetDispatchLimits(): void {
  dispatchTimes.length = 0;
  activeDispatchCount = 0;
}

// For testing: simulate N in-flight dispatched boxes without actually
// spawning any (handleDispatch only increments this after a real podman
// spawn succeeds, which unit tests can't drive without podman).
function __seedActiveDispatchCount(n: number): void {
  activeDispatchCount = n;
}

// child ⊆ parent is now enforced at the REFERENCE level by resolveLaunchDoors
// (a child can only be handed door references its parent's LaunchRecord holds),
// so the old name-based checkAttenuation guard was retired (prx-e232).

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
    // Derive the public key from the private-key PEM directly (a KeyObject trips
    // the bun-types createPublicKey overload; the PEM path is equivalent).
    publicKeyPem = createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }) as string;
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

/** The podman container Id for a just-launched box (named `launchId`). Recorded
 *  so a later spawn's caller can be correlated back to its launch by cgroup (the
 *  peercred pid is the container's process, not the `podman run` cli — verified
 *  prx-p4vb). Best-effort with a short retry (the container registers just after
 *  `podman run` starts); null if it never resolves → caller-matching falls back
 *  to pid-equality. */
async function getContainerId(launchId: string): Promise<string | undefined> {
  for (let i = 0; i < 15; i++) {
    try {
      const proc = Bun.spawn(
        ["podman", "inspect", launchId, "--format", "{{.Id}}"],
        { stdout: "pipe", stderr: "ignore" },
      );
      const out = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      if (/^[0-9a-f]{64}$/.test(out)) return out;
    } catch {
      // not registered yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

// ── Types ────────────────────────────────────────────────────────────────────

type LaunchRecord = {
  launchId: string;
  pid: number;          // the `podman run` cli pid (attach/kill); NOT the peercred caller pid
  containerId?: string; // podman container Id — correlates a spawn caller's cgroup back here
  startedAt: Date;
  doors: DoorGrant[];  // the ACTUAL granted references (host socket + caveats), not names
  repo?: string;
  depth: number;
  caller?: CallerInfo;  // SO_PEERCRED info from peercred proxy
  manifest: Manifest;
  attestation?: L2Attestation;
  proc: ReturnType<typeof Bun.spawn>;
  interposers?: Interposer[]; // caveat-enforcing proxies fronting this box's caveated doors (prx-yweb)
};

// ── Rooms ────────────────────────────────────────────────────────────────────

type Room = {
  doors: string[];
  netOpen?: boolean;
  description: string;
  /** May this room be requested over the doors-blind `dispatch` socket
   *  (see handleDispatch)? Deliberately opt-in and separate from ordinary
   *  attenuated `launch` access — a room is only safe to expose there if it
   *  can never itself hold "launcher" (no re-dispatch) and never opens
   *  ambient egress (no `netOpen`). */
  dispatchable?: boolean;
};

const ROOMS: Record<string, Room> = {
  dev: {
    doors: ["keeper", "net", "scout"],
    description: "full dev: signed commits, policed egress, external reads",
    dispatchable: true,
  },
  "dev-spawn": {
    doors: ["keeper", "net", "scout", "launcher"],
    description: "full dev + spawn: can launch sub-boxes via launcherd",
  },
  readonly: {
    doors: ["net", "scout"],
    description: "read-only research: egress + reads, no writes",
    dispatchable: true,
  },
  offline: {
    doors: [],
    description: "air-gapped: no network, no external access",
    dispatchable: true,
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

/** Extract a podman container Id from /proc/<pid>/cgroup text. Podman containers
 *  live under `…/libpod-<64-hex-id>.scope/…` (verified prx-p4vb); return that id
 *  (the full container Id, == `podman inspect .Id`) or undefined. Pure. */
function containerIdFromCgroup(cgroupText: string): string | undefined {
  const m = cgroupText.match(/libpod-([0-9a-f]{64})\.scope/);
  return m ? m[1] : undefined;
}

/** The launch whose recorded container Id matches (the caller's container). */
function findLaunchByContainerId(containerId: string): LaunchRecord | undefined {
  for (const rec of launches.values()) {
    if (rec.containerId === containerId) return rec;
  }
  return undefined;
}

/** Find the LaunchRecord for the box a spawn request came from — what makes a
 *  child's ceiling object-anchored (launcherd trusts its OWN record, not the
 *  box's self-report).
 *
 *  The peercred caller `pid` is the CONTAINER's process (PID-1 or a descendant),
 *  NOT the `podman run` cli pid launcherd's `proc.pid` holds (verified prx-p4vb).
 *  So correlate via the caller's cgroup — every process in the box shares the
 *  container's `libpod-<id>.scope` — matching the container Id recorded at launch.
 *  Fall back to pid-equality (a non-containerised caller, or a box launched before
 *  its container id resolved); failing both, undefined → root launch / the
 *  client-trusted fallback (no worse than before). */
function findCallerRecord(pid: number): LaunchRecord | undefined {
  try {
    const cid = containerIdFromCgroup(readFileSync(`/proc/${pid}/cgroup`, "utf-8"));
    if (cid) {
      const rec = findLaunchByContainerId(cid);
      if (rec) return rec;
    }
  } catch {
    // /proc unreadable (non-Linux, or the pid is gone) — fall through to pid match
  }
  for (const rec of launches.values()) {
    if (rec.pid === pid) return rec;
  }
  return undefined;
}

/** Test seam: insert a LaunchRecord so a spawn's caller-record lookup can be
 *  exercised without launching a real box. */
function __seedLaunch(rec: LaunchRecord): void {
  launches.set(rec.launchId, rec);
}

// Test seam for the caller cgroup read (real /proc isn't available for fake pids).
let __testCallerCid: { set: boolean; value: string | undefined } = { set: false, value: undefined };
function __setCallerContainerId(value: string | undefined): void { __testCallerCid = { set: true, value }; }
function __clearCallerContainerId(): void { __testCallerCid = { set: false, value: undefined }; }

/** The podman container Id of the spawn caller (the box it ran in), from the
 *  caller's cgroup — undefined if the caller is NOT containerised (the host
 *  operator at the root mint) or its cgroup can't be read. This is the kernel's
 *  truth about which box connected; the caller cannot spoof its own cgroup. */
function callerContainerId(pid: number | undefined): string | undefined {
  if (__testCallerCid.set) return __testCallerCid.value;
  if (!pid) return undefined;
  try {
    return containerIdFromCgroup(readFileSync(`/proc/${pid}/cgroup`, "utf-8"));
  } catch {
    return undefined;
  }
}

/** Resolve requested door specs to concrete grants for a launch.
 *
 *  ROOT launch (no caller record — the host operator at the mint): resolve each
 *  name globally via the door catalog; an explicit `name=host` may override the
 *  socket. This is where ambient authority legitimately originates.
 *
 *  CHILD spawn (caller record present): bind each requested door to the PARENT's
 *  ACTUAL held reference (its host socket + caveats), looked up by name in the
 *  caller's LaunchRecord — NOT re-resolved globally. A box can only delegate a
 *  reference it holds, at the parent's socket; a door the parent lacks is refused,
 *  and a `name=host` override is ignored (a child cannot re-point a door at a new
 *  socket). This makes "can't delegate what you don't hold" true at the reference
 *  level, not just the name level (prx-8k08). */
function resolveLaunchDoors(doorSpecs: string[], callerRecord: LaunchRecord | undefined): DoorGrant[] {
  if (!callerRecord) {
    return doorSpecs.map((spec) => {
      const eq = spec.indexOf("=");
      const name = eq < 0 ? spec : spec.slice(0, eq);
      const host = eq < 0 ? undefined : spec.slice(eq + 1);
      return resolveDoor(name, host);
    });
  }
  const held = new Map(callerRecord.doors.map((d) => [d.name, d] as const));
  return doorSpecs.map((spec) => {
    const name = spec.indexOf("=") < 0 ? spec : spec.slice(0, spec.indexOf("="));
    const grant = held.get(name);
    if (!grant) {
      throw {
        code: "ATTENUATION_VIOLATION",
        message: `door "${name}" not held by caller — a box can only delegate references it holds`,
      };
    }
    return grant; // the parent's actual reference (host + caveats), passed through
  });
}

/** Sanitize a caller-supplied label to podman's container-name charset
 *  (lowercase alphanumeric plus `_.-`), trimmed of leading/trailing
 *  punctuation and capped at 40 chars. Returns undefined for an empty/
 *  all-punctuation input. Used both for the podman container name
 *  (generateLaunchId) and, unchanged, as the human-facing RC session title
 *  (handleDispatch) — one cleaned value, not two independent ones that could
 *  drift apart. */
function sanitizeLabel(label: string | undefined): string | undefined {
  const clean = label
    ?.toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 40);
  return clean || undefined;
}

/** `label`, if given (already sanitized — see sanitizeLabel), is spliced in
 *  as a human-readable prefix — the random suffix is ALWAYS appended
 *  regardless, so two concurrent requests for the same label never collide
 *  on podman's own name-uniqueness constraint. No label falls back to the
 *  plain `box-<rand>` shape, unchanged from before labels existed. */
function generateLaunchId(label?: string): string {
  const rand = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return label ? `box-${label}-${rand}` : `box-${rand}`;
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

async function handleList(): Promise<unknown> {
  // Clean up exited processes
  for (const [id, rec] of launches) {
    if (rec.proc.exitCode !== null) {
      launches.delete(id);
    }
  }

  const result = [...launches.values()]
    .map((rec) => ({
      launchId: rec.launchId,
      pid: rec.pid,
      startedAt: rec.startedAt.toISOString(),
      doors: rec.doors.map((d) => d.name),
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
  const repo = params.repo as string | undefined;
  const repoRw = (params.repoRw as boolean) ?? false;
  const roomName = params.room as string | undefined;
  const netOpen = (params.netOpen as boolean) ?? false;
  const guestArgs = (params.guestArgs as string[]) ?? [];
  let doorSpecs = (params.doors as string[]) ?? [];

  // Extract caller info (injected by peercred proxy via SO_PEERCRED)
  const callerRaw = params._caller as { uid?: number; gid?: number; pid?: number } | undefined;
  const caller: CallerInfo | undefined = callerRaw?.uid !== undefined
    ? { uid: callerRaw.uid, gid: callerRaw.gid ?? 0, pid: callerRaw.pid ?? 0 }
    : undefined;
  const token = params._token as string | undefined;

  // Object-anchored authority (prx-8k08/prx-p4vb + prx-e232). Classify the caller
  // by its CGROUP (kernel truth, unspoofable), not client claims:
  //  - CONTAINER caller (cgroup is a podman libpod scope) → MUST resolve to a
  //    launch launcherd made; its child's ceiling/depth/references come from that
  //    record. A container we didn't launch is REFUSED (fail closed) — not trusted.
  //  - NON-container caller (the host operator on the direct socket) → the ROOT
  //    MINT: depth 0, doors resolved globally, no attenuation.
  // There is no client-trusted fallback: _parentDoors and the client depth are
  // gone. Reference-passing (resolveLaunchDoors) + the record are the only
  // authority; over-granting is unsayable, not rejected by a name check.
  const callerCid = callerContainerId(caller?.pid);
  let callerRecord: LaunchRecord | undefined;
  if (callerCid) {
    callerRecord = findLaunchByContainerId(callerCid);
    if (!callerRecord) {
      throw { code: "UNKNOWN_CALLER", message: "spawn caller is a container launcherd did not launch" };
    }
  }
  const depth = callerRecord ? callerRecord.depth + 1 : 0;
  if (callerRecord) {
    log("INFO", `caller pid ${caller?.pid} → launch ${callerRecord.launchId} (depth ${callerRecord.depth}, doors [${callerRecord.doors.map((d) => d.name).join(",")}]); child depth ${depth}, references delegated from the parent`);
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

  // Resolve doors to concrete grants. A child spawn (callerRecord present) gets
  // the PARENT's actual references — not a global name re-resolution — and a door
  // the parent doesn't hold is refused here. So "child ⊆ parent" is enforced by
  // construction at the REFERENCE level; the old name-based attenuation check is
  // retired (prx-e232). A root launch resolves globally (the mint).
  const doors = resolveLaunchDoors(doorSpecs, callerRecord);

  // Check door prerequisites
  const doorChecks = await checkDoors(doors);
  const unreachable = doorChecks.filter((d) => !d.reachable);
  if (unreachable.length > 0) {
    throw {
      code: "DOORS_UNREACHABLE",
      message: `doors not reachable: ${unreachable.map((d) => d.name).join(", ")}. Start the daemons first.`,
    };
  }

  const launchId = generateLaunchId();

  // prx-yweb / trust 6.3: front each CAVEATED door with an interposer that holds
  // the upstream socket and enforces the caveats on traffic; the box mounts only
  // the proxy, so a request outside the caveat never reaches the upstream. An
  // uncaveated (or tcp) door passes through unchanged — no behavior change.
  // launcherd keeps the ORIGINAL references in the record for delegation; the
  // interposers are torn down when the box exits.
  const { doors: mountDoors, interposers } = frontDoorsWithInterposers(doors, launchId);

  // Build the launch (reuse planLaunch logic structure)
  const launch: Launch = {
    guest: (params.guest as string) ?? "claude",
    repo,
    repoRw,
    repoEphemeral: false,
    repoClone: false,
    repoDoorRef: "main",
    pod: false,
    writable: [],
    doors: mountDoors,
    netOpen: (params.netOpen as boolean) ?? netOpen,
    remoteControl: false,
    remoteServe: false,
    guestArgs,
  };
  const manifest = buildManifest(launch, process.env, depth);
  const manifestJson = capabilityJson(manifest);

  // From here on the interposers are live; tear them down if launch assembly or
  // spawn fails, so a failed launch never leaks proxy sockets.
  let attestation: L2Attestation | undefined;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    // Build L2 attestation if signing is enabled
    if (signingKey) {
      const imageDigest = await getImageDigest();
      if (imageDigest) {
        attestation = buildL2Attestation(launchId, imageDigest, manifest, manifestJson);
      }
    }

    // Build podman argv
    const argv = await buildPodmanArgv(launch, manifest, launchId);

    // Spawn
    proc = Bun.spawn(argv, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch (e) {
    teardownInterposers(interposers);
    throw e;
  }

  // Record the container Id so a later spawn's caller (whose peercred pid is the
  // container's process, not this cli pid) can be correlated back to this launch
  // by cgroup — what makes object-anchored spawn actually engage in the pod (prx-p4vb).
  const containerId = await getContainerId(launchId);

  const record: LaunchRecord = {
    launchId,
    pid: proc.pid,
    containerId,
    startedAt: new Date(),
    doors, // the actual granted references — a child spawn delegates these (prx-8k08)
    repo,
    depth,
    caller,
    manifest,
    attestation,
    proc,
    interposers, // torn down on exit (prx-yweb)
  };
  launches.set(launchId, record);

  // Record for rate limiting
  recordLaunch();

  // Clean up when process exits: tear down the box's caveat-enforcing
  // interposers (close servers, unlink sockets) so they don't outlive the box.
  proc.exited.then(() => {
    teardownInterposers(interposers);
  });

  return {
    launchId,
    pid: proc.pid,
    manifest: {
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

/** `rcServe`, when present, boots this box as its own real `claude
 *  remote-control` session instead of an ordinary interactive launch — used
 *  ONLY by handleDispatch. Mirrors claude-box.ts's own --remote-serve
 *  bastion posture exactly: a throwaway tmpfs config dir (never the shared
 *  persistent volume, since the credential is LEASED from authd, not a
 *  persisted refresh token) and an `--entrypoint sh` wrapper running
 *  buildRemoteServeScript before exec'ing claude. Omitted (undefined) for
 *  every ordinary `launch` call — behavior there is unchanged. */
async function buildPodmanArgv(
  launch: Launch,
  manifest: Manifest,
  launchId: string,
  rcServe?: { leaseCmd: string; remoteControlArgs: string[] },
): Promise<string[]> {
  const { repo, repoRw, doors, netOpen, guestArgs } = launch;

  const argv = [
    "podman", "run", "-it", "--rm",
    "--name", launchId,  // Name the container for attach support
    "--security-opt", "no-new-privileges",
    "--cap-drop", "all",
    "--pids-limit", "2048",
  ];
  if (rcServe) {
    argv.push("--tmpfs", `${BOX_CONFIG_DIR}:rw,mode=1777`);
  } else {
    argv.push("-v", `claude-config:${BOX_CONFIG_DIR}:U`);
  }

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

  // Image + guest args
  if (rcServe) {
    // sh -c '<script>' claude-box <remoteControlArgs…> — "$@" inside the
    // script is exactly remoteControlArgs, never string-interpolated. Same
    // shape as claude-box.ts's own --remote-serve invocation.
    argv.push(
      "--entrypoint", "sh", IMAGE, "-c",
      buildRemoteServeScript({ rcWorkspace: RC_WORKSPACE, leaseCmd: rcServe.leaseCmd }),
      "claude-box",
      ...rcServe.remoteControlArgs,
    );
  } else {
    argv.push(IMAGE, "--append-system-prompt", capabilityPrompt(manifest), ...guestArgs);
  }

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

// ── Dispatch — a doors-blind, allow-listed request lane ─────────────────────
//
// Unlike `launch`, `dispatch` never inspects the caller at all: no cgroup
// lookup, no LaunchRecord, no attenuation. The security boundary here is
// "can you reach dispatch.sock," not "what do you hold" — a box wired with
// ONLY the "dispatch" door (claude-box.ts's own preset, mounting nothing
// else) can send {room, label} and nothing more; there is no way to request
// a door, a repo, or an escape flag. If the named room is dispatchable,
// launcherd resolves its doors GLOBALLY (the same root-mint path `launch`
// uses when there's no caller record — see resolveLaunchDoors) and boots an
// entirely independent, separately-attachable `claude remote-control
// --spawn session` box of its own. There is no ongoing relationship
// afterward: no LaunchRecord, no attach/kill/list entry for it — it is "not
// really even a child in the true sense," just another sibling bastion that
// happens to have been requested rather than started by hand.
async function handleDispatch(params: Record<string, unknown>): Promise<unknown> {
  const roomName = params.room as string | undefined;
  const label = sanitizeLabel(params.label as string | undefined);

  if (!roomName) {
    throw { code: "INVALID_REQUEST", message: "dispatch requires a room name" };
  }
  const room = ROOMS[roomName];
  if (!room || !room.dispatchable) {
    const available = Object.entries(ROOMS)
      .filter(([, r]) => r.dispatchable)
      .map(([name]) => name)
      .join(", ");
    throw {
      code: "ROOM_NOT_DISPATCHABLE",
      message: `room '${roomName}' is not dispatchable. Available: ${available}`,
    };
  }

  // These limits are independent of (and, unlike) checkRateLimit/
  // checkConcurrentLimit — see their doc comments: non-permissive by
  // default, not opt-in via a policy file, since dispatch's caller is an
  // always-on box with no other authority.
  const dispatchRateCheck = checkDispatchRateLimit();
  if (!dispatchRateCheck.allowed) {
    throw { code: "RATE_LIMITED", message: dispatchRateCheck.reason };
  }
  const dispatchConcurrentCheck = checkDispatchConcurrentLimit();
  if (!dispatchConcurrentCheck.allowed) {
    throw { code: "CONCURRENT_LIMIT", message: dispatchConcurrentCheck.reason };
  }

  // Every dispatched box runs its own RC server, so it always needs net+auth
  // on top of whatever the room itself grants — mirroring how --remote-serve
  // already implies those two doors for the bastion (claude-box.ts's
  // planLaunch, --remote-serve block).
  const doorSpecs = Array.from(new Set([...room.doors, "net", "auth"]));

  // Root-resolved: dispatch has no caller record to attenuate against, and by
  // construction never will — this handler doesn't classify callers at all.
  const doors = resolveLaunchDoors(doorSpecs, undefined);

  const doorChecks = await checkDoors(doors);
  const unreachable = doorChecks.filter((d) => !d.reachable);
  if (unreachable.length > 0) {
    throw {
      code: "DOORS_UNREACHABLE",
      message: `doors not reachable: ${unreachable.map((d) => d.name).join(", ")}. Start the daemons first.`,
    };
  }

  const launchId = generateLaunchId(label);
  const { doors: mountDoors, interposers } = frontDoorsWithInterposers(doors, launchId);

  const launch: Launch = {
    guest: "claude",
    repo: undefined,
    repoRw: false,
    repoEphemeral: false,
    repoClone: false,
    repoDoorRef: "main",
    pod: false,
    writable: [],
    doors: mountDoors,
    netOpen: room.netOpen ?? false,
    remoteControl: false,
    remoteServe: true,
    guestArgs: [],
  };
  const manifest = buildManifest(launch, process.env, 0);

  // Lease this box's OWN RC credential from authd, exactly like the bastion
  // does for itself (claude-box.ts's run()) — a fresh, independent lease
  // scoped to this box's own launchId as the audience, not the bastion's.
  const authDoor = mountDoors.find((d) => d.name === "auth");
  const grant = authDoor ? mintAuthGrant(authDoor, launchId) : undefined;
  const leaseCmd = authLeaseCmd(grant);
  const remoteControlArgs = [
    "remote-control",
    ...renderRemoteControlArgs({ ...CLAUDE_BOX_DEFAULT_FLAGS, spawn: "session", name: label }),
  ];

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    const argv = await buildPodmanArgv(launch, manifest, launchId, { leaseCmd, remoteControlArgs });
    proc = Bun.spawn(argv, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  } catch (e) {
    teardownInterposers(interposers);
    throw e;
  }
  recordDispatch();
  activeDispatchCount++;
  proc.exited.then(() => {
    activeDispatchCount--;
    teardownInterposers(interposers);
  });

  log("INFO", `dispatched ${launchId} (room ${roomName}${label ? `, label ${label}` : ""})`);

  return { dispatched: true, name: launchId };
}

const METHODS: Record<string, MethodHandler> = {
  status: handleStatus,
  list: handleList,
  kill: handleKill,
  attach: handleAttach,
  launch: handleLaunch,
  rooms: handleRooms,
};

// `dispatch` lives on its OWN socket (see serveDispatchSocket in main()), not
// this table — a box holding only the "dispatch" door mounts a socket that
// speaks nothing but this one method, so it structurally cannot reach
// launch/kill/list/attach/status/rooms even if it wanted to.
const DISPATCH_METHODS: Record<string, MethodHandler> = {
  dispatch: handleDispatch,
};

// ── Socket server ────────────────────────────────────────────────────────────

async function handleRequest(
  line: string,
  methods: Record<string, MethodHandler> = METHODS,
): Promise<ResponseEnvelope> {
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

  const handler = methods[method];
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

function listen(
  socketPath: string,
  methods: Record<string, MethodHandler>,
): UnixSocketListener<{ buffer: string }> {
  assertSocketDir(socketPath);
  prepareSocket(socketPath);
  log("INFO", `listening on ${socketPath} (${Object.keys(methods).join(", ")})`);

  return Bun.listen<{ buffer: string }>({
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
          const response = await handleRequest(line, methods);
          socket.write(JSON.stringify(response) + "\n");
        }
      },
      close(_socket) {},
      error(_socket, e) {
        log("ERR", `socket error: ${e}`);
      },
    },
  });
}

/** Listens on BOTH the general launcherd socket (launch/kill/list/attach/
 *  status/rooms) and a separate, narrower dispatch socket (dispatch only —
 *  see DISPATCH_METHODS) so a box holding just the "dispatch" door mounts a
 *  socket that structurally cannot reach anything else. */
async function serve(socketPath: string, dispatchSocketPath: string): Promise<void> {
  const servers = [
    listen(socketPath, METHODS),
    listen(dispatchSocketPath, DISPATCH_METHODS),
  ];

  const shutdown = () => {
    log("INFO", "shutting down...");
    for (const server of servers) server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

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
  --socket PATH           socket path (default: $XDG_RUNTIME_DIR/launcherd.sock)
  --dispatch-socket PATH  dispatch-only socket path (default: $XDG_RUNTIME_DIR/dispatch.sock)
  --key PATH              signing key (default: ~/.claude-box/launcherd.key)
  --policy PATH           policy file (default: ~/.claude-box/policy.json)
  --no-sign               skip key loading, disable attestation
  -h, --help              show this help

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

  let dispatchSocketPath = defaultDispatchSocketPath();
  const dispatchSockIdx = args.indexOf("--dispatch-socket");
  if (dispatchSockIdx >= 0 && args[dispatchSockIdx + 1]) {
    dispatchSocketPath = args[dispatchSockIdx + 1]!;
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

  await serve(socketPath, dispatchSocketPath);
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
  handleDispatch,
  DISPATCH_METHODS,
  sanitizeLabel,
  buildPodmanArgv,
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
  checkDispatchRateLimit,
  checkDispatchConcurrentLimit,
  recordDispatch,
  recordLaunch,
  findCallerRecord,
  findLaunchByContainerId,
  containerIdFromCgroup,
  resolveLaunchDoors,
  __seedLaunch,
  __setCallerContainerId,
  __clearCallerContainerId,
  __resetDispatchLimits,
  __seedActiveDispatchCount,
};
export type { RequestEnvelope, ResponseEnvelope, LaunchRecord, Room, L2Attestation, SigningKey, Policy, PolicyRule, CallerInfo };

if (import.meta.main) {
  process.exit(await main());
}
