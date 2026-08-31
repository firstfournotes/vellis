//! 要件#36 の受け入れテスト(requirements.md #36)— Rust 層
//!
//! 「テキスト系ビューアの表示を拡大縮小できるズーム機能(⌘+ / ⌘− / ⌘0)」
//!
//! 契約(2026-08-30 由谷決定=Q2〜Q4・コードレビュー15件反映の改稿):
//! - ② 操作= View メニューに Zoom In / Zoom Out / Actual Size の3項目
//!   (英語ラベル=要件#35 と整合)。アクセラレータは Zoom In=CmdOrCtrl+= /
//!   Zoom Out=CmdOrCtrl+- / Actual Size=CmdOrCtrl+0。
//!   **「CmdOrCtrl+Plus」は muda 0.17 が解析不能で tauri が黙って捨てるため使用禁止**。
//!   メニュー→フォーカス中ウィンドウ宛 emit(menu_open_* と同型=要件#33 の
//!   窓限定購読が前提)
//! - ⑤ Rust 側はメニュー項目+ emit のみ・依存追加なし(実行時依存のこと。
//!   下記のとおり muda は dev-dependency としてのみ宣言する)
//! - ⑧ 3項目は常時有効(グレーアウトしない)・非対象ビューアでは no-op。
//!   Actual Size は倍率リセット専用(ImageViewer の「実寸表示」トグルとは別概念)
//! - ⑩ 機械判定=メニュー定数+**アクセラレータ文字列の parse 妥当性
//!   (tauri の Accelerator 解析が Ok を返すこと)**
//!
//! 本ファイルの持ち場(Rust 層の機械判定):
//! - メニュー定数(項目 ID 3つ・イベント名3つ・アクセラレータ文字列3つ)の値固定
//! - アクセラレータ文字列の parse 妥当性: tauri はメニュー項目の accelerator を
//!   `s.parse::<muda::accelerator::Accelerator>().ok()` で解析し、**失敗を黙って
//!   捨てる**(tauri 2.10 `src/menu/normal.rs` — 項目からショートカットが消える
//!   だけでエラーにならない)。そのため「登録した文字列が実際に解析できること」
//!   自体を、tauri が委譲する当のパーサ(muda 0.17)で固定する
//! - 使用禁止形 "CmdOrCtrl+Plus" が解析不能であること(契約②の根拠の検証)と、
//!   menu.rs のコード行にその綴りが現れないことのソース走査
//! - View メニューの英語ラベル3つ("Zoom In" / "Zoom Out" / "Actual Size")が
//!   menu.rs のコード行(コメント除く)に文字列リテラルとして存在すること
//!
//! フロント側(倍率の状態遷移・保存/復元・対象ビューア判定・srcdoc への反映・
//! print.css のズーム無効化)は `src/lib/zoom.acceptance.test.ts` が判定する。
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```ignore
//! // src-tauri/src/menu.rs — 既存の項目 ID / イベント定数と同じ家風で export
//! pub const ZOOM_IN_ITEM_ID: &str = "zoom-in";
//! pub const ZOOM_OUT_ITEM_ID: &str = "zoom-out";
//! pub const ACTUAL_SIZE_ITEM_ID: &str = "actual-size";
//!
//! /// View メニューのクリックでフォーカス中ウィンドウへ emit するイベント名
//! /// (menu_open_* と同型・ペイロードなし)。Actual Size は「倍率リセット」の
//! /// 意味論なので menu_zoom_reset(ImageViewer の実寸トグルとは別概念=契約⑧)。
//! /// フロント側 src/lib/zoom.ts の同名定数と同じリテラルであることが両側の
//! /// テストで固定される(要件#34 の家風)。
//! pub const MENU_ZOOM_IN_EVENT: &str = "menu_zoom_in";
//! pub const MENU_ZOOM_OUT_EVENT: &str = "menu_zoom_out";
//! pub const MENU_ZOOM_RESET_EVENT: &str = "menu_zoom_reset";
//!
//! /// MenuItem::with_id の accelerator にこの定数を渡す(インラインリテラルに
//! /// しない — 値の固定と parse 妥当性の判定がこの定数を参照するため)。
//! pub const ZOOM_IN_ACCELERATOR: &str = "CmdOrCtrl+=";
//! pub const ZOOM_OUT_ACCELERATOR: &str = "CmdOrCtrl+-";
//! pub const ACTUAL_SIZE_ACCELERATOR: &str = "CmdOrCtrl+0";
//! ```
//!
//! ## reviewer 照合に委ねる項目(AppHandle 依存で機械判定不能な配線)
//! - View メニューに3項目が存在し(既存 Toggle Developer Tools と同居)、
//!   ラベル・ID・アクセラレータ定数が同じ MenuItem::with_id に束ねられていること
//! - 3項目とも enabled=true 固定(常時有効=契約⑧。グレーアウトさせる分岐がないこと)
//! - クリックで handle_menu_open_click と同型にフォーカス中ウィンドウへ
//!   emit_to すること(フォーカス不明時は focused_or_first_window の先頭窓
//!   フォールバック=契約②)
//! - 物理 ⌘+(US 配列では Cmd+Shift+=)を拾う Shift 変種の追加登録は実装裁量
//!   (契約②。登録した場合もその文字列が解析可能であることは実装側の責任)
//!
//! ## 人間ゲート(acceptance/acceptance.md)
//! - 実機での ⌘+ / ⌘− / ⌘0 の発火・メニュー表示・非対象ビューアで no-op の体感

use std::str::FromStr;

use muda::accelerator::Accelerator;
use vellis_lib::menu::{
    ACTUAL_SIZE_ACCELERATOR, ACTUAL_SIZE_ITEM_ID, MENU_ZOOM_IN_EVENT, MENU_ZOOM_OUT_EVENT,
    MENU_ZOOM_RESET_EVENT, ZOOM_IN_ACCELERATOR, ZOOM_IN_ITEM_ID, ZOOM_OUT_ACCELERATOR,
    ZOOM_OUT_ITEM_ID,
};

// ---------------------------------------------------------------------------
// メニュー定数 — 項目 ID とイベント名の値固定
// ---------------------------------------------------------------------------

/// 1. 項目 ID は kebab-case で固定(new-window / duplicate-window / open-file と
///    同じ家風)。
#[test]
fn zoom_menu_item_ids_are_fixed() {
    assert_eq!(ZOOM_IN_ITEM_ID, "zoom-in");
    assert_eq!(ZOOM_OUT_ITEM_ID, "zoom-out");
    assert_eq!(ACTUAL_SIZE_ITEM_ID, "actual-size");
}

/// 2. Webview への通知イベント名は menu_open_* と同じ snake_case の menu_* 固定。
///    Actual Size のイベントが menu_zoom_reset なのは「倍率リセット専用」の
///    意味論(契約⑧= ImageViewer の実寸表示トグルとは別概念)を名前に出すため。
///    フロント src/lib/zoom.ts 側の同名定数と同じリテラルであることが両側の
///    テストで固定される(要件#34 の家風)。
#[test]
fn zoom_menu_event_names_are_fixed() {
    assert_eq!(MENU_ZOOM_IN_EVENT, "menu_zoom_in");
    assert_eq!(MENU_ZOOM_OUT_EVENT, "menu_zoom_out");
    assert_eq!(MENU_ZOOM_RESET_EVENT, "menu_zoom_reset");
}

// ---------------------------------------------------------------------------
// アクセラレータ — 文字列の値固定と parse 妥当性(契約②⑩)
// ---------------------------------------------------------------------------

/// 3. アクセラレータ文字列の値固定。Zoom In は "CmdOrCtrl+=" —
///    「CmdOrCtrl+Plus」は使用禁止(契約②: muda 0.17 が解析不能で tauri が
///    黙って捨てるため)。
#[test]
fn zoom_accelerator_strings_are_fixed() {
    assert_eq!(ZOOM_IN_ACCELERATOR, "CmdOrCtrl+=");
    assert_eq!(ZOOM_OUT_ACCELERATOR, "CmdOrCtrl+-");
    assert_eq!(ACTUAL_SIZE_ACCELERATOR, "CmdOrCtrl+0");
}

/// 4. parse 妥当性(契約⑩): 3定数すべて tauri の Accelerator 解析が Ok を返す。
///    tauri 2 はメニュー項目の accelerator を
///    `s.parse::<muda::accelerator::Accelerator>().ok()` で解析して失敗を黙って
///    捨てるため、この Ok こそが「ショートカットが実際に登録される」ことの
///    機械判定点になる(判定には tauri が委譲する当のパーサ= muda 0.17 を使う)。
#[test]
fn zoom_accelerators_parse_as_tauri_accelerators() {
    for accel in [
        ZOOM_IN_ACCELERATOR,
        ZOOM_OUT_ACCELERATOR,
        ACTUAL_SIZE_ACCELERATOR,
    ] {
        assert!(
            Accelerator::from_str(accel).is_ok(),
            "accelerator '{}' must parse — tauri silently drops unparsable ones",
            accel
        );
    }
}

/// 5. 契約②の根拠の検証: 使用禁止形 "CmdOrCtrl+Plus" は muda 0.17 で解析不能
///    (parse_key に "PLUS" が無い)。これが Ok になったら muda 側の仕様が
///    変わったということなので、契約②の禁止根拠ごと要件側で見直す。
#[test]
fn banned_plus_spelling_does_not_parse() {
    assert!(
        Accelerator::from_str("CmdOrCtrl+Plus").is_err(),
        "muda 0.17 must reject 'CmdOrCtrl+Plus' — the very reason the spelling is banned"
    );
}

// ---------------------------------------------------------------------------
// menu.rs のソース走査 — 英語ラベルの存在と禁止綴りの不在
// ---------------------------------------------------------------------------

/// 行ごとに最初の `//` 以降(コメント)を落としたコード部分を連結して返す
/// (acceptance_req35 の走査と同じ流儀。文字列リテラル中の `//` も切り落とすが、
/// それは検知を緩める方向にしか働かない)。
fn menu_rs_code() -> String {
    include_str!("../src/menu.rs")
        .lines()
        .map(|line| line.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

/// 6. View メニュー3項目の英語ラベル(契約②=要件#35 と整合)が menu.rs の
///    コード行に文字列リテラルとして存在する。どの項目にどのラベルが付くかの
///    束ね(ID・アクセラレータとの対応)は reviewer 照合。
#[test]
fn menu_rs_declares_english_zoom_labels() {
    let code = menu_rs_code();
    for label in ["\"Zoom In\"", "\"Zoom Out\"", "\"Actual Size\""] {
        assert!(
            code.contains(label),
            "menu.rs must carry the literal {} for the View menu (contract ②)",
            label
        );
    }
}

/// 7. 使用禁止の綴り "CmdOrCtrl+Plus" が menu.rs のコード行に現れない(契約②)。
///    コメントで禁止の経緯に触れるのは自由(コード部分のみ走査する)。
#[test]
fn menu_rs_never_uses_the_banned_plus_spelling() {
    assert!(
        !menu_rs_code().contains("CmdOrCtrl+Plus"),
        "'CmdOrCtrl+Plus' is banned — muda 0.17 cannot parse it and tauri drops it silently"
    );
}
