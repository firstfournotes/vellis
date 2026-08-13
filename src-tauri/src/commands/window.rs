//! `new_window` command — create a new application window.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use super::AppState;

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
/// Callable from the menu (which has only an `AppHandle`) as well as from
/// the command, so `AppState` is looked up here rather than taken as an
/// argument.
pub async fn create_window(
    app: &AppHandle,
    path: Option<String>,
    root: Option<String>,
) -> Result<String, String> {
    let state = app.state::<AppState>();
    let label = {
        let mut wm = state.window_manager.lock().await;
        wm.register_new_window(path, root)
    };

    // Build and show the new window. `inner_size` is the fallback used when
    // the window-state plugin has no saved entry for this label.
    //
    // Size / position / maximized state are restored by the window-state
    // plugin on its own: its `window_created` hook calls `restore_state` for
    // every new window, with the flags from `Builder::default()` —
    // `StateFlags::all()` — and we register no denylist or
    // `skip_initial_state` (`lib.rs`). Calling `restore_state` here too is
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
        .title("vellis")
        .inner_size(800.0, 600.0)
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
/// Both arguments are optional: omitting them opens a window with no target
/// at all — the same state as launching `vellis` with no arguments, which
/// shows the history picker (requirements.md #12).  Existing callers that
/// pass `{ path, root }` are unaffected.
///
/// Returns the new window label.
#[tauri::command]
pub async fn new_window(
    path: Option<String>,
    root: Option<String>,
    app: AppHandle,
) -> Result<String, String> {
    create_window(&app, path, root).await
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
            },
        );
        let state = wm.get(&label).unwrap();
        assert_eq!(
            state.initial_args.initial_path.as_deref(),
            Some("/tmp/doc.md")
        );
    }
}
