//! 要件#54 の受け入れテスト(docs/requirements/req-54.md)— Rust 層(AC-54-15)
//!
//! 「開いているファイル内の検索」の入口=Edit メニュー「Find…」(⌘F)。
//! Rust 側の変更は menu.rs の Edit メニュー1項目と定数だけで、検索そのものは
//! フロントで完結する(契約⑦)。acceptance_req35 / acceptance_req36 と同じ形で、
//! メニュー定数の値固定・アクセラレータの parse 妥当性・menu.rs のソース走査を行う。
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```ignore
//! // src-tauri/src/menu.rs — 既存の項目 ID / イベント定数と同じ家風で export
//! pub const FIND_ITEM_ID: &str = "find";
//!
//! /// Edit メニューの「Find…」クリックでフォーカス中ウィンドウへ emit する
//! /// イベント名(menu_edit / menu_save と同型・ペイロードなし)。フロント側
//! /// src/lib/find-in-document.ts の MENU_FIND_EVENT と同じリテラルであることが
//! /// 両側のテストで固定される(要件#34 の家風)。
//! pub const MENU_FIND_EVENT: &str = "menu_find";
//!
//! /// MenuItem::with_id の accelerator にこの定数を渡す(インラインリテラルに
//! /// しない — 値の固定と parse 妥当性の判定がこの定数を参照するため)。
//! pub const FIND_ACCELERATOR: &str = "CmdOrCtrl+F";
//! ```
//!
//! ## reviewer 照合に委ねる項目(AppHandle 依存で機械判定不能な配線)
//! - Edit メニューに「Find…」が1項目だけ足され、ラベル・ID・アクセラレータ定数が
//!   同じ MenuItem::with_id に束ねられていること(置き場は Edit メニュー=契約①)
//! - enabled=true 固定(Save / Edit と同じ「常時有効・非対象ウィンドウは no-op」)
//! - クリックで handle_menu_open_click と同型にフォーカス中ウィンドウへ emit_to
//!   すること
//! - Rust 側の変更が menu.rs の1項目と定数のみであること(契約⑦)
//!
//! ## 人間ゲート(acceptance/acceptance.md 要件#54)
//! - 実機での ⌘F の発火・メニュー表示・検索バーの見た目と体感

use std::str::FromStr;

use muda::accelerator::Accelerator;
use vellis_lib::menu::{FIND_ACCELERATOR, FIND_ITEM_ID, MENU_FIND_EVENT};

// ---------------------------------------------------------------------------
// メニュー定数 — 項目 ID・イベント名・アクセラレータの値固定(AC-54-15)
// ---------------------------------------------------------------------------

/// 1. 項目 ID は kebab-case で固定(save / edit / open-file と同じ家風)。
#[test]
fn find_menu_item_id_is_fixed() {
    assert_eq!(FIND_ITEM_ID, "find");
}

/// 2. Webview への通知イベント名は menu_edit / menu_save と同じ snake_case の
///    menu_* 固定。フロント src/lib/find-in-document.ts 側の MENU_FIND_EVENT と
///    同じリテラルであることが両側のテストで固定される。
#[test]
fn find_menu_event_name_is_fixed() {
    assert_eq!(MENU_FIND_EVENT, "menu_find");
}

/// 3. アクセラレータは ⌘F(macOS 標準の Find)。値固定。
#[test]
fn find_accelerator_string_is_fixed() {
    assert_eq!(FIND_ACCELERATOR, "CmdOrCtrl+F");
}

/// 4. parse 妥当性(acceptance_req36 の家風): tauri 2 はメニュー項目の
///    accelerator を `s.parse::<muda::accelerator::Accelerator>().ok()` で解析して
///    失敗を黙って捨てるため、この Ok こそが「⌘F が実際に登録される」ことの
///    機械判定点になる。
#[test]
fn find_accelerator_parses_as_tauri_accelerator() {
    assert!(
        Accelerator::from_str(FIND_ACCELERATOR).is_ok(),
        "accelerator '{}' must parse — tauri silently drops unparsable ones",
        FIND_ACCELERATOR
    );
}

// ---------------------------------------------------------------------------
// menu.rs のソース走査 — ラベルと定数の使用(acceptance_req35/36 の家風)
// ---------------------------------------------------------------------------

/// 行ごとに最初の `//` 以降(コメント)を落としたコード部分を連結して返す
/// (acceptance_req35 / req36 の走査と同じ流儀)。
fn menu_rs_code() -> String {
    include_str!("../src/menu.rs")
        .lines()
        .map(|line| line.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

/// 5. 「Find…」の英語ラベル(Open… / Print… と同じ三点リーダ付き)が menu.rs の
///    コード行に文字列リテラルとして存在する。Edit メニューへの束ね(ID・
///    アクセラレータとの対応)は reviewer 照合。
#[test]
fn menu_rs_declares_english_find_label() {
    assert!(
        menu_rs_code().contains("\"Find…\""),
        "menu.rs must carry the literal \"Find…\" for the Edit menu (契約①)"
    );
}

/// 6. 項目 ID とアクセラレータの定数がインラインリテラルではなく実際に使われて
///    いる(宣言+ MenuItem::with_id への使用で2回以上現れる)。値の固定と parse
///    妥当性の判定が menu.rs の登録と同じ文字列を見ていることの担保(req36 で
///    ZOOM_IN_ACCELERATOR を定数渡しにしたのと同じ理由)。
#[test]
fn menu_rs_uses_find_constants() {
    let code = menu_rs_code();
    for name in ["FIND_ITEM_ID", "FIND_ACCELERATOR"] {
        let count = code.matches(name).count();
        assert!(
            count >= 2,
            "menu.rs must declare AND use {} (found {} occurrence(s))",
            name,
            count
        );
    }
}

/// 7. クリック→ emit の配線が MENU_FIND_EVENT 定数を参照している。既存の家風では
///    宣言が menu.rs・dispatch が lib.rs の match(MENU_EDIT_EVENT と同型)なので、
///    どちらに置いてもよいが、宣言(1回)以外に少なくとも1回の使用があること。
#[test]
fn find_event_constant_is_dispatched() {
    let combined = format!(
        "{}\n{}",
        menu_rs_code(),
        include_str!("../src/lib.rs")
            .lines()
            .map(|line| line.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let count = combined.matches("MENU_FIND_EVENT").count();
    assert!(
        count >= 2,
        "MENU_FIND_EVENT must be declared and dispatched (found {} occurrence(s) across menu.rs + lib.rs)",
        count
    );
}
