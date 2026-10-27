//! `list_recent_files` / `record_displayed_file` / `clear_recent_files`
//! commands — the Explorer's Recent Files section (requirements.md #64
//! 契約4・9・追補f).
//!
//! The writing side is `recent_files::record_file` / `forget_file`, called
//! from `open_in_window` (契約2・8) for text documents and from
//! `record_displayed_file` for the binary ones once a viewer has shown them
//! (追補f). The list and clear commands take the window's root and narrow the
//! app-wide list to it here, so the "under this root" rule lives in Rust only
//! (`recent_files::is_under_root`).

use tauri::Manager;

use crate::recent_files::{self, default_path, RecentFilesStore};

use super::AppState;

/// Files opened under `root`, most recent first, at most
/// `RECENT_FILES_SHOWN` (empty on first launch).
///
/// A missing config directory yields an empty list rather than an error: the
/// section must never be blocked from rendering.
#[tauri::command]
pub async fn list_recent_files(root: String, app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let Some(path) = default_path(&app) else {
        return Ok(Vec::new());
    };
    RecentFilesStore::new(&path)
        .list_under_root(&root)
        .map_err(|e| e.to_string())
}

/// Record a binary document (image・PDF・video・audio・3D) once its viewer
/// has first displayed it (要件#64 追補f 契約1・2).
///
/// `open_binary_document` only sets up the watch, so a file too large, broken
/// or unreadable is found out in the viewer; recording it there would list
/// files that never opened. The record goes through only when the calling
/// window's current session is still `uri` — a report that arrives after the
/// window moved on, or from a window without a session (a print window),
/// records nothing and still returns `Ok(())`. Best-effort like `record_file`.
#[tauri::command]
pub async fn record_displayed_file(
    window: tauri::Window,
    state: tauri::State<'_, AppState>,
    uri: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    let session_uri = {
        let wm = state.window_manager.lock().await;
        wm.get(&label)
            .and_then(|win_state| win_state.session.as_ref())
            .map(|session| session.uri.raw.clone())
    };
    if recent_files::should_record_displayed(session_uri.as_deref(), &uri) {
        recent_files::record_file(window.app_handle(), &uri);
    } else {
        tracing::debug!(
            "recent files: not recording '{}' for window '{}' (current: {:?})",
            uri,
            label,
            session_uri
        );
    }
    Ok(())
}

/// Forget every file under `root` (契約9). Other roots' entries stay.
#[tauri::command]
pub async fn clear_recent_files(root: String, app: tauri::AppHandle) -> Result<(), String> {
    let Some(path) = default_path(&app) else {
        return Ok(());
    };
    RecentFilesStore::new(&path)
        .remove_under_root(&root)
        .map_err(|e| e.to_string())
}
