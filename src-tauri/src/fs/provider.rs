use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::errors::FsError;

use super::entry::Entry;
use super::uri::Uri;

/// Event kind for file-system watch notifications.
#[derive(Clone, Debug, PartialEq)]
pub enum WatchEventKind {
    Modify,
    Create,
    Remove,
}

/// A watch event delivered through the watch channel.
#[derive(Clone, Debug)]
pub struct WatchEvent {
    pub kind: WatchEventKind,
    pub uri: String,
}

/// Handle that keeps a watch alive. Dropping it stops the watcher.
pub struct WatchHandle {
    pub id: u64,
    _drop: Box<dyn Send + Sync>,
}

impl WatchHandle {
    /// Create a new watch handle. The `guard` will be dropped when this handle is dropped,
    /// which should stop the underlying watcher.
    pub fn new(id: u64, guard: impl Send + Sync + 'static) -> Self {
        Self {
            id,
            _drop: Box::new(guard),
        }
    }
}

/// Read-only file-system provider.
///
/// **No write, delete, create, or rename methods exist by design** (FR-02).
#[async_trait]
pub trait FileProvider: Send + Sync {
    /// URI scheme this provider handles (e.g. `"file"`, `"ssh"`).
    fn scheme(&self) -> &'static str;

    /// List Markdown files and sub-directories under the given directory URI.
    async fn list(&self, uri: &Uri) -> Result<Vec<Entry>, FsError>;

    /// Stat a single entry. Returns `Err(FsError::NotFound)` if it does not exist.
    async fn stat(&self, uri: &Uri) -> Result<Entry, FsError>;

    /// Read the raw bytes of a file (images, attachments, Markdown source).
    async fn read_bytes(&self, uri: &Uri) -> Result<Vec<u8>, FsError>;

    /// Read at most `max_len` bytes starting at byte offset `start`
    /// (要件#27: the `vellis-asset` protocol serves Range requests through this).
    ///
    /// Default implementation: `read_bytes` + slice, so a provider that can only
    /// fetch whole files (`ssh.rs`) still answers partial reads correctly without
    /// any change of its own. Providers that can seek should override this — the
    /// default inherits whatever size cap `read_bytes` enforces, the override
    /// does not (see `LocalProvider::read_range`).
    ///
    /// Reading past EOF is not an error: it yields however many bytes are left
    /// (an empty `Vec` when `start` is at or beyond EOF). The caller decides
    /// whether a range is satisfiable — the asset handler does it with `stat`
    /// before reading.
    async fn read_range(&self, uri: &Uri, start: u64, max_len: u64) -> Result<Vec<u8>, FsError> {
        let bytes = self.read_bytes(uri).await?;
        let len = bytes.len() as u64;
        let start = start.min(len);
        let end = start.saturating_add(max_len).min(len);
        Ok(bytes[start as usize..end as usize].to_vec())
    }

    /// Read the file content as a UTF-8 string.
    ///
    /// Default implementation: calls `read_bytes` and decodes as UTF-8.
    async fn read_text(&self, uri: &Uri) -> Result<String, FsError> {
        let bytes = self.read_bytes(uri).await?;
        String::from_utf8(bytes).map_err(|_| FsError::InvalidUtf8)
    }

    /// Start watching a URI for changes. Events are sent to `tx`.
    /// The returned `WatchHandle` keeps the watch alive; dropping it stops the watcher.
    async fn watch(
        &self,
        uri: &Uri,
        tx: mpsc::Sender<WatchEvent>,
    ) -> Result<WatchHandle, FsError>;
}
