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
| **`--repo <path>`** | work on a real project | worktree RW at `/work`, **`.git` read-only** (no host-RCE; commits via keeper). `--repo-rw` is the unsafe `.git`-writable escape. See [REPOD.md](./REPOD.md) |
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

## Transport is interchangeable — the door is the capability

*How* a door reaches the box is an implementation detail; the grant is unchanged
("this one door, no shell"). Today the box runs in the **podman-machine** VM
while the daemons run in the **Lima devshell** VM, so a door hops
container → host → Lima-VM. Across that two-VM gap:

| Transport | Across the gap |
|---|---|
| unix-socket bind-mount (`-v keeperd.sock`) | **flaky** — a socket over virtiofs into a *nested* container often won't connect |
| podman host-gateway TCP (`host.containers.internal:PORT`) | **robust**, podman-native; needs the door on a host port; token auth (keeperd holds the keys) |
| `ssh -L` (forward the socket) | **robust**; lock the key to forwarding-only (no shell) — ssh is *transport*, not authority |

**Recommended end-state — remove the gap by consolidating on podman (`prx-zj8`):**
run the services (keeperd / beadsd / dolt) as **pinned OCI images in a podman
pod**, and launch claude-box **into that pod**. Then every door is a **direct
local mount** — `-v /run/keeperd.sock` / `localhost` — no ssh, no TCP, no
forwarding, nothing on the wire. One runtime, every service a pinned image
(claude-box was the template). "direct" isn't a separate transport; it's what
you get once there's no gap. The ssh-`-L` / host-gateway-TCP rows above are
**interim stopgaps** for the current two-VM split only. The capability is
identical in every case; only the plumbing differs. (Retires the Lima daemon-VM;
reshapes `prx-5ed` from prx-owns-VM → prx-owns-image-fleet.)

**Launcher decision — the box always sees a unix socket.** The launcher forwards
each door as a **unix-socket bind-mount only** (`--keeper`, `--beads`), because
the socket is the ocap-purest, fastest, most portable shape:

- **ocap** — the socket *fd* is the capability; possessing it is the grant. No
  port for anything else to knock on, and **no token or key in the box** (a TCP
  door needs a bearer token, an `ssh -L` door needs a key — both reintroduce the
  ambient secret the box exists to avoid).
- **speed** — local kernel IPC, no TLS/ssh handshake.
- **portability** — in the consolidated pod it's a direct `-v /run/keeperd.sock`
  mount that deploys identically anywhere the pod runs.

So the box's **contract is fixed**: a unix socket at `/run/keeperd.sock` (and
`/run/beadsd.sock`). The two-VM gap is bridged **outside** the box — relay
keeperd's socket to a host-local socket (e.g. `socat` / `ssh -L` *on the
podman-machine host*, never inside the box) and point `$KEEPERD_SOCK` /
`$BEADSD_SOCK` at it. The TCP / in-box-ssh rows above stay rejected: the box
never sees the wire. When the pod lands (`prx-zj8`), the relay disappears and the
same `--keeper` launch becomes a direct local mount with zero changes.

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

## Why this matters

- **Least authority** — a box for reading docs gets no `--keeper`; a box doing a
  PR gets `--keeper --repo`. Authority is visible at the launch site.
- **No ambient secrets** — keys live in keeperd (and 1Password upstream), never
  in a 855 MB image or a plaintext volume.
- **Auditable** — every write is a keeperd-mediated, signed action.

Tracking: `prx-mlj` (keeper grant + this surface), `prx-8qj` (the builder
actor), the workcell-sandbox-projection. `--repo`, `--keeper`, `--beads`, and the
generic `--door` are **implemented** in the launcher over one door registry (each
forwards its door as a socket bind-mount; host-socket paths are overridable via
`KEEPERD_SOCK` / `BEADSD_SOCK` / a `--door name=host.sock` so the same launch
works across transports). The capability manifest (`$CLAUDE_BOX_CAPABILITIES` +
injected system prompt) ships with it; pure unit tests cover the surface
(`tests/door.test.ts`). The live-daemon integration tests stay `test.todo` until
the pod lands (`prx-asr`); **prx tool-gating on the manifest** is the follow-up.
