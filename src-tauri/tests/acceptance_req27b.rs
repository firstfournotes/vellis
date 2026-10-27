//! 要件#27 追補b の受け入れテスト(docs/requirements/req-27.md「### 追補b」・
//! Issue #728・#439)— Rust 層
//!
//! 「ssh の要求は、要求元の窓が開いている接続先に限る・ssh の接続に時間の上限・
//!  `ssh -G` に `--`」
//!
//! Issue #728: 文書の画像に `vellis-asset://ssh/<任意のホスト>/…` と書くだけで、開いた人の
//! 操作なしにそのホストへ SSH で接続しにいく(初めてのホストなら `~/.ssh/known_hosts` に
//! 鍵を書き、ssh-agent の鍵を順に試す)。#439 も同じ根。
//!
//! 契約(追補b・2026-10-25):
//! 1. **ssh の要求は、要求元の窓に許された接続先に限る**。`vellis-asset://ssh/<authority>/…` は、
//!    要求元の webview の窓に許された接続先の authority と一致するときだけプロバイダに回す。
//!    一致しなければ**接続を開かずに 403**(応答は既存の `error_response`=追補a の CSP と ACAO 付き)
//!    - 許された接続先 = 窓の `root_uri` の authority(scheme が `ssh`)と、開いている文書
//!      (`session` の `uri`)の authority(scheme が `ssh`)
//!    - 比較は `Uri::parse` で得た authority の値どうしの一致。エイリアスと実ホスト名・ポートの
//!      省略と 22・ユーザーの省略と既定のユーザーは同一視しない
//!    - **印刷窓**(`is_print_window` の label)は、印刷を頼んだ窓に許された接続先で判定する。
//!      対応は印刷窓を作るときに記録し、印刷窓が無くなったら消す
//!    - 窓の分からない label(`WindowManager` に無く、印刷窓の対応にも無い)・許された接続先が
//!      1 つも無い窓は、ssh の要求をすべて 403
//!    - `vellis-asset://local/…` は従来どおり(label を見ない・応答も変えない)
//! 2. **入口**: `commands::asset::handle_asset_for_window(state, label, req)`(async)を足し、
//!    契約1 を通ったら既存の `handle_asset` に渡す。`lib.rs` の `vellis-asset` のハンドラは
//!    `ctx.webview_label()` を渡してこれを呼ぶ。既存の `handle_asset` は名前・シグネチャ・振る舞い
//!    とも不変。印刷窓の対応の入口は `WindowManager::set_print_owner` / `remove_print_owner`
//! 3. **ssh の接続に時間の上限**: 接続を開く処理(TCP・鍵の交換・認証・SFTP の開始)を上限で
//!    打ち切ってエラー。既定は `fs::ssh::SSH_CONNECT_TIMEOUT`(pub const・20 秒)。
//!    `SshProvider::with_connect_timeout(Duration)` で変えられる。`SshProvider::new()` は既定
//! 4. **`ssh -G` の引数の前に `--`**: `fs::ssh::ssh_g_args(alias) -> Vec<String>` が
//!    `["-G", "--", alias]` を返し、`ssh_g` はこの引数で `ssh` を呼ぶ
//! 5. 不変: 画面側・CSP・`handle_asset` の Range の解釈と応答・ローカルのアセット。依存の追加なし
//!
//! 受け入れ基準 AC-27-追b(本ファイル):
//! - (a) 窓の `root_uri` がローカル → その窓からの `vellis-asset://ssh/probe@127.0.0.1:<port>/x.png`
//!   は 403、待ち受けに接続が来ない
//! - (b) 窓の `root_uri` が ssh で authority が違う → 403、接続が来ない
//! - (c) 窓の `root_uri` の authority と同じ → 待ち受けに接続が来て `SSH-` で始まるバイトが届く
//! - (d) `WindowManager` に無い label → 403、接続が来ない
//! - (e) 印刷窓: `set_print_owner` で持ち主を記録すると、持ち主の root の authority と同じ要求は
//!   通り(接続が来る)、違う要求は 403。`remove_print_owner` のあとは 403
//! - (f) `vellis-asset://local/…` は、`WindowManager` に無い label からでも従来どおり 200(本文も同じ)
//! - (g) 403 の応答にも追補a の CSP と `Access-Control-Allow-Origin: *` が付く
//! - (h) `SshProvider::with_connect_timeout(1 秒)` で、黙ったままの待ち受けへの `stat` が
//!   数秒以内にエラーで戻る。`SSH_CONNECT_TIMEOUT` は 20 秒
//! - (i) `ssh_g_args("-oProxyCommand=x")` は `["-G", "--", "-oProxyCommand=x"]`。`ssh_g` の本体が
//!   `ssh_g_args(` を使う
//! - (j) 配線(ソースの走査): `lib.rs` の `vellis-asset` のハンドラが `webview_label` と
//!   `handle_asset_for_window(` を使い、`handle_asset(` を直に呼ばない。`print_html`(またはそこから
//!   呼ぶ関数)が `set_print_owner(` を呼び、印刷窓の `Destroyed` の経路が `remove_print_owner(` を呼ぶ
//!
//! 判定の仕方:
//! - ssh の接続の観察は **127.0.0.1 の `tokio::net::TcpListener` だけ**で行い、SSH のサーバとしては
//!   応答しない(鍵の交換に進まない=`~/.ssh/known_hosts` に書かない)。ポートはテストごとに `:0`
//!   で取る(並列で動いても取り違えない)。外部ネットワークへは出ない(ホストは 127.0.0.1 か、
//!   名前解決しない `.invalid` だけ)
//! - 通る側((c)・(e)): 待ち受けは受けた接続の先頭を読んで `SSH-` を確かめたらすぐ閉じる。
//!   `handle_asset_for_window` 全体は `tokio::time::timeout` で包む(閉じられた接続に russh は
//!   すぐエラーを返し、応答は 500 になる=Issue #728 の再現と同じ。応答の値は契約外なので
//!   「403 でない」だけを見る)。接続プール(`ssh_pool.rs`)は open の失敗を再試行しないので
//!   接続は 1 本
//! - 断る側((a)・(b)・(d)・(e)): 応答が 403 であることと、応答のあと 1 秒待っても待ち受けに
//!   接続が来ないことを確かめる
//! - (h) は黙ったままの待ち受け(受けた接続を握ったまま何も書かない)へ、1 秒の上限の `stat` が
//!   5 秒以内にエラーで戻ること
//! - AppState は `acceptance_req23d.rs` の `state_with_registry` と同じ作り。窓は
//!   `WindowManager::register_window(label, WindowArgs::default())` で登録し、`get_mut(label)` で
//!   `root_uri` を直接入れる
//! - (i)(j) はソースの走査(`acceptance_req38n.rs` の strip_line_comments / fn_body / reaches の流儀)
//!
//! ## 確定契約(公開 API・implementer はこれに従う)
//!
//! ```ignore
//! // src-tauri/src/commands/asset.rs
//! pub async fn handle_asset_for_window(
//!     state: &AppState,
//!     label: &str,
//!     req: http::Request<Vec<u8>>,
//! ) -> http::Response<Vec<u8>>;
//!
//! // src-tauri/src/window/manager.rs(impl<R: tauri::Runtime> WindowManager<R>)
//! pub fn set_print_owner(&mut self, print_label: String, owner_label: String);
//! pub fn remove_print_owner(&mut self, print_label: &str);
//!
//! // src-tauri/src/fs/ssh.rs
//! pub const SSH_CONNECT_TIMEOUT: std::time::Duration; // 20 秒
//! impl SshProvider {
//!     pub fn with_connect_timeout(timeout: std::time::Duration) -> SshProvider;
//! }
//! pub fn ssh_g_args(alias: &str) -> Vec<String>;      // ["-G", "--", alias]
//! ```
//!
//! ## reviewer 照合に委ねる配線(テストで作りにくい・機械判定不能)
//! - 開いている文書(`session` の `uri`)の authority を許すこと(`DocumentSession` はテストで作りにくい)
//! - 印刷窓の対応を記録する時点(印刷窓を作るとき)と消す時点(印刷窓の `Destroyed`)。
//!   開いている印刷窓へ前面を移すだけの経路(要件38 追補m 契約3)では対応を書き換えないこと
//! - HTML ビューアの枠(srcdoc)からの要求が持ち主の窓の label で来ること
//! - `print_html` が記録する持ち主が**呼び出し元の窓**の label であること(走査は `set_print_owner(`
//!   を呼ぶことまで)
//! - `SshProvider::new()` が既定の上限(20 秒)を使うこと(20 秒待つテストは置かない)
//!
//! ## 人間ゲート
//! - ssh のルートで Markdown と HTML の相対パスの画像が今までどおり出ること・ssh のルートの HTML を
//!   印刷して画像が出ること

#![cfg(feature = "provider-ssh")]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tempfile::TempDir;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use vellis_lib::commands::asset::{handle_asset, handle_asset_for_window};
use vellis_lib::commands::AppState;
use vellis_lib::fs::provider::FileProvider;
use vellis_lib::fs::registry::FileProviderRegistry;
use vellis_lib::fs::ssh::{ssh_g_args, SshProvider, SSH_CONNECT_TIMEOUT};
use vellis_lib::fs::uri::Uri;
use vellis_lib::print::is_print_window;
use vellis_lib::watch::hub::DocumentCoordinator;
use vellis_lib::window::manager::{WindowArgs, WindowManager};

// ---------------------------------------------------------------------------
// 契約の値・時間
// ---------------------------------------------------------------------------

/// 追補a の CSP 値(`error_response` が付ける)。(g) で「403 にも付く」ことを見る。
const EXPECTED_CSP: &str = "script-src 'none'; object-src 'none'";

/// 通る側の `handle_asset_for_window` 全体の上限。既定の接続の上限(20 秒)より長く取る:
/// 待ち受けが閉じればすぐ戻るが、万一 russh が EOF で戻らなくても契約3 の上限で戻る。
const PASS_TIMEOUT: Duration = Duration::from_secs(30);

/// 通る側で、待ち受けに `SSH-` の先頭が届くのを待つ上限。
const BANNER_WAIT: Duration = Duration::from_secs(10);

/// 断る側で、応答のあと「接続が来ない」ことを見張る時間。
const QUIET_WAIT: Duration = Duration::from_secs(1);

/// (h) 1 秒の上限の `stat` が戻るまでの許容(`ssh -G` の子プロセスの分を含む)。
const STAT_DEADLINE: Duration = Duration::from_secs(5);

/// 印刷窓の label(`print::open_print_window` の規則 `print-` + ULID。`acceptance_req38m.rs` と同じ)。
const PRINT_A: &str = "print-01J9Q3XK0F8V2T6H4N1M5A7B9C";

/// 文書の窓の label(`WindowManager::next_label` の規則)。
const WIN_1: &str = "vellis-1";
const WIN_2: &str = "vellis-2";

/// 用意した label が契約の前提(印刷窓/文書の窓)を満たすことの確認。
#[test]
fn fixtures_match_is_print_window() {
    assert!(is_print_window(PRINT_A), "fixture {PRINT_A} must be a print window label");
    for label in [WIN_1, WIN_2, "main", "no-such-window"] {
        assert!(!is_print_window(label), "fixture {label} must not be a print window label");
    }
}

// ---------------------------------------------------------------------------
// 127.0.0.1 の待ち受け(SSH のサーバとしては応答しない)
// ---------------------------------------------------------------------------

/// 受けた接続の先頭(最大 64 バイト・4 バイト集まるまで)を読んで送り、すぐ閉じる待ち受け。
/// 届いた先頭バイトは `banners` に 1 接続 1 件で入る。
struct Probe {
    port: u16,
    banners: mpsc::UnboundedReceiver<Vec<u8>>,
    task: JoinHandle<()>,
}

impl Probe {
    async fn start() -> Probe {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind a loopback listener on an ephemeral port");
        let port = listener.local_addr().expect("local_addr").port();
        let (tx, banners) = mpsc::unbounded_channel::<Vec<u8>>();
        let task = tokio::spawn(async move {
            // `tx` はこのループが生きている限り握る(受け手が「閉じた」と早とちりしない)。
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let tx = tx.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 64];
                    let mut n = 0usize;
                    let _ = tokio::time::timeout(BANNER_WAIT, async {
                        while n < 4 {
                            match stream.read(&mut buf[n..]).await {
                                Ok(0) | Err(_) => break,
                                Ok(k) => n += k,
                            }
                        }
                    })
                    .await;
                    let _ = tx.send(buf[..n].to_vec());
                    // ここで閉じる: 鍵の交換には進まない(known_hosts に書かない)。
                    drop(stream);
                });
            }
        });
        Probe { port, banners, task }
    }

    /// この待ち受けを指す authority(`probe@127.0.0.1:<port>`)。
    fn authority(&self) -> String {
        format!("probe@127.0.0.1:{}", self.port)
    }

    /// この待ち受けを root にする窓の `root_uri`。
    fn root_uri(&self) -> String {
        format!("ssh://{}/home/probe", self.authority())
    }

    /// この待ち受け(authority は `authority` の指定)への画像の要求 URL。
    fn asset_url(&self, authority: &str) -> String {
        format!("vellis-asset://ssh/{authority}/home/probe/x.png")
    }

    /// 通る側: 接続が 1 本来て、先頭が `SSH-`(russh のバナー)であること。
    async fn expect_connection(&mut self, ctx: &str) {
        match tokio::time::timeout(BANNER_WAIT, self.banners.recv()).await {
            Ok(Some(bytes)) => assert!(
                bytes.starts_with(b"SSH-"),
                "{ctx}: the connection must carry an SSH banner (the request reached the provider) — got {:?}",
                String::from_utf8_lossy(&bytes)
            ),
            Ok(None) => panic!("{ctx}: the probe listener went away"),
            Err(_) => panic!(
                "{ctx}: no connection reached the listener within {}s — the request did not reach the provider",
                BANNER_WAIT.as_secs()
            ),
        }
    }

    /// 断る側: 応答のあと `QUIET_WAIT` のあいだ接続が来ないこと。
    async fn expect_quiet(&mut self, ctx: &str) {
        match tokio::time::timeout(QUIET_WAIT, self.banners.recv()).await {
            Err(_) => {}
            Ok(Some(bytes)) => panic!(
                "{ctx}: a connection reached the listener although the request must be refused without connecting (契約1) — got {:?}",
                String::from_utf8_lossy(&bytes)
            ),
            Ok(None) => panic!("{ctx}: the probe listener went away"),
        }
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        self.task.abort();
    }
}

// ---------------------------------------------------------------------------
// Helpers(acceptance_req23d.rs の state_with_registry と同じ作り)
// ---------------------------------------------------------------------------

fn state_with_registry(registry: FileProviderRegistry) -> AppState {
    let registry = Arc::new(registry);
    AppState {
        fs_registry: registry.clone(),
        coordinator: Arc::new(DocumentCoordinator::new(registry)),
        window_manager: Arc::new(tokio::sync::Mutex::new(WindowManager::new())),
        annotation_stores: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
    }
}

/// 実プロバイダ(`file` と `ssh`)の AppState に、窓 `(label, root_uri)` を登録したもの。
/// `root_uri` が `None` の窓は root を持たない(許された接続先が 1 つも無い)。
async fn state_with_windows(windows: &[(&str, Option<&str>)]) -> AppState {
    let state = state_with_registry(FileProviderRegistry::new());
    {
        let mut wm = state.window_manager.lock().await;
        for (label, root) in windows {
            wm.register_window(label.to_string(), WindowArgs::default());
            if let Some(root) = root {
                wm.get_mut(label).expect("just registered").root_uri =
                    Some(Uri::parse(root).expect("root uri parses"));
            }
        }
    }
    state
}

fn get_request(url: &str) -> http::Request<Vec<u8>> {
    http::Request::builder()
        .method(http::Method::GET)
        .uri(url)
        .body(Vec::new())
        .unwrap()
}

/// 契約2 の入口を呼ぶ(全体を `PASS_TIMEOUT` で包む)。引数と返り値の型はここで固定される。
async fn ask(state: &AppState, label: &str, url: &str) -> http::Response<Vec<u8>> {
    let response: http::Response<Vec<u8>> =
        match tokio::time::timeout(PASS_TIMEOUT, handle_asset_for_window(state, label, get_request(url)))
            .await
        {
            Ok(response) => response,
            Err(_) => panic!(
                "handle_asset_for_window did not return within {}s (label {label:?}, {url})",
                PASS_TIMEOUT.as_secs()
            ),
        };
    response
}

fn header_str<'a>(resp: &'a http::Response<Vec<u8>>, name: &str) -> Option<&'a str> {
    resp.headers().get(name).and_then(|v| v.to_str().ok())
}

/// 応答に付いている `Content-Security-Policy` の値を全部集める。
fn csp_values(resp: &http::Response<Vec<u8>>) -> Vec<String> {
    resp.headers()
        .get_all(http::header::CONTENT_SECURITY_POLICY)
        .iter()
        .map(|v| v.to_str().expect("CSP は可視 ASCII").to_string())
        .collect()
}

/// 同名ヘッダの全行をカンマで割ってトークン列にする。
fn header_tokens(resp: &http::Response<Vec<u8>>, name: &str) -> Vec<String> {
    resp.headers()
        .get_all(name)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|line| line.split(',').map(|t| t.trim().to_string()))
        .filter(|t| !t.is_empty())
        .collect()
}

fn assert_forbidden(resp: &http::Response<Vec<u8>>, ctx: &str) {
    assert_eq!(
        resp.status().as_u16(),
        403,
        "{ctx}: an ssh request outside the window's allowance must be 403 (契約1) — got {}",
        resp.status()
    );
}

fn assert_not_forbidden(resp: &http::Response<Vec<u8>>, ctx: &str) {
    assert_ne!(
        resp.status().as_u16(),
        403,
        "{ctx}: an ssh request inside the window's allowance must be passed to the provider, not refused (契約1)"
    );
}

/// 位置から中身が一意に決まるパターンバイト列。
fn patterned(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i.wrapping_mul(31) % 251) as u8).collect()
}

fn write_file(tmp: &TempDir, name: &str, data: &[u8]) -> PathBuf {
    let path = tmp.path().join(name);
    std::fs::write(&path, data).unwrap();
    path
}

fn local_asset_url(path: &Path) -> String {
    format!(
        "vellis-asset://local{}",
        path.to_str().unwrap() // 絶対パスなので先頭 '/' がそのまま区切りになる
    )
}

// ---------------------------------------------------------------------------
// (a) 窓の root がローカル(または root 無し)→ 403・接続が来ない
// ---------------------------------------------------------------------------

/// (a)-1. `root_uri` が `file://` の窓からの ssh の要求は 403 で、待ち受けに接続が来ない
///        (Issue #728 の本体: ローカルの文書に書かれた ssh の画像で接続しにいかない)。
#[tokio::test]
async fn local_root_window_cannot_reach_ssh() {
    let mut probe = Probe::start().await;
    let state = state_with_windows(&[(WIN_1, Some("file:///Users/probe/notes"))]).await;

    let resp = ask(&state, WIN_1, &probe.asset_url(&probe.authority())).await;

    assert_forbidden(&resp, "local root");
    probe.expect_quiet("local root").await;
}

/// (a)-2. root を持たない窓(許された接続先が 1 つも無い)からの ssh の要求も 403・接続が来ない。
#[tokio::test]
async fn window_without_a_root_cannot_reach_ssh() {
    let mut probe = Probe::start().await;
    let state = state_with_windows(&[(WIN_1, None)]).await;

    let resp = ask(&state, WIN_1, &probe.asset_url(&probe.authority())).await;

    assert_forbidden(&resp, "no root");
    probe.expect_quiet("no root").await;
}

// ---------------------------------------------------------------------------
// (b) 窓の root が ssh で authority が違う → 403・接続が来ない
// ---------------------------------------------------------------------------

/// (b)-1. root の authority が要求と違えば 403。同一視しない組み合わせ(契約1):
///        ユーザー違い・ホストが別名(`localhost` / `.invalid`)・ポートの省略・ユーザーの省略。
///        要求はどれも待ち受け(`probe@127.0.0.1:<port>`)を指すので、漏れれば接続が来て分かる。
#[tokio::test]
async fn ssh_root_with_a_different_authority_is_refused() {
    let mut probe = Probe::start().await;
    let port = probe.port;
    let roots = [
        format!("ssh://other@127.0.0.1:{port}/home/other"),
        format!("ssh://probe@localhost:{port}/home/probe"),
        String::from("ssh://probe@root.invalid/home/probe"),
        String::from("ssh://probe@127.0.0.1/home/probe"),
        format!("ssh://127.0.0.1:{port}/home/probe"),
    ];

    for root in &roots {
        let state = state_with_windows(&[(WIN_1, Some(root.as_str()))]).await;

        let resp = ask(&state, WIN_1, &probe.asset_url(&probe.authority())).await;

        assert_forbidden(&resp, &format!("root {root}"));
        probe.expect_quiet(&format!("root {root}")).await;
    }
}

/// (b)-2. 別の窓に許された接続先は、この窓の要求には効かない(判定は要求元の label の窓で行う)。
#[tokio::test]
async fn another_windows_allowance_does_not_leak_into_this_window() {
    let mut probe = Probe::start().await;
    let allowed_root = probe.root_uri();
    let state = state_with_windows(&[
        (WIN_1, Some(allowed_root.as_str())),
        (WIN_2, Some("file:///Users/probe/notes")),
    ])
    .await;

    let resp = ask(&state, WIN_2, &probe.asset_url(&probe.authority())).await;

    assert_forbidden(&resp, "request from the local-root window while another window allows the host");
    probe
        .expect_quiet("request from the local-root window while another window allows the host")
        .await;
}

// ---------------------------------------------------------------------------
// (c) 窓の root の authority と同じ → 接続が来る(`SSH-` が届く)
// ---------------------------------------------------------------------------

/// (c). root の authority と同じ要求は判定を通ってプロバイダに回る: 待ち受けに接続が来て
///      `SSH-` で始まるバイトが届く。応答は 403 でない(待ち受けは SSH を話さないので実際は 500)。
#[tokio::test]
async fn ssh_root_with_the_same_authority_reaches_the_provider() {
    let mut probe = Probe::start().await;
    let root = probe.root_uri();
    let state = state_with_windows(&[(WIN_1, Some(root.as_str()))]).await;

    let resp = ask(&state, WIN_1, &probe.asset_url(&probe.authority())).await;

    assert_not_forbidden(&resp, "same authority");
    probe.expect_connection("same authority").await;
}

// ---------------------------------------------------------------------------
// (d) WindowManager に無い label → 403・接続が来ない
// ---------------------------------------------------------------------------

/// (d). 知らない label(登録の無い名前・空文字)からの ssh の要求は、ほかの窓がそのホストを
///      許していても 403・接続が来ない。
#[tokio::test]
async fn unknown_window_label_is_refused() {
    let mut probe = Probe::start().await;
    let root = probe.root_uri();
    let state = state_with_windows(&[(WIN_1, Some(root.as_str()))]).await;

    for label in ["vellis-99", "main", ""] {
        let resp = ask(&state, label, &probe.asset_url(&probe.authority())).await;

        assert_forbidden(&resp, &format!("unknown label {label:?}"));
        probe.expect_quiet(&format!("unknown label {label:?}")).await;
    }
}

// ---------------------------------------------------------------------------
// (e) 印刷窓は持ち主の窓の許しで判定する
// ---------------------------------------------------------------------------

/// (e)-1. 印刷窓の label からの要求: 対応が無いうちは 403 → `set_print_owner` で持ち主を記録すると
///        持ち主の root の authority と同じ要求は通り(接続が来る)、違う authority は 403 →
///        `remove_print_owner` のあとは同じ要求が 403・接続が来ない。
#[tokio::test]
async fn print_window_follows_its_owners_allowance() {
    let mut probe = Probe::start().await;
    let root = probe.root_uri();
    let state = state_with_windows(&[(WIN_1, Some(root.as_str()))]).await;
    let same = probe.asset_url(&probe.authority());
    let other = probe.asset_url(&format!("other@127.0.0.1:{}", probe.port));

    // 対応が無い印刷窓(WindowManager にも無い)は 403。
    let resp = ask(&state, PRINT_A, &same).await;
    assert_forbidden(&resp, "print window before set_print_owner");
    probe.expect_quiet("print window before set_print_owner").await;

    {
        let mut wm = state.window_manager.lock().await;
        wm.set_print_owner(PRINT_A.to_string(), WIN_1.to_string());
    }

    // 持ち主の root と同じ authority は通る。
    let resp = ask(&state, PRINT_A, &same).await;
    assert_not_forbidden(&resp, "print window with an owner, same authority");
    probe.expect_connection("print window with an owner, same authority").await;

    // 持ち主の root と違う authority は 403。
    let resp = ask(&state, PRINT_A, &other).await;
    assert_forbidden(&resp, "print window with an owner, other authority");
    probe.expect_quiet("print window with an owner, other authority").await;

    {
        let mut wm = state.window_manager.lock().await;
        wm.remove_print_owner(PRINT_A);
    }

    // 対応を消したあとは 403。
    let resp = ask(&state, PRINT_A, &same).await;
    assert_forbidden(&resp, "print window after remove_print_owner");
    probe.expect_quiet("print window after remove_print_owner").await;
}

/// (e)-2. 持ち主の窓が WindowManager から消えていれば(許された接続先が 1 つも無い)印刷窓の要求は 403。
///        また、印刷窓の対応を記録しても文書の窓として数えない(`window_count` が変わらない=
///        要件#12 追補a の終了判定が印刷窓を文書の窓と数えてしまわない)。
#[tokio::test]
async fn print_window_whose_owner_is_gone_is_refused() {
    let mut probe = Probe::start().await;
    let root = probe.root_uri();
    let state = state_with_windows(&[(WIN_1, Some(root.as_str()))]).await;

    {
        let mut wm = state.window_manager.lock().await;
        let before = wm.window_count();
        wm.set_print_owner(PRINT_A.to_string(), WIN_1.to_string());
        assert_eq!(
            wm.window_count(),
            before,
            "set_print_owner must not register the print window as a document window"
        );
        assert!(
            wm.get(PRINT_A).is_none(),
            "the print window has no WindowState of its own (it is not a document window)"
        );
        wm.unregister_window(WIN_1);
    }

    let resp = ask(&state, PRINT_A, &probe.asset_url(&probe.authority())).await;

    assert_forbidden(&resp, "print window whose owner is gone");
    probe.expect_quiet("print window whose owner is gone").await;
}

// ---------------------------------------------------------------------------
// (f) local は label を見ない・応答も変えない
// ---------------------------------------------------------------------------

/// (f). `vellis-asset://local/…` は、WindowManager に無い label・空の label・印刷窓の label・
///      登録済みの窓のどれからでも従来どおり 200 で、本文のバイトと Content-Type は `handle_asset` と同じ。
#[tokio::test]
async fn local_assets_ignore_the_window_label() {
    let tmp = TempDir::new().unwrap();
    let data = patterned(1000);
    let path = write_file(&tmp, "photo.png", &data);
    let url = local_asset_url(&path);
    let state = state_with_windows(&[(WIN_1, Some("file:///Users/probe/notes"))]).await;

    let baseline = handle_asset(&state, get_request(&url)).await;
    assert_eq!(baseline.status().as_u16(), 200, "handle_asset serves the file as before (前提)");
    assert_eq!(baseline.body(), &data);

    for label in ["no-such-window", "", PRINT_A, WIN_1] {
        let resp = ask(&state, label, &url).await;

        assert_eq!(
            resp.status().as_u16(),
            200,
            "local asset from label {label:?} must be 200 as before (契約1: label を見ない)"
        );
        assert_eq!(resp.body(), &data, "local asset body from label {label:?} is unchanged");
        assert_eq!(
            header_str(&resp, "Content-Type"),
            header_str(&baseline, "Content-Type"),
            "local asset Content-Type from label {label:?} is unchanged"
        );
    }
}

// ---------------------------------------------------------------------------
// (g) 403 にも CSP と ACAO が付く(既存の error_response で組み立てる)
// ---------------------------------------------------------------------------

/// (g). 契約1 の 403(ローカル root・authority 違い・知らない label)に、追補a の CSP がちょうど1つと
///      `Access-Control-Allow-Origin: *` が付く。`Access-Control-Expose-Headers: Content-Range`
///      (要件#23 追補d・`error_response` が付ける)も付く=既存のビルダーで組み立てている。
#[tokio::test]
async fn forbidden_response_carries_csp_and_cors_headers() {
    let mut probe = Probe::start().await;
    let port = probe.port;
    let other_root = format!("ssh://other@127.0.0.1:{port}/home/other");
    let state = state_with_windows(&[
        (WIN_1, Some("file:///Users/probe/notes")),
        (WIN_2, Some(other_root.as_str())),
    ])
    .await;
    let url = probe.asset_url(&probe.authority());

    for (label, ctx) in [
        (WIN_1, "403 from a local-root window"),
        (WIN_2, "403 from a window with another ssh authority"),
        ("vellis-99", "403 from an unknown label"),
    ] {
        let resp = ask(&state, label, &url).await;
        assert_forbidden(&resp, ctx);

        let values = csp_values(&resp);
        assert_eq!(
            values.len(),
            1,
            "{ctx}: Content-Security-Policy must be present exactly once (追補a) — got {values:?}"
        );
        assert_eq!(values[0], EXPECTED_CSP, "{ctx}: Content-Security-Policy value (追補a)");
        assert_eq!(
            header_str(&resp, "Access-Control-Allow-Origin"),
            Some("*"),
            "{ctx}: Access-Control-Allow-Origin: * (追補a・backlog #55)"
        );
        let exposed = header_tokens(&resp, "Access-Control-Expose-Headers");
        assert!(
            exposed.iter().any(|t| t.eq_ignore_ascii_case("Content-Range")),
            "{ctx}: Access-Control-Expose-Headers must include Content-Range (built with error_response, 契約1) — got {exposed:?}"
        );
    }
    probe.expect_quiet("after the 403s").await;
}

// ---------------------------------------------------------------------------
// (h) 接続の上限
// ---------------------------------------------------------------------------

/// (h)-1. `SSH_CONNECT_TIMEOUT` は `Duration` の pub const で 20 秒。
#[test]
fn default_connect_timeout_is_twenty_seconds() {
    let limit: Duration = SSH_CONNECT_TIMEOUT;
    assert_eq!(limit, Duration::from_secs(20), "契約3: 既定の上限は 20 秒");
}

/// (h)-2. 黙ったままの待ち受け(接続は受けるが何も書かない)へ、`with_connect_timeout(1 秒)` の
///        `stat` が 5 秒以内にエラーで戻る。上限が無いと(Issue #728 の再現)10 秒たっても戻らない。
#[tokio::test]
async fn a_short_connect_timeout_cuts_a_silent_server_short() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind a loopback listener on an ephemeral port");
    let port = listener.local_addr().expect("local_addr").port();
    let hold = tokio::spawn(async move {
        // 受けた接続は握ったまま、読みも書きもしない(SSH のバナーを返さない)。
        let mut parked = Vec::new();
        loop {
            match listener.accept().await {
                Ok((stream, _)) => parked.push(stream),
                Err(_) => break,
            }
        }
    });

    let make: fn(Duration) -> SshProvider = SshProvider::with_connect_timeout;
    let provider = make(Duration::from_secs(1));
    let uri = Uri::parse(&format!("ssh://probe@127.0.0.1:{port}/home/probe/x.png")).unwrap();

    let started = Instant::now();
    let outcome = tokio::time::timeout(STAT_DEADLINE, provider.stat(&uri)).await;
    let elapsed = started.elapsed();
    hold.abort();

    match outcome {
        Err(_) => panic!(
            "stat against a silent server did not return within {}s with a 1s connect timeout (契約3)",
            STAT_DEADLINE.as_secs()
        ),
        Ok(Ok(entry)) => panic!("stat against a silent server cannot succeed — got {entry:?}"),
        Ok(Err(_)) => {}
    }
    assert!(
        elapsed < STAT_DEADLINE,
        "stat returned in {elapsed:?}, which must be under {STAT_DEADLINE:?}"
    );
}

// ---------------------------------------------------------------------------
// (i) `ssh -G` の引数
// ---------------------------------------------------------------------------

/// (i)-1. `ssh_g_args(alias)` は `["-G", "--", alias]`。オプションに見える alias も位置引数のまま渡る。
#[test]
fn ssh_g_args_puts_double_dash_before_the_alias() {
    let f: fn(&str) -> Vec<String> = ssh_g_args;
    assert_eq!(
        f("-oProxyCommand=x"),
        vec!["-G".to_string(), "--".to_string(), "-oProxyCommand=x".to_string()],
        "契約4: an alias that looks like an option must follow `--`"
    );
    assert_eq!(
        f("myhost"),
        vec!["-G".to_string(), "--".to_string(), "myhost".to_string()],
        "契約4: a plain alias takes the same shape"
    );
}

/// (i)-2. `ssh_g` の本体が `ssh_g_args(` の引数で `ssh` を呼ぶ(`"-G"` のリテラルを直に並べない)。
#[test]
fn ssh_g_calls_ssh_with_ssh_g_args() {
    let code = strip_line_comments(include_str!("../src/fs/ssh.rs"));
    let body = fn_body(&code, "ssh_g", "ssh.rs");
    assert!(
        body.contains("Command::new(\"ssh\")"),
        "ssh_g must still spawn `ssh`:\n{body}"
    );
    assert!(
        body.contains("ssh_g_args("),
        "ssh_g must build its arguments with ssh_g_args( (契約4):\n{body}"
    );
    assert!(
        !body.contains("\"-G\""),
        "ssh_g must not pass \"-G\" on its own — the argument list lives in ssh_g_args (契約4):\n{body}"
    );
}

// ---------------------------------------------------------------------------
// (j) 配線(ソースの走査)
// ---------------------------------------------------------------------------

/// (j)-1. `lib.rs` の `vellis-asset` のハンドラは `webview_label` を取って `handle_asset_for_window(` を
///        呼び、`lib.rs` のどこにも `handle_asset(` の直接の呼び出しが残らない。
#[test]
fn asset_protocol_handler_routes_through_handle_asset_for_window() {
    let code = strip_line_comments(include_str!("../src/lib.rs"));
    let registration = asset_protocol_registration(&code);
    assert!(
        reaches(registration, "webview_label", &code),
        "the vellis-asset handler must take the requesting webview's label (webview_label) (契約2):\n{registration}"
    );
    assert!(
        reaches(registration, "handle_asset_for_window(", &code),
        "the vellis-asset handler must go through handle_asset_for_window( (契約2):\n{registration}"
    );
    assert!(
        !code.contains("handle_asset("),
        "lib.rs must not call handle_asset( directly any more — every request goes through the window check (契約2)"
    );
}

/// (j)-2. `print_html`(またはそこから呼ぶ関数)が `set_print_owner(` を呼ぶ。
#[test]
fn print_html_records_the_print_owner() {
    let code = format!(
        "{}\n{}",
        strip_line_comments(include_str!("../src/commands/print.rs")),
        strip_line_comments(include_str!("../src/print.rs"))
    );
    let body = fn_body(&code, "print_html", "commands/print.rs");
    assert!(
        reaches(body, "set_print_owner(", &code),
        "print_html (or a function it calls) must record the print window's owner with set_print_owner( (契約2):\n{body}"
    );
}

/// (j)-3. `lib.rs` の `WindowEvent::Destroyed` の経路(またはそこから呼ぶ関数)が `remove_print_owner(` を呼ぶ。
#[test]
fn destroyed_print_window_removes_the_print_owner() {
    let lib = strip_line_comments(include_str!("../src/lib.rs"));
    let code = format!(
        "{}\n{}\n{}\n{}",
        lib,
        strip_line_comments(include_str!("../src/print.rs")),
        strip_line_comments(include_str!("../src/commands/print.rs")),
        strip_line_comments(include_str!("../src/window/manager.rs"))
    );
    let blocks = destroyed_blocks(&lib);
    assert!(
        !blocks.is_empty(),
        "lib.rs must still handle WindowEvent::Destroyed (要件#12 追補a)"
    );
    assert!(
        blocks
            .iter()
            .any(|block| reaches(block, "remove_print_owner(", &code)),
        "the Destroyed path (or a function it calls) must drop the print window's owner with remove_print_owner( (契約2):\n{}",
        blocks.join("\n---\n")
    );
}

// ---------------------------------------------------------------------------
// 走査の道具 — acceptance_req38n.rs の strip_line_comments / block_end / fn_body /
// all_functions / reaches の流儀(テスト間でコードは共有しないので写す)
// ---------------------------------------------------------------------------

/// 行コメント(`//`・`///`・`//!`)を落とす。`://`(URL)は残す。
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

/// `code[open..]` が `{` か `(` で始まるとして、対応する閉じ括弧の次の位置(文字列リテラル・
/// 文字リテラルの中の括弧は数えない)。
fn block_end(code: &str, open: usize) -> usize {
    let bytes = code.as_bytes();
    let (open_ch, close_ch) = match bytes[open] {
        b'{' => (b'{', b'}'),
        b'(' => (b'(', b')'),
        other => panic!("block must start at a brace or a paren, got {:?}", other as char),
    };
    let mut depth = 0usize;
    let mut i = open;
    let mut in_str = false;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if c == b'\\' {
                i += 1;
            } else if c == b'"' {
                in_str = false;
            }
        } else if c == b'"' {
            in_str = true;
        } else if c == b'\'' && i + 2 < bytes.len() && bytes[i + 2] == b'\'' {
            // 文字リテラル `'x'`(`'{'` のような括弧を数えない)。生存期間 `'a` は当たらない
            i += 2;
        } else if c == b'\'' && i + 3 < bytes.len() && bytes[i + 1] == b'\\' && bytes[i + 3] == b'\'' {
            // `'\n'` の形
            i += 3;
        } else if c == open_ch {
            depth += 1;
        } else if c == close_ch {
            depth -= 1;
            if depth == 0 {
                return i + 1;
            }
        }
        i += 1;
    }
    panic!("block starting at {open} never closes");
}

/// `fn <name>` の最初の定義の位置(`fn <name>(` と `fn <name><R: …>(` の両方。`fn <name>_x` は拾わない)。
fn fn_definition(code: &str, name: &str) -> Option<usize> {
    let needle = format!("fn {name}");
    code.match_indices(&needle)
        .find(|(i, _)| matches!(code[i + needle.len()..].chars().next(), Some('(') | Some('<')))
        .map(|(i, _)| i)
}

/// `fn <name>(` または `fn <name><` の本体(外側の `{ … }` を含む)。
fn fn_body<'a>(code: &'a str, name: &str, file: &str) -> &'a str {
    let start = fn_definition(code, name).unwrap_or_else(|| panic!("{file} must define {name}"));
    let open = code[start..]
        .find('{')
        .unwrap_or_else(|| panic!("{name} must have a body"))
        + start;
    &code[open..block_end(code, open)]
}

/// `code` の中のすべての `fn` の (名前, 本体)。`fn` の直前が空白か行頭で、名前が識別子のもの。
fn all_functions(code: &str) -> Vec<(String, &str)> {
    let mut out = Vec::new();
    for (i, _) in code.match_indices("fn ") {
        if i > 0 && !code[..i].ends_with(|c: char| c.is_whitespace()) {
            continue;
        }
        let rest = &code[i + 3..];
        let name_len = rest
            .char_indices()
            .find(|(_, c)| !(c.is_alphanumeric() || *c == '_'))
            .map(|(j, _)| j)
            .unwrap_or(rest.len());
        if name_len == 0 {
            continue;
        }
        let name = &rest[..name_len];
        if !matches!(rest[name_len..].chars().next(), Some('(') | Some('<')) {
            continue;
        }
        let Some(open_rel) = rest.find('{') else {
            continue;
        };
        let open = i + 3 + open_rel;
        out.push((name.to_string(), &code[open..block_end(code, open)]));
    }
    out
}

/// `segment` と、そこから(推移的に)呼ぶ(`<name>(` が現れる)`code` の fn の本体の全部
/// (同名の fn は全部を候補にする)。
fn reachable_segments<'a>(segment: &'a str, code: &'a str) -> Vec<&'a str> {
    let functions = all_functions(code);
    let mut out: Vec<&'a str> = vec![segment];
    let mut seen: BTreeSet<usize> = BTreeSet::new();
    let mut i = 0;
    while i < out.len() {
        let text = out[i];
        for (index, (name, body)) in functions.iter().enumerate() {
            if text.contains(&format!("{name}(")) && seen.insert(index) {
                out.push(*body);
            }
        }
        i += 1;
    }
    out
}

/// `segment` か、そこから(推移的に)届く fn の本体のどれかが `needle` を含むか。
fn reaches(segment: &str, needle: &str, code: &str) -> bool {
    reachable_segments(segment, code)
        .iter()
        .any(|s| s.contains(needle))
}

/// `lib.rs` の `vellis-asset` のプロトコル登録の呼び出し(`register_asynchronous_uri_scheme_protocol(…)`
/// または `register_uri_scheme_protocol(…)` のうち `"vellis-asset"` を含むもの)の括弧の中身。
fn asset_protocol_registration(code: &str) -> &str {
    for needle in [
        "register_asynchronous_uri_scheme_protocol(",
        "register_uri_scheme_protocol(",
    ] {
        let mut search = 0;
        while let Some(rel) = code[search..].find(needle) {
            let open = search + rel + needle.len() - 1;
            let end = block_end(code, open);
            let segment = &code[open..end];
            if segment.contains("\"vellis-asset\"") {
                return segment;
            }
            search = end;
        }
    }
    panic!("lib.rs must register the vellis-asset protocol (register_*_uri_scheme_protocol with \"vellis-asset\")");
}

/// `lib.rs` の `WindowEvent::Destroyed` に続くブロック(`if let … = event { … }` の本体や
/// `match` の腕の本体)を全部。
fn destroyed_blocks(code: &str) -> Vec<&str> {
    code.match_indices("WindowEvent::Destroyed")
        .filter_map(|(at, _)| {
            let open = code[at..].find('{')? + at;
            Some(&code[open..block_end(code, open)])
        })
        .collect()
}
