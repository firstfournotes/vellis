//! Issue #701 の受け入れテスト(要件なし・ET の痕跡を消す)
//!
//! 契約: `src-tauri/src/cli.rs` の `Cli::path` の doc コメント(= clap が `--help` に出す文)から
//! `et://...` を外す。`vellis --help` / `vellis -h` に `et://` が出ない。`ssh://` は出たまま。
//!
//! 判定は clap の `CommandFactory`(`Cli::command()`)で help を描画して文を見る(バイナリは起動しない)。
//! 長い help(`--help`)・短い help(`-h`)・`path` 引数の help 文の 3 つを見る。
//!
//! ## 赤の源
//! 今の doc コメントは `Target path or URI (file, directory, ssh://..., et://...)` なので、
//! 3 件とも `et://` を含んで赤。`ssh://` は今も含む(歯止め= `ssh://` まで消す直し方を弾く)。

use clap::CommandFactory;

use vellis_lib::cli::Cli;

fn long_help() -> String {
    Cli::command().render_long_help().to_string()
}

fn short_help() -> String {
    Cli::command().render_help().to_string()
}

fn path_argument_help() -> String {
    let cmd = Cli::command();
    let arg = cmd
        .get_arguments()
        .find(|a| a.get_id().as_str() == "path")
        .expect("Cli keeps the positional `path` argument");
    arg.get_help()
        .map(|h| h.to_string())
        .expect("the `path` argument has a help text (doc comment)")
}

/// `vellis --help` に `et://` が出ない。`ssh://` は出たまま。
#[test]
fn issue701_long_help_mentions_ssh_but_not_et() {
    let help = long_help();
    assert!(
        !help.contains("et://"),
        "`vellis --help` must not mention et:// (Issue #701), got:\n{help}"
    );
    assert!(
        help.contains("ssh://"),
        "`vellis --help` still mentions ssh://, got:\n{help}"
    );
}

/// `vellis -h` に `et://` が出ない。`ssh://` は出たまま。
#[test]
fn issue701_short_help_mentions_ssh_but_not_et() {
    let help = short_help();
    assert!(
        !help.contains("et://"),
        "`vellis -h` must not mention et:// (Issue #701), got:\n{help}"
    );
    assert!(
        help.contains("ssh://"),
        "`vellis -h` still mentions ssh://, got:\n{help}"
    );
}

/// `Cli::path` の help 文(doc コメント)そのものに `et://` が無く、`ssh://` は残る。
#[test]
fn issue701_path_argument_help_mentions_ssh_but_not_et() {
    let help = path_argument_help();
    assert!(
        !help.contains("et://"),
        "the `path` argument's help must not mention et:// (Issue #701), got: `{help}`"
    );
    assert!(
        help.contains("ssh://"),
        "the `path` argument's help still mentions ssh://, got: `{help}`"
    );
}
