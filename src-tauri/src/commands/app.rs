//! `init_window` command — called once when a window starts up.

use serde::Serialize;
use tauri::{Manager, Window};

use crate::fs::entry::Entry;
use crate::fs::uri::Uri;
use crate::watch::hub::WindowId;

use super::AppState;

/// Response returned by `init_window`.
#[derive(Clone, Debug, Serialize)]
pub struct InitWindowResponse {
    pub window_id: String,
    pub root_uri: String,
    pub entries: Vec<Entry>,
    pub initial_path: Option<String>,
    pub version: String,
    /// `true` when the window was opened without an explicit path or root
    /// argument — the frontend should prompt the user to pick a folder.
    pub needs_root_selection: bool,
    /// `true` when the window was started with `vellis --marks` so the
    /// Webview should open the MarkList sidebar immediately
    /// (`docs/ai-collab.md` §9.1).
    pub show_marks: bool,
    /// `true` when the window was started with `vellis --changed` —
    /// sidebar opens with the drift filter active.  Implies
    /// `show_marks`.
    pub show_changed: bool,
}

/// Called once when a window mounts. Returns root URI, directory entries, and
/// an optional initial document path — all in a single round-trip.
#[tauri::command]
pub async fn init_window(
    window: Window,
    state: tauri::State<'_, AppState>,
) -> Result<InitWindowResponse, String> {
    let label = window.label().to_string();
    let mut wm = state.window_manager.lock().await;

    let win_state = wm.get(&label).ok_or_else(|| {
        format!("window '{}' not registered in WindowManager", label)
    })?;

    let initial_path = win_state.initial_args.initial_path.clone();
    let root_arg = win_state.initial_args.root.clone();
    let show_changed = win_state.initial_args.show_changed;
    // `--changed` implies the sidebar is open.
    let show_marks = win_state.initial_args.show_marks || show_changed;
    let needs_root_selection = win_state.initial_args.needs_root_selection();

    // Determine root URI: explicit root arg, or parent of initial_path, or cwd.
    let root_uri_str = if let Some(ref root) = root_arg {
        root.clone()
    } else if let Some(ref path) = initial_path {
        // Use parent directory of the initial file as root.
        let uri = Uri::parse(path).map_err(|e| e.to_string())?;
        uri.parent()
            .map(|p| p.raw.clone())
            .unwrap_or_else(|| uri.raw.clone())
    } else {
        // Fall back to the directory from which the app was launched.
        // `INIT_CWD` is set by npm/pnpm to the user's original shell cwd;
        // `tauri dev` switches process cwd to `src-tauri/`, so this is the
        // only reliable way to recover the launch directory in dev mode.
        let launch_dir = std::env::var_os("INIT_CWD")
            .map(std::path::PathBuf::from)
            .map(Ok)
            .unwrap_or_else(std::env::current_dir)
            .map_err(|e| e.to_string())?;
        format!("file://{}", launch_dir.display())
    };

    let root_uri = Uri::parse(&root_uri_str).map_err(|e| e.to_string())?;

    // List entries in the root directory.
    let provider = state.fs_registry.resolve(&root_uri).map_err(|e| e.to_string())?;
    let entries = provider.list(&root_uri).await.map_err(|e| e.to_string())?;

    // Store the resolved root URI before we await the coordinator, so
    // we don't hold the WindowManager mutex across an unrelated await
    // (the coordinator takes its own mutex internally — keeping the
    // wm lock here would serialize unrelated windows behind that work).
    {
        let win_state_mut = wm.get_mut(&label).unwrap();
        win_state_mut.root_uri = Some(root_uri.clone());
    }
    drop(wm);

    // Remember the folder this window opened with (requirements.md #3).
    // Skipped when no path/root was given: the fallback root is merely the
    // launch directory, not a folder the user chose to open.
    if !needs_root_selection {
        crate::history::record_root(window.app_handle(), &root_uri.raw);
    }

    // Name the window after the folder it settled on (requirements.md #17) —
    // the builder could only use the root it was given, which is absent when
    // the window was opened on a file (root derived above) and meaningless
    // while the history picker is up.
    let title = crate::window::title::derive_window_title(
        (!needs_root_selection).then_some(root_uri.raw.as_str()),
    );
    if let Err(e) = window.set_title(&title) {
        tracing::warn!(
            "init_window: failed to set window title to '{}': {}",
            title,
            e
        );
    }

    // Subscribe to directory changes for the new root so the Explorer
    // auto-refreshes when files / folders are added, removed or
    // renamed inside it (issue #18). Failure is non-fatal: the rest
    // of the window still works, just without live refresh.
    let coordinator = state.coordinator.clone();
    let app_handle = window.app_handle().clone();
    let root_watch = match coordinator
        .subscribe_directory(
            root_uri.clone(),
            WindowId(label.clone()),
            app_handle,
        )
        .await
    {
        Ok(sub) => Some(sub),
        Err(e) => {
            tracing::warn!(
                "init_window: failed to subscribe directory watch on {}: {}",
                root_uri.raw,
                e
            );
            None
        }
    };

    // Re-acquire the WindowManager mutex briefly to attach the watch.
    {
        let mut wm = state.window_manager.lock().await;
        if let Some(win_state_mut) = wm.get_mut(&label) {
            win_state_mut.root_watch = root_watch;
        }
    }

    let version = env!("CARGO_PKG_VERSION").to_string();

    Ok(InitWindowResponse {
        window_id: label,
        root_uri: root_uri.raw,
        entries,
        initial_path,
        version,
        needs_root_selection,
        show_marks,
        show_changed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn init_window_response_serializes() {
        let resp = InitWindowResponse {
            window_id: "win-1".into(),
            root_uri: "file:///tmp".into(),
            entries: vec![],
            initial_path: Some("file:///tmp/doc.md".into()),
            version: "0.1.0".into(),
            needs_root_selection: false,
            show_marks: false,
            show_changed: false,
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("win-1"));
        assert!(json.contains("root_uri"));
    }
}
