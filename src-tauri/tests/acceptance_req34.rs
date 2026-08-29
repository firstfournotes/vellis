//! 要件#34 の受け入れテスト(requirements.md #34)— Rust 層
//!
//! 「開いているウィンドウと同じ内容の新規ウィンドウを開く複製(Duplicate Window)機能。
//!  メニューバーとファイルツリーの右クリックメニューのどちらからでも起動できる」
//!
//! 契約(2026-08-29 由谷決定):
//! - ①「同じ内容」= {rootUri, docUri, expandedDirs}(reload-state=要件#10 と同じ
//!   3点セット。スクロール位置・マーク一覧開閉はスコープ外・ペイン幅は全窓共有=要件#9)
//! - ② メニューバー= File > Duplicate Window(New Window の直後・CmdOrCtrl+Shift+N)
//! - ③ ツリー側右クリック=要件#19 のアイテムメニュー末尾に区切り+「ウィンドウを複製」
//!   (ファイル/フォルダ全種・ssh でも常に enabled =アイテム非依存の窓操作)+
//!   ツリー空白部分の右クリックでも同項目のメニュー
//! - ④ root 未設定(履歴選択画面)の窓での複製=履歴選択画面をもう1枚
//!   (New Window 相当)
//!
//! 本ファイルの持ち場(Rust 層の機械判定):
//! - `WindowArgs` の `expanded_dirs` 拡張(Default =空)と、複製経路の新シーム
//!   `register_new_window_with_dirs` の verbatim 登録(要件の機械判定点
//!   「WindowArgs 拡張の登録内容」)。既存2引数 `register_new_window` の
//!   デグレなし(登録される expanded_dirs は空)もここで固定
//! - メニュー定数2つの値固定(フロント `src/lib/duplicate-window.ts` /
//!   `src/lib/context-menu.ts` 側は同じリテラルを vitest で固定しており、
//!   両側のリテラル固定で名前の同期が保証される)
//! - `InitWindowResponse` に `expanded_dirs` がシリアライズされること
//!   (新窓の `init_window` が initial_args から流す値=フロントの展開復元の入口)
//!
//! フロント側(planDuplicateWindow・registerDuplicateWindowListener・
//! コンテキストメニューの出し分け)は `src/lib/duplicate-window.acceptance.test.ts` と
//! `src/lib/context-menu.acceptance.test.ts` が判定する。
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```ignore
//! // src-tauri/src/window/manager.rs
//! pub struct WindowArgs {
//!     // ...既存4フィールド(initial_path / root / show_marks / show_changed)...
//!     /// 複製元ウィンドウの展開ディレクトリ URI(要件#34)。Default で空。
//!     pub expanded_dirs: Vec<String>,
//! }
//!
//! impl<R: tauri::Runtime> WindowManager<R> {
//!     /// 既存シームはシグネチャ・挙動とも現状維持(要件#12 の契約のまま)。
//!     /// 登録される expanded_dirs は空 — 展開を持たない従来経路のデグレなしは
//!     /// この形で判定する。
//!     pub fn register_new_window(
//!         &mut self,
//!         path: Option<String>,
//!         root: Option<String>,
//!     ) -> String;
//!
//!     /// 複製経路用の新シーム。値は **verbatim** に登録する — 重複除去・
//!     /// 末尾スラッシュの正規化・root 配下フィルタはフロント
//!     /// (planDuplicateWindow)の持ち場で、ここでは一切変形しない
//!     /// (path / root と同じ req12 の家風)。既存 register_new_window との
//!     /// 関係(内部委譲か独立実装か)は実装裁量。
//!     pub fn register_new_window_with_dirs(
//!         &mut self,
//!         path: Option<String>,
//!         root: Option<String>,
//!         expanded_dirs: Vec<String>,
//!     ) -> String;
//! }
//!
//! // src-tauri/src/commands/window.rs
//! //   new_window コマンドに省略可能な expanded_dirs: Option<Vec<String>> を追加
//! //   (フロントからは expandedDirs キー。None =空 Vec として
//! //    register_new_window_with_dirs へ・既存呼び出しは不変)
//! // src-tauri/src/commands/app.rs
//! //   InitWindowResponse に pub expanded_dirs: Vec<String> を追加(initial_args から流す)
//! // src-tauri/src/menu.rs
//! //   pub const DUPLICATE_WINDOW_ITEM_ID: &str = "duplicate-window";
//! //   pub const MENU_DUPLICATE_WINDOW_EVENT: &str = "menu_duplicate_window";
//! ```
//!
//! ## 既存テストへの波及(オーケストレーターの要件側更新に委ねる — implementer は触らない)
//! - `register_new_window` は2引数のまま現状維持のため `acceptance_req12.rs` は
//!   影響を受けない。`WindowArgs` / `InitWindowResponse` のフィールド追加で
//!   `src-tauri/src` 内 unit テストの構造体リテラルが実装後にコンパイル赤になる —
//!   この機械的更新は実装後にオーケストレーターが要件側判断で行う。
//!
//! ## reviewer 照合に委ねる項目(AppHandle 依存で機械判定不能な配線)
//! - File メニューに Duplicate Window 項目(New Window の直後・CmdOrCtrl+Shift+N)が
//!   存在し、クリックでフォーカス中ウィンドウへ MENU_DUPLICATE_WINDOW_EVENT を
//!   emit_to すること(menu_open_* と同型。受信側の窓限定購読=要件#33 が前提)
//! - `new_window` コマンドが expanded_dirs を register_new_window_with_dirs へ
//!   流すこと(None =空 Vec)・expandedDirs なしの既存呼び出しの挙動不変
//! - `init_window` が initial_args.expanded_dirs を InitWindowResponse へ流すこと
//!
//! ## 人間ゲート(acceptance/acceptance.md)
//! - 実機での複製結果(同 root・同文書・同展開・履歴選択画面の複製・空白部メニュー)

use tauri::test::MockRuntime;
use vellis_lib::window::manager::{WindowArgs, WindowManager};

// ---------------------------------------------------------------------------
// WindowArgs — expanded_dirs 拡張(既定=空)
// ---------------------------------------------------------------------------

/// 1. WindowArgs の既定は展開なし(Default =空)。従来の生成経路
///    (for_open_target 等= ..Default::default())が展開を発明しないことの固定。
#[test]
fn window_args_expanded_dirs_defaults_to_empty() {
    let args = WindowArgs::default();
    assert!(
        args.expanded_dirs.is_empty(),
        "WindowArgs::default() must carry no expanded dirs"
    );
    // 既存の分類シームも既定のまま=展開を発明しない。
    let opened = WindowArgs::for_open_target("ssh://host/docs/");
    assert!(
        opened.expanded_dirs.is_empty(),
        "for_open_target must not invent expanded dirs"
    );
}

// ---------------------------------------------------------------------------
// register_new_window_with_dirs — 展開ディレクトリの verbatim 登録(複製経路の新シーム)
// ---------------------------------------------------------------------------

/// 2. 複製の登録: path / root / expanded_dirs がそのまま WindowArgs へ入り、
///    返されたラベルで取得できる(要件の機械判定点「WindowArgs 拡張の登録内容」)。
#[test]
fn register_new_window_with_dirs_registers_expanded_dirs_verbatim() {
    let mut wm: WindowManager<MockRuntime> = WindowManager::new();
    let dirs = vec![
        "file:///Users/a/docs/sub".to_string(),
        "file:///Users/a/docs/My Notes".to_string(),
        "file:///Users/a/docs/sub/deep".to_string(),
    ];
    let label = wm.register_new_window_with_dirs(
        Some("file:///Users/a/docs/readme.md".into()),
        Some("file:///Users/a/docs".into()),
        dirs.clone(),
    );

    let state = wm
        .get(&label)
        .expect("the duplicated window must be registered under the returned label");
    let args = &state.initial_args;
    assert_eq!(
        args.expanded_dirs, dirs,
        "expanded dirs must be registered verbatim (same values, same order)"
    );
    // 既存2引数のセマンティクスはそのまま(デグレなし)。
    assert_eq!(
        args.initial_path.as_deref(),
        Some("file:///Users/a/docs/readme.md"),
        "path must keep travelling verbatim alongside expanded dirs"
    );
    assert_eq!(
        args.root.as_deref(),
        Some("file:///Users/a/docs"),
        "root must keep travelling verbatim alongside expanded dirs"
    );
    assert!(
        !args.needs_root_selection(),
        "a duplicate with a root opens that root — not the history picker"
    );
    assert!(
        !args.show_marks && !args.show_changed,
        "sidebar flags stay off for duplicated windows (launch-only flags)"
    );
}

/// 3. verbatim の境界: 重複・末尾スラッシュ・root 配下でない URI ・ssh URI も
///    変形せずそのまま登録される。整形(重複除去・初出順)はフロントの
///    planDuplicateWindow の持ち場で、Rust 側は何も足さず何も引かない
///    (req12 の「nothing is derived, invented or collapsed here」と同じ家風)。
#[test]
fn register_new_window_with_dirs_does_not_normalize_expanded_dirs() {
    let mut wm: WindowManager<MockRuntime> = WindowManager::new();
    let dirs = vec![
        "ssh://alice@host:22/srv/notes/sub".to_string(),
        "ssh://alice@host:22/srv/notes/sub".to_string(), // 重複もそのまま
        "file:///elsewhere/outside".to_string(),         // root 配下でなくてもそのまま
        "ssh://alice@host:22/srv/notes/deep/".to_string(), // 末尾スラッシュもそのまま
    ];
    let label = wm.register_new_window_with_dirs(
        None,
        Some("ssh://alice@host:22/srv/notes".into()),
        dirs.clone(),
    );

    let args = &wm.get(&label).unwrap().initial_args;
    assert_eq!(
        args.expanded_dirs, dirs,
        "the manager must not dedupe, filter or normalise expanded dirs — verbatim only"
    );
}

/// 4. 契約④の Rust 側: root 未設定の窓の複製=空引数+空展開で登録され、
///    引数なし起動(WindowArgs::default())と全フィールド同じ状態 —
///    needs_root_selection()=true で新窓は履歴選択画面をもう1枚出す
///    (New Window 相当。acceptance_req12 の argless ケースの複製経路版)。
#[test]
fn register_new_window_with_dirs_empty_matches_argless_launch() {
    let mut wm: WindowManager<MockRuntime> = WindowManager::new();
    let label = wm.register_new_window_with_dirs(None, None, Vec::new());

    let args = &wm.get(&label).unwrap().initial_args;
    assert!(args.initial_path.is_none(), "no initial_path may be invented");
    assert!(args.root.is_none(), "no root may be invented");
    assert!(args.expanded_dirs.is_empty(), "no expanded dirs may be invented");
    assert!(
        args.needs_root_selection(),
        "duplicating a root-less window must open another history picker \
         (New Window 相当=契約④)"
    );
    let default = WindowArgs::default();
    assert_eq!(args.show_marks, default.show_marks);
    assert_eq!(args.show_changed, default.show_changed);
}

/// 5. デグレなし: 既存2引数の register_new_window はシグネチャ・挙動とも現状維持で、
///    登録される expanded_dirs は空(要件#12 の契約はそのまま。acceptance_req12 は
///    本要件の影響を受けない)。
#[test]
fn two_arg_register_new_window_keeps_registering_empty_expanded_dirs() {
    let mut wm: WindowManager<MockRuntime> = WindowManager::new();

    // 引数なし(New Window メニュー経路)。
    let argless = wm.register_new_window(None, None);
    assert!(
        wm.get(&argless).unwrap().initial_args.expanded_dirs.is_empty(),
        "the existing argless route must keep registering no expanded dirs"
    );

    // path/root あり(既存 new_window コマンド経路)。
    let with_target = wm.register_new_window(
        Some("file:///Users/a/docs/readme.md".into()),
        Some("file:///Users/a/docs".into()),
    );
    let args = &wm.get(&with_target).unwrap().initial_args;
    assert!(
        args.expanded_dirs.is_empty(),
        "the existing path/root route must keep registering no expanded dirs"
    );
    assert_eq!(
        args.initial_path.as_deref(),
        Some("file:///Users/a/docs/readme.md"),
        "the existing route keeps registering path verbatim (unchanged behaviour)"
    );
    assert_eq!(
        args.root.as_deref(),
        Some("file:///Users/a/docs"),
        "the existing route keeps registering root verbatim (unchanged behaviour)"
    );
}

// ---------------------------------------------------------------------------
// menu.rs — 定数の値固定(項目 ID とイベント名)
// ---------------------------------------------------------------------------

/// 6. メニュー項目 ID は "duplicate-window" 固定(new-window / open-file と同じ
///    kebab-case の家風)。
#[test]
fn duplicate_window_item_id_is_fixed() {
    assert_eq!(vellis_lib::menu::DUPLICATE_WINDOW_ITEM_ID, "duplicate-window");
}

/// 7. Webview への通知イベント名は "menu_duplicate_window" 固定(menu_open_* と
///    同じ snake_case)。フロント duplicate-window.ts の同名定数と同じリテラルで
///    あることが両側のテストで固定される。
#[test]
fn menu_duplicate_window_event_is_fixed() {
    assert_eq!(
        vellis_lib::menu::MENU_DUPLICATE_WINDOW_EVENT,
        "menu_duplicate_window"
    );
}

// ---------------------------------------------------------------------------
// InitWindowResponse — expanded_dirs のシリアライズ(新窓の復元入口)
// ---------------------------------------------------------------------------

/// 8. InitWindowResponse は expanded_dirs を値・順序そのままの JSON 配列で
///    シリアライズする(新窓のフロントがツリー展開の復元に読む形)。
#[test]
fn init_window_response_serializes_expanded_dirs() {
    use vellis_lib::commands::app::InitWindowResponse;

    let resp = InitWindowResponse {
        window_id: "vellis-2".into(),
        root_uri: "file:///Users/a/docs".into(),
        entries: vec![],
        initial_path: Some("file:///Users/a/docs/readme.md".into()),
        version: "0.1.0".into(),
        needs_root_selection: false,
        show_marks: false,
        show_changed: false,
        expanded_dirs: vec![
            "file:///Users/a/docs/sub".into(),
            "file:///Users/a/docs/My Notes".into(),
        ],
    };

    let v = serde_json::to_value(&resp).expect("InitWindowResponse must serialize");
    assert_eq!(
        v.get("expanded_dirs"),
        Some(&serde_json::json!([
            "file:///Users/a/docs/sub",
            "file:///Users/a/docs/My Notes"
        ])),
        "expanded_dirs must serialize as a JSON array, values and order verbatim"
    );
}

/// 9. 展開なしの窓(従来経路すべて)では空配列としてシリアライズされる —
///    フィールドが省略されず、フロントが常に読める形であること。
#[test]
fn init_window_response_serializes_empty_expanded_dirs_as_empty_array() {
    use vellis_lib::commands::app::InitWindowResponse;

    let resp = InitWindowResponse {
        window_id: "vellis-1".into(),
        root_uri: "file:///Users/a/docs".into(),
        entries: vec![],
        initial_path: None,
        version: "0.1.0".into(),
        needs_root_selection: false,
        show_marks: false,
        show_changed: false,
        expanded_dirs: vec![],
    };

    let v = serde_json::to_value(&resp).expect("InitWindowResponse must serialize");
    assert_eq!(
        v.get("expanded_dirs"),
        Some(&serde_json::json!([])),
        "an empty expansion must still be present as [] (not omitted)"
    );
}
