//! macOS window tabs (requirements.md #62).
//!
//! A tab is an ordinary Vellis window: AppKit draws the tab bar and does the
//! tearing off and the merging back on its own. What Vellis decides is which
//! windows may share a tab bar — the tab group key, from the window's root —
//! and what each tab is called.
//!
//! The two pure functions ([`tab_group_key`], [`derive_tab_title`]) follow
//! `title.rs`. The rest sends messages to the `NSWindow` behind `ns_window()`,
//! because Tauri only lets a key be set when a window is built: re-keying,
//! `addTabbedWindow:ordered:`, `tab.title` and Show Previous / Next Tab are not
//! in its API (req-62「決定の経緯」). Every one of those is best-effort — a tab
//! feature that fails must not take the window (or the app) down with it — so
//! a missing window, a null pointer or a failed dispatch is logged and ignored,
//! and on other platforms they are no-ops.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, MutexGuard};

use percent_encoding::percent_decode_str;
use tauri::{AppHandle, Runtime};

use super::title::derive_window_title;

/// Key prefix of a window that has a root (契約2).
const ROOT_KEY_PREFIX: &str = "vellis-root:";

/// Key prefix of a window without a root — the history picker
/// (requirements.md #4). The label makes it unique, so it merges with nobody.
const NO_ROOT_KEY_PREFIX: &str = "vellis-noroot:";

/// The tab group key (NSWindow `tabbingIdentifier`) for a window (契約2).
///
/// AppKit only puts windows with the same key into one tab bar, so "a tab can
/// go back only to a window with the same root" is this function's equality.
///
/// - `Some(root)` → `vellis-root:<root>`, with the root normalised so that one
///   folder spelled two ways still gives one key: percent-encoding is decoded
///   (`%20` and a space), trailing slashes are dropped, and a local root
///   (`file://` or a bare path) is lowercased — APFS is case-insensitive by
///   default (the `/users/…` vs `/Users/…` root of requirements.md #60 追補d).
///   `ssh://` keeps its case: the remote Linux side tells `Notes` from `notes`.
/// - `None` → `vellis-noroot:<label>`.
///
/// The label plays no part in a rooted key: two windows on one root share it.
pub fn tab_group_key(root: Option<&str>, label: &str) -> String {
    match root {
        Some(root) => format!("{ROOT_KEY_PREFIX}{}", normalize_root(root)),
        None => format!("{NO_ROOT_KEY_PREFIX}{label}"),
    }
}

fn normalize_root(root: &str) -> String {
    let decoded = percent_decode_str(root).decode_utf8_lossy();
    let (scheme, rest) = match decoded.split_once("://") {
        Some((scheme, rest)) => (Some(scheme), rest),
        None => (None, decoded.as_ref()),
    };
    let trimmed = rest.trim_end_matches('/');
    // `file:///` (and a bare `/`) is the filesystem root: keep its one slash
    // rather than folding it down to the scheme alone.
    let rest = if trimmed.is_empty() && rest.starts_with('/') {
        "/"
    } else {
        trimmed
    };
    let joined = match scheme {
        Some(scheme) => format!("{scheme}://{rest}"),
        None => rest.to_string(),
    };
    let local = scheme.map_or(true, |s| s.eq_ignore_ascii_case("file"));
    if local {
        joined.to_lowercase()
    } else {
        joined
    }
}

/// The tab's own title (契約8): the open document's file name, or — with no
/// document — the window title (`derive_window_title`: the root folder's name,
/// or `vellis`).
///
/// The window title itself stays the root folder (requirements.md #17): the
/// Window menu's list and a single, tab-bar-less window read as before, while
/// several tabs on one root still tell themselves apart.
///
/// The name is the last path segment, percent-decoded. As in the window title,
/// an `ssh://` authority (`user@host:port`) never reaches it. A document URI
/// with no last segment (`…/`) falls back to the root's title.
pub fn derive_tab_title(root: Option<&str>, doc_uri: Option<&str>) -> String {
    doc_uri
        .and_then(document_file_name)
        .unwrap_or_else(|| derive_window_title(root))
}

fn document_file_name(uri: &str) -> Option<String> {
    let path = match uri.split_once("://") {
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("file") => rest,
        // Skip the authority so `user@host:2222` cannot leak into the title.
        Some((_, rest)) => rest.find('/').map_or("", |i| &rest[i..]),
        None => uri,
    };
    let last = path.rsplit('/').next().unwrap_or("");
    let name = percent_decode_str(last).decode_utf8_lossy();
    (!name.is_empty()).then(|| name.into_owned())
}

/// What a new document window is made as (追補a・c).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowKind {
    /// A tab added to the calling window's tab bar (`new_tab`).
    Tab,
    /// A window of its own (New Window, Duplicate Window, Open in New Window…).
    Standalone,
}

/// Where the tab group key a window is built with comes from (追補c).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeySource {
    /// The root's key — the window must share its tab bar from birth.
    Root,
    /// The window's own no-root key, re-keyed to its root by `init_window`.
    NoRoot,
}

/// How a new document window is built (追補a・c).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Placement {
    /// Shown as soon as it is built. A tab is built hidden and shown once it
    /// sits in the tab bar, so no second window flashes up.
    pub visible: bool,
    /// Restored and saved by `tauri-plugin-window-state`. A tab is not: the
    /// plugin would move it — and the whole tab group with it — to wherever a
    /// window of the same label sat in an earlier launch.
    pub track_window_state: bool,
    /// Which tab group key the builder is given.
    pub key: KeySource,
}

/// The placement of a new window of `kind` (追補a・c).
///
/// A standalone window is built with a key of its own, so AppKit never tabs
/// it in automatically while it is still being built (full screen, "prefer
/// tabs": the freeze of 追補c); `init_window` moves it to its root's key. A
/// tab keeps the root's key, because `add_tabbed_window` checks the keys
/// before adding it.
pub fn window_placement(kind: WindowKind) -> Placement {
    match kind {
        WindowKind::Tab => Placement {
            visible: false,
            track_window_state: false,
            key: KeySource::Root,
        },
        WindowKind::Standalone => Placement {
            visible: true,
            track_window_state: true,
            key: KeySource::NoRoot,
        },
    }
}

/// Labels of the windows built as tabs, kept out of `tauri-plugin-window-state`
/// (追補a). One set is shared by the plugin's filter (a plain closure with no
/// `AppHandle`) and the managed state `new_tab` writes to, hence the `Arc`.
///
/// Labels are never reused within one launch, so nothing is ever removed.
#[derive(Clone, Debug, Default)]
pub struct TabWindowLabels(Arc<Mutex<HashSet<String>>>);

impl TabWindowLabels {
    /// Mark `label` as a tab. Must happen before the window is built: the
    /// plugin consults its filter while the window is being created.
    pub fn insert(&self, label: &str) {
        self.lock().insert(label.to_string());
    }

    /// Whether `label` was built as a tab.
    pub fn contains(&self, label: &str) -> bool {
        self.lock().contains(label)
    }

    fn lock(&self) -> MutexGuard<'_, HashSet<String>> {
        // A panic while holding this lock cannot leave the set half-written.
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Which way Show Previous / Next Tab moves (契約7).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TabDirection {
    Previous,
    Next,
}

/// Re-key a window's tab group once its root is known or has changed
/// (契約2・9) — the three places that retitle a window (`init_window`,
/// `set_root`, `handle_switch_root`) call this next to `set_title`.
///
/// When the key really changes and the window is sharing a tab bar, it first
/// leaves for a window of its own (`moveTabToNewWindow:`): the tabs of one
/// window always share one root (起案時判断 (f)). An unchanged key does
/// nothing, so a reload or a same-root `set_root` leaves the tab where it is.
pub fn set_tabbing_identifier<R: Runtime>(app: &AppHandle<R>, label: &str, key: &str) {
    #[cfg(target_os = "macos")]
    {
        let label = label.to_string();
        let key = key.to_string();
        native::run_on_main(app, "set the tab group key", move |app| {
            if let Some(window) = native::ns_window(app, &label) {
                native::retag(&window, &key);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, label, key);
}

/// Put `child_label`'s window into `parent_label`'s tab bar, right after the
/// parent's tab, and bring it to the front (契約4 — the `new_tab` command).
///
/// The child was built hidden (追補a), so this is also what shows it. The two
/// keys are compared first: a window on another root is never added (契約6's
/// rule, kept for tabs opened from inside the app too). Whether it was added
/// or not — even if adding it failed — the child is made key and ordered
/// front, so no hidden window is left behind and a window that could not
/// become a tab is still the one the user sees.
pub fn add_tabbed_window<R: Runtime>(app: &AppHandle<R>, parent_label: &str, child_label: &str) {
    #[cfg(target_os = "macos")]
    {
        let parent_label = parent_label.to_string();
        let child_label = child_label.to_string();
        native::run_on_main(app, "add a tab", move |app| {
            let Some(child) = native::ns_window(app, &child_label) else {
                return;
            };
            if let Some(parent) = native::ns_window(app, &parent_label) {
                native::guarded("add a tab", || native::add_tab(&parent, &child));
            }
            child.makeKeyAndOrderFront(None);
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, parent_label, child_label);
}

/// Set the title shown on the window's tab (契約8). The window title is left
/// alone.
pub fn set_tab_title<R: Runtime>(app: &AppHandle<R>, label: &str, title: &str) {
    #[cfg(target_os = "macos")]
    {
        let label = label.to_string();
        let title = title.to_string();
        native::run_on_main(app, "set the tab title", move |app| {
            if let Some(window) = native::ns_window(app, &label) {
                native::set_title(&window, &title);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, label, title);
}

/// Show the previous / next tab of the window's tab bar (契約7 —
/// `selectPreviousTab:` / `selectNextTab:`). A window without other tabs does
/// nothing (AppKit's own behaviour).
pub fn select_adjacent_tab<R: Runtime>(app: &AppHandle<R>, label: &str, direction: TabDirection) {
    #[cfg(target_os = "macos")]
    {
        let label = label.to_string();
        native::run_on_main(app, "switch tabs", move |app| {
            if let Some(window) = native::ns_window(app, &label) {
                match direction {
                    TabDirection::Previous => window.selectPreviousTab(None),
                    TabDirection::Next => window.selectNextTab(None),
                }
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, label, direction);
}

/// The tab items of the View and Window menus that AppKit would have put
/// there itself for a nib menu, but never does for one built in code (追補b).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TabMenuAction {
    /// View ▸ Show Tab Bar — `toggleTabBar:`.
    ShowTabBar,
    /// View ▸ Show All Tabs — `toggleTabOverview:`.
    ShowAllTabs,
    /// Window ▸ Move Tab to New Window — `moveTabToNewWindow:`.
    MoveTabToNewWindow,
    /// Window ▸ Merge All Windows — `mergeAllWindows:`. AppKit only merges
    /// windows with the same tab group key, i.e. the same root (契約6).
    MergeAllWindows,
}

/// Send one of the tab actions of [`TabMenuAction`] to the window's
/// `NSWindow` (追補b). Same shape as [`select_adjacent_tab`]: AppKit knows the
/// tabs, so nothing reaches the frontend.
pub fn perform_tab_menu_action<R: Runtime>(app: &AppHandle<R>, label: &str, action: TabMenuAction) {
    #[cfg(target_os = "macos")]
    {
        let label = label.to_string();
        native::run_on_main(app, "run a tab menu item", move |app| {
            if let Some(window) = native::ns_window(app, &label) {
                match action {
                    TabMenuAction::ShowTabBar => window.toggleTabBar(None),
                    TabMenuAction::ShowAllTabs => window.toggleTabOverview(None),
                    TabMenuAction::MoveTabToNewWindow => window.moveTabToNewWindow(None),
                    TabMenuAction::MergeAllWindows => window.mergeAllWindows(None),
                }
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, label, action);
}

#[cfg(target_os = "macos")]
mod native {
    use std::panic::{catch_unwind, AssertUnwindSafe};

    use objc2::rc::Retained;
    use objc2_app_kit::{NSWindow, NSWindowOrderingMode};
    use objc2_foundation::NSString;
    use tauri::{AppHandle, Manager, Runtime};

    /// Run `f` on the main thread — AppKit objects may only be touched there.
    ///
    /// Called from the main thread, Tauri runs the task in place; from any
    /// other thread (the async commands) it is queued on the event loop. A
    /// panic inside is caught here: the closure runs inside the event loop's
    /// callback, where an unwinding panic would stop the app.
    pub(super) fn run_on_main<R: Runtime>(
        app: &AppHandle<R>,
        what: &'static str,
        f: impl FnOnce(&AppHandle<R>) + Send + 'static,
    ) {
        let handle = app.clone();
        let dispatched = app.run_on_main_thread(move || {
            if catch_unwind(AssertUnwindSafe(|| f(&handle))).is_err() {
                tracing::warn!("window tabs: panicked while trying to {what}");
            }
        });
        if let Err(e) = dispatched {
            tracing::warn!("window tabs: could not {what}: {e}");
        }
    }

    /// Run `f`, logging instead of unwinding if it panics — for a step whose
    /// failure must not skip what follows it inside the same main-thread task.
    pub(super) fn guarded(what: &'static str, f: impl FnOnce()) {
        if catch_unwind(AssertUnwindSafe(f)).is_err() {
            tracing::warn!("window tabs: panicked while trying to {what}");
        }
    }

    /// The `NSWindow` behind a webview window, retained for the duration of
    /// the call. `None` when the window is gone, `ns_window()` fails or the
    /// pointer is null. Main thread only.
    pub(super) fn ns_window<R: Runtime>(
        app: &AppHandle<R>,
        label: &str,
    ) -> Option<Retained<NSWindow>> {
        let window = app.get_webview_window(label)?;
        let ptr = window.ns_window().ok()?.cast::<NSWindow>();
        // SAFETY: `ns_window()` returns tao's own `NSWindow` for this window
        // (or null, which `retain` turns into `None`). We are on the main
        // thread, where the window is alive, and `retain` keeps it alive for
        // as long as the returned handle is held.
        unsafe { Retained::retain(ptr) }
    }

    pub(super) fn retag(window: &NSWindow, key: &str) {
        let key = NSString::from_str(key);
        if window.tabbingIdentifier().isEqualToString(&key) {
            return;
        }
        if has_other_tabs(window) {
            window.moveTabToNewWindow(None);
        }
        window.setTabbingIdentifier(&key);
    }

    pub(super) fn add_tab(parent: &NSWindow, child: &NSWindow) {
        if !parent
            .tabbingIdentifier()
            .isEqualToString(&child.tabbingIdentifier())
        {
            tracing::warn!("window tabs: not adding a tab from another root");
            return;
        }
        // macOS's "prefer tabs" setting may already have put it there.
        if !same_tab_group(parent, child) {
            parent.addTabbedWindow_ordered(child, NSWindowOrderingMode::Above);
        }
    }

    pub(super) fn set_title(window: &NSWindow, title: &str) {
        window.tab().setTitle(Some(&NSString::from_str(title)));
    }

    fn has_other_tabs(window: &NSWindow) -> bool {
        window
            .tabGroup()
            .is_some_and(|group| group.windows().count() > 1)
    }

    fn same_tab_group(a: &NSWindow, b: &NSWindow) -> bool {
        match (a.tabGroup(), b.tabGroup()) {
            (Some(a), Some(b)) => Retained::as_ptr(&a) == Retained::as_ptr(&b),
            _ => false,
        }
    }
}
