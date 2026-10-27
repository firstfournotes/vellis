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
//! [`PRINT_SCHEME`] URL that serves it, and *that* window is printed once it
//! has finished loading.
//!
//! Two constraints from the 2026-08-30 probe shape everything here:
//!
//! - The document must be **loaded from a real URL**. Creating the window on
//!   `about:blank` and filling it in with `document.write` made WKWebView
//!   return nil from `printOperationWithPrintInfo:`, which **wry 0.54.4
//!   unwraps** — the whole app panics. The print window no longer prints
//!   through wry and takes a nil operation as an error (追補n), but a webview
//!   that is not ready still has nothing to print. That is why there is a
//!   custom protocol at all, and why [`open_print_window`] waits for
//!   `PageLoadEvent::Finished` and simply gives up (window closed, error
//!   returned) rather than printing a webview that may not be ready.
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
//!
//! The print window looks after itself (要件#38 追補m・Issue #459 / #461).
//! There is at most one: a second request brings the open one to the front
//! instead of opening another ([`existing_print_window`]). On macOS it is not
//! printed with wry's `print()`, which hands AppKit no delegate and so never
//! hears when printing ends (要件#38 追補n・Issue #718). It runs a print
//! operation of its own, set up the way wry sets up its, whose delegate closes
//! the window once the operation is over — printed, saved or cancelled, the
//! user does not close it by hand. While a print window is open the app does
//! not exit, even with every document window closed; once it closes with
//! nothing else open, the app exits (要件#12 追補a).
//!
//! PDFs take a third route (要件#38 追補g・backlog 307). The PDF viewer shows
//! the file inside an `<iframe>` that WebKit's own PDF plug-in draws, so the
//! main-frame print only put on paper what the iframe had on screen — roughly
//! the first fifth of the document. Printing the *file* instead is what
//! Preview does, so that is what [`print_pdf_in_window`] does: the bytes go
//! into PDFKit's `PDFDocument`, and the print operation PDFKit builds from it
//! runs as a sheet of the window that asked. No crate is added for this —
//! PDFKit is reached through the Objective-C runtime (`objc2`) and linked as a
//! framework, the same way `window/tab.rs` talks to `NSWindow`.
//!
//! A local PDF is not handed over as bytes at all (要件#38 追補k・Issue #665):
//! [`print_pdf_path_in_window`] gives PDFKit the file's path and lets it read
//! the file itself (`initWithURL:`). Reading the whole file first went through
//! `read_bytes` and its 50 MB cap, so a PDF the viewer could show (it streams
//! through `vellis-asset:`) could not be printed. Nothing in this module reads
//! a file; only the bytes route (`ssh://`) comes in already read.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::mpsc;
use ulid::Ulid;

use crate::commands::AppState;

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

/// The first print window among `labels` — the open windows' labels in the
/// order `app.webview_windows()` gives them — or `None` when there is none
/// (要件#38 追補m 契約3).
///
/// [`open_print_window`] asks this before it opens a window: a print window
/// already on screen is brought to the front instead of a second one being
/// opened next to it.
pub fn existing_print_window<'a>(labels: &[&'a str]) -> Option<&'a str> {
    labels.iter().copied().find(|label| is_print_window(label))
}

/// Held from "is a print window open?" until a new one has been built, so two
/// print requests close together cannot both find none and both open one
/// (要件#38 追補m 契約3 — a window still being opened counts as open).
static PRINT_WINDOW_OPENING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Title of the print window. English, like every other window-level string
/// the app shows (要件#35 ③). The file name is not available here — the
/// command receives the document and nothing else.
const PRINT_WINDOW_TITLE: &str = "Print";

/// Initial size of the print window. Roughly a portrait page, so what the user
/// sees before the print sheet appears already resembles the output.
const PRINT_WINDOW_SIZE: (f64, f64) = (720.0, 900.0);

/// How long to wait for the print document to finish loading. Past this the
/// window is closed and printing is never started — a webview that is not
/// ready has nothing to print (the module docs on the wry panic).
const LOAD_TIMEOUT: Duration = Duration::from_secs(10);

/// Extra pause between "the page finished loading" and starting to print. The
/// load event and the moment WKWebView can build a print operation are not
/// the same instant (probe, 2026-08-30).
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

/// What the File > Print… item should do when a window comes to the front
/// (requirements.md #38 追補f).
///
/// `Unchanged` is the print window's answer: it carries no frontend, never
/// reports, and is kept out of every other menu decision too
/// (`menu::focused_or_first_window`), so it leaves the item as the document
/// window before it set it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrintItemState {
    Enabled,
    Disabled,
    Unchanged,
}

/// Which windows have a printable document open, as each window last reported
/// it through `set_print_available` (requirements.md #38 追補f).
///
/// The menu is one for the whole app, while "is there anything to print"
/// belongs to each window — the history picker and the empty state have
/// nothing to put on paper (backlog 251). So every window tells the app, the
/// app remembers per label, and the Print… item is re-applied from the
/// frontmost window's entry whenever that window changes or reports.
///
/// A window that has never reported counts as "nothing open": a window starts
/// on the picker or the empty state, and enabling Print… for a window whose
/// frontend has not spoken yet would bring the blank sheet back. Methods take
/// `&self` for the same reason as [`PrintDocumentStore`]: the command and the
/// window events reach it through managed state.
pub struct PrintAvailability {
    windows: Mutex<HashMap<String, bool>>,
}

impl PrintAvailability {
    pub fn new() -> Self {
        Self {
            windows: Mutex::new(HashMap::new()),
        }
    }

    /// Remember what window `label` reported; the latest report wins.
    pub fn set(&self, label: &str, available: bool) {
        self.windows().insert(label.to_string(), available);
    }

    /// Drop what window `label` reported, once the window is gone. Unknown
    /// labels are a no-op.
    pub fn forget(&self, label: &str) {
        self.windows().remove(label);
    }

    /// The Print… item's state while window `label` is frontmost.
    pub fn print_item_state(&self, label: &str) -> PrintItemState {
        if is_print_window(label) {
            return PrintItemState::Unchanged;
        }
        match self.windows().get(label) {
            Some(true) => PrintItemState::Enabled,
            Some(false) | None => PrintItemState::Disabled,
        }
    }

    /// The map, recovered from a poisoned lock for the same reason as the
    /// print document store's: nothing here is worth a panic.
    fn windows(&self) -> std::sync::MutexGuard<'_, HashMap<String, bool>> {
        self.windows
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Default for PrintAvailability {
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
/// One print window at a time (要件#38 追補m 契約3): when one is already open
/// — one still loading counts — it is brought to the front and the request is
/// answered `Ok(())` without opening another. The new document is dropped
/// unparked.
///
/// The window does not close when printing starts: on macOS the print sheet
/// hangs off this very window, so closing it then would take the sheet with
/// it. Instead the window runs a print operation of its own, whose delegate
/// closes the window once the operation is over — printed, saved as PDF or
/// cancelled (追補n, `start_print_operation`). The reply to the caller does
/// not wait for that; it comes once the operation is ready to run. An
/// operation that cannot be started closes the window and comes back as
/// `Err`. Other platforms keep wry's `print()` and leave the window to the
/// user to close.
///
/// The window is not registered with `WindowManager`. It is not a document
/// window and has no root, document or expansion state to restore. The app's
/// exit decision (`on_window_event`'s `Destroyed`, 要件#12 追補a) counts print
/// windows on their own: the app exits only when neither a document window nor
/// a print window is left, so closing every document window while printing
/// keeps the app running until this window closes (追補m 契約2).
///
/// What is recorded there is `owner` — the label of the window that asked —
/// as the new print window's owner (`WindowManager::set_print_owner`), before
/// the window starts loading: the document's `vellis-asset://ssh/…` images
/// are served only from a host the owner has open (要件#27 追補b). The record
/// goes when the window is destroyed (`on_window_event`), or here when it
/// could not be built. Bringing an open print window to the front leaves the
/// record as it is.
pub async fn open_print_window(
    app: &AppHandle,
    document: String,
    owner: &str,
) -> Result<(), String> {
    let opening = PRINT_WINDOW_OPENING.lock().await;
    let windows = app.webview_windows();
    let labels: Vec<&str> = windows.keys().map(String::as_str).collect();
    if let Some(open) = existing_print_window(&labels) {
        if let Some(window) = windows.get(open) {
            if let Err(e) = window.set_focus() {
                tracing::warn!(
                    "failed to bring the print window '{}' to the front: {}",
                    open,
                    e
                );
            }
        }
        return Ok(());
    }

    let store = app.state::<PrintDocumentStore>();
    let id = store.register(document);
    let label = format!("{PRINT_WINDOW_LABEL_PREFIX}{id}");
    let url = print_document_url(&id)
        .parse::<Url>()
        .map_err(|e| format!("cannot build print document url: {e}"))?;
    if let Some(state) = app.try_state::<AppState>() {
        state
            .window_manager
            .lock()
            .await
            .set_print_owner(label.clone(), owner.to_string());
    }

    // `on_page_load` is an `Fn`, so it cannot consume a oneshot sender. A
    // capacity-1 channel gives the same "tell me once" semantics and keeps the
    // notification buffered if it arrives before the wait starts.
    let (loaded_tx, mut loaded_rx) = mpsc::channel::<()>(1);

    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::CustomProtocol(url))
        .title(PRINT_WINDOW_TITLE)
        // A tab group key of its own (requirements.md #62 契約2): every window
        // needs one, or tao turns window tabbing off app-wide, and the
        // `vellis-print:` prefix keeps it out of every document window's group.
        .tabbing_identifier(&format!("vellis-print:{label}"))
        .inner_size(PRINT_WINDOW_SIZE.0, PRINT_WINDOW_SIZE.1)
        .center()
        .on_page_load(move |_window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = loaded_tx.try_send(());
            }
        })
        .build();
    let window = match window {
        Ok(window) => window,
        Err(e) => {
            // The document was never served, so it would sit in the store
            // forever otherwise; and a window that never opened is never
            // destroyed, so its owner record goes here too.
            app.state::<PrintDocumentStore>().take(&id);
            if let Some(state) = app.try_state::<AppState>() {
                state.window_manager.lock().await.remove_print_owner(&label);
            }
            return Err(format!("cannot open the print window: {e}"));
        }
    };
    // The window is in `webview_windows()` from here on, so the next request
    // finds it.
    drop(opening);

    // Nothing below may start printing without this having succeeded — see
    // the module docs on the wry panic.
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
    #[cfg(target_os = "macos")]
    {
        if let Err(e) = start_print_operation(&window).await {
            // No sheet came up, so no delegate will ever close the window (契約4).
            if let Err(close_err) = window.close() {
                tracing::warn!(
                    "failed to close the print window '{}' that could not print: {}",
                    label,
                    close_err
                );
            }
            return Err(e);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        window
            .print()
            .map_err(|e| format!("cannot open the print dialog: {e}"))?;
    }
    Ok(())
}

/// Start the print window's own print operation (要件#38 追補n 契約1・4).
///
/// The operation is built on the main thread (`run_on_main_thread`), where
/// AppKit's print panel has to be, and runs as a sheet of `window`; its
/// delegate closes the window once it is over (契約2). The sheet is not run
/// inside that closure but from a 0-delay timer on the next pass of the main
/// run loop (追補o, [`window_print::schedule_print_sheet`]). This resolves as
/// soon as the operation has been built — before it runs, so the reply to the
/// caller never waits on the sheet. `Err` when it cannot be started: the main
/// thread cannot be reached, the window has no `NSWindow` or no `WKWebView`,
/// or the web view will not build a print operation.
#[cfg(target_os = "macos")]
async fn start_print_operation(window: &tauri::WebviewWindow) -> Result<(), String> {
    use std::panic::{catch_unwind, AssertUnwindSafe};

    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            // The closure runs inside the event loop's callback, where an
            // unwinding panic would stop the app (`window/tab.rs` の run_on_main).
            let built = catch_unwind(AssertUnwindSafe(|| {
                window_print::build_print_operation(&target)
            }))
            .unwrap_or_else(|_| {
                Err(String::from(
                    "cannot open the print dialog: printing failed unexpectedly",
                ))
            });
            let operation = match built {
                Ok(operation) => operation,
                Err(e) => {
                    let _ = started_tx.send(Err(e));
                    return;
                }
            };
            // Answered before the sheet runs, so the reply never waits on it.
            let _ = started_tx.send(Ok(()));
            let app = target.app_handle().clone();
            let label = target.label().to_string();
            // Not run here: this closure runs inside tao's run loop observer,
            // and a sheet started from there can crash PrintingUI as the panel
            // comes up (#715). A timer starts it on the next pass instead.
            let ran = catch_unwind(AssertUnwindSafe(|| {
                window_print::schedule_print_sheet(operation, app, label)
            }));
            if ran.is_err() {
                // No delegate will close the window now; do it here.
                tracing::warn!(
                    "scheduling the print sheet of '{}' panicked — closing the window",
                    target.label()
                );
                if let Err(e) = target.close() {
                    tracing::warn!(
                        "failed to close the print window '{}': {}",
                        target.label(),
                        e
                    );
                }
            }
        })
        .map_err(|e| format!("cannot open the print dialog: {e}"))?;
    started_rx
        .await
        .map_err(|_| String::from("cannot open the print dialog: the window went away"))?
}

/// Page count of `bytes` as PDFKit reads them (要件#38 追補g).
///
/// The document is built exactly the way [`print_pdf_in_window`] builds the
/// one it prints (`PDFDocument initWithData:`), so "this opens with N pages"
/// here is the same judgement the print route makes before showing a sheet.
/// Bytes PDFKit cannot open — empty, not a PDF, or a PDF with no pages — are an
/// `Err` carrying a message the frontend can show as is (`printFailedMessage`).
///
/// Does not need the main thread: nothing here touches AppKit.
#[cfg(target_os = "macos")]
pub fn pdf_page_count(bytes: &[u8]) -> Result<usize, String> {
    objc2::rc::autoreleasepool(|_| pdfkit::open(bytes).map(|(_, pages)| pages))
}

/// Page count of the PDF at `path`, opened by PDFKit from the path
/// (要件#38 追補k).
///
/// The path counterpart of [`pdf_page_count`]: the document is built the way
/// [`print_pdf_path_in_window`] builds the one it prints
/// (`PDFDocument initWithURL:`), and PDFKit reads the file — it is never copied
/// into memory here first. A path PDFKit cannot open (missing, not a PDF) or a
/// PDF with no pages is an `Err` worded exactly as the bytes route words it.
///
/// Does not need the main thread: nothing here touches AppKit.
#[cfg(target_os = "macos")]
pub fn pdf_page_count_at_path(path: &std::path::Path) -> Result<usize, String> {
    objc2::rc::autoreleasepool(|_| pdfkit::open_path(path).map(|(_, pages)| pages))
}

/// Print `bytes` — a whole PDF file — as a sheet of `window` (要件#38 追補g).
///
/// The `PDFDocument` is built and the print operation run on the main thread
/// (`run_on_main_thread`): AppKit's print panel is main-thread only, and the
/// document is built there too rather than handed across, because an
/// Objective-C object is not `Send`. If the bytes do not open as a PDF with at
/// least one page, no sheet is shown and the reason comes back as `Err`.
///
/// The sheet is modeless — `runOperationModalForWindow:…` returns as soon as it
/// is attached — so this resolves once the sheet is up, not when the user is
/// done with it, the same as `Webview::print()` on the other routes.
#[cfg(target_os = "macos")]
pub async fn print_pdf_in_window<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    bytes: Vec<u8>,
) -> Result<(), String> {
    use std::panic::{catch_unwind, AssertUnwindSafe};

    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            // The closure runs inside the event loop's callback, where an
            // unwinding panic would stop the app (`window/tab.rs` の run_on_main).
            let result = catch_unwind(AssertUnwindSafe(|| pdfkit::print_as_sheet(&target, &bytes)))
                .unwrap_or_else(|_| Err(String::from("printing the PDF failed unexpectedly")));
            let _ = done_tx.send(result);
        })
        .map_err(|e| format!("cannot open the print dialog: {e}"))?;
    done_rx
        .await
        .map_err(|_| String::from("cannot open the print dialog: the window went away"))?
}

/// Printing a PDF file goes through PDFKit, which only macOS has.
#[cfg(not(target_os = "macos"))]
pub async fn print_pdf_in_window<R: tauri::Runtime>(
    _window: &tauri::Window<R>,
    _bytes: Vec<u8>,
) -> Result<(), String> {
    Err(String::from("printing a PDF is only supported on macOS"))
}

/// Print the PDF at `path` — a local file — as a sheet of `window`
/// (要件#38 追補k).
///
/// The same as [`print_pdf_in_window`] except for where the document comes
/// from: PDFKit opens the file from its path (`initWithURL:`) instead of from
/// bytes read beforehand, so a local PDF over `read_bytes`'s 50 MB cap prints
/// like any other. Everything after that is shared — the main thread, every
/// page, the sheet of the calling window, and the same `Err` (no sheet shown)
/// when the file does not open as a PDF with at least one page.
#[cfg(target_os = "macos")]
pub async fn print_pdf_path_in_window<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    path: std::path::PathBuf,
) -> Result<(), String> {
    use std::panic::{catch_unwind, AssertUnwindSafe};

    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            // Same guard as `print_pdf_in_window`: a panic must not unwind into
            // the event loop's callback.
            let result = catch_unwind(AssertUnwindSafe(|| {
                pdfkit::print_path_as_sheet(&target, &path)
            }))
            .unwrap_or_else(|_| Err(String::from("printing the PDF failed unexpectedly")));
            let _ = done_tx.send(result);
        })
        .map_err(|e| format!("cannot open the print dialog: {e}"))?;
    done_rx
        .await
        .map_err(|_| String::from("cannot open the print dialog: the window went away"))?
}

/// Printing a PDF file goes through PDFKit, which only macOS has.
#[cfg(not(target_os = "macos"))]
pub async fn print_pdf_path_in_window<R: tauri::Runtime>(
    _window: &tauri::Window<R>,
    _path: std::path::PathBuf,
) -> Result<(), String> {
    Err(String::from("printing a PDF is only supported on macOS"))
}

/// PDFKit through the Objective-C runtime. Kept to the calls the print routes
/// need — open (from bytes or from a path) and print as a sheet; nothing
/// outside this module sees an Objective-C object.
///
/// The print classes (`NSData`, `NSURL`, `NSPrintInfo`, `NSPrintOperation`) are
/// reached the same untyped way rather than through new `objc2-app-kit` /
/// `objc2-foundation` features: the AppKit feature set is pinned by 要件#62 追補a
/// (`acceptance_req62a.rs`), and these are a handful of messages.
#[cfg(target_os = "macos")]
mod pdfkit {
    use std::ffi::{c_void, CString};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject, Sel};
    use objc2::{class, msg_send};
    use objc2_app_kit::NSWindow;

    // `PDFDocument` lives in PDFKit, which nothing else in the app links.
    // Without this the class is simply not registered with the runtime and
    // `AnyClass::get` finds nothing.
    #[link(name = "PDFKit", kind = "framework")]
    extern "C" {}

    /// `kPDFPrintPageScaleDownToFit`: pages larger than the paper are shrunk,
    /// smaller ones print at their own size — Preview's default, and what
    /// 追補g 契約1 asks for. The viewer's zoom (要件#63) never reaches here.
    const SCALE_DOWN_TO_FIT: isize = 2;

    /// What both routes say when PDFKit gives no document back — the bytes are
    /// not a PDF, or (path route) the file is missing or unreadable.
    const NOT_A_PDF: &str = "the file could not be opened as a PDF";

    /// Build a `PDFDocument` from `bytes` and count its pages.
    pub(super) fn open(bytes: &[u8]) -> Result<(Retained<AnyObject>, usize), String> {
        let class = pdf_document_class()?;
        // SAFETY: `dataWithBytes:length:` copies `bytes.len()` bytes from a
        // valid slice (a zero length never dereferences the pointer). `alloc` /
        // `initWithData:` are PDFDocument's documented API with these argument
        // and return types; `initWithData:` returns nil (→ `None`) for data it
        // cannot read.
        let document: Option<Retained<AnyObject>> = unsafe {
            let data: Retained<AnyObject> = msg_send![
                class!(NSData),
                dataWithBytes: bytes.as_ptr().cast::<c_void>(),
                length: bytes.len()
            ];
            let allocated: Allocated<AnyObject> = msg_send![class, alloc];
            msg_send![allocated, initWithData: &*data]
        };
        with_pages(document)
    }

    /// Build a `PDFDocument` from the file at `path` and count its pages
    /// (追補k). PDFKit reads the file; nothing is read into memory here.
    pub(super) fn open_path(path: &Path) -> Result<(Retained<AnyObject>, usize), String> {
        let class = pdf_document_class()?;
        // The file-system representation is the path's own bytes, so a name
        // that is not valid UTF-8 still reaches PDFKit unchanged. A path cannot
        // hold a NUL; one that does names no file.
        let c_path =
            CString::new(path.as_os_str().as_bytes()).map_err(|_| String::from(NOT_A_PDF))?;
        // SAFETY: `fileURLWithFileSystemRepresentation:isDirectory:relativeToURL:`
        // (macOS 10.9+) reads the NUL-terminated string `c_path` owns for the
        // duration of the call, and a nil base URL is allowed; it returns nil
        // (→ `None`) when it cannot build a URL.
        let url: Option<Retained<AnyObject>> = unsafe {
            msg_send![
                class!(NSURL),
                fileURLWithFileSystemRepresentation: c_path.as_ptr(),
                isDirectory: false,
                relativeToURL: std::ptr::null::<AnyObject>()
            ]
        };
        let url = url.ok_or_else(|| String::from(NOT_A_PDF))?;
        // SAFETY: `alloc` / `initWithURL:` are PDFDocument's documented API with
        // these argument and return types; `initWithURL:` returns nil (→ `None`)
        // for a file that is missing or not a PDF.
        let document: Option<Retained<AnyObject>> = unsafe {
            let allocated: Allocated<AnyObject> = msg_send![class, alloc];
            msg_send![allocated, initWithURL: &*url]
        };
        with_pages(document)
    }

    /// `PDFDocument`, or an `Err` if PDFKit did not load.
    fn pdf_document_class() -> Result<&'static AnyClass, String> {
        AnyClass::get(c"PDFDocument").ok_or_else(|| String::from("PDFKit is not available"))
    }

    /// The checks both routes make on what PDFKit opened: a document came back,
    /// and it has at least one page. The page count comes back with it.
    fn with_pages(
        document: Option<Retained<AnyObject>>,
    ) -> Result<(Retained<AnyObject>, usize), String> {
        let document = document.ok_or_else(|| String::from(NOT_A_PDF))?;
        // SAFETY: `pageCount` is PDFDocument's documented API returning an
        // `NSUInteger`.
        let pages: usize = unsafe { msg_send![&*document, pageCount] };
        if pages == 0 {
            return Err(String::from("the PDF has no pages to print"));
        }
        Ok((document, pages))
    }

    /// Open `bytes` and run PDFKit's print operation as a sheet of `window`.
    /// Main thread only.
    pub(super) fn print_as_sheet<R: tauri::Runtime>(
        window: &tauri::Window<R>,
        bytes: &[u8],
    ) -> Result<(), String> {
        let (document, _) = open(bytes)?;
        run_as_sheet(window, &document)
    }

    /// Open the file at `path` and run PDFKit's print operation as a sheet of
    /// `window` (追補k). Main thread only.
    pub(super) fn print_path_as_sheet<R: tauri::Runtime>(
        window: &tauri::Window<R>,
        path: &Path,
    ) -> Result<(), String> {
        let (document, _) = open_path(path)?;
        run_as_sheet(window, &document)
    }

    /// Run the print operation PDFKit builds for `document` as a sheet of
    /// `window` — every page, scaled down to fit. Main thread only.
    fn run_as_sheet<R: tauri::Runtime>(
        window: &tauri::Window<R>,
        document: &AnyObject,
    ) -> Result<(), String> {
        let ptr = window
            .ns_window()
            .map_err(|e| format!("cannot open the print dialog: {e}"))?
            .cast::<NSWindow>();
        // SAFETY: `ns_window()` returns tao's own `NSWindow` for this window (or
        // null, which `retain` turns into `None`). We are on the main thread,
        // where the window is alive, and the handle keeps it so for the call.
        let ns_window = unsafe { Retained::retain(ptr) }
            .ok_or_else(|| String::from("cannot open the print dialog: the window is gone"))?;

        // The shared print info, like the other routes (`Webview::print()`), so
        // the printer and paper the user last chose carry over.
        // SAFETY: `+[NSPrintInfo sharedPrintInfo]` never returns nil, and
        // `printOperationForPrintInfo:scalingMode:autoRotate:` is PDFDocument's
        // documented API (macOS 10.7+) taking an `NSPrintInfo`, an `NSInteger`
        // and a `BOOL`; it returns nil when it cannot build an operation, which
        // becomes `None`.
        let operation: Option<Retained<AnyObject>> = unsafe {
            let info: Retained<AnyObject> = msg_send![class!(NSPrintInfo), sharedPrintInfo];
            msg_send![
                document,
                printOperationForPrintInfo: &*info,
                scalingMode: SCALE_DOWN_TO_FIT,
                autoRotate: true
            ]
        };
        let operation = operation
            .ok_or_else(|| String::from("cannot open the print dialog for this PDF"))?;
        // SAFETY: `runOperationModalForWindow:delegate:didRunSelector:contextInfo:`
        // with no delegate, no selector and a null context is documented as
        // allowed (wry's `print()` makes the same call). The operation retains
        // what it prints for as long as the sheet is up.
        unsafe {
            let _: () = msg_send![
                &*operation,
                runOperationModalForWindow: &*ns_window,
                delegate: std::ptr::null_mut::<AnyObject>(),
                didRunSelector: None::<Sel>,
                contextInfo: std::ptr::null_mut::<c_void>()
            ];
        }
        Ok(())
    }
}

/// The print window's own print operation (要件#38 追補n), through the
/// Objective-C runtime like [`pdfkit`]: the web view, the print info and the
/// print operation are reached with untyped messages rather than new
/// `objc2-app-kit` features or an `objc2-web-kit` dependency (要件#62 追補a).
///
/// The operation is set up exactly the way wry 0.54.4's `print()` sets up its
/// — the shared print info, every margin 0, allowed to spawn its own thread,
/// run as a sheet of the window — so what reaches the paper, and the printer
/// and paper the user last chose, do not change. What wry leaves out is the
/// delegate: [`PrintWindowDelegate`] is told when the operation is over and
/// closes the window. The same delegate starts the sheet, from a timer on the
/// next pass of the main run loop (追補o).
#[cfg(target_os = "macos")]
mod window_print {
    use std::cell::Cell;
    use std::ffi::c_void;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, NSObject};
    use objc2::{class, define_class, msg_send, sel, AnyThread, DefinedClass, Message};
    use objc2_app_kit::NSWindow;
    use tauri::{AppHandle, Manager, WebviewWindow};

    /// A print operation built for the print window's web view, with the
    /// window whose sheet it is to run as.
    pub(super) struct PrintOperation {
        operation: Retained<AnyObject>,
        ns_window: Retained<NSWindow>,
    }

    /// Build the print operation for `window`'s web view. Main thread only.
    ///
    /// `Err` when there is nothing to build it from — no `NSWindow`, no
    /// `WKWebView` in it, a web view that does not answer
    /// `printOperationWithPrintInfo:` (macOS 11+, which wry checks too) — or
    /// when the web view gives no operation back, which wry would unwrap.
    pub(super) fn build_print_operation(window: &WebviewWindow) -> Result<PrintOperation, String> {
        let ptr = window
            .ns_window()
            .map_err(|e| format!("cannot open the print dialog: {e}"))?
            .cast::<NSWindow>();
        // SAFETY: `ns_window()` returns tao's own `NSWindow` for this window (or
        // null, which `retain` turns into `None`). We are on the main thread,
        // where the window is alive, and the handle keeps it so for the call.
        let ns_window = unsafe { Retained::retain(ptr) }
            .ok_or_else(|| String::from("cannot open the print dialog: the window is gone"))?;
        let web_view = web_view_of(&ns_window).ok_or_else(|| {
            String::from("cannot open the print dialog: the print window has no web view")
        })?;

        // SAFETY: `respondsToSelector:` is NSObject's, taking a `SEL` and
        // returning a `BOOL`.
        let can_print: bool = unsafe {
            msg_send![&*web_view, respondsToSelector: sel!(printOperationWithPrintInfo:)]
        };
        if !can_print {
            return Err(String::from(
                "cannot open the print dialog: the web view cannot print",
            ));
        }

        // The shared print info, as wry uses, so the printer and paper the user
        // last chose carry over. Margins 0 are wry's `PrintMargin::default()`:
        // the print stylesheet sets the page's own.
        // SAFETY: `+[NSPrintInfo sharedPrintInfo]` never returns nil, and the
        // margin setters take a `CGFloat` (`f64`). `printOperationWithPrintInfo:`
        // is WKWebView's (macOS 11+, checked above), taking an `NSPrintInfo`;
        // it can return nil for a page that is not ready, which becomes `None`.
        let operation: Option<Retained<AnyObject>> = unsafe {
            let info: Retained<AnyObject> = msg_send![class!(NSPrintInfo), sharedPrintInfo];
            let _: () = msg_send![&*info, setTopMargin: 0.0];
            let _: () = msg_send![&*info, setRightMargin: 0.0];
            let _: () = msg_send![&*info, setBottomMargin: 0.0];
            let _: () = msg_send![&*info, setLeftMargin: 0.0];
            msg_send![&*web_view, printOperationWithPrintInfo: &*info]
        };
        let Some(operation) = operation else {
            return Err(String::from(
                "cannot open the print dialog: the page is not ready to print",
            ));
        };
        // Let the operation print on a thread of its own once the panel is
        // done, as wry does.
        // SAFETY: `setCanSpawnSeparateThread:` is NSPrintOperation's, taking a
        // `BOOL`.
        unsafe {
            let _: () = msg_send![&*operation, setCanSpawnSeparateThread: true];
        }
        Ok(PrintOperation {
            operation,
            ns_window,
        })
    }

    /// Schedule `print` to run as a sheet of the print window `label` on the
    /// next pass of the main run loop, with a delegate that closes that window
    /// once the operation is over. Main thread only.
    ///
    /// `performSelector:withObject:afterDelay:` with a delay of 0 puts a
    /// one-shot timer on the main run loop in its default mode, so the sheet
    /// starts from that timer rather than from inside the tao callback this is
    /// called from (#715). The timer retains the delegate — which holds the
    /// operation and its window — until it fires.
    pub(super) fn schedule_print_sheet(print: PrintOperation, app: AppHandle, label: String) {
        let delegate = PrintWindowDelegate::new(app, label, print);
        // SAFETY: `performSelector:withObject:afterDelay:` is NSObject's: a
        // selector taking one object (the delegate implements
        // `vellisRunPrintSheet:` with exactly that shape), the object to pass
        // (nil) and an `NSTimeInterval` (`f64`). It retains the receiver until
        // the selector has been performed.
        unsafe {
            let _: () = msg_send![
                &*delegate,
                performSelector: sel!(vellisRunPrintSheet:),
                withObject: None::<&AnyObject>,
                afterDelay: 0.0f64
            ];
        }
    }

    /// Run `print` as a sheet of its window, with `delegate` told when the
    /// operation is over. Main thread only.
    ///
    /// The sheet is modeless, so this returns once it is attached.
    fn run_print_sheet(delegate: &PrintWindowDelegate, print: PrintOperation) {
        // The operation does not retain its delegate. The context carries a
        // strong reference to it until `printOperationDidRun:…` takes it back,
        // so the delegate lives exactly as long as the operation needs it.
        let context = Retained::into_raw(delegate.retain()).cast::<c_void>();
        // SAFETY: `runOperationModalForWindow:delegate:didRunSelector:contextInfo:`
        // is NSPrintOperation's: the window to hang the sheet off, the object
        // sent the selector when the operation is over, a selector of the
        // shape `printOperationDidRun:success:contextInfo:` (the delegate
        // implements exactly that), and a context handed back untouched.
        unsafe {
            let _: () = msg_send![
                &*print.operation,
                runOperationModalForWindow: &*print.ns_window,
                delegate: delegate,
                didRunSelector: Some(sel!(printOperationDidRun:success:contextInfo:)),
                contextInfo: context
            ];
        }
    }

    /// The `WKWebView` in `ns_window`. wry puts the print window's one web
    /// view under the window's content view; `None` when there is none.
    ///
    /// Found from the window rather than through `WebviewWindow::with_webview`:
    /// tauri-runtime-wry 2.10.1 hands that closure pointers it has retained and
    /// never releases, so every print would leak the web view and its window.
    fn web_view_of(ns_window: &NSWindow) -> Option<Retained<AnyObject>> {
        let class = AnyClass::get(c"WKWebView")?;
        // SAFETY: `contentView` is NSWindow's, returning an `NSView` or nil.
        let content: Option<Retained<AnyObject>> = unsafe { msg_send![ns_window, contentView] };
        find_web_view(content?, class)
    }

    /// `view` if it is a `class`, otherwise the first one among its subviews,
    /// depth first.
    fn find_web_view(view: Retained<AnyObject>, class: &AnyClass) -> Option<Retained<AnyObject>> {
        // SAFETY: `isKindOfClass:` is NSObject's (a `Class` → `BOOL`).
        // `subviews` is NSView's and never nil; `count` / `objectAtIndex:` are
        // NSArray's, with the index kept below the count.
        unsafe {
            let is_web_view: bool = msg_send![&*view, isKindOfClass: class];
            if is_web_view {
                return Some(view);
            }
            let subviews: Retained<AnyObject> = msg_send![&*view, subviews];
            let count: usize = msg_send![&*subviews, count];
            (0..count).find_map(|i| {
                let subview: Retained<AnyObject> = msg_send![&*subviews, objectAtIndex: i];
                find_web_view(subview, class)
            })
        }
    }

    /// What the delegate needs to start its sheet and close its print window.
    struct DelegateIvars {
        app: AppHandle,
        label: String,
        /// The operation (and its window) waiting for the timer set by
        /// [`schedule_print_sheet`]; taken when it fires.
        pending: Cell<Option<PrintOperation>>,
    }

    define_class!(
        /// Starts the print window's print operation from a timer, and is
        /// told by it when it is over.
        // SAFETY: NSObject has no subclassing requirements, and the delegate
        // does not implement `Drop`.
        #[unsafe(super(NSObject))]
        #[name = "VellisPrintWindowDelegate"]
        #[ivars = DelegateIvars]
        struct PrintWindowDelegate;

        impl PrintWindowDelegate {
            /// The timer set by [`schedule_print_sheet`] fired: run the
            /// pending operation as a sheet of its window, now on a pass of
            /// the main run loop of our own. If the window is already gone
            /// nothing is run; if running panics, the window is closed here,
            /// since no `printOperationDidRun:…` will come.
            #[unsafe(method(vellisRunPrintSheet:))]
            fn run_pending_print_sheet(&self, _unused: Option<&AnyObject>) {
                let ivars = self.ivars();
                let Some(print) = ivars.pending.take() else {
                    return;
                };
                if ivars.app.get_webview_window(&ivars.label).is_none() {
                    tracing::warn!(
                        "the print window '{}' went away before its sheet ran — not printing",
                        ivars.label
                    );
                    return;
                }
                // This runs from the run loop's timer, where an unwinding
                // panic would stop the app.
                let ran = catch_unwind(AssertUnwindSafe(|| run_print_sheet(self, print)));
                if ran.is_err() {
                    tracing::warn!(
                        "running the print sheet of '{}' panicked — closing the window",
                        ivars.label
                    );
                    if let Some(window) = ivars.app.get_webview_window(&ivars.label) {
                        if let Err(e) = window.close() {
                            tracing::warn!(
                                "failed to close the print window '{}': {}",
                                ivars.label,
                                e
                            );
                        }
                    }
                }
            }

            /// The operation is over — printed, saved as PDF or cancelled;
            /// `success` makes no difference (契約2). Closing is a request
            /// to the event loop, so the window goes after this returns,
            /// and a window already gone is left alone.
            #[unsafe(method(printOperationDidRun:success:contextInfo:))]
            fn print_operation_did_run(
                &self,
                _operation: &AnyObject,
                _success: bool,
                context: *mut c_void,
            ) {
                let ivars = self.ivars();
                if let Some(window) = ivars.app.get_webview_window(&ivars.label) {
                    if let Err(e) = window.close() {
                        tracing::warn!(
                            "failed to close the print window '{}': {}",
                            ivars.label,
                            e
                        );
                    }
                }
                // Take back the reference `run_print_sheet` handed over as the
                // context, and let the autorelease pool drop it: dropping it
                // here could free the object this method is running on.
                let this = context.cast::<Self>();
                if std::ptr::eq(this.cast_const(), self) {
                    // SAFETY: the context is `Retained::into_raw` of this very
                    // delegate, and the operation sends this message once, so
                    // the reference is taken back exactly once.
                    if let Some(owned) = unsafe { Retained::from_raw(this) } {
                        let _ = Retained::autorelease_ptr(owned);
                    }
                }
            }
        }
    );

    impl PrintWindowDelegate {
        fn new(app: AppHandle, label: String, print: PrintOperation) -> Retained<Self> {
            let this = Self::alloc().set_ivars(DelegateIvars {
                app,
                label,
                pending: Cell::new(Some(print)),
            });
            // SAFETY: NSObject's `init`, on an instance whose ivars are set.
            unsafe { msg_send![super(this), init] }
        }
    }
}
