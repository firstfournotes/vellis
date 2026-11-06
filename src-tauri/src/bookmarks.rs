//! Bookmarks — folders and files the user pinned to the Dashboard
//! (requirements.md #83 契約7・9).
//!
//! A single JSON array stored in the app config directory as
//! `bookmarks.json`: `[{ "uri": "<URI>", "kind": "folder" }, …]`, in the order
//! the Dashboard shows them (the user decides it, 決定3). One list for the
//! whole app, across roots.
//!
//! Built the way `history.rs` and `recent_files.rs` are: serde_json + atomic
//! write (tmp → rename), a process-wide write lock (several windows can pin at
//! once), and reads that never fail the caller — a missing file is an empty
//! list, and so is one that cannot be parsed (logged as a warning); the next
//! write rewrites it into a clean state. URIs are compared and stored through
//! `history::normalize_uri`, so `file:///a/b/` and `file:///a//b` are the same
//! bookmark (契約7 (ad)).
//!
//! Only the user's own gestures write here (Pin / Unpin / Move / Add
//! Bookmark…). The self-check window (requirements.md #72) shows neither the
//! Dashboard nor a context menu, so the store has no self-check branch.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::history::normalize_uri;

/// Filename used inside the app config directory (契約9).
pub const BOOKMARKS_FILENAME: &str = "bookmarks.json";

/// Event sent to every window with the whole list after a command changed it
/// (契約9 (ap)). Must match `BOOKMARKS_CHANGED_EVENT` in `src/lib/bookmarks.ts`.
pub const BOOKMARKS_CHANGED_EVENT: &str = "bookmarks_changed";

/// Serializes every read-modify-write of the store (see the module docs).
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// What a bookmark points at.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BookmarkKind {
    Folder,
    File,
}

impl BookmarkKind {
    /// The command argument (`"folder"` / `"file"`); anything else is `None`.
    pub fn parse(kind: &str) -> Option<Self> {
        match kind {
            "folder" => Some(Self::Folder),
            "file" => Some(Self::File),
            _ => None,
        }
    }
}

/// One pinned folder or file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bookmark {
    pub uri: String,
    pub kind: BookmarkKind,
}

#[derive(Debug, Error)]
pub enum BookmarkError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Persistent, user-ordered list of bookmarks.
pub struct BookmarkStore {
    file: PathBuf,
}

impl BookmarkStore {
    /// Bind a store to `file`. Neither the file nor its parent directory need
    /// to exist — creation is deferred to the first write.
    pub fn new(file: &Path) -> Self {
        Self {
            file: file.to_path_buf(),
        }
    }

    /// Read every bookmark in the user's order.
    ///
    /// A missing file yields an empty list, and so does a file that cannot be
    /// parsed as an array of `{ uri, kind }` (logged as a warning).
    pub fn list(&self) -> Result<Vec<Bookmark>, BookmarkError> {
        let raw = match fs::read_to_string(&self.file) {
            Ok(raw) => raw,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        match serde_json::from_str::<Vec<Bookmark>>(&raw) {
            Ok(entries) => Ok(entries),
            Err(e) => {
                tracing::warn!(
                    "bookmarks: ignoring unreadable bookmarks file {}: {}",
                    self.file.display(),
                    e
                );
                Ok(Vec::new())
            }
        }
    }

    /// Append `uri` at the tail (契約7 (ad)) and persist. A URI already pinned
    /// (normalized comparison, whatever its kind) is not added again and keeps
    /// its place; nothing is written then. No cap.
    pub fn add(&self, uri: &str, kind: BookmarkKind) -> Result<Vec<Bookmark>, BookmarkError> {
        let _guard = lock_writes();
        let uri = normalize_uri(uri);
        let mut entries = self.list()?;
        if entries.iter().any(|b| normalize_uri(&b.uri) == uri) {
            return Ok(entries);
        }
        entries.push(Bookmark { uri, kind });
        self.write(&entries)?;
        Ok(entries)
    }

    /// Drop the bookmark naming `uri` (normalized comparison) and persist. A
    /// URI that is not pinned writes nothing.
    pub fn remove(&self, uri: &str) -> Result<Vec<Bookmark>, BookmarkError> {
        let _guard = lock_writes();
        let target = normalize_uri(uri);
        let entries = self.list()?;
        let kept: Vec<Bookmark> = entries
            .iter()
            .filter(|b| normalize_uri(&b.uri) != target)
            .cloned()
            .collect();
        if kept.len() == entries.len() {
            return Ok(entries);
        }
        self.write(&kept)?;
        Ok(kept)
    }

    /// Move the bookmark naming `uri` to position `to` of the list *without*
    /// it (契約16); an out-of-range `to` lands at the tail. Moving to where it
    /// already is, or a URI that is not pinned, writes nothing.
    pub fn move_to(&self, uri: &str, to: usize) -> Result<Vec<Bookmark>, BookmarkError> {
        let _guard = lock_writes();
        let target = normalize_uri(uri);
        let mut entries = self.list()?;
        let Some(from) = entries.iter().position(|b| normalize_uri(&b.uri) == target) else {
            return Ok(entries);
        };
        let moved = entries.remove(from);
        let to = to.min(entries.len());
        if to == from {
            entries.insert(from, moved);
            return Ok(entries);
        }
        entries.insert(to, moved);
        self.write(&entries)?;
        Ok(entries)
    }

    /// Atomic write (tmp → rename), creating the parent directory on demand.
    /// Every URI is written in its normalized spelling.
    fn write(&self, entries: &[Bookmark]) -> Result<(), BookmarkError> {
        if let Some(parent) = self.file.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        let normalized: Vec<Bookmark> = entries
            .iter()
            .map(|b| Bookmark {
                uri: normalize_uri(&b.uri),
                kind: b.kind,
            })
            .collect();
        let tmp_path = self.file.with_extension("json.tmp");
        let body = serde_json::to_string(&normalized)?;
        let mut file = fs::File::create(&tmp_path)?;
        file.write_all(body.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp_path, &self.file)?;
        Ok(())
    }
}

/// Take the process-wide write lock. A poisoned lock only means another writer
/// panicked; the file itself is still whole (atomic rename), so carry on.
fn lock_writes() -> MutexGuard<'static, ()> {
    WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Default bookmarks file: `<app config dir>/bookmarks.json` (契約9), next to
/// `history.json` and `recent-files.json`.
pub fn default_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    use tauri::Manager;
    match app.path().app_config_dir() {
        Ok(dir) => Some(dir.join(BOOKMARKS_FILENAME)),
        Err(e) => {
            tracing::warn!("bookmarks: no app config dir available: {}", e);
            None
        }
    }
}
