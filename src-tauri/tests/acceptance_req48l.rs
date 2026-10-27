//! 要件#48 追補l の受け入れテスト(docs/requirements/req-48.md 追補l・Issue #654)— Rust 層
//!
//! 「保存に失敗したときの後始末(`discard_tmp`)で、flags と ACL を外しても一時ファイルを
//!  消せなかったら、`tracing::warn!` を 1 回出す(パスと OS のエラーを含む)。消せたときは出さない」
//! を固定する:
//! - **AC-48-追l(a)** 一時ファイルを消せない状況=rename の前(差し込み口 `before_rename`)に
//!   親フォルダを書けなくする(`chmod 0555`。unlink も rename も親フォルダの書き込み権限が要る)。
//!   保存は `Err`、一時ファイルは残り(=消せなかったことの確認)、`WARN` の記録が **ちょうど 1 件**
//!   出て、一時ファイルのパスと削除に失敗した理由(OS のエラー=Permission denied)を含む
//! - **AC-48-追l(b)** 消せる状況の保存の失敗では `WARN` の記録が出ない:
//!   AC-48-29 の ACL `everyone deny delete`(一時ファイルに ACL が写り、1 回目の削除は拒まれ、
//!   ACL を外したあとの削除で消える)・`uchg`(flags を外したあとの削除で消える)・
//!   rename の前に書き先がリンクに差し替えられる(追補j(2)=一時ファイルは素のまま、1 回目の削除で
//!   消える)。成功した保存でも出ない
//! - **AC-48-追l(c)** 既存の保存の受け入れテスト(acceptance_req48 / 48d / 48e / 48f / 48j)は無改変で緑
//!   → フルスイートで判定
//!
//! ## 判定しないもの
//! - warn の文言そのもの(パスと OS のエラーを含むことだけ)・`target` の名前・fields の名前
//!   (`path = …` でも message に埋めても可)
//! - warn を出す位置(`discard_tmp` の中か呼び出し元か)→ reviewer 照合。ここでは記録の結果だけ
//!
//! ## 実装前の見立て
//! - (a) は赤のはず: 現状の `discard_tmp` は最後の `remove_file` の結果を `let _ =` で捨てていて
//!   何も記録しない → `WARN` の件数 0 ≠ 1
//! - (b) は現状でも緑のはず(退行の守り=消せたときに warn を足してしまう・1 回目の失敗で早めに
//!   warn を出してしまう、を捕まえる。後者は (a) の「ちょうど 1 件」でも捕まる)
//!
//! ## tracing の記録の捕まえ方(依存は不変: `tracing`・`tracing-subscriber` は [dependencies] にある)
//! - `tracing_subscriber::registry()` に自前の `Layer`(`on_event` で level・fields・message を文字列に
//!   して溜める)を重ね、`set_global_default` で **この試験バイナリに 1 回だけ** 入れる(`OnceLock`)。
//!   thread-local の `with_default` にしないのは、後始末が `spawn_blocking` の別スレッドで動いても
//!   取りこぼさないため。テストは並列に走るので、記録は一時ファイルの名前(テストごとに一意)で
//!   選り分ける
//! - 一時ファイルの名前は `.<name>.vellis-tmp` で決まっている(要件#65 契約2・acceptance_req48f.rs)
//!
//! ## 注意(テスト作成時の確認)
//! - `chmod 0555` したフォルダは TempDir が消せないので、`RestoreModeOnDrop` で **テストの成否に
//!   かかわらず** 戻す(panic の巻き戻しでも Drop は走る)。TempDir より後に宣言する
//! - ACL と flags は macOS 前提(`#[cfg(target_os = "macos")]`)。フィクスチャと後始末は
//!   acceptance_req48f.rs の写し

#![cfg(all(unix, target_os = "macos"))]

use std::fmt::Debug;
use std::fs;
use std::os::macos::fs::MetadataExt as MacMetadataExt;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};

use tempfile::TempDir;
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};
use vellis_lib::fs::local::LocalProvider;
use vellis_lib::fs::provider::FileProvider;

// ---------------------------------------------------------------------------
// tracing の記録を溜める(試験バイナリ全体で 1 つ)
// ---------------------------------------------------------------------------

/// 1 件の記録。`text` は fields と message を `name=value ` の形で連ねたもの。
#[derive(Clone, Debug)]
struct Record {
    level: Level,
    text: String,
}

#[derive(Default)]
struct TextVisitor(String);

impl Visit for TextVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn Debug) {
        // `%x`(Display)も `?x`(Debug)も message もここへ来る。
        self.0.push_str(&format!("{}={:?} ", field.name(), value));
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.push_str(&format!("{}={} ", field.name(), value));
    }
}

struct Collect {
    records: Arc<Mutex<Vec<Record>>>,
}

impl<S: Subscriber> Layer<S> for Collect {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = TextVisitor::default();
        event.record(&mut visitor);
        self.records.lock().unwrap().push(Record {
            level: *event.metadata().level(),
            text: visitor.0,
        });
    }
}

/// 記録の置き場。最初の呼び出しで global subscriber を入れる(以後は同じ置き場を返す)。
fn records() -> Arc<Mutex<Vec<Record>>> {
    static STORE: OnceLock<Arc<Mutex<Vec<Record>>>> = OnceLock::new();
    STORE
        .get_or_init(|| {
            let store: Arc<Mutex<Vec<Record>>> = Arc::new(Mutex::new(Vec::new()));
            let layer = Collect {
                records: store.clone(),
            };
            tracing::subscriber::set_global_default(tracing_subscriber::registry().with(layer))
                .expect("this test binary installs its tracing subscriber exactly once");
            store
        })
        .clone()
}

/// `needle`(一時ファイルの名前)を含む `WARN` の記録。
fn warns_mentioning(needle: &str) -> Vec<Record> {
    records()
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.level == Level::WARN && r.text.contains(needle))
        .cloned()
        .collect()
}

// ---------------------------------------------------------------------------
// 共通のフィクスチャ(acceptance_req48f.rs の家風)
// ---------------------------------------------------------------------------

fn file_uri(path: &Path) -> String {
    format!("file://{}", path.display())
}

/// 文書 `name` の一時ファイルの名前(要件#65 契約2: `.<name>.vellis-tmp`)。
fn tmp_name_of(name: &str) -> String {
    format!(".{name}.vellis-tmp")
}

fn assert_bytes(path: &Path, expected: &str) {
    let on_disk = fs::read(path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    assert_eq!(
        on_disk,
        expected.as_bytes(),
        "bytes at {} must equal the original content exactly (a failed save must not touch it)",
        path.display()
    );
}

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
        "no `.vellis-tmp` file may remain in {} after this save: {leftovers:?}",
        dir.display()
    );
}

fn mode_of(path: &Path) -> u32 {
    fs::metadata(path)
        .unwrap_or_else(|e| panic!("cannot stat {}: {e}", path.display()))
        .permissions()
        .mode()
        & 0o7777
}

fn set_mode(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .unwrap_or_else(|e| panic!("fixture: cannot chmod {}: {e}", path.display()));
    assert_eq!(
        mode_of(path),
        mode,
        "fixture: mode {mode:o} must be set on {}",
        path.display()
    );
}

fn file_with_mode(dir: &Path, name: &str, old: &str, mode: u32) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, old).unwrap();
    set_mode(&path, mode);
    path
}

// --- ACL(chmod +a / ls -le)---

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
            let trimmed = line.trim_start();
            let (num, rest) = trimmed.split_once(": ")?;
            num.parse::<u32>().ok()?;
            Some(rest.trim().to_string())
        })
        .collect()
}

/// `path` に `everyone deny delete` を付け、付いたことを確かめて ACL 行を返す。
fn deny_delete(path: &Path) -> Vec<String> {
    add_acl(path, "everyone deny delete");
    let acl = acl_of(path);
    assert!(
        acl.iter().any(|l| l.contains("everyone") && l.contains("deny") && l.contains("delete")),
        "fixture: `everyone deny delete` must be on {} before writing: {acl:?}",
        path.display()
    );
    acl
}

// --- flags(chflags / st_flags)---

fn flags_of(path: &Path) -> u32 {
    fs::metadata(path)
        .unwrap_or_else(|e| panic!("cannot stat {}: {e}", path.display()))
        .st_flags()
}

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

// --- 後始末: テストの成否にかかわらず TempDir を消せる状態に戻す ---

/// Drop で、登録したフォルダの中のすべてのエントリから flags と ACL を外す(acceptance_req48f.rs の写し)。
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

/// Drop で、フォルダのモードを `mode` に戻す(書けなくしたフォルダを TempDir が消せるように)。
/// TempDir より **後に** 宣言すること。
struct RestoreModeOnDrop {
    path: PathBuf,
    mode: u32,
}

impl Drop for RestoreModeOnDrop {
    fn drop(&mut self) {
        let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(self.mode));
    }
}

// ---------------------------------------------------------------------------
// AC-48-追l(a) — 一時ファイルを消せない状況: warn がちょうど 1 件、パスと OS のエラーを含む
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ac_48_l_a_unremovable_tmp_after_failed_save_warns_once_with_its_path() {
    let root = TempDir::new().unwrap();
    let _restore = RestoreModeOnDrop {
        path: root.path().to_path_buf(),
        mode: 0o755,
    };
    let old = "old\n";
    let name = "unremovable.md";
    let target = file_with_mode(root.path(), name, old, 0o644);
    let tmp_name = tmp_name_of(name);
    let tmp_path = root.path().join(&tmp_name);
    let provider = LocalProvider::new();
    let store = records();
    let before = warns_mentioning(&tmp_name).len();
    assert_eq!(before, 0, "no WARN about this temp file may exist before the save");

    // 一時ファイルを書き終えたあと rename の前に、親フォルダを書けなくする:
    // rename が EACCES で失敗し、後始末の unlink(flags と ACL を外したあとの再試行も)が拒まれる。
    let lock_dir = {
        let dir = root.path().to_path_buf();
        move || {
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o555))
                .expect("fixture: make the parent folder read-only before the rename");
        }
    };
    let result = provider
        .write_text_within_root_with(&file_uri(&target), "new\n", Some(root.path()), lock_dir)
        .await;
    assert!(
        result.is_err(),
        "the save must fail when the parent folder cannot be written at rename time"
    );

    // 場面の確認: 一時ファイルは本当に消せなかった(残っている)。保存の結果は不変(契約(3))。
    assert!(
        fs::symlink_metadata(&tmp_path).is_ok(),
        "fixture: the temp file {} must still be there (the folder was read-only, so the cleanup could not remove it)",
        tmp_path.display()
    );
    assert_bytes(&target, old);

    let warns = warns_mentioning(&tmp_name);
    assert_eq!(
        warns.len(),
        1,
        "exactly one WARN record must mention the temp file {} when the cleanup cannot remove it (追補l(1)); got {warns:?}",
        tmp_path.display()
    );
    let text = &warns[0].text;
    let canonical_tmp = fs::canonicalize(root.path()).unwrap().join(&tmp_name);
    assert!(
        text.contains(&tmp_path.display().to_string())
            || text.contains(&canonical_tmp.display().to_string()),
        "the WARN record must contain the temp file's path ({} or {}); got: {text}",
        tmp_path.display(),
        canonical_tmp.display()
    );
    assert!(
        text.to_lowercase().contains("permission denied"),
        "the WARN record must contain the OS error of the failed removal (Permission denied); got: {text}"
    );

    // 後始末: フォルダを書けるように戻し、残った一時ファイルを消す(TempDir が消せるように)。
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755)).unwrap();
    let _ = fs::remove_file(&tmp_path);
    drop(store);
}

#[tokio::test]
async fn ac_48_l_a_unremovable_locked_tmp_after_failed_save_warns_once() {
    // 一時ファイルに `uchg` が写っていて(元のファイルがロック)、かつ親フォルダも書けない:
    // 後始末は flags を外す経路を通ってから最後の削除に失敗する。それでも warn は 1 件だけ。
    let root = TempDir::new().unwrap();
    let _unlock = UnlockOnDrop::new(&[root.path()]);
    let _restore = RestoreModeOnDrop {
        path: root.path().to_path_buf(),
        mode: 0o755,
    };
    let old = "old\n";
    let name = "locked-unremovable.md";
    let target = file_with_mode(root.path(), name, old, 0o644);
    lock_uchg(&target);
    let flags_before = flags_of(&target);
    let tmp_name = tmp_name_of(name);
    let tmp_path = root.path().join(&tmp_name);
    let provider = LocalProvider::new();
    let _store = records();

    let lock_dir = {
        let dir = root.path().to_path_buf();
        move || {
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o555))
                .expect("fixture: make the parent folder read-only before the rename");
        }
    };
    let result = provider
        .write_text_within_root_with(&file_uri(&target), "new\n", Some(root.path()), lock_dir)
        .await;
    assert!(result.is_err(), "the save must fail");

    assert!(
        fs::symlink_metadata(&tmp_path).is_ok(),
        "fixture: the temp file {} must still be there",
        tmp_path.display()
    );
    assert_bytes(&target, old);
    assert_eq!(flags_of(&target), flags_before, "the original's flags must be unchanged");

    let warns = warns_mentioning(&tmp_name);
    assert_eq!(
        warns.len(),
        1,
        "exactly one WARN record must mention {} even when the cleanup went through the unlock path first; got {warns:?}",
        tmp_path.display()
    );

    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755)).unwrap();
    unlock_path(&tmp_path);
    let _ = fs::remove_file(&tmp_path);
}

// ---------------------------------------------------------------------------
// AC-48-追l(b) — 消せる状況の保存の失敗では warn が出ない
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ac_48_l_b_acl_deny_delete_failed_save_removes_tmp_without_warn() {
    // AC-48-29 の場面: ACL は一時ファイルに写り、1 回目の削除は拒まれ、ACL を外したあとの削除で消える。
    let root = TempDir::new().unwrap();
    let _unlock = UnlockOnDrop::new(&[root.path()]);
    let old = "# locked by ACL\nold\n";
    let name = "acl-quiet.md";
    let target = file_with_mode(root.path(), name, old, 0o644);
    let acl_before = deny_delete(&target);
    let tmp_name = tmp_name_of(name);
    let provider = LocalProvider::new();
    let _store = records();

    let result = provider.write_text(&file_uri(&target), "new\n").await;
    assert!(
        result.is_err(),
        "saving onto a file with `everyone deny delete` must fail (the rename is refused)"
    );

    assert_bytes(&target, old);
    assert_eq!(acl_of(&target), acl_before, "the original's ACL must be unchanged");
    assert_no_tmp_leftovers(root.path());
    let warns = warns_mentioning(&tmp_name);
    assert!(
        warns.is_empty(),
        "no WARN may mention the temp file when the cleanup removed it (after clearing the ACL); got {warns:?}"
    );
}

#[tokio::test]
async fn ac_48_l_b_uchg_failed_save_removes_tmp_without_warn() {
    // flags を外したあとの削除で消える場面。
    let root = TempDir::new().unwrap();
    let _unlock = UnlockOnDrop::new(&[root.path()]);
    let old = "old\n";
    let name = "uchg-quiet.md";
    let target = file_with_mode(root.path(), name, old, 0o644);
    lock_uchg(&target);
    let flags_before = flags_of(&target);
    let tmp_name = tmp_name_of(name);
    let provider = LocalProvider::new();
    let _store = records();

    let result = provider.write_text(&file_uri(&target), "new\n").await;
    assert!(result.is_err(), "saving onto a `uchg` (locked) file must fail");

    assert_bytes(&target, old);
    assert_eq!(flags_of(&target), flags_before, "the original's flags must be unchanged");
    assert_no_tmp_leftovers(root.path());
    let warns = warns_mentioning(&tmp_name);
    assert!(
        warns.is_empty(),
        "no WARN may mention the temp file when the cleanup removed it (after clearing the flags); got {warns:?}"
    );
}

#[tokio::test]
async fn ac_48_l_b_swapped_target_failed_save_removes_tmp_on_first_try_without_warn() {
    // 追補j(2) の場面: 一時ファイルは素のまま(ACL も flags も無い)なので 1 回目の削除で消える。
    let root = TempDir::new().unwrap();
    let old = "old\n";
    let name = "swapped-quiet.md";
    let target = file_with_mode(root.path(), name, old, 0o644);
    let moved = root.path().join("swapped-quiet.md.orig");
    let tmp_name = tmp_name_of(name);
    let provider = LocalProvider::new();
    let _store = records();

    let swap = {
        let (target, moved) = (target.clone(), moved.clone());
        move || {
            fs::rename(&target, &moved).expect("fixture: move the original aside");
            symlink(&moved, &target).expect("fixture: plant a link at the write target");
        }
    };
    let result = provider
        .write_text_within_root_with(&file_uri(&target), "new\n", Some(root.path()), swap)
        .await;
    assert!(
        result.is_err(),
        "a write target that became a symlink before the rename must be refused (追補j(2))"
    );

    assert_bytes(&moved, old);
    assert_no_tmp_leftovers(root.path());
    let warns = warns_mentioning(&tmp_name);
    assert!(
        warns.is_empty(),
        "no WARN may mention the temp file when the first removal succeeded; got {warns:?}"
    );
}

#[tokio::test]
async fn ac_48_l_b_successful_save_emits_no_warn_about_tmp() {
    let root = TempDir::new().unwrap();
    let name = "fine.md";
    let target = file_with_mode(root.path(), name, "old\n", 0o644);
    let tmp_name = tmp_name_of(name);
    let provider = LocalProvider::new();
    let _store = records();

    provider
        .write_text(&file_uri(&target), "new\n")
        .await
        .expect("a plain save must succeed");

    assert_bytes(&target, "new\n");
    assert_no_tmp_leftovers(root.path());
    let warns = warns_mentioning(&tmp_name);
    assert!(
        warns.is_empty(),
        "a successful save must not WARN about its temp file; got {warns:?}"
    );
}
