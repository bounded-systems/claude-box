// Object-anchored spawn authority (prx-8k08, supersedes prx-irs5).
//
// Two layers, both anchored on launcherd's OWN LaunchRecord (never client claims):
//  - ceiling/depth derived from the caller's record (forged _parentDoors/depth ignored);
//  - door REFERENCES passed from the parent's record — a child gets the parent's actual
//    socket + caveats, not a global name re-resolution, and can't re-point or invent one.
//
//   nix run nixpkgs#bun -- test tests/spawn-authority.test.ts
import { describe, test, expect } from "bun:test";
import {
  handleRequest,
  findCallerRecord,
  findLaunchByContainerId,
  containerIdFromCgroup,
  resolveLaunchDoors,
  __seedLaunch,
} from "../launcherd";
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

describe("cgroup correlation — caller pid → container (prx-p4vb)", () => {
  // Real podman cgroup line shape (verified in the podman VM): the container Id
  // sits in `libpod-<64hex>.scope`, == `podman inspect .Id`.
  const CID = "155a4fee5fc5cc950e1ecdfb08b0341f889eedba4f323cf3a21f7b601051ab74";
  const cgroup = `0::/user.slice/user-501.slice/user@501.service/user.slice/libpod-${CID}.scope/container\n`;

  test("containerIdFromCgroup extracts the podman container Id", () => {
    expect(containerIdFromCgroup(cgroup)).toBe(CID);
  });

  test("returns undefined for a non-podman cgroup", () => {
    expect(containerIdFromCgroup("0::/system.slice/sshd.service\n")).toBeUndefined();
  });

  test("findLaunchByContainerId matches the recorded container — the real-box correlation", () => {
    __seedLaunch({
      launchId: "L-c", account: "personal", pid: 11, containerId: CID,
      startedAt: new Date(), doors: [door("scout", "/run/scoutd.sock")], depth: 1,
    } as unknown as Parameters<typeof __seedLaunch>[0]);
    expect(findLaunchByContainerId(CID)?.launchId).toBe("L-c");
    expect(findLaunchByContainerId("0".repeat(64))).toBeUndefined();
  });
});
