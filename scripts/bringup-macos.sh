#!/usr/bin/env bash
# bringup-macos.sh — stand up claude-box on a Mac far enough to test the
# --keeper door (HANDOFF #4: verify keeperd, then flip --repo → :ro).
#
# It automates the known-good steps and STOPS with instructions at the two that
# are environment-specific (the linux-builder wiring and keeperd itself). Run a
# single step at a time:
#
#   ./scripts/bringup-macos.sh prereqs    # check nix / podman are present
#   ./scripts/bringup-macos.sh image      # build the OCI image + load into podman
#   ./scripts/bringup-macos.sh machine    # init/start a podman machine
#   ./scripts/bringup-macos.sh keeperd    # how to serve keeperd on a private socket
#   ./scripts/bringup-macos.sh run        # launch the box with --keeper --repo .
#   ./scripts/bringup-macos.sh check      # what to verify once #4's :ro flip lands
#
# Everything is idempotent-ish and prints what it's about to do.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOCK_DIR="${HOME}/.claude-box"
KEEPERD_SOCK="${KEEPERD_SOCK:-${SOCK_DIR}/keeperd.sock}"

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die()  { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

prereqs() {
  say "Prereqs"
  command -v nix    >/dev/null || die "nix not found — install Nix (flakes enabled)."
  command -v podman >/dev/null || die "podman not found — \`brew install podman\`."
  note "nix:    $(command -v nix)"
  note "podman: $(command -v podman)"
  # A private (0700) socket dir — the launcher REFUSES a world-writable dir like
  # /tmp (fail-closed #7), and on macOS \$XDG_RUNTIME_DIR is unset, so /tmp would
  # otherwise be the default. This is the door's host side.
  mkdir -p "${SOCK_DIR}"; chmod 700 "${SOCK_DIR}"
  note "door socket dir: ${SOCK_DIR} (0700) — KEEPERD_SOCK=${KEEPERD_SOCK}"
}

image() {
  say "Build + load the image  (localhost/claude-personal:dev)"
  note "The image is aarch64-linux; building it from macOS needs a Linux builder."
  note "In a SEPARATE terminal, boot the pinned builder and leave it running:"
  note "    nix run .#linux-builder"
  note "Then wire it into your Nix builders once (Determinate Nix owns nix.conf,"
  note "so the turnkey module is off): add it to /etc/nix/machines or pass"
  note "    --builders 'ssh://builder aarch64-linux'   on the build below."
  note ""
  note "With the builder reachable, build + load:"
  note "    cd ${REPO}"
  note "    nix build .#claude-image          # → ./result (image tarball)"
  note "    podman load -i result             # → localhost/claude-personal:dev"
  note ""
  note "Verify it loaded:"
  note "    podman image exists localhost/claude-personal:dev && echo OK"
}

machine() {
  say "podman machine"
  if podman machine list --format '{{.Name}}' 2>/dev/null | grep -q .; then
    note "A machine exists; starting it (no-op if already running):"
    note "    podman machine start || true"
  else
    note "No machine yet — create and start one:"
    note "    podman machine init"
    note "    podman machine start"
  fi
  note ""
  note "macOS socket caveat (CAPABILITIES.md 'Transport is interchangeable'):"
  note "the door is a unix socket on the HOST that must reach the container in"
  note "the podman-machine VM. A bind-mount over virtiofs into the VM is FLAKY."
  note "${SOCK_DIR} is under \$HOME, which podman machine shares into the VM —"
  note "try that first. If the socket won't connect, fall back to the host-gateway"
  note "TCP or 'ssh -L' transport (see CAPABILITIES.md) and set KEEPERD_SOCK"
  note "to the relayed path."
}

keeperd() {
  say "keeperd — the git-write door (NOT in this repo; it lives in prx)"
  note "keeperd owns the keys + signing and serves a unix socket; the box holds"
  note "only the door. Start it serving the PRIVATE socket the box will mount:"
  note ""
  note "    # exact invocation is prx's — e.g. one of:"
  note "    prx keeperd --socket ${KEEPERD_SOCK}"
  note "    keeper serve --socket ${KEEPERD_SOCK}"
  note ""
  note "Confirm it's listening before launching the box:"
  note "    test -S ${KEEPERD_SOCK} && echo 'keeperd socket present' || echo 'NOT a socket'"
  note ""
  note "If keeperd isn't available yet, STOP here: --keeper has nothing to talk"
  note "to, and the #4 :ro flip would brick in-box commits. Verify keeperd first."
}

run() {
  say "Launch the box with the keeper door"
  [ -S "${KEEPERD_SOCK}" ] || die "no keeperd socket at ${KEEPERD_SOCK} — run the 'keeperd' step first."
  note "Launching (KEEPERD_SOCK points the door at the private host socket):"
  note "    cd ${REPO}"
  note "    KEEPERD_SOCK=${KEEPERD_SOCK} nix run .#claude-box -- --keeper --repo ."
  note ""
  note "Bare '--keeper' (no KEEPERD_SOCK) is REFUSED on macOS by design: the"
  note "default would be /tmp/keeperd.sock and the launcher rejects world-writable"
  note "socket dirs (#7). Always pass KEEPERD_SOCK to a 0700 dir."
}

check() {
  say "Acceptance — HANDOFF #4"
  note "Today (--repo is still RW): a keeper-mediated commit should succeed in-box."
  note "After the #4 flip (--repo → :ro + drop the \${common}:\${common} RW mount):"
  note ""
  note "  1) the host .git is NOT writable from the box (the escape is closed):"
  note "       in-box:  sh -c 'echo x >> /work/.git/config' && echo 'STILL WRITABLE (bad)' || echo 'read-only (good)'"
  note "  2) writes still work via the door:"
  note "       in-box:  <keeper-mediated commit>  → lands a signed commit"
  note "  3) un-todo tests/ocap.test.ts '--repo: only the mounted worktree is writable'"
  note "     and run:  bun test tests/ocap.test.ts   (needs the image + podman)"
}

main() {
  case "${1:-help}" in
    prereqs) prereqs ;;
    image)   image ;;
    machine) machine ;;
    keeperd) keeperd ;;
    run)     run ;;
    check)   check ;;
    all)     prereqs; image; machine; keeperd; run; check ;;
    *) awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "${BASH_SOURCE[0]}" ;;
  esac
}
main "$@"
