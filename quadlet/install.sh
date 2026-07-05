#!/usr/bin/env bash
# Install (or re-install) the full Quadlet door fleet into the podman
# machine VM — the automated version of the manual bring-up steps used to
# stand up keeperd/netd/scout-netd/scoutd/launcherd/authd/remote-serve the
# first time. Safe to re-run: image loads and unit copies are idempotent,
# and the one genuinely irreversible step (the issuer keypair) is skipped
# once it already exists on the VM, never silently regenerated.
#
# Usage: ./quadlet/install.sh [--skip-build]
#   --skip-build   reuse whatever images/bundle are already loaded/in the
#                  volume; only re-copy units + daemon-reload. Useful when
#                  iterating on a .container file without rebuilding Nix.
#
# What this does NOT do (still a human step, on purpose):
#   - authd's credential: `claude-box check-in > ~/.claude-box/authd-cred.json`
#     needs a real browser OAuth login, so it can't be scripted. Run it,
#     then `podman machine ssh -- systemctl --user restart authd`.
#   - launcherd's actual host-podman-socket access is a known-unresolved
#     permission gap (see quadlet/launcherd.container's header) — this
#     script gets the daemon running and its own doors socket reachable,
#     it does not fix that gap.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VM_HOME=/var/home/core
skip_build=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) skip_build=1 ;;
    -h|--help)
      echo "Usage: $0 [--skip-build]"
      exit 0 ;;
    *) echo "install.sh: unknown arg '$arg' (try --help)" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

BUNDLE_RESULT="$REPO_ROOT/result-claude-box-bundle"

if [ "$skip_build" = "0" ]; then
  say "1/6  Build + load door images"
  for pkg in claude-image keeperd-image netd-image scoutd-image launcherd-image authd-image; do
    echo "  nix build .#$pkg"
    ( cd "$REPO_ROOT" && nix build ".#$pkg" -o "result-$pkg" )
    podman load -i "$REPO_ROOT/result-$pkg"
    rm -f "$REPO_ROOT/result-$pkg"
  done

  say "2/6  Build the claude-box CLI bundle (for the RC boot script)"
  ( cd "$REPO_ROOT" && nix build .#claude-box-bundle -o "$(basename "$BUNDLE_RESULT")" )

  say "2b  Build + deploy launcherd-rs (the Rust dispatch control plane)"
  # Static aarch64-musl binary — runs VM-native on CoreOS (no JS runtime there).
  ( cd "$REPO_ROOT" && nix build .#launcherd-rs -o result-launcherd-rs )
  podman machine ssh -- "mkdir -p $VM_HOME/.claude-box/bin"
  cat "$REPO_ROOT/result-launcherd-rs/bin/launcherd" \
    | podman machine ssh -- "cat > $VM_HOME/.claude-box/bin/launcherd.new && chmod +x $VM_HOME/.claude-box/bin/launcherd.new && mv -f $VM_HOME/.claude-box/bin/launcherd.new $VM_HOME/.claude-box/bin/launcherd"
  rm -f "$REPO_ROOT/result-launcherd-rs"
  # The SNI gateway allowlist config (nginx ssl_preread) — see ADR-RC-EGRESS-SNI.
  podman machine ssh -- "cat > $VM_HOME/.claude-box/sni-gw.conf" < "$SCRIPT_DIR/sni-gw.conf"
  # The bastion's foreground runner (see remote-serve.service).
  cat "$SCRIPT_DIR/bastion-run.sh" \
    | podman machine ssh -- "cat > $VM_HOME/.claude-box/bin/bastion-run.sh && chmod +x $VM_HOME/.claude-box/bin/bastion-run.sh"
  # Persistent config volume so the dispatcher RESUMES one stable session.
  podman machine ssh -- 'podman volume create claude-dispatch-config >/dev/null 2>&1 || true'
else
  say "1-2/6  Skipped (--skip-build): reusing images + bundle already present"
  if [ ! -e "$BUNDLE_RESULT/claude-box.js" ]; then
    echo "  --skip-build but $BUNDLE_RESULT/claude-box.js doesn't exist — run once without --skip-build first." >&2
    exit 1
  fi
fi

say "3/6  Shared doors directory on the VM"
# %h in the .container files resolves to this exact path — every door
# daemon's UserNS=keep-id:uid=1000,gid=1000 requires this directory be
# owned by that same uid/gid and NOT world-writable (launcherd itself
# refuses to bind a socket in a world-writable dir — see keeperd.container's
# comment). uid/gid 1000 is the VM's own `core` user, so this never needs
# a chown once created correctly the first time.
podman machine ssh -- "mkdir -p $VM_HOME/.claude-box/run && chown 1000:1000 $VM_HOME/.claude-box/run && chmod 0770 $VM_HOME/.claude-box/run"

say "4/6  Issuer keypair (generated once, never rotated by this script)"
# The keypair claude-box.ts signs auth grants with (lib/box-keys.ts). Two
# copies are needed: the public half as a plain bind-mounted file at
# %h/.claude-box/issuer.pub.json (authd.container reads it read-only), and
# both halves inside the claude-box-issuer-keys NAMED VOLUME (remote-serve's
# ExecStartPre= mints grants from there). A bind mount of a plain host file
# hits an SELinux EACCES that a named volume does not — see
# remote-serve.container's own ExecStartPre comment for the confirmed-live
# finding behind that split.
if podman machine ssh -- "test -f $VM_HOME/.claude-box/issuer.pub.json" 2>/dev/null; then
  echo "  issuer.pub.json already exists on the VM — leaving the existing keypair alone"
else
  echo "  no existing keypair — generating one now"
  podman volume create claude-box-issuer-keys >/dev/null 2>&1 || true
  podman volume create claude-box-bundle >/dev/null 2>&1 || true
  # Mount the (still-empty) issuer-keys volume rw and generate the bundle
  # into /app before starting: internal-mint-auth-grant triggers
  # claude-box.ts's own loadOrCreateBoxKey() (lib/box-keys.ts), which
  # creates the keypair under $HOME/.config/claude-box on first use — then
  # copy both halves straight into the mounted volume, no host round-trip
  # for the private half.
  podman create --name claude-box-key-seed -v claude-box-issuer-keys:/keys -e HOME=/tmp \
    --entrypoint sh localhost/authd:dev -c \
    'bun /app/claude-box.js internal-mint-auth-grant --audience claude-box-remote-serve >/dev/null && cp /tmp/.config/claude-box/issuer.key.pem /tmp/.config/claude-box/issuer.pub.json /keys/' >/dev/null
  podman cp "$BUNDLE_RESULT/claude-box.js" claude-box-key-seed:/app/claude-box.js
  podman start -a claude-box-key-seed
  podman rm -f claude-box-key-seed >/dev/null
  # Pull just the public half onto the VM's own filesystem for authd's bind mount.
  podman run --rm -v claude-box-issuer-keys:/keys:ro --entrypoint cat localhost/authd:dev /keys/issuer.pub.json \
    | podman machine ssh -- "cat > $VM_HOME/.claude-box/issuer.pub.json"
  echo "  keypair generated: $VM_HOME/.claude-box/issuer.pub.json (public) + claude-box-issuer-keys volume (both halves)"
fi

say "5/6  claude-box CLI bundle volume (remote-serve's boot-script source)"
podman volume create claude-box-bundle >/dev/null 2>&1 || true
podman create --name claude-box-bundle-seed -v claude-box-bundle:/app busybox true >/dev/null
podman cp "$BUNDLE_RESULT/claude-box.js" claude-box-bundle-seed:/app/claude-box.js
podman rm -f claude-box-bundle-seed >/dev/null
[ "$skip_build" = "0" ] && rm -f "$BUNDLE_RESULT"
echo "  claude-box-bundle volume refreshed from the current bundle"

say "6/6  Quadlet units (.volume / .network / .container) + plain .service units"
podman machine ssh -- "mkdir -p $VM_HOME/.config/containers/systemd $VM_HOME/.config/systemd/user"
# Quadlet-generated units (keeperd/netd/scoutd/authd/launcherd/sni-*).
for f in "$SCRIPT_DIR"/*.volume "$SCRIPT_DIR"/*.network "$SCRIPT_DIR"/*.container; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  echo "  quadlet: $name"
  podman machine ssh -- "cat > $VM_HOME/.config/containers/systemd/$name" < "$f"
done
# Plain systemd user services (the RC dispatcher + Rust launcher are foreground
# processes, NOT Quadlet's detached containers — see remote-serve.service).
for f in "$SCRIPT_DIR"/*.service; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  echo "  service: $name"
  podman machine ssh -- "cat > $VM_HOME/.config/systemd/user/$name" < "$f"
done
podman machine ssh -- systemctl --user daemon-reload

cat <<'EOF'

== Install complete ==

Still-manual step (needs a real browser login — cannot be scripted):
  claude-box check-in > ~/.claude-box/authd-cred.json
  podman machine ssh -- systemctl --user restart authd

Bring the fleet up (doors, egress gateway, both launchers, dispatcher):
  podman machine ssh -- systemctl --user enable --now \
    keeperd netd scout-netd scoutd authd launcherd \
    dolt beadsd sni-gateway launcherd-rs remote-serve

  - dolt is the beads storage backend (loopback-only, no egress); beadsd is
    the --beads door (/run/doors/beadsd.sock) sharing dolt's netns. Together
    they replace the prx-pod dependency and make the `planning` room's beads
    door resolve. dolt/beadsd images are pulled from ghcr (sha-pinned).
  - launcherd (bun) serves the LAUNCH lane; launcherd-rs (Rust, VM-native)
    serves the DISPATCH lane on the real dispatch.sock and spawns RC boxes
    onto the SNI egress (ADR-RC-EGRESS-SNI) so they register.
  - remote-serve is the dispatcher ("dispatch" in the Claude app) — a
    foreground .service (RC only registers interactively), on the SNI egress,
    resuming one stable session across restarts.

Status / logs:
  podman machine ssh -- systemctl --user status remote-serve launcherd-rs sni-gateway
  podman machine ssh -- journalctl --user -u <name> -f

Machine autostart on macOS login: a launchd agent starts the podman machine
(with VM linger, the whole fleet + dispatcher then come up). See the
com.claude-box.machine LaunchAgent / the home-manager launchd.agents entry.

Re-run with --skip-build after only editing a .container/.service file.
EOF
