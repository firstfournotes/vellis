//! 要件#25 追補a の受け入れテスト(docs/requirements/req-25.md「追補a 配布版
//! (Hardened Runtime 署名)でも framework を読み込めるようにする」・AC-25-8)
//!
//! 「macOS の配布版に entitlement `com.apple.security.cs.disable-library-validation`
//!  = `true` を付ける。置き場所は `src-tauri/` 配下の entitlements ファイル(plist)で、
//!  `tauri.conf.json` の `bundle.macOS.entitlements` から参照する。付ける entitlement は
//!  この 1 つだけ」のうち、機械判定できる部分:
//! ① `tauri.conf.json` の `bundle.macOS.entitlements` が entitlements ファイルを指す
//!    (パスは tauri.conf.json からの相対= `src-tauri/` 基準。ファイル名は実装側が決める
//!    ので、本テストは設定値からパスを解決して読む=決め打ちしない)
//! ② そのファイルが実在し、正しい plist(XML・ルート `<dict>`)である
//! ③ `com.apple.security.cs.disable-library-validation` の値が `<true/>`
//! ④ キーはこの 1 つだけ(他の `com.apple.security.*` キー・他のキーを含まない)
//!
//! 判定範囲(本ファイル): 上記①〜④のみ。以下はテスト不能につき本ファイルの外 —
//! **署名済みビルドに entitlement が実際に載ること(`codesign -d --entitlements -`)は
//! reviewer 照合**、**それで 3DxWare 常駐下の SpaceMouse が動くこと(実機動作)は
//! 人間ゲート 5**(req-25.md「人間ゲート」節)。
//!
//! 依存追加なし: 設定の解釈は既存依存の serde_json、plist の解釈は本ファイル内の
//! 最小パーサ(コメント除去 → `<plist>` 直下の `<dict>` を取り出し → `<key>` と
//! 直後の値要素を列挙)で行う。
//!
//! 既存の acceptance_req25.rs(1周目・13件)は変更しない。
//!
//! 赤の設計: 実装前は `tauri.conf.json` に `bundle.macOS` 節がなく、entitlements
//! ファイルも存在しないため、4 ケースとも未実装が理由で失敗する。

use std::path::{Path, PathBuf};

/// tauri.conf.json は既存テスト(acceptance_req35/36 などの include_str! 方式)に
/// 倣ってコンパイル時に取り込む。テストファイル基準の相対= `src-tauri/tauri.conf.json`。
const TAURI_CONF: &str = include_str!("../tauri.conf.json");

const REQUIRED_KEY: &str = "com.apple.security.cs.disable-library-validation";

/// `tauri.conf.json` の `bundle.macOS.entitlements` を文字列で返す。
/// 節やキーが無い・文字列でない場合は、その理由を Err で返す(赤の理由を読めるように)。
fn entitlements_setting() -> Result<String, String> {
    let conf: serde_json::Value = serde_json::from_str(TAURI_CONF)
        .map_err(|e| format!("tauri.conf.json が JSON として読めない: {e}"))?;
    let value = conf
        .pointer("/bundle/macOS/entitlements")
        .ok_or_else(|| "tauri.conf.json に bundle.macOS.entitlements が無い".to_string())?;
    let s = value
        .as_str()
        .ok_or_else(|| format!("bundle.macOS.entitlements が文字列でない: {value}"))?;
    if s.trim().is_empty() {
        return Err("bundle.macOS.entitlements が空文字列".to_string());
    }
    Ok(s.to_string())
}

/// 設定値を `src-tauri/`(= CARGO_MANIFEST_DIR = tauri.conf.json の置き場)基準で解決する。
fn resolve_entitlements_path(setting: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(setting)
}

/// 設定を解決して entitlements ファイルの中身を読む(前段が満たされない場合は panic して
/// 理由を出す。後段のケースは前段の基準に依存するため、失敗理由が同じでも構わない)。
fn read_entitlements() -> String {
    let setting = entitlements_setting().unwrap_or_else(|e| panic!("{e}"));
    let path = resolve_entitlements_path(&setting);
    std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "bundle.macOS.entitlements が指すファイル {} を読めない: {e}",
            path.display()
        )
    })
}

/// XML コメント(`<!-- ... -->`)を取り除く。コメント内に他の entitlement 名が書かれて
/// いても「キー」ではないので判定対象から外す。
fn strip_xml_comments(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut rest = src;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 4..];
        match after.find("-->") {
            Some(end) => rest = &after[end + 3..],
            None => {
                // 閉じないコメント=壊れた XML。残りを捨てて呼び出し側の plist 判定に任せる
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// `<plist ...>` 直下の `<dict>` … `</dict>` の中身を返す。plist として成立していなければ Err。
fn plist_root_dict_body(src: &str) -> Result<String, String> {
    let s = strip_xml_comments(src);
    let trimmed = s.trim_start();
    if !trimmed.starts_with("<?xml") {
        return Err("plist が XML 宣言(<?xml ...?>)で始まっていない".to_string());
    }
    let plist_open = s
        .find("<plist")
        .ok_or_else(|| "plist に <plist ...> 要素が無い".to_string())?;
    let plist_close = s
        .rfind("</plist>")
        .ok_or_else(|| "plist に </plist> が無い".to_string())?;
    if plist_close < plist_open {
        return Err("</plist> が <plist> より前にある".to_string());
    }
    let inner = &s[plist_open..plist_close];
    // <plist ...> の '>' 以降がルート要素
    let gt = inner
        .find('>')
        .ok_or_else(|| "<plist 開始タグが閉じていない".to_string())?;
    let root = inner[gt + 1..].trim();
    if !root.starts_with("<dict>") {
        return Err(format!(
            "plist のルート要素が <dict> でない(先頭: {:?})",
            root.chars().take(40).collect::<String>()
        ));
    }
    let dict_close = root
        .rfind("</dict>")
        .ok_or_else(|| "ルート <dict> が </dict> で閉じていない".to_string())?;
    let body = &root["<dict>".len()..dict_close];
    let tail = root[dict_close + "</dict>".len()..].trim();
    if !tail.is_empty() {
        return Err(format!("ルート <dict> の後ろに余計な内容がある: {tail:?}"));
    }
    Ok(body.to_string())
}

/// `<dict>` 本体から `(キー名, 直後の値要素タグ)` の列を返す。
/// 値要素は `<key>` の直後(空白を挟んでよい)に現れる最初のタグをそのまま文字列で返す
/// (例: `<true/>`・`<false/>`・`<string>`・`<array>`)。
fn dict_entries(body: &str) -> Result<Vec<(String, String)>, String> {
    let mut entries = Vec::new();
    let mut rest = body;
    loop {
        let Some(k_start) = rest.find("<key>") else {
            break;
        };
        let after_key_open = &rest[k_start + "<key>".len()..];
        let k_end = after_key_open
            .find("</key>")
            .ok_or_else(|| "<key> が </key> で閉じていない".to_string())?;
        let name = after_key_open[..k_end].trim().to_string();
        let after_key = after_key_open[k_end + "</key>".len()..].trim_start();
        if !after_key.starts_with('<') {
            return Err(format!("キー {name:?} の直後が要素でない: {:?}", after_key.chars().take(20).collect::<String>()));
        }
        let tag_end = after_key
            .find('>')
            .ok_or_else(|| format!("キー {name:?} の値要素タグが閉じていない"))?;
        let tag = after_key[..=tag_end].to_string();
        if tag.starts_with("<key") || tag.starts_with("</") {
            return Err(format!("キー {name:?} に値要素が無い(直後が {tag})"));
        }
        entries.push((name, tag));
        rest = &after_key[tag_end + 1..];
    }
    // <key> 以外に残った非空白テキストや要素があれば dict として不正
    Ok(entries)
}

/// ① 設定が entitlements ファイルを指し、`src-tauri/` 配下のファイルとして実在する
#[test]
fn ac_25_8_tauri_conf_points_to_existing_entitlements_file() {
    let setting = entitlements_setting().unwrap_or_else(|e| panic!("{e}"));

    // 契約: 置き場所は src-tauri/ 配下。tauri.conf.json からの相対で書く
    let p = Path::new(&setting);
    assert!(
        p.is_relative(),
        "bundle.macOS.entitlements は tauri.conf.json からの相対パスで書く(現在: {setting:?})"
    );
    assert!(
        !p.components().any(|c| matches!(c, std::path::Component::ParentDir)),
        "bundle.macOS.entitlements は src-tauri/ 配下を指す(`..` を含まない)。現在: {setting:?}"
    );

    let resolved = resolve_entitlements_path(&setting);
    assert!(
        resolved.is_file(),
        "bundle.macOS.entitlements が指すファイルが実在しない: {}",
        resolved.display()
    );
}

/// ② ファイルが正しい plist(XML 宣言・`<plist>`・ルート `<dict>`)である
#[test]
fn ac_25_8_entitlements_file_is_xml_plist_with_root_dict() {
    let src = read_entitlements();
    let body = plist_root_dict_body(&src).unwrap_or_else(|e| panic!("{e}"));
    // dict の中身が「<key>+値」の並びとして解釈できる(壊れた XML を弾く)
    let entries = dict_entries(&body).unwrap_or_else(|e| panic!("{e}"));
    assert!(
        !entries.is_empty(),
        "ルート <dict> にエントリが 1 つも無い(entitlement が付いていない)"
    );
}

/// ③ `com.apple.security.cs.disable-library-validation` が `<true/>`
#[test]
fn ac_25_8_disable_library_validation_is_true() {
    let src = read_entitlements();
    let body = plist_root_dict_body(&src).unwrap_or_else(|e| panic!("{e}"));
    let entries = dict_entries(&body).unwrap_or_else(|e| panic!("{e}"));

    let matching: Vec<&(String, String)> =
        entries.iter().filter(|(k, _)| k == REQUIRED_KEY).collect();
    assert_eq!(
        matching.len(),
        1,
        "{REQUIRED_KEY} がルート <dict> にちょうど 1 回現れる(現在: {} 回・全キー: {:?})",
        matching.len(),
        entries.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>()
    );
    let value_tag = matching[0].1.replace(' ', "");
    assert_eq!(
        value_tag, "<true/>",
        "{REQUIRED_KEY} の値は <true/> でなければならない(現在: {})",
        matching[0].1
    );
}

/// ④ キーはこの 1 つだけ(他の `com.apple.security.*` を含む一切の他キーを持たない)
#[test]
fn ac_25_8_disable_library_validation_is_the_only_key() {
    let src = read_entitlements();
    let body = plist_root_dict_body(&src).unwrap_or_else(|e| panic!("{e}"));
    let entries = dict_entries(&body).unwrap_or_else(|e| panic!("{e}"));

    let keys: Vec<&str> = entries.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(
        keys,
        vec![REQUIRED_KEY],
        "entitlements のキーは {REQUIRED_KEY} の 1 つだけ(他の Hardened Runtime 緩和=\
         allow-jit / allow-unsigned-executable-memory / allow-dyld-environment-variables / \
         disable-executable-page-protection などを付けない)。現在のキー: {keys:?}"
    );

    // 入れ子(<dict>/<array> の中)に他の entitlement 名を忍ばせることも許さない:
    // コメントを除いたファイル全体で `<key>` 要素は 1 つだけ、
    // `com.apple.security.` の出現も 1 回だけ
    let stripped = strip_xml_comments(&src);
    assert_eq!(
        stripped.matches("<key>").count(),
        1,
        "entitlements ファイル全体で <key> 要素は 1 つだけ(入れ子も含む)"
    );
    assert_eq!(
        stripped.matches("com.apple.security.").count(),
        1,
        "entitlements ファイル全体で com.apple.security.* の出現は required key の 1 回だけ"
    );
}
