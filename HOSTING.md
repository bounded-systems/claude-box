# Hosting claude-box at home (Linux)

A native Linux host is the **easy path** for claude-box — and the one the design
bends toward. Almost everything in the docs about a `podman machine` VM, the
virtiofs *door wall*, `DOORS_TCP=1`, and the world-writable-`/tmp` guard exists
**only** to work around macOS (see [ROOM.md](./ROOM.md)). On a single Linux host
none of it applies: a door is just a host unix socket bind-mounted straight into
the room, and the daemons run as ordinary **rootless-podman systemd services**
via the quadlet units in [`quadlet/`](./quadlet/).

This guide covers what to buy and how to bring it up headless.

## TL;DR

1. Pick hardware — **ARM64** (Pi 5 / RK3588) or **x86_64** (Intel/AMD mini PC).
   Both are first-class in the flake now.
2. Install **nix** (flakes), **podman** (rootless), and enable **systemd user
   lingering** so the doors survive logout.
3. Build + load the images, `claude-box doors init`, then
   `claude-box --room dev --repo .`.
4. Reach it over SSH.

## Architecture: ARM64 *and* x86_64

The flake builds the image for both Linux arches
([`flake.nix`](./flake.nix) `systems`). Each pulls its own pinned `prx` release
binary and matching glibc loader (`prxAssets`), so there is **nothing to patch**
for either — pick hardware on price/performance, not compatibility.

| Path | Hardware | Notes |
|---|---|---|
| **aarch64-linux** | Raspberry Pi 5 (8/16GB), Radxa Rock 5B / Orange Pi 5 (RK3588), Ampere mini-server, Apple Silicon under Asahi | The original target; battle-tested. |
| **x86_64-linux** | Intel NUC / Beelink / Minisforum (N100/N305 or Core/Ryzen), repurposed desktop or thin client | Best performance-per-dollar; now builds out of the box. |

### Recommended specs

The door daemons are tiny — the quadlet units cap them at `Memory=512m` /
`PidsLimit=256`. The real consumer is Claude Code itself (a Bun/Node process plus
git, ripgrep, fd, …) running inside each room.

- **RAM:** 8GB minimum, **16GB comfortable**; more if you run several
  accounts/rooms concurrently.
- **Storage:** **NVMe/SSD strongly preferred** — the nix store and pinned OCI
  layers are sizable; budget ~30–50GB. Don't run it off an SD card.
- **Network:** wired Ethernet for an always-on headless box.

## Prerequisites

```sh
# nix with flakes (https://nixos.org/download). Enable flakes:
mkdir -p ~/.config/nix
printf 'experimental-features = nix-command flakes\n' >> ~/.config/nix/nix.conf

# podman (rootless). On Debian/Ubuntu:
sudo apt-get install -y podman
# Rootless needs subuid/subgid ranges for your user (usually preconfigured):
grep "$USER" /etc/subuid /etc/subgid || \
  echo "set up /etc/subuid + /etc/subgid for rootless podman"

# systemd is already present on mainstream distros.
```

> **NixOS** is an excellent host for this — install `podman`
> (`virtualisation.podman.enable = true;`) and skip the per-distro setup.

## Bring-up

```sh
git clone https://github.com/bdelanghe/claude-box && cd claude-box

# 1. Build + load the box image (resolves to your arch automatically).
nix build .#claude-image && podman load -i result

# 2. Build + load the door images.
for d in keeperd netd scoutd; do
  nix build .#"$d"-image && podman load -i result
done

# 3. Get the launcher CLI on PATH (now built for Linux too).
nix profile install .#claude-box      # or: nix run .#claude-box -- --help

# 4. Initialize and start the doors (installs the quadlet user units).
claude-box doors init
claude-box doors status

# 5. Launch a box.
claude-box --room dev --repo .
```

First run of an account → `/login` once; it persists in that account's volume
(`claude-<account>-config`).

### Or pull prebuilt images from GHCR

Tagged releases publish the four images to GHCR for `linux/amd64` and
`linux/arm64` (see [RELEASING.md](./RELEASING.md)), so you can skip the nix build
and pull a pinned image straight onto the host:

The box image is `claude-room`; the three door daemons are `door-keeper`,
`door-net`, `door-scout`:

```sh
podman pull ghcr.io/bounded-systems/claude-box/claude-room:<version>
for d in door-keeper door-net door-scout; do
  podman pull ghcr.io/bounded-systems/claude-box/$d:<version>
done
```

Pin to a specific `:<version>` (or a `@sha256:` digest) rather than `:latest` —
the digest *is* the pin the whole design rests on. You still need the
`claude-box` CLI (`nix profile install .#claude-box`) to launch them.

**Smoke-test the published images** with [`scripts/smoke-doors.sh`](./scripts/smoke-doors.sh):
it boots each door image (any OS) and — on Linux — brings up `scout-netd` +
`scoutd --network=none` and does a real GitHub read *through* the scout door,
proving scoutd reaches GitHub with no NIC of its own:

```sh
./scripts/smoke-doors.sh 0.3.0
```

### home-manager install (declarative)

The README snippet now resolves on Linux because `claude-box` is exported for
every Linux system:

```nix
inputs.claude-box.url = "github:bdelanghe/claude-box";
# …
home.packages = [ inputs.claude-box.packages.${system}.claude-box ];
```

(`packages.x86_64-linux.claude-box` / `packages.aarch64-linux.claude-box`.)

### NixOS (declarative doors)

On a NixOS host the door daemons can run as system services straight from the
flake — no manual `quadlet` copy, no `systemctl --user enable`:

```nix
{
  inputs.claude-box.url = "github:bdelanghe/claude-box";

  # in your nixosConfigurations.<host>.modules:
  imports = [ inputs.claude-box.nixosModules.default ];
  services.claude-box.doors.enable = true;   # keeperd + netd + scoutd
  # services.claude-box.doors.doors = [ "scout" ];   # or a subset
}
```

The module ([`nixos/doors.nix`](./nixos/doors.nix)) runs each door via
`virtualisation.oci-containers` using the image **built by this flake** (pinned
by digest — no GHCR pull), and applies the same hardening as the quadlet units
(no-new-privileges, read-only rootfs, drop-all-caps, pids/memory caps, and
`--network=none` for keeperd). Options: `socketDir` (default
`/run/claude-box/doors`, mounted into each door) and `keysDir` (keeperd's
signing key).

**Verify it** with the in-repo runner (no hand-written `nixos-rebuild` snippet):

```sh
nix run .#verify        # flake check → module eval → build door images → VM boot test
# or just the boot test (Linux + KVM host):
nix build .#checks.x86_64-linux.doors
```

The boot test is a `nixosTest` ([`flake.nix`](./flake.nix) `doorsTest`) that
enables the doors in a VM and asserts keeperd/netd/scoutd start and their sockets
appear. The one thing to watch on a real host is **socket ownership** — the doors
run as uid 1000 in rootful podman and write into `socketDir`, and the user that
launches the box must be able to read them. If a door is unreachable, check
`socketDir` perms (created `0750`, uid 1000) and the container userns mapping.

## Run it headless

The doors are `systemctl --user` services. For them to keep running when you're
not logged in (the whole point of a home server), enable **lingering** once:

```sh
loginctl enable-linger "$USER"

# Verify after a reboot:
systemctl --user status keeperd netd scoutd
journalctl --user -u netd -f
```

Then SSH in and run `claude-box` whenever you want a room. The doors stay up; the
keys (keeperd's git creds, netd's allowlist) live on the host, a whole boundary
away from any room — least authority is the topology, not a setting
([ROOM.md](./ROOM.md)).

## Why Linux is simpler than the macOS docs suggest

| macOS friction | On a Linux host |
|---|---|
| `podman machine` VM | none — podman runs containers directly |
| virtiofs *door wall* (`statfs: not supported`) | gone — doors are direct socket bind-mounts |
| `DOORS_TCP=1` / `host.containers.internal` | not needed — unix sockets work |
| world-writable `/tmp` door guard | use `$XDG_RUNTIME_DIR` (set on systemd logins) |

So the unsafe escapes (`--net-open`, the retired TCP bootstrap) are unnecessary:
policed doors are the default, easy path here.

## Build targets reference

- `nix build .#claude-image` — the box (default for `nix build` is this image).
- `nix build .#keeperd-image` / `.#netd-image` / `.#scoutd-image` — the doors.
- `nix run .#claude-box` / `nix profile install .#claude-box` — the launcher CLI.
- `nix build .#peercred` — the SO_PEERCRED injector (launcherd).

See [BUILD.md](./BUILD.md) for cross-arch/offload notes (e.g. building the ARM
image from a Mac) and [quadlet/README.md](./quadlet/README.md) for the unit
files.
