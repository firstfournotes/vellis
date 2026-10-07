//! 要件#35 追補a の受け入れテスト(docs/requirements/req-35.md「追補a」・backlog 302)
//!
//! quarantine 付きのまま `/Applications` へ入れた `vellis.app` を Finder から起動すると、
//! macOS の App Translocation により本体は
//! `/private/var/folders/…/AppTranslocation/<UUID>/d/vellis.app/…` から動く。その状態で
//! メニューの Install 'vellis' Command in PATH を押すと `~/.local/bin/vellis` がその一時的な
//! 場所へ張られ、終了すると一時的な場所が消えてリンクが切れる。直し方は由谷が選択
//! (2026-10-07)=**作らずに案内する**(元の場所を解決してリンクする案は採らない)。
//!
//! 受け入れ基準 AC-35-追a(一時フォルダの `HOME` で。実環境の `current_exe()`・`HOME`・`PATH`
//! には触れない):
//!   (a) `is_translocated`: `/private/var/folders/ab/xyz/T/AppTranslocation/<UUID>/d/vellis.app/
//!       Contents/MacOS/vellis` は真。`/Applications/…`・`/Users/x/Downloads/…`・`/Volumes/Vellis/…`
//!       の各 `vellis.app/Contents/MacOS/vellis` と `/Users/x/AppTranslocationNotes/vellis` は偽
//!       → `ac35a_a_is_translocated_detects_only_the_app_translocation_segment`
//!   (b) 一時的な場所の `exe` で `install_cli_for` は `Err`。文字列は契約2 の2文をこの順・
//!       改行1つの区切りで含む。`HOME/.local` は作られない
//!       → `ac35a_b_translocated_exe_is_refused_with_the_two_sentences_and_writes_nothing`
//!   (c) (b) で、すでに `HOME/.local/bin/vellis`(別の場所への symlink)があっても、そのリンクは
//!       そのまま残る(削除も張り替えもされない)
//!       → `ac35a_c_translocated_exe_leaves_an_existing_symlink_untouched`
//!   (d) 通常の場所の `exe`(一時フォルダに作った実在のファイル。パスに `/AppTranslocation/` を
//!       含まない)で `install_cli_for` は `Ok`。`target_path` は `HOME/.local/bin/vellis`・
//!       symlink の先は `exe`・`source_path` は `exe`。すでにあるリンクは張り替わる。`path_env` に
//!       `HOME/.local/bin` を含めば `target_dir_on_path` は真、含まなければ偽
//!       → `ac35a_d1_normal_exe_installs_the_symlink_and_sees_local_bin_on_path`
//!       → `ac35a_d2_normal_exe_replaces_an_existing_symlink_and_sees_local_bin_off_path`
//!   (e) `install_cli_failure_body` に (b) の `Err` を渡すと `Failed to install the CLI:\n` で
//!       始まり契約2 の2文を含む
//!       → `ac35a_e_failure_body_wraps_the_translocation_error`
//!   (f) ソース走査: `cli_install.rs` の本文(`#[cfg(test)]` より前・行コメントを除く)に
//!       `/AppTranslocation/` と `is_translocated` と `install_cli_for` がある
//!       → `ac35a_f_cli_install_rs_body_has_the_guard_and_install_cli_for`
//!
//! ## 確定契約(implementer はこれに従う。実装先: src-tauri/src/cli_install.rs)
//!
//! ```ignore
//! // src-tauri/src/cli_install.rs
//! use std::path::Path;
//!
//! /// パスを文字列にしたとき `/AppTranslocation/` を含む(= App Translocation 中の一時的な場所)。
//! pub fn is_translocated(path: &Path) -> bool;
//!
//! /// 試験の口。`install_cli()` は「`current_exe()` を canonicalize → `HOME` を読む → `PATH` を
//! /// 読む → `install_cli_for(&exe, &home, &path_env)`」と同じ。リンクの作成・既存の置き換え・
//! /// `target_dir_on_path` の判定(`path_env` を `:` で割って `HOME/.local/bin` と一致する要素が
//! /// あるか)は従来どおりの手順でこちらへ移す。`is_translocated` の判定は渡された `exe` に対して
//! /// この中で行い、真なら **何も書き換えずに**(`HOME/.local/bin` の作成も、すでにあるリンクの
//! /// 削除も、リンクの作成もしない)`Err(String)` を返す。
//! pub fn install_cli_for(exe: &Path, home: &Path, path_env: &str) -> Result<InstallCliResult, String>;
//! ```
//!
//! 契約2(文言・英語): その `Err` の文字列は
//! `Vellis is running from a temporary location (macOS App Translocation), so the vellis command was not installed.`
//! で始まり、続けて改行1つのあと
//! `Move Vellis.app to the Applications folder, then launch it from there and try again.`
//! とする。メニュー(`menu.rs` の `install_cli_failure_body`)は従来どおりこれを
//! `Failed to install the CLI:\n<err>` に挟み、`--install-cli`(`main.rs`)は従来どおり stderr に
//! `vellis: failed to install CLI symlink: <err>` を出して終了コード 1 ―― 新しい経路は足さない。
//!
//! 契約4(不変): 通常の場所(`/Applications`・`~/Applications`・DMG の中など `/AppTranslocation/` を
//! 含まないパス)での振る舞い・`InstallCliResult` の形(`Debug` 導出も足さなくてよい=本テストは
//! Ok 値を `{:?}` しない)・`install_cli_success_body` / `install_cli_failure_body` の本文・
//! ダイアログ題・`HOME` が無いときの `Err("HOME not set")`。依存の追加なし。既存のテスト
//! (`acceptance_req35.rs` ほか)は無改変で緑。AC-35-8(`menu.rs` のコード行に CJK なし)を保つ。
//!
//! 本テストで判定しないもの(reviewer 照合): `install_cli()` が `install_cli_for` へ委ねる配線・
//! `handle_install_cli_click` と `main.rs --install-cli` が従来の経路のまま新しい `Err` を表示する
//! こと(実環境の `current_exe()` を一時的な場所にはできない)。
//!
//! 修正前の見込み: `is_translocated` / `install_cli_for` が無いので本ファイルはコンパイルせず、
//! (a)〜(f) の全件が赤。(f) は単独でも赤(`cli_install.rs` に3語とも無い)。
//!
//! ## 本テストの組み立て
//!
//! - 一時フォルダは `tempfile::tempdir()`(既存テストと同じ・依存追加なし)。ルートを
//!   canonicalize してから使う(macOS の `/var` → `/private/var` の差で「`source_path` は `exe`」が
//!   揺れないようにするため。契約は `install_cli()` 側で canonicalize する手順なので、
//!   `install_cli_for` が canonicalize してもしなくても等しくなる)。
//! - 一時的な場所の `exe` は、一時フォルダの下に `AppTranslocation/<UUID>/d/vellis.app/Contents/
//!   MacOS/vellis` を**実在のファイル**として作る(パスに `/AppTranslocation/` を含む)。
//! - 通常の場所の `exe` は、一時フォルダの下に `Applications/vellis.app/Contents/MacOS/vellis` を
//!   実在のファイルとして作る(パスに `/AppTranslocation/` を含まないことを前提として確かめる)。

use std::fs;
use std::path::{Path, PathBuf};

use tempfile::TempDir;

use vellis_lib::cli_install::{install_cli_for, is_translocated, InstallCliResult};
use vellis_lib::menu::install_cli_failure_body;

/// 契約2 の1文目(`Err` の先頭)。
const SENTENCE_1: &str = "Vellis is running from a temporary location (macOS App Translocation), so the vellis command was not installed.";
/// 契約2 の2文目(改行1つのあと)。
const SENTENCE_2: &str =
    "Move Vellis.app to the Applications folder, then launch it from there and try again.";

/// App Translocation の UUID 部分の見本((a) の `0F3A-…` を埋めたもの)。
const TRANSLOCATION_UUID: &str = "0F3A1B2C-4D5E-6F70-8192-A3B4C5D6E7F8";

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

    /// 一時的な場所(App Translocation)の `exe`。実在のファイルで、パスに `/AppTranslocation/` を含む。
    fn translocated_exe(&self) -> PathBuf {
        let exe = self.write_file(&format!(
            "AppTranslocation/{TRANSLOCATION_UUID}/d/vellis.app/Contents/MacOS/vellis"
        ));
        assert!(
            exe.to_string_lossy().contains("/AppTranslocation/"),
            "test setup: the translocated exe path must contain /AppTranslocation/; got {}",
            exe.display()
        );
        exe
    }

    /// 通常の場所の `exe`。実在のファイルで、パスに `/AppTranslocation/` を含まない。
    fn normal_exe(&self) -> PathBuf {
        let exe = self.write_file("Applications/vellis.app/Contents/MacOS/vellis");
        assert!(
            !exe.to_string_lossy().contains("/AppTranslocation/"),
            "test setup: the normal exe path must not contain /AppTranslocation/; got {}",
            exe.display()
        );
        exe
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

/// `HOME/.local/bin` を含まない `PATH`。
const PATH_ENV_WITHOUT_LOCAL_BIN: &str = "/usr/bin:/bin";

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

/// `install_cli_for` の `Ok` を取り出す。
fn expect_ok(result: Result<InstallCliResult, String>, what: &str) -> InstallCliResult {
    match result {
        Ok(ok) => ok,
        Err(e) => panic!("{what}: install_cli_for must return Ok, but it returned Err({e:?})"),
    }
}

// ---------------------------------------------------------------------------
// (a) is_translocated — /AppTranslocation/ のパス区切りつきの一致だけが真
// ---------------------------------------------------------------------------

#[test]
fn ac35a_a_is_translocated_detects_only_the_app_translocation_segment() {
    let translocated = format!(
        "/private/var/folders/ab/xyz/T/AppTranslocation/{TRANSLOCATION_UUID}/d/vellis.app/Contents/MacOS/vellis"
    );
    assert!(
        is_translocated(Path::new(&translocated)),
        "a binary under /AppTranslocation/ must be detected as translocated (contract 1): {translocated}"
    );

    for normal in [
        "/Applications/vellis.app/Contents/MacOS/vellis",
        "/Users/x/Downloads/vellis.app/Contents/MacOS/vellis",
        "/Volumes/Vellis/vellis.app/Contents/MacOS/vellis",
        "/Users/x/AppTranslocationNotes/vellis",
    ] {
        assert!(
            !is_translocated(Path::new(normal)),
            "a binary outside /AppTranslocation/ must not be detected as translocated (contract 1); \
             only the exact `/AppTranslocation/` segment counts: {normal}"
        );
    }
}

// ---------------------------------------------------------------------------
// (b) 一時的な場所の exe → Err(契約2 の2文)・HOME/.local は作られない
// ---------------------------------------------------------------------------

#[test]
fn ac35a_b_translocated_exe_is_refused_with_the_two_sentences_and_writes_nothing() {
    let fx = Fixture::new();
    let exe = fx.translocated_exe();

    let err = expect_err(
        install_cli_for(&exe, &fx.home, &fx.path_env_with_local_bin()),
        "translocated exe",
    );

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
        !has_cjk(&err),
        "the Err wording is English (contract 2); got: {err:?}"
    );

    assert!(
        !fx.home.join(".local").exists(),
        "a translocated exe must not create HOME/.local (contract 1: write nothing); \
         found {}",
        fx.home.join(".local").display()
    );
    assert!(
        !fx.target().exists() && !fx.target().is_symlink(),
        "a translocated exe must not create the symlink HOME/.local/bin/vellis (contract 1)"
    );
}

// ---------------------------------------------------------------------------
// (c) 一時的な場所の exe → 既存のリンクはそのまま(削除も張り替えもされない)
// ---------------------------------------------------------------------------

#[test]
fn ac35a_c_translocated_exe_leaves_an_existing_symlink_untouched() {
    let fx = Fixture::new();
    let elsewhere = fx.preinstall_symlink_elsewhere();
    let exe = fx.translocated_exe();

    let err = expect_err(
        install_cli_for(&exe, &fx.home, &fx.path_env_with_local_bin()),
        "translocated exe with an existing symlink",
    );
    assert!(
        err.starts_with(SENTENCE_1),
        "the Err must start with the first sentence of contract 2; got: {err:?}"
    );

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
        "the existing symlink must not have been re-pointed at the translocated exe"
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
// (d) 通常の場所の exe → Ok・リンク作成/張り替え・target_dir_on_path の判定
// ---------------------------------------------------------------------------

#[test]
fn ac35a_d1_normal_exe_installs_the_symlink_and_sees_local_bin_on_path() {
    let fx = Fixture::new();
    let exe = fx.normal_exe();

    let result = expect_ok(
        install_cli_for(&exe, &fx.home, &fx.path_env_with_local_bin()),
        "normal exe, fresh HOME",
    );

    assert_eq!(
        result.target_path,
        fx.target(),
        "target_path must be HOME/.local/bin/vellis (contract 3, unchanged behaviour)"
    );
    assert!(
        fx.target().is_symlink(),
        "HOME/.local/bin/vellis must be a symlink after a normal install"
    );
    assert_eq!(
        fs::read_link(&result.target_path).expect("read the created symlink"),
        exe,
        "the symlink must point at the given exe (contract 3)"
    );
    assert_eq!(
        result.source_path, exe,
        "source_path must be the given exe (contract 3)"
    );
    assert!(
        result.target_dir_on_path,
        "target_dir_on_path must be true when path_env contains HOME/.local/bin (contract 3)"
    );
}

#[test]
fn ac35a_d2_normal_exe_replaces_an_existing_symlink_and_sees_local_bin_off_path() {
    let fx = Fixture::new();
    let elsewhere = fx.preinstall_symlink_elsewhere();
    let exe = fx.normal_exe();

    let result = expect_ok(
        install_cli_for(&exe, &fx.home, PATH_ENV_WITHOUT_LOCAL_BIN),
        "normal exe, existing symlink",
    );

    assert_eq!(
        result.target_path,
        fx.target(),
        "target_path must be HOME/.local/bin/vellis (contract 3)"
    );
    let now_points_at = fs::read_link(fx.target()).expect("read the replaced symlink");
    assert_eq!(
        now_points_at, exe,
        "an existing symlink must be re-pointed at the given exe (contract 3, unchanged behaviour)"
    );
    assert_ne!(
        now_points_at, elsewhere,
        "the old symlink target must be gone after a normal install"
    );
    assert_eq!(
        result.source_path, exe,
        "source_path must be the given exe (contract 3)"
    );
    assert!(
        !result.target_dir_on_path,
        "target_dir_on_path must be false when path_env does not contain HOME/.local/bin (contract 3); \
         path_env was {PATH_ENV_WITHOUT_LOCAL_BIN:?}"
    );
}

// ---------------------------------------------------------------------------
// (e) install_cli_failure_body に (b) の Err を渡す → 従来の定型文に挟まる
// ---------------------------------------------------------------------------

#[test]
fn ac35a_e_failure_body_wraps_the_translocation_error() {
    let fx = Fixture::new();
    let exe = fx.translocated_exe();
    let err = expect_err(
        install_cli_for(&exe, &fx.home, PATH_ENV_WITHOUT_LOCAL_BIN),
        "translocated exe (for the failure body)",
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
        "the failure body wraps the Err as `Failed to install the CLI:\\n<err>` with no other route (contract 2 / 4)"
    );
    assert!(
        !has_cjk(&body),
        "the failure body is English (AC-35-7); got: {body:?}"
    );
}

// ---------------------------------------------------------------------------
// (f) ソース走査: cli_install.rs の本文に /AppTranslocation/・is_translocated・install_cli_for
// ---------------------------------------------------------------------------

/// 行ごとに `//` 以降(コメント)を落とす。`://` は落とさない(acceptance_req3d と同じ流儀)。
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

/// `cli_install.rs` の `#[cfg(test)]` より前・行コメントを除いた本文。
fn cli_install_rs_code() -> String {
    let code = strip_line_comments(include_str!("../src/cli_install.rs"));
    match code.find("#[cfg(test)]") {
        Some(i) => code[..i].to_string(),
        None => code,
    }
}

#[test]
fn ac35a_f_cli_install_rs_body_has_the_guard_and_install_cli_for() {
    let code = cli_install_rs_code();
    assert!(
        code.contains("/AppTranslocation/"),
        "cli_install.rs must test the exe path for the `/AppTranslocation/` segment in code, not \
         only in comments (contract 1)"
    );
    assert!(
        code.contains("is_translocated"),
        "cli_install.rs must define `is_translocated` (contract 1)"
    );
    assert!(
        code.contains("install_cli_for"),
        "cli_install.rs must define `install_cli_for` (contract 3)"
    );
}
