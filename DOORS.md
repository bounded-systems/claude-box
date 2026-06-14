# DOORS.md — the door model

> A **door** is an *ephemeral process* over a *persistent capability grant*. It
> mediates one kind of access (egress, git-write, external-read) for one box.
> Lifetime = demand, bounded by the grant. Revoke = delete the grant. The egress
> proxy **injects credentials** so the box holds **no secrets** and makes **naked
> requests**. This doc is the unifying model; [NETD.md](NETD.md),
> [KEEPERD.md](KEEPERD.md), [SCOUT.md](SCOUT.md) are instances of it, and
> [POD.md](POD.md) is where doors live (one box = one pod of doors).

## What a door is

A door is the capability boundary for one kind of access. The box never holds the
underlying authority (a network route, a signing key, a read token); it holds a
**reference to a door** and asks the door to act. Three properties define a door:

1. **Ephemeral process.** The door runs only while it's needed — spun up on
   demand, gone when idle. No standing daemons.
2. **Persistent grant.** The door's *authority* — its allowlist/scope, its
   token-ref, its audit cursor — lives in a durable **capability store**, not in
   the process. The process is a pure function of the grant.
3. **Proxy-injected credentials.** The door applies any required secret *on the
   box's behalf*; the box's requests are unauthenticated. Secrets never enter the
   box (and, with a broker, never the pod).

## Vocabulary: guests, rooms, dispatch (this IS the actor model)

A door is one edge in an object-capability **actor** graph. Naming it precisely
makes the whole model fall out:

- **Guest** — a runtime *actor*: one identity that runs (`claude`, `bun`, `node`).
  A guest holds **no ambient authority** — only references to other guests it may
  dispatch to.
- **Room** — a *declared capability set*: the named bundle of dispatch-edges a
  guest is granted (`dev` = keeper + net + scout). The room is the declaration of
  what the guest may reach — nothing wider.
- **Launch = `spawn(guest, room)`** — a guest entered into a room. Not a guest,
  not a room; the *composition*. (`claude-box --guest claude --room dev`; `cbox`
  is a convenience wrapper over it.)
- **Capability = dispatch to a guest.** A box never *holds* keeper/scout/net
  authority — it sends a message (`op` + `params`) to the guest that holds it
  (`keeperd`/`scoutd`/`netd`), which performs it and returns a result. Authority
  is **delegated by dispatch, never accumulated.**
- **Door = one dispatch edge** — "this guest may dispatch these ops to that
  guest." The heterogeneous wiring (net via `HTTPS_PROXY`, keeper/scout via unix
  sockets) is an artifact to retire: **one uniform `dispatch(guest, op, params)`
  interface**, transport-agnostic underneath (the `DoorTransport` abstraction).
- **Spawning = attenuating dispatch.** To gain a capability it lacks, a guest
  dispatches a *spawn* (the launcher) and gets a new guest with a **subset** of
  its own capabilities (child ⊆ parent — the attenuation contract). Authority
  narrows down every dispatch chain.
- **Even auth is a dispatched capability.** A box should not hold its API token;
  "inference egress" is a capability obtained by dispatching to the net guest,
  which **injects** the credential (secret-free — see below). `cbox`'s env-token
  is the *interim*; the clean form is dispatch.

This collapses the door zoo into **one primitive — guests dispatching to guests
over a declared, attenuating capability graph.** It dissolves the TCP-mode door
gap (one interface, no per-door transport to get wrong) and is the
actor-unification on the roadmap (`prx-o92`, `prx-435`).

## Lifetime & revocation — there is no "persistent" door

Every door is scoped to a **need-window** — the time its access is actually
required. "Persistent" is not a category; it is just the default lifetime:

- **Demand keeps it alive.** While there's active traffic, the door lives; when
  it goes idle, the process dies. The anthropic-egress door *looks* persistent
  only because Claude keeps inferring all session; it needs no special mechanism.
- **The grant bounds revival.** A dead-from-idle door may only come back **if the
  persisted grant still permits it.** So demand-driven lifetime is safe:
- **Revoke = delete the grant.** A durable write removes the authority; after it,
  the ephemeral process *cannot* revive. This is OCAP revocation as a state op,
  not "hope you killed the right PID."

Default need-window = pod teardown (free — the door dies with the pod). The only
explicit verb is **early revocation** (e.g. the git-pull door, deleted once the
clone completes). `behavior = f(grant)` → deterministic and reproducible; the
grant store is the single trust anchor to secure.

## Grants as a declarative asset graph (OCAP, but Dagster)

The shape above — *declare durable grants; an ephemeral process materializes the
door; `behavior = f(grant)`; revoke by deleting the declaration* — is a
**reconciliation system**. It is the same shape as a declarative asset
orchestrator (Dagster being the reference one), and naming it that turns the two
fuzziest parts of this design (the "grant store" and "how revocation/rotation
works") into known-good, principled machinery:

| Declarative-asset orchestrator | claude-box doors |
|---|---|
| **Asset** (declared, durable) | a **grant** in the store |
| **Materialization** (ephemeral run) | a **door process**, on demand |
| `asset = f(upstream, config)` | `door = f(grant)` |
| **Remove asset from the graph** | **revoke** → reconciler tears the door down |
| **Freshness policy / declarative automation** | demand-driven lifetime; token **expiry → rematerialize** (rotation is free) |
| **Sensor** | box request → door materializes |
| **Resource** | the **broker/signer** (holds the root secret) |
| **Partition** | per-box / per-repo scope |
| **Reconciler** (actual vs declared) | the **trust kernel** |

- **The grant store is the asset catalog.** Declared grants are the source of
  truth; the reconciler makes the set of running doors match the declared set.
  Revocation, rotation, and demand-materialization are all just reconciliation —
  not bespoke lifecycle code.
- **Asset lineage is the capability delegation chain.** "This repo-scoped token
  was attenuated from the App-key asset; this commit signature from the
  signing-key asset" *is* lineage. claude-box already produces it — the L1/L2/L3
  attestation and the [OCAP provenance](OCAP.md) contract (SLSA-shaped) **are**
  the lineage graph. Provenance isn't a separate feature; it's the asset graph
  read backwards.

**Borrow the model, not the runtime.** Take the *shape* — declared grants,
reconciliation, lineage — but the reconciler that grants and revokes
capabilities must be a hardened **trust kernel**, not orchestrator glue with its
own attack surface. The declarative-asset-with-lineage framing is exactly right;
the enforcement boundary stays small and audited.

## Scope & the TLS boundary

A door scopes *what* the box can reach. How tight depends on where the proxy sits
relative to TLS:

| Proxy kind | Scope it can enforce | Identity guarantee |
|---|---|---|
| **CONNECT** (tunnels encrypted bytes) | **host** (`github.com`) — the path is inside TLS | box verifies the *real* upstream cert end-to-end (provably GitHub) |
| **TLS-terminating** (sees the plaintext request) | **path** (`/org/repo.git`) **and** can inject auth | box trusts the *proxy's* cert → the proxy must **verify + pin** the upstream |

Host-scope keeps TLS end-to-end (you can *prove it's GitHub*); path-scope and
credential injection require terminating TLS (you trade end-to-end proof for the
door's verification). Pick per door: a public clone wants CONNECT (provable
identity); an authenticated, repo-scoped pull wants TLS-termination.

## Secret-free: the broker holds standing secrets, doors hold derivatives

The pod holds **no standing secrets**. Instead:

- The **standing secret** (GitHub App private key, the commit-signing key) lives
  in **one hardened host-side broker/signer**.
- Each door pulls an **attenuated, ephemeral derivative**: a repo-scoped, ~1-hour
  GitHub installation token; a single-use signature. These *are* capabilities —
  scoped and expiring.
- The **egress proxy injects** that token into outbound requests (TLS-terminating
  for authed destinations), so even the door's clients send nothing.

A full pod compromise leaks, at worst, an expiring scoped token — never the root
secret. This makes `netd`, `scoutd`, **and** `keeperd` secret-free *in the pod*:
- **netd** — scoped egress, no secret.
- **scoutd** — secret-free for public reads; private reads via a proxy-injected,
  repo-scoped, expiring installation token.
- **keeperd** — signs by **delegating to the host-side signer**; the signing key
  never enters the pod. The box still holds nothing; keeperd holds only the
  capability to *request* a signature.

## Many doors per box, one per capability

A door is one capability = one `(scope, lifetime)`. Group by **purpose**, not by
host (a single allowlist can name several hosts). A typical box's pod runs:

- **anthropic-egress** — allowlist `…anthropic.com`, lives the session.
- **git-pull** — allowlist = the origin host (or repo, if TLS-terminating),
  revoked right after the clone.
- **keeper** — delegated signing; **scout** — read content.
- *(push is keeper, not egress; in-box git after the clone needs no egress.)*

Two capabilities → two doors. Conflating them into one process (one netd, many
allowlists) re-creates the shared-authority anti-pattern at pod scale.

## Relation to the rest

- [POD.md](POD.md) — doors run as **sidecars in the box's pod**, sharing its
  network namespace; this doc is the per-door model, POD.md is the container of
  them.
- [OCAP.md](OCAP.md) — the capability-security canon this borrows from.
- Roadmap: `prx-asr` (pod + doors), `prx-anj`/`prx-634` (daemon images, key as a
  brokered secret), `prx-zj8` (containerize the fleet).
