{
  # Pinned OCI image for the personal Claude runtime.
  # ADR: docs/prx/claude-runtime.md   Epic: prx-d4o   Tasks: prx-vds (this), prx-9yp (builder), prx-6xx (run wrapper)
  #
  # The whole point is the PIN: nixpkgs is locked (flake.lock) to a rev where
  # `claude-code` is a known, content-addressed derivation. The resulting OCI
  # image then has its OWN sha256 digest — the "sha we can pin to". Upgrades are
  # a deliberate `nix flake update` + review, never a silent self-update.
  description = "Pinned OCI image for the personal Claude runtime (claude-code + agent toolchain)";

  # Locked to the rev verified to carry claude-code 2.1.175 (aarch64-linux, unfree).
  # 2.1.x is the first line with `remote-control` (drive the in-box session from
  # claude.ai/code or the Claude mobile app); 2.0.53 lacked it. Bumping the rev IS
  # the version decision — re-pin here, then `nix flake update` to re-lock.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/9f11f828c213641c2369a9f1fa31fe31557e3156";

  # The room+door capability engine, extracted to its own public repo and
  # consumed here as a PINNED input (flake.lock). It is the single source of
  # truth; ./guest-room/ is a generated mirror of mod/protocol/daemon at this
  # pin, kept honest by the `guest-room-mirror` check below. Bump with
  # `nix flake update guest-room` + `nix run .#sync-guest-room`, commit together.
  inputs.guest-room.url = "github:bounded-systems/guest-room/5bc85b634a0a8d698243ba3b708f0420516308ec";
  inputs.guest-room.flake = false;

  # The capability-provenance contract, extracted to its own public repo and
  # consumed here as a PINNED input. Single source of truth; ./contract/ is a
  # generated mirror kept honest by the `ocap-provenance-mirror` check below.
  # Bump with `nix flake update ocap-provenance` + `nix run .#sync-ocap-provenance`.
  inputs.ocap-provenance.url = "github:bounded-systems/ocap-provenance/28c7a8530e05edc446abf62cd2e04ab73f4f626f";
  inputs.ocap-provenance.flake = false;

  # The in-box door-client SDK (keeper/scout/concierge/spawn clients + runtime),
  # extracted to its own public repo and PINNED. ./lib/ is a generated mirror of
  # door-kit's lib/, kept honest by the `door-kit-mirror` check below. Bump with
  # `nix flake update door-kit` + `nix run .#sync-door-kit`. (door-kit itself pins
  # the SAME guest-room rev as this flake — keep them in lockstep.)
  inputs.door-kit.url = "github:bounded-systems/door-kit/a3ae40e5075e3dbded3db9a0d345f842984a646b";
  inputs.door-kit.flake = false;

  # door-keeper — the keeperd git-signing door, extracted to its own public repo.
  # ./keeperd.ts is a generated mirror, kept honest by the `keeperd-mirror` check.
  # (claude-box still BUILDS keeperd-image from the mirror; consuming door-keeper's
  # published image is the later slim-claude-box step.)
  inputs.door-keeper.url = "github:bounded-systems/door-keeper/3ee805085447816a48313e28453ba0af24da7d49";
  inputs.door-keeper.flake = false;

  # door-net — the netd allowlist-egress door, extracted to its own public repo.
  # ./netd/netd.ts is a generated mirror (sync-door-net + netd-mirror check).
  inputs.door-net.url = "github:bounded-systems/door-net/e4b5f47ef86392b1c4b3561ee05b9f43d9a44ef0";
  inputs.door-net.flake = false;

  # door-scout — the scoutd external-read door, extracted to its own public repo.
  # ./scoutd.ts is a generated mirror (sync-door-scout + scoutd-mirror check).
  inputs.door-scout.url = "github:bounded-systems/door-scout/52bffb73f5d06624b3c89278dcf68f9863e7cadc";
  inputs.door-scout.flake = false;

  # door-concierge — the concierged introducer door, extracted to its own public repo.
  # ./concierged.ts is a generated mirror (sync-door-concierge + concierged-mirror check).
  inputs.door-concierge.url = "github:bounded-systems/door-concierge/4c3d8ec82d2df3126942ea1ae8d1b3d333cefbae";
  inputs.door-concierge.flake = false;

  # door-peercred — the launcherd SO_PEERCRED helper (Rust), extracted to its own
  # public repo. ./peercred/ is a generated mirror (sync-door-peercred +
  # peercred-mirror check); claude-box still BUILDS the binary from the mirror.
  inputs.door-peercred.url = "github:bounded-systems/door-peercred/2e3ed4b5051d0acfcb206ff282847b40b00000ed";
  inputs.door-peercred.flake = false;

  outputs = { self, nixpkgs, guest-room, ocap-provenance, door-kit, door-keeper, door-net, door-scout, door-concierge, door-peercred }:
    let
      # The image targets Linux. On an aarch64-darwin host this builds via a
      # Linux builder (prx-9yp) — the expression itself is builder-agnostic.
      # Both Linux arches are first-class: aarch64-linux for ARM hosts (Pi 5,
      # RK3588, Apple Silicon under Asahi) and x86_64-linux for Intel/AMD mini
      # PCs. Each pulls its own pinned `prx` release (see prxAssets) and the
      # matching glibc loader. Adding a system here is all it takes — the image
      # expression is otherwise arch-agnostic. See HOSTING.md for self-hosting.
      systems = [ "aarch64-linux" "x86_64-linux" ];
      forEach = nixpkgs.lib.genAttrs systems;

      # claude-code is unfree → instantiate nixpkgs with allowUnfree.
      pkgsFor = system: import nixpkgs {
        inherit system;
        config.allowUnfree = true;
      };

      # prx — the box's SANCTIONED tool (prx-0wc), a pinned per-arch release
      # binary. It's a `bun --compile` binary (app blob appended after the ELF),
      # so it must be left BYTE-for-BYTE intact — patchelf/autoPatchelf would
      # rewrite the ELF and corrupt the blob → it degrades to bare bun. Instead
      # the matching nix glibc loader is invoked directly on the untouched
      # binary (the upstream ELF's hardcoded /lib interpreter is absent in a nix
      # image). Each arch pins its own release asset + native loader.
      prxAssets = {
        "aarch64-linux" = {
          url = "https://github.com/bounded-systems/prx/releases/download/v0.10.0/prx-aarch64-linux";
          sha256 = "1b8ba6xgi6hdaknlhigcxai1xxlvz8j1sdm570y7jssckgiqy89l";
          loader = "ld-linux-aarch64.so.1";
        };
        "x86_64-linux" = {
          url = "https://github.com/bounded-systems/prx/releases/download/v0.10.0/prx-x86_64-linux";
          sha256 = "sha256-8dPDwrQi4CbhiGbx97hkyYxh//BPaDdw+7UEZn460wU=";
          loader = "ld-linux-x86-64.so.2";
        };
      };

      user = "claude";
      uid = 1000;
      home = "/home/${user}";
      # One XDG path: XDG_CONFIG_HOME is the single source of truth; the claude
      # config dir (and the persistent volume mount point) derives from it. The
      # launcher's BOX_CONFIG_DIR must equal configDir — tests/xdg.test.ts pins it.
      xdgConfigHome = "${home}/.config";
      configDir = "${xdgConfigHome}/claude"; # = $XDG_CONFIG_HOME/claude; volume mount point

      # NixOS VM test for the doors module: boot a VM with the doors enabled and
      # assert every door daemon starts and writes its socket. This is the
      # `checks.<linux>.doors` boot test (the durable form of HOSTING.md's manual
      # nixos-rebuild snippet). Linux-only — needs KVM/qemu to run. Names track
      # the reason-named instances (keeper, claude-netd, scout-netd, scout).
      doorsTest = system:
        let pkgs = pkgsFor system;
        in pkgs.testers.runNixOSTest {
          name = "claude-box-doors";
          nodes.machine = { ... }: {
            imports = [ self.nixosModules.default ];
            services.claude-box.doors.enable = true;
            virtualisation.diskSize = 4096; # room for the loaded door images
          };
          testScript = ''
            machine.wait_for_unit("multi-user.target")
            # oci-containers names units podman-<container>; containers are the
            # reason-named doors (claude-netd serves the box's netd.sock).
            for svc in ["podman-keeper", "podman-claude-netd", "podman-scout-netd", "podman-scout", "podman-concierge"]:
                machine.wait_for_unit(svc + ".service")
            # Each door writes its socket into the shared socketDir.
            for sock in ["keeperd", "netd", "scout-netd", "scoutd", "concierged"]:
                machine.wait_until_succeeds(
                    f"test -S /run/claude-box/doors/{sock}.sock", timeout=120
                )
            # The boundary, not just liveness: keeper, scout and concierge hold NO
            # NIC (--network=none → only loopback). scoutd's GitHub egress can only
            # flow through the scout-netd door; the concierge is pure routing (it
            # hands back references, never connecting out), so it needs no NIC.
            for box in ["keeper", "scout", "concierge"]:
                nics = machine.succeed(f"podman exec {box} ls /sys/class/net").split()
                assert nics == ["lo"], f"{box} must have only loopback (no NIC), got {nics}"
          '';
        };
    in
    {
      packages = forEach (system:
        let
          pkgs = pkgsFor system;

          # prx — the box's SANCTIONED tool (prx-0wc). Pinned release binary for
          # this arch (v0.10.0 — includes prx-ag7: runtime repo-root from cwd not
          # the binary dir). See prxAssets (top of flake) for why the binary is
          # left untouched and run via the nix glibc loader directly.
          prxAsset = prxAssets.${system};
          prxBin = pkgs.fetchurl {
            url = prxAsset.url;
            sha256 = prxAsset.sha256;
          };
          prxLibs = pkgs.lib.makeLibraryPath [ pkgs.glibc pkgs.stdenv.cc.cc.lib ];
          prx = pkgs.runCommand "prx-0.10.0" { nativeBuildInputs = [ pkgs.makeWrapper ]; } ''
            install -Dm755 ${prxBin} $out/libexec/prx
            makeWrapper ${pkgs.glibc}/lib/${prxAsset.loader} $out/bin/prx \
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
          # socat bridges loopback-TCP → /run/doors/netd.sock. Flags still pass through
          # to claude (`exec claude "$@"`); a bare run launches the TUI.
          entrypoint = pkgs.writeShellScript "claude-box-entrypoint" ''
            if [ -S /run/doors/netd.sock ]; then
              ${pkgs.socat}/bin/socat TCP-LISTEN:3128,fork,reuseaddr,bind=127.0.0.1 UNIX-CONNECT:/run/doors/netd.sock &
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
                # One XDG path: XDG_CONFIG_HOME is explicit (not the implicit
                # ~/.config default), and CLAUDE_CONFIG_DIR derives from it. The
                # account's auth/settings/history live here, on the mounted volume
                # — the isolation boundary, separate from work. `claude auth login`
                # (incl. --remote-control's full-scope login) persists here too.
                "XDG_CONFIG_HOME=${xdgConfigHome}"
                "CLAUDE_CONFIG_DIR=${configDir}"
                # Disable telemetry — the box has no route to statsig.anthropic.com
                # and the failed connection attempts flood the netd log.
                # NONESSENTIAL_TRAFFIC is the master switch: it stops the statsig
                # feature-gating calls (the actual flood) plus error reporting and
                # the autoupdater. The two below are kept for explicitness.
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"
                "DISABLE_AUTOUPDATER=1"
                "DISABLE_ERROR_REPORTING=1"
              ];
              # Declares the config dir as a mount point; the run wrapper
              # (prx-6xx) binds a named volume here so /login persists.
              Volumes = { "${configDir}" = { }; };
            };
          };

          default = self.packages.${system}.claude-image;

          # keeperd-image — the git-signing daemon as a container.
          # Runs alongside the box container in the VM, sharing:
          #   - /run/doors/ volume (where keeperd writes its socket)
          #   - /work volume (the repo both containers access)
          #   - /keys volume (persistent Ed25519 signing key, keeperd-only)
          # No path translation needed — both see /work directly.
          #   nix build .#keeperd-image && podman load -i result
          #   podman run -v doors:/run/doors -v keys:/keys -v repo:/work keeperd
          keeperd-image =
            let
              # Minimal toolchain for keeperd: bun + git + ssh
              keeperdTools = with pkgs; [
                bun
                git
                openssh
                cacert
                coreutils
                bashInteractive
              ];

              keeperdEnv = pkgs.buildEnv {
                name = "keeperd-image-root";
                paths = keeperdTools;
                pathsToLink = [ "/bin" "/etc" "/share" "/lib" ];
              };

              # Bundle the keeperd source (keeperd.ts + contract/ + lib/ + guest-room/)
              keeperdSrc = pkgs.runCommand "keeperd-src" {} ''
                mkdir -p $out/app/lib $out/app/guest-room
                cp ${./keeperd.ts} $out/app/keeperd.ts
                cp -r ${./contract} $out/app/contract
                cp ${./lib/keeper.ts} $out/app/lib/keeper.ts
                cp ${./lib/runtime.ts} $out/app/lib/runtime.ts
                cp ${./guest-room/daemon.ts} $out/app/guest-room/daemon.ts
                cp ${./guest-room/protocol.ts} $out/app/guest-room/protocol.ts
              '';

              keeperdEntrypoint = pkgs.writeShellScript "keeperd-entrypoint" ''
                exec bun /app/keeperd.ts serve \
                  --socket /run/doors/keeperd.sock \
                  --key /keys/keeper.key \
                  "$@"
              '';
            in
            pkgs.dockerTools.buildLayeredImage {
              name = "keeperd";
              tag = "dev";

              contents = [ keeperdEnv keeperdSrc ];

              extraCommands = ''
                mkdir -p etc tmp run/doors keys work
                chmod 1777 tmp
                cat > etc/passwd <<EOF
                root:x:0:0:root:/root:/bin/bash
                keeper:x:${toString uid}:${toString uid}:keeper:/app:/bin/bash
                EOF
                cat > etc/group <<EOF
                root:x:0:
                keeper:x:${toString uid}:
                EOF
              '';

              fakeRootCommands = ''
                chown -R ${toString uid}:${toString uid} run/doors keys work
              '';

              config = {
                Entrypoint = [ "${keeperdEntrypoint}" ];
                WorkingDir = "/app";
                User = "keeper";
                Env = [
                  "HOME=/app"
                  "PATH=/bin"
                  "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                  "GIT_SSL_CAINFO=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                  "LANG=C.UTF-8"
                ];
                Volumes = {
                  "/run/doors" = {};
                  "/keys" = {};
                  "/work" = {};
                };
              };
            };

          # netd-image — the allowlist egress proxy as a container.
          # Runs alongside the box container in the VM, sharing:
          #   - /run/doors/ volume (where netd writes its socket)
          # netd is the ONLY egress path for boxes (--network=none + door).
          #   nix build .#netd-image && podman load -i result
          #   podman run -v doors:/run/doors netd
          netd-image =
            let
              # Minimal toolchain for netd: just bun + coreutils
              netdTools = with pkgs; [
                bun
                cacert
                coreutils
                bashInteractive
              ];

              netdEnv = pkgs.buildEnv {
                name = "netd-image-root";
                paths = netdTools;
                pathsToLink = [ "/bin" "/etc" "/share" "/lib" ];
              };

              # Bundle the netd source (preserving directory structure for imports)
              netdSrc = pkgs.runCommand "netd-src" {} ''
                mkdir -p $out/app/netd $out/app/lib $out/app/guest-room
                cp ${./netd/netd.ts} $out/app/netd/netd.ts
                cp ${./lib/runtime.ts} $out/app/lib/runtime.ts
                cp ${./guest-room/daemon.ts} $out/app/guest-room/daemon.ts
                cp ${./guest-room/protocol.ts} $out/app/guest-room/protocol.ts
              '';

              netdEntrypoint = pkgs.writeShellScript "netd-entrypoint" ''
                # NETD_SOCK lets several reason-named instances coexist on one
                # doors volume (e.g. claude-netd.sock, scout-netd.sock); default
                # keeps the single-instance path. NETD_ALLOW sets the reason's
                # allowlist. netd is the MECHANISM; the instance carries the reason.
                exec bun /app/netd/netd.ts serve --socket "''${NETD_SOCK:-/run/doors/netd.sock}" "$@"
              '';
            in
            pkgs.dockerTools.buildLayeredImage {
              name = "netd";
              tag = "dev";

              contents = [ netdEnv netdSrc ];

              extraCommands = ''
                mkdir -p etc tmp run/doors
                chmod 1777 tmp
                cat > etc/passwd <<EOF
                root:x:0:0:root:/root:/bin/bash
                netd:x:${toString uid}:${toString uid}:netd:/app:/bin/bash
                EOF
                cat > etc/group <<EOF
                root:x:0:
                netd:x:${toString uid}:
                EOF
              '';

              fakeRootCommands = ''
                chown -R ${toString uid}:${toString uid} run/doors
              '';

              config = {
                Entrypoint = [ "${netdEntrypoint}" ];
                WorkingDir = "/app";
                User = "netd";
                Env = [
                  "HOME=/app"
                  "PATH=/bin"
                  "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                  "LANG=C.UTF-8"
                  # Default allowlist — can be overridden via NETD_ALLOW env
                  "NETD_ALLOW=api.anthropic.com,.anthropic.com"
                ];
                Volumes = {
                  "/run/doors" = {};
                };
              };
            };

          # scoutd-image — the external read daemon as a container.
          # Runs alongside the box container in the VM, sharing:
          #   - /run/doors/ volume (where scoutd writes its socket)
          # scoutd holds read tokens; boxes get content, never creds.
          #   nix build .#scoutd-image && podman load -i result
          #   podman run -v doors:/run/doors scoutd
          scoutd-image =
            let
              # Minimal toolchain for scoutd: bun + coreutils + cacert + socat
              # (socat bridges loopback-TCP → the scout-netd door socket so
              # scoutd can egress through netd while holding no NIC of its own).
              scoutdTools = with pkgs; [
                bun
                cacert
                coreutils
                socat
                bashInteractive
              ];

              scoutdEnv = pkgs.buildEnv {
                name = "scoutd-image-root";
                paths = scoutdTools;
                pathsToLink = [ "/bin" "/etc" "/share" "/lib" ];
              };

              # Bundle the scoutd source (with lib/ and guest-room/ for imports)
              scoutdSrc = pkgs.runCommand "scoutd-src" {} ''
                mkdir -p $out/app/lib $out/app/guest-room
                cp ${./scoutd.ts} $out/app/scoutd.ts
                cp ${./lib/runtime.ts} $out/app/lib/runtime.ts
                cp ${./guest-room/mod.ts} $out/app/guest-room/mod.ts
                cp ${./guest-room/daemon.ts} $out/app/guest-room/daemon.ts
                cp ${./guest-room/protocol.ts} $out/app/guest-room/protocol.ts
              '';

              scoutdEntrypoint = pkgs.writeShellScript "scoutd-entrypoint" ''
                # If a scout-netd door is mounted, bridge loopback → its socket and
                # force scoutd's egress through it (SCOUTD_PROXY). With scoutd run
                # --network=none, this is the ONLY egress path: interposition, not
                # cooperation. No door ⇒ no relay ⇒ direct egress (dev/TCP mode).
                if [ -S /run/doors/scout-netd.sock ]; then
                  ${pkgs.socat}/bin/socat TCP-LISTEN:3128,fork,reuseaddr,bind=127.0.0.1 \
                    UNIX-CONNECT:/run/doors/scout-netd.sock &
                  export SCOUTD_PROXY="http://127.0.0.1:3128"
                fi
                exec bun /app/scoutd.ts serve --socket /run/doors/scoutd.sock "$@"
              '';
            in
            pkgs.dockerTools.buildLayeredImage {
              name = "scoutd";
              tag = "dev";

              contents = [ scoutdEnv scoutdSrc ];

              extraCommands = ''
                mkdir -p etc tmp run/doors creds
                chmod 1777 tmp
                cat > etc/passwd <<EOF
                root:x:0:0:root:/root:/bin/bash
                scout:x:${toString uid}:${toString uid}:scout:/app:/bin/bash
                EOF
                cat > etc/group <<EOF
                root:x:0:
                scout:x:${toString uid}:
                EOF
              '';

              fakeRootCommands = ''
                chown -R ${toString uid}:${toString uid} run/doors creds
              '';

              config = {
                Entrypoint = [ "${scoutdEntrypoint}" ];
                WorkingDir = "/app";
                User = "scout";
                Env = [
                  "HOME=/app"
                  "PATH=/bin"
                  "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                  "LANG=C.UTF-8"
                ];
                Volumes = {
                  "/run/doors" = {};
                  "/creds" = {};
                };
              };
            };

          # concierged-image — the capability concierge as a container.
          # An INTRODUCER (CONCIERGE.md): holds a leased registry and hands back
          # attenuated door references on `resolve`. Pure routing — it never
          # connects to a provider, so it holds NO NIC (--network=none) and needs
          # no egress toolchain (no socat/cacert), only the /run/doors volume.
          #   nix build .#concierged-image && podman load -i result
          concierged-image =
            let
              conciergedTools = with pkgs; [ bun coreutils bashInteractive ];

              conciergedEnv = pkgs.buildEnv {
                name = "concierged-image-root";
                paths = conciergedTools;
                pathsToLink = [ "/bin" "/etc" "/share" "/lib" ];
              };

              # Bundle concierged + lib/ + guest-room engine (resolveProvider is in
              # mod.ts; lib/runtime re-exports daemon.ts/protocol.ts).
              conciergedSrc = pkgs.runCommand "concierged-src" {} ''
                mkdir -p $out/app/lib $out/app/guest-room
                cp ${./concierged.ts} $out/app/concierged.ts
                cp ${./lib/runtime.ts} $out/app/lib/runtime.ts
                cp ${./guest-room/mod.ts} $out/app/guest-room/mod.ts
                cp ${./guest-room/daemon.ts} $out/app/guest-room/daemon.ts
                cp ${./guest-room/protocol.ts} $out/app/guest-room/protocol.ts
              '';

              conciergedEntrypoint = pkgs.writeShellScript "concierged-entrypoint" ''
                exec bun /app/concierged.ts serve --socket /run/doors/concierged.sock "$@"
              '';
            in
            pkgs.dockerTools.buildLayeredImage {
              name = "concierged";
              tag = "dev";

              contents = [ conciergedEnv conciergedSrc ];

              extraCommands = ''
                mkdir -p etc tmp run/doors
                chmod 1777 tmp
                cat > etc/passwd <<EOF
                root:x:0:0:root:/root:/bin/bash
                concierge:x:${toString uid}:${toString uid}:concierge:/app:/bin/bash
                EOF
                cat > etc/group <<EOF
                root:x:0:
                concierge:x:${toString uid}:
                EOF
              '';

              fakeRootCommands = ''
                chown -R ${toString uid}:${toString uid} run/doors
              '';

              config = {
                Entrypoint = [ "${conciergedEntrypoint}" ];
                WorkingDir = "/app";
                User = "concierge";
                Env = [
                  "HOME=/app"
                  "PATH=/bin"
                  "LANG=C.UTF-8"
                ];
                Volumes = {
                  "/run/doors" = {};
                };
              };
            };

          # peercred — SO_PEERCRED injector for launcherd (Rust)
          # Wraps a unix socket to inject caller UID/GID/PID into requests.
          peercred = pkgs.rustPlatform.buildRustPackage {
            pname = "peercred";
            version = "0.1.0";
            src = ./peercred;
            cargoLock.lockFile = ./peercred/Cargo.lock;
          };

          # claude-box — the host launcher CLI, available natively on Linux.
          # A typed Bun CLI run via pinned bun (`bun --compile` fetches its
          # runtime from the network → blocked in the nix sandbox; a pinned-bun
          # wrapper is the pure equivalent). podman is resolved from the caller's
          # PATH at runtime. This makes the home-manager install in the README
          # (`packages.${system}.claude-box`) resolve on Linux hosts — see
          # HOSTING.md. The darwin set defines its own copy below.
          claude-box = pkgs.writeShellScriptBin "claude-box" ''
            exec ${pkgs.bun}/bin/bun ${./.}/claude-box.ts "$@"
          '';
        }) // {
          # Expose the (linux) image under the darwin host too, so a plain
          # `nix build .#claude-image` on this Mac resolves and offloads to the
          # Linux builder (prx-9yp) instead of erroring "attribute not found".
          aarch64-darwin = {
            claude-image = self.packages.aarch64-linux.claude-image;
            keeperd-image = self.packages.aarch64-linux.keeperd-image;
            netd-image = self.packages.aarch64-linux.netd-image;
            scoutd-image = self.packages.aarch64-linux.scoutd-image;
            concierged-image = self.packages.aarch64-linux.concierged-image;
            # The default is the CLI, not the image. Installing/running a
            # `.tar.gz` (the old default) put junk entries in `nix profile` and
            # spewed "not including …claude-personal.tar.gz" on every op — an
            # image tarball is never a useful profile/`nix run` target.
            default = self.packages.aarch64-darwin.claude-box;

            # The host launcher: a typed Bun CLI, nix-built, run via PINNED bun.
            # (`bun --compile` would embed the runtime but fetches it from the
            # network — blocked in the nix sandbox → 0-byte output. A pinned-bun
            # wrapper is the pure, reproducible equivalent: one `claude-box` on
            # PATH, typed Bun, pinned. A self-contained ELF would need an impure
            # build. podman is resolved from the caller's PATH at runtime.)
            claude-box =
              let pkgs = pkgsFor "aarch64-darwin";
              in pkgs.writeShellScriptBin "claude-box" ''
                exec ${pkgs.bun}/bin/bun ${./.}/claude-box.ts "$@"
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

            # keeperd — the git-signing daemon behind the `--keeper` door (KEEPERD.md).
            # A pinned bun process that holds the Ed25519 signing key and performs
            # signed commits/pushes on behalf of boxes. The box holds no keys — it
            # requests signed writes through the /run/keeperd.sock door.
            #   nix run .#keeperd                  # listen on $KEEPERD_SOCK or default
            #   nix run .#keeperd -- --help        # show usage
            # Note: runs from the source tree (not just keeperd.ts) because the
            # daemon imports ./contract/types and ./contract/slsa.
            keeperd =
              let pkgs = pkgsFor "aarch64-darwin";
              in pkgs.writeShellScriptBin "keeperd" ''
                exec ${pkgs.bun}/bin/bun ${./.}/keeperd.ts "$@"
              '';

            # netd — the allowlist egress daemon behind the `--net` door (NETD.md).
            # A pinned bun process replacing the squid+socat reference: enforces a
            # destination allowlist via CONNECT, no TLS MITM, fails closed.
            #   nix run .#netd -- --port 3128     # host/pod TCP (testable here)
            #   nix run .#netd                     # listen on $NETD_SOCK door
            netd =
              let pkgs = pkgsFor "aarch64-darwin";
              in pkgs.writeShellScriptBin "netd" ''
                exec ${pkgs.bun}/bin/bun ${./.}/netd/netd.ts "$@"
              '';

            # scoutd — the external read daemon behind the `--scout` door (SCOUT.md).
            # A pinned bun process that fetches repos/PRs/issues/URLs and returns
            # content, never credentials. The read twin of keeperd.
            #   nix run .#scoutd -- --port 3129   # TCP for testing
            #   nix run .#scoutd                   # listen on $SCOUTD_SOCK door
            scoutd =
              let pkgs = pkgsFor "aarch64-darwin";
              in pkgs.writeShellScriptBin "scoutd" ''
                exec ${pkgs.bun}/bin/bun ${./.}/scoutd.ts "$@"
              '';

            # doors-serve — run all door daemons in foreground (TCP mode).
            # Delegates to `claude-box doors serve` so there is ONE orchestrator
            # and ONE source of truth for the TCP ports (TCP_PORTS in
            # claude-box.ts). The old inline version started daemons on Unix
            # sockets (no --port) — broken on macOS, where virtiofs can't share
            # sockets into the podman-machine VM.
            #   nix run .#doors-serve
            doors-serve =
              let pkgs = pkgsFor "aarch64-darwin";
              in pkgs.writeShellScriptBin "doors-serve" ''
                exec ${self.packages.aarch64-darwin.claude-box}/bin/claude-box doors serve "$@"
              '';

            # sync-guest-room — regenerate ./guest-room/ from the PINNED input.
            # The directory is a generated mirror (see guest-room/README.md); this
            # is the only sanctioned way to change it. Run from the repo root after
            # `nix flake update guest-room`, then commit flake.lock + guest-room/.
            sync-guest-room =
              let pkgs = pkgsFor "aarch64-darwin";
              in pkgs.writeShellScriptBin "sync-guest-room" ''
                set -euo pipefail
                if [ ! -d "$PWD/guest-room" ]; then
                  echo "run from the claude-box repo root (no ./guest-room here)" >&2
                  exit 1
                fi
                for f in mod.ts protocol.ts daemon.ts; do
                  install -m 644 ${guest-room}/$f "$PWD/guest-room/$f"
                  echo "synced guest-room/$f"
                done
              '';

            # sync-ocap-provenance — regenerate ./contract/ from the PINNED input.
            sync-ocap-provenance =
              let pkgs = pkgsFor "aarch64-darwin";
              in pkgs.writeShellScriptBin "sync-ocap-provenance" ''
                set -euo pipefail
                if [ ! -d "$PWD/contract" ]; then
                  echo "run from the claude-box repo root (no ./contract here)" >&2
                  exit 1
                fi
                for f in CHAIN.md README.md SLSA-MAPPING.md capability-provenance.v0.1.schema.json slsa.ts types.ts; do
                  install -m 644 ${ocap-provenance}/$f "$PWD/contract/$f"
                  echo "synced contract/$f"
                done
              '';

            # sync-door-kit — regenerate ./lib/ from the PINNED door-kit/lib/.
            sync-door-kit =
              let pkgs = pkgsFor "aarch64-darwin";
              in pkgs.writeShellScriptBin "sync-door-kit" ''
                set -euo pipefail
                if [ ! -d "$PWD/lib" ]; then
                  echo "run from the claude-box repo root (no ./lib here)" >&2
                  exit 1
                fi
                for f in concierge.ts keeper.ts runtime.ts scout.ts spawn.ts; do
                  install -m 644 ${door-kit}/lib/$f "$PWD/lib/$f"
                  echo "synced lib/$f"
                done
              '';

            # sync-door-keeper — regenerate ./keeperd.ts from the PINNED door-keeper.
            sync-door-keeper =
              let pkgs = pkgsFor "aarch64-darwin";
              in pkgs.writeShellScriptBin "sync-door-keeper" ''
                set -euo pipefail
                if [ ! -f "$PWD/keeperd.ts" ]; then
                  echo "run from the claude-box repo root (no ./keeperd.ts here)" >&2
                  exit 1
                fi
                install -m 644 ${door-keeper}/keeperd.ts "$PWD/keeperd.ts"
                echo "synced keeperd.ts"
              '';

            # sync-door-net — regenerate ./netd/netd.ts from the PINNED door-net.
            sync-door-net =
              let pkgs = pkgsFor "aarch64-darwin";
              in pkgs.writeShellScriptBin "sync-door-net" ''
                set -euo pipefail
                if [ ! -f "$PWD/netd/netd.ts" ]; then
                  echo "run from the claude-box repo root (no ./netd/netd.ts here)" >&2
                  exit 1
                fi
                install -m 644 ${door-net}/netd/netd.ts "$PWD/netd/netd.ts"
                echo "synced netd/netd.ts"
              '';

            # sync-door-scout — regenerate ./scoutd.ts from the PINNED door-scout.
            sync-door-scout =
              let pkgs = pkgsFor "aarch64-darwin";
              in pkgs.writeShellScriptBin "sync-door-scout" ''
                set -euo pipefail
                if [ ! -f "$PWD/scoutd.ts" ]; then
                  echo "run from the claude-box repo root (no ./scoutd.ts here)" >&2
                  exit 1
                fi
                install -m 644 ${door-scout}/scoutd.ts "$PWD/scoutd.ts"
                echo "synced scoutd.ts"
              '';

            # sync-door-concierge — regenerate ./concierged.ts from the PINNED door-concierge.
            sync-door-concierge =
              let pkgs = pkgsFor "aarch64-darwin";
              in pkgs.writeShellScriptBin "sync-door-concierge" ''
                set -euo pipefail
                if [ ! -f "$PWD/concierged.ts" ]; then
                  echo "run from the claude-box repo root (no ./concierged.ts here)" >&2
                  exit 1
                fi
                install -m 644 ${door-concierge}/concierged.ts "$PWD/concierged.ts"
                echo "synced concierged.ts"
              '';

            # sync-door-peercred — regenerate ./peercred/ from the PINNED door-peercred.
            sync-door-peercred =
              let pkgs = pkgsFor "aarch64-darwin";
              in pkgs.writeShellScriptBin "sync-door-peercred" ''
                set -euo pipefail
                if [ ! -d "$PWD/peercred/src" ]; then
                  echo "run from the claude-box repo root (no ./peercred here)" >&2
                  exit 1
                fi
                for f in Cargo.toml Cargo.lock src/main.rs; do
                  install -m 644 ${door-peercred}/$f "$PWD/peercred/$f"
                  echo "synced peercred/$f"
                done
              '';

            # setup — one-call local bringup for macOS (determinate, pinned).
            # Takes a fresh checkout from clone to a running box without the
            # manual dance: prereqs → podman machine → build+load image → doors.
            #   nix run .#setup                  # full bringup, then serve doors
            #   nix run .#setup -- --setup-only  # stop after the image build
            setup =
              let pkgs = pkgsFor "aarch64-darwin";
              in pkgs.writeShellScriptBin "claude-box-setup" ''
                set -euo pipefail

                serve=1
                for arg in "$@"; do
                  case "$arg" in
                    --setup-only) serve=0 ;;
                    -h|--help)
                      echo "claude-box setup — one-call local bringup (macOS)"
                      echo ""
                      echo "  nix run .#setup                 prereqs, podman machine, build+load image, then serve doors"
                      echo "  nix run .#setup -- --setup-only stop after the image (do not start doors)"
                      echo ""
                      echo "Run from the repo root. After setup, launch a box in another terminal:"
                      echo "  DOORS_TCP=1 claude-box --room dev --repo ."
                      exit 0 ;;
                    *) echo "claude-box setup: unknown arg '$arg' (try --help)" >&2; exit 2 ;;
                  esac
                done

                say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
                die() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

                say "1/3  Prereqs"
                command -v nix    >/dev/null || die "nix not found — install Nix (flakes enabled)."
                command -v podman >/dev/null || die "podman not found — 'brew install podman'."
                echo "  nix:    $(command -v nix)"
                echo "  podman: $(command -v podman)"

                say "2/3  podman machine"
                if podman machine list --format '{{.Name}}' 2>/dev/null | grep -q .; then
                  echo "  machine exists — starting (no-op if already running)"
                  podman machine start 2>/dev/null || true
                else
                  echo "  no machine — initializing + starting (first run pulls the VM image)"
                  podman machine init
                  podman machine start
                fi

                say "3/3  Build + load the image"
                echo "  nix build .#claude-image  (offloads to the aarch64-linux builder on macOS)"
                nix build .#claude-image \
                  || die "image build failed. On Apple Silicon this needs an aarch64-linux (vz) builder — see BUILD.md."
                podman load -i result
                podman image exists localhost/claude-personal:dev \
                  || die "image did not load into podman."
                echo "  image OK: localhost/claude-personal:dev"

                printf '\n\033[1m== Setup complete\033[0m\n'
                echo "Launch a box in ANOTHER terminal (TCP mode):"
                echo "    DOORS_TCP=1 claude-box --room dev --repo ."
                echo ""

                if [ "$serve" = "1" ]; then
                  say "Starting doors (TCP mode) — Ctrl+C to stop"
                  exec ${self.packages.aarch64-darwin.claude-box}/bin/claude-box doors serve
                else
                  echo "Start the doors when ready:"
                  echo "    nix run .#doors-serve        # (or: claude-box doors serve)"
                fi
              '';
          };
        };

      # NixOS module: run the door daemons declaratively on a NixOS host
      # (`services.claude-box.doors.enable = true`). See nixos/doors.nix and the
      # "NixOS" section of HOSTING.md. The module closes over `self` so it can
      # source the door images from this flake (pinned, no GHCR pull).
      nixosModules.claude-box-doors = import ./nixos/doors.nix self;
      nixosModules.default = self.nixosModules.claude-box-doors;

      # One-call local bringup: prereqs → podman machine → image → doors.
      apps.aarch64-darwin.setup = {
        type = "app";
        program = "${self.packages.aarch64-darwin.setup}/bin/claude-box-setup";
        meta.description = "One-call local bringup: prereqs → podman machine → image → doors";
      };

      # `nix run .` / `.#claude-box` → the CLI (matches the package default).
      apps.aarch64-darwin.default = {
        type = "app";
        program = "${self.packages.aarch64-darwin.claude-box}/bin/claude-box";
        meta.description = "Run the claude-box launcher CLI";
      };
      apps.aarch64-darwin.claude-box = {
        type = "app";
        program = "${self.packages.aarch64-darwin.claude-box}/bin/claude-box";
        meta.description = "Run the claude-box launcher CLI";
      };

      # `nix run .#doors-serve` → all door daemons on TCP (foreground).
      apps.aarch64-darwin.doors-serve = {
        type = "app";
        program = "${self.packages.aarch64-darwin.doors-serve}/bin/doors-serve";
        meta.description = "Run keeperd/netd/scoutd on TCP (foreground; macOS dev mode)";
      };

      # `nix run .#sync-guest-room` → regenerate ./guest-room/ from the pinned input.
      apps.aarch64-darwin.sync-guest-room = {
        type = "app";
        program = "${self.packages.aarch64-darwin.sync-guest-room}/bin/sync-guest-room";
        meta.description = "Sync ./guest-room/ from the pinned guest-room input";
      };

      # `nix run .#sync-ocap-provenance` → regenerate ./contract/ from the pinned input.
      apps.aarch64-darwin.sync-ocap-provenance = {
        type = "app";
        program = "${self.packages.aarch64-darwin.sync-ocap-provenance}/bin/sync-ocap-provenance";
        meta.description = "Sync ./contract/ from the pinned ocap-provenance input";
      };

      # `nix run .#sync-door-kit` → regenerate ./lib/ from the pinned door-kit input.
      apps.aarch64-darwin.sync-door-kit = {
        type = "app";
        program = "${self.packages.aarch64-darwin.sync-door-kit}/bin/sync-door-kit";
        meta.description = "Sync ./lib/ from the pinned door-kit input";
      };

      # `nix run .#sync-door-keeper` → regenerate ./keeperd.ts from the pinned input.
      apps.aarch64-darwin.sync-door-keeper = {
        type = "app";
        program = "${self.packages.aarch64-darwin.sync-door-keeper}/bin/sync-door-keeper";
        meta.description = "Sync ./keeperd.ts from the pinned door-keeper input";
      };

      # `nix run .#sync-door-net` → regenerate ./netd/netd.ts from the pinned input.
      apps.aarch64-darwin.sync-door-net = {
        type = "app";
        program = "${self.packages.aarch64-darwin.sync-door-net}/bin/sync-door-net";
        meta.description = "Sync ./netd/netd.ts from the pinned door-net input";
      };

      # `nix run .#sync-door-scout` → regenerate ./scoutd.ts from the pinned input.
      apps.aarch64-darwin.sync-door-scout = {
        type = "app";
        program = "${self.packages.aarch64-darwin.sync-door-scout}/bin/sync-door-scout";
        meta.description = "Sync ./scoutd.ts from the pinned door-scout input";
      };

      # `nix run .#sync-door-concierge` → regenerate ./concierged.ts from the pinned input.
      apps.aarch64-darwin.sync-door-concierge = {
        type = "app";
        program = "${self.packages.aarch64-darwin.sync-door-concierge}/bin/sync-door-concierge";
        meta.description = "Sync ./concierged.ts from the pinned door-concierge input";
      };

      # `nix run .#sync-door-peercred` → regenerate ./peercred/ from the pinned input.
      apps.aarch64-darwin.sync-door-peercred = {
        type = "app";
        program = "${self.packages.aarch64-darwin.sync-door-peercred}/bin/sync-door-peercred";
        meta.description = "Sync ./peercred/ from the pinned door-peercred input";
      };

      apps.aarch64-darwin.provenance = {
        type = "app";
        program = "${self.packages.aarch64-darwin.provenance}/bin/provenance";
        meta.description = "Emit the image's provenance statement (SLSA / OCAP)";
      };

      apps.aarch64-darwin.keeperd = {
        type = "app";
        program = "${self.packages.aarch64-darwin.keeperd}/bin/keeperd";
        meta.description = "Run the keeperd git-signing daemon";
      };

      apps.aarch64-darwin.netd = {
        type = "app";
        program = "${self.packages.aarch64-darwin.netd}/bin/netd";
        meta.description = "Run the netd egress-allowlist daemon";
      };

      apps.aarch64-darwin.scoutd = {
        type = "app";
        program = "${self.packages.aarch64-darwin.scoutd}/bin/scoutd";
        meta.description = "Run the scoutd external-read daemon";
      };

      # Verify the flake + the NixOS doors module end to end (flake check, module
      # eval, door image builds, and — on Linux — the VM boot test). Also runnable
      # directly as ./scripts/verify.sh.
      apps.aarch64-darwin.verify = {
        type = "app";
        program = "${(pkgsFor "aarch64-darwin").writeShellScriptBin "verify" (builtins.readFile ./scripts/verify.sh)}/bin/verify";
        meta.description = "Verify the flake + the NixOS doors module";
      };

      # Option A builder (prx-9yp), prepared so we can build LATER.
      # Determinate Nix owns /etc/nix/nix.conf and sets nix.enable=false in
      # nix-darwin, so the turnkey `nix.linux-builder` module is unavailable
      # (it asserts nix.enable=true). This bypasses the module: a standalone,
      # PINNED Linux builder VM. Boot it on demand with:
      #   nix run .#linux-builder
      # then wire it once into the builder set (see BUILD.md) and:
      #   nix build .#claude-image
      #
      # CAVEAT (BUILD.md): this is a QEMU/HVF VM. On recent macOS + Apple
      # Silicon (M3/M4) it crashes in `hvf_arch_init_vcpu` on the SME registers
      # (`HV_SYS_REG_SMCR_EL1` assertion, qemu#2665). Prefer a vz-backed builder
      # (e.g. a Lima aarch64-linux VM) registered in /etc/nix/machines — see
      # BUILD.md. Keep this as the no-Lima fallback.
      apps.aarch64-darwin.linux-builder =
        let pkgs = nixpkgs.legacyPackages.aarch64-darwin;
        in {
          type = "app";
          # mainProgram is `create-builder` (not `linux-builder`); getExe tracks it.
          program = nixpkgs.lib.getExe pkgs.darwin.linux-builder;
          meta.description = "Boot the pinned aarch64-linux builder VM (see BUILD.md)";
        };

      # ── Checks (nix flake check) ────────────────────────────────────────────────
      # darwin: the guest-room mirror must match the pinned input (hermetic, no
      # network). The doors module boots in a NixOS VM (Linux only — evaluates on
      # darwin, builds on a Linux+KVM host / CI). bun test + tsc run in CI
      # (.github/workflows/ci.yml), not as hermetic nix checks — they need npm,
      # which the nix sandbox blocks.
      checks.aarch64-darwin.guest-room-mirror =
        let pkgs = pkgsFor "aarch64-darwin";
        in pkgs.runCommand "guest-room-mirror" { } ''
          for f in mod.ts protocol.ts daemon.ts; do
            if ! diff -u ${guest-room}/$f ${./guest-room}/$f; then
              echo "guest-room/$f drifted from the pinned input — run: nix run .#sync-guest-room" >&2
              exit 1
            fi
          done
          touch $out
        '';
      # ./contract/ must match the pinned ocap-provenance input.
      checks.aarch64-darwin.ocap-provenance-mirror =
        let pkgs = pkgsFor "aarch64-darwin";
        in pkgs.runCommand "ocap-provenance-mirror" { } ''
          for f in CHAIN.md README.md SLSA-MAPPING.md capability-provenance.v0.1.schema.json slsa.ts types.ts; do
            if ! diff -u ${ocap-provenance}/$f ${./contract}/$f; then
              echo "contract/$f drifted from the pinned input — run: nix run .#sync-ocap-provenance" >&2
              exit 1
            fi
          done
          touch $out
        '';
      # ./lib/ must match the pinned door-kit/lib/.
      checks.aarch64-darwin.door-kit-mirror =
        let pkgs = pkgsFor "aarch64-darwin";
        in pkgs.runCommand "door-kit-mirror" { } ''
          for f in concierge.ts keeper.ts runtime.ts scout.ts spawn.ts; do
            if ! diff -u ${door-kit}/lib/$f ${./lib}/$f; then
              echo "lib/$f drifted from the pinned input — run: nix run .#sync-door-kit" >&2
              exit 1
            fi
          done
          touch $out
        '';
      # ./keeperd.ts must match the pinned door-keeper.
      checks.aarch64-darwin.keeperd-mirror =
        let pkgs = pkgsFor "aarch64-darwin";
        in pkgs.runCommand "keeperd-mirror" { } ''
          if ! diff -u ${door-keeper}/keeperd.ts ${./keeperd.ts}; then
            echo "keeperd.ts drifted from the pinned input — run: nix run .#sync-door-keeper" >&2
            exit 1
          fi
          touch $out
        '';
      # ./netd/netd.ts must match the pinned door-net.
      checks.aarch64-darwin.netd-mirror =
        let pkgs = pkgsFor "aarch64-darwin";
        in pkgs.runCommand "netd-mirror" { } ''
          if ! diff -u ${door-net}/netd/netd.ts ${./netd/netd.ts}; then
            echo "netd/netd.ts drifted from the pinned input — run: nix run .#sync-door-net" >&2
            exit 1
          fi
          touch $out
        '';
      # ./scoutd.ts must match the pinned door-scout.
      checks.aarch64-darwin.scoutd-mirror =
        let pkgs = pkgsFor "aarch64-darwin";
        in pkgs.runCommand "scoutd-mirror" { } ''
          if ! diff -u ${door-scout}/scoutd.ts ${./scoutd.ts}; then
            echo "scoutd.ts drifted from the pinned input — run: nix run .#sync-door-scout" >&2
            exit 1
          fi
          touch $out
        '';
      # ./concierged.ts must match the pinned door-concierge.
      checks.aarch64-darwin.concierged-mirror =
        let pkgs = pkgsFor "aarch64-darwin";
        in pkgs.runCommand "concierged-mirror" { } ''
          if ! diff -u ${door-concierge}/concierged.ts ${./concierged.ts}; then
            echo "concierged.ts drifted from the pinned input — run: nix run .#sync-door-concierge" >&2
            exit 1
          fi
          touch $out
        '';
      # ./peercred/ must match the pinned door-peercred.
      checks.aarch64-darwin.peercred-mirror =
        let pkgs = pkgsFor "aarch64-darwin";
        in pkgs.runCommand "peercred-mirror" { } ''
          for f in Cargo.toml Cargo.lock src/main.rs; do
            if ! diff -u ${door-peercred}/$f ${./peercred}/$f; then
              echo "peercred/$f drifted from the pinned input — run: nix run .#sync-door-peercred" >&2
              exit 1
            fi
          done
          touch $out
        '';
      checks.x86_64-linux.doors = doorsTest "x86_64-linux";
      checks.aarch64-linux.doors = doorsTest "aarch64-linux";
    };
}
