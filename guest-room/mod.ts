// guest-room — a guest-agnostic room+door capability runtime.
//
// This module knows nothing about any particular guest: no guest identity, no
// image, no container runtime. A ROOM is walls plus a furnished set of DOORS; a
// DOOR is a single (name, socket) capability brokered by a daemon that holds the
// authority the room never does. The room hands its guest a RULEBOOK keyed to
// exactly the doors present — a card per granted door (how to use it) and a card
// per denied door (there is no rule; do not attempt).
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

/** A door actually granted to a launch (resolved from a preset, or generic). */
export type DoorGrant = {
  name: string;
  inBox: string;
  env: string;
  host: string;
  grants: string;
  use: string;
};

/** The product's door catalog: the doors this kind of room can furnish. */
export type DoorCatalog = Record<string, DoorPreset>;

/** A room: a named bundle of doors for a KIND of work. */
export type RoomPreset = { doors: string[]; about: string };

/** The product's room catalog. */
export type RoomCatalog = Record<string, RoomPreset>;

/** Resolve a door by name to a concrete grant. A name in the catalog gets its
 *  canonical path + rulebook; any other name becomes a generic service door at
 *  /run/<name>.sock (you hold the door, not the service's keys). An explicit
 *  host socket overrides the default. */
export function resolveDoor(
  catalog: DoorCatalog,
  name: string,
  host: string | undefined,
  env: Env,
): DoorGrant {
  if (!DOOR_NAME_RE.test(name)) {
    throw new Error(`invalid door name "${name}" (expected [a-z0-9][a-z0-9-]*)`);
  }
  const known = catalog[name];
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

/** One card per granted door: name, what it grants, and how to use it. */
export function grantedDoorLines(doors: DoorGrant[]): string[] {
  return doors.map((d) => `- ${d.name}: ${d.grants}. ${d.use}`);
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
