//! Door name → typed [`DoorSocket`] resolution.
//!
//! One place maps a door *name* (`keeper`, `net`, …) to its daemon socket
//! filename + env var, so the boot assertion and the dispatch spawn can't
//! disagree about where a door lives. Host paths are built from an explicit
//! doors directory (never `$HOME`); in-box paths are the fixed `/run/doors/…`
//! the spawned box sees.

use crate::path::{DoorSocket, HostPath, InBoxPath};

/// (door name, daemon socket filename, in-box env var, boot_required). Mirrors
/// the door presets in `claude-box.ts`.
///
/// `boot_required` marks a door as part of the always-on **core** fleet that
/// [`boot_required`] asserts present before launcherd-rs will serve. A non-core
/// door (e.g. `beads`, used only by the `planning` room) is still fully
/// resolvable for dispatch — but launcher startup does NOT hinge on it, so a
/// beadsd outage fails only `planning` (cleanly, at dispatch time, via
/// [`resolve_all`] + the reachability check in `dispatch`), never the whole
/// dispatch lane. Capability-scoped degradation, not all-or-nothing.
const DOORS: &[(&str, &str, &str, bool)] = &[
    ("keeper", "keeperd.sock", "KEEPERD_SOCK", true),
    ("net", "netd.sock", "NETD_SOCK", true),
    ("scout", "scoutd.sock", "SCOUTD_SOCK", true),
    ("auth", "authd.sock", "AUTHD_SOCK", true),
    ("beads", "beadsd.sock", "BEADSD_SOCK", false),
];

/// Resolve one door name against a host doors directory. `None` if the name
/// isn't a known door. Searches the *full* table (core and non-core alike) —
/// resolvability is independent of whether a door gates boot.
pub fn resolve(dir: &str, name: &str) -> Option<DoorSocket> {
    DOORS.iter().find(|(n, _, _, _)| *n == name).map(|(n, file, env, _)| DoorSocket {
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

/// Every known door — for enumeration/introspection, NOT the boot gate.
pub fn all(dir: &str) -> Vec<DoorSocket> {
    DOORS.iter().filter_map(|(n, _, _, _)| resolve(dir, n)).collect()
}

/// The core doors whose host paths the boot assertion requires present before
/// launcherd-rs will serve. Excludes non-core doors (e.g. `beads`) so that a
/// single room's optional daemon can't block the whole dispatch lane at boot.
pub fn boot_required(dir: &str) -> Vec<DoorSocket> {
    DOORS
        .iter()
        .filter(|(_, _, _, req)| *req)
        .filter_map(|(n, _, _, _)| resolve(dir, n))
        .collect()
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
    fn resolves_beads_door() {
        // The beads door (beadsd) — required by the `planning` room. Its socket
        // must resolve or dispatch of `planning` fails with "unknown door(s): beads".
        let d = resolve("/var/home/core/.claude-box/run", "beads").unwrap();
        assert_eq!(d.host.to_string(), "/var/home/core/.claude-box/run/beadsd.sock");
        assert_eq!(d.in_box.to_string(), "/run/doors/beadsd.sock");
        assert_eq!(d.env, "BEADSD_SOCK");
    }

    #[test]
    fn beads_is_resolvable_but_not_boot_required() {
        // The decoupling invariant: beads resolves for dispatch (so `planning`
        // works), but is NOT in the boot gate — a beadsd outage must not stop
        // launcherd-rs from serving dev/readonly/offline dispatch.
        assert!(resolve("/d", "beads").is_some());
        let boot: Vec<String> = boot_required("/d").iter().map(|d| d.name.clone()).collect();
        assert!(!boot.contains(&"beads".to_string()), "beads must not gate boot");
        // The core fleet is exactly keeper/net/scout/auth.
        assert_eq!(boot, vec!["keeper", "net", "scout", "auth"]);
        // ...while `all` still enumerates beads alongside the core doors.
        let every: Vec<String> = all("/d").iter().map(|d| d.name.clone()).collect();
        assert!(every.contains(&"beads".to_string()));
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

    /// Parity with the declarative capability contract (contract/INVARIANTS.md).
    /// The contract's *mountable* doors must equal this `DOORS` table exactly
    /// (name, socket, env, bootRequired); its non-mountable control doors
    /// (launcher/dispatch) must NOT appear here. Drift → this test goes red.
    #[test]
    fn doors_match_the_capability_contract() {
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../../contract/capabilities.contract.json"))
                .expect("contract JSON parses");
        let doors = contract["doors"].as_array().expect("doors[] present");

        // Every mountable contract door ↔ a DOORS row with matching fields.
        for d in doors {
            let name = d["name"].as_str().unwrap();
            let mountable = d["mountable"].as_bool().unwrap();
            let row = DOORS.iter().find(|(n, _, _, _)| *n == name);
            if mountable {
                let (_, socket, env, boot) = row
                    .unwrap_or_else(|| panic!("contract mountable door {name} missing from DOORS"));
                assert_eq!(*socket, d["socket"].as_str().unwrap(), "{name} socket");
                assert_eq!(*env, d["env"].as_str().unwrap(), "{name} env");
                assert_eq!(*boot, d["bootRequired"].as_bool().unwrap(), "{name} bootRequired");
            } else {
                assert!(row.is_none(), "control door {name} must not be in DOORS");
            }
        }

        // ...and no DOORS row is absent from the contract (both directions).
        let mountable_names: Vec<&str> = doors
            .iter()
            .filter(|d| d["mountable"].as_bool().unwrap())
            .map(|d| d["name"].as_str().unwrap())
            .collect();
        for (n, _, _, _) in DOORS {
            assert!(mountable_names.contains(n), "DOORS door {n} missing from contract");
        }
    }
}
