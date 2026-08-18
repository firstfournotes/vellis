//! `open_document` / `open_binary_document` commands — open a document in the
//! calling window. The binary variant watches without reading (要件#22).

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
    open_in_window(uri, window, state, false).await
}

/// Open a raster image as a watch-only document (要件#22): same session
/// swap and subscribe-first ordering as `open_document`, but the file is
/// never read — the payload's content is empty and the bytes reach the
/// `<img>` through `vellis-asset:`.
#[tauri::command]
pub async fn open_binary_document(
    uri: String,
    window: Window,
    state: tauri::State<'_, AppState>,
) -> Result<DocumentPayload, String> {
    open_in_window(uri, window, state, true).await
}

async fn open_in_window(
    uri: String,
    window: Window,
    state: tauri::State<'_, AppState>,
    binary: bool,
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

    // Open new session: subscribe-first, then read (binary: no read at all).
    let app_handle = window.app_handle().clone();
    let opened = if binary {
        DocumentSession::open_binary(
            window_id,
            parsed_uri,
            &state.fs_registry,
            &state.coordinator,
            &app_handle,
        )
        .await
    } else {
        DocumentSession::open(
            window_id,
            parsed_uri,
            &state.fs_registry,
            &state.coordinator,
            &app_handle,
        )
        .await
    };
    let (session, payload) = opened.map_err(|e| e.to_string())?;

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
