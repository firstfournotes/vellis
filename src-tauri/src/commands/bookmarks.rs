//! `list_bookmarks` / `add_bookmark` / `remove_bookmark` / `move_bookmark`
//! commands — the Dashboard's Bookmarks (requirements.md #83 契約7〜9・16).
//!
//! Each command changing the list does its read-modify-write under the store's
//! lock (`bookmarks::BookmarkStore`), so two windows pinning at once both
//! survive, and then sends the list as it stands to every window as
//! `bookmarks_changed` (契約9 (ap) — the same `app.emit` as `theme_changed`).
//! Each window's store (`src/stores/bookmarks.svelte.ts`) reads the list once
//! with `list_bookmarks` and replaces it with each event's list from then on.

use tauri::Emitter;

use crate::bookmarks::{
    default_path, Bookmark, BookmarkKind, BookmarkStore, BOOKMARKS_CHANGED_EVENT,
};

fn store(app: &tauri::AppHandle) -> Result<BookmarkStore, String> {
    default_path(app)
        .map(|path| BookmarkStore::new(&path))
        .ok_or_else(|| "no app config directory".to_string())
}

/// Send the list after a change to every window (契約9 (ap)). Best effort: a
/// failed emit only leaves the other windows a change behind.
fn broadcast(app: &tauri::AppHandle, list: &[Bookmark]) {
    if let Err(e) = app.emit(BOOKMARKS_CHANGED_EVENT, list) {
        tracing::warn!("bookmarks_changed emit failed: {e}");
    }
}

/// Every bookmark in the user's order (empty on first launch).
///
/// A missing config directory yields an empty list rather than an error: the
/// Dashboard must never be blocked from rendering.
#[tauri::command]
pub async fn list_bookmarks(app: tauri::AppHandle) -> Result<Vec<Bookmark>, String> {
    let Ok(store) = store(&app) else {
        return Ok(Vec::new());
    };
    store.list().map_err(|e| e.to_string())
}

/// Pin `uri` at the tail (`kind` = `"folder"` / `"file"`). Already pinned →
/// left where it is. Returns the list afterwards.
#[tauri::command]
pub async fn add_bookmark(
    app: tauri::AppHandle,
    uri: String,
    kind: String,
) -> Result<Vec<Bookmark>, String> {
    let kind =
        BookmarkKind::parse(&kind).ok_or_else(|| format!("unknown bookmark kind: {kind}"))?;
    let list = store(&app)?.add(&uri, kind).map_err(|e| e.to_string())?;
    broadcast(&app, &list);
    Ok(list)
}

/// Unpin `uri`. Returns the list afterwards.
#[tauri::command]
pub async fn remove_bookmark(app: tauri::AppHandle, uri: String) -> Result<Vec<Bookmark>, String> {
    let list = store(&app)?.remove(&uri).map_err(|e| e.to_string())?;
    broadcast(&app, &list);
    Ok(list)
}

/// Move `uri` to position `to` of the list without it (out of range = the
/// tail). Returns the list afterwards.
#[tauri::command]
pub async fn move_bookmark(
    app: tauri::AppHandle,
    uri: String,
    to: usize,
) -> Result<Vec<Bookmark>, String> {
    let list = store(&app)?.move_to(&uri, to).map_err(|e| e.to_string())?;
    broadcast(&app, &list);
    Ok(list)
}
