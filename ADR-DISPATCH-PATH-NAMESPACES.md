# ADR — launcherd is a control plane; door socket paths live in one namespace

> Status: **proposed** (2026-07-04). Tracking: refines `ADR-ORCHESTRATION.md`
> (Quadlet for doors) for the one daemon that ADR's uniform rule doesn't fit.
> Motivating incident: an end-to-end dispatch spawn failed through three
> stacked, runtime-only bugs (see Context). This ADR is the contract those
> bugs violated — written before the fix, so the fix conforms to it rather
> than the contract being reverse-engineered from whatever the patch did.

## Context

`dispatch` (and `launch`) ask **launcherd** to spawn a sibling box. launcherd
does this by shelling out to `podman run` against a podman API socket. On the
macOS dev substrate there is a VM in the middle:

```
macOS host ── virtiofs ──▶ podman-machine VM (Fedora CoreOS) ──▶ containers
                            (keeperd, netd, scoutd, authd,
                             launcherd, bastion, dispatched boxes)
```

A dispatched box must mount the door sockets it was granted (`keeper`, `net`,
`scout`, …). So a single door socket is referred to by **three different path
strings**, and until now nothing in the code named which was which:

| Path role | Whose namespace resolves it | Correct value |
|---|---|---|
| **Physical socket** | VM host filesystem | `/var/home/core/.claude-box/run/keeperd.sock` |
| **launcherd's own view** (what it `connect()`s to for reachability checks) | launcherd's mount namespace | *must resolve to a path that exists for launcherd* |
| **bind-mount source** (`podman run -v SRC:DST`) | **the podman *server*** (VM host) | `/var/home/core/.claude-box/run/keeperd.sock` |
| **spawned box's mount point** (`DST`, the in-box path) | the new box's namespace | `/run/doors/keeperd.sock` |

**The load-bearing invariant, never previously written down:**

> A `podman run -v SRC:DST` source is resolved by the **podman server**, not by
> the process that typed the command. So **`SRC` must be valid in the VM-host
> filesystem namespace** — regardless of how launcherd itself refers to that
> socket.

### How containerizing launcherd broke this

`ADR-ORCHESTRATION.md` containerized every door daemon uniformly. For
keeperd/netd/scoutd/authd that is correct — they are **pure socket daemons**
with no host-control surface, so a container genuinely sandboxes them. launcherd
is categorically different: **its entire job is to control the host container
runtime.** Containerizing it and then mounting the host podman socket back in
(`CONTAINER_HOST=unix:///run/podman/podman.sock`) hands it back exactly the host
authority the container was meant to remove — the container provides ~zero
isolation while adding surface. That is *isolation theater*, and it is the
direct cause of all three dispatch bugs found live on 2026-07-04:

1. **`HOME=/root` unusable** for the keep-id uid-1000 process under
   `ReadOnly=true` → podman *client* won't start. (Fixed narrowly by
   `HOME=/tmp`; see PR #207. Only exists because launcherd is a container with a
   baked image HOME.)
2. **Door-path resolution follows ambient `$HOME`**: `getRunDir()` returns
   `$HOME/.claude-box/run` when `XDG_RUNTIME_DIR` is unset, so launcherd looked
   for doors at `/tmp/.claude-box/run` (empty) → `DOORS_UNREACHABLE`. Only
   ambiguous because the container gives launcherd a *different* path view than
   the host.
3. **bind-mount source in the wrong namespace**: `buildPodmanArgv` uses
   `unixPath(d.host)` (launcherd's `/run/doors/...` view) as the `-v` source,
   but the podman server needs `/var/home/core/.claude-box/run/...`. The two
   diverge *only because* launcherd is a container whose mount point differs
   from the host path.

Every one of these is a place where a `string` path silently meant "a path in
some namespace" and the code never said which. They are invisible to the type
checker and to reading the code; they surface only at runtime, in one specific
container. That is the contract weakness this ADR closes.

## Options considered

### 1. Keep launcherd containerized; make the namespaces coincide
Mount the doors dir at the **same** path inside launcherd as on the host
(`Volume=%h/.claude-box/run:%h/.claude-box/run`), point door resolution there,
keep the host podman socket mounted. Then launcherd-view == host == bind-source,
and #2/#3 go away.

- **Pro:** stays within `ADR-ORCHESTRATION.md`'s "everything is a Quadlet unit."
- **Con:** preserves the isolation theater. The container still holds full host
  podman authority via the mounted socket, still needs the `HOME=/tmp` hack,
  still carries a baked image HOME. We'd be spending complexity to *simulate* a
  single namespace inside a boundary whose only purpose was isolation it isn't
  providing.

### 2. Run launcherd VM-native (a `systemd --user` service, not a container)
launcherd runs directly in the VM as the invoking user, with native access to
the podman socket at its real path and native visibility of the doors dir.

- **Pro:** collapses the three path namespaces to **one**. #1 (no image, real
  HOME), #2 (launcherd's view *is* the host path), and #3 (bind-source *is*
  launcherd's view) all cease to exist — not "are fixed," *cease to exist*.
- **Pro:** honest about the trust model — launcherd is the control plane; it is
  not pretending to be a sandboxed workload.
- **Con:** launcherd is no longer uniform with the other doors; it loses the
  Quadlet-managed container lifecycle (still `systemd`-managed, just not a
  `.container`). This is a deliberate, narrow exception, documented here.
- **Con:** loses the (real, if partial) resource caps a container gives
  (`PidsLimit`, `Memory`). Mitigation: systemd unit-level `MemoryMax=`/`TasksMax=`
  on the service provide the equivalent without a container.

## Decision

**Adopt Option 2.** launcherd runs VM-native. The other four door daemons stay
containerized. The distinction is a *contract about what each daemon is*:

> A daemon may be containerized **iff** it is a pure socket daemon with no
> host-runtime-control surface. launcherd controls the host runtime; therefore
> it is a control-plane process and runs on the host, not in a sandbox that
> would have to hand the host back to it anyway.

With one namespace, the path contract becomes trivial and enforceable:

| Path role | Value (single namespace) |
|---|---|
| Physical socket | `<doors-dir>/<daemon>.sock` |
| launcherd's view (`d.host`) | **same** — launcherd is on the host |
| bind-mount source | **same** — `unixPath(d.host)`, now correct by construction |
| spawned box's mount point (`d.guest`) | `/run/doors/<daemon>.sock` (in-box, unchanged) |

where `<doors-dir>` is resolved **explicitly** (the daemon socket env vars, or a
single `CLAUDE_BOX_DOORS_DIR`), never inferred from ambient `$HOME`.

## Consequences

Conforming changes (small, and each *enforces* the contract rather than just
obeying it):

1. **Drop `quadlet/launcherd.container`**; add a `systemd --user` service unit
   for launcherd in the VM with native podman access and `MemoryMax=`/`TasksMax=`.
2. **Door resolution stops following `$HOME`.** launcherd resolves `<doors-dir>`
   from an explicit source. `getRunDir()`'s `$HOME/.claude-box/run` fallback is a
   dev-CLI convenience, not something a daemon should inherit silently.
3. **`buildPodmanArgv`'s bind-mount source is unchanged** (`unixPath(d.host)`) —
   it becomes correct the moment `d.host` is a real host path.
4. **Enforce the invariant at boot, loudly** (this is the "code isn't a good
   enough contract" fix): on startup, and again before each spawn, launcherd
   asserts that every door path it will pass as a `-v` **source** actually
   exists on the host filesystem it can `stat()`. If a future change reintroduces
   a namespace split, launcherd fails *at boot with a named error*, not silently
   at dispatch time. The assertion IS the contract, executable.
5. **PR #207 (the `HOME=/tmp` correction) still lands first** — it deletes a
   false "unresolved security decision" from the code and is correct for as long
   as launcherd remains a container. When Option 2 lands, `launcherd.container`
   is removed and the `HOME` line goes with it; the *finding* it recorded (it was
   never a security wall) stays true in history.

### Follow-up: a path-namespace type (optional, higher-assurance)
The root cause is that `DoorTransport.host` is a bare path string with an unstated
namespace. A branded type — `HostPath` vs `InBoxPath` — would make bug #3 a
**compile error** and would let `buildPodmanArgv` refuse, at the type level, to
use an `InBoxPath` as a bind-mount source. Not required by this ADR, but it is
the TypeScript-today version of the "move to Rust for stronger contracts" idea:
make the currently-implicit namespace explicit and checkable at the boundary.

## Provenance chain
- Motivating diagnosis: live testing on 2026-07-04 (podman `version`/`ps`/`run`
  succeed from inside launcherd with `HOME=/tmp`; `DOORS_UNREACHABLE` traced to
  `getRunDir()` following `$HOME`; bind-mount source confirmed at
  `launcherd.ts:1078`).
- Related: `ADR-ORCHESTRATION.md` (the uniform Quadlet rule this refines),
  `LAUNCHERD.md` (why launch is a door at all), `ADR-CAPABILITY-TRANSPORT.md`.
