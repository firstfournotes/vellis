//! 要件#6 の受け入れテスト(requirements.md #6)
//!
//! 「履歴記録時に URI を文字列正規化し、表記ゆれ(末尾スラッシュ等)による
//! 同一フォルダの重複を排除する」
//!
//! 契約(2026-08-04 由谷決定=文字列正規化案):
//! - `HistoryStore::add`(src-tauri/src/history.rs)で正規化してから
//!   dedupe・保存する
//! - 正規化 = 末尾スラッシュ除去(ただしパスが `/` のみ=`file:///` や
//!   `scheme://host` 直下=`ssh://host/` は除く)
//!   + パス部の連続スラッシュ縮約(`://` の区切りは保持)
//! - 正規化後の完全一致で dedupe(canonicalize=シンボリックリンク解決はしない)
//! - 例: `file:///a/b/` と `file:///a/b` → 1 行(`file:///a/b`)・
//!   `ssh://host//x` → `ssh://host/x`・`ssh://host/` はそのまま
//! - 追補(2026-08-04 由谷回答・requirements.md 反映済み):
//!   (a) パス空の `scheme://host` は `scheme://host/` へ正規化して同一視する
//!   (b) add 時は既存エントリ側も正規化して比較・保存する(レガシー履歴
//!       ファイル内の未正規化行・未正規化重複は add を機に解消される)
//!
//! 判定範囲: `HistoryStore::add` のシーム(add → list / on-disk)で固定する。
//! 既存の記録経路(`history::record_root`)は `tauri::AppHandle` 依存で、
//! モックアプリ経由でも `default_path` が実ユーザーの app config ディレクトリを
//! 指すため隔離した機械判定ができない。以下は reviewer 照合に委ねる:
//! - `record_root` が `HistoryStore::add` 経由のままであること
//!   (= 全記録経路に正規化が効く)
//! - 各記録箇所(set_root / init_window / handle_open_path)が引き続き
//!   `record_root` を経由すること
//!
//! 既存契約との整合: acceptance_req3.rs の契約(最近順・上限 20・JSON 配列・
//! 破損フォールバック)は変更しない。req3 が add する URI はすべて正規化済みの
//! 表記なので本要件と矛盾しない(req3 契約の「完全一致以上の正規化を加えるのは
//! 実装の自由」の自由枠を、本要件が上記の正規化規則に確定させる)。

use std::fs;
use std::path::PathBuf;

use tempfile::TempDir;

use vellis_lib::history::HistoryStore;

/// TempDir 直下の履歴ファイルパスを返す(ファイル自体は作らない)。
fn history_path(tmp: &TempDir) -> PathBuf {
    tmp.path().join("history.json")
}

/// 新しい空ストアに `uris` を順に add し、list の結果を返すヘルパ。
fn add_all_then_list(uris: &[&str]) -> Vec<String> {
    let tmp = TempDir::new().unwrap();
    let store = HistoryStore::new(&history_path(&tmp));
    for uri in uris {
        store.add(uri).unwrap();
    }
    store.list().unwrap()
}

/// 1. 末尾スラッシュ除去(local): `file:///…/` は除去した形で記録される。
#[test]
fn trailing_slash_is_stripped_for_local_uri() {
    assert_eq!(
        add_all_then_list(&["file:///Users/a/docs/"]),
        vec!["file:///Users/a/docs".to_string()],
        "add must store the trailing-slash-stripped form"
    );
}

/// 2. 末尾スラッシュ除去(ssh): user/port 付きの authority はそのまま、
///    パス末尾のスラッシュだけが落ちる。
#[test]
fn trailing_slash_is_stripped_for_ssh_uri() {
    assert_eq!(
        add_all_then_list(&["ssh://user@host:2222/path/to/dir/"]),
        vec!["ssh://user@host:2222/path/to/dir".to_string()],
        "stripping must not touch the scheme/authority part"
    );
}

/// 3. 連続スラッシュ縮約: パス部の `//`… は `/` に縮約される。
///    `://` の区切り(スキーム直後の 2 本)は縮約しない。
#[test]
fn consecutive_slashes_in_path_are_collapsed() {
    // 契約の例: ssh://host//x → ssh://host/x
    assert_eq!(
        add_all_then_list(&["ssh://host//x"]),
        vec!["ssh://host/x".to_string()],
        "double slash in the path part must collapse to one"
    );
    // 複数箇所・3 本以上も同様。
    assert_eq!(
        add_all_then_list(&["file:///a//b///c"]),
        vec!["file:///a/b/c".to_string()],
        "every run of slashes in the path part must collapse"
    );
    // file:// は authority が空なので 4 本目以降がパス部。`://` は保持される。
    assert_eq!(
        add_all_then_list(&["file:////a"]),
        vec!["file:///a".to_string()],
        "collapse must apply to the path while keeping the '://' separator"
    );
}

/// 4. 縮約+末尾除去の合成: `file:///a/b//` は縮約と末尾スラッシュ除去の
///    両方が効いて `file:///a/b` になる。
#[test]
fn collapse_and_trailing_strip_compose() {
    assert_eq!(
        add_all_then_list(&["file:///a/b//"]),
        vec!["file:///a/b".to_string()],
        "trailing run of slashes must fully normalize away"
    );
}

/// 5. ルート直下は末尾スラッシュを残す: `ssh://host/`・`file:///` はそのまま。
///    `ssh://host//` は縮約後にパスが `/` のみとなるので `ssh://host/` に落ち着く
///    (`ssh://host` まで削らない)。
#[test]
fn root_uris_keep_their_single_slash() {
    assert_eq!(
        add_all_then_list(&["ssh://host/"]),
        vec!["ssh://host/".to_string()],
        "scheme://host root must be kept as-is"
    );
    assert_eq!(
        add_all_then_list(&["file:///"]),
        vec!["file:///".to_string()],
        "file root (path is just '/') must be kept as-is"
    );
    assert_eq!(
        add_all_then_list(&["ssh://host//"]),
        vec!["ssh://host/".to_string()],
        "a doubled root slash collapses to the root form, not below it"
    );
}

/// 6. 素通し(ガード): 正規化不要な URI は一切書き換えずに記録される
///    (最近順=req3 契約もそのまま)。
#[test]
fn already_normalized_uris_pass_through_unchanged() {
    assert_eq!(
        add_all_then_list(&[
            "file:///Users/a/docs",
            "ssh://host/x",
            "ssh://user@host:2222/path/to/dir",
            "ssh://host/",
        ]),
        vec![
            "ssh://host/".to_string(),
            "ssh://user@host:2222/path/to/dir".to_string(),
            "ssh://host/x".to_string(),
            "file:///Users/a/docs".to_string(),
        ],
        "normalization must be a no-op on already-normalized URIs"
    );
}

/// 7. 契約の例そのまま: `file:///a/b/` と `file:///a/b` は 1 行
///    (`file:///a/b`)になる。
#[test]
fn slash_variant_and_plain_form_dedupe_to_one_line() {
    let entries = add_all_then_list(&["file:///a/b/", "file:///a/b"]);
    assert_eq!(
        entries,
        vec!["file:///a/b".to_string()],
        "both spellings of the same folder must yield a single normalized line"
    );
}

/// 8. 3 通りの表記(素・連続スラッシュ・末尾スラッシュ)が 1 行に畳まれる。
#[test]
fn multiple_spellings_of_same_folder_collapse_to_one_entry() {
    let entries = add_all_then_list(&["ssh://host/x", "ssh://host//x", "ssh://host/x/"]);
    assert_eq!(
        entries,
        vec!["ssh://host/x".to_string()],
        "every spelling variant must dedupe into the one normalized entry"
    );
}

/// 9. 表記ゆれでの再訪は既存エントリの繰上げになる(req3 の繰上げ契約が
///    正規化後の一致にも適用される)。他のエントリは相対順を保つ。
#[test]
fn revisiting_via_a_variant_promotes_existing_entry_without_duplicate() {
    let tmp = TempDir::new().unwrap();
    let store = HistoryStore::new(&history_path(&tmp));

    store.add("file:///Users/a/docs").unwrap();
    store.add("file:///Users/a/notes").unwrap();
    store.add("file:///Users/a/work").unwrap();

    // 最古のフォルダを末尾スラッシュ付きの表記で再訪。
    store.add("file:///Users/a/docs/").unwrap();

    let entries = store.list().unwrap();
    assert_eq!(entries.len(), 3, "a spelling variant must not create a duplicate");
    assert_eq!(
        entries,
        vec![
            "file:///Users/a/docs".to_string(),
            "file:///Users/a/work".to_string(),
            "file:///Users/a/notes".to_string(),
        ],
        "the variant must promote the existing normalized entry to the head"
    );
}

/// 10. ガード: 正規化は文字列のみ。シンボリックリンクは解決しない
///     (canonicalize しない)ので、実体が同じでも表記が異なれば別エントリ。
#[cfg(unix)]
#[test]
fn symlinked_folders_are_not_canonicalized_together() {
    let tmp = TempDir::new().unwrap();
    let real = tmp.path().join("real");
    fs::create_dir(&real).unwrap();
    let link = tmp.path().join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();

    let store = HistoryStore::new(&history_path(&tmp));
    store.add(&format!("file://{}", real.display())).unwrap();
    store.add(&format!("file://{}", link.display())).unwrap();

    assert_eq!(
        store.list().unwrap().len(),
        2,
        "normalization is string-only: symlinks must not be resolved into one entry"
    );
}

/// 11. 保存形式: ディスク上の JSON 配列にも正規化後の文字列が入る
///     (list だけ整形して見せる、ではない)。
#[test]
fn on_disk_entries_are_stored_normalized() {
    let tmp = TempDir::new().unwrap();
    let path = history_path(&tmp);
    let store = HistoryStore::new(&path);

    store.add("file:///Users/a/docs/").unwrap();
    store.add("ssh://host//x").unwrap();

    let raw = fs::read_to_string(&path).unwrap();
    let parsed: Vec<String> =
        serde_json::from_str(&raw).expect("history file must stay a JSON array of strings");
    assert_eq!(
        parsed,
        vec!["ssh://host/x".to_string(), "file:///Users/a/docs".to_string()],
        "the persisted entries themselves must be the normalized strings"
    );
}

/// 12. 永続化をまたいだ dedupe: 別インスタンス(=別プロセス起動相当)で
///     表記ゆれの同一フォルダを add しても 1 行のまま。
#[test]
fn normalized_dedupe_holds_across_instances() {
    let tmp = TempDir::new().unwrap();
    let path = history_path(&tmp);

    {
        let first = HistoryStore::new(&path);
        first.add("file:///Users/a/docs/").unwrap();
    }

    let second = HistoryStore::new(&path);
    second.add("file:///Users/a/docs").unwrap();

    assert_eq!(
        second.list().unwrap(),
        vec!["file:///Users/a/docs".to_string()],
        "the same folder recorded across launches must stay a single line"
    );
}

/// 13. 追補(a): パス空の `scheme://host` は `scheme://host/` へ正規化して
///     記録される(user/port 付き authority も同様)。
#[test]
fn authority_only_uri_gains_root_slash() {
    assert_eq!(
        add_all_then_list(&["ssh://host"]),
        vec!["ssh://host/".to_string()],
        "an authority-only URI must be normalized to the root form"
    );
    assert_eq!(
        add_all_then_list(&["ssh://user@host:2222"]),
        vec!["ssh://user@host:2222/".to_string()],
        "user/port in the authority must be kept while adding the root slash"
    );
}

/// 14. 追補(a): `ssh://host` と `ssh://host/` は同一視され 1 行になる
///     (どちらの順で add しても正規形 `ssh://host/`)。
#[test]
fn authority_only_and_root_form_dedupe_to_one_line() {
    assert_eq!(
        add_all_then_list(&["ssh://host", "ssh://host/"]),
        vec!["ssh://host/".to_string()],
        "both spellings of the host root must yield a single line"
    );
    assert_eq!(
        add_all_then_list(&["ssh://host/", "ssh://host"]),
        vec!["ssh://host/".to_string()],
        "dedupe must work in either add order"
    );
}

/// 15. 追補(b): レガシー履歴ファイル内の未正規化行は add を機に正規化される。
///     - 新規 add と表記ゆれ一致する既存行 → dedupe(重複を作らない)
///     - 無関係な既存行も正規化した形で保存し直される(ディスク上も正規形)
#[test]
fn legacy_unnormalized_entries_are_normalized_and_deduped_on_add() {
    let tmp = TempDir::new().unwrap();
    let path = history_path(&tmp);
    // 実装前(要件#6 以前)に書かれた想定の未正規化な履歴ファイルを直接用意。
    fs::write(
        &path,
        r#"["file:///Users/a/docs/","ssh://host//x"]"#,
    )
    .unwrap();

    let store = HistoryStore::new(&path);
    store.add("file:///Users/a/docs").unwrap();

    let expected = vec![
        "file:///Users/a/docs".to_string(),
        "ssh://host/x".to_string(),
    ];
    assert_eq!(
        store.list().unwrap(),
        expected,
        "a legacy variant must dedupe with the new add; unrelated legacy \
         entries must come back normalized"
    );

    // 保存側も正規形になっていること(list だけ整形して見せる、ではない)。
    let raw = fs::read_to_string(&path).unwrap();
    let parsed: Vec<String> =
        serde_json::from_str(&raw).expect("history file must stay a JSON array of strings");
    assert_eq!(
        parsed, expected,
        "the rewritten file must contain the normalized strings"
    );
}

/// 16. 追補(b): レガシーファイル内に既にある未正規化の重複(同一フォルダの
///     別表記)は、無関係な add を機に 1 行へ解消される。
#[test]
fn legacy_duplicates_inside_the_file_are_resolved_on_add() {
    let tmp = TempDir::new().unwrap();
    let path = history_path(&tmp);
    // 先頭 2 行は同一フォルダの別表記(正規形はどちらも ssh://host/x)。
    fs::write(
        &path,
        r#"["ssh://host//x","ssh://host/x/","file:///Users/a/notes"]"#,
    )
    .unwrap();

    let store = HistoryStore::new(&path);
    store.add("file:///Users/a/docs").unwrap();

    assert_eq!(
        store.list().unwrap(),
        vec![
            "file:///Users/a/docs".to_string(),
            "ssh://host/x".to_string(),
            "file:///Users/a/notes".to_string(),
        ],
        "pre-existing spelling duplicates must collapse to one normalized line"
    );
}
