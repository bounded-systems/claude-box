/**
 * guest-room behavior specs — the .feature files in ./features executed against
 * the real engine (guest-room/mod.ts). Each Scenario becomes a `bun test`, so
 * the documentation can't drift from the code: describe behavior the engine
 * lacks and the suite goes red.
 *
 *   bun test guest-room/guest-room.test.ts
 *
 * The fixture catalog below is a deliberately NON-Claude hotel: it proves the
 * engine resolves doors, opens rooms, and renders the rulebook for ANY guest —
 * the whole point of the extraction (the room doesn't know who's staying).
 */
import { describe, test } from "bun:test";
import { expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import {
  type DoorCatalog,
  type DoorGrant,
  type Env,
  type RoomCatalog,
  resolveDoor,
  expandRoom,
  deniedDoors,
  grantedDoorLines,
  deniedDoorSection,
} from "./mod.ts";
import { parseFeature, StepRegistry, type World } from "./gherkin.ts";

const env: Env = {};

// A fixture hotel — same SHAPE as claude-box's catalog, none of its identity.
const catalog: DoorCatalog = {
  keeper: {
    flag: "--keeper", inBox: "/run/keeperd.sock", env: "KEEPERD_SOCK",
    hostDefault: "/tmp/keeperd.sock", grants: "signed git writes via keeperd",
    use: "Route every git write through the keeper door.",
    deny: "No git-write authority here; relaunch with --keeper.",
  },
  net: {
    flag: "--net", inBox: "/run/netd.sock", env: "NETD_SOCK",
    hostDefault: "/tmp/netd.sock", grants: "policed egress via the netd allowlist",
    use: "All egress goes through the net door.",
    deny: "No network here; relaunch with --net.",
  },
  scout: {
    flag: "--scout", inBox: "/run/scoutd.sock", env: "SCOUTD_SOCK",
    hostDefault: "/tmp/scoutd.sock", grants: "external reads via scoutd",
    use: "Read external content through the scout door.",
    deny: "No external reads here; relaunch with --scout.",
  },
};

const rooms: RoomCatalog = {
  dev: { doors: ["keeper", "net", "scout"], about: "edit, commit, read & policed egress" },
  read: { doors: ["scout"], about: "external reads only" },
};

const grantNames = (w: World) => new Set((w.grants as DoorGrant[]).map((d) => d.name));
const suppressOf = (w: World) => (w.suppress as Set<string>) ?? new Set<string>();

const steps = new StepRegistry()
  .step(/^the hotel's door catalog$/, (w) => { w.catalog = catalog; })
  .step(/^the hotel's door catalog and rooms$/, (w) => { w.catalog = catalog; w.rooms = rooms; })

  // resolve a single door (success or refusal captured into the world)
  .step(/^the room resolves the "([^"]*)" door$/, (w, name) => {
    try { w.grant = resolveDoor(w.catalog as DoorCatalog, name, undefined, env); w.error = undefined; }
    catch (e) { w.error = e; }
  })
  .step(/^its in-room socket is "([^"]*)"$/, (w, sock) => {
    expect((w.grant as DoorGrant).inBox).toBe(sock);
  })
  .step(/^the room reaches it via the "([^"]*)" env var$/, (w, envVar) => {
    expect((w.grant as DoorGrant).env).toBe(envVar);
  })
  .step(/^resolution is refused$/, (w) => { expect(w.error).toBeInstanceOf(Error); })

  // open a room (a bundle of adjoining doors)
  .step(/^the room "([^"]*)" is opened$/, (w, name) => {
    w.suppress = new Set<string>();
    try { w.grants = expandRoom(w.rooms as RoomCatalog, w.catalog as DoorCatalog, name, env); w.error = undefined; }
    catch (e) { w.error = e; w.grants = []; }
  })
  .step(/^the room "([^"]*)" is opened with "([^"]*)" suppressed$/, (w, name, supp) => {
    w.suppress = new Set([supp]);
    w.grants = expandRoom(w.rooms as RoomCatalog, w.catalog as DoorCatalog, name, env);
  })
  .step(/^the open doors are "([^"]*)"$/, (w, list) => {
    const want = list.split(",").map((s) => s.trim()).sort();
    expect([...(w.grants as DoorGrant[])].map((d) => d.name).sort()).toEqual(want);
  })
  .step(/^opening is refused$/, (w) => { expect(w.error).toBeInstanceOf(Error); })

  // the rulebook the room hands its guest
  .step(/^the rulebook grants mention "([^"]*)"$/, (w, name) => {
    expect(grantedDoorLines(w.grants as DoorGrant[]).join("\n")).toContain(name);
  })
  .step(/^the rulebook denies "([^"]*)"$/, (w, name) => {
    const denied = deniedDoors(w.catalog as DoorCatalog, grantNames(w), suppressOf(w));
    expect(deniedDoorSection(denied).join("\n")).toContain(name);
  })
  .step(/^the rulebook does not deny "([^"]*)"$/, (w, name) => {
    const denied = deniedDoors(w.catalog as DoorCatalog, grantNames(w), suppressOf(w));
    expect(denied.map((d) => d.name)).not.toContain(name);
  });

// Discover and register every feature. Synchronous I/O (node:fs) so bun
// registers the tests during module evaluation.
const featuresDir = `${import.meta.dir}/features`;
for (const file of readdirSync(featuresDir).filter((f) => f.endsWith(".feature")).sort()) {
  const feature = parseFeature(readFileSync(`${featuresDir}/${file}`, "utf8"));
  describe(`${feature.name} (${file})`, () => {
    for (const scenario of feature.scenarios) {
      test(scenario.name, async () => { await steps.run(scenario); });
    }
  });
}
