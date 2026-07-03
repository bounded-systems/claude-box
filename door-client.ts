#!/usr/bin/env bun
/**
 * door-client — the client half of "launch bare, request a capability on
 * demand" (CONCIERGE.md §3b, REPOD.md Status). Asks concierge (reached over
 * the net door, tcp — CONCIERGE_SOCK) for a signed grant scoped to a
 * capability, presenting the box's own ROOM_ID as audience: the room
 * concierge already knows about, registered by the launcher at
 * box-creation time (register-room, unix-only — the box never registers
 * itself). Then calls the resolved provider directly with that grant.
 *
 * Today this only supports capability="repo" (repod's prepare op), since
 * that's the one bellhop door that exists. Adding another capability later
 * is just another case below — the concierge/grant machinery is already
 * generic; nothing here is repo-specific except the final `prepare` call.
 *
 * Usage: door-client repo <ref>
 * Prints the result (a checkout path, for "repo") to stdout on success
 * (exit 0); prints the error to stderr and exits 1 on failure.
 */
import { call } from "./guest-room/protocol.ts";
import type { SignedGrant } from "./guest-room/mod.ts";

/** Ask concierge for a signed grant scoped to `capability` (audience=roomId),
 *  then call the resolved provider's `prepare` op with it. Pure-ish: every
 *  side-effecting dependency (the concierge/provider endpoints) is reached
 *  only through the injectable `conciergeSock`, so tests point it at a
 *  throwaway fixture instead of a real daemon. */
export async function requestRepoCheckout(
  ref: string,
  conciergeSock: string,
  roomId: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  let resolved: { door: SignedGrant };
  try {
    resolved = await call(conciergeSock, "resolve", { capability: "repo", audience: roomId });
  } catch (e) {
    return { ok: false, error: `resolve failed: ${(e as Error).message}` };
  }

  const grant = resolved.door;
  if (grant.guest.kind !== "tcp") {
    return { ok: false, error: `resolved door is not tcp-reachable (got "${grant.guest.kind}")` };
  }
  const endpoint = `${grant.guest.host}:${grant.guest.port}`;

  try {
    const prepared = await call<{ path: string }>(endpoint, "prepare", { ref }, { grant });
    return { ok: true, path: prepared.path };
  } catch (e) {
    return { ok: false, error: `prepare failed: ${(e as Error).message}` };
  }
}

async function main(): Promise<number> {
  const [capability, ref] = Bun.argv.slice(2);
  const conciergeSock = process.env.CONCIERGE_SOCK;
  const roomId = process.env.ROOM_ID;
  if (!conciergeSock || !roomId) {
    console.error("door-client: CONCIERGE_SOCK and ROOM_ID must be set");
    return 1;
  }
  if (capability !== "repo") {
    console.error(`door-client: unsupported capability "${capability}" (only "repo" today)`);
    return 1;
  }
  if (!ref) {
    console.error("usage: door-client repo <ref>");
    return 1;
  }

  const result = await requestRepoCheckout(ref, conciergeSock, roomId);
  if (!result.ok) {
    console.error(`door-client: ${result.error}`);
    return 1;
  }
  console.log(result.path);
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
