//! Room registry — the dispatch allow-list.
//!
//! `dispatch` accepts only a room *name* off this list (plus a label); it can
//! never name a door, repo, or escape flag (see `protocol::DispatchParams`).
//! Mirrors `launcherd.ts`'s `ROOMS`: exactly `dev`, `readonly`, `offline`, and
//! `planning` are dispatchable. `dev-spawn` (holds `launcher`) and `bootstrap`
//! (full egress) are deliberately absent, so a dispatched box structurally
//! cannot itself dispatch or spawn further.

/// A dispatchable room: its base door set. Every dispatched box additionally
/// gets `net` + `auth` (it runs its own RC server and leases its own
/// credential) — see [`Room::door_specs`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Room {
    pub name: &'static str,
    base_doors: &'static [&'static str],
}

/// The dispatchable rooms, and only these. A name not here → `RoomNotDispatchable`.
pub const DISPATCHABLE: &[Room] = &[
    Room {
        name: "dev",
        base_doors: &["keeper", "net", "scout"],
    },
    Room {
        name: "readonly",
        base_doors: &["net", "scout"],
    },
    Room {
        name: "offline",
        base_doors: &[],
    },
    // Plan a ticket into a beads epic — reads the work unit (scout/beads), writes
    // the plan (beads). No `keeper`: planning writes no code. See
    // ADR-DISPATCH-PLANNING-FROM-TICKET.
    Room {
        name: "planning",
        base_doors: &["scout", "beads"],
    },
];

/// Look up a dispatchable room by name. `None` for unknown OR non-dispatchable
/// names (`dev-spawn`, `bootstrap`, garbage) — the caller can't tell the
/// difference, and shouldn't: from dispatch's side they're equally refused.
pub fn dispatchable(name: &str) -> Option<Room> {
    DISPATCHABLE.iter().copied().find(|r| r.name == name)
}

/// Comma-separated dispatchable room names, for the refusal message.
pub fn available() -> String {
    DISPATCHABLE
        .iter()
        .map(|r| r.name)
        .collect::<Vec<_>>()
        .join(", ")
}

impl Room {
    /// The full door set for a dispatched box: the room's base doors plus
    /// `net` + `auth` (always), de-duplicated, order-stable. Mirrors
    /// `handleDispatch`'s `[...room.doors, "net", "auth"]` set.
    pub fn door_specs(&self) -> Vec<&'static str> {
        let mut out: Vec<&'static str> = self.base_doors.to_vec();
        for extra in ["net", "auth"] {
            if !out.contains(&extra) {
                out.push(extra);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_readonly_offline_planning_are_dispatchable() {
        assert!(dispatchable("dev").is_some());
        assert!(dispatchable("readonly").is_some());
        assert!(dispatchable("offline").is_some());
        assert!(dispatchable("planning").is_some());
    }

    #[test]
    fn dev_spawn_and_bootstrap_and_garbage_are_not() {
        assert!(dispatchable("dev-spawn").is_none());
        assert!(dispatchable("bootstrap").is_none());
        assert!(dispatchable("../etc/passwd").is_none());
        assert!(dispatchable("").is_none());
    }

    #[test]
    fn every_dispatched_box_gets_net_and_auth() {
        let dev = dispatchable("dev").unwrap();
        assert_eq!(dev.door_specs(), vec!["keeper", "net", "scout", "auth"]);
        let ro = dispatchable("readonly").unwrap();
        assert_eq!(ro.door_specs(), vec!["net", "scout", "auth"]);
        let off = dispatchable("offline").unwrap();
        assert_eq!(off.door_specs(), vec!["net", "auth"]);
    }

    #[test]
    fn planning_gets_scout_beads_plus_net_auth_but_no_keeper() {
        let plan = dispatchable("planning").unwrap();
        // scout + beads (read the ticket, write the plan), then net + auth.
        assert_eq!(plan.door_specs(), vec!["scout", "beads", "net", "auth"]);
        // planning writes no code — it must never carry the keeper (write) door.
        assert!(!plan.door_specs().contains(&"keeper"));
    }

    #[test]
    fn net_is_not_duplicated_when_room_already_has_it() {
        // readonly already has net; door_specs must not list it twice.
        let ro = dispatchable("readonly").unwrap();
        let nets = ro.door_specs().iter().filter(|d| **d == "net").count();
        assert_eq!(nets, 1);
    }

    /// Parity with the declarative capability contract (contract/INVARIANTS.md).
    /// The contract's *dispatchable* rooms must equal this `DISPATCHABLE` table
    /// exactly (name + base doors); its non-dispatchable rooms (dev-spawn,
    /// bootstrap) must NOT appear here. Drift → this test goes red.
    #[test]
    fn dispatchable_rooms_match_the_capability_contract() {
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../../contract/capabilities.contract.json"))
                .expect("contract JSON parses");
        let rooms = contract["rooms"].as_array().expect("rooms[] present");

        let mut contract_dispatchable = Vec::new();
        for r in rooms {
            let name = r["name"].as_str().unwrap();
            let is_dispatchable = r["dispatchable"].as_bool().unwrap();
            let found = dispatchable(name);
            if is_dispatchable {
                contract_dispatchable.push(name);
                let room = found
                    .unwrap_or_else(|| panic!("contract dispatchable room {name} missing"));
                let doors: Vec<&str> =
                    r["doors"].as_array().unwrap().iter().map(|d| d.as_str().unwrap()).collect();
                assert_eq!(room.base_doors, doors.as_slice(), "{name} base doors");
            } else {
                assert!(found.is_none(), "non-dispatchable room {name} must not be dispatchable");
            }
        }

        // ...and every DISPATCHABLE room is present-and-dispatchable in the contract.
        for r in DISPATCHABLE {
            assert!(
                contract_dispatchable.contains(&r.name),
                "DISPATCHABLE room {} missing from contract",
                r.name
            );
        }
    }
}
