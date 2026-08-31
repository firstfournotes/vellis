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
//! /// 成功ダイアログの本文。target_dir_on_path で PATH 追記手順の有無が分かれる
//! /// (構成は従来の日本語文と同じ=パス2行+案内)。
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

/// PATH 上へのインストール成功: パス2行+新しいシェルで使える旨(英語・値固定)。
#[test]
fn success_body_on_path_is_english_and_fixed() {
    let body = install_cli_success_body(&sample_result(true));
    assert_eq!(
        body,
        "Installed:\n  /Users/x/.local/bin/vellis\n  → /Applications/Vellis.app/Contents/MacOS/vellis\n\nThe `vellis` command is now available in new shells."
    );
}

/// PATH 外へのインストール成功: パス2行+ PATH 警告+ ~/.zshrc への追記例
/// (英語・値固定。追記例の export 行は従来どおり)。
#[test]
fn success_body_off_path_warns_in_english() {
    let body = install_cli_success_body(&sample_result(false));
    assert_eq!(
        body,
        "Installed:\n  /Users/x/.local/bin/vellis\n  → /Applications/Vellis.app/Contents/MacOS/vellis\n\n⚠ /Users/x/.local/bin is not on your PATH.\nAdd the following to your ~/.zshrc or similar:\n\n  export PATH=\"$HOME/.local/bin:$PATH\""
    );
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
