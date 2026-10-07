//! 要件#55 追補d の受け入れテスト(docs/requirements/req-55.md「### 追補d」)— Rust 層
//! (AC-55-33〜38)
//!
//! 「見つかった順に段階的に出す・ssh の並列読み・古い世代の走査を止める」。
//! 本ファイルは **メモリ上のモック `FileProvider`** に対して走査の streaming 版を回し、
//! 進捗コールバック(sink)に届くバッチの順序・内容・大きさ・打ち切りと、`read_bytes` の
//! 同時実行数を判定する。local / ssh の実体には依存しない。
//!
//! 判定範囲(AC 番号は req-55.md の受け入れ基準):
//! - AC-55-33 純関数・定数: バッチの規則 `should_flush`(10 件 or 200ms)・
//!   `BATCH_MAX_HITS` / `BATCH_MAX_WAIT_MS`・イベント名定数・イベント payload の JSON 形
//!   (camelCase=`filesScanned`)
//! - AC-55-34 d-1 走査順=パス順: sink に届く hits を全部つなぐと `search_in_folder_with` と
//!   同じ順・同じ内容(`list` の戻りをシャッフルしても)・各バッチは `max_hits` 以下・
//!   `files_scanned` は単調増加・最初のバッチは走査の途中で届く(全件ためてから出さない)
//! - AC-55-35 d-3 打ち切り: sink が `Stop` を返したら以後 sink は呼ばれず `stopped: true`・
//!   それ以後 `read_bytes` / `list` は発行されない。`cancel`(d-3 の補足)は各 `list` 前と各ファイル
//!   読み取り前に呼ばれ、true で一致 0 件の木でも途中で止まる(sink は呼ばれない)
//! - AC-55-36 d-2 並列読み: 同じディレクトリの 20 ファイルで `read_bytes` の最大同時数が
//!   2 以上 8 以下・順序は名前順のまま
//! - AC-55-37 d-3 `ResultStore::begin` / `is_current`(窓ごとの最新世代)。`store` / `page` /
//!   `forget` の既存規則は不変(`tests/acceptance_req55a.rs` が無改変で緑)
//! - AC-55-38 ソース走査: `commands/search.rs` の `search_in_folder` が `begin` →
//!   `search_in_folder_streaming` を呼び、sink で `is_current` を見て `SearchControl::Stop`・
//!   イベントは `emit_to`(その窓だけ)・ブロードキャストの `.emit(` を使わない
//!
//! 人間ゲート 2(ssh 実機での所要時間)は本ファイルでは判定しない。
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前・公開パス)
//!
//! ```ignore
//! // --- src-tauri/src/search/mod.rs に追加 ---
//! use std::time::Duration;
//!
//! /// Tauri イベント名(フロントの `src/lib/find-in-folder.ts` と同綴り)。
//! pub const SEARCH_PROGRESS_EVENT: &str = "search_progress";
//! pub const SEARCH_DONE_EVENT: &str = "search_done";
//!
//! /// バッチの規則(d-1): 10 件たまるか、前回の送信から 200ms 経過で送る。
//! pub const BATCH_MAX_HITS: usize = 10;
//! pub const BATCH_MAX_WAIT_MS: u64 = 200;
//! pub struct BatchPolicy { pub max_hits: usize, pub max_wait: Duration }
//! /// pending == 0 なら常に false。pending >= max_hits で true。
//! /// pending >= 1 かつ since_last >= max_wait で true。
//! pub fn should_flush(pending: usize, since_last: Duration, policy: &BatchPolicy) -> bool;
//!
//! /// sink に渡す 1 バッチ。`hits` は走査順(=パス順・行番号順)・1 件以上・`max_hits` 件以下。
//! /// `files_scanned` = ここまでに読み終えたテキストファイル数(単調増加)。
//! #[derive(Clone, Debug)]
//! pub struct SearchProgress { pub hits: Vec<SearchHit>, pub files_scanned: usize }
//! #[derive(Clone, Copy, Debug, PartialEq, Eq)]
//! pub enum SearchControl { Continue, Stop }
//! /// 走査の結果。`total` = sink に渡した一致の総数・`files` = 一致のあったファイル数・
//! /// `stopped` = sink の `Stop` で打ち切った。
//! #[derive(Clone, Debug, PartialEq, Eq)]
//! pub struct SearchSummary { pub total: usize, pub files: usize, pub stopped: bool }
//!
//! /// 走査の本体(streaming)。各ディレクトリの `list` の戻りを**名前順**(kind を問わず
//! /// `Entry.name` の `Ord`)に並べてから深さ優先で降りる=走査順がパス順。最後に並べ替えない。
//! /// 同じディレクトリ内のファイルの `read_bytes` は同時 8 本まで並列(d-2)、結果は名前順に
//! /// 揃えてからバッチに載せる。sink が `Stop` を返したら以後 `list` / `read_bytes` を
//! /// 発行せず `stopped: true` で返す。空文字の query は sink を呼ばず `total: 0`。
//! pub async fn search_in_folder_streaming(
//!     provider: &dyn FileProvider,
//!     root: &Uri,
//!     query: &str,
//!     sink: &mut (dyn FnMut(SearchProgress) -> SearchControl + Send),
//!     /// d-3 の補足(要件側更新・承認済み): 各ディレクトリの `list` 前と各ファイルの読み取り前に
//!     /// 呼ぶ。true なら以後 `list` / `read_bytes` を発行せず sink も呼ばず `stopped: true` で返す。
//!     cancel: &(dyn Fn() -> bool + Send + Sync),
//! ) -> Result<SearchSummary, FsError>;
//!
//! /// 既存 `search_in_folder_with` は streaming 版を「全部ためる sink」で呼ぶ薄い層にしてよい
//! /// (戻りの順序・内容は不変=`tests/acceptance_req55.rs` が無改変で緑)。
//!
//! /// イベント payload(serde は camelCase=フロントの `SearchProgressPayload` / `SearchDonePayload`)。
//! #[derive(Clone, Debug, Serialize)] #[serde(rename_all = "camelCase")]
//! pub struct SearchProgressEvent { pub generation: u64, pub hits: Vec<SearchHit>, pub files_scanned: usize }
//! #[derive(Clone, Debug, Serialize)] #[serde(rename_all = "camelCase")]
//! pub struct SearchDoneEvent { pub generation: u64, pub total: usize, pub files: usize }
//!
//! impl ResultStore {
//!     /// その窓の最新世代を記録する(走査の開始時)。小さい世代で呼んでも最新は下がらない。
//!     pub fn begin(&mut self, label: &str, generation: u64);
//!     /// より新しい世代が begin 済みなら false。begin が無い・forget 済みの窓は true。
//!     pub fn is_current(&self, label: &str, generation: u64) -> bool;
//! }
//!
//! // --- src-tauri/src/commands/search.rs ---
//! // search_in_folder: results.begin(window.label(), generation) → search_in_folder_streaming(..)
//! //   cancel: `&|| !results.lock().is_current(label, generation)` 相当(`!` と `.is_current(` が同じ閉包内)
//! //   sink: is_current でなければ SearchControl::Stop、現在世代なら
//! //   window.emit_to(window.label(), SEARCH_PROGRESS_EVENT, SearchProgressEvent{..}) → Continue
//! //   終了: stopped なら空の SearchResponse(イベントも送らない)、
//! //         そうでなければ emit_to(.., SEARCH_DONE_EVENT, SearchDoneEvent{..}) と store(..)
//! ```
//!
//! ## 走査順の注記(契約に無い判断・報告済み)
//! 名前順 DFS とパス文字列の全体ソートは、ディレクトリ名が兄弟ファイル名の接頭辞で
//! その直後の文字が `/` より小さいとき(`a/` と `a.md`)だけ食い違う。本テストの
//! フィクスチャはその形を避ける(implementer は名前順 DFS を採り、`search_in_folder_with`
//! は streaming の順をそのまま返してよい)。

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use tokio::sync::mpsc;

use vellis_lib::errors::FsError;
use vellis_lib::fs::entry::{Entry, FileKind};
use vellis_lib::fs::provider::{FileProvider, WatchEvent, WatchHandle};
use vellis_lib::fs::uri::Uri;
use vellis_lib::search::{
    search_in_folder_streaming, search_in_folder_with, should_flush, BatchPolicy, ResultStore,
    SearchControl, SearchDoneEvent, SearchHit, SearchProgress, SearchProgressEvent,
    SearchSummary, BATCH_MAX_HITS, BATCH_MAX_WAIT_MS, PAGE_SIZE, SEARCH_DONE_EVENT,
    SEARCH_PROGRESS_EVENT,
};

// ---------------------------------------------------------------------------
// Mock FileProvider (in-memory tree) with in-flight accounting
// ---------------------------------------------------------------------------

/// Order in which `list` hands back a directory. The implementation must sort by
/// name itself (d-1), so every order has to give the same streamed sequence.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ListOrder {
    /// Same as local.rs: directories first, then by name.
    DirsFirst,
    /// Reverse of `DirsFirst`.
    Reversed,
    /// `DirsFirst` with the first entry moved to the end.
    Rotated,
}

struct MockFs {
    root: Uri,
    /// absolute dir path -> direct children
    dirs: HashMap<String, Vec<Entry>>,
    /// absolute file path -> content
    files: HashMap<String, Vec<u8>>,
    order: ListOrder,
    /// Delay inside `read_bytes` so that concurrent reads overlap measurably.
    read_delay: Option<Duration>,
    list_calls: Mutex<Vec<String>>,
    read_calls: Mutex<Vec<String>>,
    in_flight: AtomicUsize,
    max_in_flight: AtomicUsize,
    /// Set by a sink when it returns `Stop`; any `list` / `read_bytes` issued afterwards is counted.
    stopped: AtomicBool,
    calls_after_stop: AtomicUsize,
}

impl MockFs {
    fn new(root: &str) -> Self {
        let root = Uri::parse(root).expect("root uri must parse");
        let mut fs = Self {
            root: root.clone(),
            dirs: HashMap::new(),
            files: HashMap::new(),
            order: ListOrder::DirsFirst,
            read_delay: None,
            list_calls: Mutex::new(Vec::new()),
            read_calls: Mutex::new(Vec::new()),
            in_flight: AtomicUsize::new(0),
            max_in_flight: AtomicUsize::new(0),
            stopped: AtomicBool::new(false),
            calls_after_stop: AtomicUsize::new(0),
        };
        fs.dirs.insert(root.path_str().to_string(), Vec::new());
        fs
    }

    fn with_order(mut self, order: ListOrder) -> Self {
        self.order = order;
        self
    }

    fn with_read_delay(mut self, delay: Duration) -> Self {
        self.read_delay = Some(delay);
        self
    }

    fn abs_path(&self, rel: &str) -> String {
        self.root.with_path(self.root.path.join(rel)).path_str().to_string()
    }

    fn make_entry(&self, abs: &str, kind: FileKind, size: Option<u64>) -> Entry {
        let uri = self.root.with_path(abs);
        let name = std::path::Path::new(abs)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        Entry { uri: uri.raw, name, kind, size, modified: Some(1_700_000_000_000), link: None }
    }

    fn ensure_dir_abs(&mut self, abs: &str) {
        if self.dirs.contains_key(abs) {
            return;
        }
        self.dirs.insert(abs.to_string(), Vec::new());
        let parent = std::path::Path::new(abs)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .expect("dir must have a parent");
        self.ensure_dir_abs(&parent);
        let entry = self.make_entry(abs, FileKind::Dir, None);
        self.dirs.get_mut(&parent).expect("parent listing").push(entry);
    }

    /// Place a file at a root-relative path (parents are created as needed).
    fn file(&mut self, rel: &str, content: &str) -> &mut Self {
        let abs = self.abs_path(rel);
        let parent = std::path::Path::new(&abs)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .expect("file must have a parent");
        self.ensure_dir_abs(&parent);
        let bytes = content.as_bytes().to_vec();
        let entry = self.make_entry(&abs, FileKind::File, Some(bytes.len() as u64));
        self.dirs.get_mut(&parent).expect("parent listing").push(entry);
        self.files.insert(abs, bytes);
        self
    }

    fn read_calls(&self) -> Vec<String> {
        self.read_calls.lock().unwrap().clone()
    }

    fn list_calls(&self) -> Vec<String> {
        self.list_calls.lock().unwrap().clone()
    }

    fn was_read(&self, rel: &str) -> bool {
        let abs = self.abs_path(rel);
        self.read_calls().iter().any(|p| *p == abs)
    }

    fn max_in_flight(&self) -> usize {
        self.max_in_flight.load(Ordering::SeqCst)
    }

    fn mark_stopped(&self) {
        self.stopped.store(true, Ordering::SeqCst);
    }

    fn calls_after_stop(&self) -> usize {
        self.calls_after_stop.load(Ordering::SeqCst)
    }

    fn note_call(&self) {
        if self.stopped.load(Ordering::SeqCst) {
            self.calls_after_stop.fetch_add(1, Ordering::SeqCst);
        }
    }
}

#[async_trait]
impl FileProvider for MockFs {
    fn scheme(&self) -> &'static str {
        if self.root.scheme == "ssh" {
            "ssh"
        } else {
            "file"
        }
    }

    async fn list(&self, uri: &Uri) -> Result<Vec<Entry>, FsError> {
        let key = uri.path_str().to_string();
        self.note_call();
        self.list_calls.lock().unwrap().push(key.clone());
        let mut entries = self
            .dirs
            .get(&key)
            .cloned()
            .ok_or_else(|| FsError::NotFound(key.clone()))?;
        entries.sort_by(|a, b| {
            let ad = a.kind == FileKind::Dir;
            let bd = b.kind == FileKind::Dir;
            bd.cmp(&ad).then_with(|| a.name.cmp(&b.name))
        });
        match self.order {
            ListOrder::DirsFirst => {}
            ListOrder::Reversed => entries.reverse(),
            ListOrder::Rotated => {
                if !entries.is_empty() {
                    entries.rotate_left(1);
                }
            }
        }
        Ok(entries)
    }

    async fn stat(&self, uri: &Uri) -> Result<Entry, FsError> {
        let key = uri.path_str().to_string();
        if key == self.root.path_str() {
            return Ok(self.make_entry(&key, FileKind::Dir, None));
        }
        let parent = std::path::Path::new(&key)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let name = std::path::Path::new(&key)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        self.dirs
            .get(&parent)
            .and_then(|list| list.iter().find(|e| e.name == name).cloned())
            .ok_or(FsError::NotFound(key))
    }

    async fn read_bytes(&self, uri: &Uri) -> Result<Vec<u8>, FsError> {
        let key = uri.path_str().to_string();
        self.note_call();
        self.read_calls.lock().unwrap().push(key.clone());
        let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_in_flight.fetch_max(now, Ordering::SeqCst);
        if let Some(delay) = self.read_delay {
            tokio::time::sleep(delay).await;
        }
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        self.files.get(&key).cloned().ok_or(FsError::NotFound(key))
    }

    async fn write_text(&self, uri: &str, _content: &str) -> Result<(), FsError> {
        panic!("search must never write: {uri}");
    }

    async fn watch(
        &self,
        _uri: &Uri,
        _tx: mpsc::Sender<WatchEvent>,
    ) -> Result<WatchHandle, FsError> {
        Err(FsError::Unsupported("watch unsupported in mock".into()))
    }
}

// ---------------------------------------------------------------------------
// Helpers and fixtures
// ---------------------------------------------------------------------------

const FILE_ROOT: &str = "file:///root";
const SSH_ROOT: &str = "ssh://alice@host.example.com:2222/data";
const QUERY: &str = "alpha";

fn hit(path: &str, line: u32, ordinal: u32, text: &str) -> SearchHit {
    SearchHit { path: path.to_string(), line, text: text.to_string(), ordinal }
}

fn policy() -> BatchPolicy {
    BatchPolicy { max_hits: BATCH_MAX_HITS, max_wait: Duration::from_millis(BATCH_MAX_WAIT_MS) }
}

/// Three directories `a/`, `b/`, `c/` with ten one-hit files each, plus root files:
/// `r1.md` (two hits), `zz.txt` (one hit), `none.md` (no hit), `.hidden.md` (excluded).
/// Names are chosen so that name-ordered DFS and a global (path, line) sort agree.
/// 33 hits in 32 files; 33 text files are read (the hidden one is not).
fn tree(root: &str) -> MockFs {
    let mut fs = MockFs::new(root);
    for dir in ["a", "b", "c"] {
        for i in 0..10 {
            fs.file(&format!("{dir}/f{i:02}.md"), "alpha here\nnothing\n");
        }
    }
    fs.file("r1.md", "one\nalpha two\nthree\nfour\nand alpha five\n");
    fs.file("zz.txt", "ALPHA\n");
    fs.file("none.md", "nothing\n");
    fs.file(".hidden.md", "alpha hidden\n");
    fs
}

fn expected_tree_hits() -> Vec<SearchHit> {
    let mut hits = Vec::new();
    for dir in ["a", "b", "c"] {
        for i in 0..10 {
            hits.push(hit(&format!("{dir}/f{i:02}.md"), 1, 1, "alpha here"));
        }
    }
    hits.push(hit("r1.md", 2, 1, "alpha two"));
    hits.push(hit("r1.md", 5, 2, "and alpha five"));
    hits.push(hit("zz.txt", 1, 1, "ALPHA"));
    hits
}

const TREE_TOTAL: usize = 33;
const TREE_MATCHED_FILES: usize = 32;
const TREE_TEXT_FILES: usize = 33;

async fn stream_all(fs: &MockFs, query: &str) -> (Vec<SearchProgress>, SearchSummary) {
    let mut batches: Vec<SearchProgress> = Vec::new();
    let mut sink = |p: SearchProgress| {
        batches.push(p);
        SearchControl::Continue
    };
    let summary = search_in_folder_streaming(fs, &fs.root, query, &mut sink, &|| false)
        .await
        .unwrap_or_else(|e| panic!("search_in_folder_streaming({query:?}) must succeed: {e}"));
    (batches, summary)
}

fn concat(batches: &[SearchProgress]) -> Vec<SearchHit> {
    batches.iter().flat_map(|b| b.hits.iter().cloned()).collect()
}

/// Batches allowed by the time rule on top of the count rule: one extra per elapsed
/// `max_wait`, plus one for the trailing flush. With an instant mock this is 1.
fn time_slack(elapsed: Duration) -> usize {
    (elapsed.as_millis() / BATCH_MAX_WAIT_MS as u128) as usize + 1
}

// ---------------------------------------------------------------------------
// AC-55-33 — pure rules and constants
// ---------------------------------------------------------------------------

#[test]
fn batch_constants_are_10_hits_and_200ms() {
    assert_eq!(BATCH_MAX_HITS, 10);
    assert_eq!(BATCH_MAX_WAIT_MS, 200);
    let p = policy();
    assert_eq!(p.max_hits, 10);
    assert_eq!(p.max_wait, Duration::from_millis(200));
}

#[test]
fn should_flush_truth_table() {
    let p = policy();
    let ms = Duration::from_millis;
    // Nothing pending: never flush, however long it has been.
    assert!(!should_flush(0, ms(0), &p));
    assert!(!should_flush(0, ms(200), &p));
    assert!(!should_flush(0, Duration::from_secs(10), &p));
    // Count rule.
    assert!(should_flush(10, ms(0), &p));
    assert!(should_flush(11, ms(0), &p));
    assert!(should_flush(25, ms(0), &p));
    assert!(!should_flush(9, ms(0), &p));
    assert!(!should_flush(1, ms(0), &p));
    // Time rule.
    assert!(should_flush(1, ms(200), &p));
    assert!(should_flush(1, ms(201), &p));
    assert!(should_flush(9, ms(200), &p));
    assert!(should_flush(9, Duration::from_secs(5), &p));
    assert!(!should_flush(9, ms(199), &p));
    assert!(!should_flush(1, ms(199), &p));
}

#[test]
fn should_flush_honours_a_custom_policy() {
    let p = BatchPolicy { max_hits: 3, max_wait: Duration::from_millis(50) };
    assert!(should_flush(3, Duration::ZERO, &p));
    assert!(!should_flush(2, Duration::from_millis(49), &p));
    assert!(should_flush(2, Duration::from_millis(50), &p));
    assert!(!should_flush(0, Duration::from_millis(50), &p));
}

#[test]
fn event_names_are_fixed() {
    assert_eq!(SEARCH_PROGRESS_EVENT, "search_progress");
    assert_eq!(SEARCH_DONE_EVENT, "search_done");
}

#[test]
fn progress_event_serializes_with_camel_case_keys() {
    let event = SearchProgressEvent {
        generation: 7,
        hits: vec![hit("docs/a.md", 3, 1, "alpha one")],
        files_scanned: 12,
    };
    let json = serde_json::to_value(&event).expect("serialize");
    let mut keys: Vec<&str> = json.as_object().expect("object").keys().map(|k| k.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["filesScanned", "generation", "hits"]);
    assert_eq!(json["generation"], 7);
    assert_eq!(json["filesScanned"], 12);
    assert_eq!(json["hits"][0]["path"], "docs/a.md");
    assert_eq!(json["hits"][0]["line"], 3);
    assert_eq!(json["hits"][0]["text"], "alpha one");
    assert_eq!(json["hits"][0]["ordinal"], 1);
}

#[test]
fn done_event_serializes_with_generation_total_files() {
    let event = SearchDoneEvent { generation: 7, total: 250, files: 3 };
    let json = serde_json::to_value(&event).expect("serialize");
    let mut keys: Vec<&str> = json.as_object().expect("object").keys().map(|k| k.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["files", "generation", "total"]);
    assert_eq!(json["generation"], 7);
    assert_eq!(json["total"], 250);
    assert_eq!(json["files"], 3);
}

#[test]
fn progress_and_summary_shapes_are_fixed() {
    // Struct literals pin the field sets at compile time.
    let progress = SearchProgress { hits: vec![hit("a.md", 1, 1, "alpha")], files_scanned: 1 };
    assert_eq!(progress.hits.len(), 1);
    assert_eq!(progress.files_scanned, 1);
    let summary = SearchSummary { total: 1, files: 1, stopped: false };
    assert_eq!(summary, SearchSummary { total: 1, files: 1, stopped: false });
    let control = [SearchControl::Continue, SearchControl::Stop];
    assert_ne!(control[0], control[1]);
}

// ---------------------------------------------------------------------------
// AC-55-34 — d-1: streamed order == path order, batches <= 10, progressive
// ---------------------------------------------------------------------------

#[tokio::test]
async fn streamed_hits_equal_the_sorted_result_in_the_same_order() {
    for order in [ListOrder::DirsFirst, ListOrder::Reversed, ListOrder::Rotated] {
        let fs = tree(FILE_ROOT).with_order(order);
        let sorted = search_in_folder_with(&fs, &fs.root, QUERY).await.expect("sorted search");
        let (batches, summary) = stream_all(&fs, QUERY).await;
        let streamed = concat(&batches);

        assert_eq!(streamed, expected_tree_hits(), "order {order:?}: streamed sequence");
        assert_eq!(streamed, sorted, "order {order:?}: streaming == search_in_folder_with");
        assert_eq!(
            summary,
            SearchSummary { total: TREE_TOTAL, files: TREE_MATCHED_FILES, stopped: false },
            "order {order:?}: summary"
        );
        assert!(!fs.was_read(".hidden.md"), "hidden files stay excluded");
    }
}

#[tokio::test]
async fn ssh_root_streams_the_same_sequence() {
    let fs = tree(SSH_ROOT).with_order(ListOrder::Reversed);
    let (batches, summary) = stream_all(&fs, QUERY).await;
    assert_eq!(concat(&batches), expected_tree_hits());
    assert_eq!(summary.total, TREE_TOTAL);
    assert_eq!(summary.files, TREE_MATCHED_FILES);
    assert!(!summary.stopped);
}

#[tokio::test]
async fn every_batch_has_between_1_and_10_hits_and_batches_are_not_split_finer_than_needed() {
    let fs = tree(FILE_ROOT);
    let started = Instant::now();
    let (batches, _) = stream_all(&fs, QUERY).await;
    let elapsed = started.elapsed();

    assert!(!batches.is_empty());
    for (i, b) in batches.iter().enumerate() {
        assert!(!b.hits.is_empty(), "batch {i} must carry at least one hit");
        assert!(b.hits.len() <= BATCH_MAX_HITS, "batch {i} has {} hits (> {BATCH_MAX_HITS})", b.hits.len());
    }
    let minimum = TREE_TOTAL.div_ceil(BATCH_MAX_HITS); // 4
    assert!(batches.len() >= minimum, "{} batches < {minimum}", batches.len());
    assert!(
        batches.len() <= minimum + time_slack(elapsed),
        "{} batches for {TREE_TOTAL} hits in {elapsed:?}: hits are not grouped by 10",
        batches.len()
    );
}

#[tokio::test]
async fn a_single_file_with_many_hits_is_split_into_batches_of_at_most_10() {
    let mut fs = MockFs::new(FILE_ROOT);
    let body = (1..=25).map(|i| format!("alpha {i}\n")).collect::<String>();
    fs.file("big.md", &body);
    let started = Instant::now();
    let (batches, summary) = stream_all(&fs, QUERY).await;
    let elapsed = started.elapsed();

    let sizes: Vec<usize> = batches.iter().map(|b| b.hits.len()).collect();
    assert!(sizes.iter().all(|&n| (1..=BATCH_MAX_HITS).contains(&n)), "sizes {sizes:?}");
    assert_eq!(sizes.iter().sum::<usize>(), 25);
    assert!(sizes.len() >= 3 && sizes.len() <= 3 + time_slack(elapsed), "sizes {sizes:?}");
    let streamed = concat(&batches);
    let lines: Vec<u32> = streamed.iter().map(|h| h.line).collect();
    assert_eq!(lines, (1..=25).collect::<Vec<u32>>());
    let ordinals: Vec<u32> = streamed.iter().map(|h| h.ordinal).collect();
    assert_eq!(ordinals, (1..=25).collect::<Vec<u32>>());
    assert_eq!(summary, SearchSummary { total: 25, files: 1, stopped: false });
}

#[tokio::test]
async fn files_scanned_is_monotonic_and_counts_text_files_read() {
    let fs = tree(FILE_ROOT).with_order(ListOrder::Rotated);
    let (batches, _) = stream_all(&fs, QUERY).await;

    let scanned: Vec<usize> = batches.iter().map(|b| b.files_scanned).collect();
    assert!(scanned.windows(2).all(|w| w[0] <= w[1]), "files_scanned not monotonic: {scanned:?}");
    assert!(*scanned.first().unwrap() >= 1, "first batch after at least one file: {scanned:?}");
    let last = *scanned.last().unwrap();
    assert!(last <= TREE_TEXT_FILES, "files_scanned {last} exceeds the {TREE_TEXT_FILES} text files");
    assert!(last >= TREE_MATCHED_FILES, "last batch is sent after the last matching file: {scanned:?}");
    assert_eq!(fs.read_calls().len(), TREE_TEXT_FILES, "each text file is read exactly once");
}

#[tokio::test]
async fn the_first_batch_arrives_before_later_directories_are_read() {
    // If the scan buffered everything and sorted at the end, `c/` would already be read
    // when the first batch is delivered.
    let fs = tree(FILE_ROOT).with_order(ListOrder::Reversed);
    let reads_at_first_batch: Mutex<Option<Vec<String>>> = Mutex::new(None);
    let mut sink = |_p: SearchProgress| {
        let mut slot = reads_at_first_batch.lock().unwrap();
        if slot.is_none() {
            *slot = Some(fs.read_calls());
        }
        SearchControl::Continue
    };
    search_in_folder_streaming(&fs, &fs.root, QUERY, &mut sink, &|| false).await.expect("search");

    let reads = reads_at_first_batch.lock().unwrap().clone().expect("sink was called");
    let c_prefix = fs.abs_path("c");
    assert!(
        !reads.iter().any(|p| p.starts_with(&c_prefix)),
        "first batch must be delivered before `c/` is read; reads so far: {reads:?}"
    );
    assert!(reads.len() < TREE_TEXT_FILES, "first batch must not wait for the whole scan");
    assert!(
        reads.iter().any(|p| p.starts_with(&fs.abs_path("a"))),
        "the first batch comes from the first directory in name order"
    );
}

#[tokio::test]
async fn empty_query_streams_nothing_and_touches_no_file() {
    let fs = tree(FILE_ROOT);
    let (batches, summary) = stream_all(&fs, "").await;
    assert!(batches.is_empty());
    assert_eq!(summary, SearchSummary { total: 0, files: 0, stopped: false });
    assert!(fs.list_calls().is_empty());
    assert!(fs.read_calls().is_empty());
}

#[tokio::test]
async fn no_match_streams_nothing_but_reports_files_zero() {
    let fs = tree(FILE_ROOT);
    let (batches, summary) = stream_all(&fs, "nomatchword").await;
    assert!(batches.is_empty(), "no batch without hits (a timer flush with 0 pending is not sent)");
    assert_eq!(summary, SearchSummary { total: 0, files: 0, stopped: false });
    assert_eq!(fs.read_calls().len(), TREE_TEXT_FILES);
}

#[tokio::test]
async fn unreadable_root_is_an_error_for_streaming_too() {
    let fs = MockFs::new(FILE_ROOT);
    let missing = fs.root.with_path("/nowhere");
    let mut sink = |_p: SearchProgress| SearchControl::Continue;
    let result = search_in_folder_streaming(&fs, &missing, QUERY, &mut sink, &|| false).await;
    assert!(matches!(result, Err(FsError::NotFound(_))), "{result:?}");
}

// ---------------------------------------------------------------------------
// AC-55-35 — d-3: Stop from the sink ends the scan
// ---------------------------------------------------------------------------

#[tokio::test]
async fn stop_from_the_sink_ends_the_scan_without_further_reads_or_listings() {
    let fs = tree(FILE_ROOT);
    let sink_calls = AtomicUsize::new(0);
    let delivered = AtomicUsize::new(0);
    let mut sink = |p: SearchProgress| {
        sink_calls.fetch_add(1, Ordering::SeqCst);
        delivered.fetch_add(p.hits.len(), Ordering::SeqCst);
        assert!(p.hits.len() <= BATCH_MAX_HITS);
        assert!(p.hits.iter().all(|h| h.path.starts_with("a/")), "first batch comes from `a/`: {:?}", p.hits);
        fs.mark_stopped();
        SearchControl::Stop
    };
    let summary = search_in_folder_streaming(&fs, &fs.root, QUERY, &mut sink, &|| false).await.expect("search");

    assert_eq!(sink_calls.load(Ordering::SeqCst), 1, "sink is not called again after Stop");
    assert!(summary.stopped, "summary must say stopped: {summary:?}");
    assert_eq!(summary.total, delivered.load(Ordering::SeqCst), "total counts what was delivered");
    assert_eq!(fs.calls_after_stop(), 0, "no list/read_bytes may be issued after Stop");
    assert!(!fs.was_read("c/f00.md"));
    assert!(!fs.was_read("r1.md"));
    assert!(!fs.was_read("zz.txt"));
    assert!(fs.read_calls().len() < TREE_TEXT_FILES);
}

#[tokio::test]
async fn stop_on_a_later_batch_keeps_the_earlier_batches() {
    let fs = tree(FILE_ROOT);
    let mut delivered: Vec<SearchHit> = Vec::new();
    let mut calls = 0usize;
    let mut sink = |p: SearchProgress| {
        calls += 1;
        delivered.extend(p.hits);
        if calls == 2 {
            fs.mark_stopped();
            SearchControl::Stop
        } else {
            SearchControl::Continue
        }
    };
    let summary = search_in_folder_streaming(&fs, &fs.root, QUERY, &mut sink, &|| false).await.expect("search");

    assert_eq!(calls, 2);
    assert!(summary.stopped);
    let expected = expected_tree_hits();
    assert!(
        expected.starts_with(&delivered),
        "delivered hits must be a prefix of the path-ordered sequence: {delivered:?}"
    );
    assert!(delivered.len() >= 2 && delivered.len() <= 2 * BATCH_MAX_HITS, "{}", delivered.len());
    assert_eq!(summary.total, delivered.len());
    assert_eq!(fs.calls_after_stop(), 0);
    assert!(!fs.was_read("r1.md"));
}

#[tokio::test]
async fn cancel_stops_a_scan_that_has_no_hits_to_flush() {
    // d-3 supplement: with no hits the sink is never consulted, so the scan must also poll
    // `cancel` between files/directories. Here it turns true on its third call.
    let fs = tree(FILE_ROOT);
    let cancel_calls = AtomicUsize::new(0);
    let cancel = || {
        let n = cancel_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if n >= 3 {
            fs.mark_stopped();
            true
        } else {
            false
        }
    };
    let sink_calls = AtomicUsize::new(0);
    let mut sink = |_p: SearchProgress| {
        sink_calls.fetch_add(1, Ordering::SeqCst);
        SearchControl::Continue
    };
    let summary = search_in_folder_streaming(&fs, &fs.root, "nomatchword", &mut sink, &cancel)
        .await
        .expect("search");

    assert!(summary.stopped, "{summary:?}");
    assert_eq!(summary.total, 0);
    assert_eq!(sink_calls.load(Ordering::SeqCst), 0, "no hits, so the sink is never called");
    assert!(cancel_calls.load(Ordering::SeqCst) >= 3);
    assert_eq!(fs.calls_after_stop(), 0, "no list/read_bytes after cancel returned true");
    assert!(fs.read_calls().len() < TREE_TEXT_FILES, "scan must stop early: {:?}", fs.read_calls());
    assert!(!fs.was_read("zz.txt"));
}

#[tokio::test]
async fn cancel_is_polled_before_every_file_read_and_every_directory_listing() {
    let fs = tree(FILE_ROOT);
    let cancel_calls = AtomicUsize::new(0);
    let cancel = || {
        cancel_calls.fetch_add(1, Ordering::SeqCst);
        false
    };
    let mut sink = |_p: SearchProgress| SearchControl::Continue;
    let summary = search_in_folder_streaming(&fs, &fs.root, QUERY, &mut sink, &cancel)
        .await
        .expect("search");

    assert!(!summary.stopped);
    assert_eq!(summary.total, TREE_TOTAL);
    let dirs_listed = fs.list_calls().len(); // root, a, b, c
    assert_eq!(dirs_listed, 4);
    let polls = cancel_calls.load(Ordering::SeqCst);
    assert!(
        polls >= TREE_TEXT_FILES + dirs_listed,
        "cancel polled {polls} times; expected at least {} (files) + {dirs_listed} (dirs)",
        TREE_TEXT_FILES
    );
}

#[tokio::test]
async fn continue_everywhere_never_reports_stopped() {
    let fs = tree(FILE_ROOT);
    let (_, summary) = stream_all(&fs, QUERY).await;
    assert!(!summary.stopped);
}

// ---------------------------------------------------------------------------
// AC-55-36 — d-2: reads inside one directory run in parallel, at most 8 at once
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reads_in_one_directory_overlap_but_never_exceed_8_in_flight() {
    let mut fs = MockFs::new(SSH_ROOT).with_read_delay(Duration::from_millis(10));
    for i in 0..20 {
        fs.file(&format!("notes/n{i:02}.md"), &format!("alpha {i}\n"));
    }
    let (batches, summary) = stream_all(&fs, QUERY).await;

    let max = fs.max_in_flight();
    assert!(max >= 2, "read_bytes never overlapped (max in-flight {max}): reads are sequential");
    assert!(max <= 8, "more than 8 concurrent read_bytes (max in-flight {max})");

    let paths: Vec<String> = concat(&batches).iter().map(|h| h.path.clone()).collect();
    let expected: Vec<String> = (0..20).map(|i| format!("notes/n{i:02}.md")).collect();
    assert_eq!(paths, expected, "parallel reads must still be delivered in name order");
    assert_eq!(summary, SearchSummary { total: 20, files: 20, stopped: false });
    assert_eq!(fs.read_calls().len(), 20);
}

#[tokio::test]
async fn parallel_reads_keep_line_and_ordinal_within_each_file() {
    let mut fs = MockFs::new(FILE_ROOT).with_read_delay(Duration::from_millis(5));
    for i in 0..12 {
        fs.file(&format!("d/m{i:02}.md"), "x\nalpha one\nalpha two alpha\nalpha four\n");
    }
    let (batches, _) = stream_all(&fs, QUERY).await;
    let streamed = concat(&batches);
    assert_eq!(streamed.len(), 36);
    for (i, chunk) in streamed.chunks(3).enumerate() {
        let path = format!("d/m{i:02}.md");
        assert_eq!(
            chunk.to_vec(),
            vec![
                hit(&path, 2, 1, "alpha one"),
                hit(&path, 3, 2, "alpha two alpha"),
                hit(&path, 4, 4, "alpha four"),
            ],
            "file {path}"
        );
    }
    assert!(fs.max_in_flight() >= 2 && fs.max_in_flight() <= 8);
}

#[tokio::test]
async fn parallel_reads_do_not_cross_into_a_later_directory_before_the_batch_is_flushed() {
    // Two sibling directories; the first has ten one-hit files. Stopping at the first batch
    // must leave the second directory unread even with parallel reads in play.
    let mut fs = MockFs::new(FILE_ROOT).with_read_delay(Duration::from_millis(2));
    for i in 0..10 {
        fs.file(&format!("p/f{i:02}.md"), "alpha\n");
        fs.file(&format!("q/g{i:02}.md"), "alpha\n");
    }
    let mut sink = |_p: SearchProgress| {
        fs.mark_stopped();
        SearchControl::Stop
    };
    let summary = search_in_folder_streaming(&fs, &fs.root, QUERY, &mut sink, &|| false).await.expect("search");
    assert!(summary.stopped);
    assert_eq!(fs.calls_after_stop(), 0);
    let q_prefix = fs.abs_path("q");
    assert!(
        !fs.read_calls().iter().any(|p| p.starts_with(&q_prefix)),
        "second directory must not be read once the first batch was refused"
    );
}

// ---------------------------------------------------------------------------
// AC-55-37 — d-3: ResultStore::begin / is_current
// ---------------------------------------------------------------------------

#[test]
fn is_current_is_true_when_nothing_was_begun() {
    let store = ResultStore::new();
    assert!(store.is_current("main", 1));
    assert!(store.is_current("main", 42));
}

#[test]
fn begin_marks_the_latest_generation_and_older_ones_are_no_longer_current() {
    let mut store = ResultStore::new();
    store.begin("main", 1);
    assert!(store.is_current("main", 1));
    store.begin("main", 2);
    assert!(!store.is_current("main", 1), "generation 1 is superseded by 2");
    assert!(store.is_current("main", 2));
    // A generation newer than anything begun is not superseded.
    assert!(store.is_current("main", 3));
    store.begin("main", 5);
    assert!(!store.is_current("main", 2));
    assert!(!store.is_current("main", 3));
    assert!(!store.is_current("main", 4));
    assert!(store.is_current("main", 5));
}

#[test]
fn begin_with_an_older_generation_does_not_lower_the_latest() {
    let mut store = ResultStore::new();
    store.begin("main", 3);
    store.begin("main", 2);
    assert!(!store.is_current("main", 2));
    assert!(store.is_current("main", 3));
}

#[test]
fn begin_is_per_window_label() {
    let mut store = ResultStore::new();
    store.begin("main", 9);
    assert!(store.is_current("second", 1), "another window is unaffected");
    store.begin("second", 4);
    assert!(!store.is_current("second", 3));
    assert!(store.is_current("second", 4));
    assert!(!store.is_current("main", 8));
    assert!(store.is_current("main", 9));
}

#[test]
fn forget_clears_the_latest_generation_too() {
    let mut store = ResultStore::new();
    store.begin("main", 7);
    store.store("main", 7, vec![hit("a.md", 1, 1, "alpha")]);
    store.forget("main");
    assert!(store.is_current("main", 1), "a closed window has no latest generation");
    assert!(store.page("main", 7, 0, PAGE_SIZE).is_empty());
}

#[test]
fn begin_does_not_change_store_and_page_rules() {
    let mut store = ResultStore::new();
    let hits: Vec<SearchHit> = (1..=5).map(|i| hit("a.md", i, i, "alpha")).collect();
    store.begin("main", 1);
    let r1 = store.store("main", 1, hits.clone());
    assert_eq!(r1.total, 5);
    assert_eq!(r1.hits, hits);
    assert_eq!(store.page("main", 1, 2, 2), hits[2..4].to_vec());

    // A newer generation begins; the previous generation's stored page is still what it was
    // until the new generation stores (the front end drops it by generation anyway).
    store.begin("main", 2);
    assert!(!store.is_current("main", 1));
    let r2 = store.store("main", 2, hits[..2].to_vec());
    assert_eq!(r2.total, 2);
    assert!(store.page("main", 1, 0, PAGE_SIZE).is_empty(), "old generation is dropped on store");
    assert_eq!(store.page("main", 2, 0, PAGE_SIZE), hits[..2].to_vec());

    // The existing rule: a late store from an older generation does not replace a newer one.
    let r_old = store.store("main", 1, hits.clone());
    assert_eq!(r_old.generation, 1);
    assert_eq!(store.page("main", 2, 0, PAGE_SIZE), hits[..2].to_vec());
    assert!(store.page("main", 1, 0, PAGE_SIZE).is_empty());
}

// ---------------------------------------------------------------------------
// AC-55-38 — source scan of commands/search.rs (begin -> streaming -> emit_to)
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

fn search_command_code() -> String {
    strip_line_comments(include_str!("../src/commands/search.rs"))
}

fn search_module_code() -> String {
    strip_line_comments(include_str!("../src/search/mod.rs"))
}

/// The body of `search_in_folder` (from its `#[tauri::command]` to the next one or EOF).
fn search_in_folder_body(code: &str) -> String {
    let at = code.find("fn search_in_folder(").expect("search_in_folder command exists");
    let rest = &code[at..];
    let end = rest[1..].find("#[tauri::command]").map(|i| i + 1).unwrap_or(rest.len());
    rest[..end].to_string()
}

#[test]
fn command_begins_the_generation_then_streams() {
    let body = search_in_folder_body(&search_command_code());
    let begin = body.find(".begin(").expect("search_in_folder must call ResultStore::begin");
    let stream = body
        .find("search_in_folder_streaming(")
        .expect("search_in_folder must call search_in_folder_streaming");
    assert!(begin < stream, "begin(window.label(), generation) must precede the scan");
    assert!(
        !body.contains("search_in_folder_with("),
        "the command streams; the buffered helper is for callers without a window"
    );
}

/// 要件#55 追補f の要件側更新で読み替え: `.is_current(` → `.is_current_at(`(cancel の形も
/// `|| !…is_current_at(`)。走査範囲とほかの断言は不変。
#[test]
fn command_stops_the_scan_when_the_generation_is_no_longer_current() {
    let body = search_in_folder_body(&search_command_code());
    assert!(body.contains(".is_current_at("), "the sink must ask ResultStore::is_current_at");
    assert!(body.contains("SearchControl::Stop"), "the sink must return SearchControl::Stop");
    assert!(body.contains("SearchControl::Continue"));

    // d-3 supplement: the `cancel` argument is a closure that negates `is_current_at`
    // (`!` and `.is_current_at(` inside the same closure).
    let negated_in_closure = body.match_indices(".is_current_at(").any(|(i, _)| {
        let before = &body[..i];
        let closure_start = before.rfind("||").or_else(|| before.rfind("| |"));
        match closure_start {
            Some(start) => {
                let segment = &before[start..];
                !segment.contains(';') && segment.contains('!')
            }
            None => false,
        }
    });
    assert!(
        negated_in_closure,
        "search_in_folder must pass `cancel` as a closure of the form `|| !...is_current_at(label, epoch, generation)`"
    );
}

#[test]
fn command_emits_progress_and_done_to_its_own_window_only() {
    let code = search_command_code();
    let body = search_in_folder_body(&code);
    assert!(body.contains("SEARCH_PROGRESS_EVENT"), "progress event name comes from search::SEARCH_PROGRESS_EVENT");
    assert!(body.contains("SEARCH_DONE_EVENT"), "done event name comes from search::SEARCH_DONE_EVENT");
    assert!(body.contains("emit_to("), "events go to the window that asked (emit_to)");
    assert!(body.contains("window.label()"), "the target is the window's own label");
    assert!(!code.contains(".emit("), "no broadcast emit in commands/search.rs");
    assert!(code.contains("SearchProgressEvent"));
    assert!(code.contains("SearchDoneEvent"));
    for name in ["\"search_progress\"", "\"search_done\""] {
        assert!(!code.contains(name), "event names must not be spelled inline: {name}");
    }
}

#[test]
fn event_name_constants_live_in_search_module() {
    let code = search_module_code();
    assert!(code.contains("pub const SEARCH_PROGRESS_EVENT: &str = \"search_progress\";"));
    assert!(code.contains("pub const SEARCH_DONE_EVENT: &str = \"search_done\";"));
    assert!(code.contains("pub const BATCH_MAX_HITS: usize = 10;"));
    assert!(code.contains("pub const BATCH_MAX_WAIT_MS: u64 = 200;"));
}

#[test]
fn file_provider_trait_is_unchanged_by_the_streaming_scan() {
    // d-1..d-3 are implemented above the provider: the trait keeps its method set.
    let src = strip_line_comments(include_str!("../src/fs/provider.rs"));
    let names: BTreeSet<&str> = src
        .match_indices("async fn ")
        .map(|(i, _)| {
            let rest = &src[i + "async fn ".len()..];
            &rest[..rest.find('(').unwrap()]
        })
        .chain(std::iter::once("scheme"))
        .collect();
    let expected: BTreeSet<&str> =
        ["scheme", "list", "stat", "read_bytes", "read_range", "read_text", "write_text", "watch"]
            .into_iter()
            .collect();
    assert_eq!(names, expected);
}

#[test]
fn no_new_runtime_dependency_for_the_parallel_reads() {
    // d-2 is built from tokio (already a dependency); `futures` is not declared.
    let cargo = include_str!("../Cargo.toml");
    let deps = cargo.split("[dependencies]").nth(1).expect("[dependencies]");
    let deps = deps.split("\n[").next().unwrap();
    for line in deps.lines() {
        let key = line.split('=').next().unwrap_or("").trim();
        assert!(
            !(key == "futures" || key == "futures-util" || key == "rayon"),
            "unexpected new dependency for the parallel reads: {line}"
        );
    }
    assert!(deps.contains("tokio"));
}
