//! launcherd binary entry point (dispatch lane).
//!
//! Resolves config from an **explicit** environment (never ambient `$HOME`),
//! runs the ADR boot assertion (every door host path that could become a
//! `podman -v` source must exist now, or exit with a named error), then serves
//! `dispatch.sock`. The launch/list/attach/kill lane (`launcherd.sock`) is a
//! later increment; until full parity the bun `launcherd.ts` remains live.

use std::process::ExitCode;

use launcherd::dispatch::{Env, SystemClock};
use launcherd::{doors, serve};

/// Explicit host doors directory — never inferred from `$HOME` (the coupling
/// that made the bun daemon resolve doors from the wrong place; see the ADR).
fn doors_dir() -> Result<String, String> {
    std::env::var("CLAUDE_BOX_DOORS_DIR").map_err(|_| {
        "CLAUDE_BOX_DOORS_DIR is required (the host doors directory, e.g. \
         /var/home/core/.claude-box/run) — launcherd will not guess it from $HOME"
            .to_string()
    })
}

/// Where per-dispatch boot scripts are written. Defaults to the doors dir (a
/// path launcherd and the podman server both see identically, VM-native).
fn work_dir(doors_dir: &str) -> String {
    std::env::var("CLAUDE_BOX_WORK_DIR").unwrap_or_else(|_| doors_dir.to_string())
}

/// `DISPATCH_SOCK`, defaulting to `<doors-dir>/dispatch.sock`.
fn dispatch_sock(doors_dir: &str) -> String {
    std::env::var("DISPATCH_SOCK").unwrap_or_else(|_| format!("{doors_dir}/dispatch.sock"))
}

/// The ADR boot assertion: every door host path must be stat-able now.
fn assert_doors_present(dir: &str) -> Result<(), String> {
    let table = doors::all(dir);
    let missing: Vec<String> = table
        .iter()
        .filter(|d| !d.host.exists())
        .map(|d| format!("{} ({})", d.name, d.host))
        .collect();
    if missing.is_empty() {
        eprintln!("launcherd: doors dir {dir} OK ({} door sockets present)", table.len());
        Ok(())
    } else {
        Err(format!(
            "door host paths not present: {} — is CLAUDE_BOX_DOORS_DIR correct and are the \
             door daemons up? launcherd refuses to start rather than pass a non-existent path \
             as a podman -v source.",
            missing.join(", ")
        ))
    }
}

fn run() -> Result<(), String> {
    let dir = doors_dir()?;
    assert_doors_present(&dir)?;
    let env = Env {
        doors_dir: dir.clone(),
        work_dir: work_dir(&dir),
    };
    let sock = dispatch_sock(&dir);
    serve::serve_dispatch(&sock, &env, &SystemClock)
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("launcherd: {e}");
            ExitCode::FAILURE
        }
    }
}
