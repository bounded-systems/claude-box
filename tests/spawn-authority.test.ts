// Object-anchored spawn authority (prx-8k08, supersedes prx-irs5).
//
// A spawning box's child ceiling + depth come from the CALLER'S OWN LaunchRecord
// (what launcherd actually granted it, looked up by the peercred caller pid),
// NOT from client-sent params. An in-box caller therefore can't forge a wider
// _parentDoors or a smaller depth to escape attenuation/depth limits. When no
// record matches (host-operator root launch), it falls back to client values —
// today's behavior — so a matched caller is only ever hardened.
//
//   nix run nixpkgs#bun -- test tests/spawn-authority.test.ts
import { describe, test, expect } from "bun:test";
import { handleRequest, findCallerRecord, __seedLaunch } from "../launcherd";

// Partial seed records carry only the fields the caller lookup reads
// (launchId/pid/doors/depth); cast past the full LaunchRecord type for the test.
const seed = (over: Record<string, unknown> = {}) => {
  const rec = {
    launchId: "L-parent",
    account: "personal",
    pid: 4242,
    startedAt: new Date(),
    doors: ["scout"],
    depth: 1,
    ...over,
  };
  __seedLaunch(rec as unknown as Parameters<typeof __seedLaunch>[0]);
  return rec;
};
const launch = (params: Record<string, unknown>) =>
  handleRequest(JSON.stringify({ id: "1", method: "launch", params }));

describe("object-anchored spawn authority", () => {
  test("findCallerRecord resolves a seeded launch by pid", () => {
    seed({ launchId: "L-x", pid: 7777 });
    expect(findCallerRecord(7777)?.launchId).toBe("L-x");
    expect(findCallerRecord(1)).toBeUndefined();
  });

  test("child requesting a door the caller's RECORD lacks is denied — client _parentDoors lie ignored", async () => {
    seed({ pid: 4242, doors: ["scout"], depth: 1 });
    const resp = await launch({
      account: "personal",
      doors: ["keeper"], // NOT in the caller's real doors
      depth: 0, // lie (caller is depth 1)
      _parentDoors: ["keeper", "scout"], // lie — claims it holds keeper
      _caller: { uid: 1000, pid: 4242 },
    });
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("ATTENUATION_VIOLATION");
  });

  test("a door the caller DOES hold is allowed through attenuation (depth derived = 2)", async () => {
    seed({ pid: 4242, doors: ["scout", "keeper"], depth: 1 });
    const resp = await launch({
      account: "personal",
      doors: ["scout"], // ⊆ caller's real doors
      _caller: { uid: 1000, pid: 4242 },
    });
    // Passes attenuation + depth; only fails later trying to actually spawn a
    // box in the test env — so it must NOT be an attenuation/depth denial.
    expect(resp.error?.code).not.toBe("ATTENUATION_VIOLATION");
    expect(resp.error?.code).not.toBe("DEPTH_LIMIT");
  });

  test("depth is derived from the caller's record, not the client value", async () => {
    seed({ pid: 4243, doors: ["scout"], depth: 3 }); // already at default maxDepth
    const resp = await launch({
      account: "personal",
      doors: ["scout"],
      depth: 0, // lie — would pass if trusted
      _caller: { uid: 1000, pid: 4243 },
    });
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("DEPTH_LIMIT"); // child depth 4 > max 3
  });
});
