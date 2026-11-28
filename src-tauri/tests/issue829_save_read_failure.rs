//! Issue #829 — 保存前の照合(`save_document` に `expected_hash` を渡したとき)で、ファイルの読み込みの失敗がすべて
//! 「ディスク上で変更された」(`SAVE_CONFLICT_PREFIX`)になる。
//!
//! `src-tauri/src/commands/document.rs` の `save_document` は照合のための `read_to_string` の失敗を
//! `format!("{SAVE_CONFLICT_PREFIX}: {e}")` に写している。別のツールがファイルを消した直後の Command + S・権限のエラー・UTF-8 でない中身の
//! どれも重なりの帯(Keep My Edits → `readDisk` の失敗 → アラート)になる。
//!
//! ## 確定契約(implementer はこれに従う=test-writer が固定・2026-11-28)
//!
//! ```rust
//! // src-tauri/src/commands/document.rs
//! /// 照合のためにディスクの今の中身を読む。読めないときの Err は読めなかった理由(io のエラーの文)を含み、
//! /// SAVE_CONFLICT_PREFIX を含まない(衝突ではない=フロントは alert で知らせる)。
//! pub async fn read_disk_for_save(path: &std::path::Path) -> Result<String, String>;
//! // save_document: `ensure_within_root(` の後・`check_expected_hash(` の前に `read_disk_for_save(` で読む。
//! //   save_document の本文に SAVE_CONFLICT_PREFIX の字は無い(接頭辞を付けるのは check_expected_hash だけ)。
//! //   check_expected_hash( の呼び方は要件74(acceptance_req74.rs 16)のまま
//! ```
//!
//! ## 固定する振る舞い(直った後)
//! - 読める → Ok(中身そのまま。BOM・CRLF も byte のまま)
//! - 無い・ディレクトリ・UTF-8 でない → Err。文に `SAVE_CONFLICT_PREFIX` を含まず、`std::fs::read_to_string` が返すのと同じ io のエラーの文を含む
//! - `check_expected_hash` の不一致は今までどおり接頭辞つき(要件74)
//!
//! ## 判断の記録(test-writer 2026-11-28)
//! - `save_document` は Tauri の Window / State を取る command なので統合テストから呼べない(要件74・89 と同じ)。読みの段を pub の関数に
//!   出して両側を渡し、command の本文はソースをテキストとして読んで判定する(要件89 の `write_save_as` と同じ家風)
//! - 関数の名前 `read_disk_for_save` は本テストが固定した(Issue は「別のエラーで返す」とだけ)。要件74 のテストが `save_document` の本文に
//!   `check_expected_hash(` を要求するので、読みと照合を 1 つの関数にまとめる形は選ばなかった
//! - Err の文の頭(「Could not save」など)は固定しない。フロント(`saveFileEditor`)は接頭辞で始まらない Err を `Could not save: {err}` の
//!   alert にするので、ここでは io のエラーの文が含まれることだけを見る
//!
//! ## 修正前に赤になる理由
//! - `vellis_lib::commands::document::read_disk_for_save` が無いのでコンパイルできない(ファイル全体が赤)。
//!   `save_document` の本文に `SAVE_CONFLICT_PREFIX` の字がある

use std::path::PathBuf;

use tempfile::TempDir;

use vellis_lib::commands::document::{check_expected_hash, content_hash, read_disk_for_save, SAVE_CONFLICT_PREFIX};

// ---------------------------------------------------------------------------
// ソースを読む helper(acceptance_req74.rs と同じ)
// ---------------------------------------------------------------------------

fn strip_line_comments(src: &str) -> String {
    src.lines()
        .map(|line| {
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") {
                ""
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn document_rs_code() -> String {
    strip_line_comments(include_str!("../src/commands/document.rs"))
}

fn fn_decl_start(code: &str, name: &str) -> Option<usize> {
    let marker = format!("fn {name}");
    let mut from = 0;
    while let Some(i) = code[from..].find(&marker) {
        let at = from + i;
        let after = code[at + marker.len()..].chars().next();
        if matches!(after, Some('(') | Some('<')) {
            return Some(at);
        }
        from = at + marker.len();
    }
    None
}

fn matching_close(code: &str, open: usize) -> usize {
    let bytes = code.as_bytes();
    let open_ch = bytes[open];
    let close_ch = match open_ch {
        b'(' => b')',
        b'{' => b'}',
        _ => panic!("matching_close expects ( or {{"),
    };
    let mut depth = 0usize;
    let mut i = open;
    while i < bytes.len() {
        let c = bytes[i];
        if c == open_ch {
            depth += 1;
        } else if c == close_ch {
            depth -= 1;
            if depth == 0 {
                return i;
            }
        }
        i += 1;
    }
    panic!("unbalanced brackets from {open}");
}

fn fn_body(code: &str, name: &str) -> String {
    let start = fn_decl_start(code, name).unwrap_or_else(|| panic!("source must define `fn {name}(`"));
    let params_open = code[start..].find('(').expect("fn must take parameters") + start;
    let params_close = matching_close(code, params_open);
    let open = code[params_close..].find('{').expect("fn must have a body") + params_close;
    let close = matching_close(code, open);
    code[open + 1..close].to_string()
}

fn io_error_text(path: &std::path::Path) -> String {
    std::fs::read_to_string(path)
        .expect_err("the fixture must not be readable as a string")
        .to_string()
}

fn missing_path(tmp: &TempDir) -> PathBuf {
    tmp.path().join("gone.md")
}

// ---------------------------------------------------------------------------
// read_disk_for_save: 両側
// ---------------------------------------------------------------------------

#[tokio::test]
async fn readable_file_is_returned_as_it_is() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("plan.md");
    let content = "\u{FEFF}# Plan\r\n\r\nSecond line\r\n";
    std::fs::write(&path, content).unwrap();
    assert_eq!(read_disk_for_save(&path).await, Ok(content.to_string()));
}

#[tokio::test]
async fn missing_file_is_not_a_conflict() {
    let tmp = TempDir::new().unwrap();
    let path = missing_path(&tmp);
    let err = read_disk_for_save(&path).await.expect_err("a missing file cannot be read");
    assert!(
        !err.contains(SAVE_CONFLICT_PREFIX),
        "a missing file is not 'changed on disk': {err}"
    );
    let io = io_error_text(&path);
    assert!(err.contains(&io), "the message names the reason ({io}): {err}");
}

#[tokio::test]
async fn directory_is_not_a_conflict() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("folder.md");
    std::fs::create_dir(&path).unwrap();
    let err = read_disk_for_save(&path).await.expect_err("a directory cannot be read as text");
    assert!(!err.contains(SAVE_CONFLICT_PREFIX), "{err}");
    let io = io_error_text(&path);
    assert!(err.contains(&io), "the message names the reason ({io}): {err}");
}

#[tokio::test]
async fn invalid_utf8_is_not_a_conflict() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("binary.md");
    std::fs::write(&path, [0x23, 0x20, 0xff, 0xfe, 0x00, 0x80]).unwrap();
    let err = read_disk_for_save(&path).await.expect_err("invalid UTF-8 cannot be read as text");
    assert!(!err.contains(SAVE_CONFLICT_PREFIX), "{err}");
    let io = io_error_text(&path);
    assert!(err.contains(&io), "the message names the reason ({io}): {err}");
}

/// 要件74 のまま: 本当にハッシュが合わないときだけ接頭辞つき。
#[test]
fn hash_mismatch_is_still_the_conflict_with_the_prefix() {
    let disk = "line one\nline two\n";
    assert_eq!(check_expected_hash(disk, Some(&content_hash(disk))), Ok(()));
    let err = check_expected_hash(disk, Some(&content_hash("line one\nline two\nline three\n"))).expect_err("changed");
    assert!(err.starts_with(SAVE_CONFLICT_PREFIX), "{err}");
}

// ---------------------------------------------------------------------------
// save_document の本文(ソースを読む)
// ---------------------------------------------------------------------------

/// `save_document` は照合のための読みを `read_disk_for_save(` で行い(root の確かめの後・照合の前)、本文に接頭辞の字を持たない。
#[test]
fn save_document_reads_through_read_disk_for_save_and_never_writes_the_prefix_itself() {
    let code = document_rs_code();
    let body = fn_body(&code, "save_document");
    assert!(
        !body.contains("SAVE_CONFLICT_PREFIX"),
        "save_document must not attach SAVE_CONFLICT_PREFIX itself (only check_expected_hash does):\n{body}"
    );
    let read = body
        .find("read_disk_for_save(")
        .expect("save_document must read the disk through read_disk_for_save( for the optimistic lock");
    let root = body
        .find("ensure_within_root(")
        .expect("save_document still checks the root with ensure_within_root(");
    let check = body
        .find("check_expected_hash(")
        .expect("save_document still compares with check_expected_hash( (要件74 契約14)");
    assert!(root < read, "the root is judged before the disk is read");
    assert!(read < check, "the disk is read before it is compared");
    // 読みの失敗はそのまま呼び手へ返す(`?` が同じ文の中にある)。衝突に写さない。
    let call_open = read + "read_disk_for_save".len();
    let call_close = matching_close(&body, call_open);
    let rest = &body[call_close + 1..];
    let stmt_end = rest.find(';').unwrap_or(rest.len());
    assert!(
        rest[..stmt_end].contains('?'),
        "read_disk_for_save(…) must return its failure with `?` in the same statement: …{}",
        &rest[..stmt_end]
    );
}
