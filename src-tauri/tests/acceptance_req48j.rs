//! 要件#48 追補j の受け入れテスト(docs/requirements/req-48.md 追補j・Issue #653・#639)— Rust 層
//!
//! 「保存(一時ファイル+rename)の途中で、同じフォルダを書き換えられる者がリンクを差し込んだときの
//!  守りの穴 3 つを塞ぐ」を固定する:
//! - **AC-48-追j(a)** 一時ファイルはリンクを辿らずに新しく作る(追補j(1)): 一時ファイルの名前
//!   `.<name>.vellis-tmp` に、root の外のファイルを指すリンクを先に置いておくと、保存は `Err` で、
//!   リンクの先の中身は変わらず、元の文書も置き換わらない。リンクの先が root の中の別のファイル・
//!   元の文書そのもの・リンク切れ(辿ると作られてしまう)でも同じ。残っていた**普通の**一時ファイル
//!   (前の保存が途中で落ちた残り物)は消して作り直し、保存は成功する=文書は新しい中身・一時ファイルは
//!   残らない(契約(1) の 2026-10-19 訂正: リンクを辿らない unlink で消してから `create_new`)
//! - **AC-48-追j(b)** 書き込みの直前に書き先を確かめ直す(追補j(2)): 書き先の判定のあと rename の前に
//!   (差し込み口 `write_text_within_root_with` の `before_rename`)書き先がリンクに差し替えられると、
//!   保存は `Err` で、root の外は変わらず、元の文書も置き換わらず、一時ファイルは残らない。
//!   root の中を指すリンクへの差し替えも断る(判定したのは普通のファイル)。root 無し
//!   (`write_text` 相当)でもリンクの確かめ直しは効く。確かめ直しの判定そのもの
//!   (`verify_write_target`)は単体で表にし、`save_document` が判定に使った root を渡す配線は
//!   ソース走査で固定する。差し込み口が何もしなければ保存は従来どおり成功する(不変)
//! - **AC-48-追j(c)** 後始末はリンクを辿らない(追補j(3)): 後始末の時点で一時ファイルが元のファイルを
//!   指すリンク(リンク自身を `uchg` でロック=後始末の最初の unlink を拒ませ、flags と ACL を外す
//!   経路へ入れる)に差し替えられていても、元のファイルの flags(`uchg`)と ACL
//!   (`everyone deny delete`)は外れない。片方だけ持つ元のファイルでも同じ(`lchflags` と
//!   `acl_set_link_np` をそれぞれ単独で捕まえる)。差し替えられたリンクは後始末で消える(追補f の
//!   「失敗しても一時ファイルを残さない」の不変)
//! - **AC-48-追j(d)** 既存の保存の受け入れ(acceptance_req48 / 48d / 48e / 48f)は無改変で緑 → フルスイートで判定
//!
//! ## 判定しないもの
//! - 一時ファイルを `create_new`(O_EXCL)で作ること・後始末が `lchflags` / `acl_set_link_np` である
//!   こと(手段の指定)→ reviewer 照合。ここでは結果だけを判定する
//! - 窓を「なくす」のではなく「縮める」こと(完全に閉じるには tmp+rename を手放す)→ 設計判断
//! - 新しい失敗の文言(追補j(4))→ リンクの確かめ直しの `Err` に "link" を含む要旨だけを判定し、
//!   それ以外は `Err` であることのみ
//!
//! ## 実装前の見立て
//! - ファイル全体が新しい公開 API(`verify_write_target`・`write_text_within_root`・
//!   `write_text_within_root_with`)を参照するため、実装前はコンパイルで赤
//! - 振る舞いとしても: (a) のリンク 4 件は現状 `File::create` がリンクを辿って先を書き、rename が
//!   リンクを文書に被せて `Ok` を返す=赤。(b) は現状 rename が差し替え
//!   られたリンクを一時ファイルで置き換えて `Ok`=赤。(c) は現状 `chflags(2)` / `acl_set_file(3)` が
//!   リンクを辿って元のファイルの `uchg` と ACL を外す=赤。`save_document` は `.write_text(` を
//!   呼んでいる=赤
//! - API ができた後も最初から緑のはずのもの(不変の守り): 差し込み口が何もしないときの成功・
//!   `write_text_within_root` の普通の保存と最初の保存・`verify_write_target` の受け入れ側・
//!   (a) の残った普通の一時ファイルがあっても成功(今も `File::create` が上書きして成功している=
//!   `create_new` に替えたときに残り物で以後の保存が全部失敗する退行を捕まえる)
//!
//! ## 注意(テスト作成時の確認・2026-10-19・zsh で確認)
//! - `chflags -h uchg link` はリンク自身に `uchg` を付け、その `rm` は Operation not permitted。
//!   `-h` 無しの `chflags nouchg link` と `chmod -N link` はリンクを辿って**先のファイル**の flags と
//!   ACL を外す(リンク自身の `uchg` は残る)。`chflags -h nouchg` で外せる。`uchg` 付きのリンクを
//!   `mv` で普通のファイルに被せるのも、普通のファイルを `uchg` のファイルに被せるのも失敗する
//! - テストの後始末: `UnlockOnDrop` は acceptance_req48f.rs の写しに `-h` 付きを足したもの
//!   (リンク自身の `uchg` を外さないと TempDir が消えずに残る)。TempDir より後に宣言する
//! - 一時ファイルの名前は `.<name>.vellis-tmp` で決まっている(要件#65 契約2・acceptance_req48f.rs)。
//!   (a) はその名前にリンクを先に置く
//! - (a) の「残った普通の一時ファイル」は契約(1) の 2026-10-19 訂正どおり成功側(起案の「失敗を
//!   返す」は誤りと確定=オーケストレーター)。消すのにリンクを辿らないことは結果で判定する
//!   (リンクの 4 件が `Err` で先が不変・普通のファイルの 1 件が成功)
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前・公開パス)
//!
//! ```ignore
//! // --- src-tauri/src/fs/local.rs ---
//! /// 追補j(2): rename の直前の確かめ直し。`target` は `resolve_write_target` が決めた書き先。
//! /// Ok = `target` が(辿らずに見て=`symlink_metadata`)リンクでない(無い=最初の保存は可)・
//! ///      かつ `root` が Some なら `ensure_within_root(root, target)` と同じ判定(canonicalize)で root の中。
//! /// Err = それ以外(リンクなら root の中を指していても Err・リンク切れも Err・root の外も Err)。
//! /// 読み取りだけ(何も作らず消さない)。リンクの Err の文言は "link" を含む。
//! pub fn verify_write_target(target: &Path, root: Option<&Path>) -> Result<(), FsError>;
//!
//! impl LocalProvider {
//!     /// `save_document` が判定に使った root を渡す保存。`write_text` と同じ経路で、rename の直前に
//!     /// `verify_write_target(target, Some(root))` を通し、Err なら何も置き換えず一時ファイルを後始末して Err。
//!     pub async fn write_text_within_root(&self, uri: &str, content: &str, root: &Path) -> Result<(), FsError>;
//!
//!     /// テスト用の差し込み口(公開 API)。`before_rename` は一時ファイルを書き終えた(中身・メタデータの
//!     /// 写し・fsync 済み)あと、確かめ直し(`verify_write_target`)と rename の前に 1 回だけ呼ばれる。
//!     /// `write_text(uri, c)`                   == `write_text_within_root_with(uri, c, None,       || {})`
//!     /// `write_text_within_root(uri, c, root)` == `write_text_within_root_with(uri, c, Some(root), || {})`
//!     pub async fn write_text_within_root_with<F>(
//!         &self, uri: &str, content: &str, root: Option<&Path>, before_rename: F,
//!     ) -> Result<(), FsError>
//!     where F: FnOnce() + Send;
//! }
//!
//! // --- src-tauri/src/commands/document.rs の save_document(追補j(2) の配線)---
//! //   `provider.write_text(&write_uri.raw, &content)` を、判定に使った root を渡す
//! //   `write_text_within_root(&write_uri.raw, &content, &root_uri.path)` に替える
//! //   (LocalProvider::new() を直接呼んでも、trait に同名の既定メソッドを足して provider 経由でもよい。
//! //    走査は「save_document の中に `write_text_within_root(` があり、その呼び出しに `root_uri` か
//! //    `canonical_root` が渡っていて、`.write_text(` は残っていない」だけを見る)
//! ```

#![cfg(unix)]

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tempfile::TempDir;
use vellis_lib::errors::FsError;
use vellis_lib::fs::local::{verify_write_target, LocalProvider};
use vellis_lib::fs::provider::FileProvider;

// ---------------------------------------------------------------------------
// ヘルパー(acceptance_req48d / 48f の家風)
// ---------------------------------------------------------------------------

/// ローカルの絶対パスを `file://` URI にする(既存テストの家風)。
fn file_uri(path: &Path) -> String {
    format!("file://{}", path.display())
}

/// `path` の中身が `expected` と byte 等価か(読み戻しは provider を介さず素の fs)。
fn assert_bytes(path: &Path, expected: &str) {
    let on_disk = fs::read(path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    assert_eq!(
        on_disk,
        expected.as_bytes(),
        "bytes at {} must equal the expected content exactly",
        path.display()
    );
}

/// `dir` に `.vellis-tmp` で終わる名前のエントリ(リンクも含む・辿らない)が残っていないか(1 階層)。
fn tmp_leftovers_in(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("cannot list {}: {e}", dir.display()))
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".vellis-tmp"))
        .collect()
}

fn assert_no_tmp_leftovers(dir: &Path) {
    let leftovers = tmp_leftovers_in(dir);
    assert!(
        leftovers.is_empty(),
        "no `.vellis-tmp` entry may remain in {} after the save: {leftovers:?}",
        dir.display()
    );
}

/// 保存の一時ファイルの名前(`.<name>.vellis-tmp`=要件#65 契約2 の組み込みの除外・48f で固定済み)。
fn tmp_path_for(target: &Path) -> PathBuf {
    let parent = target.parent().expect("target has a parent");
    let name = target
        .file_name()
        .expect("target has a file name")
        .to_string_lossy();
    parent.join(format!(".{name}.vellis-tmp"))
}

/// `path` が(辿らずに見て)普通のファイルか。
fn assert_regular_file(path: &Path) {
    let meta =
        fs::symlink_metadata(path).unwrap_or_else(|e| panic!("{} must exist: {e}", path.display()));
    assert!(
        meta.file_type().is_file(),
        "{} must be a regular file (not a symlink, not replaced by one)",
        path.display()
    );
}

/// `path` がシンボリックリンクのまま(辿らずに見てリンク)で、リンクの中身が `expected` のままか。
fn assert_still_symlink_to(path: &Path, expected: &Path) {
    let meta = fs::symlink_metadata(path)
        .unwrap_or_else(|e| panic!("{} must still exist as a symlink: {e}", path.display()));
    assert!(
        meta.file_type().is_symlink(),
        "{} must remain a symlink (it was replaced by a regular file)",
        path.display()
    );
    assert_eq!(
        fs::read_link(path).unwrap(),
        expected,
        "the link target of {} must be unchanged",
        path.display()
    );
}

/// Err の要旨が permission denied / forbidden 系か(variant 名は実装裁量・既存テストと同じ判定)。
fn assert_forbidden_class(err: impl std::fmt::Display) {
    let msg = err.to_string().to_lowercase();
    assert!(
        msg.contains("permission denied") || msg.contains("forbidden"),
        "rejection should be a permission-denied/forbidden class error, got: {msg}"
    );
}

/// Err の要旨がリンクのことを言っているか(追補j(4)「新しい失敗は分かる文言を足す」の最小限)。
fn assert_mentions_link(err: impl std::fmt::Display) {
    let msg = err.to_string().to_lowercase();
    assert!(
        msg.contains("link"),
        "the refusal of a symlink write target should say so (expected \"link\" in the message), got: {msg}"
    );
}

/// root の中に `doc.md`(中身 `old`)、別の TempDir(root の外)に `secret.md`(中身 `secret`)。
/// 返り値 = (root, doc.md, outside, secret.md)。
fn doc_and_outside() -> (TempDir, PathBuf, TempDir, PathBuf) {
    let root = TempDir::new().unwrap();
    let doc = root.path().join("doc.md");
    fs::write(&doc, "old\n").unwrap();
    let outside = TempDir::new().unwrap();
    let secret = outside.path().join("secret.md");
    fs::write(&secret, "secret\n").unwrap();
    (root, doc, outside, secret)
}

// ---------------------------------------------------------------------------
// AC-48-追j(a) — 一時ファイルの名前に先にリンクが置かれていたら、辿らずに失敗する(追補j(1))
// ---------------------------------------------------------------------------

/// 1. 一時ファイルの名前に root の外のファイルを指すリンク → `Err`・外の中身は不変・文書も不変。
#[tokio::test]
async fn ac_48_j_a_tmp_name_link_to_outside_file_refuses_save_and_leaves_outside_untouched() {
    let (_root, doc, _outside, secret) = doc_and_outside();
    let planted = tmp_path_for(&doc);
    symlink(&secret, &planted).unwrap();
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&doc), "new\n")
        .await
        .expect_err(
            "a link already sitting at the temp file's name must make the save fail (追補j(1))",
        );

    assert_bytes(&secret, "secret\n");
    assert_regular_file(&secret);
    assert_regular_file(&doc);
    assert_bytes(&doc, "old\n");
}

/// 2. リンクの先が root の中の別のファイルでも同じ(root を渡す経路でも断る)。
#[tokio::test]
async fn ac_48_j_a_tmp_name_link_to_sibling_inside_root_refuses_save() {
    let root = TempDir::new().unwrap();
    let doc = root.path().join("doc.md");
    fs::write(&doc, "old\n").unwrap();
    let other = root.path().join("other.md");
    fs::write(&other, "other\n").unwrap();
    let planted = tmp_path_for(&doc);
    symlink(&other, &planted).unwrap();
    let provider = LocalProvider::new();

    provider
        .write_text_within_root(&file_uri(&doc), "new\n", root.path())
        .await
        .expect_err("a link at the temp file's name must make the save fail even when it points inside root");

    assert_bytes(&other, "other\n");
    assert_regular_file(&other);
    assert_regular_file(&doc);
    assert_bytes(&doc, "old\n");
}

/// 3. リンクの先が元の文書そのもの → 文書の中身は `old` のまま(辿って書くと文書が壊れる形)。
#[tokio::test]
async fn ac_48_j_a_tmp_name_link_to_the_document_itself_refuses_save() {
    let root = TempDir::new().unwrap();
    let doc = root.path().join("doc.md");
    fs::write(&doc, "old\n").unwrap();
    let planted = tmp_path_for(&doc);
    symlink(&doc, &planted).unwrap();
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&doc), "new\n")
        .await
        .expect_err(
            "a link at the temp file's name pointing at the document must make the save fail",
        );

    assert_regular_file(&doc);
    assert_bytes(&doc, "old\n");
}

/// 4. リンク切れ(先が無い)でも辿って作らない → `Err`・先は作られない・文書は不変。
#[tokio::test]
async fn ac_48_j_a_dangling_tmp_name_link_refuses_save_and_creates_nothing() {
    let (_root, doc, outside, _secret) = doc_and_outside();
    let missing = outside.path().join("not-yet.md");
    assert!(fs::symlink_metadata(&missing).is_err());
    let planted = tmp_path_for(&doc);
    symlink(&missing, &planted).unwrap();
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&doc), "new\n")
        .await
        .expect_err("a dangling link at the temp file's name must make the save fail");

    assert!(
        fs::symlink_metadata(&missing).is_err(),
        "the dangling link's target must not be created by the refused save"
    );
    assert_regular_file(&doc);
    assert_bytes(&doc, "old\n");
}

/// 5. 残っていた**普通の**一時ファイル(前の保存が途中で落ちた残り物)があっても保存は成功する
///    (契約(1) の 2026-10-19 訂正: リンクを辿らない unlink で消してから `create_new` で作り直す)。
///    文書は新しい中身(残り物の中身は混ざらない)・一時ファイルは残らない。
#[tokio::test]
async fn ac_48_j_a_leftover_regular_tmp_file_is_replaced_and_the_save_succeeds() {
    let root = TempDir::new().unwrap();
    let doc = root.path().join("doc.md");
    fs::write(&doc, "old\n").unwrap();
    let leftover = tmp_path_for(&doc);
    fs::write(&leftover, "stale\n").unwrap();
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&doc), "new\n")
        .await
        .expect("a leftover regular temp file must not make the save fail (追補j(1) 訂正: it is unlinked and recreated)");

    assert_regular_file(&doc);
    assert_bytes(&doc, "new\n");
    assert_no_tmp_leftovers(root.path());
}

// ---------------------------------------------------------------------------
// AC-48-追j(b) — 書き先の判定のあと rename の前の差し替え(差し込み口で再現)(追補j(2))
// ---------------------------------------------------------------------------

/// 6. 書き先が root の外を指すリンクに差し替えられる → `Err`・外は不変・元の文書(脇へ移した実体)は
///    不変・書き先はリンクのまま(一時ファイルで置き換えない)・一時ファイルは残らない。
#[tokio::test]
async fn ac_48_j_b_target_swapped_to_link_outside_root_before_rename_refuses_save() {
    let (root, doc, outside, secret) = doc_and_outside();
    let moved = root.path().join("doc.md.orig");
    let provider = LocalProvider::new();

    let swap = {
        let (doc, moved, secret) = (doc.clone(), moved.clone(), secret.clone());
        move || {
            // 判定のあと rename の前: 元の文書を脇へ移し、同じ名前に root の外を指すリンクを置く。
            fs::rename(&doc, &moved).expect("fixture: move the original aside");
            symlink(&secret, &doc).expect("fixture: plant a link at the write target");
        }
    };
    let result = provider
        .write_text_within_root_with(&file_uri(&doc), "new\n", Some(root.path()), swap)
        .await;
    assert!(
        result.is_err(),
        "a write target that became a symlink after the decision must be refused before the rename (追補j(2))"
    );

    assert_bytes(&secret, "secret\n");
    assert_regular_file(&secret);
    assert_bytes(&moved, "old\n");
    assert_still_symlink_to(&doc, &secret);
    assert_no_tmp_leftovers(root.path());
    assert_no_tmp_leftovers(outside.path());
}

/// 7. root の中を指すリンクへの差し替えでも断る(判定したのは普通のファイル)。先は不変。
#[tokio::test]
async fn ac_48_j_b_target_swapped_to_link_inside_root_before_rename_refuses_save() {
    let root = TempDir::new().unwrap();
    let doc = root.path().join("doc.md");
    fs::write(&doc, "old\n").unwrap();
    let other = root.path().join("other.md");
    fs::write(&other, "other\n").unwrap();
    let moved = root.path().join("doc.md.orig");
    let provider = LocalProvider::new();

    let swap = {
        let (doc, moved, other) = (doc.clone(), moved.clone(), other.clone());
        move || {
            fs::rename(&doc, &moved).expect("fixture: move the original aside");
            symlink(&other, &doc).expect("fixture: plant a link at the write target");
        }
    };
    let result = provider
        .write_text_within_root_with(&file_uri(&doc), "new\n", Some(root.path()), swap)
        .await;
    assert!(
        result.is_err(),
        "a write target that became a symlink (even one inside root) must be refused before the rename"
    );

    assert_bytes(&other, "other\n");
    assert_bytes(&moved, "old\n");
    assert_still_symlink_to(&doc, &other);
    assert_no_tmp_leftovers(root.path());
}

/// 8. root 無し(`write_text` 相当)でも、リンクの確かめ直しは効く。
#[tokio::test]
async fn ac_48_j_b_symlink_recheck_applies_without_a_root_too() {
    let (root, doc, outside, secret) = doc_and_outside();
    let moved = root.path().join("doc.md.orig");
    let provider = LocalProvider::new();

    let swap = {
        let (doc, moved, secret) = (doc.clone(), moved.clone(), secret.clone());
        move || {
            fs::rename(&doc, &moved).expect("fixture: move the original aside");
            symlink(&secret, &doc).expect("fixture: plant a link at the write target");
        }
    };
    let result = provider
        .write_text_within_root_with(&file_uri(&doc), "new\n", None, swap)
        .await;
    assert!(
        result.is_err(),
        "the symlink re-check before the rename does not depend on a root being given"
    );

    assert_bytes(&secret, "secret\n");
    assert_bytes(&moved, "old\n");
    assert_still_symlink_to(&doc, &secret);
    assert_no_tmp_leftovers(root.path());
    assert_no_tmp_leftovers(outside.path());
}

/// 9. 差し込み口の置き場所と不変: `before_rename` は一時ファイルが(普通のファイルとして・新しい
///    中身で)書き終わった後に呼ばれ、何もしなければ保存は従来どおり成功する。
#[tokio::test]
async fn ac_48_j_b_hook_runs_after_the_temp_file_is_written_and_a_quiet_hook_saves_normally() {
    let root = TempDir::new().unwrap();
    let doc = root.path().join("doc.md");
    fs::write(&doc, "old\n").unwrap();
    let tmp = tmp_path_for(&doc);
    let seen: Arc<Mutex<Option<(bool, Vec<u8>)>>> = Arc::new(Mutex::new(None));
    let provider = LocalProvider::new();

    let observe = {
        let (seen, tmp) = (Arc::clone(&seen), tmp.clone());
        move || {
            let is_regular = fs::symlink_metadata(&tmp)
                .map(|m| m.file_type().is_file())
                .unwrap_or(false);
            let bytes = fs::read(&tmp).unwrap_or_default();
            *seen.lock().unwrap() = Some((is_regular, bytes));
        }
    };
    provider
        .write_text_within_root_with(&file_uri(&doc), "new\n", Some(root.path()), observe)
        .await
        .expect("a hook that does nothing must not disturb a normal save (追補j(4) 不変)");

    let (is_regular, bytes) = seen
        .lock()
        .unwrap()
        .clone()
        .expect("before_rename must be called during the save");
    assert!(
        is_regular,
        "when before_rename runs, the temp file must already exist as a regular file at {}",
        tmp.display()
    );
    assert_eq!(
        bytes, b"new\n",
        "when before_rename runs, the temp file must already hold the new content"
    );
    assert_bytes(&doc, "new\n");
    assert_regular_file(&doc);
    assert_no_tmp_leftovers(root.path());
}

/// 10. `write_text_within_root` の普通の保存と最初の保存(不変): root の中の普通のファイルは
///     byte 等価で書け、まだ無いファイルは作られ、一時ファイルは残らない。
#[tokio::test]
async fn ac_48_j_b_write_text_within_root_writes_plain_and_first_save_under_root() {
    let root = TempDir::new().unwrap();
    let sub = root.path().join("sub");
    fs::create_dir(&sub).unwrap();
    let doc = sub.join("doc.md");
    fs::write(&doc, "old\n").unwrap();
    let content = "\u{FEFF}plain\r\nfile\r\n";
    let provider = LocalProvider::new();

    provider
        .write_text_within_root(&file_uri(&doc), content, root.path())
        .await
        .expect("a plain file under root must still save");
    assert_bytes(&doc, content);
    assert_regular_file(&doc);

    let fresh = sub.join("fresh.md");
    assert!(!fresh.exists());
    provider
        .write_text_within_root(&file_uri(&fresh), "first\n", root.path())
        .await
        .expect("a first save under root must still succeed");
    assert_bytes(&fresh, "first\n");
    assert_no_tmp_leftovers(root.path());
    assert_no_tmp_leftovers(&sub);
}

/// 11. `write_text_within_root` は root の外の普通のファイルを断る(判定の二重化・何も書かない)。
#[tokio::test]
async fn ac_48_j_b_write_text_within_root_refuses_a_plain_file_outside_root() {
    let (root, _doc, outside, secret) = doc_and_outside();
    let provider = LocalProvider::new();

    let err = provider
        .write_text_within_root(&file_uri(&secret), "new\n", root.path())
        .await
        .expect_err("a target outside the given root must be refused");
    assert_forbidden_class(err);

    assert_bytes(&secret, "secret\n");
    assert_no_tmp_leftovers(outside.path());
    assert_no_tmp_leftovers(root.path());
}

/// 12. `write_text_within_root` は、判定の時点で既に root の外を指しているリンクも断る
///     (`resolve_write_target` が辿った先が root の外=AC-48-19/23 と同じ結論を provider 側でも)。
#[tokio::test]
async fn ac_48_j_b_write_text_within_root_refuses_a_link_already_pointing_outside_root() {
    let (root, _doc, outside, secret) = doc_and_outside();
    let link = root.path().join("looks-inside.md");
    symlink(&secret, &link).unwrap();
    let provider = LocalProvider::new();

    provider
        .write_text_within_root(&file_uri(&link), "new\n", root.path())
        .await
        .expect_err("a link that resolves outside root must be refused with the root given");

    assert_bytes(&secret, "secret\n");
    assert_still_symlink_to(&link, &secret);
    assert_no_tmp_leftovers(outside.path());
    assert_no_tmp_leftovers(root.path());
}

// --- verify_write_target(確かめ直しの判定そのもの)---

/// 13. 受け入れ側: root の中の普通のファイル・まだ無いファイル(サブフォルダ含む)は Ok。読み取りだけ。
#[test]
fn ac_48_j_b_verify_write_target_accepts_a_plain_file_and_a_first_save_under_root() {
    let root = TempDir::new().unwrap();
    let plain = root.path().join("plain.md");
    fs::write(&plain, "x").unwrap();
    verify_write_target(&plain, Some(root.path()))
        .expect("a plain file under root is a valid write target");

    let fresh = root.path().join("fresh.md");
    verify_write_target(&fresh, Some(root.path()))
        .expect("a file that does not exist yet (first save) under root is valid");
    let sub = root.path().join("sub");
    fs::create_dir(&sub).unwrap();
    verify_write_target(&sub.join("deep.md"), Some(root.path()))
        .expect("a first save in a sub folder under root is valid");

    assert!(!fresh.exists(), "the check must not create anything");
    assert_bytes(&plain, "x");
}

/// 14. リンクは root の中を指していても Err(判定したのは普通のファイル)。文言は "link" を含む。
#[test]
fn ac_48_j_b_verify_write_target_refuses_a_symlink_even_inside_root() {
    let root = TempDir::new().unwrap();
    let real = root.path().join("b.md");
    fs::write(&real, "x").unwrap();
    let link = root.path().join("a.md");
    symlink(&real, &link).unwrap();

    let err = verify_write_target(&link, Some(root.path())).expect_err(
        "a symlink at the write target must be refused even when it points inside root",
    );
    assert_mentions_link(err);

    let relative = root.path().join("c.md");
    symlink("b.md", &relative).unwrap();
    let err = verify_write_target(&relative, Some(root.path()))
        .expect_err("a relative symlink must be refused too");
    assert_mentions_link(err);

    assert_still_symlink_to(&link, &real);
    assert_bytes(&real, "x");
}

/// 15. root の外を指すリンク・root の外の普通のファイル・リンク切れは Err。
#[test]
fn ac_48_j_b_verify_write_target_refuses_outside_root_and_dangling() {
    let (root, _doc, outside, secret) = doc_and_outside();

    let link = root.path().join("looks-inside.md");
    symlink(&secret, &link).unwrap();
    verify_write_target(&link, Some(root.path()))
        .expect_err("a symlink pointing outside root must be refused");

    let err = verify_write_target(&secret, Some(root.path()))
        .expect_err("a plain file outside root must be refused");
    assert_forbidden_class(err);

    let fresh_outside = outside.path().join("fresh.md");
    verify_write_target(&fresh_outside, Some(root.path()))
        .expect_err("a first save outside root must be refused");
    assert!(!fresh_outside.exists());

    let dangling = root.path().join("gone.md");
    symlink(root.path().join("missing.md"), &dangling).unwrap();
    verify_write_target(&dangling, Some(root.path()))
        .expect_err("a dangling symlink must be refused, not treated as a first save");
    assert!(fs::symlink_metadata(root.path().join("missing.md")).is_err());
}

/// 16. まだ無いファイルでも、親フォルダが root の外を指すリンクなら Err(最初の保存の経路でも外へ出ない)。
#[test]
fn ac_48_j_b_verify_write_target_refuses_a_first_save_through_a_dir_link_to_outside() {
    let (root, _doc, outside, _secret) = doc_and_outside();
    let sub_link = root.path().join("sub");
    symlink(outside.path(), &sub_link).unwrap();
    let target = sub_link.join("fresh.md");

    verify_write_target(&target, Some(root.path()))
        .expect_err("a first save whose parent folder is a link to outside root must be refused");

    assert!(
        fs::symlink_metadata(outside.path().join("fresh.md")).is_err(),
        "the check must not create anything outside"
    );
}

/// 17. root 無し(None)ではリンクの判定だけ: どこの普通のファイル・無いファイルも Ok、リンクは Err。
#[test]
fn ac_48_j_b_verify_write_target_without_root_checks_only_the_link() {
    let (root, doc, outside, secret) = doc_and_outside();
    verify_write_target(&doc, None).expect("without a root, a plain file is fine");
    verify_write_target(&secret, None).expect("without a root, a plain file anywhere is fine");
    verify_write_target(&outside.path().join("fresh.md"), None)
        .expect("without a root, a first save anywhere is fine");

    let link = root.path().join("a.md");
    symlink(&doc, &link).unwrap();
    let err =
        verify_write_target(&link, None).expect_err("without a root, a symlink is still refused");
    assert_mentions_link(err);

    let dangling = root.path().join("gone.md");
    symlink(root.path().join("missing.md"), &dangling).unwrap();
    verify_write_target(&dangling, None)
        .expect_err("without a root, a dangling symlink is still refused");
}

// 型レベルのシグネチャ固定(ズレをコンパイルエラーにする=acceptance_req48 の家風)。
#[allow(dead_code)]
fn _verify_write_target_signature() -> fn(&Path, Option<&Path>) -> Result<(), FsError> {
    verify_write_target
}

// ---------------------------------------------------------------------------
// AC-48-追j(b) — save_document が判定に使った root を書き込みへ渡す配線(ソース走査・acceptance_req64 の写し)
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

fn document_rs_code() -> String {
    strip_line_comments(include_str!("../src/commands/document.rs"))
}

/// `fn <name>(` から、次の `#[tauri::command]` か次の関数の頭か `#[cfg(test)]` まで。
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

/// `start` から最初の `(` に対応する閉じ括弧までの呼び出し全体。
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

/// 18. `save_document` は `write_text_within_root(…)` に、判定に使った root(`root_uri` /
///     `canonical_root`)を渡して書き、root を知らない `.write_text(` は呼ばない。判定(`ensure_within_root`)は残る。
#[test]
fn ac_48_j_b_save_document_passes_the_judged_root_to_the_write() {
    let code = document_rs_code();
    let body = fn_body(&code, "save_document");

    let at = body.find("write_text_within_root(").expect(
        "save_document must write through write_text_within_root(…) so the re-check before the rename \
         sees the root it judged against (追補j(2))",
    );
    let call = balanced_call(&body, at);
    assert!(
        call.contains("root_uri") || call.contains("canonical_root"),
        "the root handed to the write must be the window's root the decision used: {call}"
    );
    assert!(
        !body.contains(".write_text("),
        "save_document must not fall back to the root-less write_text(…)"
    );
    assert!(
        body.contains("ensure_within_root("),
        "the decision itself stays in save_document (追補a・追補d)"
    );
}

// ---------------------------------------------------------------------------
// AC-48-追j(c) — 後始末はリンクを辿らない(追補j(3))。macOS の flags と ACL
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod cleanup_does_not_follow_links {
    use super::*;
    use std::os::macos::fs::MetadataExt as MacMetadataExt;
    use std::process::Command;

    // --- ACL(chmod +a / chmod -N / ls -le)= acceptance_req48f の写し ---

    /// `path` に ACL エントリを足す(`chmod +a "<entry>" path`)。
    fn add_acl(path: &Path, entry: &str) {
        let out = Command::new("/bin/chmod")
            .arg("+a")
            .arg(entry)
            .arg(path)
            .output()
            .expect("fixture: cannot run /bin/chmod");
        assert!(
            out.status.success(),
            "fixture: chmod +a \"{entry}\" {} failed: {}",
            path.display(),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// `ls -le path` の ACL 行(` 0: group:everyone deny delete` の形)を番号を除いて集める。
    fn acl_of(path: &Path) -> Vec<String> {
        let out = Command::new("/bin/ls")
            .arg("-le")
            .arg(path)
            .output()
            .expect("cannot run /bin/ls -le");
        assert!(
            out.status.success(),
            "ls -le {} failed: {}",
            path.display(),
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|line| {
                let t = line.trim_start();
                let (idx, rest) = t.split_once(": ")?;
                if !idx.is_empty() && idx.chars().all(|c| c.is_ascii_digit()) {
                    Some(rest.trim().to_string())
                } else {
                    None
                }
            })
            .collect()
    }

    /// `path` に `everyone deny delete` を付け、付いたことを確かめる。
    fn deny_delete(path: &Path) -> Vec<String> {
        add_acl(path, "everyone deny delete");
        let acl = acl_of(path);
        assert!(
            acl.iter().any(|e| e == "group:everyone deny delete"),
            "fixture: `everyone deny delete` must be on {} before writing: {acl:?}",
            path.display()
        );
        acl
    }

    // --- flags(chflags / st_flags)---

    /// `path` の BSD file flags(リンクは辿る)。
    fn flags_of(path: &Path) -> u32 {
        fs::metadata(path)
            .unwrap_or_else(|e| panic!("cannot stat {}: {e}", path.display()))
            .st_flags()
    }

    /// `path` 自身の BSD file flags(リンクを辿らない)。
    fn link_flags_of(path: &Path) -> u32 {
        fs::symlink_metadata(path)
            .unwrap_or_else(|e| panic!("cannot lstat {}: {e}", path.display()))
            .st_flags()
    }

    /// `path` に `uchg` を付け、付いたことを確かめる(`chflags uchg path`)。
    fn lock_uchg(path: &Path) {
        let out = Command::new("/usr/bin/chflags")
            .arg("uchg")
            .arg(path)
            .output()
            .expect("fixture: cannot run /usr/bin/chflags");
        assert!(
            out.status.success(),
            "fixture: chflags uchg {} failed: {}",
            path.display(),
            String::from_utf8_lossy(&out.stderr)
        );
        assert_ne!(
            flags_of(path) & libc::UF_IMMUTABLE,
            0,
            "fixture: uchg must be set on {} before writing",
            path.display()
        );
    }

    /// リンク **自身** に `uchg` を付け、付いたことを確かめる(`chflags -h uchg link`)。
    /// これで後始末の最初の unlink が Operation not permitted になり、flags と ACL を外す経路へ入る。
    fn lock_uchg_link(link: &Path) {
        let out = Command::new("/usr/bin/chflags")
            .arg("-h")
            .arg("uchg")
            .arg(link)
            .output()
            .expect("fixture: cannot run /usr/bin/chflags");
        assert!(
            out.status.success(),
            "fixture: chflags -h uchg {} failed: {}",
            link.display(),
            String::from_utf8_lossy(&out.stderr)
        );
        assert_ne!(
            link_flags_of(link) & libc::UF_IMMUTABLE,
            0,
            "fixture: uchg must be set on the link itself {}",
            link.display()
        );
    }

    // --- 後始末: テストの成否にかかわらず TempDir を消せる状態に戻す(48f の写し+`-h`)---

    /// flags(`-h` 付きと無し)と ACL(`-h` 付きと無し)を外す。エラーは無視する。
    fn unlock_path(path: &Path) {
        let _ = Command::new("/usr/bin/chflags")
            .arg("-h")
            .arg("nouchg")
            .arg(path)
            .output();
        let _ = Command::new("/usr/bin/chflags")
            .arg("nouchg")
            .arg(path)
            .output();
        let _ = Command::new("/bin/chmod")
            .arg("-h")
            .arg("-N")
            .arg(path)
            .output();
        let _ = Command::new("/bin/chmod").arg("-N").arg(path).output();
    }

    fn unlock_tree(dir: &Path) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            unlock_path(&path);
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                unlock_tree(&path);
            }
        }
    }

    /// Drop で、登録したフォルダの中のすべてのエントリ(フィクスチャ・残った一時ファイルやリンク)から
    /// flags と ACL を外す。panic の巻き戻しでも走る。TempDir より **後に** 宣言すること。
    struct UnlockOnDrop {
        dirs: Vec<PathBuf>,
    }

    impl UnlockOnDrop {
        fn new(dirs: &[&Path]) -> Self {
            Self {
                dirs: dirs.iter().map(|d| d.to_path_buf()).collect(),
            }
        }
    }

    impl Drop for UnlockOnDrop {
        fn drop(&mut self) {
            for dir in &self.dirs {
                unlock_tree(dir);
            }
        }
    }

    /// `target` への保存を、rename の直前(差し込み口)で一時ファイルを「`target` を指す、自身が
    /// `uchg` のリンク」に差し替えて走らせる。保存が作った一時ファイルには元の flags / ACL が写って
    /// いるので、先に外してから消す。返り値=保存の結果(元が `uchg` か `deny delete` なら rename が
    /// 拒まれて Err=後始末が走る)。
    async fn save_with_tmp_swapped_to_locked_link(
        root: &Path,
        target: &Path,
    ) -> Result<(), FsError> {
        let tmp = tmp_path_for(target);
        let swap = {
            let (tmp, target) = (tmp.clone(), target.to_path_buf());
            move || {
                unlock_path(&tmp);
                fs::remove_file(&tmp).expect(
                    "fixture: the save's own temp file must be there and removable once unlocked",
                );
                symlink(&target, &tmp)
                    .expect("fixture: plant a link to the original at the temp file's name");
                lock_uchg_link(&tmp);
            }
        };
        let provider = LocalProvider::new();
        provider
            .write_text_within_root_with(&file_uri(target), "new\n", Some(root), swap)
            .await
    }

    /// 19. 元のファイルが `uchg` と `everyone deny delete` の両方を持つ: 後始末のあとも両方残る。
    #[tokio::test]
    async fn ac_48_j_c_original_keeps_uchg_and_acl_when_tmp_became_a_locked_link_to_it() {
        let root = TempDir::new().unwrap();
        let _unlock = UnlockOnDrop::new(&[root.path()]);
        let old = "old\n";
        let target = root.path().join("doc.md");
        fs::write(&target, old).unwrap();
        let acl_before = deny_delete(&target);
        lock_uchg(&target);
        let flags_before = flags_of(&target);

        let result = save_with_tmp_swapped_to_locked_link(root.path(), &target).await;
        assert!(
            result.is_err(),
            "the rename onto a locked original is refused, so the cleanup runs"
        );

        assert_ne!(
            flags_of(&target) & libc::UF_IMMUTABLE,
            0,
            "uchg must still be on the original: the cleanup must not follow the link (追補j(3))"
        );
        assert_eq!(
            flags_of(&target),
            flags_before,
            "the original's flags must be unchanged by the cleanup"
        );
        assert_eq!(
            acl_of(&target),
            acl_before,
            "the original's ACL must be unchanged: the cleanup must not follow the link (追補j(3))"
        );
        assert_bytes(&target, old);
        assert_regular_file(&target);
    }

    /// 20. 元のファイルが ACL(`deny delete`)だけ: 後始末が ACL を外す経路(`acl_set_link_np`)だけを捕まえる。
    #[tokio::test]
    async fn ac_48_j_c_original_keeps_acl_when_it_has_no_uchg() {
        let root = TempDir::new().unwrap();
        let _unlock = UnlockOnDrop::new(&[root.path()]);
        let old = "old\n";
        let target = root.path().join("acl-only.md");
        fs::write(&target, old).unwrap();
        let acl_before = deny_delete(&target);
        let flags_before = flags_of(&target);

        let result = save_with_tmp_swapped_to_locked_link(root.path(), &target).await;
        assert!(
            result.is_err(),
            "the rename is refused (deny delete / locked link)"
        );

        assert_eq!(
            acl_of(&target),
            acl_before,
            "the original's ACL must survive the cleanup (acl_set_file follows the link; acl_set_link_np does not)"
        );
        assert_eq!(flags_of(&target), flags_before);
        assert_bytes(&target, old);
    }

    /// 21. 元のファイルが `uchg` だけ: 後始末が flags を外す経路(`lchflags`)だけを捕まえる。
    #[tokio::test]
    async fn ac_48_j_c_original_keeps_uchg_when_it_has_no_acl() {
        let root = TempDir::new().unwrap();
        let _unlock = UnlockOnDrop::new(&[root.path()]);
        let old = "old\n";
        let target = root.path().join("uchg-only.md");
        fs::write(&target, old).unwrap();
        lock_uchg(&target);
        let flags_before = flags_of(&target);
        let acl_before = acl_of(&target);

        let result = save_with_tmp_swapped_to_locked_link(root.path(), &target).await;
        assert!(
            result.is_err(),
            "the rename onto a uchg original is refused"
        );

        assert_ne!(
            flags_of(&target) & libc::UF_IMMUTABLE,
            0,
            "uchg must survive the cleanup (chflags follows the link; lchflags does not)"
        );
        assert_eq!(flags_of(&target), flags_before);
        assert_eq!(acl_of(&target), acl_before);
        assert_bytes(&target, old);
    }

    /// 22. 差し替えられたリンクそのものは後始末で消える(追補f「失敗しても一時ファイルを残さない」の不変:
    ///     リンク自身の flags / ACL を外してから消す)。元のファイルは不変。
    #[tokio::test]
    async fn ac_48_j_c_cleanup_still_removes_the_swapped_link_itself() {
        let root = TempDir::new().unwrap();
        let _unlock = UnlockOnDrop::new(&[root.path()]);
        let old = "old\n";
        let target = root.path().join("doc.md");
        fs::write(&target, old).unwrap();
        let acl_before = deny_delete(&target);
        lock_uchg(&target);

        let result = save_with_tmp_swapped_to_locked_link(root.path(), &target).await;
        assert!(result.is_err());

        assert_no_tmp_leftovers(root.path());
        assert_eq!(acl_of(&target), acl_before);
        assert_ne!(flags_of(&target) & libc::UF_IMMUTABLE, 0);
        assert_bytes(&target, old);
    }
}
