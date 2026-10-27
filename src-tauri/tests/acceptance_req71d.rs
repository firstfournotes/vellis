//! 要件#71 追補d の受け入れテスト(docs/requirements/req-71.md「追補d」= Issue #588 / backlog 218)
//! — Rust 層(AC-71-12 (a)〜(d))
//!
//! 発端: ローカルで消えたファイルをツリーや Recent Files から開くと、alert が
//! `Could not open the file: I/O error: No path was found. about ["…/zz.md"]` という技術的な文になる。
//! 開くのは監視の登録(`DocumentSession::open` → `DocumentCoordinator::subscribe` →
//! `LocalProvider::watch`)が先で、`fs/local.rs` の `watch` が notify の失敗をすべて
//! `FsError::Io(io::Error::new(Other, e))` に包むため、`FsError::NotFound` の文言
//! (`not found: <path>`)にならない。
//!
//! 契約(追補d):
//! 1. `LocalProvider::watch` は notify の失敗を次のように写す:
//!    `notify::ErrorKind::PathNotFound` → `FsError::NotFound(<監視しようとしたパス>)`。
//!    `notify::ErrorKind::Io(e)` → 既存の `io_to_fs(e)`(NotFound / PermissionDenied / Io)。
//!    それ以外は今までどおり `FsError::Io`。watcher を作るとき(`RecommendedWatcher::new`)の失敗も同じ
//! 2. 開く経路(文書のセッション → 監視の登録)を通っても `FsError::NotFound` のまま返り、途中で
//!    `Io` に包み直さない。alert は `Could not open the file: not found: /…/zz.md` になる
//! 3. alert の文言の組み立て(フロント)は変えない
//! 4. `open_in_window` のコメント(「消えたファイルは notify の失敗(`FsError::Io`)として返り…」)を
//!    実態に直す。Recent Files から除く判定は今までどおり stat で決める
//! 5. 不変: 前の文書の購読を保つ(契約1)・ssh の監視・`FsError` の Display・存在する
//!    ファイルとフォルダの監視。依存の追加なし
//!
//! 判定範囲(AC-71-12):
//! - (a) `LocalProvider::watch` に存在しないファイルの URI → `Err(FsError::NotFound(s))` で `s` に
//!   そのパスを含む。`to_string()` に `I/O error` も `No path was found` も含まない
//! - (b) 存在しないフォルダの URI でも同じ
//! - (c) 存在するファイル・フォルダは `Ok`(不変=実装前から緑)
//! - (d) 開く経路(監視の登録を通る層)で消えたファイルを開くと、返るエラーの文が `not found:` で
//!   始まる。層は **`DocumentSession::open` / `open_binary`**(`tauri::test::mock_app()` の
//!   `AppHandle<MockRuntime>` で組める一番上の層。`open_in_window` は `tauri::State<AppState>` と
//!   `Window` を要るのでテストから呼べない= `acceptance_req71.rs` と同じ事情)。
//!   `open_in_window` は `Err(e) => return Err(e.to_string())` をそのまま返し、フロントは
//!   `Could not open the file: ${reason}` に差し込むだけなので、ここで見る文が alert の `<理由>`。
//!   hub 層(`DocumentCoordinator::subscribe`)も 1 件見る(契約2「途中で `Io` に包み直さない」)
//! - (e) 既存のテストは無改変で緑 → test-runner のフルスイートで見る
//!
//! ## 確定契約(公開 API の追加・変更は無し。implementer はこれに従う)
//!
//! ```ignore
//! // src-tauri/src/fs/local.rs — `impl FileProvider for LocalProvider` の `watch`
//! // - `RecommendedWatcher::new(...)` と `watcher.watch(&watch_path, ...)` の `map_err` を、
//! //   `FsError::Io(std::io::Error::new(Other, e))` から「notify の失敗を写す」関数に替える:
//! //     notify::ErrorKind::PathNotFound  → FsError::NotFound(watch_path.display().to_string())
//! //                                        (= 監視しようとしたパスを文に含める)
//! //     notify::ErrorKind::Io(e)         → io_to_fs(e)(既存の private fn)
//! //     それ以外                          → FsError::Io(...)(今までどおり)
//! // - macOS の FSEvents(notify 7.0.0 `fsevent.rs::append_path`)は、存在しないパスの watch を
//! //   `Error::path_not_found().add_path(path)` で返す。本テストは変種を見ず、結果だけで判定する:
//! //   `FsError::NotFound` である・文にパスを含む・`I/O error` と `No path was found` を含まない
//! //
//! // src-tauri/src/watch/hub.rs / src-tauri/src/session/document.rs — 変更不要の見込み
//! // (`provider.watch(&uri, tx).await?` と `coordinator.subscribe(...).await?` は `?` で
//! //  `FsError` → `VellisError::Fs`(transparent)に上げるだけで包み直していない)
//! ```
//!
//! ## 赤の源(修正前の見込み)
//! - (a)(b)(d): 今の `watch` は notify の失敗を `FsError::Io(io::Error::new(Other, e))` に包むので、
//!   変種が `Io`・`to_string()` が `I/O error: No path was found. about ["…"]` となり赤
//! - (c): 存在するファイル・フォルダの監視は今も `Ok` → 実装前から緑(契約5 の不変を固定する歯止め)
//!
//! ## reviewer 照合に委ねるもの(機械判定しにくいもの)
//! - `notify::ErrorKind::Io(e)` → `io_to_fs(e)` の分岐と、`RecommendedWatcher::new` の失敗の写し方
//!   (macOS ではどちらもテストから起こせない)
//! - 契約4 の `open_in_window` のコメントの直し・ssh の監視の不変

use std::path::Path;
use std::sync::Arc;

use tauri::test::MockRuntime;
use tempfile::TempDir;
use tokio::sync::mpsc;

use vellis_lib::errors::{FsError, VellisError};
use vellis_lib::fs::local::LocalProvider;
use vellis_lib::fs::provider::{FileProvider, WatchEvent, WatchHandle};
use vellis_lib::fs::registry::FileProviderRegistry;
use vellis_lib::fs::uri::Uri;
use vellis_lib::session::document::DocumentSession;
use vellis_lib::watch::hub::{DocumentCoordinator, WindowId};

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

fn make_uri(path: &Path) -> Uri {
    Uri {
        scheme: "file".into(),
        authority: None,
        path: path.to_path_buf(),
        raw: format!("file://{}", path.display()),
    }
}

/// `LocalProvider::watch` を 1 回呼ぶ(受け手のチャンネルは捨ててよい=登録の成否だけ見る)。
async fn watch_local(path: &Path) -> Result<WatchHandle, FsError> {
    let provider = LocalProvider::new();
    let (tx, _rx) = mpsc::channel::<WatchEvent>(32);
    provider.watch(&make_uri(path), tx).await
}

/// 消えたファイル・フォルダのエラー文の判定(AC-71-12 (a)(b)(d) 共通):
/// `not found:` で始まる・そのパスを含む・`I/O error` と `No path was found` を含まない。
fn assert_not_found_message(msg: &str, path: &Path, what: &str) {
    let path_str = path.display().to_string();
    assert!(
        msg.starts_with("not found:"),
        "{what}: the error text must start with `not found:` (FsError::NotFound), got `{msg}`"
    );
    assert!(
        msg.contains(&path_str),
        "{what}: the error text must name the path {path_str}, got `{msg}`"
    );
    assert!(
        !msg.contains("I/O error"),
        "{what}: the error must not be wrapped as FsError::Io, got `{msg}`"
    );
    assert!(
        !msg.contains("No path was found"),
        "{what}: notify's own wording must not leak into the error, got `{msg}`"
    );
}

/// (a)(b): `watch` の結果が `Err(FsError::NotFound(s))` で `s` にパスを含む。
fn assert_watch_not_found(result: Result<WatchHandle, FsError>, path: &Path, what: &str) {
    let path_str = path.display().to_string();
    let err = match result {
        Ok(_) => panic!("{what}: watching the missing path {path_str} must fail"),
        Err(e) => e,
    };
    let msg = err.to_string();
    match &err {
        FsError::NotFound(s) => assert!(
            s.contains(&path_str),
            "{what}: FsError::NotFound must carry the watched path {path_str}, got `{s}`"
        ),
        other => panic!("{what}: expected FsError::NotFound, got {other:?} (`{msg}`)"),
    }
    assert_not_found_message(&msg, path, what);
}

/// 開く経路の土台(`acceptance_req71.rs` と同じ組み方): registry + coordinator + mock の AppHandle。
struct OpenPath {
    providers: Arc<FileProviderRegistry>,
    coordinator: Arc<DocumentCoordinator<MockRuntime>>,
    app: tauri::App<MockRuntime>,
}

impl OpenPath {
    fn new() -> Self {
        let providers = Arc::new(FileProviderRegistry::new());
        let coordinator = Arc::new(DocumentCoordinator::new(Arc::clone(&providers)));
        let app = tauri::test::mock_app();
        Self {
            providers,
            coordinator,
            app,
        }
    }

    fn handle(&self) -> tauri::AppHandle<MockRuntime> {
        self.app.handle().clone()
    }

    async fn open(&self, path: &Path) -> Result<(), VellisError> {
        DocumentSession::open(
            WindowId("main".into()),
            make_uri(path),
            &self.providers,
            &self.coordinator,
            &self.handle(),
        )
        .await
        .map(|_| ())
    }

    async fn open_binary(&self, path: &Path) -> Result<(), VellisError> {
        DocumentSession::open_binary(
            WindowId("main".into()),
            make_uri(path),
            &self.providers,
            &self.coordinator,
            &self.handle(),
        )
        .await
        .map(|_| ())
    }
}

/// (d): 開く経路の結果が `Err(VellisError::Fs(FsError::NotFound(_)))` で、文が `not found:` で始まる。
fn assert_open_not_found(result: Result<(), VellisError>, path: &Path, what: &str) {
    let path_str = path.display().to_string();
    let err = match result {
        Ok(()) => panic!("{what}: opening the missing file {path_str} must fail"),
        Err(e) => e,
    };
    let msg = err.to_string();
    match &err {
        VellisError::Fs(FsError::NotFound(_)) => {}
        other => panic!(
            "{what}: expected VellisError::Fs(FsError::NotFound), got {other:?} (`{msg}`)"
        ),
    }
    assert_not_found_message(&msg, path, what);
}

// ---------------------------------------------------------------------------
// (a) 存在しないファイルの URI → FsError::NotFound(パスを含む)
// ---------------------------------------------------------------------------

/// a1. 作ってから消したファイル(親フォルダはある)= ツリー / Recent Files の「消えたファイル」。
#[tokio::test]
async fn ac71_12_a_watch_of_a_deleted_file_is_not_found() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("zz.md");
    std::fs::write(&file, "# gone soon").unwrap();
    std::fs::remove_file(&file).unwrap();
    assert!(!file.exists(), "precondition: the file is gone");

    assert_watch_not_found(watch_local(&file).await, &file, "a1 deleted file");
}

/// a2. 親フォルダごと無いファイル(一度も作っていない)。
#[tokio::test]
async fn ac71_12_a_watch_of_a_file_under_a_missing_folder_is_not_found() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("never").join("made").join("zz.md");
    assert!(!file.exists(), "precondition: the path never existed");

    assert_watch_not_found(watch_local(&file).await, &file, "a2 file under a missing folder");
}

// ---------------------------------------------------------------------------
// (b) 存在しないフォルダの URI でも同じ
// ---------------------------------------------------------------------------

/// b1. 作ってから消したフォルダ(中にファイルがあった)。
#[tokio::test]
async fn ac71_12_b_watch_of_a_deleted_folder_is_not_found() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("notes");
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(dir.join("a.md"), "# a").unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
    assert!(!dir.exists(), "precondition: the folder is gone");

    assert_watch_not_found(watch_local(&dir).await, &dir, "b1 deleted folder");
}

/// b2. 一度も作っていないフォルダ。
#[tokio::test]
async fn ac71_12_b_watch_of_a_never_made_folder_is_not_found() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("no-such-folder");
    assert!(!dir.exists(), "precondition: the folder never existed");

    assert_watch_not_found(watch_local(&dir).await, &dir, "b2 never-made folder");
}

// ---------------------------------------------------------------------------
// (c) 存在するファイル・フォルダは Ok(契約5 の不変=実装前から緑)
// ---------------------------------------------------------------------------

/// c1. 存在するファイルの監視は `Ok`。
#[tokio::test]
async fn ac71_12_c_watch_of_an_existing_file_is_ok() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("here.md");
    std::fs::write(&file, "# here").unwrap();

    let handle = watch_local(&file)
        .await
        .unwrap_or_else(|e| panic!("c1: watching an existing file must succeed, got `{e}`"));
    assert!(handle.id >= 1, "c1: the watch handle carries an id");
}

/// c2. 存在するフォルダの監視は `Ok`。
#[tokio::test]
async fn ac71_12_c_watch_of_an_existing_folder_is_ok() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("docs");
    std::fs::create_dir(&dir).unwrap();

    let handle = watch_local(&dir)
        .await
        .unwrap_or_else(|e| panic!("c2: watching an existing folder must succeed, got `{e}`"));
    assert!(handle.id >= 1, "c2: the watch handle carries an id");
}

// ---------------------------------------------------------------------------
// (d) 開く経路(監視の登録を通る層)で消えたファイルを開くと、文が `not found:` で始まる
// ---------------------------------------------------------------------------

/// d1. `DocumentSession::open`(テキスト文書): 作ってから消したファイルを開く。
/// `open_in_window` が `e.to_string()` をそのまま返すので、この文が alert の `<理由>`
/// (`Could not open the file: not found: /…/zz.md`)。
#[tokio::test]
async fn ac71_12_d_document_session_open_of_a_deleted_file_says_not_found() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("zz.md");
    std::fs::write(&file, "# gone soon").unwrap();
    std::fs::remove_file(&file).unwrap();

    let open_path = OpenPath::new();
    assert_open_not_found(open_path.open(&file).await, &file, "d1 DocumentSession::open");
}

/// d2. `DocumentSession::open`: フォルダごと消えたファイル(Recent Files に残った項目の典型)。
#[tokio::test]
async fn ac71_12_d_document_session_open_under_a_deleted_folder_says_not_found() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("project");
    let file = dir.join("README.md");
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(&file, "# project").unwrap();
    std::fs::remove_dir_all(&dir).unwrap();

    let open_path = OpenPath::new();
    assert_open_not_found(
        open_path.open(&file).await,
        &file,
        "d2 DocumentSession::open under a deleted folder",
    );
}

/// d3. `DocumentSession::open_binary`(画像など=同じ監視の登録を通る): 消えた画像を開く。
#[tokio::test]
async fn ac71_12_d_document_session_open_binary_of_a_deleted_image_says_not_found() {
    let tmp = TempDir::new().unwrap();
    let image = tmp.path().join("shot.png");
    std::fs::write(&image, b"\x89PNG\r\n\x1a\n").unwrap();
    std::fs::remove_file(&image).unwrap();

    let open_path = OpenPath::new();
    assert_open_not_found(
        open_path.open_binary(&image).await,
        &image,
        "d3 DocumentSession::open_binary",
    );
}

/// d4. hub 層 `DocumentCoordinator::subscribe`(監視の登録そのもの): `FsError::NotFound` のまま返り、
/// 途中で `Io` に包み直さない(契約2)。
#[tokio::test]
async fn ac71_12_d_coordinator_subscribe_of_a_deleted_file_says_not_found() {
    let tmp = TempDir::new().unwrap();
    let file = tmp.path().join("zz.md");
    std::fs::write(&file, "# gone soon").unwrap();
    std::fs::remove_file(&file).unwrap();

    let open_path = OpenPath::new();
    let result = open_path
        .coordinator
        .subscribe(make_uri(&file), WindowId("main".into()), open_path.handle())
        .await;
    let err = match result {
        Ok(_) => panic!("d4: subscribing to a missing file must fail"),
        Err(e) => e,
    };
    let msg = err.to_string();
    match &err {
        FsError::NotFound(s) => assert!(
            s.contains(&file.display().to_string()),
            "d4: FsError::NotFound must carry the path, got `{s}`"
        ),
        other => panic!("d4: expected FsError::NotFound, got {other:?} (`{msg}`)"),
    }
    assert_not_found_message(&msg, &file, "d4 DocumentCoordinator::subscribe");
}
