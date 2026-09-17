//! 要件#49 の受け入れテスト(docs/requirements/req-49.md)— Rust 層(契約⑤)
//!
//! マーク再アンカーの offset 単位を **UTF-16 code unit** に統一する(AC-49-9)。
//! `MarkAnchor` の doc(`annotation/types.rs`)と TS 側(`src/markdown/types.ts`)は
//! 0 起点の UTF-16 code unit を規定しているのに、`anchor.rs` の `rebind` は
//! `locate_text_offsets` / `find_exact_matches` / `best_fuzzy_match` が返す
//! **バイト位置**を `start_offset` / `end_offset` へ書いていた。ASCII だけの文書では
//! 両者が一致して見えないため、多バイト文字(日本語)とサロゲートペア(絵文字)を
//! 含む文書で、バイト位置・code point 数のどちらとも食い違うケースを固定する。
//!
//! ## 判定するもの
//! - rebind ladder の 2(UnchangedPosition)・3(Moved)・4(Fuzzy)のそれぞれが
//!   書く `start_offset` / `end_offset` が UTF-16 code unit であること
//! - その値でバイト列ではなく UTF-16 列をスライスすると `selected_markdown` が
//!   戻ること(単位の取り違えは必ず別の文字列になる)
//! - 期待値がバイト位置とも code point 数とも一致しないこと(テスト自身の弁別力)
//!
//! ## 判定しないもの
//! - 既存 rebind の受け入れ(hash 一致・見出しパスでの曖昧性解消・Stale 等)
//!   → `anchor.rs` 内の `#[cfg(test)]` が `cargo test` で緑のまま(契約⑤「既存
//!   rebind の受け入れは不変」はフルスイートで判定)
//! - 編集後の実地での再アンカー → 人間ゲート(acceptance/acceptance.md 要件#49 ⑤)

use vellis_lib::annotation::{rebind, sha256_hex, Anchor, Mark, MarkStatus, RebindOutcome};

// ---------------------------------------------------------------------------
// 単位の計算ヘルパ(期待値は手計算せず、TS 側と同じ定義から導く)
// ---------------------------------------------------------------------------

/// UTF-16 code unit 数(TS の `String.prototype.length` と同じ)。
fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// `line`(1 起点)の先頭のバイト位置。
fn byte_start_of_line(content: &str, line: u32) -> usize {
    let mut start = 0usize;
    for (i, l) in content.split('\n').enumerate() {
        if i as u32 + 1 == line {
            return start;
        }
        start += l.len() + 1;
    }
    panic!("line {line} is past the end of content");
}

/// `text` が `line` に現れる位置を、単位ごとに返す: (UTF-16, byte, code point)。
fn offsets_of(content: &str, line: u32, text: &str) -> ((u32, u32), (u32, u32), (u32, u32)) {
    let line_start = byte_start_of_line(content, line);
    let rel = content[line_start..]
        .find(text)
        .unwrap_or_else(|| panic!("{text:?} not found on line {line}"));
    let byte_start = line_start + rel;
    let prefix = &content[..byte_start];
    let utf16 = (utf16_len(prefix), utf16_len(prefix) + utf16_len(text));
    let bytes = (byte_start as u32, (byte_start + text.len()) as u32);
    let chars = (
        prefix.chars().count() as u32,
        (prefix.chars().count() + text.chars().count()) as u32,
    );
    (utf16, bytes, chars)
}

/// UTF-16 列を `[start, end)` でスライスして文字列に戻す(TS の `slice` 相当)。
fn utf16_slice(content: &str, start: u32, end: u32) -> String {
    let units: Vec<u16> = content.encode_utf16().collect();
    String::from_utf16(&units[start as usize..end as usize]).expect("valid UTF-16 slice")
}

/// `text` を 1 行まるごと選んだマーク。offset は TS 側が作るとおり UTF-16 で入れる。
fn mark_on_line(content: &str, line: u32, text: &str) -> Mark {
    let ((start_offset, end_offset), _, _) = offsets_of(content, line, text);
    Mark::new(
        "doc.md".into(),
        Anchor {
            start_line: line,
            end_line: line,
            start_offset,
            end_offset,
            selected_text: text.into(),
            selected_markdown: text.into(),
            heading_path: vec![],
            context_before: "".into(),
            context_after: "".into(),
            file_hash: sha256_hex(content),
        },
        "fix".into(),
    )
}

/// rebind が書いた offset が `expected_line` 上の `text` の UTF-16 位置であること。
/// バイト位置とは一致しないことも併せて固定する(単位の取り違えを見逃さないための、
/// テスト自身の弁別力の確認)。code point 数との弁別は BMP 外の文字が要るので、
/// サロゲートペアのケースだけで別に確かめる。
fn assert_utf16_anchor(new_content: &str, out: &Mark, expected_line: u32, text: &str) {
    let (utf16, bytes, chars) = offsets_of(new_content, expected_line, text);
    assert_ne!(utf16, bytes, "fixture must separate UTF-16 from byte offsets");

    assert_eq!(out.anchor.start_line, expected_line);
    assert_eq!(
        (out.anchor.start_offset, out.anchor.end_offset),
        utf16,
        "start_offset / end_offset must be UTF-16 code units (byte offsets would be {bytes:?}, code points {chars:?})"
    );
    assert_eq!(
        utf16_slice(new_content, out.anchor.start_offset, out.anchor.end_offset),
        text,
        "slicing the UTF-16 sequence with the written offsets must yield selected_markdown"
    );
}

// ---------------------------------------------------------------------------
// ladder 2 — UnchangedPosition(行は同じ・他の行が変わった)
// ---------------------------------------------------------------------------

#[test]
fn rebind_unchanged_position_writes_utf16_offsets_for_japanese() {
    // 1 行目に多バイト文字があるので、3 行目の位置はバイトと UTF-16 でずれる。
    let content_a = "見出し\n\nターゲット行\n";
    let content_b = "見出し(改)\n\nターゲット行\n";
    let mark = mark_on_line(content_a, 3, "ターゲット行");

    let (out, outcome) = rebind(&mark, content_b);

    assert_eq!(outcome, RebindOutcome::UnchangedPosition);
    assert_utf16_anchor(content_b, &out, 3, "ターゲット行");
}

// ---------------------------------------------------------------------------
// ladder 3 — Moved(行が前に挿入されてずれた)
// ---------------------------------------------------------------------------

#[test]
fn rebind_moved_writes_utf16_offsets_after_multibyte_insertion() {
    let content_a = "序文\n\n対象の文\n";
    let content_b = "序文\n\n追加された行\n対象の文\n";
    let mark = mark_on_line(content_a, 3, "対象の文");

    let (out, outcome) = rebind(&mark, content_b);

    assert_eq!(outcome, RebindOutcome::Moved);
    assert_utf16_anchor(content_b, &out, 4, "対象の文");
}

#[test]
fn rebind_moved_counts_a_surrogate_pair_as_two_units() {
    // '😀' は 1 code point・2 UTF-16 code unit・4 byte。code point で数える実装も
    // バイトで数える実装も、ここで期待値から外れる。
    let content_a = "絵文字 😀 の行\n\n対象の文\n";
    let content_b = "絵文字 😀 の行\n\n差し込み\n対象の文\n";
    let mark = mark_on_line(content_a, 3, "対象の文");
    let (utf16, _, chars) = offsets_of(content_b, 4, "対象の文");
    assert_ne!(utf16, chars, "fixture must separate UTF-16 from code point offsets");

    let (out, outcome) = rebind(&mark, content_b);

    assert_eq!(outcome, RebindOutcome::Moved);
    assert_utf16_anchor(content_b, &out, 4, "対象の文");
}

// ---------------------------------------------------------------------------
// ladder 4 — Fuzzy(文が少し変わった)
// ---------------------------------------------------------------------------

#[test]
fn rebind_fuzzy_writes_utf16_offsets_for_japanese_line() {
    // anchor.rs の既存ケース(P95 → P99)に多バイトの前置き行を足したもの。
    // 行末の offset は行の中の日本語でもずれる(バイトでは 3 倍に伸びる)。
    let content_a = "前置き\n- レスポンスタイム目標: P95 < 200ms\nend\n";
    let content_b = "前置き\n- レスポンスタイム目標: P99 < 300ms\nend\n";
    let mut mark = mark_on_line(content_a, 2, "- レスポンスタイム目標: P95 < 200ms");
    mark.status = MarkStatus::SentToAgent;

    let (out, outcome) = rebind(&mark, content_b);

    assert_eq!(outcome, RebindOutcome::Fuzzy);
    assert_eq!(out.status, MarkStatus::ChangedByAgent);
    assert_utf16_anchor(content_b, &out, 2, "- レスポンスタイム目標: P99 < 300ms");
}
