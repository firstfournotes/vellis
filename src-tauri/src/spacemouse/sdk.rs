//! 公式 3DconnexionClient framework 経由の SpaceMouse 入力(requirements.md #25)。
//!
//! 3DxWare(公式ドライバ)が入っている環境では、ドライバがデバイスを完全に
//! 占有するので要件#24 の raw HID では 1 バイトも読めない
//! (docs/3d-model-viewing.md §7.5 の実測)。その環境で唯一データを受け取れる
//! のが、ドライバが提供する `/Library/Frameworks/3DconnexionClient.framework`
//! のクライアント API。
//!
//! framework は 3DxWare を入れた機械にしか存在しないので、**リンクせず
//! dlopen で実行時ロードする**(同梱もしない)。不在なら [`try_start`] が
//! `None` を返し、呼び出し側が raw HID へ落ちる — アプリの起動は
//! この経路の成否に一切左右されない。
//!
//! ここに置くのは2層:
//! - 定数・[`ConnexionDeviceState`]・[`device_state_axes`](純関数・受け入れ対象)
//! - framework のロードとハンドラ配線([`try_start`] / [`SdkClient`])
//!
//! 受け取った 6 軸は raw HID と同じ [`SpaceMouseAxes`] にして、同じ間引き層
//! ([`AxesThrottle`])を通して `spacemouse_input` へ流す。フロントから見て
//! ソースの違いは無い。

use super::SpaceMouseAxes;

/// `kConnexionMsgDeviceState`('3dSR')。メッセージハンドラで messageArgument を
/// [`ConnexionDeviceState`] と解釈してよい messageType。
pub const MSG_DEVICE_STATE: u32 = 0x3364_5352;

/// `kConnexionCmdHandleAxis` / `kConnexionCmdHandleButtons`。
pub const CMD_HANDLE_AXIS: u16 = 3;
pub const CMD_HANDLE_BUTTONS: u16 = 2;

/// framework Headers(`ConnexionClient.h`)の `ConnexionDeviceState` を写した
/// FFI 構造体。Headers は `#pragma pack(push,2)` なので `#[repr(C, packed(2))]`。
///
/// Headers の `union { buttons8; appEventPressed; }` は同幅 `uint16_t` なので
/// `buttons8` に平坦化する(バイナリ互換)。合計 48 バイト =
/// `kConnexionDeviceStateSize`。1 バイトでもずれると全フィールドが化けるので、
/// サイズとオフセットは受け入れテストで固定してある。
#[repr(C, packed(2))]
#[derive(Clone, Copy)]
pub struct ConnexionDeviceState {
    pub version: u16,
    pub client: u16,
    pub command: u16,
    pub param: i16,
    pub value: i32,
    pub time: u64,
    pub report: [u8; 8],
    pub buttons8: u16,
    pub axis: [i16; 6], // x, y, z, rx, ry, rz
    pub address: u16,
    pub buttons: u32,
}

/// DeviceState 1 件を 6 軸の状態へ。
///
/// `command` が `kConnexionCmdHandleAxis` のときだけ `Some`(Headers の並び
/// x, y, z, rx, ry, rz を tx..rz へ素通し。符号反転・正規化はしない —
/// 意味づけはフロントの写像の持ち場)。ボタンほか軸以外のコマンドは `None`
/// で、カメラ操作には混ぜない(raw 側で Buttons を状態に混ぜない扱いと同じ)。
pub fn device_state_axes(state: &ConnexionDeviceState) -> Option<SpaceMouseAxes> {
    // packed 構造体のフィールドは参照を取れないのでコピーしてから読む。
    let command = state.command;
    if command != CMD_HANDLE_AXIS {
        return None;
    }
    let axis = state.axis;
    Some(SpaceMouseAxes {
        tx: axis[0],
        ty: axis[1],
        tz: axis[2],
        rx: axis[3],
        ry: axis[4],
        rz: axis[5],
    })
}

// ---------------------------------------------------------------------------
// framework の実行時ロードとハンドラ配線(macOS のみ)
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod ffi {
    use std::collections::HashSet;
    use std::ffi::{c_char, c_int, c_uint, c_void, CString};
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};

    use tauri::{AppHandle, Runtime};

    use super::{device_state_axes, ConnexionDeviceState, MSG_DEVICE_STATE};
    use crate::spacemouse::{AxesThrottle, SpaceMouseAxes};

    /// 3DxWare がインストールする framework の実体。リンクせずここを dlopen する
    /// (無い機械のほうが多く、あってもバージョンが機械ごとに違う)。
    const FRAMEWORK_PATH: &str =
        "/Library/Frameworks/3DconnexionClient.framework/3DconnexionClient";

    /// `kConnexionClientManual`('++++')。Headers いわく「ClientControl の呼び出しで
    /// 手動でデバイスを take over する」ための signature。
    ///
    /// ワイルドカード('****')ではなくこちらを使う理由は2つ。ひとつは
    /// **登録しただけではドライバが state を配送しない**こと(実測。下の
    /// [`try_start`] の注記)。もうひとつは、ワイルドカードが「全アプリで
    /// システム全体を横取りする」意味になり、Vellis が起動している間だけ
    /// 他の 3D アプリで SpaceMouse が効かなくなるため。manual なら
    /// 有効化/無効化をこちらが握れる。
    const CLIENT_MANUAL: u32 = 0x2B2B_2B2B;

    /// `kConnexionClientModeTakeOver`。ドライバの割り当てを介さず生の軸値を
    /// 受け取るモード。Plugin モード(2)はユーザーが 3DxWare 側で
    /// プラグイン割り当てを設定していないと何も届かないので採らない。
    const CLIENT_MODE_TAKE_OVER: u16 = 1;

    /// `kConnexionMaskAxis`(6 軸のみ)。ボタンは要件の範囲外なので要求しない。
    const MASK_AXIS: u32 = 0x3F00;

    /// `kConnexionCtlActivateClient`('3dac')/ `kConnexionCtlDeactivateClient`('3ddc')。
    /// manual 登録したクライアントを「アプリが前面に来た/去った」のと同じ扱いで
    /// 有効化・無効化する。
    const CTL_ACTIVATE_CLIENT: u32 = 0x3364_6163;
    const CTL_DEACTIVATE_CLIENT: u32 = 0x3364_6463;

    /// dlopen のフラグ(`RTLD_LAZY | RTLD_LOCAL`)。
    const RTLD_LAZY: c_int = 0x1;
    const RTLD_LOCAL: c_int = 0x4;

    type MessageHandlerProc = extern "C" fn(c_uint, c_uint, *mut c_void);
    type AddedHandlerProc = extern "C" fn(c_uint);
    type RemovedHandlerProc = extern "C" fn(c_uint);

    type SetConnexionHandlersFn = unsafe extern "C" fn(
        MessageHandlerProc,
        AddedHandlerProc,
        RemovedHandlerProc,
        bool,
    ) -> i16;
    type RegisterConnexionClientFn = unsafe extern "C" fn(u32, *mut u8, u16, u32) -> u16;
    type UnregisterConnexionClientFn = unsafe extern "C" fn(u16);
    type CleanupConnexionHandlersFn = unsafe extern "C" fn();
    type ConnexionClientControlFn = unsafe extern "C" fn(u16, u32, i32, *mut i32) -> i16;

    /// dlsym で引いた関数群。dlopen のハンドルは持たない —
    /// framework は自前のスレッドを回し続けるので dlclose してはいけない
    /// (プロセス終了まで載せたままにする)。関数ポインタだけなので
    /// この構造体は Send + Sync。
    struct Api {
        set_handlers: SetConnexionHandlersFn,
        register: RegisterConnexionClientFn,
        unregister: UnregisterConnexionClientFn,
        cleanup: CleanupConnexionHandlersFn,
        client_control: ConnexionClientControlFn,
    }

    /// コールバックは context 引数を取らない(`ConnexionMessageHandlerProc` は
    /// productID / messageType / messageArgument の 3 引数だけ)ので、
    /// 送り先はプロセスに 1 つの静的スロットで受け渡す。プロセスあたり
    /// クライアントは 1 つなので競合しない。
    type Sink = Box<dyn Fn(SpaceMouseAxes) + Send + Sync + 'static>;
    static SINK: OnceLock<Sink> = OnceLock::new();

    /// ドライバから 1 件届くたびに呼ばれる。軸コマンドだけを取り出して
    /// 共通の間引き層へ渡す。
    ///
    /// FFI 境界を panic が越えると未定義動作なので、中身は catch_unwind で包む。
    extern "C" fn message_handler(
        _product_id: c_uint,
        message_type: c_uint,
        message_argument: *mut c_void,
    ) {
        if message_type != MSG_DEVICE_STATE || message_argument.is_null() {
            return;
        }
        let _ = catch_unwind(AssertUnwindSafe(|| {
            // packed(2) なのでアライメントを仮定せずに読む。
            let state = unsafe {
                std::ptr::read_unaligned(message_argument as *const ConnexionDeviceState)
            };
            // 「登録は通るのに state が来ない」という詰まり方をする経路なので、
            // 到達の有無だけは trace で追えるようにしておく。
            let (command, axis) = (state.command, state.axis);
            tracing::trace!("SpaceMouse: SDK state command={command} axis={axis:?}");
            if let Some(axes) = device_state_axes(&state) {
                if let Some(sink) = SINK.get() {
                    sink(axes);
                }
            }
        }));
    }

    extern "C" fn added_handler(product_id: c_uint) {
        tracing::info!("SpaceMouse: SDK reports device added (product {product_id:#06x})");
    }

    extern "C" fn removed_handler(product_id: c_uint) {
        tracing::info!("SpaceMouse: SDK reports device removed (product {product_id:#06x})");
    }

    /// 生きている SDK クライアント。Drop で登録解除+ハンドラ撤去まで行う
    /// (managed state に置いてあるのでアプリ終了時に走る)。
    ///
    /// manual signature のクライアントは「前面に来た/去った」をこちらが
    /// ドライバへ伝える約束なので、ウィンドウのフォーカスに追従させる
    /// ([`SdkClient::set_window_focus`])。
    pub struct SdkClient {
        api: Api,
        client_id: u16,
        /// いまフォーカスを持っているウィンドウのラベル。1つでも入っていれば
        /// アプリは前面にいる。ウィンドウ間を移るときの (false, true) の
        /// 到着順に依存しないよう、数ではなく集合で持つ。
        focused_windows: Mutex<HashSet<String>>,
        /// ドライバへ伝えてある現在の状態。同じ値を二度送らないための番人。
        active: AtomicBool,
    }

    impl SdkClient {
        /// ウィンドウのフォーカス変化を反映する。どれか1つでもフォーカスを
        /// 持っていれば有効、全部失っていれば無効。
        pub fn set_window_focus(&self, label: &str, focused: bool) {
            let any_focused = {
                let mut windows = self
                    .focused_windows
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                if focused {
                    windows.insert(label.to_owned());
                } else {
                    windows.remove(label);
                }
                !windows.is_empty()
            };
            self.set_active(any_focused);
        }

        /// ドライバへ有効/無効を伝える。状態が変わったときだけ呼ぶ。
        fn set_active(&self, active: bool) {
            if self.active.swap(active, Ordering::SeqCst) == active {
                return;
            }
            let message = if active {
                CTL_ACTIVATE_CLIENT
            } else {
                CTL_DEACTIVATE_CLIENT
            };
            // SAFETY: 登録済みの client_id。result は使わないので null。
            let status =
                unsafe { (self.api.client_control)(self.client_id, message, 0, std::ptr::null_mut()) };
            if status != 0 {
                tracing::warn!(
                    "SpaceMouse: client control failed (active={active}, status {status})"
                );
                return;
            }
            tracing::debug!("SpaceMouse: SDK client active={active}");
        }
    }

    impl Drop for SdkClient {
        fn drop(&mut self) {
            // 有効化した分を戻してから外す(ドライバ側に「前面から去った」と
            // 伝えるのと同じ意味。これで他アプリの SpaceMouse が復帰する)。
            self.set_active(false);
            unsafe {
                (self.api.unregister)(self.client_id);
                (self.api.cleanup)();
            }
            tracing::info!("SpaceMouse: SDK client deactivated and unregistered");
        }
    }

    /// dlsym 1 本。見つからなければ None(バージョン違いの framework を
    /// 掴んでも落ちないように、シンボルは 1 つずつ確認する)。
    unsafe fn symbol(handle: *mut c_void, name: &str) -> Option<*mut c_void> {
        let c_name = CString::new(name).ok()?;
        let ptr = libc::dlsym(handle, c_name.as_ptr() as *const c_char);
        if ptr.is_null() {
            tracing::debug!("SpaceMouse: SDK symbol {name} not found");
            return None;
        }
        Some(ptr)
    }

    /// framework をロードして必要なシンボルを揃える。
    fn load_api() -> Option<Api> {
        let path = CString::new(FRAMEWORK_PATH).ok()?;
        // SAFETY: 定数パスの dlopen。ハンドルは意図的に閉じない(上記)。
        let handle = unsafe { libc::dlopen(path.as_ptr(), RTLD_LAZY | RTLD_LOCAL) };
        if handle.is_null() {
            tracing::debug!("SpaceMouse: 3DconnexionClient framework not present");
            return None;
        }

        // SAFETY: Headers のシグネチャどおりに関数ポインタへ写す。
        unsafe {
            // InstallConnexionHandlers は obsolete。現行 API は
            // SetConnexionHandlers(useSeparateThread 付き)。
            let set_handlers = symbol(handle, "SetConnexionHandlers")?;
            let register = symbol(handle, "RegisterConnexionClient")?;
            let unregister = symbol(handle, "UnregisterConnexionClient")?;
            let cleanup = symbol(handle, "CleanupConnexionHandlers")?;
            // 引数に clientID を取る新しい方(ConnexionControl は deprecated)。
            let client_control = symbol(handle, "ConnexionClientControl")?;
            Some(Api {
                set_handlers: std::mem::transmute::<*mut c_void, SetConnexionHandlersFn>(
                    set_handlers,
                ),
                register: std::mem::transmute::<*mut c_void, RegisterConnexionClientFn>(register),
                unregister: std::mem::transmute::<*mut c_void, UnregisterConnexionClientFn>(
                    unregister,
                ),
                cleanup: std::mem::transmute::<*mut c_void, CleanupConnexionHandlersFn>(cleanup),
                client_control: std::mem::transmute::<*mut c_void, ConnexionClientControlFn>(
                    client_control,
                ),
            })
        }
    }

    /// SDK 経路を開始する。framework が無い / ハンドラを置けない / 登録が
    /// 通らない、のいずれでも `None`(呼び出し側が raw HID へ落ちる)。
    pub fn try_start<R: Runtime>(app: AppHandle<R>) -> Option<SdkClient> {
        let api = load_api()?;

        // 送り先を先に据える。ハンドラ設置後は即座にコールバックが来うるので、
        // SINK が空の瞬間を作らない。
        let throttle = Mutex::new(AxesThrottle::new());
        let sink: Sink = Box::new(move |axes| {
            // 中毒したロックでイベントを止めないよう、毒は無視して続ける
            // (中身は「直前に送った値と時刻」だけで、壊れても実害がない)。
            let mut throttle = throttle.lock().unwrap_or_else(|e| e.into_inner());
            throttle.offer(&app, axes);
        });
        let _ = SINK.set(sink);

        // useSeparateThread = true: framework 側が専用スレッドと CFRunLoop を
        // 立てて回してくれる。メインスレッドの NSApplication RunLoop に
        // 相乗りしないので、Tauri のイベントループの都合と切り離せる。
        // SAFETY: シグネチャは Headers どおり。ハンドラは 'static な extern "C"。
        let status = unsafe {
            (api.set_handlers)(message_handler, added_handler, removed_handler, true)
        };
        if status != 0 {
            tracing::warn!("SpaceMouse: SetConnexionHandlers failed (status {status})");
            return None;
        }

        // name は Pascal 文字列(先頭バイトが長さ)。ドライバの UI に出る名前。
        let mut name: [u8; 7] = *b"\x06Vellis";
        // SAFETY: name は呼び出し中だけ読まれる(ドライバ側がコピーする)。
        let client_id = unsafe {
            (api.register)(
                CLIENT_MANUAL,
                name.as_mut_ptr(),
                CLIENT_MODE_TAKE_OVER,
                MASK_AXIS,
            )
        };
        if client_id == 0 {
            tracing::warn!("SpaceMouse: RegisterConnexionClient returned no client id");
            // ハンドラだけ残しても意味がないので撤去してから降りる。
            unsafe { (api.cleanup)() };
            return None;
        }

        // 登録しただけではドライバは DeviceState を1件も送ってこない
        // (実測: この呼び出しの有無だけで 0 件 / 配送ありが切り替わる)。
        // manual signature のクライアントは、明示的に「前面に来た」と伝えて
        // 初めて有効になる。
        //
        // 起動直後は「前面にいる」前提で有効にしておく。以降はウィンドウの
        // フォーカスイベントが実態に合わせて上書きする(集合が空になれば無効)。
        // SAFETY: 直前に得た有効な client_id を渡す。result は使わないので null。
        let status =
            unsafe { (api.client_control)(client_id, CTL_ACTIVATE_CLIENT, 0, std::ptr::null_mut()) };
        if status != 0 {
            tracing::warn!("SpaceMouse: ActivateClient failed (status {status})");
            unsafe {
                (api.unregister)(client_id);
                (api.cleanup)();
            }
            return None;
        }

        tracing::info!("SpaceMouse: SDK client registered and activated (id {client_id})");
        Some(SdkClient {
            api,
            client_id,
            focused_windows: Mutex::new(HashSet::new()),
            active: AtomicBool::new(true),
        })
    }
}

#[cfg(target_os = "macos")]
pub use ffi::{try_start, SdkClient};

// ---------------------------------------------------------------------------
// macOS 以外: framework は存在しないので常に raw HID へ落ちる
// ---------------------------------------------------------------------------

/// 3DconnexionClient framework は macOS 専用。他プラットフォームでは
/// この型は使われない(空のプレースホルダ)。
#[cfg(not(target_os = "macos"))]
pub struct SdkClient;

#[cfg(not(target_os = "macos"))]
impl SdkClient {
    pub fn set_window_focus(&self, _label: &str, _focused: bool) {}
}

#[cfg(not(target_os = "macos"))]
pub fn try_start<R: tauri::Runtime>(_app: tauri::AppHandle<R>) -> Option<SdkClient> {
    None
}
