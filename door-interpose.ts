/**
 * door-interpose.ts — front a delegated door with a BRIDGE so the box always
 * speaks UNIX to a local proxy, while the proxy owns the real edge: enforcing
 * CAVEATS on a held unix door (prx-yweb), and/or carrying a SIGNED GRANT to a
 * REMOTE (tcp) door (prx-8uf2 — "TCP always routes to sockets").
 *
 * `resolveLaunchDoors` hands a child the parent's ACTUAL reference (transport +
 * caveats). A door can't be mounted raw when:
 *   - it is a CAVEATED unix door — the box would hold the upstream socket and
 *     could call outside the caveat. Front it: the proxy runs `checkCaveats` on
 *     every request, so a request outside the caveat never reaches upstream.
 *   - it is a REMOTE (tcp) door — the box can't hold a network socket as
 *     authority, and should hold no grant. Front it: the proxy terminates a
 *     local unix socket, enforces any caveats, and presents the signed grant on
 *     the wire to the remote door's grant-gate. The box stays pure unix /
 *     held-reference and holds zero credentials.
 * The door's host is rewritten to the proxy's unix socket, so the box mounts the
 * proxy and never the upstream. Uncaveated unix doors (and vsock doors, which
 * have no `call()` connect path yet) pass through unchanged.
 *
 * The returned doors are for the box's MOUNTS only; launcherd keeps the original
 * references in its LaunchRecord for delegation, and tears the bridges down when
 * the box exits.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  type CaveatVerifiers,
  type DoorGrant,
  type SignedGrant,
  transportToEndpoint,
  unix,
} from "./guest-room/mod.ts";
import { type InterposeContext, createInterposerHandlers } from "./guest-room/interpose.ts";

/** A running bridge + its socket, tracked for teardown when the box exits. */
export interface Interposer {
  readonly server: { stop: () => void };
  readonly socketPath: string;
}

/** Minimal `Bun.listen` surface (injectable so the wiring is testable). */
export type Listen = (opts: { unix: string; socket: unknown }) => { stop: () => void };

/** Options for fronting. All optional; the defaults preserve the prx-yweb
 *  (caveated-unix) behavior, so launcherd's existing 2-arg call is unchanged. */
export interface FrontOptions {
  /** Caveat verifiers interpreting each caveat key (default: method + host). */
  verifiers?: CaveatVerifiers<InterposeContext>;
  /** Listener (injectable for tests). */
  listen?: Listen;
  /** The signed grant the bridge presents to a REMOTE (tcp) door's gate. The
   *  caller (deployment) supplies it — launcherd would resolve it via the
   *  concierge (prx-9s14). Omitted ⇒ a remote door is still fronted but presents
   *  no grant, so its gate rejects (fail closed). */
  grantFor?: (door: DoorGrant) => SignedGrant | undefined;
  /** Host directory for a REMOTE door's proxy socket (a tcp door has no unix
   *  upstream sibling dir). Default: the OS temp dir. Production passes the box's
   *  doors mount dir. */
  socketDir?: string;
}

/**
 * The caveat grammar launcherd enforces on a delegated door's per-request
 * traffic. The broker (launcherd) owns this — the interposer engine stays
 * domain-agnostic. Any caveat key with no verifier here fails closed at the proxy.
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

/** The proxy socket path for a door: a sibling of its UNIX upstream (same dir ⇒
 *  same mount-safe perms), or — for a REMOTE door with no such sibling — under
 *  `socketDir`. Namespaced by launch + door. */
export function bridgeSocketPath(launchId: string, door: DoorGrant, socketDir?: string): string {
  const base = door.host.kind === "unix" ? dirname(door.host.path) : (socketDir ?? tmpdir());
  return join(base, `.bridge-${launchId}-${door.name}.sock`);
}

/**
 * Front each door that needs a bridge — a CAVEATED unix door (enforce caveats)
 * or a REMOTE tcp door (terminate to a local unix socket + carry the grant) —
 * and return the doors to MOUNT (fronted ones rewritten to their proxy socket)
 * plus the live bridges to tear down on box exit. Uncaveated unix doors and
 * vsock doors pass through identically.
 */
export function frontDoorsWithInterposers(
  doors: DoorGrant[],
  launchId: string,
  opts: FrontOptions = {},
): { doors: DoorGrant[]; interposers: Interposer[] } {
  const verifiers = opts.verifiers ?? CAVEAT_VERIFIERS;
  const listen: Listen =
    opts.listen ?? ((o) => Bun.listen(o as Parameters<typeof Bun.listen>[0]) as { stop: () => void });
  const interposers: Interposer[] = [];
  const mountDoors = doors.map((door) => {
    const caveated = (door.caveats?.length ?? 0) > 0;
    const remote = door.host.kind === "tcp"; // vsock has no call() connect path yet
    // Mount raw iff there's nothing to enforce or carry: an uncaveated local
    // door (and any vsock door, until call() learns vsock).
    if ((!caveated && !remote) || door.host.kind === "vsock") return door;
    const socketPath = bridgeSocketPath(launchId, door, opts.socketDir);
    const server = listen({
      unix: socketPath,
      socket: createInterposerHandlers({
        upstream: transportToEndpoint(door.host),
        grant: door,
        verifiers,
        upstreamGrant: remote ? opts.grantFor?.(door) : undefined, // the wire grant, only for a remote door
      }),
    });
    interposers.push({ server, socketPath });
    return { ...door, host: unix(socketPath) }; // the box mounts the proxy, never the upstream
  });
  return { doors: mountDoors, interposers };
}

/** Tear down a launch's bridges: stop the servers, unlink their sockets. */
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
