# claude-box — the workcell capability surface

claude-box is a **workcell**: the pinned image + the launcher + a set of
**explicit, least-authority capability grants**. The container is
**credential-free by design** — no ssh keys, no push rights, no signing key. It
gets *exactly* the authority a launch grants it, and nothing ambient. This is
the concrete instance of the capability-profile → sandbox projection (one
declaration, projected onto the `podman run` mounts/sockets).

## The grants

| Grant | What it gives | How |
|---|---|---|
| **config volume** *(default)* | the account's own auth/history/projects | `-v claude-<acct>-config:/home/claude/.config/claude:U` |
| **`--repo <path>`** | work on a real project | bind-mount a worktree, read-write only that path |
| **`--keeper`** | **git writes** (commit/push/refs), *signed* | forward the **keeperd** door (socket) — see below |
| **`--beads`** | beads reads/writes | forward the **beadsd** door (socket) |

Each grant is opt-in per launch. No grant ⇒ the box can think and read its
mounted repo, but cannot mutate anything outside its volume.

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

## Why this matters

- **Least authority** — a box for reading docs gets no `--keeper`; a box doing a
  PR gets `--keeper --repo`. Authority is visible at the launch site.
- **No ambient secrets** — keys live in keeperd (and 1Password upstream), never
  in a 855 MB image or a plaintext volume.
- **Auditable** — every write is a keeperd-mediated, signed action.

Tracking: `prx-mlj` (keeper grant + this surface), `prx-8qj` (the builder
actor), the workcell-sandbox-projection. `--repo`, `--keeper`, and `--beads`
are **implemented** in the launcher (each forwards its door as a socket
bind-mount; the keeperd/beadsd host-socket paths are overridable via
`KEEPERD_SOCK` / `BEADSD_SOCK` so the same launch works across transports). The
live-daemon integration tests stay `test.todo` until the pod lands (`prx-asr`).
