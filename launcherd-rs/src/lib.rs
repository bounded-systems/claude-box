//! launcherd — the launch + dispatch control-plane door for claude-box.
//!
//! Rust reimplementation of `launcherd.ts`, adopted in
//! `ADR-DISPATCH-PATH-NAMESPACES.md` so launcherd runs **VM-native** as a static
//! binary (the VM has no JS runtime for the previous bun implementation) and so
//! the path-namespace contract is enforced by *types* rather than comments —
//! see [`path`].
//!
//! Lands contract-first and incrementally. The bun `launcherd.ts` stays the live
//! daemon until parity.
//!
//! Module map:
//! - [`path`] — `HostPath` / `InBoxPath`: a wrong-namespace bind-mount source is
//!   a compile error (the ADR's core invariant, as types).
//! - [`protocol`] — the NDJSON RPC surface as `serde` types + closed
//!   [`protocol::ErrorCode`].
//! - [`rooms`] — the dispatch allow-list (`dev`/`readonly`/`offline`).
//! - [`limits`] — non-permissive dispatch rate + concurrency ceilings.
//! - [`id`] — label sanitization + launch-id generation.
//! - [`doors`] — door name → typed [`path::DoorSocket`] resolution.
//! - [`spawn`] — the (pure) `podman run` argv builder + grant/boot-script
//!   orchestration.
//! - [`dispatch`] — the `dispatch` handler.
//! - [`serve`] — the `dispatch.sock` accept loop.

pub mod dispatch;
pub mod doors;
pub mod id;
pub mod limits;
pub mod path;
pub mod protocol;
pub mod rooms;
pub mod serve;
pub mod spawn;

pub use id::{generate_launch_id, sanitize_label};
pub use limits::{Decision, Limits};
pub use path::{bind_mount, DoorSocket, HostPath, InBoxPath};
pub use protocol::{Caller, DispatchParams, ErrorCode, Request, Response, RpcError};
pub use rooms::{dispatchable, Room};
