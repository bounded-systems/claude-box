//! The `dispatch` handler — the one method served on `dispatch.sock`.
//!
//! Doors-blind and allow-list-only: params are just `{room, label}`. Validate
//! the room against the allow-list, apply the non-permissive rate/concurrency
//! limits, resolve + reachability-check the room's doors (room doors + net +
//! auth), then spawn an independent RC box that shows up as its own session in
//! the Claude app. No `LaunchRecord`, no attach/kill/list relationship — "not
//! really even a child."

use crate::doors;
use crate::id::{generate_launch_id, sanitize_label};
use crate::limits::{Decision, Limits};
use crate::path::HostPath;
use crate::protocol::{DispatchParams, ErrorCode, Response};
use crate::rooms;
use crate::spawn::{self, SpawnPlan};

/// Config the handler needs from the environment, resolved once at startup.
pub struct Env {
    /// Explicit host doors directory (never `$HOME`-derived).
    pub doors_dir: String,
    /// Where to write per-dispatch boot scripts (a dir launcherd + the podman
    /// server both see at the same path — VM-native, so any host tmp dir works).
    pub work_dir: String,
}

/// Clock + urandom are real syscalls; injected as a small trait so the handler
/// logic stays testable. Production uses [`SystemClock`].
pub trait Clock {
    fn now_secs(&self) -> u64;
}

pub struct SystemClock;
impl Clock for SystemClock {
    fn now_secs(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }
}

/// Handle one dispatch request. `id` is the request correlation id echoed back.
/// `limits` is shared, mutable serving state. Returns the response to write.
pub fn handle(
    id: &str,
    params: serde_json::Value,
    env: &Env,
    limits: &mut Limits,
    clock: &dyn Clock,
) -> Response {
    let p: DispatchParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(e) => return Response::err(id, ErrorCode::BadRequest, format!("bad dispatch params: {e}")),
    };
    let label = sanitize_label(p.label.as_deref());

    let room = match rooms::dispatchable(&p.room) {
        Some(r) => r,
        None => {
            return Response::err(
                id,
                ErrorCode::RoomNotDispatchable,
                format!("room '{}' is not dispatchable. Available: {}", p.room, rooms::available()),
            )
        }
    };

    // Non-permissive limits (checked before any spawn; recorded only on success).
    let now = clock.now_secs();
    match limits.check(now) {
        Decision::Allow => {}
        Decision::ConcurrentLimited => {
            return Response::err(
                id,
                ErrorCode::RateLimited,
                format!("dispatch concurrent limit exceeded (max {})", crate::limits::MAX_CONCURRENT),
            )
        }
        Decision::RateLimited { retry_after_secs } => {
            return Response::err(
                id,
                ErrorCode::RateLimited,
                format!(
                    "dispatch rate limit exceeded ({} per {}s). Try again in {}s",
                    crate::limits::RATE_MAX,
                    crate::limits::RATE_WINDOW_SECS,
                    retry_after_secs
                ),
            )
        }
    }

    // Resolve the room's doors (+ net + auth) into typed sockets.
    let specs = room.door_specs();
    let door_socks = match doors::resolve_all(&env.doors_dir, &specs) {
        Ok(d) => d,
        Err(e) => return Response::err(id, ErrorCode::SpawnFailed, e),
    };

    // Reachability: every host path must exist now (the boot assertion, per
    // spawn). Types already guarantee they're host-namespace paths.
    let missing: Vec<String> = door_socks
        .iter()
        .filter(|d| !d.host.exists())
        .map(|d| d.name.clone())
        .collect();
    if !missing.is_empty() {
        return Response::err(
            id,
            ErrorCode::DoorsUnreachable,
            format!("doors not reachable: {}. Start the daemons first.", missing.join(", ")),
        );
    }

    let launch_id = generate_launch_id(label.as_deref());

    // Mint this box's own grant (audience = its launch id) and render the boot
    // script — both via the proven bundle (see spawn.rs).
    let grant_b64 = match spawn::mint_grant(&launch_id) {
        Ok(g) => g,
        Err(e) => return Response::err(id, ErrorCode::SpawnFailed, e),
    };
    let script = match spawn::boot_script() {
        Ok(s) => s,
        Err(e) => return Response::err(id, ErrorCode::SpawnFailed, e),
    };
    let boot_path = format!("{}/boot-{}.sh", env.work_dir, launch_id);
    if let Err(e) = write_boot_script(&boot_path, &script) {
        return Response::err(id, ErrorCode::SpawnFailed, e);
    }
    // The signed grant goes to a 0600 env-FILE, passed via `--env-file` — NOT
    // `-e CLAUDE_BOX_RC_GRANT=…` on the argv, which would land the grant in the
    // worker's systemd-run unit command line (visible in `systemctl`/journald).
    let grant_path = format!("{}/grant-{}.env", env.work_dir, launch_id);
    if let Err(e) = write_grant_file(&grant_path, &grant_b64) {
        return Response::err(id, ErrorCode::SpawnFailed, e);
    }

    let plan = SpawnPlan {
        launch_id: launch_id.clone(),
        label,
        doors: door_socks,
        boot_script: HostPath::new(&boot_path),
        grant_env_file: HostPath::new(&grant_path),
    };

    match run_box(&plan) {
        Ok(()) => {
            limits.record(now);
            Response::ok(id, serde_json::json!({ "dispatched": true, "name": launch_id }))
        }
        Err(e) => Response::err(id, ErrorCode::SpawnFailed, e),
    }
}

fn write_boot_script(path: &str, script: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, script).map_err(|e| format!("write boot script {path}: {e}"))?;
    // Readable by the container (mounted ro); 0644 is fine.
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644))
        .map_err(|e| format!("chmod boot script {path}: {e}"))?;
    Ok(())
}

/// Write the grant env-file (`CLAUDE_BOX_RC_GRANT=<b64>`) at 0600 — podman reads
/// it host-side for `--env-file`, so the grant never appears on any argv. Owner
/// is the launcherd (core) user, which is also who podman runs as.
fn write_grant_file(path: &str, grant_b64: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, format!("CLAUDE_BOX_RC_GRANT={grant_b64}\n"))
        .map_err(|e| format!("write grant file {path}: {e}"))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("chmod grant file {path}: {e}"))?;
    Ok(())
}

/// Shell-quote one argument (single-quote wrap, escape embedded quotes) so a
/// podman argv can be embedded in a `/bin/sh -c` string without word-splitting.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Launch the box as its OWN transient systemd user unit, INDEPENDENT of
/// launcherd. `systemd-run --user` registers a `Type=simple` service whose
/// ExecStart is `printf 'y\n' | podman run -i …` — foreground (so RC actually
/// registers, unlike `-d`; see `spawn::podman_run_argv`) with the one-time y/n
/// confirmation piped in, exactly as the proven prototype and the bastion do.
///
/// Because the box is its own systemd unit (not a child of launcherd), it
/// survives a launcherd restart — the "not really even a child" independence the
/// dispatch design wants. `--collect` cleans the unit up when the box exits.
/// `systemd-run` returns immediately once the transient unit is started, so the
/// serve loop is free for the next dispatch.
fn run_box(plan: &SpawnPlan) -> Result<(), String> {
    use std::process::Command;
    let argv = spawn::podman_run_argv(plan);
    let podman = argv
        .iter()
        .map(|a| shell_quote(a))
        .collect::<Vec<_>>()
        .join(" ");
    // `printf 'y\n'` answers the one-time "Enable Remote Control? (y/n)".
    let cmd = format!("printf 'y\\n' | {podman}");
    // launch_id is already sanitized to [a-z0-9_.-]; safe as a systemd unit name.
    let unit = format!("--unit=claude-box-worker-{}", plan.launch_id);

    let out = Command::new("systemd-run")
        .args(["--user", "--collect", &unit, "/bin/sh", "-c", &cmd])
        .output()
        .map_err(|e| format!("systemd-run: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "systemd-run exit {:?}: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FixedClock(u64);
    impl Clock for FixedClock {
        fn now_secs(&self) -> u64 {
            self.0
        }
    }

    fn env() -> Env {
        Env {
            doors_dir: "/nonexistent-doors-dir".into(),
            work_dir: "/tmp".into(),
        }
    }

    #[test]
    fn non_dispatchable_room_refused_before_any_spawn() {
        let mut limits = Limits::new();
        let r = handle(
            "1",
            serde_json::json!({ "room": "dev-spawn", "label": "x" }),
            &env(),
            &mut limits,
            &FixedClock(1000),
        );
        assert!(!r.ok);
        assert_eq!(r.error.unwrap().code, ErrorCode::RoomNotDispatchable);
        // Refused pre-spawn → budget untouched.
        assert_eq!(limits.active(), 0);
    }

    #[test]
    fn bad_params_are_bad_request() {
        let mut limits = Limits::new();
        let r = handle("1", serde_json::json!({ "not_room": 1 }), &env(), &mut limits, &FixedClock(1000));
        assert_eq!(r.error.unwrap().code, ErrorCode::BadRequest);
    }

    #[test]
    fn dispatchable_room_with_missing_doors_reports_unreachable() {
        // doors_dir is nonexistent → host sockets don't exist → DOORS_UNREACHABLE,
        // caught before mint/spawn (which would need real podman).
        let mut limits = Limits::new();
        let r = handle(
            "1",
            serde_json::json!({ "room": "offline", "label": "t" }),
            &env(),
            &mut limits,
            &FixedClock(1000),
        );
        assert_eq!(r.error.unwrap().code, ErrorCode::DoorsUnreachable);
    }

    #[test]
    fn concurrency_limit_refuses_without_touching_doors() {
        let mut limits = Limits::new();
        for _ in 0..crate::limits::MAX_CONCURRENT {
            limits.record(1000);
        }
        let r = handle(
            "1",
            serde_json::json!({ "room": "dev", "label": "t" }),
            &env(),
            &mut limits,
            &FixedClock(1000),
        );
        assert_eq!(r.error.unwrap().code, ErrorCode::RateLimited);
    }
}
