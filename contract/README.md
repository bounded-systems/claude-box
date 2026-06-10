# ocap-provenance — the shared provenance contract

**Pinned mirror.** This directory mirrors
[`github.com/bounded-systems/ocap-provenance`](https://github.com/bounded-systems/ocap-provenance)
— the canonical home of the `CapabilityProvenance/v0.1` contract. `types.ts` and
`capability-provenance.v0.1.schema.json` are kept **byte-for-byte identical** to
upstream so every consumer pins the same bytes; **do not edit them here** —
change upstream, then re-vendor and bump the pin below. A local copy exists only
so offline tooling (`bun test`, `nix run .#provenance`) resolves the types
without a network fetch.

**Pinned at:** `ocap-provenance@<commit>` — _not yet locked; set this to
`git -C ocap-provenance rev-parse HEAD` when re-vendoring from a shell that has
the repo (see `HANDOFF.md`, Task A)._

## Why this is its own thing

claude-box and keeperd must agree, byte-for-byte, on one schema:

- **claude-box** is the *producer* — it builds the box image (L1) and emits the
  capability manifest at launch (L2).
- **keeperd** is the *signer / verifier* — it signs the launch attestation (L2)
  and binds it into every git-write attestation (L3).

If the schema lived in claude-box, keeperd (a key-holding security daemon) would
depend on a launcher; if it lived in keeperd, claude-box would import the daemon.
Both are backwards. The contract is a **third thing both pin** — which is also
the SLSA-idiomatic shape: predicate types are published as standalone, versioned
specs so verifiers can pin them independently of any producer.

## What's novel: capability-aware provenance

Standard provenance answers *"who/what produced this artifact, and how."*
claude-box adds a dimension: *"what authority did the producing actor hold."*
The `$CLAUDE_BOX_CAPABILITIES` manifest (the OCAP surface — which doors were
granted, which were denied) becomes part of the attestation. A verifier can then
check not just "nix built this image" / "keeper signed this commit," but **"the
box that asked for this write held exactly these doors and no others."**

## The predicate

- **predicateType:** `https://github.com/bounded-systems/ocap-provenance/predicate/CapabilityProvenance/v0.1`
- Wraps the standard in-toto Statement v1 envelope (`subject` + `predicate`).
- Schema: [`capability-provenance.v0.1.schema.json`](./capability-provenance.v0.1.schema.json)
- Types: [`types.ts`](./types.ts)
- The chain (how the three levels link): [`CHAIN.md`](./CHAIN.md)

## Versioning

The predicateType URI carries the version (`/v0.1`). Breaking changes bump it;
producers and verifiers pin a URI. `v0.x` is pre-stable — fields may change.
