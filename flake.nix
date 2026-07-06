{
  # Pinned OCI image for the personal Claude runtime.
  # ADR: docs/prx/claude-runtime.md   Epic: prx-d4o   Tasks: prx-vds (this), prx-9yp (builder), prx-6xx (run wrapper)
  #
  # The whole point is the PIN: nixpkgs is locked (flake.lock) to a rev where
  # `claude-code` is a known, content-addressed derivation. The resulting OCI
  # image then has its OWN sha256 digest — the "sha we can pin to". Upgrades are
  # a deliberate `nix flake update` + review, never a silent self-update.
  description = "Pinned OCI image for the personal Claude runtime (claude-code + agent toolchain)";

  # Locked to the rev verified to carry claude-code 2.1.198 (aarch64-linux, unfree).
  # 2.1.x is the first line with `remote-control` (drive the in-box session from
  # claude.ai/code or the Claude mobile app); 2.0.53 lacked it. Bumped 2026-07-03
  # from 2.1.175 → 2.1.198: 2.1.175 predates the version (2.1.182+) that actually
  # honors `disableClaudeAiConnectors`/`disableBundledSkills`/
  # `strictPluginOnlyCustomization` in managed-settings.json — those keys were
  # silently no-ops on the old pin (found via live introspection inside the box:
  # the setting was present in settings.json, but connectors stayed attached).
  # Bumping the rev IS the version decision — re-pin here, then `nix flake update`
  # to re-lock.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/8e6f3bfd2648296235457900689e18c56b210375";

  # The room+door capability engine, extracted to its own public repo and
  # consumed here as a PINNED input (flake.lock). It is the single source of
  # truth; ./guest-room/ is a generated mirror of mod/protocol/daemon at this
  # pin, kept honest by the `guest-room-mirror` check below. Bump with
  # `nix flake update guest-room` + `nix run .#sync-guest-room`, commit together.
  inputs.guest-room.url = "github:bounded-systems/guest-room/e8cbeaa664ebe5a2ec90ad6ebf9f9c4cbe25895c";
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
  inputs.door-kit.url = "github:bounded-systems/door-kit/40f27edae0a89337cd61db364fb0bb00f8ce014a";
  inputs.door-kit.flake = false;

  # door-keeper — the keeperd git-signing door, extracted to its own public repo.
  # ./keeperd.ts is a generated mirror, kept honest by the `keeperd-mirror` check.
  # (claude-box still BUILDS keeperd-image from the mirror; consuming door-keeper's
  # published image is the later slim-claude-box step.)
  inputs.door-keeper.url = "https://flakehub.com/f/bounded-systems/door-keeper/*.tar.gz";
  inputs.door-keeper.flake = false;

  # door-net — the netd allowlist-egress door, extracted to its own public repo.
  # ./netd/netd.ts is a generated mirror (sync-door-net + netd-mirror check).
  inputs.door-net.url = "https://flakehub.com/f/bounded-systems/door-net/*.tar.gz";
  inputs.door-net.flake = false;

  # door-scout — the scoutd external-read door, extracted to its own public repo.
  # ./scoutd.ts is a generated mirror (sync-door-scout + scoutd-mirror check).
  inputs.door-scout.url = "https://flakehub.com/f/bounded-systems/door-scout/*.tar.gz";
  inputs.door-scout.flake = false;

  # door-concierge — the concierged introducer door, extracted to its own public repo.
  # ./concierged.ts is a generated mirror (sync-door-concierge + concierged-mirror check).
  inputs.door-concierge.url = "https://flakehub.com/f/bounded-systems/door-concierge/*.tar.gz";
  inputs.door-concierge.flake = false;

  # door-peercred — the launcherd SO_PEERCRED helper (Rust), extracted to its own
  # public repo. ./peercred/ is a generated mirror (sync-door-peercred +
  # peercred-mirror check); claude-box still BUILDS the binary from the mirror.
  inputs.door-peercred.url = "https://flakehub.com/f/bounded-systems/door-peercred/*.tar.gz";
  inputs.door-peercred.flake = false;

  # git-ai — local-first AI/human edit provenance (git-ai-project/git-ai),
  # packaged by bdelanghe/git-ai-flake. A real flake (exports packages.git-ai),
  # so it is NOT `flake = false` like the door mirrors above. Shipped in the box
  # so the agent can emit `git ai checkpoint` for AI-vs-human edit attribution.
  # Posture-safe (cf. GH-5's removal of `gh`): git-ai writes ONLY to the repo's
  # local .git, holds no credentials and needs no egress — it is provenance, not
  # a push/credential path.
  inputs.git-ai-flake.url = "github:bdelanghe/git-ai-flake/666cfafaf95ec6886c3100285da13a2cd9f9c959";

  outputs = { self, nixpkgs, guest-room, ocap-provenance, door-kit, door-keeper, door-net, door-scout, door-concierge, door-peercred, git-ai-flake }:
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

      # toolpath (`path` binary, github.com/empathic/toolpath) — a provenance
      # CLI: derives a step/path/graph DAG from git history and agent logs
      # (Claude, Gemini, Codex, opencode…) with actor attribution and dead-end
      # tracking. Pinned per-arch release tarball (path-cli v0.14.0), same
      # pin-a-release-asset shape as prxAssets above. UNLIKE prx, this is a
      # plain Rust binary (no appended blob), so autoPatchelf is safe here —
      # no manual loader wrapper needed. aarch64 ships dynamically linked
      # (glibc/openssl/zlib); x86_64 ships a static musl build (autoPatchelf
      # no-ops on it, nothing to patch).
      #
      # Scope: LOCAL provenance only. `path p import git` / `render md|dot`
      # read this box's own .git + agent logs and write nothing external —
      # safe to ship by default. `path auth login` / `path p export pathbase`
      # / `path p import github` need outbound network and hold a Pathbase
      # credential; those are deliberately NOT wired here (see NETD.md and
      # the toolchain comment below) — same posture that keeps `gh` out
      # (GH-5): a write-capable credential path is a named, reviewed grant,
      # never an ambient default.
      toolpathAssets = {
        "aarch64-linux" = {
          url = "https://github.com/empathic/toolpath/releases/download/v0.14.0/path-aarch64-unknown-linux-gnu.tar.gz";
          sha256 = "1d5f74nd2j26ilczm9y0cmixqp6dcn2vkd7c4jvdsbcnpln97bki";
        };
        "x86_64-linux" = {
          url = "https://github.com/empathic/toolpath/releases/download/v0.14.0/path-x86_64-unknown-linux-musl.tar.gz";
          sha256 = "1jxr089hran8l9x0hs30vcyg350jf6ysb4kbi71aqp6pcg6hj0vy";
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

          # toolpath — pinned release tarball for this arch (see toolpathAssets
          # above for why autoPatchelf is safe here, unlike prx's manual wrapper).
          toolpathAsset = toolpathAssets.${system};
          toolpath = pkgs.stdenv.mkDerivation {
            pname = "toolpath";
            version = "0.14.0";
            src = pkgs.fetchurl { inherit (toolpathAsset) url sha256; };
            nativeBuildInputs = [ pkgs.autoPatchelfHook ];
            buildInputs = [ pkgs.stdenv.cc.cc.lib pkgs.openssl pkgs.zlib ];
            # tarball is a single bare `path` file, not a directory — sourceRoot
            # "." keeps genericBuild from trying to cd into a non-existent dir.
            sourceRoot = ".";
            dontBuild = true;
            installPhase = ''
              install -Dm755 path $out/bin/path
            '';
          };

          # Everything the agent needs in the box. prx is THE tool (prx-0wc) —
          # it reaches OUT to the keeperd/beadsd boxes; the rest support it.
          toolchain = with pkgs; [
            prx                # the box's sanctioned tool (pinned v0.10.0)
            claude-code        # the star — pinned by the locked nixpkgs rev
            git                # local VCS ops (read/diff/status); pushes go via keeperd
            git-ai-flake.packages.${system}.git-ai  # AI/human edit provenance — `git ai checkpoint` (writes local .git only; no creds, no egress)
            toolpath           # `path` — provenance DAG over git/agent-log history (pinned v0.14.0).
                               # LOCAL-only: `path p import git`/`render md|dot`. Pathbase auth/export
                               # is deliberately unwired (see toolpathAssets comment above) — it needs
                               # a named netd grant + credential handling, not an ambient default.
            # NB: `gh` is deliberately ABSENT (GH-5). It was a latent direct-push
            # credential path — `gh auth login` + a token bypasses keeperd. With it
            # gone, the box has no tool that can establish push rights; writes go
            # only through the keeper door, and external READS go through the scout
            # door (see SCOUT.md), not an ambient CLI holding creds + network.
            # NB: ripgrep and fd are deliberately ABSENT. claude-code vendors its
            # OWN per-platform ripgrep binary (vendor/ripgrep/<platform>/rg) for
            # its Grep tool and does its own globbing for Glob — a separate
            # system ripgrep/fd would be dead weight, not a dependency.
            # gnused/gawk/less are ALSO absent — no evidence anything (this
            # repo's own scripts, or a real ad-hoc Bash pipeline) needs them.
            # gnugrep is a DIFFERENT case: it was cut in an earlier pass on
            # the same "no evidence" reasoning, but that was wrong — plain
            # `grep` in an ad-hoc shell pipe (e.g. `ls ... | grep -v ...`) is
            # baseline shell vocabulary, not a search-tool alternative to
            # claude-code's own Grep tool, and removing it broke a real,
            # pre-existing test (tests/ocap.test.ts's ssh-agent-absence
            # check pipes `ls` through `grep -v`) — confirmed live by booting
            # the trimmed image. Restored.
            gnugrep
            bun                # agent/runtime (also what prx is built with)
            openssh            # git-over-ssh transport (no keys shipped; agent not forwarded)
            socat              # netd-door relay (loopback proxy → /run/netd.sock)
            cacert             # TLS roots
            coreutils          # mkdir -p/sleep/dirname/cat/echo — used by claude-box's own
                               # generated boot scripts (see run()'s remote-serve/login scripts)
            bashInteractive    # provides /bin/sh itself — every guest entrypoint execs
                               # `--entrypoint sh`; this is the interpreter, not an extra
          ];

          # buildEnv gives a single /bin (+ /etc, /share) tree so PATH=/bin works.
          rootEnv = pkgs.buildEnv {
            name = "claude-image-root";
            paths = toolchain;
            pathsToLink = [ "/bin" "/etc" "/share" "/lib" ];
          };

          # GitAI authorship hooks — baked as MANAGED settings at
          # /etc/claude-code/managed-settings.json: a SYSTEM path the account-config
          # volume does NOT shadow (unlike $CLAUDE_CONFIG_DIR/settings.json),
          # highest precedence, hooks MERGE with (never replace) user/project hooks.
          # Two complementary records (see GITAI-PROVENANCE.md):
          #
          #   1. `git ai checkpoint claude` (Pre+Post) — the model's rich self-report
          #      via git-ai. Persists to .git notes, so it lands only in --repo-rw
          #      boxes (the hardened box runs .git READ-ONLY); resilient || true.
          #   2. record-authored (Post) — appends each edited file's repo-relative
          #      path to $KEEPER_AUTHORSHIP_SINK. `keeper commit` reads + truncates
          #      that sink and passes it as the authorship CLAIM, which keeperd
          #      reconciles against the real staged diff and binds into the SIGNED
          #      L3 (aiAuthored / divergent=bypass / stale). This is the channel
          #      that works in the default hardened box — the box writes nothing to
          #      .git; provenance rides keeperd's already-signed commit.
          #
          # Both are best-effort (|| true) so a hook never blocks an edit.
          #
          # disableClaudeAiConnectors — the box holds NO ambient authority by
          # design (CAPABILITIES.md: "credential-free — no ssh keys, no push
          # rights, no signing key"), but account-level Claude.ai connectors
          # (Google Drive, Notion, Calendar — configured in Claude.ai web
          # settings, NOT this repo) bypass that entirely: they apply to every
          # session under the logged-in account regardless of which box it
          # runs in, with no per-repo/per-task scoping. A box spun up for one
          # isolated repo inherited owner-level Drive/Notion write access into
          # an unrelated company's real business data (2026-07-03 finding).
          # This key is a SYSTEM-level, account-agnostic kill switch — every
          # box refuses connectors no matter which account's connectors exist,
          # closing exactly the leak the doors architecture doesn't cover.
          #
          # disableBundledSkills / strictPluginOnlyCustomization — same
          # rationale, applied to Skills: a skill is arbitrary instructions
          # that can auto-invoke inside a session, so a user- or project-level
          # skill dropped into $CLAUDE_CONFIG_DIR/skills or a repo's
          # .claude/skills is another way to introduce ambient behavior this
          # box's doors architecture never sees or gates. Locking both closes
          # bundled skills AND any user/project-supplied ones; only
          # plugin-shipped or managed-provided skills would still load.
          recordAuthoredPath = "/opt/gitai/record-authored.ts";
          gitAiHookCmd = "command -v git-ai >/dev/null 2>&1 && git-ai checkpoint claude --hook-input stdin || true";
          recordAuthoredCmd = "bun ${recordAuthoredPath} || true";
          credentialGuardPath = "/opt/security/credential-guard.ts";
          credentialGuardCmd = "bun ${credentialGuardPath}";
          cmdHook = command: { type = "command"; inherit command; };
          # permissions: a hard deny on the leased credential file. The
          # classifier already refuses credential extraction (see #193 on
          # claude-box, verified live 2026-07-04), but that's a soft,
          # prompt-dependent guardrail with no claude-box-side backstop if it
          # ever changes upstream — this is that backstop.
          #
          # NB: there is NO defaultMode value that means "deny anything not
          # explicitly allow-listed" — verified against the actual installed
          # claude-code binary's own embedded validator strings (this shipped
          # version's real defaultMode enum is default/acceptEdits/plan/
          # bypassPermissions — an overall interaction mode, not a per-tool
          # allow/deny default). An earlier attempt set defaultMode="deny",
          # which isn't a valid enum member; managed-settings validation is
          # strict (unlike user-settings), so the ENTIRE permissions object —
          # including this deny rule — was silently discarded ("Failed schema
          # validation. This field was ignored"), confirmed live by booting
          # the built image. Do not reintroduce defaultMode here without
          # re-verifying against the actual running binary first — the public
          # docs (or a summary of them) are not reliable ground truth for
          # this specific enum.
          # allowedMcpServers = [] is a full MCP lockdown: no MCP server loads
          # by default (managed, so user/project .mcp.json can't override it)
          # until a future managed entry explicitly opts one in.
          credentialsPath = "${home}/.config/claude/.credentials.json";
          gitAiManagedSettings = (pkgs.formats.json { }).generate "managed-settings.json" {
            disableClaudeAiConnectors = true;
            disableBundledSkills = true;
            strictPluginOnlyCustomization = [ "skills" ];
            allowedMcpServers = [ ];
            permissions = {
              deny = [
                "Read(${credentialsPath})"
                "Bash(cat ${credentialsPath}*)"
              ];
            };
            hooks = {
              PreToolUse = [
                { matcher = "Edit|Write"; hooks = [ (cmdHook gitAiHookCmd) ]; }
                # credential-guard: a second, dynamic layer alongside the
                # static permissions.deny above — inspects the actual
                # command/path string, catching variants a fixed pattern
                # misses (see scripts/credential-guard.ts). Deliberately no
                # `|| true` — this hook's exit code IS the block signal.
                { matcher = "Bash|Read"; hooks = [ (cmdHook credentialGuardCmd) ]; }
              ];
              PostToolUse = [{
                matcher = "Edit|Write";
                hooks = [ (cmdHook gitAiHookCmd) (cmdHook recordAuthoredCmd) ];
              }];
            };
          };

          # netd door relay (CAPABILITIES.md "Network is a door — not a NIC").
          # The box runs --network=none; if the launcher forwarded the netd door
          # (`--net`), expose it as a loopback proxy (127.0.0.1:3128) so the
          # HTTPS_PROXY the launcher set reaches netd, which owns the allowlist.
          # No door ⇒ no relay ⇒ the box is offline. The box holds no egress of
          # its own — standard tooling can't proxy straight to a unix socket, so
          # socat bridges loopback-TCP → /run/doors/netd.sock. Flags still pass through
          # to claude (`exec claude "$@"`); a bare run launches the TUI.
          #
          # prx-asr: as a long-lived per-repo-pod member (claude-room), the box is
          # started with NO args and NO TTY — there is no one to drive it yet (the
          # session:control door is sealed until prx-9s14). A bare `exec claude`
          # there defaults to --print, exits "Input must be provided", and the
          # container crash-loops (observed: 589k restarts). So when run with no
          # args AND no TTY, IDLE instead — stay up, ready to be driven via the
          # control door later. Interactive runs (a TTY → TUI) and explicit
          # arg/flag passthrough are unchanged.
          entrypoint = pkgs.writeShellScript "claude-box-entrypoint" ''
            if [ -S /run/doors/netd.sock ]; then
              ${pkgs.socat}/bin/socat TCP-LISTEN:3128,fork,reuseaddr,bind=127.0.0.1 UNIX-CONNECT:/run/doors/netd.sock &
            fi
            if [ "$#" -eq 0 ] && [ ! -t 0 ]; then
              exec ${pkgs.coreutils}/bin/sleep infinity
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
              # GitAI checkpoint hooks as managed (system) settings — not shadowed
              # by the account-config volume at $CLAUDE_CONFIG_DIR (see gitAiManagedSettings).
              mkdir -p etc/claude-code
              cp ${gitAiManagedSettings} etc/claude-code/managed-settings.json
              # The authorship-capture hook script (record-authored, run by the
              # PostToolUse hook above).
              mkdir -p opt/gitai
              cp ${./scripts/record-authored.ts} opt/gitai/record-authored.ts
              # The credential-guard PreToolUse hook script (see gitAiManagedSettings).
              mkdir -p opt/security
              cp ${./scripts/credential-guard.ts} opt/security/credential-guard.ts
              # git-ai config: baked at the user home so git-ai picks it up on
              # first run without any interactive setup. git_path points to the
              # nix-managed git binary in /bin; telemetry and version-check noise
              # are disabled (the box has no route to telemetry endpoints anyway).
              # prompt_storage=notes stores session context with each checkpoint
              # so git ai show-prompt works when .git is writable (--repo-rw).
              mkdir -p ${builtins.substring 1 (-1) home}/.git-ai
              cat > ${builtins.substring 1 (-1) home}/.git-ai/config.json <<'GITAI_EOF'
              {
                "git_path": "/bin/git",
                "prompt_storage": "notes",
                "telemetry_oss": "off",
                "disable_auto_updates": true,
                "disable_version_checks": true
              }
              GITAI_EOF
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
                # GitAI authorship sink: the record-authored PostToolUse hook
                # appends edited paths here; `keeper commit` reads + truncates it
                # and passes them as the authorship claim (GITAI-PROVENANCE.md).
                # /tmp is the box's own ephemeral tmpfs (1777) — per-run, no .git
                # write, works in the hardened box.
                "KEEPER_AUTHORSHIP_SINK=/tmp/keeper-authored"
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
                cp ${./guest-room/mod.ts} $out/app/guest-room/mod.ts
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
                cp ${./guest-room/mod.ts} $out/app/guest-room/mod.ts
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

          # launcherd-image — the launch-controller daemon as a container.
          # Unlike keeperd/netd/scoutd, launcherd needs to reach the HOST's
          # container runtime (it shells out to `podman run`/`inspect`/`kill`
          # to actually spawn/manage sibling boxes — see launcherd.ts's
          # buildPodmanArgv/getContainerId) — the one daemon in this list
          # with a host-control surface, not just a socket-scoped capability.
          #   nix build .#launcherd-image && podman load -i result
          #   podman run -v doors:/run/doors \
          #     -v $XDG_RUNTIME_DIR/podman/podman.sock:/run/podman/podman.sock \
          #     -e CONTAINER_HOST=unix:///run/podman/podman.sock launcherd
          # ^ that socket mount is the recommended-but-unvalidated approach
          # from quadlet/launcherd.container's own header comment — treat it
          # the same way here: a real privilege grant, worth a dedicated
          # security pass before a production deployment, not a settled
          # default just because it appears in this file.
          launcherd-image =
            let
              launcherdTools = with pkgs; [
                bun # ONLY for TypeScript type-stripping at runtime (`bun run`
                    # on the bundle below) — NOT `bun build --compile`, which
                    # needs network access to fetch a target runtime and
                    # produces a silent 0-byte output in the Nix sandbox (see
                    # the claude-box launcher package's own comment on this
                    # exact pitfall, above).
                podman
                git
                cacert
                coreutils
                bashInteractive
              ];

              launcherdEnv = pkgs.buildEnv {
                name = "launcherd-image-root";
                paths = launcherdTools;
                pathsToLink = [ "/bin" "/etc" "/share" "/lib" ];
              };

              # launcherd.ts pulls in a much larger module graph than
              # keeperd/scoutd (the whole ./claude-box, which itself imports
              # guest-room/, lib/box-keys.ts, lib/remote-control-flags.ts,
              # netd/netd.ts, ...) — rather than hand-enumerating every
              # transitive file the way keeperd-src/scoutd-src do (fragile:
              # a missed file only surfaces as a runtime crash), bundle with
              # `bun build --target=bun` (plain JS bundling, NOT --compile —
              # no network fetch, so it's Nix-sandbox-safe) against the full
              # source tree. A missing dependency fails LOUDLY at BUILD time
              # here instead of silently at container runtime.
              launcherdBundle = pkgs.runCommand "launcherd-bundle"
                { nativeBuildInputs = [ pkgs.bun ]; }
                ''
                  mkdir -p src
                  cp ${./launcherd.ts} src/launcherd.ts
                  cp ${./claude-box.ts} src/claude-box.ts
                  cp ${./door-interpose.ts} src/door-interpose.ts
                  cp -r ${./contract} src/contract
                  cp -r ${./guest-room} src/guest-room
                  cp -r ${./lib} src/lib
                  mkdir -p src/netd
                  cp ${./netd/netd.ts} src/netd/netd.ts
                  mkdir -p $out
                  cd src
                  HOME=$TMPDIR bun build launcherd.ts --target=bun --outfile=$out/launcherd.js
                '';

              launcherdEntrypoint = pkgs.writeShellScript "launcherd-entrypoint" ''
                exec bun /app/launcherd.js serve \
                  --socket /run/doors/launcherd.sock \
                  --dispatch-socket /run/doors/dispatch.sock \
                  --key /keys/launcherd.key \
                  "$@"
              '';
            in
            pkgs.dockerTools.buildLayeredImage {
              name = "launcherd";
              tag = "dev";

              contents = [ launcherdEnv launcherdBundle ];

              extraCommands = ''
                mkdir -p app etc tmp run/doors run/podman keys
                cp ${launcherdBundle}/launcherd.js app/launcherd.js
                chmod 1777 tmp
                cat > etc/passwd <<EOF
                root:x:0:0:root:/root:/bin/bash
                EOF
                cat > etc/group <<EOF
                root:x:0:
                EOF
              '';

              config = {
                Entrypoint = [ "${launcherdEntrypoint}" ];
                WorkingDir = "/app";
                # Runs as root (unlike keeperd/scoutd's dedicated non-root
                # user) — it needs to reach the mounted podman socket, whose
                # host-side permissions this image doesn't control. Narrowing
                # this is part of the same security pass the socket-mount
                # approach itself needs (see the comment above).
                Env = [
                  "HOME=/root"
                  "PATH=/bin"
                  "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                  "GIT_SSL_CAINFO=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                  "LANG=C.UTF-8"
                  "CONTAINER_HOST=unix:///run/podman/podman.sock"
                ];
                Volumes = {
                  "/run/doors" = {};
                  "/run/podman" = {};
                  "/keys" = {};
                };
              };
            };

          # authd-image — the Remote Control auth door as a container.
          # UNLIKE keeperd/netd/scoutd/launcherd, authd's credential is
          # EPHEMERAL, seeded from a single JSON line piped on stdin at boot
          # (see authd.ts's own header comment) — nothing ever touches disk.
          # A Quadlet unit for this needs to feed that stdin at container
          # start (e.g. `StandardInput=file:...` + an ExecStartPre= that
          # writes a fresh check-in credential there, the same shape already
          # used for remote-serve.container's auth-grant ExecStartPre=) —
          # NOT included here; this is just the image, the same scope
          # launcherd-image covered before its own Quadlet wiring landed.
          #   nix build .#authd-image && podman load -i result
          #   claude-box check-in | podman run -i -v doors:/run/doors \
          #     -e AUTHD_ISSUER_KEYS_PATH=/keys/issuer.json -v keys:/keys:ro \
          #     -e ROOM_ID=claude-box-remote-serve authd
          authd-image =
            let
              # No Bun.spawn anywhere in authd.ts (confirmed by inspection) —
              # it's pure JS/network/file work, no external CLI dependency.
              # cacert is still needed for the live OAuth refresh path
              # (AUTHD_REFRESH_LIVE=1, talks to Anthropic's token endpoint).
              authdTools = with pkgs; [
                bun
                cacert
                coreutils
                bashInteractive
              ];

              authdEnv = pkgs.buildEnv {
                name = "authd-image-root";
                paths = authdTools;
                pathsToLink = [ "/bin" "/etc" "/share" "/lib" ];
              };

              # Same bundling approach as launcherd-image (bun build
              # --target=bun, NOT --compile — see that derivation's comment
              # for why) — authd.ts's import surface is small (lib/runtime.ts
              # + guest-room/mod.ts, same as keeperd/scoutd), so this is
              # more belt-and-suspenders than strictly necessary here, but
              # keeps one bundling pattern across every daemon image rather
              # than two.
              authdBundle = pkgs.runCommand "authd-bundle"
                { nativeBuildInputs = [ pkgs.bun ]; }
                ''
                  mkdir -p src/lib src/guest-room
                  cp ${./authd.ts} src/authd.ts
                  cp ${./lib/runtime.ts} src/lib/runtime.ts
                  cp ${./guest-room/mod.ts} src/guest-room/mod.ts
                  cp ${./guest-room/daemon.ts} src/guest-room/daemon.ts
                  cp ${./guest-room/protocol.ts} src/guest-room/protocol.ts
                  mkdir -p $out
                  cd src
                  HOME=$TMPDIR bun build authd.ts --target=bun --outfile=$out/authd.js
                '';

              authdEntrypoint = pkgs.writeShellScript "authd-entrypoint" ''
                exec bun /app/authd.js serve \
                  --socket /run/doors/authd.sock \
                  "$@"
              '';
            in
            pkgs.dockerTools.buildLayeredImage {
              name = "authd";
              tag = "dev";

              contents = [ authdEnv authdBundle ];

              extraCommands = ''
                mkdir -p app etc tmp run/doors keys
                cp ${authdBundle}/authd.js app/authd.js
                chmod 1777 tmp
                cat > etc/passwd <<EOF
                root:x:0:0:root:/root:/bin/bash
                authd:x:${toString uid}:${toString uid}:authd:/app:/bin/bash
                EOF
                cat > etc/group <<EOF
                root:x:0:
                authd:x:${toString uid}:
                EOF
              '';

              fakeRootCommands = ''
                chown -R ${toString uid}:${toString uid} run/doors keys
              '';

              config = {
                Entrypoint = [ "${authdEntrypoint}" ];
                WorkingDir = "/app";
                User = "authd";
                Env = [
                  "HOME=/app"
                  "PATH=/bin"
                  "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                  "LANG=C.UTF-8"
                ];
                Volumes = {
                  "/run/doors" = {};
                  "/keys" = {};
                };
              };
            };

          # claude-box-bundle — claude-box.ts bundled standalone (no image,
          # just the JS), for populating the `claude-box-bundle` podman
          # volume that remote-serve.container's ExecStartPre= reads from
          # (see quadlet/remote-serve.container and quadlet/setup-vm.sh).
          # Previously this volume was populated by hand-running `bun build
          # --target=bun` on whatever checkout happened to be open — this
          # package makes that step reproducible and pinned like every other
          # image here, instead of a manual, undocumented one-off.
          # Same source-tree + bundling approach as launcherd-image's own
          # internal bundle (claude-box.ts is launcherd.ts's biggest
          # dependency) — kept as a separate derivation rather than reusing
          # launcherd-image's internal `launcherdBundle` because that binding
          # is local to launcherd-image's own `let`, and this needs to be a
          # standalone, directly-buildable output.
          #   nix build .#claude-box-bundle   # ./result/claude-box.js
          claude-box-bundle = pkgs.runCommand "claude-box-bundle"
            { nativeBuildInputs = [ pkgs.bun ]; }
            ''
              mkdir -p src
              cp ${./claude-box.ts} src/claude-box.ts
              cp ${./door-interpose.ts} src/door-interpose.ts
              cp -r ${./contract} src/contract
              cp -r ${./guest-room} src/guest-room
              cp -r ${./lib} src/lib
              mkdir -p src/netd
              cp ${./netd/netd.ts} src/netd/netd.ts
              mkdir -p $out
              cd src
              HOME=$TMPDIR bun build claude-box.ts --target=bun --outfile=$out/claude-box.js
            '';

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

          # launcherd-rs — the launch+dispatch control-plane door, reimplemented
          # in Rust (ADR-DISPATCH-PATH-NAMESPACES). Built via pkgsStatic so the
          # output is a STATIC binary with no dynamic loader — the previous bun
          # implementation could not run on the VM (Fedora CoreOS has no JS
          # runtime, and the nix bun's ELF interpreter is absent there), which is
          # exactly what blocked "VM-native." A static musl binary runs on CoreOS
          # with zero runtime dependency. Increment #1 is the contract only (path
          # types + wire protocol); handlers + socket serving land incrementally,
          # with the bun launcherd staying live until parity.
          launcherd-rs = pkgs.pkgsStatic.rustPlatform.buildRustPackage {
            pname = "launcherd";
            version = "0.1.0";
            src = ./launcherd-rs;
            cargoLock.lockFile = ./launcherd-rs/Cargo.lock;
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
            launcherd-image = self.packages.aarch64-linux.launcherd-image;
            authd-image = self.packages.aarch64-linux.authd-image;
            claude-box-bundle = self.packages.aarch64-linux.claude-box-bundle;
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
                for f in mod.ts protocol.ts daemon.ts interpose.ts; do
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
          for f in mod.ts protocol.ts daemon.ts interpose.ts; do
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
