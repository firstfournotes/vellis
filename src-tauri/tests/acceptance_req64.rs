//! 要件#64 の受け入れテスト(docs/requirements/req-64.md)— Rust 層(AC-64-1〜11)
//!
//! 「最近開いたファイルの履歴(Recent Files)。今の root 配下で開いたファイルを新しい順に
//!  最大 10 件出し、クリック一発で開ける」
//!
//! 判定範囲(AC 番号は req-64.md の受け入れ基準):
//! - AC-64-1  記録の規則(`add` → `list` が新しい順・同じ URI は先頭へ移り重複しない)(契約3)
//! - AC-64-2  全体の上限 `MAX_RECENT_FILES == 100`・101 件目で最古が落ちる(契約3)
//! - AC-64-3  無い / 壊れた / 文字列配列でないファイルは空・次の `add` で書き直す・親ディレクトリを
//!   作る・`*.tmp` を残さない(契約3)
//! - AC-64-4  フォルダの履歴(`history.rs` / `history.json`)と別で、そちらは触らない(契約3・12)
//! - AC-64-5  `is_under_root(uri, root)` の表(契約4)
//! - AC-64-6  `RECENT_FILES_SHOWN == 10`・`list_under_root` は root 配下だけ新しい順で最大 10 件・
//!   別 root の新しい記録に押し出されない(契約4)
//! - AC-64-7  `remove` / `remove_under_root`(契約8・9)
//! - AC-64-8  `should_forget_on_open_error` は `FsError::NotFound` のときだけ true(契約8)
//! - AC-64-9  `commands/document.rs` の `open_in_window` に記録と除去の配線・`save_document` には無い
//!   (ソース走査・契約1・2・8)
//! - AC-64-10 `list_recent_files` / `clear_recent_files` が両方の `generate_handler!` に載る
//!   (ソース走査・契約4・9・11。並びは AC-60-20 側が固定)
//! - AC-64-11 メニュー(定数の値固定・parse・重複なし・Go メニューで Go to Path… の後・File に無い・
//!   lib.rs の dispatch)(契約5)
//!
//! reviewer 照合(機械判定しない): `record_file` / `forget_file` が `record_root` と同じ best-effort
//! であること・Tauri command 本体(`AppHandle` の解決)・`history.rs` が無改変であること
//! (本ファイルは定数と「同じディレクトリの history.json が動かない」ことまでを判定する)。
//! 人間ゲート(通しの記録・ssh・再起動後の持続)は判定しない。
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前・公開パス)
//!
//! ```ignore
//! // --- 新規 src-tauri/src/recent_files.rs(lib.rs に `pub mod recent_files;`)---
//! use crate::errors::FsError;
//!
//! /// 全体の上限(契約3)。超えた分は古い方から落とす。
//! pub const MAX_RECENT_FILES: usize = 100;
//! /// 区画に出す最大件数(契約4)。
//! pub const RECENT_FILES_SHOWN: usize = 10;
//! /// app config dir の中のファイル名(契約3)。`history::HISTORY_FILENAME` とは別。
//! pub const RECENT_FILES_FILENAME: &str = "recent-files.json";
//!
//! /// `history::HistoryStore` と同じ作り: ファイルパスを注入・JSON 配列(先頭=最新)・
//! /// tmp → rename の原子的な書き込み・無い / 壊れたファイルは空。
//! pub struct RecentFilesStore { /* 実装自由 */ }
//! impl RecentFilesStore {
//!     pub fn new(file: &Path) -> Self;                 // 親ディレクトリが無くてもエラーにしない
//!     pub fn list(&self) -> Result<Vec<String>, E>;    // 新しい順。無い / 壊れた = Ok(空)
//!     pub fn add(&self, uri: &str) -> Result<(), E>;   // 完全一致で重複を先頭へ・MAX で切る・即保存
//!     pub fn remove(&self, uri: &str) -> Result<(), E>;            // その URI だけ。無ければ何もしない
//!     pub fn remove_under_root(&self, root: &str) -> Result<(), E>; // root 配下だけ。他は順序ごと残す
//!     pub fn list_under_root(&self, root: &str) -> Result<Vec<String>, E>; // 配下だけ・新しい順・最大 10
//! }   // E: Debug(型は実装自由。本テストは unwrap / expect しか使わない)
//!
//! /// 文字列だけで判定する(契約4): root の末尾の `/` を 1 つ落として `/` を足した前方一致。
//! /// root そのものは配下でない。scheme と authority も文字列に含む。
//! pub fn is_under_root(uri: &str, root: &str) -> bool;
//!
//! /// `FsError::NotFound` のときだけ true(契約8)。
//! pub fn should_forget_on_open_error(err: &FsError) -> bool;
//!
//! /// `history::record_root` と同じ形の best-effort(契約2・8)。失敗はログに残して飲み込む。
//! pub fn record_file<R: tauri::Runtime>(app: &tauri::AppHandle<R>, uri: &str);
//! pub fn forget_file<R: tauri::Runtime>(app: &tauri::AppHandle<R>, uri: &str);
//!
//! // --- src-tauri/src/commands/document.rs の open_in_window(契約2・8)---
//! //   成功後(DocumentSession::open / open_binary の Ok の後)に `recent_files::record_file(&app_handle, &uri)`、
//! //   失敗側で `should_forget_on_open_error` が真のときだけ `recent_files::forget_file(&app_handle, &uri)`。
//! //   `save_document` の中では `recent_files` に触れない。
//!
//! // --- 新規 src-tauri/src/commands/recent_files.rs(両方の generate_handler! に登録。
//! //     並びは `list_history` の直後=AC-60-20 の一覧と一致)---
//! // #[tauri::command] async fn list_recent_files(root: String, app: AppHandle) -> Result<Vec<String>, String>
//! // #[tauri::command] async fn clear_recent_files(root: String, app: AppHandle) -> Result<(), String>
//!
//! // --- src-tauri/src/menu.rs に追加(GO_TO_* と同じ家風)---
//! pub const RECENT_FILES_ITEM_ID: &str = "recent-files";
//! pub const MENU_RECENT_FILES_EVENT: &str = "menu_recent_files";
//! pub const RECENT_FILES_ACCELERATOR: &str = "CmdOrCtrl+Shift+R";
//! // ラベル "Recent Files"(三点リーダ無し)。Go メニューの項目スライスで `&go_to_item` の後
//! // (間に区切り線を挟むのは可・他の項目は挟まない)。File / Edit / View / Window には出さない。
//! // lib.rs: `id if id == menu::RECENT_FILES_ITEM_ID => menu::handle_menu_open_click(app_handle, menu::MENU_RECENT_FILES_EVENT)`
//! ```

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use muda::accelerator::Accelerator;
use tempfile::TempDir;

use vellis_lib::errors::FsError;
use vellis_lib::history::{HistoryStore, HISTORY_FILENAME, MAX_HISTORY};
use vellis_lib::menu::{MENU_RECENT_FILES_EVENT, RECENT_FILES_ACCELERATOR, RECENT_FILES_ITEM_ID};
use vellis_lib::recent_files::{
    is_under_root, should_forget_on_open_error, RecentFilesStore, MAX_RECENT_FILES,
    RECENT_FILES_FILENAME, RECENT_FILES_SHOWN,
};

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/// TempDir 直下の recent-files.json のパス(ファイル自体は作らない)。
fn store_path(tmp: &TempDir) -> PathBuf {
    tmp.path().join(RECENT_FILES_FILENAME)
}

fn s(v: &str) -> String {
    v.to_string()
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

/// ディレクトリ直下のファイル名(`*.tmp` の置き忘れの検査に使う)。
fn file_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

// ---------------------------------------------------------------------------
// AC-64-1 — 記録の規則(契約3)
// ---------------------------------------------------------------------------

/// 1. add した URI が list で新しい順(先頭=最新)に返る。
#[test]
fn add_puts_the_file_at_the_head_and_list_is_most_recent_first() {
    let tmp = TempDir::new().unwrap();
    let store = RecentFilesStore::new(&store_path(&tmp));

    store.add("file:///proj/a.md").unwrap();
    store.add("file:///proj/docs/b.md").unwrap();
    store.add("file:///proj/c.png").unwrap();

    assert_eq!(
        store.list().unwrap(),
        strings(&[
            "file:///proj/c.png",
            "file:///proj/docs/b.md",
            "file:///proj/a.md"
        ]),
        "list must return entries most-recent-first"
    );
}

/// 2. 同じ URI を add し直すと先頭へ移り、件数は増えない(重複しない)。
#[test]
fn re_adding_the_same_uri_moves_it_to_the_head_without_a_duplicate() {
    let tmp = TempDir::new().unwrap();
    let store = RecentFilesStore::new(&store_path(&tmp));
    store.add("file:///proj/a.md").unwrap();
    store.add("file:///proj/b.md").unwrap();
    store.add("file:///proj/c.md").unwrap();

    store.add("file:///proj/a.md").unwrap();

    let entries = store.list().unwrap();
    assert_eq!(entries.len(), 3, "re-adding must not create a duplicate");
    assert_eq!(
        entries,
        strings(&[
            "file:///proj/a.md",
            "file:///proj/c.md",
            "file:///proj/b.md"
        ]),
        "the re-added entry moves to the head; the others keep their relative order"
    );

    // 先頭にあるものを add し直しても何も変わらない(reload の復元=契約1)。
    store.add("file:///proj/a.md").unwrap();
    assert_eq!(store.list().unwrap(), entries);
}

/// 3. 同じ URI の判定は文字列の完全一致(契約3): 大文字小文字・末尾スラッシュ違いは別の記録。
#[test]
fn dedupe_is_exact_string_match() {
    let tmp = TempDir::new().unwrap();
    let store = RecentFilesStore::new(&store_path(&tmp));
    store.add("file:///proj/A.md").unwrap();
    store.add("file:///proj/a.md").unwrap();

    assert_eq!(
        store.list().unwrap(),
        strings(&["file:///proj/a.md", "file:///proj/A.md"]),
        "different spellings are different entries (no normalization)"
    );
}

/// 4. 保存は add のたび(契約3): 別インスタンスを同じパスで作ると同じ一覧が戻る。
#[test]
fn recent_files_persist_across_instances() {
    let tmp = TempDir::new().unwrap();
    let path = store_path(&tmp);
    {
        let first = RecentFilesStore::new(&path);
        first.add("file:///proj/a.md").unwrap();
        first.add("file:///proj/b.md").unwrap();
    }
    let second = RecentFilesStore::new(&path);
    assert_eq!(
        second.list().unwrap(),
        strings(&["file:///proj/b.md", "file:///proj/a.md"])
    );

    second.add("file:///proj/a.md").unwrap();
    let third = RecentFilesStore::new(&path);
    assert_eq!(
        third.list().unwrap(),
        strings(&["file:///proj/a.md", "file:///proj/b.md"])
    );
}

/// 5. ディスク上の形は URI 文字列の JSON 配列・先頭が最新(契約3=history.json と同じ形)。
#[test]
fn on_disk_format_is_a_json_array_of_strings_most_recent_first() {
    let tmp = TempDir::new().unwrap();
    let path = store_path(&tmp);
    let store = RecentFilesStore::new(&path);
    store.add("file:///proj/a.md").unwrap();
    store.add("file:///proj/b.md").unwrap();

    assert!(path.is_file(), "add must persist to the injected file path");
    let raw = fs::read_to_string(&path).unwrap();
    let parsed: Vec<String> =
        serde_json::from_str(&raw).expect("recent-files.json must be a JSON array of strings");
    assert_eq!(parsed, strings(&["file:///proj/b.md", "file:///proj/a.md"]));
}

// ---------------------------------------------------------------------------
// AC-64-2 — 全体の上限(契約3)
// ---------------------------------------------------------------------------

/// 6. `MAX_RECENT_FILES == 100`。101 件目を足すと最古の 1 件が落ち、list は 100 件。
#[test]
fn capacity_is_100_and_the_oldest_drops_at_the_101st() {
    assert_eq!(MAX_RECENT_FILES, 100, "the overall cap is 100 (契約3)");

    let tmp = TempDir::new().unwrap();
    let store = RecentFilesStore::new(&store_path(&tmp));
    for i in 1..=MAX_RECENT_FILES {
        store.add(&format!("file:///proj/f{i}.md")).unwrap();
    }
    assert_eq!(store.list().unwrap().len(), MAX_RECENT_FILES);
    assert!(
        store.list().unwrap().contains(&s("file:///proj/f1.md")),
        "f1 is still there at exactly 100"
    );

    store.add("file:///proj/f101.md").unwrap();

    let entries = store.list().unwrap();
    assert_eq!(
        entries.len(),
        MAX_RECENT_FILES,
        "the list is capped at MAX_RECENT_FILES"
    );
    assert_eq!(
        entries[0], "file:///proj/f101.md",
        "the newest entry is at the head"
    );
    assert!(
        !entries.contains(&s("file:///proj/f1.md")),
        "the oldest entry (f1) must be dropped"
    );
    assert_eq!(
        entries[MAX_RECENT_FILES - 1],
        "file:///proj/f2.md",
        "the surviving tail is f2"
    );

    // 上限到達後の重複繰上げは件数を変えない(落とすのは新規追加のときだけ)。
    store.add("file:///proj/f50.md").unwrap();
    let entries = store.list().unwrap();
    assert_eq!(entries.len(), MAX_RECENT_FILES);
    assert_eq!(entries[0], "file:///proj/f50.md");
    assert!(entries.contains(&s("file:///proj/f2.md")));
}

// ---------------------------------------------------------------------------
// AC-64-3 — 無い / 壊れたファイル(契約3)
// ---------------------------------------------------------------------------

/// 7. ファイルが無ければ list は空(エラーにしない)。親ディレクトリごと無くても同じ。
#[test]
fn missing_file_lists_empty() {
    let tmp = TempDir::new().unwrap();
    let store = RecentFilesStore::new(&store_path(&tmp));
    assert!(store
        .list()
        .expect("missing file must not be an error")
        .is_empty());

    let nested = tmp.path().join("no-such-dir").join(RECENT_FILES_FILENAME);
    let store = RecentFilesStore::new(&nested);
    assert!(store
        .list()
        .expect("missing parent dir must not be an error")
        .is_empty());
}

/// 8. JSON として読めない内容は空(エラーにしない)で、次の add で正しい JSON 配列に書き直される。
#[test]
fn unparseable_json_lists_empty_and_the_next_add_rewrites_a_clean_array() {
    let tmp = TempDir::new().unwrap();
    let path = store_path(&tmp);
    fs::write(&path, "this is not json {{{").unwrap();
    let store = RecentFilesStore::new(&path);

    assert!(store
        .list()
        .expect("corrupted file must not be an error")
        .is_empty());

    store.add("file:///proj/a.md").unwrap();
    assert_eq!(store.list().unwrap(), strings(&["file:///proj/a.md"]));
    let parsed: Vec<String> = serde_json::from_str(&fs::read_to_string(&path).unwrap())
        .expect("the file must be rewritten as a JSON array of strings");
    assert_eq!(parsed, strings(&["file:///proj/a.md"]));
}

/// 9. JSON ではあるが文字列配列でない内容(オブジェクト・数値の配列・文字列・null)も空で、
///    次の add で正しい形に戻る。
#[test]
fn non_string_array_json_lists_empty_and_the_next_add_recovers() {
    for broken in [
        r#"{"uris":["file:///proj/a.md"]}"#,
        "[1, 2, 3]",
        r#""file:///proj/a.md""#,
        "null",
        "{}",
    ] {
        let tmp = TempDir::new().unwrap();
        let path = store_path(&tmp);
        fs::write(&path, broken).unwrap();
        let store = RecentFilesStore::new(&path);

        assert!(
            store
                .list()
                .unwrap_or_else(|e| panic!("{broken}: must not be an error: {e:?}"))
                .is_empty(),
            "{broken}: must be treated as empty"
        );

        store.add("file:///proj/b.md").unwrap();
        assert_eq!(
            store.list().unwrap(),
            strings(&["file:///proj/b.md"]),
            "{broken}"
        );
        let parsed: Vec<String> = serde_json::from_str(&fs::read_to_string(&path).unwrap())
            .unwrap_or_else(|e| panic!("{broken}: rewritten file must parse: {e}"));
        assert_eq!(parsed, strings(&["file:///proj/b.md"]));
    }
}

/// 10. 親ディレクトリが無くても add が作る(初回起動で config dir が無いケース)。
#[test]
fn add_creates_the_missing_parent_directory() {
    let tmp = TempDir::new().unwrap();
    let path = tmp
        .path()
        .join("state")
        .join("deeper")
        .join(RECENT_FILES_FILENAME);
    assert!(!path.parent().unwrap().exists());

    RecentFilesStore::new(&path)
        .add("file:///proj/a.md")
        .unwrap();

    assert!(
        path.is_file(),
        "add must create the parent directories and the file"
    );
    assert_eq!(
        RecentFilesStore::new(&path).list().unwrap(),
        strings(&["file:///proj/a.md"])
    );
}

/// 11. add の後に `*.tmp`(原子的な書き込みの中間ファイル)が残らない。remove の後も同じ。
#[test]
fn add_and_remove_leave_no_tmp_file_behind() {
    let tmp = TempDir::new().unwrap();
    let store = RecentFilesStore::new(&store_path(&tmp));
    store.add("file:///proj/a.md").unwrap();
    store.add("file:///proj/b.md").unwrap();
    assert_eq!(
        file_names(tmp.path()),
        vec![RECENT_FILES_FILENAME.to_string()],
        "only the store file remains after add"
    );

    store.remove("file:///proj/a.md").unwrap();
    store.remove_under_root("file:///proj").unwrap();
    assert_eq!(
        file_names(tmp.path()),
        vec![RECENT_FILES_FILENAME.to_string()],
        "only the store file remains after remove"
    );
}

// ---------------------------------------------------------------------------
// AC-64-4 — フォルダの履歴(要件#3)と別(契約3・12)
// ---------------------------------------------------------------------------

/// 12. ファイル名は `recent-files.json` で `history.json` と違う。フォルダの履歴の定数は不変。
#[test]
fn filename_is_recent_files_json_and_the_folder_history_constants_are_unchanged() {
    assert_eq!(RECENT_FILES_FILENAME, "recent-files.json");
    assert_ne!(RECENT_FILES_FILENAME, HISTORY_FILENAME);
    assert_eq!(
        HISTORY_FILENAME, "history.json",
        "the folder history file name stays (契約12)"
    );
    assert_eq!(
        MAX_HISTORY, 20,
        "the folder history cap stays at 20 (契約12)"
    );
}

/// 13. 同じディレクトリに置いた history.json は、RecentFilesStore への add / remove /
///     remove_under_root の後もバイト単位で変わらない。フォルダの履歴の list も変わらない。
#[test]
fn history_json_in_the_same_directory_is_untouched() {
    let tmp = TempDir::new().unwrap();
    let history_path = tmp.path().join(HISTORY_FILENAME);
    let history = HistoryStore::new(&history_path);
    history.add("file:///Users/a/docs").unwrap();
    history.add("file:///Users/a/work").unwrap();
    let before_bytes = fs::read(&history_path).unwrap();
    let before_list = history.list().unwrap();

    let store = RecentFilesStore::new(&store_path(&tmp));
    store.add("file:///Users/a/work/plan.md").unwrap();
    store.add("file:///Users/a/docs/x.md").unwrap();
    store.remove("file:///Users/a/docs/x.md").unwrap();
    store.remove_under_root("file:///Users/a/work").unwrap();
    store.add("file:///Users/a/work/again.md").unwrap();

    assert_eq!(
        fs::read(&history_path).unwrap(),
        before_bytes,
        "history.json must not change byte for byte"
    );
    assert_eq!(
        history.list().unwrap(),
        before_list,
        "the folder history list is unchanged"
    );
    assert_eq!(
        before_list,
        strings(&["file:///Users/a/work", "file:///Users/a/docs"]),
        "and it never contains a file entry"
    );
    assert_eq!(
        store.list().unwrap(),
        strings(&["file:///Users/a/work/again.md"])
    );
}

// ---------------------------------------------------------------------------
// AC-64-5 — root 配下の判定(契約4)
// ---------------------------------------------------------------------------

/// 14. `is_under_root` の表(AC-64-5 の値どおり)。
#[test]
fn is_under_root_table() {
    let cases: [(&str, &str, bool); 11] = [
        ("file:///a/b/c.md", "file:///a/b", true),
        ("file:///a/b/c.md", "file:///a/b/", true),
        ("file:///a/b/x/y/z.md", "file:///a/b", true),
        ("file:///a/bc.md", "file:///a/b", false),
        ("file:///a/b", "file:///a/b", false),
        ("file:///a/c.md", "file:///a/b", false),
        ("file:///x.md", "file:///", true),
        ("ssh://alice@host/repo/x.md", "ssh://alice@host/repo", true),
        ("ssh://bob@host/repo/x.md", "ssh://alice@host/repo", false),
        ("file:///repo/x.md", "ssh://alice@host/repo", false),
        ("ssh://alice@host/repo/x.md", "file:///repo", false),
    ];
    for (uri, root, expected) in cases {
        assert_eq!(
            is_under_root(uri, root),
            expected,
            "is_under_root({uri:?}, {root:?})"
        );
    }
}

/// 15. 端: root に末尾 `/` があっても root そのもの(`/` 無し)は配下でない・空文字は配下でない・
///     root の綴り(末尾 `/` の有無)は判定を変えない。
#[test]
fn is_under_root_edges() {
    assert!(!is_under_root("file:///a/b", "file:///a/b/"));
    assert!(!is_under_root("", "file:///a/b"));
    assert!(
        is_under_root("file:///a/b/c.md", "file:///a/b/")
            && is_under_root("file:///a/b/c.md", "file:///a/b")
    );
    assert!(!is_under_root("file:///a/bc.md", "file:///a/b/"));
}

// 型レベルのシグネチャ固定(ズレをコンパイルエラーにする=acceptance_req48 の家風)。
#[allow(dead_code)]
fn _is_under_root_signature() -> fn(&str, &str) -> bool {
    is_under_root
}

// ---------------------------------------------------------------------------
// AC-64-6 — 絞り込みと件数(契約4)
// ---------------------------------------------------------------------------

/// 16. `RECENT_FILES_SHOWN == 10`。
#[test]
fn recent_files_shown_is_10() {
    assert_eq!(RECENT_FILES_SHOWN, 10);
    assert!(
        RECENT_FILES_SHOWN < MAX_RECENT_FILES,
        "the shown count is a window into the larger store"
    );
}

/// 17. `list_under_root(root)` は root 配下のものだけを新しい順で返し、他の root・root そのものは出さない。
#[test]
fn list_under_root_returns_only_this_root_newest_first() {
    let tmp = TempDir::new().unwrap();
    let store = RecentFilesStore::new(&store_path(&tmp));
    store.add("file:///other/x.md").unwrap();
    store.add("file:///proj/a.md").unwrap();
    store.add("file:///projects/trap.md").unwrap(); // 前方一致の罠
    store.add("file:///proj/docs/b.md").unwrap();
    store.add("file:///proj").unwrap(); // root そのもの(普通は記録されないが、出ないこと)
    store.add("ssh://alice@host/proj/c.md").unwrap();
    store.add("file:///proj/c.md").unwrap();

    assert_eq!(
        store.list_under_root("file:///proj").unwrap(),
        strings(&[
            "file:///proj/c.md",
            "file:///proj/docs/b.md",
            "file:///proj/a.md"
        ]),
    );
    assert_eq!(
        store.list_under_root("file:///proj/").unwrap(),
        strings(&[
            "file:///proj/c.md",
            "file:///proj/docs/b.md",
            "file:///proj/a.md"
        ]),
        "a trailing slash on the root reads the same"
    );
    assert_eq!(
        store.list_under_root("ssh://alice@host/proj").unwrap(),
        strings(&["ssh://alice@host/proj/c.md"])
    );
    assert_eq!(
        store.list_under_root("file:///nowhere").unwrap(),
        Vec::<String>::new()
    );
}

/// 18. 最大 10 件: 配下に 12 件あれば新しい 10 件だけ。
#[test]
fn list_under_root_caps_at_ten_newest() {
    let tmp = TempDir::new().unwrap();
    let store = RecentFilesStore::new(&store_path(&tmp));
    for i in 1..=12 {
        store.add(&format!("file:///proj/f{i}.md")).unwrap();
    }

    let shown = store.list_under_root("file:///proj").unwrap();
    assert_eq!(shown.len(), RECENT_FILES_SHOWN);
    let expected: Vec<String> = (3..=12)
        .rev()
        .map(|i| format!("file:///proj/f{i}.md"))
        .collect();
    assert_eq!(shown, expected, "the ten newest, newest first");
}

/// 19. 別の root の記録が新しい側に 90 件あり、今の root の記録が古い側に 12 件あっても、
///     今の root の新しい 10 件が返る(root を跨いでも薄くならない=契約3・4)。
#[test]
fn this_root_keeps_its_ten_newest_even_after_ninety_newer_entries_elsewhere() {
    let tmp = TempDir::new().unwrap();
    let store = RecentFilesStore::new(&store_path(&tmp));
    for i in 1..=12 {
        store.add(&format!("file:///proj/f{i}.md")).unwrap();
    }
    for i in 1..=90 {
        store.add(&format!("file:///elsewhere/g{i}.md")).unwrap();
    }
    assert_eq!(
        store.list().unwrap().len(),
        MAX_RECENT_FILES,
        "102 adds are capped at 100"
    );

    let shown = store.list_under_root("file:///proj").unwrap();
    let expected: Vec<String> = (3..=12)
        .rev()
        .map(|i| format!("file:///proj/f{i}.md"))
        .collect();
    assert_eq!(
        shown, expected,
        "f12..f3 survive; only f1 and f2 were pushed out by the cap"
    );
    assert_eq!(
        store.list_under_root("file:///elsewhere").unwrap().len(),
        RECENT_FILES_SHOWN
    );
    assert_eq!(
        store.list_under_root("file:///elsewhere").unwrap()[0],
        "file:///elsewhere/g90.md"
    );
}

/// 20. 配下が 3 件なら 3 件(10 件に満たなければあるだけ)。0 件なら空。
#[test]
fn list_under_root_returns_what_there_is_when_fewer_than_ten() {
    let tmp = TempDir::new().unwrap();
    let store = RecentFilesStore::new(&store_path(&tmp));
    assert!(
        store.list_under_root("file:///proj").unwrap().is_empty(),
        "empty store → empty"
    );
    for name in ["a.md", "b.md", "c.md"] {
        store.add(&format!("file:///proj/{name}")).unwrap();
    }
    for i in 1..=20 {
        store.add(&format!("file:///other/{i}.md")).unwrap();
    }

    assert_eq!(
        store.list_under_root("file:///proj").unwrap(),
        strings(&[
            "file:///proj/c.md",
            "file:///proj/b.md",
            "file:///proj/a.md"
        ]),
    );
}

// ---------------------------------------------------------------------------
// AC-64-7 — 除去(契約8・9)
// ---------------------------------------------------------------------------

/// 21. `remove(uri)` はその URI だけを除く。無い URI では何も変わらない(エラーにもならない)。
#[test]
fn remove_drops_only_that_uri_and_ignores_an_unknown_one() {
    let tmp = TempDir::new().unwrap();
    let store = RecentFilesStore::new(&store_path(&tmp));
    store.add("file:///proj/a.md").unwrap();
    store.add("file:///other/x.md").unwrap();
    store.add("file:///proj/b.md").unwrap();

    store.remove("file:///other/x.md").unwrap();
    assert_eq!(
        store.list().unwrap(),
        strings(&["file:///proj/b.md", "file:///proj/a.md"])
    );

    store
        .remove("file:///proj/nope.md")
        .expect("removing an unknown uri is not an error");
    assert_eq!(
        store.list().unwrap(),
        strings(&["file:///proj/b.md", "file:///proj/a.md"])
    );

    // 別インスタンスでも消えている(保存済み)。
    assert_eq!(
        RecentFilesStore::new(&store_path(&tmp)).list().unwrap(),
        strings(&["file:///proj/b.md", "file:///proj/a.md"])
    );

    // 空のストアに対する remove もエラーにしない(ファイルが無いまま)。
    let empty = RecentFilesStore::new(&tmp.path().join("empty").join(RECENT_FILES_FILENAME));
    empty
        .remove("file:///proj/a.md")
        .expect("remove on an empty store is not an error");
    assert!(empty.list().unwrap().is_empty());
}

/// 22. `remove_under_root(root)` は root 配下だけを除き、ほかの root の記録と順序は残す。
#[test]
fn remove_under_root_drops_only_that_root_keeping_the_others_in_order() {
    let tmp = TempDir::new().unwrap();
    let store = RecentFilesStore::new(&store_path(&tmp));
    store.add("file:///other/1.md").unwrap();
    store.add("file:///proj/a.md").unwrap();
    store.add("file:///projects/keep.md").unwrap();
    store.add("file:///other/2.md").unwrap();
    store.add("file:///proj/docs/b.md").unwrap();
    store.add("ssh://alice@host/proj/c.md").unwrap();

    store.remove_under_root("file:///proj").unwrap();

    assert_eq!(
        store.list().unwrap(),
        strings(&[
            "ssh://alice@host/proj/c.md",
            "file:///other/2.md",
            "file:///projects/keep.md",
            "file:///other/1.md",
        ]),
        "only file:///proj/… is gone; everything else keeps its order"
    );
    assert!(store.list_under_root("file:///proj").unwrap().is_empty());

    // 末尾 `/` 付きでも同じ root。無い root では何も変わらない。
    store.remove_under_root("file:///nowhere/").unwrap();
    assert_eq!(store.list().unwrap().len(), 4);
    store.remove_under_root("file:///other/").unwrap();
    assert_eq!(
        store.list().unwrap(),
        strings(&["ssh://alice@host/proj/c.md", "file:///projects/keep.md"])
    );
}

// ---------------------------------------------------------------------------
// AC-64-8 — 見つからないときだけ除く(契約8)
// ---------------------------------------------------------------------------

/// 23. `should_forget_on_open_error` は `FsError::NotFound` のときだけ true。
#[test]
fn should_forget_only_on_not_found() {
    assert!(should_forget_on_open_error(&FsError::NotFound(
        "file:///proj/gone.md".into()
    )));

    let others: Vec<FsError> = vec![
        FsError::PermissionDenied("file:///proj/secret.md".into()),
        FsError::FileTooLarge("file:///proj/huge.bin".into()),
        FsError::InvalidUtf8,
        FsError::UnsupportedScheme("ftp".into()),
        FsError::Unsupported("write on ssh".into()),
        FsError::Io(io::Error::new(io::ErrorKind::PermissionDenied, "denied")),
        FsError::Io(io::Error::new(io::ErrorKind::TimedOut, "ssh timed out")),
        FsError::Io(io::Error::new(
            io::ErrorKind::NotConnected,
            "ssh disconnected",
        )),
    ];
    for err in others {
        assert!(
            !should_forget_on_open_error(&err),
            "must not forget on {err}"
        );
    }
}

#[allow(dead_code)]
fn _should_forget_signature() -> fn(&FsError) -> bool {
    should_forget_on_open_error
}

// ---------------------------------------------------------------------------
// ソース走査のヘルパー(acceptance_req55 / req65 / req67 の写し)
// ---------------------------------------------------------------------------

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

fn document_rs_code() -> String {
    strip_line_comments(include_str!("../src/commands/document.rs"))
}

/// `fn <name>(` から、次の `#[tauri::command]` か次の関数の頭か `#[cfg(test)]` まで
/// (acceptance_req65 の写し)。
fn fn_body(code: &str, name: &str) -> String {
    let marker = format!("fn {name}(");
    let at = code
        .find(&marker)
        .unwrap_or_else(|| panic!("`{marker}` must exist"));
    let rest = &code[at + marker.len()..];
    let mut end = rest.len();
    for stop in [
        "#[tauri::command]",
        "\nasync fn ",
        "\nfn ",
        "\npub async fn ",
        "\npub fn ",
        "\n    async fn ",
        "\n    fn ",
        "\n    pub async fn ",
        "\n    pub fn ",
        "\n#[cfg(test)]",
    ] {
        if let Some(i) = rest.find(stop) {
            end = end.min(i);
        }
    }
    format!("{marker}{}", &rest[..end])
}

/// `start` から最初の `(` に対応する閉じ括弧までの呼び出し全体(acceptance_req60 の写し)。
fn balanced_call(code: &str, start: usize) -> &str {
    let open = code[start..].find('(').expect("call must have '('") + start;
    let mut depth = 0usize;
    for (i, c) in code[open..].char_indices() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => {
                depth -= 1;
                if depth == 0 {
                    return &code[start..=open + i];
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced call starting at byte {start}");
}

fn first_string_literal(s: &str) -> Option<&str> {
    let a = s.find('"')? + 1;
    let b = s[a..].find('"')? + a;
    Some(&s[a..b])
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

/// Submenu 呼び出しの項目スライス(`&[…]`)の識別子列(`&name` の name)。
fn slice_idents(call: &str) -> Vec<String> {
    let open = call
        .find("&[")
        .expect("Submenu::with_items must take a slice");
    let end = call[open..].find(']').expect("slice must close") + open;
    call[open + 2..end]
        .split(',')
        .map(|s| s.trim().trim_start_matches('&').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// `const_name` を渡している `MenuItem::with_id(…)` の呼び出し(ちょうど 1 つ)の開始位置と全体。
fn item_call_at<'a>(code: &'a str, const_name: &str) -> (usize, &'a str) {
    let mut search = 0;
    let mut found = None;
    while let Some(rel) = code[search..].find("MenuItem::with_id") {
        let start = search + rel;
        let call = balanced_call(code, start);
        search = start + "MenuItem::with_id".len();
        if call.contains(const_name) {
            assert!(
                found.is_none(),
                "{const_name} must bind exactly one MenuItem"
            );
            found = Some((start, call));
        }
    }
    found.unwrap_or_else(|| panic!("{const_name} must be passed to MenuItem::with_id"))
}

/// `const_name` で束ねられた MenuItem の束縛名(`let xxx = MenuItem::with_id(app, CONST, …)`)。
fn item_binding<'a>(code: &'a str, const_name: &str) -> &'a str {
    let (call_pos, _) = item_call_at(code, const_name);
    let let_pos = code[..call_pos]
        .rfind("let ")
        .unwrap_or_else(|| panic!("{const_name} must be used inside a let binding"));
    code[let_pos + 4..call_pos]
        .split(|c: char| c == '=' || c.is_whitespace())
        .find(|s| !s.is_empty())
        .expect("binding name after `let`")
}

/// menu.rs のコード部分から二重引用符の文字列リテラルを取り出す(acceptance_req60 の写し)。
fn menu_rs_string_literals() -> Vec<String> {
    let code = menu_rs_code();
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
// AC-64-9 — 記録と除去の配線(契約1・2・8)。commands/document.rs のソース走査
// ---------------------------------------------------------------------------

/// 24. `open_in_window` の中に、成功後の `recent_files::record_file` と、失敗側の
///     `recent_files::forget_file`(`should_forget_on_open_error` で絞る)がある。
#[test]
fn open_in_window_records_after_success_and_forgets_on_not_found() {
    let code = document_rs_code();
    let body = fn_body(&code, "open_in_window");

    let record_at = body
        .find("recent_files::record_file(")
        .expect("open_in_window must call recent_files::record_file(…) (契約2)");
    let last_open_at = body
        .rfind("DocumentSession::open")
        .expect("open_in_window still opens through DocumentSession::open / open_binary");
    assert!(
        record_at > last_open_at,
        "record_file must come after the session is opened (記録は成功後=契約2)"
    );
    assert!(
        body.contains("recent_files::forget_file("),
        "open_in_window must call recent_files::forget_file(…) on the failure side (契約8)"
    );
    assert!(
        body.contains("should_forget_on_open_error"),
        "the forget must be gated by should_forget_on_open_error (契約8)"
    );
    // 記録は開く経路の共通点 1 か所に置く: open_document / open_binary_document 自身には無い。
    for name in ["open_document", "open_binary_document"] {
        assert!(
            !fn_body(&code, name).contains("recent_files"),
            "{name} must not touch recent_files itself (the shared open_in_window does)"
        );
    }
}

/// 25. `save_document` の中には `recent_files` の呼び出しが無い(保存では記録しない=契約1)。
#[test]
fn save_document_does_not_touch_recent_files() {
    let code = document_rs_code();
    let body = fn_body(&code, "save_document");
    assert!(
        !body.contains("recent_files"),
        "save_document must not record or forget recent files (契約1)"
    );
    assert!(
        !fn_body(&code, "announce_settings_saved").contains("recent_files"),
        "the settings-saved hook is part of saving and must not record either"
    );
}

// ---------------------------------------------------------------------------
// AC-64-10 — command の登録(契約4・9・11)。lib.rs のソース走査
// ---------------------------------------------------------------------------

/// 26. `list_recent_files` と `clear_recent_files` が両方の `generate_handler!` ブロックに載る
///     (並びは AC-60-20 側= src/lib/go-to-path.acceptance.test.ts が固定する)。
#[test]
fn recent_files_commands_are_registered_in_both_handler_lists() {
    let code = lib_rs_code();
    let blocks: Vec<&str> = code
        .match_indices("generate_handler![")
        .map(|(i, _)| {
            let start = i + "generate_handler![".len();
            let end = code[start..].find(']').expect("handler list must close") + start;
            &code[start..end]
        })
        .collect();
    assert_eq!(
        blocks.len(),
        2,
        "lib.rs has the webdriver and the production handler lists"
    );
    for block in blocks {
        let names: Vec<&str> = block
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.rsplit("::").next().unwrap())
            .collect();
        for cmd in ["list_recent_files", "clear_recent_files"] {
            assert_eq!(
                names.iter().filter(|n| **n == cmd).count(),
                1,
                "generate_handler! must register {cmd} exactly once: {names:?}"
            );
        }
        assert!(
            names.contains(&"list_history"),
            "list_history (要件#4) stays registered: {names:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// AC-64-11 — メニュー(契約5)。定数・parse・重複なし・Go メニューの並び・lib.rs の dispatch
// ---------------------------------------------------------------------------

/// 27. 定数の値固定(項目 ID・イベント名・アクセラレータ)。
#[test]
fn recent_files_menu_constants_are_fixed() {
    assert_eq!(RECENT_FILES_ITEM_ID, "recent-files");
    assert_eq!(MENU_RECENT_FILES_EVENT, "menu_recent_files");
    assert_eq!(RECENT_FILES_ACCELERATOR, "CmdOrCtrl+Shift+R");
}

/// 28. parse 妥当性: tauri は parse に失敗した accelerator を黙って捨てるので、Ok が登録の判定点。
#[test]
fn recent_files_accelerator_parses_as_tauri_accelerator() {
    assert!(
        Accelerator::from_str(RECENT_FILES_ACCELERATOR).is_ok(),
        "accelerator '{RECENT_FILES_ACCELERATOR}' must parse"
    );
}

/// 29. menu.rs にちょうど 1 回登録され、既存のどのアクセラレータとも衝突しない
///     (acceptance_req60 の重複検査と同じ網。あちらが無改変で緑であることはフルスイートが判定)。
#[test]
fn recent_files_accelerator_is_registered_once_and_unique() {
    let parsed: Vec<(String, Accelerator)> = menu_rs_string_literals()
        .into_iter()
        .filter(|s| s.contains('+'))
        .filter_map(|s| Accelerator::from_str(&s).ok().map(|a| (s, a)))
        .collect();
    let target = Accelerator::from_str(RECENT_FILES_ACCELERATOR).unwrap();
    let count = parsed.iter().filter(|(_, a)| *a == target).count();
    assert_eq!(
        count, 1,
        "menu.rs must register {RECENT_FILES_ACCELERATOR} exactly once (found {count})"
    );
    for (i, (raw_a, acc_a)) in parsed.iter().enumerate() {
        for (raw_b, acc_b) in parsed.iter().skip(i + 1) {
            assert!(
                acc_a != acc_b,
                "duplicate accelerator in menu.rs: '{raw_a}' vs '{raw_b}'"
            );
        }
    }
}

/// 30. ラベル "Recent Files"(三点リーダ無し=ダイアログではなく区画を開く)が、
///     RECENT_FILES_ITEM_ID と RECENT_FILES_ACCELERATOR を渡す MenuItem::with_id に束ねられている。
///     定数はインラインリテラルではなく宣言+使用で 2 回以上現れる。
#[test]
fn menu_rs_binds_the_recent_files_label_to_the_item_id_and_accelerator() {
    let code = menu_rs_code();
    for name in ["RECENT_FILES_ITEM_ID", "RECENT_FILES_ACCELERATOR"] {
        let count = code.matches(name).count();
        assert!(
            count >= 2,
            "menu.rs must declare AND use {name} (found {count})"
        );
    }
    let (_, call) = item_call_at(&code, "RECENT_FILES_ITEM_ID");
    assert!(
        call.contains("\"Recent Files\""),
        "the item carries the label \"Recent Files\": {call}"
    );
    assert!(
        call.contains("RECENT_FILES_ACCELERATOR"),
        "the item registers RECENT_FILES_ACCELERATOR: {call}"
    );
    assert!(
        !code.contains("\"Recent Files\u{2026}\""),
        "no ellipsis: the item opens a section, not a dialog"
    );
    assert!(
        !code.contains("\"Recent Files...\""),
        "no three-dot spelling either"
    );
    assert_eq!(
        code.matches("\"Recent Files\"").count(),
        1,
        "the label literal appears exactly once"
    );
}

/// 31. Go メニューの項目列で「Recent Files」が「Go to Path…」の後にある(間に区切り線があるのは可・
///     ほかの項目は挟まない)。
#[test]
fn go_menu_holds_recent_files_after_go_to_path() {
    let code = menu_rs_code();
    let go_menu =
        submenu_call_with_label(&code, "Go").expect("menu.rs must build the Go submenu (要件#60)");
    let idents = slice_idents(go_menu);
    let go_to = item_binding(&code, "GO_TO_ITEM_ID");
    let recent = item_binding(&code, "RECENT_FILES_ITEM_ID");

    let go_to_at = idents
        .iter()
        .position(|s| s == go_to)
        .unwrap_or_else(|| panic!("the Go menu must still hold &{go_to}: {idents:?}"));
    let recent_at = idents
        .iter()
        .position(|s| s == recent)
        .unwrap_or_else(|| panic!("the Go menu must hold &{recent} (Recent Files): {idents:?}"));
    assert!(
        recent_at > go_to_at,
        "Recent Files comes after Go to Path…: {idents:?}"
    );
    for between in &idents[go_to_at + 1..recent_at] {
        assert!(
            code.contains(&format!("let {between} = PredefinedMenuItem::separator(")),
            "only a separator may sit between Go to Path… and Recent Files (found `{between}`): {idents:?}"
        );
    }
}

/// 32. File / Edit / View / Window のメニューには出さない(同じ項目を 2 箇所に出さない)。
#[test]
fn other_menus_do_not_hold_recent_files() {
    let code = menu_rs_code();
    let recent = item_binding(&code, "RECENT_FILES_ITEM_ID");
    for label in ["File", "Edit", "View", "Window", "Vellis"] {
        let call = submenu_call_with_label(&code, label)
            .unwrap_or_else(|| panic!("menu.rs must build a submenu labelled {label:?}"));
        assert!(
            !call.contains(&format!("&{recent}")),
            "{label} menu must not hold &{recent}"
        );
        assert!(
            !call.contains("RECENT_FILES_ITEM_ID"),
            "{label} menu must not reference RECENT_FILES_ITEM_ID"
        );
    }
}

/// 33. lib.rs の `on_menu_event` がこの ID を `MENU_RECENT_FILES_EVENT` へ回す
///     (Go to Path… と同じ `handle_menu_open_click` の配線)。
#[test]
fn lib_rs_dispatches_recent_files_to_the_focused_window() {
    let lib = lib_rs_code();
    let handler_at = lib
        .find("on_menu_event")
        .expect("lib.rs must install on_menu_event");
    let after = &lib[handler_at..];
    let arm_at = after
        .find("id if id == menu::RECENT_FILES_ITEM_ID")
        .expect("on_menu_event must match on menu::RECENT_FILES_ITEM_ID with the same arm shape as the other items");
    let arm_rest = &after[arm_at + "id if id == menu::RECENT_FILES_ITEM_ID".len()..];
    let arm_end = arm_rest
        .find("id if id ==")
        .into_iter()
        .chain(arm_rest.find("_ =>"))
        .min()
        .unwrap_or(arm_rest.len());
    let arm = &arm_rest[..arm_end];
    assert!(
        arm.contains("handle_menu_open_click"),
        "the arm must ride handle_menu_open_click: {arm}"
    );
    assert!(
        arm.contains("MENU_RECENT_FILES_EVENT"),
        "the arm must emit MENU_RECENT_FILES_EVENT: {arm}"
    );

    let combined = format!("{}\n{}", menu_rs_code(), lib);
    assert!(
        combined.matches("MENU_RECENT_FILES_EVENT").count() >= 2,
        "MENU_RECENT_FILES_EVENT must be declared and dispatched"
    );
}
