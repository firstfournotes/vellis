//! Custom protocol handler for `vellis-asset://` URIs.
//!
//! This module implements the Tauri custom protocol that serves images and
//! attachments to the Webview. The protocol translates `vellis-asset://`
//! URIs into internal `Uri` values and reads bytes through `FileProviderRegistry`.

use crate::errors::{FsError, VellisError};
use crate::fs::uri::Uri;

use super::AppState;

// ---------------------------------------------------------------------------
// URI parsing
// ---------------------------------------------------------------------------

/// Convert a `vellis-asset://` URL into an internal `Uri`.
///
/// Accepted forms:
/// - `vellis-asset://local/<absolute-path>` -> `file:///<absolute-path>`
/// - `vellis-asset://ssh/<user>@<host>[:<port>]/<absolute-path>` -> `ssh://...`
///
/// Rejects paths containing `..` segments and unknown scheme prefixes.
pub fn parse_asset_uri(url: &str) -> Result<Uri, VellisError> {
    // Strip the scheme prefix.
    let rest = url
        .strip_prefix("vellis-asset://")
        .ok_or_else(|| VellisError::Uri(crate::errors::UriError::Invalid(
            format!("not a vellis-asset URI: {}", url),
        )))?;

    if rest.is_empty() {
        return Err(VellisError::Uri(crate::errors::UriError::Invalid(
            "empty vellis-asset URI".into(),
        )));
    }

    // Reject path traversal anywhere in the URI.
    if contains_path_traversal(rest) {
        return Err(VellisError::Uri(crate::errors::UriError::Invalid(
            "path traversal (..) is not allowed".into(),
        )));
    }

    if let Some(path) = rest.strip_prefix("local/") {
        // vellis-asset://local/<absolute-path> -> file:///<absolute-path>
        if path.is_empty() {
            return Err(VellisError::Uri(crate::errors::UriError::Invalid(
                "empty path in local asset URI".into(),
            )));
        }
        let file_uri = format!("file:///{}", path);
        Uri::parse(&file_uri).map_err(VellisError::from)
    } else if let Some(rest_after_ssh) = rest.strip_prefix("ssh/") {
        // vellis-asset://ssh/<user>@<host>[:<port>]/<absolute-path>
        if rest_after_ssh.is_empty() {
            return Err(VellisError::Uri(crate::errors::UriError::Invalid(
                "empty ssh asset URI".into(),
            )));
        }
        let ssh_uri = format!("ssh://{}", rest_after_ssh);
        Uri::parse(&ssh_uri).map_err(VellisError::from)
    } else {
        // Unknown provider scheme
        let scheme = rest.split('/').next().unwrap_or(rest);
        Err(VellisError::Uri(crate::errors::UriError::Invalid(
            format!("unsupported asset provider: {}", scheme),
        )))
    }
}

/// Check whether the path contains `..` traversal segments.
fn contains_path_traversal(s: &str) -> bool {
    // Percent-decoded `..` check: literal `..` as a path segment.
    // Also check the percent-encoded form `%2e%2e` / `%2E%2E`.
    let decoded = s.replace("%2e", ".").replace("%2E", ".");
    decoded.split('/').any(|seg| seg == "..")
}

// ---------------------------------------------------------------------------
// MIME safety filter
// ---------------------------------------------------------------------------

/// Downgrade dangerous MIME types to `application/octet-stream` to prevent XSS.
fn safe_mime(mime: &str) -> &str {
    let lower = mime.to_ascii_lowercase();
    if lower.starts_with("text/html")
        || lower.starts_with("application/javascript")
        || lower.starts_with("application/x-javascript")
        || lower.starts_with("text/javascript")
    {
        "application/octet-stream"
    } else {
        // Return the original (caller owns the String, we just validate)
        mime
    }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/// Build a plain-text error response with the given HTTP status code.
pub fn error_response(status: u16, msg: &str) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Cache-Control", "no-store")
        .body(msg.as_bytes().to_vec())
        .expect("failed to build error response")
}

// ---------------------------------------------------------------------------
// Asset request handler
// ---------------------------------------------------------------------------

/// Handle an incoming `vellis-asset://` request.
///
/// 1. Parse the URI to an internal `Uri`.
/// 2. Resolve a `FileProvider` from the registry.
/// 3. Read raw bytes via `provider.read_bytes`.
/// 4. Determine MIME type and apply the safety filter.
/// 5. Return the response with `Cache-Control: no-store`.
pub async fn handle_asset(
    state: &AppState,
    req: http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    let url = req.uri().to_string();

    let inner_uri = match parse_asset_uri(&url) {
        Ok(u) => u,
        Err(_) => return error_response(400, "invalid asset uri"),
    };

    let provider = match state.fs_registry.resolve(&inner_uri) {
        Ok(p) => p,
        Err(_) => return error_response(404, "unsupported scheme"),
    };

    let bytes = match provider.read_bytes(&inner_uri).await {
        Ok(b) => b,
        Err(FsError::NotFound(_)) => return error_response(404, "not found"),
        Err(FsError::FileTooLarge(_)) => return error_response(413, "file too large"),
        Err(_) => return error_response(500, "read error"),
    };

    let mime_raw = mime_guess::from_path(inner_uri.path_str())
        .first_or_octet_stream()
        .to_string();
    let mime = safe_mime(&mime_raw);

    http::Response::builder()
        .status(200)
        .header("Content-Type", mime)
        .header("Cache-Control", "no-store")
        .body(bytes)
        .expect("failed to build asset response")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // ---- parse_asset_uri: normal cases ----

    #[test]
    fn parse_local_absolute_path() {
        let uri = parse_asset_uri("vellis-asset://local/Users/tetsuo/notes/flow.png").unwrap();
        assert_eq!(uri.scheme, "file");
        assert_eq!(uri.path, PathBuf::from("/Users/tetsuo/notes/flow.png"));
        assert!(uri.authority.is_none());
    }

    #[test]
    fn parse_ssh_with_port() {
        let uri = parse_asset_uri(
            "vellis-asset://ssh/alice@host.example.com:2222/home/alice/notes/flow.png",
        )
        .unwrap();
        assert_eq!(uri.scheme, "ssh");
        let auth = uri.authority.as_ref().unwrap();
        assert_eq!(auth.user.as_deref(), Some("alice"));
        assert_eq!(auth.host, "host.example.com");
        assert_eq!(auth.port, Some(2222));
        assert_eq!(uri.path, PathBuf::from("/home/alice/notes/flow.png"));
    }

    #[test]
    fn parse_ssh_without_port() {
        let uri = parse_asset_uri(
            "vellis-asset://ssh/alice@host.example.com/home/alice/notes/flow.png",
        )
        .unwrap();
        assert_eq!(uri.scheme, "ssh");
        let auth = uri.authority.as_ref().unwrap();
        assert_eq!(auth.user.as_deref(), Some("alice"));
        assert_eq!(auth.host, "host.example.com");
        assert!(auth.port.is_none());
        assert_eq!(uri.path, PathBuf::from("/home/alice/notes/flow.png"));
    }

    // ---- parse_asset_uri: error cases ----

    #[test]
    fn reject_path_traversal() {
        let result = parse_asset_uri("vellis-asset://local/Users/tetsuo/../etc/passwd");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("path traversal"), "got: {}", err);
    }

    #[test]
    fn reject_encoded_path_traversal() {
        let result = parse_asset_uri("vellis-asset://local/Users/tetsuo/%2e%2e/etc/passwd");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("path traversal"), "got: {}", err);
    }

    #[test]
    fn reject_unknown_scheme() {
        let result = parse_asset_uri("vellis-asset://ftp/example.com/file.png");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("unsupported"), "got: {}", err);
    }

    #[test]
    fn reject_empty_path() {
        // Not a vellis-asset URI at all
        let result = parse_asset_uri("https://example.com/file.png");
        assert!(result.is_err());
    }

    #[test]
    fn reject_empty_vellis_uri() {
        let result = parse_asset_uri("vellis-asset://");
        assert!(result.is_err());
    }

    #[test]
    fn reject_local_empty_path() {
        let result = parse_asset_uri("vellis-asset://local/");
        assert!(result.is_err());
    }

    // ---- safe_mime ----

    #[test]
    fn mime_html_is_downgraded() {
        assert_eq!(safe_mime("text/html"), "application/octet-stream");
        assert_eq!(
            safe_mime("text/html; charset=utf-8"),
            "application/octet-stream"
        );
    }

    #[test]
    fn mime_javascript_is_downgraded() {
        assert_eq!(
            safe_mime("application/javascript"),
            "application/octet-stream"
        );
        assert_eq!(safe_mime("text/javascript"), "application/octet-stream");
    }

    #[test]
    fn mime_image_passes_through() {
        assert_eq!(safe_mime("image/png"), "image/png");
        assert_eq!(safe_mime("image/jpeg"), "image/jpeg");
    }

    // ---- error_response ----

    #[test]
    fn error_response_builds_correctly() {
        let resp = error_response(404, "not found");
        assert_eq!(resp.status().as_u16(), 404);
        assert_eq!(resp.body(), b"not found");
    }
}
