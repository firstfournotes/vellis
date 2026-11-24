//! 要件#74 第3段 3-5 の続き(ドロップの周回の差し戻しの直し)— アプリの窓に on_navigation の網を張る(Rust 層・ソース走査)
//! (docs/requirements/req-74.md 状態節 8d071ec の事後確認 (26)= オーケストレーターの判断)
//!
//! 何が起きたか・wry の on_navigation が呼ばれる範囲・判定の関数 `is_app_url` の契約と認める URL の集合は
//! `acceptance_req74_navigation_url.rs` の冒頭。本ファイルは、網が全部の窓に張られていることを読む。
//!
//! ## 網の張り方(どちらでもよい=確定契約)
//! - **G(推奨): Tauri の plugin の on_navigation で全部の webview に張る**。
//!   `src-tauri/src/window/navigation.rs` に `pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R>` を置き、
//!   `tauri::plugin::Builder::new(…).on_navigation(|webview, url| is_app_url(url, …))` で作る。`lib.rs` の `tauri::Builder` に
//!   **いつも**(`#[cfg]` / `if` / `match` の中でなく)`.plugin(…navigation::plugin())` で登録する。Tauri は窓ごとの handler の
//!   後に plugin の on_navigation を呼ぶので(tauri-2.10.3 `src/manager/webview.rs:548-575`)、設定の窓・Rust で作る窓・
//!   印刷の窓のどれにも掛かる(印刷の文書は `is_app_url` が認める)
//! - **P: 窓ごとに張る**。Rust で作る 3 か所(`commands/window.rs`・`ipc/handler.rs`・`self_check/mod.rs`)の作りの範囲
//!   (作る式から `.build(` / `.add_child(` の文の終わりまで= acceptance_req74_drag_drop.rs と同じ)に `.on_navigation(` と
//!   `is_app_url(`。設定の窓は Tauri が設定から作るので窓ごとの handler を付けられない= `lib.rs` で設定の窓を自分で作る
//!   (`WebviewWindowBuilder::from_config(` / `::new(` の作りの範囲に `.on_navigation(` と `is_app_url(`)
//! - どちらでも、判定は `is_app_url`(unit で値を固定)を通すこと(走査はその名前で読む)
//!
//! ## 判定するもの
//! 1. 設定の窓(`tauri.conf.json` の `app.windows`)に網がある(G か、lib.rs で自分で作る窓の P)
//! 2. Rust で作る 3 か所の窓に網がある(G か P)
//! 3. 印刷の窓(受け手を残す判断=事後確認 (24))には網を求めない。付けても赤にならない(本ファイルは印刷の窓を読まない・
//!    `is_app_url` は印刷の文書を認める= `acceptance_req74_navigation_url.rs`)
//! 5.(2026-11-20 照合の P3 の直し・N10)plugin の閉包は判定の関数 `allow_navigation` の答えをそのまま返す(本体がその
//!    呼び出しの値そのもの・`true` / `false` / `if` / `match` の字が無い)。契約と unit は acceptance_req74_navigation_log.rs
//! 6.(同・ログ)navigation.rs の tracing のログは URL を `redact_for_log(…)` を通してだけ出し(引数の `url`・書式の `{url}` を
//!    数える)、断ったときの `warn!` はその形で残る
//! 4. 前提: lib.rs が登録する独自のプロトコルは `vellis-asset` と印刷の `PRINT_SCHEME` の 2 つだけ(増えたら認める URL の
//!    集合を見直す)。走査の器が G の登録の条件(`#[cfg]`・`if`)とコメントの中の字、P の `is_app_url` の無い網を赤にする
//!
//! ## 赤になる理由(実装前)
//! - 1・2: `window/navigation.rs` が無く、lib.rs に navigation の plugin の登録も無く、3 か所の作りにも `.on_navigation(` が無い
//! - 4 と走査の器の自己検査は最初から緑
//! - (2026-11-20 足した 5・6)0494ebe の作りで赤: 5= navigation.rs に `allow_navigation` が無く、閉包は `{ let dev_url = if … ;
//!   let allowed = is_app_url(…); if !allowed { … } allowed }` の形(if と答えの束縛)。6= `tracing::warn!` が `url` を
//!   丸ごと出し(`redact_for_log` を通さない)、`redact_for_log` を通した warn も無い

use std::path::PathBuf;

// ---------------------------------------------------------------------------
// 共通ヘルパ(acceptance_req74_drag_drop.rs と同じ作り)
// ---------------------------------------------------------------------------

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_source(rel: &str) -> String {
    let path = manifest_dir().join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {}", path.display(), e))
}

fn read_optional(rel: &str) -> Option<String> {
    std::fs::read_to_string(manifest_dir().join(rel)).ok()
}

/// 行ごとに `//` 以降(コメント)を落とす。`://`(URL のリテラル)はコメントではないので落とさない。
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

fn squeeze(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

fn is_ident_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

fn find_bytes(hay: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if from > hay.len() {
        return None;
    }
    hay[from..].windows(needle.len()).position(|w| w == needle).map(|p| from + p)
}

/// コメントと、文字列・文字のリテラルの中身を空白にした写し(長さ・位置・改行は同じ)。
fn mask_code(src: &str) -> String {
    let b = src.as_bytes();
    let mut out = b.to_vec();
    let blank = |out: &mut Vec<u8>, from: usize, to: usize| {
        for byte in out.iter_mut().take(to.min(b.len())).skip(from) {
            if *byte != b'\n' {
                *byte = b' ';
            }
        }
    };
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let next = b.get(i + 1).copied();
        if c == b'/' && next == Some(b'/') {
            let end = find_bytes(b, i, b"\n").unwrap_or(b.len());
            blank(&mut out, i, end);
            i = end;
        } else if c == b'/' && next == Some(b'*') {
            let end = find_bytes(b, i + 2, b"*/").map_or(b.len(), |p| p + 2);
            blank(&mut out, i, end);
            i = end;
        } else if c == b'r' && matches!(next, Some(b'"') | Some(b'#')) && (i == 0 || !is_ident_byte(b[i - 1])) {
            let mut j = i + 1;
            let mut hashes = 0;
            while b.get(j) == Some(&b'#') {
                hashes += 1;
                j += 1;
            }
            if b.get(j) == Some(&b'"') {
                let mut close = vec![b'"'];
                close.extend(std::iter::repeat_n(b'#', hashes));
                let end = find_bytes(b, j + 1, &close).unwrap_or(b.len());
                blank(&mut out, j + 1, end);
                i = end + close.len();
            } else {
                i += 1;
            }
        } else if c == b'"' {
            let mut j = i + 1;
            while j < b.len() && b[j] != b'"' {
                if b[j] == b'\\' {
                    j += 1;
                }
                j += 1;
            }
            blank(&mut out, i + 1, j);
            i = j + 1;
        } else if c == b'\'' {
            if next == Some(b'\\') {
                let end = find_bytes(b, i + 3, b"'").unwrap_or(b.len());
                blank(&mut out, i + 1, end);
                i = end + 1;
            } else if b.get(i + 2) == Some(&b'\'') {
                blank(&mut out, i + 1, i + 2);
                i += 3;
            } else {
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    String::from_utf8(out).expect("masking keeps UTF-8")
}

/// `open`(`(` / `[` / `{` の位置)に対応する閉じ括弧の位置(`mask_code` 済みのコードで数える)。
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

fn statement_start(code: &str, floor: usize, pos: usize) -> usize {
    code[floor..pos].rfind([';', '{', '}']).map_or(floor, |p| floor + p + 1)
}

fn tokens(s: &str) -> Vec<&str> {
    s.split(|c: char| !(c.is_alphanumeric() || c == '_')).filter(|t| !t.is_empty()).collect()
}

/// `pos` を含むいちばん内側の関数の本体(`{` の次から `}` の手前まで)。
fn enclosing_fn_body(code: &str, pos: usize) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    let mut search = 0;
    while let Some(p) = code[search..].find("fn ") {
        let at = search + p;
        search = at + 3;
        if at > 0 && is_ident_byte(code.as_bytes()[at - 1]) {
            continue;
        }
        let Some(open) = code[at..].find('{').map(|q| at + q) else {
            continue;
        };
        if open > pos {
            continue;
        }
        let close = matching_close(code, open);
        if close > pos && best.is_none_or(|(o, c)| close - open < c - o) {
            best = Some((open + 1, close));
        }
    }
    best
}

/// `pos` がいつも走るところにあるか(包むブロックに `if` / `else` / `match` / 腕が無く、文に `#[cfg` が無い)。
fn runs_always(code: &str, pos: usize) -> bool {
    let Some((body_start, _)) = enclosing_fn_body(code, pos) else {
        return false;
    };
    let body = &code[body_start..pos];
    let mut stack: Vec<usize> = Vec::new();
    for (i, c) in body.char_indices() {
        match c {
            '{' => stack.push(i),
            '}' => {
                stack.pop();
            }
            _ => {}
        }
    }
    let headers_ok = stack.iter().all(|&brace| {
        let header = &body[statement_start(body, 0, brace)..brace];
        !tokens(header).iter().any(|t| matches!(*t, "if" | "else" | "match")) && !header.contains("=>")
    });
    let statement = &body[statement_start(body, 0, body.len())..];
    headers_ok && !statement.contains("#[cfg") && !statement.contains("#![cfg")
}

// ---------------------------------------------------------------------------
// 網の読み方
// ---------------------------------------------------------------------------

const NAV_MODULE: &str = "src/window/navigation.rs";

/// G: navigation.rs の plugin が on_navigation で is_app_url を通し、lib.rs がいつもそれを `.plugin(` で登録する。
fn plugin_net_in(lib_src: &str, nav_src: Option<&str>) -> Result<(), String> {
    let nav = nav_src.ok_or_else(|| format!("{NAV_MODULE} が無い"))?;
    let nav_code = squeeze(&mask_code(nav));
    if !nav_code.contains(".on_navigation(") {
        return Err(format!("{NAV_MODULE} に .on_navigation( が無い"));
    }
    if !nav_code.contains("is_app_url(") {
        return Err(format!("{NAV_MODULE} の網が is_app_url( を通さない"));
    }
    let code = mask_code(lib_src);
    let mut registrations = Vec::new();
    let mut search = 0;
    while let Some(p) = code[search..].find(".plugin(") {
        let at = search + p;
        search = at + ".plugin(".len();
        let open = at + ".plugin".len();
        let close = matching_close(&code, open);
        if squeeze(&code[open + 1..close]).contains("navigation::plugin(") {
            registrations.push(at);
        }
    }
    if registrations.is_empty() {
        return Err("lib.rs が navigation::plugin() を .plugin( で登録していない".to_string());
    }
    if registrations.iter().any(|&at| runs_always(&code, at)) {
        Ok(())
    } else {
        Err("lib.rs の navigation::plugin() の登録が #[cfg] / if / match の中にある(いつも登録すること)".to_string())
    }
}

fn plugin_net() -> Result<(), String> {
    plugin_net_in(&read_source("src/lib.rs"), read_optional(NAV_MODULE).as_deref())
}

const BUILDER_CALLS: [&str; 4] = [
    "WebviewWindowBuilder::new(",
    "WebviewWindowBuilder::from_config(",
    "WebviewBuilder::new(",
    "WebviewBuilder::from_config(",
];
const BUILD_CALLS: [&str; 2] = [".build(", ".add_child("];

/// 作る式から、作る呼び出しの文の終わりまで(acceptance_req74_drag_drop.rs の sites_in と同じ範囲)。
fn builder_regions(code: &str) -> Vec<String> {
    let mut out: Vec<(usize, String)> = Vec::new();
    for kind in BUILDER_CALLS {
        let mut search = 0;
        while let Some(pos) = code[search..].find(kind) {
            let start = search + pos;
            search = start + kind.len();
            if code[..start].chars().next_back().is_some_and(|c| c.is_alphanumeric() || c == '_') {
                continue;
            }
            let rest = &code[start..];
            let Some(build_at) = BUILD_CALLS.iter().filter_map(|t| rest.find(t)).min() else {
                continue;
            };
            let end = rest[build_at..].find(';').map_or(rest.len(), |i| build_at + i + 1);
            out.push((start, rest[..end].to_string()));
        }
    }
    out.sort_by_key(|(at, _)| *at);
    out.into_iter().map(|(_, r)| r).collect()
}

/// P: その作りの範囲に `.on_navigation(` と `is_app_url(` がある。
fn region_has_net(region: &str) -> bool {
    let r = squeeze(region);
    r.contains(".on_navigation(") && r.contains("is_app_url(")
}

fn file_regions(rel: &str) -> Vec<String> {
    builder_regions(&strip_line_comments(&read_source(rel)))
}

// ---------------------------------------------------------------------------
// 4. 走査の器と前提
// ---------------------------------------------------------------------------

/// 走査の器の自己検査: G の登録の条件とコメント、P の is_app_url の無い網を読み分ける。
#[test]
fn the_navigation_scan_reads_the_plugin_and_the_per_window_nets() {
    let nav = "use tauri::plugin::{Builder, TauriPlugin};\n\
               pub fn plugin<R: tauri::Runtime>() -> TauriPlugin<R> {\n\
                   Builder::new(\"vellis-navigation\").on_navigation(|_w, url| is_app_url(url, None)).build()\n\
               }\n";
    let nav_without_check = "pub fn plugin<R: tauri::Runtime>() -> TauriPlugin<R> {\n\
                                 Builder::new(\"vellis-navigation\").on_navigation(|_w, _url| true).build()\n\
                             }\n";
    let lib_always = "pub fn run_app() {\n\
                          let builder = tauri::Builder::default()\n\
                              .plugin(tauri_plugin_opener::init())\n\
                              .plugin(window::navigation::plugin());\n\
                          builder.run(ctx);\n\
                      }\n";
    let lib_cfg = "pub fn run_app() {\n\
                       let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());\n\
                       #[cfg(feature = \"webdriver\")]\n\
                       let builder = builder.plugin(crate::window::navigation::plugin());\n\
                       builder.run(ctx);\n\
                   }\n";
    let lib_if = "pub fn run_app(on: bool) {\n\
                      let mut builder = tauri::Builder::default();\n\
                      if on {\n\
                          builder = builder.plugin(window::navigation::plugin());\n\
                      }\n\
                      builder.run(ctx);\n\
                  }\n";
    let lib_comment = "pub fn run_app() {\n\
                           // .plugin(window::navigation::plugin())\n\
                           let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());\n\
                           let note = \".plugin(window::navigation::plugin())\";\n\
                       }\n";
    assert_eq!(plugin_net_in(lib_always, Some(nav)), Ok(()));
    assert!(plugin_net_in(lib_always, None).is_err(), "navigation.rs が無い");
    assert!(plugin_net_in(lib_always, Some(nav_without_check)).is_err(), "is_app_url を通さない網");
    assert!(plugin_net_in(lib_cfg, Some(nav)).is_err(), "#[cfg] の中の登録");
    assert!(plugin_net_in(lib_if, Some(nav)).is_err(), "if の中の登録");
    assert!(plugin_net_in(lib_comment, Some(nav)).is_err(), "コメントと文字列の中の字");

    let per_window = "fn a(app: &AppHandle) {\n\
                          let builder = WebviewWindowBuilder::new(app, \"a\", WebviewUrl::default())\n\
                              .disable_drag_drop_handler()\n\
                              .on_navigation(move |url| is_app_url(url, dev.as_ref()));\n\
                          builder.build();\n\
                      }\n\
                      fn b(app: &AppHandle) {\n\
                          WebviewWindowBuilder::new(app, \"b\", WebviewUrl::default()).on_navigation(|_| true).build();\n\
                      }\n\
                      fn c(app: &AppHandle) {\n\
                          WebviewWindowBuilder::new(app, \"c\", WebviewUrl::default()).build();\n\
                          let later = other.on_navigation(|u| is_app_url(u, None));\n\
                      }\n";
    let got: Vec<bool> = builder_regions(&strip_line_comments(per_window)).iter().map(|r| region_has_net(r)).collect();
    assert_eq!(got, vec![true, false, false], "a: 網あり / b: is_app_url の無い網 / c: .build( の後の指定は数えない");
}

/// 前提: lib.rs が登録する独自のプロトコルは `vellis-asset` と `PRINT_SCHEME`(vellis-print)だけ
/// (`is_app_url` の認める集合はこの 2 つを含む。増えたら集合を見直す)。
#[test]
fn the_app_registers_only_the_custom_protocols_the_allowed_set_covers() {
    let code = strip_line_comments(&read_source("src/lib.rs"));
    let mut schemes = Vec::new();
    for call in ["register_asynchronous_uri_scheme_protocol(", "register_uri_scheme_protocol("] {
        let mut search = 0;
        while let Some(p) = code[search..].find(call) {
            let at = search + p + call.len();
            search = at;
            if code[..at - call.len()].chars().next_back().is_some_and(|c| c.is_alphanumeric() || c == '_') {
                continue;
            }
            let arg = code[at..].split(',').next().unwrap_or("").trim().to_string();
            schemes.push(arg);
        }
    }
    schemes.sort();
    assert_eq!(
        schemes,
        vec!["\"vellis-asset\"".to_string(), "PRINT_SCHEME".to_string()],
        "lib.rs registers a custom protocol the navigation net has not been checked against"
    );
    assert_eq!(vellis_lib::print::PRINT_SCHEME, "vellis-print");
}

/// 前提: Rust で作る 3 か所の窓が走査の網に入る(印刷の窓は読まない=判定 3)。
#[test]
fn the_scan_finds_the_three_windows_that_load_the_app_page() {
    for rel in ["src/commands/window.rs", "src/ipc/handler.rs", "src/self_check/mod.rs"] {
        assert_eq!(file_regions(rel).len(), 1, "{rel} builds exactly one webview window");
    }
}

// ---------------------------------------------------------------------------
// 1・2. 網がある
// ---------------------------------------------------------------------------

/// 1. 設定の窓(tauri.conf.json の app.windows= Tauri が設定から作る窓)は、アプリ自身の URL のほかへ移らない。
#[test]
fn the_configured_window_refuses_navigation_away_from_the_app() {
    let plugin = plugin_net();
    let lib_regions = file_regions("src/lib.rs");
    let manual = lib_regions.iter().any(|r| region_has_net(r));
    assert!(
        plugin.is_ok() || manual,
        "the window tauri.conf.json describes must refuse navigation away from the app's own URLs: \
         register `window::navigation::plugin()` (on_navigation through is_app_url) in lib.rs, or build that window \
         in lib.rs with `.on_navigation(` through `is_app_url(`. plugin: {plugin:?}; windows built in lib.rs: {}",
        lib_regions.len()
    );
}

/// 2. Rust で作る 3 か所の窓(New Window・CLI の IPC・self-check)は、アプリ自身の URL のほかへ移らない。
#[test]
fn every_window_that_loads_the_app_page_refuses_navigation_away_from_the_app() {
    let plugin = plugin_net();
    if plugin.is_ok() {
        return;
    }
    let offenders: Vec<String> = ["src/commands/window.rs", "src/ipc/handler.rs", "src/self_check/mod.rs"]
        .iter()
        .flat_map(|rel| {
            file_regions(rel)
                .into_iter()
                .filter(|r| !region_has_net(r))
                .map(move |r| format!("{rel}: {}", r.lines().next().unwrap_or("").trim()))
        })
        .collect();
    assert!(
        offenders.is_empty(),
        "these windows must refuse navigation away from the app's own URLs (the plugin net is absent: {plugin:?}); \
         add `.on_navigation(` through `is_app_url(` before building:\n{offenders:#?}"
    );
}

// ---------------------------------------------------------------------------
// 5・6. 照合の P3 の直し(2026-11-20): 網の答えをそのまま返す(N10)・断ったときのログに URL を丸ごと出さない
// (判定の関数 allow_navigation と redact_for_log の契約と unit は acceptance_req74_navigation_log.rs の冒頭)
// ---------------------------------------------------------------------------

/// `.on_navigation(` の引数(閉包)を全部集める(`mask_code` 済みのコードから)。
fn on_navigation_closures(code: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut search = 0;
    while let Some(p) = code[search..].find(".on_navigation(") {
        let at = search + p;
        search = at + ".on_navigation(".len();
        let open = at + ".on_navigation".len();
        let close = matching_close(code, open);
        out.push(code[open + 1..close].to_string());
    }
    out
}

/// 閉包の本体が `allow_navigation(…)` の呼び出しの値そのもの(`{ … }` がその式 1 つだけを包むのも可・`-> bool` も可)。
/// 閉包のどこにも `true` / `false` / `if` / `match` の字が無い。
fn returns_allow_navigation_as_it_is(closure: &str) -> bool {
    if tokens(closure).iter().any(|t| matches!(*t, "true" | "false" | "if" | "match")) {
        return false;
    }
    let mut c = closure.trim();
    if let Some(rest) = c.strip_prefix("move") {
        c = rest.trim_start();
    }
    let Some(rest) = c.strip_prefix('|') else {
        return false;
    };
    let Some(bar) = rest.find('|') else {
        return false;
    };
    let mut body = rest[bar + 1..].trim();
    if body.starts_with("->") {
        let Some(brace) = body.find('{') else {
            return false;
        };
        body = body[brace..].trim();
    }
    if body.starts_with('{') {
        let close = matching_close(body, 0);
        if close != body.len() - 1 {
            return false;
        }
        body = body[1..close].trim();
    }
    let Some(after) = body.strip_prefix("allow_navigation") else {
        return false;
    };
    if !after.starts_with('(') {
        return false;
    }
    let open = "allow_navigation".len();
    matching_close(body, open) == body.len() - 1
}

/// navigation.rs の tracing のマクロ(`warn!` などの呼び出し)の、コメントの外のもの: (マクロの名前, 原文の引数, 伏せ字の引数)。
fn tracing_macros(src: &str) -> Vec<(String, String, String)> {
    let masked = mask_code(src);
    let mut out = Vec::new();
    for name in ["warn!(", "error!(", "info!(", "debug!(", "trace!("] {
        let mut search = 0;
        while let Some(p) = masked[search..].find(name) {
            let at = search + p;
            search = at + name.len();
            if masked[..at].chars().next_back().is_some_and(|c| c.is_alphanumeric() || c == '_') {
                continue;
            }
            let open = at + name.len() - 1;
            let close = matching_close(&masked, open);
            out.push((name.trim_end_matches('(').to_string(), src[open + 1..close].to_string(), masked[open + 1..close].to_string()));
        }
    }
    out
}

/// ログのマクロの引数のうち、`redact_for_log(…)` の外で URL(名前 `url`)を出しているもの。
/// 引数としての `url`(`url`・`url.as_str()`・`url.path()` など)と、書式の文字列の中の `{url}` / `{url:?}` を数える。
fn log_leaks(src: &str) -> Vec<String> {
    let mut leaks = Vec::new();
    for (name, original, masked) in tracing_macros(src) {
        let mut outside = masked.clone();
        let mut search = 0;
        while let Some(p) = masked[search..].find("redact_for_log(") {
            let at = search + p;
            let open = at + "redact_for_log".len();
            let close = matching_close(&masked, open);
            outside.replace_range(at..=close, &" ".repeat(close + 1 - at));
            search = close + 1;
        }
        let as_argument = tokens(&outside).contains(&"url");
        let inline = original.match_indices("{url").any(|(i, m)| {
            matches!(original[i + m.len()..].chars().next(), Some('}') | Some(':'))
        });
        if as_argument || inline {
            leaks.push(format!("{name}({})", original.trim()));
        }
    }
    leaks
}

/// 断ったときのログ(`warn!`)が、`redact_for_log(` を通して残っている。
fn logs_refusal_redacted(src: &str) -> bool {
    tracing_macros(src).iter().any(|(name, _, masked)| name.ends_with("warn!") && masked.contains("redact_for_log("))
}

/// 走査の器の自己検査: 閉包の形と、ログの URL の出し方を読み分ける。
#[test]
fn the_shape_scan_reads_the_closure_and_the_log() {
    for (closure, expected) in [
        ("|webview, url| allow_navigation(url, dev_of(webview))", true),
        ("move |w, url| { allow_navigation(url, dev_of(w)) }", true),
        ("|_w, url| -> bool { allow_navigation(url, None) }", true),
        ("|webview: &tauri::Webview<R>, url: &Url| allow_navigation(url, dev_of(webview))", true),
        ("|webview, url| { let allowed = is_app_url(url, None); allowed }", false),
        ("|_, url| allow_navigation(url, None) || true", false),
        ("|_, _| true", false),
        ("|w, url| if on { allow_navigation(url, None) } else { true }", false),
        ("|_, url| { allow_navigation(url, None); true }", false),
        ("|_, url| !allow_navigation(url, None)", false),
        ("|_, url| allow_navigation(url, if dev { None } else { None })", false),
        ("|_, url| is_app_url(url, None)", false),
    ] {
        assert_eq!(returns_allow_navigation_as_it_is(closure), expected, "{closure}");
    }

    let good = "pub fn allow_navigation(url: &Url, dev_url: Option<&Url>) -> bool {\n\
                    let allowed = is_app_url(url, dev_url);\n\
                    // tracing::warn!(\"refused {}\", url);\n\
                    if !allowed { tracing::warn!(\"navigation refused: {} is not one of the app's own URLs\", redact_for_log(url)); }\n\
                    allowed\n\
                }\n";
    assert!(log_leaks(good).is_empty(), "{:?}", log_leaks(good));
    assert!(logs_refusal_redacted(good));
    for leaky in [
        "fn f(url: &Url) { tracing::warn!(\"refused {url}\"); }",
        "fn f(url: &Url) { warn!(\"refused {}\", url); }",
        "fn f(url: &Url) { tracing::warn!(\"refused {}\", url.as_str()); }",
        "fn f(url: &Url) { tracing::warn!(\"refused {:?} ({})\", url, redact_for_log(url)); }",
        "fn f(url: &Url) { tracing::info!(\"checking {url:?}\"); }",
        "fn f(url: &Url) { tracing::debug!(\"path {}\", url.path()); }",
    ] {
        assert_eq!(log_leaks(leaky).len(), 1, "{leaky}");
    }
    assert!(!logs_refusal_redacted("fn f(url: &Url) { tracing::info!(\"x {}\", redact_for_log(url)); }"), "warn でない");
    assert!(!logs_refusal_redacted("fn f() {}"), "ログが無い");
}

/// 5(N10). plugin の閉包は、判定の関数 `allow_navigation` の答えをそのまま返す(常に true を返す・答えを捨てる・if で包む
/// 形にすると網全体が黙って消える)。`allow_navigation` は navigation.rs の pub fn。
#[test]
fn the_plugin_returns_the_answer_of_allow_navigation_as_it_is() {
    let nav = read_optional(NAV_MODULE).unwrap_or_else(|| panic!("{NAV_MODULE} must exist"));
    let code = mask_code(&nav);
    assert!(
        squeeze(&code).contains("pubfnallow_navigation("),
        "{NAV_MODULE} must define `pub fn allow_navigation(url: &Url, dev_url: Option<&Url>) -> bool`"
    );
    let closures = on_navigation_closures(&code);
    assert!(!closures.is_empty(), "{NAV_MODULE} must put the net on with .on_navigation(");
    let wrong: Vec<String> = closures
        .iter()
        .filter(|c| !returns_allow_navigation_as_it_is(c))
        .map(|c| c.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect();
    assert!(
        wrong.is_empty(),
        "the on_navigation closure must return the answer of allow_navigation(…) as it is \
         (e.g. `|webview, url| allow_navigation(url, dev_of(webview))`; no true / false / if / match): {wrong:#?}"
    );
}

/// 6(ログ). navigation.rs のログは URL を `redact_for_log(…)` を通してだけ出し(scheme だけ・http(s) は host まで)、断った
/// ときの warn はその形で残る。
#[test]
fn every_log_in_the_net_shows_the_url_only_through_redact_for_log() {
    let nav = read_optional(NAV_MODULE).unwrap_or_else(|| panic!("{NAV_MODULE} must exist"));
    let leaks = log_leaks(&nav);
    assert!(
        leaks.is_empty(),
        "the net must not log a whole URL (a dropped file's path, an outside page's query); \
         pass it through redact_for_log(url): {leaks:#?}"
    );
    assert!(
        logs_refusal_redacted(&nav),
        "the refusal must still be logged with tracing::warn!, through redact_for_log(url)"
    );
}
