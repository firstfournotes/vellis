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

/// PDFKit through the Objective-C runtime. Kept to the two calls the print
/// route needs; nothing outside this module sees an Objective-C object.
///
/// The print classes (`NSData`, `NSPrintInfo`, `NSPrintOperation`) are reached
/// the same untyped way rather than through new `objc2-app-kit` /
/// `objc2-foundation` features: the AppKit feature set is pinned by 要件#62 追補a
/// (`acceptance_req62a.rs`), and these are three messages.
#[cfg(target_os = "macos")]
mod pdfkit {
    use std::ffi::c_void;

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

    /// Build a `PDFDocument` from `bytes` and count its pages.
    pub(super) fn open(bytes: &[u8]) -> Result<(Retained<AnyObject>, usize), String> {
        let class = AnyClass::get(c"PDFDocument")
            .ok_or_else(|| String::from("PDFKit is not available"))?;
        // SAFETY: `dataWithBytes:length:` copies `bytes.len()` bytes from a
        // valid slice (a zero length never dereferences the pointer). `alloc` /
        // `initWithData:` / `pageCount` are PDFDocument's documented API with
        // these argument and return types; `initWithData:` returns nil
        // (→ `None`) for data it cannot read.
        let document: Option<Retained<AnyObject>> = unsafe {
            let data: Retained<AnyObject> = msg_send![
                class!(NSData),
                dataWithBytes: bytes.as_ptr().cast::<c_void>(),
                length: bytes.len()
            ];
            let allocated: Allocated<AnyObject> = msg_send![class, alloc];
            msg_send![allocated, initWithData: &*data]
        };
        let document =
            document.ok_or_else(|| String::from("the file could not be opened as a PDF"))?;
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
                &*document,
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
