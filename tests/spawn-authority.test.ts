// Object-anchored spawn authority (prx-8k08, supersedes prx-irs5).
//
// Two layers, both anchored on launcherd's OWN LaunchRecord (never client claims):
//  - ceiling/depth derived from the caller's record (forged _parentDoors/depth ignored);
//  - door REFERENCES passed from the parent's record — a child gets the parent's actual
//    socket + caveats, not a global name re-resolution, and can't re-point or invent one.
//
//   nix run nixpkgs#bun -- test tests/spawn-authority.test.ts
import { describe, test, expect } from "bun:test";
import { handleRequest, findCallerRecord, resolveLaunchDoors, __seedLaunch } from "../launcherd";
import { unix, type DoorGrant } from "../guest-room/mod.ts";

const door = (name: string, hostPath: string): DoorGrant => ({
  name,
  host: unix(hostPath),
  guest: unix(`/run/doors/${name}d.sock`),
  env: `${name.toUpperCase()}_SOCK`,
  grants: `${name} access`,
  use: `use ${name}`,
});

const seed = (over: Record<string, unknown> = {}) => {
  const rec = {
    launchId: "L-parent",
    account: "personal",
    pid: 4242,
    startedAt: new Date(),
    doors: [door("scout", "/run/scoutd.sock")],
    depth: 1,
    ...over,
  };
  __seedLaunch(rec as unknown as Parameters<typeof __seedLaunch>[0]);
  return rec;
};
const launch = (params: Record<string, unknown>) =>
  handleRequest(JSON.stringify({ id: "1", method: "launch", params }));

describe("caller-record-derived ceiling + depth", () => {
  test("findCallerRecord resolves a seeded launch by pid", () => {
    seed({ launchId: "L-x", pid: 7777 });
    expect(findCallerRecord(7777)?.launchId).toBe("L-x");
    expect(findCallerRecord(1)).toBeUndefined();
  });

  test("child requesting a door the caller lacks is denied — forged _parentDoors ignored", async () => {
    seed({ pid: 4242, doors: [door("scout", "/run/scoutd.sock")], depth: 1 });
    const resp = await launch({
      account: "personal",
      doors: ["keeper"], // not held by the caller
      depth: 0, // lie
      _parentDoors: ["keeper", "scout"], // lie — claims keeper
      _caller: { uid: 1000, pid: 4242 },
    });
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("ATTENUATION_VIOLATION");
  });

  test("depth is derived from the caller's record, not the client value", async () => {
    seed({ pid: 4243, doors: [door("scout", "/run/scoutd.sock")], depth: 3 }); // at maxDepth
    const resp = await launch({
      account: "personal",
      doors: ["scout"],
      depth: 0, // lie
      _caller: { uid: 1000, pid: 4243 },
    });
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("DEPTH_LIMIT"); // child depth 4 > max 3
  });
});

describe("resolveLaunchDoors — reference-passing", () => {
  const parent = (doors: DoorGrant[]) =>
    ({ launchId: "P", account: "personal", pid: 9, startedAt: new Date(), doors, depth: 1 }) as unknown as Parameters<typeof __seedLaunch>[0];

  test("a child gets the PARENT's actual socket, not a global default", () => {
    const out = resolveLaunchDoors(["scout"], parent([door("scout", "/custom/scoutd.sock")]));
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("scout");
    expect((out[0]!.host as { path: string }).path).toBe("/custom/scoutd.sock");
  });

  test("a door the parent doesn't hold is refused", () => {
    let err: { code?: string } | undefined;
    try {
      resolveLaunchDoors(["keeper"], parent([door("scout", "/run/scoutd.sock")]));
    } catch (e) {
      err = e as { code?: string };
    }
    expect(err?.code).toBe("ATTENUATION_VIOLATION");
  });

  test("a name=host override is ignored for a child (can't re-point a door)", () => {
    const out = resolveLaunchDoors(["scout=/evil/sock"], parent([door("scout", "/parent/scoutd.sock")]));
    expect((out[0]!.host as { path: string }).path).toBe("/parent/scoutd.sock");
  });

  test("the parent's caveats ride along (delegated, never widened)", () => {
    const narrowed: DoorGrant = { ...door("scout", "/p/scoutd.sock"), caveats: ["host=github.com"] };
    const out = resolveLaunchDoors(["scout"], parent([narrowed]));
    expect(out[0]!.caveats).toEqual(["host=github.com"]);
  });

  test("root launch (no caller record) resolves names globally", () => {
    const out = resolveLaunchDoors(["scout"], undefined);
    expect(out[0]!.name).toBe("scout"); // global door catalog, the root mint
  });
});
