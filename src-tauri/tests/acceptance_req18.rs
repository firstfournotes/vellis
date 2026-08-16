//! 要件#18 の受け入れテスト(requirements.md #18)— Rust 層
//!
//! 「ファイルツリーが展開中のサブディレクトリでもファイル/フォルダの追加・削除を
//! 自動反映する(現状は root 直下のみ自動反映され、サブディレクトリは reload が必要)」
//!
//! 契約(2026-08-16 由谷決定):
//! - ② 方式=**展開済みディレクトリ単位の監視**: ディレクトリ展開時に
//!   subscribe_directory を追加登録・折りたたみ/root 切替/ウィンドウクローズで解除
//!   (既存の subscribe_directory・refcount・emit の仕組みを流用)。
//!   notify の NonRecursive は維持=root 丸ごと再帰監視はしない
//! - ③ イベント受信時は該当ディレクトリのみ再一覧化し、当該ノードの子リストを更新
//!   (ペイロードの uri で対象ノードを特定)
//! - ⑤ ssh リモートは対象外 ⑥ デバウンスなし・file_removed→clearDocument 不変・依存追加なし
//!
//! 判定範囲(本ファイル): サブディレクトリ監視の**ライフサイクル**(登録・重複・解除・
//! 全解除・Drop)と、**変更イベント→当該ディレクトリの再一覧ブロードキャスト**。
//! ツリーの子リスト更新・展開状態維持・ノード除去のフロント純ロジックは
//! `src/lib/tree-refresh.acceptance.test.ts` が判定する。
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```ignore
//! // 実装先: src-tauri/src/watch/dir_watch.rs(watch/mod.rs から `pub mod dir_watch`)。
//! // ウィンドウ1つが持つ「展開中サブディレクトリの監視束」。フロントの展開/折りたたみを
//! // 受けるコマンド(subscribe_dir / unsubscribe_dir 等 — 命名は実装裁量)と、root 切替・
//! // ウィンドウクローズの掃除がこの束を通ることは reviewer 照合。
//! pub struct DirWatchSet<R: tauri::Runtime = tauri::Wry> { /* uri.canonical() → WatchSubscription */ }
//!
//! impl<R: tauri::Runtime> DirWatchSet<R> {
//!     pub fn new() -> Self;
//!     /// 展開時: uri の directory 監視を hub に追加登録する(キー= uri.canonical())。
//!     /// 既に監視中の URI は no-op(Ok)— 展開⇔折りたたみの反復や復元展開で
//!     /// 購読を積み増さない。
//!     pub async fn watch(
//!         &mut self,
//!         hub: &std::sync::Arc<DocumentCoordinator<R>>,
//!         uri: Uri,
//!         window_id: WindowId,
//!         app: tauri::AppHandle<R>,
//!     ) -> Result<(), FsError>;
//!     /// 折りたたみ時: 当該 canonical URI の購読を解放する(未監視は no-op)。
//!     pub fn unwatch(&mut self, canonical: &str);
//!     /// root 切替時: 全購読を解放する(ウィンドウクローズは Drop が同じ結果になる)。
//!     pub fn clear(&mut self);
//!     pub fn is_watched(&self, canonical: &str) -> bool;
//! }
//!
//! // 観測 API: DocumentCoordinator の既存 #[cfg(test)] ヘルパ `refcount` を
//! // pub へ昇格する(観測のみ・挙動不変。統合テストから refcount 共有と解放を
//! // 機械判定するため)。`entry_count` の昇格は任意。
//! impl<R: tauri::Runtime> DocumentCoordinator<R> {
//!     pub async fn refcount(&self, canonical: &str) -> Option<usize>;
//! }
//! ```
//!
//! イベントは既存 `directory_changed { root_uri, entries }` の**流用で確定**
//! (要件の「流用/新設は実装裁量」を本テストの設計判断で流用側に固定 — 既存 hub の
//! WatchKind::Directory の emit をそのまま使う方式のため。フロントは root_uri が
//! root か展開中サブディレクトリかで分岐する)。
//!
//! ## reviewer 照合に委ねる項目(実ウィンドウ・コマンド配線)
//! - 展開(ExplorerItem の子読み込み)で watch・折りたたみで unwatch が呼ばれる配線
//! - root 切替(set_root)・ウィンドウクローズで束が clear/Drop される配線
//! - ssh リモート root ではサブディレクトリ監視を登録しないこと(対象外=既知の制限)
//! - 開いている文書の削除時挙動(file_removed→clearDocument)が不変であること
//!
//! ## 人間ゲート(gate)
//! - 実機で展開中サブディレクトリにファイル/フォルダを追加・削除してツリーに映ること

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::test::MockRuntime;
use tauri::Listener;
use tempfile::TempDir;

use vellis_lib::fs::registry::FileProviderRegistry;
use vellis_lib::fs::uri::Uri;
use vellis_lib::watch::dir_watch::DirWatchSet;
use vellis_lib::watch::hub::{DocumentCoordinator, WindowId};

// ---------------------------------------------------------------------------
// Helpers(watch/hub.rs の既存ユニットテストと同じ流儀)
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

/// 非同期の unsubscribe(WatchSubscription の Drop が spawn する)を待つ。
async fn settle() {
    tokio::time::sleep(Duration::from_millis(100)).await;
}

/// `directory_changed` を捕捉するリスナーを張る。App 本体はイベント配送に
/// 生きている必要があるので、呼び出し側が保持する。
fn capture_directory_changed(
    app: &tauri::App<MockRuntime>,
) -> Arc<Mutex<Vec<serde_json::Value>>> {
    let events: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    app.listen_any("directory_changed", move |event| {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            sink.lock().unwrap().push(v);
        }
    });
    events
}

/// 述語を満たす `directory_changed` が届くまで待つ(notify は非同期なので
/// ポーリング。macOS の FSEvents は latency があるためタイムアウトは長めに取る)。
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

/// ペイロードの entries から name の一覧を取り出す。
fn entry_names(payload: &serde_json::Value) -> Vec<String> {
    payload["entries"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|e| e["name"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// ライフサイクル(契約②: 展開で登録・折りたたみ/root 切替/クローズで解除)
// ---------------------------------------------------------------------------

/// 1. 展開相当: watch でサブディレクトリの監視が hub に登録される(refcount=1)。
#[tokio::test]
async fn watch_subdirectory_registers_a_directory_watch() {
    let tmp = TempDir::new().unwrap();
    let sub_path = tmp.path().join("notes");
    std::fs::create_dir(&sub_path).unwrap();

    let coord = make_coordinator();
    let app = tauri::test::mock_app();
    let sub_uri = make_uri(&sub_path);

    let mut set: DirWatchSet<MockRuntime> = DirWatchSet::new();
    set.watch(
        &coord,
        sub_uri.clone(),
        WindowId("win-1".into()),
        app.handle().clone(),
    )
    .await
    .expect("watching an existing subdirectory must succeed");

    assert!(set.is_watched(&sub_uri.canonical()));
    assert_eq!(
        coord.refcount(&sub_uri.canonical()).await,
        Some(1),
        "expanding a subdirectory must register exactly one hub watch"
    );
}

/// 2. 展開⇔折りたたみの反復・復元展開: 同じ URI の watch を重ねても購読を
///    積み増さない(refcount は 1 のまま・unwatch 1回で解放される)。
#[tokio::test]
async fn rewatching_same_subdirectory_does_not_stack_subscriptions() {
    let tmp = TempDir::new().unwrap();
    let sub_path = tmp.path().join("notes");
    std::fs::create_dir(&sub_path).unwrap();

    let coord = make_coordinator();
    let app = tauri::test::mock_app();
    let sub_uri = make_uri(&sub_path);
    let wid = WindowId("win-1".into());

    let mut set: DirWatchSet<MockRuntime> = DirWatchSet::new();
    set.watch(&coord, sub_uri.clone(), wid.clone(), app.handle().clone())
        .await
        .unwrap();
    set.watch(&coord, sub_uri.clone(), wid, app.handle().clone())
        .await
        .expect("re-watching an already-watched directory must be a no-op, not an error");

    assert_eq!(
        coord.refcount(&sub_uri.canonical()).await,
        Some(1),
        "one window must hold at most one subscription per directory"
    );

    set.unwatch(&sub_uri.canonical());
    settle().await;
    assert_eq!(
        coord.refcount(&sub_uri.canonical()).await,
        None,
        "a single unwatch must fully release the watch — proof nothing was stacked"
    );
    assert!(!set.is_watched(&sub_uri.canonical()));
}

/// 3. 折りたたみ相当: unwatch で監視が解放され、以後の変更でイベントが出ない。
#[tokio::test]
async fn unwatch_stops_events_for_that_directory() {
    let tmp = TempDir::new().unwrap();
    let sub_path = tmp.path().join("notes");
    std::fs::create_dir(&sub_path).unwrap();

    let coord = make_coordinator();
    let app = tauri::test::mock_app();
    let events = capture_directory_changed(&app);
    let sub_uri = make_uri(&sub_path);
    let canonical = sub_uri.canonical();

    let mut set: DirWatchSet<MockRuntime> = DirWatchSet::new();
    set.watch(
        &coord,
        sub_uri.clone(),
        WindowId("win-1".into()),
        app.handle().clone(),
    )
    .await
    .unwrap();

    set.unwatch(&canonical);
    settle().await;
    assert_eq!(coord.refcount(&canonical).await, None);

    std::fs::write(sub_path.join("late.md"), "# Late").unwrap();
    let leaked = wait_for_event(
        &events,
        |v| v["root_uri"].as_str() == Some(canonical.as_str()),
        Duration::from_millis(700),
    )
    .await;
    assert!(
        leaked.is_none(),
        "a collapsed (unwatched) directory must not broadcast directory_changed"
    );
}

/// 4. root 切替相当: clear で束の全監視が解放される。
#[tokio::test]
async fn clear_releases_every_watch() {
    let tmp = TempDir::new().unwrap();
    let sub_a = tmp.path().join("a");
    let sub_b = tmp.path().join("b");
    std::fs::create_dir(&sub_a).unwrap();
    std::fs::create_dir(&sub_b).unwrap();

    let coord = make_coordinator();
    let app = tauri::test::mock_app();
    let uri_a = make_uri(&sub_a);
    let uri_b = make_uri(&sub_b);
    let wid = WindowId("win-1".into());

    let mut set: DirWatchSet<MockRuntime> = DirWatchSet::new();
    set.watch(&coord, uri_a.clone(), wid.clone(), app.handle().clone())
        .await
        .unwrap();
    set.watch(&coord, uri_b.clone(), wid, app.handle().clone())
        .await
        .unwrap();
    assert_eq!(coord.refcount(&uri_a.canonical()).await, Some(1));
    assert_eq!(coord.refcount(&uri_b.canonical()).await, Some(1));

    set.clear();
    settle().await;
    assert_eq!(
        coord.refcount(&uri_a.canonical()).await,
        None,
        "switching the root must release every expanded-directory watch"
    );
    assert_eq!(coord.refcount(&uri_b.canonical()).await, None);
    assert!(!set.is_watched(&uri_a.canonical()));
    assert!(!set.is_watched(&uri_b.canonical()));
}

/// 5. ウィンドウクローズ相当: 束の Drop で監視が解放される(RAII)。
#[tokio::test]
async fn dropping_the_set_releases_watches() {
    let tmp = TempDir::new().unwrap();
    let sub_path = tmp.path().join("notes");
    std::fs::create_dir(&sub_path).unwrap();

    let coord = make_coordinator();
    let app = tauri::test::mock_app();
    let sub_uri = make_uri(&sub_path);

    let mut set: DirWatchSet<MockRuntime> = DirWatchSet::new();
    set.watch(
        &coord,
        sub_uri.clone(),
        WindowId("win-1".into()),
        app.handle().clone(),
    )
    .await
    .unwrap();
    assert_eq!(coord.refcount(&sub_uri.canonical()).await, Some(1));

    drop(set);
    settle().await;
    assert_eq!(
        coord.refcount(&sub_uri.canonical()).await,
        None,
        "closing a window (dropping its watch set) must release its directory watches"
    );
}

/// 6. 2ウィンドウが同じサブディレクトリを展開: hub の refcount で1本の
///    notify 監視を共有し、片方の解除では監視が生き残る(既存 hub の流用の証明)。
#[tokio::test]
async fn watches_from_two_windows_share_one_hub_watch() {
    let tmp = TempDir::new().unwrap();
    let sub_path = tmp.path().join("shared");
    std::fs::create_dir(&sub_path).unwrap();

    let coord = make_coordinator();
    let app = tauri::test::mock_app();
    let sub_uri = make_uri(&sub_path);

    let mut set1: DirWatchSet<MockRuntime> = DirWatchSet::new();
    let mut set2: DirWatchSet<MockRuntime> = DirWatchSet::new();
    set1.watch(
        &coord,
        sub_uri.clone(),
        WindowId("win-1".into()),
        app.handle().clone(),
    )
    .await
    .unwrap();
    set2.watch(
        &coord,
        sub_uri.clone(),
        WindowId("win-2".into()),
        app.handle().clone(),
    )
    .await
    .unwrap();

    assert_eq!(
        coord.refcount(&sub_uri.canonical()).await,
        Some(2),
        "two windows expanding the same directory must share one refcounted watch"
    );

    drop(set1);
    settle().await;
    assert_eq!(
        coord.refcount(&sub_uri.canonical()).await,
        Some(1),
        "the surviving window must keep the watch alive"
    );

    drop(set2);
    settle().await;
    assert_eq!(coord.refcount(&sub_uri.canonical()).await, None);
}

// ---------------------------------------------------------------------------
// イベント→再一覧化(契約③: uri=サブディレクトリ・entries=当該ディレクトリの再一覧)
// ---------------------------------------------------------------------------

/// 7. 監視中サブディレクトリへの**追加**: directory_changed が
///    root_uri=サブディレクトリで届き、entries に新ファイルが入っている。
#[tokio::test]
async fn create_in_watched_subdirectory_broadcasts_relisted_entries() {
    let tmp = TempDir::new().unwrap();
    let sub_path = tmp.path().join("notes");
    std::fs::create_dir(&sub_path).unwrap();
    std::fs::write(sub_path.join("old.md"), "# Old").unwrap();

    let coord = make_coordinator();
    let app = tauri::test::mock_app();
    let events = capture_directory_changed(&app);
    let sub_uri = make_uri(&sub_path);
    let canonical = sub_uri.canonical();

    let mut set: DirWatchSet<MockRuntime> = DirWatchSet::new();
    set.watch(
        &coord,
        sub_uri.clone(),
        WindowId("win-1".into()),
        app.handle().clone(),
    )
    .await
    .unwrap();

    std::fs::write(sub_path.join("new.md"), "# New").unwrap();

    let payload = wait_for_event(
        &events,
        |v| {
            v["root_uri"].as_str() == Some(canonical.as_str())
                && entry_names(v).iter().any(|n| n == "new.md")
        },
        Duration::from_secs(5),
    )
    .await
    .expect(
        "creating a file in a watched subdirectory must broadcast directory_changed \
         with the subdirectory uri and a listing that contains the new file",
    );
    let names = entry_names(&payload);
    assert!(names.iter().any(|n| n == "old.md"), "the re-listing must be complete: {names:?}");
}

/// 8. 監視中サブディレクトリからの**削除**: 再一覧に削除ファイルが含まれない
///    directory_changed が届く(残存ファイルは含まれる)。
#[tokio::test]
async fn remove_in_watched_subdirectory_broadcasts_relisted_entries() {
    let tmp = TempDir::new().unwrap();
    let sub_path = tmp.path().join("notes");
    std::fs::create_dir(&sub_path).unwrap();
    std::fs::write(sub_path.join("doomed.md"), "# Doomed").unwrap();
    std::fs::write(sub_path.join("kept.md"), "# Kept").unwrap();

    let coord = make_coordinator();
    let app = tauri::test::mock_app();
    let events = capture_directory_changed(&app);
    let sub_uri = make_uri(&sub_path);
    let canonical = sub_uri.canonical();

    let mut set: DirWatchSet<MockRuntime> = DirWatchSet::new();
    set.watch(
        &coord,
        sub_uri.clone(),
        WindowId("win-1".into()),
        app.handle().clone(),
    )
    .await
    .unwrap();

    std::fs::remove_file(sub_path.join("doomed.md")).unwrap();

    let payload = wait_for_event(
        &events,
        |v| {
            v["root_uri"].as_str() == Some(canonical.as_str())
                && !entry_names(v).iter().any(|n| n == "doomed.md")
        },
        Duration::from_secs(5),
    )
    .await
    .expect(
        "deleting a file in a watched subdirectory must broadcast directory_changed \
         whose listing no longer contains the deleted file",
    );
    let names = entry_names(&payload);
    assert!(
        names.iter().any(|n| n == "kept.md"),
        "surviving files must stay in the re-listing: {names:?}"
    );
}
