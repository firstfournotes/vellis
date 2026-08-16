//! 要件#17 の受け入れテスト(requirements.md #17)— Rust 層
//!
//! 「メニューの Window に開いているウィンドウの一覧を表示し、選択でそのウィンドウへ
//! 切り替えられる(macOS 標準の Window メニュー挙動=現在ウィンドウにチェックマーク)」
//!
//! 契約(2026-08-16 由谷決定):
//! - ① 既存 Window メニュー(src-tauri/src/menu.rs の Minimize/Close Window)に
//!   `Submenu::set_as_windows_menu_for_nsapp()` を適用(`app.set_menu` の後に呼ぶ)。
//!   一覧・チェックマーク・切替は macOS の自動管理(手動のメニュー項目管理はしない)。
//!   API は `#[cfg(target_os = "macos")]`
//! - ② 一覧の項目名=ウィンドウタイトルのため、固定 "vellis" を root フォルダ名へ
//!   変更する。導出= root URI の末尾フォルダ名(ssh リモートも同様=リモートパスの
//!   末尾フォルダ名)。root 未設定(履歴選択画面)= "vellis"。root 切替
//!   (Open Folder / 履歴選択 / ファイル Open の親切替=要件#11)で追従する。
//!   末尾フォルダ名が空になる場合(`/` 直下等)の表示は実装裁量(空文字にしない)
//! - ③ タイトル設定箇所は src-tauri/src/commands/window.rs と
//!   src-tauri/src/ipc/handler.rs の 2 箇所+ set_root 時の追従
//! - ④ 依存追加なし
//!
//! 判定範囲(本ファイル): **タイトル導出の純関数のみ**。実ウィンドウの
//! タイトル設定・set_as_windows_menu_for_nsapp の配線は AppHandle と実ウィンドウを
//! 要するため機械判定できない。
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```ignore
//! // 実装先: src-tauri/src/window/title.rs(lib.rs から window_title として
//! // 公開するか window::title として公開するかは実装裁量 — 本テストは
//! // `vellis_lib::window_title::derive_window_title` で解決できること)
//! /// root URI(またはローカルパス)からウィンドウタイトルを導出する。
//! /// - None(root 未設定=履歴選択画面)→ "vellis"
//! /// - それ以外 → root の末尾フォルダ名(local / ssh とも同じ規則)。
//! ///   末尾フォルダ名が空になる場合(`/` 直下・パス空)の文言は実装裁量だが
//! ///   空文字を返してはならない。
//! pub fn derive_window_title(root: Option<&str>) -> String;
//! ```
//!
//! ## reviewer 照合に委ねる項目(実ウィンドウ・AppHandle 依存)
//! - menu.rs の Window サブメニューに `set_as_windows_menu_for_nsapp()` が
//!   `app.set_menu` の後・`#[cfg(target_os = "macos")]` 付きで適用されていること
//! - commands/window.rs・ipc/handler.rs の固定 `.title("vellis")` が本導出
//!   経由になっていること・set_root(要件#11 の親切替含む)でタイトルが追従すること
//! - 手動のウィンドウ一覧メニュー項目管理をしていないこと(macOS 自動管理)
//!
//! ## 人間ゲート(gate)
//! - Window メニューに実際に一覧が出て、選択で切り替わり、現在ウィンドウに
//!   チェックマークが付くこと(macOS の実メニュー表示は機械テストのスコープ外)

use vellis_lib::window_title::derive_window_title;

/// 1. root 未設定(履歴選択画面)= 従来どおり "vellis"。
#[test]
fn no_root_falls_back_to_vellis() {
    assert_eq!(
        derive_window_title(None),
        "vellis",
        "a window without a root (history picker) must keep the app-name title"
    );
}

/// 2. local root(素のパス形)→ 末尾フォルダ名。
#[test]
fn local_root_yields_last_folder_name() {
    assert_eq!(
        derive_window_title(Some("/Users/x/projects/product-vellis")),
        "product-vellis",
        "the title must be the last folder name of the local root"
    );
}

/// 3. 末尾スラッシュ付き local root も同じフォルダ名(表記ゆれで変わらない)。
#[test]
fn trailing_slash_local_root_yields_same_name() {
    assert_eq!(
        derive_window_title(Some("/Users/x/projects/product-vellis/")),
        "product-vellis",
        "a trailing slash must not change the derived title"
    );
}

/// 4. file:// URI 形の local root(set_root / IPC が実際に持ち回る Uri.raw の形)
///    でも同じ末尾フォルダ名になる。
#[test]
fn file_uri_root_yields_last_folder_name() {
    assert_eq!(
        derive_window_title(Some("file:///Users/x/projects/product-vellis")),
        "product-vellis",
        "the file:// spelling of the same root must derive the same title"
    );
}

/// 5. ssh リモート root → リモートパスの末尾フォルダ名(local と同じ規則)。
#[test]
fn ssh_root_yields_last_remote_folder_name() {
    assert_eq!(
        derive_window_title(Some("ssh://host/home/user/notes")),
        "notes",
        "an ssh root must use the last folder name of the remote path"
    );
}

/// 6. ssh リモートの末尾スラッシュも同じフォルダ名。user/port 付き authority は
///    タイトルに漏れない。
#[test]
fn trailing_slash_ssh_root_yields_same_name() {
    assert_eq!(
        derive_window_title(Some("ssh://host/home/user/notes/")),
        "notes",
        "a trailing slash on an ssh root must not change the derived title"
    );
    assert_eq!(
        derive_window_title(Some("ssh://user@host:2222/home/user/notes")),
        "notes",
        "user/port in the authority must not leak into the title"
    );
}

/// 7. `/` 直下(末尾フォルダ名が空になる境界): 具体的な文言は実装裁量だが、
///    空文字のタイトルにはしない。
#[test]
fn filesystem_root_is_never_an_empty_title() {
    assert!(
        !derive_window_title(Some("/")).is_empty(),
        "a root of '/' has no folder name — the title may be anything but empty"
    );
    assert!(
        !derive_window_title(Some("file:///")).is_empty(),
        "the file:// spelling of '/' must not yield an empty title either"
    );
}

/// 8. パス空の `scheme://host/`(ホスト直下)も空文字にしない。
#[test]
fn host_root_is_never_an_empty_title() {
    assert!(
        !derive_window_title(Some("ssh://host/")).is_empty(),
        "an ssh host root has no folder name — the title may be anything but empty"
    );
}

/// 9. ドットを含む通常フォルダ名は拡張子扱いで削らず、そのまま使う。
#[test]
fn dotted_folder_name_is_kept_verbatim() {
    assert_eq!(
        derive_window_title(Some("/a/b/notes.d")),
        "notes.d",
        "a folder name containing a dot must be used verbatim (no extension stripping)"
    );
}
