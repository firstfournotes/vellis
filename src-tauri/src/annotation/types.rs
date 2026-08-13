//! Mark / Anchor / MarkStatus.  See `docs/ai-collab.md` §4.1.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ulid::Ulid;

/// Stable, opaque identifier for a `Mark`.  Format: `mark_<ULID>`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MarkId(pub String);

impl MarkId {
    /// Generate a fresh `MarkId` using a ULID.
    pub fn generate() -> Self {
        Self(format!("mark_{}", Ulid::new()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for MarkId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Position information of a marked range, taken from the mdast
/// `position` of the rendering pass that built the originating
/// `SourceIndex`.  `start_line` / `end_line` are 1-origin (inclusive).
/// `start_offset` / `end_offset` are 0-origin UTF-16 code units, with
/// `end_offset` exclusive (rendering-engine.md §3.9, ai-collab.md §4.1.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Anchor {
    pub start_line: u32,
    pub end_line: u32,
    pub start_offset: u32,
    pub end_offset: u32,
    /// Display text from `Selection.toString()` — the primary key used
    /// by `AnchorRebinder` (Phase 4.2) when offsets shift.
    pub selected_text: String,
    /// Source Markdown slice (= `source.slice(start_offset, end_offset)`).
    /// Lets the AI inbox quote the original syntax verbatim.
    /// Kept as the snapshot at creation time and not refreshed on rebind.
    pub selected_markdown: String,
    /// Ancestor heading texts, e.g. `["API", "Authentication"]`.
    pub heading_path: Vec<String>,
    pub context_before: String,
    pub context_after: String,
    /// SHA-256 of the file content at creation time, hex-encoded.
    /// Used for drift detection on `file_changed`.
    pub file_hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MarkStatus {
    /// Just created, not yet handed to an agent.
    Open,
    /// `generate_inbox` ran and emitted this mark.
    SentToAgent,
    /// AnchorRebinder detected the anchor range was edited (Phase 4.2).
    ChangedByAgent,
    /// User marked this resolved.
    Resolved,
    /// Anchor rebind failed (Phase 4.2).
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mark {
    pub id: MarkId,
    /// Path of the marked file relative to the project root, POSIX-separated.
    pub file: String,
    pub anchor: Anchor,
    /// User-authored instruction (Markdown allowed).  Capped at 64KB.
    pub instruction: String,
    pub status: MarkStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Persistence schema version for forward-compat parse rejection.
    pub schema_version: u32,
}

impl Mark {
    pub const SCHEMA_VERSION: u32 = 1;

    /// Build a fresh `Open` mark with a generated id and `created_at` /
    /// `updated_at` set to `Utc::now()`.
    pub fn new(file: String, anchor: Anchor, instruction: String) -> Self {
        let now = Utc::now();
        Self {
            id: MarkId::generate(),
            file,
            anchor,
            instruction,
            status: MarkStatus::Open,
            created_at: now,
            updated_at: now,
            schema_version: Self::SCHEMA_VERSION,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_anchor() -> Anchor {
        Anchor {
            start_line: 10,
            end_line: 12,
            start_offset: 100,
            end_offset: 200,
            selected_text: "hello".into(),
            selected_markdown: "**hello**".into(),
            heading_path: vec!["API".into(), "Auth".into()],
            context_before: "before".into(),
            context_after: "after".into(),
            file_hash: "abc".into(),
        }
    }

    #[test]
    fn mark_id_has_mark_prefix_and_ulid_body() {
        let id = MarkId::generate();
        assert!(id.0.starts_with("mark_"));
        // ULID is 26 chars Crockford base32
        assert_eq!(id.0.len(), 5 + 26);
    }

    #[test]
    fn mark_id_generate_is_unique() {
        let a = MarkId::generate();
        let b = MarkId::generate();
        assert_ne!(a, b);
    }

    #[test]
    fn mark_new_sets_open_status_and_schema_version() {
        let mark = Mark::new("docs/spec.md".into(), sample_anchor(), "fix wording".into());
        assert_eq!(mark.status, MarkStatus::Open);
        assert_eq!(mark.schema_version, Mark::SCHEMA_VERSION);
        assert_eq!(mark.created_at, mark.updated_at);
    }

    #[test]
    fn mark_round_trips_through_json() {
        let mark = Mark::new("docs/spec.md".into(), sample_anchor(), "fix".into());
        let json = serde_json::to_string(&mark).unwrap();
        let restored: Mark = serde_json::from_str(&json).unwrap();
        assert_eq!(mark, restored);
    }

    #[test]
    fn mark_status_uses_snake_case_in_json() {
        let mark = Mark::new("a.md".into(), sample_anchor(), "fix".into());
        let json = serde_json::to_value(&mark).unwrap();
        assert_eq!(json["status"], "open");
    }

    #[test]
    fn mark_status_round_trip() {
        for s in [
            MarkStatus::Open,
            MarkStatus::SentToAgent,
            MarkStatus::ChangedByAgent,
            MarkStatus::Resolved,
            MarkStatus::Stale,
        ] {
            let json = serde_json::to_string(&s).unwrap();
            let back: MarkStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(s, back);
        }
    }

    #[test]
    fn anchor_round_trips_through_json() {
        let a = sample_anchor();
        let json = serde_json::to_string(&a).unwrap();
        let back: Anchor = serde_json::from_str(&json).unwrap();
        assert_eq!(a, back);
    }
}
