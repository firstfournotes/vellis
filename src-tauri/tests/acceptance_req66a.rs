//! 要件#66 追補a の受け入れテスト(docs/requirements/req-66.md「追補a」・backlog 321・322)— Rust 層
//!
//! 321: .* ON で行ごとに一致の文字列が違う式(`\w+` など)を大きなファイルに当てると、`ordinal` の
//! 数え直し(`JumpCounts::before_line`)が行数の2乗の時間になる。その間 `collect_hits` は打ち切りを
//! 確かめないので、語を打ち直しても前の走査がそのファイルを数え終えるまで止まらない。
//! 322: 全部 OFF の経路が regex を通らないことを固定するテストが無く、全部 OFF を regex の経路に
//! 流す変異が生き残った。
//! (323 は `acceptance_req66.rs` の `BROKEN` に `a)(?:b` を足すことで固定=契約6。324 はフロント。)
//!
//! 契約(追補a):
//! 1. 打ち切り(321): `collect_hits` は走査の打ち切り(`cancel`)を受け取り、regex を通る経路で、
//!    行の処理と `JumpCounts` の数え直しの途中で打ち切りを確かめる。確かめる間隔は高々 1,000 行
//!    (行の処理と数え直しで見た行を合わせて数える)。打ち切りが分かったら残りの行を見ずに戻り、
//!    走査は今の打ち切りと同じく `stopped: true` の要約で終わる(以後のファイルを読まない)。
//!    打ち切られなければ結果(path・line・text・`ordinal`・`matched`)は今と同じ
//! 2. 全部 OFF の経路(322): 全部 OFF のとき `collect_hits` は regex を通らず、行ごとの
//!    `to_lowercase` の部分一致と `seen` の数え方(要件#55 のまま)で数える。打ち切りの確認は
//!    全部 OFF の経路には足さない
//! 5. 不変: 結果の形と `ordinal` の数え方(契約6)・壊れた式の文言・command の順序
//!
//! 受け入れ基準 AC-66-追a(本ファイル= (a)(b)。(c) は `acceptance_req66.rs` の `BROKEN`・
//! (d) はフロント):
//!   (a) 打ち切り(321): 行ごとに違う語が当たる大きなファイルを .* ON の `\w+` で走査し、そのファイルを
//!       読み終えた時点から打ち切りが真になるようにすると、`stopped: true` で終わり、送られた一致が
//!       そのファイルの全行に届かない。打ち切らなければ同じファイルの結果は今と同じ(`ordinal` を
//!       含めて、テストの中で独立に数えた値と一致)
//!       → `ac66a_a_cancel_noticed_inside_a_big_regex_file_stops_the_scan_short`
//!       → `ac66a_a_without_cancel_the_big_regex_file_yields_the_same_hits_and_ordinals`
//!       → `ac66a_a_cancel_is_consulted_at_least_every_1000_lines_inside_the_file`(契約1 の間隔)
//!   (b) 全部 OFF の経路(322): ソース走査で、`collect_hits` の全部 OFF の分岐(`regex` が無いとき)が
//!       `to_lowercase()` と `.matches(` で数え、その分岐の中に `find_in_line` / `first_in_line` /
//!       `JumpCounts` / `cancel` が出ない
//!       → `ac66a_b_all_off_branch_of_collect_hits_counts_with_to_lowercase_and_matches_only`
//!
//! 受け入れ基準の補強(2026-10-11・同じ周回の reviewer の P2。実装は変えずテストを足して、(a)(b) で
//! 生き残った変異を固定する):
//!   (e) 全部 OFF は打ち切りを確かめない(契約2 の振る舞いの固定): 全部 OFF で数千行のファイル
//!       (当たる行と当たらない行を混ぜる)を走査すると、そのファイルを読み終えたあとに `cancel` は
//!       1 回も呼ばれない(regex の経路に流れると 1,000 行ごとに呼ばれて赤になる)
//!       → `ac66a_e_all_off_never_consults_cancel_after_reading_the_file`
//!   (f) 間隔は高々 1,000 行(契約1 の固定): .* ON で、
//!       (1) 1 行も当たらない N 行のファイルでは、読み終えたあとの `cancel` の回数が `floor(N / 1000)` 以上
//!       → `ac66a_f1_regex_no_match_file_consults_cancel_at_least_n_over_1000_times`
//!       (2) 毎行同じ語だけが当たる N 行のファイルでは、行の処理で N 行・数え直しで N−1 行(前の行を
//!       1 行ずつ足していく)を見るので、回数が `floor(2N / 1000) - 1` 以上
//!       → `ac66a_f2_regex_same_word_every_line_consults_cancel_at_least_2n_over_1000_minus_1_times`
//!   回数の上限は固定しない(確かめる回数が多いのは契約の範囲)。
//!   変異との対応の見込み: `QueryMatcher::new` の全部 OFF の早い return を外す → (e) が赤。
//!   行の処理の `tick` を消す → (f)(1) が赤((f)(2) も赤)。数え直しの `tick` を消す → (f)(2) が赤。
//!   `CANCEL_CHECK_LINES` を 1,000,000 に → (f)(1)(2) が赤。
//!
//! 修正前の見込み: (a) の打ち切りの 2 件は赤(今の `collect_hits` は打ち切りを確かめないので、
//! ファイルの全行の一致を送って `stopped: false` で終わり、ファイルを読んだあとに `cancel` を 1 回も
//! 呼ばない)。(a) の「打ち切らなければ同じ」は今の結果を固定するものなので緑。(b) は今の分岐が
//! そのままなので緑(全部 OFF の分岐に `first_in_line` や `cancel` を入れる変異を赤にする)。
//!
//! ## 本テストの組み立て
//!
//! - 打ち切りは時間に頼らない: モックの `FileProvider` が大きなファイルの `read_bytes` を返した時点で
//!   フラグを立て、`cancel` はそのフラグを返す。今の実装はそのあと `cancel` を見ないので、全行の一致を
//!   送って `stopped: false` で終わる(決定的に赤)
//! - 大きなファイル= [`LINES`] 行。各行は `u{i:05} u{(2i mod LINES):05}`(1 つ目の語が行ごとに違うので
//!   `\w+` の `matched` が行ごとに違い、`JumpCounts` が毎行 先頭から数え直す= 321 の形)。
//!   行数は debug ビルドでも打ち切らない側が 1 秒前後で終わる大きさにしてある(2 乗で効く)
//! - 独立の数え方: 語は全部 6 文字の固定長で空白区切りなので、「前の行にある J の重ならない出現」=
//!   「前の行の語のうち J と等しいもの」。語ごとの累計で数え、一部の行は素朴な `matches` でも照合する
//! - 経路は公開 API の `SearchScope::default().with_options(.* ON).search_in_folder_streaming`
//!   (`cancel` を渡せる)。`collect_hits` は非公開

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

use async_trait::async_trait;
use tokio::sync::mpsc;

use vellis_lib::errors::FsError;
use vellis_lib::fs::entry::{Entry, FileKind};
use vellis_lib::fs::provider::{FileProvider, WatchEvent, WatchHandle};
use vellis_lib::fs::uri::Uri;
use vellis_lib::search::{
    MatchOptions, SearchControl, SearchHit, SearchProgress, SearchScope, SearchSummary,
};

// ---------------------------------------------------------------------------
// 大きなファイル(321 の形)と独立に数えた期待値
// ---------------------------------------------------------------------------

const FILE_ROOT: &str = "file:///root";
const BIG: &str = "big.md";
/// 大きなファイルの行数。契約1 の間隔(高々 1,000 行)より十分に多く、2 乗の数え直しが debug でも
/// 1 秒前後で終わる大きさ。
const LINES: usize = 4_500;
/// 契約1 の「確かめる間隔は高々 1,000 行」。
const MAX_CHECK_INTERVAL: usize = 1_000;
const QUERY: &str = r"\w+";
const RX: MatchOptions = MatchOptions { match_case: false, whole_word: false, use_regex: true };

/// `i` 行目(0 始まり)の本文。1 つ目の語は行ごとに違う。2 つ目の語は別の行の 1 つ目の語と同じに
/// なるので、`ordinal` が 1 だけにならない。
fn line_text(i: usize) -> String {
    format!("u{i:05} u{:05}", (2 * i) % LINES)
}

fn big_content() -> String {
    let mut s = String::with_capacity(LINES * 14);
    for i in 0..LINES {
        s.push_str(&line_text(i));
        s.push('\n');
    }
    s
}

/// 要件#66 契約6 の数え方で、テストの中で独立に組んだ期待値(走査順・全行が当たる)。
/// J = その行で最初に当たった `\w+` = 1 つ目の語。`ordinal` = 1 + 前の行にある J の出現数
/// (+ 当たった行の最初の一致より前の部分の出現数= 0、一致は行頭だから)。
fn expected_hits(content: &str) -> Vec<SearchHit> {
    let lines: Vec<&str> = content.lines().collect();
    assert_eq!(lines.len(), LINES, "test setup: the big file has LINES lines");
    let mut seen_before: HashMap<&str, u32> = HashMap::new();
    let mut out = Vec::with_capacity(LINES);
    for (i, line) in lines.iter().enumerate() {
        let first = line.split(' ').next().expect("a line has a first word");
        assert_eq!(first.len(), 6, "test setup: fixed-width words");
        let ordinal = 1 + seen_before.get(first).copied().unwrap_or(0);
        out.push(SearchHit {
            path: BIG.to_string(),
            line: (i + 1) as u32,
            text: line.to_string(),
            ordinal,
            matched: Some(first.to_string()),
        });
        for word in line.split(' ') {
            *seen_before.entry(word).or_insert(0) += 1;
        }
    }
    // 一部の行は素朴な数え方(前の行を全部 `to_lowercase().matches(J)`)でも照合しておく。
    for i in (0..LINES).step_by(97) {
        let j = out[i].matched.as_deref().expect("matched is set");
        let naive: u32 = lines[..i].iter().map(|l| l.to_lowercase().matches(j).count() as u32).sum();
        assert_eq!(out[i].ordinal, 1 + naive, "test oracle: line {} counted two ways", i + 1);
    }
    assert!(
        out.iter().any(|h| h.ordinal > 1),
        "test setup: some ordinals must be greater than 1 so the count is really checked"
    );
    out
}

// ---------------------------------------------------------------------------
// モック FileProvider(acceptance_req66.rs の MockFs を 1 ファイルの木に絞ったもの)。
// 大きなファイルの `read_bytes` を返した時点で `read_done` を立てる。
// ---------------------------------------------------------------------------

struct BigFileFs {
    root: Uri,
    big: Uri,
    content: Vec<u8>,
    read_done: AtomicBool,
    list_calls: Mutex<Vec<String>>,
    read_calls: Mutex<Vec<String>>,
}

impl BigFileFs {
    fn new(content: &str) -> Self {
        let root = Uri::parse(FILE_ROOT).expect("root uri must parse");
        let big = root.with_path(root.path.join(BIG));
        Self {
            root,
            big,
            content: content.as_bytes().to_vec(),
            read_done: AtomicBool::new(false),
            list_calls: Mutex::new(Vec::new()),
            read_calls: Mutex::new(Vec::new()),
        }
    }

    fn entry(&self) -> Entry {
        Entry {
            uri: self.big.raw.clone(),
            name: BIG.to_string(),
            kind: FileKind::File,
            size: Some(self.content.len() as u64),
            modified: Some(1_700_000_000_000),
            link: None,
        }
    }

    fn read_done(&self) -> bool {
        self.read_done.load(Ordering::SeqCst)
    }

    fn list_calls(&self) -> Vec<String> {
        self.list_calls.lock().unwrap().clone()
    }

    fn read_calls(&self) -> Vec<String> {
        self.read_calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl FileProvider for BigFileFs {
    fn scheme(&self) -> &'static str {
        "file"
    }

    async fn list(&self, uri: &Uri) -> Result<Vec<Entry>, FsError> {
        let key = uri.path_str().to_string();
        self.list_calls.lock().unwrap().push(key.clone());
        if key == self.root.path_str() {
            Ok(vec![self.entry()])
        } else {
            Err(FsError::NotFound(key))
        }
    }

    async fn stat(&self, uri: &Uri) -> Result<Entry, FsError> {
        let key = uri.path_str().to_string();
        if key == self.big.path_str() {
            Ok(self.entry())
        } else {
            Err(FsError::NotFound(key))
        }
    }

    async fn read_bytes(&self, uri: &Uri) -> Result<Vec<u8>, FsError> {
        let key = uri.path_str().to_string();
        self.read_calls.lock().unwrap().push(key.clone());
        if key != self.big.path_str() {
            return Err(FsError::NotFound(key));
        }
        let bytes = self.content.clone();
        // ここから先が「そのファイルを読み終えた時点」。
        self.read_done.store(true, Ordering::SeqCst);
        Ok(bytes)
    }

    async fn write_text(&self, uri: &str, _content: &str) -> Result<(), FsError> {
        Err(FsError::Unsupported(format!("search must never write: {uri}")))
    }

    async fn watch(&self, _uri: &Uri, _tx: mpsc::Sender<WatchEvent>) -> Result<WatchHandle, FsError> {
        Err(FsError::Unsupported("watch unsupported in mock".into()))
    }
}

/// 走査 1 回分: sink に届いた一致(走査順)・sink の呼び出し回数・要約・
/// 大きなファイルを読み終えたあとに `cancel` が呼ばれた回数。
struct Run {
    sent: Vec<SearchHit>,
    sink_calls: usize,
    summary: SearchSummary,
    cancel_calls_after_read: usize,
}

/// `cancel_after_read` が真なら、大きなファイルを読み終えた時点から `cancel` が真を返す。
/// 偽なら `cancel` は常に偽(呼ばれた回数だけ数える)。(a) の形= .* ON の `\w+`。
async fn run(fs: &BigFileFs, cancel_after_read: bool) -> Run {
    run_with(fs, RX, QUERY, cancel_after_read).await
}

/// [`run`] の一般形: トグルと語を受ける((e)(f) は全部 OFF や当たらない語で走らせる)。
async fn run_with(fs: &BigFileFs, options: MatchOptions, query: &str, cancel_after_read: bool) -> Run {
    let calls_after_read = AtomicUsize::new(0);
    let cancel = || {
        let done = fs.read_done();
        if done {
            calls_after_read.fetch_add(1, Ordering::SeqCst);
        }
        cancel_after_read && done
    };
    let mut sent: Vec<SearchHit> = Vec::new();
    let mut sink_calls = 0usize;
    let mut sink = |p: SearchProgress| {
        sink_calls += 1;
        sent.extend(p.hits);
        SearchControl::Continue
    };
    // `search_in_folder_streaming` は打ち切り `cancel` を受け取る公開 API。
    let summary = SearchScope::default()
        .with_options(options)
        .search_in_folder_streaming(fs, &fs.root, query, &mut sink, &cancel)
        .await
        .unwrap_or_else(|e| panic!("the scan of the big file must not fail: {e}"));
    assert!(fs.read_done(), "test setup: the big file must have been read");
    assert_eq!(fs.read_calls(), vec![fs.big.path_str().to_string()], "the big file is read once");
    assert_eq!(fs.list_calls(), vec![fs.root.path_str().to_string()], "only the root is listed");
    Run { sent, sink_calls, summary, cancel_calls_after_read: calls_after_read.load(Ordering::SeqCst) }
}

// ---------------------------------------------------------------------------
// (a) 打ち切り(321)
// ---------------------------------------------------------------------------

/// 大きなファイルを読み終えた時点から打ち切りが真: `stopped: true` で終わり、送られた一致が全行に
/// 届かない(送られた分があれば、打ち切らない場合の結果の先頭部分と同じ)。
#[tokio::test]
async fn ac66a_a_cancel_noticed_inside_a_big_regex_file_stops_the_scan_short() {
    let content = big_content();
    let expected = expected_hits(&content);
    let fs = BigFileFs::new(&content);

    let r = run(&fs, true).await;

    assert!(
        r.summary.stopped,
        "the scan must end with `stopped: true` once the cancel is noticed inside the big file \
         (contract 1); summary: {:?}, sent {} hits in {} sink calls",
        r.summary,
        r.sent.len(),
        r.sink_calls
    );
    assert!(
        r.sent.len() < LINES,
        "the hits handed to the sink must stop short of the file's {LINES} lines (contract 1: the \
         remaining lines are not looked at); got {} hits, summary {:?}",
        r.sent.len(),
        r.summary
    );
    assert_eq!(
        r.summary.total,
        r.sent.len(),
        "`total` counts the hits handed to the sink"
    );
    assert!(
        r.summary.total < LINES,
        "`total` must stop short of {LINES} too; summary {:?}",
        r.summary
    );
    assert_eq!(
        &r.sent[..],
        &expected[..r.sent.len()],
        "whatever was handed to the sink before the cancel must be the head of the uncancelled result"
    );
}

/// 打ち切らなければ、同じファイルの結果(path・line・text・`ordinal`・`matched`)は独立に数えた
/// 期待値と一致し、`stopped: false`・`total` = 行数。
#[tokio::test]
async fn ac66a_a_without_cancel_the_big_regex_file_yields_the_same_hits_and_ordinals() {
    let content = big_content();
    let expected = expected_hits(&content);
    let fs = BigFileFs::new(&content);

    let r = run(&fs, false).await;

    assert_eq!(
        r.summary,
        SearchSummary { total: LINES, files: 1, stopped: false },
        "an uncancelled scan of the big file reports every line and does not stop"
    );
    assert_eq!(r.sent.len(), expected.len(), "every line of the big file is a hit");
    for (got, want) in r.sent.iter().zip(expected.iter()) {
        assert_eq!(
            got, want,
            "line {}: the hit (path / line / text / ordinal / matched) must equal the independently \
             counted value (contract 1: results unchanged; contract 6: ordinal by J = matched)",
            want.line
        );
    }
    assert_eq!(r.sent, expected);
}

/// 契約1 の間隔: 打ち切らない走査でも、大きなファイル(`LINES` 行)を読み終えたあとに `cancel` が
/// 少なくとも `LINES / 1000` 回は呼ばれる(行の処理だけでも 1,000 行ごとに確かめる下限。
/// 数え直しで見た行も合わせて数える実装ならもっと多い)。
#[tokio::test]
async fn ac66a_a_cancel_is_consulted_at_least_every_1000_lines_inside_the_file() {
    let content = big_content();
    let fs = BigFileFs::new(&content);

    let r = run(&fs, false).await;

    let at_least = LINES / MAX_CHECK_INTERVAL;
    assert!(at_least >= 4, "test setup: the file is long enough to need several checks");
    assert!(
        r.cancel_calls_after_read >= at_least,
        "after the big file was read, `cancel` must be consulted at least every {MAX_CHECK_INTERVAL} \
         lines (contract 1), i.e. at least {at_least} times for {LINES} lines; it was consulted {} times",
        r.cancel_calls_after_read
    );
    assert!(!r.summary.stopped, "cancel always answered false, so the scan must not stop");
}

// ---------------------------------------------------------------------------
// 補強 (e)(f): 読み終えたあとの `cancel` の回数(契約1 の間隔・契約2 の「確かめない」)
// ---------------------------------------------------------------------------

/// (e)(f) のファイルの行数 N。契約1 の間隔(高々 1,000 行)の数倍で、`floor(N / 1000)` と
/// `floor(2N / 1000) - 1` が 1,000 の倍数のきわに乗らない値(5,500)。
const N_LINES: usize = 5_500;
const ALL_OFF: MatchOptions = MatchOptions { match_case: false, whole_word: false, use_regex: false };
/// (e)(f)(2) で当たる語。
const WORD: &str = "foo";
/// (f)(1) で 1 行も当たらない語(ファイルのどの行にも含まれない)。
const NEVER: &str = "zzz_never_matches";

/// (e) 当たる行と当たらない行を混ぜた N 行: 3 行に 1 行だけ `foo` を 1 つ含む。
fn mixed_content() -> String {
    let mut s = String::with_capacity(N_LINES * 24);
    for i in 0..N_LINES {
        if i % 3 == 0 {
            s.push_str(&format!("line {i:05} has {WORD} once\n"));
        } else {
            s.push_str(&format!("line {i:05} has nothing\n"));
        }
    }
    s
}

/// (f)(1) 1 行も当たらない N 行。
fn no_match_content() -> String {
    let mut s = String::with_capacity(N_LINES * 24);
    for i in 0..N_LINES {
        s.push_str(&format!("line {i:05} has nothing\n"));
    }
    s
}

/// (f)(2) 毎行同じ語 `foo` だけが 1 つ当たる N 行。
fn same_word_content() -> String {
    let mut s = String::with_capacity(N_LINES * 24);
    for i in 0..N_LINES {
        s.push_str(&format!("line {i:05} has {WORD} once\n"));
    }
    s
}

/// (e) 全部 OFF は打ち切りを確かめない(契約2): 当たる行と当たらない行を混ぜた N 行のファイルを
/// `MatchOptions::default()` で走査すると、読み終えたあとに `cancel` は 1 回も呼ばれない。
/// 全部 OFF を regex の経路に流す変異(`QueryMatcher::new` の早い return を外す)では、1,000 行ごとに
/// 呼ばれて赤になる。
#[tokio::test]
async fn ac66a_e_all_off_never_consults_cancel_after_reading_the_file() {
    assert_eq!(ALL_OFF, MatchOptions::default(), "test setup: ALL_OFF is the default (all toggles OFF)");
    let content = mixed_content();
    let fs = BigFileFs::new(&content);

    let r = run_with(&fs, ALL_OFF, WORD, false).await;

    // 走査が本当にファイルの全行を見たことを、結果の形(要件#55 の数え方)で押さえる。
    let matching_lines: Vec<usize> = (0..N_LINES).filter(|i| i % 3 == 0).collect();
    assert!(matching_lines.len() >= 1_000, "test setup: enough matching lines to span several 1,000-line intervals");
    assert_eq!(
        r.summary,
        SearchSummary { total: matching_lines.len(), files: 1, stopped: false },
        "an all-OFF scan of the mixed file reports every matching line and does not stop"
    );
    assert_eq!(r.sent.len(), matching_lines.len(), "every `foo` line of the mixed file is a hit");
    for (k, (got, &i)) in r.sent.iter().zip(matching_lines.iter()).enumerate() {
        assert_eq!(got.line, (i + 1) as u32, "hit {k}: line number");
        assert_eq!(got.ordinal, (k + 1) as u32, "hit {k}: ordinal = 1 + occurrences before (one per hit line)");
        assert_eq!(got.matched, None, "hit {k}: all OFF hands no `matched` (要件#66 契約)");
    }
    assert_eq!(
        r.cancel_calls_after_read, 0,
        "all OFF must not consult `cancel` at all after the file was read (contract 2: the all-OFF path \
         is the 要件#55 path without a cancel check); it was consulted {} times — the scan went through \
         the regex path",
        r.cancel_calls_after_read
    );
}

/// (f)(1) 間隔は高々 1,000 行(契約1): .* ON で 1 行も当たらない N 行のファイルを走査すると、読み終えた
/// あとの `cancel` の回数が `floor(N / 1000)` 以上(行の処理だけで N 行を見る)。行の処理の確認を消す
/// 変異・間隔を 1,000,000 行に広げる変異では 0 回になって赤。
#[tokio::test]
async fn ac66a_f1_regex_no_match_file_consults_cancel_at_least_n_over_1000_times() {
    let content = no_match_content();
    assert!(!content.contains(NEVER), "test setup: the query must not occur in the file");
    let fs = BigFileFs::new(&content);

    let r = run_with(&fs, RX, NEVER, false).await;

    assert_eq!(
        r.summary,
        SearchSummary { total: 0, files: 0, stopped: false },
        "nothing matches, and cancel always answered false, so the scan must not stop"
    );
    assert!(r.sent.is_empty(), "nothing matches");
    let at_least = N_LINES / MAX_CHECK_INTERVAL;
    assert!(at_least >= 5, "test setup: the file is long enough to need several checks");
    assert!(
        r.cancel_calls_after_read >= at_least,
        "after a {N_LINES}-line file with no match was read, `cancel` must be consulted at least every \
         {MAX_CHECK_INTERVAL} lines of line processing (contract 1), i.e. at least floor({N_LINES} / \
         {MAX_CHECK_INTERVAL}) = {at_least} times; it was consulted {} times",
        r.cancel_calls_after_read
    );
}

/// (f)(2) 間隔は高々 1,000 行(契約1): .* ON で毎行同じ語だけが当たる N 行のファイルを走査すると、
/// 行の処理で N 行・`ordinal` の数え直しで N−1 行(`JumpCounts::before_line` は前の行を 1 行ずつ足して
/// いく)を見るので、読み終えたあとの `cancel` の回数が `floor(2N / 1000) - 1` 以上。数え直しの確認を
/// 消す変異(N 行分= floor(N / 1000) 回)・間隔を広げる変異(0 回)では赤。
#[tokio::test]
async fn ac66a_f2_regex_same_word_every_line_consults_cancel_at_least_2n_over_1000_minus_1_times() {
    let content = same_word_content();
    let fs = BigFileFs::new(&content);

    let r = run_with(&fs, RX, WORD, false).await;

    // 走査が本当に全行を当てて数え直したことを、結果の形で押さえる(行 i の ordinal = i + 1)。
    assert_eq!(
        r.summary,
        SearchSummary { total: N_LINES, files: 1, stopped: false },
        "every line matches, and cancel always answered false, so the scan must not stop"
    );
    assert_eq!(r.sent.len(), N_LINES, "every line of the file is a hit");
    for (i, got) in r.sent.iter().enumerate() {
        assert_eq!(got.line, (i + 1) as u32, "hit {i}: line number");
        assert_eq!(got.ordinal, (i + 1) as u32, "hit {i}: ordinal = 1 + one `foo` per previous line");
        assert_eq!(got.matched.as_deref(), Some(WORD), "hit {i}: .* ON hands the matched text");
    }
    let at_least = (2 * N_LINES) / MAX_CHECK_INTERVAL - 1;
    assert!(at_least > N_LINES / MAX_CHECK_INTERVAL, "test setup: the bound exceeds what line processing alone gives");
    assert!(
        r.cancel_calls_after_read >= at_least,
        "after a {N_LINES}-line file matching `{WORD}` on every line was read, `cancel` must be consulted \
         at least every {MAX_CHECK_INTERVAL} lines counting line processing ({N_LINES}) and the ordinal \
         recount ({} lines) together (contract 1), i.e. at least floor(2 * {N_LINES} / {MAX_CHECK_INTERVAL}) \
         - 1 = {at_least} times; it was consulted {} times",
        N_LINES - 1,
        r.cancel_calls_after_read
    );
}

// ---------------------------------------------------------------------------
// (b) 全部 OFF の経路(322)= ソース走査
// ---------------------------------------------------------------------------

/// 行ごとに `//` 以降(コメント)を落としたコード部分を連結して返す。`://` は落とさない
/// (acceptance_req66.rs と同じ)。
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

/// `fn <name>` の (引数リスト, 本体)。
fn function_parts<'a>(code: &'a str, name: &str) -> (&'a str, &'a str) {
    let needle = format!("fn {name}");
    let start = code
        .match_indices(&needle)
        .map(|(i, _)| i)
        .find(|i| {
            let rest = &code[i + needle.len()..];
            rest.starts_with('(') || rest.starts_with('<')
        })
        .unwrap_or_else(|| panic!("search/mod.rs must define {name}"));
    let params = balanced(code, start + needle.len(), '(', ')');
    let params_end = params.as_ptr() as usize - code.as_ptr() as usize + params.len();
    let body = balanced(code, params_end, '{', '}');
    (params, body)
}

/// `collect_hits` の本体のうち、全部 OFF の分岐(`regex` が無いとき)の `{ … }`。
/// `if … regex.is_none() { … }` か、`match` の `None => { … }` の腕。
fn all_off_branch(body: &str) -> &str {
    if let Some(at) = body.find("regex.is_none()") {
        return balanced(body, at, '{', '}');
    }
    if let Some(at) = body.find("None =>") {
        return balanced(body, at, '{', '}');
    }
    panic!(
        "collect_hits must branch on the absence of the regex (`regex.is_none()` or a `None =>` arm) \
         so the all-OFF path can be told apart (contract 2): {body}"
    );
}

#[test]
fn ac66a_b_all_off_branch_of_collect_hits_counts_with_to_lowercase_and_matches_only() {
    let code = strip_line_comments(include_str!("../src/search/mod.rs"));
    let (_, body) = function_parts(&code, "collect_hits");
    let branch = all_off_branch(body);

    assert!(
        branch.contains("to_lowercase()"),
        "the all-OFF branch counts with `to_lowercase()` (要件#55 の規則のまま=contract 2): {branch}"
    );
    assert!(
        branch.contains(".matches("),
        "the all-OFF branch counts with `.matches(` (要件#55 の規則のまま=contract 2): {branch}"
    );
    for forbidden in ["find_in_line", "first_in_line", "JumpCounts", "cancel"] {
        assert!(
            !branch.contains(forbidden),
            "the all-OFF branch must not go through `{forbidden}` (contract 2: no regex path and no \
             cancel check for all OFF): {branch}"
        );
    }
}
