//! `open_document` / `open_binary_document` / `save_document` commands — open
//! a document in the calling window, or write one back. The binary variant
//! watches without reading (要件#22); the write is the whole of the app's
//! authority to modify a file (要件#48).

use tauri::{Manager, Window};

use crate::annotation::SnapshotManager;
use crate::fs::local::ensure_within_root;
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

/// Write `content` back to `uri` (要件#48 契約①⑤) — the app's only write to a
/// user file, and the only one it will ever have (delete / rename / move stay
/// out by design, `docs/architecture.md` §10.1).
///
/// Four gates, in this order, and none of them is skippable:
///
/// 1. **Scheme** — `ssh://` is refused here, before a provider is even
///    resolved. SSH roots are read-only in this first cut (追補a).
/// 2. **Root containment** — the target must resolve inside the root *this
///    window* currently shows. The root is the window's, not a global one:
///    two windows on different folders must not be able to write into each
///    other's tree. `LocalProvider` holds no root of its own, so this check
///    lives here (追補a) and is a pure function
///    (`fs::local::ensure_within_root`) so it can be judged on its own.
/// 3. **Snapshot** — a copy under `<root>/.vellis/snapshots/` *before* the
///    write, which is what makes the edit undoable through the existing
///    revert (契約⑤). A failure here aborts the save: the safety net is the
///    reason FR-02 (viewer-only) could be withdrawn at all, so a save without
///    one is not a save this command is willing to perform.
/// 4. **Write** — `FileProvider::write_text`, tmp+rename, bytes verbatim.
///
/// The write makes the file watcher fire `file_changed` right back at the
/// window that saved. The frontend recognises its own bytes by hash and drops
/// that echo (契約⑥), which is what keeps the caret from being thrown away by
/// a re-render half a second after every save.
#[tauri::command]
pub async fn save_document(
    uri: String,
    content: String,
    window: Window,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let parsed_uri = Uri::parse(&uri).map_err(|e| e.to_string())?;
    if parsed_uri.scheme != "file" {
        return Err(format!(
            "saving is not supported for {} roots: {}",
            parsed_uri.scheme, uri
        ));
    }

    // The window's own root, as last set by `init_window` / `set_root`.
    let root_uri = {
        let wm = state.window_manager.lock().await;
        wm.get(&label)
            .and_then(|win_state| win_state.root_uri.clone())
            .ok_or_else(|| format!("window '{}' has no root to save into", label))?
    };
    if root_uri.scheme != "file" {
        return Err(format!(
            "saving is not supported under {} roots",
            root_uri.scheme
        ));
    }

    let resolved = ensure_within_root(&root_uri.path, &parsed_uri.path).map_err(|e| e.to_string())?;

    // Snapshot the pre-edit file under `<root>/.vellis/snapshots/`, reusing the
    // store cache and the root-relative path form the annotation commands
    // already speak (`SnapshotManager::take_snapshot` wants root-relative
    // names). No mark ids: this snapshot belongs to a manual save, not to a
    // round of AI instructions.
    let store = super::annotation::store_for(state.inner(), &root_uri.raw)?;
    let canonical_root = store.vellis_dir().parent().ok_or_else(|| {
        format!(
            "annotation store has no parent root: {}",
            store.vellis_dir().display()
        )
    })?;
    let relative = resolved
        .strip_prefix(canonical_root)
        .map_err(|_| {
            format!(
                "{} is outside the project root {}",
                resolved.display(),
                canonical_root.display()
            )
        })?
        .to_string_lossy()
        .into_owned();
    SnapshotManager::new(store.vellis_dir())
        .take_snapshot(&[relative], &[], chrono::Utc::now())
        .map_err(|e| format!("could not snapshot before saving: {}", e))?;

    let provider = state
        .fs_registry
        .resolve(&parsed_uri)
        .map_err(|e| e.to_string())?;
    provider
        .write_text(&parsed_uri.raw, &content)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
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
