//! Door name → typed [`DoorSocket`] resolution.
//!
//! One place maps a door *name* (`keeper`, `net`, …) to its daemon socket
//! filename + env var, so the boot assertion and the dispatch spawn can't
//! disagree about where a door lives. Host paths are built from an explicit
//! doors directory (never `$HOME`); in-box paths are the fixed `/run/doors/…`
//! the spawned box sees.

use crate::path::{DoorSocket, HostPath, InBoxPath};

/// (door name, daemon socket filename, in-box env var). Mirrors the door
/// presets in `claude-box.ts`.
const DOORS: &[(&str, &str, &str)] = &[
    ("keeper", "keeperd.sock", "KEEPERD_SOCK"),
    ("net", "netd.sock", "NETD_SOCK"),
    ("scout", "scoutd.sock", "SCOUTD_SOCK"),
    ("auth", "authd.sock", "AUTHD_SOCK"),
];

/// Resolve one door name against a host doors directory. `None` if the name
/// isn't a known door.
pub fn resolve(dir: &str, name: &str) -> Option<DoorSocket> {
    DOORS.iter().find(|(n, _, _)| *n == name).map(|(n, file, env)| DoorSocket {
        name: (*n).to_string(),
        host: HostPath::new(format!("{dir}/{file}")),
        in_box: InBoxPath::new(format!("/run/doors/{file}")),
        env: (*env).to_string(),
    })
}

/// Resolve a set of door names. Unknown names are collected and returned as an
/// error (they indicate a bug in the room table, not user input).
pub fn resolve_all(dir: &str, names: &[&str]) -> Result<Vec<DoorSocket>, String> {
    let mut out = Vec::with_capacity(names.len());
    let mut unknown = Vec::new();
    for &n in names {
        match resolve(dir, n) {
            Some(d) => out.push(d),
            None => unknown.push(n),
        }
    }
    if unknown.is_empty() {
        Ok(out)
    } else {
        Err(format!("unknown door(s): {}", unknown.join(", ")))
    }
}

/// The full door table (every known door) for the boot assertion.
pub fn all(dir: &str) -> Vec<DoorSocket> {
    DOORS.iter().filter_map(|(n, _, _)| resolve(dir, n)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_known_doors_into_both_namespaces() {
        let d = resolve("/var/home/core/.claude-box/run", "keeper").unwrap();
        assert_eq!(d.host.to_string(), "/var/home/core/.claude-box/run/keeperd.sock");
        assert_eq!(d.in_box.to_string(), "/run/doors/keeperd.sock");
        assert_eq!(d.env, "KEEPERD_SOCK");
    }

    #[test]
    fn unknown_door_is_none() {
        assert!(resolve("/d", "launcher").is_none());
        assert!(resolve("/d", "bogus").is_none());
    }

    #[test]
    fn resolve_all_reports_unknowns() {
        assert!(resolve_all("/d", &["net", "auth"]).is_ok());
        assert!(resolve_all("/d", &["net", "nope"]).is_err());
    }
}
