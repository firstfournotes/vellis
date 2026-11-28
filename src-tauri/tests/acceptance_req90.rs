//! 要件#90 の受け入れテスト(docs/requirements/req-90.md)— Rust 層(メニュー)
//! AC-90-1 View ▸ Alerts の項目とショートカット(契約1)・AC-90-7 のチェック印の同期(契約7)
//!
//! 「GitHub Alerts の枠を、画面の操作で隠す・出す・折り畳む」のうち、ネイティブのメニュー(menu.rs / lib.rs)の分。
//! muda のメニューは main thread と `AppHandle` が要るので、既存の acceptance_req74_menu.rs / req80.rs と同じ**ソース走査**と、
//! `vellis_lib::menu` の純関数の直接の呼び出しで固定する。フロントの分は `src/lib/alert-visibility.acceptance.test.ts`。
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```text
//! // --- src-tauri/src/menu.rs
//! pub const ALERTS_MENU_ID: &str = "alerts-menu";                       // View ▸ Alerts(Submenu::with_id_and_items)
//! pub const SHOW_ALL_ALERTS_ITEM_ID: &str = "show-all-alerts";          // "Show All Alerts"(MenuItem・全部隠れているときだけ有効)
//! pub const HIDE_ALL_ALERTS_ITEM_ID: &str = "hide-all-alerts";          // "Hide All Alerts"(MenuItem・どれか 1 種類でも出ているときだけ有効)
//! pub const TOGGLE_ALL_ALERTS_ACCELERATOR: &str = "CmdOrCtrl+Alt+A";    // Option + Command + A。Show All と Hide All の**両方**に付ける
//!                                                                        // (有効な方だけが鍵を受ける= AppKit の key equivalent の規則。
//!                                                                        // これで「どれか出ていれば全部隠す・全部隠れていれば全部出す」=契約1)
//! pub const ALERT_KIND_ITEM_ID_PREFIX: &str = "alerts-kind:";           // 種類のチェック項目の ID の頭。"alerts-kind:note" など
//! pub const ALERT_KINDS: [&str; 5] = ["note", "tip", "important", "warning", "caution"];   // 要件15 の 5 種・この順
//! pub const MENU_ALERTS_SHOW_ALL_EVENT: &str = "menu_alerts_show_all";       // Rust → 前面の窓(payload なし)
//! pub const MENU_ALERTS_HIDE_ALL_EVENT: &str = "menu_alerts_hide_all";       // Rust → 前面の窓(payload なし)
//! pub const MENU_ALERTS_TOGGLE_KIND_EVENT: &str = "menu_alerts_toggle_kind"; // Rust → 前面の窓(payload = 種類 "note" …)
//! pub const ALERTS_STATE_EVENT: &str = "alerts_state";                      // 窓 → Rust { label, visibility: { note: bool, … } }
//! pub fn alert_kind_item_id(kind: &str) -> String;                 // "alerts-kind:" + kind
//! pub fn alert_kind_of_item_id(id: &str) -> Option<&str>;          // 5 種のどれかの ID なら Some(kind)。それ以外(別の頭・知らない種類)は None
//! pub fn alert_kind_label(kind: &str) -> Option<&'static str>;     // "Note" / "Tip" / "Important" / "Warning" / "Caution"(チェック項目のラベル)
//! pub fn show_all_alerts_enabled(shown: &[bool]) -> bool;          // 全部隠れている(どれも true でない)ときだけ true
//! pub fn hide_all_alerts_enabled(shown: &[bool]) -> bool;          // どれか 1 つでも true なら true
//! fn alert_kind_item<R: Runtime>(app: &AppHandle<R>, kind: &str) -> tauri::Result<CheckMenuItem<R>>;
//!     // CheckMenuItem::with_id(app, alert_kind_item_id(kind), alert_kind_label(kind)…, true, true, None::<&str>)=既定は全部出す(チェック付き)
//! // build():
//!   let show_all_alerts_item = MenuItem::with_id(app, SHOW_ALL_ALERTS_ITEM_ID, "Show All Alerts", false, Some(TOGGLE_ALL_ALERTS_ACCELERATOR))?;
//!   let hide_all_alerts_item = MenuItem::with_id(app, HIDE_ALL_ALERTS_ITEM_ID, "Hide All Alerts", true, Some(TOGGLE_ALL_ALERTS_ACCELERATOR))?;
//!   let alerts_kind_sep = PredefinedMenuItem::separator(app)?;
//!   let alerts_note_item = alert_kind_item(app, "note")?;   … alerts_tip_item / alerts_important_item / alerts_warning_item / alerts_caution_item
//!   let alerts_menu = Submenu::with_id_and_items(app, ALERTS_MENU_ID, "Alerts", true, &[&show_all_alerts_item, &hide_all_alerts_item,
//!       &alerts_kind_sep, &alerts_note_item, &alerts_tip_item, &alerts_important_item, &alerts_warning_item, &alerts_caution_item])?;
//!   // View は 16 項目: … raw_source_item, show_format_toolbar_item, alerts_menu, view_chrome_sep, …(Show Formatting Toolbar の直後)
//! pub fn listen_alerts_state(app: &AppHandle<Wry>);
//!   // app.listen(ALERTS_STATE_EVENT, …) → payload の visibility を読み、5 つのチェック項目を set_checked(出す=true)、
//!   // Show All を set_enabled(show_all_alerts_enabled(…))・Hide All を set_enabled(hide_all_alerts_enabled(…))。
//!   // Alerts は View の 2 段下なので、項目の探し方は find_check_menu_item(1 段)では届かない=再帰か Alerts の Submenu を経由する
//! // --- src-tauri/src/lib.rs
//!   setup: menu::listen_alerts_state(app.handle()) を 1 回
//!   on_menu_event:
//!     id if id == menu::SHOW_ALL_ALERTS_ITEM_ID => menu::handle_menu_open_click(app_handle, menu::MENU_ALERTS_SHOW_ALL_EVENT)
//!     id if id == menu::HIDE_ALL_ALERTS_ITEM_ID => menu::handle_menu_open_click(app_handle, menu::MENU_ALERTS_HIDE_ALL_EVENT)
//!     id if let Some(kind) = menu::alert_kind_of_item_id(id) … => menu::emit_to_focused(app_handle, menu::MENU_ALERTS_TOGGLE_KIND_EVENT, kind.to_string())
//!       (種類の項目は muda の自動反転をそのまま使い、窓の alerts_state の知らせで set_checked し直す。revert_check_toggle は呼ばない=
//!        acceptance_req74_menu_check_revert.rs の「2 つの腕だけ」を保つ)
//! ```
//!
//! ## 判断の記録(test-writer 2026-11-26)
//! - 「Option + Command + A は全部の切り替え」を、専用の項目を増やさずに Show All / Hide All の 2 項目に同じアクセラレータを付け、
//!   有効な方だけに鍵が届く形で実現する(契約1 の項目の並びをそのまま保てる。別案=「Toggle All Alerts」の項目を足す / フロントの
//!   keydown で受ける=メニューに鍵の表示が出ない)。menu.rs の文字列リテラルとしては 1 つなので AC-60-19 / AC-80-4 の重複検査は緑
//! - 有効の切り替えは窓からの `alerts_state`(契約7 の知らせ)で行う。設定はアプリ全体で 1 値なので、どの窓の知らせでも同じ値
//! - 種類の項目は 5 つとも同じ形なので helper `alert_kind_item` で作る(CheckMenuItem::with_id の字面は menu.rs に 1 つ増えるだけ)
//!
//! ## 既存テストへの影響(オーケストレーターの要件側更新が要る=このテストと両立しない既存の固定)
//! - acceptance_req80.rs と acceptance_req74_menu.rs の `EXPECTED_VIEW`(15 項目)→ `alerts_menu` を show_format_toolbar_item の直後に足して 16
//! - acceptance_req74_menu.rs:769 「CheckMenuItem::with_id( は 2 つ」→ 3(alert_kind_item の分)
//!
//! ## 修正前に赤になる理由
//! - `vellis_lib::menu` に ALERTS_* / alert_kind_* が無いのでコンパイルで落ちる(=このバイナリ全体が赤)

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::str::FromStr;

use muda::accelerator::Accelerator;
use vellis_lib::menu::{
    alert_kind_item_id, alert_kind_label, alert_kind_of_item_id, hide_all_alerts_enabled, show_all_alerts_enabled,
    ALERTS_MENU_ID, ALERTS_STATE_EVENT, ALERT_KINDS, ALERT_KIND_ITEM_ID_PREFIX, HIDE_ALL_ALERTS_ITEM_ID,
    MENU_ALERTS_HIDE_ALL_EVENT, MENU_ALERTS_SHOW_ALL_EVENT, MENU_ALERTS_TOGGLE_KIND_EVENT, RAW_SOURCE_ACCELERATOR,
    SHOW_ALL_ALERTS_ITEM_ID, TOGGLE_ALL_ALERTS_ACCELERATOR,
};

// ---------------------------------------------------------------------------
// 共通ヘルパ — acceptance_req80.rs / req74_menu.rs と同じ流儀(コメント落とし・括弧の対応)
// ---------------------------------------------------------------------------

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// 無いファイルは空文字(=その上のアサートが赤になる)。
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

/// `src/lib/alert-visibility.ts`(フロントの正本)。無ければ空=AC-90-1 の突き合わせが赤になる。
fn alert_visibility_ts() -> String {
    read_source_or_empty("../src/lib/alert-visibility.ts")
}

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

fn balanced_call(code: &str, start: usize) -> &str {
    let open = code[start..].find('(').expect("call must have '('") + start;
    let close = matching_close(code, open);
    &code[start..=close]
}

fn first_string_literal(s: &str) -> Option<&str> {
    let a = s.find('"')? + 1;
    let b = s[a..].find('"')? + a;
    Some(&s[a..b])
}

fn arguments(call: &str) -> Vec<&str> {
    let open = call.find('(').expect("call must have '('");
    let inner = &call[open + 1..call.len() - 1];
    inner.split(',').map(str::trim).filter(|s| !s.is_empty()).collect()
}

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

fn submenu_item_idents(call: &str) -> Vec<&str> {
    let slice_open = call.find("&[").expect("submenu must take an item slice");
    let slice_end = matching_close(call, slice_open + 1);
    call[slice_open + 2..slice_end]
        .split(',')
        .map(|s| s.trim().trim_start_matches('&'))
        .filter(|s| !s.is_empty())
        .collect()
}

fn menu_item_call_using<'a>(code: &'a str, const_name: &str) -> Option<&'a str> {
    let mut search = 0;
    while let Some(rel) = code[search..].find("MenuItem::with_id(") {
        let start = search + rel;
        // `CheckMenuItem::with_id(` も `MenuItem::with_id(` を含むので、素の MenuItem だけを拾う
        let is_check = start >= 5 && &code[start - 5..start] == "Check";
        let call = balanced_call(code, start);
        search = start + "MenuItem::with_id(".len();
        if !is_check && call.contains(const_name) {
            return Some(call);
        }
    }
    None
}

fn let_binding_before<'a>(code: &'a str, use_pos: usize, what: &str) -> &'a str {
    let let_pos = code[..use_pos]
        .rfind("let ")
        .unwrap_or_else(|| panic!("{what} must be used inside a let binding"));
    code[let_pos + 4..use_pos]
        .split(|c: char| c == '=' || c.is_whitespace())
        .find(|s| !s.is_empty())
        .expect("binding name after `let`")
}

fn separator_bindings(code: &str) -> BTreeSet<&str> {
    code.match_indices("PredefinedMenuItem::separator(")
        .map(|(pos, _)| let_binding_before(code, pos, "PredefinedMenuItem::separator"))
        .collect()
}

fn str_const<'a>(code: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("pub const {name}: &str = \"");
    let start = code.find(&needle)? + needle.len();
    let end = code[start..].find('"')? + start;
    Some(&code[start..end])
}

fn fn_decl_start(code: &str, name: &str) -> Option<usize> {
    let paren = format!("fn {name}(");
    let generic = format!("fn {name}<");
    code.find(&paren).or_else(|| code.find(&generic))
}

/// `fn name(…) { … }` の本体(中括弧の中)。
fn fn_body(code: &str, name: &str) -> String {
    let start = fn_decl_start(code, name).unwrap_or_else(|| panic!("source must define `fn {name}(` (or `fn {name}<`)"));
    let params_open = code[start..].find('(').expect("fn must take parameters") + start;
    let params_close = matching_close(code, params_open);
    let open = code[params_close..].find('{').expect("fn must have a body") + params_close;
    let close = matching_close(code, open);
    code[open + 1..close].to_string()
}

fn on_menu_event_block(code: &str) -> &str {
    let start = code.find("on_menu_event(").expect("lib.rs must call on_menu_event");
    balanced_call(code, start)
}

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

/// `export const NAME = '…'` の文字列リテラルの中身(acceptance_req80.rs の写し)。
fn ts_string_const(src: &str, name: &str) -> String {
    let marker = format!("export const {name}");
    let at = src
        .find(&marker)
        .unwrap_or_else(|| panic!("src/lib/alert-visibility.ts must `{marker}` (AC-90-1)"));
    let rest = &src[at + marker.len()..];
    let eq = rest.find('=').expect("`=` after the const name");
    let after = rest[eq + 1..].trim_start();
    let quote = after.chars().next().expect("a quoted string");
    assert!(quote == '\'' || quote == '"' || quote == '`', "{name} must be a string literal, got {after:?}");
    let body = &after[quote.len_utf8()..];
    let end = body.find(quote).expect("closing quote");
    body[..end].to_string()
}

fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

// 要件側更新(2026-11-26・要件#90 契約1): Show Formatting Toolbar の直後に `alerts_menu`(View ▸ Alerts ▸)。15 → 16。
// 要件91(2026-11-27)で改めた(docs/requirements/req-91.md「要件側の更新」): Alerts の直後に `show_spectrum_item`(View ▸ Show Audio Spectrum)。16 → 17。
const EXPECTED_VIEW: [&str; 17] = [
    "show_tab_bar_item",
    "show_all_tabs_item",
    "view_tab_sep",
    "reload_file_item",
    "view_reload_sep",
    "appearance_menu",
    "toggle_full_width_item",
    "raw_source_item",
    "show_format_toolbar_item",
    "alerts_menu",
    "show_spectrum_item",
    "view_chrome_sep",
    "zoom_in_item",
    "zoom_out_item",
    "actual_size_item",
    "view_sep",
    "toggle_devtools",
];

const EXPECTED_ALERTS: [&str; 8] = [
    "show_all_alerts_item",
    "hide_all_alerts_item",
    "alerts_kind_sep",
    "alerts_note_item",
    "alerts_tip_item",
    "alerts_important_item",
    "alerts_warning_item",
    "alerts_caution_item",
];

// ---------------------------------------------------------------------------
// AC-90-1 — 定数(契約1)
// ---------------------------------------------------------------------------

/// 1. 定数は値固定(ID・イベント名・アクセラレータ・種類の順)。
#[test]
fn ac90_1_constants_are_fixed() {
    assert_eq!(ALERTS_MENU_ID, "alerts-menu");
    assert_eq!(SHOW_ALL_ALERTS_ITEM_ID, "show-all-alerts");
    assert_eq!(HIDE_ALL_ALERTS_ITEM_ID, "hide-all-alerts");
    assert_eq!(ALERT_KIND_ITEM_ID_PREFIX, "alerts-kind:");
    assert_eq!(TOGGLE_ALL_ALERTS_ACCELERATOR, "CmdOrCtrl+Alt+A");
    assert_eq!(MENU_ALERTS_SHOW_ALL_EVENT, "menu_alerts_show_all");
    assert_eq!(MENU_ALERTS_HIDE_ALL_EVENT, "menu_alerts_hide_all");
    assert_eq!(MENU_ALERTS_TOGGLE_KIND_EVENT, "menu_alerts_toggle_kind");
    assert_eq!(ALERTS_STATE_EVENT, "alerts_state");
    assert_eq!(ALERT_KINDS, ["note", "tip", "important", "warning", "caution"]);
    let code = menu_rs_code();
    for (name, value) in [
        ("ALERTS_MENU_ID", "alerts-menu"),
        ("SHOW_ALL_ALERTS_ITEM_ID", "show-all-alerts"),
        ("HIDE_ALL_ALERTS_ITEM_ID", "hide-all-alerts"),
        ("ALERT_KIND_ITEM_ID_PREFIX", "alerts-kind:"),
        ("TOGGLE_ALL_ALERTS_ACCELERATOR", "CmdOrCtrl+Alt+A"),
        ("MENU_ALERTS_SHOW_ALL_EVENT", "menu_alerts_show_all"),
        ("MENU_ALERTS_HIDE_ALL_EVENT", "menu_alerts_hide_all"),
        ("MENU_ALERTS_TOGGLE_KIND_EVENT", "menu_alerts_toggle_kind"),
        ("ALERTS_STATE_EVENT", "alerts_state"),
    ] {
        assert_eq!(str_const(&code, name), Some(value), "menu.rs must declare `pub const {name}: &str = \"{value}\";`");
    }
}

/// 2. アクセラレータは muda が parse でき、Option + Command + A そのもの。Raw Source(Option + Command + U)とは別。
///    menu.rs の中で Option + Command + A のリテラルは 1 つだけ(2 項目は同じ定数を渡す)で、ほかと重ならない。
#[test]
fn ac90_1_accelerator_is_option_command_a_registered_once_without_collision() {
    let parsed = Accelerator::from_str(TOGGLE_ALL_ALERTS_ACCELERATOR)
        .unwrap_or_else(|e| panic!("TOGGLE_ALL_ALERTS_ACCELERATOR must parse: {e}"));
    assert_eq!(parsed, Accelerator::from_str("CmdOrCtrl+Alt+A").expect("CmdOrCtrl+Alt+A parses"));
    assert_ne!(parsed, Accelerator::from_str(RAW_SOURCE_ACCELERATOR).expect("RAW_SOURCE_ACCELERATOR parses"));

    let code = menu_rs_code();
    let all: Vec<(String, Accelerator)> = menu_rs_string_literals(&code)
        .into_iter()
        .filter(|s| s.contains('+'))
        .filter_map(|s| Accelerator::from_str(&s).ok().map(|a| (s, a)))
        .collect();
    let count = all.iter().filter(|(_, a)| *a == parsed).count();
    assert_eq!(count, 1, "menu.rs must register Option + Command + A exactly once as a literal (found {count})");
    for (i, (raw_a, acc_a)) in all.iter().enumerate() {
        for (raw_b, acc_b) in all.iter().skip(i + 1) {
            assert!(acc_a != acc_b, "duplicate accelerator in menu.rs: '{raw_a}' collides with '{raw_b}'");
        }
    }
}

// ---------------------------------------------------------------------------
// AC-90-1 — 純関数(ID と種類・ラベル・有効の規則)
// ---------------------------------------------------------------------------

/// 3. 種類 ⇄ ID の往復。5 種以外・別の頭は None。
#[test]
fn ac90_1_kind_item_ids_round_trip_for_the_five_kinds_only() {
    for kind in ALERT_KINDS {
        let id = alert_kind_item_id(kind);
        assert_eq!(id, format!("alerts-kind:{kind}"));
        assert!(id.starts_with(ALERT_KIND_ITEM_ID_PREFIX));
        assert_eq!(alert_kind_of_item_id(&id), Some(kind), "{id} must map back to {kind}");
    }
    for bad in ["alerts-kind:foo", "alerts-kind:", "alerts-kind:NOTE", "format-alert-note", "note", "", "show-all-alerts"] {
        assert_eq!(alert_kind_of_item_id(bad), None, "{bad:?} is not a kind item id");
    }
}

/// 4. チェック項目のラベルは英語の正規形(要件15 のタイトルと同じ綴り)。知らない種類は None。
#[test]
fn ac90_1_kind_labels_are_the_english_canonical_forms() {
    assert_eq!(alert_kind_label("note"), Some("Note"));
    assert_eq!(alert_kind_label("tip"), Some("Tip"));
    assert_eq!(alert_kind_label("important"), Some("Important"));
    assert_eq!(alert_kind_label("warning"), Some("Warning"));
    assert_eq!(alert_kind_label("caution"), Some("Caution"));
    assert_eq!(alert_kind_label("foo"), None);
    assert_eq!(alert_kind_label("Note"), None);
}

/// 5. 契約1 の規則: どれか 1 種類でも出ていれば Hide All が有効(Show All は無効)、全部隠れていれば Show All が有効(Hide All は無効)。
#[test]
fn ac90_1_toggle_rule_enables_exactly_one_of_show_all_and_hide_all() {
    let all_shown = [true, true, true, true, true];
    let all_hidden = [false, false, false, false, false];
    let one_shown = [false, false, false, true, false];
    assert!(!show_all_alerts_enabled(&all_shown));
    assert!(hide_all_alerts_enabled(&all_shown));
    assert!(show_all_alerts_enabled(&all_hidden));
    assert!(!hide_all_alerts_enabled(&all_hidden));
    assert!(!show_all_alerts_enabled(&one_shown), "one kind shown: the key hides all, so Show All stays disabled");
    assert!(hide_all_alerts_enabled(&one_shown));
    for shown in [all_shown, all_hidden, one_shown] {
        assert_ne!(
            show_all_alerts_enabled(&shown),
            hide_all_alerts_enabled(&shown),
            "exactly one of the two items takes the key for {shown:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// AC-90-1 — View ▸ Alerts の並び(契約1・ソース走査)
// ---------------------------------------------------------------------------

/// 6. View は Show Formatting Toolbar の直後に `alerts_menu`(束縛名まで一致。16 項目 → 要件91 で 17 項目)。
#[test]
fn ac90_1_view_menu_holds_alerts_right_after_show_formatting_toolbar() {
    let code = menu_rs_code();
    let view = submenu_call_with_label(&code, "View").expect("menu.rs must build a \"View\" submenu");
    let idents = submenu_item_idents(view);
    assert_eq!(idents, EXPECTED_VIEW, "the View menu must hold exactly these 17 entries in this order (要件91 adds show_spectrum_item after Alerts): found {idents:?}");
}

/// 7. Alerts = Submenu::with_id_and_items(app, ALERTS_MENU_ID, "Alerts", true, &[Show All / Hide All / ─ / Note / Tip / Important / Warning / Caution]).
#[test]
fn ac90_1_alerts_submenu_is_built_with_its_id_and_the_eight_entries() {
    let code = menu_rs_code();
    let call = submenu_call_with_label(&code, "Alerts").expect("menu.rs must build an \"Alerts\" submenu");
    assert!(call.starts_with("Submenu::with_id_and_items("), "Alerts must be built with Submenu::with_id_and_items (found {call})");
    let args = arguments(call);
    assert_eq!(args.get(1).copied(), Some("ALERTS_MENU_ID"), "the id must be the constant: {call}");
    assert_eq!(args.get(2).copied(), Some("\"Alerts\""), "the label is \"Alerts\": {call}");
    assert_eq!(args.get(3).copied(), Some("true"), "the submenu is enabled: {call}");
    let use_pos = call.as_ptr() as usize - code.as_ptr() as usize;
    assert_eq!(let_binding_before(&code, use_pos, "Alerts submenu"), "alerts_menu");
    let idents = submenu_item_idents(call);
    assert_eq!(idents, EXPECTED_ALERTS, "View ▸ Alerts must hold exactly these 8 entries: found {idents:?}");
    assert!(separator_bindings(&code).contains("alerts_kind_sep"), "`alerts_kind_sep` must be a PredefinedMenuItem::separator binding");
}

/// 8. Show All Alerts / Hide All Alerts は MenuItem::with_id で定数から作り、**両方**に Some(TOGGLE_ALL_ALERTS_ACCELERATOR)。
///    build の時点は既定(全部出す)なので Show All は無効・Hide All は有効。
#[test]
fn ac90_1_show_all_and_hide_all_share_the_toggle_accelerator_and_start_from_all_shown() {
    let code = menu_rs_code();
    for (const_name, label, enabled, binding) in [
        ("SHOW_ALL_ALERTS_ITEM_ID", "Show All Alerts", "false", "show_all_alerts_item"),
        ("HIDE_ALL_ALERTS_ITEM_ID", "Hide All Alerts", "true", "hide_all_alerts_item"),
    ] {
        let call = menu_item_call_using(&code, const_name)
            .unwrap_or_else(|| panic!("menu.rs must build a MenuItem::with_id(... {const_name} ...)"));
        let use_pos = call.as_ptr() as usize - code.as_ptr() as usize;
        assert_eq!(let_binding_before(&code, use_pos, const_name), binding);
        let args = arguments(call);
        assert_eq!(args.len(), 5, "MenuItem::with_id takes 5 arguments: {call}");
        assert_eq!(args[1], const_name, "the ID must be the constant: {call}");
        assert_eq!(args[2], format!("\"{label}\""), "the label is \"{label}\": {call}");
        assert_eq!(args[3], enabled, "{label} starts {} (the default is all shown): {call}", if enabled == "true" { "enabled" } else { "disabled" });
        assert_eq!(args[4], "Some(TOGGLE_ALL_ALERTS_ACCELERATOR)", "{label} carries the toggle accelerator: {call}");
        assert!(!call.contains("\"CmdOrCtrl+Alt+A\""), "no inline accelerator literal: {call}");
    }
    let literals = menu_rs_string_literals(&code);
    assert_eq!(literals.iter().filter(|s| s.as_str() == "Show All Alerts").count(), 1);
    assert_eq!(literals.iter().filter(|s| s.as_str() == "Hide All Alerts").count(), 1);
}

/// 9. 種類のチェック項目は helper `alert_kind_item(app, kind)` で作る: CheckMenuItem::with_id(…, alert_kind_item_id(kind), alert_kind_label(kind)…, true, true, None::<&str>)。
///    5 つの束縛は `let alerts_<kind>_item = alert_kind_item(app, "<kind>")?;`。
#[test]
fn ac90_1_kind_check_items_are_built_by_one_helper_checked_by_default() {
    let code = menu_rs_code();
    let body = fn_body(&code, "alert_kind_item");
    assert!(body.contains("CheckMenuItem::with_id("), "alert_kind_item builds a CheckMenuItem ({body})");
    assert!(body.contains("alert_kind_item_id("), "the id comes from alert_kind_item_id ({body})");
    assert!(body.contains("alert_kind_label("), "the label comes from alert_kind_label ({body})");
    let squashed = squash(&body);
    assert!(
        squashed.contains(",true,true,None::<&str>)"),
        "the kind item is enabled, checked (all shown by default) and has no accelerator ({body})"
    );
    let all = squash(&code);
    for kind in ALERT_KINDS {
        let expected = format!("letalerts_{kind}_item=alert_kind_item(app,\"{kind}\")");
        assert!(all.contains(&expected), "menu.rs must bind `let alerts_{kind}_item = alert_kind_item(app, \"{kind}\")`");
    }
}

// ---------------------------------------------------------------------------
// AC-90-1 — lib.rs の配線(契約1・ソース走査)
// ---------------------------------------------------------------------------

/// 10. Show All / Hide All の腕は前面の窓へ `handle_menu_open_click`(payload なし)。
#[test]
fn ac90_1_lib_rs_dispatches_show_all_and_hide_all_to_the_focused_window() {
    let lib = lib_rs_code();
    let block = on_menu_event_block(&lib);
    for (id, event) in [
        ("SHOW_ALL_ALERTS_ITEM_ID", "MENU_ALERTS_SHOW_ALL_EVENT"),
        ("HIDE_ALL_ALERTS_ITEM_ID", "MENU_ALERTS_HIDE_ALL_EVENT"),
    ] {
        let body = menu_arm_body(block, id);
        assert!(
            squash(body).contains(&format!("menu::handle_menu_open_click(app_handle,menu::{event})")),
            "the {id} arm must call menu::handle_menu_open_click(app_handle, menu::{event}) ({body})"
        );
        assert_eq!(block.matches(&format!("menu::{id}")).count(), 1, "on_menu_event dispatches {id} exactly once");
    }
}

/// 11. 種類の腕は `alert_kind_of_item_id` で種類を取り、`emit_to_focused(app_handle, MENU_ALERTS_TOGGLE_KIND_EVENT, kind)`。
///     チェックは窓の alerts_state で直すので revert_check_toggle は呼ばない(acceptance_req74_menu_check_revert.rs の 2 つのまま)。
#[test]
fn ac90_1_lib_rs_dispatches_a_kind_item_as_toggle_kind_with_the_kind_as_payload() {
    let lib = lib_rs_code();
    let block = on_menu_event_block(&lib);
    assert!(block.contains("menu::alert_kind_of_item_id("), "on_menu_event must recognise kind items through menu::alert_kind_of_item_id");
    assert!(block.contains("menu::MENU_ALERTS_TOGGLE_KIND_EVENT"), "on_menu_event must emit menu::MENU_ALERTS_TOGGLE_KIND_EVENT");
    assert!(
        squash(block).contains("menu::emit_to_focused(app_handle,menu::MENU_ALERTS_TOGGLE_KIND_EVENT"),
        "the kind arm emits through emit_to_focused(app_handle, menu::MENU_ALERTS_TOGGLE_KIND_EVENT, <kind>) with the kind as payload"
    );
    assert_eq!(block.matches("revert_check_toggle(").count(), 2, "the kind items do not revert the check (the window's alerts_state sets it)");
}

// ---------------------------------------------------------------------------
// AC-90-7 — チェック印と有効の同期(契約7・ソース走査)
// ---------------------------------------------------------------------------

/// 12. `listen_alerts_state` は alerts_state を受け、5 つのチェックを set_checked し、Show All / Hide All を規則どおり set_enabled。setup で 1 回購読。
#[test]
fn ac90_7_listen_alerts_state_sets_the_checks_and_the_enabled_items() {
    let code = menu_rs_code();
    assert!(code.contains("pub fn listen_alerts_state("), "menu.rs defines pub fn listen_alerts_state");
    let body = fn_body(&code, "listen_alerts_state");
    assert!(body.contains("ALERTS_STATE_EVENT"), "subscribes ALERTS_STATE_EVENT ({body})");
    assert!(body.contains("set_checked("), "sets the checks of the kind items ({body})");
    assert!(body.contains("alert_kind_item_id(") || body.contains("ALERT_KIND_ITEM_ID_PREFIX"), "finds the kind items by their ids ({body})");
    assert!(body.contains("set_enabled("), "enables / disables Show All and Hide All ({body})");
    assert!(body.contains("SHOW_ALL_ALERTS_ITEM_ID") && body.contains("HIDE_ALL_ALERTS_ITEM_ID"), "touches both all-items ({body})");
    assert!(body.contains("show_all_alerts_enabled(") && body.contains("hide_all_alerts_enabled("), "the enabled rule is the pure one ({body})");
    let lib = lib_rs_code();
    assert_eq!(lib.matches("menu::listen_alerts_state(app.handle())").count(), 1, "lib.rs setup subscribes the alerts state once");
}

// ---------------------------------------------------------------------------
// AC-90-1 — フロントとの一致
// ---------------------------------------------------------------------------

/// 13. `src/lib/alert-visibility.ts` の 4 つのイベント名は Rust と同じ値。
#[test]
fn ac90_1_front_end_event_names_match_menu_rs() {
    let ts = alert_visibility_ts();
    assert!(!ts.is_empty(), "src/lib/alert-visibility.ts must exist");
    assert_eq!(ts_string_const(&ts, "MENU_ALERTS_SHOW_ALL_EVENT"), MENU_ALERTS_SHOW_ALL_EVENT);
    assert_eq!(ts_string_const(&ts, "MENU_ALERTS_HIDE_ALL_EVENT"), MENU_ALERTS_HIDE_ALL_EVENT);
    assert_eq!(ts_string_const(&ts, "MENU_ALERTS_TOGGLE_KIND_EVENT"), MENU_ALERTS_TOGGLE_KIND_EVENT);
    assert_eq!(ts_string_const(&ts, "ALERTS_STATE_EVENT"), ALERTS_STATE_EVENT);
}
