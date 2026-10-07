//! 要件#65 の受け入れテスト(docs/requirements/req-65.md)— Rust 層
//! (AC-65-1〜11・AC-65-12 の Rust 側・AC-65-14)
//!
//! 「除外リスト(Exclude)を使う人が設定できる」。コードに埋め込まれていた 2 つの除外
//! (`.` 始まりの一律スキップ=`list` の段階・`EXCLUDED_DIR_NAMES`=検索だけ)を、
//! `~/.config/vellis/settings.json` の `files.exclude`(ツリーと検索)/ `search.exclude`(検索だけ)
//! へ移す。既定値は今の除外と同じ。検索パネルには files to include / files to exclude の欄と
//! 歯車(Use Exclude Settings)が付き、Rust 側の検索が `include` / `exclude` /
//! `use_exclude_settings` を受ける(契約13)。
//!
//! 判定範囲(AC 番号は req-65.md の受け入れ基準):
//! - AC-65-1  glob の照合 `glob_match`(`*`・`?`・`**`・大文字小文字・`{}` は文字のまま)
//! - AC-65-2  既定値(`files.exclude` 3 つ・`search.exclude` = `EXCLUDED_DIR_NAMES` の 6 つ・
//!   `default_settings_json()` の往復)
//! - AC-65-3  読み込みの規則(キーがあればその辞書が全部・false は無効・空辞書・知らないキー)
//! - AC-65-4  壊れた設定(既定値で動く・警告を返す・panic しない・ファイルが無ければ既定)
//! - AC-65-5  置き場(`settings_path` の純関数・`settings.json`・`history.json` と違う)
//! - AC-65-6  書き出し(無ければ親ごと作って既定値・有れば壊れていても触らない)
//! - AC-65-7  ツリーの判定(`is_hidden_from_tree`・`filter_tree_entries_with`・組み込みの `.vellis-tmp`)
//! - AC-65-8  `LocalProvider::list` は隠し名も返す(要件#31 AC-31-6 の置き換え)
//! - AC-65-9  検索への適用(MockFs・設定ごとの `list` / `read_bytes` の有無・3 引数版は既定と同じ)
//! - AC-65-10 適用の配線(ソース走査: 一覧の 5 経路・`search_in_folder` command・`list` の `starts_with('.')` 撤去)
//! - AC-65-11 メニュー(`SETTINGS_ITEM_ID` / `SETTINGS_ACCELERATOR`・Command + ,・App メニューの位置・lib.rs の dispatch)
//! - AC-65-12 保存後の読み直し(Rust 側: `SETTINGS_CHANGED_EVENT` の値・`save_document` の見分けと送信)
//! - AC-65-13 不変(`EXCLUDED_DIR_NAMES` の値は AC-55-2 のまま。それ以外は既存テストが無改変で緑=本ファイルの外)
//! - AC-65-14 検索パネルの欄= Rust(`SearchFilter` の include / exclude / use_exclude_settings の判定順)
//!
//! フロント側(AC-65-12 のイベント名と `+page.svelte` の配線・AC-65-15 の欄)は
//! `src/lib/settings-changed.acceptance.test.ts` と `src/components/FindInFolder.wiring.test.ts`。
//! 人間ゲート(Command + , の手応え・保存でツリーが変わる流れ・ssh・警告の出方・欄の見た目)は判定しない。
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前・公開パス)
//!
//! ```ignore
//! // --- 新規 src-tauri/src/settings.rs(lib.rs に `pub mod settings;`)---
//! use std::collections::BTreeMap;
//! use std::path::{Path, PathBuf};
//!
//! pub const SETTINGS_FILENAME: &str = "settings.json";
//! pub const FILES_EXCLUDE_KEY: &str = "files.exclude";
//! pub const SEARCH_EXCLUDE_KEY: &str = "search.exclude";
//! /// Vellis で settings.json を保存したとき全窓へ送るイベント名(フロント `src/lib/settings.ts` と同綴り)。
//! pub const SETTINGS_CHANGED_EVENT: &str = "settings_changed";
//!
//! /// 除外リスト 1 つ = パターン → true(除外する)/ false(その行を無効にする)。
//! pub type ExcludeMap = BTreeMap<String, bool>;
//!
//! /// 設定の中身。pub フィールドはこの 2 つだけ(本テストは構造体リテラルで組む)。
//! #[derive(Clone, Debug, PartialEq, Eq)]
//! pub struct Settings { pub files_exclude: ExcludeMap, pub search_exclude: ExcludeMap }
//! /// 契約5 の既定値。`search_exclude` は `EXCLUDED_DIR_NAMES` の各名前に `**/` を付けて作る(全部 true)。
//! impl Default for Settings { .. }
//! impl Settings {
//!     /// 値が true のパターンだけ(効いているもの)。順序は問わない。
//!     pub fn active_files_exclude(&self) -> Vec<&str>;
//!     pub fn active_search_exclude(&self) -> Vec<&str>;
//! }
//!
//! /// 読み込みの結果。`warnings` は英語の文(壊れた箇所ごとに 1 件以上・壊れていなければ空)。
//! #[derive(Clone, Debug)]
//! pub struct LoadedSettings { pub settings: Settings, pub warnings: Vec<String> }
//!
//! /// 文字列から読む純関数(契約4・8)。JSON でない/外がオブジェクトでない → 両方既定+警告。
//! /// キーの値がオブジェクトでない → そのキーだけ既定+警告。値が bool でない → その行だけ無視+警告。
//! /// キーがあればその辞書が全部(既定と足し合わせない)。キーが無ければ既定。知らないキーは黙って無視。
//! /// panic も Err もしない。
//! pub fn parse_settings(text: &str) -> LoadedSettings;
//! /// ファイルから読む。無ければ既定値・警告 0 件。読めなければ既定値+警告。
//! pub fn read_settings(path: &Path) -> LoadedSettings;
//! /// `read_settings(default_settings_path())`(無ければ既定)。command はこれを呼ぶ。
//! pub fn load_settings() -> LoadedSettings;
//! /// 置き場の純関数(契約4): `xdg_config_home` が Some で空でなければ `<それ>/vellis/settings.json`、
//! /// そうでなければ `<home>/.config/vellis/settings.json`。home も無ければ None。
//! /// (`cli_fix::default_config_path` と同じフォルダ・同じ決め方。環境変数はここでは読まない)
//! pub fn settings_path(xdg_config_home: Option<&str>, home: Option<&Path>) -> Option<PathBuf>;
//! /// 環境変数版(`XDG_CONFIG_HOME` と `dirs::home_dir()` を `settings_path` に渡す)。
//! pub fn default_settings_path() -> Option<PathBuf>;
//! /// `path` が `default_settings_path()` の指すファイルか(`save_document` が保存先を見分けるのに使う)。
//! pub fn is_settings_file(path: &Path) -> bool;
//! /// 「Settings…」で書き出す既定値の JSON(キーは files.exclude / search.exclude の 2 つだけ・
//! /// 読み戻すと `Settings::default()` と一致・警告 0)。
//! pub fn default_settings_json() -> String;
//! /// 契約6: `path` が無ければ親フォルダごと作って `default_settings_json()` を書き `Ok(true)`。
//! /// 有れば(壊れていても)バイト単位で触らず `Ok(false)`。
//! pub fn ensure_settings_file(path: &Path) -> std::io::Result<bool>;
//!
//! // --- 新規 src-tauri/src/exclude.rs(lib.rs に `pub mod exclude;`)---
//! use crate::fs::entry::Entry;
//! use crate::fs::uri::Uri;
//! use crate::settings::Settings;
//!
//! /// 契約3 の glob。`rel_path` は root からの相対(`/` 区切り・先頭 `/` 無し)。パス全体が一致したら true。
//! /// `*` = `/` を含まない 0 文字以上(`.` 始まりも対象)・`?` = `/` 以外の 1 文字・
//! /// 区切りの間に単独で書いた `**` = 0 個以上のフォルダ(`**/x`・`x/**`・`a/**/b`)・
//! /// 単独でない `**`(`a**b`)は `*` と同じ・大文字小文字は区別・`{a,b}` と `[abc]` は文字のまま。自前実装。
//! pub fn glob_match(pattern: &str, rel_path: &str) -> bool;
//!
//! /// `rel_path` 自身か、その祖先(`a`・`a/b`・…)のどれかが `patterns` のどれかに当たるか
//! /// (ディレクトリに当たれば配下ごと=契約3)。
//! pub fn path_or_ancestor_matches(patterns: &[&str], rel_path: &str) -> bool;
//!
//! /// 組み込みで固定する除外(契約2): 名前(最後のセグメント)が `.vellis-tmp` で終わるもの。設定に依らない。
//! pub const BUILTIN_TMP_SUFFIX: &str = ".vellis-tmp";
//! pub fn is_builtin_excluded(rel_path: &str) -> bool;
//!
//! /// ツリーから隠すか = 組み込み || `settings.active_files_exclude()` に `path_or_ancestor_matches`。
//! pub fn is_hidden_from_tree(rel_path: &str, settings: &Settings) -> bool;
//!
//! /// `dir` の一覧 `entries` から、ツリーに出さないものを落として返す(順序は保つ)。
//! /// 相対パスは `root` からの相対に `entry.name` を足したもの(`dir` が `root` の外なら名前だけ)。
//! /// kind は問わない(Symlink も名前で判定)。
//! pub fn filter_tree_entries_with(root: &Uri, dir: &Uri, entries: Vec<Entry>, settings: &Settings) -> Vec<Entry>;
//! /// `load_settings()` して `filter_tree_entries_with`。ツリーの一覧を返す全経路(AC-65-10)はこれ
//! /// (または `_with`)を `provider.list` の結果に通す。判定に要る root は窓の状態(WindowManager)から取る。
//! pub fn filter_tree_entries(root: &Uri, dir: &Uri, entries: Vec<Entry>) -> Vec<Entry>;
//!
//! // --- src-tauri/src/search/mod.rs に追加(既存の pub は無改変)---
//! use crate::settings::Settings;
//!
//! /// 検索パネルの欄(契約13)。pub フィールドはこの 3 つだけ。
//! #[derive(Clone, Debug, PartialEq, Eq)]
//! pub struct SearchFilter { pub include: Vec<String>, pub exclude: Vec<String>, pub use_exclude_settings: bool }
//! /// include: [] / exclude: [] / use_exclude_settings: true
//! impl Default for SearchFilter { .. }
//!
//! /// 1 回の検索が使う設定と欄。`Default` = `Settings::default()` + `SearchFilter::default()`(=今の除外)。
//! #[derive(Clone, Debug, Default)]
//! pub struct SearchScope { pub settings: Settings, pub filter: SearchFilter }
//! impl SearchScope {
//!     pub fn new(settings: Settings, filter: SearchFilter) -> Self;
//!     /// 走査の本体。`search_in_folder_streaming`(free fn・5 引数)と同じ引数・同じ戻り・同じ batch / 打ち切り。
//!     /// 判定順(契約13)= 組み込み(`.vellis-tmp`)→ files.exclude → (use_exclude_settings なら search.exclude)
//!     /// → 欄の exclude → 欄の include(空なら素通し)。ディレクトリは exclude 系だけで切り(`list` も呼ばない)、
//!     /// include はファイルで判定する(`docs/**` に対する `docs` は降りる)。include / exclude の判定は
//!     /// `path_or_ancestor_matches`(フォルダに当たれば配下全部)。各要素は trim し、空要素・空白だけの要素は無視。
//!     pub async fn search_in_folder_streaming(
//!         &self, provider: &dyn FileProvider, root: &Uri, query: &str,
//!         sink: &mut (dyn FnMut(SearchProgress) -> SearchControl + Send),
//!         cancel: &(dyn Fn() -> bool + Send + Sync),
//!     ) -> Result<SearchSummary, FsError>;
//!     /// 全部ためる薄い層(`search_in_folder_with` と同じ戻り)。
//!     pub async fn search_in_folder_with(&self, provider: &dyn FileProvider, root: &Uri, query: &str)
//!         -> Result<Vec<SearchHit>, FsError>;
//! }
//! // 既存の free fn は**シグネチャ不変**で `SearchScope::default()` を呼ぶ薄い包みにする:
//! //   search_in_folder_with(provider, root, query)                      … tests/acceptance_req55.rs
//! //   search_in_folder_streaming(provider, root, query, sink, cancel)   … tests/acceptance_req55b.rs
//! // command 本体(commands/search.rs)は `load_settings()` で設定を読み、`SearchScope::new(settings, SearchFilter{..})`
//! // の `.search_in_folder_streaming(` を呼ぶ(字面 `search_in_folder_streaming(` を保つ=55b の固定)。
//! // #[tauri::command] async fn search_in_folder(root, query, generation,
//! //     include: Vec<String>, exclude: Vec<String>, use_exclude_settings: bool, window, state, results)
//!
//! // --- src-tauri/src/menu.rs に追加(FIND_* と同じ家風)---
//! pub const SETTINGS_ITEM_ID: &str = "settings";
//! pub const SETTINGS_ACCELERATOR: &str = "CmdOrCtrl+,";   // "CmdOrCtrl+Comma" でもよい(Command + , を表す)
//! // ラベル "Settings…"・App メニュー(最初の Submenu・ラベル "Vellis")の項目スライスで
//! // `&about` より後・`&quit` より前。File メニューには出さない。
//! // `SETTINGS_ITEM_ID` は menu.rs では `let settings_item = MenuItem::with_id(app, SETTINGS_ITEM_ID, "Settings…", ..)`
//! // の 1 か所でだけ使う(束縛名は裁量。本テストは最後の使用箇所から `let` を遡って束縛名を取る=FIND_* と同じ)。
//! // lib.rs: `id if id == menu::SETTINGS_ITEM_ID => menu::handle_settings_click(app_handle)`(名前は裁量)
//! // 押すと Rust の中で: `ensure_settings_file(&default_settings_path()…)` → `create_window(app, Some(settings.json), Some(設定フォルダ), ..)`
//!
//! // --- src-tauri/src/commands/document.rs ---
//! // save_document: 書き込みの後、`is_settings_file(&resolved)` なら `read_settings` / `parse_settings` で検証して
//! //   `app.emit(SETTINGS_CHANGED_EVENT, ..)`(全窓)。warnings があれば英語の警告ダイアログを 1 回。
//! ```
//!
//! ## モックが前提にする `Entry` の使い方
//! `tests/acceptance_req55.rs` の MockFs と同じ作り: `list` は隠し名も `.vellis-tmp` も**そのまま返す**
//! (除外は走査側の判定=契約2「除外は 1 か所の判定に集める」)。`list` / `read_bytes` の呼び出しを記録し、
//! 「除外先は `list` すら呼ばれない」「除外ファイルは読まれない」を直接判定する。

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use async_trait::async_trait;
use muda::accelerator::{Accelerator, Code};
use tokio::sync::mpsc;

use vellis_lib::errors::FsError;
use vellis_lib::exclude::{
    filter_tree_entries_with, glob_match, is_builtin_excluded, is_hidden_from_tree,
    path_or_ancestor_matches, BUILTIN_TMP_SUFFIX,
};
use vellis_lib::fs::entry::{Entry, FileKind};
use vellis_lib::fs::local::LocalProvider;
use vellis_lib::fs::provider::{FileProvider, WatchEvent, WatchHandle};
use vellis_lib::fs::uri::Uri;
use vellis_lib::history::HISTORY_FILENAME;
use vellis_lib::menu::{SETTINGS_ACCELERATOR, SETTINGS_ITEM_ID};
use vellis_lib::search::{
    search_in_folder_with, SearchFilter, SearchHit, SearchScope, EXCLUDED_DIR_NAMES,
};
use vellis_lib::settings::{
    default_settings_json, ensure_settings_file, parse_settings, read_settings, settings_path,
    ExcludeMap, Settings, FILES_EXCLUDE_KEY, SEARCH_EXCLUDE_KEY, SETTINGS_CHANGED_EVENT,
    SETTINGS_FILENAME,
};

// ---------------------------------------------------------------------------
// モック FileProvider(メモリ上の木・acceptance_req55.rs の MockFs と同じ作り)
// ---------------------------------------------------------------------------

struct MockFs {
    scheme: &'static str,
    root: Uri,
    /// ディレクトリの絶対パス → 直下のエントリ(隠し名も一時ファイルもそのまま入る)
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

    fn was_read(&self, rel: &str) -> bool {
        let abs = self.abs_path(rel);
        self.read_calls().iter().any(|p| *p == abs)
    }

    fn was_listed(&self, rel: &str) -> bool {
        let abs = self.abs_path(rel);
        self.list_calls().iter().any(|p| *p == abs)
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
        // local.rs と同じ: ディレクトリ先行・名前順。隠し名は落とさない(契約2)。
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

/// 日本語(CJK)の検知(要件#51 と同じ範囲): 警告文が英語であることの判定に使う。
fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| {
        let u = c as u32;
        (0x3000..=0x303F).contains(&u)
            || (0x3040..=0x30FF).contains(&u)
            || (0x4E00..=0x9FFF).contains(&u)
            || (0xFF00..=0xFFEF).contains(&u)
    })
}

fn map(pairs: &[(&str, bool)]) -> ExcludeMap {
    pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
}

fn settings_from(json: &str) -> Settings {
    parse_settings(json).settings
}

fn default_files_exclude() -> ExcludeMap {
    map(&[("**/.*", true), ("**/.git", true), ("**/.DS_Store", true)])
}

fn default_search_exclude() -> ExcludeMap {
    EXCLUDED_DIR_NAMES.iter().map(|n| (format!("**/{n}"), true)).collect()
}

fn paths(hits: &[SearchHit]) -> Vec<String> {
    hits.iter().map(|h| h.path.clone()).collect()
}

async fn run_default(fs: &MockFs, query: &str) -> Vec<SearchHit> {
    search_in_folder_with(fs, &fs.root, query)
        .await
        .unwrap_or_else(|e| panic!("search_in_folder_with({query:?}) must succeed: {e}"))
}

async fn run_scope(fs: &MockFs, scope: &SearchScope, query: &str) -> Vec<SearchHit> {
    scope
        .search_in_folder_with(fs, &fs.root, query)
        .await
        .unwrap_or_else(|e| panic!("SearchScope::search_in_folder_with({query:?}) must succeed: {e}"))
}

fn scope_with(settings: Settings) -> SearchScope {
    SearchScope::new(settings, SearchFilter::default())
}

fn filter(include: &[&str], exclude: &[&str], use_exclude_settings: bool) -> SearchFilter {
    // 構造体リテラル=フィールドがこの 3 つだけであることのコンパイル時の担保。
    SearchFilter {
        include: include.iter().map(|s| s.to_string()).collect(),
        exclude: exclude.iter().map(|s| s.to_string()).collect(),
        use_exclude_settings,
    }
}

fn scope_filtered(filter: SearchFilter) -> SearchScope {
    SearchScope::new(Settings::default(), filter)
}

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

fn menu_rs_code() -> String {
    strip_line_comments(include_str!("../src/menu.rs"))
}

fn lib_rs_code() -> String {
    strip_line_comments(include_str!("../src/lib.rs"))
}

fn settings_rs_code() -> String {
    strip_line_comments(include_str!("../src/settings.rs"))
}

fn document_rs_code() -> String {
    strip_line_comments(include_str!("../src/commands/document.rs"))
}

fn search_command_code() -> String {
    strip_line_comments(include_str!("../src/commands/search.rs"))
}

/// `fn <name>(` から、次の `#[tauri::command]` か次の関数の頭(行頭または impl の 4 字下げの
/// `fn ` / `async fn ` / `pub fn ` / `pub async fn `)か `#[cfg(test)]` まで。
fn fn_body(code: &str, name: &str) -> String {
    let marker = format!("fn {name}(");
    let at = code.find(&marker).unwrap_or_else(|| panic!("`{marker}` must exist"));
    let rest = &code[at + marker.len()..];
    let mut end = rest.len();
    for stop in [
        "#[tauri::command]",
        "\nasync fn ",
        "\nfn ",
        "\npub async fn ",
        "\npub fn ",
        "\n    async fn ",
        "\n    fn ",
        "\n    pub async fn ",
        "\n    pub fn ",
        "\n#[cfg(test)]",
    ] {
        if let Some(i) = rest.find(stop) {
            end = end.min(i);
        }
    }
    format!("{marker}{}", &rest[..end])
}

/// `start` から最初の `(` に対応する閉じ括弧までの呼び出し全体(acceptance_req60 の写し)。
fn balanced_call(code: &str, start: usize) -> &str {
    let open = code[start..].find('(').expect("call must have '('") + start;
    let mut depth = 0usize;
    for (i, c) in code[open..].char_indices() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => {
                depth -= 1;
                if depth == 0 {
                    return &code[start..=open + i];
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced call starting at byte {start}");
}

fn first_string_literal(s: &str) -> Option<&str> {
    let a = s.find('"')? + 1;
    let b = s[a..].find('"')? + a;
    Some(&s[a..b])
}

fn submenu_call_with_label<'a>(code: &'a str, label: &str) -> Option<&'a str> {
    let mut search = 0;
    while let Some(rel) = code[search..].find("Submenu::with_") {
        let start = search + rel;
        let call = balanced_call(code, start);
        search = start + "Submenu::with_".len();
        if first_string_literal(call) == Some(label) {
            return Some(call);
        }
    }
    None
}

/// Submenu 呼び出しの項目スライス(`&[…]`)の識別子列(`&name` の name)。
fn slice_idents(call: &str) -> Vec<String> {
    let open = call.find("&[").expect("Submenu::with_items must take a slice");
    let end = call[open..].find(']').expect("slice must close") + open;
    call[open + 2..end]
        .split(',')
        .map(|s| s.trim().trim_start_matches('&').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// `const_name` で束ねられた MenuItem の束縛名(`let xxx = MenuItem::with_id(app, CONST, …)`)。
fn item_binding<'a>(code: &'a str, const_name: &str) -> &'a str {
    let use_pos = code
        .rfind(const_name)
        .unwrap_or_else(|| panic!("menu.rs must use {const_name}"));
    let let_pos = code[..use_pos]
        .rfind("let ")
        .unwrap_or_else(|| panic!("{const_name} must be used inside a let binding"));
    code[let_pos + 4..use_pos]
        .split(|c: char| c == '=' || c.is_whitespace())
        .find(|s| !s.is_empty())
        .expect("binding name after `let`")
}

/// menu.rs のコード部分から二重引用符の文字列リテラルを取り出す(acceptance_req60 の写し)。
fn menu_rs_string_literals() -> Vec<String> {
    let code = menu_rs_code();
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_str = false;
    let mut chars = code.chars();
    while let Some(c) = chars.next() {
        if in_str {
            match c {
                '\\' => {
                    cur.push(c);
                    if let Some(next) = chars.next() {
                        cur.push(next);
                    }
                }
                '"' => {
                    out.push(std::mem::take(&mut cur));
                    in_str = false;
                }
                _ => cur.push(c),
            }
        } else if c == '"' {
            in_str = true;
        }
    }
    out
}

fn make_local_uri(path: &Path) -> Uri {
    Uri {
        scheme: "file".into(),
        authority: None,
        path: path.to_path_buf(),
        raw: format!("file://{}", path.display()),
    }
}

fn names(entries: &[Entry]) -> Vec<String> {
    entries.iter().map(|e| e.name.clone()).collect()
}

fn entry(root: &Uri, rel: &str, kind: FileKind) -> Entry {
    let uri = root.with_path(root.path.join(rel));
    Entry {
        uri: uri.raw,
        name: rel.rsplit('/').next().unwrap_or(rel).to_string(),
        kind,
        size: None,
        modified: None,
        link: None,
    }
}

// ---------------------------------------------------------------------------
// AC-65-1 — glob の照合(契約3)
// ---------------------------------------------------------------------------

fn assert_glob_table(cases: &[(&str, &str, bool)]) {
    for (pattern, path, expected) in cases {
        assert_eq!(
            glob_match(pattern, path),
            *expected,
            "glob_match({pattern:?}, {path:?}) must be {expected}"
        );
    }
}

/// 1. `**/name` はどの深さの名前にも当たり、前方一致や部分一致では当たらない。
#[test]
fn glob_double_star_prefix_matches_a_name_at_any_depth_but_not_partially() {
    assert_glob_table(&[
        ("**/node_modules", "node_modules", true),
        ("**/node_modules", "a/b/node_modules", true),
        ("**/node_modules", "node_modules_x", false),
        ("**/target", "target.md", false),
        ("**/target", "targets", false),
    ]);
}

/// 2. `*` は `/` をまたがない(`*.log` は root 直下だけ)。`**/*.log` なら全階層。
#[test]
fn glob_single_star_stays_inside_one_segment() {
    assert_glob_table(&[
        ("*.log", "a.log", true),
        ("*.log", "sub/a.log", false),
        ("**/*.log", "sub/a.log", true),
        ("**/*.log", "a.log", true),
    ]);
}

/// 3. 末尾の `docs/drafts/**` はフォルダ自身(0 個)にも配下にも当たる。途中の `a/**/b` も同じ。
#[test]
fn glob_double_star_at_the_end_and_in_the_middle_spans_zero_or_more_folders() {
    assert_glob_table(&[
        ("docs/drafts/**", "docs/drafts", true),
        ("docs/drafts/**", "docs/drafts/x/y.md", true),
        ("docs/drafts/**", "docs/draftsX/a.md", false),
        ("a/**/b", "a/b", true),
        ("a/**/b", "a/x/y/b", true),
    ]);
}

/// 4. `.` 始まりの名前も `*` の対象(シェルと違う)。`**/.*` は「どこかの `.` 始まりの名前」。
#[test]
fn glob_star_covers_dot_names() {
    assert_glob_table(&[
        ("**/.*", ".env", true),
        ("**/.*", "a/.git", true),
        ("**/.*", "a/b.c", false),
        ("**/*.md", ".draft.md", true),
    ]);
}

/// 5. `?` は `/` 以外の 1 文字。
#[test]
fn glob_question_mark_is_exactly_one_non_slash_char() {
    assert_glob_table(&[("?.md", "a.md", true), ("?.md", "ab.md", false), ("?", "/", false)]);
}

/// 6. 大文字小文字は区別する。`{a,b}` は文字のまま(記法として解釈しない)。
#[test]
fn glob_is_case_sensitive_and_braces_are_literal() {
    assert_glob_table(&[
        ("**/Build", "build", false),
        ("**/build", "build", true),
        ("{a,b}.md", "a.md", false),
        ("{a,b}.md", "{a,b}.md", true),
    ]);
}

/// 7. 区切りの間に単独で書かれていない `**`(`a**b`)は `*` と同じ(契約3)。
#[test]
fn glob_non_solitary_double_star_acts_as_a_single_star() {
    assert_glob_table(&[("a**b", "axxb", true), ("a**b", "ab", true), ("a**b", "a/b", false)]);
}

/// 8. 祖先を含む判定: `path_or_ancestor_matches` はパス自身か祖先のどれかが当たれば true。
#[test]
fn path_or_ancestor_matches_walks_up_the_directories() {
    assert!(path_or_ancestor_matches(&["**/.*"], ".github/workflows/ci.yml"));
    assert!(path_or_ancestor_matches(&["docs/drafts/**"], "docs/drafts/x.md"));
    assert!(path_or_ancestor_matches(&["docs"], "docs/a.md"), "a folder pattern covers its contents");
    assert!(!path_or_ancestor_matches(&["docs"], "other/docs/a.md"), "patterns are anchored at the root");
    assert!(!path_or_ancestor_matches(&["*.log"], "sub/a.log"));
    assert!(!path_or_ancestor_matches(&[], "anything.md"));
}

// ---------------------------------------------------------------------------
// AC-65-2 — 既定値(契約5)・AC-65-13 の `EXCLUDED_DIR_NAMES` 不変
// ---------------------------------------------------------------------------

/// 9. 既定の files.exclude は `**/.*`・`**/.git`・`**/.DS_Store`(全部 true)と集合で一致。
#[test]
fn default_files_exclude_is_the_three_dot_patterns() {
    let defaults = Settings::default();
    assert_eq!(defaults.files_exclude, default_files_exclude());
    let active: BTreeSet<&str> = defaults.active_files_exclude().into_iter().collect();
    let expected: BTreeSet<&str> = ["**/.*", "**/.git", "**/.DS_Store"].into_iter().collect();
    assert_eq!(active, expected);
}

/// 10. 既定の search.exclude は `EXCLUDED_DIR_NAMES` の各名前に `**/` を付けた 6 つ(全部 true)。
///     `EXCLUDED_DIR_NAMES` の値は AC-55-2 のまま(AC-65-13)。
#[test]
fn default_search_exclude_mirrors_excluded_dir_names() {
    let expected_names: BTreeSet<&str> =
        [".git", "node_modules", "target", "dist", "build", ".svelte-kit"].into_iter().collect();
    let actual_names: BTreeSet<&str> = EXCLUDED_DIR_NAMES.iter().copied().collect();
    assert_eq!(actual_names, expected_names, "EXCLUDED_DIR_NAMES must stay as AC-55-2 fixed it");
    assert_eq!(EXCLUDED_DIR_NAMES.len(), 6);

    let defaults = Settings::default();
    assert_eq!(defaults.search_exclude, default_search_exclude());
    assert_eq!(defaults.search_exclude.len(), 6);
    let active: BTreeSet<&str> = defaults.active_search_exclude().into_iter().collect();
    let expected: BTreeSet<String> = expected_names.iter().map(|n| format!("**/{n}")).collect();
    assert_eq!(active.iter().map(|s| s.to_string()).collect::<BTreeSet<_>>(), expected);
}

/// 11. 既定値の JSON はキーが files.exclude / search.exclude の 2 つだけで、読み戻すと既定値・警告 0 件。
#[test]
fn default_settings_json_round_trips_to_the_defaults_without_warnings() {
    let json = default_settings_json();
    let value: serde_json::Value = serde_json::from_str(&json).expect("default JSON must parse");
    let object = value.as_object().expect("default JSON is an object");
    let keys: BTreeSet<&str> = object.keys().map(String::as_str).collect();
    let expected_keys: BTreeSet<&str> = [FILES_EXCLUDE_KEY, SEARCH_EXCLUDE_KEY].into_iter().collect();
    assert_eq!(keys, expected_keys, "the default JSON carries exactly the two keys");
    assert_eq!(FILES_EXCLUDE_KEY, "files.exclude");
    assert_eq!(SEARCH_EXCLUDE_KEY, "search.exclude");
    for key in [FILES_EXCLUDE_KEY, SEARCH_EXCLUDE_KEY] {
        let dict = object[key].as_object().unwrap_or_else(|| panic!("{key} must be an object"));
        assert!(dict.values().all(|v| v == &serde_json::Value::Bool(true)), "{key}: every default line is true");
    }

    let loaded = parse_settings(&json);
    assert!(loaded.warnings.is_empty(), "defaults must load cleanly: {:?}", loaded.warnings);
    assert_eq!(loaded.settings, Settings::default());
}

// ---------------------------------------------------------------------------
// AC-65-3 — 読み込みの規則(契約4)
// ---------------------------------------------------------------------------

/// 12. `{}` → 両方とも既定値・警告 0 件。
#[test]
fn empty_object_yields_the_defaults_without_warnings() {
    let loaded = parse_settings("{}");
    assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    assert_eq!(loaded.settings, Settings::default());
}

/// 13. キーがあればその辞書が全部(既定と足し合わせない)。無いキーは既定値。
#[test]
fn a_written_key_replaces_that_list_entirely_and_a_missing_key_keeps_the_default() {
    let loaded = parse_settings(r#"{"files.exclude": {"**/*.log": true}}"#);
    assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    assert_eq!(loaded.settings.files_exclude, map(&[("**/*.log", true)]));
    assert_eq!(loaded.settings.search_exclude, default_search_exclude());

    let loaded = parse_settings(r#"{"search.exclude": {"**/out": true}}"#);
    assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    assert_eq!(loaded.settings.search_exclude, map(&[("**/out", true)]));
    assert_eq!(loaded.settings.files_exclude, default_files_exclude());
}

/// 14. `false` はその行を無効にする(消さずに一時的に外せる): `.env` は隠れず `.git` は隠れる。
#[test]
fn false_disables_a_line_while_true_keeps_it() {
    let s = settings_from(r#"{"files.exclude": {"**/.*": false, "**/.git": true}}"#);
    assert_eq!(s.files_exclude, map(&[("**/.*", false), ("**/.git", true)]));
    assert_eq!(s.active_files_exclude(), vec!["**/.git"]);
    assert!(!is_hidden_from_tree(".env", &s), ".env must show once **/.* is false");
    assert!(is_hidden_from_tree(".git", &s));
    assert!(is_hidden_from_tree("a/.git", &s));
    assert!(!is_hidden_from_tree(".github", &s));
}

/// 15. `{"files.exclude": {}}` → 何も隠さない(空の辞書は既定に戻らない)。
#[test]
fn an_empty_dictionary_hides_nothing() {
    let loaded = parse_settings(r#"{"files.exclude": {}}"#);
    assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    assert!(loaded.settings.files_exclude.is_empty());
    assert!(loaded.settings.active_files_exclude().is_empty());
    assert!(!is_hidden_from_tree(".env", &loaded.settings));
    assert!(!is_hidden_from_tree(".git", &loaded.settings));
}

/// 16. 知らないキーは警告 0 件で無視する(後の要件で設定を足しても古い Vellis が壊れない)。
#[test]
fn unknown_keys_are_ignored_without_warnings() {
    let loaded = parse_settings(r#"{"editor.fontSize": 14, "files.exclude": {"**/x": true}}"#);
    assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    assert_eq!(loaded.settings.files_exclude, map(&[("**/x", true)]));
    assert_eq!(loaded.settings.search_exclude, default_search_exclude());
}

// ---------------------------------------------------------------------------
// AC-65-4 — 壊れた設定(契約8)
// ---------------------------------------------------------------------------

/// 17. JSON でない・配列・文字列 → 両方既定値・警告 1 件以上(英語)・panic も Err もしない。
#[test]
fn unreadable_or_non_object_json_falls_back_to_the_defaults_with_a_warning() {
    for text in ["not json", "[]", "\"x\"", "", "{\"files.exclude\": {}", "null", "42"] {
        let loaded = parse_settings(text);
        assert_eq!(loaded.settings, Settings::default(), "{text:?} must yield the defaults");
        assert!(!loaded.warnings.is_empty(), "{text:?} must produce a warning");
        for w in &loaded.warnings {
            assert!(!has_cjk(w), "warnings are English: {w}");
        }
    }
}

/// 18. キーの値がオブジェクトでない → そのキーだけ既定値。もう一方は書いたとおり(無ければ既定)。
#[test]
fn a_non_object_key_falls_back_for_that_key_only() {
    let loaded = parse_settings(r#"{"files.exclude": ["**/.git"]}"#);
    assert_eq!(loaded.settings.files_exclude, default_files_exclude());
    assert_eq!(loaded.settings.search_exclude, default_search_exclude());
    assert!(!loaded.warnings.is_empty());

    let loaded = parse_settings(r#"{"files.exclude": ["**/.git"], "search.exclude": {"**/out": true}}"#);
    assert_eq!(loaded.settings.files_exclude, default_files_exclude());
    assert_eq!(loaded.settings.search_exclude, map(&[("**/out", true)]));
    assert!(!loaded.warnings.is_empty());

    let loaded = parse_settings(r#"{"search.exclude": "**/out"}"#);
    assert_eq!(loaded.settings.search_exclude, default_search_exclude());
    assert_eq!(loaded.settings.files_exclude, default_files_exclude());
    assert!(!loaded.warnings.is_empty());
    for w in &loaded.warnings {
        assert!(!has_cjk(w), "warnings are English: {w}");
    }
}

/// 19. 辞書の値が true/false でない → その行だけ無視(残りは効く)・警告 1 件以上。
#[test]
fn a_non_boolean_value_drops_that_line_only() {
    let loaded = parse_settings(r#"{"search.exclude": {"**/a": true, "**/b": "yes", "**/c": 1}}"#);
    assert_eq!(loaded.settings.search_exclude, map(&[("**/a", true)]));
    assert_eq!(loaded.settings.active_search_exclude(), vec!["**/a"]);
    assert_eq!(loaded.settings.files_exclude, default_files_exclude());
    assert!(!loaded.warnings.is_empty());
}

/// 20. ファイルが無ければ既定値・警告 0 件。読める既定値ファイルも同じ。
#[test]
fn a_missing_file_yields_the_defaults_without_warnings() {
    let tmp = tempfile::TempDir::new().unwrap();
    let missing = tmp.path().join("nope").join(SETTINGS_FILENAME);
    let loaded = read_settings(&missing);
    assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    assert_eq!(loaded.settings, Settings::default());

    let present = tmp.path().join(SETTINGS_FILENAME);
    std::fs::write(&present, r#"{"files.exclude": {"**/secret": true}}"#).unwrap();
    let loaded = read_settings(&present);
    assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    assert_eq!(loaded.settings.files_exclude, map(&[("**/secret", true)]));

    std::fs::write(&present, "not json").unwrap();
    let loaded = read_settings(&present);
    assert_eq!(loaded.settings, Settings::default());
    assert!(!loaded.warnings.is_empty(), "a broken file on disk warns like a broken string");
}

// ---------------------------------------------------------------------------
// AC-65-5 — 置き場(契約4)
// ---------------------------------------------------------------------------

/// 21. `XDG_CONFIG_HOME` が空でなければ `<それ>/vellis/settings.json`(home は見ない)。
#[test]
fn settings_path_prefers_a_non_empty_xdg_config_home() {
    let home = Path::new("/home/u");
    assert_eq!(
        settings_path(Some("/xdg"), Some(home)),
        Some(PathBuf::from("/xdg/vellis/settings.json"))
    );
    assert_eq!(settings_path(Some("/xdg"), None), Some(PathBuf::from("/xdg/vellis/settings.json")));
}

/// 22. 空か無ければ `<home>/.config/vellis/settings.json`。home も無ければ None。
#[test]
fn settings_path_falls_back_to_home_dot_config() {
    let home = Path::new("/home/u");
    let expected = Some(PathBuf::from("/home/u/.config/vellis/settings.json"));
    assert_eq!(settings_path(Some(""), Some(home)), expected);
    assert_eq!(settings_path(None, Some(home)), expected);
    assert_eq!(settings_path(None, None), None);
    assert_eq!(settings_path(Some(""), None), None);
}

/// 23. ファイル名は `settings.json`(`history.json` と違う)。フォルダは `cli_fix::default_config_path`
///     と同じ `vellis`(`agents.toml` の隣)。
#[test]
fn settings_file_name_is_fixed_and_differs_from_the_history_file() {
    assert_eq!(SETTINGS_FILENAME, "settings.json");
    assert_ne!(SETTINGS_FILENAME, HISTORY_FILENAME);
    let path = settings_path(Some("/xdg"), None).unwrap();
    assert_eq!(path.file_name().and_then(|n| n.to_str()), Some(SETTINGS_FILENAME));
    // cli_fix.rs: `$XDG_CONFIG_HOME/vellis/agents.toml` — the same `vellis` folder.
    assert_eq!(path.parent(), Some(Path::new("/xdg/vellis")));
}

// ---------------------------------------------------------------------------
// AC-65-6 — 書き出し(契約6)
// ---------------------------------------------------------------------------

/// 24. 無ければ親フォルダごと作って既定値の JSON を書き、読み戻すと既定値。
#[test]
fn ensure_settings_file_creates_parents_and_writes_the_defaults_when_missing() {
    let tmp = tempfile::TempDir::new().unwrap();
    let path = tmp.path().join("cfg").join("vellis").join(SETTINGS_FILENAME);
    assert!(!path.exists());

    let created = ensure_settings_file(&path).expect("creating the file must succeed");

    assert!(created, "a missing file is created");
    assert!(path.is_file());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), default_settings_json());
    let loaded = read_settings(&path);
    assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    assert_eq!(loaded.settings, Settings::default());
}

/// 25. 有れば(壊れた中身でも・自分で書いた中身でも)バイト単位で変わらない。
#[test]
fn ensure_settings_file_leaves_an_existing_file_untouched_even_when_broken() {
    let tmp = tempfile::TempDir::new().unwrap();
    let path = tmp.path().join(SETTINGS_FILENAME);
    for content in ["not json {{{", "{\"files.exclude\": {\"**/x\": true}}\n", "", "// comment\n{}"] {
        std::fs::write(&path, content).unwrap();
        let created = ensure_settings_file(&path).expect("an existing file must not error");
        assert!(!created, "an existing file is reported as not created: {content:?}");
        assert_eq!(std::fs::read(&path).unwrap(), content.as_bytes(), "bytes must be untouched: {content:?}");
    }
}

// ---------------------------------------------------------------------------
// AC-65-7 — ツリーの判定(契約1・2・9)
// ---------------------------------------------------------------------------

/// 26. 既定値は `.` 始まり(と配下)を隠し、search.exclude だけのもの(node_modules・target)と普通のファイルは出す。
#[test]
fn tree_hides_files_exclude_matches_and_shows_search_exclude_only_names() {
    let s = Settings::default();
    for hidden in [".env", "a/.git", ".DS_Store", ".github/x.yml", "docs/.drafts/a.md", ".git"] {
        assert!(is_hidden_from_tree(hidden, &s), "{hidden} must be hidden by the defaults");
    }
    for shown in ["node_modules", "target", "docs/a.md", "build", "dist", "a/node_modules/x.js", "readme.md"] {
        assert!(!is_hidden_from_tree(shown, &s), "{shown} must stay in the tree (search.exclude only)");
    }
}

/// 27. `{"files.exclude": {}}` では `.env` を隠さない。使う人のパターン(`**/secret`)は隠す。
#[test]
fn tree_follows_the_files_exclude_dictionary() {
    let empty = settings_from(r#"{"files.exclude": {}}"#);
    assert!(!is_hidden_from_tree(".env", &empty));
    assert!(!is_hidden_from_tree(".github/x.yml", &empty));

    let custom = settings_from(r#"{"files.exclude": {"**/secret": true, "docs/drafts/**": true}}"#);
    assert!(is_hidden_from_tree("secret", &custom));
    assert!(is_hidden_from_tree("a/secret/b.md", &custom));
    assert!(is_hidden_from_tree("docs/drafts", &custom));
    assert!(is_hidden_from_tree("docs/drafts/x.md", &custom));
    assert!(!is_hidden_from_tree("docs/a.md", &custom));
    assert!(!is_hidden_from_tree(".env", &custom), "search.exclude / the old dot rule do not apply once replaced");
}

/// 28. 名前が `.vellis-tmp` で終わるものはどの設定でも隠す(`files.exclude` が空でも)。
#[test]
fn tree_always_hides_vellis_tmp_files_whatever_the_settings() {
    assert_eq!(BUILTIN_TMP_SUFFIX, ".vellis-tmp");
    assert!(is_builtin_excluded(".a.md.vellis-tmp"));
    assert!(is_builtin_excluded("docs/.a.md.vellis-tmp"));
    assert!(is_builtin_excluded("plain.vellis-tmp"));
    assert!(!is_builtin_excluded("a.md"));
    assert!(!is_builtin_excluded("vellis-tmp.md"));

    let none = Settings { files_exclude: ExcludeMap::new(), search_exclude: ExcludeMap::new() };
    for s in [Settings::default(), settings_from(r#"{"files.exclude": {}}"#), none] {
        assert!(is_hidden_from_tree(".a.md.vellis-tmp", &s));
        assert!(is_hidden_from_tree("docs/.a.md.vellis-tmp", &s));
    }
}

/// 29. `filter_tree_entries_with` は root からの相対パスで判定し、順序を保ち、kind を問わない。
#[test]
fn filter_tree_entries_judges_by_root_relative_path_and_keeps_order() {
    let root = Uri::parse(FILE_ROOT).unwrap();
    let docs = root.with_path(root.path.join("docs"));
    let entries = vec![
        entry(&root, "docs/drafts", FileKind::Dir),
        entry(&root, "docs/sub", FileKind::Dir),
        entry(&root, "docs/.broken", FileKind::Symlink),
        entry(&root, "docs/a.md", FileKind::File),
        entry(&root, "docs/.a.md.vellis-tmp", FileKind::File),
        entry(&root, "docs/.env", FileKind::File),
        entry(&root, "docs/node_modules", FileKind::Dir),
    ];

    let kept = filter_tree_entries_with(&root, &docs, entries.clone(), &Settings::default());
    assert_eq!(names(&kept), vec!["drafts", "sub", "a.md", "node_modules"]);

    let custom = settings_from(r#"{"files.exclude": {"docs/drafts/**": true}}"#);
    let kept = filter_tree_entries_with(&root, &docs, entries.clone(), &custom);
    assert_eq!(names(&kept), vec!["sub", ".broken", "a.md", ".env", "node_modules"]);

    // `docs/drafts/**` is anchored: the same names under another folder stay.
    let other = root.with_path(root.path.join("other/docs"));
    let other_entries = vec![entry(&root, "other/docs/drafts", FileKind::Dir), entry(&root, "other/docs/a.md", FileKind::File)];
    let kept = filter_tree_entries_with(&root, &other, other_entries, &custom);
    assert_eq!(names(&kept), vec!["drafts", "a.md"]);

    // root 直下(dir == root)。
    let top = vec![entry(&root, ".git", FileKind::Dir), entry(&root, "src", FileKind::Dir), entry(&root, ".DS_Store", FileKind::File)];
    let kept = filter_tree_entries_with(&root, &root, top, &Settings::default());
    assert_eq!(names(&kept), vec!["src"]);
}

/// 30. ssh の root でも相対パスは scheme / authority を含まず、同じ判定になる。
#[test]
fn filter_tree_entries_works_the_same_under_an_ssh_root() {
    let root = Uri::parse(SSH_ROOT).unwrap();
    let docs = root.with_path(root.path.join("docs"));
    let entries = vec![
        entry(&root, "docs/drafts", FileKind::Dir),
        entry(&root, "docs/.env", FileKind::File),
        entry(&root, "docs/a.md", FileKind::File),
    ];
    let custom = settings_from(r#"{"files.exclude": {"docs/drafts/**": true, "**/.*": true}}"#);
    let kept = filter_tree_entries_with(&root, &docs, entries, &custom);
    assert_eq!(names(&kept), vec!["a.md"]);
}

// ---------------------------------------------------------------------------
// AC-65-8 — `LocalProvider::list` は隠し名も返す(契約2・11=要件#31 AC-31-6 の置き換え)
// ---------------------------------------------------------------------------

/// 31. `.hidden.md`・`.hidden-dir/`・`visible.md` を置くと 3 つとも返る(隠すのは除外の判定であって `list` ではない)。
#[tokio::test]
async fn local_list_returns_hidden_names_too() {
    let tmp = tempfile::TempDir::new().unwrap();
    let root = tmp.path().join("root");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join(".hidden.md"), "# h").unwrap();
    std::fs::create_dir(root.join(".hidden-dir")).unwrap();
    std::fs::write(root.join("visible.md"), "v").unwrap();

    let entries = LocalProvider::new().list(&make_local_uri(&root)).await.unwrap();

    let got: BTreeSet<String> = names(&entries).into_iter().collect();
    let expected: BTreeSet<String> =
        [".hidden.md", ".hidden-dir", "visible.md"].iter().map(|s| s.to_string()).collect();
    assert_eq!(got, expected, "hidden names are listed like any other (要件#65 契約2)");
    let kind_of = |n: &str| entries.iter().find(|e| e.name == n).map(|e| e.kind).unwrap();
    assert_eq!(kind_of(".hidden-dir"), FileKind::Dir);
    assert_eq!(kind_of(".hidden.md"), FileKind::File);
    assert_eq!(names(&entries)[0], ".hidden-dir", "directories still come first");
}

/// 32. `.` 始まりの壊れたリンクがあっても一覧は失敗せず、そのリンクは `Symlink` として返る
///     (要件#31 の「壊れたリンクで一覧が失敗しない」を隠し名にも保つ)。
#[cfg(unix)]
#[tokio::test]
async fn local_list_survives_a_hidden_broken_symlink_and_lists_it_as_symlink() {
    use std::os::unix::fs::symlink;
    let tmp = tempfile::TempDir::new().unwrap();
    let root = tmp.path().join("root");
    std::fs::create_dir(&root).unwrap();
    let target_dir = tmp.path().join("hidden-target");
    std::fs::create_dir(&target_dir).unwrap();
    symlink(&target_dir, root.join(".hidden-link")).unwrap();
    symlink(tmp.path().join("no-such"), root.join(".broken-link")).unwrap();
    std::fs::write(root.join("visible.txt"), "v").unwrap();

    let entries = LocalProvider::new()
        .list(&make_local_uri(&root))
        .await
        .expect("a hidden broken symlink must not fail the listing");

    let kind_of = |n: &str| {
        entries
            .iter()
            .find(|e| e.name == n)
            .unwrap_or_else(|| panic!("{n} must be listed (got {:?})", names(&entries)))
            .kind
    };
    assert_eq!(kind_of(".broken-link"), FileKind::Symlink);
    assert_eq!(kind_of(".hidden-link"), FileKind::Dir, "a link to a directory resolves to Dir (要件#31 契約①)");
    assert_eq!(kind_of("visible.txt"), FileKind::File);
}

// ---------------------------------------------------------------------------
// AC-65-9 — 検索への適用(契約1・9)
// ---------------------------------------------------------------------------

/// AC-55-2 と同じ木: 除外ディレクトリと `.` 始まりの中に一致を置き、`keep/ok.md` と `target.md` だけが残る。
fn populate_ac55_2_tree(fs: &mut MockFs) {
    for dir in EXCLUDED_DIR_NAMES {
        fs.file(&format!("{dir}/hit.md"), "alpha inside excluded\n");
        fs.file(&format!("keep/{dir}/hit.md"), "alpha inside nested excluded\n");
    }
    fs.file(".hidden/x.md", "alpha in hidden dir\n");
    fs.file(".secret.md", "alpha in hidden file\n");
    fs.file("keep/.also-hidden.txt", "alpha in nested hidden file\n");
    fs.file("keep/ok.md", "alpha kept\n");
    fs.file("target.md", "alpha in a file merely named like target\n");
}

fn assert_ac55_2_scan(fs: &MockFs, hits: &[SearchHit]) {
    assert_eq!(paths(hits), vec!["keep/ok.md", "target.md"]);
    for dir in EXCLUDED_DIR_NAMES {
        assert!(!fs.was_listed(dir), "{dir} must not be listed");
        assert!(!fs.was_listed(&format!("keep/{dir}")), "keep/{dir} must not be listed");
        assert!(!fs.was_read(&format!("{dir}/hit.md")));
    }
    assert!(!fs.was_listed(".hidden"));
    assert!(!fs.was_read(".secret.md"));
    assert!(!fs.was_read("keep/.also-hidden.txt"));
}

/// 33. 既定値では AC-55-2 と同じ結果(除外ディレクトリと `.` 始まりは `list` も読みもされない)。
#[tokio::test]
async fn search_defaults_skip_excluded_dirs_and_dot_names_like_ac_55_2() {
    let mut fs = MockFs::new(FILE_ROOT);
    populate_ac55_2_tree(&mut fs);

    let hits = run_scope(&fs, &scope_with(Settings::default()), "alpha").await;

    assert_ac55_2_scan(&fs, &hits);
}

/// 34. `{"search.exclude": {"**/*.log": true}}` → `.log` は読まれない・`node_modules/` は読まれる
///     (キーがあれば既定を置き換える)・`.` 始まりは読まれない(`files.exclude` は既定のまま)。
#[tokio::test]
async fn search_exclude_key_replaces_the_default_list() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("a.md", "alpha a\n");
    fs.file("b.log", "alpha b\n");
    fs.file("sub/c.log", "alpha c\n");
    fs.file("node_modules/x.md", "alpha in node_modules\n");
    fs.file("target/t.md", "alpha in target\n");
    fs.file(".secret.md", "alpha hidden\n");
    fs.file(".hidden/y.md", "alpha hidden dir\n");

    let scope = scope_with(settings_from(r#"{"search.exclude": {"**/*.log": true}}"#));
    let hits = run_scope(&fs, &scope, "alpha").await;

    assert_eq!(paths(&hits), vec!["a.md", "node_modules/x.md", "target/t.md"]);
    assert!(!fs.was_read("b.log"));
    assert!(!fs.was_read("sub/c.log"));
    assert!(fs.was_listed("node_modules"), "the default search.exclude is replaced, not merged");
    assert!(fs.was_read("node_modules/x.md"));
    assert!(!fs.was_read(".secret.md"));
    assert!(!fs.was_listed(".hidden"));
}

/// 35. `{"files.exclude": {}}` → `.github/x.md` が検索に入る(`.git` は既定の search.exclude で切れたまま)。
#[tokio::test]
async fn empty_files_exclude_lets_dot_names_into_the_search() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file(".github/x.md", "alpha in github\n");
    fs.file(".secret.md", "alpha secret\n");
    fs.file(".git/HEAD", "alpha ref\n");
    fs.file("a.md", "alpha a\n");

    let scope = scope_with(settings_from(r#"{"files.exclude": {}}"#));
    let hits = run_scope(&fs, &scope, "alpha").await;

    assert_eq!(paths(&hits), vec![".github/x.md", ".secret.md", "a.md"]);
    assert!(fs.was_listed(".github"));
    assert!(fs.was_read(".github/x.md"));
    assert!(!fs.was_listed(".git"), "**/.git stays in the default search.exclude");
}

/// 36. `{"files.exclude": {"docs/drafts/**": true}}` → `docs/drafts` は `list` されない。パターンは root に固定
///     (`other/docs/drafts` は走査される)。
#[tokio::test]
async fn files_exclude_pattern_cuts_a_directory_before_it_is_listed() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("docs/a.md", "alpha doc\n");
    fs.file("docs/drafts/d.md", "alpha draft\n");
    fs.file("docs/drafts/deep/e.md", "alpha deep draft\n");
    fs.file("other/docs/drafts/o.md", "alpha other\n");
    fs.file(".secret.md", "alpha secret\n");

    let scope = scope_with(settings_from(r#"{"files.exclude": {"docs/drafts/**": true}}"#));
    let hits = run_scope(&fs, &scope, "alpha").await;

    assert_eq!(paths(&hits), vec![".secret.md", "docs/a.md", "other/docs/drafts/o.md"]);
    assert!(!fs.was_listed("docs/drafts"), "docs/drafts must be cut before listing");
    assert!(!fs.was_read("docs/drafts/d.md"));
    assert!(fs.was_listed("other/docs/drafts"), "the pattern is anchored at the root");
    assert!(fs.was_read(".secret.md"), "the written files.exclude replaces **/.*");
}

/// 37. `.vellis-tmp` で終わる名前はどの設定でも読まれない(両方の辞書が空でも)。
#[tokio::test]
async fn vellis_tmp_files_are_never_read_whatever_the_settings() {
    let none = Settings { files_exclude: ExcludeMap::new(), search_exclude: ExcludeMap::new() };
    for settings in [Settings::default(), settings_from(r#"{"files.exclude": {}, "search.exclude": {}}"#), none] {
        let mut fs = MockFs::new(FILE_ROOT);
        fs.file(".x.md.vellis-tmp", "alpha tmp\n");
        fs.file("docs/.y.md.vellis-tmp", "alpha nested tmp\n");
        fs.file("plain.vellis-tmp", "alpha plain tmp\n");
        fs.file("x.md", "alpha real\n");

        let hits = run_scope(&fs, &scope_with(settings), "alpha").await;

        assert_eq!(paths(&hits), vec!["x.md"]);
        assert!(!fs.was_read(".x.md.vellis-tmp"));
        assert!(!fs.was_read("docs/.y.md.vellis-tmp"));
        assert!(!fs.was_read("plain.vellis-tmp"));
    }
}

/// 38. 3 引数の `search_in_folder_with(provider, root, query)` は既定の scope と同じ結果
///     (`acceptance_req55.rs` が無改変で緑=既定の設定で動く)。ssh のモックでも同じ。
#[tokio::test]
async fn three_argument_search_equals_the_default_scope() {
    for root in [FILE_ROOT, SSH_ROOT] {
        let mut fs = MockFs::new(root);
        populate_ac55_2_tree(&mut fs);
        let plain = run_default(&fs, "alpha").await;
        assert_ac55_2_scan(&fs, &plain);

        let mut fs2 = MockFs::new(root);
        populate_ac55_2_tree(&mut fs2);
        let scoped = run_scope(&fs2, &SearchScope::default(), "alpha").await;

        assert_eq!(plain, scoped, "root {root}");
        assert_eq!(fs.list_calls(), fs2.list_calls(), "same directories listed under {root}");
        assert_eq!(fs.read_calls(), fs2.read_calls(), "same files read under {root}");
    }
}

// ---------------------------------------------------------------------------
// AC-65-14 — 検索パネルの欄= Rust(契約13)
// ---------------------------------------------------------------------------

/// include / exclude の判定に使う木。
fn populate_filter_tree(fs: &mut MockFs) {
    fs.file("readme.md", "alpha readme\n");
    fs.file("notes.txt", "alpha notes\n");
    fs.file("b.log", "alpha log\n");
    fs.file("docs/a.md", "alpha doc\n");
    fs.file("docs/sub/b.md", "alpha sub doc\n");
    fs.file("docs/c.log", "alpha doc log\n");
    fs.file("other/z.md", "alpha other\n");
    fs.file("node_modules/x.md", "alpha in node_modules\n");
    fs.file("target/t.md", "alpha in target\n");
    fs.file(".git/x", "alpha in git\n");
    fs.file(".github/x.md", "alpha in github\n");
    fs.file(".x.md.vellis-tmp", "alpha tmp\n");
}

/// 39. 全部空・歯車 ON → 既定の走査と同じ結果(`SearchFilter::default()` の値も固定)。
#[tokio::test]
async fn empty_fields_with_the_gear_on_equal_the_default_scan() {
    let default_filter = SearchFilter::default();
    assert_eq!(default_filter, filter(&[], &[], true));

    let mut plain = MockFs::new(FILE_ROOT);
    populate_filter_tree(&mut plain);
    let expected = run_default(&plain, "alpha").await;
    assert_eq!(paths(&expected), vec!["b.log", "docs/a.md", "docs/c.log", "docs/sub/b.md", "notes.txt", "other/z.md", "readme.md"]);

    let mut fs = MockFs::new(FILE_ROOT);
    populate_filter_tree(&mut fs);
    let hits = run_scope(&fs, &scope_filtered(filter(&[], &[], true)), "alpha").await;

    assert_eq!(hits, expected);
    assert_eq!(fs.list_calls(), plain.list_calls());
    assert_eq!(fs.read_calls(), plain.read_calls());
}

/// 40. `include=["docs/**"]` → `docs/a.md`(と配下)は当たり、`readme.md` は読まれない。
///     ディレクトリは include で切らない(`docs` も `other` も降りる)。
#[tokio::test]
async fn include_keeps_only_matching_files_but_still_descends_directories() {
    let mut fs = MockFs::new(FILE_ROOT);
    populate_filter_tree(&mut fs);

    let hits = run_scope(&fs, &scope_filtered(filter(&["docs/**"], &[], true)), "alpha").await;

    assert_eq!(paths(&hits), vec!["docs/a.md", "docs/c.log", "docs/sub/b.md"]);
    assert!(fs.was_listed("docs"));
    assert!(fs.was_listed("docs/sub"));
    assert!(fs.was_listed("other"), "include never cuts a directory (a match may sit below)");
    assert!(!fs.was_read("readme.md"));
    assert!(!fs.was_read("notes.txt"));
    assert!(!fs.was_read("other/z.md"));
    assert!(!fs.was_listed("node_modules"), "search.exclude still applies");
}

/// 41. `include=["*.md"]` → root 直下の `.md` だけ(`docs/a.md` は読まれない=`*` は `/` をまたがない)。
///     複数書けばどれかに当たればよい。フォルダ名(`docs`)を書けばその配下全部。
#[tokio::test]
async fn include_single_star_stays_at_the_root_level_and_a_folder_covers_its_contents() {
    let mut fs = MockFs::new(FILE_ROOT);
    populate_filter_tree(&mut fs);
    let hits = run_scope(&fs, &scope_filtered(filter(&["*.md"], &[], true)), "alpha").await;
    assert_eq!(paths(&hits), vec!["readme.md"]);
    assert!(!fs.was_read("docs/a.md"));
    assert!(!fs.was_read("notes.txt"));

    let mut fs = MockFs::new(FILE_ROOT);
    populate_filter_tree(&mut fs);
    let hits = run_scope(&fs, &scope_filtered(filter(&["*.md", "*.txt"], &[], true)), "alpha").await;
    assert_eq!(paths(&hits), vec!["notes.txt", "readme.md"]);

    let mut fs = MockFs::new(FILE_ROOT);
    populate_filter_tree(&mut fs);
    let hits = run_scope(&fs, &scope_filtered(filter(&["docs"], &[], true)), "alpha").await;
    assert_eq!(paths(&hits), vec!["docs/a.md", "docs/c.log", "docs/sub/b.md"]);
    assert!(!fs.was_read("readme.md"));
}

/// 42. `exclude=["**/*.log"]` → `.log` は読まれない・`node_modules` は既定どおり読まれない(上乗せ)。
#[tokio::test]
async fn exclude_field_adds_to_the_settings_exclusions() {
    let mut fs = MockFs::new(FILE_ROOT);
    populate_filter_tree(&mut fs);

    let hits = run_scope(&fs, &scope_filtered(filter(&[], &["**/*.log"], true)), "alpha").await;

    assert_eq!(paths(&hits), vec!["docs/a.md", "docs/sub/b.md", "notes.txt", "other/z.md", "readme.md"]);
    assert!(!fs.was_read("b.log"));
    assert!(!fs.was_read("docs/c.log"));
    assert!(!fs.was_listed("node_modules"));
    assert!(!fs.was_listed("target"));
    assert!(!fs.was_listed(".git"));

    // A folder pattern in the field cuts the folder before listing.
    let mut fs = MockFs::new(FILE_ROOT);
    populate_filter_tree(&mut fs);
    let hits = run_scope(&fs, &scope_filtered(filter(&[], &["docs/sub"], true)), "alpha").await;
    assert_eq!(paths(&hits), vec!["b.log", "docs/a.md", "docs/c.log", "notes.txt", "other/z.md", "readme.md"]);
    assert!(!fs.was_listed("docs/sub"));
}

/// 43. `use_exclude_settings=false` → `node_modules/x.md`・`target/t.md` が読まれる。
///     `.git/x`・`.github`・`.x.md.vellis-tmp` は読まれない(`files.exclude` と組み込みは効く)。
#[tokio::test]
async fn gear_off_drops_search_exclude_but_keeps_files_exclude_and_the_builtin() {
    let mut fs = MockFs::new(FILE_ROOT);
    populate_filter_tree(&mut fs);

    let hits = run_scope(&fs, &scope_filtered(filter(&[], &[], false)), "alpha").await;

    assert_eq!(
        paths(&hits),
        vec!["b.log", "docs/a.md", "docs/c.log", "docs/sub/b.md", "node_modules/x.md", "notes.txt", "other/z.md", "readme.md", "target/t.md"]
    );
    assert!(fs.was_listed("node_modules"));
    assert!(fs.was_read("node_modules/x.md"));
    assert!(fs.was_read("target/t.md"));
    assert!(!fs.was_listed(".git"), "**/.git is in files.exclude too");
    assert!(!fs.was_listed(".github"), "**/.* is files.exclude");
    assert!(!fs.was_read(".x.md.vellis-tmp"), "the builtin exclusion ignores the gear");

    // The field's exclude still applies with the gear off.
    let mut fs = MockFs::new(FILE_ROOT);
    populate_filter_tree(&mut fs);
    let hits = run_scope(&fs, &scope_filtered(filter(&[], &["**/node_modules"], false)), "alpha").await;
    assert!(!fs.was_listed("node_modules"));
    assert!(fs.was_read("target/t.md"));
    assert!(!paths(&hits).iter().any(|p| p.starts_with("node_modules/")));
}

/// 44. 欄の exclude に `files.exclude` の解除を書いても解除できない(`.github/x.md` は出ない)。
///     否定(`!`)は記法として持たないので、その文字のまま照合される。
#[tokio::test]
async fn exclude_field_cannot_undo_files_exclude() {
    for undo in [&["!**/.*"][..], &["!**/.github"][..], &["**/.*: false"][..]] {
        let mut fs = MockFs::new(FILE_ROOT);
        populate_filter_tree(&mut fs);

        let hits = run_scope(&fs, &scope_filtered(filter(&[], undo, true)), "alpha").await;

        assert!(!fs.was_listed(".github"), "{undo:?} must not un-hide .github");
        assert!(!paths(&hits).iter().any(|p| p.starts_with('.')), "{undo:?}: {:?}", paths(&hits));
        assert!(fs.was_read("readme.md"), "{undo:?} must not break the rest of the scan");
    }

    // The gear cannot un-hide files.exclude either (AC-65-14 with use_exclude_settings=false above),
    // and a `false` in the settings is the only way (契約4) — checked here through the scope.
    let mut fs = MockFs::new(FILE_ROOT);
    populate_filter_tree(&mut fs);
    let unhidden = SearchScope::new(settings_from(r#"{"files.exclude": {"**/.*": false, "**/.git": true}}"#), filter(&[], &[], true));
    let hits = run_scope(&fs, &unhidden, "alpha").await;
    assert!(fs.was_read(".github/x.md"));
    assert!(!fs.was_listed(".git"));
    assert!(paths(&hits).contains(&".github/x.md".to_string()));
}

/// 45. 空要素・空白だけの要素は無視して panic しない(include が空要素だけなら「全部が対象」)。
#[tokio::test]
async fn blank_elements_are_ignored_without_panicking() {
    let mut fs = MockFs::new(FILE_ROOT);
    populate_filter_tree(&mut fs);
    let expected = run_default(&fs, "alpha").await;

    let mut fs = MockFs::new(FILE_ROOT);
    populate_filter_tree(&mut fs);
    let hits = run_scope(&fs, &scope_filtered(filter(&["", "  ", "\t"], &["", " "], true)), "alpha").await;
    assert_eq!(hits, expected, "blank-only fields behave like empty fields");

    let mut fs = MockFs::new(FILE_ROOT);
    populate_filter_tree(&mut fs);
    let hits = run_scope(&fs, &scope_filtered(filter(&["", " docs/** ", ""], &[" ", "**/*.log"], true)), "alpha").await;
    assert_eq!(paths(&hits), vec!["docs/a.md", "docs/sub/b.md"], "non-blank elements are trimmed and applied");
}

/// 46. ssh の root でも欄の判定は同じ(判定は Rust の 1 か所)。
#[tokio::test]
async fn filter_fields_apply_the_same_under_an_ssh_root() {
    let mut fs = MockFs::new(SSH_ROOT);
    populate_filter_tree(&mut fs);

    let hits = run_scope(&fs, &scope_filtered(filter(&["docs/**"], &["**/*.log"], false)), "alpha").await;

    assert_eq!(paths(&hits), vec!["docs/a.md", "docs/sub/b.md"]);
    assert!(fs.was_listed("node_modules"), "gear off under ssh too");
    assert!(!fs.was_read("docs/c.log"));
    assert!(!fs.was_listed(".github"));
}

// ---------------------------------------------------------------------------
// AC-65-10 — 適用の配線(契約9)= ソース走査
// ---------------------------------------------------------------------------

/// 47. ツリーの一覧を返す 5 経路が `provider.list` の結果を `filter_tree_entries` に通す。
#[test]
fn tree_listing_routes_pass_provider_list_through_the_exclude_filter() {
    let sources: [(&str, &str); 5] = [
        ("commands/list.rs", include_str!("../src/commands/list.rs")),
        ("commands/root.rs", include_str!("../src/commands/root.rs")),
        ("commands/app.rs", include_str!("../src/commands/app.rs")),
        ("ipc/handler.rs", include_str!("../src/ipc/handler.rs")),
        ("watch/hub.rs", include_str!("../src/watch/hub.rs")),
    ];
    for (name, raw) in sources {
        let code = strip_line_comments(raw);
        assert!(code.contains(".list("), "{name} must still call provider.list");
        let calls = code.matches("filter_tree_entries(").count() + code.matches("filter_tree_entries_with(").count();
        assert!(calls >= 1, "{name} must pass the listing through exclude::filter_tree_entries (契約9)");
        let first_list = code.find(".list(").unwrap();
        let last_filter = code
            .rfind("filter_tree_entries")
            .expect("filter call found above");
        assert!(last_filter > first_list, "{name}: the filter is applied to the listing, i.e. after provider.list");
    }
}

/// 48. `search_in_folder` command が設定を読み(`load_settings`)、欄の 3 引数を受けて検索に渡している。
///     命令の字面は固定しない(`SearchScope` か `SearchFilter` が本体に現れ、`search_in_folder_streaming(` を呼び続ける)。
#[test]
fn search_command_reads_the_settings_and_hands_the_fields_to_the_scan() {
    let code = search_command_code();
    let body = fn_body(&code, "search_in_folder");
    let signature_end = body.find('{').expect("fn has a body");
    let signature: String = body[..signature_end].split_whitespace().collect();
    for param in ["include:Vec<String>", "exclude:Vec<String>", "use_exclude_settings:bool"] {
        assert!(signature.contains(param), "search_in_folder must take `{param}` (契約13): {signature}");
    }
    assert!(body.contains("load_settings("), "search_in_folder must read the settings (契約7: 読むのは使うとき)");
    assert!(
        body.contains("SearchScope") || body.contains("SearchFilter"),
        "search_in_folder must build the scan's scope from the settings and the fields"
    );
    assert!(body.contains("search_in_folder_streaming("), "the command keeps streaming (要件#55 追補d)");
    for used in ["include", "exclude", "use_exclude_settings"] {
        assert!(
            body[signature_end..].contains(used),
            "the `{used}` argument must be used in the body, not just declared"
        );
    }
}

/// 49. `fs/local.rs` と `fs/ssh.rs` の `list` に `starts_with('.')` による隠し名スキップが無い(契約2)。
#[test]
fn provider_list_no_longer_skips_dot_names() {
    for (name, raw) in [
        ("fs/local.rs", include_str!("../src/fs/local.rs")),
        ("fs/ssh.rs", include_str!("../src/fs/ssh.rs")),
    ] {
        let code = strip_line_comments(raw);
        let body = fn_body(&code, "list");
        assert!(
            !body.contains("starts_with('.')") && !body.contains("starts_with(\".\")"),
            "{name}: `list` must not skip dot names any more (hiding is the exclude judgement): {body}"
        );
    }
}

// ---------------------------------------------------------------------------
// AC-65-11 — メニュー(契約6)
// ---------------------------------------------------------------------------

/// 50. 定数の値固定と parse 妥当性: ID は `settings`、アクセラレータは Command + ,(`,` でも `Comma` でも)。
#[test]
fn settings_menu_constants_are_fixed_and_the_accelerator_is_command_comma() {
    assert_eq!(SETTINGS_ITEM_ID, "settings");
    assert!(
        SETTINGS_ACCELERATOR == "CmdOrCtrl+," || SETTINGS_ACCELERATOR == "CmdOrCtrl+Comma",
        "SETTINGS_ACCELERATOR must be CmdOrCtrl+, (got {SETTINGS_ACCELERATOR})"
    );
    let parsed = Accelerator::from_str(SETTINGS_ACCELERATOR)
        .unwrap_or_else(|e| panic!("accelerator '{SETTINGS_ACCELERATOR}' must parse: {e}"));
    assert_eq!(parsed.key(), Code::Comma);
    assert_eq!(parsed, Accelerator::from_str("CmdOrCtrl+Comma").unwrap());
}

/// 51. 既存のアクセラレータと衝突せず、menu.rs にちょうど 1 回登録される。
#[test]
fn settings_accelerator_is_registered_once_and_unique() {
    let parsed: Vec<(String, Accelerator)> = menu_rs_string_literals()
        .into_iter()
        .filter(|s| s.contains('+'))
        .filter_map(|s| Accelerator::from_str(&s).ok().map(|a| (s, a)))
        .collect();
    let target = Accelerator::from_str(SETTINGS_ACCELERATOR).unwrap();
    let count = parsed.iter().filter(|(_, a)| *a == target).count();
    assert_eq!(count, 1, "menu.rs must register {SETTINGS_ACCELERATOR} exactly once");
    for (i, (raw_a, acc_a)) in parsed.iter().enumerate() {
        for (raw_b, acc_b) in parsed.iter().skip(i + 1) {
            assert!(acc_a != acc_b, "duplicate accelerator: '{raw_a}' vs '{raw_b}'");
        }
    }
    let code = menu_rs_code();
    for name in ["SETTINGS_ITEM_ID", "SETTINGS_ACCELERATOR"] {
        assert!(code.matches(name).count() >= 2, "menu.rs must declare AND use {name}");
    }
}

/// 52. ラベル `Settings…` の項目が App メニュー(最初の Submenu=`Vellis`)にあり、About の後・Quit の前。
///     File メニューには無い。
#[test]
fn app_menu_holds_settings_between_about_and_quit_and_the_file_menu_does_not() {
    let code = menu_rs_code();
    assert!(code.contains("\"Settings…\""), "menu.rs must carry the literal \"Settings…\" (three-dot ellipsis)");

    let first = code.find("Submenu::with_").expect("menu.rs builds submenus");
    let first_call = balanced_call(&code, first);
    assert_eq!(first_string_literal(first_call), Some("Vellis"), "the App menu is the first submenu");

    let app = submenu_call_with_label(&code, "Vellis").expect("menu.rs must build the Vellis submenu");
    let item = item_binding(&code, "SETTINGS_ITEM_ID");
    let idents = slice_idents(app);
    let about_at = idents.iter().position(|s| s == "about").expect("App menu must still hold &about");
    let quit_at = idents.iter().position(|s| s == "quit").expect("App menu must still hold &quit");
    let settings_at = idents
        .iter()
        .position(|s| s == item)
        .unwrap_or_else(|| panic!("App menu must hold &{item} (Settings…): {idents:?}"));
    assert!(about_at < settings_at, "Settings… comes after About Vellis: {idents:?}");
    assert!(settings_at < quit_at, "Settings… comes before Quit: {idents:?}");

    for label in ["File", "Edit", "View", "Go"] {
        if let Some(call) = submenu_call_with_label(&code, label) {
            assert!(!call.contains(&format!("&{item}")), "{label} menu must not hold &{item}");
            assert!(!call.contains("SETTINGS_ITEM_ID"), "{label} menu must not reference SETTINGS_ITEM_ID");
        }
    }
}

/// 53. `lib.rs` の `on_menu_event` がこの ID を扱い、Rust の中で「ファイルを用意して窓を開く」
///     (`ensure_settings_file` が宣言以外で呼ばれる=menu.rs / lib.rs / settings.rs / commands/window.rs のどこか)。
#[test]
fn lib_rs_dispatches_the_settings_item_and_rust_prepares_the_file() {
    let lib = lib_rs_code();
    assert!(lib.contains("menu::SETTINGS_ITEM_ID"), "lib.rs must match on menu::SETTINGS_ITEM_ID");

    let combined = format!(
        "{}\n{}\n{}\n{}",
        menu_rs_code(),
        lib,
        settings_rs_code(),
        strip_line_comments(include_str!("../src/commands/window.rs"))
    );
    assert!(
        combined.matches("ensure_settings_file(").count() >= 2,
        "ensure_settings_file must be declared and called on the menu path (契約6)"
    );
    assert!(
        combined.matches("default_settings_path(").count() >= 2,
        "the menu path must resolve the settings file location"
    );
}

// ---------------------------------------------------------------------------
// AC-65-12 — 保存後の読み直し(契約7・8)= Rust 側
// ---------------------------------------------------------------------------

/// 54. `SETTINGS_CHANGED_EVENT == "settings_changed"`。宣言は settings.rs の 1 か所だけ(インラインの綴りは無い)。
#[test]
fn settings_changed_event_name_is_fixed_and_declared_once() {
    assert_eq!(SETTINGS_CHANGED_EVENT, "settings_changed");
    assert!(
        settings_rs_code().contains("pub const SETTINGS_CHANGED_EVENT: &str = \"settings_changed\";"),
        "settings.rs must declare SETTINGS_CHANGED_EVENT"
    );
    for (name, raw) in [
        ("commands/document.rs", include_str!("../src/commands/document.rs")),
        ("menu.rs", include_str!("../src/menu.rs")),
        ("lib.rs", include_str!("../src/lib.rs")),
        ("commands/search.rs", include_str!("../src/commands/search.rs")),
    ] {
        assert!(
            !strip_line_comments(raw).contains("\"settings_changed\""),
            "{name}: the event name must come from settings::SETTINGS_CHANGED_EVENT"
        );
    }
}

/// 55. `save_document` の中に設定ファイルの保存を見分ける呼び出し(`is_settings_file`)があり、
///     `SETTINGS_CHANGED_EVENT` が全窓へ `emit` される。
#[test]
fn save_document_detects_the_settings_file_and_broadcasts_settings_changed() {
    let document = document_rs_code();
    let body = fn_body(&document, "save_document");
    assert!(
        body.contains("is_settings_file("),
        "save_document must tell a settings.json save apart (契約7): {body}"
    );
    let combined = format!("{document}\n{}", settings_rs_code());
    assert!(
        combined.matches("SETTINGS_CHANGED_EVENT").count() >= 2,
        "SETTINGS_CHANGED_EVENT must be declared and used"
    );
    assert!(combined.contains(".emit("), "settings_changed goes to every window (emit, not emit_to)");
    assert!(
        combined.contains("read_settings(") || combined.contains("parse_settings(") || combined.contains("load_settings("),
        "the saved file is validated (契約8: warnings once on save)"
    );
}
