//! 要件#56 の受け入れテスト(docs/requirements/req-56.md)— Rust 層のソース走査
//! (AC-56-8・9 の Rust 側=メニューと配線。契約 3・4・6)
//!
//! 「UI の作り直し(見た目の刷新)」第1段のうち、`src-tauri` に足すもの(契約 6 の例外)が揃っていることを
//! **ソースをテキストとして読んで**判定する。関数は呼ばない(呼ぶ側は `acceptance_req56_theme.rs`)ので、
//! 実装前でもこのファイル自体はコンパイルでき、落ちるのはアサートの側=赤の理由が読める。
//!
//! 判定範囲:
//! - AC-56-8(モード)  View ▸ Appearance サブメニューに Light / Dark / System の 3 項目(英語ラベル・項目 ID・
//!   イベント名・ショートカットなし=判断 (a))。`lib.rs` の `on_menu_event` が 3 つの ID をフロントへの
//!   `emit_to`(`handle_menu_open_click`)に振る
//! - AC-56-8(テーマ)  同じサブメニューに区切り・Default の項目・`appearance-theme:` 接頭辞の動的な項目・
//!   (第1段の末尾か第2段=)Export Default Theme…。テーマを選ぶ分岐は `settings.json` の `appearance.theme`
//!   だけを置き換える関数を呼び、自分では `emit` しない(配るのは watcher)。`theme.rs` の
//!   `THEME_CHANGED_EVENT == "theme_changed"`・全窓への `emit`・NonRecursive の watcher・command `get_theme`
//!   (`commands/theme.rs`・`generate_handler!` の 2 箇所)・`Cargo.toml` の `serde_json` に `preserve_order`
//! - AC-56-9  View メニューに `Toggle Full Width`(判断 (g)=チェック印なし・ショートカットなし)があり、
//!   `on_menu_event` がフロントへの `emit_to` に振る
//! - View メニューの並び(契約 3・4。位置は theme-architecture §6.1 の図のとおり=本テストで確定):
//!   `Show Tab Bar / Show All Tabs / ─ / Appearance ▸ / Toggle Full Width / ─ / Zoom In / Zoom Out / Actual Size /
//!   ─ / Toggle Developer Tools`(11 項目。既存 8 項目の相対順は保つ=要件#62 追補b・#63 の要件側更新と同じ列)
//!
//! `tauri.conf.json`・窓の生成 2 箇所・`print.css`・依存は `src/lib/ui-invariants.acceptance.test.ts`(AC-56-11・15・16)。
//! 人間ゲート 4(メニューの手応え・OS の外観への追従・ダイアログ)は判定しない。
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前。theme-architecture §6.1・§10 を具体化)
//!
//! ```ignore
//! // --- src-tauri/src/menu.rs — 既存の *_ITEM_ID / MENU_*_EVENT と同じ家風
//! pub const APPEARANCE_LIGHT_ITEM_ID: &str = "appearance-light";
//! pub const APPEARANCE_DARK_ITEM_ID: &str = "appearance-dark";
//! pub const APPEARANCE_SYSTEM_ITEM_ID: &str = "appearance-system";
//! pub const MENU_APPEARANCE_LIGHT_EVENT: &str = "menu_appearance_light";     // フロント src/lib/ui-chrome.ts と同綴り
//! pub const MENU_APPEARANCE_DARK_EVENT: &str = "menu_appearance_dark";
//! pub const MENU_APPEARANCE_SYSTEM_EVENT: &str = "menu_appearance_system";
//! /// テーマの項目 ID の接頭辞(動的生成 `appearance-theme:<name>`)。Default は `appearance-theme:default`。
//! pub const APPEARANCE_THEME_ITEM_PREFIX: &str = "appearance-theme:";
//! pub const APPEARANCE_DEFAULT_THEME_ITEM_ID: &str = "appearance-theme:default";
//! pub const EXPORT_DEFAULT_THEME_ITEM_ID: &str = "export-default-theme";         // 第1段の末尾か第2段(無い間は判定保留)
//! pub const TOGGLE_FULL_WIDTH_ITEM_ID: &str = "toggle-full-width";
//! pub const MENU_TOGGLE_FULL_WIDTH_EVENT: &str = "menu_toggle_full_width";
//! /// テーマを選んだ: settings.json の appearance.theme だけを置き換える(emit しない=配るのは watcher)。
//! pub fn handle_appearance_theme_click(app: &AppHandle<Wry>, name: &str);
//!
//! // --- src-tauri/src/theme.rs(新規・lib.rs に `pub mod theme;`)
//! pub const THEME_CHANGED_EVENT: &str = "theme_changed";
//! // --- src-tauri/src/commands/theme.rs(新規・commands/mod.rs に `pub mod theme;`)
//! #[tauri::command] pub fn get_theme(...) -> ResolvedTheme;   // lib.rs の generate_handler! 2 箇所に `get_theme`
//! ```
//!
//! ソース走査が前提にする形(既存コードの家風・acceptance_req62a.rs / req63.rs と同じ読み方):
//! - 各 MenuItem は `let <binding> = MenuItem::with_id(app, <ID 定数>, "<ラベル>", true, None::<&str>)?;` で束縛する
//! - Appearance は `Submenu::with_…(app, "Appearance", true, &[&appearance_light_item, &appearance_dark_item,
//!   &appearance_system_item, &<区切り>, &appearance_default_item(, &<区切り>, &export_default_theme_item)])?` を
//!   `let appearance_menu = …` で束縛し、View の項目スライスに `&appearance_menu` として置く
//! - 区切り線は `let <binding> = PredefinedMenuItem::separator(app)?;` で束縛する
//! - View は `Submenu::with_items(app, "View", true, &[…])?` のまま(上記の 11 項目の順)
//! - `lib.rs` の `on_menu_event` の分岐は `id if id == menu::<ID 定数> => { … }` の形。テーマの項目は
//!   `menu::APPEARANCE_THEME_ITEM_PREFIX` で見分け(`strip_prefix` / `starts_with`)、
//!   `menu::handle_appearance_theme_click(app_handle, <name>)` を呼ぶ

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// 共通ヘルパ — acceptance_req62a.rs / req63.rs と同じ流儀(コメント落とし・括弧の対応)
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

fn theme_rs_code() -> String {
    strip_line_comments(&read_source_or_empty("src/theme.rs"))
}

fn commands_theme_rs_code() -> String {
    strip_line_comments(&read_source_or_empty("src/commands/theme.rs"))
}

fn commands_mod_rs_code() -> String {
    strip_line_comments(include_str!("../src/commands/mod.rs"))
}

fn cargo_toml() -> String {
    include_str!("../Cargo.toml").to_string()
}

/// `src-tauri/src/**/*.rs` のコード行(コメント落とし)を集める。
fn all_rust_code() -> Vec<(String, String)> {
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
                let rel = path.strip_prefix(base).expect("under src").to_string_lossy().replace('\\', "/");
                let src = std::fs::read_to_string(&path)
                    .unwrap_or_else(|e| panic!("cannot read {}: {}", path.display(), e));
                out.push((rel, strip_line_comments(&src)));
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
    inner.split(',').map(str::trim).filter(|s| !s.is_empty()).last().expect("call must have an argument")
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

/// ラベルが `label` の Submenu 呼び出しの数。
fn count_submenus_with_label(code: &str, label: &str) -> usize {
    let mut count = 0;
    let mut search = 0;
    while let Some(rel) = code[search..].find("Submenu::with_") {
        let start = search + rel;
        let call = balanced_call(code, start);
        search = start + "Submenu::with_".len();
        if first_string_literal(call) == Some(label) {
            count += 1;
        }
    }
    count
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
    let let_pos = code[..use_pos].rfind("let ").unwrap_or_else(|| panic!("{what} must be used inside a let binding"));
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

/// ラベル `label` の Submenu の束縛名。
fn submenu_binding<'a>(code: &'a str, label: &str) -> &'a str {
    let call = submenu_call_with_label(code, label)
        .unwrap_or_else(|| panic!("menu.rs must build a submenu labelled {label:?}"));
    let use_pos = call.as_ptr() as usize - code.as_ptr() as usize;
    let_binding_before(code, use_pos, label)
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

/// `fn <name>(` で始まる関数の本体(最初の `{` から対応する `}` まで)。
fn fn_body<'a>(code: &'a str, name: &str) -> &'a str {
    let needle = format!("fn {name}(");
    let start = code.find(&needle).unwrap_or_else(|| panic!("source must define `{needle}...`"));
    let open = code[start..].find('{').expect("fn must have a body") + start;
    let close = matching_close(code, open);
    &code[open..=close]
}

/// `lib.rs` の `on_menu_event(|app_handle, event| match … { … })` の本体。
fn on_menu_event_block(code: &str) -> &str {
    let start = code.find("on_menu_event(").expect("lib.rs must call on_menu_event");
    balanced_call(code, start)
}

/// `on_menu_event` の中で `menu::<const_name>` を条件に持つ分岐の本体(`=> { … }`)。
fn menu_arm_body<'a>(block: &'a str, const_name: &str) -> &'a str {
    let needle = format!("menu::{const_name}");
    let pos = block.find(&needle).unwrap_or_else(|| panic!("on_menu_event must dispatch menu::{const_name}"));
    let arrow = block[pos..].find("=>").expect("match arm must have =>") + pos;
    let open = block[arrow..].find('{').expect("arm body must be a block") + arrow;
    let close = matching_close(block, open);
    &block[open..=close]
}

fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| {
        matches!(c as u32,
            0x3000..=0x303F | 0x3040..=0x30FF | 0x4E00..=0x9FFF | 0xFF00..=0xFFEF)
    })
}

// ---------------------------------------------------------------------------
// AC-56-8(モード)— 定数とラベル(契約 3・判断 (a))
// ---------------------------------------------------------------------------

/// 1. 3 項目の ID とイベント名は値固定(フロント `src/lib/ui-chrome.ts` と同綴り)。
#[test]
fn appearance_mode_ids_and_events_are_fixed() {
    let code = menu_rs_code();
    assert_eq!(str_const(&code, "APPEARANCE_LIGHT_ITEM_ID"), Some("appearance-light"));
    assert_eq!(str_const(&code, "APPEARANCE_DARK_ITEM_ID"), Some("appearance-dark"));
    assert_eq!(str_const(&code, "APPEARANCE_SYSTEM_ITEM_ID"), Some("appearance-system"));
    assert_eq!(str_const(&code, "MENU_APPEARANCE_LIGHT_EVENT"), Some("menu_appearance_light"));
    assert_eq!(str_const(&code, "MENU_APPEARANCE_DARK_EVENT"), Some("menu_appearance_dark"));
    assert_eq!(str_const(&code, "MENU_APPEARANCE_SYSTEM_EVENT"), Some("menu_appearance_system"));
}

/// 2. Light / Dark / System の MenuItem は英語ラベルで、ショートカット無し(判断 (a)=今の Show Tab Bar と同じ流儀の普通の項目)。
#[test]
fn appearance_mode_items_carry_english_labels_and_no_accelerator() {
    let code = menu_rs_code();
    for (const_name, label) in [
        ("APPEARANCE_LIGHT_ITEM_ID", "Light"),
        ("APPEARANCE_DARK_ITEM_ID", "Dark"),
        ("APPEARANCE_SYSTEM_ITEM_ID", "System"),
    ] {
        let call = menu_item_call_using(&code, const_name)
            .unwrap_or_else(|| panic!("menu.rs must build a MenuItem with {const_name}"));
        assert_eq!(first_string_literal(call), Some(label), "{const_name} must be labelled {label:?} ({call})");
        assert!(!has_cjk(label));
        assert!(
            last_argument(call).starts_with("None"),
            "{const_name} must have no accelerator (judgement (a)); found {}",
            last_argument(call)
        );
    }
}

// ---------------------------------------------------------------------------
// AC-56-8(テーマ)— Appearance サブメニューの中身(契約 3・由谷決定 8・判断 (d))
// ---------------------------------------------------------------------------

/// 3. テーマの項目 ID の接頭辞と Default の ID は値固定。Default の ID は接頭辞+`default`。
#[test]
fn appearance_theme_prefix_and_default_id_are_fixed() {
    let code = menu_rs_code();
    assert_eq!(str_const(&code, "APPEARANCE_THEME_ITEM_PREFIX"), Some("appearance-theme:"));
    assert_eq!(str_const(&code, "APPEARANCE_DEFAULT_THEME_ITEM_ID"), Some("appearance-theme:default"));
    let occurrences = code.matches("APPEARANCE_THEME_ITEM_PREFIX").count();
    assert!(
        occurrences >= 2,
        "menu.rs must use APPEARANCE_THEME_ITEM_PREFIX to build the dynamic theme items (found {occurrences} occurrence(s))"
    );
}

/// 4. Appearance サブメニューは 1 つで、Light / Dark / System・区切り・Default の順に始まる。
///    Export Default Theme… は第1段の末尾か第2段(契約 7)= あるなら区切りの後の末尾に置く。無い間は判定しない。
#[test]
fn appearance_submenu_starts_with_modes_then_separator_then_default() {
    let code = menu_rs_code();
    assert_eq!(count_submenus_with_label(&code, "Appearance"), 1, "exactly one \"Appearance\" submenu");
    let call = submenu_call_with_label(&code, "Appearance").expect("menu.rs must build an \"Appearance\" submenu");
    let idents = submenu_item_idents(call);
    let separators = separator_bindings(&code);
    let light = menu_item_binding(&code, "APPEARANCE_LIGHT_ITEM_ID");
    let dark = menu_item_binding(&code, "APPEARANCE_DARK_ITEM_ID");
    let system = menu_item_binding(&code, "APPEARANCE_SYSTEM_ITEM_ID");
    let default = menu_item_binding(&code, "APPEARANCE_DEFAULT_THEME_ITEM_ID");
    assert!(idents.len() >= 5, "Appearance must hold at least Light / Dark / System / ─ / Default ({idents:?})");
    assert_eq!(idents[0], light, "Appearance[0] must be Light ({idents:?})");
    assert_eq!(idents[1], dark, "Appearance[1] must be Dark ({idents:?})");
    assert_eq!(idents[2], system, "Appearance[2] must be System ({idents:?})");
    assert!(separators.contains(idents[3]), "Appearance[3] must be a separator ({idents:?}; separators: {separators:?})");
    assert_eq!(idents[4], default, "Appearance[4] must be Default ({idents:?})");

    if str_const(&code, "EXPORT_DEFAULT_THEME_ITEM_ID").is_some() {
        let export = menu_item_binding(&code, "EXPORT_DEFAULT_THEME_ITEM_ID");
        let last = idents.len() - 1;
        assert_eq!(idents[last], export, "Export Default Theme… must be the last Appearance item ({idents:?})");
        assert!(
            separators.contains(idents[last - 1]),
            "Export Default Theme… must sit behind a separator ({idents:?})"
        );
        let call = menu_item_call_using(&code, "EXPORT_DEFAULT_THEME_ITEM_ID").unwrap();
        assert_eq!(first_string_literal(call), Some("Export Default Theme…"));
    }
}

/// 5. Default の項目は英語ラベル "Default"・ショートカット無し・チェック印なし(`CheckMenuItem` を使わない=判断 (a)・決定 8)。
#[test]
fn default_theme_item_is_a_plain_menu_item_labelled_default() {
    let code = menu_rs_code();
    let call = menu_item_call_using(&code, "APPEARANCE_DEFAULT_THEME_ITEM_ID")
        .expect("menu.rs must build a MenuItem with APPEARANCE_DEFAULT_THEME_ITEM_ID");
    assert_eq!(first_string_literal(call), Some("Default"));
    assert!(last_argument(call).starts_with("None"), "Default must have no accelerator");
    assert!(!code.contains("CheckMenuItem"), "no check marks anywhere in menu.rs (judgement (a), decision 8)");
}

// ---------------------------------------------------------------------------
// AC-56-9 — Toggle Full Width(契約 4・判断 (g))
// ---------------------------------------------------------------------------

/// 6. Toggle Full Width の ID とイベント名は値固定・英語ラベル・ショートカット無し。
#[test]
fn toggle_full_width_item_is_fixed() {
    let code = menu_rs_code();
    assert_eq!(str_const(&code, "TOGGLE_FULL_WIDTH_ITEM_ID"), Some("toggle-full-width"));
    assert_eq!(str_const(&code, "MENU_TOGGLE_FULL_WIDTH_EVENT"), Some("menu_toggle_full_width"));
    let call = menu_item_call_using(&code, "TOGGLE_FULL_WIDTH_ITEM_ID")
        .expect("menu.rs must build a MenuItem with TOGGLE_FULL_WIDTH_ITEM_ID");
    assert_eq!(first_string_literal(call), Some("Toggle Full Width"));
    assert!(last_argument(call).starts_with("None"), "Toggle Full Width has no shortcut (judgement (g))");
}

// ---------------------------------------------------------------------------
// View メニューの並び(契約 3・4・theme-architecture §6.1)
// ---------------------------------------------------------------------------

/// 7. View = Show Tab Bar / Show All Tabs / ─ / Appearance ▸ / Toggle Full Width / ─ / Zoom In / Zoom Out /
///    Actual Size / ─ / Toggle Developer Tools(11 項目。既存 8 項目の相対順はそのまま)。
///
///    要件側更新(2026-11-04・要件#80 契約 2・12 承認 1=req-80.md で事前承認・(r) 決定): 要件#80 が [2] の
///    区切り線の直後に **[3] Reload File・[4] 区切り線** を足し、Appearance 以降の添字が 2 つずつずれた
///    (13 項目。acceptance_req80.rs が同じ列を固定する)。Appearance と Toggle Full Width が「タブの項目と
///    Zoom の間」にあることは同じ。
#[test]
fn view_menu_holds_appearance_and_full_width_between_the_tab_items_and_zoom() {
    let code = menu_rs_code();
    let view = submenu_call_with_label(&code, "View").expect("menu.rs must build a \"View\" submenu");
    let idents = submenu_item_idents(view);
    let separators = separator_bindings(&code);
    assert_eq!(idents.len(), 13, "View must hold exactly 13 entries ({idents:?})");

    let show_tab_bar = menu_item_binding(&code, "SHOW_TAB_BAR_ITEM_ID");
    let show_all_tabs = menu_item_binding(&code, "SHOW_ALL_TABS_ITEM_ID");
    let reload_file = menu_item_binding(&code, "RELOAD_FILE_ITEM_ID");
    let appearance = submenu_binding(&code, "Appearance");
    let full_width = menu_item_binding(&code, "TOGGLE_FULL_WIDTH_ITEM_ID");
    let zoom_in = menu_item_binding(&code, "ZOOM_IN_ITEM_ID");
    let zoom_out = menu_item_binding(&code, "ZOOM_OUT_ITEM_ID");
    let actual_size = menu_item_binding(&code, "ACTUAL_SIZE_ITEM_ID");
    let devtools = menu_item_binding(&code, "TOGGLE_DEVTOOLS_ITEM_ID");

    assert_eq!(idents[0], show_tab_bar, "View[0] ({idents:?})");
    assert_eq!(idents[1], show_all_tabs, "View[1] ({idents:?})");
    assert!(separators.contains(idents[2]), "View[2] must be a separator ({idents:?})");
    assert_eq!(idents[3], reload_file, "View[3] must be Reload File (requirement #80) ({idents:?})");
    assert!(separators.contains(idents[4]), "View[4] must be a separator (requirement #80) ({idents:?})");
    assert_eq!(idents[5], appearance, "View[5] must be the Appearance submenu ({idents:?})");
    assert_eq!(idents[6], full_width, "View[6] must be Toggle Full Width ({idents:?})");
    assert!(separators.contains(idents[7]), "View[7] must be a separator ({idents:?})");
    assert_eq!(idents[8], zoom_in, "View[8] ({idents:?})");
    assert_eq!(idents[9], zoom_out, "View[9] ({idents:?})");
    assert_eq!(idents[10], actual_size, "View[10] ({idents:?})");
    assert!(separators.contains(idents[11]), "View[11] must be a separator ({idents:?})");
    assert_eq!(idents[12], devtools, "View[12] ({idents:?})");
}

// ---------------------------------------------------------------------------
// lib.rs の配線(契約 3・4・6)
// ---------------------------------------------------------------------------

/// 8. モード 3 項目と Toggle Full Width は、Zoom と同じ形で見ている窓へ emit_to(`handle_menu_open_click` にイベント名を渡す)。
#[test]
fn lib_rs_routes_mode_and_full_width_items_to_the_focused_window() {
    let lib = lib_rs_code();
    let block = on_menu_event_block(&lib);
    for (id, event) in [
        ("APPEARANCE_LIGHT_ITEM_ID", "MENU_APPEARANCE_LIGHT_EVENT"),
        ("APPEARANCE_DARK_ITEM_ID", "MENU_APPEARANCE_DARK_EVENT"),
        ("APPEARANCE_SYSTEM_ITEM_ID", "MENU_APPEARANCE_SYSTEM_EVENT"),
        ("TOGGLE_FULL_WIDTH_ITEM_ID", "MENU_TOGGLE_FULL_WIDTH_EVENT"),
    ] {
        let body = menu_arm_body(block, id);
        assert!(body.contains("handle_menu_open_click("), "{id} arm must call handle_menu_open_click ({body})");
        assert!(body.contains(event), "{id} arm must emit menu::{event} ({body})");
    }
}

/// 9. テーマの項目は接頭辞で見分け、`handle_appearance_theme_click` へ渡す。その関数は `set_appearance_theme(` を呼び、
///    自分では emit しない(配るのは watcher=経路を 1 本にする)。
#[test]
fn lib_rs_routes_theme_items_by_prefix_and_the_handler_writes_settings_without_emitting() {
    let lib = lib_rs_code();
    let block = on_menu_event_block(&lib);
    assert!(
        block.contains("APPEARANCE_THEME_ITEM_PREFIX"),
        "on_menu_event must tell theme items apart by menu::APPEARANCE_THEME_ITEM_PREFIX"
    );
    assert!(
        block.contains("strip_prefix(") || block.contains("starts_with("),
        "on_menu_event must match the prefix with strip_prefix / starts_with"
    );
    assert!(block.contains("handle_appearance_theme_click("), "on_menu_event must call menu::handle_appearance_theme_click");

    let menu = menu_rs_code();
    let body = fn_body(&menu, "handle_appearance_theme_click");
    assert!(body.contains("set_appearance_theme("), "handle_appearance_theme_click must call set_appearance_theme ({body})");
    assert!(!body.contains("emit"), "handle_appearance_theme_click must not emit (the watcher broadcasts): {body}");
}

// ---------------------------------------------------------------------------
// theme.rs・command get_theme・event theme_changed(契約 3・6)
// ---------------------------------------------------------------------------

/// 10. `theme.rs` がモジュールとして登録され、`THEME_CHANGED_EVENT == "theme_changed"`。
#[test]
fn theme_module_exists_and_theme_changed_event_is_fixed() {
    assert!(lib_rs_code().contains("pub mod theme;"), "lib.rs must declare `pub mod theme;`");
    let theme = theme_rs_code();
    assert!(!theme.is_empty(), "src-tauri/src/theme.rs must exist");
    assert_eq!(str_const(&theme, "THEME_CHANGED_EVENT"), Some("theme_changed"));
}

/// 11. `theme_changed` は全窓へ `emit`(`emit_to` ではない=settings_changed と同じ配り方)。
#[test]
fn theme_changed_is_broadcast_with_emit_to_every_window() {
    let sources = all_rust_code();
    let broadcast = sources.iter().any(|(_, code)| {
        code.match_indices(".emit(").any(|(pos, _)| balanced_call(code, pos + 1).contains("THEME_CHANGED_EVENT"))
    });
    assert!(broadcast, "some Rust source must call `.emit(THEME_CHANGED_EVENT, …)` (broadcast to every window)");
    let targeted = sources.iter().any(|(_, code)| {
        code.match_indices(".emit_to(").any(|(pos, _)| balanced_call(code, pos + 1).contains("THEME_CHANGED_EVENT"))
    });
    assert!(!targeted, "theme_changed must not be sent with emit_to (it is app-wide)");
}

/// 12. watcher は `notify` で `~/.config/vellis/` と `themes/` を NonRecursive に見る(契約 3)。
#[test]
fn theme_watcher_uses_notify_non_recursive() {
    let theme = theme_rs_code();
    assert!(theme.contains("notify"), "theme.rs must use the notify crate for the watcher");
    assert!(theme.contains("NonRecursive"), "theme.rs must watch the two folders NonRecursive");
}

/// 13. command `get_theme` が `commands/theme.rs` にあり、`generate_handler!` の 2 箇所(webdriver あり/なし)に載る。
#[test]
fn get_theme_command_is_declared_and_registered_twice() {
    assert!(commands_mod_rs_code().contains("pub mod theme;"), "commands/mod.rs must declare `pub mod theme;`");
    let cmd = commands_theme_rs_code();
    assert!(cmd.contains("#[tauri::command]"), "commands/theme.rs must define a tauri command");
    assert!(cmd.contains("fn get_theme("), "commands/theme.rs must define get_theme");
    let lib = lib_rs_code();
    let blocks: Vec<&str> = lib
        .match_indices("generate_handler![")
        .map(|(pos, _)| {
            let open = pos + "generate_handler!".len();
            &lib[open..=matching_close(&lib, open)]
        })
        .collect();
    assert_eq!(blocks.len(), 2, "lib.rs has two generate_handler! blocks");
    for block in blocks {
        assert!(block.contains("get_theme"), "generate_handler! must list get_theme ({block})");
    }
}

/// 14. `Cargo.toml` の `serde_json` に `preserve_order`(契約 6 (7)・判断 (q))。依存は増えない(AC-56-11 は TS 側)。
#[test]
fn serde_json_has_the_preserve_order_feature() {
    let cargo = cargo_toml();
    let line = cargo
        .lines()
        .find(|l| l.trim_start().starts_with("serde_json"))
        .expect("Cargo.toml must declare serde_json");
    assert!(
        line.contains("preserve_order"),
        "serde_json must enable the preserve_order feature so the menu keeps the user's key order: {line}"
    );
}
