//! 要件#27 の受け入れテスト(requirements.md #27)— Rust 層
//!
//! 「vellis-asset プロトコルを Range/206 対応のストリーミング配信へ作り直す
//!  (大容量ファイルの部分応答。ローカル全量読み 10MB キャップの見直しを含む)」
//!
//! 契約(2026-08-22 由谷決定・docs/video-viewing.md §3.3〜§4 案A・§7):
//! - ① handle_asset を Range ヘッダ解釈+部分応答(206+Content-Range+Accept-Ranges・
//!   seek+チャンク読み)へ作り直す(手本=tauri 公式 examples/streaming・最大1MB チャンク)
//! - ② Range なし要求への応答は互換維持(asset.rs 内の既存インラインテスト23件が
//!   回帰の主防衛線=不変・緑のまま)
//! - ③ ストリーミング経路には上限を置かない・全量読み経路(read_bytes)の上限は
//!   10MB → 50MB へ引き上げ
//! - ⑤ backlog #59 同時解消=10MB 超のローカルファイルが asset 経由で配信できる
//! - ⑥ 全応答に `Access-Control-Allow-Origin: *`(backlog #55)を維持・依存追加なし
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```ignore
//! // 実装先: src-tauri/src/commands/asset.rs
//!
//! /// 開区間 Range(`bytes=a-`)1回の応答で返す最大バイト数(1 MiB)。
//! /// クライアントは Content-Range を見て続きを再要求する。
//! pub const STREAM_CHUNK_SIZE: u64 = 1024 * 1024;
//!
//! /// Range ヘッダ値の解釈結果。
//! #[derive(Debug, PartialEq)]
//! pub enum RangeResolution {
//!     /// 解釈できない値(bytes= 以外・パース不能・a>b 等)→ 200 全量へ
//!     /// フォールバック(HTTP 仕様どおり ignore)
//!     Ignore,
//!     /// 充足可能: バイト位置 start..=end(end は inclusive)の 206 部分応答
//!     Partial { start: u64, end: u64 },
//!     /// 充足不能(start >= total)→ 416
//!     Unsatisfiable,
//! }
//!
//! /// Range ヘッダ値 × ファイル総量 → 応答範囲(純関数)。
//! /// - `bytes=a-b`: 両端指定(end は total-1 へクランプ)
//! /// - `bytes=a-`:  開区間=残り全部だが min(remaining, STREAM_CHUNK_SIZE) に制限
//! /// - `bytes=-n`:  末尾 n バイト(n は total へクランプ)
//! /// - 複数レンジ(`bytes=0-1,5-6`)は最初のレンジのみ扱う
//! pub fn resolve_range(header: &str, total: u64) -> RangeResolution;
//!
//! // 実装先: src-tauri/src/fs/provider.rs(trait FileProvider に追加)
//! //
//! // デフォルト実装=read_bytes+スライス(ssh.rs は無変更のまま部分読みが成立)。
//! // EOF 超過はエラーにせず空 Vec(充足可否はハンドラが stat で先に判定する)。
//! async fn read_range(&self, uri: &Uri, start: u64, max_len: u64) -> Result<Vec<u8>, FsError>;
//!
//! // 実装先: src-tauri/src/fs/local.rs
//! // - LocalProvider が read_range を seek+チャンク読みで上書き
//! //   (MAX_FILE_SIZE キャップの対象外=どんなサイズでも部分読み可)
//! // - MAX_FILE_SIZE(read_bytes=全量読み経路のみ): 10MB → 50MB
//! ```
//!
//! handle_asset の応答契約:
//! - Range なし → 200・全量ボディ(read_range 経由=キャップ非適用→10MB 超も配信)・
//!   `Accept-Ranges: bytes` を付与・Content-Type / Cache-Control: no-store / ACAO は従来どおり
//! - Range あり(充足可能)→ 206・`Content-Range: bytes {start}-{end}/{total}`・
//!   `Accept-Ranges: bytes`・ボディ=該当スライス・no-store・ACAO
//! - 充足不能 → 416・`Content-Range: bytes */{total}`・no-store・ACAO
//! - 既存の 400/404/500 は不変
//!
//! 判定範囲(本ファイル): Range 解釈純関数・read_range(デフォルト実装/Local 上書き)・
//! read_bytes キャップ・handle_asset の 200/206/416。Range なし互換(②)は既存
//! インライン23件+既存 acceptance が回帰防衛線。
//!
//! 契約外(実装裁量): `bytes=-0`・total=0 の縮退・ヘッダ内空白の扱い。
//! ssh.rs 無変更の確認は reviewer 照合・大容量実ファイルでの体感は人間ゲート。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use tempfile::TempDir;
use tokio::sync::mpsc;

use vellis_lib::commands::asset::{handle_asset, resolve_range, RangeResolution, STREAM_CHUNK_SIZE};
use vellis_lib::commands::AppState;
use vellis_lib::errors::FsError;
use vellis_lib::fs::entry::Entry;
use vellis_lib::fs::local::LocalProvider;
use vellis_lib::fs::provider::{FileProvider, WatchEvent, WatchHandle};
use vellis_lib::fs::registry::FileProviderRegistry;
use vellis_lib::fs::uri::Uri;
use vellis_lib::watch::hub::DocumentCoordinator;
use vellis_lib::window::manager::WindowManager;

use RangeResolution::{Ignore, Partial, Unsatisfiable};

// ---------------------------------------------------------------------------
// Helpers(asset.rs インラインテスト・local.rs テストと同じ流儀)
// ---------------------------------------------------------------------------

const MB: u64 = 1024 * 1024;

fn make_uri(path: &Path) -> Uri {
    Uri {
        scheme: "file".into(),
        authority: None,
        path: path.to_path_buf(),
        raw: format!("file://{}", path.display()),
    }
}

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

/// 全応答種(200/206/416)共通のヘッダ契約: ACAO: * と no-store。
fn assert_common_headers(resp: &http::Response<Vec<u8>>, ctx: &str) {
    assert_eq!(
        header_str(resp, "Access-Control-Allow-Origin"),
        Some("*"),
        "{ctx}: すべての応答に Access-Control-Allow-Origin: * が要る(backlog #55 の維持)"
    );
    assert_eq!(
        header_str(resp, "Cache-Control"),
        Some("no-store"),
        "{ctx}: すべての応答に Cache-Control: no-store が要る(従来どおり)"
    );
}

/// 位置から中身が一意に決まるパターンバイト列(スライスの取り違えを検出できる)。
fn patterned(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i.wrapping_mul(31) % 251) as u8).collect()
}

/// スパースファイル(ゼロ埋め)を set_len で高速に作る。大容量テスト用。
fn sparse_file(dir: &Path, name: &str, len: u64) -> PathBuf {
    let path = dir.join(name);
    let file = std::fs::File::create(&path).unwrap();
    file.set_len(len).unwrap();
    path
}

// ---------------------------------------------------------------------------
// resolve_range: Range ヘッダ解釈の純関数
// ---------------------------------------------------------------------------

/// 1. `bytes=a-b`(両端指定)は end inclusive でそのまま採用される。
#[test]
fn resolve_bounded_range() {
    assert_eq!(resolve_range("bytes=0-499", 10_000), Partial { start: 0, end: 499 });
    assert_eq!(resolve_range("bytes=500-999", 10_000), Partial { start: 500, end: 999 });
    // 1バイトだけの要求(a == b)も充足可能
    assert_eq!(resolve_range("bytes=0-0", 10_000), Partial { start: 0, end: 0 });
}

/// 2. `bytes=a-b` の end はファイル末尾(total-1)へクランプされる。
#[test]
fn resolve_bounded_range_clamps_end_to_total() {
    assert_eq!(
        resolve_range("bytes=9500-19999", 10_000),
        Partial { start: 9500, end: 9999 }
    );
    assert_eq!(resolve_range("bytes=0-10000", 10_000), Partial { start: 0, end: 9999 });
}

/// 3. STREAM_CHUNK_SIZE は Tauri 標準 asset を手本にした 1 MiB(要件#27 契約①)。
#[test]
fn stream_chunk_size_is_one_mebibyte() {
    assert_eq!(STREAM_CHUNK_SIZE, 1024 * 1024);
}

/// 4. `bytes=a-`(開区間)は「残り全部」ではなく 1MB チャンクに制限される
///    (巨大ファイルを一撃で読まない。クライアントが続きを再要求する方式)。
#[test]
fn resolve_open_range_is_limited_to_one_chunk() {
    let total = 5 * MB;
    assert_eq!(
        resolve_range("bytes=0-", total),
        Partial { start: 0, end: STREAM_CHUNK_SIZE - 1 },
        "開区間は min(remaining, 1MB) — 5MB 中の先頭要求は 1MB チャンクで切る"
    );
    assert_eq!(
        resolve_range("bytes=3000000-", total),
        Partial { start: 3_000_000, end: 3_000_000 + STREAM_CHUNK_SIZE - 1 }
    );
}

/// 5. `bytes=a-` で残りが 1MB 未満なら残り全部(末尾まで)。
#[test]
fn resolve_open_range_short_remainder_takes_rest() {
    assert_eq!(resolve_range("bytes=0-", 1000), Partial { start: 0, end: 999 });
    let total = 5 * MB;
    assert_eq!(
        resolve_range("bytes=5242000-", total),
        Partial { start: 5_242_000, end: total - 1 }
    );
}

/// 6. `bytes=-n` は末尾 n バイト。
#[test]
fn resolve_suffix_range_takes_tail() {
    assert_eq!(resolve_range("bytes=-500", 10_000), Partial { start: 9500, end: 9999 });
    assert_eq!(resolve_range("bytes=-1", 10_000), Partial { start: 9999, end: 9999 });
}

/// 7. `bytes=-n` の n が総量を超えたら全量(total へクランプ)。
#[test]
fn resolve_suffix_range_clamps_to_total() {
    assert_eq!(resolve_range("bytes=-20000", 10_000), Partial { start: 0, end: 9999 });
}

/// 8. 不正形式は Ignore(=Range なし扱いで 200 全量へフォールバック。
///    HTTP 仕様どおり、解釈できない Range はエラーにせず無視する)。
#[test]
fn resolve_invalid_header_falls_back_to_ignore() {
    for header in [
        "items=0-10",  // bytes= 以外の単位
        "0-499",       // 単位なし
        "bytes=abc-def", // パース不能
        "bytes=5-2",   // a > b
        "bytes=",      // 空
        "bytes=--5",   // 形式崩れ
    ] {
        assert_eq!(
            resolve_range(header, 10_000),
            Ignore,
            "解釈できない Range 値 {header:?} は Ignore(200 全量へフォールバック)"
        );
    }
}

/// 9. 充足不能(start >= total)は Unsatisfiable(=416)。
#[test]
fn resolve_unsatisfiable_start_past_eof() {
    assert_eq!(resolve_range("bytes=10000-", 10_000), Unsatisfiable);
    assert_eq!(resolve_range("bytes=10000-10500", 10_000), Unsatisfiable);
    assert_eq!(resolve_range("bytes=99999-", 10), Unsatisfiable);
}

/// 10. 複数レンジは最初のレンジのみ扱う(multipart/byteranges はやらない)。
#[test]
fn resolve_multi_range_takes_first() {
    assert_eq!(resolve_range("bytes=0-1,5-6", 10_000), Partial { start: 0, end: 1 });
    assert_eq!(
        resolve_range("bytes=200-299,0-99", 10_000),
        Partial { start: 200, end: 299 }
    );
}

// ---------------------------------------------------------------------------
// FileProvider::read_range のデフォルト実装(read_bytes+スライス)
//
// ssh.rs を無変更のまま部分読みに参加させるための契約。read_bytes だけを
// 実装した素のプロバイダでも read_range が正しくスライスを返すことを、
// モックプロバイダで判定する。
// ---------------------------------------------------------------------------

/// read_bytes が固定バイト列を返すだけの最小プロバイダ(trait デフォルト実装の検証用)。
struct FixedBytesProvider(Vec<u8>);

#[async_trait]
impl FileProvider for FixedBytesProvider {
    fn scheme(&self) -> &'static str {
        "mock"
    }

    async fn list(&self, _uri: &Uri) -> Result<Vec<Entry>, FsError> {
        Err(FsError::NotFound("list unsupported".into()))
    }

    async fn stat(&self, _uri: &Uri) -> Result<Entry, FsError> {
        Err(FsError::NotFound("stat unsupported".into()))
    }

    async fn read_bytes(&self, _uri: &Uri) -> Result<Vec<u8>, FsError> {
        Ok(self.0.clone())
    }

    async fn watch(
        &self,
        _uri: &Uri,
        _tx: mpsc::Sender<WatchEvent>,
    ) -> Result<WatchHandle, FsError> {
        Err(FsError::NotFound("watch unsupported".into()))
    }
}

/// 11. デフォルト実装は read_bytes の結果を [start, start+max_len) にスライスする。
#[tokio::test]
async fn default_read_range_slices_read_bytes() {
    let provider = FixedBytesProvider(b"0123456789".to_vec());
    let uri = make_uri(Path::new("/mock/data.bin"));

    assert_eq!(provider.read_range(&uri, 2, 3).await.unwrap(), b"234");
    assert_eq!(provider.read_range(&uri, 0, 10).await.unwrap(), b"0123456789");
}

/// 12. デフォルト実装の EOF 超過: 途中まで届く要求は届く分だけ、
///     start が EOF 以降なら空 Vec(エラーにしない=充足可否はハンドラが先に判定)。
#[tokio::test]
async fn default_read_range_clamps_at_eof() {
    let provider = FixedBytesProvider(b"0123456789".to_vec());
    let uri = make_uri(Path::new("/mock/data.bin"));

    assert_eq!(provider.read_range(&uri, 8, 100).await.unwrap(), b"89");
    assert_eq!(
        provider.read_range(&uri, 10, 5).await.unwrap(),
        b"",
        "start == EOF は空 Vec(エラーにしない)"
    );
    assert_eq!(provider.read_range(&uri, 100, 5).await.unwrap(), b"");
}

// ---------------------------------------------------------------------------
// LocalProvider: read_range(seek+チャンク読み・キャップ対象外)と
// read_bytes キャップ(10MB → 50MB)
// ---------------------------------------------------------------------------

/// 13. LocalProvider::read_range は実ファイルの部分バイト列を返す。
#[tokio::test]
async fn local_read_range_reads_partial_bytes() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("data.bin");
    std::fs::write(&path, b"hello, range world").unwrap();

    let provider = LocalProvider::new();
    let uri = make_uri(&path);

    assert_eq!(provider.read_range(&uri, 7, 5).await.unwrap(), b"range");
    assert_eq!(provider.read_range(&uri, 0, 5).await.unwrap(), b"hello");
}

/// 14. LocalProvider::read_range の EOF 超過は届く分だけ/空 Vec(デフォルト実装と同じ契約)。
#[tokio::test]
async fn local_read_range_clamps_at_eof() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("data.bin");
    std::fs::write(&path, b"hello, range world").unwrap(); // 18 bytes

    let provider = LocalProvider::new();
    let uri = make_uri(&path);

    assert_eq!(provider.read_range(&uri, 13, 100).await.unwrap(), b"world");
    assert_eq!(provider.read_range(&uri, 18, 5).await.unwrap(), b"");
    assert_eq!(provider.read_range(&uri, 1000, 5).await.unwrap(), b"");
}

/// 15. read_range は MAX_FILE_SIZE キャップの対象外(契約③=ストリーミング経路は
///     上限なし)。read_bytes なら 50MB キャップで即死するサイズ(51MB)でも
///     部分読みは成功する — read_bytes 経由のデフォルト実装ではなく
///     seek+チャンク読みで上書きされていることの機械判定点。
#[tokio::test]
async fn local_read_range_is_exempt_from_full_read_cap() {
    let tmp = TempDir::new().unwrap();
    let len = 51 * MB;
    let path = sparse_file(tmp.path(), "huge.bin", len);

    let provider = LocalProvider::new();
    let uri = make_uri(&path);

    let tail = provider
        .read_range(&uri, len - 1024, 1024)
        .await
        .expect("51MB ファイルの部分読みは成功しなければならない(キャップ対象外)");
    assert_eq!(tail.len(), 1024);
    assert!(tail.iter().all(|&b| b == 0), "スパースファイルの中身はゼロ埋め");

    let middle = provider
        .read_range(&uri, 10 * MB, 4096)
        .await
        .expect("10MB 超のオフセットからの部分読みも成功する");
    assert_eq!(middle.len(), 4096);
}

/// 16. read_bytes(全量読み経路)のキャップは 50MB へ引き上げ:
///     旧キャップ 10MB を超える 11MB は成功・境界の 50MB ちょうども成功。
#[tokio::test]
async fn local_read_bytes_cap_raised_to_50mb() {
    let tmp = TempDir::new().unwrap();
    let provider = LocalProvider::new();

    let path_11mb = sparse_file(tmp.path(), "over-old-cap.bin", 11 * MB);
    let bytes = provider
        .read_bytes(&make_uri(&path_11mb))
        .await
        .expect("11MB は新キャップ(50MB)以下なので全量読みできる(旧 10MB キャップの撤廃)");
    assert_eq!(bytes.len() as u64, 11 * MB);

    let path_50mb = sparse_file(tmp.path(), "at-cap.bin", 50 * MB);
    let bytes = provider
        .read_bytes(&make_uri(&path_50mb))
        .await
        .expect("50MB ちょうどはキャップ以下(境界は inclusive)");
    assert_eq!(bytes.len() as u64, 50 * MB);
}

/// 17. read_bytes の 50MB 超は従来どおり FsError::FileTooLarge(上限は残す=契約③)。
#[tokio::test]
async fn local_read_bytes_over_50mb_still_too_large() {
    let tmp = TempDir::new().unwrap();
    let path = sparse_file(tmp.path(), "too-large.bin", 50 * MB + 1);

    let provider = LocalProvider::new();
    let result = provider.read_bytes(&make_uri(&path)).await;
    assert!(
        matches!(result, Err(FsError::FileTooLarge(_))),
        "50MB 超の全量読みは FileTooLarge のまま(得たのは: {result:?})"
    );
}

// ---------------------------------------------------------------------------
// handle_asset: Range なし → 200 全量(互換+Accept-Ranges 付与)
// ---------------------------------------------------------------------------

/// 18. Range なしは従来どおり 200・全量ボディ・Content-Type、加えて
///     `Accept-Ranges: bytes` を付与する(クライアントに Range 対応を広告)。
#[tokio::test]
async fn no_range_returns_200_full_body_with_accept_ranges() {
    let tmp = TempDir::new().unwrap();
    let data = patterned(4096);
    let path = tmp.path().join("photo.png");
    std::fs::write(&path, &data).unwrap();

    let resp = handle_asset(&test_state(), asset_request(&path, None)).await;

    assert_eq!(resp.status().as_u16(), 200);
    assert!(
        resp.body().as_slice() == data.as_slice(),
        "Range なしは全量ボディ(互換維持)"
    );
    assert_eq!(
        header_str(&resp, "Accept-Ranges"),
        Some("bytes"),
        "200 応答に Accept-Ranges: bytes を付与する(Range 対応の広告)"
    );
    assert_eq!(header_str(&resp, "Content-Type"), Some("image/png"));
    assert_common_headers(&resp, "200(Range なし)");
}

// ---------------------------------------------------------------------------
// handle_asset: Range あり → 206 部分応答
// ---------------------------------------------------------------------------

/// 19. `bytes=a-b` は 206・Content-Range・該当スライスのボディ。
#[tokio::test]
async fn bounded_range_returns_206_with_content_range() {
    let tmp = TempDir::new().unwrap();
    let data = patterned(1000);
    let path = tmp.path().join("clip.mp4");
    std::fs::write(&path, &data).unwrap();

    let resp = handle_asset(&test_state(), asset_request(&path, Some("bytes=100-199"))).await;

    assert_eq!(resp.status().as_u16(), 206, "充足可能な Range は 206 Partial Content");
    assert_eq!(
        header_str(&resp, "Content-Range"),
        Some("bytes 100-199/1000"),
        "Content-Range は bytes {{start}}-{{end}}/{{total}} 形式"
    );
    assert_eq!(header_str(&resp, "Accept-Ranges"), Some("bytes"));
    assert!(
        resp.body().as_slice() == &data[100..200],
        "ボディは要求どおりのスライス(end は inclusive)"
    );
    assert_common_headers(&resp, "206");
}

/// 20. `bytes=a-b` の end がファイルサイズを超えたら末尾へクランプして 206。
#[tokio::test]
async fn bounded_range_end_clamps_to_file_size() {
    let tmp = TempDir::new().unwrap();
    let data = patterned(1000);
    let path = tmp.path().join("clip.mp4");
    std::fs::write(&path, &data).unwrap();

    let resp = handle_asset(&test_state(), asset_request(&path, Some("bytes=900-5000"))).await;

    assert_eq!(resp.status().as_u16(), 206);
    assert_eq!(header_str(&resp, "Content-Range"), Some("bytes 900-999/1000"));
    assert!(resp.body().as_slice() == &data[900..]);
}

/// 21. `bytes=a-`(開区間)は 1MB チャンクに制限した 206(1MB 超ファイルで検証)。
///     動画シークで WebKit が投げる形=これが巨大ファイルを一撃で読まない要。
#[tokio::test]
async fn open_ended_range_returns_at_most_one_chunk() {
    let tmp = TempDir::new().unwrap();
    let total: usize = 3 * MB as usize; // 3145728
    let data = patterned(total);
    let path = tmp.path().join("big.bin");
    std::fs::write(&path, &data).unwrap();

    let resp = handle_asset(&test_state(), asset_request(&path, Some("bytes=1000-"))).await;

    assert_eq!(resp.status().as_u16(), 206);
    assert_eq!(
        resp.body().len() as u64,
        STREAM_CHUNK_SIZE,
        "開区間 Range のボディは 1MB チャンクに制限される"
    );
    assert_eq!(
        header_str(&resp, "Content-Range"),
        Some(format!("bytes 1000-{}/{}", 1000 + STREAM_CHUNK_SIZE - 1, total).as_str())
    );
    assert!(
        resp.body().as_slice() == &data[1000..1000 + STREAM_CHUNK_SIZE as usize],
        "チャンクは要求オフセットから始まる正しいバイト列"
    );
    assert_common_headers(&resp, "206(開区間)");
}

/// 22. `bytes=a-` で残りが 1MB 未満なら末尾までの 206。
#[tokio::test]
async fn open_ended_range_near_eof_returns_remainder() {
    let tmp = TempDir::new().unwrap();
    let total: usize = 3 * MB as usize;
    let data = patterned(total);
    let path = tmp.path().join("big.bin");
    std::fs::write(&path, &data).unwrap();

    let resp = handle_asset(&test_state(), asset_request(&path, Some("bytes=3145000-"))).await;

    assert_eq!(resp.status().as_u16(), 206);
    assert_eq!(
        header_str(&resp, "Content-Range"),
        Some(format!("bytes 3145000-{}/{}", total - 1, total).as_str())
    );
    assert!(resp.body().as_slice() == &data[3_145_000..]);
}

/// 23. `bytes=-n` は末尾 n バイトの 206。
#[tokio::test]
async fn suffix_range_returns_206_tail() {
    let tmp = TempDir::new().unwrap();
    let data = patterned(1000);
    let path = tmp.path().join("clip.mp4");
    std::fs::write(&path, &data).unwrap();

    let resp = handle_asset(&test_state(), asset_request(&path, Some("bytes=-100"))).await;

    assert_eq!(resp.status().as_u16(), 206);
    assert_eq!(header_str(&resp, "Content-Range"), Some("bytes 900-999/1000"));
    assert!(resp.body().as_slice() == &data[900..]);
}

/// 24. 複数レンジは最初のレンジだけの 206(multipart/byteranges にしない)。
#[tokio::test]
async fn multi_range_serves_first_range_only() {
    let tmp = TempDir::new().unwrap();
    let data = patterned(1000);
    let path = tmp.path().join("clip.mp4");
    std::fs::write(&path, &data).unwrap();

    let resp = handle_asset(&test_state(), asset_request(&path, Some("bytes=0-1,5-6"))).await;

    assert_eq!(resp.status().as_u16(), 206);
    assert_eq!(header_str(&resp, "Content-Range"), Some("bytes 0-1/1000"));
    assert!(resp.body().as_slice() == &data[0..2]);
}

// ---------------------------------------------------------------------------
// handle_asset: 不正 Range → 200 フォールバック・充足不能 → 416
// ---------------------------------------------------------------------------

/// 25. 解釈できない Range 値は無視して 200 全量(HTTP 仕様どおり ignore)。
#[tokio::test]
async fn invalid_range_header_falls_back_to_200_full() {
    let tmp = TempDir::new().unwrap();
    let data = patterned(1000);
    let path = tmp.path().join("clip.mp4");
    std::fs::write(&path, &data).unwrap();

    for header in ["bytes=5-2", "items=0-10"] {
        let resp = handle_asset(&test_state(), asset_request(&path, Some(header))).await;
        assert_eq!(
            resp.status().as_u16(),
            200,
            "不正な Range 値 {header:?} は Range なし扱い(200 全量)"
        );
        assert!(resp.body().as_slice() == data.as_slice());
        assert_eq!(header_str(&resp, "Accept-Ranges"), Some("bytes"));
        assert_common_headers(&resp, "200(不正 Range フォールバック)");
    }
}

/// 26. 充足不能(start >= total)は 416+`Content-Range: bytes */{total}`。
#[tokio::test]
async fn unsatisfiable_range_returns_416() {
    let tmp = TempDir::new().unwrap();
    let data = patterned(1000);
    let path = tmp.path().join("clip.mp4");
    std::fs::write(&path, &data).unwrap();

    for header in ["bytes=1000-", "bytes=2000-3000"] {
        let resp = handle_asset(&test_state(), asset_request(&path, Some(header))).await;
        assert_eq!(
            resp.status().as_u16(),
            416,
            "充足不能な Range {header:?} は 416 Range Not Satisfiable"
        );
        assert_eq!(
            header_str(&resp, "Content-Range"),
            Some("bytes */1000"),
            "416 の Content-Range は bytes */{{total}} 形式"
        );
        assert_common_headers(&resp, "416");
    }
}

/// 27. 存在しないファイルへの Range 要求は従来どおり 404(既存エラー応答は不変)。
#[tokio::test]
async fn missing_file_with_range_still_returns_404() {
    let req = http::Request::builder()
        .uri("vellis-asset://local/no/such/dir/missing.mp4")
        .header("Range", "bytes=0-99")
        .body(Vec::new())
        .unwrap();

    let resp = handle_asset(&test_state(), req).await;

    assert_eq!(resp.status().as_u16(), 404);
    assert_common_headers(&resp, "404(Range あり)");
}

// ---------------------------------------------------------------------------
// backlog #59: 10MB 超のローカルファイルが asset 経由で配信できる
// (旧実装は read_bytes の 10MB キャップで 413 になっていた)
// ---------------------------------------------------------------------------

/// 28. 10MB 超(11MB)のローカルファイルは Range なしでも 200 で全長配信される。
///     3D の 256MB 契約(要件#23)が実際に意味を持つための要(backlog #59)。
#[tokio::test]
async fn backlog59_over_10mb_file_served_in_full_without_range() {
    let tmp = TempDir::new().unwrap();
    let len = 11 * MB;
    let path = sparse_file(tmp.path(), "huge.stl", len);

    let resp = handle_asset(&test_state(), asset_request(&path, None)).await;

    assert_eq!(
        resp.status().as_u16(),
        200,
        "10MB 超のローカルファイルは 413 ではなく 200 で配信される(backlog #59)"
    );
    assert_eq!(
        resp.body().len() as u64,
        len,
        "ボディは全長(11MB)そのまま"
    );
    assert_eq!(header_str(&resp, "Accept-Ranges"), Some("bytes"));
    assert_common_headers(&resp, "200(10MB 超)");
}

/// 29. 10MB 超ファイルへの Range 要求も 206 で部分応答できる。
#[tokio::test]
async fn backlog59_over_10mb_file_serves_partial_content() {
    let tmp = TempDir::new().unwrap();
    let len = 11 * MB;
    let path = sparse_file(tmp.path(), "huge.stl", len);

    let start = 10 * MB;
    let end = start + 1023;
    let resp = handle_asset(
        &test_state(),
        asset_request(&path, Some(&format!("bytes={start}-{end}"))),
    )
    .await;

    assert_eq!(resp.status().as_u16(), 206);
    assert_eq!(
        header_str(&resp, "Content-Range"),
        Some(format!("bytes {start}-{end}/{len}").as_str())
    );
    assert_eq!(resp.body().len(), 1024);
    assert!(resp.body().iter().all(|&b| b == 0), "スパースファイルの中身はゼロ埋め");
    assert_common_headers(&resp, "206(10MB 超)");
}
