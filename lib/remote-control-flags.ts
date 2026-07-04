/**
 * remote-control-flags — one definition for `claude remote-control`'s (server
 * mode) CLI flags, projected to real argv. See
 * schemas/remote-control-flags.schema.json for the full shape, defaults, and
 * WHY each choice was made (e.g. --spawn worktree matching claude-box's own
 * isolation philosophy, --no-sandbox since podman is already the boundary).
 *
 * No Zod (this repo ships zero npm dependencies by design) — a small
 * hand-rolled render function instead, matching verbspec.ts's own precedent.
 * This isn't a validator (the shape is simple enough, and it's only ever
 * constructed by claude-box.ts's own code, not untrusted input) — just the
 * one place that turns "what we decided" into "the exact args claude sees,"
 * so they can't drift apart.
 */

export type RemoteControlFlags = {
  name?: string;
  sessionNamePrefix?: string;
  resume?: { continue: true } | { sessionId: string };
  spawn?: "same-dir" | "worktree" | "session";
  capacity?: number;
  createSessionInDir?: boolean;
  verbose?: boolean;
  sandbox?: boolean;
};

/** claude-box's own default posture for a --remote-serve bastion: worktree
 *  spawn (isolated per on-demand session, matching --repo-ephemeral), no
 *  sandbox (podman is already the boundary), identifiable session prefix. */
export const CLAUDE_BOX_DEFAULT_FLAGS: RemoteControlFlags = {
  sessionNamePrefix: "claude-box",
  spawn: "worktree",
};

/** Render flags to the argv fragment `claude remote-control` (already
 *  prepended by the caller) accepts. Throws on the one real conflict claude
 *  itself rejects (spawn=session + capacity) rather than silently dropping
 *  one — this is meant to catch a mistake in claude-box.ts's own code, not
 *  handle untrusted input. */
export function renderRemoteControlArgs(flags: RemoteControlFlags): string[] {
  if (flags.spawn === "session" && flags.capacity !== undefined) {
    throw new Error("remote-control-flags: --spawn=session cannot combine with --capacity");
  }
  const args: string[] = [];
  if (flags.name) args.push("--name", flags.name);
  if (flags.sessionNamePrefix) {
    args.push("--remote-control-session-name-prefix", flags.sessionNamePrefix);
  }
  if (flags.resume) {
    if ("continue" in flags.resume) args.push("--continue");
    else args.push("--session-id", flags.resume.sessionId);
  }
  if (flags.spawn) args.push("--spawn", flags.spawn);
  if (flags.capacity !== undefined) args.push("--capacity", String(flags.capacity));
  if (flags.createSessionInDir === false) args.push("--no-create-session-in-dir");
  if (flags.verbose) args.push("--verbose");
  if (flags.sandbox) args.push("--sandbox");
  return args;
}
