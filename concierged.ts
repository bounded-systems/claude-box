#!/usr/bin/env bun
/**
 * concierged — the capability concierge for claude-box (the --concierge door).
 *
 * Service-oriented delegation: rooms don't spawn children that inherit doors —
 * they are INTRODUCED to capabilities. Providers `register` a capability (a door
 * they serve) under a liveness lease; a consumer `resolve`s a capability and is
 * handed back an ATTENUATED door reference, then messages the serving room
 * peer-to-peer. The concierge governs who is introduced to what, and how
 * narrowed — then stays off the data path (introducer, not broker).
 *
 * The pure resolution (lease-aware, attenuate-on-handoff, fail-closed) lives in
 * the guest-room engine (resolveProvider); this daemon owns the mutable
 * registry, the clock, and policy ordering. See CONCIERGE.md.
 *
 * AUTHORITY: a door determines AVAILABILITY, not authority. The concierge MINTS
 * a grant, so it SIGNS it: `resolve` returns a SignedGrant bound to the caller
 * (audience), a short expiry, and a nonce. The `keys` method publishes the
 * issuer's public key set; a serving room verifies the signed grant
 * (verifyGrantWithKeys, keyed by `kid`) before honoring a call — no shared
 * secret, reachability is not authority (CONCIERGE.md §7 / the transport-split
 * ADR). The remaining half is the serving-room verify step in each door daemon.
 *
 * Usage:
 *   concierged serve                     # foreground, default socket
 *   concierged serve --socket /path.sock # custom socket path
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  createHash,
  sign as edSign,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import type { Socket } from "bun";

import {
  defaultSocketPath,
  prepareSocket,
  createLogger,
  type RequestEnvelope,
  type ResponseEnvelope,
  ok,
  err,
} from "./lib/runtime";
import {
  resolveProvider,
  liveProviders,
  attenuate,
  unix,
  signGrant,
  DOOR_NAME_RE,
  type DoorGrant,
  type ProviderEntry,
  type GrantBinding,
  type IssuerKeys,
} from "./guest-room/mod.ts";

const log = createLogger("concierged");

// ── Config ───────────────────────────────────────────────────────────────────

const VERSION = "0.1.0";

/** Default lease (seconds) a provider gets if it doesn't ask for one. A provider
 *  must re-register within this window (heartbeat) or its entry expires and the
 *  capability becomes unresolvable — fail closed, a dead room is undiscoverable. */
const DEFAULT_LEASE_SEC = 30;
const MAX_LEASE_SEC = 300;

/** How long an issued grant's binding is valid (the `exp` the signature covers).
 *  Short: a grant is introduced just-in-time, not hoarded. */
const GRANT_TTL_SEC = 60;

// ── Grant signer (the issuer; keyless verification by the serving room) ───────
// The concierge MINTS grants, so it signs them: a resolved grant is returned as
// a SignedGrant the serving room verifies (verifyGrantWithKeys) before honoring
// a call. Verifiers hold the issuer's PUBLISHED key — served by `keys` below —
// keyed by `kid`; no shared secret (CONCIERGE.md §7, the transport-split ADR).
// Ed25519, generated on first use and persisted with private perms.

const GRANT_KEY_PATH =
  process.env.CONCIERGE_GRANT_KEY ?? `${process.env.HOME ?? "/tmp"}/.claude-box/concierge-grant.key`;

type SigningKey = {
  privateKey: ReturnType<typeof createPrivateKey>;
  publicKeyPem: string;
  keyId: string;
};
let signingKey: SigningKey | null = null;

/** Load (or generate-and-persist) the issuer's Ed25519 grant-signing key. The
 *  keyId is a stable digest of the public key — the `kid` a SignedGrant names
 *  and the `keys` door publishes. */
function getSigningKey(): SigningKey {
  if (signingKey) return signingKey;
  let privateKeyPem: string;
  let publicKeyPem: string;
  if (existsSync(GRANT_KEY_PATH)) {
    privateKeyPem = readFileSync(GRANT_KEY_PATH, "utf-8");
    publicKeyPem = createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }) as string;
  } else {
    const kp = generateKeyPairSync("ed25519");
    privateKeyPem = kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    publicKeyPem = kp.publicKey.export({ type: "spki", format: "pem" }) as string;
    mkdirSync(dirname(GRANT_KEY_PATH), { recursive: true });
    writeFileSync(GRANT_KEY_PATH, privateKeyPem, { mode: 0o600 });
    log("INFO", `generated grant signing key at ${GRANT_KEY_PATH}`);
  }
  const keyId = createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 16);
  signingKey = { privateKey: createPrivateKey(privateKeyPem), publicKeyPem, keyId };
  return signingKey;
}

/** Sign canonical grant bytes with the issuer key (injected into signGrant). */
function signData(data: string): string {
  return edSign(null, Buffer.from(data), getSigningKey().privateKey).toString("base64");
}

// ── Registry (the mutable state the engine's pure resolve runs over) ──────────

const registry: ProviderEntry[] = [];

/** Current epoch ms — isolated so tests can hold the clock if needed. */
function now(): number {
  return Date.now();
}

/** Drop expired leases. Called before every read/list so a dead provider is
 *  never resolved or reported. */
function prune(): void {
  const t = now();
  for (let i = registry.length - 1; i >= 0; i--) {
    if (registry[i]!.expiresAt <= t) registry.splice(i, 1);
  }
}

// ── Rooms: the tcp bootstrap-trust step ────────────────────────────────────
// A unix caller (claude-box.ts, a provider) IS trusted — the mounted socket is
// authority, same as every other door in this codebase. TCP has no kernel
// peer identity, so a bare box resolving over the net door needs SOME prior
// credential. A "room" is that credential: the LAUNCHER registers one, over
// its own local unix connection to concierge, at launch — naming which
// capabilities THIS box's audience/ROOM_ID may ever resolve. This is not the
// capability itself (no door details cross yet) — it's an introduction
// ticket, scoped narrower than any single door, expiring on its own lease.
// resolve() over tcp then checks the room's allowlist before minting a real
// signed grant, exactly like resolve always has for a live provider.
type RoomEntry = { roomId: string; capabilities: Set<string>; expiresAt: number };
const rooms = new Map<string, RoomEntry>();
const DEFAULT_ROOM_LEASE_SEC = 3600;
const MAX_ROOM_LEASE_SEC = 24 * 3600;

function pruneRooms(): void {
  const t = now();
  for (const [id, r] of rooms) if (r.expiresAt <= t) rooms.delete(id);
}

/** register-room: unix-only (viaTcp callers are refused — a box can't grant
 *  itself an introduction ticket). Called by the launcher at box-creation
 *  time for a bare/bastion box that should be allowed to request capabilities
 *  later, never by the box itself. */
function handleRegisterRoom(params: Record<string, unknown>, viaTcp = false): unknown {
  if (viaTcp) {
    throw { code: "FORBIDDEN", message: "register-room is unix-only (the launcher registers rooms, not the box)" };
  }
  const roomId = params.roomId as string;
  const capabilities = params.capabilities as string[];
  const leaseSec = Math.min((params.lease as number) ?? DEFAULT_ROOM_LEASE_SEC, MAX_ROOM_LEASE_SEC);
  if (!roomId) throw { code: "INVALID_PARAMS", message: "roomId required" };
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    throw { code: "INVALID_PARAMS", message: "capabilities (non-empty string[]) required" };
  }
  rooms.set(roomId, { roomId, capabilities: new Set(capabilities), expiresAt: now() + leaseSec * 1000 });
  log("ALLOW", `register-room ${roomId} capabilities=[${capabilities.join(", ")}] (lease ${leaseSec}s)`);
  return { ttl: leaseSec };
}

// ── Method handlers ────────────────────────────────────────────────────────

type MethodHandler = (params: Record<string, unknown>, viaTcp?: boolean) => Promise<unknown> | unknown;

const startedAt = new Date();

function handleStatus(_params: Record<string, unknown>): unknown {
  prune();
  return {
    version: VERSION,
    uptime: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    providers: registry.length,
  };
}

/**
 * A provider announces a capability it serves. Upserts by (capability, socket):
 * re-registering the same door is a heartbeat that renews the lease.
 *
 * Unix-only: a tcp caller (a box with no ambient trust) registering a
 * provider would let it poison the registry with a fake competing door for
 * a real capability name — only a trusted local provider may announce one.
 */
function handleRegister(params: Record<string, unknown>, viaTcp = false): unknown {
  if (viaTcp) {
    throw { code: "FORBIDDEN", message: "register is unix-only (a box cannot announce itself as a provider)" };
  }
  const capability = params.capability as string;
  const door = params.door as string; // the provider's socket path
  const env = (params.env as string) ?? `${(capability ?? "").toUpperCase().replace(/-/g, "_")}_SOCK`;
  const grants = (params.grants as string) ?? `service "${capability}"`;
  const caveats = (params.caveats as string[]) ?? undefined;
  const leaseSec = Math.min((params.lease as number) ?? DEFAULT_LEASE_SEC, MAX_LEASE_SEC);

  if (!capability || !DOOR_NAME_RE.test(capability)) {
    throw { code: "INVALID_CAPABILITY", message: `capability must match ${DOOR_NAME_RE}` };
  }
  if (!door) {
    throw { code: "INVALID_PARAMS", message: "door (socket path) required" };
  }

  const grant: DoorGrant = {
    name: capability,
    host: unix(door),
    guest: unix(door),
    env,
    grants,
    use: `Reach the ${capability} service at ${door} ($${env}).`,
    caveats: caveats?.length ? caveats : undefined,
  };
  const expiresAt = now() + leaseSec * 1000;

  // Upsert: replace an existing entry for the same capability + socket (heartbeat).
  const idx = registry.findIndex((e) => e.capability === capability && e.door.guest.kind === "unix" && (e.door.guest as { path: string }).path === door);
  if (idx >= 0) registry[idx] = { capability, door: grant, expiresAt };
  else registry.push({ capability, door: grant, expiresAt });

  log("ALLOW", `register ${capability} → ${door} (lease ${leaseSec}s${caveats?.length ? `, ceiling: ${caveats.join("; ")}` : ""})`);
  return { ttl: leaseSec };
}

/**
 * A consumer asks to be introduced to a capability. Returns the first LIVE
 * provider's door, attenuated by the caller's requested narrowing (`want`),
 * never wider than the provider's ceiling. Fail closed: unknown/dead → error.
 *
 * The response carries a `binding` (audience/exp/nonce) — the envelope a Phase-2
 * signature will cover. PHASE 1: `sig` is null and NOTHING verifies it, so the
 * grant is unauthenticated routing data, not a capability the serving room can
 * trust yet (CONCIERGE.md §9). prx wires the signer + verify in Phase 2.
 */
function handleResolve(params: Record<string, unknown>, viaTcp = false): unknown {
  const capability = params.capability as string;
  const want = (params.want as string[]) ?? [];
  const audience = (params.audience as string) ?? null; // who the grant is for (caller); bound + signed in Phase 2
  if (!capability) {
    throw { code: "INVALID_PARAMS", message: "capability required" };
  }

  // TCP bootstrap-trust gate (see "Rooms" above) — unix callers skip this;
  // the mounted socket is already authority, same as every other door.
  if (viaTcp) {
    pruneRooms();
    const room = audience ? rooms.get(audience) : undefined;
    if (!room) {
      log("DENY", `resolve ${capability} via tcp (unknown/expired room "${audience}")`);
      throw { code: "ROOM_UNKNOWN", message: `no registered room for audience "${audience}"` };
    }
    if (!room.capabilities.has(capability)) {
      log("DENY", `resolve ${capability} via tcp (room "${audience}" not authorized for it)`);
      throw { code: "ROOM_NOT_AUTHORIZED", message: `room "${audience}" is not authorized to resolve "${capability}"` };
    }
  }

  prune();
  const grant = resolveProvider(registry, capability, want, now());
  if (!grant) {
    log("DENY", `resolve ${capability} (no live provider)`);
    throw { code: "CAPABILITY_UNAVAILABLE", message: `no live provider for "${capability}"` };
  }

  // Mint a SIGNED grant: bind it to the caller (audience), a short expiry, and a
  // fresh nonce, then sign. The serving room verifies (verifyGrantWithKeys)
  // before honoring a call — reachability is not authority.
  const key = getSigningKey();
  const binding: GrantBinding = {
    audience: audience ?? "",
    exp: now() + GRANT_TTL_SEC * 1000,
    nonce: crypto.randomUUID(),
    keyId: key.keyId,
  };
  const signed = signGrant(grant, binding, signData);

  log("ALLOW", `resolve ${capability}${want.length ? ` want[${want.join("; ")}]` : ""} → ${(grant.guest as { path: string }).path}`);
  // The SignedGrant carries `binding` + `signature` inline; `binding` is also
  // returned at top level for consumers that read it directly.
  return { door: signed, binding: signed.binding };
}

/** Publish the issuer's public key set (keyless verification). A serving room
 *  fetches this once, caches it, and verifies signed grants against the key the
 *  grant names by `kid`. Rotation = serve an additional key here. */
function handleKeys(_params: Record<string, unknown>): unknown {
  const key = getSigningKey();
  const keys: IssuerKeys = { keys: [{ kid: key.keyId, publicKeyPem: key.publicKeyPem }] };
  return keys;
}

/** Discovery: the capabilities currently served (one row per live capability).
 *  Unix-only — a box shouldn't get a map of every capability on the host
 *  before it's even been introduced to one. */
function handleList(_params: Record<string, unknown>, viaTcp = false): unknown {
  if (viaTcp) {
    throw { code: "FORBIDDEN", message: "list is unix-only" };
  }
  prune();
  const byCap = new Map<string, { capability: string; grants: string; providers: number }>();
  for (const e of registry) {
    const row = byCap.get(e.capability) ?? { capability: e.capability, grants: e.door.grants, providers: 0 };
    row.providers += 1;
    byCap.set(e.capability, row);
  }
  return { capabilities: [...byCap.values()] };
}

const METHODS: Record<string, MethodHandler> = {
  status: handleStatus,
  register: handleRegister,
  "register-room": handleRegisterRoom,
  resolve: handleResolve,
  list: handleList,
  keys: handleKeys,
};

// ── Request handling ─────────────────────────────────────────────────────────

async function handleRequest(line: string, viaTcp = false): Promise<ResponseEnvelope> {
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
    const result = await handler(params ?? {}, viaTcp);
    return ok(id, result);
  } catch (e) {
    const error = e as { code?: string; message?: string };
    return err(id, error.code ?? "INTERNAL_ERROR", error.message ?? String(e));
  }
}

// ── Socket server ────────────────────────────────────────────────────────────

const socketHandler = {
  async data(socket: Socket, data: Buffer) {
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      const resp = await handleRequest(line, false);
      socket.write(JSON.stringify(resp) + "\n");
    }
  },
  open(_socket: Socket) {},
  close(_socket: Socket) {},
  error(_socket: Socket, error: Error) {
    log("ERR", `socket error: ${error}`);
  },
};

function startUnix(socketPath: string): void {
  const dir = dirname(socketPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  prepareSocket(socketPath);
  log("INFO", `listening unix ${socketPath} (introducer; default lease ${DEFAULT_LEASE_SEC}s)`);
  Bun.listen({ unix: socketPath, socket: socketHandler });
}

// tcp: bare/bastion boxes reach concierge over the net door the same way they
// reach authd/repod. No kernel peer identity, so `resolve` is room-gated (see
// "Rooms" above); `register`/`register-room`/`list` stay refused over tcp —
// only a trusted local (unix) caller may announce a provider or a room.
const tcpSocketHandler = {
  async data(socket: Socket, data: Buffer) {
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      const resp = await handleRequest(line, true);
      socket.write(JSON.stringify(resp) + "\n");
    }
  },
  open(_socket: Socket) {},
  close(_socket: Socket) {},
  error(_socket: Socket, error: Error) {
    log("ERR", `tcp socket error: ${error}`);
  },
};

function startTcp(port: number, host: string = "0.0.0.0"): void {
  log("INFO", `listening tcp ${host}:${port} (room-gated resolve; register/register-room/list unix-only)`);
  Bun.listen({ hostname: host, port, socket: tcpSocketHandler });
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = Bun.argv.slice(2);
  const cmd = args[0];

  if (cmd === "serve") {
    let socketPath = defaultSocketPath("concierged");
    let port: number | undefined;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--socket" || args[i] === "-s") socketPath = args[++i]!;
      else if (args[i] === "--port" || args[i] === "-p") port = Number(args[++i]);
    }
    // unix always starts (trusted local register/register-room/list/resolve);
    // tcp is additive, opt-in via --port, for bare boxes reaching in over the
    // net door.
    startUnix(socketPath);
    if (port) startTcp(port);
    await new Promise(() => {});
    return 0;
  }

  console.log(`concierged — capability concierge for claude-box

Usage:
  concierged serve                     start daemon (unix socket only)
  concierged serve --socket PATH       custom socket path
  concierged serve --port PORT         ALSO listen on tcp (room-gated resolve)

Methods (NDJSON over the socket):
  register       announce a capability you serve (door + lease) — unix-only
  register-room  authorize an audience/ROOM_ID to resolve specific
                 capabilities later over tcp — unix-only (the launcher calls
                 this at box-creation time, never the box itself)
  resolve        be introduced to a capability (returns an attenuated door) —
                 tcp callers must belong to a registered room
  list           capabilities currently served — unix-only
  status         health + provider count

See CONCIERGE.md.`);
  return cmd === "-h" || cmd === "--help" ? 0 : 1;
}

// ── Exports for testing ──────────────────────────────────────────────────────

export {
  handleRequest,
  handleRegister,
  handleRegisterRoom,
  handleResolve,
  handleList,
  handleStatus,
  socketHandler,
  registry,
  rooms,
  VERSION,
};

if (import.meta.main) {
  process.exit(await main());
}
