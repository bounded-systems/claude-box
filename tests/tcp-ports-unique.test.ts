/**
 * TCP_PORTS is a small, manually-curated map — nothing catches two entries
 * picking the same literal port until they collide at merge time. Confirmed
 * live: `pathbased` and `beadsd` were both added as `3004` in concurrent PRs
 * and only surfaced as a merge conflict, not a test failure.
 *
 *   nix run nixpkgs#bun -- test tests/tcp-ports-unique.test.ts
 */
import { test, expect } from "bun:test";
import { TCP_PORTS } from "../claude-box.ts";

test("every TCP_PORTS entry is a distinct port", () => {
  const entries = Object.entries(TCP_PORTS);
  const seen = new Map<number, string>();
  for (const [name, port] of entries) {
    const existing = seen.get(port);
    expect(existing, `port ${port} claimed by both "${existing}" and "${name}"`).toBeUndefined();
    seen.set(port, name);
  }
});
