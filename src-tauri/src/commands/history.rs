//! `list_history` command — recently opened folders (requirements.md #4).
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
