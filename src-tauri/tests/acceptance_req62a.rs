//! 要件#62 追補a/b/c・AC-62-16〜22 の受け入れテスト(docs/requirements/req-62.md)— Rust 層
//!
//! 1 周目(acceptance_req62.rs=AC-62-1〜15)のあとの実機確認で出た NG 3 件への追補:
//! - 追補a: 新しいタブは隠して(`visible(false)`)作り、右隣に加えてから前面に出す。
//!   タブとして作る窓は window-state の復元・保存の対象外=元の窓が動かない
//! - 追補b: タブの標準メニュー項目を自前で置く= View ▸ Show Tab Bar / Show All Tabs・
//!   Window ▸ Move Tab to New Window / Merge All Windows
//! - 追補c: New Tab 以外の窓は窓ごとに一意の鍵で作り、`init_window` で root の鍵に
//!   付け替える=全画面中でも生成の途中で自動でタブにならない(固まらない)
//!
//! 本ファイルの持ち場(機械判定できる範囲):
//! - AC-62-16(追補a・c)純関数 `window_placement(kind)` の値固定
//! - AC-62-17(追補a)  隠して作る・window-state の対象外(ソース走査 4 点)
//! - AC-62-18(追補b)  4 項目の定数・アクセラレータの parse・ラベル・アクセラレータの渡し方
//! - AC-62-19(追補b)  View / Window メニューの並び(ソース走査)
//! - AC-62-20(追補b)  配線(ID の出現数・objc2 の呼び出し・`objc2-app-kit` の features 不変)
//! - AC-62-21(追補c)  生成時の鍵(`handle_open_path` / 窓を作る関数の本体・ソース走査)
//! - AC-62-22(一部)   新しいアクセラレータが acceptance_req60 の衝突検査の網に入る形で
//!   `menu.rs` に現れる(`+` を含む文字列リテラル)。既存テストの無改変は reviewer 照合
//!
//! 人間ゲート 11〜13 に送った範囲(本ファイルでは判定しない):
//! - 11(追補a)実機で窓が動かない・別の窓が一瞬見えない・新しいタブが右隣で前面になる
//! - 12(追補b)Show Tab Bar / Show All Tabs / Move Tab to New Window / Merge All Windows の
//!   効き・同じ root の窓だけがまとまる・タブバーへドラッグで戻せる・項目が二重に出ない・
//!   Control + Tab の切り替え
//! - 13(追補c)全画面表示中に Duplicate Window / New Window / Open in New Window /
//!   Go to Path / Shift + クリックが固まらずに別の窓で開く
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前・公開パス)
//!
//! ```ignore
//! // --- src-tauri/src/window/tab.rs(既存)に追加。本テストは
//! //     `vellis_lib::window::tab::{window_placement, KeySource, Placement, WindowKind}` で解決する。
//! #[derive(Clone, Copy, Debug, PartialEq, Eq)]
//! pub enum WindowKind { Tab, Standalone }
//! #[derive(Clone, Copy, Debug, PartialEq, Eq)]
//! pub enum KeySource { Root, NoRoot }
//! #[derive(Clone, Copy, Debug, PartialEq, Eq)]
//! pub struct Placement { pub visible: bool, pub track_window_state: bool, pub key: KeySource }
//! pub fn window_placement(kind: WindowKind) -> Placement;
//!
//! // --- src-tauri/src/menu.rs — 既存の *_ITEM_ID / *_ACCELERATOR と同じ家風
//! pub const SHOW_TAB_BAR_ITEM_ID: &str = "show-tab-bar";
//! pub const SHOW_ALL_TABS_ITEM_ID: &str = "show-all-tabs";
//! pub const MOVE_TAB_TO_NEW_WINDOW_ITEM_ID: &str = "move-tab-to-new-window";
//! pub const MERGE_ALL_WINDOWS_ITEM_ID: &str = "merge-all-windows";
//! pub const SHOW_TAB_BAR_ACCELERATOR: &str = "CmdOrCtrl+Shift+T";
//! pub const SHOW_ALL_TABS_ACCELERATOR: &str = "CmdOrCtrl+Shift+Backslash";
//! ```
//!
//! ソース走査が前提にする形(既存コードの家風どおり):
//! - 4 項目の MenuItem は `let <binding> = MenuItem::with_id(app, <ID 定数>, "<ラベル>", true,
//!   <Some(<ACCELERATOR 定数>) | None>)?;` の形で束縛し、View / Window の Submenu の項目スライス
//!   `&[&a, &b, …]` に置く(View は `Submenu::with_items`・Window は `Submenu::with_id_and_items`
//!   のまま。本テストは `Submenu::with_` で始まる呼び出しのラベルで見分ける)
//! - View の先頭の区切り線は `let <binding> = PredefinedMenuItem::separator(app)?;` で束縛する
//! - `lib.rs` の window-state プラグイン登録は `tauri_plugin_window_state::Builder::default()` から
//!   始まるメソッド連鎖で、その中に `.with_filter(` がある
//! - `commands/window.rs` で `WebviewWindowBuilder::new(` を含む関数の本体では、識別子
//!   `track_window_state` の参照(タブのラベル集合へ入れる判定)が `WebviewWindowBuilder::new(`
//!   より前にあり、同じ関数の全ての builder 連鎖が `.visible(` を呼ぶ
//! - `WindowKind::Tab` はコード行では `new_tab` の本体と `window/tab.rs` にだけ現れる
//! - `new_tab` 以外の窓を作る関数(`create_window`)の本体には `tab_group_key(None,` と
//!   `KeySource::NoRoot` がある。`handle_open_path` の本体の `tab_group_key(` の第 1 引数は
//!   すべて `None`
//! - `window/tab.rs` のコード行に `toggleTabBar(` / `toggleTabOverview(` / `mergeAllWindows(` が
//!   あり、`moveTabToNewWindow(` は 2 箇所以上(契約9 の既存 1 箇所+メニューの経路)
//!
//! ## reviewer 照合に委ねる項目(AppHandle / NSWindow 依存で機械判定不能)
//! - `add_tabbed_window` が加えたあとに `makeKeyAndOrderFront:` で前面に出し、隠れた窓を残さないこと
//! - filter が「タブのラベル集合」に含まれるラベルに `false` を返すこと(集合は managed state)
//! - 4 項目のクリックが `focused_or_first_window` の NSWindow に同名の objc メソッドを送ること
//! - `WindowArgs` にフィールドを足していないこと(AC-62-15 の既存テストのコンパイル)
//! - acceptance_req60 / acceptance_req62 の既存テストが無改変で緑(AC-62-22)

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use muda::accelerator::Accelerator;
use vellis_lib::menu::{
    ACTUAL_SIZE_ITEM_ID, MERGE_ALL_WINDOWS_ITEM_ID, MOVE_TAB_TO_NEW_WINDOW_ITEM_ID,
    NEXT_TAB_ITEM_ID, PREVIOUS_TAB_ITEM_ID, SHOW_ALL_TABS_ACCELERATOR, SHOW_ALL_TABS_ITEM_ID,
    SHOW_TAB_BAR_ACCELERATOR, SHOW_TAB_BAR_ITEM_ID, TOGGLE_DEVTOOLS_ITEM_ID, ZOOM_IN_ITEM_ID,
    ZOOM_OUT_ITEM_ID,
};
use vellis_lib::window::tab::{window_placement, KeySource, Placement, WindowKind};

// ---------------------------------------------------------------------------
// 共通ヘルパ — acceptance_req62.rs と同じ流儀(ソースの読み込み・コメント落とし・括弧)
// ---------------------------------------------------------------------------

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_source(rel: &str) -> String {
    let path = manifest_dir().join(rel);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {}", path.display(), e))
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

fn commands_window_rs_code() -> String {
    strip_line_comments(include_str!("../src/commands/window.rs"))
}

fn window_tab_rs_code() -> String {
    strip_line_comments(include_str!("../src/window/tab.rs"))
}

fn ipc_handler_rs_code() -> String {
    strip_line_comments(include_str!("../src/ipc/handler.rs"))
}

/// `src-tauri/src/**/*.rs` を再帰的に集める(相対パス・ソート済み)。
fn all_rust_sources() -> Vec<(String, String)> {
    fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, String)>) {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .unwrap_or_else(|e| panic!("cannot read {}: {}", dir.display(), e))
            .map(|e| e.expect("dir entry").path())
            .collect();
        entries.sort();
        for path in entries {
            if path.is_dir() {
                walk(&path, base, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                let rel = path
                    .strip_prefix(base)
                    .expect("under src")
                    .to_string_lossy()
                    .replace('\\', "/");
                let src = std::fs::read_to_string(&path)
                    .unwrap_or_else(|e| panic!("cannot read {}: {}", path.display(), e));
                out.push((rel, src));
            }
        }
    }
    let base = manifest_dir().join("src");
    let mut out = Vec::new();
    walk(&base, &base, &mut out);
    out
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

/// `start` から始まるメソッド連鎖全体(`.ident(` が続く限り取り込む)。
fn method_chain(code: &str, start: usize) -> &str {
    let mut end = start + balanced_call(code, start).len();
    loop {
        let rest = &code[end..];
        let trimmed = rest.trim_start();
        let Some(after_dot) = trimmed.strip_prefix('.') else {
            break;
        };
        let ident_len = after_dot
            .char_indices()
            .find(|(_, c)| !(c.is_alphanumeric() || *c == '_'))
            .map(|(i, _)| i)
            .unwrap_or(after_dot.len());
        if ident_len == 0 || !after_dot[ident_len..].starts_with('(') {
            break;
        }
        let ws = rest.len() - trimmed.len();
        let call_start = end + ws + 1;
        let open = call_start + ident_len;
        end = matching_close(code, open) + 1;
    }
    &code[start..end]
}

/// 呼び出しテキスト中の最初の二重引用符リテラルの中身。
fn first_string_literal(s: &str) -> Option<&str> {
    let a = s.find('"')? + 1;
    let b = s[a..].find('"')? + a;
    Some(&s[a..b])
}

/// 呼び出し `f(a, b, …)` の最後の引数(前後の空白を落としたテキスト)。
/// 対象の呼び出し(MenuItem::with_id)の引数にカンマを含む式は無い。
fn last_argument(call: &str) -> &str {
    let open = call.find('(').expect("call must have '('");
    let inner = &call[open + 1..call.len() - 1];
    inner
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .last()
        .expect("call must have at least one argument")
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

/// `const_name` を使う MenuItem の束縛名。
fn menu_item_binding<'a>(code: &'a str, const_name: &str) -> &'a str {
    let call = menu_item_call_using(code, const_name)
        .unwrap_or_else(|| panic!("menu.rs must build a MenuItem with {const_name}"));
    let use_pos = call.as_ptr() as usize - code.as_ptr() as usize;
    let_binding_before(code, use_pos, const_name)
}

/// `let <binding> = PredefinedMenuItem::separator(` で束縛された区切り線の名前の集合。
fn separator_bindings(code: &str) -> BTreeSet<&str> {
    code.match_indices("PredefinedMenuItem::separator(")
        .map(|(pos, _)| let_binding_before(code, pos, "PredefinedMenuItem::separator"))
        .collect()
}

/// `fn <name>(` で始まる関数の本体(最初の `{` から対応する `}` まで)。
fn fn_body<'a>(code: &'a str, name: &str) -> &'a str {
    let needle = format!("fn {name}(");
    let start = code
        .find(&needle)
        .unwrap_or_else(|| panic!("source must define `{needle}...`"));
    let open = code[start..].find('{').expect("fn must have a body") + start;
    let close = matching_close(code, open);
    &code[open..=close]
}

/// `pos` を本体に含む最も内側の関数: (関数名, 本体, 本体の開始位置)。
fn enclosing_fn(code: &str, pos: usize) -> (&str, &str, usize) {
    let mut found: Option<(&str, &str, usize)> = None;
    for (start, _) in code.match_indices("fn ") {
        if start >= pos {
            break;
        }
        if start > 0 && !code[..start].ends_with(|c: char| c.is_whitespace()) {
            continue;
        }
        let name_start = start + 3;
        let name_len = code[name_start..]
            .find(|c: char| !(c.is_alphanumeric() || c == '_'))
            .unwrap_or(0);
        if name_len == 0 {
            continue;
        }
        let name = &code[name_start..name_start + name_len];
        let Some(open_rel) = code[start..].find('{') else {
            continue;
        };
        let open = start + open_rel;
        if open > pos {
            continue;
        }
        let close = matching_close(code, open);
        if pos <= close {
            found = Some((name, &code[open..=close], open));
        }
    }
    found.unwrap_or_else(|| panic!("byte {pos} must lie inside a function body"))
}

/// 二重引用符の文字列リテラルの中身(acceptance_req60 の menu_rs_string_literals と同じ)。
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

/// `commands/window.rs` の `WebviewWindowBuilder::new(` ごとの (位置, 連鎖テキスト)。
fn builder_sites(code: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let mut search = 0;
    while let Some(rel) = code[search..].find("WebviewWindowBuilder::new(") {
        let start = search + rel;
        out.push((start, method_chain(code, start)));
        search = start + "WebviewWindowBuilder::new(".len();
    }
    out
}

// ---------------------------------------------------------------------------
// AC-62-16 — 窓の置き方 `window_placement(kind)`(追補a・c・純関数の値固定)
// ---------------------------------------------------------------------------

/// 1. 新しいタブ=隠して作る・window-state の対象外・鍵は root から。
#[test]
fn tab_placement_is_hidden_untracked_and_keyed_by_root() {
    assert_eq!(
        window_placement(WindowKind::Tab),
        Placement {
            visible: false,
            track_window_state: false,
            key: KeySource::Root,
        }
    );
}

/// 2. 独立の窓=見せて作る・window-state の対象・鍵は窓ごとに一意(no-root)。
#[test]
fn standalone_placement_is_visible_tracked_and_keyed_uniquely() {
    assert_eq!(
        window_placement(WindowKind::Standalone),
        Placement {
            visible: true,
            track_window_state: true,
            key: KeySource::NoRoot,
        }
    );
}

/// 3. 2 つの置き方は 3 点とも逆(どちらか一方に寄っていない)。
#[test]
fn tab_and_standalone_placements_differ_in_every_field() {
    let tab = window_placement(WindowKind::Tab);
    let standalone = window_placement(WindowKind::Standalone);
    assert_ne!(tab, standalone);
    assert_ne!(tab.visible, standalone.visible);
    assert_ne!(tab.track_window_state, standalone.track_window_state);
    assert_ne!(tab.key, standalone.key);
}

// ---------------------------------------------------------------------------
// AC-62-17 — 隠して作る・window-state の対象外(追補a・ソース走査)
// ---------------------------------------------------------------------------

/// 4. (1) `commands/window.rs` の全ての `WebviewWindowBuilder::new(` 連鎖が `.visible(` を呼ぶ
///    (置き方の `visible` をビルダーへ渡す口)。既存 AC-62-2 の `.tabbing_identifier(` も保つ。
#[test]
fn every_builder_chain_in_commands_window_sets_visible() {
    let code = commands_window_rs_code();
    let sites = builder_sites(&code);
    assert!(!sites.is_empty(), "commands/window.rs must build at least one window");
    for (_, chain) in &sites {
        assert!(
            chain.contains(".visible("),
            "this WebviewWindowBuilder chain must call .visible(...):\n{chain}"
        );
        assert!(
            chain.contains(".tabbing_identifier("),
            "this WebviewWindowBuilder chain must keep .tabbing_identifier(...) (AC-62-2):\n{chain}"
        );
    }
}

/// 5. (2) `new_tab` の本体に `WindowKind::Tab` があり、コード行で `WindowKind::Tab` が現れるのは
///    `new_tab` の本体と `window/tab.rs` だけ(他の経路がタブの置き方を使わない)。
#[test]
fn window_kind_tab_appears_only_in_new_tab_and_tab_rs() {
    let code = commands_window_rs_code();
    let new_tab = fn_body(&code, "new_tab");
    assert!(
        new_tab.contains("WindowKind::Tab"),
        "new_tab must ask for WindowKind::Tab in its own body"
    );
    let inside_new_tab = new_tab.matches("WindowKind::Tab").count();

    for (rel, src) in all_rust_sources() {
        if rel == "window/tab.rs" {
            continue;
        }
        let file_code = strip_line_comments(&src);
        let total = file_code.matches("WindowKind::Tab").count();
        let allowed = if rel == "commands/window.rs" { inside_new_tab } else { 0 };
        assert_eq!(
            total, allowed,
            "{rel}: WindowKind::Tab may appear only inside new_tab's body and window/tab.rs (found {total}, allowed {allowed})"
        );
    }
}

/// 6. (3) `WebviewWindowBuilder::new(` を含む関数の本体で、`track_window_state` の参照
///    (タブのラベル集合へ入れる判定)がビルダーより前にある(=`.build()` より前に
///    集合へ入れるので、プラグインの窓生成時の hook が filter で弾ける)。
#[test]
fn label_set_decision_precedes_the_builder_in_every_creating_fn() {
    let code = commands_window_rs_code();
    let sites = builder_sites(&code);
    assert!(!sites.is_empty(), "commands/window.rs must build at least one window");
    for (pos, _) in sites {
        let (name, body, body_start) = enclosing_fn(&code, pos);
        let builder_in_body = pos - body_start;
        let track = body.find("track_window_state").unwrap_or_else(|| {
            panic!("fn {name}: the body that builds the window must reference track_window_state")
        });
        assert!(
            track < builder_in_body,
            "fn {name}: track_window_state must be consulted before WebviewWindowBuilder::new( (found at {track}, builder at {builder_in_body})"
        );
    }
}

/// 7. (4) `lib.rs` の window-state プラグイン登録が `.with_filter(` を呼ぶ
///    (タブのラベルを復元・保存の対象から外す口)。
#[test]
fn window_state_plugin_is_registered_with_a_filter() {
    let code = lib_rs_code();
    let start = code
        .find("tauri_plugin_window_state::Builder")
        .expect("lib.rs must register tauri_plugin_window_state::Builder");
    let chain = method_chain(&code, start);
    assert!(
        chain.contains(".with_filter("),
        "the window-state plugin registration must call .with_filter(...):\n{chain}"
    );
    assert!(
        chain.contains(".build("),
        "the window-state plugin registration must end with .build():\n{chain}"
    );
}

// ---------------------------------------------------------------------------
// AC-62-18 — タブの標準項目の定数とラベル(追補b)
// ---------------------------------------------------------------------------

/// 8. 項目 ID の値固定。
#[test]
fn tab_menu_item_ids_are_fixed() {
    assert_eq!(SHOW_TAB_BAR_ITEM_ID, "show-tab-bar");
    assert_eq!(SHOW_ALL_TABS_ITEM_ID, "show-all-tabs");
    assert_eq!(MOVE_TAB_TO_NEW_WINDOW_ITEM_ID, "move-tab-to-new-window");
    assert_eq!(MERGE_ALL_WINDOWS_ITEM_ID, "merge-all-windows");
}

/// 9. アクセラレータの綴りの値固定(Show All Tabs は `Backslash` と綴る=衝突検査の網に入る)。
#[test]
fn tab_menu_accelerators_are_fixed() {
    assert_eq!(SHOW_TAB_BAR_ACCELERATOR, "CmdOrCtrl+Shift+T");
    assert_eq!(SHOW_ALL_TABS_ACCELERATOR, "CmdOrCtrl+Shift+Backslash");
}

/// 10. 両アクセラレータが muda で parse できる(tauri は失敗を黙って捨てる=要件#36 の教訓)。
#[test]
fn tab_menu_accelerators_parse_as_tauri_accelerators() {
    for (name, value) in [
        ("SHOW_TAB_BAR_ACCELERATOR", SHOW_TAB_BAR_ACCELERATOR),
        ("SHOW_ALL_TABS_ACCELERATOR", SHOW_ALL_TABS_ACCELERATOR),
    ] {
        assert!(
            Accelerator::from_str(value).is_ok(),
            "{name} '{value}' must parse - tauri silently drops unparsable ones"
        );
    }
    assert_ne!(
        Accelerator::from_str(SHOW_TAB_BAR_ACCELERATOR).unwrap(),
        Accelerator::from_str(SHOW_ALL_TABS_ACCELERATOR).unwrap()
    );
}

/// 11. 4 項目のラベル(英語・固定)。
#[test]
fn tab_menu_items_carry_english_labels() {
    let code = menu_rs_code();
    for (const_name, label) in [
        ("SHOW_TAB_BAR_ITEM_ID", "Show Tab Bar"),
        ("SHOW_ALL_TABS_ITEM_ID", "Show All Tabs"),
        ("MOVE_TAB_TO_NEW_WINDOW_ITEM_ID", "Move Tab to New Window"),
        ("MERGE_ALL_WINDOWS_ITEM_ID", "Merge All Windows"),
    ] {
        let call = menu_item_call_using(&code, const_name)
            .unwrap_or_else(|| panic!("menu.rs must build a MenuItem::with_id(...{const_name}...)"));
        assert_eq!(
            first_string_literal(call),
            Some(label),
            "the {const_name} item's label must be the literal \"{label}\""
        );
    }
}

/// 12. Show Tab Bar / Show All Tabs はそれぞれの ACCELERATOR 定数を渡す(インラインリテラルではなく)。
#[test]
fn show_tab_bar_and_show_all_tabs_pass_their_accelerator_constants() {
    let code = menu_rs_code();
    for (const_name, accel) in [
        ("SHOW_TAB_BAR_ITEM_ID", "SHOW_TAB_BAR_ACCELERATOR"),
        ("SHOW_ALL_TABS_ITEM_ID", "SHOW_ALL_TABS_ACCELERATOR"),
    ] {
        let call = menu_item_call_using(&code, const_name)
            .unwrap_or_else(|| panic!("menu.rs must build a MenuItem::with_id(...{const_name}...)"));
        assert!(
            call.contains(accel),
            "the {const_name} item must pass {accel} (not an inline literal):\n{call}"
        );
        assert_eq!(
            last_argument(call),
            format!("Some({accel})"),
            "the {const_name} item's accelerator argument must be Some({accel})"
        );
    }
}

/// 13. Move Tab to New Window / Merge All Windows はアクセラレータ無し
///     (ショートカット無し=AppKit 標準と同じ)。最終引数は `None` で始まり `Some(` ではない
///     (tauri 2.10 の `Option<A: AsRef<str>>` は素の `None` だと型推論できないので、既存の
///     Install CLI 項目と同じ `None::<&str>` も可)。
#[test]
fn move_tab_and_merge_all_pass_no_accelerator() {
    let code = menu_rs_code();
    for const_name in ["MOVE_TAB_TO_NEW_WINDOW_ITEM_ID", "MERGE_ALL_WINDOWS_ITEM_ID"] {
        let call = menu_item_call_using(&code, const_name)
            .unwrap_or_else(|| panic!("menu.rs must build a MenuItem::with_id(...{const_name}...)"));
        let accel = last_argument(call);
        assert!(
            accel.starts_with("None") && !accel.starts_with("Some("),
            "the {const_name} item must pass no accelerator (None or None::<&str>), found `{accel}`:\n{call}"
        );
    }
}

// ---------------------------------------------------------------------------
// AC-62-19 — 並び(追補b・ソース走査)
// ---------------------------------------------------------------------------

/// 14. View メニューは Show Tab Bar・Show All Tabs・区切り線で始まり、その後に既存の
///     Zoom In・Zoom Out・Actual Size・区切り線・Toggle Developer Tools が従来の順で続く
///     (項目数 8=他の項目を挟まない)。
#[test]
fn view_menu_starts_with_tab_bar_items_then_the_existing_order() {
    let code = menu_rs_code();
    let view_menu = submenu_call_with_label(&code, "View")
        .expect("menu.rs must build a submenu labelled \"View\"");
    let idents = submenu_item_idents(view_menu);
    let separators = separator_bindings(&code);
    let expected_len = 8;
    assert_eq!(
        idents.len(),
        expected_len,
        "View menu must hold exactly {expected_len} entries ({idents:?})"
    );

    let show_tab_bar = menu_item_binding(&code, "SHOW_TAB_BAR_ITEM_ID");
    let show_all_tabs = menu_item_binding(&code, "SHOW_ALL_TABS_ITEM_ID");
    let zoom_in = menu_item_binding(&code, "ZOOM_IN_ITEM_ID");
    let zoom_out = menu_item_binding(&code, "ZOOM_OUT_ITEM_ID");
    let actual_size = menu_item_binding(&code, "ACTUAL_SIZE_ITEM_ID");
    let devtools = menu_item_binding(&code, "TOGGLE_DEVTOOLS_ITEM_ID");

    assert_eq!(idents[0], show_tab_bar, "View[0] must be Show Tab Bar ({idents:?})");
    assert_eq!(idents[1], show_all_tabs, "View[1] must be Show All Tabs ({idents:?})");
    assert!(
        separators.contains(idents[2]),
        "View[2] must be a PredefinedMenuItem::separator binding ({idents:?}; separators: {separators:?})"
    );
    assert_eq!(idents[3], zoom_in, "View[3] must be Zoom In ({idents:?})");
    assert_eq!(idents[4], zoom_out, "View[4] must be Zoom Out ({idents:?})");
    assert_eq!(idents[5], actual_size, "View[5] must be Actual Size ({idents:?})");
    assert!(
        separators.contains(idents[6]),
        "View[6] must be a PredefinedMenuItem::separator binding ({idents:?})"
    );
    assert_eq!(idents[7], devtools, "View[7] must be Toggle Developer Tools ({idents:?})");
    // The zoom / devtools constants above are the ones the items are built with
    // (guards against the binding lookup silently matching another item).
    let _ = (ZOOM_IN_ITEM_ID, ZOOM_OUT_ITEM_ID, ACTUAL_SIZE_ITEM_ID, TOGGLE_DEVTOOLS_ITEM_ID);
}

/// 15. Window メニューで Move Tab to New Window・Merge All Windows が Show Next Tab の直後に
///     この順で並ぶ(Show Previous Tab が Show Next Tab より前=既存 AC-62-6 の並びも保つ)。
#[test]
fn window_menu_places_move_tab_and_merge_all_right_after_show_next_tab() {
    let code = menu_rs_code();
    let window_menu = submenu_call_with_label(&code, "Window")
        .expect("menu.rs must build a submenu labelled \"Window\"");
    let idents = submenu_item_idents(window_menu);
    let previous = menu_item_binding(&code, "PREVIOUS_TAB_ITEM_ID");
    let next = menu_item_binding(&code, "NEXT_TAB_ITEM_ID");
    let move_tab = menu_item_binding(&code, "MOVE_TAB_TO_NEW_WINDOW_ITEM_ID");
    let merge_all = menu_item_binding(&code, "MERGE_ALL_WINDOWS_ITEM_ID");
    let pos = |name: &str| {
        idents
            .iter()
            .position(|i| *i == name)
            .unwrap_or_else(|| panic!("Window menu must hold `&{name}` (items: {idents:?})"))
    };
    let next_pos = pos(next);
    assert!(pos(previous) < next_pos, "Show Previous Tab must precede Show Next Tab ({idents:?})");
    assert_eq!(
        pos(move_tab),
        next_pos + 1,
        "Move Tab to New Window must come right after Show Next Tab ({idents:?})"
    );
    assert_eq!(
        pos(merge_all),
        next_pos + 2,
        "Merge All Windows must come right after Move Tab to New Window ({idents:?})"
    );
    let _ = (PREVIOUS_TAB_ITEM_ID, NEXT_TAB_ITEM_ID);
}

// ---------------------------------------------------------------------------
// AC-62-20 — 配線(追補b・ソース走査)
// ---------------------------------------------------------------------------

/// 16. 4 つの ID 定数が menu.rs + lib.rs で 3 回以上現れる(宣言・項目・`on_menu_event` の分岐
///     =AC-62-6 と同じ数え方)。
#[test]
fn tab_menu_item_ids_are_dispatched() {
    let combined = format!("{}\n{}", menu_rs_code(), lib_rs_code());
    for name in [
        "SHOW_TAB_BAR_ITEM_ID",
        "SHOW_ALL_TABS_ITEM_ID",
        "MOVE_TAB_TO_NEW_WINDOW_ITEM_ID",
        "MERGE_ALL_WINDOWS_ITEM_ID",
    ] {
        let count = combined.matches(name).count();
        assert!(
            count >= 3,
            "{name} must be declared, bound to a MenuItem and dispatched (found {count} occurrence(s) across menu.rs + lib.rs)"
        );
    }
}

/// 17. `window/tab.rs` のコード行に objc2 の同名メソッドの呼び出しがある
///     (`toggleTabBar` / `toggleTabOverview` / `mergeAllWindows`)。
#[test]
fn tab_rs_calls_the_appkit_tab_actions() {
    let code = window_tab_rs_code();
    for method in ["toggleTabBar(", "toggleTabOverview(", "mergeAllWindows("] {
        assert!(
            code.contains(method),
            "window/tab.rs must call NSWindow's {method}...) on a code line"
        );
    }
}

/// 18. `moveTabToNewWindow(` は 2 箇所以上(契約9 の付け替え時の 1 箇所+メニューの経路)。
#[test]
fn tab_rs_calls_move_tab_to_new_window_from_two_places() {
    let code = window_tab_rs_code();
    let count = code.matches("moveTabToNewWindow(").count();
    assert!(
        count >= 2,
        "window/tab.rs must call moveTabToNewWindow(...) at least twice (retag + menu), found {count}"
    );
}

/// Cargo.toml の `objc2-app-kit` の `features = [...]` の中身(コメント行を除く)。
fn objc2_app_kit_features() -> BTreeSet<String> {
    let src = read_source("Cargo.toml");
    let code = src
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n");
    let entry = code
        .find("objc2-app-kit")
        .expect("Cargo.toml must declare objc2-app-kit");
    let mut search = entry;
    let features = loop {
        let rel = code[search..]
            .find("features")
            .expect("objc2-app-kit must list features");
        let at = search + rel;
        // skip `default-features = false`
        if code[..at].ends_with('-') {
            search = at + "features".len();
            continue;
        }
        break at;
    };
    let open = code[features..].find('[').expect("features must be an array") + features;
    let close = code[open..].find(']').expect("features array must close") + open;
    string_literals(&code[open..=close]).into_iter().collect()
}

/// 19. `objc2-app-kit` の features の集合が本追補の起案時点(2026-09-24)と同一
///     (4 つの操作はどれも `NSWindow` のメソッド=features を増やさない)。
#[test]
fn objc2_app_kit_features_are_unchanged() {
    let expected: BTreeSet<String> = [
        "std",
        "NSGraphics",
        "NSResponder",
        "NSWindow",
        "NSWindowTab",
        "NSWindowTabGroup",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    assert_eq!(
        objc2_app_kit_features(),
        expected,
        "objc2-app-kit features must stay exactly as they were on 2026-09-24"
    );
}

// ---------------------------------------------------------------------------
// AC-62-21 — 生成時の鍵(追補c・ソース走査)
// ---------------------------------------------------------------------------

/// 関数本体の全ての `tab_group_key(` 呼び出しの第 1 引数の先頭テキスト。
fn tab_group_key_first_args(body: &str) -> Vec<&str> {
    body.match_indices("tab_group_key(")
        .map(|(i, m)| body[i + m.len()..].trim_start())
        .map(|rest| {
            let end = rest.find(|c: char| c == ',' || c == ')').unwrap_or(rest.len());
            rest[..end].trim_end()
        })
        .collect()
}

/// 20. (1) `handle_open_path`(CLI の 2 回目の起動)は鍵を `tab_group_key(None, ...)` でだけ作る
///     (root から鍵を作る呼び出しが無い=一意の鍵で生まれ、`init_window` で付け替わる)。
#[test]
fn handle_open_path_builds_only_a_no_root_key() {
    let code = ipc_handler_rs_code();
    let body = fn_body(&code, "handle_open_path");
    assert!(
        body.contains("tab_group_key(None,"),
        "handle_open_path must build its key with tab_group_key(None, ...)"
    );
    let args = tab_group_key_first_args(body);
    assert!(!args.is_empty());
    for arg in &args {
        assert_eq!(
            *arg, "None",
            "handle_open_path must not derive a key from a root at creation (found tab_group_key({arg}, ...))"
        );
    }
}

/// 21. (2) `new_tab` 以外で窓を作る関数(`create_window`)の本体に `tab_group_key(None,` と
///     `KeySource::NoRoot` がある(`KeySource::Root` のときだけ root から鍵を作る)。
#[test]
fn window_creating_fn_builds_a_no_root_key_for_standalone_windows() {
    let code = commands_window_rs_code();
    let sites = builder_sites(&code);
    assert!(!sites.is_empty(), "commands/window.rs must build at least one window");
    let mut checked = 0;
    for (pos, _) in sites {
        let (name, body, _) = enclosing_fn(&code, pos);
        if name == "new_tab" {
            continue;
        }
        checked += 1;
        assert!(
            body.contains("tab_group_key(None,"),
            "fn {name}: must be able to build the unique no-root key with tab_group_key(None, ...)"
        );
        assert!(
            body.contains("KeySource::NoRoot"),
            "fn {name}: must branch on KeySource::NoRoot (the standalone placement's key)"
        );
    }
    assert!(
        checked >= 1,
        "commands/window.rs must keep a window-creating function other than new_tab (create_window)"
    );
}

/// 22. 鍵の値の区別(AC-62-1 の参照): 一意の鍵と root の鍵は等しくない。
#[test]
fn no_root_key_differs_from_the_rooted_key_of_the_same_window() {
    use vellis_lib::window::tab::tab_group_key;
    let root = "file:///Users/a/notes";
    assert_ne!(tab_group_key(None, "vellis-3"), tab_group_key(Some(root), "vellis-3"));
}

// ---------------------------------------------------------------------------
// AC-62-22(一部)— 新しいアクセラレータが acceptance_req60 の衝突検査の網に入る
// ---------------------------------------------------------------------------

/// 23. 両 ACCELERATOR の値が menu.rs のコード中に `+` を含む文字列リテラルとして現れ
///     (定数宣言)、同じ網の中で parse 結果が一致する他のリテラルが無い(それぞれ 1 件)。
#[test]
fn new_accelerators_are_visible_to_the_collision_scan() {
    let parsed: Vec<(String, Accelerator)> = string_literals(&menu_rs_code())
        .into_iter()
        .filter(|s| s.contains('+'))
        .filter_map(|s| Accelerator::from_str(&s).ok().map(|a| (s, a)))
        .collect();
    for (name, value) in [
        ("SHOW_TAB_BAR_ACCELERATOR", SHOW_TAB_BAR_ACCELERATOR),
        ("SHOW_ALL_TABS_ACCELERATOR", SHOW_ALL_TABS_ACCELERATOR),
    ] {
        assert!(
            parsed.iter().any(|(raw, _)| raw == value),
            "{name} '{value}' must appear as a string literal in menu.rs (the collision scan reads literals)"
        );
        let acc = Accelerator::from_str(value).unwrap();
        let count = parsed.iter().filter(|(_, a)| *a == acc).count();
        assert_eq!(
            count, 1,
            "menu.rs must register {name} '{value}' exactly once (found {count})"
        );
    }
}
