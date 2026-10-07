//! Recently opened files (requirements.md #64).
//!
//! A single JSON array of file URI strings (head = most recent) stored in the
//! app config directory as `recent-files.json`.  It is kept apart from the
//! folder history (`history.rs` / `history.json`, requirements.md #3) on
//! purpose: different name, different file, different UI.
//!
//! The store is global — one list for the whole app — and the Explorer's
//! Recent Files section narrows it to the current root when it reads it
//! ([`RecentFilesStore::list_under_root`]).  Keeping the store global and
//! filtering on display is what lets a root raised with ↑ still show what was
//! opened while a child folder was the root (契約4).  The overall cap
//! ([`MAX_RECENT_FILES`]) is much larger than what is shown
//! ([`RECENT_FILES_SHOWN`]) so that heavy use of one root does not push
//! another root's entries out.
//!
//! Persistence follows `history.rs`: serde_json + atomic write (tmp → rename),
//! and reads never fail the caller — a missing or unreadable file is an empty
//! list, rewritten into a clean state by the next write.  Unlike the folder
//! history, entries are compared as plain strings: a file URI arrives exactly
//! as `open_document` received it, and there is no spelling to normalize.
//!
//! Writes are serialized through a process-wide `std::sync::Mutex`
//! (`tasks/lessons.md`「連射される file_changed と並列 IPC は競合する」):
//! windows can open documents concurrently, and two read-modify-write cycles
//! racing on the same `*.tmp` would lose an entry or fail the rename.  The
//! lock is global rather than per instance because callers build a fresh
//! store per call (`record_file` / the commands), and the app has exactly one
//! recent-files file.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use thiserror::Error;

use crate::errors::FsError;

/// Overall cap on remembered files (契約3). The oldest entries are dropped.
pub const MAX_RECENT_FILES: usize = 100;

/// How many entries the Recent Files section shows for one root (契約4).
pub const RECENT_FILES_SHOWN: usize = 10;

/// Filename used inside the app config directory (契約3). Not `history.json`.
pub const RECENT_FILES_FILENAME: &str = "recent-files.json";

/// Serializes every read-modify-write of the store (see the module docs).
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Error)]
pub enum RecentFilesError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Persistent list of recently opened file URIs (most recent first).
pub struct RecentFilesStore {
    file: PathBuf,
}

impl RecentFilesStore {
    /// Bind a store to `file`.  Neither the file nor its parent directory
    /// need to exist — creation is deferred to the first write.
    pub fn new(file: &Path) -> Self {
        Self {
            file: file.to_path_buf(),
        }
    }

    /// Read every remembered file, most recent first.
    ///
    /// A missing file yields an empty list, and so does a file that cannot be
    /// parsed as a JSON array of strings (logged as a warning); the next write
    /// rewrites it into a clean state.
    pub fn list(&self) -> Result<Vec<String>, RecentFilesError> {
        let raw = match fs::read_to_string(&self.file) {
            Ok(raw) => raw,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        match serde_json::from_str::<Vec<String>>(&raw) {
            Ok(entries) => Ok(entries),
            Err(e) => {
                tracing::warn!(
                    "recent files: ignoring unreadable file {}: {}",
                    self.file.display(),
                    e
                );
                Ok(Vec::new())
            }
        }
    }

    /// The files under `root`, most recent first, at most
    /// [`RECENT_FILES_SHOWN`] of them (契約4).
    pub fn list_under_root(&self, root: &str) -> Result<Vec<String>, RecentFilesError> {
        Ok(self
            .list()?
            .into_iter()
            .filter(|uri| is_under_root(uri, root))
            .take(RECENT_FILES_SHOWN)
            .collect())
    }

    /// Put `uri` at the head and persist immediately (契約3).  An existing
    /// entry with the same spelling moves up instead of being duplicated;
    /// anything past [`MAX_RECENT_FILES`] is dropped from the tail.
    pub fn add(&self, uri: &str) -> Result<(), RecentFilesError> {
        let _guard = lock_writes();
        let mut entries = vec![uri.to_string()];
        entries.extend(self.list()?.into_iter().filter(|existing| existing != uri));
        entries.truncate(MAX_RECENT_FILES);
        self.write(&entries)
    }

    /// Drop `uri` (契約8).  Unknown URIs leave the store untouched.
    pub fn remove(&self, uri: &str) -> Result<(), RecentFilesError> {
        let _guard = lock_writes();
        self.retain(|existing| existing != uri)
    }

    /// Drop every entry under `root` (契約9).  Entries of other roots keep
    /// their order.
    pub fn remove_under_root(&self, root: &str) -> Result<(), RecentFilesError> {
        let _guard = lock_writes();
        self.retain(|existing| !is_under_root(existing, root))
    }

    /// Keep the entries `keep` accepts; writes only when something went away.
    /// The caller holds the write lock.
    fn retain(&self, keep: impl Fn(&str) -> bool) -> Result<(), RecentFilesError> {
        let entries = self.list()?;
        let kept: Vec<String> = entries.iter().filter(|e| keep(e)).cloned().collect();
        if kept.len() == entries.len() {
            return Ok(());
        }
        self.write(&kept)
    }

    /// Atomic write (tmp → rename), creating the parent directory on demand.
    fn write(&self, entries: &[String]) -> Result<(), RecentFilesError> {
        if let Some(parent) = self.file.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        let tmp_path = self.file.with_extension("json.tmp");
        let body = serde_json::to_string(entries)?;
        let mut file = fs::File::create(&tmp_path)?;
        file.write_all(body.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp_path, &self.file)?;
        Ok(())
    }
}

/// Take the process-wide write lock.  A poisoned lock only means another
/// writer panicked; the file itself is still whole (atomic rename), so carry on.
fn lock_writes() -> MutexGuard<'static, ()> {
    WRITE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Whether `uri` lies under `root`, judged on the strings alone (契約4).
///
/// One trailing `/` is dropped from `root` and a `/` is added back, and `uri`
/// must start with that and go on past it: `file:///a/b` holds
/// `file:///a/b/c.md` but not `file:///a/bc.md`, and not `file:///a/b` itself.
/// The scheme and the authority are part of the string, so an ssh root never
/// holds another user's or a local file.  No symlink resolution and no case
/// folding — nothing here touches the disk (the same stance as the folder
/// history's `normalize_uri`).
pub fn is_under_root(uri: &str, root: &str) -> bool {
    let base = root.strip_suffix('/').unwrap_or(root);
    uri.len() > base.len() + 1
        && uri.starts_with(base)
        && uri.as_bytes()[base.len()] == b'/'
}

/// Whether a failed open should drop the file from the list (契約8): only a
/// plain "not found".  Permission errors, ssh disconnects and the like may be
/// temporary, and losing the entry for them would be a surprise.
pub fn should_forget_on_open_error(err: &FsError) -> bool {
    matches!(err, FsError::NotFound(_))
}

/// Default store file: `<app config dir>/recent-files.json`, next to the
/// folder history's `history.json`.
pub fn default_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    use tauri::Manager;
    match app.path().app_config_dir() {
        Ok(dir) => Some(dir.join(RECENT_FILES_FILENAME)),
        Err(e) => {
            tracing::warn!("recent files: no app config dir available: {}", e);
            None
        }
    }
}

/// Record a document this window has just opened (契約1・2).
///
/// Best-effort, like `history::record_root`: any failure is logged and
/// swallowed so opening a document never breaks because the list could not
/// be written.
pub fn record_file<R: tauri::Runtime>(app: &tauri::AppHandle<R>, uri: &str) {
    // `vellis --self-check` leaves Recent Files alone (requirements.md #72 契約8).
    if !crate::self_check::active_plan().recent_files {
        return;
    }
    let Some(path) = default_path(app) else {
        return;
    };
    if let Err(e) = RecentFilesStore::new(&path).add(uri) {
        tracing::warn!("recent files: failed to record '{}': {}", uri, e);
    }
}

/// Drop a file that turned out not to exist any more (契約8).  Best-effort in
/// the same way as [`record_file`].
pub fn forget_file<R: tauri::Runtime>(app: &tauri::AppHandle<R>, uri: &str) {
    if !crate::self_check::active_plan().recent_files {
        return;
    }
    let Some(path) = default_path(app) else {
        return;
    };
    if let Err(e) = RecentFilesStore::new(&path).remove(uri) {
        tracing::warn!("recent files: failed to forget '{}': {}", uri, e);
    }
}
