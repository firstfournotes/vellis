//! 要件#38 追補g の受け入れテスト(docs/requirements/req-38.md 追補g・backlog 307)— Rust 層
//!
//! 「PDF を表示している窓で Command + P(File > Print…)を押すと、PDF ファイルそのものの
//!  全ページが macOS の印刷ダイアログ(その窓のシート)に載る」
//! (2026-10-06 由谷の決定=PDF そのものを印刷する。従来は 'main-frame' 経路=
//!  `Webview::print()` で、iframe の画面に見えている範囲=先頭の約 1/5 だけが紙に出ていた)
//!
//! 契約(追補g)のうち Rust の持ち場:
//! 1. 中身は macOS の PDFKit(`PDFDocument` の印刷操作)で作る=プレビュー.app と同じ紙面
//! 3. `print_pdf`(`#[tauri::command]`・呼び出し元の窓): URI のプロバイダ(local / ssh)で
//!    ファイルの全バイトを読み、PDFKit の `PDFDocument` にして、その窓のシートとして
//!    印刷操作を走らせる(メインスレッドで)。読めない・PDF として開けない(ページ 0)
//!    ときは印刷ダイアログを出さず `Err`(文言)を返す
//! 4. PDFKit は crate を足さずに使う(`objc2` で `PDFDocument` を引き、フレームワークを
//!    リンクする)。既存の crate の feature を足すのは可。依存(crate)の追加なし
//!
//! 本ファイルの持ち場= AC-38-追g の (b)(macOS のみ)。フロント (a)(c) は
//! `src/lib/print-pdf.acceptance.test.ts`。Tauri command 一覧の固定(AC-60-20)は
//! `src/lib/go-to-path.acceptance.test.ts` に `print_pdf` を1行足した(要件側の更新・
//! 2026-10-06 由谷の決定)。
//!
//! ## 確定契約(公開 API・implementer はこれに従う)
//!
//! ```ignore
//! // src-tauri/src/print.rs(既存モジュールに追加・macOS のみ)
//!
//! /// PDF のバイト列から PDFKit の `PDFDocument` を作り、そのページ数を返す。
//! /// - `print_pdf` が印刷の前に文書を作るのと同じ道筋(PDFKit の `PDFDocument`
//! ///   `initWithData:`)で作ること — 自前の PDF パーサで数えない
//! /// - PDF として開けない(PDFKit が nil を返す)・ページが 0 → `Err(文言)`
//! ///   (空のバイト列・PDF でないバイト列はここで Err になる=契約 3)
//! /// - メインスレッドを要求しない(テストのワーカースレッドから呼べる)
//! #[cfg(target_os = "macos")]
//! pub fn pdf_page_count(bytes: &[u8]) -> Result<usize, String>;
//!
//! // src-tauri/src/commands/print.rs(print_current_window / print_html /
//! // set_print_available の隣)
//! /// 表示中の PDF そのものを、呼び出し元の窓のシートとして印刷する。
//! /// フロントは invoke('print_pdf', { uri }) で呼ぶ(uri = 表示中の文書の URI。
//! /// file:// も ssh:// もそのまま)。プロバイダでファイルの全バイトを読み →
//! /// PDFDocument → 印刷操作を `runOperationModalForWindow…` で窓のシートとして
//! /// メインスレッドで走らせる(`AppHandle::run_on_main_thread` 等)。
//! /// 読めない・開けない・ページ 0 → 印刷ダイアログを出さず Err(文言)。
//! #[tauri::command]
//! pub async fn print_pdf(uri: String, window: tauri::Window, …managed state…) -> Result<(), String>;
//!
//! // src-tauri/src/lib.rs
//! // - 両方の generate_handler! に print_pdf を登録(set_print_available の直後)
//! ```
//!
//! ## reviewer 照合に委ねる配線(実機の AppKit / プロバイダ依存で機械判定不能)
//! - `print_pdf` が URI のプロバイダ(local / ssh)で全バイトを読むこと(ssh の PDF も同じ経路)
//! - 拡大縮小=「用紙より大きいページだけ縮める」・自動回転あり・ズーム(要件63)を紙に
//!   持ち込まないこと(契約 1)
//! - PDFKit のリンク方法(`#[link(name = "PDFKit", kind = "framework")]` 等)と、依存
//!   (crate)の追加が無いこと(契約 4)
//! - 不変: markdown / text / 画像などの印刷・HTML の印刷窓・`print.css`・Print… の有効/無効
//!   (追補f)・項目の ID・ラベル・アクセラレータ(契約 5=既存の受け入れテストが固定)
//!
//! ## 人間ゲート
//! - (e) 実機(/verify・webdriver ビルド): 複数ページの PDF を開いて Command + P で印刷の
//!   シートが出て、ページ数が PDF と同じ

#![cfg(target_os = "macos")]

use vellis_lib::print::pdf_page_count;

// ---------------------------------------------------------------------------
// フィクスチャ — N ページの最小 PDF を手で組む(依存を足さない・xref は実測で正しく)
// ---------------------------------------------------------------------------

/// オブジェクト `id` を書き、その先頭のバイト位置を `offsets` に記録する。
fn push_obj(out: &mut Vec<u8>, offsets: &mut Vec<usize>, id: usize, body: &str) {
    assert_eq!(offsets.len() + 1, id, "objects are written in order");
    offsets.push(out.len());
    out.extend_from_slice(format!("{id} 0 obj\n{body}\nendobj\n").as_bytes());
}

/// `pages` ページの最小 PDF(1.4)を返す。各ページは US Letter の空白ページで、
/// 1ページ目に区別用の短い内容ストリームを持つ。
///
/// オブジェクト: 1=Catalog・2=Pages・3..=各 Page(+ 内容ストリーム1つ)。
/// xref の各行は規格どおり 20 バイト(`nnnnnnnnnn ggggg n \n`)で、オフセットは
/// 実際に書いたバイト位置から計算する。`pages == 0` なら Kids が空・Count 0 の文書。
fn make_pdf(pages: usize) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut offsets: Vec<usize> = Vec::new(); // index = object number - 1

    out.extend_from_slice(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

    let page_ids: Vec<usize> = (0..pages).map(|i| 3 + i).collect();
    let content_id = 3 + pages; // 1ページ目の内容ストリーム(pages > 0 のときだけ書く)

    push_obj(
        &mut out,
        &mut offsets,
        1,
        "<< /Type /Catalog /Pages 2 0 R >>",
    );

    let kids = page_ids
        .iter()
        .map(|id| format!("{id} 0 R"))
        .collect::<Vec<_>>()
        .join(" ");
    push_obj(
        &mut out,
        &mut offsets,
        2,
        &format!("<< /Type /Pages /Kids [{kids}] /Count {pages} >>"),
    );

    for (i, id) in page_ids.iter().enumerate() {
        let contents = if i == 0 {
            format!(" /Contents {content_id} 0 R")
        } else {
            String::new()
        };
        push_obj(
            &mut out,
            &mut offsets,
            *id,
            &format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]{contents} >>"),
        );
    }

    if pages > 0 {
        let stream = "0 0 0 RG 72 720 m 540 720 l S";
        push_obj(
            &mut out,
            &mut offsets,
            content_id,
            &format!(
                "<< /Length {} >>\nstream\n{stream}\nendstream",
                stream.len()
            ),
        );
    }

    let size = offsets.len() + 1;
    let xref_at = out.len();
    out.extend_from_slice(format!("xref\n0 {size}\n").as_bytes());
    out.extend_from_slice(b"0000000000 65535 f \n");
    for off in &offsets {
        let line = format!("{off:010} 00000 n \n");
        assert_eq!(line.len(), 20, "an xref entry is exactly 20 bytes");
        out.extend_from_slice(line.as_bytes());
    }
    out.extend_from_slice(
        format!("trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n")
            .as_bytes(),
    );
    out
}

/// フィクスチャ自身の健全性: startxref が xref を、xref の各オフセットが `N 0 obj` の先頭を指す
/// (バイト単位で照合する=先頭のバイナリ注釈行があっても位置がずれない)。
#[test]
fn fixture_xref_offsets_point_at_objects() {
    fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
        hay.windows(needle.len()).rposition(|w| w == needle)
    }
    for pages in [0usize, 1, 5] {
        let pdf = make_pdf(pages);
        let sx = find(&pdf, b"startxref\n").expect("startxref present") + b"startxref\n".len();
        let sx_end = pdf[sx..]
            .iter()
            .position(|b| *b == b'\n')
            .expect("startxref line ends")
            + sx;
        let xref_at: usize = std::str::from_utf8(&pdf[sx..sx_end])
            .expect("ascii")
            .trim()
            .parse()
            .expect("startxref is a number");
        assert!(
            pdf[xref_at..].starts_with(b"xref\n"),
            "startxref must point at xref"
        );
        let table = std::str::from_utf8(&pdf[xref_at..]).expect("the xref table is ascii");
        let entries: Vec<&str> = table.lines().skip(3).collect(); // xref / 0 n / free
        let objects = if pages == 0 { 2 } else { 2 + pages + 1 };
        for (i, entry) in entries.iter().take(objects).enumerate() {
            let off: usize = entry[..10].parse().expect("offset is 10 digits");
            assert!(
                pdf[off..].starts_with(format!("{} 0 obj\n", i + 1).as_bytes()),
                "xref entry {} must point at its object (pages={pages})",
                i + 1
            );
        }
    }
}

// ---------------------------------------------------------------------------
// (b) PDFKit の文書 — N ページの PDF で N・PDF でない/空のバイト列は Err
// ---------------------------------------------------------------------------

/// 1. 1ページの PDF → 1。
#[test]
fn one_page_pdf_has_one_page() {
    assert_eq!(pdf_page_count(&make_pdf(1)), Ok(1));
}

/// 2. 5ページの PDF → 5(backlog 307 = 5ページの先頭 1/5 しか出なかったときの形)。
#[test]
fn five_page_pdf_has_five_pages() {
    assert_eq!(pdf_page_count(&make_pdf(5)), Ok(5));
}

/// 3. 作ったページ数がそのまま返る(全ページが文書に載る=契約 1 の「全ページ」)。
#[test]
fn page_count_matches_the_pdf_for_several_sizes() {
    for pages in [2usize, 3, 7, 12] {
        assert_eq!(
            pdf_page_count(&make_pdf(pages)),
            Ok(pages),
            "a {pages}-page PDF must open as {pages} pages"
        );
    }
}

/// 4. 空のバイト列 → Err(印刷ダイアログを出さない=契約 3)。
#[test]
fn empty_bytes_are_an_error() {
    let result = pdf_page_count(&[]);
    assert!(
        result.is_err(),
        "empty bytes must not open as a PDF: {result:?}"
    );
}

/// 5. PDF でないバイト列 → Err(Markdown のテキスト・PNG の頭・でたらめなバイト)。
#[test]
fn non_pdf_bytes_are_an_error() {
    let png_header: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01";
    let garbage: Vec<u8> = (0u8..=255)
        .cycle()
        .take(4096)
        .map(|b| b.wrapping_mul(31))
        .collect();
    let cases: [(&str, &[u8]); 3] = [
        ("markdown", b"# Title\n\nThis is not a PDF.\n"),
        ("png", png_header),
        ("garbage", &garbage),
    ];
    for (name, bytes) in cases {
        let result = pdf_page_count(bytes);
        assert!(
            result.is_err(),
            "{name} bytes must not open as a PDF: {result:?}"
        );
    }
}

/// 6. ページが 0 の PDF → Err(「PDF として開けない(ページ 0)」=契約 3)。
#[test]
fn zero_page_pdf_is_an_error() {
    let result = pdf_page_count(&make_pdf(0));
    assert!(
        result.is_err(),
        "a PDF with no pages must be an error: {result:?}"
    );
}

/// 7. Err は文言を持つ(フロントは既存の printFailedMessage でそのまま知らせる=契約 3)。
#[test]
fn errors_carry_a_message() {
    let message = pdf_page_count(b"not a pdf").expect_err("not a PDF");
    assert!(!message.trim().is_empty(), "the error must say something");
}

// ---------------------------------------------------------------------------
// (b) ソース走査 — command・登録・メインスレッド・窓のシート(acceptance_req38f.rs の流儀)
// ---------------------------------------------------------------------------

fn strip_line_comments(src: &str) -> String {
    src.lines()
        .map(|line| {
            let bytes = line.as_bytes();
            let mut i = 0;
            while i + 1 < bytes.len() {
                if bytes[i] == b'/' && bytes[i + 1] == b'/' && (i == 0 || bytes[i - 1] != b':') {
                    return &line[..i];
                }
                i += 1;
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn lib_rs_code() -> String {
    strip_line_comments(include_str!("../src/lib.rs"))
}

fn print_command_code() -> String {
    strip_line_comments(include_str!("../src/commands/print.rs"))
}

fn print_module_code() -> String {
    strip_line_comments(include_str!("../src/print.rs"))
}

/// 印刷の実装が置かれうる2ファイル(command 本体と crate::print)をつないだもの。
fn print_code() -> String {
    format!("{}\n{}", print_command_code(), print_module_code())
}

fn handler_lists(code: &str) -> Vec<Vec<String>> {
    code.match_indices("generate_handler![")
        .map(|(i, _)| {
            let start = i + "generate_handler![".len();
            let end = code[start..].find(']').expect("handler list must close") + start;
            code[start..end]
                .split(',')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.rsplit("::").next().unwrap().to_string())
                .collect()
        })
        .collect()
}

/// `fn <name>(` から始まる関数の引数リストを切り出す。
fn function_params<'a>(code: &'a str, name: &str, file: &str) -> &'a str {
    let needle = format!("fn {name}(");
    let start = code
        .find(&needle)
        .unwrap_or_else(|| panic!("{file} must define {name}"));
    let params_start = start + needle.len();
    let params_end = code[params_start..]
        .find(')')
        .expect("parameter list must close")
        + params_start;
    &code[params_start..params_end]
}

/// 8. `commands/print.rs` に `print_pdf` があり、`#[tauri::command]` が直接付く・pub。
#[test]
fn print_pdf_is_a_tauri_command() {
    let code = print_command_code();
    let start = code
        .find("fn print_pdf(")
        .expect("commands/print.rs must define print_pdf");
    let before = &code[..start];
    let attr_at = before
        .rfind("#[tauri::command]")
        .expect("commands/print.rs declares tauri commands");
    assert!(
        !before[attr_at..].contains("fn "),
        "the #[tauri::command] attribute must sit directly on print_pdf"
    );
    assert!(
        code.contains("pub fn print_pdf(") || code.contains("pub async fn print_pdf("),
        "print_pdf must be pub so lib.rs can register it"
    );
}

/// 9. 引数はフロントの `{ uri }`(`uri: String`)と呼び出し元の窓(ラベルは受け取らない)。
#[test]
fn print_pdf_takes_the_uri_and_the_calling_window() {
    let code = print_command_code();
    let params = function_params(&code, "print_pdf", "commands/print.rs");
    assert!(
        params.contains("uri: String"),
        "print_pdf must take `uri: String` (the name the frontend passes): {params}"
    );
    assert!(
        params.contains("Window"),
        "the window comes from the calling window handle (tauri::Window / WebviewWindow): {params}"
    );
    assert!(
        !params.contains("label"),
        "the frontend never names a window: {params}"
    );
}

/// 10. `lib.rs` の両方の `generate_handler!` に `print_pdf` が 1 回ずつ登録される
///     (既存の印刷 command の登録はそのまま)。
#[test]
fn print_pdf_is_registered_in_both_handler_lists() {
    let code = lib_rs_code();
    let blocks = handler_lists(&code);
    assert_eq!(
        blocks.len(),
        2,
        "lib.rs has the webdriver and the production handler lists"
    );
    for names in blocks {
        for required in [
            "print_current_window",
            "print_html",
            "set_print_available",
            "print_pdf",
        ] {
            assert_eq!(
                names.iter().filter(|n| *n == required).count(),
                1,
                "{required} must be registered exactly once: {names:?}"
            );
        }
    }
}

/// 11. 中身は PDFKit の `PDFDocument`(契約 1・4=プレビュー.app と同じ紙面)。
#[test]
fn print_code_uses_pdfkit_document() {
    let code = print_code();
    assert!(
        code.contains("PDFDocument"),
        "the PDF must be printed through PDFKit's PDFDocument (print.rs / commands/print.rs)"
    );
}

/// 12. 印刷操作は窓のシート(`runOperationModalForWindow`)として出す(契約 1・3=その窓のシート)。
#[test]
fn print_operation_runs_as_a_window_sheet() {
    let code = print_code();
    assert!(
        code.contains("runOperationModalForWindow"),
        "the print operation must run as a sheet of the calling window (runOperationModalForWindow)"
    );
}

/// 13. 印刷操作はメインスレッドで走らせる(契約 3。AppKit の UI はメインスレッドのみ)。
#[test]
fn print_operation_runs_on_the_main_thread() {
    let code = print_code();
    assert!(
        code.contains("run_on_main_thread(") || code.contains("MainThreadMarker"),
        "the print operation must be dispatched to the main thread (run_on_main_thread / MainThreadMarker)"
    );
}
