//! 要件#71 追補e の受け入れテスト(docs/requirements/req-71.md「追補e」= Issue #871)
//! — Rust 層(AC-71-13 (a)〜(d))
//!
//! 発端: ssh で開いたフォルダで、フォルダへのシンボリックリンクをクリックすると alert が
//! `Could not open the file: I/O error: Failure: Failure` になる。ssh の一覧はリンクを全部
//! `symlink` で返すのでフォルダへのリンクもファイルとして開こうとし、macOS の sftp-server は
//! `open_with_flags` を通して `read_to_end` で汎用の `Failure` を返す。それが `classify_io_error`
//! で `FsError::Io` になる。
//!
//! 契約(追補e):
//! 1. `FsError` に `NotAFile(String)` を足す。Display は中の文そのまま(前置きなし)。
//!    `ssh_pool.rs` の `copy_fs_error` も同じ変種に写す
//! 2. `fs/ssh.rs` に純粋関数 `pub fn folder_read_error(uri: &str, behind: &FolderBehind) -> FsError`
//!    と `pub enum FolderBehind { Folder, Link { target: Option<String> } }`。返すのは
//!    `FsError::NotAFile(<文>)` で、文は本ファイルの `EXPECTED_*` のとおり
//! 3. `SshProvider::read_bytes` が失敗したら、同じ接続で 1 回だけ調べ直す: `metadata`(リンクを辿る)
//!    がフォルダなら `symlink_metadata` でリンクかを見て、リンクなら `read_link` でリンク先を取り
//!    (取れなければ `None`)、`folder_read_error(&uri.raw, …)` を返す。フォルダでない・調べ直しが
//!    失敗したときは元のエラー。成功した読み込みでは調べ直さない
//! 4. 開く経路では包み直さない(alert の `<理由>` がそのまま契約2 の文になる)
//! 5. 不変: `sftp_to_fs` / `classify_sftp_error` / `classify_io_error`・ほかの `FsError` の Display・
//!    ssh の一覧・`FileProvider` の fn 集合・alert の組み立て。依存の追加なし
//!
//! 判定範囲(AC-71-13。実 sshd は使わない):
//! - (a) `folder_read_error` の 3 通りが契約2 の文と完全一致し、変種は `FsError::NotAFile`(公開の口)
//! - (b) `FsError::NotAFile(s).to_string() == s`(`I/O error`・`Failure` を含まない)(公開の口)
//! - (c) ソース走査: `SshProvider::read_bytes` の本文(+ そこから呼ぶ ssh.rs 内の fn の本体=1 段)が
//!   `folder_read_error(`・`.metadata(`・`.symlink_metadata(`・`.read_link(` を使う。
//!   調べ直しは `read_to_end` のあと・`Err` の文脈で始まる(成功の分岐で調べ直さない)。
//!   `.metadata(` は 1 回だけ(契約3「1 回だけ調べ直す」)
//! - (d) `copy_fs_error`(private)は公開の口で判定する: `ConnectionPool::get` で同じキーを同時に
//!   取り出し、開く側が `FsError::NotAFile` で失敗すると、待っていた側は `copy_fs_error` の写し
//!   (`wait_for_open`)を受け取る。その変種と文が同じであること。加えてソース走査で match の腕を 1 件
//! - (e) 既存のテストは無改変で緑 → test-runner のフルスイートで見る
//!
//! ## 確定契約(公開 API。implementer はこれに従う)
//!
//! ```ignore
//! // src-tauri/src/errors.rs
//! pub enum FsError {
//!     …,
//!     /// 追補e: 開こうとした場所がファイルではない(フォルダ・フォルダへのリンク)。
//!     /// 文は呼び手(`fs::ssh::folder_read_error`)が組み立て、Display は前置きを付けない。
//!     #[error("{0}")]
//!     NotAFile(String),
//! }
//!
//! // src-tauri/src/fs/ssh.rs
//! #[derive(Debug, Clone, PartialEq, Eq)]
//! pub enum FolderBehind {
//!     Folder,
//!     Link { target: Option<String> },
//! }
//! pub fn folder_read_error(uri: &str, behind: &FolderBehind) -> FsError;
//!
//! // src-tauri/src/fs/ssh_pool.rs — copy_fs_error に腕を足す
//! FsError::NotAFile(s) => FsError::NotAFile(s.clone()),
//! ```
//!
//! ## 赤の源(修正前の見込み)
//! - `FsError::NotAFile`・`folder_read_error`・`FolderBehind` が無いのでコンパイルが落ち、
//!   本ファイル全体が赤。型だけ置いたスタブでも (a) は文で・(c) は走査で・(d) は変種で赤
//!
//! ## 判断の記録(2026-11-28 test-writer)
//! - (c) の「成功の分岐で調べ直さない」は本文の形で近似する: `.metadata(` 等の調べ直しの最初の
//!   位置が `read_to_end` より後で、その間に `Err` の文脈(`Err(`・`map_err`・`or_else`・`is_err`)が
//!   ある。読み込みの成功・失敗を実サーバ無しで分けて実行できないため。厳密な配線は reviewer に委ねる
//! - (c) の走査対象は `read_bytes` の本体に、そこから呼ぶ ssh.rs 内の fn(1 段)の本体を足す。
//!   調べ直しを private の helper に切り出す作り(KISS 的に自然)を許すため
//! - (d) は公開の口(`ConnectionPool::get` の待ち手が受ける写し)で判定し、走査は腕の有無だけ補助
//! - (c) で `OpError::Failed` に包むこと(`Disconnected` だと入れ物が開き直してもう 1 回読む)は
//!   契約に明記が無いので assert せず、reviewer の照合項目として報告に書く

#![cfg(feature = "provider-ssh")]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use vellis_lib::errors::FsError;
use vellis_lib::fs::ssh::{folder_read_error, FolderBehind};
use vellis_lib::fs::ssh_pool::{ConnectionPool, PooledConnection};

const URI: &str = "ssh://Alis4/Users/tetsuo/ffn/dropbox";
const TARGET: &str = "../First Four Notes Dropbox";

const EXPECTED_LINK_WITH_TARGET: &str = "ssh://Alis4/Users/tetsuo/ffn/dropbox is a symbolic link to a folder (../First Four Notes Dropbox), not a file. Folders behind a symbolic link cannot be opened over ssh; open the folder it points to instead.";
const EXPECTED_LINK_NO_TARGET: &str = "ssh://Alis4/Users/tetsuo/ffn/dropbox is a symbolic link to a folder, not a file. Folders behind a symbolic link cannot be opened over ssh; open the folder it points to instead.";
const EXPECTED_FOLDER: &str = "ssh://Alis4/Users/tetsuo/ffn/dropbox is a folder, not a file.";

fn not_a_file_text(e: &FsError, what: &str) -> String {
    match e {
        FsError::NotAFile(s) => s.clone(),
        other => panic!("{what}: expected FsError::NotAFile, got {other:?} (`{other}`)"),
    }
}

fn assert_plain_message(msg: &str, what: &str) {
    assert!(
        !msg.contains("I/O error"),
        "{what}: must not carry the `I/O error` prefix: `{msg}`"
    );
    assert!(
        !msg.contains("Failure"),
        "{what}: must not leak the sftp `Failure` status: `{msg}`"
    );
}

// ---------------------------------------------------------------------------
// (a) folder_read_error の 3 通り(公開の口)
// ---------------------------------------------------------------------------

/// a1. フォルダへのリンクでリンク先が取れた: URI とリンク先を含む契約2 の文、変種は NotAFile。
#[test]
fn ac71_13_a_link_with_target_message() {
    let e = folder_read_error(
        URI,
        &FolderBehind::Link {
            target: Some(TARGET.to_string()),
        },
    );
    assert_eq!(
        not_a_file_text(&e, "link with target"),
        EXPECTED_LINK_WITH_TARGET
    );
    assert_eq!(
        e.to_string(),
        EXPECTED_LINK_WITH_TARGET,
        "Display adds no prefix"
    );
}

/// a2. フォルダへのリンクでリンク先が取れなかった: 括弧の無い文。
#[test]
fn ac71_13_a_link_without_target_message() {
    let e = folder_read_error(URI, &FolderBehind::Link { target: None });
    assert_eq!(
        not_a_file_text(&e, "link without target"),
        EXPECTED_LINK_NO_TARGET
    );
    assert_eq!(
        e.to_string(),
        EXPECTED_LINK_NO_TARGET,
        "Display adds no prefix"
    );
}

/// a3. リンクでないフォルダ: 短い文。
#[test]
fn ac71_13_a_folder_message() {
    let e = folder_read_error(URI, &FolderBehind::Folder);
    assert_eq!(not_a_file_text(&e, "folder"), EXPECTED_FOLDER);
    assert_eq!(e.to_string(), EXPECTED_FOLDER, "Display adds no prefix");
}

/// a4. 文は URI をそのまま含み(どこの・ssh であることが分かる)、ほかの URI でも同じ形になる。
#[test]
fn ac71_13_a_message_embeds_the_uri_verbatim() {
    let other = "ssh://box.example/srv/notes/link to docs";
    for behind in [
        FolderBehind::Folder,
        FolderBehind::Link { target: None },
        FolderBehind::Link {
            target: Some("/srv/docs".to_string()),
        },
    ] {
        let msg = not_a_file_text(&folder_read_error(other, &behind), "other uri");
        assert!(
            msg.starts_with(other),
            "the message must start with the ssh URI verbatim ({behind:?}): `{msg}`"
        );
        assert!(msg.contains(", not a file."), "({behind:?}): `{msg}`");
        assert_plain_message(&msg, "other uri");
    }
    let with_target = not_a_file_text(
        &folder_read_error(
            other,
            &FolderBehind::Link {
                target: Some("/srv/docs".to_string()),
            },
        ),
        "other uri with target",
    );
    assert!(
        with_target.contains("(/srv/docs)"),
        "the link target goes in parentheses: `{with_target}`"
    );
}

// ---------------------------------------------------------------------------
// (b) FsError::NotAFile の Display(公開の口)
// ---------------------------------------------------------------------------

/// b1. `NotAFile(s).to_string() == s`(前置き・後置きを付けない)。
#[test]
fn ac71_13_b_not_a_file_displays_its_message_verbatim() {
    for s in [
        EXPECTED_LINK_WITH_TARGET,
        EXPECTED_LINK_NO_TARGET,
        EXPECTED_FOLDER,
        "x",
        "",
    ] {
        let e = FsError::NotAFile(s.to_string());
        assert_eq!(
            e.to_string(),
            s,
            "Display of NotAFile must be the inner text as is"
        );
    }
}

/// b2. `I/O error` と `Failure` を含まない(発端の `I/O error: Failure: Failure` にならない)。
#[test]
fn ac71_13_b_not_a_file_display_has_no_io_error_or_failure() {
    let e = FsError::NotAFile(EXPECTED_LINK_WITH_TARGET.to_string());
    assert_plain_message(&e.to_string(), "NotAFile display");
}

/// b3. 不変(契約5): ほかの変種の Display は今までどおり。
#[test]
fn ac71_13_b_other_variants_display_unchanged() {
    assert_eq!(FsError::NotFound("p".into()).to_string(), "not found: p");
    assert_eq!(
        FsError::PermissionDenied("p".into()).to_string(),
        "permission denied: p"
    );
    assert_eq!(
        FsError::FileTooLarge("p".into()).to_string(),
        "file too large: p"
    );
    assert_eq!(FsError::InvalidUtf8.to_string(), "invalid UTF-8");
    assert_eq!(
        FsError::UnsupportedScheme("s".into()).to_string(),
        "unsupported scheme: s"
    );
    assert_eq!(
        FsError::Unsupported("o".into()).to_string(),
        "unsupported operation: o"
    );
    assert_eq!(
        FsError::Io(std::io::Error::other("Failure")).to_string(),
        "I/O error: Failure"
    );
}

// ---------------------------------------------------------------------------
// (d) copy_fs_error が NotAFile を同じ文で写す(公開の口 = 入れ物の待ち手)
// ---------------------------------------------------------------------------

struct FakeConn;

impl PooledConnection for FakeConn {
    fn is_closed(&self) -> bool {
        false
    }
}

/// d1. 同じキーで 2 件同時に取り出し、開く側が `NotAFile` で失敗すると、待っていた側は
///     `copy_fs_error` で写された同じ変種・同じ文を受け取る(`Io` に化けない)。
#[tokio::test]
async fn ac71_13_d_waiter_receives_not_a_file_copied_verbatim() {
    const KEY: &str = "tetsuo@Alis4:22";
    let pool: Arc<ConnectionPool<FakeConn>> = Arc::new(ConnectionPool::new());
    let opens = Arc::new(AtomicUsize::new(0));

    // 開く側: 最初の yield で止まり(待ち手が「開いている最中」に重なる)、NotAFile で失敗する。
    let opener = {
        let pool = pool.clone();
        let opens = opens.clone();
        tokio::spawn(async move {
            pool.get(KEY, || {
                let opens = opens.clone();
                async move {
                    opens.fetch_add(1, Ordering::SeqCst);
                    tokio::task::yield_now().await;
                    Err::<FakeConn, FsError>(FsError::NotAFile(
                        EXPECTED_LINK_WITH_TARGET.to_string(),
                    ))
                }
            })
            .await
        })
    };
    // 待ち手: `open` は呼ばれないはず(呼ばれたら別の文で失敗させ、写しでないことが分かる)。
    let waiter = {
        let pool = pool.clone();
        let opens = opens.clone();
        tokio::spawn(async move {
            pool.get(KEY, || {
                let opens = opens.clone();
                async move {
                    opens.fetch_add(1, Ordering::SeqCst);
                    Err::<FakeConn, FsError>(FsError::NotFound("waiter opened by itself".into()))
                }
            })
            .await
        })
    };

    let first = opener.await.expect("opener task does not panic");
    let second = waiter.await.expect("waiter task does not panic");

    assert_eq!(
        opens.load(Ordering::SeqCst),
        1,
        "only the opener may enter `open`"
    );
    let original = first
        .err()
        .expect("the opener receives the original failure");
    assert_eq!(
        not_a_file_text(&original, "opener"),
        EXPECTED_LINK_WITH_TARGET
    );

    let copied = second
        .err()
        .expect("the waiter receives the copied failure");
    assert_eq!(
        not_a_file_text(&copied, "waiter (copy_fs_error)"),
        EXPECTED_LINK_WITH_TARGET,
        "copy_fs_error must keep the NotAFile text verbatim"
    );
    assert_eq!(copied.to_string(), EXPECTED_LINK_WITH_TARGET);
    assert!(
        pool.cached(KEY).await.is_none(),
        "nothing is kept after a failed open"
    );
}

/// d2. 走査の補助: `copy_fs_error` に `NotAFile` の腕があり、文を clone で写す。
#[test]
fn ac71_13_d_copy_fs_error_has_a_not_a_file_arm() {
    let code = strip_line_comments(SSH_POOL_RS);
    let (_, body) = function_parts(&code, "copy_fs_error", "ssh_pool.rs");
    let compact = body.replace(' ', "").replace('\n', "");
    assert!(
        compact.contains("FsError::NotAFile(s)=>FsError::NotAFile(s.clone())"),
        "copy_fs_error must copy NotAFile into NotAFile with the same text: {body}"
    );
}

// ---------------------------------------------------------------------------
// (c) ソース走査: read_bytes の失敗の分岐で調べ直す
// ---------------------------------------------------------------------------

const SSH_RS: &str = include_str!("../src/fs/ssh.rs");
const SSH_POOL_RS: &str = include_str!("../src/fs/ssh_pool.rs");

/// `read_bytes` の本体と、そこから呼ぶ ssh.rs 内の fn(1 段)の本体。
/// 2 つ目の返り値は、調べ直し(`.metadata(` / `folder_read_error(`)を含む helper の
/// `read_bytes` 本体内での呼び出し位置(本体に直書きなら無い)。
fn read_bytes_reach(code: &str) -> (String, Vec<usize>) {
    let (_, body) = function_parts(code, "read_bytes", "ssh.rs");
    let mut reach = String::from(body);
    let mut helper_call_sites = Vec::new();
    for (name, _) in all_functions(code) {
        // 純粋関数 `folder_read_error` 自身は配線ではない(含めると FolderBehind の腕が自明に満たる)。
        if name == "read_bytes" || name == "folder_read_error" {
            continue;
        }
        let call = format!("{name}(");
        let Some(site) = body.match_indices(&call).map(|(i, _)| i).find(|&i| {
            i == 0
                || !(body.as_bytes()[i - 1].is_ascii_alphanumeric()
                    || body.as_bytes()[i - 1] == b'_')
        }) else {
            continue;
        };
        let (_, helper_body) = function_parts(code, &name, "ssh.rs");
        if helper_body.contains(".metadata(") || helper_body.contains("folder_read_error(") {
            helper_call_sites.push(site);
        }
        reach.push('\n');
        reach.push_str(helper_body);
    }
    (reach, helper_call_sites)
}

/// c1. 失敗の分岐が `folder_read_error` に至り、`metadata`・`symlink_metadata`・`read_link` を使う。
#[test]
fn ac71_13_c_read_bytes_reaches_folder_read_error_via_metadata_lookups() {
    let code = strip_line_comments(SSH_RS);
    let (reach, _) = read_bytes_reach(&code);
    for needle in [
        "folder_read_error(",
        ".metadata(",
        ".symlink_metadata(",
        ".read_link(",
    ] {
        assert!(
            reach.contains(needle),
            "SshProvider::read_bytes (or a helper it calls) must use `{needle}`: {reach}"
        );
    }
    assert!(
        reach.contains("FolderBehind::Link") && reach.contains("FolderBehind::Folder"),
        "both FolderBehind variants must be produced on the failure path: {reach}"
    );
}

/// c2. 成功の分岐で調べ直さない: 調べ直しは `read_to_end` のあと、`Err` の文脈で始まる。
///     `.metadata(` は 1 回だけ(契約3「同じ接続で 1 回だけ調べ直す」)。
#[test]
fn ac71_13_c_read_bytes_recheck_only_on_the_failure_path() {
    let code = strip_line_comments(SSH_RS);
    let (_, body) = function_parts(&code, "read_bytes", "ssh.rs");
    let (reach, helper_sites) = read_bytes_reach(&code);

    let read_at = body
        .find("read_to_end")
        .expect("read_bytes still reads the whole file");
    let open_at = body
        .find("open_with_flags")
        .expect("read_bytes still opens the file first");
    let recheck_at = [body.find("folder_read_error("), body.find(".metadata(")]
        .into_iter()
        .flatten()
        .chain(helper_sites)
        .min()
        .expect("read_bytes must start the re-check somewhere in its body");
    assert!(
        recheck_at > read_at && recheck_at > open_at,
        "the re-check must come after the open + read_to_end, not before them (success path untouched): {body}"
    );
    // 調べ直しは await を要るので同期の `map_err` / `or_else` の閉包には置けない。`match` /
    // `if let Err` / `let Err(..) = .. else` のどれかで `Err(` が現れることを失敗の分岐の印にする
    // (`map_err(classify_io_error)` は小文字の `err(` なので印にならない)。
    let between = &body[read_at..recheck_at];
    assert!(
        between.contains("Err("),
        "the re-check must sit in the failure branch (`Err(` arm) after read_to_end: {between}"
    );

    assert_eq!(
        reach.matches(".metadata(").count(),
        1,
        "exactly one `metadata` lookup per failed read: {reach}"
    );
    assert_eq!(
        reach.matches(".symlink_metadata(").count(),
        1,
        "exactly one `symlink_metadata` lookup per failed read: {reach}"
    );
    assert_eq!(
        reach.matches(".read_link(").count(),
        1,
        "exactly one `read_link` lookup per failed read: {reach}"
    );
}

/// c3. 不変(契約5・AC-05-追a f5): `read_to_end` の失敗は今までどおり `classify_io_error` を通り、
///     `sftp_to_fs` 直結にはしない。`&uri.raw` を文に使う(契約3)。
#[test]
fn ac71_13_c_read_bytes_keeps_classification_and_uses_the_raw_uri() {
    let code = strip_line_comments(SSH_RS);
    let (_, body) = function_parts(&code, "read_bytes", "ssh.rs");
    let (reach, _) = read_bytes_reach(&code);
    assert!(
        body.contains("classify_io_error"),
        "read_to_end errors still go through classify_io_error"
    );
    assert!(
        body.contains("classify_sftp_error"),
        "open errors still go through classify_sftp_error"
    );
    assert!(
        !body.contains("sftp_to_fs("),
        "no direct sftp_to_fs in read_bytes: {body}"
    );
    assert!(
        reach.contains("uri.raw"),
        "the message is built from the raw ssh URI (`&uri.raw`): {reach}"
    );
}

/// c4. 契約2 の置き場: `folder_read_error` と `FolderBehind` は `fs/ssh.rs` に公開で定義される。
#[test]
fn ac71_13_c_folder_read_error_and_folder_behind_live_in_ssh_rs() {
    let code = strip_line_comments(SSH_RS);
    assert!(
        code.contains("pub fn folder_read_error("),
        "ssh.rs must define `pub fn folder_read_error(`"
    );
    assert!(
        code.contains("pub enum FolderBehind"),
        "ssh.rs must define `pub enum FolderBehind`"
    );
    let (params, _) = function_parts(&code, "folder_read_error", "ssh.rs");
    let compact = params.replace(' ', "");
    assert!(
        compact.contains("uri:&str") && compact.contains("behind:&FolderBehind"),
        "folder_read_error(uri: &str, behind: &FolderBehind): {params}"
    );
}

// ---------------------------------------------------------------------------
// ソース走査の道具(acceptance_req5a.rs と同じ家風)
// ---------------------------------------------------------------------------

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

/// `from` 以降で最初に現れる `open` から、対応する `close` までを切り出す。
fn balanced(code: &str, from: usize, open: char, close: char) -> &str {
    let start = code[from..]
        .find(open)
        .unwrap_or_else(|| panic!("`{open}` must follow offset {from}"))
        + from;
    let mut depth = 0usize;
    for (offset, ch) in code[start..].char_indices() {
        if ch == open {
            depth += 1;
        } else if ch == close {
            depth -= 1;
            if depth == 0 {
                return &code[start..start + offset + ch.len_utf8()];
            }
        }
    }
    panic!("`{open}` at {start} never closes");
}

/// `fn <name>` の (引数リスト, 本体) を切り出す(ジェネリクス入りの引数にも耐える)。
fn function_parts<'a>(code: &'a str, name: &str, file: &str) -> (&'a str, &'a str) {
    let needle = format!("fn {name}");
    let start = code
        .match_indices(&needle)
        .map(|(i, _)| i)
        .find(|i| {
            let rest = &code[i + needle.len()..];
            rest.starts_with('(') || rest.starts_with('<')
        })
        .unwrap_or_else(|| panic!("{file} must define {name}"));
    let params = balanced(code, start + needle.len(), '(', ')');
    let params_end = params.as_ptr() as usize - code.as_ptr() as usize + params.len();
    let body = balanced(code, params_end, '{', '}');
    (params, body)
}

/// ファイル内の全関数の (名前, 引数リスト)。
fn all_functions(code: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (i, _) in code.match_indices("fn ") {
        if i > 0 && !code.as_bytes()[i - 1].is_ascii_whitespace() {
            continue;
        }
        let rest = &code[i + 3..];
        let name_len = rest
            .find(|c: char| !(c.is_alphanumeric() || c == '_'))
            .unwrap_or(rest.len());
        if name_len == 0 {
            continue;
        }
        let name = &rest[..name_len];
        let after = &rest[name_len..];
        if !(after.starts_with('(') || after.starts_with('<')) {
            continue;
        }
        let params = balanced(code, i + 3 + name_len, '(', ')');
        out.push((name.to_string(), params.to_string()));
    }
    out
}
