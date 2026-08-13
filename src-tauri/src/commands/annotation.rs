//! Tauri command surface for the annotation feature
//! (`docs/ai-collab.md` §8).
//!
//! All commands take an explicit `root_uri` so the backend can resolve
//! the per-project `.vellis/` sidecar.  SSH roots are rejected in Phase
//! 4.1 (ai-collab.md §6.2) — the UI keeps the mark-add affordance
//! disabled in that case.
//!
//! Sync `std::fs` calls inside `AnnotationStore` are intentionally not
//! wrapped in `spawn_blocking`: each call writes a small JSONL file at
//! human interaction frequency and finishes within a few hundred
//! microseconds.  Phase 4.2 may revisit this when AnchorRebinder fans
//! out per-file.

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::annotation::{
    line_diff, AnnotationError, AnnotationStore, Anchor, Hunk, Manifest, Mark, MarkId,
    MarkPatch, MarkStatus, SnapshotManager,
};
use crate::commands::AppState;
use crate::fs::uri::Uri;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorInput {
    pub start_line: u32,
    pub end_line: u32,
    pub start_offset: u32,
    pub end_offset: u32,
    pub selected_text: String,
    pub selected_markdown: String,
    pub heading_path: Vec<String>,
    pub context_before: String,
    pub context_after: String,
    pub file_hash: String,
}

impl From<AnchorInput> for Anchor {
    fn from(a: AnchorInput) -> Self {
        Self {
            start_line: a.start_line,
            end_line: a.end_line,
            start_offset: a.start_offset,
            end_offset: a.end_offset,
            selected_text: a.selected_text,
            selected_markdown: a.selected_markdown,
            heading_path: a.heading_path,
            context_before: a.context_before,
            context_after: a.context_after,
            file_hash: a.file_hash,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkFilter {
    pub file: Option<String>,
    pub status: Option<MarkStatus>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkPatchInput {
    pub instruction: Option<String>,
    pub status: Option<MarkStatus>,
}

#[derive(Debug, Serialize)]
pub struct GenerateInboxResponse {
    pub path: String,
    pub mark_ids: Vec<MarkId>,
}

/// Per-file rebind summary returned by `rebind_marks_for_file`.
/// `marks` contains the full updated mark list for the file (after
/// persistence); `drifted_ids` enumerates the marks whose status moved
/// to `Stale` or `ChangedByAgent` during this rebind so the frontend
/// can show a notification.
#[derive(Debug, Serialize)]
pub struct RebindResponse {
    pub marks: Vec<Mark>,
    pub drifted_ids: Vec<MarkId>,
}

#[derive(Debug, Serialize)]
pub struct DiffResponse {
    pub before: String,
    pub after: String,
    pub hunks: Vec<Hunk>,
    pub snapshot_id: String,
    pub file: String,
}

const MAX_INSTRUCTION_BYTES: usize = 64 * 1024;
const MAX_SELECTED_MARKDOWN_BYTES: usize = 64 * 1024;

fn store_for(state: &AppState, root_uri: &str) -> Result<Arc<AnnotationStore>, String> {
    let uri = Uri::parse(root_uri).map_err(|e| format!("invalid root_uri: {}", e))?;
    if uri.scheme != "file" {
        return Err(format!(
            "annotation store is unavailable for {} roots in Phase 4.1",
            uri.scheme
        ));
    }
    let canon = std::fs::canonicalize(&uri.path)
        .map_err(|e| format!("cannot canonicalise root: {}", e))?;
    let mut cache = state
        .annotation_stores
        .lock()
        .map_err(|_| "annotation_stores lock poisoned".to_string())?;
    if let Some(existing) = cache.get(&canon) {
        return Ok(existing.clone());
    }
    let store =
        AnnotationStore::new(&canon).map_err(|e| format!("cannot open .vellis/: {}", e))?;
    let arc = Arc::new(store);
    cache.insert(canon, arc.clone());
    Ok(arc)
}

fn relative_file_path(root: &Path, doc_uri: &str) -> Result<String, String> {
    let uri = Uri::parse(doc_uri).map_err(|e| format!("invalid uri: {}", e))?;
    if uri.scheme != "file" {
        return Err(format!("non-file uri in Phase 4.1: {}", uri.canonical()));
    }
    let rel = uri.path.strip_prefix(root).map_err(|_| {
        format!(
            "{} is outside the project root {}",
            uri.path.display(),
            root.display()
        )
    })?;
    Ok(rel.to_string_lossy().into_owned())
}

fn map_err(e: AnnotationError) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn add_mark(
    state: State<'_, AppState>,
    root_uri: String,
    uri: String,
    anchor: AnchorInput,
    instruction: String,
) -> Result<Mark, String> {
    if instruction.len() > MAX_INSTRUCTION_BYTES {
        return Err(format!(
            "instruction exceeds {} bytes",
            MAX_INSTRUCTION_BYTES
        ));
    }
    if anchor.selected_markdown.len() > MAX_SELECTED_MARKDOWN_BYTES {
        return Err(format!(
            "selected_markdown exceeds {} bytes",
            MAX_SELECTED_MARKDOWN_BYTES
        ));
    }
    let store = store_for(state.inner(), &root_uri)?;
    let root = store.vellis_dir().parent().unwrap_or(Path::new("/")).to_path_buf();
    let file = relative_file_path(&root, &uri)?;
    let mark = Mark::new(file, anchor.into(), instruction);
    store.add_mark(mark.clone()).map_err(map_err)?;
    Ok(mark)
}

#[tauri::command]
pub async fn list_marks(
    state: State<'_, AppState>,
    root_uri: String,
    filter: Option<MarkFilter>,
) -> Result<Vec<Mark>, String> {
    let store = store_for(state.inner(), &root_uri)?;
    let mut marks = store.load_marks().map_err(map_err)?;
    if let Some(f) = filter {
        marks.retain(|m| {
            f.file.as_ref().map_or(true, |file| m.file == *file)
                && f.status.as_ref().map_or(true, |status| m.status == *status)
        });
    }
    Ok(marks)
}

#[tauri::command]
pub async fn update_mark(
    state: State<'_, AppState>,
    root_uri: String,
    id: MarkId,
    patch: MarkPatchInput,
) -> Result<Mark, String> {
    if let Some(ref instr) = patch.instruction {
        if instr.len() > MAX_INSTRUCTION_BYTES {
            return Err(format!(
                "instruction exceeds {} bytes",
                MAX_INSTRUCTION_BYTES
            ));
        }
    }
    let store = store_for(state.inner(), &root_uri)?;
    store
        .update_mark(
            &id,
            MarkPatch {
                instruction: patch.instruction,
                status: patch.status,
            },
        )
        .map_err(map_err)
}

#[tauri::command]
pub async fn remove_mark(
    state: State<'_, AppState>,
    root_uri: String,
    id: MarkId,
) -> Result<(), String> {
    let store = store_for(state.inner(), &root_uri)?;
    store.remove_mark(&id).map_err(map_err)
}

/// Rebind every mark on `uri` against `content` and persist the
/// changes (`docs/ai-collab.md` §7).  Triggered by the frontend when a
/// `file_changed` event fires; the frontend already has the new content
/// in the event payload, so we avoid an extra read here.
#[tauri::command]
pub async fn rebind_marks_for_file(
    state: State<'_, AppState>,
    root_uri: String,
    uri: String,
    content: String,
) -> Result<RebindResponse, String> {
    let store = store_for(state.inner(), &root_uri)?;
    let root = store.vellis_dir().parent().unwrap_or(Path::new("/")).to_path_buf();
    let file = relative_file_path(&root, &uri)?;
    let (marks, drifted_ids) = store
        .rebind_marks_for_file(&file, &content)
        .map_err(map_err)?;
    Ok(RebindResponse {
        marks,
        drifted_ids,
    })
}

/// Write `agent-inbox.md` for the marks matching `filter` (defaults to
/// `status == Open`).  Side effects (`docs/ai-collab.md` §10.2 / §10.4):
/// 1. Each emitted mark transitions `Open → SentToAgent`.
/// 2. The unique set of files referenced by the emitted marks is
///    snapshotted into `<root>/.vellis/snapshots/<id>/` so DiffView
///    has a "before" baseline once the AI edits the source.
#[tauri::command]
pub async fn generate_inbox(
    state: State<'_, AppState>,
    root_uri: String,
    filter: Option<MarkFilter>,
) -> Result<GenerateInboxResponse, String> {
    let store = store_for(state.inner(), &root_uri)?;
    let mut marks = store.load_marks().map_err(map_err)?;
    let f = filter.unwrap_or_else(|| MarkFilter {
        file: None,
        status: Some(MarkStatus::Open),
    });
    marks.retain(|m| {
        f.file.as_ref().map_or(true, |file| m.file == *file)
            && f.status.as_ref().map_or(true, |status| m.status == *status)
    });

    let path = store.write_inbox(&marks).map_err(map_err)?;

    // Auto-snapshot before status transition so the manifest captures
    // the marks that were emitted in this round.
    if !marks.is_empty() {
        let snap_mgr = SnapshotManager::new(store.vellis_dir());
        let mut files: Vec<String> = marks.iter().map(|m| m.file.clone()).collect();
        files.sort();
        files.dedup();
        let mark_ids: Vec<MarkId> = marks.iter().map(|m| m.id.clone()).collect();
        if let Err(e) = snap_mgr.take_snapshot(&files, &mark_ids, chrono::Utc::now()) {
            tracing::warn!("auto-snapshot during generate_inbox failed: {}", e);
        }
    }

    // Status transition for emitted marks (Open → SentToAgent).  Only
    // affects marks that were actually Open; manually-set statuses are
    // left alone so re-running generate_inbox is idempotent.
    let mut emitted = Vec::with_capacity(marks.len());
    for m in &marks {
        if m.status == MarkStatus::Open {
            store
                .update_mark(
                    &m.id,
                    MarkPatch {
                        instruction: None,
                        status: Some(MarkStatus::SentToAgent),
                    },
                )
                .map_err(map_err)?;
        }
        emitted.push(m.id.clone());
    }

    Ok(GenerateInboxResponse {
        path: path.to_string_lossy().into_owned(),
        mark_ids: emitted,
    })
}

/// List existing snapshots, newest first (`docs/ai-collab.md` §11.5).
#[tauri::command]
pub async fn list_snapshots(
    state: State<'_, AppState>,
    root_uri: String,
) -> Result<Vec<Manifest>, String> {
    let store = store_for(state.inner(), &root_uri)?;
    let mgr = SnapshotManager::new(store.vellis_dir());
    mgr.list().map_err(map_err)
}

/// Compute a line-level diff between `before` (the snapshot copy) and
/// the current file content for the given URI.  When `snapshot_id` is
/// `None` the most recent snapshot containing the file is used.  Errors
/// when no snapshot has been taken yet for that file
/// (`docs/ai-collab.md` §11.5 — fallback to last in-memory `file_changed`
/// content lives on the frontend).
#[tauri::command]
pub async fn diff_against_snapshot(
    state: State<'_, AppState>,
    root_uri: String,
    uri: String,
    snapshot_id: Option<String>,
) -> Result<DiffResponse, String> {
    let store = store_for(state.inner(), &root_uri)?;
    let root = store
        .vellis_dir()
        .parent()
        .unwrap_or(Path::new("/"))
        .to_path_buf();
    let file = relative_file_path(&root, &uri)?;

    let mgr = SnapshotManager::new(store.vellis_dir());
    let manifest = match snapshot_id {
        Some(id) => mgr
            .list()
            .map_err(map_err)?
            .into_iter()
            .find(|m| m.snapshot_id == id)
            .ok_or_else(|| format!("snapshot {} not found", id))?,
        None => mgr
            .list()
            .map_err(map_err)?
            .into_iter()
            .find(|m| m.files.iter().any(|f| f == &file))
            .ok_or_else(|| format!("no snapshot has been taken for {}", file))?,
    };
    let before = mgr
        .read_before(&manifest.snapshot_id, &file)
        .map_err(map_err)?;
    let after = std::fs::read_to_string(root.join(&file))
        .map_err(|e| format!("read current file: {}", e))?;
    let hunks = line_diff(&before, &after);
    Ok(DiffResponse {
        before,
        after,
        hunks,
        snapshot_id: manifest.snapshot_id,
        file,
    })
}

/// Restore `files` from `snapshot_id` back into the working tree
/// (`docs/ai-collab.md` §8 / §11.5).  Caller is responsible for
/// confirming with the user before invoking this command.
#[tauri::command]
pub async fn revert_to_snapshot(
    state: State<'_, AppState>,
    root_uri: String,
    snapshot_id: String,
    files: Vec<String>,
) -> Result<(), String> {
    let store = store_for(state.inner(), &root_uri)?;
    let mgr = SnapshotManager::new(store.vellis_dir());
    mgr.revert(&snapshot_id, &files).map_err(map_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchor_input_converts_to_anchor() {
        let input = AnchorInput {
            start_line: 1,
            end_line: 2,
            start_offset: 0,
            end_offset: 10,
            selected_text: "t".into(),
            selected_markdown: "**t**".into(),
            heading_path: vec!["A".into()],
            context_before: "".into(),
            context_after: "".into(),
            file_hash: "h".into(),
        };
        let a: Anchor = input.into();
        assert_eq!(a.start_line, 1);
        assert_eq!(a.selected_markdown, "**t**");
    }

    #[test]
    fn relative_file_path_strips_root_prefix() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let doc = root.join("docs/spec.md");
        std::fs::create_dir_all(doc.parent().unwrap()).unwrap();
        std::fs::write(&doc, "x").unwrap();
        let doc_uri = format!("file://{}", doc.canonicalize().unwrap().display());
        let rel = relative_file_path(&root, &doc_uri).unwrap();
        assert_eq!(rel, "docs/spec.md");
    }

    #[test]
    fn relative_file_path_rejects_outside_paths() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let other = tempfile::TempDir::new().unwrap();
        let outside = other.path().join("foo.md");
        std::fs::write(&outside, "x").unwrap();
        let outside_uri = format!("file://{}", outside.canonicalize().unwrap().display());
        let err = relative_file_path(&root, &outside_uri).unwrap_err();
        assert!(err.contains("outside the project root"));
    }
}
