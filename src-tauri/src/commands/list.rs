//! `list_dir` command — list entries under a directory without side effects.
//!
//! Unlike `set_root`, this does not change the window's root state, making it
//! suitable for tree-style explorer child fetching.

use crate::fs::entry::Entry;
use crate::fs::uri::Uri;

use super::AppState;

#[tauri::command]
pub async fn list_dir(
    uri: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Entry>, String> {
    let dir_uri = Uri::parse(&uri).map_err(|e| e.to_string())?;
    let provider = state.fs_registry.resolve(&dir_uri).map_err(|e| e.to_string())?;
    provider.list(&dir_uri).await.map_err(|e| e.to_string())
}
