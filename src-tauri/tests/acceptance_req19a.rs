//! 要件#19 追補a の受け入れテスト(docs/requirements/req-19.md「追補a」・AC-19-追a (a)〜(c)・
//! Issue #418 = backlog 48)
//!
//! 「既定アプリで開く」(と要件#21 の「アプリを選択して開く…」)が、名前が「.」で始まる
//! フォルダの下(`~/.config/…`・`~/.claude/…`)のファイルで失敗する。opener の path scope
//! `"**"` は既定で `require_literal_leading_dot = true` なので、途中に「.」で始まる要素を
//! 含むパスに当たらない。
//!
//! 契約(追補a):
//! 1. `src-tauri/tauri.conf.json` の `plugins.opener.requireLiteralLeadingDot` を `false` にする
//! 2. 許可の範囲(`capabilities/default.json` の `opener:allow-open-path` の `"**"`・
//!    `opener:allow-reveal-item-in-dir`)は変えない
//!
//! 判定範囲(本ファイル・AC 番号は req-19.md「追補a」の受け入れ基準):
//! - **AC-19-追a (a)** `tauri.conf.json` の `plugins.opener.requireLiteralLeadingDot` が `false`
//!   (設定の走査)。opener の設定構造体(`tauri-plugin-opener` の `Config`)は
//!   `rename_all = "camelCase"` + `deny_unknown_fields` なので、綴りは camelCase で**この
//!   キーだけ**であることも固定する(snake_case で書くと起動時に plugin の初期化が失敗する)
//! - **AC-19-追a (b)** capability の opener の許可が追補a の前と同じ(`"**"` のまま・項目が
//!   増えていない)。`opener:` で始まる permission の並びを JSON 値ごと登録時の形と突き合わせる
//! - **AC-19-追a (c)** opener と同じ glob の規則で `/Users/u/.config/a.md`・
//!   `/Users/u/.claude/x/y.txt` が `"**"` に当たる(規則の確かめ。`require_literal_leading_dot
//!   = true` では当たらないことも固定)
//!
//! ## (c) の判定経路について(依存追加なし)
//!
//! `glob` crate は `src-tauri/Cargo.toml` の直接の依存ではない(opener と tauri 経由の
//! 間接依存のみ)ので、`glob::MatchOptions` を直接組むことはしない。代わりに
//! **opener が path scope の判定に使っている当の経路**= tauri の fs scope
//! (`tauri::scope::fs::Scope`)を通す。`tauri-plugin-opener` 2.5.3 の `Scope::is_path_allowed`
//! (`src/scope.rs`)は tauri の fs scope を
//! `Scope::new(manager, &FsScope::Scope { allow, deny, require_literal_leading_dot })` で組んで
//! `is_allowed(path)` を呼ぶだけで、`require_literal_leading_dot` には plugin 設定
//! (`plugins.opener.requireLiteralLeadingDot`)の値がそのまま入る。tauri 2.10.3 の
//! `Scope::new`(`src/scope/fs.rs`)はその値から `glob::MatchOptions { require_literal_separator:
//! true, require_literal_leading_dot, .. }` を組む。つまり本テストの
//! `FsScope::Scope { require_literal_leading_dot: Some(x) }` → `is_allowed` は、opener の
//! 判定そのものである。tauri は直接依存(dev では `features = ["test"]`)で、`mock_app()` は
//! 既存テスト(acceptance_req22 / req71)と同じ使い方。
//!
//! 赤の設計: 実装前は `tauri.conf.json` に `plugins` 節が無い。(a) の 2 件はキーが無いので
//! 失敗し、(c) のうち「設定値をそのまま流す」1 件は未設定= unix 既定の `true` になって
//! 「.」付きパスが当たらず失敗する。(b) と (c) の規則固定(`Some(false)` / `Some(true)`)は
//! 不変条件・規則の確かめなので最初から緑(退行防止)。
//!
//! 既存の acceptance(`src/lib/context-menu.acceptance.test.ts` の capability 検査=AC-19-8)は
//! 変更しない。

use serde_json::{json, Value};
use tauri::scope::fs::Scope;
use tauri::utils::config::{Config, FsScope};

/// tauri.conf.json / capability は既存テスト(acceptance_req25a / req68 の include_str! 方式)に
/// 倣ってコンパイル時に取り込む。テストファイル基準の相対= `src-tauri/` 配下。
const TAURI_CONF: &str = include_str!("../tauri.conf.json");
const CAPABILITY: &str = include_str!("../capabilities/default.json");

/// 契約1 のキー(opener の `Config` は `rename_all = "camelCase"`)。
const OPENER_KEY: &str = "requireLiteralLeadingDot";

/// AC-19-追a (c) が当たることを求めるパス(「.」で始まる要素を途中に含む)。
const DOTTED_PATHS: &[&str] = &["/Users/u/.config/a.md", "/Users/u/.claude/x/y.txt"];

/// 「.」を含まない対照パス。scope が機能していること(= 偽が「.」の規則によるもの)の確認用。
const PLAIN_PATH: &str = "/Users/u/docs/a.md";

fn conf_value() -> Value {
    serde_json::from_str(TAURI_CONF).expect("tauri.conf.json must be valid JSON")
}

fn capability_value() -> Value {
    serde_json::from_str(CAPABILITY).expect("capabilities/default.json must be valid JSON")
}

/// `plugins.opener.requireLiteralLeadingDot` の値(無ければ `None`)。
fn configured_require_literal_leading_dot() -> Option<bool> {
    conf_value()
        .pointer(&format!("/plugins/opener/{OPENER_KEY}"))
        .map(|v| {
            v.as_bool().unwrap_or_else(|| {
                panic!("plugins.opener.{OPENER_KEY} must be a JSON boolean, got {v}")
            })
        })
}

/// opener と同じ経路で path scope を組む: allow は capability と同じ `"**"` 1 本・deny なし。
fn opener_path_scope(require_literal_leading_dot: Option<bool>) -> Scope {
    let app = tauri::test::mock_app();
    Scope::new(
        &app,
        &FsScope::Scope {
            allow: vec!["**".into()],
            deny: vec![],
            require_literal_leading_dot,
        },
    )
    .expect("fs scope must build from allow [\"**\"]")
}

// ---------------------------------------------------------------------------
// AC-19-追a (a): tauri.conf.json の plugins.opener.requireLiteralLeadingDot = false
// ---------------------------------------------------------------------------

/// (a)-1 `plugins.opener.requireLiteralLeadingDot` が JSON の `false`(契約1)。
/// 併せて、設定全体が `tauri::utils::config::Config`(`deny_unknown_fields`)として読めること
/// = `plugins` 節がトップレベルの正しい場所にあることを前提に置く。
#[test]
fn ac19a_a1_tauri_conf_sets_require_literal_leading_dot_false() {
    serde_json::from_str::<Config>(TAURI_CONF).unwrap_or_else(|e| {
        panic!("tauri.conf.json must parse as tauri::utils::config::Config (deny_unknown_fields): {e}")
    });

    let value = conf_value();
    let opener = value
        .pointer("/plugins/opener")
        .unwrap_or_else(|| panic!("tauri.conf.json must have a top-level plugins.opener object (契約1)"));
    assert!(
        opener.is_object(),
        "plugins.opener must be a JSON object, got {opener}"
    );

    assert_eq!(
        configured_require_literal_leading_dot(),
        Some(false),
        "plugins.opener.{OPENER_KEY} must be false (契約1)"
    );
}

/// (a)-2 `plugins.opener` のキーは camelCase の `requireLiteralLeadingDot` だけ。
/// opener の `Config` は `deny_unknown_fields` なので、snake_case(`require_literal_leading_dot`)
/// や他のキーがあると plugin の初期化が失敗し、設定が効かないどころか opener 全体が死ぬ。
#[test]
fn ac19a_a2_plugins_opener_has_only_the_camel_case_key() {
    let value = conf_value();
    let opener = value
        .pointer("/plugins/opener")
        .and_then(Value::as_object)
        .unwrap_or_else(|| panic!("tauri.conf.json must have a plugins.opener object (契約1)"));

    let keys: Vec<&str> = opener.keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        vec![OPENER_KEY],
        "plugins.opener must contain exactly the camelCase key {OPENER_KEY:?} (opener Config is deny_unknown_fields); got {keys:?}"
    );
    assert!(
        !opener.contains_key("require_literal_leading_dot"),
        "snake_case require_literal_leading_dot is rejected by the opener plugin config"
    );
}

// ---------------------------------------------------------------------------
// AC-19-追a (b): capability の opener の許可は追補a の前と同じ
// ---------------------------------------------------------------------------

/// (b) `opener:` で始まる permission の並び(識別子・scope・順序)が登録時点の形と一致する=
/// `"**"` のまま・項目が増えていない・deny が足されていない(契約2)。
#[test]
fn ac19a_b_capability_opener_permissions_are_unchanged() {
    let value = capability_value();
    let permissions = value
        .pointer("/permissions")
        .and_then(Value::as_array)
        .expect("capabilities/default.json must have a permissions array");

    let opener_entries: Vec<&Value> = permissions
        .iter()
        .filter(|p| {
            let id = match p {
                Value::String(s) => s.as_str(),
                Value::Object(o) => o.get("identifier").and_then(Value::as_str).unwrap_or(""),
                _ => "",
            };
            id.starts_with("opener:")
        })
        .collect();

    let expected = json!([
        {
            "identifier": "opener:allow-open-url",
            "allow": [
                { "url": "https://*" },
                { "url": "http://*" },
                { "url": "mailto:*" },
                { "url": "tel:*" }
            ]
        },
        "opener:allow-reveal-item-in-dir",
        {
            "identifier": "opener:allow-open-path",
            "allow": [{ "path": "**", "app": true }]
        }
    ]);
    let expected: Vec<&Value> = expected.as_array().unwrap().iter().collect();

    assert_eq!(
        opener_entries, expected,
        "opener permissions in capabilities/default.json must be exactly the pre-追補a set (契約2)"
    );
}

// ---------------------------------------------------------------------------
// AC-19-追a (c): opener と同じ glob の規則で「.」付きパスが "**" に当たる
// ---------------------------------------------------------------------------

/// (c)-1 規則の確かめ: `require_literal_leading_dot = false` なら `"**"` は「.」で始まる要素を
/// 含むパスにも当たる(対照の「.」なしパスも当たる)。
#[test]
fn ac19a_c1_rule_leading_dot_not_required_matches_dotted_paths() {
    let scope = opener_path_scope(Some(false));
    for path in DOTTED_PATHS {
        assert!(
            scope.is_allowed(path),
            "with require_literal_leading_dot=false, \"**\" must match {path}"
        );
    }
    assert!(scope.is_allowed(PLAIN_PATH), "\"**\" must match {PLAIN_PATH}");
}

/// (c)-2 規則の固定: `require_literal_leading_dot = true`(unix の既定)では「.」付きパスに
/// 当たらない=これが Issue #418 の原因。対照の「.」なしパスは当たる(scope は機能している)。
#[test]
fn ac19a_c2_rule_leading_dot_required_rejects_dotted_paths() {
    let scope = opener_path_scope(Some(true));
    for path in DOTTED_PATHS {
        assert!(
            !scope.is_allowed(path),
            "with require_literal_leading_dot=true, \"**\" must NOT match {path} (the Issue #418 behaviour)"
        );
    }
    assert!(
        scope.is_allowed(PLAIN_PATH),
        "the scope itself must still work: \"**\" must match {PLAIN_PATH}"
    );
}

/// (c)-3 設定値をそのまま流す: `tauri.conf.json` の `plugins.opener.requireLiteralLeadingDot`
/// (無ければ `None` = tauri の unix 既定 `true`)を opener と同じ経路に入れて、「.」付きの
/// 2 パスが `"**"` に当たること。実装前(キー無し)は既定の `true` で当たらず赤。
#[test]
fn ac19a_c3_configured_value_lets_dotted_paths_through() {
    let configured = configured_require_literal_leading_dot();
    let scope = opener_path_scope(configured);
    for path in DOTTED_PATHS {
        assert!(
            scope.is_allowed(path),
            "with tauri.conf.json plugins.opener.{OPENER_KEY} = {configured:?}, \"**\" must match {path}"
        );
    }
    assert!(scope.is_allowed(PLAIN_PATH), "\"**\" must match {PLAIN_PATH}");
}
