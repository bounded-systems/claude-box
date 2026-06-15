# NixOS module: run the claude-box door daemons as system services, via podman +
# virtualisation.oci-containers. Declarative equivalent of the quadlet/ units and
# the manual bring-up in HOSTING.md — `services.claude-box.doors.enable = true`.
#
# Egress is reasoned, never generic: `netd` is the MECHANISM (an allowlist proxy),
# and each instance is named for its reason and carries that reason's allowlist —
#   • claude-netd  → the box reaches Anthropic (inference)
#   • scout-netd   → scoutd reads GitHub
# keeperd holds the signing key and gets NO network; scoutd holds NO NIC either —
# it egresses through scout-netd (its entrypoint bridges loopback → the
# scout-netd door and sets SCOUTD_PROXY). So only the netd instances hold a NIC.
#
# Images come from THIS flake (imageFile), pinned by digest — no GHCR pull.
#
#   imports = [ inputs.claude-box.nixosModules.default ];
#   services.claude-box.doors.enable = true;
#
# ⚠️ Authored without a NixOS host to test on — verify on first nixos-rebuild
# (chiefly socket ownership, and that scoutd actually reaches GitHub through
# scout-netd). See HOSTING.md "NixOS".
self:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.claude-box.doors;
  sys = pkgs.stdenv.hostPlatform.system;
  flakePkgs = self.packages.${sys};

  # uid the daemon images run as (flake.nix: non-root daemon user).
  uid = 1000;

  # The hardening floor shared by every door (mirrors quadlet/*.container).
  hardening = [
    "--security-opt=no-new-privileges"
    "--security-opt=label=disable"
    "--read-only"
    "--cap-drop=all"
  ];

  # Read-door egress allowlist for scout-netd (GitHub API + tarballs + raw/objects,
  # plus the npm/pypi registries scoutd can read). netd is fail-closed.
  scoutAllow = lib.concatStringsSep "," [
    "api.github.com" "codeload.github.com" "objects.githubusercontent.com"
    "github.com" ".github.com"
    "registry.npmjs.org" "pypi.org" "files.pythonhosted.org"
  ];

  doorDefs = {
    keeper = {
      imageFile = flakePkgs.keeperd-image;
      image = "keeperd:dev";
      environment = { };
      dependsOn = [ ];
      # keeperd holds the signing key and needs NO network — socket only.
      extraOptions = hardening ++ [ "--network=none" "--pids-limit=256" "--memory=512m" ];
      volumes = [ "${cfg.socketDir}:/run/doors" "${cfg.keysDir}:/keys" ];
    };
    claude-netd = {
      imageFile = flakePkgs.netd-image;
      image = "netd:dev";
      # Reason: the box reaches Anthropic. This instance serves the box's
      # established egress door (/run/doors/netd.sock — the box image relays that
      # path); the *name* + allowlist carry the reason. It keeps the network.
      environment = {
        NETD_SOCK = "/run/doors/netd.sock";
        NETD_ALLOW = "api.anthropic.com,.anthropic.com";
      };
      dependsOn = [ ];
      extraOptions = hardening ++ [ "--pids-limit=128" "--memory=256m" ];
      volumes = [ "${cfg.socketDir}:/run/doors" ];
    };
    scout-netd = {
      imageFile = flakePkgs.netd-image;
      image = "netd:dev";
      # Reason: scoutd reads GitHub. Separate netd instance + allowlist, so the
      # box's egress (Anthropic) and scout's egress (GitHub) are distinct doors.
      environment = {
        NETD_SOCK = "/run/doors/scout-netd.sock";
        NETD_ALLOW = scoutAllow;
      };
      dependsOn = [ ];
      extraOptions = hardening ++ [ "--pids-limit=128" "--memory=256m" ];
      volumes = [ "${cfg.socketDir}:/run/doors" ];
    };
    scout = {
      imageFile = flakePkgs.scoutd-image;
      image = "scoutd:dev";
      environment = { };
      # scoutd holds NO NIC: --network=none. Its entrypoint relays through the
      # scout-netd door (which must be up first), forcing egress via netd.
      dependsOn = [ "scout-netd" ];
      extraOptions = hardening ++ [ "--network=none" "--pids-limit=128" "--memory=512m" ];
      volumes = [ "${cfg.socketDir}:/run/doors" ];
    };
    concierge = {
      imageFile = flakePkgs.concierged-image;
      image = "concierged:dev";
      environment = { };
      # The capability concierge (CONCIERGE.md): an INTRODUCER that hands back
      # attenuated door references. Pure routing — it never connects to a
      # provider, so it holds NO NIC (--network=none) and just writes its socket.
      dependsOn = [ ];
      extraOptions = hardening ++ [ "--network=none" "--pids-limit=128" "--memory=256m" ];
      volumes = [ "${cfg.socketDir}:/run/doors" ];
    };
  };

  enabledDoors = lib.filterAttrs (name: _: lib.elem name cfg.doors) doorDefs;
in
{
  options.services.claude-box.doors = {
    enable = lib.mkEnableOption "the claude-box door daemons (keeperd / netd instances / scoutd / concierged)";

    doors = lib.mkOption {
      type = lib.types.listOf (lib.types.enum [ "keeper" "claude-netd" "scout" "scout-netd" "concierge" ]);
      default = [ "keeper" "claude-netd" "scout" "scout-netd" "concierge" ];
      description = ''
        Which doors to run. `scout` requires `scout-netd` (its egress door).
        Defaults to the full set.
      '';
    };

    socketDir = lib.mkOption {
      type = lib.types.path;
      default = "/run/claude-box/doors";
      description = ''
        Host directory the doors write their sockets into (mounted at /run/doors
        in every door). The box mounts this read-only when launched. Must not be
        world-writable (each door refuses a world-writable socket dir — the
        hijack guard), so it is created 0750 owned by the daemon uid.
      '';
    };

    keysDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/claude-box/keys";
      description = "Persistent directory for keeperd's Ed25519 signing key.";
    };
  };

  config = lib.mkIf cfg.enable {
    virtualisation.podman.enable = true;
    virtualisation.oci-containers.backend = "podman";

    virtualisation.oci-containers.containers =
      lib.mapAttrs (_: d: {
        inherit (d) image imageFile volumes environment extraOptions;
      } // lib.optionalAttrs (d.dependsOn != [ ]) { inherit (d) dependsOn; }) enabledDoors;

    # Create the socket + keys dirs owned by the daemon uid, non-world-writable
    # (the door hijack guard). The keys dir is keeperd-private (0700).
    systemd.tmpfiles.rules = [
      "d ${cfg.socketDir} 0750 ${toString uid} ${toString uid} -"
    ] ++ lib.optional (lib.elem "keeper" cfg.doors)
      "d ${cfg.keysDir} 0700 ${toString uid} ${toString uid} -";
  };
}
