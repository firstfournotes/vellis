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

/// Maximum file size for `read_bytes` (50 MB).
///
/// This caps the *whole-file* read only. `read_range` streams and is deliberately
/// exempt, so a large asset is served in pieces rather than refused (要件#27).
/// The limit was 10 MB until backlog #59 showed it turning away files the viewers
/// are expected to open (3D models above 10 MB, 要件#23).
const MAX_FILE_SIZE: u64 = 50 * 1024 * 1024;

/// Buffer size for one `read` call inside `read_range` (64 KB).
///
/// Only an I/O granularity — unrelated to `asset::STREAM_CHUNK_SIZE`, which caps
/// how much one HTTP response carries.
const READ_CHUNK_SIZE: u64 = 64 * 1024;

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
            let file_name = de.file_name();
            let name = file_name.to_string_lossy().to_string();

            // Skip hidden files/directories. Decided on the name alone, before any
            // symlink is resolved, so a hidden broken link costs nothing (要件#31).
            if name.starts_with('.') {
                continue;
            }

            let entry_path = dir_path.join(&name);

            // `DirEntry::metadata` does *not* traverse symlinks, so a link to a
            // directory would show up as `Symlink` and the tree could not expand it
            // (要件#31 契約①, backlog #68). Re-stat links through `fs::metadata`
            // (which follows) so kind/size/modified describe the *target*.
            let mut metadata = de.metadata().await.map_err(io_to_fs)?;
            if metadata.is_symlink() {
                match tokio::fs::metadata(&entry_path).await {
                    Ok(target) => metadata = target,
                    Err(e) => {
                        // Unreachable target — missing, a permission wall, or a loop
                        // (ELOOP on a self-referencing link). Keep the entry listed as
                        // a symlink instead of failing the whole listing (契約②).
                        tracing::debug!(
                            path = %entry_path.display(),
                            error = %e,
                            "symlink target is unreachable; listing it as Symlink"
                        );
                    }
                }
            }

            let kind = if metadata.is_dir() {
                FileKind::Dir
            } else if metadata.is_file() {
                // Every regular file is listed, regardless of extension.
                FileKind::File
            } else if metadata.is_symlink() {
                // Only reachable when the re-stat above failed: a broken link.
                FileKind::Symlink
            } else {
                continue;
            };

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
        // `fs::metadata` follows symlinks, so a link is already described by its
        // target here — the same rule `list` now applies (要件#31 契約④). There is
        // no `Symlink` arm because this metadata can never report one.
        let metadata = tokio::fs::metadata(path).await.map_err(io_to_fs)?;

        let kind = if metadata.is_dir() {
            FileKind::Dir
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

    /// Seek to `start` and read up to `max_len` bytes in 64 KB chunks.
    ///
    /// Overrides the trait default (whole-file read + slice) so that a partial
    /// read costs only the bytes asked for. No `MAX_FILE_SIZE` check: the size
    /// cap exists to bound a single whole-file read, and this path is bounded by
    /// `max_len` instead (要件#27 契約③).
    async fn read_range(&self, uri: &Uri, start: u64, max_len: u64) -> Result<Vec<u8>, FsError> {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};

        let mut file = tokio::fs::File::open(&uri.path).await.map_err(io_to_fs)?;
        if start > 0 {
            file.seek(std::io::SeekFrom::Start(start))
                .await
                .map_err(io_to_fs)?;
        }

        let mut out = Vec::new();
        let mut buf = vec![0u8; max_len.min(READ_CHUNK_SIZE) as usize];
        let mut remaining = max_len;

        while remaining > 0 {
            let want = remaining.min(buf.len() as u64) as usize;
            let n = file.read(&mut buf[..want]).await.map_err(io_to_fs)?;
            if n == 0 {
                break; // EOF: return what we got (past-EOF reads are not errors)
            }
            out.extend_from_slice(&buf[..n]);
            remaining -= n as u64;
        }

        Ok(out)
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

    /// Replace the file at `uri` atomically (要件#48 契約①).
    ///
    /// Writes a sibling temp file, flushes it to disk, then `rename`s it over
    /// the target — the same tmp+rename shape `annotation/store.rs` uses for
    /// `marks.jsonl`. A crash mid-write therefore leaves either the old file
    /// or the new one, never a truncated document. The temp file is a sibling
    /// (not `/tmp`) so the rename stays within one filesystem, which is what
    /// makes it atomic.
    ///
    /// Bytes go out exactly as given: no newline translation, no BOM
    /// handling, no trailing-newline insertion. The editor buffer round-trips
    /// through `<pre>` unchanged (契約②) and it must survive this step too.
    ///
    /// The only refusal here is a path carrying `..`. Root containment is
    /// checked one layer up, by `save_document`, because a `LocalProvider`
    /// holds no root of its own (追補a).
    async fn write_text(&self, uri: &str, content: &str) -> Result<(), FsError> {
        let parsed = Uri::parse(uri).map_err(|e| FsError::PermissionDenied(e.to_string()))?;
        if parsed.scheme != "file" {
            return Err(FsError::UnsupportedScheme(parsed.scheme.clone()));
        }
        let target = parsed.path;

        // `..` is refused before anything is opened: a path that walks up is
        // never something the user pointed at, and resolving it here would
        // silently write somewhere else (snapshot.rs `resolve_source` refuses
        // the same shape for the same reason).
        if target
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(FsError::PermissionDenied(format!(
                "path contains a parent-directory component: {}",
                target.display()
            )));
        }

        let parent = target.parent().ok_or_else(|| {
            FsError::PermissionDenied(format!("{} has no parent directory", target.display()))
        })?;
        let file_name = target.file_name().ok_or_else(|| {
            FsError::PermissionDenied(format!("{} has no file name", target.display()))
        })?;

        // Hidden name so a crash between create and rename does not leave
        // something the explorer would list (hidden entries are skipped by
        // `list`, 要件#31).
        let mut tmp_name = std::ffi::OsString::from(".");
        tmp_name.push(file_name);
        tmp_name.push(".vellis-tmp");
        let tmp_path = parent.join(tmp_name);

        if let Err(e) = write_then_rename(&tmp_path, &target, content).await {
            // Best-effort cleanup: a failed write must not leave the temp file
            // behind next to the document.
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err(e);
        }
        Ok(())
    }
}

/// Write `content` to `tmp_path`, fsync it, then rename it onto `target`.
async fn write_then_rename(
    tmp_path: &std::path::Path,
    target: &std::path::Path,
    content: &str,
) -> Result<(), FsError> {
    use tokio::io::AsyncWriteExt;

    let mut file = tokio::fs::File::create(tmp_path).await.map_err(io_to_fs)?;
    file.write_all(content.as_bytes()).await.map_err(io_to_fs)?;
    // fsync before the rename: without it the rename can land while the new
    // contents are still only in the page cache, and a power loss leaves an
    // empty file where the document was.
    file.sync_all().await.map_err(io_to_fs)?;
    drop(file);
    tokio::fs::rename(tmp_path, target).await.map_err(io_to_fs)?;
    Ok(())
}

/// Resolve `target` and refuse it unless it lives under `root` (要件#48 追補a).
///
/// Returns the canonical path to write to. This is the **only** root check on
/// the write path: `LocalProvider` is a unit struct with no root of its own,
/// so containment is the command layer's job, and it is a pure function here
/// so it can be judged on its own.
///
/// Both sides are canonicalised before comparing, which is what makes a
/// symlink pointing out of the root a refusal rather than a hole: the string
/// `<root>/looks-inside.txt` is under the root, its canonical form is not.
/// A file that does not exist yet (a first save) is resolved through its
/// parent directory instead, so creating a new file under the root is allowed
/// while creating one outside is not.
pub fn ensure_within_root(
    root: &std::path::Path,
    target: &std::path::Path,
) -> Result<std::path::PathBuf, FsError> {
    let canonical_root = std::fs::canonicalize(root).map_err(|e| {
        FsError::PermissionDenied(format!("cannot resolve root {}: {}", root.display(), e))
    })?;

    let resolved = if target.exists() {
        std::fs::canonicalize(target).map_err(|e| {
            FsError::PermissionDenied(format!("cannot resolve {}: {}", target.display(), e))
        })?
    } else {
        let parent = target.parent().ok_or_else(|| {
            FsError::PermissionDenied(format!("{} has no parent directory", target.display()))
        })?;
        let file_name = target.file_name().ok_or_else(|| {
            FsError::PermissionDenied(format!("{} has no file name", target.display()))
        })?;
        let parent_canon = std::fs::canonicalize(parent).map_err(|e| {
            FsError::PermissionDenied(format!("cannot resolve {}: {}", parent.display(), e))
        })?;
        parent_canon.join(file_name)
    };

    if !resolved.starts_with(&canonical_root) {
        return Err(FsError::PermissionDenied(format!(
            "{} resolves outside the current root {}",
            target.display(),
            canonical_root.display()
        )));
    }
    Ok(resolved)
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
