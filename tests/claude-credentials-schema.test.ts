/**
 * Drift guard between schemas/claude-credentials.schema.json and authd.ts's
 * actual runtime validator (parseClaudeCredentials). Plain bun test, no
 * external JSON Schema library and no Nix build step (this repo ships zero
 * npm dependencies by design) — just enough to catch the schema and the
 * validator disagreeing about what's required.
 *
 *   nix run nixpkgs#bun -- test tests/claude-credentials-schema.test.ts
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeCredentials } from "../authd.ts";

const schema = JSON.parse(
  readFileSync(join(import.meta.dir, "../schemas/claude-credentials.schema.json"), "utf-8"),
);

const validCred = {
  claudeAiOauth: {
    accessToken: "sk-ant-oat01-test",
    refreshToken: "sk-ant-ort01-test",
    expiresAt: Date.now() + 60_000,
    scopes: ["user:inference"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
  },
  oauthAccount: { organizationUuid: "org-test" },
};

describe("claude-credentials.schema.json ↔ authd.ts's parseClaudeCredentials", () => {
  test("a fully valid credential (matching the schema's own example shape) parses", () => {
    expect(parseClaudeCredentials(JSON.stringify(validCred)).claudeAiOauth.accessToken).toBe(
      "sk-ant-oat01-test",
    );
  });

  test("every field the schema marks required under claudeAiOauth is actually enforced", () => {
    const required: string[] = schema.properties.claudeAiOauth.required;
    expect(required.length).toBeGreaterThan(0); // guards against an accidentally-emptied schema
    for (const field of required) {
      const broken = structuredClone(validCred) as Record<string, unknown>;
      delete (broken.claudeAiOauth as Record<string, unknown>)[field];
      expect(() => parseClaudeCredentials(JSON.stringify(broken))).toThrow();
    }
  });

  test("the schema itself requires claudeAiOauth at the top level, matching the validator", () => {
    expect(schema.required).toContain("claudeAiOauth");
    expect(() => parseClaudeCredentials(JSON.stringify({}))).toThrow();
  });

  test("oauthAccount is optional in both the schema and the validator", () => {
    expect(schema.required).not.toContain("oauthAccount");
    const { oauthAccount: _drop, ...withoutOauthAccount } = validCred;
    expect(() => parseClaudeCredentials(JSON.stringify(withoutOauthAccount))).not.toThrow();
  });
});
