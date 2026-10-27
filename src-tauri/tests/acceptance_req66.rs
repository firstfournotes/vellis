//! 要件#66 の受け入れテスト(docs/requirements/req-66.md)— Rust 層(AC-66-1〜12)
//!
//! 「フォルダ横断検索に Aa / ab / .* の3トグル(大文字小文字の区別・単語単位・正規表現)を付ける」。
//! 照合は今までどおり `src-tauri/src/search/` の1か所で行い、正規表現は `regex` クレート
//! (`Cargo.lock` に既にある 1.12.3)を `Cargo.toml` に直接書いて使う(起案時判断 (b))。
//! 本ファイルは **メモリ上のモック `FileProvider`**(`acceptance_req55.rs` の MockFs と同じ作り・
//! `list` / `read_bytes` の呼び出しを記録)に対して `SearchScope::default().with_options(..)` の
//! 走査を回し、照合の規則は `QueryMatcher` を直接呼んでも判定する。
//!
//! 判定範囲(AC 番号は req-66.md の受け入れ基準):
//! - AC-66-1  全部 OFF は今と同じ(既定の free fn と `MatchOptions::default()` の結果が一致・
//!   `a.c` は `abc` に当たらない・`ALPHA` は `alpha` に当たる)
//! - AC-66-2  Aa(大文字小文字を区別・部分一致のまま)
//! - AC-66-3  ab(前後の文字だけを見る片側の境界・`_` は単語の文字・語の端が記号・`.` は文字のまま)
//! - AC-66-4  単語の文字= Unicode の `\w`(`café`・`v`・仮名・漢字も単語の文字)
//! - AC-66-5  正規表現(`regex` の構文・Aa との組み合わせ・ab との組み合わせ)
//! - AC-66-6  組み合わせ 8 通りの表(語 `Foo.`・5 行のファイル)
//! - AC-66-7  長さ 0 の一致は数えない(`^`・`$`・`\b`・`^$` は 0 件・`a*` / `x?` は文字を含む行だけ)・
//!   `find_in_line` の範囲(バイト範囲・左から重ならず・長さ 1 以上)
//! - AC-66-8  行単位(`\n` を含む式は当たらない・CRLF でも `foo$` が当たり `text` に `\r` が無い・行番号)
//! - AC-66-9  壊れた式(`QueryMatcher::new` が Err・文言の値固定・走査しない=`list` も `read_bytes` も
//!   sink も呼ばれず 0 件で panic しない・.* OFF の `(` は文字のまま)
//! - AC-66-10 番目(`ordinal` は要件#54 の数え方=跳ぶときに渡す語 J の `to_lowercase` の重ならない出現・
//!   ファイルごとに 1 から)と `matched`(.* ON のときだけ値・JSON には値があるときだけ出る)
//! - AC-66-11 command と照合の置き場(ソース走査: `search_in_folder` の 3 引数と使用・
//!   `INVALID_PATTERN_MESSAGE`・`begin` → `QueryMatcher::new` → `search_in_folder_streaming(` の順・
//!   `regex` の字面は `src/search/` の下だけ・フロント 2 ファイルに `RegExp` が無い・command の一覧・
//!   Rust と TS の文言の突き合わせ)
//! - AC-66-12 依存(`[dependencies]` の集合= 周回開始時点 + `regex`・値は `"1"`・`Cargo.lock` の
//!   `regex` は 1.12.3・target / dev / build は不変)
//!
//! 人間ゲート 1〜5 に送った範囲(本ファイルでは判定しない): トグルの見た目・全部 OFF で実フォルダの
//! 結果が今と同じこと・実機で要件#54 へ跳んだときの見え方・ssh の root。フロント(トグルの表示・
//! invoke の引数・再検索・壊れた式の表示・覚え方・結果クリック)は `src/components/FindInFolder.wiring.test.ts`
//! (AC-66-13〜17)と `src/lib/find-in-folder.acceptance.test.ts`(AC-66-18)。
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前・公開パス)
//!
//! ```ignore
//! // --- src-tauri/src/search/mod.rs に追加(既存の pub は無改変)---
//!
//! /// 3 トグル(契約2)。`Default` = 3 つとも false(= 今の規則)。
//! #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
//! pub struct MatchOptions { pub match_case: bool, pub whole_word: bool, pub use_regex: bool }
//!
//! /// 壊れた正規表現(契約5)。中身は裁量(本テストは `is_err()` だけを見る)。
//! pub struct InvalidPattern { .. }
//!
//! /// 壊れた式のときに command が返す文言(契約5・値固定)。フロントの
//! /// `FIND_IN_FOLDER_INVALID_REGEX`(src/lib/find-in-folder.ts)と同じ値。
//! pub const INVALID_PATTERN_MESSAGE: &str = "Invalid regular expression";
//!
//! /// 語とトグルから組んだ照合器(契約2〜5)。
//! pub struct QueryMatcher { .. }
//! impl QueryMatcher {
//!     /// 全部 OFF なら `to_lowercase` の部分一致(regex を通さない)。.* OFF の語は `regex::escape`。
//!     /// ab ON は `\b{start-half}(?:E)\b{end-half}` で包む。Aa OFF(全部 OFF 以外)は `case_insensitive(true)`。
//!     /// .* ON で組めない式は Err。
//!     pub fn new(query: &str, options: MatchOptions) -> Result<QueryMatcher, InvalidPattern>;
//!     /// 1 行(行末の `\n` / `\r\n` を除いたもの)の中の**長さ 1 以上**の一致のバイト範囲を
//!     /// 左から重ならずに(`find_iter` の順)。長さ 0 の一致は返さない。
//!     pub fn find_in_line(&self, line: &str) -> Vec<std::ops::Range<usize>>;
//! }
//!
//! /// `SearchHit` に `matched: Option<String>` を 1 つ足す(.* ON のときだけ、その行で最初に当たった
//! /// 部分の文字列。.* OFF は None で JSON にキーが出ない)。
//! #[derive(Clone, Debug, PartialEq, Eq, Serialize)]
//! pub struct SearchHit {
//!     pub path: String, pub line: u32, pub text: String, pub ordinal: u32,
//!     #[serde(skip_serializing_if = "Option::is_none")]
//!     pub matched: Option<String>,
//! }
//!
//! /// `SearchScope` に `options` を足す。`new(settings, filter)` の引数は変えない(options は既定)。
//! pub struct SearchScope { pub settings: Settings, pub filter: SearchFilter, pub options: MatchOptions }
//! impl SearchScope {
//!     pub fn with_options(self, options: MatchOptions) -> Self;
//!     // search_in_folder_streaming / search_in_folder_with のシグネチャは不変。
//!     // 組めない式を受けたら `list` も `read_bytes` も sink も呼ばずに Ok(total 0)。
//! }
//!
//! // --- src-tauri/src/commands/search.rs ---
//! // #[tauri::command] async fn search_in_folder(root, query, generation, include, exclude,
//! //     use_exclude_settings, match_case: bool, whole_word: bool, use_regex: bool, window, state, results)
//! // 本体: load_settings → SearchScope::new(..).with_options(MatchOptions { .. }) → .begin( →
//! //       QueryMatcher::new( で検査(Err なら Err(INVALID_PATTERN_MESSAGE.to_string())) → .search_in_folder_streaming(
//!
//! // --- src-tauri/Cargo.toml の [dependencies] に `regex = "1"` を 1 行(Cargo.lock は不変)---
//! ```
//!
//! `ordinal` の数え方(契約6): 跳ぶときに渡す語 J(.* OFF なら Q・.* ON ならその行の `matched`)を
//! `to_lowercase` の重ならない出現で数える。`ordinal` = 1 + (当たった行より前の**すべての行**の J の
//! 出現数)+(当たった行の、最初のトグルの一致の開始位置より前の部分 `line[..start]` の J の出現数)。
//!
//! 以下の例の結果は req-66.md が 2026-10-08 に `regex` 1.12.3 で実測した値。

use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use async_trait::async_trait;
use tokio::sync::mpsc;

use vellis_lib::errors::FsError;
use vellis_lib::fs::entry::{Entry, FileKind};
use vellis_lib::fs::provider::{FileProvider, WatchEvent, WatchHandle};
use vellis_lib::fs::uri::Uri;
use vellis_lib::search::{
    search_in_folder_with, MatchOptions, QueryMatcher, SearchControl, SearchHit, SearchProgress,
    SearchScope, INVALID_PATTERN_MESSAGE,
};

// ---------------------------------------------------------------------------
// モック FileProvider(メモリ上の木・acceptance_req55.rs / acceptance_req65.rs の MockFs と同じ作り)
// ---------------------------------------------------------------------------

struct MockFs {
    scheme: &'static str,
    root: Uri,
    /// ディレクトリの絶対パス → 直下のエントリ
    dirs: HashMap<String, Vec<Entry>>,
    /// ファイルの絶対パス → 中身
    files: HashMap<String, Vec<u8>>,
    list_calls: Mutex<Vec<String>>,
    stat_calls: Mutex<Vec<String>>,
    read_calls: Mutex<Vec<String>>,
    write_calls: AtomicUsize,
}

impl MockFs {
    fn new(root: &str) -> Self {
        let root = Uri::parse(root).expect("root uri must parse");
        let scheme: &'static str = match root.scheme.as_str() {
            "file" => "file",
            "ssh" => "ssh",
            other => panic!("unexpected scheme in test root: {other}"),
        };
        let mut fs = Self {
            scheme,
            root: root.clone(),
            dirs: HashMap::new(),
            files: HashMap::new(),
            list_calls: Mutex::new(Vec::new()),
            stat_calls: Mutex::new(Vec::new()),
            read_calls: Mutex::new(Vec::new()),
            write_calls: AtomicUsize::new(0),
        };
        fs.dirs.insert(root.path_str().to_string(), Vec::new());
        fs
    }

    /// root 相対パス → 絶対 URI(scheme / authority は root のもの)
    fn uri_of(&self, rel: &str) -> Uri {
        self.root.with_path(self.root.path.join(rel))
    }

    fn abs_path(&self, rel: &str) -> String {
        self.uri_of(rel).path_str().to_string()
    }

    fn make_entry(&self, abs: &str, kind: FileKind, size: Option<u64>) -> Entry {
        let uri = self.root.with_path(abs);
        let name = Path::new(abs)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        Entry { uri: uri.raw, name, kind, size, modified: Some(1_700_000_000_000), link: None }
    }

    /// `abs` の親ディレクトリの一覧に `entry` を足す(同名は足さない)。親が無ければ作る。
    fn add_to_parent(&mut self, abs: &str, entry: Entry) {
        let parent = Path::new(abs)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .expect("entry must have a parent");
        self.ensure_dir_abs(&parent);
        let list = self.dirs.get_mut(&parent).expect("parent listing");
        if !list.iter().any(|e| e.name == entry.name) {
            list.push(entry);
        }
    }

    fn ensure_dir_abs(&mut self, abs: &str) {
        if self.dirs.contains_key(abs) {
            return;
        }
        self.dirs.insert(abs.to_string(), Vec::new());
        let root_path = self.root.path_str().to_string();
        if abs == root_path || abs == "/" {
            return;
        }
        let entry = self.make_entry(abs, FileKind::Dir, None);
        self.add_to_parent(abs, entry);
    }

    /// root 相対のディレクトリを作る(空でもよい)。
    fn dir(&mut self, rel: &str) -> &mut Self {
        let abs = self.abs_path(rel);
        self.ensure_dir_abs(&abs);
        self
    }

    /// root 相対のファイルを置く(親は自動で作る)。
    fn file(&mut self, rel: &str, bytes: impl Into<Vec<u8>>) -> &mut Self {
        let abs = self.abs_path(rel);
        let bytes = bytes.into();
        let entry = self.make_entry(&abs, FileKind::File, Some(bytes.len() as u64));
        self.add_to_parent(&abs, entry);
        self.files.insert(abs, bytes);
        self
    }

    fn list_calls(&self) -> Vec<String> {
        self.list_calls.lock().unwrap().clone()
    }

    fn read_calls(&self) -> Vec<String> {
        self.read_calls.lock().unwrap().clone()
    }

    fn write_calls(&self) -> usize {
        self.write_calls.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl FileProvider for MockFs {
    fn scheme(&self) -> &'static str {
        self.scheme
    }

    async fn list(&self, uri: &Uri) -> Result<Vec<Entry>, FsError> {
        let key = uri.path_str().to_string();
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
        Ok(entries)
    }

    async fn stat(&self, uri: &Uri) -> Result<Entry, FsError> {
        let key = uri.path_str().to_string();
        self.stat_calls.lock().unwrap().push(key.clone());
        if key == self.root.path_str() {
            return Ok(self.make_entry(&key, FileKind::Dir, None));
        }
        let parent = Path::new(&key)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let name = Path::new(&key)
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
        self.read_calls.lock().unwrap().push(key.clone());
        self.files.get(&key).cloned().ok_or(FsError::NotFound(key))
    }

    /// 契約⑤(要件#55): 検索は書き込み系に一切触れない。
    async fn write_text(&self, uri: &str, _content: &str) -> Result<(), FsError> {
        self.write_calls.fetch_add(1, Ordering::SeqCst);
        Err(FsError::Unsupported(format!("search must never write: {uri}")))
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
// ヘルパー
// ---------------------------------------------------------------------------

const FILE_ROOT: &str = "file:///root";
const SSH_ROOT: &str = "ssh://alice@host.example.com:2222/data";

/// 3 トグル。構造体リテラル=フィールドがこの 3 つだけであることのコンパイル時の担保。
fn opts(match_case: bool, whole_word: bool, use_regex: bool) -> MatchOptions {
    MatchOptions { match_case, whole_word, use_regex }
}

const ALL_OFF: MatchOptions = MatchOptions { match_case: false, whole_word: false, use_regex: false };
const AA: MatchOptions = MatchOptions { match_case: true, whole_word: false, use_regex: false };
const AB: MatchOptions = MatchOptions { match_case: false, whole_word: true, use_regex: false };
const AA_AB: MatchOptions = MatchOptions { match_case: true, whole_word: true, use_regex: false };
const RX: MatchOptions = MatchOptions { match_case: false, whole_word: false, use_regex: true };
const AA_RX: MatchOptions = MatchOptions { match_case: true, whole_word: false, use_regex: true };
const AB_RX: MatchOptions = MatchOptions { match_case: false, whole_word: true, use_regex: true };
const AA_AB_RX: MatchOptions = MatchOptions { match_case: true, whole_word: true, use_regex: true };

fn label(o: MatchOptions) -> String {
    format!(
        "Aa={} ab={} .*={}",
        if o.match_case { "ON" } else { "OFF" },
        if o.whole_word { "ON" } else { "OFF" },
        if o.use_regex { "ON" } else { "OFF" }
    )
}

/// 組める語の照合器(組めなければ panic)。
fn matcher(query: &str, o: MatchOptions) -> QueryMatcher {
    match QueryMatcher::new(query, o) {
        Ok(m) => m,
        Err(_) => panic!("QueryMatcher::new({query:?}, {}) must build", label(o)),
    }
}

/// その行に長さ 1 以上の一致があるか(`find_in_line` が空でない)。
fn line_matches(query: &str, o: MatchOptions, line: &str) -> bool {
    !matcher(query, o).find_in_line(line).is_empty()
}

/// 当たる行・当たらない行の表を `QueryMatcher` で判定する。
fn assert_lines(query: &str, o: MatchOptions, yes: &[&str], no: &[&str]) {
    for line in yes {
        assert!(
            line_matches(query, o, line),
            "{query:?} ({}) must match line {line:?}",
            label(o)
        );
    }
    for line in no {
        assert!(
            !line_matches(query, o, line),
            "{query:?} ({}) must NOT match line {line:?}",
            label(o)
        );
    }
}

fn scope(o: MatchOptions) -> SearchScope {
    SearchScope::default().with_options(o)
}

async fn run_default(fs: &MockFs, query: &str) -> Vec<SearchHit> {
    search_in_folder_with(fs, &fs.root, query)
        .await
        .unwrap_or_else(|e| panic!("search_in_folder_with({query:?}) must succeed: {e}"))
}

async fn run_scope(fs: &MockFs, o: MatchOptions, query: &str) -> Vec<SearchHit> {
    scope(o)
        .search_in_folder_with(fs, &fs.root, query)
        .await
        .unwrap_or_else(|e| panic!("SearchScope({}).search_in_folder_with({query:?}) must succeed: {e}", label(o)))
}

/// 1 ファイル `t.md` の木を走査し、当たった行番号を返す。
async fn lines_hit(content: &str, query: &str, o: MatchOptions) -> Vec<u32> {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("t.md", content);
    run_scope(&fs, o, query).await.iter().map(|h| h.line).collect()
}

/// 一致 1 件を構造体リテラルで組む=フィールドが path / line / text / ordinal / matched の 5 つで
/// あることのコンパイル時の担保(要件#55 の 4 つ + 要件#66 の `matched`)。
fn hit_nth(path: &str, line: u32, ordinal: u32, text: &str, matched: Option<&str>) -> SearchHit {
    SearchHit {
        path: path.to_string(),
        line,
        text: text.to_string(),
        ordinal,
        matched: matched.map(str::to_string),
    }
}

/// `acceptance_req55.rs` の共有の木(AC-55-10 / 11)+ AC-55-7 の `dot.md` / `r.md`。
fn populate_req55_tree(fs: &mut MockFs) {
    fs.file("zeta.md", "alpha at zeta\nnothing\nALPHA again\n");
    fs.file("docs/beta.txt", "no\nalpha in beta\n");
    fs.file("docs/sub/gamma.md", "alpha in gamma\n");
    fs.file("alpha.md", "first alpha\n");
    fs.file("docs/photo.png", "alpha inside png must not count");
    fs.file("dot.md", "literal a.c here\n");
    fs.file("r.md", "Alpha\nabc\naLPHA alpha\nzzz\nalp ha\n");
    fs.dir("empty");
}

// ---------------------------------------------------------------------------
// AC-66-1 — 全部 OFF は今と同じ(契約2・13)
// ---------------------------------------------------------------------------

/// 1. `MatchOptions::default()` は 3 つとも false(= 今の規則)。
#[test]
fn default_options_are_all_off() {
    assert_eq!(MatchOptions::default(), ALL_OFF);
    assert!(!MatchOptions::default().match_case);
    assert!(!MatchOptions::default().whole_word);
    assert!(!MatchOptions::default().use_regex);
}

/// 2. 同じ木・同じ語で、既定の free fn と `SearchScope::default().with_options(default)` の結果
///    (path / line / text / ordinal)が一致する。`matched` は全部 OFF なら None。
#[tokio::test]
async fn all_off_scope_equals_the_default_free_fn() {
    for root in [FILE_ROOT, SSH_ROOT] {
        let mut fs = MockFs::new(root);
        populate_req55_tree(&mut fs);
        for q in ["alpha", "ALPHA", "a.c", "al"] {
            let expected = run_default(&fs, q).await;
            let actual = run_scope(&fs, MatchOptions::default(), q).await;
            assert_eq!(actual, expected, "root {root} query {q:?}");
            assert!(!actual.is_empty(), "query {q:?} must have hits on the shared tree");
            assert!(
                actual.iter().all(|h| h.matched.is_none()),
                "all OFF never fills `matched`: {actual:?}"
            );
        }
        assert_eq!(fs.write_calls(), 0, "search must never write ({root})");
    }
}

/// 3. 全部 OFF の `QueryMatcher` は `a.c` で `abc` に当たらず、`ALPHA` で `alpha` に当たる
///    (regex を通さない=AC-55-7 の規則のまま)。
#[test]
fn all_off_matcher_is_a_case_insensitive_literal_substring() {
    assert_lines("a.c", ALL_OFF, &["a.c", "literal a.c here"], &["abc", "a-c", "ac"]);
    assert_lines("ALPHA", ALL_OFF, &["alpha", "Alpha", "xalphay", "aLPHA alpha"], &["alp ha", "zzz"]);
    assert_lines("alpha", ALL_OFF, &["ALPHA"], &[]);
    for q in ["[", "(", "\\", "a+", "^alpha$", ".*", "a{2,1}", "(?<x"] {
        assert!(
            QueryMatcher::new(q, ALL_OFF).is_ok(),
            "all OFF never fails to build: {q:?}"
        );
        assert!(line_matches(q, ALL_OFF, &format!("x{q}y")), "{q:?} matches itself literally");
    }
    assert!(!line_matches("a+", ALL_OFF, "aaa"), "`+` is a character, not a quantifier");
    assert!(!line_matches(".*", ALL_OFF, "anything"), "`.*` is two characters");
}

// ---------------------------------------------------------------------------
// AC-66-2 — Aa(契約2)
// ---------------------------------------------------------------------------

/// 4. Aa ON の `Foo` は `Foo` に当たり `foo`・`FOO` に当たらない。Aa OFF は 3 つとも当たる。
///    Aa ON も部分一致(`xFooy` に当たる)。
#[test]
fn match_case_distinguishes_case_but_stays_a_substring_match() {
    assert_lines("Foo", AA, &["Foo", "xFooy", "a Foo b"], &["foo", "FOO", "fOO", "xfooy"]);
    assert_lines("Foo", ALL_OFF, &["Foo", "foo", "FOO", "xFooy", "xfooy"], &["fo o"]);
}

/// 5. 走査でも同じ(Aa ON で大文字小文字違いの行が消える・行テキストは原文)。
#[tokio::test]
async fn match_case_applies_to_the_scan() {
    let doc = "foo\nFoo\nFOO\nxFooy\n";
    assert_eq!(lines_hit(doc, "Foo", AA).await, vec![2, 4]);
    assert_eq!(lines_hit(doc, "Foo", ALL_OFF).await, vec![1, 2, 3, 4]);
    assert_eq!(lines_hit(doc, "foo", AA).await, vec![1]);
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("t.md", doc);
    let hits = run_scope(&fs, AA, "Foo").await;
    assert_eq!(hits.iter().map(|h| h.text.as_str()).collect::<Vec<_>>(), vec!["Foo", "xFooy"]);
}

// ---------------------------------------------------------------------------
// AC-66-3 — ab(契約2・3)
// ---------------------------------------------------------------------------

/// 6. ab ON(Aa OFF)の `cat` は単語として当たり、`concat` / `cats` / `cat_` には当たらない(`_` は単語の文字)。
#[test]
fn whole_word_matches_only_when_the_neighbours_are_not_word_chars() {
    assert_lines(
        "cat",
        AB,
        &["cat", "cat-x", "(cat)", "Cat", "a cat.", "cat,dog", "x cat", "CAT"],
        &["cat_", "_cat", "concat", "cats", "scat", "cat1", "1cat"],
    );
}

/// 7. Aa ON にすると `Cat` に当たらない(ab と Aa は独立に効く)。
#[test]
fn whole_word_with_match_case_also_distinguishes_case() {
    assert_lines("cat", AA_AB, &["cat", "(cat)", "a cat."], &["Cat", "CAT", "concat", "cats"]);
    assert_lines("Cat", AA_AB, &["Cat", "a Cat."], &["cat", "Cats"]);
}

/// 8. 語の端が記号でも「前後の文字だけ」を見る(片側の境界=素の `\b` ではない):
///    語 `-x` は ` -x`・`-x`(行頭)に当たり、`a-x`・`b -xy` に当たらない。
#[test]
fn whole_word_uses_half_boundaries_so_a_symbol_edged_word_behaves_as_ripgrep_w() {
    assert_lines("-x", AB, &[" -x", "-x", "foo -x bar", "(-x)"], &["a-x", "b -xy", "a-xy"]);
    // 素の `\b` なら逆になる組み合わせ(` -x` に当たらず `a-x` に当たる)ではないことを両方で固定。
    assert!(line_matches("-x", AB, " -x"));
    assert!(!line_matches("-x", AB, "a-x"));
}

/// 9. .* OFF の語の `.` は文字のまま(`regex::escape`)= `foo.bar` は `fooxbar` に当たらない。
#[test]
fn whole_word_off_regex_keeps_the_query_literal() {
    assert_lines("foo.bar", AB, &["foo.bar", "x foo.bar y", "(foo.bar)"], &["fooxbar", "foo bar", "foo.barz"]);
    assert_lines("foo.bar", ALL_OFF, &["foo.bar", "xfoo.barz"], &["fooxbar"]);
    assert_lines("a+b", AB, &["a+b", "x a+b"], &["aab", "ab"]);
}

/// 10. 走査でも同じ(ab ON で語の一部の行が消える)。
#[tokio::test]
async fn whole_word_applies_to_the_scan() {
    let doc = "cat\ncat-x\n(cat)\nCat\na cat.\ncat_\nconcat\ncats\n";
    assert_eq!(lines_hit(doc, "cat", AB).await, vec![1, 2, 3, 4, 5]);
    assert_eq!(lines_hit(doc, "cat", AA_AB).await, vec![1, 2, 3, 5]);
    assert_eq!(lines_hit(doc, "cat", ALL_OFF).await, vec![1, 2, 3, 4, 5, 6, 7, 8]);
}

// ---------------------------------------------------------------------------
// AC-66-4 — 単語の文字= Unicode(契約3)【2026-10-08 由谷確定: 仮名・漢字も単語の文字】
// ---------------------------------------------------------------------------

/// 11. `café` は `café au lait` に当たり `cafés` に当たらない。`v` は `v 2` に当たり `v2` に当たらない。
#[test]
fn word_chars_are_unicode_alphabetic_and_digits() {
    assert_lines("café", AB, &["café au lait", "un café", "(café)"], &["cafés", "xcafé"]);
    assert_lines("v", AB, &["v 2", "v", "(v)", "v-2"], &["v2", "2v", "vv", "v_"]);
    assert_lines("naïve", AB, &["a naïve idea"], &["naïveté"]);
}

/// 12. 日本語: ab ON の `テスト` は前後が空白・記号・行頭・行末のときだけ当たる。ab OFF なら 5 つとも当たる。
#[test]
fn japanese_kana_and_kanji_are_word_chars_so_whole_word_needs_a_non_word_neighbour() {
    let five = ["「テスト」", "テスト", "test テスト end", "これはテストです", "テスト結果"];
    assert_lines("テスト", AB, &["「テスト」", "テスト", "test テスト end"], &["これはテストです", "テスト結果"]);
    assert_lines("テスト", ALL_OFF, &five, &[]);
    assert_lines("テスト", RX, &five, &[]);
    assert_lines("テスト", AB_RX, &["「テスト」", "テスト", "test テスト end"], &["これはテストです", "テスト結果"]);
    // 漢字も同じ。
    assert_lines("結果", AB, &["結果 を見る", "(結果)", "結果"], &["テスト結果", "結果表"]);
}

/// 13. 走査でも同じ(日本語の文中の語は ab ON で当たらない)。
#[tokio::test]
async fn japanese_whole_word_applies_to_the_scan() {
    let doc = "「テスト」\nテスト\ntest テスト end\nこれはテストです\nテスト結果\n";
    assert_eq!(lines_hit(doc, "テスト", AB).await, vec![1, 2, 3]);
    assert_eq!(lines_hit(doc, "テスト", ALL_OFF).await, vec![1, 2, 3, 4, 5]);
}

// ---------------------------------------------------------------------------
// AC-66-5 — 正規表現(契約2・4)
// ---------------------------------------------------------------------------

/// 14. .* ON・Aa OFF: `a.c` は `abc`・`a.c` に当たる。`^#` は `# h` に当たり `x #` に当たらない。
///     `\d{3}` は `123` に当たり `12` に当たらない。
#[test]
fn regex_syntax_is_the_regex_crate() {
    assert_lines("a.c", RX, &["abc", "a.c", "xaBcy", "a-c"], &["ac", "a\tbc"]);
    assert_lines("^#", RX, &["# h", "#", "## two"], &["x #", " #"]);
    assert_lines(r"\d{3}", RX, &["123", "a1234b"], &["12", "1 2 3"]);
    assert_lines("foo|bar", RX, &["foo", "bar", "xbary"], &["fo", "ba"]);
    assert_lines(r"\d{4}-\d{2}", RX, &["2026-10", "on 2026-10-08"], &["2026/10", "202-10"]);
}

/// 15. `FOO\d` は Aa OFF で `foo1`・`FOO2` に当たり、Aa ON で `FOO2` だけ。
#[test]
fn regex_with_match_case() {
    assert_lines(r"FOO\d", RX, &["foo1", "FOO2", "Foo3"], &["FOO", "fooX"]);
    assert_lines(r"FOO\d", AA_RX, &["FOO2"], &["foo1", "Foo3"]);
}

/// 16. .* ON・ab ON の `fo+` は `foo bar`・`fooo.` に当たり `food` に当たらない(全体を `(?:…)` で包む)。
#[test]
fn regex_with_whole_word_wraps_the_whole_pattern() {
    assert_lines("fo+", AB_RX, &["foo bar", "fooo.", "fo", "x foo"], &["food", "xfoo", "foo_"]);
    // 選択肢を含む式も全体で包む(`a|ab` を `\b…a|ab…\b` にしない)。
    assert_lines("ab|cd", AB_RX, &["ab", "cd x", "x ab y"], &["abc", "xcd", "ab_"]);
    assert_lines("fo+", AA_AB_RX, &["foo bar"], &["Foo bar", "food"]);
}

/// 17. 走査でも同じ(.* ON の例を 1 ファイルで)。
#[tokio::test]
async fn regex_applies_to_the_scan() {
    let doc = "abc\na.c\n# h\nx #\n123\n12\nfoo1\nFOO2\nfoo bar\nfooo.\nfood\n";
    assert_eq!(lines_hit(doc, "a.c", RX).await, vec![1, 2]);
    assert_eq!(lines_hit(doc, "^#", RX).await, vec![3]);
    assert_eq!(lines_hit(doc, r"\d{3}", RX).await, vec![5]);
    assert_eq!(lines_hit(doc, r"FOO\d", RX).await, vec![7, 8]);
    assert_eq!(lines_hit(doc, r"FOO\d", AA_RX).await, vec![8]);
    assert_eq!(lines_hit(doc, "fo+", AB_RX).await, vec![9, 10]);
    assert_eq!(lines_hit(doc, "fo+", RX).await, vec![7, 8, 9, 10, 11]);
}

// ---------------------------------------------------------------------------
// AC-66-6 — 組み合わせ 8 通り(契約2)
// ---------------------------------------------------------------------------

const COMBO_DOC: &str = "Foo. bar\nfoo. bar\nFood bar\nxFoo. bar\nFOOx\n";
const COMBO_QUERY: &str = "Foo.";

/// req-66.md AC-66-6 の表(2026-10-08 実測)。
fn combo_table() -> Vec<(MatchOptions, Vec<u32>)> {
    vec![
        (ALL_OFF, vec![1, 2, 4]),
        (AA, vec![1, 4]),
        (AB, vec![1, 2]),
        (AA_AB, vec![1]),
        (RX, vec![1, 2, 3, 4, 5]),
        (AA_RX, vec![1, 3, 4]),
        (AB_RX, vec![1, 2, 3, 5]),
        (AA_AB_RX, vec![1, 3]),
    ]
}

/// 18. 8 通りの組み合わせで当たる行番号が表のとおり(走査)。
#[tokio::test]
async fn eight_combinations_hit_the_lines_in_the_table() {
    for (o, expected) in combo_table() {
        let got = lines_hit(COMBO_DOC, COMBO_QUERY, o).await;
        assert_eq!(got, expected, "{} with query {COMBO_QUERY:?}", label(o));
    }
}

/// 19. 同じ表を `QueryMatcher` で行ごとに判定しても一致する(走査と照合器が同じ規則)。
#[test]
fn eight_combinations_agree_with_the_matcher() {
    let lines: Vec<&str> = COMBO_DOC.lines().collect();
    assert_eq!(lines.len(), 5);
    for (o, expected) in combo_table() {
        let m = matcher(COMBO_QUERY, o);
        let got: Vec<u32> = lines
            .iter()
            .enumerate()
            .filter(|(_, l)| !m.find_in_line(l).is_empty())
            .map(|(i, _)| (i + 1) as u32)
            .collect();
        assert_eq!(got, expected, "{} (matcher)", label(o));
    }
}

/// 20. `opts(..)` で組んだ値と定数が同じ(構造体の 3 フィールドの対応)。
#[test]
fn options_struct_has_exactly_the_three_toggles() {
    assert_eq!(opts(false, false, false), ALL_OFF);
    assert_eq!(opts(true, false, false), AA);
    assert_eq!(opts(false, true, false), AB);
    assert_eq!(opts(false, false, true), RX);
    assert_eq!(opts(true, true, true), AA_AB_RX);
    let copied: MatchOptions = AA_AB_RX; // Copy
    assert_eq!(copied, AA_AB_RX);
}

// ---------------------------------------------------------------------------
// AC-66-7 — 長さ 0 の一致は数えない(契約4)
// ---------------------------------------------------------------------------

const EMPTY_DOC: &str = "abc\nxyz\n\nbab\n";

/// 21. `^`・`$`・`\b`・`^$` は 0 件。`a*` は 1 行目と 4 行目、`x?` は 2 行目だけ。
#[tokio::test]
async fn zero_length_matches_do_not_count_in_the_scan() {
    for q in ["^", "$", r"\b", "^$", "()"] {
        assert_eq!(lines_hit(EMPTY_DOC, q, RX).await, Vec::<u32>::new(), "{q:?} must hit nothing");
    }
    assert_eq!(lines_hit(EMPTY_DOC, "a*", RX).await, vec![1, 4]);
    assert_eq!(lines_hit(EMPTY_DOC, "x?", RX).await, vec![2]);
    assert_eq!(lines_hit(EMPTY_DOC, "b*", RX).await, vec![1, 4]);
}

/// 22. `find_in_line` は長さ 0 の範囲を返さない(どの組み合わせでも)。
#[test]
fn find_in_line_never_returns_an_empty_range() {
    for q in ["^", "$", r"\b", "^$", "a*", "x?", "()", "(?:)", r"\B"] {
        for o in [RX, AA_RX, AB_RX, AA_AB_RX] {
            let m = matcher(q, o);
            for line in EMPTY_DOC.lines().chain(["", " ", "aaa"]) {
                for r in m.find_in_line(line) {
                    assert!(r.end > r.start, "{q:?} ({}) on {line:?} returned an empty range {r:?}", label(o));
                }
            }
        }
    }
    let m = matcher("a*", RX);
    assert_eq!(m.find_in_line("xyz"), Vec::<std::ops::Range<usize>>::new());
    assert_eq!(m.find_in_line(""), Vec::<std::ops::Range<usize>>::new());
    assert_eq!(m.find_in_line("abc"), vec![0..1]);
    assert_eq!(m.find_in_line("bab"), vec![1..2]);
    assert_eq!(matcher("^", RX).find_in_line("abc"), Vec::<std::ops::Range<usize>>::new());
    assert_eq!(matcher("^$", RX).find_in_line(""), Vec::<std::ops::Range<usize>>::new());
}

/// 23. 範囲はバイト範囲で、左から重ならずに(`find_iter`=最左・先に書いた選択肢が優先)。
#[test]
fn find_in_line_returns_byte_ranges_left_to_right_without_overlap() {
    assert_eq!(matcher("aa", ALL_OFF).find_in_line("aaaa"), vec![0..2, 2..4]);
    assert_eq!(matcher("aa", ALL_OFF).find_in_line("aaa"), vec![0..2]);
    assert_eq!(matcher("AA", ALL_OFF).find_in_line("xaAy aa"), vec![1..3, 5..7]);
    assert_eq!(matcher("aa", AA).find_in_line("aAaa"), vec![2..4]);
    assert_eq!(matcher("aa", RX).find_in_line("aaaa"), vec![0..2, 2..4]);
    assert_eq!(matcher("a|ab", RX).find_in_line("ab"), vec![0..1], "leftmost-first alternation");
    assert_eq!(matcher("cat", AB).find_in_line("cat concat cat"), vec![0..3, 11..14]);
    // バイト範囲: `テ` `ス` `ト` は各 3 バイト。
    assert_eq!(matcher("スト", ALL_OFF).find_in_line("テスト"), vec![3..9]);
    assert_eq!(matcher("テスト", AB).find_in_line("「テスト」"), vec![3..12]);
    assert_eq!(matcher("é", ALL_OFF).find_in_line("café"), vec![3..5]);
}

// ---------------------------------------------------------------------------
// AC-66-8 — 行単位(契約4)
// ---------------------------------------------------------------------------

/// 24. 中身が `a\nb\n` のファイルで、.* ON の `\n`・`a\nb` は 0 件(複数行にまたがる一致はしない)。
#[tokio::test]
async fn regex_never_matches_across_lines() {
    for q in [r"\n", r"a\nb", "a\nb", r"a\sb", r"(?s)a.b"] {
        assert_eq!(lines_hit("a\nb\n", q, RX).await, Vec::<u32>::new(), "{q:?} must not match across lines");
    }
    assert_eq!(lines_hit("a\nb\n", "a|b", RX).await, vec![1, 2]);
    assert_eq!(lines_hit("a b\n", r"a\sb", RX).await, vec![1]);
}

/// 25. CRLF のファイルで .* ON の `foo$` は 1 行目に当たり、返る `text` は `foo`(`\r` を含まない)。
///     行番号は今と同じ数え方(1 始まり・最終行に改行が無くても数える)。
#[tokio::test]
async fn regex_anchors_apply_per_line_and_crlf_is_stripped() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("crlf.md", "foo\r\nbar\r\nfoo bar\r\nfoo");
    fs.file("lf.md", "foo\nbar\nfoo bar\nfoo");

    let hits = run_scope(&fs, RX, "foo$").await;

    assert_eq!(
        hits,
        vec![
            hit_nth("crlf.md", 1, 1, "foo", Some("foo")),
            hit_nth("crlf.md", 4, 3, "foo", Some("foo")),
            hit_nth("lf.md", 1, 1, "foo", Some("foo")),
            hit_nth("lf.md", 4, 3, "foo", Some("foo")),
        ]
    );
    for h in &hits {
        assert!(!h.text.contains('\r') && !h.text.contains('\n'), "{:?}", h.text);
    }
    let bar = run_scope(&fs, RX, "^bar$").await;
    assert_eq!(bar.iter().map(|h| (h.path.as_str(), h.line)).collect::<Vec<_>>(), vec![("crlf.md", 2), ("lf.md", 2)]);
    let starts = run_scope(&fs, RX, "^foo").await;
    assert_eq!(starts.iter().filter(|h| h.path == "crlf.md").map(|h| h.line).collect::<Vec<_>>(), vec![1, 3, 4]);
}

// ---------------------------------------------------------------------------
// AC-66-9 — 壊れた式(契約5)
// ---------------------------------------------------------------------------

const BROKEN: &[&str] = &["(", "[a-", "a{2,1}", "\\", "(?<x", "(?P<", "a)", "*", "a)(?:b"];

/// 26. .* ON の `(`・`[a-`・`a{2,1}`・`\`(末尾)・`(?<x` で `QueryMatcher::new` が Err。
///     文言は `Invalid regular expression`(値固定・英語)。
#[test]
fn broken_patterns_fail_to_build_and_the_message_is_fixed() {
    for q in BROKEN {
        for o in [RX, AA_RX, AB_RX, AA_AB_RX] {
            assert!(QueryMatcher::new(q, o).is_err(), "{q:?} ({}) must be Err", label(o));
        }
    }
    assert_eq!(INVALID_PATTERN_MESSAGE, "Invalid regular expression");
    assert!(!INVALID_PATTERN_MESSAGE.contains('\n'), "one line: it goes into the status line");
}

/// 27. 同じ式で `SearchScope` の走査を回すと、`list` も `read_bytes` も 1 回も呼ばれず、sink も
///     呼ばれず、結果 0 件で panic しない(`search_in_folder_streaming` と `search_in_folder_with` の両方)。
#[tokio::test]
async fn broken_patterns_never_start_the_scan() {
    for q in BROKEN {
        let mut fs = MockFs::new(FILE_ROOT);
        fs.file("a.md", "( [a- a{2,1} \\ (?<x\n");
        fs.file("docs/b.md", "anything\n");

        let mut sink_calls = 0usize;
        let mut sink = |_p: SearchProgress| {
            sink_calls += 1;
            SearchControl::Continue
        };
        let summary = scope(RX)
            .search_in_folder_streaming(&fs, &fs.root, q, &mut sink, &|| false)
            .await
            .unwrap_or_else(|e| panic!("a broken pattern {q:?} must not be an Err of the scan: {e}"));
        assert_eq!(summary.total, 0, "{q:?}");
        assert_eq!(summary.files, 0, "{q:?}");
        assert_eq!(sink_calls, 0, "{q:?}: the sink must not be called");
        assert!(fs.list_calls().is_empty(), "{q:?}: list must not be called: {:?}", fs.list_calls());
        assert!(fs.read_calls().is_empty(), "{q:?}: read_bytes must not be called: {:?}", fs.read_calls());

        let hits = run_scope(&fs, RX, q).await;
        assert!(hits.is_empty(), "{q:?}");
        assert!(fs.list_calls().is_empty(), "{q:?}: list must not be called (with)");
        assert!(fs.read_calls().is_empty(), "{q:?}: read_bytes must not be called (with)");
    }
}

/// 28. .* OFF の `(` は Err にならず、`(` を含む行に当たる(照合器でも走査でも)。
#[tokio::test]
async fn broken_patterns_are_plain_text_when_regex_is_off() {
    for o in [ALL_OFF, AA, AB, AA_AB] {
        for q in BROKEN {
            assert!(QueryMatcher::new(q, o).is_ok(), "{q:?} ({}) must build", label(o));
        }
    }
    assert_lines("(", ALL_OFF, &["f(x)", "(", "a ( b"], &["fx", ")"]);
    assert_lines("(", AA, &["f(x)"], &[]);
    // ab ON の `(` は前後の文字だけを見る: `f(x)` は前が `f`・後が `x`(単語の文字)なので当たらない。
    assert_lines("(", AB, &["(", "a ( b", "f ( x )"], &["fx", "f(x)", "f (x)"]);
    assert_lines("[a-", ALL_OFF, &["x[a-z]"], &["xaz"]);

    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("a.md", "f(x)\nfx\n(\nf ( x )\n");
    assert_eq!(run_scope(&fs, ALL_OFF, "(").await.iter().map(|h| h.line).collect::<Vec<_>>(), vec![1, 3, 4]);
    assert_eq!(run_scope(&fs, AA_AB, "(").await.iter().map(|h| h.line).collect::<Vec<_>>(), vec![3, 4]);
    assert!(!fs.read_calls().is_empty(), "the scan ran");
}

// ---------------------------------------------------------------------------
// AC-66-10 — 番目(契約6)と `matched`(契約6・10)
// ---------------------------------------------------------------------------

/// 29. Aa ON の `Foo` で、行 `foo` / `Foo` / `x FOO Foo` のファイルは、当たる行が 2 行目と 3 行目・
///     `ordinal` が 2 と 4(要件#54 は `foo` / `Foo` / `FOO` / `Foo` の 4 つを数える)。
#[tokio::test]
async fn ordinal_counts_the_way_find_in_document_does_when_match_case_is_on() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("o.md", "foo\nFoo\nx FOO Foo\n");

    let hits = run_scope(&fs, AA, "Foo").await;

    assert_eq!(
        hits,
        vec![hit_nth("o.md", 2, 2, "Foo", None), hit_nth("o.md", 3, 4, "x FOO Foo", None)]
    );
}

/// 30. ab ON の `cat` で、行 `concat` / `cat` のファイルは、当たる行が 2 行目・`ordinal` が 2
///     (要件#54 は `concat` の中の `cat` も数える)。
#[tokio::test]
async fn ordinal_counts_partial_occurrences_when_whole_word_is_on() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("o.md", "concat\ncat\n");

    let hits = run_scope(&fs, AB, "cat").await;

    assert_eq!(hits, vec![hit_nth("o.md", 2, 2, "cat", None)]);

    // 当たった行の、最初の一致より前の部分も数える(`cats cat` の `cats` の中の `cat`)。
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("p.md", "cats cat\n");
    let hits = run_scope(&fs, AB, "cat").await;
    assert_eq!(hits, vec![hit_nth("p.md", 1, 2, "cats cat", None)]);
}

/// 31. 全部 OFF では今の `ordinal`(AC-55-25 の値)と同じ。
#[tokio::test]
async fn ordinal_is_unchanged_when_all_toggles_are_off() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("o.md", "alpha\nAlpha ALPHA\nalpha\nx alpha y alpha z alpha\nalpha\n");
    fs.file("q.md", "aaaa\naaa\naa\n");

    let pairs = |hits: &[SearchHit]| hits.iter().map(|h| (h.path.clone(), h.line, h.ordinal)).collect::<Vec<_>>();
    let expected = run_default(&fs, "alpha").await;
    let actual = run_scope(&fs, ALL_OFF, "alpha").await;
    assert_eq!(actual, expected);
    assert_eq!(
        pairs(&actual),
        vec![
            ("o.md".to_string(), 1, 1),
            ("o.md".to_string(), 2, 2),
            ("o.md".to_string(), 3, 4),
            ("o.md".to_string(), 4, 5),
            ("o.md".to_string(), 5, 8),
        ]
    );
    let aa = run_scope(&fs, ALL_OFF, "aa").await;
    assert_eq!(aa, run_default(&fs, "aa").await);
    assert_eq!(pairs(&aa), vec![("q.md".to_string(), 1, 1), ("q.md".to_string(), 2, 3), ("q.md".to_string(), 3, 4)]);
}

/// 32. ファイルが変われば 1 から数え直す(トグルが ON でも)。
#[tokio::test]
async fn ordinal_restarts_for_each_file_with_toggles_on() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("a.md", "foo\nFoo\n");
    fs.file("b/c.md", "Foo\n");
    fs.file("d.txt", "foo foo\nFoo\n");

    let hits = run_scope(&fs, AA, "Foo").await;

    assert_eq!(
        hits,
        vec![
            hit_nth("a.md", 2, 2, "Foo", None),
            hit_nth("b/c.md", 1, 1, "Foo", None),
            hit_nth("d.txt", 2, 3, "Foo", None),
        ]
    );
}

/// 33. .* ON の `fo+` で、行 `food` / `x foo` のファイルは、2 行の `matched` が `foo` と `foo`・
///     `ordinal` が 1 と 2(J = その行の `matched`)。
#[tokio::test]
async fn regex_hits_carry_the_matched_text_and_count_by_it() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("o.md", "food\nx foo\n");

    let hits = run_scope(&fs, RX, "fo+").await;

    assert_eq!(
        hits,
        vec![hit_nth("o.md", 1, 1, "food", Some("foo")), hit_nth("o.md", 2, 2, "x foo", Some("foo"))]
    );
}

/// 34. `matched` はその行で**最初に**当たった部分(`fo+` で `food fooo` なら `foo`)。行ごとに
///     違ってよく、`ordinal` はその行の J で数える(`\d{4}` の例: 前の行の `2026` は J=`2025` を含まない)。
#[tokio::test]
async fn matched_is_the_first_match_of_the_line_and_ordinal_follows_it() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("m.md", "food fooo\nfooo food\n");
    let hits = run_scope(&fs, RX, "fo+").await;
    assert_eq!(hits[0].matched.as_deref(), Some("foo"));
    assert_eq!(hits[1].matched.as_deref(), Some("fooo"));
    assert_eq!(hits[0].ordinal, 1);
    // 2 行目: J = `fooo`。1 行目 `food fooo` に `fooo` は 1 回 → ordinal 2。
    assert_eq!(hits[1].ordinal, 2);

    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("y.md", "in 2026\nin 2025 and 2026\nnone\n2026 again\n");
    let hits = run_scope(&fs, RX, r"\d{4}").await;
    assert_eq!(
        hits,
        vec![
            hit_nth("y.md", 1, 1, "in 2026", Some("2026")),
            hit_nth("y.md", 2, 1, "in 2025 and 2026", Some("2025")),
            hit_nth("y.md", 4, 3, "2026 again", Some("2026")),
        ]
    );
    // Aa OFF の .* ON: `matched` は原文の大文字小文字のまま。
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("c.md", "FOO\nfoo\n");
    let hits = run_scope(&fs, RX, "foo").await;
    assert_eq!(hits[0].matched.as_deref(), Some("FOO"));
    assert_eq!(hits[1].matched.as_deref(), Some("foo"));
    assert_eq!(hits.iter().map(|h| h.ordinal).collect::<Vec<_>>(), vec![1, 2]);
}

/// 35. .* OFF の結果の `matched` は None(Aa / ab が ON でも)。JSON には `matched` キーが出ない。
///     .* ON の結果は JSON に `matched` が出る。
#[tokio::test]
async fn matched_is_none_without_regex_and_absent_from_json() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("o.md", "foo\nFoo cat\n");
    for o in [ALL_OFF, AA, AB, AA_AB] {
        for q in ["foo", "cat"] {
            let hits = run_scope(&fs, o, q).await;
            assert!(!hits.is_empty(), "{q:?} ({})", label(o));
            assert!(hits.iter().all(|h| h.matched.is_none()), "{q:?} ({}): {hits:?}", label(o));
        }
    }

    let off = hit_nth("o.md", 1, 1, "foo", None);
    let json = serde_json::to_value(&off).expect("SearchHit serializes");
    let keys: BTreeSet<String> = json.as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, ["path", "line", "text", "ordinal"].iter().map(|s| s.to_string()).collect());

    let on = hit_nth("o.md", 1, 1, "food", Some("foo"));
    let json = serde_json::to_value(&on).expect("SearchHit serializes");
    let keys: BTreeSet<String> = json.as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, ["path", "line", "text", "ordinal", "matched"].iter().map(|s| s.to_string()).collect());
    assert_eq!(json["matched"], "foo");
}

/// 36. ssh の root でも同じ(照合は Rust の 1 か所)。`write_text` は呼ばれない。
#[tokio::test]
async fn ssh_root_yields_the_same_hits_for_every_toggle() {
    for (o, expected) in combo_table() {
        let mut local = MockFs::new(FILE_ROOT);
        local.file("t.md", COMBO_DOC);
        let mut ssh = MockFs::new(SSH_ROOT);
        ssh.file("t.md", COMBO_DOC);
        let a = run_scope(&local, o, COMBO_QUERY).await;
        let b = run_scope(&ssh, o, COMBO_QUERY).await;
        assert_eq!(a, b, "{}", label(o));
        assert_eq!(a.iter().map(|h| h.line).collect::<Vec<_>>(), expected, "{}", label(o));
        assert_eq!(ssh.write_calls(), 0);
    }
}

// ---------------------------------------------------------------------------
// AC-66-11 — command と照合の置き場(契約7・5・13)= ソース走査
// ---------------------------------------------------------------------------

/// 行ごとに `//` 以降(コメント)を落としたコード部分を連結して返す。`://` は落とさない。
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

/// `/* … */`・`<!-- … -->` のブロックも落とす(TS / Svelte 用)。
fn strip_ts_comments(src: &str) -> String {
    let mut s = src.to_string();
    for (open, close) in [("/*", "*/"), ("<!--", "-->")] {
        while let Some(a) = s.find(open) {
            let b = s[a..].find(close).map(|i| a + i + close.len()).unwrap_or(s.len());
            s.replace_range(a..b, "");
        }
    }
    strip_line_comments(&s)
}

fn search_command_code() -> String {
    strip_line_comments(include_str!("../src/commands/search.rs"))
}

fn lib_rs_code() -> String {
    strip_line_comments(include_str!("../src/lib.rs"))
}

/// `search_in_folder` command の本体(`fn search_in_folder(` から次の `#[tauri::command]` か EOF まで=55b の写し)。
fn search_in_folder_body(code: &str) -> String {
    let at = code.find("fn search_in_folder(").expect("search_in_folder command exists");
    let rest = &code[at..];
    let end = rest[1..].find("#[tauri::command]").map(|i| i + 1).unwrap_or(rest.len());
    rest[..end].to_string()
}

/// `src-tauri/src/` の下の `.rs` を全部(src からの相対パス・中身)。
fn rust_sources() -> Vec<(String, String)> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
        for entry in std::fs::read_dir(dir).expect("read src dir") {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                walk(base, &path, out);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let rel = path.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
            let src = std::fs::read_to_string(&path).expect("read rs");
            out.push((rel, src));
        }
    }
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut out = Vec::new();
    walk(&base, &base, &mut out);
    out.sort();
    out
}

const FIND_IN_FOLDER_TS: &str = include_str!("../../src/lib/find-in-folder.ts");
const FIND_IN_FOLDER_SVELTE: &str = include_str!("../../src/components/FindInFolder.svelte");

/// `export const NAME = '…'` の文字列リテラルの中身(`'` / `"` / `` ` `` のどれでも)。
fn ts_string_const(src: &str, name: &str) -> String {
    let marker = format!("export const {name}");
    let at = src.find(&marker).unwrap_or_else(|| panic!("find-in-folder.ts must `{marker}`"));
    let rest = &src[at + marker.len()..];
    let eq = rest.find('=').expect("`=` after the const name");
    let after = rest[eq + 1..].trim_start();
    let quote = after.chars().next().expect("a quoted string");
    assert!(
        quote == '\'' || quote == '"' || quote == '`',
        "{name} must be a string literal, got {after:?}"
    );
    let body = &after[quote.len_utf8()..];
    let end = body.find(quote).expect("closing quote");
    body[..end].to_string()
}

/// 37. `search_in_folder` のシグネチャに `match_case: bool`・`whole_word: bool`・`use_regex: bool` があり、
///     3 つとも本体で使われている。既存の 6 引数も残る。
#[test]
fn search_command_takes_the_three_toggles_and_uses_them() {
    let body = search_in_folder_body(&search_command_code());
    let signature_end = body.find('{').expect("fn has a body");
    let signature: String = body[..signature_end].split_whitespace().collect();
    for param in [
        "root:String",
        "query:String",
        "generation:u64",
        "include:Vec<String>",
        "exclude:Vec<String>",
        "use_exclude_settings:bool",
        "match_case:bool",
        "whole_word:bool",
        "use_regex:bool",
    ] {
        assert!(signature.contains(param), "search_in_folder must take `{param}` (契約7): {signature}");
    }
    for used in ["match_case", "whole_word", "use_regex"] {
        assert!(
            body[signature_end..].contains(used),
            "the `{used}` argument must be used in the body, not just declared"
        );
    }
    assert!(body.contains("MatchOptions"), "the command hands the toggles to the scan as MatchOptions");
}

/// 38. 本体が `INVALID_PATTERN_MESSAGE` を使い、`.begin(` が `QueryMatcher::new(` より前、
///     `QueryMatcher::new(` が `search_in_folder_streaming(` より前にある(契約5・7)。
///     `load_settings(`・`is_current_at`・`store_at`・`emit_to` は今のまま。
#[test]
fn search_command_begins_then_validates_the_pattern_then_streams() {
    let body = search_in_folder_body(&search_command_code());
    assert!(body.contains("INVALID_PATTERN_MESSAGE"), "the command returns INVALID_PATTERN_MESSAGE on a broken pattern");
    assert!(!body.contains("\"Invalid regular expression\""), "the message is the constant, not an inline literal");
    let begin = body.find(".begin(").expect("search_in_folder must call ResultStore::begin");
    let check = body.find("QueryMatcher::new(").expect("search_in_folder must validate the pattern with QueryMatcher::new");
    let stream = body.find("search_in_folder_streaming(").expect("search_in_folder must call search_in_folder_streaming");
    assert!(begin < check, "begin must precede the pattern check (a broken pattern still records the generation)");
    assert!(check < stream, "the pattern check must precede the scan");
    assert!(body.contains("load_settings("), "settings are still read per search (要件#65)");
    assert!(body.contains(".is_current_at(") && body.contains(".store_at("), "追補f の世代と epoch の扱いは不変");
    assert!(body.contains("emit_to("), "search_progress / search_done は不変");
    assert!(body.contains("with_options("), "the scope carries the toggles via with_options");
}

/// 39. `regex` を使うのは `src-tauri/src/search/` の下だけ(`regex::` / `Regex` / `RegexBuilder` の字面)。
///     search/ の下には使っている箇所がある(=依存が実際に使われている)。
#[test]
fn regex_is_used_only_inside_the_search_module() {
    let sources = rust_sources();
    assert!(sources.iter().any(|(rel, _)| rel == "search/mod.rs"), "search/mod.rs exists: {sources:?}");
    let mut inside = 0usize;
    for (rel, src) in &sources {
        let code = strip_line_comments(src);
        let uses = ["regex::", "Regex", "RegexBuilder"].iter().any(|needle| code.contains(*needle));
        if rel.starts_with("search/") {
            if uses {
                inside += 1;
            }
        } else {
            assert!(!uses, "{rel} must not use the regex crate (照合は search/ の 1 か所=契約7)");
        }
    }
    assert!(inside >= 1, "src/search/ must be where the regex crate is used");
}

/// 40. フロントは照合しない: `FindInFolder.svelte` と `find-in-folder.ts` に `RegExp` の字面が無い
///     (コメントを除く)。正規表現リテラルで照合もしない(`.test(` / `.match(` を語に当てない)。
#[test]
fn front_end_builds_no_regexp() {
    for (name, src) in [("FindInFolder.svelte", FIND_IN_FOLDER_SVELTE), ("find-in-folder.ts", FIND_IN_FOLDER_TS)] {
        let code = strip_ts_comments(src);
        assert!(!code.contains("RegExp"), "{name} must not build a RegExp (照合は Rust=契約7)");
    }
}

/// 41. `lib.rs` の `generate_handler!` の command は増えていない(両方の一覧に search_* は 3 つ・
///     本数は周回開始時点と同じ=AC-60-20 と同じ固定)。
#[test]
fn tauri_commands_are_not_added() {
    let code = lib_rs_code();
    let blocks: Vec<Vec<String>> = code
        .match_indices("generate_handler![")
        .map(|(i, _)| {
            let start = i + "generate_handler![".len();
            let end = code[start..].find(']').expect("handler list must close") + start;
            code[start..end]
                .split(',')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.rsplit("::").next().unwrap().to_string())
                .collect()
        })
        .collect();
    assert_eq!(blocks.len(), 2, "lib.rs has the webdriver and the production handler lists");
    for names in &blocks {
        let search: Vec<&str> = names.iter().map(String::as_str).filter(|n| n.starts_with("search")).collect();
        assert_eq!(search, vec!["search_in_folder", "search_in_folder_page", "search_in_folder_reset"]);
    }
    // 周回開始時点(2026-10-08)は webdriver 側 35(`__test_list_windows` 込み)・本番側 34。
    // 要件#64 追補f(2026-10-25・Issue #717)で `record_displayed_file` が 1 つ増えて 36・35。
    // 要件#48 追補m(2026-10-26・Issue #750)で `switch_root_confirmed` が 1 つ増えて 37・36=由谷承認 2026-10-26。
    assert_eq!(blocks[0].len(), 37, "{:?}", blocks[0]);
    assert_eq!(blocks[1].len(), 36, "{:?}", blocks[1]);
}

/// 42. Rust の `INVALID_PATTERN_MESSAGE` と TS の `FIND_IN_FOLDER_INVALID_REGEX` が同じ値。
#[test]
fn invalid_pattern_message_matches_the_front_end_constant() {
    let ts = ts_string_const(FIND_IN_FOLDER_TS, "FIND_IN_FOLDER_INVALID_REGEX");
    assert_eq!(ts, INVALID_PATTERN_MESSAGE);
    assert_eq!(ts, "Invalid regular expression");
}

// ---------------------------------------------------------------------------
// AC-66-12 — 依存(契約11)
// ---------------------------------------------------------------------------

const CARGO_TOML: &str = include_str!("../Cargo.toml");
const CARGO_LOCK: &str = include_str!("../Cargo.lock");

/// `[header]` 節の本文(次の `[` で始まる行まで)。
fn cargo_section_body(header: &str) -> &'static str {
    let marker = format!("\n{header}\n");
    let start = CARGO_TOML
        .find(&marker)
        .unwrap_or_else(|| panic!("Cargo.toml must have section {header}"))
        + marker.len();
    let body = &CARGO_TOML[start..];
    let end = body
        .lines()
        .scan(0usize, |acc, l| {
            let at = *acc;
            *acc += l.len() + 1;
            Some((at, l))
        })
        .find(|(_, l)| l.starts_with('['))
        .map(|(at, _)| at)
        .unwrap_or(body.len());
    &body[..end]
}

/// `[header]` 節の `name = …` のキー集合(acceptance_req55.rs の写し)。
fn cargo_section_keys(header: &str) -> BTreeSet<String> {
    cargo_section_body(header)
        .lines()
        .filter_map(|l| {
            let l = l.trim_start();
            if l.starts_with('#') {
                return None;
            }
            let (key, _) = l.split_once('=')?;
            let key = key.trim().trim_matches('"');
            if key.is_empty() || key.contains(' ') {
                None
            } else {
                Some(key.to_string())
            }
        })
        .collect()
}

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| s.to_string()).collect()
}

/// 周回開始時点(2026-10-08)の `[dependencies]`(acceptance_req55.rs の 26 と同じ集合)。
const DEPENDENCIES_BEFORE_REQ66: &[&str] = &[
    "tauri",
    "tauri-plugin-opener",
    "serde",
    "serde_json",
    "clap",
    "thiserror",
    "tokio",
    "async-trait",
    "notify",
    "libc",
    "tracing",
    "tracing-subscriber",
    "mime_guess",
    "http",
    "percent-encoding",
    "tauri-plugin-dialog",
    "reqwest",
    "russh",
    "russh-sftp",
    "bytes",
    "dirs",
    "ulid",
    "chrono",
    "strsim",
    "sha2",
    "similar",
    "hidapi",
    "toml",
    "tauri-plugin-webdriver",
    "tauri-plugin-window-state",
];

/// 43. `[dependencies]` のクレート集合= 周回開始時点の集合 + `regex`(それ以外の追加・削除なし)。
#[test]
fn cargo_dependencies_gain_exactly_regex() {
    let mut expected = set(DEPENDENCIES_BEFORE_REQ66);
    expected.insert("regex".to_string());
    assert_eq!(cargo_section_keys("[dependencies]"), expected);
}

/// 44. `regex` の値は `"1"`(または `version = "1"` を持つ表)。
#[test]
fn regex_dependency_is_declared_as_version_1() {
    let body = cargo_section_body("[dependencies]");
    let line = body
        .lines()
        .map(str::trim_start)
        .find(|l| l.starts_with("regex") && l.trim_start_matches("regex").trim_start().starts_with('='))
        .expect("[dependencies] must declare regex");
    let value = line.split_once('=').unwrap().1.trim();
    let ok = value == "\"1\""
        || (value.starts_with('{') && value.contains("version = \"1\""));
    assert!(ok, "regex must be `\"1\"` or a table with `version = \"1\"`: {line}");
}

/// 45. `Cargo.lock` の `regex` は 1.12.3 のまま(`cargo update` しない)。`regex-automata` / `regex-syntax` も残る。
#[test]
fn cargo_lock_keeps_regex_at_1_12_3() {
    assert!(
        CARGO_LOCK.contains("name = \"regex\"\nversion = \"1.12.3\""),
        "Cargo.lock must keep regex 1.12.3"
    );
    assert_eq!(CARGO_LOCK.matches("\nname = \"regex\"\n").count(), 1, "exactly one regex package");
    assert!(CARGO_LOCK.contains("\nname = \"regex-automata\"\n"));
    assert!(CARGO_LOCK.contains("\nname = \"regex-syntax\"\n"));
}

/// 46. macOS target 節と `[dev-dependencies]` / `[build-dependencies]` は不変(acceptance_req55.rs の 27 と同じ)。
#[test]
fn cargo_target_dev_and_build_dependencies_are_unchanged() {
    assert_eq!(
        cargo_section_keys("[target.'cfg(target_os = \"macos\")'.dependencies]"),
        set(&["objc2", "objc2-app-kit", "objc2-foundation"])
    );
    assert_eq!(cargo_section_keys("[dev-dependencies]"), set(&["tempfile", "tauri", "muda"]));
    assert_eq!(cargo_section_keys("[build-dependencies]"), set(&["tauri-build", "chrono"]));
    let target_sections = CARGO_TOML
        .lines()
        .filter(|l| l.trim_start().starts_with("[target."))
        .count();
    assert_eq!(target_sections, 1, "no new target-specific dependency sections");
}
