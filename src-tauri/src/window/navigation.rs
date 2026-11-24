//! The navigation net: an app window stays on the app's own URLs
//! (requirements.md #74 第3段 3-5, 事後確認 (26)).
//!
//! Tauri's drag-drop handler is off (`lib.rs` and the window builders), so
//! drags reach WKWebView. The page cancels a file drop itself
//! (`src/lib/file-drop-guard.ts`), but a file dropped onto the HTML viewer's
//! frame is not seen there: WebKit then loads the file in the main frame. The
//! net refuses every navigation to a URL that is not the app's own.
//!
//! wry asks about every navigation action, frames included, so the URLs the
//! app loads into frames are its own too: the HTML viewer's `about:srcdoc`,
//! a frame's first `about:blank`, and the PDF viewer's `vellis-asset://`.
//! External links never navigate (they go to the OS through plugin-opener),
//! so they are not affected.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, Url, Webview};

use crate::print::{print_document_url, PRINT_SCHEME};

/// The custom protocol `lib.rs` registers for local and ssh assets.
const ASSET_SCHEME: &str = "vellis-asset";

/// Whether `url` is one of the app's own URLs, which a window (or a frame in
/// it) may navigate to:
///
/// - the app page: `tauri://localhost/…`, or `http(s)://tauri.localhost/…`
///   (Tauri's origin on Windows and Android);
/// - the development server's origin, when `dev_url` is given (pass
///   `build.devUrl` in development builds only);
/// - `about:srcdoc` and `about:blank` (the HTML viewer's frame and a frame's
///   first document);
/// - `vellis-asset://local/…` and `vellis-asset://ssh/…` (the PDF viewer's
///   frame, the HTML document's `<base>`);
/// - the print window's document (`print_document_url`).
///
/// Anything else is refused: files, outside pages (another port of
/// `localhost` included), `javascript:`, `mailto:`.
pub fn is_app_url(url: &Url, dev_url: Option<&Url>) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => {
            (url.host_str() == Some("tauri.localhost") && url.port().is_none())
                || dev_url.is_some_and(|dev| dev.origin() == url.origin())
        }
        "about" => matches!(url.path(), "srcdoc" | "blank"),
        ASSET_SCHEME => matches!(url.host_str(), Some("local") | Some("ssh")),
        PRINT_SCHEME => url.as_str().starts_with(&print_document_url("")),
        _ => false,
    }
}

/// The net's answer: exactly what [`is_app_url`] answers. A refusal is
/// logged in the redacted form only ([`redact_for_log`]): a dropped file's
/// URL carries the user's folders and the document's name.
pub fn allow_navigation(url: &Url, dev_url: Option<&Url>) -> bool {
    let allowed = is_app_url(url, dev_url);
    if !allowed {
        tracing::warn!(
            "navigation refused: {} is not one of the app's own URLs",
            redact_for_log(url)
        );
    }
    allowed
}

/// The form of `url` a log may show: the scheme and `:` (`file:`,
/// `javascript:`, `mailto:`), and for http(s) the scheme and the host
/// (`https://example.com`). The path, query, fragment, user name and
/// password never appear.
pub fn redact_for_log(url: &Url) -> String {
    match (url.scheme(), url.host_str()) {
        (scheme @ ("http" | "https"), Some(host)) => format!("{scheme}://{host}"),
        (scheme, _) => format!("{scheme}:"),
    }
}

/// The development server the net lets through: `build.devUrl`, in
/// development builds only (when Tauri itself loads it).
fn dev_of<R: Runtime>(webview: &Webview<R>) -> Option<&Url> {
    if tauri::is_dev() {
        webview.config().build.dev_url.as_ref()
    } else {
        None
    }
}

/// The plugin that puts the net on every webview: Tauri asks a plugin's
/// `on_navigation` for every window, the ones `tauri.conf.json` describes
/// included.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("vellis-navigation")
        .on_navigation(|webview, url| allow_navigation(url, dev_of(webview)))
        .build()
}
