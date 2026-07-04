# ADR — launcherd is a control plane; reimplement it in Rust, VM-native, one path namespace

> Status: **accepted** (2026-07-04). Tracking: refines `ADR-ORCHESTRATION.md`
> (Quadlet for doors) for the one daemon that ADR's uniform rule doesn't fit.
> Motivating incident: an end-to-end dispatch spawn failed through three
> stacked, runtime-only bugs (see Context). This ADR is the contract those
> bugs violated — written before the fix, so the fix conforms to it rather
> than the contract being reverse-engineered from whatever the patch did.
> Amended same-day (still pre-implementation): the accepted "VM-native" decision
> collided with a substrate constraint found during setup — the VM (Fedora
> CoreOS) has no JS runtime and the nix bun can't run there — so "VM-native"
> is realized as a **static Rust binary** (Option 3), not a bun bundle. The
> path-namespace contract is unchanged; only launcherd's implementation language
> and runtime shape are. No conforming code was written before this amendment.

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

### 3. VM-native, but reimplemented in Rust (a static native binary)
The same as Option 2 — launcherd runs directly on the VM host — but it stops
being a bun program. Discovered during implementation (2026-07-04): Option 2 as
literally written is **not achievable with the current runtime**. The VM is
Fedora CoreOS with no bun and no node, and the nix-built bun cannot run on it —
its ELF interpreter is `/nix/store/…/ld-linux-aarch64.so.1`, which CoreOS does
not have (`"cannot execute: required file not found"`). Every door is
containerized *precisely* to carry the bun runtime the VM lacks. So "drop the
container and run the bun bundle on the host" is a contradiction: removing the
container removes the only runtime.

A Rust launcherd compiled to a **static binary** (musl target, no dynamic
loader) has **zero runtime dependency** — it runs natively on CoreOS with no
container, no bun, no nix loader. That is what makes true VM-native actually
reachable, not just asserted.

- **Pro:** genuinely achieves Option 2's single-namespace collapse — the
  runtime problem that blocked it disappears.
- **Pro:** launcherd is the **most security-critical door** (it holds podman —
  the one host-control surface in the system). Reimplementing *it* in a language
  whose type system can encode the path-namespace contract directly — `HostPath`
  vs `InBoxPath` as distinct types, so a wrong-namespace bind-mount source is a
  **compile error, not a runtime surprise** — puts the strongest guarantees
  exactly where the blast radius is largest. This is the concrete, scoped form
  of the standing "the code isn't a good enough contract" concern.
- **Pro:** not greenfield — `peercred/` is already a Rust crate that exists
  *only* to serve launcherd (SO_PEERCRED caller-UID injection, same NDJSON
  protocol). The toolchain (`rustPlatform.buildRustPackage`), the nix build
  pattern, and launcherd's own sidecar are already Rust. A Rust launcherd
  absorbs peercred rather than starting from nothing.
- **Con:** it is a **reimplementation**, not a config change — materially more
  work than Options 1/2, and it must reach behavior parity with `launcherd.ts`
  (dispatch + launch RPCs, door resolution, podman argv, rate/concurrency
  limits, grant handling). Mitigated by doing it contract-first and
  incrementally (dispatch path first — the narrow, highest-value lane), with the
  TS launcherd staying in place until parity is proven.

## Decision

**Adopt Option 3: reimplement launcherd in Rust as a static (musl) binary,
running VM-native.** The other four door daemons stay containerized. The
distinction is a *contract about what each daemon is*:

> A daemon may be containerized **iff** it is a pure socket daemon with no
> host-runtime-control surface. launcherd controls the host runtime; therefore
> it is a control-plane process and runs on the host, not in a sandbox that
> would have to hand the host back to it anyway.

Option 3 over Option 2 because the VM has no JS runtime and the nix bun can't run
there (see above); a static Rust binary is the *only* form of "VM-native" that
actually runs. Option 3 over Options 1 (path-matched container) because that
keeps the isolation theater and the bun/HOME workarounds, spending complexity to
*simulate* a single namespace inside a boundary that provides no isolation.

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

Because Option 3 is a reimplementation, it lands **contract-first and
incrementally** — the TS launcherd (`launcherd.ts`, containerized, now with the
`HOME=/tmp` fix from #207) stays the live daemon until the Rust one proves parity
and cuts over. Sequence:

1. **Write the wire + path contract first** (before Rust code): the NDJSON RPC
   surface (`dispatch`, `launch`, `list`, `attach`, `kill`, `status`) and the
   path-namespace types. `peercred/` already fixes the NDJSON framing and the
   `_caller` injection shape — the contract extends that, it doesn't invent it.
2. **Path-namespace as types, not comments.** `HostPath` vs `InBoxPath` are
   *distinct Rust types*. `podman run -v SRC:DST` takes `SRC: HostPath`,
   `DST: InBoxPath`; passing an `InBoxPath` as a source **does not compile**. Bug
   #3 becomes structurally impossible rather than assertion-caught. (The runtime
   `stat()` boot-assertion from Option 2 still ships as defense-in-depth for the
   one thing types can't see: whether the path exists on *this* host right now.)
3. **`<doors-dir>` is an explicit input**, never inferred from ambient `$HOME` —
   a required config/flag, so a daemon can't silently resolve doors from the
   wrong place the way the TS `getRunDir()` `$HOME` fallback allowed.
4. **Build + ship as a static binary.** Extend the existing `peercred`
   `rustPlatform.buildRustPackage` pattern with a musl target so the output has
   no dynamic loader and runs on CoreOS. Absorb `peercred` into the launcherd
   crate (it's already launcherd's sidecar).
5. **Run VM-native**: a `systemd --user` service on the VM (native podman socket,
   `MemoryMax=`/`TasksMax=` for the resource caps a container would have given),
   replacing `quadlet/launcherd.container`.
6. **Cut over only on proven parity**: dispatch lane first (`{room,label}` →
   independent RC box, verified end-to-end), then launch/list/attach/kill, then
   retire `launcherd.ts` + `launcherd.container` + the `launcherd-image`.

Increment order is deliberate: **dispatch first** — it is the narrowest surface
(two params, allow-listed rooms, no attenuation) and the highest user value (it
is what "talk to the dispatcher and have it spawn a box" needs). launch/attach/
kill follow once the spawn substrate is proven.

## Provenance chain
- Motivating diagnosis: live testing on 2026-07-04 (podman `version`/`ps`/`run`
  succeed from inside launcherd with `HOME=/tmp`; `DOORS_UNREACHABLE` traced to
  `getRunDir()` following `$HOME`; bind-mount source confirmed at
  `launcherd.ts:1078`; nix bun confirmed non-runnable on CoreOS — interpreter
  `/nix/store/…/ld-linux-aarch64.so.1` absent).
- Related: `ADR-ORCHESTRATION.md` (the uniform Quadlet rule this refines),
  `LAUNCHERD.md` (why launch is a door at all), `ADR-CAPABILITY-TRANSPORT.md`,
  `peercred/` (the existing Rust sidecar this absorbs).
