//! The Dashboard's Rust side (requirements.md #83 契約6・10・11・12): which
//! bookmarks and recent folders are gone, which folders Recently Modified
//! scans, and the scan itself.
//!
//! - [`missing_paths`] — the local URIs that are not on disk any more (NotFound),
//!   so the Dashboard can draw them faded. ssh is never checked (契約6 (h)).
//! - [`scan_targets`] — the local folders of the history (history order) and the
//!   folder bookmarks (bookmark order), normalized and deduplicated. ssh is never
//!   scanned (契約11 (k)).
//! - [`scan_recently_modified_in`] — the newest [`RECENTLY_MODIFIED_LIMIT`] files
//!   Vellis can open under those folders, by `Entry.modified` (no file is read).
//!   Breadth first over every target at once, at most [`MAX_PARALLEL_LISTS`]
//!   listings in flight (契約11 (ai)); the whole scan stops after the budget
//!   ([`RECENTLY_MODIFIED_BUDGET_MS`], 契約12 (l)) and says so (`truncated`).
//!
//! Exclusions are the ones Find in Folder applies (契約11 (j)): `files.exclude`
//! and `search.exclude` matched against the path relative to the target folder
//! (`crate::exclude`), plus the built-in `.vellis-tmp`. An excluded folder is not
//! listed at all. Symbolic links are never followed, and a link to a file is not
//! listed either (the same as Find in Folder). A folder that is a target of its
//! own is read once, as that target, when another target contains it.
//!
//! Nothing here writes.

use std::collections::{HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::task::Poll;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::bookmarks::{Bookmark, BookmarkKind};
use crate::exclude::{is_builtin_excluded, path_or_ancestor_matches};
use crate::fs::entry::{Entry, FileKind};
use crate::fs::provider::FileProvider;
use crate::fs::uri::Uri;
use crate::history::normalize_uri;
use crate::settings::Settings;

/// How many files Recently Modified shows (契約12 (m)).
pub const RECENTLY_MODIFIED_LIMIT: usize = 8;

/// The whole scan's budget in milliseconds (契約12 (l)).
pub const RECENTLY_MODIFIED_BUDGET_MS: u64 = 2000;

/// Event sent to the calling window while a scan runs (契約12 (aj)). Must match
/// `RECENTLY_MODIFIED_PROGRESS_EVENT` in `src/lib/dashboard.ts`.
pub const RECENTLY_MODIFIED_PROGRESS_EVENT: &str = "recently_modified_progress";

/// At most one progress report per this many milliseconds (the same 200ms as
/// Find in Folder's batches, 契約12 (aj)).
const PROGRESS_INTERVAL_MS: u64 = 200;

/// Listings in flight at once (the same 8 as Find in Folder, 契約11 (ai)).
const MAX_PARALLEL_LISTS: usize = 8;

/// The extensions `src/lib/file-type.ts` classifies as `binary` — the files
/// Vellis cannot open (契約11 (j)). Lowercase. Everything else, a name without
/// an extension included, opens (as markdown, html, text, image, 3D, video,
/// audio or PDF). The values are matched against `BINARY_EXTENSIONS` in
/// file-type.ts by `tests/acceptance_req83.rs`.
pub const UNOPENABLE_EXTENSIONS: &[&str] = &[
    "tiff", "tif", "heic", "zip", "gz", "bz2", "xz", "7z", "rar", "tar", "doc", "docx", "xls",
    "xlsx", "ppt", "pptx", "exe", "dll", "so", "dylib", "bin", "wasm", "class", "jar", "pyc",
    "woff", "woff2", "ttf", "otf", "eot", "flac", "ogg", "sqlite", "db", "dmg", "iso",
];

/// Whether Vellis can open a file called `name`: its extension (file-type.ts's
/// `extensionOf` rule — the last `.` of the last segment, lowercased, none when
/// the only dot leads) is not in [`UNOPENABLE_EXTENSIONS`].
pub fn is_openable_file_name(name: &str) -> bool {
    let segment = name.rsplit('/').next().unwrap_or(name);
    let ext = match segment.rfind('.') {
        Some(dot) if dot > 0 => segment[dot + 1..].to_lowercase(),
        _ => String::new(),
    };
    !UNOPENABLE_EXTENSIONS.contains(&ext.as_str())
}

fn is_local(uri: &str) -> bool {
    uri.starts_with("file://")
}

/// The local URIs of `uris` that are not on disk (NotFound), in input order.
/// ssh URIs are never checked and never returned. Only a `stat` per URI.
pub fn missing_paths(uris: &[String]) -> Vec<String> {
    uris.iter()
        .filter(|uri| {
            let Some(path) = uri.strip_prefix("file://") else {
                return false;
            };
            matches!(std::fs::metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
        })
        .cloned()
        .collect()
}

/// The folders Recently Modified scans (契約11 (i)(k)): the local folders of
/// `history` in its order, then the local folder bookmarks in theirs. ssh and
/// file bookmarks are left out; the same folder (normalized) counts once.
pub fn scan_targets(history: &[String], bookmarks: &[Bookmark]) -> Vec<String> {
    let folders = history.iter().map(String::as_str).chain(
        bookmarks
            .iter()
            .filter(|b| b.kind == BookmarkKind::Folder)
            .map(|b| b.uri.as_str()),
    );
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for uri in folders.filter(|uri| is_local(uri)) {
        let normalized = normalize_uri(uri);
        if seen.insert(normalized.clone()) {
            out.push(normalized);
        }
    }
    out
}

/// One Recently Modified row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModifiedFile {
    pub uri: String,
    /// The target folder the file was found under (the deepest one) — the
    /// root the Dashboard opens it in (契約5 (d)).
    pub folder: String,
    /// `Entry.modified`: Unix epoch milliseconds.
    pub modified: i64,
}

/// The scan's result, and the shape of each progress report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecentlyModifiedScan {
    /// Handed back as given, so the window drops reports of an older scan.
    pub generation: u64,
    /// Newest first (ties by URI), at most [`RECENTLY_MODIFIED_LIMIT`].
    pub files: Vec<ModifiedFile>,
    /// How many targets could be listed.
    pub folders: usize,
    /// The budget ran out before every folder was seen.
    pub truncated: bool,
}

/// One folder to list: `target` indexes the scan's targets, `rel` is the
/// folder's path relative to that target (`""` for the target itself).
struct Job {
    target: usize,
    dir: Uri,
    rel: String,
}

type ListFuture<'a> = Pin<Box<dyn Future<Output = (Job, Option<Vec<Entry>>)> + Send + 'a>>;

/// Wait for whichever listing finishes first (unordered; no `futures` crate).
async fn next_listing<'a>(inflight: &mut Vec<ListFuture<'a>>) -> (Job, Option<Vec<Entry>>) {
    std::future::poll_fn(|cx| {
        for i in 0..inflight.len() {
            if let Poll::Ready(out) = inflight[i].as_mut().poll(cx) {
                drop(inflight.swap_remove(i));
                return Poll::Ready(out);
            }
        }
        Poll::Pending
    })
    .await
}

/// Newest first, ties by URI.
fn newer_first(a: &ModifiedFile, b: &ModifiedFile) -> std::cmp::Ordering {
    b.modified.cmp(&a.modified).then_with(|| a.uri.cmp(&b.uri))
}

/// Put `file` into the sorted top list if it belongs there. True when the list
/// changed.
fn offer(top: &mut Vec<ModifiedFile>, file: ModifiedFile) -> bool {
    let at = top.partition_point(|existing| newer_first(existing, &file).is_lt());
    if at >= RECENTLY_MODIFIED_LIMIT {
        return false;
    }
    top.insert(at, file);
    top.truncate(RECENTLY_MODIFIED_LIMIT);
    true
}

fn join_rel(dir_rel: &str, name: &str) -> String {
    if dir_rel.is_empty() {
        name.to_string()
    } else {
        format!("{dir_rel}/{name}")
    }
}

/// The scan behind `scan_recently_modified` (see the module docs).
///
/// `on_progress` gets the current top list (same shape as the result) whenever
/// it changed, at most once per [`PROGRESS_INTERVAL_MS`]. A target that is not
/// a readable local folder is skipped silently (not listed, not counted). When
/// `budget` runs out the scan stops where it is — the listings in flight are
/// dropped — and returns what it has seen with `truncated: true`.
pub async fn scan_recently_modified_in(
    provider: &dyn FileProvider,
    generation: u64,
    targets: &[String],
    settings: &Settings,
    budget: Duration,
    on_progress: &mut (dyn FnMut(&RecentlyModifiedScan) + Send),
) -> RecentlyModifiedScan {
    let started = Instant::now();
    let deadline = tokio::time::Instant::from_std(started) + budget;
    let files_exclude = settings.active_files_exclude();
    let search_exclude = settings.active_search_exclude();

    // The targets: local, normalized, once each.
    let mut roots: Vec<String> = Vec::new();
    let mut queue: VecDeque<Job> = VecDeque::new();
    for target in targets.iter().filter(|t| is_local(t)) {
        let normalized = normalize_uri(target);
        if roots.contains(&normalized) {
            continue;
        }
        let Ok(dir) = Uri::parse(&normalized) else {
            continue;
        };
        queue.push_back(Job {
            target: roots.len(),
            dir,
            rel: String::new(),
        });
        roots.push(normalized);
    }
    let target_set: HashSet<String> = roots.iter().cloned().collect();

    let mut top: Vec<ModifiedFile> = Vec::new();
    let mut folders = 0usize;
    let mut truncated = false;
    let mut unreported = false;
    let mut last_report = started;
    let mut inflight: Vec<ListFuture<'_>> = Vec::new();

    'scan: loop {
        while inflight.len() < MAX_PARALLEL_LISTS {
            let Some(job) = queue.pop_front() else { break };
            if tokio::time::Instant::now() >= deadline {
                truncated = true;
                break 'scan;
            }
            inflight.push(Box::pin(async move {
                // A target is checked first, so a missing one is skipped without a listing.
                if job.rel.is_empty() {
                    match provider.stat(&job.dir).await {
                        Ok(entry) if entry.kind == FileKind::Dir => {}
                        _ => return (job, None),
                    }
                }
                let entries = provider.list(&job.dir).await.ok();
                (job, entries)
            }));
        }
        if inflight.is_empty() {
            break;
        }
        let Ok((job, entries)) =
            tokio::time::timeout_at(deadline, next_listing(&mut inflight)).await
        else {
            truncated = true;
            break;
        };
        let Some(entries) = entries else { continue };
        if job.rel.is_empty() {
            folders += 1;
        }
        for entry in entries {
            // `LocalProvider::list` describes a link's target; `link` says it was a link.
            if entry.kind == FileKind::Symlink || entry.link.is_some() {
                continue;
            }
            let rel = join_rel(&job.rel, &entry.name);
            if is_builtin_excluded(&rel)
                || path_or_ancestor_matches(&files_exclude, &rel)
                || path_or_ancestor_matches(&search_exclude, &rel)
            {
                continue;
            }
            let uri = job.dir.with_path(job.dir.path.join(&entry.name));
            match entry.kind {
                FileKind::Dir => {
                    // Another target: read once, as that (deeper) target.
                    if target_set.contains(&normalize_uri(&uri.raw)) {
                        continue;
                    }
                    queue.push_back(Job {
                        target: job.target,
                        dir: uri,
                        rel,
                    });
                }
                FileKind::File => {
                    if !is_openable_file_name(&entry.name) {
                        continue;
                    }
                    let Some(modified) = entry.modified else {
                        continue;
                    };
                    let file = ModifiedFile {
                        uri: uri.raw,
                        folder: roots[job.target].clone(),
                        modified,
                    };
                    if offer(&mut top, file) {
                        unreported = true;
                    }
                }
                FileKind::Symlink => {}
            }
        }
        if unreported && last_report.elapsed() >= Duration::from_millis(PROGRESS_INTERVAL_MS) {
            on_progress(&RecentlyModifiedScan {
                generation,
                files: top.clone(),
                folders,
                truncated: false,
            });
            unreported = false;
            last_report = Instant::now();
        }
    }

    RecentlyModifiedScan {
        generation,
        files: top,
        folders,
        truncated,
    }
}
