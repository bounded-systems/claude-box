/**
 * launcherd tests — pure unit tests (no daemon, no podman).
 *
 * Tests request handling, room expansion, protocol parsing, and L2 attestation.
 */

import { describe, test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createPublicKey, verify } from "node:crypto";
import {
  ROOMS,
  handleRequest,
  handleDispatch,
  DISPATCH_METHODS,
  sanitizeLabel,
  buildPodmanArgv,
  generateLaunchId,
  sha256,
  loadOrCreateKey,
  buildL2Attestation,
} from "../launcherd";
import type { RequestEnvelope, ResponseEnvelope, SigningKey } from "../launcherd";
import { PREDICATE_TYPE, IN_TOTO_STATEMENT_TYPE } from "../contract/types";
import type { Launch, Manifest } from "../claude-box";

describe("launcherd", () => {
  describe("rooms", () => {
    test("dev room has keeper, net, scout", () => {
      expect(ROOMS.dev.doors).toEqual(["keeper", "net", "scout"]);
      expect(ROOMS.dev.netOpen).toBeUndefined();
    });

    test("readonly room has net, scout but no keeper", () => {
      expect(ROOMS.readonly.doors).toEqual(["net", "scout"]);
      expect(ROOMS.readonly.doors).not.toContain("keeper");
    });

    test("offline room has no doors", () => {
      expect(ROOMS.offline.doors).toEqual([]);
      expect(ROOMS.offline.netOpen).toBeUndefined();
    });

    test("bootstrap room has netOpen escape", () => {
      expect(ROOMS.bootstrap.doors).toEqual([]);
      expect(ROOMS.bootstrap.netOpen).toBe(true);
    });

    test("all rooms have descriptions", () => {
      for (const [name, room] of Object.entries(ROOMS)) {
        expect(room.description).toBeTruthy();
        expect(typeof room.description).toBe("string");
      }
    });

    test("dev, readonly, offline are dispatchable; dev-spawn and bootstrap are not", () => {
      expect(ROOMS.dev.dispatchable).toBe(true);
      expect(ROOMS.readonly.dispatchable).toBe(true);
      expect(ROOMS.offline.dispatchable).toBe(true);
      expect(ROOMS["dev-spawn"].dispatchable).toBeFalsy();
      expect(ROOMS.bootstrap.dispatchable).toBeFalsy();
    });

    test("no dispatchable room holds the launcher door or opens ambient egress", () => {
      for (const [name, room] of Object.entries(ROOMS)) {
        if (!room.dispatchable) continue;
        expect(room.doors).not.toContain("launcher");
        expect(room.netOpen).toBeFalsy();
      }
    });
  });

  describe("generateLaunchId", () => {
    test("generates unique IDs", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateLaunchId());
      }
      expect(ids.size).toBe(100);
    });

    test("IDs start with box-", () => {
      const id = generateLaunchId();
      expect(id.startsWith("box-")).toBe(true);
    });

    test("splices a sanitized label in as a prefix, random suffix always appended", () => {
      const id = generateLaunchId("fix-auth-bug");
      expect(id.startsWith("box-fix-auth-bug-")).toBe(true);
      // Two calls with the same label never collide.
      expect(generateLaunchId("fix-auth-bug")).not.toBe(generateLaunchId("fix-auth-bug"));
    });

    test("falls back to the bare box-<rand> shape for no label", () => {
      expect(generateLaunchId(undefined).startsWith("box-")).toBe(true);
    });
  });

  describe("sanitizeLabel", () => {
    test("lowercases and replaces disallowed characters", () => {
      expect(sanitizeLabel("Fix Auth Bug!")).toBe("fix-auth-bug");
    });

    test("trims leading/trailing punctuation", () => {
      expect(sanitizeLabel("--.fix-this.--")).toBe("fix-this");
    });

    test("truncates to 40 characters", () => {
      const long = "a".repeat(60);
      expect(sanitizeLabel(long)!.length).toBe(40);
    });

    test("returns undefined for empty, undefined, or all-punctuation input", () => {
      expect(sanitizeLabel(undefined)).toBeUndefined();
      expect(sanitizeLabel("")).toBeUndefined();
      expect(sanitizeLabel("---...___")).toBeUndefined();
    });
  });

  describe("handleRequest", () => {
    test("rejects invalid JSON", async () => {
      const resp = await handleRequest("not json");
      expect(resp.ok).toBe(false);
      expect(resp.error?.code).toBe("PARSE_ERROR");
    });

    test("rejects missing id", async () => {
      const resp = await handleRequest(JSON.stringify({ method: "status" }));
      expect(resp.ok).toBe(false);
      expect(resp.error?.code).toBe("INVALID_REQUEST");
    });

    test("rejects missing method", async () => {
      const resp = await handleRequest(JSON.stringify({ id: "1" }));
      expect(resp.ok).toBe(false);
      expect(resp.error?.code).toBe("INVALID_REQUEST");
    });

    test("rejects unknown method", async () => {
      const resp = await handleRequest(JSON.stringify({ id: "1", method: "bogus" }));
      expect(resp.ok).toBe(false);
      expect(resp.error?.code).toBe("UNKNOWN_METHOD");
      expect(resp.id).toBe("1");
    });

    test("status returns daemon info", async () => {
      const resp = await handleRequest(JSON.stringify({ id: "test-1", method: "status" }));
      expect(resp.ok).toBe(true);
      expect(resp.id).toBe("test-1");

      const result = resp.result as Record<string, unknown>;
      expect(result.version).toBe("0.1.0");
      expect(typeof result.uptime).toBe("number");
      expect(typeof result.launches).toBe("number");
      expect(result.doors).toBeDefined();
      expect(result.rooms).toBeDefined();
    });

    test("rooms returns all room definitions", async () => {
      const resp = await handleRequest(JSON.stringify({ id: "test-2", method: "rooms" }));
      expect(resp.ok).toBe(true);

      const result = resp.result as { rooms: Record<string, { doors: string[]; netOpen: boolean; description: string }> };
      expect(result.rooms.dev).toBeDefined();
      expect(result.rooms.dev.doors).toEqual(["keeper", "net", "scout"]);
      expect(result.rooms.readonly).toBeDefined();
      expect(result.rooms.offline).toBeDefined();
      expect(result.rooms.bootstrap).toBeDefined();
      expect(result.rooms.bootstrap.netOpen).toBe(true);
    });

    test("list returns empty when no launches", async () => {
      const resp = await handleRequest(JSON.stringify({ id: "test-3", method: "list" }));
      expect(resp.ok).toBe(true);

      const result = resp.result as { launches: unknown[] };
      expect(Array.isArray(result.launches)).toBe(true);
    });

    test("kill fails for nonexistent launch", async () => {
      const resp = await handleRequest(
        JSON.stringify({ id: "test-4", method: "kill", params: { launchId: "box-nonexistent" } })
      );
      expect(resp.ok).toBe(false);
      expect(resp.error?.code).toBe("NOT_FOUND");
    });

    test("kill fails without launchId", async () => {
      const resp = await handleRequest(JSON.stringify({ id: "test-5", method: "kill", params: {} }));
      expect(resp.ok).toBe(false);
      expect(resp.error?.code).toBe("INVALID_PARAMS");
    });

    test("launch rejects unknown room", async () => {
      const resp = await handleRequest(
        JSON.stringify({ id: "test-7", method: "launch", params: { room: "nonexistent" } })
      );
      expect(resp.ok).toBe(false);
      expect(resp.error?.code).toBe("UNKNOWN_ROOM");
      expect(resp.error?.message).toContain("Available:");
    });

    // Note: We can't fully test launch without podman/doors running, but we can
    // test validation. The launch will fail at door-checking stage.
    test("launch fails when doors unreachable", async () => {
      const resp = await handleRequest(
        JSON.stringify({
          id: "test-8",
          method: "launch",
          params: { doors: ["keeper"] },
        })
      );
      expect(resp.ok).toBe(false);
      // Either DOORS_UNREACHABLE (socket exists but unreachable) or ENOENT (socket doesn't exist)
      expect(["DOORS_UNREACHABLE", "ENOENT"]).toContain(resp.error?.code ?? "");
    });
  });

  describe("dispatch", () => {
    test("is unreachable on the general METHODS table", async () => {
      const resp = await handleRequest(
        JSON.stringify({ id: "d-1", method: "dispatch", params: { room: "dev" } })
      );
      expect(resp.ok).toBe(false);
      expect(resp.error?.code).toBe("UNKNOWN_METHOD");
    });

    test("launch/kill/list/attach/status/rooms are unreachable on the dispatch table", async () => {
      for (const method of ["launch", "kill", "list", "attach", "status", "rooms"]) {
        const resp = await handleRequest(
          JSON.stringify({ id: "d-2", method, params: {} }),
          DISPATCH_METHODS
        );
        expect(resp.ok).toBe(false);
        expect(resp.error?.code).toBe("UNKNOWN_METHOD");
      }
    });

    test("requires a room name", async () => {
      const resp = await handleRequest(JSON.stringify({ id: "d-3", method: "dispatch", params: {} }), DISPATCH_METHODS);
      expect(resp.ok).toBe(false);
      expect(resp.error?.code).toBe("INVALID_REQUEST");
    });

    test("refuses a non-dispatchable room (dev-spawn holds launcher)", async () => {
      const resp = await handleRequest(
        JSON.stringify({ id: "d-4", method: "dispatch", params: { room: "dev-spawn" } }),
        DISPATCH_METHODS
      );
      expect(resp.ok).toBe(false);
      expect(resp.error?.code).toBe("ROOM_NOT_DISPATCHABLE");
      expect(resp.error?.message).toContain("Available:");
    });

    test("refuses an unknown room", async () => {
      const resp = await handleRequest(
        JSON.stringify({ id: "d-5", method: "dispatch", params: { room: "does-not-exist" } }),
        DISPATCH_METHODS
      );
      expect(resp.ok).toBe(false);
      expect(resp.error?.code).toBe("ROOM_NOT_DISPATCHABLE");
    });

    // Can't fully test dispatch without podman/doors running (same caveat as
    // `launch`), but this proves two load-bearing things at once: doors are
    // resolved GLOBALLY for a dispatchable room (no caller record, so no
    // ATTENUATION_VIOLATION even though this test has no caller at all), and
    // net+auth are always added on top of the room's own door list — "dev"
    // only lists keeper/net/scout, so "auth" showing up in the unreachable
    // list proves the addition happened.
    test("resolves a dispatchable room's doors globally, always adding net+auth", async () => {
      const resp = await handleRequest(
        JSON.stringify({ id: "d-6", method: "dispatch", params: { room: "dev", label: "fix-auth-bug" } }),
        DISPATCH_METHODS
      );
      expect(resp.ok).toBe(false);
      expect(["DOORS_UNREACHABLE", "ENOENT"]).toContain(resp.error?.code ?? "");
      if (resp.error?.code === "DOORS_UNREACHABLE") {
        expect(resp.error.message).toContain("auth");
      }
    });
  });

  describe("protocol", () => {
    test("response echoes request id", async () => {
      const id = `test-${Date.now()}`;
      const resp = await handleRequest(JSON.stringify({ id, method: "status" }));
      expect(resp.id).toBe(id);
    });

    test("error responses have code and message", async () => {
      const resp = await handleRequest(JSON.stringify({ id: "1", method: "kill", params: {} }));
      expect(resp.ok).toBe(false);
      expect(resp.error).toBeDefined();
      expect(typeof resp.error?.code).toBe("string");
      expect(typeof resp.error?.message).toBe("string");
    });

    test("success responses have result", async () => {
      const resp = await handleRequest(JSON.stringify({ id: "1", method: "status" }));
      expect(resp.ok).toBe(true);
      expect(resp.result).toBeDefined();
      expect(resp.error).toBeUndefined();
    });
  });
});

// NOTE: the CLI `--room` flag is an *in-process* door bundle expanded by
// claude-box (knownRooms): see tests/door.test.ts. It does not route through
// launcherd, so its parsing is covered there, not here. The daemon keeps its
// own internal room presets (ROOMS), exercised by the "rooms" block above.

describe("L2 attestation", () => {
  let tempDir: string;
  let key: SigningKey;

  // Set up a temp dir for key storage
  tempDir = mkdtempSync(join(tmpdir(), "launcherd-test-"));
  const keyPath = join(tempDir, "test.key");
  key = loadOrCreateKey(keyPath);

  describe("sha256", () => {
    test("produces 64-char hex digest", () => {
      const digest = sha256("hello world");
      expect(digest.length).toBe(64);
      expect(/^[a-f0-9]{64}$/.test(digest)).toBe(true);
    });

    test("is deterministic", () => {
      const a = sha256("test data");
      const b = sha256("test data");
      expect(a).toBe(b);
    });

    test("different inputs produce different digests", () => {
      const a = sha256("input1");
      const b = sha256("input2");
      expect(a).not.toBe(b);
    });
  });

  describe("loadOrCreateKey", () => {
    test("generates Ed25519 key pair", () => {
      expect(key.privateKey).toBeDefined();
      expect(key.publicKeyPem).toContain("PUBLIC KEY");
      expect(key.keyId.length).toBe(64);
    });

    test("reloading returns same keyId", () => {
      const reloaded = loadOrCreateKey(keyPath);
      expect(reloaded.keyId).toBe(key.keyId);
    });

    test("creates .pub file alongside private key", () => {
      const pubFile = Bun.file(`${keyPath}.pub`);
      expect(pubFile.size).toBeGreaterThan(0);
    });
  });

  describe("buildL2Attestation", () => {
    // Build a mock manifest
    const { buildManifest, capabilityJson } = require("../claude-box");
    const mockLaunch = {
      repo: "/work",
      repoRw: false,
      repoEphemeral: false,
      writable: [],
      doors: [{ name: "keeper", guest: { kind: "unix", path: "/run/keeperd.sock" } as const, env: "KEEPERD_SOCK", host: { kind: "unix", path: "/tmp/keeperd.sock" } as const, grants: "git writes", use: "route writes" }],
      netOpen: false,
      claudeArgs: [],
    };
    const manifest = buildManifest(mockLaunch);
    const manifestJson = capabilityJson(manifest);
    const launchId = "box-test-123";
    const imageDigest = "sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abcd";

    // We need to set the signingKey module variable for buildL2Attestation
    // Since it's a module-level variable, we need to load the key first
    // The test already loaded a key above, but buildL2Attestation uses the global
    // For testing, we'll import and set it via a workaround

    test("produces valid SLSA Provenance v1 statement", () => {
      // Re-load key to set the module-level signingKey
      const launcherd = require("../launcherd");
      // Set the module's signingKey by re-calling loadOrCreateKey
      // This is a bit of a hack, but it works for testing
      const testKey = launcherd.loadOrCreateKey(keyPath);

      const attestation = launcherd.buildL2Attestation(launchId, imageDigest, manifest, manifestJson);

      expect(attestation.statement._type).toBe(IN_TOTO_STATEMENT_TYPE);
      expect(attestation.statement.predicateType).toBe("https://slsa.dev/provenance/v1");
      expect(attestation.statement.predicate.buildDefinition.buildType).toBe(
        "https://claude.ai/buildTypes/ocap-launch/v1"
      );
    });

    test("includes correct manifest digest in externalParameters", () => {
      const launcherd = require("../launcherd");
      launcherd.loadOrCreateKey(keyPath);

      const attestation = launcherd.buildL2Attestation(launchId, imageDigest, manifest, manifestJson);
      const expectedDigest = sha256(manifestJson);
      const caps = attestation.statement.predicate.buildDefinition.externalParameters.capabilities as any;

      expect(caps?.manifestDigest?.sha256).toBe(expectedDigest);
    });

    test("links to image digest via ocap_links extension", () => {
      const launcherd = require("../launcherd");
      launcherd.loadOrCreateKey(keyPath);

      const attestation = launcherd.buildL2Attestation(launchId, imageDigest, manifest, manifestJson);
      const links = attestation.statement.predicate.runDetails.ocap_links;

      expect(links).toHaveLength(1);
      expect(links![0].level).toBe("image");
      expect(links![0].digest.sha256).toBe(
        imageDigest.replace(/^sha256:/, "")
      );
    });

    test("includes doors in externalParameters.capabilities", () => {
      const launcherd = require("../launcherd");
      launcherd.loadOrCreateKey(keyPath);

      const attestation = launcherd.buildL2Attestation(launchId, imageDigest, manifest, manifestJson);
      const caps = attestation.statement.predicate.buildDefinition.externalParameters.capabilities as any;

      expect(caps?.doors).toBeDefined();
      expect(caps?.doors?.length).toBeGreaterThan(0);
      expect(caps?.doors?.[0].name).toBe("keeper");
    });

    test("signature is base64 encoded", () => {
      const launcherd = require("../launcherd");
      launcherd.loadOrCreateKey(keyPath);

      const attestation = launcherd.buildL2Attestation(launchId, imageDigest, manifest, manifestJson);

      // Base64 validation: only alphanumeric, +, /, and = padding
      expect(/^[A-Za-z0-9+/]+=*$/.test(attestation.signature)).toBe(true);
    });

    test("signature verifies with public key", () => {
      const launcherd = require("../launcherd");
      const testKey = launcherd.loadOrCreateKey(keyPath);

      const attestation = launcherd.buildL2Attestation(launchId, imageDigest, manifest, manifestJson);

      // Verify the signature
      const publicKey = createPublicKey(testKey.publicKeyPem);
      const stmtJson = JSON.stringify(attestation.statement);
      const isValid = verify(
        null,
        Buffer.from(stmtJson),
        publicKey,
        Buffer.from(attestation.signature, "base64")
      );

      expect(isValid).toBe(true);
    });

    test("statementDigest matches statement content", () => {
      const launcherd = require("../launcherd");
      launcherd.loadOrCreateKey(keyPath);

      const attestation = launcherd.buildL2Attestation(launchId, imageDigest, manifest, manifestJson);
      const expectedDigest = sha256(JSON.stringify(attestation.statement));

      expect(attestation.statementDigest).toBe(expectedDigest);
    });

    test("keyId matches loaded key", () => {
      const launcherd = require("../launcherd");
      const testKey = launcherd.loadOrCreateKey(keyPath);

      const attestation = launcherd.buildL2Attestation(launchId, imageDigest, manifest, manifestJson);

      expect(attestation.keyId).toBe(testKey.keyId);
    });
  });

  // Cleanup
  test.skip("cleanup temp dir", () => {
    rmSync(tempDir, { recursive: true, force: true });
  });
});

// The name-based checkAttenuation + client `_parentDoors` were retired (prx-e232):
// child ⊆ parent is now enforced at the REFERENCE level by resolveLaunchDoors, and
// the spawn caller is classified by its cgroup (object-anchored, fail-closed). Those
// tests live in tests/spawn-authority.test.ts (resolveLaunchDoors + the cgroup-seam
// handleRequest cases).

describe("caller-based policy (SO_PEERCRED)", () => {
  const { setPolicy, isRoomAllowed } = require("../launcherd");
  type CallerInfo = import("../launcherd").CallerInfo;

  test("no policy = allow all", () => {
    setPolicy(null);
    expect(isRoomAllowed("dev")).toBe(true);
    expect(isRoomAllowed("readonly")).toBe(true);
    expect(isRoomAllowed("admin")).toBe(true); // even nonexistent rooms
  });

  test("defaultAllow permits listed rooms", () => {
    setPolicy({
      defaultAllow: ["dev", "readonly"],
      rules: [],
    });
    expect(isRoomAllowed("dev")).toBe(true);
    expect(isRoomAllowed("readonly")).toBe(true);
    expect(isRoomAllowed("dev-spawn")).toBe(false); // not in default
  });

  test("UID rule matches caller.uid", () => {
    setPolicy({
      defaultAllow: [],
      rules: [{ uid: 1000, allow: ["dev", "dev-spawn"] }],
    });

    const caller: CallerInfo = { uid: 1000, gid: 1000, pid: 12345 };

    expect(isRoomAllowed("dev", caller)).toBe(true);
    expect(isRoomAllowed("dev-spawn", caller)).toBe(true);
    expect(isRoomAllowed("readonly", caller)).toBe(false); // not in allow list

    // Different UID = no match
    const otherCaller: CallerInfo = { uid: 1001, gid: 1001, pid: 99999 };
    expect(isRoomAllowed("dev", otherCaller)).toBe(false);
  });

  test("token rule matches _token param", () => {
    const secretToken = "abc123secret";
    setPolicy({
      defaultAllow: [],
      rules: [{ token: secretToken, allow: ["readonly"] }],
    });

    // With matching token
    expect(isRoomAllowed("readonly", undefined, secretToken)).toBe(true);
    expect(isRoomAllowed("dev", undefined, secretToken)).toBe(false); // not in allow

    // Without token = no match
    expect(isRoomAllowed("readonly")).toBe(false);
    expect(isRoomAllowed("readonly", undefined, "wrong-token")).toBe(false);
  });

  test("first matching rule wins", () => {
    setPolicy({
      defaultAllow: ["bootstrap"],
      rules: [
        { uid: 1000, allow: ["dev"] },      // UID 1000 can only do dev
        { uid: 1001, allow: ["readonly"] }, // UID 1001 can only do readonly
      ],
    });

    const caller1000: CallerInfo = { uid: 1000, gid: 1000, pid: 1 };
    const caller1001: CallerInfo = { uid: 1001, gid: 1001, pid: 2 };

    // UID 1000 rule matches first
    expect(isRoomAllowed("dev", caller1000)).toBe(true);
    expect(isRoomAllowed("readonly", caller1000)).toBe(false);

    // UID 1001 rule matches
    expect(isRoomAllowed("readonly", caller1001)).toBe(true);
    expect(isRoomAllowed("dev", caller1001)).toBe(false);

    // No caller = falls through to defaultAllow
    expect(isRoomAllowed("bootstrap")).toBe(true);
  });

  // Reset policy after tests
  test("cleanup policy", () => {
    setPolicy(null);
  });

  describe("buildPodmanArgv — rcServe mode (used only by handleDispatch)", () => {
    const launch: Launch = {
      guest: "claude",
      repo: undefined,
      repoRw: false,
      repoEphemeral: false,
      repoClone: false,
      repoDoorRef: "main",
      pod: false,
      writable: [],
      doors: [],
      netOpen: false,
      remoteControl: false,
      remoteServe: true,
      guestArgs: [],
    };
    const manifest: Manifest = {
      guest: "claude",
      repo: undefined,
      repoRw: false,
      repoEphemeral: false,
      repoClone: false,
      writable: [],
      doors: [],
      netOpen: false,
      denied: [],
      depth: 0,
    };

    test("omitted: behaves exactly like an ordinary launch (no entrypoint override)", async () => {
      const argv = await buildPodmanArgv(launch, manifest, "box-plain-abc123");
      expect(argv).not.toContain("--entrypoint");
      expect(argv).toContain("claude-config:/home/claude/.config/claude:U");
    });

    test("present: overrides the entrypoint, uses a throwaway tmpfs, passes remoteControlArgs positionally", async () => {
      const argv = await buildPodmanArgv(launch, manifest, "box-fix-auth-bug-abc123", {
        leaseCmd: "echo lease",
        remoteControlArgs: ["remote-control", "--spawn", "session", "--name", "fix-auth-bug"],
      });
      expect(argv).toContain("--entrypoint");
      expect(argv[argv.indexOf("--entrypoint") + 1]).toBe("sh");
      // Throwaway tmpfs, never the shared persistent volume.
      expect(argv.some((a) => a.includes("home/claude/.config/claude:rw,mode=1777"))).toBe(true);
      expect(argv).not.toContain("claude-config:/home/claude/.config/claude:U");
      // "-c", "<script>", "claude-box", ...remoteControlArgs — tail order intact.
      const cIdx = argv.indexOf("-c");
      expect(argv.slice(cIdx)).toEqual([
        "-c",
        argv[cIdx + 1], // the script itself — content is buildRemoteServeScript's concern, not this one
        "claude-box",
        "remote-control",
        "--spawn",
        "session",
        "--name",
        "fix-auth-bug",
      ]);
      expect(typeof argv[cIdx + 1]).toBe("string");
      expect((argv[cIdx + 1] as string).length).toBeGreaterThan(0);
    });
  });
});

describe("dispatch rate/concurrency limits — non-permissive by default", () => {
  const {
    setPolicy,
    checkDispatchRateLimit,
    checkDispatchConcurrentLimit,
    recordDispatch,
    __resetDispatchLimits,
    __seedActiveDispatchCount,
  } = require("../launcherd");

  test("no policy still enforces a bounded default concurrency (unlike checkConcurrentLimit)", () => {
    setPolicy(null);
    __resetDispatchLimits();
    expect(checkDispatchConcurrentLimit().allowed).toBe(true);
    __seedActiveDispatchCount(5); // DEFAULT_MAX_CONCURRENT_DISPATCHED
    expect(checkDispatchConcurrentLimit().allowed).toBe(false);
    __resetDispatchLimits();
  });

  test("no policy still enforces a bounded default rate (unlike checkRateLimit)", () => {
    setPolicy(null);
    __resetDispatchLimits();
    for (let i = 0; i < 20; i++) {
      // DEFAULT_DISPATCH_RATE_LIMIT.max
      expect(checkDispatchRateLimit().allowed).toBe(true);
      recordDispatch();
    }
    const over = checkDispatchRateLimit();
    expect(over.allowed).toBe(false);
    expect(over.reason).toContain("dispatch rate limit exceeded");
    __resetDispatchLimits();
  });

  test("policy.maxConcurrentDispatched overrides the default", () => {
    setPolicy({ rules: [], maxConcurrentDispatched: 2 });
    __resetDispatchLimits();
    __seedActiveDispatchCount(2);
    expect(checkDispatchConcurrentLimit().allowed).toBe(false);
    __seedActiveDispatchCount(1);
    expect(checkDispatchConcurrentLimit().allowed).toBe(true);
    setPolicy(null);
    __resetDispatchLimits();
  });

  test("policy.dispatchRateLimit overrides the default window/max", () => {
    setPolicy({ rules: [], dispatchRateLimit: { window: 60, max: 1 } });
    __resetDispatchLimits();
    expect(checkDispatchRateLimit().allowed).toBe(true);
    recordDispatch();
    const second = checkDispatchRateLimit();
    expect(second.allowed).toBe(false);
    expect(second.reason).toContain("dispatch rate limit exceeded");
    setPolicy(null);
    __resetDispatchLimits();
  });
});
