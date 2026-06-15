# CHECK-CAVEATS — making guest-room's attenuation *enforced*, not just *rendered*

> Status: **IMPLEMENTED.** `checkCaveats` shipped in guest-room#2 and mirrored
> here (claude-box#96); scoutd enforces through it (claude-box#99); the live-DENY
> OCAP proof is `tests/scoutd.ocap.test.ts`. Canonical home is
> `bounded-systems/guest-room` — engine changes land upstream first, then mirror
> via `nix run .#sync-guest-room`. Do not hand-edit the read-only mirror.
> The sections below are the original design record, kept for the rationale.

## 1. The OCAP gap

guest-room's capability story is currently half-enforced:

| Layer | Today |
|---|---|
| Capability = unforgeable reference (a door is a socket) | ✅ enforced by construction — no socket, no call |
| Attenuation (`attenuate`, `parseCaveat`, `grantedDoorLines`) | ⚠️ **rendered, never checked** — the engine carries caveats and prints "RESTRICTED to: host=github.com" into the rulebook |
| Per-request allow/deny (scoutd `allowed()`, launcherd `child ⊆ parent`) | ✅ real, but **ad-hoc and daemon-ambient** — derived from `SCOUTD_ALLOW`/`DEFAULT_ALLOW`, *not* from the door's `caveats` |

The door grant the agent is *told about* (`grantedDoorLines` → "RESTRICTED to: host=github.com") and the policy that is *actually enforced* (`scoutd.ts:64 allowed()` against the `ALLOW` env list) are **two independently-maintained lists**. They can drift: a door rendered as `host=github.com` is in fact gated by whatever `SCOUTD_ALLOW` happens to say. For an OCAP system the whole claim is **granted == enforced, by construction** — that is the property this primitive restores.

## 2. The hard constraint: the engine must stay guest-agnostic

`mod.ts` is explicit (lines 100, 107–108, 178–181): the engine **carries and renders** caveats but **never interprets** them — "the broker behind the door enforces it, and the catalog owner owns its grammar." A `checkCaveat` that knew what `host=` *means* would couple the engine to scoutd's vocabulary and break the seam test (`the engine source names no guest`).

The caveats are already described as **macaroon-shaped** (line 180). So the correct split is the macaroon split:

- **Engine owns the combinator** — the conjunction rule, and *fail-closed on any caveat it cannot get a verdict for*. This is the part that delivers the OCAP guarantee, and it is fully guest-agnostic (it never reads a caveat's value).
- **Daemon owns the predicates** — one verifier per caveat key it understands (`host`, `mode`, …). scoutd owns what `host=` means; the engine does not.

## 3. The primitive (engine, `mod.ts`)

```ts
/** Interprets ONE caveat's value against a request context. Returns true if
 *  satisfied. The catalog owner (daemon) supplies these; the engine never reads
 *  `value` itself, so it stays guest-agnostic. */
export type CaveatVerifier<Ctx> = (value: string, ctx: Ctx) => boolean;

/** The verifier set a daemon registers — keyed by caveat key. */
export type CaveatVerifiers<Ctx> = Record<string, CaveatVerifier<Ctx>>;

export type CaveatVerdict =
  | { ok: true }
  | { ok: false; caveat: string; reason: "unsatisfied" | "uninterpretable" };

/** Enforce a door's caveats against a request. Fail-closed by construction:
 *   - no caveats            → ok      (coarse capability already gated reach)
 *   - caveat won't parse    → DENY    (reason: "uninterpretable")
 *   - no verifier for key   → DENY    (reason: "uninterpretable") ← keystone
 *   - verifier returns false → DENY   (reason: "unsatisfied")
 *   - every caveat passes    → ok     (conjunction = append-only narrowing)
 *  The engine owns the conjunction + fail-closed rule. It never reads a caveat
 *  value, so it carries no guest grammar. */
export function checkCaveats<Ctx>(
  grant: DoorGrant,
  ctx: Ctx,
  verifiers: CaveatVerifiers<Ctx>,
): CaveatVerdict {
  for (const raw of grant.caveats ?? []) {
    const parsed = parseCaveat(raw);
    if (!parsed) return { ok: false, caveat: raw, reason: "uninterpretable" };
    const verify = verifiers[parsed.key];
    if (!verify) return { ok: false, caveat: raw, reason: "uninterpretable" };
    if (!verify(parsed.value, ctx)) return { ok: false, caveat: raw, reason: "unsatisfied" };
  }
  return { ok: true };
}
```

### Semantics that matter

- **Fail-closed on an unknown caveat key is the keystone.** Today an undeclared/uninterpretable constraint is silently *allowed*; here it *denies*. "You must not allow what you cannot interpret" is what makes the rendered rulebook honest.
- **Across caveats = AND (intersection); within a value = OR (daemon grammar).** An 8-host allowlist is *one* caveat `host=github.com,.github.com,pypi.org,…` whose verifier splits the value and ORs the patterns. Adding a *second* `host=` caveat intersects the two sets → strictly narrower, preserving the append-only monotonicity invariant `attenuate` guarantees. (A naive "one caveat per host under pure conjunction" would deny everything — documented here so the upstream impl doesn't fall into it.)

## 4. First caller: scoutd (`scoutd.ts`)

scoutd's `allowed()` / `ALLOW` becomes a **verifier over the door's caveats**, not a separate ambient list:

```ts
import { checkCaveats, type CaveatVerifiers } from "./guest-room/mod.ts";

// daemon owns the `host` grammar; OR within the value, exact + .suffix match
const hostMatches = (hostname: string, pattern: string): boolean => {
  const h = hostname.toLowerCase();
  return pattern.split(",").map((s) => s.trim()).filter(Boolean).some((a) =>
    a.startsWith(".") ? h === a.slice(1) || h.endsWith(a) : h === a);
};

const SCOUT_VERIFIERS: CaveatVerifiers<{ hostname: string }> = {
  host: (value, ctx) => hostMatches(ctx.hostname, value),
};

// in handleFetch / handleDownload (replaces the bespoke `allowed()` call):
const verdict = checkCaveats(scoutDoor, { hostname: parsed.hostname }, SCOUT_VERIFIERS);
if (!verdict.ok) {
  log("DENY", `fetch ${url} (${verdict.caveat}: ${verdict.reason})`);
  throw { code: "NOT_ALLOWED", message: `denied by caveat ${verdict.caveat}` };
}
log("ALLOW", `fetch ${url}`);
```

The source of truth flips: the allowlist now lives in `scoutDoor.caveats` — **the same array `grantedDoorLines` renders into the agent's rulebook.** Granted == enforced. (`SCOUTD_ALLOW` can still seed the door's `host=` caveat at launch, but it is no longer a second, hidden policy path.)

## 5. The failing test (executable spec — lands in `bounded-systems/guest-room` first)

```ts
import { test, expect, describe } from "bun:test";
import { attenuate, checkCaveats, unix, type DoorGrant, type CaveatVerifiers } from "../mod.ts";

const door = (caveats?: string[]): DoorGrant => ({
  name: "scout", host: unix("/tmp/scout.sock"), guest: unix("/run/scout.sock"),
  env: "SCOUT_SOCK", grants: "egress", use: "fetch via the socket", caveats,
});

const V: CaveatVerifiers<{ hostname: string }> = {
  host: (value, ctx) =>
    value.split(",").map((s) => s.trim()).some((a) =>
      a.startsWith(".") ? ctx.hostname === a.slice(1) || ctx.hostname.endsWith(a) : ctx.hostname === a),
};

describe("checkCaveats — granted == enforced", () => {
  test("unattenuated door allows anything (coarse capability already gated reach)", () => {
    expect(checkCaveats(door(), { hostname: "evil.com" }, V).ok).toBe(true);
  });

  test("request satisfying the caveat is ALLOWED", () => {
    const v = checkCaveats(door(["host=github.com,.github.com"]), { hostname: "api.github.com" }, V);
    expect(v.ok).toBe(true);
  });

  test("request violating the caveat is DENIED (unsatisfied)", () => {
    const v = checkCaveats(door(["host=github.com,.github.com"]), { hostname: "evil.com" }, V);
    expect(v).toEqual({ ok: false, caveat: "host=github.com,.github.com", reason: "unsatisfied" });
  });

  test("KEYSTONE: an uninterpretable caveat (no verifier) DENIES, never silently allows", () => {
    const v = checkCaveats(door(["mode=readonly"]), { hostname: "github.com" }, V);
    expect(v).toEqual({ ok: false, caveat: "mode=readonly", reason: "uninterpretable" });
  });

  test("malformed caveat (no separator) DENIES", () => {
    const v = checkCaveats(door(["garbage"]), { hostname: "github.com" }, V);
    expect(v.reason).toBe("uninterpretable");
  });

  test("conjunction: adding a caveat only narrows — intersection, never widens", () => {
    const narrowed = attenuate(door(["host=github.com,pypi.org"]), ["host=github.com"]);
    expect(checkCaveats(narrowed, { hostname: "pypi.org" }, V).ok).toBe(false); // dropped by 2nd caveat
    expect(checkCaveats(narrowed, { hostname: "github.com" }, V).ok).toBe(true);
  });
});
```

This is **red** until `checkCaveats` exists in `mod.ts` (the import fails to resolve). That is the intended TDD starting point.

## 6. Landing plan (canonical-upstream discipline)

1. In `bounded-systems/guest-room`: add the test above (red) → implement `checkCaveats` + the two exported types in `mod.ts` (green) → ship a release.
2. In claude-box: `nix flake update guest-room` → `nix run .#sync-guest-room` → the mirror picks up `checkCaveats`; commit `flake.lock` + `guest-room/` together.
3. Migrate `scoutd.ts` to route `handleFetch`/`handleDownload` (and the GitHub-API paths) through `checkCaveats`; delete the now-redundant `allowed()`/`ALLOW` enforcement path, seeding the door's `host=` caveat from `SCOUTD_ALLOW` instead.
4. **OCAP proof (the end-to-end deliverable):** boot scoutd with an attenuated scout door and assert a live `DENY` on an out-of-caveat host, with the rulebook line and the denial citing the *same* caveat.

## 7. Open questions — `[NEEDS CLARIFICATION]`

- **Multi-key OR.** Do any real doors need OR *across* keys (not just within one value)? Pure conjunction is the safe default; if a door ever needs "host=X OR mode=Y", macaroons express that with a structured caveat, not the flat k=v form. Defer until a door needs it.
- **launcherd `child ⊆ parent`.** Should the `attenuate`-monotonicity check that enforces "a sub-room's doors are never wider than the parent's" also route through this primitive, or stay a separate set-containment check? Likely separate (it compares two grant sets, not a grant vs a request) — but worth confirming so we don't grow two enforcement engines again.
- **Ctx typing across daemons.** Each daemon has its own request `Ctx` (scoutd: `{hostname}`). The engine stays generic via `<Ctx>`; confirm netd/keeperd contexts compose cleanly before locking the signature.
