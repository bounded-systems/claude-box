#!/usr/bin/env bash
# Install Quadlet units into podman machine
#
# Usage: ./quadlet/install.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Creating systemd directory..."
podman machine ssh -- "mkdir -p /var/home/core/.config/containers/systemd"

echo "Copying Quadlet units..."
for f in "$SCRIPT_DIR"/*.volume "$SCRIPT_DIR"/*.container; do
  name="$(basename "$f")"
  echo "  $name"
  podman machine ssh -- "cat > /var/home/core/.config/containers/systemd/$name" < "$f"
done

echo "Reloading systemd..."
podman machine ssh -- systemctl --user daemon-reload

echo ""
echo "Done. To start doors:"
echo "  podman machine ssh -- systemctl --user start keeperd"
echo "  podman machine ssh -- systemctl --user start netd"
echo "  podman machine ssh -- systemctl --user start scoutd"
echo ""
echo "To check status:"
echo "  podman machine ssh -- systemctl --user status keeperd netd scoutd"
echo ""
echo "To view logs:"
echo "  podman machine ssh -- journalctl --user -u keeperd -f"
echo "  podman machine ssh -- journalctl --user -u netd -f"
echo "  podman machine ssh -- journalctl --user -u scoutd -f"
echo ""
echo "To run a box with all doors (dev room):"
echo "  podman run -it --rm --network=none \\"
echo "    -v systemd-claude-doors:/run/doors:ro \\"
echo "    -v \$PWD:/work \\"
echo "    -e KEEPERD_SOCK=/run/doors/keeperd.sock \\"
echo "    -e NETD_SOCK=/run/doors/netd.sock \\"
echo "    -e SCOUTD_SOCK=/run/doors/scoutd.sock \\"
echo "    -e HTTPS_PROXY=http://127.0.0.1:3128 \\"
echo "    localhost/claude-personal:dev"
