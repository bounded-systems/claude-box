#!/usr/bin/env bash
# Verify the flake and the NixOS doors module, in one runner.
#   ./scripts/verify.sh        (from the repo root)
#   nix run .#verify
#
# Steps 1–3 work anywhere nix runs (on macOS, building images needs the
# aarch64-linux builder — see BUILD.md). Step 4 (the VM boot test) needs a
# Linux host with KVM/qemu; it is skipped with a note elsewhere.
set -euo pipefail

[ -f flake.nix ] || { echo "run from the claude-box repo root (no flake.nix here)" >&2; exit 1; }

echo "==> 1/4  nix flake check"
nix flake check

echo "==> 2/4  nixosModules.default evaluates"
t="$(nix eval --raw .#nixosModules.default --apply builtins.typeOf)"
[ "$t" = lambda ] || { echo "expected a module lambda, got: $t" >&2; exit 1; }
echo "    ok (lambda)"

echo "==> 3/4  build the door images the module wires via imageFile"
nix build .#keeperd-image .#netd-image .#scoutd-image

echo "==> 4/4  NixOS VM boot test (doors)"
sys="$(nix eval --raw --impure --expr builtins.currentSystem)"
case "$sys" in
  *-linux) nix build ".#checks.${sys}.doors" && echo "    ok (doors VM test passed)" ;;
  *) echo "    skipped: the VM test needs a Linux host with KVM (current system: ${sys})." ;;
esac

echo "==> verify OK"
