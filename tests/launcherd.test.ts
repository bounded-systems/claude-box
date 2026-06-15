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
  generateLaunchId,
  sha256,
  loadOrCreateKey,
  buildL2Attestation,
} from "../launcherd";
import type { RequestEnvelope, ResponseEnvelope, SigningKey } from "../launcherd";
import { PREDICATE_TYPE, IN_TOTO_STATEMENT_TYPE } from "../contract/types";

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

    test("launch rejects invalid account", async () => {
      const resp = await handleRequest(
        JSON.stringify({ id: "test-6", method: "launch", params: { account: "../escape" } })
      );
      expect(resp.ok).toBe(false);
      expect(resp.error?.code).toBe("INVALID_ACCOUNT");
    });

    test("launch rejects unknown room", async () => {
      const resp = await handleRequest(
        JSON.stringify({ id: "test-7", method: "launch", params: { account: "test", room: "nonexistent" } })
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
          params: { account: "test", doors: ["keeper"] },
        })
      );
      expect(resp.ok).toBe(false);
      // Either DOORS_UNREACHABLE (socket exists but unreachable) or ENOENT (socket doesn't exist)
      expect(["DOORS_UNREACHABLE", "ENOENT"]).toContain(resp.error?.code ?? "");
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
    const manifest = buildManifest("test", mockLaunch);
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

describe("attenuation (child ⊆ parent)", () => {
  const { checkAttenuation } = require("../launcherd");

  test("root launches (depth 0) always pass", () => {
    // Even with no parent doors, depth 0 passes (it's the root)
    const result = checkAttenuation(["keeper", "net", "scout"], undefined, 0);
    expect(result.allowed).toBe(true);
  });

  test("child with subset of parent doors passes", () => {
    // Parent has keeper, net, scout; child requests only keeper
    const result = checkAttenuation(
      ["keeper"],
      ["keeper", "net", "scout"],
      1
    );
    expect(result.allowed).toBe(true);
    expect(result.violations).toBeUndefined();
  });

  test("child with exact parent doors passes", () => {
    // Child requests same doors as parent
    const result = checkAttenuation(
      ["keeper", "net", "scout"],
      ["keeper", "net", "scout"],
      1
    );
    expect(result.allowed).toBe(true);
  });

  test("child with empty doors passes", () => {
    // Child requests no doors (most restrictive)
    const result = checkAttenuation(
      [],
      ["keeper", "net", "scout"],
      2
    );
    expect(result.allowed).toBe(true);
  });

  test("child requesting door parent lacks fails", () => {
    // Parent has only net; child requests keeper (escalation attempt)
    const result = checkAttenuation(
      ["keeper", "net"],
      ["net"],
      1
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("attenuation violation");
    expect(result.violations).toEqual(["keeper"]);
  });

  test("multiple violations are all reported", () => {
    // Parent has only net; child requests keeper, scout, launcher
    const result = checkAttenuation(
      ["keeper", "net", "scout", "launcher"],
      ["net"],
      1
    );
    expect(result.allowed).toBe(false);
    expect(result.violations).toContain("keeper");
    expect(result.violations).toContain("scout");
    expect(result.violations).toContain("launcher");
    expect(result.violations).not.toContain("net"); // net is allowed
  });

  test("depth > 0 with undefined parentDoors passes (lenient fallback)", () => {
    // This handles the case where parent info isn't available
    // (e.g., legacy callers or root-equivalent contexts)
    const result = checkAttenuation(["keeper"], undefined, 1);
    expect(result.allowed).toBe(true);
  });

  test("nested children (depth > 1) still enforce attenuation", () => {
    // Depth 3 child still needs subset of parent doors
    const result = checkAttenuation(
      ["launcher"], // child wants launcher
      ["keeper", "net"], // parent doesn't have launcher
      3
    );
    expect(result.allowed).toBe(false);
    expect(result.violations).toEqual(["launcher"]);
  });
});

describe("attenuation is caveat-aware (child cannot drop a parent caveat)", () => {
  const { checkAttenuation } = require("../launcherd");

  test("child KEEPS the parent's caveat → attenuates (allowed)", () => {
    const r = checkAttenuation(
      [{ name: "scout", caveats: ["host=github.com"] }],
      [{ name: "scout", caveats: ["host=github.com"] }],
      1,
    );
    expect(r.allowed).toBe(true);
  });

  test("child ADDS a caveat (keeps parent's) → still attenuates", () => {
    const r = checkAttenuation(
      [{ name: "scout", caveats: ["host=github.com", "mode=readonly"] }],
      [{ name: "scout", caveats: ["host=github.com"] }],
      1,
    );
    expect(r.allowed).toBe(true);
  });

  test("KEYSTONE: child DROPS the parent's caveat → widens → violation", () => {
    const r = checkAttenuation(
      [{ name: "scout" }], // no caveat = wider than parent's restricted scout
      [{ name: "scout", caveats: ["host=github.com"] }],
      1,
    );
    expect(r.allowed).toBe(false);
    expect(r.violations).toEqual(["scout"]);
    expect(r.reason).toContain("drops caveats");
    expect(r.reason).toContain("host=github.com");
  });

  test("name-only specs still behave as a subset check (back-compat)", () => {
    expect(checkAttenuation(["scout"], ["scout", "net"], 1).allowed).toBe(true);
    expect(checkAttenuation(["keeper"], ["net"], 1).allowed).toBe(false);
  });
});

describe("attenuation via handleRequest", () => {
  const { handleRequest, setPolicy } = require("../launcherd");

  // Ensure no policy for these tests
  setPolicy(null);

  test("launch with depth>0 and _parentDoors enforces attenuation", async () => {
    // Request launch at depth 1 with doors not in parent
    const resp = await handleRequest(
      JSON.stringify({
        id: "att-1",
        method: "launch",
        params: {
          account: "test",
          doors: ["keeper", "net"],
          depth: 1,
          _parentDoors: ["net"], // parent only has net
        },
      })
    );

    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("ATTENUATION_VIOLATION");
    expect(resp.error?.message).toContain("keeper");
  });

  test("launch with valid attenuation proceeds to door check", async () => {
    // Request subset of parent doors - should pass attenuation but fail on door check
    const resp = await handleRequest(
      JSON.stringify({
        id: "att-2",
        method: "launch",
        params: {
          account: "test",
          doors: ["net"],
          depth: 1,
          _parentDoors: ["keeper", "net", "scout"],
        },
      })
    );

    // Should fail at door-check stage, not ATTENUATION_VIOLATION
    // (either DOORS_UNREACHABLE or ENOENT depending on socket existence)
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).not.toBe("ATTENUATION_VIOLATION");
    expect(["DOORS_UNREACHABLE", "ENOENT"]).toContain(resp.error?.code);
  });

  test("room expansion is checked against parent doors", async () => {
    // Request dev room (keeper, net, scout) but parent only has net
    const resp = await handleRequest(
      JSON.stringify({
        id: "att-3",
        method: "launch",
        params: {
          account: "test",
          room: "dev",
          depth: 1,
          _parentDoors: ["net"],
        },
      })
    );

    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("ATTENUATION_VIOLATION");
    // Dev room expands to keeper, net, scout - keeper and scout should be violations
    expect(resp.error?.message).toContain("keeper");
    expect(resp.error?.message).toContain("scout");
  });

  test("child dropping a parent's door caveat is refused over the wire", async () => {
    // Parent's scout is restricted to host=github.com; child requests scout with
    // no caveat → it would WIDEN authority → ATTENUATION_VIOLATION.
    const resp = await handleRequest(
      JSON.stringify({
        id: "att-cav-1",
        method: "launch",
        params: {
          account: "test",
          doors: ["scout"],
          depth: 1,
          _parentDoors: [{ name: "scout", caveats: ["host=github.com"] }],
        },
      }),
    );
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("ATTENUATION_VIOLATION");
    expect(resp.error?.message).toContain("scout");
    expect(resp.error?.message).toContain("host=github.com");
  });

  test("child keeping the parent's caveat passes attenuation (then door check)", async () => {
    // Child requests scout WITH the parent's caveat → attenuation OK; proceeds to
    // the door-reachability stage (which fails in the test env, not ATTENUATION).
    const resp = await handleRequest(
      JSON.stringify({
        id: "att-cav-2",
        method: "launch",
        params: {
          account: "test",
          doors: ["scout"],
          caveats: { scout: ["host=github.com"] },
          depth: 1,
          _parentDoors: [{ name: "scout", caveats: ["host=github.com"] }],
        },
      }),
    );
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).not.toBe("ATTENUATION_VIOLATION");
    expect(["DOORS_UNREACHABLE", "ENOENT"]).toContain(resp.error?.code);
  });
});

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
});
