//! 要件#65 追補b の受け入れテスト(docs/requirements/req-65.md「追補b agents.toml の置き場の
//! 解決を環境変数から切り離す」・backlog 192)— AC-65-追b (a)〜(e)
//!
//! 発端: `cli_fix::tests::default_config_path_uses_xdg_config_home_when_set` がプロセス全体の
//! `XDG_CONFIG_HOME` を書き換え、同じプロセスで並列に走る隣のテストがまれに落ちた。
//! 置き場の判定を純関数 `agent_config_path` に切り出し(`settings::settings_path` と同じ形)、
//! 環境変数を書き換えるテストを無くす。
//!
//! 判定範囲:
//! - (a) `agent_config_path(Some("/xdg"), Some("/home/u"))` は `/xdg/vellis/agents.toml`
//!   (契約1 の「非 UTF-8 のパスも落とさない」は unix でだけ別ケースで見る)
//! - (b) `Some("")` / `None` と home → `/home/u/.config/vellis/agents.toml`
//! - (c) `(None, None)` / `(Some(""), None)` → `None`
//! - (d) 同じ入力で `settings::settings_path` と親フォルダが一致する(`agents.toml` と `settings.json` が同じ親)
//! - (e) ソース走査: `src-tauri/src/` の `.rs` の `#[cfg(test)]` より後ろと `src-tauri/tests/` の `.rs` に、
//!   `XDG_CONFIG_HOME` を対象にした `set_var` / `remove_var` の呼び出しが無い。`cli_fix.rs` の本文
//!   (`#[cfg(test)]` より前)の `default_config_path` が `agent_config_path` を呼ぶ。
//!   あわせて契約1 の「`agent_config_path` は環境変数を読まない」も本文の走査で見る
//!
//! 人間ゲート: なし(契約4 の不変=`run_fix`・`default_config_path` の公開シグネチャ・依存は
//! 既存テストが無改変で緑=本ファイルの外)。
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前・公開パス)
//!
//! ```ignore
//! // --- src-tauri/src/cli_fix.rs に追加(`vellis_lib::cli_fix` は既に pub mod)---
//! use std::ffi::OsStr;
//! use std::path::{Path, PathBuf};
//!
//! /// `agents.toml` の置き場を、環境変数を読まずに引数だけで決める。
//! /// `xdg_config_home` が `Some` かつ空でなければ `<xdg>/vellis/agents.toml`、
//! /// そうでなければ `home` があれば `<home>/.config/vellis/agents.toml`、どちらも無ければ `None`。
//! pub fn agent_config_path(xdg_config_home: Option<&OsStr>, home: Option<&Path>) -> Option<PathBuf>;
//!
//! /// 公開シグネチャは不変。中身は `var_os("XDG_CONFIG_HOME")` → `dirs::home_dir()` →
//! /// `agent_config_path(..)` だけ。
//! pub fn default_config_path() -> Option<PathBuf>;
//! ```

use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use vellis_lib::cli_fix::agent_config_path;
use vellis_lib::settings::settings_path;

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

fn xdg(s: &str) -> Option<&OsStr> {
    Some(OsStr::new(s))
}

fn home(s: &str) -> Option<&Path> {
    Some(Path::new(s))
}

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// `//` 行コメントと `/* */` ブロックコメントを落とす(acceptance_req70 の写し)。
fn strip_rust_comments(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut rest = src;
    loop {
        let line_at = rest.find("//");
        let block_at = rest.find("/*");
        let block_first = match (line_at, block_at) {
            (None, None) => {
                out.push_str(rest);
                return out;
            }
            (Some(l), Some(b)) => b < l,
            (None, Some(_)) => true,
            (Some(_), None) => false,
        };
        if block_first {
            let b = block_at.unwrap();
            out.push_str(&rest[..b]);
            match rest[b + 2..].find("*/") {
                Some(end) => rest = &rest[b + 2 + end + 2..],
                None => return out,
            }
        } else {
            let l = line_at.unwrap();
            out.push_str(&rest[..l]);
            match rest[l..].find('\n') {
                Some(nl) => rest = &rest[l + nl..],
                None => return out,
            }
        }
    }
}

fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for de in fs::read_dir(dir).unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display())) {
        let path = de.unwrap().path();
        if path.is_dir() {
            collect_rs_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

fn rel_to(root: &Path, file: &Path) -> String {
    file.strip_prefix(root)
        .unwrap()
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// `start` から最初の `(` に対応する閉じ括弧までの呼び出し全体(acceptance_req60 の写し)。
fn balanced_call(code: &str, start: usize) -> &str {
    let open = code[start..].find('(').expect("call must have '('") + start;
    let mut depth = 0usize;
    for (i, c) in code[open..].char_indices() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => {
                depth -= 1;
                if depth == 0 {
                    return &code[start..=open + i];
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced call starting at byte {start}");
}

/// 環境変数を書き換える呼び出しの名前。本ファイル自身も走査の対象なので、
/// 字面をそのまま書かずに結合して作る。
fn env_mutators() -> [&'static str; 2] {
    [concat!("set_", "var("), concat!("remove_", "var(")]
}

const XDG_VAR: &str = "XDG_CONFIG_HOME";

/// `code` にある `set_var` / `remove_var` の呼び出しのうち、括弧の中に
/// `XDG_CONFIG_HOME` を含むものの本文を返す。
fn xdg_mutations(code: &str) -> Vec<String> {
    let mut found = Vec::new();
    for needle in env_mutators() {
        let mut from = 0;
        while let Some(pos) = code[from..].find(needle) {
            let at = from + pos;
            let call = balanced_call(code, at);
            if call.contains(XDG_VAR) {
                found.push(call.to_string());
            }
            from = at + needle.len();
        }
    }
    found
}

/// `code` にある `set_var` / `remove_var` の出現回数(対象の環境変数を問わない)。
fn env_mutation_count(code: &str) -> usize {
    env_mutators().iter().map(|n| code.matches(n).count()).sum()
}

/// `#[cfg(test)]` より前(本文)と後ろ(テスト)に分ける。無ければ全部が本文。
fn split_at_cfg_test(code: &str) -> (&str, &str) {
    match code.find("#[cfg(test)]") {
        Some(i) => (&code[..i], &code[i..]),
        None => (code, ""),
    }
}

/// `fn <name>(` から、次の関数の頭(行頭または 4 字下げの `fn ` / `pub fn `)か
/// `#[cfg(test)]` まで(acceptance_req65 の `fn_body` の写し)。
fn fn_body(code: &str, name: &str) -> String {
    let marker = format!("fn {name}(");
    let at = code.find(&marker).unwrap_or_else(|| panic!("`{marker}` must exist"));
    let rest = &code[at + marker.len()..];
    let mut end = rest.len();
    for stop in [
        "#[tauri::command]",
        "\nasync fn ",
        "\nfn ",
        "\npub async fn ",
        "\npub fn ",
        "\n    async fn ",
        "\n    fn ",
        "\n    pub async fn ",
        "\n    pub fn ",
        "\n#[cfg(test)]",
    ] {
        if let Some(i) = rest.find(stop) {
            end = end.min(i);
        }
    }
    format!("{marker}{}", &rest[..end])
}

fn cli_fix_code() -> String {
    strip_rust_comments(include_str!("../src/cli_fix.rs"))
}

// ---------------------------------------------------------------------------
// (a) XDG_CONFIG_HOME があればその下
// ---------------------------------------------------------------------------

/// (a) `agent_config_path(Some("/xdg"), Some("/home/u"))` は `/xdg/vellis/agents.toml`。
#[test]
fn ac65b_a_xdg_config_home_wins_over_home() {
    assert_eq!(
        agent_config_path(xdg("/xdg"), home("/home/u")),
        Some(PathBuf::from("/xdg/vellis/agents.toml"))
    );
}

/// (a) home が無くても XDG だけで決まる。
#[test]
fn ac65b_a_xdg_config_home_alone_is_enough() {
    assert_eq!(
        agent_config_path(xdg("/xdg"), None),
        Some(PathBuf::from("/xdg/vellis/agents.toml"))
    );
}

/// (a・契約1) 非 UTF-8 の `XDG_CONFIG_HOME` も落とさない(`OsStr` で受ける理由)。
#[cfg(unix)]
#[test]
fn ac65b_a_non_utf8_xdg_config_home_is_kept_as_is() {
    use std::os::unix::ffi::OsStrExt;
    let raw = OsStr::from_bytes(b"/xdg-\xff-dir");
    assert!(raw.to_str().is_none(), "fixture must be non-UTF-8");
    let path = agent_config_path(Some(raw), home("/home/u")).expect("xdg given → Some");
    assert_eq!(path, Path::new(raw).join("vellis").join("agents.toml"));
}

// ---------------------------------------------------------------------------
// (b) XDG が無い/空なら home の .config
// ---------------------------------------------------------------------------

/// (b) `Some("")` は「無い」と同じ扱いで `/home/u/.config/vellis/agents.toml`。
#[test]
fn ac65b_b_empty_xdg_falls_back_to_home_dot_config() {
    assert_eq!(
        agent_config_path(xdg(""), home("/home/u")),
        Some(PathBuf::from("/home/u/.config/vellis/agents.toml"))
    );
}

/// (b) `None` でも `/home/u/.config/vellis/agents.toml`。
#[test]
fn ac65b_b_missing_xdg_falls_back_to_home_dot_config() {
    assert_eq!(
        agent_config_path(None, home("/home/u")),
        Some(PathBuf::from("/home/u/.config/vellis/agents.toml"))
    );
}

// ---------------------------------------------------------------------------
// (c) どちらも無ければ None
// ---------------------------------------------------------------------------

/// (c) `(None, None)` と `(Some(""), None)` は `None`。
#[test]
fn ac65b_c_no_xdg_and_no_home_is_none() {
    assert_eq!(agent_config_path(None, None), None);
    assert_eq!(agent_config_path(xdg(""), None), None);
}

// ---------------------------------------------------------------------------
// (d) settings_path と同じフォルダ
// ---------------------------------------------------------------------------

/// (d) 同じ入力で `settings::settings_path` と親フォルダが一致し、ファイル名だけが違う
///     (`agents.toml` と `settings.json` が同じ `vellis` フォルダに並ぶ)。
#[test]
fn ac65b_d_agents_toml_and_settings_json_share_the_same_folder() {
    let cases: [(Option<&str>, Option<&str>); 6] = [
        (Some("/xdg"), Some("/home/u")),
        (Some("/xdg"), None),
        (Some(""), Some("/home/u")),
        (None, Some("/home/u")),
        (Some(""), None),
        (None, None),
    ];
    let mut some_count = 0;
    for (x, h) in cases {
        let agents = agent_config_path(x.map(OsStr::new), h.map(Path::new));
        let settings = settings_path(x, h.map(Path::new));
        assert_eq!(
            agents.is_some(),
            settings.is_some(),
            "({x:?}, {h:?}): both resolve or neither does"
        );
        if let (Some(a), Some(s)) = (agents, settings) {
            some_count += 1;
            assert_eq!(a.parent(), s.parent(), "({x:?}, {h:?}): same folder");
            assert_eq!(a.file_name().and_then(|n| n.to_str()), Some("agents.toml"));
            assert_eq!(s.file_name().and_then(|n| n.to_str()), Some("settings.json"));
            assert_ne!(a, s);
        }
    }
    assert_eq!(some_count, 4, "4 of the 6 inputs resolve to a path");
}

// ---------------------------------------------------------------------------
// (e) ソース走査
// ---------------------------------------------------------------------------

/// (e) `src-tauri/src/` の `.rs` の `#[cfg(test)]` より後ろに、`XDG_CONFIG_HOME` を対象にした
///     `set_var` / `remove_var` の呼び出しが無い。`cli_fix.rs` のテストには対象を問わず無い(契約3)。
#[test]
fn ac65b_e_no_unit_test_mutates_xdg_config_home() {
    let src_root = manifest_dir().join("src");
    let mut files = Vec::new();
    collect_rs_files(&src_root, &mut files);
    assert!(!files.is_empty(), "src-tauri/src must contain .rs files");

    let mut offenders = BTreeSet::new();
    let mut saw_cli_fix = false;
    for file in &files {
        let rel = rel_to(&src_root, file);
        let code = strip_rust_comments(&fs::read_to_string(file).unwrap());
        let (_, tests) = split_at_cfg_test(&code);
        for call in xdg_mutations(tests) {
            offenders.insert(format!("{rel}: {call}"));
        }
        if rel == "cli_fix.rs" {
            saw_cli_fix = true;
            assert!(
                tests.contains("mod tests"),
                "cli_fix.rs keeps its unit tests (sanity check of the split)"
            );
            assert_eq!(
                env_mutation_count(tests),
                0,
                "cli_fix.rs tests must not mutate the process environment at all (契約3)"
            );
        }
    }
    assert!(saw_cli_fix, "cli_fix.rs must be scanned");
    assert_eq!(
        offenders,
        BTreeSet::new(),
        "no unit test may call set_var/remove_var on XDG_CONFIG_HOME"
    );
}

/// (e) `src-tauri/tests/` の `.rs`(本ファイルを含む)にも、`XDG_CONFIG_HOME` を対象にした
///     `set_var` / `remove_var` の呼び出しが無い。
#[test]
fn ac65b_e_no_integration_test_mutates_xdg_config_home() {
    let tests_root = manifest_dir().join("tests");
    let mut files = Vec::new();
    collect_rs_files(&tests_root, &mut files);
    assert!(
        files.iter().any(|f| f.ends_with("acceptance_req65b.rs")),
        "the scan must cover this very file"
    );

    let mut offenders = BTreeSet::new();
    for file in &files {
        let rel = rel_to(&tests_root, file);
        let code = strip_rust_comments(&fs::read_to_string(file).unwrap());
        for call in xdg_mutations(&code) {
            offenders.insert(format!("{rel}: {call}"));
        }
    }
    assert_eq!(
        offenders,
        BTreeSet::new(),
        "no integration test may call set_var/remove_var on XDG_CONFIG_HOME"
    );
}

/// (e) `cli_fix.rs` の本文(`#[cfg(test)]` より前)で `pub fn agent_config_path(` が定義され、
///     `default_config_path` がそれを呼ぶ。`default_config_path` は `XDG_CONFIG_HOME` を
///     `var_os` で読む(契約2)。
#[test]
fn ac65b_e_default_config_path_delegates_to_agent_config_path() {
    let code = cli_fix_code();
    let (body, tests) = split_at_cfg_test(&code);
    assert!(!tests.is_empty(), "cli_fix.rs has a #[cfg(test)] section");

    assert!(
        body.contains("pub fn agent_config_path("),
        "cli_fix.rs must define `pub fn agent_config_path(` in its body"
    );
    let default_fn = fn_body(body, "default_config_path");
    assert!(
        default_fn.contains("agent_config_path("),
        "default_config_path must call agent_config_path (契約2):\n{default_fn}"
    );
    assert!(
        default_fn.contains("var_os(") && default_fn.contains(XDG_VAR),
        "default_config_path reads XDG_CONFIG_HOME via var_os (契約2):\n{default_fn}"
    );
}

/// (e・契約1) `agent_config_path` の本文は環境変数を読まない(`std::env` / `var_os(` / `var(` /
///     `home_dir(` のいずれも現れない)。
#[test]
fn ac65b_e_agent_config_path_reads_no_environment() {
    let code = cli_fix_code();
    let (body, _) = split_at_cfg_test(&code);
    let agent_fn = fn_body(body, "agent_config_path");
    for forbidden in ["std::env", "env::", "var_os(", "var(", "home_dir(", "dirs::"] {
        assert!(
            !agent_fn.contains(forbidden),
            "agent_config_path must not touch `{forbidden}` (契約1):\n{agent_fn}"
        );
    }
}

// ---------------------------------------------------------------------------
// 走査の自己検証
// ---------------------------------------------------------------------------

/// 走査の自己検証: `XDG_CONFIG_HOME` を対象にした呼び出しだけを拾い、別の変数や
/// コメントの中の字面は拾わない。
#[test]
fn ac65b_scan_self_check_finds_only_xdg_targeted_calls() {
    let [set, remove] = env_mutators();
    let sample = format!(
        "fn t() {{\n    unsafe {{ std::env::{set}\"{XDG_VAR}\", dir.path()); }}\n    \
         unsafe {{ std::env::{remove}\"{XDG_VAR}\"); }}\n    \
         unsafe {{ std::env::{set}\"HOME\", \"/h\"); }}\n    \
         // std::env::{remove}\"{XDG_VAR}\");\n}}\n"
    );
    let code = strip_rust_comments(&sample);
    let hits = xdg_mutations(&code);
    assert_eq!(hits.len(), 2, "{hits:?}");
    assert!(hits[0].starts_with(set));
    assert!(hits[1].starts_with(remove));
    assert_eq!(env_mutation_count(&code), 3);
    assert!(xdg_mutations("fn t() {}").is_empty());
}
