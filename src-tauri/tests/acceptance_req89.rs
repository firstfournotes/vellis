//! 要件#89 の受け入れテスト(docs/requirements/req-89.md)— Rust 層
//! 「別の名前で保存(Save As…)」の menu(AC-89-1・契約1)と、新しい場所へ書く command(AC-89-2・AC-89-4・AC-89-5・契約3・5・7)。
//!
//! 入口(`save_document_as` は Tauri の Window / State を取る command)は統合テストから呼べないので、書く実体を純粋な async fn
//! `write_save_as` に出してそれを呼び、command の本文と menu / lib.rs の配線は**ソースをテキストとして読んで**判定する
//! (acceptance_req74.rs・acceptance_req80.rs・acceptance_req84.rs と同じ作り。コメントの中の字は数えない)。
//!
//! ## 確定契約(implementer はこれに従う=test-writer が固定・2026-11-26)
//!
//! ```ignore
//! // --- src-tauri/src/menu.rs
//! pub const SAVE_AS_ITEM_ID: &str = "save-as";
//! pub const MENU_SAVE_AS_EVENT: &str = "menu_save_as";          // フロント src/lib/save-as.ts の同名定数と同じ綴り
//! pub const SAVE_AS_ACCELERATOR: &str = "CmdOrCtrl+Shift+S";    // Shift + Command + S(他の項目と重ならない=acceptance_req60 の走査)
//! //   let save_as_item = MenuItem::with_id(app, SAVE_AS_ITEM_ID, "Save As…", true, Some(SAVE_AS_ACCELERATOR))?;   (… は U+2026 の 1 文字)
//! //   File の並び: new_window_item, new_tab_item, duplicate_window_item, new_window_sep, open_file_item, open_folder_item, file_sep,
//! //               save_item, save_as_item, save_sep, print_item   (Save の直後。macOS の File メニューの慣習)
//! //   有効(true)で作る: Save と同じく、効くかどうかは窓の側が決める(契約1「押しても何もしない」の形)
//! // --- src-tauri/src/lib.rs の on_menu_event
//! //   id if id == menu::SAVE_AS_ITEM_ID => { menu::handle_menu_open_click(app_handle, menu::MENU_SAVE_AS_EVENT); }
//! //   generate_handler![ …, commands::document::save_document, commands::document::save_document_as, … ](2 つの一覧の両方・save_document の直後)
//! // --- src-tauri/src/commands/document.rs
//! /// Save As… の結果(フロントの `SaveAsResult { uri, within_root }` と同じ綴り=snake_case)。
//! #[derive(Debug, Clone, PartialEq, serde::Serialize)]
//! pub struct SaveAsResult { pub uri: String, pub within_root: bool }
//! /// Save As… の書き込みの実体(窓なし)。`path` は絶対パス(相対なら Err)。`content` を byte のまま(改行コード・BOM を保って)
//! /// 一時ファイル+rename で書く(`LocalProvider` の write_text=今の保存と同じ書き方。root の囲い込みは無し=どこでも書ける・
//! /// 保存の照合(expected hash)は無し)。`root` はこの窓の root(無ければ None)で、結果の `within_root`(`ensure_within_root` が Ok か)
//! /// にだけ使う。`uri` は書いたファイルの file:// URI(フロントがそのまま open に渡せる形)。失敗は Err(文字列)で、
//! /// 一時ファイル(`.<名前>.vellis-tmp`)を残さない。
//! pub async fn write_save_as(root: Option<&std::path::Path>, path: &std::path::Path, content: &str) -> Result<SaveAsResult, String>;
//! /// command: path(ダイアログが返した絶対パス)・content。expected_hash は取らない。窓の root を取り、存在する書き換え先が root の中なら
//! /// save_document と同じ写し(snapshot)を取ってから `write_save_as(Some(root), path, content)` を返す。
//! #[tauri::command]
//! pub async fn save_document_as(path: String, content: String, window: Window, state: State<'_, AppState>) -> Result<SaveAsResult, String>;
//! // --- src/lib/save-as.ts(フロントの正本は src/lib/save-as.wiring.test.ts)
//! export const MENU_SAVE_AS_EVENT = 'menu_save_as';
//! export const SAVE_AS_LABEL = 'Save As…';
//! export const SAVE_AS_COMMAND = 'save_document_as';
//! ```
//!
//! ## 判断の記録(test-writer 2026-11-26)
//! - 新しい command を足す(`save_document` に「root の外も可」の引数を足す案は選ばなかった: `save_document` の 4 つの門は要件48 の約束で、
//!   Save As… は照合も囲い込みも無い別の経路)。**既存の数を固定したテストが 3 つ赤になる=要件側更新が要る**(オーケストレーターの判断):
//!   acceptance_req74.rs `ac74_23_generate_handler_lists_keep_45_and_44_commands`(45/44 → 46/45)・acceptance_req84.rs
//!   `ac84_6_generate_handler_lists_are_unchanged`(COMMON に save_document_as)・acceptance_req84.rs `ac84_4_file_and_edit_slices_are_unchanged`
//!   (File の並びに save_as_item)。本ファイルはそれらの新しい値を固定する
//! - 写し(snapshot)は契約 3 に無いが、既存のファイルを置き換える(自分自身への上書き=契約7 を含む)ときの安全網として save_document と同じにする
//!   (ブリーフの推奨)。root の外の既存ファイルは写しの置き場(root ごとの store)が無いので写さない。本文に `snapshot` を含む識別子が
//!   `write_save_as(` より前にあることだけを固定し、置き方は実装の自由
//! - `uri` の形(canonical にするか・そのままか)は固定せず、`file://` で始まり指す実体が同じことだけを見る(macOS の /var → /private/var)
//! - 書けない場所のテストは、権限を落としたフォルダに書けてしまう環境(root で実行)では自分を飛ばす
//!
//! ## 修正前に赤になる理由
//! - `vellis_lib::menu` に SAVE_AS_* が無く、`vellis_lib::commands::document` に `write_save_as` / `SaveAsResult` が無いのでコンパイルで落ちる
//!   (=このバイナリ全体が赤)

use std::path::{Path, PathBuf};
use std::str::FromStr;

use muda::accelerator::Accelerator;
use vellis_lib::commands::document::{write_save_as, SaveAsResult};
use vellis_lib::menu::{MENU_SAVE_AS_EVENT, SAVE_ACCELERATOR, SAVE_AS_ACCELERATOR, SAVE_AS_ITEM_ID, SAVE_ITEM_ID};

// ---------------------------------------------------------------------------
// ソース走査の道具(acceptance_req74.rs / acceptance_req80.rs の写し)
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

fn document_rs_code() -> String {
    strip_line_comments(include_str!("../src/commands/document.rs"))
}

fn lib_rs_code() -> String {
    strip_line_comments(include_str!("../src/lib.rs"))
}

fn save_as_ts() -> String {
    read_source_or_empty("../src/lib/save-as.ts")
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

/// 関数の本体(外側の括弧を除く)。無ければ panic(=赤)。
fn fn_body(code: &str, name: &str) -> String {
    let start = fn_decl_start(code, name).unwrap_or_else(|| panic!("source must define `fn {name}(`"));
    let params_open = code[start..].find('(').expect("fn must take parameters") + start;
    let params_close = matching_close(code, params_open);
    let open = code[params_close..].find('{').expect("fn must have a body") + params_close;
    let close = matching_close(code, open);
    code[open + 1..close].to_string()
}

/// 関数のシグネチャの引数部分(`(`…`)` の中身)。
fn fn_params(code: &str, name: &str) -> String {
    let start = fn_decl_start(code, name).unwrap_or_else(|| panic!("source must define `fn {name}(`"));
    let params_open = code[start..].find('(').expect("fn must take parameters") + start;
    let params_close = matching_close(code, params_open);
    code[params_open + 1..params_close].to_string()
}

/// 関数の返り値の型(`)` の後の `->` から本体の `{` の手前まで)。
fn fn_return(code: &str, name: &str) -> String {
    let start = fn_decl_start(code, name).unwrap_or_else(|| panic!("source must define `fn {name}(`"));
    let params_open = code[start..].find('(').expect("fn must take parameters") + start;
    let params_close = matching_close(code, params_open);
    let open = code[params_close..].find('{').expect("fn must have a body") + params_close;
    code[params_close + 1..open].to_string()
}

fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

/// `start` から、最初の `(` に対応する閉じ括弧までの呼び出し全体。
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

/// `lib.rs` の `on_menu_event(…)` の呼び出し全体。
fn on_menu_event_block(code: &str) -> &str {
    let start = code.find("on_menu_event(").expect("lib.rs must call on_menu_event");
    balanced_call(code, start)
}

/// `on_menu_event` の中で `menu::<const_name>` を条件に持つ分岐の本体(`=> { … }`)。
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

/// `generate_handler![ … ]` の 2 つの一覧(acceptance_req84.rs の写し)。
fn generate_handler_lists(code: &str) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    let mut search = 0;
    while let Some(rel) = code[search..].find("generate_handler![") {
        let start = search + rel + "generate_handler!".len();
        let close = matching_close(code, start);
        let names = code[start + 1..close]
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.rsplit("::").next().unwrap_or(s).to_string())
            .collect();
        out.push(names);
        search = close;
    }
    out
}

/// `export const NAME = '…'` の文字列リテラルの中身(acceptance_req74.rs の写し)。
fn ts_string_const(src: &str, file: &str, name: &str) -> String {
    let marker = format!("export const {name}");
    let at = src.find(&marker).unwrap_or_else(|| panic!("{file} must `{marker}`"));
    let rest = &src[at + marker.len()..];
    let eq = rest.find('=').expect("`=` after the const name");
    let after = rest[eq + 1..].trim_start();
    let quote = after.chars().next().expect("a quoted string");
    assert!(quote == '\'' || quote == '"' || quote == '`', "{name} must be a string literal, got {after:?}");
    let body = &after[quote.len_utf8()..];
    let end = body.find(quote).expect("closing quote");
    body[..end].to_string()
}

// ---------------------------------------------------------------------------
// AC-89-1 — File ▸ Save As…(Shift + Command + S)の定数と menu(契約1)
// ---------------------------------------------------------------------------

#[test]
fn ac89_1_constants_are_fixed() {
    assert_eq!(SAVE_AS_ITEM_ID, "save-as");
    assert_eq!(MENU_SAVE_AS_EVENT, "menu_save_as");
    assert_eq!(SAVE_AS_ACCELERATOR, "CmdOrCtrl+Shift+S");
    assert_ne!(SAVE_AS_ITEM_ID, SAVE_ITEM_ID);
    assert_ne!(SAVE_AS_ACCELERATOR, SAVE_ACCELERATOR, "Save As… is not Command + S");
}

#[test]
fn ac89_1_accelerator_parses_and_is_registered_once_without_collision() {
    let save_as = Accelerator::from_str(SAVE_AS_ACCELERATOR)
        .expect("Shift + Command + S must parse — tauri silently drops unparsable accelerators");
    let parsed: Vec<(String, Accelerator)> = menu_rs_string_literals(&menu_rs_code())
        .into_iter()
        .filter(|s| s.contains('+'))
        .filter_map(|s| Accelerator::from_str(&s).ok().map(|a| (s, a)))
        .collect();
    let count = parsed.iter().filter(|(_, a)| *a == save_as).count();
    assert_eq!(count, 1, "menu.rs must register CmdOrCtrl+Shift+S exactly once (found {count})");
    for (i, (raw_a, acc_a)) in parsed.iter().enumerate() {
        for (raw_b, acc_b) in parsed.iter().skip(i + 1) {
            assert!(acc_a != acc_b, "duplicate accelerator in menu.rs: '{raw_a}' collides with '{raw_b}'");
        }
    }
}

#[test]
fn ac89_1_menu_rs_builds_save_as_item_with_the_constants_and_the_english_label() {
    let code = menu_rs_code();
    let at = code.find("let save_as_item").expect("menu.rs must bind `let save_as_item = MenuItem::with_id(…)`");
    let call_start = code[at..].find("MenuItem::with_id").expect("save_as_item must be a MenuItem::with_id") + at;
    let call = balanced_call(&code, call_start);
    let args = arguments(call);
    assert_eq!(args.len(), 5, "MenuItem::with_id(app, id, label, enabled, accelerator): {call}");
    assert_eq!(args[1], "SAVE_AS_ITEM_ID", "the id is the constant, not an inline literal");
    assert_eq!(args[2], "\"Save As\u{2026}\"", "the label is English with the … character (U+2026)");
    assert_eq!(args[3], "true", "enabled: the window decides whether it does anything (契約1)");
    assert_eq!(args[4], "Some(SAVE_AS_ACCELERATOR)", "the accelerator is the constant");
    assert!(
        !code.contains("\"Save As...\""),
        "no three-dot spelling of the label anywhere in menu.rs"
    );
}

#[test]
fn ac89_1_file_menu_holds_save_as_right_after_save() {
    let code = menu_rs_code();
    let file = submenu_call_with_label(&code, "File").expect("menu.rs must build the File submenu");
    let idents = submenu_item_idents(file);
    assert_eq!(
        idents,
        vec![
            "new_window_item",
            "new_tab_item",
            "duplicate_window_item",
            "new_window_sep",
            "open_file_item",
            "open_folder_item",
            "file_sep",
            "save_item",
            "save_as_item",
            "save_sep",
            "print_item",
        ],
        "File: … Save, Save As…, separator, Print… (acceptance_req84 ac84_4_file_and_edit_slices_are_unchanged needs the same update)"
    );
    let body = fn_body(&code, "build");
    assert!(!body.contains(".remove("), "build still removes nothing (要件74 契約21)");
}

#[test]
fn ac89_1_lib_rs_dispatches_save_as_to_the_focused_window() {
    let code = lib_rs_code();
    let block = on_menu_event_block(&code);
    let arm = menu_arm_body(block, "SAVE_AS_ITEM_ID");
    let flat = squash(arm);
    assert!(
        flat.contains("menu::handle_menu_open_click(app_handle,menu::MENU_SAVE_AS_EVENT)"),
        "the Save As… arm must emit MENU_SAVE_AS_EVENT to the focused window (as Save does): {arm}"
    );
    // Save の分岐は今のまま
    let save_arm = squash(menu_arm_body(block, "SAVE_ITEM_ID"));
    assert!(save_arm.contains("menu::MENU_SAVE_EVENT"), "the Save arm is untouched");
}

#[test]
fn ac89_1_frontend_constants_match_the_menu() {
    let ts = save_as_ts();
    assert!(!ts.is_empty(), "src/lib/save-as.ts must exist (the frontend's one hand for Save As…)");
    assert_eq!(ts_string_const(&ts, "src/lib/save-as.ts", "MENU_SAVE_AS_EVENT"), MENU_SAVE_AS_EVENT);
    assert_eq!(ts_string_const(&ts, "src/lib/save-as.ts", "SAVE_AS_LABEL"), "Save As\u{2026}");
    assert_eq!(ts_string_const(&ts, "src/lib/save-as.ts", "SAVE_AS_COMMAND"), "save_document_as");
}

// ---------------------------------------------------------------------------
// AC-89-2 / AC-89-4 / AC-89-5 — 書く実体 `write_save_as`(契約3・5・7)
// ---------------------------------------------------------------------------

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

fn tmp_leftovers(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.ends_with(".vellis-tmp"))
                .collect()
        })
        .unwrap_or_default()
}

fn uri_path(result: &SaveAsResult) -> PathBuf {
    assert!(result.uri.starts_with("file://"), "uri must be a file:// URI: {}", result.uri);
    PathBuf::from(&result.uri["file://".len()..])
}

#[tokio::test]
async fn ac89_2_writes_the_bytes_verbatim_to_a_new_file_outside_the_root() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let other = tmp.path().join("elsewhere");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    let target = other.join("copy.md");
    // BOM・CRLF・末尾に改行なし・非 ASCII: 1 byte も変えない
    let content = "\u{FEFF}# Title\r\n\r\nline two\r\nlast line without newline — ü";
    let result = write_save_as(Some(&root), &target, content).await.expect("writes outside the root");
    assert_eq!(std::fs::read(&target).unwrap(), content.as_bytes(), "bytes verbatim");
    assert!(!result.within_root, "elsewhere/ is outside root/");
    assert!(same_file(&uri_path(&result), &target), "uri points at the file written: {}", result.uri);
    assert!(tmp_leftovers(&other).is_empty(), "no .vellis-tmp left behind");
    assert!(std::fs::read_dir(&root).unwrap().next().is_none(), "nothing appears inside the root");
}

#[tokio::test]
async fn ac89_2_within_root_is_true_inside_the_root_and_false_without_a_root() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    std::fs::create_dir_all(root.join("sub")).unwrap();
    let inside = root.join("sub").join("copy.txt");
    let r1 = write_save_as(Some(&root), &inside, "a\nb\n").await.unwrap();
    assert!(r1.within_root, "root/sub/copy.txt is inside root/");
    assert_eq!(std::fs::read_to_string(&inside).unwrap(), "a\nb\n");
    assert!(same_file(&uri_path(&r1), &inside));

    let outside = tmp.path().join("copy2.txt");
    let r2 = write_save_as(None, &outside, "x\n").await.unwrap();
    assert!(!r2.within_root, "without a root nothing is within it");
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "x\n");

    // root の兄弟で名前が root で始まるフォルダ(root2/)は root の中ではない(文字列の接頭辞では判定しない)
    let sibling = tmp.path().join("root2");
    std::fs::create_dir_all(&sibling).unwrap();
    let r3 = write_save_as(Some(&root), &sibling.join("c.txt"), "y\n").await.unwrap();
    assert!(!r3.within_root, "root2/ is not inside root/");
}

#[tokio::test]
async fn ac89_5_overwrites_an_existing_file_and_leaves_its_siblings_alone() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    std::fs::create_dir_all(&root).unwrap();
    let target = root.join("plan.md");
    let sibling = root.join("other.md");
    std::fs::write(&target, "old content\n").unwrap();
    std::fs::write(&sibling, "sibling\n").unwrap();
    // 契約7: 自分自身(存在するファイル)を選んだときは照合なしで上書き(expected hash を取る引数そのものが無い)
    let result = write_save_as(Some(&root), &target, "new content\r\n").await.expect("overwrites");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "new content\r\n");
    assert_eq!(std::fs::read_to_string(&sibling).unwrap(), "sibling\n", "the sibling is untouched");
    assert!(result.within_root);
    assert!(tmp_leftovers(&root).is_empty());
    let names: Vec<String> = std::fs::read_dir(&root)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names.len(), 2, "no extra file in the folder: {names:?}");
}

#[tokio::test]
async fn ac89_4_refuses_a_missing_parent_a_relative_path_and_a_directory_and_writes_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    std::fs::create_dir_all(&root).unwrap();

    let missing_parent = tmp.path().join("no-such-dir").join("copy.md");
    let err = write_save_as(Some(&root), &missing_parent, "x\n").await.expect_err("parent does not exist");
    assert!(!err.is_empty(), "the error says something");
    assert!(!missing_parent.exists());
    assert!(!tmp.path().join("no-such-dir").exists(), "no folder is created on the way");

    let relative = PathBuf::from("relative/copy.md");
    let err = write_save_as(Some(&root), &relative, "x\n").await.expect_err("a relative path is refused");
    assert!(!err.is_empty());
    assert!(!relative.exists());

    let err = write_save_as(Some(&root), &root, "x\n").await.expect_err("a directory is not a file to write");
    assert!(!err.is_empty());
    assert!(root.is_dir(), "the directory is still there");
    assert!(tmp_leftovers(tmp.path()).is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn ac89_4_refuses_an_unwritable_folder_and_leaves_no_temp_file() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let locked = tmp.path().join("locked");
    std::fs::create_dir_all(&locked).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
    // root で動いているなど、権限が効かない環境では判定できないので飛ばす
    if std::fs::write(locked.join(".probe"), b"").is_ok() {
        let _ = std::fs::remove_file(locked.join(".probe"));
        let _ = std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755));
        eprintln!("skipped: the folder is writable in this environment");
        return;
    }
    let target = locked.join("copy.md");
    let err = write_save_as(None, &target, "x\n").await.expect_err("an unwritable folder is refused");
    assert!(!err.is_empty(), "the error carries a message for the alert (契約5)");
    let _ = std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755));
    assert!(!target.exists(), "nothing written");
    assert!(tmp_leftovers(&locked).is_empty(), "no .vellis-tmp left behind");
}

#[test]
fn ac89_3_save_as_result_serializes_with_snake_case_keys_for_the_frontend() {
    let result = SaveAsResult { uri: "file:///a/b.md".to_string(), within_root: true };
    let json = serde_json::to_value(&result).unwrap();
    assert_eq!(json, serde_json::json!({ "uri": "file:///a/b.md", "within_root": true }));
}

// ---------------------------------------------------------------------------
// 契約3・契約7 — command `save_document_as` の本文(ソース走査)と invoke_handler への登録
// ---------------------------------------------------------------------------

#[test]
fn ac89_2_save_document_as_takes_path_and_content_without_an_expected_hash() {
    let code = document_rs_code();
    let params = squash(&fn_params(&code, "save_document_as"));
    assert!(params.contains("path:String"), "save_document_as takes `path: String`: {params}");
    assert!(params.contains("content:String"), "save_document_as takes `content: String`: {params}");
    assert!(!params.contains("expected_hash"), "no save check for a write to a new place (契約3): {params}");
    assert!(params.contains("window:Window") || params.contains("window:tauri::Window"), "it is a window command: {params}");
    let ret = squash(&fn_return(&code, "save_document_as"));
    assert!(ret.contains("Result<SaveAsResult"), "it returns Result<SaveAsResult, String>: {ret}");
    // #[tauri::command] が直前に付く
    let start = fn_decl_start(&code, "save_document_as").expect("fn save_document_as");
    let before = &code[..start];
    let attr = before.rfind("#[tauri::command]").expect("save_document_as must be a #[tauri::command]");
    assert!(
        !before[attr..].contains("fn "),
        "the #[tauri::command] attribute belongs to save_document_as itself"
    );
}

#[test]
fn ac89_2_save_document_as_snapshots_then_writes_through_write_save_as_without_the_hash_check() {
    let code = document_rs_code();
    let body = fn_body(&code, "save_document_as");
    let write = body.find("write_save_as(").expect("save_document_as must write through write_save_as(");
    assert!(!body.contains("check_expected_hash("), "no optimistic lock in Save As… (契約3・契約7)");
    let lower = body.to_lowercase();
    let snapshot = lower.find("snapshot").expect("save_document_as takes the same pre-write snapshot as save_document for an existing target inside the root");
    assert!(snapshot < write, "the snapshot comes before the write");
    // save_document の本文は今のまま(照合つき・root の囲い込みつき)
    let save = fn_body(&code, "save_document");
    assert!(save.contains("check_expected_hash(") && save.contains("ensure_within_root("), "save_document is untouched");
}

#[test]
fn ac89_2_write_save_as_is_a_public_async_fn_without_a_window() {
    let code = document_rs_code();
    let params = squash(&fn_params(&code, "write_save_as"));
    assert!(!params.contains("Window") && !params.contains("State<"), "write_save_as needs no window or state: {params}");
    let start = fn_decl_start(&code, "write_save_as").unwrap();
    let decl_line_start = code[..start].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let decl = &code[decl_line_start..start];
    assert!(decl.contains("pub") && decl.contains("async"), "write_save_as is `pub async fn`: {decl:?}");
}

#[test]
fn ac89_1_generate_handler_lists_register_save_document_as_after_save_document() {
    let lists = generate_handler_lists(&lib_rs_code());
    assert_eq!(lists.len(), 2, "lib.rs builds the invoke handler twice (webdriver / not)");
    for (which, list) in [("webdriver", &lists[0]), ("default", &lists[1])] {
        let save = list.iter().position(|n| n == "save_document").unwrap_or_else(|| panic!("{which}: save_document"));
        let save_as = list
            .iter()
            .position(|n| n == "save_document_as")
            .unwrap_or_else(|| panic!("{which} list must register save_document_as (acceptance_req74 / req84 count tests need the same update)"));
        assert_eq!(save_as, save + 1, "{which}: save_document_as sits right after save_document");
        assert_eq!(list.iter().filter(|n| *n == "save_document_as").count(), 1, "{which}: registered once");
    }
    assert_eq!(lists[0].len(), 46, "webdriver list: 45 + save_document_as");
    assert_eq!(lists[1].len(), 45, "default list: 44 + save_document_as");
}
