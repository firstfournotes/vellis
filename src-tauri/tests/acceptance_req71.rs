//! 要件#71 の受け入れテスト(docs/requirements/req-71.md)— Rust 層(AC-71-1・契約1)
//!
//! 「開くのに失敗しても、いま開いている文書のセッションを落とさない」。
//! `open_in_window`(`commands/document.rs`)は `tauri::State<AppState>` と `Window` を
//! 要るのでテストから直接は呼べない。契約1 が「差し替えを `WindowManager` の公開の口に
//! 切り出す」としているので、本テストは **その口を使って手順を写し**、外の状態
//! (`DocumentCoordinator::refcount`・`file_changed` イベント)で判定する。
//! `open_in_window` 自体の手順(先に落とさない・口を通す)はソース走査で固定する。
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前・型)
//!
//! ```ignore
//! // src-tauri/src/window/manager.rs
//! impl<R: tauri::Runtime> WindowManager<R> {
//!     /// `label` の窓のセッションを `session` に差し替え、前のセッションを返す
//!     /// (呼び出し側が drop する=RAII で前の購読が外れる)。窓に前のセッションが
//!     /// 無ければ `None`。
//!     pub fn replace_session(
//!         &mut self,
//!         label: &str,
//!         session: DocumentSession<R>,
//!     ) -> Option<DocumentSession<R>>;
//! }
//!
//! // src-tauri/src/commands/document.rs の open_in_window(契約1)
//! //   - `DocumentSession::open` / `open_binary` より前に `session.take()` をしない
//! //     (失敗したら前のセッションをそのまま残す)
//! //   - 開けたら `replace_session(…)` で差し替える(`win_state.session = Some(…)` の
//! //     直接代入はしない)。前のセッションは drop する
//! //   - `DocumentSession::open*` と `recent_files::record_file` はこの関数の中に残す
//! //     (AC-64-9 が本文を走査している)
//! ```
//!
//! ## 判定しないもの
//! - 実アプリで alert が出ること・画面が前の文書のまま → フロントの wiring テスト/人間ゲート
//! - `replace_session` を知らない label で呼んだときの扱い → 要件に無い(reviewer 照合)
//!
//! ## 前提
//! - 「読めない権限」のケースは root 以外のユーザーで走ること(root は 0o000 でも読める)。
//! - `file_changed` の到着待ちは macOS FSEvents の latency を見て 5 秒まで待つ。

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::test::MockRuntime;
use tauri::Listener;
use tempfile::TempDir;

use vellis_lib::fs::registry::FileProviderRegistry;
use vellis_lib::fs::uri::Uri;
use vellis_lib::session::document::DocumentSession;
use vellis_lib::watch::hub::{DocumentCoordinator, WindowId};
use vellis_lib::window::manager::{WindowArgs, WindowManager};

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

fn make_uri(path: &std::path::Path) -> Uri {
    Uri {
        scheme: "file".into(),
        authority: None,
        path: path.to_path_buf(),
        raw: format!("file://{}", path.display()),
    }
}

/// `WatchSubscription` の Drop は unsubscribe を非同期タスクに投げるので、少し待つ。
async fn settle() {
    tokio::time::sleep(Duration::from_millis(100)).await;
}

fn capture(app: &tauri::App<MockRuntime>, name: &str) -> Arc<Mutex<Vec<serde_json::Value>>> {
    let events: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    app.listen_any(name.to_string(), move |event| {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            sink.lock().unwrap().push(v);
        }
    });
    events
}

async fn wait_for_uri(
    events: &Arc<Mutex<Vec<serde_json::Value>>>,
    uri: &str,
    timeout: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if events.lock().unwrap().iter().any(|v| v["uri"] == uri) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

const MAIN: &str = "main";

/// 文書 A を開いた窓 `main` と、開けない文書たち・開ける文書 C。
struct Fixture {
    _tmp: TempDir,
    /// 開いている文書 A。
    a: Uri,
    /// 開ける別の文書 C。
    c: Uri,
    /// リンク切れのシンボリックリンク。
    broken: Uri,
    /// UTF-8 でないテキスト(Shift_JIS の「あい」)。
    sjis: Uri,
    /// 50MB 超(sparse)。
    big: Uri,
    /// 読めない権限(0o000)。
    noperm: Uri,
    coordinator: Arc<DocumentCoordinator<MockRuntime>>,
    providers: Arc<FileProviderRegistry>,
    app: tauri::App<MockRuntime>,
    wm: WindowManager<MockRuntime>,
}

impl Fixture {
    async fn open(&self, uri: &Uri) -> Result<DocumentSession<MockRuntime>, String> {
        DocumentSession::open(
            WindowId(MAIN.into()),
            uri.clone(),
            &self.providers,
            &self.coordinator,
            self.app.handle(),
        )
        .await
        .map(|(s, _)| s)
        .map_err(|e| e.to_string())
    }

    async fn open_binary(&self, uri: &Uri) -> Result<DocumentSession<MockRuntime>, String> {
        DocumentSession::open_binary(
            WindowId(MAIN.into()),
            uri.clone(),
            &self.providers,
            &self.coordinator,
            self.app.handle(),
        )
        .await
        .map(|(s, _)| s)
        .map_err(|e| e.to_string())
    }

    async fn refcount(&self, uri: &Uri) -> Option<usize> {
        self.coordinator.refcount(&uri.canonical()).await
    }

    fn write(&self, uri: &Uri, content: &str) {
        std::fs::write(&uri.path, content).unwrap();
    }
}

async fn fixture() -> Fixture {
    let tmp = TempDir::new().unwrap();
    let a_path = tmp.path().join("a.md");
    std::fs::write(&a_path, "# A\n").unwrap();
    let c_path = tmp.path().join("c.md");
    std::fs::write(&c_path, "# C\n").unwrap();

    let broken_path = tmp.path().join("broken.md");
    std::os::unix::fs::symlink(tmp.path().join("missing.md"), &broken_path).unwrap();

    let sjis_path = tmp.path().join("sjis.txt");
    std::fs::write(&sjis_path, [0x82u8, 0xa0, 0x82, 0xa2, 0x0a]).unwrap();

    let big_path = tmp.path().join("big.log");
    std::fs::File::create(&big_path)
        .unwrap()
        .set_len(51 * 1024 * 1024)
        .unwrap();

    let noperm_path = tmp.path().join("noperm.md");
    std::fs::write(&noperm_path, "x").unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&noperm_path, std::fs::Permissions::from_mode(0o000)).unwrap();
    }

    let providers = Arc::new(FileProviderRegistry::new());
    let coordinator = Arc::new(DocumentCoordinator::new(Arc::clone(&providers)));
    let app = tauri::test::mock_app();
    let mut wm: WindowManager<MockRuntime> = WindowManager::new();
    wm.register_window(MAIN.into(), WindowArgs::default());

    let mut f = Fixture {
        _tmp: tmp,
        a: make_uri(&a_path),
        c: make_uri(&c_path),
        broken: make_uri(&broken_path),
        sjis: make_uri(&sjis_path),
        big: make_uri(&big_path),
        noperm: make_uri(&noperm_path),
        coordinator,
        providers,
        app,
        wm,
    };

    // 文書 A を開く(open_in_window の成功経路と同じ: 開けてから口で差し替える)。
    let session_a = f.open(&f.a).await.expect("A opens");
    let previous = f.wm.replace_session(MAIN, session_a);
    assert!(previous.is_none(), "the window had no session before A");
    assert_eq!(f.refcount(&f.a).await, Some(1), "A is watched once");
    f
}

/// 開けない文書 B を開こうとして失敗したあとも、A の購読が 1 のまま残り、
/// A を書き換えると `file_changed` が届く(契約1 の核)。
async fn assert_failed_open_keeps_a(f: &mut Fixture, bad: Uri) {
    let err = f
        .open(&bad)
        .await
        .err()
        .unwrap_or_else(|| panic!("{} must fail to open", bad.raw));
    assert!(!err.is_empty(), "the failure carries a reason (alert に素通しされる)");
    settle().await;

    // 窓のセッションは A のまま。
    let state = f.wm.get(MAIN).expect("window is registered");
    let held = state
        .session
        .as_ref()
        .expect("the window still holds a session after the failed open");
    assert_eq!(held.uri.raw, f.a.raw, "the session held is still A");

    // 購読: A は 1 のまま・B の購読は残らない。
    assert_eq!(f.refcount(&f.a).await, Some(1), "A's watch survives the failed open");
    assert_eq!(f.refcount(&bad).await, None, "the failed open leaves no watch of its own");

    // A を書き換えると file_changed が届く(変更追従が続いている)。
    let events = capture(&f.app, "file_changed");
    f.write(&f.a, "# A changed\n");
    assert!(
        wait_for_uri(&events, &f.a.raw, Duration::from_secs(5)).await,
        "file_changed for A still arrives after the failed open of {}",
        bad.raw
    );
}

// ---------------------------------------------------------------------------
// AC-71-1 — 開けない B(4 種)で失敗しても A の購読と変更追従が残る
// ---------------------------------------------------------------------------

/// 1. リンク切れ(`DocumentSession::open` と `open_binary` の両方で失敗する)。
#[tokio::test]
async fn failed_open_of_broken_symlink_keeps_current_session_and_watch() {
    let mut f = fixture().await;
    // 読まない経路(ラスタ画像=open_binary_document)でも同じ。
    let broken = f.broken.clone();
    assert!(f.open_binary(&broken).await.is_err(), "open_binary of a broken symlink fails");
    assert_failed_open_keeps_a(&mut f, broken).await;
}

/// 2. UTF-8 でないテキスト(Shift_JIS)。
#[tokio::test]
async fn failed_open_of_non_utf8_text_keeps_current_session_and_watch() {
    let mut f = fixture().await;
    let sjis = f.sjis.clone();
    assert_failed_open_keeps_a(&mut f, sjis).await;
}

/// 3. 50MB 超。
#[tokio::test]
async fn failed_open_of_too_large_file_keeps_current_session_and_watch() {
    let mut f = fixture().await;
    let big = f.big.clone();
    assert_failed_open_keeps_a(&mut f, big).await;
}

/// 4. 読めない権限。
#[tokio::test]
async fn failed_open_of_unreadable_file_keeps_current_session_and_watch() {
    let mut f = fixture().await;
    let noperm = f.noperm.clone();
    assert_failed_open_keeps_a(&mut f, noperm).await;
}

// ---------------------------------------------------------------------------
// AC-71-1 — 開ける C に差し替えたら A の購読は外れ C が 1・同じ文書の開き直しは 1 のまま
// ---------------------------------------------------------------------------

/// 5. 開ける C に差し替える: 前のセッション(A)が返り、drop すると A の購読が外れて
///    C の購読が 1 になる。窓のセッションは C。C を書き換えると file_changed が届く。
#[tokio::test]
async fn replacing_with_an_openable_document_releases_a_and_watches_c_once() {
    let mut f = fixture().await;
    let session_c = f.open(&f.c).await.expect("C opens");
    // subscribe-first なので差し替え前は A=1・C=1 が同時に立つ。
    assert_eq!(f.refcount(&f.a).await, Some(1));
    assert_eq!(f.refcount(&f.c).await, Some(1));

    let previous = f.wm.replace_session(MAIN, session_c);
    let previous = previous.expect("replace_session returns the previous session (A)");
    assert_eq!(previous.uri.raw, f.a.raw, "the returned session is A");
    drop(previous);
    settle().await;

    assert_eq!(f.refcount(&f.a).await, None, "A's watch is released (no other window has it)");
    assert_eq!(f.refcount(&f.c).await, Some(1), "C is watched once");
    assert_eq!(
        f.wm.get(MAIN).unwrap().session.as_ref().map(|s| s.uri.raw.clone()),
        Some(f.c.raw.clone()),
        "the window now holds C"
    );

    let events = capture(&f.app, "file_changed");
    f.write(&f.c, "# C changed\n");
    assert!(
        wait_for_uri(&events, &f.c.raw, Duration::from_secs(5)).await,
        "file_changed for C arrives after the swap"
    );
}

/// 6. 同じ文書 A を開き直す: 差し替え中は 2 になるが、前のセッションを drop すると
///    1 に戻る(二重にならない・0 にもならない)。その後も A の file_changed が届く。
#[tokio::test]
async fn reopening_the_same_document_keeps_refcount_one_and_watch_alive() {
    let mut f = fixture().await;
    let session_a2 = f.open(&f.a).await.expect("A opens again");
    assert_eq!(f.refcount(&f.a).await, Some(2), "subscribe-first: both sessions hold A");

    let previous = f.wm.replace_session(MAIN, session_a2);
    assert!(previous.is_some(), "the previous session (A) is returned");
    drop(previous);
    settle().await;

    assert_eq!(f.refcount(&f.a).await, Some(1), "A is watched exactly once after the reopen");
    assert!(f.wm.get(MAIN).unwrap().session.is_some());

    let events = capture(&f.app, "file_changed");
    f.write(&f.a, "# A changed again\n");
    assert!(
        wait_for_uri(&events, &f.a.raw, Duration::from_secs(5)).await,
        "file_changed for A still arrives after reopening the same document"
    );
}

/// 7. 他の窓も A を開いているとき: 失敗しても 2 のまま・C に差し替えても A は 1 残る
///    (「他に開いている窓が無ければ」の但し書き)。
#[tokio::test]
async fn another_window_holding_a_keeps_its_watch_through_failure_and_swap() {
    let mut f = fixture().await;
    let (other, _) = DocumentSession::open(
        WindowId("other".into()),
        f.a.clone(),
        &f.providers,
        &f.coordinator,
        f.app.handle(),
    )
    .await
    .expect("A opens in another window");
    assert_eq!(f.refcount(&f.a).await, Some(2));

    let sjis = f.sjis.clone();
    assert!(f.open(&sjis).await.is_err());
    settle().await;
    assert_eq!(f.refcount(&f.a).await, Some(2), "a failed open changes nothing");

    let session_c = f.open(&f.c).await.expect("C opens");
    let previous = f.wm.replace_session(MAIN, session_c);
    drop(previous);
    settle().await;
    assert_eq!(f.refcount(&f.a).await, Some(1), "only main's hold on A is released");
    assert_eq!(f.refcount(&f.c).await, Some(1));
    drop(other);
}

// ---------------------------------------------------------------------------
// AC-71-1 — open_in_window の手順(ソース走査・acceptance_req64 の家風)
// ---------------------------------------------------------------------------

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

/// `fn <name>(` から、次の `#[tauri::command]` か次の関数の頭か `#[cfg(test)]` まで
/// (acceptance_req64 の写し)。
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

/// 8. `open_in_window` は `DocumentSession::open*` より前に前のセッションを取り出さず、
///    開けたあとに `replace_session(…)` で差し替える。`DocumentSession::open*` と
///    `recent_files::record_file` はこの関数の中に残る(AC-64-9 と両立)。
#[test]
fn open_in_window_opens_first_and_swaps_through_replace_session() {
    let code = document_rs_code();
    let body = fn_body(&code, "open_in_window");

    let last_open_at = body
        .rfind("DocumentSession::open")
        .expect("open_in_window still opens through DocumentSession::open / open_binary");

    // 先に落とさない: 前のセッションを `session.take()` で取り出す箇所が無い
    // (失敗したら前のセッションはそのまま残る。差し替えは replace_session が担う)。
    assert!(
        !body.contains("session.take()"),
        "open_in_window must not take the previous session by `session.take()` — the swap goes through replace_session after a successful open (契約1)"
    );

    // 差し替えは公開の口を通し、開いた後に行う。
    let replace_at = body
        .find("replace_session(")
        .expect("open_in_window must swap through WindowManager::replace_session(…) (契約1)");
    assert!(
        replace_at > last_open_at,
        "replace_session must come after the session is opened (開けたときだけ差し替える)"
    );
    assert!(
        !body.contains(".session = Some("),
        "open_in_window must not assign win_state.session directly — use replace_session (契約1)"
    );

    // AC-64-9 との両立: 記録は残り、成功後。
    let record_at = body
        .find("recent_files::record_file(")
        .expect("recent_files::record_file(…) stays inside open_in_window (契約1・AC-64-9)");
    assert!(record_at > last_open_at, "record_file stays after the open");
}
