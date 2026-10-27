//! 要件#64 追補e の受け入れテスト(docs/requirements/req-64.md 追補e・Issue #587)— Rust 層
//!
//! 「ssh の root で、一時的な汎用の失敗でも Recent Files から消えうる」穴を塞ぐ(契約8 の
//! 「一時的な失敗で履歴を失わない」): ssh のときは stat の NotFound だけで除かず、親フォルダの一覧で
//! 確かめる。
//! - **AC-64-追e(a)** 判定(純関数): ssh で stat が NotFound・親の一覧が取れて名前が無い → 除く。
//!   stat が NotFound・親の一覧が取れて名前がある → 除かない。stat が NotFound・親の一覧が失敗 →
//!   除かない。stat が NotFound 以外 → 除かない(今のまま)。ローカルで stat が NotFound → 除く
//!   (今のまま)。境界: ssh で一覧を取っていない(None)なら除かない・名前はフォルダ/リンクの行でも
//!   「ある」・照合は名前(uri の綴りではない)・stat が Ok なら除かない・ローカルは一覧を見ない
//!   (渡されても判定を変えない)・一覧が要るのは ssh で stat が NotFound のときだけ(`needs_parent_listing`)
//! - **AC-64-追e(b)** 配線(ソース走査): `commands/document.rs` の `open_in_window` の失敗側が
//!   stat → `needs_parent_listing` → 親(`.parent()`)の `list` → `should_forget_on_open_error_with_listing`
//!   → `forget_file` の順で (a) の判定を通る
//! - 不変(契約3): `fs/ssh.rs` の `sftp_to_fs` は `Failure` も `NoSuchFile` も `NotFound` に写したまま
//!   (ソース走査)。`should_forget_on_open_error(&FsError) -> bool` は無改変(AC-64-8 が固定済み=
//!   フルスイートで判定。本ファイルはローカルの判定がそれと一致することを見る)
//!
//! ## 判定しないもの
//! - 実際の sftp サーバーに対する振る舞い(macOS sftp-server の `Failure`)→ 人間ゲート 14 の範囲
//! - 除いたときのイベント・alert の文言(契約3 の不変)→ フロントの既存テストとフルスイート
//! - `forget_file` / `record_file` の best-effort(要件#64 本体の reviewer 照合)
//!
//! ## 実装前の見立て
//! - ファイル全体が新しい公開 API(`needs_parent_listing`・`should_forget_on_open_error_with_listing`)を
//!   参照するため、実装前はコンパイルで赤。配線の走査も現状は `open_in_window` に `.list(` が無いので赤
//! - 最初から緑のはずのもの(不変の守り): `sftp_to_fs` の写し方の走査(契約3)
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前・公開パス)
//!
//! ```ignore
//! // --- src-tauri/src/recent_files.rs(追加。既存の `should_forget_on_open_error` は無改変)---
//! use crate::fs::{entry::Entry, uri::Uri};
//!
//! /// 追補e(契約1・2): 親フォルダの一覧で確かめる必要があるか。
//! /// true = `uri.scheme == "ssh"` かつ `stat` が `Err(FsError::NotFound(_))`。ローカルは常に false。
//! pub fn needs_parent_listing(uri: &Uri, stat: &Result<Entry, FsError>) -> bool;
//!
//! /// 追補e の判定。`stat` = 開くのに失敗したあとの `provider.stat(uri)` の結果、
//! /// `parent_listing` = 親フォルダの `provider.list(parent)` の結果(取っていなければ None)。
//! /// - `stat` が Ok → false
//! /// - ローカル(scheme != "ssh") → `should_forget_on_open_error(err)`(NotFound だけ true)。`parent_listing` は見ない
//! /// - ssh → `stat` が NotFound かつ `parent_listing` が `Some(Ok(entries))` かつ entries のどの `name` も
//! ///   `uri.path.file_name()` と一致しないときだけ true(None / `Some(Err(_))` / 名前がある → false)
//! pub fn should_forget_on_open_error_with_listing(
//!     uri: &Uri,
//!     stat: &Result<Entry, FsError>,
//!     parent_listing: Option<&Result<Vec<Entry>, FsError>>,
//! ) -> bool;
//!
//! // --- src-tauri/src/commands/document.rs の open_in_window(失敗側)の形 ---
//! //   let stat = provider.stat(&parsed_uri).await;
//! //   let parent_listing = if recent_files::needs_parent_listing(&parsed_uri, &stat) {
//! //       match parsed_uri.parent() { Some(parent) => Some(provider.list(&parent).await), None => None }
//! //   } else { None };
//! //   if recent_files::should_forget_on_open_error_with_listing(&parsed_uri, &stat, parent_listing.as_ref()) {
//! //       recent_files::forget_file(&app_handle, &uri);
//! //   } else { tracing::debug!(...) }
//! ```

use std::io;

use vellis_lib::errors::FsError;
use vellis_lib::fs::entry::{Entry, FileKind};
use vellis_lib::fs::uri::Uri;
use vellis_lib::recent_files::{
    needs_parent_listing, should_forget_on_open_error, should_forget_on_open_error_with_listing,
};

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

const SSH_ROOT: &str = "ssh://alice@host/repo";
const LOCAL_ROOT: &str = "file:///proj";

fn ssh_uri(name: &str) -> Uri {
    Uri::parse(&format!("{SSH_ROOT}/docs/{name}")).unwrap()
}

fn local_uri(name: &str) -> Uri {
    Uri::parse(&format!("{LOCAL_ROOT}/docs/{name}")).unwrap()
}

fn parent_of(uri: &Uri) -> Uri {
    uri.parent().expect("the file uri has a parent folder")
}

fn name_of(uri: &Uri) -> &str {
    uri.path
        .file_name()
        .and_then(|n| n.to_str())
        .expect("the file uri has a name")
}

/// 一覧の 1 行(`FileProvider::list` が返す形)。uri は親の綴りに名前を足したもの。
fn entry(parent: &Uri, name: &str, kind: FileKind) -> Entry {
    Entry {
        uri: parent.with_path(parent.path.join(name)).raw,
        name: name.to_string(),
        kind,
        size: None,
        modified: None,
        link: None,
    }
}

/// 親フォルダの一覧が取れた(`Ok`)形。
fn listing_of(parent: &Uri, names: &[&str]) -> Result<Vec<Entry>, FsError> {
    Ok(names
        .iter()
        .map(|n| entry(parent, n, FileKind::File))
        .collect())
}

fn stat_not_found(uri: &Uri) -> Result<Entry, FsError> {
    Err(FsError::NotFound(uri.raw.clone()))
}

fn stat_ok(uri: &Uri) -> Result<Entry, FsError> {
    Ok(entry(&parent_of(uri), name_of(uri), FileKind::File))
}

/// NotFound 以外の stat の失敗(AC-64-8 の一覧と同じ網+ssh の汎用の失敗の `Io` 写し)。
fn other_stat_errors() -> Vec<FsError> {
    vec![
        FsError::PermissionDenied("secret.md".into()),
        FsError::FileTooLarge("huge.bin".into()),
        FsError::InvalidUtf8,
        FsError::UnsupportedScheme("ftp".into()),
        FsError::Unsupported("write on ssh".into()),
        FsError::Io(io::Error::new(io::ErrorKind::PermissionDenied, "denied")),
        FsError::Io(io::Error::new(io::ErrorKind::TimedOut, "ssh timed out")),
        FsError::Io(io::Error::new(
            io::ErrorKind::NotConnected,
            "ssh disconnected",
        )),
        FsError::Io(io::Error::other("Failure: Failure")),
    ]
}

/// 親フォルダの一覧の失敗(切断・権限・`Failure` の NotFound 写し・その他)。
fn listing_failures() -> Vec<FsError> {
    vec![
        FsError::Io(io::Error::new(
            io::ErrorKind::NotConnected,
            "ssh disconnected",
        )),
        FsError::Io(io::Error::new(io::ErrorKind::TimedOut, "ssh timed out")),
        FsError::PermissionDenied("docs".into()),
        FsError::NotFound("Failure".into()),
        FsError::Io(io::Error::other("Failure: Failure")),
    ]
}

// ---------------------------------------------------------------------------
// AC-64-追e(a) — ssh の判定
// ---------------------------------------------------------------------------

/// 1. ssh: stat が NotFound・親の一覧が取れて名前が無い → 除く(空の一覧でも)。
#[test]
fn ssh_not_found_and_parent_listing_without_the_name_forgets() {
    let uri = ssh_uri("gone.md");
    let parent = parent_of(&uri);
    let stat = stat_not_found(&uri);

    let listing = listing_of(&parent, &["a.md", "b.md", "sub"]);
    assert!(
        should_forget_on_open_error_with_listing(&uri, &stat, Some(&listing)),
        "ssh + NotFound + the parent listing lacks the name → forget (追補e 契約1)"
    );

    let empty = listing_of(&parent, &[]);
    assert!(
        should_forget_on_open_error_with_listing(&uri, &stat, Some(&empty)),
        "an empty parent listing also confirms the file is gone"
    );
}

/// 2. ssh: stat が NotFound でも親の一覧に名前がある → 除かない(ファイル・フォルダ・リンクの行のどれでも)。
#[test]
fn ssh_not_found_but_the_name_is_in_the_parent_listing_keeps() {
    let uri = ssh_uri("gone.md");
    let parent = parent_of(&uri);
    let stat = stat_not_found(&uri);

    let listing = listing_of(&parent, &["a.md", "gone.md", "b.md"]);
    assert!(
        !should_forget_on_open_error_with_listing(&uri, &stat, Some(&listing)),
        "the name is still in the parent folder: the NotFound was a passing failure → keep"
    );

    for kind in [FileKind::Dir, FileKind::Symlink] {
        let listing: Result<Vec<Entry>, FsError> = Ok(vec![
            entry(&parent, "a.md", FileKind::File),
            entry(&parent, "gone.md", kind),
        ]);
        assert!(
            !should_forget_on_open_error_with_listing(&uri, &stat, Some(&listing)),
            "a row of kind {kind:?} with the same name counts as present → keep"
        );
    }
}

/// 3. ssh: stat が NotFound・親の一覧が失敗(切断・権限・`Failure` 写し など) → 除かない。
#[test]
fn ssh_not_found_but_parent_listing_failed_keeps() {
    let uri = ssh_uri("gone.md");
    let stat = stat_not_found(&uri);

    for failure in listing_failures() {
        let msg = failure.to_string();
        let listing: Result<Vec<Entry>, FsError> = Err(failure);
        assert!(
            !should_forget_on_open_error_with_listing(&uri, &stat, Some(&listing)),
            "a parent listing that failed ({msg}) cannot confirm anything → keep"
        );
    }
}

/// 4. ssh: stat が NotFound でも、親の一覧を取っていない(None)なら除かない(確かめずに除かない)。
#[test]
fn ssh_not_found_without_a_parent_listing_keeps() {
    let uri = ssh_uri("gone.md");
    let stat = stat_not_found(&uri);
    assert!(
        !should_forget_on_open_error_with_listing(&uri, &stat, None),
        "over ssh a NotFound alone must never drop the entry (追補e 契約1)"
    );
}

/// 5. ssh: stat が NotFound 以外 → 除かない(今のまま)。一覧が「名前が無い」と言っていても。
#[test]
fn ssh_stat_other_than_not_found_keeps_whatever_the_listing_says() {
    let uri = ssh_uri("gone.md");
    let parent = parent_of(&uri);
    let without_name = listing_of(&parent, &["a.md"]);

    for err in other_stat_errors() {
        let msg = err.to_string();
        let stat: Result<Entry, FsError> = Err(err);
        assert!(
            !should_forget_on_open_error_with_listing(&uri, &stat, Some(&without_name)),
            "ssh stat failed with {msg} (not NotFound) → keep, even with a listing lacking the name"
        );
        assert!(
            !should_forget_on_open_error_with_listing(&uri, &stat, None),
            "ssh stat failed with {msg} (not NotFound) → keep"
        );
    }
}

/// 6. ssh: stat が Ok(ファイルはある) → 除かない。
#[test]
fn ssh_stat_ok_keeps() {
    let uri = ssh_uri("there.md");
    let parent = parent_of(&uri);
    let stat = stat_ok(&uri);
    assert!(!should_forget_on_open_error_with_listing(&uri, &stat, None));
    let without_name = listing_of(&parent, &["a.md"]);
    assert!(
        !should_forget_on_open_error_with_listing(&uri, &stat, Some(&without_name)),
        "a successful stat says the file is there → keep, whatever the listing"
    );
}

/// 7. 照合は名前(`Entry.name`)で、uri の綴りではない: 名前が一致すれば uri の綴りが違っても「ある」、
///    uri が同じ綴りでも名前が違えば「無い」。
#[test]
fn ssh_matches_by_name_not_by_uri_spelling() {
    let uri = ssh_uri("gone.md");
    let stat = stat_not_found(&uri);

    let name_matches_uri_differs: Result<Vec<Entry>, FsError> = Ok(vec![Entry {
        uri: "ssh://alice@host/repo/docs/./gone.md".into(),
        name: "gone.md".into(),
        kind: FileKind::File,
        size: Some(1),
        modified: Some(1),
        link: None,
    }]);
    assert!(
        !should_forget_on_open_error_with_listing(&uri, &stat, Some(&name_matches_uri_differs)),
        "the name is in the listing (uri spelled differently) → keep"
    );

    let uri_matches_name_differs: Result<Vec<Entry>, FsError> = Ok(vec![Entry {
        uri: uri.raw.clone(),
        name: "other.md".into(),
        kind: FileKind::File,
        size: None,
        modified: None,
        link: None,
    }]);
    assert!(
        should_forget_on_open_error_with_listing(&uri, &stat, Some(&uri_matches_name_differs)),
        "no row carries the name (only a uri string happens to match) → forget"
    );
}

/// 8. ssh の名前にスペースや非 ASCII があっても、一覧の名前と素の文字列で照合する。
#[test]
fn ssh_name_comparison_is_the_plain_string() {
    for name in ["space name.md", "日本語.md"] {
        let uri = ssh_uri(name);
        let parent = parent_of(&uri);
        let stat = stat_not_found(&uri);
        let present = listing_of(&parent, &[name, "a.md"]);
        assert!(
            !should_forget_on_open_error_with_listing(&uri, &stat, Some(&present)),
            "{name}: present in the listing → keep"
        );
        let absent = listing_of(&parent, &["a.md"]);
        assert!(
            should_forget_on_open_error_with_listing(&uri, &stat, Some(&absent)),
            "{name}: absent from the listing → forget"
        );
    }
}

// ---------------------------------------------------------------------------
// AC-64-追e(a) — ローカルは今のまま(契約2)
// ---------------------------------------------------------------------------

/// 9. ローカル: stat が NotFound → 除く。一覧は見ない(None でも、名前のある Ok でも、Err でも除く)。
#[test]
fn local_not_found_forgets_without_consulting_a_listing() {
    let uri = local_uri("gone.md");
    let parent = parent_of(&uri);
    let stat = stat_not_found(&uri);

    assert!(
        should_forget_on_open_error_with_listing(&uri, &stat, None),
        "local + NotFound → forget, no listing needed (契約2)"
    );
    let with_name = listing_of(&parent, &["gone.md"]);
    assert!(
        should_forget_on_open_error_with_listing(&uri, &stat, Some(&with_name)),
        "local ignores a listing even if it names the file (契約2: stat decides)"
    );
    let failed: Result<Vec<Entry>, FsError> = Err(FsError::PermissionDenied("docs".into()));
    assert!(
        should_forget_on_open_error_with_listing(&uri, &stat, Some(&failed)),
        "local ignores a failed listing too"
    );
}

/// 10. ローカル: stat が NotFound 以外 → 除かない(今のまま)。判定は `should_forget_on_open_error` と一致する。
#[test]
fn local_other_errors_keep_and_agree_with_the_existing_rule() {
    let uri = local_uri("gone.md");
    let parent = parent_of(&uri);
    let without_name = listing_of(&parent, &["a.md"]);

    for err in other_stat_errors() {
        let msg = err.to_string();
        let stat: Result<Entry, FsError> = Err(err);
        let existing_rule = should_forget_on_open_error(stat.as_ref().err().unwrap());
        assert!(!existing_rule, "sanity: the existing rule keeps on {msg}");
        assert!(
            !should_forget_on_open_error_with_listing(&uri, &stat, None),
            "local stat failed with {msg} (not NotFound) → keep"
        );
        assert!(
            !should_forget_on_open_error_with_listing(&uri, &stat, Some(&without_name)),
            "local stat failed with {msg} → keep, whatever the listing"
        );
    }

    let not_found = stat_not_found(&uri);
    assert_eq!(
        should_forget_on_open_error_with_listing(&uri, &not_found, None),
        should_forget_on_open_error(not_found.as_ref().err().unwrap()),
        "for a local file the new judgement is the existing rule"
    );
}

/// 11. ローカル: stat が Ok → 除かない。
#[test]
fn local_stat_ok_keeps() {
    let uri = local_uri("there.md");
    let stat = stat_ok(&uri);
    assert!(!should_forget_on_open_error_with_listing(&uri, &stat, None));
}

// ---------------------------------------------------------------------------
// AC-64-追e(a) — 一覧が要るのは ssh で stat が NotFound のときだけ(契約1・2)
// ---------------------------------------------------------------------------

/// 12. `needs_parent_listing` の表: ssh + NotFound だけ true。ローカルは常に false。
#[test]
fn needs_parent_listing_table() {
    let ssh = ssh_uri("gone.md");
    assert!(
        needs_parent_listing(&ssh, &stat_not_found(&ssh)),
        "ssh + NotFound → the parent must be listed before deciding"
    );
    assert!(
        !needs_parent_listing(&ssh, &stat_ok(&ssh)),
        "ssh + stat Ok → no listing"
    );
    for err in other_stat_errors() {
        let msg = err.to_string();
        let stat: Result<Entry, FsError> = Err(err);
        assert!(
            !needs_parent_listing(&ssh, &stat),
            "ssh + {msg} → no listing (the entry is kept without one)"
        );
    }

    let local = local_uri("gone.md");
    assert!(
        !needs_parent_listing(&local, &stat_not_found(&local)),
        "local + NotFound → no listing (契約2: stat decides)"
    );
    assert!(!needs_parent_listing(&local, &stat_ok(&local)));
    for err in other_stat_errors() {
        let stat: Result<Entry, FsError> = Err(err);
        assert!(!needs_parent_listing(&local, &stat));
    }
}

// 型レベルのシグネチャ固定(ズレをコンパイルエラーにする=acceptance_req64 の家風)。
#[allow(dead_code)]
fn _needs_parent_listing_signature() -> fn(&Uri, &Result<Entry, FsError>) -> bool {
    needs_parent_listing
}

#[allow(dead_code)]
fn _with_listing_signature(
) -> fn(&Uri, &Result<Entry, FsError>, Option<&Result<Vec<Entry>, FsError>>) -> bool {
    should_forget_on_open_error_with_listing
}

#[allow(dead_code)]
fn _existing_rule_signature() -> fn(&FsError) -> bool {
    should_forget_on_open_error
}

// ---------------------------------------------------------------------------
// ソース走査のヘルパー(acceptance_req64 の写し)
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

fn document_rs_code() -> String {
    strip_line_comments(include_str!("../src/commands/document.rs"))
}

fn ssh_rs_code() -> String {
    strip_line_comments(include_str!("../src/fs/ssh.rs"))
}

/// `fn <name>(` から、次の `#[tauri::command]` か次の関数の頭か `#[cfg(test)]` まで。
fn fn_body(code: &str, name: &str) -> String {
    let marker = format!("fn {name}(");
    let at = code
        .find(&marker)
        .unwrap_or_else(|| panic!("`{marker}` must exist"));
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

/// `start` から最初の `(` に対応する閉じ括弧までの呼び出し全体。
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

// ---------------------------------------------------------------------------
// AC-64-追e(b) — 配線(commands/document.rs の open_in_window の失敗側)
// ---------------------------------------------------------------------------

/// 13. `open_in_window` の失敗側は stat → `needs_parent_listing` → 親(`.parent()`)の `list` →
///     `should_forget_on_open_error_with_listing` → `forget_file` の順で判定を通る。判定には stat の
///     結果と一覧の結果が渡る。
#[test]
fn open_in_window_consults_the_parent_listing_before_forgetting() {
    let code = document_rs_code();
    let body = fn_body(&code, "open_in_window");

    let stat_at = body
        .find(".stat(")
        .expect("open_in_window still stats the file after a failed open (契約8)");
    let needs_at = body
        .find("recent_files::needs_parent_listing(")
        .expect("the failure side must ask recent_files::needs_parent_listing(…) (追補e 契約1・2)");
    let list_at = body
        .find(".list(")
        .expect("the ssh case must list the parent folder with provider.list(…) (追補e 契約1)");
    let decide_at = body
        .find("recent_files::should_forget_on_open_error_with_listing(")
        .expect("the forget must be decided by recent_files::should_forget_on_open_error_with_listing(…) (追補e)");
    let forget_at = body
        .find("recent_files::forget_file(")
        .expect("open_in_window still calls recent_files::forget_file(…) (契約8)");
    assert!(
        stat_at < needs_at && needs_at < list_at && list_at < decide_at && decide_at < forget_at,
        "order must be stat → needs_parent_listing → list → should_forget_on_open_error_with_listing → forget_file:\n{body}"
    );
    assert!(
        body.contains(".parent()"),
        "the folder listed is the file's parent (Uri::parent): {body}"
    );

    let needs_call = balanced_call(&body, needs_at);
    assert!(
        needs_call.contains("parsed_uri"),
        "needs_parent_listing takes the opened uri: {needs_call}"
    );
    let decide_call = balanced_call(&body, decide_at);
    // 関数名(…_with_listing)を落として引数部分だけを見る(名前に "listing" が入るので、
    // 呼び出し全体で contains すると `None` を渡す変異を見逃す)。
    let decide_args = &decide_call[decide_call.find('(').expect("call must have '('") + 1..];
    assert!(
        decide_args.contains("parsed_uri"),
        "the judgement takes the opened uri: {decide_call}"
    );
    assert!(
        decide_args.contains("stat"),
        "the judgement takes the stat result: {decide_call}"
    );
    assert!(
        decide_args.contains("listing"),
        "the judgement must be handed the parent listing as an argument (a binding named …listing…, not None): {decide_call}"
    );

    // 記録の側(成功後の record_file)は不変=AC-64-9 が固定。ここでは forget が判定の後ろにあることだけ。
    assert!(
        body.contains("recent_files::record_file("),
        "the success side still records (契約2)"
    );
}

// ---------------------------------------------------------------------------
// 不変(契約3)— sftp_to_fs の写し方はそのまま
// ---------------------------------------------------------------------------

/// 14. `fs/ssh.rs` の `sftp_to_fs` は `NoSuchFile` も汎用の `Failure` も `NotFound` に写したまま
///     (macOS sftp-server 対策の既存の写し方は変えない=追補e の判断)。
#[test]
fn sftp_failure_and_no_such_file_still_map_to_not_found() {
    let code = ssh_rs_code();
    let compact = code.split_whitespace().collect::<Vec<_>>().join(" ");
    let at = compact
        .find("fn sftp_to_fs(")
        .expect("fs/ssh.rs must keep sftp_to_fs");
    let after = &compact[at..];
    assert!(
        after.contains("StatusCode::NoSuchFile => FsError::NotFound("),
        "NoSuchFile → NotFound must stay (契約3)"
    );
    assert!(
        after.contains("StatusCode::Failure => FsError::NotFound("),
        "the generic Failure → NotFound mapping must stay (契約3: the fix is the parent listing, not the mapping)"
    );
}
