//! `new_window` command — create a new application window.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Window};

use super::AppState;
use crate::window::tab::{
    add_tabbed_window, derive_tab_title, tab_group_key, window_placement, KeySource,
    TabWindowLabels, WindowKind,
};
use crate::window::title::derive_window_title;

/// Register and open a new application window, returning its label.
///
/// The shared implementation behind every "open another window" trigger:
/// the [`new_window`] command (Explorer / Viewer links pass a path and root)
/// and the File ▸ New Window menu item, which passes neither
/// (requirements.md #12).  `path` / `root` travel verbatim into
/// `WindowManager::register_new_window`, so the window's later
/// `init_window` sees exactly what was asked for — and two `None`s leave it
/// in the same state as an argument-less launch, i.e. the history picker
/// screen (requirements.md #4).
///
/// `expanded_dirs` carries the third part of "the same contents" for the
/// duplicate route (requirements.md #34); every other caller passes an empty
/// `Vec` and gets exactly the window it got before.
///
/// `kind` says how the window is placed (requirements.md #62 追補a・c,
/// [`window_placement`]): `WindowKind::Standalone` for every caller but
/// [`new_tab`], which asks for `WindowKind::Tab` — built hidden, left out of
/// the window-state plugin and keyed by its root from birth.
///
/// Callable from the menu (which has only an `AppHandle`) as well as from
/// the command, so `AppState` is looked up here rather than taken as an
/// argument.
pub async fn create_window(
    app: &AppHandle,
    path: Option<String>,
    root: Option<String>,
    expanded_dirs: Vec<String>,
    kind: WindowKind,
) -> Result<String, String> {
    let placement = window_placement(kind);
    let state = app.state::<AppState>();
    // The title names the root folder (requirements.md #17); `root` itself is
    // handed to the manager below. When it is `None` the window opens on the
    // history picker, which keeps the app name.
    let root_for_title = root.clone();
    let label = {
        let mut wm = state.window_manager.lock().await;
        wm.register_new_window_with_dirs(path, root, expanded_dirs)
    };
    // Every window carries a tab group key from birth (requirements.md #62
    // 契約2): a single window built without one makes tao switch automatic
    // window tabbing off for the whole app.
    //
    // A standalone window is born with a key of its own and moves to its
    // root's key in `init_window` (追補c): with the root's key, AppKit may
    // tab it into a same-root window while it is still being built (full
    // screen, "prefer tabs"), which re-enters tao's event handler and hangs
    // the app. A tab keeps the root's key: `add_tabbed_window` compares keys.
    let tab_key = match placement.key {
        KeySource::Root => tab_group_key(root_for_title.as_deref(), &label),
        KeySource::NoRoot => tab_group_key(None, &label),
    };
    // A tab is left out of the window-state plugin (追補a): it would get the
    // position of whichever window had this label in an earlier launch, and
    // the whole tab group — the caller included — would move there. The
    // plugin's filter runs while the window is built, so the label goes into
    // the set first.
    if !placement.track_window_state {
        app.state::<TabWindowLabels>().insert(&label);
    }

    // Build the new window — shown at once, or, for a tab, hidden until
    // `add_tabbed_window` has put it in the tab bar (追補a). `inner_size` is
    // the fallback used when the window-state plugin has no saved entry for
    // this label.
    //
    // Size / position / maximized state are restored by the window-state
    // plugin on its own: its `window_created` hook calls `restore_state` for
    // every new window its filter lets through (every window but a tab —
    // `lib.rs`), with the flags from `Builder::default()` —
    // `StateFlags::all()` — and we register no denylist or
    // `skip_initial_state`. Calling `restore_state` here too is
    // not merely redundant, it deadlocks: the plugin's `restore_state` holds
    // an internal `Mutex` while asking the event loop for
    // `available_monitors()`, so this thread ends up waiting on the main
    // thread while the main thread — inside `attach_window` →
    // `PluginStore::window_created` → the plugin's own `restore_state` —
    // waits for that same `Mutex`. The new window then never finishes
    // initialising and just spins (requirements.md #12, 目視 NG 2026-08-10;
    // confirmed by a `sample` of the hung process). Leave the restore to the
    // plugin — that is also what the IPC-spawned window path does.
    WebviewWindowBuilder::new(app, &label, WebviewUrl::default())
        .title(derive_window_title(root_for_title.as_deref()))
        .tabbing_identifier(&tab_key)
        .visible(placement.visible)
        .inner_size(1280.0, 800.0)
        .build()
        .map_err(|e| format!("failed to create window: {}", e))?;

    Ok(label)
}

/// Create a new window with the given initial path and root.
///
/// The window is registered in `WindowManager` with its `WindowArgs` so that
/// when the window's frontend calls `init_window`, it can discover the root
/// URI and initial document path.
///
/// All three arguments are optional: omitting them opens a window with no
/// target at all — the same state as launching `vellis` with no arguments,
/// which shows the history picker (requirements.md #12).  Existing callers
/// that pass `{ path, root }` are unaffected.
///
/// `expandedDirs` (requirements.md #34) is what the duplicate route adds: the
/// directories the source window had open in its tree, so the new window can
/// come up showing the same thing.  Absent — every caller but the duplicate —
/// means an empty expansion, i.e. exactly the previous behaviour.
///
/// Returns the new window label.
#[tauri::command]
pub async fn new_window(
    path: Option<String>,
    root: Option<String>,
    expanded_dirs: Option<Vec<String>>,
    app: AppHandle,
) -> Result<String, String> {
    create_window(
        &app,
        path,
        root,
        expanded_dirs.unwrap_or_default(),
        WindowKind::Standalone,
    )
    .await
}

/// Open a new tab next to the calling window's current tab
/// (requirements.md #62 契約3・4) and return its label.
///
/// A tab is an ordinary window, so it is made exactly the way `new_window`
/// makes one — same `create_window`, same `WindowArgs`, same `init_window`
/// route for the root, the document and the expanded directories, and the
/// root is recorded in the history by the new tab's own `init_window`. It is
/// only placed differently (`WindowKind::Tab`, 追補a): built hidden and out
/// of the window-state plugin, then added to the calling window's tab bar
/// (`addTabbedWindow:ordered:` with `NSWindowAbove`, i.e. right after the
/// current tab) and brought to the front — so the calling window does not
/// move and no second window flashes up.
///
/// `root` is required — the frontend never asks for a tab without one — and
/// is the caller's own root, so both windows carry the same tab group key.
/// `path` is the document to open (`None` for File ▸ New Tab); `expandedDirs`
/// is the caller's tree expansion, already normalised by the frontend.
#[tauri::command]
pub async fn new_tab(
    path: Option<String>,
    root: String,
    expanded_dirs: Vec<String>,
    window: Window,
    app: AppHandle,
) -> Result<String, String> {
    let label = create_window(&app, path, Some(root), expanded_dirs, WindowKind::Tab).await?;
    add_tabbed_window(&app, window.label(), &label);
    Ok(label)
}

/// Name the calling window's tab after the document it shows
/// (requirements.md #62 契約8). The frontend calls this whenever the root or
/// the document changes — opening, closing, a file that disappears — so the
/// tab always reads `derive_tab_title(root, doc_uri)`. The window title (the
/// root folder, requirements.md #17) is not touched.
///
/// `root` is `None` while the history picker is up. Best-effort: nothing is
/// returned but success, since a tab title that failed to apply must not
/// surface as an error.
#[tauri::command]
pub fn set_tab_title(root: Option<String>, doc_uri: Option<String>, window: Window) {
    let title = derive_tab_title(root.as_deref(), doc_uri.as_deref());
    crate::window::tab::set_tab_title(window.app_handle(), window.label(), &title);
}

#[cfg(test)]
mod tests {
    use crate::window::manager::{WindowArgs, WindowManager};
    use tauri::test::MockRuntime;

    #[test]
    fn window_args_are_stored() {
        let mut wm: WindowManager<MockRuntime> = WindowManager::new();
        let label = wm.next_label();
        wm.register_window(
            label.clone(),
            WindowArgs {
                initial_path: Some("/tmp/doc.md".into()),
                root: Some("/tmp".into()),
                show_marks: false,
                show_changed: false,
                // requirements.md #34 のフィールド追加に伴うリテラル追記のみ
                // (アサーション不変=要件側判断 2026-08-29)。
                expanded_dirs: vec![],
            },
        );
        let state = wm.get(&label).unwrap();
        assert_eq!(
            state.initial_args.initial_path.as_deref(),
            Some("/tmp/doc.md")
        );
    }
}
