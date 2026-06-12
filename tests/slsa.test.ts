/**
 * slsa.ts tests — verify SLSA Provenance v1 conversion.
 */

import { describe, test, expect } from "bun:test";
import { statement, PREDICATE_TYPE, IN_TOTO_STATEMENT_TYPE } from "../contract/types";
import type { CapabilityProvenance, CapabilityProvenanceStatement } from "../contract/types";
import { toSLSA, fromSLSA, SLSA_PROVENANCE_V1, BUILD_TYPES } from "../contract/slsa";

describe("SLSA conversion", () => {
  const samplePredicate: CapabilityProvenance = {
    level: "launch",
    producer: { kind: "keeperd", id: "keeperd-instance-1" },
    image: { name: "claude-personal:dev", digest: { sha256: "abc123def456" } },
    capabilities: {
      workcell: "claude-box",
      manifestDigest: { sha256: "manifest789" },
      doors: [
        { name: "keeper", socket: "/run/keeperd.sock", grants: "signed git writes" },
        { name: "net", socket: "/run/netd.sock", grants: "policed egress" },
      ],
      denied: [{ name: "beads" }, { name: "launcher" }],
    },
    links: [{ level: "image", digest: { sha256: "abc123def456" } }],
    metadata: {
      invocationId: "box-test-123",
      startedOn: "2024-01-15T10:30:00Z",
    },
  };

  const sampleStatement = statement(
    [{ name: "launch-id", digest: { sha256: "launch456" } }],
    samplePredicate
  );

  describe("toSLSA", () => {
    test("converts to SLSA Provenance v1 predicateType", () => {
      const slsa = toSLSA(sampleStatement);

      expect(slsa._type).toBe(IN_TOTO_STATEMENT_TYPE);
      expect(slsa.predicateType).toBe(SLSA_PROVENANCE_V1);
    });

    test("maps level to buildType", () => {
      const slsa = toSLSA(sampleStatement);

      expect(slsa.predicate.buildDefinition.buildType).toBe(BUILD_TYPES.launch);
    });

    test("puts capabilities in externalParameters", () => {
      const slsa = toSLSA(sampleStatement);
      const caps = slsa.predicate.buildDefinition.externalParameters.capabilities as any;

      expect(caps.workcell).toBe("claude-box");
      expect(caps.manifestDigest.sha256).toBe("manifest789");
      expect(caps.doors).toHaveLength(2);
      expect(caps.doors[0].name).toBe("keeper");
      expect(caps.denied).toHaveLength(2);
    });

    test("puts image in externalParameters", () => {
      const slsa = toSLSA(sampleStatement);
      const image = slsa.predicate.buildDefinition.externalParameters.image as any;

      expect(image.name).toBe("claude-personal:dev");
      expect(image.digest.sha256).toBe("abc123def456");
    });

    test("maps producer to builder", () => {
      const slsa = toSLSA(sampleStatement);

      expect(slsa.predicate.runDetails.builder.id).toBe("https://claude.ai/builders/keeperd/v1");
      expect(slsa.predicate.runDetails.builder.version?.ref).toBe("keeperd-instance-1");
    });

    test("preserves metadata", () => {
      const slsa = toSLSA(sampleStatement);

      expect(slsa.predicate.runDetails.metadata?.invocationId).toBe("box-test-123");
      expect(slsa.predicate.runDetails.metadata?.startedOn).toBe("2024-01-15T10:30:00Z");
    });

    test("puts chain links in ocap_links extension", () => {
      const slsa = toSLSA(sampleStatement);

      expect(slsa.predicate.runDetails.ocap_links).toHaveLength(1);
      expect(slsa.predicate.runDetails.ocap_links![0].level).toBe("image");
      expect(slsa.predicate.runDetails.ocap_links![0].digest.sha256).toBe("abc123def456");
    });

    test("preserves subject", () => {
      const slsa = toSLSA(sampleStatement);

      expect(slsa.subject).toHaveLength(1);
      expect(slsa.subject[0].name).toBe("launch-id");
      expect(slsa.subject[0].digest?.sha256).toBe("launch456");
    });
  });

  describe("fromSLSA (round-trip)", () => {
    test("round-trips back to equivalent CapabilityProvenance", () => {
      const slsa = toSLSA(sampleStatement);
      const roundTrip = fromSLSA(slsa);

      expect(roundTrip._type).toBe(IN_TOTO_STATEMENT_TYPE);
      expect(roundTrip.predicateType).toBe(PREDICATE_TYPE);
      expect(roundTrip.predicate.level).toBe("launch");
      expect(roundTrip.predicate.producer.kind).toBe("keeperd");
    });

    test("preserves capabilities through round-trip", () => {
      const slsa = toSLSA(sampleStatement);
      const roundTrip = fromSLSA(slsa);

      expect(roundTrip.predicate.capabilities?.workcell).toBe("claude-box");
      expect(roundTrip.predicate.capabilities?.doors).toHaveLength(2);
      expect(roundTrip.predicate.capabilities?.denied).toHaveLength(2);
    });

    test("preserves links through round-trip", () => {
      const slsa = toSLSA(sampleStatement);
      const roundTrip = fromSLSA(slsa);

      expect(roundTrip.predicate.links).toHaveLength(1);
      expect(roundTrip.predicate.links![0].level).toBe("image");
    });

    test("preserves subject through round-trip", () => {
      const slsa = toSLSA(sampleStatement);
      const roundTrip = fromSLSA(slsa);

      expect(roundTrip.subject).toHaveLength(1);
      expect(roundTrip.subject[0].digest.sha256).toBe("launch456");
    });
  });

  describe("all levels", () => {
    test("image level uses correct buildType", () => {
      const imageStmt = statement(
        [{ digest: { sha256: "image123" } }],
        { level: "image", producer: { kind: "nix-flake", id: "abc123" } }
      );
      const slsa = toSLSA(imageStmt);

      expect(slsa.predicate.buildDefinition.buildType).toBe(BUILD_TYPES.image);
    });

    test("write level uses correct buildType", () => {
      const writeStmt = statement(
        [{ digest: { sha256: "commit456" } }],
        { level: "write", producer: { kind: "keeperd", id: "keeper-1" } }
      );
      const slsa = toSLSA(writeStmt);

      expect(slsa.predicate.buildDefinition.buildType).toBe(BUILD_TYPES.write);
    });
  });
});
