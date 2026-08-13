//! `open_document` command — opens a document in the calling window.

use tauri::{Manager, Window};

use crate::fs::uri::Uri;
use crate::session::document::{DocumentPayload, DocumentSession};
use crate::watch::hub::WindowId;

use super::AppState;

/// Open a document: drop any existing session, create a new one (subscribe-first),
/// read content, and return a `DocumentPayload`.
#[tauri::command]
pub async fn open_document(
    uri: String,
    window: Window,
    state: tauri::State<'_, AppState>,
) -> Result<DocumentPayload, String> {
    let label = window.label().to_string();
    let parsed_uri = Uri::parse(&uri).map_err(|e| e.to_string())?;
    let window_id = WindowId(label.clone());

    // Drop existing session (RAII unsubscribe) before opening a new one.
    {
        let mut wm = state.window_manager.lock().await;
        if let Some(win_state) = wm.get_mut(&label) {
            // Take the old session — dropping it triggers unsubscribe.
            let _ = win_state.session.take();
        }
    }

    // Open new session: subscribe-first, then read.
    let app_handle = window.app_handle().clone();
    let (session, payload) = DocumentSession::open(
        window_id,
        parsed_uri,
        &state.fs_registry,
        &state.coordinator,
        &app_handle,
    )
    .await
    .map_err(|e| e.to_string())?;

    // Store the new session in the window manager.
    {
        let mut wm = state.window_manager.lock().await;
        if let Some(win_state) = wm.get_mut(&label) {
            win_state.session = Some(session);
        }
    }

    Ok(payload)
}

#[cfg(test)]
mod tests {
    use crate::session::document::DocumentPayload;

    #[test]
    fn document_payload_serializes() {
        let payload = DocumentPayload {
            uri: "file:///tmp/doc.md".into(),
            content: "# Hello".into(),
            modified: Some(1700000000000),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("# Hello"));
        assert!(json.contains("modified"));
    }
}
