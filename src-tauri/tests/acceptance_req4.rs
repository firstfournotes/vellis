//! 要件#4 の受け入れテスト(requirements.md #4)— Rust 層
//!
//! 「引数なし起動時は履歴選択画面を表示し、選択したフォルダを開ける」
//! 受け入れ基準: 起動分岐がパス引数あり=従来どおり該当パスを開く/
//! 引数なし=履歴選択画面を初期表示し、選択で該当フォルダを開く
//!
//! 判定範囲(本ファイル): 起動分岐の純ロジック。ウィンドウ引数(WindowArgs)から
//! 「履歴選択画面行きか・従来どおり該当パスを開くか」を決める判定が公開メソッドとして
//! 存在し、真偽が基準どおりであることを固定する。
//! tauri コマンド(init_window / list_history)は AppHandle を要するため統合テストでは
//! 呼ばず、履歴一覧のコア(HistoryStore::list)は acceptance_req3.rs で担保済み。
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```ignore
//! // 実装先: src-tauri/src/window/manager.rs
//! impl WindowArgs {
//!     /// true = パス/ルート引数なし → フロントは履歴選択画面を初期表示する。
//!     /// false = 従来どおり該当パス(initial_path / root)を開く。
//!     /// 判定は initial_path と root がともに None であること。
//!     /// --marks / --changed 等のフラグはパス引数ではない(判定に影響しない)。
//!     pub fn needs_root_selection(&self) -> bool;
//! }
//! ```
//!
//! `commands::app::init_window` の既存インライン判定
//! (`initial_path.is_none() && root_arg.is_none()`)は本メソッドへ抽出し、
//! init_window はこれを参照して `needs_root_selection` を返すこと(配線は
//! reviewer 照合 — 本テストは純ロジックの契約のみ機械判定する)。
//!
//! ## reviewer 照合に委ねる項目(AppHandle 依存で機械判定不能)
//! - `list_history` コマンドの追加と invoke_handler への登録
//!   (`history::default_path` の `HistoryStore::list` を最近順で返す。
//!    無し/破損は空 — ストア側契約は acceptance_req3.rs で固定済み)
//! - フロント側の選択画面表示・選択→オープンのビューモデル契約は
//!   src/lib/root-picker.acceptance.test.ts が固定する

use vellis_lib::window::manager::WindowArgs;

/// 1. 引数なし起動(パスも root もなし)= 履歴選択画面行き。
#[test]
fn argless_launch_requires_root_selection() {
    let args = WindowArgs::default();
    assert!(
        args.needs_root_selection(),
        "launch without a path or root argument must go to the history picker screen"
    );
}

/// 2. パス引数あり(ファイル → initial_path)= 従来どおり該当パスを開く。
#[test]
fn file_path_argument_opens_target_as_before() {
    let args = WindowArgs {
        initial_path: Some("file:///Users/a/docs/readme.md".into()),
        ..WindowArgs::default()
    };
    assert!(
        !args.needs_root_selection(),
        "a file path argument must open that path as before (no picker screen)"
    );
}

/// 3. ルート引数あり(ディレクトリ / -r → root)= 従来どおり該当フォルダを開く。
#[test]
fn root_argument_opens_target_as_before() {
    let args = WindowArgs {
        root: Some("file:///Users/a/docs".into()),
        ..WindowArgs::default()
    };
    assert!(
        !args.needs_root_selection(),
        "a root argument must open that folder as before (no picker screen)"
    );
}

/// 3b. 両方あり(ファイル+ルート)も従来どおり開く。
#[test]
fn both_path_and_root_open_target_as_before() {
    let args = WindowArgs {
        initial_path: Some("file:///Users/a/docs/readme.md".into()),
        root: Some("file:///Users/a/docs".into()),
        ..WindowArgs::default()
    };
    assert!(
        !args.needs_root_selection(),
        "path + root together must open the target as before (no picker screen)"
    );
}

/// 4. 境界: サイドバー系フラグ(--marks / --changed)はパス引数ではない。
///    `vellis --marks`(パスなし)は引数なし扱いのまま履歴選択画面行き。
#[test]
fn sidebar_flags_alone_still_require_root_selection() {
    let args = WindowArgs {
        show_marks: true,
        show_changed: true,
        ..WindowArgs::default()
    };
    assert!(
        args.needs_root_selection(),
        "--marks / --changed without a path is still an argless launch → picker screen"
    );
}
