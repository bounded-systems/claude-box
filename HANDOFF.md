# Handoff — capability-aware provenance work

Pickup brief for continuing the provenance work in a shell that has **both**
`bounded-systems/claude-box` and `bounded-systems/ocap-provenance` in scope.
(The session that authored this could only reach `claude-box`, so it could not
seed or pin the upstream repo.) Remove this file before merging PR #2.

## Status

| Thing | State |
|---|---|
| **PR #1** — OCAP capability surface (doors → generic `--door` → per-launch manifest) | open, ready for review |
| **PR #2** — provenance contract + L1 generator (this branch) | open, draft |
| **`ocap-provenance`** — the shared contract repo | **seeded** (contract at repo root) |
| L1 image attestation generator (`provenance.ts`, `nix run .#provenance`) | implemented, 6 tests green |
| L2 (launch attestation) / L3 (git-write binding) | **not started** — live in keeperd |

The contract (`CapabilityProvenance/v0.1`): one in-toto predicate, three levels
linked by digest — see `contract/CHAIN.md`. L1 = image (producer = nix flake,
capabilities empty); L2 = launch (keeper signs, binds `$CLAUDE_BOX_CAPABILITIES`
+ image digest); L3 = git write (keeper re-binds the same `manifestDigest`).

## Invariants — do not break

- **`contract/types.ts` and `contract/capability-provenance.v0.1.schema.json`
  are byte-for-byte identical to `ocap-provenance`.** That identity *is* the
  pin. Never edit them in only one repo. Edit upstream, then re-vendor.
- **L1 capabilities are empty by design** — a built image holds no granted
  doors; authority is only ever added at launch. Tests assert this.
- **`manifestDigest` is the chain binding** — sha256 of the
  `$CLAUDE_BOX_CAPABILITIES` JSON, identical at L2 and L3. That equality is what
  ties a signed commit to the authority the launch held.
- `provenance.ts` runs **two ways**: `nix run .#provenance` *and* plain
  `bun test` (offline). Tests import `../contract/types.ts` relatively, so a
  local copy of the types must exist in claude-box regardless — hence "pinned
  mirror," not "fetch-only."

## Task A — claude-box: pin the vendored contract to upstream

Goal: declare `claude-box/contract/` a *pinned mirror* of the now-canonical
`ocap-provenance`, without breaking offline tests.

> **Partly done:** `contract/README.md` has already been reframed as a
> pinned-mirror note. **Remaining:** (1) confirm `types.ts` + schema are
> byte-identical to upstream, (2) lock the real commit SHA in
> `contract/README.md` (`**Pinned at:** ocap-provenance@<commit>`), (3) the
> optional CI drift-guard below.

```bash
cd claude-box && git checkout claude/fervent-sagan-1eiu17-provenance
SHA=$(git -C ../ocap-provenance rev-parse HEAD)

# 1) Confirm the vendored types/schema are byte-identical to upstream (the pin).
diff -u contract/types.ts                        ../ocap-provenance/types.ts
diff -u contract/capability-provenance.v0.1.schema.json \
        ../ocap-provenance/capability-provenance.v0.1.schema.json
# (must be empty; if not, reconcile upstream-first, then re-copy)
```

Then rewrite `contract/README.md` to a mirror note (do **not** touch
`types.ts` / the schema):

> **Pinned mirror.** This directory mirrors
> `github.com/bounded-systems/ocap-provenance` @ `<SHA>` — the canonical home of
> the `CapabilityProvenance/v0.1` contract. `types.ts` and the schema are kept
> byte-for-byte identical so consumers pin the same bytes; **do not edit them
> here** — change upstream, bump the pinned SHA, and re-vendor. A local copy
> exists only so offline tooling (`bun test`, `nix run .#provenance`) resolves
> the types without a network fetch.

Substitute the real `$SHA`. Then:

```bash
git commit -am "chore(provenance): pin contract/ as a mirror of ocap-provenance@<SHA>"
git push
```

Update PR #2's description: the contract now lives upstream; claude-box carries
the pinned mirror.

### Task A+ (optional, stronger) — CI-enforced pin

Add `ocap-provenance` as a `flake = false` input and a `nix flake check` that
asserts the vendored copy matches the pinned input byte-for-byte. This makes
drift a CI failure while keeping offline imports working. Validate with
`nix flake check` on a machine with network (not the authoring session).

```nix
inputs.ocap-provenance = {
  url = "github:bounded-systems/ocap-provenance/<SHA>";
  flake = false;
};
# checks.<sys>.contract-pin = runCommand … { diff vendored vs ${ocap-provenance} }
```

## Task B — ocap-provenance: tag the version (optional)

The predicate is `…/v0.1` (pre-stable). Consider `git tag v0.1` so consumers can
pin a tag as well as a SHA. Breaking changes bump the predicateType URI to
`/v0.2` (new path, not a mutation).

## Task C — keeperd: implement L2 + L3 (the rest of the chain)

keeperd is the git-write daemon (unix socket `/tmp/keeperd.sock`) that owns
push/ref writes **and the keeper signing key**. It pins the same `contract/`
(vendor it as a pinned mirror too, or consume via the flake input).

**L2 — launch attestation** (claude-box launcher requests; keeperd signs):
- The launcher (`claude-box.ts`) already computes the manifest and exports
  `$CLAUDE_BOX_CAPABILITIES` from the **door registry** (single source of
  truth). On launch it asks keeperd to sign an L2 statement:
  - `subject` = launch id = `{ image digest + nonce }`
  - `predicate.level = "launch"`, `producer = { kind: "keeperd", id }`
  - `predicate.capabilities` = the manifest: `manifestDigest` (sha256 of the
    `$CLAUDE_BOX_CAPABILITIES` JSON) + granted `doors[]` + `denied[]`
  - `predicate.links` → the L1 image digest
- keeperd signs with the keeper key (no new key infra; it already signs writes).

**L3 — git-write attestation** (keeperd, on every commit/push it performs):
- `subject` = the git object sha it just produced
- `predicate.level = "write"`, `capabilities.manifestDigest` = **the same digest
  as the L2 launch** (the binding), `links` → the L2 launch digest
- signed by the keeper key.

**Verification** a consumer runs: L1 image matches a `CapabilityProvenance`
statement (producer = expected flake rev, materials = `flake.lock`); L3 commit
links via `manifestDigest` → L2 launch → L1 image; keeper sigs valid at L2/L3;
policy check that the attested `capabilities` match what the write's target
required (e.g. a `main` write came from a box that actually held `--keeper` and
nothing it shouldn't). Full description: `contract/CHAIN.md` § Verification.

## Key files (claude-box)

- `provenance.ts` — L1 generator. `buildImageProvenance({ imageDigest, … })`;
  CLI `nix run .#provenance -- --image-digest sha256:<hex>`. Materials pulled
  from `flake.lock` (nixpkgs) + `flake.nix` (prx release).
- `tests/provenance.test.ts` — 6 pure tests (no nix/podman).
- `flake.nix` — `apps.aarch64-darwin.provenance` + the `provenance` package.
- `contract/` — the pinned-mirror contract (README, CHAIN.md, types.ts, schema).
- `CAPABILITIES.md` — the OCAP surface narrative; `claude-box.ts` — the launcher
  + door registry that emits `$CLAUDE_BOX_CAPABILITIES`.
