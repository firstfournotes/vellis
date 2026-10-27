//! 要件#35 の受け入れテスト(requirements.md #35)— Rust 層
//!
//! 「右クリックメニュー(ファイルツリーのコンテキストメニュー)とウィンドウ上部の
//!  メニューバーの表示、およびメニュー起点の体験一式(ダイアログ題・エラー通知)を
//!  全部英語にする」
//!
//! 本ファイルの持ち場(Rust 層の機械判定):
//! - 契約③: CLI インストール結果ダイアログ本文(menu.rs の handle_install_cli_click)
//!   の英語化 — 本文の組み立てを純関数へ切り出し、値を固定する
//! - 契約②: メニューバー(menu.rs)の項目ラベルが全英語のまま=menu.rs の
//!   コード行(コメント除く)に日本語(CJK)が残らないことのソース走査。
//!   これは③の「対象箇所に日本語が残らないこと」の判定も兼ねる
//!   (日本語コメントは家風のとおり残ってよい=走査対象外)
//!
//! フロント側(コンテキストメニューのラベル・ダイアログ題・alert 文言)は
//! `src/lib/menu-language.acceptance.test.ts` と
//! `src/lib/context-menu.acceptance.test.ts`(契約⑥の要件側更新)が判定する。
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```ignore
//! // src-tauri/src/menu.rs(cli_install.rs 側の実装+ menu からの再 export でも可)
//! use crate::cli_install::InstallCliResult;
//!
//! /// 成功ダイアログの本文。追補b(2026-10-08・backlog 318)の契約3 により target_dir_on_path を
//! /// 見ず、常に1通り(パス2行+断定しない案内+ ~/.zshrc への追記例)。
//! pub fn install_cli_success_body(result: &InstallCliResult) -> String;
//!
//! /// 失敗ダイアログの本文。install_cli() の Err(String) をそのまま挟む。
//! pub fn install_cli_failure_body(err: &str) -> String;
//! ```
//!
//! handle_install_cli_click はこの2関数の返り値をダイアログ本文に使う(配線は
//! reviewer 照合)。ダイアログ題 "Vellis CLI" は既に英語=変更なし。
//!
//! ## 文言の設計判断(本テストの確定)
//! 英語文言は要件に推奨がないため本テストで確定する(下の期待値が正)。
//! gate で由谷が文言 NG とした場合は要件側で文言を確定してから acceptance を
//! 更新する(契約①の脱出口=要件#24 と同じ運用・事前承認済み)。
//! 成功ダイアログの本文2件は追補b(docs/requirements/req-35.md「追補b」契約3・backlog 318)で
//! 要件側から改めた(PATH を判定しない1通りの本文=2026-10-08 由谷承認)。さらに追補d の
//! 改訂 d-2(2026-10-25 由谷「字下げをやめる」・Issue #720)で 3 行の行頭の空白 2 つを除いた。
//!
//! ## 人間ゲート(acceptance/acceptance.md)
//! - 実機のメニューバー表示・CLI インストールダイアログの見た目と文言の妥当性・
//!   実機で日本語が見えるメニュー項目があれば由谷指摘で追補(契約②)

use std::path::PathBuf;

use vellis_lib::cli_install::InstallCliResult;
use vellis_lib::menu::{install_cli_failure_body, install_cli_success_body};

/// 日本語(CJK)の検知: CJK 記号・句読点(U+3000–303F)・かな(U+3040–30FF)・
/// CJK 統合漢字(U+4E00–9FFF)・全角形(U+FF00–FFEF)。
/// "…"(U+2026)・"→"(U+2192)・"⚠"(U+26A0)は英語 UI でも使う記号なので対象外。
fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| {
        matches!(c,
            '\u{3000}'..='\u{30FF}'
                | '\u{4E00}'..='\u{9FFF}'
                | '\u{FF00}'..='\u{FFEF}'
        )
    })
}

fn sample_result(target_dir_on_path: bool) -> InstallCliResult {
    InstallCliResult {
        target_path: PathBuf::from("/Users/x/.local/bin/vellis"),
        source_path: PathBuf::from("/Applications/Vellis.app/Contents/MacOS/vellis"),
        target_dir_on_path,
    }
}

// ---------------------------------------------------------------------------
// 契約③ — CLI インストール結果ダイアログ本文の英語化(値固定)
// ---------------------------------------------------------------------------

/// 成功ダイアログの本文(英語・値固定)。追補b 契約3(2026-10-08 由谷承認)で
/// `target_dir_on_path` に依らず1通りになった=パス2行+断定しない案内+ ~/.zshrc への
/// 追記例(追記例の export 行は従来どおり)。
/// 要件35 追補d 改訂 d-2(2026-10-25 由谷「字下げをやめる」・Issue #720)で、target・→ source・
/// `export PATH=…` の 3 行の行頭の空白 2 つを除いた(macOS 27 の NSAlert が行頭の空白を消すため。
/// 行の並び・空行・文言はそのまま)。
const SUCCESS_BODY: &str = "Installed:\n/Users/x/.local/bin/vellis\n→ /Applications/Vellis.app/Contents/MacOS/vellis\n\nOpen a new terminal window and run `vellis`.\nIf the command is not found, add the following to your ~/.zshrc or similar:\n\nexport PATH=\"$HOME/.local/bin:$PATH\"";

/// PATH 上へのインストール成功: 追補b 契約3 の本文(要件側更新・2026-10-08)。
#[test]
fn success_body_on_path_is_english_and_fixed() {
    let body = install_cli_success_body(&sample_result(true));
    assert_eq!(body, SUCCESS_BODY);
}

/// PATH 外へのインストール成功: 追補b 契約3 により PATH 上と同じ本文(要件側更新・
/// 2026-10-08。メニューは PATH を判定しないので `is not on your PATH` は出さない)。
#[test]
fn success_body_off_path_warns_in_english() {
    let body = install_cli_success_body(&sample_result(false));
    assert_eq!(body, SUCCESS_BODY);
}

/// 失敗ダイアログ: 英語の定型文+エラー内容の素通し(値固定)。
#[test]
fn failure_body_is_english_and_carries_the_error() {
    assert_eq!(
        install_cli_failure_body("HOME not set"),
        "Failed to install the CLI:\nHOME not set"
    );
}

/// 機械判定「対象箇所に日本語が残らないこと」: 3変種すべての本文に CJK が無い
/// (エラー内容の素通し分は除く= ASCII エラーで判定)。
#[test]
fn dialog_bodies_contain_no_cjk() {
    assert!(!has_cjk(&install_cli_success_body(&sample_result(true))));
    assert!(!has_cjk(&install_cli_success_body(&sample_result(false))));
    assert!(!has_cjk(&install_cli_failure_body("symlink failed")));
}

// ---------------------------------------------------------------------------
// 契約② — menu.rs のコード行に日本語が残らない(ソース走査)
// ---------------------------------------------------------------------------

/// メニューバーの項目ラベルが全英語のまま(契約②=変更なしの確認)と、
/// handle_install_cli_click の日本語本文が menu.rs から消えたこと(契約③)を
/// まとめて固定する。行ごとに最初の `//` 以降(コメント)を落としてから CJK を
/// 探すので、家風の日本語コメントは残ってよい。文字列リテラル中の `//`
/// (URL 等)も切り落とすが、それは検知を緩める方向にしか働かない
/// (コメント外の日本語を誤検知することはない)。
#[test]
fn menu_rs_code_lines_contain_no_cjk() {
    let source = include_str!("../src/menu.rs");
    for (idx, line) in source.lines().enumerate() {
        let code = line.split("//").next().unwrap_or("");
        assert!(
            !has_cjk(code),
            "menu.rs の {} 行目のコード(コメント外)に日本語が残っている: {}",
            idx + 1,
            line
        );
    }
}
