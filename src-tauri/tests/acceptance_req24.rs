//! 要件#24 の受け入れテスト(requirements.md #24)— Rust 層
//!
//! 「3D モデル表示(要件#23)を 3Dconnexion SpaceMouse(6DoF)で操作できる
//!  (回転・パン・ズーム)」のうち、機械判定できる純粋部分:
//! ① HID レポートのパース(バイト列 → 6 軸値/ボタン)
//! ② デバイス列挙フィルタ(対象 VID/PID の判定)
//!
//! 背景(docs/3d-model-viewing.md §5・要件側で確定):
//! - WKWebView は WebHID 非対応 → Rust 側 raw HID 読み(`hidapi`)。
//!   3DxWare ドライバ不要で動く方式
//! - 対象機種は初回限定 = SpaceMouse Wireless(VID 0x256F / PID 0xC63A =
//!   Bluetooth。USB レシーバー接続も同系 VID のため VID 単位で対象とする)
//! - 3DxWare がインストール済みの環境ではバーチャルデバイス
//!   (PID 0xC671 / 0xC672)が同 VID で列挙される。これを誤って掴むと
//!   ドライバ出力と二重になるため**除外**する
//!
//! 判定範囲(本ファイル): レポートのデコードとデバイスフィルタの純関数のみ。
//! hidapi の常駐タスク・Tauri イベント emit・60Hz 間引きの配線は reviewer 照合。
//! 実機の操作感・3DxWare 併存時の排他挙動は人間ゲート。
//! 6 軸値 → CameraDelta の写像はフロント側
//! `src/lib/spacemouse.acceptance.test.ts` が判定する。
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```ignore
//! // 実装先: src-tauri/src/spacemouse.rs(lib.rs に pub mod spacemouse;)
//!
//! /// 1 HID レポートのデコード結果。軸値は生の i16(符号反転や正規化はしない
//! /// — 軸の向き・スケールの解釈はフロントの写像の持ち場)。
//! #[derive(Debug, Clone, Copy, PartialEq, Eq)]
//! pub enum SpaceMouseInput {
//!     /// report ID 1(データ 6 バイト): 並進 x/y/z(各 i16 LE)
//!     Translation { x: i16, y: i16, z: i16 },
//!     /// report ID 2(データ 6 バイト): 回転 rx/ry/rz(各 i16 LE)
//!     Rotation { rx: i16, ry: i16, rz: i16 },
//!     /// report ID 1(データ 12 バイト): 並進+回転の連結(新ファーム個体)
//!     SixAxis { x: i16, y: i16, z: i16, rx: i16, ry: i16, rz: i16 },
//!     /// report ID 3: ボタンビットマップ(LE・4 バイトまで・不足はゼロ拡張)
//!     Buttons { bits: u32 },
//! }
//!
//! /// `report` は hidapi の read が返す形 = 先頭バイトが report ID、以降がデータ。
//! /// 既知の (ID, データ長) 以外は None(短い・長い・未知 ID・空)。
//! pub fn parse_spacemouse_report(report: &[u8]) -> Option<SpaceMouseInput>;
//!
//! /// 列挙したデバイスを掴むかどうか。VID 0x256F(3Dconnexion)を対象とし、
//! /// 3DxWare のバーチャルデバイス PID 0xC671 / 0xC672 は除外する。
//! pub fn is_spacemouse_device(vendor_id: u16, product_id: u16) -> bool;
//! ```
//!
//! レポート形式の根拠(要件#24 台帳): 一般に report ID 1 = 並進(3×i16 LE)・
//! ID 2 = 回転(3×i16 LE)・新ファームは ID 1 に並進+回転 12 バイト連結の個体
//! あり・ID 3 = ボタン。

use vellis_lib::spacemouse::{is_spacemouse_device, parse_spacemouse_report, SpaceMouseInput};

/// i16 → LE 2 バイト。テスト側の期待値組み立て用。
fn le(v: i16) -> [u8; 2] {
    v.to_le_bytes()
}

/// report ID + 各軸値からレポートのバイト列を組む。
fn report(id: u8, axes: &[i16]) -> Vec<u8> {
    let mut buf = vec![id];
    for &v in axes {
        buf.extend_from_slice(&le(v));
    }
    buf
}

// ---------------------------------------------------------------------------
// ① パース: 既知レポートのデコード
// ---------------------------------------------------------------------------

#[test]
fn id1_6bytes_decodes_translation_le() {
    // 正・負・ゼロの混在。i16 LE の素通し(符号反転しない)を固定する。
    let r = report(1, &[100, -200, 0]);
    assert_eq!(
        parse_spacemouse_report(&r),
        Some(SpaceMouseInput::Translation { x: 100, y: -200, z: 0 })
    );
}

#[test]
fn id2_6bytes_decodes_rotation_le() {
    let r = report(2, &[-1, 350, -350]);
    assert_eq!(
        parse_spacemouse_report(&r),
        Some(SpaceMouseInput::Rotation { rx: -1, ry: 350, rz: -350 })
    );
}

#[test]
fn id1_12bytes_decodes_six_axis_concatenation() {
    // 新ファーム個体: ID 1 に並進 6 バイト+回転 6 バイトの連結。
    let r = report(1, &[10, -20, 30, -40, 50, -60]);
    assert_eq!(
        parse_spacemouse_report(&r),
        Some(SpaceMouseInput::SixAxis { x: 10, y: -20, z: 30, rx: -40, ry: 50, rz: -60 })
    );
}

#[test]
fn negative_i16_le_boundaries() {
    // 0xFFFF = -1・0x8000 = i16::MIN・0x7FFF = i16::MAX。バイト直書きで
    // エンディアンの取り違えを検出する(BE 読みだと -1 以外は別値になる)。
    let r = [1u8, 0xFF, 0xFF, 0x00, 0x80, 0xFF, 0x7F];
    assert_eq!(
        parse_spacemouse_report(&r),
        Some(SpaceMouseInput::Translation { x: -1, y: i16::MIN, z: i16::MAX })
    );
}

#[test]
fn id3_buttons_2bytes_zero_extended_le() {
    // SpaceMouse Wireless のボタンは 2 バイトで来る。LE でゼロ拡張。
    let r = [3u8, 0x05, 0x01];
    assert_eq!(
        parse_spacemouse_report(&r),
        Some(SpaceMouseInput::Buttons { bits: 0x0105 })
    );
}

#[test]
fn id3_buttons_4bytes_full_width() {
    let r = [3u8, 0x01, 0x02, 0x03, 0x04];
    assert_eq!(
        parse_spacemouse_report(&r),
        Some(SpaceMouseInput::Buttons { bits: 0x0403_0201 })
    );
}

#[test]
fn id3_all_released_is_zero_bits() {
    // 全ボタン解放([3, 0, 0])は「意味のある入力」= Some(bits: 0)。
    let r = [3u8, 0x00, 0x00];
    assert_eq!(parse_spacemouse_report(&r), Some(SpaceMouseInput::Buttons { bits: 0 }));
}

// ---------------------------------------------------------------------------
// ① パース: 異常系(短い・長い・未知 ID・空)
// ---------------------------------------------------------------------------

#[test]
fn empty_report_is_none() {
    assert_eq!(parse_spacemouse_report(&[]), None);
}

#[test]
fn unknown_report_id_is_none() {
    // ID 0 と適当な未知 ID。データ長が正しくても掴まない。
    assert_eq!(parse_spacemouse_report(&report(0, &[1, 2, 3])), None);
    assert_eq!(parse_spacemouse_report(&report(0x17, &[1, 2, 3])), None);
}

#[test]
fn id1_wrong_lengths_are_none() {
    // 6 でも 12 でもないデータ長は不完全なレポートとして捨てる
    // (途中で切れた読みを半端に解釈して軸値が化けるのを防ぐ)。
    for len in [0usize, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 13, 14] {
        let mut r = vec![1u8];
        r.extend(std::iter::repeat(0u8).take(len));
        assert_eq!(parse_spacemouse_report(&r), None, "ID1 データ長 {len} は None のはず");
    }
}

#[test]
fn id2_wrong_lengths_are_none() {
    for len in [0usize, 1, 5, 7, 12] {
        let mut r = vec![2u8];
        r.extend(std::iter::repeat(0u8).take(len));
        assert_eq!(parse_spacemouse_report(&r), None, "ID2 データ長 {len} は None のはず");
    }
}

#[test]
fn id3_without_data_is_none() {
    // ID だけでデータ 0 バイトは不完全。
    assert_eq!(parse_spacemouse_report(&[3u8]), None);
}

#[test]
fn parse_is_deterministic() {
    let r = report(1, &[7, -7, 77]);
    assert_eq!(parse_spacemouse_report(&r), parse_spacemouse_report(&r));
}

// ---------------------------------------------------------------------------
// ② デバイス列挙フィルタ
// ---------------------------------------------------------------------------

#[test]
fn accepts_spacemouse_wireless_bluetooth() {
    // 実機検出値(2026-08-19 由谷回答): Bluetooth 接続 VID 0x256F / PID 0xC63A。
    assert!(is_spacemouse_device(0x256F, 0xC63A));
}

#[test]
fn accepts_same_vendor_usb_receiver_pids() {
    // USB レシーバー接続も同系として対象 = VID 0x256F は PID を問わず掴む
    // (バーチャルデバイスを除く)。代表として Universal Receiver 0xC652。
    assert!(is_spacemouse_device(0x256F, 0xC652));
}

#[test]
fn rejects_3dxware_virtual_devices() {
    // 3DxWare のバーチャルデバイス。掴むとドライバ出力と二重になる。
    assert!(!is_spacemouse_device(0x256F, 0xC671));
    assert!(!is_spacemouse_device(0x256F, 0xC672));
}

#[test]
fn rejects_other_vendors() {
    // 旧 3Dconnexion(Logitech VID 0x046D)機は今回のスコープ外。
    assert!(!is_spacemouse_device(0x046D, 0xC626));
    assert!(!is_spacemouse_device(0x1234, 0xC63A));
    assert!(!is_spacemouse_device(0x0000, 0x0000));
}
