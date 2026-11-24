//! 要件#74 /code-review 不具合 B — View ▸ Raw Source / Show Formatting Toolbar のチェック印が実際とずれる(2026-11-22)。
//!
//! 両方とも常に有効な `CheckMenuItem` で、muda はクリックごとにチェックを**自分で反転**してからイベントを届ける。
//! 受け手のある面(Markdown の面)は `raw_source_state` / `format_toolbar_state` で正しい値を知らせ直すので印は合うが、
//! 受け手のない面(コード・テキスト・画像・Dashboard など)では誰も直さないので、クリックのたびにチェックだけが付いたり外れたりする。
//!
//! ## 直し方(オーケストレーターの決定)
//! `lib.rs` の `on_menu_event` で `RAW_SOURCE_ITEM_ID` / `SHOW_FORMAT_TOOLBAR_ITEM_ID` がクリックされたら、窓へ emit する**前に**
//! そのチェック項目の自動反転を元に戻す(`set_checked(!is_checked())`)。戻すのは `menu.rs` の小さな関数にする。チェック印は窓が
//! `raw_source_state` / `format_toolbar_state` で知らせる値だけで動く(`listen_raw_source_state` / `listen_format_toolbar_state`=既存)。
//!
//! ## 対応する受け入れ基準(req-74.md に記帳)
//! - AC-74-B1 `menu.rs` に `pub fn revert_check_toggle(app: &AppHandle<Wry>, id: &str)` があり、`find_check_menu_item` で `id` の
//!   `CheckMenuItem` を探し、`is_checked()` の否定を `set_checked(` する(muda の自動反転を元に戻す)
//! - AC-74-B2 `lib.rs` の `RAW_SOURCE_ITEM_ID` の腕は `menu::revert_check_toggle(app_handle, menu::RAW_SOURCE_ITEM_ID)` を
//!   `handle_menu_open_click(` より**前に**呼ぶ
//! - AC-74-B3 `lib.rs` の `SHOW_FORMAT_TOOLBAR_ITEM_ID` の腕も同じ(`menu::SHOW_FORMAT_TOOLBAR_ITEM_ID` で戻してから emit)
//! - AC-74-B4 戻す関数はチェック項目の 2 つの腕だけが呼ぶ(他の項目の腕には混ざらない)
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```text
//! // --- src-tauri/src/menu.rs
//! /// muda flips a CheckMenuItem's check on every click before the event arrives. Undo that flip so the check
//! /// follows only the window's report (raw_source_state / format_toolbar_state).
//! pub fn revert_check_toggle(app: &AppHandle<Wry>, id: &str) {
//!     let Some(item) = app.menu().and_then(|menu| find_check_menu_item(&menu, id)) else { return; };
//!     match item.is_checked() {
//!         Ok(checked) => { if let Err(e) = item.set_checked(!checked) { tracing::warn!(…); } }
//!         Err(e) => tracing::warn!(…),
//!     }
//! }
//! // --- src-tauri/src/lib.rs の on_menu_event
//! id if id == menu::SHOW_FORMAT_TOOLBAR_ITEM_ID => {
//!     menu::revert_check_toggle(app_handle, menu::SHOW_FORMAT_TOOLBAR_ITEM_ID);
//!     menu::handle_menu_open_click(app_handle, menu::MENU_SHOW_FORMAT_TOOLBAR_EVENT);
//! }
//! id if id == menu::RAW_SOURCE_ITEM_ID => {
//!     menu::revert_check_toggle(app_handle, menu::RAW_SOURCE_ITEM_ID);
//!     menu::handle_menu_open_click(app_handle, menu::MENU_RAW_SOURCE_EVENT);
//! }
//! ```
//!
//! ## 判断の記録(test-writer・2026-11-22)
//! - muda のメニューは main thread が要り、`AppHandle` 無しに `CheckMenuItem` を作れないので、振る舞いのテストは書けない。
//!   既存の `acceptance_req74_menu.rs` と同じ**ソース走査**(`fn_body` / `on_menu_event_block` / `menu_arm_body`)で配線を固定する
//! - 戻す関数の形は `(app, id)` にした(腕は `app_handle` と ID の定数しか持たず、項目の束縛は `build()` の中にあるため。
//!   `listen_*_state` と同じ `find_check_menu_item` の経路に乗る)。項目を受ける形(`&CheckMenuItem<R>`)より腕の呼び出しが短い
//! - 関数名は `revert_check_toggle` に固定(ソース走査で名前を見るため)。シグネチャの型は走査では見ない(コンパイルの縛りは掛けない)
//! - 「set_checked(!is_checked())」は tauri の API が `Result` を返すので、`is_checked()` と `set_checked(!` の両方が本文にあることで見る
//!
//! ## 修正前に赤になる理由
//! - B1: `menu.rs` に `fn revert_check_toggle` が無い(`fn_body` が panic)
//! - B2・B3: 2 つの腕の本文は `handle_menu_open_click` だけで、`revert_check_toggle(` を含まない

use std::path::PathBuf;

use vellis_lib::menu::{RAW_SOURCE_ITEM_ID, SHOW_FORMAT_TOOLBAR_ITEM_ID};

// ---------------------------------------------------------------------------
// ソースの読み取り(acceptance_req74_menu.rs と同じ道具)
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

/// `fn name(` の宣言の先頭から本文の終わりまで(シグネチャを含む)。
fn fn_decl(code: &str, name: &str) -> String {
    let start =
        fn_decl_start(code, name).unwrap_or_else(|| panic!("source must define `fn {name}(` (or `fn {name}<`)"));
    let params_open = code[start..].find('(').expect("fn must take parameters") + start;
    let params_close = matching_close(code, params_open);
    let open = code[params_close..].find('{').expect("fn must have a body") + params_close;
    let close = matching_close(code, open);
    code[start..=close].to_string()
}

fn fn_body(code: &str, name: &str) -> String {
    let decl = fn_decl(code, name);
    let open = decl.find('{').expect("fn must have a body");
    decl[open + 1..decl.len() - 1].to_string()
}

fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
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

/// 腕の本文が「戻す → emit」の順で呼ぶことを確かめる(共通)。
fn assert_arm_reverts_then_emits(arm: &str, item_const: &str, event_const: &str) {
    let squashed = squash(arm);
    let revert_at = squashed
        .find("revert_check_toggle(")
        .unwrap_or_else(|| panic!("the {item_const} arm must call menu::revert_check_toggle before emitting: {arm}"));
    let revert_call = &squashed[revert_at..];
    let revert_close = revert_call.find(')').expect("revert_check_toggle call must close");
    let revert_args = &revert_call["revert_check_toggle(".len()..revert_close];
    assert!(
        revert_args.contains("app_handle") && revert_args.contains(&format!("menu::{item_const}")),
        "revert_check_toggle takes the app handle and menu::{item_const} ({revert_args})"
    );
    let emit_at = squashed
        .find("handle_menu_open_click(")
        .unwrap_or_else(|| panic!("the {item_const} arm must still call handle_menu_open_click: {arm}"));
    assert!(revert_at < emit_at, "the check is reverted BEFORE the window is told ({arm})");
    assert!(squashed.contains(&format!("menu::{event_const}")), "the arm still emits menu::{event_const} ({arm})");
    assert_eq!(squashed.matches("revert_check_toggle(").count(), 1, "revert exactly once per click ({arm})");
}

// ---------------------------------------------------------------------------
// AC-74-B1 — menu.rs: 戻す関数
// ---------------------------------------------------------------------------

/// B1. `pub fn revert_check_toggle(app, id)` が `find_check_menu_item` で項目を探し、`is_checked()` の否定を `set_checked(` する。
#[test]
fn ac74_b1_menu_rs_defines_revert_check_toggle_that_undoes_mudas_flip() {
    let code = menu_rs_code();
    let decl = fn_decl(&code, "revert_check_toggle");
    assert!(code.contains("pub fn revert_check_toggle"), "revert_check_toggle is pub (lib.rs calls it as menu::revert_check_toggle)");
    let signature = &decl[..decl.find('{').unwrap()];
    assert!(signature.contains("AppHandle"), "takes the AppHandle (looks the item up through app.menu()): {signature}");
    assert!(signature.contains("&str"), "takes the item id as &str: {signature}");

    let body = squash(&fn_body(&code, "revert_check_toggle"));
    assert!(body.contains("find_check_menu_item("), "looks the CheckMenuItem up with find_check_menu_item (same path as listen_*_state): {body}");
    assert!(body.contains("is_checked()"), "reads the current (already flipped) check with is_checked(): {body}");
    assert!(body.contains("set_checked(!"), "writes the negation back with set_checked(!…): {body}");
    assert!(!body.contains("emit"), "the revert helper does not talk to the window (the arm does): {body}");
}

// ---------------------------------------------------------------------------
// AC-74-B2 / B3 — lib.rs: 2 つの腕は「戻す → emit」
// ---------------------------------------------------------------------------

/// B2. View ▸ Raw Source の腕。
#[test]
fn ac74_b2_raw_source_arm_reverts_the_check_before_emitting() {
    let lib = lib_rs_code();
    let block = on_menu_event_block(&lib);
    let arm = menu_arm_body(block, "RAW_SOURCE_ITEM_ID");
    assert_arm_reverts_then_emits(arm, "RAW_SOURCE_ITEM_ID", "MENU_RAW_SOURCE_EVENT");
    assert_eq!(RAW_SOURCE_ITEM_ID, "raw-source");
}

/// B3. View ▸ Show Formatting Toolbar の腕。
#[test]
fn ac74_b3_show_format_toolbar_arm_reverts_the_check_before_emitting() {
    let lib = lib_rs_code();
    let block = on_menu_event_block(&lib);
    let arm = menu_arm_body(block, "SHOW_FORMAT_TOOLBAR_ITEM_ID");
    assert_arm_reverts_then_emits(arm, "SHOW_FORMAT_TOOLBAR_ITEM_ID", "MENU_SHOW_FORMAT_TOOLBAR_EVENT");
    assert_eq!(SHOW_FORMAT_TOOLBAR_ITEM_ID, "show-format-toolbar");
}

// ---------------------------------------------------------------------------
// AC-74-B4 — 戻すのはチェック項目の 2 つの腕だけ
// ---------------------------------------------------------------------------

/// B4. `on_menu_event` の中で `revert_check_toggle(` はちょうど 2 回(Raw Source と Show Formatting Toolbar)。
///     他の(チェックでない)項目の腕に混ざると、その項目のチェックを作ってしまう。
#[test]
fn ac74_b4_only_the_two_check_items_revert() {
    let lib = lib_rs_code();
    let block = on_menu_event_block(&lib);
    assert_eq!(
        block.matches("revert_check_toggle(").count(),
        2,
        "exactly the two CheckMenuItem arms call revert_check_toggle"
    );
    // チェック印の正本は窓の報告(既存の listen_*_state)。戻す関数が listen の中に入り込んでいない。
    let code = menu_rs_code();
    for listener in ["listen_raw_source_state", "listen_format_toolbar_state"] {
        let body = fn_body(&code, listener);
        assert!(!body.contains("revert_check_toggle("), "{listener} sets the check from the window's value, it does not revert ({body})");
        assert!(body.contains("set_checked("), "{listener} still sets the check from the window's report");
    }
}
