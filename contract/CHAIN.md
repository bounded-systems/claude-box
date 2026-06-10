# The capability-aware provenance chain (L1 → L2 → L3)

One predicate type (`CapabilityProvenance/v0.1`), three levels, linked by digest.
Each level is an in-toto Statement: a `subject` (the thing attested) and a
`predicate` (how it came to be + **what authority was in play**). A verifier
walks the `links` back-references up the chain.

```
  L1  image            L2  launch                 L3  git write
  ───────────          ─────────────              ──────────────
  subject: the         subject: a launch id       subject: a git object
   box image digest     (image digest + nonce)     (commit / tree sha)
  producer: nix flake  producer: keeperd          producer: keeperd
  capabilities: none   capabilities: the actual   capabilities: same manifest
   (build-time)         $CLAUDE_BOX_CAPABILITIES    digest as the launch
  materials:           links: → L1 image digest   links: → L2 launch digest
   flake.lock inputs   signed by: keeper key      signed by: keeper key
  signed by: builder

        ▲                      ▲                          ▲
        └──────── links ───────┴────────── links ─────────┘
     "this commit was produced by a launch of THIS image holding EXACTLY
      these doors, built reproducibly from THIS flake."
```

## L1 — image provenance  *(lives in claude-box: `flake.nix` / CI)*

- **subject:** the `claude-personal:dev` OCI image digest.
- **producer:** `{ kind: "nix-flake", id: <flake rev> }` — the build is a pinned
  `dockerTools.buildLayeredImage`, so it is already reproducible/hermetic.
- **materials:** the `flake.lock` inputs (nixpkgs rev, prx release + sha256).
- **capabilities:** *empty* — a freshly built image holds no granted doors;
  authority is only ever added at launch. (This is the honest baseline: the
  image's default surface is "config volume only, nothing ambient.")
- **signed by:** the build identity (cosign keyless / a CI OIDC identity).

This is the plain "signed artifact" win: anyone can verify the image they run is
the one nix built from the pinned flake.

## L2 — launch attestation  *(claude-box launcher requests; keeperd signs)*

- **subject:** a launch id = `image digest + nonce` (one per `claude-box … run`).
- **predicate.capabilities:** the exact manifest the launcher computed —
  `manifestDigest` = sha256 of the `$CLAUDE_BOX_CAPABILITIES` JSON, plus the
  granted `doors[]` and `denied[]`. This is the OCAP surface, attested.
- **links:** → the L1 image digest (so the launch is tied to a known image).
- **signed by:** the **keeper key**. The launcher holds no key (that is the whole
  point); it *asks* keeperd to attest "a box launched against image X with
  manifest Y." keeperd already owns the provenance signing key — no new key
  infrastructure.

## L3 — git-write attestation  *(lives in keeperd)*

- **subject:** the git object keeperd just produced (commit / pushed ref sha).
- **predicate.capabilities.manifestDigest:** the *same* digest as the L2 launch —
  this is the binding. The signed commit carries proof of the authority context
  that requested it.
- **links:** → the L2 launch digest (→ which links → the L1 image).
- **signed by:** the keeper key (keeperd already signs every write; this adds the
  capability binding to what it signs).

## Verification (what a consumer checks)

1. L1: image digest matches a `CapabilityProvenance` statement whose producer is
   the expected flake rev, materials match `flake.lock`, signature valid.
2. L3: the commit has a statement linking (via `manifestDigest`) to an L2 launch
   that links to that L1 image; keeper signatures valid at L2 and L3.
3. Policy: the attested `capabilities` are within what the commit's target should
   have required (e.g. a write to `main` came from a box that actually held
   `--keeper`, and held nothing it shouldn't have).

The result: a single verifiable line from **reproducible image → the authority a
launch held → the signed commit** — provenance that includes *capability
context*, not just build lineage.
