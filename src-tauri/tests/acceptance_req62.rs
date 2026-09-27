//! 要件#62 の受け入れテスト(docs/requirements/req-62.md)— Rust 層
//! (AC-62-1〜6・AC-62-13・AC-62-14 の Rust 側。契約 2・3・7・8・11)
//!
//! 「タブで1つのウィンドウに複数のファイルを開く。タブは取り出して別のウィンドウに
//!  でき、root が同じなら元のウィンドウへ戻せる」— タブの実体は **macOS 標準の
//! ウィンドウタブ**(1タブ=既存の Vellis ウィンドウ1枚・契約1【(a) 確定】)。
//!
//! 本ファイルの持ち場(機械判定できる範囲):
//! - AC-62-1(契約2)  タブ群の鍵 `tab_group_key(root, label)` の規則(純関数の値固定)
//! - AC-62-2(契約2)  全ての窓の生成経路(`WebviewWindowBuilder::new(` の全呼び出し・
//!   `tauri.conf.json` の `app.windows`)で鍵を付けている(ソース走査)
//! - AC-62-3(契約2)  印刷窓の鍵は `vellis-print:` で始まり文書の窓と合流しない
//! - AC-62-4(契約2・9)`init_window` / `set_root` / `handle_switch_root` が `set_title` と
//!   同じ関数の中で鍵を付け替えている(ソース走査)
//! - AC-62-5(契約3・11)File ▸ New Tab の定数・parse 妥当性・並び・ラベル
//! - AC-62-6(契約7)  Window ▸ Show Previous Tab / Show Next Tab の定数・parse 妥当性・
//!   Window メニューにあること・ラベル
//! - AC-62-13(契約8)タブの見出し `derive_tab_title(root, doc_uri)`(純関数の値固定)
//! - AC-62-14(契約11)`Cargo.toml` の `[dependencies]` 節のクレート集合が登録時点と同一・
//!   `objc2` / `objc2-app-kit` は macOS 専用の target 節にだけ現れる・
//!   **Cargo.lock の `[[package]]` の名前集合が登録時点と同一**(新しいパッケージが増えない)
//!
//! AC-62-7(既存 acceptance_req60.rs のアクセラレータ重複なし・メニューバーの並び)と
//! AC-62-15(既存テストの無改変)は既存テストと reviewer 照合の持ち場。
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前・公開パス)
//!
//! ```ignore
//! // --- src-tauri/src/window/tab.rs(新規)— lib.rs の `pub mod window` 配下に
//! //     `pub mod tab;` を足す。title.rs の derive_window_title と同じ家風の純関数。
//! //     本テストは `vellis_lib::window::tab::{tab_group_key, derive_tab_title}` で解決する。
//!
//! /// タブ群の鍵(契約2)= NSWindow の tabbingIdentifier に入れる文字列。
//! /// - Some(root) → "vellis-root:<正規化した root>"
//! ///   正規化= 末尾スラッシュを落とす・パーセントエンコードを復号する・
//! ///   `file://` は小文字に畳む(APFS は既定で大文字小文字を区別しない)・
//! ///   `ssh://` は畳まない(接続先の Linux は区別する)
//! /// - None(root の無い窓=履歴選択画面)→ "vellis-noroot:<label>"(窓ごとに一意)
//! pub fn tab_group_key(root: Option<&str>, label: &str) -> String;
//!
//! /// タブの見出し(契約8)= 開いている文書のファイル名。文書が無ければ
//! /// derive_window_title(root)(root フォルダ名・root も無ければ "vellis")。
//! /// ssh の authority(user@host:port)は見出しに出ない。
//! pub fn derive_tab_title(root: Option<&str>, doc_uri: Option<&str>) -> String;
//!
//! // --- src-tauri/src/menu.rs — 既存の *_ITEM_ID / MENU_*_EVENT / *_ACCELERATOR と同じ家風
//! pub const NEW_TAB_ITEM_ID: &str = "new-tab";
//! pub const MENU_NEW_TAB_EVENT: &str = "menu_new_tab";
//! pub const NEW_TAB_ACCELERATOR: &str = "CmdOrCtrl+T";
//! pub const PREVIOUS_TAB_ITEM_ID: &str = "previous-tab";
//! pub const NEXT_TAB_ITEM_ID: &str = "next-tab";
//! /// Shift+Command+[ / Shift+Command+] — 綴りは muda が parse できるものなら自由
//! /// (本テストは parse 結果が BracketLeft / BracketRight + Shift + CmdOrCtrl と
//! /// 一致することを判定する。例: "CmdOrCtrl+Shift+[" / "CmdOrCtrl+Shift+BracketLeft")。
//! pub const PREVIOUS_TAB_ACCELERATOR: &str = /* … */;
//! pub const NEXT_TAB_ACCELERATOR: &str = /* … */;
//! ```
//!
//! ソース走査が前提にする形(既存コードの家風どおり):
//! - 窓を作る式は `WebviewWindowBuilder::new(app, &label, …)` から始まるメソッド連鎖で、
//!   その**同じ連鎖の中**に `.tabbing_identifier(…)` がある(`commands/window.rs`・
//!   `ipc/handler.rs`・`print.rs` の3箇所。新しい `new_tab` command が `create_window` を
//!   通らずに builder を呼ぶなら、それも同じ網に入る)
//! - 鍵の付け替えは `set_title` を呼んでいる3関数(`init_window` / `set_root` /
//!   `handle_switch_root`)の**本体の中**で、名前に `tabbing_identifier` を含む関数
//!   (例: `set_tabbing_identifier(&window, &key)`)を呼ぶ形にする。関数名そのものは
//!   契約に無いので決め打ちしない
//! - New Tab の MenuItem は `let <binding> = MenuItem::with_id(app, NEW_TAB_ITEM_ID, "New Tab",
//!   true, Some(NEW_TAB_ACCELERATOR))?;` の形で束縛し、File メニューの項目スライスで
//!   `&new_window_item` の直後・`&duplicate_window_item` の直前に置く
//! - Show Previous / Next Tab の MenuItem も同じ形で束縛し、Window メニュー(ラベル
//!   "Window" の `Submenu::with_id_and_items`)の項目スライスに置く(Previous が先)
//!
//! ## reviewer 照合に委ねる項目(AppHandle / NSWindow 依存で機械判定不能)
//! - `new_tab` command が `create_window` で窓を作り、呼んだ窓の NSWindow に
//!   `addTabbedWindow:ordered:` で加えること(契約4)
//! - Show Previous / Next Tab のクリックで前面の NSWindow に `selectPreviousTab:` /
//!   `selectNextTab:` を送ること(契約7)・New Tab のクリックが handle_menu_open_click と
//!   同型に MENU_NEW_TAB_EVENT を前面の窓へ emit_to すること(契約3)
//! - 文書が変わるたびに NSWindow の tab.title を derive_tab_title で差し替えること(契約8)
//! - root が変わったタブが同じ窓に他のタブがあれば新しい窓へ出ること(契約9)
//! - `WindowArgs` にフィールドを足していないこと(AC-62-15=既存テストのコンパイル)
//!
//! ## 人間ゲート(acceptance/acceptance.md 要件#62 — AppKit の実挙動)
//! タブバーの見え方・ドラッグでの取り出しと戻す・root が違う窓へ戻せないこと・
//! Merge All Windows・Command+W と未保存確認・Control+Tab と Shift+Command+] の効き・
//! タブの見出し・root を変えたタブが別の窓へ出ること・全画面での自動タブ・
//! SpaceMouse・タブを10枚開いたときの重さ。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use muda::accelerator::Accelerator;
use vellis_lib::menu::{
    MENU_NEW_TAB_EVENT, NEW_TAB_ACCELERATOR, NEW_TAB_ITEM_ID, NEXT_TAB_ACCELERATOR,
    NEXT_TAB_ITEM_ID, PREVIOUS_TAB_ACCELERATOR, PREVIOUS_TAB_ITEM_ID,
};
use vellis_lib::window::tab::{derive_tab_title, tab_group_key};
use vellis_lib::window_title::derive_window_title;

// ---------------------------------------------------------------------------
// 共通ヘルパ — ソースの読み込み・コメント落とし・括弧の対応
// ---------------------------------------------------------------------------

/// `src-tauri/` の絶対パス(cargo test は CARGO_MANIFEST_DIR を必ず与える)。
fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_source(rel: &str) -> String {
    let path = manifest_dir().join(rel);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {}", path.display(), e))
}

/// 行ごとに `//` 以降(コメント)を落としたコード部分を連結して返す
/// (acceptance_req35 / req36 / req54 / req60 の走査と同じ流儀)。`://`(URL や
/// `file://` のリテラル)はコメントではないので落とさない。
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

/// `open`(`(` の位置)に対応する閉じ括弧の位置。`(`/`[`/`{` と `)`/`]`/`}` を同じ
/// 深さで数える素朴な走査(対象の式の文字列リテラルに括弧は現れない)。
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

/// `start`(`Xxx::with_…` の先頭)から、最初の `(` に対応する閉じ括弧までの
/// 呼び出し全体(acceptance_req60 の balanced_call と同じ)。
fn balanced_call(code: &str, start: usize) -> &str {
    let open = code[start..].find('(').expect("call must have '('") + start;
    let close = matching_close(code, open);
    &code[start..=close]
}

/// `start` から始まるメソッド連鎖全体(`Builder::new(…).a(…).b(…)…` を、`.ident(` が
/// 続く限り取り込む)。`?` や `.await` は含めず、次が `.` でなくなったところで止まる。
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

/// ラベル(呼び出し内の最初の文字列リテラル)が `label` の
/// Submenu::with_items / with_id_and_items 呼び出し全体(acceptance_req60 と同じ)。
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

/// `const_name` を引数に取る `MenuItem::with_id(` 呼び出し全体(定数の宣言行ではなく
/// 使用箇所)。無ければ None。
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

/// `const_name` を使う MenuItem の束縛名(`let <binding> = MenuItem::with_id(…)` の
/// binding)。acceptance_req60 の go_to_item_binding と同じ遡り方。
fn menu_item_binding<'a>(code: &'a str, const_name: &str) -> &'a str {
    let call = menu_item_call_using(code, const_name)
        .unwrap_or_else(|| panic!("menu.rs must build a MenuItem with {const_name}"));
    let use_pos = call.as_ptr() as usize - code.as_ptr() as usize;
    let let_pos = code[..use_pos]
        .rfind("let ")
        .unwrap_or_else(|| panic!("{const_name} must be used inside a let binding"));
    code[let_pos + 4..use_pos]
        .split(|c: char| c == '=' || c.is_whitespace())
        .find(|s| !s.is_empty())
        .expect("binding name after `let`")
}

/// `fn <name>(` で始まる関数の本体(最初の `{` から対応する `}` まで)。
fn fn_body<'a>(code: &'a str, name: &str) -> &'a str {
    let needle = format!("fn {name}(");
    let start = code
        .find(&needle)
        .unwrap_or_else(|| panic!("source must define `{needle}…`"));
    let open = code[start..].find('{').expect("fn must have a body") + start;
    let close = matching_close(code, open);
    &code[open..=close]
}

/// menu.rs のコード部分から二重引用符の文字列リテラルを取り出す(acceptance_req60 と同じ)。
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

// ---------------------------------------------------------------------------
// AC-62-1 — タブ群の鍵の規則(契約2)
// ---------------------------------------------------------------------------

/// 1. 大文字小文字(file://)と末尾スラッシュの違いは同じ鍵に畳まれ、形は
///    `vellis-root:<小文字・末尾スラッシュなし>`(要件#60 追補d の前例)。
#[test]
fn file_root_key_folds_case_and_trailing_slash() {
    let a = tab_group_key(Some("file:///Users/a/notes"), "w1");
    let b = tab_group_key(Some("file:///users/a/notes/"), "w2");
    assert_eq!(a, "vellis-root:file:///users/a/notes");
    assert_eq!(a, b, "same folder spelled differently must share one tab group");
}

/// 2. パーセントエンコードは復号してから比べる(`%20` と空白は同じフォルダ)。
#[test]
fn file_root_key_decodes_percent_encoding() {
    let encoded = tab_group_key(Some("file:///Users/a/my%20notes"), "w1");
    let plain = tab_group_key(Some("file:///Users/a/my notes"), "w2");
    assert_eq!(encoded, plain, "%20 and a space must yield the same key");
    assert_eq!(encoded, "vellis-root:file:///users/a/my notes");
}

/// 3. ssh:// は大文字小文字を畳まない(接続先の Linux は区別する)。末尾スラッシュは落とす。
#[test]
fn ssh_root_key_keeps_case_but_drops_trailing_slash() {
    let upper = tab_group_key(Some("ssh://h/srv/Notes"), "w1");
    let lower = tab_group_key(Some("ssh://h/srv/notes"), "w2");
    assert_ne!(upper, lower, "ssh roots differing only in case are different folders");
    assert_eq!(upper, "vellis-root:ssh://h/srv/Notes");
    assert_eq!(
        tab_group_key(Some("ssh://h/srv/Notes/"), "w3"),
        upper,
        "a trailing slash on an ssh root must not change the key"
    );
}

/// 4. ラベルは root のある窓の鍵に影響しない(同じ root なら別の窓でも同じ鍵)。
#[test]
fn label_does_not_affect_a_rooted_key() {
    assert_eq!(
        tab_group_key(Some("file:///a/b"), "main"),
        tab_group_key(Some("file:///a/b"), "vellis-7")
    );
}

/// 5. root の無い窓は `vellis-noroot:<label>`=窓ごとに一意(誰とも合流しない)。
#[test]
fn no_root_key_is_unique_per_window_label() {
    assert_eq!(tab_group_key(None, "main"), "vellis-noroot:main");
    assert_eq!(tab_group_key(None, "vellis-2"), "vellis-noroot:vellis-2");
    assert_ne!(tab_group_key(None, "main"), tab_group_key(None, "vellis-2"));
}

/// 6. root の無い窓の鍵は、どんな root の鍵とも一致しない(接頭辞が違う)。
#[test]
fn no_root_key_never_matches_a_rooted_key() {
    let noroot = tab_group_key(None, "main");
    assert!(noroot.starts_with("vellis-noroot:"));
    for root in ["file:///main", "file:///", "ssh://main/", "main"] {
        let rooted = tab_group_key(Some(root), "main");
        assert!(rooted.starts_with("vellis-root:"), "rooted key for {root}: {rooted}");
        assert_ne!(rooted, noroot);
    }
}

// ---------------------------------------------------------------------------
// AC-62-2 — 全ての窓の生成経路で鍵を付ける(契約2・ソース走査)
// ---------------------------------------------------------------------------

/// `src-tauri/src/**` の `WebviewWindowBuilder::new(` 呼び出しごとのメソッド連鎖
/// (ファイル相対パス, 連鎖テキスト)。
fn builder_chains() -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (rel, src) in all_rust_sources() {
        let code = strip_line_comments(&src);
        let mut search = 0;
        while let Some(pos) = code[search..].find("WebviewWindowBuilder::new(") {
            let start = search + pos;
            let chain = method_chain(&code, start).to_string();
            search = start + "WebviewWindowBuilder::new(".len();
            out.push((rel.clone(), chain));
        }
    }
    out
}

/// 7. 走査が空振りしていない: 既知の3経路(`commands/window.rs`・`ipc/handler.rs`・
///    `print.rs`)が網に入っている(前提の固定=これが崩れたら走査を見直す)。
#[test]
fn builder_scan_covers_the_three_known_creation_paths() {
    let files: BTreeSet<String> = builder_chains().into_iter().map(|(f, _)| f).collect();
    for expected in ["commands/window.rs", "ipc/handler.rs", "print.rs"] {
        assert!(
            files.contains(expected),
            "WebviewWindowBuilder::new( must be found in {expected} (found in: {files:?})"
        );
    }
}

/// 8. 全ての `WebviewWindowBuilder::new(` の連鎖が、同じ連鎖の中で
///    `.tabbing_identifier(` を呼ぶ。1枚でも鍵の無い窓を作ると tao が
///    `allowsAutomaticWindowTabbing = false` を**アプリ全体**に設定するため(契約2)。
#[test]
fn every_webview_window_builder_sets_a_tabbing_identifier() {
    let chains = builder_chains();
    assert!(!chains.is_empty(), "no WebviewWindowBuilder::new( found under src-tauri/src");
    for (file, chain) in &chains {
        assert!(
            chain.contains(".tabbing_identifier("),
            "{file}: this WebviewWindowBuilder chain must call .tabbing_identifier(…):\n{chain}"
        );
    }
}

/// 9. 最初の窓(`tauri.conf.json` の `app.windows`)も鍵を持つ。起動時は root が
///    未定なので `vellis-noroot:main`(`init_window` で root が決まったら付け替える)。
#[test]
fn every_configured_window_has_a_tabbing_identifier() {
    let conf: serde_json::Value = serde_json::from_str(&read_source("tauri.conf.json"))
        .expect("tauri.conf.json must be valid JSON");
    let windows = conf["app"]["windows"]
        .as_array()
        .expect("app.windows must be an array");
    assert!(!windows.is_empty(), "app.windows must configure the first window");
    for (i, window) in windows.iter().enumerate() {
        let id = window["tabbingIdentifier"]
            .as_str()
            .unwrap_or_else(|| panic!("app.windows[{i}] must set a string tabbingIdentifier"));
        assert!(!id.is_empty(), "app.windows[{i}].tabbingIdentifier must not be empty");
    }
    let label = windows[0]["label"].as_str().unwrap_or("main");
    assert_eq!(
        windows[0]["tabbingIdentifier"].as_str(),
        Some(tab_group_key(None, label).as_str()),
        "the first window starts without a root, so its key is the no-root key for its label"
    );
}

// ---------------------------------------------------------------------------
// AC-62-3 — 印刷窓は文書の窓と合流しない(契約2)
// ---------------------------------------------------------------------------

/// 10. 印刷窓(`print.rs` の builder 連鎖)が鍵を付け、その鍵の接頭辞
///     `vellis-print:` が print.rs のコード行に文字列リテラルとして現れる。
#[test]
fn print_window_key_starts_with_the_print_prefix() {
    let chains: Vec<String> = builder_chains()
        .into_iter()
        .filter(|(f, _)| f == "print.rs")
        .map(|(_, c)| c)
        .collect();
    assert_eq!(chains.len(), 1, "print.rs must build exactly one print window");
    assert!(chains[0].contains(".tabbing_identifier("));

    let print_code = strip_line_comments(include_str!("../src/print.rs"));
    assert!(
        string_literals(&print_code)
            .iter()
            .any(|s| s.starts_with("vellis-print:")),
        "print.rs must carry a string literal starting with \"vellis-print:\" for the print window's key"
    );
}

/// 11. `tab_group_key` は決して `vellis-print:` で始まる鍵を作らない(文書の窓の鍵と
///     印刷窓の鍵は接頭辞で排他)。
#[test]
fn document_keys_never_collide_with_the_print_prefix() {
    for key in [
        tab_group_key(None, "print-1"),
        tab_group_key(Some("file:///print-1"), "w"),
        tab_group_key(Some("vellis-print:abc"), "w"),
    ] {
        assert!(!key.starts_with("vellis-print:"), "{key}");
        assert!(key.starts_with("vellis-root:") || key.starts_with("vellis-noroot:"), "{key}");
    }
}

// ---------------------------------------------------------------------------
// AC-62-4 — 鍵の付け替えの経路(契約2・9・ソース走査)
// ---------------------------------------------------------------------------

/// `set_title` を呼ぶ関数本体が、同じ本体の中で名前に `tabbing_identifier` を含む
/// 関数を呼んでいるか。
fn body_retags(body: &str) -> bool {
    body.match_indices("tabbing_identifier")
        .any(|(i, _)| {
            let after = &body[i + "tabbing_identifier".len()..];
            after.trim_start().starts_with('(')
        })
}

/// 12. `init_window`(commands/app.rs)= root が決まったところで鍵を付け替える。
#[test]
fn init_window_retags_where_it_sets_the_title() {
    let code = strip_line_comments(include_str!("../src/commands/app.rs"));
    let body = fn_body(&code, "init_window");
    assert!(body.contains("set_title("), "init_window must still set the title (要件#17)");
    assert!(
        body_retags(body),
        "init_window must call a `…tabbing_identifier(…)` retag in the same body as set_title"
    );
}

/// 13. `set_root`(commands/root.rs)= Open Folder… / ↑ / 履歴選択で root が変わる経路。
#[test]
fn set_root_retags_where_it_sets_the_title() {
    let code = strip_line_comments(include_str!("../src/commands/root.rs"));
    let body = fn_body(&code, "set_root");
    assert!(body.contains("set_title("), "set_root must still set the title (要件#17)");
    assert!(
        body_retags(body),
        "set_root must call a `…tabbing_identifier(…)` retag in the same body as set_title"
    );
}

/// 14. `handle_switch_root`(ipc/handler.rs)= `vellis -r` で root が変わる経路。
#[test]
fn handle_switch_root_retags_where_it_sets_the_title() {
    let code = strip_line_comments(include_str!("../src/ipc/handler.rs"));
    let body = fn_body(&code, "handle_switch_root");
    assert!(body.contains("set_title("), "handle_switch_root must still set the title (要件#17)");
    assert!(
        body_retags(body),
        "handle_switch_root must call a `…tabbing_identifier(…)` retag in the same body as set_title"
    );
}

// ---------------------------------------------------------------------------
// AC-62-5 — File ▸ New Tab(契約3・11)
// ---------------------------------------------------------------------------

/// 15. 定数の値固定(項目 ID・イベント名・アクセラレータ)。
#[test]
fn new_tab_menu_constants_are_fixed() {
    assert_eq!(NEW_TAB_ITEM_ID, "new-tab");
    assert_eq!(MENU_NEW_TAB_EVENT, "menu_new_tab");
    assert_eq!(NEW_TAB_ACCELERATOR, "CmdOrCtrl+T");
}

/// 16. Command+T が muda で parse できる(tauri は失敗を黙って捨てる=要件#36 の教訓)。
#[test]
fn new_tab_accelerator_parses_as_tauri_accelerator() {
    assert!(
        Accelerator::from_str(NEW_TAB_ACCELERATOR).is_ok(),
        "accelerator '{}' must parse — tauri silently drops unparsable ones",
        NEW_TAB_ACCELERATOR
    );
}

/// 17. New Tab の MenuItem がラベル "New Tab"(英語)で、定数(ID・アクセラレータ)を
///     インラインリテラルではなく参照している。
#[test]
fn new_tab_menu_item_carries_english_label_and_constants() {
    let code = menu_rs_code();
    let call = menu_item_call_using(&code, "NEW_TAB_ITEM_ID")
        .expect("menu.rs must build a MenuItem::with_id(…NEW_TAB_ITEM_ID…)");
    assert_eq!(
        first_string_literal(call),
        Some("New Tab"),
        "the New Tab item's label must be the literal \"New Tab\""
    );
    assert!(
        call.contains("NEW_TAB_ACCELERATOR"),
        "the New Tab item must pass NEW_TAB_ACCELERATOR (not an inline literal)"
    );
}

/// 18. File メニューの項目列で `new_window_item` の直後・`duplicate_window_item` の直前。
#[test]
fn file_menu_places_new_tab_between_new_window_and_duplicate_window() {
    let code = menu_rs_code();
    let file_menu = submenu_call_with_label(&code, "File")
        .expect("menu.rs must build a submenu labelled \"File\"");
    let idents = submenu_item_idents(file_menu);
    let new_tab = menu_item_binding(&code, "NEW_TAB_ITEM_ID");
    let pos = |name: &str| {
        idents
            .iter()
            .position(|i| *i == name)
            .unwrap_or_else(|| panic!("File menu must hold `&{name}` (items: {idents:?})"))
    };
    let new_window = pos("new_window_item");
    let tab = pos(new_tab);
    let duplicate = pos("duplicate_window_item");
    assert_eq!(tab, new_window + 1, "New Tab must come right after New Window ({idents:?})");
    assert_eq!(duplicate, tab + 1, "Duplicate Window must come right after New Tab ({idents:?})");
}

/// 19. クリック→ emit の配線が MENU_NEW_TAB_EVENT 定数を参照している(宣言+ dispatch
///     で2回以上=acceptance_req60 の go_to_event_constant_is_dispatched と同型)。
#[test]
fn new_tab_event_constant_is_dispatched() {
    let combined = format!("{}\n{}", menu_rs_code(), lib_rs_code());
    let count = combined.matches("MENU_NEW_TAB_EVENT").count();
    assert!(
        count >= 2,
        "MENU_NEW_TAB_EVENT must be declared and dispatched (found {count} occurrence(s) across menu.rs + lib.rs)"
    );
}

// ---------------------------------------------------------------------------
// AC-62-6 — Window ▸ Show Previous Tab / Show Next Tab(契約7)
// ---------------------------------------------------------------------------

/// 20. 項目 ID の値固定。
#[test]
fn tab_switch_item_ids_are_fixed() {
    assert_eq!(PREVIOUS_TAB_ITEM_ID, "previous-tab");
    assert_eq!(NEXT_TAB_ITEM_ID, "next-tab");
}

/// 21. Shift+Command+[ / Shift+Command+] が parse でき、鍵が BracketLeft / BracketRight
///     (綴りは自由=parse 結果で比べる)。
#[test]
fn tab_switch_accelerators_parse_to_shift_cmd_brackets() {
    let previous = Accelerator::from_str(PREVIOUS_TAB_ACCELERATOR).unwrap_or_else(|e| {
        panic!("PREVIOUS_TAB_ACCELERATOR '{PREVIOUS_TAB_ACCELERATOR}' must parse: {e}")
    });
    let next = Accelerator::from_str(NEXT_TAB_ACCELERATOR).unwrap_or_else(|e| {
        panic!("NEXT_TAB_ACCELERATOR '{NEXT_TAB_ACCELERATOR}' must parse: {e}")
    });
    assert_eq!(
        previous,
        Accelerator::from_str("CmdOrCtrl+Shift+BracketLeft").unwrap(),
        "Show Previous Tab must be Shift+Command+["
    );
    assert_eq!(
        next,
        Accelerator::from_str("CmdOrCtrl+Shift+BracketRight").unwrap(),
        "Show Next Tab must be Shift+Command+]"
    );
}

/// 22. 両項目のラベル(英語)と定数の参照。
#[test]
fn tab_switch_menu_items_carry_english_labels_and_constants() {
    let code = menu_rs_code();
    let previous = menu_item_call_using(&code, "PREVIOUS_TAB_ITEM_ID")
        .expect("menu.rs must build a MenuItem::with_id(…PREVIOUS_TAB_ITEM_ID…)");
    assert_eq!(first_string_literal(previous), Some("Show Previous Tab"));
    assert!(previous.contains("PREVIOUS_TAB_ACCELERATOR"));

    let next = menu_item_call_using(&code, "NEXT_TAB_ITEM_ID")
        .expect("menu.rs must build a MenuItem::with_id(…NEXT_TAB_ITEM_ID…)");
    assert_eq!(first_string_literal(next), Some("Show Next Tab"));
    assert!(next.contains("NEXT_TAB_ACCELERATOR"));
}

/// 23. 両項目が Window メニューの項目列にあり、Previous が Next より前(契約7 の並び)。
#[test]
fn window_menu_holds_previous_then_next_tab() {
    let code = menu_rs_code();
    let window_menu = submenu_call_with_label(&code, "Window")
        .expect("menu.rs must build a submenu labelled \"Window\"");
    let idents = submenu_item_idents(window_menu);
    let previous = menu_item_binding(&code, "PREVIOUS_TAB_ITEM_ID");
    let next = menu_item_binding(&code, "NEXT_TAB_ITEM_ID");
    let pos = |name: &str| {
        idents
            .iter()
            .position(|i| *i == name)
            .unwrap_or_else(|| panic!("Window menu must hold `&{name}` (items: {idents:?})"))
    };
    assert!(pos(previous) < pos(next), "Show Previous Tab must precede Show Next Tab ({idents:?})");
}

/// 24. 切り替え項目の ID がクリックの dispatch(lib.rs の match)で参照されている
///     (宣言+使用で2回以上)。
#[test]
fn tab_switch_item_ids_are_dispatched() {
    let combined = format!("{}\n{}", menu_rs_code(), lib_rs_code());
    for name in ["PREVIOUS_TAB_ITEM_ID", "NEXT_TAB_ITEM_ID"] {
        let count = combined.matches(name).count();
        assert!(
            count >= 3,
            "{name} must be declared, bound to a MenuItem and dispatched (found {count} occurrence(s) across menu.rs + lib.rs)"
        );
    }
}

// ---------------------------------------------------------------------------
// AC-62-13 — タブの見出し(契約8)
// ---------------------------------------------------------------------------

/// 25. 文書があればそのファイル名。
#[test]
fn tab_title_is_the_document_file_name() {
    assert_eq!(
        derive_tab_title(Some("file:///a/notes"), Some("file:///a/notes/plan.md")),
        "plan.md"
    );
}

/// 26. 文書が無ければ窓タイトルと同じ(root フォルダ名・root も無ければ "vellis")。
#[test]
fn tab_title_without_document_equals_window_title() {
    assert_eq!(derive_tab_title(Some("file:///a/notes"), None), "notes");
    assert_eq!(
        derive_tab_title(Some("file:///a/notes"), None),
        derive_window_title(Some("file:///a/notes"))
    );
    assert_eq!(derive_tab_title(None, None), "vellis");
    assert_eq!(derive_tab_title(None, None), derive_window_title(None));
}

/// 27. ssh の authority(user@host:port)は見出しに出ない(文書あり・なしとも)。
#[test]
fn tab_title_never_leaks_the_ssh_authority() {
    assert_eq!(
        derive_tab_title(
            Some("ssh://user@host:2222/home/user/notes"),
            Some("ssh://user@host:2222/home/user/notes/plan.md")
        ),
        "plan.md"
    );
    assert_eq!(
        derive_tab_title(Some("ssh://user@host:2222/home/user/notes"), None),
        "notes"
    );
}

/// 28. 見出しは空にならない(文書 URI が `/` で終わる等の境界でも root 側へ落ちる)。
#[test]
fn tab_title_is_never_empty() {
    assert!(!derive_tab_title(Some("file:///a/notes"), Some("file:///a/notes/")).is_empty());
    assert!(!derive_tab_title(Some("file:///"), Some("file:///")).is_empty());
    assert!(!derive_tab_title(None, Some("")).is_empty());
}

// ---------------------------------------------------------------------------
// AC-62-14 — 不変(契約11): Cargo.toml の [dependencies]・objc2 の置き場・Cargo.lock
// ---------------------------------------------------------------------------

/// Cargo.toml を節ごとに分ける: (節の見出し, 本文)。見出し行 `[…]` から次の見出しまで。
fn cargo_toml_sections() -> Vec<(String, String)> {
    let src = read_source("Cargo.toml");
    let mut sections: Vec<(String, String)> = Vec::new();
    let mut current: Option<(String, String)> = None;
    for line in src.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if let Some(done) = current.take() {
                sections.push(done);
            }
            current = Some((trimmed.to_string(), String::new()));
        } else if let Some((_, body)) = current.as_mut() {
            body.push_str(line);
            body.push('\n');
        }
    }
    if let Some(done) = current.take() {
        sections.push(done);
    }
    sections
}

/// 節本文の `name = …` 行からクレート名を集める(コメント行は除く)。
fn crate_names(body: &str) -> BTreeSet<String> {
    body.lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .filter_map(|l| {
            let (name, _) = l.split_once('=')?;
            let name = name.trim();
            (!name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
            .then(|| name.to_string())
        })
        .collect()
}

const MACOS_DEPENDENCIES_SECTION: &str = "[target.'cfg(target_os = \"macos\")'.dependencies]";

/// 29. `[dependencies]` 節のクレート集合が登録時点(2026-09-23)と同一。
///     open-in-new-window / go-to-path / model-obj / model-ply の acceptance と同じ固定。
#[test]
fn cargo_dependencies_section_is_unchanged() {
    let sections = cargo_toml_sections();
    let (_, body) = sections
        .iter()
        .find(|(h, _)| h == "[dependencies]")
        .expect("Cargo.toml must have a [dependencies] section");
    let expected: BTreeSet<String> = [
        "tauri",
        "tauri-plugin-opener",
        "serde",
        "serde_json",
        "clap",
        "thiserror",
        "tokio",
        "async-trait",
        "notify",
        "libc",
        "tracing",
        "tracing-subscriber",
        "mime_guess",
        "http",
        "percent-encoding",
        "tauri-plugin-dialog",
        "reqwest",
        "russh",
        "russh-sftp",
        "bytes",
        "dirs",
        "ulid",
        "chrono",
        "strsim",
        "sha2",
        "similar",
        "hidapi",
        "toml",
        "tauri-plugin-webdriver",
        "tauri-plugin-window-state",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    assert_eq!(crate_names(body), expected, "[dependencies] must not gain or lose crates (契約11)");
}

/// 30. `objc2` / `objc2-app-kit` は macOS 専用の target 節に**だけ**現れる
///     (起案時判断 (i)=2026-09-23 由谷承認)。他の節([dependencies] /
///     [dev-dependencies] / [build-dependencies] など)には無い。
#[test]
fn objc2_crates_live_only_in_the_macos_target_section() {
    let sections = cargo_toml_sections();
    let macos: BTreeSet<String> = sections
        .iter()
        .find(|(h, _)| h == MACOS_DEPENDENCIES_SECTION)
        .map(|(_, body)| crate_names(body))
        .unwrap_or_else(|| panic!("Cargo.toml must declare {MACOS_DEPENDENCIES_SECTION}"));
    for name in ["objc2", "objc2-app-kit"] {
        assert!(
            macos.contains(name),
            "{name} must be declared in {MACOS_DEPENDENCIES_SECTION} (found: {macos:?})"
        );
        for (heading, body) in &sections {
            if heading == MACOS_DEPENDENCIES_SECTION {
                continue;
            }
            assert!(
                !crate_names(body).contains(name),
                "{name} must not appear in {heading} — only in the macOS target section"
            );
        }
    }
}

/// 31. Cargo.lock の `[[package]]` の名前集合が登録時点と同一=直接宣言で新しい
///     パッケージが増えていない(objc2 系は tao / wry 経由で既にツリーにある)。
#[test]
fn cargo_lock_package_set_is_unchanged() {
    let lock = read_source("Cargo.lock");
    let mut in_package = false;
    let mut actual: BTreeSet<String> = BTreeSet::new();
    for line in lock.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_package = trimmed == "[[package]]";
            continue;
        }
        if in_package {
            if let Some(rest) = trimmed.strip_prefix("name = ") {
                actual.insert(rest.trim_matches('"').to_string());
            }
        }
    }
    let expected: BTreeSet<String> = LOCKED_PACKAGES.iter().map(|s| s.to_string()).collect();
    assert_eq!(
        expected.len(),
        LOCKED_PACKAGES.len(),
        "the pinned package list must not contain duplicates"
    );
    let added: Vec<_> = actual.difference(&expected).collect();
    let removed: Vec<_> = expected.difference(&actual).collect();
    assert!(
        added.is_empty() && removed.is_empty(),
        "Cargo.lock package set changed — added: {added:?}, removed: {removed:?} (契約11・起案時判断 (i))"
    );
}

/// 登録時点(2026-09-23・main 79aae03)の Cargo.lock の `[[package]]` 名(重複除去・
/// 609 件)。ハッシュではなく全名で持つ=差分が出たとき何が増えたか読めるように。
const LOCKED_PACKAGES: &[&str] = &[
    "adler2",
    "aead",
    "aes-gcm",
    "aes",
    "ahash",
    "aho-corasick",
    "alloc-no-stdlib",
    "alloc-stdlib",
    "android_system_properties",
    "anstream",
    "anstyle-parse",
    "anstyle-query",
    "anstyle-wincon",
    "anstyle",
    "anyhow",
    "argon2",
    "async-broadcast",
    "async-channel",
    "async-executor",
    "async-io",
    "async-lock",
    "async-process",
    "async-recursion",
    "async-signal",
    "async-task",
    "async-trait",
    "atk-sys",
    "atk",
    "atomic-waker",
    "autocfg",
    "aws-lc-rs",
    "aws-lc-sys",
    "axum-core",
    "axum",
    "base16ct",
    "base64",
    "base64ct",
    "bcrypt-pbkdf",
    "bit-set",
    "bit-vec",
    "bitflags",
    "blake2",
    "block-buffer",
    "block-padding",
    "block2",
    "blocking",
    "blowfish",
    "brotli-decompressor",
    "brotli",
    "bstr",
    "bumpalo",
    "bytemuck",
    "byteorder",
    "bytes",
    "cairo-rs",
    "cairo-sys-rs",
    "camino",
    "cargo_metadata",
    "cargo_toml",
    "cargo-platform",
    "cbc",
    "cc",
    "cesu8",
    "cfb",
    "cfg_aliases",
    "cfg-expr",
    "cfg-if",
    "chacha20",
    "chrono",
    "cipher",
    "clap_builder",
    "clap_derive",
    "clap_lex",
    "clap",
    "cmake",
    "colorchoice",
    "combine",
    "concurrent-queue",
    "const-oid",
    "const-random-macro",
    "const-random",
    "convert_case",
    "cookie",
    "core-foundation-sys",
    "core-foundation",
    "core-graphics-types",
    "core-graphics",
    "cpufeatures",
    "crc32fast",
    "crossbeam-channel",
    "crossbeam-utils",
    "crunchy",
    "crypto-bigint",
    "crypto-common",
    "cssparser-macros",
    "cssparser",
    "ctor",
    "ctr",
    "curve25519-dalek-derive",
    "curve25519-dalek",
    "darling_core",
    "darling_macro",
    "darling",
    "data-encoding",
    "delegate",
    "der",
    "deranged",
    "derive_more-impl",
    "derive_more",
    "digest",
    "dirs-sys",
    "dirs",
    "dispatch2",
    "displaydoc",
    "dlopen2_derive",
    "dlopen2",
    "dom_query",
    "dpi",
    "dtoa-short",
    "dtoa",
    "dunce",
    "dyn-clone",
    "ecdsa",
    "ed25519-dalek",
    "ed25519",
    "elliptic-curve",
    "embed_plist",
    "embed-resource",
    "endi",
    "enum_dispatch",
    "enumflags2_derive",
    "enumflags2",
    "equivalent",
    "erased-serde",
    "errno",
    "event-listener-strategy",
    "event-listener",
    "fastrand",
    "fdeflate",
    "ff",
    "fiat-crypto",
    "field-offset",
    "filetime",
    "find-msvc-tools",
    "flate2",
    "flurry",
    "fnv",
    "foldhash",
    "foreign-types-macros",
    "foreign-types-shared",
    "foreign-types",
    "form_urlencoded",
    "fs_extra",
    "fsevent-sys",
    "futf",
    "futures-channel",
    "futures-core",
    "futures-executor",
    "futures-io",
    "futures-lite",
    "futures-macro",
    "futures-sink",
    "futures-task",
    "futures-util",
    "futures",
    "fxhash",
    "gdk-pixbuf-sys",
    "gdk-pixbuf",
    "gdk-sys",
    "gdk",
    "gdkwayland-sys",
    "gdkx11-sys",
    "gdkx11",
    "generic-array",
    "getrandom",
    "ghash",
    "gio-sys",
    "gio",
    "glib-macros",
    "glib-sys",
    "glib",
    "glob",
    "gobject-sys",
    "group",
    "gtk-sys",
    "gtk",
    "gtk3-macros",
    "hashbrown",
    "heck",
    "hermit-abi",
    "hex-literal",
    "hex",
    "hidapi",
    "hkdf",
    "hmac",
    "home",
    "html5ever",
    "http-body-util",
    "http-body",
    "http",
    "httparse",
    "httpdate",
    "hybrid-array",
    "hyper-rustls",
    "hyper-util",
    "hyper",
    "iana-time-zone-haiku",
    "iana-time-zone",
    "ico",
    "icu_collections",
    "icu_locale_core",
    "icu_normalizer_data",
    "icu_normalizer",
    "icu_properties_data",
    "icu_properties",
    "icu_provider",
    "id-arena",
    "ident_case",
    "idna_adapter",
    "idna",
    "indexmap",
    "infer",
    "inotify-sys",
    "inotify",
    "inout",
    "instant",
    "internal-russh-forked-ssh-key",
    "ipnet",
    "iri-string",
    "is_terminal_polyfill",
    "is-docker",
    "is-wsl",
    "itoa",
    "javascriptcore-rs-sys",
    "javascriptcore-rs",
    "jni-sys-macros",
    "jni-sys",
    "jni",
    "jobserver",
    "js-sys",
    "json-patch",
    "jsonptr",
    "keyboard-types",
    "kqueue-sys",
    "kqueue",
    "kuchikiki",
    "lazy_static",
    "leb128fmt",
    "libappindicator-sys",
    "libappindicator",
    "libc",
    "libloading",
    "libm",
    "libredox",
    "linux-raw-sys",
    "litemap",
    "lock_api",
    "log",
    "lru-slab",
    "mac",
    "markup5ever",
    "match_token",
    "matchers",
    "matches",
    "matchit",
    "md5",
    "memchr",
    "memoffset",
    "mime_guess",
    "mime",
    "miniz_oxide",
    "mio",
    "muda",
    "ndk-context",
    "ndk-sys",
    "ndk",
    "new_debug_unreachable",
    "nix",
    "nodrop",
    "notify-types",
    "notify",
    "nu-ansi-term",
    "num_cpus",
    "num_enum_derive",
    "num_enum",
    "num-bigint-dig",
    "num-bigint",
    "num-conv",
    "num-integer",
    "num-iter",
    "num-traits",
    "objc2-app-kit",
    "objc2-cloud-kit",
    "objc2-core-data",
    "objc2-core-foundation",
    "objc2-core-graphics",
    "objc2-core-image",
    "objc2-core-text",
    "objc2-core-video",
    "objc2-encode",
    "objc2-exception-helper",
    "objc2-foundation",
    "objc2-io-surface",
    "objc2-javascript-core",
    "objc2-quartz-core",
    "objc2-security",
    "objc2-ui-kit",
    "objc2-web-kit",
    "objc2",
    "once_cell_polyfill",
    "once_cell",
    "opaque-debug",
    "open",
    "openssl-probe",
    "option-ext",
    "ordered-stream",
    "p256",
    "p384",
    "p521",
    "pageant",
    "pango-sys",
    "pango",
    "parking_lot_core",
    "parking_lot",
    "parking",
    "password-hash",
    "pathdiff",
    "pbkdf2",
    "pem-rfc7468",
    "percent-encoding",
    "phf_codegen",
    "phf_generator",
    "phf_macros",
    "phf_shared",
    "phf",
    "pin-project-lite",
    "piper",
    "pkcs1",
    "pkcs5",
    "pkcs8",
    "pkg-config",
    "plain",
    "plist",
    "png",
    "polling",
    "poly1305",
    "polyval",
    "potential_utf",
    "powerfmt",
    "ppv-lite86",
    "precomputed-hash",
    "prettyplease",
    "primeorder",
    "proc-macro-crate",
    "proc-macro-error-attr",
    "proc-macro-error",
    "proc-macro-hack",
    "proc-macro2",
    "quick-xml",
    "quinn-proto",
    "quinn-udp",
    "quinn",
    "quote",
    "r-efi",
    "rand_chacha",
    "rand_core",
    "rand_hc",
    "rand_pcg",
    "rand",
    "raw-window-handle",
    "redox_syscall",
    "redox_users",
    "ref-cast-impl",
    "ref-cast",
    "regex-automata",
    "regex-syntax",
    "regex",
    "reqwest",
    "rfc6979",
    "rfd",
    "ring",
    "rsa",
    "russh-cryptovec",
    "russh-sftp",
    "russh-util",
    "russh",
    "rustc_version",
    "rustc-hash",
    "rustix",
    "rustls-native-certs",
    "rustls-pki-types",
    "rustls-platform-verifier-android",
    "rustls-platform-verifier",
    "rustls-webpki",
    "rustls",
    "rustversion",
    "ryu",
    "salsa20",
    "same-file",
    "schannel",
    "schemars_derive",
    "schemars",
    "scopeguard",
    "scrypt",
    "sec1",
    "security-framework-sys",
    "security-framework",
    "seize",
    "selectors",
    "semver",
    "serde_core",
    "serde_derive_internals",
    "serde_derive",
    "serde_json",
    "serde_path_to_error",
    "serde_repr",
    "serde_spanned",
    "serde_urlencoded",
    "serde_with_macros",
    "serde_with",
    "serde-untagged",
    "serde",
    "serialize-to-javascript-impl",
    "serialize-to-javascript",
    "servo_arc",
    "sha1",
    "sha2",
    "sharded-slab",
    "shlex",
    "signal-hook-registry",
    "signature",
    "simd-adler32",
    "similar",
    "siphasher",
    "slab",
    "smallvec",
    "socket2",
    "softbuffer",
    "soup3-sys",
    "soup3",
    "spin",
    "spki",
    "ssh-cipher",
    "ssh-encoding",
    "stable_deref_trait",
    "string_cache_codegen",
    "string_cache",
    "strsim",
    "subtle",
    "swift-rs",
    "syn",
    "sync_wrapper",
    "synstructure",
    "system-deps",
    "tao-macros",
    "tao",
    "target-lexicon",
    "tauri-build",
    "tauri-codegen",
    "tauri-macros",
    "tauri-plugin-dialog",
    "tauri-plugin-fs",
    "tauri-plugin-opener",
    "tauri-plugin-webdriver",
    "tauri-plugin-window-state",
    "tauri-plugin",
    "tauri-runtime-wry",
    "tauri-runtime",
    "tauri-utils",
    "tauri-winres",
    "tauri",
    "tempfile",
    "tendril",
    "thiserror-impl",
    "thiserror",
    "thread_local",
    "time-core",
    "time-macros",
    "time",
    "tiny-keccak",
    "tinystr",
    "tinyvec_macros",
    "tinyvec",
    "tokio-macros",
    "tokio-rustls",
    "tokio-util",
    "tokio",
    "toml_datetime",
    "toml_edit",
    "toml_parser",
    "toml_writer",
    "toml",
    "tower-http",
    "tower-layer",
    "tower-service",
    "tower",
    "tracing-attributes",
    "tracing-core",
    "tracing-log",
    "tracing-subscriber",
    "tracing",
    "tray-icon",
    "try-lock",
    "typeid",
    "typenum",
    "uds_windows",
    "ulid",
    "unic-char-property",
    "unic-char-range",
    "unic-common",
    "unic-ucd-ident",
    "unic-ucd-version",
    "unicase",
    "unicode-ident",
    "unicode-segmentation",
    "unicode-xid",
    "universal-hash",
    "untrusted",
    "url",
    "urlpattern",
    "utf-8",
    "utf8_iter",
    "utf8parse",
    "uuid",
    "valuable",
    "vellis",
    "version_check",
    "version-compare",
    "vswhom-sys",
    "vswhom",
    "walkdir",
    "want",
    "wasi",
    "wasip2",
    "wasip3",
    "wasm-bindgen-futures",
    "wasm-bindgen-macro-support",
    "wasm-bindgen-macro",
    "wasm-bindgen-shared",
    "wasm-bindgen",
    "wasm-encoder",
    "wasm-metadata",
    "wasm-streams",
    "wasmparser",
    "web_atoms",
    "web-sys",
    "web-time",
    "webkit2gtk-sys",
    "webkit2gtk",
    "webpki-root-certs",
    "webview2-com-macros",
    "webview2-com-sys",
    "webview2-com",
    "winapi-i686-pc-windows-gnu",
    "winapi-util",
    "winapi-x86_64-pc-windows-gnu",
    "winapi",
    "window-vibrancy",
    "windows_aarch64_gnullvm",
    "windows_aarch64_msvc",
    "windows_i686_gnu",
    "windows_i686_gnullvm",
    "windows_i686_msvc",
    "windows_x86_64_gnu",
    "windows_x86_64_gnullvm",
    "windows_x86_64_msvc",
    "windows-collections",
    "windows-core",
    "windows-future",
    "windows-implement",
    "windows-interface",
    "windows-link",
    "windows-numerics",
    "windows-result",
    "windows-strings",
    "windows-sys",
    "windows-targets",
    "windows-threading",
    "windows-version",
    "windows",
    "winnow",
    "winreg",
    "wit-bindgen-core",
    "wit-bindgen-rust-macro",
    "wit-bindgen-rust",
    "wit-bindgen",
    "wit-component",
    "wit-parser",
    "writeable",
    "wry",
    "x11-dl",
    "x11",
    "yoke-derive",
    "yoke",
    "zbus_macros",
    "zbus_names",
    "zbus",
    "zerocopy-derive",
    "zerocopy",
    "zerofrom-derive",
    "zerofrom",
    "zeroize",
    "zerotrie",
    "zerovec-derive",
    "zerovec",
    "zmij",
    "zvariant_derive",
    "zvariant_utils",
    "zvariant",
];
