//! 要件#12 の受け入れテスト(requirements.md #12)— Rust 層
//!
//! 「File メニューの New Window で新規ウインドウを開ける(引数なし起動と同じ状態)」
//!
//! 契約(2026-08-09 由谷決定):
//! - File メニューに New Window(CmdOrCtrl+N)
//! - 生成ウインドウは WindowArgs 両 None(initial_path/root なし)で登録され、
//!   needs_root_selection=true → 履歴選択画面(要件#4)を表示する
//! - 既存 new_window コマンドは path/root 必須のため引数なし生成に対応させる
//!   (拡張か同等の生成経路かは実装裁量。**WindowArgs の登録内容が契約**)
//! - サイズ等は window-state プラグインの既存復元に従う
//!
//! 判定範囲(本ファイル): 登録ロジックのみ。tauri コマンド本体(new_window)は
//! AppHandle と実ウインドウ生成(WebviewWindowBuilder / window-state 復元)を
//! 要するため統合テストでは呼ばず、「コマンド入力 → WindowManager への登録内容」
//! を公開シームとして固定する(要件#5 の `WindowArgs::for_open_target` と同じ
//! 流儀)。needs_root_selection の真偽表自体は acceptance_req4.rs で固定済み —
//! 本ファイルは「メニュー起点の引数なし生成でも登録内容が引数なし起動と同じ状態
//! になる」ことを固定する。
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```ignore
//! // 実装先: src-tauri/src/window/manager.rs
//! impl<R: tauri::Runtime> WindowManager<R> {
//!     /// 既存 new_window コマンド(path/root あり)と New Window メニュー
//!     /// (引数なし)が共有する登録シーム。`next_label()` で一意ラベルを
//!     /// 採番し、WindowArgs {
//!     ///     initial_path: path, root, show_marks: false, show_changed: false
//!     /// } で `register_window` して、採番したラベルを返す。
//!     /// 引数は変形せずそのまま登録する — 両 None なら引数なし起動と同じ
//!     /// 状態(needs_root_selection()=true → 履歴選択画面=要件#4)。
//!     /// 実ウインドウ生成(WebviewWindowBuilder・window-state の
//!     /// restore_state)は呼び出し側の仕事で、本シームの範囲外。
//!     pub fn register_new_window(
//!         &mut self,
//!         path: Option<String>,
//!         root: Option<String>,
//!     ) -> String;
//! }
//! ```
//!
//! `commands::window::new_window` の既存インライン登録(next_label +
//! register_window)は本シームへ抽出し、引数なし生成経路(New Window メニュー)
//! も同じシームを通ること(配線は reviewer 照合 — 本テストは登録内容の契約のみ
//! 機械判定する)。
//!
//! ## reviewer 照合に委ねる項目(AppHandle 依存で機械判定不能な配線)
//! - File メニューに New Window 項目(CmdOrCtrl+N)が存在し、クリックで
//!   引数なし生成経路(register_new_window(None, None) 経由の登録+
//!   ウインドウ生成)に到達すること
//! - 既存 new_window コマンドが本シーム経由で登録すること(挙動不変)
//! - 生成ウインドウのサイズ等が window-state プラグインの既存復元
//!   (restore_state)に従うこと
//!
//! ## 人間ゲート(gate)
//! - New Window で実際に新規ウインドウが開き、履歴選択画面が表示されること
//!   (新規ウインドウの実動は機械テストのスコープ外)

use tauri::test::MockRuntime;
use vellis_lib::window::manager::{WindowArgs, WindowManager};

/// 1. 引数なし生成(New Window メニュー起点)= WindowArgs 両 None で登録され、
///    返されたラベルで取得できる。登録内容は引数なし起動
///    (WindowArgs::default())と全フィールド同じ状態。
#[test]
fn argless_new_window_registers_both_none_args() {
    let mut wm: WindowManager<MockRuntime> = WindowManager::new();
    let label = wm.register_new_window(None, None);

    let state = wm
        .get(&label)
        .expect("the new window must be registered under the returned label");
    let args = &state.initial_args;
    assert!(
        args.initial_path.is_none(),
        "New Window must register no initial_path"
    );
    assert!(args.root.is_none(), "New Window must register no root");

    // 「引数なし起動と同じ状態」= default とサイドバー系フラグも含めて一致。
    let default = WindowArgs::default();
    assert_eq!(
        args.show_marks, default.show_marks,
        "New Window must not turn on the marks sidebar (same as an argless launch)"
    );
    assert_eq!(
        args.show_changed, default.show_changed,
        "New Window must not turn on the drift filter (same as an argless launch)"
    );
}

/// 2. 引数なし生成の登録内容は needs_root_selection()=true —
///    その窓の init_window が履歴選択画面(要件#4)へ分岐する状態である。
#[test]
fn argless_new_window_needs_root_selection() {
    let mut wm: WindowManager<MockRuntime> = WindowManager::new();
    let label = wm.register_new_window(None, None);
    let args = &wm.get(&label).unwrap().initial_args;
    assert!(
        args.needs_root_selection(),
        "a menu-created window without arguments must show the history picker \
         screen, exactly like an argless launch (requirements.md #4)"
    );
}

/// 3. 既存経路のデグレなし: path/root 指定の生成は従来どおり両 Some で
///    登録され、履歴選択画面には落ちない(現行 new_window コマンドの
///    登録内容と同じ)。
#[test]
fn path_root_new_window_route_is_unchanged() {
    let mut wm: WindowManager<MockRuntime> = WindowManager::new();
    let label = wm.register_new_window(
        Some("file:///Users/a/docs/readme.md".into()),
        Some("file:///Users/a/docs".into()),
    );

    let args = &wm.get(&label).unwrap().initial_args;
    assert_eq!(
        args.initial_path.as_deref(),
        Some("file:///Users/a/docs/readme.md"),
        "the existing path/root route must keep registering the initial document"
    );
    assert_eq!(
        args.root.as_deref(),
        Some("file:///Users/a/docs"),
        "the existing path/root route must keep registering the root"
    );
    assert!(
        !args.needs_root_selection(),
        "an explicit target must never fall back to the history picker"
    );
    assert!(
        !args.show_marks && !args.show_changed,
        "sidebar flags stay off on the command route (unchanged behaviour)"
    );
}

/// 4. 境界: 片側だけの指定も変形せずそのまま登録される(いずれかが Some なら
///    従来どおり開く= needs_root_selection は false。要件#4 で固定済みの
///    判定と整合し、「どちらかが None なら引数なし扱い」のような誤実装を防ぐ)。
#[test]
fn partial_args_pass_through_verbatim() {
    let mut wm: WindowManager<MockRuntime> = WindowManager::new();

    // path のみ(ファイル直指定の形 — root は init_window が親から導出する現行経路)。
    let label = wm.register_new_window(Some("ssh://host/notes.md".into()), None);
    let args = &wm.get(&label).unwrap().initial_args;
    assert_eq!(
        args.initial_path.as_deref(),
        Some("ssh://host/notes.md"),
        "a path-only registration must keep the path verbatim"
    );
    assert!(args.root.is_none(), "no root may be invented for a path-only registration");
    assert!(
        !args.needs_root_selection(),
        "a path-only window opens its target — not the history picker"
    );

    // root のみ(ディレクトリの形)。
    let label = wm.register_new_window(None, Some("ssh://host/docs/".into()));
    let args = &wm.get(&label).unwrap().initial_args;
    assert!(
        args.initial_path.is_none(),
        "no initial document may be invented for a root-only registration"
    );
    assert_eq!(
        args.root.as_deref(),
        Some("ssh://host/docs/"),
        "a root-only registration must keep the root verbatim"
    );
    assert!(
        !args.needs_root_selection(),
        "a root-only window opens its folder — not the history picker"
    );
}

/// 5. 連続生成でラベルが一意に採番され、それぞれ登録される。
///    新しく開いたウインドウがアクティブになる(register_window の既存挙動の維持)。
#[test]
fn repeated_new_windows_get_unique_registered_labels() {
    let mut wm: WindowManager<MockRuntime> = WindowManager::new();
    let first = wm.register_new_window(None, None);
    let second = wm.register_new_window(None, None);

    assert_ne!(first, second, "each New Window must get its own label");
    assert_eq!(wm.window_count(), 2, "both windows must be tracked");
    assert!(
        wm.get(&first).is_some() && wm.get(&second).is_some(),
        "both labels must resolve to registered state"
    );
    assert_eq!(
        wm.active_label(),
        Some(second.as_str()),
        "the most recently created window becomes the active one"
    );
}

/// 6. 両経路の両立と後からの取得整合: 引数なしウインドウと path/root ウインドウが
///    同居し、アクティブ切替や他ウインドウの解除が介在しても、後から取得した
///    WindowArgs は登録時のまま(各窓の init_window が後段で参照する値が壊れない)。
#[test]
fn mixed_routes_coexist_and_args_survive_later_retrieval() {
    let mut wm: WindowManager<MockRuntime> = WindowManager::new();
    let argless = wm.register_new_window(None, None);
    let with_target = wm.register_new_window(
        Some("file:///Users/a/docs/readme.md".into()),
        Some("file:///Users/a/docs".into()),
    );

    // 介在操作: アクティブを引数なし側へ戻す。
    wm.set_active(&argless);

    let argless_args = &wm.get(&argless).unwrap().initial_args;
    assert!(
        argless_args.initial_path.is_none() && argless_args.root.is_none(),
        "the argless window's registration must survive later retrieval unchanged"
    );
    assert!(
        argless_args.needs_root_selection(),
        "the argless window still goes to the history picker when queried later"
    );

    let target_args = &wm.get(&with_target).unwrap().initial_args;
    assert_eq!(
        target_args.initial_path.as_deref(),
        Some("file:///Users/a/docs/readme.md"),
        "the path/root window's registration must not be affected by the argless one"
    );
    assert_eq!(target_args.root.as_deref(), Some("file:///Users/a/docs"));
    assert!(!target_args.needs_root_selection());

    // 片方を閉じても、残る側の登録内容に影響しない。
    wm.unregister_window(&argless);
    let target_args = &wm.get(&with_target).unwrap().initial_args;
    assert_eq!(
        target_args.root.as_deref(),
        Some("file:///Users/a/docs"),
        "closing the argless window must not disturb the surviving window's args"
    );
    assert_eq!(wm.window_count(), 1);
}
