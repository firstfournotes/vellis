//! 要件#5 追補a の受け入れテスト(docs/requirements/req-05.md 追補a・backlog 261)
//!
//! 「ssh の接続が切れると、アプリを再起動するまでそのホストのフォルダを開けない」
//! (2026-10-03 由谷発見・2026-10-04 /goal「backlog #256を修正して」)
//!
//! 契約(追補a):
//! 1. 取り出す前に生存を確かめる: 保持している接続が閉じている(`Handle::is_closed()`)なら
//!    捨てて開き直してから渡す。閉じていなければ使い回す(1ホスト1接続は不変)
//! 2. 切断のエラーで1回だけ開き直す: `list` / `stat` / `read_bytes` の SFTP 操作が「切断」で
//!    失敗したら、その接続を捨てて開き直し、同じ操作を1回だけやり直す。やり直しも失敗したら
//!    そのエラーを返す。開き直し自体が失敗したらその失敗(接続できない理由)を返す
//! 3. 「切断」= `UnexpectedBehavior` / `Timeout` / `IO`。`Status` / `Limited` / `UnexpectedPacket`
//!    は切断ではなく、やり直さずそのまま返す(FsError への写し方は従来の `sftp_to_fs` のまま)。
//!    `read_bytes` の `read_to_end` 途中の I/O エラーも「切断」
//! 4. 捨てるのは自分が使った接続だけ。開き直している間に別の操作が新しい接続を入れていたら、
//!    後から開いた側は先に入った生きている接続を使う(重複は捨てる)
//! 5. 監視は接続を握り続けない: 周回ごとに取り出し直す。切断(開き直しの失敗を含む)では
//!    イベントを送らず直前の状態を保つ。`Status` のときだけ Remove を1回。つながり直して
//!    中身が変わっていれば Modify
//!
//! 本ファイルの持ち場(AC-05-追a の (a)〜(f)。実 sshd は使わない):
//! - (a) `classify_sftp_error` / `classify_io_error` の純関数判定
//! - (b)(c)(d) `ConnectionPool<C>` を偽の接続(`FakeConn`)で判定(tokio の現行スレッド runtime)
//! - (e) `poll_step` の純関数判定
//! - (f) `ssh.rs` のソース走査(配線)
//!
//! ## 確定契約(公開 API・implementer はこれに従う)
//!
//! ```ignore
//! // src-tauri/src/fs/mod.rs
//! #[cfg(feature = "provider-ssh")]
//! pub mod ssh_pool;
//!
//! // src-tauri/src/fs/ssh_pool.rs — 接続の型 C を差し替えられる汎用の入れ物
//! use crate::errors::FsError;
//!
//! /// 入れ物に入る接続。`is_closed` = 下位の SSH 接続が閉じているか
//! /// (ssh.rs の `Session` は `russh::client::Handle::is_closed()` を返す)。
//! pub trait PooledConnection: Send + Sync + 'static {
//!     fn is_closed(&self) -> bool;
//! }
//!
//! /// 操作の失敗の2分類。
//! /// - `Disconnected` = 切断(契約 3)・開く/開き直すことの失敗(接続できない理由)
//! /// - `Failed`       = サーバーが答えたエラーなど、やり直さずそのまま返すもの
//! /// 中の FsError は従来の `sftp_to_fs` と同じ写し方(文言不変)。
//! #[derive(Debug)]
//! pub enum OpError {
//!     Disconnected(FsError),
//!     Failed(FsError),
//! }
//! impl OpError {
//!     pub fn is_disconnected(&self) -> bool;
//!     pub fn into_fs(self) -> FsError;          // 中身を取り出す
//! }
//! impl From<OpError> for FsError { … }         // list / stat / read_bytes が `?` で返す
//!
//! /// `key`(= `user@host:port`)ごとに Arc<C> を1つ保持する。
//! pub struct ConnectionPool<C> { … }            // 内部可変(&self)。Send + Sync
//! impl<C: PooledConnection> ConnectionPool<C> {
//!     pub fn new() -> Self;
//!     /// 契約 1: 保持していて閉じていなければそれを返す(open を呼ばない)。閉じていれば
//!     /// 捨てて `open` で開き直す。無ければ `open` で開く。`open` の失敗はそのまま返し、
//!     /// 入れ物には何も入れない。契約 4 後段: 開いている間に別の操作が同じ key に生きた
//!     /// 接続を入れていたら、自分が開いた方を捨てて先に入った方を返す。
//!     pub async fn get<F, Fut>(&self, key: &str, open: F) -> Result<Arc<C>, FsError>
//!     where F: Fn() -> Fut, Fut: Future<Output = Result<C, FsError>>;
//!     /// 契約 4: `key` に保持しているのが `used` と同じ Arc(`Arc::ptr_eq`)のときだけ
//!     /// 捨てて true。別の接続が入っている・何も無いなら何もせず false。
//!     pub async fn discard(&self, key: &str, used: &Arc<C>) -> bool;
//!     /// いま保持している接続(生存は見ない・開かない)。テスト・診断用。
//!     pub async fn cached(&self, key: &str) -> Option<Arc<C>>;
//!     /// 契約 2: `get(key, open)` → `op(conn)`。`op` が `Disconnected` なら
//!     /// `discard(key, &conn)` → `get(key, open)` → `op(new_conn)` を**1回だけ**。
//!     /// 2回目の結果はそのまま返す。`get` の失敗(開けない・開き直せない)は
//!     /// `Err(OpError::Disconnected(その FsError))`(監視が Remove を送らないため)。
//!     /// `Failed` はやり直さず・捨てずにそのまま返す。
//!     pub async fn run<T, F, Fut, Op, OpFut>(&self, key: &str, open: F, op: Op) -> Result<T, OpError>
//!     where F: Fn() -> Fut, Fut: Future<Output = Result<C, FsError>>,
//!           Op: Fn(Arc<C>) -> OpFut, OpFut: Future<Output = Result<T, OpError>>;
//! }
//! impl<C: PooledConnection> Default for ConnectionPool<C> { … }
//! // (implementer は必要なら F / Fut / Op / OpFut / T に Send 境界を足してよい。
//! //  本テストのクロージャと future はすべて Send)
//!
//! // src-tauri/src/fs/ssh.rs に追加する pub 関数
//! /// 契約 3(純関数): russh-sftp のエラーを 2 分類する。
//! /// - `Status`(NoSuchFile→NotFound(msg)・Failure→NotFound(msg)・PermissionDenied→
//! ///   PermissionDenied(msg)・その他→Io(other(msg)))・`Limited`・`UnexpectedPacket`
//! ///   (→ Io(other(e.to_string()))) → `Failed`
//! /// - `UnexpectedBehavior(_)`・`Timeout`・`IO(_)`(→ Io(other(e.to_string()))) → `Disconnected`
//! pub fn classify_sftp_error(e: russh_sftp::client::error::Error) -> OpError;
//! /// 契約 3(`read_to_end` の途中の I/O エラー): 常に `Disconnected(FsError::Io(e))`。
//! pub fn classify_io_error(e: std::io::Error) -> OpError;
//!
//! /// 監視1周の判定(契約 5・純関数)。
//! pub type PollSnapshot = (Option<u64>, Option<std::time::SystemTime>);
//! /// 入力 = 直前の状態と今回の結果(stat の成功 / Failed=サーバーが答えた / Disconnected)
//! /// 出力 = (送るイベント, 次の直前の状態)
//! /// - 直前なし + Ok(s)                 → (None, Some(s))
//! /// - 直前 s   + Ok(s)                 → (None, Some(s))
//! /// - 直前 s   + Ok(s2 ≠ s)            → (Some(Modify), Some(s2))
//! /// - 直前あり + Err(Failed)           → (Some(Remove), None)
//! /// - 直前なし + Err(Failed)           → (None, None)       … 続けて Remove は送らない
//! /// - 直前 x   + Err(Disconnected)     → (None, x)          … 状態を保つ・何も送らない
//! pub fn poll_step(
//!     prev: Option<PollSnapshot>,
//!     outcome: Result<PollSnapshot, OpError>,
//! ) -> (Option<WatchEventKind>, Option<PollSnapshot>);
//!
//! // src-tauri/src/fs/ssh.rs の配線(ソース走査 (f) が見るもの)
//! // - `impl PooledConnection for Session` が `Handle::is_closed()` を返す
//! // - `SshProvider` の field が `ConnectionPool<Session>`(旧 `Mutex<HashMap<..>>` は撤去)
//! // - `list` / `stat` / `read_bytes` の本体が `.run(` を通る
//! // - `read_bytes` の `read_to_end` の失敗は `classify_io_error(` で写す(`FsError::Io` 直結は不可)
//! // - ポーリング本体: `POLL_INTERVAL` で待つ `loop { … }` の中で毎周 `.run(`(または `.get(`)
//! //   で接続を取り出し、`poll_step(` で判定する。`Arc<SftpSession>` を引数で受け取る関数は
//! //   残さない(= 周回の外で握らない)
//! // - モジュール冒頭 `//!` の「reconnect は後続(follow-up)」の記述を消す
//! ```
//!
//! ## reviewer 照合に委ねるもの(機械判定しにくい配線)
//! - `Session::is_closed` が実際に `russh::client::Handle::is_closed()` の値であること
//! - `run` の `op` クロージャが従来と同じ SFTP 呼び出し(`read_dir` / `metadata` /
//!   `open_with_flags` + `read_to_end`)を `classify_sftp_error` / `classify_io_error` で写していること
//! - ポーリング間隔 2 秒・Remove の文言・known_hosts / 認証 / `ssh -G` が不変であること
//!
//! ## 人間ゲート(実機)
//! - ssh のフォルダを開いたまま接続を切り(スリープ・Wi-Fi 切替・sshd 子プロセス停止)、
//!   再起動なしでツリーの展開・ファイルを開く・外部変更の反映が動くこと

#![cfg(feature = "provider-ssh")]

use std::future::{ready, Future, Ready};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::{Status, StatusCode};

use vellis_lib::errors::FsError;
use vellis_lib::fs::provider::WatchEventKind;
use vellis_lib::fs::ssh::{classify_io_error, classify_sftp_error, poll_step, PollSnapshot};
use vellis_lib::fs::ssh_pool::{ConnectionPool, OpError, PooledConnection};

// ---------------------------------------------------------------------------
// (a) エラーの分け方(純関数)
// ---------------------------------------------------------------------------

fn status(code: StatusCode, msg: &str) -> SftpError {
    SftpError::Status(Status {
        id: 7,
        status_code: code,
        error_message: msg.to_string(),
        language_tag: "en".to_string(),
    })
}

fn failed_display(e: OpError) -> String {
    match e {
        OpError::Failed(fs) => fs.to_string(),
        other => panic!("expected Failed (not a disconnection), got {other:?}"),
    }
}

fn disconnected_display(e: OpError) -> String {
    match e {
        OpError::Disconnected(fs) => fs.to_string(),
        other => panic!("expected Disconnected, got {other:?}"),
    }
}

/// a1. NoSuchFile → 切断ではない・従来どおり NotFound(メッセージそのまま)。
#[test]
fn status_no_such_file_is_not_a_disconnection_and_maps_to_not_found() {
    let e = classify_sftp_error(status(StatusCode::NoSuchFile, "No such file"));
    assert!(!e.is_disconnected());
    assert!(matches!(&e, OpError::Failed(FsError::NotFound(m)) if m == "No such file"));
    assert_eq!(failed_display(e), "not found: No such file");
}

/// a2. PermissionDenied → 切断ではない・従来どおり PermissionDenied。
#[test]
fn status_permission_denied_is_not_a_disconnection() {
    let e = classify_sftp_error(status(StatusCode::PermissionDenied, "Permission denied"));
    assert!(!e.is_disconnected());
    assert!(matches!(&e, OpError::Failed(FsError::PermissionDenied(m)) if m == "Permission denied"));
    assert_eq!(failed_display(e), "permission denied: Permission denied");
}

/// a3. Failure(macOS sftp-server の「見つからない」)→ 切断ではない・従来どおり NotFound。
#[test]
fn status_failure_is_not_a_disconnection_and_maps_to_not_found() {
    let e = classify_sftp_error(status(StatusCode::Failure, "Failure"));
    assert!(!e.is_disconnected());
    assert!(matches!(&e, OpError::Failed(FsError::NotFound(m)) if m == "Failure"));
    assert_eq!(failed_display(e), "not found: Failure");
}

/// a4. その他の Status(BadMessage など)→ 切断ではない・従来どおり Io(メッセージ)。
#[test]
fn other_status_codes_are_not_a_disconnection_and_map_to_io() {
    let e = classify_sftp_error(status(StatusCode::BadMessage, "Bad message"));
    assert!(!e.is_disconnected());
    assert!(matches!(&e, OpError::Failed(FsError::Io(_))));
    assert_eq!(failed_display(e), "I/O error: Bad message");
}

/// a5. Limited → 切断ではない・従来どおり Io(e.to_string())。
#[test]
fn limited_is_not_a_disconnection() {
    let e = classify_sftp_error(SftpError::Limited("read 1048576".into()));
    assert!(!e.is_disconnected());
    assert!(matches!(&e, OpError::Failed(FsError::Io(_))));
    assert_eq!(failed_display(e), "I/O error: Limit exceeded: read 1048576");
}

/// a6. UnexpectedPacket → 切断ではない・従来どおり Io(e.to_string())。
#[test]
fn unexpected_packet_is_not_a_disconnection() {
    let e = classify_sftp_error(SftpError::UnexpectedPacket);
    assert!(!e.is_disconnected());
    assert!(matches!(&e, OpError::Failed(FsError::Io(_))));
    assert_eq!(failed_display(e), "I/O error: Unexpected packet");
}

/// a7. UnexpectedBehavior("session closed")(backlog 261 のコンソールに出た文言)→ 切断。
///     FsError の文言は従来どおり `I/O error: session closed`。
#[test]
fn session_closed_is_a_disconnection() {
    let e = classify_sftp_error(SftpError::UnexpectedBehavior("session closed".into()));
    assert!(e.is_disconnected());
    assert!(matches!(&e, OpError::Disconnected(FsError::Io(_))));
    assert_eq!(disconnected_display(e), "I/O error: session closed");
}

/// a8. UnexpectedBehavior("recv none message")→ 切断。
#[test]
fn recv_none_message_is_a_disconnection() {
    let e = classify_sftp_error(SftpError::UnexpectedBehavior("recv none message".into()));
    assert!(e.is_disconnected());
    assert_eq!(disconnected_display(e), "I/O error: recv none message");
}

/// a9. UnexpectedBehavior の他の文言(送受信の失敗)も切断。
#[test]
fn any_unexpected_behavior_is_a_disconnection() {
    for msg in ["SendError: channel closed", "RecvError: channel closed", "anything else"] {
        let e = classify_sftp_error(SftpError::UnexpectedBehavior(msg.into()));
        assert!(e.is_disconnected(), "UnexpectedBehavior({msg:?}) must be a disconnection");
    }
}

/// a10. Timeout → 切断(文言は従来どおり `I/O error: Timeout`)。
#[test]
fn timeout_is_a_disconnection() {
    let e = classify_sftp_error(SftpError::Timeout);
    assert!(e.is_disconnected());
    assert_eq!(disconnected_display(e), "I/O error: Timeout");
}

/// a11. IO(..) → 切断(文言は従来どおり `I/O error: I/O: <msg>`)。
#[test]
fn io_is_a_disconnection() {
    let e = classify_sftp_error(SftpError::IO("broken pipe".into()));
    assert!(e.is_disconnected());
    assert_eq!(disconnected_display(e), "I/O error: I/O: broken pipe");
}

/// a12. read_to_end 途中の std::io::Error → 切断・FsError::Io に包まれる(kind を保つ)。
#[test]
fn read_to_end_io_error_is_a_disconnection() {
    let e = classify_io_error(std::io::Error::new(
        std::io::ErrorKind::ConnectionReset,
        "connection reset by peer",
    ));
    assert!(e.is_disconnected());
    match e {
        OpError::Disconnected(FsError::Io(io)) => {
            assert_eq!(io.kind(), std::io::ErrorKind::ConnectionReset);
            assert_eq!(io.to_string(), "connection reset by peer");
        }
        other => panic!("expected Disconnected(Io), got {other:?}"),
    }
}

/// a13. OpError → FsError の写しは中身をそのまま返す(どちらの分類でも)。
#[test]
fn op_error_converts_into_its_inner_fs_error() {
    let fs: FsError = OpError::Failed(FsError::NotFound("x".into())).into();
    assert_eq!(fs.to_string(), "not found: x");
    let fs: FsError = OpError::Disconnected(FsError::PermissionDenied("y".into())).into();
    assert_eq!(fs.to_string(), "permission denied: y");
    let fs = OpError::Disconnected(FsError::Io(std::io::Error::other("z"))).into_fs();
    assert_eq!(fs.to_string(), "I/O error: z");
}

// ---------------------------------------------------------------------------
// 偽の接続とフィクスチャ((b)(c)(d) 用)
// ---------------------------------------------------------------------------

/// 偽の接続。`closed` は外から切り替えられる。Drop で `dropped` を数える
/// (重複した接続が捨てられたことを見る)。
struct FakeConn {
    id: usize,
    closed: AtomicBool,
    dropped: Arc<AtomicUsize>,
}

impl PooledConnection for FakeConn {
    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}

impl Drop for FakeConn {
    fn drop(&mut self) {
        self.dropped.fetch_add(1, Ordering::SeqCst);
    }
}

/// `open` の呼び出し回数と、開いた接続の通し番号を数える開き手。
#[derive(Default)]
struct Opener {
    opens: AtomicUsize,
    dropped: Arc<AtomicUsize>,
    /// true のあいだ `open` は PermissionDenied で失敗する(接続できない理由)。
    fail: AtomicBool,
}

impl Opener {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    fn opens(&self) -> usize {
        self.opens.load(Ordering::SeqCst)
    }
    fn dropped(&self) -> usize {
        self.dropped.load(Ordering::SeqCst)
    }
    fn set_fail(&self, fail: bool) {
        self.fail.store(fail, Ordering::SeqCst);
    }
    /// 即時に完了する `open`。
    fn open(self: &Arc<Self>) -> impl Fn() -> Ready<Result<FakeConn, FsError>> {
        let me = self.clone();
        move || ready(me.open_now())
    }
    fn open_now(&self) -> Result<FakeConn, FsError> {
        let id = self.opens.fetch_add(1, Ordering::SeqCst) + 1;
        if self.fail.load(Ordering::SeqCst) {
            return Err(FsError::PermissionDenied(format!(
                "no key accepted by user@host (open #{id})"
            )));
        }
        Ok(FakeConn {
            id,
            closed: AtomicBool::new(false),
            dropped: self.dropped.clone(),
        })
    }
    /// 数回 yield してから完了する `open`(並行の確認用。両方の open が同時に進む)。
    fn open_slow(
        self: &Arc<Self>,
    ) -> impl Fn() -> std::pin::Pin<Box<dyn Future<Output = Result<FakeConn, FsError>> + Send>> {
        let me = self.clone();
        move || {
            let me = me.clone();
            Box::pin(async move {
                for _ in 0..3 {
                    tokio::task::yield_now().await;
                }
                me.open_now()
            })
        }
    }
}

/// 操作の記録: 何回呼ばれ、何番の接続で呼ばれたか。
#[derive(Default)]
struct OpLog {
    conn_ids: Mutex<Vec<usize>>,
}

impl OpLog {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    fn record(&self, conn: &FakeConn) {
        self.conn_ids.lock().unwrap().push(conn.id);
    }
    fn calls(&self) -> usize {
        self.conn_ids.lock().unwrap().len()
    }
    fn ids(&self) -> Vec<usize> {
        self.conn_ids.lock().unwrap().clone()
    }
}

fn disconnected() -> OpError {
    OpError::Disconnected(FsError::Io(std::io::Error::other("session closed")))
}

const KEY: &str = "user@host:22";
const OTHER_KEY: &str = "user@other:2222";

// ---------------------------------------------------------------------------
// (b) 接続の保持
// ---------------------------------------------------------------------------

/// b1. 初回は開く(open 1回)・入れ物に入る。
#[tokio::test]
async fn first_get_opens_a_connection() {
    let opener = Opener::new();
    let pool: ConnectionPool<FakeConn> = ConnectionPool::new();
    let a = pool.get(KEY, opener.open()).await.expect("open succeeds");
    assert_eq!(opener.opens(), 1);
    let cached = pool.cached(KEY).await.expect("connection is kept");
    assert!(Arc::ptr_eq(&cached, &a));
}

/// b2. 2回目は同じ接続を返して開かない(1ホスト1接続)。
#[tokio::test]
async fn second_get_reuses_without_opening() {
    let opener = Opener::new();
    let pool: ConnectionPool<FakeConn> = ConnectionPool::new();
    let a = pool.get(KEY, opener.open()).await.unwrap();
    let a2 = pool.get(KEY, opener.open()).await.unwrap();
    assert!(Arc::ptr_eq(&a, &a2), "the same connection must be handed out");
    assert_eq!(opener.opens(), 1, "a live connection must not be reopened");
}

/// b3. 契約 1: 閉じた接続は捨てて開き直す(取り出す前に生存を確かめる)。
#[tokio::test]
async fn closed_connection_is_replaced_before_handing_out() {
    let opener = Opener::new();
    let pool: ConnectionPool<FakeConn> = ConnectionPool::new();
    let a = pool.get(KEY, opener.open()).await.unwrap();
    a.closed.store(true, Ordering::SeqCst);

    let b = pool.get(KEY, opener.open()).await.unwrap();
    assert!(!Arc::ptr_eq(&a, &b), "a closed connection must not be handed out");
    assert!(!b.is_closed());
    assert_eq!(opener.opens(), 2);
    let cached = pool.cached(KEY).await.expect("the new connection is kept");
    assert!(Arc::ptr_eq(&cached, &b), "the pool must hold the replacement, not the dead one");

    // 以後は b を使い回す(また開かない)。
    let b2 = pool.get(KEY, opener.open()).await.unwrap();
    assert!(Arc::ptr_eq(&b, &b2));
    assert_eq!(opener.opens(), 2);
}

/// b4. 閉じた接続を捨てたあと、テスト側の Arc を手放せば接続本体は解放される
///     (入れ物が古い接続を抱え続けない)。
#[tokio::test]
async fn replaced_connection_is_released_by_the_pool() {
    let opener = Opener::new();
    let pool: ConnectionPool<FakeConn> = ConnectionPool::new();
    let a = pool.get(KEY, opener.open()).await.unwrap();
    a.closed.store(true, Ordering::SeqCst);
    let _b = pool.get(KEY, opener.open()).await.unwrap();
    assert_eq!(opener.dropped(), 0, "the test still holds `a`");
    drop(a);
    assert_eq!(opener.dropped(), 1, "the pool must not keep a reference to the dead connection");
}

/// b5. 開けなかったら失敗を返し、入れ物には何も入れない(次回また開きに行く)。
#[tokio::test]
async fn failed_open_returns_the_error_and_keeps_nothing() {
    let opener = Opener::new();
    opener.set_fail(true);
    let pool: ConnectionPool<FakeConn> = ConnectionPool::new();
    let err = pool.get(KEY, opener.open()).await.err().expect("open fails");
    assert!(matches!(&err, FsError::PermissionDenied(m) if m.starts_with("no key accepted")), "{err}");
    assert!(pool.cached(KEY).await.is_none());
    assert_eq!(opener.opens(), 1);

    opener.set_fail(false);
    let a = pool.get(KEY, opener.open()).await.expect("now it opens");
    assert_eq!(opener.opens(), 2);
    assert!(Arc::ptr_eq(&pool.cached(KEY).await.unwrap(), &a));
}

/// b6. ホストごとに独立: 別の key は別の接続・片方を閉じても他方は影響を受けない。
#[tokio::test]
async fn hosts_are_independent() {
    let opener = Opener::new();
    let pool: ConnectionPool<FakeConn> = ConnectionPool::new();
    let a = pool.get(KEY, opener.open()).await.unwrap();
    let o = pool.get(OTHER_KEY, opener.open()).await.unwrap();
    assert!(!Arc::ptr_eq(&a, &o));
    assert_eq!(opener.opens(), 2);

    a.closed.store(true, Ordering::SeqCst);
    let o2 = pool.get(OTHER_KEY, opener.open()).await.unwrap();
    assert!(Arc::ptr_eq(&o, &o2), "another host's connection must stay");
    assert_eq!(opener.opens(), 2);

    let b = pool.get(KEY, opener.open()).await.unwrap();
    assert!(!Arc::ptr_eq(&a, &b));
    assert_eq!(opener.opens(), 3);
    assert!(Arc::ptr_eq(&pool.cached(OTHER_KEY).await.unwrap(), &o));
}

/// b7. 契約 4 後段: 空の入れ物に2つの操作が同時に開きに行っても、渡されるのは同じ1つの
///     接続で、重複して開いた分は捨てられる(1ホスト1接続)。
#[tokio::test]
async fn concurrent_opens_converge_on_one_connection() {
    let opener = Opener::new();
    let pool: Arc<ConnectionPool<FakeConn>> = Arc::new(ConnectionPool::new());

    let (r1, r2) = tokio::join!(
        pool.get(KEY, opener.open_slow()),
        pool.get(KEY, opener.open_slow()),
    );
    let c1 = r1.expect("first get succeeds");
    let c2 = r2.expect("second get succeeds");
    assert!(Arc::ptr_eq(&c1, &c2), "both callers must end up with the same connection");
    let cached = pool.cached(KEY).await.expect("one connection is kept");
    assert!(Arc::ptr_eq(&cached, &c1));
    let opens = opener.opens();
    assert!((1..=2).contains(&opens), "open at most once per caller, got {opens}");
    assert_eq!(
        opener.dropped(),
        opens - 1,
        "every duplicate connection must be discarded (opened {opens}, dropped {})",
        opener.dropped()
    );
}

// ---------------------------------------------------------------------------
// (c) やり直し
// ---------------------------------------------------------------------------

/// c1. 操作が成功 → 開き直さない(open 1回・op 1回・接続は保持されたまま)。
#[tokio::test]
async fn successful_operation_does_not_reopen() {
    let opener = Opener::new();
    let log = OpLog::new();
    let pool: ConnectionPool<FakeConn> = ConnectionPool::new();

    let out = pool
        .run(KEY, opener.open(), |c: Arc<FakeConn>| {
            let log = log.clone();
            async move {
                log.record(&c);
                Ok::<usize, OpError>(c.id * 10)
            }
        })
        .await
        .expect("op succeeds");
    assert_eq!(out, 10);
    assert_eq!(opener.opens(), 1);
    assert_eq!(log.calls(), 1);
    assert!(pool.cached(KEY).await.is_some());
}

/// c2. 1回目が切断 → 捨てて1回だけ開き直し、新しい接続で同じ操作をやり直して成功を返す。
#[tokio::test]
async fn disconnection_reopens_once_and_retries_on_the_new_connection() {
    let opener = Opener::new();
    let log = OpLog::new();
    let pool: ConnectionPool<FakeConn> = ConnectionPool::new();
    let a = pool.get(KEY, opener.open()).await.unwrap();
    let dead_id = a.id;

    let out = pool
        .run(KEY, opener.open(), |c: Arc<FakeConn>| {
            let log = log.clone();
            async move {
                log.record(&c);
                if c.id == dead_id {
                    Err(disconnected())
                } else {
                    Ok::<String, OpError>(format!("read on #{}", c.id))
                }
            }
        })
        .await
        .expect("the retry on the fresh connection succeeds");
    assert_eq!(out, "read on #2");
    assert_eq!(opener.opens(), 2, "exactly one reopen");
    assert_eq!(log.ids(), vec![1, 2], "the same operation runs once on the old and once on the new connection");
    let cached = pool.cached(KEY).await.expect("the new connection is kept");
    assert!(!Arc::ptr_eq(&cached, &a), "the dead connection must be gone");
    assert_eq!(cached.id, 2);
}

/// c3. 2回続けて切断 → 切断のエラーを返し、開くのは合計2回まで(何度も繰り返さない)。
#[tokio::test]
async fn two_disconnections_in_a_row_give_up_after_one_reopen() {
    let opener = Opener::new();
    let log = OpLog::new();
    let pool: ConnectionPool<FakeConn> = ConnectionPool::new();

    let err = pool
        .run(KEY, opener.open(), |c: Arc<FakeConn>| {
            let log = log.clone();
            async move {
                log.record(&c);
                Err::<(), OpError>(disconnected())
            }
        })
        .await
        .err()
        .expect("the second disconnection is returned");
    assert!(err.is_disconnected(), "{err:?}");
    assert_eq!(err.into_fs().to_string(), "I/O error: session closed");
    assert_eq!(opener.opens(), 2, "open at most twice in total");
    assert_eq!(log.calls(), 2, "the operation runs at most twice");
}

/// c4. 切断でないエラー(サーバーが答えた)→ やり直さず・捨てずにそのまま返す。
#[tokio::test]
async fn non_disconnection_error_is_returned_without_retry() {
    let opener = Opener::new();
    let log = OpLog::new();
    let pool: ConnectionPool<FakeConn> = ConnectionPool::new();
    let a = pool.get(KEY, opener.open()).await.unwrap();

    let err = pool
        .run(KEY, opener.open(), |c: Arc<FakeConn>| {
            let log = log.clone();
            async move {
                log.record(&c);
                Err::<(), OpError>(OpError::Failed(FsError::NotFound("No such file".into())))
            }
        })
        .await
        .err()
        .expect("the server error is returned");
    assert!(!err.is_disconnected());
    assert!(matches!(&err, OpError::Failed(FsError::NotFound(m)) if m == "No such file"));
    assert_eq!(log.calls(), 1, "no retry for a server-answered error");
    assert_eq!(opener.opens(), 1, "no reopen for a server-answered error");
    let cached = pool.cached(KEY).await.expect("the connection stays");
    assert!(Arc::ptr_eq(&cached, &a), "a server-answered error must not discard the connection");
}

/// c5. 開き直しの失敗 → その失敗(接続できない理由)を「切断」側で返す。操作はやり直さない。
#[tokio::test]
async fn failed_reopen_returns_the_open_error() {
    let opener = Opener::new();
    let log = OpLog::new();
    let pool: ConnectionPool<FakeConn> = ConnectionPool::new();
    let _a = pool.get(KEY, opener.open()).await.unwrap();
    opener.set_fail(true);

    let err = pool
        .run(KEY, opener.open(), |c: Arc<FakeConn>| {
            let log = log.clone();
            async move {
                log.record(&c);
                Err::<(), OpError>(disconnected())
            }
        })
        .await
        .err()
        .expect("the reopen failure is returned");
    assert!(err.is_disconnected(), "a reopen failure counts as a disconnection: {err:?}");
    let fs = err.into_fs();
    assert!(
        matches!(&fs, FsError::PermissionDenied(m) if m.starts_with("no key accepted")),
        "the reason the connection could not be opened must come through: {fs}"
    );
    assert_eq!(log.calls(), 1, "the operation is not retried when the reopen fails");
    assert_eq!(opener.opens(), 2);
    assert!(pool.cached(KEY).await.is_none(), "nothing usable is kept after a failed reopen");
}

/// c6. 最初から開けない(入れ物が空で open が失敗)→ 操作は呼ばれず、失敗を「切断」側で返す。
#[tokio::test]
async fn failed_initial_open_returns_the_open_error_without_running_the_operation() {
    let opener = Opener::new();
    opener.set_fail(true);
    let log = OpLog::new();
    let pool: ConnectionPool<FakeConn> = ConnectionPool::new();

    let err = pool
        .run(KEY, opener.open(), |c: Arc<FakeConn>| {
            let log = log.clone();
            async move {
                log.record(&c);
                Ok::<(), OpError>(())
            }
        })
        .await
        .err()
        .expect("the open failure is returned");
    assert!(err.is_disconnected());
    assert!(matches!(err.into_fs(), FsError::PermissionDenied(_)));
    assert_eq!(log.calls(), 0);
    assert_eq!(opener.opens(), 1, "no second attempt when the first open fails");
}

/// c7. 契約 1 と 2 の合わせ技: 閉じている接続は操作の前に捨てられるので、操作は新しい
///     接続で1回だけ走る。
#[tokio::test]
async fn run_checks_liveness_before_the_operation() {
    let opener = Opener::new();
    let log = OpLog::new();
    let pool: ConnectionPool<FakeConn> = ConnectionPool::new();
    let a = pool.get(KEY, opener.open()).await.unwrap();
    a.closed.store(true, Ordering::SeqCst);

    let out = pool
        .run(KEY, opener.open(), |c: Arc<FakeConn>| {
            let log = log.clone();
            async move {
                log.record(&c);
                Ok::<usize, OpError>(c.id)
            }
        })
        .await
        .unwrap();
    assert_eq!(out, 2);
    assert_eq!(log.ids(), vec![2], "the closed connection must never be used for the operation");
    assert_eq!(opener.opens(), 2);
}

/// c8. 契約 4 前段: 2つの操作が同じ死んだ接続で同時に切断に気づいても、捨てるのは1回で、
///     両方のやり直しは同じ生きた接続を使う(別の操作が入れた新しい接続は捨てない)。
#[tokio::test]
async fn concurrent_disconnections_discard_the_dead_connection_once() {
    let opener = Opener::new();
    let log = OpLog::new();
    let pool: Arc<ConnectionPool<FakeConn>> = Arc::new(ConnectionPool::new());
    let a = pool.get(KEY, opener.open()).await.unwrap();
    let dead_id = a.id;
    drop(a);

    let op = |c: Arc<FakeConn>| {
        let log = log.clone();
        async move {
            // 死んだ接続での操作は(現実と同じく)少し時間がかかってから切断に気づく。
            tokio::task::yield_now().await;
            log.record(&c);
            if c.id == dead_id {
                Err(disconnected())
            } else {
                Ok::<usize, OpError>(c.id)
            }
        }
    };
    let (r1, r2) = tokio::join!(
        pool.run(KEY, opener.open_slow(), op),
        pool.run(KEY, opener.open_slow(), op),
    );
    let id1 = r1.expect("first operation recovers");
    let id2 = r2.expect("second operation recovers");
    assert_eq!(id1, id2, "both retries must use the one live connection");
    assert_ne!(id1, dead_id);

    let cached = pool.cached(KEY).await.expect("a live connection is kept");
    assert_eq!(cached.id, id1, "the pool holds the connection the retries used");
    let opens = opener.opens();
    assert!((2..=3).contains(&opens), "dead + at most one reopen per caller, got {opens}");
    // 死んだ接続と、重複して開いた分(あれば)は捨てられている。cached を手放す前なので
    // 生きている接続1つだけが未解放。
    assert_eq!(opener.dropped(), opens - 1, "opened {opens}, dropped {}", opener.dropped());
    assert_eq!(
        log.ids().iter().filter(|id| **id == dead_id).count(),
        2,
        "each operation noticed the disconnection exactly once: {:?}",
        log.ids()
    );
    assert!(log.calls() <= 4, "no operation may retry more than once: {:?}", log.ids());
}

// ---------------------------------------------------------------------------
// (d) 捨てるのは同じ接続だけ
// ---------------------------------------------------------------------------

/// d1. A を B に入れ替えたあと A を捨てるよう頼んでも B は残る(false が返る)。
#[tokio::test]
async fn discard_of_a_replaced_connection_leaves_the_replacement() {
    let opener = Opener::new();
    let pool: ConnectionPool<FakeConn> = ConnectionPool::new();
    let a = pool.get(KEY, opener.open()).await.unwrap();
    a.closed.store(true, Ordering::SeqCst);
    let b = pool.get(KEY, opener.open()).await.unwrap();
    assert!(!Arc::ptr_eq(&a, &b));

    assert!(!pool.discard(KEY, &a).await, "A is no longer the kept connection");
    let cached = pool.cached(KEY).await.expect("B must still be there");
    assert!(Arc::ptr_eq(&cached, &b));
    assert_eq!(opener.opens(), 2);
}

/// d2. 保持しているのと同じ接続を捨てるよう頼めば捨てる(true)・以後は開き直す。
#[tokio::test]
async fn discard_of_the_kept_connection_removes_it() {
    let opener = Opener::new();
    let pool: ConnectionPool<FakeConn> = ConnectionPool::new();
    let a = pool.get(KEY, opener.open()).await.unwrap();
    assert!(pool.discard(KEY, &a).await);
    assert!(pool.cached(KEY).await.is_none());
    let b = pool.get(KEY, opener.open()).await.unwrap();
    assert!(!Arc::ptr_eq(&a, &b));
    assert_eq!(opener.opens(), 2);
}

/// d3. 2回目の discard(すでに捨てた接続・知らない key)は無害(false・他に影響しない)。
#[tokio::test]
async fn repeated_or_unknown_discard_is_harmless() {
    let opener = Opener::new();
    let pool: ConnectionPool<FakeConn> = ConnectionPool::new();
    let a = pool.get(KEY, opener.open()).await.unwrap();
    let o = pool.get(OTHER_KEY, opener.open()).await.unwrap();
    assert!(pool.discard(KEY, &a).await);
    assert!(!pool.discard(KEY, &a).await, "already gone");
    assert!(!pool.discard("nobody@nowhere:1", &a).await, "unknown key");
    assert!(!pool.discard(OTHER_KEY, &a).await, "A is not the other host's connection");
    let cached = pool.cached(OTHER_KEY).await.expect("the other host is untouched");
    assert!(Arc::ptr_eq(&cached, &o));
}

// ---------------------------------------------------------------------------
// (e) 監視の判定(純関数)
// ---------------------------------------------------------------------------

fn snap(size: u64, secs: u64) -> PollSnapshot {
    (Some(size), Some(UNIX_EPOCH + Duration::from_secs(secs)))
}

fn server_error() -> OpError {
    OpError::Failed(FsError::NotFound("No such file".into()))
}

/// e1. 初回の状態 → 何も送らない・状態を覚える。
#[test]
fn first_snapshot_sends_nothing() {
    let (ev, next) = poll_step(None, Ok(snap(10, 100)));
    assert_eq!(ev, None);
    assert_eq!(next, Some(snap(10, 100)));
}

/// e2. 同じ状態 → 何も送らない。
#[test]
fn unchanged_snapshot_sends_nothing() {
    let (ev, next) = poll_step(Some(snap(10, 100)), Ok(snap(10, 100)));
    assert_eq!(ev, None);
    assert_eq!(next, Some(snap(10, 100)));
}

/// e3. 変わった(サイズ・更新時刻のどちらか)→ Modify・新しい状態を覚える。
#[test]
fn changed_snapshot_sends_modify() {
    let (ev, next) = poll_step(Some(snap(10, 100)), Ok(snap(11, 100)));
    assert_eq!(ev, Some(WatchEventKind::Modify));
    assert_eq!(next, Some(snap(11, 100)));

    let (ev, next) = poll_step(Some(snap(10, 100)), Ok(snap(10, 101)));
    assert_eq!(ev, Some(WatchEventKind::Modify));
    assert_eq!(next, Some(snap(10, 101)));
}

/// e4. サーバーが答えたエラー → 直前に状態があれば Remove を1回・状態を捨てる。
#[test]
fn server_error_after_a_snapshot_sends_remove_once() {
    let (ev, next) = poll_step(Some(snap(10, 100)), Err(server_error()));
    assert_eq!(ev, Some(WatchEventKind::Remove));
    assert_eq!(next, None);
}

/// e5. サーバーが答えたエラーが続く → 2回目以降は送らない(直前の状態が無いので)。
#[test]
fn repeated_server_error_stays_silent() {
    let (ev, next) = poll_step(None, Err(server_error()));
    assert_eq!(ev, None);
    assert_eq!(next, None);

    let (_, after_remove) = poll_step(Some(snap(10, 100)), Err(server_error()));
    let (ev, next) = poll_step(after_remove, Err(server_error()));
    assert_eq!(ev, None);
    assert_eq!(next, None);
}

/// e6. 切断 → 何も送らず直前の状態を保つ(Remove を誤って送らない=backlog 261 の症状)。
#[test]
fn disconnection_sends_nothing_and_keeps_the_snapshot() {
    let (ev, next) = poll_step(Some(snap(10, 100)), Err(disconnected()));
    assert_eq!(ev, None);
    assert_eq!(next, Some(snap(10, 100)));
}

/// e7. 開き直しの失敗(接続できない理由が「切断」側で返る)も同じ扱い。
#[test]
fn reopen_failure_sends_nothing_and_keeps_the_snapshot() {
    let reopen_failed = OpError::Disconnected(FsError::PermissionDenied("no key accepted".into()));
    let (ev, next) = poll_step(Some(snap(10, 100)), Err(reopen_failed));
    assert_eq!(ev, None);
    assert_eq!(next, Some(snap(10, 100)));
}

/// e8. 切断が続いても状態は保たれる・直前が無ければ何も変わらない。
#[test]
fn repeated_disconnection_keeps_state_stable() {
    let mut state = Some(snap(10, 100));
    for _ in 0..3 {
        let (ev, next) = poll_step(state, Err(disconnected()));
        assert_eq!(ev, None);
        state = next;
    }
    assert_eq!(state, Some(snap(10, 100)));

    let (ev, next) = poll_step(None, Err(disconnected()));
    assert_eq!(ev, None);
    assert_eq!(next, None);
}

/// e9. 切断のあと変わった状態 → Modify(切れている間の変更を取りこぼさない)。
#[test]
fn change_after_disconnection_sends_modify() {
    let (_, kept) = poll_step(Some(snap(10, 100)), Err(disconnected()));
    let (ev, next) = poll_step(kept, Ok(snap(12, 130)));
    assert_eq!(ev, Some(WatchEventKind::Modify));
    assert_eq!(next, Some(snap(12, 130)));
}

/// e10. 切断のあと同じ状態 → 何も送らない。
#[test]
fn same_state_after_disconnection_sends_nothing() {
    let (_, kept) = poll_step(Some(snap(10, 100)), Err(disconnected()));
    let (ev, next) = poll_step(kept, Ok(snap(10, 100)));
    assert_eq!(ev, None);
    assert_eq!(next, Some(snap(10, 100)));
}

/// e11. Remove のあとファイルが戻った → 従来どおり何も送らない(初回扱い)・次の変化で Modify。
#[test]
fn reappearance_after_remove_is_treated_as_first_snapshot() {
    let (_, after_remove) = poll_step(Some(snap(10, 100)), Err(server_error()));
    let (ev, next) = poll_step(after_remove, Ok(snap(3, 200)));
    assert_eq!(ev, None);
    assert_eq!(next, Some(snap(3, 200)));
}

/// e12. サイズも更新時刻も無い(サーバーが属性を返さない)状態同士も「同じ」として扱える。
#[test]
fn absent_attributes_compare_as_equal_snapshots() {
    let empty: PollSnapshot = (None, None);
    let (ev, next) = poll_step(Some(empty), Ok(empty));
    assert_eq!(ev, None);
    assert_eq!(next, Some(empty));
    let (ev, _) = poll_step(Some(empty), Ok((Some(1), None::<SystemTime>)));
    assert_eq!(ev, Some(WatchEventKind::Modify));
}

// ---------------------------------------------------------------------------
// (f) ソース走査 — ssh.rs の配線
// ---------------------------------------------------------------------------

const SSH_RS: &str = include_str!("../src/fs/ssh.rs");
const FS_MOD_RS: &str = include_str!("../src/fs/mod.rs");

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

fn ssh_code() -> String {
    strip_line_comments(SSH_RS)
}

/// `from` 以降で最初に現れる `open` から、対応する `close` までを切り出す。
fn balanced(code: &str, from: usize, open: char, close: char) -> &str {
    let start = code[from..]
        .find(open)
        .unwrap_or_else(|| panic!("`{open}` must follow offset {from}"))
        + from;
    let mut depth = 0usize;
    for (offset, ch) in code[start..].char_indices() {
        if ch == open {
            depth += 1;
        } else if ch == close {
            depth -= 1;
            if depth == 0 {
                return &code[start..start + offset + ch.len_utf8()];
            }
        }
    }
    panic!("`{open}` at {start} never closes");
}

/// `fn <name>` の (引数リスト, 本体) を切り出す(ジェネリクス・`impl Fn()` 入りの引数にも耐える)。
fn function_parts<'a>(code: &'a str, name: &str) -> (&'a str, &'a str) {
    let needle = format!("fn {name}");
    let start = code
        .match_indices(&needle)
        .map(|(i, _)| i)
        .find(|i| {
            let rest = &code[i + needle.len()..];
            rest.starts_with('(') || rest.starts_with('<')
        })
        .unwrap_or_else(|| panic!("ssh.rs must define {name}"));
    let params = balanced(code, start + needle.len(), '(', ')');
    let params_end = params.as_ptr() as usize - code.as_ptr() as usize + params.len();
    let body = balanced(code, params_end, '{', '}');
    (params, body)
}

/// ファイル内の全関数の (名前, 引数リスト)。
fn all_functions(code: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (i, _) in code.match_indices("fn ") {
        if i > 0 && !code.as_bytes()[i - 1].is_ascii_whitespace() {
            continue; // `self.fn `, `pub fn ` の内側など
        }
        let rest = &code[i + 3..];
        let name_len = rest
            .find(|c: char| !(c.is_alphanumeric() || c == '_'))
            .unwrap_or(rest.len());
        if name_len == 0 {
            continue;
        }
        let name = &rest[..name_len];
        let after = &rest[name_len..];
        if !(after.starts_with('(') || after.starts_with('<')) {
            continue;
        }
        let params = balanced(code, i + 3 + name_len, '(', ')');
        out.push((name.to_string(), params.to_string()));
    }
    out
}

/// f1. `fs/mod.rs` が `ssh_pool` を provider-ssh の下で公開する。
#[test]
fn fs_mod_exposes_ssh_pool_under_the_feature() {
    let code = strip_line_comments(FS_MOD_RS);
    let at = code
        .find("pub mod ssh_pool;")
        .expect("fs/mod.rs must declare `pub mod ssh_pool;`");
    let before = &code[..at];
    let attr = before
        .rfind("#[cfg(feature = \"provider-ssh\")]")
        .expect("ssh_pool must be gated on provider-ssh");
    assert!(
        !before[attr..].contains("mod "),
        "the cfg attribute must sit directly on `pub mod ssh_pool;`"
    );
}

/// f2. 契約 1 の配線: `Session` が `PooledConnection` を実装し、`is_closed()` を Handle に問う。
#[test]
fn session_is_a_pooled_connection_backed_by_handle_is_closed() {
    let code = ssh_code();
    let at = code
        .find("impl PooledConnection for Session")
        .expect("ssh.rs must `impl PooledConnection for Session`");
    let body = balanced(&code, at, '{', '}');
    let (_, is_closed_body) = function_parts(body, "is_closed");
    assert!(
        is_closed_body.contains(".is_closed()"),
        "Session::is_closed must delegate to the russh Handle's is_closed(): {is_closed_body}"
    );
}

/// f3. `SshProvider` の保持は `ConnectionPool<…>`(旧 `Mutex<HashMap<…>>` は撤去)。
#[test]
fn ssh_provider_holds_a_connection_pool() {
    let code = ssh_code();
    let at = code
        .find("struct SshProvider")
        .expect("ssh.rs defines SshProvider");
    let body = balanced(&code, at, '{', '}');
    assert!(
        body.contains("ConnectionPool<"),
        "SshProvider must keep its sessions in a ConnectionPool: {body}"
    );
    assert!(
        !body.contains("HashMap<"),
        "the hand-rolled HashMap cache must be gone (the pool replaces it): {body}"
    );
}

/// f4. `list` / `stat` / `read_bytes` の本体が入れ物の `run(` を通る(契約 2 が3操作に効く)。
#[test]
fn list_stat_read_bytes_go_through_the_pool_run() {
    let code = ssh_code();
    for name in ["list", "stat", "read_bytes"] {
        let (_, body) = function_parts(&code, name);
        assert!(
            body.contains(".run("),
            "SshProvider::{name} must perform its SFTP operation through ConnectionPool::run: {body}"
        );
        assert!(
            !body.contains("sftp_to_fs"),
            "SshProvider::{name} must classify errors (classify_sftp_error), not map them straight to FsError: {body}"
        );
    }
}

/// f5. `read_bytes` の `read_to_end` の失敗は「切断」として写す(契約 3 末尾)。
#[test]
fn read_bytes_classifies_read_to_end_errors_as_disconnection() {
    let code = ssh_code();
    let (_, body) = function_parts(&code, "read_bytes");
    assert!(body.contains("read_to_end"), "read_bytes still reads the whole file: {body}");
    assert!(
        body.contains("classify_io_error"),
        "the read_to_end error must go through classify_io_error: {body}"
    );
    assert!(
        !body.contains("FsError::Io"),
        "read_bytes must not map the read error straight to FsError::Io (that bypasses the retry): {body}"
    );
}

/// f6. 契約 5: ポーリング本体が `Arc<SftpSession>` を引数で受け取って握り続ける形ではない。
#[test]
fn no_function_takes_an_sftp_session_by_arc() {
    let code = ssh_code();
    let offenders: Vec<_> = all_functions(&code)
        .into_iter()
        .filter(|(_, params)| params.replace(' ', "").contains("Arc<SftpSession>"))
        .collect();
    assert!(
        offenders.is_empty(),
        "no function may hold an Arc<SftpSession> across poll rounds: {offenders:?}"
    );
}

/// f7. 契約 5: `POLL_INTERVAL` で待つ周回の中で、毎周 入れ物から取り出し(`.run(` / `.get(`)、
///     `poll_step(` で判定する。
#[test]
fn poll_loop_reacquires_the_connection_every_round_and_uses_poll_step() {
    let code = ssh_code();
    let loops: Vec<&str> = code
        .match_indices("loop {")
        .map(|(i, _)| balanced(&code, i, '{', '}'))
        .collect();
    let poll_loops: Vec<&&str> = loops.iter().filter(|b| b.contains("POLL_INTERVAL")).collect();
    assert_eq!(
        poll_loops.len(),
        1,
        "exactly one polling loop waits on POLL_INTERVAL: found {}",
        poll_loops.len()
    );
    let body = poll_loops[0];
    assert!(
        body.contains(".run(") || body.contains(".get("),
        "the polling loop must take the connection out of the pool every round: {body}"
    );
    assert!(
        body.contains("poll_step("),
        "the polling loop must decide events with poll_step: {body}"
    );
}

/// f8. `watch` は `tokio::spawn` で周回を起こし、その周回には接続ではなく入れ物(または
///     provider)を渡す。
#[test]
fn watch_spawns_the_poll_without_handing_it_a_session() {
    let code = ssh_code();
    let (_, body) = function_parts(&code, "watch");
    assert!(body.contains("tokio::spawn("), "watch still runs the poll in a task: {body}");
    assert!(
        !body.contains("self.sftp(") && !body.contains("SftpSession"),
        "watch must not fetch a session up front and pass it into the poll: {body}"
    );
}

/// f9. モジュール冒頭の「reconnect は後続(follow-up)」の先送りの記述が消えている。
#[test]
fn module_doc_no_longer_defers_reconnect() {
    let doc: Vec<&str> = SSH_RS
        .lines()
        .filter(|l| l.trim_start().starts_with("//!"))
        .collect();
    assert!(!doc.is_empty(), "ssh.rs keeps a module doc");
    let joined = doc.join(" ").to_lowercase();
    let deferral = ["follow-up", "follow up", "later", "deferred", "todo"];
    for sentence in joined.split(['.', ';']) {
        if sentence.contains("reconnect") {
            assert!(
                !deferral.iter().any(|d| sentence.contains(d)),
                "the module doc must not defer reconnect to a follow-up any more: `{sentence}`"
            );
        }
    }
}
