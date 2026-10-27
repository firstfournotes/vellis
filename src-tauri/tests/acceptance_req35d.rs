//! 要件#35 追補d の受け入れテスト(docs/requirements/req-35.md「追補d」・Issue #720・#721)
//!
//! #720: CLI の導入の成功ダイアログで、契約3 の本文の行頭の空白 2 つが画面では落ちる。親の窓の
//! 無い rfd のメッセージは `CFUserNotificationDisplayAlert` で、システムの UserNotificationCenter が
//! 表示し、そこで行頭の空白が落ちる。
//! #721: 結果のダイアログ(成功・失敗とも)は `blocking_show` で、メニューのイベント(メイン
//! スレッド)の上で閉じられるまで待つ。表示中はアプリのすべての窓が固まり、Quit も効かない。
//! 由谷の決定(2026-10-25)= **前面の文書の窓のシートとして出す**(`.parent(&window)` を渡した
//! `show(callback)`。2 件とも解ける)。
//!
//! 契約(追補d):
//! 1. `handle_install_cli_click` の結果のダイアログ(成功・失敗とも)は `MessageDialogBuilder::show(callback)`
//!    で出す。`menu.rs` に `blocking_show` を残さない。親の窓が決まれば `.parent(&window)` を渡す。
//!    決まらなければ親なしの `show`
//! 2. `menu.rs` に純関数 `pub fn install_cli_dialog_parent<'a>(windows: &[(&'a str, bool, bool)]) -> Option<&'a str>`
//!    を置く。要素は (label, フォーカスがある, 見えていて最小化されていない)。印刷窓
//!    (`crate::print::is_print_window`)は選ばない。順は「フォーカスのある文書の窓 → 見えていて
//!    最小化されていない文書の窓のうち最初のもの → `None`」
//! 3. 二度押し: 要件67 契約10(`CHECK_FOR_UPDATES_IN_FLIGHT`)と同じ形= `AtomicBool` を
//!    `compare_exchange` で立ててから `install_cli()` を呼び、`Drop` で下ろす値をダイアログの
//!    callback に持たせて、閉じたときに下ろす
//! 4. 不変: 本文・題 `Vellis CLI`・kind・`install_cli()` / `install_cli_for` の判定と文言・
//!    `--install-cli`・AC-35-8・`focused_or_first_window` とその呼び出し元。依存の追加なし
//!
//! 受け入れ基準 AC-35-追d(本ファイルの持ち場):
//!   (a) `install_cli_dialog_parent` の表:
//!       - フォーカスのある文書の窓が選ばれる(ほかに見えている窓があっても)
//!         → `ac35d_a_focused_document_window_wins_over_other_visible_windows`
//!       - フォーカスが印刷窓にあり文書の窓が見えていれば文書の窓
//!         → `ac35d_a_focused_print_window_yields_to_a_visible_document_window`
//!       - フォーカスが無ければ見えている文書の窓のうち最初
//!         → `ac35d_a_without_focus_the_first_visible_document_window_is_chosen`
//!       - 文書の窓がどれも見えない(隠れている・最小化)なら `None`
//!         → `ac35d_a_no_visible_document_window_is_none`
//!       - 印刷窓だけなら `None` → `ac35d_a_print_windows_only_is_none`
//!       - 空なら `None` → `ac35d_a_empty_is_none`
//!       - 契約2 の型(返り値はラベルの寿命を借りる)
//!         → `ac35d_a_install_cli_dialog_parent_has_the_contracted_signature`
//!   (b) ソース走査: `menu.rs` の本文(`#[cfg(test)]` より前・行コメントを除く)に `blocking_show`
//!       が無い。`handle_install_cli_click` の本体に `install_cli_dialog_parent(`・`.parent(`・
//!       `.show(` がある
//!       → `ac35d_b_menu_rs_has_no_blocking_show_and_the_handler_parents_and_shows`
//!   (c) ソース走査: `handle_install_cli_click` の本体で、`compare_exchange` が `install_cli(` より
//!       前にある。その `AtomicBool` を下ろす `impl Drop` がある。`.show(` の callback(閉包)が
//!       その値を持つ(閉包の中にその値の名前が出る)
//!       → `ac35d_c_in_flight_flag_is_raised_before_install_cli_and_released_by_a_guard_in_the_callback`
//!   (d) 既存の AC-35-追b(e)・AC-35-8 などは無改変で緑(本文と題が変わらない)=同じ周回の
//!       フルスイートで確かめる(本ファイルでは重ねない)
//!
//! ## 確定契約(公開 API・implementer はこれに従う)
//!
//! ```ignore
//! // src-tauri/src/menu.rs
//! /// 結果のダイアログの親の窓(純関数)。`windows` は (label, フォーカスがある,
//! /// 見えていて最小化されていない) の並び(`app.webview_windows()` の順)。
//! /// - 印刷窓(`crate::print::is_print_window`)は選ばない
//! /// - フォーカスのある文書の窓があればそれ
//! /// - 無ければ、見えていて最小化されていない文書の窓のうち最初のもの
//! /// - それも無ければ None(親なしの show)
//! pub fn install_cli_dialog_parent<'a>(windows: &[(&'a str, bool, bool)]) -> Option<&'a str>;
//!
//! /// 既存。AtomicBool を compare_exchange で立て(立っていれば何もしない)、Drop で下ろす値を
//! /// 作ってから install_cli() を呼ぶ。app.webview_windows() から (label, is_focused,
//! /// is_visible && !is_minimized) の表を作り(Err は偽)install_cli_dialog_parent で親を選び、
//! /// 決まれば .parent(&window) を渡して .show(callback) で出す。callback が Drop の値を持つ。
//! pub fn handle_install_cli_click(app: &AppHandle<Wry>);
//! ```
//!
//! ## reviewer 照合に委ねる配線(AppHandle 依存で機械判定不能)
//! - `handle_install_cli_click` が `app.webview_windows()` の全窓を
//!   (label, `is_focused()`, `is_visible() && !is_minimized()`)に写し(`Err` は偽)、その表を
//!   `install_cli_dialog_parent` に渡していること・選ばれた label の窓を `.parent(&window)` に
//!   渡していること・`None` のときは `.parent` を付けずに `show` していること
//! - 二度押しの `AtomicBool` が `CHECK_FOR_UPDATES_IN_FLIGHT` とは別の static であること
//!   (本テストは「`compare_exchange` の受け手の static を `impl Drop` が下ろす」ことだけを見る)
//!
//! ## 人間ゲート(req-35.md 追補d の節)
//! - ダイアログがアプリの文書の窓のシート(AXSheet)に出て UserNotificationCenter には出ない・
//!   本文が契約3 と行頭の空白まで一致・表示中もアプリが応答する・OK で閉じる
//!
//! 修正前の見込み: `install_cli_dialog_parent` が無いので本ファイルはコンパイルせず全件が赤。
//! 単独でも (b) は `menu.rs` の本体に `.blocking_show()` が 2 つあり `install_cli_dialog_parent(`・
//! `.parent(`・`.show(` が無いので赤、(c) は `compare_exchange` が無いので赤。
//!
//! ## 本テストの組み立て
//!
//! - 印刷窓のラベルは `print::open_print_window` の生成規則(`PRINT_WINDOW_LABEL_PREFIX`="print-"
//!   + ULID)に合わせ、`is_print_window` で裏を取る(acceptance_req38i.rs と同じ)
//! - `strip_line_comments` / `code_body` は acceptance_req35b.rs・35c.rs と同じ流儀。
//!   `fn_body` / `block_end` は acceptance_req38o.rs と同じ流儀(文字列・文字リテラルの中の
//!   括弧は数えない)
//! - (c) の名前は本体から読む: `compare_exchange` の受け手(直前の識別子)= static の名前。
//!   `impl Drop for <T>` のうち本体でその static を `store(false` する T = 守りの型。
//!   本体で `let <guard> = <T>` と束縛された名前= guard。`.show(` の引数の中に `<guard>` が
//!   語として出ることを見る(`.show(` が複数あれば全部)

use vellis_lib::menu::install_cli_dialog_parent;
use vellis_lib::print::is_print_window;

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const PRINT_A: &str = "print-01J9Q3XK0F8V2T6H4N1M5A7B9C";
const PRINT_B: &str = "print-01J9Q3XK0G1W3R8D2P6K4Z0M7E";
const MAIN: &str = "main";
const DOC_2: &str = "doc-2";
const DOC_3: &str = "doc-3";

/// 用意したラベルが契約の前提(印刷窓/文書の窓)を満たすことの確認。
#[test]
fn fixtures_match_is_print_window() {
    for label in [PRINT_A, PRINT_B] {
        assert!(
            is_print_window(label),
            "fixture {label:?} must be a print window by crate::print::is_print_window"
        );
    }
    for label in [MAIN, DOC_2, DOC_3] {
        assert!(
            !is_print_window(label),
            "fixture {label:?} must be a document window by crate::print::is_print_window"
        );
    }
}

// ---------------------------------------------------------------------------
// (a) install_cli_dialog_parent の表
// ---------------------------------------------------------------------------

/// AC-35-追d (a)・契約2 の型: `install_cli_dialog_parent<'a>(&[(&'a str, bool, bool)]) -> Option<&'a str>`
/// (返り値はラベルの寿命を借りる=スライスの寿命ではない)。コンパイル時の判定。
#[test]
fn ac35d_a_install_cli_dialog_parent_has_the_contracted_signature() {
    let f: for<'a> fn(&[(&'a str, bool, bool)]) -> Option<&'a str> = install_cli_dialog_parent;
    let labels = [MAIN, DOC_2];
    let parent = {
        let windows = vec![(labels[0], false, true), (labels[1], true, true)];
        f(&windows)
        // `windows` はここで落ちるが、返り値はラベル側の寿命なので使い続けられる
    };
    assert_eq!(parent, Some(DOC_2));
}

/// AC-35-追d (a): フォーカスのある文書の窓が選ばれる(ほかに見えている窓があっても)。
#[test]
fn ac35d_a_focused_document_window_wins_over_other_visible_windows() {
    // フォーカスのある窓が並びの途中・前後に見えている文書の窓と印刷窓
    let windows = [
        (MAIN, false, true),
        (DOC_2, true, true),
        (PRINT_A, false, true),
        (DOC_3, false, true),
    ];
    assert_eq!(
        install_cli_dialog_parent(&windows),
        Some(DOC_2),
        "the focused document window is the parent even when other windows are visible"
    );

    // フォーカスのある窓が並びの末尾(「最初の見えている窓」とは別)
    let windows = [(MAIN, false, true), (DOC_2, false, true), (DOC_3, true, true)];
    assert_eq!(
        install_cli_dialog_parent(&windows),
        Some(DOC_3),
        "focus wins over the first visible document window"
    );

    // フォーカスのある窓が先頭
    let windows = [(MAIN, true, true), (DOC_2, false, true)];
    assert_eq!(install_cli_dialog_parent(&windows), Some(MAIN));
}

/// AC-35-追d (a): フォーカスが印刷窓にあり文書の窓が見えていれば文書の窓
/// (起案時判断 (a): 印刷窓が前面でも文書の窓があればそちらに付ける)。
#[test]
fn ac35d_a_focused_print_window_yields_to_a_visible_document_window() {
    let windows = [(PRINT_A, true, true), (MAIN, false, true)];
    assert_eq!(
        install_cli_dialog_parent(&windows),
        Some(MAIN),
        "a focused print window is never the parent; the visible document window is"
    );

    // 文書の窓が複数見えていれば最初のもの
    let windows = [(DOC_2, false, true), (PRINT_A, true, true), (MAIN, false, true)];
    assert_eq!(
        install_cli_dialog_parent(&windows),
        Some(DOC_2),
        "with a focused print window the first visible document window is the parent"
    );

    // 見えていない文書の窓は飛ばして、見えている文書の窓
    let windows = [(MAIN, false, false), (PRINT_A, true, true), (DOC_2, false, true)];
    assert_eq!(
        install_cli_dialog_parent(&windows),
        Some(DOC_2),
        "a hidden document window is skipped in favour of a visible one"
    );
}

/// AC-35-追d (a): フォーカスが無ければ見えている文書の窓のうち最初。
#[test]
fn ac35d_a_without_focus_the_first_visible_document_window_is_chosen() {
    let windows = [(MAIN, false, true), (DOC_2, false, true)];
    assert_eq!(
        install_cli_dialog_parent(&windows),
        Some(MAIN),
        "without focus the first visible document window is the parent"
    );

    // 先頭が隠れている・最小化されていれば、次の見えている文書の窓
    let windows = [(MAIN, false, false), (DOC_2, false, true), (DOC_3, false, true)];
    assert_eq!(
        install_cli_dialog_parent(&windows),
        Some(DOC_2),
        "a hidden or minimized first document window is skipped"
    );

    // 印刷窓が先頭に見えていても、見えている文書の窓
    let windows = [(PRINT_A, false, true), (PRINT_B, false, true), (DOC_3, false, true)];
    assert_eq!(
        install_cli_dialog_parent(&windows),
        Some(DOC_3),
        "print windows are never the parent, even when they come first"
    );
}

/// AC-35-追d (a): 文書の窓がどれも見えない(隠れている・最小化)なら `None`
/// (起案時判断 (b): 親なしの `show`)。
#[test]
fn ac35d_a_no_visible_document_window_is_none() {
    let windows = [(MAIN, false, false), (DOC_2, false, false)];
    assert_eq!(
        install_cli_dialog_parent(&windows),
        None,
        "with every document window hidden or minimized there is no parent"
    );

    // 印刷窓だけが見えている(フォーカスも印刷窓)
    let windows = [(MAIN, false, false), (PRINT_A, true, true), (DOC_2, false, false)];
    assert_eq!(
        install_cli_dialog_parent(&windows),
        None,
        "a visible print window does not stand in for hidden document windows"
    );
}

/// AC-35-追d (a): 印刷窓だけなら `None`。
#[test]
fn ac35d_a_print_windows_only_is_none() {
    assert_eq!(install_cli_dialog_parent(&[(PRINT_A, true, true)]), None);
    assert_eq!(install_cli_dialog_parent(&[(PRINT_A, false, true)]), None);
    assert_eq!(
        install_cli_dialog_parent(&[(PRINT_A, false, true), (PRINT_B, true, true)]),
        None,
        "print windows alone never yield a parent"
    );
}

/// AC-35-追d (a): 空なら `None`。
#[test]
fn ac35d_a_empty_is_none() {
    let empty: [(&str, bool, bool); 0] = [];
    assert_eq!(install_cli_dialog_parent(&empty), None);
}

// ---------------------------------------------------------------------------
// 補助(ソース走査)— acceptance_req35b.rs / 35c.rs / 38o.rs と同じ流儀
// ---------------------------------------------------------------------------

/// 行ごとに `//` 以降(コメント)を落とす。`://` は落とさない。
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

/// ソースの `#[cfg(test)]` より前・行コメントを除いた本文。
fn code_body(src: &str) -> String {
    let code = strip_line_comments(src);
    match code.find("#[cfg(test)]") {
        Some(i) => code[..i].to_string(),
        None => code,
    }
}

/// `open`(`{` か `(`)の位置から、対応する閉じ括弧の次の位置まで。文字列・文字リテラルの中の
/// 括弧は数えない(acceptance_req38o.rs の `block_end` と同じ)。
fn block_end(code: &str, open: usize) -> usize {
    let bytes = code.as_bytes();
    let (open_ch, close_ch) = match bytes[open] {
        b'{' => (b'{', b'}'),
        b'(' => (b'(', b')'),
        other => panic!("block must start at a brace or a paren, got {:?}", other as char),
    };
    let mut depth = 0usize;
    let mut i = open;
    let mut in_str = false;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if c == b'\\' {
                i += 1;
            } else if c == b'"' {
                in_str = false;
            }
        } else if c == b'"' {
            in_str = true;
        } else if c == b'\'' && i + 2 < bytes.len() && bytes[i + 2] == b'\'' {
            // 文字リテラル `'x'`(`'{'` のような括弧を数えない)。生存期間 `'a` は当たらない
            i += 2;
        } else if c == open_ch {
            depth += 1;
        } else if c == close_ch {
            depth -= 1;
            if depth == 0 {
                return i + 1;
            }
        }
        i += 1;
    }
    panic!("unbalanced block starting at offset {open}");
}

/// `fn <name>(` または `fn <name><` の定義の位置。
fn fn_definition(code: &str, name: &str) -> Option<usize> {
    let needle = format!("fn {name}");
    code.match_indices(&needle)
        .find(|(i, _)| matches!(code[i + needle.len()..].chars().next(), Some('(') | Some('<')))
        .map(|(i, _)| i)
}

/// `fn <name>` の本体(外側の `{ … }` を含む)。
fn fn_body<'a>(code: &'a str, name: &str, file: &str) -> &'a str {
    let start = fn_definition(code, name).unwrap_or_else(|| panic!("{file} must define {name}"));
    let open = code[start..]
        .find('{')
        .unwrap_or_else(|| panic!("{name} must have a body"))
        + start;
    &code[open..block_end(code, open)]
}

fn is_ident_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// `code` の中に `ident` が語として(前後が識別子の文字でなく)出るか。
fn contains_word(code: &str, ident: &str) -> bool {
    code.match_indices(ident).any(|(i, _)| {
        let before_ok = code[..i].chars().next_back().is_none_or(|c| !is_ident_char(c));
        let after_ok = code[i + ident.len()..]
            .chars()
            .next()
            .is_none_or(|c| !is_ident_char(c));
        before_ok && after_ok
    })
}

/// `end` の直前(空白を飛ばして)にある識別子。
fn ident_before(code: &str, end: usize) -> &str {
    let trimmed = code[..end].trim_end();
    let start = trimmed
        .char_indices()
        .rev()
        .take_while(|(_, c)| is_ident_char(*c))
        .last()
        .map(|(i, _)| i)
        .unwrap_or(trimmed.len());
    &trimmed[start..]
}

/// `start` から(空白を飛ばして)始まる識別子。
fn ident_at(code: &str, start: usize) -> &str {
    let rest = code[start..].trim_start();
    let len = rest
        .char_indices()
        .find(|(_, c)| !is_ident_char(*c))
        .map(|(i, _)| i)
        .unwrap_or(rest.len());
    &rest[..len]
}

/// `let ` の直後 `start` から読む束縛 (名前, `=` の右の識別子)。`let mut name = T` と
/// `let name: T = T` にも耐える。`=` の右が識別子で始まらなければ `None`。
fn let_binding(code: &str, start: usize) -> Option<(&str, &str)> {
    let skip_ws = |s: &str| s.len() - s.trim_start().len();
    let mut pos = start + skip_ws(&code[start..]);
    let mut name = ident_at(code, pos);
    if name == "mut" {
        pos += name.len();
        pos += skip_ws(&code[pos..]);
        name = ident_at(code, pos);
    }
    pos += name.len();
    let rest = code[pos..].trim_start();
    let rest = match rest.strip_prefix(':') {
        Some(annotated) => annotated[annotated.find('=')?..].trim_start(),
        None => rest,
    };
    let rhs = rest.strip_prefix('=')?;
    if rhs.starts_with('=') {
        return None;
    }
    let bound = ident_at(rhs, 0);
    (!bound.is_empty()).then_some((name, bound))
}

/// `code` の中のすべての `<needle>` の直後にある `(` … `)` の中身(引数)。
fn call_args<'a>(code: &'a str, needle: &str) -> Vec<&'a str> {
    code.match_indices(needle)
        .map(|(i, _)| {
            let open = i + needle.len() - 1;
            assert_eq!(code.as_bytes()[open], b'(', "{needle} must end with `(`");
            &code[open..block_end(code, open)]
        })
        .collect()
}

/// 空白を全部落とす(`NAME\n    .store(false` のような折り返しを揃える)。
fn without_whitespace(code: &str) -> String {
    code.chars().filter(|c| !c.is_whitespace()).collect()
}

/// `code` の中に `<flag>.store(false` が(`flag` を語として)出るか。
/// `IN_FLIGHT.store(false` が `CHECK_FOR_UPDATES_IN_FLIGHT.store(false` に当たらないように。
fn stores_false(code: &str, flag: &str) -> bool {
    let flat = without_whitespace(code);
    let needle = format!("{flag}.store(false");
    flat.match_indices(&needle)
        .any(|(i, _)| flat[..i].chars().next_back().is_none_or(|c| !is_ident_char(c)))
}

const MENU_RS: &str = "menu.rs";
const HANDLER: &str = "handle_install_cli_click";

// ---------------------------------------------------------------------------
// (b) menu.rs に blocking_show が無い・handler が親を選んで .parent(…).show(…)
// ---------------------------------------------------------------------------

/// AC-35-追d (b)・契約1: `menu.rs` の本文に `blocking_show` が無い。`handle_install_cli_click` の
/// 本体に `install_cli_dialog_parent(`・`.parent(`・`.show(` がある。
#[test]
fn ac35d_b_menu_rs_has_no_blocking_show_and_the_handler_parents_and_shows() {
    let menu = code_body(include_str!("../src/menu.rs"));
    assert!(
        !menu.contains("blocking_show"),
        "menu.rs must not call `blocking_show` anywhere in code (contract 1: a parented \
         blocking_show on the main thread hangs for good; the Install CLI dialog uses `show`)"
    );

    let body = fn_body(&menu, HANDLER, MENU_RS);
    assert!(
        body.contains("install_cli_dialog_parent("),
        "{HANDLER} must choose the parent window with `install_cli_dialog_parent(` (contract 2)"
    );
    assert!(
        body.contains(".parent("),
        "{HANDLER} must pass the chosen window with `.parent(` so the dialog is that window's sheet (contract 1)"
    );
    assert!(
        body.contains(".show("),
        "{HANDLER} must show the result dialog with `.show(` (contract 1: never wait on the main thread)"
    );
}

// ---------------------------------------------------------------------------
// (c) 二度押し: compare_exchange → install_cli(・impl Drop が下ろす・callback が guard を持つ
// ---------------------------------------------------------------------------

/// AC-35-追d (c)・契約3: `handle_install_cli_click` の本体で `compare_exchange` が `install_cli(`
/// より前にある。その `AtomicBool` を下ろす `impl Drop` がある。`.show(` の callback(閉包)が
/// その値(guard)を持つ。
#[test]
fn ac35d_c_in_flight_flag_is_raised_before_install_cli_and_released_by_a_guard_in_the_callback() {
    let menu = code_body(include_str!("../src/menu.rs"));
    let body = fn_body(&menu, HANDLER, MENU_RS);

    // compare_exchange が install_cli( より前
    let cx = body
        .find(".compare_exchange(")
        .unwrap_or_else(|| panic!("{HANDLER} must raise the in-flight flag with `.compare_exchange(` (contract 3)"));
    let install = body
        .find("install_cli(")
        .unwrap_or_else(|| panic!("{HANDLER} must still call `install_cli(` (contract 4)"));
    assert!(
        cx < install,
        "{HANDLER} must call `compare_exchange` before `install_cli(` so a second click while the \
         dialog is up neither reinstalls nor stacks a dialog (contract 3); compare_exchange at {cx}, install_cli( at {install}"
    );

    // compare_exchange の受け手= static AtomicBool
    let flag = ident_before(body, cx);
    assert!(
        !flag.is_empty() && flag.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'),
        "the receiver of `.compare_exchange(` must be a static (SCREAMING_CASE) AtomicBool, got {flag:?}"
    );
    let menu_flat = without_whitespace(&menu);
    assert!(
        menu_flat.contains(&format!("static{flag}:AtomicBool")),
        "menu.rs must declare `static {flag}: AtomicBool` (contract 3)"
    );

    // その AtomicBool を store(false で下ろす impl Drop for <T>
    let drop_types: Vec<&str> = menu
        .match_indices("impl Drop for ")
        .map(|(i, m)| {
            let type_name = ident_at(&menu, i + m.len());
            let open = menu[i..].find('{').expect("impl Drop must have a body") + i;
            (type_name, &menu[open..block_end(&menu, open)])
        })
        .filter(|(_, impl_body)| stores_false(impl_body, flag))
        .map(|(type_name, _)| type_name)
        .collect();
    assert!(
        !drop_types.is_empty(),
        "menu.rs must have an `impl Drop for <T>` whose body clears `{flag}` with `.store(false` \
         (contract 3: every path out, dialog or not, lowers the flag)"
    );

    // 本体で let <guard> = <T> と束縛され、.show( の閉包がその名前を持つ
    let shows = call_args(body, ".show(");
    assert!(
        !shows.is_empty(),
        "{HANDLER} must show the result dialog with `.show(` (contract 1)"
    );
    let first_show = body.find(".show(").expect("checked above");
    let guard = drop_types
        .iter()
        .find_map(|type_name| {
            body[..first_show]
                .match_indices("let ")
                .map(|(i, m)| i + m.len())
                .find_map(|start| let_binding(body, start).filter(|(name, bound)| {
                    bound == type_name && !name.is_empty() && *name != "_"
                }))
                .map(|(name, _)| name)
        })
        .unwrap_or_else(|| {
            panic!(
                "{HANDLER} must bind the Drop guard before the dialog, e.g. `let guard = {};` (contract 3)",
                drop_types[0]
            )
        });
    for (n, closure) in shows.iter().enumerate() {
        assert!(
            contains_word(closure, guard),
            "the callback of `.show(` #{n} in {HANDLER} must carry the guard `{guard}` so the flag is \
             lowered when the dialog closes (contract 3); got: {closure}"
        );
    }
}
