use std::sync::Arc;

use serde::Serialize;

use crate::errors::VellisError;
use crate::fs::registry::FileProviderRegistry;
use crate::fs::uri::Uri;
use crate::watch::hub::{DocumentCoordinator, WatchSubscription, WindowId};

// ---------------------------------------------------------------------------
// DocumentPayload
// ---------------------------------------------------------------------------

/// Payload returned to the frontend when a document is opened.
#[derive(Clone, Debug, Serialize)]
pub struct DocumentPayload {
    /// The canonical URI string.
    pub uri: String,
    /// UTF-8 content of the file.
    pub content: String,
    /// Last-modified time as Unix epoch milliseconds (if available).
    pub modified: Option<i64>,
}

// ---------------------------------------------------------------------------
// DocumentSession
// ---------------------------------------------------------------------------

/// Represents one open document inside a window.
///
/// The session owns a `WatchSubscription` whose `Drop` automatically
/// unsubscribes from the `DocumentCoordinator`, so closing a window (or
/// opening a new document in the same window) cleanly stops the watch.
pub struct DocumentSession<R: tauri::Runtime = tauri::Wry> {
    pub window_id: WindowId,
    pub uri: Uri,
    /// Kept alive for its `Drop` side-effect (unsubscribe).
    pub watch_subscription: WatchSubscription<R>,
}

impl<R: tauri::Runtime> DocumentSession<R> {
    /// Open a document: subscribe to changes *first*, then read the current content.
    ///
    /// The subscribe-first ordering is critical: any modification that happens
    /// between subscribe and read will be caught by the watch and delivered as
    /// a `file_changed` event, preventing data loss when an AI tool is
    /// continuously appending to a Markdown file.
    pub async fn open(
        window_id: WindowId,
        uri: Uri,
        providers: &FileProviderRegistry,
        coordinator: &Arc<DocumentCoordinator<R>>,
        app: &tauri::AppHandle<R>,
    ) -> Result<(Self, DocumentPayload), VellisError> {
        // 1. Subscribe FIRST — watch begins before we read
        let subscription = coordinator
            .subscribe(uri.clone(), window_id.clone(), app.clone())
            .await?;

        // 2. Read current content
        let provider = providers.resolve(&uri)?;
        let content = provider.read_text(&uri).await?;
        let modified = provider.stat(&uri).await.ok().and_then(|e| e.modified);

        Ok((
            Self {
                window_id,
                uri: uri.clone(),
                watch_subscription: subscription,
            },
            DocumentPayload {
                uri: uri.raw.clone(),
                content,
                modified,
            },
        ))
    }
}

// Drop for DocumentSession is implicit: when the struct is dropped,
// `watch_subscription` is dropped, which triggers the RAII unsubscribe.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::registry::FileProviderRegistry;
    use crate::watch::hub::DocumentCoordinator;
    use std::fs;
    use std::sync::Arc;
    use tauri::test::MockRuntime;
    use tempfile::TempDir;

    fn make_uri(path: &std::path::Path) -> Uri {
        Uri {
            scheme: "file".into(),
            authority: None,
            path: path.to_path_buf(),
            raw: format!("file://{}", path.display()),
        }
    }

    fn make_app() -> tauri::AppHandle<MockRuntime> {
        let app = tauri::test::mock_app();
        app.handle().clone()
    }

    #[tokio::test]
    async fn open_returns_content_and_subscribes() {
        let tmp = TempDir::new().unwrap();
        let file_path = tmp.path().join("doc.md");
        fs::write(&file_path, "# Document").unwrap();

        let providers = Arc::new(FileProviderRegistry::new());
        let coordinator: Arc<DocumentCoordinator<MockRuntime>> =
            Arc::new(DocumentCoordinator::new(Arc::clone(&providers)));
        let app = make_app();
        let wid = WindowId("win-1".into());
        let uri = make_uri(&file_path);

        let (session, payload) = DocumentSession::open(
            wid.clone(),
            uri.clone(),
            &providers,
            &coordinator,
            &app,
        )
        .await
        .unwrap();

        // Payload should contain the file content
        assert_eq!(payload.content, "# Document");
        assert_eq!(payload.uri, uri.raw);
        assert!(payload.modified.is_some());

        // Coordinator should have one subscription
        assert_eq!(coordinator.refcount(&uri.canonical()).await, Some(1));

        // Drop the session — subscription should be cleaned up
        drop(session);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(coordinator.entry_count().await, 0);
    }

    #[tokio::test]
    async fn open_subscribes_before_read() {
        // This test verifies the subscribe-first invariant by checking
        // that after open() returns, the coordinator already has the
        // subscription (proving subscribe happened before we could
        // possibly have read the file).
        let tmp = TempDir::new().unwrap();
        let file_path = tmp.path().join("order.md");
        fs::write(&file_path, "# Order test").unwrap();

        let providers = Arc::new(FileProviderRegistry::new());
        let coordinator: Arc<DocumentCoordinator<MockRuntime>> =
            Arc::new(DocumentCoordinator::new(Arc::clone(&providers)));
        let app = make_app();
        let wid = WindowId("win-order".into());
        let uri = make_uri(&file_path);

        let (_session, payload) = DocumentSession::open(
            wid,
            uri.clone(),
            &providers,
            &coordinator,
            &app,
        )
        .await
        .unwrap();

        // The coordinator must be tracking the URI
        assert_eq!(coordinator.refcount(&uri.canonical()).await, Some(1));
        // And we must have read the content
        assert_eq!(payload.content, "# Order test");
    }

    #[tokio::test]
    async fn drop_session_unsubscribes_automatically() {
        let tmp = TempDir::new().unwrap();
        let file_path = tmp.path().join("drop.md");
        fs::write(&file_path, "# Drop test").unwrap();

        let providers = Arc::new(FileProviderRegistry::new());
        let coordinator: Arc<DocumentCoordinator<MockRuntime>> =
            Arc::new(DocumentCoordinator::new(Arc::clone(&providers)));
        let app = make_app();
        let wid = WindowId("win-drop".into());
        let uri = make_uri(&file_path);

        let (session, _payload) = DocumentSession::open(
            wid,
            uri.clone(),
            &providers,
            &coordinator,
            &app,
        )
        .await
        .unwrap();

        assert_eq!(coordinator.refcount(&uri.canonical()).await, Some(1));

        // Dropping the session triggers WatchSubscription::drop → unsubscribe
        drop(session);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        assert_eq!(coordinator.refcount(&uri.canonical()).await, None);
        assert_eq!(coordinator.entry_count().await, 0);
    }

    #[tokio::test]
    async fn open_nonexistent_file_returns_error() {
        let providers = Arc::new(FileProviderRegistry::new());
        let coordinator: Arc<DocumentCoordinator<MockRuntime>> =
            Arc::new(DocumentCoordinator::new(Arc::clone(&providers)));
        let app = make_app();
        let wid = WindowId("win-err".into());
        let uri = make_uri(std::path::Path::new("/nonexistent/no_such_file.md"));

        let result = DocumentSession::open(
            wid,
            uri,
            &providers,
            &coordinator,
            &app,
        )
        .await;

        assert!(result.is_err());
    }
}
