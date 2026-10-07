//! 要件#3 追補c の受け入れテスト(docs/requirements/req-03.md「追補c」・backlog 311・312)
//!
//! 追補b(`vellis_lib::ipc::launch`)の残り2件を判定する。
//!   - 311: `launch` が起動途中の本体へ依頼を渡すとき、応答待ちが `IpcClient::send` の 500ms
//!     だったため、本体で処理されるのに CLI が `response timed out` で終わりうる。
//!   - 312: `FileLock` の Drop はロックファイルを消してから閉じる。消える前に開かれた古い
//!     ファイル(inode)に後から flock を取ると、パスにはもう無いファイルのロックになり、
//!     パスに新しいファイルを作った別の者と本体が2つになる。
//!
//! 受け入れ基準 AC-03-追c(一時フォルダで):
//!   311:
//!   (a) 本体役が依頼を受けてから 1.5 秒後に `Ok` を返す。ソケットがすでにある場合も、
//!       ロックの持ち主がいてソケットが少し遅れてできる場合も、`launch` は `Delivered(Ok)`
//!       → `ac03c_a_slow_running_main_is_delivered_ok`
//!         `ac03c_a_slow_starting_main_with_late_socket_is_delivered_ok`
//!   (b) 同じ 1.5 秒遅れの本体役に `IpcClient::send` は `Err(ResponseTimeout)`(500ms は不変)、
//!       `IpcClient::send_with_timeout(.., 3 秒)` は `Ok`
//!       → `ac03c_b_send_keeps_500ms_and_send_with_timeout_waits_longer`
//!   (c) `STARTUP_RESPONSE_WAIT` は 10 秒
//!       → `ac03c_c_startup_response_wait_is_10_seconds`
//!   312:
//!   (d) A がロックを持つ間に別のハンドルでロックファイルを開いておく(古いファイル)。A を
//!       手放した(ファイルが消えた)後、その古いハンドルで `try_acquire_opened` すると `Some`、
//!       その間はパスに対する `try_acquire` が `None`
//!       → `ac03c_d_stale_handle_acquires_the_file_now_at_the_path`
//!   (e) (d) と同じ古いハンドルを用意し、A を手放した後に C が `try_acquire` で取る。その後、
//!       古いハンドルで `try_acquire_opened` すると `None`(本体は C だけ)
//!       → `ac03c_e_stale_handle_does_not_lock_beside_the_new_holder`
//!   (f) 複数のスレッドが同じパスで「`try_acquire` → 持っている数を数える → 手放す」を
//!       繰り返しても、同時に持つ者は常に 1 以下
//!       → `ac03c_f_concurrent_acquire_release_never_has_two_holders`
//!
//! ## 確定契約(implementer はこれに従う。実装先: src-tauri/src/ipc/{launch.rs,client.rs,lock.rs})
//!
//! 1. 起動途中の本体への応答は長く待つ(311): `launch` が本体へ依頼を渡すときは、応答を
//!    `STARTUP_RESPONSE_WAIT`(10 秒)まで待つ。待ちきれなければ従来どおり
//!    `Err(LaunchError::Ipc(IpcClientError::ResponseTimeout))`。`IpcClient::send` は
//!    `send_with_timeout` に `SEND_TIMEOUT`(500ms)を渡すのと同じ。接続の待ち時間(100ms)も不変。
//! 2. ロックはパスにいまあるファイルで持つ(312): `try_acquire` は flock が取れた後、開いた
//!    ファイルとパスにいまあるファイルが同じか(デバイスと inode)を確かめ、パスに無い・別の
//!    ファイルなら手放して開き直して取り直す(上限を超えたら `Ok(None)`)。
//!    `try_acquire` は「パスを開く → `try_acquire_opened`」と同じ。
//! 3. 不変: Drop でロックファイルを消すこと(消してから閉じる順)・ロックとソケットのパス・
//!    `try_acquire` の戻り値の意味(`Some`/`None`/`Err`)・追補b の契約1〜7・`protocol.rs`。
//!    依存の追加なし。既存のテストは無改変で緑。
//!
//! このテストが使う口(まだ無いもの):
//!    ```ignore
//!    // vellis_lib::ipc::launch
//!    pub const STARTUP_RESPONSE_WAIT: std::time::Duration; // 10 秒
//!    // vellis_lib::ipc::client::IpcClient
//!    pub async fn send_with_timeout(socket_path: &Path, request: &Request,
//!        response_timeout: Duration) -> Result<Response, IpcClientError>;
//!    // vellis_lib::ipc::lock::FileLock
//!    pub fn try_acquire_opened(path: &Path, file: std::fs::File)
//!        -> Result<Option<FileLock>, std::io::Error>;
//!    ```
//!
//! ## 本テストの組み立て
//!
//! - ソケット・ロックは `/tmp` 直下の短い一時フォルダに置く(Unix ソケットのパス長制限)。
//! - 本体の役は `IpcServer::start` と、受けた `IpcCommand` に `RESPONSE_DELAY`(1.5 秒)後に
//!   `Response::Ok` を返す応答役。別スレッドの個別ランタイムで動かす。
//! - 依頼は `OpenPath`(`Ping` はサーバーがその場で返すので遅延できない)。
//! - `launch` は `main.rs` と同じく current_thread のランタイムで `block_on` する。
//! - 「古いハンドル」は A がロックを持つ間に `OpenOptions::new().read(true).write(true)` で開く。

use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::{Duration, Instant};

use tempfile::TempDir;

use vellis_lib::ipc::client::{IpcClient, IpcClientError};
use vellis_lib::ipc::launch::{launch, Launch, LaunchError, STARTUP_RESPONSE_WAIT};
use vellis_lib::ipc::lock::FileLock;
use vellis_lib::ipc::protocol::{Request, Response};
use vellis_lib::ipc::server::IpcServer;

/// 本体役が依頼を受けてから応答するまでの遅れ(AC (a)(b))。
const RESPONSE_DELAY: Duration = Duration::from_millis(1500);
/// (a) の「少し遅れて」ソケットができるまでの時間。
const LATE: Duration = Duration::from_millis(300);
/// (a) で `launch` に渡すソケット待ちの時間(LATE より十分長く、STARTUP_WAIT より短い)。
const WAIT: Duration = Duration::from_secs(5);
/// (b) で `send_with_timeout` に渡す応答待ち(RESPONSE_DELAY より長い)。
const LONG_RESPONSE_WAIT: Duration = Duration::from_secs(3);
/// 本体の役が止めの合図を待つ上限(テストが固まらないための安全弁)。
const SERVE_DEADLINE: Duration = Duration::from_secs(30);

/// (f) のスレッドの数と、各スレッドのくり返しの回数。
const RACERS: usize = 8;
const ITERATIONS: usize = 500;

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

struct Paths {
    _dir: TempDir,
    socket: PathBuf,
    lock: PathBuf,
}

fn paths() -> Paths {
    let dir = tempfile::Builder::new()
        .prefix("v3c")
        .tempdir_in("/tmp")
        .expect("create a short temp dir under /tmp");
    let socket = dir.path().join("v.sock");
    let lock = dir.path().join("v.lock");
    Paths {
        _dir: dir,
        socket,
        lock,
    }
}

fn open_request() -> Request {
    Request::OpenPath {
        uri: "file:///tmp/x.md".into(),
        new_window: false,
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build tokio runtime")
}

/// `main.rs` と同じく current_thread のランタイムで `launch` を回す。
fn run_launch(
    socket: &Path,
    lock: &Path,
    request: &Request,
    wait: Duration,
) -> Result<Launch, LaunchError> {
    runtime().block_on(launch(socket, lock, request, wait))
}

/// 結果を文字にする(`Launch`/`LaunchError` に Debug を求めないため)。
fn describe(r: &Result<Launch, LaunchError>) -> String {
    match r {
        Ok(Launch::Main(_)) => "Main".into(),
        Ok(Launch::Delivered(Response::Ok)) => "Delivered(Ok)".into(),
        Ok(Launch::Delivered(Response::Error { code, message })) => {
            format!("Delivered(Error {code}: {message})")
        }
        Err(LaunchError::Timeout) => "Err(Timeout)".into(),
        Err(LaunchError::Ipc(e)) => format!("Err(Ipc: {e})"),
        Err(LaunchError::Lock(e)) => format!("Err(Lock: {e})"),
    }
}

/// 遅い本体の役(別スレッド・個別のランタイム)。`delay` の後に `IpcServer` を始め、受けた
/// 依頼を数えて `RESPONSE_DELAY` 後に `Response::Ok` を返す。`lock` を渡すと、生きている間
/// それを持ち続ける(=起動途中の本体)。
struct SlowMain {
    count: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    ready: std_mpsc::Receiver<()>,
    handle: Option<thread::JoinHandle<()>>,
}

impl SlowMain {
    fn spawn(socket: PathBuf, delay: Duration, lock: Option<FileLock>) -> Self {
        let count = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready) = std_mpsc::channel();
        let handle = {
            let count = Arc::clone(&count);
            let stop = Arc::clone(&stop);
            thread::spawn(move || {
                let _lock = lock;
                runtime().block_on(async move {
                    tokio::time::sleep(delay).await;
                    let (server, mut rx) =
                        IpcServer::start(&socket).expect("slow main: start IpcServer");
                    let _ = ready_tx.send(());
                    let started = Instant::now();
                    loop {
                        if stop.load(Ordering::SeqCst) || started.elapsed() > SERVE_DEADLINE {
                            break;
                        }
                        tokio::select! {
                            cmd = rx.recv() => match cmd {
                                Some(cmd) => {
                                    count.fetch_add(1, Ordering::SeqCst);
                                    // 応答だけを遅らせる(受け付けの流れは止めない)。
                                    tokio::spawn(async move {
                                        tokio::time::sleep(RESPONSE_DELAY).await;
                                        let _ = cmd.responder.send(Response::Ok);
                                    });
                                }
                                None => break,
                            },
                            _ = tokio::time::sleep(Duration::from_millis(10)) => {}
                        }
                    }
                    drop(server);
                });
            })
        };
        SlowMain {
            count,
            stop,
            ready,
            handle: Some(handle),
        }
    }

    /// ソケットが bind されるまで待つ。
    fn wait_ready(&self) {
        self.ready
            .recv_timeout(Duration::from_secs(5))
            .expect("slow main must start its IpcServer");
    }

    fn received(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }
}

impl Drop for SlowMain {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

// ---------------------------------------------------------------------------
// (a) 1.5 秒遅れの本体 → launch は Delivered(Ok)(ソケットあり/遅れてできる)
// ---------------------------------------------------------------------------

#[test]
fn ac03c_a_slow_running_main_is_delivered_ok() {
    let p = paths();
    let main = SlowMain::spawn(p.socket.clone(), Duration::ZERO, None);
    main.wait_ready();

    let started = Instant::now();
    let result = run_launch(&p.socket, &p.lock, &open_request(), WAIT);
    let elapsed = started.elapsed();
    assert!(
        matches!(result, Ok(Launch::Delivered(Response::Ok))),
        "with a running main that answers {RESPONSE_DELAY:?} after receiving the request, launch \
         must wait for the answer (STARTUP_RESPONSE_WAIT) and return Delivered(Ok); got {} after \
         {elapsed:?}",
        describe(&result)
    );
    assert_eq!(
        main.received(),
        1,
        "the running main must receive the request exactly once"
    );
    drop(result);
    drop(main);
}

#[test]
fn ac03c_a_slow_starting_main_with_late_socket_is_delivered_ok() {
    let p = paths();
    let held = FileLock::try_acquire(&p.lock)
        .expect("acquire")
        .expect("lock must be free at start");
    // 起動途中の本体: ロックを持ったまま LATE の後にソケットを作り、応答は 1.5 秒遅れる。
    let main = SlowMain::spawn(p.socket.clone(), LATE, Some(held));

    let started = Instant::now();
    let result = run_launch(&p.socket, &p.lock, &open_request(), WAIT);
    let elapsed = started.elapsed();
    assert!(
        matches!(result, Ok(Launch::Delivered(Response::Ok))),
        "with the lock held, the socket appearing after {LATE:?} and the answer coming \
         {RESPONSE_DELAY:?} after the request, launch must return Delivered(Ok); got {} after \
         {elapsed:?}",
        describe(&result)
    );
    assert_eq!(
        main.received(),
        1,
        "the starting main must receive the request exactly once"
    );
    drop(result);
    drop(main);
}

// ---------------------------------------------------------------------------
// (b) send は 500ms のまま ResponseTimeout・send_with_timeout(3 秒) は Ok
// ---------------------------------------------------------------------------

#[test]
fn ac03c_b_send_keeps_500ms_and_send_with_timeout_waits_longer() {
    let p = paths();
    let main = SlowMain::spawn(p.socket.clone(), Duration::ZERO, None);
    main.wait_ready();
    let rt = runtime();
    let request = open_request();

    // IpcClient::send: 応答待ちは 500ms のまま(1.5 秒遅れの応答は待たない)。
    let started = Instant::now();
    let short = rt.block_on(IpcClient::send(&p.socket, &request));
    let elapsed = started.elapsed();
    assert!(
        matches!(short, Err(IpcClientError::ResponseTimeout)),
        "IpcClient::send to a main answering after {RESPONSE_DELAY:?} must fail with \
         ResponseTimeout (SEND_TIMEOUT stays 500ms); got {short:?} after {elapsed:?}"
    );
    assert!(
        elapsed >= Duration::from_millis(450) && elapsed < Duration::from_millis(1400),
        "IpcClient::send must wait about 500ms for the response (SEND_TIMEOUT unchanged); \
         returned after {elapsed:?}"
    );

    // IpcClient::send_with_timeout(.., 3 秒): 1.5 秒遅れの応答を受け取る。
    let started = Instant::now();
    let long = rt.block_on(IpcClient::send_with_timeout(
        &p.socket,
        &request,
        LONG_RESPONSE_WAIT,
    ));
    let elapsed = started.elapsed();
    assert!(
        matches!(long, Ok(Response::Ok)),
        "IpcClient::send_with_timeout(.., {LONG_RESPONSE_WAIT:?}) to a main answering after \
         {RESPONSE_DELAY:?} must return Ok; got {long:?} after {elapsed:?}"
    );

    assert_eq!(
        main.received(),
        2,
        "the main must receive both requests (send and send_with_timeout)"
    );
    drop(main);
}

// ---------------------------------------------------------------------------
// (c) STARTUP_RESPONSE_WAIT は 10 秒
// ---------------------------------------------------------------------------

#[test]
fn ac03c_c_startup_response_wait_is_10_seconds() {
    assert_eq!(
        STARTUP_RESPONSE_WAIT,
        Duration::from_secs(10),
        "STARTUP_RESPONSE_WAIT must be 10 seconds"
    );
}

// ---------------------------------------------------------------------------
// (d) 古いハンドルで try_acquire_opened → Some・その間 try_acquire は None
// ---------------------------------------------------------------------------

#[test]
fn ac03c_d_stale_handle_acquires_the_file_now_at_the_path() {
    let p = paths();
    let a = FileLock::try_acquire(&p.lock)
        .expect("A: try_acquire")
        .expect("A: lock must be free at start");
    // A がロックを持つ間に、別のハンドルでロックファイルを開いておく(古いファイル)。
    let stale = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&p.lock)
        .expect("open the lock file while A holds it");

    drop(a);
    assert!(
        !p.lock.exists(),
        "precondition: dropping A must remove the lock file from the path (Drop unlinks it)"
    );

    let b = match FileLock::try_acquire_opened(&p.lock, stale) {
        Ok(Some(b)) => b,
        Ok(None) => panic!(
            "with no other holder, try_acquire_opened with a handle to the removed lock file must \
             take the lock on the file now at the path and return Some; got None"
        ),
        Err(e) => panic!("try_acquire_opened failed: {e}"),
    };

    match FileLock::try_acquire(&p.lock) {
        Ok(None) => {}
        Ok(Some(_)) => panic!(
            "while B (from try_acquire_opened with a stale handle) holds the lock, try_acquire on \
             the path must return None; it returned Some, so B is locking a file that is no \
             longer at the path (lock file exists at the path while B holds it: {})",
            p.lock.exists()
        ),
        Err(e) => panic!("try_acquire on the lock path failed: {e}"),
    }

    drop(b);
    assert!(
        matches!(FileLock::try_acquire(&p.lock), Ok(Some(_))),
        "after B is dropped, the lock must be free again"
    );
}

// ---------------------------------------------------------------------------
// (e) A を手放した後に C が取る → 古いハンドルで try_acquire_opened は None
// ---------------------------------------------------------------------------

#[test]
fn ac03c_e_stale_handle_does_not_lock_beside_the_new_holder() {
    let p = paths();
    let a = FileLock::try_acquire(&p.lock)
        .expect("A: try_acquire")
        .expect("A: lock must be free at start");
    let stale = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&p.lock)
        .expect("open the lock file while A holds it");

    drop(a);
    assert!(
        !p.lock.exists(),
        "precondition: dropping A must remove the lock file from the path (Drop unlinks it)"
    );

    let c = FileLock::try_acquire(&p.lock)
        .expect("C: try_acquire")
        .expect("C: after A is dropped, C must take the lock on a new file at the path");

    match FileLock::try_acquire_opened(&p.lock, stale) {
        Ok(None) => {}
        Ok(Some(_)) => panic!(
            "while C holds the lock on the file now at the path, try_acquire_opened with a handle \
             to the removed file must return None; it returned Some (two holders)"
        ),
        Err(e) => panic!("try_acquire_opened failed: {e}"),
    }

    // 本体は C だけ: C のロックファイルはパスに残り、別の try_acquire は取れない。
    assert!(
        p.lock.exists(),
        "the failed try_acquire_opened must not remove C's lock file from the path"
    );
    assert!(
        matches!(FileLock::try_acquire(&p.lock), Ok(None)),
        "C must still be the only holder after the failed try_acquire_opened"
    );
    drop(c);
}

// ---------------------------------------------------------------------------
// (f) 複数スレッドで try_acquire → 数える → 手放す: 同時に持つ者は常に 1 以下
// ---------------------------------------------------------------------------

#[test]
fn ac03c_f_concurrent_acquire_release_never_has_two_holders() {
    let p = paths();
    let barrier = Barrier::new(RACERS);
    let holders = AtomicUsize::new(0);
    let max_holders = AtomicUsize::new(0);
    let violations = AtomicUsize::new(0);
    let acquisitions = AtomicUsize::new(0);

    thread::scope(|s| {
        for _ in 0..RACERS {
            let lock_path = &p.lock;
            let barrier = &barrier;
            let holders = &holders;
            let max_holders = &max_holders;
            let violations = &violations;
            let acquisitions = &acquisitions;
            s.spawn(move || {
                barrier.wait();
                for _ in 0..ITERATIONS {
                    match FileLock::try_acquire(lock_path) {
                        Ok(Some(lock)) => {
                            acquisitions.fetch_add(1, Ordering::SeqCst);
                            let now = holders.fetch_add(1, Ordering::SeqCst) + 1;
                            max_holders.fetch_max(now, Ordering::SeqCst);
                            if now > 1 {
                                violations.fetch_add(1, Ordering::SeqCst);
                            }
                            thread::yield_now();
                            // 手放す前に数を戻す。
                            holders.fetch_sub(1, Ordering::SeqCst);
                            drop(lock);
                        }
                        Ok(None) => {}
                        Err(e) => panic!("try_acquire failed during the race: {e}"),
                    }
                }
            });
        }
    });

    assert!(
        acquisitions.load(Ordering::SeqCst) > 0,
        "the race must take the lock at least once (otherwise the check proves nothing)"
    );
    assert_eq!(
        violations.load(Ordering::SeqCst),
        0,
        "at most one thread may hold the lock at a time; saw two or more holders {} time(s) \
         (max at once = {}) over {} acquisitions",
        violations.load(Ordering::SeqCst),
        max_holders.load(Ordering::SeqCst),
        acquisitions.load(Ordering::SeqCst)
    );
    assert!(max_holders.load(Ordering::SeqCst) <= 1);
}
