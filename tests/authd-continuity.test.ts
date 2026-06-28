// authd-continuity harness tests (prx-6194 Phase 0 / Risk #1) — the pure
// stage/rewrite transforms. The interactive observation is owner-driven.
//
//   nix run nixpkgs#bun -- test tests/authd-continuity.test.ts
import { test, expect, describe } from "bun:test";
import type { ClaudeCredentials } from "../authd.ts";
import { stageCredential, bumpExpiry } from "../tools/authd-continuity.ts";

const full: ClaudeCredentials = {
  claudeAiOauth: {
    accessToken: "acc-TOKEN",
    refreshToken: "SECRET-REFRESH",
    expiresAt: 1000,
    scopes: ["user:profile", "user:inference"],
    subscriptionType: "max",
  },
};

describe("stageCredential — the authd shape, primed to expire", () => {
  test("strips refreshToken and sets a near-future expiry", () => {
    const now = 1_000_000;
    const staged = stageCredential(full, now, 90_000);
    expect(staged.claudeAiOauth.refreshToken).toBeUndefined(); // box never holds it
    expect(staged.claudeAiOauth.accessToken).toBe("acc-TOKEN"); // same token (no rotation)
    expect(staged.claudeAiOauth.expiresAt).toBe(now + 90_000);
    expect(staged.claudeAiOauth.scopes).toEqual(["user:profile", "user:inference"]);
    expect(JSON.stringify(staged)).not.toContain("SECRET-REFRESH");
  });
});

describe("bumpExpiry — what authd's re-lease writes", () => {
  test("moves only expiresAt forward; keeps the same (access-only) token", () => {
    const now = 2_000_000;
    const staged = stageCredential(full, 1_000_000, 90_000);
    const fresh = bumpExpiry(staged, now, 8 * 60 * 60 * 1000);
    expect(fresh.claudeAiOauth.accessToken).toBe("acc-TOKEN"); // unchanged — no rotation
    expect(fresh.claudeAiOauth.refreshToken).toBeUndefined();
    expect(fresh.claudeAiOauth.expiresAt).toBe(now + 8 * 60 * 60 * 1000);
    expect(fresh.claudeAiOauth.expiresAt).toBeGreaterThan(staged.claudeAiOauth.expiresAt);
  });
});
