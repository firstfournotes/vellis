//! 3DconnexionClient SDK 診断プローブ(要件#25 実機不動の調査用・出荷物に含まれない)。
//!
//! 登録の組み合わせを 1 プロセスで同時に張り、どの client にドライバが
//! DeviceState を配送するかを見る。DeviceState の `client` フィールドは
//! 「その state の宛先 client id」なので、1 本のハンドラで区別がつく。
//!
//! 併せて ConnexionClientControl(kConnexionCtlGetDeviceID) を各 client で叩く。
//! これはデバイスを動かさなくても「ドライバがその client を生きた相手として
//! 扱っているか」が分かる(= 人手が要らない切り分け)。
#![cfg(target_os = "macos")]
use std::ffi::c_void;
use std::sync::atomic::{AtomicU32, Ordering};

type MsgHandler = extern "C" fn(u32, u32, *mut c_void);
type AddedHandler = extern "C" fn(u32);

static COUNT: AtomicU32 = AtomicU32::new(0);

const SIG_WILDCARD: u32 = 0x2A2A_2A2A; // '****'
const SIG_MANUAL: u32 = 0x2B2B_2B2B; // '++++'
const MODE_TAKE_OVER: u16 = 1;
const MODE_PLUGIN: u16 = 2;
const MASK_AXIS: u32 = 0x3F00;

const CTL_GET_DEVICE_ID: u32 = 0x3364_6964; // '3did'
const CTL_ACTIVATE_CLIENT: u32 = 0x3364_6163; // '3dac'
const CTL_DEACTIVATE_CLIENT: u32 = 0x3364_6463; // '3ddc'

#[repr(C, packed(2))]
struct DeviceState {
    version: u16,
    client: u16,
    command: u16,
    param: i16,
    value: i32,
    time: u64,
    report: [u8; 8],
    buttons8: u16,
    axis: [i16; 6],
    address: u16,
    buttons: u32,
}

extern "C" fn on_message(product: u32, msg: u32, arg: *mut c_void) {
    let n = COUNT.fetch_add(1, Ordering::Relaxed);
    if n < 60 {
        if msg == 0x3364_5352 && !arg.is_null() {
            let st = unsafe { std::ptr::read_unaligned(arg as *const DeviceState) };
            let axis = st.axis;
            let cmd = st.command;
            let client = st.client;
            println!("msg=DeviceState product={product:#x} client={client} cmd={cmd} axis={axis:?}");
        } else {
            println!("msg={msg:#x} product={product:#x}");
        }
    }
}
extern "C" fn on_added(product: u32) {
    println!("added product={product:#x}");
}
extern "C" fn on_removed(product: u32) {
    println!("removed product={product:#x}");
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRunLoopRunInMode(mode: *const c_void, seconds: f64, return_after_source: u8) -> i32;
    static kCFRunLoopDefaultMode: *const c_void;
}

fn main() {
    // 秒数は引数で指定(既定 20)。デバイスを動かしてもらう時間。
    let secs: f64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(20.0);

    unsafe {
        let path = std::ffi::CString::new(
            "/Library/Frameworks/3DconnexionClient.framework/3DconnexionClient",
        )
        .unwrap();
        let h = libc::dlopen(path.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL);
        assert!(!h.is_null(), "dlopen failed");
        let sym = |name: &str| -> *mut c_void {
            let c = std::ffi::CString::new(name).unwrap();
            let p = libc::dlsym(h, c.as_ptr());
            assert!(!p.is_null(), "dlsym {name} failed");
            p
        };
        let set_handlers: extern "C" fn(MsgHandler, AddedHandler, AddedHandler, bool) -> i16 =
            std::mem::transmute(sym("SetConnexionHandlers"));
        let register: extern "C" fn(u32, *const u8, u16, u32) -> u16 =
            std::mem::transmute(sym("RegisterConnexionClient"));
        let client_control: extern "C" fn(u16, u32, i32, *mut i32) -> i16 =
            std::mem::transmute(sym("ConnexionClientControl"));

        let st = set_handlers(on_message, on_added, on_removed, true);
        println!("SetConnexionHandlers -> {st}");

        let name = b"\x06Vellis\0";

        // 1 プロセスで登録できる client は 1 つだけ(2 本目以降は id 0 が返る)
        // ことが実測で分かったので、変種は 1 回の実行につき 1 つだけ張る。
        let variant = std::env::args().nth(2).unwrap_or_else(|| "plain".into());
        let (sig, mode) = match variant.as_str() {
            "plain" | "activate" => (SIG_WILDCARD, MODE_TAKE_OVER),
            "plugin" => (SIG_WILDCARD, MODE_PLUGIN),
            "manual" | "cycle" => (SIG_MANUAL, MODE_TAKE_OVER),
            other => panic!("unknown variant {other}"),
        };
        let id = register(sig, name.as_ptr(), mode, MASK_AXIS);
        println!("variant={variant} sig={sig:#x} mode={mode} -> client {id}");

        if matches!(variant.as_str(), "activate" | "manual" | "cycle") {
            let rc = client_control(id, CTL_ACTIVATE_CLIENT, 0, std::ptr::null_mut());
            println!("ActivateClient -> rc {rc}");
        }

        // 人手なしの生存確認: ドライバがこの client を相手にしているか。
        let mut result: i32 = 0;
        let rc = client_control(id, CTL_GET_DEVICE_ID, 0, &mut result);
        println!(
            "GetDeviceID rc={rc} result={result:#010x} (vid={:#06x} pid={:#06x})",
            (result as u32) >> 16,
            (result as u32) & 0xFFFF
        );

        // cycle: Deactivate → 再 Activate をドライバが受け付けるかを見る
        // (フォーカス往復で SpaceMouse が死ぬ不具合の修正方針の前提確認)。
        // アクティベート直後に state のバーストが来るので、区間ごとの件数で判定できる。
        if variant == "cycle" {
            let phase = |label: &str| {
                let before = COUNT.load(Ordering::Relaxed);
                std::thread::sleep(std::time::Duration::from_secs(2));
                println!(
                    "  [{label}] {} messages",
                    COUNT.load(Ordering::Relaxed) - before
                );
            };
            phase("after 1st activate");
            let rc = client_control(id, CTL_DEACTIVATE_CLIENT, 0, std::ptr::null_mut());
            println!("Deactivate -> rc {rc}");
            phase("while deactivated");
            let rc = client_control(id, CTL_ACTIVATE_CLIENT, 0, std::ptr::null_mut());
            println!("Re-activate -> rc {rc}");
            phase("after re-activate");
            println!("done: {} messages", COUNT.load(Ordering::Relaxed));
            return;
        }

        println!("--- listening {secs}s ---");
        if std::env::var("PROBE_NO_RUNLOOP").is_ok() {
            std::thread::sleep(std::time::Duration::from_secs_f64(secs));
        } else {
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, secs, 0);
        }
        println!("done: {} messages", COUNT.load(Ordering::Relaxed));
    }
}
