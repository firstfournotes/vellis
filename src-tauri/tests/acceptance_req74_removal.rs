//! 要件#74 第2段 2-5 — 今の編集の撤去(Rust の分)。AC-74-25・AC-74-43・AC-74-46(契約21・契約14・決定 (ad)(ae)(ah))。
//!
//! **仮の前提(2026-11-17・由谷の確認待ち)**: 決定 (ae)=配布版に新しい編集を出す時点は第2段の完了(撤去と同時にフラグを外して通常の機能に)・
//! (ah)=Settings… / Export Default Theme… は Vellis の窓・(ad)=Edit ▸ Edit を外す・(ag)=保存前の写しは先行の周回で済み(AC-74-44)。
//!
//! ## 対応する受け入れ基準
//! - AC-74-25 現行の編集の撤去(Rust の分): `menu.rs` に `EDIT_ITEM_ID`・`MENU_EDIT_EVENT`・`EDIT_ACCELERATOR` が無い。`lib.rs` の `on_menu_event` に
//!   Edit ▸ Edit の腕が無い。Command + E(`CmdOrCtrl+E`)はどこにも登録されない
//! - AC-74-43 Settings… / Export Default Theme…: `handle_settings_click` と `handle_export_default_theme_click` が Vellis の窓を開き(`create_window(`)、
//!   既定のアプリを開く枝(`open_path(`)が無い。外で保存した設定の知らせの条件は「編集がある」側(`settings_announce_needed(…, true)`)
//! - AC-74-46 フラグの撤去: `REGISTRY` が `ai_marks` だけ。`features::EDITOR_INLINE`・`EDITOR_FILE` が無い。File ▸ Save・Format・View ▸ Raw Source が
//!   フラグなしで常に作られ、`save_document` に門が無い。タグの CI の確かめ(要件84 契約13)の名前の一覧に `editor_inline` が無い。
//!   `docs/feature-flags.md` の登録の表からも外れる(文書は implementer の仕事=ここでは見ない)
//! - 契約14: 門が無くても照合(`check_expected_hash(`)と写し(`take_snapshot(`)と書き込みの順は第1段のまま(AC-74-44 の 12 が見る)
//!
//! ## 確定契約(implementer はこれに従う)
//! ```text
//! // src-tauri/src/features/mod.rs: REGISTRY = &[FlagSpec { name: AI_MARKS, … }]。pub const EDITOR_INLINE / EDITOR_FILE は消す。
//! //   require / require_with / require_any / require_any_with は純関数として残してよい(門には使わない)
//! // src-tauri/src/menu.rs: EDIT_ITEM_ID / MENU_EDIT_EVENT / EDIT_ACCELERATOR と edit_mode_item を消す(edit_mode_sep は Find… の前に残す)。
//! //   build() に .remove( / is_enabled( は無い。handle_settings_click / handle_export_default_theme_click は create_window( だけ
//! // src-tauri/src/commands/document.rs: save_document の最初の文は門でない(Uri::parse から)。check_expected_hash( は残る
//! // src-tauri/src/commands/annotation.rs: vellis_dir_allowed(ai: bool)(acceptance_req84.rs の 24・25)
//! // src-tauri/src/theme.rs: settings_announce_needed(prev, next, true)
//! // .github/workflows/release.yml の Release-channel smoke: 確かめる名前は ['ai_marks'] だけ
//! ```
//!
//! ## 修正前に赤になる理由
//! - `REGISTRY` に `editor_inline`・`editor_file` があり、menu.rs に Edit ▸ Edit と `.remove(`・`is_enabled(` が残り、`save_document` の最初の文が
//!   `require_any(`、Settings… に `open_path(` の枝がある

use std::path::PathBuf;
use std::str::FromStr;

use muda::accelerator::Accelerator;
use vellis_lib::features::{is_enabled, resolve_by_name, AI_MARKS, REGISTRY};
use vellis_lib::channel::Channel;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}
fn read_source(rel: &str) -> String {
    let path = manifest_dir().join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{} must be readable: {e}", path.display()))
}
fn strip_line_comments(src: &str) -> String {
    src.lines()
        .map(|line| {
            if let Some(at) = line.find("//") {
                if line[..at].matches('"').count() % 2 == 0 && !line[..at].contains("http") {
                    return &line[..at];
                }
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}
fn menu_rs_code() -> String {
    strip_line_comments(&read_source("src/menu.rs"))
}
fn lib_rs_code() -> String {
    strip_line_comments(&read_source("src/lib.rs"))
}
fn features_rs_code() -> String {
    strip_line_comments(&read_source("src/features/mod.rs"))
}
fn document_rs_code() -> String {
    strip_line_comments(&read_source("src/commands/document.rs"))
}
fn theme_rs_code() -> String {
    strip_line_comments(&read_source("src/theme.rs"))
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
fn fn_body(code: &str, name: &str) -> String {
    let start = fn_decl_start(code, name).unwrap_or_else(|| panic!("source must define `fn {name}(`"));
    let params_open = code[start..].find('(').expect("fn must take parameters") + start;
    let params_close = matching_close(code, params_open);
    let open = code[params_close..].find('{').expect("fn must have a body") + params_close;
    let close = matching_close(code, open);
    code[open + 1..close].to_string()
}
fn first_statement(code: &str, name: &str) -> String {
    let body = fn_body(code, name);
    let end = body.find(';').map(|i| i + 1).unwrap_or(body.len());
    body[..end].split_whitespace().collect::<Vec<_>>().join(" ")
}
fn string_literals(code: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_str = false;
    let mut chars = code.chars();
    while let Some(c) = chars.next() {
        if in_str {
            match c {
                '\\' => {
                    cur.push(c);
                    if let Some(next) = chars.next() {
                        cur.push(next);
                    }
                }
                '"' => {
                    out.push(std::mem::take(&mut cur));
                    in_str = false;
                }
                _ => cur.push(c),
            }
        } else if c == '"' {
            in_str = true;
        }
    }
    out
}

// ---------------------------------------------------------------------------
// AC-74-46 — フラグの撤去
// ---------------------------------------------------------------------------

/// 1. `REGISTRY` は `ai_marks` だけ。`editor_inline` / `editor_file` は知らない名前(どの組でも偽)。
#[test]
fn ac74_46_registry_holds_ai_marks_alone() {
    let names: Vec<&str> = REGISTRY.iter().map(|f| f.name).collect();
    assert_eq!(names, vec![AI_MARKS]);
    for name in ["editor_inline", "editor_file"] {
        for channel in [Channel::Dev, Channel::Release] {
            for compiled in [false, true] {
                assert!(!resolve_by_name(name, channel, compiled, &[name], false), "{name} is gone ({channel:?}, compiled={compiled})");
            }
        }
        assert!(!is_enabled(name), "{name} is never enabled in this build");
    }
}

/// 2. `features/mod.rs` に `EDITOR_INLINE` / `EDITOR_FILE` の定数が無く、`"editor_inline"` / `"editor_file"` の文字列も REGISTRY の近くに無い
///    (単体テストの中の見本 `editor_inline` は許す=`#[cfg(test)]` より前の部分だけを見る)。
#[test]
fn ac74_46_features_rs_has_no_editing_flag_constants() {
    let code = features_rs_code();
    let product = code.split("#[cfg(test)]").next().unwrap_or(&code).to_string();
    assert!(!product.contains("pub const EDITOR_INLINE"), "EDITOR_INLINE is removed (#811)");
    assert!(!product.contains("pub const EDITOR_FILE"), "EDITOR_FILE is removed (#820)");
    assert!(!product.contains("\"editor_inline\"") && !product.contains("\"editor_file\""), "no editing flag name in the registry: {product}");
    assert!(product.contains("pub const AI_MARKS"), "ai_marks stays");
}

/// 3. `menu::build` はフラグを見ない(`.remove(` も `is_enabled(` も無い)。Save・Format・Raw Source は常に作られる。
#[test]
fn ac74_46_menu_builds_save_format_and_raw_source_unconditionally() {
    let code = menu_rs_code();
    let body = fn_body(&code, "build");
    assert!(!body.contains(".remove("), "build removes nothing: {body}");
    assert!(!body.contains("is_enabled("), "build reads no flag: {body}");
    assert!(!code.contains("EDITOR_INLINE") && !code.contains("EDITOR_FILE"), "menu.rs names no editing flag");
    for binding in ["save_item", "format_menu", "raw_source_item"] {
        assert!(body.contains(binding), "build still creates {binding}");
    }
    assert_eq!(code.matches(".remove(").count(), 1, "the only .remove( is rebuild_theme_items'");
}

/// 4. `save_document` に門が無い(最初の文は `require` でない・本文に `require_any(` / `EDITOR_*` が無い)。照合は残る。
#[test]
fn ac74_46_save_document_has_no_gate() {
    let code = document_rs_code();
    let first = first_statement(&code, "save_document");
    assert!(!first.contains("require"), "no gate as the first statement: `{first}`");
    let body = fn_body(&code, "save_document");
    assert!(!body.contains("require_any(") && !body.contains("require(") && !body.contains("EDITOR_INLINE") && !body.contains("EDITOR_FILE"), "{body}");
    assert!(body.contains("check_expected_hash("), "契約14 の照合は残る");
    assert!(body.contains("take_snapshot(") && body.contains("write_text_within_root("), "写しと書き込みは残る");
}

/// 5. タグの CI(release.yml の Release-channel smoke)の確かめる名前の一覧に `editor_inline` が無く、`ai_marks` はある。
#[test]
fn ac74_46_release_smoke_names_only_ai_marks() {
    let yml = read_source("../.github/workflows/release.yml");
    let start = yml.find("Release-channel smoke").expect("release.yml keeps the Release-channel smoke step");
    let step = &yml[start..];
    let end = step.find("\n      - name: ").unwrap_or(step.len());
    let step = &step[..end];
    let check: Vec<&str> = step
        .lines()
        .filter(|l| !l.trim_start().starts_with('#') && !l.trim_start().starts_with("echo") && l.contains("--print-build-info") && l.contains("flags"))
        .collect();
    assert!(!check.is_empty(), "the smoke still reads --print-build-info's flags: {step}");
    for l in &check {
        assert!(l.contains("ai_marks"), "the check names ai_marks: {l}");
        assert!(!l.contains("editor_inline"), "editor_inline is gone from the check (AC-74-46): {l}");
    }
}

/// 6. `scripts/e2e.sh` は dev-features のまま(`ai_marks` の E2E のため=要件84 契約10)。
#[test]
fn ac74_46_e2e_build_keeps_dev_features() {
    let sh = read_source("../scripts/e2e.sh");
    assert!(sh.contains("dev-features"), "scripts/e2e.sh keeps dev-features for the ai_marks E2E");
}

// ---------------------------------------------------------------------------
// AC-74-25 — Edit ▸ Edit の撤去(Rust の分)
// ---------------------------------------------------------------------------

/// 7. `menu.rs` に `EDIT_ITEM_ID`・`MENU_EDIT_EVENT`・`EDIT_ACCELERATOR`・`edit_mode_item` が無い。`lib.rs` の `on_menu_event` に Edit の腕が無い。
#[test]
fn ac74_25_edit_menu_item_is_gone() {
    let menu = menu_rs_code();
    for needle in ["EDIT_ITEM_ID", "MENU_EDIT_EVENT", "EDIT_ACCELERATOR", "edit_mode_item", "\"menu_edit\""] {
        assert!(!menu.contains(needle), "menu.rs must not contain {needle} (AC-74-25・(ad))");
    }
    let lib = lib_rs_code();
    assert!(!lib.contains("EDIT_ITEM_ID") && !lib.contains("MENU_EDIT_EVENT"), "lib.rs has no Edit ▸ Edit arm");
    // Edit メニューの並び: 標準の組・区切り線・Find…・Find and Replace…(第3段 3-3)・Find in Folder…(Edit ▸ Edit 無し)
    let at = menu.find("Submenu::with_items(\n        app,\n        \"Edit\"").or_else(|| menu.find("\"Edit\"")).expect("an Edit submenu");
    let slice_open = menu[at..].find("&[").expect("Edit takes a slice") + at + 1;
    let slice_close = matching_close(&menu, slice_open);
    let idents: Vec<&str> = menu[slice_open + 1..slice_close].split(',').map(|s| s.trim().trim_start_matches('&')).filter(|s| !s.is_empty()).collect();
    // 第3段 3-3(3-12): Find… の直後に Find and Replace…
    assert_eq!(idents, ["undo", "redo", "edit_sep", "cut", "copy", "paste", "select_all", "edit_mode_sep", "find_item", "find_replace_item", "find_in_folder_item"]);
}

/// 8. Command + E(`CmdOrCtrl+E`)はどのアクセラレータにも登録されない(撤去で空く)。
#[test]
fn ac74_25_command_e_is_no_longer_registered() {
    let cmd_e = Accelerator::from_str("CmdOrCtrl+E").unwrap();
    let registered: Vec<String> = string_literals(&menu_rs_code())
        .into_iter()
        .filter(|s| s.contains('+'))
        .filter(|s| Accelerator::from_str(s).ok().is_some_and(|a| a == cmd_e))
        .collect();
    assert!(registered.is_empty(), "CmdOrCtrl+E must not be registered after the removal round: {registered:?}");
}

// ---------------------------------------------------------------------------
// AC-74-43 — Settings… / Export Default Theme… は Vellis の窓
// ---------------------------------------------------------------------------

/// 9. 2 つの handler は `create_window(` だけで、`open_path(` と `is_enabled(` が無い。`theme.rs` の知らせの条件は `true`。
#[test]
fn ac74_43_settings_and_export_open_a_vellis_window() {
    let menu = menu_rs_code();
    for name in ["handle_settings_click", "handle_export_default_theme_click"] {
        let body = fn_body(&menu, name);
        assert!(body.contains("create_window("), "{name} opens a Vellis window: {body}");
        assert!(!body.contains("open_path("), "{name} has no default-app branch: {body}");
        assert!(!body.contains("is_enabled(") && !body.contains("EDITOR_INLINE"), "{name} decides nothing by a flag: {body}");
    }
    let theme = theme_rs_code();
    let at = theme.find("settings_announce_needed(").filter(|&i| !theme[..i].ends_with("pub fn ")).or_else(|| {
        theme.match_indices("settings_announce_needed(").map(|(i, _)| i).find(|&i| !theme[..i].trim_end().ends_with("pub fn"))
    });
    let at = at.expect("theme.rs still calls settings_announce_needed(");
    let close = matching_close(&theme, at + "settings_announce_needed".len());
    let call: String = theme[at..=close].chars().filter(|c| !c.is_whitespace()).collect();
    assert!(call.ends_with(",true)"), "edit_enabled is always true (the editor always exists): {call}");
    assert!(!theme.contains("EDITOR_INLINE"), "theme.rs names no editing flag");
}
