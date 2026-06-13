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
echo "Done. To start keeperd:"
echo "  podman machine ssh -- systemctl --user start keeperd"
echo ""
echo "To check status:"
echo "  podman machine ssh -- systemctl --user status keeperd"
echo ""
echo "To run a box with keeper door:"
echo "  podman run -it --rm \\"
echo "    -v systemd-claude-doors:/run/doors:ro \\"
echo "    -v \$PWD:/work \\"
echo "    -e KEEPERD_SOCK=/run/doors/keeperd.sock \\"
echo "    localhost/claude-personal:dev"
