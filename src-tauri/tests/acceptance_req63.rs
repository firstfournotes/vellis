//! 要件#63 の受け入れテスト(docs/requirements/req-63.md)— Rust 層(メニュー不変のソース走査)
//!
//! 「エクスプローラー(ツリー)の文字も拡大縮小できる。操作はボディ側と同じ(Command + Plus /
//! Minus / 0)で、どちらを拡大するかは自動で判別する。タブで分けたときはタブごと」
//!
//! 本ファイルの持ち場= **AC-63-12(契約2・10)**: 本要件は View メニューに項目を足さず、Rust 側を
//! 変えない。判別はフロントが押された時点の状態で行う(メニューは「ズームして」とフォーカス中の
//! 窓へイベントを投げるだけ)。
//! - View メニューの項目列が周回開始時点(要件#62 追補b 後)の 8 項目
//!   `show_tab_bar_item, show_all_tabs_item, view_tab_sep, zoom_in_item, zoom_out_item,
//!   actual_size_item, view_sep, toggle_devtools` のまま(ソース走査)
//! - `MENU_ZOOM_` で始まる `pub const` が 3 つのまま(`MENU_ZOOM_IN_EVENT` / `MENU_ZOOM_OUT_EVENT` /
//!   `MENU_ZOOM_RESET_EVENT`)で、値も要件#36 の固定どおり
//! - 既存 `acceptance_req36.rs` が無改変で緑=reviewer 照合(ここでは判定しない)
//!
//! フロント側(判別・振り分け・保存・ツリーへの適用・本文側の目印・storage 購読の不在・print.css)は
//! `src/lib/zoom-target.acceptance.test.ts` と `src/components/Explorer.zoom.wiring.test.ts` が判定する。
//!
//! 人間ゲート 1〜7 に送った範囲(本ファイルでは判定しない): ポインタの位置で対象が切り替わる
//! 手応え・メニューをマウスで押したときの対象・拡縮したツリーの見た目と当たり判定・タブごとの
//! 独立・50% / 300% での崩れ。
//!
//! 本ファイルは「不変」を固定するので、実装前から緑である(意図どおり。赤になるのは本要件の
//! 実装が View メニューや `MENU_ZOOM_` 定数に手を入れたとき)。
//!
//! ソース走査が前提にする形(既存コードの家風・acceptance_req62a.rs と同じ読み方):
//! - View の Submenu は `Submenu::with_items(app, "View", true, &[&a, &b, …])?` で、項目スライスの
//!   識別子列をそのまま比べる

use vellis_lib::menu::{MENU_ZOOM_IN_EVENT, MENU_ZOOM_OUT_EVENT, MENU_ZOOM_RESET_EVENT};

// ---------------------------------------------------------------------------
// 共通ヘルパ — acceptance_req62a.rs と同じ流儀(コメント落とし・括弧の対応)
// ---------------------------------------------------------------------------

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

/// `pub const MENU_ZOOM_…` の宣言名(コード行・出現順)。
fn menu_zoom_const_names(code: &str) -> Vec<&str> {
    code.match_indices("pub const MENU_ZOOM_")
        .map(|(pos, _)| {
            let name_start = pos + "pub const ".len();
            let rest = &code[name_start..];
            let len = rest
                .find(|c: char| !(c.is_alphanumeric() || c == '_'))
                .unwrap_or(rest.len());
            &rest[..len]
        })
        .collect()
}

// ---------------------------------------------------------------------------
// AC-63-12 — View メニューの項目列(契約2・10・ソース走査)
// ---------------------------------------------------------------------------

/// 1. View メニューは周回開始時点の 8 項目そのまま(順序・束縛名まで一致=項目を足していない)。
#[test]
fn view_menu_keeps_the_eight_entries_from_before_req63() {
    let code = menu_rs_code();
    let view_menu = submenu_call_with_label(&code, "View")
        .expect("menu.rs must build a submenu labelled \"View\"");
    let idents = submenu_item_idents(view_menu);
    let expected = [
        "show_tab_bar_item",
        "show_all_tabs_item",
        "view_tab_sep",
        "zoom_in_item",
        "zoom_out_item",
        "actual_size_item",
        "view_sep",
        "toggle_devtools",
    ];
    assert_eq!(
        idents, expected,
        "requirement #63 must not add, remove or reorder View menu items (found {idents:?})"
    );
}

/// 2. View メニューはただ 1 つ(同じラベルの Submenu を別に組んでいない)。
#[test]
fn there_is_exactly_one_view_submenu() {
    let code = menu_rs_code();
    let mut count = 0;
    let mut search = 0;
    while let Some(rel) = code[search..].find("Submenu::with_") {
        let start = search + rel;
        let call = balanced_call(&code, start);
        search = start + "Submenu::with_".len();
        if first_string_literal(call) == Some("View") {
            count += 1;
        }
    }
    assert_eq!(count, 1, "menu.rs must build exactly one \"View\" submenu");
}

// ---------------------------------------------------------------------------
// AC-63-12 — `MENU_ZOOM_` 定数が 3 つのまま(契約2・10)
// ---------------------------------------------------------------------------

/// 3. `pub const MENU_ZOOM_…` は 3 つ(IN / OUT / RESET)のまま。ツリー用のイベントを足していない。
#[test]
fn menu_zoom_constants_are_still_exactly_three() {
    let code = menu_rs_code();
    let names = menu_zoom_const_names(&code);
    assert_eq!(
        names,
        ["MENU_ZOOM_IN_EVENT", "MENU_ZOOM_OUT_EVENT", "MENU_ZOOM_RESET_EVENT"],
        "menu.rs must declare exactly the three MENU_ZOOM_ constants of requirement #36 (found {names:?})"
    );
}

/// 4. 3 つの値は要件#36 の固定どおり(ペイロード無しのイベント名。フロントが押された側を決める)。
#[test]
fn menu_zoom_event_names_are_unchanged() {
    assert_eq!(MENU_ZOOM_IN_EVENT, "menu_zoom_in");
    assert_eq!(MENU_ZOOM_OUT_EVENT, "menu_zoom_out");
    assert_eq!(MENU_ZOOM_RESET_EVENT, "menu_zoom_reset");
}

/// 5. `menu_zoom_` で始まる文字列リテラルはコード行に 3 つだけ(定数の値以外に同系のイベントを
///    足していない=どちらを動かすかを Rust が知らないまま)。
#[test]
fn no_additional_menu_zoom_event_literal_in_menu_rs() {
    let code = menu_rs_code();
    let literals: Vec<&str> = code
        .match_indices("\"menu_zoom_")
        .map(|(pos, _)| {
            let start = pos + 1;
            let end = code[start..].find('"').expect("literal must close") + start;
            &code[start..end]
        })
        .collect();
    assert_eq!(
        literals,
        ["menu_zoom_in", "menu_zoom_out", "menu_zoom_reset"],
        "menu.rs must carry only the three menu_zoom_* event literals (found {literals:?})"
    );
}
