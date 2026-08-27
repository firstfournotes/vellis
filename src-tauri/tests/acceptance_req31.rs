//! 要件#31 の受け入れテスト(requirements.md #31・backlog #68)
//!
//! 「シンボリックリンクをリンク先の種別で扱う(ディレクトリへのリンクはツリーで
//!  展開できる)」
//!
//! 不具合の背景(診断済み): LocalProvider::list(src-tauri/src/fs/local.rs)の
//! `de.metadata()`(tokio の DirEntry::metadata)は**リンクを辿らない**ため、dir への
//! リンクが FileKind::Symlink になりフロントがファイル扱い(展開不能)。stat() は
//! `tokio::fs::metadata`(辿る)なので経路間非対称。
//!
//! 契約(2026-08-27 由谷決定):
//! - ① LocalProvider::list は symlink エントリのリンク先を辿って種別判定する
//!   (リンク先 dir=FileKind::Dir・リンク先 file=FileKind::File。size/modified も
//!   リンク先の値)。
//! - ② リンク先不在(壊れたリンク)は FileKind::Symlink のまま一覧に表示
//!   (フロントはファイル扱い・開くと既存エラー経路=無害)。
//! - ③ ソートは判定後の kind に従う(dir リンクはディレクトリ群と同順=
//!   ディレクトリ優先ソートに乗る)。
//! - ④ stat() は既にリンクを辿る(fs::metadata)ため挙動不変(現行の到達不能な
//!   Symlink 分岐の整理は実装裁量)。
//! - ⑤ ssh リモートは初版対象外=ssh.rs 現状維持。
//! - ⑥ 循環リンクの特別対策なし(ツリーは遅延展開のため無限再帰は構造上起きない)。
//! - ⑦ フロント無変更。
//! - ⑧ 展開したリンク先ディレクトリの変更追従(subscribe_dir)はベストエフォート=
//!   実装裁量(機械固定は list の分類のみ)。
//!
//! 判定範囲(本ファイル): list の symlink 分類(①)・壊れたリンクの温存(②)・
//! 判定後 kind でのソート(③)・通常エントリと隠しファイルスキップの回帰ガード・
//! stat の dir リンク(④の固定=現行でも通るはず)・循環リンク下でも list が
//! 正常に返ること(⑥)。
//! 契約外(機械判定しない): ⑤ ssh.rs 現状維持・⑦ フロント無変更 — reviewer 照合。
//! ⑧ subscribe_dir の追従はベストエフォート=実装裁量のため判定しない。

// symlink 作成は Unix API 前提(macOS で実行。acceptance_req6.rs の前例に同じ)。
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tempfile::TempDir;

use vellis_lib::fs::entry::{Entry, FileKind};
use vellis_lib::fs::local::LocalProvider;
use vellis_lib::fs::provider::FileProvider;
use vellis_lib::fs::uri::Uri;

/// 既存ユニットテスト(src/fs/local.rs)・acceptance_req1.rs と同じ流儀で
/// file:// URI を直接構築する。
fn make_uri(path: &Path) -> Uri {
    Uri {
        scheme: "file".into(),
        authority: None,
        path: path.to_path_buf(),
        raw: format!("file://{}", path.display()),
    }
}

/// list の結果からエントリ名を並び順のまま得る(ソート検証用)。
fn names_in_order(entries: &[Entry]) -> Vec<String> {
    entries.iter().map(|e| e.name.clone()).collect()
}

/// 名前でエントリを探す(見つからなければ panic=一覧に出ること自体も検証)。
fn find<'a>(entries: &'a [Entry], name: &str) -> &'a Entry {
    entries
        .iter()
        .find(|e| e.name == name)
        .unwrap_or_else(|| panic!("entry {:?} must be listed (got: {:?})", name, names_in_order(entries)))
}

/// SystemTime → Unix epoch ミリ秒(Entry::modified と同じ変換)。
fn millis(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

// ---------------------------------------------------------------------------
// 契約①: リンク先を辿った種別判定
// ---------------------------------------------------------------------------

/// ① dir へのリンクは FileKind::Dir・size=None(ディレクトリ扱い)で列挙される。
#[tokio::test]
async fn list_reports_dir_symlink_as_dir() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("root");
    fs::create_dir(&root).unwrap();

    // リンク先は listing 対象外の場所に置く(一覧をリンクだけにして観点を絞る)
    let target_dir = tmp.path().join("target-dir");
    fs::create_dir(&target_dir).unwrap();
    fs::write(target_dir.join("inside.md"), "# inside").unwrap();
    symlink(&target_dir, root.join("link-dir")).unwrap();

    let provider = LocalProvider::new();
    let entries = provider.list(&make_uri(&root)).await.unwrap();

    let link = find(&entries, "link-dir");
    assert_eq!(
        link.kind,
        FileKind::Dir,
        "a symlink to a directory must be classified by its target (Dir), not as Symlink"
    );
    assert_eq!(link.size, None, "a dir-symlink entry must have size=None like a directory");
}

/// ① file へのリンクは FileKind::File で列挙され、size/modified は
/// **リンク先の値**になる(リンク自体の lstat 値ではない)。
///
/// 判別方法: リンク先に既知バイト数を書き、mtime を過去(2001-09-09)に固定する。
/// リンク自体の size はリンク先パス文字列長・mtime は作成時刻(今)なので、
/// どちらも機械的に区別できる。
#[tokio::test]
async fn list_reports_file_symlink_as_file_with_target_metadata() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("root");
    fs::create_dir(&root).unwrap();

    let target_file = tmp.path().join("target.txt");
    let content = b"vellis symlink"; // 14 bytes
    fs::write(&target_file, content).unwrap();

    // リンク先の mtime を既知の過去時刻に固定(Rust 1.75+ の File::set_modified)
    let past = UNIX_EPOCH + Duration::from_secs(1_000_000_000); // 2001-09-09
    fs::File::options()
        .write(true)
        .open(&target_file)
        .unwrap()
        .set_modified(past)
        .unwrap();

    let link_path = root.join("link.txt");
    symlink(&target_file, &link_path).unwrap();

    // フィクスチャの自己検証: リンク自体の lstat 値はリンク先と確実に異なる
    let link_own = fs::symlink_metadata(&link_path).unwrap();
    let target_meta = fs::metadata(&target_file).unwrap();
    assert_ne!(
        link_own.len(),
        content.len() as u64,
        "fixture: the symlink's own size (target path length) must differ from the content size"
    );
    assert_ne!(
        millis(link_own.modified().unwrap()),
        millis(target_meta.modified().unwrap()),
        "fixture: the symlink's own mtime (now) must differ from the target's fixed mtime"
    );

    let provider = LocalProvider::new();
    let entries = provider.list(&make_uri(&root)).await.unwrap();

    let link = find(&entries, "link.txt");
    assert_eq!(
        link.kind,
        FileKind::File,
        "a symlink to a regular file must be classified by its target (File), not as Symlink"
    );
    assert_eq!(
        link.size,
        Some(content.len() as u64),
        "size must be the target file's byte count, not the symlink's own size"
    );
    assert_eq!(
        link.modified,
        Some(millis(target_meta.modified().unwrap())),
        "modified must be the target file's mtime, not the symlink's own mtime"
    );
}

// ---------------------------------------------------------------------------
// 契約②: 壊れたリンクは Symlink のまま一覧に出る
// ---------------------------------------------------------------------------

/// ② リンク先不在(壊れたリンク)があっても list はエラーにならず、
/// そのエントリは FileKind::Symlink のまま一覧に表示される。
#[tokio::test]
async fn list_keeps_broken_symlink_listed_as_symlink() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("root");
    fs::create_dir(&root).unwrap();

    // 実在しないパスへのリンク(リンク先を辿ると NotFound になる)
    symlink(tmp.path().join("no-such-target"), root.join("ghost-link")).unwrap();
    fs::write(root.join("normal.txt"), "ok").unwrap();

    let provider = LocalProvider::new();
    let entries = provider
        .list(&make_uri(&root))
        .await
        .expect("a broken symlink must not fail the whole listing");

    let ghost = find(&entries, "ghost-link");
    assert_eq!(
        ghost.kind,
        FileKind::Symlink,
        "a broken symlink must stay FileKind::Symlink in the listing"
    );
    // 通常エントリは巻き添えにならない
    assert_eq!(find(&entries, "normal.txt").kind, FileKind::File);
}

// ---------------------------------------------------------------------------
// 契約③: ソートは判定後の kind に従う
// ---------------------------------------------------------------------------

/// ③ dir へのリンクはディレクトリ群側に並ぶ(ディレクトリ優先ソートに乗る)。
///
/// フィクスチャは「現行実装(リンク=非 dir 扱い)と判定後(リンク=dir 扱い)で
/// 並びが変わる」名前を選ぶ: 実 dir "alpha"・実 file "beta.txt"・dir リンク
/// "gamma-link"。判定後の正解は [alpha, gamma-link, beta.txt]。
#[tokio::test]
async fn list_sorts_dir_symlink_into_directory_group() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("root");
    fs::create_dir(&root).unwrap();

    let target_dir = tmp.path().join("linked-target");
    fs::create_dir(&target_dir).unwrap();

    fs::create_dir(root.join("alpha")).unwrap();
    fs::write(root.join("beta.txt"), "b").unwrap();
    symlink(&target_dir, root.join("gamma-link")).unwrap();

    let provider = LocalProvider::new();
    let entries = provider.list(&make_uri(&root)).await.unwrap();

    assert_eq!(
        names_in_order(&entries),
        vec!["alpha", "gamma-link", "beta.txt"],
        "a dir-symlink must sort with the directory group (dirs first, then alphabetical)"
    );
}

// ---------------------------------------------------------------------------
// 回帰ガード: 通常エントリの分類・ソート/隠しファイルスキップは従来どおり
// ---------------------------------------------------------------------------

/// 回帰ガード: 実 dir・実 file の分類とソート(dir 優先→名前昇順)は従来どおり。
#[tokio::test]
async fn list_keeps_real_entry_classification_and_order() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("root");
    fs::create_dir(&root).unwrap();

    fs::create_dir(root.join("src")).unwrap();
    fs::create_dir(root.join("docs")).unwrap();
    fs::write(root.join("readme.md"), "# r").unwrap();
    fs::write(root.join("a.txt"), "a").unwrap();

    let provider = LocalProvider::new();
    let entries = provider.list(&make_uri(&root)).await.unwrap();

    assert_eq!(
        names_in_order(&entries),
        vec!["docs", "src", "a.txt", "readme.md"],
        "real entries must keep the existing dirs-first alphabetical order"
    );
    assert_eq!(find(&entries, "docs").kind, FileKind::Dir);
    assert_eq!(find(&entries, "src").kind, FileKind::Dir);
    assert_eq!(find(&entries, "a.txt").kind, FileKind::File);
    assert_eq!(find(&entries, "readme.md").kind, FileKind::File);
}

/// 回帰ガード: 隠しエントリ(ドット始まり)はスキップされる — リンクでも同じ。
/// ドット始まりの壊れたリンクが listing 全体を失敗させないことも兼ねて固定する
/// (隠し判定はリンク先を辿る前に効くべき)。
#[tokio::test]
async fn list_still_skips_hidden_entries_including_symlinks() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("root");
    fs::create_dir(&root).unwrap();

    let target_dir = tmp.path().join("hidden-target");
    fs::create_dir(&target_dir).unwrap();

    fs::write(root.join(".hidden.md"), "# h").unwrap();
    symlink(&target_dir, root.join(".hidden-link")).unwrap();
    symlink(tmp.path().join("no-such"), root.join(".broken-link")).unwrap();
    fs::write(root.join("visible.txt"), "v").unwrap();

    let provider = LocalProvider::new();
    let entries = provider
        .list(&make_uri(&root))
        .await
        .expect("hidden broken symlinks must not fail the listing");

    assert_eq!(
        names_in_order(&entries),
        vec!["visible.txt"],
        "dot-prefixed entries (files and symlinks alike) must be skipped"
    );
}

// ---------------------------------------------------------------------------
// 契約④: stat はリンクを辿る(現行挙動の固定=経路間非対称の解消の証左)
// ---------------------------------------------------------------------------

/// ④ dir リンクへの stat は Dir を返す(fs::metadata は辿るため現行でも通るはず。
/// 「到達不能な Symlink 分岐の整理」がこの挙動を壊さないことを固定する)。
#[tokio::test]
async fn stat_follows_dir_symlink_to_dir() {
    let tmp = TempDir::new().unwrap();
    let target_dir = tmp.path().join("target-dir");
    fs::create_dir(&target_dir).unwrap();
    let link_path = tmp.path().join("link-dir");
    symlink(&target_dir, &link_path).unwrap();

    let provider = LocalProvider::new();
    let entry = provider.stat(&make_uri(&link_path)).await.unwrap();

    assert_eq!(entry.kind, FileKind::Dir, "stat on a dir-symlink must report Dir");
    assert_eq!(entry.size, None, "stat on a dir-symlink must report size=None like a directory");
}

// ---------------------------------------------------------------------------
// 契約⑥: 循環リンクがあっても list は正常に返る(一覧は1階層のみ=再帰しない)
// ---------------------------------------------------------------------------

/// ⑥ サブディレクトリ内に親へのリンク(循環)があっても、list() は各階層とも
/// 正常に返る(list は1階層の列挙で再帰しないことの固定)。循環リンク自体も
/// 契約①によりリンク先の種別=Dir で列挙される。
#[tokio::test]
async fn list_returns_normally_with_cycle_symlink() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("root");
    fs::create_dir(&root).unwrap();
    let sub = root.join("sub");
    fs::create_dir(&sub).unwrap();
    // 親(root)へのリンク=循環
    symlink(&root, sub.join("parent")).unwrap();

    let provider = LocalProvider::new();

    let root_entries = provider
        .list(&make_uri(&root))
        .await
        .expect("list on the root must succeed despite the cycle below");
    assert_eq!(find(&root_entries, "sub").kind, FileKind::Dir);

    let sub_entries = provider
        .list(&make_uri(&sub))
        .await
        .expect("list on the sub-directory must succeed despite the cycle link");
    assert_eq!(
        find(&sub_entries, "parent").kind,
        FileKind::Dir,
        "the cycle link resolves to a directory, so it must be listed as Dir (契約①)"
    );
    // 1階層のみの列挙であること(循環による膨張がない)
    assert_eq!(sub_entries.len(), 1, "list must enumerate exactly one level (no recursion)");
}
