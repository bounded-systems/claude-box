#!/usr/bin/env bun
/**
 * credential-guard — a PreToolUse hook that hard-blocks Bash/Read calls
 * whose input references the leased credential file, as a second,
 * independent layer alongside the static permissions.deny rule (which only
 * matches a fixed literal pattern) and the harness's own intent classifier
 * (soft, prompt-dependent — see claude-box#193). This one inspects the
 * actual command/path string dynamically, so it also catches variants a
 * static pattern misses: $HOME-relative paths, the file read through a
 * pipe/transform (base64, wc, sha256sum), a differently-quoted path, etc.
 *
 * Input: PreToolUse hook JSON on stdin — {tool_name, tool_input: {command}}
 * for Bash, {tool_input: {file_path}} for Read (see hooks reference).
 * Output: exit 2 + stderr message BLOCKS the call; exit 0 lets normal
 * permission handling proceed. Never throws past its own try/catch — a bug
 * in this script must not silently block every Bash/Read call.
 */
const CREDENTIALS_BASENAME = ".credentials.json";

try {
  const payload = JSON.parse(await Bun.stdin.text()) as {
    tool_name?: string;
    tool_input?: { command?: string; file_path?: string };
  };
  const toolName = payload?.tool_name;
  const target =
    toolName === "Bash"
      ? payload?.tool_input?.command
      : toolName === "Read"
        ? payload?.tool_input?.file_path
        : undefined;

  if (typeof target === "string" && target.includes(CREDENTIALS_BASENAME)) {
    console.error(
      `credential-guard: blocked — ${toolName} call references ${CREDENTIALS_BASENAME}. ` +
        "The leased access token is not readable via tool calls in this session.",
    );
    process.exit(2);
  }
} catch {
  // A guard bug must fail OPEN, not closed — never block on our own error.
}
process.exit(0);
