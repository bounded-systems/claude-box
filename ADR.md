# ADR — the personal Claude runtime: a pinned OCI container (not a VM)

> Status: **proposed** (2026-06-08). Tracking: epic `prx-d4o`. Supersedes the
> VM-runtime framing of `prx-bst` (session-host) and deprioritizes `prx-5ed`
> (prx-owns-the-VM) *for the Claude runtime*. Claude is currently installed in
> the Lima devshell VM via the native installer as an **interim bridge**
> (unpinned, self-updating) — this ADR replaces that.

## Problem

We want to run a **personal** Claude account isolated from the **work** account,
reproducibly, on this Mac. The first instinct was "run Claude in the Lima VM"
(the beadsd pattern: prx owns a VM, daemons live in it). Two things broke that:

1. **A full VM is heavy for account separation.** The Ubuntu devshell VM
   reserves 6 GiB RAM / 80 GiB disk and boots a whole OS; a NixOS VM is heavier
   still. The actual threat model here is *don't cross-contaminate two configs*,
   not *sandbox untrusted code* — a VM is overkill.
2. **The native `curl | bash` installer is unpinned and self-updating.** That
   contradicts prx's content-addressed, anchored-chain ethos. The ask was
   explicitly "a **sha** we can pin to."

## What "pin to a sha" actually requires

The pin lives in an **artifact's content address**, not in the OS — you do **not
need NixOS** (or any particular OS) to pin a package. Two content-addressed
packaging models get conflated; they are not the same artifact:

| | **nix closure** | **OCI image** |
| --- | --- | --- |
| addressed by | `/nix/store/<hash>` paths | manifest **sha256 digest** |
| delivered via | `nix copy` | registry pull / `nerdctl load` |
| runs on | a host that has the nix store | **any** OCI runtime |
| needs nix on target | yes | no |

The "**`nix build` the closure → `nix copy` into the VM → symlink `claude`**"
north star is the **nix-closure** model — it is **not OCI**. It ships store
paths and needs the nix store on the target. The OCI model is
`dockerTools.streamLayeredImage`, which *builds* an OCI image from the **same**
pinned nixpkgs: the layers are store paths, but the artifact is an OCI manifest
with a digest, runnable anywhere. Both are "build a pinned artifact, ship it";
only the second is a container.

## Decision

Run the personal Claude as a **pinned OCI container**.

- **Image** — built with **nix `dockerTools.streamLayeredImage`** from the
  pinned nixpkgs (`claude-code` = 2.1.175 @ rev `9f11f82`, license *unfree*,
  `aarch64-linux` ✓) plus the agent toolchain it needs to be useful (git, gh,
  ripgrep, bun, prx). Reproducible build → **deterministic digest**. Double pin:
  the nixpkgs rev *and* the resulting image digest.
- **Runtime** — **containerd + `nerdctl` inside the existing Lima devshell VM**
  (already present), and/or **rootless `podman`** host-side. Explicitly **not
  Docker**: host Docker Desktop is being removed, and its root daemon is the
  ambient-authority / confused-deputy anti-pattern ocap rejects. The image is
  standard OCI, so the runtime stays swappable.
- **Isolation** — a persistent volume for the personal `~/.config/claude`,
  separate from the work account; repo and MCP mounts are **explicit,
  least-privilege grants**, not ambient access.

## ocap fit

Rootless podman / containerd-in-VM means **no root daemon, user-namespaced, no
`docker`-group≈root ambient authority**. Mounts and network egress become
explicit capability grants — the same shape as prx's capability seams
(`@bounded-systems/proc`, `/fs`, `/host` as the one sanctioned access points).
A self-updating curl binary, by contrast, is an unbounded, unaudited mutation.

## Concerns (the honest tradeoffs)

1. **Weaker isolation than a VM.** Containers share the host kernel; a
   kernel-escape escapes the container. Acceptable for *account separation*;
   revisit if we ever run untrusted code as this account.
2. **macOS still needs a Linux kernel.** "Container, not VM" really means *one
   shared light VM (the Lima VM, or a `podman machine`), many cheap
   containers* — not zero VMs.
3. **Building a Linux OCI image via nix from macOS needs a Linux builder**
   (the Lima VM as a remote builder, a `nix-darwin` `linux-builder`, or CI).
   `dockerTools` produces Linux images; an `aarch64-darwin` host can't build
   them alone. **Open logistic.**
4. **Pinned nixpkgs lags upstream** (the pin tracks nixpkgs, which trails the
   native installer — e.g. pinned 2.1.175 vs the installer's 2.1.177).
   Upgrades become a deliberate, reviewable **sha bump** — a feature, but it
   means no automatic version/security updates; someone must bump the lock.
5. **A useful Claude needs the whole dev toolchain** (git/gh/rg/bun/prx) +
   repo mounts. The image grows and re-couples to the toolchain — the very
   thing that made a devshell/VM attractive. nix composes this cleanly, but it
   is real surface to maintain and pin.
6. **Auth friction.** `/login` OAuth in a container prints a URL to open on the
   host browser and paste a code back; the token persists in the config volume
   — a **secret to protect** (volume permissions, no accidental commit/mount).
7. **State hygiene.** Ephemeral containers lose state unless the config volume
   is named/persistent; every mount re-introduces host coupling that the
   container was meant to reduce.

## Consequences

- prx owns an **OCI-digest lifecycle** (build pinned image → load → run), not a
  VM lifecycle — *more* aligned with `@bounded-systems/cas` and the anchored
  chain than a VM ever was.
- The data daemons (beadsd / keeperd / dolt) stay in the Lima VM; Claude becomes
  a container that can run *in that same VM's containerd* or host-side.
- Interim: the curl-installed Claude in the VM stays until the image lands.
- A `claude-box` (a.k.a. `claude-personal`) wrapper runs the pinned image with
  the config volume — replacing the host `CLAUDE_CONFIG_DIR` alias hack.

## Open questions

- **Where the Linux image builds** — Lima VM remote builder vs `nix-darwin`
  `linux-builder` vs CI (concern #3).
- **Image distribution & end-to-end pinning** — local `nerdctl load` of a built
  tarball vs a registry digest; whether the image digest gets **signed into the
  anchored chain** (a `built@<rev>` derivation) so the run is provenance-tracked.
- **Whether the session-host daemon (`prx-bst`) becomes a container-spawner**
  rather than a tmux/VM-process launcher.

## History

Considered and rejected on the way here:

- **NixOS VM** — a pinned `environment.systemPackages` image is the tidiest
  delivery, but switching the *running* daemon VM (beadsd/keeperd/dolt) to NixOS
  is a full-OS migration with too much blast radius. NixOS is not required to
  pin (see *What "pin to a sha" requires*).
- **Ubuntu VM + `nix profile install`** — keeps the VM, pins claude via nix
  without NixOS; correct but still carries full-VM weight for account
  separation.
- **Host `curl | bash` native installer** — unpinned, self-updating; kept only
  as the interim bridge until the image lands.
