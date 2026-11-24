//! 要件#84 の受け入れテスト(docs/requirements/req-84.md)— Rust 層
//! (AC-84-1〜9・13・14=契約 1〜8・10・13。レジストリ・解決の表・フロントとの一致・メニュー・CLI・
//! command と置き場の門・IPC・Settings… / Export・theme.rs の知らせ・E2E の道具と CI のソース走査)
//!
//! 「配布版(release チャンネル)では今の編集と AI 連携を隠し、開発版(dev チャンネル)では使えるようにする」
//! のうち `src-tauri` に足すものを判定する。純関数(`resolve_by_name`・`flags_map_for`・`require_with`・
//! `cli::command_with`・`cli::unavailable_option`・`vellis_dir_allowed`・`settings_announce_needed`)には両側
//! (隠す側・出る側)を渡して見る。入口の門(メニュー・command の先頭・`main` の CLI・IPC の受け手・
//! Settings…・theme.rs の監視)は**ソースをテキストとして読んで**判定する(acceptance_req80.rs /
//! acceptance_req64.rs の `fn_body`・`submenu_call_with_label` と同じ作り)。新しい公開の口を `use` するので、
//! 実装前はこのファイルはコンパイルできない=赤の理由は「未実装」(acceptance_req83.rs と同じ)。
//!
//! 判定範囲:
//! - AC-84-1 レジストリ(契約1)【(b)(c) 決定】
//! - AC-84-2 解決の表(契約2)【(b)(d) 決定】
//! - AC-84-3 フロントとの一致(契約1・3)
//! - AC-84-4 メニュー(契約4・ソース走査)【(h) 決定】
//! - AC-84-5 CLI(契約6)【(i)(n) 決定】(6 の「既存テストが無改変で緑」は test-runner のフルスイートで見る)
//! - AC-84-6 command の門(契約4・5・ソース走査+純関数)
//! - AC-84-7 `.vellis/` の置き場(契約5・7・ソース走査+純関数)
//! - AC-84-8 起動中の窓への知らせ(契約5・ソース走査)
//! - AC-84-9 Settings… と Export Default Theme…(契約8・ソース走査+純関数)【(f)(g) 決定】
//! - AC-84-13 E2E のビルド(契約10・ソース走査)【(k) 決定】
//! - AC-84-14 タグの CI(契約13・ソース走査)【(p) 決定】
//!
//! AC-84-10〜12(フロント)は `src/lib/legacy-features.acceptance.test.ts` と
//! `src/components/Viewer.legacy-hidden.wiring.test.ts`。AC-84-15(既存テストの無改変・緑)は test-runner の
//! フルスイート。
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前。推奨名は req-84.md のもの・無いものは test-writer が固定)
//!
//! ```ignore
//! // --- src-tauri/src/features/mod.rs
//! pub const EDITOR_INLINE: &str = "editor_inline";   // フラグの名前の定数(今の編集=#41〜#46)
//! pub const AI_MARKS: &str = "ai_marks";             // フラグの名前の定数(今の AI 連携=#48〜#51)
//! // REGISTRY = &[ FlagSpec { name: EDITOR_INLINE, kind: Dev, default_dev: true, default_release: false,
//! //                          owner: "…", removal: "#811", description: "…" },
//! //               FlagSpec { name: AI_MARKS,      kind: Dev, default_dev: true, default_release: false,
//! //                          owner: "…", removal: "#812", description: "…" } ]   // この順・removal は Issue 番号
//! /// 今の非公開の `resolve` を名前で引いて公開する口。知らない名前は false。
//! pub fn resolve_by_name(name: &str, channel: Channel, dev_features_compiled: bool, vellis_flags: &[&str], ops_killed: bool) -> bool;
//! /// `flags_map` の純関数の版(release では kind=Dev の行を除く)。`VELLIS_DISABLE` は見ない(ops の行が無いので同じ)。
//! pub fn flags_map_for(channel: Channel, dev_features_compiled: bool, vellis_flags: &[&str]) -> BTreeMap<&'static str, bool>;
//! /// command の門: `is_enabled(name)` が偽なら Err(UNAVAILABLE_MESSAGE の形)。
//! pub fn require(name: &str, what: &str) -> Result<(), String>;
//! /// 純関数の版: `enabled` が偽なら Err("<what> is not available in this version of Vellis")。
//! pub fn require_with(enabled: bool, what: &str) -> Result<(), String>;
//!
//! // --- src-tauri/src/cli.rs
//! // `about` = "A file viewer for Markdown, HTML, images, 3D models, video, audio and PDF"(全ビルド)
//! /// `Cli::command()` に、`ai_enabled` が偽なら --marks / --changed / --fix / --inbox を `hide` にして返す
//! /// (解析の器は残る=4 つとも解析はできる・--self-check との同時指定は今どおり ArgumentConflict)。
//! pub fn command_with(ai_enabled: bool) -> clap::Command;
//! /// 4 つのどれかが付いていれば、--marks・--changed・--fix・--inbox の順で最初の 1 つ(`--` 付きの綴り)。
//! /// 付いていなければ None。`ai_enabled` が真なら常に None。
//! pub fn unavailable_option(cli: &Cli, ai_enabled: bool) -> Option<&'static str>;
//! /// 標準エラーの 1 行: "vellis: <option> is not available in this version of Vellis"(option は `--fix` の形)。
//! pub fn unavailable_option_message(option: &str) -> String;
//! /// 断ったときの終了コード。
//! pub const UNAVAILABLE_OPTION_EXIT_CODE: i32 = 2;
//!
//! // --- src-tauri/src/main.rs
//! // 解析は `cli::command_with(<ai_enabled>)` を通す(`Cli::parse()` のままでは --help の出し分けができない)。
//! // 解析の直後・`cli.print_build_info` と `cli.fix` の処理より前に
//! //   if let Some(option) = unavailable_option(&cli, ai_enabled) { eprintln!("{}", unavailable_option_message(option));
//! //                                                                std::process::exit(UNAVAILABLE_OPTION_EXIT_CODE); }
//! // ai_enabled は features::is_enabled(features::AI_MARKS)(main.rs か cli.rs のどちらかで AI_MARKS を引く)。
//!
//! // --- src-tauri/src/menu.rs
//! // build: `Submenu::with_items` の File / Edit の並びは今のまま組み、組んだ後に
//! //   if !features::is_enabled(features::EDITOR_INLINE) { file_menu.remove(&save_item)?; file_menu.remove(&save_sep)?;
//! //                                                       edit_menu.remove(&edit_mode_item)?; }
//! //   (`.remove(` は build の本文にこの 3 つだけ。ほかのメニューには足さない)
//! // handle_settings_click / handle_export_default_theme_click: `features::is_enabled(features::EDITOR_INLINE)` を条件に
//! //   持つ `if` の、**偽のときに走る枝**に `app.opener().open_path(…)`(`open_path(` の字面)があって `create_window(` が無く、
//! //   **真のときに走る枝**は今のまま `create_window(`(`open_path(` 無し)。書き方は `if !…is_enabled(…) { open_path; return }`
//! //   (残りが真の枝)・`if !… { … } else { … }`・`if … { create_window } else { open_path }` のどれでもよいが、判定の向きと
//! //   枝の中身の対応は見る(反転すると赤)。Settings… は `ensure_settings_file(` を判定より先に呼ぶ。
//!
//! // --- src-tauri/src/commands/document.rs / commands/annotation.rs
//! // save_document の本文の最初の文: `features::require(features::EDITOR_INLINE, "Saving")?;`
//! // add_mark・list_marks・update_mark・remove_mark・generate_inbox・rebind_marks_for_file・list_snapshots・
//! // diff_against_snapshot・revert_to_snapshot の本文の最初の文: `features::require(features::AI_MARKS, "…")?;`
//! /// `.vellis/` を開いてよいか(契約5: 両方が偽なら断る)。
//! pub fn vellis_dir_allowed(edit: bool, ai: bool) -> bool;    // = edit || ai
//! // store_for: 要件72 の `vellis_dir_writes` の判定はそのまま残し、`vellis_dir_allowed(is_enabled(EDITOR_INLINE), is_enabled(AI_MARKS))`
//! //   の判定を `AnnotationStore::new(` より前に置く(偽なら Err)。
//!
//! // --- src-tauri/src/ipc/handler.rs
//! // handle_show_marks: `features::is_enabled(features::AI_MARKS)` が偽なら `emit_to(` の前に return(送らない)。
//!
//! // --- src-tauri/src/settings.rs
//! /// `settings.json` が変わった後の知らせ(`commands::document::announce_settings_saved` と同じ処理を共有する口):
//! /// 読み直して `SETTINGS_CHANGED_EVENT` を全窓へ emit し、壊れていれば警告を 1 回出す。
//! pub fn announce_changed(app: &tauri::AppHandle<tauri::Wry>, path: &std::path::Path);
//! // commands/document.rs の保存の経路もこの口を呼ぶ(`announce_changed(` の字面が document.rs にある)。
//!
//! // --- src-tauri/src/theme.rs
//! /// 監視の後始末の判定(純関数): settings.json の中身(無ければ None)が前回と変わり、かつ今の編集が隠れている
//! /// (`edit_enabled == false`)ときだけ true。
//! pub fn settings_announce_needed(prev: Option<&str>, next: Option<&str>, edit_enabled: bool) -> bool;
//! // reconcile(か spawn_watcher): `settings_announce_needed(last.inputs.settings…, inputs.settings…, features::is_enabled(features::EDITOR_INLINE))`
//! //   が真なら `settings::announce_changed(app, &path)` を呼ぶ。
//!
//! // --- src/lib/legacy-features.ts(フロントの正本は legacy-features.acceptance.test.ts)
//! export const EDITOR_INLINE_FLAG = 'editor_inline';
//! export const AI_MARKS_FLAG = 'ai_marks';
//!
//! // --- scripts/e2e.sh: `pnpm --silent tauri build --debug --no-bundle -f webdriver,dev-features`(承認 2)
//! // --- .github/workflows/release.yml: `Release-channel smoke` の run に editor_inline / ai_marks が flags に無い確かめを足す
//! //     (ステップの名前と並びは今のまま)。確かめは**実際に止めるコード**で: コメント・`echo` 以外の 1 行が
//! //     `--print-build-info` の出力の `flags` を見て 2 つの名前を両方持ち(例 `LEAKED=$("$BIN" --print-build-info | node -p "… ['editor_inline', 'ai_marks'] …")`)、
//! //     その結果で `if … $LEAKED …` 〜 `fi` の中で `exit 1` する。`echo "… no editor_inline / ai_marks …"` の字面だけでは足りない。
//! ```
//!
//! ## 判断の記録(test-writer 2026-11-06)
//! - `removal` は周回開始時に作った Issue の番号(#811・#812)で固定した(req-84.md は「`#` で始まる」とだけ書く)
//! - `unavailable_option` の返り値は `--` 付きの綴り(`"--marks"`)にした。文言の「名前を差し込む形」は関数
//!   `unavailable_option_message(option)` で固定し、終了コードは `UNAVAILABLE_OPTION_EXIT_CODE`(`self_check::EXIT_NOT_RUNNABLE`
//!   と同じ作法)
//! - `settings_announce_needed` の引数は `Option<&str>`(`theme.rs` の `Inputs.settings: Option<String>` を `as_deref()` で渡す形)。
//!   ファイルが消えた(Some → None)のも「中身が変わった」として true
//! - メニューの `.remove(` は AC-84-4 の字面どおり `build` の本文で見る(別の補助関数に逃がすと赤になる)
//!
//! 人間ゲート(本物のメニューから項目が消えること・本物のキー・配布版相当のビルドでフォルダに何も作られないこと・
//! CLI の実際の終了・既定のアプリで開くこと)は判定しない。

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use clap::{CommandFactory, FromArgMatches, Parser};

use vellis_lib::channel::Channel;
use vellis_lib::cli::{
    command_with, unavailable_option, unavailable_option_message, Cli, UNAVAILABLE_OPTION_EXIT_CODE,
};
use vellis_lib::commands::annotation::vellis_dir_allowed;
// 要件74 第2段 2-5(2026-11-17 仮・契約21・棚卸し 8=承認済み (as)): `editor_inline`(#811)と `editor_file`(#820)を REGISTRY から外した。
// 残るのは `ai_marks`。`EDITOR_INLINE` の定数は無いので import しない(AC-74-46)。
use vellis_lib::features::{
    current_channel, flags_map, flags_map_for, is_enabled, require, require_with, resolve_by_name, FlagKind,
    AI_MARKS, DEV_FEATURES_COMPILED, REGISTRY,
};
use vellis_lib::theme::settings_announce_needed;

// ---------------------------------------------------------------------------
// 共通ヘルパ — acceptance_req80.rs / acceptance_req64.rs と同じ流儀(コメント落とし・括弧の対応)
// ---------------------------------------------------------------------------

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// 無いファイルは空文字(=その上のアサートが赤になる。`include_str!` と違ってコンパイルは止めない)。
fn read_source_or_empty(rel: &str) -> String {
    std::fs::read_to_string(manifest_dir().join(rel)).unwrap_or_default()
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

fn menu_rs_code() -> String {
    strip_line_comments(include_str!("../src/menu.rs"))
}

fn main_rs_code() -> String {
    strip_line_comments(include_str!("../src/main.rs"))
}

fn cli_rs_code() -> String {
    strip_line_comments(include_str!("../src/cli.rs"))
}

fn lib_rs_code() -> String {
    strip_line_comments(include_str!("../src/lib.rs"))
}

fn document_rs_code() -> String {
    strip_line_comments(include_str!("../src/commands/document.rs"))
}

fn annotation_rs_code() -> String {
    strip_line_comments(include_str!("../src/commands/annotation.rs"))
}

fn ipc_handler_rs_code() -> String {
    strip_line_comments(include_str!("../src/ipc/handler.rs"))
}

fn theme_rs_code() -> String {
    strip_line_comments(include_str!("../src/theme.rs"))
}

fn settings_rs_code() -> String {
    strip_line_comments(include_str!("../src/settings.rs"))
}

/// `src/lib/legacy-features.ts`(フロントの正本)。無ければ空=AC-84-3 が赤になる。
fn legacy_features_ts() -> String {
    read_source_or_empty("../src/lib/legacy-features.ts")
}

fn e2e_sh() -> String {
    read_source_or_empty("../scripts/e2e.sh")
}

fn release_yml() -> String {
    read_source_or_empty("../.github/workflows/release.yml")
}

/// `fn <name>(` か `fn <name><`(ジェネリクス)の宣言の開始位置(`fn ` の位置)。
fn fn_decl_start(code: &str, name: &str) -> Option<usize> {
    let marker = format!("fn {name}");
    let mut search = 0;
    while let Some(rel) = code[search..].find(&marker) {
        let at = search + rel;
        let after = code[at + marker.len()..].chars().next();
        if matches!(after, Some('(') | Some('<')) {
            return Some(at);
        }
        search = at + marker.len();
    }
    None
}

/// `open`(`{` / `(` / `[` の位置)に対応する閉じ括弧の位置。文字列リテラルの中の括弧は数えない。
fn matching_close(code: &str, open: usize) -> usize {
    let bytes = code.as_bytes();
    let (inc, dec) = match bytes[open] {
        b'{' => (b'{', b'}'),
        b'(' => (b'(', b')'),
        b'[' => (b'[', b']'),
        other => panic!("not an opening bracket at {open}: {}", other as char),
    };
    let mut depth = 0usize;
    let mut in_str = false;
    let mut i = open;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if c == b'\\' {
                i += 2;
                continue;
            }
            if c == b'"' {
                in_str = false;
            }
        } else if c == b'"' {
            in_str = true;
        } else if c == inc {
            depth += 1;
        } else if c == dec {
            depth -= 1;
            if depth == 0 {
                return i;
            }
        }
        i += 1;
    }
    panic!("unbalanced bracket starting at byte {open}");
}

/// 関数の本体(`{ … }` の中身=外側の括弧を除く)。無ければ panic(=赤)。
fn fn_body(code: &str, name: &str) -> String {
    let start = fn_decl_start(code, name)
        .unwrap_or_else(|| panic!("source must define `fn {name}(` (or `fn {name}<`)"));
    // シグネチャの `(`…`)` を飛ばしてから本体の `{` を探す(`-> Result<(), String>` に括弧があっても先頭の `(` を基準にする)。
    let params_open = code[start..].find('(').expect("fn must take parameters") + start;
    let params_close = matching_close(code, params_open);
    let open = code[params_close..].find('{').expect("fn must have a body") + params_close;
    let close = matching_close(code, open);
    code[open + 1..close].to_string()
}

/// `start` から最初の `(` に対応する閉じ括弧までの呼び出し全体(acceptance_req64.rs の写し・文字列を飛ばす)。
fn balanced_call(code: &str, start: usize) -> &str {
    let open = code[start..].find('(').expect("call must have '('") + start;
    let close = matching_close(code, open);
    &code[start..=close]
}

fn first_string_literal(s: &str) -> Option<&str> {
    let a = s.find('"')? + 1;
    let b = s[a..].find('"')? + a;
    Some(&s[a..b])
}

/// ラベルが `label` の `Submenu::with_…` 呼び出し全体(with_items / with_id_and_items のどちらも)。
fn submenu_call_with_label<'a>(code: &'a str, label: &str) -> Option<&'a str> {
    let mut search = 0;
    while let Some(rel) = code[search..].find("Submenu::with_") {
        let start = search + rel;
        let call = balanced_call(code, start);
        search = start + "Submenu::with_".len();
        if first_string_literal(call) == Some(label) {
            return Some(call);
        }
    }
    None
}

/// Submenu 呼び出しの項目スライス `&[&a, &b, …]` の識別子列(`&` を剥がした順)。
fn submenu_item_idents(call: &str) -> Vec<&str> {
    let slice_open = call.find("&[").expect("submenu must take an item slice");
    let slice_end = matching_close(call, slice_open + 1);
    call[slice_open + 2..slice_end]
        .split(',')
        .map(|s| s.trim().trim_start_matches('&'))
        .filter(|s| !s.is_empty())
        .collect()
}

/// `export const NAME = '…'` の文字列リテラルの中身(`'` / `"` / `` ` `` のどれでも)=acceptance_req66.rs の写し。
fn ts_string_const(src: &str, file: &str, name: &str) -> String {
    let marker = format!("export const {name}");
    let at = src
        .find(&marker)
        .unwrap_or_else(|| panic!("{file} must `{marker}` (AC-84-3)"));
    let rest = &src[at + marker.len()..];
    let eq = rest.find('=').expect("`=` after the const name");
    let after = rest[eq + 1..].trim_start();
    let quote = after.chars().next().expect("a quoted string");
    assert!(
        quote == '\'' || quote == '"' || quote == '`',
        "{name} must be a string literal, got {after:?}"
    );
    let body = &after[quote.len_utf8()..];
    let end = body.find(quote).expect("closing quote");
    body[..end].to_string()
}

/// 空白を全部落とす(呼び出しの字面を改行・インデントに左右されずに比べる)。
fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

/// CJK(漢字・かな・全角記号)を含むか=英語の文言の確かめ(要件#65 ほかと同じ範囲)。
fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| {
        matches!(c as u32,
            0x3000..=0x303F | 0x3040..=0x309F | 0x30A0..=0x30FF | 0x4E00..=0x9FFF | 0xFF00..=0xFFEF)
    })
}

/// `is_enabled(` の呼び出しのうち、引数に `needle` を含む最初のものの位置と呼び出し全体。
fn is_enabled_call_with<'a>(code: &'a str, needle: &str) -> Option<(usize, &'a str)> {
    let mut search = 0;
    while let Some(rel) = code[search..].find("is_enabled(") {
        let start = search + rel;
        let call = balanced_call(code, start);
        search = start + "is_enabled(".len();
        if call.contains(needle) {
            return Some((start, call));
        }
    }
    None
}

/// `code` の中の `fn <name>(` の本体の最初の文(空白を除いた先頭の字面)。
fn first_statement(code: &str, name: &str) -> String {
    let body = fn_body(code, name);
    let trimmed = body.trim_start();
    let end = trimmed.find(';').unwrap_or(trimmed.len());
    squash(&trimmed[..end])
}

/// `generate_handler![ … ]` の 2 つの一覧(`::` の最後の名前だけ)=acceptance_req66.rs と同じ読み方。
fn generate_handler_lists(code: &str) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    let mut search = 0;
    while let Some(rel) = code[search..].find("generate_handler![") {
        let start = search + rel + "generate_handler!".len();
        let close = matching_close(code, start);
        let names = code[start + 1..close]
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.rsplit("::").next().unwrap_or(s).to_string())
            .collect();
        out.push(names);
        search = close;
    }
    out
}

// ---------------------------------------------------------------------------
// AC-84-1 レジストリ(契約1)【(b)(c) 決定】
// ---------------------------------------------------------------------------

/// 1. `REGISTRY` は `editor_inline`・`ai_marks`(この順)で始まる。名前の定数も同じ綴り。
///    要件74 第1段(2026-11-16・契約21・棚卸し 8=要件側更新): 3 本目に `editor_file` が入る(中身は acceptance_req74.rs の AC-74-24)。
///    要件74 第2段 2-5(2026-11-17 仮・契約21・AC-74-46=要件側更新): `editor_inline` と `editor_file` は撤去。REGISTRY は `ai_marks` だけ。
#[test]
fn ac84_1_registry_holds_editor_inline_then_ai_marks() {
    assert_eq!(AI_MARKS, "ai_marks");
    let names: Vec<&str> = REGISTRY.iter().map(|f| f.name).collect();
    assert_eq!(names, vec!["ai_marks"], "REGISTRY holds ai_marks alone after the removal round (要件74 契約21・AC-74-46)");
}

/// 2. 要件84 の 2 本はどちらも `kind == Dev`・`default_dev == true`・`default_release == false`。
///    要件74 第1段(2026-11-16・棚卸し 8=要件側更新): `editor_file` の既定は (af) で決まる(acceptance_req74.rs)ので、ここでは見ない。
#[test]
fn ac84_1_both_flags_are_dev_default_on_in_dev_off_in_release() {
    for spec in REGISTRY.iter().filter(|f| BOTH.contains(&f.name)) {
        assert_eq!(spec.kind, FlagKind::Dev, "{}: kind must be Dev", spec.name);
        assert!(spec.default_dev, "{}: default_dev must be true ((b) 決定)", spec.name);
        assert!(!spec.default_release, "{}: default_release must be false", spec.name);
    }
    assert_eq!(REGISTRY.iter().filter(|f| BOTH.contains(&f.name)).count(), 1, "ai_marks alone (要件74 2-5)");
}

/// 3. `removal` は Issue(`#` で始まる=周回開始時に作った #811 / #812)・`owner` と `description` は空でない・
///    `description` は英語 1 行。
#[test]
fn ac84_1_removal_is_an_issue_and_owner_description_are_filled() {
    let by_name: BTreeMap<&str, &vellis_lib::features::FlagSpec> =
        REGISTRY.iter().map(|f| (f.name, f)).collect();
    assert!(by_name.get("editor_inline").is_none(), "editor_inline is removed (要件74 2-5・#811)");
    let ai = by_name.get("ai_marks").expect("ai_marks is registered");
    assert_eq!(ai.removal, "#812", "ai_marks.removal = 今の AI 連携の行き先の Issue (#812)");
    for spec in REGISTRY {
        assert!(spec.removal.starts_with('#'), "{}: removal must be an issue (#N)", spec.name);
        assert!(!spec.owner.trim().is_empty(), "{}: owner must not be empty", spec.name);
        assert!(!spec.description.trim().is_empty(), "{}: description must not be empty", spec.name);
        assert!(!spec.description.contains('\n'), "{}: description is one line", spec.name);
        assert!(!has_cjk(spec.description), "{}: description is English", spec.name);
    }
}

/// 4. 名前は `snake_case`(小文字・数字・`_`・先頭は英字・`__` 無し)で `dev_` / `ops_` / `experiment_` で始まらない・重複なし。
#[test]
fn ac84_1_names_are_snake_case_without_kind_prefix_and_unique() {
    let mut seen = BTreeSet::new();
    for spec in REGISTRY {
        let name = spec.name;
        assert!(
            name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
            "{name}: snake_case only"
        );
        assert!(name.chars().next().is_some_and(|c| c.is_ascii_lowercase()), "{name}: starts with a letter");
        assert!(!name.contains("__"), "{name}: no double underscore");
        assert!(name.contains('_'), "{name}: <domain>_<specific> has an underscore");
        for prefix in ["dev_", "ops_", "experiment_"] {
            assert!(!name.starts_with(prefix), "{name}: no kind prefix ({prefix})");
        }
        assert!(seen.insert(name), "{name}: duplicated in REGISTRY");
    }
}

// ---------------------------------------------------------------------------
// AC-84-2 解決の表(契約2)【(b)(d) 決定】
// ---------------------------------------------------------------------------

/// 要件74 第2段 2-5: 要件84 の 2 本のうち残るのは `ai_marks` だけ(`editor_inline` は AC-84-2 の表で「知らない名前=常に偽」の側へ)。
const BOTH: [&str; 1] = ["ai_marks"];
const REMOVED_FLAGS: [&str; 2] = ["editor_inline", "editor_file"];

/// 1. `Channel::Release` では dev-features の有無・`VELLIS_FLAGS` に名前があるか・`ops_killed` に関わらず false。
#[test]
fn ac84_2_release_is_always_false() {
    for name in BOTH {
        for compiled in [false, true] {
            for flags in [&[][..], &BOTH[..]] {
                for killed in [false, true] {
                    assert!(
                        !resolve_by_name(name, Channel::Release, compiled, flags, killed),
                        "{name}: release must be false (compiled={compiled}, flags={flags:?}, killed={killed})"
                    );
                }
            }
        }
    }
}

/// 2. `Channel::Dev` で dev-features なし → false(`VELLIS_FLAGS` に名前があっても)。
#[test]
fn ac84_2_dev_without_dev_features_is_false_even_when_listed() {
    for name in BOTH {
        assert!(!resolve_by_name(name, Channel::Dev, false, &[], false), "{name}: dev, no dev-features");
        assert!(
            !resolve_by_name(name, Channel::Dev, false, &BOTH, false),
            "{name}: VELLIS_FLAGS cannot turn it on without dev-features ((b)(d) 決定)"
        );
    }
}

/// 3. `Channel::Dev` で dev-features あり → true(`VELLIS_FLAGS` が空でも)。`ops_killed` が真でも true。
#[test]
fn ac84_2_dev_with_dev_features_is_true_without_vellis_flags_and_despite_ops_kill() {
    for name in BOTH {
        assert!(resolve_by_name(name, Channel::Dev, true, &[], false), "{name}: default_dev=true");
        assert!(resolve_by_name(name, Channel::Dev, true, &BOTH, false), "{name}: listed too");
        assert!(
            resolve_by_name(name, Channel::Dev, true, &[], true),
            "{name}: ops kill is kind=ops only, must not turn a dev flag off"
        );
    }
}

/// 4. 知らない名前 → false(どの組でも)。撤去した `editor_inline` / `editor_file` も知らない名前(AC-74-46)。
#[test]
fn ac84_2_unknown_name_is_false() {
    for channel in [Channel::Dev, Channel::Release] {
        for compiled in [false, true] {
            assert!(!resolve_by_name("does_not_exist", channel, compiled, &["does_not_exist"], false));
            assert!(!resolve_by_name("", channel, compiled, &[], false));
            for name in REMOVED_FLAGS {
                assert!(!resolve_by_name(name, channel, compiled, &[name], false), "{name} is gone (要件74 2-5)");
                assert!(!is_enabled(name) || channel == Channel::Release, "{name} is never enabled");
            }
        }
    }
}

/// 5. release の `flags_map` に 2 本の名前が出ない(dev では出て、値は dev-features の有無のとおり)。
#[test]
fn ac84_2_release_flags_map_omits_both_names_and_dev_lists_them() {
    for compiled in [false, true] {
        let release = flags_map_for(Channel::Release, compiled, &BOTH);
        for name in BOTH {
            assert!(
                !release.contains_key(name),
                "release flags_map must not carry {name} (§3.5 payload minimization): {release:?}"
            );
        }
        let dev = flags_map_for(Channel::Dev, compiled, &[]);
        for name in BOTH {
            assert_eq!(dev.get(name), Some(&compiled), "dev flags_map carries {name} = dev-features compiled");
        }
    }
}

/// 6. 今のビルドの `is_enabled` / `flags_map` は表のとおり(`cargo test` は dev チャンネル=dev-features の有無で決まる。
///    release チャンネルで回したときは両方 false・flags_map に出ない)。
#[test]
fn ac84_2_runtime_is_enabled_follows_the_compile_flag_on_the_dev_channel() {
    let on_dev = current_channel() == Channel::Dev;
    let expected = on_dev && DEV_FEATURES_COMPILED;
    for name in BOTH {
        assert_eq!(is_enabled(name), expected, "{name}: is_enabled == (dev channel && DEV_FEATURES_COMPILED)");
    }
    let map = flags_map();
    for name in BOTH {
        if on_dev {
            assert_eq!(map.get(name), Some(&expected), "{name} in flags_map on the dev channel");
        } else {
            assert!(!map.contains_key(name), "{name} is omitted from flags_map on release");
        }
    }
}

// ---------------------------------------------------------------------------
// AC-84-3 フロントとの一致(契約1・3)
// ---------------------------------------------------------------------------

/// 7. `src/lib/legacy-features.ts` の `AI_MARKS_FLAG` がレジストリの名前と一致する。`EDITOR_INLINE_FLAG` は無い(要件74 2-5・AC-74-46)。
#[test]
fn ac84_3_frontend_flag_names_match_the_registry() {
    let ts = legacy_features_ts();
    assert!(!ts.is_empty(), "src/lib/legacy-features.ts must exist (契約3)");
    let ai = ts_string_const(&ts, "src/lib/legacy-features.ts", "AI_MARKS_FLAG");
    assert_eq!(ai, AI_MARKS);
    assert!(REGISTRY.iter().any(|f| f.name == ai), "{ai} is registered");
    assert!(!ts.contains("EDITOR_INLINE_FLAG"), "EDITOR_INLINE_FLAG is gone from the front end (AC-74-46)");
    assert!(!ts.contains("editor_inline"), "the name editor_inline is gone from legacy-features.ts");
}

// ---------------------------------------------------------------------------
// AC-84-4 メニュー(契約4・ソース走査)【(h) 決定】
// ---------------------------------------------------------------------------

/// 8. `Submenu::with_items` の File と Edit の並びの字面は今のまま(Save・区切り線・Edit を並びからは外さない)。
#[test]
fn ac84_4_file_and_edit_slices_are_unchanged() {
    let code = menu_rs_code();
    let file = submenu_call_with_label(&code, "File").expect("menu.rs must build the File submenu");
    assert_eq!(
        submenu_item_idents(file),
        vec![
            "new_window_item",
            "new_tab_item",
            "duplicate_window_item",
            "new_window_sep",
            "open_file_item",
            "open_folder_item",
            "file_sep",
            "save_item",
            "save_sep",
            "print_item",
        ],
        "the File slice must stay as built; Save is removed after building (契約4)"
    );
    let edit = submenu_call_with_label(&code, "Edit").expect("menu.rs must build the Edit submenu");
    assert_eq!(
        submenu_item_idents(edit),
        // 要件74 第2段 2-5(2026-11-17 仮・契約21・(ad)・棚卸し 3=承認済み (as)): Edit ▸ Edit(`edit_mode_item`)は撤去。その区切り線
        // (`edit_mode_sep`)は Find… の前に残る(標準の編集の組と検索の組の区切り)。
        vec![
            "undo",
            "redo",
            "edit_sep",
            "cut",
            "copy",
            "paste",
            "select_all",
            "edit_mode_sep",
            "find_item",
            // 要件74 第3段 3-3(2026-11-17 由谷の決定 3-12・棚卸し 3): Edit ▸ Find and Replace… は Find… の直後
            "find_replace_item",
            "find_in_folder_item",
        ],
        "the Edit slice after the removal round: no Edit ▸ Edit (要件74 契約21・(ad)); Find and Replace… after Find… (3-3)"
    );
}

/// 9. 要件74 第2段 2-5(2026-11-17 仮・契約21・AC-74-46=要件側更新): File ▸ Save・Edit ▸ Edit・Format・Raw Source の出し分けは無くなる。
///    `menu::build` の本文に `.remove(` は無く、`features::is_enabled(` も無い(メニューはフラグを見ない)。Edit ▸ Edit は作らない。
#[test]
fn ac84_4_build_removes_save_its_separator_and_edit_when_editor_inline_is_off() {
    let code = menu_rs_code();
    let body = fn_body(&code, "build");
    assert!(!body.contains(".remove("), "build no longer removes any item (要件74 契約21): {body}");
    assert!(!body.contains("is_enabled("), "build no longer reads a feature flag: {body}");
    assert!(!body.contains("EDITOR_INLINE") && !body.contains("EDITOR_FILE"), "no flag names in build");
    assert!(!code.contains("EDIT_ITEM_ID") && !code.contains("MENU_EDIT_EVENT") && !code.contains("EDIT_ACCELERATOR"), "Edit ▸ Edit is gone (AC-74-25・(ad))");
    assert!(!code.contains("edit_mode_item"), "no binding for Edit ▸ Edit");
    assert!(code.contains("save_item") && code.contains("format_menu") && code.contains("raw_source_item"), "Save / Format / Raw Source are always built");
}

/// 10. `.remove(` は menu.rs 全体で `rebuild_theme_items` の 1 つだけ(build には無い)。
#[test]
fn ac84_4_no_other_menu_item_is_removed() {
    let code = menu_rs_code();
    let body = fn_body(&code, "build");
    assert_eq!(body.matches(".remove(").count(), 0, "build removes nothing after the removal round");
    assert_eq!(code.matches(".remove(").count(), 1, "menu.rs: the only `.remove(` is rebuild_theme_items' (View ▸ Appearance)");
}

// ---------------------------------------------------------------------------
// AC-84-5 CLI(契約6)【(i)(n) 決定】
// ---------------------------------------------------------------------------

const HIDDEN_OPTIONS: [&str; 4] = ["--marks", "--changed", "--fix", "--inbox"];

/// 11. `cli::command_with(false)` の長い help と短い help に 4 つが無い。`--print-build-info`・`ssh://` はある。
#[test]
fn ac84_5_help_hides_the_four_options_when_ai_marks_is_off() {
    let long = command_with(false).render_long_help().to_string();
    let short = command_with(false).render_help().to_string();
    for (label, help) in [("--help", &long), ("-h", &short)] {
        for option in HIDDEN_OPTIONS {
            assert!(!help.contains(option), "`vellis {label}` must not mention {option} (契約6):\n{help}");
        }
        assert!(help.contains("--print-build-info"), "`vellis {label}` keeps --print-build-info:\n{help}");
        assert!(help.contains("ssh://"), "`vellis {label}` keeps ssh:// (Issue #701):\n{help}");
        assert!(!help.contains("self-check"), "`vellis {label}` keeps --self-check hidden (AC-72-1):\n{help}");
    }
}

/// 12. `cli::command_with(true)` には 4 つともある(開発版は今のまま)。
#[test]
fn ac84_5_help_shows_the_four_options_when_ai_marks_is_on() {
    let long = command_with(true).render_long_help().to_string();
    let short = command_with(true).render_help().to_string();
    for (label, help) in [("--help", &long), ("-h", &short)] {
        for option in HIDDEN_OPTIONS {
            assert!(help.contains(option), "`vellis {label}` (dev) must mention {option}:\n{help}");
        }
    }
}

/// 13. 隠しても解析の器は残る: `command_with(false)` で `--marks` / `--fix x --inbox p` / `--changed` が解析でき、
///     `--self-check` との同時指定は今どおり `ArgumentConflict`(AC-72-1)。
#[test]
fn ac84_5_hidden_options_still_parse_and_still_conflict_with_self_check() {
    let matches = command_with(false)
        .try_get_matches_from(["vellis", "--marks"])
        .expect("--marks parses (hidden, not removed)");
    let cli = Cli::from_arg_matches(&matches).expect("Cli::from_arg_matches");
    assert!(cli.marks);

    let matches = command_with(false)
        .try_get_matches_from(["vellis", "--changed", "--fix", "claude", "--inbox", "/tmp/inbox.md"])
        .expect("--changed/--fix/--inbox parse (hidden, not removed)");
    let cli = Cli::from_arg_matches(&matches).expect("Cli::from_arg_matches");
    assert!(cli.changed);
    assert_eq!(cli.fix.as_deref(), Some("claude"));
    assert_eq!(cli.inbox.as_deref(), Some(std::path::Path::new("/tmp/inbox.md")));

    for ai_enabled in [false, true] {
        for argv in [
            &["vellis", "--self-check", "a.md", "--marks"][..],
            &["vellis", "--self-check", "a.md", "--changed"][..],
            &["vellis", "--self-check", "a.md", "--fix", "claude"][..],
        ] {
            let err = command_with(ai_enabled)
                .try_get_matches_from(argv)
                .expect_err("--self-check conflicts with the AI options");
            assert_eq!(err.kind(), clap::error::ErrorKind::ArgumentConflict, "{argv:?} (ai_enabled={ai_enabled})");
        }
    }
}

/// 14. `cli::unavailable_option(&cli, false)` = 4 つのどれかが付いていれば、`--marks`・`--changed`・`--fix`・`--inbox`
///     の順で最初の名前。付いていなければ `None`。
#[test]
fn ac84_5_unavailable_option_names_the_first_of_the_four_in_order() {
    let cases: &[(&[&str], Option<&str>)] = &[
        (&["vellis"], None),
        (&["vellis", "README.md"], None),
        (&["vellis", "-n", "-r", "-vv", "--foreground", "docs"], None),
        (&["vellis", "--print-build-info"], None),
        (&["vellis", "--install-cli"], None),
        (&["vellis", "--marks"], Some("--marks")),
        (&["vellis", "--marks", "./docs"], Some("--marks")),
        (&["vellis", "--changed"], Some("--changed")),
        (&["vellis", "--fix", "claude"], Some("--fix")),
        (&["vellis", "--inbox", "/tmp/inbox.md"], Some("--inbox")),
        (&["vellis", "--changed", "--marks"], Some("--marks")),
        (&["vellis", "--fix", "claude", "--changed"], Some("--changed")),
        (&["vellis", "--inbox", "/tmp/i.md", "--fix", "claude"], Some("--fix")),
        (&["vellis", "--inbox", "/tmp/i.md", "--marks", "--fix", "x", "--changed"], Some("--marks")),
    ];
    for (argv, expected) in cases {
        let cli = Cli::try_parse_from(*argv).unwrap_or_else(|e| panic!("{argv:?} parses: {e}"));
        assert_eq!(unavailable_option(&cli, false), *expected, "{argv:?} (ai_marks off)");
    }
}

/// 15. `ai_enabled` が真なら常に `None`(開発版では断らない)。
#[test]
fn ac84_5_unavailable_option_is_none_when_ai_marks_is_on() {
    for argv in [
        &["vellis", "--marks"][..],
        &["vellis", "--changed"][..],
        &["vellis", "--fix", "claude"][..],
        &["vellis", "--inbox", "/tmp/inbox.md", "--fix", "codex"][..],
        &["vellis"][..],
    ] {
        let cli = Cli::try_parse_from(argv).expect("parses");
        assert_eq!(unavailable_option(&cli, true), None, "{argv:?} (ai_marks on)");
    }
}

/// 16. 文言 = `vellis: --fix is not available in this version of Vellis`(名前を差し込む形)・終了コード = 2。
///     どちらも CJK を含まない。
#[test]
fn ac84_5_refusal_message_and_exit_code_are_fixed() {
    assert_eq!(
        unavailable_option_message("--fix"),
        "vellis: --fix is not available in this version of Vellis"
    );
    for option in HIDDEN_OPTIONS {
        let message = unavailable_option_message(option);
        assert_eq!(message, format!("vellis: {option} is not available in this version of Vellis"));
        assert!(!has_cjk(&message), "the message is English: {message}");
        assert!(!message.contains('\n'), "one line: {message:?}");
    }
    assert_eq!(UNAVAILABLE_OPTION_EXIT_CODE, 2);
}

/// 17. `main.rs`(ソース走査): 解析は `command_with(` を通し、`cli.print_build_info` と `cli.fix` の処理より前に
///     `unavailable_option(` を呼び、`Some` なら `std::process::exit(UNAVAILABLE_OPTION_EXIT_CODE)` する。
#[test]
fn ac84_5_main_refuses_before_print_build_info_and_fix() {
    let main = main_rs_code();
    assert!(main.contains("command_with("), "main.rs must parse through cli::command_with(ai_enabled) (契約6)");
    let refuse = main
        .find("unavailable_option(")
        .expect("main.rs must call cli::unavailable_option(&cli, …) right after parsing");
    let print_build_info = main
        .find("cli.print_build_info")
        .expect("main.rs still handles --print-build-info");
    let fix = main.find("cli.fix").expect("main.rs still handles --fix");
    assert!(refuse < print_build_info, "the refusal comes before the --print-build-info handling");
    assert!(refuse < fix, "the refusal comes before the --fix handling");
    let between = &main[refuse..print_build_info.min(fix)];
    assert!(
        between.contains("std::process::exit("),
        "a refused option ends the process (no window, nothing sent): {between}"
    );
    assert!(
        between.contains("UNAVAILABLE_OPTION_EXIT_CODE"),
        "the exit uses cli::UNAVAILABLE_OPTION_EXIT_CODE: {between}"
    );
    assert!(
        between.contains("unavailable_option_message("),
        "the one line on stderr comes from cli::unavailable_option_message: {between}"
    );
    // `--self-check` の分岐(要件72)は今どおり残る。
    assert!(main.contains("cli.self_check"), "the --self-check branch stays (AC-72-2)");
    // ai_enabled は Rust の正本(AI_MARKS を main.rs か cli.rs で引く)。
    let combined = format!("{main}\n{}", cli_rs_code());
    assert!(
        combined.contains("AI_MARKS") && combined.contains("is_enabled("),
        "ai_enabled must come from features::is_enabled(features::AI_MARKS) (契約3)"
    );
}

/// 18. `about` の文 = `A file viewer for Markdown, HTML, images, 3D models, video, audio and PDF`(全ビルド・(n) 決定)。
#[test]
fn ac84_5_about_names_a_file_viewer() {
    const ABOUT: &str = "A file viewer for Markdown, HTML, images, 3D models, video, audio and PDF";
    let about = Cli::command().get_about().map(|s| s.to_string());
    assert_eq!(about.as_deref(), Some(ABOUT));
    for ai_enabled in [false, true] {
        let about = command_with(ai_enabled).get_about().map(|s| s.to_string());
        assert_eq!(about.as_deref(), Some(ABOUT), "command_with({ai_enabled}) keeps the same about");
        let help = command_with(ai_enabled).render_long_help().to_string();
        assert!(help.contains(ABOUT), "--help starts with the new one-liner:\n{help}");
        assert!(!help.contains("text editor"), "--help no longer says text editor ((n) 決定):\n{help}");
    }
}

// ---------------------------------------------------------------------------
// AC-84-6 command の門(契約4・5・ソース走査+純関数)
// ---------------------------------------------------------------------------

const AI_COMMANDS: [&str; 9] = [
    "add_mark",
    "list_marks",
    "update_mark",
    "remove_mark",
    "generate_inbox",
    "rebind_marks_for_file",
    "list_snapshots",
    "diff_against_snapshot",
    "revert_to_snapshot",
];

/// 19. `save_document` の本文の最初の文が門で、`EDITOR_INLINE` を渡す。
///     要件74 第1段(2026-11-16・契約14・棚卸し 8=要件側更新): 門は `features::require_any(&[EDITOR_INLINE, EDITOR_FILE], "Saving")?;`
///     に改まる(どちらかが真なら通す。形は acceptance_req74.rs の AC-74-40 が見る)。
///     要件74 第2段 2-5(2026-11-17 仮・契約21・AC-74-46=要件側更新): 門は無くなる(保存は通常の機能)。最初の文は `require` ではない。
#[test]
fn ac84_6_save_document_requires_editor_inline_first() {
    let code = document_rs_code();
    let first = first_statement(&code, "save_document");
    assert!(!first.contains("require"), "save_document has no feature gate after the removal round: `{first}`");
    let body = fn_body(&code, "save_document");
    assert!(!body.contains("require_any(") && !body.contains("require(") && !body.contains("EDITOR_INLINE") && !body.contains("EDITOR_FILE"), "no gate anywhere in save_document: {body}");
    assert!(body.contains("check_expected_hash("), "the hash check (契約14) stays");
}

/// 20. AI の 9 本の本文の最初の文が `features::require(` で、`AI_MARKS` を渡す。
#[test]
fn ac84_6_the_nine_ai_commands_require_ai_marks_first() {
    let code = annotation_rs_code();
    for name in AI_COMMANDS {
        let first = first_statement(&code, name);
        assert!(
            first.starts_with("features::require(") || first.starts_with("crate::features::require("),
            "{name}'s first statement must be features::require(features::AI_MARKS, …)?; got `{first}`"
        );
        assert!(first.contains("AI_MARKS"), "{name} is gated by ai_marks: `{first}`");
    }
}

/// 21. `features::require_with(false, "Saving")` = `Err("Saving is not available in this version of Vellis")`・
///     `true` は `Ok(())`。文言は CJK を含まない。
#[test]
fn ac84_6_require_with_refuses_with_the_fixed_message() {
    assert_eq!(
        require_with(false, "Saving"),
        Err("Saving is not available in this version of Vellis".to_string())
    );
    assert_eq!(require_with(true, "Saving"), Ok(()));
    for what in ["Marks", "The agent inbox", "Snapshots"] {
        let err = require_with(false, what).expect_err("off → Err");
        assert_eq!(err, format!("{what} is not available in this version of Vellis"));
        assert!(!has_cjk(&err));
        assert_eq!(require_with(true, what), Ok(()));
    }
}

/// 22. `features::require(name, what)` は今のビルドの `is_enabled` に従う(dev-features なしの `cargo test` では
///     両フラグとも断る・ありなら通す)。知らない名前は常に断る。
#[test]
fn ac84_6_require_follows_is_enabled_of_this_build() {
    for name in BOTH {
        let result = require(name, "Saving");
        if DEV_FEATURES_COMPILED {
            assert_eq!(result, Ok(()), "{name}: dev-features build lets it through");
        } else {
            assert_eq!(
                result,
                Err("Saving is not available in this version of Vellis".to_string()),
                "{name}: without dev-features the gate refuses"
            );
        }
    }
    assert_eq!(
        require("does_not_exist", "Nothing"),
        Err("Nothing is not available in this version of Vellis".to_string())
    );
}

/// 23. `generate_handler!` の 2 つの一覧は無改変(command の数と並び=要件83 の後の 45 / 44)。
#[test]
fn ac84_6_generate_handler_lists_are_unchanged() {
    const COMMON: [&str; 44] = [
        "init_window",
        "open_document",
        "open_binary_document",
        "save_document",
        "set_root",
        "switch_root_confirmed",
        "new_window",
        "new_tab",
        "set_tab_title",
        "search_in_folder",
        "search_in_folder_page",
        "search_in_folder_reset",
        "list_dir",
        "subscribe_dir",
        "unsubscribe_dir",
        "add_mark",
        "list_marks",
        "update_mark",
        "remove_mark",
        "generate_inbox",
        "rebind_marks_for_file",
        "list_snapshots",
        "diff_against_snapshot",
        "revert_to_snapshot",
        "get_build_info",
        "get_theme",
        "list_history",
        "list_recent_files",
        "record_displayed_file",
        "clear_recent_files",
        "list_bookmarks",
        "add_bookmark",
        "remove_bookmark",
        "move_bookmark",
        "remove_history_entry",
        "list_missing_paths",
        "scan_recently_modified",
        "get_video_frame_index",
        "extract_waveform_audio",
        "analyze_wav_waveform",
        "print_current_window",
        "print_html",
        "set_print_available",
        "print_pdf",
    ];
    let lists = generate_handler_lists(&lib_rs_code());
    assert_eq!(lists.len(), 2, "lib.rs builds the invoke handler twice (webdriver / not)");
    let mut webdriver: Vec<&str> = COMMON.to_vec();
    webdriver.push("__test_list_windows");
    assert_eq!(lists[0], webdriver, "webdriver list: 45 commands, unchanged");
    assert_eq!(lists[1], COMMON.to_vec(), "default list: 44 commands, unchanged");
}

// ---------------------------------------------------------------------------
// AC-84-7 `.vellis/` の置き場(契約5・7・ソース走査+純関数)
// ---------------------------------------------------------------------------

/// 24. 要件74 第2段 2-5(2026-11-17 仮・契約14・項目 28=要件側更新): 写しは `.vellis/` を使わない(配布版はアプリのデータの置き場)ので、
///     `vellis_dir_allowed` は `ai` だけで決まる= `vellis_dir_allowed(ai: bool) -> bool`(偽 → .vellis/ を作らない・真 → 作る)。
#[test]
fn ac84_7_vellis_dir_allowed_is_edit_or_ai() {
    assert!(!vellis_dir_allowed(false), "ai_marks hidden → no .vellis/ (契約5・7・要件74 項目 28)");
    assert!(vellis_dir_allowed(true), "marks use .vellis/");
}

/// 25. `store_for` の本文で、両フラグの判定(`vellis_dir_allowed(`)が `AnnotationStore::new(` より前にある。
///     要件72 の `vellis_dir_writes` の判定はそのまま残る。
#[test]
fn ac84_7_store_for_decides_before_opening_the_store() {
    let body = fn_body(&annotation_rs_code(), "store_for");
    let decide = body
        .find("vellis_dir_allowed(")
        .expect("store_for must decide with vellis_dir_allowed(edit, ai) (契約5)");
    let open = body
        .find("AnnotationStore::new(")
        .expect("store_for still opens the store with AnnotationStore::new");
    assert!(decide < open, "the decision comes before AnnotationStore::new (which creates .vellis/)");
    let call = balanced_call(&body, decide);
    assert!(call.contains("AI_MARKS"), "the ai_marks flag is read from the registry: {call}");
    assert!(!call.contains("EDITOR_INLINE") && !call.contains("EDITOR_FILE"), "no editing flag after the removal round (要件74 項目 28): {call}");
    assert!(
        body.contains("vellis_dir_writes"),
        "the --self-check plan's vellis_dir_writes gate stays (要件72 契約8)"
    );
}

// ---------------------------------------------------------------------------
// AC-84-8 起動中の窓への知らせ(契約5・ソース走査)
// ---------------------------------------------------------------------------

/// 26. `ipc::handler` の `handle_show_marks` の本文で、`ai_marks` の判定が `emit_to(` より前にあり、偽なら送らずに返す。
#[test]
fn ac84_8_handle_show_marks_returns_before_emitting_when_ai_marks_is_off() {
    let body = fn_body(&ipc_handler_rs_code(), "handle_show_marks");
    let (decide, call) = is_enabled_call_with(&body, "AI_MARKS")
        .expect("handle_show_marks must decide with features::is_enabled(features::AI_MARKS) (契約5)");
    let emit = body.find("emit_to(").expect("handle_show_marks still emits show_marks to the active window");
    assert!(decide < emit, "the decision comes before emit_to: {body}");
    let between = &body[decide + call.len()..emit];
    assert!(
        between.contains("return"),
        "when ai_marks is off the handler returns without emitting: {between}"
    );
    assert!(
        body.contains("\"show_marks\"") || body.contains("show_marks"),
        "the event name stays show_marks"
    );
}

// ---------------------------------------------------------------------------
// AC-84-9 Settings… と Export Default Theme…(契約8)【(f)(g) 決定】
// ---------------------------------------------------------------------------

/// `body` の中で、引数に `needle` を含む `is_enabled(` を条件に持つ `if` の 2 つの枝=`(off, on)`
/// (off=フラグが偽のときに走るコード・on=真のときに走るコード)。書き方は 3 つとも読める:
/// `if !…is_enabled(…) { A } B`(then 枝が `return` で抜けて、残りの B が真の枝)・`if !…is_enabled(…) { A } else { B }`・
/// `if …is_enabled(…) { B } else { A }`。`else` が無いときは then 枝に `return` が無いと panic(=赤。抜けないと
/// 両方のコードが走る)。ブロックの切り出しは中括弧の対応(`matching_close`)。

/// 27. 要件74 第2段 2-5(2026-11-17 仮・契約21・(ah)・AC-74-43=要件側更新): `handle_settings_click` は Vellis の窓を開く(`create_window(`)。
///     既定のアプリを開く枝(`open_path(`)と `editor_inline` の判定は無い。`ensure_settings_file(` は今どおり先に呼ぶ。
#[test]
fn ac84_9_settings_opens_with_the_default_app_when_editor_inline_is_off() {
    let body = fn_body(&menu_rs_code(), "handle_settings_click");
    assert!(body.contains("create_window("), "Settings… opens a Vellis window (AC-74-43・(ah)): {body}");
    assert!(!body.contains("open_path("), "no default-app branch after the removal round: {body}");
    assert!(!body.contains("is_enabled(") && !body.contains("EDITOR_INLINE"), "no flag decision: {body}");
    let ensure = body.find("ensure_settings_file(").expect("Settings… still creates the file when missing (契約8)");
    let create = body.find("create_window(").expect("checked above");
    assert!(ensure < create, "the file exists before the window opens");
}

/// 28. `handle_export_default_theme_click` も同じ: `create_window(` だけ(`open_path(` 無し・判定無し)。`emit` しない(AC-56-23 の 4)。
#[test]
fn ac84_9_export_default_theme_opens_with_the_default_app_when_editor_inline_is_off() {
    let body = fn_body(&menu_rs_code(), "handle_export_default_theme_click");
    assert!(body.contains("create_window("), "Export opens a Vellis window (AC-74-43): {body}");
    assert!(!body.contains("open_path("), "no default-app branch: {body}");
    assert!(!body.contains("is_enabled(") && !body.contains("EDITOR_INLINE"), "no flag decision: {body}");
    let export = body.find("export_default_theme(").expect("the theme is still written by theme::export_default_theme");
    assert!(export < body.find("create_window(").unwrap(), "the theme is written before the window opens");
    assert!(!body.contains("emit"), "the handler still does not emit (AC-56-23 の 4)");
}

/// 29. (g) 推奨: `settings_announce_needed(prev, next, edit_enabled)` の表。
#[test]
fn ac84_9_settings_announce_needed_table() {
    let a = Some("{\"appearance.theme\": \"default\"}");
    let b = Some("{\"appearance.theme\": \"night\"}");
    // 今の編集が隠れているとき(配布版): 中身が変わったら知らせる。
    assert!(!settings_announce_needed(None, None, false), "no file before or after → nothing to announce");
    assert!(!settings_announce_needed(a, a, false), "same text → no second announcement (§5.3)");
    assert!(settings_announce_needed(a, b, false), "changed text → announce");
    assert!(settings_announce_needed(None, b, false), "file appeared → announce");
    assert!(settings_announce_needed(a, None, false), "file removed → announce (defaults apply)");
    // 今の編集が出ているとき(開発版): 保存の経路だけが知らせる(2 回にしない)。
    assert!(!settings_announce_needed(a, b, true));
    assert!(!settings_announce_needed(None, b, true));
    assert!(!settings_announce_needed(a, None, true));
    assert!(!settings_announce_needed(a, a, true));
}

/// 30. `theme.rs` の監視の後始末(`reconcile` か `spawn_watcher`)が、`settings_announce_needed(` に `editor_inline` の
///     判定を渡し、真なら `settings::announce_changed(` を呼ぶ。`announce_changed` は settings.rs の公開関数で、
///     保存の経路(commands/document.rs)も同じ口を呼ぶ。
#[test]
fn ac84_9_watcher_announces_external_settings_changes_through_the_shared_route() {
    let theme = theme_rs_code();
    let reconcile = fn_body(&theme, "reconcile");
    let watcher = fn_body(&theme, "spawn_watcher");
    let (body, where_) = if reconcile.contains("settings_announce_needed(") {
        (reconcile, "reconcile")
    } else if watcher.contains("settings_announce_needed(") {
        (watcher, "spawn_watcher")
    } else {
        panic!("theme.rs: reconcile or spawn_watcher must decide with settings_announce_needed(prev, next, edit_enabled) (契約8 (g))");
    };
    let decide = body.find("settings_announce_needed(").unwrap();
    let call = balanced_call(&body, decide);
    // 要件74 第2段 2-5(2026-11-17 仮・契約21・AC-74-43): 編集は常にあるので第 3 引数は `true`(外で保存した知らせは保存の経路だけ=2 回にしない)。
    assert!(!call.contains("EDITOR_INLINE") && !call.contains("editor_inline"), "{where_}: no flag after the removal round: {call}");
    assert!(squash(&call).ends_with(",true)"), "{where_}: edit_enabled is always true (the editor always exists): {call}");
    let announce = body
        .find("announce_changed(")
        .unwrap_or_else(|| panic!("{where_}: when needed, settings::announce_changed(app, &path) is called"));
    assert!(decide < announce, "{where_}: decide first, then announce");

    let settings = settings_rs_code();
    assert!(
        fn_decl_start(&settings, "announce_changed").is_some() && settings.contains("pub fn announce_changed"),
        "settings.rs must expose pub fn announce_changed (the shared route)"
    );
    let announce_body = fn_body(&settings, "announce_changed");
    assert!(announce_body.contains("SETTINGS_CHANGED_EVENT"), "announce_changed emits settings_changed to every window");
    assert!(announce_body.contains(".emit("), "emit, not emit_to (all windows): {announce_body}");
    assert!(
        announce_body.contains("read_settings(") || announce_body.contains("parse_settings(") || announce_body.contains("load_settings("),
        "announce_changed validates the file and warns once when broken (要件65 契約8)"
    );
    assert!(
        document_rs_code().contains("announce_changed("),
        "commands/document.rs (the in-Vellis save) shares the same route (one implementation, not two)"
    );
}

// ---------------------------------------------------------------------------
// AC-84-13 E2E のビルド(契約10・ソース走査)【(k) 決定】
// ---------------------------------------------------------------------------

/// シェルの 1 行から `"…"` / `'…'` の中身を落とす(`echo "… tauri build …"` のような表示の行を、
/// 実際に `tauri build` を呼ぶ行と区別するため)。
fn strip_shell_quotes(line: &str) -> String {
    let mut out = String::new();
    let mut quote: Option<char> = None;
    for c in line.chars() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                }
            }
            None => {
                if c == '"' || c == '\'' {
                    quote = Some(c);
                } else {
                    out.push(c);
                }
            }
        }
    }
    out
}

/// `scripts/e2e.sh` の中で `tauri build` を**実際に呼ぶ**行(コメントでなく、`tauri build` が文字列リテラルの外にある行)。
/// `echo "==> … (via tauri build)"` のような表示の行は選ばない。ちょうど 1 行でなければ panic(=赤。ビルドの行が
/// 2 つに増えて片方だけ直った、という見落としを防ぐ)。
fn e2e_build_line() -> String {
    let sh = e2e_sh();
    let lines: Vec<&str> = sh
        .lines()
        .filter(|l| !l.trim_start().starts_with('#') && strip_shell_quotes(l).contains("tauri build"))
        .collect();
    assert_eq!(
        lines.len(),
        1,
        "scripts/e2e.sh must call `tauri build` on exactly one command line (not an echo/printf), got {lines:?}"
    );
    lines[0].to_string()
}

/// `scripts/e2e.sh` の `tauri build` を呼ぶ行の `-f` / `--features` の値(`,` 区切り)。
fn e2e_build_features() -> Vec<String> {
    let line = e2e_build_line();
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let mut value: Option<&str> = None;
    for (i, token) in tokens.iter().enumerate() {
        if *token == "-f" || *token == "--features" {
            value = tokens.get(i + 1).copied();
        } else if let Some(rest) = token.strip_prefix("--features=") {
            value = Some(rest);
        }
    }
    let value = value.unwrap_or_else(|| panic!("the build line must pass -f / --features: {line}"));
    value
        .trim_matches(|c| c == '"' || c == '\'')
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// 31. `scripts/e2e.sh` の `tauri build` の行の `-f` / `--features` に `webdriver` と `dev-features` の両方がある(承認 2)。
#[test]
fn ac84_13_e2e_builds_with_webdriver_and_dev_features() {
    let features = e2e_build_features();
    assert!(features.iter().any(|f| f == "webdriver"), "scripts/e2e.sh keeps the webdriver feature: {features:?}");
    assert!(
        features.iter().any(|f| f == "dev-features"),
        "scripts/e2e.sh builds the E2E binary with dev-features so the editing E2E keep passing (契約10): {features:?}"
    );
}

// ---------------------------------------------------------------------------
// AC-84-14 タグの CI(契約13・ソース走査)【(p) 決定】
// ---------------------------------------------------------------------------

/// release.yml の build ジョブの steps(`- name:` 単位)= self-check-release-wiring.acceptance.test.ts と同じ切り方。
fn release_build_steps() -> Vec<(String, String)> {
    let yml = release_yml();
    let start = yml.find("\n  build:").expect("release.yml has the build job") + 1;
    let end = yml[start..].find("\n  e2e:").map(|i| start + i).unwrap_or(yml.len());
    let job = &yml[start..end];
    job.split("\n      - name: ")
        .skip(1)
        .map(|part| {
            let nl = part.find('\n').unwrap_or(part.len());
            let name = part[..nl].trim().trim_matches(|c| c == '"' || c == '\'').to_string();
            (name, part[nl.min(part.len())..].to_string())
        })
        .collect()
}

/// 32. `Release-channel smoke` のステップが `ai_marks` が flags に無いことを**実際に確かめる**(要件74 第2段 2-5: `editor_inline` は
///     撤去したので名前の一覧から外れる=AC-74-46):
///     コメントの行と `echo` の行を除いた行のうち、`--print-build-info` の出力の `flags` を見る行に 2 つの名前が両方あり
///     (=確かめの行)、その結果で `exit 1` する分岐がある(確かめの行が `VAR=…` なら、後ろの `if … $VAR …` から `fi`
///     までに `exit 1`。確かめの行自体が `if` なら、そこから `fi` まで)。`exit 1` は文字列の外で数える(`echo "… exit 1"`
///     は数えない)。表示の `echo "Smoke OK: … no editor_inline / ai_marks …"` の字面だけでは緑にならない。
///     今の確かめ(`--print-build-info`・`VELLIS_DEV_FEATURES_PRESENT`)とタグ限定(`if: github.ref_type == 'tag'`)も残る。
#[test]
fn ac84_14_release_smoke_checks_that_both_flag_names_are_absent() {
    let steps = release_build_steps();
    let (_, smoke) = steps
        .iter()
        .find(|(name, _)| name == "Release-channel smoke")
        .expect("release.yml keeps the Release-channel smoke step");
    let lines: Vec<&str> = smoke.lines().collect();
    let is_comment = |l: &str| l.trim_start().starts_with('#');
    let is_echo = |l: &str| l.trim_start().starts_with("echo");
    // 確かめの行: コメントでも echo でもなく、--print-build-info の flags を見て、2 つの名前を両方持つ。
    let check_idx = lines
        .iter()
        .position(|&l| {
            !is_comment(l)
                && !is_echo(l)
                && l.contains("--print-build-info")
                && l.contains("flags")
                && BOTH.iter().all(|&name| l.contains(name))
                && !l.contains("editor_inline")
        })
        .unwrap_or_else(|| {
            panic!(
                "the smoke must have a non-echo line that reads --print-build-info's flags and names both {BOTH:?} (契約13): {smoke}"
            )
        });
    let check = lines[check_idx].trim();
    // 止める分岐: 確かめの行が `if` ならそこから、`VAR=…` なら後ろの `if … $VAR …` から、`fi` まで。
    let guard_idx = if check.starts_with("if ") {
        check_idx
    } else {
        let var = check.split('=').next().unwrap_or("").trim();
        assert!(
            !var.is_empty() && var.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
            "the check line must be `if …` or assign its result to a shell variable (`VAR=$(…)`): {check}"
        );
        let dollar = format!("${var}");
        let braced = format!("${{{var}}}");
        lines
            .iter()
            .enumerate()
            .skip(check_idx + 1)
            .find(|&(_, l)| {
                let t = l.trim_start();
                t.starts_with("if ") && (t.contains(dollar.as_str()) || t.contains(braced.as_str()))
            })
            .map(|(i, _)| i)
            .unwrap_or_else(|| panic!("after the check line an `if … ${var} …` must decide: {smoke}"))
    };
    let fi_idx = lines
        .iter()
        .enumerate()
        .skip(guard_idx + 1)
        .find(|&(_, l)| l.trim() == "fi")
        .map(|(i, _)| i)
        .unwrap_or_else(|| panic!("the deciding `if` must close with `fi`: {smoke}"));
    let guard: String = lines[guard_idx..=fi_idx]
        .iter()
        .map(|&l| strip_shell_quotes(l))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        guard.contains("exit 1"),
        "when a dev flag leaks into flags the smoke must stop with `exit 1` (outside a string): {guard}"
    );
    assert!(smoke.contains("--print-build-info"), "the smoke still reads --print-build-info");
    assert!(smoke.contains("VELLIS_DEV_FEATURES_PRESENT"), "the smoke still checks the dev-features sentinel");
    assert!(smoke.contains("github.ref_type == 'tag'"), "the smoke stays tag-only");
    assert!(!smoke.contains("continue-on-error") && !smoke.contains("|| true"), "the smoke does not soften");
}

/// 33. build ジョブのステップの名前と並びは今のまま(新しいステップを足さない=`self-check-release-wiring` の前提)。
#[test]
fn ac84_14_release_build_steps_are_unchanged() {
    let names: Vec<String> = release_build_steps().into_iter().map(|(name, _)| name).collect();
    assert_eq!(
        names,
        vec![
            "Prepend tool paths",
            "Pin Node",
            "Toolchain (Rust / Node / corepack-pinned pnpm)",
            "Import signing certificate (temporary keychain)",
            "Build (tauri)",
            "Release-channel smoke",
            "Self-check smoke (fixtures/sample.md)",
            "Compute DMG path",
            "Notarize + staple DMG",
            "Cleanup keychain",
            "Upload DMG artifact",
        ],
        "the build job's steps must stay as they are (契約13: one more line in the smoke, no new step)"
    );
}
