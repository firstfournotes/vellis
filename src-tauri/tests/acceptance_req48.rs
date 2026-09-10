//! 要件#48 の受け入れテスト(requirements.md #48)— Rust 層
//!
//! 「閲覧専用(FR-02)撤廃の第1段」のうち契約①=保存経路を固定する:
//! - `FileProvider` trait の `write_text(uri, content)`(既定実装なし=全実装が明示)
//! - `LocalProvider`: tmp+rename の atomic write。書き込み後に読み戻すと
//!   **byte 等価**(改行始まり・末尾改行なし・CRLF・BOM 付き UTF-8 の4ケース)。
//!   tmp ファイルを残さない。`..` を含むパスは拒否
//! - `SshProvider`: 初版は書き込み不可(Unsupported 系エラー)=SSH root は
//!   読み取り専用のまま
//! - コマンド `save_document` が invoke_handler に登録されていること
//!   (menu 系の前例=acceptance_req35.rs の include_str! 方式)
//!
//! ## 判定しないもの
//! - 保存前の SnapshotManager スナップショット(契約⑤)・コマンド層の配線の実体
//!   → reviewer 照合(コマンド層はここでは登録名の存在のみ判定)
//! - フロントの編集 UI・エコー抑止 → src/lib/document-edit.acceptance.test.ts /
//!   src/components/Viewer.edit.wiring.test.ts
//! - ⌘S メニュー・実機の保存体感 → 人間ゲート(acceptance/acceptance.md)
//!
//! エラーの variant 名は実装裁量(既存 `PermissionDenied` か新 variant)なので、
//! ここでは `Display` 文字列の要旨(permission denied / forbidden / unsupported)で
//! 判定する(variant 追加の自由度を残しつつ、成功で握り潰す実装は赤にする)。

use std::fs;

use tempfile::TempDir;
use vellis_lib::fs::local::LocalProvider;
use vellis_lib::fs::provider::FileProvider;
use vellis_lib::fs::ssh::SshProvider;

/// ローカルの絶対パスを `file://` URI にする(既存テストの家風)。
fn file_uri(path: &std::path::Path) -> String {
    format!("file://{}", path.display())
}

// ---------------------------------------------------------------------------
// LocalProvider::write_text — byte 等価ラウンドトリップ(契約①②の境界4ケース)
// ---------------------------------------------------------------------------

/// 書いた内容がディスク上で byte 等価か(読み戻しは provider を介さず素の fs=
/// 「本当にそのバイト列で保存されたか」を判定する)。
async fn roundtrip(content: &str) {
    let tmp = TempDir::new().unwrap();
    let target = tmp.path().join("note.txt");
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&target), content)
        .await
        .expect("write_text should succeed for a plain file in a writable dir");

    let on_disk = fs::read(&target).unwrap();
    assert_eq!(
        on_disk,
        content.as_bytes(),
        "written bytes must equal the input exactly (no normalization)"
    );
}

#[tokio::test]
async fn write_text_roundtrips_leading_newline() {
    // 改行始まり: renderPlainText の `<pre>` 直後 `\n` と対になる境界。
    roundtrip("\nfirst line was empty\nsecond\n").await;
}

#[tokio::test]
async fn write_text_roundtrips_no_trailing_newline() {
    roundtrip("no trailing newline").await;
}

#[tokio::test]
async fn write_text_roundtrips_crlf() {
    // CRLF を LF へ潰さない(byte 等価)。
    roundtrip("line1\r\nline2\r\n").await;
}

#[tokio::test]
async fn write_text_roundtrips_utf8_bom() {
    // BOM 付き UTF-8: 先頭 EF BB BF が残ること。
    roundtrip("\u{FEFF}# bom heading\nbody\n").await;
}

// ---------------------------------------------------------------------------
// LocalProvider::write_text — 上書きと atomic write の痕跡(契約①)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn write_text_overwrites_existing_file_and_leaves_no_tmp() {
    let tmp = TempDir::new().unwrap();
    let target = tmp.path().join("note.txt");
    fs::write(&target, "old content\n").unwrap();
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&target), "new content\n")
        .await
        .expect("overwrite should succeed");

    assert_eq!(fs::read(&target).unwrap(), b"new content\n");

    // tmp+rename の後始末: ディレクトリに残るのは対象ファイルだけ
    // (中間 tmp ファイルの置き忘れは atomic write の実装不備)。
    let leftovers: Vec<String> = fs::read_dir(tmp.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name != "note.txt")
        .collect();
    assert!(
        leftovers.is_empty(),
        "no temp files should remain after write: {leftovers:?}"
    );
}

// ---------------------------------------------------------------------------
// LocalProvider::write_text — パス脱出の拒否(契約①)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn write_text_rejects_parent_dir_components() {
    let tmp = TempDir::new().unwrap();
    let sub = tmp.path().join("sub");
    fs::create_dir(&sub).unwrap();
    let provider = LocalProvider::new();

    // `..` を含むパスは拒否(snapshot.rs `resolve_source` の型=ParentDir 成分を弾く)。
    let escaping = format!("{}/sub/../escaped.txt", file_uri(tmp.path()));
    let err = provider
        .write_text(&escaping, "must not be written")
        .await
        .expect_err("a path containing `..` must be rejected");

    let msg = err.to_string().to_lowercase();
    assert!(
        msg.contains("permission denied") || msg.contains("forbidden"),
        "rejection should be a permission-denied/forbidden class error, got: {msg}"
    );

    // 拒否は書き込み前に効くこと(脱出先にファイルができていない)。
    assert!(
        !tmp.path().join("escaped.txt").exists(),
        "rejected write must not create the target file"
    );
}

// ---------------------------------------------------------------------------
// SshProvider::write_text — 初版は Unsupported(契約①=SSH root は読み取り専用)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ssh_write_text_is_unsupported() {
    let provider = SshProvider::new();

    let err = provider
        .write_text("ssh://user@host/notes/memo.txt", "content")
        .await
        .expect_err("SSH write must fail as unsupported (no network attempt needed)");

    let msg = err.to_string().to_lowercase();
    assert!(
        msg.contains("unsupported"),
        "SSH write should report an unsupported-class error, got: {msg}"
    );
}

// ---------------------------------------------------------------------------
// コマンド登録 — save_document(契約①⑤のコマンド面・登録名のみ)
// ---------------------------------------------------------------------------

#[test]
fn save_document_command_is_registered() {
    // invoke_handler の generate_handler! リストに載っていること
    // (webdriver / 通常ビルドの両リストがある lib.rs 全文で判定)。
    let source = include_str!("../src/lib.rs");
    assert!(
        source.contains("save_document"),
        "lib.rs must register the `save_document` command"
    );
}

// ---------------------------------------------------------------------------
// ensure_within_root — root 外拒否の照合純関数(契約①・追補a=2026-09-05
// オーケストレーター記帳。provider 層は `..` 拒否のみ・root 照合はコマンド層
// `save_document` がウインドウセッションの root とこの関数で照合する)
// ---------------------------------------------------------------------------

use std::path::Path;

use vellis_lib::fs::local::ensure_within_root;

/// Err の要旨が permission denied / forbidden 系か(variant 名は実装裁量)。
fn assert_forbidden_class(err: impl std::fmt::Display) {
    let msg = err.to_string().to_lowercase();
    assert!(
        msg.contains("permission denied") || msg.contains("forbidden"),
        "rejection should be a permission-denied/forbidden class error, got: {msg}"
    );
}

#[test]
fn ensure_within_root_accepts_existing_file_under_root() {
    let root = TempDir::new().unwrap();
    let target = root.path().join("notes").join("memo.txt");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(&target, "body").unwrap();

    let resolved = ensure_within_root(root.path(), &target)
        .expect("a file under root must be accepted");

    // 返り値は正規化パス(macOS の /var → /private/var も吸収して比較する)。
    assert_eq!(resolved, fs::canonicalize(&target).unwrap());
}

#[test]
fn ensure_within_root_rejects_absolute_path_outside_root() {
    let root = TempDir::new().unwrap();
    let other = TempDir::new().unwrap();
    let outside = other.path().join("outside.txt");
    fs::write(&outside, "elsewhere").unwrap();

    let err = ensure_within_root(root.path(), &outside)
        .expect_err("an absolute path outside root must be rejected");
    assert_forbidden_class(err);
}

#[test]
fn ensure_within_root_rejects_parent_dir_escape() {
    let root = TempDir::new().unwrap();
    let sub = root.path().join("sub");
    fs::create_dir(&sub).unwrap();
    // root/sub/../../escaped.txt = root の1つ上へ脱出するパス。
    let escaping = sub.join("..").join("..").join("escaped.txt");

    let err = ensure_within_root(root.path(), &escaping)
        .expect_err("a `..` escape out of root must be rejected");
    assert_forbidden_class(err);
}

#[test]
fn ensure_within_root_rejects_symlink_pointing_outside_root() {
    let root = TempDir::new().unwrap();
    let other = TempDir::new().unwrap();
    let real_outside = other.path().join("secret.txt");
    fs::write(&real_outside, "outside").unwrap();
    let link = root.path().join("looks-inside.txt");
    std::os::unix::fs::symlink(&real_outside, &link).unwrap();

    // 文字列上は root 配下でも、canonicalize すると root 外 → 拒否
    // (symlink 経由の脱出を許すと root 制約が意味を失う)。
    let err = ensure_within_root(root.path(), &link)
        .expect_err("a symlink escaping root must be rejected");
    assert_forbidden_class(err);
}

#[test]
fn ensure_within_root_accepts_new_file_under_root() {
    let root = TempDir::new().unwrap();
    let target = root.path().join("brand-new.txt");
    assert!(!target.exists());

    // 新規保存(未作成ファイル)は親ディレクトリの canonicalize で照合して受理。
    let resolved = ensure_within_root(root.path(), &target)
        .expect("a not-yet-created file under root must be accepted (new save)");

    let canonical_root = fs::canonicalize(root.path()).unwrap();
    assert_eq!(
        resolved.parent(),
        Some(canonical_root.as_path()),
        "resolved path should live directly under the canonicalized root"
    );
    assert_eq!(resolved.file_name().unwrap(), "brand-new.txt");
}

// `ensure_within_root(&Path, &Path) -> Result<PathBuf, FsError>` のシグネチャ固定
// (追補a)。型レベルの参照でズレをコンパイルエラーにする。
#[allow(dead_code)]
fn _ensure_within_root_signature(
) -> fn(&Path, &Path) -> Result<std::path::PathBuf, vellis_lib::errors::FsError> {
    ensure_within_root
}
