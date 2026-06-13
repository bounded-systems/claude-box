// guest-room — a guest-agnostic room+door capability runtime.
//
// This module knows nothing about any particular guest: no guest identity, no
// image, no container runtime. A ROOM is walls plus a furnished set of DOORS; a
// DOOR is a single (name, socket) capability brokered by a daemon that holds the
// authority the room never does. A door may be ATTENUATED — narrowed by opaque
// caveats the broker enforces — and attenuation is append-only, so a door can
// only ever be handed onward equally or more restricted, never wider. The room
// hands its guest a RULEBOOK keyed to exactly the doors present — a card per
// granted door (how to use it, and any restriction on it) and a card per denied
// door (there is no rule; do not attempt).
//
// A consumer supplies the door CATALOG and the room bundles; guest-room resolves
// grants, derives the honest granted/denied surface, and renders the rulebook
// lines. The consumer keeps its own launch mechanics (which runtime, which
// image, how state mounts) — those are the guest, not the room.
//
// Extraction note: this directory is a self-contained internal dependency. When
// it graduates to its own repo, it moves as-is and consumers flip the import
// path; nothing here names a guest — a test enforces that the engine source is
// guest-agnostic, so the seam can't silently re-couple.

/** A door name lands in a mount path (`/run/<name>.sock`) and an env var, so it
 *  must be path-safe — no `/`, no `..`, no injection into the mount spec. */
export const DOOR_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// ── Door transport ───────────────────────────────────────────────────────────
// How a door socket is addressed. The capability model is transport-agnostic;
// the substrate (container, microVM, remote) determines which transport is used.
//
//   unix:  same-machine socket (container or native substrates)
//   vsock: cross-VM socket (microVM substrates)
//   tcp:   cross-network socket (distributed/remote doors)

/** Unix domain socket — same-machine, the current default. */
export type UnixTransport = { kind: "unix"; path: string };

/** Virtio socket — crosses the VM boundary (host CID 2, guest CID 3+). */
export type VsockTransport = { kind: "vsock"; cid: number; port: number };

/** TCP socket — crosses the network (remote doors). */
export type TcpTransport = { kind: "tcp"; host: string; port: number };

/** A door's transport address. */
export type DoorTransport = UnixTransport | VsockTransport | TcpTransport;

/** Construct a unix socket transport. */
export function unix(path: string): UnixTransport {
  return { kind: "unix", path };
}

/** Construct a vsock transport (for microVM substrates). */
export function vsock(cid: number, port: number): VsockTransport {
  return { kind: "vsock", cid, port };
}

/** Construct a tcp transport (for remote doors). */
export function tcp(host: string, port: number): TcpTransport {
  return { kind: "tcp", host, port };
}

/** Render a transport as a human-readable string (for logs/errors). */
export function transportString(t: DoorTransport): string {
  switch (t.kind) {
    case "unix": return t.path;
    case "vsock": return `vsock:${t.cid}:${t.port}`;
    case "tcp": return `tcp:${t.host}:${t.port}`;
  }
}

export type Env = Record<string, string | undefined>;

/** Default host socket for a daemon, private-dir-first. Pure (no I/O) so door
 *  resolution stays testable; the launch site enforces the fail-closed
 *  world-writable-dir check. */
export function defaultHostSock(daemon: string, env: Env): string {
  return `${env.XDG_RUNTIME_DIR ?? "/tmp"}/${daemon}.sock`;
}

/** A door the room knows by name: canonical in-room path, env, and rulebook. */
export type DoorPreset = {
  flag: string; // the launcher sugar flag (e.g. "--keeper")
  inBox: string; // where the room looks for the socket
  env: string; // env var pointing the room at the in-room socket
  hostDefault: string; // host socket path (overridable so the same launch works across transports)
  grants: string; // one-line capability, for the manifest
  use: string; // rulebook when GRANTED — how the guest uses this door
  deny: string; // rulebook when DENIED — there is no rule; do not attempt
};

/** A door actually granted to a launch (resolved from a preset, or generic).
 *  Transport-agnostic: works across unix sockets, vsock (microVM), or tcp (remote). */
export type DoorGrant = {
  name: string;
  host: DoorTransport;   // broker side (where the daemon listens)
  guest: DoorTransport;  // in-box side (where the guest connects)
  env: string;           // env var pointing at the guest transport
  grants: string;        // one-line capability description
  use: string;           // rulebook when granted
  caveats?: string[];    // opaque constraints; engine carries, daemon enforces
};

// ── Attenuation ──────────────────────────────────────────────────────────────
// A door can be narrowed by appending caveats. Append-only: you can add
// constraints, never remove them, so authority is monotonically non-increasing.
// The engine carries caveats; it doesn't interpret them — that's the daemon's
// job. This separation keeps the engine guest-agnostic (no door-specific
// vocabulary) while enabling real capability attenuation.

/** Attenuate a door by appending caveats. Returns a new grant with the
 *  combined caveats; the original is unchanged. Append-only by construction. */
export function attenuate(grant: DoorGrant, more: string[]): DoorGrant {
  if (!more.length) return grant; // no-op optimization
  return { ...grant, caveats: [...(grant.caveats ?? []), ...more] };
}

/** Parse a caveat string (k=v or k:v format) into key and value. */
export function parseCaveat(s: string): { key: string; value: string } | null {
  const eq = s.indexOf("=");
  const colon = s.indexOf(":");
  const sep = eq >= 0 && (colon < 0 || eq < colon) ? eq : colon;
  if (sep < 1) return null; // no separator or empty key
  return { key: s.slice(0, sep), value: s.slice(sep + 1) };
}

/** The product's door catalog: the doors this kind of room can furnish. */
export type DoorCatalog = Record<string, DoorPreset>;

/** A room: a named bundle of doors for a KIND of work. */
export type RoomPreset = { doors: string[]; about: string };

/** The product's room catalog. */
export type RoomCatalog = Record<string, RoomPreset>;

/** Resolve a door by name to a concrete grant. A name in the catalog gets its
 *  canonical path + rulebook; any other name becomes a generic service door at
 *  /run/<name>.sock (you hold the door, not the service's keys). An explicit
 *  host transport overrides the default.
 *
 *  The hostOverride parameter accepts either a DoorTransport or a string (unix
 *  path) for backward compatibility. */
export function resolveDoor(
  catalog: DoorCatalog,
  name: string,
  hostOverride: DoorTransport | string | undefined,
  env: Env,
): DoorGrant {
  if (!DOOR_NAME_RE.test(name)) {
    throw new Error(`invalid door name "${name}" (expected [a-z0-9][a-z0-9-]*)`);
  }
  // Normalize hostOverride: string → unix transport
  const hostTransport: DoorTransport | undefined =
    hostOverride === undefined ? undefined :
    typeof hostOverride === "string" ? unix(hostOverride) :
    hostOverride;

  const known = catalog[name];
  if (known) {
    return {
      name,
      host: hostTransport ?? unix(known.hostDefault),
      guest: unix(known.inBox),
      env: known.env,
      grants: known.grants,
      use: known.use,
    };
  }
  const ENV = `${name.toUpperCase().replace(/-/g, "_")}_SOCK`;
  const guestPath = `/run/${name}.sock`;
  return {
    name,
    host: hostTransport ?? unix(env[ENV] ?? defaultHostSock(name, env)),
    guest: unix(guestPath),
    env: ENV,
    grants: `service door "${name}"`,
    use: `Reach the ${name} service at ${guestPath} ($${ENV}). You hold the door, not the service's keys.`,
  };
}

/** Attenuation — derive a strictly *narrower* door from one you already hold.
 *  A caveat is an opaque restriction (e.g. a single host, a read-only mode): the
 *  engine carries and renders it, but never interprets it — the broker behind
 *  the door enforces it, and the catalog owner owns its grammar. Append-only by
 *  construction, so authority is monotonically non-increasing: a holder can add
 *  caveats but never drop them, and so can pass a door onward (e.g. to a
 *  sub-room) only equally or more restricted, never wider. This is the
 *  object-capability attenuation rule; the caveats are macaroon-shaped. Blank
 *  caveats are dropped; attenuating by nothing returns the grant unchanged. */
export function attenuate(grant: DoorGrant, caveats: string[]): DoorGrant {
  const add = caveats.map((c) => c.trim()).filter(Boolean);
  if (!add.length) return grant;
  return { ...grant, caveats: [...(grant.caveats ?? []), ...add] };
}

/** Expand a named room to its door grants. Throws (fail closed, not a silent
 *  empty launch) if the room is unknown — a typo must never widen authority. */
export function expandRoom(
  rooms: RoomCatalog,
  catalog: DoorCatalog,
  name: string,
  env: Env,
): DoorGrant[] {
  const room = rooms[name];
  if (!room) {
    throw new Error(`unknown room "${name}" (known: ${Object.keys(rooms).join(", ")})`);
  }
  return room.doors.map((d) => resolveDoor(catalog, d, undefined, env));
}

/** The honest denial set: every catalog door NOT granted, minus any explicitly
 *  suppressed (e.g. an ambient-egress escape suppresses the "no network" denial
 *  so the surface can't claim there's no network when there is). */
export function deniedDoors(
  catalog: DoorCatalog,
  granted: Set<string>,
  suppress: Set<string> = new Set(),
): { name: string; flag: string; deny: string }[] {
  return Object.entries(catalog)
    .filter(([name]) => !granted.has(name) && !suppress.has(name))
    .map(([name, p]) => ({ name, flag: p.flag, deny: p.deny }));
}

// ── The rulebook the room hands its guest ────────────────────────────────────
// The room is credential-free by construction; the guest acts ONLY through the
// cards (doors) it holds. These render the cards: a line per granted door (how
// to translate this symbol) and a line per denied door (a symbol with no rule).

/** The preamble: "your authority is EXACTLY this, generated from the actual
 *  mounts, so it is ground truth." Parameterized by the workcell name. */
export function capabilityPreamble(workcell: string): string[] {
  return [
    `[${workcell} — capability surface for THIS launch]`,
    `You are running inside ${workcell}, a credential-free OCAP workcell. Your authority is EXACTLY the capabilities listed below — nothing is ambient. This list is generated from the actual mounts of this launch, so it is ground truth: if something is not GRANTED, you do not have it — do not attempt it and do not claim it succeeded.`,
  ];
}

/** One card per granted door: name, what it grants, and how to use it. An
 *  attenuated door also states its restriction, so the surface stays honest —
 *  a narrowed door must not read as if it were the full grant. */
export function grantedDoorLines(doors: DoorGrant[]): string[] {
  return doors.map((d) => {
    const card = `- ${d.name}: ${d.grants}. ${d.use}`;
    return d.caveats?.length
      ? `${card} RESTRICTED to: ${d.caveats.join("; ")} — requests outside this are denied.`
      : card;
  });
}

/** The DENIED section: a card per absent door (no rule; do not attempt), or an
 *  explicit "nothing named" note that authority is still only what's granted. */
export function deniedDoorSection(denied: { name: string; deny: string }[]): string[] {
  if (!denied.length) {
    return ["DENIED: nothing named — but authority is still ONLY what is GRANTED above."];
  }
  return [
    "DENIED (the capability is physically absent from this box — do not attempt):",
    ...denied.map((d) => `- ${d.name}: ${d.deny}`),
  ];
}
