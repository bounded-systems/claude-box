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

          # Everything the agent needs to be useful inside the container.
          # NOTE: `prx` is NOT in nixpkgs — it's built from this repo; wiring it
          # in (a bun-compiled binary added to `paths`) is a TODO for prx-vds.
          toolchain = with pkgs; [
            claude-code        # the star — pinned by the locked nixpkgs rev
            git
            gh                 # GitHub CLI
            ripgrep
            fd
            bun                # agent/runtime (also what prx is built with)
            openssh            # git-over-ssh, gh auth
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
            # TODO(prx-6xx): finalize ownership (chown to ${uid}) under
            # fakeRootCommands/enableFakechroot so a rootless runtime can write
            # without a named-volume perm dance.
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

            config = {
              # Entrypoint (not Cmd) so `podman run IMG --resume`/`-p …` pass
              # flags THROUGH to claude; bare `podman run IMG` launches the TUI.
              Entrypoint = [ "claude" ];
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
          };
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
