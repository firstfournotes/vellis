//! IPC message protocol — JSON Lines format.

use serde::{Deserialize, Serialize};

/// Request sent from CLI to Main Process.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(tag = "type")]
pub enum Request {
    OpenPath { uri: String, new_window: bool },
    SwitchRoot { uri: String },
    /// `vellis --marks` — focus the existing instance and open the marks
    /// sidebar (`docs/ai-collab.md` §9.1).
    ShowMarks,
    /// `vellis --changed` — focus the existing instance and open the
    /// marks sidebar with the drift filter on (`docs/ai-collab.md` §9.1).
    ShowChanged,
    Ping,
    Shutdown,
}

/// Response sent from Main Process to CLI.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(tag = "type")]
pub enum Response {
    Ok,
    Error { code: String, message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_open_path_roundtrip() {
        let req = Request::OpenPath {
            uri: "file:///tmp/README.md".into(),
            new_window: false,
        };
        let json = serde_json::to_string(&req).unwrap();
        let parsed: Request = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, req);
    }

    #[test]
    fn request_open_path_new_window_roundtrip() {
        let req = Request::OpenPath {
            uri: "file:///tmp/README.md".into(),
            new_window: true,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"new_window\":true"));
        let parsed: Request = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, req);
    }

    #[test]
    fn request_switch_root_roundtrip() {
        let req = Request::SwitchRoot {
            uri: "file:///home/user/docs".into(),
        };
        let json = serde_json::to_string(&req).unwrap();
        let parsed: Request = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, req);
    }

    #[test]
    fn request_ping_roundtrip() {
        let req = Request::Ping;
        let json = serde_json::to_string(&req).unwrap();
        assert_eq!(json, r#"{"type":"Ping"}"#);
        let parsed: Request = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, req);
    }

    #[test]
    fn request_shutdown_roundtrip() {
        let req = Request::Shutdown;
        let json = serde_json::to_string(&req).unwrap();
        let parsed: Request = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, req);
    }

    #[test]
    fn response_ok_roundtrip() {
        let resp = Response::Ok;
        let json = serde_json::to_string(&resp).unwrap();
        assert_eq!(json, r#"{"type":"Ok"}"#);
        let parsed: Response = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, resp);
    }

    #[test]
    fn response_error_roundtrip() {
        let resp = Response::Error {
            code: "NOT_FOUND".into(),
            message: "Path does not exist".into(),
        };
        let json = serde_json::to_string(&resp).unwrap();
        let parsed: Response = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, resp);
    }

    #[test]
    fn json_lines_format() {
        // Verify serialized output does not contain newlines (JSON Lines compatible).
        let req = Request::OpenPath {
            uri: "file:///path/with spaces/doc.md".into(),
            new_window: true,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(!json.contains('\n'));
    }

    #[test]
    fn deserialize_from_known_json() {
        let json = r#"{"type":"OpenPath","uri":"file:///tmp/README.md","new_window":false}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        assert_eq!(
            req,
            Request::OpenPath {
                uri: "file:///tmp/README.md".into(),
                new_window: false,
            }
        );
    }
}
