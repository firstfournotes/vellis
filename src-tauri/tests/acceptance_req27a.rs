//! 要件#27 追補a の受け入れテスト(docs/requirements/req-27.md「### 追補a」・
//! backlog 331・要件#82 (e) の先行)— Rust 層
//!
//! 「`vellis-asset` のすべての応答に
//!  `Content-Security-Policy: script-src 'none'; object-src 'none'` を付ける」
//!
//! 契約(追補a・2026-10-11):
//! 1. `vellis-asset` の**すべての応答**(200 の全体・206 の部分・416・エラー)に
//!    `Content-Security-Policy: script-src 'none'; object-src 'none'` を付ける。
//!    値は印刷の scheme の `PRINT_CSP`(`src-tauri/src/print.rs`)と同じ文字列
//!    (1つの定数を共有するか、同じ値を持つ)
//! 2. 不変: `Access-Control-Allow-Origin: *`・`Content-Type`(`safe_mime`)・
//!    Range の解釈と応答の作り分け(契約①〜⑤)・本文のバイト
//!
//! 受け入れ基準 AC-27-追a:
//! - (a) 200(Range なし)・206(Range あり)・416(満たせない Range)・エラー
//!   (無いファイル・不正な URI)の応答に、`Content-Security-Policy` が契約1 の値で
//!   **ちょうど1つ**付く。`Access-Control-Allow-Origin: *` も付いたまま
//! - (b) `asset.rs` の CSP の値と `print.rs` の `PRINT_CSP` が同じ文字列
//!
//! 判定の仕方:
//! - (a) は既存 `acceptance_req27.rs` と同じ流儀=一時フォルダに実ファイルを置き、
//!   公開 API `handle_asset` を `vellis-asset://local/<path>` の要求で呼ぶ。
//!   エラー応答のうち 413 / 500 の経路(`read_error_response`)は要求で再現しにくい
//!   ため、公開ビルダー `error_response` を直接呼んで判定する
//! - (b) は2段: ① 実際に配られるヘッダどうしの比較(`handle_asset` の応答 vs
//!   公開 API `handle_print_protocol` の応答)・② `print.rs` の非公開定数 `PRINT_CSP`
//!   の文字列をソース走査(`include_str!`・menu.rs 系の前例と同じ)で取り出して
//!   `handle_asset` の応答の値と比べる。定数の共有・同値の別定義のどちらでも緑に
//!   なり、どちらかが変われば赤になる
//!
//! 契約外(実装裁量): 定数の名前(推奨 `ASSET_DOCUMENT_CSP`)・共有するかどうか。
//! 表示への影響(PDF・画像・動画・HTML プレビュー)は実測済み(req-82.md (e))で、
//! 実装後の E2E は backlog 335 の後(本ファイルの範囲外)。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tempfile::TempDir;

use vellis_lib::commands::asset::{error_response, handle_asset};
use vellis_lib::commands::AppState;
use vellis_lib::fs::registry::FileProviderRegistry;
use vellis_lib::print::{handle_print_protocol, print_document_url, PrintDocumentStore};
use vellis_lib::watch::hub::DocumentCoordinator;
use vellis_lib::window::manager::WindowManager;

// ---------------------------------------------------------------------------
// 契約1 の値
// ---------------------------------------------------------------------------

/// 契約1 の CSP 値(印刷の `PRINT_CSP` と同じ文字列)。
const EXPECTED_CSP: &str = "script-src 'none'; object-src 'none'";

// ---------------------------------------------------------------------------
// Helpers(acceptance_req27.rs と同じ流儀)
// ---------------------------------------------------------------------------

/// handle_asset を通すための最小 AppState(実プロバイダ・実ファイル)。
fn test_state() -> AppState {
    let registry = Arc::new(FileProviderRegistry::new());
    AppState {
        fs_registry: registry.clone(),
        coordinator: Arc::new(DocumentCoordinator::new(registry)),
        window_manager: Arc::new(tokio::sync::Mutex::new(WindowManager::new())),
        annotation_stores: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
    }
}

/// vellis-asset://local/<path> への要求(Range ヘッダは任意)。
fn asset_request(path: &Path, range: Option<&str>) -> http::Request<Vec<u8>> {
    let url = format!(
        "vellis-asset://local{}",
        path.to_str().unwrap() // 絶対パスなので先頭 '/' がそのまま区切りになる
    );
    let mut builder = http::Request::builder().uri(url);
    if let Some(r) = range {
        builder = builder.header("Range", r);
    }
    builder.body(Vec::new()).unwrap()
}

fn header_str<'a>(resp: &'a http::Response<Vec<u8>>, name: &str) -> Option<&'a str> {
    resp.headers().get(name).and_then(|v| v.to_str().ok())
}

/// 応答に付いている `Content-Security-Policy` の値を**全部**集める
/// (「ちょうど1つ」の判定のため `get` ではなく `get_all`)。
fn csp_values(resp: &http::Response<Vec<u8>>) -> Vec<String> {
    resp.headers()
        .get_all(http::header::CONTENT_SECURITY_POLICY)
        .iter()
        .map(|v| {
            v.to_str()
                .expect("Content-Security-Policy は可視 ASCII")
                .to_string()
        })
        .collect()
}

/// AC-27-追a (a) の判定本体: CSP が契約1 の値でちょうど1つ・ACAO `*` も残っている。
fn assert_csp_contract(resp: &http::Response<Vec<u8>>, ctx: &str) {
    let values = csp_values(resp);
    assert_eq!(
        values.len(),
        1,
        "{ctx}: Content-Security-Policy はちょうど1つ付く(契約1)— got {values:?}"
    );
    assert_eq!(
        values[0], EXPECTED_CSP,
        "{ctx}: Content-Security-Policy の値は契約1 の文字列そのもの"
    );
    assert_eq!(
        header_str(resp, "Access-Control-Allow-Origin"),
        Some("*"),
        "{ctx}: Access-Control-Allow-Origin: * は付いたまま(契約2・backlog #55)"
    );
}

/// 位置から中身が一意に決まるパターンバイト列(スライスの取り違えを検出できる)。
fn patterned(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i.wrapping_mul(31) % 251) as u8).collect()
}

/// 一時フォルダに `name` のファイルを置く。
fn write_file(tmp: &TempDir, name: &str, data: &[u8]) -> PathBuf {
    let path = tmp.path().join(name);
    std::fs::write(&path, data).unwrap();
    path
}

// ---------------------------------------------------------------------------
// AC-27-追a (a): 200 / 206 / 416 / エラー のすべてに CSP がちょうど1つ
// ---------------------------------------------------------------------------

/// (a)-1. Range なし → 200 全量の応答に CSP がちょうど1つ付く。
///        Content-Type・本文は従来どおり(契約2)。
#[tokio::test]
async fn whole_file_200_carries_csp_exactly_once() {
    let tmp = TempDir::new().unwrap();
    let data = patterned(1000);
    let path = write_file(&tmp, "photo.png", &data);

    let resp = handle_asset(&test_state(), asset_request(&path, None)).await;

    assert_eq!(resp.status().as_u16(), 200, "Range なしは 200(契約2)");
    assert_csp_contract(&resp, "200(Range なし)");
    assert_eq!(
        header_str(&resp, "Content-Type"),
        Some("image/png"),
        "Content-Type は safe_mime のまま変わらない(契約2)"
    );
    assert_eq!(resp.body(), &data, "本文のバイトは変わらない(契約2)");
}

/// (a)-2. スクリプト入りの SVG(backlog 331 の当の文書)も 200 で配られ、
///        `image/svg+xml` のまま(safe_mime は格下げしない=契約2)で、CSP が付く。
///        ヘッダが文書に効いてスクリプトが動かないのが狙い(見た目は出たまま)。
#[tokio::test]
async fn scripted_svg_200_keeps_svg_mime_and_carries_csp() {
    let tmp = TempDir::new().unwrap();
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="10" height="10"/></svg>"#;
    let path = write_file(&tmp, "evil.svg", svg);

    let resp = handle_asset(&test_state(), asset_request(&path, None)).await;

    assert_eq!(resp.status().as_u16(), 200);
    assert_csp_contract(&resp, "200(スクリプト入り SVG)");
    let content_type = header_str(&resp, "Content-Type").unwrap_or("");
    assert!(
        content_type.starts_with("image/svg+xml"),
        "SVG の Content-Type は格下げしない(契約2・代案1 は不採用)— got {content_type}"
    );
    assert_eq!(resp.body(), svg, "本文のバイトは変わらない(契約2)");
}

/// (a)-3. Range あり(充足可能)→ 206 部分応答に CSP がちょうど1つ付く。
///        Content-Range・本文スライスは従来どおり(契約2)。
#[tokio::test]
async fn partial_206_carries_csp_exactly_once() {
    let tmp = TempDir::new().unwrap();
    let data = patterned(1000);
    let path = write_file(&tmp, "clip.mp4", &data);

    let resp = handle_asset(&test_state(), asset_request(&path, Some("bytes=100-199"))).await;

    assert_eq!(resp.status().as_u16(), 206, "充足可能な Range は 206(契約①)");
    assert_csp_contract(&resp, "206(Range あり)");
    assert_eq!(
        header_str(&resp, "Content-Range"),
        Some("bytes 100-199/1000"),
        "Content-Range は従来どおり(契約2)"
    );
    assert_eq!(resp.body(), &data[100..=199], "本文スライスは従来どおり(契約2)");
}

/// (a)-4. 充足不能な Range → 416 に CSP がちょうど1つ付く(開区間・両端指定の両形式)。
///        `Content-Range: bytes */{total}` は従来どおり(契約2)。
#[tokio::test]
async fn unsatisfiable_416_carries_csp_exactly_once() {
    let tmp = TempDir::new().unwrap();
    let path = write_file(&tmp, "clip.mp4", &patterned(1000));

    for header in ["bytes=1000-", "bytes=2000-3000"] {
        let resp = handle_asset(&test_state(), asset_request(&path, Some(header))).await;

        assert_eq!(
            resp.status().as_u16(),
            416,
            "充足不能な Range {header:?} は 416(契約①)"
        );
        assert_csp_contract(&resp, &format!("416({header})"));
        assert_eq!(
            header_str(&resp, "Content-Range"),
            Some("bytes */1000"),
            "416 の Content-Range は従来どおり(契約2)"
        );
    }
}

/// (a)-5. 無いファイル → 404 に CSP がちょうど1つ付く(Range の有無を問わず)。
#[tokio::test]
async fn missing_file_404_carries_csp_exactly_once() {
    let tmp = TempDir::new().unwrap();
    let missing = tmp.path().join("no-such-file.svg");

    for range in [None, Some("bytes=0-99")] {
        let resp = handle_asset(&test_state(), asset_request(&missing, range)).await;

        assert_eq!(resp.status().as_u16(), 404, "無いファイルは 404(Range={range:?})");
        assert_csp_contract(&resp, &format!("404(Range={range:?})"));
    }
}

/// (a)-6. 不正な URI → 400 に CSP がちょうど1つ付く
///        (`..` の抜け・未知のプロバイダ・空のパス・不正なパーセント符号)。
#[tokio::test]
async fn invalid_uri_400_carries_csp_exactly_once() {
    let bad_uris = [
        "vellis-asset://local/Users/tetsuo/../etc/passwd",
        "vellis-asset://local/Users/tetsuo/%2e%2e/etc/passwd",
        "vellis-asset://ftp/example.com/file.png",
        "vellis-asset://local/",
        "vellis-asset://local/Users/tetsuo/bad%zz.svg",
    ];

    for uri in bad_uris {
        let req = http::Request::builder().uri(uri).body(Vec::new()).unwrap();
        let resp = handle_asset(&test_state(), req).await;

        assert_eq!(resp.status().as_u16(), 400, "不正な URI {uri:?} は 400");
        assert_csp_contract(&resp, &format!("400({uri})"));
    }
}

/// (a)-7. エラー応答のビルダー `error_response`(404 / 413 / 500 の共通経路)が
///        どの status でも CSP をちょうど1つ付ける。要求で再現しにくい 413 / 500 を
///        公開ビルダーで直接押さえる。
#[test]
fn error_response_builder_carries_csp_exactly_once() {
    for (status, msg) in [
        (400u16, "invalid asset uri"),
        (404, "not found"),
        (413, "file too large"),
        (500, "read error"),
    ] {
        let resp = error_response(status, msg);

        assert_eq!(resp.status().as_u16(), status);
        assert_csp_contract(&resp, &format!("error_response({status})"));
        assert_eq!(resp.body(), msg.as_bytes(), "本文は従来どおり(契約2)");
    }
}

// ---------------------------------------------------------------------------
// AC-27-追a (b): asset.rs の CSP の値 == print.rs の PRINT_CSP
// ---------------------------------------------------------------------------

/// 実際に印刷の scheme が配る CSP ヘッダの値(`PRINT_CSP` が付く公開経路)。
fn print_csp_from_response() -> String {
    let store = PrintDocumentStore::new();
    let id = store.register(String::from("<!doctype html><p>csp</p>"));
    let resp = handle_print_protocol(&store, &print_document_url(&id));
    assert_eq!(resp.status(), http::StatusCode::OK, "印刷文書の応答は 200(前提)");
    resp.headers()
        .get(http::header::CONTENT_SECURITY_POLICY)
        .expect("印刷の応答には PRINT_CSP が付く(要件#38 契約②・前提)")
        .to_str()
        .expect("PRINT_CSP は可視 ASCII")
        .to_string()
}

/// `print.rs` のソースから非公開定数 `PRINT_CSP` の文字列リテラルを取り出す
/// (`const PRINT_CSP: &str = "...";` の行。menu.rs 系の include_str! 前例と同じ)。
fn print_csp_from_source() -> String {
    let source = include_str!("../src/print.rs");
    let line = source
        .lines()
        .map(str::trim_start)
        .find(|l| l.starts_with("const PRINT_CSP") || l.starts_with("pub const PRINT_CSP"))
        .expect("print.rs に `const PRINT_CSP: &str = \"...\";` の定義がある(前提)");
    let open = line.find('"').expect("PRINT_CSP は文字列リテラル");
    let close = line[open + 1..]
        .find('"')
        .map(|i| open + 1 + i)
        .expect("PRINT_CSP の文字列リテラルは1行で閉じる");
    line[open + 1..close].to_string()
}

/// `vellis-asset` の 200 応答に実際に付く CSP の値(=asset.rs の CSP の値)。
async fn asset_csp_from_response() -> String {
    let tmp = TempDir::new().unwrap();
    let path = write_file(&tmp, "photo.png", &patterned(16));

    let resp = handle_asset(&test_state(), asset_request(&path, None)).await;
    assert_eq!(resp.status().as_u16(), 200);

    let values = csp_values(&resp);
    assert_eq!(
        values.len(),
        1,
        "asset の 200 応答に Content-Security-Policy がちょうど1つ付く — got {values:?}"
    );
    values.into_iter().next().unwrap()
}

/// (b)-1. 配られるヘッダどうしが同じ文字列: `vellis-asset` の応答の CSP と
///        `vellis-print` の応答の CSP(= `PRINT_CSP`)が一致する。
#[tokio::test]
async fn asset_csp_header_equals_print_csp_header() {
    let asset_csp = asset_csp_from_response().await;
    let print_csp = print_csp_from_response();

    assert_eq!(
        asset_csp, print_csp,
        "asset.rs の CSP の値は print.rs の PRINT_CSP と同じ文字列(契約1)"
    );
    assert_eq!(
        asset_csp, EXPECTED_CSP,
        "その値は契約1 に書かれた文字列そのもの"
    );
}

/// (b)-2. ソース側でも一致: `print.rs` の `PRINT_CSP` 定数の文字列リテラルが
///        `vellis-asset` の応答の CSP と同じ(定数を共有しても別定義でも通る。
///        印刷側の値だけが変わったときも赤になる)。
#[tokio::test]
async fn asset_csp_equals_print_rs_constant_source() {
    let asset_csp = asset_csp_from_response().await;
    let print_csp_literal = print_csp_from_source();

    assert_eq!(
        print_csp_literal, EXPECTED_CSP,
        "print.rs の PRINT_CSP は契約1 の値(前提の固定)"
    );
    assert_eq!(
        asset_csp, print_csp_literal,
        "asset.rs の CSP の値は print.rs の PRINT_CSP のリテラルと同じ文字列(契約1)"
    );
}
