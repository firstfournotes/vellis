//! `AnchorRebinder` — pure re-anchoring logic for marks after a file
//! changes (Phase 4.2).
//!
//! Spec: `docs/ai-collab.md` 改訂 2 §7 / §7.2.  The function is
//! deliberately side-effect-free; persistence and event emission live in
//! the wiring layer (`commands::annotation::rebind_marks_for_file` in
//! a follow-up).
//!
//! Rebind ladder (in order):
//! 1. **Hash unchanged** — file content has not actually changed.
//! 2. **Lines still match** — old `start_line..end_line` slice equals
//!    `selected_text`.
//! 3. **Exact text search** — find `selected_text` verbatim in the new
//!    content; disambiguate with `heading_path` then `context_*`.
//! 4. **Fuzzy match** — line-level Levenshtein similarity ≥ 0.85;
//!    `status` becomes `ChangedByAgent`.
//! 5. **Stale** — keep last known anchor, set `status = Stale`.

use sha2::{Digest, Sha256};

use super::types::{Anchor, Mark, MarkStatus};

const FUZZY_THRESHOLD: f64 = 0.85;

/// Outcome of `rebind` — captures what happened so callers can emit the
/// right events without re-deriving the change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RebindOutcome {
    /// Hash matches; nothing was touched.  The mark is returned as-is.
    Unchanged,
    /// File changed but the anchor still points at the same text and
    /// status is preserved.
    UnchangedPosition,
    /// Anchor moved to a new location; status preserved.
    Moved,
    /// Fuzzy match — anchor moved and status escalated to `ChangedByAgent`.
    Fuzzy,
    /// No usable match; anchor preserved but status is `Stale`.
    Stale,
}

/// Compute SHA-256 of `content` as lowercase hex.
pub fn sha256_hex(content: &str) -> String {
    let mut h = Sha256::new();
    h.update(content.as_bytes());
    let bytes = h.finalize();
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// Apply the rebind ladder.  Returns the (possibly mutated) Mark and
/// the outcome enum.  When the outcome is `Unchanged`, the mark is
/// untouched (caller can skip persistence).
///
/// Needle preference: `selected_markdown` is the source slice covered
/// by the anchor's offsets and is therefore a strict superset of
/// `selected_text` (which is `Selection.toString()` and may be a
/// substring of a rolled-up block — e.g. plain text inside a list item
/// where there is no inline mdast node carrying its own
/// `data-vellis-node-id`).  Using `selected_markdown` everywhere keeps
/// the fuzzy needle representative of the actual mark range; we fall
/// back to `selected_text` when `selected_markdown` is empty (older
/// marks that predate ai-collab.md 改訂 2).
pub fn rebind(mark: &Mark, new_content: &str) -> (Mark, RebindOutcome) {
    let new_hash = sha256_hex(new_content);

    // 1. Hash unchanged
    if mark.anchor.file_hash == new_hash {
        return (mark.clone(), RebindOutcome::Unchanged);
    }

    let lines: Vec<&str> = new_content.split('\n').collect();
    let primary: &str = if !mark.anchor.selected_markdown.is_empty() {
        mark.anchor.selected_markdown.as_str()
    } else {
        mark.anchor.selected_text.as_str()
    };

    // 2. Lines still match — old line range identical to `primary`.
    if let Some(old_slice) = slice_lines(&lines, mark.anchor.start_line, mark.anchor.end_line) {
        if old_slice == primary {
            let mut updated = mark.clone();
            updated.anchor.file_hash = new_hash;
            if let Some((start_offset, end_offset)) =
                locate_text_offsets(new_content, mark.anchor.start_line, primary)
            {
                updated.anchor.start_offset = start_offset;
                updated.anchor.end_offset = end_offset;
            }
            updated.updated_at = chrono::Utc::now();
            return (updated, RebindOutcome::UnchangedPosition);
        }
    }

    // 3. Exact text search — try `primary` (selected_markdown) first;
    // fall back to selected_text only if `primary` yields nothing and
    // the two strings differ (older marks).
    let mut hits = find_exact_matches(new_content, primary);
    if hits.is_empty() && primary != mark.anchor.selected_text.as_str() {
        hits = find_exact_matches(new_content, &mark.anchor.selected_text);
    }

    // Disambiguate with heading_path
    if hits.len() > 1 && !mark.anchor.heading_path.is_empty() {
        hits.retain(|hit| heading_path_matches(new_content, hit.byte_offset, &mark.anchor.heading_path));
    }

    // Disambiguate with context_before / context_after
    if hits.len() > 1 {
        hits.retain(|hit| context_matches(&lines, hit.line_1based, &mark.anchor));
    }

    if hits.len() == 1 {
        let hit = &hits[0];
        let updated = build_anchored(mark, hit, &new_hash, mark.status);
        return (updated, RebindOutcome::Moved);
    }

    // 4. Fuzzy match — slide a window the same shape as `primary` over
    // the new content; pick the best by normalised Levenshtein.
    if let Some(fuzzy_hit) = best_fuzzy_match(new_content, primary) {
        if fuzzy_hit.similarity >= FUZZY_THRESHOLD {
            let updated = build_anchored(
                mark,
                &fuzzy_hit.hit,
                &new_hash,
                MarkStatus::ChangedByAgent,
            );
            return (updated, RebindOutcome::Fuzzy);
        }
    }

    // 5. Stale
    let mut staled = mark.clone();
    staled.status = MarkStatus::Stale;
    // Keep anchor as the last known value, but refresh file_hash so we
    // don't re-run rebind on every subsequent file_changed.
    staled.anchor.file_hash = new_hash;
    staled.updated_at = chrono::Utc::now();
    (staled, RebindOutcome::Stale)
}

#[derive(Debug, Clone)]
struct Hit {
    /// 1-based start line.
    line_1based: u32,
    /// 1-based end line (inclusive).
    end_line_1based: u32,
    byte_offset: u32,
    end_byte_offset: u32,
}

#[derive(Debug, Clone)]
struct FuzzyHit {
    hit: Hit,
    similarity: f64,
}

/// Slice the lines covered by `[start_line, end_line]` (1-based,
/// inclusive on both ends).  Joined with `\n` to mirror the caller's
/// original `selected_text` shape.
fn slice_lines(lines: &[&str], start_line: u32, end_line: u32) -> Option<String> {
    if start_line == 0 || end_line < start_line {
        return None;
    }
    let s = (start_line - 1) as usize;
    let e = end_line as usize;
    if s >= lines.len() {
        return None;
    }
    let end = e.min(lines.len());
    Some(lines[s..end].join("\n"))
}

/// Compute the byte offsets of `text` in `content` when the match
/// starts on `start_line` (1-based).
fn locate_text_offsets(content: &str, start_line: u32, text: &str) -> Option<(u32, u32)> {
    if start_line == 0 {
        return None;
    }
    let line_start = byte_offset_of_line(content, start_line)?;
    let rest = &content[line_start..];
    let rel = rest.find(text)?;
    let start = (line_start + rel) as u32;
    let end = start + text.len() as u32;
    Some((start, end))
}

/// Byte offset where `line_1based` begins.  Returns `Some(content.len())`
/// when the line is exactly one past the last newline (caller is
/// expected to handle that case).
fn byte_offset_of_line(content: &str, line_1based: u32) -> Option<usize> {
    if line_1based == 0 {
        return None;
    }
    if line_1based == 1 {
        return Some(0);
    }
    let mut count = 1u32;
    for (i, b) in content.bytes().enumerate() {
        if b == b'\n' {
            count += 1;
            if count == line_1based {
                return Some(i + 1);
            }
        }
    }
    None
}

fn find_exact_matches(content: &str, needle: &str) -> Vec<Hit> {
    if needle.is_empty() {
        return Vec::new();
    }
    let mut hits = Vec::new();
    let mut start = 0usize;
    while let Some(pos) = content[start..].find(needle) {
        let abs = start + pos;
        let end = abs + needle.len();
        let line_1based = line_of_offset(content, abs);
        let end_line_1based = line_of_offset(content, end.saturating_sub(1).max(abs));
        hits.push(Hit {
            line_1based,
            end_line_1based,
            byte_offset: abs as u32,
            end_byte_offset: end as u32,
        });
        // Advance past the whole match.  `abs + 1` (overlap-allowing)
        // would split a multi-byte character (e.g. `未` = 3 bytes UTF-8)
        // and the next `content[start..].find(...)` would panic.  Mark
        // needles never overlap in practice, so skipping the full match
        // is both safer and simpler.
        start = end;
    }
    hits
}

/// 1-based line number containing `offset`.
fn line_of_offset(content: &str, offset: usize) -> u32 {
    let bounded = offset.min(content.len());
    let mut line = 1u32;
    for (i, b) in content.bytes().enumerate() {
        if i >= bounded {
            break;
        }
        if b == b'\n' {
            line += 1;
        }
    }
    line
}

/// Returns true if the heading hierarchy preceding `offset` ends in a
/// chain that *contains* every entry of `heading_path` in order
/// (consecutive enough to be the same section).
fn heading_path_matches(content: &str, offset: u32, heading_path: &[String]) -> bool {
    if heading_path.is_empty() {
        return true;
    }
    let prefix = &content[..(offset as usize).min(content.len())];
    let mut stack: Vec<String> = Vec::new();
    for line in prefix.split('\n') {
        if let Some((_depth, text)) = parse_heading(line) {
            stack.push(text.into());
        }
    }
    // Match the tail: the path must be the last N headings (in order).
    if stack.len() < heading_path.len() {
        return false;
    }
    let tail = &stack[stack.len() - heading_path.len()..];
    tail.iter().zip(heading_path.iter()).all(|(a, b)| a == b)
}

fn parse_heading(line: &str) -> Option<(u32, &str)> {
    let trimmed = line.trim_start();
    if !trimmed.starts_with('#') {
        return None;
    }
    let depth = trimmed.chars().take_while(|c| *c == '#').count() as u32;
    if depth == 0 || depth > 6 {
        return None;
    }
    let rest = &trimmed[depth as usize..];
    if !rest.starts_with(' ') && !rest.is_empty() {
        return None; // setext or "##foo" non-heading
    }
    Some((depth, rest.trim()))
}

/// Returns true if the line before `start_line_1based` matches the
/// stored `context_before` *or* the line after `end_line_1based`
/// matches `context_after`.  Either neighbour is sufficient — the
/// neighbouring text usually changes less than the heading path.
fn context_matches(lines: &[&str], start_line_1based: u32, anchor: &Anchor) -> bool {
    let cb_ok = if anchor.context_before.is_empty() {
        true
    } else {
        let idx = start_line_1based as usize;
        if idx == 0 || idx > lines.len() {
            true
        } else {
            lines[idx - 1] == anchor.context_before
        }
    };
    let ca_ok = if anchor.context_after.is_empty() {
        true
    } else {
        let idx = start_line_1based as usize;
        if idx >= lines.len() {
            true
        } else {
            lines[idx] == anchor.context_after
        }
    };
    cb_ok || ca_ok
}

fn build_anchored(mark: &Mark, hit: &Hit, new_hash: &str, status: MarkStatus) -> Mark {
    let mut updated = mark.clone();
    updated.anchor.start_line = hit.line_1based;
    updated.anchor.end_line = hit.end_line_1based;
    updated.anchor.start_offset = hit.byte_offset;
    updated.anchor.end_offset = hit.end_byte_offset;
    updated.anchor.file_hash = new_hash.to_string();
    updated.status = status;
    updated.updated_at = chrono::Utc::now();
    updated
}

/// Slide `selected_text`-sized window across the content, line-anchored,
/// pick the best by normalized Levenshtein similarity.  Returns `None`
/// when no candidate had any similarity at all.
fn best_fuzzy_match(content: &str, needle: &str) -> Option<FuzzyHit> {
    if needle.trim().is_empty() {
        return None;
    }
    let lines: Vec<&str> = content.split('\n').collect();
    let needle_lines: Vec<&str> = needle.split('\n').collect();
    let window = needle_lines.len();
    if window == 0 || lines.len() < window {
        return None;
    }
    let mut best: Option<FuzzyHit> = None;
    for start in 0..=lines.len() - window {
        let candidate = lines[start..start + window].join("\n");
        let similarity = strsim::normalized_levenshtein(&candidate, needle);
        if best
            .as_ref()
            .map_or(true, |b| similarity > b.similarity)
        {
            // Compute byte offsets of this window in the original content
            let line_offset = byte_offset_of_line(content, (start as u32) + 1)?;
            let end_offset = line_offset + candidate.len();
            best = Some(FuzzyHit {
                hit: Hit {
                    line_1based: (start as u32) + 1,
                    end_line_1based: (start as u32) + window as u32,
                    byte_offset: line_offset as u32,
                    end_byte_offset: end_offset as u32,
                },
                similarity,
            });
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::annotation::types::{Anchor, Mark};

    fn anchor(text: &str, start_line: u32, end_line: u32, content: &str) -> Anchor {
        let (start_offset, end_offset) =
            locate_text_offsets(content, start_line, text).unwrap_or((0, text.len() as u32));
        Anchor {
            start_line,
            end_line,
            start_offset,
            end_offset,
            selected_text: text.into(),
            selected_markdown: text.into(),
            heading_path: vec![],
            context_before: "".into(),
            context_after: "".into(),
            file_hash: sha256_hex(content),
        }
    }

    fn make_mark(file: &str, content: &str, text: &str, line: u32) -> Mark {
        Mark::new(
            file.into(),
            anchor(text, line, line, content),
            "fix".into(),
        )
    }

    #[test]
    fn rebind_unchanged_when_hash_matches() {
        let content = "line1\nline2\nline3\n";
        let mark = make_mark("a.md", content, "line2", 2);
        let (out_mark, outcome) = rebind(&mark, content);
        assert_eq!(outcome, RebindOutcome::Unchanged);
        assert_eq!(out_mark, mark);
    }

    #[test]
    fn rebind_unchanged_position_when_text_at_same_line_after_other_edits() {
        let content_a = "line1\nline2\nline3\n";
        let content_b = "line1 edited\nline2\nline3 edited\n";
        let mark = make_mark("a.md", content_a, "line2", 2);
        let (out, outcome) = rebind(&mark, content_b);
        assert_eq!(outcome, RebindOutcome::UnchangedPosition);
        assert_eq!(out.status, mark.status); // status preserved
        assert_eq!(out.anchor.start_line, 2);
        assert_eq!(out.anchor.file_hash, sha256_hex(content_b));
    }

    #[test]
    fn rebind_moved_when_text_shifted_by_added_lines() {
        let content_a = "intro\n\n\ntarget here\n\nend\n";
        let content_b = "intro\n\n\nNEW LINE 1\nNEW LINE 2\ntarget here\n\nend\n";
        let mark = make_mark("a.md", content_a, "target here", 4);
        let (out, outcome) = rebind(&mark, content_b);
        assert_eq!(outcome, RebindOutcome::Moved);
        assert_eq!(out.anchor.start_line, 6);
        let slice = &content_b[out.anchor.start_offset as usize..out.anchor.end_offset as usize];
        assert_eq!(slice, "target here");
        assert_eq!(out.status, mark.status);
    }

    #[test]
    fn rebind_disambiguates_by_heading_path() {
        let content_a = "# A\n\nshared\n\n# B\n\nshared\n";
        let content_b = "# A\n\nshared\n\n# B\n\nNEW\nshared\n";
        // The original mark was under heading B
        let mut mark = make_mark("a.md", content_a, "shared", 7);
        mark.anchor.heading_path = vec!["B".into()];
        let (out, outcome) = rebind(&mark, content_b);
        assert_eq!(outcome, RebindOutcome::Moved);
        // The B/shared moved from line 7 to line 8 due to NEW insertion
        assert_eq!(out.anchor.start_line, 8);
    }

    #[test]
    fn rebind_falls_through_to_fuzzy_when_text_slightly_changed() {
        // Typo-style edits: AI rephrased a couple of words but kept the
        // overall sentence shape.  Exact search misses, fuzzy catches.
        let content_a = "alpha\nbeta\nthe quick brown fox jumps\ndelta\n";
        let content_b = "alpha\nbeta\nthe quik brown foks jumps\ndelta\n";
        let mark = make_mark("a.md", content_a, "the quick brown fox jumps", 3);
        let (out, outcome) = rebind(&mark, content_b);
        assert_eq!(outcome, RebindOutcome::Fuzzy);
        assert_eq!(out.status, MarkStatus::ChangedByAgent);
        assert_eq!(out.anchor.start_line, 3);
    }

    #[test]
    fn rebind_uses_selected_markdown_for_block_rolled_marks() {
        // Regression: a plain-text selection inside a list item rolls
        // up to the listItem mdast node, so `selected_markdown` covers
        // the whole line ("- foo: P95 < 200ms") while
        // `selected_text` is just the user's drag substring
        // ("P95 < 200ms").  After AI replaces the inner numbers, the
        // exact substring is gone and a fuzzy match against the short
        // `selected_text` would score below 0.85.  Using
        // `selected_markdown` as the fuzzy needle keeps the line-level
        // similarity ≥ 0.85 and produces ChangedByAgent.
        let original = "intro\n- レスポンスタイム目標: P95 < 200ms\nend\n";
        let mut mark = Mark::new(
            "doc.md".into(),
            Anchor {
                start_line: 2,
                end_line: 2,
                start_offset: 6,
                end_offset: 6 + "- レスポンスタイム目標: P95 < 200ms".len() as u32,
                selected_text: "P95 < 200ms".into(),
                selected_markdown: "- レスポンスタイム目標: P95 < 200ms".into(),
                heading_path: vec![],
                context_before: "".into(),
                context_after: "".into(),
                file_hash: sha256_hex(original),
            },
            "fix".into(),
        );
        // Force Sent so we can assert ChangedByAgent (not the initial Open)
        mark.status = MarkStatus::SentToAgent;

        let new_content = "intro\n- レスポンスタイム目標: P99 < 300ms\nend\n";
        let (out, outcome) = rebind(&mark, new_content);
        assert_eq!(outcome, RebindOutcome::Fuzzy);
        assert_eq!(out.status, MarkStatus::ChangedByAgent);
        assert_eq!(out.anchor.start_line, 2);
    }

    #[test]
    fn rebind_marks_stale_when_text_completely_replaced() {
        let content_a = "line1\nthe-target-text\nline3\n";
        let content_b = "line1\nentirely different content here\nline3\n";
        let mark = make_mark("a.md", content_a, "the-target-text", 2);
        let (out, outcome) = rebind(&mark, content_b);
        assert_eq!(outcome, RebindOutcome::Stale);
        assert_eq!(out.status, MarkStatus::Stale);
        // Anchor preserved at last known position (offsets/lines unchanged)
        assert_eq!(out.anchor.start_line, mark.anchor.start_line);
        // file_hash refreshed so subsequent file_changed doesn't loop
        assert_eq!(out.anchor.file_hash, sha256_hex(content_b));
    }

    #[test]
    fn sha256_hex_is_deterministic_and_64_char_lowercase() {
        let a = sha256_hex("hello world");
        let b = sha256_hex("hello world");
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn slice_lines_inclusive_handles_first_and_last_line() {
        let content = "a\nb\nc";
        let lines: Vec<&str> = content.split('\n').collect();
        assert_eq!(slice_lines(&lines, 1, 1).unwrap(), "a");
        assert_eq!(slice_lines(&lines, 1, 3).unwrap(), "a\nb\nc");
        assert_eq!(slice_lines(&lines, 2, 3).unwrap(), "b\nc");
        assert!(slice_lines(&lines, 0, 1).is_none());
        assert!(slice_lines(&lines, 5, 6).is_none());
    }

    #[test]
    fn line_of_offset_handles_boundaries() {
        let content = "a\nbb\nccc";
        assert_eq!(line_of_offset(content, 0), 1); // a
        assert_eq!(line_of_offset(content, 2), 2); // bb (after first \n)
        assert_eq!(line_of_offset(content, 5), 3); // ccc (after second \n)
        assert_eq!(line_of_offset(content, 100), 3); // past end clamps
    }

    #[test]
    fn parse_heading_recognises_atx() {
        assert_eq!(parse_heading("# top"), Some((1, "top")));
        assert_eq!(parse_heading("### third"), Some((3, "third")));
        assert_eq!(parse_heading("###no space"), None);
        assert_eq!(parse_heading("  ## indent"), Some((2, "indent")));
        assert_eq!(parse_heading("plain"), None);
    }

    #[test]
    fn find_exact_matches_returns_all_occurrences() {
        let content = "x foo bar foo baz foo";
        let hits = find_exact_matches(content, "foo");
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].byte_offset, 2);
        assert_eq!(hits[1].byte_offset, 10);
        assert_eq!(hits[2].byte_offset, 18);
    }

    #[test]
    fn find_exact_matches_handles_multibyte_needle_without_panic() {
        // Regression: `start = abs + 1` after matching `未対応` (3-byte
        // UTF-8 chars) lands inside `未` and the next `content[start..]
        // .find(needle)` panicked at "byte index ... is not a char
        // boundary".
        let content = "intro 未対応 middle 未対応 again";
        let hits = find_exact_matches(content, "未対応");
        assert_eq!(hits.len(), 2);
        // Byte offsets must land at char boundaries
        assert_eq!(content.is_char_boundary(hits[0].byte_offset as usize), true);
        assert_eq!(content.is_char_boundary(hits[0].end_byte_offset as usize), true);
        assert_eq!(content.is_char_boundary(hits[1].byte_offset as usize), true);
        assert_eq!(content.is_char_boundary(hits[1].end_byte_offset as usize), true);
        // Slicing each Hit returns the original needle
        for h in &hits {
            assert_eq!(
                &content[h.byte_offset as usize..h.end_byte_offset as usize],
                "未対応"
            );
        }
    }

    #[test]
    fn rebind_does_not_panic_on_multibyte_content() {
        // Regression: japanese mark + japanese new content used to
        // panic inside find_exact_matches's loop on the second hit.
        let original = "見出し\n\n本文に未対応キーワードが複数: 未対応 / 未対応\n";
        let mark = make_mark("a.md", original, "未対応", 3);
        // Edit one occurrence
        let new_content = "見出し\n\n本文に解決済キーワードが複数: 未対応 / 未対応\n";
        let (_out, outcome) = rebind(&mark, new_content);
        // No panic.  Outcome may be Stale or Moved depending on heuristics;
        // we only care that it returns rather than crashing.
        let _ = outcome;
    }
}
