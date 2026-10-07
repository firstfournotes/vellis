//! 要件#55 追補e の受け入れテスト(docs/requirements/req-55.md「追補e 検索パネルを開き直しても
//! 検索できる」= backlog 216)— Rust 側(AC-55-41〜42)
//!
//! 発端: 3 回以上検索 → Close → Command + Shift + F で開き直す → 何を探しても `No results`。
//! `FindInFolder.svelte` の `SearchSession` はパネルのマウントごとに世代を 1 から振り直すが、
//! Rust の `ResultStore` は窓ラベルごとの最新世代(`latest`)と保持中の結果(`by_label`)を
//! **窓が閉じるまで**持ち続ける。開き直した後の世代 1・2… は `latest` より小さいので
//! `is_current` が偽になり、走査はすぐ止まり、`store` も保持しない。
//!
//! 判定範囲:
//! - AC-55-41 `ResultStore` の開き直しの筋書き: 世代 5 まで `begin` / `store` した窓を
//!   `forget` すると、世代 1 が `is_current` で真・`store` で保持され `page` で取れる。
//!   対照として `forget` しなければ世代 1 は偽・保持されない(=現状の不具合の再現)。
//!   `forget` は呼んだ窓だけに効き、他の窓の最新世代と結果は残る(e-3 不変)。
//! - AC-55-42 ソース走査: `commands/search.rs` に `#[tauri::command]` 付きの
//!   `search_in_folder_reset` があり、フロントから渡す引数を取らず(窓は `tauri::Window` /
//!   `WebviewWindow` の `.label()`・保持は managed state)、`ResultStore::forget` を呼ぶ。
//!   `lib.rs` の両方の `generate_handler!` に 1 回ずつ登録される。`search_in_folder` の
//!   `begin` / `is_current` / `store` の流れは不変。
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```text
//! // --- src-tauri/src/commands/search.rs に追加 ---
//! /// パネルを開いたとき(マウント時)にその窓の検索状態を捨てる(追補e e-1)。
//! /// 引数なし。窓ラベルは `window.label()`(`search_in_folder` と同じ取り方)。
//! /// 中身は `ResultStore::forget(label)`(結果も最新世代も捨てる=窓が閉じたときと同じ)。
//! #[tauri::command]
//! pub fn search_in_folder_reset(
//!     window: tauri::Window,
//!     results: tauri::State<'_, SearchResults>,
//! ) -> Result<(), String> { .. }
//!
//! // lib.rs: 両方の generate_handler! に `search_in_folder_reset` を登録(位置は問わない)。
//! ```
//!
//! `ResultStore` 本体(`begin` / `is_current` / `store` / `page` / `forget`)は追補a・d で
//! 確定済みの API を変えない。本ファイルの AC-55-41 は現状でも緑(API は既存)で、赤の源は
//! AC-55-42(command と登録)と `FindInFolder.reset.wiring.test.ts`(フロント配線)。

use vellis_lib::search::{ResultStore, SearchHit, PAGE_SIZE};

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

fn few(tag: &str) -> Vec<SearchHit> {
    vec![hit(&format!("{tag}-a.md"), 1, 1), hit(&format!("{tag}-a.md"), 4, 2), hit(&format!("{tag}-b.md"), 2, 1)]
}

/// パネルを開いて 5 回検索した窓を再現する: 世代 1〜5 を `begin` し、それぞれ `store` する。
fn search_five_times(store: &mut ResultStore, label: &str) {
    for generation in 1..=5u64 {
        store.begin(label, generation);
        store.store(label, generation, few(&format!("g{generation}")));
    }
}

// ---------------------------------------------------------------------------
// AC-55-41 — ResultStore: 開き直しの筋書き(forget で世代 1 が生き返る)
// ---------------------------------------------------------------------------

/// 対照(現状の不具合の再現): 世代 5 まで使った窓で、`forget` せずに世代 1 を始めると
/// `is_current` は偽・`store` は保持を変えず・`page` は空(= 開き直し後の `No results`)。
#[test]
fn without_forget_a_reopened_panel_generation_one_is_stale() {
    let mut store = ResultStore::new();
    search_five_times(&mut store, LABEL);

    // パネルを開き直す: SearchSession は 1 から振り直す。
    store.begin(LABEL, 1);
    assert!(!store.is_current(LABEL, 1), "without forget, generation 1 is older than the kept latest (5)");

    let response = store.store(LABEL, 1, few("reopened"));
    assert_eq!(response.generation, 1);
    assert!(store.page(LABEL, 1, 0, PAGE_SIZE).is_empty(), "generation 1 must not have been kept");
    assert_eq!(store.page(LABEL, 5, 0, PAGE_SIZE), few("g5"), "generation 5 stays kept");
}

/// 1. 世代 5 まで `begin` / `store` した窓を `forget` すると、世代 1 が `is_current` で真。
#[test]
fn after_forget_generation_one_is_current_again() {
    let mut store = ResultStore::new();
    search_five_times(&mut store, LABEL);
    assert!(!store.is_current(LABEL, 1), "precondition: generation 1 is stale before forget");

    store.forget(LABEL);

    assert!(store.is_current(LABEL, 1), "forget drops the latest generation; 1 is current again");
    store.begin(LABEL, 1);
    assert!(store.is_current(LABEL, 1), "and stays current once begun");
}

/// 2. `forget` の後の世代 1 は `store` で保持され、`page` で取れる。前の世代 5 の結果は消えている。
#[test]
fn after_forget_generation_one_is_stored_and_pageable() {
    let mut store = ResultStore::new();
    search_five_times(&mut store, LABEL);

    store.forget(LABEL);
    store.begin(LABEL, 1);
    let hits = few("reopened");
    let response = store.store(LABEL, 1, hits.clone());

    assert_eq!(response.generation, 1);
    assert_eq!(response.total, hits.len());
    assert_eq!(response.files, 2);
    assert_eq!(response.hits, hits);
    assert_eq!(store.page(LABEL, 1, 0, PAGE_SIZE), hits, "the reopened panel's results are kept");
    assert_eq!(store.page(LABEL, 1, 1, 1), hits[1..2].to_vec(), "and pageable by offset / limit");
    assert!(store.page(LABEL, 5, 0, PAGE_SIZE).is_empty(), "the old generation's results are gone");
}

/// 3. 開き直しを繰り返しても同じ(forget → 1〜3 → forget → 1)。
#[test]
fn reopening_twice_works_the_same_way() {
    let mut store = ResultStore::new();
    search_five_times(&mut store, LABEL);
    store.forget(LABEL);
    for generation in 1..=3u64 {
        store.begin(LABEL, generation);
        store.store(LABEL, generation, few(&format!("second-open-{generation}")));
    }
    assert!(!store.is_current(LABEL, 1));

    store.forget(LABEL);
    store.begin(LABEL, 1);
    assert!(store.is_current(LABEL, 1));
    let hits = few("third-open");
    store.store(LABEL, 1, hits.clone());
    assert_eq!(store.page(LABEL, 1, 0, PAGE_SIZE), hits);
}

/// 4. `forget` は呼んだ窓だけ: 別の窓の最新世代と結果はそのまま(e-3 不変・AC-55-26 の
///    「ラベルは独立」と同じ規則)。
#[test]
fn forget_resets_only_the_calling_window() {
    let mut store = ResultStore::new();
    search_five_times(&mut store, LABEL);
    search_five_times(&mut store, OTHER);

    store.forget(LABEL);

    assert!(store.is_current(LABEL, 1), "the reset window accepts generation 1");
    assert!(!store.is_current(OTHER, 1), "the other window still has latest = 5");
    assert!(store.is_current(OTHER, 5));
    assert_eq!(store.page(OTHER, 5, 0, PAGE_SIZE), few("g5"), "the other window's results are kept");
    assert!(store.page(LABEL, 5, 0, PAGE_SIZE).is_empty(), "the reset window's results are gone");
}

/// 5. `forget` の後も世代の規則は変わらない: 新しい世代を `begin` すれば古い世代は偽に戻る
///    (開き直し後の打ち替えが従来どおり前の走査を止める)。
#[test]
fn generation_rules_still_apply_after_forget() {
    let mut store = ResultStore::new();
    search_five_times(&mut store, LABEL);
    store.forget(LABEL);

    store.begin(LABEL, 1);
    store.begin(LABEL, 2);
    assert!(!store.is_current(LABEL, 1), "a newer generation makes 1 stale again");
    assert!(store.is_current(LABEL, 2));

    // 遅れて返った世代 1 は、世代 2 が保持済みなら保持を変えない(追補a の規則)。
    store.store(LABEL, 2, few("gen2"));
    store.store(LABEL, 1, few("late-gen1"));
    assert_eq!(store.page(LABEL, 2, 0, PAGE_SIZE), few("gen2"));
    assert!(store.page(LABEL, 1, 0, PAGE_SIZE).is_empty());
}

/// 6. 何も検索していない窓(`begin` 無し)を `forget` しても害はなく、世代 1 は真のまま。
#[test]
fn forget_on_a_fresh_window_is_harmless() {
    let mut store = ResultStore::new();
    store.forget(LABEL);
    assert!(store.is_current(LABEL, 1));
    store.begin(LABEL, 1);
    let hits = few("fresh");
    store.store(LABEL, 1, hits.clone());
    assert_eq!(store.page(LABEL, 1, 0, PAGE_SIZE), hits);
}

// ---------------------------------------------------------------------------
// AC-55-42 — ソース走査: search_in_folder_reset command と登録
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

/// `fn <name>(` から始まる関数の (引数リスト, 本体) を切り出す。本体は `{` と `}` の対応で区切る。
fn function_parts<'a>(code: &'a str, name: &str) -> (&'a str, &'a str) {
    let needle = format!("fn {name}(");
    let start = code
        .find(&needle)
        .unwrap_or_else(|| panic!("commands/search.rs must define {name}"));
    let params_start = start + needle.len();
    let params_end = code[params_start..].find(')').expect("parameter list must close") + params_start;
    let params = &code[params_start..params_end];
    let body_start = code[params_end..].find('{').expect("function body must open") + params_end;
    let mut depth = 0usize;
    let mut body_end = None;
    for (offset, ch) in code[body_start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    body_end = Some(body_start + offset + ch.len_utf8());
                    break;
                }
            }
            _ => {}
        }
    }
    let body = &code[body_start..body_end.expect("function body must close")];
    (params, body)
}

/// 7. `commands/search.rs` に `search_in_folder_reset` があり、`#[tauri::command]` が直接付く。
#[test]
fn search_in_folder_reset_is_a_tauri_command() {
    let code = search_command_code();
    let start = code
        .find("fn search_in_folder_reset(")
        .expect("commands/search.rs must define search_in_folder_reset");
    let before = &code[..start];
    let attr_at = before
        .rfind("#[tauri::command]")
        .expect("commands/search.rs declares tauri commands");
    assert!(
        !before[attr_at..].contains("fn "),
        "the #[tauri::command] attribute must sit directly on search_in_folder_reset"
    );
    assert!(
        code.contains("pub fn search_in_folder_reset(") || code.contains("pub async fn search_in_folder_reset("),
        "search_in_folder_reset must be pub so lib.rs can register it"
    );
}

/// 8. e-1「引数なし」: フロントから渡すデータ引数を取らない。窓は `tauri::Window` /
///    `WebviewWindow` のハンドル、保持は managed state(`SearchResults`)だけ。
#[test]
fn search_in_folder_reset_takes_no_front_end_arguments() {
    let code = search_command_code();
    let (params, _) = function_parts(&code, "search_in_folder_reset");
    for forbidden in ["String", "u64", "usize", "bool", "Vec<", "label"] {
        assert!(
            !params.contains(forbidden),
            "search_in_folder_reset must not take a front-end argument (found `{forbidden}`): {params}"
        );
    }
    assert!(
        params.contains("Window"),
        "the window label comes from the window handle (tauri::Window / WebviewWindow): {params}"
    );
    assert!(
        params.contains("SearchResults"),
        "the store comes from the managed state `SearchResults`: {params}"
    );
}

/// 9. 中身は `ResultStore::forget(label)`: 本体で `.label()` を取り、`.forget(` を呼ぶ。
///    (`begin` / `store` は呼ばない=捨てるだけ)
#[test]
fn search_in_folder_reset_forgets_the_windows_results() {
    let code = search_command_code();
    let (_, body) = function_parts(&code, "search_in_folder_reset");
    assert!(body.contains(".label()"), "the label comes from the window handle: {body}");
    assert!(body.contains(".forget("), "the command must call ResultStore::forget: {body}");
    assert!(!body.contains(".begin("), "reset must not start a generation: {body}");
    assert!(!body.contains(".store("), "reset must not keep results: {body}");
}

/// 10. `lib.rs` の両方の `generate_handler!` に `search_in_folder_reset` が 1 回ずつ登録される
///     (`search_in_folder` / `search_in_folder_page` の登録はそのまま)。
#[test]
fn search_in_folder_reset_is_registered_in_both_handler_lists() {
    let code = lib_rs_code();
    let blocks = handler_lists(&code);
    assert_eq!(blocks.len(), 2, "lib.rs has the webdriver and the production handler lists");
    for names in blocks {
        for required in ["search_in_folder", "search_in_folder_page", "search_in_folder_reset"] {
            assert_eq!(
                names.iter().filter(|n| *n == required).count(),
                1,
                "{required} must be registered exactly once: {names:?}"
            );
        }
    }
}

/// 11. e-3 不変: `search_in_folder` は従来どおり `begin` → `is_current_at` → `store_at` を通る。
///     (要件#55 追補f の要件側更新で読み替え: `.is_current(` → `.is_current_at(`・`.store(` → `.store_at(`)
#[test]
fn search_in_folder_still_begins_checks_and_stores() {
    let code = search_command_code();
    let (_, body) = function_parts(&code, "search_in_folder");
    assert!(body.contains(".begin("), "search_in_folder records the generation at start (d-3)");
    assert!(body.contains(".is_current_at("), "search_in_folder stops stale scans");
    assert!(body.contains(".store_at("), "search_in_folder keeps the results for Show more");
    assert!(!body.contains(".forget("), "search_in_folder itself must not forget (reset is its own command)");
}
