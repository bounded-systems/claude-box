# ADR — Quadlet for door orchestration (not Compose, not Pods)

> Status: **accepted** (2026-06-13). Tracking: follows from `ADR.md` (OCI runtime).
> Provenance: doors emit L3 attestations per SLSA Provenance v1 / in-toto Statement v1.

## Context

claude-box doors (keeperd, netd, scoutd) are separate daemons that boxes connect
to via unix sockets. We need orchestration to:

1. Start doors on boot / on demand
2. Restart on failure
3. Manage lifecycle (dependencies, logs, cleanup)
4. Work the same on macOS (dev) and Linux (prod)

## Options considered

### 1. Podman Compose

```yaml
services:
  keeperd:
    image: localhost/keeperd:dev
    volumes:
      - doors:/run/doors
```

**Pros:** Familiar, docker-compose compatible.
**Cons:** No boot integration, manual lifecycle, separate tooling (`podman-compose`).

### 2. Podman Pods

```bash
podman pod create --name claude-room
podman run -d --pod claude-room localhost/keeperd:dev
```

**Pros:** Kubernetes-native, export to k8s YAML.
**Cons:** Shared network namespace (weaker isolation), doesn't fit socket-as-capability model.

### 3. Quadlet (systemd units)

```ini
# keeperd.container
[Container]
Image=localhost/keeperd:dev
Volume=claude-doors.volume:/run/doors:U
```

**Pros:**
- Native systemd lifecycle (restart, dependencies, boot start)
- Same units for macOS (via Lima/podman machine) and Linux
- journald logging (`journalctl -u keeperd`)
- Declarative (INI files in `~/.config/containers/systemd/`)

**Cons:**
- Requires systemd (Linux or VM on macOS)
- Volume names get `systemd-` prefix

## Decision

**Quadlet.** One orchestration path for dev and prod.

- macOS: `podman machine ssh -- systemctl --user start keeperd`
- Linux: `systemctl --user start keeperd`

Same units, same commands, same tooling.

## Consequences

1. **No Compose file** — removed to avoid two paths
2. **Lima/podman machine required on macOS** — already the case for containers
3. **Volume naming** — Quadlet prefixes volumes with `systemd-`, docs updated
4. **Install script** — `quadlet/install.sh` copies units into the VM

## Provenance chain

Orchestration doesn't change the attestation model:

```
L1 (image)     → CapabilityProvenance statement for the OCI image
L2 (launch)    → launcherd emits manifest of granted doors
L3 (operation) → each door emits signed attestations for its actions
```

keeperd emits L3 attestations (SLSA Provenance v1) for every commit, binding:
- The git commit SHA (subject)
- The L2 manifest digest (proving which box made the request)
- The door's signing key

Whether keeperd runs as a Quadlet container, a microVM, or a bare process, the
attestation format is identical. Orchestration is orthogonal to provenance.

See: `KEEPERD.md` (L3 attestation), `OCAP.md` (capability model), `contract/` (schemas).

## Future: microVMs

For multi-tenant or compliance, doors could run in Firecracker microVMs instead
of containers. The systemd units would change from `*.container` to launching
microVMs, but the interface (socket at `/run/doors/*.sock`) stays the same.
The L3 attestations remain identical — only the isolation boundary changes.
