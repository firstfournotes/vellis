//! 要件#14 追補b(2026-10-25・Issue #393)の受け入れテスト — Rust 層(AC-14-追b (a)(b) と (d) の一部)。
//! 正本: docs/requirements/req-14.md「追補b」。
//!
//! 「更新を確かめた後に開いた窓には、更新のバナーが出ない」―― `check_once` は新版を見つけると
//! 全窓へ `update_available` を 1 回 emit するだけで結果を持たず、Tauri の event は貯まらない。
//! 追補b は、見つけた payload をプロセスのメモリに**覚え**、窓が listen を登録し終えて
//! `update_banner_ready`(payload=窓の label)を emit してきたら、覚えがあればその窓だけへ
//! `emit_to` で `update_available` を送り直す。
//!
//! ## AC 対応表
//! - (a) 単体: 覚えの口=覚える → 読める・`None` で消す → 読めない・上書きで新しいほう
//!   (`remember_update_roundtrip_in_one_test` ― static を使うので 1 つの test にまとめる)
//! - (b) ソース走査(`update_check.rs`・`lib.rs`):
//!   - `check_once` は `is_newer` が偽の経路で覚えを消し、新版の経路では **emit の前に**覚える
//!     (`check_once_remembers_before_emit_and_forgets_when_not_newer`)
//!   - `setup` から届く範囲で `update_banner_ready` を listen し、覚えがあれば `emit_to(` で
//!     `update_available` を送る(`setup_listens_banner_ready_and_replays_with_emit_to`)
//! - (d) の一部: Tauri command は足さない(`no_tauri_command_is_added_for_the_banner`)。
//!   command の一覧と数そのものは AC-60-20・`acceptance_req66.rs` 41 が固定する(無改変)
//! - 不変: `UPDATE_AVAILABLE_EVENT` の名前・全窓への `app.emit(`・6 時間・起動の 5 秒
//!   (`invariants_of_the_automatic_check_are_kept`)
//!
//! ## 確定契約(implementer はこれに従う。実装先: src-tauri/src/update_check.rs・lib.rs)
//!
//! ```ignore
//! // --- src-tauri/src/update_check.rs ---
//!
//! /// 窓が `update_available` の listen を登録し終えたことを知らせる event。
//! /// payload は窓の label(フロントは `emit(UPDATE_BANNER_READY_EVENT, label)`)。
//! /// フロント側の定数と同じ綴り(`src/routes/+page.svelte` 側の走査が値を固定する)。
//! pub const UPDATE_BANNER_READY_EVENT: &str = "update_banner_ready";
//!
//! /// 既存の private struct を pub に(テストから組み立てて比較する)。`Serialize` は既存のまま。
//! #[derive(Clone, Debug, PartialEq, Eq, Serialize)]
//! pub struct UpdateAvailablePayload {
//!     pub version: String,
//!     pub url: String,
//! }
//!
//! /// 新版の payload をプロセスのメモリに覚える(`None` で消す)。純関数で試せる小さな口。
//! pub fn remember_update(payload: Option<UpdateAvailablePayload>);
//!
//! /// 覚えている payload の写し(無ければ `None`)。
//! pub fn remembered_update() -> Option<UpdateAvailablePayload>;
//!
//! // `check_once`(private のまま):
//! //   - `if !is_newer(..)` の中(= 新版が無い経路)で `remember_update(None)` を呼ぶ
//! //   - 新版の経路では `remember_update(Some(..))` を `app.emit(UPDATE_AVAILABLE_EVENT, ..)` の**前**に呼ぶ
//! //
//! // 起動時(lib.rs の `.setup(move |app| { .. })`)に `UPDATE_BANNER_READY_EVENT` を listen する。
//! // setup の中に直接書いても、`update_check::<fn>(app.handle()..)` の形で update_check.rs の
//! // 関数に切り出してもよい(走査はその 1 段を辿る)。handler は event の `payload()` から
//! // label を取り、`remembered_update()` が `Some` なら `emit_to(label, UPDATE_AVAILABLE_EVENT, payload)`。
//! // 覚えが無ければ何もしない。Tauri command は足さない(`#[tauri::command]` を update_check.rs に
//! // 書かない・`generate_handler!` の一覧を変えない)。
//! ```
//!
//! ## 実装前の見込み(赤の理由)
//! `UPDATE_BANNER_READY_EVENT` / `remember_update` / `remembered_update` が無く、
//! `UpdateAvailablePayload` が private ―― 本ファイルはコンパイルで止まる(= 赤)。
//! 走査の 3 件も、`check_once` に `remember_update(` が無い・setup に banner_ready の listen も
//! `emit_to(` も無いので、口だけ足した段階でも赤のまま。`no_tauri_command_is_added_for_the_banner` と
//! `invariants_of_the_automatic_check_are_kept` は実装前から緑(不変の確認)。

use vellis_lib::update_check::{
    remember_update, remembered_update, UpdateAvailablePayload, CHECK_INTERVAL_SECS,
    UPDATE_AVAILABLE_EVENT, UPDATE_BANNER_READY_EVENT,
};

// ---------------------------------------------------------------------------
// ソース(コメントを落とした本文)
// ---------------------------------------------------------------------------

/// 行ごとに `//` 以降(コメント)を落としたコード部分を連結して返す。`://` は落とさない
/// (acceptance_req67 の写し)。
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

fn update_check_code() -> String {
    strip_line_comments(include_str!("../src/update_check.rs"))
}

fn lib_rs_code() -> String {
    strip_line_comments(include_str!("../src/lib.rs"))
}

/// `open` の位置(`(` か `{`)から対応する閉じ括弧までの中身(括弧の種類は混ぜて数える)。
fn balanced_body(code: &str, open: usize) -> &str {
    let mut depth = 0usize;
    for (i, c) in code[open..].char_indices() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => {
                depth -= 1;
                if depth == 0 {
                    return &code[open + 1..open + i];
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced bracket starting at byte {open}");
}

/// `start` から最初の `(` に対応する閉じ括弧までの呼び出し全体(acceptance_req67 の写し)。
fn balanced_call(code: &str, start: usize) -> &str {
    let open = code[start..].find('(').expect("call must have '('") + start;
    let body = balanced_body(code, open);
    &code[start..open + body.len() + 2]
}

/// `fn <name>` の本体(`{ .. }` の中身)。無ければ None。
fn fn_body<'a>(code: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("fn {name}");
    let mut search = 0;
    while let Some(rel) = code[search..].find(&needle) {
        let at = search + rel;
        let after = at + needle.len();
        // `fn check_once_x` を `fn check_once` と取り違えない。
        let next = code[after..].chars().next().unwrap_or(' ');
        if next == '(' || next == '<' || next.is_whitespace() {
            let open = code[after..].find('{').expect("fn must have a body") + after;
            return Some(balanced_body(code, open));
        }
        search = after;
    }
    None
}

/// lib.rs の `.setup(move |app| { .. })` の本体。
fn setup_body(lib: &str) -> &str {
    let at = lib
        .find(".setup(")
        .expect("lib.rs must build the app with .setup(..)");
    let open = lib[at..].find('{').expect("setup closure must have a body") + at;
    balanced_body(lib, open)
}

/// `code` の中の `.listen(` / `listen_any(` の呼び出し全体を全部。
fn listen_calls(code: &str) -> Vec<&str> {
    let mut out = Vec::new();
    for needle in [".listen(", ".listen_any(", ".once("] {
        let mut search = 0;
        while let Some(rel) = code[search..].find(needle) {
            let start = search + rel;
            out.push(balanced_call(code, start));
            search = start + needle.len();
        }
    }
    out
}

/// `code` から呼ばれている `update_check::<name>(` の `<name>` を全部。
fn update_check_calls(code: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut search = 0;
    while let Some(rel) = code[search..].find("update_check::") {
        let at = search + rel + "update_check::".len();
        let name: String = code[at..]
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        if !name.is_empty() && code[at + name.len()..].trim_start().starts_with('(') {
            out.push(name);
        }
        search = at;
    }
    out
}

/// 走査で「覚えの再送の配線」とみなす本文: setup の本体そのものと、setup から呼ばれる
/// `update_check::<fn>` の本体(1 段)。さらにそれぞれの中から呼ばれる update_check.rs の
/// 関数の本体(もう 1 段=handler を関数に切り出す形)も足す。
fn banner_wiring_reach(lib: &str, uc: &str) -> Vec<String> {
    let setup = setup_body(lib);
    let mut reach: Vec<String> = vec![setup.to_string()];
    for name in update_check_calls(setup) {
        if let Some(body) = fn_body(uc, &name) {
            reach.push(body.to_string());
        }
    }
    // handler を関数に切り出した形: 本文の中で呼ばれている update_check.rs の fn を 1 段足す。
    let mut extra = Vec::new();
    for body in &reach {
        for name in fn_names(uc) {
            let call = format!("{name}(");
            if body.contains(&call) && !reach.iter().any(|b| fn_body(uc, &name) == Some(b.as_str())) {
                if let Some(fb) = fn_body(uc, &name) {
                    extra.push(fb.to_string());
                }
            }
        }
    }
    reach.extend(extra);
    reach
}

/// update_check.rs の全 `fn` 名。
fn fn_names(uc: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut search = 0;
    while let Some(rel) = uc[search..].find("fn ") {
        let at = search + rel + 3;
        let name: String = uc[at..]
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        if !name.is_empty() {
            out.push(name);
        }
        search = at;
    }
    out
}

fn payload(version: &str, url: &str) -> UpdateAvailablePayload {
    UpdateAvailablePayload {
        version: version.to_string(),
        url: url.to_string(),
    }
}

// ---------------------------------------------------------------------------
// AC-14-追b (a) — 覚えの口(単体)
// ---------------------------------------------------------------------------

/// (a) 覚える → 読める・`None` で消す → 読めない・上書きで新しいほう。
///     プロセス全体の覚え(static)を使うので、順序の干渉を避けるため 1 つの test にまとめる。
#[test]
fn remember_update_roundtrip_in_one_test() {
    // 起点を揃える(ほかのテストが同じ static を触らないよう本ファイルはこれ 1 件だけが書く)。
    remember_update(None);
    assert_eq!(remembered_update(), None, "消した直後は読めない");

    let first = payload("0.5.0", "https://github.com/firstfournotes/vellis/releases/tag/v0.5.0");
    remember_update(Some(first.clone()));
    assert_eq!(remembered_update(), Some(first.clone()), "覚えたものがそのまま読める");
    assert_eq!(
        remembered_update(),
        Some(first.clone()),
        "読み出しは写し(読んでも消えない=何枚の窓が問い合わせても同じ答え)"
    );

    let second = payload("0.6.0", "https://github.com/firstfournotes/vellis/releases/tag/v0.6.0");
    remember_update(Some(second.clone()));
    assert_eq!(remembered_update(), Some(second), "上書きは新しいほう");
    assert_ne!(remembered_update(), Some(first), "古いほうは残らない");

    remember_update(None);
    assert_eq!(remembered_update(), None, "`None` で消える(取り下げられたリリースを新しい窓に出さない)");
    assert_eq!(remembered_update(), None, "消えたままである");
}

/// (a) 補助: event 名はフロントの定数と同じ綴りで固定(フロント側は +page.svelte の走査が見る)。
#[test]
fn banner_ready_event_name_is_fixed() {
    assert_eq!(UPDATE_BANNER_READY_EVENT, "update_banner_ready");
    assert_ne!(
        UPDATE_BANNER_READY_EVENT, UPDATE_AVAILABLE_EVENT,
        "問い合わせの event と告知の event は別の名前"
    );
}

// ---------------------------------------------------------------------------
// AC-14-追b (b) — ソース走査: check_once の覚えと消し
// ---------------------------------------------------------------------------

/// (b) `check_once` は、`is_newer` が偽の経路で覚えを消し、新版の経路では **emit の前に**覚える。
#[test]
fn check_once_remembers_before_emit_and_forgets_when_not_newer() {
    let uc = update_check_code();
    let body = fn_body(&uc, "check_once").expect("update_check.rs must keep `fn check_once`");

    // --- 新版が無い経路: `if !is_newer(..) { .. }` の中で `remember_update(None)` ---
    let not_newer_at = body
        .find("if !is_newer(")
        .expect("check_once must branch on `if !is_newer(..)` (不変)");
    let not_newer_open = body[not_newer_at..].find('{').expect("if must have a block") + not_newer_at;
    let not_newer_block = balanced_body(body, not_newer_open);
    assert!(
        not_newer_block.contains("remember_update(None)"),
        "the `!is_newer` branch must forget the remembered update with remember_update(None):\n{not_newer_block}"
    );
    // 消すだけで、この経路では emit しない(不変)。
    assert!(
        !not_newer_block.contains("emit"),
        "the `!is_newer` branch must not emit anything"
    );

    // --- 新版の経路: ブロックの後ろで `remember_update(Some(..))` が `app.emit(UPDATE_AVAILABLE_EVENT` より前 ---
    let after = &body[not_newer_open + not_newer_block.len() + 2..];
    let remember_at = after
        .find("remember_update(Some(")
        .expect("the newer path must call remember_update(Some(..)) after the !is_newer block");
    let emit_at = after
        .find(".emit(")
        .expect("the newer path must still emit to every window with app.emit(..) (不変)");
    let emit_call = balanced_call(after, emit_at);
    assert!(
        emit_call.contains("UPDATE_AVAILABLE_EVENT"),
        "the broadcast must stay `update_available`: {emit_call}"
    );
    assert!(
        remember_at < emit_at,
        "remember_update(Some(..)) must come before the emit (a window that asks between the two must still get the answer)"
    );
    // 覚える前に消していない(新版の経路で `None` を書かない)。
    assert!(
        !after.contains("remember_update(None)"),
        "the newer path must not forget the update"
    );
    // 全窓への配信は `emit`(`emit_to` ではない)のまま(不変)。
    assert!(
        !emit_call.contains("emit_to("),
        "check_once must broadcast with emit, not emit_to"
    );
}

// ---------------------------------------------------------------------------
// AC-14-追b (b) — ソース走査: setup の listen と emit_to
// ---------------------------------------------------------------------------

/// (b) `setup` から届く範囲(setup の本体か、そこから呼ぶ update_check.rs の関数)で
///     `UPDATE_BANNER_READY_EVENT` を listen し、handler は `remembered_update()` を読み、
///     `Some` なら `emit_to(` で `UPDATE_AVAILABLE_EVENT` を送る。label は event の payload から。
#[test]
fn setup_listens_banner_ready_and_replays_with_emit_to() {
    let lib = lib_rs_code();
    let uc = update_check_code();
    let reach = banner_wiring_reach(&lib, &uc);

    // 1. listen の呼び出しのうち、引数に UPDATE_BANNER_READY_EVENT を持つものがちょうど 1 つ。
    let listens: Vec<&str> = reach
        .iter()
        .flat_map(|body| listen_calls(body))
        .filter(|call| call.contains("UPDATE_BANNER_READY_EVENT"))
        .collect();
    assert_eq!(
        listens.len(),
        1,
        "exactly one listen(UPDATE_BANNER_READY_EVENT, ..) reachable from setup (found {}):\n{:#?}",
        listens.len(),
        listens
    );
    let listen = listens[0];
    // `.once(` では 2 枚目以降の窓に答えられない。
    assert!(
        !listen.starts_with(".once("),
        "the banner_ready listener must stay registered for every later window (not .once)"
    );

    // 2. handler(listen の中の closure か、そこから呼ぶ関数)が覚えを読み、emit_to で送る。
    let mut handler_code = listen.to_string();
    for name in fn_names(&uc) {
        if listen.contains(&format!("{name}(")) {
            if let Some(body) = fn_body(&uc, &name) {
                handler_code.push_str(body);
            }
        }
    }
    assert!(
        handler_code.contains("remembered_update()"),
        "the handler must read remembered_update():\n{handler_code}"
    );
    let emit_to_at = handler_code
        .find("emit_to(")
        .unwrap_or_else(|| panic!("the handler must answer with emit_to(..):\n{handler_code}"));
    let emit_to = balanced_call(&handler_code, emit_to_at);
    assert!(
        emit_to.contains("UPDATE_AVAILABLE_EVENT"),
        "emit_to must send `update_available` to the asking window: {emit_to}"
    );
    assert!(
        handler_code.contains("payload()"),
        "the handler must take the window label from the event payload (event.payload()):\n{handler_code}"
    );
    // 覚えが無ければ何もしない: 送るのは `Some` の中だけ(`if let Some` / `match` / `.map`)。
    assert!(
        handler_code.contains("Some(") || handler_code.contains("if let") || handler_code.contains("match "),
        "emit_to must be guarded by the remembered Some(..):\n{handler_code}"
    );

    // 3. 自動の確かめ(spawn_poller)の dev ゲートとは独立に、setup から直接届く
    //    (listen が `check_once` の中や STARTUP_DELAY の後ろに埋まっていない)。
    let in_check_once = fn_body(&uc, "check_once")
        .map(|b| b.contains("UPDATE_BANNER_READY_EVENT"))
        .unwrap_or(false);
    assert!(!in_check_once, "the listener must not live inside check_once");
}

// ---------------------------------------------------------------------------
// AC-14-追b (d) の一部 — Tauri command は足さない
// ---------------------------------------------------------------------------

/// (d) command は足さない: update_check.rs に `#[tauri::command]` が無く、`generate_handler!` の
///     2 つの一覧に `update` を含む名前は `update_mark` だけ(覚えの口を command にしていない)。
///     一覧の本数そのものは `acceptance_req66.rs` 41 と AC-60-20 が固定する(無改変で緑=AC (d))。
#[test]
fn no_tauri_command_is_added_for_the_banner() {
    let uc = update_check_code();
    assert!(
        !uc.contains("#[tauri::command]"),
        "update_check.rs must not define a Tauri command (起案時判断 (a))"
    );

    let lib = lib_rs_code();
    let blocks: Vec<Vec<String>> = lib
        .match_indices("generate_handler![")
        .map(|(i, _)| {
            let start = i + "generate_handler![".len();
            let end = lib[start..].find(']').expect("handler list must close") + start;
            lib[start..end]
                .split(',')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.rsplit("::").next().unwrap().to_string())
                .collect()
        })
        .collect();
    assert_eq!(blocks.len(), 2, "lib.rs has the webdriver and the production handler lists");
    for names in &blocks {
        let suspicious: Vec<&str> = names
            .iter()
            .map(String::as_str)
            .filter(|n| {
                (n.contains("update") && *n != "update_mark")
                    || n.contains("banner")
                    || n.contains("remember")
            })
            .collect();
        assert!(
            suspicious.is_empty(),
            "no command for the update banner may be added: {suspicious:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// 不変(契約(追補b) 4)
// ---------------------------------------------------------------------------

/// 不変: 告知の event 名・6 時間の規則・起動の 5 秒の遅れ・全窓への `app.emit(`。
#[test]
fn invariants_of_the_automatic_check_are_kept() {
    assert_eq!(UPDATE_AVAILABLE_EVENT, "update_available");
    assert_eq!(CHECK_INTERVAL_SECS, 6 * 60 * 60);
    let uc = update_check_code();
    assert!(
        uc.contains("STARTUP_DELAY: Duration = Duration::from_secs(5)"),
        "the launch check keeps its 5-second delay"
    );
    let poller = fn_body(&uc, "spawn_poller").expect("spawn_poller stays");
    assert!(
        poller.contains("STARTUP_DELAY") && poller.contains("check_once("),
        "spawn_poller keeps the delayed first check"
    );
}
