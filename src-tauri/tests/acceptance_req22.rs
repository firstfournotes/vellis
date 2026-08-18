//! 要件#22 の受け入れテスト(requirements.md #22)— Rust 層
//!
//! 「表示中のラスタ画像(png/jpg/jpeg/gif/webp/avif/bmp/ico)の変更追従を
//!  テキスト文書と同等に揃える: ①ディスク上で変更されたら表示へ自動反映
//!  ②削除されたら表示を閉じる ③reload 復元(要件#10)の対象に含める」
//!
//! 背景(要件#16 の既知の代償): ラスタ画像は `open_document`(UTF-8 テキスト読込)を
//! 通さず URI だけで `<img>` 表示するため、文書セッション=watch hub の監視が張られず、
//! 変更反映・削除追従・reload 復元の対象外だった。
//!
//! 契約(2026-08-18 由谷決定・設計方針は requirements.md #22 の周回設計判断):
//! - 既存 watch hub(DocumentCoordinator)に**読まない監視種別**を足す。
//!   Modify=本文なしの変更イベント・Remove=既存 `file_removed` と同経路
//! - フロントはラスタ画像でも watch-only の文書セッションを張る(新コマンド
//!   `open_binary_document`。既存 open_document 同様に window session を差し替え、
//!   subscribe-first)
//!
//! 判定範囲(本ファイル): hub の読まない監視種別の**イベント契約**と**ライフサイクル**。
//! フロントの経路切替(openForDisplay / reload 復元)は
//! `src/lib/open-document.acceptance.test.ts`、`<img>` のキャッシュ破りは
//! `src/lib/image-watch.acceptance.test.ts` が判定する。
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```ignore
//! // 実装先: src-tauri/src/watch/hub.rs(WatchKind に読まない種別を追加)。
//! // 既存 subscribe / subscribe_directory と同じ refcount・RAII 機構に載せる。
//! impl<R: tauri::Runtime> DocumentCoordinator<R> {
//!     /// ラスタ画像など「読まない」ファイル監視。Modify で本文を読まずに
//!     /// `binary_file_changed { uri }` を購読ウインドウへ emit し、
//!     /// Remove は既存テキスト経路と同じ `file_removed { uri }` を emit する。
//!     pub async fn subscribe_binary(
//!         self: &Arc<Self>,
//!         uri: Uri,
//!         window_id: WindowId,
//!         app: tauri::AppHandle<R>,
//!     ) -> Result<WatchSubscription<R>, FsError>;
//! }
//! ```
//!
//! イベント名は本テストが契約として固定する:
//! - 変更 = `binary_file_changed`、ペイロードは `{ uri }` のみ(**content フィールドを
//!   持たない**=読まないことの機械判定点。中身は `<img>` が vellis-asset を
//!   取りに行くときに初めて読まれる)
//! - 削除 = `file_removed`、ペイロードは `{ uri }`(テキスト経路と同名・同形=
//!   フロントの既存 file_removed → clearDocument 配線がそのまま効く)
//!
//! ## reviewer 照合に委ねる項目(実ウィンドウ・コマンド配線)
//! - `open_binary_document` コマンド: 既存 open_document と同様に旧セッションを
//!   drop してから subscribe_binary で新セッションを張り(subscribe-first)、
//!   window session として保持すること(ウインドウクローズ・別文書オープンで解放)
//! - フロント: binary_file_changed 受信で表示中ラスタの `<img>` src を版数クエリ付きで
//!   差し替える配線・file_removed → clearDocument が従来どおり効くこと
//! - 要件#16 の契約コメント(image-viewing.ts / open-document.ts 冒頭)の
//!   「監視対象外」記述の更新
//!
//! ## 人間ゲート(gate)
//! - 実機で表示中の png を上書き→表示が変わる・削除→表示が閉じる・reload→復元される

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::test::MockRuntime;
use tauri::Listener;
use tempfile::TempDir;

use vellis_lib::fs::registry::FileProviderRegistry;
use vellis_lib::fs::uri::Uri;
use vellis_lib::watch::hub::{DocumentCoordinator, WindowId};

// ---------------------------------------------------------------------------
// Helpers(acceptance_req18.rs / watch/hub.rs の既存テストと同じ流儀)
// ---------------------------------------------------------------------------

fn make_coordinator() -> Arc<DocumentCoordinator<MockRuntime>> {
    Arc::new(DocumentCoordinator::new(Arc::new(FileProviderRegistry::new())))
}

fn make_uri(path: &std::path::Path) -> Uri {
    Uri {
        scheme: "file".into(),
        authority: None,
        path: path.to_path_buf(),
        raw: format!("file://{}", path.display()),
    }
}

/// PNG マジックナンバー+不正 UTF-8 バイト列。`read_text` に通すと
/// InvalidUtf8 で必ず失敗する中身 — 「読まない」ことの証明に使う。
const PNG_LIKE_BYTES: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0xFF, 0xFE, 0x00];
const PNG_LIKE_BYTES_V2: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0xFE, 0xFF, 0x01, 0x02];

/// 非同期の unsubscribe(WatchSubscription の Drop が spawn する)を待つ。
async fn settle() {
    tokio::time::sleep(Duration::from_millis(100)).await;
}

/// 指定イベントを捕捉するリスナーを張る。App 本体はイベント配送に
/// 生きている必要があるので、呼び出し側が保持する。
fn capture_events(
    app: &tauri::App<MockRuntime>,
    event_name: &str,
) -> Arc<Mutex<Vec<serde_json::Value>>> {
    let events: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    app.listen_any(event_name.to_string(), move |event| {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            sink.lock().unwrap().push(v);
        }
    });
    events
}

/// 述語を満たすイベントが届くまで待つ(notify は非同期なのでポーリング。
/// macOS の FSEvents は latency があるためタイムアウトは長めに取る)。
async fn wait_for_event(
    events: &Arc<Mutex<Vec<serde_json::Value>>>,
    pred: impl Fn(&serde_json::Value) -> bool,
    timeout: Duration,
) -> Option<serde_json::Value> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(found) = events.lock().unwrap().iter().find(|v| pred(v)).cloned() {
            return Some(found);
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// ---------------------------------------------------------------------------
// ライフサイクル(既存 hub の refcount・RAII 機構に載っていることの証明)
// ---------------------------------------------------------------------------

/// 1. subscribe_binary で監視が登録され(refcount=1)、2窓目は同じ監視を共有し
///    (refcount=2)、全 Drop で解放される — テキスト文書と同じ機構であることの証明。
#[tokio::test]
async fn binary_watch_shares_refcount_and_releases_on_drop() {
    let tmp = TempDir::new().unwrap();
    let img_path = tmp.path().join("photo.png");
    std::fs::write(&img_path, PNG_LIKE_BYTES).unwrap();

    let coord = make_coordinator();
    let app = tauri::test::mock_app();
    let uri = make_uri(&img_path);

    let sub1 = coord
        .subscribe_binary(
            uri.clone(),
            WindowId("win-1".into()),
            app.handle().clone(),
        )
        .await
        .expect("subscribing an existing raster image must succeed");
    assert_eq!(
        coord.refcount(&uri.canonical()).await,
        Some(1),
        "opening a raster image must register exactly one hub watch"
    );

    let sub2 = coord
        .subscribe_binary(
            uri.clone(),
            WindowId("win-2".into()),
            app.handle().clone(),
        )
        .await
        .expect("a second window must piggyback on the same watch");
    assert_eq!(
        coord.refcount(&uri.canonical()).await,
        Some(2),
        "two windows showing the same image must share one refcounted watch"
    );

    drop(sub1);
    settle().await;
    assert_eq!(
        coord.refcount(&uri.canonical()).await,
        Some(1),
        "the surviving window must keep the watch alive"
    );

    drop(sub2);
    settle().await;
    assert_eq!(
        coord.refcount(&uri.canonical()).await,
        None,
        "dropping the last subscription (window close / other doc opened) must release the watch"
    );
}

/// 2. 存在しないファイルの subscribe_binary はエラーになる(テキスト経路と同等)。
///    reload 復元で画像が消えていたときのフォールバック(document:null)の前提。
#[tokio::test]
async fn binary_watch_on_missing_file_errors() {
    let coord = make_coordinator();
    let app = tauri::test::mock_app();
    let uri = make_uri(std::path::Path::new("/nonexistent/no_such_image.png"));

    let result = coord
        .subscribe_binary(uri, WindowId("win-1".into()), app.handle().clone())
        .await;
    assert!(
        result.is_err(),
        "watching a missing image must fail so the caller can fall back"
    );
}

// ---------------------------------------------------------------------------
// ①変更: Modify → binary_file_changed { uri }(本文なし=読まない)
// ---------------------------------------------------------------------------

/// 3. 監視中のラスタ画像(不正 UTF-8 の中身)を上書きすると、
///    `binary_file_changed` が uri 付きで届く。ペイロードは content を持たず
///    (読まない監視の機械判定点)、テキスト用 `file_changed` は流れない。
#[tokio::test]
async fn modify_emits_binary_file_changed_without_content() {
    let tmp = TempDir::new().unwrap();
    let img_path = tmp.path().join("photo.png");
    std::fs::write(&img_path, PNG_LIKE_BYTES).unwrap();

    let coord = make_coordinator();
    let app = tauri::test::mock_app();
    let binary_events = capture_events(&app, "binary_file_changed");
    let text_events = capture_events(&app, "file_changed");
    let uri = make_uri(&img_path);
    let canonical = uri.canonical();

    let _sub = coord
        .subscribe_binary(
            uri.clone(),
            WindowId("win-1".into()),
            app.handle().clone(),
        )
        .await
        .unwrap();

    std::fs::write(&img_path, PNG_LIKE_BYTES_V2).unwrap();

    let payload = wait_for_event(
        &binary_events,
        |v| v["uri"].as_str() == Some(canonical.as_str()),
        Duration::from_secs(5),
    )
    .await
    .expect(
        "overwriting a watched raster image must broadcast binary_file_changed \
         with the image uri — even though the bytes are not valid UTF-8",
    );

    assert!(
        payload.get("content").is_none(),
        "binary_file_changed must not carry content — the watch never reads the file \
         (the <img> refetches via vellis-asset instead): {payload}"
    );

    let leaked_text_event = text_events
        .lock()
        .unwrap()
        .iter()
        .any(|v| v["uri"].as_str() == Some(canonical.as_str()));
    assert!(
        !leaked_text_event,
        "a binary watch must not emit the text-path file_changed (that would imply a read)"
    );
}

// ---------------------------------------------------------------------------
// ②削除: Remove → file_removed { uri }(テキスト経路と同名・同形)
// ---------------------------------------------------------------------------

/// 4. 監視中のラスタ画像を削除すると、テキスト経路と同じ `file_removed` が
///    uri 付きで届く — フロントの既存 file_removed → clearDocument 配線が
///    そのまま「表示を閉じる」になる。
#[tokio::test]
async fn remove_emits_file_removed_same_as_text_path() {
    let tmp = TempDir::new().unwrap();
    let img_path = tmp.path().join("doomed.png");
    std::fs::write(&img_path, PNG_LIKE_BYTES).unwrap();

    let coord = make_coordinator();
    let app = tauri::test::mock_app();
    let removed_events = capture_events(&app, "file_removed");
    let uri = make_uri(&img_path);
    let canonical = uri.canonical();

    let _sub = coord
        .subscribe_binary(
            uri.clone(),
            WindowId("win-1".into()),
            app.handle().clone(),
        )
        .await
        .unwrap();

    std::fs::remove_file(&img_path).unwrap();

    let payload = wait_for_event(
        &removed_events,
        |v| v["uri"].as_str() == Some(canonical.as_str()),
        Duration::from_secs(5),
    )
    .await
    .expect(
        "deleting a watched raster image must broadcast file_removed with the image uri \
         (the same event the text path uses, so the existing close wiring applies)",
    );
    assert_eq!(payload["uri"].as_str(), Some(canonical.as_str()));
}
