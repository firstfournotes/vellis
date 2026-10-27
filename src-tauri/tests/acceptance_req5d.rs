//! 要件#5 追補d の受け入れテスト(docs/requirements/req-05.md「追補d」= Issue #420 / backlog 50)
//! — Rust 層(AC-5-追d (a)(b))
//!
//! 発端: `vellis <無いパス>` で起動すると、`main.rs` の `resolve_path_to_uri` が canonicalize の失敗を
//! 黙って飲み、`uri_looks_like_dir` は `is_dir` が偽なので「ファイル」扱いになる。結果、親フォルダ
//! (相対パスなら cwd)が root として開き、何も知らせない。
//! 由谷の決定(2026-10-20): 「エラーを出して終える」。履歴の画面を開く案は採らない。
//!
//! 契約(追補d):
//! 1. `vellis <パス>` の引数が `://` を含まない(ローカルのパス)とき、cwd を基準に絶対パスにした先が
//!    無ければ(`try_exists` が `Ok(false)`=リンク切れのシンボリックリンクも含む)、標準エラーに
//!    `vellis: no such file or directory: <打ったパス>` を 1 行出して **終了コード 2** で終える。
//!    IPC にも送らず、本体も起動せず、履歴にも残さない。`-n` / `-r` / `--marks` / `--changed` と
//!    組み合わせても同じ
//! 2. 確かめるのは IPC の probe と本体の起動より前。有無を確かめられない(`try_exists` が `Err`=
//!    権限など)ときは今までどおり進む(開く側でエラーを出す)
//! 3. `://` を含む引数(`file://` / `ssh://`)は確かめない。パス無しの起動と `--self-check` /
//!    `--print-build-info` / `--fix` / `--install-cli` も今のまま
//! 4. 判定は lib の関数にする(`main.rs` は bin なので tests から呼べない)。`main.rs` はこれを呼んで終える
//! 5. 不変: 存在するパスの解決(`resolve_path_to_uri`・canonicalize)・`WindowArgs::for_open_target`・
//!    終了コード 0 / 1 / 3 / 4 / 5 / 6 の意味。依存の追加なし
//!
//! 判定範囲(AC-5-追d):
//! - (a) 判定の関数: 無い絶対パス → 返す・無い相対パス → cwd を基準にした絶対パスを返す・ある
//!   ファイルとフォルダ → 返さない・リンク切れのシンボリックリンク → 返す・`ssh://h/x` と
//!   `file:///nonexistent` → 返さない。契約2 の「確かめられない(`Err`)→ 返さない」も 1 件見る
//! - (b) ソース走査: `main.rs` の `fn main` の本文で (a) の関数の呼び出しが `build_request(&cli)`・
//!   `IpcClient::probe(`・`launch(` より前にあり、返ったら `no such file or directory` を `eprintln!` で
//!   出して `process::exit(2)` で終える
//! - (c) 既存のテスト(`main.rs` の `build_request` のテストを含む)は無改変で緑 → test-runner
//!
//! **バイナリは起動しない**(判定が壊れていると本物の Vellis に IPC を送ったり GUI を立ち上げたりする)。
//! 終了コード 2 と標準エラーの 1 行は (b) のソース走査と人間ゲート(`vellis 無いファイル.md` →
//! `echo $?` が 2)で見る。
//!
//! ## 確定契約(公開 API・implementer はこれに従う)
//!
//! ```ignore
//! // src-tauri/src/cli.rs(既存の `vellis_lib::cli` に足す)
//!
//! /// `vellis <path>` のローカルのパスが無いか(要件#5 追補d 契約1・2・4)。
//! /// - `path` が `://` を含む(`file://` / `ssh://` …)→ `None`(確かめない=契約3)
//! /// - `path` が絶対ならそのまま、相対なら `cwd.join(path)` を「絶対パス」とし、その
//! ///   `try_exists()` が `Ok(false)` なら `Some(<その絶対パス>)`(リンク切れのシンボリックリンクを含む:
//! ///   `try_exists` はリンクをたどる)
//! /// - `Ok(true)`(ファイル・フォルダ・先のあるリンク)→ `None`
//! /// - `Err(_)`(権限などで確かめられない)→ `None`(今までどおり進む=契約2。`Path::exists()` は
//! ///   `Err` を偽に潰すので使わない)
//! /// canonicalize はしない(無いパスは canonicalize できない)。返す値は判定に使った絶対パスそのもの
//! /// (絶対の入力なら `PathBuf::from(path)`、相対の入力なら `cwd.join(path)` に等しい)。
//! pub fn missing_local_path(path: &str, cwd: &std::path::Path) -> Option<std::path::PathBuf>;
//!
//! // src-tauri/src/main.rs の `fn main` の本体(ソース走査 (b) が見るもの)
//! // - `missing_local_path(` の呼び出しが、`build_request(&cli)`・`IpcClient::probe(`・`launch(` の
//! //   どれよりも前にある(`fn main` の本体に直接書く。別関数に出さない)。`--self-check` /
//! //   `--print-build-info` / `--fix` / `--install-cli` の分岐より後でよい(契約3)
//! // - `Some(_)` が返ったら `eprintln!("vellis: no such file or directory: {}", <打ったパス>)` を出し、
//! //   `std::process::exit(2)` で終える。この `eprintln!` と `process::exit(2)` は呼び出しと
//! //   `build_request(&cli)` の間にある
//! // - cwd は `std::env::current_dir()`(取れなければ従来どおり進む=reviewer 照合)
//! ```
//!
//! ソース走査の流儀は `acceptance_req12b.rs` / `acceptance_req72.rs` と同じ(行コメントを落としてから
//! `fn_body` で `fn main` の本体を切り出す)。
//!
//! ## 赤の源(修正前の見込み)
//! - (a) は `vellis_lib::cli::missing_local_path` が無いのでコンパイルが落ちる(赤)。スタブを置いても
//!   a1・a2・a5 は値で赤
//! - (b) は `fn main` に `missing_local_path(` も `no such file or directory` も `exit(2)` も無いので赤
//!
//! ## reviewer 照合に委ねるもの(機械判定しにくい配線)
//! - `eprintln!` に差し込むのが「打ったパス」(`cli.path` の文字列そのもの)であること
//! - `cwd` に `std::env::current_dir()` を渡すこと・取れないときに従来どおり進むこと
//! - `-n` / `-r` / `--marks` / `--changed` の組み合わせでも同じ(呼び出しがフラグで分岐しない)

use std::path::Path;

use tempfile::TempDir;

use vellis_lib::cli::missing_local_path;

const MAIN_RS: &str = include_str!("../src/main.rs");

// ---------------------------------------------------------------------------
// (a) 判定の関数
// ---------------------------------------------------------------------------

fn s(path: &Path) -> &str {
    path.to_str().expect("test paths are UTF-8")
}

/// a1. 無い絶対パス → そのパスを返す(cwd は関与しない)。
#[test]
fn ac5d_a_missing_absolute_path_is_returned() {
    let tmp = TempDir::new().unwrap();
    let other_cwd = TempDir::new().unwrap();

    let missing = tmp.path().join("missing.md");
    assert!(!missing.exists(), "precondition");
    assert_eq!(
        missing_local_path(s(&missing), other_cwd.path()),
        Some(missing.clone()),
        "a1: a missing absolute file is returned as given (cwd must not matter)"
    );

    let deep = tmp.path().join("no").join("such").join("folder");
    assert_eq!(
        missing_local_path(s(&deep), other_cwd.path()),
        Some(deep.clone()),
        "a1: a missing absolute folder path (parents missing too) is returned as given"
    );
}

/// a2. 無い相対パス → cwd を基準にした絶対パス(`cwd.join(path)`)を返す。
#[test]
fn ac5d_a_missing_relative_path_is_returned_joined_to_cwd() {
    let tmp = TempDir::new().unwrap();
    let cwd = tmp.path();
    std::fs::create_dir(cwd.join("sub")).unwrap();

    let got = missing_local_path("missing.md", cwd);
    assert_eq!(
        got,
        Some(cwd.join("missing.md")),
        "a2: a missing relative name resolves against cwd"
    );
    assert!(
        got.as_deref().is_some_and(Path::is_absolute),
        "a2: the returned path is absolute"
    );

    assert_eq!(
        missing_local_path("sub/missing.md", cwd),
        Some(cwd.join("sub").join("missing.md")),
        "a2: a missing file under an existing sub folder resolves against cwd"
    );
    assert_eq!(
        missing_local_path("nope/missing.md", cwd),
        Some(cwd.join("nope").join("missing.md")),
        "a2: a missing file under a missing sub folder resolves against cwd"
    );
}

/// a3. あるファイル → 返さない(絶対でも相対でも)。
#[test]
fn ac5d_a_existing_file_is_not_missing() {
    let tmp = TempDir::new().unwrap();
    let cwd = tmp.path();
    let file = cwd.join("here.md");
    std::fs::write(&file, "# here").unwrap();

    assert_eq!(missing_local_path(s(&file), cwd), None, "a3: existing absolute file");
    assert_eq!(missing_local_path("here.md", cwd), None, "a3: existing relative file");
}

/// a4. あるフォルダ → 返さない(絶対・相対・`.`・cwd そのもの)。
#[test]
fn ac5d_a_existing_folder_is_not_missing() {
    let tmp = TempDir::new().unwrap();
    let cwd = tmp.path();
    let dir = cwd.join("docs");
    std::fs::create_dir(&dir).unwrap();

    assert_eq!(missing_local_path(s(&dir), cwd), None, "a4: existing absolute folder");
    assert_eq!(missing_local_path("docs", cwd), None, "a4: existing relative folder");
    assert_eq!(missing_local_path(".", cwd), None, "a4: `.` is the (existing) cwd");
    assert_eq!(missing_local_path(s(cwd), cwd), None, "a4: cwd itself exists");
}

/// a5. リンク切れのシンボリックリンク → 返す(`try_exists` はリンクをたどる)。先のあるリンクは返さない。
#[cfg(unix)]
#[test]
fn ac5d_a_dangling_symlink_is_missing() {
    use std::os::unix::fs::symlink;

    let tmp = TempDir::new().unwrap();
    let cwd = tmp.path();

    let dangling = cwd.join("dangling.md");
    symlink(cwd.join("gone-target.md"), &dangling).unwrap();
    assert!(
        dangling.symlink_metadata().is_ok() && !dangling.exists(),
        "precondition: the link exists but its target does not"
    );
    assert_eq!(
        missing_local_path(s(&dangling), cwd),
        Some(dangling.clone()),
        "a5: a dangling symlink (absolute) is reported missing, as the link's own path"
    );
    assert_eq!(
        missing_local_path("dangling.md", cwd),
        Some(cwd.join("dangling.md")),
        "a5: a dangling symlink (relative) is reported missing, joined to cwd"
    );

    let target = cwd.join("real.md");
    std::fs::write(&target, "# real").unwrap();
    let alive = cwd.join("alive.md");
    symlink(&target, &alive).unwrap();
    assert_eq!(
        missing_local_path(s(&alive), cwd),
        None,
        "a5: a symlink whose target exists is not missing"
    );
}

/// a6. `://` を含む引数は確かめない → 返さない(`ssh://h/x`・`file:///nonexistent`・`file://` + 無いパス)。
#[test]
fn ac5d_a_uris_are_not_checked() {
    let tmp = TempDir::new().unwrap();
    let cwd = tmp.path();

    assert_eq!(missing_local_path("ssh://h/x", cwd), None, "a6: ssh:// is never checked");
    assert_eq!(
        missing_local_path("file:///nonexistent", cwd),
        None,
        "a6: file:// is never checked (契約3), even when the path does not exist"
    );
    let missing_file_uri = format!("file://{}", cwd.join("missing.md").display());
    assert_eq!(
        missing_local_path(&missing_file_uri, cwd),
        None,
        "a6: a file:// URI of a missing file is never checked"
    );
}

/// a7(契約2). 有無を確かめられない(`try_exists` が `Err`=親フォルダに入る権限が無い)→ 返さない
/// (今までどおり進み、開く側でエラーを出す)。root では権限で `Err` にならないので、その場合は判定を飛ばす。
#[cfg(unix)]
#[test]
fn ac5d_a_unverifiable_path_is_not_missing() {
    use std::os::unix::fs::PermissionsExt;

    let tmp = TempDir::new().unwrap();
    let cwd = tmp.path();
    let locked = cwd.join("locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

    let probe_abs = locked.join("child.md");
    let verdict = missing_local_path("locked/child.md", cwd);
    let verdict_abs = missing_local_path(s(&probe_abs), cwd);
    let unverifiable = probe_abs.try_exists().is_err();

    // TempDir の掃除が通るように先に権限を戻す。
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();

    if !unverifiable {
        eprintln!(
            "a7: skipped — {} could be checked (running as root?); the Err branch cannot be exercised here",
            probe_abs.display()
        );
        return;
    }
    assert_eq!(
        verdict, None,
        "a7: when try_exists() is Err the CLI must proceed as before (not refuse), relative input"
    );
    assert_eq!(
        verdict_abs, None,
        "a7: when try_exists() is Err the CLI must proceed as before (not refuse), absolute input"
    );
}

// ---------------------------------------------------------------------------
// (b) ソース走査: main.rs の fn main の本体
// ---------------------------------------------------------------------------

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

/// `start` から、最初の `(` に対応する閉じ括弧までの呼び出し全体。
fn balanced_call(code: &str, start: usize) -> &str {
    let open = code[start..].find('(').expect("call must have '('") + start;
    let close = matching_close(code, open);
    &code[start..=close]
}

/// 空白をすべて落とす(改行の入れ方に依らず照合するため)。
fn no_ws(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

fn main_body() -> String {
    let code = strip_line_comments(MAIN_RS);
    fn_body(&code, "main").to_string()
}

const CALL: &str = "missing_local_path(";

/// b1. `fn main` の本体で `missing_local_path(` の呼び出しが `build_request(&cli)`・`IpcClient::probe(`・
/// `launch(` のどれよりも前にある(契約2: IPC にも送らず、本体も起動しない)。
#[test]
fn ac5d_b_main_checks_the_path_before_request_probe_and_launch() {
    let body = main_body();
    let call = body
        .find(CALL)
        .expect("fn main calls `missing_local_path(` (vellis_lib::cli) in its own body");
    let request = body
        .find("build_request(&cli)")
        .expect("fn main calls build_request(&cli)");
    let probe = body
        .find("IpcClient::probe(")
        .expect("fn main probes the running instance with IpcClient::probe(");
    let launch = body.find("launch(").expect("fn main calls launch(");

    assert!(
        call < request,
        "the missing-path check comes before build_request(&cli) (call at {call}, build_request at {request})"
    );
    assert!(
        call < probe,
        "the missing-path check comes before IpcClient::probe( (call at {call}, probe at {probe})"
    );
    assert!(
        call < launch,
        "the missing-path check comes before launch( (call at {call}, launch at {launch})"
    );
}

/// b2. 返ったら(`Some`)`vellis: no such file or directory: <打ったパス>` を `eprintln!` で出し、
/// `process::exit(2)` で終える。どちらも呼び出しと `build_request(&cli)` の間にある。
#[test]
fn ac5d_b_main_prints_no_such_file_and_exits_with_2() {
    let body = main_body();
    let call = body
        .find(CALL)
        .expect("fn main calls `missing_local_path(` (vellis_lib::cli) in its own body");
    let request = body
        .find("build_request(&cli)")
        .expect("fn main calls build_request(&cli)");
    assert!(call < request, "precondition (b1): the check precedes build_request(&cli)");
    let window = &body[call..request];

    let message_calls: Vec<&str> = window
        .match_indices("eprintln!")
        .map(|(at, _)| balanced_call(window, at))
        .filter(|call| call.contains("no such file or directory"))
        .collect();
    assert!(
        !message_calls.is_empty(),
        "between the check and build_request(&cli) an eprintln! prints `no such file or directory`"
    );
    assert!(
        message_calls
            .iter()
            .any(|call| call.contains("vellis: no such file or directory: ")),
        "the line reads `vellis: no such file or directory: <typed path>` (契約1), got {message_calls:?}"
    );

    assert!(
        no_ws(window).contains("process::exit(2)"),
        "between the check and build_request(&cli) the process ends with process::exit(2)"
    );
}
