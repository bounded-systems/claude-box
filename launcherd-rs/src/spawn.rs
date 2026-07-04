//! Spawning a dispatched box.
//!
//! A dispatched box is "just another sibling bastion that happens to have been
//! requested rather than started by hand" (`launcherd.ts`). So it runs the same
//! shape `remote-serve.container` does — `sh /rc-boot.sh remote-control --spawn
//! session --name <label>` on `localhost/claude-personal:dev`, with the door
//! sockets bind-mounted and its own leased RC credential — just with a
//! per-dispatch container name and no Quadlet unit.
//!
//! Split in two, deliberately:
//! - [`podman_run_argv`] is **pure**: it builds the `podman run` argument vector
//!   from a fully-resolved [`SpawnPlan`]. This is where the ADR's type contract
//!   pays off — every door bind-mount source is a [`HostPath`], so a
//!   wrong-namespace `-v` source cannot be constructed here.
//! - [`mint_grant`] / [`boot_script`] shell out to the already-proven
//!   `claude-box` bundle (ed25519 grant signing + the RC boot script) via
//!   `podman run`, the exact mechanism `remote-serve.container`'s ExecStartPre
//!   uses. Reimplementing the crypto/boot-script in Rust is a later increment;
//!   the control plane (validate, limit, name, mount, spawn) is Rust now.
//!
//! ## KNOWN BLOCKER — RC registration 405 through netd (LOUD, unresolved)
//!
//! Verified live: a dispatched box now spawns confined, reaches its doors,
//! leases its credential, authenticates, and *attempts* RC session
//! registration — then fails with `Registration: Failed with status 405`.
//! Root cause is NOT security posture and NOT dispatch-specific plumbing: the
//! RC client registers via `POST https://api.anthropic.com/v1/environments/
//! bridge` as a **non-CONNECT** proxied request, and `netd` is a CONNECT-only
//! allowlist proxy — it tunnels TLS and, by design, REFUSES to forward
//! plaintext non-CONNECT requests (`netd … DENY non-CONNECT POST …/bridge`),
//! which the client surfaces as 405.
//!
//! The two ways forward, per the "always more secure; if not, name the
//! shortcoming + risk + research" rule:
//!   1. MORE SECURE (preferred): keep netd CONNECT-only and find how to make the
//!      RC bridge use CONNECT (or a route that doesn't need netd to forward a
//!      bare POST). Needs research into the `tengu_ccr_bridge` transport.
//!   2. SHORTCUT (a real weakening — do NOT take silently): teach netd to
//!      forward non-CONNECT POSTs to allow-listed hosts. RISK: netd would then
//!      proxy plaintext application requests (seeing/forwarding bodies), not
//!      just blind-tunnel TLS — eroding the "netd never sees cleartext" property
//!      that makes it a trustworthy egress boundary. If ever taken, it must be
//!      scoped to the exact RC bridge host+path and documented as such.
//!   OPEN QUESTION: does the live bastion hit the same 405? If so this is a
//!   pre-existing, system-wide RC-through-netd gap (the "claude-box" app entry
//!   may never have fully registered), not something dispatch introduced.

use std::process::Command;

use crate::path::{bind_mount, DoorSocket, HostPath, InBoxPath};

/// The RC guest image (same as the bastion).
pub const IMAGE: &str = "localhost/claude-personal:dev";
/// Volume holding the bundled `claude-box.js` (see `remote-serve.container`).
pub const BUNDLE_VOLUME: &str = "claude-box-bundle";
/// Volume holding the issuer keypair used to sign auth grants.
pub const ISSUER_KEYS_VOLUME: &str = "claude-box-issuer-keys";
/// Image with `bun` on PATH, reused to run the bundle (not semantically the
/// "right" image, just one that already has bun — same as the bastion's ExecStartPre).
pub const BUNDLE_RUNNER_IMAGE: &str = "localhost/authd:dev";

/// Everything needed to render the `podman run` for a dispatched box, all paths
/// already in their correct namespaces.
pub struct SpawnPlan {
    /// Container name = launch id, e.g. `box-hooksmith-abc12`.
    pub launch_id: String,
    /// Human RC session title (the sanitized label), shown in the app. `None`
    /// falls back to the launch id.
    pub label: Option<String>,
    /// Door sockets to mount, host→in-box, in their correct namespaces.
    pub doors: Vec<DoorSocket>,
    /// The generated RC boot script, written to this host path and bind-mounted
    /// read-only at `/rc-boot.sh`.
    pub boot_script: HostPath,
    /// The freshly-minted, base64 auth grant for this box (audience = launch id).
    pub grant_b64: String,
}

/// Build the `podman run` argv for a dispatched box. Pure — no I/O.
///
/// Mirrors `remote-serve.container` field-for-field, minus the Quadlet wrapping:
/// detached, `-i` + stdin `y\n` for the one-time RC confirmation, the netd
/// loopback proxy env, a throwaway tmpfs config dir, the doors mounted, the boot
/// script mounted, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` unset so the RC
/// feature-flag gate can evaluate.
pub fn podman_run_argv(plan: &SpawnPlan) -> Vec<String> {
    // Owned-string arg vector; `p` pushes literals, `a.push` pushes computed ones.
    fn p(a: &mut Vec<String>, s: &str) {
        a.push(s.to_string());
    }
    let a = &mut Vec::<String>::new();

    p(a, "podman");
    p(a, "run");
    p(a, "-d"); // detached — the app attaches over claude.ai/code, no local tty
    p(a, "-i"); // stdin for the one-time "Enable Remote Control? (y/n)"
    p(a, "--rm");
    p(a, "--name");
    a.push(plan.launch_id.clone());

    // Same rootless uid mapping every door daemon + the bastion share, so the
    // mounted door sockets are actually reachable (see keeperd.container).
    p(a, "--userns");
    p(a, "keep-id:uid=1000,gid=1000");

    // Security floor (same as the bastion / every box).
    p(a, "--security-opt");
    p(a, "no-new-privileges");
    p(a, "--cap-drop");
    p(a, "all");
    p(a, "--pids-limit");
    p(a, "2048");

    // RC needs the feature-flag gate to evaluate → the image's baked
    // CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC must be unset.
    p(a, "--unsetenv");
    p(a, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC");

    // Egress goes through the in-box netd relay the boot script starts.
    for kv in [
        "HTTPS_PROXY=http://127.0.0.1:3128",
        "HTTP_PROXY=http://127.0.0.1:3128",
        "ALL_PROXY=http://127.0.0.1:3128",
        "NO_PROXY=localhost,127.0.0.1",
    ] {
        p(a, "-e");
        p(a, kv);
    }

    // The auth door socket (the boot script's lease step connects here).
    p(a, "-e");
    p(a, "AUTHD_SOCK=/run/doors/authd.sock");

    // The per-box grant the boot script decodes to lease its credential.
    p(a, "-e");
    a.push(format!("CLAUDE_BOX_RC_GRANT={}", plan.grant_b64));

    // The doors themselves — THIS is the ADR payoff: each source is a HostPath,
    // each dest an InBoxPath, and DoorSocket.mount_arg() is the only way to form
    // the pair. A wrong-namespace source can't be typed here.
    //
    // SECURITY POSTURE — deliberately MORE secure than the rest of the fleet.
    // The door sockets live under the user's home, so they carry `user_home_t`,
    // which a confined `container_t` box cannot read (verified live: bare mounts
    // showed `-?????????` / permission denied). The whole existing fleet
    // (keeperd/netd/.../remote-serve) sidesteps this with
    // `SecurityLabelDisable=true` — i.e. it turns SELinux confinement OFF for
    // the container. We do NOT do that here. Instead each door mount gets `:z`,
    // which relabels the source to the SHARED `container_file_t:s0` a confined
    // box can read, while the box itself stays fully confined (`container_t`
    // with its own MCS categories). Net: a dispatched box reaches exactly its
    // granted doors AND keeps SELinux confinement — strictly stronger isolation
    // than the label-disabled bastion. `:z` (shared) not `:Z` (private) because
    // door sockets are shared services many boxes mount; a private label would
    // lock a socket to one box and break the others.
    for d in &plan.doors {
        p(a, "-v");
        a.push(format!("{}:z", d.mount_arg()));
        p(a, "-e");
        a.push(format!("{}={}", d.env, d.in_box));
    }

    // Throwaway config dir — the credential is leased, never persisted.
    p(a, "--tmpfs");
    p(a, "/home/claude/.config/claude:rw,mode=1777");

    // The generated boot script, host→in-box, read-only + `:z` (same reasoning
    // as the doors — it's host-written so it carries `user_home_t`; without the
    // relabel a confined box gets `sh: /rc-boot.sh: Permission denied`).
    p(a, "-v");
    a.push(format!("{}:ro,z", bind_mount(&plan.boot_script, &InBoxPath::new("/rc-boot.sh"))));

    p(a, "--entrypoint");
    p(a, "sh");
    a.push(IMAGE.to_string());

    // The RC invocation. NOTE: no leading "claude-box" positional — `sh
    // /rc-boot.sh <args>` makes the script $0 and everything after "$@" (the
    // exact bug fixed in remote-serve.container). `--name <label>` is the
    // app-visible session title.
    p(a, "/rc-boot.sh");
    p(a, "remote-control");
    p(a, "--name");
    a.push(plan.label.clone().unwrap_or_else(|| plan.launch_id.clone()));
    p(a, "--remote-control-session-name-prefix");
    p(a, "claude-box");
    p(a, "--spawn");
    p(a, "session");

    std::mem::take(a)
}

/// The stdin fed to the spawned box: the fixed, non-secret `y\n` answering the
/// one-time "Enable Remote Control?" prompt.
pub const RC_CONFIRM_STDIN: &[u8] = b"y\n";

/// Mint a fresh base64 auth grant scoped to `audience` (the box's launch id),
/// by running the bundled `claude-box internal-mint-auth-grant` in a throwaway
/// container. CRITICAL: `--log-driver=none` so the grant is never captured by
/// journald (the leak that happened once during this project's setup).
pub fn mint_grant(audience: &str) -> Result<String, String> {
    let out = Command::new("podman")
        .args([
            "run", "--rm", "--log-driver=none",
            "--userns", "keep-id:uid=1000,gid=1000",
            "-v", &format!("{ISSUER_KEYS_VOLUME}:/keys:ro"),
            "-v", &format!("{BUNDLE_VOLUME}:/app:ro"),
            "-e", "HOME=/tmp",
            "--entrypoint", "sh", BUNDLE_RUNNER_IMAGE,
            "-c",
            &format!(
                "mkdir -p /tmp/.config/claude-box && cp /keys/issuer.key.pem /keys/issuer.pub.json /tmp/.config/claude-box/ && \
                 bun /app/claude-box.js internal-mint-auth-grant --audience {audience}"
            ),
        ])
        .output()
        .map_err(|e| format!("mint_grant: spawn podman: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "mint_grant: podman exit {:?}: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let grant = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if grant.is_empty() {
        return Err("mint_grant: empty grant".into());
    }
    Ok(grant)
}

/// Render the RC boot script (netd relay + auth lease + trust dialog + exec
/// claude) via the bundle's `internal-print-rc-boot-script`. Deterministic
/// across boxes (the per-box grant comes in via env), so callers may cache it.
pub fn boot_script() -> Result<String, String> {
    let out = Command::new("podman")
        .args([
            "run", "--rm",
            "-v", &format!("{BUNDLE_VOLUME}:/app:ro"),
            "--entrypoint", "bun", BUNDLE_RUNNER_IMAGE,
            "/app/claude-box.js", "internal-print-rc-boot-script",
        ])
        .output()
        .map_err(|e| format!("boot_script: spawn podman: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "boot_script: podman exit {:?}: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let script = String::from_utf8_lossy(&out.stdout).to_string();
    if script.trim().is_empty() {
        return Err("boot_script: empty script".into());
    }
    Ok(script)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> SpawnPlan {
        SpawnPlan {
            launch_id: "box-hooksmith-abc123".into(),
            label: Some("hooksmith".into()),
            doors: vec![
                DoorSocket {
                    name: "net".into(),
                    host: HostPath::new("/var/home/core/.claude-box/run/netd.sock"),
                    in_box: InBoxPath::new("/run/doors/netd.sock"),
                    env: "NETD_SOCK".into(),
                },
                DoorSocket {
                    name: "auth".into(),
                    host: HostPath::new("/var/home/core/.claude-box/run/authd.sock"),
                    in_box: InBoxPath::new("/run/doors/authd.sock"),
                    env: "AUTHD_SOCK".into(),
                },
            ],
            boot_script: HostPath::new("/var/home/core/.claude-box/run/boot-box-hooksmith-abc123.sh"),
            grant_b64: "GRANTB64".into(),
        }
    }

    fn argv() -> Vec<String> {
        podman_run_argv(&plan())
    }

    fn window<'a>(a: &'a [String], first: &str, second: &str) -> bool {
        a.windows(2).any(|w| w[0] == first && w[1] == second)
    }

    #[test]
    fn detached_named_after_launch_id() {
        let a = argv();
        assert!(a.contains(&"-d".to_string()));
        assert!(window(&a, "--name", "box-hooksmith-abc123"));
    }

    #[test]
    fn door_bind_mounts_are_host_to_in_box_with_z_relabel() {
        let a = argv();
        // `:z` keeps the box SELinux-confined while letting it read the
        // user_home_t door sockets (see the security-posture comment).
        assert!(window(&a, "-v", "/var/home/core/.claude-box/run/netd.sock:/run/doors/netd.sock:z"));
        assert!(window(&a, "-v", "/var/home/core/.claude-box/run/authd.sock:/run/doors/authd.sock:z"));
        // door env vars point at the in-box path (no :z on the env value)
        assert!(window(&a, "-e", "NETD_SOCK=/run/doors/netd.sock"));
        assert!(window(&a, "-e", "AUTHD_SOCK=/run/doors/authd.sock"));
    }

    #[test]
    fn no_security_label_disable() {
        // The box must stay confined — never `--security-opt label=disable`
        // (the fleet-wide shortcut we deliberately do NOT take here).
        let a = argv();
        assert!(!a.iter().any(|s| s.contains("label=disable")));
    }

    #[test]
    fn boot_script_mounted_readonly_with_z_relabel() {
        let a = argv();
        assert!(window(
            &a, "-v",
            "/var/home/core/.claude-box/run/boot-box-hooksmith-abc123.sh:/rc-boot.sh:ro,z"
        ));
    }

    #[test]
    fn rc_invocation_has_label_and_session_spawn_no_leading_positional() {
        let a = argv();
        // entrypoint sh; script is the FIRST arg (no "claude-box" before it)
        let sh_i = a.iter().position(|s| s == "sh").unwrap();
        assert_eq!(a[sh_i - 1], "--entrypoint");
        // after the image, the very next arg is the script path
        let img_i = a.iter().position(|s| s == IMAGE).unwrap();
        assert_eq!(a[img_i + 1], "/rc-boot.sh");
        assert_eq!(a[img_i + 2], "remote-control");
        assert!(window(&a, "--name", "hooksmith"));
        assert!(window(&a, "--spawn", "session"));
        assert!(window(&a, "--remote-control-session-name-prefix", "claude-box"));
    }

    #[test]
    fn grant_and_traffic_flag_present() {
        let a = argv();
        assert!(window(&a, "-e", "CLAUDE_BOX_RC_GRANT=GRANTB64"));
        assert!(window(&a, "--unsetenv", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"));
    }

    #[test]
    fn label_falls_back_to_launch_id() {
        let mut p = plan();
        p.label = None;
        let a = podman_run_argv(&p);
        // --name (session title) uses the launch id when no label
        assert!(window(&a, "--name", "box-hooksmith-abc123"));
    }
}
