# ADR — pod orchestration: `podman kube play` vs Quadlet `.container` units

> Status: **decided — converge on Quadlet** (2026-07-05). Surfaced while wiring
> the beads door single-writer guard (claude-box #219/#223/#225, prx #989), which
> had to add the *same* guard twice because two orchestrators own overlapping
> resources. The pod (netns) is settled; its realization converges on Quadlet
> `.container` units. Migration sequencing (not the decision) belongs with the
> prx-asr ADR.

## The invariant that is NOT in question

**One box (or one repo) = one podman *pod* = one network namespace.** The doors
are pod-local sidecars; the box reaches them at pod-`localhost`, off the host.
This is settled and load-bearing (see [POD.md](./POD.md)): a private netns makes
port collisions and cross-session interference *physically impossible*, kills the
`0.0.0.0` host exposure, and keeps a capability with exactly one holder (the OCAP
invariant). The `dolt`↔`beadsd` netns sharing that the single-writer work depends
on is a direct consequence.

**What IS in question is only how the pod is *realized*.** Two ways are in the
tree today:

## Option A — `podman kube play` (prx)

`prx pod up` renders the per-repo pod as a Kubernetes manifest and runs it via
`podman kube play -` ([`packages/prx/src/room/podman-runtime.ts`]). Backing
services (dolt-box) and non-secret rooms are containers in that manifest.

- **Pro:** one declarative manifest; nominally portable to real Kubernetes;
  `kube play` provisions the shared door-fabric `hostPath` in one step.
- **Con (observed, not hypothetical):** `podman kube play` **cannot mount a
  podman secret**, so every secret-holding room (keeperd) had to drop out to a
  separate `podman run --secret` path. `playPod`/`downPod` now juggle **two
  runtimes for one pod** — permanent complexity, called out in the module header.

## Option B — Quadlet `.container` units (claude-box)

The claude-box door fleet (#219: `dolt.container`, `beadsd.container`, and the
keeper/net/scout units) is systemd-native Quadlet. Netns sharing is expressed
per-unit (`Network=container:dolt`); lifecycle, ordering (`Requires=`/`After=`),
restart, and the single-writer `ExecStartPre` guard are all plain systemd.

- **Pro:** no secret-mount limitation (systemd `Secret=`/`ExecStartPre` work),
  one lifecycle manager, per-unit hardening, first-class `ExecStartPre` guards
  (used by the I5 single-writer guard, #225).
- **Con:** not a single portable manifest; k8s portability is lost (or deferred).

## The divergence

claude-box **already moved to Option B** for the door fleet; prx **still uses
Option A** for the per-repo pod. Both now target the *same* store (`prx-dolt-data`)
— which is exactly why the single-writer guards (#225 claude-box side, #989 prx
side) had to be added on *both*. That duplication is a symptom: two orchestrators
own overlapping resources.

## Decision

Converge on **Option B (Quadlet units)** for the single-host VM deployment.
Rationale: the only concrete payoff of `kube play` is k8s portability, which is
currently unused; meanwhile its secret limitation already forced a two-runtime
split, and claude-box's Quadlet path is where the door fleet and the enforcement
guards already live. One realization, one lifecycle manager, one place for the
single-writer guard.

**Reopen only if** shipping to real Kubernetes becomes a near-term goal that
justifies the `kube play` secret-split tax — at which point the trade flips and
this ADR should be revisited.

This ADR is the decision; it is **not** the migration. Sequencing and the "does
the per-repo pod still run dolt-box at all" question belong with the **prx-asr**
ADR (`docs/prx/beadsd-door-wiring.md` in the prx repo).

## Consequences if adopted

- prx's per-repo pod migrates from `kube play` + `podman run --secret` to Quadlet
  units; the two-runtime split in `podman-runtime.ts` collapses.
- The single-writer guard (currently in `playPod`, #989) moves to a
  `dolt.container` `ExecStartPre` — the same shape already shipped in claude-box
  #225, so the two guards merge into one.
- k8s portability is explicitly deferred; revisit if/when a cluster target is real.

## Provenance chain
- The pod-per-box netns rationale: [POD.md](./POD.md).
- The store single-writer invariant enforced across both orchestrators:
  [`contract/INVARIANTS.md`](./contract/INVARIANTS.md) I5; guards in
  claude-box #225 + prx #989.
- Composes with the prx-asr pod-assembly decisions (beadsd-door-wiring ADR).
