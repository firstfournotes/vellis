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
//!
//! A link inside the HTML viewer's frame navigates to
//! `vellis-asset://link/<token>?href=…` (要件#88). The net refuses it like
//! any URL that is not the app's own — the preview stays — and the plugin in
//! `html_link.rs`, registered ahead of the net, reports the click to the
//! window that shows the frame ([`report_link_click`]).

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Emitter, Manager, Runtime, Url, Webview};

use crate::print::{print_document_url, PRINT_SCHEME};

/// The custom protocol `lib.rs` registers for local and ssh assets.
const ASSET_SCHEME: &str = "vellis-asset";

/// The host of `vellis-asset://` that a clickable link of the HTML viewer
/// points at (要件#88). The protocol handler serves only `local` and `ssh`,
/// so a load of it (an image's `src`, say) fails as before.
const LINK_HOST: &str = "link";

/// The event a link click is reported with, to the frame's window only. The
/// same literal as `HTML_LINK_CLICKED_EVENT` in `src/lib/html-link.ts`.
pub const HTML_LINK_CLICKED_EVENT: &str = "html_link_clicked";

/// The payload of [`HTML_LINK_CLICKED_EVENT`]: the URL the frame tried to
/// navigate to, as it is (the window checks the token and reads the `href`).
#[derive(Clone, serde::Serialize)]
struct LinkClicked {
    url: String,
}

/// Whether `url` is a click on a link of the HTML viewer:
/// `vellis-asset://link/…` (要件#88). It is not one of the app's own URLs —
/// the navigation is refused, so the preview is not replaced.
pub fn is_link_click(url: &Url) -> bool {
    url.scheme() == ASSET_SCHEME && url.host_str() == Some(LINK_HOST)
}

/// Report a link click to the window that shows it: when `url` is one
/// ([`is_link_click`]), send [`HTML_LINK_CLICKED_EVENT`] with the URL to this
/// webview's window only — never to every window — and answer true. Anything
/// else is left alone (false).
pub fn report_link_click<R: Runtime>(webview: &Webview<R>, url: &Url) -> bool {
    if !is_link_click(url) {
        return false;
    }
    let clicked = webview.emit_to(
        webview.label(),
        HTML_LINK_CLICKED_EVENT,
        LinkClicked {
            url: url.to_string(),
        },
    );
    if let Err(e) = clicked {
        tracing::warn!("could not report a link click to the window: {e}");
    }
    true
}

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
/// URL carries the user's folders and the document's name. A link click
/// ([`is_link_click`]) is refused without a log: refusing it is how a click
/// works, and its URL carries the link's target.
pub fn allow_navigation(url: &Url, dev_url: Option<&Url>) -> bool {
    let allowed = is_app_url(url, dev_url);
    if !allowed && !is_link_click(url) {
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
