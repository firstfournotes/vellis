//! 要件#30 の受け入れテスト(requirements.md #30・backlog #67)— Rust 層
//!
//! 「パーセントエンコード対象文字(日本語等の非 ASCII・スペース等)を含むパスの
//!  ファイルをアプリ内表示できる(vellis-asset 配信のエンコード非対称修正)」
//!
//! 不具合の背景(診断済み): フロント toAssetUri(src/lib/uri.ts)は `URL.pathname`
//! でエンコード済み asset URI を組み立てる(例:
//! `vellis-asset://local/Users/x/2025%E5%B9%B4%E5%BA%A6.pdf`)が、Rust 側
//! parse_asset_uri はデコードせず literal な `%XX` 入り PathBuf で開くため 404 —
//! PDF はプレースホルダ・画像/動画/3D も同罪。
//!
//! 契約(2026-08-27 由谷決定):
//! - ① parse_asset_uri(src-tauri/src/commands/asset.rs)はクエリ/フラグメント
//!   除去**後**にパス部をパーセントデコードしてから Uri を組み立てる(local/ssh
//!   両形式・デコードは1回のみ=二重デコードしない)。ファイル名の literal
//!   `?`/`#` はフロント側で %3F/%23 にエンコードされて届くため、除去→デコードの
//!   順序が正。
//! - ② `..` トラバーサル検査はデコード後の値に対して行う。既存
//!   reject_path_traversal / reject_encoded_path_traversal(asset.rs インライン)
//!   は現行のまま成立=既存テストの書き換えなし。二重エンコード
//!   (%252e%252e)は1回デコードで literal `%2e%2e` という名前=トラバーサル
//!   ではない(実在しなければ 404 のエラー経路)。
//! - ③ 不正なパーセント列(%zz・末尾 % 等)・UTF-8 として不正なデコード結果
//!   (%E5 単独等)は Invalid URI として拒否(黙って素通ししない)。
//! - ④ デコードは percent-encoding クレートを使用(既に依存ツリー内=url/tauri
//!   経由。Cargo.toml への直接依存宣言のみ=由谷承認済み)。
//!   注意: percent-encoding の decode は不正列を素通しする(lenient)ため、
//!   拒否(契約③)には厳格検証の併用が要る。検証をデコード**後**に置くと
//!   `100%25off.pdf` → `100%off.pdf` の正当な literal `%` を誤拒否する
//!   (本ファイルのテストが両側から挟む)。
//! - ⑤ フロント(toAssetUri=URL.pathname のエンコード済み出力)は変更しない。
//! - ⑥ Range/206・ACAO・MIME 降格・版数クエリ・413/416 等の既存挙動は不変。
//!
//! 判定範囲(本ファイル): parse_asset_uri のデコード(①)・除去→デコードの
//! 順序(①)・単回デコード(①/②)・デコード後トラバーサル拒否(②)・不正列の
//! 拒否(③)・エンコード済みパスの実ファイル配信と Range/206 合成(①×⑥)。
//!
//! 契約外(機械判定しない): ④の「percent-encoding クレートを使っている」こと
//! 自体と Cargo.toml 直接宣言・⑤ toAssetUri 無変更 — いずれも reviewer 照合。
//! ⑥の広域(MIME 降格・413/416・ACAO 全種)は既存インライン23件+既存
//! acceptance が回帰防衛線(本ファイルは新経路の 200/206 にのみ共通ヘッダを
//! 確認する)。ssh authority 部(user 名等)にエンコード文字が来た場合の扱い・
//! 16進の大文字小文字混在の細部は実装裁量。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tempfile::TempDir;

use vellis_lib::commands::asset::{handle_asset, parse_asset_uri};
use vellis_lib::commands::AppState;
use vellis_lib::errors::{UriError, VellisError};
use vellis_lib::fs::registry::FileProviderRegistry;
use vellis_lib::watch::hub::DocumentCoordinator;
use vellis_lib::window::manager::WindowManager;

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

fn header_str<'a>(resp: &'a http::Response<Vec<u8>>, name: &str) -> Option<&'a str> {
    resp.headers().get(name).and_then(|v| v.to_str().ok())
}

/// 成功応答(200/206)共通のヘッダ契約: ACAO: * と no-store(契約⑥の維持)。
fn assert_common_headers(resp: &http::Response<Vec<u8>>, ctx: &str) {
    assert_eq!(
        header_str(resp, "Access-Control-Allow-Origin"),
        Some("*"),
        "{ctx}: Access-Control-Allow-Origin: * は不変(契約⑥)"
    );
    assert_eq!(
        header_str(resp, "Cache-Control"),
        Some("no-store"),
        "{ctx}: Cache-Control: no-store は不変(契約⑥)"
    );
}

/// tempdir 直下のエンコード済みファイル名への vellis-asset URL を組み立てる。
///
/// tempdir のディレクトリ部は ASCII・エンコード不要である前提(WebKit も
/// そのまま素通しする部分)。前提が崩れた環境では判定がぼやけるので先に落とす。
fn encoded_local_url(dir: &Path, encoded_name: &str) -> String {
    let dir_str = dir.to_str().unwrap();
    assert!(
        dir_str.is_ascii() && !dir_str.contains(' ') && !dir_str.contains('%'),
        "テスト前提: tempdir パスは ASCII かつスペース/% なし(得たのは {dir_str})"
    );
    format!("vellis-asset://local{}/{}", dir_str, encoded_name)
}

fn get(url: &str) -> http::Request<Vec<u8>> {
    http::Request::builder().uri(url).body(Vec::new()).unwrap()
}

fn get_with_range(url: &str, range: &str) -> http::Request<Vec<u8>> {
    http::Request::builder()
        .uri(url)
        .header("Range", range)
        .body(Vec::new())
        .unwrap()
}

// ---------------------------------------------------------------------------
// 契約①: parse_asset_uri がパス部をパーセントデコードする
// ---------------------------------------------------------------------------

/// 1.(契約①)エンコード済み日本語パス(local 形式)がデコード済みパスの
///    Uri になる。`2025%E5%B9%B4%E5%BA%A6.pdf` = `2025年度.pdf`
///    (年 = E5 B9 B4・度 = E5 BA A6)— 実例の不具合ファイルと同型。
#[test]
fn parse_local_decodes_japanese_path() {
    let uri =
        parse_asset_uri("vellis-asset://local/tmp/vellis-req30/2025%E5%B9%B4%E5%BA%A6.pdf")
            .expect("エンコード済み日本語パスは有効な asset URI");
    assert_eq!(uri.scheme, "file");
    assert!(uri.authority.is_none());
    assert_eq!(
        uri.path,
        PathBuf::from("/tmp/vellis-req30/2025年度.pdf"),
        "パス部はパーセントデコード済みでなければならない(literal %XX のままでは 404 になる)"
    );
}

/// 2.(契約①)スペース(%20)入りパス(local 形式)のデコード。
#[test]
fn parse_local_decodes_space_path() {
    let uri = parse_asset_uri("vellis-asset://local/Users/x/my%20scan%20file.png")
        .expect("%20 入りパスは有効な asset URI");
    assert_eq!(uri.scheme, "file");
    assert_eq!(uri.path, PathBuf::from("/Users/x/my scan file.png"));
}

/// 3.(契約①)ssh 形式でもパス部がデコードされる。authority
///    (user/host/port)は従来どおり保持される。
#[test]
fn parse_ssh_decodes_path() {
    let uri =
        parse_asset_uri("vellis-asset://ssh/alice@host.example.com/data/path%20with%20space.png")
            .expect("ssh 形式のエンコード済みパスは有効な asset URI");
    assert_eq!(uri.scheme, "ssh");
    let auth = uri.authority.as_ref().unwrap();
    assert_eq!(auth.user.as_deref(), Some("alice"));
    assert_eq!(auth.host, "host.example.com");
    assert_eq!(uri.path, PathBuf::from("/data/path with space.png"));

    // 日本語も同様(画 = E7 94 BB・像 = E5 83 8F)
    let uri = parse_asset_uri(
        "vellis-asset://ssh/alice@host.example.com:2222/home/alice/%E7%94%BB%E5%83%8F.png",
    )
    .expect("ssh 形式の日本語パスは有効な asset URI");
    assert_eq!(uri.authority.as_ref().unwrap().port, Some(2222));
    assert_eq!(uri.path, PathBuf::from("/home/alice/画像.png"));
}

/// 4.(契約①)版数クエリ(?v=3・要件#22 のキャッシュバスト)付きでも
///    クエリ除去→デコードの順でパスが正しく決まる。
#[test]
fn parse_strips_version_query_then_decodes() {
    let uri = parse_asset_uri("vellis-asset://local/tmp/img/%E7%94%BB%E5%83%8F.png?v=3")
        .expect("版数クエリ付きエンコード済みパスは有効な asset URI");
    assert_eq!(
        uri.path,
        PathBuf::from("/tmp/img/画像.png"),
        "クエリは除去され、残ったパス部がデコードされる"
    );
}

/// 5.(契約①=順序の要)ファイル名の literal `?`/`#` はフロントで %3F/%23 に
///    エンコードされて届く。除去→デコードの順なら literal 文字としてパスに
///    残る(デコード→除去の誤順だと `file?name.png` が `file` に切り詰められる)。
#[test]
fn parse_keeps_encoded_question_and_hash_as_literals() {
    let uri = parse_asset_uri("vellis-asset://local/tmp/x/file%3Fname.png")
        .expect("%3F 入りファイル名は有効な asset URI");
    assert_eq!(uri.path, PathBuf::from("/tmp/x/file?name.png"));

    // 版数クエリと同居しても、除去は literal `?` でのみ起こる
    let uri = parse_asset_uri("vellis-asset://local/tmp/x/file%3Fname.png?v=3")
        .expect("%3F 入りファイル名+版数クエリは有効な asset URI");
    assert_eq!(
        uri.path,
        PathBuf::from("/tmp/x/file?name.png"),
        "クエリ除去は literal `?` まで・%3F はデコード後の literal `?` として残る"
    );

    let uri = parse_asset_uri("vellis-asset://local/tmp/x/file%23note.md")
        .expect("%23 入りファイル名は有効な asset URI");
    assert_eq!(uri.path, PathBuf::from("/tmp/x/file#note.md"));
}

/// 6.(契約①=単回デコード)literal `%` を含むファイル名はフロントで %25 に
///    エンコードされて届く。1回デコードで literal `%` に戻る(デコード後の
///    `%of` 等を再検証・再デコードして誤拒否/二重デコードしない)。
#[test]
fn parse_decodes_literal_percent_once() {
    let uri = parse_asset_uri("vellis-asset://local/tmp/sale/100%25off.pdf")
        .expect("%25(literal %)入りファイル名は有効な asset URI");
    assert_eq!(
        uri.path,
        PathBuf::from("/tmp/sale/100%off.pdf"),
        "%25 は literal `%` に1回だけデコードされる"
    );
}

/// 7.(契約①/②)二重エンコード(%252e%252e)は二重デコードされない:
///    1回デコードで literal `%2e%2e` という名前のパス segment になり、
///    トラバーサルではない。実在しなければ 404(400 で拒否しない)。
#[tokio::test]
async fn parse_does_not_double_decode_dots() {
    let uri = parse_asset_uri("vellis-asset://local/tmp/%252e%252e/file.png")
        .expect("%252e%252e は literal `%2e%2e` という名前=有効な asset URI");
    assert_eq!(
        uri.path,
        PathBuf::from("/tmp/%2e%2e/file.png"),
        "デコードは1回のみ(%252e → %2e で止まる。.. まで進めば二重デコード)"
    );

    // 配信経路でも: トラバーサル拒否(400)ではなく、実在しないので 404
    let tmp = TempDir::new().unwrap();
    let url = encoded_local_url(tmp.path(), "%252e%252e/nope.png");
    let resp = handle_asset(&test_state(), get(&url)).await;
    assert_eq!(
        resp.status().as_u16(),
        404,
        "literal `%2e%2e` ディレクトリ名はトラバーサル扱いせず、不在なら 404"
    );
}

// ---------------------------------------------------------------------------
// 契約②: トラバーサル検査はデコード後の値に対して行う
// (既存 reject_path_traversal / reject_encoded_path_traversal は書き換えず
//  現行のまま=raw `..`・%2e%2e 拒否の回帰防衛線)
// ---------------------------------------------------------------------------

/// 8.(契約②)デコード後に `..` segment になる形はすべて拒否される。
///    `..%2f`(区切りの `/` 側をエンコード)は raw では `..` segment に
///    見えないため、検査がデコード後の値に対して行われていることの判定点。
#[test]
fn reject_decoded_traversal_variants() {
    for url in [
        "vellis-asset://local/tmp/%2e%2e/etc/passwd",  // %2e%2e/ → ../
        "vellis-asset://local/tmp/%2E%2E/etc/passwd",  // 大文字ヘクス
        "vellis-asset://local/tmp/.%2e/etc/passwd",    // .%2e → ..
        "vellis-asset://local/tmp/%2e./etc/passwd",    // %2e. → ..
        "vellis-asset://local/tmp/..%2fetc/passwd",    // ..%2f → ../(デコード後にのみ現れる)
        "vellis-asset://ssh/alice@host.example.com/home/%2e%2e/etc/passwd", // ssh 形式も同じ検査
    ] {
        let result = parse_asset_uri(url);
        assert!(
            result.is_err(),
            "デコード後に `..` となる {url} はトラバーサルとして拒否されなければならない"
        );
    }
}

// ---------------------------------------------------------------------------
// 契約③: 不正なパーセント列・不正 UTF-8 は Invalid URI として拒否
// ---------------------------------------------------------------------------

/// 9.(契約③)不正なパーセント列(hex でない・桁不足・末尾 %)は
///    Invalid URI として拒否される(lenient に素通しさせない)。
#[test]
fn reject_malformed_percent_sequences() {
    for url in [
        "vellis-asset://local/tmp/file%zzname.png", // hex でない
        "vellis-asset://local/tmp/file%2gname.png", // 2桁目が hex でない
        "vellis-asset://local/tmp/file%2",          // 桁不足
        "vellis-asset://local/tmp/file%",           // 末尾 %
    ] {
        let result = parse_asset_uri(url);
        assert!(
            matches!(result, Err(VellisError::Uri(UriError::Invalid(_)))),
            "不正なパーセント列 {url} は Invalid URI として拒否(得たのは {result:?})"
        );
    }
}

/// 10.(契約③)デコード結果が UTF-8 として不正なもの(%E5 単独=3バイト列の
///     先頭バイトのみ・%FF=UTF-8 に現れないバイト)も Invalid URI として拒否。
#[test]
fn reject_invalid_utf8_decode_result() {
    for url in [
        "vellis-asset://local/tmp/file%E5.png", // 継続バイトのない先頭バイト
        "vellis-asset://local/tmp/file%FF.png", // UTF-8 に現れないバイト
    ] {
        let result = parse_asset_uri(url);
        assert!(
            matches!(result, Err(VellisError::Uri(UriError::Invalid(_)))),
            "UTF-8 として不正なデコード結果 {url} は Invalid URI として拒否(得たのは {result:?})"
        );
    }
}

/// 11.(契約③)配信経路でも不正列は 400(invalid asset uri)であり、
///     素通しして 404(literal パスの不在)へ流れない。
#[tokio::test]
async fn handle_asset_invalid_percent_returns_400() {
    let req = get("vellis-asset://local/tmp/file%E5.png");
    let resp = handle_asset(&test_state(), req).await;
    assert_eq!(
        resp.status().as_u16(),
        400,
        "不正なパーセント列は 400(素通しの 404 は「黙って素通し」= 契約③違反)"
    );
    assert_eq!(header_str(&resp, "Access-Control-Allow-Origin"), Some("*"));
}

// ---------------------------------------------------------------------------
// 契約①×⑥: エンコード済みパスの実ファイル配信(要件の本丸=アプリ内表示)
// ---------------------------------------------------------------------------

/// 12.(契約①×⑥)日本語名の実ファイル(`2025年度.pdf`・%PDF- offset 0)が
///     エンコード済み URL 経由で 200 配信される — 実例の不具合
///     (プレースホルダ表示=404)の直接の再現・修正判定。
#[tokio::test]
async fn serves_japanese_named_pdf() {
    let tmp = TempDir::new().unwrap();
    let content = b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n";
    std::fs::write(tmp.path().join("2025年度.pdf"), content).unwrap();

    let url = encoded_local_url(tmp.path(), "2025%E5%B9%B4%E5%BA%A6.pdf");
    let resp = handle_asset(&test_state(), get(&url)).await;

    assert_eq!(
        resp.status().as_u16(),
        200,
        "日本語名ファイルはエンコード済み URL で 200 配信される(404=プレースホルダが不具合)"
    );
    assert_eq!(resp.body().as_slice(), content, "ボディは実ファイルの中身そのまま");
    assert_eq!(
        header_str(&resp, "Content-Type"),
        Some("application/pdf"),
        "MIME はデコード済みパスの拡張子から決まる"
    );
    assert_eq!(header_str(&resp, "Accept-Ranges"), Some("bytes"));
    assert_common_headers(&resp, "200(日本語名)");
}

/// 13.(契約①×⑥)スペース入り名の実ファイル+版数クエリ(?v=3)の合成でも
///     200 配信される(要件#22 のキャッシュバスト経路がデコードと両立)。
#[tokio::test]
async fn serves_space_named_file_with_version_query() {
    let tmp = TempDir::new().unwrap();
    let content: Vec<u8> = (0..256u16).map(|i| (i % 251) as u8).collect();
    std::fs::write(tmp.path().join("my scan file.png"), &content).unwrap();

    let url = encoded_local_url(tmp.path(), "my%20scan%20file.png?v=3");
    let resp = handle_asset(&test_state(), get(&url)).await;

    assert_eq!(resp.status().as_u16(), 200, "スペース入り名+版数クエリでも 200 配信");
    assert_eq!(resp.body().as_slice(), content.as_slice());
    assert_eq!(header_str(&resp, "Content-Type"), Some("image/png"));
    assert_common_headers(&resp, "200(スペース名+?v=3)");
}

/// 14.(契約⑥=要件#27 との合成)エンコード済み日本語パスへの Range 要求
///     (bytes=0-4)が 206 で部分応答する(Content-Range・部分ボディ)。
#[tokio::test]
async fn range_request_on_encoded_japanese_path_returns_206() {
    let tmp = TempDir::new().unwrap();
    let content = b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n";
    std::fs::write(tmp.path().join("2025年度.pdf"), content).unwrap();

    let url = encoded_local_url(tmp.path(), "2025%E5%B9%B4%E5%BA%A6.pdf");
    let resp = handle_asset(&test_state(), get_with_range(&url, "bytes=0-4")).await;

    assert_eq!(resp.status().as_u16(), 206, "エンコード済みパスでも Range は 206 部分応答");
    assert_eq!(
        header_str(&resp, "Content-Range"),
        Some(format!("bytes 0-4/{}", content.len()).as_str())
    );
    assert_eq!(resp.body().as_slice(), b"%PDF-", "ボディは先頭5バイト(%PDF- マジック)");
    assert_eq!(header_str(&resp, "Accept-Ranges"), Some("bytes"));
    assert_common_headers(&resp, "206(日本語名)");
}
