//! 要件#38 追補f の受け入れテスト(docs/requirements/req-38.md 追補f・backlog 251)— Rust 層
//!
//! 「文書を開いていない窓(履歴選択画面・空の状態)が前面のとき、File > Print… は
//!  無効(灰色)になり、Command + P を押しても印刷ダイアログは開かない」
//! (2026-10-02 由谷「メニューを無効にして開かないようにして」)
//!
//! 契約(追補f):
//! 1. 文書を開いていない窓が前面 → Print… 無効。開いている窓が前面 → 有効(経路は従来どおり)
//! 2. メニューはアプリ全体で1つなので、各窓が「印刷できる文書を開いているか」を本体へ
//!    知らせ、本体は窓ごとに覚える(既定=開いていない)。前面の窓が変わったとき・前面の
//!    窓が知らせてきたときに Print… の有効・無効をその窓の状態に合わせる。窓が閉じたら
//!    覚えた状態を捨てる。印刷窓(`print-*`)は対象外=前面でも Print… の状態を変えない
//! 3. 知らせ方は新しい Tauri command 1本 `set_print_available`(引数は真偽1つ・窓は
//!    呼び出し元の `tauri::Window`)
//! 4. 念のための止め: 本体側も、前面の窓が「開いていない」ならイベントを送らない
//! - Print… 項目の ID・ラベル・アクセラレータ(acceptance_req38.rs が固定)・印刷の経路・
//!   `print.css` は不変
//!
//! 本ファイルの持ち場(AC-38-追f の (a)(b)):
//! - (a) 純関数: 窓ごとの状態から Print… の有効・無効を決める(`PrintAvailability` /
//!   `PrintItemState`)
//! - (b) ソース走査: `set_print_available` の command と両方の `generate_handler!` への
//!   登録・窓の前面化(`WindowEvent::Focused`)と破棄(`WindowEvent::Destroyed`)の配線・
//!   Print… 項目の `set_enabled` 切り替え・`handle_print_click` の止め
//!
//! フロント側((c) 純関数・(d) 購読の止め)は `src/lib/print-available.acceptance.test.ts`。
//! Tauri command 一覧の固定(AC-60-20)は `src/lib/go-to-path.acceptance.test.ts` に
//! `set_print_available` を1行足した(要件側の更新・承認済み)。
//!
//! ## 確定契約(公開 API・implementer はこれに従う)
//!
//! ```ignore
//! // src-tauri/src/print.rs(既存モジュールに追加・PrintDocumentStore と同じ家風=
//! // &self の内部可変で、managed state として `app.manage(PrintAvailability::new())`
//! // に載せる。Send + Sync が要る)
//!
//! /// Print… 項目に対する指示。`Unchanged` = 印刷窓が前面のときの「状態を変えない」。
//! #[derive(Debug, Clone, Copy, PartialEq, Eq)]
//! pub enum PrintItemState { Enabled, Disabled, Unchanged }
//!
//! /// 窓ごとの「印刷できる文書を開いているか」(ラベル → bool)。既定=開いていない。
//! pub struct PrintAvailability { … }
//! impl PrintAvailability {
//!     pub fn new() -> Self;
//!     /// 窓 `label` が知らせてきた状態を覚える(上書き)。
//!     pub fn set(&self, label: &str, available: bool);
//!     /// 窓 `label` が閉じたので覚えた状態を捨てる(未知のラベルは無害)。
//!     pub fn forget(&self, label: &str);
//!     /// 前面になった窓 `label` に対する Print… 項目の指示(純関数):
//!     /// - `crate::print::is_print_window(label)` → `Unchanged`(覚えた値に関わらず)
//!     /// - 覚えた値が true → `Enabled`
//!     /// - 覚えた値が false・知らせが無い(既定)→ `Disabled`
//!     pub fn print_item_state(&self, label: &str) -> PrintItemState;
//! }
//!
//! // src-tauri/src/menu.rs
//! /// 前面の窓 `label` の状態に合わせて Print… 項目(PRINT_ITEM_ID)の有効・無効を
//! /// `set_enabled` で当て直す。`print_item_state` が `Unchanged` なら何もしない。
//! pub fn sync_print_item(app: &AppHandle<Wry>, label: &str);
//!
//! /// 既存。前面の窓(focused_or_first_window)の `print_item_state` が `Enabled` の
//! /// ときだけ MENU_PRINT_EVENT を emit し、そうでなければ何も送らない(契約 4)。
//! pub fn handle_print_click(app: &AppHandle<Wry>);
//!
//! // src-tauri/src/commands/print.rs(print_current_window / print_html の隣)
//! /// 呼び出し元の窓が「印刷できる文書を開いているか」を知らせる。
//! /// フロントは invoke('set_print_available', { available }) で呼ぶ。
//! /// 本体は PrintAvailability::set(window.label(), available) で覚え、呼び出し元が
//! /// 前面(window.is_focused())なら sync_print_item で当て直す。
//! #[tauri::command]
//! pub fn set_print_available(available: bool, window: tauri::Window, …managed state…) -> …;
//!
//! // src-tauri/src/lib.rs
//! // - `.manage(PrintAvailability::new())`
//! // - on_window_event の Focused 分岐で sync_print_item(…, window.label()) を呼ぶ
//! //   (前面になったとき=Focused(true))
//! // - on_window_event の Destroyed 分岐で PrintAvailability::forget(window.label())
//! //   (要件#55 追補a の SearchResults::forget と同じ形)
//! // - 両方の generate_handler! に set_print_available を登録
//! ```
//!
//! ## reviewer 照合に委ねる配線(AppHandle / Menu 依存で機械判定不能)
//! - `sync_print_item` が File メニューの Print… 項目(`Menu::get(PRINT_ITEM_ID)`)に
//!   `set_enabled` を当てること・Focused 分岐が前面化(true)のときに当て直すこと
//! - `set_print_available` の `available` の引数名がフロントの invoke と一致すること
//! - +page.svelte が「文書を開いているか」(`isPrintAvailable`)の変化のたびに
//!   `set_print_available` を呼ぶこと
//!
//! ## 人間ゲート
//! - 実機で履歴選択画面・空の状態の窓を前面にすると File > Print… が灰色で
//!   Command + P が何も開かないこと・文書の窓に切り替えると有効に戻ること

use vellis_lib::print::{is_print_window, PrintAvailability, PrintItemState};

// ---------------------------------------------------------------------------
// (a) 純関数 — 窓ごとの状態から Print… の有効・無効を決める
// ---------------------------------------------------------------------------

/// managed state に載せる型なので Send + Sync が要る(コンパイル時の判定)。
fn assert_managed<T: Send + Sync + 'static>() {}

/// 1. `PrintAvailability` は `app.manage` に載せられる(Send + Sync + 'static)。
#[test]
fn print_availability_can_be_managed_state() {
    assert_managed::<PrintAvailability>();
}

/// 2. 既定=開いていない: 知らせが無い窓が前面なら Print… は無効(契約 2 の既定)。
#[test]
fn unknown_window_is_disabled_by_default() {
    let state = PrintAvailability::new();
    assert_eq!(state.print_item_state("main"), PrintItemState::Disabled);
}

/// 3. 「開いている」と知らせた窓が前面なら有効。
#[test]
fn window_that_reported_available_is_enabled() {
    let state = PrintAvailability::new();
    state.set("main", true);
    assert_eq!(state.print_item_state("main"), PrintItemState::Enabled);
}

/// 4. 「開いていない」と知らせた窓が前面なら無効(履歴選択画面・空の状態)。
#[test]
fn window_that_reported_unavailable_is_disabled() {
    let state = PrintAvailability::new();
    state.set("main", false);
    assert_eq!(state.print_item_state("main"), PrintItemState::Disabled);
}

/// 5. 最後の知らせが勝つ: 開いた → 閉じた(履歴選択画面へ戻った)→ また開いた、を追う。
#[test]
fn latest_report_wins() {
    let state = PrintAvailability::new();
    state.set("main", true);
    state.set("main", false);
    assert_eq!(state.print_item_state("main"), PrintItemState::Disabled);
    state.set("main", true);
    assert_eq!(state.print_item_state("main"), PrintItemState::Enabled);
}

/// 6. 窓ごとに独立: 文書の窓と履歴選択画面の窓が同時にあっても混線しない。
#[test]
fn windows_are_tracked_independently() {
    let state = PrintAvailability::new();
    state.set("doc-window", true);
    state.set("picker-window", false);
    assert_eq!(state.print_item_state("doc-window"), PrintItemState::Enabled);
    assert_eq!(state.print_item_state("picker-window"), PrintItemState::Disabled);
    assert_eq!(
        state.print_item_state("never-reported"),
        PrintItemState::Disabled
    );
}

/// 7. 窓を捨てると既定(無効)に戻る(同じラベルが再利用されても古い状態を引きずらない)。
#[test]
fn forget_resets_window_to_default() {
    let state = PrintAvailability::new();
    state.set("main", true);
    state.forget("main");
    assert_eq!(state.print_item_state("main"), PrintItemState::Disabled);
}

/// 8. 捨てるのはその窓だけ。
#[test]
fn forget_leaves_other_windows_alone() {
    let state = PrintAvailability::new();
    state.set("a", true);
    state.set("b", true);
    state.forget("a");
    assert_eq!(state.print_item_state("a"), PrintItemState::Disabled);
    assert_eq!(state.print_item_state("b"), PrintItemState::Enabled);
}

/// 9. 未知のラベルを捨てても無害(panic しない・他に影響しない)。
#[test]
fn forget_unknown_window_is_harmless() {
    let state = PrintAvailability::new();
    state.set("main", true);
    state.forget("no-such-window");
    assert_eq!(state.print_item_state("main"), PrintItemState::Enabled);
}

/// 10. 印刷窓(`print-*`)が前面のときは Print… の状態を変えない(`Unchanged`)=
///     menu.rs の focused_or_first_window が印刷窓を除外するのと同じ扱い。
///     覚えた値があっても(印刷窓からは知らせが来ないはずだが)Unchanged。
#[test]
fn print_window_leaves_item_unchanged() {
    let label = "print-01HXYZ";
    assert!(
        is_print_window(label),
        "fixture must be a print window label by crate::print::is_print_window"
    );
    let state = PrintAvailability::new();
    assert_eq!(state.print_item_state(label), PrintItemState::Unchanged);
    state.set(label, true);
    assert_eq!(state.print_item_state(label), PrintItemState::Unchanged);
    state.set(label, false);
    assert_eq!(state.print_item_state(label), PrintItemState::Unchanged);
}

/// 11. 印刷窓でない窓は `Unchanged` にならない(有効か無効のどちらかに必ず決まる)。
#[test]
fn document_windows_never_get_unchanged() {
    let state = PrintAvailability::new();
    for label in ["main", "window-2", "tab-3", "printer"] {
        assert!(!is_print_window(label), "fixture {label} must not be a print window");
        assert_ne!(state.print_item_state(label), PrintItemState::Unchanged);
        state.set(label, true);
        assert_ne!(state.print_item_state(label), PrintItemState::Unchanged);
    }
}

/// 12. 3つの指示は互いに区別できる(set_enabled の true / false / 何もしない、に写す前提)。
#[test]
fn print_item_states_are_distinct() {
    assert_ne!(PrintItemState::Enabled, PrintItemState::Disabled);
    assert_ne!(PrintItemState::Enabled, PrintItemState::Unchanged);
    assert_ne!(PrintItemState::Disabled, PrintItemState::Unchanged);
}

// ---------------------------------------------------------------------------
// (b) ソース走査 — command・登録・配線(acceptance_req55e.rs の AC-55-42 と同じ流儀)
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

fn lib_rs_code() -> String {
    strip_line_comments(include_str!("../src/lib.rs"))
}

fn menu_rs_code() -> String {
    strip_line_comments(include_str!("../src/menu.rs"))
}

fn print_command_code() -> String {
    strip_line_comments(include_str!("../src/commands/print.rs"))
}

fn handler_lists(code: &str) -> Vec<Vec<String>> {
    code.match_indices("generate_handler![")
        .map(|(i, _)| {
            let start = i + "generate_handler![".len();
            let end = code[start..].find(']').expect("handler list must close") + start;
            code[start..end]
                .split(',')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.rsplit("::").next().unwrap().to_string())
                .collect()
        })
        .collect()
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

/// `needle` の各出現の直後のブロック(`{ … }`)をすべて集める。
fn blocks_after<'a>(code: &'a str, needle: &str) -> Vec<&'a str> {
    code.match_indices(needle)
        .map(|(i, _)| balanced_block(code, i + needle.len()))
        .collect()
}

/// 13. `commands/print.rs` に `set_print_available` があり、`#[tauri::command]` が直接付く
///     (契約 3=新しい Tauri command 1本)。
#[test]
fn set_print_available_is_a_tauri_command() {
    let code = print_command_code();
    let start = code
        .find("fn set_print_available(")
        .expect("commands/print.rs must define set_print_available");
    let before = &code[..start];
    let attr_at = before
        .rfind("#[tauri::command]")
        .expect("commands/print.rs declares tauri commands");
    assert!(
        !before[attr_at..].contains("fn "),
        "the #[tauri::command] attribute must sit directly on set_print_available"
    );
    assert!(
        code.contains("pub fn set_print_available(") || code.contains("pub async fn set_print_available("),
        "set_print_available must be pub so lib.rs can register it"
    );
}

/// 14. 契約 3: 引数は真偽1つ(`available: bool`)・窓は呼び出し元の `tauri::Window`
///     (ラベルや文字列をフロントから受け取らない)。
#[test]
fn set_print_available_takes_one_bool_and_the_calling_window() {
    let code = print_command_code();
    let (params, _) = function_parts(&code, "set_print_available", "commands/print.rs");
    assert!(
        params.contains("available: bool"),
        "set_print_available must take `available: bool` (the name the frontend passes): {params}"
    );
    assert_eq!(
        params.matches("bool").count(),
        1,
        "exactly one boolean argument: {params}"
    );
    for forbidden in ["String", "&str", "label", "u64", "usize", "Vec<"] {
        assert!(
            !params.contains(forbidden),
            "set_print_available must not take a front-end argument other than the bool (found `{forbidden}`): {params}"
        );
    }
    assert!(
        params.contains("Window"),
        "the window comes from the calling window handle (tauri::Window / WebviewWindow): {params}"
    );
}

/// 15. 中身は「覚える」+「前面なら当て直す」: 本体で `.label()` を取り `.set(` で覚え、
///     `is_focused(` を見て `sync_print_item(` で Print… を当て直す(契約 2 の
///     「前面の窓が知らせてきたとき」=背面の窓の知らせでは項目を変えない)。
#[test]
fn set_print_available_remembers_and_syncs_when_focused() {
    let code = print_command_code();
    let (_, body) = function_parts(&code, "set_print_available", "commands/print.rs");
    assert!(body.contains(".label()"), "the label comes from the window handle: {body}");
    assert!(body.contains(".set("), "the command must remember the state via PrintAvailability::set: {body}");
    assert!(
        body.contains("is_focused("),
        "only a frontmost window's report may change the menu item (contract 2): {body}"
    );
    assert!(
        body.contains("sync_print_item("),
        "the command must re-apply the item state via menu::sync_print_item: {body}"
    );
}

/// 16. `lib.rs` の両方の `generate_handler!` に `set_print_available` が 1 回ずつ登録される
///     (`print_current_window` / `print_html` の登録はそのまま)。
#[test]
fn set_print_available_is_registered_in_both_handler_lists() {
    let code = lib_rs_code();
    let blocks = handler_lists(&code);
    assert_eq!(blocks.len(), 2, "lib.rs has the webdriver and the production handler lists");
    for names in blocks {
        for required in ["print_current_window", "print_html", "set_print_available"] {
            assert_eq!(
                names.iter().filter(|n| *n == required).count(),
                1,
                "{required} must be registered exactly once: {names:?}"
            );
        }
    }
}

/// 17. `lib.rs` が `PrintAvailability` を managed state に載せる(窓ごとの記憶の置き場)。
#[test]
fn lib_rs_manages_print_availability() {
    let code = lib_rs_code();
    assert!(
        code.contains("manage(PrintAvailability::new())")
            || code.contains("manage(PrintAvailability::default())"),
        "lib.rs must `.manage(PrintAvailability::new())` so the command and the window events share it"
    );
}

/// `on_window_event(` のクロージャ本体。
fn on_window_event_body(code: &str) -> &str {
    let at = code
        .find(".on_window_event(")
        .expect("lib.rs installs an on_window_event handler");
    balanced_block(code, at)
}

/// 18. 窓の前面化の配線: `on_window_event` の `WindowEvent::Focused(` 分岐で
///     `sync_print_item(` を呼ぶ(前面の窓が変わったら、その窓の状態で当て直す)。
#[test]
fn window_focus_resyncs_print_item() {
    let code = lib_rs_code();
    let closure = on_window_event_body(&code);
    let focused_blocks = blocks_after(closure, "WindowEvent::Focused(");
    assert!(
        !focused_blocks.is_empty(),
        "on_window_event must handle WindowEvent::Focused: {closure}"
    );
    assert!(
        focused_blocks.iter().any(|b| b.contains("sync_print_item(")),
        "a WindowEvent::Focused branch must call menu::sync_print_item for the window: {closure}"
    );
}

/// 19. 窓の破棄の配線: `on_window_event` の `WindowEvent::Destroyed` 分岐で
///     `PrintAvailability` の `.forget(` を呼ぶ(覚えた状態を捨てる=契約 2)。
#[test]
fn window_destroy_forgets_print_availability() {
    let code = lib_rs_code();
    let closure = on_window_event_body(&code);
    let destroyed_blocks = blocks_after(closure, "WindowEvent::Destroyed");
    assert!(
        !destroyed_blocks.is_empty(),
        "on_window_event must handle WindowEvent::Destroyed: {closure}"
    );
    assert!(
        destroyed_blocks
            .iter()
            .any(|b| b.contains("PrintAvailability") && b.contains(".forget(")),
        "a WindowEvent::Destroyed branch must call PrintAvailability::forget for the window: {closure}"
    );
}

/// 20. `menu.rs` の `sync_print_item` が Print… 項目(PRINT_ITEM_ID)の有効・無効を
///     `print_item_state` の答えに従って `set_enabled(` で切り替える。
#[test]
fn menu_sync_print_item_toggles_enabled_from_item_state() {
    let code = menu_rs_code();
    let (params, body) = function_parts(&code, "sync_print_item", "menu.rs");
    assert!(
        code.contains("pub fn sync_print_item("),
        "sync_print_item must be pub so the command and lib.rs can call it"
    );
    assert!(
        params.contains("AppHandle") && params.contains("&str"),
        "sync_print_item(app: &AppHandle<_>, label: &str): {params}"
    );
    assert!(
        body.contains("print_item_state("),
        "sync_print_item must ask PrintAvailability::print_item_state: {body}"
    );
    assert!(
        body.contains("PRINT_ITEM_ID"),
        "sync_print_item must address the Print… item by PRINT_ITEM_ID: {body}"
    );
    assert!(
        body.contains("set_enabled("),
        "sync_print_item must call set_enabled on the Print… item: {body}"
    );
}

/// 21. 契約 4(本体側の止め): `handle_print_click` は前面の窓の `print_item_state` が
///     `Enabled` のときだけ MENU_PRINT_EVENT を送る。
#[test]
fn handle_print_click_emits_only_when_enabled() {
    let code = menu_rs_code();
    let (_, body) = function_parts(&code, "handle_print_click", "menu.rs");
    assert!(
        body.contains("print_item_state("),
        "handle_print_click must consult PrintAvailability::print_item_state for the frontmost window: {body}"
    );
    assert!(
        body.contains("Enabled"),
        "handle_print_click must gate the emit on PrintItemState::Enabled: {body}"
    );
    assert!(
        body.contains("MENU_PRINT_EVENT"),
        "handle_print_click must still emit MENU_PRINT_EVENT when enabled (the route stays the frontend's): {body}"
    );
}
