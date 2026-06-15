/**
 * concierged introduction plumbing — introduction hands back a NARROWED door
 * whose caveats are well-formed (the shape checkCaveats evaluates).
 *
 * Boots a real concierged listener, drives it with the in-box client
 * (lib/concierge), and asserts the Phase-1 introducer plumbing: a resolved
 * capability comes back as a DoorGrant attenuated to the provider's ceiling
 * (and any narrowing the caller asked for). The concierge never sees the
 * target's payload (introducer, not broker).
 *
 * ⚠️ This is PLUMBING, not a security boundary (CONCIERGE.md §9). It shows the
 * caveats are CARRIED and well-formed — NOT that introduction is non-bypassable.
 * The boundary is the serving room verifying a SIGNED grant (prx, Phase 2);
 * until then nothing forces a consumer to honor these caveats.
 *
 *   nix run nixpkgs#bun -- test tests/concierged.introduction.test.ts
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, unlinkSync } from "node:fs";
import { socketHandler, registry } from "../concierged.ts";
import { register, resolve } from "../lib/concierge.ts";
import { checkCaveats, type CaveatVerifiers } from "../guest-room/mod.ts";

const sockDir = `${process.env.HOME ?? "."}/.cache`;
const sockPath = `${sockDir}/cb-concierge-ocap-test.sock`;
let server: { stop: (c?: boolean) => void } | undefined;
let prevSock: string | undefined;

// A host verifier — shows the carried caveats are checkCaveats-shaped (Phase 2
// is where the serving room actually runs this over a VERIFIED signed grant).
const verifiers: CaveatVerifiers<{ hostname: string }> = {
  host: (value, ctx) =>
    value.split(",").map((s) => s.trim()).some((a) =>
      a.startsWith(".") ? ctx.hostname === a.slice(1) || ctx.hostname.endsWith(a) : ctx.hostname === a),
};

beforeAll(() => {
  mkdirSync(sockDir, { recursive: true });
  try { unlinkSync(sockPath); } catch { /* not present */ }
  server = Bun.listen({ unix: sockPath, socket: socketHandler }) as unknown as { stop: (c?: boolean) => void };
  prevSock = process.env.CONCIERGE_SOCK;
  process.env.CONCIERGE_SOCK = sockPath;
});

afterAll(() => {
  server?.stop(true);
  if (prevSock === undefined) delete process.env.CONCIERGE_SOCK;
  else process.env.CONCIERGE_SOCK = prevSock;
  try { unlinkSync(sockPath); } catch { /* gone */ }
});

beforeEach(() => {
  registry.length = 0;
});

describe("concierged introduction plumbing (live introducer, Phase 1)", () => {
  test("register → resolve roundtrips the provider's door over the socket", async () => {
    await register({ capability: "scout", door: "/run/scoutd.sock", env: "SCOUTD_SOCK", grants: "external reads", caveats: ["host=github.com,.github.com"] });
    const door = await resolve("scout");
    expect(door.name).toBe("scout");
    expect(door.guest).toEqual({ kind: "unix", path: "/run/scoutd.sock" });
    expect(door.env).toBe("SCOUTD_SOCK");
  });

  test("the introduced door's caveats are CARRIED and checkCaveats-shaped (plumbing, not a boundary)", async () => {
    await register({ capability: "scout", door: "/run/scoutd.sock", caveats: ["host=github.com,.github.com"] });
    const door = await resolve("scout");
    // The carried caveats are what a Phase-2 serving room would run over a
    // VERIFIED grant. Here we only show they're well-formed — Phase 1 does not
    // force any consumer to honor them (no signature, nothing verifies).
    expect(checkCaveats(door, { hostname: "api.github.com" }, verifiers).ok).toBe(true);
    expect(checkCaveats(door, { hostname: "evil.com" }, verifiers).ok).toBe(false);
  });

  test("want narrows the introduction further (never wider than the ceiling)", async () => {
    await register({ capability: "scout", door: "/run/scoutd.sock", caveats: ["host=github.com,.github.com"] });
    const door = await resolve("scout", ["mode=readonly"]);
    expect(door.caveats).toEqual(["host=github.com,.github.com", "mode=readonly"]);
  });

  test("resolving an unregistered capability is refused (fail closed)", async () => {
    await expect(resolve("nonexistent")).rejects.toThrow();
  });
});
