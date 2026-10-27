//! 要件#55 追補g の受け入れテスト(docs/requirements/req-55.md「追補g 語を空にしたとき・パネルを
//! 閉じたときも古い走査を止める」= Issue #580 / backlog 210)— Rust 側(AC-55-51〜52)
//!
//! 発端: 追補d の d-3 は「古い世代」だけを打ち切る。`ResultStore.latest` は新しい検索が来たときだけ
//! 進むので、語を消す・パネルを閉じると、走っている走査は最後まで走る(ssh で数分かかる走査が
//! 接続を圧迫したまま残る)。直し= 追補e の `search_in_folder_reset`(`forget`=結果と最新世代を
//! 捨て、`epoch` を進める)を、フロントが語を空にしたときとパネルを閉じたときにも呼ぶ
//! (AC-55-50・`src/components/FindInFolder.stop.wiring.test.ts`)。Rust 側は無改変: `forget` で
//! `epoch` が変わるので、走っている走査は次のファイルの区切りで止まる(追補f f-3 の
//! `is_current_at`)。本ファイルはその筋書きを「空にする・閉じる」の名前で固定する。
//!
//! 判定範囲(req-55.md 追補g の受け入れ基準 (2)(3)。(1) はフロント・(4)=既存の AC-55 系が
//! 無改変で緑、は test-runner のフルスイートで見る):
//! - AC-55-51 (2) `ResultStore`: 走査中(`begin` 済み・`store_at` 前)に `forget` すると、その走査の
//!   `epoch` での `is_current_at` が偽になる(=次の区切りで止まる)。語を空にした(次の `begin` は
//!   来ない)・空にしてから打ち直した(同じパネルで世代が進む)・パネルを閉じて開き直した
//!   (世代 1 から `begin`)のどれでも同じ。遅れて着いた古い走査の `store_at` は保持しない。
//!   窓 A の `forget` は窓 B の走査を止めない(reset は呼んだ窓のラベルに効く)
//! - AC-55-52 (3) ソース走査: `lib.rs` の `on_window_event` の `WindowEvent::Destroyed` 分岐が
//!   `SearchResults` の `ResultStore::forget` を窓のラベルで呼ぶ(g-3・今のまま・固定)
//!
//! ## 契約(g-4 不変)
//!
//! `ResultStore` の API(`begin` / `is_current` / `is_current_at` / `store` / `store_at` / `page` /
//! `forget`)・世代の規則・イベント名と payload・`search_in_folder_reset` の引数は追補a/d/e/f で
//! 確定済みのまま。command は増えない。本ファイルは現状の実装で緑(固定が目的)。赤の源は
//! AC-55-50(フロントの配線)。

use vellis_lib::search::{ResultStore, SearchHit, PAGE_SIZE};

const LABEL: &str = "main";
const OTHER: &str = "second";

fn hit(path: &str, line: u32, ordinal: u32) -> SearchHit {
    SearchHit {
        path: path.to_string(),
        line,
        text: format!("alpha {line}"),
        ordinal,
        matched: None,
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

/// パネルで 2 回検索し終え、3 回目(世代 3)の走査中の窓を再現する。走査中の世代 3 が `begin` で
/// 得た epoch を返す。
fn two_done_third_running(store: &mut ResultStore, label: &str) -> u64 {
    store.begin(label, 1);
    store.store(label, 1, few("g1"));
    store.begin(label, 2);
    store.store(label, 2, few("g2"));
    store.begin(label, 3)
}

// ---------------------------------------------------------------------------
// AC-55-51 — (2) 走査中に forget すると、その走査の epoch での is_current_at が偽になる
// ---------------------------------------------------------------------------

/// 1. 語を空にした: 世代 3 の走査中に `forget`(= 空にしたときの `search_in_folder_reset`)。
///    空文字は検索を投げないので次の `begin` は来ないが、走っている走査は次の区切りで止まる。
///    保持していた結果も捨てられ、遅れて着いた古い走査の `store_at` は保持しない。
#[test]
fn clearing_the_query_stales_the_running_scan() {
    let mut store = ResultStore::new();
    let e = two_done_third_running(&mut store, LABEL);
    assert!(store.is_current_at(LABEL, e, 3), "precondition: the scan is current while the query is typed");
    assert_eq!(store.page(LABEL, 2, 0, PAGE_SIZE), few("g2"), "precondition: generation 2 is kept");

    // The front end cleared the query → search_in_folder_reset → forget.
    store.forget(LABEL);

    assert!(!store.is_current_at(LABEL, e, 3), "the running scan must stop at its next file boundary");
    // 対照: epoch 無しの is_current だけでは止められない(latest が消えて真のまま)= f-4 不変。
    assert!(store.is_current(LABEL, 3), "is_current alone still says yes (that is why the epoch exists)");
    assert!(store.page(LABEL, 2, 0, PAGE_SIZE).is_empty(), "an empty query keeps no results to Show more");

    let late = more("late");
    let response = store.store_at(LABEL, e, 3, late.clone());
    assert_eq!(response.generation, 3, "the response still carries the scan's generation");
    assert_eq!(response.total, late.len(), "the response is built from its own hits (the front end drops it)");
    assert_eq!(response.files, 3);
    assert!(store.page(LABEL, 3, 0, PAGE_SIZE).is_empty(), "nothing is kept under the stale epoch");
}

/// 2. 空にしてから打ち直した: 同じパネルなので世代は 1 から振り直さず進む(4)。`forget` の後の
///    `begin(4)` は新しい epoch を返し、古い走査(3)は偽・新しい走査(4)は真。遅れて着いた
///    古い走査の `store_at` は新しい走査の保持を上書きしない(順序を問わず)。
#[test]
fn typing_again_after_clearing_runs_the_new_scan_under_a_new_epoch() {
    let mut store = ResultStore::new();
    let e0 = two_done_third_running(&mut store, LABEL);

    store.forget(LABEL);
    let e1 = store.begin(LABEL, 4);

    assert_ne!(e1, e0, "clearing hands the next search a different epoch");
    assert!(!store.is_current_at(LABEL, e0, 3), "the scan from before the clear is stale");
    assert!(store.is_current_at(LABEL, e1, 4), "the new scan is current");

    // Old scan finishes first, then the new one.
    let old = more("old");
    let new = few("new");
    store.store_at(LABEL, e0, 3, old.clone());
    assert!(store.page(LABEL, 3, 0, PAGE_SIZE).is_empty(), "the stale scan keeps nothing");
    let response = store.store_at(LABEL, e1, 4, new.clone());
    assert_eq!(response.generation, 4);
    assert_eq!(response.total, new.len());
    assert_eq!(store.page(LABEL, 4, 0, PAGE_SIZE), new, "the new scan's results are kept");
    assert!(store.page(LABEL, 3, 0, PAGE_SIZE).is_empty());

    // New scan finishes first, then the old one arrives late: still the new one is kept.
    let mut store = ResultStore::new();
    let e0 = two_done_third_running(&mut store, LABEL);
    store.forget(LABEL);
    let e1 = store.begin(LABEL, 4);
    store.store_at(LABEL, e1, 4, new.clone());
    store.store_at(LABEL, e0, 3, old);
    assert_eq!(store.page(LABEL, 4, 0, PAGE_SIZE), new, "a late stale store_at does not replace the kept results");
    assert!(store.page(LABEL, 3, 0, PAGE_SIZE).is_empty());
}

/// 3. パネルを閉じた: 世代 3 の走査中に `forget`(= `onDestroy` の `search_in_folder_reset`)。
///    古い走査は偽のまま・保持も捨てる。開き直す(マウント時の reset でもう 1 回 `forget`・
///    世代 1 から `begin`)と、新しい走査は真・古い走査は偽のまま(追補f の (1) と同じ筋書き)。
#[test]
fn closing_the_panel_stales_the_running_scan() {
    let mut store = ResultStore::new();
    let e0 = two_done_third_running(&mut store, LABEL);
    assert!(store.is_current_at(LABEL, e0, 3), "precondition: the scan is current while the panel is open");

    // Close → onDestroy → search_in_folder_reset → forget.
    store.forget(LABEL);
    assert!(!store.is_current_at(LABEL, e0, 3), "the scan must stop once the panel is gone");
    assert!(store.page(LABEL, 2, 0, PAGE_SIZE).is_empty(), "the closed panel's results are dropped");

    // Reopen → mount-time reset (追補e) → forget again, then generation 1 begins.
    store.forget(LABEL);
    let e1 = store.begin(LABEL, 1);
    assert_ne!(e1, e0);
    assert!(!store.is_current_at(LABEL, e0, 3), "still stale after the reopen");
    assert!(store.is_current_at(LABEL, e1, 1), "the reopened panel's generation 1 is current");

    let old = more("old");
    let new = few("new");
    store.store_at(LABEL, e0, 3, old);
    store.store_at(LABEL, e1, 1, new.clone());
    assert_eq!(store.page(LABEL, 1, 0, PAGE_SIZE), new, "the reopened panel keeps its results");
    assert!(store.page(LABEL, 3, 0, PAGE_SIZE).is_empty());
}

/// 4. 窓ごと: 窓 A のパネルで語を空にした・閉じた(A の `forget`)でも、窓 B の走査は止まらない
///    (reset は呼んだ窓のラベルに効く=`search_in_folder_reset` の引数は不変)。
#[test]
fn resetting_one_window_does_not_stop_the_other_windows_scan() {
    let mut store = ResultStore::new();
    let ea = two_done_third_running(&mut store, LABEL);
    let eb = two_done_third_running(&mut store, OTHER);

    store.forget(LABEL);

    assert!(!store.is_current_at(LABEL, ea, 3), "window A's scan stops");
    assert!(store.is_current_at(OTHER, eb, 3), "window B's scan keeps running");
    let b_hits = few("b3");
    store.store_at(OTHER, eb, 3, b_hits.clone());
    assert_eq!(store.page(OTHER, 3, 0, PAGE_SIZE), b_hits, "window B's results are kept");
}

// ---------------------------------------------------------------------------
// AC-55-52 — (3) ソース走査: lib.rs の WindowEvent::Destroyed が forget( を呼ぶ(g-3・固定)
//                (acceptance_req38f.rs の on_window_event 走査と同じ流儀)
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

/// `from` 以降で最初に現れる `{` から、対応する `}` までを切り出す。
fn balanced_block(code: &str, from: usize) -> &str {
    let open = code[from..].find('{').expect("block must open") + from;
    let mut depth = 0usize;
    for (offset, ch) in code[open..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &code[open..open + offset + ch.len_utf8()];
                }
            }
            _ => {}
        }
    }
    panic!("block must close")
}

/// `needle` の各出現の直後に続くブロック(`{ … }`)。
fn blocks_after<'a>(code: &'a str, needle: &str) -> Vec<&'a str> {
    code.match_indices(needle)
        .map(|(i, _)| balanced_block(code, i + needle.len()))
        .collect()
}

/// `.on_window_event(` に渡すクロージャの本体。
fn on_window_event_body(code: &str) -> &str {
    let at = code
        .find(".on_window_event(")
        .expect("lib.rs installs an on_window_event handler");
    balanced_block(code, at)
}

/// 5. g-3: `on_window_event` の `WindowEvent::Destroyed` 分岐で `SearchResults`(managed state)の
///    `ResultStore::forget` を窓のラベルで呼ぶ(窓を閉じたら走査は止まる=今のまま・固定)。
#[test]
fn window_destroy_forgets_the_search_results() {
    let code = lib_rs_code();
    let closure = on_window_event_body(&code);
    let destroyed_blocks = blocks_after(closure, "WindowEvent::Destroyed");
    assert!(
        !destroyed_blocks.is_empty(),
        "on_window_event must handle WindowEvent::Destroyed: {closure}"
    );
    assert!(
        destroyed_blocks
            .iter()
            .any(|b| b.contains("SearchResults") && b.contains(".forget(") && b.contains("label()")),
        "a WindowEvent::Destroyed branch must call ResultStore::forget on SearchResults for the window's label: {closure}"
    );
}
