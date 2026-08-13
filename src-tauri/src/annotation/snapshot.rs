//! `SnapshotManager` — captures pre-edit copies of marked files so
//! `DiffView` can show "before vs after" once the AI edits the source
//! (`docs/ai-collab.md` 改訂 2 §4.5 / §10.4 / §11.5).
//!
//! Layout under `<root>/.vellis/snapshots/`:
//!
//! ```text
//! <root>/.vellis/snapshots/
//!   2026-04-28T12-30-15Z/
//!     manifest.json   { snapshot_id, created_at, files, mark_ids }
//!     docs/spec.md    (verbatim copy)
//!     docs/api.md
//!   ...
//! ```
//!
//! `take_snapshot` keeps the most recent 20 directories; older ones are
//! purged after a successful write so the directory does not grow
//! unbounded (§4.5 retention policy).
//!
//! All paths are constructed inside the canonicalised `<root>/.vellis/`
//! directory; absolute / `..` inputs are rejected.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use similar::{ChangeTag, TextDiff};

use super::store::AnnotationError;
use super::types::MarkId;

pub const SNAPSHOTS_DIRNAME: &str = "snapshots";
pub const MANIFEST_FILENAME: &str = "manifest.json";
pub const DEFAULT_RETENTION: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Manifest {
    pub snapshot_id: String,
    pub created_at: DateTime<Utc>,
    pub files: Vec<String>,
    #[serde(default)]
    pub mark_ids: Vec<MarkId>,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HunkKind {
    Equal,
    Insert,
    Delete,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Hunk {
    pub kind: HunkKind,
    /// Line number range in the *before* content (1-based, inclusive).
    /// `None` for `Insert`.
    pub before_lines: Option<(u32, u32)>,
    /// Line number range in the *after* content (1-based, inclusive).
    /// `None` for `Delete`.
    pub after_lines: Option<(u32, u32)>,
    pub text: String,
}

/// Format `now` into a filesystem-safe ISO-style id (`:` → `-`).
pub fn snapshot_id_for(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Secs, true)
        .replace(':', "-")
}

pub struct SnapshotManager<'a> {
    /// Canonical absolute path of `<root>/.vellis/`.
    vellis_dir: &'a Path,
    /// Canonical absolute path of `<root>` (parent of vellis_dir).
    root_dir: PathBuf,
    retention: usize,
}

impl<'a> SnapshotManager<'a> {
    pub fn new(vellis_dir: &'a Path) -> Self {
        let root_dir = vellis_dir
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| vellis_dir.to_path_buf());
        Self {
            vellis_dir,
            root_dir,
            retention: DEFAULT_RETENTION,
        }
    }

    pub fn with_retention(mut self, retention: usize) -> Self {
        self.retention = retention;
        self
    }

    fn snapshots_dir(&self) -> PathBuf {
        self.vellis_dir.join(SNAPSHOTS_DIRNAME)
    }

    /// Copy each entry of `relative_files` into a fresh `<vellis>/snapshots/<id>/`
    /// directory and write a `manifest.json`.  The id is derived from
    /// `now_utc`; pass `Utc::now()` outside tests.  After a successful
    /// write the manager applies the retention policy.
    pub fn take_snapshot(
        &self,
        relative_files: &[String],
        mark_ids: &[MarkId],
        now_utc: DateTime<Utc>,
    ) -> Result<Manifest, AnnotationError> {
        let snap_id = snapshot_id_for(now_utc);
        let snap_dir = self.snapshots_dir().join(&snap_id);
        fs::create_dir_all(&snap_dir)?;

        let mut copied: Vec<String> = Vec::with_capacity(relative_files.len());
        for rel in relative_files {
            let src = self.resolve_source(rel)?;
            if !src.exists() {
                tracing::warn!(
                    "snapshot: source {} does not exist, skipping",
                    src.display()
                );
                continue;
            }
            let dst = snap_dir.join(rel);
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent)?;
            }
            // Plain copy, not a hardlink — AI edits to the original must
            // not corrupt the snapshot (`docs/ai-collab.md` §4.5).
            fs::copy(&src, &dst)?;
            copied.push(rel.clone());
        }

        let manifest = Manifest {
            snapshot_id: snap_id.clone(),
            created_at: now_utc,
            files: copied,
            mark_ids: mark_ids.to_vec(),
        };
        let manifest_path = snap_dir.join(MANIFEST_FILENAME);
        let tmp_path = manifest_path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(&manifest)?;
        fs::write(&tmp_path, json.as_bytes())?;
        fs::rename(&tmp_path, &manifest_path)?;

        self.apply_retention()?;
        Ok(manifest)
    }

    /// List existing snapshots, newest first, by manifest.
    pub fn list(&self) -> Result<Vec<Manifest>, AnnotationError> {
        let snaps_dir = self.snapshots_dir();
        if !snaps_dir.exists() {
            return Ok(Vec::new());
        }
        let mut manifests = Vec::new();
        for entry in fs::read_dir(&snaps_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let manifest_path = entry.path().join(MANIFEST_FILENAME);
            if !manifest_path.exists() {
                continue;
            }
            let body = fs::read_to_string(&manifest_path)?;
            match serde_json::from_str::<Manifest>(&body) {
                Ok(m) => manifests.push(m),
                Err(e) => tracing::warn!(
                    "skipping malformed manifest at {}: {}",
                    manifest_path.display(),
                    e
                ),
            }
        }
        // Sort newest first by created_at (strings sort lexicographically
        // for our id format too).
        manifests.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(manifests)
    }

    /// Read the `before` content stored for `relative_file` in the
    /// snapshot identified by `snapshot_id`.
    pub fn read_before(
        &self,
        snapshot_id: &str,
        relative_file: &str,
    ) -> Result<String, AnnotationError> {
        let path = self.snapshots_dir().join(snapshot_id).join(relative_file);
        Ok(fs::read_to_string(&path)?)
    }

    /// Restore `relative_files` from `snapshot_id` back into the working
    /// tree.  Caller is responsible for confirming with the user
    /// (`docs/ai-collab.md` §8 / §11.5).
    pub fn revert(
        &self,
        snapshot_id: &str,
        relative_files: &[String],
    ) -> Result<(), AnnotationError> {
        let snap_dir = self.snapshots_dir().join(snapshot_id);
        for rel in relative_files {
            let src = snap_dir.join(rel);
            let dst = self.resolve_source(rel)?;
            if !src.exists() {
                return Err(AnnotationError::PathEscape(format!(
                    "snapshot {} has no copy of {}",
                    snapshot_id, rel
                )));
            }
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&src, &dst)?;
        }
        Ok(())
    }

    fn resolve_source(&self, relative_file: &str) -> Result<PathBuf, AnnotationError> {
        let rel = Path::new(relative_file);
        if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(AnnotationError::PathEscape(format!(
                "relative file {} contains absolute or parent component",
                relative_file
            )));
        }
        Ok(self.root_dir.join(rel))
    }

    fn apply_retention(&self) -> Result<(), AnnotationError> {
        let mut manifests = self.list()?;
        if manifests.len() <= self.retention {
            return Ok(());
        }
        // `list` returns newest first; drop the tail that exceeds retention.
        let drop = manifests.split_off(self.retention);
        for m in drop {
            let dir = self.snapshots_dir().join(&m.snapshot_id);
            if let Err(e) = fs::remove_dir_all(&dir) {
                if e.kind() != io::ErrorKind::NotFound {
                    tracing::warn!("retention: failed to remove {}: {}", dir.display(), e);
                }
            }
        }
        Ok(())
    }
}

/// Compute a line-level diff between `before` and `after`.  The result
/// is a sequence of `Hunk`s suitable for rendering in DiffView.  Equal
/// runs are emitted so the frontend can show context lines.
pub fn line_diff(before: &str, after: &str) -> Vec<Hunk> {
    let diff = TextDiff::from_lines(before, after);
    let mut hunks = Vec::new();
    let mut buffer: Option<Hunk> = None;
    let mut before_line: u32 = 1;
    let mut after_line: u32 = 1;

    for change in diff.iter_all_changes() {
        let kind = match change.tag() {
            ChangeTag::Equal => HunkKind::Equal,
            ChangeTag::Delete => HunkKind::Delete,
            ChangeTag::Insert => HunkKind::Insert,
        };
        let text: String = change.value().to_string();

        let merge_with_existing = buffer.as_ref().is_some_and(|h| h.kind == kind);

        if !merge_with_existing {
            if let Some(prev) = buffer.take() {
                hunks.push(prev);
            }
            buffer = Some(Hunk {
                kind,
                before_lines: None,
                after_lines: None,
                text: String::new(),
            });
        }

        let h = buffer.as_mut().expect("buffer initialised above");
        h.text.push_str(&text);

        match kind {
            HunkKind::Equal => {
                let start = before_line;
                let after_start = after_line;
                let line_count = text.matches('\n').count() as u32;
                let end = before_line + line_count.saturating_sub(if text.ends_with('\n') { 1 } else { 0 });
                let after_end = after_line + line_count.saturating_sub(if text.ends_with('\n') { 1 } else { 0 });
                h.before_lines = Some(merge_range(h.before_lines, (start, end)));
                h.after_lines = Some(merge_range(h.after_lines, (after_start, after_end)));
                before_line += line_count;
                after_line += line_count;
            }
            HunkKind::Delete => {
                let start = before_line;
                let line_count = text.matches('\n').count() as u32;
                let end = before_line + line_count.saturating_sub(if text.ends_with('\n') { 1 } else { 0 });
                h.before_lines = Some(merge_range(h.before_lines, (start, end)));
                before_line += line_count;
            }
            HunkKind::Insert => {
                let start = after_line;
                let line_count = text.matches('\n').count() as u32;
                let end = after_line + line_count.saturating_sub(if text.ends_with('\n') { 1 } else { 0 });
                h.after_lines = Some(merge_range(h.after_lines, (start, end)));
                after_line += line_count;
            }
        }
    }

    if let Some(last) = buffer.take() {
        hunks.push(last);
    }
    hunks
}

fn merge_range(existing: Option<(u32, u32)>, new: (u32, u32)) -> (u32, u32) {
    match existing {
        Some((s, _)) => (s.min(new.0), new.1),
        None => new,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> tempfile::TempDir {
        tempfile::TempDir::new().unwrap()
    }

    fn make_vellis(root: &Path) -> PathBuf {
        let v = root.join(".vellis");
        fs::create_dir_all(&v).unwrap();
        fs::canonicalize(&v).unwrap()
    }

    #[test]
    fn snapshot_id_replaces_colons_with_hyphens() {
        let now = DateTime::parse_from_rfc3339("2026-04-28T12:30:15+00:00")
            .unwrap()
            .with_timezone(&Utc);
        let id = snapshot_id_for(now);
        assert!(!id.contains(':'));
        assert!(id.contains("2026-04-28T12-30-15"));
    }

    #[test]
    fn take_snapshot_copies_files_and_writes_manifest() {
        let root = temp_root();
        fs::write(root.path().join("a.md"), "hello\n").unwrap();
        fs::create_dir_all(root.path().join("docs")).unwrap();
        fs::write(root.path().join("docs/spec.md"), "world\n").unwrap();
        let vellis = make_vellis(root.path());
        let mgr = SnapshotManager::new(&vellis);

        let now = DateTime::parse_from_rfc3339("2026-04-28T12:30:15+00:00")
            .unwrap()
            .with_timezone(&Utc);
        let mark_id = MarkId("mark_x".into());
        let manifest = mgr
            .take_snapshot(
                &["a.md".into(), "docs/spec.md".into()],
                &[mark_id.clone()],
                now,
            )
            .unwrap();

        assert_eq!(manifest.snapshot_id, snapshot_id_for(now));
        assert_eq!(manifest.files, vec!["a.md".to_string(), "docs/spec.md".to_string()]);
        assert_eq!(manifest.mark_ids, vec![mark_id]);

        let snap_dir = vellis.join("snapshots").join(&manifest.snapshot_id);
        assert_eq!(
            fs::read_to_string(snap_dir.join("a.md")).unwrap(),
            "hello\n"
        );
        assert_eq!(
            fs::read_to_string(snap_dir.join("docs/spec.md")).unwrap(),
            "world\n"
        );
        let mf: Manifest =
            serde_json::from_str(&fs::read_to_string(snap_dir.join(MANIFEST_FILENAME)).unwrap())
                .unwrap();
        assert_eq!(mf, manifest);
    }

    #[test]
    fn take_snapshot_skips_missing_source_with_warn() {
        let root = temp_root();
        fs::write(root.path().join("a.md"), "x").unwrap();
        let vellis = make_vellis(root.path());
        let mgr = SnapshotManager::new(&vellis);
        let now = Utc::now();
        let manifest = mgr
            .take_snapshot(
                &["a.md".into(), "missing.md".into()],
                &[],
                now,
            )
            .unwrap();
        // Only the existing file ends up in the manifest.
        assert_eq!(manifest.files, vec!["a.md".to_string()]);
    }

    #[test]
    fn take_snapshot_rejects_path_escape() {
        let root = temp_root();
        let vellis = make_vellis(root.path());
        let mgr = SnapshotManager::new(&vellis);
        let err = mgr
            .take_snapshot(&["../../etc/passwd".into()], &[], Utc::now())
            .unwrap_err();
        assert!(matches!(err, AnnotationError::PathEscape(_)));
    }

    #[test]
    fn list_returns_manifests_newest_first() {
        let root = temp_root();
        fs::write(root.path().join("a.md"), "x").unwrap();
        let vellis = make_vellis(root.path());
        let mgr = SnapshotManager::new(&vellis);

        let t1 = DateTime::parse_from_rfc3339("2026-04-28T10:00:00+00:00")
            .unwrap()
            .with_timezone(&Utc);
        let t2 = DateTime::parse_from_rfc3339("2026-04-28T11:00:00+00:00")
            .unwrap()
            .with_timezone(&Utc);
        mgr.take_snapshot(&["a.md".into()], &[], t1).unwrap();
        mgr.take_snapshot(&["a.md".into()], &[], t2).unwrap();
        let list = mgr.list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].created_at, t2);
        assert_eq!(list[1].created_at, t1);
    }

    #[test]
    fn retention_drops_older_snapshots() {
        let root = temp_root();
        fs::write(root.path().join("a.md"), "x").unwrap();
        let vellis = make_vellis(root.path());
        let mgr = SnapshotManager::new(&vellis).with_retention(2);

        for i in 0..5 {
            let now = DateTime::parse_from_rfc3339(&format!("2026-04-28T1{}:00:00+00:00", i))
                .unwrap()
                .with_timezone(&Utc);
            mgr.take_snapshot(&["a.md".into()], &[], now).unwrap();
        }
        let list = mgr.list().unwrap();
        assert_eq!(list.len(), 2);
        // Newest two retained
        assert_eq!(list[0].created_at.hour(), 14);
        assert_eq!(list[1].created_at.hour(), 13);
    }

    #[test]
    fn read_before_returns_snapshot_content() {
        let root = temp_root();
        fs::write(root.path().join("a.md"), "before edit\n").unwrap();
        let vellis = make_vellis(root.path());
        let mgr = SnapshotManager::new(&vellis);
        let manifest = mgr
            .take_snapshot(&["a.md".into()], &[], Utc::now())
            .unwrap();
        // Edit the original after snapshot
        fs::write(root.path().join("a.md"), "after edit\n").unwrap();

        let before = mgr.read_before(&manifest.snapshot_id, "a.md").unwrap();
        assert_eq!(before, "before edit\n");
        // The original on disk reflects the post-edit state
        let after = fs::read_to_string(root.path().join("a.md")).unwrap();
        assert_eq!(after, "after edit\n");
    }

    #[test]
    fn revert_restores_from_snapshot() {
        let root = temp_root();
        fs::write(root.path().join("a.md"), "v1\n").unwrap();
        let vellis = make_vellis(root.path());
        let mgr = SnapshotManager::new(&vellis);
        let manifest = mgr
            .take_snapshot(&["a.md".into()], &[], Utc::now())
            .unwrap();
        // Simulate AI edit
        fs::write(root.path().join("a.md"), "v2\n").unwrap();
        // Revert
        mgr.revert(&manifest.snapshot_id, &["a.md".into()]).unwrap();
        let restored = fs::read_to_string(root.path().join("a.md")).unwrap();
        assert_eq!(restored, "v1\n");
    }

    #[test]
    fn line_diff_simple_insert() {
        let before = "a\nb\n";
        let after = "a\nx\nb\n";
        let hunks = line_diff(before, after);
        // Expected: Equal a, Insert x, Equal b
        assert_eq!(hunks.len(), 3);
        assert_eq!(hunks[0].kind, HunkKind::Equal);
        assert_eq!(hunks[1].kind, HunkKind::Insert);
        assert_eq!(hunks[1].text, "x\n");
        assert_eq!(hunks[2].kind, HunkKind::Equal);
    }

    #[test]
    fn line_diff_replace() {
        let before = "first\nold\nlast\n";
        let after = "first\nnew\nlast\n";
        let hunks = line_diff(before, after);
        // similar emits delete then insert (or vice versa) depending on heuristics
        let kinds: Vec<HunkKind> = hunks.iter().map(|h| h.kind).collect();
        assert!(kinds.contains(&HunkKind::Delete));
        assert!(kinds.contains(&HunkKind::Insert));
    }

    #[test]
    fn line_diff_empty_when_unchanged() {
        let same = "alpha\nbeta\n";
        let hunks = line_diff(same, same);
        for h in &hunks {
            assert_eq!(h.kind, HunkKind::Equal);
        }
    }

    use chrono::Timelike;
}
