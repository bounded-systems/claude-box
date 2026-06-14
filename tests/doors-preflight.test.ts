/**
 * doors-preflight tests — the TCP-mode door reachability check.
 *
 * In TCP mode (macOS), a box launched while the doors are down used to succeed
 * and then the in-box agent would die with an opaque "API Error: Connection
 * error" the moment it touched a door. The unix path had assertSocketExists; the
 * TCP path had nothing. tcpReachable is the check that closes that gap — these
 * tests exercise it against a real ephemeral listener (deterministic, no daemons).
 *
 *   nix run nixpkgs#bun -- test tests/doors-preflight.test.ts
 */
import { test, expect } from "bun:test";
import { tcpReachable } from "../claude-box.ts";

test("tcpReachable: true for an open listener", async () => {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0, // ephemeral
    socket: { data() {}, open() {} },
  });
  try {
    expect(await tcpReachable("127.0.0.1", server.port)).toBe(true);
  } finally {
    server.stop();
  }
});

test("tcpReachable: false for a closed port", async () => {
  // bind an ephemeral port, capture it, then free it → guaranteed-closed port
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {} },
  });
  const port = server.port;
  server.stop();
  expect(await tcpReachable("127.0.0.1", port)).toBe(false);
});

test("tcpReachable: false (not hang) for an unreachable host within timeout", async () => {
  // 192.0.2.0/24 (TEST-NET-1) is reserved and routes nowhere; must time out fast.
  const start = Date.now();
  expect(await tcpReachable("192.0.2.1", 3128, 800)).toBe(false);
  expect(Date.now() - start).toBeLessThan(3000); // bounded by the timeout, not a hang
});
