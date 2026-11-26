//! Clicks on the links of the HTML viewer (要件#88).
//!
//! A link in the viewer's frame points at `vellis-asset://link/<token>?href=…`
//! (`buildSrcdoc` with `links`). This plugin refuses that navigation — so the
//! preview stays — after reporting the click to the frame's window
//! ([`navigation::report_link_click`]); the window decides what the link opens.
//! Every other navigation is passed on to the next plugin, the navigation net
//! (`navigation::plugin`), unchanged.
//!
//! It is a plugin of its own, registered in `lib.rs` ahead of the net: Tauri
//! asks the plugins' `on_navigation` in registration order and stops at the
//! first refusal, and the net refuses a link click too.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

use super::navigation;

/// The plugin that picks up link clicks on every webview.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("vellis-html-link")
        .on_navigation(|webview, url| !navigation::report_link_click(webview, url))
        .build()
}
