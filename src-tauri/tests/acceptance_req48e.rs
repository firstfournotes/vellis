//! 要件#48 追補e の受け入れテスト(docs/requirements/req-48.md 追補e・backlog 274)— Rust 層
//!
//! 「保存(tmp+rename)で元のファイルの権限・ACL・拡張属性(Finder タグを含む)を保つ」を固定する:
//! - **AC-48-24** 権限を保つ(追補e(1)): `0o755`(実行ビット付き)と `0o600` の既存ファイルへ
//!   `LocalProvider::write_text` で書くと、書いたあとも権限(モード)が同じ。
//!   中身は byte 等価・`.vellis-tmp` は残らない。2回続けて保存しても同じ
//! - **AC-48-25** 拡張属性と ACL を保つ(追補e(1)): 任意の名前の拡張属性(NUL / 0xFF を含む
//!   バイナリ値)と Finder タグ `com.apple.metadata:_kMDItemUserTags` を持つファイル、
//!   ACL(`chmod +a`)を持つファイルへ書くと、書いたあとも同じ拡張属性(名前と値)・同じ ACL を持つ
//! - **AC-48-26** リンクを通した保存でも実体の属性を保つ(追補e(2)・追補d): 権限と拡張属性を持つ
//!   実体 `b.md` を指すリンク `a.md` へ書くと、`a.md` はリンクのまま・`b.md` の権限と拡張属性は同じ
//! - **AC-48-27** 最初の保存と不変(追補e(3)(4)): まだ無いファイルへの `write_text` は従来どおり
//!   成功する(写す元が無い)。byte 等価・tmp を残さない・`..` を断る
//! - **AC-48-28** 更新日時は保存の時刻(追補e(1)・2026-10-05 追記): 更新日時を過去(2020-01-01)に
//!   設定した既存のファイルへ書くと、書いたあとの更新日時は書く直前に控えた時刻以降になる
//!   (元の日時が写らない)。権限は AC-48-24 のとおり保たれる。リンクを通した保存でも実体 `b.md` が同じ。
//!   実装前(HEAD 53d7d97)の tmp+rename は新しいファイルになるため最初から緑で、この AC は
//!   「属性を写す実装が日時まで写して戻し忘れる」退行を捕まえるためのもの(`copyfile` の
//!   `COPYFILE_METADATA` は STAT=更新日時も含む)
//!
//! ## 判定しないもの
//! - 写すのに失敗したとき保存を続けてログに残すこと(追補e(3))→ 権限の都合で写せない状況を
//!   テスト内で安定して作れないため reviewer 照合(実装内のコメント / ログ出力で確認)
//! - `copyfile(3)` の `COPYFILE_METADATA` を使うこと(手段の指定)→ reviewer 照合。
//!   ここでは結果(権限・拡張属性・ACL が同じ)だけを判定する
//! - ハードリンクの別名が古い内容のまま残ること(追補e(4)=今のまま)→ 判定しない(由谷決定の不変)
//!
//! ## 実装前の見立て
//! - AC-48-24〜26 は赤のはず: 現状の `write_then_rename` は `File::create` で umask 既定
//!   (多くは `0o644`)の一時ファイルを作り、拡張属性も ACL も写さずに `rename` する
//! - AC-48-27 は現状でも緑のはず(非退行)
//!
//! ## 注意(テスト作成時の確認・2026-10-05)
//! - 要件本文の例 `everyone deny delete` は **`rename` そのものを Permission denied にする**
//!   (置き換え=削除の扱い)ため、実装に関係なく保存が失敗する。ここでは rename を妨げない ACL
//!   (`everyone deny chown`・`everyone allow read`)で「ACL を保つ」を判定する
//! - `com.apple.provenance` はファイル作成時に OS が付ける属性で、作成経路によって有無が変わる。
//!   利用者の属性ではないので、拡張属性の比較からはこの名前だけ除く
//! - 拡張属性・ACL は macOS 前提(`#[cfg(target_os = "macos")]`)。拡張属性の読み書きは
//!   既存の依存 `libc`(`setxattr` / `getxattr` / `listxattr`)、ACL は `chmod +a` と `ls -le`

#![cfg(unix)]

use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};

use tempfile::TempDir;
use vellis_lib::fs::local::LocalProvider;
use vellis_lib::fs::provider::FileProvider;

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
        "bytes at {} must equal the written content exactly",
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

/// 権限ビット(モードの下 12 ビット=rwx + setuid/setgid/sticky)。リンクは辿る。
fn mode_of(path: &Path) -> u32 {
    fs::metadata(path)
        .unwrap_or_else(|e| panic!("cannot stat {}: {e}", path.display()))
        .permissions()
        .mode()
        & 0o7777
}

/// `path` に `mode` を付け、付いたことを確かめる(フィクスチャ側の前提が崩れていたら即 panic)。
fn set_mode(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .unwrap_or_else(|e| panic!("cannot chmod {}: {e}", path.display()));
    assert_eq!(
        mode_of(path),
        mode,
        "fixture: mode {mode:o} must be set on {} before writing",
        path.display()
    );
}

/// `dir` に中身 `old`・モード `mode` のファイル `name` を作る。
fn file_with_mode(dir: &Path, name: &str, old: &str, mode: u32) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, old).unwrap();
    set_mode(&path, mode);
    path
}

// ---------------------------------------------------------------------------
// 拡張属性(macOS・既存の依存 libc の setxattr / getxattr / listxattr)
// ---------------------------------------------------------------------------

/// Finder タグの属性名。
#[cfg(target_os = "macos")]
const FINDER_TAGS_XATTR: &str = "com.apple.metadata:_kMDItemUserTags";

/// Finder タグ「Red」(色 6)1つのバイナリ plist(`plutil -convert binary1` の出力・50 bytes)。
#[cfg(target_os = "macos")]
const FINDER_TAG_RED: &[u8] = &[
    0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30, 0xa1, 0x01, 0x55, 0x52, 0x65, 0x64, 0x0a, 0x36,
    0x08, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x10,
];

/// 任意の名前の属性と、NUL と 0xFF を含むバイナリ値(bytes が逐語に戻ることを判定するため)。
#[cfg(target_os = "macos")]
const CUSTOM_XATTR_NAME: &str = "jp.firstfournotes.vellis.test";
#[cfg(target_os = "macos")]
const CUSTOM_XATTR_VALUE: &[u8] = b"vellis\x00\xff\x01 keep me";

/// OS がファイル作成時に付ける属性。利用者の属性ではないので比較から除く(モジュール doc 参照)。
#[cfg(target_os = "macos")]
const SYSTEM_XATTRS_IGNORED: &[&str] = &["com.apple.provenance"];

#[cfg(target_os = "macos")]
fn c_path(path: &Path) -> std::ffi::CString {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap()
}

/// `path` に拡張属性を付ける(リンクは辿る)。
#[cfg(target_os = "macos")]
fn set_xattr(path: &Path, name: &str, value: &[u8]) {
    let p = c_path(path);
    let n = std::ffi::CString::new(name).unwrap();
    // SAFETY: すべての引数は有効な NUL 終端文字列 / バッファで、長さを正しく渡している。
    let rc = unsafe {
        libc::setxattr(
            p.as_ptr(),
            n.as_ptr(),
            value.as_ptr() as *const libc::c_void,
            value.len(),
            0,
            0,
        )
    };
    assert_eq!(
        rc,
        0,
        "fixture: setxattr({name}) on {} failed: {}",
        path.display(),
        std::io::Error::last_os_error()
    );
}

/// `path` の拡張属性 `name` の値。無ければ `None`。
#[cfg(target_os = "macos")]
fn get_xattr(path: &Path, name: &str) -> Option<Vec<u8>> {
    let p = c_path(path);
    let n = std::ffi::CString::new(name).unwrap();
    // SAFETY: サイズ問い合わせ(buf = NULL, size = 0)→ 実バッファの 2 段呼び出し。
    let size = unsafe { libc::getxattr(p.as_ptr(), n.as_ptr(), std::ptr::null_mut(), 0, 0, 0) };
    if size < 0 {
        return None;
    }
    let mut buf = vec![0u8; size as usize];
    let got = unsafe {
        libc::getxattr(
            p.as_ptr(),
            n.as_ptr(),
            buf.as_mut_ptr() as *mut libc::c_void,
            buf.len(),
            0,
            0,
        )
    };
    if got < 0 {
        return None;
    }
    buf.truncate(got as usize);
    Some(buf)
}

/// `path` の拡張属性(名前 → 値)。`SYSTEM_XATTRS_IGNORED` は除く。
#[cfg(target_os = "macos")]
fn xattrs_of(path: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    let p = c_path(path);
    // SAFETY: サイズ問い合わせ → 実バッファの 2 段呼び出し。
    let size = unsafe { libc::listxattr(p.as_ptr(), std::ptr::null_mut(), 0, 0) };
    assert!(
        size >= 0,
        "listxattr on {} failed: {}",
        path.display(),
        std::io::Error::last_os_error()
    );
    let mut buf = vec![0u8; size as usize];
    let got = unsafe { libc::listxattr(p.as_ptr(), buf.as_mut_ptr() as *mut libc::c_char, buf.len(), 0) };
    assert!(got >= 0, "listxattr on {} failed (2nd call)", path.display());
    buf.truncate(got as usize);

    buf.split(|b| *b == 0)
        .filter(|chunk| !chunk.is_empty())
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .filter(|name| !SYSTEM_XATTRS_IGNORED.contains(&name.as_str()))
        .map(|name| {
            let value = get_xattr(path, &name)
                .unwrap_or_else(|| panic!("xattr {name} listed but unreadable on {}", path.display()));
            (name, value)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// ACL(macOS・chmod +a / ls -le)
// ---------------------------------------------------------------------------

/// `path` に ACL エントリを足す(`chmod +a "<entry>" path`)。
#[cfg(target_os = "macos")]
fn add_acl(path: &Path, entry: &str) {
    let out = std::process::Command::new("/bin/chmod")
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

/// `ls -le path` の ACL 行(` 0: group:everyone deny chown` の形)を番号を除いて集める。
#[cfg(target_os = "macos")]
fn acl_of(path: &Path) -> Vec<String> {
    let out = std::process::Command::new("/bin/ls")
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

// ---------------------------------------------------------------------------
// AC-48-24 — 権限を保つ(追補e(1)・backlog 274)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ac_48_24_write_text_keeps_executable_mode_0o755() {
    let root = TempDir::new().unwrap();
    let target = file_with_mode(root.path(), "run.sh", "#!/bin/sh\necho old\n", 0o755);
    let content = "#!/bin/sh\necho new\n";
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&target), content)
        .await
        .expect("writing to an executable file must succeed");

    assert_eq!(
        mode_of(&target),
        0o755,
        "mode 0o755 (execute bits) must survive a save (tmp+rename must copy the mode)"
    );
    assert_bytes(&target, content);
    assert_no_tmp_leftovers(root.path());
}

#[tokio::test]
async fn ac_48_24_write_text_keeps_private_mode_0o600() {
    let root = TempDir::new().unwrap();
    let target = file_with_mode(root.path(), "secret.md", "old secret\n", 0o600);
    let content = "new secret\n";
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&target), content)
        .await
        .expect("writing to an owner-only file must succeed");

    assert_eq!(
        mode_of(&target),
        0o600,
        "mode 0o600 must survive a save (a umask-default 0o644 would widen it to group/others)"
    );
    assert_bytes(&target, content);
    assert_no_tmp_leftovers(root.path());
}

#[tokio::test]
async fn ac_48_24_mode_survives_two_consecutive_saves_and_is_byte_exact() {
    // 保存のたびに落ちていた不具合なので、2回続けても同じであることを固定する。
    // byte 等価の境界(BOM・CRLF・末尾改行なし)も実行ビット付きで併せて判定する。
    let root = TempDir::new().unwrap();
    let target = file_with_mode(root.path(), "tool.sh", "old\n", 0o755);
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&target), "first\n")
        .await
        .expect("first save must succeed");
    assert_eq!(mode_of(&target), 0o755, "mode must survive the first save");

    let content = "\u{FEFF}second\r\nno trailing newline";
    provider
        .write_text(&file_uri(&target), content)
        .await
        .expect("second save must succeed");

    assert_eq!(mode_of(&target), 0o755, "mode must survive the second save too");
    assert_bytes(&target, content);
    assert_no_tmp_leftovers(root.path());
}

// ---------------------------------------------------------------------------
// AC-48-25 — 拡張属性と ACL を保つ(追補e(1))
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
#[tokio::test]
async fn ac_48_25_write_text_keeps_custom_xattr_name_and_binary_value() {
    let root = TempDir::new().unwrap();
    let target = root.path().join("tagged.md");
    fs::write(&target, "old\n").unwrap();
    set_xattr(&target, CUSTOM_XATTR_NAME, CUSTOM_XATTR_VALUE);
    let before = xattrs_of(&target);
    assert_eq!(
        before.get(CUSTOM_XATTR_NAME).map(Vec::as_slice),
        Some(CUSTOM_XATTR_VALUE),
        "fixture: the custom xattr must be set before writing"
    );
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&target), "new\n")
        .await
        .expect("writing to a file with an xattr must succeed");

    assert_eq!(
        get_xattr(&target, CUSTOM_XATTR_NAME).as_deref(),
        Some(CUSTOM_XATTR_VALUE),
        "the custom xattr (name and exact bytes, including NUL and 0xFF) must survive a save"
    );
    assert_eq!(
        xattrs_of(&target),
        before,
        "the set of extended attributes must be the same after a save"
    );
    assert_bytes(&target, "new\n");
    assert_no_tmp_leftovers(root.path());
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn ac_48_25_write_text_keeps_finder_tags() {
    let root = TempDir::new().unwrap();
    let target = root.path().join("notes.md");
    fs::write(&target, "old\n").unwrap();
    set_xattr(&target, FINDER_TAGS_XATTR, FINDER_TAG_RED);
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&target), "new\n")
        .await
        .expect("writing to a Finder-tagged file must succeed");

    assert_eq!(
        get_xattr(&target, FINDER_TAGS_XATTR).as_deref(),
        Some(FINDER_TAG_RED),
        "the Finder tag ({FINDER_TAGS_XATTR}) must survive a save, byte for byte"
    );
    assert_bytes(&target, "new\n");
    assert_no_tmp_leftovers(root.path());
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn ac_48_25_write_text_keeps_acl_entries() {
    // 要件本文の例 `everyone deny delete` は rename 自体を拒むので使えない(モジュール doc 参照)。
    // rename を妨げない deny と allow を 1 つずつ付け、両方が同じ順で残ることを判定する。
    let root = TempDir::new().unwrap();
    let target = root.path().join("acl.md");
    fs::write(&target, "old\n").unwrap();
    add_acl(&target, "everyone deny chown");
    add_acl(&target, "everyone allow read");
    let before = acl_of(&target);
    assert_eq!(before.len(), 2, "fixture: two ACL entries must be present before writing: {before:?}");
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&target), "new\n")
        .await
        .expect("writing to a file with an ACL must succeed");

    let after = acl_of(&target);
    assert_eq!(
        after, before,
        "the ACL entries must be the same after a save (a fresh tmp file has none)"
    );
    assert_bytes(&target, "new\n");
    assert_no_tmp_leftovers(root.path());
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn ac_48_25_write_text_keeps_mode_xattrs_and_acl_together() {
    // 権限・拡張属性(任意+Finder タグ)・ACL を 1 つのファイルに同時に持たせ、すべて残ることを判定する。
    let root = TempDir::new().unwrap();
    let target = file_with_mode(root.path(), "all.sh", "#!/bin/sh\nold\n", 0o755);
    set_xattr(&target, CUSTOM_XATTR_NAME, CUSTOM_XATTR_VALUE);
    set_xattr(&target, FINDER_TAGS_XATTR, FINDER_TAG_RED);
    add_acl(&target, "everyone deny chown");
    let xattrs_before = xattrs_of(&target);
    let acl_before = acl_of(&target);
    assert_eq!(xattrs_before.len(), 2, "fixture: both xattrs must be present: {xattrs_before:?}");
    assert_eq!(acl_before.len(), 1, "fixture: the ACL entry must be present: {acl_before:?}");
    let provider = LocalProvider::new();

    let content = "#!/bin/sh\nnew\n";
    provider
        .write_text(&file_uri(&target), content)
        .await
        .expect("writing must succeed");

    assert_eq!(mode_of(&target), 0o755, "mode must be kept");
    assert_eq!(xattrs_of(&target), xattrs_before, "extended attributes must be kept");
    assert_eq!(acl_of(&target), acl_before, "ACL must be kept");
    assert_bytes(&target, content);
    assert_no_tmp_leftovers(root.path());
}

// ---------------------------------------------------------------------------
// AC-48-26 — リンクを通した保存でも実体の属性を保つ(追補e(2)・追補d)
// ---------------------------------------------------------------------------

/// `path` がシンボリックリンクのまま(辿らずに見てリンク)で、リンクの中身が `expected` のままか。
fn assert_still_symlink_to(path: &Path, expected: &Path) {
    let meta = fs::symlink_metadata(path)
        .unwrap_or_else(|e| panic!("{} must still exist as a symlink: {e}", path.display()));
    assert!(
        meta.file_type().is_symlink(),
        "{} must remain a symlink after write_text",
        path.display()
    );
    assert_eq!(
        fs::read_link(path).unwrap(),
        expected,
        "the link target of {} must be unchanged by write_text",
        path.display()
    );
}

#[tokio::test]
async fn ac_48_26_write_through_symlink_keeps_target_mode() {
    let root = TempDir::new().unwrap();
    let real = file_with_mode(root.path(), "b.md", "old\n", 0o755);
    let link = root.path().join("a.md");
    symlink(&real, &link).unwrap();
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&link), "new\n")
        .await
        .expect("writing through a symlink must succeed");

    assert_still_symlink_to(&link, &real);
    assert_eq!(
        mode_of(&real),
        0o755,
        "the link target's mode must survive a save through the link"
    );
    assert_bytes(&real, "new\n");
    assert_no_tmp_leftovers(root.path());
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn ac_48_26_write_through_symlink_keeps_target_mode_and_xattrs() {
    let root = TempDir::new().unwrap();
    let real = file_with_mode(root.path(), "b.md", "old\n", 0o600);
    set_xattr(&real, CUSTOM_XATTR_NAME, CUSTOM_XATTR_VALUE);
    set_xattr(&real, FINDER_TAGS_XATTR, FINDER_TAG_RED);
    let xattrs_before = xattrs_of(&real);
    assert_eq!(xattrs_before.len(), 2, "fixture: both xattrs must be on b.md: {xattrs_before:?}");
    let link = root.path().join("a.md");
    symlink(&real, &link).unwrap();
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&link), "new\n")
        .await
        .expect("writing through a symlink must succeed");

    assert_still_symlink_to(&link, &real);
    assert_eq!(mode_of(&real), 0o600, "b.md's mode must be kept when saving through a.md");
    assert_eq!(
        xattrs_of(&real),
        xattrs_before,
        "b.md's extended attributes (custom + Finder tag) must be kept when saving through a.md"
    );
    assert_bytes(&real, "new\n");
    assert_no_tmp_leftovers(root.path());
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn ac_48_26_relative_symlink_in_other_folder_keeps_target_attributes() {
    // 追補d の形(別フォルダ・相対パスのリンク)でも、写す元は書き先=リンク先の実体。
    let root = TempDir::new().unwrap();
    let x = root.path().join("x");
    let y = root.path().join("y");
    fs::create_dir(&x).unwrap();
    fs::create_dir(&y).unwrap();
    let real = file_with_mode(&y, "b.md", "old\n", 0o755);
    set_xattr(&real, FINDER_TAGS_XATTR, FINDER_TAG_RED);
    let link = x.join("a.md");
    symlink("../y/b.md", &link).unwrap();
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&link), "new\n")
        .await
        .expect("writing through a relative symlink must succeed");

    assert_still_symlink_to(&link, Path::new("../y/b.md"));
    assert_eq!(mode_of(&real), 0o755, "b.md's mode must be kept");
    assert_eq!(
        get_xattr(&real, FINDER_TAGS_XATTR).as_deref(),
        Some(FINDER_TAG_RED),
        "b.md's Finder tag must be kept"
    );
    assert_bytes(&real, "new\n");
    assert_no_tmp_leftovers(&x);
    assert_no_tmp_leftovers(&y);
}

// ---------------------------------------------------------------------------
// AC-48-27 — 最初の保存と不変(追補e(3)(4)=非退行)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ac_48_27_first_save_to_missing_file_succeeds_byte_exact_without_tmp() {
    // 写す元が無い(まだ無いファイル)ときは従来どおり成功する。
    let root = TempDir::new().unwrap();
    let target = root.path().join("brand-new.md");
    assert!(!target.exists());
    let content = "\u{FEFF}first\r\nsave";
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&target), content)
        .await
        .expect("a first save (no source file to copy attributes from) must succeed");

    assert_bytes(&target, content);
    assert!(
        fs::metadata(&target).unwrap().is_file(),
        "the first save must create a regular file"
    );
    assert_no_tmp_leftovers(root.path());
    let entries: Vec<String> = fs::read_dir(root.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries, vec!["brand-new.md".to_string()], "only the new file may remain");
}

#[tokio::test]
async fn ac_48_27_first_save_in_subfolder_succeeds() {
    let root = TempDir::new().unwrap();
    let sub = root.path().join("docs");
    fs::create_dir(&sub).unwrap();
    let target = sub.join("new.md");
    let provider = LocalProvider::new();

    provider
        .write_text(&file_uri(&target), "hello\n")
        .await
        .expect("a first save inside an existing subfolder must succeed");

    assert_bytes(&target, "hello\n");
    assert_no_tmp_leftovers(&sub);
    assert_no_tmp_leftovers(root.path());
}

#[tokio::test]
async fn ac_48_27_write_text_still_rejects_parent_dir_components() {
    // `..` を含むパスは従来どおり断り、何も書かない(属性を写す処理が先に走ってもいけない)。
    let root = TempDir::new().unwrap();
    let sub = root.path().join("sub");
    fs::create_dir(&sub).unwrap();
    let provider = LocalProvider::new();

    let escaping = format!("{}/sub/../escaped.md", file_uri(root.path()));
    let err = provider
        .write_text(&escaping, "must not be written")
        .await
        .expect_err("a path containing `..` must still be rejected");
    let msg = err.to_string().to_lowercase();
    assert!(
        msg.contains("permission denied") || msg.contains("forbidden"),
        "rejection should be a permission-denied/forbidden class error, got: {msg}"
    );

    assert!(
        !root.path().join("escaped.md").exists(),
        "rejected write must not create the target file"
    );
    assert_no_tmp_leftovers(root.path());
    assert_no_tmp_leftovers(&sub);
}

// ---------------------------------------------------------------------------
// AC-48-28 — 更新日時は保存の時刻(追補e(1)・2026-10-05 追記)
// ---------------------------------------------------------------------------
//
// 実装前の tmp+rename でも新しいファイルになるので緑。AC-48-24〜26 の「属性を写す」実装が
// 更新日時まで写して戻し忘れる退行(保存したのに 2020 年のまま=監視・同期・make が気づけない)
// を捕まえるためのテスト。

/// 2020-01-01T00:00:00Z。
fn year_2020() -> std::time::SystemTime {
    std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_577_836_800)
}

/// `path` の更新日時を 2020-01-01 にし、設定できたことを確かめる(std だけ=`File::set_modified`)。
fn backdate_mtime(path: &Path) {
    let file = fs::File::options()
        .write(true)
        .open(path)
        .unwrap_or_else(|e| panic!("fixture: cannot open {} for utimes: {e}", path.display()));
    file.set_modified(year_2020())
        .unwrap_or_else(|e| panic!("fixture: cannot set mtime on {}: {e}", path.display()));
    drop(file);
    let mtime = fs::metadata(path).unwrap().modified().unwrap();
    assert!(
        mtime < year_2020() + std::time::Duration::from_secs(1),
        "fixture: mtime of {} must be back-dated to 2020 before writing (got {mtime:?})",
        path.display()
    );
}

/// `path` の更新日時が `not_before`(書く直前に控えた時刻)以降か。
/// ファイルシステムの時刻粒度(1 秒のものもある)を見て 1 秒の余裕を取る。
fn assert_mtime_is_now(path: &Path, not_before: std::time::SystemTime) {
    let mtime = fs::metadata(path).unwrap().modified().unwrap();
    let floor = not_before - std::time::Duration::from_secs(1);
    assert!(
        mtime >= floor,
        "mtime of {} must be the time of the save (>= {not_before:?}), not the old file's; got {mtime:?}",
        path.display()
    );
}

#[tokio::test]
async fn ac_48_28_write_text_sets_mtime_to_now_while_keeping_mode() {
    let root = TempDir::new().unwrap();
    let target = file_with_mode(root.path(), "old.sh", "#!/bin/sh\nold\n", 0o755);
    backdate_mtime(&target);
    let provider = LocalProvider::new();

    let before_write = std::time::SystemTime::now();
    let content = "#!/bin/sh\nnew\n";
    provider
        .write_text(&file_uri(&target), content)
        .await
        .expect("writing to a back-dated file must succeed");

    assert_mtime_is_now(&target, before_write);
    assert_eq!(
        mode_of(&target),
        0o755,
        "the mode must still be kept (AC-48-24) while the mtime is not copied"
    );
    assert_bytes(&target, content);
    assert_no_tmp_leftovers(root.path());
}

#[tokio::test]
async fn ac_48_28_write_through_symlink_sets_target_mtime_to_now() {
    let root = TempDir::new().unwrap();
    let real = file_with_mode(root.path(), "b.md", "old\n", 0o755);
    backdate_mtime(&real);
    let link = root.path().join("a.md");
    symlink(&real, &link).unwrap();
    let provider = LocalProvider::new();

    let before_write = std::time::SystemTime::now();
    provider
        .write_text(&file_uri(&link), "new\n")
        .await
        .expect("writing through a symlink to a back-dated file must succeed");

    assert_still_symlink_to(&link, &real);
    assert_mtime_is_now(&real, before_write);
    assert_eq!(mode_of(&real), 0o755, "b.md's mode must still be kept");
    assert_bytes(&real, "new\n");
    assert_no_tmp_leftovers(root.path());
}
