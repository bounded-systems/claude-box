#!/usr/bin/env bash
# run-keeperd.sh — start keeperd with host→VM relay
#
# On macOS, unix sockets can't be bind-mounted from host into the podman-machine
# VM (virtiofs doesn't support statfs on sockets). So keeperd listens on TCP and
# socat bridges it to a unix socket inside the VM.
#
# Usage:
#   ./run-keeperd.sh up       # start keeperd on TCP + socat relay in VM
#   ./run-keeperd.sh test     # verify keeperd responds
#   ./run-keeperd.sh down     # stop keeperd
#
# Then: claude-box work --repo . --keeper
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${KEEPERD_PORT:-9999}"
VM_SOCK="/tmp/keeperd.sock"

die() { printf '\033[31mkeepered: %s\033[0m\n' "$*" >&2; exit 1; }

up() {
  command -v bun >/dev/null || die "bun not found (install via: curl -fsSL https://bun.sh/install | bash)"

  # Kill any existing keeperd
  pkill -f "keeperd.ts serve" 2>/dev/null || true
  pkill -f "socat.*TCP:.*:${PORT}" 2>/dev/null || true

  # Start keeperd on TCP
  echo "keeperd: starting on TCP port ${PORT}..."
  bun run "$SCRIPT_DIR/keeperd.ts" serve --port "$PORT" &
  KEEPERD_PID=$!
  sleep 0.5

  # Verify it's running
  if ! kill -0 "$KEEPERD_PID" 2>/dev/null; then
    die "keeperd failed to start"
  fi

  # Set up socat relay in podman VM (TCP → unix socket)
  if [[ "$(uname)" == "Darwin" ]]; then
    echo "keeperd: setting up relay in podman VM..."
    # Kill any existing relay in the VM
    podman machine ssh "pkill -f 'socat.*UNIX-LISTEN:${VM_SOCK}' 2>/dev/null || true"
    podman machine ssh "rm -f ${VM_SOCK}"
    # Start relay: VM listens on unix socket, connects to host TCP via gateway
    # host.containers.internal is the podman machine's route to the host
    podman machine ssh "socat UNIX-LISTEN:${VM_SOCK},fork TCP:host.containers.internal:${PORT}" &
    sleep 0.5
    echo "keeperd: relay ready at ${VM_SOCK} (inside podman VM)"
  fi

  echo "keeperd: running (pid ${KEEPERD_PID})"
  echo ""
  echo "Test with:"
  echo "  { echo '{\"id\":\"1\",\"method\":\"status\"}'; sleep 0.1; } | nc localhost ${PORT}"
  echo ""
  echo "Launch a box with:"
  echo "  KEEPERD_SOCK=${VM_SOCK} claude-box work --repo . --keeper"
}

test_() {
  echo "keeperd: testing status..."
  response=$({ echo '{"id":"1","method":"status"}'; sleep 0.2; } | nc localhost "$PORT" 2>/dev/null || true)
  if [[ "$response" == *'"ok":true'* ]]; then
    echo "keeperd: responding ✓"
    echo "$response" | head -1
  else
    die "keeperd not responding (got: $response)"
  fi
}

down() {
  echo "keeperd: stopping..."
  pkill -f "keeperd.ts serve" 2>/dev/null || true
  if [[ "$(uname)" == "Darwin" ]]; then
    podman machine ssh "pkill -f 'socat.*UNIX-LISTEN:${VM_SOCK}' 2>/dev/null || true" 2>/dev/null || true
    podman machine ssh "rm -f ${VM_SOCK}" 2>/dev/null || true
  fi
  echo "keeperd: stopped"
}

case "${1:-up}" in
  up)   up ;;
  test) test_ ;;
  down) down ;;
  *)    die "usage: run-keeperd.sh {up|test|down}" ;;
esac
