//! SpaceMouse(3Dconnexion 6DoF デバイス)の raw HID 読み(requirements.md #24)。
//!
//! WKWebView は WebHID を持たないので、デバイスは Rust 側で直接読む
//! (docs/3d-model-viewing.md §5 の経路②)。3DxWare ドライバに依存しないのが
//! この方式の利点で、代わりにレポート形式の解釈はこちらの持ち場になる。
//!
//! ここに置くのは3層:
//! - `parse_spacemouse_report` / `is_spacemouse_device`(純関数・受け入れ対象)
//! - `SpaceMouseAxes`(直近の並進+回転を合成した6軸の状態。イベントの積み荷)
//! - `spawn_reader`(常駐スレッド。デバイス監視 → 読み → 60Hz 程度に間引いて emit)
//!
//! 軸値は生の i16 のまま流す。符号の向き・デッドゾーン・感度といった
//! 「操作の意味づけ」はフロント(`src/lib/spacemouse.ts`)が一手に持ち、
//! カメラ VM への写像はマウスと同じ 1 本の経路に合流する。
//!
//! 3DxWare(公式ドライバ)が常駐している環境では raw HID を開けない
//! (ドライバがデバイスを占有する)。その環境向けの経路が [`sdk`] で、
//! どちらを使うかは起動時に [`select_source`] が一点で決める。軸が
//! `SpaceMouseAxes` になった後の経路(間引き・emit・フロント)は共通。

pub mod sdk;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

/// 3Dconnexion のベンダ ID。対応機種(SpaceMouse Wireless)はこの VID で出る。
const VENDOR_3DCONNEXION: u16 = 0x256F;

/// 3DxWare がインストールされた環境で同 VID に現れるバーチャルデバイス。
/// これを掴むとドライバの出力と二重になるので列挙から外す。
const VIRTUAL_DEVICE_PIDS: [u16; 2] = [0xC671, 0xC672];

/// フロントが listen するイベント名。積み荷は [`SpaceMouseAxes`]。
pub const SPACEMOUSE_EVENT: &str = "spacemouse_input";

/// 1 HID レポートのデコード結果。軸値は生の i16(符号反転や正規化はしない
/// — 軸の向き・スケールの解釈はフロントの写像の持ち場)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpaceMouseInput {
    /// report ID 1(データ 6 バイト): 並進 x/y/z(各 i16 LE)
    Translation { x: i16, y: i16, z: i16 },
    /// report ID 2(データ 6 バイト): 回転 rx/ry/rz(各 i16 LE)
    Rotation { rx: i16, ry: i16, rz: i16 },
    /// report ID 1(データ 12 バイト): 並進+回転の連結(新ファーム個体)
    SixAxis {
        x: i16,
        y: i16,
        z: i16,
        rx: i16,
        ry: i16,
        rz: i16,
    },
    /// report ID 3: ボタンビットマップ(LE・4 バイトまで・不足はゼロ拡張)
    Buttons { bits: u32 },
}

/// フロントへ渡す 6 軸の状態。並進と回転が別レポートで届く機種があるため、
/// 直近に受けた両者を合成した「いまの倒し具合」を1つにまとめて送る。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct SpaceMouseAxes {
    pub tx: i16,
    pub ty: i16,
    pub tz: i16,
    pub rx: i16,
    pub ry: i16,
    pub rz: i16,
}

/// データ部の先頭から i16 LE を 3 つ読む。長さは呼び出し側で確定済み。
fn three_i16_le(data: &[u8]) -> (i16, i16, i16) {
    let at = |i: usize| i16::from_le_bytes([data[i * 2], data[i * 2 + 1]]);
    (at(0), at(1), at(2))
}

/// `report` は hidapi の read が返す形 = 先頭バイトが report ID、以降がデータ。
/// 既知の (ID, データ長) 以外は None(短い・長い・未知 ID・空)。
///
/// 長さが合わないレポートを捨てるのは、途中で切れた読みを半端に解釈して
/// 軸値が化けるより「1 イベント落とす」ほうが安全なため。
pub fn parse_spacemouse_report(report: &[u8]) -> Option<SpaceMouseInput> {
    let (id, data) = report.split_first()?;
    match (*id, data.len()) {
        (1, 6) => {
            let (x, y, z) = three_i16_le(data);
            Some(SpaceMouseInput::Translation { x, y, z })
        }
        (1, 12) => {
            let (x, y, z) = three_i16_le(data);
            let (rx, ry, rz) = three_i16_le(&data[6..]);
            Some(SpaceMouseInput::SixAxis { x, y, z, rx, ry, rz })
        }
        (2, 6) => {
            let (rx, ry, rz) = three_i16_le(data);
            Some(SpaceMouseInput::Rotation { rx, ry, rz })
        }
        (3, 1..=4) => {
            let mut bytes = [0u8; 4];
            bytes[..data.len()].copy_from_slice(data);
            Some(SpaceMouseInput::Buttons {
                bits: u32::from_le_bytes(bytes),
            })
        }
        _ => None,
    }
}

/// 列挙したデバイスを掴むかどうか。VID 0x256F(3Dconnexion)を対象とし、
/// 3DxWare のバーチャルデバイス PID 0xC671 / 0xC672 は除外する。
pub fn is_spacemouse_device(vendor_id: u16, product_id: u16) -> bool {
    vendor_id == VENDOR_3DCONNEXION && !VIRTUAL_DEVICE_PIDS.contains(&product_id)
}

/// 直近のレポートを積み上げて 6 軸の状態にする。並進レポートと回転レポートが
/// 別々に届く機種では、片方だけが更新され残りは前回値のまま保たれる。
/// ボタンは要件#24 の範囲(回転・パン・ズーム)に効かないので状態に混ぜない。
fn accumulate(axes: &mut SpaceMouseAxes, input: SpaceMouseInput) -> bool {
    match input {
        SpaceMouseInput::Translation { x, y, z } => {
            axes.tx = x;
            axes.ty = y;
            axes.tz = z;
            true
        }
        SpaceMouseInput::Rotation { rx, ry, rz } => {
            axes.rx = rx;
            axes.ry = ry;
            axes.rz = rz;
            true
        }
        SpaceMouseInput::SixAxis { x, y, z, rx, ry, rz } => {
            *axes = SpaceMouseAxes { tx: x, ty: y, tz: z, rx, ry, rz };
            true
        }
        SpaceMouseInput::Buttons { .. } => false,
    }
}

/// emit の最小間隔(≒60Hz)。デバイスは数百 Hz でレポートを出すので、
/// そのまま流すと IPC が詰まる。間引いても最後の値は必ず送る(下記)。
const EMIT_INTERVAL: Duration = Duration::from_millis(16);

/// HID 読みのタイムアウト。デバイスが黙っている間もこの周期でループが回り、
/// 停止フラグの確認と「静止した最終値の送出」ができる。
const READ_TIMEOUT_MS: i32 = 16;

/// デバイスが見つからない / 開けないときの再試行間隔。挿し直しや
/// 3DxWare の排他が外れたタイミングで自然に拾い直す。
const RETRY_INTERVAL: Duration = Duration::from_secs(2);

/// 「変化したときだけ・最大 60Hz で」emit する間引き層。raw HID の読みループと
/// SDK のコールバックが同じ形でフロントへ届くよう、両経路がこれを通る。
pub(crate) struct AxesThrottle {
    sent: SpaceMouseAxes,
    last_emit: Instant,
}

impl AxesThrottle {
    pub(crate) fn new() -> Self {
        Self {
            sent: SpaceMouseAxes::default(),
            // 最初の 1 件を待たせない。
            last_emit: Instant::now()
                .checked_sub(EMIT_INTERVAL)
                .unwrap_or_else(Instant::now),
        }
    }

    /// 送るのは「前回送った値と違うとき」だけ。静止中(全軸ゼロが続く)は
    /// 何も流れず、指を離した瞬間のゼロは1回だけ届く = フロントは
    /// 最後のイベントで止まる。
    pub(crate) fn offer<R: Runtime>(&mut self, app: &AppHandle<R>, axes: SpaceMouseAxes) {
        if axes == self.sent || self.last_emit.elapsed() < EMIT_INTERVAL {
            return;
        }
        if let Err(e) = app.emit(SPACEMOUSE_EVENT, axes) {
            tracing::debug!("SpaceMouse: emit failed: {e}");
        }
        self.sent = axes;
        self.last_emit = Instant::now();
    }
}

/// 入力ソースの選択結果。二重読みは構造上あり得ない(1 変種のみ返る)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpaceMouseSource {
    /// 3DconnexionClient framework 経由(3DxWare 常駐環境)
    Sdk,
    /// 要件#24 の raw HID 読み(ドライバ不在環境)
    RawHid,
    /// どちらも使えない(SpaceMouse 入力なし。アプリは通常起動)
    Disabled,
}

/// 起動時のソース一点決め。SDK が使えれば SDK・だめなら raw・両方不能なら無効。
///
/// `sdk_available` = framework のロード+ハンドラ設置に成功したか、
/// `raw_available` = raw HID 経路を開始できるか。
pub fn select_source(sdk_available: bool, raw_available: bool) -> SpaceMouseSource {
    match (sdk_available, raw_available) {
        (true, _) => SpaceMouseSource::Sdk,
        (false, true) => SpaceMouseSource::RawHid,
        (false, false) => SpaceMouseSource::Disabled,
    }
}

/// 起動時に生きたソースを 1 つだけ持つハンドル。managed state に置いておくと
/// プロセス終了時に Drop が走り、raw スレッドの停止 / SDK の登録解除が行われる。
pub enum SpaceMouseHandle {
    Sdk(sdk::SdkClient),
    Raw(SpaceMouseReader),
    Disabled,
}

impl SpaceMouseHandle {
    /// ウィンドウのフォーカス変化を入力ソースへ伝える。
    ///
    /// SDK 経路だけが関係する。3DxWare は他アプリが前面に出た時点でこちらの
    /// クライアントを非アクティブにするので、戻ってきたら明示的に再有効化
    /// しないと入力が死んだままになる。raw HID はデバイスを直接読んでいて
    /// フォーカスと無関係なので何もしない。
    pub fn set_window_focus(&self, label: &str, focused: bool) {
        if let SpaceMouseHandle::Sdk(client) = self {
            client.set_window_focus(label, focused);
        }
    }
}

/// SpaceMouse 入力を 1 経路だけ開始する。
///
/// SDK を先に試し、成功したら raw は触らない(3DxWare 常駐環境で両方読むと
/// 二重入力になる)。SDK が使えなかったときだけ raw HID を評価する —
/// 失敗しても「SpaceMouse が無いだけ」で、アプリの起動や 3D 表示には
/// 一切影響させない。
pub fn start<R: Runtime>(app: AppHandle<R>) -> SpaceMouseHandle {
    let sdk_client = sdk::try_start(app.clone());
    // SDK が生きているときは raw を探しに行かない(select_source は
    // sdk_available=true なら raw を見ないので、探索そのものを省ける)。
    let raw_available = sdk_client.is_none() && raw_hid_available();

    match select_source(sdk_client.is_some(), raw_available) {
        SpaceMouseSource::Sdk => {
            tracing::info!("SpaceMouse: using 3DconnexionClient framework (3DxWare present)");
            // 直前の is_some() で確定しているので取り出せる。
            match sdk_client {
                Some(client) => SpaceMouseHandle::Sdk(client),
                None => SpaceMouseHandle::Disabled,
            }
        }
        SpaceMouseSource::RawHid => {
            tracing::info!("SpaceMouse: using raw HID reader (no 3DxWare driver)");
            SpaceMouseHandle::Raw(spawn_reader(app))
        }
        SpaceMouseSource::Disabled => {
            tracing::info!("SpaceMouse: no input source available — device input disabled");
            SpaceMouseHandle::Disabled
        }
    }
}

/// raw HID 経路を始められるか。デバイスが挿さっているかは問わない
/// (後から挿す運用があるので、判定は HID サブシステムが使えるかどうかだけ)。
fn raw_hid_available() -> bool {
    match hidapi::HidApi::new() {
        Ok(_) => true,
        Err(e) => {
            tracing::warn!("SpaceMouse: HID API unavailable ({e})");
            false
        }
    }
}

/// 常駐スレッドの停止スイッチ。Drop で落ちるので、アプリの managed state に
/// 置いておけばプロセス終了時にスレッドが畳まれる。
pub struct SpaceMouseReader {
    stop: Arc<AtomicBool>,
}

impl Drop for SpaceMouseReader {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// SpaceMouse の常駐読みを開始する。
///
/// デバイスが無い環境が普通(SpaceMouse を持っていないユーザーのほうが多い)
/// ので、失敗は全て「ログを残して待ち、また探す」に倒す — アプリの起動や
/// 3D 表示そのものは、このスレッドの成否に一切左右されない。
///
/// hidapi の読みはブロッキングなので専用の OS スレッドを1本使う
/// (tokio のブロッキングプールを永久に1枠占有しないため)。
pub fn spawn_reader<R: Runtime>(app: AppHandle<R>) -> SpaceMouseReader {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_thread = Arc::clone(&stop);

    std::thread::Builder::new()
        .name("spacemouse-hid".into())
        .spawn(move || reader_loop(app, stop_for_thread))
        .map_err(|e| tracing::warn!("SpaceMouse: reader thread could not start: {e}"))
        .ok();

    SpaceMouseReader { stop }
}

/// 「デバイスを探す → 読めるだけ読む → 見失ったら探し直す」の外側ループ。
fn reader_loop<R: Runtime>(app: AppHandle<R>, stop: Arc<AtomicBool>) {
    let mut api = match hidapi::HidApi::new() {
        Ok(api) => api,
        Err(e) => {
            // HID サブシステムごと使えない環境。再試行しても状況は変わらないので
            // ここで降りる(3D 表示はマウスで従来どおり操作できる)。
            tracing::warn!("SpaceMouse: HID API unavailable ({e}) — device input disabled");
            return;
        }
    };

    while !stop.load(Ordering::Relaxed) {
        match open_device(&mut api) {
            Some(device) => {
                tracing::info!("SpaceMouse: device connected");
                read_device(&app, &device, &stop);
                tracing::info!("SpaceMouse: device disconnected");
            }
            None => sleep_until_stopped(&stop, RETRY_INTERVAL),
        }
    }
}

/// 対象デバイスを1台開く。列挙も open も失敗しうる(未接続・3DxWare の排他・
/// 権限)。いずれも debug ログ止まりで、呼び出し側が再試行する。
fn open_device(api: &mut hidapi::HidApi) -> Option<hidapi::HidDevice> {
    if let Err(e) = api.refresh_devices() {
        tracing::debug!("SpaceMouse: device enumeration failed: {e}");
        return None;
    }
    for info in api.device_list() {
        if !is_spacemouse_device(info.vendor_id(), info.product_id()) {
            continue;
        }
        match info.open_device(api) {
            Ok(device) => return Some(device),
            Err(e) => {
                // 3DxWare が動いていると exclusive open に負けることがある
                // (docs/3d-model-viewing.md §5 のリスク項)。次の周回で再挑戦。
                tracing::debug!(
                    "SpaceMouse: open failed for {:04x}:{:04x}: {e}",
                    info.vendor_id(),
                    info.product_id()
                );
            }
        }
    }
    None
}

/// 開いたデバイスを読み続け、6 軸の状態が変わったら間引いて emit する。
/// 読みエラー(切断・スリープ復帰)で戻り、外側ループが探し直す。
fn read_device<R: Runtime>(app: &AppHandle<R>, device: &hidapi::HidDevice, stop: &AtomicBool) {
    let mut buf = [0u8; 64];
    let mut axes = SpaceMouseAxes::default();
    let mut throttle = AxesThrottle::new();

    while !stop.load(Ordering::Relaxed) {
        match device.read_timeout(&mut buf, READ_TIMEOUT_MS) {
            Ok(0) => {} // タイムアウト = デバイスは静止中。下の送出判定へ落ちる。
            Ok(len) => {
                if let Some(input) = parse_spacemouse_report(&buf[..len]) {
                    accumulate(&mut axes, input);
                }
            }
            Err(e) => {
                tracing::debug!("SpaceMouse: read failed ({e}) — reconnecting");
                return;
            }
        }

        throttle.offer(app, axes);
    }
}

/// 停止フラグを見ながら待つ(終了時に最大 100ms で畳めるように刻む)。
fn sleep_until_stopped(stop: &AtomicBool, total: Duration) {
    let step = Duration::from_millis(100);
    let mut remaining = total;
    while remaining > Duration::ZERO && !stop.load(Ordering::Relaxed) {
        let slice = remaining.min(step);
        std::thread::sleep(slice);
        remaining -= slice;
    }
}
