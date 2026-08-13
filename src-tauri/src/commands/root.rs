//! `set_root` command — switch the explorer root directory.

use serde::Serialize;
use tauri::{Manager, Window};

use crate::fs::entry::Entry;
use crate::fs::uri::Uri;
use crate::watch::hub::WindowId;

use super::AppState;

/// Payload returned by `set_root`.
#[derive(Clone, Debug, Serialize)]
pub struct RootPayload {
    pub root_uri: String,
    pub entries: Vec<Entry>,
    /// `true` if the currently open document is under the new root and was retained.
    pub document_retained: bool,
}

/// Switch the explorer root for the calling window.
///
/// - Lists entries in the new root via `FileProvider::list`.
/// - Checks whether the current document URI is a prefix-child of the new root.
///   - If yes: session is kept (`document_retained = true`).
///   - If no: session is dropped (`document_retained = false`), which triggers
///     RAII unsubscribe in DocumentCoordinator.
/// - Updates the root URI in `WindowManager`.
/// - Returns the result via command return value only (no event emit for
///   same-window operations).
#[tauri::command]
pub async fn set_root(
    uri: String,
    window: Window,
    state: tauri::State<'_, AppState>,
) -> Result<RootPayload, String> {
    let label = window.label().to_string();
    let new_root = Uri::parse(&uri).map_err(|e| e.to_string())?;

    // List entries under the new root.
    let provider = state
        .fs_registry
        .resolve(&new_root)
        .map_err(|e| e.to_string())?;
    let entries = provider.list(&new_root).await.map_err(|e| e.to_string())?;

    let mut wm = state.window_manager.lock().await;
    let win_state = wm.get_mut(&label).ok_or_else(|| {
        format!("window '{}' not registered in WindowManager", label)
    })?;

    // Determine whether the current document lives under the new root.
    let document_retained = if let Some(ref session) = win_state.session {
        let doc_raw = &session.uri.raw;
        let root_prefix = &new_root.raw;
        doc_raw.starts_with(root_prefix)
    } else {
        false
    };

    if !document_retained {
        // Drop the session — RAII triggers unsubscribe.
        let _ = win_state.session.take();
    }

    // Drop the previous directory watch before subscribing to the new
    // one so the refcount decrements first. The new subscription is
    // attached below; if it fails we leave the explorer without a
    // live watch but the root switch itself still succeeds.
    win_state.root_watch = None;
    win_state.root_uri = Some(new_root.clone());

    // Release the WindowManager lock before we await the subscribe call
    // — `subscribe_directory` takes its own lock on the coordinator and
    // must not be awaited while we hold the manager mutex.
    drop(wm);

    // The root is confirmed at this point — remember it so the user can
    // reopen it later (requirements.md #3).  Best-effort: a failed write
    // must not fail the root switch.
    crate::history::record_root(window.app_handle(), &new_root.raw);

    let coordinator = state.coordinator.clone();
    let app_handle = window.app_handle().clone();
    let new_watch = match coordinator
        .subscribe_directory(
            new_root.clone(),
            WindowId(label.clone()),
            app_handle,
        )
        .await
    {
        Ok(sub) => Some(sub),
        Err(e) => {
            tracing::warn!(
                "set_root: failed to subscribe directory watch on {}: {}",
                new_root.raw,
                e
            );
            None
        }
    };

    let mut wm = state.window_manager.lock().await;
    if let Some(win_state) = wm.get_mut(&label) {
        win_state.root_watch = new_watch;
    }

    Ok(RootPayload {
        root_uri: new_root.raw,
        entries,
        document_retained,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_payload_serializes() {
        let payload = RootPayload {
            root_uri: "file:///tmp".into(),
            entries: vec![],
            document_retained: true,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("document_retained"));
        assert!(json.contains("true"));
    }

    #[test]
    fn prefix_check_logic() {
        let root = "file:///home/user/docs";
        let doc_inside = "file:///home/user/docs/notes/readme.md";
        let doc_outside = "file:///home/user/other/readme.md";

        assert!(doc_inside.starts_with(root));
        assert!(!doc_outside.starts_with(root));
    }
}
