//! 要件#22 追補a の受け入れテスト(docs/requirements/req-22.md「## 追補a」・Issue #759)— Rust 層
//!
//! 「ローカルの root で、開いているファイルを外で名前の変更・別の場所へ移動すると
//!  (Finder の『ゴミ箱に入れる』も同じボリュームの中の移動)、元のパスから無くなった
//!  ことを、ふつうの削除と同じ `file_removed { uri }` で知らせる」
//!
//! 背景: macOS の FSEvents は移動・名前の変更に REMOVED の印を付けない
//! (`CREATED|RENAMED|MODIFIED|XATTR_MOD`)。`LocalProvider::watch` が notify の
//! `Modify(_)` をそのまま Modify に写すため、hub はテキストを読み直して失敗の warn を
//! 出すだけ・バイナリには `binary_file_changed` を出し、`file_removed` が出なかった。
//!
//! ## 契約(req-22.md 追補a 1〜6)と本ファイルの判定点
//!
//! 1. 元のパスから無くなったら削除と同じ `file_removed { uri }`(テキスト=`subscribe`・
//!    バイナリ=`subscribe_binary` の両方)
//! 2. 移った先は追いかけない(本ファイルでは「移った先」のイベントが元の uri で届かない
//!    ことまでは見ない。元の uri で `file_removed` が来れば足りる)
//! 3. 無くなったパスを読み直しにいかない: 続けて届く知らせでテキストの `file_changed`・
//!    バイナリの `binary_file_changed` を出さない。1 回の移動・1 回の削除で `file_removed` は 1 回
//! 4. 元のパスにファイルがあれば今と同じ: 原子的な保存(一時ファイル → rename で上書き)では
//!    `file_removed` を出さず、テキストは新しい中身の `file_changed`・バイナリは `binary_file_changed`
//!
//! 判定は実装の形(local.rs で写すか hub で調べるか)に縛られない。本物の
//! `DocumentCoordinator` と本物の notify(FSEvents)を mock app で動かし、
//! hub が app へ emit するイベントだけを観測する(`acceptance_req22.rs` と同じ道具立て)。
//!
//! 「出ない」「1 回だけ」の判定は、操作のあと一定の窓(`QUIET_WINDOW`)を待って数える。
//! FSEvents の遅延があるため「届く」の上限は `acceptance_req22.rs` と同じ 5 秒。
//!
//! AC-22-追a との対応:
//! - (a) `move_text_to_other_dir_emits_file_removed_without_file_changed`
//! - (b) `rename_text_in_same_dir_emits_file_removed_without_file_changed`
//! - (c) `move_binary_emits_file_removed_without_binary_file_changed`
//! - (d) `one_move_emits_file_removed_exactly_once`(テキストの移動)・
//!       `one_remove_file_emits_file_removed_exactly_once`(テキストの `remove_file`)・
//!       `one_binary_move_emits_file_removed_exactly_once`(バイナリの移動)
//! - (e) `atomic_save_text_emits_file_changed_not_file_removed`・
//!       `atomic_save_binary_emits_binary_file_changed_not_file_removed`
//! - (f) 既存テストの無改変=本ファイルでは扱わない(reviewer が diff で照合)

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::test::MockRuntime;
use tauri::Listener;
use tempfile::TempDir;

use vellis_lib::fs::registry::FileProviderRegistry;
use vellis_lib::fs::uri::Uri;
use vellis_lib::watch::hub::{DocumentCoordinator, WindowId};

// ---------------------------------------------------------------------------
// Helpers(acceptance_req22.rs と同じ流儀。共有 helper モジュールが無いので写す)
// ---------------------------------------------------------------------------

/// 「届く」の上限(FSEvents の遅延込み。acceptance_req22.rs と同じ)。
const ARRIVAL_TIMEOUT: Duration = Duration::from_secs(5);

/// 「出ない」「1 回だけ」を数える窓。1 回の移動で notify が続けて出す
/// `Create` / `Modify(Name)` / `Modify(Metadata)` / `Modify(Data)` が
/// 全部 hub を通り抜けるのに十分な長さ。
const QUIET_WINDOW: Duration = Duration::from_secs(2);

fn make_coordinator() -> Arc<DocumentCoordinator<MockRuntime>> {
    Arc::new(DocumentCoordinator::new(Arc::new(FileProviderRegistry::new())))
}

/// 既存テストと同じ作り方(canonicalize しない)。macOS の一時ディレクトリは
/// `/var/...` と `/private/var/...` の両方の名前を持つので、uri の比較は常に
/// `make_uri(&path).canonical()` 同士で行う。
fn make_uri(path: &std::path::Path) -> Uri {
    Uri {
        scheme: "file".into(),
        authority: None,
        path: path.to_path_buf(),
        raw: format!("file://{}", path.display()),
    }
}

/// PNG マジックナンバー+不正 UTF-8 バイト列(`read_text` に通すと必ず失敗する中身)。
const PNG_LIKE_BYTES: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0xFF, 0xFE, 0x00];
const PNG_LIKE_BYTES_V2: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0xFE, 0xFF, 0x01, 0x02];

const TEXT_V1: &str = "# v1\n\nbefore\n";
const TEXT_V2: &str = "# v2\n\nafter atomic save\n";

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

/// 述語を満たすイベントが届くまで待つ(notify は非同期なのでポーリング)。
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

/// `canonical` を uri に持つイベントの数。
fn count_for(events: &Arc<Mutex<Vec<serde_json::Value>>>, canonical: &str) -> usize {
    events
        .lock()
        .unwrap()
        .iter()
        .filter(|v| v["uri"].as_str() == Some(canonical))
        .count()
}

/// 「出ない」「1 回だけ」を数えるための待ち。
async fn quiet_window() {
    tokio::time::sleep(QUIET_WINDOW).await;
}

/// 原子的な保存(一時ファイルを隣に書いて rename で上書き)。Vellis 自身の
/// `LocalProvider::write_text` と同じ形(要件#48 契約①)だが、ここでは
/// 「外のエディタが同じ形で保存した」ことを模すので std::fs で直接やる。
fn atomic_replace(target: &std::path::Path, bytes: &[u8]) {
    let tmp = target.with_extension("tmp-atomic-save");
    std::fs::write(&tmp, bytes).unwrap();
    std::fs::rename(&tmp, target).unwrap();
}

// ---------------------------------------------------------------------------
// (a)(b) テキスト: 移動・名前の変更 → file_removed、そのあと file_changed は出ない
// ---------------------------------------------------------------------------

/// (a) テキストの文書を `subscribe` で開き、同じボリュームの別のディレクトリへ
///     rename で移すと `file_removed { uri }` が届く(数秒以内)。そのあと
///     `file_changed` は出ない(契約1・3)。
#[tokio::test]
async fn move_text_to_other_dir_emits_file_removed_without_file_changed() {
    let tmp = TempDir::new().unwrap();
    let doc_path = tmp.path().join("doc.md");
    std::fs::write(&doc_path, TEXT_V1).unwrap();
    let elsewhere = tmp.path().join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();

    let coord = make_coordinator();
    let app = tauri::test::mock_app();
    let removed_events = capture_events(&app, "file_removed");
    let changed_events = capture_events(&app, "file_changed");
    let uri = make_uri(&doc_path);
    let canonical = uri.canonical();

    let _sub = coord
        .subscribe(uri.clone(), WindowId("win-1".into()), app.handle().clone())
        .await
        .expect("subscribing an existing text document must succeed");

    std::fs::rename(&doc_path, elsewhere.join("doc.md")).unwrap();

    let payload = wait_for_event(
        &removed_events,
        |v| v["uri"].as_str() == Some(canonical.as_str()),
        ARRIVAL_TIMEOUT,
    )
    .await
    .expect(
        "moving a watched text document to another directory must broadcast file_removed \
         with the original uri — FSEvents carries no REMOVED flag for a rename, so the \
         watch must notice the path is gone (Issue #759)",
    );
    assert_eq!(payload["uri"].as_str(), Some(canonical.as_str()));

    quiet_window().await;
    assert_eq!(
        count_for(&changed_events, &canonical),
        0,
        "after the move, the hub must not re-read the vanished path and emit file_changed"
    );
}

/// (b) 同じディレクトリの中で名前を変えても (a) と同じ:`file_removed` が届き、
///     `file_changed` は出ない。
#[tokio::test]
async fn rename_text_in_same_dir_emits_file_removed_without_file_changed() {
    let tmp = TempDir::new().unwrap();
    let doc_path = tmp.path().join("doc.md");
    std::fs::write(&doc_path, TEXT_V1).unwrap();

    let coord = make_coordinator();
    let app = tauri::test::mock_app();
    let removed_events = capture_events(&app, "file_removed");
    let changed_events = capture_events(&app, "file_changed");
    let uri = make_uri(&doc_path);
    let canonical = uri.canonical();

    let _sub = coord
        .subscribe(uri.clone(), WindowId("win-1".into()), app.handle().clone())
        .await
        .expect("subscribing an existing text document must succeed");

    std::fs::rename(&doc_path, tmp.path().join("renamed.md")).unwrap();

    let payload = wait_for_event(
        &removed_events,
        |v| v["uri"].as_str() == Some(canonical.as_str()),
        ARRIVAL_TIMEOUT,
    )
    .await
    .expect(
        "renaming a watched text document within its directory must broadcast file_removed \
         with the original uri (same as a move: the original path is gone)",
    );
    assert_eq!(payload["uri"].as_str(), Some(canonical.as_str()));

    quiet_window().await;
    assert_eq!(
        count_for(&changed_events, &canonical),
        0,
        "after the rename, the hub must not re-read the vanished path and emit file_changed"
    );
}

// ---------------------------------------------------------------------------
// (c) バイナリ: 移動 → file_removed、そのあと binary_file_changed は出ない
// ---------------------------------------------------------------------------

/// (c) ラスタ画像を `subscribe_binary` で開いて別のディレクトリへ移すと
///     `file_removed` が届き、移したあとに `binary_file_changed` は出ない(契約1・3)。
///     今の実装は移動で `binary_file_changed` を(複数回)出し、`file_removed` を出さない。
#[tokio::test]
async fn move_binary_emits_file_removed_without_binary_file_changed() {
    let tmp = TempDir::new().unwrap();
    let img_path = tmp.path().join("photo.png");
    std::fs::write(&img_path, PNG_LIKE_BYTES).unwrap();
    let elsewhere = tmp.path().join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();

    let coord = make_coordinator();
    let app = tauri::test::mock_app();
    let removed_events = capture_events(&app, "file_removed");
    let binary_events = capture_events(&app, "binary_file_changed");
    let uri = make_uri(&img_path);
    let canonical = uri.canonical();

    let _sub = coord
        .subscribe_binary(uri.clone(), WindowId("win-1".into()), app.handle().clone())
        .await
        .expect("subscribing an existing raster image must succeed");

    std::fs::rename(&img_path, elsewhere.join("photo.png")).unwrap();

    let payload = wait_for_event(
        &removed_events,
        |v| v["uri"].as_str() == Some(canonical.as_str()),
        ARRIVAL_TIMEOUT,
    )
    .await
    .expect(
        "moving a watched raster image must broadcast file_removed with the original uri \
         (the same event unlink produces, so the existing close wiring applies)",
    );
    assert_eq!(payload["uri"].as_str(), Some(canonical.as_str()));

    quiet_window().await;
    assert_eq!(
        count_for(&binary_events, &canonical),
        0,
        "after the move, the hub must not announce binary_file_changed for the vanished path \
         (the <img> would refetch a file that no longer exists)"
    );
}

// ---------------------------------------------------------------------------
// (d) 1 回の移動・1 回の削除で file_removed は 1 回
// ---------------------------------------------------------------------------

/// (d-1) テキストの 1 回の移動で `file_removed` はちょうど 1 回。notify が 1 回の
///       移動に対して続けて出す知らせ(`Modify(Name)`・`Modify(Metadata)`・
///       `Modify(Data)` など)で重ねて出さない(契約3)。
#[tokio::test]
async fn one_move_emits_file_removed_exactly_once() {
    let tmp = TempDir::new().unwrap();
    let doc_path = tmp.path().join("doc.md");
    std::fs::write(&doc_path, TEXT_V1).unwrap();
    let elsewhere = tmp.path().join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();

    let coord = make_coordinator();
    let app = tauri::test::mock_app();
    let removed_events = capture_events(&app, "file_removed");
    let uri = make_uri(&doc_path);
    let canonical = uri.canonical();

    let _sub = coord
        .subscribe(uri.clone(), WindowId("win-1".into()), app.handle().clone())
        .await
        .expect("subscribing an existing text document must succeed");

    std::fs::rename(&doc_path, elsewhere.join("doc.md")).unwrap();

    wait_for_event(
        &removed_events,
        |v| v["uri"].as_str() == Some(canonical.as_str()),
        ARRIVAL_TIMEOUT,
    )
    .await
    .expect("one move of a watched text document must broadcast file_removed");

    quiet_window().await;
    assert_eq!(
        count_for(&removed_events, &canonical),
        1,
        "one move must produce exactly one file_removed — the follow-up notify events for \
         the same move must not repeat it"
    );
}

/// (d-2) テキストの 1 回の削除(`remove_file`)で `file_removed` はちょうど 1 回
///       (契約5: ふつうの削除の振る舞いは不変。FSEvents は削除にも
///       `CREATED|REMOVED|MODIFIED|XATTR_MOD` を付けるので、NotFound を見て
///       `file_removed` を出す作りにしても重ねて出してはいけない)。
#[tokio::test]
async fn one_remove_file_emits_file_removed_exactly_once() {
    let tmp = TempDir::new().unwrap();
    let doc_path = tmp.path().join("doomed.md");
    std::fs::write(&doc_path, TEXT_V1).unwrap();

    let coord = make_coordinator();
    let app = tauri::test::mock_app();
    let removed_events = capture_events(&app, "file_removed");
    let uri = make_uri(&doc_path);
    let canonical = uri.canonical();

    let _sub = coord
        .subscribe(uri.clone(), WindowId("win-1".into()), app.handle().clone())
        .await
        .expect("subscribing an existing text document must succeed");

    std::fs::remove_file(&doc_path).unwrap();

    wait_for_event(
        &removed_events,
        |v| v["uri"].as_str() == Some(canonical.as_str()),
        ARRIVAL_TIMEOUT,
    )
    .await
    .expect("deleting a watched text document must broadcast file_removed");

    quiet_window().await;
    assert_eq!(
        count_for(&removed_events, &canonical),
        1,
        "one unlink must produce exactly one file_removed — the follow-up notify events \
         (Modify after Remove) must not repeat it"
    );
}

/// (d-3) バイナリの 1 回の移動でも `file_removed` はちょうど 1 回。
#[tokio::test]
async fn one_binary_move_emits_file_removed_exactly_once() {
    let tmp = TempDir::new().unwrap();
    let img_path = tmp.path().join("photo.png");
    std::fs::write(&img_path, PNG_LIKE_BYTES).unwrap();
    let elsewhere = tmp.path().join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();

    let coord = make_coordinator();
    let app = tauri::test::mock_app();
    let removed_events = capture_events(&app, "file_removed");
    let uri = make_uri(&img_path);
    let canonical = uri.canonical();

    let _sub = coord
        .subscribe_binary(uri.clone(), WindowId("win-1".into()), app.handle().clone())
        .await
        .expect("subscribing an existing raster image must succeed");

    std::fs::rename(&img_path, elsewhere.join("photo.png")).unwrap();

    wait_for_event(
        &removed_events,
        |v| v["uri"].as_str() == Some(canonical.as_str()),
        ARRIVAL_TIMEOUT,
    )
    .await
    .expect("one move of a watched raster image must broadcast file_removed");

    quiet_window().await;
    assert_eq!(
        count_for(&removed_events, &canonical),
        1,
        "one move must produce exactly one file_removed for a binary watch too"
    );
}

// ---------------------------------------------------------------------------
// (e) 原子的な保存(一時ファイル → rename で上書き)は今と同じ=file_removed を出さない
// ---------------------------------------------------------------------------

/// (e-1) テキスト: 一時ファイルを書いて rename で上書きすると、`file_removed` は出ず、
///       新しい中身の `file_changed` が届く(契約4: 元のパスにファイルがあれば今と同じ)。
#[tokio::test]
async fn atomic_save_text_emits_file_changed_not_file_removed() {
    let tmp = TempDir::new().unwrap();
    let doc_path = tmp.path().join("doc.md");
    std::fs::write(&doc_path, TEXT_V1).unwrap();

    let coord = make_coordinator();
    let app = tauri::test::mock_app();
    let removed_events = capture_events(&app, "file_removed");
    let changed_events = capture_events(&app, "file_changed");
    let uri = make_uri(&doc_path);
    let canonical = uri.canonical();

    let _sub = coord
        .subscribe(uri.clone(), WindowId("win-1".into()), app.handle().clone())
        .await
        .expect("subscribing an existing text document must succeed");

    atomic_replace(&doc_path, TEXT_V2.as_bytes());

    let payload = wait_for_event(
        &changed_events,
        |v| {
            v["uri"].as_str() == Some(canonical.as_str()) && v["content"].as_str() == Some(TEXT_V2)
        },
        ARRIVAL_TIMEOUT,
    )
    .await
    .expect(
        "an atomic save (tmp + rename over the watched path) must broadcast file_changed \
         with the new content — the original path still has a file, so it is a change, \
         not a removal",
    );
    assert_eq!(payload["content"].as_str(), Some(TEXT_V2));

    quiet_window().await;
    assert_eq!(
        count_for(&removed_events, &canonical),
        0,
        "an atomic save must never be mistaken for a removal: the rename notification \
         arrives but the original path still exists"
    );
}

/// (e-2) バイナリ: 一時ファイルを書いて rename で上書きすると、`file_removed` は出ず、
///       `binary_file_changed` が届く。
#[tokio::test]
async fn atomic_save_binary_emits_binary_file_changed_not_file_removed() {
    let tmp = TempDir::new().unwrap();
    let img_path = tmp.path().join("photo.png");
    std::fs::write(&img_path, PNG_LIKE_BYTES).unwrap();

    let coord = make_coordinator();
    let app = tauri::test::mock_app();
    let removed_events = capture_events(&app, "file_removed");
    let binary_events = capture_events(&app, "binary_file_changed");
    let uri = make_uri(&img_path);
    let canonical = uri.canonical();

    let _sub = coord
        .subscribe_binary(uri.clone(), WindowId("win-1".into()), app.handle().clone())
        .await
        .expect("subscribing an existing raster image must succeed");

    atomic_replace(&img_path, PNG_LIKE_BYTES_V2);

    let payload = wait_for_event(
        &binary_events,
        |v| v["uri"].as_str() == Some(canonical.as_str()),
        ARRIVAL_TIMEOUT,
    )
    .await
    .expect(
        "an atomic save over a watched raster image must broadcast binary_file_changed — \
         the original path still has a file, so it is a change, not a removal",
    );
    assert!(
        payload.get("content").is_none(),
        "binary_file_changed must still carry no content (要件#22): {payload}"
    );

    quiet_window().await;
    assert_eq!(
        count_for(&removed_events, &canonical),
        0,
        "an atomic save over a raster image must never be mistaken for a removal"
    );
}
