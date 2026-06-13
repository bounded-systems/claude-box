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
  knownRooms,
  planLaunch,
  buildManifest,
  capabilityJson,
  capabilityPrompt,
} from "../claude-box.ts";

// Test env with a fake HOME (required for socket path resolution)
const EMPTY = { HOME: "/tmp" } as Record<string, string | undefined>;

// ── one generic primitive, named presets over it ──
test("preset door: --keeper resolves to the canonical keeperd door", () => {
  const d = resolveDoor("keeper", undefined, EMPTY);
  expect(d.inBox).toBe("/run/keeperd.sock");
  expect(d.env).toBe("KEEPERD_SOCK");
  expect(d.host).toBe("/tmp/.claude-box/run/keeperd.sock");
});

test("preset door: --scout resolves to the canonical scoutd read door", () => {
  const d = resolveDoor("scout", undefined, EMPTY);
  expect(d.inBox).toBe("/run/scoutd.sock");
  expect(d.env).toBe("SCOUTD_SOCK");
  expect(d.host).toBe("/tmp/.claude-box/run/scoutd.sock");
});

test("--scout grants the scout read door (content, not credential)", () => {
  const m = buildManifest("work", planLaunch(["--scout"], EMPTY), EMPTY);
  expect(m.doors.map((d) => d.name)).toContain("scout");
  // a box can read external artifacts AND still have no network (scout ≠ netd)
  expect(JSON.parse(capabilityJson(m)).network).toBe("none");
});

test("preset host socket is overridable via env (same launch, any transport)", () => {
  const d = resolveDoor("keeper", undefined, { HOME: "/tmp", KEEPERD_SOCK: "/relay/k.sock" });
  expect(d.host).toBe("/relay/k.sock");
  expect(d.inBox).toBe("/run/keeperd.sock"); // the box's contract is fixed
});

test("generic door: any service attaches by socket, deriving path + env", () => {
  const d = resolveDoor("dolt", undefined, EMPTY);
  expect(d.inBox).toBe("/run/dolt.sock");
  expect(d.env).toBe("DOLT_SOCK");
  // Generic doors use library's defaultHostSock which falls back to /tmp
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

// ── rooms: named door bundles, the layer above presets ──
test("--room dev expands to its door bundle (keeper + net + scout)", () => {
  const l = planLaunch(["--room", "dev"], EMPTY);
  expect(l.doors.map((d) => d.name).sort()).toEqual(["keeper", "net", "scout"]);
});

test("--room read is reads-only: scout door, still no network", () => {
  const m = buildManifest("work", planLaunch(["--room", "read"], EMPTY), EMPTY);
  expect(m.doors.map((d) => d.name)).toEqual(["scout"]);
  expect(JSON.parse(capabilityJson(m)).network).toBe("none"); // scout ≠ a NIC
});

test("flags compose over a room (add a door, dedup the overlap)", () => {
  const l = planLaunch(["--room", "read", "--keeper", "--scout", "--resume"], EMPTY);
  expect(l.doors.map((d) => d.name).sort()).toEqual(["keeper", "scout"]); // scout not doubled
  expect(l.claudeArgs).toEqual(["--resume"]);
});

test("every room references only known doors (no drift from the registry)", () => {
  const doorNames = new Set(["keeper", "beads", "scout", "net"]);
  for (const room of Object.values(knownRooms())) {
    for (const d of room.doors) expect(doorNames.has(d)).toBe(true);
  }
});

test("an unknown room is refused (fail closed, not a silent empty launch)", () => {
  expect(() => planLaunch(["--room", "nope"], EMPTY)).toThrow(/unknown room/);
});

// ── --repo is safe-by-default: .git read-only (writes via keeper); --repo-rw escapes ──
test("--repo defaults to read-only .git; --repo-rw is the unsafe escape", () => {
  const ro = buildManifest("work", planLaunch(["--repo", "."], EMPTY), EMPTY);
  expect(ro.repo).toBe(".");
  expect(ro.repoRw).toBe(false);
  expect(JSON.parse(capabilityJson(ro)).granted.repoGit).toBe("ro");
  expect(capabilityPrompt(ro)).toMatch(/\.git is READ-ONLY/);

  const rw = buildManifest("work", planLaunch(["--repo-rw", "."], EMPTY), EMPTY);
  expect(rw.repo).toBe(".");
  expect(rw.repoRw).toBe(true);
  expect(JSON.parse(capabilityJson(rw)).granted.repoGit).toBe("rw");
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
  expect(m.denied.map((d) => d.name).sort()).toEqual(["beads", "keeper", "launcher", "net", "scout"]);
});

// ── network is a door, with launch effects ──
test("preset door: --net resolves to the canonical netd door", () => {
  const d = resolveDoor("net", undefined, EMPTY);
  expect(d.inBox).toBe("/run/netd.sock");
  expect(d.env).toBe("NETD_SOCK");
  expect(d.host).toBe("/tmp/.claude-box/run/netd.sock"); // default; run() fails closed on world-writable dirs
});

test("--net grants the net door; default posture is no network", () => {
  const granted = buildManifest("work", planLaunch(["--net"], EMPTY), EMPTY);
  expect(granted.doors.map((d) => d.name)).toContain("net");
  expect(JSON.parse(capabilityJson(granted)).network).toBe("policed");

  const none = buildManifest("work", planLaunch([], EMPTY), EMPTY);
  expect(JSON.parse(capabilityJson(none)).network).toBe("none");
  expect(none.denied.map((d) => d.name)).toContain("net"); // honest: no network
});

test("--net-open opens egress WITHOUT a door, and the manifest says so", () => {
  const m = buildManifest("work", planLaunch(["--net-open"], EMPTY), EMPTY);
  expect(m.doors.map((d) => d.name)).not.toContain("net"); // no door granted
  expect(m.denied.map((d) => d.name)).not.toContain("net"); // but NOT denied — network is open
  expect(JSON.parse(capabilityJson(m)).network).toBe("open");
  expect(capabilityPrompt(m)).toMatch(/UNRESTRICTED ambient egress/);
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

// ── launcher door (spawn sub-boxes) ──
test("preset door: --launcher resolves to the canonical launcherd door", () => {
  const d = resolveDoor("launcher", undefined, EMPTY);
  expect(d.inBox).toBe("/run/launcherd.sock");
  expect(d.env).toBe("LAUNCHERD_SOCK");
  expect(d.host).toBe("/tmp/.claude-box/run/launcherd.sock");
});

test("--launcher grants spawn authority and is reflected in manifest", () => {
  const m = buildManifest("work", planLaunch(["--launcher"], EMPTY), EMPTY);
  expect(m.doors.map((d) => d.name)).toContain("launcher");
  expect(m.denied.map((d) => d.name)).not.toContain("launcher");
  expect(capabilityPrompt(m)).toMatch(/launcher:.*spawn sub-boxes/i);
});

test("without --launcher, spawn is explicitly denied", () => {
  const m = buildManifest("work", planLaunch([], EMPTY), EMPTY);
  expect(m.doors.map((d) => d.name)).not.toContain("launcher");
  expect(m.denied.map((d) => d.name)).toContain("launcher");
  expect(capabilityPrompt(m)).toMatch(/launcher:.*No spawn authority/i);
});

// ── --repo-ephemeral: parallel-safe ephemeral worktrees ──
test("--repo-ephemeral sets the repoEphemeral flag", () => {
  const l = planLaunch(["--repo-ephemeral", "."], EMPTY);
  expect(l.repo).toBe(".");
  expect(l.repoEphemeral).toBe(true);
  expect(l.repoRw).toBe(false); // still read-only .git
});

test("--repo-ephemeral manifest reflects ephemeral mode", () => {
  const m = buildManifest("work", planLaunch(["--repo-ephemeral", "."], EMPTY), EMPTY);
  expect(m.repo).toBe(".");
  expect(m.repoEphemeral).toBe(true);
  expect(m.repoRw).toBe(false);
  const json = JSON.parse(capabilityJson(m));
  expect(json.granted.repoEphemeral).toBe(true);
  expect(json.granted.repoGit).toBe("ro"); // still read-only
});

test("--repo-ephemeral prompt describes isolated copy", () => {
  const prompt = capabilityPrompt(buildManifest("work", planLaunch(["--repo-ephemeral", "."], EMPTY), EMPTY));
  expect(prompt).toMatch(/EPHEMERAL worktree/);
  expect(prompt).toMatch(/isolated copy/);
  expect(prompt).toMatch(/\.git is READ-ONLY/);
});

test("regular --repo does not set repoEphemeral", () => {
  const l = planLaunch(["--repo", "."], EMPTY);
  expect(l.repo).toBe(".");
  expect(l.repoEphemeral).toBe(false);
  const m = buildManifest("work", l, EMPTY);
  expect(JSON.parse(capabilityJson(m)).granted.repoEphemeral).toBe(false);
});
