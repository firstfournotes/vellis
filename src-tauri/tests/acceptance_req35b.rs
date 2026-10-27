//! 要件#35 追補b の受け入れテスト(docs/requirements/req-35.md「追補b」・backlog 317・318)
//!
//! 317: DMG の中から直接起動した `vellis.app` でメニューの Install 'vellis' Command in PATH を
//! 押すと `~/.local/bin/vellis` が `/Volumes/vellis/vellis.app/Contents/MacOS/vellis` を指し、
//! DMG を取り出すとリンクが切れる。DMG は読み取り専用なので App Translocation が掛からず、
//! 追補a の判定(パスに `/AppTranslocation/` を含む)をすり抜けた。
//! 318: Finder(launchd)から起動したアプリは最小の `PATH` で動くため、`~/.local/bin` が
//! `PATH` に入っていても成功ダイアログが「⚠ … is not on your PATH」と出る。
//! 直し方は由谷が決定(2026-10-08)= 317 は**読み取り専用のボリュームにあれば作らずに案内する**
//! (追補a の判定と文言は残し、読み取り専用の判定を足して文言を分ける)・318 は**メニューの
//! 成功ダイアログは PATH を判定せず断定しない案内にする**(`--install-cli` は今のまま)。
//!
//! 受け入れ基準 AC-35-追b(一時フォルダの `HOME` で。実環境の `current_exe()`・`HOME`・`PATH`
//! には触れない。読み取り専用のボリュームの見本は `/usr/bin/true` = macOS の封印された
//! システムボリューム):
//!   (a) `is_on_read_only_volume`: `/usr/bin/true` は真。一時フォルダに作った実在のファイルは偽。
//!       存在しないパスは偽
//!       → `ac35b_a_is_on_read_only_volume_is_true_only_for_an_existing_path_on_a_read_only_mount`
//!   (b) `exe` を `/usr/bin/true` にした `install_cli_for` は `Err`。文字列は契約2 の2文を
//!       この順・改行1つの区切りで含み、追補a の文言(`App Translocation`)は含まない。
//!       `HOME/.local` は作られない
//!       → `ac35b_b_read_only_exe_is_refused_with_the_two_sentences_and_writes_nothing`
//!   (c) (b) で、すでに `HOME/.local/bin/vellis`(別の場所への symlink)があっても、そのリンクは
//!       そのまま残る(削除も張り替えもされない)
//!       → `ac35b_c_read_only_exe_leaves_an_existing_symlink_untouched`
//!   (d) `install_cli_failure_body` に (b) の `Err` を渡すと `Failed to install the CLI:\n` で
//!       始まり契約2 の2文を含む
//!       → `ac35b_d_failure_body_wraps_the_read_only_volume_error`
//!   (e) `install_cli_success_body` は `target_dir_on_path` が真でも偽でも契約3 の本文と一致する
//!       (`acceptance_req35.rs` の2件を改めたものと同じ本文)。本文に `is not on your PATH` を
//!       含まない
//!       → `ac35b_e_success_body_is_the_single_contract_3_text_regardless_of_path`
//!   (f) ソース走査: `cli_install.rs` の本文(`#[cfg(test)]` より前・行コメントを除く)に
//!       `is_on_read_only_volume` と `MNT_RDONLY` と `statfs` がある。`main.rs` の本文に
//!       `is not on your PATH` が残る(契約4= `--install-cli` は不変)
//!       → `ac35b_f_cli_install_rs_uses_statfs_and_main_rs_keeps_the_path_warning`
//!
//! ## 確定契約(implementer はこれに従う。実装先: src-tauri/src/cli_install.rs・src/menu.rs)
//!
//! ```ignore
//! // src-tauri/src/cli_install.rs
//! use std::path::Path;
//!
//! /// `libc::statfs` で `path` のファイルシステムを調べ、`f_flags` に `MNT_RDONLY` が立って
//! /// いれば真。`statfs` が失敗したとき(パスが無いなど)は偽。
//! pub fn is_on_read_only_volume(path: &Path) -> bool;
//!
//! /// 追補a の `is_translocated` の判定の**あとに**、`exe` が `is_on_read_only_volume` のとき
//! /// **何も書き換えずに**(`HOME/.local/bin` の作成も、すでにあるリンクの削除も、リンクの
//! /// 作成もしない)`Err(String)` を返す。翻訳された場所(読み取り専用でもある)は従来どおり
//! /// 追補a の文言になる。
//! pub fn install_cli_for(exe: &Path, home: &Path, path_env: &str) -> Result<InstallCliResult, String>;
//!
//! // src-tauri/src/menu.rs
//! /// `target_dir_on_path` を見ず、常に契約3 の本文(下の `SUCCESS_BODY_TEMPLATE`)を返す。
//! pub fn install_cli_success_body(result: &InstallCliResult) -> String;
//! ```
//!
//! 契約2(文言・英語): その `Err` の文字列は
//! `Vellis is running from a read-only volume (such as the disk image), so the vellis command was not installed.`
//! で始まり、続けて改行1つのあと
//! `Move Vellis.app to the Applications folder, then launch it from there and try again.`
//! とする。メニューは従来どおり `install_cli_failure_body` で `Failed to install the CLI:\n<err>`
//! に挟み、`--install-cli` は従来どおり stderr に `vellis: failed to install CLI symlink: <err>`
//! を出して終了コード 1 ―― 新しい経路は足さない。
//!
//! 契約3(メニューの成功ダイアログは1通り): `install_cli_success_body` は常に
//! `Installed:\n{target}\n→ {source}\n\nOpen a new terminal window and run `vellis`.\n`
//! `If the command is not found, add the following to your ~/.zshrc or similar:\n\n`
//! `export PATH="$HOME/.local/bin:$PATH"` を返す(`{target}` `{source}` は `target_path` /
//! `source_path` の `display()`)。これに合わせて `acceptance_req35.rs` の成功本文2件の期待値は
//! 要件側で改めた(契約3 で事前承認・test-writer が改める・implementer は触らない)。
//! 要件35 追補d 改訂 d-2(2026-10-25 由谷「字下げをやめる」・Issue #720)で、target・→ source・
//! `export PATH=…` の 3 行の行頭の空白 2 つを除いた(macOS 27 の NSAlert が行頭の空白を消すため)。
//!
//! 契約4・5(不変): `--install-cli`(`main.rs`)の成功時の表示(PATH 上なら
//! `` You can now run `vellis` from any shell. ``・無ければ `⚠ … is not on your PATH.` と追記の
//! 手順)は今のまま。`InstallCliResult` の形(`target_dir_on_path` を含む・`Debug` 導出は
//! 足さなくてよい=本テストは Ok 値を `{:?}` しない)・書き込めるボリュームでの振る舞い・
//! 追補a の判定と文言・`install_cli_failure_body` の本文の形・ダイアログ題・`HOME` が無いときの
//! `Err("HOME not set")`。依存の追加なし(`libc` は既存)。AC-35-8(`menu.rs` のコード行に CJK
//! なし)を保つ。
//!
//! 本テストで判定しないもの(reviewer 照合): `is_translocated` の判定が `is_on_read_only_volume`
//! の**前**にあること(翻訳された場所は読み取り専用でもあるが、一時フォルダには読み取り専用の
//! `/AppTranslocation/` を作れない)・`handle_install_cli_click` と `main.rs --install-cli` が
//! 従来の経路のまま新しい `Err` を表示すること・実機の DMG からの起動(人間ゲート)。
//!
//! 修正前の見込み: `is_on_read_only_volume` が無いので本ファイルはコンパイルせず、(a)〜(f) の
//! 全件が赤。単独でも (b)(c)(d) は `/usr/bin/true` が `/AppTranslocation/` を含まず `Ok` に
//! なるので赤、(e) は現行の本文が `target_dir_on_path` で分岐するので赤、(f) は
//! `cli_install.rs` に3語とも無いので赤。
//!
//! ## 本テストの組み立て
//!
//! - 一時フォルダは `tempfile::tempdir()`(既存テストと同じ・依存追加なし)。ルートを
//!   canonicalize してから使う(acceptance_req35a.rs と同じ流儀)。
//! - 読み取り専用の `exe` は `/usr/bin/true`(実在・macOS の封印されたシステムボリューム上。
//!   テストの前提として `exists()` を確かめる)。パスに `/AppTranslocation/` を含まないので、
//!   追補a の判定には掛からない。
//! - 書き込めるボリュームの見本は一時フォルダに作った実在のファイル(`/private/var/…` =
//!   Data ボリューム)。

use std::fs;
use std::path::{Path, PathBuf};

use tempfile::TempDir;

use vellis_lib::cli_install::{install_cli_for, is_on_read_only_volume, InstallCliResult};
use vellis_lib::menu::{install_cli_failure_body, install_cli_success_body};

/// 契約2 の1文目(`Err` の先頭)。
const SENTENCE_1: &str = "Vellis is running from a read-only volume (such as the disk image), so the vellis command was not installed.";
/// 契約2 の2文目(改行1つのあと)。
const SENTENCE_2: &str =
    "Move Vellis.app to the Applications folder, then launch it from there and try again.";

/// 追補a の文言の目印(契約1: 読み取り専用の案内には混ざらない)。
const TRANSLOCATION_MARKER: &str = "App Translocation";

/// 読み取り専用のボリューム上の実在のファイル(macOS の封印されたシステムボリューム)。
const READ_ONLY_EXE: &str = "/usr/bin/true";

/// 契約3 の本文の固定部(パス2行のあと)。要件35 追補d 改訂 d-2(2026-10-25 由谷「字下げを
/// やめる」)で `export PATH=…` の行頭の空白 2 つを除いた。
const SUCCESS_BODY_TAIL: &str = "Open a new terminal window and run `vellis`.\nIf the command is not found, add the following to your ~/.zshrc or similar:\n\nexport PATH=\"$HOME/.local/bin:$PATH\"";

/// 契約4 の目印(`main.rs` の `--install-cli` に残る PATH の警告)。
const PATH_WARNING: &str = "is not on your PATH";

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

/// 日本語(CJK)の検知(acceptance_req35.rs と同じ定義): CJK 記号・句読点(U+3000–303F)・
/// かな(U+3040–30FF)・CJK 統合漢字(U+4E00–9FFF)・全角形(U+FF00–FFEF)。
fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| {
        matches!(c,
            '\u{3000}'..='\u{30FF}'
                | '\u{4E00}'..='\u{9FFF}'
                | '\u{FF00}'..='\u{FFEF}'
        )
    })
}

/// 一時フォルダ(canonical なルート)と、その中の `HOME`。
struct Fixture {
    _dir: TempDir,
    root: PathBuf,
    home: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("create temp dir");
        let root = dir
            .path()
            .canonicalize()
            .expect("canonicalize the temp dir root");
        let home = root.join("home");
        fs::create_dir(&home).expect("create HOME dir");
        Fixture {
            _dir: dir,
            root,
            home,
        }
    }

    /// `HOME/.local/bin`。
    fn local_bin(&self) -> PathBuf {
        self.home.join(".local").join("bin")
    }

    /// `HOME/.local/bin/vellis`(リンクの置き場)。
    fn target(&self) -> PathBuf {
        self.local_bin().join("vellis")
    }

    /// ルートの下に `rel` の実在のファイルを作って返す(親フォルダも作る)。
    fn write_file(&self, rel: &str) -> PathBuf {
        let path = self.root.join(rel);
        fs::create_dir_all(path.parent().expect("file has a parent")).expect("create parent dirs");
        fs::write(&path, b"#!/bin/sh\n").expect("write the file");
        path
    }

    /// 書き込めるボリューム上の実在のファイル(一時フォルダの下)。
    fn writable_file(&self) -> PathBuf {
        self.write_file("Applications/vellis.app/Contents/MacOS/vellis")
    }

    /// `HOME/.local/bin/vellis` に、別の場所(`elsewhere/vellis`・実在のファイル)への symlink を
    /// あらかじめ張る。張った先を返す。
    fn preinstall_symlink_elsewhere(&self) -> PathBuf {
        let elsewhere = self.write_file("elsewhere/vellis");
        fs::create_dir_all(self.local_bin()).expect("create HOME/.local/bin");
        std::os::unix::fs::symlink(&elsewhere, self.target())
            .expect("pre-create the existing symlink");
        assert_eq!(
            fs::read_link(self.target()).expect("read the pre-created symlink"),
            elsewhere,
            "test setup: the pre-created symlink must point elsewhere"
        );
        elsewhere
    }

    /// `HOME/.local/bin` を含む `PATH`。
    fn path_env_with_local_bin(&self) -> String {
        format!("/usr/bin:{}:/bin", self.local_bin().display())
    }
}

/// 読み取り専用のボリューム上の `exe`(`/usr/bin/true`)。実在することと、追補a の判定に
/// 掛からない(パスに `/AppTranslocation/` を含まない)ことを前提として確かめる。
fn read_only_exe() -> PathBuf {
    let exe = PathBuf::from(READ_ONLY_EXE);
    assert!(
        exe.exists(),
        "test setup: {READ_ONLY_EXE} must exist (macOS sealed system volume)"
    );
    assert!(
        !exe.to_string_lossy().contains("/AppTranslocation/"),
        "test setup: the read-only exe must not look translocated; got {}",
        exe.display()
    );
    exe
}

/// `install_cli_for` の `Err` を取り出す(`InstallCliResult` は `Debug` を持たないので
/// `unwrap_err` は使えない)。
fn expect_err(result: Result<InstallCliResult, String>, what: &str) -> String {
    match result {
        Err(e) => e,
        Ok(ok) => panic!(
            "{what}: install_cli_for must return Err, but it returned Ok(target_path = {}, source_path = {}, target_dir_on_path = {})",
            ok.target_path.display(),
            ok.source_path.display(),
            ok.target_dir_on_path
        ),
    }
}

/// `Err` が契約2 の2文をこの順・改行1つの区切りで含み、追補a の文言を含まず、英語であること。
fn assert_read_only_sentences(err: &str) {
    assert!(
        err.starts_with(SENTENCE_1),
        "the Err must start with the first sentence of contract 2; got: {err:?}"
    );
    let two_sentences = format!("{SENTENCE_1}\n{SENTENCE_2}");
    assert!(
        err.contains(&two_sentences),
        "the Err must contain the two sentences of contract 2 in this order, separated by exactly \
         one newline; got: {err:?}"
    );
    assert!(
        !err.contains(TRANSLOCATION_MARKER),
        "a read-only volume (not translocated) must get the read-only wording, not the \
         App Translocation wording of 追補a (contract 1); got: {err:?}"
    );
    assert!(
        !has_cjk(err),
        "the Err wording is English (contract 2); got: {err:?}"
    );
}

/// acceptance_req35.rs と同じ見本の `InstallCliResult`。
fn sample_result(target_dir_on_path: bool) -> InstallCliResult {
    InstallCliResult {
        target_path: PathBuf::from("/Users/x/.local/bin/vellis"),
        source_path: PathBuf::from("/Applications/Vellis.app/Contents/MacOS/vellis"),
        target_dir_on_path,
    }
}

/// 契約3 の本文を `sample_result` のパスで組んだもの。要件35 追補d 改訂 d-2(2026-10-25 由谷
/// 「字下げをやめる」)で target・→ source の 2 行の行頭の空白 2 つを除いた。
fn expected_success_body() -> String {
    format!(
        "Installed:\n/Users/x/.local/bin/vellis\n→ /Applications/Vellis.app/Contents/MacOS/vellis\n\n{SUCCESS_BODY_TAIL}"
    )
}

// ---------------------------------------------------------------------------
// (a) is_on_read_only_volume — 読み取り専用のマウント上の実在のパスだけが真
// ---------------------------------------------------------------------------

#[test]
fn ac35b_a_is_on_read_only_volume_is_true_only_for_an_existing_path_on_a_read_only_mount() {
    let fx = Fixture::new();

    let read_only = read_only_exe();
    assert!(
        is_on_read_only_volume(&read_only),
        "{} lies on the sealed (read-only) system volume, so MNT_RDONLY must be seen (contract 1)",
        read_only.display()
    );

    let writable = fx.writable_file();
    assert!(
        !is_on_read_only_volume(&writable),
        "a real file in a temp dir is on a writable volume, so it must be false (contract 1); \
         path: {}",
        writable.display()
    );

    let missing_in_temp = fx.root.join("does-not-exist").join("vellis");
    assert!(
        !missing_in_temp.exists() && !missing_in_temp.is_symlink(),
        "test setup: {} must not exist",
        missing_in_temp.display()
    );
    assert!(
        !is_on_read_only_volume(&missing_in_temp),
        "a path that does not exist makes statfs fail, which must be false (contract 1); \
         path: {}",
        missing_in_temp.display()
    );

    let missing_on_read_only = Path::new("/usr/bin/vellis-does-not-exist-ac35b");
    assert!(
        !missing_on_read_only.exists() && !missing_on_read_only.is_symlink(),
        "test setup: {} must not exist",
        missing_on_read_only.display()
    );
    assert!(
        !is_on_read_only_volume(missing_on_read_only),
        "a missing path must be false even when its parent lies on a read-only volume \
         (contract 1: statfs failure is false, not a guess from the parent); path: {}",
        missing_on_read_only.display()
    );
}

// ---------------------------------------------------------------------------
// (b) 読み取り専用の exe → Err(契約2 の2文・追補a の文言なし)・HOME/.local は作られない
// ---------------------------------------------------------------------------

#[test]
fn ac35b_b_read_only_exe_is_refused_with_the_two_sentences_and_writes_nothing() {
    let fx = Fixture::new();
    let exe = read_only_exe();

    let err = expect_err(
        install_cli_for(&exe, &fx.home, &fx.path_env_with_local_bin()),
        "read-only exe",
    );
    assert_read_only_sentences(&err);

    assert!(
        !fx.home.join(".local").exists(),
        "a read-only exe must not create HOME/.local (contract 1: write nothing); found {}",
        fx.home.join(".local").display()
    );
    assert!(
        !fx.target().exists() && !fx.target().is_symlink(),
        "a read-only exe must not create the symlink HOME/.local/bin/vellis (contract 1)"
    );
}

// ---------------------------------------------------------------------------
// (c) 読み取り専用の exe → 既存のリンクはそのまま(削除も張り替えもされない)
// ---------------------------------------------------------------------------

#[test]
fn ac35b_c_read_only_exe_leaves_an_existing_symlink_untouched() {
    let fx = Fixture::new();
    let elsewhere = fx.preinstall_symlink_elsewhere();
    let exe = read_only_exe();

    let err = expect_err(
        install_cli_for(&exe, &fx.home, &fx.path_env_with_local_bin()),
        "read-only exe with an existing symlink",
    );
    assert_read_only_sentences(&err);

    assert!(
        fx.target().is_symlink(),
        "the existing symlink HOME/.local/bin/vellis must still be there (contract 1: no removal)"
    );
    assert_eq!(
        fs::read_link(fx.target()).expect("read the existing symlink"),
        elsewhere,
        "the existing symlink must still point where it pointed before (contract 1: no re-link)"
    );
    assert_ne!(
        fs::read_link(fx.target()).expect("read the existing symlink"),
        exe,
        "the existing symlink must not have been re-pointed at the read-only exe"
    );
    let entries: Vec<_> = fs::read_dir(fx.local_bin())
        .expect("list HOME/.local/bin")
        .map(|e| e.expect("dir entry").file_name())
        .collect();
    assert_eq!(
        entries,
        vec![std::ffi::OsString::from("vellis")],
        "HOME/.local/bin must hold only the pre-existing link (contract 1: write nothing)"
    );
}

// ---------------------------------------------------------------------------
// (d) install_cli_failure_body に (b) の Err を渡す → 従来の定型文に挟まる
// ---------------------------------------------------------------------------

#[test]
fn ac35b_d_failure_body_wraps_the_read_only_volume_error() {
    let fx = Fixture::new();
    let exe = read_only_exe();
    let err = expect_err(
        install_cli_for(&exe, &fx.home, &fx.path_env_with_local_bin()),
        "read-only exe (for the failure body)",
    );

    let body = install_cli_failure_body(&err);

    assert!(
        body.starts_with("Failed to install the CLI:\n"),
        "the menu failure body must keep its prefix (contract 2 / AC-35-6); got: {body:?}"
    );
    let two_sentences = format!("{SENTENCE_1}\n{SENTENCE_2}");
    assert!(
        body.contains(&two_sentences),
        "the menu failure body must carry the two sentences of contract 2 in this order; got: {body:?}"
    );
    assert_eq!(
        body,
        format!("Failed to install the CLI:\n{err}"),
        "the failure body wraps the Err as `Failed to install the CLI:\\n<err>` with no other route (contract 2 / 5)"
    );
    assert!(
        !body.contains(TRANSLOCATION_MARKER),
        "the failure body for a read-only volume must not carry the App Translocation wording; got: {body:?}"
    );
    assert!(
        !has_cjk(&body),
        "the failure body is English (AC-35-7); got: {body:?}"
    );
}

// ---------------------------------------------------------------------------
// (e) install_cli_success_body は target_dir_on_path を見ず、常に契約3 の本文
// ---------------------------------------------------------------------------

#[test]
fn ac35b_e_success_body_is_the_single_contract_3_text_regardless_of_path() {
    let expected = expected_success_body();

    for on_path in [true, false] {
        let body = install_cli_success_body(&sample_result(on_path));
        assert_eq!(
            body, expected,
            "install_cli_success_body must return the contract-3 text whether target_dir_on_path \
             is {on_path} or not (contract 3: one body, no PATH judgement in the menu)"
        );
        assert!(
            !body.contains(PATH_WARNING),
            "the menu success body must not claim `{PATH_WARNING}` (contract 3, target_dir_on_path = {on_path}); got: {body:?}"
        );
        // 要件35 追補d 改訂 d-2(2026-10-25 由谷「字下げをやめる」): どの行も空白で始まらない
        // (macOS 27 の NSAlert が行頭の空白を消すので、本文に字下げを置かない)。
        assert!(
            !body.contains("\n ") && !body.starts_with(' '),
            "no line of the menu success body may start with a space (追補d d-2: no indentation, \
             target_dir_on_path = {on_path}); got: {body:?}"
        );
        assert!(
            !has_cjk(&body),
            "the success body is English (AC-35-7, target_dir_on_path = {on_path}); got: {body:?}"
        );
    }

    assert_eq!(
        install_cli_success_body(&sample_result(true)),
        install_cli_success_body(&sample_result(false)),
        "the two bodies must be identical (contract 3)"
    );
}

// ---------------------------------------------------------------------------
// (f) ソース走査: cli_install.rs に is_on_read_only_volume・MNT_RDONLY・statfs、
//     main.rs に `is not on your PATH`
// ---------------------------------------------------------------------------

/// 行ごとに `//` 以降(コメント)を落とす。`://` は落とさない(acceptance_req35a と同じ流儀)。
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

/// ソースの `#[cfg(test)]` より前・行コメントを除いた本文。
fn code_body(src: &str) -> String {
    let code = strip_line_comments(src);
    match code.find("#[cfg(test)]") {
        Some(i) => code[..i].to_string(),
        None => code,
    }
}

#[test]
fn ac35b_f_cli_install_rs_uses_statfs_and_main_rs_keeps_the_path_warning() {
    let cli_install = code_body(include_str!("../src/cli_install.rs"));
    assert!(
        cli_install.contains("is_on_read_only_volume"),
        "cli_install.rs must define `is_on_read_only_volume` in code, not only in comments (contract 1)"
    );
    assert!(
        cli_install.contains("MNT_RDONLY"),
        "cli_install.rs must test `f_flags` for `MNT_RDONLY` in code (contract 1)"
    );
    assert!(
        cli_install.contains("statfs"),
        "cli_install.rs must call `statfs` in code (contract 1)"
    );

    let main_rs = code_body(include_str!("../src/main.rs"));
    assert!(
        main_rs.contains(PATH_WARNING),
        "main.rs must keep the `{PATH_WARNING}` warning of `--install-cli` in code (contract 4: \
         the shell path still judges PATH)"
    );
}
