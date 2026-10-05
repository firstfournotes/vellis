//! 要件#48 追補d の受け入れテスト(docs/requirements/req-48.md 追補d・backlog 270)— Rust 層
//!
//! 「ファイルへのシンボリックリンクを保存するとリンク先へ書く(リンクを置き換えない)」を固定する:
//! - **AC-48-21** リンクを辿って書く(追補d(1)): root の中の `b.md` を指すリンク `a.md` に
//!   `LocalProvider::write_text` で書くと、`a.md` はリンクのまま(`symlink_metadata` がリンク・
//!   `read_link` の中身は書く前と同じ)で、`b.md` の中身が書いた内容と byte 等価。
//!   リンクの連鎖・相対パスのリンク・別フォルダのリンク先・2回続けての保存でも同じ。
//!   一時ファイル(`.vellis-tmp` で終わる名前)はリンクのフォルダにもリンク先のフォルダにも残らない
//! - **AC-48-22** リンク切れへの書き込みは断る(追補d(2)): リンク先が無いリンクへの `write_text` は
//!   `Err`。リンクはリンクのまま残り(普通のファイルに置き換わらない)、リンク先も作られない。
//!   `ensure_within_root` もリンク切れとリンクのループ(`a.md` → `a.md`・`a.md` → `b.md` → `a.md`)を
//!   `Err` にし、`write_text` にループのリンクを渡しても `Err`(2026-10-04 追記)
//! - **AC-48-23** root の判定と書き先は同じパス(追補d(3)): `ensure_within_root` は root の中を指す
//!   リンクに対してリンク先の正規化したパスを返し、root の外を指すリンクは断る(AC-48-19 の回帰)。
//!   普通のファイルの書き込み(byte 等価・tmp を残さない・`..` を断る)は従来どおり(追補d(4)=非退行)
//!
//! ## 判定しないもの
//! - `save_document` が `ensure_within_root` の返り値を書き先として `write_text` に渡す配線
//!   (追補d(3))・保存前スナップショットが解決済みパスで取られること → reviewer 照合
//!   (`save_document` は Tauri の State / Window を要し、ここからは呼べない)
//! - 保存のあとに外部変更の衝突表示が出ないこと(契約⑥) → 人間ゲート(追補d(5))
//!
//! ## 実装前の見立て
//! - AC-48-21・22 は赤のはず: 現状の `write_text` はリンクのパスのフォルダに tmp を作り、
//!   リンクのパスへ `rename` する(`rename` はリンクを辿らない)ため、リンクが普通のファイルに
//!   置き換わり、リンク先は古いまま・リンク切れでも成功してしまう
//! - AC-48-23 と非退行は現状でも緑のはず(`ensure_within_root` は追補a から canonicalize 照合)
//!
//! エラーの variant は実装裁量(AC-48-22 は「エラーになる」だけが基準)なので `Err` であることのみ
//! 判定する。root 外拒否は既存 acceptance_req48.rs に合わせて Display の要旨で判定する。

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use tempfile::TempDir;
use vellis_lib::fs::local::{ensure_within_root, LocalProvider};
use vellis_lib::fs::provider::FileProvider;

/// ローカルの絶対パスを `file://` URI にする(既存テストの家風)。
fn file_uri(path: &Path) -> String {
    format!("file://{}", path.display())
}

/// `path` がシンボリックリンクのまま(辿らずに見てリンク)で、リンクの中身が `expected` のままか。
fn assert_still_symlink_to(path: &Path, expected: &Path) {
    let meta = fs::symlink_metadata(path)
        .unwrap_or_else(|e| panic!("{} must still exist as a symlink: {e}", path.display()));
    assert!(
        meta.file_type().is_symlink(),
        "{} must remain a symlink after write_text (it was replaced by a regular file)",
        path.display()
    );
    assert_eq!(
        fs::read_link(path).unwrap(),
        expected,
        "the link target of {} must be unchanged by write_text",
        path.display()
    );
}

/// `dir` に `.vellis-tmp` で終わる名前のエントリが残っていないか。
fn assert_no_tmp_leftovers(dir: &Path) {
    let leftovers: Vec<String> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("cannot list {}: {e}", dir.display()))
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".vellis-tmp"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "no `.vellis-tmp` file may remain in {}: {leftovers:?}",
        dir.display()
    );
}

/// `path` がリンク先に `expected` を byte 等価で持つか(読み戻しは provider を介さず素の fs)。
fn assert_bytes(path: &Path, expected: &str) {
    let on_disk = fs::read(path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    assert_eq!(
        on_disk,
        expected.as_bytes(),
        "bytes at {} must equal the written content exactly",
        path.display()
    );
}

/// root の中に `b.md`(中身 `old`)と、それを絶対パスで指すリンク `a.md` を作る。
/// 返り値 = (root, a.md のパス, b.md のパス)。
fn link_to_sibling(old: &str) -> (TempDir, PathBuf, PathBuf) {
    let root = TempDir::new().unwrap();
    let real = root.path().join("b.md");
    fs::write(&real, old).unwrap();
    let link = root.path().join("a.md");
    symlink(&real, &link).unwrap();
    (root, link, real)
}

// ---------------------------------------------------------------------------
// AC-48-21 — リンクを辿って書く(追補d(1)・backlog 270)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ac_48_21_write_through_symlink_updates_target_and_keeps_link() {
    let (root, link, real) = link_to_sibling("old body\n");
    let link_target_before = fs::read_link(&link).unwrap();
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&link), "new body\n")
        .await
        .expect("writing through a symlink to a file inside root must succeed");

    assert_still_symlink_to(&link, &link_target_before);
    assert_bytes(&real, "new body\n");
    // リンクを辿って読んでも同じ(リンクと実体が食い違わない)。
    assert_bytes(&link, "new body\n");
    assert_no_tmp_leftovers(root.path());
}

#[tokio::test]
async fn ac_48_21_write_through_symlink_is_byte_exact_for_crlf_and_bom() {
    // byte 等価の境界: BOM 付き・CRLF・末尾改行なし。リンク経由でも正規化されないこと。
    let content = "\u{FEFF}# heading\r\nline1\r\nno trailing newline";
    let (root, link, real) = link_to_sibling("old\n");
    let link_target_before = fs::read_link(&link).unwrap();
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&link), content)
        .await
        .expect("write through symlink must succeed");

    assert_still_symlink_to(&link, &link_target_before);
    assert_bytes(&real, content);
    assert_no_tmp_leftovers(root.path());
}

#[tokio::test]
async fn ac_48_21_write_through_symlink_chain_updates_final_target() {
    // a.md → c.md → b.md の連鎖。中間リンクも終端リンクも残り、実体 b.md だけが変わる。
    let root = TempDir::new().unwrap();
    let real = root.path().join("b.md");
    fs::write(&real, "old\n").unwrap();
    let mid = root.path().join("c.md");
    symlink(&real, &mid).unwrap();
    let link = root.path().join("a.md");
    symlink(&mid, &link).unwrap();
    let link_before = fs::read_link(&link).unwrap();
    let mid_before = fs::read_link(&mid).unwrap();
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&link), "via chain\n")
        .await
        .expect("write through a symlink chain must succeed");

    assert_still_symlink_to(&link, &link_before);
    assert_still_symlink_to(&mid, &mid_before);
    assert_bytes(&real, "via chain\n");
    assert_no_tmp_leftovers(root.path());
}

#[tokio::test]
async fn ac_48_21_write_through_relative_symlink_updates_target() {
    // リンクの中身が相対パス(`b.md`)。リンクのフォルダ基準で解決されること。
    let root = TempDir::new().unwrap();
    let real = root.path().join("b.md");
    fs::write(&real, "old\n").unwrap();
    let link = root.path().join("a.md");
    symlink("b.md", &link).unwrap();
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&link), "relative\n")
        .await
        .expect("write through a relative symlink must succeed");

    assert_still_symlink_to(&link, Path::new("b.md"));
    assert_bytes(&real, "relative\n");
    assert_no_tmp_leftovers(root.path());
}

#[tokio::test]
async fn ac_48_21_write_through_symlink_in_other_folder_updates_target_and_leaves_no_tmp_anywhere() {
    // x/a.md → ../y/b.md(別フォルダのリンク先・相対パス)。
    // 一時ファイルはリンクのフォルダ x にもリンク先のフォルダ y にも残らない。
    let root = TempDir::new().unwrap();
    let x = root.path().join("x");
    let y = root.path().join("y");
    fs::create_dir(&x).unwrap();
    fs::create_dir(&y).unwrap();
    let real = y.join("b.md");
    fs::write(&real, "old\n").unwrap();
    let link = x.join("a.md");
    symlink("../y/b.md", &link).unwrap();
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&link), "other folder\n")
        .await
        .expect("write through a symlink into another folder must succeed");

    assert_still_symlink_to(&link, Path::new("../y/b.md"));
    assert_bytes(&real, "other folder\n");
    assert_no_tmp_leftovers(&x);
    assert_no_tmp_leftovers(&y);
    // リンクのフォルダに実体ファイルが生えていない(x には a.md のリンクだけ)。
    let x_entries: Vec<String> = fs::read_dir(&x)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(x_entries, vec!["a.md".to_string()], "x/ must hold only the link");
}

#[tokio::test]
async fn ac_48_21_writing_through_symlink_twice_keeps_link_both_times() {
    // 2回続けて保存しても、1回目で実体になって2回目は普通の上書き、にならないこと。
    let (root, link, real) = link_to_sibling("v0\n");
    let link_before = fs::read_link(&link).unwrap();
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&link), "v1\n")
        .await
        .expect("first write through symlink must succeed");
    assert_still_symlink_to(&link, &link_before);
    assert_bytes(&real, "v1\n");

    provider
        .write_text(&file_uri(&link), "v2\n")
        .await
        .expect("second write through symlink must succeed");
    assert_still_symlink_to(&link, &link_before);
    assert_bytes(&real, "v2\n");
    assert_no_tmp_leftovers(root.path());
}

// ---------------------------------------------------------------------------
// AC-48-22 — リンク切れへの書き込みは断る(追補d(2))
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ac_48_22_write_to_dangling_symlink_fails_and_leaves_link_untouched() {
    let root = TempDir::new().unwrap();
    let missing = root.path().join("gone.md");
    assert!(!missing.exists());
    let link = root.path().join("a.md");
    symlink(&missing, &link).unwrap();
    let link_before = fs::read_link(&link).unwrap();
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&link), "must not land anywhere")
        .await
        .expect_err("writing to a dangling symlink must be refused");

    // リンクはリンクのまま(普通のファイルに置き換わっていない)。
    assert_still_symlink_to(&link, &link_before);
    // リンク先は作られていない(辿らずに見ても、辿って見ても無い)。
    assert!(
        fs::symlink_metadata(&missing).is_err(),
        "the missing link target must not be created by a refused write"
    );
    assert!(
        !link.exists(),
        "the link must still dangle (following it must find nothing)"
    );
    assert_no_tmp_leftovers(root.path());
}

#[tokio::test]
async fn ac_48_22_write_to_dangling_relative_symlink_into_other_folder_fails_and_creates_nothing() {
    // x/a.md → ../y/gone.md(y はあるがファイルは無い)。y にも x にも何も生えない。
    let root = TempDir::new().unwrap();
    let x = root.path().join("x");
    let y = root.path().join("y");
    fs::create_dir(&x).unwrap();
    fs::create_dir(&y).unwrap();
    let link = x.join("a.md");
    symlink("../y/gone.md", &link).unwrap();
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&link), "must not land anywhere")
        .await
        .expect_err("writing to a dangling symlink must be refused");

    assert_still_symlink_to(&link, Path::new("../y/gone.md"));
    assert!(
        fs::symlink_metadata(y.join("gone.md")).is_err(),
        "the missing link target must not be created"
    );
    assert_no_tmp_leftovers(&x);
    assert_no_tmp_leftovers(&y);
    let y_entries = fs::read_dir(&y).unwrap().count();
    assert_eq!(y_entries, 0, "y/ must stay empty after a refused write");
}

// AC-48-22(追記・2026-10-04)— `ensure_within_root` もリンク切れとリンクのループを断る
// (判定の時点でリンクのパスを書き先として返すと、判定のあとにリンク先が root の外に
// 作られたときに外へ書く余地が残るため=追補d(2) 実装時のオーケストレーター判断)

#[test]
fn ac_48_22_ensure_within_root_rejects_dangling_symlink_inside_root() {
    let root = TempDir::new().unwrap();
    let missing = root.path().join("gone.md");
    let link = root.path().join("a.md");
    symlink(&missing, &link).unwrap();
    let link_before = fs::read_link(&link).unwrap();

    ensure_within_root(root.path(), &link)
        .expect_err("a dangling symlink must be refused, not treated as a first save");

    // 判定は読み取りだけ: リンクはそのまま・リンク先も作られない。
    assert_still_symlink_to(&link, &link_before);
    assert!(fs::symlink_metadata(&missing).is_err(), "link target must not be created");
}

#[test]
fn ac_48_22_ensure_within_root_rejects_self_referencing_symlink() {
    // a.md → a.md(自分を指すループ)。canonicalize が ELOOP で失敗する形。
    let root = TempDir::new().unwrap();
    let link = root.path().join("a.md");
    symlink("a.md", &link).unwrap();

    ensure_within_root(root.path(), &link)
        .expect_err("a self-referencing symlink must be refused");

    assert_still_symlink_to(&link, Path::new("a.md"));
}

#[test]
fn ac_48_22_ensure_within_root_rejects_two_link_loop() {
    // a.md → b.md → a.md(2つで回るループ)。
    let root = TempDir::new().unwrap();
    let a = root.path().join("a.md");
    let b = root.path().join("b.md");
    symlink("b.md", &a).unwrap();
    symlink("a.md", &b).unwrap();

    ensure_within_root(root.path(), &a)
        .expect_err("a symlink loop must be refused");

    assert_still_symlink_to(&a, Path::new("b.md"));
    assert_still_symlink_to(&b, Path::new("a.md"));
}

#[tokio::test]
async fn ac_48_22_write_to_symlink_loop_fails_and_creates_nothing() {
    // write_text にループのリンクを渡しても Err。両リンクはそのまま・tmp も実体も生えない。
    let root = TempDir::new().unwrap();
    let a = root.path().join("a.md");
    let b = root.path().join("b.md");
    symlink("b.md", &a).unwrap();
    symlink("a.md", &b).unwrap();
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&a), "must not land anywhere")
        .await
        .expect_err("writing to a symlink loop must be refused");

    assert_still_symlink_to(&a, Path::new("b.md"));
    assert_still_symlink_to(&b, Path::new("a.md"));
    assert_no_tmp_leftovers(root.path());
    let mut entries: Vec<String> = fs::read_dir(root.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    entries.sort();
    assert_eq!(
        entries,
        vec!["a.md".to_string(), "b.md".to_string()],
        "only the two links may remain in root"
    );
}

// ---------------------------------------------------------------------------
// AC-48-23 — root の判定と書き先は同じパス(追補d(3))・非退行(追補d(4))
// ---------------------------------------------------------------------------

/// Err の要旨が permission denied / forbidden 系か(variant 名は実装裁量・既存テストと同じ判定)。
fn assert_forbidden_class(err: impl std::fmt::Display) {
    let msg = err.to_string().to_lowercase();
    assert!(
        msg.contains("permission denied") || msg.contains("forbidden"),
        "rejection should be a permission-denied/forbidden class error, got: {msg}"
    );
}

#[test]
fn ac_48_23_ensure_within_root_returns_canonical_link_target_for_symlink_inside_root() {
    let (root, link, real) = link_to_sibling("body\n");

    let resolved = ensure_within_root(root.path(), &link)
        .expect("a symlink pointing inside root must be accepted");

    // 返り値はリンクのパスではなく、リンク先の正規化したパス(= 書き先)。
    assert_eq!(resolved, fs::canonicalize(&real).unwrap());
    assert_ne!(
        resolved,
        fs::canonicalize(root.path()).unwrap().join("a.md"),
        "the resolved path must be the link target, not the link itself"
    );
}

#[test]
fn ac_48_23_ensure_within_root_resolves_relative_symlink_in_other_folder_to_target() {
    let root = TempDir::new().unwrap();
    let x = root.path().join("x");
    let y = root.path().join("y");
    fs::create_dir(&x).unwrap();
    fs::create_dir(&y).unwrap();
    let real = y.join("b.md");
    fs::write(&real, "body\n").unwrap();
    let link = x.join("a.md");
    symlink("../y/b.md", &link).unwrap();

    let resolved = ensure_within_root(root.path(), &link)
        .expect("a relative symlink into another folder under root must be accepted");

    assert_eq!(resolved, fs::canonicalize(&real).unwrap());
}

#[test]
fn ac_48_23_ensure_within_root_still_rejects_symlink_pointing_outside_root() {
    // AC-48-19 の回帰: リンクを辿るようになっても root 外を指すリンクは断る。
    let root = TempDir::new().unwrap();
    let other = TempDir::new().unwrap();
    let outside = other.path().join("secret.md");
    fs::write(&outside, "outside").unwrap();
    let link = root.path().join("looks-inside.md");
    symlink(&outside, &link).unwrap();

    let err = ensure_within_root(root.path(), &link)
        .expect_err("a symlink escaping root must be rejected");
    assert_forbidden_class(err);
}

#[tokio::test]
async fn ac_48_23_plain_file_write_is_still_byte_exact_and_leaves_no_tmp() {
    // 非退行(追補d(4)): 普通のファイルは従来どおり byte 等価・tmp を残さない。
    let root = TempDir::new().unwrap();
    let target = root.path().join("plain.md");
    fs::write(&target, "old\n").unwrap();
    let content = "\u{FEFF}plain\r\nfile\r\n";
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&target), content)
        .await
        .expect("plain file write must still succeed");

    assert_bytes(&target, content);
    assert!(
        !fs::symlink_metadata(&target).unwrap().file_type().is_symlink(),
        "a plain file must stay a plain file"
    );
    assert_no_tmp_leftovers(root.path());
    let entries: Vec<String> = fs::read_dir(root.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries, vec!["plain.md".to_string()], "only the target may remain");
}

#[tokio::test]
async fn ac_48_23_plain_file_write_still_rejects_parent_dir_components() {
    // 非退行(追補d(4)): `..` を含むパスは従来どおり断り、何も書かない。
    let root = TempDir::new().unwrap();
    let sub = root.path().join("sub");
    fs::create_dir(&sub).unwrap();
    let provider = LocalProvider::new();

    let escaping = format!("{}/sub/../escaped.md", file_uri(root.path()));
    let err = provider
        .write_text(&escaping, "must not be written")
        .await
        .expect_err("a path containing `..` must still be rejected");
    assert_forbidden_class(err);

    assert!(
        !root.path().join("escaped.md").exists(),
        "rejected write must not create the target file"
    );
    assert_no_tmp_leftovers(root.path());
    assert_no_tmp_leftovers(&sub);
}
