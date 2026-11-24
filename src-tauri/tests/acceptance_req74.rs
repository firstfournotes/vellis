//! 要件#74 第1段の受け入れテスト(docs/requirements/req-74.md)— Rust 層
//! (AC-74-24 フラグ・AC-74-40 Save の出し分けと門・AC-74-16 保存の照合・AC-74-23 依存と触らないもの=契約 14・20・21。
//!  契約19 の「第1段の作り」1・7・8・17・18)
//!
//! 純関数(`resolve_by_name`・`flags_map_for`・`require_any_with`・`content_hash`・`check_expected_hash`)には両側を渡して見る。
//! 入口(`menu::build` の判定・`save_document` の最初の文と照合の順)は**ソースをテキストとして読んで**判定する
//! (acceptance_req84.rs の `fn_body`・`first_statement` と同じ作り)。新しい公開の口を `use` するので、実装前は
//! このファイルはコンパイルできない=赤の理由は「未実装」(acceptance_req84.rs と同じ)。
//!
//! フロントの分(`EDITOR_FILE_FLAG`・ページの配線・package.json)は `src/lib/editor-flags.acceptance.test.ts`、
//! 面の分は `src/components/CodeEditor.wiring.test.ts`、文書モデルは `src/editor/*.acceptance.test.ts`。
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前。推奨名は req-74.md のもの・無いものは test-writer が固定)
//!
//! ```ignore
//! // --- src-tauri/src/features/mod.rs
//! pub const EDITOR_FILE: &str = "editor_file";
//! // REGISTRY = &[ editor_inline(今のまま), ai_marks(今のまま),
//! //               FlagSpec { name: EDITOR_FILE, kind: Dev, default_dev: false /* 第1段の周回中。完了で true=(af) */,
//! //                          default_release: false, owner: "yutani", removal: "#820", description: "<英語 1 行>" } ]
//! /// どれかが真なら Ok。全部偽なら Err("<what> is not available in this version of Vellis")(文は `require` と同じ)。
//! pub fn require_any(names: &[&str], what: &str) -> Result<(), String>;
//! /// 純関数の版。`enabled` のどれかが真なら Ok。空でも Err。
//! pub fn require_any_with(enabled: &[bool], what: &str) -> Result<(), String>;
//!
//! // --- src-tauri/src/menu.rs(build の本文。Submenu の並びは今のまま・組んだ後に外す)
//! //   if !crate::features::is_enabled(crate::features::EDITOR_INLINE) && !crate::features::is_enabled(crate::features::EDITOR_FILE) {
//! //       file_menu.remove(&save_item)?; file_menu.remove(&save_sep)?;
//! //   }
//! //   if !crate::features::is_enabled(crate::features::EDITOR_INLINE) { edit_menu.remove(&edit_mode_item)?; }
//! //   (`crate::` の有無は問わない。`.remove(` は build に 3 つのまま=AC-84-4 の 10)
//!
//! // --- src-tauri/src/commands/document.rs
//! /// フロントの `contentHash`(src/lib/document-edit.ts)と同じ値: FNV-1a 32bit と djb2 32bit を UTF-16 の単位で回し、
//! /// `{UTF-16 の長さ(36 進)}-{fnv(36 進)}-{djb(36 進)}`(36 進は小文字)。
//! pub fn content_hash(content: &str) -> String;
//! /// 照合のエラーの接頭辞(フロントの `SAVE_CONFLICT_PREFIX` と同じ綴り)。
//! pub const SAVE_CONFLICT_PREFIX: &str = "The file was changed on disk";
//! /// 楽観ロックの純関数: `expected` が None なら Ok(従来どおり書く)。Some なら `content_hash(disk)` と比べ、違えば
//! /// Err(SAVE_CONFLICT_PREFIX で始まる文)。
//! pub fn check_expected_hash(disk: &str, expected: Option<&str>) -> Result<(), String>;
//! // save_document(uri, content, expected_hash: Option<String>, window, state):
//! //   最初の文= features::require_any(&[features::EDITOR_INLINE, features::EDITOR_FILE], "Saving")?;
//! //   `check_expected_hash(` を `store_for(`(写し)より前・`ensure_within_root(` より後に呼ぶ(root の外は従来どおり先に断る)。
//! //   引数を省いた呼び出し(今の編集の `saveDocument(uri, content)`)は従来どおり書く
//!
//! // --- src/lib/editor-flags.ts(フロントの正本は editor-flags.acceptance.test.ts)
//! export const EDITOR_FILE_FLAG = 'editor_file';
//! // --- src/editor/file-editor.ts
//! export const SAVE_CONFLICT_PREFIX = 'The file was changed on disk';
//! ```
//!
//! ## 判断の記録(test-writer 2026-11-16)
//! - `removal` は周回開始時に作った Issue #820 で固定した(req-74.md は「周回開始時に作る Issue」とだけ書く)
//! - `default_dev` は (af)=「第1段の周回中は偽・第1段の完了(人間ゲートの後)で真」。本テストは**周回中の値 `false`** を
//!   `EDITOR_FILE_DEFAULT_DEV` に置く。第1段の完了でこの定数を `true` に改める(要件側更新・同じコミットで AC-84-1 の 2 も見直す)
//! - AC-74-16 の「ファイルの byte も `.vellis/snapshots/` も変わらない・`.vellis-tmp` が残らない」は、`save_document` が
//!   Tauri の Window / State を取る command なので統合テストから呼べない。純関数 `check_expected_hash` と、本文の中で
//!   照合が写し(`store_for(`)と書き込みより前に来ること(ソース走査)で固定する。実機は人間ゲート 6
//! - `content_hash` の表は `src/editor/text-document.acceptance.test.ts` の `CONTENT_HASH_TABLE` と同じ値(2026-11-16 に
//!   フロントの `contentHash` で実測)
//!
//! ## 修正前に赤になる理由
//! - `features::EDITOR_FILE`・`require_any`・`require_any_with`・`commands::document::{content_hash, check_expected_hash,
//!   SAVE_CONFLICT_PREFIX}` が無いのでコンパイルできない(ファイル全体が赤)。依存・capability・tauri.conf.json の不変の
//!   ケースは実装前から緑(不変の固定)

use std::path::PathBuf;

use vellis_lib::annotation::sha256_hex;
use vellis_lib::commands::document::{check_expected_hash, content_hash, SAVE_CONFLICT_PREFIX};
// 要件74 第2段 2-5(2026-11-17 仮・契約21・AC-74-24 → AC-74-46): `editor_file`(#820)と `editor_inline`(#811)は REGISTRY から外れ、
// AC-74-24(フラグ)と AC-74-40(Save の出し分けと門)はこのファイルから外した。後継は acceptance_req74_removal.rs(AC-74-46)。
use vellis_lib::features::{require_any_with, require_with, AI_MARKS, REGISTRY};

// ---------------------------------------------------------------------------
// 共通ヘルパ — acceptance_req84.rs と同じ流儀(コメント落とし・括弧の対応)
// ---------------------------------------------------------------------------

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_source_or_empty(rel: &str) -> String {
    std::fs::read_to_string(manifest_dir().join(rel)).unwrap_or_default()
}

fn strip_line_comments(src: &str) -> String {
    src.lines()
        .map(|line| {
            let bytes = line.as_bytes();
            let mut i = 0;
            while i + 1 < bytes.len() {
                if bytes[i] == b'/' && bytes[i + 1] == b'/' && (i == 0 || bytes[i - 1] != b':') {
                    return &line[..i];
                }
                i += 1;
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn menu_rs_code() -> String {
    strip_line_comments(include_str!("../src/menu.rs"))
}

fn document_rs_code() -> String {
    strip_line_comments(include_str!("../src/commands/document.rs"))
}

fn lib_rs_code() -> String {
    strip_line_comments(include_str!("../src/lib.rs"))
}

fn fn_decl_start(code: &str, name: &str) -> Option<usize> {
    let marker = format!("fn {name}");
    let mut search = 0;
    while let Some(rel) = code[search..].find(&marker) {
        let at = search + rel;
        let after = code[at + marker.len()..].chars().next();
        if matches!(after, Some('(') | Some('<')) {
            return Some(at);
        }
        search = at + marker.len();
    }
    None
}

fn matching_close(code: &str, open: usize) -> usize {
    let bytes = code.as_bytes();
    let (inc, dec) = match bytes[open] {
        b'{' => (b'{', b'}'),
        b'(' => (b'(', b')'),
        b'[' => (b'[', b']'),
        other => panic!("not an opening bracket at {open}: {}", other as char),
    };
    let mut depth = 0usize;
    let mut in_str = false;
    let mut i = open;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if c == b'\\' {
                i += 2;
                continue;
            }
            if c == b'"' {
                in_str = false;
            }
        } else if c == b'"' {
            in_str = true;
        } else if c == inc {
            depth += 1;
        } else if c == dec {
            depth -= 1;
            if depth == 0 {
                return i;
            }
        }
        i += 1;
    }
    panic!("unbalanced bracket starting at byte {open}");
}

/// 関数の本体(外側の括弧を除く)。無ければ panic(=赤)。
fn fn_body(code: &str, name: &str) -> String {
    let start = fn_decl_start(code, name)
        .unwrap_or_else(|| panic!("source must define `fn {name}(` (or `fn {name}<`)"));
    let params_open = code[start..].find('(').expect("fn must take parameters") + start;
    let params_close = matching_close(code, params_open);
    let open = code[params_close..].find('{').expect("fn must have a body") + params_close;
    let close = matching_close(code, open);
    code[open + 1..close].to_string()
}

/// 関数のシグネチャの引数部分(`(`…`)` の中身)。
fn fn_params(code: &str, name: &str) -> String {
    let start = fn_decl_start(code, name)
        .unwrap_or_else(|| panic!("source must define `fn {name}(`"));
    let params_open = code[start..].find('(').expect("fn must take parameters") + start;
    let params_close = matching_close(code, params_open);
    code[params_open + 1..params_close].to_string()
}

fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| {
        matches!(c as u32,
            0x3000..=0x303F | 0x3040..=0x309F | 0x30A0..=0x30FF | 0x4E00..=0x9FFF | 0xFF00..=0xFFEF)
    })
}

fn first_statement(code: &str, name: &str) -> String {
    let body = fn_body(code, name);
    let trimmed = body.trim_start();
    let end = trimmed.find(';').unwrap_or(trimmed.len());
    squash(&trimmed[..end])
}

/// `export const NAME = '…'` の文字列リテラルの中身(acceptance_req84.rs の写し)。
fn ts_string_const(src: &str, file: &str, name: &str) -> String {
    let marker = format!("export const {name}");
    let at = src
        .find(&marker)
        .unwrap_or_else(|| panic!("{file} must `{marker}`"));
    let rest = &src[at + marker.len()..];
    let eq = rest.find('=').expect("`=` after the const name");
    let after = rest[eq + 1..].trim_start();
    let quote = after.chars().next().expect("a quoted string");
    assert!(
        quote == '\'' || quote == '"' || quote == '`',
        "{name} must be a string literal, got {after:?}"
    );
    let body = &after[quote.len_utf8()..];
    let end = body.find(quote).expect("closing quote");
    body[..end].to_string()
}

/// `if <cond> { <block> }` の一覧(`else if` も拾う。`cond` は `if` から `{` の手前まで・`block` は括弧を含む)。
fn if_statements(body: &str) -> Vec<(String, String)> {
    let bytes = body.as_bytes();
    let mut out = Vec::new();
    let mut search = 0;
    while let Some(rel) = body[search..].find("if ") {
        let at = search + rel;
        let word_start = at == 0 || !(bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_');
        search = at + 3;
        if !word_start {
            continue;
        }
        // 条件の終わり= 括弧の深さ 0 の最初の `{`。
        let mut depth = 0i32;
        let mut i = at + 3;
        let mut block_open = None;
        while i < bytes.len() {
            match bytes[i] {
                b'(' | b'[' => depth += 1,
                b')' | b']' => depth -= 1,
                b'{' if depth == 0 => {
                    block_open = Some(i);
                    break;
                }
                b';' if depth == 0 => break,
                _ => {}
            }
            i += 1;
        }
        let Some(open) = block_open else { continue };
        let close = matching_close(body, open);
        out.push((
            body[at + 3..open].trim().to_string(),
            body[open..=close].to_string(),
        ));
    }
    out
}

/// `generate_handler![ … ]` の 2 つの一覧(acceptance_req84.rs の写し)。
fn generate_handler_lists(code: &str) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    let mut search = 0;
    while let Some(rel) = code[search..].find("generate_handler![") {
        let start = search + rel + "generate_handler!".len();
        let close = matching_close(code, start);
        let names = code[start + 1..close]
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.rsplit("::").next().unwrap_or(s).to_string())
            .collect();
        out.push(names);
        search = close;
    }
    out
}

// ---------------------------------------------------------------------------
// AC-74-24 → AC-74-46(撤去の後): REGISTRY は ai_marks だけ(詳細は acceptance_req74_removal.rs)
// ---------------------------------------------------------------------------

#[test]
fn ac74_46_registry_holds_ai_marks_alone() {
    let names: Vec<&str> = REGISTRY.iter().map(|f| f.name).collect();
    assert_eq!(names, vec![AI_MARKS], "REGISTRY = ai_marks alone after the removal round (契約21・AC-74-46)");
}

/// `require_any_with` は純関数として残る(門には使わない)。
#[test]
fn ac74_40_require_any_with_is_or_of_the_flags() {
    assert_eq!(require_any_with(&[true, false], "Saving"), Ok(()));
    assert_eq!(require_any_with(&[false, false], "Saving"), require_with(false, "Saving"));
}

// ---------------------------------------------------------------------------
// AC-74-16 — 保存の照合(契約14・契約19-7)
// ---------------------------------------------------------------------------

/// `src/editor/text-document.acceptance.test.ts` の `CONTENT_HASH_TABLE` と同じ値。
fn content_hash_table() -> Vec<(&'static str, String, &'static str)> {
    vec![
        ("empty", String::new(), "0-ztntfp-45h"),
        ("ascii", "abc".to_string(), "3-7aigaz-3772q3"),
        ("japanese", "日本語のテキスト\n".to_string(), "9-mdn3tu-iq79uo"),
        ("surrogate", "a😀b".to_string(), "4-13waept-zlbdid"),
        ("crlf", "line one\r\nline two\r\n".to_string(), "k-1oi56o7-2or8vz"),
        ("bom", "\u{FEFF}bom".to_string(), "4-1nrhob8-29w4w2"),
        ("longx", "x".repeat(100_000), "255s-3s8zlx-vloc1x"),
    ]
}

/// 13. `content_hash` はフロントの `contentHash` と同じ値(空・ASCII・日本語・サロゲート対・CRLF・BOM・10 万字)。
#[test]
fn ac74_16_content_hash_matches_the_frontend_table() {
    for (name, input, expected) in content_hash_table() {
        assert_eq!(content_hash(&input), expected, "content_hash({name})");
    }
}

/// 14. `check_expected_hash`: None は Ok・一致は Ok・不一致は接頭辞つきの Err。
#[test]
fn ac74_16_check_expected_hash_table() {
    let disk = "line one\r\nline two\r\n";
    assert_eq!(check_expected_hash(disk, None), Ok(()), "no expected hash → write as before");
    assert_eq!(check_expected_hash(disk, Some(&content_hash(disk))), Ok(()));
    assert_eq!(check_expected_hash("", Some(&content_hash(""))), Ok(()));
    let err = check_expected_hash(disk, Some(&content_hash("line one\r\nline two\r\nline three\r\n")))
        .expect_err("different disk content → conflict");
    assert!(
        err.starts_with(SAVE_CONFLICT_PREFIX),
        "conflict error starts with the fixed prefix: {err}"
    );
    assert!(!has_cjk(&err));
    let err = check_expected_hash(disk, Some("not-a-hash")).expect_err("garbage expected → conflict");
    assert!(err.starts_with(SAVE_CONFLICT_PREFIX));
}

/// 15. 接頭辞はフロントの `SAVE_CONFLICT_PREFIX`(`src/editor/file-editor.ts`)と同じ綴り。
#[test]
fn ac74_16_conflict_prefix_matches_the_frontend() {
    assert_eq!(SAVE_CONFLICT_PREFIX, "The file was changed on disk");
    let ts = read_source_or_empty("../src/editor/file-editor.ts");
    assert!(!ts.is_empty(), "src/editor/file-editor.ts must exist");
    assert_eq!(
        ts_string_const(&ts, "src/editor/file-editor.ts", "SAVE_CONFLICT_PREFIX"),
        SAVE_CONFLICT_PREFIX
    );
}

/// 16. `save_document` は省略可能な `expected_hash: Option<String>` を取り、照合を root の確かめの後・写し(`store_for(`)の
///     前に置く。引数を省いた呼び出し(今の `saveDocument(uri, content)`)が通る形(Option)である。
#[test]
fn ac74_16_save_document_takes_expected_hash_and_checks_before_the_snapshot() {
    let code = document_rs_code();
    let params = squash(&fn_params(&code, "save_document"));
    assert!(
        params.contains("expected_hash:Option<String>"),
        "save_document must take `expected_hash: Option<String>` (invoke では expectedHash・省略可): {params}"
    );
    let body = fn_body(&code, "save_document");
    let check = body
        .find("check_expected_hash(")
        .expect("save_document must call check_expected_hash( (契約14)");
    let root = body
        .find("ensure_within_root(")
        .expect("save_document still checks the root with ensure_within_root(");
    let snapshot = body
        .find("store_for(")
        .expect("save_document still takes the pre-save snapshot through store_for(");
    let write = body
        .find("write_text_within_root(")
        .expect("save_document still writes through write_text_within_root(");
    assert!(root < check, "root containment is judged before the hash check (outside-root is refused as before)");
    assert!(check < snapshot, "the hash check comes before the snapshot: nothing is copied on a conflict");
    assert!(check < write, "the hash check comes before the write");
    let call_open = check + "check_expected_hash".len();
    let call_close = matching_close(&body, call_open);
    let call = squash(&body[check..=call_close]);
    assert!(call.contains("expected_hash"), "the check is given the argument: {call}");
    // 照合の失敗は `?` で呼び手へ返す(書かずに衝突として返す)。`check_expected_hash(…)?;` でも
    // `check_expected_hash(…).map_err(…)?;` でもよいが、同じ文の中で `?` が付くこと。
    let rest = &body[call_close + 1..];
    let stmt_end = rest.find(';').unwrap_or(rest.len());
    assert!(
        rest[..stmt_end].contains('?'),
        "check_expected_hash(…) must return the conflict with `?` in the same statement: …{}",
        &rest[..stmt_end]
    );
}

// ---------------------------------------------------------------------------
// AC-74-23 / 契約19-18 — 依存・capability・command の数・触らないもの(Rust 側)
// ---------------------------------------------------------------------------

/// 2026-11-16 の main の `[dependencies]`(31 名=AC-56-11 と同じ数え方)。
const CARGO_DEPENDENCIES: [&str; 31] = [
    "async-trait",
    "bytes",
    "chrono",
    "clap",
    "dirs",
    "hidapi",
    "http",
    "libc",
    "mime_guess",
    "notify",
    "percent-encoding",
    "regex",
    "reqwest",
    "russh",
    "russh-sftp",
    "serde",
    "serde_json",
    "sha2",
    "similar",
    "strsim",
    "tauri",
    "tauri-plugin-dialog",
    "tauri-plugin-opener",
    "tauri-plugin-webdriver",
    "tauri-plugin-window-state",
    "thiserror",
    "tokio",
    "toml",
    "tracing",
    "tracing-subscriber",
    "ulid",
];

fn cargo_dependency_names() -> Vec<String> {
    let toml = include_str!("../Cargo.toml");
    let mut names = Vec::new();
    let mut in_section = false;
    for line in toml.lines() {
        if line.starts_with('[') {
            in_section = line.trim() == "[dependencies]";
            continue;
        }
        if !in_section {
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(eq) = trimmed.find('=') {
            let name = trimmed[..eq].trim();
            if name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                names.push(name.to_string());
            }
        }
    }
    names.sort();
    names
}

/// 17. `Cargo.toml` の `[dependencies]` は無改変(契約20「Rust の依存は増やさない」)。
#[test]
fn ac74_23_cargo_dependencies_are_unchanged() {
    let mut expected: Vec<String> = CARGO_DEPENDENCIES.iter().map(|s| s.to_string()).collect();
    expected.sort();
    assert_eq!(cargo_dependency_names(), expected);
}

/// 18. `capabilities/default.json` と `tauri.conf.json` は無改変(SHA-256・2026-11-16 の main)。
///
/// 2026-11-21 要件側の更新:版上げ(0.7.0)で version は変わるので除く。
/// `tauri.conf.json` は JSON として読み、トップの `version` の欄だけを除いた正規の形
/// (`serde_json::to_string`・preserve_order で欄の並びはファイルのまま・空白なし)の SHA-256 を比べる。
/// 期待値は 2026-11-16 の main(a45dd887…=0.6.0)から `version` を除いた形。version 以外の欄が 1 つでも
/// 変われば(値・欄の追加/削除・並び)赤のまま。capabilities の側はファイルの byte のまま固定する。
#[test]
fn ac74_23_capabilities_and_tauri_conf_are_unchanged() {
    assert_eq!(
        sha256_hex(include_str!("../capabilities/default.json")),
        "faed09590bb5f8a89b1bf7d4ba6fa96b74767250d794edb4f50cd32dbe45bbff",
        "capabilities/default.json (契約20: capability は増やさない)"
    );
    let mut conf: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json is JSON");
    let top = conf.as_object_mut().expect("tauri.conf.json is a JSON object");
    // `remove` は preserve_order では swap_remove(最後の欄が前に来る)なので、並びを保つ shift_remove を使う
    top.shift_remove("version");
    let canonical = serde_json::to_string(&conf).expect("serialize tauri.conf.json");
    assert_eq!(
        sha256_hex(&canonical),
        "2b2a63ed1b7b490cb01f514eb644286faa05c8d05dcd076ff9486ee4980c13aa",
        "tauri.conf.json without the top-level `version` (契約19-18)"
    );
}

/// 19. `generate_handler!` の 2 つの一覧は 45 / 44 のまま(command は増やさない。並びは AC-84-6 の 23 が固定)。
#[test]
fn ac74_23_generate_handler_lists_keep_45_and_44_commands() {
    let lists = generate_handler_lists(&lib_rs_code());
    assert_eq!(lists.len(), 2);
    assert_eq!(lists[0].len(), 45, "webdriver list");
    assert_eq!(lists[1].len(), 44, "default list");
    assert!(lists[0].contains(&"save_document".to_string()));
    assert!(lists[1].contains(&"save_document".to_string()));
}
