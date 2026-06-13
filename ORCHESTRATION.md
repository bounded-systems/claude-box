# Orchestration — Quadlet (systemd units for containers)

Doors run as systemd services via Quadlet. Same setup for macOS (Lima) and Linux.

## Architecture

```
~/.config/containers/systemd/
├── claude-doors.volume     # shared socket volume
├── claude-keys.volume      # keeperd signing keys
├── keeperd.container       # → keeperd.service
├── netd.container          # → netd.service
└── scoutd.container        # → scoutd.service
```

Boxes connect to doors via `/run/doors/*.sock`. Doors own credentials; boxes hold nothing.

## Setup

### macOS (via Lima)

```bash
# One-time: create Lima VM with podman
limactl create --name=claude template://podman
limactl start claude

# Copy Quadlet units into VM
limactl copy quadlet/*.volume quadlet/*.container claude:~/.config/containers/systemd/

# Reload and enable doors
limactl shell claude -- systemctl --user daemon-reload
limactl shell claude -- systemctl --user enable --now keeperd
```

### Linux (native)

```bash
mkdir -p ~/.config/containers/systemd
cp quadlet/*.volume quadlet/*.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user enable --now keeperd
```

## Usage

```bash
# Status
systemctl --user status keeperd

# Logs
journalctl --user -u keeperd -f

# Run a box with keeper door
# Note: Quadlet prefixes volumes with "systemd-"
podman run -it --rm \
  -v systemd-claude-doors:/run/doors:ro \
  -v ~/code/myproject:/work \
  -e KEEPERD_SOCK=/run/doors/keeperd.sock \
  localhost/claude-personal:dev
```

## Why Quadlet

| Feature | Benefit |
|---------|---------|
| One path | Same units for macOS (Lima) and Linux |
| systemd lifecycle | Restart on failure, boot start, dependencies |
| journald logs | `journalctl -u keeperd` |
| Declarative | INI files in `~/.config/containers/systemd/` |

## Future: microVMs

For multi-tenant or compliance, doors could run in microVMs:

```
Host
├── keeperd VM (Firecracker)
│   └── vsock:3 → /run/doors/keeperd.sock
├── netd VM
│   └── vsock:4 → /run/doors/netd.sock
└── box VM
    └── mounts vsock:3, vsock:4
```

**Why microVMs:**
- Hardware isolation (separate kernel per door)
- Sub-second boot (~125ms)
- Cloud-native (Firecracker powers Lambda, Fly.io)

**Technologies:** Firecracker, Cloud Hypervisor, Kata Containers.

Not needed for single-tenant — containers are sufficient.
