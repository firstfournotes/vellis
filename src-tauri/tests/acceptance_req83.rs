//! 要件#83 の受け入れテスト(docs/requirements/req-83.md)— Rust 層
//! (AC-83-1〜13=契約 3・6・7・9・10・11・12・16。メニュー・配線・置き場・履歴・見つからない判定・走査・command)
//!
//! 「起動時の画面を Dashboard にし、Bookmarks・Recent Folders・Recently Modified を載せて、Go ▸ Dashboard で
//! いつでも開けるようにする」のうち `src-tauri` に足すものを判定する。メニューと配線は**ソースをテキストとして
//! 読んで**判定し(acceptance_req80.rs と同じ作り)、置き場・履歴・走査は一時フォルダの上で本物を呼ぶ。
//! 新しいモジュール(`bookmarks`・`dashboard`)の API を `use` するので、実装前はこのファイルはコンパイルできない
//! =赤の理由は「未実装」(acceptance_req3.rs と同じ)。
//!
//! 判定範囲:
//! - AC-83-1 Go の定数(契約 3)【(a) 決定】
//! - AC-83-2 Go の並び(契約 3・ソース走査)【(v) 決定】
//! - AC-83-3 配線(契約 3・ソース走査)
//! - AC-83-4 アクセラレータの衝突なし(契約 3)
//! - AC-83-5 フロントとの一致(契約 3・9・12・16)
//! - AC-83-6 Bookmark の置き場(契約 7・9)【(g)(ad) 決定】
//! - AC-83-7 履歴から外す(契約 10)
//! - AC-83-8 見つからない判定(契約 6・10)
//! - AC-83-9 走査の対象(契約 11)【(i)(k) 決定】
//! - AC-83-10 走査の中身(契約 11・12)【(j)(m)(ai) 決定】
//! - AC-83-11 打ち切りと途中の知らせ(契約 12)【(l)(aj) 決定】
//! - AC-83-12 開ける種類の鏡(契約 11)【(j) 決定】
//! - AC-83-13 command(契約 16)【(ao) 決定】
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前。推奨名は req-83.md のもの・無いものは test-writer が固定)
//!
//! ```ignore
//! // --- src-tauri/src/menu.rs
//! pub const DASHBOARD_ITEM_ID: &str = "dashboard";
//! pub const MENU_DASHBOARD_EVENT: &str = "menu_dashboard";
//! pub const DASHBOARD_ACCELERATOR: &str = "CmdOrCtrl+Shift+H";
//! // Go の組み立て(Go to Path…・Recent Files・区切り線・Dashboard)
//! let go_dashboard_sep = PredefinedMenuItem::separator(app)?;
//! let dashboard_item = MenuItem::with_id(app, DASHBOARD_ITEM_ID, "Dashboard", true, Some(DASHBOARD_ACCELERATOR))?;
//! // Submenu::with_items(app, "Go", true, &[&go_to_item, &recent_files_item, &go_dashboard_sep, &dashboard_item])?
//!
//! // --- src-tauri/src/lib.rs の on_menu_event
//! id if id == menu::DASHBOARD_ITEM_ID => {
//!     menu::handle_menu_open_click(app_handle, menu::MENU_DASHBOARD_EVENT);
//! }
//! // generate_handler! の 2 つの一覧: clear_recent_files の直後に
//! //   list_bookmarks, add_bookmark, remove_bookmark, move_bookmark, remove_history_entry, list_missing_paths, scan_recently_modified
//! pub mod bookmarks;
//! pub mod dashboard;
//!
//! // --- src-tauri/src/history.rs
//! pub fn normalize_uri(uri: &str) -> String;                       // 非公開 → pub
//! impl HistoryStore {
//!     /// 正規化して比べて外し、外した後の履歴を返す。無い URI では書かない。
//!     pub fn remove(&self, uri: &str) -> Result<Vec<String>, HistoryError>;
//! }
//!
//! // --- src-tauri/src/bookmarks.rs(新規・history.rs / recent_files.rs と同じ作り)
//! pub const BOOKMARKS_FILENAME: &str = "bookmarks.json";
//! pub const BOOKMARKS_CHANGED_EVENT: &str = "bookmarks_changed";
//! #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
//! #[serde(rename_all = "lowercase")]
//! pub enum BookmarkKind { Folder, File }
//! #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
//! pub struct Bookmark { pub uri: String, pub kind: BookmarkKind }
//! pub struct BookmarkStore { /* 実装自由 */ }
//! impl BookmarkStore {
//!     pub fn new(file: &Path) -> Self;
//!     pub fn list(&self) -> Result<Vec<Bookmark>, BookmarkError>;                        // 無い・壊れた → Ok(空)
//!     pub fn add(&self, uri: &str, kind: BookmarkKind) -> Result<Vec<Bookmark>, BookmarkError>;   // 末尾・重複は足さない
//!     pub fn remove(&self, uri: &str) -> Result<Vec<Bookmark>, BookmarkError>;
//!     pub fn move_to(&self, uri: &str, to: usize) -> Result<Vec<Bookmark>, BookmarkError>;  // 外した後の並びでの位置・範囲外は末尾
//! }
//! // BookmarkError は Debug + Display(thiserror。型名は自由=本テストは unwrap/expect しか使わない)
//!
//! // --- src-tauri/src/dashboard.rs(新規)
//! pub const RECENTLY_MODIFIED_LIMIT: usize = 8;
//! pub const RECENTLY_MODIFIED_BUDGET_MS: u64 = 2000;
//! pub const RECENTLY_MODIFIED_PROGRESS_EVENT: &str = "recently_modified_progress";
//! /// `src/lib/file-type.ts` の BINARY_EXTENSIONS の鏡(小文字)。
//! pub const UNOPENABLE_EXTENSIONS: &[&str] = &[ … ];
//! /// local で NotFound の URI を入力の順に。ssh は返さない。同期(stat だけ)。
//! pub fn missing_paths(uris: &[String]) -> Vec<String>;
//! /// 履歴の local のフォルダ(履歴の順)→ Bookmark の local のフォルダ(Bookmark の順)。正規化して重複を除く。I/O なし。
//! pub fn scan_targets(history: &[String], bookmarks: &[Bookmark]) -> Vec<String>;
//! #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
//! pub struct ModifiedFile { pub uri: String, pub folder: String, pub modified: i64 }   // modified = ミリ秒
//! #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
//! pub struct RecentlyModifiedScan { pub generation: u64, pub files: Vec<ModifiedFile>, pub folders: usize, pub truncated: bool }
//! /// 走査の本体(command `scan_recently_modified` はこれを呼ぶ)。`provider` は `list` を数えられるよう注入。
//! /// `on_progress` には上位 8 件が変わるたびの一覧(同じ形)を渡す。budget を使い切ったら truncated: true。
//! pub async fn scan_recently_modified_in(
//!     provider: &dyn FileProvider,
//!     generation: u64,
//!     targets: &[String],
//!     settings: &Settings,
//!     budget: Duration,
//!     on_progress: &mut (dyn FnMut(&RecentlyModifiedScan) + Send),
//! ) -> RecentlyModifiedScan;
//!
//! // --- src-tauri/src/commands/bookmarks.rs(新規)・commands/dashboard.rs(新規)・commands/history.rs
//! #[tauri::command] pub async fn list_bookmarks(app: AppHandle) -> Result<Vec<Bookmark>, String>;
//! #[tauri::command] pub async fn add_bookmark(app: AppHandle, uri: String, kind: String) -> Result<Vec<Bookmark>, String>;
//! #[tauri::command] pub async fn remove_bookmark(app: AppHandle, uri: String) -> Result<Vec<Bookmark>, String>;
//! #[tauri::command] pub async fn move_bookmark(app: AppHandle, uri: String, to: usize) -> Result<Vec<Bookmark>, String>;
//! #[tauri::command] pub async fn remove_history_entry(app: AppHandle, uri: String) -> Result<Vec<String>, String>;
//! #[tauri::command] pub async fn list_missing_paths(uris: Vec<String>) -> Result<Vec<String>, String>;
//! #[tauri::command] pub async fn scan_recently_modified(window: Window, …, generation: u64) -> Result<RecentlyModifiedScan, String>;
//!
//! // --- src/lib/dashboard.ts / src/lib/bookmarks.ts(フロントの正本は dashboard.acceptance.test.ts / bookmarks.acceptance.test.ts)
//! export const MENU_DASHBOARD_EVENT = 'menu_dashboard';
//! export const DASHBOARD_LABEL = 'Dashboard';
//! export const RECENTLY_MODIFIED_PROGRESS_EVENT = 'recently_modified_progress';
//! export const SCAN_RECENTLY_MODIFIED_COMMAND = 'scan_recently_modified';
//! export const REMOVE_HISTORY_ENTRY_COMMAND = 'remove_history_entry';
//! export const LIST_MISSING_PATHS_COMMAND = 'list_missing_paths';
//! export const BOOKMARKS_CHANGED_EVENT = 'bookmarks_changed';
//! export const LIST_BOOKMARKS_COMMAND = 'list_bookmarks';
//! export const ADD_BOOKMARK_COMMAND = 'add_bookmark';
//! export const REMOVE_BOOKMARK_COMMAND = 'remove_bookmark';
//! export const MOVE_BOOKMARK_COMMAND = 'move_bookmark';
//! ```
//!
//! ソース走査が前提にする形(acceptance_req80.rs と同じ読み方): MenuItem は `let <binding> = MenuItem::with_id(app, <ID 定数>,
//! "<ラベル>", true, Some(<ACCELERATOR 定数>))?;`・区切り線は `let <binding> = PredefinedMenuItem::separator(app)?;`・
//! Go は `Submenu::with_items(app, "Go", true, &[…])?`・`on_menu_event` の分岐は `id if id == menu::<ID 定数> => { … }`。
//!
//! ## 判断の記録(test-writer 2026-11-05)
//! - 走査の `list` の回数(AC-83-10 の 6・8・除外したフォルダに降りない)は、`LocalProvider` を包んで `list` の URI を
//!   記録する `CountingProvider` で数える。そのため `scan_recently_modified_in` は provider を引数に取る形で固定した
//!   (req-83.md の推奨の 4 引数に provider と generation を足した)
//! - 更新日時は `std::fs::File::set_modified`(Rust 1.75 以降の std・本機は 1.95)で秒単位に作る。依存は足さない
//! - command の並びは契約 16 の表(= AC-83-13)の順で固定する。承認 2 の `go-to-path.acceptance.test.ts` の書き換えも
//!   同じ順にそろえた(承認 2 の本文は `remove_history_entry` を先頭に書いているが、契約 16 と AC-83-13 を正とした
//!   =報告で由谷に確かめる)
//!
//! 人間ゲート(ネイティブの Go メニューと Shift + Command + H の効き・大きなフォルダでの 2 秒の体感)は判定しない。

use std::collections::BTreeSet;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use muda::accelerator::Accelerator;
use tempfile::TempDir;
use tokio::sync::mpsc;

use vellis_lib::bookmarks::{Bookmark, BookmarkKind, BookmarkStore, BOOKMARKS_CHANGED_EVENT, BOOKMARKS_FILENAME};
use vellis_lib::dashboard::{
    missing_paths, scan_recently_modified_in, scan_targets, ModifiedFile, RecentlyModifiedScan,
    RECENTLY_MODIFIED_BUDGET_MS, RECENTLY_MODIFIED_LIMIT, RECENTLY_MODIFIED_PROGRESS_EVENT,
    UNOPENABLE_EXTENSIONS,
};
use vellis_lib::errors::FsError;
use vellis_lib::fs::entry::Entry;
use vellis_lib::fs::local::LocalProvider;
use vellis_lib::fs::provider::{FileProvider, WatchEvent, WatchHandle};
use vellis_lib::fs::uri::Uri;
use vellis_lib::history::{normalize_uri, HistoryStore};
use vellis_lib::menu::{
    DASHBOARD_ACCELERATOR, DASHBOARD_ITEM_ID, MENU_DASHBOARD_EVENT, RECENT_FILES_ACCELERATOR,
};
use vellis_lib::settings::{ExcludeMap, Settings};

// ---------------------------------------------------------------------------
// 共通ヘルパ — acceptance_req80.rs と同じ流儀(コメント落とし・括弧の対応)
// ---------------------------------------------------------------------------

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// 無いファイルは空文字(=その上のアサートが赤になる。`include_str!` と違ってコンパイルは止めない)。
fn read_source_or_empty(rel: &str) -> String {
    fs::read_to_string(manifest_dir().join(rel)).unwrap_or_default()
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

fn dashboard_ts() -> String {
    read_source_or_empty("../src/lib/dashboard.ts")
}

fn bookmarks_ts() -> String {
    read_source_or_empty("../src/lib/bookmarks.ts")
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
    inner
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .last()
        .expect("call must have an argument")
}

/// 呼び出し `f(a, b, …)` の引数列(前後の空白を落としたテキスト)。
fn arguments(call: &str) -> Vec<&str> {
    let open = call.find('(').expect("call must have '('");
    let inner = &call[open + 1..call.len() - 1];
    inner.split(',').map(str::trim).filter(|s| !s.is_empty()).collect()
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

/// すべての `Submenu::with_…` 呼び出し(ラベル, 呼び出し全体)。
fn all_submenu_calls(code: &str) -> Vec<(&str, &str)> {
    let mut out = Vec::new();
    let mut search = 0;
    while let Some(rel) = code[search..].find("Submenu::with_") {
        let start = search + rel;
        let call = balanced_call(code, start);
        search = start + "Submenu::with_".len();
        out.push((first_string_literal(call).unwrap_or(""), call));
    }
    out
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

/// `lib.rs` の `on_menu_event(|app_handle, event| match … { … })` の本体。
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

/// `export const NAME = '…'` の文字列リテラルの中身(`'` / `"` / `` ` `` のどれでも)=acceptance_req66.rs の写し。
fn ts_string_const(src: &str, file: &str, name: &str) -> String {
    let marker = format!("export const {name}");
    let at = src
        .find(&marker)
        .unwrap_or_else(|| panic!("{file} must `{marker}` (AC-83-5)"));
    let rest = &src[at + marker.len()..];
    let eq = rest.find('=').expect("`=` after the const name");
    let after = rest[eq + 1..].trim_start();
    let quote = after.chars().next().expect("a quoted string");
    assert!(
        quote == '\'' || quote == '"' || quote == '`',
        "{name} must be a string literal, got {after:?}"
    );
    let body = &after[quote.len_utf8()..];
    let end = body.find(quote).expect("closing quote");
    body[..end].to_string()
}

/// 空白を全部落とす(呼び出しの字面を改行・インデントに左右されずに比べる)。
fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

/// `generate_handler![ … ]` の 2 つの一覧(`::` の最後の名前だけ)=acceptance_req66.rs の `tauri_commands_are_not_added` と同じ読み方。
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

/// 契約 16 の表の順(= `clear_recent_files` の直後に並ぶ 7 本)。
const NEW_COMMANDS: [&str; 7] = [
    "list_bookmarks",
    "add_bookmark",
    "remove_bookmark",
    "move_bookmark",
    "remove_history_entry",
    "list_missing_paths",
    "scan_recently_modified",
];

const EXPECTED_GO: [&str; 4] = ["go_to_item", "recent_files_item", "go_dashboard_sep", "dashboard_item"];

// ---------------------------------------------------------------------------
// AC-83-1 — Go の定数(契約 3)【(a) 決定】
// ---------------------------------------------------------------------------

/// 1. 3 つの定数は値固定(ID・イベント名・アクセラレータ)。`pub const … = "…"` の字面でも、`use` した値でも同じ。
#[test]
fn dashboard_constants_are_fixed() {
    assert_eq!(DASHBOARD_ITEM_ID, "dashboard");
    assert_eq!(MENU_DASHBOARD_EVENT, "menu_dashboard");
    assert_eq!(DASHBOARD_ACCELERATOR, "CmdOrCtrl+Shift+H");
    let code = menu_rs_code();
    assert_eq!(str_const(&code, "DASHBOARD_ITEM_ID"), Some("dashboard"));
    assert_eq!(str_const(&code, "MENU_DASHBOARD_EVENT"), Some("menu_dashboard"));
    assert_eq!(str_const(&code, "DASHBOARD_ACCELERATOR"), Some("CmdOrCtrl+Shift+H"));
}

/// 2. アクセラレータは muda が parse でき、Shift + Command + H そのもの。
#[test]
fn dashboard_accelerator_parses_as_shift_command_h() {
    let parsed = Accelerator::from_str(DASHBOARD_ACCELERATOR)
        .unwrap_or_else(|e| panic!("DASHBOARD_ACCELERATOR {DASHBOARD_ACCELERATOR:?} must parse: {e}"));
    assert_eq!(parsed, Accelerator::from_str("CmdOrCtrl+Shift+H").expect("CmdOrCtrl+Shift+H parses"));
    assert_ne!(
        parsed,
        Accelerator::from_str(RECENT_FILES_ACCELERATOR).expect("RECENT_FILES_ACCELERATOR parses"),
        "Shift + Command + H must differ from Recent Files"
    );
}

// ---------------------------------------------------------------------------
// AC-83-2 — Go の並び(契約 3・ソース走査)【(v) 決定】
// ---------------------------------------------------------------------------

/// 3. Go = Go to Path… / Recent Files / ─ / Dashboard(4 項目・束縛名まで一致)。`go_dashboard_sep` は区切り線の束縛。
#[test]
fn go_menu_holds_dashboard_behind_a_separator_after_recent_files() {
    let code = menu_rs_code();
    let go = submenu_call_with_label(&code, "Go").expect("menu.rs must build a \"Go\" submenu");
    let idents = submenu_item_idents(go);
    assert_eq!(
        idents, EXPECTED_GO,
        "the Go menu must hold exactly these 4 entries in this order (requirement #83 契約 3, (v)): found {idents:?}"
    );
    let separators = separator_bindings(&code);
    assert!(
        separators.contains("go_dashboard_sep"),
        "`go_dashboard_sep` must be a `PredefinedMenuItem::separator` binding (separators: {separators:?})"
    );
}

/// 4. `dashboard_item` は `MenuItem::with_id(app, DASHBOARD_ITEM_ID, "Dashboard", true, Some(DASHBOARD_ACCELERATOR))` で作る。
#[test]
fn dashboard_item_is_built_from_the_constants_with_the_english_label() {
    let code = menu_rs_code();
    let call = menu_item_call_using(&code, "DASHBOARD_ITEM_ID")
        .expect("menu.rs must build a MenuItem::with_id(... DASHBOARD_ITEM_ID ...)");
    let use_pos = call.as_ptr() as usize - code.as_ptr() as usize;
    let binding = let_binding_before(&code, use_pos, "DASHBOARD_ITEM_ID");
    assert_eq!(binding, "dashboard_item", "the Dashboard item must be bound as `dashboard_item`");

    let args = arguments(call);
    assert_eq!(args.len(), 5, "MenuItem::with_id takes 5 arguments: {call}");
    assert_eq!(args[1], "DASHBOARD_ITEM_ID", "the ID must be the constant: {call}");
    assert_eq!(first_string_literal(call), Some("Dashboard"), "the label must be \"Dashboard\": {call}");
    assert_eq!(args[2], "\"Dashboard\"", "the label is the 3rd argument (no ellipsis): {call}");
    assert_eq!(args[3], "true", "the item is always enabled (契約 3): {call}");
    assert_eq!(last_argument(call), "Some(DASHBOARD_ACCELERATOR)", "accelerator as Some(DASHBOARD_ACCELERATOR): {call}");
    assert!(
        !call.contains("\"dashboard\"") && !call.contains("\"CmdOrCtrl+Shift+H\""),
        "no inline ID / accelerator literal in the item call: {call}"
    );
}

/// 5. `"Dashboard"` の字面は menu.rs のコードの中に 1 回だけ(項目のラベル)。
#[test]
fn dashboard_label_appears_exactly_once_in_menu_rs() {
    let code = menu_rs_code();
    let literals = menu_rs_string_literals(&code);
    let count = literals.iter().filter(|s| s.as_str() == "Dashboard").count();
    assert_eq!(count, 1, "\"Dashboard\" must appear exactly once in menu.rs code (found {count})");
}

/// 6. ほかのメニュー(Vellis / File / Edit / View / Window)と Appearance は `dashboard_item` も `DASHBOARD_ITEM_ID` も持たない。
///    メニューバーは 6 つのまま(Help なし)。
#[test]
fn other_menus_do_not_hold_dashboard_and_the_bar_stays_six() {
    let code = menu_rs_code();
    let calls = all_submenu_calls(&code);
    let labels: Vec<&str> = calls.iter().map(|(l, _)| *l).collect();
    for expected in ["Vellis", "File", "Edit", "View", "Go", "Window", "Appearance"] {
        assert!(labels.contains(&expected), "menu.rs must build a submenu labelled {expected:?} (found {labels:?})");
    }
    assert!(!labels.contains(&"Help"), "no Help menu (requirement #67)");
    for (label, call) in &calls {
        let idents = submenu_item_idents(call);
        if *label == "Go" {
            assert!(idents.contains(&"dashboard_item"), "the Go submenu holds dashboard_item ({idents:?})");
            continue;
        }
        assert!(!idents.contains(&"dashboard_item"), "the {label:?} submenu must not hold dashboard_item ({idents:?})");
        assert!(!call.contains("DASHBOARD_ITEM_ID"), "the {label:?} submenu must not mention DASHBOARD_ITEM_ID");
    }

    // メニューバー= `Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu, &go_menu, &window_menu])`。
    let bar_start = code.find("Menu::with_items(").expect("menu.rs must build the menu bar with Menu::with_items(");
    let bar = balanced_call(&code, bar_start);
    let bar_idents = submenu_item_idents(bar);
    assert_eq!(
        bar_idents,
        ["app_menu", "file_menu", "edit_menu", "view_menu", "go_menu", "window_menu"],
        "the menu bar stays Vellis / File / Edit / View / Go / Window (契約 18)"
    );
}

// ---------------------------------------------------------------------------
// AC-83-3 — 配線(契約 3・ソース走査)
// ---------------------------------------------------------------------------

/// 7. `lib.rs` の `on_menu_event` に `menu::DASHBOARD_ITEM_ID` の腕があり、
///    `menu::handle_menu_open_click(app_handle, menu::MENU_DASHBOARD_EVENT)` を呼ぶ(前面の文書の窓へ `emit_to`)。
#[test]
fn lib_rs_dispatches_dashboard_to_the_focused_document_window() {
    let lib = lib_rs_code();
    let block = on_menu_event_block(&lib);
    let body = menu_arm_body(block, "DASHBOARD_ITEM_ID");
    assert!(
        squash(body).contains("menu::handle_menu_open_click(app_handle,menu::MENU_DASHBOARD_EVENT)"),
        "the DASHBOARD_ITEM_ID arm must call menu::handle_menu_open_click(app_handle, menu::MENU_DASHBOARD_EVENT) ({body})"
    );
    assert_eq!(block.matches("menu::DASHBOARD_ITEM_ID").count(), 1, "on_menu_event must dispatch DASHBOARD_ITEM_ID exactly once");
}

// ---------------------------------------------------------------------------
// AC-83-4 — アクセラレータの衝突なし(契約 3)
// ---------------------------------------------------------------------------

/// 8. menu.rs のアクセラレータの字面のうち Shift + Command + H と同じ組み合わせはちょうど 1 つ。全体に重複が無い。
#[test]
fn shift_command_h_is_registered_exactly_once_and_does_not_collide() {
    let code = menu_rs_code();
    let parsed: Vec<(String, Accelerator)> = menu_rs_string_literals(&code)
        .into_iter()
        .filter(|s| s.contains('+'))
        .filter_map(|s| Accelerator::from_str(&s).ok().map(|a| (s, a)))
        .collect();

    let target = Accelerator::from_str("CmdOrCtrl+Shift+H").expect("CmdOrCtrl+Shift+H parses");
    let count = parsed.iter().filter(|(_, a)| *a == target).count();
    assert_eq!(
        count, 1,
        "menu.rs must register Shift + Command + H exactly once (found {count}; literals: {:?})",
        parsed.iter().map(|(s, _)| s).collect::<Vec<_>>()
    );

    for (i, (raw_a, acc_a)) in parsed.iter().enumerate() {
        for (raw_b, acc_b) in parsed.iter().skip(i + 1) {
            assert!(acc_a != acc_b, "duplicate accelerator in menu.rs: '{raw_a}' collides with '{raw_b}'");
        }
    }
}

// ---------------------------------------------------------------------------
// AC-83-5 — フロントとの一致(契約 3・9・12・16)
// ---------------------------------------------------------------------------

/// 9. `src/lib/dashboard.ts` の定数は Rust の定数・`"Dashboard"`・command の関数名と一致する。
#[test]
fn dashboard_ts_constants_match_rust() {
    let ts = dashboard_ts();
    assert!(!ts.is_empty(), "src/lib/dashboard.ts must exist (契約 3・12・16)");
    let file = "src/lib/dashboard.ts";
    assert_eq!(ts_string_const(&ts, file, "MENU_DASHBOARD_EVENT"), MENU_DASHBOARD_EVENT);
    assert_eq!(ts_string_const(&ts, file, "RECENTLY_MODIFIED_PROGRESS_EVENT"), RECENTLY_MODIFIED_PROGRESS_EVENT);
    assert_eq!(RECENTLY_MODIFIED_PROGRESS_EVENT, "recently_modified_progress");

    let code = menu_rs_code();
    let call = menu_item_call_using(&code, "DASHBOARD_ITEM_ID").expect("menu.rs builds the Dashboard item");
    let rust_label = first_string_literal(call).expect("the item call has a label literal");
    assert_eq!(ts_string_const(&ts, file, "DASHBOARD_LABEL"), rust_label);
    assert_eq!(rust_label, "Dashboard");

    for (ts_name, command) in [
        ("SCAN_RECENTLY_MODIFIED_COMMAND", "scan_recently_modified"),
        ("REMOVE_HISTORY_ENTRY_COMMAND", "remove_history_entry"),
        ("LIST_MISSING_PATHS_COMMAND", "list_missing_paths"),
    ] {
        assert_eq!(ts_string_const(&ts, file, ts_name), command);
        assert_command_fn_exists(command);
    }
}

/// 10. `src/lib/bookmarks.ts` の定数は Rust の `BOOKMARKS_CHANGED_EVENT` と command の関数名と一致する。
#[test]
fn bookmarks_ts_constants_match_rust() {
    let ts = bookmarks_ts();
    assert!(!ts.is_empty(), "src/lib/bookmarks.ts must exist (契約 9・16)");
    let file = "src/lib/bookmarks.ts";
    assert_eq!(ts_string_const(&ts, file, "BOOKMARKS_CHANGED_EVENT"), BOOKMARKS_CHANGED_EVENT);
    assert_eq!(BOOKMARKS_CHANGED_EVENT, "bookmarks_changed");
    for (ts_name, command) in [
        ("LIST_BOOKMARKS_COMMAND", "list_bookmarks"),
        ("ADD_BOOKMARK_COMMAND", "add_bookmark"),
        ("REMOVE_BOOKMARK_COMMAND", "remove_bookmark"),
        ("MOVE_BOOKMARK_COMMAND", "move_bookmark"),
    ] {
        assert_eq!(ts_string_const(&ts, file, ts_name), command);
        assert_command_fn_exists(command);
    }
}

/// `src/commands/*.rs` のどれかに `#[tauri::command]` 付きの `fn <name>(` がある。
fn assert_command_fn_exists(name: &str) {
    let dir = manifest_dir().join("src/commands");
    let mut found = false;
    for entry in fs::read_dir(&dir).expect("src/commands exists") {
        let path = entry.expect("dir entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let src = strip_line_comments(&fs::read_to_string(&path).unwrap_or_default());
        let needle_async = format!("pub async fn {name}(");
        let needle_sync = format!("pub fn {name}(");
        if let Some(pos) = src.find(&needle_async).or_else(|| src.find(&needle_sync)) {
            let before = &src[..pos];
            let attr = before.rfind("#[tauri::command]").unwrap_or(0);
            let between = &before[attr..];
            assert!(
                before.contains("#[tauri::command]") && !between.contains("fn "),
                "{name} in {} must be a #[tauri::command]",
                path.display()
            );
            found = true;
        }
    }
    assert!(found, "src/commands/*.rs must define the Tauri command `{name}` (契約 16)");
}

// ---------------------------------------------------------------------------
// AC-83-6 — Bookmark の置き場(契約 7・9)【(g) 決定・(ad) 決定】
// ---------------------------------------------------------------------------

fn bookmarks_path(tmp: &TempDir) -> PathBuf {
    tmp.path().join(BOOKMARKS_FILENAME)
}

fn bm(uri: &str, kind: BookmarkKind) -> Bookmark {
    Bookmark { uri: uri.to_string(), kind }
}

fn uris(list: &[Bookmark]) -> Vec<&str> {
    list.iter().map(|b| b.uri.as_str()).collect()
}

fn mtime(path: &Path) -> SystemTime {
    fs::metadata(path).expect("file exists").modified().expect("mtime")
}

/// 1. ファイルが無い → 空。壊れた JSON・形の違う JSON → 空(エラーにしない)。
#[test]
fn bookmark_store_reads_missing_and_broken_files_as_empty() {
    let tmp = TempDir::new().unwrap();
    let store = BookmarkStore::new(&bookmarks_path(&tmp));
    assert!(store.list().expect("missing file is not an error").is_empty());

    let nested = tmp.path().join("no-such-dir").join(BOOKMARKS_FILENAME);
    assert!(BookmarkStore::new(&nested).list().expect("missing parent dir is not an error").is_empty());

    fs::write(bookmarks_path(&tmp), "this is not json {{{").unwrap();
    assert!(store.list().expect("broken JSON is not an error").is_empty());

    fs::write(bookmarks_path(&tmp), r#"["file:///a/b", "file:///c"]"#).unwrap();
    assert!(store.list().expect("a JSON of the wrong shape is not an error").is_empty());

    fs::write(bookmarks_path(&tmp), r#"{"uri":"file:///a","kind":"folder"}"#).unwrap();
    assert!(store.list().expect("an object instead of an array is not an error").is_empty());
}

/// 2. `add` は末尾に足す。書いた JSON は `[{"uri":…,"kind":"folder"},{"uri":…,"kind":"file"}]` の形。
///    書いた後に `bookmarks.json.tmp` が残らない。
#[test]
fn bookmark_store_add_appends_and_writes_the_contract_json_atomically() {
    let tmp = TempDir::new().unwrap();
    let path = bookmarks_path(&tmp);
    let store = BookmarkStore::new(&path);

    let after_first = store.add("file:///Users/a/docs", BookmarkKind::Folder).unwrap();
    assert_eq!(after_first, vec![bm("file:///Users/a/docs", BookmarkKind::Folder)]);
    let after_second = store.add("file:///Users/a/docs/plan.md", BookmarkKind::File).unwrap();
    assert_eq!(
        after_second,
        vec![bm("file:///Users/a/docs", BookmarkKind::Folder), bm("file:///Users/a/docs/plan.md", BookmarkKind::File)],
        "add appends at the tail (ad)"
    );
    assert_eq!(store.list().unwrap(), after_second, "list reads back what add returned");

    let raw = fs::read_to_string(&path).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).expect("bookmarks.json is JSON");
    assert_eq!(
        parsed,
        serde_json::json!([
            { "uri": "file:///Users/a/docs", "kind": "folder" },
            { "uri": "file:///Users/a/docs/plan.md", "kind": "file" }
        ]),
        "on-disk shape (契約 9)"
    );
    assert!(!path.with_extension("json.tmp").exists(), "no bookmarks.json.tmp is left behind");
    let leftovers: Vec<_> = fs::read_dir(tmp.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n != BOOKMARKS_FILENAME)
        .collect();
    assert!(leftovers.is_empty(), "only bookmarks.json in the folder: {leftovers:?}");

    // 別のインスタンスでも同じ(永続化)。
    assert_eq!(BookmarkStore::new(&path).list().unwrap(), after_second);
}

/// 3. 同じ URI(`file:///a/b/`・`file:///a//b`・`file:///a/b`)は 2 つ目を足さず、位置も変えない。保存は正規化した綴り。
#[test]
fn bookmark_store_dedupes_by_normalized_uri_and_stores_the_normalized_spelling() {
    let tmp = TempDir::new().unwrap();
    let store = BookmarkStore::new(&bookmarks_path(&tmp));

    store.add("file:///a/b/", BookmarkKind::Folder).unwrap();
    store.add("file:///c", BookmarkKind::Folder).unwrap();
    let list = store.add("file:///a//b", BookmarkKind::Folder).unwrap();
    assert_eq!(uris(&list), ["file:///a/b", "file:///c"], "the same folder is not added twice and keeps its place");
    let list = store.add("file:///a/b", BookmarkKind::File).unwrap();
    assert_eq!(uris(&list), ["file:///a/b", "file:///c"], "the kind does not make it a different bookmark");
    assert_eq!(list[0].kind, BookmarkKind::Folder, "the first entry keeps its kind");

    for (raw, expected) in [
        ("file:///a/b/", "file:///a/b"),
        ("file:///a//b", "file:///a/b"),
        ("file:///a/b", "file:///a/b"),
        ("ssh://host", "ssh://host/"),
        ("ssh://alice@host:22/srv/notes/", "ssh://alice@host:22/srv/notes"),
        ("file:///", "file:///"),
    ] {
        assert_eq!(normalize_uri(raw), expected, "history::normalize_uri({raw:?}) is pub and unchanged");
    }
    let raw = fs::read_to_string(bookmarks_path(&tmp)).unwrap();
    assert!(raw.contains("\"file:///a/b\""), "the normalized spelling is what is written: {raw}");
    assert!(!raw.contains("file:///a/b/\"") && !raw.contains("file:///a//b"), "raw spellings are not written: {raw}");
}

/// 4. `remove` は正規化して比べて外す。無い URI では書かない(更新日時が変わらない)。
#[test]
fn bookmark_store_remove_compares_normalized_and_does_not_write_for_a_missing_uri() {
    let tmp = TempDir::new().unwrap();
    let path = bookmarks_path(&tmp);
    let store = BookmarkStore::new(&path);
    store.add("file:///a/b", BookmarkKind::Folder).unwrap();
    store.add("file:///c", BookmarkKind::File).unwrap();
    store.add("file:///d", BookmarkKind::Folder).unwrap();

    let list = store.remove("file:///c/").unwrap();
    assert_eq!(uris(&list), ["file:///a/b", "file:///d"], "removed by normalized comparison; order of the rest kept");
    assert_eq!(store.list().unwrap(), list);

    let old = UNIX_EPOCH + Duration::from_secs(1_600_000_000);
    fs::File::options().write(true).open(&path).unwrap().set_modified(old).unwrap();
    assert_eq!(mtime(&path), old);
    let list = store.remove("file:///nope").unwrap();
    assert_eq!(uris(&list), ["file:///a/b", "file:///d"]);
    assert_eq!(mtime(&path), old, "removing a URI that is not there must not rewrite the file");
}

/// 5. `move_to(uri, to)`: 前へ・後ろへ動く。範囲外の `to` は末尾。同じ位置では書かない。
#[test]
fn bookmark_store_move_to_reorders_and_clamps() {
    let tmp = TempDir::new().unwrap();
    let path = bookmarks_path(&tmp);
    let store = BookmarkStore::new(&path);
    for u in ["file:///a", "file:///b", "file:///c", "file:///d"] {
        store.add(u, BookmarkKind::Folder).unwrap();
    }

    // 後ろへ: a を 2 へ(外した後の並び [b, c, d] の 2 の位置)→ [b, c, a, d]
    let list = store.move_to("file:///a", 2).unwrap();
    assert_eq!(uris(&list), ["file:///b", "file:///c", "file:///a", "file:///d"], "move down");
    // 前へ: d を 0 へ → [d, b, c, a]
    let list = store.move_to("file:///d", 0).unwrap();
    assert_eq!(uris(&list), ["file:///d", "file:///b", "file:///c", "file:///a"], "move up");
    // 範囲外は末尾: b を 99 へ → [d, c, a, b]
    let list = store.move_to("file:///b/", 99).unwrap();
    assert_eq!(uris(&list), ["file:///d", "file:///c", "file:///a", "file:///b"], "out of range lands at the tail (normalized lookup)");
    assert_eq!(store.list().unwrap(), list, "persisted");

    // 同じ位置では書かない。
    let old = UNIX_EPOCH + Duration::from_secs(1_600_000_000);
    fs::File::options().write(true).open(&path).unwrap().set_modified(old).unwrap();
    let list = store.move_to("file:///c", 1).unwrap();
    assert_eq!(uris(&list), ["file:///d", "file:///c", "file:///a", "file:///b"]);
    assert_eq!(mtime(&path), old, "moving to the same position must not rewrite the file");
    // 無い URI でも書かない(並びはそのまま)。
    let list = store.move_to("file:///nope", 0).unwrap();
    assert_eq!(uris(&list), ["file:///d", "file:///c", "file:///a", "file:///b"]);
    assert_eq!(mtime(&path), old, "moving a URI that is not there must not rewrite the file");
}

/// 6. 上限なし(100 件足して 100 件残る)。
#[test]
fn bookmark_store_has_no_cap() {
    let tmp = TempDir::new().unwrap();
    let store = BookmarkStore::new(&bookmarks_path(&tmp));
    let mut last = Vec::new();
    for i in 0..100 {
        last = store.add(&format!("file:///Users/a/folder-{i}"), BookmarkKind::Folder).unwrap();
    }
    assert_eq!(last.len(), 100);
    let list = store.list().unwrap();
    assert_eq!(list.len(), 100, "no cap (ad)");
    assert_eq!(list[0].uri, "file:///Users/a/folder-0");
    assert_eq!(list[99].uri, "file:///Users/a/folder-99");
}

/// 7. 8 スレッドから同時に別の URI を `add` → 8 件とも残る(書き込みの錠)。
#[test]
fn bookmark_store_serializes_concurrent_adds() {
    let tmp = TempDir::new().unwrap();
    let path = bookmarks_path(&tmp);
    std::thread::scope(|scope| {
        for i in 0..8 {
            let path = path.clone();
            scope.spawn(move || {
                let store = BookmarkStore::new(&path);
                store.add(&format!("file:///Users/a/thread-{i}"), BookmarkKind::Folder).unwrap();
            });
        }
    });
    let list = BookmarkStore::new(&path).list().unwrap();
    let got: BTreeSet<String> = list.iter().map(|b| b.uri.clone()).collect();
    let expected: BTreeSet<String> = (0..8).map(|i| format!("file:///Users/a/thread-{i}")).collect();
    assert_eq!(got, expected, "all 8 concurrent adds survive (write lock)");
    assert_eq!(list.len(), 8);
}

/// 8. `BOOKMARKS_FILENAME == "bookmarks.json"`。
#[test]
fn bookmarks_filename_is_fixed() {
    assert_eq!(BOOKMARKS_FILENAME, "bookmarks.json");
}

// ---------------------------------------------------------------------------
// AC-83-7 — 履歴から外す(契約 10)
// ---------------------------------------------------------------------------

/// 9. `HistoryStore::remove(uri)` は正規化して外し、ほかの順は保つ。無い URI では書かない。`add` / `list` は今のまま。
#[test]
fn history_store_remove_drops_the_normalized_entry_and_keeps_the_rest() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("history.json");
    let store = HistoryStore::new(&path);
    store.add("file:///Users/a/docs").unwrap();
    store.add("file:///Users/a/notes").unwrap();
    store.add("file:///Users/a/work").unwrap();
    assert_eq!(store.list().unwrap(), ["file:///Users/a/work", "file:///Users/a/notes", "file:///Users/a/docs"]);

    let after = store.remove("file:///Users/a/notes/").unwrap();
    assert_eq!(after, ["file:///Users/a/work", "file:///Users/a/docs"], "removed by normalized comparison; order kept");
    assert_eq!(store.list().unwrap(), after, "persisted");
    let parsed: Vec<String> = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(parsed, after, "history.json keeps its shape (an array of strings)");

    let old = UNIX_EPOCH + Duration::from_secs(1_600_000_000);
    fs::File::options().write(true).open(&path).unwrap().set_modified(old).unwrap();
    let after = store.remove("file:///Users/a/nope").unwrap();
    assert_eq!(after, ["file:///Users/a/work", "file:///Users/a/docs"]);
    assert_eq!(mtime(&path), old, "removing a URI that is not there must not rewrite history.json");

    // add はそのまま(先頭へ・重複なし)。
    store.add("file:///Users/a/docs").unwrap();
    assert_eq!(store.list().unwrap(), ["file:///Users/a/docs", "file:///Users/a/work"]);
}

// ---------------------------------------------------------------------------
// AC-83-8 — 見つからない判定(契約 6・10)
// ---------------------------------------------------------------------------

fn file_uri(path: &Path) -> String {
    format!("file://{}", path.display())
}

/// 10. `dashboard::missing_paths(&uris)` は消したフォルダとファイル(local)を入力の順に返し、あるものと ssh は返さない。
#[test]
fn missing_paths_returns_local_not_found_in_input_order() {
    let tmp = TempDir::new().unwrap();
    let present_dir = tmp.path().join("present");
    fs::create_dir(&present_dir).unwrap();
    let present_file = tmp.path().join("present.md");
    fs::write(&present_file, "x").unwrap();
    let gone_dir = tmp.path().join("gone-dir");
    fs::create_dir(&gone_dir).unwrap();
    fs::remove_dir(&gone_dir).unwrap();
    let gone_file = tmp.path().join("gone.md");

    let input = vec![
        "ssh://alice@host:22/srv/nowhere".to_string(),
        file_uri(&gone_file),
        file_uri(&present_dir),
        file_uri(&gone_dir),
        file_uri(&present_file),
        "ssh://host/also/nowhere".to_string(),
    ];
    let missing = missing_paths(&input);
    assert_eq!(missing, vec![file_uri(&gone_file), file_uri(&gone_dir)], "only local NotFound, in input order");

    assert!(missing_paths(&[]).is_empty());
    assert!(missing_paths(&[file_uri(&present_dir)]).is_empty());
}

// ---------------------------------------------------------------------------
// AC-83-9 — 走査の対象(契約 11)【(i)(k) 決定】
// ---------------------------------------------------------------------------

/// 11. `scan_targets(&history, &bookmarks)` = 履歴の local のフォルダ(履歴の順)→ Bookmark の local のフォルダ(Bookmark の順)。
///     ssh・ファイルの Bookmark を除き、正規化して重複を除く。
#[test]
fn scan_targets_are_history_then_bookmark_folders_local_only_deduped() {
    let history = vec![
        "file:///Users/a/work".to_string(),
        "ssh://alice@host:22/srv/notes".to_string(),
        "file:///Users/a/docs/".to_string(),
        "file:///Users/a/work".to_string(),
    ];
    let bookmarks = vec![
        bm("file:///Users/a/docs", BookmarkKind::Folder),
        bm("file:///Users/a/docs/plan.md", BookmarkKind::File),
        bm("ssh://host/srv/pinned", BookmarkKind::Folder),
        bm("file:///Users/a/pinned//deep/", BookmarkKind::Folder),
        bm("file:///Users/a/other.md", BookmarkKind::File),
    ];
    let targets = scan_targets(&history, &bookmarks);
    let normalized: Vec<String> = targets.iter().map(|t| normalize_uri(t)).collect();
    assert_eq!(
        normalized,
        ["file:///Users/a/work", "file:///Users/a/docs", "file:///Users/a/pinned/deep"],
        "history folders first (history order), then bookmark folders (bookmark order); ssh and files left out; duplicates removed: {targets:?}"
    );
    assert_eq!(targets.len(), 3);
    assert!(targets.iter().all(|t| t.starts_with("file://")), "no ssh target (k)");

    assert!(scan_targets(&[], &[]).is_empty());
    assert!(scan_targets(&["ssh://host/x".to_string()], &[bm("ssh://host/y", BookmarkKind::Folder)]).is_empty());
}

// ---------------------------------------------------------------------------
// AC-83-10 / 11 — 走査の中身・打ち切り(契約 11・12)【(j)(m)(ai)(l)(aj) 決定】
// ---------------------------------------------------------------------------

/// `LocalProvider` を包んで `list` の URI を記録する(数えるため)。ほかはそのまま委譲。
struct CountingProvider {
    inner: LocalProvider,
    lists: Mutex<Vec<String>>,
}

impl CountingProvider {
    fn new() -> Self {
        Self { inner: LocalProvider::new(), lists: Mutex::new(Vec::new()) }
    }

    fn lists(&self) -> Vec<String> {
        self.lists.lock().unwrap().clone()
    }

    fn list_count(&self, dir: &Path) -> usize {
        let key = dir.to_string_lossy().to_string();
        self.lists().iter().filter(|p| **p == key).count()
    }
}

#[async_trait]
impl FileProvider for CountingProvider {
    fn scheme(&self) -> &'static str {
        "file"
    }

    async fn list(&self, uri: &Uri) -> Result<Vec<Entry>, FsError> {
        self.lists.lock().unwrap().push(uri.path.to_string_lossy().to_string());
        self.inner.list(uri).await
    }

    async fn stat(&self, uri: &Uri) -> Result<Entry, FsError> {
        self.inner.stat(uri).await
    }

    async fn read_bytes(&self, uri: &Uri) -> Result<Vec<u8>, FsError> {
        self.inner.read_bytes(uri).await
    }

    async fn watch(&self, uri: &Uri, tx: mpsc::Sender<WatchEvent>) -> Result<WatchHandle, FsError> {
        self.inner.watch(uri, tx).await
    }
}

/// `secs` 秒(エポック)の更新日時のファイルを作る(中身は名前)。
fn touch_at(path: &Path, secs: u64) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, path.file_name().unwrap().to_string_lossy().as_bytes()).unwrap();
    let f = fs::File::options().write(true).open(path).unwrap();
    f.set_modified(UNIX_EPOCH + Duration::from_secs(secs)).unwrap();
}

const T0: u64 = 1_700_000_000;

fn ms(secs: u64) -> i64 {
    (secs as i64) * 1000
}

fn settings_with(files_exclude: &[&str], search_exclude: &[&str]) -> Settings {
    let mut s = Settings::default();
    let mut fe: ExcludeMap = s.files_exclude.clone();
    for p in files_exclude {
        fe.insert((*p).to_string(), true);
    }
    let mut se: ExcludeMap = s.search_exclude.clone();
    for p in search_exclude {
        se.insert((*p).to_string(), true);
    }
    s.files_exclude = fe;
    s.search_exclude = se;
    s
}

async fn scan(provider: &CountingProvider, targets: &[String], settings: &Settings, budget: Duration) -> (RecentlyModifiedScan, Vec<RecentlyModifiedScan>) {
    let mut progress = Vec::new();
    let result = scan_recently_modified_in(provider, 7, targets, settings, budget, &mut |p: &RecentlyModifiedScan| {
        progress.push(p.clone());
    })
    .await;
    (result, progress)
}

const GENEROUS: Duration = Duration::from_secs(30);

fn file_uris(files: &[ModifiedFile]) -> Vec<&str> {
    files.iter().map(|f| f.uri.as_str()).collect()
}

/// 12. (1) 上位 8 件・更新日時の新しい順・同じ日時は URI の順。`modified` はミリ秒。(7) `folders` は読めた対象の数。
#[tokio::test]
async fn scan_returns_the_newest_eight_sorted_by_modified_then_uri_in_milliseconds() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("root");
    fs::create_dir(&root).unwrap();
    // 10 件: f0 が一番古い … f9 が一番新しい。f3 と f4 は同じ日時(URI の順= f3 が先)。
    for i in 0..10u64 {
        let secs = if i == 4 { T0 + 3 } else { T0 + i };
        touch_at(&root.join(format!("f{i}.md")), secs);
    }
    let provider = CountingProvider::new();
    let (result, _) = scan(&provider, &[file_uri(&root)], &Settings::default(), GENEROUS).await;

    assert_eq!(result.generation, 7, "the generation is handed back as given");
    assert!(!result.truncated);
    assert_eq!(result.folders, 1, "one readable target");
    assert_eq!(result.files.len(), RECENTLY_MODIFIED_LIMIT, "the top 8 only");
    let expected: Vec<String> = ["f9", "f8", "f7", "f6", "f5", "f3", "f4", "f2"]
        .iter()
        .map(|n| file_uri(&root.join(format!("{n}.md"))))
        .collect();
    assert_eq!(file_uris(&result.files), expected.iter().map(String::as_str).collect::<Vec<_>>(), "newest first; ties by URI");
    assert_eq!(result.files[0].modified, ms(T0 + 9), "modified is Unix epoch milliseconds");
    assert_eq!(result.files[5].modified, ms(T0 + 3));
    assert_eq!(result.files[6].modified, ms(T0 + 3));
    for f in &result.files {
        assert_eq!(f.folder, file_uri(&root), "the origin folder is the target the file was found under");
    }
}

/// 13. (2) 開けない種類(`a.zip`・`b.docx`・`c.sqlite`)は載らない。`a.md`・`b.png`・`c.mp4`・`d.pdf`・`e.rs`・`Makefile` は載る。
#[tokio::test]
async fn scan_lists_only_openable_kinds() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("root");
    fs::create_dir(&root).unwrap();
    // 開けないものを一番新しくしておく(落ちたのが「上位 8 件から溢れた」のではないことを確かめる)。
    for (i, name) in ["a.zip", "b.docx", "c.sqlite"].iter().enumerate() {
        touch_at(&root.join(name), T0 + 100 + i as u64);
    }
    for (i, name) in ["a.md", "b.png", "c.mp4", "d.pdf", "e.rs", "Makefile"].iter().enumerate() {
        touch_at(&root.join(name), T0 + i as u64);
    }
    let provider = CountingProvider::new();
    let (result, _) = scan(&provider, &[file_uri(&root)], &Settings::default(), GENEROUS).await;
    let names: BTreeSet<String> = result
        .files
        .iter()
        .map(|f| f.uri.rsplit('/').next().unwrap().to_string())
        .collect();
    let expected: BTreeSet<String> = ["a.md", "b.png", "c.mp4", "d.pdf", "e.rs", "Makefile"].iter().map(|s| s.to_string()).collect();
    assert_eq!(names, expected, "only the kinds Vellis can open (j)");
}

/// 14. (3) 既定の設定で `.` 始まりの名前は載らない。注入した `files.exclude` の `**/drafts`・`search.exclude` の既定
///     (`node_modules`・`target`)・注入した `search.exclude` の `**/out` が当たる。除外したフォルダには降りない(list しない)。
///     (4) `x.md.vellis-tmp`(組み込みの除外)は載らない。
#[tokio::test]
async fn scan_applies_files_exclude_search_exclude_and_the_builtin_exclusion_without_descending() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("root");
    fs::create_dir(&root).unwrap();
    // 除外されるものを全部「一番新しく」しておく。
    touch_at(&root.join(".hidden.md"), T0 + 200);
    touch_at(&root.join(".cache").join("x.md"), T0 + 201);
    touch_at(&root.join("drafts").join("x.md"), T0 + 202);
    touch_at(&root.join("node_modules").join("x.md"), T0 + 203);
    touch_at(&root.join("target").join("x.md"), T0 + 204);
    touch_at(&root.join("out").join("x.md"), T0 + 205);
    touch_at(&root.join("x.md.vellis-tmp"), T0 + 206);
    // 載るもの。
    touch_at(&root.join("keep.md"), T0 + 1);
    touch_at(&root.join("sub").join("keep2.md"), T0 + 2);

    let settings = settings_with(&["**/drafts"], &["**/out"]);
    let provider = CountingProvider::new();
    let (result, _) = scan(&provider, &[file_uri(&root)], &settings, GENEROUS).await;

    let got: Vec<String> = result.files.iter().map(|f| f.uri.clone()).collect();
    assert_eq!(
        got,
        vec![file_uri(&root.join("sub/keep2.md")), file_uri(&root.join("keep.md"))],
        "only keep2.md and keep.md survive the exclusions: {got:?}"
    );
    for dir in [".cache", "drafts", "node_modules", "target", "out"] {
        assert_eq!(provider.list_count(&root.join(dir)), 0, "an excluded folder ({dir}) is not listed (no descent)");
    }
    assert_eq!(provider.list_count(&root.join("sub")), 1, "sub is listed once");
}

/// 15. (5) シンボリックリンク(ファイルへ・フォルダへ)は辿らず載せない。
#[tokio::test]
async fn scan_does_not_follow_symlinks() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("root");
    fs::create_dir(&root).unwrap();
    let outside = tmp.path().join("outside");
    touch_at(&outside.join("newest.md"), T0 + 300);
    touch_at(&outside.join("deep").join("newer.md"), T0 + 301);
    let real = root.join("real.md");
    touch_at(&real, T0 + 1);
    symlink(&outside.join("newest.md"), root.join("link-to-file.md")).unwrap();
    symlink(&outside, root.join("link-to-dir")).unwrap();

    let provider = CountingProvider::new();
    let (result, _) = scan(&provider, &[file_uri(&root)], &Settings::default(), GENEROUS).await;
    assert_eq!(file_uris(&result.files), [file_uri(&real).as_str()], "neither the linked file nor the linked folder's files: {:?}", result.files);
    assert_eq!(provider.list_count(&root.join("link-to-dir")), 0, "a folder link is not listed");
    assert_eq!(provider.list_count(&outside), 0);
}

/// 16. (6) 対象 A と A の下の B → B の下のファイルは 1 回だけ載り、`folder` は B。B の中の `list` は 1 回。
///     `folders` は 2(読めた対象の数)。
#[tokio::test]
async fn scan_reads_an_overlapping_target_once_as_the_deepest_target() {
    let tmp = TempDir::new().unwrap();
    let a = tmp.path().join("a");
    let b = a.join("b");
    touch_at(&a.join("a1.md"), T0 + 1);
    touch_at(&b.join("b1.md"), T0 + 2);
    touch_at(&b.join("c").join("c1.md"), T0 + 3);

    let provider = CountingProvider::new();
    let (result, _) = scan(&provider, &[file_uri(&a), file_uri(&b)], &Settings::default(), GENEROUS).await;

    assert_eq!(result.folders, 2, "both targets were read");
    assert_eq!(
        file_uris(&result.files),
        [file_uri(&b.join("c/c1.md")).as_str(), file_uri(&b.join("b1.md")).as_str(), file_uri(&a.join("a1.md")).as_str()],
        "each file once: {:?}",
        result.files
    );
    let by_uri = |u: &str| result.files.iter().find(|f| f.uri == u).map(|f| f.folder.clone());
    assert_eq!(by_uri(&file_uri(&b.join("b1.md"))), Some(file_uri(&b)), "files under B belong to B (the deepest target)");
    assert_eq!(by_uri(&file_uri(&b.join("c/c1.md"))), Some(file_uri(&b)));
    assert_eq!(by_uri(&file_uri(&a.join("a1.md"))), Some(file_uri(&a)));
    assert_eq!(provider.list_count(&b), 1, "B is listed once");
    assert_eq!(provider.list_count(&a), 1);
    assert_eq!(provider.list_count(&b.join("c")), 1);
}

/// 17. (7) 見つからない対象は黙って飛ばし、`folders` に数えない。(8) ssh の URI が渡っても `list` しない。
#[tokio::test]
async fn scan_skips_missing_targets_silently_and_never_lists_ssh() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("root");
    touch_at(&root.join("one.md"), T0 + 1);
    let gone = tmp.path().join("gone");

    let provider = CountingProvider::new();
    let targets = vec![
        file_uri(&gone),
        "ssh://alice@host:22/srv/notes".to_string(),
        file_uri(&root),
    ];
    let (result, _) = scan(&provider, &targets, &Settings::default(), GENEROUS).await;
    assert_eq!(result.folders, 1, "only the readable target counts");
    assert_eq!(file_uris(&result.files), [file_uri(&root.join("one.md")).as_str()]);
    assert!(!result.truncated);
    assert!(
        provider.lists().iter().all(|p| p.starts_with(&root.to_string_lossy().to_string())),
        "only the readable local target is listed (no ssh, no missing): {:?}",
        provider.lists()
    );

    // ssh だけ → 0 フォルダ・空。
    let provider = CountingProvider::new();
    let (result, _) = scan(&provider, &["ssh://host/srv".to_string()], &Settings::default(), GENEROUS).await;
    assert_eq!(result.folders, 0);
    assert!(result.files.is_empty());
    assert!(provider.lists().is_empty(), "ssh is never listed (k)");
}

/// 18. (9) 何も書かない(対象のフォルダのファイルの集合と更新日時が走査の前後で同じ)。
#[tokio::test]
async fn scan_writes_nothing() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("root");
    touch_at(&root.join("a.md"), T0 + 1);
    touch_at(&root.join("sub").join("b.md"), T0 + 2);
    touch_at(&root.join(".hidden.md"), T0 + 3);

    fn snapshot(dir: &Path, out: &mut Vec<(String, SystemTime)>) {
        for e in fs::read_dir(dir).unwrap() {
            let e = e.unwrap();
            let p = e.path();
            let m = fs::metadata(&p).unwrap();
            out.push((p.to_string_lossy().to_string(), m.modified().unwrap()));
            if m.is_dir() {
                snapshot(&p, out);
            }
        }
        out.sort();
    }
    let mut before = Vec::new();
    snapshot(&root, &mut before);

    let provider = CountingProvider::new();
    let _ = scan(&provider, &[file_uri(&root)], &Settings::default(), GENEROUS).await;

    let mut after = Vec::new();
    snapshot(&root, &mut after);
    assert_eq!(after, before, "the scan must not create, delete or touch anything");
}

/// 19. (AC-83-11) `budget` が 0 → `truncated: true` で返り、例外を出さない。十分な `budget` → `truncated: false`。
///     `on_progress` に渡る一覧はいつも新しい順で 8 件以下・`generation` は同じ。定数の値固定。
#[tokio::test]
async fn scan_truncates_on_a_zero_budget_and_reports_progress_sorted() {
    assert_eq!(RECENTLY_MODIFIED_LIMIT, 8);
    assert_eq!(RECENTLY_MODIFIED_BUDGET_MS, 2000);

    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("root");
    for i in 0..12u64 {
        touch_at(&root.join(format!("d{}", i % 4)).join(format!("f{i}.md")), T0 + i);
    }
    let provider = CountingProvider::new();

    let (zero, _) = scan(&provider, &[file_uri(&root)], &Settings::default(), Duration::ZERO).await;
    assert!(zero.truncated, "a zero budget stops the scan: truncated must be true");
    assert_eq!(zero.generation, 7);
    assert!(zero.files.len() <= RECENTLY_MODIFIED_LIMIT);

    let (full, progress) = scan(&provider, &[file_uri(&root)], &Settings::default(), GENEROUS).await;
    assert!(!full.truncated, "a generous budget finishes: truncated must be false");
    assert_eq!(full.files.len(), RECENTLY_MODIFIED_LIMIT);
    assert_eq!(full.files[0].uri, file_uri(&root.join("d3/f11.md")));
    for p in &progress {
        assert_eq!(p.generation, 7, "progress carries the same generation");
        assert!(p.files.len() <= RECENTLY_MODIFIED_LIMIT, "progress never exceeds 8: {}", p.files.len());
        let mods: Vec<(i64, &str)> = p.files.iter().map(|f| (f.modified, f.uri.as_str())).collect();
        let mut sorted = mods.clone();
        sorted.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));
        assert_eq!(mods, sorted, "progress is always newest first (ties by URI)");
    }
}

// ---------------------------------------------------------------------------
// AC-83-12 — 開ける種類の鏡(契約 11)【(j) 決定】
// ---------------------------------------------------------------------------

const FILE_TYPE_TS: &str = include_str!("../../src/lib/file-type.ts");

/// `const NAME = new Set([ ... ])` の中の単一引用符リテラルを集める(acceptance_req55.rs の写し)。
fn extension_set(name: &str) -> BTreeSet<String> {
    let marker = format!("const {name} = new Set([");
    let start = FILE_TYPE_TS
        .find(&marker)
        .unwrap_or_else(|| panic!("file-type.ts must declare {name}"))
        + marker.len();
    let end = FILE_TYPE_TS[start..].find("])").expect("Set literal must close") + start;
    let body: String = FILE_TYPE_TS[start..end]
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    let mut out = BTreeSet::new();
    let mut rest = body.as_str();
    while let Some(a) = rest.find('\'') {
        let after = &rest[a + 1..];
        let b = after.find('\'').expect("unterminated quote");
        out.insert(after[..b].to_string());
        rest = &after[b + 1..];
    }
    assert!(!out.is_empty(), "{name} must not be empty");
    out
}

/// 20. `dashboard::UNOPENABLE_EXTENSIONS` が `src/lib/file-type.ts` の `BINARY_EXTENSIONS` と集合で一致する(小文字・重複なし)。
#[test]
fn unopenable_extensions_mirror_binary_extensions_of_file_type_ts() {
    let expected = extension_set("BINARY_EXTENSIONS");
    let actual: BTreeSet<String> = UNOPENABLE_EXTENSIONS.iter().map(|s| s.to_string()).collect();
    assert_eq!(actual, expected, "UNOPENABLE_EXTENSIONS must equal BINARY_EXTENSIONS in file-type.ts");
    assert_eq!(UNOPENABLE_EXTENSIONS.len(), expected.len(), "no duplicates");
    for ext in UNOPENABLE_EXTENSIONS {
        assert_eq!(ext.to_lowercase(), **ext, "extensions are stored lowercase: {ext}");
    }
    for must in ["zip", "docx", "sqlite", "tiff", "heic"] {
        assert!(actual.contains(must), "{must} stays unopenable");
    }
    for must_not in ["md", "png", "mp4", "pdf", "rs", "txt", "svg"] {
        assert!(!actual.contains(must_not), "{must_not} is openable");
    }
}

// ---------------------------------------------------------------------------
// AC-83-13 — command(契約 16)【(ao) 決定】
// ---------------------------------------------------------------------------

/// 21. 7 つの command が 2 つの `generate_handler!` にちょうど 1 回ずつ、`clear_recent_files` の直後に契約 16 の表の順で並ぶ。
///     `list_history` は残る。名前に `update`・`banner`・`remember`・`export` を含まず、`search` で始まらない。
#[test]
fn the_seven_commands_follow_clear_recent_files_in_both_handler_lists() {
    let lib = lib_rs_code();
    let blocks = handler_lists(&lib);
    assert_eq!(blocks.len(), 2, "lib.rs has the webdriver and the production handler lists");
    for names in &blocks {
        let at = names
            .iter()
            .position(|n| n == "clear_recent_files")
            .expect("clear_recent_files stays in the list (AC-64)");
        let window: Vec<&str> = names.iter().skip(at + 1).take(NEW_COMMANDS.len()).map(String::as_str).collect();
        assert_eq!(window, NEW_COMMANDS, "right after clear_recent_files, in the order of the 契約 16 table: {names:?}");
        for cmd in NEW_COMMANDS {
            assert_eq!(names.iter().filter(|n| *n == cmd).count(), 1, "{cmd} is registered exactly once");
            assert!(!cmd.contains("update") && !cmd.contains("banner") && !cmd.contains("remember"), "{cmd} (AC-14b)");
            assert!(!cmd.contains("export"), "{cmd} (AC-56 第2段)");
            assert!(!cmd.starts_with("search"), "{cmd} (AC-66)");
        }
        assert!(names.iter().any(|n| n == "list_history"), "list_history stays (AC-64)");
        // Recent Files の 3 つの連続(AC-64 追補f)は保つ。
        let rf = names.iter().position(|n| n == "list_recent_files").expect("list_recent_files stays");
        assert_eq!(&names[rf..rf + 3], ["list_recent_files", "record_displayed_file", "clear_recent_files"]);
    }
    assert!(lib.contains("pub mod bookmarks;"), "lib.rs declares `pub mod bookmarks;`");
    assert!(lib.contains("pub mod dashboard;"), "lib.rs declares `pub mod dashboard;`");
}
