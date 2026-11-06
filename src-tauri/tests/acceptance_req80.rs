//! 要件#80 の受け入れテスト(docs/requirements/req-80.md)— Rust 層のソース走査
//! (AC-80-1〜5=契約 1・2・3・13。メニューの定数・View の並び・配線・アクセラレータ・フロントとの一致)
//!
//! 「開いているファイルを読み直す Reload File を、View メニューと右クリックメニューから実行できる
//! ようにし、ツリーも一緒に読み直す。フォルダの行とツリーの空白の右クリックには Reload Folder を置く」
//! のうち、`src-tauri` に足すもの(View ▸ Reload File と `on_menu_event` の腕)を**ソースをテキストとして
//! 読んで**判定する。定数も `pub const … = "…"` の字面で読む(acceptance_req56.rs と同じ作り)ので、
//! 実装前でもこのファイル自体はコンパイルでき、落ちるのはアサートの側=赤の理由が読める。
//!
//! 判定範囲:
//! - AC-80-1 定数(契約 1・2)【(a)(b) 決定】: `RELOAD_FILE_ITEM_ID == "reload-file"`・
//!   `MENU_RELOAD_FILE_EVENT == "menu_reload_file"`・`RELOAD_FILE_ACCELERATOR == "CmdOrCtrl+R"`。
//!   `Accelerator::from_str(RELOAD_FILE_ACCELERATOR)` が Ok
//! - AC-80-2 View の並び(契約 2)【(r) 決定】: 13 項目(束縛名まで一致)。`view_reload_sep` は区切り線の束縛。
//!   `reload_file_item` は `MenuItem::with_id` に定数・`"Reload File"`・`true`・`Some(RELOAD_FILE_ACCELERATOR)`
//!   を渡して作る。`"Reload File"` の字面は menu.rs のコードの中に 1 回だけ。ほかのメニューと Appearance は
//!   `reload_file_item` も `RELOAD_FILE_ITEM_ID` も持たない。`"Reload Folder"` の字面は menu.rs に無い
//! - AC-80-3 配線(契約 2): `lib.rs` の `on_menu_event` に `menu::RELOAD_FILE_ITEM_ID` の腕があり、
//!   `menu::handle_menu_open_click(app_handle, menu::MENU_RELOAD_FILE_EVENT)` を呼ぶ
//! - AC-80-4 アクセラレータの衝突なし(契約 2): `+` を含み parse できる字面のうち Command + R と同じ組み合わせが
//!   ちょうど 1 つ。`RECENT_FILES_ACCELERATOR`(Command + Shift + R)とは別。重複なし
//! - AC-80-5 フロントとの一致(契約 1・3・13): `src/lib/reload-file.ts` の `MENU_RELOAD_FILE_EVENT` と
//!   `RELOAD_FILE_LABEL` が Rust の値と一致する(`acceptance_req66.rs` の `ts_string_const` と同じ作法)。
//!   command の本数(38 / 37)は `acceptance_req66.rs` の `tauri_commands_are_not_added` と
//!   `go-to-path.acceptance.test.ts` の AC-60-20 が無改変で固定する(ここでは重ねて数えない)
//!
//! 人間ゲート 1(ネイティブのメニューの見え方と Command + R の効き)は判定しない。
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前)
//!
//! ```ignore
//! // --- src-tauri/src/menu.rs — 既存の *_ITEM_ID / MENU_*_EVENT / *_ACCELERATOR と同じ家風
//! pub const RELOAD_FILE_ITEM_ID: &str = "reload-file";
//! pub const MENU_RELOAD_FILE_EVENT: &str = "menu_reload_file";
//! pub const RELOAD_FILE_ACCELERATOR: &str = "CmdOrCtrl+R";
//! // View の組み立て(Show All Tabs の区切りの直後・Appearance の上=13 項目)
//! let reload_file_item = MenuItem::with_id(app, RELOAD_FILE_ITEM_ID, "Reload File", true, Some(RELOAD_FILE_ACCELERATOR))?;
//! let view_reload_sep = PredefinedMenuItem::separator(app)?;
//! // &[&show_tab_bar_item, &show_all_tabs_item, &view_tab_sep, &reload_file_item, &view_reload_sep,
//! //   &appearance_menu, &toggle_full_width_item, &view_chrome_sep, &zoom_in_item, &zoom_out_item,
//! //   &actual_size_item, &view_sep, &toggle_devtools]
//!
//! // --- src-tauri/src/lib.rs の on_menu_event
//! id if id == menu::RELOAD_FILE_ITEM_ID => {
//!     menu::handle_menu_open_click(app_handle, menu::MENU_RELOAD_FILE_EVENT);
//! }
//!
//! // --- src/lib/reload-file.ts(新規・フロント側の正本は reload-file.acceptance.test.ts)
//! export const MENU_RELOAD_FILE_EVENT = 'menu_reload_file';
//! export const RELOAD_FILE_LABEL = 'Reload File';
//! ```
//!
//! ソース走査が前提にする形(既存コードの家風・acceptance_req62a.rs / req63.rs / req56.rs と同じ読み方):
//! - MenuItem は `let <binding> = MenuItem::with_id(app, <ID 定数>, "<ラベル>", true, Some(<ACCELERATOR 定数>))?;`
//!   で束縛する(ID・アクセラレータはインラインの字面ではなく定数)
//! - 区切り線は `let <binding> = PredefinedMenuItem::separator(app)?;` で束縛する
//! - View は `Submenu::with_items(app, "View", true, &[…])?` のまま(上記 13 項目の順)
//! - `lib.rs` の `on_menu_event` の分岐は `id if id == menu::<ID 定数> => { … }` の形
//! - menu.rs のコード行に CJK を書かない(acceptance_req35.rs の走査=要件#51)

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::str::FromStr;

use muda::accelerator::Accelerator;
use vellis_lib::menu::RECENT_FILES_ACCELERATOR;

// ---------------------------------------------------------------------------
// 共通ヘルパ — acceptance_req62a.rs / req56.rs と同じ流儀(コメント落とし・括弧の対応)
// ---------------------------------------------------------------------------

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// 無いファイルは空文字(=その上のアサートが赤になる。`include_str!` と違ってコンパイルは止めない)。
fn read_source_or_empty(rel: &str) -> String {
    std::fs::read_to_string(manifest_dir().join(rel)).unwrap_or_default()
}

/// 行ごとに `//` 以降(コメント)を落としたコード部分を連結して返す。`://` は落とさない。
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

fn lib_rs_code() -> String {
    strip_line_comments(include_str!("../src/lib.rs"))
}

/// `src/lib/reload-file.ts`(フロントの正本)。無ければ空=AC-80-5 が赤になる。
fn reload_file_ts() -> String {
    read_source_or_empty("../src/lib/reload-file.ts")
}

/// `open` の位置の開き括弧に対応する閉じ括弧の位置(`(`/`[`/`{` を同じ深さで数える)。
fn matching_close(code: &str, open: usize) -> usize {
    let mut depth = 0usize;
    for (i, c) in code[open..].char_indices() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => {
                depth -= 1;
                if depth == 0 {
                    return open + i;
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced bracket starting at byte {open}");
}

/// `start` から、最初の `(` に対応する閉じ括弧までの呼び出し全体。
fn balanced_call(code: &str, start: usize) -> &str {
    let open = code[start..].find('(').expect("call must have '('") + start;
    let close = matching_close(code, open);
    &code[start..=close]
}

/// 呼び出しテキスト中の最初の二重引用符リテラルの中身。
fn first_string_literal(s: &str) -> Option<&str> {
    let a = s.find('"')? + 1;
    let b = s[a..].find('"')? + a;
    Some(&s[a..b])
}

/// 呼び出し `f(a, b, …)` の最後の引数(前後の空白を落としたテキスト)。
fn last_argument(call: &str) -> &str {
    let open = call.find('(').expect("call must have '('");
    let inner = &call[open + 1..call.len() - 1];
    inner
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .last()
        .expect("call must have an argument")
}

/// 呼び出し `f(a, b, …)` の引数列(前後の空白を落としたテキスト)。
fn arguments(call: &str) -> Vec<&str> {
    let open = call.find('(').expect("call must have '('");
    let inner = &call[open + 1..call.len() - 1];
    inner.split(',').map(str::trim).filter(|s| !s.is_empty()).collect()
}

/// ラベルが `label` の `Submenu::with_…` 呼び出し全体(with_items / with_id_and_items のどちらも)。
fn submenu_call_with_label<'a>(code: &'a str, label: &str) -> Option<&'a str> {
    let mut search = 0;
    while let Some(rel) = code[search..].find("Submenu::with_") {
        let start = search + rel;
        let call = balanced_call(code, start);
        search = start + "Submenu::with_".len();
        if first_string_literal(call) == Some(label) {
            return Some(call);
        }
    }
    None
}

/// すべての `Submenu::with_…` 呼び出し(ラベル, 呼び出し全体)。
fn all_submenu_calls(code: &str) -> Vec<(&str, &str)> {
    let mut out = Vec::new();
    let mut search = 0;
    while let Some(rel) = code[search..].find("Submenu::with_") {
        let start = search + rel;
        let call = balanced_call(code, start);
        search = start + "Submenu::with_".len();
        out.push((first_string_literal(call).unwrap_or(""), call));
    }
    out
}

/// Submenu 呼び出しの項目スライス `&[&a, &b, …]` の識別子列(`&` を剥がした順)。
fn submenu_item_idents(call: &str) -> Vec<&str> {
    let slice_open = call.find("&[").expect("submenu must take an item slice");
    let slice_end = matching_close(call, slice_open + 1);
    call[slice_open + 2..slice_end]
        .split(',')
        .map(|s| s.trim().trim_start_matches('&'))
        .filter(|s| !s.is_empty())
        .collect()
}

/// `const_name` を引数に取る `MenuItem::with_id(` 呼び出し全体。
fn menu_item_call_using<'a>(code: &'a str, const_name: &str) -> Option<&'a str> {
    let mut search = 0;
    while let Some(rel) = code[search..].find("MenuItem::with_id(") {
        let start = search + rel;
        let call = balanced_call(code, start);
        search = start + "MenuItem::with_id(".len();
        if call.contains(const_name) {
            return Some(call);
        }
    }
    None
}

/// `use_pos`(式の先頭)を右辺に持つ `let <binding> = …` の binding 名。
fn let_binding_before<'a>(code: &'a str, use_pos: usize, what: &str) -> &'a str {
    let let_pos = code[..use_pos]
        .rfind("let ")
        .unwrap_or_else(|| panic!("{what} must be used inside a let binding"));
    code[let_pos + 4..use_pos]
        .split(|c: char| c == '=' || c.is_whitespace())
        .find(|s| !s.is_empty())
        .expect("binding name after `let`")
}

/// `let <binding> = PredefinedMenuItem::separator(` で束縛された区切り線の名前の集合。
fn separator_bindings(code: &str) -> BTreeSet<&str> {
    code.match_indices("PredefinedMenuItem::separator(")
        .map(|(pos, _)| let_binding_before(code, pos, "PredefinedMenuItem::separator"))
        .collect()
}

/// `pub const <name>: &str = "<value>";` の value。
fn str_const<'a>(code: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("pub const {name}: &str = \"");
    let start = code.find(&needle)? + needle.len();
    let end = code[start..].find('"')? + start;
    Some(&code[start..end])
}

/// `lib.rs` の `on_menu_event(|app_handle, event| match … { … })` の本体。
fn on_menu_event_block(code: &str) -> &str {
    let start = code.find("on_menu_event(").expect("lib.rs must call on_menu_event");
    balanced_call(code, start)
}

/// `on_menu_event` の中で `menu::<const_name>` を条件に持つ分岐の本体(`=> { … }`)。
fn menu_arm_body<'a>(block: &'a str, const_name: &str) -> &'a str {
    let needle = format!("menu::{const_name}");
    let pos = block
        .find(&needle)
        .unwrap_or_else(|| panic!("on_menu_event must dispatch menu::{const_name}"));
    let arrow = block[pos..].find("=>").expect("match arm must have =>") + pos;
    let open = block[arrow..].find('{').expect("arm body must be a block") + arrow;
    let close = matching_close(block, open);
    &block[open..=close]
}

/// menu.rs のコード部分から二重引用符の文字列リテラルを取り出す(acceptance_req60.rs の写し)。
fn menu_rs_string_literals(code: &str) -> Vec<String> {
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

/// `export const NAME = '…'` の文字列リテラルの中身(`'` / `"` / `` ` `` のどれでも)=acceptance_req66.rs の写し。
fn ts_string_const(src: &str, name: &str) -> String {
    let marker = format!("export const {name}");
    let at = src
        .find(&marker)
        .unwrap_or_else(|| panic!("src/lib/reload-file.ts must `{marker}` (AC-80-5)"));
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

/// 空白を全部落とす(呼び出しの字面を改行・インデントに左右されずに比べる)。
fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

const EXPECTED_VIEW: [&str; 13] = [
    "show_tab_bar_item",
    "show_all_tabs_item",
    "view_tab_sep",
    "reload_file_item",
    "view_reload_sep",
    "appearance_menu",
    "toggle_full_width_item",
    "view_chrome_sep",
    "zoom_in_item",
    "zoom_out_item",
    "actual_size_item",
    "view_sep",
    "toggle_devtools",
];

// ---------------------------------------------------------------------------
// AC-80-1 — 定数(契約 1・2)【(a)(b) 決定】
// ---------------------------------------------------------------------------

/// 1. 3 つの定数は値固定(ID・イベント名・アクセラレータ)。
#[test]
fn reload_file_constants_are_fixed() {
    let code = menu_rs_code();
    assert_eq!(
        str_const(&code, "RELOAD_FILE_ITEM_ID"),
        Some("reload-file"),
        "menu.rs must declare `pub const RELOAD_FILE_ITEM_ID: &str = \"reload-file\";`"
    );
    assert_eq!(
        str_const(&code, "MENU_RELOAD_FILE_EVENT"),
        Some("menu_reload_file"),
        "menu.rs must declare `pub const MENU_RELOAD_FILE_EVENT: &str = \"menu_reload_file\";`"
    );
    assert_eq!(
        str_const(&code, "RELOAD_FILE_ACCELERATOR"),
        Some("CmdOrCtrl+R"),
        "menu.rs must declare `pub const RELOAD_FILE_ACCELERATOR: &str = \"CmdOrCtrl+R\";`"
    );
}

/// 2. アクセラレータは muda が parse できる綴りで、Command + R そのもの(要件#36 の教訓=parse できない
///    綴りは黙って捨てられる)。Command + Shift + R(Recent Files)とは別の組み合わせ。
#[test]
fn reload_file_accelerator_parses_as_command_r() {
    let code = menu_rs_code();
    let raw = str_const(&code, "RELOAD_FILE_ACCELERATOR")
        .expect("menu.rs must declare RELOAD_FILE_ACCELERATOR (AC-80-1)");
    let parsed = Accelerator::from_str(raw)
        .unwrap_or_else(|e| panic!("RELOAD_FILE_ACCELERATOR {raw:?} must parse as an Accelerator: {e}"));
    assert_eq!(
        parsed,
        Accelerator::from_str("CmdOrCtrl+R").expect("CmdOrCtrl+R parses"),
        "RELOAD_FILE_ACCELERATOR must be Command + R"
    );
    assert_ne!(
        parsed,
        Accelerator::from_str(RECENT_FILES_ACCELERATOR).expect("RECENT_FILES_ACCELERATOR parses"),
        "Command + R must differ from Recent Files (Command + Shift + R)"
    );
}

// ---------------------------------------------------------------------------
// AC-80-2 — View の並び(契約 2・ソース走査)【(r) 決定】
// ---------------------------------------------------------------------------

/// 3. View = Show Tab Bar / Show All Tabs / ─ / **Reload File / ─** / Appearance ▸ / Toggle Full Width / ─ /
///    Zoom In / Zoom Out / Actual Size / ─ / Toggle Developer Tools(13 項目・束縛名まで一致)。
#[test]
fn view_menu_holds_reload_file_and_its_separator_right_after_the_tab_items() {
    let code = menu_rs_code();
    let view = submenu_call_with_label(&code, "View").expect("menu.rs must build a \"View\" submenu");
    let idents = submenu_item_idents(view);
    assert_eq!(
        idents, EXPECTED_VIEW,
        "the View menu must hold exactly these 13 entries in this order (requirement #80 契約 2, (r)): found {idents:?}"
    );
    let separators = separator_bindings(&code);
    for sep in ["view_tab_sep", "view_reload_sep", "view_chrome_sep", "view_sep"] {
        assert!(
            separators.contains(sep),
            "`{sep}` must be a `PredefinedMenuItem::separator` binding (separators: {separators:?})"
        );
    }
}

/// 4. `reload_file_item` は `MenuItem::with_id(app, RELOAD_FILE_ITEM_ID, "Reload File", true, Some(RELOAD_FILE_ACCELERATOR))`
///    で作る(ID・アクセラレータは定数。インラインの字面ではない)。
#[test]
fn reload_file_item_is_built_from_the_constants_with_the_english_label() {
    let code = menu_rs_code();
    let call = menu_item_call_using(&code, "RELOAD_FILE_ITEM_ID")
        .expect("menu.rs must build a MenuItem::with_id(... RELOAD_FILE_ITEM_ID ...)");
    let use_pos = call.as_ptr() as usize - code.as_ptr() as usize;
    let binding = let_binding_before(&code, use_pos, "RELOAD_FILE_ITEM_ID");
    assert_eq!(binding, "reload_file_item", "the Reload File item must be bound as `reload_file_item`");

    let args = arguments(call);
    assert_eq!(args.len(), 5, "MenuItem::with_id takes 5 arguments: {call}");
    assert_eq!(args[1], "RELOAD_FILE_ITEM_ID", "the ID must be the constant, not an inline literal: {call}");
    assert_eq!(first_string_literal(call), Some("Reload File"), "the label must be \"Reload File\": {call}");
    assert_eq!(args[2], "\"Reload File\"", "the label is the 3rd argument: {call}");
    assert_eq!(args[3], "true", "the item is always enabled (契約 2): {call}");
    assert_eq!(
        last_argument(call),
        "Some(RELOAD_FILE_ACCELERATOR)",
        "the accelerator must be passed as Some(RELOAD_FILE_ACCELERATOR): {call}"
    );
    assert!(
        !call.contains("\"reload-file\"") && !call.contains("\"CmdOrCtrl+R\""),
        "no inline ID / accelerator literal in the item call: {call}"
    );
}

/// 5. `"Reload File"` の字面は menu.rs のコードの中に 1 回だけ(項目のラベル)。`"Reload Folder"` は無い
///    (Reload Folder はネイティブのメニューに置かない=契約 14)。
#[test]
fn reload_labels_appear_only_where_the_contract_says() {
    let code = menu_rs_code();
    let literals = menu_rs_string_literals(&code);
    let reload_file = literals.iter().filter(|s| s.as_str() == "Reload File").count();
    assert_eq!(reload_file, 1, "\"Reload File\" must appear exactly once in menu.rs code (found {reload_file})");
    let reload_folder = literals.iter().filter(|s| s.as_str() == "Reload Folder").count();
    assert_eq!(reload_folder, 0, "\"Reload Folder\" must not appear in menu.rs (契約 14: right-click only)");
}

/// 6. ほかのメニュー(Vellis / File / Edit / Go / Window)と Appearance のサブメニューは `reload_file_item` も
///    `RELOAD_FILE_ITEM_ID` も持たない(契約 2「ほかのメニューには置かない」・契約 13)。
#[test]
fn other_menus_do_not_hold_reload_file() {
    let code = menu_rs_code();
    let calls = all_submenu_calls(&code);
    let labels: Vec<&str> = calls.iter().map(|(l, _)| *l).collect();
    for expected in ["Vellis", "File", "Edit", "View", "Go", "Window", "Appearance"] {
        assert!(labels.contains(&expected), "menu.rs must build a submenu labelled {expected:?} (found {labels:?})");
    }
    for (label, call) in calls {
        let idents = submenu_item_idents(call);
        if label == "View" {
            assert!(
                idents.contains(&"reload_file_item"),
                "the View submenu is the one place that holds reload_file_item ({idents:?})"
            );
            continue;
        }
        assert!(
            !idents.contains(&"reload_file_item"),
            "the {label:?} submenu must not hold reload_file_item ({idents:?})"
        );
        assert!(
            !call.contains("RELOAD_FILE_ITEM_ID"),
            "the {label:?} submenu must not mention RELOAD_FILE_ITEM_ID"
        );
    }
}

// ---------------------------------------------------------------------------
// AC-80-3 — 配線(契約 2・ソース走査)
// ---------------------------------------------------------------------------

/// 7. `lib.rs` の `on_menu_event` に `menu::RELOAD_FILE_ITEM_ID` の腕があり、
///    `menu::handle_menu_open_click(app_handle, menu::MENU_RELOAD_FILE_EVENT)` を呼ぶ(前面の文書の窓へ `emit_to`)。
#[test]
fn lib_rs_dispatches_reload_file_to_the_focused_document_window() {
    let lib = lib_rs_code();
    let block = on_menu_event_block(&lib);
    let body = menu_arm_body(block, "RELOAD_FILE_ITEM_ID");
    assert!(
        squash(body).contains("menu::handle_menu_open_click(app_handle,menu::MENU_RELOAD_FILE_EVENT)"),
        "the RELOAD_FILE_ITEM_ID arm must call menu::handle_menu_open_click(app_handle, menu::MENU_RELOAD_FILE_EVENT) ({body})"
    );
    assert_eq!(
        block.matches("menu::RELOAD_FILE_ITEM_ID").count(),
        1,
        "on_menu_event must dispatch RELOAD_FILE_ITEM_ID exactly once"
    );
}

// ---------------------------------------------------------------------------
// AC-80-4 — アクセラレータの衝突なし(契約 2)
// ---------------------------------------------------------------------------

/// 8. menu.rs のアクセラレータの字面(`+` を含み parse できるもの)のうち、Command + R と同じ組み合わせは
///    ちょうど 1 つ。Command + Shift + R(Recent Files)とは別。全体に重複が無い(AC-60-19 と同じ走査)。
#[test]
fn command_r_is_registered_exactly_once_and_does_not_collide() {
    let code = menu_rs_code();
    let parsed: Vec<(String, Accelerator)> = menu_rs_string_literals(&code)
        .into_iter()
        .filter(|s| s.contains('+'))
        .filter_map(|s| Accelerator::from_str(&s).ok().map(|a| (s, a)))
        .collect();

    let command_r = Accelerator::from_str("CmdOrCtrl+R").expect("CmdOrCtrl+R parses");
    let command_r_count = parsed.iter().filter(|(_, a)| *a == command_r).count();
    assert_eq!(
        command_r_count, 1,
        "menu.rs must register Command + R exactly once (found {command_r_count}; literals: {:?})",
        parsed.iter().map(|(s, _)| s).collect::<Vec<_>>()
    );

    let recent = Accelerator::from_str(RECENT_FILES_ACCELERATOR).expect("RECENT_FILES_ACCELERATOR parses");
    assert_ne!(command_r, recent, "Command + R must not equal Recent Files' Command + Shift + R");

    for (i, (raw_a, acc_a)) in parsed.iter().enumerate() {
        for (raw_b, acc_b) in parsed.iter().skip(i + 1) {
            assert!(
                acc_a != acc_b,
                "duplicate accelerator in menu.rs: '{raw_a}' collides with '{raw_b}'"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// AC-80-5 — フロントとの一致(契約 1・3・13)
// ---------------------------------------------------------------------------

/// 9. `src/lib/reload-file.ts` の `MENU_RELOAD_FILE_EVENT` は Rust の `MENU_RELOAD_FILE_EVENT` と同じ値。
#[test]
fn front_end_event_name_matches_menu_rs() {
    let ts = reload_file_ts();
    assert!(!ts.is_empty(), "src/lib/reload-file.ts must exist (契約 1・3)");
    let front = ts_string_const(&ts, "MENU_RELOAD_FILE_EVENT");
    let code = menu_rs_code();
    let rust = str_const(&code, "MENU_RELOAD_FILE_EVENT")
        .expect("menu.rs must declare MENU_RELOAD_FILE_EVENT (AC-80-1)");
    assert_eq!(front, rust, "reload-file.ts MENU_RELOAD_FILE_EVENT must equal menu.rs MENU_RELOAD_FILE_EVENT");
    assert_eq!(front, "menu_reload_file");
}

/// 10. `src/lib/reload-file.ts` の `RELOAD_FILE_LABEL` は menu.rs の項目のラベル `"Reload File"` と同じ字面
///     (3 つの入口で同じ名前=契約 1)。
#[test]
fn front_end_label_matches_the_menu_item_label() {
    let ts = reload_file_ts();
    assert!(!ts.is_empty(), "src/lib/reload-file.ts must exist (契約 1・3)");
    let front = ts_string_const(&ts, "RELOAD_FILE_LABEL");
    let code = menu_rs_code();
    let call = menu_item_call_using(&code, "RELOAD_FILE_ITEM_ID")
        .expect("menu.rs must build a MenuItem::with_id(... RELOAD_FILE_ITEM_ID ...)");
    let rust_label = first_string_literal(call).expect("the item call has a label literal");
    assert_eq!(front, rust_label, "RELOAD_FILE_LABEL must equal the View item's label");
    assert_eq!(front, "Reload File");
}
