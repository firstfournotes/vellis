use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;
use tracing;

use crate::errors::FsError;

use super::entry::{Entry, FileKind, LinkInfo};
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

            // Hidden names are listed like any other: hiding them is the exclude
            // settings' job (`files.exclude` defaults to `**/.*`, 要件#65 契約2),
            // applied by the callers that hand a listing to the tree.

            let entry_path = dir_path.join(&name);

            // `DirEntry::metadata` does *not* traverse symlinks, so a link to a
            // directory would show up as `Symlink` and the tree could not expand it
            // (要件#31 契約①, backlog #68). Re-stat links through `fs::metadata`
            // (which follows) so kind/size/modified describe the *target*.
            let mut metadata = de.metadata().await.map_err(io_to_fs)?;
            let mut link = None;
            if metadata.is_symlink() {
                // The raw link text for the tree's tooltip (要件#70 契約1). A failed
                // readlink (e.g. the link vanished mid-listing) only drops `target`.
                let target = tokio::fs::read_link(&entry_path)
                    .await
                    .ok()
                    .map(|t| t.to_string_lossy().to_string());
                let broken = match tokio::fs::metadata(&entry_path).await {
                    Ok(followed) => {
                        metadata = followed;
                        false
                    }
                    Err(e) => {
                        // Unreachable target — missing, a permission wall, or a loop
                        // (ELOOP on a self-referencing link). Keep the entry listed as
                        // a symlink instead of failing the whole listing (契約②).
                        tracing::debug!(
                            path = %entry_path.display(),
                            error = %e,
                            "symlink target is unreachable; listing it as Symlink"
                        );
                        true
                    }
                };
                link = Some(LinkInfo { target, broken });
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
                link,
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
            link: None,
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
    /// A symlink is written *through*, not over (追補d(1)): the bytes land in
    /// the file the link resolves to (following a chain of links), the temp
    /// file is made next to *that* file so the rename stays on its
    /// filesystem, and the link itself is left as it was — what vim and
    /// VS Code do. `rename` never follows its destination, so renaming onto
    /// the link's own path would swap the link for a plain file and leave
    /// the real document stale. A link whose target is missing is refused
    /// outright (追補d(2)): writing would either replace the link or create
    /// a file the user never opened.
    ///
    /// The replaced file keeps its mode, ACL and extended attributes (Finder
    /// tags included, 追補e): they are copied onto the temp file before the
    /// rename, from the file actually being replaced — through a symlink,
    /// the link's target. A hard link's other names still keep the old
    /// contents, as before: the rename gives the document a new inode.
    ///
    /// The only other refusal here is a path carrying `..`. Root containment
    /// is checked one layer up, by `save_document`, because a `LocalProvider`
    /// holds no root of its own (追補a).
    async fn write_text(&self, uri: &str, content: &str) -> Result<(), FsError> {
        let parsed = Uri::parse(uri).map_err(|e| FsError::PermissionDenied(e.to_string()))?;
        if parsed.scheme != "file" {
            return Err(FsError::UnsupportedScheme(parsed.scheme.clone()));
        }

        // `..` is refused before anything is opened: a path that walks up is
        // never something the user pointed at, and resolving it here would
        // silently write somewhere else (snapshot.rs `resolve_source` refuses
        // the same shape for the same reason). It is judged on the path as
        // given; a link's own target may well contain `..` (`../y/b.md`).
        if parsed
            .path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(FsError::PermissionDenied(format!(
                "path contains a parent-directory component: {}",
                parsed.path.display()
            )));
        }

        let target = resolve_write_target(parsed.path).await?;

        let parent = target.parent().ok_or_else(|| {
            FsError::PermissionDenied(format!("{} has no parent directory", target.display()))
        })?;
        let file_name = target.file_name().ok_or_else(|| {
            FsError::PermissionDenied(format!("{} has no file name", target.display()))
        })?;

        // A name ending in `.vellis-tmp`, so a crash between create and rename
        // does not leave something the explorer would list (the built-in
        // exclusion hides it whatever the settings say, 要件#65 契約2).
        let mut tmp_name = std::ffi::OsString::from(".");
        tmp_name.push(file_name);
        tmp_name.push(".vellis-tmp");
        let tmp_path = parent.join(tmp_name);

        if let Err(e) = write_then_rename(&tmp_path, &target, content).await {
            // Best-effort cleanup: a failed write must not leave the temp file
            // behind next to the document.
            discard_tmp(&tmp_path).await;
            return Err(e);
        }
        Ok(())
    }
}

/// Remove a temp file left by a failed save, best effort.
///
/// The temp file may carry the original's file flags and ACL by now (追補e(1)):
/// a document locked in Finder (`uchg`) or carrying `everyone deny delete`
/// cannot be replaced, so its save fails at the rename, and the copied flag or
/// ACL would then make the temp file itself undeletable. Clear the temp file's
/// flags and ACL and try once more rather than leave it next to the document
/// (追補f(1)). Only the temp file is touched, never the original.
async fn discard_tmp(tmp_path: &std::path::Path) {
    if tokio::fs::remove_file(tmp_path).await.is_ok() {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        if let Ok(c_path) = std::ffi::CString::new(tmp_path.as_os_str().as_bytes()) {
            // Flags first: `uchg` refuses the ACL change as well. Each step is
            // best effort; whichever of the two the temp file carries, the
            // removal below gets its chance.
            // SAFETY: `c_path` is a valid NUL-terminated path for the whole call.
            unsafe { libc::chflags(c_path.as_ptr(), 0) };
            clear_acl(&c_path);
            let _ = tokio::fs::remove_file(tmp_path).await;
        }
    }
}

/// Replace the extended ACL of the file at `path` with an empty one — what
/// `chmod -N` does. The `libc` crate has no `acl_*` bindings, so the three
/// calls are declared here; they live in libSystem, which every macOS binary
/// links already (no new dependency).
#[cfg(target_os = "macos")]
fn clear_acl(path: &std::ffi::CStr) {
    type AclT = *mut std::ffi::c_void;
    const ACL_TYPE_EXTENDED: std::ffi::c_uint = 0x0000_0100;
    extern "C" {
        fn acl_init(count: std::ffi::c_int) -> AclT;
        fn acl_set_file(
            path_p: *const std::ffi::c_char,
            acl_type: std::ffi::c_uint,
            acl: AclT,
        ) -> std::ffi::c_int;
        fn acl_free(obj_p: *mut std::ffi::c_void) -> std::ffi::c_int;
    }
    // SAFETY: `acl_init` returns an owned ACL or null; a non-null one is used
    // for one `acl_set_file` with a valid NUL-terminated path and then freed
    // exactly once.
    unsafe {
        let acl = acl_init(0);
        if acl.is_null() {
            return;
        }
        acl_set_file(path.as_ptr(), ACL_TYPE_EXTENDED, acl);
        acl_free(acl);
    }
}

/// The path `write_text` should actually replace (要件#48 追補d(1)(2)).
///
/// A symlink (the final component only) is resolved through the whole chain
/// to its canonical target; anything else — a plain file, or a path that does
/// not exist yet (a first save) — is written where it is, as before. A link
/// that cannot be resolved (missing target, a loop) is an error, so a refused
/// save neither replaces the link nor creates its target.
async fn resolve_write_target(path: std::path::PathBuf) -> Result<std::path::PathBuf, FsError> {
    match tokio::fs::symlink_metadata(&path).await {
        Ok(meta) if meta.file_type().is_symlink() => {
            tokio::fs::canonicalize(&path).await.map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => FsError::NotFound(format!(
                    "{} is a broken symlink (its target does not exist): {}",
                    path.display(),
                    e
                )),
                _ => io_to_fs(e),
            })
        }
        _ => Ok(path),
    }
}

/// Write `content` to `tmp_path`, give it `target`'s metadata, fsync it, then
/// rename it onto `target`.
async fn write_then_rename(
    tmp_path: &std::path::Path,
    target: &std::path::Path,
    content: &str,
) -> Result<(), FsError> {
    use tokio::io::AsyncWriteExt;

    let mut file = tokio::fs::File::create(tmp_path).await.map_err(io_to_fs)?;
    file.write_all(content.as_bytes()).await.map_err(io_to_fs)?;
    // Surface the write's own error here: `into_std` waits for an in-flight
    // write but would drop its error.
    file.flush().await.map_err(io_to_fs)?;
    let file = file.into_std().await;

    let original = target.to_path_buf();
    tokio::task::spawn_blocking(move || {
        // A fresh temp file has the umask's mode and no ACL or extended
        // attributes, so the rename would strip the document of them on every
        // save (追補e(1)). Copy them over first; `target` is the file being
        // replaced — for a save through a symlink, the link's target (追補e(2)).
        copy_metadata_from_original(&original, &file);
        // fsync before the rename: without it the rename can land while the
        // new contents are still only in the page cache, and a power loss
        // leaves an empty file where the document was. Done after the
        // metadata copy so the one flush covers that too.
        file.sync_all()
    })
    .await
    .map_err(|e| FsError::Io(std::io::Error::other(e.to_string())))?
    .map_err(io_to_fs)?;

    tokio::fs::rename(tmp_path, target).await.map_err(io_to_fs)?;
    Ok(())
}

/// Give the temp file `tmp` the mode, ACL and extended attributes (Finder
/// tags included) of `original`, the file it is about to replace (要件#48
/// 追補e(1)).
///
/// macOS does it with `fcopyfile(3)` and `COPYFILE_METADATA` — mode, owner,
/// file flags, ACL and extended attributes in one call. That flag also copies
/// the original's access and modification times, which would make a saved
/// document look untouched (Finder's date, `make`, a backup tool that compares
/// size and mtime), so the temp file's own times — this save's — are put back
/// afterwards. Other platforms copy the mode only.
///
/// Best effort (追補e(3)): no original (a first save) means nothing to copy,
/// and a copy that fails — say an ACL the user may not set — is logged while
/// the save goes on. Keeping the new contents matters more than the metadata.
#[cfg(target_os = "macos")]
fn copy_metadata_from_original(original: &std::path::Path, tmp: &std::fs::File) {
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::io::AsRawFd;

    // Opened only for its descriptor. `O_NONBLOCK` keeps a FIFO at this path
    // from blocking the save until some writer shows up.
    let source = match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(original)
    {
        Ok(source) => source,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            tracing::warn!(
                path = %original.display(),
                error = %e,
                "save: cannot open the original to copy its mode, ACL and extended attributes; saving without them"
            );
            return;
        }
    };

    let own_times = tmp
        .metadata()
        .and_then(|m| Ok((m.accessed()?, m.modified()?)));

    // SAFETY: both descriptors stay open for the whole call (`source` and
    // `tmp` are borrowed for this scope) and a null state is allowed.
    let rc = unsafe {
        libc::fcopyfile(
            source.as_raw_fd(),
            tmp.as_raw_fd(),
            std::ptr::null_mut(),
            libc::COPYFILE_METADATA,
        )
    };
    if rc != 0 {
        tracing::warn!(
            path = %original.display(),
            error = %std::io::Error::last_os_error(),
            "save: could not copy the original's mode, ACL and extended attributes; saving anyway"
        );
    }

    let restored = own_times.and_then(|(accessed, modified)| {
        tmp.set_times(
            std::fs::FileTimes::new()
                .set_accessed(accessed)
                .set_modified(modified),
        )
    });
    if let Err(e) = restored {
        tracing::warn!(
            path = %original.display(),
            error = %e,
            "save: could not set the saved file's modification time; it may show the previous one"
        );
    }
}

/// See the macOS version above. Here only the mode is copied.
#[cfg(not(target_os = "macos"))]
fn copy_metadata_from_original(original: &std::path::Path, tmp: &std::fs::File) {
    let permissions = match std::fs::metadata(original) {
        Ok(meta) => meta.permissions(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            tracing::warn!(
                path = %original.display(),
                error = %e,
                "save: cannot read the original's permissions; saving without them"
            );
            return;
        }
    };
    if let Err(e) = tmp.set_permissions(permissions) {
        tracing::warn!(
            path = %original.display(),
            error = %e,
            "save: could not copy the original's permissions; saving anyway"
        );
    }
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
///
/// The returned path is also the path to *write* (追補d(3)): for a symlink
/// it is the link's canonical target, so the root check and the write judge
/// the same file and a link re-pointed after the check cannot steer the
/// write elsewhere. A symlink whose target is missing is refused here rather
/// than resolved through its parent (追補d(2)) — its own location says
/// nothing about where a write through it would land.
pub fn ensure_within_root(
    root: &std::path::Path,
    target: &std::path::Path,
) -> Result<std::path::PathBuf, FsError> {
    let canonical_root = std::fs::canonicalize(root).map_err(|e| {
        FsError::PermissionDenied(format!("cannot resolve root {}: {}", root.display(), e))
    })?;

    // `symlink_metadata`, not `exists()`: the latter follows links and calls
    // a dangling one absent, which would send it down the first-save branch.
    let resolved = if std::fs::symlink_metadata(target).is_ok() {
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
        // 要件#1(requirements.md #1): 全ファイルを列挙する。隠すのは除外の設定(要件#65
        // 契約2・11: `list` は隠し名も返し、`files.exclude` の既定 `**/.*` がツリーから隠す)
        assert!(names.contains(&"subdir"));
        assert!(names.contains(&"readme.md"));
        assert!(names.contains(&"notes.markdown"));
        assert!(names.contains(&"design.mdx"));
        assert!(names.contains(&"image.png"));
        assert!(names.contains(&"data.json"));
        assert!(names.contains(&".hidden.md"));

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
