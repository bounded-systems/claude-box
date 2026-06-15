/**
 * L1 image-provenance tests — assert the generator emits a valid
 * SLSA Provenance v1 statement from the real flake.lock / flake.nix.
 * Pure: no nix build, no podman; the image digest is supplied (it only exists
 * post-build).
 *
 *   nix run nixpkgs#bun -- test tests/provenance.test.ts
 */
import { test, expect, describe } from "bun:test";
import { buildImageProvenance, buildImageProvenanceOCAP } from "../provenance.ts";
import { PREDICATE_TYPE, IN_TOTO_STATEMENT_TYPE } from "../contract/types.ts";
import { SLSA_PROVENANCE_V1, BUILD_TYPES } from "../contract/slsa.ts";

const DIGEST = "sha256:" + "a".repeat(64);
const REV = "68b84642d7fc79c9cd68e77f3625b2f88ab07cbf";

async function slsaStmt() {
  return buildImageProvenance({ root: ".", imageDigest: DIGEST, flakeRev: REV });
}

async function ocapStmt() {
  return buildImageProvenance({ root: ".", imageDigest: DIGEST, flakeRev: REV, format: "ocap" });
}

describe("SLSA Provenance v1 format (default)", () => {
  test("emits an in-toto Statement with SLSA Provenance v1 predicate type", async () => {
    const s = await slsaStmt();
    expect(s._type).toBe(IN_TOTO_STATEMENT_TYPE);
    expect(s.predicateType).toBe(SLSA_PROVENANCE_V1);
  });

  test("buildType is ocap-image", async () => {
    const s = await slsaStmt() as any;
    expect(s.predicate.buildDefinition.buildType).toBe(BUILD_TYPES.image);
  });

  test("subject is the image digest (sha256 hex, prefix stripped)", async () => {
    const s = await slsaStmt();
    expect(s.subject[0]!.digest?.sha256).toBe("a".repeat(64));
  });

  test("builder is the pinned flake rev", async () => {
    const s = await slsaStmt() as any;
    expect(s.predicate.runDetails.builder.id).toBe("https://claude.ai/builders/nix-flake/v1");
    expect(s.predicate.runDetails.builder.version?.ref).toBe(`git+rev:${REV}`);
  });

  test("capabilities are EMPTY at build time (in externalParameters)", async () => {
    const s = await slsaStmt() as any;
    const caps = s.predicate.buildDefinition.externalParameters.capabilities;
    expect(caps?.doors).toEqual([]);
    expect(caps?.denied).toEqual([]);
  });

  test("resolvedDependencies carry the pinned inputs", async () => {
    const s = await slsaStmt() as any;
    const deps = s.predicate.buildDefinition.resolvedDependencies ?? [];
    const uris = deps.map((d: any) => d.uri);
    // the nixpkgs rev pinned in flake.lock
    expect(uris.some((u: string) => u.includes("9f11f828c213641c2369a9f1fa31fe31557e3156"))).toBe(true);
    // the prx release pinned in flake.nix
    expect(uris.some((u: string) => u.includes("prx/releases/download"))).toBe(true);
  });
});

describe("OCAP format (--format=ocap)", () => {
  test("emits CapabilityProvenance/v0.1 predicate type", async () => {
    const s = await ocapStmt();
    expect(s._type).toBe(IN_TOTO_STATEMENT_TYPE);
    expect(s.predicateType).toBe(PREDICATE_TYPE);
  });

  test("level is image", async () => {
    const s = await ocapStmt() as any;
    expect(s.predicate.level).toBe("image");
  });

  test("producer is the pinned flake rev", async () => {
    const s = await ocapStmt() as any;
    expect(s.predicate.producer.kind).toBe("nix-flake");
    expect(s.predicate.producer.id).toBe(`git+rev:${REV}`);
  });
});

test("rejects a non-sha256 image digest", async () => {
  await expect(buildImageProvenance({ root: ".", imageDigest: "deadbeef", flakeRev: REV })).rejects.toThrow();
});
