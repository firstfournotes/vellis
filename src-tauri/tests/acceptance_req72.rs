//! 要件#72 の受け入れテスト(docs/requirements/req-72.md)— Rust 層
//! (AC-72-1・AC-72-2 の構造面・AC-72-3・AC-72-4)
//!
//! 「配布するアプリ本体に自己点検の起動オプション `--self-check <file>` を持たせ、
//! 指定した文書を描画して CSP 違反・読み込み失敗・Console のエラーを機械で読める形で出す」。
//! 実 WebView での検知・副作用の無いこと(AC-72-8)は /verify の範囲なので、ここでは
//! Tauri を起動せずに判定できる面 ―― CLI の解析・報告の型・起動の計画 ―― を固定する。
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前・型)
//!
//! ```ignore
//! // src-tauri/src/cli.rs
//! pub struct Cli {
//!     /// `--self-check <file>`(契約1)。`hide = true`。`#[cfg(...)]` で外さない。
//!     /// path・-r・-n・--marks・--changed・--fix・--install-cli・--print-build-info と
//!     /// conflicts_with。-v は併用できる。
//!     pub self_check: Option<std::path::PathBuf>,
//!     ...
//! }
//!
//! // src-tauri/src/self_check/mod.rs(新モジュール。lib.rs に `pub mod self_check;`)
//! pub const RECORDER_JS: &str = include_str!("recorder.js");   // 契約4(初期化スクリプト)
//! pub const EXIT_NOT_RUNNABLE: i32 = 6;                         // 契約7
//! pub const TIMEOUT_MS: u64 = 30_000;                           // 契約5
//! pub const QUIET_MS: u64 = 500;                                // 契約5
//!
//! /// `<file>` を絶対パスに解く(相対はカレントディレクトリ基準)。無い・ファイルでない → Err(理由)
//! pub fn resolve_target(path: &std::path::Path) -> Result<std::path::PathBuf, String>;
//!
//! #[derive(Serialize, ...)] #[serde(rename_all = "lowercase")]
//! pub enum SelfCheckStatus { Done, Timeout }                    // "done" / "timeout"
//!
//! /// 記録スクリプト `window.__vellisSelfCheck.snapshot()` が返す記録(JSON・snake_case)。
//! #[derive(Deserialize, ...)]
//! pub struct RecorderSnapshot {
//!     pub csp: Vec<_>,              // [{directive, blocked_uri, source_file, line}]
//!     pub resource_errors: Vec<_>,  // [{tag, attr, resolved}]
//!     pub console_errors: Vec<String>,
//!     pub script_errors: Vec<String>,
//!     pub rejections: Vec<String>,
//!     pub dialogs: Vec<_>,          // [{kind, message}]
//!     pub asset_images: _,          // {loaded, failed}
//! }
//!
//! /// 契約6 の報告。キーはこの 13 個で全部(serde で snake_case のまま)。
//! #[derive(Serialize, ...)]
//! pub struct SelfCheckReport {
//!     pub self_check: u32,   // 1
//!     pub version: String,   // CARGO_PKG_VERSION
//!     pub channel: String,   // features::current_channel().as_str()
//!     pub file: String,      // 絶対パス
//!     pub status: SelfCheckStatus,
//!     pub elapsed_ms: u64,
//!     pub csp: Vec<_>, pub resource_errors: Vec<_>, pub console_errors: Vec<String>,
//!     pub script_errors: Vec<String>, pub rejections: Vec<String>, pub dialogs: Vec<_>,
//!     pub asset_images: _,
//! }
//! impl SelfCheckReport {
//!     pub fn new(file: &std::path::Path, status: SelfCheckStatus, elapsed_ms: u64,
//!                snapshot: RecorderSnapshot) -> Self;
//! }
//!
//! /// 起動の計画(契約8 + 契約3/(g))。true = する・false = しない。
//! #[derive(Debug, Clone, PartialEq, ...)]
//! pub struct StartupPlan {
//!     pub single_instance_lock: bool, // FileLock::try_acquire
//!     pub ipc_server: bool,           // IpcServer::start / spawn_command_handler
//!     pub root_history: bool,         // history::record_root
//!     pub recent_files: bool,         // recent_files::record_file
//!     pub vellis_dir_writes: bool,    // .vellis/(注釈・スナップショット・inbox)
//!     pub spacemouse: bool,           // spacemouse::start(3DxWare / HID)
//!     pub update_check: bool,         // update_check::spawn_poller
//!     pub window_state: bool,         // tauri_plugin_window_state(保存/復元)
//!     pub dock_icon: bool,            // 契約3: Accessory 相当なら false
//!     pub visible_window: bool,       // (g): 画面に窓を出すか
//! }
//! impl StartupPlan {
//!     pub fn normal() -> Self;      // 全部 true
//!     pub fn self_check() -> Self;  // 全部 false
//! }
//! ```
//!
//! main.rs 側(AC-72-2): `cli.self_check` の分岐は `build_request(&cli)` と
//! `IpcClient::probe(` より **前** に置く(ソース走査で固定。`build_request` の値は
//! main.rs の tests モジュール `build_request_self_check_makes_no_request` が見る)。
//!
//! ## 判定しないもの(AC-72-8 = /verify)
//! - 実 WebView で CSP 違反・読み込み失敗が拾えること、窓や Dock に出ないこと、
//!   一時 HOME で何も書かれないこと、終了コード 6 の実挙動

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use clap::error::ErrorKind;
use clap::{CommandFactory, Parser};
use serde_json::{json, Value};

use vellis_lib::cli::Cli;
use vellis_lib::self_check::{
    resolve_target, RecorderSnapshot, SelfCheckReport, SelfCheckStatus, StartupPlan,
    EXIT_NOT_RUNNABLE, QUIET_MS, RECORDER_JS, TIMEOUT_MS,
};

const MAIN_RS: &str = include_str!("../src/main.rs");
const CLI_RS: &str = include_str!("../src/cli.rs");
const LIB_RS: &str = include_str!("../src/lib.rs");

// ---------------------------------------------------------------------------
// AC-72-1: CLI の解析(契約1)
// ---------------------------------------------------------------------------

#[test]
fn ac72_1_self_check_parses_to_a_path() {
    let cli = Cli::try_parse_from(["vellis", "--self-check", "fixtures/sample.md"])
        .expect("--self-check <file> は解析できる");
    assert_eq!(cli.self_check, Some(PathBuf::from("fixtures/sample.md")));
    assert!(cli.path.is_none(), "<file> は位置引数の path ではなく self_check に入る");
}

#[test]
fn ac72_1_self_check_requires_a_value() {
    let err = Cli::try_parse_from(["vellis", "--self-check"])
        .expect_err("値なしの --self-check はエラー(<file> が要る)");
    assert_ne!(err.kind(), ErrorKind::DisplayHelp, "ヘルプ表示ではなく解析エラー: {err:?}");
    assert_ne!(err.kind(), ErrorKind::DisplayVersion);
}

#[test]
fn ac72_1_self_check_is_hidden_from_help() {
    let mut cmd = Cli::command();
    let long = cmd.render_long_help().to_string();
    let short = cmd.render_help().to_string();
    assert!(!long.contains("self-check"), "--help(long)に self-check が出ている:\n{long}");
    assert!(!short.contains("self-check"), "--help(short)に self-check が出ている:\n{short}");
    // 隠しても普通のオプションは出ている(ヘルプそのものが壊れていない)
    assert!(long.contains("--print-build-info"));
}

/// 契約1 の同時指定: それぞれ clap の ArgumentConflict になる。
#[test]
fn ac72_1_self_check_conflicts_with_other_modes() {
    let cases: &[&[&str]] = &[
        &["vellis", "--self-check", "a.md", "other.md"],          // 位置引数 path
        &["vellis", "--self-check", "a.md", "-r"],                // -r
        &["vellis", "--self-check", "a.md", "--root"],            // --root
        &["vellis", "--self-check", "a.md", "-n"],                // -n
        &["vellis", "--self-check", "a.md", "--new-window"],      // --new-window
        &["vellis", "--self-check", "a.md", "--marks"],           // --marks
        &["vellis", "--self-check", "a.md", "--changed"],         // --changed
        &["vellis", "--self-check", "a.md", "--fix", "claude"],   // --fix
        &["vellis", "--self-check", "a.md", "--install-cli"],     // --install-cli
        &["vellis", "--self-check", "a.md", "--print-build-info"], // --print-build-info
        &["vellis", "--print-build-info", "--self-check", "a.md"], // 順序を入れ替えても
        &["vellis", "other.md", "--self-check", "a.md"],
    ];
    for argv in cases {
        let err = Cli::try_parse_from(*argv)
            .err()
            .unwrap_or_else(|| panic!("{argv:?} は同時指定できないのでエラーになるべき"));
        assert_eq!(
            err.kind(),
            ErrorKind::ArgumentConflict,
            "{argv:?} は ArgumentConflict になるべき: {err}"
        );
    }
}

#[test]
fn ac72_1_self_check_combines_with_verbose() {
    let cli = Cli::try_parse_from(["vellis", "-vv", "--self-check", "a.md"])
        .expect("-v は --self-check と併用できる");
    assert_eq!(cli.verbose, 2);
    assert_eq!(cli.self_check, Some(PathBuf::from("a.md")));

    let cli = Cli::try_parse_from(["vellis", "--self-check", "a.md", "-v"]).expect("後置の -v も可");
    assert_eq!(cli.verbose, 1);
}

/// 契約1: release ビルド・タグのビルドにも入る(feature / debug_assertions で外さない)。
/// `long = "self-check"` の arg 属性と、その直前数行に `#[cfg(` が無いこと、`hide` が付くこと。
#[test]
fn ac72_1_self_check_option_is_not_cfg_gated_and_is_hidden() {
    let lines: Vec<&str> = CLI_RS.lines().collect();
    let idx = lines
        .iter()
        .position(|l| l.contains("long = \"self-check\""))
        .expect("cli.rs に long = \"self-check\" の #[arg] がある");
    // #[arg(...)] は複数行に割れていてもよいので、前後の数行をまとめて見る
    let around = lines[idx.saturating_sub(6)..(idx + 8).min(lines.len())].join("\n");
    assert!(
        around.contains("hide"),
        "#[arg(long = \"self-check\", hide = true, ...)] である:\n{around}"
    );
    let before = &lines[idx.saturating_sub(6)..idx];
    assert!(
        !before.iter().any(|l| l.contains("#[cfg(") || l.contains("cfg_attr(")),
        "--self-check は #[cfg] で外さない(release にも入れる): {before:?}"
    );
}

// ---------------------------------------------------------------------------
// AC-72-2(構造面): 点検への分岐は IPC の probe と要求の組み立てより前(契約2)
// ---------------------------------------------------------------------------

#[test]
fn ac72_2_main_branches_to_self_check_before_ipc_probe() {
    let branch = MAIN_RS
        .find("cli.self_check")
        .expect("main.rs が cli.self_check で分岐する");
    let probe = MAIN_RS
        .find("IpcClient::probe(")
        .expect("main.rs は既存インスタンスを probe する");
    let request = MAIN_RS
        .find("build_request(&cli)")
        .expect("main.rs は build_request(&cli) を呼ぶ");
    assert!(branch < probe, "self_check の分岐は IpcClient::probe より前にある");
    assert!(branch < request, "self_check の分岐は build_request(&cli) の呼び出しより前にある");
    assert!(
        MAIN_RS.contains("self_check::"),
        "main.rs は vellis_lib::self_check へ分岐する"
    );
}

// ---------------------------------------------------------------------------
// AC-72-3: 報告の型(契約6)・記録 → 報告(契約4/6)・`<file>` の解決(契約7)
// ---------------------------------------------------------------------------

/// 契約6 のトップレベルのキー(これで全部)。
const REPORT_KEYS: [&str; 13] = [
    "self_check",
    "version",
    "channel",
    "file",
    "status",
    "elapsed_ms",
    "csp",
    "resource_errors",
    "console_errors",
    "script_errors",
    "rejections",
    "dialogs",
    "asset_images",
];

fn keys(v: &Value) -> BTreeSet<String> {
    v.as_object()
        .unwrap_or_else(|| panic!("object expected, got {v}"))
        .keys()
        .cloned()
        .collect()
}

fn empty_snapshot_json() -> String {
    json!({
        "csp": [],
        "resource_errors": [],
        "console_errors": [],
        "script_errors": [],
        "rejections": [],
        "dialogs": [],
        "asset_images": {"loaded": 0, "failed": 0}
    })
    .to_string()
}

fn full_snapshot_json() -> String {
    json!({
        "csp": [{
            "directive": "img-src",
            "blocked_uri": "https://example.com/a.png",
            "source_file": "tauri://localhost/_app/x.js",
            "line": 12
        }],
        "resource_errors": [{
            "tag": "img",
            "attr": "vellis-asset://local/repo/fixtures/x",
            "resolved": "vellis-asset://local/repo/fixtures/x"
        }],
        "console_errors": ["Failed to load resource: vellis-asset://local/repo/fixtures/x"],
        "script_errors": ["Uncaught TypeError: boom"],
        "rejections": ["Error: nope"],
        "dialogs": [{"kind": "alert", "message": "XSS via onerror"}],
        "asset_images": {"loaded": 1, "failed": 1}
    })
    .to_string()
}

fn report_json(status: SelfCheckStatus, elapsed_ms: u64, snapshot: &str) -> Value {
    let snapshot: RecorderSnapshot =
        serde_json::from_str(snapshot).expect("記録スクリプトの記録(JSON)を RecorderSnapshot に読める");
    let report = SelfCheckReport::new(Path::new("/abs/dir/sample.md"), status, elapsed_ms, snapshot);
    serde_json::to_value(&report).expect("SelfCheckReport は Serialize")
}

#[test]
fn ac72_3_report_keys_are_exactly_contract_6_with_empty_arrays() {
    let v = report_json(SelfCheckStatus::Done, 1234, &empty_snapshot_json());
    let expected: BTreeSet<String> = REPORT_KEYS.iter().map(|s| s.to_string()).collect();
    assert_eq!(keys(&v), expected, "トップレベルのキーは契約6 で全部(過不足なし)");

    assert_eq!(v["self_check"], json!(1));
    assert_eq!(v["version"], json!(env!("CARGO_PKG_VERSION")));
    assert_eq!(
        v["channel"],
        json!(vellis_lib::features::current_channel().as_str()),
        "channel は build-info と同じ源(release|dev)"
    );
    assert!(
        matches!(v["channel"].as_str(), Some("release") | Some("dev")),
        "channel は release|dev"
    );
    assert_eq!(v["file"], json!("/abs/dir/sample.md"));
    assert_eq!(v["status"], json!("done"));
    assert_eq!(v["elapsed_ms"], json!(1234));
    assert!(v["elapsed_ms"].is_u64(), "elapsed_ms は整数");

    // 配列は空でも出る
    for key in ["csp", "resource_errors", "console_errors", "script_errors", "rejections", "dialogs"] {
        assert_eq!(v[key], json!([]), "{key} は空配列として出る");
    }
    assert_eq!(v["asset_images"], json!({"loaded": 0, "failed": 0}));
    assert_eq!(
        keys(&v["asset_images"]),
        ["loaded", "failed"].iter().map(|s| s.to_string()).collect()
    );
}

#[test]
fn ac72_3_report_is_built_from_recorder_snapshot() {
    let v = report_json(SelfCheckStatus::Done, 2500, &full_snapshot_json());

    assert_eq!(v["csp"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        keys(&v["csp"][0]),
        ["directive", "blocked_uri", "source_file", "line"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    );
    assert_eq!(v["csp"][0]["directive"], json!("img-src"));
    assert_eq!(v["csp"][0]["blocked_uri"], json!("https://example.com/a.png"));
    assert_eq!(v["csp"][0]["source_file"], json!("tauri://localhost/_app/x.js"));
    assert_eq!(v["csp"][0]["line"], json!(12));
    assert!(v["csp"][0]["line"].is_u64() || v["csp"][0]["line"].is_i64(), "line は整数");

    assert_eq!(
        keys(&v["resource_errors"][0]),
        ["tag", "attr", "resolved"].iter().map(|s| s.to_string()).collect()
    );
    assert_eq!(v["resource_errors"][0]["tag"], json!("img"));
    assert_eq!(
        v["resource_errors"][0]["resolved"],
        json!("vellis-asset://local/repo/fixtures/x")
    );

    assert_eq!(
        v["console_errors"],
        json!(["Failed to load resource: vellis-asset://local/repo/fixtures/x"])
    );
    assert_eq!(v["script_errors"], json!(["Uncaught TypeError: boom"]));
    assert_eq!(v["rejections"], json!(["Error: nope"]));
    assert_eq!(v["dialogs"], json!([{"kind": "alert", "message": "XSS via onerror"}]));
    assert_eq!(
        keys(&v["dialogs"][0]),
        ["kind", "message"].iter().map(|s| s.to_string()).collect()
    );
    assert_eq!(v["asset_images"], json!({"loaded": 1, "failed": 1}));
}

#[test]
fn ac72_3_status_serializes_as_done_or_timeout() {
    assert_eq!(serde_json::to_value(SelfCheckStatus::Done).unwrap(), json!("done"));
    assert_eq!(serde_json::to_value(SelfCheckStatus::Timeout).unwrap(), json!("timeout"));

    // 時間切れでも、その時点までの記録を載せて出す(契約5)
    let v = report_json(SelfCheckStatus::Timeout, 30_000, &full_snapshot_json());
    assert_eq!(v["status"], json!("timeout"));
    assert_eq!(v["csp"].as_array().map(Vec::len), Some(1));
    let expected: BTreeSet<String> = REPORT_KEYS.iter().map(|s| s.to_string()).collect();
    assert_eq!(keys(&v), expected);
}

#[test]
fn ac72_3_report_serializes_to_a_single_line() {
    let v = report_json(SelfCheckStatus::Done, 1, &full_snapshot_json());
    let line = serde_json::to_string(&v).unwrap();
    assert!(!line.contains('\n'), "標準出力に出す JSON は 1 行(契約6)");
}

/// 契約5 の定数(30 秒・500ms)と契約7 の終了コード(6)。
#[test]
fn ac72_3_timing_and_exit_code_constants() {
    assert_eq!(TIMEOUT_MS, 30_000);
    assert_eq!(QUIET_MS, 500);
    assert_eq!(EXIT_NOT_RUNNABLE, 6);
}

/// 契約7: `<file>` が無い・ファイルでない → 実行できない(Err)。相対パスは cwd から解決して絶対に。
#[test]
fn ac72_3_resolve_target_rejects_missing_and_non_file_and_absolutizes() {
    let dir = tempfile::tempdir().unwrap();
    let md = dir.path().join("doc.md");
    std::fs::write(&md, "# hi\n").unwrap();

    let ok = resolve_target(&md).expect("存在するファイルは解決できる");
    assert!(ok.is_absolute());
    assert_eq!(
        ok.canonicalize().unwrap(),
        md.canonicalize().unwrap(),
        "同じファイルを指す"
    );

    let missing = resolve_target(&dir.path().join("nope.md"));
    assert!(missing.is_err(), "無いファイルは Err");
    assert!(!missing.unwrap_err().is_empty(), "理由を 1 行持つ");

    let not_a_file = resolve_target(dir.path());
    assert!(not_a_file.is_err(), "ディレクトリは Err");

    // 相対パスはカレントディレクトリから解決する(契約3)
    let cwd = std::env::current_dir().unwrap();
    let rel = PathBuf::from("Cargo.toml");
    assert!(
        cwd.join(&rel).is_file(),
        "前提: cargo test の cwd はクレートのルート(Cargo.toml がある)"
    );
    let resolved = resolve_target(&rel).expect("相対パスも解決できる");
    assert!(resolved.is_absolute(), "絶対パスになる: {resolved:?}");
    assert_eq!(
        resolved.canonicalize().unwrap(),
        cwd.join(&rel).canonicalize().unwrap()
    );
}

// ---------------------------------------------------------------------------
// AC-72-4: 起動の計画(契約8・契約3・(g))
// ---------------------------------------------------------------------------

#[test]
fn ac72_4_self_check_plan_does_none_of_contract_8() {
    let plan = StartupPlan::self_check();
    assert!(!plan.single_instance_lock, "単一インスタンスのロックを取らない");
    assert!(!plan.ipc_server, "IPC サーバを起動しない");
    assert!(!plan.root_history, "root の履歴(history::record_root)を書かない");
    assert!(!plan.recent_files, "Recent Files を書かない");
    assert!(!plan.vellis_dir_writes, ".vellis/(注釈・スナップショット・inbox)に書かない");
    assert!(!plan.spacemouse, "SpaceMouse(3DxWare / HID)を登録しない");
    assert!(!plan.update_check, "更新通知の確認をしない");
    assert!(!plan.window_state, "窓の位置と大きさを保存/復元しない");
    // 契約3 / (g)
    assert!(!plan.dock_icon, "Dock にアイコンを出さない");
    assert!(!plan.visible_window, "画面に窓を出さない");
}

#[test]
fn ac72_4_normal_plan_keeps_everything_on() {
    let plan = StartupPlan::normal();
    assert!(plan.single_instance_lock);
    assert!(plan.ipc_server);
    assert!(plan.root_history);
    assert!(plan.recent_files);
    assert!(plan.vellis_dir_writes);
    assert!(plan.spacemouse);
    assert!(plan.update_check);
    assert!(plan.window_state);
    assert!(plan.dock_icon);
    assert!(plan.visible_window);
    assert_ne!(StartupPlan::normal(), StartupPlan::self_check());
}

/// 計画が死んだ値でないこと: 本番の起動(lib.rs)が StartupPlan を参照している。
#[test]
fn ac72_4_startup_plan_is_consulted_by_lib_rs() {
    assert!(
        LIB_RS.contains("StartupPlan"),
        "lib.rs(run_with_args の経路)が StartupPlan を参照して、ロック/IPC/更新確認/SpaceMouse/window-state を切り替える"
    );
}

// ---------------------------------------------------------------------------
// AC-72-5(Rust 側の半分): 埋め込む記録スクリプトは vitest が読むのと同じファイル
// ---------------------------------------------------------------------------

#[test]
fn ac72_5_recorder_js_is_embedded_from_the_single_source_file() {
    let on_disk = include_str!("../src/self_check/recorder.js");
    assert_eq!(RECORDER_JS, on_disk, "RECORDER_JS = include_str!(\"recorder.js\")");
    assert!(
        RECORDER_JS.contains("__vellisSelfCheck"),
        "記録の取り出し口は window.__vellisSelfCheck"
    );
    assert!(RECORDER_JS.contains("securitypolicyviolation"));
    assert!(RECORDER_JS.contains("unhandledrejection"));
}
