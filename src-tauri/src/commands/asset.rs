//! Custom protocol handler for `vellis-asset://` URIs.
//!
//! This module implements the Tauri custom protocol that serves images and
//! attachments to the Webview. The protocol translates `vellis-asset://`
//! URIs into internal `Uri` values and reads bytes through `FileProviderRegistry`.
//!
//! Responses are range-capable (要件#27, modelled on Tauri's own
//! `examples/streaming` but parsed here rather than pulling in a dependency):
//! the handler stats the target first, answers `Range` with `206` + a slice, and
//! falls back to a `200` whole-file response otherwise. That whole-file path
//! streams too — it is not subject to `LocalProvider`'s `read_bytes` size cap,
//! which is what used to turn files over 10 MB into a `413` (backlog #59).

use crate::errors::{FsError, VellisError};
use crate::fs::uri::Uri;

use super::AppState;

// ---------------------------------------------------------------------------
// URI parsing
// ---------------------------------------------------------------------------

/// Every rejection this module reports is an "invalid URI".
fn invalid_uri(msg: impl Into<String>) -> VellisError {
    VellisError::Uri(crate::errors::UriError::Invalid(msg.into()))
}

/// Convert a `vellis-asset://` URL into an internal `Uri`.
///
/// Accepted forms:
/// - `vellis-asset://local/<absolute-path>` -> `file:///<absolute-path>`
/// - `vellis-asset://ssh/<user>@<host>[:<port>]/<absolute-path>` -> `ssh://...`
///
/// A query string, if any, is ignored: the frontend appends a version query to
/// bust the WebView cache when a watched image changes (要件#22,
/// `src/lib/image-watch.ts`), and it is not part of the path being served.
///
/// The path arrives percent-encoded — the frontend builds these URIs out of
/// `URL.pathname` (`src/lib/uri.ts`), so `2025年度.pdf` reaches us as
/// `2025%E5%B9%B4%E5%BA%A6.pdf` — and is decoded here, exactly once, before it
/// becomes a `PathBuf` (要件#30 / backlog #67; opening the literal `%XX` name
/// is what used to 404 every non-ASCII asset).
///
/// Order matters both ways round:
/// - the query is dropped *before* decoding, so that a file whose name really
///   contains `?` or `#` (delivered as `%3F` / `%23`) is not truncated;
/// - the `..` check runs *after* decoding, where every disguise — `%2e%2e` for
///   the dots, `..%2f` for the separator — has collapsed into a plain segment.
///
/// Rejects paths containing `..` segments, malformed percent escapes, decodes
/// that are not valid UTF-8, and unknown scheme prefixes.
pub fn parse_asset_uri(url: &str) -> Result<Uri, VellisError> {
    // Strip the scheme prefix.
    let rest = url
        .strip_prefix("vellis-asset://")
        .ok_or_else(|| invalid_uri(format!("not a vellis-asset URI: {}", url)))?;

    // Drop the query (and any fragment behind it) — path only from here on.
    let rest = rest.split(['?', '#']).next().unwrap_or("");

    if rest.is_empty() {
        return Err(invalid_uri("empty vellis-asset URI"));
    }

    if let Some(path) = rest.strip_prefix("local/") {
        // vellis-asset://local/<absolute-path> -> file:///<absolute-path>
        if path.is_empty() {
            return Err(invalid_uri("empty path in local asset URI"));
        }
        let path = decode_path(path)?;
        let file_uri = format!("file:///{}", path);
        Uri::parse(&file_uri).map_err(VellisError::from)
    } else if let Some(rest_after_ssh) = rest.strip_prefix("ssh/") {
        // vellis-asset://ssh/<user>@<host>[:<port>]/<absolute-path>
        if rest_after_ssh.is_empty() {
            return Err(invalid_uri("empty ssh asset URI"));
        }
        // Only the path is decoded; the authority (`user@host:port`) is passed
        // through as received, as it always was.
        let ssh_uri = match rest_after_ssh.split_once('/') {
            Some((authority, path)) => format!("ssh://{}/{}", authority, decode_path(path)?),
            // No path at all — `Uri::parse` is the one that says so.
            None => format!("ssh://{}", rest_after_ssh),
        };
        Uri::parse(&ssh_uri).map_err(VellisError::from)
    } else {
        // Unknown provider scheme
        let scheme = rest.split('/').next().unwrap_or(rest);
        Err(invalid_uri(format!("unsupported asset provider: {}", scheme)))
    }
}

/// Percent-decode the path portion of an asset URI — once — and check it.
///
/// Validation runs on the **encoded** input, before decoding, for two reasons
/// that pull in opposite directions:
/// - `percent_encoding`'s decoder is lenient: `%zz` and a trailing `%` are
///   copied through untouched, which would quietly serve a path nobody asked
///   for. Those are rejected here instead.
/// - Validating the *decoded* text instead would reject honest names: a file
///   called `100%off.pdf` arrives as `100%25off.pdf` and decodes to a literal
///   `%o`, which is not a valid escape and does not need to be. For the same
///   reason the result is never fed back through the decoder — `%252e%252e`
///   names a directory `%2e%2e`, it is not a way out of the tree.
fn decode_path(encoded: &str) -> Result<String, VellisError> {
    reject_malformed_escapes(encoded)?;

    let decoded = percent_encoding::percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|_| {
            invalid_uri(format!(
                "percent-decoded path is not valid UTF-8: {}",
                encoded
            ))
        })?
        .into_owned();

    if contains_path_traversal(&decoded) {
        return Err(invalid_uri("path traversal (..) is not allowed"));
    }

    Ok(decoded)
}

/// Reject any `%` that is not followed by two hex digits.
fn reject_malformed_escapes(s: &str) -> Result<(), VellisError> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'%' {
            i += 1;
            continue;
        }
        match bytes.get(i + 1..i + 3) {
            Some(hex) if hex.iter().all(u8::is_ascii_hexdigit) => i += 3,
            _ => {
                return Err(invalid_uri(format!(
                    "malformed percent-encoding in asset URI: {}",
                    s
                )))
            }
        }
    }
    Ok(())
}

/// Check whether a **decoded** path contains `..` traversal segments.
///
/// Decoding first is what makes one plain comparison enough: the encoded form
/// can hide a traversal in the dots (`%2e%2e/`) or in the separator (`..%2f`),
/// and only the decoded string shows both as a `..` segment.
fn contains_path_traversal(s: &str) -> bool {
    s.split('/').any(|seg| seg == "..")
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

/// Origins allowed to read an asset response (backlog #55 / 要件#23).
///
/// `<img src="vellis-asset://…">` never needed this: the WebView draws an
/// opaque image without letting the page read its bytes. `ModelViewer` does
/// read the bytes (`fetch` -> `ArrayBuffer` -> STL / 3MF parser), and that
/// makes the request a cross-origin one from the page's origin
/// (`http://localhost:1420` in dev, `tauri://localhost` in the bundle) to the
/// `vellis-asset` origin — without this header the WebView blocks the body
/// even though the request itself succeeded with 200.
///
/// `*` is the right value here rather than a specific origin: the protocol is
/// only reachable from inside this app's WebView (no network listener), the
/// page origin differs between dev and bundle, and the handler already
/// enforces its own access rules (path traversal rejection, MIME downgrade).
const ALLOW_ORIGIN: &str = "*";

/// Build a plain-text error response with the given HTTP status code.
///
/// Errors carry the CORS header too: without it the frontend cannot even
/// observe the status code (the fetch rejects with an opaque network error),
/// so a missing file would be indistinguishable from a broken protocol.
pub fn error_response(status: u16, msg: &str) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", ALLOW_ORIGIN)
        .body(msg.as_bytes().to_vec())
        .expect("failed to build error response")
}

/// Map a read failure to the status code it has always produced.
fn read_error_response(err: FsError) -> http::Response<Vec<u8>> {
    match err {
        FsError::NotFound(_) => error_response(404, "not found"),
        FsError::FileTooLarge(_) => error_response(413, "file too large"),
        _ => error_response(500, "read error"),
    }
}

/// Build the body-carrying response: `206` when `content_range` is present,
/// `200` otherwise. Both advertise `Accept-Ranges: bytes` so the WebView knows
/// it may seek instead of pulling the whole file.
fn body_response(
    mime: &str,
    bytes: Vec<u8>,
    content_range: Option<String>,
) -> http::Response<Vec<u8>> {
    let builder = http::Response::builder()
        .header("Content-Type", mime)
        .header("Accept-Ranges", "bytes")
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", ALLOW_ORIGIN);

    let builder = match content_range {
        Some(range) => builder.status(206).header("Content-Range", range),
        None => builder.status(200),
    };

    builder.body(bytes).expect("failed to build asset response")
}

/// `416 Range Not Satisfiable`, telling the client the real size so it can
/// re-ask for a range that exists.
fn unsatisfiable_response(total: u64) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(416)
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Content-Range", format!("bytes */{}", total))
        .header("Accept-Ranges", "bytes")
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", ALLOW_ORIGIN)
        .body(b"range not satisfiable".to_vec())
        .expect("failed to build 416 response")
}

// ---------------------------------------------------------------------------
// Range requests
// ---------------------------------------------------------------------------

/// Largest body one open-ended `Range` (`bytes=N-`) response carries (1 MiB).
///
/// A media element asks for `bytes=N-` meaning "everything from here", which for
/// a video is the whole file. Answering with one chunk and a `Content-Range`
/// that says so is what makes the WebView come back for the next piece instead
/// of waiting on a multi-gigabyte read. 1 MiB is the size Tauri's own streaming
/// example settles on.
pub const STREAM_CHUNK_SIZE: u64 = 1024 * 1024;

/// What a `Range` header value means for a file of a given size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeResolution {
    /// No usable range in the header. Per RFC 9110 an unparsable `Range` is
    /// ignored rather than rejected, so this means "serve the whole file".
    Ignore,
    /// Serve bytes `start..=end` (`end` inclusive, as in `Content-Range`).
    Partial { start: u64, end: u64 },
    /// The range starts at or past EOF — nothing to serve (`416`).
    Unsatisfiable,
}

/// Interpret a `Range` header value against the total file size.
///
/// Handles the three forms browsers send, taking only the first range of a
/// multi-range request (no `multipart/byteranges`):
/// - `bytes=a-b` — both ends given; `b` is clamped to the last byte.
/// - `bytes=a-`  — open-ended; capped at `STREAM_CHUNK_SIZE`.
/// - `bytes=-n`  — the last `n` bytes; clamped to the whole file.
pub fn resolve_range(header: &str, total: u64) -> RangeResolution {
    let spec = match split_bytes_unit(header.trim()) {
        Some(s) => s,
        None => return RangeResolution::Ignore,
    };

    // Only the first range of `bytes=0-1,5-6` is served.
    let spec = spec.split(',').next().unwrap_or("").trim();
    let (first, last) = match spec.split_once('-') {
        Some(parts) => parts,
        None => return RangeResolution::Ignore,
    };

    if first.is_empty() {
        // `bytes=-n`: the last n bytes.
        let n: u64 = match last.trim().parse() {
            Ok(n) => n,
            Err(_) => return RangeResolution::Ignore,
        };
        if n == 0 || total == 0 {
            return RangeResolution::Unsatisfiable;
        }
        return RangeResolution::Partial {
            start: total.saturating_sub(n),
            end: total - 1,
        };
    }

    let start: u64 = match first.trim().parse() {
        Ok(s) => s,
        Err(_) => return RangeResolution::Ignore,
    };
    let last = last.trim();

    if last.is_empty() {
        // `bytes=a-`: to EOF, but no more than one chunk per response.
        if start >= total {
            return RangeResolution::Unsatisfiable;
        }
        let end = start.saturating_add(STREAM_CHUNK_SIZE - 1).min(total - 1);
        return RangeResolution::Partial { start, end };
    }

    // `bytes=a-b`
    let end: u64 = match last.parse() {
        Ok(e) => e,
        Err(_) => return RangeResolution::Ignore,
    };
    if start > end {
        return RangeResolution::Ignore; // malformed, not unsatisfiable
    }
    if start >= total {
        return RangeResolution::Unsatisfiable;
    }
    RangeResolution::Partial {
        start,
        end: end.min(total - 1),
    }
}

/// Strip the `bytes=` unit prefix, rejecting any other range unit.
fn split_bytes_unit(header: &str) -> Option<&str> {
    let (unit, spec) = header.split_once('=')?;
    unit.trim().eq_ignore_ascii_case("bytes").then_some(spec)
}

// ---------------------------------------------------------------------------
// Asset request handler
// ---------------------------------------------------------------------------

/// Handle an incoming `vellis-asset://` request.
///
/// 1. Parse the URI to an internal `Uri`.
/// 2. Resolve a `FileProvider` from the registry.
/// 3. `stat` the target for its size — needed to decide whether a `Range` can
///    be satisfied and to fill in `Content-Range`.
/// 4. Read the requested slice (or the whole file) via `provider.read_range`.
/// 5. Determine MIME type and apply the safety filter.
/// 6. Return `206` / `200` with `Cache-Control: no-store` and the CORS header.
///
/// Every response this module can produce comes from one of exactly three
/// builders — `body_response` (200 / 206), `unsatisfiable_response` (416) and
/// `error_response` (400 / 404 / 413 / 500) — and all carry
/// `Access-Control-Allow-Origin` so that `fetch` from the page can read the
/// result (backlog #55).
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

    // `size` is `None` for anything that is not a regular file (a directory,
    // say). There is no total to range against, so the request falls through to
    // a whole-file read, which fails exactly as it did before ranges existed.
    let total = match provider.stat(&inner_uri).await {
        Ok(entry) => entry.size,
        Err(FsError::NotFound(_)) => return error_response(404, "not found"),
        Err(_) => return error_response(500, "stat error"),
    };

    let range_header = req
        .headers()
        .get(http::header::RANGE)
        .and_then(|v| v.to_str().ok());

    let resolution = match (total, range_header) {
        (Some(total), Some(header)) => resolve_range(header, total),
        _ => RangeResolution::Ignore,
    };

    let (start, max_len, content_range) = match (resolution, total) {
        (RangeResolution::Partial { start, end }, Some(total)) => (
            start,
            end - start + 1,
            Some(format!("bytes {}-{}/{}", start, end, total)),
        ),
        (RangeResolution::Unsatisfiable, Some(total)) => return unsatisfiable_response(total),
        // Whole file. `u64::MAX` only stands in for an unknown size; the read
        // stops at EOF either way.
        _ => (0, total.unwrap_or(u64::MAX), None),
    };

    let bytes = match provider.read_range(&inner_uri, start, max_len).await {
        Ok(b) => b,
        Err(e) => return read_error_response(e),
    };

    let mime_raw = mime_guess::from_path(inner_uri.path_str())
        .first_or_octet_stream()
        .to_string();
    let mime = safe_mime(&mime_raw);

    body_response(mime, bytes, content_range)
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

    // ---- CORS(backlog #55 の回帰・要件#23) ----
    //
    // ModelViewer は `<img src>` と違い fetch(vellis-asset://…) でバイトを取るため、
    // 応答に `Access-Control-Allow-Origin` が無いと WebView(origin
    // http://localhost:1420 等)が本文を遮断する。契約: 成功・エラーを問わず
    // すべての応答に `Access-Control-Allow-Origin: *` を付ける(エラーも
    // フロントから観測可能でなければならない)。

    /// handle_asset を通すための最小 AppState(実プロバイダ・実ファイル)。
    fn test_state() -> AppState {
        let registry = std::sync::Arc::new(crate::fs::registry::FileProviderRegistry::new());
        AppState {
            fs_registry: registry.clone(),
            coordinator: std::sync::Arc::new(crate::watch::hub::DocumentCoordinator::new(
                registry,
            )),
            window_manager: std::sync::Arc::new(tokio::sync::Mutex::new(
                crate::window::manager::WindowManager::new(),
            )),
            annotation_stores: std::sync::Arc::new(std::sync::Mutex::new(
                std::collections::HashMap::new(),
            )),
        }
    }

    fn allow_origin(resp: &http::Response<Vec<u8>>) -> Option<&str> {
        resp.headers()
            .get("Access-Control-Allow-Origin")
            .and_then(|v| v.to_str().ok())
    }

    #[tokio::test]
    async fn asset_success_response_allows_cross_origin() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cube.stl");
        std::fs::write(&path, b"solid cube\nendsolid cube\n").unwrap();

        let url = format!(
            "vellis-asset://local{}",
            path.to_str().unwrap() // 絶対パスなので先頭 '/' がそのまま区切りになる
        );
        let req = http::Request::builder().uri(url).body(Vec::new()).unwrap();

        let resp = handle_asset(&test_state(), req).await;

        assert_eq!(resp.status().as_u16(), 200);
        assert_eq!(
            allow_origin(&resp),
            Some("*"),
            "200 応答に Access-Control-Allow-Origin: * が要る(fetch が本文を読めない)"
        );
        assert_eq!(resp.body(), b"solid cube\nendsolid cube\n");
    }

    #[tokio::test]
    async fn asset_not_found_response_allows_cross_origin() {
        let req = http::Request::builder()
            .uri("vellis-asset://local/no/such/dir/missing.stl")
            .body(Vec::new())
            .unwrap();

        let resp = handle_asset(&test_state(), req).await;

        assert_eq!(resp.status().as_u16(), 404);
        assert_eq!(
            allow_origin(&resp),
            Some("*"),
            "エラー応答にも要る(付けないと 404 すらフロントで観測できない)"
        );
    }

    #[tokio::test]
    async fn asset_bad_request_response_allows_cross_origin() {
        let req = http::Request::builder()
            .uri("vellis-asset://local/Users/tetsuo/../etc/passwd")
            .body(Vec::new())
            .unwrap();

        let resp = handle_asset(&test_state(), req).await;

        assert_eq!(resp.status().as_u16(), 400);
        assert_eq!(allow_origin(&resp), Some("*"));
    }

    #[test]
    fn error_response_allows_cross_origin() {
        let resp = error_response(500, "read error");
        assert_eq!(allow_origin(&resp), Some("*"));
    }
}
