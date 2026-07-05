/**
 * Capability-contract validator (TS side).
 *
 * Asserts the TypeScript implementation — claude-box.ts `knownDoors()` and
 * launcherd.ts `ROOMS` — matches contract/capabilities.contract.json exactly,
 * and that the contract satisfies invariants I1-I4 (contract/INVARIANTS.md).
 * The Rust side has a mirror parity test (launcherd-rs doors.rs/rooms.rs). One
 * declarative source; both impls checked against it; drift → a red test on the
 * side that moved.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { knownDoors } from "../claude-box.ts";
import { ROOMS } from "../launcherd.ts";

type ContractDoor = {
  name: string;
  socket: string;
  env: string;
  mountable: boolean;
  bootRequired: boolean;
};
type ContractRoom = {
  name: string;
  doors: string[];
  dispatchable: boolean;
  netOpen?: boolean;
};
type Contract = {
  version: string;
  doors: ContractDoor[];
  autoDoors: string[];
  rooms: ContractRoom[];
  stores: { volume: string; writer: string; readers?: string[] }[];
};

const contract: Contract = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "contract", "capabilities.contract.json"), "utf8"),
);
const doorByName = new Map(contract.doors.map((d) => [d.name, d]));

describe("capability contract", () => {
  describe("doors ↔ knownDoors() parity", () => {
    test("same door names on both sides (no drift)", () => {
      const contractNames = contract.doors.map((d) => d.name).sort();
      const implNames = Object.keys(knownDoors()).sort();
      expect(contractNames).toEqual(implNames);
    });

    test("each contract door matches the knownDoors preset (socket path + env)", () => {
      const doors = knownDoors();
      for (const d of contract.doors) {
        const preset = doors[d.name];
        expect(preset, `knownDoors missing ${d.name}`).toBeDefined();
        expect(preset.inBox).toBe(`/run/doors/${d.socket}`);
        expect(preset.env).toBe(d.env);
      }
    });
  });

  describe("rooms ↔ ROOMS parity", () => {
    test("same room names on both sides (no drift)", () => {
      const contractNames = contract.rooms.map((r) => r.name).sort();
      const implNames = Object.keys(ROOMS).sort();
      expect(contractNames).toEqual(implNames);
    });

    test("each contract room matches ROOMS (doors, dispatchable, netOpen)", () => {
      for (const r of contract.rooms) {
        const room = ROOMS[r.name];
        expect(room, `ROOMS missing ${r.name}`).toBeDefined();
        expect(room.doors).toEqual(r.doors);
        expect(Boolean(room.dispatchable)).toBe(r.dispatchable);
        expect(Boolean(room.netOpen)).toBe(Boolean(r.netOpen));
      }
    });
  });

  describe("invariants", () => {
    test("I1 — every room door is a known door", () => {
      for (const r of contract.rooms) {
        for (const n of r.doors) {
          expect(doorByName.has(n), `room ${r.name} names unknown door ${n}`).toBe(true);
        }
      }
    });

    test("I2 — dispatchable rooms hold only mountable doors and never open ambient egress", () => {
      for (const r of contract.rooms) {
        if (!r.dispatchable) continue;
        expect(Boolean(r.netOpen), `dispatchable ${r.name} sets netOpen`).toBe(false);
        for (const n of r.doors) {
          expect(doorByName.get(n)?.mountable, `dispatchable ${r.name} holds non-mountable ${n}`).toBe(true);
        }
      }
    });

    test("I3 — autoDoors are mountable and known", () => {
      for (const n of contract.autoDoors) {
        expect(doorByName.get(n)?.mountable, `autoDoor ${n} not a mountable door`).toBe(true);
      }
    });

    test("I4 — boot-required doors are mountable", () => {
      for (const d of contract.doors) {
        if (d.bootRequired) expect(d.mountable, `boot-required ${d.name} not mountable`).toBe(true);
      }
    });

    test("I5 — each store has exactly one writer, distinct from its readers", () => {
      for (const s of contract.stores) {
        expect(typeof s.writer).toBe("string");
        expect(s.writer.length).toBeGreaterThan(0);
        expect(s.readers ?? []).not.toContain(s.writer);
      }
    });
  });
});
