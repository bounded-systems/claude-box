# BUILD.md — building the image on an Apple Silicon Mac

`claude-box`'s images target **`aarch64-linux`** (see `flake.nix`: `systems =
[ "aarch64-linux" ]`). On an `aarch64-darwin` host Nix can't build them
directly — it needs a reachable **`aarch64-linux` builder**. This doc gets one
wired up.

```sh
nix build .#claude-image     # offloads to the Linux builder → ./result (tarball)
podman load -i result        # → localhost/claude-personal:dev
```

If you see `Failed to find a machine for remote build! … Required system:
'aarch64-linux'`, you have no builder registered — start here.

## Use a vz (Apple Virtualization.framework) builder, not QEMU

The turnkey `nix run .#linux-builder` (and upstream `nixpkgs#darwin.linux-builder`)
boots a **QEMU/HVF** VM. On recent macOS + Apple Silicon (M3/M4) that QEMU path
crashes before the guest boots:

```
hvf_arch_init_vcpu: assertion failed: (HV_SYS_REG_SMCR_EL1 == KVMID_TO_HVF(...))
```

That's a QEMU-on-HVF bug: the host now exposes the **SME** (Scalable Matrix
Extension) system registers and the pinned QEMU's HVF accelerator can't map them
(qemu#2665). It's a moving target across QEMU versions.

**Avoid it entirely by using a builder backed by Apple's Virtualization.framework
(`vz`)** instead of QEMU. A vz guest doesn't go through QEMU's HVF vCPU init, so
the SME assertion never fires. If `apple-virt` shows up in your host's Nix
feature set, vz is available:

```sh
nix show-config | grep -i system-features   # look for `apple-virt`
```

> Determinate Nix owns `/etc/nix/nix.conf` and sets `nix.enable = false` for
> nix-darwin, so the turnkey `nix.linux-builder` **module** is unavailable. We
> register the builder the module-free way: a line in **`/etc/nix/machines`**.

## Recommended: register a Lima (vz) VM as the builder

[Lima](https://lima-vm.io) runs its guests on `vz` by default on Apple Silicon —
so a Lima `aarch64-linux` VM is a crash-free builder. If you already run one
(e.g. a devshell VM), you only need Nix inside it and one line in
`/etc/nix/machines`.

### 1. Install Nix in the VM

The VM needs `nix-daemon` reachable over SSH. (Symptom of a VM with **no** Nix:
`error: … Nix daemon disconnected unexpectedly (maybe it crashed?)` — SSH
connects, but there's nothing serving `nix-daemon --stdio` on the far end.)

```sh
limactl shell <vm-name>     # e.g. bdelanghe-lima-devshell-main
# inside the VM (Determinate installer; works on the usual Linux distros):
curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix \
  | sh -s -- install linux --no-confirm
exit
# verify from the host:
limactl shell <vm-name> -- nix --version
```

### 2. Point Nix at the VM over SSH

Add a `Host` block so `/etc/nix/machines` can use a stable alias instead of a
long Lima socket path. Grab the VM's port and identity key from
`ssh -F ~/.lima/<vm-name>/ssh.config <vm-name>` (Lima emits the exact flags) —
on a default Lima VM it's `127.0.0.1`, port from `limactl list`, key
`~/.lima/_config/user`:

```sshconfig
# ~/.ssh/config
Host claude-box-builder
  HostName 127.0.0.1
  Port 50348                                   # from `limactl list`
  User <vm-user>                               # e.g. your username inside the VM
  IdentityFile ~/.lima/_config/user
  IdentitiesOnly yes
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
```

Test it as the **root** daemon user (the Nix daemon, not your login shell, runs
the build), then trust the host key once so the non-interactive build doesn't
stall:

```sh
sudo ssh claude-box-builder 'nix --version'
```

### 3. Register it in `/etc/nix/machines`

```
# /etc/nix/machines
# <ssh-uri> <system> <ssh-key> <maxjobs> <speedfactor> <features> <mandatory> <pubkey>
ssh-ng://claude-box-builder aarch64-linux /var/root/.ssh/id_builder 4 1 big-parallel,benchmark,kvm,nixos-test - -
```

Notes:
- The key path must be readable by the **daemon** (root). Either give root its
  own key (`IdentityFile` above + matching `authorized_keys` in the VM) or use a
  key root can read. Don't point it at a user-only key.
- `-` placeholders are fine for the trailing optional fields.
- Reload the daemon after editing:
  ```sh
  sudo launchctl kickstart -k system/systems.determinate.nix-daemon
  ```

### 4. Trust paths coming back from the builder

Paths built on a remote builder are copied into your local store, and the daemon
**rejects unsigned paths** unless the requesting user is trusted:

```
error: cannot add path '/nix/store/…' because it lacks a signature by a trusted key
```

Add yourself to `trusted-users`. Determinate Nix owns `/etc/nix/nix.conf` but
includes `/etc/nix/nix.custom.conf` — put overrides there:

```sh
# /etc/nix/nix.custom.conf
echo "trusted-users = root $(whoami)" | sudo tee -a /etc/nix/nix.custom.conf
sudo launchctl kickstart -k system/systems.determinate.nix-daemon
```

(Trusted users may import unsigned paths; this is the intended way to accept
output from your own builder. Avoid the blunter `require-sigs = false`.)

### 5. Build + load

```sh
cd <repo>
nix build .#claude-image      # offloads to claude-box-builder
podman load -i result         # → localhost/claude-personal:dev
podman image exists localhost/claude-personal:dev && echo OK
```

`buildLayeredImage` (not `streamLayeredImage`) is used on purpose: the stream
script is a target-arch executable that can't run on the darwin host, whereas a
tarball is just data and loads anywhere.

The other images build the same way:
`.#keeperd-image`, `.#netd-image`, `.#scoutd-image`.

## One-off alternative: `--builders` on the command line

To build without touching `/etc/nix/machines`:

```sh
nix build .#claude-image \
  --builders 'ssh-ng://claude-box-builder aarch64-linux - 4 1 big-parallel,kvm' \
  --builders-use-substitutes
```

## Fallback: the bundled QEMU builder

`flake.nix` still exposes the standalone QEMU builder:

```sh
nix run .#linux-builder       # boots a pinned QEMU/HVF aarch64-linux VM
```

Use it only if vz isn't an option — and expect the `HV_SYS_REG_SMCR_EL1` crash
above on M3/M4 hosts. Local VM state (private key + multi-GB qcow2) is
git-ignored; never commit `keys/` or `*.qcow2`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Failed to find a machine for remote build … aarch64-linux` | no builder registered | add the `/etc/nix/machines` line (step 3) |
| `Nix daemon disconnected unexpectedly (maybe it crashed?)` | SSH works but no Nix in the VM | install Nix in the VM (step 1) |
| `failed to start SSH master connection` | host alias unreachable / wrong port | fix the `~/.ssh/config` `Host` block (step 2) |
| `Permission denied (publickey)` under `sudo nix build` | daemon (root) can't read the key | give root a readable `IdentityFile` |
| `cannot add path '…' because it lacks a signature by a trusted key` | your user isn't trusted, so unsigned builder output is rejected | add `trusted-users = root <you>` (step 4) |
| `HV_SYS_REG_SMCR_EL1` assertion | QEMU/HVF + SME on M3/M4 | use a **vz** builder (this doc), not `.#linux-builder` |
