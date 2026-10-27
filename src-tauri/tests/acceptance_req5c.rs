//! 要件#5 追補c の受け入れテスト(docs/requirements/req-05.md「追補c」・Issue #628 = backlog 262)
//!
//! 「ssh の接続が切れている間、監視のポーリングが 2 秒ごとに開き直しを試み続ける」
//! (2026-10-04 追補a の reviewer P3・2026-10-19 /goal「issueの#656, #592, #628を修正して」)
//!
//! 契約(追補c):
//! 1. 切断中は待ち時間を延ばす: 周回の結果が「切断」(開き直しの失敗を含む)なら次の待ち時間を
//!    直前の 2 倍にする(2 → 4 → 8 → 16 → 32 → 60・上限 60 秒)。切断でない(成功・サーバーが
//!    答えたエラー)なら 2 秒に戻す。決め方は純関数
//! 2. 同じホストの開き直しは1回にまとめる: 入れ物は、同じキーを誰かが開いている間に来た取り出しを
//!    自分では開かずにその結果を待たせる(何人来ても開くのは1回)。開けなかったら待っていた全員に
//!    その失敗を返す(それぞれが開き直さない)。別のキーは互いに待たない
//! 3. `ssh -G` をワーカーで直に動かさない: `ssh_g` の呼び出しは `spawn_blocking`(または
//!    `tokio::process`)を通す
//! 4. 不変: 1ホスト1接続・生存の確かめと切断で1回だけやり直す(追補a)・`poll_step` の判定・
//!    最初の stat は待たずに取る(追補b)・停止の合図は待機の `select!` で見る・FsError の文言
//!
//! 本ファイルの持ち場(AC-5-追c の (a)〜(c)。実 sshd は使わない):
//! - (a) `next_poll_delay` の純関数判定(定数 `POLL_INTERVAL` / `POLL_INTERVAL_MAX` を含む)
//! - (b) `ConnectionPool<C>` の「まとめて開く」を偽の接続(`FakeConn`)で判定
//! - (c) `ssh.rs` のソース走査(配線)
//! - (d) は `acceptance_req5b.rs` の (a) を追補c に合わせた最小の直しで表す(本ファイル外)
//!
//! ## 確定契約(公開 API・implementer はこれに従う)
//!
//! ```ignore
//! // src-tauri/src/fs/ssh.rs
//!
//! /// つながっているときの周回の間隔(従来の private const を公開にする。値は 2 秒で不変)。
//! pub const POLL_INTERVAL: Duration = Duration::from_secs(2);
//! /// 切断中に延ばす待ち時間の上限。
//! pub const POLL_INTERVAL_MAX: Duration = Duration::from_secs(60);
//!
//! /// 次の周回までの待ち時間(契約 1・純関数)。
//! /// - `prev`    = 直前の周回の前に待った時間(最初の周回では `POLL_INTERVAL`)
//! /// - `outcome` = 今回の周回の結果(`poll_step` に渡すものと同じ。借用で受け取る)
//! /// - `Ok(_)`・`Err(OpError::Failed(_))`        → `POLL_INTERVAL`(2 秒に戻す)
//! /// - `Err(OpError::Disconnected(_))`           → `min(prev * 2, POLL_INTERVAL_MAX)`
//! ///   (開き直しの失敗も `Disconnected` 側=追補a 答え2 なので同じく延びる)
//! pub fn next_poll_delay(prev: Duration, outcome: &Result<PollSnapshot, OpError>) -> Duration;
//!
//! // src-tauri/src/fs/ssh_pool.rs — 公開 API は追補a のまま(シグネチャ不変)。振る舞いの追加:
//! //   `get` / `run`: 同じ key を他の呼び手が開いている最中に来た取り出しは、自分では `open` を
//! //   呼ばずにその結果を待つ。成功なら同じ Arc<C> を受け取り、失敗なら待っていた全員が
//! //   「その失敗」(同じ FsError の内容=Display が同じ)を受け取る(入れ物には何も入らない。
//! //   その後の取り出しは改めて開きに行く)。別の key の取り出しは待たされない。
//! //   (implementer は必要なら F / Fut / Op / OpFut / T に Send 境界を足してよい。
//! //    本テストのクロージャと future はすべて Send)
//!
//! // src-tauri/src/fs/ssh.rs の配線(ソース走査 (c) が見るもの)
//! // - `poll_loop` の唯一の `loop { … }` の中で `next_poll_delay(` を呼び、その値で待つ
//! //   (`tokio::time::sleep(POLL_INTERVAL)` のように `POLL_INTERVAL` を直に待たない)
//! // - 待機は今までどおり `tokio::select!` で `stop_rx` と一緒に見る
//! // - `ssh_g(` の呼び出しは `spawn_blocking(` の括弧の中にある。または `ssh_g` 自身が
//! //   `tokio::process` で動き、`std::process::Command` を使わない
//! ```
//!
//! ## 修正前の見込み
//! - (a)(c) は `next_poll_delay` / `POLL_INTERVAL_MAX` が無く、`POLL_INTERVAL` が private なので
//!   コンパイルが落ちる(赤)。スタブを置いても (a) は値で赤・(c) は `poll_loop` が
//!   `sleep(POLL_INTERVAL)` を直に待ち `ssh_g(` が `spawn_blocking` の外にあるので赤
//! - (b) は今の入れ物が呼び手ごとに開く(追補a 答え4)ので、同時 8 件で open が 8 回になり赤。
//!   別キーの並行(b6)は今でも緑(過度に直列化した実装への歯止め)
//!
//! ## reviewer 照合に委ねるもの(機械判定しにくい配線)
//! - `next_poll_delay` に渡す `prev` が実際に直前の待ち時間であること(初期値 `POLL_INTERVAL`)
//! - `spawn_blocking` の結果を `.await` していること・`JoinError` の扱い
//! - 1ホスト1接続・切断で1回だけやり直す(追補a)が、まとめて開く変更で崩れていないこと
//!   (`acceptance_req5a.rs` の緑で機械的にも見る)

#![cfg(feature = "provider-ssh")]

use std::future::{ready, Future, Ready};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use vellis_lib::errors::FsError;
use vellis_lib::fs::ssh::{next_poll_delay, PollSnapshot, POLL_INTERVAL, POLL_INTERVAL_MAX};
use vellis_lib::fs::ssh_pool::{ConnectionPool, OpError, PooledConnection};

// ---------------------------------------------------------------------------
// (a) 待ち時間(純関数)
// ---------------------------------------------------------------------------

fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

fn snap(size: u64, mtime_secs: u64) -> PollSnapshot {
    (Some(size), Some(UNIX_EPOCH + Duration::from_secs(mtime_secs)))
}

fn ok() -> Result<PollSnapshot, OpError> {
    Ok(snap(10, 1_700_000_000))
}

fn server_error() -> Result<PollSnapshot, OpError> {
    Err(OpError::Failed(FsError::NotFound("No such file".into())))
}

fn disconnected() -> Result<PollSnapshot, OpError> {
    Err(OpError::Disconnected(FsError::Io(std::io::Error::other(
        "session closed",
    ))))
}

fn reopen_failed() -> Result<PollSnapshot, OpError> {
    Err(OpError::Disconnected(FsError::PermissionDenied(
        "no key accepted by user@host".into(),
    )))
}

/// a1. 定数: つながっているときの間隔は 2 秒(不変)・上限は 60 秒。
#[test]
fn ac5c_a_poll_interval_is_two_seconds_and_the_cap_is_sixty() {
    assert_eq!(POLL_INTERVAL, secs(2), "POLL_INTERVAL stays 2 s (contract 4)");
    assert_eq!(POLL_INTERVAL_MAX, secs(60), "the backoff cap is 60 s (contract 1)");
}

/// a2. 切断が続くと 2・4・8・16・32・60・60 秒(2 から倍々・60 で頭打ち)。
#[test]
fn ac5c_a_consecutive_disconnections_double_the_delay_up_to_sixty() {
    let mut delay = POLL_INTERVAL;
    let mut seen = vec![delay];
    for _ in 0..6 {
        delay = next_poll_delay(delay, &disconnected());
        seen.push(delay);
    }
    assert_eq!(
        seen,
        vec![secs(2), secs(4), secs(8), secs(16), secs(32), secs(60), secs(60)],
        "the delay climbs 2 → 4 → 8 → 16 → 32 → 60 and stays at 60 while the disconnection lasts"
    );
}

/// a3. 上限: 2 倍が 60 秒を超える値からは 60 秒(64 にならない)・60 からは 60 のまま。
#[test]
fn ac5c_a_delay_never_exceeds_the_cap() {
    assert_eq!(next_poll_delay(secs(32), &disconnected()), secs(60), "32 × 2 = 64 is capped to 60");
    assert_eq!(next_poll_delay(secs(40), &disconnected()), secs(60));
    assert_eq!(next_poll_delay(secs(59), &disconnected()), secs(60));
    assert_eq!(next_poll_delay(secs(60), &disconnected()), secs(60), "stays at the cap");
    assert_eq!(next_poll_delay(POLL_INTERVAL_MAX, &disconnected()), POLL_INTERVAL_MAX);
}

/// a4. 成功が来たら、どこまで延びていても 2 秒に戻る。
#[test]
fn ac5c_a_success_resets_to_two_seconds() {
    for prev in [2u64, 4, 8, 16, 32, 60] {
        assert_eq!(
            next_poll_delay(secs(prev), &ok()),
            POLL_INTERVAL,
            "a successful round resets the delay from {prev} s to 2 s"
        );
    }
}

/// a5. サーバーが答えたエラー(`Failed`・Remove を送る側)でも 2 秒に戻る(切断ではない)。
#[test]
fn ac5c_a_server_answered_error_resets_to_two_seconds() {
    for prev in [2u64, 4, 8, 16, 32, 60] {
        assert_eq!(
            next_poll_delay(secs(prev), &server_error()),
            POLL_INTERVAL,
            "a server-answered error is not a disconnection: the delay goes back to 2 s from {prev} s"
        );
    }
}

/// a6. 開き直しの失敗(接続できない理由を `Disconnected` で運ぶ=追補a 答え2)も切断として延びる。
#[test]
fn ac5c_a_reopen_failure_counts_as_a_disconnection() {
    assert_eq!(next_poll_delay(secs(2), &reopen_failed()), secs(4));
    assert_eq!(next_poll_delay(secs(16), &reopen_failed()), secs(32));
    assert_eq!(next_poll_delay(secs(60), &reopen_failed()), secs(60));
}

/// a7. 途中で戻ったあとは、また 2 から登り直す(直前の高さを覚えていない)。
#[test]
fn ac5c_a_climb_restarts_from_two_after_a_recovery() {
    let steps: [(fn() -> Result<PollSnapshot, OpError>, u64); 12] = [
        (disconnected, 4),
        (disconnected, 8),
        (disconnected, 16),
        (ok, 2),
        (disconnected, 4),
        (server_error, 2),
        (disconnected, 4),
        (reopen_failed, 8),
        (disconnected, 16),
        (disconnected, 32),
        (disconnected, 60),
        (ok, 2),
    ];
    let mut delay = POLL_INTERVAL;
    for (i, (outcome, expected)) in steps.iter().enumerate() {
        delay = next_poll_delay(delay, &outcome());
        assert_eq!(delay, secs(*expected), "step {i}: expected {expected} s, got {delay:?}");
    }
}

/// a8. 純関数: 同じ入力には同じ出力(呼ぶ順や回数に依らない)。
#[test]
fn ac5c_a_next_poll_delay_is_pure() {
    let first = next_poll_delay(secs(8), &disconnected());
    for _ in 0..5 {
        assert_eq!(next_poll_delay(secs(8), &disconnected()), first);
        assert_eq!(next_poll_delay(secs(8), &ok()), POLL_INTERVAL);
    }
    assert_eq!(first, secs(16));
}

// ---------------------------------------------------------------------------
// 偽の接続とフィクスチャ((b) 用)
// ---------------------------------------------------------------------------

/// 偽の接続。`closed` は外から切り替えられる。Drop で `dropped` を数える
/// (重複して開いた接続が捨てられた=まとめられなかった、ことを見る)。
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

type BoxOpen = Pin<Box<dyn Future<Output = Result<FakeConn, FsError>> + Send>>;

/// `open` に入った回数(`started`)と、開き終えた回数(`opens`)を数える開き手。
#[derive(Default)]
struct Opener {
    started: AtomicUsize,
    opens: AtomicUsize,
    dropped: Arc<AtomicUsize>,
    /// true のあいだ `open` は PermissionDenied で失敗する(接続できない理由)。
    fail: AtomicBool,
}

impl Opener {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    fn started(&self) -> usize {
        self.started.load(Ordering::SeqCst)
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
    /// 即時に完了する `open`。
    fn open(self: &Arc<Self>) -> impl Fn() -> Ready<Result<FakeConn, FsError>> {
        let me = self.clone();
        move || {
            me.started.fetch_add(1, Ordering::SeqCst);
            ready(me.open_now())
        }
    }
    /// 数回 yield してから完了する `open`(同時に来た取り出しが「開いている最中」に重なる)。
    fn open_slow(self: &Arc<Self>) -> impl Fn() -> BoxOpen + Send + Sync + 'static {
        let me = self.clone();
        move || {
            let me = me.clone();
            me.started.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                for _ in 0..3 {
                    tokio::task::yield_now().await;
                }
                me.open_now()
            })
        }
    }
    /// `gate` が true になるまで完了しない `open`(別キーが待たされないことの確認用)。
    fn open_gated(
        self: &Arc<Self>,
        gate: tokio::sync::watch::Receiver<bool>,
    ) -> impl Fn() -> BoxOpen + Send + Sync + 'static {
        let me = self.clone();
        move || {
            let me = me.clone();
            let mut gate = gate.clone();
            me.started.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                gate.wait_for(|open| *open).await.expect("the gate sender outlives the open");
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

fn disconnected_op_error() -> OpError {
    OpError::Disconnected(FsError::Io(std::io::Error::other("session closed")))
}

const KEY: &str = "user@host:22";
const OTHER_KEY: &str = "user@other:2222";
const N: usize = 8;

/// `N` 個のタスクで同時に `get(KEY, open_slow)` を呼び、結果を到着順に集める。
/// (現行スレッドの runtime: 各タスクは `open` の最初の yield で止まるので、どれかが開き終える
/// 前に全員が「開いている最中」に重なる)
async fn concurrent_gets(
    pool: &Arc<ConnectionPool<FakeConn>>,
    opener: &Arc<Opener>,
    key: &'static str,
) -> Vec<Result<Arc<FakeConn>, FsError>> {
    let handles: Vec<_> = (0..N)
        .map(|_| {
            let pool = pool.clone();
            let open = opener.open_slow();
            tokio::spawn(async move { pool.get(key, open).await })
        })
        .collect();
    let mut out = Vec::with_capacity(N);
    for h in handles {
        out.push(h.await.expect("get task does not panic"));
    }
    out
}

// ---------------------------------------------------------------------------
// (b) まとめて開く(偽の接続)
// ---------------------------------------------------------------------------

/// b1. 同じキーで同時に 8 件取り出すと、開くのは 1 回で全員が同じ接続を受け取る
///     (重複して開いて捨てる、もしない)。
#[tokio::test]
async fn ac5c_b_concurrent_gets_on_one_key_open_once_and_share_the_connection() {
    let opener = Opener::new();
    let pool: Arc<ConnectionPool<FakeConn>> = Arc::new(ConnectionPool::new());

    let results = concurrent_gets(&pool, &opener, KEY).await;
    let conns: Vec<Arc<FakeConn>> = results
        .into_iter()
        .map(|r| r.expect("every waiter receives the connection"))
        .collect();
    assert_eq!(conns.len(), N);
    for c in &conns[1..] {
        assert!(Arc::ptr_eq(&conns[0], c), "all {N} callers must receive the same connection");
    }
    assert_eq!(opener.started(), 1, "only one caller may enter `open` for the same key");
    assert_eq!(opener.opens(), 1, "open exactly once for {N} concurrent callers");
    assert_eq!(opener.dropped(), 0, "no duplicate connection was opened and thrown away");
    let cached = pool.cached(KEY).await.expect("the one connection is kept");
    assert!(Arc::ptr_eq(&cached, &conns[0]));
}

/// b2. `run` でも同じ: 空の入れ物に同時 8 件の操作が来ても開くのは 1 回で、全操作が同じ接続で走る。
#[tokio::test]
async fn ac5c_b_concurrent_runs_on_one_key_open_once() {
    let opener = Opener::new();
    let log = OpLog::new();
    let pool: Arc<ConnectionPool<FakeConn>> = Arc::new(ConnectionPool::new());

    let handles: Vec<_> = (0..N)
        .map(|_| {
            let pool = pool.clone();
            let open = opener.open_slow();
            let log = log.clone();
            tokio::spawn(async move {
                pool.run(KEY, open, move |c: Arc<FakeConn>| {
                    let log = log.clone();
                    async move {
                        log.record(&c);
                        Ok::<usize, OpError>(c.id)
                    }
                })
                .await
            })
        })
        .collect();
    let mut ids = Vec::with_capacity(N);
    for h in handles {
        ids.push(h.await.unwrap().expect("every operation succeeds"));
    }
    assert!(ids.iter().all(|id| *id == ids[0]), "all operations ran on one connection: {ids:?}");
    assert_eq!(opener.opens(), 1, "open exactly once for {N} concurrent operations");
    assert_eq!(log.calls(), N, "each operation ran exactly once");
    assert_eq!(opener.dropped(), 0);
}

/// b3. 開くのが失敗するとき: 開く試みは 1 回で、待っていた全員がその失敗を受け取る
///     (それぞれが開き直さない)。入れ物には何も入らない。
#[tokio::test]
async fn ac5c_b_concurrent_gets_share_one_failed_open() {
    let opener = Opener::new();
    opener.set_fail(true);
    let pool: Arc<ConnectionPool<FakeConn>> = Arc::new(ConnectionPool::new());

    let results = concurrent_gets(&pool, &opener, KEY).await;
    assert_eq!(results.len(), N);
    for (i, r) in results.iter().enumerate() {
        let err = r.as_ref().err().unwrap_or_else(|| panic!("caller {i} must receive the failure"));
        assert_eq!(
            err.to_string(),
            "permission denied: no key accepted by user@host (open #1)",
            "caller {i} must receive the failure of the one open attempt"
        );
    }
    assert_eq!(opener.started(), 1, "only one caller may enter `open`");
    assert_eq!(opener.opens(), 1, "exactly one open attempt for {N} concurrent callers");
    assert!(pool.cached(KEY).await.is_none(), "nothing is kept after a failed open");
}

/// b4. まとめて失敗したあと、次に来た取り出しは改めて開きに行ける(失敗を覚え込まない)。
#[tokio::test]
async fn ac5c_b_a_later_get_opens_again_after_a_shared_failure() {
    let opener = Opener::new();
    opener.set_fail(true);
    let pool: Arc<ConnectionPool<FakeConn>> = Arc::new(ConnectionPool::new());
    let results = concurrent_gets(&pool, &opener, KEY).await;
    assert!(results.iter().all(|r| r.is_err()));
    assert_eq!(opener.opens(), 1);

    opener.set_fail(false);
    let c = pool.get(KEY, opener.open()).await.expect("the host is reachable again");
    assert_eq!(opener.opens(), 2, "the next caller opens afresh");
    assert_eq!(c.id, 2);
    let cached = pool.cached(KEY).await.expect("the new connection is kept");
    assert!(Arc::ptr_eq(&cached, &c));
}

/// b5. 閉じた接続の開き直しもまとめる(Issue #628 の場面: 切断に気づいた監視が一斉に開き直す)。
///     開くのは合計 2 回(最初の 1 回 + 開き直し 1 回)で、全員が同じ新しい接続を受け取る。
#[tokio::test]
async fn ac5c_b_concurrent_reopens_of_a_closed_connection_open_once() {
    let opener = Opener::new();
    let pool: Arc<ConnectionPool<FakeConn>> = Arc::new(ConnectionPool::new());
    let a = pool.get(KEY, opener.open()).await.unwrap();
    a.closed.store(true, Ordering::SeqCst);
    assert_eq!(opener.opens(), 1);

    let results = concurrent_gets(&pool, &opener, KEY).await;
    let conns: Vec<Arc<FakeConn>> = results
        .into_iter()
        .map(|r| r.expect("every waiter receives the reopened connection"))
        .collect();
    for c in &conns {
        assert!(!Arc::ptr_eq(c, &a), "the closed connection must not be handed out");
        assert!(Arc::ptr_eq(c, &conns[0]), "all callers share the one reopened connection");
    }
    assert_eq!(opener.opens(), 2, "first open + exactly one reopen for {N} concurrent callers");
    let cached = pool.cached(KEY).await.expect("the reopened connection is kept");
    assert!(Arc::ptr_eq(&cached, &conns[0]));
}

/// b6. 別のキーは並行に開ける: 片方の `open` を止めておいても、もう片方の取り出しは完了する
///     (待たされたらタイムアウトで赤)。
#[tokio::test]
async fn ac5c_b_another_key_opens_while_one_key_is_still_opening() {
    let opener = Opener::new();
    let pool: Arc<ConnectionPool<FakeConn>> = Arc::new(ConnectionPool::new());
    let (gate_tx, gate_rx) = tokio::sync::watch::channel(false);

    let blocked = tokio::spawn({
        let pool = pool.clone();
        let open = opener.open_gated(gate_rx);
        async move { pool.get(KEY, open).await }
    });
    // 止めた側が `open` に入るまで進める。
    for _ in 0..3 {
        tokio::task::yield_now().await;
    }
    assert_eq!(opener.started(), 1, "the first key is in the middle of its open");
    assert_eq!(opener.opens(), 0);

    let other = tokio::time::timeout(Duration::from_secs(2), pool.get(OTHER_KEY, opener.open()))
        .await
        .expect("another key must not wait for the first key's open (contract 2)")
        .expect("the other key opens");
    assert_eq!(opener.opens(), 1, "the other key opened while the first key is still opening");
    assert!(!blocked.is_finished(), "the first key is still waiting on its own open");
    let cached_other = pool.cached(OTHER_KEY).await.expect("the other key is kept");
    assert!(Arc::ptr_eq(&cached_other, &other));

    gate_tx.send(true).expect("release the first key's open");
    let first = blocked.await.unwrap().expect("the first key opens once released");
    assert_eq!(opener.opens(), 2);
    assert!(!Arc::ptr_eq(&first, &other), "keys are independent connections");
    let cached_first = pool.cached(KEY).await.expect("the first key is kept");
    assert!(Arc::ptr_eq(&cached_first, &first));
}

/// b7. 同じ死んだ接続で 8 件の操作が同時に切断に気づいても、開き直しは 1 回にまとまり
///     (開くのは合計 2 回)、全員のやり直しが同じ新しい接続で成功する。やり直しは各 1 回のまま
///     (追補a 契約 2 不変)。
#[tokio::test]
async fn ac5c_b_concurrent_disconnections_reopen_once_and_retry_on_the_shared_connection() {
    let opener = Opener::new();
    let log = OpLog::new();
    let pool: Arc<ConnectionPool<FakeConn>> = Arc::new(ConnectionPool::new());
    let a = pool.get(KEY, opener.open()).await.unwrap();
    let dead_id = a.id;
    drop(a);

    let handles: Vec<_> = (0..N)
        .map(|_| {
            let pool = pool.clone();
            let open = opener.open_slow();
            let log = log.clone();
            tokio::spawn(async move {
                pool.run(KEY, open, move |c: Arc<FakeConn>| {
                    let log = log.clone();
                    async move {
                        // 死んだ接続での操作は少し時間がかかってから切断に気づく。
                        tokio::task::yield_now().await;
                        log.record(&c);
                        if c.id == dead_id {
                            Err(disconnected_op_error())
                        } else {
                            Ok::<usize, OpError>(c.id)
                        }
                    }
                })
                .await
            })
        })
        .collect();
    let mut ids = Vec::with_capacity(N);
    for h in handles {
        ids.push(h.await.unwrap().expect("every operation recovers on the reopened connection"));
    }
    assert!(ids.iter().all(|id| *id == ids[0]), "all retries used the one live connection: {ids:?}");
    assert_ne!(ids[0], dead_id);
    assert_eq!(opener.opens(), 2, "the dead connection + exactly one shared reopen");
    let cached = pool.cached(KEY).await.expect("a live connection is kept");
    assert_eq!(cached.id, ids[0]);
    assert_eq!(
        log.ids().iter().filter(|id| **id == dead_id).count(),
        N,
        "each operation noticed the disconnection exactly once: {:?}",
        log.ids()
    );
    assert_eq!(log.calls(), 2 * N, "each operation retried exactly once: {:?}", log.ids());
}

// ---------------------------------------------------------------------------
// (c) 配線(ソース走査)
// ---------------------------------------------------------------------------

const SSH_RS: &str = include_str!("../src/fs/ssh.rs");

/// 行ごとに `//` 以降(コメント)を落とす。`://` は落とさない(acceptance_req5a.rs と同じ)。
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

/// `from` 以降で最初に現れる `open` から、対応する `close` までを切り出す(acceptance_req5a.rs と同じ)。
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

/// `fn <name>` の (引数リスト, 本体)(acceptance_req5a.rs と同じ)。
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

fn offset_in(code: &str, part: &str) -> usize {
    part.as_ptr() as usize - code.as_ptr() as usize
}

/// `poll_loop` の本文と、その中の唯一の `loop { … }`(本体・`code` 内の絶対オフセット)。
fn polling_loop(code: &str) -> (&str, &str, usize) {
    let (_, poll_loop_body) = function_parts(code, "poll_loop");
    let poll_loop_start = offset_in(code, poll_loop_body);
    let loops: Vec<usize> = poll_loop_body
        .match_indices("loop {")
        .map(|(i, _)| poll_loop_start + i)
        .collect();
    assert_eq!(
        loops.len(),
        1,
        "poll_loop has exactly one `loop {{ … }}` (the polling round); found {}",
        loops.len()
    );
    let body = balanced(code, loops[0], '{', '}');
    (poll_loop_body, body, loops[0])
}

/// `body` 内の `needle(` の呼び出しごとに、その括弧の中身(引数の文字列)を返す。
fn call_arguments<'a>(body: &'a str, needle: &str) -> Vec<&'a str> {
    body.match_indices(needle)
        .map(|(i, _)| {
            let args = balanced(body, i + needle.len() - 1, '(', ')');
            &args[1..args.len() - 1]
        })
        .collect()
}

/// c1. `poll_loop` の周回は `next_poll_delay(` の値で待ち、`POLL_INTERVAL` を直に待たない。
#[test]
fn ac5c_c_poll_loop_waits_on_next_poll_delay_not_on_poll_interval() {
    let code = ssh_code();
    let (_, body, _) = polling_loop(&code);

    let run = body
        .find(".run(")
        .expect("the polling loop still takes the connection out of the pool with `.run(` (contract 4)");
    let next = body
        .find("next_poll_delay(")
        .expect("the polling loop must decide its wait with `next_poll_delay(` (contract 1)");
    assert!(
        run < next,
        "`next_poll_delay(` needs this round's outcome, so it comes after `.run(`; loop:\n{body}"
    );

    let sleeps = call_arguments(body, "sleep(");
    assert!(
        !sleeps.is_empty(),
        "the polling loop still waits with `tokio::time::sleep(` inside its `select!`; loop:\n{body}"
    );
    for args in &sleeps {
        let arg = args.trim();
        assert_ne!(
            arg, "POLL_INTERVAL",
            "the polling loop must not wait on `POLL_INTERVAL` directly (contract 1: the wait is \
             the value `next_poll_delay` returns); loop:\n{body}"
        );
        assert!(
            !arg.is_empty(),
            "the sleep takes the computed delay; loop:\n{body}"
        );
    }
    assert!(
        !body.contains("sleep(POLL_INTERVAL)"),
        "no `sleep(POLL_INTERVAL)` may remain in the polling loop; loop:\n{body}"
    );
}

/// c2. 待機は停止の合図と `select!` のまま(待ち時間が延びても停止は待たされない)。
///     `.run(` と `poll_step(` は今までどおり待機より前(追補b 不変)。
#[test]
fn ac5c_c_poll_loop_wait_still_selects_on_the_stop_signal() {
    let code = ssh_code();
    let (poll_loop_body, body, loop_at) = polling_loop(&code);

    let select_at = body
        .find("select!")
        .expect("the wait inside the loop goes through `select!` (contract 4); loop:\n{body}");
    let select_block = balanced(body, select_at, '{', '}');
    assert!(
        select_block.contains("stop_rx"),
        "the `select!` must still watch the stop signal (`stop_rx`); select:\n{select_block}"
    );
    assert!(
        select_block.contains("sleep("),
        "the `select!` must race the stop signal against the sleep; select:\n{select_block}"
    );
    let run = body.find(".run(").expect("`.run(` in the loop");
    let step = body.find("poll_step(").expect("`poll_step(` in the loop");
    assert!(run < select_at && step < select_at, "stat and decide before the wait (追補b); loop:\n{body}");

    // 周回の前では待たない(追補b 不変: 最初の stat は待たずに取る)。
    let poll_loop_start = offset_in(&code, poll_loop_body);
    let before_loop = &poll_loop_body[..loop_at - poll_loop_start];
    assert!(
        !before_loop.contains("select!") && !before_loop.contains("sleep("),
        "poll_loop must not wait before its loop (追補b); the body before the loop is:\n{before_loop}"
    );
}

/// c3. `ssh_g(` の呼び出しは `spawn_blocking(` の中にある(または `ssh_g` 自身が `tokio::process`
///     で動き、`std::process::Command` を使わない)。
#[test]
fn ac5c_c_ssh_g_does_not_block_the_async_worker() {
    let code = ssh_code();
    let (_, ssh_g_body) = function_parts(&code, "ssh_g");

    let imports_tokio_process = code.contains("use tokio::process");
    let ssh_g_is_async_process = ssh_g_body.contains("tokio::process::")
        || (imports_tokio_process
            && ssh_g_body.contains("Command::new(")
            && !ssh_g_body.contains("std::process::"));
    if ssh_g_is_async_process {
        assert!(
            !ssh_g_body.contains("std::process::Command"),
            "an async `ssh_g` must not still run `std::process::Command`; body:\n{ssh_g_body}"
        );
        return;
    }

    // 同期の `ssh_g` のまま: すべての呼び出しが `spawn_blocking(` の括弧の中にある。
    let blocking_ranges: Vec<(usize, usize)> = code
        .match_indices("spawn_blocking(")
        .map(|(i, m)| {
            let args = balanced(&code, i + m.len() - 1, '(', ')');
            let start = offset_in(&code, args);
            (start, start + args.len())
        })
        .collect();
    let call_sites: Vec<usize> = code
        .match_indices("ssh_g(")
        .map(|(i, _)| i)
        .filter(|&i| {
            let before = &code[..i];
            let prev = before.chars().last();
            !before.ends_with("fn ") && !prev.is_some_and(|c| c.is_alphanumeric() || c == '_')
        })
        .collect();
    assert!(
        !call_sites.is_empty(),
        "`open` still resolves the host through `ssh_g(` (contract 4: `ssh -G` resolution is unchanged)"
    );
    for at in call_sites {
        let line = code[..at].lines().count();
        assert!(
            blocking_ranges.iter().any(|(s, e)| *s <= at && at < *e),
            "the `ssh_g(` call at line {line} must run inside `tokio::task::spawn_blocking(` \
             (contract 3), not directly on the async worker"
        );
    }
}
