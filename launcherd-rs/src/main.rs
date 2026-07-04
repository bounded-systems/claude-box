//! launcherd binary entry point.
//!
//! Increment #1 (this commit) wires up only the contract: it parses the doors
//! directory, builds the door-socket table with correctly-typed host/in-box
//! paths, and runs the **boot assertion** the ADR requires — every path that
//! will ever be a `podman -v` source must exist on the host filesystem now, or
//! launcherd exits with a named error rather than failing silently at dispatch
//! time. Socket serving + the dispatch/launch handlers land in later
//! increments; until then the bun `launcherd.ts` remains the live daemon.

use std::process::ExitCode;

use launcherd::path::{DoorSocket, HostPath, InBoxPath};

/// The doors a spawned box mounts by name → daemon socket filename. Mirrors the
/// door presets in `claude-box.ts` (`keeper`→`keeperd.sock`, etc.).
const DOOR_SOCKETS: &[(&str, &str, &str)] = &[
    // (door name, socket filename, in-box env var)
    ("keeper", "keeperd.sock", "KEEPERD_SOCK"),
    ("net", "netd.sock", "NETD_SOCK"),
    ("scout", "scoutd.sock", "SCOUTD_SOCK"),
    ("auth", "authd.sock", "AUTHD_SOCK"),
];

/// Where door sockets physically live, from an **explicit** input — never
/// inferred from ambient `$HOME` (the coupling that made the bun daemon resolve
/// doors from the wrong place; see the ADR). Required, not defaulted.
fn doors_dir() -> Result<String, String> {
    std::env::var("CLAUDE_BOX_DOORS_DIR").map_err(|_| {
        "CLAUDE_BOX_DOORS_DIR is required (the host doors directory, e.g. \
         /var/home/core/.claude-box/run) — launcherd will not guess it from $HOME"
            .to_string()
    })
}

/// Build the door table with host + in-box paths in their correct namespaces.
fn door_table(dir: &str) -> Vec<DoorSocket> {
    DOOR_SOCKETS
        .iter()
        .map(|(name, file, env)| DoorSocket {
            name: (*name).to_string(),
            host: HostPath::new(format!("{dir}/{file}")),
            in_box: InBoxPath::new(format!("/run/doors/{file}")),
            env: (*env).to_string(),
        })
        .collect()
}

/// The ADR's boot assertion: every path that could become a `-v` source must be
/// stat-able on the host now. A namespace/config drift fails here, named, not
/// silently at spawn time. (Types guarantee the path is in the host namespace;
/// this guarantees it exists on *this* host.)
fn assert_doors_present(doors: &[DoorSocket]) -> Result<(), String> {
    let missing: Vec<String> = doors
        .iter()
        .filter(|d| !d.host.exists())
        .map(|d| format!("{} ({})", d.name, d.host))
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "door host paths not present on this host: {} — is CLAUDE_BOX_DOORS_DIR correct, \
             and are the door daemons up? launcherd refuses to start rather than pass a \
             non-existent path as a podman -v source.",
            missing.join(", ")
        ))
    }
}

fn run() -> Result<(), String> {
    let dir = doors_dir()?;
    let doors = door_table(&dir);
    assert_doors_present(&doors)?;
    eprintln!(
        "launcherd: doors dir {dir} OK ({} door sockets present)",
        doors.len()
    );
    // Socket serving + dispatch/launch handlers: later increments.
    eprintln!("launcherd: increment #1 — contract only; not yet serving. See ADR-DISPATCH-PATH-NAMESPACES.md.");
    Ok(())
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
