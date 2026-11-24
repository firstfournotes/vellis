//! 要件#74 第3段 3-5 の続き(ドロップの周回の差し戻しの直し)— on_navigation の網の判定の関数
//! (docs/requirements/req-74.md 状態節 8d071ec の事後確認 (26)= オーケストレーターの判断。Rust 層の unit)
//!
//! ## 何が起きたか(照合役の読み・P2)
//! drag-drop の受け手を切った(1cb3164)ので、ドラッグが WKWebView に届く。file-drop-guard は主の文書の window にしか
//! 付かず、HtmlViewer の iframe(`sandbox=""`・srcdoc・script なし)の中の dragover / drop は見えない。WebKit は、iframe の
//! 文書が drop を取り消さず編集もできないとき、主の窓(mainFrame)で落としたファイルの URL を load する
//! (DragController::performDragOperation の operationForLoad)。アプリは on_navigation を持たないので、Tauri
//! (tauri-2.10.3 `src/manager/webview.rs:548-575`)も wry(wry-0.54.4 `src/wkwebview/navigation.rs:50-82`)も Allow を返す。
//! よって HTML の文書の表示の上に Finder からファイルを落とすと、窓がそのファイルへ移る見込み。
//! 判断(事後確認 (26)): アプリの窓に on_navigation の網を張り、アプリ自身の URL のほかへは移らないようにする。
//!
//! ## wry の on_navigation が呼ばれる範囲(~/.cargo/registry の wry-0.54.4 で確かめた)
//! `src/wkwebview/navigation.rs` の `navigation_policy`(WKNavigationDelegate の decidePolicyForNavigationAction)は、
//! `action.targetFrame` を見ずに、どの navigation action でも `navigation_policy_function(url)` を呼ぶ= **main frame だけで
//! なく iframe の移動にも呼ばれる**(HtmlViewer の `about:srcdoc`・PdfViewer の `vellis-asset://local/…`)。tauri-runtime-wry
//! (`src/lib.rs:4706-4712`)は URL を `Url` に読めないとき Allow にする。Tauri は窓ごとの handler の後に plugin の
//! `on_navigation` を呼ぶ(`manager/webview.rs:548-575`= 窓ごとの handler が無い窓=設定の窓にも plugin の網は掛かる)。
//! よって判定の関数は、iframe の中で使う URL も認めなければならない(壊すと HTML と PDF の表示が出なくなる)。
//!
//! ## 確定契約(implementer はこれに従う=test-writer が固定)
//!
//! ```ignore
//! // --- src-tauri/src/window/navigation.rs(新規)— window/mod.rs に `pub mod navigation;`
//! /// アプリ自身の URL か(on_navigation の網の判定。main frame と iframe の移動のどちらにも呼ばれる)。
//! /// `dev_url` は開発のサーバ(tauri.conf.json の build.devUrl)。開発のビルドのときだけ渡すのを推奨(本テストは渡したときと
//! /// 渡さないときの両方を見る)。
//! pub fn is_app_url(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool;
//! ```
//! 網の張り方(plugin か窓ごとか)は `acceptance_req74_navigation.rs` の注記。
//!
//! ## 認める URL の集合(src と src-tauri から拾ったもの)
//! | URL | どこで使うか |
//! | --- | --- |
//! | `tauri://localhost/…` | 本番のアプリのページ(macOS / Linux。`WebviewUrl::default()`・設定の窓) |
//! | `http://tauri.localhost/…`・`https://tauri.localhost/…` | 本番のアプリのページ(Windows / Android の Tauri の既定) |
//! | 開発のサーバの origin(`dev_url`= tauri.conf.json の `build.devUrl`= `http://localhost:1420`)の `…` | `pnpm tauri dev` のアプリのページ(`dev_url` を渡したときだけ) |
//! | `about:srcdoc` | HtmlViewer の `<iframe srcdoc>`(要件#8) |
//! | `about:blank` | iframe と新しい webview の最初の文書 |
//! | `vellis-asset://local/…`・`vellis-asset://ssh/…` | PdfViewer の `<iframe src>`(`src/lib/uri.ts` の toAssetUri)・HTML の `<base>`(lib.rs が登録する独自のプロトコル) |
//! | `vellis-print://document/<id>` | 印刷の窓の文書(`print.rs` の print_document_url。網を印刷の窓に付けても壊れないように認める) |
//!
//! 断る(判定する): `file://` のファイル・http(s) の外のページ(`localhost` の別のポートを含む)・`javascript:`・`mailto:`
//! (外のリンクは plugin-opener の openUrl で OS が開き、navigation を使わない)・`tauri://` の localhost でない host・`dev_url`
//! を渡さないときの開発のサーバ。
//! 判定しない(どちらでもよい): `data:`・`blob:`(アプリは navigation に使っていない)・`vellis-asset://` の local / ssh でない host。
//!
//! ## 赤になる理由(実装前)
//! `vellis_lib::window::navigation` が無いので、このファイルはコンパイルできず全部赤。

use tauri::Url;
use vellis_lib::print::print_document_url;
use vellis_lib::window::navigation::is_app_url;

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

fn assert_allowed(list: &[&str], dev: Option<&Url>) {
    for s in list {
        assert!(is_app_url(&url(s), dev), "{s} is the app's own URL and must be allowed (dev_url: {dev:?})");
    }
}

fn assert_refused(list: &[&str], dev: Option<&Url>) {
    for s in list {
        assert!(!is_app_url(&url(s), dev), "{s} is not the app's own URL and must be refused (dev_url: {dev:?})");
    }
}

/// アプリのページ(本番の origin)はどこの path でも認める。開発のサーバを渡しても渡さなくても同じ。
#[test]
fn the_app_page_is_allowed() {
    let dev = dev_url();
    let pages = [
        "tauri://localhost",
        "tauri://localhost/",
        "tauri://localhost/index.html",
        "tauri://localhost/?root=x#top",
        "http://tauri.localhost/",
        "https://tauri.localhost/index.html",
    ];
    assert_allowed(&pages, None);
    assert_allowed(&pages, Some(&dev));
}

/// 開発のサーバ(devUrl の origin)は、渡したときだけ認める。別のポート・別の host は断る。
#[test]
fn the_dev_server_is_allowed_only_when_given() {
    let dev = dev_url();
    let origin = dev.origin().ascii_serialization();
    let same = [format!("{origin}/"), format!("{origin}/src/routes/+page.svelte?t=1"), dev.to_string()];
    let same: Vec<&str> = same.iter().map(String::as_str).collect();
    assert_allowed(&same, Some(&dev));
    assert_refused(&same, None);
    assert_refused(&["http://localhost:5173/", "https://localhost/", "http://127.0.0.1:1420/"], Some(&dev));
}

/// アプリが iframe に載せるもの(on_navigation は iframe の移動にも呼ばれる): HtmlViewer の srcdoc・最初の about:blank・
/// PdfViewer の vellis-asset(ローカルと ssh)。
#[test]
fn the_frames_the_app_loads_are_allowed() {
    assert_allowed(
        &[
            "about:srcdoc",
            "about:blank",
            "vellis-asset://local/Users/a/Documents/report.pdf",
            "vellis-asset://local/Users/a/My%20Docs/%E8%B3%87%E6%96%99.pdf",
            "vellis-asset://ssh/alice@host.example:22/srv/docs/report.pdf",
            "vellis-asset://ssh/host.example/srv/docs/report.pdf",
        ],
        None,
    );
}

/// 印刷の窓の文書(網を印刷の窓に付けても壊れないように認める)。
#[test]
fn the_print_document_is_allowed() {
    let print = print_document_url("01JD2Q4ZK3T8V7M5N6P0R9S1XA");
    assert_allowed(&[print.as_str()], None);
}

/// 落としたファイル・外のページ・script・メールは断る(主の窓がそこへ移らない)。
#[test]
fn files_outside_pages_and_scripts_are_refused() {
    let dev = dev_url();
    let refused = [
        "file:///Users/a/notes/other.md",
        "file:///Users/a/Desktop/page.html",
        "file:///Users/a/Desktop/My%20File.pdf",
        "file://localhost/etc/hosts",
        "https://example.com/",
        "http://example.com/index.html",
        "https://github.com/login",
        "javascript:alert(1)",
        "mailto:someone@example.com",
        "tauri://example.com/",
    ];
    assert_refused(&refused, None);
    assert_refused(&refused, Some(&dev));
}

/// CSP の frame-src が iframe に許しているもの(`'self'` とスキーム)は、網でも認める(iframe を網で壊さない)。
#[test]
fn every_frame_source_the_csp_permits_is_allowed() {
    let conf: serde_json::Value =
        serde_json::from_str(&read_source("tauri.conf.json")).expect("tauri.conf.json must be valid JSON");
    let csp = conf["app"]["security"]["csp"].as_str().expect("app.security.csp must be a string");
    let frame_src = csp
        .split(';')
        .map(str::trim)
        .find(|d| d.starts_with("frame-src"))
        .expect("the CSP must have a frame-src directive");
    let sources: Vec<&str> = frame_src.split_whitespace().skip(1).collect();
    assert!(!sources.is_empty(), "frame-src must list its sources: {frame_src}");
    for source in sources {
        let sample = match source {
            "'self'" => "tauri://localhost/index.html".to_string(),
            "vellis-asset:" => "vellis-asset://local/Users/a/report.pdf".to_string(),
            other => panic!("frame-src has a source the navigation net has not been checked against: {other} ({frame_src})"),
        };
        assert!(is_app_url(&url(&sample), None), "frame-src {source} lets frames load {sample}; the net must allow it");
    }
}
