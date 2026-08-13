//! Recently-opened folder history (requirements.md #3).
//!
//! A single JSON array of root URI strings (head = most recent) stored in
//! the app config directory.  The store is deliberately dumb: it takes a
//! file path, dedupes, caps at [`MAX_HISTORY`] and persists on every `add`.
//! Requirement #4 (history picker on argument-less launch) reads the same
//! file back through [`HistoryStore::list`].
//!
//! Dedupe compares the *normalized* URI (requirements.md #6) so that the
//! spellings a folder picks up along the way — a trailing slash, a doubled
//! separator — cannot fill the list with the same folder several times.  See
//! [`normalize_uri`] for the rules.
//!
//! Persistence follows the `annotation::store` house style: serde_json +
//! atomic write (tmp → rename).  Reads never fail the caller — a missing
//! file (first launch) or a corrupted one falls back to an empty list so a
//! broken history can never block startup.

use std::collections::HashSet;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use thiserror::Error;

/// Maximum number of remembered folders; the oldest entries are dropped.
pub const MAX_HISTORY: usize = 20;

/// Filename used inside the app config directory.
pub const HISTORY_FILENAME: &str = "history.json";

#[derive(Debug, Error)]
pub enum HistoryError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Persistent list of recently opened folder URIs (most recent first).
pub struct HistoryStore {
    file: PathBuf,
}

impl HistoryStore {
    /// Bind a store to `file`.  Neither the file nor its parent directory
    /// need to exist — creation is deferred to the first [`Self::add`].
    pub fn new(file: &Path) -> Self {
        Self {
            file: file.to_path_buf(),
        }
    }

    /// Read the history, most recent first.
    ///
    /// A missing file yields an empty list, and so does a file that cannot
    /// be parsed as a JSON array of strings (logged as a warning); the next
    /// [`Self::add`] rewrites it into a clean state.
    pub fn list(&self) -> Result<Vec<String>, HistoryError> {
        let raw = match fs::read_to_string(&self.file) {
            Ok(raw) => raw,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        match serde_json::from_str::<Vec<String>>(&raw) {
            Ok(entries) => Ok(entries),
            Err(e) => {
                tracing::warn!(
                    "history: ignoring unreadable history file {}: {}",
                    self.file.display(),
                    e
                );
                Ok(Vec::new())
            }
        }
    }

    /// Put `path` at the head of the history and persist immediately.
    ///
    /// Both sides of the comparison are run through [`normalize_uri`] first,
    /// so an existing entry naming the same folder is promoted rather than
    /// duplicated even when it is spelled differently (`file:///a/b/` vs
    /// `file:///a/b`).  The normalized strings are what gets written, which
    /// also means a history file left unnormalized by an older build — stale
    /// spellings, or duplicates already sitting in it — is cleaned up the
    /// next time a folder is opened.  Anything past [`MAX_HISTORY`] is
    /// dropped from the tail.
    pub fn add(&self, path: &str) -> Result<(), HistoryError> {
        let head = normalize_uri(path);
        let mut seen = HashSet::new();
        seen.insert(head.clone());
        let mut entries = vec![head];
        for existing in self.list()? {
            let normalized = normalize_uri(&existing);
            // First spelling wins, so the surviving line keeps the position
            // of the most recent visit to that folder.
            if seen.insert(normalized.clone()) {
                entries.push(normalized);
            }
        }
        entries.truncate(MAX_HISTORY);
        self.write(&entries)
    }

    /// Atomic write (tmp → rename), creating the parent directory on demand.
    fn write(&self, entries: &[String]) -> Result<(), HistoryError> {
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

/// Canonical spelling of a root URI for history purposes (requirements.md #6).
///
/// The rules are purely textual — the path part is rewritten, the scheme and
/// authority are handed back untouched:
///
/// * runs of `/` inside the path collapse to a single `/`, while the `://`
///   separator itself is preserved (`file:////a` → `file:///a`);
/// * a trailing `/` is dropped, unless the path *is* `/` — `file:///` and
///   `ssh://host/` are the root folder, not a spelling of something above it
///   (`ssh://host//` therefore lands on `ssh://host/`);
/// * an authority with no path at all gains the root slash, so `ssh://host`
///   and `ssh://host/` name the same folder.
///
/// Deliberately *not* `canonicalize`: resolving symlinks would need I/O the
/// remote roots cannot serve, and two different spellings of a real path are
/// two different ways the user thinks about the folder.  A string without a
/// `://` is not a URI this can take apart safely — the scheme/authority
/// boundary is what keeps the collapsing rules honest — so it is returned
/// unchanged.
fn normalize_uri(uri: &str) -> String {
    const SEP: &str = "://";
    let Some(sep_at) = uri.find(SEP) else {
        return uri.to_string();
    };
    let (prefix, rest) = uri.split_at(sep_at + SEP.len());

    // The authority runs up to the first `/`; everything from there is path.
    let Some(path_at) = rest.find('/') else {
        return format!("{prefix}{rest}/");
    };
    let (authority, path) = rest.split_at(path_at);

    let mut collapsed = String::with_capacity(path.len());
    for c in path.chars() {
        if c == '/' && collapsed.ends_with('/') {
            continue;
        }
        collapsed.push(c);
    }
    // At most one trailing slash survives the collapse above, and the bare
    // root `/` keeps it.
    if collapsed.len() > 1 && collapsed.ends_with('/') {
        collapsed.pop();
    }

    format!("{prefix}{authority}{collapsed}")
}

/// Default history file: `<app config dir>/history.json`.
///
/// Unlike `cli_fix::default_config_path` (user-edited `~/.config/vellis/`),
/// the history is app-managed state, so it belongs in the platform's
/// app-managed location — which is exactly what Tauri's path resolver
/// returns (`~/Library/Application Support/com.tetsuo.vellis/` on macOS).
pub fn default_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    use tauri::Manager;
    match app.path().app_config_dir() {
        Ok(dir) => Some(dir.join(HISTORY_FILENAME)),
        Err(e) => {
            tracing::warn!("history: no app config dir available: {}", e);
            None
        }
    }
}

/// Record a confirmed root URI in the default history.
///
/// Best-effort by design: any failure is logged and swallowed so opening a
/// folder never breaks because the history could not be written.
pub fn record_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>, root_uri: &str) {
    let Some(path) = default_path(app) else {
        return;
    };
    if let Err(e) = HistoryStore::new(&path).add(root_uri) {
        tracing::warn!("history: failed to record '{}': {}", root_uri, e);
    }
}
