//! 要件#48 追補f の受け入れテスト(docs/requirements/req-48.md 追補f・backlog 281)— Rust 層
//!
//! 「保存に失敗しても一時ファイルを残さない(元の ACL を写したあとでも)」を固定する:
//! - **AC-48-29** ACL `everyone deny delete` を持つ既存のファイルへ `LocalProvider::write_text` で
//!   書くと(置き換え=削除の扱いで `rename` そのものが拒まれ、保存はもともと失敗する)、
//!   `Err` が返り、元のファイルの中身・権限・ACL は変わらず、`.vellis-tmp` で終わる一時ファイルが
//!   どのフォルダにも残らない。`uchg`(Finder のロック=`chflags uchg`)のファイルでも同じ。
//!   ACL と `uchg` を両方持つファイル・リンクを通した保存(一時ファイルはリンク先のフォルダに
//!   できる=追補d)・続けて 2 回失敗したときも同じ
//!
//! ## 判定しないもの
//! - 後始末の手段(一時ファイルの ACL と flags を外してから消す・依存を足さない)→ reviewer 照合。
//!   ここでは結果(一時ファイルが残らない・元のファイルに触らない)だけを判定する
//! - 保存が成功する場合の属性の写し方(追補f(2) の不変)→ `acceptance_req48e.rs` が固定済み
//!
//! ## 実装前の見立て
//! - ACL のケース(`deny delete` 単独・ACL+uchg・リンク経由・2 回続け)は赤のはず:
//!   追補e の `discard_tmp` は flags(`chflags(0)`)しか外さないので、`COPYFILE_METADATA` で
//!   写された `everyone deny delete` が一時ファイルの `unlink` を拒み、`.<name>.vellis-tmp` が残る
//! - `uchg` 単独のケースは現状でも緑のはず(追補e で flags を外す後始末が入っている)=回帰の守り
//!
//! ## 注意(テスト作成時の確認・2026-10-05・zsh で確認)
//! - `everyone deny delete` を持つ一時ファイルは `rm` が Permission denied になり、`chmod -N` の
//!   あとなら消せる。`chmod -N` は ACL の無いファイルにも `uchg` のファイルにも成功する
//! - テストの後始末: ACL(`deny delete`)や `uchg` を付けたまま TempDir を drop すると消せずに残る
//!   (tempfile の Drop はエラーを捨てる)ので、`UnlockOnDrop` が **テストの成否にかかわらず**
//!   (panic の巻き戻しでも Drop は走る)フォルダの中のすべてのエントリ(残った一時ファイルも
//!   含む)から flags と ACL を外す。TempDir より後に宣言して、先に drop させる
//! - ACL と flags は macOS 前提(`#[cfg(target_os = "macos")]`)。ACL は `chmod +a` / `chmod -N` /
//!   `ls -le`、flags は `chflags` と `std::os::macos::fs::MetadataExt::st_flags`

#![cfg(all(unix, target_os = "macos"))]

use std::fs;
use std::os::macos::fs::MetadataExt as MacMetadataExt;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;

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
        "bytes at {} must equal the original content exactly (a failed save must not touch it)",
        path.display()
    );
}

/// `dir` に `.vellis-tmp` で終わる名前のエントリが残っていないか(1 階層)。
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
        "no `.vellis-tmp` file may remain in {} after a failed save: {leftovers:?}",
        dir.display()
    );
}

/// 権限ビット(モードの下 12 ビット)。リンクは辿る。
fn mode_of(path: &Path) -> u32 {
    fs::metadata(path)
        .unwrap_or_else(|e| panic!("cannot stat {}: {e}", path.display()))
        .permissions()
        .mode()
        & 0o7777
}

/// `path` に `mode` を付け、付いたことを確かめる。
fn set_mode(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .unwrap_or_else(|e| panic!("fixture: cannot chmod {}: {e}", path.display()));
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
// ACL(chmod +a / chmod -N / ls -le)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// flags(chflags / st_flags)
// ---------------------------------------------------------------------------

/// `path` の BSD file flags(リンクは辿る)。
fn flags_of(path: &Path) -> u32 {
    fs::metadata(path)
        .unwrap_or_else(|e| panic!("cannot stat {}: {e}", path.display()))
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

// ---------------------------------------------------------------------------
// 後始末: テストの成否にかかわらず TempDir を消せる状態に戻す
// ---------------------------------------------------------------------------

/// Drop で、登録したフォルダの中のすべてのエントリ(フィクスチャ・残った一時ファイル・
/// サブフォルダの中身)から flags(`chflags nouchg`)と ACL(`chmod -N`)を外す。
/// エラーは無視する(無いものを外しても害はない)。panic の巻き戻しでも走る。
/// TempDir より **後に** 宣言すること(逆順で drop されるので TempDir の前に走る)。
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

fn unlock_path(path: &Path) {
    // flags を先に外す(uchg が付いたままだと他の変更が拒まれ得る)。
    let _ = Command::new("/usr/bin/chflags")
        .arg("nouchg")
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

impl Drop for UnlockOnDrop {
    fn drop(&mut self) {
        for dir in &self.dirs {
            unlock_tree(dir);
        }
    }
}

// ---------------------------------------------------------------------------
// AC-48-29 — ACL `everyone deny delete` のファイル
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ac_48_29_acl_deny_delete_save_fails_and_leaves_no_tmp() {
    let root = TempDir::new().unwrap();
    let _unlock = UnlockOnDrop::new(&[root.path()]);
    let old = "# locked by ACL\nold\n";
    let target = file_with_mode(root.path(), "acl.md", old, 0o644);
    let acl_before = deny_delete(&target);
    let provider = LocalProvider::new();

    let result = provider.write_text(&file_uri(&target), "new\n").await;
    assert!(
        result.is_err(),
        "saving onto a file with `everyone deny delete` must fail (the rename is refused)"
    );

    assert_bytes(&target, old);
    assert_eq!(mode_of(&target), 0o644, "the original's mode must be unchanged");
    assert_eq!(
        acl_of(&target),
        acl_before,
        "the original's ACL must be unchanged (the cleanup must not touch the original)"
    );
    assert_no_tmp_leftovers(root.path());
}

#[tokio::test]
async fn ac_48_29_acl_deny_delete_two_failed_saves_in_a_row_leave_no_tmp() {
    // 一時ファイルの名前は決まっている(`.<name>.vellis-tmp`)。1 回目の後始末が漏れると
    // 2 回目は別の経路で失敗して残り物が増え得るので、続けて 2 回を判定する。
    let root = TempDir::new().unwrap();
    let _unlock = UnlockOnDrop::new(&[root.path()]);
    let old = "old\n";
    let target = file_with_mode(root.path(), "twice.md", old, 0o644);
    let acl_before = deny_delete(&target);
    let provider = LocalProvider::new();

    for attempt in 1..=2 {
        let result = provider
            .write_text(&file_uri(&target), &format!("new {attempt}\n"))
            .await;
        assert!(result.is_err(), "attempt {attempt} must fail");
        assert_no_tmp_leftovers(root.path());
    }

    assert_bytes(&target, old);
    assert_eq!(acl_of(&target), acl_before, "the original's ACL must be unchanged");
}

#[tokio::test]
async fn ac_48_29_acl_deny_delete_through_symlink_leaves_no_tmp_in_either_folder() {
    // 一時ファイルは書き先(リンク先)のフォルダにできる(追補d(1))。「どのフォルダにも残らない」
    // =リンクのフォルダにもリンク先のフォルダにも残らない。
    let root = TempDir::new().unwrap();
    let _unlock = UnlockOnDrop::new(&[root.path()]);
    let sub = root.path().join("real");
    fs::create_dir(&sub).unwrap();
    let old = "real old\n";
    let real = file_with_mode(&sub, "b.md", old, 0o644);
    let acl_before = deny_delete(&real);
    let link = root.path().join("a.md");
    symlink(&real, &link).unwrap();
    let provider = LocalProvider::new();

    let result = provider.write_text(&file_uri(&link), "new\n").await;
    assert!(result.is_err(), "saving through a link onto a `deny delete` file must fail");

    let link_meta = fs::symlink_metadata(&link).unwrap();
    assert!(link_meta.file_type().is_symlink(), "a.md must still be a symlink");
    assert_eq!(fs::read_link(&link).unwrap(), real, "a.md must still point at b.md");
    assert_bytes(&real, old);
    assert_eq!(acl_of(&real), acl_before, "b.md's ACL must be unchanged");
    assert_no_tmp_leftovers(root.path());
    assert_no_tmp_leftovers(&sub);
}

// ---------------------------------------------------------------------------
// AC-48-29 — `uchg`(ロック)のファイル=回帰の守り(追補e の後始末)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ac_48_29_uchg_save_fails_and_leaves_no_tmp() {
    let root = TempDir::new().unwrap();
    let _unlock = UnlockOnDrop::new(&[root.path()]);
    let old = "#!/bin/sh\nold\n";
    let target = file_with_mode(root.path(), "locked.sh", old, 0o755);
    lock_uchg(&target);
    let flags_before = flags_of(&target);
    let provider = LocalProvider::new();

    let result = provider.write_text(&file_uri(&target), "#!/bin/sh\nnew\n").await;
    assert!(result.is_err(), "saving onto a `uchg` (locked) file must fail");

    assert_bytes(&target, old);
    assert_eq!(mode_of(&target), 0o755, "the original's mode must be unchanged");
    assert_eq!(
        flags_of(&target),
        flags_before,
        "the original's flags (uchg) must be unchanged (the cleanup must not touch the original)"
    );
    assert_no_tmp_leftovers(root.path());
}

// ---------------------------------------------------------------------------
// AC-48-29 — ACL と `uchg` の両方
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ac_48_29_acl_and_uchg_together_save_fails_and_leaves_no_tmp() {
    // 一時ファイルには ACL も flags も写る。どちらか片方しか外さない後始末では消せない。
    let root = TempDir::new().unwrap();
    let _unlock = UnlockOnDrop::new(&[root.path()]);
    let old = "old\n";
    let target = file_with_mode(root.path(), "both.md", old, 0o600);
    let acl_before = deny_delete(&target);
    lock_uchg(&target);
    let flags_before = flags_of(&target);
    let provider = LocalProvider::new();

    let result = provider.write_text(&file_uri(&target), "new\n").await;
    assert!(result.is_err(), "saving onto a file with `deny delete` and `uchg` must fail");

    assert_bytes(&target, old);
    assert_eq!(mode_of(&target), 0o600, "the original's mode must be unchanged");
    assert_eq!(acl_of(&target), acl_before, "the original's ACL must be unchanged");
    assert_eq!(flags_of(&target), flags_before, "the original's flags must be unchanged");
    assert_no_tmp_leftovers(root.path());
}
