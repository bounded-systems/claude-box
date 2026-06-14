/**
 * guest-room tests — the guest-agnostic capability engine.
 *
 * Tests the core OCAP abstractions: door grants, attenuation, and rulebook
 * rendering. These are pure functions with no I/O.
 *
 *   nix run nixpkgs#bun -- test tests/guest-room.test.ts
 */
import { test, expect, describe } from "bun:test";
import {
  attenuate,
  parseCaveat,
  grantedDoorLines,
  unix,
  type DoorGrant,
} from "../guest-room/mod.ts";

const makeDoor = (name: string, caveats?: string[]): DoorGrant => ({
  name,
  host: unix(`/tmp/${name}.sock`),
  guest: unix(`/run/${name}.sock`),
  env: `${name.toUpperCase()}_SOCK`,
  grants: `${name} capability`,
  use: `Use ${name} via the socket.`,
  caveats,
});

describe("attenuate", () => {
  test("returns same grant if no caveats added", () => {
    const door = makeDoor("net");
    const result = attenuate(door, []);
    expect(result).toBe(door); // same reference, no copy
  });

  test("adds caveats to a door without existing caveats", () => {
    const door = makeDoor("net");
    const result = attenuate(door, ["host=github.com"]);
    expect(result.caveats).toEqual(["host=github.com"]);
    expect(door.caveats).toBeUndefined(); // original unchanged
  });

  test("appends caveats to existing caveats", () => {
    const door = makeDoor("net", ["host=api.anthropic.com"]);
    const result = attenuate(door, ["host=github.com"]);
    expect(result.caveats).toEqual(["host=api.anthropic.com", "host=github.com"]);
    expect(door.caveats).toEqual(["host=api.anthropic.com"]); // original unchanged
  });

  test("is append-only: caveats can only narrow, never widen", () => {
    const narrow = attenuate(makeDoor("net"), ["host=github.com"]);
    const narrower = attenuate(narrow, ["host=api.github.com"]);
    // Both caveats present — the daemon enforces the intersection
    expect(narrower.caveats).toEqual(["host=github.com", "host=api.github.com"]);
  });
});

describe("parseCaveat", () => {
  test("parses k=v format", () => {
    expect(parseCaveat("host=github.com")).toEqual({ key: "host", value: "github.com" });
  });

  test("parses k:v format", () => {
    expect(parseCaveat("host:github.com")).toEqual({ key: "host", value: "github.com" });
  });

  test("prefers = over : when both present", () => {
    expect(parseCaveat("host=foo:bar")).toEqual({ key: "host", value: "foo:bar" });
  });

  test("returns null for invalid caveats", () => {
    expect(parseCaveat("no-separator")).toBeNull();
    expect(parseCaveat("")).toBeNull();
    expect(parseCaveat("=value-without-key")).toBeNull();
  });
});

describe("grantedDoorLines", () => {
  test("renders door without caveats", () => {
    const lines = grantedDoorLines([makeDoor("net")]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("net:");
    expect(lines[0]).not.toContain("RESTRICTED");
  });

  test("renders door with caveats as RESTRICTED", () => {
    const door = makeDoor("net", ["host=github.com"]);
    const lines = grantedDoorLines([door]);
    expect(lines[0]).toContain("RESTRICTED to: host=github.com");
  });

  test("renders multiple caveats semicolon-separated", () => {
    const door = makeDoor("net", ["host=github.com", "host=api.anthropic.com"]);
    const lines = grantedDoorLines([door]);
    expect(lines[0]).toContain("RESTRICTED to: host=github.com; host=api.anthropic.com");
  });
});
