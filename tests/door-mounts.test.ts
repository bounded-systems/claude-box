/**
 * door-mounts tests (prx-sfr0) — the capability BOUNDARY is the set of door
 * sockets mounted into the box, so it must be VERIFIED, not eyeballed.
 *
 * The box used to bind-mount the whole run dir (`${runDir}:/run/doors`), exposing
 * EVERY daemon socket regardless of grant; the per-door env vars were only hints.
 * planDoorMounts now mounts each granted socket individually — the mounted set IS
 * the capability set. These tests assert a partially-granted box has NO mount
 * path to the doors it wasn't granted (on the unix transport the held reference
 * IS the authority — see ADR-CAPABILITY-TRANSPORT).
 *
 *   nix run nixpkgs#bun -- test tests/door-mounts.test.ts
 */
import { test, expect } from "bun:test";
import { planDoorMounts, resolveDoor } from "../claude-box.ts";

// Deterministic host socket paths via XDG_RUNTIME_DIR; unix (not TCP) mode.
const UNIX_ENV = { XDG_RUNTIME_DIR: "/run/test-doors" };
const TCP_ENV = { XDG_RUNTIME_DIR: "/run/test-doors", DOORS_TCP: "1" };

const grants = (names: string[], env: Record<string, string>) =>
  names.map((n) => resolveDoor(n, undefined, env));

test("scout-only box: only the scout socket is mounted", () => {
  const argv = planDoorMounts(grants(["scout"], UNIX_ENV), false);
  const mounts = argv.filter((_, i) => argv[i - 1] === "-v");
  expect(mounts).toEqual(["/run/test-doors/scoutd.sock:/run/doors/scoutd.sock"]);
});

test("scout-only box: NO mount path to keeperd / netd / launcherd", () => {
  const argv = planDoorMounts(grants(["scout"], UNIX_ENV), false).join(" ");
  // The whole point of prx-sfr0: a non-granted door is physically absent.
  expect(argv).not.toContain("keeperd.sock");
  expect(argv).not.toContain("netd.sock");
  expect(argv).not.toContain("launcherd.sock");
});

test("multi-grant box: mounts exactly the granted doors, nothing more", () => {
  const argv = planDoorMounts(grants(["keeper", "scout"], UNIX_ENV), false);
  const mounts = argv.filter((_, i) => argv[i - 1] === "-v").sort();
  expect(mounts).toEqual([
    "/run/test-doors/keeperd.sock:/run/doors/keeperd.sock",
    "/run/test-doors/scoutd.sock:/run/doors/scoutd.sock",
  ]);
  // net was NOT granted → no path to it.
  expect(argv.join(" ")).not.toContain("netd.sock");
});

test("each granted door still gets its env var pointed at the guest path", () => {
  const argv = planDoorMounts(grants(["scout"], UNIX_ENV), false);
  const envIdx = argv.indexOf("--env");
  expect(argv[envIdx + 1]).toBe("SCOUTD_SOCK=/run/doors/scoutd.sock");
});

test("no-grant box: no mounts and no door env at all", () => {
  expect(planDoorMounts([], false)).toEqual([]);
});

test("TCP mode: no socket mounts (door rides the host gateway), env only", () => {
  const argv = planDoorMounts(grants(["scout"], TCP_ENV), true);
  expect(argv).not.toContain("-v"); // nothing bind-mounted
  expect(argv.some((a) => a.startsWith("SCOUTD_SOCK="))).toBe(true);
});

test("TCP mode: the env value is a bare host:port, NOT tcp:host:port", () => {
  // door-kit's call()/connectTarget parses a bare "host:port" (or a "unix://"-
  // /leading-"/" path); a "tcp:" prefix doesn't match its host:port regex and
  // gets misread as part of the hostname — this is the exact "scout dead in
  // TCP mode" bug (DOORS.md), so the value shape itself must be pinned down.
  const argv = planDoorMounts(grants(["scout"], TCP_ENV), true);
  const envIdx = argv.indexOf("--env");
  const value = argv[envIdx + 1];
  expect(value).toMatch(/^SCOUTD_SOCK=[^:/\s]+:\d+$/);
  expect(value).not.toContain("tcp:");
});
