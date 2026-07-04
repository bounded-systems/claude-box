//! launcherd — the launch + dispatch control-plane door for claude-box.
//!
//! This crate is the Rust reimplementation of `launcherd.ts`, adopted in
//! `ADR-DISPATCH-PATH-NAMESPACES.md` so launcherd can run **VM-native** as a
//! static binary (the VM has no JS runtime for the previous bun implementation)
//! and so the path-namespace contract is enforced by *types* rather than
//! comments — see [`path`].
//!
//! It lands contract-first and incrementally: this module set is increment #1,
//! the executable contract (path types + wire protocol) with the handlers to
//! follow. The bun `launcherd.ts` stays the live daemon until parity is proven.
//!
//! Module map:
//! - [`path`] — `HostPath` / `InBoxPath`: a wrong-namespace bind-mount source
//!   is a compile error (the ADR's core invariant, as types).
//! - [`protocol`] — the NDJSON RPC surface as `serde` types (`dispatch`, and
//!   the launch-lane methods to come), with a closed [`protocol::ErrorCode`]
//!   set.

pub mod path;
pub mod protocol;

pub use path::{bind_mount, DoorSocket, HostPath, InBoxPath};
pub use protocol::{Caller, DispatchParams, ErrorCode, Request, Response, RpcError};
