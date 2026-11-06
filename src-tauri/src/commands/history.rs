//! `list_history` / `remove_history_entry` commands — recently opened folders
//! (requirements.md #4・#83 契約10).
//!
//! The argument-less launch shows a history picker instead of opening a
//! folder straight away; this command feeds that screen.  Writing side is
//! `history::record_root`, called from `init_window` / `set_root` /
//! `handle_open_path` (requirements.md #3).

use crate::history::{default_path, HistoryStore};

/// Recently opened folder URIs, most recent first (empty on first launch).
///
/// A missing config directory yields an empty list rather than an error:
/// the picker must never be blocked from rendering — the user can still
/// choose a folder through the OS dialog.
#[tauri::command]
pub async fn list_history(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let Some(path) = default_path(&app) else {
        return Ok(Vec::new());
    };
    HistoryStore::new(&path).list().map_err(|e| e.to_string())
}

/// Remove `uri` from the history (requirements.md #83 契約10 — the Dashboard's
/// Remove from Recent Folders) and return the history as it stands afterwards.
///
/// Compared through `history::normalize_uri`, like `record_root`. Not sent to
/// the other windows: only the Dashboard shows the history, and it reads it
/// again every time it opens (契約9 (ap)). A missing config directory is an
/// error here — there is nothing that could have been removed.
#[tauri::command]
pub async fn remove_history_entry(app: tauri::AppHandle, uri: String) -> Result<Vec<String>, String> {
    let Some(path) = default_path(&app) else {
        return Err("no app config directory".to_string());
    };
    HistoryStore::new(&path).remove(&uri).map_err(|e| e.to_string())
}
