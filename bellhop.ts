#!/usr/bin/env bun
/**
 * bellhop — the ONE command a box runs to request a capability on demand
 * (CONCIERGE.md §3b, REPOD.md Status). Asks concierge (reached over the net
 * door, tcp — CONCIERGE_SOCK) for a signed grant scoped to a capability,
 * presenting the box's own ROOM_ID as audience: the room concierge already
 * knows about, registered by the launcher at box-creation time
 * (register-room, unix-only — the box never registers itself). Then calls
 * the resolved provider directly with that grant.
 *
 * Today this only supports capability="repo" (repod's prepare op), since
 * that's the one bellhop-mode provider that exists. Adding another
 * capability later is just another case below — the concierge/grant
 * machinery is already generic; nothing here is repo-specific except the
 * final `prepare` call.
 *
 * Usage: bellhop repo <ref>
 * Prints the result (a checkout path, for "repo") to stdout on success
 * (exit 0); prints the error to stderr and exits 1 on failure.
 *
 * Authored as a verbspec.ts VerbSpec (see bellhopVerb below): the SAME spec
 * drives argv parsing here AND projects to a Claude Code slash command
 * (`bun bellhop.ts --emit-command > .claude/commands/bellhop.md`) — one
 * definition, so the command's argument-hint can't drift from what this file
 * actually parses.
 */
import { call } from "./guest-room/protocol.ts";
import type { SignedGrant } from "./guest-room/mod.ts";
import { defineVerb, parseArgs, toHelp, toClaudeCommand } from "./verbspec.ts";

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

/** bellhop's own CLI, as a verbspec VerbSpec: `bellhop <capability> <ref>`.
 *  Only capability="repo" exists today (see requestRepoCheckout); a second
 *  capability is just another branch in `run` below — the concierge/grant
 *  machinery is already generic. */
export const bellhopVerb = defineVerb<{ capability: string; ref: string }>({
  id: "bellhop",
  summary:
    "Request a capability from concierge on demand, scoped to this room. The ONE sanctioned client command for this — do not reach the provider directly.",
  positionals: ["capability", "ref"],
  params: {
    capability: { type: "string", required: true, description: 'the capability to request (only "repo" today)' },
    ref: { type: "string", required: true, description: "the git ref to check out (capability=repo)" },
  },
  run: async ({ capability, ref }) => {
    const conciergeSock = process.env.CONCIERGE_SOCK;
    const roomId = process.env.ROOM_ID;
    if (!conciergeSock || !roomId) {
      throw new Error("CONCIERGE_SOCK and ROOM_ID must be set");
    }
    if (capability !== "repo") {
      throw new Error(`unsupported capability "${capability}" (only "repo" today)`);
    }
    const result = await requestRepoCheckout(ref, conciergeSock, roomId);
    if (!result.ok) throw new Error(result.error);
    return result.path;
  },
});

async function main(): Promise<number> {
  const argv = Bun.argv.slice(2);

  if (argv[0] === "--emit-command") {
    console.log(toClaudeCommand(bellhopVerb, { scriptPath: "bellhop.ts" }));
    return 0;
  }
  if (argv[0] === "-h" || argv[0] === "--help") {
    console.log(toHelp(bellhopVerb));
    return 0;
  }

  let input: { capability: string; ref: string };
  try {
    input = parseArgs(bellhopVerb, argv);
  } catch (e) {
    console.error(`bellhop: ${(e as Error).message}`);
    console.error(toHelp(bellhopVerb));
    return 1;
  }

  try {
    console.log(await bellhopVerb.run(input));
    return 0;
  } catch (e) {
    console.error(`bellhop: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
