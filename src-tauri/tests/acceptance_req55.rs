//! 要件#55 の受け入れテスト(docs/requirements/req-55.md)— Rust 層
//! (AC-55-1〜11・AC-55-17・AC-55-18)
//!
//! 「開いている root フォルダの配下を串刺しで検索する」。走査は Rust 側の Tauri command
//! `search_in_folder` が `FileProvider` 経由で行う(契約②〜⑤)。本ファイルは **メモリ上の
//! モック `FileProvider`** に対して走査の関数本体を回し、local / ssh の実体に依存せず
//! 結果の内容と順序・読まれたファイル・呼ばれた/呼ばれなかったメソッドを判定する。
//!
//! 判定範囲(AC 番号は req-55.md の受け入れ基準):
//! - AC-55-1  再帰走査(入れ子まで降りる)
//! - AC-55-2  既定の除外(`EXCLUDED_DIR_NAMES` の値固定・`.` 始まり・除外先は `list` すら
//!   呼ばれない)
//! - AC-55-3  シンボリックリンクを辿らない(自己ループ・root 外へのリンク)
//! - AC-55-4  種別の選別(`src/lib/file-type.ts` と同じ拡張子集合=ソースから抽出して突合)
//! - AC-55-5  サイズ上限を設けない(10 MiB 超も読まれる)
//! - AC-55-6  NUL 含みは除外・非 UTF-8 は静かに飛ばす(Err にしない)
//! - AC-55-7  大小無視の部分一致・正規表現なし・1 行 1 件・空文字は走査しない
//! - AC-55-8  行番号 1 始まり・CRLF でもずれない・行テキストは原文一致(`\r` を含まない)
//! - AC-55-9  打ち切らない(5,000 件超も全件・戻り値の型に打ち切りフラグが無い)
//! - AC-55-10 決定性(`list` の順序が変わっても出力が同じ・パス順/行番号順)
//! - AC-55-11 ssh のモックでも同じ結果・`write_text` は一度も呼ばれない
//! - AC-55-17 メニュー(定数の値固定・parse・ラベル・Edit の `find_item` 直後・lib.rs の dispatch)
//! - AC-55-18 不変と依存(Cargo.toml のクレート集合・`FileProvider` の fn 集合・command の登録)
//! - AC-55-25 (追補a・2026-09-25)`SearchHit.ordinal` = そのファイルの先頭からの出現の通し番号
//!   (1 始まり・1 行に複数あれば最初の出現の番号・次の行は出現数ぶん進む・ファイルごとに戻る)。
//!   `hit()` の構造体リテラルは要件側更新として `ordinal` を +1(AC-55-9 の 4 フィールド固定)。
//!   段階渡し(`ResultStore` / `PAGE_SIZE` / `search_in_folder_page` の登録)は
//!   `tests/acceptance_req55a.rs`(AC-55-26〜27)
//!
//! 人間ゲート 1〜5 に送った範囲(本ファイルでは判定しない): 数千ファイル規模の応答と
//! 待ち表示・ssh 先で固まらないこと・結果一覧の見た目・結果クリックの跳び・起案時判断の妥当性。
//! Tauri command 本体(`State` / `Window` の解決・世代番号の往復)は reviewer 照合。
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前・公開パス)
//!
//! ```ignore
//! // --- 新規 src-tauri/src/search/mod.rs(lib.rs に `pub mod search;`)---
//! use crate::errors::FsError;
//! use crate::fs::provider::FileProvider;
//! use crate::fs::uri::Uri;
//!
//! /// 名前で判定して再帰の手前で切るディレクトリ名(契約②)。順序は問わない。
//! pub const EXCLUDED_DIR_NAMES: &[&str] =
//!     &[".git", "node_modules", "target", "dist", "build", ".svelte-kit"];
//!
//! /// `src/lib/file-type.ts` で `text` 以外(image / model3d / video / audio / pdf / binary)に
//! /// 分類される拡張子の和集合(小文字)。file-type.ts は「上記に無ければ text」なので、
//! /// テキスト扱いの集合は開集合=Rust 側はこの**非テキスト集合**を鏡にする。
//! pub const NON_TEXT_EXTENSIONS: &[&str] = &[/* file-type.ts の 6 集合の和 */];
//!
//! /// 小文字の拡張子(ドット無し・無ければ "")がテキスト扱いか
//! /// (= markdown / html / text のどれか= `NON_TEXT_EXTENSIONS` に無い)。
//! pub fn is_text_extension(ext: &str) -> bool;
//!
//! /// ファイル名(最後のセグメント)から file-type.ts の `extensionOf` と同じ規則で
//! /// 拡張子を取り(最後の `.` の後ろ・小文字化・`dot <= 0` は ""), `is_text_extension` に通す。
//! pub fn is_text_file_name(name: &str) -> bool;
//!
//! /// 一致 1 件。`path` は root からの相対(`/` 区切り・先頭 `/` 無し)、`line` は 1 始まり、
//! /// `text` は当該行の原文(行末の `\n` / `\r\n` を除く)。フィールドはこの 3 つだけ
//! /// (打ち切りフラグは存在しない=契約④)。
//! #[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
//! pub struct SearchHit { pub path: String, pub line: u32, pub text: String }
//!
//! /// 走査の本体(Tauri command `search_in_folder` はこれを呼ぶ薄い層)。
//! /// 空文字の `query` は `Ok(vec![])` で `list` も `read_bytes` も呼ばない。
//! /// 戻りは (path, line) 昇順(`String` の Ord)。
//! pub async fn search_in_folder_with(
//!     provider: &dyn FileProvider,
//!     root: &Uri,
//!     query: &str,
//! ) -> Result<Vec<SearchHit>, FsError>;
//!
//! // --- src-tauri/src/menu.rs に追加(FIND_* と同じ家風)---
//! pub const FIND_IN_FOLDER_ITEM_ID: &str = "find-in-folder";
//! pub const MENU_FIND_IN_FOLDER_EVENT: &str = "menu_find_in_folder";
//! pub const FIND_IN_FOLDER_ACCELERATOR: &str = "CmdOrCtrl+Shift+F";
//! // ラベル "Find in Folder…"・Edit メニューの項目スライスで `&find_item` の直後
//! // lib.rs: `id if id == menu::FIND_IN_FOLDER_ITEM_ID => handle_menu_open_click(.., MENU_FIND_IN_FOLDER_EVENT)`
//!
//! // --- src-tauri/src/commands/… の Tauri command(登録名 `search_in_folder`。両方の
//! //     generate_handler! ブロックに載せる。並びは `set_tab_title` の後ろ=AC-60-20 の一覧と一致)---
//! // #[tauri::command] async fn search_in_folder(root: String, query: String, generation: u64, ..)
//! //   -> Result<SearchResponse, String>   // SearchResponse { generation: u64, hits: Vec<SearchHit> }
//! ```
//!
//! ## モックが前提にする `Entry` の使い方
//! - `FileProvider::list(dir)` は 1 階層の `Entry` 列(kind = File / Dir / Symlink)。走査は
//!   `Dir` だけ再帰し、`Symlink` は**辿らない**(`list` も `stat` も `read_bytes` も呼ばない)。
//!   隠し名(`.` 始まり)と `EXCLUDED_DIR_NAMES` は `list` の戻りに**含まれていても**名前で切る
//!   (モックは local.rs と違って隠しエントリを返す=契約②「名前で判定」を直接判定する)
//! - `Entry.size` は使っても使わなくてもよい(上限は無い)。`stat` は呼ばれても呼ばれなくてもよい
//! - **注意(implementer / reviewer 向け)**: 実物の `LocalProvider::list` / `stat` はリンクを
//!   辿った先の kind を返す(要件#31)。root 外を指すディレクトリへのリンクは local では `Dir`
//!   に見えるため、`Entry.kind == Symlink` だけでは local の脱出を防げない。モックでは
//!   `Symlink` として表す(本テストの範囲)。local 実機の挙動は reviewer 照合・人間ゲート。

use std::collections::{BTreeSet, HashMap};
use std::str::FromStr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use async_trait::async_trait;
use muda::accelerator::Accelerator;
use tokio::sync::mpsc;

use vellis_lib::errors::FsError;
use vellis_lib::fs::entry::{Entry, FileKind};
use vellis_lib::fs::provider::{FileProvider, WatchEvent, WatchHandle};
use vellis_lib::fs::uri::Uri;
use vellis_lib::menu::{
    FIND_IN_FOLDER_ACCELERATOR, FIND_IN_FOLDER_ITEM_ID, MENU_FIND_IN_FOLDER_EVENT,
};
use vellis_lib::search::{
    is_text_extension, is_text_file_name, search_in_folder_with, SearchHit, EXCLUDED_DIR_NAMES,
    NON_TEXT_EXTENSIONS,
};

// ---------------------------------------------------------------------------
// モック FileProvider(メモリ上の木)
// ---------------------------------------------------------------------------

/// `list` が返す順序。走査順が変わっても出力が同じであること(AC-55-10)の材料。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ListOrder {
    /// local.rs と同じ: ディレクトリ先行・名前順
    Sorted,
    /// 逆順
    Reversed,
    /// 先頭 1 つを末尾へ回した順
    Rotated,
}

struct MockFs {
    scheme: &'static str,
    root: Uri,
    /// ディレクトリの絶対パス → 直下のエントリ
    dirs: HashMap<String, Vec<Entry>>,
    /// ファイルの絶対パス → 中身
    files: HashMap<String, Vec<u8>>,
    /// シンボリックリンクの絶対パス → `stat` が返す(辿った先の)エントリ
    link_targets: HashMap<String, Entry>,
    order: ListOrder,
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
            link_targets: HashMap::new(),
            order: ListOrder::Sorted,
            list_calls: Mutex::new(Vec::new()),
            stat_calls: Mutex::new(Vec::new()),
            read_calls: Mutex::new(Vec::new()),
            write_calls: AtomicUsize::new(0),
        };
        fs.dirs.insert(root.path_str().to_string(), Vec::new());
        fs
    }

    fn with_order(mut self, order: ListOrder) -> Self {
        self.order = order;
        self
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
        let name = std::path::Path::new(abs)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        Entry {
            uri: uri.raw,
            name,
            kind,
            size,
            modified: Some(1_700_000_000_000),
            link: None,
        }
    }

    /// `abs` の親ディレクトリの一覧に `entry` を足す(同名は足さない)。親が無ければ作る。
    fn add_to_parent(&mut self, abs: &str, entry: Entry) {
        let parent = std::path::Path::new(abs)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .expect("entry must have a parent");
        self.ensure_dir_abs(&parent);
        let list = self.dirs.get_mut(&parent).expect("parent listing");
        if !list.iter().any(|e| e.name == entry.name) {
            list.push(entry);
        }
    }

    /// 絶対パスのディレクトリを(祖先ごと)用意する。root の外でもよい(リンク先用)。
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

    /// root 相対のファイルを置く。
    fn file(&mut self, rel: &str, bytes: impl Into<Vec<u8>>) -> &mut Self {
        let abs = self.abs_path(rel);
        self.file_abs(&abs, bytes)
    }

    /// 絶対パスのファイルを置く(root の外=リンク先用)。
    fn file_abs(&mut self, abs: &str, bytes: impl Into<Vec<u8>>) -> &mut Self {
        let bytes = bytes.into();
        let entry = self.make_entry(abs, FileKind::File, Some(bytes.len() as u64));
        self.add_to_parent(abs, entry);
        self.files.insert(abs.to_string(), bytes);
        self
    }

    /// root 相対のシンボリックリンクを置く。`target` は `stat` が返す辿った先
    /// (`None` = 解決できないリンク=自己ループ等。`stat` はリンク自身を Symlink で返す)。
    /// リンク先がディレクトリなら `list(リンク)` はリンク先の一覧を返し、ファイルなら
    /// `read_bytes(リンク)` はリンク先の中身を返す=辿れば結果に混ざる形にしておく。
    fn symlink(&mut self, rel: &str, target_abs: Option<&str>) -> &mut Self {
        let abs = self.abs_path(rel);
        let entry = self.make_entry(&abs, FileKind::Symlink, None);
        self.add_to_parent(&abs, entry);
        if let Some(target) = target_abs {
            if let Some(list) = self.dirs.get(target).cloned() {
                let resolved = self.make_entry(&abs, FileKind::Dir, None);
                self.link_targets.insert(abs.clone(), resolved);
                self.dirs.insert(abs.clone(), list);
            } else if let Some(bytes) = self.files.get(target).cloned() {
                let resolved = self.make_entry(&abs, FileKind::File, Some(bytes.len() as u64));
                self.link_targets.insert(abs.clone(), resolved);
                self.files.insert(abs.clone(), bytes);
            } else {
                panic!("symlink target {target} must be placed first");
            }
        }
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
        entries.sort_by(|a, b| {
            let ad = a.kind == FileKind::Dir;
            let bd = b.kind == FileKind::Dir;
            bd.cmp(&ad).then_with(|| a.name.cmp(&b.name))
        });
        match self.order {
            ListOrder::Sorted => {}
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
        self.stat_calls.lock().unwrap().push(key.clone());
        if let Some(target) = self.link_targets.get(&key) {
            return Ok(target.clone());
        }
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
        self.read_calls.lock().unwrap().push(key.clone());
        self.files
            .get(&key)
            .cloned()
            .ok_or(FsError::NotFound(key))
    }

    /// 契約⑤: 検索は書き込み系に一切触れない。呼ばれた回数を数えて 0 を固定する。
    async fn write_text(&self, uri: &str, _content: &str) -> Result<(), FsError> {
        self.write_calls.fetch_add(1, Ordering::SeqCst);
        Err(FsError::Unsupported(format!(
            "search must never write: {uri}"
        )))
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

async fn run(fs: &MockFs, query: &str) -> Vec<SearchHit> {
    search_in_folder_with(fs, &fs.root, query)
        .await
        .unwrap_or_else(|e| panic!("search_in_folder_with({query:?}) must succeed: {e}"))
}

fn paths(hits: &[SearchHit]) -> Vec<String> {
    hits.iter().map(|h| h.path.clone()).collect()
}

fn hit(path: &str, line: u32, text: &str) -> SearchHit {
    // そのファイルで最初の出現(ordinal = 1)の一致。
    hit_nth(path, line, 1, text)
}

/// `ordinal` を明示する一致(そのファイルの先頭からの出現の通し番号・1 始まり=追補a)。
fn hit_nth(path: &str, line: u32, ordinal: u32, text: &str) -> SearchHit {
    // 構造体リテラルで組む=フィールドが path / line / text / ordinal の 4 つだけであることの
    // コンパイル時の担保(打ち切りフラグ等が増えるとここが通らない=AC-55-9。
    // 要件側更新 2026-09-25 追補a: `ordinal: u32` を +1)。
    SearchHit {
        path: path.to_string(),
        line,
        text: text.to_string(),
        ordinal,
    }
}

/// AC-55-10 / 11 で共有する小さな木(パスの順序が走査順と一致しないように名前を選ぶ)。
fn populate_shared_tree(fs: &mut MockFs) {
    fs.file("zeta.md", "alpha at zeta\nnothing\nALPHA again\n");
    fs.file("docs/beta.txt", "no\nalpha in beta\n");
    fs.file("docs/sub/gamma.md", "alpha in gamma\n");
    fs.file("alpha.md", "first alpha\n");
    fs.file("docs/photo.png", "alpha inside png must not count");
    fs.dir("empty");
}

fn shared_tree_expected() -> Vec<SearchHit> {
    vec![
        hit("alpha.md", 1, "first alpha"),
        hit("docs/beta.txt", 2, "alpha in beta"),
        hit("docs/sub/gamma.md", 1, "alpha in gamma"),
        hit("zeta.md", 1, "alpha at zeta"),
        hit_nth("zeta.md", 3, 2, "ALPHA again"),
    ]
}

// ---------------------------------------------------------------------------
// AC-55-1 — 再帰走査(契約②)
// ---------------------------------------------------------------------------

/// 1. 入れ子の 3 階層目まで降りて一致を拾う(1 階層目で止まらない)。
#[tokio::test]
async fn recurses_into_nested_directories() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("a.md", "alpha\n");
    fs.file("docs/b.md", "alpha\n");
    fs.file("docs/deep/c.txt", "alpha\n");
    fs.file("docs/deep/deeper/d.md", "alpha here\n");

    let hits = run(&fs, "alpha").await;

    assert_eq!(
        paths(&hits),
        vec!["a.md", "docs/b.md", "docs/deep/c.txt", "docs/deep/deeper/d.md"]
    );
    assert!(fs.was_listed("docs/deep/deeper"), "the deepest directory must be listed");
}

/// 2. 空のディレクトリ・一致の無いファイルだけの root は 0 件で Ok。
#[tokio::test]
async fn empty_tree_yields_no_hits_without_error() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.dir("empty");
    fs.file("plain.md", "nothing here\n");

    let hits = run(&fs, "alpha").await;

    assert!(hits.is_empty());
}

// ---------------------------------------------------------------------------
// AC-55-2 — 既定の除外(契約②)
// ---------------------------------------------------------------------------

/// 3. 除外リストの値固定(順序は問わない・6 つちょうど)。
#[test]
fn excluded_dir_names_are_fixed() {
    let actual: BTreeSet<&str> = EXCLUDED_DIR_NAMES.iter().copied().collect();
    let expected: BTreeSet<&str> = [".git", "node_modules", "target", "dist", "build", ".svelte-kit"]
        .into_iter()
        .collect();
    assert_eq!(actual, expected);
    assert_eq!(EXCLUDED_DIR_NAMES.len(), 6, "no duplicates");
}

/// 4. 除外ディレクトリと `.` 始まりの名前は走査されない(`list` すら呼ばれない=再帰の手前で切る)。
///    名前は完全一致で見る(`target.md` というファイルは除外されない)。
#[tokio::test]
async fn excluded_and_hidden_names_are_never_visited() {
    let mut fs = MockFs::new(FILE_ROOT);
    for dir in EXCLUDED_DIR_NAMES {
        fs.file(&format!("{dir}/hit.md"), "alpha inside excluded\n");
        fs.file(&format!("keep/{dir}/hit.md"), "alpha inside nested excluded\n");
    }
    fs.file(".hidden/x.md", "alpha in hidden dir\n");
    fs.file(".secret.md", "alpha in hidden file\n");
    fs.file("keep/.also-hidden.txt", "alpha in nested hidden file\n");
    fs.file("keep/ok.md", "alpha kept\n");
    fs.file("target.md", "alpha in a file merely named like target\n");

    let hits = run(&fs, "alpha").await;

    assert_eq!(paths(&hits), vec!["keep/ok.md", "target.md"]);
    for dir in EXCLUDED_DIR_NAMES {
        assert!(!fs.was_listed(dir), "{dir} must not be listed");
        assert!(!fs.was_listed(&format!("keep/{dir}")), "keep/{dir} must not be listed");
        assert!(!fs.was_read(&format!("{dir}/hit.md")));
    }
    assert!(!fs.was_listed(".hidden"));
    assert!(!fs.was_read(".secret.md"));
    assert!(!fs.was_read("keep/.also-hidden.txt"));
}

// ---------------------------------------------------------------------------
// AC-55-3 — シンボリックリンクを辿らない(契約②)
// ---------------------------------------------------------------------------

/// 5. 自己ループ・root 外のディレクトリ・root 外のファイルへのリンクがあっても走査は終わり、
///    root 外の中身は結果に出ない。リンクは `list` も `read_bytes` もされない。
#[tokio::test]
async fn symlinks_are_not_followed() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("inside.md", "alpha inside\n");
    // root の外に置いた木(リンクを辿ればここへ出てしまう)
    fs.file_abs("/outside/secret.md", "alpha secret\n");
    fs.file_abs("/outside/nested/more.md", "alpha more\n");
    // 自分(root)を指すループ
    let root_path = fs.root.path_str().to_string();
    fs.symlink("loop", Some(&root_path));
    // root 外のディレクトリへ
    fs.symlink("escape", Some("/outside"));
    // root 外のファイルへ
    fs.symlink("alias.md", Some("/outside/secret.md"));
    // 解決できない(壊れた)リンク
    fs.symlink("dangling.md", None);

    let hits = run(&fs, "alpha").await;

    assert_eq!(paths(&hits), vec!["inside.md"]);
    assert!(!fs.was_listed("loop"), "self-loop must not be listed");
    assert!(!fs.was_listed("escape"), "link to outside dir must not be listed");
    assert!(
        !fs.list_calls().iter().any(|p| p.starts_with("/outside")),
        "nothing outside root may be listed: {:?}",
        fs.list_calls()
    );
    assert!(!fs.was_read("alias.md"), "link to outside file must not be read");
    assert!(!fs.was_read("dangling.md"));
    assert!(
        !fs.read_calls().iter().any(|p| p.starts_with("/outside")),
        "nothing outside root may be read: {:?}",
        fs.read_calls()
    );
}

// ---------------------------------------------------------------------------
// AC-55-4 — 種別の選別(契約③)= file-type.ts との突き合わせ
// ---------------------------------------------------------------------------

const FILE_TYPE_TS: &str = include_str!("../../src/lib/file-type.ts");

/// `const NAME = new Set([ ... ])` の中の単一引用符リテラルを集める(行コメントは落とす)。
fn extension_set(name: &str) -> BTreeSet<String> {
    let marker = format!("const {name} = new Set([");
    let start = FILE_TYPE_TS
        .find(&marker)
        .unwrap_or_else(|| panic!("file-type.ts must declare {name}"))
        + marker.len();
    let end = FILE_TYPE_TS[start..]
        .find("])")
        .expect("Set literal must close")
        + start;
    let body: String = FILE_TYPE_TS[start..end]
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    let mut out = BTreeSet::new();
    let mut rest = body.as_str();
    while let Some(a) = rest.find('\'') {
        let after = &rest[a + 1..];
        let b = after.find('\'').expect("unterminated quote");
        out.insert(after[..b].to_string());
        rest = &after[b + 1..];
    }
    assert!(!out.is_empty(), "{name} must not be empty");
    out
}

/// 6. Rust 側の非テキスト集合= file-type.ts の image / model3d / video / audio / pdf / binary の和。
#[test]
fn non_text_extensions_mirror_file_type_ts() {
    let mut expected = BTreeSet::new();
    for name in [
        "IMAGE_EXTENSIONS",
        "MODEL3D_EXTENSIONS",
        "VIDEO_EXTENSIONS",
        "AUDIO_EXTENSIONS",
        "PDF_EXTENSIONS",
        "BINARY_EXTENSIONS",
    ] {
        expected.extend(extension_set(name));
    }
    let actual: BTreeSet<String> = NON_TEXT_EXTENSIONS.iter().map(|s| s.to_string()).collect();
    assert_eq!(actual, expected, "NON_TEXT_EXTENSIONS must equal the union in file-type.ts");
    assert_eq!(NON_TEXT_EXTENSIONS.len(), expected.len(), "no duplicates");
    for ext in NON_TEXT_EXTENSIONS {
        assert_eq!(ext.to_lowercase(), **ext, "extensions are stored lowercase: {ext}");
    }
}

/// 7. markdown / html の集合はテキスト扱い、未知の拡張子・拡張子無しもテキスト扱い
///    (file-type.ts の既定=text)。非テキスト集合は全て偽。大文字の名前も小文字化して判定。
#[test]
fn text_extension_predicate_matches_file_type_ts() {
    let mut text = extension_set("MARKDOWN_EXTENSIONS");
    text.extend(extension_set("HTML_EXTENSIONS"));
    for ext in ["md", "markdown", "mdx", "html", "htm"] {
        assert!(text.contains(ext), "file-type.ts must still classify {ext} as markdown/html");
    }
    for ext in &text {
        assert!(is_text_extension(ext), "{ext} must be text");
    }
    for ext in ["txt", "json", "xhtml", "rs", "xyz", ""] {
        assert!(is_text_extension(ext), "{ext:?} must be text (file-type.ts default)");
    }
    for ext in NON_TEXT_EXTENSIONS {
        assert!(!is_text_extension(ext), "{ext} must not be text");
    }
    assert!(is_text_file_name("README.MD"));
    assert!(is_text_file_name("notes.txt"));
    assert!(is_text_file_name("Makefile"));
    assert!(is_text_file_name("archive.tar.md"));
    assert!(!is_text_file_name("PHOTO.PNG"));
    assert!(!is_text_file_name("paper.pdf"));
    assert!(!is_text_file_name("clip.mp4"));
    assert!(!is_text_file_name("song.mp3"));
    assert!(!is_text_file_name("blob.bin"));
    assert!(!is_text_file_name("model.obj"));
    assert!(!is_text_file_name("archive.md.zip"));
}

/// 8. モック上で: md / txt / html / 未知の拡張子 / 拡張子無しは読まれて一致が出る。
///    png / pdf / mp4 / mp3 / bin / exe / obj / svg は読まれない(`read_bytes` が呼ばれない)。
#[tokio::test]
async fn only_text_kinds_are_read() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("a.md", "alpha\n");
    fs.file("b.txt", "alpha\n");
    fs.file("c.html", "<p>alpha</p>\n");
    fs.file("notes.xyz", "alpha\n");
    fs.file("Makefile", "alpha:\n");
    for name in [
        "p.png", "d.pdf", "v.mp4", "s.mp3", "x.bin", "y.exe", "m.obj", "i.svg", "UP.PNG",
    ] {
        fs.file(name, "alpha would match if read\n");
    }

    let hits = run(&fs, "alpha").await;

    assert_eq!(
        paths(&hits),
        vec!["Makefile", "a.md", "b.txt", "c.html", "notes.xyz"]
    );
    for name in ["a.md", "b.txt", "c.html", "notes.xyz", "Makefile"] {
        assert!(fs.was_read(name), "{name} must be read");
    }
    for name in [
        "p.png", "d.pdf", "v.mp4", "s.mp3", "x.bin", "y.exe", "m.obj", "i.svg", "UP.PNG",
    ] {
        assert!(!fs.was_read(name), "{name} must not be read");
    }
}

// ---------------------------------------------------------------------------
// AC-55-5 — サイズ上限を設けない(契約③)
// ---------------------------------------------------------------------------

/// 9. 10 MiB 超のファイルも読まれ、末尾近くの一致が正しい行番号で出る。後続のファイルも走査される。
#[tokio::test]
async fn files_over_ten_mib_are_read() {
    let filler_lines: usize = 10 * 1024; // 1,024 bytes per line => 10 MiB of filler
    let mut big = String::with_capacity(filler_lines * 1024 + 64);
    let line = format!("{}\n", "x".repeat(1023));
    for _ in 0..filler_lines {
        big.push_str(&line);
    }
    big.push_str("needle at the end\n");
    assert!(big.len() > 10 * 1024 * 1024);

    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("big.txt", big);
    fs.file("zz.md", "needle after big\n");

    let hits = run(&fs, "needle").await;

    assert_eq!(
        hits,
        vec![
            hit("big.txt", (filler_lines + 1) as u32, "needle at the end"),
            hit("zz.md", 1, "needle after big"),
        ]
    );
}

// ---------------------------------------------------------------------------
// AC-55-6 — バイナリ除外・非 UTF-8 は静かに飛ばす(契約③)
// ---------------------------------------------------------------------------

/// 10. `.txt` でも先頭付近に NUL を含むファイルは結果に出ない。非 UTF-8 は Err にならず
///     飛ばされ、他のファイルの一致は普通に返る。
#[tokio::test]
async fn nul_bytes_exclude_and_invalid_utf8_is_skipped() {
    let mut fs = MockFs::new(FILE_ROOT);
    let mut nul = b"alpha ".to_vec();
    nul.push(0);
    nul.extend_from_slice(b" binary payload\nalpha again\n");
    fs.file("nul.txt", nul);
    let mut latin = b"alpha caf".to_vec();
    latin.extend_from_slice(&[0xE9, 0xFF, 0xFE, b'\n']);
    fs.file("latin1.txt", latin);
    fs.file("ok.md", "alpha ok\n");

    let result = search_in_folder_with(&fs, &fs.root, "alpha").await;

    let hits = result.expect("invalid UTF-8 must not turn the whole search into an error");
    assert_eq!(hits, vec![hit("ok.md", 1, "alpha ok")]);
}

// ---------------------------------------------------------------------------
// AC-55-7 — 一致の規則(契約④)
// ---------------------------------------------------------------------------

const RULES_DOC: &str = "Alpha\nabc\naLPHA alpha\nzzz\nalp ha\n";

/// 11. 大文字小文字を区別しない部分一致。1 行に 2 回出ても 1 件。
#[tokio::test]
async fn match_is_case_insensitive_and_one_hit_per_line() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("r.md", RULES_DOC);

    let lower = run(&fs, "alpha").await;
    let upper = run(&fs, "ALPHA").await;
    let mixed = run(&fs, "aLpHa").await;

    let expected = vec![hit("r.md", 1, "Alpha"), hit_nth("r.md", 3, 2, "aLPHA alpha")];
    assert_eq!(lower, expected);
    assert_eq!(upper, expected);
    assert_eq!(mixed, expected);
    let partial = run(&fs, "lph").await;
    assert_eq!(paths(&partial), vec!["r.md", "r.md"], "substring match");
}

/// 12. 正規表現は解釈しない: `a.c` は `abc` に当たらない・`a.c` そのものには当たる。
///     `[` や `(` や `\` で例外にもならない。
#[tokio::test]
async fn query_is_literal_not_regex() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("r.md", RULES_DOC);
    fs.file("dot.md", "literal a.c here\n");

    let hits = run(&fs, "a.c").await;
    assert_eq!(hits, vec![hit("dot.md", 1, "literal a.c here")]);

    for q in ["[", "(", "\\", "a+", "^alpha$", ".*"] {
        let r = search_in_folder_with(&fs, &fs.root, q).await;
        assert!(r.is_ok(), "query {q:?} must not error");
        assert!(r.unwrap().is_empty(), "query {q:?} must match literally (none here)");
    }
}

/// 13. 空文字は 0 件で、走査もしない(`list` も `read_bytes` も呼ばれない)。
#[tokio::test]
async fn empty_query_returns_nothing_without_walking() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("r.md", RULES_DOC);

    let hits = run(&fs, "").await;

    assert!(hits.is_empty());
    assert!(fs.list_calls().is_empty(), "empty query must not list: {:?}", fs.list_calls());
    assert!(fs.read_calls().is_empty(), "empty query must not read: {:?}", fs.read_calls());
}

// ---------------------------------------------------------------------------
// AC-55-8 — 行番号と行テキスト(契約⑥)
// ---------------------------------------------------------------------------

/// 14. 行番号は 1 始まり。CRLF でもずれず、返る行テキストに `\r` が混ざらない。
///     先頭の空白は保つ。最終行に改行が無くても数える。
#[tokio::test]
async fn line_numbers_and_texts_survive_crlf() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("crlf.md", "one\r\nalpha two\r\nthree\r\n  alpha indented\r\nfive\r\nalpha end");
    fs.file("lf.md", "one\nalpha two\nthree\n  alpha indented\nfive\nalpha end");

    let hits = run(&fs, "alpha").await;

    let expected_for = |p: &str| {
        vec![
            hit(p, 2, "alpha two"),
            hit_nth(p, 4, 2, "  alpha indented"),
            hit_nth(p, 6, 3, "alpha end"),
        ]
    };
    let mut expected = expected_for("crlf.md");
    expected.extend(expected_for("lf.md"));
    assert_eq!(hits, expected);
    for h in &hits {
        assert!(!h.text.contains('\r'), "text must not carry CR: {:?}", h.text);
        assert!(!h.text.contains('\n'), "text must be a single line: {:?}", h.text);
    }
}

/// 15. 一致した行の**原文**がそのまま返る(前後の行は付かない・切り詰めない・大文字小文字も原文)。
#[tokio::test]
async fn hit_text_is_the_original_line() {
    let long = format!("{} ALPHA {}", "-".repeat(500), "=".repeat(500));
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("t.md", format!("before\n{long}\nafter\n"));

    let hits = run(&fs, "alpha").await;

    assert_eq!(hits, vec![hit("t.md", 2, &long)]);
}

// ---------------------------------------------------------------------------
// AC-55-9 — 打ち切らない(契約④)
// ---------------------------------------------------------------------------

/// 16. 一致が 5,000 件を超えても全件返る。行番号は連番。戻りは `Vec<SearchHit>` そのもので、
///     打ち切りフラグを載せる場所が無い(`hit()` の構造体リテラルがコンパイルできることが
///     フィールド集合の担保)。
#[tokio::test]
async fn all_hits_are_returned_without_truncation() {
    let lines: usize = 6_000;
    let mut many = String::new();
    for i in 1..=lines {
        many.push_str(&format!("alpha line {i}\n"));
    }
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("many.txt", many);
    fs.file("one.md", "alpha one\n");
    fs.file("two.md", "alpha two\n");

    let hits: Vec<SearchHit> = run(&fs, "alpha").await;

    assert_eq!(hits.len(), lines + 2);
    let many_hits: Vec<&SearchHit> = hits.iter().filter(|h| h.path == "many.txt").collect();
    assert_eq!(many_hits.len(), lines);
    for (i, h) in many_hits.iter().enumerate() {
        assert_eq!(h.line as usize, i + 1);
        assert_eq!(h.text, format!("alpha line {}", i + 1));
    }
}

// ---------------------------------------------------------------------------
// AC-55-10 — 決定性(契約④)
// ---------------------------------------------------------------------------

/// 17. `list` の返す順序(名前順・逆順・回転)を変えても出力は同じで、パス順・行番号順。
#[tokio::test]
async fn output_is_sorted_and_independent_of_listing_order() {
    let mut outputs = Vec::new();
    for order in [ListOrder::Sorted, ListOrder::Reversed, ListOrder::Rotated] {
        let mut fs = MockFs::new(FILE_ROOT).with_order(order);
        populate_shared_tree(&mut fs);
        outputs.push((order, run(&fs, "alpha").await));
    }
    for (order, hits) in &outputs {
        assert_eq!(*hits, shared_tree_expected(), "listing order {order:?}");
        let keys: Vec<(&str, u32)> = hits.iter().map(|h| (h.path.as_str(), h.line)).collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted, "hits must be ordered by (path, line) for {order:?}");
    }
}

// ---------------------------------------------------------------------------
// AC-55-11 — ssh でも動く・書き込み系は呼ばれない(契約⑤)
// ---------------------------------------------------------------------------

/// 18. scheme=ssh のモック(authority 付き root)でも同じ走査が回り、同じ結果(root 相対の
///     パス)が返る。`write_text` は file / ssh どちらでも一度も呼ばれない。
#[tokio::test]
async fn ssh_provider_yields_the_same_hits_and_never_writes() {
    let mut local = MockFs::new(FILE_ROOT);
    populate_shared_tree(&mut local);
    let mut ssh = MockFs::new(SSH_ROOT);
    populate_shared_tree(&mut ssh);
    assert_eq!(ssh.scheme(), "ssh");
    assert!(ssh.root.authority.is_some());

    let local_hits = run(&local, "alpha").await;
    let ssh_hits = run(&ssh, "alpha").await;

    assert_eq!(ssh_hits, shared_tree_expected());
    assert_eq!(ssh_hits, local_hits);
    assert_eq!(local.write_calls(), 0, "write_text must never be called (file)");
    assert_eq!(ssh.write_calls(), 0, "write_text must never be called (ssh)");
    // ssh でも走査は root の配下に閉じる(authority を落とした別の木を見ない)
    assert!(ssh.list_calls().iter().all(|p| p.starts_with("/data")), "{:?}", ssh.list_calls());
    assert!(ssh.read_calls().iter().all(|p| p.starts_with("/data")), "{:?}", ssh.read_calls());
}

// ---------------------------------------------------------------------------
// AC-55-17 — メニュー(契約①)。acceptance_req54 / req60 / req62a の家風
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

fn menu_rs_code() -> String {
    strip_line_comments(include_str!("../src/menu.rs"))
}

fn lib_rs_code() -> String {
    strip_line_comments(include_str!("../src/lib.rs"))
}

/// 19. 定数の値固定(項目 ID・イベント名・アクセラレータ)。
#[test]
fn find_in_folder_constants_are_fixed() {
    assert_eq!(FIND_IN_FOLDER_ITEM_ID, "find-in-folder");
    assert_eq!(MENU_FIND_IN_FOLDER_EVENT, "menu_find_in_folder");
    assert_eq!(FIND_IN_FOLDER_ACCELERATOR, "CmdOrCtrl+Shift+F");
}

/// 20. parse 妥当性(acceptance_req36 の家風): tauri は parse に失敗した accelerator を
///     黙って捨てるので、Ok であることが「登録される」ことの判定点。
#[test]
fn find_in_folder_accelerator_parses_as_tauri_accelerator() {
    assert!(
        Accelerator::from_str(FIND_IN_FOLDER_ACCELERATOR).is_ok(),
        "accelerator '{}' must parse",
        FIND_IN_FOLDER_ACCELERATOR
    );
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

/// 21. 既存のアクセラレータと衝突せず、menu.rs にちょうど 1 回登録される。
#[test]
fn find_in_folder_accelerator_is_registered_once_and_unique() {
    let parsed: Vec<(String, Accelerator)> = menu_rs_string_literals()
        .into_iter()
        .filter(|s| s.contains('+'))
        .filter_map(|s| Accelerator::from_str(&s).ok().map(|a| (s, a)))
        .collect();
    let target = Accelerator::from_str(FIND_IN_FOLDER_ACCELERATOR).unwrap();
    let count = parsed.iter().filter(|(_, a)| *a == target).count();
    assert_eq!(count, 1, "menu.rs must register {FIND_IN_FOLDER_ACCELERATOR} exactly once");
    for (i, (raw_a, acc_a)) in parsed.iter().enumerate() {
        for (raw_b, acc_b) in parsed.iter().skip(i + 1) {
            assert!(acc_a != acc_b, "duplicate accelerator: '{raw_a}' vs '{raw_b}'");
        }
    }
}

/// 22. 英語ラベル「Find in Folder…」(三点リーダ付き)がコード行の文字列リテラルにある。
#[test]
fn menu_rs_declares_english_find_in_folder_label() {
    assert!(
        menu_rs_code().contains("\"Find in Folder…\""),
        "menu.rs must carry the literal \"Find in Folder…\""
    );
}

/// 23. 項目 ID とアクセラレータの定数が宣言+使用で 2 回以上現れる(インラインリテラルにしない)。
#[test]
fn menu_rs_uses_find_in_folder_constants() {
    let code = menu_rs_code();
    for name in ["FIND_IN_FOLDER_ITEM_ID", "FIND_IN_FOLDER_ACCELERATOR"] {
        let count = code.matches(name).count();
        assert!(count >= 2, "menu.rs must declare AND use {name} (found {count})");
    }
}

/// 24. イベント定数が宣言(menu.rs)以外に dispatch(lib.rs の match)で使われ、項目 ID も
///     lib.rs で照合される(宣言 + with_id + dispatch = 3 回以上)。
#[test]
fn find_in_folder_event_and_id_are_dispatched_in_lib_rs() {
    let combined = format!("{}\n{}", menu_rs_code(), lib_rs_code());
    let events = combined.matches("MENU_FIND_IN_FOLDER_EVENT").count();
    assert!(events >= 2, "MENU_FIND_IN_FOLDER_EVENT must be declared and dispatched (found {events})");
    let ids = combined.matches("FIND_IN_FOLDER_ITEM_ID").count();
    assert!(ids >= 3, "FIND_IN_FOLDER_ITEM_ID must be declared, bound and matched (found {ids})");
    assert!(
        lib_rs_code().contains("menu::FIND_IN_FOLDER_ITEM_ID"),
        "lib.rs must match on menu::FIND_IN_FOLDER_ITEM_ID"
    );
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

/// `FIND_IN_FOLDER_ITEM_ID` で束ねられた MenuItem の束縛名(`let xxx = MenuItem::with_id(app, FIND_IN_FOLDER_ITEM_ID, …)`)。
fn find_in_folder_item_binding(code: &str) -> &str {
    let use_pos = code
        .rfind("FIND_IN_FOLDER_ITEM_ID")
        .expect("menu.rs must use FIND_IN_FOLDER_ITEM_ID");
    let let_pos = code[..use_pos]
        .rfind("let ")
        .expect("FIND_IN_FOLDER_ITEM_ID must be used inside a let binding");
    code[let_pos + 4..use_pos]
        .split(|c: char| c == '=' || c.is_whitespace())
        .find(|s| !s.is_empty())
        .expect("binding name after `let`")
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

/// 25. Edit メニューの項目列で「Find in Folder…」が `find_item`(⌘F)の直後に並ぶ。
#[test]
fn edit_menu_holds_find_in_folder_right_after_find() {
    let code = menu_rs_code();
    let edit = submenu_call_with_label(&code, "Edit").expect("menu.rs must build the Edit submenu");
    let item = find_in_folder_item_binding(&code);
    let idents = slice_idents(edit);
    let find_at = idents
        .iter()
        .position(|s| s == "find_item")
        .expect("Edit menu must still hold &find_item (要件#54)");
    assert_eq!(
        idents.get(find_at + 1).map(String::as_str),
        Some(item),
        "Find in Folder… (`&{item}`) must directly follow &find_item in the Edit menu: {idents:?}"
    );
    // File / View / Go / Window には出さない(同じ項目を 2 箇所に出さない)
    for label in ["File", "View", "Go"] {
        if let Some(call) = submenu_call_with_label(&code, label) {
            assert!(!call.contains(&format!("&{item}")), "{label} menu must not hold &{item}");
        }
    }
}

// ---------------------------------------------------------------------------
// AC-55-18 — 不変と依存(契約⑧)。Cargo.toml のクレート集合・FileProvider の fn 集合・command 登録
// ---------------------------------------------------------------------------

const CARGO_TOML: &str = include_str!("../Cargo.toml");

/// `[header]` 節の `name = …` のキー集合(次の `[` で始まる行まで)。
fn cargo_section_keys(header: &str) -> BTreeSet<String> {
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
    body[..end]
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

/// 26. `[dependencies]` のクレート集合が周回開始時点(2026-09-24)と同一(追加ゼロ)。
#[test]
fn cargo_dependencies_are_unchanged() {
    assert_eq!(
        cargo_section_keys("[dependencies]"),
        set(&[
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
        ])
    );
}

/// 27. macOS target 節と `[dev-dependencies]` / `[build-dependencies]` も同一。
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

/// 28. `FileProvider` トレイトの fn 名の集合が現状と同一(書き込み系が増えていない)。
#[test]
fn file_provider_trait_methods_are_unchanged() {
    let src = strip_line_comments(include_str!("../src/fs/provider.rs"));
    let start = src.find("pub trait FileProvider").expect("provider.rs must declare FileProvider");
    let body_open = src[start..].find('{').unwrap() + start;
    let mut depth = 0usize;
    let mut body_end = src.len();
    for (i, c) in src[body_open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    body_end = body_open + i;
                    break;
                }
            }
            _ => {}
        }
    }
    let body = &src[body_open..body_end];
    let mut names = BTreeSet::new();
    let mut rest = body;
    while let Some(at) = rest.find("fn ") {
        let after = &rest[at + 3..];
        let name: String = after
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        if !name.is_empty() {
            names.insert(name);
        }
        rest = after;
    }
    assert_eq!(
        names,
        set(&["scheme", "list", "stat", "read_bytes", "read_range", "read_text", "write_text", "watch"])
    );
}

/// 29. 契約⑤: `search_in_folder` が両方の `generate_handler!` ブロックに登録される
///     (並びは AC-60-20 側=`src/lib/go-to-path.acceptance.test.ts` が固定する)。
#[test]
fn search_in_folder_command_is_registered_in_both_handler_lists() {
    let code = lib_rs_code();
    let blocks: Vec<&str> = code
        .match_indices("generate_handler![")
        .map(|(i, _)| {
            let start = i + "generate_handler![".len();
            let end = code[start..].find(']').expect("handler list must close") + start;
            &code[start..end]
        })
        .collect();
    assert_eq!(blocks.len(), 2, "lib.rs has the webdriver and the production handler lists");
    for block in blocks {
        let names: Vec<&str> = block
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.rsplit("::").next().unwrap())
            .collect();
        assert!(
            names.contains(&"search_in_folder"),
            "generate_handler! must register search_in_folder: {names:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// 要件#55 追補a(2026-09-25)— AC-55-25 `SearchHit.ordinal`
//
// 契約: `ordinal: u32` = そのファイルの先頭からの語の出現の通し番号(1 始まり)。
// 1 行に複数あれば**最初の出現の番号**で、次の一致行の ordinal はその行の出現数ぶん進む
// (要件#54 の `findMatches` と同じ数え方=大小無視・重ならない出現)。ファイルが変われば
// 1 に戻る。フロントは `ordinal - 1` を要件#54 の番目(0 始まり)に使う。
// ---------------------------------------------------------------------------

/// 30. 1 行 1 回なら ordinal は行の並び順の連番(1, 2, 3)。
#[tokio::test]
async fn ordinal_counts_occurrences_from_the_top_of_the_file() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("o.md", "alpha one\nnone\nalpha two\nnone\nalpha three\n");

    let hits = run(&fs, "alpha").await;

    assert_eq!(
        hits,
        vec![
            hit_nth("o.md", 1, 1, "alpha one"),
            hit_nth("o.md", 3, 2, "alpha two"),
            hit_nth("o.md", 5, 3, "alpha three"),
        ]
    );
}

/// 31. 1 行に 2 回ある行は最初の出現の番号で、次の行は +2(大小無視で数える)。
#[tokio::test]
async fn ordinal_of_a_line_with_two_occurrences_advances_the_next_line_by_two() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("o.md", "alpha\nAlpha ALPHA\nalpha\nx alpha y alpha z alpha\nalpha\n");

    let hits = run(&fs, "alpha").await;

    assert_eq!(hits.iter().map(|h| (h.line, h.ordinal)).collect::<Vec<_>>(), vec![
        (1, 1),
        (2, 2),
        (3, 4),
        (4, 5),
        (5, 8),
    ]);
    // The query's case does not change the count.
    let upper = run(&fs, "ALPHA").await;
    assert_eq!(upper, hits);
}

/// 32. 重ならない出現で数える(`aaaa` から `aa` は 2 → 次の行は 3)。
#[tokio::test]
async fn ordinal_counts_non_overlapping_occurrences() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("o.md", "aaaa\naaa\naa\n");

    let hits = run(&fs, "aa").await;

    assert_eq!(
        hits,
        vec![hit_nth("o.md", 1, 1, "aaaa"), hit_nth("o.md", 2, 3, "aaa"), hit_nth("o.md", 3, 4, "aa")]
    );
}

/// 33. ファイルが変わると 1 に戻る(パス順に並んでいても通し番号は引き継がない)。
#[tokio::test]
async fn ordinal_restarts_for_each_file() {
    let mut fs = MockFs::new(FILE_ROOT);
    fs.file("a.md", "alpha\nalpha alpha\nalpha\n");
    fs.file("b/c.md", "alpha\n");
    fs.file("d.txt", "none\nalpha\n");

    let hits = run(&fs, "alpha").await;

    assert_eq!(
        hits,
        vec![
            hit_nth("a.md", 1, 1, "alpha"),
            hit_nth("a.md", 2, 2, "alpha alpha"),
            hit_nth("a.md", 3, 4, "alpha"),
            hit_nth("b/c.md", 1, 1, "alpha"),
            hit_nth("d.txt", 2, 1, "alpha"),
        ]
    );
}

/// 34. 走査順(`list` の返す順序)が変わっても ordinal は同じ(AC-55-10 の決定性を ordinal にも)。
#[tokio::test]
async fn ordinal_is_deterministic_regardless_of_list_order() {
    let mut expected: Option<Vec<(String, u32, u32)>> = None;
    for order in [ListOrder::Sorted, ListOrder::Reversed, ListOrder::Rotated] {
        let mut fs = MockFs::new(FILE_ROOT).with_order(order);
        populate_shared_tree(&mut fs);
        fs.file("m.md", "Alpha ALPHA\nalpha\n");
        let got: Vec<(String, u32, u32)> = run(&fs, "alpha")
            .await
            .into_iter()
            .map(|h| (h.path, h.line, h.ordinal))
            .collect();
        assert!(got.contains(&("m.md".to_string(), 2, 3)));
        assert!(got.contains(&("zeta.md".to_string(), 3, 2)));
        match &expected {
            None => expected = Some(got),
            Some(e) => assert_eq!(&got, e, "order {order:?} must not change ordinals"),
        }
    }
}
