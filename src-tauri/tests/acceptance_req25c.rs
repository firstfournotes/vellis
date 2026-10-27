//! 要件#25 追補c の受け入れテスト(docs/requirements/req-25.md「追補c 普通の終了で
//! 3DxWare への登録を解除する」・AC-25-追c (a)・Issue #561)— 入力源を止める関数
//!
//! 追補c(1): 「SpaceMouse の入力源を止める関数」は**一度きり**(2 回目以降は何もしない)で、
//! SDK の解除は `Deactivate` → `Unregister` → `Cleanup` の順。`Drop` からも同じ関数を呼び、
//! どちらが先でも二重に解除しない。
//!
//! 判定は **3DxWare に登録せず・framework を dlopen せず**に行う。`SdkClient` が呼ぶ
//! framework の関数表を trait(`ConnexionApi`)にし、本テストは呼び出しを記録するだけの
//! 偽物を差し込む(下の確定契約)。偽物は何も開かず何も登録しないので、由谷が
//! SpaceMouse を使っている最中に走っても入力を握らない。
//!
//! ケース(AC-25-追c (a)):
//! ① `shutdown_sends_deactivate_unregister_cleanup_in_order` — 有効な(登録+Activate 済み)
//!    クライアントの `shutdown()` 1 回で、偽の関数表には Deactivate(id) → Unregister(id) →
//!    Cleanup の 3 件がこの順で、それぞれ 1 回だけ記録される
//! ② `shutdown_twice_tears_down_only_once` — `shutdown()` を 2 回呼んでも記録は①の 3 件のまま
//! ③ `drop_after_shutdown_does_not_tear_down_again` — `shutdown()` の後に `Drop` が走っても
//!    記録は 3 件のまま(終了事象 → その後の破棄、の順)
//! ④ `drop_without_shutdown_still_tears_down_once` — `shutdown()` を呼ばずに `Drop` だけが
//!    走っても(従来の経路)3 件がこの順で 1 回ずつ記録される(どちらが先でも二重に解除しない)
//! ⑤ `shutdown_after_focus_loss_never_unregisters_before_deactivating` — フォーカスを失って
//!    Deactivate 済みのクライアントを `shutdown()` しても、Unregister と Cleanup は 1 回ずつ・
//!    Deactivate はすべて Unregister より前(Unregister の後にクライアントへ触らない)
//! ⑥ `handle_shutdown_reaches_sdk_client_once` — `lib.rs` が呼ぶ入り口 `SpaceMouseHandle::shutdown`
//!    が `Sdk` 変種のクライアントへ届き、2 回呼んで+Drop でも解除は 1 回
//! ⑦ `handle_shutdown_on_disabled_is_a_no_op` — `Disabled` 変種(webdriver ビルド・`--self-check`)
//!    の `shutdown()` は何もせず落ちない
//!
//! 本ファイルの外: `lib.rs` の `.run` コールバックが `RunEvent::Exit` でこの関数を呼ぶこと
//! (AC-25-追c (b))は `acceptance_req25c_exit.rs`。raw HID のスレッド停止は `SpaceMouseReader`
//! の停止フラグ(`store(true)` は何度呼んでも同じ)で、スレッドを立てずに判定できる形が無く
//! 実機の HID を触らないため本ファイルでは扱わない(reviewer 照合)。実機で登録が消えること
//! (`ioreg` の `TDxVirtualHIDData_ID` の数)は人間ゲート。
//!
//! 既存の acceptance_req25.rs / acceptance_req25a.rs / acceptance_req25b.rs は変更しない。
//!
//! ## 確定契約(implementer はこれに従う。差し込み口は最小)
//!
//! ```ignore
//! // --- vellis_lib::spacemouse::sdk(macOS。既存の `pub use ffi::{try_start, SdkClient}` に足す) ---
//!
//! /// `SdkClient` が解除・有効化で呼ぶ framework の関数表。本物は dlsym で引いた
//! /// 関数ポインタ(既存の `Api`)がこの trait を実装し、テストは偽物を差し込む。
//! /// `set_handlers` / `register` は登録時(`try_start`)にしか使わないので含めない。
//! pub trait ConnexionApi: Send + Sync {
//!     /// `ConnexionClientControl(clientID, message, param, NULL)` の戻り値(0 = 成功)。
//!     /// message は `kConnexionCtlActivateClient`('3dac' = 0x3364_6163)か
//!     /// `kConnexionCtlDeactivateClient`('3ddc' = 0x3364_6463)。
//!     fn client_control(&self, client_id: u16, message: u32, param: i32) -> i16;
//!     /// `UnregisterConnexionClient(clientID)`
//!     fn unregister(&self, client_id: u16);
//!     /// `CleanupConnexionHandlers()`
//!     fn cleanup(&self);
//! }
//!
//! impl SdkClient {
//!     /// 登録+Activate 済み(= `try_start` が返した直後と同じ状態)のクライアントを、
//!     /// 与えた関数表で組み立てる。framework には触らない(テストの差し込み口)。
//!     pub fn from_registered(api: Box<dyn ConnexionApi>, client_id: u16) -> SdkClient;
//!
//!     /// 入力源を止める(一度きり)。初回: Deactivate(有効なら)→ Unregister → Cleanup。
//!     /// 2 回目以降は何もしない。`Drop` もこれを呼ぶ。
//!     pub fn shutdown(&self);
//! }
//!
//! // --- vellis_lib::spacemouse(全プラットフォーム) ---
//!
//! impl SpaceMouseHandle {
//!     /// `lib.rs` の `.run` コールバックが `RunEvent::Exit` で呼ぶ入り口。
//!     /// `Sdk` → `SdkClient::shutdown`・`Raw` → 読みスレッドの停止・`Disabled` → 何もしない。
//!     pub fn shutdown(&self);
//! }
//! ```
//!
//! 赤の設計: 実装前の `sdk.rs` には `ConnexionApi` trait・`SdkClient::from_registered`・
//! `SdkClient::shutdown` が無く、`spacemouse.rs` には `SpaceMouseHandle::shutdown` が無いので、
//! 本ファイルはコンパイルが通らず全ケースが赤になる(理由はすべて未実装)。

use vellis_lib::spacemouse::SpaceMouseHandle;

/// ⑦ `Disabled` 変種の `shutdown()` は何もせず落ちない(webdriver ビルド・`--self-check` は
///    `Disabled` を managed state に置いたまま終了事象を受けるので、ここで落ちてはいけない)。
#[test]
fn handle_shutdown_on_disabled_is_a_no_op() {
    let handle = SpaceMouseHandle::Disabled;
    handle.shutdown();
    handle.shutdown();
    drop(handle);
}

#[cfg(target_os = "macos")]
mod sdk_teardown {
    use std::sync::{Arc, Mutex};

    use vellis_lib::spacemouse::sdk::{ConnexionApi, SdkClient};
    use vellis_lib::spacemouse::SpaceMouseHandle;

    /// `kConnexionCtlActivateClient`('3dac')/ `kConnexionCtlDeactivateClient`('3ddc')。
    /// framework Headers(`ConnexionClientAPI.h`)の値。実装側の定数名には依存せず、
    /// 偽の関数表に届いた message の値そのもので判定する。
    const CTL_ACTIVATE_CLIENT: u32 = 0x3364_6163;
    const CTL_DEACTIVATE_CLIENT: u32 = 0x3364_6463;

    /// テストで使うクライアント ID(`RegisterConnexionClient` が返したことにする値)。
    const CLIENT_ID: u16 = 7;

    /// 偽の関数表に届いた呼び出し。
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Call {
        Activate(u16),
        Deactivate(u16),
        Unregister(u16),
        Cleanup,
    }

    /// 呼び出しを記録するだけの関数表。framework を開かず、何も登録しない。
    struct Recorder {
        calls: Arc<Mutex<Vec<Call>>>,
    }

    impl ConnexionApi for Recorder {
        fn client_control(&self, client_id: u16, message: u32, _param: i32) -> i16 {
            let call = match message {
                CTL_ACTIVATE_CLIENT => Call::Activate(client_id),
                CTL_DEACTIVATE_CLIENT => Call::Deactivate(client_id),
                other => panic!(
                    "ConnexionClientControl received an unexpected message {other:#010x} \
                     (expected ActivateClient {CTL_ACTIVATE_CLIENT:#010x} or \
                     DeactivateClient {CTL_DEACTIVATE_CLIENT:#010x})"
                ),
            };
            self.calls.lock().unwrap().push(call);
            0
        }

        fn unregister(&self, client_id: u16) {
            self.calls.lock().unwrap().push(Call::Unregister(client_id));
        }

        fn cleanup(&self) {
            self.calls.lock().unwrap().push(Call::Cleanup);
        }
    }

    /// 偽の関数表で、登録+Activate 済みのクライアントを組み立てる。
    /// 記録は `Arc` で共有するので、クライアントを drop した後でも読める。
    fn registered_client() -> (SdkClient, Arc<Mutex<Vec<Call>>>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let api = Recorder {
            calls: Arc::clone(&calls),
        };
        let client = SdkClient::from_registered(Box::new(api), CLIENT_ID);
        (client, calls)
    }

    fn recorded(calls: &Arc<Mutex<Vec<Call>>>) -> Vec<Call> {
        calls.lock().unwrap().clone()
    }

    /// 解除 1 回ぶんの正しい並び。
    const TEARDOWN: [Call; 3] = [
        Call::Deactivate(CLIENT_ID),
        Call::Unregister(CLIENT_ID),
        Call::Cleanup,
    ];

    /// ① 有効なクライアントの `shutdown()` 1 回 = Deactivate → Unregister → Cleanup を 1 回ずつ。
    #[test]
    fn shutdown_sends_deactivate_unregister_cleanup_in_order() {
        let (client, calls) = registered_client();
        assert!(
            recorded(&calls).is_empty(),
            "building the client from a registered id must not touch the API table"
        );

        client.shutdown();

        assert_eq!(
            recorded(&calls),
            TEARDOWN.to_vec(),
            "shutdown must send exactly DeactivateClient({CLIENT_ID}) → UnregisterConnexionClient({CLIENT_ID}) → CleanupConnexionHandlers, once each, in this order"
        );
        std::mem::forget(client); // Drop の挙動は③④で別に見る
    }

    /// ② `shutdown()` を 2 回呼んでも解除は 1 回だけ。
    #[test]
    fn shutdown_twice_tears_down_only_once() {
        let (client, calls) = registered_client();

        client.shutdown();
        client.shutdown();

        assert_eq!(
            recorded(&calls),
            TEARDOWN.to_vec(),
            "the second shutdown() must not call the API table again"
        );
        std::mem::forget(client);
    }

    /// ③ `shutdown()` → `Drop` の順(終了事象のあとで managed state が破棄される)でも 1 回だけ。
    #[test]
    fn drop_after_shutdown_does_not_tear_down_again() {
        let (client, calls) = registered_client();

        client.shutdown();
        drop(client);

        assert_eq!(
            recorded(&calls),
            TEARDOWN.to_vec(),
            "Drop after shutdown() must not unregister or clean up a second time"
        );
    }

    /// ④ `Drop` だけ(従来の経路)でも、同じ順で 1 回ずつ解除される。
    #[test]
    fn drop_without_shutdown_still_tears_down_once() {
        let (client, calls) = registered_client();

        drop(client);

        assert_eq!(
            recorded(&calls),
            TEARDOWN.to_vec(),
            "Drop alone must still tear down once: Deactivate → Unregister → Cleanup"
        );
    }

    /// ⑤ フォーカスを失って Deactivate 済みでも、Unregister と Cleanup は 1 回ずつで、
    ///    Deactivate はすべて Unregister より前(外した後のクライアントへ触らない)。
    ///    Deactivate を再送するかどうかは既存の「同じ状態を二度送らない」番人に任せ、ここでは縛らない。
    #[test]
    fn shutdown_after_focus_loss_never_unregisters_before_deactivating() {
        let (client, calls) = registered_client();

        client.set_window_focus("main", true);
        client.set_window_focus("main", false);
        let before = recorded(&calls);
        assert_eq!(
            before,
            vec![Call::Deactivate(CLIENT_ID)],
            "losing focus from the active state sends one DeactivateClient (existing invariant)"
        );

        client.shutdown();
        client.shutdown();
        drop(client);

        let all = recorded(&calls);
        let unregisters = all
            .iter()
            .filter(|c| matches!(c, Call::Unregister(_)))
            .count();
        let cleanups = all.iter().filter(|c| matches!(c, Call::Cleanup)).count();
        assert_eq!(unregisters, 1, "exactly one UnregisterConnexionClient; got {all:?}");
        assert_eq!(cleanups, 1, "exactly one CleanupConnexionHandlers; got {all:?}");
        assert!(
            all.iter().all(|c| !matches!(c, Call::Activate(_))),
            "shutdown must never activate the client; got {all:?}"
        );
        assert!(
            all.iter().all(|c| !matches!(c, Call::Unregister(id) | Call::Deactivate(id) if *id != CLIENT_ID)),
            "every call must address the registered client id {CLIENT_ID}; got {all:?}"
        );
        let unregister_at = all
            .iter()
            .position(|c| matches!(c, Call::Unregister(_)))
            .unwrap();
        let cleanup_at = all.iter().position(|c| matches!(c, Call::Cleanup)).unwrap();
        assert!(
            unregister_at < cleanup_at,
            "UnregisterConnexionClient must come before CleanupConnexionHandlers; got {all:?}"
        );
        assert!(
            all.iter()
                .enumerate()
                .all(|(i, c)| !matches!(c, Call::Deactivate(_)) || i < unregister_at),
            "no DeactivateClient may follow UnregisterConnexionClient; got {all:?}"
        );
    }

    /// ⑥ `lib.rs` が呼ぶ入り口 `SpaceMouseHandle::shutdown` が `Sdk` のクライアントへ届き、
    ///    2 回呼んで+Drop でも解除は 1 回。
    #[test]
    fn handle_shutdown_reaches_sdk_client_once() {
        let (client, calls) = registered_client();
        let handle = SpaceMouseHandle::Sdk(client);

        handle.shutdown();
        assert_eq!(
            recorded(&calls),
            TEARDOWN.to_vec(),
            "SpaceMouseHandle::shutdown on the Sdk variant must tear the SDK client down once, in order"
        );

        handle.shutdown();
        drop(handle);
        assert_eq!(
            recorded(&calls),
            TEARDOWN.to_vec(),
            "a second SpaceMouseHandle::shutdown and the final Drop must not tear down again"
        );
    }
}
