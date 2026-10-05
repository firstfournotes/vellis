//! Print commands (requirements.md #38).
//!
//! Both routes ⌘P can take end up here. Which one is taken is decided in the
//! frontend (`src/lib/print-html.ts` の `printRouteFor`), because only the
//! window knows which viewer it is showing — the same split as the Open,
//! Duplicate Window and zoom menu items.
//!
//! The work itself lives in [`crate::print`]; these are the seams that let the
//! window ask for it.

use tauri::{AppHandle, Manager, State, WebviewWindow, Window};

use crate::menu::sync_print_item;
use crate::print::{open_print_window, PrintAvailability};

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
