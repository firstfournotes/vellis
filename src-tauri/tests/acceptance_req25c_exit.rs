//! 要件#25 追補c の受け入れテスト(docs/requirements/req-25.md「追補c 普通の終了で
//! 3DxWare への登録を解除する」・AC-25-追c (b)・Issue #561)— 終了事象で止める配線
//!
//! 追補c(1): `lib.rs` の `.run` のコールバックで `RunEvent::Exit` を受けたら、SpaceMouse の
//! 入力源を止める関数(`SpaceMouseHandle::shutdown`・確定契約は `acceptance_req25c.rs`)を呼ぶ。
//! Command + Q・メニューの終了・最後の窓を閉じる・Dock やログアウトからの終了は、どれも
//! `RunEvent::Exit` に来る(追補c(2))。
//!
//! 判定は `src-tauri/src/lib.rs` のソース走査で行う(AC-25-9 = `acceptance_req25b.rs` と同じ型。
//! `.run(` のコールバックを実際に起動して終了させる判定は、本物の Tauri のイベントループと
//! 3DxWare への登録を伴うので採らない)。
//!
//! 走査の規則(実装の書き方の自由度=受け付ける形と拒む形):
//! - `lib.rs` の `.run(` に渡すクロージャをすべて集める。本体が空のクロージャ
//!   (`.run(|_, _| {})`=`--self-check` の経路。入力源は `Disabled` で起動しない)は対象外。
//!   本体のある(=何かの事象を扱う)クロージャは**すべて**、`RunEvent::Exit` を受けた領域で
//!   止める関数を呼ばなければならない
//! - 「`RunEvent::Exit` を受けた領域」= `if let RunEvent::Exit = event { … }` のブロック・
//!   `if matches!(event, RunEvent::Exit) { … }` のブロック・`match event { RunEvent::Exit => … }`
//!   の腕(ブロックでも式でもよい。`RunEvent::Exit | RunEvent::ExitRequested { .. } =>` のように
//!   `Exit` を含む腕も可)。`RunEvent::ExitRequested` だけでは `Exit` を受けたことにならない
//!   (ExitRequested は取り消せる段階で、`Exit` がイベントループの終了そのもの)。
//!   `!matches!(…)` の否定は受けない
//! - 「止める関数を呼ぶ」= その領域の中に `SpaceMouseHandle` と `.shutdown(` の両方がある
//!   (例: `app_handle.state::<spacemouse::SpaceMouseHandle>().shutdown();`)。または領域から
//!   呼ぶ `lib.rs` 内の `fn`(1 段だけ)の本体にそれがある
//! - 判定できない書き方(例: 判定結果を変数に取ってから分岐・`.run(名前付き関数)` で
//!   その関数が `lib.rs` に無い)は不合格にする(緩すぎない側に寄せる)
//!
//! ケース:
//! ① `run_callback_shuts_spacemouse_down_on_exit` — `lib.rs` の本体のある `.run(` クロージャ
//!    すべてが `RunEvent::Exit` の領域で `SpaceMouseHandle` の `.shutdown(` を呼ぶ(AC-25-追c (b))
//! ②〜 `scanner_*` — 走査器の自己検証(受け付ける形 5・拒む形 5)
//!
//! 本ファイルの外: 止める関数そのもの(一度きり・Deactivate → Unregister → Cleanup)は
//! `acceptance_req25c.rs`。既存テストが無改変で緑(AC-25-追c (c))は test-runner。
//! 実機で登録が消えること(`ioreg` の `TDxVirtualHIDData_ID` の数)は人間ゲート。
//!
//! 既存の acceptance_req25.rs / acceptance_req25a.rs / acceptance_req25b.rs は変更しない。
//!
//! 赤の設計: 実装前の `lib.rs` の `.run(|app_handle, event| { … })` は `RunEvent::Opened` だけを
//! 扱い、`RunEvent::Exit` を受ける領域が無いので、①は未実装が理由で失敗する。

const LIB_RS: &str = include_str!("../src/lib.rs");

const EXIT_EVENT: &str = "RunEvent::Exit";
const HANDLE_TYPE: &str = "SpaceMouseHandle";
const SHUTDOWN_CALL: &str = ".shutdown(";

// ---------------------------------------------------------------------------
// ソースの読み取り(acceptance_req25b.rs と同じ方式)
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

/// 文字列リテラルの中を空白に置き換えた同じ長さの写し(括弧の対応を数えるとき、
/// リテラル内の括弧や `.run(` に惑わされないため。位置は元のソースと一致する)。
fn mask_string_literals(code: &str) -> Vec<u8> {
    let bytes = code.as_bytes();
    let mut out = bytes.to_vec();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j] != b'"' {
                if bytes[j] == b'\\' {
                    j += 1;
                }
                j += 1;
            }
            for k in (i + 1)..j.min(bytes.len()) {
                out[k] = b' ';
            }
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}

fn is_open(c: u8) -> bool {
    matches!(c, b'(' | b'[' | b'{')
}

fn is_close(c: u8) -> bool {
    matches!(c, b')' | b']' | b'}')
}

fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// `open` の位置の開き括弧に対応する閉じ括弧の位置(前方)。
fn matching_close(masked: &[u8], open: usize) -> usize {
    let mut depth = 0usize;
    for i in open..masked.len() {
        if is_open(masked[i]) {
            depth += 1;
        } else if is_close(masked[i]) {
            depth -= 1;
            if depth == 0 {
                return i;
            }
        }
    }
    panic!("bracket at {open} never closes");
}

fn skip_ws(masked: &[u8], mut i: usize) -> usize {
    while i < masked.len() && masked[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

fn trim_end_len(bytes: &[u8]) -> usize {
    let mut n = bytes.len();
    while n > 0 && bytes[n - 1].is_ascii_whitespace() {
        n -= 1;
    }
    n
}

fn line_of(code: &str, pos: usize) -> usize {
    code[..pos].matches('\n').count() + 1
}

fn find_all(masked: &[u8], needle: &str) -> Vec<usize> {
    let n = needle.as_bytes();
    (0..masked.len().saturating_sub(n.len() - 1))
        .filter(|&i| &masked[i..i + n.len()] == n)
        .collect()
}

/// `.run(` のコールバック 1 つ。`body` は本体の範囲(ブロックなら `{` の次〜`}`)。
struct RunCallback {
    at: usize,
    body: (usize, usize),
}

/// `lib.rs` の `.run(` すべてのコールバック。クロージャならその本体、名前付き関数なら
/// `lib.rs` 内のその `fn` の本体。どちらでもなければ Err(判定できない)。
fn run_callbacks(code: &str, masked: &[u8]) -> Result<Vec<RunCallback>, String> {
    let mut out = Vec::new();
    for at in find_all(masked, ".run(") {
        let arg = skip_ws(masked, at + ".run(".len());
        let close = matching_close(masked, at + ".run(".len() - 1);
        if masked.get(arg) == Some(&b'|') {
            // クロージャ: `|params|` を読み飛ばして本体へ。
            let mut i = arg + 1;
            while i < close && masked[i] != b'|' {
                i += 1;
            }
            let body_start = skip_ws(masked, i + 1);
            if masked.get(body_start) == Some(&b'{') {
                out.push(RunCallback {
                    at,
                    body: (body_start + 1, matching_close(masked, body_start)),
                });
            } else {
                // ブロック無しのクロージャ式: `.run(` の閉じ括弧までを本体とみなす。
                out.push(RunCallback {
                    at,
                    body: (body_start, close),
                });
            }
        } else {
            // 名前付き関数: lib.rs 内の fn を 1 段だけ解決する。
            let name: String = code[arg..close]
                .trim()
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == ':')
                .collect();
            let short = name.rsplit("::").next().unwrap_or(&name).to_string();
            match local_fn_body(masked, &short) {
                Some(body) => out.push(RunCallback { at, body }),
                None => {
                    return Err(format!(
                        "line {}: `.run({name})` hands the callback to something this test cannot read (not a closure, and no `fn {short}` in lib.rs)",
                        line_of(code, at)
                    ))
                }
            }
        }
    }
    Ok(out)
}

/// `lib.rs` 内の `fn NAME(` / `fn NAME<` の本体 `{`..`}`(無ければ None)。
fn local_fn_body(masked: &[u8], name: &str) -> Option<(usize, usize)> {
    let needle = format!("fn {name}");
    for at in find_all(masked, &needle) {
        let after = at + needle.len();
        if !matches!(masked.get(after), Some(b'(') | Some(b'<')) {
            continue;
        }
        if at > 0 && is_ident(masked[at - 1]) {
            continue;
        }
        // 引数と戻り値を読み飛ばして本体の `{` へ(深さ 0 の最初の `{`)。
        let mut depth = 0usize;
        let mut i = after;
        while i < masked.len() {
            let c = masked[i];
            if c == b'{' && depth == 0 {
                return Some((i + 1, matching_close(masked, i)));
            }
            if is_open(c) {
                depth += 1;
            } else if is_close(c) {
                depth = depth.saturating_sub(1);
            } else if c == b';' && depth == 0 {
                break;
            }
            i += 1;
        }
    }
    None
}

/// `RunEvent::Exit`(`ExitRequested` を除く)の出現位置。
fn exit_occurrences(masked: &[u8], (start, end): (usize, usize)) -> Vec<usize> {
    find_all(&masked[start..end], EXIT_EVENT)
        .into_iter()
        .map(|i| start + i)
        .filter(|&p| !masked.get(p + EXIT_EVENT.len()).copied().is_some_and(is_ident))
        .collect()
}

/// `pos` の直前で、同じ文の中に `!matches!` があるか(否定の条件は受けない)。
fn negated_before(code: &str, masked: &[u8], pos: usize) -> bool {
    let mut depth = 0usize;
    let mut i = pos;
    let mut start = 0;
    while i > 0 {
        i -= 1;
        let c = masked[i];
        if is_close(c) {
            if depth == 0 && c == b'}' {
                // 直前の文(ブロック)の終わり。
                start = i + 1;
                break;
            }
            depth += 1;
        } else if is_open(c) {
            if depth > 0 {
                depth -= 1;
            } else {
                // 囲む括弧の開き。`matches!(` の `(` なら、その前の `!matches!` を見るため続ける。
                if c == b'{' {
                    start = i + 1;
                    break;
                }
                continue;
            }
        } else if c == b';' && depth == 0 {
            start = i + 1;
            break;
        }
    }
    let text: String = code[start..pos].split_whitespace().collect();
    text.contains("!matches!")
}

/// `pos` の `RunEvent::Exit` を受けた領域(本体 `body` の中)。判定できなければ None。
fn exit_region(masked: &[u8], pos: usize, body: (usize, usize)) -> Option<(usize, usize)> {
    let mut depth = 0usize;
    let mut i = pos + EXIT_EVENT.len();
    while i < body.1 {
        let c = masked[i];
        if depth == 0 {
            if c == b'{' {
                // `RunEvent::Name { .. }` の構造体パターンの括弧は読み飛ばす
                // (`Exit | ExitRequested { .. } =>` のような腕のため)。
                let n = trim_end_len(&masked[..i]);
                let mut j = n;
                while j > 0 && is_ident(masked[j - 1]) {
                    j -= 1;
                }
                if j >= 2 && j < n && &masked[j - 2..j] == b"::" {
                    i = matching_close(masked, i) + 1;
                    continue;
                }
                return Some((i + 1, matching_close(masked, i)));
            }
            if c == b'=' && masked.get(i + 1) == Some(&b'>') {
                let arm = skip_ws(masked, i + 2);
                if masked.get(arm) == Some(&b'{') {
                    return Some((arm + 1, matching_close(masked, arm)));
                }
                // ブロック無しの腕: 深さ 0 の `,` か、match を閉じる `}` まで。
                let mut d = 0usize;
                let mut k = arm;
                while k < body.1 {
                    let ck = masked[k];
                    if is_open(ck) {
                        d += 1;
                    } else if is_close(ck) {
                        if d == 0 {
                            return Some((arm, k));
                        }
                        d -= 1;
                    } else if ck == b',' && d == 0 {
                        return Some((arm, k));
                    }
                    k += 1;
                }
                return None;
            }
            if c == b';' {
                return None;
            }
            if is_close(c) {
                // 囲む括弧(`matches!(…)` など)から出る。
                i += 1;
                continue;
            }
        }
        if is_open(c) {
            depth += 1;
        } else if is_close(c) {
            depth -= 1;
        }
        i += 1;
    }
    None
}

fn contains_shutdown(text: &str) -> bool {
    text.contains(HANDLE_TYPE) && text.contains(SHUTDOWN_CALL)
}

/// 領域の中で止める関数を呼ぶか(直接、または `lib.rs` 内の fn を 1 段経由して)。
fn region_calls_shutdown(code: &str, masked: &[u8], (start, end): (usize, usize)) -> bool {
    let text = &code[start..end];
    if contains_shutdown(text) {
        return true;
    }
    // 領域から呼ぶ識別子 `NAME(`(マクロ `NAME!(` とメソッド `.NAME(` は除く)。
    let bytes = &masked[start..end];
    let mut i = 0;
    while i < bytes.len() {
        if is_ident(bytes[i]) && (i == 0 || !is_ident(bytes[i - 1])) {
            let s = i;
            while i < bytes.len() && is_ident(bytes[i]) {
                i += 1;
            }
            let name = &text[s..i];
            let before_is_dot = s > 0 && bytes[s - 1] == b'.';
            if bytes.get(i) == Some(&b'(') && !before_is_dot {
                if let Some(body) = local_fn_body(masked, name) {
                    if contains_shutdown(&code[body.0..body.1]) {
                        return true;
                    }
                }
            }
        } else {
            i += 1;
        }
    }
    false
}

/// `src` の `.run(` コールバックすべてについて追補c(1) の配線を判定する。
fn verdict(src: &str) -> Result<(), String> {
    let code = strip_line_comments(src);
    let masked = mask_string_literals(&code);
    let callbacks = run_callbacks(&code, &masked)?;
    if callbacks.is_empty() {
        return Err("no `.run(` callback found".to_string());
    }
    let mut checked = 0;
    for cb in callbacks {
        if code[cb.body.0..cb.body.1].trim().is_empty() {
            continue; // 本体が空(`--self-check` の `app.run(|_, _| {})`)は対象外
        }
        checked += 1;
        let exits = exit_occurrences(&masked, cb.body);
        if exits.is_empty() {
            return Err(format!(
                "line {}: the `.run(` callback never receives `{EXIT_EVENT}` (it must stop the SpaceMouse input source on exit)",
                line_of(&code, cb.at)
            ));
        }
        let ok = exits.iter().any(|&p| {
            if negated_before(&code, &masked, p) {
                return false;
            }
            exit_region(&masked, p, cb.body)
                .is_some_and(|region| region_calls_shutdown(&code, &masked, region))
        });
        if !ok {
            return Err(format!(
                "line {}: the `.run(` callback mentions `{EXIT_EVENT}` (at line(s) {:?}) but no `{EXIT_EVENT}` region calls `{SHUTDOWN_CALL}` on the `{HANDLE_TYPE}` state (directly or via one local fn)",
                line_of(&code, cb.at),
                exits.iter().map(|&p| line_of(&code, p)).collect::<Vec<_>>()
            ));
        }
    }
    if checked == 0 {
        return Err("every `.run(` callback has an empty body — the normal path must handle `RunEvent::Exit`".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// ケース
// ---------------------------------------------------------------------------

/// ① AC-25-追c (b): `lib.rs` の本体のある `.run(` クロージャすべてが `RunEvent::Exit` の
///    領域で `SpaceMouseHandle` の `.shutdown(` を呼ぶ。
#[test]
fn run_callback_shuts_spacemouse_down_on_exit() {
    if let Err(reason) = verdict(LIB_RS) {
        panic!(
            "lib.rs must stop the SpaceMouse input source when the event loop exits \
             (`RunEvent::Exit` → `app_handle.state::<spacemouse::SpaceMouseHandle>().shutdown()` \
             or equivalent) — {reason}"
        );
    }
}

// ---------------------------------------------------------------------------
// 走査器の自己検証(受け付ける形・拒む形を固定する)
// ---------------------------------------------------------------------------

/// 通常経路の `.run(` に、`--self-check` の空クロージャを添えた骨組み。
fn fixture(main_callback_body: &str) -> String {
    format!(
        r#"
pub(crate) fn run_app() {{
    if is_self_check {{
        app.run(|_, _| {{}});
    }} else {{
        built
            .expect("error while running tauri application")
            .run(|app_handle, event| {{
{main_callback_body}
            }});
    }}
}}
"#
    )
}

#[test]
fn scanner_accepts_if_let_exit_block() {
    let src = fixture(
        r#"
                #[cfg(target_os = "macos")]
                if let tauri::RunEvent::Opened { urls } = &event {
                    let uris = window::open_with::opened_file_uris(urls);
                    open_in_new_windows(app_handle, uris);
                }
                if let tauri::RunEvent::Exit = event {
                    app_handle.state::<spacemouse::SpaceMouseHandle>().shutdown();
                }
        "#,
    );
    assert_eq!(verdict(&src), Ok(()));
}

#[test]
fn scanner_accepts_match_arms_with_and_without_block() {
    let with_block = fixture(
        r#"
                match event {
                    tauri::RunEvent::Opened { urls } => {
                        open_in_new_windows(app_handle, window::open_with::opened_file_uris(&urls));
                    }
                    tauri::RunEvent::Exit => {
                        tracing::info!("exiting {}", 1);
                        app_handle.state::<spacemouse::SpaceMouseHandle>().shutdown();
                    }
                    _ => {}
                }
        "#,
    );
    assert_eq!(verdict(&with_block), Ok(()));

    let without_block = fixture(
        r#"
                match event {
                    tauri::RunEvent::Exit => app_handle.state::<spacemouse::SpaceMouseHandle>().shutdown(),
                    _ => {}
                }
        "#,
    );
    assert_eq!(verdict(&without_block), Ok(()));

    // `Exit` を含む腕(ExitRequested の構造体パターンの括弧を読み飛ばす)
    let or_pattern = fixture(
        r#"
                match event {
                    tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. } => {
                        if let Some(handle) = app_handle.try_state::<spacemouse::SpaceMouseHandle>() {
                            handle.shutdown();
                        }
                    }
                    _ => {}
                }
        "#,
    );
    assert_eq!(verdict(&or_pattern), Ok(()));
}

#[test]
fn scanner_accepts_matches_macro() {
    let src = fixture(
        r#"
                if matches!(event, tauri::RunEvent::Exit) {
                    app_handle.state::<spacemouse::SpaceMouseHandle>().shutdown();
                }
        "#,
    );
    assert_eq!(verdict(&src), Ok(()));
}

#[test]
fn scanner_accepts_one_local_helper_fn() {
    let mut src = fixture(
        r#"
                if let tauri::RunEvent::Exit = event {
                    stop_spacemouse(app_handle);
                }
        "#,
    );
    src.push_str(
        r#"
fn stop_spacemouse(app: &tauri::AppHandle) {
    if let Some(handle) = app.try_state::<spacemouse::SpaceMouseHandle>() {
        handle.shutdown();
    }
}
"#,
    );
    assert_eq!(verdict(&src), Ok(()));
}

#[test]
fn scanner_ignores_empty_self_check_callback() {
    // fixture() は空の `app.run(|_, _| {})` を含む。通常経路が正しければ合格。
    let src = fixture(
        r#"
                if let tauri::RunEvent::Exit = event {
                    app_handle.state::<spacemouse::SpaceMouseHandle>().shutdown();
                }
        "#,
    );
    assert_eq!(verdict(&src), Ok(()));
}

#[test]
fn scanner_rejects_callback_without_exit_handling() {
    // 実装前の lib.rs と同じ形(Opened だけ)。
    let src = fixture(
        r#"
                #[cfg(target_os = "macos")]
                if let tauri::RunEvent::Opened { urls } = event {
                    let uris = window::open_with::opened_file_uris(&urls);
                    let to_open = app_handle.state::<PendingOpens>().receive(uris);
                    open_in_new_windows(app_handle, to_open);
                }
                #[cfg(not(target_os = "macos"))]
                let _ = (app_handle, event);
        "#,
    );
    assert!(verdict(&src).is_err(), "a callback that never receives RunEvent::Exit must be rejected");
    // 実装前の本物の lib.rs も同じ理由で拒まれる(赤の設計の根拠)。
    let _ = LIB_RS;
}

#[test]
fn scanner_rejects_exit_requested_only() {
    let src = fixture(
        r#"
                if let tauri::RunEvent::ExitRequested { .. } = event {
                    app_handle.state::<spacemouse::SpaceMouseHandle>().shutdown();
                }
        "#,
    );
    assert!(verdict(&src).is_err(), "`ExitRequested` alone is not `RunEvent::Exit`");
}

#[test]
fn scanner_rejects_shutdown_outside_exit_region() {
    let src = fixture(
        r#"
                if let tauri::RunEvent::Opened { urls } = &event {
                    app_handle.state::<spacemouse::SpaceMouseHandle>().shutdown();
                }
                if let tauri::RunEvent::Exit = event {
                    tracing::info!("bye");
                }
        "#,
    );
    assert!(verdict(&src).is_err(), "shutdown in another event's region does not count");
}

#[test]
fn scanner_rejects_negated_matches() {
    let src = fixture(
        r#"
                if !matches!(event, tauri::RunEvent::Exit) {
                    app_handle.state::<spacemouse::SpaceMouseHandle>().shutdown();
                }
        "#,
    );
    assert!(verdict(&src).is_err(), "`!matches!` is not receiving RunEvent::Exit");
}

#[test]
fn scanner_rejects_exit_handled_only_in_self_check_callback() {
    // self-check 側のクロージャだけが Exit を扱い、通常経路は Opened だけ → 不合格。
    let src = r#"
pub(crate) fn run_app() {
    if is_self_check {
        app.run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                app_handle.state::<spacemouse::SpaceMouseHandle>().shutdown();
            }
        });
    } else {
        built
            .expect("error while running tauri application")
            .run(|app_handle, event| {
                if let tauri::RunEvent::Opened { urls } = event {
                    open_in_new_windows(app_handle, window::open_with::opened_file_uris(&urls));
                }
            });
    }
}
"#;
    assert!(verdict(src).is_err(), "every non-empty `.run(` callback must handle Exit");
}
