//! 要件#88 の受け入れテスト(docs/requirements/req-88.md)— Rust の判定(AC-88-5)
//! 「HTML の表示の中のリンクを使えるようにする(ローカルの別のファイルは Vellis で・外部の URL はブラウザで)」
//!
//! 仕組み(req-88.md「作り(決めたこと)」§2): HTML の表示の中のリンクは `vellis-asset://link/<token>?href=…` へ
//! ナビゲーションしようとする。`on_navigation` の網(要件#74 第3段 3-5・`window/navigation.rs`)はこれを**拒否**して
//! プレビューを置き換えず、その webview の窓だけにイベント `html_link_clicked`(payload `{ "url": "<その URL>" }`)を送る。
//! 断ったときの警告のログ(navigation refused)は出さない(リンク先をログに出さない)。ほかの URL の許可・拒否は今までどおり。
//!
//! ## 確定契約(implementer はこれに従う=オーケストレーターが名前を決めた・2026-11-26)
//!
//! ```ignore
//! // --- src-tauri/src/window/navigation.rs(クレートの外からは is_app_url などと同じ公開の仕方)
//! /// フロント src/lib/html-link.ts の同名定数と同じリテラル。
//! pub const HTML_LINK_CLICKED_EVENT: &str = "html_link_clicked";
//! /// `vellis-asset://link/…`(リンクのクリック)のとき真。
//! pub fn is_link_click(url: &tauri::Url) -> bool;
//! /// 今までどおり。`vellis-asset://link/…` にも偽(リンクのクリックはアプリの URL ではない=プレビューを置き換えない)。
//! pub fn is_app_url(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool;
//! /// 今までどおり is_app_url の答え。ただし `vellis-asset://link/…` のときは warn を出さない。
//! pub fn allow_navigation(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool;
//! /// リンクのクリックなら、その webview の窓だけに `emit_to` でイベント(payload `{ "url": … }`)を送って真。それ以外は何もせず偽。
//! pub fn report_link_click<R: tauri::Runtime>(webview: &tauri::Webview<R>, url: &tauri::Url) -> bool;
//!
//! // --- src-tauri/src/window/html_link.rs(新規)— window/mod.rs に `pub mod html_link;`
//! /// リンクのクリックを拾うプラグイン。on_navigation の閉包は `navigation::report_link_click(webview, url)` が真なら偽
//! /// (ナビゲーションを拒否)、偽なら真。
//! pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R>;
//!
//! // --- src-tauri/src/lib.rs — `window::html_link::plugin()` を `window::navigation::plugin()` より前に登録する
//! ```
//!
//! 2 つのプラグインに分ける理由(2026-11-26 オーケストレーターの決定 2): Tauri の `PluginStore::on_navigation` は登録の順に
//! 各プラグインを呼び、偽が返ったところで打ち切る(tauri 2.10.3 plugin.rs)。要件#74 の網(`navigation::plugin()`)の閉包は
//! 「`allow_navigation(…)` の答えそのもの」に固めてある(acceptance_req74_navigation.rs の N10)ので、そこにイベントの送信を
//! 足さず、前に置いた別のプラグインで拾う。後ろに置くと網が先に拒否して打ち切られ、通知が送られない。
//!
//! ## 判定するもの(AC-88-5)
//! 1. `vellis-asset://link/…` は `is_link_click` が真・`is_app_url` と `allow_navigation` が偽(拒否してクリックとして扱う)
//! 2. `vellis-asset://local|ssh/…`・`about:srcdoc`・`about:srcdoc#…`・`about:blank`・アプリのページは今までどおり通し、
//!    クリックとしては扱わない
//! 3. ほか(`file:`・外のページ・`javascript:`・`mailto:`・`vellis-asset://` の別の host)は今までどおり拒否し、クリックとしては扱わない
//! 4. ログ: リンクのクリックの拒否では warn を出さない(今までどおりの拒否= `file:` では warn が 1 件出る)
//! 5. イベント名の固定とフロントとの一致
//! 6. 配線(ソースの走査・acceptance_req74_navigation.rs の家風・コメントの中の字は数えない):
//!    (a) navigation.rs の `report_link_click` の本体が `is_link_click(` で判定し、`HTML_LINK_CLICKED_EVENT` を `emit_to(`(宛先つき=
//!        その窓だけ・payload に url)で送る。navigation.rs は `HTML_LINK_CLICKED_EVENT` を `.emit(`(全窓)では送らない
//!    (b) `window/html_link.rs` があり、その `on_navigation(` の閉包が `report_link_click(` を呼ぶ
//!    (c) `lib.rs` で `window::html_link::plugin()` の登録(`.plugin(`)が `window::navigation::plugin()` の登録より前にある
//!    (d) `window/mod.rs` が `pub mod html_link;` で公開する(今の `navigation` と同じ)
//!
//! ## 判定しないもの
//! - 実際の webview でクリックが届いてイベントが出ること・`report_link_click` が本物の窓に送ること(AC-88-8 実機・reviewer の照合)・
//!   payload の形(`{ "url": … }`)= reviewer の照合
//! - プロトコルハンドラが `vellis-asset://link/…` の読み込み(画像の `src` など)に失敗を返すこと= 今の `lib.rs` の作り(host が
//!   local / ssh 以外は失敗)。変えないので reviewer の照合
//! - 要件#74 の網(`navigation::plugin()`・N10・ログ)が今までどおりなこと= acceptance_req74_navigation*.rs(書き換えない)
//!
//! ## 判断の記録(test-writer・2026-11-26)
//! - `report_link_click` の振る舞いは本物の `Webview` が要るので、unit では呼ばず走査で固定する(tauri の mock runtime で窓を
//!   作って listen する作りは重く、壊れやすい)。実機(AC-88-8)で確かめる
//!
//! ## 赤になる理由(実装前)
//! `is_link_click` と `HTML_LINK_CLICKED_EVENT` が無いので、このファイルはコンパイルできず全部赤。走査の 6(a)〜(d)も、
//! `report_link_click`・`window/html_link.rs`・`pub mod html_link;`・lib.rs の登録が無いので赤(走査の器の自己検査だけ最初から緑)。

use std::sync::{Arc, Mutex};

use tauri::Url;
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};
use vellis_lib::window::navigation::{allow_navigation, is_app_url, is_link_click, HTML_LINK_CLICKED_EVENT};

fn manifest_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_source(rel: &str) -> String {
    let path = manifest_dir().join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {}", path.display(), e))
}

fn url(s: &str) -> Url {
    Url::parse(s).unwrap_or_else(|e| panic!("{s} must parse as a URL: {e}"))
}

/// tauri.conf.json の `build.devUrl`(開発のサーバ)。
fn dev_url() -> Url {
    let conf: serde_json::Value =
        serde_json::from_str(&read_source("tauri.conf.json")).expect("tauri.conf.json must be valid JSON");
    url(conf["build"]["devUrl"].as_str().expect("build.devUrl must be a string"))
}

const TOKEN: &str = "tok_ABC-123_xyz";

/// リンクのクリックの URL(srcdoc が作る形= `vellis-asset://link/<token>?href=<encodeURIComponent(原文)>`)。
fn link_clicks() -> Vec<String> {
    vec![
        format!("vellis-asset://link/{TOKEN}?href=https%3A%2F%2Fexternal.example%2Fpage"),
        format!("vellis-asset://link/{TOKEN}?href=other%2Fpage2.html"),
        format!("vellis-asset://link/{TOKEN}?href=..%2Fup.pdf%23sec"),
        format!("vellis-asset://link/{TOKEN}?href=mailto%3Asomeone%40example.com"),
        format!("vellis-asset://link/{TOKEN}?href=javascript%3Aalert(1)"),
        format!("vellis-asset://link/{TOKEN}?href=file%3A%2F%2F%2FUsers%2Fa%2Fnotes%2Fother.md"),
        format!("vellis-asset://link/{TOKEN}?href="),
        format!("vellis-asset://link/{TOKEN}"),
        // トークンが違っても「クリック」としては扱う(照合はフロントの持ち場=捨てる)
        "vellis-asset://link/other-token?href=other.html".to_string(),
        // 入れ子の iframe の src など、クリックでない細工も同じ URL で届く(区別できない=トークンで捨てる)
        "vellis-asset://link/?href=other.html".to_string(),
    ]
}

/// アプリ自身の URL(今までどおり通す)。
const APP_URLS: [&str; 12] = [
    "about:srcdoc",
    // host が `local` ならパスが `/link/…` でもふつうのローカルのファイル(クリックではない・今までどおり通す)
    "vellis-asset://local/link/tok?href=other.html",
    "about:srcdoc#sec",
    "about:srcdoc#top",
    "about:srcdoc#%E8%A6%81%E7%B4%84",
    "about:blank",
    "vellis-asset://local/Users/a/Documents/report.pdf",
    "vellis-asset://local/Users/a/My%20Docs/%E8%B3%87%E6%96%99.html",
    "vellis-asset://ssh/alice@host.example:22/srv/docs/report.pdf",
    "vellis-asset://ssh/host.example/srv/docs/report.pdf",
    "tauri://localhost/",
    "tauri://localhost/index.html",
];

/// 今までどおり拒否する URL(クリックではない)。
const REFUSED_URLS: [&str; 11] = [
    "file:///Users/a/notes/other.md",
    "file:///Users/a/Desktop/page.html",
    "file://localhost/etc/hosts",
    "https://example.com/",
    "http://example.com/index.html",
    "https://external.example/link/tok?href=other.html",
    "javascript:alert(1)",
    "mailto:someone@example.com",
    "tauri://example.com/",
    "vellis-asset://links/tok?href=other.html",
    "vellis-asset://remote/host/x.html",
];

// ---------------------------------------------------------------------------
// tracing の記録の捕まえ方(this thread の scoped subscriber。allow_navigation は同じスレッドで同期に走る)
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct Records(Arc<Mutex<Vec<(tracing::Level, String)>>>);

struct MessageVisitor(String);

impl tracing::field::Visit for MessageVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.0 = format!("{value:?}");
        }
    }
}

impl<S: tracing::Subscriber> Layer<S> for Records {
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = MessageVisitor(String::new());
        event.record(&mut visitor);
        self.0.lock().expect("records lock").push((*event.metadata().level(), visitor.0));
    }
}

/// `f` の間に出た tracing の記録(level, message)。
fn captured<T>(f: impl FnOnce() -> T) -> (T, Vec<(tracing::Level, String)>) {
    let records = Records::default();
    let subscriber = tracing_subscriber::registry().with(records.clone());
    let out = tracing::subscriber::with_default(subscriber, f);
    let logs = records.0.lock().expect("records lock").clone();
    (out, logs)
}

fn warnings(logs: &[(tracing::Level, String)]) -> Vec<&str> {
    logs.iter().filter(|(level, _)| *level == tracing::Level::WARN).map(|(_, m)| m.as_str()).collect()
}

// ---------------------------------------------------------------------------
// 1. リンクのクリックは拒否してクリックとして扱う
// ---------------------------------------------------------------------------

/// `vellis-asset://link/…` は is_link_click が真。
#[test]
fn a_link_click_is_recognised_by_its_host() {
    for s in link_clicks() {
        assert!(is_link_click(&url(&s)), "{s} is a link click (host `link`) and must be recognised");
    }
}

/// `vellis-asset://link/…` はアプリの URL ではなく、網は拒否する(プレビューは置き換わらない)。dev_url の有無で変わらない。
#[test]
fn a_link_click_is_refused_and_is_not_an_app_url() {
    let dev = dev_url();
    for s in link_clicks() {
        let u = url(&s);
        assert!(!is_app_url(&u, None), "{s} is not one of the app's own URLs");
        assert!(!is_app_url(&u, Some(&dev)), "{s} is not one of the app's own URLs (dev)");
        assert!(!allow_navigation(&u, None), "{s} must be refused so the preview stays");
        assert!(!allow_navigation(&u, Some(&dev)), "{s} must be refused so the preview stays (dev)");
    }
}

// ---------------------------------------------------------------------------
// 2・3. ほかの URL は今までどおり(クリックとしては扱わない)
// ---------------------------------------------------------------------------

/// アプリ自身の URL(`about:srcdoc#…` を含む)は今までどおり通し、クリックではない。
#[test]
fn the_app_urls_are_still_allowed_and_are_not_link_clicks() {
    let dev = dev_url();
    for s in APP_URLS {
        let u = url(s);
        assert!(is_app_url(&u, None), "{s} is the app's own URL and must still be allowed");
        assert!(allow_navigation(&u, None), "{s} must still be allowed by the net");
        assert!(allow_navigation(&u, Some(&dev)), "{s} must still be allowed by the net (dev)");
        assert!(!is_link_click(&u), "{s} is not a link click");
    }
}

/// 落としたファイル・外のページ・script・メール・`vellis-asset://` の別の host は今までどおり拒否し、クリックではない。
#[test]
fn the_other_urls_are_still_refused_and_are_not_link_clicks() {
    let dev = dev_url();
    for s in REFUSED_URLS {
        let u = url(s);
        assert!(!is_app_url(&u, None), "{s} is not the app's own URL");
        assert!(!allow_navigation(&u, None), "{s} must still be refused");
        assert!(!allow_navigation(&u, Some(&dev)), "{s} must still be refused (dev)");
        assert!(!is_link_click(&u), "{s} is not a link click (only host `link` of vellis-asset is)");
    }
}

/// 開発のサーバは今までどおり: 渡したときだけ通す(リンクのクリックの追加で変わらない)。
#[test]
fn the_dev_server_rule_is_unchanged() {
    let dev = dev_url();
    let page = url(&format!("{}/", dev.origin().ascii_serialization()));
    assert!(allow_navigation(&page, Some(&dev)));
    assert!(!allow_navigation(&page, None));
    assert!(!is_link_click(&page));
}

// ---------------------------------------------------------------------------
// 4. ログ
// ---------------------------------------------------------------------------

/// リンクのクリックの拒否では warn を出さない(リンク先をログに出さない。普通の拒否は今までどおり warn が 1 件)。
#[test]
fn a_link_click_is_refused_without_a_warning() {
    for s in link_clicks() {
        let (allowed, logs) = captured(|| allow_navigation(&url(&s), None));
        assert!(!allowed, "{s} must be refused");
        assert_eq!(warnings(&logs), Vec::<&str>::new(), "a link click must not be logged as a refusal: {s}");
    }

    let (allowed, logs) = captured(|| allow_navigation(&url("file:///Users/a/notes/other.md"), None));
    assert!(!allowed);
    let warns = warnings(&logs);
    assert_eq!(warns.len(), 1, "an ordinary refusal still logs one warning: {logs:?}");
    assert!(warns[0].contains("navigation refused"), "the ordinary refusal keeps its wording: {}", warns[0]);
    assert!(!warns[0].contains("other.md"), "the ordinary refusal still redacts the path: {}", warns[0]);
}

// ---------------------------------------------------------------------------
// 5. イベント名
// ---------------------------------------------------------------------------

/// イベント名は snake_case のリテラルで固定され、フロント(src/lib/html-link.ts)の同名定数と同じ。
#[test]
fn the_event_name_is_fixed_and_matches_the_frontend() {
    assert_eq!(HTML_LINK_CLICKED_EVENT, "html_link_clicked");
    let ts = read_source("../src/lib/html-link.ts");
    let needle = "export const HTML_LINK_CLICKED_EVENT";
    let at = ts.find(needle).unwrap_or_else(|| panic!("src/lib/html-link.ts must have `{needle} = '…'`"));
    let rest = &ts[at + needle.len()..];
    let eq = rest.find('=').expect("HTML_LINK_CLICKED_EVENT must be assigned a literal");
    let after = rest[eq + 1..].trim_start();
    let quote = after.chars().next().expect("a quoted literal");
    assert!(quote == '\'' || quote == '"', "HTML_LINK_CLICKED_EVENT must be a string literal: {after}");
    let literal: String = after[1..].chars().take_while(|c| *c != quote).collect();
    assert_eq!(literal, HTML_LINK_CLICKED_EVENT, "the frontend event name must match the Rust one");
}

// ---------------------------------------------------------------------------
// 6. 配線(ソースの走査)
// ---------------------------------------------------------------------------

const NAV_MODULE: &str = "src/window/navigation.rs";

/// コメント(`//` と `/* */`)を落とす。`://`(URL のリテラル)はコメントではないので落とさない。
fn strip_comments(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let bytes = src.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            let end = src[i + 2..].find("*/").map_or(src.len(), |p| i + 2 + p + 2);
            i = end;
            continue;
        }
        if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' && (i == 0 || bytes[i - 1] != b':') {
            let end = src[i..].find('\n').map_or(src.len(), |p| i + p);
            i = end;
            continue;
        }
        let ch = src[i..].chars().next().expect("char boundary");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// 文字列と文字のリテラルの中身を空白にする(長さは同じ)。括弧の対応を数えるとき `"{}"` や `'('` に釣られないため。
/// `"…"`(`\` のエスケープあり)・`r"…"` / `r#"…"#`・`'x'` / `'\n'` / `b'"'` を読む。ライフタイム(`'a`)は触らない。
fn mask_strings(src: &str) -> String {
    let b = src.as_bytes();
    let mut out = b.to_vec();
    let blank = |out: &mut Vec<u8>, from: usize, to: usize| {
        for byte in out.iter_mut().take(to.min(b.len())).skip(from) {
            if *byte != b'\n' {
                *byte = b' ';
            }
        }
    };
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let next = b.get(i + 1).copied();
        let prev_ident = i > 0 && (b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_');
        if c == b'r' && matches!(next, Some(b'"') | Some(b'#')) && !prev_ident {
            let mut j = i + 1;
            let mut hashes = 0;
            while b.get(j) == Some(&b'#') {
                hashes += 1;
                j += 1;
            }
            if b.get(j) == Some(&b'"') {
                let mut close = vec![b'"'];
                close.extend(std::iter::repeat_n(b'#', hashes));
                let end = b[j + 1..].windows(close.len()).position(|w| w == close.as_slice()).map_or(b.len(), |p| j + 1 + p);
                blank(&mut out, j + 1, end);
                i = end + close.len();
                continue;
            }
            i += 1;
        } else if c == b'"' {
            let mut j = i + 1;
            while j < b.len() && b[j] != b'"' {
                if b[j] == b'\\' {
                    j += 1;
                }
                j += 1;
            }
            blank(&mut out, i + 1, j);
            i = j + 1;
        } else if c == b'\'' {
            if next == Some(b'\\') {
                let start = (i + 3).min(b.len());
                let end = b[start..].iter().position(|&x| x == b'\'').map_or(b.len(), |p| start + p);
                blank(&mut out, i + 1, end);
                i = end + 1;
            } else if b.get(i + 2) == Some(&b'\'') {
                blank(&mut out, i + 1, i + 2);
                i += 3;
            } else {
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    String::from_utf8(out).expect("masking keeps UTF-8")
}

/// 走査に使う形: コメントを落とし、文字列の中身を伏せる。
fn scan_code(src: &str) -> String {
    mask_strings(&strip_comments(src))
}

/// `open`(`(` の位置)に対応する `)` の位置。
fn matching_close(code: &str, open: usize) -> usize {
    let mut depth = 0usize;
    for (i, c) in code[open..].char_indices() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => {
                depth -= 1;
                if depth == 0 {
                    return open + i;
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced bracket starting at byte {open}");
}

/// `name(` の呼び出し(定義 `fn name(` は除く)の引数の文字列を全部返す。
fn call_args(code: &str, name: &str) -> Vec<String> {
    let needle = format!("{name}(");
    let mut out = Vec::new();
    let mut search = 0;
    while let Some(p) = code[search..].find(&needle) {
        let at = search + p;
        search = at + needle.len();
        let before = &code[..at];
        if before.chars().next_back().is_some_and(|c| c.is_alphanumeric() || c == '_') {
            continue;
        }
        if before.trim_end().ends_with("fn") {
            continue;
        }
        let open = at + name.len();
        let close = matching_close(code, open);
        out.push(code[open + 1..close].to_string());
    }
    out
}

fn tokens(s: &str) -> Vec<&str> {
    s.split(|c: char| !(c.is_alphanumeric() || c == '_')).filter(|t| !t.is_empty()).collect()
}

/// 呼び出しの引数の文字列の、最初の引数(いちばん外のコンマまで)。
fn first_arg(args: &str) -> &str {
    let mut depth = 0usize;
    for (i, c) in args.char_indices() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => return &args[..i],
            _ => {}
        }
    }
    args
}

/// `fn <name>` の本体(最初の `{` の次から対応する `}` の手前まで)。無ければ None。
fn fn_body(code: &str, name: &str) -> Option<String> {
    let needle = format!("fn {name}");
    let mut search = 0;
    while let Some(p) = code[search..].find(&needle) {
        let at = search + p;
        search = at + needle.len();
        let after = code[at + needle.len()..].chars().next();
        if !matches!(after, Some('<') | Some('(')) {
            continue; // `fn report_link_click_x` など、名前が続くものは別の関数
        }
        let open = code[at..].find('{').map(|q| at + q)?;
        let close = matching_close(code, open);
        return Some(code[open + 1..close].to_string());
    }
    None
}

/// `.plugin(` の登録(位置, 引数)を lib.rs の順に返す。
fn plugin_registrations(code: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut search = 0;
    while let Some(p) = code[search..].find(".plugin(") {
        let at = search + p;
        search = at + ".plugin(".len();
        let open = at + ".plugin".len();
        let close = matching_close(code, open);
        out.push((at, code[open + 1..close].to_string()));
    }
    out
}

fn squeeze(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

/// 走査の器の自己検査: 定義と呼び出し・コメント・登録の順を読み分ける。
#[test]
fn the_wiring_scan_reads_calls_and_skips_definitions_and_comments() {
    let sample = "// emit_to(label, HTML_LINK_CLICKED_EVENT, x)\n\
                  pub fn is_link_click(url: &Url) -> bool { url.host_str() == Some(\"link\") }\n\
                  pub fn report_link_click<R: Runtime>(webview: &Webview<R>, url: &Url) -> bool {\n\
                      if !is_link_click(url) {\n\
                          return false;\n\
                      }\n\
                      let _ = webview.emit_to(webview.label(), HTML_LINK_CLICKED_EVENT, Payload { url: url.to_string() });\n\
                      true\n\
                  }\n\
                  fn report_link_click_twice() { /* emit_to(a, HTML_LINK_CLICKED_EVENT, b) */ }\n";
    let code = strip_comments(sample);
    assert_eq!(call_args(&code, "is_link_click"), vec!["url".to_string()]);
    let body = fn_body(&code, "report_link_click").expect("the sample defines report_link_click");
    assert!(body.contains("is_link_click(") && body.contains("emit_to("));
    assert!(!body.contains("report_link_click_twice"), "the body stops at its own closing brace");
    assert_eq!(mask_strings("a(\"x(\", '(', b\"{\") // k"), "a(\"  \", ' ', b\" \") // k");
    assert_eq!(mask_strings("r#\"a)\"# + '\\n' + \"\\\"}\""), "r#\"  \"# + '  ' + \"   \"");
    let emits = call_args(&body, "emit_to");
    assert_eq!(emits.len(), 1);
    assert!(tokens(&emits[0]).contains(&"HTML_LINK_CLICKED_EVENT"));
    assert!(tokens(&emits[0]).contains(&"url"));
    assert_eq!(first_arg(&emits[0]).trim(), "webview.label()");
    assert!(tokens(first_arg(&emits[0])).contains(&"label"), "the destination is this webview's label");
    let fixed = mask_strings("webview.emit_to(\"main\", HTML_LINK_CLICKED_EVENT, Payload { url: url.to_string() })");
    let fixed_args = call_args(&fixed, "emit_to");
    assert!(!tokens(first_arg(&fixed_args[0])).contains(&"label"), "a fixed \"main\" destination is not a label");
    assert_eq!(first_arg("a(b, c), d"), "a(b, c)");
    assert!(call_args(&code, "emit").is_empty(), "emit_to is not emit");
    assert!(fn_body(&code, "missing").is_none());
    assert_eq!(strip_comments("let u = \"vellis-asset://link/x\"; // c\n"), "let u = \"vellis-asset://link/x\"; \n");

    let lib = "pub fn run_app() {\n\
                   // .plugin(window::html_link::plugin())\n\
                   let builder = tauri::Builder::default()\n\
                       .plugin(tauri_plugin_opener::init())\n\
                       .plugin(window::navigation::plugin())\n\
                       .plugin(window::html_link::plugin());\n\
               }\n";
    let regs = plugin_registrations(&strip_comments(lib));
    let names: Vec<String> = regs.iter().map(|(_, a)| squeeze(a)).collect();
    assert_eq!(
        names,
        vec!["tauri_plugin_opener::init()", "window::navigation::plugin()", "window::html_link::plugin()"],
        "registrations in source order, comments skipped"
    );
    assert!(regs[1].0 < regs[2].0);
}

/// 6(a). navigation.rs の `report_link_click` は `is_link_click(` で判定し、`HTML_LINK_CLICKED_EVENT` を宛先つきの `emit_to(` で
///    送る(URL を payload に)。navigation.rs は全窓への `.emit(` では送らない(契約 12: 通知はそのリンクを表示している窓だけが受ける)。
#[test]
fn report_link_click_sends_the_click_to_that_webview_only() {
    let code = scan_code(&read_source(NAV_MODULE));
    let body = fn_body(&code, "report_link_click")
        .unwrap_or_else(|| panic!("{NAV_MODULE} must define `pub fn report_link_click<R: Runtime>(webview: &Webview<R>, url: &Url) -> bool`"));
    assert!(
        !call_args(&body, "is_link_click").is_empty(),
        "report_link_click must decide with is_link_click(url): {body}"
    );
    let emits: Vec<String> = call_args(&body, "emit_to")
        .into_iter()
        .filter(|args| tokens(args).contains(&"HTML_LINK_CLICKED_EVENT"))
        .collect();
    assert!(
        !emits.is_empty(),
        "report_link_click must send HTML_LINK_CLICKED_EVENT with emit_to(<that window>, HTML_LINK_CLICKED_EVENT, <payload with the url>): {body}"
    );
    for args in &emits {
        assert!(tokens(args).contains(&"url"), "the payload must carry the URL (payload {{ url }}): emit_to({args})");
        // 送り先はその webview のラベル(`webview.label()` など)。`"main"` のような固定の宛先は別の窓に届く(照合の P3-5)
        assert!(
            tokens(first_arg(args)).contains(&"label"),
            "the destination of emit_to must be this webview's label (webview.label()), not a fixed window: emit_to({args})"
        );
    }
    let broadcasts: Vec<String> = call_args(&code, "emit")
        .into_iter()
        .filter(|args| tokens(args).contains(&"HTML_LINK_CLICKED_EVENT"))
        .collect();
    assert!(
        broadcasts.is_empty(),
        "HTML_LINK_CLICKED_EVENT must not be broadcast with emit(…) (every window would open the link): {broadcasts:?}"
    );
}

const HTML_LINK_MODULE: &str = "src/window/html_link.rs";

/// 6(b). `window/html_link.rs` のプラグインの `on_navigation(` の閉包が `report_link_click(` を呼ぶ(拾う側のプラグイン)。
#[test]
fn the_html_link_plugin_reports_the_click_from_its_on_navigation() {
    let src = std::fs::read_to_string(manifest_dir().join(HTML_LINK_MODULE))
        .unwrap_or_else(|e| panic!("{HTML_LINK_MODULE} must exist (the plugin that picks up link clicks): {e}"));
    let code = scan_code(&src);
    assert!(
        fn_body(&code, "plugin").is_some(),
        "{HTML_LINK_MODULE} must define `pub fn plugin<R: Runtime>() -> TauriPlugin<R>`"
    );
    let closures = call_args(&code, "on_navigation");
    assert!(!closures.is_empty(), "{HTML_LINK_MODULE} must register the pickup with .on_navigation(…)");
    let reporting: Vec<&String> = closures.iter().filter(|c| !call_args(c, "report_link_click").is_empty()).collect();
    assert!(
        !reporting.is_empty(),
        "the on_navigation closure of {HTML_LINK_MODULE} must call navigation::report_link_click(webview, url): {closures:?}"
    );
}

/// 6(c). lib.rs は `window::html_link::plugin()` を `window::navigation::plugin()` より前に登録する(後ろだと網が先に拒否して
///    打ち切られ、通知が送られない)。
#[test]
fn the_html_link_plugin_is_registered_before_the_navigation_net() {
    let code = scan_code(&read_source("src/lib.rs"));
    let regs = plugin_registrations(&code);
    let position = |needle: &str| regs.iter().find(|(_, args)| squeeze(args).contains(needle)).map(|(at, _)| *at);
    let html_link = position("html_link::plugin(")
        .unwrap_or_else(|| panic!("lib.rs must register window::html_link::plugin() with .plugin(…): {regs:?}"));
    let navigation = position("navigation::plugin(")
        .unwrap_or_else(|| panic!("lib.rs must still register window::navigation::plugin() with .plugin(…): {regs:?}"));
    assert!(
        html_link < navigation,
        "window::html_link::plugin() (byte {html_link}) must be registered before window::navigation::plugin() (byte {navigation}): \
         Tauri calls the plugins' on_navigation in registration order and stops at the first refusal"
    );
}

/// 6(d). `window/mod.rs` は `html_link` を `navigation` と同じ公開の仕方(`pub mod`)で公開する。
#[test]
fn the_window_module_publishes_html_link_like_navigation() {
    let code = squeeze(&scan_code(&read_source("src/window/mod.rs")));
    assert!(code.contains("pubmodnavigation;"), "window/mod.rs must keep `pub mod navigation;`");
    assert!(code.contains("pubmodhtml_link;"), "window/mod.rs must publish `pub mod html_link;`");
}
