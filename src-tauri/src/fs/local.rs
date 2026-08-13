use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;
use tracing;

use crate::errors::FsError;

use super::entry::{Entry, FileKind};
use super::provider::{FileProvider, WatchEvent, WatchEventKind, WatchHandle};
use super::uri::Uri;

/// Maximum file size for `read_bytes` (10 MB).
const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024;

/// Counter for generating unique watch handle IDs.
static WATCH_ID: AtomicU64 = AtomicU64::new(1);

/// Local file-system provider backed by `tokio::fs` and `notify`.
pub struct LocalProvider;

impl LocalProvider {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl FileProvider for LocalProvider {
    fn scheme(&self) -> &'static str {
        "file"
    }

    async fn list(&self, uri: &Uri) -> Result<Vec<Entry>, FsError> {
        let dir_path = uri.path.clone();
        let mut entries = Vec::new();
        let mut read_dir = tokio::fs::read_dir(&dir_path).await.map_err(io_to_fs)?;

        while let Some(de) = read_dir.next_entry().await.map_err(io_to_fs)? {
            let metadata = de.metadata().await.map_err(io_to_fs)?;
            let file_name = de.file_name();
            let name = file_name.to_string_lossy().to_string();

            // Skip hidden files/directories
            if name.starts_with('.') {
                continue;
            }

            let kind = if metadata.is_dir() {
                FileKind::Dir
            } else if metadata.is_symlink() {
                FileKind::Symlink
            } else if metadata.is_file() {
                // Every regular file is listed, regardless of extension.
                FileKind::File
            } else {
                continue;
            };

            let entry_path = dir_path.join(&name);
            let entry_uri = uri.with_path(&entry_path);

            let modified = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64);

            let size = if metadata.is_file() {
                Some(metadata.len())
            } else {
                None
            };

            entries.push(Entry {
                uri: entry_uri.raw,
                name,
                kind,
                size,
                modified,
            });
        }

        // Sort: directories first, then alphabetical
        entries.sort_by(|a, b| {
            let dir_ord = |k: &FileKind| if *k == FileKind::Dir { 0 } else { 1 };
            dir_ord(&a.kind)
                .cmp(&dir_ord(&b.kind))
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(entries)
    }

    async fn stat(&self, uri: &Uri) -> Result<Entry, FsError> {
        let path = &uri.path;
        let metadata = tokio::fs::metadata(path).await.map_err(io_to_fs)?;

        let kind = if metadata.is_dir() {
            FileKind::Dir
        } else if metadata.is_symlink() {
            FileKind::Symlink
        } else {
            FileKind::File
        };

        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);

        let size = if metadata.is_file() {
            Some(metadata.len())
        } else {
            None
        };

        Ok(Entry {
            uri: uri.raw.clone(),
            name,
            kind,
            size,
            modified,
        })
    }

    async fn read_bytes(&self, uri: &Uri) -> Result<Vec<u8>, FsError> {
        let path = &uri.path;

        // Check size before reading
        let metadata = tokio::fs::metadata(path).await.map_err(io_to_fs)?;
        if metadata.len() > MAX_FILE_SIZE {
            return Err(FsError::FileTooLarge(format!(
                "{} ({} bytes, max {})",
                path.display(),
                metadata.len(),
                MAX_FILE_SIZE
            )));
        }

        tokio::fs::read(path).await.map_err(io_to_fs)
    }

    // read_text: uses the default trait implementation (read_bytes + UTF-8 decode)

    async fn watch(
        &self,
        uri: &Uri,
        tx: mpsc::Sender<WatchEvent>,
    ) -> Result<WatchHandle, FsError> {
        let watch_path = uri.path.clone();
        let uri_raw = uri.raw.clone();

        let mut watcher = RecommendedWatcher::new(
            move |res: Result<notify::Event, notify::Error>| {
                if let Ok(event) = res {
                    let kind = match event.kind {
                        notify::EventKind::Modify(_) => Some(WatchEventKind::Modify),
                        notify::EventKind::Create(_) => Some(WatchEventKind::Create),
                        notify::EventKind::Remove(_) => Some(WatchEventKind::Remove),
                        _ => None,
                    };
                    if let Some(kind) = kind {
                        let _ = tx.try_send(WatchEvent {
                            kind,
                            uri: uri_raw.clone(),
                        });
                    }
                }
            },
            notify::Config::default(),
        )
        .map_err(|e| FsError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;

        watcher
            .watch(&watch_path, RecursiveMode::NonRecursive)
            .map_err(|e| FsError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;

        let id = WATCH_ID.fetch_add(1, Ordering::Relaxed);
        tracing::debug!(id, path = %watch_path.display(), "started local watch");

        Ok(WatchHandle::new(id, watcher))
    }
}

/// Convert `std::io::Error` to `FsError`, mapping `NotFound` and `PermissionDenied`.
fn io_to_fs(e: std::io::Error) -> FsError {
    match e.kind() {
        std::io::ErrorKind::NotFound => FsError::NotFound(e.to_string()),
        std::io::ErrorKind::PermissionDenied => FsError::PermissionDenied(e.to_string()),
        _ => FsError::Io(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_uri(path: &std::path::Path) -> Uri {
        Uri {
            scheme: "file".into(),
            authority: None,
            path: path.to_path_buf(),
            raw: format!("file://{}", path.display()),
        }
    }

    #[tokio::test]
    async fn list_returns_all_files_and_dirs() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        fs::write(root.join("readme.md"), "# Hello").unwrap();
        fs::write(root.join("notes.markdown"), "# Notes").unwrap();
        fs::write(root.join("design.mdx"), "# Design").unwrap();
        fs::write(root.join("image.png"), &[0u8; 10]).unwrap();
        fs::write(root.join("data.json"), "{}").unwrap();
        fs::create_dir(root.join("subdir")).unwrap();
        fs::write(root.join(".hidden.md"), "# Hidden").unwrap();

        let provider = LocalProvider::new();
        let uri = make_uri(root);
        let entries = provider.list(&uri).await.unwrap();

        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        // 要件#1(requirements.md #1): 全ファイルを列挙する。隠しファイルは現行踏襲で除外
        assert!(names.contains(&"subdir"));
        assert!(names.contains(&"readme.md"));
        assert!(names.contains(&"notes.markdown"));
        assert!(names.contains(&"design.mdx"));
        assert!(names.contains(&"image.png"));
        assert!(names.contains(&"data.json"));
        assert!(!names.contains(&".hidden.md"));

        // Dir should come first
        assert_eq!(entries[0].kind, FileKind::Dir);
    }

    #[tokio::test]
    async fn stat_returns_entry() {
        let tmp = TempDir::new().unwrap();
        let file_path = tmp.path().join("test.md");
        fs::write(&file_path, "# Test").unwrap();

        let provider = LocalProvider::new();
        let uri = make_uri(&file_path);
        let entry = provider.stat(&uri).await.unwrap();

        assert_eq!(entry.name, "test.md");
        assert_eq!(entry.kind, FileKind::File);
        assert!(entry.size.is_some());
        assert!(entry.modified.is_some());
    }

    #[tokio::test]
    async fn stat_not_found() {
        let provider = LocalProvider::new();
        let uri = make_uri(std::path::Path::new("/nonexistent/file.md"));
        let result = provider.stat(&uri).await;
        assert!(matches!(result, Err(FsError::NotFound(_))));
    }

    #[tokio::test]
    async fn read_bytes_works() {
        let tmp = TempDir::new().unwrap();
        let file_path = tmp.path().join("test.md");
        fs::write(&file_path, "hello world").unwrap();

        let provider = LocalProvider::new();
        let uri = make_uri(&file_path);
        let bytes = provider.read_bytes(&uri).await.unwrap();
        assert_eq!(bytes, b"hello world");
    }

    #[tokio::test]
    async fn read_text_uses_default_impl() {
        let tmp = TempDir::new().unwrap();
        let file_path = tmp.path().join("test.md");
        fs::write(&file_path, "# こんにちは").unwrap();

        let provider = LocalProvider::new();
        let uri = make_uri(&file_path);
        let text = provider.read_text(&uri).await.unwrap();
        assert_eq!(text, "# こんにちは");
    }

    #[tokio::test]
    async fn read_text_rejects_invalid_utf8() {
        let tmp = TempDir::new().unwrap();
        let file_path = tmp.path().join("binary.md");
        fs::write(&file_path, &[0xFF, 0xFE, 0x00]).unwrap();

        let provider = LocalProvider::new();
        let uri = make_uri(&file_path);
        let result = provider.read_text(&uri).await;
        assert!(matches!(result, Err(FsError::InvalidUtf8)));
    }

    #[tokio::test]
    async fn watch_detects_modification() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();
        let file_path = root.join("watched.md");
        fs::write(&file_path, "initial").unwrap();

        let provider = LocalProvider::new();
        let uri = make_uri(&root);
        let (tx, mut rx) = mpsc::channel(32);
        let _handle = provider.watch(&uri, tx).await.unwrap();

        // Give the watcher a moment to initialize
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // Modify the file
        fs::write(&file_path, "modified").unwrap();

        // Wait for the event (with timeout)
        let event = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("timed out waiting for watch event")
            .expect("channel closed");

        // We should get some kind of event (Modify or Create depending on platform)
        assert!(
            event.kind == WatchEventKind::Modify || event.kind == WatchEventKind::Create,
            "unexpected event kind: {:?}",
            event.kind
        );
    }
}
