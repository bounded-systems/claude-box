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

import { unlinkSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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
  type DoorGrant,
  type Manifest,
  type Launch,
} from "./claude-box";
import {
  statement,
  PREDICATE_TYPE,
  IN_TOTO_STATEMENT_TYPE,
  type CapabilityProvenanceStatement,
  type DigestSet,
} from "./contract/types";

// ── Config ───────────────────────────────────────────────────────────────────

const VERSION = "0.1.0";
const IMAGE = "localhost/claude-personal:dev";
const NETD_PROXY = "http://127.0.0.1:3128";

function defaultSocketPath(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) return `${runtime}/launcherd.sock`;
  const home = process.env.HOME ?? "/tmp";
  return `${home}/.claude-box/launcherd.sock`;
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
  uid?: number;           // Unix UID of the caller
  socket?: string;        // Socket path the request came from (for in-box callers)
  // Permissions
  allow: string[];        // Rooms/profiles this caller may request
  maxConcurrent?: number; // Max concurrent boxes this caller can have
};

type Policy = {
  defaultAllow?: string[];  // Rooms allowed if no rule matches (default: none)
  rules: PolicyRule[];
};

let policy: Policy | null = null;

function loadPolicy(path: string): Policy | null {
  try {
    if (!existsSync(path)) {
      return null;
    }
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content) as Policy;
    // Validate structure
    if (!Array.isArray(parsed.rules)) {
      console.error(`launcherd: invalid policy file (rules must be an array)`);
      return null;
    }
    return parsed;
  } catch (e) {
    console.error(`launcherd: failed to load policy: ${e}`);
    return null;
  }
}

/** Check if a room is allowed for the current caller. Returns true if allowed. */
function isRoomAllowed(roomName: string): boolean {
  // No policy = allow all (permissive default for development)
  if (!policy) {
    return true;
  }

  // Check rules in order
  // For now, we can't identify callers by UID over unix socket in Bun easily,
  // so we just check the default allow list
  // TODO: Use SO_PEERCRED to get caller UID

  // Check default allow
  if (policy.defaultAllow?.includes(roomName)) {
    return true;
  }

  // For now, if there's a policy but no matching rule and no default, deny
  return false;
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
    console.error(`launcherd: generated new signing key at ${keyPath}`);
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
  statement: CapabilityProvenanceStatement;
  statementDigest: string;
  signature: string;
  keyId: string;
};

/** Build and sign an L2 launch attestation. */
function buildL2Attestation(
  launchId: string,
  imageDigest: string,
  manifest: Manifest,
  manifestJson: string,
): L2Attestation {
  const manifestDigest = sha256(manifestJson);
  const now = new Date().toISOString();

  // Build the L2 statement per contract/CHAIN.md
  const stmt = statement(
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
          socket: d.inBox,
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

type RequestEnvelope = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

type ResponseEnvelope = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

type LaunchRecord = {
  launchId: string;
  account: string;
  pid: number;
  startedAt: Date;
  doors: string[];
  repo?: string;
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
      reachable: await checkDoorReachable(d.host),
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

  return {
    version: VERSION,
    uptime: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    launches: launches.size,
    signing: signingKey
      ? { enabled: true, keyId: signingKey.keyId }
      : { enabled: false },
    policy: policy
      ? { enabled: true, defaultAllow: policy.defaultAllow ?? [], rulesCount: policy.rules.length }
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
  let doorSpecs = (params.doors as string[]) ?? [];

  // Validate account
  if (!/^[A-Za-z0-9._-]+$/.test(account)) {
    throw { code: "INVALID_ACCOUNT", message: `invalid account name: ${account}` };
  }

  // Expand room to doors
  if (roomName) {
    const room = ROOMS[roomName];
    if (!room) {
      throw { code: "UNKNOWN_ROOM", message: `unknown room: ${roomName}. Available: ${Object.keys(ROOMS).join(", ")}` };
    }
    // Check policy
    if (!isRoomAllowed(roomName)) {
      throw { code: "POLICY_DENIED", message: `room '${roomName}' not permitted by policy` };
    }
    doorSpecs = [...room.doors, ...doorSpecs];
    if (room.netOpen && !netOpen) {
      // Room implies netOpen
      (params as Record<string, unknown>).netOpen = true;
    }
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
    manifest,
    attestation,
    proc,
  };
  launches.set(launchId, record);

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
    argv.push("-v", `${d.host}:${d.inBox}`, "--env", `${d.env}=${d.inBox}`);
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
    return { id: "", ok: false, error: { code: "PARSE_ERROR", message: "invalid JSON" } };
  }

  const { id, method, params } = req;
  if (!id || !method) {
    return { id: id ?? "", ok: false, error: { code: "INVALID_REQUEST", message: "id and method required" } };
  }

  const handler = METHODS[method];
  if (!handler) {
    return { id, ok: false, error: { code: "UNKNOWN_METHOD", message: `unknown method: ${method}` } };
  }

  try {
    const result = await handler(params ?? {});
    return { id, ok: true, result };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return {
      id,
      ok: false,
      error: {
        code: err.code ?? "INTERNAL_ERROR",
        message: err.message ?? String(e),
      },
    };
  }
}

function assertSocketDir(sock: string): void {
  const dir = dirname(sock);
  let mode: number;
  try {
    mode = statSync(dir).mode;
  } catch {
    console.error(`launcherd: socket dir ${dir} does not exist`);
    process.exit(2);
  }
  if (mode & 0o002) {
    console.error(`launcherd: refusing socket in world-writable ${dir} (hijack risk)`);
    process.exit(2);
  }
}

async function serve(socketPath: string): Promise<void> {
  assertSocketDir(socketPath);

  // Clean up stale socket
  try {
    unlinkSync(socketPath);
  } catch {
    // Doesn't exist, fine
  }

  console.error(`launcherd: listening on ${socketPath}`);

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
      error(_socket, err) {
        console.error("launcherd: socket error:", err);
      },
    },
  });

  // Handle shutdown
  process.on("SIGINT", () => {
    console.error("\nlauncherd: shutting down...");
    server.stop();
    try { unlinkSync(socketPath); } catch {}
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    server.stop();
    try { unlinkSync(socketPath); } catch {}
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
  launcherd serve --no-sign           disable L2 attestation signing

Options:
  --socket PATH    socket path (default: $XDG_RUNTIME_DIR/launcherd.sock)
  --key PATH       signing key (default: ~/.claude-box/launcherd.key)
  --no-sign        skip key loading, disable attestation
  -h, --help       show this help`;

async function main(): Promise<number> {
  const args = Bun.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);
    return 0;
  }

  const cmd = args[0];
  if (cmd !== "serve") {
    console.error("usage: launcherd serve [--socket PATH] [--key PATH] [--no-sign]");
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
      console.error(`launcherd: signing enabled (keyId: ${signingKey.keyId.slice(0, 16)}...)`);
    } catch (e) {
      console.error(`launcherd: failed to load signing key: ${e}`);
      console.error("launcherd: continuing without signing (use --no-sign to suppress)");
    }
  } else {
    console.error("launcherd: signing disabled (--no-sign)");
  }

  await serve(socketPath);
  return 0;
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
};
export type { RequestEnvelope, ResponseEnvelope, LaunchRecord, Room, L2Attestation, SigningKey };

if (import.meta.main) {
  process.exit(await main());
}
