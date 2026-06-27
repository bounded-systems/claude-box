#!/usr/bin/env bun
/**
 * record-authored — the box-side capture half of GitAI authorship provenance
 * (GITAI-PROVENANCE.md). Run as a Claude Code PostToolUse hook on Edit/Write: it
 * reads the hook payload (JSON on stdin), extracts the edited file, and appends
 * its REPO-RELATIVE path to the sink named by $KEEPER_AUTHORSHIP_SINK.
 *
 * The keeper CLI (`keeper commit`) reads + truncates that sink at commit time
 * and passes it as the authorship CLAIM; keeperd reconciles the claim against
 * the actually-staged diff and records aiAuthored / divergent (bypass) / stale
 * in the SIGNED L3 attestation. This is the model's self-report, not authority —
 * keeperd's reconciliation is what makes it trustworthy.
 *
 * Paths are made repo-relative (relative to the payload's `cwd` = the box repo
 * root /work) so they match keeperd's `git diff --cached --name-only` names.
 *
 * Best-effort by construction: any failure is swallowed so the hook NEVER blocks
 * an edit, and it no-ops when $KEEPER_AUTHORSHIP_SINK is unset.
 */
const sink = process.env.KEEPER_AUTHORSHIP_SINK;
if (sink) {
  try {
    const payload = JSON.parse(await Bun.stdin.text()) as {
      tool_input?: { file_path?: string };
      cwd?: string;
    };
    const filePath = payload?.tool_input?.file_path;
    if (typeof filePath === "string" && filePath) {
      const { relative, isAbsolute } = await import("node:path");
      const { appendFileSync } = await import("node:fs");
      const cwd = payload?.cwd ?? process.cwd();
      // Repo-relative when the edit is under the repo root; otherwise leave as-is
      // (an out-of-repo edit won't match the staged diff → keeperd flags it).
      const rel = isAbsolute(filePath) ? relative(cwd, filePath) : filePath;
      appendFileSync(sink, `${rel}\n`);
    }
  } catch {
    // never block the edit
  }
}
