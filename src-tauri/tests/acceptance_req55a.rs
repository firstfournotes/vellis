//! 要件#55 追補a の受け入れテスト(docs/requirements/req-55.md「追補a 結果を段階的に渡す」)
//! — 段階渡しの純関数部分と command の登録(AC-55-26〜27)
//!
//! `search_in_folder_with` は従来どおり**全件**を返す(上限なし=由谷 2026-09-16 は不変)。
//! 変わるのは一度に運ぶ量だけで、それを担うのが `ResultStore`(窓ラベル×世代で直近の結果を
//! 保持し、先頭 `PAGE_SIZE` 件を返し、続きをページで切り出す)。Tauri の managed state を
//! 経由する command 層(`commands/search.rs`)は統合テストから直接呼べないので、保持と
//! ページ切り出しをこの純構造体に切り出す前提で判定する。`SearchHit.ordinal` の値は
//! `tests/acceptance_req55.rs` の AC-55-25。
//!
//! 判定範囲:
//! - AC-55-26 `PAGE_SIZE` = 200・`ResultStore::store` は先頭 `PAGE_SIZE` 件だけ返し
//!   `total` / `files` は全件の値・`page` は offset / limit で切り出す・範囲外は空・
//!   世代違いは空・新しい世代で前の世代が消える・ラベルは独立・`forget` で捨てる・
//!   200 件以下なら全部・`SearchResponse` は 4 フィールド固定(JSON のキーも)
//! - AC-55-27 `search_in_folder_page` が両方の `generate_handler!` に `search_in_folder` の
//!   直後で登録される・command の引数名(`generation` / `offset` / `limit`)・窓が閉じたら捨てる
//!   (`forget` を窓のイベントから呼ぶ)
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```text
//! // --- src-tauri/src/search/mod.rs に追加 ---
//! /// 1 ページの件数(`search_in_folder` の初回応答と `search_in_folder_page` の既定)。
//! pub const PAGE_SIZE: usize = 200;
//!
//! /// command の戻り(commands/search.rs から移す。commands 側は `pub use` でよい)。
//! /// `total` = 一致の総件数・`files` = 一致ファイル数(いずれも全件の値)・
//! /// `hits` = 先頭 PAGE_SIZE 件(パス順・行番号順の先頭)。
//! #[derive(Clone, Debug, Serialize)]
//! pub struct SearchResponse {
//!     pub generation: u64,
//!     pub total: usize,
//!     pub files: usize,
//!     pub hits: Vec<SearchHit>,
//! }
//!
//! /// 窓ラベル×世代で直近の検索結果を保持する(managed state に `Mutex<ResultStore>` で載せる)。
//! #[derive(Default)]
//! pub struct ResultStore { .. }
//! impl ResultStore {
//!     pub fn new() -> Self;
//!     /// 全件を受け取り、その窓の前の世代を捨てて保持し、初回応答を組む。
//!     pub fn store(&mut self, label: &str, generation: u64, hits: Vec<SearchHit>) -> SearchResponse;
//!     /// 続きを切り出す。ラベルが無い・世代が違う・offset が範囲外・limit 0 なら空。
//!     /// 末尾は短くてよい(offset..min(offset+limit, total))。
//!     pub fn page(&self, label: &str, generation: u64, offset: usize, limit: usize) -> Vec<SearchHit>;
//!     /// 窓が閉じたら捨てる。無いラベルでも何もしない。
//!     pub fn forget(&mut self, label: &str);
//! }
//!
//! // --- src-tauri/src/commands/search.rs ---
//! // #[tauri::command] async fn search_in_folder(root, query, generation, window, state)
//! //   -> Result<SearchResponse, String>   // 全件走査 → state.result_store.store(window.label(), ..)
//! // #[tauri::command] fn search_in_folder_page(generation: u64, offset: usize, limit: usize, window, state)
//! //   -> Result<PageResponse, String>     // PageResponse { generation: u64, hits: Vec<SearchHit> }
//! // lib.rs: 両方の generate_handler! に `search_in_folder_page`(`search_in_folder` の直後)。
//! //         on_window_event の Destroyed(または CloseRequested)で result_store.forget(label)
//! ```

use std::collections::BTreeSet;

use vellis_lib::search::{ResultStore, SearchHit, SearchResponse, PAGE_SIZE};

const LABEL: &str = "main";
const OTHER: &str = "second";

fn hit(path: &str, line: u32, ordinal: u32) -> SearchHit {
    SearchHit {
        path: path.to_string(),
        line,
        text: format!("alpha {line}"),
        ordinal,
    }
}

/// `files` ファイル × `per_file` 行の一致(パス順・行番号順に並んだ全件)。
fn many(files: usize, per_file: usize) -> Vec<SearchHit> {
    let mut hits = Vec::with_capacity(files * per_file);
    for f in 0..files {
        for i in 0..per_file {
            hits.push(hit(&format!("f{f:02}.md"), (i + 1) as u32, (i + 1) as u32));
        }
    }
    hits
}

fn distinct_paths(hits: &[SearchHit]) -> usize {
    hits.iter().map(|h| h.path.as_str()).collect::<BTreeSet<_>>().len()
}

// ---------------------------------------------------------------------------
// AC-55-26 — ResultStore / PAGE_SIZE
// ---------------------------------------------------------------------------

/// 1. `PAGE_SIZE` は 200(値固定)。
#[test]
fn page_size_is_200() {
    assert_eq!(PAGE_SIZE, 200);
}

/// 2. 1,000 件 / 10 ファイルを store すると、初回応答は先頭 200 件だけで、
///    `total` / `files` / `generation` は全件の値・受け取った世代。
#[test]
fn store_returns_only_the_first_page_but_counts_everything() {
    let all = many(10, 100);
    let mut store = ResultStore::new();

    let resp: SearchResponse = store.store(LABEL, 7, all.clone());

    assert_eq!(resp.generation, 7);
    assert_eq!(resp.total, 1000);
    assert_eq!(resp.files, 10);
    assert_eq!(resp.hits.len(), PAGE_SIZE);
    assert_eq!(resp.hits, all[..PAGE_SIZE].to_vec(), "the first page is the head of the sorted list");
    assert_eq!(distinct_paths(&resp.hits), 2, "the first 200 hits span f00 and f01 only");
}

/// 3. 200 件以下なら全部返る(ちょうど 200・3 件・0 件)。0 件は total 0 / files 0。
#[test]
fn store_returns_everything_when_at_or_below_page_size() {
    let mut store = ResultStore::new();

    let exact = many(2, 100);
    let resp = store.store(LABEL, 1, exact.clone());
    assert_eq!((resp.total, resp.files, resp.hits.len()), (200, 2, 200));
    assert_eq!(resp.hits, exact);

    let few = vec![hit("a.md", 1, 1), hit("a.md", 4, 2), hit("b.txt", 2, 1)];
    let resp = store.store(LABEL, 2, few.clone());
    assert_eq!((resp.total, resp.files), (3, 2));
    assert_eq!(resp.hits, few);

    let resp = store.store(LABEL, 3, Vec::new());
    assert_eq!((resp.total, resp.files), (0, 0));
    assert!(resp.hits.is_empty());
    assert!(store.page(LABEL, 3, 0, PAGE_SIZE).is_empty());
}

/// 4. `page(label, generation, offset, limit)` は保持した全件の `offset..offset+limit` を返す。
///    末尾は短くてよい。
#[test]
fn page_slices_by_offset_and_limit() {
    let all = many(10, 100);
    let mut store = ResultStore::new();
    store.store(LABEL, 1, all.clone());

    assert_eq!(store.page(LABEL, 1, 200, 200), all[200..400].to_vec());
    assert_eq!(store.page(LABEL, 1, 800, 200), all[800..1000].to_vec());
    assert_eq!(store.page(LABEL, 1, 900, 200), all[900..1000].to_vec(), "the last page is short");
    assert_eq!(store.page(LABEL, 1, 0, 50), all[..50].to_vec());
    assert_eq!(store.page(LABEL, 1, 999, 1), all[999..].to_vec());
    // Paging in PAGE_SIZE steps from 0 reassembles the whole list exactly once.
    let mut collected = Vec::new();
    let mut offset = 0;
    loop {
        let page = store.page(LABEL, 1, offset, PAGE_SIZE);
        if page.is_empty() {
            break;
        }
        offset += page.len();
        collected.extend(page);
    }
    assert_eq!(collected, all);
}

/// 5. 範囲外(offset >= total)・limit 0・無いラベルは空(Err にもパニックにもならない)。
#[test]
fn page_out_of_range_or_unknown_label_is_empty() {
    let all = many(10, 100);
    let mut store = ResultStore::new();
    store.store(LABEL, 1, all);

    assert!(store.page(LABEL, 1, 1000, 200).is_empty());
    assert!(store.page(LABEL, 1, 5000, 200).is_empty());
    assert!(store.page(LABEL, 1, usize::MAX, 200).is_empty());
    assert!(store.page(LABEL, 1, 0, 0).is_empty());
    assert!(store.page(LABEL, 1, 200, usize::MAX).len() == 800, "a huge limit clamps to the end");
    assert!(store.page("no-such-window", 1, 0, 200).is_empty());
    assert!(ResultStore::new().page(LABEL, 1, 0, 200).is_empty());
}

/// 6. 世代が違えば空(古い世代も未来の世代も)。
#[test]
fn page_for_another_generation_is_empty() {
    let all = many(10, 100);
    let mut store = ResultStore::new();
    store.store(LABEL, 5, all);

    assert!(store.page(LABEL, 4, 0, 200).is_empty());
    assert!(store.page(LABEL, 6, 0, 200).is_empty());
    assert!(store.page(LABEL, 0, 0, 200).is_empty());
    assert_eq!(store.page(LABEL, 5, 0, 200).len(), 200);
}

/// 7. 新しい世代を store すると同じ窓の前の世代は消える(ページも取れない)。
#[test]
fn a_new_generation_replaces_the_previous_one_for_the_same_window() {
    let old = many(10, 100);
    let new = many(3, 100);
    let mut store = ResultStore::new();
    store.store(LABEL, 1, old);
    assert_eq!(store.page(LABEL, 1, 200, 200).len(), 200);

    let resp = store.store(LABEL, 2, new.clone());

    assert_eq!((resp.generation, resp.total, resp.files), (2, 300, 3));
    assert!(store.page(LABEL, 1, 0, 200).is_empty(), "generation 1 is gone");
    assert!(store.page(LABEL, 1, 200, 200).is_empty());
    assert_eq!(store.page(LABEL, 2, 200, 200), new[200..300].to_vec());
}

/// 8. 窓ラベルごとに独立(別の窓の検索で消えない・別の窓のページは取れない)。
#[test]
fn labels_are_independent() {
    let a = many(10, 100);
    let b = vec![hit("only-in-second.md", 1, 1), hit("only-in-second.md", 2, 2)];
    let mut store = ResultStore::new();
    store.store(LABEL, 1, a.clone());
    let resp_b = store.store(OTHER, 1, b.clone());

    assert_eq!((resp_b.total, resp_b.files), (2, 1));
    assert_eq!(store.page(LABEL, 1, 200, 200), a[200..400].to_vec());
    assert_eq!(store.page(OTHER, 1, 0, 200), b);
    assert_eq!(store.page(OTHER, 1, 1, 200), b[1..].to_vec());

    // A new generation in one window leaves the other window alone.
    store.store(LABEL, 2, many(1, 10));
    assert_eq!(store.page(OTHER, 1, 0, 200), b);
    assert!(store.page(LABEL, 1, 0, 200).is_empty());
}

/// 9. `forget(label)` でその窓の保持を捨てる(他の窓は残る・無いラベルは何もしない)。
#[test]
fn forget_drops_only_that_window() {
    let mut store = ResultStore::new();
    store.store(LABEL, 1, many(10, 100));
    store.store(OTHER, 1, many(2, 10));

    store.forget(LABEL);

    assert!(store.page(LABEL, 1, 0, 200).is_empty());
    assert_eq!(store.page(OTHER, 1, 0, 200).len(), 20);
    store.forget("never-stored");
    store.forget(LABEL);
    assert_eq!(store.page(OTHER, 1, 0, 200).len(), 20);
}

/// 10. `SearchResponse` は `generation` / `total` / `files` / `hits` の 4 フィールド固定
///     (構造体リテラルがコンパイルできることが担保)。JSON のキーも同じ綴りで、
///     `hits` の要素は `path` / `line` / `text` / `ordinal`(フロントの型と同形)。
#[test]
fn search_response_shape_is_fixed_in_rust_and_in_json() {
    let resp = SearchResponse {
        generation: 3,
        total: 1,
        files: 1,
        hits: vec![hit("a.md", 2, 1)],
    };

    let json = serde_json::to_value(&resp).expect("SearchResponse serializes");
    let keys: BTreeSet<String> = json.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        ["generation", "total", "files", "hits"].iter().map(|s| s.to_string()).collect()
    );
    assert_eq!(json["generation"], 3);
    assert_eq!(json["total"], 1);
    assert_eq!(json["files"], 1);
    let hit_keys: BTreeSet<String> = json["hits"][0].as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        hit_keys,
        ["path", "line", "text", "ordinal"].iter().map(|s| s.to_string()).collect()
    );
    assert_eq!(json["hits"][0]["ordinal"], 1);
}

// ---------------------------------------------------------------------------
// AC-55-27 — command の登録と窓が閉じたときの破棄(ソース走査)
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

fn lib_rs_code() -> String {
    strip_line_comments(include_str!("../src/lib.rs"))
}

fn search_command_code() -> String {
    strip_line_comments(include_str!("../src/commands/search.rs"))
}

fn handler_lists(code: &str) -> Vec<Vec<String>> {
    code.match_indices("generate_handler![")
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
        .collect()
}

/// 11. `search_in_folder_page` が両方の `generate_handler!` に、`search_in_folder` の直後で登録される。
#[test]
fn search_in_folder_page_is_registered_right_after_search_in_folder_in_both_lists() {
    let code = lib_rs_code();
    let blocks = handler_lists(&code);
    assert_eq!(blocks.len(), 2, "lib.rs has the webdriver and the production handler lists");
    for names in blocks {
        let at = names
            .iter()
            .position(|n| n == "search_in_folder")
            .unwrap_or_else(|| panic!("search_in_folder must be registered: {names:?}"));
        assert_eq!(
            names.get(at + 1).map(String::as_str),
            Some("search_in_folder_page"),
            "search_in_folder_page must follow search_in_folder: {names:?}"
        );
        assert_eq!(
            names.iter().filter(|n| *n == "search_in_folder_page").count(),
            1,
            "registered exactly once: {names:?}"
        );
    }
}

/// 12. command の引数名は `generation` / `offset` / `limit`(フロントは camelCase の同名で
///     invoke する)。窓ラベルは `Window` / `WebviewWindow` の `label()` から取る
///     (フロントに窓の識別子を持たせない)。
#[test]
fn search_in_folder_page_command_signature() {
    let code = search_command_code();
    let start = code
        .find("fn search_in_folder_page(")
        .expect("commands/search.rs must define search_in_folder_page");
    let params_end = code[start..].find(')').expect("parameter list must close") + start;
    let params = &code[start..params_end];
    for name in ["generation: u64", "offset: usize", "limit: usize"] {
        assert!(params.contains(name), "search_in_folder_page must take `{name}`: {params}");
    }
    let before = &code[..start];
    let attr_at = before.rfind("#[tauri::command]").expect("commands/search.rs declares tauri commands");
    assert!(
        !before[attr_at..].contains("fn "),
        "the #[tauri::command] attribute must sit directly on search_in_folder_page"
    );
    assert!(code.contains(".label()"), "the window label comes from the window handle, not the front end");
    assert!(code.contains("ResultStore"), "the command layer delegates to search::ResultStore");
}

/// 13. 窓が閉じたら保持を捨てる: lib.rs の `on_window_event` で `Destroyed`(または
///     `CloseRequested`)を受けて `forget(` を呼ぶ。
#[test]
fn window_close_forgets_the_stored_results() {
    let code = lib_rs_code();
    assert!(code.contains("on_window_event"), "lib.rs installs a window event handler");
    assert!(
        code.contains("WindowEvent::Destroyed") || code.contains("WindowEvent::CloseRequested"),
        "lib.rs must react to the window closing"
    );
    let calls_forget = code.contains(".forget(") || search_command_code().contains(".forget(");
    assert!(calls_forget, "closing a window must call ResultStore::forget for its label");
}
