//! 要件#38 追補m の受け入れテスト(docs/requirements/req-38.md 追補m・Issue #461・#459)— Rust 層
//!
//! 「印刷窓の後始末と、印刷のあいだの終わり方」
//!
//! 由谷の決定(2026-10-20): 文書の窓を全部閉じても、印刷窓が開いているあいだはアプリを終えない。
//! 印刷窓が閉じたら(刷り終えた・取り消した)、ほかに窓が無ければアプリを終える。
//!
//! 契約(追補m):
//! 1. **シートが閉じたら印刷窓を閉じる** — **追補n(2026-10-21・Issue #718)で作りを置き換えた**。
//!    追補m の初版は `print()` のあと `attachedSheet` を一定間隔で見て「付いた → 外れて 1 秒」で
//!    閉じていたが、パネルを 0.5 秒未満で閉じると最初の確かめより前にシートが付いて外れ、
//!    「一度も付かなかった」と区別できずに窓が残った(reviewer の P3・機械駆動で 3/3 再現)。
//!    追補n では印刷窓の印刷を自前の印刷操作(`printOperationWithPrintInfo:` → delegate 付きの
//!    `runOperationModalForWindow:…`)で出し、印刷の終わりの通知 `printOperationDidRun:success:contextInfo:`
//!    で印刷窓を閉じる。見張りの判定 `SheetWatch`・`SheetWatchAction`・定数 `SHEET_WATCH_*`・
//!    `PRINT_BLOCKED_AFTER`・1. の補足(メインスレッドとの往復で測る)は消えた。
//!    **固定は `acceptance_req38n.rs`**(本ファイルの旧 (a)・(a′)・(b)・(b′) は 2026-10-21 の
//!    要件側の更新で消した)。「新しい依存は足さない」は本ファイルに残す
//! 2. **印刷のあいだはアプリを終えない**: 要件#12 追補a の 2 のとおり(印刷窓が残っていれば終えない)
//! 3. **印刷窓は1つまで**: 印刷窓がすでに開いているとき(開いている途中を含む)の印刷の要求は、
//!    新しい印刷窓を作らずに、開いている印刷窓を前面に出して `Ok` を返す
//! 4. 残す(変えない)もの: 印刷窓が前面のときの Command + P は何もしない・印刷窓だけが残ったときの
//!    Window メニューなどは何もしない・印刷窓の再読み込みで 404 の文字が出る
//!
//! 本ファイルの持ち場= AC-38-追m の (c) と、契約 1 の「新しい依存は足さない」:
//! - (c) 印刷窓がすでにあるときの `open_print_window`: 判定は純関数 `existing_print_window`
//!   (窓のラベルの並び → 印刷窓の先頭)で振る舞いを固定し、ソース走査で「窓を作る前に探し、
//!   `set_focus` して `Ok(())` を返す」を固定する
//! - 契約 1 の「新しい依存は足さない」: Cargo.toml の依存クレート名の集合が起案時点と同一
//!   (追補n の契約 5 も同じ固定を `acceptance_req38n.rs` に持つ)
//!
//! 持ち場の外:
//! - 契約 1(印刷の終わりで閉じる)= AC-38-追n(`acceptance_req38n.rs`)
//! - 契約 2(印刷窓が残っていればアプリを終えない)= AC-12-追a (b) の純関数(`acceptance_req12a.rs`)
//! - (d) 既存の要件#38 のテスト(`acceptance_req38*.rs`)が無改変で緑=同じ周回のフルスイート
//! - 契約 4 の「印刷窓が前面のときの Command + P は何もしない」= `acceptance_req38i.rs` が固定済み
//!
//! ## 確定契約(公開 API・implementer はこれに従う)
//!
//! ```ignore
//! // src-tauri/src/print.rs(`#[cfg]` を付けない=純関数は OS に依らない)
//!
//! /// 開いている窓のラベルの並び(`app.webview_windows()` の順)から、印刷窓(`is_print_window`)の
//! /// 先頭。無ければ `None`。
//! pub fn existing_print_window<'a>(labels: &[&'a str]) -> Option<&'a str>;
//!
//! // `open_print_window`(シグネチャ・呼び出し元は不変):
//! // - 先頭(`register(` と `WebviewWindowBuilder::new(` の前)で `app.webview_windows()` のラベルを
//! //   `existing_print_window(` に渡し、あればその窓を `set_focus(` して `return Ok(())`
//! //   (`register(` のあとに探すなら、早く返す経路で `take(` して文書を捨てる)
//! // - 印刷の始め方と印刷窓の閉じ方は追補n(`acceptance_req38n.rs` の確定契約)
//! ```
//!
//! ## reviewer 照合に委ねる配線(AppHandle / AppKit 依存で機械判定不能)
//! - 契約 3 の「開いている途中」: `build()` が返った窓は `webview_windows()` に載るので先頭の探索で
//!   見つかる。`build()` の前の並列の競合(同時に 2 つの command が探索を通る)は reviewer の判断
//!   (実装は `PRINT_WINDOW_OPENING` のロックで直列にした=2026-10-20 の記録)
//! - `set_focus` の失敗は warn に留めて `Ok(())` を返すこと(文書は捨てる)
//!
//! ## 人間ゲート
//! - 印刷パネルを出したまま文書の窓を全部閉じてもアプリは残り、パネルを閉じると印刷窓が閉じてアプリが
//!   終わる。Command + P の連打で印刷窓は 1 枚(2026-10-21 に機械で PASS=req-38.md 追補m の記録)

use std::collections::BTreeSet;

use vellis_lib::print::{existing_print_window, is_print_window};

// ---------------------------------------------------------------------------
// フィクスチャ — 印刷窓のラベルは `print::open_print_window` の生成規則
// (`PRINT_WINDOW_LABEL_PREFIX`="print-" + ULID)に合わせ、`is_print_window` で裏を取る
// (acceptance_req38i.rs と同じ)
// ---------------------------------------------------------------------------

const PRINT_A: &str = "print-01J9Q3XK0F8V2T6H4N1M5A7B9C";
const PRINT_B: &str = "print-01J9Q3XK0G1W3R8D2P6K4Z0M7E";

/// 用意したラベルが契約の前提(印刷窓/文書の窓)を満たすことの確認。
#[test]
fn fixtures_match_is_print_window() {
    for label in [PRINT_A, PRINT_B] {
        assert!(is_print_window(label), "fixture {label} must be a print window label");
    }
    for label in ["main", "doc-2", "vellis-3", "tab-1", "printer"] {
        assert!(!is_print_window(label), "fixture {label} must not be a print window label");
    }
}

// ---------------------------------------------------------------------------
// (c) 印刷窓がすでにあるか — 純関数 existing_print_window
// ---------------------------------------------------------------------------

/// 1. 契約の型: `existing_print_window<'a>(&[&'a str]) -> Option<&'a str>`
///    (返り値はラベルの寿命を借りる=スライスの寿命ではない)。コンパイル時の判定。
#[test]
fn existing_print_window_has_the_contracted_signature() {
    let f: for<'a> fn(&[&'a str]) -> Option<&'a str> = existing_print_window;
    let labels = ["main", PRINT_A];
    let found = {
        let windows = vec![labels[0], labels[1]];
        f(&windows)
        // `windows` はここで落ちるが、返り値はラベル側の寿命なので使い続けられる
    };
    assert_eq!(found, Some(PRINT_A));
}

/// 2. 印刷窓が無ければ `None`(空・文書の窓だけ・"printer" のような似た名前)。
#[test]
fn no_print_window_among_document_windows_is_none() {
    assert_eq!(existing_print_window(&[]), None);
    assert_eq!(existing_print_window(&["main"]), None);
    assert_eq!(existing_print_window(&["main", "doc-2", "printer", "vellis-3"]), None);
}

/// 3. 開いている印刷窓は並びのどこにあっても見つかる。
#[test]
fn an_open_print_window_is_found_wherever_it_sits() {
    assert_eq!(existing_print_window(&[PRINT_A]), Some(PRINT_A));
    assert_eq!(existing_print_window(&["main", PRINT_A]), Some(PRINT_A));
    assert_eq!(existing_print_window(&[PRINT_A, "main"]), Some(PRINT_A));
    assert_eq!(
        existing_print_window(&["main", "doc-2", PRINT_A, "doc-3"]),
        Some(PRINT_A)
    );
}

/// 4. 印刷窓が複数あれば(旧版の名残り)並びの先頭のもの。
#[test]
fn the_first_print_window_wins_when_several_are_open() {
    assert_eq!(existing_print_window(&[PRINT_A, "main", PRINT_B]), Some(PRINT_A));
    assert_eq!(existing_print_window(&["main", PRINT_B, PRINT_A]), Some(PRINT_B));
}

/// 5. 判定は `is_print_window` と一致する(ラベルの規則を二重に持たない)。
#[test]
fn existing_print_window_agrees_with_is_print_window() {
    let lists: [&[&str]; 5] = [
        &["main", "doc-2"],
        &["main", PRINT_A],
        &[PRINT_B, PRINT_A, "main"],
        &["printer", "print", "print-", PRINT_A],
        &["print-x", "main"],
    ];
    for labels in lists {
        let expected = labels.iter().copied().find(|l| is_print_window(l));
        assert_eq!(
            existing_print_window(labels),
            expected,
            "existing_print_window must pick the first is_print_window label of {labels:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// (c) ソース走査 — acceptance_req38k.rs の strip_line_comments / fn_body / block_end の流儀
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

fn print_module_code() -> String {
    strip_line_comments(include_str!("../src/print.rs"))
}

/// `code[open..]` が `{` で始まるとして、対応する `}` の次の位置(文字列リテラルの中の
/// 括弧は数えない)。
fn block_end(code: &str, open: usize) -> usize {
    let bytes = code.as_bytes();
    assert_eq!(bytes[open], b'{', "block must start at a brace");
    let mut depth = 0usize;
    let mut i = open;
    let mut in_str = false;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if c == b'\\' {
                i += 1;
            } else if c == b'"' {
                in_str = false;
            }
        } else if c == b'"' {
            in_str = true;
        } else if c == b'{' {
            depth += 1;
        } else if c == b'}' {
            depth -= 1;
            if depth == 0 {
                return i + 1;
            }
        }
        i += 1;
    }
    panic!("block starting at {open} never closes");
}

/// `fn <name>(` または `fn <name><` の本体(外側の `{ … }` を含む)。
fn fn_body<'a>(code: &'a str, name: &str, file: &str) -> &'a str {
    let start = fn_definition(code, name)
        .unwrap_or_else(|| panic!("{file} must define {name}"));
    let open = code[start..]
        .find('{')
        .unwrap_or_else(|| panic!("{name} must have a body"))
        + start;
    &code[open..block_end(code, open)]
}

/// `fn <name>` の最初の定義の位置(`fn <name>(` と `fn <name><R: …>(` の両方。`fn <name>_x` は拾わない)。
fn fn_definition(code: &str, name: &str) -> Option<usize> {
    let needle = format!("fn {name}");
    code.match_indices(&needle)
        .find(|(i, _)| matches!(code[i + needle.len()..].chars().next(), Some('(') | Some('<')))
        .map(|(i, _)| i)
}

/// 6. (c) `open_print_window` は窓を作る前に(`WebviewWindowBuilder::new(` の前で)開いている窓の
///    一覧(`webview_windows()`)から `existing_print_window(` で印刷窓を探し、あれば `set_focus(`
///    して `Ok(())` を返す。探すのは `register(` の前(あとなら早く返す経路で `take(` して文書を捨てる)。
#[test]
fn open_print_window_focuses_an_existing_print_window_instead_of_opening_another() {
    let code = print_module_code();
    let body = fn_body(&code, "open_print_window", "print.rs");
    let build_at = body
        .find("WebviewWindowBuilder::new(")
        .expect("open_print_window must still build the print window with WebviewWindowBuilder");
    let before_build = &body[..build_at];
    let lookup_at = before_build.find("existing_print_window(").unwrap_or_else(|| {
        panic!(
            "open_print_window must look for an open print window (existing_print_window) before \
             building a new one (契約 3):\n{before_build}"
        )
    });
    assert!(
        before_build.contains("webview_windows()"),
        "the lookup must use the app's live window list (webview_windows()):\n{before_build}"
    );
    let early = &before_build[lookup_at..];
    assert!(
        early.contains("set_focus("),
        "an open print window must be brought to the front (set_focus) (契約 3):\n{early}"
    );
    assert!(
        early.contains("Ok(())"),
        "the request must return Ok(()) when a print window is already open (契約 3):\n{early}"
    );
    let register_at = body.find("register(").expect("open_print_window must still park the document");
    assert!(
        lookup_at < register_at || early.contains("take("),
        "a document parked for a window that is never opened must not be left in the store: look \
         before register(), or take() it on the early return:\n{before_build}"
    );
}

/// 7. (c) `existing_print_window` は `print.rs` の `pub fn` で、`is_print_window(` で判定する。
#[test]
fn existing_print_window_is_a_pub_fn_in_print_rs_built_on_is_print_window() {
    let code = print_module_code();
    let at = fn_definition(&code, "existing_print_window")
        .expect("print.rs must define existing_print_window");
    assert!(
        code[..at].ends_with("pub "),
        "existing_print_window must be pub (the tests and the command reach it)"
    );
    let body = fn_body(&code, "existing_print_window", "print.rs");
    assert!(
        body.contains("is_print_window(") || body.contains("PRINT_WINDOW_LABEL_PREFIX"),
        "existing_print_window must recognise print windows by the label rule (is_print_window):\n{body}"
    );
}

// ---------------------------------------------------------------------------
// 契約 1「新しい依存は足さない」— Cargo.toml の依存クレート名の集合が起案時点(2026-10-20)と同一
// (acceptance_req62a.rs が AppKit の features を固定するのと同じ流儀)
// ---------------------------------------------------------------------------

/// Cargo.toml の `section` の表にある依存クレート名(表の直下の `name = …` の `name`。コメント行と、
/// 複数行に割った `{ … }` / `[ … ]` の内側の行は除く)。
fn dependency_names(section: &str) -> BTreeSet<String> {
    let toml = include_str!("../Cargo.toml");
    let mut current = String::new();
    let mut names = BTreeSet::new();
    let mut depth = 0isize;
    for line in toml.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        let at_top = depth == 0;
        // 文字列の外の括弧だけ数える(値が次の行へ続いているかを知るため)。
        let mut in_str: Option<char> = None;
        for c in line.chars() {
            match in_str {
                Some(q) if c == q => in_str = None,
                Some(_) => {}
                None => match c {
                    '"' | '\'' => in_str = Some(c),
                    '{' | '[' => depth += 1,
                    '}' | ']' => depth -= 1,
                    '#' => break,
                    _ => {}
                },
            }
        }
        if !at_top {
            continue;
        }
        if line.starts_with('[') {
            current = line.to_string();
            depth = 0;
            continue;
        }
        if current == section {
            if let Some((name, _)) = line.split_once('=') {
                names.insert(name.trim().to_string());
            }
        }
    }
    names
}

/// 8. 依存の表(`[dependencies]`・macOS の表・`[dev-dependencies]`・`[build-dependencies]`)の
///    クレート名の集合が本追補の起案時点と同一(契約 1=新しい依存は足さない。追補n の印刷操作も
///    `objc2` の `msg_send!` / `define_class!` で足りる)。
#[test]
fn no_new_dependency_is_declared() {
    let expected: [(&str, &[&str]); 4] = [
        (
            "[dependencies]",
            &[
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
                "regex",
                "tauri-plugin-webdriver",
                "tauri-plugin-window-state",
            ],
        ),
        (
            "[target.'cfg(target_os = \"macos\")'.dependencies]",
            &["objc2", "objc2-app-kit", "objc2-foundation"],
        ),
        ("[dev-dependencies]", &["tempfile", "tauri", "muda"]),
        ("[build-dependencies]", &["tauri-build", "chrono"]),
    ];
    for (section, names) in expected {
        let want: BTreeSet<String> = names.iter().map(|s| s.to_string()).collect();
        let got = dependency_names(section);
        assert_eq!(
            got, want,
            "{section} must list exactly the crates it listed on 2026-10-20 (契約 1: no new dependency)"
        );
    }
}
