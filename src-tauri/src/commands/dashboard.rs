//! `list_missing_paths` / `scan_recently_modified` commands — the Dashboard's
//! faded entries and its Recently Modified section (requirements.md #83
//! 契約6・10・11・12・16).
//!
//! Both are thin: the judgement lives in `crate::dashboard`. The scan's targets
//! come from `history.json` and `bookmarks.json` here (the front end does not
//! pick them), the exclusions from the user's settings, read on every scan like
//! Find in Folder does. Progress goes to the calling window only
//! (`recently_modified_progress`, `emit_to`), tagged with the generation the
//! window passed, so the window can drop an older scan's reports.

use std::time::Duration;

use tauri::Emitter;

use crate::bookmarks::{self, BookmarkStore};
use crate::dashboard::{
    missing_paths, scan_recently_modified_in, scan_targets, RecentlyModifiedScan,
    RECENTLY_MODIFIED_BUDGET_MS, RECENTLY_MODIFIED_PROGRESS_EVENT,
};
use crate::fs::uri::Uri;
use crate::history::{self, HistoryStore};
use crate::settings::load_settings;

use super::AppState;

/// The local URIs of `uris` that are not on disk, in input order (ssh is never
/// checked). The `stat`s run off the async runtime.
#[tauri::command]
pub async fn list_missing_paths(uris: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || missing_paths(&uris))
        .await
        .map_err(|e| e.to_string())
}

/// Scan the history's and the folder bookmarks' local folders for the newest
/// files Vellis can open (契約11・12). Ends within the budget (2 seconds).
#[tauri::command]
pub async fn scan_recently_modified(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    generation: u64,
) -> Result<RecentlyModifiedScan, String> {
    let history = history::default_path(&app)
        .and_then(|path| HistoryStore::new(&path).list().ok())
        .unwrap_or_default();
    let bookmarks = bookmarks::default_path(&app)
        .and_then(|path| BookmarkStore::new(&path).list().ok())
        .unwrap_or_default();
    let targets = scan_targets(&history, &bookmarks);
    let local = Uri::parse("file:///").map_err(|e| e.to_string())?;
    let provider = state
        .fs_registry
        .resolve(&local)
        .map_err(|e| e.to_string())?;
    let settings = load_settings().settings;

    let label = window.label().to_string();
    let mut on_progress = |progress: &RecentlyModifiedScan| {
        if let Err(e) = window.emit_to(label.as_str(), RECENTLY_MODIFIED_PROGRESS_EVENT, progress) {
            tracing::warn!("recently_modified_progress emit failed: {e}");
        }
    };
    Ok(scan_recently_modified_in(
        provider.as_ref(),
        generation,
        &targets,
        &settings,
        Duration::from_millis(RECENTLY_MODIFIED_BUDGET_MS),
        &mut on_progress,
    )
    .await)
}
