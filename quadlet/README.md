# Quadlet Units for claude-box

Systemd unit files for running door daemons as containers.

```
quadlet/
├── claude-doors.volume   # shared socket volume
├── claude-keys.volume    # keeperd signing keys
├── keeperd.container     # git-signing daemon
├── netd.container        # allowlist egress proxy
└── scoutd.container      # external reads (stub)
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

### macOS (via Lima)

```bash
# One-time: create Lima VM
limactl create --name=claude template://podman
limactl start claude

# Copy units
limactl copy *.volume *.container claude:~/.config/containers/systemd/

# Enable
limactl shell claude -- systemctl --user daemon-reload
limactl shell claude -- systemctl --user enable --now keeperd
```

### Linux

```bash
mkdir -p ~/.config/containers/systemd
cp *.volume *.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user enable --now keeperd
```

## Use

```bash
# Status
systemctl --user status keeperd

# Logs
journalctl --user -u keeperd -f

# Run box with keeper door
podman run -it --rm \
  -v claude-doors:/run/doors:ro \
  -v ~/code/myproject:/work \
  -e KEEPERD_SOCK=/run/doors/keeperd.sock \
  --network=none \
  localhost/claude-personal:dev
```

## Customize

Edit `.container` files:

```ini
Volume=/path/to/repo:/work:U
Environment=FOO=bar
```

Then `systemctl --user daemon-reload`.
