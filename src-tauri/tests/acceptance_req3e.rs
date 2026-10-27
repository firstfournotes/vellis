//! 要件#3 追補e の受け入れテスト(docs/requirements/req-03.md「追補e」・backlog 336)
//!
//! `XDG_RUNTIME_DIR` が長いと `<XDG_RUNTIME_DIR>/vellis.sock` が Unix ソケットのパス長
//! (`sockaddr_un.sun_path`=macOS 104・Linux 108 バイト)に収まらず、本体は
//! `Failed to start IPC server: path must be shorter than SUN_LEN` を記録して IPC なしで
//! 動き続ける。ロックは取れているので、2回目の `vellis <path>` はソケットに繋がれず・ロックも
//! 取れず、`STARTUP_WAIT`(10 秒)待って終了コード 3 で終わる(窓は開かない)。
//!
//! 受け入れ基準 AC-03-追e(契約1=純関数 `socket_path_for(runtime_dir, uid)` が退避先を決める):
//!   (a) `socket_path_for(None, uid)` → `/tmp/vellis-<uid>.sock`。短い `runtime_dir` →
//!       `<runtime_dir>/vellis.sock`
//!       → `ac03e_a_no_runtime_dir_is_tmp_vellis_uid_sock`
//!       → `ac03e_a_short_runtime_dir_is_runtime_dir_vellis_sock`
//!   (b) 境目: `<runtime_dir>/vellis.sock` がちょうど `sun_path` の長さ − 1 バイト → そのまま。
//!       ちょうど `sun_path` の長さ → 退避
//!       → `ac03e_b_boundary_sun_len_minus_1_stays_in_runtime_dir`
//!       → `ac03e_b_boundary_sun_len_falls_back_to_tmp`
//!   (c) 長い `runtime_dir`(200 バイト程度)→ `/tmp/vellis-<uid>-<h>.sock`。`<h>` は小文字の
//!       16進 16 桁で、テストが自前で計算した FNV-1a 64bit(offset basis 0xcbf29ce484222325・
//!       prime 0x100000001b3)と一致。全体が `sun_path` の長さ未満。同じ入力 → 同じパス。
//!       違う長い `runtime_dir` 2つ → 違うパス
//!       → `ac03e_c_long_runtime_dir_falls_back_to_tmp_with_fnv1a_hash`
//!       → `ac03e_c_same_input_same_path_different_input_different_path`
//!   (d) 退避したパスで `IpcServer::start` が成功し、`IpcClient::probe` が真
//!       → `ac03e_d_server_starts_on_fallback_path_and_probe_is_true`
//!   (e) 子プロセス: 長い `XDG_RUNTIME_DIR`(実在する一時フォルダの下の深いフォルダ)で、
//!       本体役が `<XDG_RUNTIME_DIR>/vellis.lock` のロックを持ち、退避したパスにソケットを
//!       立てる → ビルドされた `vellis <path>` は終了コード 0、本体役が `OpenPath` を1回受ける
//!       → `ac03e_e_child_with_long_runtime_dir_reaches_main_on_fallback_socket`
//!   (f) ソース走査: `default_socket_path` の本体が `socket_path_for(` を呼ぶ
//!       → `ac03e_f_default_socket_path_calls_socket_path_for`
//!
//! ## 確定契約(implementer はこれに従う。実装先: src-tauri/src/ipc/server.rs)
//!
//! 1. 純関数 `pub fn socket_path_for(runtime_dir: Option<&Path>, uid: u32) -> PathBuf`:
//!    - `None` → `/tmp/vellis-<uid>.sock`
//!    - `<runtime_dir>/vellis.sock` のバイト長が `sun_path` の長さ未満 → `<runtime_dir>/vellis.sock`
//!    - それ以上 → `/tmp/vellis-<uid>-<h>.sock`。`<h>` = `runtime_dir` の `OsStr` のバイト列の
//!      FNV-1a 64bit を小文字16進 16 桁ゼロ詰め(依存の追加なし=自前)
//!    `default_socket_path()` は `XDG_RUNTIME_DIR` と `getuid()` をこれに渡すだけ。
//! 2. ロックファイル(`default_lock_path`)は今のまま `<XDG_RUNTIME_DIR>/vellis.lock`。
//! 3. 不変: `XDG_RUNTIME_DIR` が無いときの置き場・追補b〜d の契約・終了コードと stderr の文言。
//!
//! 修正前の見込み: `socket_path_for` が無いのでこのテストバイナリ全体がコンパイルできず赤
//! ((a)〜(d) が直接呼ぶ)。関数だけ足しても、(e) は修正前の `vellis` が長いパスに繋がれず・
//! ロックも取れないので 10 秒待って終了コード 3 になり赤(どちらでも GUI は起きない)、(f) は
//! `default_socket_path` の本体が `socket_path_for(` を呼ぶまで赤。
//!
//! ## 本テストの組み立て
//!
//! - `sun_path` の長さは決め打ちせず、`libc::sockaddr_un` をゼロ初期化して `sun_path` の
//!   大きさから求める(`sun_len()`)。
//! - 長い `XDG_RUNTIME_DIR` は `/tmp` 直下の一時フォルダの下に深いフォルダを実際に作る
//!   (`LongRuntimeDir`)。退避先のソケットのファイルは、パニックしても消えるよう
//!   `SocketFileGuard` の Drop で消す。
//! - (e) の本体役は acceptance_req3d と同じ形(別スレッド・個別ランタイム・`IpcServer::start`)。
//!   起動前に `<XDG_RUNTIME_DIR>/vellis.lock` を `FileLock::try_acquire` で持ち、退避先に
//!   ソケットを立ててから子を起動する。子には上限時間(`CHILD_LIMIT`=30 秒)を設ける。
//!   子の `HOME` は一時フォルダに向ける(利用者の履歴を汚さない)。

use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tempfile::TempDir;

use vellis_lib::ipc::client::IpcClient;
use vellis_lib::ipc::lock::FileLock;
use vellis_lib::ipc::protocol::{Request, Response};
use vellis_lib::ipc::server::{socket_path_for, IpcServer};

/// 子プロセスの上限時間。修正前は `STARTUP_WAIT`(10 秒)の後に 3 で終わるので、それより長く。
const CHILD_LIMIT: Duration = Duration::from_secs(30);
/// 本体役が止めの合図を待つ上限(テストが固まらないための安全弁)。
const SERVE_DEADLINE: Duration = Duration::from_secs(60);
/// (c)(d)(e) の「長い `runtime_dir`」の最小のバイト長(200 バイト程度)。
const LONG_RUNTIME_DIR_MIN_LEN: usize = 200;
/// ソケットのファイル名(契約1)。
const SOCKET_FILE_NAME: &str = "vellis.sock";

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

/// `sockaddr_un.sun_path` の長さ(macOS 104・Linux 108)。決め打ちせず型から求める。
fn sun_len() -> usize {
    let addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    std::mem::size_of_val(&addr.sun_path)
}

fn uid() -> u32 {
    unsafe { libc::getuid() }
}

/// FNV-1a 64bit(offset basis 0xcbf29ce484222325・prime 0x100000001b3)の自前実装。
fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// 契約1 の退避先: `/tmp/vellis-<uid>-<h>.sock`(`<h>` は `runtime_dir` のバイト列の FNV-1a)。
fn expected_fallback(runtime_dir: &Path, uid: u32) -> PathBuf {
    PathBuf::from(format!(
        "/tmp/vellis-{uid}-{:016x}.sock",
        fnv1a_64(runtime_dir.as_os_str().as_bytes())
    ))
}

/// `<runtime_dir>/vellis.sock` のバイト長。
fn socket_in(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join(SOCKET_FILE_NAME)
}

fn byte_len(p: &Path) -> usize {
    p.as_os_str().as_bytes().len()
}

/// `/tmp/` + `a` の列で、`<dir>/vellis.sock` のバイト長がちょうど `socket_len` になる
/// `runtime_dir` を作る(実在しなくてよい=純関数の入力)。
fn runtime_dir_with_socket_len(socket_len: usize) -> PathBuf {
    let sep_and_name = 1 + SOCKET_FILE_NAME.len(); // "/vellis.sock"
    let dir_len = socket_len
        .checked_sub(sep_and_name)
        .expect("socket_len must cover /vellis.sock");
    let prefix = "/tmp/";
    assert!(dir_len > prefix.len(), "dir_len must be longer than /tmp/");
    let dir = format!("{prefix}{}", "a".repeat(dir_len - prefix.len()));
    let dir = PathBuf::from(dir);
    assert_eq!(byte_len(&socket_in(&dir)), socket_len, "test helper self-check");
    dir
}

/// 実在する長い `XDG_RUNTIME_DIR`: `/tmp` 直下の一時フォルダの下に深いフォルダを作る。
struct LongRuntimeDir {
    root: TempDir,
    dir: PathBuf,
}

impl LongRuntimeDir {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("v3e")
            .tempdir_in("/tmp")
            .expect("create a temp dir under /tmp");
        let mut dir = root.path().to_path_buf();
        // 40 バイトの階層を、200 バイト程度に届くまで重ねる。
        while byte_len(&dir) < LONG_RUNTIME_DIR_MIN_LEN {
            dir.push("x".repeat(40));
        }
        std::fs::create_dir_all(&dir).expect("create the deep runtime dir");
        assert!(
            byte_len(&socket_in(&dir)) >= sun_len(),
            "test setup: <dir>/vellis.sock must be at least sun_path long"
        );
        LongRuntimeDir { root, dir }
    }

    fn path(&self) -> &Path {
        &self.dir
    }

    fn root(&self) -> &Path {
        self.root.path()
    }
}

/// 退避先のソケットのファイルを、パニックしても消すための番人。
struct SocketFileGuard(PathBuf);

impl Drop for SocketFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build tokio runtime")
}

/// 本体の役(別スレッド・個別のランタイム)。`IpcServer` を `socket` に立て、受けた依頼を
/// 記録してすぐ `Ok` を返す。`lock` を渡すと生きている間それを持ち続ける。
struct MainRole {
    received: Arc<Mutex<Vec<Request>>>,
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl MainRole {
    /// 立ててソケットが bind されるまで待ってから返す。
    fn start(socket: PathBuf, lock: Option<FileLock>) -> Self {
        let received = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = std_mpsc::channel();
        let handle = {
            let received = Arc::clone(&received);
            let stop = Arc::clone(&stop);
            thread::spawn(move || {
                let _lock = lock;
                runtime().block_on(async move {
                    let (server, mut rx) =
                        IpcServer::start(&socket).expect("main role: start IpcServer");
                    let _ = ready_tx.send(());
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
                                    let _ = responder.send(Response::Ok);
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

/// ビルドされた `vellis` を `XDG_RUNTIME_DIR=runtime_dir`・`HOME=home` で起動し、終わるまで
/// 待つ。`CHILD_LIMIT` を超えたら kill して失敗にする。
///
/// GUI を起こさないための前提(呼ぶ前に満たすこと): 本体役が `<runtime_dir>/vellis.lock` を
/// 持ち(修正前の子はロックを取れず 10 秒後に 3 で終わる)、退避先 `fallback_socket` に
/// ソケットが立っている(修正後の子はそこへ依頼を渡して 0 で終わる)。
fn run_vellis(
    runtime_dir: &Path,
    home: &Path,
    cwd: &Path,
    fallback_socket: &Path,
    args: &[&OsStr],
) -> Run {
    assert!(
        fallback_socket.exists(),
        "test setup: the main role's socket must exist at the fallback path before starting \
         vellis (no GUI)"
    );
    assert!(
        matches!(FileLock::try_acquire(&runtime_dir.join("vellis.lock")), Ok(None)),
        "test setup: the main role must hold <XDG_RUNTIME_DIR>/vellis.lock before starting \
         vellis (otherwise an unfixed vellis would start the GUI)"
    );
    let started = Instant::now();
    let mut child = Command::new(env!("CARGO_BIN_EXE_vellis"))
        .args(args)
        .env("XDG_RUNTIME_DIR", runtime_dir)
        .env("HOME", home)
        .current_dir(cwd)
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
// 自前 FNV-1a の自己検査(既知のベクトル)
// ---------------------------------------------------------------------------

#[test]
fn ac03e_helper_fnv1a_64_matches_known_vectors() {
    assert_eq!(fnv1a_64(b""), 0xcbf2_9ce4_8422_2325, "FNV-1a 64 of the empty string");
    assert_eq!(fnv1a_64(b"a"), 0xaf63_dc4c_8601_ec8c, "FNV-1a 64 of \"a\"");
}

// ---------------------------------------------------------------------------
// (a) None → /tmp/vellis-<uid>.sock・短い runtime_dir → <runtime_dir>/vellis.sock
// ---------------------------------------------------------------------------

#[test]
fn ac03e_a_no_runtime_dir_is_tmp_vellis_uid_sock() {
    for uid in [0u32, 501, 1000, u32::MAX] {
        assert_eq!(
            socket_path_for(None, uid),
            PathBuf::from(format!("/tmp/vellis-{uid}.sock")),
            "without a runtime dir the socket is /tmp/vellis-<uid>.sock (contract 1, unchanged)"
        );
    }
}

#[test]
fn ac03e_a_short_runtime_dir_is_runtime_dir_vellis_sock() {
    let short = PathBuf::from("/tmp/v3e-short");
    assert!(byte_len(&socket_in(&short)) < sun_len(), "test helper self-check");
    assert_eq!(
        socket_path_for(Some(&short), uid()),
        short.join("vellis.sock"),
        "a short runtime dir keeps <runtime_dir>/vellis.sock (contract 1, unchanged)"
    );
    // uid は短いときの結果に関わらない。
    assert_eq!(
        socket_path_for(Some(&short), 0),
        short.join("vellis.sock"),
        "the uid must not change the in-runtime-dir socket path"
    );
}

// ---------------------------------------------------------------------------
// (b) 境目: sun_path − 1 → そのまま・sun_path → 退避
// ---------------------------------------------------------------------------

#[test]
fn ac03e_b_boundary_sun_len_minus_1_stays_in_runtime_dir() {
    let dir = runtime_dir_with_socket_len(sun_len() - 1);
    let got = socket_path_for(Some(&dir), uid());
    assert_eq!(
        got,
        socket_in(&dir),
        "<runtime_dir>/vellis.sock of exactly sun_path − 1 ({}) bytes still fits a Unix \
         socket address and must stay in the runtime dir (contract 1); got {}",
        sun_len() - 1,
        got.display()
    );
}

#[test]
fn ac03e_b_boundary_sun_len_falls_back_to_tmp() {
    let dir = runtime_dir_with_socket_len(sun_len());
    let got = socket_path_for(Some(&dir), uid());
    assert_ne!(
        got,
        socket_in(&dir),
        "<runtime_dir>/vellis.sock of exactly sun_path ({}) bytes cannot be bound and must \
         fall back (contract 1)",
        sun_len()
    );
    assert_eq!(
        got,
        expected_fallback(&dir, uid()),
        "the fallback is /tmp/vellis-<uid>-<fnv1a of runtime_dir>.sock (contract 1)"
    );
}

// ---------------------------------------------------------------------------
// (c) 長い runtime_dir → /tmp/vellis-<uid>-<h>.sock(h = 自前 FNV-1a・16桁小文字16進)
// ---------------------------------------------------------------------------

#[test]
fn ac03e_c_long_runtime_dir_falls_back_to_tmp_with_fnv1a_hash() {
    let long = LongRuntimeDir::new();
    let uid = uid();
    let got = socket_path_for(Some(long.path()), uid);
    let got_str = got.to_str().expect("the fallback path is ASCII");

    let prefix = format!("/tmp/vellis-{uid}-");
    assert!(
        got_str.starts_with(&prefix),
        "the fallback must start with {prefix}; got {got_str}"
    );
    assert!(
        got_str.ends_with(".sock"),
        "the fallback must end with .sock; got {got_str}"
    );
    let h = &got_str[prefix.len()..got_str.len() - ".sock".len()];
    assert_eq!(h.len(), 16, "<h> must be 16 hex digits; got {h:?} in {got_str}");
    assert!(
        h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "<h> must be lowercase hexadecimal; got {h:?} in {got_str}"
    );
    assert!(
        byte_len(&got) < sun_len(),
        "the fallback path must be shorter than sun_path ({}); got {} bytes: {got_str}",
        sun_len(),
        byte_len(&got)
    );
    assert_eq!(
        h,
        format!("{:016x}", fnv1a_64(long.path().as_os_str().as_bytes())),
        "<h> must be the FNV-1a 64bit of the runtime_dir bytes (offset basis \
         0xcbf29ce484222325, prime 0x100000001b3), zero-padded lowercase hex"
    );
    assert_eq!(got, expected_fallback(long.path(), uid));
}

#[test]
fn ac03e_c_same_input_same_path_different_input_different_path() {
    let uid = uid();
    let one = LongRuntimeDir::new();
    let two = LongRuntimeDir::new();
    assert_ne!(one.path(), two.path(), "test setup: two distinct long runtime dirs");

    let first = socket_path_for(Some(one.path()), uid);
    let again = socket_path_for(Some(one.path()), uid);
    assert_eq!(
        first, again,
        "the same runtime_dir must always map to the same fallback (CLI and main agree)"
    );

    let other = socket_path_for(Some(two.path()), uid);
    assert_ne!(
        first, other,
        "different long runtime dirs must map to different fallback paths (E2E isolation); \
         both gave {}",
        first.display()
    );
}

// ---------------------------------------------------------------------------
// (d) 退避したパスで IpcServer::start が成功し、IpcClient::probe が真
// ---------------------------------------------------------------------------

#[test]
fn ac03e_d_server_starts_on_fallback_path_and_probe_is_true() {
    let long = LongRuntimeDir::new();
    // 前提の確認: 長いパスそのものには立てられない(これが退避の理由)。
    assert!(
        runtime().block_on(async { IpcServer::start(&socket_in(long.path())).is_err() }),
        "test setup: <long runtime_dir>/vellis.sock must be too long to bind"
    );

    let fallback = socket_path_for(Some(long.path()), uid());
    let _guard = SocketFileGuard(fallback.clone());
    runtime().block_on(async {
        let (server, _rx) = IpcServer::start(&fallback).unwrap_or_else(|e| {
            panic!(
                "IpcServer::start must succeed on the fallback path {} (AC (d)): {e}",
                fallback.display()
            )
        });
        assert!(
            IpcClient::probe(&fallback).await,
            "IpcClient::probe must be true on the fallback path {} (AC (d))",
            fallback.display()
        );
        drop(server);
    });
}

// ---------------------------------------------------------------------------
// (e) 子プロセス: 長い XDG_RUNTIME_DIR・本体役がロックを持ち退避先にソケット → 0・OpenPath 1回
// ---------------------------------------------------------------------------

#[test]
fn ac03e_e_child_with_long_runtime_dir_reaches_main_on_fallback_socket() {
    let long = LongRuntimeDir::new();
    let home = long.root().join("h");
    std::fs::create_dir(&home).expect("create HOME dir");
    let doc = long.root().join("note.md");
    std::fs::write(&doc, "# note\n").expect("write the .md file");

    // 本体役が <XDG_RUNTIME_DIR>/vellis.lock を持つ(修正前の子が本体になって GUI を起こすのを防ぐ)。
    let lock = FileLock::try_acquire(&long.path().join("vellis.lock"))
        .expect("open the lock file in the long runtime dir")
        .expect("the lock in the long runtime dir must be free at test start");

    // 退避先(テストが自前で計算)にソケットを立てる。番人は本体役より先に宣言=後に消える。
    let fallback = expected_fallback(long.path(), uid());
    let _guard = SocketFileGuard(fallback.clone());
    let main = MainRole::start(fallback.clone(), Some(lock));

    let run = run_vellis(long.path(), &home, long.root(), &fallback, &[doc.as_os_str()]);

    assert_eq!(
        run.code(),
        Some(0),
        "with a long XDG_RUNTIME_DIR ({} bytes) and a main listening on the fallback socket {}, \
         `vellis <path>` must hand the request there and exit 0 (contract 1); got {:?} after \
         {:?}, stderr: {}",
        byte_len(long.path()),
        fallback.display(),
        run.code(),
        run.elapsed,
        run.stderr()
    );
    let received = main.received();
    assert_eq!(
        received.len(),
        1,
        "the main role must receive OpenPath exactly once; got {received:?}"
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
// (f) ソース走査: default_socket_path の本体が socket_path_for( を呼ぶ
// ---------------------------------------------------------------------------

/// 行ごとに `//` 以降(コメント)を落とす。`://` は落とさない(acceptance_req3d と同じ流儀)。
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

/// `server.rs` の `pub fn default_socket_path` の本体(中括弧の釣り合いで切り出す)。
fn default_socket_path_body() -> String {
    let code = strip_line_comments(include_str!("../src/ipc/server.rs"));
    let start = code
        .find("pub fn default_socket_path")
        .expect("server.rs must define pub fn default_socket_path");
    let rest = &code[start..];
    let open = rest.find('{').expect("default_socket_path must have a body");
    let mut depth = 0usize;
    for (i, ch) in rest[open..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return rest[open..open + i + 1].to_string();
                }
            }
            _ => {}
        }
    }
    panic!("default_socket_path body is not brace-balanced");
}

#[test]
fn ac03e_f_default_socket_path_calls_socket_path_for() {
    let body = default_socket_path_body();
    assert!(
        body.contains("socket_path_for("),
        "the body of default_socket_path must call socket_path_for( (contract 1); body:\n{body}"
    );
}
