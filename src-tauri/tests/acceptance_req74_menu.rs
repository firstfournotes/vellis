//! 要件#74 第2段 2-3 — Format メニューと View ▸ Raw Source(AC-74-7・契約8・契約23・項目 9・10)。
//!
//! **仮の前提(2026-11-17・由谷の確認待ち=第2段の準備で出た判断)**: 判断 4=Format メニューは準備 (B) の項目 10 の表どおり
//! (Bold〜Link… / Body Text・Heading 1〜6 / Bulleted〜Code Block・Alert ▸ / Increase・Decrease Indent / Insert ▸ / Clear Formatting・
//! 区切り線 5 本)・判断 9=Raw Source のチェック印はフロントからのイベント `raw_source_state` で前面の窓の値を Rust に知らせる
//! (Tauri command は増やさない)。回答が推奨と違えば「判断 4 に依存」「判断 9 に依存」の印のテストを書き直す。
//!
//! ## 対応する受け入れ基準
//! - AC-74-7 メニュー(契約8)(ソース走査): `menu.rs` に Format の Submenu があり、メニューバーの並びが
//!   Vellis / File / Edit / Format / View / Go / Window になる。表の各項目の ID・英語のラベル・アクセラレータの定数があり、
//!   アクセラレータが `muda::accelerator::Accelerator` として parse でき、既存のアクセラレータと重ならない
//!   (`acceptance_req60.rs` の重複検査が緑)。`lib.rs` の `on_menu_event` が各 ID を前面の窓へ送る。
//!   `editor_file` が偽のビルドでは Format と Raw Source を作らない(第2段の周回中。撤去の後は常に作る)
//! - 契約23 View ▸ Raw Source=`CheckMenuItem`(ID `raw-source`・`Raw Source`・Option + Command + U)を Toggle Full Width の直後に((ao))。
//!   チェック印は前面の窓の値(判断 9)
//!
//! ## 確定契約(implementer はこれに従う=推奨名は req-74.md 第2段の作り(案)10。無いものは test-writer が固定)
//!
//! ```text
//! // --- src-tauri/src/menu.rs
//! pub const FORMAT_ITEM_ID_PREFIX: &str = "format-";
//! pub const MENU_FORMAT_EVENT: &str = "menu_format";             // payload=項目の ID(String)。フロントの commands.ts と同じ綴り
//! pub const FORMAT_<名>_ITEM_ID: &str = "format-<kebab>";         // 34 個(下の表。第3段 3-2 で Table ▸ の 7 つ)+ FORMAT_ALERT_MENU_ID "format-alert-menu"・FORMAT_INSERT_MENU_ID "format-insert-menu"・FORMAT_TABLE_MENU_ID "format-table-menu"
//! pub const FORMAT_<名>_ACCELERATOR: &str = "CmdOrCtrl+…";       // ショートカットのある 20 個(下の表)
//! pub const RAW_SOURCE_ITEM_ID: &str = "raw-source";
//! pub const RAW_SOURCE_ACCELERATOR: &str = "CmdOrCtrl+Alt+U";
//! pub const MENU_RAW_SOURCE_EVENT: &str = "menu_raw_source";     // payload なし(handle_menu_open_click)
//! pub const RAW_SOURCE_STATE_EVENT: &str = "raw_source_state";   // フロント → Rust。payload { label, raw }(判断 9)
//! // build(): let format_menu = Submenu::with_items(app, "Format", true, &[…28 の束縛=20 項目+Alert ▸・Insert ▸・Table ▸+区切り線 5 本…])?;  Edit と View の間
//! //   第3段 3-2: let format_table_menu = Submenu::with_id_and_items(app, FORMAT_TABLE_MENU_ID, "Table", true, &[4 項目, &format_table_sep, 3 項目])?;  Insert ▸ の直後(区切り線は増やさない)
//! //   let raw_source_item = CheckMenuItem::with_id(app, RAW_SOURCE_ITEM_ID, "Raw Source", true, false, Some(RAW_SOURCE_ACCELERATOR))?;
//! //   View は 14 項目: … toggle_full_width_item, raw_source_item, view_chrome_sep, …
//! //   (2-5 の撤去の後: Format と Raw Source はフラグなしで常に作る。build に `.remove(` は無い=AC-74-46)
//! pub fn emit_to_focused<S: Serialize + Clone>(app: &AppHandle<Wry>, event: &str, payload: S);   // focused_or_first_window → emit_to
//! pub fn listen_raw_source_state(app: &AppHandle<Wry>);   // app.listen(RAW_SOURCE_STATE_EVENT, …) → payload の { label, raw } を読み、
//!                                                          // 前面の窓の label と同じなら raw_source_item.set_checked(raw)
//! pub fn raw_check_applies(front: Option<&str>, label: &str) -> bool;   // = front == Some(label)(M2・第1段の check_expected_hash の家風=
//!                                                          // 判定を純関数に出す)。listen_raw_source_state は `if !raw_check_applies(…) { return; }` を set_checked の前に
//! // --- src-tauri/src/lib.rs の on_menu_event
//! //   id if id.starts_with(menu::FORMAT_ITEM_ID_PREFIX) => menu::emit_to_focused(app_handle, menu::MENU_FORMAT_EVENT, id.to_string())
//! //   id if id == menu::RAW_SOURCE_ITEM_ID => menu::handle_menu_open_click(app_handle, menu::MENU_RAW_SOURCE_EVENT)
//! //   setup で menu::listen_raw_source_state(app.handle()) を 1 回
//! ```
//!
//! ## 修正前に赤になる理由
//! - `vellis_lib::menu` に FORMAT_* / RAW_SOURCE_* の定数が無いのでコンパイルで落ちる(=このバイナリ全体が赤)
//!
//! ## 既存テストの書き換え(棚卸し 3=承認済みの範囲)
//! - View の 13 項目の 4 本(acceptance_req56 / 62a / 63 / 80)に `raw_source_item` を [7] に足して 14 項目に
//! - メニューバー(acceptance_req60 / 83)に Format を Edit と View の間に
//! - acceptance_req84 の `ac84_4_no_other_menu_item_is_removed`・acceptance_req74 の AC-74-40 の `.remove(` の数(3 → 5・4 → 6)

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::str::FromStr;

use muda::accelerator::Accelerator;
use vellis_lib::menu::{
    FORMAT_ALERT_CAUTION_ITEM_ID, FORMAT_ALERT_IMPORTANT_ITEM_ID, FORMAT_ALERT_MENU_ID, FORMAT_ALERT_NOTE_ITEM_ID,
    FORMAT_ALERT_TIP_ITEM_ID, FORMAT_ALERT_WARNING_ITEM_ID, FORMAT_BODY_TEXT_ACCELERATOR, FORMAT_BODY_TEXT_ITEM_ID,
    FORMAT_BOLD_ACCELERATOR, FORMAT_BOLD_ITEM_ID, FORMAT_BULLETED_LIST_ACCELERATOR, FORMAT_BULLETED_LIST_ITEM_ID,
    FORMAT_CLEAR_ITEM_ID, FORMAT_CODE_BLOCK_ACCELERATOR, FORMAT_CODE_BLOCK_ITEM_ID, FORMAT_HEADING_1_ACCELERATOR,
    FORMAT_HEADING_1_ITEM_ID, FORMAT_HEADING_2_ACCELERATOR, FORMAT_HEADING_2_ITEM_ID, FORMAT_HEADING_3_ACCELERATOR,
    FORMAT_HEADING_3_ITEM_ID, FORMAT_HEADING_4_ACCELERATOR, FORMAT_HEADING_4_ITEM_ID, FORMAT_HEADING_5_ACCELERATOR,
    FORMAT_HEADING_5_ITEM_ID, FORMAT_HEADING_6_ACCELERATOR, FORMAT_HEADING_6_ITEM_ID, FORMAT_INDENT_ACCELERATOR,
    FORMAT_INDENT_ITEM_ID, FORMAT_INLINE_CODE_ACCELERATOR, FORMAT_INLINE_CODE_ITEM_ID, FORMAT_INSERT_FOOTNOTE_ITEM_ID,
    FORMAT_INSERT_IMAGE_ITEM_ID, FORMAT_INSERT_MENU_ID, FORMAT_INSERT_RULE_ITEM_ID, FORMAT_INSERT_TABLE_ITEM_ID,
    FORMAT_ITALIC_ACCELERATOR, FORMAT_ITALIC_ITEM_ID, FORMAT_ITEM_ID_PREFIX, FORMAT_LINK_ACCELERATOR, FORMAT_LINK_ITEM_ID,
    FORMAT_NUMBERED_LIST_ACCELERATOR, FORMAT_NUMBERED_LIST_ITEM_ID, FORMAT_OUTDENT_ACCELERATOR, FORMAT_OUTDENT_ITEM_ID,
    FORMAT_QUOTE_ACCELERATOR, FORMAT_QUOTE_ITEM_ID, FORMAT_STRIKETHROUGH_ACCELERATOR, FORMAT_STRIKETHROUGH_ITEM_ID,
    FORMAT_TASK_LIST_ACCELERATOR, FORMAT_TASK_LIST_ITEM_ID, MENU_FORMAT_EVENT, MENU_RAW_SOURCE_EVENT,
    RAW_SOURCE_ACCELERATOR, RAW_SOURCE_ITEM_ID, RAW_SOURCE_STATE_EVENT, TOGGLE_FULL_WIDTH_ITEM_ID,
};
use vellis_lib::menu::raw_check_applies;
// 要件74 第3段 3-3(Edit ▸ Find and Replace…=契約5 の (x)・3-12)
use vellis_lib::menu::{FIND_REPLACE_ACCELERATOR, FIND_REPLACE_ITEM_ID, MENU_FIND_REPLACE_EVENT};
// 要件74 第4段 4-2(View ▸ Show Formatting Toolbar=4-5)
use vellis_lib::menu::{FORMAT_TOOLBAR_STATE_EVENT, MENU_SHOW_FORMAT_TOOLBAR_EVENT, SHOW_FORMAT_TOOLBAR_ITEM_ID};
// 要件74 第3段 3-2(Format ▸ Table=契約8・3-6・3-8・3-9)
use vellis_lib::menu::{
    FORMAT_TABLE_COLUMN_LEFT_ITEM_ID, FORMAT_TABLE_COLUMN_RIGHT_ITEM_ID, FORMAT_TABLE_DELETE_COLUMN_ITEM_ID,
    FORMAT_TABLE_DELETE_ITEM_ID, FORMAT_TABLE_DELETE_ROW_ITEM_ID, FORMAT_TABLE_MENU_ID, FORMAT_TABLE_ROW_ABOVE_ITEM_ID,
    FORMAT_TABLE_ROW_BELOW_ITEM_ID,
};

// ---------------------------------------------------------------------------
// ソースの読み取り(acceptance_req74.rs と同じ道具)
// ---------------------------------------------------------------------------

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_source(rel: &str) -> String {
    let path = manifest_dir().join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{} must be readable: {e}", path.display()))
}

/// `//` のコメント行を落とす(文字列リテラルの中の `//` は URL 以外に無い前提。`"` の数が奇数の行は残す)。
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
fn frontend(rel: &str) -> String {
    read_source(&format!("../{rel}"))
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
    let start =
        fn_decl_start(code, name).unwrap_or_else(|| panic!("source must define `fn {name}(` (or `fn {name}<`)"));
    let params_open = code[start..].find('(').expect("fn must take parameters") + start;
    let params_close = matching_close(code, params_open);
    let open = code[params_close..].find('{').expect("fn must have a body") + params_close;
    let close = matching_close(code, open);
    code[open + 1..close].to_string()
}

fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

/// `start` から最初の `(` に対応する閉じ括弧までの呼び出し全体。
fn balanced_call(code: &str, start: usize) -> &str {
    let open = code[start..].find('(').expect("call must have '('") + start;
    let close = matching_close(code, open);
    &code[start..=close]
}

fn first_string_literal(s: &str) -> Option<&str> {
    let open = s.find('"')? + 1;
    let close = s[open..].find('"')? + open;
    Some(&s[open..close])
}

/// 直前の `let <ident> =` の ident。
fn let_binding_before<'a>(code: &'a str, pos: usize, what: &str) -> &'a str {
    let head = &code[..pos];
    let let_at = head.rfind("let ").unwrap_or_else(|| panic!("{what} must be bound with `let`"));
    let rest = &head[let_at + 4..];
    let eq = rest.find('=').unwrap_or_else(|| panic!("{what}: `let` without `=`"));
    rest[..eq].trim().trim_start_matches("mut ").trim()
}

/// ラベル `label` の Submenu の呼び出し(`Submenu::with_items` / `with_id_and_items`)。
fn submenu_call_with_label<'a>(code: &'a str, label: &str) -> Option<&'a str> {
    for (pos, _) in code.match_indices("Submenu::with_") {
        let call = balanced_call(code, pos);
        if first_string_literal(call) == Some(label) {
            return Some(call);
        }
    }
    None
}

/// 呼び出しの `&[ … ]` の中の識別子(`&` を外す)。
fn slice_idents(call: &str) -> Vec<&str> {
    let open = call.find("&[").expect("call must take a slice") + 1;
    let close = matching_close(call, open);
    call[open + 1..close]
        .split(',')
        .map(|s| s.trim().trim_start_matches('&'))
        .filter(|s| !s.is_empty())
        .collect()
}

fn separator_bindings(code: &str) -> BTreeSet<&str> {
    code.match_indices("PredefinedMenuItem::separator(")
        .map(|(pos, _)| let_binding_before(code, pos, "PredefinedMenuItem::separator"))
        .collect()
}

/// `<Kind>::with_id(app, <CONST>, …)` の呼び出し(定数で組んだもの)。
fn item_call_using<'a>(code: &'a str, const_name: &str) -> Option<&'a str> {
    for (pos, _) in code.match_indices("::with_id(") {
        let start = code[..pos].rfind(|c: char| !(c.is_alphanumeric() || c == '_')).map(|i| i + 1).unwrap_or(0);
        let call = balanced_call(code, start);
        let args: Vec<&str> = call[call.find('(').unwrap() + 1..].split(',').collect();
        if args.get(1).map(|a| a.trim()) == Some(const_name) {
            return Some(call);
        }
    }
    None
}

fn item_binding<'a>(code: &'a str, const_name: &str) -> &'a str {
    let call = item_call_using(code, const_name).unwrap_or_else(|| panic!("menu.rs must build an item with {const_name}"));
    let_binding_before(code, call.as_ptr() as usize - code.as_ptr() as usize, const_name)
}

fn last_argument(call: &str) -> String {
    let inner = &call[call.find('(').unwrap() + 1..call.len() - 1];
    squash(inner.rsplit(',').find(|s| !s.trim().is_empty()).unwrap_or(""))
}

fn on_menu_event_block(lib: &str) -> &str {
    let at = lib.find("app.on_menu_event(").expect("lib.rs must call app.on_menu_event(");
    let open = lib[at..].find('{').expect("on_menu_event must have a block") + at;
    let close = matching_close(lib, open);
    &lib[open..=close]
}

/// `id if id == menu::<CONST> =>` か `id if id.starts_with(menu::<CONST>) =>` の腕の本文。
fn menu_arm_body<'a>(block: &'a str, const_name: &str) -> &'a str {
    let needle = format!("menu::{const_name}");
    let at = block.find(&needle).unwrap_or_else(|| panic!("on_menu_event must have an arm for {const_name}"));
    let arrow = block[at..].find("=>").expect("arm must have =>") + at;
    let open = block[arrow..].find('{').expect("arm must have a block") + arrow;
    let close = matching_close(block, open);
    &block[open..=close]
}

fn ts_string_const(src: &str, name: &str) -> String {
    let needle = format!("export const {name} = '");
    let start = src.find(&needle).unwrap_or_else(|| panic!("frontend must export `{name}`")) + needle.len();
    let end = src[start..].find('\'').expect("closing quote") + start;
    src[start..end].to_string()
}

// ---------------------------------------------------------------------------
// 判断 4 に依存: 表(並び・ラベル・ID・アクセラレータ・束縛名)
// ---------------------------------------------------------------------------

/// 項目 10 の表。(束縛名, 定数名, ID, ラベル, アクセラレータ(定数名, 値))。
const FORMAT_ITEMS: [(&str, &str, &str, &str, Option<(&str, &str)>); 34] = [
    ("format_bold_item", "FORMAT_BOLD_ITEM_ID", "format-bold", "Bold", Some(("FORMAT_BOLD_ACCELERATOR", "CmdOrCtrl+B"))),
    ("format_italic_item", "FORMAT_ITALIC_ITEM_ID", "format-italic", "Italic", Some(("FORMAT_ITALIC_ACCELERATOR", "CmdOrCtrl+I"))),
    ("format_strikethrough_item", "FORMAT_STRIKETHROUGH_ITEM_ID", "format-strikethrough", "Strikethrough", Some(("FORMAT_STRIKETHROUGH_ACCELERATOR", "CmdOrCtrl+Shift+X"))),
    ("format_inline_code_item", "FORMAT_INLINE_CODE_ITEM_ID", "format-inline-code", "Inline Code", Some(("FORMAT_INLINE_CODE_ACCELERATOR", "CmdOrCtrl+Shift+C"))),
    ("format_link_item", "FORMAT_LINK_ITEM_ID", "format-link", "Link…", Some(("FORMAT_LINK_ACCELERATOR", "CmdOrCtrl+K"))),
    ("format_body_text_item", "FORMAT_BODY_TEXT_ITEM_ID", "format-body-text", "Body Text", Some(("FORMAT_BODY_TEXT_ACCELERATOR", "CmdOrCtrl+Alt+0"))),
    ("format_heading_1_item", "FORMAT_HEADING_1_ITEM_ID", "format-heading-1", "Heading 1", Some(("FORMAT_HEADING_1_ACCELERATOR", "CmdOrCtrl+Alt+1"))),
    ("format_heading_2_item", "FORMAT_HEADING_2_ITEM_ID", "format-heading-2", "Heading 2", Some(("FORMAT_HEADING_2_ACCELERATOR", "CmdOrCtrl+Alt+2"))),
    ("format_heading_3_item", "FORMAT_HEADING_3_ITEM_ID", "format-heading-3", "Heading 3", Some(("FORMAT_HEADING_3_ACCELERATOR", "CmdOrCtrl+Alt+3"))),
    ("format_heading_4_item", "FORMAT_HEADING_4_ITEM_ID", "format-heading-4", "Heading 4", Some(("FORMAT_HEADING_4_ACCELERATOR", "CmdOrCtrl+Alt+4"))),
    ("format_heading_5_item", "FORMAT_HEADING_5_ITEM_ID", "format-heading-5", "Heading 5", Some(("FORMAT_HEADING_5_ACCELERATOR", "CmdOrCtrl+Alt+5"))),
    ("format_heading_6_item", "FORMAT_HEADING_6_ITEM_ID", "format-heading-6", "Heading 6", Some(("FORMAT_HEADING_6_ACCELERATOR", "CmdOrCtrl+Alt+6"))),
    ("format_bulleted_list_item", "FORMAT_BULLETED_LIST_ITEM_ID", "format-bulleted-list", "Bulleted List", Some(("FORMAT_BULLETED_LIST_ACCELERATOR", "CmdOrCtrl+Shift+8"))),
    ("format_numbered_list_item", "FORMAT_NUMBERED_LIST_ITEM_ID", "format-numbered-list", "Numbered List", Some(("FORMAT_NUMBERED_LIST_ACCELERATOR", "CmdOrCtrl+Shift+7"))),
    ("format_task_list_item", "FORMAT_TASK_LIST_ITEM_ID", "format-task-list", "Task List", Some(("FORMAT_TASK_LIST_ACCELERATOR", "CmdOrCtrl+Shift+L"))),
    ("format_quote_item", "FORMAT_QUOTE_ITEM_ID", "format-quote", "Quote", Some(("FORMAT_QUOTE_ACCELERATOR", "CmdOrCtrl+Shift+Period"))),
    ("format_code_block_item", "FORMAT_CODE_BLOCK_ITEM_ID", "format-code-block", "Code Block", Some(("FORMAT_CODE_BLOCK_ACCELERATOR", "CmdOrCtrl+Alt+C"))),
    ("format_alert_note_item", "FORMAT_ALERT_NOTE_ITEM_ID", "format-alert-note", "Note", None),
    ("format_alert_tip_item", "FORMAT_ALERT_TIP_ITEM_ID", "format-alert-tip", "Tip", None),
    ("format_alert_important_item", "FORMAT_ALERT_IMPORTANT_ITEM_ID", "format-alert-important", "Important", None),
    ("format_alert_warning_item", "FORMAT_ALERT_WARNING_ITEM_ID", "format-alert-warning", "Warning", None),
    ("format_alert_caution_item", "FORMAT_ALERT_CAUTION_ITEM_ID", "format-alert-caution", "Caution", None),
    ("format_indent_item", "FORMAT_INDENT_ITEM_ID", "format-indent", "Increase Indent", Some(("FORMAT_INDENT_ACCELERATOR", "CmdOrCtrl+]"))),
    ("format_outdent_item", "FORMAT_OUTDENT_ITEM_ID", "format-outdent", "Decrease Indent", Some(("FORMAT_OUTDENT_ACCELERATOR", "CmdOrCtrl+["))),
    ("format_insert_table_item", "FORMAT_INSERT_TABLE_ITEM_ID", "format-insert-table", "Table", None),
    ("format_insert_rule_item", "FORMAT_INSERT_RULE_ITEM_ID", "format-insert-rule", "Horizontal Rule", None),
    ("format_insert_footnote_item", "FORMAT_INSERT_FOOTNOTE_ITEM_ID", "format-insert-footnote", "Footnote", None),
    // 第3段 3-2: Format ▸ Table ▸(アクセラレータなし=3-9)
    ("format_table_row_above_item", "FORMAT_TABLE_ROW_ABOVE_ITEM_ID", "format-table-row-above", "Insert Row Above", None),
    ("format_table_row_below_item", "FORMAT_TABLE_ROW_BELOW_ITEM_ID", "format-table-row-below", "Insert Row Below", None),
    ("format_table_column_left_item", "FORMAT_TABLE_COLUMN_LEFT_ITEM_ID", "format-table-column-left", "Insert Column Left", None),
    ("format_table_column_right_item", "FORMAT_TABLE_COLUMN_RIGHT_ITEM_ID", "format-table-column-right", "Insert Column Right", None),
    ("format_table_delete_row_item", "FORMAT_TABLE_DELETE_ROW_ITEM_ID", "format-table-delete-row", "Delete Row", None),
    ("format_table_delete_column_item", "FORMAT_TABLE_DELETE_COLUMN_ITEM_ID", "format-table-delete-column", "Delete Column", None),
    ("format_table_delete_item", "FORMAT_TABLE_DELETE_ITEM_ID", "format-table-delete", "Delete Table", None),
];

/// Format の Submenu の並び(判断 4=(B) の 10 の表・区切り線 5 本。第3段 3-2: Insert ▸ の直後に Table ▸=3-8)。
const EXPECTED_FORMAT: [&str; 28] = [
    "format_bold_item",
    "format_italic_item",
    "format_strikethrough_item",
    "format_inline_code_item",
    "format_link_item",
    "format_sep1",
    "format_body_text_item",
    "format_heading_1_item",
    "format_heading_2_item",
    "format_heading_3_item",
    "format_heading_4_item",
    "format_heading_5_item",
    "format_heading_6_item",
    "format_sep2",
    "format_bulleted_list_item",
    "format_numbered_list_item",
    "format_task_list_item",
    "format_quote_item",
    "format_code_block_item",
    "format_alert_menu",
    "format_sep3",
    "format_indent_item",
    "format_outdent_item",
    "format_sep4",
    "format_insert_menu",
    "format_table_menu",
    "format_sep5",
    "format_clear_item",
];

const EXPECTED_VIEW: [&str; 15] = [
    "show_tab_bar_item",
    "show_all_tabs_item",
    "view_tab_sep",
    "reload_file_item",
    "view_reload_sep",
    "appearance_menu",
    "toggle_full_width_item",
    "raw_source_item",
    // 第4段 4-2(4-5): View ▸ Show Formatting Toolbar(CheckMenuItem・アクセラレータなし)は Raw Source の直後
    "show_format_toolbar_item",
    "view_chrome_sep",
    "zoom_in_item",
    "zoom_out_item",
    "actual_size_item",
    "view_sep",
    "toggle_devtools",
];

// ---------------------------------------------------------------------------
// AC-74-7 — 定数
// ---------------------------------------------------------------------------

/// 1. ID の定数は表どおり(34+3)。Image… は `format-insert-image`(2-2 で面の側が受ける)。
#[test]
fn ac74_7_format_item_ids_are_fixed() {
    let ids: Vec<(&str, &str)> = vec![
        (FORMAT_BOLD_ITEM_ID, "format-bold"),
        (FORMAT_ITALIC_ITEM_ID, "format-italic"),
        (FORMAT_STRIKETHROUGH_ITEM_ID, "format-strikethrough"),
        (FORMAT_INLINE_CODE_ITEM_ID, "format-inline-code"),
        (FORMAT_LINK_ITEM_ID, "format-link"),
        (FORMAT_BODY_TEXT_ITEM_ID, "format-body-text"),
        (FORMAT_HEADING_1_ITEM_ID, "format-heading-1"),
        (FORMAT_HEADING_2_ITEM_ID, "format-heading-2"),
        (FORMAT_HEADING_3_ITEM_ID, "format-heading-3"),
        (FORMAT_HEADING_4_ITEM_ID, "format-heading-4"),
        (FORMAT_HEADING_5_ITEM_ID, "format-heading-5"),
        (FORMAT_HEADING_6_ITEM_ID, "format-heading-6"),
        (FORMAT_BULLETED_LIST_ITEM_ID, "format-bulleted-list"),
        (FORMAT_NUMBERED_LIST_ITEM_ID, "format-numbered-list"),
        (FORMAT_TASK_LIST_ITEM_ID, "format-task-list"),
        (FORMAT_QUOTE_ITEM_ID, "format-quote"),
        (FORMAT_CODE_BLOCK_ITEM_ID, "format-code-block"),
        (FORMAT_ALERT_NOTE_ITEM_ID, "format-alert-note"),
        (FORMAT_ALERT_TIP_ITEM_ID, "format-alert-tip"),
        (FORMAT_ALERT_IMPORTANT_ITEM_ID, "format-alert-important"),
        (FORMAT_ALERT_WARNING_ITEM_ID, "format-alert-warning"),
        (FORMAT_ALERT_CAUTION_ITEM_ID, "format-alert-caution"),
        (FORMAT_INDENT_ITEM_ID, "format-indent"),
        (FORMAT_OUTDENT_ITEM_ID, "format-outdent"),
        (FORMAT_INSERT_TABLE_ITEM_ID, "format-insert-table"),
        (FORMAT_INSERT_RULE_ITEM_ID, "format-insert-rule"),
        (FORMAT_INSERT_FOOTNOTE_ITEM_ID, "format-insert-footnote"),
        (FORMAT_INSERT_IMAGE_ITEM_ID, "format-insert-image"),
        (FORMAT_CLEAR_ITEM_ID, "format-clear"),
        (FORMAT_ALERT_MENU_ID, "format-alert-menu"),
        (FORMAT_INSERT_MENU_ID, "format-insert-menu"),
        // 第3段 3-2
        (FORMAT_TABLE_ROW_ABOVE_ITEM_ID, "format-table-row-above"),
        (FORMAT_TABLE_ROW_BELOW_ITEM_ID, "format-table-row-below"),
        (FORMAT_TABLE_COLUMN_LEFT_ITEM_ID, "format-table-column-left"),
        (FORMAT_TABLE_COLUMN_RIGHT_ITEM_ID, "format-table-column-right"),
        (FORMAT_TABLE_DELETE_ROW_ITEM_ID, "format-table-delete-row"),
        (FORMAT_TABLE_DELETE_COLUMN_ITEM_ID, "format-table-delete-column"),
        (FORMAT_TABLE_DELETE_ITEM_ID, "format-table-delete"),
        (FORMAT_TABLE_MENU_ID, "format-table-menu"),
    ];
    let mut seen = BTreeSet::new();
    for (actual, expected) in &ids {
        assert_eq!(actual, expected);
        assert!(actual.starts_with(FORMAT_ITEM_ID_PREFIX), "{actual} starts with the prefix");
        assert!(seen.insert(*actual), "duplicate id {actual}");
    }
    assert_eq!(FORMAT_ITEM_ID_PREFIX, "format-");
    assert_eq!(MENU_FORMAT_EVENT, "menu_format");
    assert_eq!(RAW_SOURCE_ITEM_ID, "raw-source");
    assert!(!RAW_SOURCE_ITEM_ID.starts_with(FORMAT_ITEM_ID_PREFIX), "Raw Source is not a Format item");
    assert_eq!(MENU_RAW_SOURCE_EVENT, "menu_raw_source");
    assert_eq!(RAW_SOURCE_STATE_EVENT, "raw_source_state"); // 判断 9 に依存
}

/// 2. アクセラレータは表どおりで、どれも `muda::accelerator::Accelerator` として parse できる。
#[test]
fn ac74_7_format_accelerators_are_fixed_and_parse() {
    let accs: Vec<(&str, &str)> = vec![
        (FORMAT_BOLD_ACCELERATOR, "CmdOrCtrl+B"),
        (FORMAT_ITALIC_ACCELERATOR, "CmdOrCtrl+I"),
        (FORMAT_STRIKETHROUGH_ACCELERATOR, "CmdOrCtrl+Shift+X"),
        (FORMAT_INLINE_CODE_ACCELERATOR, "CmdOrCtrl+Shift+C"),
        (FORMAT_LINK_ACCELERATOR, "CmdOrCtrl+K"),
        (FORMAT_BODY_TEXT_ACCELERATOR, "CmdOrCtrl+Alt+0"),
        (FORMAT_HEADING_1_ACCELERATOR, "CmdOrCtrl+Alt+1"),
        (FORMAT_HEADING_2_ACCELERATOR, "CmdOrCtrl+Alt+2"),
        (FORMAT_HEADING_3_ACCELERATOR, "CmdOrCtrl+Alt+3"),
        (FORMAT_HEADING_4_ACCELERATOR, "CmdOrCtrl+Alt+4"),
        (FORMAT_HEADING_5_ACCELERATOR, "CmdOrCtrl+Alt+5"),
        (FORMAT_HEADING_6_ACCELERATOR, "CmdOrCtrl+Alt+6"),
        (FORMAT_BULLETED_LIST_ACCELERATOR, "CmdOrCtrl+Shift+8"),
        (FORMAT_NUMBERED_LIST_ACCELERATOR, "CmdOrCtrl+Shift+7"),
        (FORMAT_TASK_LIST_ACCELERATOR, "CmdOrCtrl+Shift+L"),
        (FORMAT_QUOTE_ACCELERATOR, "CmdOrCtrl+Shift+Period"),
        (FORMAT_CODE_BLOCK_ACCELERATOR, "CmdOrCtrl+Alt+C"),
        (FORMAT_INDENT_ACCELERATOR, "CmdOrCtrl+]"),
        (FORMAT_OUTDENT_ACCELERATOR, "CmdOrCtrl+["),
        (RAW_SOURCE_ACCELERATOR, "CmdOrCtrl+Alt+U"),
    ];
    let mut parsed: Vec<Accelerator> = Vec::new();
    for (actual, expected) in &accs {
        assert_eq!(actual, expected);
        let acc = Accelerator::from_str(actual).unwrap_or_else(|e| panic!("{actual} must parse as an Accelerator: {e}"));
        assert!(!parsed.contains(&acc), "{actual} collides with another Format accelerator");
        parsed.push(acc);
    }
}

/// 3. 既存のアクセラレータと重ならない(acceptance_req60.rs の重複検査と同じ集め方で、表の 20 個がそれぞれちょうど 1 回登録される)。
#[test]
fn ac74_7_accelerators_do_not_collide_with_the_existing_ones_and_each_is_registered_once() {
    let code = menu_rs_code();
    let mut literals = Vec::new();
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
                    literals.push(std::mem::take(&mut cur));
                    in_str = false;
                }
                _ => cur.push(c),
            }
        } else if c == '"' {
            in_str = true;
        }
    }
    let parsed: Vec<(String, Accelerator)> = literals
        .into_iter()
        .filter(|s| s.contains('+'))
        .filter_map(|s| Accelerator::from_str(&s).ok().map(|a| (s, a)))
        .collect();
    for (i, (raw_a, acc_a)) in parsed.iter().enumerate() {
        for (raw_b, acc_b) in parsed.iter().skip(i + 1) {
            assert!(acc_a != acc_b, "duplicate accelerator in menu.rs: '{raw_a}' collides with '{raw_b}'");
        }
    }
    for (_, _, _, _, acc) in FORMAT_ITEMS.iter().chain([("", "", "", "", Some(("RAW_SOURCE_ACCELERATOR", "CmdOrCtrl+Alt+U")))].iter()) {
        let Some((_, value)) = acc else { continue };
        let want = Accelerator::from_str(value).unwrap();
        let count = parsed.iter().filter(|(_, a)| *a == want).count();
        assert_eq!(count, 1, "menu.rs must register {value} exactly once (found {count})");
    }
}

/// 4. フロントの `commands.ts` の ID と `raw-sync.ts` のイベント名は Rust と同じ綴り。
#[test]
fn ac74_7_frontend_ids_and_event_names_match() {
    let commands = frontend("src/editor/commands.ts");
    for (_, _, id, _, _) in FORMAT_ITEMS.iter() {
        assert!(commands.contains(&format!("'{id}'")), "commands.ts must know the id '{id}'");
    }
    assert!(commands.contains("'format-insert-image'"), "commands.ts must know 'format-insert-image'");
    assert!(commands.contains("'format-clear'"), "commands.ts must know 'format-clear'");
    assert_eq!(ts_string_const(&commands, "MENU_FORMAT_EVENT"), MENU_FORMAT_EVENT);
    let raw_sync = frontend("src/editor/raw-sync.ts");
    assert_eq!(ts_string_const(&raw_sync, "MENU_RAW_SOURCE_EVENT"), MENU_RAW_SOURCE_EVENT);
    assert_eq!(ts_string_const(&raw_sync, "RAW_SOURCE_STATE_EVENT"), RAW_SOURCE_STATE_EVENT); // 判断 9 に依存
}

// ---------------------------------------------------------------------------
// AC-74-7 — menu.rs(ソース走査)
// ---------------------------------------------------------------------------

/// 5. メニューバーは Vellis / File / Edit / Format / View / Go / Window(Format は Edit と View の間=契約8)。
#[test]
fn ac74_7_menu_bar_holds_format_between_edit_and_view() {
    let code = menu_rs_code();
    let bar_start = code
        .match_indices("Menu::with_items")
        .map(|(i, _)| i)
        .find(|&i| !code[..i].ends_with("Sub"))
        .expect("menu.rs must build the bar with Menu::with_items");
    let bar = balanced_call(&code, bar_start);
    let idents = slice_idents(bar);
    assert_eq!(
        idents,
        ["app_menu", "file_menu", "edit_menu", "format_menu", "view_menu", "go_menu", "window_menu"],
        "the menu bar must be Vellis / File / Edit / Format / View / Go / Window (契約8)"
    );
    let format = submenu_call_with_label(&code, "Format").expect("menu.rs must build a \"Format\" submenu");
    assert_eq!(
        let_binding_before(&code, format.as_ptr() as usize - code.as_ptr() as usize, "Format submenu"),
        "format_menu"
    );
    let labels: Vec<&str> = code.match_indices("Submenu::with_").filter_map(|(p, _)| first_string_literal(balanced_call(&code, p))).collect();
    assert_eq!(labels.iter().filter(|l| **l == "Format").count(), 1, "exactly one Format submenu");
}

/// 6. 判断 4 に依存: Format の並び(28 の束縛=20 項目・区切り線 5 本 format_sep1〜5(Insert ▸ と Clear Formatting の間にも)・Alert ▸ / Insert ▸ / Table ▸ のサブメニュー。第3段 3-2 で Table ▸ が Insert ▸ の直後)。
///    注: 項目 10 の表には 4 本しか無いが、判断 4 の文言(とオーケストレーターの指示)は 5 本。表の側を直す(報告済み)。
#[test]
fn ac74_7_format_submenu_order_follows_the_table() {
    let code = menu_rs_code();
    let format = submenu_call_with_label(&code, "Format").expect("menu.rs must build a \"Format\" submenu");
    let idents = slice_idents(format);
    assert_eq!(idents, EXPECTED_FORMAT, "Format must hold exactly these 28 entries in this order (判断 4・第3段 3-2): found {idents:?}");
    let separators = separator_bindings(&code);
    for sep in ["format_sep1", "format_sep2", "format_sep3", "format_sep4", "format_sep5"] {
        assert!(separators.contains(sep), "`{sep}` must be a PredefinedMenuItem::separator binding ({separators:?})");
    }
    assert_eq!(idents.iter().filter(|i| separators.contains(**i)).count(), 5, "5 separators inside Format (判断 4)");

    let alert = submenu_call_with_label(&code, "Alert").expect("menu.rs must build an \"Alert\" submenu");
    assert!(alert.contains("FORMAT_ALERT_MENU_ID"), "Alert is built with Submenu::with_id_and_items(app, FORMAT_ALERT_MENU_ID, …)");
    assert_eq!(
        slice_idents(alert),
        ["format_alert_note_item", "format_alert_tip_item", "format_alert_important_item", "format_alert_warning_item", "format_alert_caution_item"]
    );
    assert_eq!(let_binding_before(&code, alert.as_ptr() as usize - code.as_ptr() as usize, "Alert"), "format_alert_menu");

    let insert = submenu_call_with_label(&code, "Insert").expect("menu.rs must build an \"Insert\" submenu");
    assert!(insert.contains("FORMAT_INSERT_MENU_ID"), "Insert is built with Submenu::with_id_and_items(app, FORMAT_INSERT_MENU_ID, …)");
    assert_eq!(
        slice_idents(insert),
        ["format_insert_table_item", "format_insert_rule_item", "format_insert_footnote_item", "format_insert_image_item"]
    );
    assert_eq!(let_binding_before(&code, insert.as_ptr() as usize - code.as_ptr() as usize, "Insert"), "format_insert_menu");
}

/// AC-74-52(第3段 3-2・契約8・3-6・3-8・3-9): Format ▸ Table ▸ は Insert ▸ の直後(区切り線は増やさない)。
/// `Submenu::with_id_and_items(app, FORMAT_TABLE_MENU_ID, "Table", true, &[…])` で、並びは
/// Insert Row Above / Insert Row Below / Insert Column Left / Insert Column Right / ─(format_table_sep)/ Delete Row / Delete Column / Delete Table。
/// 7 項目にアクセラレータは無い(FORMAT_ITEMS の None=テスト 7 で見る)。ID は `format-` で始まる(lib.rs の今の枝で menu_format=テスト 1・routes)。
#[test]
fn ac74_52_table_submenu_sits_right_after_insert_with_seven_items() {
    let code = menu_rs_code();
    let format = submenu_call_with_label(&code, "Format").expect("menu.rs must build a \"Format\" submenu");
    let idents = slice_idents(format);
    let insert_at = idents.iter().position(|i| *i == "format_insert_menu").expect("Insert ▸ in Format");
    assert_eq!(idents.get(insert_at + 1), Some(&"format_table_menu"), "Table ▸ must come right after Insert ▸ (3-8): {idents:?}");
    assert_eq!(idents.iter().filter(|i| **i == "format_table_menu").count(), 1);
    let separators = separator_bindings(&code);
    assert_eq!(idents.iter().filter(|i| separators.contains(**i)).count(), 5, "Table ▸ does not add a separator to Format (3-8)");

    // Table ▸ は label "Table" の Submenu のうち FORMAT_TABLE_MENU_ID で組むもの(Insert ▸ Table の項目は MenuItem)
    let table = code
        .match_indices("Submenu::with_")
        .map(|(p, _)| balanced_call(&code, p))
        .find(|call| call.contains("FORMAT_TABLE_MENU_ID"))
        .expect("menu.rs must build the Table submenu with Submenu::with_id_and_items(app, FORMAT_TABLE_MENU_ID, …)");
    assert!(table.starts_with("Submenu::with_id_and_items("), "{table}");
    assert_eq!(first_string_literal(table), Some("Table"), "Table ▸ label");
    assert!(table.contains(", true,"), "Table ▸ is always enabled: {table}");
    assert_eq!(
        slice_idents(table),
        [
            "format_table_row_above_item",
            "format_table_row_below_item",
            "format_table_column_left_item",
            "format_table_column_right_item",
            "format_table_sep",
            "format_table_delete_row_item",
            "format_table_delete_column_item",
            "format_table_delete_item",
        ],
        "Table ▸ order (3-6: 追加 4・区切り線・削除 3)"
    );
    assert!(separators.contains("format_table_sep"), "`format_table_sep` must be a PredefinedMenuItem::separator binding");
    assert_eq!(let_binding_before(&code, table.as_ptr() as usize - code.as_ptr() as usize, "Table"), "format_table_menu");
    assert_eq!(FORMAT_TABLE_MENU_ID, "format-table-menu");
    assert!(FORMAT_TABLE_MENU_ID.starts_with(FORMAT_ITEM_ID_PREFIX));
    // ラベル "Table" は Insert ▸ Table(項目)と Table ▸(サブメニュー)の 2 回
    assert_eq!(code.matches("\"Table\"").count(), 2, "\"Table\" appears for Insert ▸ Table and the Table submenu");
    // Move / Align は無い(3-6)
    assert!(!code.contains("format-table-move"), "no Move Row / Column items (3-6)");
    assert!(!code.contains("format-table-align"), "no Align Column items (3-6)");
    // フロントの FormatItemId に同じ 7 つ
    let commands = frontend("src/editor/commands.ts");
    for id in ["format-table-row-above", "format-table-row-below", "format-table-column-left", "format-table-column-right", "format-table-delete-row", "format-table-delete-column", "format-table-delete"] {
        assert!(commands.contains(&format!("'{id}'")), "commands.ts must know '{id}'");
    }
}

/// menu.rs のコード部分の二重引用符の文字列リテラル(アクセラレータの重複の判定用。acceptance_req60 と同じ素朴な走査)。
fn menu_string_literals(code: &str) -> Vec<String> {
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

/// AC-74-55(第3段 3-3・契約5 の (x)・3-12): Edit ▸ Find and Replace…(ID `find-replace`・ラベル `Find and Replace…`・`CmdOrCtrl+Alt+F`)が
/// Find… の直後(Find… / Find and Replace… / Find in Folder…)。lib.rs は `handle_menu_open_click(app_handle, menu::MENU_FIND_REPLACE_EVENT)` で
/// 前面の窓へ。フロントの `MENU_FIND_REPLACE_EVENT` は `src/editor/cm-replace.ts`(`find-in-document.ts` は SHA 固定なので足さない)。
#[test]
fn ac74_55_find_and_replace_sits_right_after_find_and_is_dispatched() {
    assert_eq!(FIND_REPLACE_ITEM_ID, "find-replace");
    assert_eq!(FIND_REPLACE_ACCELERATOR, "CmdOrCtrl+Alt+F");
    assert_eq!(MENU_FIND_REPLACE_EVENT, "menu_find_replace");
    assert!(!FIND_REPLACE_ITEM_ID.starts_with(FORMAT_ITEM_ID_PREFIX), "not a Format item");
    let acc = Accelerator::from_str(FIND_REPLACE_ACCELERATOR).expect("CmdOrCtrl+Alt+F must parse");
    // ほかのアクセラレータと重ならない(menu.rs の `+` を含む文字列リテラルのうち parse できるもの)
    let code = menu_rs_code();
    let parsed: Vec<Accelerator> = menu_string_literals(&code)
        .into_iter()
        .filter(|s| s.contains('+'))
        .filter_map(|s| Accelerator::from_str(&s).ok())
        .collect();
    assert_eq!(parsed.iter().filter(|a| **a == acc).count(), 1, "CmdOrCtrl+Alt+F is registered exactly once");

    // 項目の組み方とラベル
    let call = item_call_using(&code, "FIND_REPLACE_ITEM_ID").expect("menu.rs must build an item with FIND_REPLACE_ITEM_ID");
    assert!(call.starts_with("MenuItem::with_id("), "{call}");
    assert_eq!(first_string_literal(call), Some("Find and Replace…"), "label (English, with the ellipsis)");
    assert!(call.contains(", true,"), "always enabled: {call}");
    assert_eq!(last_argument(call), "Some(FIND_REPLACE_ACCELERATOR)");
    assert_eq!(item_binding(&code, "FIND_REPLACE_ITEM_ID"), "find_replace_item");
    assert_eq!(code.matches("\"Find and Replace…\"").count(), 1);

    // Edit の並び: 標準の組・区切り線・Find… / Find and Replace… / Find in Folder…
    let edit = submenu_call_with_label(&code, "Edit").expect("menu.rs must build an \"Edit\" submenu");
    assert_eq!(
        slice_idents(edit),
        ["undo", "redo", "edit_sep", "cut", "copy", "paste", "select_all", "edit_mode_sep", "find_item", "find_replace_item", "find_in_folder_item"],
        "Edit must hold Find and Replace… right after Find… (3-12)"
    );
    for label in ["File", "View", "Go", "Format"] {
        if let Some(other) = submenu_call_with_label(&code, label) {
            assert!(!other.contains("&find_replace_item"), "{label} must not hold Find and Replace…");
        }
    }

    // lib.rs: 前面の窓へ(Find… と同じ形)
    let lib = lib_rs_code();
    let block = on_menu_event_block(&lib);
    let arm = menu_arm_body(block, "FIND_REPLACE_ITEM_ID");
    assert!(arm.contains("handle_menu_open_click("), "Find and Replace… arm calls handle_menu_open_click ({arm})");
    assert!(arm.contains("menu::MENU_FIND_REPLACE_EVENT"), "Find and Replace… arm emits menu::MENU_FIND_REPLACE_EVENT ({arm})");
    assert_eq!(block.matches("menu::MENU_FIND_REPLACE_EVENT").count(), 1);

    // フロントの定数は cm-replace.ts に(find-in-document.ts には足さない)
    let cm_replace = frontend("src/editor/cm-replace.ts");
    assert_eq!(ts_string_const(&cm_replace, "MENU_FIND_REPLACE_EVENT"), MENU_FIND_REPLACE_EVENT);
    let fid = frontend("src/lib/find-in-document.ts");
    assert!(!fid.contains("menu_find_replace"), "find-in-document.ts stays as fixed by AC-54-14 / AC-60-20");
}

/// 7. 各項目は `MenuItem::with_id(app, <ID 定数>, "<英語のラベル>", true, Some(<ACCELERATOR 定数>) | None)` で組む(常に有効)。
#[test]
fn ac74_7_each_format_item_is_built_from_its_constants_with_the_english_label() {
    let code = menu_rs_code();
    let mut rows: Vec<(&str, &str, &str, &str, Option<(&str, &str)>)> = FORMAT_ITEMS.to_vec();
    rows.push(("format_insert_image_item", "FORMAT_INSERT_IMAGE_ITEM_ID", "format-insert-image", "Image…", None));
    rows.push(("format_clear_item", "FORMAT_CLEAR_ITEM_ID", "format-clear", "Clear Formatting", None));
    for (binding, const_name, _, label, acc) in rows {
        let call = item_call_using(&code, const_name).unwrap_or_else(|| panic!("menu.rs must build an item with {const_name}"));
        assert!(call.starts_with("MenuItem::with_id("), "{const_name} is a plain MenuItem ({call})");
        assert_eq!(first_string_literal(call), Some(label), "{const_name} label");
        assert!(call.contains(", true,"), "{const_name} is always enabled (契約8): {call}");
        let last = last_argument(call);
        match acc {
            Some((acc_name, _)) => assert_eq!(last, format!("Some({acc_name})"), "{const_name} accelerator"),
            None => assert!(last.starts_with("None"), "{const_name} has no shortcut: {last}"),
        }
        assert_eq!(item_binding(&code, const_name), binding, "{const_name} binding");
    }
    for label in ["Bold", "Italic", "Strikethrough", "Inline Code", "Link…", "Body Text", "Heading 1", "Heading 6", "Bulleted List", "Numbered List", "Task List", "Quote", "Code Block", "Increase Indent", "Decrease Indent", "Horizontal Rule", "Footnote", "Clear Formatting", "Raw Source", "Insert Row Above", "Insert Row Below", "Insert Column Left", "Insert Column Right", "Delete Row", "Delete Column", "Delete Table"] {
        assert_eq!(code.matches(&format!("\"{label}\"")).count(), 1, "the label {label:?} appears exactly once in menu.rs");
    }
}

/// 8. View ▸ Raw Source は `CheckMenuItem::with_id(app, RAW_SOURCE_ITEM_ID, "Raw Source", true, false, Some(RAW_SOURCE_ACCELERATOR))`
///    (最初は印なし)で、Toggle Full Width の直後((ao))。View は 14 項目。メニューで最初の CheckMenuItem。
#[test]
fn ac74_7_raw_source_is_a_check_item_right_after_toggle_full_width() {
    let code = menu_rs_code();
    let call = item_call_using(&code, "RAW_SOURCE_ITEM_ID").expect("menu.rs must build an item with RAW_SOURCE_ITEM_ID");
    assert!(call.starts_with("CheckMenuItem::with_id("), "Raw Source is a CheckMenuItem (契約23): {call}");
    assert_eq!(first_string_literal(call), Some("Raw Source"));
    assert!(squash(call).contains(",true,false,"), "enabled and unchecked at build: {call}");
    assert_eq!(last_argument(call), "Some(RAW_SOURCE_ACCELERATOR)");
    assert_eq!(item_binding(&code, "RAW_SOURCE_ITEM_ID"), "raw_source_item");
    assert_eq!(code.matches("CheckMenuItem::with_id(").count(), 2, "Raw Source and Show Formatting Toolbar (第4段 4-2) are the only CheckMenuItems");

    let view = submenu_call_with_label(&code, "View").expect("menu.rs must build a \"View\" submenu");
    let idents = slice_idents(view);
    assert_eq!(idents, EXPECTED_VIEW, "View must hold these 15 entries ((ao)・第4段 4-2): found {idents:?}");
    let full_width = item_binding(&code, "TOGGLE_FULL_WIDTH_ITEM_ID");
    assert_eq!(idents[6], full_width);
    assert_eq!(idents[7], "raw_source_item");
    let _ = TOGGLE_FULL_WIDTH_ITEM_ID;
}

/// AC-74-62(第4段 4-2・4-5・棚卸し 3=View の並びの書き換えは承認済み): View ▸ Show Formatting Toolbar=
/// `CheckMenuItem::with_id(app, SHOW_FORMAT_TOOLBAR_ITEM_ID, "Show Formatting Toolbar", true, false, None::<&str>)`(最初は印なし・アクセラレータなし)が
/// Raw Source の直後。lib.rs は `handle_menu_open_click(app_handle, menu::MENU_SHOW_FORMAT_TOOLBAR_EVENT)` で前面の窓へ、チェック印は窓からの
/// `format_toolbar_state`({ label, shown })を `listen_format_toolbar_state` で受けて前面の窓の値に合わせる(raw_source_state と同じ形)。
#[test]
fn ac74_62_show_format_toolbar_is_a_check_item_right_after_raw_source() {
    assert_eq!(SHOW_FORMAT_TOOLBAR_ITEM_ID, "show-format-toolbar");
    assert_eq!(MENU_SHOW_FORMAT_TOOLBAR_EVENT, "menu_show_format_toolbar");
    assert_eq!(FORMAT_TOOLBAR_STATE_EVENT, "format_toolbar_state");
    assert!(!SHOW_FORMAT_TOOLBAR_ITEM_ID.starts_with(FORMAT_ITEM_ID_PREFIX), "not a Format item (View's own)");
    let code = menu_rs_code();
    let call = item_call_using(&code, "SHOW_FORMAT_TOOLBAR_ITEM_ID").expect("menu.rs must build an item with SHOW_FORMAT_TOOLBAR_ITEM_ID");
    assert!(call.starts_with("CheckMenuItem::with_id("), "Show Formatting Toolbar is a CheckMenuItem: {call}");
    assert_eq!(first_string_literal(call), Some("Show Formatting Toolbar"));
    assert!(squash(call).contains(",true,false,"), "enabled and unchecked at build (既定=隠す): {call}");
    assert!(last_argument(call).starts_with("None"), "no accelerator (4-5): {call}");
    assert_eq!(item_binding(&code, "SHOW_FORMAT_TOOLBAR_ITEM_ID"), "show_format_toolbar_item");
    assert_eq!(code.matches("\"Show Formatting Toolbar\"").count(), 1);

    let view = submenu_call_with_label(&code, "View").expect("menu.rs must build a \"View\" submenu");
    let idents = slice_idents(view);
    assert_eq!(idents, EXPECTED_VIEW, "View must hold these 15 entries: found {idents:?}");
    let raw_at = idents.iter().position(|i| *i == "raw_source_item").expect("Raw Source in View");
    assert_eq!(idents.get(raw_at + 1), Some(&"show_format_toolbar_item"), "right after Raw Source");
    let separators = separator_bindings(&code);
    assert_eq!(idents.iter().filter(|i| separators.contains(**i)).count(), 4, "View keeps its 4 separators");

    // lib.rs: 前面の窓へ(Raw Source と同じ形)・チェック印は窓からの状態で
    let lib = lib_rs_code();
    let block = on_menu_event_block(&lib);
    let arm = menu_arm_body(block, "SHOW_FORMAT_TOOLBAR_ITEM_ID");
    assert!(arm.contains("handle_menu_open_click("), "Show Formatting Toolbar arm calls handle_menu_open_click ({arm})");
    assert!(arm.contains("menu::MENU_SHOW_FORMAT_TOOLBAR_EVENT"), "arm emits menu::MENU_SHOW_FORMAT_TOOLBAR_EVENT ({arm})");
    assert!(lib.contains("menu::listen_format_toolbar_state(app.handle())"), "lib.rs subscribes the front window's toolbar state");
    assert!(code.contains("pub fn listen_format_toolbar_state("), "menu.rs defines listen_format_toolbar_state");
    let listener = fn_body(&code, "listen_format_toolbar_state");
    assert!(listener.contains("FORMAT_TOOLBAR_STATE_EVENT"), "listens FORMAT_TOOLBAR_STATE_EVENT ({listener})");
    // P3 R3: 前面の窓の判定は raw の M2 と同じ純関数 raw_check_applies を通る(focused_or_first_window だけで判定しない)
    assert!(listener.contains("raw_check_applies("), "the front-window check goes through the pure fn raw_check_applies (same as Raw Source, M2) ({listener})");
    assert!(listener.contains("SHOW_FORMAT_TOOLBAR_ITEM_ID") && listener.contains("set_checked("), "sets the check of Show Formatting Toolbar ({listener})");

    // フロントの定数(src/editor/format-toolbar.ts)
    let front = frontend("src/editor/format-toolbar.ts");
    assert_eq!(ts_string_const(&front, "MENU_SHOW_FORMAT_TOOLBAR_EVENT"), MENU_SHOW_FORMAT_TOOLBAR_EVENT);
    assert_eq!(ts_string_const(&front, "FORMAT_TOOLBAR_STATE_EVENT"), FORMAT_TOOLBAR_STATE_EVENT);
}

/// 9. 要件74 第2段 2-5(2026-11-17 仮・契約21・AC-74-46=要件側更新): Format と Raw Source はフラグなしで常に作る。`build` の本文に
///    `.remove(` も `is_enabled(` も無い。
#[test]
fn ac74_7_build_removes_format_and_raw_source_when_editor_file_is_off() {
    let code = menu_rs_code();
    let body = fn_body(&code, "build");
    assert!(!body.contains(".remove(&format_menu)") && !body.contains(".remove(&raw_source_item)"), "Format / Raw Source are always built: {body}");
    assert!(!body.contains(".remove("), "build removes nothing after the removal round");
    assert!(!body.contains("is_enabled(") && !body.contains("EDITOR_FILE") && !body.contains("EDITOR_INLINE"), "no flag in build: {body}");
    assert_eq!(code.matches(".remove(").count(), 1, "menu.rs: the only `.remove(` is rebuild_theme_items'");
}

/// 10. `emit_to_focused` は前面の窓(focused_or_first_window)へ payload 付きで emit_to。`handle_menu_open_click` はそのまま。
#[test]
fn ac74_7_emit_to_focused_sends_a_payload_to_the_focused_window() {
    let code = menu_rs_code();
    let body = fn_body(&code, "emit_to_focused");
    assert!(body.contains("focused_or_first_window("), "emit_to_focused picks the focused window: {body}");
    assert!(body.contains("emit_to("), "emit_to_focused uses emit_to (one window): {body}");
    assert!(body.contains("payload"), "emit_to_focused forwards the payload: {body}");
    let open_click = fn_body(&code, "handle_menu_open_click");
    assert!(open_click.contains("emit_to(") && open_click.contains("()"), "handle_menu_open_click keeps its empty payload");
}

/// 11. 判断 9 に依存: `listen_raw_source_state` は `app.listen(RAW_SOURCE_STATE_EVENT, …)` で `{ label, raw }` を読み、
///     前面の窓の label のときだけ `set_checked(` する(Tauri command は増やさない=AC-74-23 の 45 / 44 のまま)。
#[test]
fn ac74_7_listen_raw_source_state_sets_the_check_from_the_front_window() {
    let code = menu_rs_code();
    let body = fn_body(&code, "listen_raw_source_state");
    assert!(body.contains(".listen(") && body.contains("RAW_SOURCE_STATE_EVENT"), "listens for RAW_SOURCE_STATE_EVENT: {body}");
    assert!(body.contains("label"), "reads the label of the payload: {body}");
    assert!(body.contains("raw"), "reads the raw flag of the payload: {body}");
    assert!(body.contains("set_checked("), "sets the check of the Raw Source item: {body}");
    assert!(body.contains("focused_or_first_window(") || body.contains("get_focused_window(") || body.contains("is_focused("), "only the front window's value sets the check: {body}");
    let lib = lib_rs_code();
    assert!(lib.contains("menu::listen_raw_source_state("), "lib.rs setup must call menu::listen_raw_source_state once");
    assert_eq!(lib.matches("menu::listen_raw_source_state(").count(), 1);
    assert!(!lib.contains("set_raw_source_checked") && !lib.contains("raw_source_checked,"), "no new Tauri command for the check (判断 9)");
}

// ---------------------------------------------------------------------------
// AC-74-7 — lib.rs の on_menu_event
// ---------------------------------------------------------------------------

/// 12. `format-` で始まる ID は 1 つの腕で `emit_to_focused(app_handle, menu::MENU_FORMAT_EVENT, id)`(payload=ID)。
///     Raw Source は `handle_menu_open_click(app_handle, menu::MENU_RAW_SOURCE_EVENT)`。
#[test]
fn ac74_7_on_menu_event_routes_format_ids_and_raw_source_to_the_focused_window() {
    let lib = lib_rs_code();
    let block = on_menu_event_block(&lib);
    let format_arm_at = block.find("menu::FORMAT_ITEM_ID_PREFIX").expect("on_menu_event must have an arm using menu::FORMAT_ITEM_ID_PREFIX");
    let guard = &block[block[..format_arm_at].rfind("id if ").expect("prefix arm is a guard")..format_arm_at];
    assert!(guard.contains("starts_with(") , "the Format arm matches by prefix (starts_with): {guard}");
    let body = menu_arm_body(block, "FORMAT_ITEM_ID_PREFIX");
    assert!(body.contains("emit_to_focused("), "Format arm emits with emit_to_focused ({body})");
    assert!(body.contains("menu::MENU_FORMAT_EVENT"), "Format arm emits menu::MENU_FORMAT_EVENT ({body})");
    assert!(body.contains("id"), "Format arm forwards the id as the payload ({body})");
    assert_eq!(block.matches("menu::MENU_FORMAT_EVENT").count(), 1, "one arm for all Format items");

    let raw = menu_arm_body(block, "RAW_SOURCE_ITEM_ID");
    assert!(raw.contains("handle_menu_open_click("), "Raw Source arm calls handle_menu_open_click ({raw})");
    assert!(raw.contains("menu::MENU_RAW_SOURCE_EVENT"), "Raw Source arm emits menu::MENU_RAW_SOURCE_EVENT ({raw})");

    // Raw Source の腕は Format の接頭辞の腕に飲まれない(別の ID)。
    assert!(!RAW_SOURCE_ITEM_ID.starts_with(FORMAT_ITEM_ID_PREFIX));
    // Format の腕は、Appearance のテーマの接頭辞の腕と同じ形(`starts_with`)で、`_ =>` の前にある。
    let catch_all = block.rfind("_ =>").unwrap_or(block.len());
    assert!(format_arm_at < catch_all, "the Format arm sits before the catch-all");
}

/// 13. M2(reviewer 2026-11-17): `listen_raw_source_state` は前面の窓(`focused_or_first_window` か同等)の label と payload の
///     label を比べ、違えば `set_checked(` の前に `return` する(別の窓の raw の値で印を動かさない)。
#[test]
fn ac74_7_listen_raw_source_state_ignores_windows_that_are_not_in_front() {
    let code = menu_rs_code();
    let body = fn_body(&code, "listen_raw_source_state");
    let front_at = body
        .find("focused_or_first_window(")
        .or_else(|| body.find("get_focused_window("))
        .or_else(|| body.find("is_focused("))
        .expect("listen_raw_source_state must look up the front window");
    let set_at = body.find("set_checked(").expect("listen_raw_source_state must call set_checked(");
    assert!(front_at < set_at, "the front window is looked up before the check is set: {body}");
    let between = &body[front_at..set_at];
    assert!(between.contains("label"), "the payload's label is compared with the front window's: {between}");
    assert!(between.contains("return"), "a payload from another window returns before set_checked: {between}");
    assert!(
        between.contains("!=") || between.contains("==") || between.contains("if let") || between.contains("let Some"),
        "the comparison decides whether to set the check: {between}"
    );
    // 印は前面の窓の値だけで決まる=payload の raw をそのまま set_checked に渡す(反転・固定値ではない)
    let set_call = &body[set_at..set_at + body[set_at..].find(')').unwrap() + 1];
    assert!(set_call.contains("raw"), "set_checked takes the payload's raw: {set_call}");
    assert!(!set_call.contains("true)") && !set_call.contains("false)") && !set_call.contains("!"), "not a constant or a toggle: {set_call}");
}

/// 14. M2(オーケストレーター 2026-11-17・純関数で固定): `raw_check_applies(front, label)` の値の表。
#[test]
fn ac74_7_raw_check_applies_table() {
    assert!(raw_check_applies(Some("main"), "main"), "the front window's own report applies");
    assert!(!raw_check_applies(Some("main"), "win-2"), "another window's report does not");
    assert!(!raw_check_applies(None, "main"), "with no front window nothing applies");
    assert!(!raw_check_applies(Some("win-2"), "main"));
    assert!(raw_check_applies(Some("win-2"), "win-2"));
    assert!(!raw_check_applies(Some(""), "main"));
    assert!(!raw_check_applies(Some("main"), "Main"), "labels compare exactly");
}

/// 15. M2: `listen_raw_source_state` は `raw_check_applies(` を `set_checked(` より前に呼び、偽なら `return`
///     (`if !raw_check_applies(` … `return` の形)。前面の窓は `focused_or_first_window` で取る。判定の式を本文に直書きしない。
#[test]
fn ac74_7_listen_raw_source_state_decides_with_raw_check_applies() {
    let code = menu_rs_code();
    let body = fn_body(&code, "listen_raw_source_state");
    let applies_at = body.find("raw_check_applies(").expect("listen_raw_source_state must call raw_check_applies(");
    let set_at = body.find("set_checked(").expect("listen_raw_source_state must call set_checked(");
    assert!(applies_at < set_at, "raw_check_applies is decided before set_checked: {body}");
    assert_eq!(body.matches("raw_check_applies(").count(), 1, "one decision");
    let if_at = body[..applies_at].rfind("if ").expect("raw_check_applies sits in an `if`");
    let cond = squash(&body[if_at + 3..applies_at + "raw_check_applies(".len()]);
    assert_eq!(cond, "!raw_check_applies(", "the guard is `if !raw_check_applies(…)`: {cond}");
    let open = body[applies_at..].find('{').expect("if must have a block") + applies_at;
    let close = matching_close(&body, open);
    let block = squash(&body[open..=close]);
    assert!(block.contains("return"), "a report that does not apply returns: {block}");
    assert!(close < set_at, "the guard closes before set_checked: {body}");
    let call_close = matching_close(&body, applies_at + "raw_check_applies".len());
    let args = squash(&body[applies_at + "raw_check_applies(".len()..call_close]);
    assert!(args.contains("label"), "raw_check_applies takes the payload's label: {args}");
    assert!(body.contains("focused_or_first_window("), "the front window comes from focused_or_first_window: {body}");
    assert!(body[..applies_at].contains("focused_or_first_window("), "the front window is looked up before the decision");
    // 判定は純関数に出したので、本文に label の直比較を残さない。
    let direct = ["!=Some(label", "==Some(label", "front!=", "front=="];
    let squashed = squash(&body);
    for d in direct {
        assert!(!squashed.contains(d), "no inline comparison of the labels (use raw_check_applies): {d}");
    }
    // 純関数の本体= front == Some(label)
    let pure = squash(&fn_body(&code, "raw_check_applies"));
    assert!(pure == "front==Some(label)" || pure == "front.is_some_and(|f|f==label)" || pure.contains("==Some(label)"), "raw_check_applies is front == Some(label): {pure}");
}
