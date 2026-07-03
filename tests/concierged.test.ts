/**
 * concierged tests — the capability concierge, including the new tcp
 * "bellhop" bootstrap-trust step (rooms).
 *
 * A unix caller is always trusted (the mounted socket IS authority, same as
 * every other door in this codebase). A tcp caller has no kernel peer
 * identity, so `resolve` over tcp is gated on a registered "room": the
 * launcher registers an audience/ROOM_ID, over ITS OWN local unix
 * connection, naming which capabilities that room may ever resolve. This is
 * an introduction ticket, not the capability itself — no door details cross
 * until resolve actually succeeds. `register`/`register-room`/`list` stay
 * unix-only entirely: a box (viaTcp) must never be able to announce a fake
 * provider, mint itself a room, or enumerate the registry.
 *
 *   nix run nixpkgs#bun -- test tests/concierged.test.ts
 */
import { test, expect, describe, beforeEach } from "bun:test";
import {
  handleRegister,
  handleRegisterRoom,
  handleResolve,
  handleList,
  registry,
  rooms,
} from "../concierged.ts";

beforeEach(() => {
  registry.length = 0;
  rooms.clear();
});

describe("register/list — unix-only", () => {
  test("register succeeds over unix (viaTcp=false, the default)", () => {
    const res = handleRegister({ capability: "repo", door: "/tmp/repod.sock" }) as { ttl: number };
    expect(res.ttl).toBeGreaterThan(0);
    expect(registry.length).toBe(1);
  });

  test("register is refused over tcp — a box can't announce a fake provider", () => {
    expect(() => handleRegister({ capability: "repo", door: "/tmp/evil.sock" }, true)).toThrow();
    expect(registry.length).toBe(0);
  });

  test("list is refused over tcp — a box can't enumerate the registry", () => {
    handleRegister({ capability: "repo", door: "/tmp/repod.sock" });
    expect(() => handleList({}, true)).toThrow();
  });

  test("list succeeds over unix", () => {
    handleRegister({ capability: "repo", door: "/tmp/repod.sock" });
    const res = handleList({}) as { capabilities: unknown[] };
    expect(res.capabilities.length).toBe(1);
  });
});

describe("register-room — unix-only, the tcp bootstrap-trust step", () => {
  test("a box (viaTcp) cannot register its own room", () => {
    expect(() => handleRegisterRoom({ roomId: "room-A", capabilities: ["repo"] }, true)).toThrow();
    expect(rooms.size).toBe(0);
  });

  test("the launcher (unix) can register a room scoped to specific capabilities", () => {
    const res = handleRegisterRoom({ roomId: "room-A", capabilities: ["repo"] }) as { ttl: number };
    expect(res.ttl).toBeGreaterThan(0);
    expect(rooms.get("room-A")?.capabilities.has("repo")).toBe(true);
  });

  test("rejects a room with no capabilities", () => {
    expect(() => handleRegisterRoom({ roomId: "room-A", capabilities: [] })).toThrow();
  });
});

describe("resolve — unix is unchanged; tcp is room-gated", () => {
  beforeEach(() => {
    handleRegister({ capability: "repo", door: "/tmp/repod.sock" });
  });

  test("unix resolve needs no room at all (existing behavior, untouched)", () => {
    const res = handleResolve({ capability: "repo", audience: "whoever" }) as { door: unknown };
    expect(res.door).toBeDefined();
  });

  test("tcp resolve with NO registered room → ROOM_UNKNOWN", () => {
    let error: { code?: string } | undefined;
    try {
      handleResolve({ capability: "repo", audience: "room-A" }, true);
    } catch (e) {
      error = e as { code?: string };
    }
    expect(error?.code).toBe("ROOM_UNKNOWN");
  });

  test("tcp resolve with a room NOT authorized for this capability → ROOM_NOT_AUTHORIZED", () => {
    handleRegisterRoom({ roomId: "room-A", capabilities: ["auth"] }); // wrong capability on purpose
    let error: { code?: string } | undefined;
    try {
      handleResolve({ capability: "repo", audience: "room-A" }, true);
    } catch (e) {
      error = e as { code?: string };
    }
    expect(error?.code).toBe("ROOM_NOT_AUTHORIZED");
  });

  test("tcp resolve with a room authorized for this exact capability succeeds", () => {
    handleRegisterRoom({ roomId: "room-A", capabilities: ["repo"] });
    const res = handleResolve({ capability: "repo", audience: "room-A" }, true) as { door: unknown };
    expect(res.door).toBeDefined();
  });

  test("tcp resolve with NO audience at all → ROOM_UNKNOWN (can't default to some other room)", () => {
    handleRegisterRoom({ roomId: "room-A", capabilities: ["repo"] });
    let error: { code?: string } | undefined;
    try {
      handleResolve({ capability: "repo" }, true);
    } catch (e) {
      error = e as { code?: string };
    }
    expect(error?.code).toBe("ROOM_UNKNOWN");
  });
});
