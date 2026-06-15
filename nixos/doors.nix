# NixOS module: run the claude-box door daemons (keeperd / netd / scoutd) as
# system services, via podman + virtualisation.oci-containers. This is the
# declarative equivalent of the quadlet/ units and the manual bring-up in
# HOSTING.md — `services.claude-box.doors.enable = true` instead of
# `cp *.container ~/.config/containers/systemd/ && systemctl --user enable`.
#
# Images come from THIS flake (imageFile), so the doors are pinned by the same
# digest the rest of the project is — no GHCR pull, no registry auth.
#
# Wire it into a host config:
#   imports = [ inputs.claude-box.nixosModules.default ];
#   services.claude-box.doors.enable = true;
#
# ⚠️ Authored without a NixOS host to test on — see HOSTING.md "NixOS" for the
# points to verify on first `nixos-rebuild` (chiefly socket ownership between
# the rootful container uid and the user that launches the box).
self:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.claude-box.doors;
  sys = pkgs.stdenv.hostPlatform.system;
  flakePkgs = self.packages.${sys};

  # uid the daemon images run as (flake.nix: non-root `claude`/daemon user).
  uid = 1000;

  # The hardening floor shared by every door (mirrors quadlet/*.container).
  hardening = [
    "--security-opt=no-new-privileges"
    "--security-opt=label=disable"
    "--read-only"
    "--cap-drop=all"
  ];

  doorDefs = {
    keeper = {
      imageFile = flakePkgs.keeperd-image;
      image = "keeperd:dev";
      # keeperd holds the signing key and needs NO network — socket only.
      extraOptions = hardening ++ [ "--network=none" "--pids-limit=256" "--memory=512m" ];
      volumes = [
        "${cfg.socketDir}:/run/doors"
        "${cfg.keysDir}:/keys"
      ];
    };
    net = {
      imageFile = flakePkgs.netd-image;
      image = "netd:dev";
      # netd IS the egress door — it needs network. (Default podman network.)
      extraOptions = hardening ++ [ "--pids-limit=128" "--memory=256m" ];
      volumes = [ "${cfg.socketDir}:/run/doors" ];
    };
    scout = {
      imageFile = flakePkgs.scoutd-image;
      image = "scoutd:dev";
      # scoutd fetches external content — it needs network too.
      extraOptions = hardening ++ [ "--pids-limit=128" "--memory=512m" ];
      volumes = [ "${cfg.socketDir}:/run/doors" ];
    };
  };

  enabledDoors = lib.filterAttrs (name: _: lib.elem name cfg.doors) doorDefs;
in
{
  options.services.claude-box.doors = {
    enable = lib.mkEnableOption "the claude-box door daemons (keeperd/netd/scoutd)";

    doors = lib.mkOption {
      type = lib.types.listOf (lib.types.enum [ "keeper" "net" "scout" ]);
      default = [ "keeper" "net" "scout" ];
      description = "Which doors to run. Defaults to the full `dev` room set.";
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
        inherit (d) image imageFile volumes extraOptions;
      }) enabledDoors;

    # Create the socket + keys dirs owned by the daemon uid, non-world-writable
    # (the door hijack guard). The keys dir is keeperd-private (0700).
    systemd.tmpfiles.rules = [
      "d ${cfg.socketDir} 0750 ${toString uid} ${toString uid} -"
    ] ++ lib.optional (lib.elem "keeper" cfg.doors)
      "d ${cfg.keysDir} 0700 ${toString uid} ${toString uid} -";
  };
}
