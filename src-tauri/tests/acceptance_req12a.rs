//! 要件#12 追補a の受け入れテスト(docs/requirements/req-12.md「追補a 窓の登録の外し方・失敗時の
//! 後始末・前面の窓」= Issue #598 / #385 / #710)— Rust 層(AC-12-追a (a)〜(d))
//!
//! 発端:
//! - #598: `lib.rs` は `app.listen("tauri://destroyed", …)` で窓の破棄を待って `unregister_window` を
//!   呼ぶが、Tauri 2.10.3 はこのイベントを窓の宛先にしか送らず(アプリ全体の購読には届かない)、
//!   中身も `()` でラベルが取れない(`extract_window_label_from_event`)。閉じた窓は WindowManager
//!   から一度も外れず、「All windows closed — exiting」も出ない
//! - #385: 窓の build に失敗したとき、IPC の経路(`ipc/handler.rs`)は登録を外すが、command と
//!   メニューの経路(`commands/window.rs` の `create_window`)は外さない
//! - #710: `WindowManager::set_active` が本番から呼ばれず、2 回目の CLI の送り先が前面の窓でなく
//!   最後に作った窓になる
//!
//! 判定範囲(req-12.md 追補a の受け入れ基準。(e)=既存テストが無改変で緑、は test-runner の
//! フルスイートで見る):
//! - (a) ソース走査(`lib.rs`): `tauri://destroyed` の購読と `extract_window_label_from_event` が無い。
//!   `on_window_event` の `WindowEvent::Destroyed` 分岐で `unregister_window` を窓のラベルで呼ぶ。
//!   `WindowEvent::Focused` 分岐で、前面になった(`Focused(true)`)文書の窓(`is_print_window` が偽)
//!   のときだけ `set_active` を呼ぶ。破棄のあとの「終える判定」は (b) の純関数で行い、終えるときは
//!   「All windows closed — exiting」をログに出して `exit(0)` する(契約 2)
//! - (b) 終える判定(純関数): 文書の窓の数と印刷窓の数から、両方 0 のときだけ終える。文書の窓が 0 でも
//!   印刷窓が 1 以上なら終えない(要件#38 追補m 契約 2=印刷のあいだはアプリを終えない)
//! - (c) ソース走査(`commands/window.rs`): `create_window` の build が失敗した経路で `unregister_window`
//!   を呼ぶ(IPC の経路と揃える)
//! - (d) `WindowManager`: `set_active(a)` → `active_label() == a`。active の窓を `unregister_window` すると
//!   `active_label()` はその窓を指さない(外すか次の窓へ移すかは今の作り=`windows.keys().next()`
//!   に従う。本ファイルは「その窓を指さない・指すなら登録の残っている窓」まで固定する)
//!
//! ## 確定契約(公開 API・implementer はこれに従う)
//!
//! ```ignore
//! // src-tauri/src/window/lifecycle.rs(新規。`src-tauri/src/window/mod.rs` に `pub mod lifecycle;`
//! // を足す)
//!
//! /// 窓が 1 つ破棄されたあと、アプリを終えるかどうか(要件#12 追補a 契約 2・要件#38 追補m 契約 2)。
//! /// `document_windows` = 破棄した窓を外したあとに WindowManager に残る文書の窓の数、
//! /// `print_windows` = 残っている印刷窓(`crate::print::is_print_window` が真のラベル)の数。
//! /// 両方 0 のときだけ true(終える)。印刷窓が 1 つでも残っていれば false。
//! pub fn should_exit_after_destroy(document_windows: usize, print_windows: usize) -> bool;
//!
//! // src-tauri/src/print.rs(既存・変更なし)
//! pub fn is_print_window(label: &str) -> bool;   // "print-…" のラベルだけ真
//!
//! // src-tauri/src/window/manager.rs(既存・変更なし)
//! impl<R: tauri::Runtime> WindowManager<R> {
//!     pub fn set_active(&mut self, label: &str);          // 登録済みのラベルだけ active にする
//!     pub fn active_label(&self) -> Option<&str>;
//!     pub fn unregister_window(&mut self, label: &str);  // active を外す/次の窓へ移す(今の作り)
//! }
//!
//! // src-tauri/src/lib.rs(配線=ソース走査)
//! // - `app.listen("tauri://destroyed", …)` と `fn extract_window_label_from_event` を消す
//! // - `.on_window_event(|window, event| { … })` の `WindowEvent::Destroyed` 分岐(ブロック)の中で
//! //   `unregister_window(` を `window.label()` で呼び、残った文書の窓の数と印刷窓の数を
//! //   `should_exit_after_destroy(` に渡して、true なら "All windows closed — exiting" をログに出して
//! //   `exit(0)` する(`app_handle.exit(0)`)
//! // - `WindowEvent::Focused` 分岐の中で、`*focused`(または `Focused(true)`)のブロックの中から
//! //   `.set_active(` を呼ぶ。その前に `is_print_window(` で印刷窓を除く
//! //
//! // src-tauri/src/commands/window.rs(配線=ソース走査)
//! // - `create_window` の `.build()` が失敗した経路(`Err`)で `unregister_window(` を呼んでから Err を返す
//! ```
//!
//! ソース走査の流儀は `acceptance_req38f.rs` / `acceptance_req55g.rs` と同じ(行コメントを落として
//! から `balanced_block` で分岐のブロックを切り出す)。分岐は `{ … }` のブロックで書くこと(`=> expr,`
//! の形は走査が別のブロックを拾う)。
//!
//! ## 赤の源
//!
//! (b) の `vellis_lib::window::lifecycle` は未定義なので本ファイルはコンパイルで赤。(a) は `lib.rs` に
//! `tauri://destroyed` / `extract_window_label_from_event` が残り、`Focused` に `set_active(` が無く、
//! `Destroyed` に `unregister_window(` が無いので赤。(c) は `create_window` に `unregister_window(` が
//! 無いので赤。(d) は今の `WindowManager` で緑(固定)。
//!
//! ## 走査が見ないもの(reviewer 照合・人間ゲート)
//! - 印刷窓の数をどう数えるか(`app.webview_windows()` を `is_print_window` で絞る等)。`Destroyed` の
//!   時点で破棄中の窓自身が一覧に残るかは Tauri の都合なので、残るなら自分を除いて数えること
//! - 実機で窓を全部閉じたときに「All windows closed — exiting」が出てアプリが終わること・印刷窓が
//!   残っているあいだは終わらないこと(要件#38 追補m の人間ゲート)

use tauri::test::MockRuntime;
use vellis_lib::print::is_print_window;
use vellis_lib::window::lifecycle::should_exit_after_destroy;
use vellis_lib::window::manager::{WindowArgs, WindowManager};

// ---------------------------------------------------------------------------
// AC-12-追a (b) — 終える判定(純関数)
// ---------------------------------------------------------------------------

/// 1. 文書の窓も印刷窓も 0 → 終える(契約 2)。
#[test]
fn no_windows_left_means_exit() {
    assert!(
        should_exit_after_destroy(0, 0),
        "with no document window and no print window left the app must exit"
    );
}

/// 2. 文書の窓が 0 でも印刷窓が 1 以上 → 終えない(要件#38 追補m 契約 2=印刷のあいだは終えない)。
#[test]
fn a_remaining_print_window_keeps_the_app_alive() {
    assert!(
        !should_exit_after_destroy(0, 1),
        "a print window still open must keep the app alive"
    );
    assert!(
        !should_exit_after_destroy(0, 2),
        "two print windows still open must keep the app alive"
    );
}

/// 3. 文書の窓が 1 以上 → 終えない(印刷窓の有無によらず)。
#[test]
fn a_remaining_document_window_keeps_the_app_alive() {
    assert!(
        !should_exit_after_destroy(1, 0),
        "one document window left must keep the app alive"
    );
    assert!(
        !should_exit_after_destroy(3, 0),
        "several document windows left must keep the app alive"
    );
    assert!(
        !should_exit_after_destroy(1, 1),
        "a document window and a print window left must keep the app alive"
    );
    assert!(
        !should_exit_after_destroy(2, 3),
        "several of both left must keep the app alive"
    );
}

/// 4. 印刷窓の見分け(既存の `print::is_print_window`・固定): 印刷窓のラベル(`print-` + ULID)だけ真、
///    文書の窓(`main` / `vellis-N`)は偽。(a) の `Focused` の除外と (b) の印刷窓の数はこれで決まる。
#[test]
fn print_window_labels_are_told_apart_from_document_windows() {
    assert!(
        is_print_window("print-01ARZ3NDEKTSV4RRFFQ69G5FAV"),
        "a print window label must be recognised"
    );
    assert!(!is_print_window("main"), "the first window is a document window");
    assert!(!is_print_window("vellis-1"), "a numbered window is a document window");
    assert!(!is_print_window("vellis-12"), "a numbered window is a document window");
    assert!(!is_print_window(""), "an empty label is not a print window");
}

// ---------------------------------------------------------------------------
// AC-12-追a (d) — WindowManager: set_active / active_label / unregister_window
// ---------------------------------------------------------------------------

fn manager_with(labels: &[&str]) -> WindowManager<MockRuntime> {
    let mut wm: WindowManager<MockRuntime> = WindowManager::new();
    for label in labels {
        wm.register_window((*label).to_string(), WindowArgs::default());
    }
    wm
}

/// 5. `set_active(a)` → `active_label() == a`。前面の窓が入れ替わるたびに記録が追いかける
///    (`Focused(true)` の配線がこれを呼ぶ=契約 4)。
#[test]
fn set_active_records_the_frontmost_window() {
    let mut wm = manager_with(&["vellis-1", "vellis-2", "vellis-3"]);
    assert_eq!(
        wm.active_label(),
        Some("vellis-3"),
        "precondition: the last registered window starts as the active one"
    );

    wm.set_active("vellis-1");
    assert_eq!(wm.active_label(), Some("vellis-1"), "set_active(a) must make a the active window");

    wm.set_active("vellis-2");
    assert_eq!(wm.active_label(), Some("vellis-2"), "the record must follow the next frontmost window");

    wm.set_active("vellis-1");
    assert_eq!(wm.active_label(), Some("vellis-1"), "…and back again");
}

/// 6. active の窓を `unregister_window` すると `active_label()` はその窓を指さない。指すなら登録の
///    残っている窓(外すか次の窓へ移すかは今の作りに従う)。
#[test]
fn unregistering_the_active_window_stops_pointing_at_it() {
    let mut wm = manager_with(&["vellis-1", "vellis-2"]);
    wm.set_active("vellis-1");
    assert_eq!(wm.active_label(), Some("vellis-1"), "precondition: vellis-1 is active");

    wm.unregister_window("vellis-1");

    assert_ne!(
        wm.active_label(),
        Some("vellis-1"),
        "the closed window must no longer be the active one"
    );
    assert!(wm.get("vellis-1").is_none(), "the closed window must be gone from the registry");
    if let Some(active) = wm.active_label() {
        assert!(
            wm.get(active).is_some(),
            "if a window is recorded as active it must be one that is still registered: {active}"
        );
    }
}

/// 7. 最後の窓(= active)を外すと `active_label()` は None(終える判定へ渡す「文書の窓の数」も 0)。
#[test]
fn unregistering_the_last_window_leaves_no_active_window() {
    let mut wm = manager_with(&["vellis-1"]);
    wm.set_active("vellis-1");

    wm.unregister_window("vellis-1");

    assert_eq!(wm.active_label(), None, "no window left means no active window");
    assert_eq!(wm.window_count(), 0, "no document window is left for the exit decision");
}

/// 8. active でない窓を外しても記録は動かない(前面の窓はそのまま=CLI の送り先が変わらない)。
#[test]
fn unregistering_another_window_keeps_the_active_record() {
    let mut wm = manager_with(&["vellis-1", "vellis-2", "vellis-3"]);
    wm.set_active("vellis-2");

    wm.unregister_window("vellis-3");
    assert_eq!(wm.active_label(), Some("vellis-2"), "closing a background window must not move the record");

    wm.unregister_window("vellis-1");
    assert_eq!(wm.active_label(), Some("vellis-2"), "closing another background window must not move it either");
    assert_eq!(wm.window_count(), 1);
}

/// 9. 前面の窓が閉じたあと、次に前面になった窓を `set_active` で記録し直せる(閉じる → 次の窓に
///    `Focused(true)` が来る、の順)。
#[test]
fn the_next_focused_window_becomes_active_after_the_frontmost_closed() {
    let mut wm = manager_with(&["vellis-1", "vellis-2", "vellis-3"]);
    wm.set_active("vellis-3");

    wm.unregister_window("vellis-3");
    wm.set_active("vellis-1");

    assert_eq!(wm.active_label(), Some("vellis-1"), "the newly focused window must be recorded");
}

/// 10. 印刷窓は登録されないので `set_active` しても記録は動かない(契約 4「印刷窓は記録しない」の
///     WindowManager 側の裏付け。配線側の除外は 14 で見る)。
#[test]
fn set_active_ignores_a_label_that_is_not_registered() {
    let mut wm = manager_with(&["vellis-1", "vellis-2"]);
    wm.set_active("vellis-1");

    wm.set_active("print-01ARZ3NDEKTSV4RRFFQ69G5FAV");

    assert_eq!(
        wm.active_label(),
        Some("vellis-1"),
        "a print window is never registered, so it must not become the active document window"
    );
}

// ---------------------------------------------------------------------------
// ソース走査の道具(acceptance_req38f.rs / acceptance_req55g.rs と同じ流儀)
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

fn window_command_code() -> String {
    strip_line_comments(include_str!("../src/commands/window.rs"))
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
    panic!("block must close")
}

/// `needle` の各出現の直後に続くブロック(`{ … }`)。
fn blocks_after<'a>(code: &'a str, needle: &str) -> Vec<&'a str> {
    code.match_indices(needle)
        .map(|(i, _)| balanced_block(code, i + needle.len()))
        .collect()
}

/// `fn <name>(` から始まる関数の本体。
fn function_body<'a>(code: &'a str, name: &str, file: &str) -> &'a str {
    let needle = format!("fn {name}(");
    let start = code
        .find(&needle)
        .unwrap_or_else(|| panic!("{file} must define {name}"));
    let params_start = start + needle.len();
    let params_end = code[params_start..].find(')').expect("parameter list must close") + params_start;
    balanced_block(code, params_end)
}

/// `.on_window_event(` に渡すクロージャの本体。
fn on_window_event_body(code: &str) -> &str {
    let at = code
        .find(".on_window_event(")
        .expect("lib.rs installs an on_window_event handler");
    balanced_block(code, at)
}

// ---------------------------------------------------------------------------
// AC-12-追a (a) — ソース走査: lib.rs の配線
// ---------------------------------------------------------------------------

/// 11. 契約 1: `tauri://destroyed` の購読(`app.listen("tauri://destroyed", …)`)と
///     `extract_window_label_from_event`(定義も呼び出しも)が `lib.rs` に無い。
#[test]
fn lib_rs_no_longer_listens_for_tauri_destroyed() {
    let code = lib_rs_code();
    assert!(
        !code.contains("tauri://destroyed"),
        "lib.rs must not subscribe to tauri://destroyed (the event never reaches an app-wide listener)"
    );
    assert!(
        !code.contains("extract_window_label_from_event"),
        "extract_window_label_from_event must be gone (the payload carries no label)"
    );
}

/// 12. 契約 1: `on_window_event` の `WindowEvent::Destroyed` 分岐の中で、その窓のラベルで
///     `unregister_window(` を呼ぶ(窓ごとに届くイベントで外す)。
#[test]
fn window_destroy_unregisters_the_window() {
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
            .any(|b| b.contains("unregister_window(") && b.contains("label()")),
        "a WindowEvent::Destroyed branch must call WindowManager::unregister_window with the window's label: {closure}"
    );
}

/// 13. 契約 2: 破棄のあとの終える判定は (b) の純関数 `should_exit_after_destroy(` で行い、終えるときは
///     "All windows closed — exiting" をログに出して `.exit(0)` する(`lib.rs` の配線)。
#[test]
fn window_destroy_decides_exit_with_the_pure_function() {
    let code = lib_rs_code();
    assert!(
        code.contains("should_exit_after_destroy("),
        "lib.rs must decide the exit after a destroy with window::lifecycle::should_exit_after_destroy"
    );
    assert!(
        code.contains("All windows closed — exiting"),
        "lib.rs must log \"All windows closed — exiting\" when the last window is gone"
    );
    assert!(
        code.contains("exit(0)"),
        "lib.rs must exit the app (exit(0)) when the last window is gone"
    );
    // 判定と終了が on_window_event の中(か、そこから呼ぶ lib.rs の関数)にあること: 消したはずの
    // app.listen の中には無い。
    let listen_blocks = blocks_after(&code, "app.listen(");
    assert!(
        listen_blocks
            .iter()
            .all(|b| !b.contains("should_exit_after_destroy(") && !b.contains("exit(0)")),
        "the exit decision must not live in an app.listen subscription: {listen_blocks:?}"
    );
}

/// 14. 契約 4: `on_window_event` の `WindowEvent::Focused` 分岐の中で、前面になったとき
///     (`*focused` / `Focused(true)` のブロックの中)に `.set_active(` を呼ぶ。その前に
///     `is_print_window(` で印刷窓を除く(印刷窓は記録しない)。
#[test]
fn window_focus_records_the_active_document_window() {
    let code = lib_rs_code();
    let closure = on_window_event_body(&code);
    let focused_blocks = blocks_after(closure, "WindowEvent::Focused");
    assert!(
        !focused_blocks.is_empty(),
        "on_window_event must handle WindowEvent::Focused: {closure}"
    );
    let recording = focused_blocks
        .iter()
        .find(|b| b.contains(".set_active("))
        .unwrap_or_else(|| {
            panic!("a WindowEvent::Focused branch must call WindowManager::set_active for the window: {closure}")
        });
    let guard_at = recording
        .find("is_print_window(")
        .unwrap_or_else(|| panic!("the Focused branch must exclude print windows with is_print_window: {recording}"));
    let set_at = recording.find(".set_active(").expect("found above");
    assert!(
        guard_at < set_at,
        "the print-window check must come before set_active: {recording}"
    );
    // 前面になったとき(true)だけ: `*focused` の条件ブロック、または `Focused(true)` の分岐の中。
    let true_blocks: Vec<&str> = blocks_after(closure, "Focused(true)")
        .into_iter()
        .chain(focused_blocks.iter().flat_map(|b| blocks_after(*b, "*focused")))
        .collect();
    assert!(
        true_blocks.iter().any(|b| b.contains(".set_active(")),
        "set_active must be called only when the window became frontmost (inside a `*focused` / `Focused(true)` block): {recording}"
    );
}

// ---------------------------------------------------------------------------
// AC-12-追a (c) — ソース走査: create_window の build 失敗で登録を外す
// ---------------------------------------------------------------------------

/// 15. 契約 3: `commands/window.rs` の `create_window` は `.build()` が失敗した経路(`Err`)で
///     `unregister_window(` を呼んでから Err を返す(IPC の経路 `ipc/handler.rs` と同じ後始末)。
#[test]
fn create_window_unregisters_the_label_when_the_build_fails() {
    let code = window_command_code();
    let body = function_body(&code, "create_window", "commands/window.rs");
    let build_at = body
        .find(".build()")
        .unwrap_or_else(|| panic!("create_window must build the window with .build(): {body}"));
    let after_build = &body[build_at..];
    let rollback_at = after_build
        .find("unregister_window(")
        .unwrap_or_else(|| panic!("create_window must unregister the label after a failed build: {body}"));
    let between = &after_build[..rollback_at];
    assert!(
        between.contains("Err") || between.contains("map_err") || between.contains("is_err"),
        "the unregister must sit on the build's error path (after Err / map_err): {after_build}"
    );
    // 登録は build の前(今のまま): ラベルは build より先に register されている。
    let register_at = body
        .find("register_new_window")
        .expect("create_window registers the window before building it");
    assert!(
        register_at < build_at,
        "the label must still be registered before the build (unchanged): {body}"
    );
}
