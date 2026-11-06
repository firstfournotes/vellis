//! 要件#56 の受け入れテスト(docs/requirements/req-56.md)— テーマの解決と設定(AC-56-19・20・21)
//!
//! 契約 2・3「テーマ」の Rust 側=単一真実源 `theme.rs`。正本 `themes/default.json` を `include_str!` で埋め込み、
//! 利用者のテーマ(`~/.config/vellis/themes/<name>.json`)と同じ `resolve_theme` に通す。検証は型ごとの文法の
//! 白リスト+全型共通の禁止(docs/theme-architecture.md §3.2)、壊れた項目は Default で補って警告 1 枚(§5.1)。
//! `settings.json` には `appearance.theme`(文字列・既定 `"default"`)が加わる(要件#65 の拡張=req-65 の状態節)。
//!
//! 本ファイルは**実装の関数を呼ぶ**ので、`theme.rs` が無い間はコンパイルが通らない(=未実装の赤)。
//! ソース走査だけの `acceptance_req56.rs` と分けてあるのはそのため(`cargo test --test acceptance_req56_theme`)。
//!
//! 判定範囲:
//! - AC-56-19 生成物と正本の一致(Rust 側)= Default を `resolve_theme` に通すと警告 0・light と dark それぞれ 65 名
//!   すべて解決・`code` が `("github-light", "github-dark")`。`TOKENS` の名前の集合と `themes/default.json` の鍵の集合
//!   (common ∪ light ∪ dark)が一致・`TOKENS` の件数が 65。Default を利用者のテーマとして読んでも同じ結果
//! - AC-56-20 解決の純関数= §5.1 の場面表(無い・読めない・一部上書き・common・白リスト・共通の禁止・知らない名前・
//!   `version`・`appearance.theme` の型違い・予約名 `default`・Shiki 名の文法)。`PartialEq`・panic も Err もしない
//! - AC-56-21 `settings.json` の `appearance.theme`= `parse_settings`・`Settings::default()`・`default_settings_json()`
//!   の先頭の 1 行・`appearance.theme` だけを置き換えて書き戻す関数(鍵の並びを保つ・壊れた JSON には書かない)。
//!   Export の書き出し名(`my-theme.json` …)は第1段の末尾か第2段(契約 7)=無い間は判定を保留(本ファイルに無い)
//!
//! 判定しないもの: ダイアログの出方・watcher の実動作・メニューの実クリック(人間ゲート 4)。
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前・公開パス。theme-architecture §5.2・§10 を具体化)
//!
//! ```ignore
//! // --- 新規 src-tauri/src/theme.rs(lib.rs に `pub mod theme;`)---
//! use std::collections::BTreeMap;
//! use std::path::Path;
//!
//! /// 全窓へ配るイベント名(フロント src/lib/theme.ts と同綴り)。
//! pub const THEME_CHANGED_EVENT: &str = "theme_changed";
//! /// 組み込みの予約名。
//! pub const DEFAULT_THEME_NAME: &str = "default";
//! /// 正本をビルドに埋め込む(include_str!("../../themes/default.json"))。
//! pub const DEFAULT_THEME_JSON: &str = …;
//!
//! /// 型(§3.2 の白リストの単位)。バリアントの名前は実装裁量(本テストは第 2 要素を使わない)。
//! #[derive(Clone, Copy, Debug, PartialEq, Eq)]
//! pub enum TokenType { Color, Length, FontFamily, FontSize, LineHeight, FontWeight, LetterSpacing, Shadow, Duration, Easing }
//! /// どの名前がどの型か(65 行)。名前は JSON の鍵の形=先頭の `--` を省いた平らな名前(判断 (a))。
//! pub const TOKENS: &[(&str, TokenType)] = &[("color-bg-base", TokenType::Color), …];
//!
//! /// 解決済みのテーマ(フロントへ serde で渡す。鍵は `--` 無し・code は (light, dark))。
//! #[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
//! pub struct ResolvedTheme {
//!     pub name: String,                            // 効いているテーマの名前(見つからない・型違いなら "default")
//!     pub light: BTreeMap<&'static str, String>,   // 65 名すべて
//!     pub dark: BTreeMap<&'static str, String>,    // 65 名すべて
//!     pub code: (String, String),                  // (light, dark) の Shiki の名前
//!     pub warnings: Vec<String>,                   // 英語。解決 1 回につき壊れた項目はまとめて 1 要素
//! }
//!
//! /// 純関数(§5.2)。settings_text = settings.json の中身(無ければ None)。read_theme = 名前 → テーマ本文(無ければ None)。
//! pub fn resolve_theme(settings_text: Option<&str>, read_theme: impl Fn(&str) -> Option<String>) -> ResolvedTheme;
//!
//! /// `themes/` のファイル名から一覧(名前順の stem)を作る。`*.json` 以外は無視。`default.json` は一覧に出さず警告 1 件。
//! /// 戻り値 = (names, warnings)。
//! pub fn list_theme_names(file_names: &[&str]) -> (Vec<String>, Vec<String>);
//!
//! /// settings.json の中身の `appearance.theme` だけを `name` に置き換えた中身(鍵の並びは保つ=preserve_order・
//! /// 無ければ足す・整形は to_string_pretty)。読めない JSON は Err(書かない)。
//! pub fn replace_appearance_theme(settings_text: &str, name: &str) -> Result<String, String>;
//! /// 上のファイル版。無ければ親ごと作って既定の JSON(appearance.theme = name)を書く。壊れていれば Err でバイト単位で不変。
//! pub fn set_appearance_theme(path: &Path, name: &str) -> Result<(), String>;
//!
//! // --- src-tauri/src/settings.rs(既存)に追加 ---
//! pub const APPEARANCE_THEME_KEY: &str = "appearance.theme";
//! pub struct Settings { pub files_exclude: ExcludeMap, pub search_exclude: ExcludeMap, pub appearance_theme: String }
//! // Settings::default().appearance_theme == "default"。parse_settings は文字列以外を "default" + 警告 1 件以上。
//! // default_settings_json() の先頭の鍵が "appearance.theme": "default"(判断 (s))。
//! ```
//!
//! 白リストの文法(§3.2)で本テストが使う例: color=`#rgb`/`#rrggbb`/`rgba(…)`・length=`12px`/`72ch`/`0`・
//! font-weight=100〜900/`normal`/`bold`・code=`^[a-z0-9][a-z0-9-]*$`。

use std::collections::BTreeSet;
use std::path::PathBuf;

use vellis_lib::settings::{default_settings_json, parse_settings, Settings};
use vellis_lib::theme::{
    list_theme_names, replace_appearance_theme, resolve_theme, set_appearance_theme, ResolvedTheme,
    DEFAULT_THEME_JSON, THEME_CHANGED_EVENT, TOKENS,
};

// ---------------------------------------------------------------------------
// 名前の集合(docs/theme-architecture.md §3.1・JSON の鍵の形=`--` 無し)
// ---------------------------------------------------------------------------

const TOKEN_NAMES: [&str; 65] = [
    // 色 23 + emphasis
    "color-bg-base",
    "color-bg-surface",
    "color-bg-raised",
    "color-bg-hover",
    "color-bg-active",
    "color-text-primary",
    "color-text-secondary",
    "color-text-muted",
    "color-border",
    "color-border-strong",
    "color-accent",
    "color-accent-text",
    "color-on-accent",
    "color-accent-soft",
    "color-selection",
    "color-focus-ring",
    "color-danger",
    "color-success",
    "color-warning",
    "color-danger-soft",
    "color-success-soft",
    "color-warning-soft",
    "color-shadow",
    "color-emphasis",
    // 余白 6
    "space-1",
    "space-2",
    "space-3",
    "space-4",
    "space-5",
    "space-6",
    // 角丸 2
    "radius-sm",
    "radius-md",
    // タイポ 15
    "font-ui",
    "font-doc",
    "font-mono",
    "text-xs",
    "text-sm",
    "text-md",
    "text-lg",
    "text-xl",
    "doc-size",
    "doc-leading",
    "doc-measure",
    "leading-ui",
    "pane-header-font-size",
    "pane-header-font-weight",
    "pane-header-letter-spacing",
    // 影 2
    "shadow-1",
    "shadow-2",
    // 遷移 4
    "duration-fast",
    "duration-base",
    "duration-slow",
    "ease-out",
    // ファイル種別 9
    "ft-md",
    "ft-html",
    "ft-pdf",
    "ft-img",
    "ft-video",
    "ft-audio",
    "ft-3d",
    "ft-code",
    "ft-folder",
    // 検索 3
    "color-find-match",
    "color-find-current",
    "color-find-current-text",
];

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().expect("src-tauri has a parent").to_path_buf()
}

fn default_json_from_disk() -> serde_json::Value {
    let path = repo_root().join("themes").join("default.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {}", path.display(), e));
    serde_json::from_str(&text).expect("themes/default.json must be JSON")
}

fn none_reader(_: &str) -> Option<String> {
    None
}

/// Default(settings 無し)。
fn default_theme() -> ResolvedTheme {
    resolve_theme(None, none_reader)
}

/// `appearance.theme = "forest"` で、forest の本文が `theme_json` のときの解決。
fn with_forest(theme_json: &str) -> ResolvedTheme {
    let body = theme_json.to_string();
    resolve_theme(Some(r#"{"appearance.theme": "forest"}"#), move |name| {
        if name == "forest" {
            Some(body.clone())
        } else {
            None
        }
    })
}

fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| matches!(c as u32, 0x3000..=0x303F | 0x3040..=0x30FF | 0x4E00..=0x9FFF | 0xFF00..=0xFFEF))
}

/// light / dark / code が Default と同じ(name と warnings は見ない)。
fn assert_values_are_default(theme: &ResolvedTheme, what: &str) {
    let d = default_theme();
    assert_eq!(theme.light, d.light, "{what}: light must be Default");
    assert_eq!(theme.dark, d.dark, "{what}: dark must be Default");
    assert_eq!(theme.code, d.code, "{what}: code must be Default");
}

/// `key` だけが Default と違い、他はすべて Default のまま(light 側)。
fn assert_only_light_key_differs(theme: &ResolvedTheme, key: &str, value: &str) {
    let d = default_theme();
    assert_eq!(theme.light.get(key).map(String::as_str), Some(value), "{key} must be overridden");
    for (name, v) in &d.light {
        if *name != key {
            assert_eq!(theme.light.get(name), Some(v), "{name} must stay Default");
        }
    }
    assert_eq!(theme.dark, d.dark, "dark must stay Default");
}

/// 値 1 つを light に書いたテーマ本文。
fn light_theme(key: &str, value: &str) -> String {
    format!(r#"{{"version": 1, "light": {{"{key}": {}}}}}"#, serde_json::to_string(value).unwrap())
}

// ---------------------------------------------------------------------------
// AC-56-19 — 生成物と正本の一致(Rust 側)
// ---------------------------------------------------------------------------

/// 1. Default(`include_str!` の正本)を解決すると警告 0・light と dark に 65 名・code は github-light / github-dark・name は default。
#[test]
fn default_theme_resolves_cleanly_with_all_65_tokens() {
    let d = default_theme();
    assert!(d.warnings.is_empty(), "Default must produce no warnings: {:?}", d.warnings);
    assert_eq!(d.light.len(), 65, "light must hold every token");
    assert_eq!(d.dark.len(), 65, "dark must hold every token");
    assert_eq!(d.code, ("github-light".to_string(), "github-dark".to_string()));
    assert_eq!(d.name, "default");
    let names: BTreeSet<&str> = d.light.keys().copied().collect();
    assert_eq!(names, TOKEN_NAMES.iter().copied().collect::<BTreeSet<_>>());
    assert_eq!(d.dark.keys().copied().collect::<BTreeSet<_>>(), names);
}

/// 2. `TOKENS` は 65 行で、名前の集合は §3.1 の 65 名と一致する。
#[test]
fn tokens_table_has_the_65_names() {
    assert_eq!(TOKENS.len(), 65);
    let names: BTreeSet<&str> = TOKENS.iter().map(|(name, _)| *name).collect();
    assert_eq!(names.len(), 65, "no duplicate names in TOKENS");
    assert_eq!(names, TOKEN_NAMES.iter().copied().collect::<BTreeSet<_>>());
}

/// 3. `TOKENS` の名前の集合と `themes/default.json` の鍵の集合(common ∪ light ∪ dark)が一致する(片方にしか無い名前が無い)。
///    `include_str!` の中身とディスクの正本は同じ。
#[test]
fn tokens_table_matches_the_keys_of_default_json() {
    let json = default_json_from_disk();
    let mut keys: BTreeSet<String> = BTreeSet::new();
    for block in ["common", "light", "dark"] {
        if let Some(obj) = json.get(block).and_then(|v| v.as_object()) {
            keys.extend(obj.keys().cloned());
        }
    }
    let table: BTreeSet<String> = TOKENS.iter().map(|(name, _)| name.to_string()).collect();
    let only_in_json: Vec<_> = keys.difference(&table).cloned().collect();
    let only_in_table: Vec<_> = table.difference(&keys).cloned().collect();
    assert!(only_in_json.is_empty(), "keys only in themes/default.json: {only_in_json:?}");
    assert!(only_in_table.is_empty(), "names only in TOKENS: {only_in_table:?}");
    assert_eq!(json.get("version"), Some(&serde_json::Value::from(1)));

    let embedded: serde_json::Value = serde_json::from_str(DEFAULT_THEME_JSON).expect("embedded default must be JSON");
    assert_eq!(embedded, json, "include_str! must embed themes/default.json itself");
}

/// 4. Default の値はアクセント=藍(ライト #4256e8 / ダーク #5566ee)・行長 72ch・見出し行 11px / 600 / .06em。
#[test]
fn default_values_carry_the_indigo_accent_and_the_fixed_typography() {
    let d = default_theme();
    assert_eq!(d.light["color-accent"].to_lowercase(), "#4256e8");
    assert_eq!(d.dark["color-accent"].to_lowercase(), "#5566ee");
    assert_eq!(d.light["doc-measure"], "72ch");
    assert_eq!(d.dark["doc-measure"], "72ch");
    assert_eq!(d.light["pane-header-font-size"], "11px");
    assert_eq!(d.light["pane-header-font-weight"], "600");
    assert_eq!(d.light["pane-header-letter-spacing"].trim_start_matches('0'), ".06em");
    assert_eq!(d.light["color-emphasis"].to_lowercase(), "#8250df");
    assert_eq!(d.dark["color-emphasis"].to_lowercase(), "#d2a8ff");
}

/// 5. 正本を利用者のテーマとして読んでも(書けるもの=アプリが使うもの)警告 0 で Default と同じ値になる。
#[test]
fn default_json_passes_the_same_validation_as_a_user_theme() {
    let copy = with_forest(DEFAULT_THEME_JSON);
    assert!(copy.warnings.is_empty(), "the Default file must pass validation unchanged: {:?}", copy.warnings);
    assert_values_are_default(&copy, "a copy of Default");
    assert_eq!(copy.name, "forest");
}

/// 6. イベント名は値固定(フロントの `src/lib/theme.ts` と同綴り=theme.wiring.test.ts が照合)。
#[test]
fn theme_changed_event_name_is_fixed() {
    assert_eq!(THEME_CHANGED_EVENT, "theme_changed");
}

// ---------------------------------------------------------------------------
// AC-56-20 — 解決の純関数(§5.1 の場面表)
// ---------------------------------------------------------------------------

/// 7. settings が None か `{}` → Default・警告 0。
#[test]
fn missing_or_empty_settings_yield_default_without_warnings() {
    for settings in [None, Some("{}")] {
        let t = resolve_theme(settings, none_reader);
        assert!(t.warnings.is_empty(), "{settings:?}: {:?}", t.warnings);
        assert_values_are_default(&t, &format!("{settings:?}"));
        assert_eq!(t.name, "default");
    }
}

/// 8. `appearance.theme = "forest"` で読めるファイルが無い → Default 全体・警告 1 件(`not found` を含む・英語)。
#[test]
fn a_missing_theme_file_falls_back_to_default_with_one_not_found_warning() {
    let t = resolve_theme(Some(r#"{"appearance.theme": "forest"}"#), none_reader);
    assert_values_are_default(&t, "missing forest");
    assert_eq!(t.warnings.len(), 1, "{:?}", t.warnings);
    assert!(t.warnings[0].contains("not found"), "{:?}", t.warnings);
    assert!(t.warnings[0].contains("forest"), "{:?}", t.warnings);
    assert!(!has_cjk(&t.warnings[0]));
}

/// 9. 読めない JSON・いちばん外がオブジェクトでない → Default 全体・警告 1 件以上。
#[test]
fn an_unreadable_theme_file_falls_back_to_default_with_a_warning() {
    for body in ["not json", "[]", "\"x\"", "", "{", "null", "42"] {
        let t = with_forest(body);
        assert_values_are_default(&t, body);
        assert!(!t.warnings.is_empty(), "{body:?} must warn");
        for w in &t.warnings {
            assert!(!has_cjk(w), "warnings are English: {w}");
        }
    }
}

/// 10. `light` の 1 項目だけ上書き → その項目だけ変わり、他と dark は Default・警告 0・name は forest。
#[test]
fn a_single_light_override_changes_only_that_token() {
    let t = with_forest(r##"{"version": 1, "light": {"color-accent": "#1f7a4d"}}"##);
    assert!(t.warnings.is_empty(), "{:?}", t.warnings);
    assert_only_light_key_differs(&t, "color-accent", "#1f7a4d");
    assert_eq!(t.name, "forest");
    assert_eq!(t.code, default_theme().code);
}

/// 11. `common` は light と dark の両方に効き、`light` / `dark` に同じ名前があればそちらが勝つ(§4.1 の解決の順)。
#[test]
fn common_applies_to_both_modes_and_mode_blocks_win() {
    let t = with_forest(r#"{"version": 1, "common": {"doc-size": "17px"}}"#);
    assert!(t.warnings.is_empty(), "{:?}", t.warnings);
    assert_eq!(t.light["doc-size"], "17px");
    assert_eq!(t.dark["doc-size"], "17px");

    let t = with_forest(r#"{"version": 1, "common": {"doc-size": "17px"}, "dark": {"doc-size": "18px"}}"#);
    assert!(t.warnings.is_empty(), "{:?}", t.warnings);
    assert_eq!(t.light["doc-size"], "17px");
    assert_eq!(t.dark["doc-size"], "18px");
}

/// 12. 白リスト: 型に合わない値はその項目だけ Default で警告(1 項目=1 件)。
#[test]
fn a_value_outside_the_type_grammar_is_replaced_by_default_with_one_warning() {
    let cases: &[(&str, &str)] = &[
        ("color-accent", "12px"),
        ("color-danger", "red"),
        ("color-success", "color-mix(in srgb, red, blue)"),
        ("space-1", "#fff"),
        ("space-2", "12"),
        ("pane-header-font-weight", "1000"),
    ];
    let d = default_theme();
    for (key, value) in cases {
        let t = with_forest(&light_theme(key, value));
        assert_eq!(t.light.get(key), d.light.get(key), "{key}={value:?} must fall back to Default");
        assert_eq!(t.warnings.len(), 1, "{key}={value:?}: {:?}", t.warnings);
        assert!(t.warnings[0].contains(key), "the warning names the token: {:?}", t.warnings);
        assert!(!has_cjk(&t.warnings[0]));
    }
}

/// 13. 白リスト: 文法に合う値は通る(color の 4 形・length の 0・font-weight の normal / bold)。
#[test]
fn values_inside_the_type_grammar_are_accepted() {
    let cases: &[(&str, &str)] = &[
        ("color-accent", "#abc"),
        ("color-accent", "#abcd"),
        ("color-accent", "#aabbcc"),
        ("color-accent", "#aabbccdd"),
        ("color-accent", "rgba(15, 18, 30, .045)"),
        ("color-accent", "rgb(1,2,3)"),
        ("color-accent", "transparent"),
        ("space-1", "0"),
        ("space-1", "1.5rem"),
        ("doc-measure", "80ch"),
        ("pane-header-font-weight", "normal"),
        ("pane-header-font-weight", "bold"),
        ("pane-header-font-weight", "650"),
        ("doc-leading", "1.7"),
        ("duration-fast", "0"),
        ("duration-fast", "1.5s"),
        ("ease-out", "ease-in-out"),
        ("shadow-1", "none"),
        ("shadow-1", "inset 0 1px 2px rgba(0,0,0,.4), 0 0 0 1px #fff"),
        ("font-mono", "\"JetBrains Mono\", Menlo, monospace"),
    ];
    for (key, value) in cases {
        let t = with_forest(&light_theme(key, value));
        assert!(t.warnings.is_empty(), "{key}={value:?} must be accepted: {:?}", t.warnings);
        assert_eq!(t.light.get(key).map(String::as_str), Some(*value));
    }
}

/// 14. 複数の壊れた項目は 1 回の解決で 1 枚にまとめる(`warnings` は 1 要素で、各項目の名前を含む)。
#[test]
fn several_broken_values_are_reported_in_one_warning() {
    let t = with_forest(
        r##"{"version": 1, "light": {"color-accent": "12px", "space-1": "#fff", "pane-header-font-weight": "1000"}}"##,
    );
    assert_values_are_default(&t, "all three broken");
    assert_eq!(t.warnings.len(), 1, "one dialog per resolve: {:?}", t.warnings);
    for key in ["color-accent", "space-1", "pane-header-font-weight"] {
        assert!(t.warnings[0].contains(key), "the warning names {key}: {:?}", t.warnings);
    }
}

/// 15. 全型共通の禁止: url( / var( / ; / } / </style> / !important / 257 文字 / 制御文字 → その項目だけ Default で警告。
#[test]
fn forbidden_characters_and_functions_are_rejected_for_every_type() {
    let long = "a".repeat(257);
    let cases: Vec<(&str, String)> = vec![
        ("font-ui", "url(http://example.com/x.woff)".to_string()),
        ("color-accent", "var(--color-danger)".to_string()),
        ("font-ui", "Menlo; color: red".to_string()),
        ("font-ui", "Menlo } body { display: none".to_string()),
        ("font-ui", "</style><script>alert(1)</script>".to_string()),
        ("space-1", "4px !important".to_string()),
        ("font-ui", long),
        ("font-ui", "Menlo\u{1}".to_string()),
        ("color-accent", "env(safe-area-inset-top)".to_string()),
        ("font-ui", "@import 'x'".to_string()),
    ];
    let d = default_theme();
    for (key, value) in &cases {
        let t = with_forest(&light_theme(key, value));
        assert_eq!(t.light.get(*key), d.light.get(*key), "{key}={value:?} must fall back to Default");
        assert_eq!(t.warnings.len(), 1, "{key}={value:?}: {:?}", t.warnings);
    }
}

/// 16. 知らない名前は無視(警告 0・結果に増えない)。足りない名前は Default で補われる(警告 0)。
#[test]
fn unknown_and_missing_names_are_silent() {
    let t = with_forest(r##"{"version": 1, "light": {"color-nope": "#000", "color-accent": "#1f7a4d"}}"##);
    assert!(t.warnings.is_empty(), "{:?}", t.warnings);
    assert!(!t.light.contains_key("color-nope"));
    assert_eq!(t.light.len(), 65);
    assert_eq!(t.dark.len(), 65);
    assert_only_light_key_differs(&t, "color-accent", "#1f7a4d");
}

/// 17. `version` 無し・1 → 警告 0。`1` 以外 → 読むが警告 1 件(`version` を含む)。
#[test]
fn version_is_optional_and_only_an_unknown_version_warns() {
    for body in [r##"{"light": {"color-accent": "#1f7a4d"}}"##, r##"{"version": 1, "light": {"color-accent": "#1f7a4d"}}"##] {
        let t = with_forest(body);
        assert!(t.warnings.is_empty(), "{body}: {:?}", t.warnings);
        assert_eq!(t.light["color-accent"], "#1f7a4d");
    }
    let t = with_forest(r##"{"version": 2, "light": {"color-accent": "#1f7a4d"}}"##);
    assert_eq!(t.light["color-accent"], "#1f7a4d", "an unknown version is still read");
    assert_eq!(t.warnings.len(), 1, "{:?}", t.warnings);
    assert!(t.warnings[0].contains("version"), "{:?}", t.warnings);
}

/// 18. `appearance.theme` が文字列でない → `"default"` と見なし警告 1 件。read_theme は呼ばれない。
#[test]
fn a_non_string_appearance_theme_means_default_with_one_warning() {
    let t = resolve_theme(Some(r#"{"appearance.theme": 42}"#), |name| panic!("must not read a theme named {name:?}"));
    assert_eq!(t.name, "default");
    assert_values_are_default(&t, "appearance.theme = 42");
    assert_eq!(t.warnings.len(), 1, "{:?}", t.warnings);
    assert!(!has_cjk(&t.warnings[0]));
}

/// 19. `appearance.theme = "default"` は組み込み(ファイルを読まない・警告 0)。壊れた settings.json でも Default で動く。
#[test]
fn default_name_is_builtin_and_broken_settings_still_resolve() {
    let t = resolve_theme(Some(r#"{"appearance.theme": "default"}"#), |name| panic!("must not read {name:?}"));
    assert!(t.warnings.is_empty(), "{:?}", t.warnings);
    assert_values_are_default(&t, "explicit default");
    assert_eq!(t.name, "default");

    for settings in ["not json", "[]", "null", "{\"appearance.theme\": "] {
        let t = resolve_theme(Some(settings), none_reader);
        assert_values_are_default(&t, settings);
        assert_eq!(t.name, "default");
    }
}

/// 20. 一覧: `*.json` の stem を名前順に・`default.json` は出さず警告 1 件・json 以外は無視。
#[test]
fn theme_list_sorts_stems_and_reserves_default() {
    let (names, warnings) = list_theme_names(&["solarized.json", "default.json", "forest.json", "notes.txt", ".DS_Store"]);
    assert_eq!(names, vec!["forest".to_string(), "solarized".to_string()]);
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert!(warnings[0].contains("default"), "{warnings:?}");

    let (names, warnings) = list_theme_names(&["forest.json"]);
    assert_eq!(names, vec!["forest".to_string()]);
    assert!(warnings.is_empty(), "{warnings:?}");

    let (names, warnings) = list_theme_names(&[]);
    assert!(names.is_empty());
    assert!(warnings.is_empty());
}

/// 21. Shiki の名前: 文法 `^[a-z0-9][a-z0-9-]*$` に合えば通す(同梱かどうかはフロント)。合わなければ Default の名前で警告。
#[test]
fn code_theme_names_follow_the_grammar_and_fall_back_to_default() {
    let t = with_forest(r#"{"version": 1, "code": {"dark": "vitesse-dark"}}"#);
    assert!(t.warnings.is_empty(), "{:?}", t.warnings);
    assert_eq!(t.code, ("github-light".to_string(), "vitesse-dark".to_string()));

    let t = with_forest(r#"{"version": 1, "code": {"dark": "Vitesse Dark"}}"#);
    assert_eq!(t.code, ("github-light".to_string(), "github-dark".to_string()));
    assert_eq!(t.warnings.len(), 1, "{:?}", t.warnings);

    let t = with_forest(r#"{"version": 1, "code": {"light": "../etc", "dark": 7}}"#);
    assert_eq!(t.code, default_theme().code);
    assert_eq!(t.warnings.len(), 1, "{:?}", t.warnings);
}

/// 22. `PartialEq`: 同じ入力は等しく、違う入力は違う。
#[test]
fn resolved_themes_compare_by_value() {
    let a = with_forest(r##"{"version": 1, "light": {"color-accent": "#1f7a4d"}}"##);
    let b = with_forest(r##"{"version": 1, "light": {"color-accent": "#1f7a4d"}}"##);
    let c = with_forest(r##"{"version": 1, "light": {"color-accent": "#1f7a4e"}}"##);
    assert_eq!(a, b);
    assert_ne!(a, c);
    assert_eq!(default_theme(), default_theme());
    assert_ne!(default_theme(), a);
}

/// 23. どんな入力でも panic もエラーの返却もしない(戻り値は常に ResolvedTheme)。
#[test]
fn resolve_theme_never_panics() {
    let bodies = [
        "{",
        r#"{"version": "x"}"#,
        r#"{"light": []}"#,
        r#"{"common": 5}"#,
        r#"{"code": "x"}"#,
        r#"{"code": {"light": null}}"#,
        r#"{"light": {"color-accent": null}}"#,
        r#"{"light": {"color-accent": 1}}"#,
        r#"{"light": {"color-accent": {"a": 1}}}"#,
        r##"{"light": {"": "#fff"}}"##,
        r#"{"meta": "not an object"}"#,
        "\u{feff}{}",
    ];
    for body in bodies {
        let t = with_forest(body);
        assert_eq!(t.light.len(), 65, "{body:?}");
        assert_eq!(t.dark.len(), 65, "{body:?}");
    }
    let settings = ["{\"appearance.theme\": \"../../etc/passwd\"}", "{\"appearance.theme\": \"\"}", "{\"appearance.theme\": null}"];
    for s in settings {
        let t = resolve_theme(Some(s), none_reader);
        assert_eq!(t.light.len(), 65, "{s:?}");
    }
}

// ---------------------------------------------------------------------------
// AC-56-21 — settings.json の appearance.theme(要件#65 の拡張)
// ---------------------------------------------------------------------------

/// 24. `parse_settings` は `appearance.theme` を読む。無ければ `"default"`。文字列でなければ `"default"` と警告 1 件以上。
#[test]
fn parse_settings_reads_appearance_theme_with_default_and_type_check() {
    let loaded = parse_settings(r#"{"appearance.theme": "forest"}"#);
    assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    assert_eq!(loaded.settings.appearance_theme, "forest");

    let loaded = parse_settings("{}");
    assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    assert_eq!(loaded.settings.appearance_theme, "default");
    assert_eq!(Settings::default().appearance_theme, "default");

    let loaded = parse_settings(r#"{"appearance.theme": 42}"#);
    assert_eq!(loaded.settings.appearance_theme, "default");
    assert!(!loaded.warnings.is_empty(), "a non-string appearance.theme must warn");
    for w in &loaded.warnings {
        assert!(!has_cjk(w), "warnings are English: {w}");
    }
    // the exclude lists are untouched by the new key
    assert_eq!(loaded.settings.files_exclude, Settings::default().files_exclude);
    assert_eq!(loaded.settings.search_exclude, Settings::default().search_exclude);
}

/// 25. `default_settings_json()` の先頭の鍵は `"appearance.theme": "default"`(判断 (s))で、読み戻すと警告 0・既定値。
#[test]
fn default_settings_json_starts_with_appearance_theme_and_round_trips() {
    let json = default_settings_json();
    let value: serde_json::Value = serde_json::from_str(&json).expect("default JSON must parse");
    let object = value.as_object().expect("object");
    assert_eq!(object.get("appearance.theme"), Some(&serde_json::Value::from("default")));
    let appearance_at = json.find("\"appearance.theme\"").expect("the key is written");
    let files_at = json.find("\"files.exclude\"").expect("files.exclude is written");
    let search_at = json.find("\"search.exclude\"").expect("search.exclude is written");
    assert!(appearance_at < files_at && files_at < search_at, "appearance.theme comes first, then the two exclude lists");

    let loaded = parse_settings(&json);
    assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    assert_eq!(loaded.settings, Settings::default());
}

const TWO_KEY_SETTINGS: &str = r#"{
  "files.exclude": {
    "**/.*": true,
    "**/.git": true
  },
  "search.exclude": {
    "**/node_modules": true,
    "**/target": false
  }
}
"#;

fn key_position(text: &str, key: &str) -> usize {
    text.find(&format!("\"{key}\"")).unwrap_or_else(|| panic!("{key} must be present in {text}"))
}

/// 26. `appearance.theme` が無い settings に足しても `files.exclude` → `search.exclude` の並びを保ち、中身は変わらない。
#[test]
fn replace_appearance_theme_adds_the_key_and_keeps_the_order_of_the_others() {
    let out = replace_appearance_theme(TWO_KEY_SETTINGS, "forest").expect("valid JSON must be rewritten");
    let value: serde_json::Value = serde_json::from_str(&out).expect("output is JSON");
    assert_eq!(value["appearance.theme"], serde_json::Value::from("forest"));
    let before: serde_json::Value = serde_json::from_str(TWO_KEY_SETTINGS).unwrap();
    assert_eq!(value["files.exclude"], before["files.exclude"]);
    assert_eq!(value["search.exclude"], before["search.exclude"]);
    assert!(
        key_position(&out, "files.exclude") < key_position(&out, "search.exclude"),
        "files.exclude must still precede search.exclude (preserve_order): {out}"
    );
    let loaded = parse_settings(&out);
    assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    assert_eq!(loaded.settings.appearance_theme, "forest");
}

/// 27. 既にあれば値だけ変わり、鍵の並びは元のまま(先頭にあっても途中にあっても)。
#[test]
fn replace_appearance_theme_replaces_an_existing_value_in_place() {
    let middle = r#"{"files.exclude": {"**/.git": true}, "appearance.theme": "old", "search.exclude": {"**/dist": true}}"#;
    let out = replace_appearance_theme(middle, "forest").expect("valid JSON");
    let value: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(value["appearance.theme"], serde_json::Value::from("forest"));
    assert_eq!(value.as_object().unwrap().len(), 3, "no key is added or lost");
    let f = key_position(&out, "files.exclude");
    let a = key_position(&out, "appearance.theme");
    let s = key_position(&out, "search.exclude");
    assert!(f < a && a < s, "order must be files.exclude, appearance.theme, search.exclude: {out}");

    let first = r#"{"appearance.theme": "old", "files.exclude": {"**/.git": true}}"#;
    let out = replace_appearance_theme(first, "default").expect("valid JSON");
    assert!(key_position(&out, "appearance.theme") < key_position(&out, "files.exclude"), "{out}");
    assert_eq!(serde_json::from_str::<serde_json::Value>(&out).unwrap()["appearance.theme"], serde_json::Value::from("default"));
}

/// 28. 壊れた JSON(読めない・外がオブジェクトでない)は Err(書き直さない=要件#65 契約8 の精神)。
#[test]
fn replace_appearance_theme_refuses_broken_json() {
    for text in ["not json", "{\"files.exclude\": {", "[]", "", "42"] {
        let result = replace_appearance_theme(text, "forest");
        assert!(result.is_err(), "{text:?} must not be rewritten: {result:?}");
        assert!(!has_cjk(&result.unwrap_err()));
    }
}

/// 29. ファイル版: 壊れたファイルは Err でバイト単位で不変。
#[test]
fn set_appearance_theme_leaves_a_broken_file_untouched() {
    let tmp = tempfile::TempDir::new().unwrap();
    let path = tmp.path().join("settings.json");
    for content in ["not json {{{", "", "[]", "// comment\n{}"] {
        std::fs::write(&path, content).unwrap();
        let result = set_appearance_theme(&path, "forest");
        assert!(result.is_err(), "{content:?} must not be rewritten: {result:?}");
        assert_eq!(std::fs::read(&path).unwrap(), content.as_bytes(), "bytes must be untouched: {content:?}");
    }
}

/// 30. ファイル版: 無ければ親フォルダごと作って既定の JSON に `appearance.theme = name` を書き、読み戻せる。
#[test]
fn set_appearance_theme_creates_a_missing_file_with_the_defaults_and_the_chosen_theme() {
    let tmp = tempfile::TempDir::new().unwrap();
    let path = tmp.path().join("cfg").join("vellis").join("settings.json");
    assert!(!path.exists());
    set_appearance_theme(&path, "forest").expect("a missing file is created");
    assert!(path.is_file());
    let loaded = parse_settings(&std::fs::read_to_string(&path).unwrap());
    assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    assert_eq!(loaded.settings.appearance_theme, "forest");
    assert_eq!(loaded.settings.files_exclude, Settings::default().files_exclude);
    assert_eq!(loaded.settings.search_exclude, Settings::default().search_exclude);
}

/// 31. ファイル版: 読める settings.json は `appearance.theme` だけ変わり、他の鍵の並びと中身は保たれる。
#[test]
fn set_appearance_theme_rewrites_only_the_theme_key_of_a_valid_file() {
    let tmp = tempfile::TempDir::new().unwrap();
    let path = tmp.path().join("settings.json");
    std::fs::write(&path, TWO_KEY_SETTINGS).unwrap();
    set_appearance_theme(&path, "forest").expect("valid JSON is rewritten");
    let out = std::fs::read_to_string(&path).unwrap();
    let value: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(value["appearance.theme"], serde_json::Value::from("forest"));
    let before: serde_json::Value = serde_json::from_str(TWO_KEY_SETTINGS).unwrap();
    assert_eq!(value["files.exclude"], before["files.exclude"]);
    assert_eq!(value["search.exclude"], before["search.exclude"]);
    assert!(key_position(&out, "files.exclude") < key_position(&out, "search.exclude"), "{out}");

    set_appearance_theme(&path, "default").expect("rewritten again");
    let again: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(again["appearance.theme"], serde_json::Value::from("default"));
    assert_eq!(again.as_object().unwrap().len(), 3);
}
