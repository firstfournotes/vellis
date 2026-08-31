//! The print-only window and the one-shot documents it loads
//! (requirements.md #38).
//!
//! Printing has always been `Webview::print()` on the focused window, with
//! `src/styles/print.css` deciding what reaches the paper. That works for
//! Markdown and text, but the HTML viewer (要件#8) shows its document inside a
//! sandboxed `<iframe srcdoc>`, and WebKit does not expand an iframe's contents
//! into the main frame's print output — so ⌘P over an HTML file produced a
//! blank sheet (backlog #82).
//!
//! The fix is a second window. The frontend builds the same preprocessed
//! snapshot the viewer is showing (`src/lib/print-html.ts` の
//! `buildPrintDocument`) and hands it to the `print_html` command; the document
//! is parked in a [`PrintDocumentStore`], a print-only window is opened on the
//! [`PRINT_SCHEME`] URL that serves it, and `print()` is called on *that*
//! window once it has finished loading.
//!
//! Two constraints from the 2026-08-30 probe shape everything here:
//!
//! - The document must be **loaded from a real URL**. Creating the window on
//!   `about:blank` and filling it in with `document.write` made WKWebView
//!   return nil from `printOperationWithPrintInfo:`, which **wry 0.54.4
//!   unwraps** — the whole app panics. That is why there is a custom protocol
//!   at all, and why [`open_print_window`] waits for `PageLoadEvent::Finished`
//!   and simply gives up (window closed, error returned) rather than calling
//!   `print()` on a webview that may not be ready.
//! - The window has to be **visible**. `visible(false)` prints, but AppKit
//!   forces the window on screen anyway to hang the print sheet off it, so a
//!   "hidden" print window is a fiction.
//!
//! The window carries no app JavaScript: the protocol serves the document and
//! nothing else, and its label does not match any capability in
//! `capabilities/default.json`, so the print document has no command surface to
//! reach even if it could run script — which it cannot, because the response
//! carries [`PRINT_CSP`] and the document carries the same policy in a `<meta>`
//! (`PRINT_CSP_META`, frontend side). That doubling is the printing half of
//! 要件#8's "scripts do not run": the print window is outside the viewer's
//! sandbox, so the CSP is what stands in its place.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::mpsc;
use ulid::Ulid;

/// Scheme the print window loads its document from. Registered on the builder
/// (`lib.rs`) and used to mint URLs by [`print_document_url`], so both sides
/// read the same constant — the same arrangement as `vellis-asset`.
pub const PRINT_SCHEME: &str = "vellis-print";

/// Authority of a print document URL. A fixed host keeps the identifier in the
/// path, where nothing normalises its case (a URL's host may be lowercased;
/// the id is Crockford base32 and is not).
const PRINT_DOCUMENT_HOST: &str = "document";

/// Content-Security-Policy served with every print document, and the same
/// policy the document carries in a `<meta>` of its own (`PRINT_CSP_META` in
/// `src/lib/print-html.ts` — keep the two in step).
///
/// Only the executable things are barred. `default-src` is deliberately absent:
/// images, styles and fonts must still resolve through the injected `<base>` to
/// `vellis-asset:` so the paper shows what the screen shows.
const PRINT_CSP: &str = "script-src 'none'; object-src 'none'";

/// Prefix of a print window's label. It matches neither `main` nor `vellis-*`,
/// so `capabilities/default.json` does not cover the print window and the
/// document it holds has no Tauri command available to it.
const PRINT_WINDOW_LABEL_PREFIX: &str = "print-";

/// Whether `label` names a print window.
///
/// Menu clicks are handed to "the focused window" (`menu::focused_or_first_window`)
/// on the understanding that the window has a frontend listening. A print
/// window does not — it holds one static document and no app JavaScript — so it
/// has to be kept out of that choice, or a print window left open would swallow
/// Open… / Duplicate Window / the zoom items.
pub fn is_print_window(label: &str) -> bool {
    label.starts_with(PRINT_WINDOW_LABEL_PREFIX)
}

/// Title of the print window. English, like every other window-level string
/// the app shows (要件#35 ③). The file name is not available here — the
/// command receives the document and nothing else.
const PRINT_WINDOW_TITLE: &str = "Print";

/// Initial size of the print window. Roughly a portrait page, so what the user
/// sees before the print sheet appears already resembles the output.
const PRINT_WINDOW_SIZE: (f64, f64) = (720.0, 900.0);

/// How long to wait for the print document to finish loading. Past this the
/// window is closed and `print()` is never called — the panic above is far
/// worse than a print that did not happen.
const LOAD_TIMEOUT: Duration = Duration::from_secs(10);

/// Extra pause between "the page finished loading" and `print()`. The load
/// event and the moment WKWebView can build a print operation are not the same
/// instant (probe, 2026-08-30).
const PRINT_SETTLE: Duration = Duration::from_millis(500);

/// The documents waiting to be printed, keyed by the identifier that appears in
/// their URL.
///
/// One-shot by design: [`take`](Self::take) removes as it reads, so a document
/// is served exactly once and a reload of the print window cannot bring the raw
/// HTML back. Methods take `&self` because the protocol handler reaches the
/// store through Tauri's managed state, which hands out shared references.
pub struct PrintDocumentStore {
    documents: Mutex<HashMap<String, String>>,
}

impl PrintDocumentStore {
    pub fn new() -> Self {
        Self {
            documents: Mutex::new(HashMap::new()),
        }
    }

    /// Park `document` and return the identifier its URL will carry.
    ///
    /// The identifier is a ULID: unique without coordination, and spelled in
    /// Crockford base32, so it needs no percent-encoding to sit in a path.
    pub fn register(&self, document: String) -> String {
        let id = Ulid::new().to_string();
        self.documents().insert(id.clone(), document);
        id
    }

    /// Read a document out of the store, removing it. `None` for an unknown
    /// identifier and for the second read of the same one.
    pub fn take(&self, id: &str) -> Option<String> {
        self.documents().remove(id)
    }

    /// The map, recovered from a poisoned lock rather than propagating the
    /// panic. Nothing inside the guard can panic (insert / remove on a
    /// `HashMap`), so a poisoned lock would have to come from elsewhere — and
    /// a print that fails is not worth taking the app down for.
    fn documents(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.documents
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Default for PrintDocumentStore {
    fn default() -> Self {
        Self::new()
    }
}

/// The URL the print window loads for the document registered under `id`.
///
/// A real URL, navigated to normally — see the module docs for why nothing
/// here may go through `about:blank`.
pub fn print_document_url(id: &str) -> String {
    format!("{PRINT_SCHEME}://{PRINT_DOCUMENT_HOST}/{id}")
}

/// The document identifier in a print URL, or `None` when the URL is not one.
///
/// Kept deliberately strict: the scheme, the fixed host and a single non-empty
/// path segment of unreserved characters. Anything else — another scheme, a
/// missing id, a path that tries to say something more — is not a URL this
/// handler minted, and is turned away rather than interpreted.
fn document_id_from_url(url: &str) -> Option<&str> {
    let rest = url.strip_prefix(PRINT_SCHEME)?.strip_prefix("://")?;
    // A print URL carries neither query nor fragment; drop them before the id
    // is read so a decorated URL is rejected on the id's shape, not silently
    // matched with the decoration attached.
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let id = rest.strip_prefix(PRINT_DOCUMENT_HOST)?.strip_prefix('/')?;
    let unreserved = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~');
    if id.is_empty() || !id.chars().all(unreserved) {
        return None;
    }
    Some(id)
}

/// Serve a print document: `200` with the document bytes for a URL whose id is
/// in the store, `404` once it has been served (or was never registered), `400`
/// for anything that is not a print URL at all.
///
/// Never panics: the print window is not the only thing that can reach a
/// registered scheme, and a malformed request must be an error page, not a
/// crash.
pub fn handle_print_protocol(store: &PrintDocumentStore, url: &str) -> http::Response<Vec<u8>> {
    let Some(id) = document_id_from_url(url) else {
        return error_response(http::StatusCode::BAD_REQUEST, "invalid print document url");
    };
    match store.take(id) {
        Some(document) => document_response(document),
        None => error_response(http::StatusCode::NOT_FOUND, "print document not found"),
    }
}

/// `200 text/html` carrying the document, under [`PRINT_CSP`].
fn document_response(document: String) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(http::StatusCode::OK)
        .header(http::header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(http::header::CONTENT_SECURITY_POLICY, PRINT_CSP)
        .header(http::header::CACHE_CONTROL, "no-store")
        .body(document.into_bytes())
        .expect("failed to build print document response")
}

/// A plain-text error page, carrying the same policy as a real document so a
/// mistake cannot become a laxer context than a success.
fn error_response(status: http::StatusCode, message: &str) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(http::header::CONTENT_SECURITY_POLICY, PRINT_CSP)
        .header(http::header::CACHE_CONTROL, "no-store")
        .body(message.as_bytes().to_vec())
        .expect("failed to build print error response")
}

/// Open a print window on `document` and, once it has loaded, print it.
///
/// The window stays open afterwards: on macOS the print sheet hangs off this
/// very window, so closing it here would take the sheet with it. Closing is the
/// user's (initial version — an automatic close after the sheet is dismissed is
/// a follow-up).
///
/// The window is not registered with `WindowManager`. It is not a document
/// window: it must not appear in the window count that decides when the app
/// exits, and it has no root, document or expansion state to restore.
/// `tauri://destroyed` calls `unregister_window` for it and finds nothing,
/// which is the intended no-op.
pub async fn open_print_window(app: &AppHandle, document: String) -> Result<(), String> {
    let store = app.state::<PrintDocumentStore>();
    let id = store.register(document);
    let label = format!("{PRINT_WINDOW_LABEL_PREFIX}{id}");
    let url = print_document_url(&id)
        .parse::<Url>()
        .map_err(|e| format!("cannot build print document url: {e}"))?;

    // `on_page_load` is an `Fn`, so it cannot consume a oneshot sender. A
    // capacity-1 channel gives the same "tell me once" semantics and keeps the
    // notification buffered if it arrives before the wait starts.
    let (loaded_tx, mut loaded_rx) = mpsc::channel::<()>(1);

    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::CustomProtocol(url))
        .title(PRINT_WINDOW_TITLE)
        .inner_size(PRINT_WINDOW_SIZE.0, PRINT_WINDOW_SIZE.1)
        .center()
        .on_page_load(move |_window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = loaded_tx.try_send(());
            }
        })
        .build()
        .map_err(|e| {
            // The document was never served, so it would sit in the store
            // forever otherwise.
            app.state::<PrintDocumentStore>().take(&id);
            format!("cannot open the print window: {e}")
        })?;

    // Nothing below may call `print()` without this having succeeded — see the
    // module docs on the wry panic.
    let loaded = tokio::time::timeout(LOAD_TIMEOUT, loaded_rx.recv()).await;
    if !matches!(loaded, Ok(Some(()))) {
        tracing::warn!(
            "print document '{}' did not finish loading within {}s — not printing",
            id,
            LOAD_TIMEOUT.as_secs()
        );
        app.state::<PrintDocumentStore>().take(&id);
        if let Err(e) = window.close() {
            tracing::warn!("failed to close the stalled print window '{}': {}", label, e);
        }
        return Err(String::from("the print document did not finish loading"));
    }

    tokio::time::sleep(PRINT_SETTLE).await;
    window
        .print()
        .map_err(|e| format!("cannot open the print dialog: {e}"))
}
