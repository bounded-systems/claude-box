# Quadlet Units for claude-box

Systemd unit files for running door daemons as containers.

```
quadlet/
├── claude-doors.volume   # shared socket volume
├── claude-keys.volume    # keeperd signing keys
├── keeperd.container     # git-signing daemon (no network)
├── netd.container        # the box's egress door (claude-netd: Anthropic allowlist)
├── scout-netd.container  # scoutd's egress door (a netd instance: GitHub allowlist)
└── scoutd.container      # external reads — runs --network=none, egress via scout-netd
```

## Schema

We use a subset of the [Quadlet .container spec](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html):

### [Unit] section (systemd)

| Key | Usage |
|-----|-------|
| `Description=` | Human-readable service description |
| `After=` | Start after these units (volume dependencies) |

### [Container] section (Quadlet)

| Key | Usage | Example |
|-----|-------|---------|
| `Image=` | Container image (required) | `localhost/keeperd:dev` |
| `ContainerName=` | Override default name | `keeperd` |
| `Volume=` | Mount volumes (repeatable) | `claude-doors.volume:/run/doors:U` |
| `Network=` | Network mode | `none` (isolated) or default (egress) |
| `NoNewPrivileges=` | Block privilege escalation | `true` |
| `ReadOnly=` | Read-only root filesystem | `true` |
| `ReadOnlyTmpfs=` | Writable /tmp, /run, /dev | `true` |
| `DropCapability=` | Remove Linux capabilities | `all` |
| `SecurityLabelDisable=` | Disable SELinux separation | `true` |
| `PidsLimit=` | Max processes | `256` |
| `Memory=` | Memory limit | `512m` |

### [Service] section (systemd)

| Key | Usage |
|-----|-------|
| `Restart=` | Restart policy | `always` |
| `RestartSec=` | Delay between restarts | `5` |

### [Install] section (systemd)

| Key | Usage |
|-----|-------|
| `WantedBy=` | Target for enable | `default.target` |

## Security hardening

All doors use defense-in-depth:

- **NoNewPrivileges** — cannot escalate via setuid/setgid
- **ReadOnly** — root filesystem is immutable
- **DropCapability=all** — no Linux capabilities
- **PidsLimit** — prevent fork bombs
- **Memory** — prevent OOM from affecting host
- **Network=none** (keeperd) — no network access at all

## Install

### macOS (via podman machine)

```bash
# Build and load images
nix build .#keeperd-image && podman load -i result
nix build .#netd-image && podman load -i result
nix build .#scoutd-image && podman load -i result

# Install quadlet units
./quadlet/install.sh

# Start doors
podman machine ssh -- systemctl --user start keeperd
podman machine ssh -- systemctl --user start netd
podman machine ssh -- systemctl --user start scoutd
```

### macOS (via Lima)

```bash
# One-time: create Lima VM
limactl create --name=claude template://podman
limactl start claude

# Copy units
limactl copy *.volume *.container claude:~/.config/containers/systemd/

# Enable
limactl shell claude -- systemctl --user daemon-reload
limactl shell claude -- systemctl --user enable --now keeperd netd
```

### Linux

```bash
mkdir -p ~/.config/containers/systemd
cp *.volume *.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user enable --now keeperd netd
```

## Use

```bash
# Status
systemctl --user status keeperd netd scoutd

# Logs
journalctl --user -u keeperd -f
journalctl --user -u netd -f
journalctl --user -u scoutd -f

# Run box with all doors (dev room)
podman run -it --rm --network=none \
  -v claude-doors:/run/doors:ro \
  -v ~/code/myproject:/work \
  -e KEEPERD_SOCK=/run/doors/keeperd.sock \
  -e NETD_SOCK=/run/doors/netd.sock \
  -e SCOUTD_SOCK=/run/doors/scoutd.sock \
  -e HTTPS_PROXY=http://127.0.0.1:3128 \
  localhost/claude-personal:dev
```

## Customize

Edit `.container` files:

```ini
Volume=/path/to/repo:/work:U
Environment=FOO=bar
```

Then `systemctl --user daemon-reload`.
