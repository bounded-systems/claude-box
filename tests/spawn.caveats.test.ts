/**
 * lib/spawn.ts — caveat forwarding (3b of the launcherd room-attenuation chain).
 *
 * Proves the in-box spawn client forwards this box's own doors (WITH caveats) as
 * `_parentDoors`, so launcherd can enforce that a child is never wider than its
 * parent — names AND caveats. Without this, launcherd's caveat-aware check (3a)
 * never sees the parent's caveats for a real nested spawn.
 *
 *   nix run nixpkgs#bun -- test tests/spawn.caveats.test.ts
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, unlinkSync } from "node:fs";
import { spawn, getCurrentDoors } from "../lib/spawn";

const CAPS = "CLAUDE_BOX_CAPABILITIES";

afterEach(() => {
  delete process.env[CAPS];
});

describe("getCurrentDoors — this box's doors+caveats from its capability surface", () => {
  test("returns undefined with no capability surface (host/dev/root-equivalent)", () => {
    delete process.env[CAPS];
    expect(getCurrentDoors()).toBeUndefined();
  });

  test("maps granted.doors to {name, caveats}", () => {
    process.env[CAPS] = JSON.stringify({
      granted: { doors: [{ name: "scout", caveats: ["host=github.com"] }, { name: "net" }] },
    });
    expect(getCurrentDoors()).toEqual([
      { name: "scout", caveats: ["host=github.com"] },
      { name: "net", caveats: [] }, // missing caveats default to none
    ]);
  });

  test("malformed caps surface → undefined (fail safe, not a crash)", () => {
    process.env[CAPS] = "{not json";
    expect(getCurrentDoors()).toBeUndefined();
  });
});

describe("spawn() forwards _parentDoors + caveats to launcherd", () => {
  const sockDir = `${process.env.HOME ?? "."}/.cache`;
  const sockPath = `${sockDir}/cb-spawn-caveats-test.sock`;
  let prevSock: string | undefined;

  function bootStub(): { server: { stop: (c?: boolean) => void }; captured: () => Record<string, unknown> | null } {
    mkdirSync(sockDir, { recursive: true });
    try { unlinkSync(sockPath); } catch { /* not present */ }
    let captured: Record<string, unknown> | null = null;
    const server = Bun.listen({
      unix: sockPath,
      socket: {
        data(sock, data) {
          const line = Buffer.from(data).toString("utf-8").split("\n")[0]!;
          const req = JSON.parse(line);
          captured = req.params;
          const result = { launchId: "stub-1", pid: 1, manifest: { account: "test", doors: [], denied: [], netOpen: false } };
          sock.write(JSON.stringify({ id: req.id, ok: true, result }) + "\n");
        },
        open() {},
        close() {},
        error() {},
      },
    }) as unknown as { stop: (c?: boolean) => void };
    return { server, captured: () => captured };
  }

  afterEach(() => {
    if (prevSock === undefined) delete process.env.LAUNCHERD_SOCK;
    else process.env.LAUNCHERD_SOCK = prevSock;
    try { unlinkSync(sockPath); } catch { /* already gone */ }
  });

  test("forwards the box's caveated doors as _parentDoors (granted == enforced across spawn)", async () => {
    prevSock = process.env.LAUNCHERD_SOCK;
    process.env.LAUNCHERD_SOCK = sockPath;
    process.env[CAPS] = JSON.stringify({
      granted: { doors: [{ name: "scout", caveats: ["host=github.com"] }] },
    });
    const { server, captured } = bootStub();
    try {
      await spawn({ doors: ["scout"], caveats: { scout: ["host=github.com"] } });
    } finally {
      server.stop(true);
    }
    const params = captured()!;
    expect(params._parentDoors).toEqual([{ name: "scout", caveats: ["host=github.com"] }]);
    expect(params.caveats).toEqual({ scout: ["host=github.com"] });
    expect(params.depth).toBe(1);
  });

  test("omits _parentDoors when the box has no capability surface (stays parentless/lenient)", async () => {
    prevSock = process.env.LAUNCHERD_SOCK;
    process.env.LAUNCHERD_SOCK = sockPath;
    delete process.env[CAPS];
    const { server, captured } = bootStub();
    try {
      await spawn({ doors: ["net"] });
    } finally {
      server.stop(true);
    }
    expect(captured()!._parentDoors).toBeUndefined();
  });
});
