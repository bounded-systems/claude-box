/**
 * door-interpose tests (prx-yweb / trust 6.3) — a delegated door's CAVEATS must
 * be enforced by an interposer on traffic, not carried as metadata. These prove
 * the fronting logic on REAL unix sockets (the only thing the podman VM adds is
 * the box reaching the proxy through the bind-mount, which #159/#161 verified):
 *   - a caveated door is rewritten to a proxy socket that enforces the caveat;
 *   - a denied request never reaches the upstream the box can't see (keystone);
 *   - a REMOTE (tcp) door is fronted into a unix bridge that carries the grant
 *     on the wire (prx-8uf2 — the box always speaks unix);
 *   - an uncaveated unix door (and a vsock door) passes through unchanged.
 *
 *   nix run nixpkgs#bun -- test tests/door-interpose.test.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planDoorMounts } from "../claude-box.ts";
import { type DoorGrant, type SignedGrant, tcp, unix, vsock } from "../guest-room/mod.ts";
import { call, createDoorHandlers } from "../guest-room/protocol.ts";
import { type Interposer, frontDoorsWithInterposers, teardownInterposers } from "../door-interpose.ts";

const noop = (): void => {};

function doorAt(host: string, caveats: string[]): DoorGrant {
  return {
    name: "scout",
    host: unix(host),
    guest: unix("/run/doors/scoutd.sock"),
    env: "SCOUTD_SOCK",
    grants: "test door",
    use: "test",
    caveats,
  };
}

/** A signed grant the bridge would present to a remote upstream (shape only —
 *  the test asserts it's carried on the wire, not its signature's validity). */
function signedGrant(door: DoorGrant): SignedGrant {
  return {
    ...door,
    binding: { audience: "room-A", exp: Date.now() + 60_000, nonce: "n", keyId: "k" },
    signature: "sig-xyz",
  };
}

describe("frontDoorsWithInterposers", () => {
  const servers: Array<{ stop: () => void }> = [];
  const paths: string[] = [];
  let live: Interposer[] = [];
  afterEach(() => {
    teardownInterposers(live);
    live = [];
    for (const s of servers.splice(0)) s.stop();
    for (const p of paths.splice(0)) {
      try {
        unlinkSync(p);
      } catch {
        /* gone */
      }
    }
  });

  /** A fake upstream door that records every method it actually receives. */
  function upstream(seen: string[]): string {
    const path = join(tmpdir(), `cb-up-${crypto.randomUUID()}.sock`);
    paths.push(path);
    servers.push(
      Bun.listen({
        unix: path,
        socket: createDoorHandlers(
          "up",
          {
            read: (p) => {
              seen.push("read");
              return { read: p.x };
            },
            write: (p) => {
              seen.push("write");
              return { wrote: p.x };
            },
          },
          noop,
        ),
      }),
    );
    return path;
  }

  /** A fake upstream door on a real TCP port that records each request's grant. */
  function tcpUpstream(onGrant: (g: SignedGrant | undefined) => void): number {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0, // ephemeral
      socket: createDoorHandlers(
        "up",
        { read: (p) => ({ read: p.x }) },
        noop,
        (req) => {
          onGrant(req.grant);
          return true;
        },
      ),
    });
    servers.push(server);
    return server.port;
  }

  test("KEYSTONE: a caveated door is fronted; a denied request never reaches upstream", async () => {
    const seen: string[] = [];
    const up = upstream(seen);
    const { doors, interposers } = frontDoorsWithInterposers([doorAt(up, ["method=read"])], "launch-1");
    live = interposers;
    paths.push(...interposers.map((i) => i.socketPath));

    // The door's host was rewritten away from the upstream → the box mounts the proxy.
    expect(doors[0]!.host.kind).toBe("unix");
    const proxyPath = (doors[0]!.host as { path: string }).path;
    expect(proxyPath).not.toBe(up);
    expect(interposers).toHaveLength(1);

    // An allowed call round-trips to the upstream.
    expect(await call<{ read: number }>(proxyPath, "read", { x: 1 })).toEqual({ read: 1 });
    expect(seen).toEqual(["read"]);

    // A request outside the caveat is refused AT THE PROXY — upstream never sees it.
    await expect(call(proxyPath, "write", { x: 2 })).rejects.toThrow(/caveat not satisfied/);
    expect(seen).toEqual(["read"]); // structurally blocked, not trusted to behave
  });

  test("an uncaveated door passes through unchanged (no proxy, no behavior change)", () => {
    const { doors, interposers } = frontDoorsWithInterposers([doorAt("/run/doors/scoutd.sock", [])], "launch-2");
    expect(interposers).toHaveLength(0);
    expect((doors[0]!.host as { path: string }).path).toBe("/run/doors/scoutd.sock");
  });

  test("REMOTE: a tcp door is fronted into a unix bridge that carries the grant to the upstream", async () => {
    let received: SignedGrant | undefined;
    const port = tcpUpstream((g) => {
      received = g;
    });
    const tcpDoor: DoorGrant = { ...doorAt("/unused", ["method=read"]), host: tcp("127.0.0.1", port) };
    const sg = signedGrant(tcpDoor);
    const { doors, interposers } = frontDoorsWithInterposers([tcpDoor], "launch-r", {
      grantFor: () => sg,
      socketDir: tmpdir(),
    });
    live = interposers;
    paths.push(...interposers.map((i) => i.socketPath));

    // The box-facing door is UNIX (the box never sees tcp), fronted by one bridge.
    expect(interposers).toHaveLength(1);
    expect(doors[0]!.host.kind).toBe("unix");
    const proxyPath = (doors[0]!.host as { path: string }).path;

    // Calling the unix proxy reaches the tcp upstream WITH the grant attached —
    // the box spoke unix; the bridge carried the grant on the wire.
    expect(await call<{ read: number }>(proxyPath, "read", { x: 7 })).toEqual({ read: 7 });
    expect(received?.signature).toBe("sig-xyz");
  });

  test("a vsock door passes through unchanged (no call() vsock path yet)", () => {
    const vsockDoor: DoorGrant = { ...doorAt("/x", ["method=read"]), host: vsock(3, 5000) };
    const { doors, interposers } = frontDoorsWithInterposers([vsockDoor], "launch-v");
    expect(interposers).toHaveLength(0);
    expect(doors[0]!.host).toEqual(vsock(3, 5000));
  });

  test("the box MOUNTS the proxy, not the upstream (frontDoorsWithInterposers → planDoorMounts)", () => {
    // The integration the live spawn rides on: a fronted door, fed to the same
    // planDoorMounts launcherd uses, mounts the INTERPOSER at the guest path — so
    // the box can only ever reach the proxy, never the upstream socket.
    const seen: string[] = [];
    const up = upstream(seen);
    const { doors, interposers } = frontDoorsWithInterposers([doorAt(up, ["method=read"])], "launch-mount");
    live = interposers;
    paths.push(...interposers.map((i) => i.socketPath));

    const proxyPath = (doors[0]!.host as { path: string }).path;
    const argv = planDoorMounts(doors, false);
    const mount = argv[argv.indexOf("-v") + 1];

    expect(mount).toBe(`${proxyPath}:/run/doors/scoutd.sock`); // proxy mounted at the guest path
    expect(mount).not.toContain(up); // the upstream socket is never mounted into the box
  });
});
