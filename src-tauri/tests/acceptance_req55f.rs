//! 要件#55 追補f の受け入れテスト(docs/requirements/req-55.md「追補f 開き直しをまたいだ古い走査が
//! 新しいパネルの結果を上書きしない」= backlog 220)— Rust 側(AC-55-44〜49)
//!
//! 発端: 前のパネルの長い走査(世代 5)が走っている間にパネルを開き直して検索すると、
//! `search_in_folder_reset`(`forget`)で `latest` が消えた後も古い走査は `is_current(5)` で
//! 真のまま走り続け(新しいパネルの世代 1 の `begin` 後も 5 ≥ 1 で真)、終了時の
//! `store(label, 5, …)` が新しいパネルの世代 1 の保持を上書きする(逆順なら世代 1 の `store`
//! が「より新しい 5 が保持済み」で捨てられる)。新しいパネルの Show more は空になる。
//!
//! 判定範囲(req-55.md 追補f の受け入れ基準 (1)〜(6)。(7)=既存テストが無改変で緑、は
//! test-runner のフルスイートで見る):
//! - AC-55-44 (1) 世代 5 を `begin`(e0)→ `forget` → 世代 1 を `begin`(e1)で `e1 != e0`・
//!   `is_current_at(label, e0, 5)` は偽・`is_current_at(label, e1, 1)` は真。
//!   あわせて f-1(`epoch` は 0 始まり・`forget` ごとに 1 増える・`forget` でも消えない)。
//! - AC-55-45 (2) 新しいパネルが `store_at(e1, 1, A)` した後に古い走査が `store_at(e0, 5, B)`
//!   しても `page(1)` は A・`page(5)` は空・古い `store_at` の応答は B から組まれる。
//!   逆順(古い `store_at` が先)でも同じ。
//! - AC-55-46 (3) `forget` を挟まなければ従来どおり: `begin` は同じ `epoch` を返し、
//!   `is_current_at` は `is_current` と同じ真偽・`store_at` は `store` と同じ保持の規則。
//! - AC-55-47 (4) 窓 A の `forget` は窓 B の `epoch` を変えない。
//! - AC-55-48 (5) `forget` の後、一度も `begin` していないラベルでも、`forget` 前の `epoch` は
//!   `is_current_at` で偽(=`store_at` も保持しない)。
//! - AC-55-49 (6) ソース走査: `commands/search.rs` の `search_in_folder` が `begin(` の返り値を
//!   変数に受け、`is_current_at(` を sink と cancel の両方で、`store_at(` を走査の後に呼ぶ。
//!   `.is_current(` と `.store(` は直接呼ばない。
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```text
//! // --- src-tauri/src/search/mod.rs ---
//! impl ResultStore {
//!     /// 窓の最新世代を記録し、その窓の今の epoch(リセット回数・初期値 0)を返す。
//!     pub fn begin(&mut self, label: &str, generation: u64) -> u64;
//!     /// epoch が今の値と同じ、かつ is_current(label, generation) が真。
//!     pub fn is_current_at(&self, label: &str, epoch: u64, generation: u64) -> bool;
//!     /// epoch が今の値と違えば保持を変えずに応答だけ組む(形は store と同じ)。同じなら store と同じ。
//!     pub fn store_at(&mut self, label: &str, epoch: u64, generation: u64, hits: Vec<SearchHit>) -> SearchResponse;
//!     /// 今の処理(結果と最新世代を捨てる)に加えて、その窓の epoch を 1 増やす(epoch は消さない)。
//!     pub fn forget(&mut self, label: &str);
//! }
//! // is_current / store / page は無改変(今の epoch の走査として判定する)。
//!
//! // --- src-tauri/src/commands/search.rs の search_in_folder ---
//! let epoch = results.0.lock().map_err(|e| e.to_string())?.begin(&label, generation);
//! // sink と cancel の判定: s.is_current_at(&label, epoch, generation)
//! // 走査の後の保持:          store.store_at(&label, epoch, generation, all)
//! ```
//!
//! 赤の理由(実装前): `begin` が `()` を返し `is_current_at` / `store_at` が無いので本ファイルは
//! コンパイルできない(AC-55-44〜48)。`ResultStore` を直しても、command が `is_current(` /
//! `.store(` のままなら AC-55-49 が赤。

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

/// 3 件・2 ファイル。
fn few(tag: &str) -> Vec<SearchHit> {
    vec![hit(&format!("{tag}-a.md"), 1, 1), hit(&format!("{tag}-a.md"), 4, 2), hit(&format!("{tag}-b.md"), 2, 1)]
}

/// 5 件・3 ファイル(`few` と件数・ファイル数が違う=応答がどちらから組まれたか見分けられる)。
fn more(tag: &str) -> Vec<SearchHit> {
    vec![
        hit(&format!("{tag}-x.md"), 1, 1),
        hit(&format!("{tag}-x.md"), 3, 2),
        hit(&format!("{tag}-y.md"), 2, 1),
        hit(&format!("{tag}-y.md"), 9, 2),
        hit(&format!("{tag}-z.md"), 5, 1),
    ]
}

/// 前のパネルで 5 回検索した窓を再現する: 世代 1〜4 は `begin` / `store` 済み、世代 5 は
/// `begin` して走査中(まだ `store` していない)。走査中の世代 5 が `begin` で得た epoch を返す。
fn open_and_search_five_times(store: &mut ResultStore, label: &str) -> u64 {
    let mut epoch: Option<u64> = None;
    for generation in 1..=5u64 {
        let e: u64 = store.begin(label, generation);
        if let Some(previous) = epoch {
            assert_eq!(e, previous, "begin without a forget in between returns the same epoch");
        }
        epoch = Some(e);
        if generation < 5 {
            store.store(label, generation, few(&format!("g{generation}")));
        }
    }
    epoch.expect("five generations began")
}

// ---------------------------------------------------------------------------
// AC-55-44 — (1) 開き直し(forget)で epoch が変わり、古い走査は偽・新しい走査は真
// ---------------------------------------------------------------------------

/// 1. 世代 5 を `begin`(e0)→ `forget` → 世代 1 を `begin`(e1): `e1 != e0`・
///    `is_current_at(e0, 5)` は偽・`is_current_at(e1, 1)` は真。
///    対照として従来の `is_current` は両方とも真のまま(=これだけでは古い走査を止められない。
///    f-4: `is_current` の振る舞いは不変)。
#[test]
fn reopening_changes_the_epoch_and_stales_the_old_scan() {
    let mut store = ResultStore::new();
    let e0 = open_and_search_five_times(&mut store, LABEL);
    assert!(store.is_current_at(LABEL, e0, 5), "precondition: the running scan is current before the reopen");

    // パネルを開き直す: search_in_folder_reset → forget、新しいパネルの最初の検索 → begin(1)。
    store.forget(LABEL);
    let e1: u64 = store.begin(LABEL, 1);

    assert_ne!(e1, e0, "a reopen must hand the new panel a different epoch");
    assert!(!store.is_current_at(LABEL, e0, 5), "the old scan (epoch e0) must stop at its next check");
    assert!(store.is_current_at(LABEL, e1, 1), "the new panel's generation 1 is current under e1");

    // f-4: the epoch-less checks are unchanged — and that is exactly why they cannot tell.
    assert!(store.is_current(LABEL, 5), "is_current still says yes for the old generation (5 >= 1)");
    assert!(store.is_current(LABEL, 1));
}

/// 2. f-1: `epoch` は 0 始まり・`forget` のたびに 1 増える(間に `begin` が無くても数える)・
///    `forget` で消えない(一度も `begin` していないラベルを `forget` しても 1 になる)。
#[test]
fn epoch_starts_at_zero_and_each_forget_adds_one() {
    let mut store = ResultStore::new();
    let first: u64 = store.begin(LABEL, 1);
    assert_eq!(first, 0, "a window that was never reset is at epoch 0");

    store.forget(LABEL);
    assert_eq!(store.begin(LABEL, 1), 1, "one reset → epoch 1");

    store.forget(LABEL);
    store.forget(LABEL);
    assert_eq!(store.begin(LABEL, 1), 3, "every forget counts, even without a begin in between");

    // A label nobody has begun: forget still moves it from 0 to 1 (the epoch is not dropped).
    store.forget(OTHER);
    assert!(!store.is_current_at(OTHER, 0, 1), "epoch 0 is stale once the window was reset");
    assert_eq!(store.begin(OTHER, 1), 1);
}

// ---------------------------------------------------------------------------
// AC-55-45 — (2) 古い走査の store_at は新しいパネルの保持を上書きしない・応答は自分の結果から
// ---------------------------------------------------------------------------

/// 3. 新しいパネルが `store_at(e1, 1, A)` した後に古い走査が `store_at(e0, 5, B)`:
///    `page(1)` は A・`page(5)` は空。古い `store_at` の応答は B から組まれる(total/files/hits)。
#[test]
fn late_store_from_the_old_scan_does_not_replace_the_new_panels_results() {
    let mut store = ResultStore::new();
    let e0 = open_and_search_five_times(&mut store, LABEL);
    store.forget(LABEL);
    let e1 = store.begin(LABEL, 1);

    let new_hits = few("new");
    let old_hits = more("old");

    let new_response = store.store_at(LABEL, e1, 1, new_hits.clone());
    assert_eq!(new_response.generation, 1);
    assert_eq!(new_response.total, new_hits.len());
    assert_eq!(new_response.files, 2);
    assert_eq!(new_response.hits, new_hits);

    let old_response = store.store_at(LABEL, e0, 5, old_hits.clone());
    assert_eq!(old_response.generation, 5, "the response still carries the old scan's generation");
    assert_eq!(old_response.total, old_hits.len(), "the response is built from B (the front end drops it)");
    assert_eq!(old_response.files, 3);
    assert_eq!(old_response.hits, old_hits);

    assert_eq!(store.page(LABEL, 1, 0, PAGE_SIZE), new_hits, "the new panel's results are kept");
    assert_eq!(store.page(LABEL, 1, 1, 1), new_hits[1..2].to_vec(), "Show more still works for the new panel");
    assert!(store.page(LABEL, 5, 0, PAGE_SIZE).is_empty(), "the old scan's results were never kept");
}

/// 4. 逆順: 古い走査の `store_at(e0, 5, B)` が先に着き、その後に新しいパネルが
///    `store_at(e1, 1, A)`: それでも `page(1)` は A・`page(5)` は空(古い 5 が保持されていれば
///    `store` の「より新しい世代が保持済み」の規則で A が捨てられてしまう=それが起きない)。
#[test]
fn old_store_arriving_before_the_new_panel_stores_is_dropped_too() {
    let mut store = ResultStore::new();
    let e0 = open_and_search_five_times(&mut store, LABEL);
    store.forget(LABEL);
    let e1 = store.begin(LABEL, 1);

    let old_hits = more("old");
    let old_response = store.store_at(LABEL, e0, 5, old_hits.clone());
    assert_eq!(old_response.generation, 5);
    assert_eq!(old_response.total, old_hits.len());
    assert!(store.page(LABEL, 5, 0, PAGE_SIZE).is_empty(), "a stale epoch keeps nothing");

    let new_hits = few("new");
    let new_response = store.store_at(LABEL, e1, 1, new_hits.clone());
    assert_eq!(new_response.generation, 1);
    assert_eq!(new_response.hits, new_hits);
    assert_eq!(store.page(LABEL, 1, 0, PAGE_SIZE), new_hits, "generation 1 is kept (no newer generation blocks it)");
    assert!(store.page(LABEL, 5, 0, PAGE_SIZE).is_empty());
}

// ---------------------------------------------------------------------------
// AC-55-46 — (3) forget を挟まなければ従来どおり
// ---------------------------------------------------------------------------

/// 5. `begin` の返り値は同じ `epoch`・`is_current_at` は `is_current` と同じ真偽
///    (新しい世代が `begin` 済みなら古い世代は偽・最新と未来の世代は真)。
///    一度も触っていないラベルは epoch 0 で、どの世代も真(`is_current` と同じ)。
#[test]
fn without_forget_begin_returns_the_same_epoch_and_is_current_at_follows_is_current() {
    let mut store = ResultStore::new();
    let e: u64 = store.begin(LABEL, 1);
    assert_eq!(store.begin(LABEL, 2), e, "no reset → same epoch");
    assert_eq!(store.begin(LABEL, 3), e);

    for generation in 1..=4u64 {
        assert_eq!(
            store.is_current_at(LABEL, e, generation),
            store.is_current(LABEL, generation),
            "generation {generation}: is_current_at under the current epoch equals is_current"
        );
    }
    assert!(!store.is_current_at(LABEL, e, 1), "an older generation is stale once 3 began");
    assert!(!store.is_current_at(LABEL, e, 2));
    assert!(store.is_current_at(LABEL, e, 3), "the latest generation is current");
    assert!(store.is_current_at(LABEL, e, 4), "a newer generation not yet begun is current (same as is_current)");

    assert!(store.is_current_at(OTHER, 0, 1), "an untouched label is at epoch 0 and every generation is current");
    assert_eq!(store.is_current_at(OTHER, 0, 7), store.is_current(OTHER, 7));
}

/// 6. `store_at` は同じ `epoch` なら `store` と同じ: 最新世代は保持され、遅れて返った古い世代は
///    保持を変えず(応答は自分の結果から)、さらに新しい世代は前の世代を捨てて保持される。
#[test]
fn without_forget_store_at_keeps_results_like_store() {
    let mut store = ResultStore::new();
    let e = store.begin(LABEL, 1);
    store.begin(LABEL, 2);

    let gen2 = few("gen2");
    let response = store.store_at(LABEL, e, 2, gen2.clone());
    assert_eq!(response.generation, 2);
    assert_eq!(response.total, gen2.len());
    assert_eq!(response.files, 2);
    assert_eq!(response.hits, gen2);
    assert_eq!(store.page(LABEL, 2, 0, PAGE_SIZE), gen2);

    // Late generation 1 under the same epoch: the rule from 追補a — a newer kept generation wins.
    let late = more("late");
    let late_response = store.store_at(LABEL, e, 1, late.clone());
    assert_eq!(late_response.generation, 1);
    assert_eq!(late_response.total, late.len(), "the response is built from its own hits");
    assert_eq!(store.page(LABEL, 2, 0, PAGE_SIZE), gen2, "generation 2 stays kept");
    assert!(store.page(LABEL, 1, 0, PAGE_SIZE).is_empty());

    // A newer generation under the same epoch replaces the kept one, like store.
    store.begin(LABEL, 3);
    let gen3 = few("gen3");
    store.store_at(LABEL, e, 3, gen3.clone());
    assert_eq!(store.page(LABEL, 3, 0, PAGE_SIZE), gen3);
    assert!(store.page(LABEL, 2, 0, PAGE_SIZE).is_empty(), "one generation per window");
}

// ---------------------------------------------------------------------------
// AC-55-47 — (4) 窓 A の forget は窓 B の epoch を変えない
// ---------------------------------------------------------------------------

/// 7. 窓 A と窓 B がそれぞれ走査中に A だけ `forget`: B の `begin` は同じ `epoch` を返し、
///    B の走査は `is_current_at` で真のまま・`store_at` で保持される。A の方だけ `epoch` が変わる。
#[test]
fn forgetting_one_window_leaves_the_other_windows_epoch_alone() {
    let mut store = ResultStore::new();
    let ea = open_and_search_five_times(&mut store, LABEL);
    let eb = open_and_search_five_times(&mut store, OTHER);

    store.forget(LABEL);

    assert_eq!(store.begin(OTHER, 5), eb, "window B's epoch is untouched by A's reset");
    assert!(store.is_current_at(OTHER, eb, 5), "B's running scan stays current");
    let b_hits = few("b5");
    let b_response = store.store_at(OTHER, eb, 5, b_hits.clone());
    assert_eq!(b_response.hits, b_hits);
    assert_eq!(store.page(OTHER, 5, 0, PAGE_SIZE), b_hits, "B's results are kept");

    let ea_new = store.begin(LABEL, 1);
    assert_ne!(ea_new, ea, "A's epoch did change");
    assert!(!store.is_current_at(LABEL, ea, 5), "A's old scan is stale");
    assert_eq!(store.begin(OTHER, 5), eb, "B's epoch is still untouched after A began anew");
}

// ---------------------------------------------------------------------------
// AC-55-48 — (5) forget の後、まだ誰も begin していなくても、forget 前の epoch は偽
// ---------------------------------------------------------------------------

/// 8. 世代 5 を `begin`(e0)→ `forget` →(新しいパネルはまだ `begin` しない):
///    `is_current(5)` は真でも `is_current_at(e0, 5)` は偽・`store_at(e0, 5, B)` は保持しない
///    (応答は B から)。その後に新しいパネルが `begin`(e1)→ `store_at` すれば保持される。
#[test]
fn epoch_taken_before_forget_is_stale_even_before_the_new_panel_begins() {
    let mut store = ResultStore::new();
    let e0 = open_and_search_five_times(&mut store, LABEL);

    store.forget(LABEL);

    assert!(store.is_current(LABEL, 5), "f-4: with no latest recorded, is_current alone still says yes");
    assert!(!store.is_current_at(LABEL, e0, 5), "but the epoch from before the reset is stale");
    assert!(!store.is_current_at(LABEL, e0, 1), "whatever the generation");

    let old_hits = more("old");
    let old_response = store.store_at(LABEL, e0, 5, old_hits.clone());
    assert_eq!(old_response.generation, 5);
    assert_eq!(old_response.total, old_hits.len(), "the response is built from B");
    assert!(store.page(LABEL, 5, 0, PAGE_SIZE).is_empty(), "nothing is kept under a stale epoch");

    let e1 = store.begin(LABEL, 1);
    assert_ne!(e1, e0);
    let new_hits = few("new");
    store.store_at(LABEL, e1, 1, new_hits.clone());
    assert_eq!(store.page(LABEL, 1, 0, PAGE_SIZE), new_hits, "the new panel keeps its results as usual");
}

// ---------------------------------------------------------------------------
// AC-55-49 — (6) ソース走査: search_in_folder が begin の返り値を持ち回り、
//                is_current_at / store_at を使う(acceptance_req55e.rs の AC-55-42 と同じ流儀)
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

/// `call`(例 `.begin(`)を含む文の、文頭から呼び出しまでの部分(直前の `;` / `{` / `}` の後ろから)。
fn statement_head_before<'a>(body: &'a str, call: &str) -> &'a str {
    let idx = body
        .find(call)
        .unwrap_or_else(|| panic!("search_in_folder must call {call}"));
    let start = body[..idx]
        .rfind(|c: char| c == ';' || c == '{' || c == '}')
        .map(|i| i + 1)
        .unwrap_or(0);
    &body[start..idx]
}

/// `let [mut] <name>[: T] = ...` の `<name>` を取り出す。`let` で始まらなければ None。
fn let_binding_name(statement_head: &str) -> Option<String> {
    let rest = statement_head.trim_start().strip_prefix("let ")?.trim_start();
    let rest = rest.strip_prefix("mut ").unwrap_or(rest).trim_start();
    let name: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    (!name.is_empty()).then_some(name)
}

/// `search_in_folder` が `begin(` の返り値を受ける変数名。受けていなければ panic。
fn epoch_binding(body: &str) -> String {
    let head = statement_head_before(body, ".begin(");
    let_binding_name(head).unwrap_or_else(|| {
        panic!("the return value of begin must be bound with `let <epoch> = ...begin(...)`, found: `{head}`")
    })
}

/// `start` から始まる文を、括弧の対応を見ながら深さ 0 の `;` まで切り出す。
fn statement_from(body: &str, start: usize) -> &str {
    let mut depth = 0i32;
    for (offset, ch) in body[start..].char_indices() {
        match ch {
            '{' | '(' | '[' => depth += 1,
            '}' | ')' | ']' => depth -= 1,
            ';' if depth == 0 => return &body[start..start + offset + 1],
            _ => {}
        }
    }
    panic!("the statement starting at {start} must end with ';'")
}

/// `let [mut] <name> = ...;` の文(クロージャの本体を含む)。
fn let_statement<'a>(body: &'a str, name: &str) -> &'a str {
    let start = [format!("let mut {name}"), format!("let {name}")]
        .iter()
        .filter_map(|needle| {
            body.match_indices(needle.as_str())
                .find(|(i, _)| {
                    body[i + needle.len()..]
                        .chars()
                        .next()
                        .is_some_and(|c| c == ' ' || c == ':' || c == '=')
                })
                .map(|(i, _)| i)
        })
        .next()
        .unwrap_or_else(|| panic!("search_in_folder must bind `{name}` with let"));
    statement_from(body, start)
}

/// `call`(例 `.is_current_at(`)の各呼び出しの引数リスト(対応する `)` まで)。
fn call_args<'a>(body: &'a str, call: &str) -> Vec<&'a str> {
    body.match_indices(call)
        .map(|(i, _)| {
            let start = i + call.len();
            let mut depth = 1i32;
            for (offset, ch) in body[start..].char_indices() {
                match ch {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            return &body[start..start + offset];
                        }
                    }
                    _ => {}
                }
            }
            panic!("the call {call} must close")
        })
        .collect()
}

fn has_ident(text: &str, ident: &str) -> bool {
    text.split(|c: char| !(c.is_alphanumeric() || c == '_')).any(|token| token == ident)
}

/// 9. `search_in_folder` は `begin(` を 1 回呼び、その返り値を `let` で変数に受ける。
#[test]
fn search_in_folder_keeps_the_epoch_returned_by_begin() {
    let code = search_command_code();
    let (_, body) = function_parts(&code, "search_in_folder");
    assert_eq!(body.matches(".begin(").count(), 1, "search_in_folder begins exactly once (d-3)");
    let epoch = epoch_binding(body);
    assert_ne!(epoch, "_", "the epoch must be kept in a named variable, not discarded with `let _`");
}

/// 10. 進捗の sink と `cancel` の判定はどちらも `is_current_at(` で、`begin` で受けた epoch を渡す。
///     epoch 無しの `.is_current(` は直接呼ばない。
#[test]
fn search_in_folder_checks_is_current_at_in_both_sink_and_cancel() {
    let code = search_command_code();
    let (_, body) = function_parts(&code, "search_in_folder");
    let epoch = epoch_binding(body);

    let sink = let_statement(body, "sink");
    assert!(sink.contains(".is_current_at("), "the progress sink must check is_current_at: {sink}");
    let cancel = let_statement(body, "cancel");
    assert!(cancel.contains(".is_current_at("), "the cancel poll must check is_current_at: {cancel}");

    let calls = call_args(body, ".is_current_at(");
    assert!(calls.len() >= 2, "is_current_at is called in both the sink and cancel");
    for args in calls {
        assert!(has_ident(args, &epoch), "is_current_at must receive the epoch `{epoch}`: ({args})");
        assert!(has_ident(args, "generation"), "is_current_at must receive the generation: ({args})");
    }
    assert!(!body.contains(".is_current("), "the epoch-less is_current must not be called directly");
}

/// 11. 走査の後の保持は `store_at(` で、`begin` で受けた epoch を渡す。epoch 無しの `.store(` は
///     直接呼ばない。`forget` も呼ばない(reset は別 command=f-4)。
#[test]
fn search_in_folder_stores_with_store_at_after_the_scan() {
    let code = search_command_code();
    let (_, body) = function_parts(&code, "search_in_folder");
    let epoch = epoch_binding(body);

    let scan_at = body
        .find("search_in_folder_streaming(")
        .expect("search_in_folder runs the streaming scan");
    let store_at = body.find(".store_at(").expect("search_in_folder must keep results with store_at");
    assert!(store_at > scan_at, "store_at comes after the scan finished");

    let calls = call_args(body, ".store_at(");
    assert_eq!(calls.len(), 1, "results are kept once, at the end");
    for args in calls {
        assert!(has_ident(args, &epoch), "store_at must receive the epoch `{epoch}`: ({args})");
        assert!(has_ident(args, "generation"), "store_at must receive the generation: ({args})");
    }
    assert!(!body.contains(".store("), "the epoch-less store must not be called directly");
    assert!(!body.contains(".forget("), "search_in_folder itself must not forget (reset is its own command)");
}

/// 12. f-4 不変: `search_in_folder_reset` は引数も中身(`.forget(`)も変わらない。
#[test]
fn search_in_folder_reset_is_unchanged() {
    let code = search_command_code();
    let (params, body) = function_parts(&code, "search_in_folder_reset");
    assert!(params.contains("Window"), "reset still takes the window handle: {params}");
    assert!(params.contains("SearchResults"), "reset still takes the managed state: {params}");
    assert!(body.contains(".forget("), "reset still calls ResultStore::forget: {body}");
    assert!(!body.contains(".begin("), "reset must not start a generation");
}
