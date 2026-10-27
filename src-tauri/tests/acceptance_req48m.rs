//! 要件#48 追補m の受け入れテスト(docs/requirements/req-48.md「追補m」= Issue #750)— Rust 層
//!
//! 「CLI の `vellis -r`(IPC の `SwitchRoot`)は、URI の解釈と一覧の取得の判定を先に済ませて
//!  CLI へ応答し、root の切り替えは窓の確認(`confirmDiscardEdits`)が true を返してから行う。
//!  backend は先に切り替えない。判定の失敗は今までどおり CLI へエラーで返す」を固定する。
//!
//! フロントの判断(確認 → 切り替えの依頼)は `src/lib/root-switch-request.acceptance.test.ts` と
//! `src/lib/root-switch-request.wiring.test.ts`。本ファイルは backend の順序と応答。
//! `dispatch_command` は `AppHandle` を要るので実行できない — 既存の家風(acceptance_req62 /
//! acceptance_req12b)どおり、行コメントを落としたソースから関数の本体を切り出して走査する。
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前・公開パス)
//!
//! 差し込み口は「backend は判定だけ済ませて前面の窓へ『切り替えの依頼』の事象を送り、窓が確認して
//! から既存の切り替え(`handle_switch_root`)を command で呼ぶ」。`set_root` を使い回さないのは、
//! (1) `acceptance_req62.rs` が `handle_switch_root` の本体に `set_title(` と `…tabbing_identifier(` が
//! あることを固定していて(AC-48-追m (f)= 既存テスト無改変)、`set_root` に寄せると
//! `handle_switch_root` が消えるか死んだコードになる、(2) `set_root` は履歴に記録する(`record_root`)が
//! 今の `vellis -r` は記録しないので契約2「結果は今と同じ」から外れる、の 2 点。
//!
//! ```ignore
//! // --- src-tauri/src/ipc/handler.rs ---
//!
//! /// 判定のあと前面の窓へ送る「切り替えの依頼」の事象名(フロントの ROOT_SWITCH_REQUESTED_EVENT と同じ綴り)。
//! pub const ROOT_SWITCH_REQUESTED_EVENT: &str = "root_switch_requested";
//!
//! /// 依頼の payload。JSON は `{"root_uri": "<新しい root の URI>"}` だけ(フィールドはこれ 1 つ)。
//! #[derive(Clone, Debug, serde::Serialize)]
//! pub struct RootSwitchRequestPayload { pub root_uri: String }
//!
//! /// `Request::SwitchRoot` の新しい受け口(契約3・4)。
//! /// 1. `Uri::parse` → 失敗は `Response::Error { code: "INVALID_URI" }`
//! /// 2. `fs_registry.resolve` → 失敗は `"PROVIDER_ERROR"`
//! /// 3. `provider.list(&new_root).await` → 失敗は `"LIST_ERROR"`(一覧は判定にだけ使い、捨ててよい)
//! /// 4. `wm.active_label()` が無ければ `"NO_ACTIVE_WINDOW"`
//! /// 5. `app.emit_to(&active_label, ROOT_SWITCH_REQUESTED_EVENT, &RootSwitchRequestPayload { root_uri })`
//! /// 6. `Response::Ok` を返す — 窓の答えは待たない(oneshot・recv・listen・once・sleep・timeout なし)
//! /// **root・監視(root_watch / dir_watches)・session・タイトル・タブのまとまり・`root_changed` には触らない**。
//! async fn handle_switch_root_request(app: &AppHandle, uri: &str) -> Response;
//!
//! // `dispatch_command` の `Request::SwitchRoot { uri }` の腕は `handle_switch_root_request(app, &uri).await`。
//! // `dispatch_command` の本体から `handle_switch_root(` の直接の呼び出しは無くなる。
//!
//! /// 切り替えの実体(今の本体のまま=契約2・5: 監視の付け替え・`set_title`・タブのまとまり・
//! /// `document_retained`・`root_changed` の emit・履歴に記録しない)。
//! /// 切り替える窓は**確認した窓**=呼び出し側が渡す `label`(前面の窓 `active_label()` を見ない —
//! /// ダイアログに答える間に別の窓が前面になっても、確認した窓が切り替わる)。
//! pub(crate) async fn handle_switch_root(app: &AppHandle, label: &str, uri: &str) -> Response;
//!
//! // --- 新しい command(置き場は commands/root.rs が自然。ソース走査は src-tauri/src/**/*.rs 全体から探す)---
//!
//! /// 窓の確認が true を返したあとにフロントが呼ぶ(`invoke('switch_root_confirmed', { uri })`)。
//! /// 本体で `handle_switch_root(window.app_handle(), window.label(), &uri)` を呼び、
//! /// `Response::Error { message, .. }` は `Err(message)` にして返す。戻り値は `Result<(), String>`
//! /// (結果は `root_changed` で窓へ届く。payload を二重に返さない)。
//! #[tauri::command]
//! pub async fn switch_root_confirmed(uri: String, window: Window, state: tauri::State<'_, AppState>) -> Result<(), String>;
//!
//! // --- src-tauri/src/lib.rs ---
//! // `tauri::generate_handler![ … ]` の両方の一覧(webdriver あり / なし)に `switch_root_confirmed` を足す。
//! ```
//!
//! ## 判定するもの
//! - **AC-48-追m (d)** `SwitchRoot` の受け口(`handle_switch_root_request`)の本体に root・監視・session・
//!   タイトル・タブ・`root_changed`・履歴の操作が無い。`dispatch_command` が `handle_switch_root(` を直接
//!   呼ばない
//! - **AC-48-追m (e)** 受け口に `INVALID_URI` / `PROVIDER_ERROR` / `LIST_ERROR`(と `NO_ACTIVE_WINDOW`)の
//!   `Response::Error` があり、いずれも依頼の `emit_to(` より前にある
//! - **契約4** 受け口が `emit_to(` で `ROOT_SWITCH_REQUESTED_EVENT` を前面の窓へ送って `Response::Ok` を返し、
//!   窓の答えを待つ道具を使っていない
//! - **契約2・5(不変)** `handle_switch_root` の本体は今と同じ要素(`set_title(`・`…tabbing_identifier(`・
//!   `subscribe_directory(`・`root_changed`・`document_retained`・`dir_watches.clear()`・`root_watch = None`)
//!   を持ち、`record_root(` は呼ばず、`active_label()` は見ない
//! - **配線** `switch_root_confirmed` command が `#[tauri::command]` 付きでちょうど 1 つあり、`window: Window`
//!   を受け、本体で `handle_switch_root(` と `window.label()` を使い、lib.rs の `generate_handler![` 全部に
//!   登録されている
//! - 事象名・payload の綴り(フロントと一致)・`Request::SwitchRoot` の JSON は不変
//!
//! ## 判定しないもの
//! - 実際に `vellis -r` を送って応答が返ること(AppHandle が要る)→ 既存の acceptance_req3d(応答の待ち)と
//!   人間ゲート。確認のダイアログの見え方 → 人間ゲート
//! - `handle_switch_root_request` が一覧を捨てるか使うか・ログの文言
//!
//! ## 実装前の見立て(赤の理由)
//! - `vellis_lib::ipc::handler::{ROOT_SWITCH_REQUESTED_EVENT, RootSwitchRequestPayload}` が無いので
//!   コンパイルで赤。走査でも: `handle_switch_root_request` が定義されていない(panic)・`dispatch_command`
//!   が `handle_switch_root(` を直接呼んでいる・`handle_switch_root` の本体が `active_label()` を見ている・
//!   `switch_root_confirmed` がどこにも無い、で赤
//! - 「不変」のケース(`handle_switch_root` の要素・`Request::SwitchRoot` の JSON)は実装前から通る内容
//!   (退行の守り)

use std::path::{Path, PathBuf};

use vellis_lib::ipc::handler::{RootSwitchRequestPayload, ROOT_SWITCH_REQUESTED_EVENT};
use vellis_lib::ipc::protocol::Request;

// ---------------------------------------------------------------------------
// ソース走査の道具(acceptance_req62.rs / acceptance_req12b.rs の写し)
// ---------------------------------------------------------------------------

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// 行コメント(`//`)を落とす。`://`(URI の中)は残す。
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

fn ipc_handler_rs_code() -> String {
    strip_line_comments(include_str!("../src/ipc/handler.rs"))
}

fn lib_rs_code() -> String {
    strip_line_comments(include_str!("../src/lib.rs"))
}

/// `src-tauri/src/**/*.rs` を再帰的に集める(相対パス・コメントを落としたソース)。
fn all_rust_sources() -> Vec<(String, String)> {
    fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, String)>) {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .unwrap_or_else(|e| panic!("cannot read {}: {}", dir.display(), e))
            .map(|e| e.expect("dir entry").path())
            .collect();
        entries.sort();
        for path in entries {
            if path.is_dir() {
                walk(&path, base, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                let rel = path
                    .strip_prefix(base)
                    .expect("under src")
                    .to_string_lossy()
                    .replace('\\', "/");
                let src = std::fs::read_to_string(&path)
                    .unwrap_or_else(|e| panic!("cannot read {}: {}", path.display(), e));
                out.push((rel, strip_line_comments(&src)));
            }
        }
    }
    let base = manifest_dir().join("src");
    let mut out = Vec::new();
    walk(&base, &base, &mut out);
    out
}

/// `open` の位置の開き括弧に対応する閉じ括弧の位置。
fn matching_close(code: &str, open: usize) -> usize {
    let mut depth = 0usize;
    for (i, c) in code[open..].char_indices() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => {
                depth -= 1;
                if depth == 0 {
                    return open + i;
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced bracket starting at byte {open}");
}

/// `fn <name>(` の定義の位置(無ければ None)。
fn fn_start(code: &str, name: &str) -> Option<usize> {
    code.find(&format!("fn {name}("))
}

/// `fn <name>(` の本体(`{` から対応する `}` まで)。
fn fn_body<'a>(code: &'a str, name: &str) -> &'a str {
    let start = fn_start(code, name)
        .unwrap_or_else(|| panic!("source must define `fn {name}(…`(確定契約を参照)"));
    let open = code[start..].find('{').expect("fn must have a body") + start;
    let close = matching_close(code, open);
    &code[open..=close]
}

/// `fn <name>(` の引数部分(`(` から対応する `)` まで)。
fn fn_signature<'a>(code: &'a str, name: &str) -> &'a str {
    let start = fn_start(code, name)
        .unwrap_or_else(|| panic!("source must define `fn {name}(…`(確定契約を参照)"));
    let open = code[start..].find('(').expect("fn must have '('") + start;
    let close = matching_close(code, open);
    &code[open..=close]
}

/// `start` から、最初の `(` に対応する閉じ括弧までの呼び出し全体。
fn balanced_call(code: &str, start: usize) -> &str {
    let open = code[start..].find('(').expect("call must have '('") + start;
    let close = matching_close(code, open);
    &code[start..=close]
}

/// `needle` が現れる位置をすべて返す。
fn positions(code: &str, needle: &str) -> Vec<usize> {
    code.match_indices(needle).map(|(i, _)| i).collect()
}

/// 空白を落とした比較用の文字列。
fn compact(code: &str) -> String {
    code.chars().filter(|c| !c.is_whitespace()).collect()
}

const REQUEST_HANDLER: &str = "handle_switch_root_request";
const SWITCH_FN: &str = "handle_switch_root";
const CONFIRMED_COMMAND: &str = "switch_root_confirmed";

// ---------------------------------------------------------------------------
// 綴り(フロントの root-switch-request.ts と一致)
// ---------------------------------------------------------------------------

/// 1. 依頼の事象名。
#[test]
fn root_switch_requested_event_name_is_fixed() {
    assert_eq!(ROOT_SWITCH_REQUESTED_EVENT, "root_switch_requested");
}

/// 2. 依頼の payload は `{"root_uri": …}` だけ。
#[test]
fn root_switch_request_payload_serializes_root_uri_only() {
    let payload = RootSwitchRequestPayload {
        root_uri: "file:///Users/a/other".into(),
    };
    let json = serde_json::to_string(&payload).unwrap();
    assert_eq!(json, r#"{"root_uri":"file:///Users/a/other"}"#);
}

/// 3. 不変: CLI が送る `SwitchRoot` の形は変わらない(`vellis -r` 側に手を入れない)。
#[test]
fn switch_root_request_json_is_unchanged() {
    let req = Request::SwitchRoot {
        uri: "file:///Users/a/other".into(),
    };
    let json = serde_json::to_string(&req).unwrap();
    assert_eq!(json, r#"{"type":"SwitchRoot","uri":"file:///Users/a/other"}"#);
    let parsed: Request = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, req);
}

// ---------------------------------------------------------------------------
// AC-48-追m (d) — backend は窓の確認の前に root を切り替えない
// ---------------------------------------------------------------------------

/// 4. `dispatch_command` の `SwitchRoot` の腕は依頼の受け口へ行き、切り替えの実体を直接は呼ばない。
#[test]
fn switch_root_dispatch_routes_to_the_request_handler_not_to_the_switch() {
    let code = ipc_handler_rs_code();
    let body = fn_body(&code, "dispatch_command");
    assert!(
        body.contains("Request::SwitchRoot"),
        "dispatch_command must still match Request::SwitchRoot"
    );
    assert!(
        body.contains(&format!("{REQUEST_HANDLER}(")),
        "dispatch_command must route Request::SwitchRoot to `{REQUEST_HANDLER}(`"
    );
    assert!(
        !body.contains(&format!("{SWITCH_FN}(")),
        "dispatch_command must not call `{SWITCH_FN}(` directly — the switch waits for the window's confirmation (契約3)"
    );
}

/// 5. 受け口の本体は root・監視・session・タイトル・タブ・`root_changed`・履歴に触らない。
///    切り替えの実体(`handle_switch_root(` / `set_root(`)を確認の前に呼ぶ近道も塞ぐ
///    (受け口の名前 `handle_switch_root_request(` は `(` の前が `_request` なので掛からない)。
#[test]
fn request_handler_does_not_switch_before_the_window_confirms() {
    let code = ipc_handler_rs_code();
    let body = fn_body(&code, REQUEST_HANDLER);
    for forbidden in [
        "handle_switch_root(",
        "set_root(",
        "root_uri = Some(",
        "root_watch",
        "dir_watches",
        "session.take(",
        "session = ",
        "subscribe_directory(",
        "set_title(",
        "tabbing_identifier(",
        "root_changed",
        "record_root(",
        "get_mut(",
    ] {
        assert!(
            !body.contains(forbidden),
            "`{REQUEST_HANDLER}` must not touch `{forbidden}` — the backend switches only after the window confirmed (契約3)"
        );
    }
}

// ---------------------------------------------------------------------------
// 契約4 — 依頼を前面の窓へ送って CLI へ応答する(確認を待たない)
// ---------------------------------------------------------------------------

/// 6. 受け口は `emit_to(` で `ROOT_SWITCH_REQUESTED_EVENT` を前面の窓へ送り、`Response::Ok` を返す。
#[test]
fn request_handler_emits_the_request_to_the_active_window_and_returns_ok() {
    let code = ipc_handler_rs_code();
    let body = fn_body(&code, REQUEST_HANDLER);
    assert!(
        body.contains("active_label()"),
        "`{REQUEST_HANDLER}` must address the active window (`active_label()`)"
    );
    let emits: Vec<&str> = positions(body, "emit_to(")
        .into_iter()
        .map(|i| balanced_call(body, i))
        .collect();
    assert_eq!(
        emits.len(),
        1,
        "`{REQUEST_HANDLER}` must emit exactly one event (the request); found {}",
        emits.len()
    );
    assert!(
        emits[0].contains("ROOT_SWITCH_REQUESTED_EVENT"),
        "the emit must name ROOT_SWITCH_REQUESTED_EVENT (not a bare literal): {}",
        emits[0]
    );
    assert!(
        body.contains("RootSwitchRequestPayload"),
        "`{REQUEST_HANDLER}` must send a RootSwitchRequestPayload"
    );
    assert!(
        body.contains("Response::Ok"),
        "`{REQUEST_HANDLER}` must answer the CLI with Response::Ok once the request is sent"
    );
}

/// 7. 受け口は窓の答えを待たない(待つ道具が本体に無い)。
#[test]
fn request_handler_does_not_wait_for_the_window() {
    let code = ipc_handler_rs_code();
    let body = fn_body(&code, REQUEST_HANDLER);
    for waiting in [
        "oneshot", "recv(", "listen", "once(", "once_any", "Notify", "sleep(", "timeout(",
        "spawn(",
    ] {
        assert!(
            !body.contains(waiting),
            "`{REQUEST_HANDLER}` must not wait for the window's answer (`{waiting}` found) — the CLI returns as soon as the request is sent (契約4)"
        );
    }
}

// ---------------------------------------------------------------------------
// AC-48-追m (e) — URI の解釈・一覧の取得の失敗は CLI へエラーで返る(確認より前に判定)
// ---------------------------------------------------------------------------

/// 8. 受け口に 4 つのエラーの `Response::Error` があり、いずれも依頼の emit より前にある。
#[test]
fn request_handler_rejects_bad_uri_and_unlistable_root_before_requesting() {
    let code = ipc_handler_rs_code();
    let body = fn_body(&code, REQUEST_HANDLER);
    let emit_at = body
        .find("emit_to(")
        .expect("request handler must emit the request (see test 6)");

    assert!(body.contains("Uri::parse("), "the request handler must parse the URI");
    assert!(body.contains(".list("), "the request handler must list the new root (一覧の取得の判定)");
    assert!(
        body.contains("Response::Error"),
        "the request handler must answer failures with Response::Error"
    );

    for code_name in ["INVALID_URI", "PROVIDER_ERROR", "LIST_ERROR", "NO_ACTIVE_WINDOW"] {
        let needle = format!("\"{code_name}\"");
        let at = body
            .find(&needle)
            .unwrap_or_else(|| panic!("`{REQUEST_HANDLER}` must return Response::Error {{ code: {needle} }}"));
        assert!(
            at < emit_at,
            "the `{code_name}` error must be decided before the request is sent (契約3: 確認より前に判定する)"
        );
    }
}

// ---------------------------------------------------------------------------
// 契約2・5(不変)— 切り替えの実体は今と同じ `handle_switch_root`
// ---------------------------------------------------------------------------

/// 9. `handle_switch_root` の本体は今と同じ要素を持つ(監視・タイトル・タブ・文書を残すか・`root_changed`)。
#[test]
fn confirmed_switch_keeps_the_existing_switch_body() {
    let code = ipc_handler_rs_code();
    let body = fn_body(&code, SWITCH_FN);
    for kept in [
        "set_title(",
        "tabbing_identifier(",
        "subscribe_directory(",
        "root_changed",
        "document_retained",
        "dir_watches.clear()",
        "root_watch = None",
        "root_uri = Some(",
    ] {
        assert!(
            body.contains(kept),
            "`{SWITCH_FN}` must keep `{kept}` — the result of the switch stays the same (契約2・5)"
        );
    }
    assert!(
        !body.contains("record_root("),
        "`{SWITCH_FN}` must not start recording history — `vellis -r` never did (契約2「今と同じ」)"
    );
}

/// 10. `handle_switch_root` は確認した窓を切り替える(呼び出し側が渡す label。前面の窓を見ない)。
#[test]
fn confirmed_switch_targets_the_window_that_confirmed_not_the_front_window() {
    let code = ipc_handler_rs_code();
    let body = fn_body(&code, SWITCH_FN);
    assert!(
        !body.contains("active_label()"),
        "`{SWITCH_FN}` must switch the window named by its caller (the one that confirmed), not `active_label()` — another window may be in front while the dialog is open"
    );
    let signature = compact(fn_signature(&code, SWITCH_FN));
    assert!(
        signature.contains("label:&str"),
        "`{SWITCH_FN}` must take the window label (`label: &str`) from its caller: {signature}"
    );
}

// ---------------------------------------------------------------------------
// 配線 — `switch_root_confirmed` command
// ---------------------------------------------------------------------------

/// 11. `switch_root_confirmed` が `#[tauri::command]` 付きでちょうど 1 つあり、確認した窓で
///     `handle_switch_root(` を呼ぶ。
#[test]
fn switch_root_confirmed_command_performs_the_switch_for_the_calling_window() {
    let sources = all_rust_sources();
    let needle = format!("fn {CONFIRMED_COMMAND}(");
    let defs: Vec<&(String, String)> = sources.iter().filter(|(_, src)| src.contains(&needle)).collect();
    assert_eq!(
        defs.len(),
        1,
        "exactly one `{needle}…` under src-tauri/src (found in {:?})",
        defs.iter().map(|(rel, _)| rel).collect::<Vec<_>>()
    );
    let (rel, src) = defs[0];
    let start = fn_start(src, CONFIRMED_COMMAND).unwrap();
    // 直前 400 バイトほど(属性・可視性・doc の範囲)。文字の途中で切らない。
    let mut from = start.saturating_sub(400);
    while !src.is_char_boundary(from) {
        from -= 1;
    }
    let before = &src[from..start];
    assert!(
        before.contains("#[tauri::command]"),
        "`{CONFIRMED_COMMAND}` in {rel} must be a `#[tauri::command]`"
    );

    let signature = compact(fn_signature(src, CONFIRMED_COMMAND));
    assert!(
        signature.contains("uri:String"),
        "`{CONFIRMED_COMMAND}` must take `uri: String` (the front sends `{{ uri }}`): {signature}"
    );
    assert!(
        signature.contains("window:Window") || signature.contains("window:tauri::Window"),
        "`{CONFIRMED_COMMAND}` must take the calling `window: Window` — the window that confirmed is the one to switch: {signature}"
    );

    let body = fn_body(src, CONFIRMED_COMMAND);
    assert!(
        body.contains(&format!("{SWITCH_FN}(")),
        "`{CONFIRMED_COMMAND}` must perform the switch through `{SWITCH_FN}(` (契約2: 結果は今と同じ)"
    );
    assert!(
        body.contains("window.label()"),
        "`{CONFIRMED_COMMAND}` must pass the calling window's label to the switch"
    );
    assert!(
        !body.contains("set_root(") && !body.contains("subscribe_directory("),
        "`{CONFIRMED_COMMAND}` must not re-implement the switch — delegate to `{SWITCH_FN}(`"
    );
}

/// 12. lib.rs の `generate_handler![` 全部(webdriver あり / なし)に登録されている。
#[test]
fn switch_root_confirmed_is_registered_in_every_invoke_handler() {
    let code = lib_rs_code();
    let lists: Vec<&str> = positions(&code, "generate_handler!")
        .into_iter()
        .map(|i| {
            let open = code[i..].find('[').expect("generate_handler![") + i;
            let close = matching_close(&code, open);
            &code[open..=close]
        })
        .collect();
    assert!(
        lists.len() >= 2,
        "lib.rs must keep both invoke handler lists (webdriver / normal); found {}",
        lists.len()
    );
    for (n, list) in lists.iter().enumerate() {
        let names: Vec<String> = list[1..list.len() - 1]
            .split(',')
            .map(|s| compact(s))
            .filter(|s| !s.is_empty())
            .collect();
        assert!(
            names.iter().any(|name| name == CONFIRMED_COMMAND || name.ends_with(&format!("::{CONFIRMED_COMMAND}"))),
            "generate_handler! list #{} in lib.rs must register `{CONFIRMED_COMMAND}`: {:?}",
            n + 1,
            names
        );
    }
}
