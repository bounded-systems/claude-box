# POD.md — pod-per-box: the doors belong to the box, not the host

> One box = one podman **pod**. The box container and its door daemons
> (`netd`/`keeperd`/`scoutd`) are **sidecars in the same pod**, sharing one
> network namespace. The box reaches its doors at `localhost:PORT`; the doors
> live entirely in the pod, **off the host**. This is the namespace the doors
> always wanted.

## The problem: doors as shared global host infrastructure

Today the doors run as **host daemons on fixed global ports** (`0.0.0.0:3001`
keeperd, `0.0.0.0:3002` scoutd, `0.0.0.0:3128` netd). Every box — *and* the host
operator — share that one flat space. Four failures fall out of it:

1. **Cross-session disruption.** A box reaches netd over the macOS↔VM boundary
   (`host.containers.internal:3128`) on a *shared* daemon. Restarting/ churning
   the doors from one session knocks every live box offline. (Observed: an
   interactive dogfood box lost its API connection mid-task when the operator
   session restarted the doors and ran the red-team harness.)
2. **Port collisions.** Anything that binds `3128` collides — the red-team
   harness did exactly this (now fixed to an ephemeral port, #46).
3. **Network exposure.** netd binds `0.0.0.0`, so the proxy is reachable by *any
   device on the LAN*, not just the box (it had to, to be reachable from the VM).
4. **Capability leak.** One netd serving every box, disruptable by the operator,
   means authority crosses the trust boundary — the opposite of OCAP, where a
   capability belongs to exactly one holder.

## The decision: a pod per box

```
podman machine (Linux VM)
└─ pod "box-<account>"            ← one network namespace
     ├─ box container             → reaches doors at localhost:3128 / :3001 / :3002
     ├─ netd     (sidecar)        → egress via the VM's own NAT
     ├─ keeperd  (sidecar)        → signing key injected as a runtime secret
     └─ scoutd   (sidecar)        → read token injected as a runtime secret
```

- The box reaches its doors at **pod-localhost** — no `host.containers.internal`,
  no host port, no shared daemon.
- netd reaches the internet via the **VM's NAT**; the **macOS host leaves the
  data path entirely**. The fragile VM↔Darwin hop is gone.
- Each pod is its **own netns** → collisions and cross-session interference are
  *physically impossible*, and the `0.0.0.0` exposure disappears (doors bind the
  pod's private loopback, never a host interface).

### OCAP is *strengthened*, not weakened
Sidecars share only the **network** namespace — not filesystem, not process
space. So:
- The box still **holds no credentials**, and — per the door model
  ([DOORS.md](DOORS.md)) — **neither does the pod**: standing secrets stay in one
  host-side broker/signer; doors hold only attenuated, ephemeral derivatives, and
  the egress proxy injects them so requests go out naked.
- The repo door / egress scoping we hand-rolled (`--repo-origin`'s git-pull door,
  the per-launch scoped netd) become **just doors in the pod** — one per egress
  capability, each `(scope, lifetime)`, revoked by deleting its grant.
- The doors are now part of **that box's capability namespace**, not a global
  service. One holder, one capability.

The full per-door model — ephemeral process over a persistent grant, demand-driven
lifetime, proxy-injected credentials, host-vs-path scope — lives in
[DOORS.md](DOORS.md). POD.md is just the *container* (the pod) those doors run in.

## Verified (spike)

A pod with a netd sidecar + a box, proven end-to-end:

```bash
podman pod create --name boxpod-spike
podman run -d --pod boxpod-spike -v "$PWD:/src:ro" \
  -e NETD_ALLOW="api.anthropic.com,.anthropic.com,github.com,.github.com" \
  --entrypoint bun localhost/claude-personal:dev /src/netd/netd.ts serve --port 3128
podman run --rm --pod boxpod-spike --entrypoint sh localhost/claude-personal:dev -c '
  export HTTPS_PROXY=http://localhost:3128
  git clone --depth 1 https://github.com/octocat/Hello-World /tmp/r   # ALLOW → cloned
  git clone --depth 1 https://gitlab.com/gitlab-org/gitlab-test /tmp/g # DENY → 403
'
podman pod rm -f boxpod-spike
```

Result: box cloned `Hello-World` through the **pod-local** netd (`localhost:3128`),
gitlab was **DENIED 403**, and the shared host doors were **untouched** (no new
host listener on `3128`). The architecture holds.

## Migration plan

Opt-in `--pod` mode, parallel to the existing host-daemon path, then flip the
default once the sidecars are solid:

1. **netd sidecar first** (secret-free). `--pod` creates the pod, starts netd as a
   sidecar with the launch's allowlist, runs the box with `HTTPS_PROXY=localhost`,
   tears the pod down on exit. (The egress door is the one that's been fragile —
   start there.)
2. **scoutd sidecar** — secret-free for public reads; private reads use a
   proxy-injected, repo-scoped, expiring token (the standing App key stays in the
   broker, never the pod). See [DOORS.md](DOORS.md).
3. **keeperd sidecar** — signs by **delegating to the host-side signer**; the
   signing key never enters the pod. The box (and the keeperd container) hold no
   standing secret. Attest as today (L3).
4. **Lifecycle hardening** — pod cleanup on crash/timeout, one pod per
   account/launch id, `claude-box doctor`-style detection of orphaned pods.
5. **Deprecate** the host-daemon + `host.containers.internal` path once `--pod`
   is the default.

## Open questions
- **The broker/signer** ([DOORS.md](DOORS.md)) — where standing secrets live and
  how doors request attenuated, expiring derivatives. The pod stays secret-free;
  the broker is the one trust anchor to design and harden.
- **The persistent grant store** — modeled as a **declarative asset catalog**
  reconciled by the trust kernel ([DOORS.md](DOORS.md), "OCAP, but Dagster"):
  grants are assets, doors are materializations, revocation is removing a
  declaration, lineage is the existing provenance chain. Open: its home + a
  consistency model.
- **Pod lifecycle** on operator crash — orphaned pods leak; need a reaper.
- **Coexistence** with the current TCP-doors mode during migration.

## Roadmap
This is `prx-asr` (assemble the per-repo pod + wire the doors), `prx-anj` /
`prx-634` (keeperd/beadsd box images, brokered secrets), and `prx-zj8`
(containerize the fleet). POD.md + [DOORS.md](DOORS.md) are the spec they execute
against.

### Blocking order (the dep edges beads can't yet hold)

These items form a strict chain, but the in-box beadsd write-door is partial —
`prx beads dep add` is rejected from inside the box (`failed the beadsd wire
contract`, cf. `prx-716`), so the edges below are **not** reflected in the
tracker's `dependency_count`. Until the host/sync path writes them, this is the
authority:

```
prx-634  beadsd-box IMAGE  ┐
prx-anj  keeperd-box image │  (none exist yet; prx-zj8 / nix-dockerTools work,
dolt-box                   ┘   verified only on a podman host)
        │ must exist before
        ▼
prx-asr  assemble the pod {dolt-box, beadsd-box, keeperd-box} + box joins
        │ which lights up
        ▼
prx-438  prx verbs route bd-backed ops through the beadsd door (prx repo)
```

The **box (consumer) side is already done**: `claude-box.ts` `--beads` forwards
`/run/doors/beadsd.sock` ($BEADSD_SOCK) into the box, and `keeperd`/`netd`/
`scoutd` quadlets exist. What's missing is the **server** side — nothing in this
repo *serves* the beadsd/dolt doors, and there is no `.pod` grouping. So `prx-asr`
is blocked on the images, not on launcher work. (`tests/ocap.test.ts` keeps the
`--beads` e2e as `test.todo` for the same reason.)

See also: [NETD.md](NETD.md), [KEEPERD.md](KEEPERD.md), [OCAP.md](OCAP.md),
[REPOD.md](REPOD.md).
