/**
 * L1 image-provenance tests — assert the generator emits a valid
 * CapabilityProvenance/v0.1 statement from the real flake.lock / flake.nix.
 * Pure: no nix build, no podman; the image digest is supplied (it only exists
 * post-build).
 *
 *   nix run nixpkgs#bun -- test tests/provenance.test.ts
 */
import { test, expect } from "bun:test";
import { buildImageProvenance } from "../provenance.ts";
import { PREDICATE_TYPE, IN_TOTO_STATEMENT_TYPE } from "../contract/types.ts";

const DIGEST = "sha256:" + "a".repeat(64);
const REV = "68b84642d7fc79c9cd68e77f3625b2f88ab07cbf";

async function stmt() {
  return buildImageProvenance({ root: ".", imageDigest: DIGEST, flakeRev: REV });
}

test("emits an in-toto Statement carrying the contract predicate type", async () => {
  const s = await stmt();
  expect(s._type).toBe(IN_TOTO_STATEMENT_TYPE);
  expect(s.predicateType).toBe(PREDICATE_TYPE);
});

test("subject is the image digest (sha256 hex, prefix stripped)", async () => {
  const s = await stmt();
  expect(s.subject[0]!.digest.sha256).toBe("a".repeat(64));
});

test("producer is the pinned flake rev; level is image", async () => {
  const s = await stmt();
  expect(s.predicate.level).toBe("image");
  expect(s.predicate.producer.kind).toBe("nix-flake");
  expect(s.predicate.producer.id).toBe(`git+rev:${REV}`);
});

test("capabilities are EMPTY at build time (authority is added at launch)", async () => {
  const s = await stmt();
  expect(s.predicate.capabilities?.doors).toEqual([]);
  expect(s.predicate.capabilities?.denied).toEqual([]);
});

test("materials carry the pinned inputs: nixpkgs rev + prx release", async () => {
  const s = await stmt();
  const uris = (s.predicate.materials ?? []).map((m) => m.uri);
  // the nixpkgs rev pinned in flake.lock
  expect(uris.some((u) => u.includes("bb813de6d2241bcb1b5af2d3059f560c66329967"))).toBe(true);
  // the prx release pinned in flake.nix
  expect(uris.some((u) => u.includes("prx/releases/download"))).toBe(true);
});

test("rejects a non-sha256 image digest", async () => {
  await expect(buildImageProvenance({ root: ".", imageDigest: "deadbeef", flakeRev: REV })).rejects.toThrow();
});
