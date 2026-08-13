use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::Emitter;
use tokio::sync::{mpsc, Mutex};

use crate::errors::FsError;
use crate::fs::entry::Entry;
use crate::fs::provider::{WatchEvent, WatchEventKind, WatchHandle};
use crate::fs::registry::FileProviderRegistry;
use crate::fs::uri::Uri;

// ---------------------------------------------------------------------------
// Public newtypes
// ---------------------------------------------------------------------------

/// Identifies a Tauri window.
#[derive(Clone, Debug, Hash, Eq, PartialEq)]
pub struct WindowId(pub String);

/// Unique subscription identifier (monotonically increasing).
#[derive(Clone, Copy, Debug, Hash, Eq, PartialEq)]
pub struct SubscriptionId(u64);

static NEXT_SUB_ID: AtomicU64 = AtomicU64::new(1);

impl SubscriptionId {
    fn next() -> Self {
        Self(NEXT_SUB_ID.fetch_add(1, Ordering::Relaxed))
    }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/// Per-subscriber handle stored inside a `WatchEntry`.
struct SubscriberHandle<R: tauri::Runtime> {
    app_handle: tauri::AppHandle<R>,
}

/// What the URI is being watched for. Determines what the fan-out task
/// does when `notify` fires (read content vs re-list children) and which
/// event the subscribers receive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WatchKind {
    File,
    Directory,
}

/// One entry per canonical URI. Holds the refcount, subscribers, and the
/// provider-level watch handle whose `Drop` stops the watcher.
struct WatchEntry<R: tauri::Runtime> {
    kind: WatchKind,
    subscribers: HashMap<(WindowId, SubscriptionId), SubscriberHandle<R>>,
    refcount: usize,
    _provider_handle: WatchHandle,
}

// ---------------------------------------------------------------------------
// DocumentCoordinator
// ---------------------------------------------------------------------------

/// Central hub that de-duplicates file watches by canonical URI and fans out
/// change notifications to all subscribing windows.
pub struct DocumentCoordinator<R: tauri::Runtime = tauri::Wry> {
    inner: Mutex<HashMap<String, WatchEntry<R>>>,
    providers: Arc<FileProviderRegistry>,
}

impl<R: tauri::Runtime> DocumentCoordinator<R> {
    /// Create a new coordinator backed by the given provider registry.
    pub fn new(providers: Arc<FileProviderRegistry>) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            providers,
        }
    }

    /// Subscribe a window to change notifications for the given URI as a
    /// **document** (file). Fans out `file_changed` / `file_removed` to the
    /// app handle on every notify event.
    pub async fn subscribe(
        self: &Arc<Self>,
        uri: Uri,
        window_id: WindowId,
        app: tauri::AppHandle<R>,
    ) -> Result<WatchSubscription<R>, FsError> {
        self.subscribe_inner(uri, window_id, app, WatchKind::File).await
    }

    /// Subscribe a window to change notifications for the given URI as a
    /// **directory** (Explorer root). Any create/remove/modify under the
    /// directory triggers a fresh `provider.list(&uri)` and broadcasts
    /// `directory_changed { root_uri, entries }`. The frontend listener
    /// filters by `root_uri == windowState.root` (`docs/architecture.md`
    /// §6.6, issue #18).
    pub async fn subscribe_directory(
        self: &Arc<Self>,
        uri: Uri,
        window_id: WindowId,
        app: tauri::AppHandle<R>,
    ) -> Result<WatchSubscription<R>, FsError> {
        self.subscribe_inner(uri, window_id, app, WatchKind::Directory).await
    }

    async fn subscribe_inner(
        self: &Arc<Self>,
        uri: Uri,
        window_id: WindowId,
        app: tauri::AppHandle<R>,
        kind: WatchKind,
    ) -> Result<WatchSubscription<R>, FsError> {
        let canonical = uri.canonical();
        let mut inner = self.inner.lock().await;

        match inner.get_mut(&canonical) {
            Some(entry) if entry.kind == kind => {
                // Existing watch of the same kind — piggyback.
                entry.refcount += 1;
                let sub_id = SubscriptionId::next();
                entry.subscribers.insert(
                    (window_id.clone(), sub_id),
                    SubscriberHandle { app_handle: app },
                );
                Ok(WatchSubscription {
                    canonical_uri: canonical,
                    window_id,
                    sub_id,
                    hub: Arc::clone(self),
                })
            }
            Some(_) => {
                // The same canonical URI is already watched as the *other*
                // kind. This is theoretically possible (a path stat'd as
                // both a directory and a file at different times) but in
                // practice means a logic bug upstream.
                Err(FsError::Io(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!(
                        "{} is already watched with a different kind",
                        canonical
                    ),
                )))
            }
            None => {
                let provider = self.providers.resolve(&uri)?;
                let (tx, rx) = mpsc::channel(32);
                let handle = provider.watch(&uri, tx).await?;
                self.spawn_fanout(canonical.clone(), rx, kind);

                let sub_id = SubscriptionId::next();
                let mut subscribers = HashMap::new();
                subscribers.insert(
                    (window_id.clone(), sub_id),
                    SubscriberHandle { app_handle: app },
                );

                inner.insert(
                    canonical.clone(),
                    WatchEntry {
                        kind,
                        subscribers,
                        refcount: 1,
                        _provider_handle: handle,
                    },
                );

                Ok(WatchSubscription {
                    canonical_uri: canonical,
                    window_id,
                    sub_id,
                    hub: Arc::clone(self),
                })
            }
        }
    }

    /// Remove a single subscription. When the refcount reaches zero the
    /// provider-level watch is dropped (stopped).
    pub async fn unsubscribe(&self, uri: &str, window_id: &WindowId, sub_id: SubscriptionId) {
        let mut inner = self.inner.lock().await;
        if let Some(entry) = inner.get_mut(uri) {
            entry.subscribers.remove(&(window_id.clone(), sub_id));
            entry.refcount = entry.refcount.saturating_sub(1);
            if entry.refcount == 0 {
                inner.remove(uri);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    /// Spawn an async task that reads from the provider watch channel and fans
    /// out events to all current subscribers. The action depends on `kind`:
    /// File entries re-read content and emit `file_changed`/`file_removed`;
    /// Directory entries re-list and emit `directory_changed`.
    fn spawn_fanout(
        self: &Arc<Self>,
        canonical: String,
        mut rx: mpsc::Receiver<WatchEvent>,
        kind: WatchKind,
    ) {
        let coordinator = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                match kind {
                    WatchKind::File => {
                        coordinator
                            .handle_file_event(&canonical, event.kind)
                            .await;
                    }
                    WatchKind::Directory => {
                        coordinator
                            .handle_directory_event(&canonical, event.kind)
                            .await;
                    }
                }
            }
        });
    }

    async fn handle_file_event(&self, canonical: &str, kind: WatchEventKind) {
        match kind {
            WatchEventKind::Modify => {
                let uri = match Uri::parse(canonical) {
                    Ok(u) => u,
                    Err(e) => {
                        tracing::warn!("invalid canonical uri {}: {}", canonical, e);
                        return;
                    }
                };
                let provider = match self.providers.resolve(&uri) {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::warn!("no provider for {}: {}", canonical, e);
                        return;
                    }
                };
                match provider.read_text(&uri).await {
                    Ok(content) => self.emit_file_changed(canonical, content).await,
                    Err(e) => tracing::warn!("failed to re-read {}: {}", canonical, e),
                }
            }
            WatchEventKind::Remove => self.emit_file_removed(canonical).await,
            _ => {}
        }
    }

    async fn handle_directory_event(&self, canonical: &str, _kind: WatchEventKind) {
        // Re-list on every Create / Modify / Remove inside the directory.
        // `notify` fires multiple events for a single user-facing action
        // (e.g. `mv` produces Remove + Create); the listing call is cheap
        // and the frontend listener idempotently overwrites `entries`,
        // so debouncing is unnecessary for v1 (issue #18).
        let uri = match Uri::parse(canonical) {
            Ok(u) => u,
            Err(e) => {
                tracing::warn!("invalid canonical dir uri {}: {}", canonical, e);
                return;
            }
        };
        let provider = match self.providers.resolve(&uri) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!("no provider for dir {}: {}", canonical, e);
                return;
            }
        };
        match provider.list(&uri).await {
            Ok(entries) => self.emit_directory_changed(canonical, entries).await,
            Err(e) => tracing::warn!("failed to re-list {}: {}", canonical, e),
        }
    }

    /// Emit `file_changed` to every window subscribed to `canonical`.
    async fn emit_file_changed(&self, canonical: &str, content: String) {
        let inner = self.inner.lock().await;
        if let Some(entry) = inner.get(canonical) {
            let payload = FileChangedPayload {
                uri: canonical.to_string(),
                content,
            };
            for ((_wid, _sid), handle) in &entry.subscribers {
                let _ = handle.app_handle.emit("file_changed", &payload);
            }
        }
    }

    /// Emit `file_removed` to every window subscribed to `canonical`.
    async fn emit_file_removed(&self, canonical: &str) {
        let inner = self.inner.lock().await;
        if let Some(entry) = inner.get(canonical) {
            let payload = FileRemovedPayload {
                uri: canonical.to_string(),
            };
            for ((_wid, _sid), handle) in &entry.subscribers {
                let _ = handle.app_handle.emit("file_removed", &payload);
            }
        }
    }

    /// Emit `directory_changed` to every window subscribed to `canonical`
    /// as a directory. Frontends self-filter by `root_uri ==
    /// windowState.root` (`src/routes/+page.svelte`).
    async fn emit_directory_changed(&self, canonical: &str, entries: Vec<Entry>) {
        let inner = self.inner.lock().await;
        if let Some(entry) = inner.get(canonical) {
            let payload = DirectoryChangedPayload {
                root_uri: canonical.to_string(),
                entries,
            };
            for ((_wid, _sid), handle) in &entry.subscribers {
                let _ = handle.app_handle.emit("directory_changed", &payload);
            }
        }
    }

    // -- Test helpers -------------------------------------------------------

    /// Return the current refcount for a canonical URI (test-only).
    #[cfg(test)]
    pub(crate) async fn refcount(&self, canonical: &str) -> Option<usize> {
        self.inner.lock().await.get(canonical).map(|e| e.refcount)
    }

    /// Return the number of tracked canonical URIs (test-only).
    #[cfg(test)]
    pub(crate) async fn entry_count(&self) -> usize {
        self.inner.lock().await.len()
    }
}

// ---------------------------------------------------------------------------
// Event payloads (Serialize for tauri emit)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
struct FileChangedPayload {
    uri: String,
    content: String,
}

#[derive(Clone, Debug, Serialize)]
struct FileRemovedPayload {
    uri: String,
}

#[derive(Clone, Debug, Serialize)]
struct DirectoryChangedPayload {
    root_uri: String,
    entries: Vec<Entry>,
}

// ---------------------------------------------------------------------------
// WatchSubscription (RAII unsubscribe)
// ---------------------------------------------------------------------------

/// RAII guard that unsubscribes from the coordinator when dropped.
pub struct WatchSubscription<R: tauri::Runtime = tauri::Wry> {
    canonical_uri: String,
    window_id: WindowId,
    sub_id: SubscriptionId,
    hub: Arc<DocumentCoordinator<R>>,
}

impl<R: tauri::Runtime> Drop for WatchSubscription<R> {
    fn drop(&mut self) {
        let hub = Arc::clone(&self.hub);
        let uri = self.canonical_uri.clone();
        let window = self.window_id.clone();
        let sub = self.sub_id;
        tauri::async_runtime::spawn(async move {
            hub.unsubscribe(&uri, &window, sub).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::registry::FileProviderRegistry;
    use std::fs;
    use tauri::test::MockRuntime;
    use tempfile::TempDir;

    /// Helper: build an Arc<DocumentCoordinator<MockRuntime>> with default local provider.
    fn make_coordinator() -> Arc<DocumentCoordinator<MockRuntime>> {
        let registry = FileProviderRegistry::new();
        Arc::new(DocumentCoordinator::new(Arc::new(registry)))
    }

    /// Helper: create a file URI for a real path.
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
    async fn subscribe_creates_entry_with_refcount_one() {
        let tmp = TempDir::new().unwrap();
        let file_path = tmp.path().join("test.md");
        fs::write(&file_path, "# Hello").unwrap();

        let coord = make_coordinator();
        let uri = make_uri(&file_path);
        let app = make_app();
        let wid = WindowId("win-1".into());

        let sub = coord
            .subscribe(uri.clone(), wid, app)
            .await
            .unwrap();

        assert_eq!(coord.refcount(&uri.canonical()).await, Some(1));
        drop(sub);

        // Give the async unsubscribe a moment to run
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(coord.refcount(&uri.canonical()).await, None);
        assert_eq!(coord.entry_count().await, 0);
    }

    #[tokio::test]
    async fn multiple_subscribers_share_single_watch() {
        let tmp = TempDir::new().unwrap();
        let file_path = tmp.path().join("shared.md");
        fs::write(&file_path, "# Shared").unwrap();

        let coord = make_coordinator();
        let uri = make_uri(&file_path);
        let app1 = make_app();
        let app2 = make_app();
        let wid1 = WindowId("win-1".into());
        let wid2 = WindowId("win-2".into());

        let sub1 = coord
            .subscribe(uri.clone(), wid1, app1)
            .await
            .unwrap();
        let sub2 = coord
            .subscribe(uri.clone(), wid2, app2)
            .await
            .unwrap();

        // Both subscriptions share one entry with refcount 2
        assert_eq!(coord.refcount(&uri.canonical()).await, Some(2));
        assert_eq!(coord.entry_count().await, 1);

        // Drop first — refcount should go to 1
        drop(sub1);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(coord.refcount(&uri.canonical()).await, Some(1));

        // Drop second — entry removed
        drop(sub2);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(coord.entry_count().await, 0);
    }

    #[tokio::test]
    async fn unsubscribe_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        let file_path = tmp.path().join("idem.md");
        fs::write(&file_path, "# Idem").unwrap();

        let coord = make_coordinator();
        let uri = make_uri(&file_path);
        let canonical = uri.canonical();
        let app = make_app();
        let wid = WindowId("win-1".into());

        let sub = coord
            .subscribe(uri.clone(), wid.clone(), app)
            .await
            .unwrap();
        let sub_id = sub.sub_id;

        // Manual unsubscribe
        coord.unsubscribe(&canonical, &wid, sub_id).await;
        assert_eq!(coord.entry_count().await, 0);

        // Second unsubscribe is a no-op
        coord.unsubscribe(&canonical, &wid, sub_id).await;
        assert_eq!(coord.entry_count().await, 0);

        // Prevent the Drop from running (already unsubscribed)
        std::mem::forget(sub);
    }

    #[tokio::test]
    async fn different_uris_get_separate_entries() {
        let tmp = TempDir::new().unwrap();
        let path_a = tmp.path().join("a.md");
        let path_b = tmp.path().join("b.md");
        fs::write(&path_a, "# A").unwrap();
        fs::write(&path_b, "# B").unwrap();

        let coord = make_coordinator();
        let uri_a = make_uri(&path_a);
        let uri_b = make_uri(&path_b);
        let app = make_app();
        let wid = WindowId("win-1".into());

        let _sub_a = coord
            .subscribe(uri_a.clone(), wid.clone(), app.clone())
            .await
            .unwrap();
        let _sub_b = coord
            .subscribe(uri_b.clone(), wid, app)
            .await
            .unwrap();

        assert_eq!(coord.entry_count().await, 2);
        assert_eq!(coord.refcount(&uri_a.canonical()).await, Some(1));
        assert_eq!(coord.refcount(&uri_b.canonical()).await, Some(1));
    }

    #[tokio::test]
    async fn subscribe_directory_tracks_root_with_refcount() {
        // Issue #18: directory watching must hook into the same refcount
        // machinery as file watching, so a window switching its root
        // (drop + re-subscribe) doesn't leak a `notify` watcher.
        let tmp = TempDir::new().unwrap();
        let dir_uri = make_uri(tmp.path());

        let coord = make_coordinator();
        let app = make_app();
        let wid = WindowId("win-1".into());

        let sub = coord
            .subscribe_directory(dir_uri.clone(), wid, app)
            .await
            .unwrap();

        assert_eq!(coord.refcount(&dir_uri.canonical()).await, Some(1));

        drop(sub);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(coord.refcount(&dir_uri.canonical()).await, None);
    }

    #[tokio::test]
    async fn subscribing_same_uri_with_mixed_kinds_errors() {
        // The same canonical URI can't be both a file watch and a
        // directory watch at once — that would imply the upstream caller
        // is confused about whether the path is a file or a directory.
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("entry.md");
        fs::write(&path, "# Entry").unwrap();

        let coord = make_coordinator();
        let uri = make_uri(&path);
        let app = make_app();
        let wid = WindowId("win-1".into());

        let _file_sub = coord
            .subscribe(uri.clone(), wid.clone(), app.clone())
            .await
            .unwrap();

        let result = coord.subscribe_directory(uri, wid, app).await;
        assert!(result.is_err(), "mixed-kind subscribe must fail");
    }
}
