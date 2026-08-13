//! Annotation subsystem for the AI-collaboration feature.
//!
//! Spec: `docs/ai-collab.md` 改訂 2.  Phase 4.1 wires up:
//! - `Mark` / `Anchor` / `MarkStatus` types (`types`)
//! - `.vellis/marks.jsonl` persistence (`store`)
//! - `.vellis/agent-inbox.md` generator (`inbox`)
//!
//! All write paths are confined to `<root>/.vellis/`.  `FileProvider`
//! (read-only by design) is *not* used here; sidecar writes go through
//! the dedicated `AnnotationStore` so the read-only invariant on
//! original `.md` files is preserved at the type level (architecture.md
//! §10.1).

pub mod anchor;
pub mod inbox;
pub mod snapshot;
pub mod store;
pub mod types;

pub use anchor::{rebind, sha256_hex, RebindOutcome};
pub use snapshot::{line_diff, Hunk, HunkKind, Manifest, SnapshotManager};
pub use store::{AnnotationError, AnnotationStore, MarkPatch};
pub use types::{Anchor, Mark, MarkId, MarkStatus};
