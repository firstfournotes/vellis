//! 要件#64 追補f の受け入れテスト(docs/requirements/req-64.md 追補f・Issue #717)— Rust 層
//!
//! 「開けなかったファイルを Recent Files に載せない」。バイナリの経路(画像・PDF・動画・音声・
//! 3D)の `open_binary_document` の成功は「監視を張れた」だけなので、`open_in_window` では記録せず、
//! ビューアが最初に表示できた時点でフロントが新しい command `record_displayed_file` で記録を頼む。
//! - **AC-64-追f(a)** ソース走査: `open_in_window` の `recent_files::record_file(` の呼び出しは 1 つだけで、
//!   `binary` が偽のときだけ通る(`if !binary { … }` の中、または `if binary { … } else { … }` の else)。
//!   成功後(最後の `DocumentSession::open*` より後)に置く点は AC-64-9・AC-71 の既存の固定のまま
//! - **AC-64-追f(b)** 純関数 `recent_files::should_record_displayed(session_uri, uri)` の表:
//!   同じ URI → 真/違う URI → 偽/`None`(セッションが無い=印刷窓など)→ 偽。比較は文字列の完全一致
//!   (大文字小文字・末尾の差で別物=AC-64-1 の重複判定と同じ規則)
//! - **AC-64-追f(c)** ソース走査: `commands/recent_files.rs` の `record_displayed_file` が `#[tauri::command]`
//!   で `(window, state, uri: String) -> Result<(), String>`、本体が呼んだ窓の label でセッションの URI を
//!   引き、`should_record_displayed` を通ってから `record_file` を 1 回だけ呼ぶ。`lib.rs` の両方の
//!   `generate_handler!` に `list_recent_files`・`record_displayed_file`・`clear_recent_files` がこの順で
//!   続けて載る(要件81 の AC-81-13 が `clear_recent_files` の直後を予約しているため)
//!
//! ## 判定しないもの
//! - AC-64-9(記録と除去の配線)・AC-64-追e・`acceptance_req71.rs` の既存の固定 → それぞれのファイルが
//!   無改変で緑(フルスイートで判定)
//! - command の数の固定 → `acceptance_req66.rs`(35 → 36・34 → 35)と AC-60-20(要件側の更新=追補f (f))
//! - フロント(ビューアの `onDisplayed`・`+page.svelte` の 1 回だけ)→ `src/components/recent-files-displayed.wiring.test.ts`・
//!   `src/components/ModelViewer.displayed.wiring.test.ts`・`src/lib/recent-files-displayed.acceptance.test.ts`
//! - 実機で 256 MB 超の STL・壊れた PNG を開いても載らないこと → 人間ゲート(機械で駆動できる)
//!
//! ## 実装前の見立て
//! - ファイル全体が新しい公開 API(`recent_files::should_record_displayed`)を参照するため、実装前は
//!   コンパイルで赤。(a) は今の `open_in_window` が `record_file` を無条件に呼ぶので赤・(c) は
//!   `record_displayed_file` が無いので赤
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前・公開パス)
//!
//! ```ignore
//! // --- src-tauri/src/recent_files.rs(追加。既存の関数は無改変)---
//! /// 追補f(契約2): その窓のいまのセッションの URI(`None` = セッションが無い)が `uri` と
//! /// 同じときだけ真。比較は文字列の完全一致(`Uri::raw` と invoke の `uri`)。
//! pub fn should_record_displayed(session_uri: Option<&str>, uri: &str) -> bool;
//!
//! // --- src-tauri/src/commands/recent_files.rs(追加)---
//! /// 追補f(契約1・2): ビューアが表示できた時点でフロントが呼ぶ。呼んだ窓(`window.label()`)の
//! /// セッションの URI(`state.window_manager` → `WindowState::session` → `DocumentSession::uri.raw`)
//! /// が `uri` と同じときだけ `recent_files::record_file(&app, &uri)`。違う・セッションが無い
//! /// (印刷窓など)なら何もせず `Ok(())`(ログだけ)。
//! #[tauri::command]
//! pub async fn record_displayed_file(
//!     window: tauri::Window,
//!     state: tauri::State<'_, AppState>,
//!     uri: String,
//! ) -> Result<(), String>;
//! //   本体の形:
//! //   let label = window.label().to_string();
//! //   let session_uri = { let wm = state.window_manager.lock().await;
//! //       wm.get(&label).and_then(|w| w.session.as_ref()).map(|s| s.uri.raw.clone()) };
//! //   if recent_files::should_record_displayed(session_uri.as_deref(), &uri) {
//! //       recent_files::record_file(window.app_handle(), &uri);
//! //   } else { tracing::debug!(...) }
//! //   Ok(())
//!
//! // --- src-tauri/src/commands/document.rs の open_in_window(成功側)の形 ---
//! //   if !binary {
//! //       recent_files::record_file(&app_handle, &uri);
//! //   }
//!
//! // --- src-tauri/src/lib.rs: 両方の generate_handler! に
//! //   list_recent_files, record_displayed_file, clear_recent_files,  の順で続けて載せる
//! ```

use vellis_lib::recent_files::should_record_displayed;

// ---------------------------------------------------------------------------
// ヘルパー(acceptance_req64 / acceptance_req38g の写し)
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

fn document_rs_code() -> String {
    strip_line_comments(include_str!("../src/commands/document.rs"))
}

fn recent_files_command_code() -> String {
    strip_line_comments(include_str!("../src/commands/recent_files.rs"))
}

fn lib_rs_code() -> String {
    strip_line_comments(include_str!("../src/lib.rs"))
}

/// `fn <name>(` から、次の `#[tauri::command]` か次の関数の頭か `#[cfg(test)]` まで。
fn fn_body(code: &str, name: &str) -> String {
    let marker = format!("fn {name}(");
    let at = code
        .find(&marker)
        .unwrap_or_else(|| panic!("`{marker}` must exist"));
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

/// `at` を囲む最も内側の `if` 文: (条件の文, 枝)。枝 0 = then・枝 1 = else。
/// 条件は `if ` から次の `{` まで。then の `{` から `at` まで波括弧の深さを追い、`at` で深さが 1 以上の
/// `if` だけを候補にする(深さが 0 に戻った回数が枝=0 なら then・1 なら else。else は `}` と次の `{`
/// のあいだが `else` の字そのものであることも見る)。
fn enclosing_if(body: &str, at: usize) -> Option<(String, usize)> {
    let mut found: Option<(String, usize)> = None;
    let mut search = 0;
    while let Some(rel) = body[search..at].find("if ") {
        let if_at = search + rel;
        search = if_at + 3;
        // 直前が識別子の文字なら `if ` ではない(例: `elif`)。
        if if_at > 0 {
            let prev = body.as_bytes()[if_at - 1];
            if prev.is_ascii_alphanumeric() || prev == b'_' {
                continue;
            }
        }
        let Some(brace_rel) = body[if_at..at].find('{') else {
            continue;
        };
        let brace_at = if_at + brace_rel;
        let cond = body[if_at + 3..brace_at].trim().to_string();
        let mut depth = 0usize;
        let mut returns_to_zero = 0usize;
        let mut last_close: Option<usize> = None;
        let mut reopened_after_close: Option<usize> = None;
        for (i, c) in body[brace_at..at].char_indices() {
            match c {
                '{' => {
                    if depth == 0 && last_close.is_some() {
                        reopened_after_close = Some(brace_at + i);
                    }
                    depth += 1;
                }
                '}' => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        returns_to_zero += 1;
                        last_close = Some(brace_at + i);
                    }
                }
                _ => {}
            }
        }
        if depth == 0 {
            continue;
        }
        let branch = match returns_to_zero {
            0 => 0,
            1 => {
                let between = body[last_close.unwrap() + 1..reopened_after_close.unwrap()].trim();
                if between != "else" {
                    continue;
                }
                1
            }
            _ => continue,
        };
        found = Some((cond, branch));
    }
    found
}

// ---------------------------------------------------------------------------
// AC-64-追f(a) — open_in_window の記録はテキストの経路だけ(契約1)
// ---------------------------------------------------------------------------

/// 1. `open_in_window` の `recent_files::record_file(` は 1 つだけで、`binary` の `if` の「偽」の側
///    (`if !binary { … }` の then か、`if binary { … } else { … }` の else)にある。成功後に置く点は
///    AC-64-9 のとおり(ここでも見る)。
#[test]
fn open_in_window_records_only_when_not_binary() {
    let code = document_rs_code();
    let body = fn_body(&code, "open_in_window");

    let calls: Vec<usize> = body
        .match_indices("recent_files::record_file(")
        .map(|(i, _)| i)
        .collect();
    assert_eq!(
        calls.len(),
        1,
        "open_in_window must call recent_files::record_file(…) exactly once (契約1): {calls:?}"
    );
    let record_at = calls[0];

    let last_open_at = body
        .rfind("DocumentSession::open")
        .expect("open_in_window still opens through DocumentSession::open / open_binary");
    assert!(
        record_at > last_open_at,
        "record_file must stay after the session is opened (記録は成功後=契約2・AC-64-9)"
    );

    let (cond, branch) = enclosing_if(&body, record_at).unwrap_or_else(|| {
        panic!("record_file must sit inside an `if` on `binary` (契約1: バイナリの経路では記録しない)")
    });
    assert!(
        cond.contains("binary"),
        "the `if` around record_file must test `binary`, got `if {cond}`"
    );
    let negated = cond.replace(' ', "").contains("!binary");
    match branch {
        0 => assert!(
            negated,
            "record_file in the then-branch requires `if !binary`, got `if {cond}`"
        ),
        _ => assert!(
            !negated,
            "record_file in the else-branch requires `if binary {{ … }} else {{ … }}`, got `if {cond}`"
        ),
    }
}

/// 2. `binary` の引数はそのまま(`open_document` / `open_binary_document` が `open_in_window` に
///    `false` / `true` を渡す形=契約7 の不変)。
#[test]
fn open_document_and_open_binary_document_still_route_through_open_in_window() {
    let code = document_rs_code();
    let text = fn_body(&code, "open_document");
    let bin = fn_body(&code, "open_binary_document");
    assert!(
        text.contains("open_in_window(") && text.contains("false"),
        "open_document must call open_in_window(…, false)"
    );
    assert!(
        bin.contains("open_in_window(") && bin.contains("true"),
        "open_binary_document must call open_in_window(…, true)"
    );
    for (name, b) in [("open_document", &text), ("open_binary_document", &bin)] {
        assert!(
            !b.contains("recent_files"),
            "{name} must not touch recent_files itself (AC-64-9 と同じ)"
        );
    }
}

// ---------------------------------------------------------------------------
// AC-64-追f(b) — should_record_displayed の表(契約2)
// ---------------------------------------------------------------------------

const DOC: &str = "file:///Users/x/notes/img/photo.png";

/// 3. 同じ URI → 真/違う URI → 偽/`None` → 偽。
#[test]
fn should_record_displayed_table() {
    assert!(should_record_displayed(Some(DOC), DOC), "same uri → record");
    assert!(
        !should_record_displayed(Some("file:///Users/x/notes/img/other.png"), DOC),
        "different uri → do not record"
    );
    assert!(
        !should_record_displayed(None, DOC),
        "no session (print window など) → do not record"
    );
}

/// 4. 比較は文字列の完全一致(大文字小文字・末尾の差・前方一致では同じと見ない=AC-64-1 の重複判定と同じ規則)。
#[test]
fn should_record_displayed_is_an_exact_string_match() {
    assert!(!should_record_displayed(Some("file:///Users/x/notes/img/Photo.png"), DOC));
    assert!(!should_record_displayed(Some("file:///Users/x/notes/img/photo.png/"), DOC));
    assert!(!should_record_displayed(Some("file:///Users/x/notes/img/photo.pn"), DOC));
    assert!(!should_record_displayed(Some("file:///Users/x/notes/img"), DOC));
    assert!(!should_record_displayed(Some(DOC), "file:///Users/x/notes/img/photo.png?v=1"));
    // ssh の URI も同じ規則。
    let remote = "ssh://alice@host/repo/docs/plan.pdf";
    assert!(should_record_displayed(Some(remote), remote));
    assert!(!should_record_displayed(Some(remote), "ssh://alice@host/repo/docs/plan.pdf.bak"));
}

/// 5. シグネチャの固定: `fn(Option<&str>, &str) -> bool`。
#[test]
fn should_record_displayed_signature() {
    let f: fn(Option<&str>, &str) -> bool = should_record_displayed;
    assert!(f(Some("a"), "a"));
    assert!(!f(None, "a"));
}

// ---------------------------------------------------------------------------
// AC-64-追f(c) — record_displayed_file の command と登録(契約2)
// ---------------------------------------------------------------------------

/// 6. `commands/recent_files.rs` に `#[tauri::command] pub async fn record_displayed_file(window, state,
///    uri: String) -> Result<(), String>` がある。
#[test]
fn record_displayed_file_is_a_command_with_the_fixed_signature() {
    let code = recent_files_command_code();
    let marker = "pub async fn record_displayed_file(";
    let at = code
        .find(marker)
        .expect("commands/recent_files.rs must define `pub async fn record_displayed_file(`");
    assert!(
        code[..at].trim_end().ends_with("#[tauri::command]"),
        "record_displayed_file must be a #[tauri::command]"
    );
    let params_end = code[at..].find(')').expect("param list must close") + at;
    let params = &code[at + marker.len()..params_end];
    assert!(
        params.contains("uri: String"),
        "record_displayed_file takes `uri: String`, got ({params})"
    );
    assert!(
        params.contains("window:") && params.contains("Window"),
        "record_displayed_file takes the calling `window: tauri::Window` (呼んだ窓の label を見る), got ({params})"
    );
    assert!(
        params.contains("state:") && params.contains("AppState"),
        "record_displayed_file takes `state: tauri::State<'_, AppState>` (セッションを引く), got ({params})"
    );
    let ret = code[params_end..]
        .split('{')
        .next()
        .unwrap_or("")
        .replace(' ', "");
    assert!(
        ret.contains("->Result<(),String>"),
        "record_displayed_file returns Result<(), String>, got `{ret}`"
    );
}

/// 7. 本体: 呼んだ窓の label → セッションの URI → `should_record_displayed` → `record_file`(1 回だけ・
///    判定の `if` の中)。`list_recent_files` / `clear_recent_files` は記録に触れない。
#[test]
fn record_displayed_file_checks_the_window_session_before_recording() {
    let code = recent_files_command_code();
    let body = fn_body(&code, "record_displayed_file");

    let label_at = body
        .find(".label()")
        .expect("record_displayed_file must read the calling window's label (window.label())");
    assert!(
        body.contains("window_manager"),
        "record_displayed_file must look the window up in state.window_manager"
    );
    assert!(
        body.contains("session"),
        "record_displayed_file must read the window's current session (WindowState::session)"
    );
    let judge_at = body
        .find("should_record_displayed(")
        .expect("record_displayed_file must decide through recent_files::should_record_displayed(…)");
    let records: Vec<usize> = body.match_indices("record_file(").map(|(i, _)| i).collect();
    assert_eq!(
        records.len(),
        1,
        "record_displayed_file must call record_file(…) exactly once: {records:?}"
    );
    let record_at = records[0];
    assert!(
        label_at < judge_at && judge_at < record_at,
        "order must be label → should_record_displayed → record_file"
    );
    let (cond, branch) = enclosing_if(&body, record_at)
        .expect("record_file must sit inside the `if` on should_record_displayed(…)");
    assert_eq!(branch, 0, "record_file goes in the then-branch of `if {cond}`");
    assert!(
        cond.contains("should_record_displayed("),
        "the `if` around record_file must be the should_record_displayed judgement, got `if {cond}`"
    );
    assert!(
        !cond.trim_start().starts_with('!'),
        "the judgement must not be negated: `if {cond}`"
    );

    for name in ["list_recent_files", "clear_recent_files"] {
        assert!(
            !fn_body(&code, name).contains("record_file("),
            "{name} must not record (unchanged)"
        );
    }
}

/// 8. `lib.rs` の両方の `generate_handler!` に `list_recent_files`・`record_displayed_file`・
///    `clear_recent_files` がこの順で続けて載る(それぞれ 1 回)。
#[test]
fn handler_lists_register_record_displayed_file_between_list_and_clear() {
    let code = lib_rs_code();
    let blocks = handler_lists(&code);
    assert_eq!(
        blocks.len(),
        2,
        "lib.rs has the webdriver and the production handler lists"
    );
    for names in &blocks {
        for required in ["list_recent_files", "record_displayed_file", "clear_recent_files"] {
            assert_eq!(
                names.iter().filter(|n| *n == required).count(),
                1,
                "{required} must be registered exactly once: {names:?}"
            );
        }
        let at = names
            .iter()
            .position(|n| n == "list_recent_files")
            .unwrap();
        let window: Vec<&str> = names[at..(at + 3).min(names.len())]
            .iter()
            .map(String::as_str)
            .collect();
        assert_eq!(
            window,
            vec!["list_recent_files", "record_displayed_file", "clear_recent_files"],
            "the three recent-files commands must be consecutive in this order: {names:?}"
        );
    }
}
