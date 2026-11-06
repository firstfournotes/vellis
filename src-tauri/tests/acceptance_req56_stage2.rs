//! 要件#56 の受け入れテスト(docs/requirements/req-56.md)— 第2段の Rust 層のソース走査
//! (AC-56-23 の配線=Export Default Theme… のメニュー項目と分岐・一覧の自動更新。契約 3・6・7)
//!
//! `acceptance_req56.rs`(第1段)と同じく**ソースをテキストとして読んで**判定する。関数は呼ばない
//! (呼ぶ側は `acceptance_req56_export.rs`)ので、実装前でもこのファイル自体はコンパイルでき、落ちるのは
//! アサートの側=赤の理由が読める。
//!
//! 判定範囲:
//! - AC-56-23(メニュー)  View ▸ Appearance の末尾に区切りと `Export Default Theme…`(英語ラベル・項目 ID
//!   `export-default-theme`・ショートカット無し)。`lib.rs` の `on_menu_event` がその ID を
//!   `menu::handle_export_default_theme_click` に振る
//! - AC-56-23(処理)  `handle_export_default_theme_click` は Rust の中で完結する= `theme::export_default_theme(` で
//!   書き(版は `CARGO_PKG_VERSION`)、Settings… と同じく `create_window(` で root=`themes/`・文書=書いたファイルの窓を
//!   開く。`emit` しない。新しい command を足さない(`generate_handler!` に export の command が無い=AC-60-20 の
//!   一覧は不変)
//! - AC-56-23(純関数)  `theme.rs` に `export_file_name` / `exported_theme_json` / `export_default_theme` が公開され、
//!   ファイル版は `create_new(true)` で既存を上書きしない
//! - AC-56-23(一覧)  `menu.rs` の `rebuild_theme_items` が `Submenu::remove` / `append` で作り直し、`theme.rs` の
//!   watcher の経路(`spawn_watcher` が呼ぶ関数)から呼ばれる。起動時(`build`)と同じ項目の作り方を使う
//!   (第1段で実装済み=**現状の固定**)
//!
//! 人間ゲート 4(Export が `my-theme.json` を書いて新しい窓で開き、2 回目は `my-theme-2.json`)は判定しない。
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前)
//!
//! ```ignore
//! // --- src-tauri/src/menu.rs
//! pub const EXPORT_DEFAULT_THEME_ITEM_ID: &str = "export-default-theme";
//! // Appearance = [Light, Dark, System, ─, Default, (themes/ の一覧…), ─, Export Default Theme…]
//! //   ※ 動的な一覧は `append` で Default の後ろに足すので、区切りと Export は append で一覧の後ろに置くか、
//! //     `rebuild_theme_items` が区切りと Export の**前**に挿すこと(本テストは `Submenu::with_…` の項目スライスと
//! //     その後の append の順で「区切り → Export が末尾」を見る)
//! /// Export Default Theme…: themes/ を作り、my-theme.json(あれば -2, -3 …)に Default の全文を書き、新しい窓で開く。
//! pub fn handle_export_default_theme_click(app: &AppHandle<Wry>);
//!
//! // --- src-tauri/src/theme.rs
//! /// 既存のファイル名(themes/ の一覧)から書き出し名を決める: "my-theme.json" / "my-theme-2.json" / …(大文字小文字を区別しない)
//! pub fn export_file_name(existing: &[&str]) -> String;
//! /// Default の全文で meta.name = "My Theme"・meta.description = "Exported from Vellis <version>"(整形済み JSON)
//! pub fn exported_theme_json(version: &str) -> String;
//! /// themes_dir を作り、衝突しない名前で書き(create_new= 既存を上書きしない)、書いたパスを返す
//! pub fn export_default_theme(themes_dir: &Path, version: &str) -> Result<PathBuf, String>;
//! ```

use std::collections::BTreeSet;
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// 共通ヘルパ — acceptance_req56.rs と同じ流儀
// ---------------------------------------------------------------------------

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_source_or_empty(rel: &str) -> String {
    std::fs::read_to_string(manifest_dir().join(rel)).unwrap_or_default()
}

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

/// `open` の位置の開き括弧に対応する閉じ括弧の位置(`(`/`[`/`{` を同じ深さで数える)。
/// 文字列(`"…"`・`r#"…"#`)・文字リテラル(`'('`)・コメント(`//`・`/* */`)の中の括弧は数えない。
fn matching_close(code: &str, open: usize) -> usize {
    let bytes = code.as_bytes();
    let n = bytes.len();
    let mut depth = 0usize;
    let mut i = open;
    while i < n {
        let b = bytes[i];
        match b {
            b'/' if i + 1 < n && bytes[i + 1] == b'/' => {
                i = code[i..].find('\n').map_or(n, |p| i + p);
                continue;
            }
            b'/' if i + 1 < n && bytes[i + 1] == b'*' => {
                i = code[i + 2..].find("*/").map_or(n, |p| i + 2 + p + 2);
                continue;
            }
            b'"' => {
                // raw string: r"…" / r#"…"# / br##"…"##(直前の r と # を見る)
                let mut hashes = 0;
                let mut j = i;
                while j > 0 && bytes[j - 1] == b'#' {
                    hashes += 1;
                    j -= 1;
                }
                let raw = j > 0 && bytes[j - 1] == b'r';
                if raw {
                    let close = "\"".to_string() + &"#".repeat(hashes);
                    i = code[i + 1..].find(&close).map_or(n, |p| i + 1 + p + close.len());
                } else {
                    i += 1;
                    while i < n && bytes[i] != b'"' {
                        if bytes[i] == b'\\' {
                            i += 1;
                        }
                        i += 1;
                    }
                    i += 1;
                }
                continue;
            }
            b'\'' => {
                // 文字リテラル('('・'\n')か lifetime('a)か
                if i + 1 < n && bytes[i + 1] == b'\\' {
                    i = code[i + 2..].find('\'').map_or(n, |p| i + 2 + p + 1);
                    continue;
                }
                let next_char_len = code[i + 1..].chars().next().map_or(1, char::len_utf8);
                if i + 1 + next_char_len < n && bytes[i + 1 + next_char_len] == b'\'' {
                    i += 2 + next_char_len;
                    continue;
                }
                i += 1;
                continue;
            }
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                depth -= 1;
                if depth == 0 {
                    return i;
                }
            }
            _ => {}
        }
        i += 1;
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

fn last_argument(call: &str) -> &str {
    let open = call.find('(').expect("call must have '('");
    let inner = &call[open + 1..call.len() - 1];
    inner.split(',').map(str::trim).filter(|s| !s.is_empty()).last().expect("call must have an argument")
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
        let call = balanced_call(code, start);
        search = start + "MenuItem::with_id(".len();
        if call.contains(const_name) {
            return Some(call);
        }
    }
    None
}

fn let_binding_before<'a>(code: &'a str, use_pos: usize, what: &str) -> &'a str {
    let let_pos = code[..use_pos].rfind("let ").unwrap_or_else(|| panic!("{what} must be used inside a let binding"));
    code[let_pos + 4..use_pos]
        .split(|c: char| c == '=' || c.is_whitespace())
        .find(|s| !s.is_empty())
        .expect("binding name after `let`")
}

fn menu_item_binding<'a>(code: &'a str, const_name: &str) -> &'a str {
    let call = menu_item_call_using(code, const_name)
        .unwrap_or_else(|| panic!("menu.rs must build a MenuItem with {const_name}"));
    let use_pos = call.as_ptr() as usize - code.as_ptr() as usize;
    let_binding_before(code, use_pos, const_name)
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

/// `fn <name>(` または `fn <name><…>(`(ジェネリクス付き)の宣言の先頭の位置。
fn fn_decl_start(code: &str, name: &str) -> Option<usize> {
    let needle = format!("fn {name}");
    let mut search = 0;
    while let Some(rel) = code[search..].find(&needle) {
        let start = search + rel;
        let after = start + needle.len();
        match code.as_bytes().get(after) {
            Some(b'(') | Some(b'<') => return Some(start),
            _ => search = after,
        }
    }
    None
}

/// `fn <name>(` で始まる関数の本体(最初の `{` から対応する `}` まで)。ジェネリクス `<R: Runtime>` 付きも可。
fn fn_body<'a>(code: &'a str, name: &str) -> &'a str {
    let start = fn_decl_start(code, name).unwrap_or_else(|| panic!("source must define `fn {name}(...`"));
    let open = code[start..].find('{').expect("fn must have a body") + start;
    let close = matching_close(code, open);
    &code[open..=close]
}

fn has_fn(code: &str, name: &str) -> bool {
    fn_decl_start(code, name).is_some()
}

/// ソースに宣言されている関数名の一覧(`fn <name>(` / `fn <name><…>(`)。
fn fn_names(code: &str) -> Vec<&str> {
    code.match_indices("fn ")
        .filter_map(|(pos, _)| {
            let rest = &code[pos + 3..];
            let end = rest.find(|c: char| !(c.is_alphanumeric() || c == '_'))?;
            let name = &rest[..end];
            let next = rest.as_bytes().get(end)?;
            (!name.is_empty() && matches!(next, b'(' | b'<')).then_some(name)
        })
        .collect()
}

fn on_menu_event_block(code: &str) -> &str {
    let start = code.find("on_menu_event(").expect("lib.rs must call on_menu_event");
    balanced_call(code, start)
}

fn menu_arm_body<'a>(block: &'a str, const_name: &str) -> &'a str {
    let needle = format!("menu::{const_name}");
    let pos = block.find(&needle).unwrap_or_else(|| panic!("on_menu_event must dispatch menu::{const_name}"));
    let arrow = block[pos..].find("=>").expect("match arm must have =>") + pos;
    let open = block[arrow..].find('{').expect("arm body must be a block") + arrow;
    let close = matching_close(block, open);
    &block[open..=close]
}

fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| matches!(c as u32, 0x3000..=0x303F | 0x3040..=0x30FF | 0x4E00..=0x9FFF | 0xFF00..=0xFFEF))
}

/// `fn build(` の本体で、Appearance に `appearance_menu.<method>(…)` で足される項目の列
/// (呼び出しの最初の引数の識別子。`&theme_item(app, &name)?` のような式は関数名で表す)。
fn added_in_build(code: &str, appearance_binding: &str, method: &str) -> Vec<String> {
    let body = fn_body(code, "build");
    let needle = format!("{appearance_binding}.{method}(");
    body.match_indices(&needle)
        .map(|(pos, _)| {
            let call = balanced_call(body, pos + appearance_binding.len() + 1);
            let open = call.find('(').expect("call");
            let inner = call[open + 1..call.len() - 1].trim().trim_start_matches('&').trim();
            inner.split(|c: char| !(c.is_alphanumeric() || c == '_')).next().unwrap_or("").to_string()
        })
        .collect()
}

// ---------------------------------------------------------------------------
// AC-56-23 — Export Default Theme… のメニュー項目(契約 3・由谷決定 8・判断 (e))
// ---------------------------------------------------------------------------

/// 1. 項目 ID は値固定・英語ラベル "Export Default Theme…"・ショートカット無し・CheckMenuItem でない。
#[test]
fn export_default_theme_item_is_fixed() {
    let code = menu_rs_code();
    assert_eq!(str_const(&code, "EXPORT_DEFAULT_THEME_ITEM_ID"), Some("export-default-theme"));
    let call = menu_item_call_using(&code, "EXPORT_DEFAULT_THEME_ITEM_ID")
        .expect("menu.rs must build a MenuItem with EXPORT_DEFAULT_THEME_ITEM_ID");
    assert_eq!(first_string_literal(call), Some("Export Default Theme…"), "{call}");
    assert!(!has_cjk(first_string_literal(call).unwrap()));
    assert!(last_argument(call).starts_with("None"), "Export has no accelerator: {}", last_argument(call));
    assert!(!code.contains("CheckMenuItem"), "no check marks in menu.rs (judgement (a), decision 8)");
}

/// 2. Appearance = Light / Dark / System / ─ / Default / (一覧) / ─ / Export Default Theme… — 区切りと Export が末尾。
///    静的なスライスに入っているか、`build` の中で一覧の後ろに append されているかのどちらか。
#[test]
fn appearance_submenu_ends_with_a_separator_and_export() {
    let code = menu_rs_code();
    let call = submenu_call_with_label(&code, "Appearance").expect("menu.rs must build an \"Appearance\" submenu");
    let use_pos = call.as_ptr() as usize - code.as_ptr() as usize;
    let appearance_binding = let_binding_before(&code, use_pos, "Appearance");
    let mut idents: Vec<String> = submenu_item_idents(call).into_iter().map(str::to_string).collect();
    idents.extend(added_in_build(&code, appearance_binding, "append"));
    let separators = separator_bindings(&code);
    let export = menu_item_binding(&code, "EXPORT_DEFAULT_THEME_ITEM_ID");
    let default = menu_item_binding(&code, "APPEARANCE_DEFAULT_THEME_ITEM_ID");

    let last = idents.len() - 1;
    assert_eq!(idents[last], export, "Export Default Theme… must be the last Appearance item ({idents:?})");
    assert!(
        separators.contains(idents[last - 1].as_str()),
        "Export Default Theme… must sit behind a separator ({idents:?}; separators: {separators:?})"
    );
    let default_at = idents.iter().position(|i| i == default).expect("Default is in Appearance");
    assert!(default_at < last - 1, "Default (and the dynamic list) come before the final separator ({idents:?})");
}

/// 3. `lib.rs` の `on_menu_event` が Export の ID を `handle_export_default_theme_click` に振る。
#[test]
fn lib_rs_routes_export_to_its_handler() {
    let lib = lib_rs_code();
    let block = on_menu_event_block(&lib);
    let body = menu_arm_body(block, "EXPORT_DEFAULT_THEME_ITEM_ID");
    assert!(
        body.contains("handle_export_default_theme_click("),
        "EXPORT_DEFAULT_THEME_ITEM_ID arm must call menu::handle_export_default_theme_click ({body})"
    );
}

/// 4. 処理は Rust の中で完結: `export_default_theme(` で書き(版は CARGO_PKG_VERSION)、`create_window(` で開き、`emit` しない。
#[test]
fn export_handler_writes_with_theme_rs_and_opens_a_window_without_emitting() {
    let menu = menu_rs_code();
    assert!(has_fn(&menu, "handle_export_default_theme_click"), "menu.rs must define handle_export_default_theme_click");
    let body = fn_body(&menu, "handle_export_default_theme_click");
    assert!(body.contains("export_default_theme("), "the handler must call theme::export_default_theme ({body})");
    assert!(body.contains("CARGO_PKG_VERSION"), "the exported meta.description carries the version ({body})");
    assert!(body.contains("create_window("), "the handler must open the written file in a new window like Settings… ({body})");
    assert!(!body.contains("emit"), "the handler must not emit (the watcher rebuilds the list): {body}");
}

/// 5. 新しい command は足さない(契約 6): `generate_handler!` の 2 箇所に export の command が無い。
#[test]
fn no_export_command_is_registered() {
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
        assert!(!block.contains("export"), "generate_handler! must not gain an export command ({block})");
    }
}

// ---------------------------------------------------------------------------
// AC-56-23 — theme.rs の純関数と非上書き(判断 (e))
// ---------------------------------------------------------------------------

/// 6. `theme.rs` に 3 つの公開関数があり、ファイル版は `create_new(true)` で書く(既存を上書きしない)。
#[test]
fn theme_rs_exposes_the_export_functions_and_never_overwrites() {
    let theme = theme_rs_code();
    for name in ["export_file_name", "exported_theme_json", "export_default_theme"] {
        assert!(theme.contains(&format!("pub fn {name}(")), "theme.rs must define `pub fn {name}(`");
    }
    let body = fn_body(&theme, "export_default_theme");
    assert!(body.contains("create_new(true)"), "export_default_theme must open with create_new(true) ({body})");
}

/// 7. 書き出し名の基底は "my-theme"・中身の名前は "My Theme"・説明は "Exported from Vellis "(判断 (e))が theme.rs にある。
#[test]
fn export_literals_follow_judgement_e() {
    let theme = theme_rs_code();
    assert!(theme.contains("\"my-theme\"") || theme.contains("my-theme.json"), "the file stem my-theme");
    assert!(theme.contains("\"My Theme\""), "meta.name = \"My Theme\"");
    assert!(theme.contains("Exported from Vellis "), "meta.description = \"Exported from Vellis <version>\"");
}

// ---------------------------------------------------------------------------
// AC-56-23 — 一覧の自動更新(第1段で実装済み=現状の固定)
// ---------------------------------------------------------------------------

/// 8. `rebuild_theme_items` が `remove(` と `append(` で作り直し、`build` と同じ項目の作り方(同じ関数)を使う。
#[test]
fn rebuild_theme_items_removes_and_appends_with_the_same_item_builder_as_build() {
    let code = menu_rs_code();
    assert!(has_fn(&code, "rebuild_theme_items"), "menu.rs must define rebuild_theme_items");
    let body = fn_body(&code, "rebuild_theme_items");
    assert!(body.contains(".remove("), "rebuild_theme_items must remove the old items ({body})");
    assert!(body.contains(".append("), "rebuild_theme_items must append the new items ({body})");
    assert!(body.contains("APPEARANCE_THEME_ITEM_PREFIX"), "it tells theme items apart by the prefix ({body})");

    let call = submenu_call_with_label(&code, "Appearance").expect("Appearance submenu");
    let use_pos = call.as_ptr() as usize - code.as_ptr() as usize;
    let appearance_binding = let_binding_before(&code, use_pos, "Appearance");
    let build_body = fn_body(&code, "build");
    assert!(build_body.contains("installed_themes()"), "build lists themes/ at startup ({build_body})");
    let mut added = added_in_build(&code, appearance_binding, "append");
    added.extend(added_in_build(&code, appearance_binding, "insert"));
    let builders: Vec<String> = added
        .into_iter()
        .filter(|ident| build_body.contains(&format!("{ident}(app, ")))
        .collect();
    assert!(!builders.is_empty(), "build must append / insert the theme items through a helper taking (app, name)");
    for builder in builders {
        assert!(body.contains(&format!("{builder}(")), "rebuild_theme_items must use the same helper `{builder}` as build ({body})");
    }
}

/// 9. watcher の経路から `rebuild_theme_items` が呼ばれる(`spawn_watcher` が呼ぶ関数の中、または spawn_watcher 自身)。
#[test]
fn the_theme_watcher_rebuilds_the_appearance_list() {
    let theme = theme_rs_code();
    assert!(theme.contains("rebuild_theme_items("), "theme.rs must call menu::rebuild_theme_items");
    assert!(has_fn(&theme, "spawn_watcher"), "theme.rs must define spawn_watcher");
    let watcher = fn_body(&theme, "spawn_watcher");
    if watcher.contains("rebuild_theme_items(") {
        return;
    }
    // rebuild_theme_items( を含む関数のどれかが spawn_watcher から呼ばれる
    let callers: Vec<&str> = fn_names(&theme)
        .into_iter()
        .filter(|name| fn_body(&theme, name).contains("rebuild_theme_items("))
        .collect();
    assert!(
        callers.iter().any(|name| watcher.contains(&format!("{name}("))),
        "spawn_watcher must call a function that rebuilds the list (candidates: {callers:?})"
    );
}

/// 10. 一覧の作り直しは起動時(`theme::start`)にも同じ関数を使う必要はないが、`build` が起動時の一覧を作り、
///     watcher が差分で作り直す= `reconcile` 相当が `installed_themes()` を読み直している。
#[test]
fn the_watcher_path_relists_the_theme_files() {
    let theme = theme_rs_code();
    let watcher = fn_body(&theme, "spawn_watcher");
    let relists = watcher.contains("installed_themes()")
        || fn_names(&theme)
            .into_iter()
            .any(|name| watcher.contains(&format!("{name}(")) && fn_body(&theme, name).contains("installed_themes()"));
    assert!(relists, "the watcher path must list themes/ again to notice additions and removals");
}
