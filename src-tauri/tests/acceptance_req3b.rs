//! 要件#3 追補b の受け入れテスト(docs/requirements/req-03.md「追補b」・backlog 310)
//!
//! 「起動していない状態で CLI を同時に叩くとプロセスが別々に立ち上がり、履歴のファイルが
//! 壊れる」の修正を判定する。本体になる前に単一起動のロックを取り、取れなければ本体の
//! ソケットに繋がるまで待って依頼を渡す(`vellis_lib::ipc::launch`)。
//!
//! 受け入れ基準 AC-03-追b(一時フォルダのソケット・ロックで):
//!   (a) ソケットもロックの持ち主も無い → `Main` が返り、そのロックが生きている間は
//!       別の `FileLock::try_acquire` が取れない
//!   (b) 本体(`IpcServer` とその応答役)がすでにいる → `Delivered(Ok)` が返り、本体が
//!       依頼を1回受け、ロックには触らない
//!   (c) ロックを別の持ち主が持ち、ソケットは少し遅れてできる → `Delivered` が返り、
//!       本体が依頼を1回受ける
//!   (d) ロックを別の持ち主が持ち続け、ソケットができない → `wait` の後に `Err(Timeout)`
//!       (`Main` にはならない)
//!   (e) ロックの持ち主が、ソケットを作る前にロックを手放す → `Main` が返る
//!   (f) 同じソケット・ロックに対して複数のスレッドが同時に `launch` し、`Main` を取った者
//!       だけが少し遅れて本体を始める → `Main` はちょうど1つ、残りはすべて `Delivered(Ok)`、
//!       本体は残りの数だけ依頼を受ける
//!   (g) `STARTUP_WAIT` は 10 秒
//!   (h) ソース走査: `main.rs` が `launch` と `run_as_main` を使う。`run_with_args(` を呼ぶのは
//!       `LaunchError::Lock` の腕の中の1か所だけで、そこには `warning` の文字を含む `eprintln!`
//!       がある(2026-10-06 契約7=backlog 313 に合わせて改訂。改訂前=`run_with_args` を呼ばない)
//!   (i) ロックのパスが存在しないフォルダの中を指し、ソケットも無い → 待たずに(`wait` を長く
//!       しても 1 秒未満で)`Err(LaunchError::Lock)`(`Main` にも `Timeout` にもならない)
//!   (j) ソース走査: `main.rs` の `LaunchError::Timeout` の腕は終了コード 3 で終わり、
//!       `run_with_args`/`run_as_main` を呼ばない
//!
//! ## 確定契約(implementer はこれに従う。実装先: src-tauri/src/ipc/launch.rs・main.rs・lib.rs)
//!
//! 1. 本体になる前にロックを取る: 本体のソケットに繋がらないときは、Tauri を起動する前に
//!    単一起動のロックを取る。取れたらそのプロセスが本体になり、取ったロックを本体の
//!    生きている間持ち続ける(`setup` で取り直さない)。
//! 2. 取れなければ本体へ渡して終わる: 本体のソケットに繋がるまで短い間隔で待ち、繋がったら
//!    依頼を渡して、すでに起動しているときと同じ終了コードで終わる。
//! 3. 待つ間にロックが空いたら本体になる。
//! 4. 待つのは `STARTUP_WAIT`(10 秒)まで。繋がらなければ stderr に理由を出して終了コード 3。
//! 5. 口(このテストが使う形):
//!    ```ignore
//!    // vellis_lib::ipc::launch
//!    pub const STARTUP_WAIT: std::time::Duration; // 10 秒
//!    pub enum Launch { Main(FileLock), Delivered(Response) }
//!    pub enum LaunchError { Timeout, Ipc(IpcClientError), Lock(std::io::Error) }
//!    pub async fn launch(socket_path: &Path, lock_path: &Path, request: &Request, wait: Duration)
//!        -> Result<Launch, LaunchError>;
//!    // vellis_lib::run_as_main(initial_args: WindowArgs, lock: FileLock)
//!    ```
//!    `main.rs` はこれを使い、本体になるときは取ったロックを `run_as_main` に渡す
//!    (`run_with_args` は契約7 の `LaunchError::Lock` の腕でだけ呼ぶ)。
//! 6. 不変: すでに起動しているときの振る舞い・`--self-check` ほかの早期終了・ソケットと
//!    ロックのパス・`protocol.rs`・追補a のロック。依存の追加なし。既存の受け入れテストは
//!    無改変で緑(注: acceptance_req72.rs は `main.rs` の本文に `IpcClient::probe(` が
//!    `cli.self_check` の分岐より後にあることをソース走査で見ている)。
//! 7. ロックファイルを開けないときは単独で起動する(2026-10-06 由谷判断・backlog 313 で追加):
//!    取り合いに負けたのではなく、ロックファイルそのものを開けない・flock が I/O の失敗を返した
//!    (=`launch` が `Err(LaunchError::Lock)`)ときは、stderr に警告(`vellis: warning:` で始まり、
//!    ロックファイルのパスと理由と「単一起動のロック無しで起動する」旨)を出し、終了せずに
//!    ロック無しで本体として起動する(IPC の受け口は持たない)。`LaunchError::Lock` は待たずに
//!    すぐ返す。`Timeout`・`Ipc` は従来どおり終了コード 3。
//!
//! ## 本テストの組み立て
//!
//! - ソケット・ロックは `/tmp` 直下の短い一時フォルダに置く(Unix ソケットのパス長制限)。
//! - 本体の役は `IpcServer::start` と、受けた `IpcCommand` に `Response::Ok` を返しつつ
//!   受けた数を数えるループ。(b)(c) では別スレッドの個別ランタイムで動かす
//!   (`launch` の待ち方に依らず本体が進むように)。
//! - `launch` は `main.rs` と同じく current_thread のランタイムで `block_on` する。
//! - `Launch`/`LaunchError` に Debug/PartialEq を求めない(match で判定する)。
//! - 依頼は `OpenPath`(`Ping` は本体が応答役へ回さず即答するので、受けた数に出ない)。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::{Duration, Instant};

use tempfile::TempDir;

use vellis_lib::ipc::launch::{launch, Launch, LaunchError, STARTUP_WAIT};
use vellis_lib::ipc::lock::FileLock;
use vellis_lib::ipc::protocol::{Request, Response};
use vellis_lib::ipc::server::IpcServer;

/// (c)(e)(f) の「少し遅れて」。
const LATE: Duration = Duration::from_millis(300);
/// (a)(b)(c)(e)(f) で `launch` に渡す待ち時間(LATE より十分長く、STARTUP_WAIT より短い)。
const WAIT: Duration = Duration::from_secs(5);
/// (d) で `launch` に渡す待ち時間。
const SHORT_WAIT: Duration = Duration::from_millis(500);
/// 本体の役が止めの合図を待つ上限(テストが固まらないための安全弁)。
const SERVE_DEADLINE: Duration = Duration::from_secs(30);

/// (f) の同時に起動するスレッドの数と、くり返しの回数。
const RACERS: usize = 5;
const ROUNDS: usize = 5;

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
        .prefix("v3b")
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

fn is_delivered_ok(r: &Result<Launch, LaunchError>) -> bool {
    matches!(r, Ok(Launch::Delivered(Response::Ok)))
}

/// 本体の応答役: 受けた依頼を数えて `Ok` を返す。`stop()` が真になるか期限で抜ける。
async fn serve(
    rx: &mut tokio::sync::mpsc::Receiver<vellis_lib::ipc::server::IpcCommand>,
    count: &AtomicUsize,
    stop: impl Fn() -> bool,
) {
    let started = Instant::now();
    loop {
        if stop() || started.elapsed() > SERVE_DEADLINE {
            break;
        }
        tokio::select! {
            cmd = rx.recv() => match cmd {
                Some(cmd) => {
                    count.fetch_add(1, Ordering::SeqCst);
                    let _ = cmd.responder.send(Response::Ok);
                }
                None => break,
            },
            _ = tokio::time::sleep(Duration::from_millis(10)) => {}
        }
    }
}

/// 別スレッド(個別のランタイム)で動く本体の役。`delay` の後に `IpcServer` を始める。
/// `lock` を渡すと、本体の役が生きている間それを持ち続ける(=起動途中の本体)。
struct FakeMain {
    count: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    ready: std_mpsc::Receiver<()>,
    handle: Option<thread::JoinHandle<()>>,
}

impl FakeMain {
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
                        IpcServer::start(&socket).expect("fake main: start IpcServer");
                    let _ = ready_tx.send(());
                    serve(&mut rx, &count, || stop.load(Ordering::SeqCst)).await;
                    drop(server);
                });
            })
        };
        FakeMain {
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
            .expect("fake main must start its IpcServer");
    }

    fn received(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }
}

impl Drop for FakeMain {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

// ---------------------------------------------------------------------------
// (a) ソケットもロックの持ち主も無い → Main・ロックは生きている間取れない
// ---------------------------------------------------------------------------

#[test]
fn ac03b_a_no_socket_no_lock_holder_becomes_main_and_holds_the_lock() {
    let p = paths();
    let result = run_launch(&p.socket, &p.lock, &open_request(), WAIT);
    let desc = describe(&result);
    let lock = match result {
        Ok(Launch::Main(lock)) => lock,
        _ => panic!("with no socket and no lock holder, launch must return Main; got {desc}"),
    };

    match FileLock::try_acquire(&p.lock) {
        Ok(None) => {}
        Ok(Some(_)) => panic!(
            "while the lock returned in Main is alive, another FileLock::try_acquire must not get it"
        ),
        Err(e) => panic!("try_acquire on the lock path failed: {e}"),
    }

    drop(lock);
    assert!(
        matches!(FileLock::try_acquire(&p.lock), Ok(Some(_))),
        "after the Main lock is dropped, the lock must be free again"
    );
}

// ---------------------------------------------------------------------------
// (b) 本体がすでにいる → Delivered(Ok)・依頼を1回受ける・ロックに触らない
// ---------------------------------------------------------------------------

#[test]
fn ac03b_b_running_main_gets_the_request_once_and_lock_is_untouched() {
    let p = paths();
    let main = FakeMain::spawn(p.socket.clone(), Duration::ZERO, None);
    main.wait_ready();

    let result = run_launch(&p.socket, &p.lock, &open_request(), WAIT);
    assert!(
        is_delivered_ok(&result),
        "with a running main, launch must return Delivered(Ok); got {}",
        describe(&result)
    );
    assert_eq!(
        main.received(),
        1,
        "the running main must receive the request exactly once"
    );

    // 依頼を渡したプロセスはロックを持っていない(取れる)。
    match FileLock::try_acquire(&p.lock) {
        Ok(Some(_)) => {}
        Ok(None) => panic!("launch that delivered to a running main must not hold the lock"),
        Err(e) => panic!("try_acquire on the lock path failed: {e}"),
    }
    drop(result);
    drop(main);
}

#[test]
fn ac03b_b_running_main_holding_the_lock_gets_the_request_once() {
    // 実際の本体はロックを持っている。その状態でも依頼を渡して終わる。
    let p = paths();
    let held = FileLock::try_acquire(&p.lock)
        .expect("acquire")
        .expect("lock must be free at start");
    let main = FakeMain::spawn(p.socket.clone(), Duration::ZERO, Some(held));
    main.wait_ready();

    let result = run_launch(&p.socket, &p.lock, &open_request(), WAIT);
    assert!(
        is_delivered_ok(&result),
        "with a running main that holds the lock, launch must return Delivered(Ok); got {}",
        describe(&result)
    );
    assert_eq!(
        main.received(),
        1,
        "the running main must receive the request exactly once"
    );
    drop(main);
}

// ---------------------------------------------------------------------------
// (c) ロックは別の持ち主・ソケットは遅れてできる → Delivered・依頼を1回
// ---------------------------------------------------------------------------

#[test]
fn ac03b_c_lock_held_and_socket_appears_late_delivers_once() {
    let p = paths();
    let held = FileLock::try_acquire(&p.lock)
        .expect("acquire")
        .expect("lock must be free at start");
    // 起動途中の本体: ロックを持ったまま、LATE の後にソケットを作る。
    let main = FakeMain::spawn(p.socket.clone(), LATE, Some(held));

    let started = Instant::now();
    let result = run_launch(&p.socket, &p.lock, &open_request(), WAIT);
    let elapsed = started.elapsed();
    assert!(
        is_delivered_ok(&result),
        "with the lock held and the socket appearing after {LATE:?}, launch must wait and return \
         Delivered(Ok); got {} after {elapsed:?}",
        describe(&result)
    );
    assert_eq!(
        main.received(),
        1,
        "the late main must receive the request exactly once"
    );
    drop(main);
}

// ---------------------------------------------------------------------------
// (d) ロックは持たれ続け・ソケットはできない → wait の後に Err(Timeout)
// ---------------------------------------------------------------------------

#[test]
fn ac03b_d_lock_held_and_no_socket_times_out_after_wait() {
    let p = paths();
    let _held = FileLock::try_acquire(&p.lock)
        .expect("acquire")
        .expect("lock must be free at start");

    let started = Instant::now();
    let result = run_launch(&p.socket, &p.lock, &open_request(), SHORT_WAIT);
    let elapsed = started.elapsed();

    assert!(
        matches!(result, Err(LaunchError::Timeout)),
        "with the lock held forever and no socket, launch must return Err(Timeout) (never Main); \
         got {} after {elapsed:?}",
        describe(&result)
    );
    assert!(
        elapsed >= SHORT_WAIT,
        "launch must keep waiting for the socket until `wait` ({SHORT_WAIT:?}) has passed; \
         returned after {elapsed:?}"
    );
    assert!(
        elapsed < SHORT_WAIT + Duration::from_secs(3),
        "launch must honor the `wait` argument ({SHORT_WAIT:?}), not wait much longer; \
         returned after {elapsed:?}"
    );
}

// ---------------------------------------------------------------------------
// (e) 持ち主がソケットを作る前にロックを手放す → Main
// ---------------------------------------------------------------------------

#[test]
fn ac03b_e_lock_released_before_socket_appears_becomes_main() {
    let p = paths();
    let held = FileLock::try_acquire(&p.lock)
        .expect("acquire")
        .expect("lock must be free at start");
    let releaser = thread::spawn(move || {
        thread::sleep(LATE);
        drop(held);
    });

    let started = Instant::now();
    let result = run_launch(&p.socket, &p.lock, &open_request(), WAIT);
    let elapsed = started.elapsed();
    releaser.join().unwrap();

    let desc = describe(&result);
    let lock = match result {
        Ok(Launch::Main(lock)) => lock,
        _ => panic!(
            "when the lock holder exits before making the socket, launch must take the lock and \
             return Main; got {desc} after {elapsed:?}"
        ),
    };
    assert!(
        matches!(FileLock::try_acquire(&p.lock), Ok(None)),
        "the lock returned in Main must actually be held"
    );
    drop(lock);
}

// ---------------------------------------------------------------------------
// (f) 同時に launch → Main はちょうど1つ・残りは Delivered(Ok)・本体は残りの数だけ受ける
// ---------------------------------------------------------------------------

#[test]
fn ac03b_f_concurrent_launches_elect_exactly_one_main_and_deliver_the_rest() {
    for round in 0..ROUNDS {
        let p = paths();
        let barrier = Barrier::new(RACERS);
        let received = AtomicUsize::new(0);
        let finished_others = AtomicUsize::new(0);
        let mains = AtomicUsize::new(0);

        let outcomes: Vec<String> = thread::scope(|s| {
            let handles: Vec<_> = (0..RACERS)
                .map(|_| {
                    let p = &p;
                    let barrier = &barrier;
                    let received = &received;
                    let finished_others = &finished_others;
                    let mains = &mains;
                    s.spawn(move || {
                        let rt = runtime();
                        let request = open_request();
                        barrier.wait();
                        rt.block_on(async {
                            let result = launch(&p.socket, &p.lock, &request, WAIT).await;
                            match result {
                                Ok(Launch::Main(lock)) => {
                                    mains.fetch_add(1, Ordering::SeqCst);
                                    // Main を取った者だけが少し遅れて本体を始め、
                                    // 他の全員が終わるまで(このランタイムで)生かしておく。
                                    tokio::time::sleep(LATE).await;
                                    let (server, mut rx) = IpcServer::start(&p.socket)
                                        .expect("main: start IpcServer");
                                    serve(&mut rx, received, || {
                                        finished_others.load(Ordering::SeqCst)
                                            + mains.load(Ordering::SeqCst)
                                            >= RACERS
                                    })
                                    .await;
                                    drop(server);
                                    drop(lock);
                                    "Main".to_string()
                                }
                                other => {
                                    let d = describe(&other);
                                    finished_others.fetch_add(1, Ordering::SeqCst);
                                    d
                                }
                            }
                        })
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().expect("launch thread must not panic"))
                .collect()
        });

        let ctx = format!("round {round}: outcomes={outcomes:?}");
        let main_count = outcomes.iter().filter(|o| *o == "Main").count();
        assert_eq!(main_count, 1, "{ctx}: exactly one launch must become Main");
        let not_delivered: Vec<_> = outcomes
            .iter()
            .filter(|o| *o != "Main" && *o != "Delivered(Ok)")
            .collect();
        assert!(
            not_delivered.is_empty(),
            "{ctx}: every other launch must return Delivered(Ok); not delivered: {not_delivered:?}"
        );
        assert_eq!(
            received.load(Ordering::SeqCst),
            RACERS - 1,
            "{ctx}: the main must receive exactly one request from each of the others"
        );
    }
}

// ---------------------------------------------------------------------------
// (g) STARTUP_WAIT は 10 秒
// ---------------------------------------------------------------------------

#[test]
fn ac03b_g_startup_wait_is_ten_seconds() {
    assert_eq!(STARTUP_WAIT, Duration::from_secs(10));
}

// ---------------------------------------------------------------------------
// (h) ソース走査: main.rs が launch と run_as_main を使い、run_with_args は Lock の腕で1回だけ
//     (2026-10-06 契約7 で改訂。改訂前=run_with_args を呼ばない)
// ---------------------------------------------------------------------------

/// 行ごとに `//` 以降(コメント)を落とす。`://` は落とさない(acceptance_req3a と同じ流儀)。
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

fn main_rs_code() -> String {
    let code = strip_line_comments(include_str!("../src/main.rs"));
    // 単体テストのモジュールは対象外(本文の起動の流れを判定する)。
    match code.find("#[cfg(test)]") {
        Some(i) => code[..i].to_string(),
        None => code,
    }
}

/// `name(` の呼び出しが(識別子の一部としてではなく)あるか。`ipc::launch::launch(` などを許す。
fn calls(code: &str, name: &str) -> bool {
    let marker = format!("{name}(");
    code.match_indices(&marker).any(|(i, _)| {
        i == 0 || {
            let b = code.as_bytes()[i - 1];
            !(b.is_ascii_alphanumeric() || b == b'_')
        }
    })
}

#[test]
fn ac03b_h_main_rs_uses_launch() {
    let code = main_rs_code();
    assert!(
        calls(&code, "launch"),
        "main.rs must start through vellis_lib::ipc::launch::launch(..) (contract 5)"
    );
}

#[test]
fn ac03b_h_main_rs_uses_run_as_main() {
    let code = main_rs_code();
    assert!(
        calls(&code, "run_as_main"),
        "main.rs must hand the acquired lock to vellis_lib::run_as_main(args, lock) (contract 5)"
    );
}

/// `name(` の呼び出し(識別子の一部ではないもの)の位置をすべて返す。
fn call_positions(code: &str, name: &str) -> Vec<usize> {
    let marker = format!("{name}(");
    code.match_indices(&marker)
        .filter(|(i, _)| {
            *i == 0 || {
                let b = code.as_bytes()[*i - 1];
                !(b.is_ascii_alphanumeric() || b == b'_')
            }
        })
        .map(|(i, _)| i)
        .collect()
}

/// `start` から括弧の深さ(`()` `[]` `{}`。文字列リテラルの中は数えない)を追い、
/// 深さ 0 で `stop(c)` が真になる位置、または深さが負になる(外側の閉じ括弧に当たる)
/// 位置を返す。見つからなければ末尾。
fn scan_balanced(code: &str, start: usize, stop: impl Fn(u8) -> bool) -> usize {
    let b = code.as_bytes();
    let mut depth: i32 = 0;
    let mut i = start;
    while i < b.len() {
        let c = b[i];
        if c == b'"' {
            i += 1;
            while i < b.len() && b[i] != b'"' {
                if b[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i += 1;
            continue;
        }
        match c {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                depth -= 1;
                if depth < 0 {
                    return i;
                }
            }
            _ => {}
        }
        if depth == 0 && stop(c) {
            return i;
        }
        i += 1;
    }
    b.len()
}

/// `pattern`(例 `LaunchError::Lock`)を含む match の腕の範囲(パターンの位置から腕の本体の
/// 終わりまで)をすべて返す。腕の本体は `=>` の後の `{ .. }` のブロック、またはブロックで
/// なければ深さ 0 の `,` か match の閉じ括弧まで。`use` などの腕でない出現(`=>` までに
/// `;` `{` `}` があるもの)は除く。
fn match_arms(code: &str, pattern: &str) -> Vec<(usize, usize)> {
    code.match_indices(pattern)
        .filter_map(|(i, _)| {
            let rest = &code[i..];
            let arrow = rest.find("=>")?;
            if rest[..arrow].contains([';', '{', '}']) {
                return None;
            }
            let body_start = i + arrow + 2;
            let body_start = body_start
                + code[body_start..]
                    .find(|c: char| !c.is_whitespace())
                    .unwrap_or(0);
            let end = if code.as_bytes().get(body_start) == Some(&b'{') {
                // ブロック: 対応する `}` まで(含む)。
                let close = scan_balanced(code, body_start + 1, |_| false);
                (close + 1).min(code.len())
            } else {
                scan_balanced(code, body_start, |c| c == b',')
            };
            Some((i, end))
        })
        .collect()
}

/// `eprintln!(..)` の呼び出しの中身をすべて返す。
fn eprintln_args(code: &str) -> Vec<&str> {
    code.match_indices("eprintln!(")
        .map(|(i, m)| {
            let open = i + m.len();
            let close = scan_balanced(code, open, |_| false);
            &code[open..close]
        })
        .collect()
}

#[test]
fn ac03b_h_main_rs_calls_run_with_args_once_inside_the_lock_error_arm() {
    let code = main_rs_code();
    let calls_at = call_positions(&code, "run_with_args");
    assert_eq!(
        calls_at.len(),
        1,
        "main.rs must call run_with_args( exactly once — only to start without the lock when the \
         lock file cannot be opened (contract 7); found {} call(s)",
        calls_at.len()
    );
    let arms = match_arms(&code, "LaunchError::Lock");
    assert!(
        !arms.is_empty(),
        "main.rs must have a match arm for LaunchError::Lock (contract 7: warn and start alone)"
    );
    let at = calls_at[0];
    assert!(
        arms.iter().any(|&(s, e)| s <= at && at < e),
        "the single run_with_args( call in main.rs must be inside the LaunchError::Lock arm \
         (contract 7); arms found: {:?}",
        arms.iter().map(|&(s, e)| &code[s..e]).collect::<Vec<_>>()
    );
}

#[test]
fn ac03b_h_lock_error_arm_prints_a_warning_with_eprintln() {
    let code = main_rs_code();
    let arms = match_arms(&code, "LaunchError::Lock");
    assert!(
        !arms.is_empty(),
        "main.rs must have a match arm for LaunchError::Lock (contract 7: warn and start alone)"
    );
    let warns = arms.iter().any(|&(s, e)| {
        eprintln_args(&code[s..e])
            .iter()
            .any(|args| args.contains("warning"))
    });
    assert!(
        warns,
        "the LaunchError::Lock arm in main.rs must print a warning to stderr with an eprintln! \
         containing \"warning\" (contract 7); arms found: {:?}",
        arms.iter().map(|&(s, e)| &code[s..e]).collect::<Vec<_>>()
    );
}

// ---------------------------------------------------------------------------
// (i) ロックファイルを開けない(存在しないフォルダの中)・ソケットも無い → すぐ Err(Lock)
// ---------------------------------------------------------------------------

#[test]
fn ac03b_i_unopenable_lock_path_returns_lock_error_without_waiting() {
    let p = paths();
    let dir = p.socket.parent().expect("socket path has a parent").to_path_buf();
    let lock = dir.join("no-such-dir").join("vellis.lock");
    assert!(
        !lock.parent().unwrap().exists(),
        "fixture: the lock's folder must not exist"
    );

    let started = Instant::now();
    let result = run_launch(&p.socket, &lock, &open_request(), WAIT);
    let elapsed = started.elapsed();

    assert!(
        matches!(result, Err(LaunchError::Lock(_))),
        "when the lock file cannot be opened (its folder does not exist) and there is no socket, \
         launch must return Err(LaunchError::Lock) (neither Main nor Timeout); got {} after \
         {elapsed:?}",
        describe(&result)
    );
    assert!(
        elapsed < Duration::from_secs(1),
        "LaunchError::Lock must be returned without waiting (wait = {WAIT:?}); returned after \
         {elapsed:?}"
    );
}

// ---------------------------------------------------------------------------
// (j) ソース走査: LaunchError::Timeout の腕は exit(3) で終わり、本体として起動しない
// ---------------------------------------------------------------------------

#[test]
fn ac03b_j_timeout_arm_exits_with_3_and_does_not_start_the_app() {
    let code = main_rs_code();
    let arms = match_arms(&code, "LaunchError::Timeout");
    assert!(
        !arms.is_empty(),
        "main.rs must have a match arm for LaunchError::Timeout (contract 4)"
    );
    for &(s, e) in &arms {
        let arm = &code[s..e];
        let compact: String = arm.chars().filter(|c| !c.is_whitespace()).collect();
        assert!(
            compact.contains("exit(3)"),
            "the LaunchError::Timeout arm must end with exit code 3 (contract 4・7); arm: {arm}"
        );
        assert!(
            !calls(arm, "run_with_args") && !calls(arm, "run_as_main"),
            "the LaunchError::Timeout arm must not start the app (no run_with_args / run_as_main; \
             contract 4・7); arm: {arm}"
        );
    }
}
