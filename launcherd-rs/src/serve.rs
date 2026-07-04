//! Unix-socket serving for the dispatch lane.
//!
//! `dispatch.sock` serves exactly one method — `dispatch`. Any other method is
//! `UNKNOWN_METHOD`: a box holding only the dispatch door mounts a socket that
//! structurally cannot reach `launch`/`kill`/`list`/`attach` (they live on the
//! separate `launcherd.sock`, served by a later increment). This is the
//! mount-level isolation the ADR / PR B rely on.
//!
//! Single-threaded, one connection at a time: dispatch is low-rate (≤20/hour)
//! and each request briefly shells out to podman, so a simple accept-loop is
//! plenty and keeps the shared [`Limits`] state lock-free.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};

use crate::dispatch::{self, Clock, Env};
use crate::limits::Limits;
use crate::protocol::{ErrorCode, Request, Response};

/// Bind `dispatch.sock` and serve forever. Removes a stale socket file first
/// (a crashed prior instance leaves one), then serves the dispatch method.
pub fn serve_dispatch(
    socket_path: &str,
    env: &Env,
    clock: &dyn Clock,
) -> Result<(), String> {
    let _ = std::fs::remove_file(socket_path); // clear any stale socket
    let listener = UnixListener::bind(socket_path)
        .map_err(|e| format!("bind {socket_path}: {e}"))?;
    eprintln!("launcherd: dispatch serving on {socket_path}");

    let mut limits = Limits::new();
    for conn in listener.incoming() {
        match conn {
            Ok(stream) => handle_conn(stream, env, &mut limits, clock),
            Err(e) => eprintln!("launcherd: accept error: {e}"),
        }
    }
    Ok(())
}

/// One connection: read NDJSON request lines, respond per line. Kept resilient —
/// a malformed line gets a `BAD_REQUEST` response rather than dropping the conn.
fn handle_conn(stream: UnixStream, env: &Env, limits: &mut Limits, clock: &dyn Clock) {
    let read_half = match stream.try_clone() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("launcherd: clone stream: {e}");
            return;
        }
    };
    let mut writer = stream;
    let reader = BufReader::new(read_half);

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("launcherd: read line: {e}");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let resp = route(&line, env, limits, clock);
        if let Err(e) = writeln!(writer, "{}", resp.to_line()) {
            eprintln!("launcherd: write response: {e}");
            break;
        }
    }
}

/// Parse one line and route it. Only `dispatch` is served here.
fn route(line: &str, env: &Env, limits: &mut Limits, clock: &dyn Clock) -> Response {
    let req: Request = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(e) => return Response::err("", ErrorCode::BadRequest, format!("bad request line: {e}")),
    };
    match req.method.as_str() {
        "dispatch" => dispatch::handle(&req.id, req.params, env, limits, clock),
        other => Response::err(
            &req.id,
            ErrorCode::UnknownMethod,
            format!("method '{other}' is not served on dispatch.sock (dispatch only)"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::Clock;

    struct FixedClock;
    impl Clock for FixedClock {
        fn now_secs(&self) -> u64 {
            1000
        }
    }

    fn env() -> Env {
        Env {
            doors_dir: "/nonexistent".into(),
            work_dir: "/tmp".into(),
        }
    }

    #[test]
    fn non_dispatch_method_is_unknown_method() {
        let mut limits = Limits::new();
        let r = route(
            r#"{"id":"1","method":"launch","params":{}}"#,
            &env(),
            &mut limits,
            &FixedClock,
        );
        assert_eq!(r.error.unwrap().code, ErrorCode::UnknownMethod);
    }

    #[test]
    fn malformed_line_is_bad_request_not_a_panic() {
        let mut limits = Limits::new();
        let r = route("not json at all", &env(), &mut limits, &FixedClock);
        assert_eq!(r.error.unwrap().code, ErrorCode::BadRequest);
    }

    #[test]
    fn dispatch_method_reaches_the_handler() {
        // offline room + nonexistent doors dir → handler returns DOORS_UNREACHABLE,
        // proving the line routed all the way through.
        let mut limits = Limits::new();
        let r = route(
            r#"{"id":"9","method":"dispatch","params":{"room":"offline"}}"#,
            &env(),
            &mut limits,
            &FixedClock,
        );
        assert_eq!(r.id, "9");
        assert_eq!(r.error.unwrap().code, ErrorCode::DoorsUnreachable);
    }
}
