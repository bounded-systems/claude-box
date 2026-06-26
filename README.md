# claude-box

A **pinned, isolated, multi-account Claude runtime** — Claude Code in a
content-addressed OCI container, one account per volume, built reproducibly by
nix. Each account's auth/history/projects live in their own podman volume; the
container itself is credential-free (see [CAPABILITIES.md](./CAPABILITIES.md)).

## Quick Start

**Prerequisites:** [nix](https://nixos.org/download) (with flakes), [podman](https://podman.io/docs/installation) + `podman machine` (macOS)

**macOS — one call:** `nix run .#setup` does the whole bringup (prereqs →
`podman machine` → build+load the image → start the doors on TCP). Then, in
another terminal:

```sh
nix run .#setup                              # one-time bringup, leaves doors running
DOORS_TCP=1 claude-box --room dev --repo .   # launch a box (TCP mode — see note below)
```

On macOS the doors run in **TCP mode** (`DOORS_TCP=1`): virtiofs can't share
Unix sockets across the macOS ↔ podman-machine boundary, so daemons listen on
TCP ports and containers reach them via `host.containers.internal`.

**Manual / Linux:**

```sh
# 1. Build and load the Claude image
nix build .#claude-image && podman load -i result

# 2. Initialize door services (one-time setup; Linux/quadlet)
claude-box doors init

# 3. Launch with full capabilities
claude-box --room dev --repo .

# Or quick start without doors (unsafe, but works immediately):
claude-box --net-open --repo .
```

**Self-hosting at home?** A native Linux host is the easy path (no
podman-machine VM, no door wall). See **[HOSTING.md](./HOSTING.md)** for hardware
suggestions (ARM64 *and* x86_64 are both first-class) and a headless bring-up.

## Use

```sh
claude-box                 # 'personal' account (no network — see --net)
claude-box work            # 'work' account — separate auth/history
claude-box work --resume   # flags pass through to claude
claude-box work --net      # policed egress via the netd door (allowlist)
claude-box ls              # list accounts (+ descriptions)
claude-box name work "Acme, Inc. — billing@acme"   # friendly label
```

First run of an account → `/login` once; it persists in that account's volume
(`claude-<account>-config`). Names are free-form; labels live in
`~/.config/claude-box/accounts.json`.

A container bounds what the box can *write*, not what it can *reach* — so
**egress is a grant**: the box runs `--network=none` by default and reaches the
network only through the **netd** door (`--net`), which enforces an allowlist
(`--net-open` is an explicit, unsafe full-egress escape). See
[CAPABILITIES.md](./CAPABILITIES.md) — and [OCAP.md](./OCAP.md) for where this
applied object-capability design sits in the established canon.

## Design — a room for any guest

The capability engine (door → room → rulebook) is guest-agnostic and lives in
[`guest-room/`](./guest-room/) — an internal dependency `claude-box` consumes by
supplying its own door catalog and room bundles. The model is a **hotel**:
independent rooms joined by adjoining doors, each door reaching one brokered
service, never the keys or the building. The essay
[*The Guest Room*](./drafts/the-guest-room.md) tells that story end to end; the
topology (host / VM / room) is in [ROOM.md](./ROOM.md).

## Install (home-manager)

```nix
inputs.claude-box.url = "github:bounded-systems/claude-box";
# …
home.packages = [ inputs.claude-box.packages.${system}.claude-box ];
```

`claude-box` is a typed Bun CLI, nix-built (a pinned-bun launcher — `bun
--compile` can't run in the nix sandbox). It needs **podman** + a running
`podman machine`, and the image loaded (below).

## The image

`packages.{aarch64,x86_64}-linux.claude-image` — `dockerTools.buildLayeredImage`
from a pinned nixpkgs (`claude-code` + git, gh, ripgrep, fd, bun, openssh…),
non-root `claude` user, config-volume mount point. The resulting OCI image is
addressed by its own **sha256 digest** — the pin. Both Linux arches build out of
the box (each pins its own `prx` release + glibc loader); see
[HOSTING.md](./HOSTING.md).

Building needs an `aarch64-linux` builder. On Apple Silicon use a **vz**
(Apple Virtualization.framework) builder — the QEMU `nix run .#linux-builder`
crashes on M3/M4 (`HV_SYS_REG_SMCR_EL1`); see **[BUILD.md](./BUILD.md)** for the
full setup:

```sh
nix build .#claude-image           # offloads to the Linux builder
podman load -i result              # → localhost/claude-personal:dev
```

`buildLayeredImage` (not `streamLayeredImage`) on purpose: the stream script is
a target-arch executable that can't run on the darwin host; a tarball loads
anywhere.

## Development

```sh
# Run tests (no podman needed for unit tests)
bun test

# Type check
bun x tsc --noEmit   # `bunx` is a separate binary not all bun installs ship; `bun x` always works
```

Commits/PR titles follow [Conventional Commits](https://www.conventionalcommits.org/)
(releases are cut from them) — see [CONTRIBUTING.md](./CONTRIBUTING.md) and
[RELEASING.md](./RELEASING.md).

### Starting the doors (daemons)

The `--room dev` preset requires three daemons: keeperd (git signing), scoutd
(external reads), and netd (egress allowlist).

**One-shot setup** (builds images, installs systemd units, starts services):

```sh
claude-box doors init
```

This runs in podman-machine (macOS) or native systemd (Linux). After init:

```sh
claude-box doors status          # check service status
claude-box --room dev --repo .   # launch with all doors
```

**Manual daemon startup** (alternative to quadlet):

```sh
nix run .#keeperd -- serve   # → ~/.claude-box/run/keeperd.sock
nix run .#scoutd  -- serve   # → ~/.claude-box/run/scoutd.sock
nix run .#netd    -- serve   # → ~/.claude-box/run/netd.sock
```

Each daemon auto-creates `~/.claude-box/run/` with safe permissions (0700).
Override socket paths with `--socket PATH` or env vars (`KEEPERD_SOCK`, etc.).

### Quick start (no daemons)

For development without full door setup, use the unsafe escapes:

```sh
claude-box --net-open --repo .   # unrestricted egress, no daemon needed
```

## Status

Extracted from the prx `claude-runtime` work (ADR: [ADR.md](./ADR.md)). prx's
**builder actor** is the intended producer/signer of the image; this repo is the
self-contained source.
