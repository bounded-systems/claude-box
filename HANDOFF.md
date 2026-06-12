# Handoff — capability-aware provenance work

Pickup brief for continuing the provenance work. The contract + L1 generator are
**done and merged**; the only remaining work (Task C — keeperd L2/L3) lives in a
repo this session's scope doesn't cover. To finish it you need a shell with
**both** `bounded-systems/claude-box` and `keeperd` (and ideally
`bounded-systems/ocap-provenance`) in scope.

## Status (refreshed 2026-06-12)

| Thing | State |
|---|---|
| **PR #1** — OCAP capability surface (doors → generic `--door` → per-launch manifest) | **merged** |
| **PR #2** — provenance contract (`contract/`) + L1 generator (`provenance.ts`) | **merged** |
| **PR #3** — egress-as-a-door (`--net`) + box hardening floor | **merged** |
| **PR #8** — reframe `contract/` as a pinned mirror of `ocap-provenance` | **merged** |
| **`ocap-provenance`** — the shared contract repo (canonical home) | seeded upstream (out of this scope to re-verify) |
| L1 image attestation (`provenance.ts`, `nix run .#provenance`) | implemented, tests green |
| **L2 (launch attestation) / L3 (git-write binding)** | **not started** — live in keeperd (Task C below) |

> All four PRs above are merged; the work is durable on GitHub. The earlier
> "remove this file before merging PR #2" note is obsolete — #2 has merged. This
> file is now just a pickup brief for the one remaining task.

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

## Done — Task A / A+ / B (for the record)

- **Task A — pin `contract/` as a mirror of `ocap-provenance`.** Done. Reframe
  shipped as **PR #8**; the pin is now **locked** to
  `ocap-provenance@95167a4a9c77777fa331b967001ca5b24669acec` in
  `contract/README.md`. `types.ts` + the schema are byte-identical to upstream.
- **Task A+ — CI drift-guard.** Optional `flake = false` input + `nix flake
  check` that diffs the vendored copy against the pinned upstream. Kept here as a
  reference sketch in case it's wanted later (needs a networked machine to
  validate `nix flake check`):

  ```nix
  inputs.ocap-provenance = {
    url = "github:bounded-systems/ocap-provenance/v0.1";  # or a pinned SHA
    flake = false;
  };

  # per-system scope:
  checks.contract-pin = pkgs.runCommand "contract-pin-matches-upstream" { } ''
    set -e
    diff -u ${./contract/types.ts} ${ocap-provenance}/types.ts
    diff -u ${./contract/capability-provenance.v0.1.schema.json} \
            ${ocap-provenance}/capability-provenance.v0.1.schema.json
    touch $out
  '';
  ```

  Thread `ocap-provenance` into the per-system scope, then `nix flake lock &&
  nix flake check`, then commit `flake.nix` + `flake.lock`.
- **Task B — tag `ocap-provenance@v0.1`.** Lives in the upstream repo (out of
  this session's scope to re-verify). Treat the upstream tag as canonical.

## Task C — keeperd: implement L2 + L3 (the remaining work)

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
- `tests/provenance.test.ts` — pure tests (no nix/podman).
- `flake.nix` — `apps.aarch64-darwin.provenance` + the `provenance` package.
- `contract/` — the pinned-mirror contract (README, CHAIN.md, types.ts, schema).
- `CAPABILITIES.md` — the OCAP surface narrative; `claude-box.ts` — the launcher
  + door registry that emits `$CLAUDE_BOX_CAPABILITIES`.
