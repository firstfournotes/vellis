//! 要件#3 の受け入れテスト(requirements.md #3)
//!
//! 「一度開いたフォルダを履歴として保存し、UI から簡単に再オープンできる」
//! 受け入れ基準: 履歴ストアの追加・重複排除(最近順に繰上げ)・永続化(保存→復元)が
//! 機械判定で通る。
//!
//! 判定範囲: 本テストは履歴ストアの契約まで。「UI から簡単に再オープン」の UI 部分は
//! 要件#4(引数なし起動時の履歴選択画面)と統合されるため、そちらの受け入れで照合する。
//!
//! ## 確定契約(implementer はこれに従う。実装先: src-tauri/src/history.rs、
//! ## lib.rs に `pub mod history;` を追加)
//!
//! ```ignore
//! pub const MAX_HISTORY: usize = 20;
//!
//! pub struct HistoryStore { /* 実装自由 */ }
//!
//! impl HistoryStore {
//!     /// 保存先ファイルパスを注入して構築する。ファイルや親ディレクトリが
//!     /// 未存在でもエラーにしない(生成は保存時まで遅延)ため infallible。
//!     pub fn new(file: &Path) -> HistoryStore;
//!
//!     /// フォルダパス(文字列。file:// URI か絶対パスかはストアは関知しない)を
//!     /// 履歴の先頭に追加し、即座に永続化する。
//!     /// - 既存エントリ(文字列完全一致)は重複させず先頭へ繰上げる
//!     ///   (完全一致以上の正規化を加えるのは実装の自由)
//!     /// - MAX_HISTORY(20 件)を超えた分は末尾=最古から破棄する
//!     /// - 保存先の親ディレクトリが無ければ作成する
//!     pub fn add(&self, path: &str) -> Result<(), E>;      // E: Debug(型は実装自由)
//!
//!     /// 履歴を最近順(先頭=最新)で返す。
//!     /// - ファイル未存在(初回起動)は Ok(空 Vec)。エラーにしない
//!     /// - ファイルが壊れて JSON として読めない場合も Ok(空 Vec)にフォールバック
//!     ///   (要件#4 で起動時に読むため、壊れた履歴で起動を阻害しない)
//!     pub fn list(&self) -> Result<Vec<String>, E>;
//! }
//! ```
//!
//! 保存形式: 注入されたファイルに JSON 配列(`Vec<String>`、先頭=最新)として
//! serde_json でシリアライズする。書き込みは既存 AnnotationStore と同じく
//! アトミック(tmp → rename)が望ましいが、本テストが固定するのは
//! 「ファイル内容が JSON 配列としてパースでき、最近順である」ことまで。
//!
//! 実装フックポイントの想定(本テストの判定対象外・実装の参考):
//! - `commands::root::set_root`(ユーザーがルートを切り替えた時)
//! - `commands::app::init_window`(ルート確定でウィンドウがマウントされた時)
//! - `ipc::handler::handle_open_path`(2 回目以降の CLI 起動の委譲)
//! いずれもルート URI 文字列が確定する箇所であり、`HistoryStore::add` を
//! 1 行差し込める。ストア自体は AppState 管理でもその場生成でも成立する。

use std::fs;
use std::path::PathBuf;

use tempfile::TempDir;

use vellis_lib::history::{HistoryStore, MAX_HISTORY};

/// TempDir 直下の履歴ファイルパスを返す(ファイル自体は作らない)。
fn history_path(tmp: &TempDir) -> PathBuf {
    tmp.path().join("history.json")
}

/// 1. 追加: add したフォルダパスが list の先頭に来る(最近順)。
#[test]
fn add_puts_folder_at_head_of_list() {
    let tmp = TempDir::new().unwrap();
    let path = history_path(&tmp);
    let store = HistoryStore::new(&path);

    store.add("file:///Users/a/docs").unwrap();
    store.add("file:///Users/a/notes").unwrap();
    store.add("file:///Users/a/work").unwrap();

    let entries = store.list().unwrap();
    assert_eq!(
        entries,
        vec![
            "file:///Users/a/work".to_string(),
            "file:///Users/a/notes".to_string(),
            "file:///Users/a/docs".to_string(),
        ],
        "list must return entries most-recent-first"
    );
}

/// 2. 重複排除: 既存パスを再 add すると重複せず先頭へ繰上げ。
#[test]
fn re_adding_existing_path_moves_it_to_head_without_duplicate() {
    let tmp = TempDir::new().unwrap();
    let store = HistoryStore::new(&history_path(&tmp));

    store.add("file:///Users/a/docs").unwrap();
    store.add("file:///Users/a/notes").unwrap();
    store.add("file:///Users/a/work").unwrap();

    // 最古のエントリを再 add → 先頭へ繰上げ、件数は増えない。
    store.add("file:///Users/a/docs").unwrap();

    let entries = store.list().unwrap();
    assert_eq!(entries.len(), 3, "re-adding must not create a duplicate");
    assert_eq!(
        entries,
        vec![
            "file:///Users/a/docs".to_string(),
            "file:///Users/a/work".to_string(),
            "file:///Users/a/notes".to_string(),
        ],
        "re-added entry must move to the head, others keep relative order"
    );
}

/// 3. 永続化: add 後に別インスタンスを同じパスで作ると同じ履歴が復元される。
///    保存先は未作成のサブディレクトリ配下(初回起動で config ディレクトリが
///    無いケース)— add が親ディレクトリを作成することも同時に固定する。
#[test]
fn history_persists_across_instances() {
    let tmp = TempDir::new().unwrap();
    // "state/" は事前に作らない — add 側で作成されること。
    let path = tmp.path().join("state").join("history.json");

    {
        let first = HistoryStore::new(&path);
        first.add("file:///Users/a/docs").unwrap();
        first.add("file:///Users/a/notes").unwrap();
    } // drop = 保存はここまでに完了していること(add 時点で永続化)

    let second = HistoryStore::new(&path);
    assert_eq!(
        second.list().unwrap(),
        vec![
            "file:///Users/a/notes".to_string(),
            "file:///Users/a/docs".to_string(),
        ],
        "a new instance on the same file must restore the same history"
    );

    // 復元後の add も一貫していること(繰上げ・追記が引き継がれる)。
    second.add("file:///Users/a/docs").unwrap();
    let third = HistoryStore::new(&path);
    assert_eq!(
        third.list().unwrap(),
        vec![
            "file:///Users/a/docs".to_string(),
            "file:///Users/a/notes".to_string(),
        ],
        "promotion (dedupe to head) must also persist across instances"
    );
}

/// 3b. 保存形式: ファイル内容は JSON 配列(Vec<String>、先頭=最新)として
///     パースできる(要件#4 の起動時読み込みが依存する契約)。
#[test]
fn on_disk_format_is_json_array_of_strings_most_recent_first() {
    let tmp = TempDir::new().unwrap();
    let path = history_path(&tmp);
    let store = HistoryStore::new(&path);

    store.add("file:///Users/a/docs").unwrap();
    store.add("file:///Users/a/notes").unwrap();

    assert!(path.is_file(), "add must persist to the injected file path");
    let raw = fs::read_to_string(&path).unwrap();
    let parsed: Vec<String> = serde_json::from_str(&raw)
        .expect("history file must be a JSON array of strings");
    assert_eq!(
        parsed,
        vec![
            "file:///Users/a/notes".to_string(),
            "file:///Users/a/docs".to_string(),
        ],
        "on-disk order must be most-recent-first"
    );
}

/// 4. 上限: MAX_HISTORY(=20)を超えたら古いものから落ちる。
#[test]
fn capacity_caps_at_max_history_dropping_oldest() {
    assert_eq!(MAX_HISTORY, 20, "contract fixes the default capacity at 20");

    let tmp = TempDir::new().unwrap();
    let store = HistoryStore::new(&history_path(&tmp));

    // 21 件の相異なるパスを追加。
    for i in 0..=MAX_HISTORY {
        store.add(&format!("file:///Users/a/folder-{}", i)).unwrap();
    }

    let entries = store.list().unwrap();
    assert_eq!(entries.len(), MAX_HISTORY, "history must be capped at MAX_HISTORY");
    assert_eq!(
        entries[0], "file:///Users/a/folder-20",
        "newest entry stays at the head"
    );
    assert!(
        !entries.contains(&"file:///Users/a/folder-0".to_string()),
        "the oldest entry must be dropped when capacity is exceeded"
    );
    assert_eq!(
        entries[MAX_HISTORY - 1],
        "file:///Users/a/folder-1",
        "the surviving tail is the second-oldest entry"
    );

    // 上限到達後の重複繰上げは件数を変えない(落とすのは新規追加時のみ)。
    store.add("file:///Users/a/folder-5").unwrap();
    let entries = store.list().unwrap();
    assert_eq!(entries.len(), MAX_HISTORY);
    assert_eq!(entries[0], "file:///Users/a/folder-5");
}

/// 5. 空/初回: ファイルが無い状態で list が空を返す(エラーにしない)。
#[test]
fn fresh_store_with_missing_file_lists_empty() {
    let tmp = TempDir::new().unwrap();
    let store = HistoryStore::new(&history_path(&tmp));
    let entries = store
        .list()
        .expect("missing history file must not be an error");
    assert!(entries.is_empty(), "first launch must yield an empty history");

    // 親ディレクトリごと未存在でも同様(初回起動で config dir が無いケース)。
    let nested = tmp.path().join("no-such-dir").join("history.json");
    let store = HistoryStore::new(&nested);
    assert!(
        store.list().expect("missing parent dir must not be an error").is_empty()
    );
}

/// 5b. 異常系: 履歴ファイルが JSON として壊れていても list はエラーにせず
///     空にフォールバックし、次の add で正常状態に復帰する
///     (要件#4 で起動時に読むため、壊れた履歴が起動を阻害してはならない。
///     AnnotationStore の corrupted-lines-skipped と同じ家風)。
#[test]
fn corrupted_file_falls_back_to_empty_and_recovers_on_add() {
    let tmp = TempDir::new().unwrap();
    let path = history_path(&tmp);
    fs::write(&path, "this is not json {{{").unwrap();

    let store = HistoryStore::new(&path);
    let entries = store
        .list()
        .expect("corrupted history file must not be an error");
    assert!(entries.is_empty(), "corrupted file must fall back to empty");

    store.add("file:///Users/a/docs").unwrap();
    assert_eq!(
        store.list().unwrap(),
        vec!["file:///Users/a/docs".to_string()],
        "add after corruption must leave the store in a clean state"
    );
}
