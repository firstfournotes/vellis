//! `list_recent_files` / `clear_recent_files` commands — the Explorer's Recent
//! Files section (requirements.md #64 契約4・9).
//!
//! The writing side is `recent_files::record_file` / `forget_file`, called
//! from `open_in_window` (契約2・8). Both commands take the window's root and
//! narrow the app-wide list to it here, so the "under this root" rule lives in
//! Rust only (`recent_files::is_under_root`).

use crate::recent_files::{default_path, RecentFilesStore};

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
