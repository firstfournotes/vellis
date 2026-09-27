//! Exclude judgement for the tree and the search (requirements.md #65 契約1〜3・9).
//!
//! Every exclusion goes through this one place: `list` returns every name
//! (dot names included) and the callers drop what the settings exclude. The
//! frontend has no copy of these rules.
//!
//! Patterns are globs matched against the path relative to the root
//! (`/`-separated, no leading `/`), the whole path at once:
//!
//! - `*`  — zero or more characters other than `/` (dot names included)
//! - `?`  — exactly one character other than `/`
//! - `**` — on its own between separators: zero or more folders
//!   (`**/x`, `x/**`, `a/**/b`); anywhere else it is the same as `*`
//! - everything else is literal (`{a,b}` and `[abc]` included), case-sensitive
//!
//! A pattern that matches a folder covers everything below it
//! ([`path_or_ancestor_matches`]).

use crate::fs::entry::Entry;
use crate::fs::uri::Uri;
use crate::settings::{load_settings, Settings};

/// Suffix of the temp file a save puts next to the document for an instant
/// (`.<name>.vellis-tmp`, requirements.md #48). Hidden whatever the settings say
/// (契約2): it used to hide only because `list` skipped dot names.
pub const BUILTIN_TMP_SUFFIX: &str = ".vellis-tmp";

/// Whether `pattern` matches the whole of `rel_path` (see the module docs).
pub fn glob_match(pattern: &str, rel_path: &str) -> bool {
    let pattern: Vec<&str> = pattern.split('/').collect();
    let path: Vec<&str> = rel_path.split('/').collect();
    match_segments(&pattern, &path)
}

fn match_segments(pattern: &[&str], path: &[&str]) -> bool {
    match pattern.split_first() {
        None => path.is_empty(),
        Some((&"**", rest)) => (0..=path.len()).any(|skip| match_segments(rest, &path[skip..])),
        Some((first, rest)) => match path.split_first() {
            Some((segment, path_rest)) => {
                match_segment(first, segment) && match_segments(rest, path_rest)
            }
            None => false,
        },
    }
}

/// One segment against one segment: `*` (any run, `**` included) and `?`.
/// Works on chars, so a multi-byte name never lands inside a character.
fn match_segment(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    let (mut p, mut t) = (0, 0);
    // Last `*` seen, and the text position it is currently stretched to.
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        if p < pattern.len() && pattern[p] == '*' {
            star = Some((p, t));
            p += 1;
        } else if p < pattern.len() && (pattern[p] == '?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if let Some((star_p, star_t)) = star {
            // Let the last `*` swallow one more character and retry.
            star = Some((star_p, star_t + 1));
            p = star_p + 1;
            t = star_t + 1;
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|c| *c == '*')
}

/// Whether `rel_path` itself or one of its ancestors (`a`, `a/b`, …) matches
/// one of `patterns` — a folder that matches covers its contents (契約3).
pub fn path_or_ancestor_matches(patterns: &[&str], rel_path: &str) -> bool {
    if patterns.is_empty() {
        return false;
    }
    let ends = rel_path.match_indices('/').map(|(i, _)| i).chain(std::iter::once(rel_path.len()));
    for end in ends {
        // `end` is the byte index of a `/` or the end of the string: always a char boundary.
        let prefix = &rel_path[..end];
        if patterns.iter().any(|pattern| glob_match(pattern, prefix)) {
            return true;
        }
    }
    false
}

/// The built-in exclusion (契約2): the name (last segment) ends in
/// [`BUILTIN_TMP_SUFFIX`]. Independent of the settings.
pub fn is_builtin_excluded(rel_path: &str) -> bool {
    rel_path.rsplit('/').next().unwrap_or(rel_path).ends_with(BUILTIN_TMP_SUFFIX)
}

/// Whether the tree hides `rel_path`: the built-in exclusion, or an active
/// `files.exclude` pattern on the path or one of its ancestors.
pub fn is_hidden_from_tree(rel_path: &str, settings: &Settings) -> bool {
    hidden_by(&settings.active_files_exclude(), rel_path)
}

fn hidden_by(files_exclude: &[&str], rel_path: &str) -> bool {
    is_builtin_excluded(rel_path) || path_or_ancestor_matches(files_exclude, rel_path)
}

/// Drop from `entries` (a listing of `dir`) what the tree does not show, keeping
/// the order. Each entry is judged by its path relative to `root`; when `dir` is
/// not under `root` the entry's name alone is used. The kind does not matter
/// (a symlink is judged by its name like anything else).
pub fn filter_tree_entries_with(
    root: &Uri,
    dir: &Uri,
    entries: Vec<Entry>,
    settings: &Settings,
) -> Vec<Entry> {
    let files_exclude = settings.active_files_exclude();
    let base = relative_dir(root, dir).unwrap_or_default();
    entries
        .into_iter()
        .filter(|entry| {
            let rel = if base.is_empty() {
                entry.name.clone()
            } else {
                format!("{base}/{}", entry.name)
            };
            !hidden_by(&files_exclude, &rel)
        })
        .collect()
}

/// [`filter_tree_entries_with`] with the user's current settings. Every route
/// that hands a listing to the tree (契約9) passes `provider.list` through this.
pub fn filter_tree_entries(root: &Uri, dir: &Uri, entries: Vec<Entry>) -> Vec<Entry> {
    filter_tree_entries_with(root, dir, entries, &load_settings().settings)
}

/// `dir` relative to `root` (`""` for the root itself), or `None` when `dir` is
/// not under `root` (another scheme, another host, or outside the folder).
fn relative_dir(root: &Uri, dir: &Uri) -> Option<String> {
    if root.scheme != dir.scheme || root.authority != dir.authority {
        return None;
    }
    let rest = dir.path.strip_prefix(&root.path).ok()?;
    let segments: Vec<String> =
        rest.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    Some(segments.join("/"))
}

