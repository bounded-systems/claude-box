/**
 * door-interpose tests (prx-yweb / trust 6.3) — a delegated door's CAVEATS must
 * be enforced by an interposer on traffic, not carried as metadata. These prove
 * the fronting logic on REAL unix sockets (the only thing the podman VM adds is
 * the box reaching the proxy through the bind-mount, which #159/#161 verified):
 *   - a caveated door is rewritten to a proxy socket that enforces the caveat;
 *   - a denied request never reaches the upstream the box can't see (keystone);
 *   - an uncaveated door (and a tcp door) passes through unchanged.
 *
 *   nix run nixpkgs#bun -- test tests/door-interpose.test.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planDoorMounts } from "../claude-box.ts";
import { type DoorGrant, tcp, unix } from "../guest-room/mod.ts";
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

  test("a tcp/vsock door is not fronted (its authority rides in a signed grant)", () => {
    const tcpDoor: DoorGrant = { ...doorAt("/x", ["method=read"]), host: tcp("host.internal", 3002) };
    const { doors, interposers } = frontDoorsWithInterposers([tcpDoor], "launch-3");
    expect(interposers).toHaveLength(0);
    expect(doors[0]!.host).toEqual(tcp("host.internal", 3002));
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
