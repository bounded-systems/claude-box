//! Path-namespace types — the load-bearing contract from
//! `ADR-DISPATCH-PATH-NAMESPACES.md`.
//!
//! A single door socket is referred to by paths in *different namespaces*, and
//! the whole class of dispatch bugs came from a bare `string` path silently
//! meaning "a path in *some* namespace." Here those namespaces are **distinct
//! types**, so the compiler enforces the one invariant that matters:
//!
//! > A `podman run -v SRC:DST` source is resolved by the podman **server**
//! > (the VM host), so `SRC` must be a [`HostPath`]. `DST` is a path inside the
//! > spawned box, an [`InBoxPath`]. They are not interchangeable.
//!
//! [`bind_mount`] takes `(HostPath, InBoxPath)` in that order. Passing an
//! `InBoxPath` as a source **does not compile** — bug #3 from the ADR becomes
//! structurally impossible rather than assertion-caught.

use std::fmt;
use std::path::{Path, PathBuf};

/// A path valid in the **VM-host** filesystem namespace — the namespace in
/// which the podman server resolves bind-mount *sources*. The only kind of
/// path that may be a `-v` source.
///
/// launcherd runs VM-native (see the ADR), so a `HostPath` is also exactly what
/// launcherd itself `connect()`s to and `stat()`s — there is a single host
/// namespace, not the three the containerized bun implementation had.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostPath(PathBuf);

/// A path valid **inside a spawned box's** mount namespace — a bind-mount
/// *destination* only. Boxes see their doors at `/run/doors/<daemon>.sock`
/// regardless of where those sockets physically live on the host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InBoxPath(PathBuf);

impl HostPath {
    pub fn new(p: impl Into<PathBuf>) -> Self {
        HostPath(p.into())
    }
    pub fn as_path(&self) -> &Path {
        &self.0
    }
    /// Does this source actually exist on the host filesystem right now? This is
    /// the runtime defense-in-depth the *types* can't provide: types guarantee
    /// the path is in the right namespace, `stat()` guarantees it exists on
    /// *this* host at spawn time. The ADR requires both — assert this before
    /// every spawn and at boot, failing loudly on a namespace/config drift.
    pub fn exists(&self) -> bool {
        self.0.exists()
    }
}

impl InBoxPath {
    pub fn new(p: impl Into<PathBuf>) -> Self {
        InBoxPath(p.into())
    }
    pub fn as_path(&self) -> &Path {
        &self.0
    }
}

impl fmt::Display for HostPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0.display())
    }
}

impl fmt::Display for InBoxPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0.display())
    }
}

/// Render a `podman run -v SRC:DST` mount argument. The signature is the
/// contract: `src` is a [`HostPath`], `dst` an [`InBoxPath`], and no other
/// combination type-checks. This is the single choke point through which every
/// door-socket mount must pass, so the namespace invariant cannot be bypassed
/// by hand-formatting a `-v` string elsewhere.
pub fn bind_mount(src: &HostPath, dst: &InBoxPath) -> String {
    format!("{}:{}", src, dst)
}

/// A door socket, in both namespaces at once: where it physically lives on the
/// host (for reachability + as the bind source) and where the spawned box will
/// see it (the bind destination). Pairing them in one value keeps the two paths
/// from drifting apart.
#[derive(Clone, Debug)]
pub struct DoorSocket {
    /// e.g. `"keeper"`, `"net"`, `"auth"` — the door name, not the daemon name.
    pub name: String,
    /// Physical host path, e.g. `/var/home/core/.claude-box/run/keeperd.sock`.
    pub host: HostPath,
    /// In-box mount point, e.g. `/run/doors/keeperd.sock`.
    pub in_box: InBoxPath,
    /// The env var the box reads to find this socket, e.g. `KEEPERD_SOCK`.
    pub env: String,
}

impl DoorSocket {
    /// The `-v` argument mounting this door into a spawned box. Type-correct by
    /// construction — `host` is a `HostPath`, `in_box` an `InBoxPath`.
    pub fn mount_arg(&self) -> String {
        bind_mount(&self.host, &self.in_box)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_mount_orders_host_then_in_box() {
        let src = HostPath::new("/var/home/core/.claude-box/run/keeperd.sock");
        let dst = InBoxPath::new("/run/doors/keeperd.sock");
        assert_eq!(
            bind_mount(&src, &dst),
            "/var/home/core/.claude-box/run/keeperd.sock:/run/doors/keeperd.sock"
        );
        // The whole point: `bind_mount(&dst, &src)` does not compile — InBoxPath
        // is not accepted where a HostPath source is required. (Enforced by the
        // type checker, so there is no runtime test to write for it.)
    }

    #[test]
    fn door_socket_mount_arg_is_host_to_in_box() {
        let d = DoorSocket {
            name: "net".into(),
            host: HostPath::new("/var/home/core/.claude-box/run/netd.sock"),
            in_box: InBoxPath::new("/run/doors/netd.sock"),
            env: "NETD_SOCK".into(),
        };
        assert_eq!(
            d.mount_arg(),
            "/var/home/core/.claude-box/run/netd.sock:/run/doors/netd.sock"
        );
    }
}
