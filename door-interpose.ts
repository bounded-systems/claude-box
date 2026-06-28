/**
 * door-interpose.ts — front a delegated, CAVEATED door with an interposer so the
 * caveat is enforced on traffic, not carried as metadata (prx-yweb / trust 6.3).
 *
 * `resolveLaunchDoors` hands a child the parent's ACTUAL reference (host socket +
 * caveats) — reference-passing (prx-8k08) makes "can't delegate what you don't
 * hold" true at the door level. But a door's CAVEATS (narrowing *within* a door)
 * were still only metadata: the box mounted the upstream socket directly, so a
 * `scout` door caveated to one channel could still call any method. This fronts a
 * caveated unix door with an interposer that holds the upstream socket, runs
 * `checkCaveats` on every request, and rewrites the door's host to the proxy
 * socket — so the box mounts the proxy and a request outside the caveat never
 * reaches upstream. Uncaveated doors (and tcp/vsock doors, whose authority rides
 * in a signed grant) pass through unchanged — no behavior change.
 *
 * The returned doors are for the box's MOUNTS only; launcherd keeps the original
 * references in its LaunchRecord for delegation, and tears the interposers down
 * when the box exits.
 */

import { unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { type CaveatVerifiers, type DoorGrant, type DoorTransport, unix } from "./guest-room/mod.ts";
import { type InterposeContext, createInterposerHandlers } from "./guest-room/interpose.ts";

/** A running interposer + its socket, tracked for teardown when the box exits. */
export interface Interposer {
  readonly server: { stop: () => void };
  readonly socketPath: string;
}

/** Minimal `Bun.listen` surface (injectable so the wiring is testable). */
export type Listen = (opts: { unix: string; socket: unknown }) => { stop: () => void };

/**
 * The caveat grammar launcherd enforces on a delegated door's per-request
 * traffic. The broker (launcherd) owns this — the interposer engine stays
 * domain-agnostic. The context is the door request itself (`{method, params}`).
 * Any caveat key with no verifier here fails closed at the proxy.
 */
export const CAVEAT_VERIFIERS: CaveatVerifiers<InterposeContext> = {
  /** `method=read` — restrict which door methods the holder may call. */
  method: (value, ctx) => ctx.method === value,
  /** `host=a,b,.suffix` — the request's target host (`params.host`) must be allowed. */
  host: (value, ctx) => {
    const target = String((ctx.params as { host?: unknown }).host ?? "");
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .some((a) => (a.startsWith(".") ? target === a.slice(1) || target.endsWith(a) : target === a));
  },
};

function unixHostPath(t: DoorTransport): string {
  if (t.kind !== "unix") throw new Error(`interposer requires a unix upstream, got ${t.kind}`);
  return t.path;
}

/** The interposer socket path for a door: a sibling of its upstream socket (same
 *  directory ⇒ same mount-safe permissions), namespaced by launch + door. */
export function interposeSocketPath(launchId: string, door: DoorGrant): string {
  return join(dirname(unixHostPath(door.host)), `.interpose-${launchId}-${door.name}.sock`);
}

/**
 * Front every CAVEATED unix door with an interposer. Returns the doors to MOUNT
 * (caveated ones rewritten to their proxy socket) and the live interposers to
 * tear down on box exit. Uncaveated and non-unix doors pass through identically.
 */
export function frontDoorsWithInterposers(
  doors: DoorGrant[],
  launchId: string,
  verifiers: CaveatVerifiers<InterposeContext> = CAVEAT_VERIFIERS,
  listen: Listen = (o) => Bun.listen(o as Parameters<typeof Bun.listen>[0]) as { stop: () => void },
): { doors: DoorGrant[]; interposers: Interposer[] } {
  const interposers: Interposer[] = [];
  const mountDoors = doors.map((door) => {
    const caveated = (door.caveats?.length ?? 0) > 0;
    if (!caveated || door.host.kind !== "unix") return door; // pass through — no proxy
    const socketPath = interposeSocketPath(launchId, door);
    const server = listen({
      unix: socketPath,
      socket: createInterposerHandlers({ upstream: unixHostPath(door.host), grant: door, verifiers }),
    });
    interposers.push({ server, socketPath });
    return { ...door, host: unix(socketPath) }; // the box mounts the proxy, never the upstream
  });
  return { doors: mountDoors, interposers };
}

/** Tear down a launch's interposers: stop the servers, unlink their sockets. */
export function teardownInterposers(interposers: readonly Interposer[]): void {
  for (const ip of interposers) {
    try {
      ip.server.stop();
    } catch {
      /* already stopped */
    }
    try {
      unlinkSync(ip.socketPath);
    } catch {
      /* already gone */
    }
  }
}
