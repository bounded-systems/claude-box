# claude-box

A **pinned, isolated, multi-account Claude runtime** — Claude Code in a
content-addressed OCI container, one account per volume, built reproducibly by
nix. Each account's auth/history/projects live in their own podman volume; the
container itself is credential-free (see [CAPABILITIES.md](./CAPABILITIES.md)).

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
[CAPABILITIES.md](./CAPABILITIES.md).

## Install (home-manager)

```nix
inputs.claude-box.url = "github:bdelanghe/claude-box";
# …
home.packages = [ inputs.claude-box.packages.${system}.claude-box ];
```

`claude-box` is a typed Bun CLI, nix-built (a pinned-bun launcher — `bun
--compile` can't run in the nix sandbox). It needs **podman** + a running
`podman machine`, and the image loaded (below).

## The image

`packages.aarch64-linux.claude-image` — `dockerTools.buildLayeredImage` from a
pinned nixpkgs (`claude-code` + git, gh, ripgrep, fd, bun, openssh…), non-root
`claude` user, config-volume mount point. The resulting OCI image is addressed
by its own **sha256 digest** — the pin.

Building needs an `aarch64-linux` builder (the flake exposes
`nix run .#linux-builder` for a standalone one on darwin):

```sh
nix build .#claude-image           # offloads to the Linux builder
podman load -i result              # → localhost/claude-personal:dev
```

`buildLayeredImage` (not `streamLayeredImage`) on purpose: the stream script is
a target-arch executable that can't run on the darwin host; a tarball loads
anywhere.

## Status

Extracted from the prx `claude-runtime` work (ADR: [ADR.md](./ADR.md)). prx's
**builder actor** is the intended producer/signer of the image; this repo is the
self-contained source.
# test
