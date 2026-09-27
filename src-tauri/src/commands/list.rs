//! `list_dir` command — list entries under a directory without side effects.
//!
//! Unlike `set_root`, this does not change the window's root state, making it
//! suitable for tree-style explorer child fetching.
//!
//! The listing goes through the exclude settings (requirements.md #65 契約9),
//! judged by the path relative to the calling window's root. The root comes
//! from the window's state (`WindowManager`), so the frontend's arguments stay
//! as they were.

use tauri::Window;

use crate::exclude::filter_tree_entries;
use crate::fs::entry::Entry;
use crate::fs::uri::Uri;

use super::AppState;

#[tauri::command]
pub async fn list_dir(
    uri: String,
    window: Window,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Entry>, String> {
    let dir_uri = Uri::parse(&uri).map_err(|e| e.to_string())?;
    let provider = state.fs_registry.resolve(&dir_uri).map_err(|e| e.to_string())?;
    let entries = provider.list(&dir_uri).await.map_err(|e| e.to_string())?;
    // A window without a root yet (the history picker) judges by the names alone.
    let root_uri = {
        let wm = state.window_manager.lock().await;
        wm.get(window.label()).and_then(|win_state| win_state.root_uri.clone())
    }
    .unwrap_or_else(|| dir_uri.clone());
    Ok(filter_tree_entries(&root_uri, &dir_uri, entries))
}
