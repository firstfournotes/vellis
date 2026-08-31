//! 要件#38 の受け入れテスト(requirements.md #38)— Rust 層
//!
//! 「HTML ビューア表示中も ⌘P(File > Print…)で表示中のレンダリング結果を
//!  印刷できる(現状は印刷不能= backlog #82 のバグ修正)」
//!
//! 契約(2026-08-30 登録・方式はプローブ実測で確定済み=案a′):
//! - ② 印刷内容=画面の HtmlViewer と同じ前処理済みスナップショット。要件#8 の
//!   安全対策を印刷経路でも全部維持=生 HTML をスクリプト実行可能な文脈へ置かない
//!   (文書側の CSP メタはフロント= print-html.acceptance.test.ts が固定。本層は
//!   protocol 応答の **CSP ヘッダ**で二重化する)
//! - ③ 方式(案a′)=印刷専用の可視 WebviewWindow に印刷文書を**実 URL で正規
//!   ロード**し、on_page_load Finished 待ち+猶予後に Webview::print()。
//!   about:blank + document.write は wry 0.54.4 が panic しアプリごとクラッシュ
//!   するため禁止(実測)。文書の供給=カスタム protocol が one-shot 文書を配信し、
//!   印刷窓にアプリ JS を載せない
//! - ④ markdown/text の印刷経路・print.css の既存設計は変更しない(本ファイルは
//!   Print… メニュー項目の存置をソース走査で固定する)
//! - ⑦ 依存追加なし(store も protocol 応答も既存依存= std + http のみで書ける)
//! - ⑧ 機械判定=印刷文書ストア(one-shot)と protocol 応答生成の純関数
//!
//! 本ファイルの持ち場(Rust 層の機械判定):
//! - menu.rs: MENU_PRINT_EVENT("menu_print")の値固定(フロント
//!   src/lib/print-html.ts の同名定数と同じリテラル=要件#34/#36 の家風)と、
//!   既存 Print… 項目の存置(PRINT_ITEM_ID="print"・ラベル "Print…"・
//!   アクセラレータ "CmdOrCtrl+P" =契約④の防衛線)
//! - print モジュール: 印刷文書ストア(登録→ URL 用 id 発行→取り出しで消える
//!   one-shot)と、カスタム protocol 応答生成(200 + text/html + CSP ヘッダ
//!   `script-src 'none'`・未知 id は 404・不正 URL は 4xx)
//!
//! フロント側(印刷文書の生成純関数・経路選択の出し分け・menu_print 購読の
//! 実行列)は `src/lib/print-html.acceptance.test.ts` が判定する。
//!
//! ## 確定契約(公開 API・implementer はこれに従う)
//!
//! ```ignore
//! // src-tauri/src/menu.rs — 既存のイベント定数と同じ家風で追加
//! /// File > Print… のクリックでフォーカス中ウィンドウへ emit_to するイベント名
//! /// (menu_open_* と同型・ペイロードなし)。従来の「クリックで直接
//! /// Webview::print()」はこの emit に置き換わり、経路判定はフロント
//! /// (src/lib/print-html.ts の printRouteFor)が行う。
//! pub const MENU_PRINT_EVENT: &str = "menu_print";
//!
//! // src-tauri/src/print.rs(新規)・lib.rs に pub mod print;
//!
//! /// 印刷窓が文書をロードするカスタム protocol のスキーム名。
//! /// register_asynchronous_uri_scheme_protocol(PRINT_SCHEME, …) の登録名と
//! /// print_document_url の生成が同じ定数を参照する(vellis-asset と同じ家風)。
//! pub const PRINT_SCHEME: &str = "vellis-print";
//!
//! /// one-shot の印刷文書ストア。register で id を発行し、take は取り出しと
//! /// 同時に消す(同じ id は二度サーブされない)。メソッドは &self(内部可変)—
//! /// protocol handler は共有参照(managed state / static)から呼ぶため。
//! pub struct PrintDocumentStore { … }
//! impl PrintDocumentStore {
//!     pub fn new() -> Self;
//!     pub fn register(&self, document: String) -> String; // URL-safe な一意 id
//!     pub fn take(&self, id: &str) -> Option<String>;     // 取り出しで消える
//! }
//!
//! /// 印刷窓にロードさせる実 URL(契約③=実 URL 正規ロード)。
//! /// PRINT_SCHEME:// で始まり id を含む。macOS(WKWebView)ではカスタム
//! /// スキーム URL がこの形のまま protocol handler に届く(vellis-asset と同じ)。
//! pub fn print_document_url(id: &str) -> String;
//!
//! /// protocol 応答の生成(純関数=テスト可能な形)。登録済み id の URL →
//! /// 200 / Content-Type: text/html / CSP ヘッダに script-src 'none' / body =
//! /// 文書バイト。取り出しは one-shot なので同じ URL の2回目と未知 id は 404、
//! /// スキーム不一致など不正な URL は 4xx。
//! pub fn handle_print_protocol(store: &PrintDocumentStore, url: &str) -> http::Response<Vec<u8>>;
//! ```
//!
//! ## reviewer 照合に委ねる配線(AppHandle / Webview 依存で機械判定不能)
//! - menu.rs: Print… クリックが handle_menu_open_click と同型で MENU_PRINT_EVENT を
//!   フォーカス窓へ emit_to すること(直接 print() の呼び出しは印刷窓経路と
//!   main-frame コマンドに置き換わる=契約④の解釈はフロント側テスト冒頭に記載)
//! - コマンド print_current_window: invoke 元の窓の Webview::print() を呼ぶ
//!   (従来の終端。print.css の適用は従来どおり=契約④)
//! - コマンド print_html: store.register → print_document_url の URL で印刷専用の
//!   可視 WebviewWindow を生成 → on_page_load Finished 待ち+猶予 →
//!   Webview::print() → 窓クローズ。about:blank + document.write は禁止(実測で
//!   wry panic =アプリごとクラッシュ)
//! - lib.rs: register_asynchronous_uri_scheme_protocol(PRINT_SCHEME, …) が
//!   handle_print_protocol へ委譲していること・印刷窓に SvelteKit バンドルを
//!   載せないこと(one-shot 文書のみを配信)
//!
//! ## 人間ゲート(acceptance/acceptance.md)
//! - 実機の印刷出力(白紙でない・複数ページ展開・倍率非依存・見た目)・
//!   印刷シートが印刷窓に付くこと・窓の後始末・markdown/text の印刷が従来どおり

use vellis_lib::menu::{MENU_PRINT_EVENT, PRINT_ITEM_ID};
use vellis_lib::print::{
    handle_print_protocol, print_document_url, PrintDocumentStore, PRINT_SCHEME,
};

// ---------------------------------------------------------------------------
// menu.rs — イベント名の固定と Print… 項目の存置(契約④の防衛線)
// ---------------------------------------------------------------------------

/// 1. Webview への通知イベント名は menu_open_* と同じ snake_case の menu_* 固定。
///    フロント src/lib/print-html.ts 側の同名定数と同じリテラルであることが
///    両側のテストで固定される(要件#34/#36 の家風)。
#[test]
fn menu_print_event_name_is_fixed() {
    assert_eq!(MENU_PRINT_EVENT, "menu_print");
}

/// 2. 既存 Print… 項目の ID は "print" のまま(issue #24 由来の既存定数=
///    契約④: メニュー項目そのものは従来どおり存在する)。
#[test]
fn print_menu_item_id_is_preserved() {
    assert_eq!(PRINT_ITEM_ID, "print");
}

/// 行ごとに最初の `//` 以降(コメント)を落としたコード部分を連結して返す
/// (acceptance_req35/req36 の走査と同じ流儀)。
fn menu_rs_code() -> String {
    include_str!("../src/menu.rs")
        .lines()
        .map(|line| line.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

/// 3. File メニューの Print…(ラベルと CmdOrCtrl+P)が menu.rs のコード行に
///    残っている(契約④=⌘P の入口は従来どおり。クリック後の配線の変更は
///    reviewer 照合)。
#[test]
fn menu_rs_keeps_print_item_label_and_accelerator() {
    let code = menu_rs_code();
    assert!(
        code.contains("\"Print…\""),
        "menu.rs must keep the \"Print…\" File menu item (contract ④)"
    );
    assert!(
        code.contains("CmdOrCtrl+P"),
        "menu.rs must keep the CmdOrCtrl+P accelerator on Print… (contract ④)"
    );
}

// ---------------------------------------------------------------------------
// PRINT_SCHEME / print_document_url — 実 URL 正規ロードの素材(契約③)
// ---------------------------------------------------------------------------

/// 4. スキーム名は vellis-asset と同じ家風の固定リテラル。protocol 登録名と
///    URL 生成が同じ定数を参照するための錨。
#[test]
fn print_scheme_is_fixed() {
    assert_eq!(PRINT_SCHEME, "vellis-print");
}

/// 5. 印刷窓にロードさせる URL はスキームで始まり id を含む(実 URL 正規ロード=
///    契約③。about:blank 供給は禁止)。
#[test]
fn print_document_url_carries_scheme_and_id() {
    let store = PrintDocumentStore::new();
    let id = store.register(String::from("<p>doc</p>"));
    let url = print_document_url(&id);
    assert!(
        url.starts_with(&format!("{PRINT_SCHEME}://")),
        "print URL must start with {PRINT_SCHEME}:// — got {url}"
    );
    assert!(url.contains(&id), "print URL must carry the id — got {url}");
}

// ---------------------------------------------------------------------------
// PrintDocumentStore — one-shot の文書ストア
// ---------------------------------------------------------------------------

/// 6. 登録 → 取り出しの往復で同じ文書が返る。
#[test]
fn store_round_trips_document() {
    let store = PrintDocumentStore::new();
    let id = store.register(String::from("<!doctype html><p>印刷文書</p>"));
    assert_eq!(
        store.take(&id).as_deref(),
        Some("<!doctype html><p>印刷文書</p>")
    );
}

/// 7. 取り出しで消える(one-shot)。同じ id の2回目は None — 印刷後に文書が
///    ストアへ残らない(サーブは一度きり)。
#[test]
fn store_take_is_one_shot() {
    let store = PrintDocumentStore::new();
    let id = store.register(String::from("<p>once</p>"));
    assert!(store.take(&id).is_some());
    assert!(store.take(&id).is_none(), "take must consume the document");
}

/// 8. 未知 id は None(発明しない)。
#[test]
fn store_unknown_id_is_none() {
    let store = PrintDocumentStore::new();
    assert!(store.take("no-such-id").is_none());
}

/// 9. id は一意で、登録間で文書が混線しない(取り出し順にも依らない)。
#[test]
fn store_ids_are_unique_and_documents_do_not_cross() {
    let store = PrintDocumentStore::new();
    let a = store.register(String::from("<p>doc-a</p>"));
    let b = store.register(String::from("<p>doc-b</p>"));
    assert_ne!(a, b, "two registrations must get distinct ids");
    assert_eq!(store.take(&b).as_deref(), Some("<p>doc-b</p>"));
    assert_eq!(store.take(&a).as_deref(), Some("<p>doc-a</p>"));
}

/// 10. id はそのまま URL に載る前提なので percent-encode 不要の URL-safe 文字
///     (unreserved: 英数と `-` `_` `.` `~`)だけで構成される。
#[test]
fn store_ids_are_url_safe() {
    let store = PrintDocumentStore::new();
    for _ in 0..32 {
        let id = store.register(String::from("<p>doc</p>"));
        assert!(!id.is_empty(), "id must not be empty");
        assert!(
            id.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~')),
            "id must be URL-safe without percent-encoding — got {id}"
        );
    }
}

// ---------------------------------------------------------------------------
// handle_print_protocol — protocol 応答の生成(契約②③)
// ---------------------------------------------------------------------------

/// 11. 登録済み id の URL → 200・Content-Type: text/html・CSP ヘッダに
///     script-src 'none'・body =文書バイト(UTF-8 日本語含む)。CSP ヘッダは
///     文書側 meta(フロント固定)との二重化=契約②の「印刷経路でも安全対策を
///     全部維持」の Rust 側の半分。
#[test]
fn protocol_serves_registered_document_with_csp() {
    let store = PrintDocumentStore::new();
    let document = "<!doctype html><html><head><title>印刷</title></head>\
                    <body><p>日本語本文 🖨</p></body></html>";
    let id = store.register(document.to_string());

    let resp = handle_print_protocol(&store, &print_document_url(&id));

    assert_eq!(resp.status(), http::StatusCode::OK);
    let content_type = resp
        .headers()
        .get(http::header::CONTENT_TYPE)
        .expect("Content-Type header must be present")
        .to_str()
        .expect("Content-Type must be visible ASCII");
    assert!(
        content_type.starts_with("text/html"),
        "Content-Type must be text/html — got {content_type}"
    );
    let csp = resp
        .headers()
        .get(http::header::CONTENT_SECURITY_POLICY)
        .expect("Content-Security-Policy header must be present (contract ②)")
        .to_str()
        .expect("CSP header must be visible ASCII");
    assert!(
        csp.contains("script-src 'none'"),
        "CSP header must contain script-src 'none' — got {csp}"
    );
    assert_eq!(resp.body().as_slice(), document.as_bytes());
}

/// 12. one-shot は protocol 面でも実効: 同じ URL の2回目は 404(文書は最初の
///     サーブで消える=印刷後にリロードしても生 HTML は出てこない)。
#[test]
fn protocol_serves_each_document_only_once() {
    let store = PrintDocumentStore::new();
    let id = store.register(String::from("<p>once</p>"));
    let url = print_document_url(&id);

    assert_eq!(handle_print_protocol(&store, &url).status(), http::StatusCode::OK);
    assert_eq!(
        handle_print_protocol(&store, &url).status(),
        http::StatusCode::NOT_FOUND,
        "second request for the same one-shot document must 404"
    );
}

/// 13. 未知 id は 404。
#[test]
fn protocol_unknown_id_is_not_found() {
    let store = PrintDocumentStore::new();
    let resp = handle_print_protocol(&store, &print_document_url("no-such-id"));
    assert_eq!(resp.status(), http::StatusCode::NOT_FOUND);
}

/// 14. 不正な URL(空・スキーム不一致・id 欠落)はクライアントエラー(4xx)で
///     応答し、panic しない(印刷窓以外から protocol を突かれても落ちない)。
#[test]
fn protocol_malformed_urls_are_client_errors() {
    let store = PrintDocumentStore::new();
    for bad in ["", "garbage", "http://example.com/x", "vellis-print://"] {
        let resp = handle_print_protocol(&store, bad);
        assert!(
            resp.status().is_client_error(),
            "malformed url {bad:?} must get a 4xx — got {}",
            resp.status()
        );
    }
}
