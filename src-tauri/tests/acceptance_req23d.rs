//! 要件#23 追補d の受け入れテスト(docs/requirements/req-23.md「## 追補d」
//! 契約6・AC-23-追d (f)・Issue #708)— Rust 層
//!
//! 「`vellis-asset` の応答で `Content-Range` を読めるようにする」
//!
//! 契約6(追補d・2026-10-20):
//! - ページ(`tauri://localhost`)から `vellis-asset:` への fetch は別オリジンの
//!   扱いで、`Content-Range` は CORS で既定に読める応答ヘッダに入っていない
//!   (`commands/asset.rs` は `Access-Control-Allow-Origin: *` だけを返す)。
//!   このままでは契約1 の問い合わせ(`Range: bytes=0-0`)は毎回「総量が読めない」
//!   になり、効かない
//! - そこで `asset.rs` の**すべての応答**(200・206・416・エラー)に
//!   `Access-Control-Expose-Headers: Content-Range` を足す
//! - あわせて、Range を付けた要求の前に WebKit が事前の確かめ(OPTIONS)を送る
//!   場合に備え、OPTIONS には**ファイルを読まずに** 204 で答える
//!   (`Access-Control-Allow-Origin: *`・`Access-Control-Allow-Methods: GET`・
//!   `Access-Control-Allow-Headers: Range`)
//! - ほかの応答の作り(CSP・Range の扱い・本文)は変えない
//!
//! 受け入れ基準 AC-23-追d (f):
//! - (f-1) 200・206・416・エラー(404 など)の応答すべてに
//!   `Access-Control-Expose-Headers` があり、値に `Content-Range` を含む
//! - (f-2) メソッドが OPTIONS の要求には、provider の読み出し(`stat`・
//!   `read_range`・`read_bytes` など)を一度も呼ばずに 204 を返し、
//!   `Access-Control-Allow-Origin: *`・`Access-Control-Allow-Methods` に GET・
//!   `Access-Control-Allow-Headers` に Range を含む
//! - (f-3) GET の応答の CSP・Range の扱い・本文は今のまま(Expose を足しても
//!   既存の CSP のヘッダが残る)。既存の asset のテスト(`acceptance_req27.rs`・
//!   `acceptance_req27a.rs`・`asset.rs` インライン)は無改変で緑=test-runner の
//!   フルスイートで判定
//!
//! 判定の仕方:
//! - 公開 API は既存の `handle_asset(&AppState, http::Request<Vec<u8>>)
//!   -> http::Response<Vec<u8>>` のまま(新しい入口は要らない)。メソッドは
//!   `http::Request::builder().method(...)` で与える
//! - (f-1)(f-3) は `acceptance_req27a.rs` と同じ流儀=一時フォルダに実ファイルを
//!   置き、`vellis-asset://local/<path>` の要求で呼ぶ。413 / 500 の経路
//!   (`read_error_response`)は要求で再現しにくいため、公開ビルダー
//!   `error_response` を直接呼んで判定する(req27a と同じ)
//! - (f-2) の「provider を呼ばない」は、呼び出し回数を数える偽 provider を
//!   `FileProviderRegistry::register` で `file` スキームに差し替えて判定する。
//!   偽 provider は `stat` / `read_*` に**成功を返す**ので、「先に読んでから
//!   204 を返す」実装は状態コードでは見分けられず、回数だけで赤になる
//! - ヘッダの値は「カンマ区切りのトークンに含まれる」で見る(ヘッダ名は大小を
//!   区別しない=`Content-Range` / `Range` は ASCII 大小無視で比較。メソッド
//!   `GET` はそのまま)。同名ヘッダが複数行でも全部を集める
//!
//! 契約外(実装裁量): OPTIONS の応答に CSP / Expose を付けるかどうか・
//! Allow-Methods に GET 以外(HEAD・OPTIONS)を並べるかどうか・
//! 不正な URI(`..` など)への OPTIONS を 204 にするか 400 にするか(どちらも
//! provider を読まない)・`Access-Control-Max-Age` の有無。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use tempfile::TempDir;
use tokio::sync::mpsc;

use vellis_lib::commands::asset::{error_response, handle_asset};
use vellis_lib::commands::AppState;
use vellis_lib::errors::FsError;
use vellis_lib::fs::entry::{Entry, FileKind};
use vellis_lib::fs::provider::{FileProvider, WatchEvent, WatchHandle};
use vellis_lib::fs::registry::FileProviderRegistry;
use vellis_lib::fs::uri::Uri;
use vellis_lib::watch::hub::DocumentCoordinator;
use vellis_lib::window::manager::WindowManager;

// ---------------------------------------------------------------------------
// 契約の値
// ---------------------------------------------------------------------------

/// 既存契約(要件#27 追補a)の CSP 値。(f-3) で「残っている」ことを見る。
const EXPECTED_CSP: &str = "script-src 'none'; object-src 'none'";

// ---------------------------------------------------------------------------
// Helpers(acceptance_req27a.rs と同じ流儀)
// ---------------------------------------------------------------------------

fn state_with_registry(registry: FileProviderRegistry) -> AppState {
    let registry = Arc::new(registry);
    AppState {
        fs_registry: registry.clone(),
        coordinator: Arc::new(DocumentCoordinator::new(registry)),
        window_manager: Arc::new(tokio::sync::Mutex::new(WindowManager::new())),
        annotation_stores: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
    }
}

/// handle_asset を通すための最小 AppState(実プロバイダ・実ファイル)。
fn test_state() -> AppState {
    state_with_registry(FileProviderRegistry::new())
}

fn asset_url(path: &Path) -> String {
    format!(
        "vellis-asset://local{}",
        path.to_str().unwrap() // 絶対パスなので先頭 '/' がそのまま区切りになる
    )
}

/// vellis-asset://local/<path> への GET 要求(Range ヘッダは任意)。
fn get_request(path: &Path, range: Option<&str>) -> http::Request<Vec<u8>> {
    let mut builder = http::Request::builder()
        .method(http::Method::GET)
        .uri(asset_url(path));
    if let Some(r) = range {
        builder = builder.header("Range", r);
    }
    builder.body(Vec::new()).unwrap()
}

/// vellis-asset://local/<path> への OPTIONS 要求。WebKit の事前の確かめが付ける
/// `Access-Control-Request-*` も載せる(無くても判定は変わらない)。
fn options_request(path: &Path) -> http::Request<Vec<u8>> {
    http::Request::builder()
        .method(http::Method::OPTIONS)
        .uri(asset_url(path))
        .header("Origin", "tauri://localhost")
        .header("Access-Control-Request-Method", "GET")
        .header("Access-Control-Request-Headers", "range")
        .body(Vec::new())
        .unwrap()
}

fn header_str<'a>(resp: &'a http::Response<Vec<u8>>, name: &str) -> Option<&'a str> {
    resp.headers().get(name).and_then(|v| v.to_str().ok())
}

/// 同名ヘッダの全行をカンマで割ってトークン列にする(空要素は捨てる)。
fn header_tokens(resp: &http::Response<Vec<u8>>, name: &str) -> Vec<String> {
    resp.headers()
        .get_all(name)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|line| line.split(',').map(|t| t.trim().to_string()))
        .filter(|t| !t.is_empty())
        .collect()
}

/// トークン列に `wanted` が(ASCII 大小無視で)含まれるか。
fn has_token_ci(tokens: &[String], wanted: &str) -> bool {
    tokens.iter().any(|t| t.eq_ignore_ascii_case(wanted))
}

/// (f-1) の判定本体: `Access-Control-Expose-Headers` があり `Content-Range` を含む。
fn assert_exposes_content_range(resp: &http::Response<Vec<u8>>, ctx: &str) {
    assert!(
        resp.headers().contains_key("Access-Control-Expose-Headers"),
        "{ctx}: Access-Control-Expose-Headers が要る(無いと fetch から Content-Range が読めない)— headers {:?}",
        resp.headers()
    );
    let tokens = header_tokens(resp, "Access-Control-Expose-Headers");
    assert!(
        has_token_ci(&tokens, "Content-Range"),
        "{ctx}: Access-Control-Expose-Headers の値に Content-Range が要る — got {tokens:?}"
    );
}

/// 応答に付いている `Content-Security-Policy` の値を全部集める。
fn csp_values(resp: &http::Response<Vec<u8>>) -> Vec<String> {
    resp.headers()
        .get_all(http::header::CONTENT_SECURITY_POLICY)
        .iter()
        .map(|v| v.to_str().expect("CSP は可視 ASCII").to_string())
        .collect()
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
// 呼び出し回数を数える偽 provider((f-2) 用)
//
// `file` スキームに登録して LocalProvider を差し替える。stat / read_* は
// すべて成功を返す=「読んでから 204」の実装でも状態コードは 204 になるので、
// provider に触らなかったことは回数でしか判定できない。
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Calls {
    stat: AtomicUsize,
    read_bytes: AtomicUsize,
    read_range: AtomicUsize,
    read_text: AtomicUsize,
    list: AtomicUsize,
    watch: AtomicUsize,
}

impl Calls {
    fn snapshot(&self) -> Vec<(&'static str, usize)> {
        vec![
            ("stat", self.stat.load(Ordering::SeqCst)),
            ("read_bytes", self.read_bytes.load(Ordering::SeqCst)),
            ("read_range", self.read_range.load(Ordering::SeqCst)),
            ("read_text", self.read_text.load(Ordering::SeqCst)),
            ("list", self.list.load(Ordering::SeqCst)),
            ("watch", self.watch.load(Ordering::SeqCst)),
        ]
    }

    fn total(&self) -> usize {
        self.snapshot().iter().map(|(_, n)| n).sum()
    }
}

struct CountingProvider {
    calls: Arc<Calls>,
    body: Vec<u8>,
}

#[async_trait]
impl FileProvider for CountingProvider {
    fn scheme(&self) -> &'static str {
        "file"
    }

    async fn list(&self, _uri: &Uri) -> Result<Vec<Entry>, FsError> {
        self.calls.list.fetch_add(1, Ordering::SeqCst);
        Ok(Vec::new())
    }

    async fn stat(&self, uri: &Uri) -> Result<Entry, FsError> {
        self.calls.stat.fetch_add(1, Ordering::SeqCst);
        Ok(Entry {
            uri: uri.raw.clone(),
            name: "probe.stl".into(),
            kind: FileKind::File,
            size: Some(self.body.len() as u64),
            modified: None,
            link: None,
        })
    }

    async fn read_bytes(&self, _uri: &Uri) -> Result<Vec<u8>, FsError> {
        self.calls.read_bytes.fetch_add(1, Ordering::SeqCst);
        Ok(self.body.clone())
    }

    async fn read_range(&self, _uri: &Uri, start: u64, max_len: u64) -> Result<Vec<u8>, FsError> {
        self.calls.read_range.fetch_add(1, Ordering::SeqCst);
        let len = self.body.len() as u64;
        let start = start.min(len);
        let end = start.saturating_add(max_len).min(len);
        Ok(self.body[start as usize..end as usize].to_vec())
    }

    async fn read_text(&self, _uri: &Uri) -> Result<String, FsError> {
        self.calls.read_text.fetch_add(1, Ordering::SeqCst);
        Ok(String::from_utf8_lossy(&self.body).into_owned())
    }

    async fn watch(
        &self,
        _uri: &Uri,
        _tx: mpsc::Sender<WatchEvent>,
    ) -> Result<WatchHandle, FsError> {
        self.calls.watch.fetch_add(1, Ordering::SeqCst);
        Err(FsError::NotFound("watch unsupported".into()))
    }
}

/// 偽 provider を `file` に登録した AppState と、その呼び出し回数の覗き窓。
fn counting_state(body: Vec<u8>) -> (AppState, Arc<Calls>) {
    let calls = Arc::new(Calls::default());
    let mut registry = FileProviderRegistry::new();
    registry.register(Arc::new(CountingProvider {
        calls: calls.clone(),
        body,
    }));
    (state_with_registry(registry), calls)
}

// ---------------------------------------------------------------------------
// (f-1) すべての応答に Access-Control-Expose-Headers: Content-Range
// ---------------------------------------------------------------------------

/// 1. 200(Range なし・全体)に Expose-Headers があり Content-Range を含む。
#[tokio::test]
async fn full_200_response_exposes_content_range() {
    let tmp = TempDir::new().unwrap();
    let path = write_file(&tmp, "whole.stl", &patterned(1000));

    let resp = handle_asset(&test_state(), get_request(&path, None)).await;

    assert_eq!(resp.status().as_u16(), 200);
    assert_exposes_content_range(&resp, "200 全体");
}

/// 2. 206(契約1 の問い合わせ `Range: bytes=0-0`)に Expose-Headers があり
///    Content-Range を含む。これが無いとページは総量を読めない(Issue #708 の核)。
#[tokio::test]
async fn probe_206_response_exposes_content_range() {
    let tmp = TempDir::new().unwrap();
    let data = patterned(4096);
    let path = write_file(&tmp, "probe.stl", &data);

    let resp = handle_asset(&test_state(), get_request(&path, Some("bytes=0-0"))).await;

    assert_eq!(resp.status().as_u16(), 206);
    assert_eq!(
        header_str(&resp, "Content-Range"),
        Some("bytes 0-0/4096"),
        "問い合わせの応答は総量を Content-Range で返す(要件#27=不変)"
    );
    assert_exposes_content_range(&resp, "206 問い合わせ");
}

/// 3. 206(一般の両端指定)にも Expose-Headers があり Content-Range を含む。
#[tokio::test]
async fn bounded_206_response_exposes_content_range() {
    let tmp = TempDir::new().unwrap();
    let path = write_file(&tmp, "part.bin", &patterned(1000));

    let resp = handle_asset(&test_state(), get_request(&path, Some("bytes=100-199"))).await;

    assert_eq!(resp.status().as_u16(), 206);
    assert_exposes_content_range(&resp, "206 部分");
}

/// 4. 416(満たせない Range)に Expose-Headers があり Content-Range を含む
///    (416 の `Content-Range: bytes */<total>` も総量の手掛かりになる)。
#[tokio::test]
async fn unsatisfiable_416_response_exposes_content_range() {
    let tmp = TempDir::new().unwrap();
    let path = write_file(&tmp, "small.bin", &patterned(10));

    let resp = handle_asset(&test_state(), get_request(&path, Some("bytes=10-"))).await;

    assert_eq!(resp.status().as_u16(), 416);
    assert_eq!(header_str(&resp, "Content-Range"), Some("bytes */10"));
    assert_exposes_content_range(&resp, "416");
}

/// 5. エラー 404(無いファイル)にも Expose-Headers があり Content-Range を含む。
#[tokio::test]
async fn missing_file_404_response_exposes_content_range() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("missing.stl");

    let resp = handle_asset(&test_state(), get_request(&path, Some("bytes=0-0"))).await;

    assert_eq!(resp.status().as_u16(), 404);
    assert_exposes_content_range(&resp, "404");
}

/// 6. エラー 400(不正な URI)にも Expose-Headers があり Content-Range を含む。
#[tokio::test]
async fn invalid_uri_400_response_exposes_content_range() {
    let req = http::Request::builder()
        .method(http::Method::GET)
        .uri("vellis-asset://local/Users/tetsuo/../etc/passwd")
        .body(Vec::new())
        .unwrap();

    let resp = handle_asset(&test_state(), req).await;

    assert_eq!(resp.status().as_u16(), 400);
    assert_exposes_content_range(&resp, "400");
}

/// 7. 公開ビルダー `error_response`(413 / 500 の経路)にも Expose-Headers が
///    あり Content-Range を含む。
#[test]
fn error_response_builder_exposes_content_range() {
    for (status, msg) in [
        (413u16, "file too large"),
        (500, "read error"),
        (404, "not found"),
    ] {
        let resp = error_response(status, msg);
        assert_eq!(resp.status().as_u16(), status);
        assert_exposes_content_range(&resp, &format!("error_response({status})"));
    }
}

// ---------------------------------------------------------------------------
// (f-2) OPTIONS は provider を読まずに 204 + CORS ヘッダ
// ---------------------------------------------------------------------------

/// 8. OPTIONS は provider の読み出し(stat・read_range・read_bytes・…)を一度も
///    呼ばずに 204 を返す。偽 provider は成功を返すので、回数が 0 でなければ赤。
#[tokio::test]
async fn options_returns_204_without_touching_provider() {
    let (state, calls) = counting_state(patterned(4096));
    let path = Path::new("/fake/dir/probe.stl");

    let resp = handle_asset(&state, options_request(path)).await;

    assert_eq!(
        resp.status(),
        http::StatusCode::NO_CONTENT,
        "OPTIONS は 204 で答える — got {}",
        resp.status()
    );
    assert!(
        resp.body().is_empty(),
        "204 に本文は無い — got {} bytes",
        resp.body().len()
    );
    assert_eq!(
        calls.total(),
        0,
        "OPTIONS で provider を読んではいけない — calls {:?}",
        calls.snapshot()
    );
}

/// 9. OPTIONS の 204 に CORS の事前確かめ用ヘッダが揃う:
///    `Access-Control-Allow-Origin: *`・`Allow-Methods` に GET・`Allow-Headers` に Range。
#[tokio::test]
async fn options_response_carries_preflight_headers() {
    let tmp = TempDir::new().unwrap();
    let path = write_file(&tmp, "cube.stl", b"solid cube\nendsolid cube\n");

    let resp = handle_asset(&test_state(), options_request(&path)).await;

    assert_eq!(resp.status(), http::StatusCode::NO_CONTENT);
    assert_eq!(
        header_str(&resp, "Access-Control-Allow-Origin"),
        Some("*"),
        "OPTIONS の応答にも Access-Control-Allow-Origin: * が要る"
    );
    let methods = header_tokens(&resp, "Access-Control-Allow-Methods");
    assert!(
        methods.iter().any(|m| m == "GET"),
        "Access-Control-Allow-Methods に GET が要る — got {methods:?}"
    );
    let headers = header_tokens(&resp, "Access-Control-Allow-Headers");
    assert!(
        has_token_ci(&headers, "Range"),
        "Access-Control-Allow-Headers に Range が要る — got {headers:?}"
    );
}

/// 10. OPTIONS はファイルを読まないので、無いファイルへの OPTIONS も 204
///     (実 provider・実フォルダ。stat していれば 404 になってしまう)。
#[tokio::test]
async fn options_on_missing_file_is_still_204() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("not-here.stl");

    let resp = handle_asset(&test_state(), options_request(&path)).await;

    assert_eq!(
        resp.status(),
        http::StatusCode::NO_CONTENT,
        "ファイルの有無に関わらず OPTIONS は 204(読まないので知りようがない)— got {}",
        resp.status()
    );
    assert_eq!(header_str(&resp, "Access-Control-Allow-Origin"), Some("*"));
}

/// 11. 対照: GET は今までどおり provider を読む(偽 provider の差し替えが
///     効いていること=8. の 0 回が「差し替え漏れ」で緑になっていないことの確かめ)。
#[tokio::test]
async fn get_still_reads_through_provider() {
    let (state, calls) = counting_state(patterned(4096));
    let path = Path::new("/fake/dir/probe.stl");

    let resp = handle_asset(&state, get_request(path, Some("bytes=0-0"))).await;

    assert_eq!(resp.status().as_u16(), 206);
    assert_eq!(header_str(&resp, "Content-Range"), Some("bytes 0-0/4096"));
    assert_eq!(resp.body(), &patterned(4096)[0..1]);
    assert!(
        calls.stat.load(Ordering::SeqCst) >= 1 && calls.read_range.load(Ordering::SeqCst) >= 1,
        "GET は stat と read_range を通る — calls {:?}",
        calls.snapshot()
    );
}

// ---------------------------------------------------------------------------
// (f-3) GET の応答の CSP・Range の扱い・本文は今のまま
// ---------------------------------------------------------------------------

/// 12. Expose を足しても、200 / 206 / 416 の CSP(ちょうど1つ・既存の値)・
///     ACAO `*`・Content-Range・本文のバイトは今のまま。
#[tokio::test]
async fn get_responses_keep_csp_range_and_body() {
    let tmp = TempDir::new().unwrap();
    let data = patterned(1000);
    let path = write_file(&tmp, "keep.stl", &data);

    // 200 全体
    let full = handle_asset(&test_state(), get_request(&path, None)).await;
    assert_eq!(full.status().as_u16(), 200);
    assert_eq!(
        csp_values(&full),
        vec![EXPECTED_CSP.to_string()],
        "200: CSP は既存の値でちょうど1つ"
    );
    assert_eq!(header_str(&full, "Access-Control-Allow-Origin"), Some("*"));
    assert_eq!(header_str(&full, "Accept-Ranges"), Some("bytes"));
    assert_eq!(full.body(), &data, "200: 本文は全体のまま");
    assert_exposes_content_range(&full, "200");

    // 206 部分
    let part = handle_asset(&test_state(), get_request(&path, Some("bytes=100-199"))).await;
    assert_eq!(part.status().as_u16(), 206);
    assert_eq!(
        csp_values(&part),
        vec![EXPECTED_CSP.to_string()],
        "206: CSP は既存の値でちょうど1つ"
    );
    assert_eq!(header_str(&part, "Access-Control-Allow-Origin"), Some("*"));
    assert_eq!(
        header_str(&part, "Content-Range"),
        Some("bytes 100-199/1000")
    );
    assert_eq!(
        part.body(),
        &data[100..200],
        "206: 本文は該当スライスのまま"
    );
    assert_exposes_content_range(&part, "206");

    // 416 充足不能
    let bad = handle_asset(&test_state(), get_request(&path, Some("bytes=1000-"))).await;
    assert_eq!(bad.status().as_u16(), 416);
    assert_eq!(
        csp_values(&bad),
        vec![EXPECTED_CSP.to_string()],
        "416: CSP は既存の値でちょうど1つ"
    );
    assert_eq!(header_str(&bad, "Content-Range"), Some("bytes */1000"));
    assert_exposes_content_range(&bad, "416");
}
