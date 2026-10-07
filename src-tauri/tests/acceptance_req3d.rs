//! 要件#3 追補d の受け入れテスト(docs/requirements/req-03.md「追補d」・backlog 314)
//!
//! `main.rs` の早道(すでに起動している本体のソケットに繋がったら依頼を渡して終わる)は
//! `IpcClient::send`(応答待ち 500ms)を使っていた。本体がソケットを作った後・窓の準備が
//! できる前に CLI が来ると、`OpenPath` の応答が 500ms を超え、依頼は本体で処理されるのに
//! CLI は `response timed out` で終了コード 3 になる。
//!
//! 受け入れ基準 AC-03-追d(ビルドされた `vellis` を子プロセスとして起動する。環境は
//! `XDG_RUNTIME_DIR=<短い一時フォルダ>`・`HOME=<一時フォルダ>`。テストが先に本体役の
//! ソケット `<XDG_RUNTIME_DIR>/vellis.sock` を立ててから起動する=GUI を起こさない):
//!   (a) 本体役が `OpenPath` に 1.5 秒後に `Ok` を返す → `vellis <path>` は終了コード 0、
//!       本体役は依頼を1回受ける(修正前は 500ms で `response timed out`=3)
//!       → `ac03d_a_slow_ok_from_running_main_exits_0_and_is_received_once`
//!   (b) 本体役が `Error` を返す → 終了コード 3・stderr に `server error`(不変の確認)
//!       → `ac03d_b_error_from_running_main_exits_3_with_server_error`
//!   (c) 本体役が依頼を受けて応答しない → `STARTUP_RESPONSE_WAIT` の後に終了コード 3
//!       (`response timed out`)。10 秒以上かかり、30 秒以内に終わる
//!       → `ac03d_c_silent_running_main_times_out_after_startup_response_wait`
//!   (d) 引数なし(`Ping`)→ 終了コード 0(不変の確認)
//!       → `ac03d_d_no_args_pings_running_main_and_exits_0`
//!   (e) ソース走査: `main.rs` の(`#[cfg(test)]` より前・行コメントを除く)本文に
//!       `IpcClient::send(` が無く、`send_with_timeout(` と `STARTUP_RESPONSE_WAIT` がある
//!       → `ac03d_e_main_rs_fast_path_uses_send_with_timeout_and_startup_response_wait`
//!
//! ## 確定契約(implementer はこれに従う。実装先: src-tauri/src/main.rs)
//!
//! 1. 早道も応答を長く待つ: `main.rs` の早道は、依頼(`OpenPath`・`SwitchRoot`・`ShowMarks`・
//!    `ShowChanged`)も `Ping` も、応答を `STARTUP_RESPONSE_WAIT`(10 秒)まで待つ
//!    (`IpcClient::send_with_timeout`)。追補c 契約1 の「`main.rs` の早道の待ち時間 500ms は
//!    不変」をこれで改める。`main.rs` の本文から `IpcClient::send(` の呼び出しは無くなる。
//! 2. 不変: 早道の終了コード(依頼は `Ok` で 0・`Error` と IPC の失敗で 3・`Ping` は応答が
//!    あれば 0)・stderr の文言・接続の待ち時間(100ms)・`IpcClient::send` そのもの
//!    (500ms・追補c (b))・`launch` と追補b/c の契約・`main.rs` の `IpcClient::probe(` と
//!    `build_request(&cli)`(要件72 の走査)。依存の追加なし。既存のテストは無改変で緑。
//!
//! 修正前の見込み: (a) は 500ms で 3 になり赤、(c) は約 0.5 秒で 3 になり「10 秒以上」で赤、
//! (e) は赤。(b)(d) は修正前から緑(不変の確認)。
//!
//! ## 本テストの組み立て
//!
//! - 一時フォルダは `/tmp` 直下の短い名前(Unix ソケットのパス長 104 バイト)。ソケットは
//!   `default_socket_path` の規則どおり `<XDG_RUNTIME_DIR>/vellis.sock`。
//! - 本体役は `IpcServer::start` と応答役(別スレッドの個別ランタイム)。ソケットが bind
//!   されたのを確かめてから子を起動する。
//! - 子には上限時間(`CHILD_LIMIT`=30 秒)を設け、超えたら kill して失敗にする。

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tempfile::TempDir;

use vellis_lib::ipc::protocol::{Request, Response};
use vellis_lib::ipc::server::IpcServer;

/// (a) 本体役が依頼を受けてから `Ok` を返すまでの遅れ。
const RESPONSE_DELAY: Duration = Duration::from_millis(1500);
/// (c) 終了までにかかるべき最小の時間(`STARTUP_RESPONSE_WAIT` = 10 秒)。
const MIN_SILENT_WAIT: Duration = Duration::from_secs(10);
/// 子プロセスの上限時間((c) の「30 秒以内」を兼ねる)。超えたら kill して失敗にする。
const CHILD_LIMIT: Duration = Duration::from_secs(30);
/// 本体役が止めの合図を待つ上限(テストが固まらないための安全弁)。
const SERVE_DEADLINE: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

/// 子に渡す環境(`XDG_RUNTIME_DIR`・`HOME`)と、開く `.md` を置く一時フォルダ。
struct Env {
    dir: TempDir,
    home: PathBuf,
    doc: PathBuf,
}

impl Env {
    fn new() -> Self {
        let dir = tempfile::Builder::new()
            .prefix("v3d")
            .tempdir_in("/tmp")
            .expect("create a short temp dir under /tmp");
        let home = dir.path().join("h");
        std::fs::create_dir(&home).expect("create HOME dir");
        let doc = dir.path().join("note.md");
        std::fs::write(&doc, "# note\n").expect("write the .md file");
        Env { dir, home, doc }
    }

    fn runtime_dir(&self) -> &Path {
        self.dir.path()
    }

    /// `default_socket_path` の規則: `<XDG_RUNTIME_DIR>/vellis.sock`。
    fn socket(&self) -> PathBuf {
        self.runtime_dir().join("vellis.sock")
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build tokio runtime")
}

/// 本体役の応じ方。
#[derive(Clone)]
enum Behavior {
    /// `delay` の後に `Response::Ok`。
    OkAfter(Duration),
    /// すぐに `Response::Error`。
    Error,
    /// 受けて応答しない(`responder` を持ったまま黙る。drop しない)。
    Silent,
}

/// 本体の役(別スレッド・個別のランタイム)。`IpcServer` をソケットに立て、受けた依頼を
/// 記録して `Behavior` どおりに応じる。
struct MainRole {
    received: Arc<Mutex<Vec<Request>>>,
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl MainRole {
    /// 立ててソケットが bind されるまで待ってから返す。
    fn start(socket: PathBuf, behavior: Behavior) -> Self {
        let received = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = std_mpsc::channel();
        let handle = {
            let received = Arc::clone(&received);
            let stop = Arc::clone(&stop);
            thread::spawn(move || {
                runtime().block_on(async move {
                    let (server, mut rx) =
                        IpcServer::start(&socket).expect("main role: start IpcServer");
                    let _ = ready_tx.send(());
                    // Silent のとき応答役をここに持ち続ける(drop すると INTERNAL エラーが返る)。
                    let mut held = Vec::new();
                    let started = Instant::now();
                    loop {
                        if stop.load(Ordering::SeqCst) || started.elapsed() > SERVE_DEADLINE {
                            break;
                        }
                        tokio::select! {
                            cmd = rx.recv() => match cmd {
                                Some(cmd) => {
                                    let vellis_lib::ipc::server::IpcCommand { request, responder } = cmd;
                                    received.lock().unwrap().push(request);
                                    match behavior.clone() {
                                        Behavior::OkAfter(delay) => {
                                            tokio::spawn(async move {
                                                tokio::time::sleep(delay).await;
                                                let _ = responder.send(Response::Ok);
                                            });
                                        }
                                        Behavior::Error => {
                                            let _ = responder.send(Response::Error {
                                                code: "TEST_ERROR".into(),
                                                message: "main role refused".into(),
                                            });
                                        }
                                        Behavior::Silent => held.push(responder),
                                    }
                                }
                                None => break,
                            },
                            _ = tokio::time::sleep(Duration::from_millis(10)) => {}
                        }
                    }
                    drop(held);
                    drop(server);
                });
            })
        };
        ready_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("main role must start its IpcServer");
        MainRole {
            received,
            stop,
            handle: Some(handle),
        }
    }

    fn received(&self) -> Vec<String> {
        self.received
            .lock()
            .unwrap()
            .iter()
            .map(|r| format!("{r:?}"))
            .collect()
    }

    fn received_requests(&self) -> std::sync::MutexGuard<'_, Vec<Request>> {
        self.received.lock().unwrap()
    }
}

impl Drop for MainRole {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

/// 子の結果。
struct Run {
    output: Output,
    elapsed: Duration,
}

impl Run {
    fn code(&self) -> Option<i32> {
        self.output.status.code()
    }
    fn stderr(&self) -> String {
        String::from_utf8_lossy(&self.output.stderr).into_owned()
    }
}

/// ビルドされた `vellis` を `env` の環境で起動し、終わるまで待つ。`CHILD_LIMIT` を超えたら
/// kill して失敗にする。本体役を立ててから呼ぶこと(立てずに呼ぶと GUI が起動する)。
fn run_vellis(env: &Env, args: &[&std::ffi::OsStr]) -> Run {
    assert!(
        env.socket().exists(),
        "test setup: the main role's socket must exist before starting vellis (no GUI)"
    );
    let started = Instant::now();
    let mut child = Command::new(env!("CARGO_BIN_EXE_vellis"))
        .args(args)
        .env("XDG_RUNTIME_DIR", env.runtime_dir())
        .env("HOME", &env.home)
        .current_dir(env.runtime_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn the built vellis binary");
    loop {
        match child.try_wait().expect("poll vellis") {
            Some(_) => break,
            None => {
                if started.elapsed() > CHILD_LIMIT {
                    let _ = child.kill();
                    let out = child.wait_with_output().expect("collect killed vellis");
                    panic!(
                        "vellis did not exit within {CHILD_LIMIT:?}; killed. stderr: {}",
                        String::from_utf8_lossy(&out.stderr)
                    );
                }
                thread::sleep(Duration::from_millis(20));
            }
        }
    }
    let elapsed = started.elapsed();
    let output = child.wait_with_output().expect("collect vellis output");
    Run { output, elapsed }
}

// ---------------------------------------------------------------------------
// (a) 1.5 秒後に Ok を返す本体 → 終了コード 0・依頼は1回
// ---------------------------------------------------------------------------

#[test]
fn ac03d_a_slow_ok_from_running_main_exits_0_and_is_received_once() {
    let env = Env::new();
    let main = MainRole::start(env.socket(), Behavior::OkAfter(RESPONSE_DELAY));

    let run = run_vellis(&env, &[env.doc.as_os_str()]);

    assert_eq!(
        run.code(),
        Some(0),
        "with a running main that answers OpenPath with Ok {RESPONSE_DELAY:?} after receiving it, \
         `vellis <path>` must wait up to STARTUP_RESPONSE_WAIT and exit 0 (contract 1); got {:?} \
         after {:?}, stderr: {}",
        run.code(),
        run.elapsed,
        run.stderr()
    );
    let received = main.received();
    assert_eq!(
        received.len(),
        1,
        "the main role must receive the request exactly once; got {received:?}"
    );
    let reqs = main.received_requests();
    match &reqs[0] {
        Request::OpenPath { uri, new_window } => {
            assert!(
                uri.starts_with("file://") && uri.ends_with("note.md"),
                "OpenPath must carry the file:// URI of the given .md; got {uri}"
            );
            assert!(!new_window, "no -n was given");
        }
        other => panic!("the request must be OpenPath; got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// (b) Error を返す本体 → 終了コード 3・stderr に server error(不変)
// ---------------------------------------------------------------------------

#[test]
fn ac03d_b_error_from_running_main_exits_3_with_server_error() {
    let env = Env::new();
    let main = MainRole::start(env.socket(), Behavior::Error);

    let run = run_vellis(&env, &[env.doc.as_os_str()]);

    assert_eq!(
        run.code(),
        Some(3),
        "Response::Error from the running main must exit 3 (contract 2); got {:?}, stderr: {}",
        run.code(),
        run.stderr()
    );
    assert!(
        run.stderr().contains("server error"),
        "stderr must contain `server error` (contract 2, wording unchanged); got: {}",
        run.stderr()
    );
    assert_eq!(
        main.received().len(),
        1,
        "the main role must receive the request exactly once; got {:?}",
        main.received()
    );
}

// ---------------------------------------------------------------------------
// (c) 応答しない本体 → STARTUP_RESPONSE_WAIT の後に終了コード 3(10 秒以上・30 秒以内)
// ---------------------------------------------------------------------------

#[test]
fn ac03d_c_silent_running_main_times_out_after_startup_response_wait() {
    let env = Env::new();
    let main = MainRole::start(env.socket(), Behavior::Silent);

    // 30 秒を超えたら run_vellis が kill して失敗にする(「30 秒以内に終わる」)。
    let run = run_vellis(&env, &[env.doc.as_os_str()]);

    assert_eq!(
        run.code(),
        Some(3),
        "a running main that never answers must end in exit 3 (contract 2); got {:?}, stderr: {}",
        run.code(),
        run.stderr()
    );
    assert!(
        run.stderr().contains("timed out"),
        "stderr must report the response timeout (`response timed out`); got: {}",
        run.stderr()
    );
    assert!(
        run.elapsed >= MIN_SILENT_WAIT,
        "the fast path must wait for the answer up to STARTUP_RESPONSE_WAIT (10s) before giving \
         up (contract 1); it exited after {:?}",
        run.elapsed
    );
    assert!(
        run.elapsed <= CHILD_LIMIT,
        "vellis must end within {CHILD_LIMIT:?}; took {:?}",
        run.elapsed
    );
    assert_eq!(
        main.received().len(),
        1,
        "the main role must have received the request exactly once; got {:?}",
        main.received()
    );
}

// ---------------------------------------------------------------------------
// (d) 引数なし(Ping)→ 終了コード 0(不変)
// ---------------------------------------------------------------------------

#[test]
fn ac03d_d_no_args_pings_running_main_and_exits_0() {
    let env = Env::new();
    // Ping はサーバーがその場で答えるので応答役には届かない。応じ方は何でもよい。
    let main = MainRole::start(env.socket(), Behavior::Silent);

    let run = run_vellis(&env, &[]);

    assert_eq!(
        run.code(),
        Some(0),
        "`vellis` with no args must Ping the running main and exit 0 (contract 2); got {:?}, \
         stderr: {}",
        run.code(),
        run.stderr()
    );
    assert!(
        main.received().is_empty(),
        "Ping is answered by the server itself and must not reach the command handler; got {:?}",
        main.received()
    );
}

// ---------------------------------------------------------------------------
// (e) ソース走査: main.rs の本文に IpcClient::send( が無く、send_with_timeout( と
//     STARTUP_RESPONSE_WAIT がある
// ---------------------------------------------------------------------------

/// 行ごとに `//` 以降(コメント)を落とす。`://` は落とさない(acceptance_req3b と同じ流儀)。
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

/// `main.rs` の `#[cfg(test)]` より前・行コメントを除いた本文。
fn main_rs_code() -> String {
    let code = strip_line_comments(include_str!("../src/main.rs"));
    match code.find("#[cfg(test)]") {
        Some(i) => code[..i].to_string(),
        None => code,
    }
}

#[test]
fn ac03d_e_main_rs_fast_path_uses_send_with_timeout_and_startup_response_wait() {
    let code = main_rs_code();
    assert!(
        !code.contains("IpcClient::send("),
        "main.rs must no longer call IpcClient::send( (500ms); the fast path waits with \
         IpcClient::send_with_timeout(.., STARTUP_RESPONSE_WAIT) (contract 1)"
    );
    assert!(
        code.contains("send_with_timeout("),
        "main.rs fast path must call IpcClient::send_with_timeout( (contract 1)"
    );
    assert!(
        code.contains("STARTUP_RESPONSE_WAIT"),
        "main.rs fast path must wait for the answer up to STARTUP_RESPONSE_WAIT (contract 1)"
    );
}
