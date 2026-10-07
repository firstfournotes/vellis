//! 要件#38 追補i の受け入れテスト(docs/requirements/req-38.md 追補i・backlog 253)— Rust 層
//!
//! 「印刷窓が前面のときの Command + P が背面の文書の窓に届く」
//!
//! 発見: `handle_print_click` は `focused_or_first_window` で前面の窓を探すが、この関数は
//! 印刷窓を除外するので、印刷窓が前面だと「フォーカスのある文書の窓」が見つからず、
//! 先頭の文書の窓(背面)へ fallback して印刷が始まりうる。申し送り 91 の
//! 「印刷窓フォーカス中の ⌘P は意図的 no-op」と食い違う。
//!
//! 契約(追補i):
//! 1. `menu.rs` に `pub fn print_click_target<'a>(windows: &[(&'a str, bool)]) -> Option<&'a str>`
//!    を足す(`(ラベル, フォーカスがあるか)` の並び)。フォーカスのある窓に印刷窓
//!    (`print::is_print_window`)が1つでもあれば `None`。そうでなければ、フォーカスのある
//!    文書の窓(印刷窓でない)の先頭、それも無ければ文書の窓の先頭、文書の窓が無ければ `None`
//! 2. `handle_print_click` は窓の一覧を `(label, is_focused().unwrap_or(false))` にして
//!    `print_click_target` で行き先を決める。`None` なら何もしない。行き先が決まった後の
//!    `print_item_state` の止め(追補f の契約4)と `emit_to` は従来どおり
//! 3. 不変: `focused_or_first_window` とそれを使うほかのメニュー項目(ズーム・DevTools ほか)・
//!    印刷窓の生成・`sync_print_item`・フロントの経路判定
//!
//! 本ファイルの持ち場(AC-38-追i の (a)〜(e)):
//! - (a) 印刷窓が前面 → `None`
//! - (b) 文書の窓が前面(印刷窓は背面)→ その文書の窓
//! - (c) どれにもフォーカスが無い → 文書の窓の先頭(印刷窓は fallback の先にならない)
//! - (d) 印刷窓だけ・空の並び → `None`
//! - (e) ソース走査: `handle_print_click` の本体が `print_click_target(` を呼び、
//!   `focused_or_first_window(` を呼ばない。`focused_or_first_window` 自体は残る(契約 3)
//!
//! AC-38-追f の 21(`acceptance_req38f.rs`・`print_item_state(`・`Enabled`・`MENU_PRINT_EVENT`)
//! は無改変のまま緑であること=同じ周回のフルスイートで確かめる(本ファイルでは重ねない)。
//!
//! ## 確定契約(公開 API・implementer はこれに従う)
//!
//! ```ignore
//! // src-tauri/src/menu.rs
//! /// Print… の行き先(純関数)。`windows` は (ラベル, フォーカスがあるか) の並び
//! /// (`app.webview_windows()` の順)。
//! /// - フォーカスのある窓に印刷窓(`crate::print::is_print_window`)が1つでもあれば None
//! /// - そうでなければ、フォーカスのある文書の窓の先頭
//! /// - それも無ければ文書の窓の先頭
//! /// - 文書の窓が無ければ None
//! pub fn print_click_target<'a>(windows: &[(&'a str, bool)]) -> Option<&'a str>;
//!
//! /// 既存。窓の一覧を (label, is_focused().unwrap_or(false)) にして print_click_target
//! /// で行き先を決め、None なら何もしない。その後の print_item_state の止めと emit_to は
//! /// 従来どおり。focused_or_first_window は呼ばない(ほかのメニュー項目のために残す)。
//! pub fn handle_print_click(app: &AppHandle<Wry>);
//! ```
//!
//! ## reviewer 照合に委ねる配線(AppHandle 依存で機械判定不能)
//! - `handle_print_click` が `app.webview_windows()` の全窓(印刷窓を含む)を
//!   `(label, is_focused().unwrap_or(false))` に写してから `print_click_target` に渡すこと
//!   (印刷窓を先に除いてしまうと「印刷窓が前面」を検知できない)
//!
//! ## 人間ゲート
//! - 実機で印刷窓(HTML の Command + P で開く窓)を前面にして Command + P を押しても、
//!   背面の文書の窓で印刷のシートが開かないこと(人間ゲート 7 の「印刷窓にフォーカスが
//!   ある場合」)

use vellis_lib::menu::print_click_target;
use vellis_lib::print::is_print_window;

// ---------------------------------------------------------------------------
// フィクスチャ — 印刷窓のラベルは `print::open_print_window` の生成規則
// (`PRINT_WINDOW_LABEL_PREFIX`="print-" + ULID)に合わせ、`is_print_window` で裏を取る
// ---------------------------------------------------------------------------

const PRINT_A: &str = "print-01J9Q3XK0F8V2T6H4N1M5A7B9C";
const PRINT_B: &str = "print-01J9Q3XK0G1W3R8D2P6K4Z0M7E";

/// 用意したラベルが契約の前提(印刷窓/文書の窓)を満たすことの確認。
#[test]
fn fixtures_match_is_print_window() {
    for label in [PRINT_A, PRINT_B] {
        assert!(is_print_window(label), "fixture {label} must be a print window label");
    }
    for label in ["main", "doc-2", "vellis-3", "tab-1", "printer"] {
        assert!(!is_print_window(label), "fixture {label} must not be a print window label");
    }
}

/// 契約 1 の型: `print_click_target<'a>(&[(&'a str, bool)]) -> Option<&'a str>`
/// (返り値はラベルの寿命を借りる=スライスの寿命ではない)。コンパイル時の判定。
#[test]
fn print_click_target_has_the_contracted_signature() {
    let f: for<'a> fn(&[(&'a str, bool)]) -> Option<&'a str> = print_click_target;
    let labels = ["main", "doc-2"];
    let target = {
        let windows = vec![(labels[0], false), (labels[1], true)];
        f(&windows)
        // `windows` はここで落ちるが、返り値はラベル側の寿命なので使い続けられる
    };
    assert_eq!(target, Some("doc-2"));
}

// ---------------------------------------------------------------------------
// (a) 印刷窓が前面 → None
// ---------------------------------------------------------------------------

/// (a) `[("main", false), ("print-01J…", true)]` は `None`(印刷窓が前面)。
#[test]
fn print_window_focused_targets_nothing() {
    assert_eq!(print_click_target(&[("main", false), (PRINT_A, true)]), None);
}

/// (a) 並びの先頭に印刷窓が来ても同じ(背面の "main" に fallback しない)。
#[test]
fn print_window_focused_first_in_list_targets_nothing() {
    assert_eq!(print_click_target(&[(PRINT_A, true), ("main", false)]), None);
}

/// (a) 文書の窓が複数あっても、前面が印刷窓なら `None`。
#[test]
fn print_window_focused_among_many_documents_targets_nothing() {
    assert_eq!(
        print_click_target(&[("main", false), ("doc-2", false), (PRINT_A, true), ("doc-3", false)]),
        None
    );
}

/// (a) 「フォーカスのある窓に印刷窓が1つでもあれば None」: `is_focused` の答えが
///     文書の窓と印刷窓の両方で true になっても(窓マネージャの揺れ)、印刷窓が勝つ。
#[test]
fn focused_print_window_wins_over_a_focused_document_window() {
    assert_eq!(print_click_target(&[("main", true), (PRINT_A, true)]), None);
    assert_eq!(print_click_target(&[(PRINT_A, true), ("main", true)]), None);
}

/// (a) 印刷窓が2枚あり、どちらか1枚が前面でも `None`。
#[test]
fn any_focused_print_window_targets_nothing() {
    assert_eq!(
        print_click_target(&[(PRINT_A, false), ("main", false), (PRINT_B, true)]),
        None
    );
}

// ---------------------------------------------------------------------------
// (b) 文書の窓が前面 → その窓
// ---------------------------------------------------------------------------

/// (b) `[("main", false), ("doc-2", true), ("print-01J…", false)]` は `Some("doc-2")`。
#[test]
fn focused_document_window_is_the_target() {
    assert_eq!(
        print_click_target(&[("main", false), ("doc-2", true), (PRINT_A, false)]),
        Some("doc-2")
    );
}

/// (b) 背面の印刷窓が並びの先頭にあっても、前面の文書の窓へ届く。
#[test]
fn focused_document_window_is_the_target_even_after_a_print_window() {
    assert_eq!(
        print_click_target(&[(PRINT_A, false), ("main", false), ("doc-2", true)]),
        Some("doc-2")
    );
}

/// (b) 前面の文書の窓が先頭でなくても、先頭の文書の窓("main")ではなく前面の窓に届く
///     (フォーカスが fallback より優先)。
#[test]
fn focused_document_window_beats_the_first_document_window() {
    assert_eq!(
        print_click_target(&[("main", false), ("doc-2", false), ("doc-3", true)]),
        Some("doc-3")
    );
}

/// (b) フォーカスのある文書の窓が複数報告されたら、その先頭。
#[test]
fn first_focused_document_window_wins_among_several() {
    assert_eq!(
        print_click_target(&[("main", false), ("doc-2", true), ("doc-3", true)]),
        Some("doc-2")
    );
}

/// (b) 文書の窓が1枚だけで前面 → その窓。
#[test]
fn single_focused_document_window_is_the_target() {
    assert_eq!(print_click_target(&[("main", true)]), Some("main"));
}

// ---------------------------------------------------------------------------
// (c) どれにもフォーカスが無い → 文書の窓の先頭(印刷窓は fallback の先にならない)
// ---------------------------------------------------------------------------

/// (c) `[("print-01J…", false), ("main", false)]` は `Some("main")`。
#[test]
fn no_focus_falls_back_to_the_first_document_window_skipping_print_windows() {
    assert_eq!(print_click_target(&[(PRINT_A, false), ("main", false)]), Some("main"));
}

/// (c) 文書の窓が複数あり、どれにもフォーカスが無ければ並びの先頭の文書の窓。
#[test]
fn no_focus_falls_back_to_the_first_of_several_document_windows() {
    assert_eq!(
        print_click_target(&[("main", false), ("doc-2", false), ("doc-3", false)]),
        Some("main")
    );
    assert_eq!(
        print_click_target(&[("doc-2", false), ("main", false)]),
        Some("doc-2")
    );
}

/// (c) 印刷窓が先頭に何枚あっても飛ばして、最初の文書の窓。
#[test]
fn no_focus_skips_every_leading_print_window() {
    assert_eq!(
        print_click_target(&[(PRINT_A, false), (PRINT_B, false), ("doc-2", false), ("main", false)]),
        Some("doc-2")
    );
}

/// (c) 文書の窓が1枚だけ・フォーカス無し → その窓。
#[test]
fn single_unfocused_document_window_is_the_target() {
    assert_eq!(print_click_target(&[("main", false)]), Some("main"));
}

// ---------------------------------------------------------------------------
// (d) 印刷窓だけ・空の並び → None
// ---------------------------------------------------------------------------

/// (d) 空の並びは `None`。
#[test]
fn empty_list_targets_nothing() {
    assert_eq!(print_click_target(&[]), None);
}

/// (d) 印刷窓だけ(フォーカス無し)は `None`。
#[test]
fn only_unfocused_print_windows_target_nothing() {
    assert_eq!(print_click_target(&[(PRINT_A, false)]), None);
    assert_eq!(print_click_target(&[(PRINT_A, false), (PRINT_B, false)]), None);
}

/// (d) 印刷窓だけ(前面)は `None`。
#[test]
fn only_focused_print_windows_target_nothing() {
    assert_eq!(print_click_target(&[(PRINT_A, true)]), None);
    assert_eq!(print_click_target(&[(PRINT_A, false), (PRINT_B, true)]), None);
}

// ---------------------------------------------------------------------------
// (e) ソース走査 — acceptance_req38f.rs の menu_rs_code / function_parts と同じ流儀
// ---------------------------------------------------------------------------

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

/// `from` 以降で最初に現れる `{` から、対応する `}` までを切り出す。
fn balanced_block(code: &str, from: usize) -> &str {
    let open = code[from..].find('{').expect("block must open") + from;
    let mut depth = 0usize;
    for (offset, ch) in code[open..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &code[open..open + offset + ch.len_utf8()];
                }
            }
            _ => {}
        }
    }
    panic!("block must close");
}

/// `fn <name>(` から始まる関数の (引数リスト, 本体) を切り出す。
fn function_parts<'a>(code: &'a str, name: &str, file: &str) -> (&'a str, &'a str) {
    let needle = format!("fn {name}(");
    let start = code
        .find(&needle)
        .unwrap_or_else(|| panic!("{file} must define {name}"));
    let params_start = start + needle.len();
    let params_end = code[params_start..].find(')').expect("parameter list must close") + params_start;
    let params = &code[params_start..params_end];
    let body = balanced_block(code, params_end);
    (params, body)
}

/// (e) 契約 2: `handle_print_click` の本体が `print_click_target(` を呼ぶ。
#[test]
fn handle_print_click_decides_the_target_with_print_click_target() {
    let code = menu_rs_code();
    let (_, body) = function_parts(&code, "handle_print_click", "menu.rs");
    assert!(
        body.contains("print_click_target("),
        "handle_print_click must decide the target window via print_click_target: {body}"
    );
}

/// (e) 契約 2: `handle_print_click` の本体が `focused_or_first_window(` を呼ばない
///     (印刷窓を除外して fallback する旧経路を使わない)。
#[test]
fn handle_print_click_no_longer_uses_focused_or_first_window() {
    let code = menu_rs_code();
    let (_, body) = function_parts(&code, "handle_print_click", "menu.rs");
    assert!(
        !body.contains("focused_or_first_window("),
        "handle_print_click must not fall back through focused_or_first_window (backlog 253): {body}"
    );
}

/// (e) 契約 2: 窓の一覧を `(label, is_focused().unwrap_or(false))` にする=本体で
///     `is_focused(` を見て失敗は「前面でない」に倒す(`unwrap_or(false)`)。
#[test]
fn handle_print_click_maps_windows_to_label_and_focus() {
    let code = menu_rs_code();
    let (_, body) = function_parts(&code, "handle_print_click", "menu.rs");
    assert!(
        body.contains("is_focused("),
        "handle_print_click must read each window's is_focused(): {body}"
    );
    assert!(
        body.contains("unwrap_or(false)"),
        "a failed is_focused() query counts as not focused (contract 2): {body}"
    );
}

/// (e) 契約 1: `print_click_target` は `menu.rs` に `pub fn` として置かれる
///     (ジェネリックな寿命 `<'a>` 付き・本テストから呼べる)。
#[test]
fn print_click_target_is_a_pub_fn_in_menu_rs() {
    let code = menu_rs_code();
    assert!(
        code.contains("pub fn print_click_target<"),
        "menu.rs must define `pub fn print_click_target<'a>(windows: &[(&'a str, bool)]) -> Option<&'a str>`"
    );
    // 仮引数は入れ子の括弧を含むので function_parts(最初の `)` で切る)では確かめられない。
    // ソース全体に対して契約のシグネチャをそのまま探す。
    assert!(
        code.contains("print_click_target<'a>(windows: &[(&'a str, bool)]) -> Option<&'a str>"),
        "print_click_target takes the (label, focused) list and returns a borrowed label: \
         expected `print_click_target<'a>(windows: &[(&'a str, bool)]) -> Option<&'a str>` in menu.rs"
    );
    let (_, body) = function_parts(&code, "print_click_target<'a>", "menu.rs");
    assert!(
        body.contains("is_print_window("),
        "print_click_target must recognise print windows via print::is_print_window: {body}"
    );
}

/// (e) 契約 3(不変): `focused_or_first_window` は残り(ほかのメニュー項目が使う)、
///     `handle_print_click` 以外の呼び出し元が1つ以上ある。
#[test]
fn focused_or_first_window_stays_for_the_other_menu_items() {
    let code = menu_rs_code();
    assert!(
        code.contains("fn focused_or_first_window<"),
        "focused_or_first_window must stay in menu.rs (contract 3)"
    );
    let (_, print_body) = function_parts(&code, "handle_print_click", "menu.rs");
    let total = code.matches("focused_or_first_window(").count();
    let in_print = print_body.matches("focused_or_first_window(").count();
    assert!(
        total - in_print >= 1,
        "other menu items (zoom / DevTools / Open…) must still call focused_or_first_window"
    );
}
