//! `.vellis/marks.jsonl` persistence (`docs/ai-collab.md` §6).
//!
//! All writes go through `AnnotationStore` and target paths under
//! `<root>/.vellis/`.  The store enforces this with a canonicalised
//! `vellis_dir` root and never accepts user-controlled relative paths
//! into its own write helpers (Phase 4.3 SnapshotManager will reuse the
//! same canonical guard for snapshot file paths).

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use thiserror::Error;

use super::anchor::{rebind, RebindOutcome};
use super::inbox::format_inbox;
use super::types::{Mark, MarkId, MarkStatus};

/// Filename used inside `.vellis/` for the JSONL ledger.
pub const MARKS_FILENAME: &str = "marks.jsonl";
pub const INBOX_FILENAME: &str = "agent-inbox.md";

#[derive(Debug, Error)]
pub enum AnnotationError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("mark not found: {0}")]
    NotFound(MarkId),

    #[error("path escape detected: {0}")]
    PathEscape(String),

    #[error("project root cannot be canonicalised: {0}")]
    InvalidRoot(String),
}

/// Partial update applied via `update_mark`.
#[derive(Debug, Clone, Default)]
pub struct MarkPatch {
    pub instruction: Option<String>,
    pub status: Option<MarkStatus>,
}

/// Sidecar persistence for the AI-collab feature.
///
/// Construct one per project root; the store is cheap to clone.
pub struct AnnotationStore {
    /// Canonical absolute path of `<root>/.vellis/`.  Created on demand.
    vellis_dir: PathBuf,
    /// Serialises mutating operations (load → mutate → atomic rename)
    /// against this store.  Concurrent `file_changed` bursts (e.g.
    /// three `sed -i` invocations in quick succession) trigger
    /// multiple `rebind_marks_for_file` calls which would otherwise
    /// race on `marks.jsonl.tmp`, causing `NotFound` on the loser of
    /// the rename.  All writers acquire this lock; reads (`load_marks`)
    /// also acquire it briefly to see a consistent file (no torn
    /// reads).
    write_lock: Mutex<()>,
}

impl AnnotationStore {
    /// Create a store bound to `<root>/.vellis/`.  The directory is
    /// created if missing.  Returns `InvalidRoot` if `root` cannot be
    /// canonicalised (typically because it does not exist).
    pub fn new(root: &Path) -> Result<Self, AnnotationError> {
        let canonical_root = fs::canonicalize(root)
            .map_err(|e| AnnotationError::InvalidRoot(format!("{}: {}", root.display(), e)))?;
        let vellis_dir = canonical_root.join(".vellis");
        fs::create_dir_all(&vellis_dir)?;
        // Re-canonicalise after mkdir so symlink targets are flattened.
        let vellis_dir = fs::canonicalize(&vellis_dir).map_err(|e| {
            AnnotationError::InvalidRoot(format!("{}: {}", vellis_dir.display(), e))
        })?;
        Ok(Self {
            vellis_dir,
            write_lock: Mutex::new(()),
        })
    }

    /// `.vellis/` directory (canonical absolute path).
    pub fn vellis_dir(&self) -> &Path {
        &self.vellis_dir
    }

    fn marks_path(&self) -> PathBuf {
        self.vellis_dir.join(MARKS_FILENAME)
    }

    fn lock_writes(&self) -> std::sync::MutexGuard<'_, ()> {
        // Poisoned mutexes can only happen if a previous holder panicked;
        // the underlying state is already consistent (atomic rename is
        // all-or-nothing), so we recover by reading through the poison.
        match self.write_lock.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Read all marks.  Corrupted lines are skipped with a `warn` log
    /// rather than failing the whole load (`docs/ai-collab.md` §12.1).
    /// Lock-free: writers use atomic rename, so any single
    /// `read_to_string` sees a consistent file (either the pre- or
    /// post-rename version).
    pub fn load_marks(&self) -> Result<Vec<Mark>, AnnotationError> {
        let path = self.marks_path();
        if !path.exists() {
            return Ok(Vec::new());
        }
        let content = fs::read_to_string(&path)?;
        let mut marks = Vec::new();
        for (idx, line) in content.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<Mark>(trimmed) {
                Ok(mark) => marks.push(mark),
                Err(e) => {
                    tracing::warn!(
                        "skipping corrupted mark at {}:{}: {}",
                        path.display(),
                        idx + 1,
                        e
                    );
                }
            }
        }
        Ok(marks)
    }

    /// Append a new mark and persist the full ledger atomically
    /// (write to `.tmp` → `rename`).
    pub fn add_mark(&self, mark: Mark) -> Result<(), AnnotationError> {
        let _guard = self.lock_writes();
        let mut marks = self.load_marks()?;
        marks.push(mark);
        self.write_marks(&marks)
    }

    /// Apply `patch` to the mark with the matching id, refresh
    /// `updated_at`, and persist.  Returns the updated record.
    pub fn update_mark(
        &self,
        id: &MarkId,
        patch: MarkPatch,
    ) -> Result<Mark, AnnotationError> {
        let _guard = self.lock_writes();
        let mut marks = self.load_marks()?;
        let pos = marks
            .iter()
            .position(|m| &m.id == id)
            .ok_or_else(|| AnnotationError::NotFound(id.clone()))?;

        let m = &mut marks[pos];
        if let Some(instruction) = patch.instruction {
            m.instruction = instruction;
        }
        if let Some(status) = patch.status {
            m.status = status;
        }
        m.updated_at = chrono::Utc::now();
        let updated = m.clone();
        self.write_marks(&marks)?;
        Ok(updated)
    }

    /// Remove the mark with the matching id.
    pub fn remove_mark(&self, id: &MarkId) -> Result<(), AnnotationError> {
        let _guard = self.lock_writes();
        let mut marks = self.load_marks()?;
        let before = marks.len();
        marks.retain(|m| &m.id != id);
        if marks.len() == before {
            return Err(AnnotationError::NotFound(id.clone()));
        }
        self.write_marks(&marks)
    }

    /// Re-anchor every mark whose `file` matches `relative_path` against
    /// `new_content` and persist the changes atomically.
    ///
    /// Returns `(marks_for_file, drifted_ids)` where `drifted_ids`
    /// enumerates marks whose status moved to `Stale` or
    /// `ChangedByAgent` (`docs/ai-collab.md` §7).
    pub fn rebind_marks_for_file(
        &self,
        relative_path: &str,
        new_content: &str,
    ) -> Result<(Vec<Mark>, Vec<MarkId>), AnnotationError> {
        let _guard = self.lock_writes();
        let mut marks = self.load_marks()?;
        let mut drifted = Vec::new();
        let mut any_changed = false;

        for mark in marks.iter_mut() {
            if mark.file != relative_path {
                continue;
            }
            let (new_mark, outcome) = rebind(mark, new_content);
            match outcome {
                RebindOutcome::Unchanged => {}
                RebindOutcome::UnchangedPosition | RebindOutcome::Moved => {
                    *mark = new_mark;
                    any_changed = true;
                }
                RebindOutcome::Fuzzy | RebindOutcome::Stale => {
                    *mark = new_mark;
                    any_changed = true;
                    drifted.push(mark.id.clone());
                }
            }
        }

        if any_changed {
            self.write_marks(&marks)?;
        }

        let for_file: Vec<Mark> = marks
            .into_iter()
            .filter(|m| m.file == relative_path)
            .collect();
        Ok((for_file, drifted))
    }

    /// Generate `<root>/.vellis/agent-inbox.md` from the given marks
    /// (`docs/ai-collab.md` §4.3).  Status transitions
    /// (Open → SentToAgent) are caller's responsibility.
    pub fn write_inbox(&self, marks: &[Mark]) -> Result<PathBuf, AnnotationError> {
        let _guard = self.lock_writes();
        let final_path = self.vellis_dir.join(INBOX_FILENAME);
        let tmp_path = final_path.with_extension("md.tmp");
        self.assert_within_vellis(&tmp_path)?;
        self.assert_within_vellis(&final_path)?;

        let body = format_inbox(marks);
        let mut file = fs::File::create(&tmp_path)?;
        file.write_all(body.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp_path, &final_path)?;
        Ok(final_path)
    }

    /// Write the full ledger atomically.
    fn write_marks(&self, marks: &[Mark]) -> Result<(), AnnotationError> {
        let final_path = self.marks_path();
        let tmp_path = final_path.with_extension("jsonl.tmp");

        // Defensive — neither path should escape vellis_dir.  These come
        // from `marks_path()` which is composed locally, so this is a
        // belt-and-braces check that catches symlink races.
        self.assert_within_vellis(&tmp_path)?;
        self.assert_within_vellis(&final_path)?;

        let mut file = fs::File::create(&tmp_path)?;
        for m in marks {
            let line = serde_json::to_string(m)?;
            file.write_all(line.as_bytes())?;
            file.write_all(b"\n")?;
        }
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp_path, &final_path)?;
        Ok(())
    }

    /// Reject paths whose canonical form (or, if missing, parent's
    /// canonical form) is not contained in `self.vellis_dir`.
    fn assert_within_vellis(&self, path: &Path) -> Result<(), AnnotationError> {
        // For not-yet-existing files (e.g. `.tmp` before write), resolve
        // the parent and append the file name back.  `vellis_dir` is
        // already canonical.
        let resolved = if path.exists() {
            fs::canonicalize(path).map_err(|e| {
                AnnotationError::PathEscape(format!("{}: {}", path.display(), e))
            })?
        } else {
            let parent = path.parent().ok_or_else(|| {
                AnnotationError::PathEscape(format!("{} has no parent", path.display()))
            })?;
            let parent_canon = fs::canonicalize(parent).map_err(|e| {
                AnnotationError::PathEscape(format!("{}: {}", parent.display(), e))
            })?;
            let file_name = path.file_name().ok_or_else(|| {
                AnnotationError::PathEscape(format!("{} has no file name", path.display()))
            })?;
            parent_canon.join(file_name)
        };

        if !resolved.starts_with(&self.vellis_dir) {
            return Err(AnnotationError::PathEscape(format!(
                "{} resolves outside {}",
                path.display(),
                self.vellis_dir.display()
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::annotation::types::Anchor;
    use std::fs::OpenOptions;

    fn temp_root() -> tempfile::TempDir {
        tempfile::TempDir::new().unwrap()
    }

    fn anchor(text: &str) -> Anchor {
        Anchor {
            start_line: 1,
            end_line: 1,
            start_offset: 0,
            end_offset: text.len() as u32,
            selected_text: text.into(),
            selected_markdown: text.into(),
            heading_path: vec![],
            context_before: "".into(),
            context_after: "".into(),
            file_hash: "h".into(),
        }
    }

    #[test]
    fn new_creates_dot_vellis_directory() {
        let root = temp_root();
        let store = AnnotationStore::new(root.path()).unwrap();
        let dot = root.path().join(".vellis");
        assert!(dot.is_dir());
        assert!(store.vellis_dir().ends_with(".vellis"));
    }

    #[test]
    fn load_marks_on_fresh_store_returns_empty() {
        let root = temp_root();
        let store = AnnotationStore::new(root.path()).unwrap();
        assert!(store.load_marks().unwrap().is_empty());
    }

    #[test]
    fn add_then_load_round_trips() {
        let root = temp_root();
        let store = AnnotationStore::new(root.path()).unwrap();
        let m = Mark::new("a.md".into(), anchor("hello"), "fix".into());
        store.add_mark(m.clone()).unwrap();
        let loaded = store.load_marks().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, m.id);
        assert_eq!(loaded[0].anchor.selected_text, "hello");
    }

    #[test]
    fn add_appends_subsequent_marks() {
        let root = temp_root();
        let store = AnnotationStore::new(root.path()).unwrap();
        for i in 0..3 {
            store
                .add_mark(Mark::new(
                    format!("doc{}.md", i),
                    anchor(&format!("text{}", i)),
                    format!("fix {}", i),
                ))
                .unwrap();
        }
        let loaded = store.load_marks().unwrap();
        assert_eq!(loaded.len(), 3);
        // Order preserved
        let files: Vec<_> = loaded.iter().map(|m| m.file.clone()).collect();
        assert_eq!(files, vec!["doc0.md", "doc1.md", "doc2.md"]);
    }

    #[test]
    fn update_mark_changes_instruction_and_refreshes_updated_at() {
        let root = temp_root();
        let store = AnnotationStore::new(root.path()).unwrap();
        let m = Mark::new("a.md".into(), anchor("hi"), "old".into());
        store.add_mark(m.clone()).unwrap();
        // Sleep just enough for `Utc::now` to advance.
        std::thread::sleep(std::time::Duration::from_millis(2));
        let updated = store
            .update_mark(
                &m.id,
                MarkPatch {
                    instruction: Some("new".into()),
                    status: Some(MarkStatus::Resolved),
                },
            )
            .unwrap();
        assert_eq!(updated.instruction, "new");
        assert_eq!(updated.status, MarkStatus::Resolved);
        assert!(updated.updated_at >= m.created_at);
    }

    #[test]
    fn update_unknown_id_returns_not_found() {
        let root = temp_root();
        let store = AnnotationStore::new(root.path()).unwrap();
        let err = store
            .update_mark(&MarkId::generate(), MarkPatch::default())
            .unwrap_err();
        matches!(err, AnnotationError::NotFound(_));
    }

    #[test]
    fn remove_mark_deletes_one_record() {
        let root = temp_root();
        let store = AnnotationStore::new(root.path()).unwrap();
        let m1 = Mark::new("a.md".into(), anchor("a"), "fix".into());
        let m2 = Mark::new("b.md".into(), anchor("b"), "fix".into());
        store.add_mark(m1.clone()).unwrap();
        store.add_mark(m2.clone()).unwrap();
        store.remove_mark(&m1.id).unwrap();
        let remaining = store.load_marks().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, m2.id);
    }

    #[test]
    fn corrupted_lines_are_skipped_not_fatal() {
        let root = temp_root();
        let store = AnnotationStore::new(root.path()).unwrap();
        let good = Mark::new("a.md".into(), anchor("a"), "fix".into());
        store.add_mark(good.clone()).unwrap();

        // Append a busted line and an empty line directly.
        let path = root.path().join(".vellis").join(MARKS_FILENAME);
        let mut f = OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"\n").unwrap();
        f.write_all(b"this is not json\n").unwrap();
        let other = Mark::new("b.md".into(), anchor("b"), "fix".into());
        f.write_all(serde_json::to_string(&other).unwrap().as_bytes())
            .unwrap();
        f.write_all(b"\n").unwrap();
        drop(f);

        let loaded = store.load_marks().unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, good.id);
        assert_eq!(loaded[1].id, other.id);
    }

    #[test]
    fn add_mark_writes_atomically_no_tmp_left_behind() {
        let root = temp_root();
        let store = AnnotationStore::new(root.path()).unwrap();
        store
            .add_mark(Mark::new("a.md".into(), anchor("a"), "fix".into()))
            .unwrap();
        let tmp = root.path().join(".vellis").join("marks.jsonl.tmp");
        assert!(!tmp.exists(), "tmp file should be gone after rename");
    }

    #[test]
    fn rebind_marks_for_file_persists_moves_and_drifts() {
        let root = temp_root();
        let store = AnnotationStore::new(root.path()).unwrap();

        // Author the original file content so the mark.fileHash matches.
        let original = "intro\n\n\ntarget here\n\nend\n";
        let mark = Mark::new(
            "doc.md".into(),
            Anchor {
                start_line: 4,
                end_line: 4,
                start_offset: 8,
                end_offset: 19,
                selected_text: "target here".into(),
                selected_markdown: "target here".into(),
                heading_path: vec![],
                context_before: "".into(),
                context_after: "".into(),
                file_hash: super::super::anchor::sha256_hex(original),
            },
            "fix".into(),
        );
        let other_file = Mark::new("other.md".into(), anchor("x"), "skip me".into());
        store.add_mark(mark.clone()).unwrap();
        store.add_mark(other_file.clone()).unwrap();

        // Insert two new lines before the target — exact match should still
        // find it on the new line (line 6).
        let new_content = "intro\n\n\nNEW LINE 1\nNEW LINE 2\ntarget here\n\nend\n";
        let (for_file, drifted) = store
            .rebind_marks_for_file("doc.md", new_content)
            .unwrap();

        assert_eq!(for_file.len(), 1);
        assert_eq!(for_file[0].id, mark.id);
        assert_eq!(for_file[0].anchor.start_line, 6);
        assert_eq!(for_file[0].status, mark.status); // Moved → status preserved
        assert!(drifted.is_empty(), "Moved is not drift");

        // Verify the file on disk reflects the change too.
        let loaded = store.load_marks().unwrap();
        let updated = loaded.iter().find(|m| m.id == mark.id).unwrap();
        assert_eq!(updated.anchor.start_line, 6);

        // The mark for the other file is untouched.
        let untouched = loaded.iter().find(|m| m.id == other_file.id).unwrap();
        assert_eq!(untouched.anchor.start_line, other_file.anchor.start_line);
    }

    #[test]
    fn rebind_marks_for_file_records_drift_when_text_disappears() {
        let root = temp_root();
        let store = AnnotationStore::new(root.path()).unwrap();
        let original = "intro\nthe-target\nend\n";
        let mark = Mark::new(
            "doc.md".into(),
            Anchor {
                start_line: 2,
                end_line: 2,
                start_offset: 6,
                end_offset: 16,
                selected_text: "the-target".into(),
                selected_markdown: "the-target".into(),
                heading_path: vec![],
                context_before: "".into(),
                context_after: "".into(),
                file_hash: super::super::anchor::sha256_hex(original),
            },
            "fix".into(),
        );
        store.add_mark(mark.clone()).unwrap();

        let new_content = "intro\ncompletely different content\nend\n";
        let (for_file, drifted) = store
            .rebind_marks_for_file("doc.md", new_content)
            .unwrap();

        assert_eq!(for_file.len(), 1);
        assert_eq!(for_file[0].status, MarkStatus::Stale);
        assert_eq!(drifted, vec![mark.id.clone()]);
    }

    #[test]
    fn concurrent_rebind_calls_do_not_corrupt_marks_jsonl() {
        // Regression for the I/O error: NotFound that surfaced when
        // three quick `sed -i` invocations triggered three concurrent
        // file_changed → rebind_marks_for_file calls.  Without the
        // per-store lock, the loser of the rename(.tmp, .jsonl) race
        // would observe the .tmp file already gone.
        use std::sync::Arc;
        use std::thread;

        let root = temp_root();
        let store = Arc::new(AnnotationStore::new(root.path()).unwrap());

        // Author 5 marks that share a file.
        let original = "header\nbody\nfooter\n";
        for i in 0..5 {
            let mut a = anchor("body");
            a.start_line = 2;
            a.end_line = 2;
            a.start_offset = 7;
            a.end_offset = 11;
            a.file_hash = super::super::anchor::sha256_hex(original);
            let mark = Mark::new(
                "doc.md".into(),
                a,
                format!("fix #{}", i),
            );
            store.add_mark(mark).unwrap();
        }
        assert_eq!(store.load_marks().unwrap().len(), 5);

        // Three rebind calls in parallel against three slightly
        // different new contents (mimicking three sed invocations).
        let new_contents = vec![
            "header\nbody A\nfooter\n".to_string(),
            "header\nbody B\nfooter\n".to_string(),
            "header\nbody C\nfooter\n".to_string(),
        ];
        let handles: Vec<_> = new_contents
            .into_iter()
            .map(|c| {
                let s = Arc::clone(&store);
                thread::spawn(move || s.rebind_marks_for_file("doc.md", &c))
            })
            .collect();
        for h in handles {
            // Each individual rebind must succeed (no NotFound on rename).
            h.join().unwrap().unwrap();
        }

        // Final state still has all 5 marks, no torn file.
        let marks = store.load_marks().unwrap();
        assert_eq!(marks.len(), 5);
    }

    #[test]
    fn write_inbox_creates_agent_inbox_md_with_marks() {
        let root = temp_root();
        let store = AnnotationStore::new(root.path()).unwrap();
        let m = Mark::new("a.md".into(), anchor("hello"), "fix wording".into());
        let path = store.write_inbox(&[m.clone()]).unwrap();
        assert!(path.ends_with("agent-inbox.md"));
        let body = fs::read_to_string(&path).unwrap();
        assert!(body.contains("# Markdown Review Instructions"));
        assert!(body.contains(m.id.as_str()));
        assert!(body.contains("- File: `a.md`"));
        assert!(body.contains("- Instruction:"));
        assert!(body.contains("  fix wording"));
        assert!(body.ends_with("<!-- end -->\n"));
    }

    #[test]
    fn write_inbox_is_atomic_no_tmp_left_behind() {
        let root = temp_root();
        let store = AnnotationStore::new(root.path()).unwrap();
        store
            .write_inbox(&[Mark::new(
                "a.md".into(),
                anchor("hi"),
                "fix".into(),
            )])
            .unwrap();
        let tmp = root.path().join(".vellis").join("agent-inbox.md.tmp");
        assert!(!tmp.exists());
    }

    #[test]
    fn load_skips_blank_lines() {
        let root = temp_root();
        let store = AnnotationStore::new(root.path()).unwrap();
        let path = root.path().join(".vellis").join(MARKS_FILENAME);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "\n\n").unwrap();
        assert!(store.load_marks().unwrap().is_empty());
    }
}
