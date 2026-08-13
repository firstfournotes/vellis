//! 要件#5 の受け入れテスト(requirements.md #5)
//!
//! 「ssh のファイル直指定(拡張子付きパス)はファイルとして開く(親ディレクトリを
//! root・履歴には親を記録)。拡張子なし・末尾スラッシュはディレクトリ扱いのまま」
//!
//! 契約(2026-08-04 由谷決定=拡張子ヒューリスティック案):
//! - `uri_looks_like_dir`(src/window/manager.rs)はリモート URI の末尾セグメントに
//!   拡張子(セグメント先頭以外の `.`)があればファイル判定
//!   (現行の md/markdown/mdx 限定を撤廃)
//! - 例: ssh://host/notes.txt=ファイル・ssh://host/repo=ディレクトリ(拡張子なし)・
//!   ssh://host/path/=ディレクトリ(末尾スラッシュ)・ssh://host/.bashrc=
//!   ディレクトリ扱い(先頭ドットは拡張子とみなさない)
//! - ファイル直指定時: root=親ディレクトリ・initial_path=当該ファイル・
//!   履歴記録=親ディレクトリ(ファイル URI を履歴に入れない)
//! - local(file://)の実 stat 判定は現行維持
//!
//! 判定範囲: 純ロジックのみ(実 SSH 接続を要するテストは書かない)。
//! 履歴ストア自体の契約(add/list/永続化)は acceptance_req3.rs で固定済み。
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```ignore
//! // 実装先: src-tauri/src/window/manager.rs
//!
//! // (1) 既存関数の判定規則を変更する:
//! //     リモート(非 file://)URI は「末尾パスセグメントにセグメント先頭以外の
//! //     `.` がある」場合のみファイル(false)。末尾スラッシュは常にディレクトリ。
//! //     ホスト名や途中セグメントのドットは判定に関与しない。
//! //     std::path::Path::extension() の意味論(先頭ドット単独は拡張子でない)と
//! //     一致する規則である。file:// は現行どおり実 stat(is_dir)。
//! pub fn uri_looks_like_dir(uri: &str) -> bool;
//!
//! // (2) 新規シーム: `vellis <uri>` / IPC OpenPath の開き先解決を一本化する。
//! //     main.rs の build_initial_args と ipc::handler::handle_open_path が
//! //     同じ規則を共有するための公開 API(issue #20 の同一規則要件)。
//! impl WindowArgs {
//!     /// - ディレクトリ URI → root=Some(uri)・initial_path=None
//!     /// - ファイル URI     → initial_path=Some(uri)・root=None
//!     ///   (root は init_window が親ディレクトリから導出する=現行経路)
//!     /// 判定は uri_looks_like_dir。サイドバー系フラグは false で返し、
//!     /// 呼び出し側が上書きする。
//!     pub fn for_open_target(uri: &str) -> WindowArgs;
//! }
//! ```
//!
//! ## reviewer 照合に委ねる項目(AppHandle 依存で機械判定不能な配線)
//! - `main.rs::build_initial_args` と `ipc::handler::handle_open_path` がともに
//!   `WindowArgs::for_open_target`(同一規則)を経由すること
//! - `handle_open_path` の `record_root` 呼び出しがディレクトリ分岐のみに残ること
//!   (ファイル URI を履歴に渡さない)
//! - ファイル直指定時の履歴は `init_window` が親導出済み root(`root_uri.raw`)で
//!   `record_root` すること(本ファイルのテスト 11 が親導出の値を固定する)

use std::fs;

use tempfile::TempDir;

use vellis_lib::fs::uri::Uri;
use vellis_lib::window::manager::{uri_looks_like_dir, WindowArgs};

// ---------------------------------------------------------------------------
// A. リモート URI の拡張子ヒューリスティック(uri_looks_like_dir)
// ---------------------------------------------------------------------------

/// 1. 拡張子付きの ssh パスはファイル判定(md 系限定の撤廃=本要件の核)。
#[test]
fn remote_file_with_extension_is_file() {
    for uri in [
        "ssh://host/notes.txt",
        "ssh://alice@host.example.com:2222/docs/report.pdf",
        "ssh://host/data/table.csv",
        "ssh://host/archive.tar.gz",
    ] {
        assert!(
            !uri_looks_like_dir(uri),
            "{uri}: an extension in the final segment must mean file, \
             not just md/markdown/mdx"
        );
    }
}

/// 2. Markdown 系拡張子は引き続きファイル判定(一般化で退行しない)。
#[test]
fn remote_markdown_extensions_remain_files() {
    for uri in [
        "ssh://host/path/to/notes.md",
        "ssh://host/A.MARKDOWN",
        "ssh://host/a/b.mdx",
    ] {
        assert!(
            !uri_looks_like_dir(uri),
            "{uri}: markdown paths must remain file-classified"
        );
    }
}

/// 3. 拡張子なしの末尾セグメントはディレクトリ扱いのまま。
///    ホスト名や途中セグメントのドットは拡張子ではない。
#[test]
fn remote_path_without_extension_is_dir() {
    for uri in [
        "ssh://host/repo",
        "ssh://host.example.com/repo",           // ホストのドットは判定に関与しない
        "ssh://alice@host:2222/home/alice/notes",
        "ssh://host/release-1.2/notes",          // 途中セグメントのドットも無関係
    ] {
        assert!(
            uri_looks_like_dir(uri),
            "{uri}: no extension in the final segment must mean directory"
        );
    }
}

/// 4. 末尾スラッシュは常にディレクトリ扱いのまま(拡張子様の名前でも
///    スラッシュが勝つ=現行挙動の維持)。
#[test]
fn remote_trailing_slash_is_dir() {
    for uri in [
        "ssh://host/path/",
        "ssh://host/",
        "ssh://host/notes.md/", // 現行も dir(ends_with 判定に掛からない)— 維持する
    ] {
        assert!(
            uri_looks_like_dir(uri),
            "{uri}: a trailing slash must always mean directory"
        );
    }
}

/// 5. 先頭ドットのセグメント(隠しファイル名)は拡張子とみなさず
///    ディレクトリ扱い(契約の明示例: ssh://host/.bashrc)。
#[test]
fn remote_leading_dot_segment_is_dir() {
    for uri in ["ssh://host/.bashrc", "ssh://host/home/user/.vimrc"] {
        assert!(
            uri_looks_like_dir(uri),
            "{uri}: a leading dot alone is not an extension → directory"
        );
    }
}

/// 6. セグメント先頭以外のドットは拡張子(既知拡張子ホワイトリストに
///    逆戻りしない)。バージョン風の名前がファイル判定になるのは
///    本ヒューリスティックの受容済みトレードオフ(2026-08-04 由谷決定)。
///    `.env.local` は先頭ドット以外にもドットがあるためファイル
///    (Path::extension() の意味論と同じ)。
#[test]
fn remote_non_leading_dot_counts_as_extension() {
    for uri in ["ssh://host/release-2.0", "ssh://host/.env.local"] {
        assert!(
            !uri_looks_like_dir(uri),
            "{uri}: a non-leading dot in the final segment must mean file"
        );
    }
}

/// 7. local(file://)は実 stat 判定を現行維持 — 拡張子風の名前の
///    ディレクトリは dir、拡張子なしのファイルは file(ヒューリスティックを
///    file:// に適用してはならない)。
#[test]
fn local_stat_decides_regardless_of_extension_shape() {
    let tmp = TempDir::new().unwrap();

    // 拡張子っぽい名前の実ディレクトリ → stat が勝って dir。
    let dir_with_ext = tmp.path().join("notes.txt");
    fs::create_dir(&dir_with_ext).unwrap();
    assert!(
        uri_looks_like_dir(&format!("file://{}", dir_with_ext.display())),
        "a local directory named notes.txt must stay a directory (stat wins)"
    );

    // 拡張子なしの実ファイル → stat が勝って file。
    let file_no_ext = tmp.path().join("Makefile");
    fs::write(&file_no_ext, "all:\n").unwrap();
    assert!(
        !uri_looks_like_dir(&format!("file://{}", file_no_ext.display())),
        "a local file named Makefile must stay a file (stat wins)"
    );
}

// ---------------------------------------------------------------------------
// B. 開き先解決(WindowArgs::for_open_target)— ファイルとして開く/
//    ディレクトリとして開くの振り分け
// ---------------------------------------------------------------------------

/// 8. ssh のファイル直指定は initial_path として開く(root は持たない=
///    init_window が親から導出する)。履歴選択画面には落ちない。
#[test]
fn remote_file_target_resolves_to_initial_path() {
    let uri = "ssh://host/notes.txt";
    let args = WindowArgs::for_open_target(uri);
    assert_eq!(
        args.initial_path.as_deref(),
        Some(uri),
        "a remote file target must become the initial document"
    );
    assert!(
        args.root.is_none(),
        "root must be left for init_window to derive from the parent directory"
    );
    assert!(
        !args.needs_root_selection(),
        "an explicit file target must never fall back to the history picker"
    );
    assert!(
        !args.show_marks && !args.show_changed,
        "sidebar flags default to false (callers overlay them)"
    );
}

/// 9. 拡張子なし・末尾スラッシュの ssh パスはディレクトリとして root になる
///    (従来どおり)。
#[test]
fn remote_dir_target_resolves_to_root() {
    for uri in ["ssh://host/repo", "ssh://host/path/"] {
        let args = WindowArgs::for_open_target(uri);
        assert_eq!(
            args.root.as_deref(),
            Some(uri),
            "{uri}: a remote directory target must become the root"
        );
        assert!(
            args.initial_path.is_none(),
            "{uri}: a directory target has no initial document"
        );
    }
}

/// 10. local は実 stat で振り分け(現行維持): 実ファイル → initial_path・
///     実ディレクトリ → root。
#[test]
fn local_targets_resolve_via_stat() {
    let tmp = TempDir::new().unwrap();

    let file = tmp.path().join("memo.txt");
    fs::write(&file, "plain text").unwrap();
    let file_uri = format!("file://{}", file.display());
    let args = WindowArgs::for_open_target(&file_uri);
    assert_eq!(
        args.initial_path.as_deref(),
        Some(file_uri.as_str()),
        "a local file target must become the initial document"
    );
    assert!(args.root.is_none());

    let dir_uri = format!("file://{}", tmp.path().display());
    let args = WindowArgs::for_open_target(&dir_uri);
    assert_eq!(
        args.root.as_deref(),
        Some(dir_uri.as_str()),
        "a local directory target must become the root"
    );
    assert!(args.initial_path.is_none());
}

// ---------------------------------------------------------------------------
// C. 親ディレクトリ導出 — 「root=親・履歴には親を記録」の値の固定
//    (init_window は initial_path の Uri::parent() を root に採用し、
//     その root_uri.raw を record_root へ渡す=配線は reviewer 照合)
// ---------------------------------------------------------------------------

/// 11. ssh ファイル URI の親導出: authority(user/host/port)を保ったまま
///     親ディレクトリ URI になる。この raw 値が root であり履歴に記録される
///     文字列である(ファイル URI 自体は履歴に入らない)。
#[test]
fn remote_file_parent_is_the_directory_recorded_as_root() {
    let parent = Uri::parse("ssh://alice@host:2222/notes/readme.txt")
        .unwrap()
        .parent()
        .expect("a file URI must have a parent directory");
    assert_eq!(
        parent.raw, "ssh://alice@host:2222/notes",
        "root/history entry for a file target is its parent directory URI, \
         with user@host:port preserved"
    );

    // トップレベル直下のファイルはホスト直下がルートになる。
    let top = Uri::parse("ssh://host/notes.txt")
        .unwrap()
        .parent()
        .expect("a top-level file URI must still have a parent");
    assert_eq!(
        top.raw, "ssh://host/",
        "the parent of a top-level remote file is the host root directory"
    );
}
