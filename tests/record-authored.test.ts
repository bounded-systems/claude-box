/**
 * record-authored tests (GitAI Phase 2, box-side capture) — the PostToolUse hook
 * that appends edited paths to $KEEPER_AUTHORSHIP_SINK as REPO-RELATIVE names
 * (so they match keeperd's `git diff --cached --name-only`). Best-effort: it must
 * never throw into the hook and must no-op without the sink env.
 *
 *   nix run nixpkgs#bun -- test tests/record-authored.test.ts
 */
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "record-authored.ts");

function run(payload: unknown, env: Record<string, string>): number {
  const p = Bun.spawnSync([process.execPath, SCRIPT], {
    stdin: Buffer.from(JSON.stringify(payload)),
    env: { ...process.env, ...env },
  });
  return p.exitCode;
}

test("appends the edited file as a repo-relative path", () => {
  const sink = join(mkdtempSync(join(tmpdir(), "ra-")), "authored");
  run({ cwd: "/work", tool_input: { file_path: "/work/src/foo.ts" } }, {
    KEEPER_AUTHORSHIP_SINK: sink,
  });
  expect(readFileSync(sink, "utf-8")).toBe("src/foo.ts\n");
});

test("accumulates multiple edits", () => {
  const sink = join(mkdtempSync(join(tmpdir(), "ra-")), "authored");
  run({ cwd: "/work", tool_input: { file_path: "/work/a.ts" } }, { KEEPER_AUTHORSHIP_SINK: sink });
  run({ cwd: "/work", tool_input: { file_path: "/work/b.ts" } }, { KEEPER_AUTHORSHIP_SINK: sink });
  expect(readFileSync(sink, "utf-8")).toBe("a.ts\nb.ts\n");
});

test("no sink env → no-op, exit 0", () => {
  expect(run({ cwd: "/work", tool_input: { file_path: "/work/a.ts" } }, {
    KEEPER_AUTHORSHIP_SINK: "",
  })).toBe(0);
});

test("malformed payload → no throw, nothing written", () => {
  const sink = join(mkdtempSync(join(tmpdir(), "ra-")), "authored");
  const p = Bun.spawnSync([process.execPath, SCRIPT], {
    stdin: Buffer.from("not json"),
    env: { ...process.env, KEEPER_AUTHORSHIP_SINK: sink },
  });
  expect(p.exitCode).toBe(0);
  expect(existsSync(sink)).toBe(false);
});
