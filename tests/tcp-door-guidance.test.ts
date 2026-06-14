/**
 * TCP-mode door-guidance honesty.
 *
 * The bug: in TCP mode (macOS) the box mounts NO /run/doors, yet resolveDoor's
 * `use` text still told the agent to reach keeper/scout/net "at
 * /run/doors/<d>.sock". A live box hit exactly this — net worked (it rides
 * HTTPS_PROXY, a protocol the client already speaks) but scout looked "dead"
 * because its guidance pointed at an absent socket. The machine-readable manifest
 * was already honest (it uses transportString(d.guest)); only the human-readable
 * guidance lied.
 *
 * This is the bounded fix ahead of the full transport-agnostic client (prx-o92):
 * in TCP mode the guidance must advertise the real host-gateway endpoint, never a
 * unix path that isn't mounted. Unix mode must keep its concrete socket path.
 *
 *   nix run nixpkgs#bun -- test tests/tcp-door-guidance.test.ts
 */
import { test, expect } from "bun:test";
import { resolveDoor } from "../claude-box.ts";

// Base on the real env (door host paths need HOME/XDG_RUNTIME_DIR); toggle only
// the TCP-mode switch so each block exercises one transport.
const TCP = { ...process.env, DOORS_TCP: "1" };
const UNIX = { ...process.env, DOORS_TCP: "" };

// Only keeper/net/scout have TCP ports (TCP_PORTS); beads/launcher stay unix.
const TCP_DOORS = ["keeper", "scout", "net"] as const;

for (const name of TCP_DOORS) {
  test(`${name}: TCP-mode guidance advertises the host gateway, not /run/doors`, () => {
    const grant = resolveDoor(name, undefined, TCP);
    // honest: names the real reachable endpoint…
    expect(grant.use).toContain("host.containers.internal:");
    // …and never the unmounted unix path.
    expect(grant.use).not.toContain(`/run/doors/${name}d.sock`);
    // the transport override the guidance must agree with
    expect(grant.guest.kind).toBe("tcp");
  });

  test(`${name}: unix-mode guidance keeps the concrete socket path`, () => {
    const grant = resolveDoor(name, undefined, UNIX);
    expect(grant.use).toContain(`/run/doors/${name}d.sock`);
    expect(grant.use).not.toContain("host.containers.internal:");
    expect(grant.guest.kind).toBe("unix");
  });
}
