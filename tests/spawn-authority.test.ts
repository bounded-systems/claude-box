// Object-anchored spawn authority (prx-8k08, supersedes prx-irs5).
//
// Two layers, both anchored on launcherd's OWN LaunchRecord (never client claims):
//  - ceiling/depth derived from the caller's record (forged _parentDoors/depth ignored);
//  - door REFERENCES passed from the parent's record — a child gets the parent's actual
//    socket + caveats, not a global name re-resolution, and can't re-point or invent one.
//
//   nix run nixpkgs#bun -- test tests/spawn-authority.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import {
  handleRequest,
  findCallerRecord,
  findLaunchByContainerId,
  containerIdFromCgroup,
  resolveLaunchDoors,
  __seedLaunch,
  __setCallerContainerId,
  __clearCallerContainerId,
} from "../launcherd";

afterEach(() => __clearCallerContainerId());
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

describe("caller classification — cgroup-anchored, fail-closed (prx-e232)", () => {
  test("findCallerRecord resolves a seeded launch by pid (fallback path)", () => {
    seed({ launchId: "L-x", pid: 7777 });
    expect(findCallerRecord(7777)?.launchId).toBe("L-x");
    expect(findCallerRecord(1)).toBeUndefined();
  });

  test("a container caller may only spawn doors its launch holds (forged request refused)", async () => {
    seed({ launchId: "L-a", containerId: "CIDA", doors: [door("scout", "/run/scoutd.sock")], depth: 1 });
    __setCallerContainerId("CIDA"); // caller resolves to L-a via its cgroup
    const resp = await launch({
        doors: ["keeper"], // L-a doesn't hold keeper
      depth: 0, // ignored — depth comes from the record
      _parentDoors: ["keeper", "scout"], // ignored — no client-trusted fallback anymore
      _caller: { uid: 1000, pid: 1 },
    });
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("ATTENUATION_VIOLATION"); // from resolveLaunchDoors
  });

  test("child depth is derived from the caller's record (depth limit enforced)", async () => {
    seed({ launchId: "L-b", containerId: "CIDB", doors: [door("scout", "/run/scoutd.sock")], depth: 3 });
    __setCallerContainerId("CIDB");
    const resp = await launch({
        doors: ["scout"],
      depth: 0, // lie — would pass if trusted
      _caller: { uid: 1000, pid: 1 },
    });
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("DEPTH_LIMIT"); // child depth 4 > max 3
  });

  test("a container caller launcherd did NOT launch is refused (fail closed)", async () => {
    __setCallerContainerId("CID-NOT-OURS");
    const resp = await launch({
        doors: ["scout"],
      _caller: { uid: 1000, pid: 1 },
    });
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("UNKNOWN_CALLER");
  });

  test("a non-container caller is the root mint — resolved globally, no attenuation/deny", async () => {
    __setCallerContainerId(undefined); // host operator: cgroup is not a libpod scope
    const resp = await launch({
        doors: ["scout"],
      _caller: { uid: 501, pid: 1 },
    });
    // not denied for attenuation or unknown-caller — it's the mint; it only fails
    // later trying to reach the real (absent) socket.
    expect(resp.error?.code).not.toBe("ATTENUATION_VIOLATION");
    expect(resp.error?.code).not.toBe("UNKNOWN_CALLER");
  });
});

describe("resolveLaunchDoors — reference-passing", () => {
  const parent = (doors: DoorGrant[]) =>
    ({ launchId: "P", pid: 9, startedAt: new Date(), doors, depth: 1 }) as unknown as Parameters<typeof __seedLaunch>[0];

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
      launchId: "L-c", pid: 11, containerId: CID,
      startedAt: new Date(), doors: [door("scout", "/run/scoutd.sock")], depth: 1,
    } as unknown as Parameters<typeof __seedLaunch>[0]);
    expect(findLaunchByContainerId(CID)?.launchId).toBe("L-c");
    expect(findLaunchByContainerId("0".repeat(64))).toBeUndefined();
  });
});
