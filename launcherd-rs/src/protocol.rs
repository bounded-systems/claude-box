//! Wire protocol — the NDJSON RPC contract launcherd speaks, as types.
//!
//! One JSON object per line, request and response. This mirrors the framing
//! `peercred/` already established (it forwards these same lines and injects a
//! `_caller`), and the method/param/error shapes the bun `launcherd.ts` serves
//! today — captured here as `serde` types so the contract is checked at the
//! (de)serialization boundary instead of living in scattered `as` casts.
//!
//! Requests:  `{"id":"1","method":"dispatch","params":{...}}`
//! Responses: `{"id":"1","ok":true,"result":{...}}`
//!         or `{"id":"1","ok":false,"error":{"code":"...","message":"..."}}`

use serde::{Deserialize, Serialize};

/// A single request line. `method` + `params` are kept loosely-typed at the
/// envelope level (params shape depends on the method) and narrowed per-handler
/// via the typed `*Params` structs below.
#[derive(Debug, Clone, Deserialize)]
pub struct Request {
    /// Correlation id echoed back on the response. Optional in some callers, so
    /// default to empty rather than reject the line.
    #[serde(default)]
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
    /// Caller identity injected by the `peercred` frontend (SO_PEERCRED). Absent
    /// on the doors-blind `dispatch` socket, which deliberately performs no
    /// caller-identity check (see ADR / LAUNCHERD.md).
    #[serde(default, rename = "_caller")]
    pub caller: Option<Caller>,
}

/// SO_PEERCRED-derived caller identity, injected by the peercred frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Caller {
    pub uid: u32,
    pub gid: u32,
    pub pid: i32,
}

/// `dispatch` params — deliberately just two fields. No `doors`, `repo`,
/// `repoRw`, `netOpen`, or any way to name a host path or escape flag: the
/// dispatch door is doors-blind and allow-list-only (see ADR / PR B). A room
/// name off the allow-list and a human label, nothing else.
#[derive(Debug, Clone, Deserialize)]
pub struct DispatchParams {
    pub room: String,
    #[serde(default)]
    pub label: Option<String>,
}

/// A response line. Construct via [`Response::ok`] / [`Response::err`] so the
/// `ok` flag and the result/error fields can't disagree.
#[derive(Debug, Clone, Serialize)]
pub struct Response {
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RpcError {
    pub code: ErrorCode,
    pub message: String,
}

/// The closed set of error codes launcherd emits. An enum (not free strings) so
/// callers can match exhaustively and a typo can't invent a new code — the same
/// codes the bun implementation returns, now enforced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    /// Method name not served on this socket (e.g. `launch` on `dispatch.sock`).
    UnknownMethod,
    /// Room is unknown or not marked dispatchable.
    RoomNotDispatchable,
    /// A door the spawn needs isn't reachable / its host socket path is missing.
    DoorsUnreachable,
    /// Dispatch rate or concurrency ceiling hit.
    RateLimited,
    /// The spawn itself failed (podman error, etc.).
    SpawnFailed,
    /// Malformed request line.
    BadRequest,
}

impl Response {
    pub fn ok(id: impl Into<String>, result: serde_json::Value) -> Self {
        Response {
            id: id.into(),
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: impl Into<String>, code: ErrorCode, message: impl Into<String>) -> Self {
        Response {
            id: id.into(),
            ok: false,
            result: None,
            error: Some(RpcError {
                code,
                message: message.into(),
            }),
        }
    }

    /// Serialize to a single NDJSON line (no trailing newline; the writer adds
    /// it). Infallible in practice — the types are all plainly serializable.
    pub fn to_line(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|e| {
            format!(
                "{{\"id\":\"{}\",\"ok\":false,\"error\":{{\"code\":\"SPAWN_FAILED\",\"message\":\"response-serialize: {}\"}}}}",
                self.id, e
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_dispatch_request() {
        let line = r#"{"id":"1","method":"dispatch","params":{"room":"dev","label":"hooksmith"}}"#;
        let req: Request = serde_json::from_str(line).unwrap();
        assert_eq!(req.method, "dispatch");
        let p: DispatchParams = serde_json::from_value(req.params).unwrap();
        assert_eq!(p.room, "dev");
        assert_eq!(p.label.as_deref(), Some("hooksmith"));
    }

    #[test]
    fn dispatch_label_is_optional() {
        let line = r#"{"id":"x","method":"dispatch","params":{"room":"readonly"}}"#;
        let req: Request = serde_json::from_str(line).unwrap();
        let p: DispatchParams = serde_json::from_value(req.params).unwrap();
        assert_eq!(p.room, "readonly");
        assert_eq!(p.label, None);
    }

    #[test]
    fn error_response_serializes_with_screaming_snake_code() {
        let r = Response::err("1", ErrorCode::RoomNotDispatchable, "room \"bootstrap\" is not dispatchable");
        let line = r.to_line();
        assert!(line.contains(r#""ok":false"#));
        assert!(line.contains(r#""code":"ROOM_NOT_DISPATCHABLE""#));
        assert!(!line.contains(r#""result""#), "err response must omit result");
    }

    #[test]
    fn ok_response_omits_error() {
        let r = Response::ok("2", serde_json::json!({"launchId": "dispatch-hooksmith-ab12"}));
        let line = r.to_line();
        assert!(line.contains(r#""ok":true"#));
        assert!(!line.contains(r#""error""#), "ok response must omit error");
    }

    #[test]
    fn caller_injection_is_optional() {
        // dispatch.sock lines have no _caller; must still parse.
        let line = r#"{"id":"1","method":"dispatch","params":{"room":"dev"}}"#;
        let req: Request = serde_json::from_str(line).unwrap();
        assert!(req.caller.is_none());
        // launcherd.sock lines (via peercred) carry _caller.
        let line2 = r#"{"id":"1","method":"launch","params":{},"_caller":{"uid":1000,"gid":1000,"pid":42}}"#;
        let req2: Request = serde_json::from_str(line2).unwrap();
        assert_eq!(req2.caller.unwrap().uid, 1000);
    }
}
