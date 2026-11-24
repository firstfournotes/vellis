//! 要件#74 — on_navigation の網の照合の P3 の直し(N10 と、断ったときのログ)。Rust 層の unit
//! (網と is_app_url の契約は acceptance_req74_navigation_url.rs・網の張り方の走査は acceptance_req74_navigation.rs)
//!
//! ## 直す穴(2026-11-20 照合の P3・6770da2 / 0494ebe の後)
//! - N10: plugin の閉包が `is_app_url` の答えを捨てて常に true を返しても、走査(`.on_navigation(` と `is_app_url(` の字を
//!   見るだけ)は緑のまま= 網全体が黙って消えうる。閉包は判定の関数の返り値を**そのまま**返す形に固める
//! - ログ: 断ったときの `tracing::warn!` が URL を丸ごと出す(落としたファイルなら `file:///Users/<名前>/…/<文書名>`、外の
//!   ページなら query も)。scheme だけ(http(s) なら host まで)を出す形に固める
//!
//! ## 確定契約(implementer はこれに従う=test-writer が固定・2026-11-20 オーケストレーターの指示の形)
//!
//! ```ignore
//! // --- src-tauri/src/window/navigation.rs
//! /// 網の答え(is_app_url の答えをそのまま返す)。断るときは redact_for_log を通した形だけを warn に出す。
//! pub fn allow_navigation(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool;
//! /// ログに出す形: scheme と `:` だけ(`file:`・`javascript:`・`mailto:`)。http(s) は scheme と host まで
//! /// (`https://example.com`= path・query・fragment・利用者名とパスワードを出さない)。
//! pub fn redact_for_log(url: &tauri::Url) -> String;
//!
//! // plugin の閉包は `|webview, url| allow_navigation(url, dev_of(webview))` の形= 本体が allow_navigation の呼び出しの値
//! // そのもの(走査= acceptance_req74_navigation.rs の「閉包は allow_navigation の答えをそのまま返す」)。開発のサーバの
//! // 選び分け(今の `if tauri::is_dev() { … } else { None }`)は閉包の外の関数(例 `dev_of`)に出す
//! ```
//! - http(s) の port をログに出すかは判定しない
//!
//! ## 赤になる理由(実装前)
//! `allow_navigation` と `redact_for_log` が無いので、このファイルはコンパイルできず全部赤。

use tauri::Url;
use vellis_lib::window::navigation::{allow_navigation, is_app_url, redact_for_log};

fn url(s: &str) -> Url {
    Url::parse(s).unwrap_or_else(|e| panic!("{s} must parse as a URL: {e}"))
}

fn dev_url() -> Url {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
    let conf: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("read tauri.conf.json")).expect("valid JSON");
    url(conf["build"]["devUrl"].as_str().expect("build.devUrl must be a string"))
}

/// N10: allow_navigation は is_app_url の答えをそのまま返す(落としたファイルと外のページで false・アプリのページで true)。
#[test]
fn allow_navigation_answers_exactly_what_is_app_url_answers() {
    let dev = dev_url();
    for (s, expected) in [
        ("file:///Users/a/notes/other.md", false),
        ("file:///Users/a/Desktop/page.html", false),
        ("https://example.com/", false),
        ("http://example.com/index.html?q=1", false),
        ("javascript:alert(1)", false),
        ("mailto:someone@example.com", false),
        ("tauri://localhost/", true),
        ("tauri://localhost/index.html", true),
        ("about:srcdoc", true),
        ("about:blank", true),
        ("vellis-asset://local/Users/a/Documents/report.pdf", true),
    ] {
        let u = url(s);
        assert_eq!(allow_navigation(&u, None), expected, "allow_navigation({s}, None)");
        assert_eq!(allow_navigation(&u, None), is_app_url(&u, None), "allow_navigation({s}, None) == is_app_url");
        assert_eq!(allow_navigation(&u, Some(&dev)), is_app_url(&u, Some(&dev)), "allow_navigation({s}, dev) == is_app_url");
    }
    let dev_page = url(&format!("{}/", dev.origin().ascii_serialization()));
    assert!(allow_navigation(&dev_page, Some(&dev)), "the dev server is allowed when given");
    assert!(!allow_navigation(&dev_page, None), "the dev server is refused when not given");
}

/// ログ: scheme だけ(http(s) は host まで)。path・query・fragment・利用者名・パスワード・メールの宛先は出さない。
#[test]
fn redact_for_log_keeps_only_the_scheme_and_for_http_the_host() {
    for (s, expected) in [
        ("file:///Users/x/doc.md", "file:"),
        ("file:///Users/tetsuo/Documents/%E7%A7%98%E5%AF%86.md", "file:"),
        ("file://localhost/etc/hosts", "file:"),
        ("https://example.com/a?b=c", "https://example.com"),
        ("https://example.com/a/b#frag", "https://example.com"),
        ("http://example.com/", "http://example.com"),
        ("https://user:secret@example.com/private?token=abc", "https://example.com"),
        ("javascript:alert(document.cookie)", "javascript:"),
        ("mailto:someone@example.com", "mailto:"),
        ("data:text/html,%3Ch1%3Ehi%3C/h1%3E", "data:"),
        ("vellis-asset://local/Users/x/report.pdf", "vellis-asset:"),
        ("about:srcdoc", "about:"),
    ] {
        assert_eq!(redact_for_log(&url(s)), expected, "redact_for_log({s})");
    }
}
