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
