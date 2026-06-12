/**
 * lib/spawn.ts tests — tests for the in-box spawn client library.
 *
 * These test the client code without needing a running launcherd.
 */

import { describe, test, expect } from "bun:test";
import {
  SpawnOptions,
  SpawnResult,
  LauncherdStatus,
  BoxInfo,
  LauncherdError,
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
