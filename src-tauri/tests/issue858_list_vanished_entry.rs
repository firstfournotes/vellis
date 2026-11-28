//! Issue #858 — フォルダの一覧(`LocalProvider::list`)が、readdir と stat の間に消えた 1 項目(保存の一時ファイル)で全体ごと失敗する。
//!
//! `src-tauri/src/fs/local.rs` の `list` は `de.metadata().await.map_err(io_to_fs)?` で、readdir が返した項目が stat までの間に消える
//! (一時ファイル+rename の保存で使う tmp)と、一覧の取得全体が `not found` で失敗する(要件89 の実機ゲートのログ
//! `WARN failed to re-list <root>: not found`)。
//!
//! ## 固定する振る舞い(直った後)
//! - 一覧の途中で項目が消えても `list` は `Ok` を返し、残っている項目(消えなかったファイルとフォルダ)は全部入っている。
//!   消えた項目は入っていてもいなくてもよい(入っているなら readdir が見た通常ファイル)
//! - フォルダそのものが無いときの `Err(NotFound)` は今までどおり(回帰の守り)
//!
//! ## 判定の作り(推奨の解釈。報告に列挙)
//! - 「readdir と stat の間」を外から正確に突くことはできない(tokio の `ReadDir` は 32 項目ずつ読み、項目ごとに `spawn_blocking` で
//!   stat する)。そこで、消える項目を多数(240)作り、一覧と並行して別のスレッドがそれらを順に消す。stat は 1 項目ずつ別スレッドで
//!   行うので、読み込んだ塊の中の未 stat の項目が消される窓は毎回ある。これを数回(8)回す
//! - 直した後は、どの順で消えても `Ok` になる(決定的に緑)。直す前は、消えた項目に 1 つでも stat が当たれば `Err` になる(極めて高い確率で赤)。
//!   赤の見込みだけが確率的で、緑の判定は決定的
//! - 消えない目印(`keep.md`・`keepdir/`)が一覧に残ること・ディレクトリが先頭に並ぶ(今のソート)ことも併せて見る
//!
//! ## 修正前に赤になる理由
//! - 消えた項目の `de.metadata()` が `NotFound` になり、`?` で一覧の取得全体が `Err(FsError::NotFound)` になる

#![cfg(unix)]

use std::fs;
use std::path::Path;
use std::thread;

use tempfile::TempDir;

use vellis_lib::errors::FsError;
use vellis_lib::fs::entry::FileKind;
use vellis_lib::fs::local::LocalProvider;
use vellis_lib::fs::provider::FileProvider;
use vellis_lib::fs::uri::Uri;

/// 既存ユニットテスト(src/fs/local.rs)・acceptance_req31.rs と同じ流儀で file:// URI を直接構築する。
fn make_uri(path: &Path) -> Uri {
    Uri {
        scheme: "file".into(),
        authority: None,
        path: path.to_path_buf(),
        raw: format!("file://{}", path.display()),
    }
}

/// 回す回数(赤の見込みを上げる。直した後は毎回 Ok)。
const ROUNDS: usize = 8;
/// 一覧の最中に消える項目の数(tokio の ReadDir の塊 32 を何度もまたぐ数)。
const VANISHING: usize = 240;

#[tokio::test]
async fn list_survives_entries_that_vanish_between_readdir_and_stat() {
    for round in 0..ROUNDS {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();
        fs::write(root.join("keep.md"), "# keep").unwrap();
        fs::create_dir(root.join("keepdir")).unwrap();
        let vanishing: Vec<_> = (0..VANISHING)
            .map(|i| root.join(format!("save-{i:04}.md.vellis-tmp")))
            .collect();
        for p in &vanishing {
            fs::write(p, "tmp").unwrap();
        }

        // 一覧と並行して、別のスレッドが一時ファイルを順に消す(保存の tmp+rename の見立て)。
        let deleter = {
            let paths = vanishing.clone();
            thread::spawn(move || {
                for p in paths {
                    let _ = fs::remove_file(p);
                }
            })
        };

        let result = LocalProvider::new().list(&make_uri(&root)).await;
        deleter.join().unwrap();

        let entries = result.unwrap_or_else(|e| {
            panic!("round {round}: list must not fail because an entry vanished between readdir and stat: {e}")
        });
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"keep.md"), "round {round}: keep.md must be listed (got: {names:?})");
        assert!(names.contains(&"keepdir"), "round {round}: keepdir must be listed (got: {names:?})");
        assert_eq!(entries[0].kind, FileKind::Dir, "round {round}: directories still sort first");
        for e in &entries {
            let known = e.name == "keep.md" || e.name == "keepdir" || e.name.starts_with("save-");
            assert!(known, "round {round}: unexpected entry {:?}", e.name);
            if e.name.starts_with("save-") {
                assert_eq!(e.kind, FileKind::File, "round {round}: a vanishing entry that made it in is a regular file");
            }
        }
    }
}

/// 回帰の守り: フォルダそのものが無いときは今までどおり NotFound。
#[tokio::test]
async fn list_of_a_missing_folder_is_still_not_found() {
    let tmp = TempDir::new().unwrap();
    let missing = tmp.path().join("gone");
    let result = LocalProvider::new().list(&make_uri(&missing)).await;
    assert!(
        matches!(result, Err(FsError::NotFound(_))),
        "a missing folder is still NotFound: {result:?}"
    );
}

/// 回帰の守り: 何も消えなければ全部の項目が入る(ディレクトリが先頭)。
#[tokio::test]
async fn list_without_races_lists_everything() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    fs::write(root.join("a.md"), "a").unwrap();
    fs::write(root.join("b.md"), "b").unwrap();
    fs::create_dir(root.join("sub")).unwrap();
    let entries = LocalProvider::new().list(&make_uri(root)).await.unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(entries.len(), 3, "{names:?}");
    assert_eq!(entries[0].name, "sub");
    assert!(names.contains(&"a.md") && names.contains(&"b.md"));
}
