//! 要件#56 の受け入れテスト(docs/requirements/req-56.md)— Export Default Theme… の純関数とファイル版
//! (AC-56-23・AC-56-21 の「Export の書き出し名」の保留分。契約 3・docs/theme-architecture.md 判断 (e))
//!
//! 本ファイルは**実装の関数を呼ぶ**ので、`theme.rs` に関数が無い間はコンパイルが通らない(=未実装の赤)。
//! ソース走査だけの `acceptance_req56_stage2.rs` と分けてあるのはそのため。
//!
//! 判定範囲:
//! - 書き出し名(純関数 `export_file_name`)= 既存のファイル名の集合から `my-theme.json`、あれば `my-theme-2.json`・
//!   `my-theme-3.json` … の最初の空き。大文字小文字は区別しない(macOS の FS に合わせる=第1段の `default` の予約と同じ)。
//!   `.json` 以外の同名は数えない
//! - 中身(純関数 `exported_theme_json`)= Default の全文(`DEFAULT_THEME_JSON`)で `meta.name` = `"My Theme"`・
//!   `meta.description` = `"Exported from Vellis <版>"` に差し替えたもの。他(version・code・common・light・dark・meta の
//!   他の鍵)は Default と同じ。整形済み(複数行)。利用者のテーマとして `resolve_theme` に通すと警告 0 で Default と同じ値
//! - ファイル版(`export_default_theme`)= `themes/` を親ごと作り、衝突しない名前で書き、書いたパスを返す。
//!   **既存を上書きしない**(2 回押すと `my-theme-2.json`・先のファイルはバイト単位で不変)。書けないときは Err(panic しない)
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```ignore
//! // --- src-tauri/src/theme.rs に追加
//! pub fn export_file_name(existing: &[&str]) -> String;                               // "my-theme.json" / "my-theme-2.json" …
//! pub fn exported_theme_json(version: &str) -> String;                                // Default の全文 + meta の差し替え
//! pub fn export_default_theme(themes_dir: &Path, version: &str) -> Result<PathBuf, String>;   // 書いたパス
//! ```

use std::path::Path;

use vellis_lib::theme::{
    export_default_theme, export_file_name, exported_theme_json, resolve_theme, DEFAULT_THEME_JSON,
};

fn default_value() -> serde_json::Value {
    serde_json::from_str(DEFAULT_THEME_JSON).expect("Default is JSON")
}

/// `meta` から name / description を除いたもの(他の鍵は Default のまま、の比較に使う)。
fn meta_without_name_and_description(value: &serde_json::Value) -> serde_json::Value {
    let mut meta = value.get("meta").cloned().unwrap_or(serde_json::Value::Null);
    if let Some(obj) = meta.as_object_mut() {
        obj.remove("name");
        obj.remove("description");
    }
    meta
}

/// `meta` を除いた全体(version・code・common・light・dark が Default と同じ、の比較に使う)。
fn without_meta(value: &serde_json::Value) -> serde_json::Value {
    let mut v = value.clone();
    if let Some(obj) = v.as_object_mut() {
        obj.remove("meta");
    }
    v
}

// ---------------------------------------------------------------------------
// 書き出し名(判断 (e))
// ---------------------------------------------------------------------------

/// 1. 空・他の名前だけ → my-theme.json。あれば -2・-3 … の最初の空き。
#[test]
fn export_file_name_is_my_theme_then_numbered() {
    assert_eq!(export_file_name(&[]), "my-theme.json");
    assert_eq!(export_file_name(&["forest.json", "solarized.json"]), "my-theme.json");
    assert_eq!(export_file_name(&["my-theme.json"]), "my-theme-2.json");
    assert_eq!(export_file_name(&["my-theme.json", "my-theme-2.json"]), "my-theme-3.json");
    assert_eq!(
        export_file_name(&["my-theme-2.json", "my-theme.json", "my-theme-3.json", "forest.json"]),
        "my-theme-4.json"
    );
}

/// 2. 空きは先頭から埋める(my-theme.json が無ければ -2 があっても my-theme.json)。
#[test]
fn export_file_name_fills_the_first_gap() {
    assert_eq!(export_file_name(&["my-theme-2.json"]), "my-theme.json");
    assert_eq!(export_file_name(&["my-theme.json", "my-theme-3.json"]), "my-theme-2.json");
}

/// 3. 大文字小文字を区別しない(macOS の FS)。`.json` 以外の同名は数えない。
#[test]
fn export_file_name_ignores_case_and_other_extensions() {
    assert_eq!(export_file_name(&["My-Theme.json"]), "my-theme-2.json");
    assert_eq!(export_file_name(&["MY-THEME.JSON", "my-theme-2.json"]), "my-theme-3.json");
    assert_eq!(export_file_name(&["my-theme.txt", "my-theme"]), "my-theme.json");
}

/// 4. 戻り値は常に `<stem>.json` で、stem はテーマ名の文法 `^[A-Za-z0-9][A-Za-z0-9._-]*$` に合い、予約名 default ではない。
#[test]
fn export_file_name_is_a_valid_theme_file_name() {
    for existing in [&[][..], &["my-theme.json"][..], &["my-theme.json", "my-theme-2.json"][..]] {
        let name = export_file_name(existing);
        let stem = name.strip_suffix(".json").unwrap_or_else(|| panic!("{name} must end with .json"));
        assert!(stem.starts_with("my-theme"), "{name}");
        assert!(
            stem.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
                && stem.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')),
            "{name} must be a valid theme name"
        );
        assert!(!stem.eq_ignore_ascii_case("default"));
    }
}

// ---------------------------------------------------------------------------
// 中身(判断 (e))
// ---------------------------------------------------------------------------

/// 5. meta.name = "My Theme"・meta.description = "Exported from Vellis <版>"。
#[test]
fn exported_json_renames_the_meta() {
    let text = exported_theme_json("0.5.5");
    let value: serde_json::Value = serde_json::from_str(&text).expect("exported text is JSON");
    assert_eq!(value["meta"]["name"], serde_json::Value::from("My Theme"));
    assert_eq!(value["meta"]["description"], serde_json::Value::from("Exported from Vellis 0.5.5"));

    let other: serde_json::Value = serde_json::from_str(&exported_theme_json("1.2.3")).unwrap();
    assert_eq!(other["meta"]["description"], serde_json::Value::from("Exported from Vellis 1.2.3"));
}

/// 6. それ以外は Default の全文のまま(version・code・common・light・dark・meta の他の鍵)。
#[test]
fn exported_json_is_default_everywhere_else() {
    let value: serde_json::Value = serde_json::from_str(&exported_theme_json("0.5.5")).unwrap();
    let default = default_value();
    assert_eq!(without_meta(&value), without_meta(&default), "version / code / common / light / dark must be Default");
    assert_eq!(
        meta_without_name_and_description(&value),
        meta_without_name_and_description(&default),
        "the other meta keys stay"
    );
    assert_eq!(value["version"], serde_json::Value::from(1));
}

/// 7. 整形済み(複数行・すぐ直し始められる)で、末尾は改行。
#[test]
fn exported_json_is_pretty_printed() {
    let text = exported_theme_json("0.5.5");
    assert!(text.lines().count() > 10, "pretty-printed over many lines, not one line");
    assert!(text.ends_with('\n'), "ends with a newline");
    assert!(text.contains("\"color-accent\""), "carries the token keys");
}

/// 8. 利用者のテーマとして読んでも警告 0 で、値は Default と同じ(書けるもの=アプリが使うもの)。
#[test]
fn exported_json_passes_validation_as_a_user_theme_with_default_values() {
    let body = exported_theme_json("0.5.5");
    let t = resolve_theme(Some(r#"{"appearance.theme": "my-theme"}"#), move |name| {
        (name == "my-theme").then(|| body.clone())
    });
    let d = resolve_theme(None, |_| None);
    assert!(t.warnings.is_empty(), "{:?}", t.warnings);
    assert_eq!(t.light, d.light);
    assert_eq!(t.dark, d.dark);
    assert_eq!(t.code, d.code);
    assert_eq!(t.name, "my-theme");
}

// ---------------------------------------------------------------------------
// ファイル版(非上書き)
// ---------------------------------------------------------------------------

/// 9. themes/ が無ければ親ごと作り、my-theme.json に exported_theme_json(version) を書き、そのパスを返す。
#[test]
fn export_default_theme_creates_the_folder_and_writes_my_theme_json() {
    let tmp = tempfile::TempDir::new().unwrap();
    let themes = tmp.path().join("cfg").join("vellis").join("themes");
    assert!(!themes.exists());
    let written = export_default_theme(&themes, "0.5.5").expect("export succeeds");
    assert_eq!(written, themes.join("my-theme.json"));
    assert!(written.is_file());
    assert_eq!(std::fs::read_to_string(&written).unwrap(), exported_theme_json("0.5.5"));
}

/// 10. 2 回目は my-theme-2.json・3 回目は my-theme-3.json。先に書いたファイルはバイト単位で不変。
#[test]
fn export_default_theme_never_overwrites_and_numbers_the_next_file() {
    let tmp = tempfile::TempDir::new().unwrap();
    let themes = tmp.path().join("themes");
    let first = export_default_theme(&themes, "0.5.5").unwrap();
    std::fs::write(&first, "edited by the user").unwrap();
    let second = export_default_theme(&themes, "0.5.5").unwrap();
    assert_eq!(second, themes.join("my-theme-2.json"));
    assert_eq!(std::fs::read_to_string(&first).unwrap(), "edited by the user", "the first file is untouched");
    assert_eq!(std::fs::read_to_string(&second).unwrap(), exported_theme_json("0.5.5"));
    let third = export_default_theme(&themes, "0.5.5").unwrap();
    assert_eq!(third, themes.join("my-theme-3.json"));
    let names: Vec<String> = {
        let mut v: Vec<String> = std::fs::read_dir(&themes)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        v.sort();
        v
    };
    assert_eq!(names, vec!["my-theme-2.json", "my-theme-3.json", "my-theme.json"]);
}

/// 11. 利用者が置いた my-theme.json(中身は何でも)があれば、それを触らず my-theme-2.json に書く。
#[test]
fn export_default_theme_skips_a_user_file_with_the_same_name() {
    let tmp = tempfile::TempDir::new().unwrap();
    let themes = tmp.path().join("themes");
    std::fs::create_dir_all(&themes).unwrap();
    std::fs::write(themes.join("my-theme.json"), "not even json").unwrap();
    std::fs::write(themes.join("forest.json"), "{}").unwrap();
    let written = export_default_theme(&themes, "0.5.5").unwrap();
    assert_eq!(written, themes.join("my-theme-2.json"));
    assert_eq!(std::fs::read_to_string(themes.join("my-theme.json")).unwrap(), "not even json");
    assert_eq!(std::fs::read_to_string(themes.join("forest.json")).unwrap(), "{}");
}

/// 12. 書けない場所(themes_dir がファイル)は Err で panic しない。
#[test]
fn export_default_theme_returns_err_when_it_cannot_write() {
    let tmp = tempfile::TempDir::new().unwrap();
    let not_a_dir = tmp.path().join("themes");
    std::fs::write(&not_a_dir, "a file, not a folder").unwrap();
    let result = export_default_theme(Path::new(&not_a_dir), "0.5.5");
    assert!(result.is_err(), "{result:?}");
    assert_eq!(std::fs::read_to_string(&not_a_dir).unwrap(), "a file, not a folder");
}
