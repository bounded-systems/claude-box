// authd tests (prx-6194) — the RC credential-broker door. Box-facing identity is
// the signed grant scoped to door="auth" (the OIDC unification); the box is lent
// an ACCESS-TOKEN-ONLY credential; the live OAuth refresh is gated until Phase 0.
//
//   nix run nixpkgs#bun -- test tests/authd.test.ts
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { signGrant, unix, type DoorGrant, type IssuerKeys, type SignedGrant } from "../guest-room/mod.ts";
import {
  gateGrant,
  handleRequest,
  handleLease,
  toAccessTokenOnly,
  refreshAccessToken,
  isStillFresh,
  seedEphemeral,
  type ClaudeCredentials,
  __setGrantRequired,
  __setIssuerKeys,
  __resetEphemeral,
} from "../authd.ts";

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

describe("authd gateGrant — door='auth' (the OIDC identity)", () => {
  beforeEach(() => {
    process.env.ROOM_ID = "room-A";
    __setGrantRequired(true);
    __setIssuerKeys(keys);
  });
  afterAll(() => __setGrantRequired(false));

  test("accepts a valid auth grant", async () => {
    expect(await gateGrant({ id: "1", method: "lease", grant: grant("auth") })).toEqual({ ok: true });
  });

  test("no grant → no-grant", async () => {
    expect((await gateGrant({ id: "1", method: "lease" })).reason).toBe("no-grant");
  });

  test("a KEEPER grant cannot lease an auth credential (wrong-door)", async () => {
    expect((await gateGrant({ id: "1", method: "lease", grant: grant("keeper") })).reason).toBe("wrong-door");
  });

  test("a grant minted for a different room (audience) is rejected", async () => {
    const grantForOtherRoom = signGrant(
      door("auth"),
      { audience: "room-B", exp: Date.now() + 60_000, nonce: "n2", keyId: "k1" },
      sign,
    );
    // ROOM_ID is "room-A" (beforeEach); this grant's audience is "room-B".
    const result = await gateGrant({ id: "1", method: "lease", grant: grantForOtherRoom });
    expect(result.ok).toBe(false);
  });

  test("an expired grant is rejected even though the signature is valid", async () => {
    const expiredGrant = signGrant(
      door("auth"),
      { audience: "room-A", exp: Date.now() - 1_000, nonce: "n3", keyId: "k1" },
      sign,
    );
    const result = await gateGrant({ id: "1", method: "lease", grant: expiredGrant });
    expect(result.ok).toBe(false);
  });

  test("handleRequest refuses an ungranted lease with UNAUTHORIZED (no handler reached)", async () => {
    const resp = await handleRequest(JSON.stringify({ id: "9", method: "lease" }));
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("UNAUTHORIZED");
  });
});

describe("toAccessTokenOnly — the box never gets the refresh token", () => {
  test("strips refreshToken, keeps accessToken/expiresAt/scopes", () => {
    const full: ClaudeCredentials = {
      claudeAiOauth: {
        accessToken: "acc",
        refreshToken: "SECRET-REFRESH",
        expiresAt: 123,
        scopes: ["user:profile", "user:inference"],
        subscriptionType: "max",
      },
    };
    const out = toAccessTokenOnly(full);
    expect(out.claudeAiOauth.refreshToken).toBeUndefined();
    expect(out.claudeAiOauth.accessToken).toBe("acc");
    expect(out.claudeAiOauth.scopes).toEqual(["user:profile", "user:inference"]);
    expect(JSON.stringify(out)).not.toContain("SECRET-REFRESH"); // not anywhere in the leased blob
  });
});

describe("refreshAccessToken — gated until Phase 0, then mockable", () => {
  const saved = process.env.AUTHD_REFRESH_LIVE;
  afterAll(() => {
    if (saved === undefined) delete process.env.AUTHD_REFRESH_LIVE;
    else process.env.AUTHD_REFRESH_LIVE = saved;
  });

  test("REFUSES a live refresh until AUTHD_REFRESH_LIVE=1 (the Phase 0 gate)", async () => {
    delete process.env.AUTHD_REFRESH_LIVE;
    let err: { code?: string } | undefined;
    try {
      await refreshAccessToken("rt");
    } catch (e) {
      err = e as { code?: string };
    }
    expect(err?.code).toBe("REFRESH_GATED");
  });

  test("posts the confirmed refresh spec (form-encoded, client_id, no PKCE) + returns rotated creds", async () => {
    process.env.AUTHD_REFRESH_LIVE = "1";
    let seen: { url: string; ct: string; body: string } | undefined;
    const mockFetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen = { url, ct: init.headers["content-type"], body: init.body };
      return new Response(
        JSON.stringify({ access_token: "new-acc", refresh_token: "new-ref", expires_in: 28800, scope: "user:profile user:inference" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const { creds, rotatedRefreshToken } = await refreshAccessToken("old-ref", mockFetch);

    // The request matches what the claude-code client sends (Phase 0, confirmed).
    expect(seen?.url).toBe("https://platform.claude.com/v1/oauth/token");
    expect(seen?.ct).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(seen!.body);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("old-ref");
    expect(params.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(params.has("code_verifier")).toBe(false); // no PKCE on refresh

    expect(creds.claudeAiOauth.accessToken).toBe("new-acc");
    expect(rotatedRefreshToken).toBe("new-ref");
    expect(creds.claudeAiOauth.scopes).toContain("user:inference");
    // The leased (box-facing) credential drops the refresh token authd just rotated.
    expect(toAccessTokenOnly(creds).claudeAiOauth.refreshToken).toBeUndefined();
  });

  test("never sends a scope param — omitting it means \"same as originally granted\" (RFC 6749 §6), so a hardcoded scope list can't drift stale again (regression: invalid_scope when DEFAULT_SCOPES missed a real granted scope)", async () => {
    process.env.AUTHD_REFRESH_LIVE = "1";
    let seen: string | undefined;
    const mockFetch = (async (_url: string, init: { body: string }) => {
      seen = init.body;
      return new Response(
        JSON.stringify({ access_token: "a", refresh_token: "b", expires_in: 1, scope: "x" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await refreshAccessToken("old-ref", mockFetch);
    expect(new URLSearchParams(seen!).has("scope")).toBe(false);
  });
});

describe("isStillFresh — the staleness check that skips an unnecessary rotation", () => {
  const cred = (expiresAt: number): ClaudeCredentials => ({
    claudeAiOauth: { accessToken: "a", expiresAt, scopes: [] },
  });

  test("fresh well before expiry", () => {
    expect(isStillFresh(cred(Date.now() + 60 * 60 * 1000))).toBe(true);
  });

  test("stale once inside the 5-minute buffer", () => {
    expect(isStillFresh(cred(Date.now() + 60 * 1000))).toBe(false);
  });

  test("stale once already expired", () => {
    expect(isStillFresh(cred(Date.now() - 1000))).toBe(false);
  });
});

describe("handleLease — the ephemeral, in-memory-only store (Keychain/op both removed)", () => {
  const savedFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = savedFetch;
  });
  beforeEach(() => {
    __resetEphemeral();
    process.env.AUTHD_REFRESH_LIVE = "1";
  });

  test("throws EPHEMERAL_NOT_SEEDED before any credential is piped on stdin", async () => {
    let err: { code?: string } | undefined;
    try {
      await handleLease();
    } catch (e) {
      err = e as { code?: string };
    }
    expect(err?.code).toBe("EPHEMERAL_NOT_SEEDED");
  });

  test("reuses the seeded credential as-is when still fresh — no refresh call at all (right after a login)", async () => {
    globalThis.fetch = (() => {
      throw new Error("must not be called — the seeded token is still fresh");
    }) as unknown as typeof fetch;
    seedEphemeral(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "fresh-acc",
          refreshToken: "fresh-ref",
          expiresAt: Date.now() + 60 * 60 * 1000,
          scopes: ["user:inference"],
        },
      }),
    );
    const leased = (await handleLease()) as ClaudeCredentials;
    expect(leased.claudeAiOauth.accessToken).toBe("fresh-acc");
    expect(leased.claudeAiOauth.refreshToken).toBeUndefined();
  });

  test("refreshes + rewrites the in-memory store when stale, and the rotated credential is what the NEXT lease reuses", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ access_token: "new-acc", refresh_token: "new-ref", expires_in: 28800, scope: "user:inference" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    seedEphemeral(
      JSON.stringify({
        claudeAiOauth: { accessToken: "old-acc", refreshToken: "old-ref", expiresAt: Date.now() - 1000, scopes: [] },
      }),
    );
    const first = (await handleLease()) as ClaudeCredentials;
    expect(first.claudeAiOauth.accessToken).toBe("new-acc");
    expect(calls).toBe(1);

    // Second lease reuses the just-rotated, now-fresh credential — no second refresh.
    const second = (await handleLease()) as ClaudeCredentials;
    expect(second.claudeAiOauth.accessToken).toBe("new-acc");
    expect(calls).toBe(1);
  });
});
