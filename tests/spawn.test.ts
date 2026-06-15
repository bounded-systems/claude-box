/**
 * lib/spawn.ts tests — tests for the in-box spawn client library.
 *
 * These test the client code without needing a running launcherd.
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  SpawnOptions,
  SpawnResult,
  LauncherdStatus,
  BoxInfo,
  LauncherdError,
  getCurrentDepth,
  spawn,
} from "../lib/spawn";

describe("lib/spawn types", () => {
  test("SpawnOptions has expected shape", () => {
    const opts: SpawnOptions = {
      account: "personal",
      room: "dev",
      repo: "/work",
      repoRw: false,
      doors: ["keeper", "net"],
      netOpen: false,
      claudeArgs: ["--resume"],
      depth: 1,
    };

    expect(opts.account).toBe("personal");
    expect(opts.room).toBe("dev");
    expect(opts.doors).toEqual(["keeper", "net"]);
  });

  test("SpawnResult has expected shape", () => {
    const result: SpawnResult = {
      launchId: "box-123",
      pid: 12345,
      manifest: {
        account: "personal",
        repo: "/work",
        doors: ["keeper"],
        denied: ["beads"],
        netOpen: false,
      },
    };

    expect(result.launchId).toBe("box-123");
    expect(result.pid).toBe(12345);
    expect(result.manifest.doors).toContain("keeper");
  });

  test("SpawnResult can include attestation", () => {
    const result: SpawnResult = {
      launchId: "box-456",
      pid: 67890,
      manifest: {
        account: "test",
        doors: [],
        denied: [],
        netOpen: false,
      },
      attestation: {
        statementDigest: "abc123",
        signature: "sig456",
        keyId: "key789",
      },
    };

    expect(result.attestation).toBeDefined();
    expect(result.attestation?.statementDigest).toBe("abc123");
  });

  test("LauncherdStatus has expected shape", () => {
    const status: LauncherdStatus = {
      version: "0.1.0",
      uptime: 3600,
      launches: 5,
      signing: { enabled: true, keyId: "test-key" },
      policy: {
        enabled: true,
        defaultAllow: ["dev"],
        rulesCount: 2,
        maxConcurrent: 10,
        maxDepth: 3,
        rateLimit: { window: 60, max: 10 },
      },
      doors: {
        keeper: { socket: "/run/keeperd.sock", reachable: true },
        net: { socket: "/run/netd.sock", reachable: false },
      },
      rooms: {
        dev: "full dev",
        readonly: "read-only research",
      },
    };

    expect(status.version).toBe("0.1.0");
    expect(status.signing.enabled).toBe(true);
    expect(status.policy.maxDepth).toBe(3);
  });

  test("BoxInfo has expected shape", () => {
    const box: BoxInfo = {
      launchId: "box-test",
      account: "personal",
      pid: 1234,
      startedAt: "2024-01-01T00:00:00Z",
      doors: ["keeper"],
      repo: "/work",
      depth: 1,
      status: "running",
    };

    expect(box.launchId).toBe("box-test");
    expect(box.status).toBe("running");
  });
});

describe("getCurrentDepth", () => {
  const saved = process.env.CLAUDE_BOX_CAPABILITIES;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_BOX_CAPABILITIES;
    else process.env.CLAUDE_BOX_CAPABILITIES = saved;
  });

  test("returns 0 when no capabilities are present", () => {
    delete process.env.CLAUDE_BOX_CAPABILITIES;
    expect(getCurrentDepth()).toBe(0);
  });

  test("returns 0 when the manifest omits depth (back-compat)", () => {
    process.env.CLAUDE_BOX_CAPABILITIES = JSON.stringify({ account: "personal" });
    expect(getCurrentDepth()).toBe(0);
  });

  test("reads the real depth emitted by capabilityJson", () => {
    process.env.CLAUDE_BOX_CAPABILITIES = JSON.stringify({ account: "personal", depth: 2 });
    expect(getCurrentDepth()).toBe(2);
  });

  test("returns 0 for malformed capabilities", () => {
    process.env.CLAUDE_BOX_CAPABILITIES = "not-json";
    expect(getCurrentDepth()).toBe(0);
  });
});

describe("spawn depth accumulation (nested spawns)", () => {
  const savedCaps = process.env.CLAUDE_BOX_CAPABILITIES;
  const savedSock = process.env.LAUNCHERD_SOCK;
  let server: { stop: () => void } | undefined;

  afterEach(() => {
    server?.stop();
    server = undefined;
    if (savedCaps === undefined) delete process.env.CLAUDE_BOX_CAPABILITIES;
    else process.env.CLAUDE_BOX_CAPABILITIES = savedCaps;
    if (savedSock === undefined) delete process.env.LAUNCHERD_SOCK;
    else process.env.LAUNCHERD_SOCK = savedSock;
  });

  // A mock launcherd over a unix socket that captures the launch params and
  // replies with a minimal SpawnResult. Returns a promise for the received params.
  function mockLauncherd(sockPath: string): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      server = Bun.listen({
        unix: sockPath,
        socket: {
          data(sock, data) {
            const req = JSON.parse(data.toString().trim());
            resolve(req.params as Record<string, unknown>);
            const resp = {
              id: req.id,
              ok: true,
              result: { launchId: "box-test", pid: 4242, manifest: { account: "personal", doors: [], denied: [], netOpen: false } },
            };
            sock.write(JSON.stringify(resp) + "\n");
            sock.end();
          },
          open() {},
        },
      }) as { stop: () => void };
    });
  }

  test("a box at depth 2 spawns a child at depth 3 (ceiling stays effective)", async () => {
    const sockPath = `/tmp/launcherd-spawn-test-${process.pid}.sock`;
    const received = mockLauncherd(sockPath);
    process.env.LAUNCHERD_SOCK = sockPath;
    // Simulate the in-box manifest: this box was launched at depth 2.
    process.env.CLAUDE_BOX_CAPABILITIES = JSON.stringify({ account: "personal", depth: 2 });

    await spawn({ account: "personal" });
    const params = await received;
    expect(params.depth).toBe(3); // 2 (current) + 1, NOT 0 + 1
  });

  test("a root box (no depth in caps) spawns a child at depth 1", async () => {
    const sockPath = `/tmp/launcherd-spawn-test-root-${process.pid}.sock`;
    const received = mockLauncherd(sockPath);
    process.env.LAUNCHERD_SOCK = sockPath;
    delete process.env.CLAUDE_BOX_CAPABILITIES;

    await spawn({ account: "personal" });
    const params = await received;
    expect(params.depth).toBe(1);
  });
});

describe("LauncherdError", () => {
  test("has code and message", () => {
    const err = new LauncherdError("TEST_ERROR", "something went wrong");

    expect(err.code).toBe("TEST_ERROR");
    expect(err.message).toBe("something went wrong");
    expect(err.name).toBe("LauncherdError");
  });

  test("is an Error instance", () => {
    const err = new LauncherdError("CODE", "message");
    expect(err instanceof Error).toBe(true);
    expect(err instanceof LauncherdError).toBe(true);
  });
});
