/**
 * repod tests — the repo-materialization door (prx-8uf2 continuation,
 * 2026-07-03). repod owns the ONE thing claude-room must never touch
 * directly: real git access to a host bare repo. It exposes exactly one
 * operation (prepare a worktree checkout of a ref) and holds no other
 * capability — no network, no credentials, no host paths beyond the bare
 * repo (read) and the shared checkouts dir (read-write).
 *
 * These exercise the pure logic (assertSafeRef, prepareCheckout) against a
 * real throwaway bare repo + worktree on disk — no daemon/socket needed for
 * these; door-mounts.test.ts / door.test.ts cover the wiring shape.
 */
import { afterEach, afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";

import { assertSafeRef, prepareCheckout, gateGrant, handleEnvelope, __setGrantRequired, __setIssuerKeys } from "../repod.ts";
import { signGrant, unix, type DoorGrant, type IssuerKeys, type SignedGrant } from "../guest-room/mod.ts";

function sh(args: string[], cwd: string): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

let root: string;
let bareRepo: string;
let seedClone: string;
let outDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "repod-test-"));
  bareRepo = join(root, "repo.git");
  seedClone = join(root, "seed");
  outDir = join(root, "checkouts");
  mkdirSync(outDir, { recursive: true });

  sh(["init", "--bare", "-b", "main", bareRepo], root);
  sh(["clone", bareRepo, seedClone], root);
  sh(["config", "user.email", "test@example.com"], seedClone);
  sh(["config", "user.name", "Test"], seedClone);
  Bun.write(join(seedClone, "README.md"), "hello\n");
  sh(["add", "README.md"], seedClone);
  sh(["commit", "-m", "seed"], seedClone);
  sh(["push", "origin", "main"], seedClone);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("assertSafeRef accepts a normal branch name", () => {
  expect(() => assertSafeRef("fix/some-thing_123")).not.toThrow();
});

test("assertSafeRef rejects path traversal and shell metacharacters", () => {
  expect(() => assertSafeRef("../../etc/passwd")).toThrow(/invalid ref/);
  expect(() => assertSafeRef("main; rm -rf /")).toThrow(/invalid ref/);
  expect(() => assertSafeRef("$(whoami)")).toThrow(/invalid ref/);
  expect(() => assertSafeRef("a\nb")).toThrow(/invalid ref/);
});

test("prepareCheckout fails closed when REPOD_BARE_REPO is unset", () => {
  const result = prepareCheckout("main", undefined, outDir);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("REPOD_BARE_REPO");
});

test("prepareCheckout rejects an unsafe ref before touching git", () => {
  const result = prepareCheckout("../escape", bareRepo, outDir);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("invalid ref");
});

test("prepareCheckout materializes an existing branch as a real worktree", () => {
  const result = prepareCheckout("main", bareRepo, outDir);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(existsSync(join(result.path, "README.md"))).toBe(true);
    expect(existsSync(join(result.path, ".git"))).toBe(true);
  }
});

test("prepareCheckout is idempotent — a second call reuses the healthy worktree", () => {
  const first = prepareCheckout("main", bareRepo, outDir);
  const second = prepareCheckout("main", bareRepo, outDir);
  expect(first).toEqual(second);
});

test("prepareCheckout cuts a NEW branch from origin/main when the ref doesn't exist yet", () => {
  const result = prepareCheckout("feature/new-thing", bareRepo, outDir);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(existsSync(join(result.path, "README.md"))).toBe(true);
  }
});

test("prepareCheckout self-heals a broken/leftover registration at the target path", () => {
  const first = prepareCheckout("main", bareRepo, outDir);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  // Simulate corruption: the working dir is gone but the worktree is still
  // registered in the bare repo's administrative area.
  rmSync(first.path, { recursive: true, force: true });
  const healed = prepareCheckout("main", bareRepo, outDir);
  expect(healed.ok).toBe(true);
  if (healed.ok) {
    expect(existsSync(join(healed.path, "README.md"))).toBe(true);
  }
});

// ── TCP "bellhop" mode: signed-grant gated, door="repo" ──────────────────────
// Mirrors tests/authd.test.ts's gateGrant suite exactly — same shape, same
// concierge-minted-grant mechanism, scoped to a different door name.
const kp = generateKeyPairSync("ed25519");
const pem = kp.publicKey.export({ type: "spki", format: "pem" }) as string;
const sign = (d: string): string => nodeSign(null, Buffer.from(d), kp.privateKey).toString("base64");
const keys: IssuerKeys = { keys: [{ kid: "k1", publicKeyPem: pem }] };

const door = (name: string): DoorGrant => ({
  name,
  host: unix(`/tmp/${name}d.sock`),
  guest: unix(`/run/doors/${name}d.sock`),
  env: `${name.toUpperCase()}D_SOCK`,
  grants: `${name} access`,
  use: `use ${name}`,
});
const grant = (name: string): SignedGrant =>
  signGrant(door(name), { audience: "room-A", exp: Date.now() + 60_000, nonce: "n1", keyId: "k1" }, sign);

describe("repod gateGrant — door='repo' (the bellhop TCP mode)", () => {
  beforeEach(() => {
    process.env.ROOM_ID = "room-A";
    __setGrantRequired(true);
    __setIssuerKeys(keys);
  });
  afterAll(() => __setGrantRequired(false));

  test("accepts a valid repo grant", async () => {
    expect(await gateGrant({ id: "1", method: "prepare", grant: grant("repo") })).toEqual({ ok: true });
  });

  test("no grant → no-grant", async () => {
    expect((await gateGrant({ id: "1", method: "prepare" })).reason).toBe("no-grant");
  });

  test("an AUTH grant cannot prepare a checkout (wrong-door)", async () => {
    expect((await gateGrant({ id: "1", method: "prepare", grant: grant("auth") })).reason).toBe("wrong-door");
  });

  test("handleEnvelope refuses an ungranted prepare with UNAUTHORIZED (no handler reached)", async () => {
    const resp = await handleEnvelope(JSON.stringify({ id: "9", method: "prepare", params: { ref: "main" } }));
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("UNAUTHORIZED");
  });

  test("handleEnvelope with a valid grant reaches the handler (not blocked at the gate)", async () => {
    // TCP_METHODS.prepare uses the module-level REPOD_BARE_REPO/OUT_DIR (env-
    // derived at import time), not this file's per-test tmpdir fixtures — so
    // this only asserts the gate passes and the real handler runs, not that
    // it succeeds. prepareCheckout's own success path is covered above.
    const resp = await handleEnvelope(
      JSON.stringify({ id: "1", method: "prepare", params: { ref: "main" }, grant: grant("repo") }),
    );
    expect(resp.error?.code).not.toBe("UNAUTHORIZED");
  });
});
