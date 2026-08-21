//! 要件#25 の受け入れテスト(requirements.md #25)— Rust 層
//!
//! 「3DxWare(公式ドライバ)常駐環境でも SpaceMouse で 3D モデルを操作できる
//!  (公式 3DconnexionClient framework 経由)」のうち、機械判定できる純粋部分:
//! ① ConnexionDeviceState 構造のメモリレイアウト(framework Headers に一致)
//! ② ConnexionClientAPI の定数(メッセージ種別・コマンド種別)
//! ③ DeviceState → SpaceMouseAxes 変換の純関数(コマンド選別+6軸の写像)
//! ④ 入力ソース選択の純関数(SDK 優先・raw フォールバック・二重読みしない)
//!
//! 背景(docs/3d-model-viewing.md §7.5・要件側で確定):
//! - 3DxWare 常駐環境ではドライバがデバイスを完全占有し raw HID(要件#24)は
//!   読めない → 公式 3DconnexionClient framework 経由で受信する
//! - framework は実行時ロード(dlopen 弱リンク・同梱しない)。不在環境では
//!   要件#24 の raw HID にフォールバックし、起動には影響させない
//! - 受信した 6軸は既存の `spacemouse_input` イベント(60Hz 間引き・変化時のみ)
//!   へ**同じ形(= 既存 `SpaceMouseAxes` 型)で合流**する。フロント
//!   (spaceMouseToCameraDelta・ModelViewer)は無変更
//!
//! 判定範囲(本ファイル): 上記①〜④の純粋部分のみ。以下はテスト不能につき
//! reviewer 照合とする — dlopen/dlsym による framework の実ロード・
//! SetConnexionHandlers/RegisterConnexionClient の呼び出し配線・コールバック
//! スレッドから emit までの経路・60Hz 間引きの共有。実機で動くこと
//! (3DxWare 常駐下での操作)は人間ゲート。
//!
//! 軸の並び・符号は raw HID(要件#24)と同一を既定とする(SDK の axis[6] は
//! Headers 記載どおり x, y, z, rx, ry, rz)。実機で符号が逆と判明した場合は
//! 要件側で仕様を直してから本テストを更新する(要件#24 と同じ運用)。
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```ignore
//! // 実装先: src-tauri/src/spacemouse.rs 配下(サブモジュール sdk)
//! //   lib.rs 側は既存の `pub mod spacemouse;` のまま
//! //   (spacemouse.rs 内に `pub mod sdk;` または inline module)
//!
//! // --- vellis_lib::spacemouse::sdk ---
//!
//! /// kConnexionMsgDeviceState('3dSR')。メッセージハンドラで
//! /// messageArgument を ConnexionDeviceState と解釈してよい messageType。
//! pub const MSG_DEVICE_STATE: u32 = 0x3364_5352;
//!
//! /// kConnexionCmdHandleAxis / kConnexionCmdHandleButtons。
//! pub const CMD_HANDLE_AXIS: u16 = 3;
//! pub const CMD_HANDLE_BUTTONS: u16 = 2;
//!
//! /// framework Headers の ConnexionDeviceState を写した FFI 構造体。
//! /// Headers は `#pragma pack(push,2)` なので `#[repr(C, packed(2))]`。
//! /// Headers の union { buttons8, appEventPressed } は同幅 u16 のため
//! /// buttons8 に平坦化する(バイナリ互換)。
//! #[repr(C, packed(2))]
//! #[derive(Clone, Copy)]
//! pub struct ConnexionDeviceState {
//!     pub version: u16,
//!     pub client: u16,
//!     pub command: u16,
//!     pub param: i16,
//!     pub value: i32,
//!     pub time: u64,
//!     pub report: [u8; 8],
//!     pub buttons8: u16,
//!     pub axis: [i16; 6], // x, y, z, rx, ry, rz
//!     pub address: u16,
//!     pub buttons: u32,
//! }
//!
//! /// DeviceState 1 件を 6 軸の状態へ。command が kConnexionCmdHandleAxis の
//! /// ときだけ Some(axis を tx,ty,tz,rx,ry,rz へ素通しで写像)。ボタンほか
//! /// 軸以外のコマンドは None(カメラ操作に混ぜない — raw 側の Buttons を
//! /// 状態に混ぜない扱いと同じ)。
//! pub fn device_state_axes(state: &ConnexionDeviceState) -> Option<SpaceMouseAxes>;
//!
//! // --- vellis_lib::spacemouse(ソース選択・SDK/raw 横断なので親モジュール)---
//!
//! /// 入力ソースの選択結果。二重読みは構造上あり得ない(1 変種のみ返る)。
//! #[derive(Debug, Clone, Copy, PartialEq, Eq)]
//! pub enum SpaceMouseSource {
//!     /// 3DconnexionClient framework 経由(3DxWare 常駐環境)
//!     Sdk,
//!     /// 要件#24 の raw HID 読み(ドライバ不在環境)
//!     RawHid,
//!     /// どちらも使えない(SpaceMouse 入力なし。アプリは通常起動)
//!     Disabled,
//! }
//!
//! /// 起動時のソース一点決め。SDK が使えれば SDK・だめなら raw・両方不能なら
//! /// 無効。`sdk_available` = framework のロード+ハンドラ設置に成功したか、
//! /// `raw_available` = raw HID 経路を開始できるか。
//! pub fn select_source(sdk_available: bool, raw_available: bool) -> SpaceMouseSource;
//! ```
//!
//! レイアウト・定数の根拠: 実機の
//! /Library/Frameworks/3DconnexionClient.framework/Headers/ConnexionClient.h
//! (pack(2)・axis は「x, y, z, rx, ry, rz」・kConnexionMsgDeviceState =
//! 0x33645352・kConnexionCmdHandleAxis = 3・kConnexionCmdHandleButtons = 2)。

use std::mem::{offset_of, size_of};

use vellis_lib::spacemouse::sdk::{
    device_state_axes, ConnexionDeviceState, CMD_HANDLE_AXIS, CMD_HANDLE_BUTTONS,
    MSG_DEVICE_STATE,
};
use vellis_lib::spacemouse::{
    parse_spacemouse_report, select_source, SpaceMouseAxes, SpaceMouseInput, SpaceMouseSource,
};

/// command と axis だけ指定して DeviceState を組む(他フィールドはゼロ)。
/// コールバックで受ける実データの最小形。
fn state(command: u16, axis: [i16; 6]) -> ConnexionDeviceState {
    ConnexionDeviceState {
        version: 0x6D33, // kConnexionDeviceStateVers 'm3'
        client: 0,
        command,
        param: 0,
        value: 0,
        time: 0,
        report: [0; 8],
        buttons8: 0,
        axis,
        address: 0,
        buttons: 0,
    }
}

// ---------------------------------------------------------------------------
// ① ConnexionDeviceState のメモリレイアウト(Headers の pack(2) 構造に一致)
//
// コールバックの messageArgument はこの構造体へのポインタとして届く。
// レイアウトが 1 バイトでもずれると全フィールドが化けるので、サイズと
// 各オフセットを Headers の値で固定する。
// ---------------------------------------------------------------------------

#[test]
fn device_state_size_matches_header() {
    // pack(2) での合計: 2+2+2+2+4+8+8+2+12+2+4 = 48 バイト
    // (= 実機 Headers の kConnexionDeviceStateSize)。
    assert_eq!(size_of::<ConnexionDeviceState>(), 48);
}

#[test]
fn device_state_field_offsets_match_header() {
    assert_eq!(offset_of!(ConnexionDeviceState, version), 0);
    assert_eq!(offset_of!(ConnexionDeviceState, client), 2);
    assert_eq!(offset_of!(ConnexionDeviceState, command), 4);
    assert_eq!(offset_of!(ConnexionDeviceState, param), 6);
    assert_eq!(offset_of!(ConnexionDeviceState, value), 8);
    assert_eq!(offset_of!(ConnexionDeviceState, time), 12);
    assert_eq!(offset_of!(ConnexionDeviceState, report), 20);
    assert_eq!(offset_of!(ConnexionDeviceState, buttons8), 28);
    assert_eq!(offset_of!(ConnexionDeviceState, axis), 30);
    assert_eq!(offset_of!(ConnexionDeviceState, address), 42);
    assert_eq!(offset_of!(ConnexionDeviceState, buttons), 44);
}

// ---------------------------------------------------------------------------
// ② ConnexionClientAPI の定数(Headers に一致)
// ---------------------------------------------------------------------------

#[test]
fn sdk_constants_match_header() {
    // kConnexionMsgDeviceState = 0x33645352('3dSR')・
    // kConnexionCmdHandleAxis = 3・kConnexionCmdHandleButtons = 2。
    assert_eq!(MSG_DEVICE_STATE, 0x3364_5352);
    assert_eq!(CMD_HANDLE_AXIS, 3);
    assert_eq!(CMD_HANDLE_BUTTONS, 2);
}

// ---------------------------------------------------------------------------
// ③ DeviceState → SpaceMouseAxes 変換(純関数)
// ---------------------------------------------------------------------------

#[test]
fn handle_axis_maps_six_axes_in_header_order() {
    // Headers の並び x,y,z,rx,ry,rz を tx,ty,tz,rx,ry,rz へ素通し
    // (符号反転・正規化はしない — 意味づけはフロントの写像の持ち場)。
    let s = state(CMD_HANDLE_AXIS, [1, 2, 3, 4, 5, 6]);
    assert_eq!(
        device_state_axes(&s),
        Some(SpaceMouseAxes { tx: 1, ty: 2, tz: 3, rx: 4, ry: 5, rz: 6 })
    );
}

#[test]
fn handle_axis_passes_signs_and_extremes_through() {
    let s = state(CMD_HANDLE_AXIS, [-350, 350, i16::MIN, i16::MAX, -1, 0]);
    assert_eq!(
        device_state_axes(&s),
        Some(SpaceMouseAxes {
            tx: -350,
            ty: 350,
            tz: i16::MIN,
            rx: i16::MAX,
            ry: -1,
            rz: 0,
        })
    );
}

#[test]
fn handle_axis_all_zero_is_meaningful_rest_event() {
    // 全軸ゼロ(指を離した)は「意味のある入力」= Some。raw 側と同様、
    // 間引き層の「変化時のみ送る」がこのゼロを 1 回だけフロントへ届ける。
    let s = state(CMD_HANDLE_AXIS, [0; 6]);
    assert_eq!(device_state_axes(&s), Some(SpaceMouseAxes::default()));
}

#[test]
fn handle_buttons_does_not_produce_axes() {
    // ボタンはカメラ操作(回転・パン・ズーム)に効かせない
    // — raw 側で Buttons を軸状態に混ぜない扱いと一致させる。
    let s = state(CMD_HANDLE_BUTTONS, [1, 2, 3, 4, 5, 6]);
    assert_eq!(device_state_axes(&s), None);
}

#[test]
fn non_axis_commands_do_not_produce_axes() {
    // kConnexionCmdNone=0 / HandleRawData=1 / AppSpecific=10 / AppEvent=11 /
    // AppSynced=20。軸コマンド以外は axis フィールドに値が残っていても捨てる。
    for cmd in [0u16, 1, 10, 11, 20] {
        let s = state(cmd, [7, 7, 7, 7, 7, 7]);
        assert_eq!(device_state_axes(&s), None, "command {cmd} は None のはず");
    }
}

#[test]
fn sdk_and_raw_sources_yield_identical_axes() {
    // 同じ物理入力なら SDK 経由でも raw HID 経由でも SpaceMouseAxes が
    // 一致する = フロントの写像(spaceMouseToCameraDelta)がソース非依存で
    // 同じ結果になる。raw の 6 軸連結レポート(ID1+12B)と突き合わせる。
    let values: [i16; 6] = [10, -20, 30, -40, 50, -60];

    let mut raw_report = vec![1u8];
    for v in values {
        raw_report.extend_from_slice(&v.to_le_bytes());
    }
    let raw = match parse_spacemouse_report(&raw_report) {
        Some(SpaceMouseInput::SixAxis { x, y, z, rx, ry, rz }) => {
            SpaceMouseAxes { tx: x, ty: y, tz: z, rx, ry, rz }
        }
        other => panic!("raw 側のパースが SixAxis でない: {other:?}"),
    };

    let sdk = device_state_axes(&state(CMD_HANDLE_AXIS, values));
    assert_eq!(sdk, Some(raw));
}

#[test]
fn device_state_axes_is_deterministic() {
    let s = state(CMD_HANDLE_AXIS, [7, -7, 77, -77, 777, -777]);
    assert_eq!(device_state_axes(&s), device_state_axes(&s));
}

// ---------------------------------------------------------------------------
// ④ 入力ソース選択(SDK 優先・raw フォールバック・両方不能なら無効)
// ---------------------------------------------------------------------------

#[test]
fn sdk_wins_when_available() {
    // 3DxWare 常駐環境: framework が使えるなら SDK。raw も開ける状況でも
    // SDK を選ぶ(戻りは 1 変種のみ = 二重読みは構造上起こらない)。
    assert_eq!(select_source(true, true), SpaceMouseSource::Sdk);
    assert_eq!(select_source(true, false), SpaceMouseSource::Sdk);
}

#[test]
fn falls_back_to_raw_hid_without_sdk() {
    // framework 不在(ドライバなし)環境 = 要件#24 の raw HID へフォールバック。
    assert_eq!(select_source(false, true), SpaceMouseSource::RawHid);
}

#[test]
fn disabled_when_neither_source_works() {
    // 両方不能なら SpaceMouse 入力なし(アプリの起動・3D 表示には影響させない
    // — 起動可否そのものは reviewer 照合)。
    assert_eq!(select_source(false, false), SpaceMouseSource::Disabled);
}
