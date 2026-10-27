//! 要件#12 追補b の受け入れテスト(docs/requirements/req-12.md「追補b 窓の位置を復元するのは起動ごとの
//! 最初の窓だけにする」= Issue #569 / #570)— Rust 層(AC-12-追b (a)〜(c))
//!
//! 発端:
//! - #569: `WindowManager::next_label` は起動ごとに `vellis-1` から振り直し、`tauri-plugin-window-state`
//!   はラベルごとに位置と大きさを保存する。そのため New Window / Duplicate Window で開いた `vellis-2`
//!   などが、前の起動で同じラベルだった別の窓の位置・大きさで開く
//! - #570: プラグイン 2.4.1 の終了時の `save_window_state` はディスクの控えの全項目を見て同じラベルの
//!   窓で上書きし、filter を見ない。前の起動の `vellis-N` が控えに残っていて、今回そのラベルがタブに
//!   使われると、タブの位置が保存されうる
//!
//! 判断(契約): ラベルは窓の正体ではないので、前の起動の「同じラベルの窓」の位置を使う意味は、
//! 起動ごとの最初の窓= `tauri.conf.json` の窓(ラベル **`main`**・`lib.rs` が `main` で登録)にしか
//! ない。`vellis-1` 以降は 2 枚目以降の窓で、前面の窓から右下へ 24px ずらして開く。
//!
//! 判定範囲(req-12.md 追補b の受け入れ基準。(d)=既存の要件#12・#62 のテストが無改変で緑、は
//! test-runner のフルスイートで見る):
//! - (a) 純関数: 位置を追う窓の判定は `main` だけ真(`vellis-1`・`vellis-2`・`vellis-10`・印刷窓・
//!   タブのラベルは偽)
//! - (b) 純関数: 前面の窓の左上 (x, y) から、新しい窓の左上は (x + 24, y + 24)。前面の窓が無ければ「中央」
//! - (c) ソース走査: window-state の `with_filter` が (a) の判定を使う。`create_window`(と IPC の経路
//!   `handle_open_path`)が、タブでない窓に (b) の位置を与える(前面の窓が無ければ `.center()`)。
//!   大きさは今のまま(`.inner_size(1280.0, 800.0)`=契約 2)。前面の窓は `active_label` の窓
//!   (要件#12 追補a)で、その左上を論理 px で読む
//!
//! ## 確定契約(公開 API・implementer はこれに従う)
//!
//! ```ignore
//! // src-tauri/src/window/placement.rs(新規。`src-tauri/src/window/mod.rs` に `pub mod placement;`
//! // を足す)
//!
//! /// 起動ごとの最初の窓のラベル= `tauri.conf.json` の窓(label 未指定= Tauri 既定の "main")。
//! pub const FIRST_WINDOW_LABEL: &str = "main";
//!
//! /// 前面の窓からのずらし幅(論理 px)。
//! pub const CASCADE_OFFSET: f64 = 24.0;
//!
//! /// window-state が位置・大きさを復元・保存する窓か(契約 1)。`FIRST_WINDOW_LABEL` と等しいときだけ
//! /// 真(厳密な一致。`vellis-N`・印刷窓・タブ・空文字はすべて偽)。
//! pub fn tracks_window_state(label: &str) -> bool;
//!
//! /// 新しい窓の左上(契約 2)。
//! #[derive(Clone, Copy, Debug, PartialEq)]
//! pub enum NewWindowPosition {
//!     /// 左上をここに置く(論理 px)。
//!     At { x: f64, y: f64 },
//!     /// 画面の中央(`WebviewWindowBuilder::center()`)。
//!     Center,
//! }
//!
//! /// 前面の窓の左上 (x, y)(論理 px)→ `At { x: x + CASCADE_OFFSET, y: y + CASCADE_OFFSET }`。
//! /// 前面の窓が無い・位置が取れない(`None`)→ `Center`。
//! pub fn cascade_from(front: Option<(f64, f64)>) -> NewWindowPosition;
//!
//! /// 種類ごとの置き場(契約 2「タブを除く」の判定を純関数に置く)。
//! /// - `WindowKind::Tab` → `None`(位置を与えない。タブバーが置く=要件#62)
//! /// - `WindowKind::Standalone` → `Some(cascade_from(front))`
//! pub fn new_window_position(kind: WindowKind, front: Option<(f64, f64)>) -> Option<NewWindowPosition>;
//!
//! // src-tauri/src/lib.rs(配線=ソース走査)
//! // - `tauri_plugin_window_state::Builder::default()` の連鎖の `.with_filter(` の引数(クロージャ)で
//! //   `tracks_window_state(label)` を使う(タブの除外は `main` がタブになり得ないので含まれる。
//! //   `TabWindowLabels` を併用してもよい)
//! //
//! // src-tauri/src/commands/window.rs(配線=ソース走査)
//! // - `create_window` の本体で `new_window_position(kind, front)` を呼び(第 1 引数は引数の `kind`
//! //   そのもの)、`Some(At { x, y })` なら builder の `.position(x, y)`、`Some(Center)` なら
//! //   `.center()`、`None` なら何もしない。この 3 分岐は `create_window` の本体に書く(別関数に
//! //   出さない)。`cascade_from(` を直接は呼ばない(タブの除外は `new_window_position` が担う)。
//! //   `.inner_size(1280.0, 800.0)` は残す
//! //
//! // src-tauri/src/ipc/handler.rs(配線=ソース走査)
//! // - `handle_open_path` の本体で `new_window_position(WindowKind::Standalone, front)` を呼び、
//! //   同じ 3 分岐(`.position(` / `.center()`)を本体に書く。`.inner_size(1280.0, 800.0)` は残す
//! //
//! // 前面の窓の位置(どこか 1 つの関数の本体=ソース走査):
//! // - `WindowManager::active_label()` の窓を `outer_position()` で読み、`scale_factor()` で
//! //   論理 px に直す(`WebviewWindowBuilder::position` は論理 px・`outer_position` は物理 px)。
//! //   `active_label(`・`outer_position(`・`scale_factor(` の 3 つが同じ関数の本体にあること
//! ```
//!
//! ソース走査の流儀は `acceptance_req12a.rs` / `acceptance_req62a.rs` と同じ(行コメントを落として
//! から `fn_body` で関数の本体を切り出す)。空白を落として照合するので改行の入れ方は自由。
//!
//! ## 赤の源
//! `vellis_lib::window::placement` は未定義なので本ファイルはコンパイルで赤。(c) は `lib.rs` の filter
//! が `TabWindowLabels` だけで `tracks_window_state` を使わず、`create_window` / `handle_open_path` に
//! `new_window_position(` も `.position(` / `.center()` も無く、`outer_position(` もどこにも無いので赤。
//!
//! ## 走査が見ないもの(reviewer 照合・人間ゲート)
//! - 前面の窓の位置を読むときの `WindowManager` のロックの取り方(`create_window` は既にロックを
//!   取っているので、同じ関数で二重に取らないこと)
//! - 実機で: 窓を 2 つ以上開いて終了 → 起動すると最初の窓は前回の位置。New Window は前面の窓から
//!   少しずれて開き、前の起動の 2 つ目の窓の位置には出ない(人間ゲート)

use std::path::{Path, PathBuf};

use tauri::test::MockRuntime;
use vellis_lib::print::is_print_window;
use vellis_lib::window::manager::WindowManager;
use vellis_lib::window::placement::{
    cascade_from, new_window_position, tracks_window_state, NewWindowPosition, CASCADE_OFFSET,
    FIRST_WINDOW_LABEL,
};
use vellis_lib::window::tab::WindowKind;

// ---------------------------------------------------------------------------
// AC-12-追b (a) — 位置を追う窓の判定(純関数)
// ---------------------------------------------------------------------------

/// 1. 最初の窓= `main`(tauri.conf.json の窓)だけ真。定数もその値。
#[test]
fn the_first_window_tracks_window_state() {
    assert_eq!(FIRST_WINDOW_LABEL, "main", "the first window is tauri.conf.json's window, labelled main");
    assert!(tracks_window_state("main"), "the first window must be restored and saved");
    assert!(tracks_window_state(FIRST_WINDOW_LABEL));
}

/// 2. 2 枚目以降の窓(`vellis-N`)は偽: 前の起動の同じラベルの位置を使わない(#569)。
#[test]
fn later_windows_do_not_track_window_state() {
    for label in ["vellis-1", "vellis-2", "vellis-10", "vellis-100"] {
        assert!(
            !tracks_window_state(label),
            "{label}: a window opened after launch must not be restored from an earlier launch"
        );
    }
}

/// 3. 印刷窓・タブ・空文字・`main` の綴り違いは偽(厳密な一致)。
#[test]
fn print_tab_and_near_miss_labels_do_not_track_window_state() {
    let print = "print-01ARZ3NDEKTSV4RRFFQ69G5FAV";
    assert!(is_print_window(print), "precondition: this is a print window label");
    assert!(!tracks_window_state(print), "a print window is never restored by label");
    // A tab is an ordinary numbered window (要件#62): never the first window.
    assert!(!tracks_window_state("vellis-3"), "a tab's label is a numbered label, never main");
    for label in ["", "Main", "MAIN", " main", "main ", "main2", "xmain", "vellis-main"] {
        assert!(!tracks_window_state(label), "{label:?} must not be taken for the first window");
    }
}

/// 4. `WindowManager::next_label()` が振るラベルは一つも追わない(判定が実際の採番と噛み合う)。
#[test]
fn no_label_from_the_window_manager_is_tracked() {
    let mut wm: WindowManager<MockRuntime> = WindowManager::new();
    for _ in 0..5 {
        let label = wm.next_label();
        assert!(
            !tracks_window_state(&label),
            "{label}: labels handed out during a launch must not be restored"
        );
    }
}

// ---------------------------------------------------------------------------
// AC-12-追b (b) — 前面の窓からのずらし(純関数)
// ---------------------------------------------------------------------------

/// 5. ずらし幅は 24px。
#[test]
fn cascade_offset_is_24px() {
    assert_eq!(CASCADE_OFFSET, 24.0);
}

/// 6. 前面の窓の左上 (x, y) → 新しい窓の左上は (x + 24, y + 24)。負の座標(左のディスプレイ)や
///    小数(論理 px)でもそのまま足す。
#[test]
fn a_front_window_cascades_the_new_window_24px_down_and_right() {
    assert_eq!(
        cascade_from(Some((100.0, 200.0))),
        NewWindowPosition::At { x: 124.0, y: 224.0 }
    );
    assert_eq!(cascade_from(Some((0.0, 0.0))), NewWindowPosition::At { x: 24.0, y: 24.0 });
    assert_eq!(
        cascade_from(Some((-500.0, 50.0))),
        NewWindowPosition::At { x: -476.0, y: 74.0 },
        "a front window on a display to the left keeps its negative x"
    );
    assert_eq!(
        cascade_from(Some((10.5, 20.25))),
        NewWindowPosition::At { x: 34.5, y: 44.25 },
        "logical pixels may be fractional"
    );
}

/// 7. 前面の窓が無い(位置が取れない)→ 中央。
#[test]
fn no_front_window_means_center() {
    assert_eq!(cascade_from(None), NewWindowPosition::Center);
}

/// 8. ずらしは定数 `CASCADE_OFFSET` そのもの(定数を変えれば両方が動く)。
#[test]
fn cascade_uses_the_offset_constant() {
    let (x, y) = (640.0, 360.0);
    assert_eq!(
        cascade_from(Some((x, y))),
        NewWindowPosition::At {
            x: x + CASCADE_OFFSET,
            y: y + CASCADE_OFFSET
        }
    );
}

// ---------------------------------------------------------------------------
// 契約 2「タブを除く」— 種類ごとの置き場(純関数)
// ---------------------------------------------------------------------------

/// 9. タブには位置を与えない(前面の窓があっても無くても `None`)。
#[test]
fn a_tab_gets_no_position_of_its_own() {
    assert_eq!(new_window_position(WindowKind::Tab, Some((100.0, 200.0))), None);
    assert_eq!(new_window_position(WindowKind::Tab, None), None);
}

/// 10. 独立の窓は (b) の位置: 前面の窓があればずらし、無ければ中央(`cascade_from` と同じ値)。
#[test]
fn a_standalone_window_gets_the_cascaded_position() {
    assert_eq!(
        new_window_position(WindowKind::Standalone, Some((100.0, 200.0))),
        Some(NewWindowPosition::At { x: 124.0, y: 224.0 })
    );
    assert_eq!(
        new_window_position(WindowKind::Standalone, None),
        Some(NewWindowPosition::Center)
    );
    for front in [None, Some((0.0, 0.0)), Some((-12.0, 8.5))] {
        assert_eq!(
            new_window_position(WindowKind::Standalone, front),
            Some(cascade_from(front)),
            "front={front:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// ソース走査の道具(acceptance_req12a.rs / acceptance_req62a.rs と同じ流儀)
// ---------------------------------------------------------------------------

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// 行ごとに `//` 以降(コメント)を落としたコード部分を連結して返す。`://` は落とさない。
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

fn commands_window_rs_code() -> String {
    strip_line_comments(include_str!("../src/commands/window.rs"))
}

fn ipc_handler_rs_code() -> String {
    strip_line_comments(include_str!("../src/ipc/handler.rs"))
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

/// `open` の位置の開き括弧に対応する閉じ括弧の位置(`(`/`[`/`{` を同じ深さで数える)。
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

/// `start` から、最初の `(` に対応する閉じ括弧までの呼び出し全体。
fn balanced_call(code: &str, start: usize) -> &str {
    let open = code[start..].find('(').expect("call must have '('") + start;
    let close = matching_close(code, open);
    &code[start..=close]
}

/// `start` から始まるメソッド連鎖全体(`.ident(` が続く限り取り込む)。
fn method_chain(code: &str, start: usize) -> &str {
    let mut end = start + balanced_call(code, start).len();
    loop {
        let rest = &code[end..];
        let trimmed = rest.trim_start();
        let Some(after_dot) = trimmed.strip_prefix('.') else {
            break;
        };
        let ident_len = after_dot
            .char_indices()
            .find(|(_, c)| !(c.is_alphanumeric() || *c == '_'))
            .map(|(i, _)| i)
            .unwrap_or(after_dot.len());
        if ident_len == 0 || !after_dot[ident_len..].starts_with('(') {
            break;
        }
        let ws = rest.len() - trimmed.len();
        let call_start = end + ws + 1;
        let open = call_start + ident_len;
        end = matching_close(code, open) + 1;
    }
    &code[start..end]
}

/// `fn <name>(` で始まる関数の本体(最初の `{` から対応する `}` まで)。
fn fn_body<'a>(code: &'a str, name: &str) -> &'a str {
    let needle = format!("fn {name}(");
    let start = code
        .find(&needle)
        .unwrap_or_else(|| panic!("source must define `{needle}...`"));
    let open = code[start..].find('{').expect("fn must have a body") + start;
    let close = matching_close(code, open);
    &code[open..=close]
}

/// `pos` を本体に含む最も内側の関数の本体(無ければ None)。
fn enclosing_fn_body(code: &str, pos: usize) -> Option<&str> {
    let mut found = None;
    for (start, _) in code.match_indices("fn ") {
        if start >= pos {
            break;
        }
        if start > 0 && !code[..start].ends_with(|c: char| c.is_whitespace()) {
            continue;
        }
        let Some(open_rel) = code[start..].find('{') else {
            continue;
        };
        let open = start + open_rel;
        if open > pos {
            continue;
        }
        let close = matching_close(code, open);
        if pos <= close {
            found = Some(&code[open..=close]);
        }
    }
    found
}

/// 空白をすべて落とす(改行の入れ方に依らず照合するため)。
fn no_ws(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

/// 空白を落としたコードの中の `needle(` の最初の呼び出しの第 1 引数(最初の `,` まで)。
fn first_argument<'a>(flat: &'a str, needle: &str) -> Option<&'a str> {
    let at = flat.find(needle)? + needle.len();
    let rest = &flat[at..];
    let end = rest.find(|c: char| c == ',' || c == ')')?;
    Some(&rest[..end])
}

// ---------------------------------------------------------------------------
// AC-12-追b (c) — ソース走査: filter・create_window・IPC の経路・前面の窓
// ---------------------------------------------------------------------------

/// 11. `lib.rs` の window-state プラグイン登録(`tauri_plugin_window_state::Builder` の連鎖)の
///     `.with_filter(` の引数が (a) の `tracks_window_state` を使う。連鎖は `.build(` で終わる(不変)。
#[test]
fn window_state_filter_uses_the_pure_judgement() {
    let code = lib_rs_code();
    let start = code
        .find("tauri_plugin_window_state::Builder")
        .expect("lib.rs must register tauri_plugin_window_state::Builder");
    let chain = method_chain(&code, start);
    let at = chain
        .find(".with_filter(")
        .unwrap_or_else(|| panic!("the window-state registration must call .with_filter(...):\n{chain}"));
    let filter = balanced_call(chain, at);
    assert!(
        filter.contains("tracks_window_state"),
        "the filter must decide with window::placement::tracks_window_state:\n{filter}"
    );
    assert!(
        chain.contains(".build("),
        "the window-state plugin registration must still end with .build():\n{chain}"
    );
}

/// 12. `create_window` は `new_window_position(kind, …)` で置き場を決め(第 1 引数は引数の `kind`)、
///     本体で `.position(` と `.center()` の両方を builder に渡せる。`cascade_from(` は直接呼ばない
///     (タブの除外は純関数が担う)。`.inner_size(1280.0, 800.0)` は残る(契約 2「大きさは今のまま」)。
#[test]
fn create_window_places_standalone_windows_by_kind() {
    let code = commands_window_rs_code();
    let body = fn_body(&code, "create_window");
    let flat = no_ws(body);
    let first = first_argument(&flat, "new_window_position(").unwrap_or_else(|| {
        panic!("create_window must decide the position with new_window_position(kind, front): {body}")
    });
    assert_eq!(
        first, "kind",
        "new_window_position must be given create_window's own `kind` so a tab is left out: {body}"
    );
    assert!(
        !flat.contains("cascade_from("),
        "create_window must not call cascade_from directly (that would bypass the tab exclusion): {body}"
    );
    assert!(
        flat.contains(".position("),
        "create_window must pass At {{ x, y }} to the builder with .position(x, y): {body}"
    );
    assert!(
        flat.contains(".center()"),
        "create_window must pass Center to the builder with .center(): {body}"
    );
    assert!(
        flat.contains(".inner_size(1280.0,800.0)"),
        "the default size 1280 × 800 must stay: {body}"
    );
}

/// 13. IPC の経路(`handle_open_path`= 2 回目の CLI)は独立の窓なので
///     `new_window_position(WindowKind::Standalone, …)` で同じ置き場を決め、本体で `.position(` と
///     `.center()` の両方を builder に渡せる。`.inner_size(1280.0, 800.0)` は残る。
#[test]
fn handle_open_path_places_the_cli_window_like_new_window() {
    let code = ipc_handler_rs_code();
    let body = fn_body(&code, "handle_open_path");
    let flat = no_ws(body);
    let first = first_argument(&flat, "new_window_position(").unwrap_or_else(|| {
        panic!("handle_open_path must decide the position with new_window_position(WindowKind::Standalone, front): {body}")
    });
    assert!(
        first.ends_with("WindowKind::Standalone"),
        "the CLI window is a standalone window (found new_window_position({first}, …)): {body}"
    );
    assert!(
        flat.contains(".position("),
        "handle_open_path must pass At {{ x, y }} to the builder with .position(x, y): {body}"
    );
    assert!(
        flat.contains(".center()"),
        "handle_open_path must pass Center to the builder with .center(): {body}"
    );
    assert!(
        flat.contains(".inner_size(1280.0,800.0)"),
        "the default size 1280 × 800 must stay: {body}"
    );
}

/// 14. 前面の窓= `active_label()` の窓の左上を `outer_position()` で読み、`scale_factor()` で論理 px
///     に直す関数が `src-tauri/src/**` のどこかに 1 つはある(3 つが同じ関数の本体に同居)。
#[test]
fn the_front_window_is_the_active_label_read_in_logical_pixels() {
    let mut seen: Vec<String> = Vec::new();
    for (rel, src) in all_rust_sources() {
        let code = strip_line_comments(&src);
        for (pos, _) in code.match_indices("outer_position(") {
            let Some(body) = enclosing_fn_body(&code, pos) else {
                continue;
            };
            seen.push(format!("{rel}: outer_position( at byte {pos}"));
            if body.contains("active_label(") && body.contains("scale_factor(") {
                return;
            }
        }
    }
    panic!(
        "some function must read the active window's outer_position() and convert it with scale_factor() (the front window of 要件#12 追補a). outer_position( found at: {seen:?}"
    );
}
