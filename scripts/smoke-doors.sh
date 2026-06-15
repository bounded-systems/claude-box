#!/usr/bin/env bash
# Smoke-test the published claude-box door images locally.
#
#   ./scripts/smoke-doors.sh [version]      # default: latest
#
# Layer 1 (any OS): each published door image boots and serves its socket.
# Layer 2 (Linux):  two live checks on a shared socket dir —
#                   (a) scout-netd + scoutd(--network=none): a REAL GitHub read
#                       through the scout door, proving scoutd reaches GitHub
#                       with NO NIC of its own (egress forced through scout-netd);
#                   (b) the concierge introducer: register a capability over the
#                       door, then resolve it back as an attenuated grant —
#                       proving the register/resolve wire end-to-end.
#                   Skipped on macOS: the podman-machine door-wall blocks a
#                   host->socket probe, so run layer 2 on a Linux/Pi host (or
#                   rely on CI's nixos doors VM test).
#
# Needs: podman (logged in to ghcr.io if the packages are private), and — for
# layer 2 — socat on the host.
set -euo pipefail

REG="ghcr.io/bounded-systems/claude-box"
VER="${1:-latest}"
DOORS=(door-keeper door-net door-scout door-concierge)
DOORS_DIR=""

cleanup() {
  podman rm -f smoke-door-keeper smoke-door-net smoke-door-scout \
    smoke-door-concierge smoke-scout-netd smoke-scout smoke-concierge \
    >/dev/null 2>&1 || true
  [ -n "$DOORS_DIR" ] && rm -rf "$DOORS_DIR" 2>/dev/null || true
}
trap cleanup EXIT

echo "== Layer 1: each door image boots + serves (v$VER) =="
for d in "${DOORS[@]}"; do
  podman rm -f "smoke-$d" >/dev/null 2>&1 || true
  podman run -d --name "smoke-$d" "$REG/$d:$VER" >/dev/null
done
sleep 2
layer1_ok=1
for d in "${DOORS[@]}"; do
  if podman logs "smoke-$d" 2>&1 | grep -qi "listening"; then
    echo "  ok   $d — listening"
  else
    echo "  FAIL $d — never logged 'listening':"
    podman logs "smoke-$d" 2>&1 | tail -3 | sed 's/^/         /'
    layer1_ok=0
  fi
  podman rm -f "smoke-$d" >/dev/null 2>&1 || true
done
[ "$layer1_ok" = 1 ] || { echo "Layer 1 FAILED"; exit 1; }

# ── Layer 2 — Linux only (host can socat the bind-mounted scoutd.sock) ─────────
if [ "$(uname -s)" != "Linux" ]; then
  echo "== Layer 2: skipped (needs Linux; macOS door-wall blocks host->socket) =="
  echo "smoke OK (layer 1)"; exit 0
fi
command -v socat >/dev/null 2>&1 || {
  echo "== Layer 2: skipped (socat not on PATH) =="; echo "smoke OK (layer 1)"; exit 0; }

echo "== Layer 2: live GitHub read through scout-netd (scoutd has no NIC) =="
DOORS_DIR="$(mktemp -d)"   # 0700 — not world-writable, passes the door hijack guard

# scout-netd: the egress door — netd instance with the GitHub allowlist, has network.
podman run -d --name smoke-scout-netd \
  -e NETD_SOCK=/run/doors/scout-netd.sock \
  -e NETD_ALLOW="api.github.com,codeload.github.com,objects.githubusercontent.com,github.com,.github.com" \
  -v "$DOORS_DIR:/run/doors:U,Z" "$REG/door-net:$VER" >/dev/null

# scoutd: NO NIC. Its entrypoint relays loopback->scout-netd.sock and sets
# SCOUTD_PROXY, so egress is forced through scout-netd.
podman run -d --name smoke-scout --network=none \
  -v "$DOORS_DIR:/run/doors:U,Z" "$REG/door-scout:$VER" >/dev/null

# Wait for the scout door socket.
for _ in $(seq 1 30); do [ -S "$DOORS_DIR/scoutd.sock" ] && break; sleep 0.5; done
[ -S "$DOORS_DIR/scoutd.sock" ] || {
  echo "  FAIL scoutd.sock never appeared"; podman logs smoke-scout 2>&1 | tail -10; exit 1; }

# Speak the scout door's NDJSON wire protocol: read a public repo. Success means
# scoutd reached GitHub — and it did so with --network=none, i.e. through scout-netd.
req='{"id":"smoke","method":"repo","params":{"url":"github.com/bounded-systems/claude-box"}}'
resp="$(printf '%s\n' "$req" | socat -t8 - "UNIX-CONNECT:$DOORS_DIR/scoutd.sock" || true)"
echo "  scoutd response: ${resp:-<empty>}"
if printf '%s' "$resp" | grep -q '"defaultBranch"'; then
  echo "  ok   GitHub read succeeded through scout-netd — scoutd reached GitHub with NO NIC"
else
  echo "  FAIL scout read did not return repo metadata"
  echo "  --- scoutd logs ---";     podman logs smoke-scout      2>&1 | tail -10 | sed 's/^/    /'
  echo "  --- scout-netd logs ---"; podman logs smoke-scout-netd 2>&1 | tail -10 | sed 's/^/    /'
  exit 1
fi

echo "== Layer 2b: concierge introduction (register → resolve over the door) =="
# The concierge needs no network — it's pure routing. Boot it on the shared dir,
# register a capability, then resolve it back as an attenuated grant.
podman run -d --name smoke-concierge \
  -v "$DOORS_DIR:/run/doors:U,Z" "$REG/door-concierge:$VER" >/dev/null
for _ in $(seq 1 30); do [ -S "$DOORS_DIR/concierged.sock" ] && break; sleep 0.5; done
[ -S "$DOORS_DIR/concierged.sock" ] || {
  echo "  FAIL concierged.sock never appeared"; podman logs smoke-concierge 2>&1 | tail -10; exit 1; }

# A provider announces "scout" with a ceiling caveat; then a consumer resolves it.
reg='{"id":"reg","method":"register","params":{"capability":"scout","door":"/run/scoutd.sock","env":"SCOUTD_SOCK","caveats":["host=github.com,.github.com"]}}'
res='{"id":"res","method":"resolve","params":{"capability":"scout"}}'
regresp="$(printf '%s\n' "$reg" | socat -t8 - "UNIX-CONNECT:$DOORS_DIR/concierged.sock" || true)"
resresp="$(printf '%s\n' "$res" | socat -t8 - "UNIX-CONNECT:$DOORS_DIR/concierged.sock" || true)"
echo "  register response: ${regresp:-<empty>}"
echo "  resolve  response: ${resresp:-<empty>}"
# The resolved grant must carry the provider's socket path and its ceiling caveat.
if printf '%s' "$resresp" | grep -q '/run/scoutd.sock' \
   && printf '%s' "$resresp" | grep -q 'host=github.com'; then
  echo "  ok   concierge introduced an attenuated scout grant over the door"
  echo "smoke OK (layers 1 + 2 + 2b)"
else
  echo "  FAIL concierge did not return the introduced grant"
  echo "  --- concierged logs ---"; podman logs smoke-concierge 2>&1 | tail -10 | sed 's/^/    /'
  exit 1
fi
