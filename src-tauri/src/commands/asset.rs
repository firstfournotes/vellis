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
//!
//! The protocol's entry point is [`handle_asset_for_window`], which knows the
//! webview that asked: a `vellis-asset://ssh/…` request is served only from a
//! host that window has open, so an image URI written into a document cannot
//! make the app open an SSH connection anywhere else (要件#27 追補b・Issue
//! #728).
//!
//! An open-GOP movie is served with the sync tables of its `moov` rewritten
//! (see `video_sync`): an HEVC one with its CRAs moved from `stss` to `stps`
//! (要件#37 追補f・Issue #591), an H.264 one with its non-IDR I frames moved
//! to `stps` or out of `stss` and their lone leading frames marked in `sdtp`
//! (要件#37 追補g・Issue #734). Ranges are cut from that rewritten file, and
//! the file on disk is left alone.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, PoisonError};

use crate::errors::{FsError, VellisError};
use crate::fs::provider::FileProvider;
use crate::fs::uri::{Authority, Uri};
use crate::print::is_print_window;
use crate::video_sync::{rewrite_moov_for_open_gop, MoovPatch, MoovPosition, Piece};

use super::video::{top_level_box, BOX_HEADER_LEN, MAX_MOOV_BYTES};
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

/// `Content-Security-Policy` carried by every response (200 / 206 / 416 /
/// errors); the same value as `PRINT_CSP` in `print.rs` — keep the two in step.
///
/// backlog 331 / 要件#82 (e): without it a scripted SVG or XHTML served here runs
/// its scripts once a frame navigates to it as a document. The header only takes
/// effect when the response is read as a document, so sub-resource loads
/// (`<img>`, `<video>`, `fetch`) display exactly as before (the PDF frame too:
/// measured unchanged in req-82.md (e)).
const ASSET_DOCUMENT_CSP: &str = "script-src 'none'; object-src 'none'";

/// `Access-Control-Expose-Headers` carried by every response (要件#23 追補d
/// 契約6).
///
/// A cross-origin `fetch` only lets the page read the CORS-safelisted response
/// headers, and `Content-Range` is not one of them. `ModelViewer` learns a
/// file's size from the `Content-Range` of a `Range: bytes=0-0` probe before it
/// asks for the body (so an oversized model is turned down without the whole
/// file being read into this process); without this header every probe would
/// read as "size unknown".
const EXPOSE_HEADERS: &str = "Content-Range";

/// Build a plain-text error response with the given HTTP status code.
///
/// Errors carry the CORS headers too: without them the frontend cannot even
/// observe the status code (the fetch rejects with an opaque network error),
/// so a missing file would be indistinguishable from a broken protocol.
pub fn error_response(status: u16, msg: &str) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", ALLOW_ORIGIN)
        .header("Access-Control-Expose-Headers", EXPOSE_HEADERS)
        .header("Content-Security-Policy", ASSET_DOCUMENT_CSP)
        .body(msg.as_bytes().to_vec())
        .expect("failed to build error response")
}

/// Answer a CORS preflight (`OPTIONS`) without touching the file (要件#23
/// 追補d 契約6).
///
/// WebKit may send one before a `fetch` that carries a `Range` header (the
/// `ModelViewer` size probe). The answer is the same for every path, so the
/// URI is not even parsed and no provider is asked anything: `204` allowing
/// `GET` with a `Range` header from any origin.
fn preflight_response() -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(204)
        .header("Access-Control-Allow-Origin", ALLOW_ORIGIN)
        .header("Access-Control-Allow-Methods", "GET")
        .header("Access-Control-Allow-Headers", "Range")
        .header("Access-Control-Expose-Headers", EXPOSE_HEADERS)
        .header("Content-Security-Policy", ASSET_DOCUMENT_CSP)
        .body(Vec::new())
        .expect("failed to build preflight response")
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
        .header("Access-Control-Allow-Origin", ALLOW_ORIGIN)
        .header("Access-Control-Expose-Headers", EXPOSE_HEADERS)
        .header("Content-Security-Policy", ASSET_DOCUMENT_CSP);

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
        .header("Access-Control-Expose-Headers", EXPOSE_HEADERS)
        .header("Content-Security-Policy", ASSET_DOCUMENT_CSP)
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
/// 0. A CORS preflight (`OPTIONS`) is answered at once with `204`
///    (`preflight_response`) — no URI parsing, no provider call.
/// 1. Parse the URI to an internal `Uri`.
/// 2. Resolve a `FileProvider` from the registry.
/// 3. `stat` the target for its size — needed to decide whether a `Range` can
///    be satisfied and to fill in `Content-Range`.
/// 4. Determine MIME type and apply the safety filter.
/// 5. For an open-GOP HEVC or H.264 movie, find the rewritten `moov`
///    (`moov_patch`, 要件#37 追補f・追補g); from here on the file is the
///    rewritten one — its size is the one ranges resolve against and
///    `Content-Range` / `416` report.
/// 6. Read the requested slice (or the whole file) via `provider.read_range`
///    (`read_patched` for a rewritten movie).
/// 7. Return `206` / `200` with `Cache-Control: no-store` and the CORS header.
///
/// Every response this module can produce comes from one of exactly four
/// builders — `body_response` (200 / 206), `unsatisfiable_response` (416),
/// `error_response` (400 / 404 / 413 / 500) and `preflight_response` (204) —
/// and all carry `Access-Control-Allow-Origin` so that `fetch` from the page
/// can read the result (backlog #55), and `Access-Control-Expose-Headers:
/// Content-Range` so that it can read the file's size too (要件#23 追補d).
pub async fn handle_asset(
    state: &AppState,
    req: http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    if req.method() == http::Method::OPTIONS {
        return preflight_response();
    }

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
    let (total, modified) = match provider.stat(&inner_uri).await {
        Ok(entry) => (entry.size, entry.modified),
        Err(FsError::NotFound(_)) => return error_response(404, "not found"),
        Err(_) => return error_response(500, "stat error"),
    };

    let mime_raw = mime_guess::from_path(inner_uri.path_str())
        .first_or_octet_stream()
        .to_string();
    let mime = safe_mime(&mime_raw);

    let patch = match total {
        Some(total) if mime.starts_with("video/") => {
            moov_patch(provider.as_ref(), &inner_uri, total, modified).await
        }
        _ => None,
    };
    let total = match (&patch, total) {
        (Some(patch), Some(total)) => Some(patch.patched_total(total)),
        _ => total,
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

    let read = match &patch {
        Some(patch) => read_patched(provider.as_ref(), &inner_uri, patch, start, max_len).await,
        None => provider.read_range(&inner_uri, start, max_len).await,
    };
    let bytes = match read {
        Ok(b) => b,
        Err(e) => return read_error_response(e),
    };

    body_response(mime, bytes, content_range)
}

// ---------------------------------------------------------------------------
// Open-GOP HEVC and H.264 (要件#37 追補f・追補g)
// ---------------------------------------------------------------------------

/// Most top-level boxes `find_moov_patch` steps through before giving up.
/// Movies have a handful; the bound only keeps a file of tiny boxes from
/// turning one request into millions of reads.
const MAX_TOP_LEVEL_BOXES: usize = 1024;

/// Movies whose decision is remembered (契約5)…
const MOOV_PATCH_CACHE_ENTRIES: usize = 16;

/// …and the rewritten `moov` bytes they may hold together. The newest entry
/// is kept whatever its size.
const MOOV_PATCH_CACHE_BYTES: usize = MAX_MOOV_BYTES as usize;

/// The file a decision was made for: the same URI, size and modification time
/// (契約5).
#[derive(PartialEq, Eq)]
struct PatchKey {
    uri: String,
    size: u64,
    modified: i64,
}

/// What was decided for the movies served lately, newest first: the rewritten
/// `moov`, or `None` for "served as it is".
///
/// A media element reads a movie as a run of `Range` requests, and each one
/// would otherwise walk the top-level boxes and read and parse the `moov`
/// again. Remembering the decision also keeps it the same for the whole run,
/// so the sizes the requests report agree.
type PatchCache = VecDeque<(PatchKey, Option<Arc<MoovPatch>>)>;

static MOOV_PATCHES: Mutex<PatchCache> = Mutex::new(VecDeque::new());

/// The rewritten `moov` to serve `uri` (a movie of `total` bytes) with, or
/// `None` to serve the file as it is.
///
/// Issue #591: x265's default open-GOP output lists its CRAs as full sync
/// samples, and a paused accurate seek in WKWebView then decodes from the CRA
/// and cannot show the RASL frames ahead of it — the frame number moves, the
/// picture does not. Serving those CRAs as partial sync samples
/// (`video_sync`) lets the seek start a GOP earlier.
///
/// Issue #734: with x264's `open-gop`, a seek that starts decoding at a
/// non-IDR I fails on its leading B-frames, and past the first GOP only the I
/// frames show. Serving an I with one leading frame as a partial sync sample,
/// with that frame marked in `sdtp` as one no other depends on, and an I with
/// more as no sync sample at all (`video_sync`, "fs") lets every frame decode.
///
/// The decision is remembered when the provider reports a modification time;
/// a read that fails is not, and the file is served as it is this time.
async fn moov_patch(
    provider: &dyn FileProvider,
    uri: &Uri,
    total: u64,
    modified: Option<i64>,
) -> Option<Arc<MoovPatch>> {
    let key = modified.map(|modified| PatchKey {
        uri: uri.raw.clone(),
        size: total,
        modified,
    });
    if let Some(remembered) = key.as_ref().and_then(remembered_patch) {
        return remembered;
    }
    let patch = find_moov_patch(provider, uri, total)
        .await
        .ok()?
        .map(Arc::new);
    if let Some(key) = key {
        remember_patch(key, patch.clone());
    }
    patch
}

/// Walk the top-level boxes — read as `get_video_frame_index` reads them — and
/// rewrite the `moov` when it is worth it (契約4: any doubt serves the file as
/// it is).
///
/// - The file has to start with `ftyp`; a `moof` anywhere means fragmented.
/// - Whether the `moov` is ahead of the media data decides whether the chunk
///   offsets move. Without an `mdat`, or with one on both sides, where they
///   point is not certain, and nothing is rewritten.
/// - A `moov` over `MAX_MOOV_BYTES` is not read, as in `get_video_frame_index`.
///
/// `Err` only for a read that failed.
async fn find_moov_patch(
    provider: &dyn FileProvider,
    uri: &Uri,
    total: u64,
) -> Result<Option<MoovPatch>, FsError> {
    let mut pos: u64 = 0;
    let mut moov = None;
    let (mut mdat_before, mut mdat_after) = (false, false);
    for _ in 0..MAX_TOP_LEVEL_BOXES {
        if pos >= total {
            break;
        }
        let header = provider.read_range(uri, pos, BOX_HEADER_LEN).await?;
        let Some((kind, size)) = top_level_box(&header, total - pos) else {
            return Ok(None);
        };
        if pos == 0 && &kind != b"ftyp" {
            return Ok(None);
        }
        match &kind {
            b"moov" if moov.is_none() => moov = Some((pos, size)),
            b"mdat" if moov.is_some() => mdat_after = true,
            b"mdat" => mdat_before = true,
            b"moof" => return Ok(None),
            _ => {}
        }
        pos += size;
    }
    if pos < total {
        return Ok(None);
    }

    let Some((offset, len)) = moov else {
        return Ok(None);
    };
    let position = match (mdat_before, mdat_after) {
        (false, true) => MoovPosition::BeforeMdat,
        (true, false) => MoovPosition::AfterMdat,
        _ => return Ok(None),
    };
    if len > MAX_MOOV_BYTES {
        return Ok(None);
    }
    let original = provider.read_range(uri, offset, len).await?;
    Ok(
        rewrite_moov_for_open_gop(&original, position).map(|moov| MoovPatch {
            offset,
            original_len: len,
            moov,
        }),
    )
}

/// Bytes `[start, start + len)` of the rewritten file: the original's bytes
/// around the rewritten `moov`.
async fn read_patched(
    provider: &dyn FileProvider,
    uri: &Uri,
    patch: &MoovPatch,
    start: u64,
    len: u64,
) -> Result<Vec<u8>, FsError> {
    let mut out = Vec::new();
    for piece in patch.pieces(start, len) {
        match piece {
            Piece::Original { offset, len } => {
                out.extend(provider.read_range(uri, offset, len).await?)
            }
            Piece::Moov { start, len } => out.extend_from_slice(&patch.moov[start..start + len]),
        }
    }
    Ok(out)
}

/// The remembered decision for `key` (the outer `None` is "not remembered").
fn remembered_patch(key: &PatchKey) -> Option<Option<Arc<MoovPatch>>> {
    let mut cache = MOOV_PATCHES.lock().unwrap_or_else(PoisonError::into_inner);
    let at = cache.iter().position(|(k, _)| k == key)?;
    let entry = cache.remove(at)?;
    let patch = entry.1.clone();
    cache.push_front(entry);
    Some(patch)
}

/// Remember the decision for `key`, in place of any for an older version of
/// the same file, and drop the oldest beyond the bounds.
fn remember_patch(key: PatchKey, patch: Option<Arc<MoovPatch>>) {
    let mut cache = MOOV_PATCHES.lock().unwrap_or_else(PoisonError::into_inner);
    cache.retain(|(k, _)| k.uri != key.uri);
    cache.push_front((key, patch));
    let held = |cache: &PatchCache| -> usize {
        cache
            .iter()
            .filter_map(|(_, patch)| patch.as_ref())
            .map(|patch| patch.moov.len())
            .sum()
    };
    while cache.len() > 1
        && (cache.len() > MOOV_PATCH_CACHE_ENTRIES || held(&cache) > MOOV_PATCH_CACHE_BYTES)
    {
        cache.pop_back();
    }
}

/// Handle a `vellis-asset://` request from the webview `label` — the entry
/// point the protocol handler in `lib.rs` calls (要件#27 追補b 契約2).
///
/// A `vellis-asset://ssh/<authority>/…` request — whatever its method, a CORS
/// preflight included — is passed on to [`handle_asset`] only when
/// `<authority>` is one the window may reach
/// (`allowed_ssh_authorities`); otherwise it is answered `403` from
/// [`error_response`] — CSP and CORS headers included — **before any
/// connection is opened** (契約1). This is what keeps an image URI written
/// into a document from connecting to a host the user never opened (Issue
/// #728): the frontend keeps `vellis-asset:` sources, and the CSP allows them,
/// so this is the place that can tell them apart.
///
/// The authorities are compared as `Uri::parse` gives them, value for value:
/// an alias and the host it resolves to, an omitted port and `22`, an omitted
/// user and the default one are all different. Image URIs are built from the
/// document's own URI (`toAssetUri`), so a document's images carry exactly its
/// authority. Resolving aliases first would mean running `ssh -G` on a name
/// taken from the document before deciding — the thing being guarded against.
///
/// Everything else goes to [`handle_asset`] as is, without looking at
/// `label`: `vellis-asset://local/…`, and a URI that does not parse (which
/// `handle_asset` answers `400`).
///
/// The window manager's lock is held only while the allowed authorities are
/// read, never while the provider connects.
pub async fn handle_asset_for_window(
    state: &AppState,
    label: &str,
    req: http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    if let Ok(target) = parse_asset_uri(&req.uri().to_string()) {
        if target.scheme == "ssh" {
            let allowed = allowed_ssh_authorities(state, label).await;
            let reachable = target
                .authority
                .as_ref()
                .is_some_and(|authority| allowed.contains(authority));
            if !reachable {
                return error_response(403, "ssh host not open in this window");
            }
        }
    }
    handle_asset(state, req).await
}

/// The ssh authorities the window `label` may load assets from
/// (要件#27 追補b 契約1): the authority of its root and that of the document
/// it has open, each only when that URI is `ssh://`.
///
/// - A print window (`is_print_window`) borrows the allowance of the window
///   that asked for it (`WindowManager::print_owner`); with no owner
///   recorded, or an owner that has closed, it has none.
/// - A label the window manager does not know has none.
///
/// The lock is released when this returns.
async fn allowed_ssh_authorities(state: &AppState, label: &str) -> Vec<Authority> {
    let manager = state.window_manager.lock().await;
    let window_label = if is_print_window(label) {
        match manager.print_owner(label) {
            Some(owner) => owner,
            None => return Vec::new(),
        }
    } else {
        label
    };
    let Some(window) = manager.get(window_label) else {
        return Vec::new();
    };
    let document = window.session.as_ref().map(|session| &session.uri);
    window
        .root_uri
        .iter()
        .chain(document)
        .filter(|uri| uri.scheme == "ssh")
        .filter_map(|uri| uri.authority.clone())
        .collect()
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
