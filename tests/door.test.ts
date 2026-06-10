/**
 * door / capability-surface tests (the OCAP surface) — pure unit tests over the
 * launcher's door registry + manifest. No podman needed: they assert that the
 * box KNOWS what it can and can't do, and that the surface is generated from the
 * actual grants (so it can't drift, the way `--keeper` once did).
 *
 *   nix run nixpkgs#bun -- test tests/door.test.ts
 */
import { test, expect } from "bun:test";
import {
  resolveDoor,
  planLaunch,
  buildManifest,
  capabilityJson,
  capabilityPrompt,
} from "../claude-box.ts";

const EMPTY = {} as Record<string, string | undefined>;

// ── one generic primitive, named presets over it ──
test("preset door: --keeper resolves to the canonical keeperd door", () => {
  const d = resolveDoor("keeper", undefined, EMPTY);
  expect(d.inBox).toBe("/run/keeperd.sock");
  expect(d.env).toBe("KEEPERD_SOCK");
  expect(d.host).toBe("/tmp/keeperd.sock");
});

test("preset host socket is overridable via env (same launch, any transport)", () => {
  const d = resolveDoor("keeper", undefined, { KEEPERD_SOCK: "/relay/k.sock" });
  expect(d.host).toBe("/relay/k.sock");
  expect(d.inBox).toBe("/run/keeperd.sock"); // the box's contract is fixed
});

test("generic door: any service attaches by socket, deriving path + env", () => {
  const d = resolveDoor("dolt", undefined, EMPTY);
  expect(d.inBox).toBe("/run/dolt.sock");
  expect(d.env).toBe("DOLT_SOCK");
  expect(d.host).toBe("/tmp/dolt.sock");
});

test("generic door honors an explicit host socket (NAME=HOST)", () => {
  const d = resolveDoor("dolt", "/var/run/dolt.sock", EMPTY);
  expect(d.host).toBe("/var/run/dolt.sock");
});

test("door names are validated (no path injection into the mount)", () => {
  expect(() => resolveDoor("../escape", undefined, EMPTY)).toThrow();
  expect(() => resolveDoor("a/b", undefined, EMPTY)).toThrow();
});

// ── launch planning: claude-box flags vs claude passthrough ──
test("planLaunch separates doors/repo from claude args", () => {
  const l = planLaunch(["--keeper", "--repo", ".", "--door", "dolt=/var/run/dolt.sock", "--resume"], EMPTY);
  expect(l.repo).toBe(".");
  expect(l.claudeArgs).toEqual(["--resume"]);
  expect(l.doors.map((d) => d.name).sort()).toEqual(["dolt", "keeper"]);
  expect(l.doors.find((d) => d.name === "dolt")!.host).toBe("/var/run/dolt.sock");
});

// ── the honest surface: granted AND denied, from the actual grants ──
test("manifest is honest about what is denied, not just granted", () => {
  const m = buildManifest("work", planLaunch(["--keeper"], EMPTY), EMPTY);
  expect(m.doors.map((d) => d.name)).toEqual(["keeper"]);
  expect(m.denied.map((d) => d.name)).toContain("beads"); // not granted ⇒ explicitly denied
});

test("a no-grant box still names its denials (knows what it cannot do)", () => {
  const m = buildManifest("personal", planLaunch([], EMPTY), EMPTY);
  expect(m.doors).toEqual([]);
  expect(m.denied.map((d) => d.name).sort()).toEqual(["beads", "keeper"]);
});

test("injected prompt states authority is EXACTLY the granted set", () => {
  const prompt = capabilityPrompt(buildManifest("work", planLaunch(["--keeper"], EMPTY), EMPTY));
  expect(prompt).toContain("EXACTLY");
  expect(prompt).toContain("GRANTED:");
  expect(prompt).toMatch(/keeper:.*keeperd/); // how to translate this symbol
  expect(prompt).toMatch(/DENIED[\s\S]*beads/); // and the symbols with no rule
});

test("machine-readable surface (for prx tool-gating) reflects the grants", () => {
  const json = JSON.parse(capabilityJson(buildManifest("work", planLaunch(["--keeper", "--repo", "."], EMPTY), EMPTY)));
  expect(json.workcell).toBe("claude-box");
  expect(json.granted.repo).toBe(".");
  expect(json.granted.doors[0]).toMatchObject({ name: "keeper", socket: "/run/keeperd.sock", env: "KEEPERD_SOCK" });
  expect(json.denied.map((d: { name: string }) => d.name)).toContain("beads");
});
