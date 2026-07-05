/**
 * Store single-writer enforcement (capability contract I5).
 *
 * The contract declares `stores[].writer` (one writer per volume). This test
 * makes I5 operational: it reads the actual Quadlet units and asserts the
 * deployment agrees — exactly one unit binds each store's volume *writable*, and
 * it is the declared writer. Plus: the writer unit carries the loud
 * single-writer ExecStartPre guard. Drift between contract, units, and the
 * single-writer rule → a red test.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const quadletDir = join(root, "quadlet");

const contract = JSON.parse(
  readFileSync(join(root, "contract", "capabilities.contract.json"), "utf8"),
) as { stores: { volume: string; writer: string; readers?: string[] }[] };

/** Read every Quadlet .container unit as { unitName (sans .container): body }. */
function containerUnits(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(quadletDir)) {
    if (f.endsWith(".container")) out[f.replace(/\.container$/, "")] = readFileSync(join(quadletDir, f), "utf8");
  }
  return out;
}

/** Units that bind `volume` WRITABLE (a `Volume=<volume>:...` without a `:ro`
 *  option). Comment lines are ignored. */
function writersOf(volume: string, units: Record<string, string>): string[] {
  const writers: string[] = [];
  for (const [name, body] of Object.entries(units)) {
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("#")) continue;
      const m = line.match(/^Volume=([^:]+):([^:]+)(?::(.*))?$/);
      if (!m || m[1] !== volume) continue;
      const opts = (m[3] ?? "").split(",");
      if (!opts.includes("ro")) writers.push(name);
    }
  }
  return writers;
}

describe("store single-writer (I5)", () => {
  const units = containerUnits();

  for (const store of contract.stores) {
    describe(`store ${store.volume}`, () => {
      test("exactly one Quadlet unit binds it writable", () => {
        expect(writersOf(store.volume, units)).toEqual([store.writer]);
      });

      test("the declared writer unit exists", () => {
        expect(units[store.writer], `no ${store.writer}.container`).toBeDefined();
      });

      test("readers do not bind the volume (they reach it through the writer)", () => {
        const binders = writersOf(store.volume, units);
        for (const reader of store.readers ?? []) {
          expect(binders).not.toContain(reader);
        }
      });

      test("the writer unit carries the loud single-writer guard (ExecStartPre)", () => {
        const body = units[store.writer] ?? "";
        expect(body).toContain("ExecStartPre=");
        expect(body).toMatch(/prx-dolt-data|single-writer/i);
      });
    });
  }
});
