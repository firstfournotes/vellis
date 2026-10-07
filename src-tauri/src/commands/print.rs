//! Print commands (requirements.md #38).
//!
//! Every route ⌘P can take ends up here. Which one is taken is decided in the
//! frontend (`src/lib/print-html.ts` の `printRouteFor`), because only the
//! window knows which viewer it is showing — the same split as the Open,
//! Duplicate Window and zoom menu items.
//!
//! The work itself lives in [`crate::print`]; these are the seams that let the
//! window ask for it.

use tauri::{AppHandle, Manager, State, WebviewWindow, Window};

use super::AppState;
use crate::fs::uri::Uri;
use crate::menu::sync_print_item;
use crate::print::{open_print_window, print_pdf_in_window, PrintAvailability};

/// Print the calling window's main frame — the route Markdown, text and every
/// other viewer have always taken.
///
/// This is the old `handle_print_click` body, moved so that the menu click can
/// go through the frontend first: the call is still `Webview::print()` on the
/// window the user is looking at, and `src/styles/print.css` still decides what
/// reaches the paper. `Webview::print()` rather than JavaScript's
/// `window.print()` because WKWebView does not implement the latter (issue #24)
/// — eval'ing it is a silent no-op.
#[tauri::command]
pub fn print_current_window(window: WebviewWindow) -> Result<(), String> {
    window
        .print()
        .map_err(|e| format!("cannot open the print dialog: {e}"))
}

/// Print an HTML document in a window of its own (要件#38).
///
/// `document` is the finished print document built by the frontend — the same
/// preprocessed snapshot the HTML viewer is displaying, plus its CSP `<meta>`.
/// Nothing is added to it here.
#[tauri::command]
pub async fn print_html(document: String, app: AppHandle) -> Result<(), String> {
    open_print_window(&app, document).await
}

/// Tell the app whether the calling window has a printable document open
/// (要件#38 追補f).
///
/// `available` is the frontend's `isPrintAvailable` (`src/lib/print-html.ts`):
/// a document is showing and the history picker is not. The window is the
/// caller's own handle — the frontend never names a window. The report is
/// remembered per label, and File > Print… is re-applied straight away only
/// when the caller is frontmost; a window in the background changes the item
/// when it next gains focus (`on_window_event` in `lib.rs`).
#[tauri::command]
pub fn set_print_available(
    available: bool,
    window: Window,
    state: State<'_, PrintAvailability>,
) {
    state.set(window.label(), available);
    if window.is_focused().unwrap_or(false) {
        sync_print_item(window.app_handle(), window.label());
    }
}

/// Print the PDF the calling window is showing — the file itself, every page
/// (要件#38 追補g・backlog 307).
///
/// The PDF viewer draws the file in an `<iframe>`, and the main-frame print
/// (`print_current_window`) only reaches what that iframe has on screen. So
/// this route does not print the window at all: `uri` is the document the
/// window is showing (`file://` or `ssh://`, as the frontend has it), its bytes
/// are read in full through the same provider `open_document` uses, and
/// [`print_pdf_in_window`] hands them to PDFKit and runs the print operation as
/// a sheet of the calling window. A file that cannot be read, or does not open
/// as a PDF with pages, comes back as `Err` before any sheet is shown; the
/// frontend shows it with `printFailedMessage`.
#[tauri::command]
pub async fn print_pdf(
    uri: String,
    window: Window,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let parsed = Uri::parse(&uri).map_err(|e| e.to_string())?;
    let provider = state.fs_registry.resolve(&parsed).map_err(|e| e.to_string())?;
    let bytes = provider
        .read_bytes(&parsed)
        .await
        .map_err(|e| format!("cannot read the PDF: {e}"))?;
    print_pdf_in_window(&window, bytes).await
}
