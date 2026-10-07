//! フォルダ横断検索(要件#55 契約②〜⑤)。
//!
//! 開いている root フォルダの配下を `FileProvider` 経由で再帰的に走査し、
//! 大文字小文字を区別しない部分一致で「どのファイルのどの行に語があるか」を集める。
//! `FileProvider::list` は1階層だけなので、再帰はここで自前に降りる。
//!
//! - 走査は各ディレクトリの `list` の戻りを名前順に並べてから深さ優先で降りる
//!   (=走査順がパス順・`list` の返す順序に依らず決定的=契約④・追補d)。最後に並べ替えない。
//!   名前順で連続するファイルの読み込みは同時 8 本まで並列(追補d d-2)
//! - 見つかった一致は 10 件か 200ms ごとのバッチで sink に渡し、sink の `Stop` で打ち切る
//!   (追補d d-1 / d-3=[`search_in_folder_streaming`])
//! - 除外=設定(要件#65)の `files.exclude` と `search.exclude` と検索パネルの欄を、root からの
//!   相対パスに glob で当てる([`SearchScope`]・判定は `crate::exclude`)。ディレクトリは再帰の
//!   手前で切る(`list` も呼ばない)。既定値は `.` 始まりの名前と [`EXCLUDED_DIR_NAMES`] の
//!   ディレクトリ=要件#55 の除外と同じ
//! - シンボリックリンクは辿らない。ssh は `Entry.kind == Symlink` で、local は
//!   `LocalProvider::list` がリンク先の種別を返す(要件#31)ので、ここで
//!   `symlink_metadata` を見て判定する(読み取りのみ・trait は無改変=req-55.md
//!   「契約②と⑤の間の欠落」)
//! - 読むのはテキスト扱いの拡張子だけ(`src/lib/file-type.ts` の鏡=[`NON_TEXT_EXTENSIONS`]
//!   の補集合)。NUL を含むもの・UTF-8 でないものは静かに飛ばす
//! - サイズ・件数の上限は設けない(2026-09-16 由谷決定)
//! - 書き込み系(`write_text`)は一切呼ばない

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::task::Poll;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::errors::FsError;
use crate::exclude::{is_builtin_excluded, path_or_ancestor_matches};
use crate::fs::entry::{Entry, FileKind};
use crate::fs::provider::FileProvider;
use crate::fs::uri::Uri;
use crate::settings::Settings;

/// 名前で判定して再帰の手前で切るディレクトリ名(契約②)。要件#65 からは `search.exclude` の
/// 既定値(`**/<名前>`)の元(`settings::Settings::default`)。
pub const EXCLUDED_DIR_NAMES: &[&str] =
    &[".git", "node_modules", "target", "dist", "build", ".svelte-kit"];

/// `src/lib/file-type.ts` で `text` 以外に分類される拡張子の和集合(小文字)。
///
/// file-type.ts は「どの集合にも無ければ text」なので、テキスト扱いの集合は開集合。
/// Rust 側はこの**非テキスト集合**を鏡として持ち、その補集合を読む。並びは
/// file-type.ts の IMAGE / MODEL3D / VIDEO / AUDIO / PDF / BINARY の順
/// (値の一致は `tests/acceptance_req55.rs` が file-type.ts から抽出して突き合わせる)。
pub const NON_TEXT_EXTENSIONS: &[&str] = &[
    // IMAGE_EXTENSIONS
    "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg",
    // MODEL3D_EXTENSIONS
    "stl", "3mf", "obj", "ply",
    // VIDEO_EXTENSIONS
    "mp4", "mov", "webm", "mkv", "avi",
    // AUDIO_EXTENSIONS
    "wav", "mp3", "m4a",
    // PDF_EXTENSIONS
    "pdf",
    // BINARY_EXTENSIONS
    "tiff", "tif", "heic", "zip", "gz", "bz2", "xz", "7z", "rar", "tar", "doc", "docx", "xls",
    "xlsx", "ppt", "pptx", "exe", "dll", "so", "dylib", "bin", "wasm", "class", "jar", "pyc",
    "woff", "woff2", "ttf", "otf", "eot", "flac", "ogg", "sqlite", "db", "dmg", "iso",
];

/// 小文字の拡張子(ドット無し・無ければ "")がテキスト扱いか
/// (= markdown / html / text のどれか= [`NON_TEXT_EXTENSIONS`] に無い)。
pub fn is_text_extension(ext: &str) -> bool {
    !NON_TEXT_EXTENSIONS.contains(&ext)
}

/// ファイル名(最後の `/` の後ろ)から file-type.ts の `extensionOf` と同じ規則で
/// 拡張子を取り(最後の `.` の後ろ・小文字化・`.` が無いか先頭だけなら "")、
/// [`is_text_extension`] に通す。
pub fn is_text_file_name(name: &str) -> bool {
    let segment = name.rsplit('/').next().unwrap_or(name);
    let ext = match segment.rfind('.') {
        Some(dot) if dot > 0 => segment[dot + 1..].to_lowercase(),
        _ => String::new(),
    };
    is_text_extension(&ext)
}

/// 一致 1 件。`path` は root からの相対(`/` 区切り・先頭 `/` 無し)、`line` は 1 始まり、
/// `text` は当該行の原文(行末の `\n` / `\r\n` を除く)。打ち切りフラグは存在しない(契約④)。
/// `ordinal` はそのファイルの先頭からの語の出現の通し番号(1 始まり・大小無視・重ならない出現・
/// 1 行に複数あれば最初の出現の番号=追補a)。フロントは `ordinal - 1` を要件#54 の番目に使う。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SearchHit {
    pub path: String,
    pub line: u32,
    pub text: String,
    pub ordinal: u32,
}

/// local の実体がシンボリックリンクか。`LocalProvider::list` はリンク先の種別を返すので
/// `Entry.kind` では見分けられない(req-55.md「契約②と⑤の間の欠落」)。
/// 調べられなければリンクではないとみなし、`Entry.kind` の判定に任せる。
async fn is_local_symlink(root: &Uri, uri: &Uri) -> bool {
    if root.scheme != "file" {
        return false;
    }
    tokio::fs::symlink_metadata(&uri.path)
        .await
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// ファイルの中身を丸ごと読む。上限は設けない(契約③)ので、`LocalProvider::read_bytes`
/// が大きさを理由に断ったときは上限を持たない `read_range` で読み直す。
async fn read_whole(provider: &dyn FileProvider, uri: &Uri) -> Result<Vec<u8>, FsError> {
    match provider.read_bytes(uri).await {
        Err(FsError::FileTooLarge(_)) => provider.read_range(uri, 0, u64::MAX).await,
        other => other,
    }
}

/// 1 ファイル分の一致を `hits` に足す(契約③④⑥)。NUL を含む・UTF-8 でないものは飛ばす。
fn collect_hits(rel: &str, bytes: &[u8], query_lower: &str, hits: &mut Vec<SearchHit>) {
    if bytes.contains(&0) {
        return;
    }
    let Ok(content) = std::str::from_utf8(bytes) else {
        return;
    };
    // Occurrences seen so far in this file (non-overlapping, case-insensitive,
    // the same rule as `findMatches` on the front end).
    let mut seen: u32 = 0;
    for (i, raw) in content.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let count = line.to_lowercase().matches(query_lower).count() as u32;
        if count > 0 {
            hits.push(SearchHit {
                path: rel.to_string(),
                line: (i + 1) as u32,
                text: line.to_string(),
                ordinal: seen + 1,
            });
            seen += count;
        }
    }
}

/// 走査の本体を「全部ためる sink」で呼ぶ薄い層(窓を持たない呼び出し元・テスト用)。
///
/// 空文字の `query` は `Ok(vec![])` で、`list` も `read_bytes` も呼ばない。
/// root 自体が一覧できなければ Err。配下のディレクトリ・ファイルが読めないときは
/// そこだけ飛ばして走査を続ける(検索を止めない=fail-open)。
/// 戻りは走査順=名前順の深さ優先(=パス順・行番号順。[`search_in_folder_streaming`])。
///
/// 除外は既定値([`SearchScope::default`]=要件#55 の除外と同じ)。設定と検索パネルの欄を
/// 効かせるなら [`SearchScope::search_in_folder_with`]。
pub async fn search_in_folder_with(
    provider: &dyn FileProvider,
    root: &Uri,
    query: &str,
) -> Result<Vec<SearchHit>, FsError> {
    SearchScope::default().search_in_folder_with(provider, root, query).await
}

// ---------------------------------------------------------------------------
// 除外の設定と検索パネルの欄(要件#65 契約1・13)
// ---------------------------------------------------------------------------

/// 検索パネルの欄(要件#65 契約13)。`include` / `exclude` は glob の並び(各要素は trim して
/// 使い、空要素・空白だけの要素は無視)。`use_exclude_settings` は歯車(Use Exclude Settings)。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchFilter {
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub use_exclude_settings: bool,
}

impl Default for SearchFilter {
    /// 欄は空・歯車は ON(=設定の除外だけが効く)。
    fn default() -> Self {
        Self { include: Vec::new(), exclude: Vec::new(), use_exclude_settings: true }
    }
}

/// 1 回の検索が使う設定と欄。`Default` は既定の設定と空の欄=要件#55 の除外と同じ。
#[derive(Clone, Debug, Default)]
pub struct SearchScope {
    pub settings: Settings,
    pub filter: SearchFilter,
}

impl SearchScope {
    pub fn new(settings: Settings, filter: SearchFilter) -> Self {
        Self { settings, filter }
    }

    /// 走査の本体(引数・戻り・バッチ・打ち切りは free fn の [`search_in_folder_streaming`] と同じ)。
    /// 除外はこの scope の設定と欄(要件#65 契約13 の判定順=[`ScanRules`])。
    pub async fn search_in_folder_streaming(
        &self,
        provider: &dyn FileProvider,
        root: &Uri,
        query: &str,
        sink: &mut (dyn FnMut(SearchProgress) -> SearchControl + Send),
        cancel: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<SearchSummary, FsError> {
        scan(&self.rules(), provider, root, query, sink, cancel).await
    }

    /// 全部ためる薄い層(戻りは free fn の [`search_in_folder_with`] と同じ)。
    pub async fn search_in_folder_with(
        &self,
        provider: &dyn FileProvider,
        root: &Uri,
        query: &str,
    ) -> Result<Vec<SearchHit>, FsError> {
        let mut hits = Vec::new();
        let mut sink = |p: SearchProgress| {
            hits.extend(p.hits);
            SearchControl::Continue
        };
        self.search_in_folder_streaming(provider, root, query, &mut sink, &|| false).await?;
        Ok(hits)
    }

    fn rules(&self) -> ScanRules<'_> {
        ScanRules {
            files_exclude: self.settings.active_files_exclude(),
            search_exclude: if self.filter.use_exclude_settings {
                self.settings.active_search_exclude()
            } else {
                Vec::new()
            },
            field_exclude: field_patterns(&self.filter.exclude),
            include: field_patterns(&self.filter.include),
        }
    }
}

/// 欄の要素を trim し、空要素・空白だけの要素を落とす(契約13)。
fn field_patterns(patterns: &[String]) -> Vec<&str> {
    patterns.iter().map(|p| p.trim()).filter(|p| !p.is_empty()).collect()
}

/// 走査 1 回分の判定(要件#65 契約13 の判定順)。パターンは root からの相対パス全体に当て、
/// フォルダに当たれば配下全部([`path_or_ancestor_matches`])。
struct ScanRules<'a> {
    files_exclude: Vec<&'a str>,
    /// 歯車 OFF なら空。
    search_exclude: Vec<&'a str>,
    field_exclude: Vec<&'a str>,
    /// 空なら全部が対象。
    include: Vec<&'a str>,
}

impl ScanRules<'_> {
    /// 組み込み → files.exclude → search.exclude → 欄の exclude。ディレクトリもファイルも
    /// これで切る(ディレクトリは `list` の手前で切れる)。
    fn excludes(&self, rel: &str) -> bool {
        is_builtin_excluded(rel)
            || path_or_ancestor_matches(&self.files_exclude, rel)
            || path_or_ancestor_matches(&self.search_exclude, rel)
            || path_or_ancestor_matches(&self.field_exclude, rel)
    }

    /// 欄の include(ファイルだけに当てる。`docs/**` に対する `docs` のような途中の
    /// ディレクトリは切らない=配下に当たるものがありうる)。
    fn includes_file(&self, rel: &str) -> bool {
        self.include.is_empty() || path_or_ancestor_matches(&self.include, rel)
    }
}

// ---------------------------------------------------------------------------
// 見つかった順に段階的に出す・並列読み・打ち切り(追補d)
// ---------------------------------------------------------------------------

/// Tauri イベント名(フロントの `src/lib/find-in-folder.ts` と同綴り)。
pub const SEARCH_PROGRESS_EVENT: &str = "search_progress";
pub const SEARCH_DONE_EVENT: &str = "search_done";

/// バッチの規則(d-1): 10 件たまるか、前回の送信から 200ms 経過で送る。
pub const BATCH_MAX_HITS: usize = 10;
pub const BATCH_MAX_WAIT_MS: u64 = 200;

/// 同じディレクトリ内で同時に発行する `read_bytes` の上限(d-2)。
const MAX_PARALLEL_READS: usize = 8;

/// バッチを送る規則。
#[derive(Clone, Copy, Debug)]
pub struct BatchPolicy {
    pub max_hits: usize,
    pub max_wait: Duration,
}

impl Default for BatchPolicy {
    fn default() -> Self {
        Self { max_hits: BATCH_MAX_HITS, max_wait: Duration::from_millis(BATCH_MAX_WAIT_MS) }
    }
}

/// 送るか。pending == 0 なら常に false。pending >= max_hits で true。
/// pending >= 1 かつ since_last >= max_wait で true。
pub fn should_flush(pending: usize, since_last: Duration, policy: &BatchPolicy) -> bool {
    pending > 0 && (pending >= policy.max_hits || since_last >= policy.max_wait)
}

/// sink に渡す 1 バッチ。`hits` は走査順・1 件以上・`max_hits` 件以下。
/// `files_scanned` = ここまでに読み終えたテキストファイル数(単調増加)。
#[derive(Clone, Debug)]
pub struct SearchProgress {
    pub hits: Vec<SearchHit>,
    pub files_scanned: usize,
}

/// sink の返事。`Stop` で走査を打ち切る(d-3)。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchControl {
    Continue,
    Stop,
}

/// 走査の結果。`total` = sink に渡した一致の総数・`files` = 一致のあったファイル数
/// (sink に渡した分)・`stopped` = sink の `Stop` で打ち切った。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchSummary {
    pub total: usize,
    pub files: usize,
    pub stopped: bool,
}

/// `search_progress` イベントの payload。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProgressEvent {
    pub generation: u64,
    pub hits: Vec<SearchHit>,
    pub files_scanned: usize,
}

/// `search_done` イベントの payload。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchDoneEvent {
    pub generation: u64,
    pub total: usize,
    pub files: usize,
}

/// バッチを組んで sink に渡す係。
struct Batcher<'s> {
    sink: &'s mut (dyn FnMut(SearchProgress) -> SearchControl + Send),
    policy: BatchPolicy,
    pending: Vec<SearchHit>,
    last_flush: Instant,
    files_scanned: usize,
    total: usize,
    files: usize,
    last_path: Option<String>,
}

impl Batcher<'_> {
    /// `n` 件を先頭から送る。`Stop` なら false。
    fn send(&mut self, n: usize) -> bool {
        let hits: Vec<SearchHit> = self.pending.drain(..n).collect();
        for h in &hits {
            if self.last_path.as_deref() != Some(h.path.as_str()) {
                self.files += 1;
                self.last_path = Some(h.path.clone());
            }
        }
        self.total += hits.len();
        self.last_flush = Instant::now();
        let control = (self.sink)(SearchProgress { hits, files_scanned: self.files_scanned });
        control == SearchControl::Continue
    }

    /// 規則に当たる分を送る。`Stop` なら false。
    fn flush_due(&mut self) -> bool {
        while self.pending.len() >= self.policy.max_hits {
            if !self.send(self.policy.max_hits) {
                return false;
            }
        }
        if should_flush(self.pending.len(), self.last_flush.elapsed(), &self.policy) {
            return self.send(self.pending.len());
        }
        true
    }

    /// 残りを全部送る(max_hits ずつ)。`Stop` なら false。
    fn flush_all(&mut self) -> bool {
        while !self.pending.is_empty() {
            let n = self.pending.len().min(self.policy.max_hits);
            if !self.send(n) {
                return false;
            }
        }
        true
    }

    fn summary(&self, stopped: bool) -> SearchSummary {
        SearchSummary { total: self.total, files: self.files, stopped }
    }
}

type ReadFuture<'a> = Pin<Box<dyn Future<Output = Result<Vec<u8>, FsError>> + Send + 'a>>;

enum ReadSlot<'a> {
    Running(ReadFuture<'a>),
    Done(Result<Vec<u8>, FsError>),
}

/// 同時 [`MAX_PARALLEL_READS`] 本までの読み込みを発行順に受け取る(`buffered` 相当・依存なし)。
struct OrderedReads<'a> {
    slots: VecDeque<ReadSlot<'a>>,
}

impl<'a> OrderedReads<'a> {
    fn new() -> Self {
        Self { slots: VecDeque::new() }
    }

    fn has_room(&self) -> bool {
        self.slots.len() < MAX_PARALLEL_READS
    }

    fn push(&mut self, fut: ReadFuture<'a>) {
        self.slots.push_back(ReadSlot::Running(fut));
    }

    /// 走っているものを全部進め、先頭(発行順で最古)が済んだらそれを返す。
    async fn next(&mut self) -> Option<Result<Vec<u8>, FsError>> {
        if self.slots.is_empty() {
            return None;
        }
        std::future::poll_fn(|cx| {
            for slot in self.slots.iter_mut() {
                if let ReadSlot::Running(fut) = slot {
                    if let Poll::Ready(out) = fut.as_mut().poll(cx) {
                        *slot = ReadSlot::Done(out);
                    }
                }
            }
            if matches!(self.slots.front(), Some(ReadSlot::Done(_))) {
                if let Some(ReadSlot::Done(out)) = self.slots.pop_front() {
                    return Poll::Ready(Some(out));
                }
            }
            Poll::Pending
        })
        .await
    }
}

/// 1 ディレクトリの走査対象(除外・リンク・非テキスト・include に当たらないファイルを落とし、
/// 名前順に並べたもの)。`dir_rel` は `dir` の root からの相対パス(root なら "")。
async fn scan_entries(
    rules: &ScanRules<'_>,
    root: &Uri,
    dir: &Uri,
    dir_rel: &str,
    entries: Vec<Entry>,
) -> Vec<(Entry, Uri)> {
    let mut kept = Vec::with_capacity(entries.len());
    for entry in entries {
        if entry.kind == FileKind::Symlink {
            continue;
        }
        let rel = join_rel(dir_rel, &entry.name);
        if rules.excludes(&rel) {
            continue;
        }
        if entry.kind == FileKind::File
            && (!is_text_file_name(&entry.name) || !rules.includes_file(&rel))
        {
            continue;
        }
        let uri = dir.with_path(dir.path.join(&entry.name));
        if is_local_symlink(root, &uri).await {
            continue;
        }
        kept.push((entry, uri));
    }
    kept.sort_by(|a, b| a.0.name.cmp(&b.0.name));
    kept
}

fn join_rel(dir_rel: &str, name: &str) -> String {
    if dir_rel.is_empty() {
        name.to_string()
    } else {
        format!("{dir_rel}/{name}")
    }
}

/// 走査の本体(streaming・Tauri command `search_in_folder` はこれを呼ぶ)。
///
/// 各ディレクトリの `list` の戻りを**名前順**(kind を問わず `Entry.name` の `Ord`)に並べて
/// 深さ優先で降りる=走査順がパス順。最後に並べ替えない。名前順で連続するファイルの
/// `read_bytes` は同時 8 本まで並列に発行し(d-2)、結果は名前順に受け取ってバッチに載せる。
/// バッチは [`BatchPolicy`] の既定(10 件 or 200ms)で、最後に残りを送る。sink が `Stop` を
/// 返したら以後 `list` / `read_bytes` を発行せず `stopped: true` で返す(d-3)。
/// `cancel` は各ディレクトリの `list` 前(root 含む)と各ファイルの `read_bytes` 前に呼び、
/// true なら以後 `list` / `read_bytes` を発行せず、sink も呼ばずに `stopped: true` で返す
/// (一致が無く sink に問えない古い走査も止める=d-3 の補足)。
/// 空文字の query は sink を呼ばず `total: 0`。root 自体が一覧できなければ Err、
/// 配下の読み取り失敗はそこだけ飛ばす(fail-open)。
///
/// 除外は既定値([`SearchScope::default`])。設定と欄を効かせるなら
/// [`SearchScope::search_in_folder_streaming`](Tauri command はそちらを呼ぶ)。
pub async fn search_in_folder_streaming(
    provider: &dyn FileProvider,
    root: &Uri,
    query: &str,
    sink: &mut (dyn FnMut(SearchProgress) -> SearchControl + Send),
    cancel: &(dyn Fn() -> bool + Send + Sync),
) -> Result<SearchSummary, FsError> {
    SearchScope::default().search_in_folder_streaming(provider, root, query, sink, cancel).await
}

/// 走査の本体([`SearchScope::search_in_folder_streaming`] の中身)。
async fn scan(
    rules: &ScanRules<'_>,
    provider: &dyn FileProvider,
    root: &Uri,
    query: &str,
    sink: &mut (dyn FnMut(SearchProgress) -> SearchControl + Send),
    cancel: &(dyn Fn() -> bool + Send + Sync),
) -> Result<SearchSummary, FsError> {
    let mut batch = Batcher {
        sink,
        policy: BatchPolicy::default(),
        pending: Vec::new(),
        last_flush: Instant::now(),
        files_scanned: 0,
        total: 0,
        files: 0,
        last_path: None,
    };
    if query.is_empty() {
        return Ok(batch.summary(false));
    }
    let query_lower = query.to_lowercase();

    // 深さ優先のフレーム: (ディレクトリの相対パス, 残りの対象=名前順)。
    if cancel() {
        return Ok(batch.summary(true));
    }
    let root_entries = provider.list(root).await?;
    let mut frames: Vec<(String, VecDeque<(Entry, Uri)>)> =
        vec![(String::new(), scan_entries(rules, root, root, "", root_entries).await.into())];

    while let Some((dir_rel, queue)) = frames.last_mut() {
        let Some((entry, uri)) = queue.pop_front() else {
            frames.pop();
            continue;
        };
        let dir_rel = dir_rel.clone();
        match entry.kind {
            FileKind::Dir => {
                if !batch.flush_due() {
                    return Ok(batch.summary(true));
                }
                let rel = join_rel(&dir_rel, &entry.name);
                if cancel() {
                    return Ok(batch.summary(true));
                }
                if let Ok(children) = provider.list(&uri).await {
                    let kept = scan_entries(rules, root, &uri, &rel, children).await;
                    frames.push((rel, kept.into()));
                }
            }
            FileKind::File => {
                // 名前順で連続するファイルをまとめて並列に読む(次のディレクトリの手前まで)。
                let mut run: VecDeque<(String, Uri)> = VecDeque::new();
                run.push_back((join_rel(&dir_rel, &entry.name), uri));
                while let Some((next, _)) = queue.front() {
                    if next.kind != FileKind::File {
                        break;
                    }
                    let (next, next_uri) = queue.pop_front().expect("front exists");
                    run.push_back((join_rel(&dir_rel, &next.name), next_uri));
                }
                let mut reads = OrderedReads::new();
                let mut issued = 0usize;
                let mut rels: VecDeque<String> = VecDeque::new();
                loop {
                    while reads.has_room() && issued < run.len() {
                        if cancel() {
                            return Ok(batch.summary(true));
                        }
                        let (rel, uri) = run[issued].clone();
                        rels.push_back(rel);
                        reads.push(Box::pin(async move { read_whole(provider, &uri).await }));
                        issued += 1;
                    }
                    let Some(result) = reads.next().await else { break };
                    let rel = rels.pop_front().expect("one rel per read");
                    batch.files_scanned += 1;
                    if let Ok(bytes) = result {
                        collect_hits(&rel, &bytes, &query_lower, &mut batch.pending);
                    }
                    if !batch.flush_due() {
                        return Ok(batch.summary(true));
                    }
                }
            }
            FileKind::Symlink => {}
        }
    }

    if !batch.flush_all() {
        return Ok(batch.summary(true));
    }
    Ok(batch.summary(false))
}

// ---------------------------------------------------------------------------
// 結果を段階的に渡す(追補a・案 1)
// ---------------------------------------------------------------------------

/// 1 ページの件数(`search_in_folder` の初回応答と `search_in_folder_page` の既定)。
pub const PAGE_SIZE: usize = 200;

/// `search_in_folder` command の戻り。`total` = 一致の総件数・`files` = 一致ファイル数
/// (いずれも全件の値)・`hits` = 先頭 [`PAGE_SIZE`] 件(パス順・行番号順の先頭)。
#[derive(Clone, Debug, Serialize)]
pub struct SearchResponse {
    pub generation: u64,
    pub total: usize,
    pub files: usize,
    pub hits: Vec<SearchHit>,
}

/// 窓ラベル×世代で直近の検索結果(全件)を保持する。1 窓につき 1 世代分だけ持ち、
/// 新しい世代を `store` すると前の世代は捨てる。窓が閉じたら `forget` で捨てる。
#[derive(Default)]
pub struct ResultStore {
    by_label: HashMap<String, (u64, Vec<SearchHit>)>,
    /// 窓ごとの最新世代(走査の開始時に `begin` で記録=追補d d-3)。
    latest: HashMap<String, u64>,
    /// 窓ごとのリセット回数(`forget` で +1・`forget` でも消さない=追補f f-1)。無ければ 0。
    epoch: HashMap<String, u64>,
}

impl ResultStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 全件を受け取り、その窓の前の世代を捨てて保持し、初回応答(先頭 [`PAGE_SIZE`] 件)を組む。
    /// 同じ窓により新しい世代が既に保持されていれば保持は変えない(遅れて返った古い世代が
    /// 新しい世代を捨てないため)。応答は受け取った全件から組む(フロントが世代で捨てる)。
    pub fn store(&mut self, label: &str, generation: u64, hits: Vec<SearchHit>) -> SearchResponse {
        let (total, files, head) = response_parts(&hits);
        // Searches of one window run concurrently; an older generation that returns late
        // must not replace a newer one already kept (the front end drops its response anyway).
        let newer_kept = matches!(self.by_label.get(label), Some((kept, _)) if *kept > generation);
        if !newer_kept {
            self.by_label.insert(label.to_string(), (generation, hits));
        }
        SearchResponse { generation, total, files, hits: head }
    }

    /// 続きを切り出す。ラベルが無い・世代が違う・offset が範囲外・limit 0 なら空。
    /// 末尾は短くてよい(`offset..min(offset + limit, total)`)。
    pub fn page(&self, label: &str, generation: u64, offset: usize, limit: usize) -> Vec<SearchHit> {
        match self.by_label.get(label) {
            Some((stored, hits)) if *stored == generation && offset < hits.len() => {
                let end = offset.saturating_add(limit).min(hits.len());
                hits[offset..end].to_vec()
            }
            _ => Vec::new(),
        }
    }

    /// 窓が閉じたら・パネルを開き直したら捨てる(結果も最新世代も)。あわせてその窓の
    /// epoch を 1 増やし、それより前に始まった走査を古くする(追補f f-1・epoch は消さない)。
    pub fn forget(&mut self, label: &str) {
        self.by_label.remove(label);
        self.latest.remove(label);
        *self.epoch.entry(label.to_string()).or_insert(0) += 1;
    }

    /// その窓の最新世代を記録する(走査の開始時=追補d d-3)。小さい世代で呼んでも最新は下がらない。
    /// 戻りはその窓の今の epoch(走査はこれを持ち回る=追補f f-2)。
    pub fn begin(&mut self, label: &str, generation: u64) -> u64 {
        let latest = self.latest.entry(label.to_string()).or_insert(generation);
        *latest = (*latest).max(generation);
        self.current_epoch(label)
    }

    /// より新しい世代が `begin` 済みなら false。`begin` が無い・`forget` 済みの窓は true。
    pub fn is_current(&self, label: &str, generation: u64) -> bool {
        self.latest.get(label).is_none_or(|latest| generation >= *latest)
    }

    /// `epoch` が今の値と同じ、かつ [`Self::is_current`] が真(追補f f-2)。
    pub fn is_current_at(&self, label: &str, epoch: u64, generation: u64) -> bool {
        epoch == self.current_epoch(label) && self.is_current(label, generation)
    }

    /// `epoch` が今の値と違えば保持を変えずに応答だけ組む。同じなら [`Self::store`] と同じ(追補f f-2)。
    pub fn store_at(&mut self, label: &str, epoch: u64, generation: u64, hits: Vec<SearchHit>) -> SearchResponse {
        if epoch == self.current_epoch(label) {
            return self.store(label, generation, hits);
        }
        let (total, files, head) = response_parts(&hits);
        SearchResponse { generation, total, files, hits: head }
    }

    fn current_epoch(&self, label: &str) -> u64 {
        self.epoch.get(label).copied().unwrap_or(0)
    }
}

/// 応答の `total` / `files` / 先頭 [`PAGE_SIZE`] 件を全件から組む。
fn response_parts(hits: &[SearchHit]) -> (usize, usize, Vec<SearchHit>) {
    let total = hits.len();
    let files = hits.iter().map(|h| h.path.as_str()).collect::<HashSet<_>>().len();
    (total, files, hits[..total.min(PAGE_SIZE)].to_vec())
}
