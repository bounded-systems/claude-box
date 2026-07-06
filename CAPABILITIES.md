# claude-box — the workcell capability surface

claude-box is a **workcell**: the pinned image + the launcher + a set of
**explicit, least-authority capability grants**. The container is
**credential-free by design** — no ssh keys, no push rights, no signing key. It
gets *exactly* the authority a launch grants it, and nothing ambient. This is
the concrete instance of the capability-profile → sandbox projection (one
declaration, projected onto the `podman run` mounts/sockets).

> **A container bounds what the box can *write*, not what it can *reach*.** That
> is the gap most "Claude in Docker" setups leave open — and the one that
> actually bites. A bind-mount stops the box touching the rest of the host, but
> with ambient network + forwarded credentials a prompt-injected or runaway box
> can still exfiltrate the mounted repo (and any `.env` in it) or push with your
> keys. It never touches your home dir and still leaks everything that matters.
> So claude-box treats **both halves of reach** as grants, not ambient: *egress*
> goes through the **netd** door (`--net`, `--network=none` by default) and *git
> writes* go through the **keeperd** door (no keys in the box). Confining where
> it writes is necessary; confining what it can talk to is the rest of the job.

## The grants

| Grant | What it gives | How |
|---|---|---|
| **config volume** *(default)* | the account's own auth/history/projects | `-v claude-<acct>-config:/home/claude/.config/claude:U` |
| **`--repo <path>`** | work on a real project | worktree RW at `/work`, **`.git` read-only** (no host-RCE; commits via keeper). `--writable PATH` narrows the writable surface to subtrees; `--repo-ephemeral` is a parallel-safe temp worktree; `--repo-clone` is an isolated clone with full in-box git (real repo never mounted); `--repo-origin URL` clones in-box from origin with **zero host mount**; `--repo-rw` is the unsafe `.git`-writable escape. See [REPOD.md](./REPOD.md) |
| **`--net [sock]`** | **policed egress** (incl. the model API) | `--network=none` + forward the **netd** door (socket) — see below |
| **`--keeper`** | **git writes** (commit/push/refs), *signed* | forward the **keeperd** door (socket) — see below |
| **`--scout`** | **external reads** (repos/PRs/URLs) | forward the **scoutd** door — content, not creds; the read twin of keeper, see [SCOUT.md](./SCOUT.md) |
| **`--beads`** | beads reads/writes | forward the **beadsd** door (socket) |
| **`--door <name>[=<sock>]`** | attach any other service | the **generic door** — mount a host socket at `/run/<name>.sock`, export `<NAME>_SOCK` |

Each grant is opt-in per launch. No grant ⇒ the box can think and read its
mounted repo, but cannot mutate anything outside its volume **and has no
network at all** (`--network=none`). `--net-open` is an explicit, unsafe escape
hatch (full ambient egress, no allowlist).

Underneath every launch the box also runs **`--cap-drop=all
--security-opt=no-new-privileges --pids-limit`** as non-root uid 1000: it needs
no Linux capabilities and never escalates, so a runaway agent can't fork-bomb or
privilege-escalate the host. These are floor, not grants.

## Network is a door — not a NIC

The box runs **`--network=none`**: it has no network interface, so there is no
ambient egress to exfiltrate *through* — even with a repo mounted. Its only way
out is the forwarded **netd** door: a unix socket whose daemon owns the egress
**allowlist** (the network twin of keeperd/beadsd). The box holds no egress
capability of its own; it can only *ask* netd, which decides what's reachable.

```
claude-box work --net --repo .
# → --network=none  -v <netd.sock>:/run/netd.sock  -e HTTPS_PROXY=http://127.0.0.1:3128 …
# In-box, the entrypoint relays loopback:3128 → /run/netd.sock (standard tooling
# can't proxy straight to a unix socket). Claude reaches api.anthropic.com ONLY
# because netd's allowlist permits it; a curl to evil.com has no route — netd
# refuses, and there's no other path off the box.
```

This is why the model API (mandatory, unlike git) still works under a door: the
grant isn't "no network", it's "no *unmediated* network". A prompt-injected or
runaway box can't POST your repo to an arbitrary host — there is nothing to
POST it through except netd, which enforces policy. `--net-open` (full ambient
egress) exists only as a loud, explicit fallback for when no netd is running.

netd's contract — socket protocol, default allowlist, no-MITM destination
gating, audit log — is [NETD.md](./NETD.md).

**One primitive, named presets.** A *door* is the whole capability mechanism: a
single `(name, socket)` pair. `--keeper` / `--beads` are just **named presets**
over the generic `--door` — canonical in-box path + a rulebook — and any other
service attaches with `--door <name>=<host.sock>`. We build **one** box image and
attach services per launch by socket; there is **one door registry** in the
launcher, so the mount, the env, the manifest, the help and these docs all fall
out of a single source and **cannot drift**. (That drift is exactly what let
`--keeper` ship "documented but unimplemented": the description and the reality
were separate artifacts. With one registry that is structurally impossible.)

## Git writes go through keeper — not raw git

The box holds **no git credentials and no signing key** on purpose. To
commit/push it routes through **keeperd** — the git-write daemon
(`prx … keeperd`, `keeper serve`, unix socket `/tmp/keeperd.sock`) that *owns*
push/branch/ref writes **and the keeper-only provenance signing key**. The box
is granted the keeperd **door**, not the keys:

```
claude-box work --keeper --repo .
# → -v <keeperd.sock>:/run/keeperd.sock
# Claude can REQUEST a signed write; keeperd performs it. The box can never
# push directly — there's nothing in it to push with.
```

This mirrors how beads writes go through **beadsd** (GH-296). keeperd is the git
twin; both are doors, not credentials in the box. That's the ocap win: a
compromised or runaway box can only *ask* a daemon that enforces policy and
holds the keys — it cannot exfiltrate keys or force-push.

### Credential hygiene — `gh` removed; writes and reads are doors (GH-5)

`gh` bundled three things into one ambient tool: a **read** client, a **write**
client (push / PR-create), and a **credential store**. A single `gh auth login`
turned the box into a direct push path that bypassed keeperd. So **`gh` is gone
from the image** (`flake.nix`), and its capabilities are unbundled into doors:

- **writes → keeperd** — the only sanctioned write path; the box holds no keys.
- **external reads → scout** — repos/PRs/URLs come back as *content*, not a
  token or a live connection ([SCOUT.md](./SCOUT.md)). Dropping `gh` without
  scout would just *lose* the read capability; scout *relocates* it to a door.
- **raw egress → netd** — and nothing ambient is forwarded (no SSH agent, no
  keys, no `GH_TOKEN`); `git`/`openssh` remain only for local VCS + transport.

The result is the enforced version of "credential-free": there is no in-box tool
that can establish push rights, so keeperd is the *only* way to write history —
not merely the recommended one. (The remaining footgun is still *handing* the
box a credential — mounting a key or `-e GH_TOKEN=…` — so don't.)

## Transport and the contract — what's interchangeable, and what isn't

*What* a door grants is fixed by the daemon behind it ("this one door, no shell").
*How* the box reaches it has several transports — but they are **not** equal on the
one axis that matters for ocap: **who else can reach the door.** That axis is the
contract, and it degrades as you move off the socket:

| Transport | Who can reach the door | ocap contract |
|---|---|---|
| **unix-socket bind-mount** (`-v keeperd.sock`) | only the fd-holder — mounted into *this* box, nothing else | **purest** — possessing the fd *is* the grant; unforgeable, no token, no port to knock on |
| **pod-local TCP** (`--pod`, shared netns `localhost:PORT`) | only **pod members** — the netns is the boundary; no host port, no LAN | **near-equal** — pod membership is the grant; scoped, no host-wide surface |
| **host-gateway TCP** (`DOORS_TCP=1`, `host.containers.internal:PORT`) | **anything host-local that can route to the port** — ambient reachability | **weakest** — possession is no longer the grant; leans on `127.0.0.1` binding + the daemon's own policy; true possession-semantics would need a bearer token (the in-box secret the box exists to avoid) |

So "transport is interchangeable" is only half true: the **capability** (what the
door does) is identical, but the **scoping guarantee** (what else can reach it)
falls from unforgeable fd-possession → netns membership → ambient host-local
reachability. That degradation is the whole reason to prefer the socket — and to
treat host-gateway TCP as a **concession, not a peer.**

**The ideal — unix socket; the box sees the fd, holds no secret.** On a single Linux
host (and in the consolidated pod, `prx-zj8`) every door is a direct
`-v /run/<name>.sock` mount: the fd is the capability, possessing it is the grant,
**no token or key in the box**, no port for anything else to knock on. This is the
contract the box is *designed* around, and where it should always land. Bonus:
local kernel IPC (no TLS/ssh handshake), and it deploys identically anywhere the pod
runs.

**The macOS concession — `DOORS_TCP=1`.** A socket can't cross the host→VM virtiofs
hop ([ROOM.md](./ROOM.md)), so on macOS the daemons listen on host TCP ports and the
box dials `host.containers.internal:PORT`. This **ships and works today** (it's what
`cbox` runs) — but it is honestly the *weakest* tier above. It is kept acceptable by
three things, none of them the transport itself:

- bound to **`127.0.0.1`** (loopback), never `0.0.0.0` — not LAN-exposed;
- the **daemon still enforces policy** (netd allowlist, keeper signing rules), so an
  unauthorized connector is bounded, not free;
- it's a **single-user trusted dev host** — a deliberately narrow threat model.

The residual gap is real (ambient host-local reachability; no possession-semantics
without a token) — which is exactly why `--pod` exists and why the unix-socket
end-state is the target, not a nicety.

**`--pod` recovers most of the contract.** Running the daemons as sidecars in the
box's pod (shared netns) makes the door a `localhost:PORT` reachable **only by pod
members** — no host-wide port, no LAN. Pod membership becomes the grant: not the
unforgeable fd, but a real boundary, far closer to the socket than host-gateway TCP.

The unifying move underneath all of this is the **actor model** ([DOORS.md](./DOORS.md)):
a door is a *dispatch to a guest that holds the authority*, and the transport is just
how the message travels. `prx-o92` collapses these tiers into **one transport-agnostic
client**, so the box asks for a capability the same way regardless of which tier
carries it — and *scoping* becomes a property of the grant, not an accident of the
plumbing.

## The surface is honest — the box knows what it can't do

An OCAP surface needs two things, and the doors above only give the first:

1. **Unforgeable.** No `--keeper` ⇒ no keeperd socket ⇒ *there is nothing in the
   box to push with*. The capability can't be faked; its absence is real.
2. **Self-describing.** The box must *know* its surface — granted **and** denied
   — so it never "thinks it can." Otherwise the agent reads a stale doc, reaches
   for a door that isn't there, and fails at runtime (or hallucinates success).

For (2), the launcher emits a **per-launch capability manifest from the same
registry that does the mounting**, so it is ground truth by construction:

- a machine-readable manifest is exported as **`$CLAUDE_BOX_CAPABILITIES`**
  (granted doors + repo + the explicit *denied* list);
- a human-readable version is **injected into the agent's context every launch**
  via `claude --append-system-prompt` — "your authority is EXACTLY this; if it
  isn't GRANTED you don't have it," with, for each door, *how to use it* and, for
  each denied door, *do not attempt; relaunch with `--flag`*.

This is the Chinese Room: the box (the room) hands the agent (the man) a rulebook
keyed to exactly the doors present. He never needs ambient authority ("to
understand Chinese") — he translates only via the card for the symbols he holds,
and for symbols with no card there is no rule. He cannot "think he can."

> The full **host / VM / room** topology — where the keys sit, where the room
> sits, and why the host→VM virtiofs gap is the macOS door wall the pod closes —
> is sketched in [ROOM.md](./ROOM.md).

**Follow-up — enforce, don't just describe (prx tool-gating).** Injecting the
manifest *tells* the agent its limits; the stronger form is for the in-box
runtime (**prx**) to read `$CLAUDE_BOX_CAPABILITIES` and **not expose a tool for a
denied door at all** — absence becomes unforgeable at the tool layer, not merely
stated. That lives in prx, not this launcher; tracked as a follow-up.

**Follow-up — provenance (capability-aware).** The manifest is also a hashable
record of the authority a launch held, so it can be *attested*: a SLSA/in-toto
chain from **reproducible image → the doors a launch held → the keeper-signed
commit** (L1→L2→L3). The shared predicate schema both claude-box and keeperd pin
is authored under [`contract/`](./contract/) (`CapabilityProvenance/v0.1`),
destined for its own repo (`bounded-systems/ocap-provenance`); see
[`contract/CHAIN.md`](./contract/CHAIN.md). L1 (sign + SLSA-attest the box image)
is the self-contained next step in this flake; L2/L3 land in keeperd.

## Where authority originates — the root mint, then attenuating delegation

A box holds no ambient authority; every capability traces to a single origin and
can only narrow from there.

- **The root mint — the only ambient-authority origin.** `launcherd` gates the
  INITIAL grant at root launch against its policy (`isRoomAllowed`, the `rooms`
  catalog, `maxConcurrent`, `rateLimit`). This is the one place authority enters
  the system: a launch either matches policy and mints a manifest of doors, or it
  is refused. Everything downstream can only attenuate.

- **Delegation is chosen by transport, not re-checked per hop** (see
  [ADR-CAPABILITY-TRANSPORT.md](./ADR-CAPABILITY-TRANSPORT.md)):
  - **`unix` (local):** the held reference IS the authority — a box can reach only
    the door sockets bind-mounted into it (`prx-sfr0`), and can delegate only
    references it already holds. Over-granting is *unsayable*, not rejected.
  - **`vsock`/`tcp` (in transit):** a reachable socket is not authority. The
    concierge MINTS a signed grant (audience/exp/nonce-bound) and the serving room
    VERIFIES it before honoring a call (`verifyGrantWithKeys` — keyless, against
    the concierge's published keys), then enforces its caveats.

- **Post-root delegation is deliberately unchecked**, by construction: you cannot
  hand on a reference you don't hold (local) or widen a signed grant you were
  issued (transit), so authority is monotonically non-increasing from the mint —
  no per-hop policy gate is needed or wanted. This now holds on the **spawn path**
  too: `launcherd` derives a child's references from the **caller's own
  `LaunchRecord`** — correlating the spawn caller to its launch by the caller's
  **cgroup** (kernel truth, unspoofable; `prx-p4vb`) — and hands the child the
  parent's *actual* door references (`prx-8k08`). A box we didn't launch is
  refused (fail closed); the old name-based `child ⊆ parent` check and the
  client-sent `_parentDoors` were retired (`prx-e232`). Over-granting is
  *unsayable* on spawn, not rejected by a check.

## The `--remote-control` profile — an honest, scoped relaxation

`--remote-control` (and its server form `--remote-serve`) lets the Claude app
drive a *boxed* session. Every relaxation it makes is **scoped to that
launch** — the default box is byte-for-byte unchanged (pinned by
`tests/remote-control.test.ts`).

What it relaxes, and the boundary that stays:

- **Feature-flag fetch (Gate A).** The default box bakes
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (kills the auto-updater, Sentry,
  feedback, *and* GrowthBook). RC needs GrowthBook to evaluate the `tengu_ccr_bridge`
  flag, so `authEnvArgs()` unsets that umbrella and **re-asserts the three
  RC-compatible blocks granularly** (updates, error-reporting, feedback) — only
  telemetry/GrowthBook becomes reachable, and even that is bounded by netd below.
- **Token (Gate B).** RC does **not** forward the inference-only
  `CLAUDE_CODE_OAUTH_TOKEN`; it uses the full-scope `claude auth login` credential
  the user persists in the `claude-<account>-config` volume. The box still holds
  no standing secret beyond that account credential. *(Open: whether in-box
  `claude auth login` completes via a device/paste flow — the `prx-9s14` spike.)*
- **Egress is still a policed door — just a wider allowlist.** RC gets its **own
  scoped netd** whose allowlist is `DEFAULT_ALLOW + RC_NETD_ALLOW` (the anthropic
  hosts **plus** `statsig.anthropic.com` and the enumerated GrowthBook host). It is
  **never** `--net-open` — the allowlist is explicit and minimal, and it is *this
  launch's own netd*, so no other box's egress widens. netd remains the
  fail-closed boundary that drops anything off the list.

So the relaxation is legible and contained: a wider-but-still-enumerated egress
allowlist and a full-scope login, for one opt-in profile, with the default
hardened box untouched.

## The `--pathbase` profile — the same egress-only shape, for toolpath

`--pathbase` is a second, narrower opt-in profile with the same shape as RC's
egress relaxation (minus the auth/feature-flag gates — it touches *only*
egress): it lets toolpath (`path`) reach Pathbase for session push/pull and
`path auth login`. It gets its own scoped netd allowlisting
`DEFAULT_ALLOW + PATHBASE_NETD_ALLOW` (the anthropic hosts plus
`pathbase.dev`) — never `--net-open`, never the shared netd, never folded
into a default profile (pathbase.dev is a write-capable host, so it follows
the same "fetch hosts only in defaults" hygiene as NETD.md's GH-6 rule).
Without `--pathbase`, `path` still ships in every box (see the toolchain in
`flake.nix`) for fully local, zero-egress use: `path p import git` /
`render md|dot` over the box's own `.git` and agent logs.

Both profiles' scoped allowlists are unioned into ONE scoped netd when more
than one applies to a launch (`scopedAllow` in `claude-box.ts`'s `run()`), so
a launch that somehow combined them would still get every host either one
needs — never silently lose one to the other.

## Why this matters

- **Least authority** — a box for reading docs gets no `--keeper`; a box doing a
  PR gets `--keeper --repo`. Authority is visible at the launch site.
- **No ambient secrets** — keys live in keeperd (and 1Password upstream), never
  in a 855 MB image or a plaintext volume.
- **Auditable** — every write is a keeperd-mediated, signed action.

This is an **applied object-capability system**, not a loose analogy to one;
where the doors, the credential-free box, and the attenuating launcher sit in the
OCAP canon (POLA, no ambient authority, attenuation/delegation, Capsicum/seL4 as
cousins) is mapped in [OCAP.md](./OCAP.md).

Tracking: `prx-mlj` (keeper grant + this surface), `prx-8qj` (the builder
actor), the workcell-sandbox-projection. `--repo`, `--keeper`, `--beads`, and the
generic `--door` are **implemented** in the launcher over one door registry (each
forwards its door as a socket bind-mount; host-socket paths are overridable via
`KEEPERD_SOCK` / `BEADSD_SOCK` / a `--door name=host.sock` so the same launch
works across transports). The capability manifest (`$CLAUDE_BOX_CAPABILITIES` +
injected system prompt) ships with it; pure unit tests cover the surface
(`tests/door.test.ts`). The live-daemon integration tests stay `test.todo` until
the pod lands (`prx-asr`); **prx tool-gating on the manifest** is the follow-up.
