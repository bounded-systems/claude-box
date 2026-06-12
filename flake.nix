{
  # Pinned OCI image for the personal Claude runtime.
  # ADR: docs/prx/claude-runtime.md   Epic: prx-d4o   Tasks: prx-vds (this), prx-9yp (builder), prx-6xx (run wrapper)
  #
  # The whole point is the PIN: nixpkgs is locked (flake.lock) to a rev where
  # `claude-code` is a known, content-addressed derivation. The resulting OCI
  # image then has its OWN sha256 digest — the "sha we can pin to". Upgrades are
  # a deliberate `nix flake update` + review, never a silent self-update.
  description = "Pinned OCI image for the personal Claude runtime (claude-code + agent toolchain)";

  # Locked to the rev verified to carry claude-code 2.0.53 (aarch64-linux, unfree).
  # `nix flake update` to move it — that bump IS the version decision.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/bb813de6d2241bcb1b5af2d3059f560c66329967";

  outputs = { self, nixpkgs }:
    let
      # The image targets Linux. On an aarch64-darwin host this builds via a
      # Linux builder (prx-9yp) — the expression itself is builder-agnostic.
      # Add "x86_64-linux" here if/when CI builds a multi-arch image.
      systems = [ "aarch64-linux" ];
      forEach = nixpkgs.lib.genAttrs systems;

      # claude-code is unfree → instantiate nixpkgs with allowUnfree.
      pkgsFor = system: import nixpkgs {
        inherit system;
        config.allowUnfree = true;
      };

      user = "claude";
      uid = 1000;
      home = "/home/${user}";
      configDir = "${home}/.config/claude"; # the persistent volume mount point
    in
    {
      packages = forEach (system:
        let
          pkgs = pkgsFor system;

          # prx — the box's SANCTIONED tool (prx-0wc). Pinned release binary
          # (aarch64-linux, v0.10.0 — includes prx-ag7: runtime repo-root from
          # cwd not the binary dir). It's a `bun --compile` binary: bun appends
          # the app blob AFTER the ELF, so patchelf/autoPatchelf rewrites the ELF
          # and CORRUPTS the blob → the binary degrades to bare bun. So leave the
          # binary untouched and invoke the nix glibc loader directly on it (the
          # ubuntu-built ELF's hardcoded /lib interpreter is absent in a nix image).
          prxBin = pkgs.fetchurl {
            url = "https://github.com/bounded-systems/prx/releases/download/v0.10.0/prx-aarch64-linux";
            sha256 = "1b8ba6xgi6hdaknlhigcxai1xxlvz8j1sdm570y7jssckgiqy89l";
          };
          prxLibs = pkgs.lib.makeLibraryPath [ pkgs.glibc pkgs.stdenv.cc.cc.lib ];
          prx = pkgs.runCommand "prx-0.10.0" { nativeBuildInputs = [ pkgs.makeWrapper ]; } ''
            install -Dm755 ${prxBin} $out/libexec/prx
            makeWrapper ${pkgs.glibc}/lib/ld-linux-aarch64.so.1 $out/bin/prx \
              --add-flags "--library-path ${prxLibs}" \
              --add-flags "$out/libexec/prx" \
              --set LD_LIBRARY_PATH "${prxLibs}"
          '';

          # Everything the agent needs in the box. prx is THE tool (prx-0wc) —
          # it reaches OUT to the keeperd/beadsd boxes; the rest support it.
          toolchain = with pkgs; [
            prx                # the box's sanctioned tool (pinned v0.10.0)
            claude-code        # the star — pinned by the locked nixpkgs rev
            git                # local VCS ops (read/diff/status); pushes go via keeperd
            # NB: `gh` is deliberately ABSENT (GH-5). It was a latent direct-push
            # credential path — `gh auth login` + a token bypasses keeperd. With it
            # gone, the box has no tool that can establish push rights; writes go
            # only through the keeper door, and external READS go through the scout
            # door (see SCOUT.md), not an ambient CLI holding creds + network.
            ripgrep
            fd
            bun                # agent/runtime (also what prx is built with)
            openssh            # git-over-ssh transport (no keys shipped; agent not forwarded)
            socat              # netd-door relay (loopback proxy → /run/netd.sock)
            cacert             # TLS roots
            coreutils
            gnugrep
            gnused
            gawk
            less
            bashInteractive
          ];

          # buildEnv gives a single /bin (+ /etc, /share) tree so PATH=/bin works.
          rootEnv = pkgs.buildEnv {
            name = "claude-image-root";
            paths = toolchain;
            pathsToLink = [ "/bin" "/etc" "/share" "/lib" ];
          };

          # netd door relay (CAPABILITIES.md "Network is a door — not a NIC").
          # The box runs --network=none; if the launcher forwarded the netd door
          # (`--net`), expose it as a loopback proxy (127.0.0.1:3128) so the
          # HTTPS_PROXY the launcher set reaches netd, which owns the allowlist.
          # No door ⇒ no relay ⇒ the box is offline. The box holds no egress of
          # its own — standard tooling can't proxy straight to a unix socket, so
          # socat bridges loopback-TCP → /run/netd.sock. Flags still pass through
          # to claude (`exec claude "$@"`); a bare run launches the TUI.
          entrypoint = pkgs.writeShellScript "claude-box-entrypoint" ''
            if [ -S /run/netd.sock ]; then
              ${pkgs.socat}/bin/socat TCP-LISTEN:3128,fork,reuseaddr,bind=127.0.0.1 UNIX-CONNECT:/run/netd.sock &
            fi
            exec claude "$@"
          '';
        in
        {
          # `nix build .#claude-image` → ./result is the image TARBALL (data),
          # loaded cross-platform with:
          #   podman load -i result        (rootless podman)
          #   nerdctl -n default load -i result   (containerd in the Lima VM)
          # NB: buildLayeredImage (not streamLayeredImage) on purpose — the
          # stream script is a target-arch (linux) executable that can't run on
          # the aarch64-darwin host; a tarball is just data, so it loads anywhere.
          claude-image = pkgs.dockerTools.buildLayeredImage {
            name = "claude-personal";
            tag = "dev"; # the meaningful identity is the digest, not the tag

            contents = [ rootEnv ];

            # Create the non-root `claude` user + a writable HOME with the config
            # dir that the persistent volume mounts over. extraCommands runs in
            # the image root at build time.
            # prx-al1: HOME is chowned to the claude uid (fakeRootCommands,
            # below) so the rootless runtime can write ~/.cache etc. — without
            # it, prx hit `EACCES: mkdir '/home/claude/.cache'` (root-owned home).
            extraCommands = ''
              mkdir -p etc tmp ${builtins.substring 1 (-1) home}/.config/claude
              chmod 1777 tmp
              cat > etc/passwd <<EOF
              root:x:0:0:root:/root:/bin/bash
              ${user}:x:${toString uid}:${toString uid}:${user}:${home}:/bin/bash
              EOF
              cat > etc/group <<EOF
              root:x:0:
              ${user}:x:${toString uid}:
              EOF
            '';

            # prx-al1: own HOME as the claude uid so a rootless runtime can write
            # ~/.cache (and anything else outside the config volume). chown sticks
            # into the layer here; the config-volume mount (:U) handles its own.
            fakeRootCommands = ''
              chown -R ${toString uid}:${toString uid} ${builtins.substring 1 (-1) home}
            '';

            config = {
              # Entrypoint (not Cmd) so `podman run IMG --resume`/`-p …` pass
              # flags THROUGH to claude; bare `podman run IMG` launches the TUI.
              # The wrapper starts the netd-door relay first (iff the door is
              # mounted), then `exec claude "$@"` — flag passthrough unchanged.
              Entrypoint = [ "${entrypoint}" ];
              WorkingDir = home;
              User = user; # ocap: never run as root (see ADR "ocap fit")
              Env = [
                "HOME=${home}"
                "PATH=/bin"
                "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                "GIT_SSL_CAINFO=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                "LANG=C.UTF-8"
                # Personal account's auth/settings/history live here, on the
                # mounted volume — the isolation boundary, separate from work.
                "CLAUDE_CONFIG_DIR=${configDir}"
              ];
              # Declares the config dir as a mount point; the run wrapper
              # (prx-6xx) binds a named volume here so /login persists.
              Volumes = { "${configDir}" = { }; };
            };
          };

          default = self.packages.${system}.claude-image;
        }) // {
          # Expose the (linux) image under the darwin host too, so a plain
          # `nix build .#claude-image` on this Mac resolves and offloads to the
          # Linux builder (prx-9yp) instead of erroring "attribute not found".
          aarch64-darwin = {
            claude-image = self.packages.aarch64-linux.claude-image;
            default = self.packages.aarch64-linux.claude-image;

            # The host launcher: a typed Bun CLI, nix-built, run via PINNED bun.
            # (`bun --compile` would embed the runtime but fetches it from the
            # network — blocked in the nix sandbox → 0-byte output. A pinned-bun
            # wrapper is the pure, reproducible equivalent: one `claude-box` on
            # PATH, typed Bun, pinned. A self-contained ELF would need an impure
            # build. podman is resolved from the caller's PATH at runtime.)
            claude-box =
              let pkgs = pkgsFor "aarch64-darwin";
              in pkgs.writeShellScriptBin "claude-box" ''
                exec ${pkgs.bun}/bin/bun ${./claude-box.ts} "$@"
              '';

            # L1 provenance generator (capability-aware, see contract/). Emits
            # the CapabilityProvenance image attestation for a built image:
            #   nix run .#provenance -- --image-digest sha256:<hex>
            # Sign the emitted statement downstream (e.g. `cosign attest`).
            provenance =
              let pkgs = pkgsFor "aarch64-darwin";
              in pkgs.writeShellScriptBin "provenance" ''
                exec ${pkgs.bun}/bin/bun ${./provenance.ts} "$@"
              '';

            # netd — the allowlist egress daemon behind the `--net` door (NETD.md).
            # A pinned bun process replacing the squid+socat reference: enforces a
            # destination allowlist via CONNECT, no TLS MITM, fails closed.
            #   nix run .#netd -- --port 3128     # host/pod TCP (testable here)
            #   nix run .#netd                     # listen on $NETD_SOCK door
            netd =
              let pkgs = pkgsFor "aarch64-darwin";
              in pkgs.writeShellScriptBin "netd" ''
                exec ${pkgs.bun}/bin/bun ${./netd/netd.ts} "$@"
              '';
          };
        };

      apps.aarch64-darwin.provenance = {
        type = "app";
        program = "${self.packages.aarch64-darwin.provenance}/bin/provenance";
      };

      apps.aarch64-darwin.netd = {
        type = "app";
        program = "${self.packages.aarch64-darwin.netd}/bin/netd";
      };

      # peercred — SO_PEERCRED injector for launcherd (Rust)
      # Wraps a unix socket to inject caller UID/GID/PID into requests.
      packages.aarch64-linux.peercred =
        let pkgs = pkgsFor "aarch64-linux";
        in pkgs.rustPlatform.buildRustPackage {
          pname = "peercred";
          version = "0.1.0";
          src = ./peercred;
          cargoLock.lockFile = ./peercred/Cargo.lock;
        };
      packages.x86_64-linux.peercred =
        let pkgs = pkgsFor "x86_64-linux";
        in pkgs.rustPlatform.buildRustPackage {
          pname = "peercred";
          version = "0.1.0";
          src = ./peercred;
          cargoLock.lockFile = ./peercred/Cargo.lock;
        };

      # Option A builder (prx-9yp), prepared so we can build LATER.
      # Determinate Nix owns /etc/nix/nix.conf and sets nix.enable=false in
      # nix-darwin, so the turnkey `nix.linux-builder` module is unavailable
      # (it asserts nix.enable=true). This bypasses the module: a standalone,
      # PINNED Linux builder VM. Boot it on demand with:
      #   nix run .#linux-builder
      # then wire it once into the builder set (see BUILD.md) and:
      #   nix build .#claude-image
      apps.aarch64-darwin.linux-builder =
        let pkgs = nixpkgs.legacyPackages.aarch64-darwin;
        in {
          type = "app";
          # mainProgram is `create-builder` (not `linux-builder`); getExe tracks it.
          program = nixpkgs.lib.getExe pkgs.darwin.linux-builder;
        };
    };
}
