//! 要件#74 第3段 3-5 の続き — Tauri の drag-drop の受け手を切る(Rust 層・ソース走査)
//! (docs/requirements/req-74.md 状態節「2026-11-20 夜 再照合と実機の用意」の由谷の決定 20:20・
//!  2026-11-20 21:00〜21:25 の実機=ビルド local 2846c6e)
//!
//! ## 何が起きたか
//! 3-5(編集面へのドロップとドラッグ)が実機で動かない。面の中で語を引きずっても動かず
//! (dragstart は出る)、外から落とした文字・HTML がページに届かない。Tauri の drag-drop の受け手が
//! 既定で有効で、wry がどのドラッグも受け取り WKWebView に渡さないため
//! (wry-0.54.4 `src/wkwebview/class/wry_web_view.rs:79-106`・`drag_drop.rs`/
//!  tauri-runtime-wry-2.10.1 `lib.rs:4669-4702`)。`tauri.conf.json` の窓に `dragDropEnabled` が無く、
//! Rust の窓の作りに `disable_drag_drop_handler()` が無い。src にも src-tauri にも DragDrop の受け口は無い
//! (受け手は何にも使われていない)。
//! 由谷の決定(2026-11-20 20:20): 実機で確かめてから直す。赤なら設定を切る。ファイルを落としたときに
//! 窓の中身がそのファイルに切り替わらないことも守る(ページの側= `src/components/file-drop-guard.wiring.test.ts`)。
//!
//! ## 判定するもの
//! 1. 設定の窓(`tauri.conf.json` の `app.windows`)は**実行時に**切る(案 B・2026-11-20 オーケストレーターの判断):
//!    - 1a. `src-tauri/src/lib.rs` の `tauri::generate_context!()` を持つ関数の中で、`context.config_mut().app.windows` の
//!      全部の窓に `.drag_drop_enabled = false` を入れる。**いつも**(self-check のときに限らず)= その代入が `if` /
//!      `else` / `match` の中(self-check の分岐など)に無い。全部の窓= 代入が `app.windows`(か、それを束縛した名前)を
//!      回す `for` / `iter_mut` の中にある(`windows[0]` だけは不可)。コメントと文字列の中の字は数えない
//!    - 1b. `tauri.conf.json` の `app.windows` は今のまま= どの窓にも `dragDropEnabled` の項目を足していない
//! 2.`src-tauri/src/**/*.rs` で webview の窓を作る式(`WebviewWindowBuilder::new(` /
//!    `WebviewWindowBuilder::from_config(` / `WebviewBuilder::new(` / `WebviewBuilder::from_config(`)を全部拾い、
//!    アプリのページを載せる窓(印刷の窓のほか全部)の作りに切る指定がある:
//!    - その式から、作る呼び出し(`.build(` か `.add_child(`)の文の終わりまでの間に `.disable_drag_drop_handler()`
//!      (連鎖の中でも、`let builder = builder.disable_drag_drop_handler();` のような後からの指定でもよい)
//!    - `from_config(` は、同じ関数の中で渡す設定に `.drag_drop_enabled = false` を入れてもよい(設定の側の切り方)
//! 3. 印刷の窓(`print.rs`)は、落としたファイルへ移らない: 受け手を残す(切らない)か、切るなら同じ作りに
//!    `.on_navigation(`(印刷の文書の外へ移らない)を持つ
//! 4. 走査の前提: 既知の 4 か所(`commands/window.rs`・`ipc/handler.rs`・`print.rs`・`self_check/mod.rs` の
//!    `from_config`)が網に入る。走査の器が両方の切り方を読み分け、`.build(` の後の指定は数えない。1a の走査の器が
//!    self-check の分岐の中だけの代入・1 つの窓だけの代入・条件の中の代入・コメントと文字列の中の字を赤にする
//!
//! ## 案 B を選んだ理由(2026-11-20 オーケストレーターの判断・bc3cade の判定 1 の書き直し)
//! 初めの判定 1 は `tauri.conf.json` の窓に `"dragDropEnabled": false` を足す形だったが、既存の受け入れテスト 2 件が
//! `tauri.conf.json` を固定していて、項目を足すと赤になる(既存の受け入れテストは書き換えない):
//! - `src/lib/ui-invariants.acceptance.test.ts:420`(AC-56-15): `app.windows[0]` を `toEqual` で比べる
//! - `src-tauri/tests/acceptance_req74.rs:471`(契約19-18 の ac74_23): `tauri.conf.json` の SHA-256 を固定する
//! そこで `tauri.conf.json` は変えず、`lib.rs` が起動時に `context.config_mut().app.windows` を書き換えているところ
//! (今は self-check のときの `create = false`)で、全部の窓の `drag_drop_enabled` を false にする。1b はその前提
//! (設定の側は今のまま)を固定する(既存の固定と重なってよい)
//!
//! ## 判断(test-writer 2026-11-20)
//! - **self_check の窓は切る**: 利用者の窓と同じページ・同じ大きさと権限で作る窓(要件#72 契約3)なので、
//!   利用者の窓と同じく切る。設定(`tauri.conf.json` の最初の窓)の写しから作るので設定の側でも切れるが、
//!   取りこぼしを防ぐため作りの場所に明示の指定を求める(2 の `from_config` の 2 つの書き方のどちらか)
//! - **印刷の窓は一律に切らない(3 の書き方)**: 印刷の窓はアプリの JavaScript を持たず(CSP で script が走らない・
//!   print.rs の冒頭)、ドロップを受ける場所も無い。受け手を切ると、ページの側でファイルのドロップを止める手段が
//!   無いので、落としたファイルを WKWebView が開き、印刷の窓の中身がそのファイルに切り替わる。受け手を残せば
//!   wry がドラッグを飲み込むので中身は変わらない。一律に切るなら `.on_navigation(` で印刷の文書の外へ移らない
//!   ようにすること(3 はその書き方も緑にする)
//!
//! ## 赤になる理由(実装前)
//! - 1a: `lib.rs` に `drag_drop_enabled = false` の代入が無い(設定の窓は既定の true のまま作られる)
//! - 2: `commands/window.rs`・`ipc/handler.rs`・`self_check/mod.rs` の 3 か所に切る指定が無い
//! - 1b・3・4 と走査の器の自己検査は最初から緑(1b は設定の側を今のままにする守り・3 は印刷の窓が今は受け手を
//!   残しているので緑=守り)

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// 共通ヘルパ(acceptance_req62.rs と同じ流儀=ソースの読み込み・コメント落とし)
// ---------------------------------------------------------------------------

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_source(rel: &str) -> String {
    let path = manifest_dir().join(rel);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {}", path.display(), e))
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

/// `src-tauri/src/**/*.rs` を再帰的に集める(相対パス・ソート済み)。
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
                out.push((rel, src));
            }
        }
    }
    let base = manifest_dir().join("src");
    let mut out = Vec::new();
    walk(&base, &base, &mut out);
    out
}

/// 空白(改行を含む)を全部落とす(`.disable_drag_drop_handler( )` や改行をまたぐ書き方を同じに読む)。
fn squeeze(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

// ---------------------------------------------------------------------------
// webview の窓を作る場所の走査
// ---------------------------------------------------------------------------

/// webview の窓を作る式の頭(パスの前置き `tauri::` などは部分一致で拾う)。
const BUILDER_CALLS: [&str; 4] = [
    "WebviewWindowBuilder::new(",
    "WebviewWindowBuilder::from_config(",
    "WebviewBuilder::new(",
    "WebviewBuilder::from_config(",
];

/// 作る呼び出し(この文の終わりまでが、その窓の作りの範囲)。
const BUILD_CALLS: [&str; 2] = [".build(", ".add_child("];

/// 印刷の窓を作るファイル(判断: 一律には切らない=判定 3)。
const PRINT_FILE: &str = "print.rs";

#[derive(Debug)]
struct Site {
    file: String,
    /// `BUILDER_CALLS` のどれで拾ったか。
    kind: &'static str,
    /// コード(コメント落とし後)の中の位置(並べ替えと表示用)。
    at: usize,
    /// 作る式から、作る呼び出しの文の終わり(次の `;`)まで。
    region: String,
    /// 作る式を含む関数の頭(`fn `)から作る式の手前まで(`from_config` に渡す設定の用意を読む)。
    before: String,
}

impl Site {
    fn describe(&self) -> String {
        let head: String = self.region.lines().next().unwrap_or("").trim().chars().take(120).collect();
        format!("{} @{}: {}", self.file, self.at, head)
    }
}

/// コード 1 本の中の作る場所を全部拾う。
fn sites_in(file: &str, code: &str) -> Vec<Site> {
    let mut out = Vec::new();
    for kind in BUILDER_CALLS {
        let mut search = 0;
        while let Some(pos) = code[search..].find(kind) {
            let start = search + pos;
            search = start + kind.len();
            // `WebviewWindowBuilder::new(` の中の `WindowBuilder::new(` のような、名前の途中での一致は数えない
            let prev = code[..start].chars().next_back();
            if prev.is_some_and(|c| c.is_alphanumeric() || c == '_') {
                continue;
            }
            let rest = &code[start..];
            let build_at = BUILD_CALLS
                .iter()
                .filter_map(|t| rest.find(t))
                .min()
                .unwrap_or_else(|| panic!("{file}: {kind} の後に .build( / .add_child( が無い(走査の前提)"));
            let end = rest[build_at..]
                .find(';')
                .map(|i| build_at + i + 1)
                .unwrap_or(rest.len());
            let fn_start = code[..start].rfind("fn ").unwrap_or(0);
            out.push(Site {
                file: file.to_string(),
                kind,
                at: start,
                region: rest[..end].to_string(),
                before: code[fn_start..start].to_string(),
            });
        }
    }
    out.sort_by_key(|s| s.at);
    out
}

/// `src-tauri/src/**` の作る場所全部(ファイル順・位置順)。
fn all_sites() -> Vec<Site> {
    all_rust_sources()
        .into_iter()
        .flat_map(|(rel, src)| sites_in(&rel, &strip_line_comments(&src)))
        .collect()
}

/// その作りで Tauri の drag-drop の受け手を切っている。
fn cuts_drag_drop(site: &Site) -> bool {
    let in_builder = squeeze(&site.region).contains(".disable_drag_drop_handler()");
    let in_config = site.kind.ends_with("from_config(")
        && squeeze(&site.before).contains(".drag_drop_enabled=false");
    in_builder || in_config
}

// ---------------------------------------------------------------------------
// 4. 走査の器と前提
// ---------------------------------------------------------------------------

/// 走査の器の自己検査: 連鎖の中・後からの指定・設定の側の切り方を読み、`.build(` の後の指定は数えない。
#[test]
fn the_scan_reads_both_ways_of_cutting_and_stops_at_the_build_call() {
    let code = r#"
fn a(app: &AppHandle) {
    let builder = WebviewWindowBuilder::new(app, "a", WebviewUrl::default()).title("a");
    let builder = builder
        .disable_drag_drop_handler( );
    builder.build();
}
fn b(app: &AppHandle) {
    WebviewWindowBuilder::new(app, "b", WebviewUrl::default()).title("b").build();
    let other = something().disable_drag_drop_handler();
}
fn c(app: &AppHandle, config: &WindowConfig) -> tauri::Result<()> {
    let mut config = config.clone();
    config.drag_drop_enabled = false;
    let builder = tauri::WebviewWindowBuilder::from_config(app, &config)?;
    builder.build()?;
    Ok(())
}
fn d(app: &AppHandle, config: &WindowConfig) -> tauri::Result<()> {
    let builder = tauri::WebviewWindowBuilder::from_config(app, config)?;
    builder.build()?;
    Ok(())
}
fn e(window: &Window) {
    let child = tauri::webview::WebviewBuilder::new("e", WebviewUrl::default());
    window.add_child(child.disable_drag_drop_handler(), pos, size);
}
fn f(app: &AppHandle) {
    let builder = WebviewWindowBuilder::new(app, "f", WebviewUrl::default())
        .drag_drop_enabled = false;
    builder.build();
}
"#;
    let sites = sites_in("x.rs", code);
    let got: Vec<(&str, bool)> = sites.iter().map(|s| (s.kind, cuts_drag_drop(s))).collect();
    assert_eq!(
        got,
        vec![
            ("WebviewWindowBuilder::new(", true),          // a: 後からの指定
            ("WebviewWindowBuilder::new(", false),         // b: .build( の後の指定は数えない
            ("WebviewWindowBuilder::from_config(", true),  // c: 設定の側で切る
            ("WebviewWindowBuilder::from_config(", false), // d: 切る指定なし
            ("WebviewBuilder::new(", true),                // e: 子の webview(add_child)
            ("WebviewWindowBuilder::new(", false),         // f: new( に設定の側の切り方は効かない
        ],
        "{sites:#?}"
    );
}

/// 走査が空振りしていない: 既知の 4 か所(New Window・CLI の IPC・印刷・self-check の from_config)が網に入る。
#[test]
fn the_builder_scan_finds_every_known_window() {
    let sites = all_sites();
    let files: BTreeSet<&str> = sites.iter().map(|s| s.file.as_str()).collect();
    for expected in ["commands/window.rs", "ipc/handler.rs", "print.rs", "self_check/mod.rs"] {
        assert!(
            files.contains(expected),
            "a webview window builder must be found in {expected} (found in: {files:?})"
        );
    }
    assert!(
        sites
            .iter()
            .any(|s| s.file == "self_check/mod.rs" && s.kind == "WebviewWindowBuilder::from_config("),
        "self_check/mod.rs builds its window with WebviewWindowBuilder::from_config(: {sites:#?}"
    );
}

// ---------------------------------------------------------------------------
// 1. 設定の窓は実行時に切る(案 B)— lib.rs の context.config_mut().app.windows の書き換え
// ---------------------------------------------------------------------------

fn is_ident_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

fn find_bytes(hay: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if from > hay.len() {
        return None;
    }
    hay[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| from + p)
}

/// コメント(`//…`・`/*…*/`)と、文字列・文字のリテラルの中身を空白にした写し(長さ・位置・改行は同じ)。
/// 括弧の対応と字の並びを、コメントとリテラルに惑わされずに読む。
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
                i += 1; // ライフタイム
            }
        } else {
            i += 1;
        }
    }
    String::from_utf8(out).expect("masking keeps UTF-8 (only ASCII bytes are replaced at ASCII boundaries)")
}

/// `open`(`{` の位置)に対応する `}` の位置(`mask_code` 済みのコードで数える)。
fn matching_brace(code: &str, open: usize) -> usize {
    let mut depth = 0usize;
    for (i, c) in code[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return open + i;
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced brace starting at byte {open}");
}

/// `tauri::generate_context!()` を含む関数の本体(`{` の次から `}` の手前まで)の範囲。
fn context_fn_body(code: &str) -> (usize, usize) {
    let gc = code
        .find("generate_context!")
        .expect("lib.rs must call tauri::generate_context!()");
    let mut best: Option<(usize, usize)> = None;
    let mut search = 0;
    while let Some(pos) = code[search..].find("fn ") {
        let at = search + pos;
        search = at + 3;
        if at > 0 && is_ident_byte(code.as_bytes()[at - 1]) {
            continue;
        }
        let Some(open) = code[at..].find('{').map(|p| at + p) else {
            continue;
        };
        if open > gc {
            continue;
        }
        let close = matching_brace(code, open);
        if close > gc && best.is_none_or(|(o, c)| close - open < c - o) {
            best = Some((open, close));
        }
    }
    let (open, close) = best.expect("generate_context!() must sit inside a fn body");
    (open + 1, close)
}

/// `pos` の直前の文の区切り(`;` / `{` / `}`)の次の位置(`floor` より前には戻らない)。
fn statement_start(code: &str, floor: usize, pos: usize) -> usize {
    code[floor..pos]
        .rfind([';', '{', '}'])
        .map_or(floor, |p| floor + p + 1)
}

fn tokens(s: &str) -> Vec<&str> {
    s.split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|t| !t.is_empty())
        .collect()
}

/// `.drag_drop_enabled = false` の代入 1 つの読み。
struct RunTimeCut {
    at: usize,
    /// 代入を包むブロックの頭(外から順)。
    headers: Vec<String>,
    /// 代入を含む文。
    statement: String,
    /// 包むブロックのどれも `if` / `else` / `match` / 腕(`=>`)/ self_check の分岐でない(いつも走る)。
    always: bool,
    /// `app.windows`(か、それを束縛した名前)を回す `for` / `iter_mut` の中(全部の窓)。
    every_window: bool,
}

impl RunTimeCut {
    fn describe(&self) -> String {
        format!(
            "@{}: `{}` (always: {}, every window: {}, inside: {:?})",
            self.at, self.statement, self.always, self.every_window, self.headers
        )
    }
}

fn describe_cuts(src: &str) -> Vec<String> {
    run_time_cuts(src).iter().map(RunTimeCut::describe).collect()
}

/// `code`(lib.rs の原文)の、`generate_context!()` を持つ関数の中の `.drag_drop_enabled = false` の代入を全部読む。
fn run_time_cuts(src: &str) -> Vec<RunTimeCut> {
    let code = mask_code(src);
    let (body_start, body_end) = context_fn_body(&code);
    let body = &code[body_start..body_end];

    // `let [mut] NAME = … config_mut().app.windows …;` の NAME(窓の並びを束縛した名前)
    let mut bindings: Vec<String> = Vec::new();
    let mut search = 0;
    while let Some(pos) = body[search..].find("app.windows") {
        let at = search + pos;
        search = at + "app.windows".len();
        let start = statement_start(body, 0, at);
        let stmt = body[start..at].trim_start();
        let toks = tokens(stmt);
        if toks.first() == Some(&"let") {
            let name = if toks.get(1) == Some(&"mut") { toks.get(2) } else { toks.get(1) };
            if let Some(name) = name {
                bindings.push((*name).to_string());
            }
        }
    }
    let mentions_windows = |text: &str| {
        let squeezed = squeeze(text);
        squeezed.contains("app.windows")
            || bindings.iter().any(|n| {
                squeezed.contains(&format!("{n}.iter_mut")) || squeezed.contains(&format!("in{n}")) || squeezed.contains(&format!("in&mut{n}"))
            })
    };
    let iterates = |text: &str| {
        let t = text.trim_start();
        squeeze(t).contains("iter_mut") || tokens(t).first() == Some(&"for")
    };

    let mut out = Vec::new();
    let mut search = 0;
    while let Some(pos) = body[search..].find("drag_drop_enabled") {
        let at = search + pos;
        search = at + "drag_drop_enabled".len();
        let prev = body[..at].trim_end().chars().next_back();
        if prev != Some('.') {
            continue;
        }
        let rest = body[search..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        if rest.starts_with('=') {
            continue; // `==` は比べるだけ
        }
        let rest = rest.trim_start();
        if !(rest.starts_with("false") && !rest[5..].starts_with(|c: char| c.is_alphanumeric() || c == '_')) {
            continue;
        }

        // 包むブロックの頭
        let mut stack: Vec<usize> = Vec::new();
        for (i, c) in body[..at].char_indices() {
            match c {
                '{' => stack.push(i),
                '}' => {
                    stack.pop();
                }
                _ => {}
            }
        }
        let headers: Vec<String> = stack
            .iter()
            .map(|&brace| body[statement_start(body, 0, brace)..brace].trim().to_string())
            .collect();
        let stmt_start = statement_start(body, 0, at);
        let stmt_end = body[at..].find([';', '}']).map_or(body.len(), |p| at + p);
        let statement = body[stmt_start..stmt_end].trim().to_string();

        let always = headers.iter().all(|h| {
            let toks = tokens(h);
            !toks.iter().any(|t| matches!(*t, "if" | "else" | "match"))
                && !h.contains("=>")
                && !h.contains("self_check")
        });
        let every_window = headers
            .iter()
            .chain(std::iter::once(&statement))
            .any(|t| iterates(t) && mentions_windows(t));
        out.push(RunTimeCut { at: body_start + at, headers, statement, always, every_window });
    }
    out
}

/// 1a の判定: いつも・全部の窓に入れる代入が 1 つはある。
fn cuts_every_configured_window_at_run_time(src: &str) -> bool {
    run_time_cuts(src).iter().any(|c| c.always && c.every_window)
}

/// 1a の走査の器の自己検査: 赤にすべき書き方(self-check の分岐の中だけ・1 つの窓だけ・条件の中・コメントと
/// 文字列の中)を赤にし、緑にすべき書き方(for・iter_mut().for_each・束縛した名前を回す)を緑にする。
#[test]
fn the_run_time_config_scan_needs_every_window_and_no_branch() {
    let wrap = |inner: &str| {
        format!(
            "pub(crate) fn run_app(self_check_session: Option<u8>) {{\n    let mut context = tauri::generate_context!();\n{inner}\n    let built = builder.build(context);\n}}\n"
        )
    };
    let cases: Vec<(&str, bool, String)> = vec![
        (
            "for で全部の窓(いつも)",
            true,
            wrap("    for window in context.config_mut().app.windows.iter_mut() {\n        window.drag_drop_enabled = false;\n    }"),
        ),
        (
            "iter_mut().for_each(いつも)",
            true,
            wrap("    context.config_mut().app.windows.iter_mut().for_each(|w| w.drag_drop_enabled = false);"),
        ),
        (
            "束縛した名前を回す(いつも)",
            true,
            wrap("    let windows = &mut context.config_mut().app.windows;\n    for w in windows.iter_mut() {\n        w.drag_drop_enabled = false;\n    }"),
        ),
        (
            "self-check の分岐の中だけ(今の create = false の隣)",
            false,
            wrap(
                "    let self_check_window = if self_check_session.is_some() {\n        let windows = &mut context.config_mut().app.windows;\n        let first = windows.first().cloned();\n        for window in windows.iter_mut() {\n            window.create = false;\n            window.drag_drop_enabled = false;\n        }\n        first\n    } else {\n        None\n    };",
            ),
        ),
        (
            "self-check でないときの分岐の中だけ",
            false,
            wrap(
                "    if self_check_session.is_some() {\n    } else {\n        for window in context.config_mut().app.windows.iter_mut() {\n            window.drag_drop_enabled = false;\n        }\n    }",
            ),
        ),
        (
            "1 つの窓だけ",
            false,
            wrap("    context.config_mut().app.windows[0].drag_drop_enabled = false;"),
        ),
        (
            "条件の中(cfg! の if)",
            false,
            wrap(
                "    if cfg!(target_os = \"macos\") {\n        for w in context.config_mut().app.windows.iter_mut() {\n            w.drag_drop_enabled = false;\n        }\n    }",
            ),
        ),
        (
            "コメントと文字列の中の字だけ",
            false,
            wrap("    let note = \"window.drag_drop_enabled = false\"; // for w in context.config_mut().app.windows.iter_mut() { w.drag_drop_enabled = false; }\n    /* w.drag_drop_enabled = false; */"),
        ),
        (
            "比べるだけ(==)",
            false,
            wrap("    for w in context.config_mut().app.windows.iter_mut() {\n        let _ = w.drag_drop_enabled == false;\n    }"),
        ),
    ];
    for (name, expected, src) in &cases {
        assert_eq!(
            cuts_every_configured_window_at_run_time(src),
            *expected,
            "{name}: {:#?}\n{src}",
            describe_cuts(src)
        );
    }
}

/// 1a. `lib.rs` が起動時に、設定の全部の窓(`context.config_mut().app.windows`)の drag-drop の受け手を切る
/// (いつも= self-check のときに限らず)。既定は true で、wry がドラッグを WKWebView に渡さない。
#[test]
fn lib_rs_turns_the_drag_drop_handler_off_for_every_configured_window_at_run_time() {
    let src = read_source("src/lib.rs");
    assert!(
        cuts_every_configured_window_at_run_time(&src),
        "src-tauri/src/lib.rs must set `drag_drop_enabled = false` on every window of \
         `context.config_mut().app.windows`, always (not only in the self-check branch), so that drags \
         reach WKWebView (and ProseMirror's handleDrop, 要件#74 第3段 3-5). Assignments found: {:#?}",
        describe_cuts(&src)
    );
}

/// 1b. `tauri.conf.json` の `app.windows` は今のまま(`dragDropEnabled` の項目を足さない=案 B。
/// AC-56-15 の toEqual と ac74_23 の SHA-256 の固定を崩さない)。
#[test]
fn tauri_conf_json_windows_do_not_carry_drag_drop_enabled() {
    let conf: serde_json::Value = serde_json::from_str(&read_source("tauri.conf.json"))
        .expect("tauri.conf.json must be valid JSON");
    let windows = conf["app"]["windows"]
        .as_array()
        .expect("app.windows must be an array");
    assert!(!windows.is_empty(), "app.windows must configure the first window");
    for (i, window) in windows.iter().enumerate() {
        assert!(
            window.get("dragDropEnabled").is_none(),
            "app.windows[{i}] must stay as it is (the handler is turned off at run time in lib.rs): {window}"
        );
    }
}

// ---------------------------------------------------------------------------
// 2. Rust で作る窓(アプリのページを載せる窓)
// ---------------------------------------------------------------------------

/// アプリのページを載せる窓(印刷の窓のほか全部)の作りに、drag-drop の受け手を切る指定がある。
#[test]
fn every_window_that_loads_the_app_page_turns_the_drag_drop_handler_off() {
    let sites = all_sites();
    let app_page: Vec<&Site> = sites.iter().filter(|s| s.file != PRINT_FILE).collect();
    assert!(!app_page.is_empty(), "no webview window builder found outside {PRINT_FILE}");
    let offenders: Vec<String> = app_page
        .iter()
        .filter(|s| !cuts_drag_drop(s))
        .map(|s| s.describe())
        .collect();
    assert!(
        offenders.is_empty(),
        "these webview window builders must turn Tauri's drag-drop handler off \
         (`.disable_drag_drop_handler()` before building, or `config.drag_drop_enabled = false` \
         for `from_config`), so that drags reach WKWebView:\n{offenders:#?}"
    );
}

// ---------------------------------------------------------------------------
// 3. 印刷の窓は落としたファイルへ移らない
// ---------------------------------------------------------------------------

/// 印刷の窓(script の走らない印刷の文書だけを載せる)は、drag-drop の受け手を残すか、
/// 切るなら `.on_navigation(` で印刷の文書の外へ移らないようにする。
#[test]
fn the_print_window_is_not_navigated_by_a_dropped_file() {
    let sites = all_sites();
    let print: Vec<&Site> = sites.iter().filter(|s| s.file == PRINT_FILE).collect();
    assert_eq!(print.len(), 1, "{PRINT_FILE} must build exactly one print window: {print:#?}");
    let region = squeeze(&print[0].region);
    let cut = region.contains(".disable_drag_drop_handler()");
    assert!(
        !cut || region.contains(".on_navigation("),
        "the print window carries no script that could stop a dropped file from being opened; \
         keep Tauri's drag-drop handler (it swallows drops) or add `.on_navigation(` that keeps \
         the window on the print document:\n{}",
        print[0].region
    );
}
