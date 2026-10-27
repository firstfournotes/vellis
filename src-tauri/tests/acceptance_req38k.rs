//! 要件#38 追補k の受け入れテスト(docs/requirements/req-38.md 追補k・Issue #665=backlog 308)— Rust 層
//!
//! 「ローカルの PDF の印刷は、ファイルをアプリのメモリへ全部読まず、パスから PDFKit に開かせる」
//!
//! 発見(2026-10-06 追補g の reviewer P3): `print_pdf`(`commands/print.rs`)は `read_bytes` で
//! 全バイトを読むので、ローカルの上限 `MAX_FILE_SIZE`(50 MB・`fs/local.rs`)を超える PDF は、
//! 画面には出る(`vellis-asset:` で少しずつ読む)のに印刷すると「Could not print: …file too large」
//! になる。
//!
//! 契約(追補k):
//! 1. `print_pdf` は `file://` のとき `read_bytes` を通さず、ファイルのパスを PDFKit に渡して開く
//!    (`PDFDocument initWithURL:`)。開けない・ページが無いときは今と同じく印刷の前に `Err`
//!    (文言は今と同じ形)。読むのは PDFKit で、アプリのメモリへ全部を写さない
//! 2. `ssh://` は今のまま(`read_bytes` で読んで `initWithData:`。上限も今のまま)
//! 3. 不変: 印刷のシートの出し方(呼んだ窓のシート)・追補g の全ページを刷る作り・ページ数の確かめ・
//!    エラーの文言
//!
//! 本ファイルの持ち場= AC-38-追k の (a)〜(c)(macOS のみ・PDFKit を実際に呼ぶ=acceptance_req38g の作り):
//! - (a) ソース走査: `print_pdf` の `"file"` の経路が `read_bytes(` を呼ばず `print_pdf_path_in_window(`
//!   を呼ぶ。それ以外(ssh)の経路は `read_bytes(` → `print_pdf_in_window(` のまま。`print.rs` は
//!   `initWithURL` でパスから開き、ファイルを自分で読む呼び出し(`fs::read` 等)を持たない
//! - (b) `pdf_page_count_at_path` は PDF でないファイル・ページの無い PDF・無いパスで `Err`
//!   (文言は bytes 経路の `pdf_page_count` と同じ)。N ページの PDF は `Ok(N)`(bytes 経路と同じ答え)
//! - (c) 50 MB を超える PDF(テストの中で作る=未参照のストリーム 1 つで水増し)がパスで開けて
//!   ページ数が正しい。同じファイルを `LocalProvider::read_bytes` で読むと `FsError::FileTooLarge`
//!   (上限は今のまま=契約 2)
//!
//! フィクスチャの前提は 2026-10-19 に JXA(Quartz の `PDFDocument`)で実測した: 51 MB の未参照
//! ストリームで水増しした 7 ページの PDF は `initWithURL:` で 7 ページ、PDF でないファイル・無いパス・
//! ページ 0 の PDF は `initWithURL:` でも `initWithData:` でも nil(=両経路で同じ文言になる)。
//!
//! ## 確定契約(公開 API・implementer はこれに従う)
//!
//! ```ignore
//! // src-tauri/src/print.rs(既存の pdf_page_count / print_pdf_in_window の隣)
//!
//! /// `path` の PDF を PDFKit に **パスで** 開かせて(`PDFDocument initWithURL:`)ページ数を返す。
//! /// - `print_pdf_path_in_window` が印刷の前に文書を作るのと同じ道筋で作る(bytes 経路の
//! ///   `pdf_page_count` と `print_pdf_in_window` の関係と同じ)。ファイルを自分で読まない
//! ///   (`std::fs::read` / `tokio::fs::read` / `read_to_end` / `read_bytes` を使わない=契約 1)
//! /// - 開けない(nil)・ページ 0 → `Err(文言)`。文言は bytes 経路と同じ
//! ///   ("the file could not be opened as a PDF" / "the PDF has no pages to print")
//! /// - メインスレッドを要求しない(テストのワーカースレッドから呼べる)
//! #[cfg(target_os = "macos")]
//! pub fn pdf_page_count_at_path(path: &std::path::Path) -> Result<usize, String>;
//!
//! /// `path` の PDF をパスで開き(`initWithURL:`)、呼び出し元の窓のシートとして印刷する。
//! /// 文書を作ったあとは `print_pdf_in_window` と同じ(メインスレッドで `run_on_main_thread`・
//! /// `runOperationModalForWindow…`・用紙より大きいページだけ縮める・自動回転)。
//! /// 開けない・ページ 0 → シートを出さず `Err(文言)`(文言は今と同じ)。
//! #[cfg(target_os = "macos")]
//! pub async fn print_pdf_path_in_window<R: tauri::Runtime>(
//!     window: &tauri::Window<R>,
//!     path: std::path::PathBuf,
//! ) -> Result<(), String>;
//! // macOS 以外は print_pdf_in_window と同じく "printing a PDF is only supported on macOS" の Err
//! // (同名の `#[cfg(not(target_os = "macos"))]` 版を置く)
//!
//! // src-tauri/src/commands/print.rs の `print_pdf`(シグネチャ・lib.rs の登録は不変)
//! // 本文は `"file"` のリテラルでローカルを見分け、その**直後のブロック**がパスの経路:
//! //   if parsed.scheme == "file" { return print_pdf_path_in_window(&window, parsed.path).await; }
//! //   (または match parsed.scheme.as_str() { "file" => print_pdf_path_in_window(&window, parsed.path).await, _ => { … } })
//! // それ以外の経路は今のまま: state.fs_registry.resolve(&parsed) → read_bytes → print_pdf_in_window
//! ```
//!
//! ## reviewer 照合に委ねる配線(実機の AppKit 依存で機械判定不能)
//! - `print_pdf_path_in_window` が `initWithURL:` で作った文書を、bytes 経路と同じ
//!   `printOperationForPrintInfo:scalingMode:autoRotate:` → `runOperationModalForWindow…` に渡すこと
//! - ssh の PDF が今までどおり `read_bytes`(上限 50 MB)→ `initWithData:` で印刷されること
//!
//! ## 人間ゲート
//! - 実機: 50 MB を超えるローカルの PDF を開いて Command + P で印刷のシートが出て、ページ数が PDF と同じ

#![cfg(target_os = "macos")]

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use tempfile::TempDir;

use vellis_lib::errors::FsError;
use vellis_lib::fs::local::LocalProvider;
use vellis_lib::fs::provider::FileProvider;
use vellis_lib::fs::uri::Uri;
use vellis_lib::print::{pdf_page_count, pdf_page_count_at_path};

// ---------------------------------------------------------------------------
// フィクスチャ — N ページの最小 PDF(acceptance_req38g の `make_pdf`)に、未参照のストリーム
// 1 つで水増しできる口を足したもの。xref のオフセットは書いたバイト数から数える。
// ---------------------------------------------------------------------------

const MB: u64 = 1024 * 1024;

/// `fs/local.rs` の `MAX_FILE_SIZE`(50 MB・非公開)の写し。acceptance_req27 と同じ固定値。
const MAX_FILE_SIZE: u64 = 50 * MB;

/// (c) の PDF の水増し量。ファイル全体が `MAX_FILE_SIZE` を確実に超える。
const BIG_PADDING: usize = 51 * MB as usize;

/// (c) の PDF のページ数。
const BIG_PAGES: usize = 7;

/// 書き手: 書いたバイト数を数え、オブジェクトの先頭位置を xref 用に覚える。
struct PdfWriter<'a> {
    out: &'a mut dyn Write,
    written: usize,
    offsets: Vec<usize>,
}

impl<'a> PdfWriter<'a> {
    fn put(&mut self, bytes: &[u8]) {
        self.out.write_all(bytes).expect("write pdf bytes");
        self.written += bytes.len();
    }

    /// `id 0 obj` の先頭を記録して書き始める(オブジェクトは番号順に書く)。
    fn begin_obj(&mut self, id: usize) {
        assert_eq!(self.offsets.len() + 1, id, "objects are written in order");
        self.offsets.push(self.written);
        self.put(format!("{id} 0 obj\n").as_bytes());
    }

    fn obj(&mut self, id: usize, body: &str) {
        self.begin_obj(id);
        self.put(format!("{body}\nendobj\n").as_bytes());
    }
}

/// `pages` ページの最小 PDF(1.4)を `out` に書く。各ページは US Letter の空白ページで、
/// 1ページ目に区別用の短い内容ストリームを持つ。`padding > 0` なら最後に、どこからも参照
/// されないストリーム(`padding` バイトのゼロ)を 1 オブジェクト足す=PDFKit は xref から
/// 必要なオブジェクトへ飛ぶので、水増しは読み飛ばされ、ページ数は変わらない。
///
/// オブジェクト: 1=Catalog・2=Pages・3..=各 Page(+ 内容ストリーム 1 つ)(+ 水増し 1 つ)。
/// xref の各行は規格どおり 20 バイト(`nnnnnnnnnn ggggg n \n`)。`pages == 0` なら Kids が空・Count 0。
fn write_pdf(out: &mut dyn Write, pages: usize, padding: usize) {
    let mut w = PdfWriter {
        out,
        written: 0,
        offsets: Vec::new(),
    };

    w.put(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

    let page_ids: Vec<usize> = (0..pages).map(|i| 3 + i).collect();
    let content_id = 3 + pages; // 1ページ目の内容ストリーム(pages > 0 のときだけ書く)
    let padding_id = if pages > 0 { content_id + 1 } else { 3 };

    w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");

    let kids = page_ids
        .iter()
        .map(|id| format!("{id} 0 R"))
        .collect::<Vec<_>>()
        .join(" ");
    w.obj(
        2,
        &format!("<< /Type /Pages /Kids [{kids}] /Count {pages} >>"),
    );

    for (i, id) in page_ids.iter().enumerate() {
        let contents = if i == 0 {
            format!(" /Contents {content_id} 0 R")
        } else {
            String::new()
        };
        w.obj(
            *id,
            &format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]{contents} >>"),
        );
    }

    if pages > 0 {
        let stream = "0 0 0 RG 72 720 m 540 720 l S";
        w.obj(
            content_id,
            &format!(
                "<< /Length {} >>\nstream\n{stream}\nendstream",
                stream.len()
            ),
        );
    }

    if padding > 0 {
        w.begin_obj(padding_id);
        w.put(format!("<< /Length {padding} >>\nstream\n").as_bytes());
        let chunk = vec![0u8; padding.min(MB as usize)];
        let mut left = padding;
        while left > 0 {
            let n = left.min(chunk.len());
            w.put(&chunk[..n]);
            left -= n;
        }
        w.put(b"\nendstream\nendobj\n");
    }

    let size = w.offsets.len() + 1;
    let xref_at = w.written;
    w.put(format!("xref\n0 {size}\n").as_bytes());
    w.put(b"0000000000 65535 f \n");
    for off in w.offsets.clone() {
        let line = format!("{off:010} 00000 n \n");
        assert_eq!(line.len(), 20, "an xref entry is exactly 20 bytes");
        w.put(line.as_bytes());
    }
    w.put(
        format!("trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n")
            .as_bytes(),
    );
}

/// `pages` ページの最小 PDF(水増しなし)のバイト列。
fn make_pdf(pages: usize) -> Vec<u8> {
    let mut out = Vec::new();
    write_pdf(&mut out, pages, 0);
    out
}

/// `dir/name` に `pages` ページ・`padding` バイト水増しの PDF を書き、そのパスを返す。
fn write_pdf_file(dir: &Path, name: &str, pages: usize, padding: usize) -> PathBuf {
    let path = dir.join(name);
    let file = File::create(&path).expect("create pdf file");
    let mut out = BufWriter::new(file);
    write_pdf(&mut out, pages, padding);
    out.flush().expect("flush pdf file");
    path
}

/// `dir/name` に `bytes` をそのまま書き、そのパスを返す。
fn write_file(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, bytes).expect("write file");
    path
}

fn make_local_uri(path: &Path) -> Uri {
    Uri {
        scheme: "file".into(),
        authority: None,
        path: path.to_path_buf(),
        raw: format!("file://{}", path.display()),
    }
}

/// フィクスチャ自身の健全性: startxref が xref を、xref の各オフセットが `N 0 obj` の先頭を指す
/// (水増しありでも位置がずれない)。
#[test]
fn fixture_xref_offsets_point_at_objects_with_and_without_padding() {
    fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
        hay.windows(needle.len()).rposition(|w| w == needle)
    }
    for (pages, padding) in [(0usize, 0usize), (1, 0), (5, 0), (0, 300), (3, 4096)] {
        let mut pdf = Vec::new();
        write_pdf(&mut pdf, pages, padding);
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
            "startxref must point at xref (pages={pages}, padding={padding})"
        );
        let table = std::str::from_utf8(&pdf[xref_at..]).expect("the xref table is ascii");
        let mut lines = table.lines();
        lines.next(); // xref
        let count: usize = lines
            .next()
            .expect("subsection line")
            .split(' ')
            .nth(1)
            .expect("object count")
            .parse()
            .expect("count is a number");
        lines.next(); // the free entry
        let objects = {
            let base = if pages == 0 { 2 } else { 2 + pages + 1 };
            if padding > 0 { base + 1 } else { base }
        };
        assert_eq!(count, objects + 1, "xref size counts the free entry");
        for (i, entry) in lines.take(objects).enumerate() {
            let off: usize = entry[..10].parse().expect("offset is 10 digits");
            assert!(
                pdf[off..].starts_with(format!("{} 0 obj\n", i + 1).as_bytes()),
                "xref entry {} must point at its object (pages={pages}, padding={padding})",
                i + 1
            );
        }
    }
}

/// フィクスチャの前提: 水増しした 50 MB 超の PDF は、既存の bytes 経路(`pdf_page_count`=
/// `initWithData:`)でも正しいページ数で開ける=水増しがページ数を変えていない。
/// (新しい経路が落ちたとき、フィクスチャのせいか実装のせいかを切り分けるための対照)
#[test]
fn fixture_over_50mb_pdf_opens_from_bytes_with_its_page_count() {
    let tmp = TempDir::new().unwrap();
    let path = write_pdf_file(tmp.path(), "big.pdf", BIG_PAGES, BIG_PADDING);
    let len = std::fs::metadata(&path).unwrap().len();
    assert!(
        len > MAX_FILE_SIZE,
        "the fixture must exceed the 50 MB read_bytes cap: {len} bytes"
    );
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(pdf_page_count(&bytes), Ok(BIG_PAGES));
}

// ---------------------------------------------------------------------------
// (b) パスで開く — N ページで N(bytes 経路と同じ答え)・PDF でない/ページ 0/無いパスは Err
// ---------------------------------------------------------------------------

/// 1. N ページの PDF をパスで開くと `Ok(N)`。bytes 経路(`pdf_page_count`)と同じ答え
///    (=追補g の「ページ数の確かめ」が不変=契約 3)。
#[test]
fn path_route_counts_pages_like_the_bytes_route() {
    let tmp = TempDir::new().unwrap();
    for pages in [1usize, 2, 5, 12] {
        let path = write_pdf_file(tmp.path(), &format!("{pages}.pdf"), pages, 0);
        let by_path = pdf_page_count_at_path(&path);
        assert_eq!(
            by_path,
            Ok(pages),
            "a {pages}-page PDF must open from its path as {pages} pages"
        );
        assert_eq!(
            by_path,
            pdf_page_count(&std::fs::read(&path).unwrap()),
            "the path route must give the bytes route's answer (pages={pages})"
        );
    }
}

/// 2. PDF でないファイル → Err(Markdown・PNG の頭・`.pdf` の名前だがでたらめなバイト)。
///    文言は bytes 経路で同じバイト列を開いたときと同じ(契約 1=「文言は今と同じ形」)。
#[test]
fn path_route_rejects_a_file_that_is_not_a_pdf() {
    let tmp = TempDir::new().unwrap();
    let png_header: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01";
    let garbage: Vec<u8> = (0u8..=255)
        .cycle()
        .take(4096)
        .map(|b| b.wrapping_mul(31))
        .collect();
    let cases: [(&str, &[u8]); 3] = [
        ("note.md", b"# Title\n\nThis is not a PDF.\n"),
        ("pic.png", png_header),
        ("garbage.pdf", &garbage),
    ];
    for (name, bytes) in cases {
        let path = write_file(tmp.path(), name, bytes);
        let result = pdf_page_count_at_path(&path);
        assert!(
            result.is_err(),
            "{name} must not open as a PDF from its path: {result:?}"
        );
        assert_eq!(
            result,
            pdf_page_count(bytes),
            "{name}: the path route must fail with the bytes route's wording"
        );
    }
}

/// 3. ページが 0 の PDF → Err(印刷のシートを出さない=契約 1)。文言は bytes 経路と同じ。
#[test]
fn path_route_rejects_a_pdf_with_no_pages() {
    let tmp = TempDir::new().unwrap();
    let path = write_pdf_file(tmp.path(), "empty.pdf", 0, 0);
    let result = pdf_page_count_at_path(&path);
    assert!(
        result.is_err(),
        "a PDF with no pages must be an error from its path: {result:?}"
    );
    assert_eq!(
        result,
        pdf_page_count(&make_pdf(0)),
        "the path route must fail with the bytes route's wording"
    );
}

/// 4. 無いパス → Err(文言あり=フロントは printFailedMessage でそのまま知らせる)。
#[test]
fn path_route_rejects_a_missing_path() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("does-not-exist.pdf");
    assert!(!path.exists());
    let message = pdf_page_count_at_path(&path).expect_err("a missing path cannot open as a PDF");
    assert!(!message.trim().is_empty(), "the error must say something");
}

// ---------------------------------------------------------------------------
// (c) 50 MB 超 — パスで開けてページ数が正しい・read_bytes では上限で断られる(今のまま)
// ---------------------------------------------------------------------------

/// 5. 50 MB を超える PDF がパスで開けて、ページ数が正しい(Issue #665 の本体)。
#[test]
fn over_50mb_pdf_opens_from_its_path_with_the_right_page_count() {
    let tmp = TempDir::new().unwrap();
    let path = write_pdf_file(tmp.path(), "big.pdf", BIG_PAGES, BIG_PADDING);
    let len = std::fs::metadata(&path).unwrap().len();
    assert!(len > MAX_FILE_SIZE, "the PDF must exceed 50 MB: {len} bytes");
    assert_eq!(
        pdf_page_count_at_path(&path),
        Ok(BIG_PAGES),
        "a PDF over the read_bytes cap must still open from its path with every page"
    );
}

/// 6. 同じファイルを `LocalProvider::read_bytes` で読むと `FsError::FileTooLarge`
///    (上限は今のまま=契約 2。ssh の経路はこの上限のまま)。
#[tokio::test]
async fn over_50mb_pdf_is_still_refused_by_read_bytes() {
    let tmp = TempDir::new().unwrap();
    let path = write_pdf_file(tmp.path(), "big.pdf", BIG_PAGES, BIG_PADDING);
    let provider = LocalProvider::new();
    let result = provider.read_bytes(&make_local_uri(&path)).await;
    assert!(
        matches!(result, Err(FsError::FileTooLarge(_))),
        "read_bytes keeps its 50 MB cap (got: {result:?})"
    );
}

// ---------------------------------------------------------------------------
// (a) ソース走査 — print_pdf の file の経路・ssh の経路・print.rs の開き方
// (acceptance_req38g.rs の流儀)
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

fn print_command_code() -> String {
    strip_line_comments(include_str!("../src/commands/print.rs"))
}

fn print_module_code() -> String {
    strip_line_comments(include_str!("../src/print.rs"))
}

/// `code[open..]` が `{` で始まるとして、対応する `}` の次の位置(文字列リテラルの中の
/// 括弧は数えない)。
fn block_end(code: &str, open: usize) -> usize {
    let bytes = code.as_bytes();
    assert_eq!(bytes[open], b'{', "block must start at a brace");
    let mut depth = 0usize;
    let mut i = open;
    let mut in_str = false;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if c == b'\\' {
                i += 1;
            } else if c == b'"' {
                in_str = false;
            }
        } else if c == b'"' {
            in_str = true;
        } else if c == b'{' {
            depth += 1;
        } else if c == b'}' {
            depth -= 1;
            if depth == 0 {
                return i + 1;
            }
        }
        i += 1;
    }
    panic!("block starting at {open} never closes");
}

/// `fn <name>(` の本体(外側の `{ … }` を含む)。
fn fn_body<'a>(code: &'a str, name: &str, file: &str) -> &'a str {
    let needle = format!("fn {name}(");
    let start = code
        .find(&needle)
        .unwrap_or_else(|| panic!("{file} must define {name}"));
    let open = code[start..]
        .find('{')
        .unwrap_or_else(|| panic!("{name} must have a body"))
        + start;
    &code[open..block_end(code, open)]
}

/// `fn <name>` の定義の位置(`fn <name>(` と `fn <name><R: …>(` の両方。`fn <name>_x` は拾わない)。
fn fn_definitions(code: &str, name: &str) -> Vec<usize> {
    let needle = format!("fn {name}");
    code.match_indices(&needle)
        .filter(|(i, _)| {
            matches!(code[i + needle.len()..].chars().next(), Some('(') | Some('<'))
        })
        .map(|(i, _)| i)
        .collect()
}

/// `fn <name>` の引数リスト(名前のあとの最初の `(` から対応する `)` まで。ジェネリクスは飛ばす)。
fn function_params<'a>(code: &'a str, name: &str, file: &str) -> &'a str {
    let start = *fn_definitions(code, name)
        .first()
        .unwrap_or_else(|| panic!("{file} must define {name}"));
    let params_start = code[start..].find('(').expect("parameter list must open") + start + 1;
    let bytes = code.as_bytes();
    let mut depth = 0usize;
    let mut i = params_start;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => {
                if depth == 0 {
                    return &code[params_start..i];
                }
                depth -= 1;
            }
            _ => {}
        }
        i += 1;
    }
    panic!("parameter list of {name} must close")
}

/// `print_pdf` の本体のうち、`"file"` のリテラルの直後に続くブロック(`if … == "file" { … }` の
/// `{ … }`、または `match` の `"file" => { … }` / `"file" => 式,` の腕)=パスの経路。
fn file_branch(body: &str) -> &str {
    const LIT: &str = "\"file\"";
    assert_eq!(
        body.matches(LIT).count(),
        1,
        "print_pdf must tell the local route apart with the literal \"file\" exactly once (契約 1):\n{body}"
    );
    let after = body.find(LIT).unwrap() + LIT.len();
    let rest = &body[after..];
    let bytes = rest.as_bytes();
    let mut i = 0;
    loop {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if rest[i..].starts_with("=>") {
            i += 2;
            continue;
        }
        if i < bytes.len() && bytes[i] == b')' {
            i += 1;
            continue;
        }
        break;
    }
    assert!(
        i < bytes.len(),
        "something must follow the \"file\" literal in print_pdf:\n{body}"
    );
    if bytes[i] == b'{' {
        return &rest[i..block_end(rest, i)];
    }
    // match の腕が式のとき: 深さ 0 の `,` まで。
    let mut depth = 0isize;
    let mut j = i;
    while j < bytes.len() {
        match bytes[j] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                if depth == 0 {
                    break;
                }
                depth -= 1;
            }
            b',' if depth == 0 => break,
            _ => {}
        }
        j += 1;
    }
    &rest[i..j]
}

/// `code` から `call(` の引数部分(対応する `)` まで)を切り出す。
fn call_args<'a>(code: &'a str, call: &str) -> &'a str {
    let needle = format!("{call}(");
    let start = code
        .find(&needle)
        .unwrap_or_else(|| panic!("code must call {call}(:\n{code}"))
        + needle.len();
    let bytes = code.as_bytes();
    let mut depth = 0usize;
    let mut i = start;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => {
                if depth == 0 {
                    return &code[start..i];
                }
                depth -= 1;
            }
            _ => {}
        }
        i += 1;
    }
    panic!("{call}( never closes")
}

/// 7. `print_pdf` の `"file"` の経路は `read_bytes(` を呼ばず、`print_pdf_path_in_window(` に
///    `.path`(`parsed.path`)を渡す。bytes 経路の `print_pdf_in_window(` も呼ばない。
#[test]
fn print_pdf_file_route_opens_by_path_without_read_bytes() {
    let code = print_command_code();
    let body = fn_body(&code, "print_pdf", "commands/print.rs");
    let branch = file_branch(body);
    assert!(
        branch.contains("print_pdf_path_in_window("),
        "the file route must call print_pdf_path_in_window (契約 1):\n{branch}"
    );
    let args = call_args(branch, "print_pdf_path_in_window");
    assert!(
        args.contains(".path"),
        "print_pdf_path_in_window must receive the parsed URI's path (`parsed.path`): ({args})"
    );
    assert!(
        !branch.contains("read_bytes("),
        "the file route must not read the file through read_bytes (契約 1):\n{branch}"
    );
    assert!(
        !branch.contains("print_pdf_in_window("),
        "the file route must not take the bytes route (契約 1):\n{branch}"
    );
}

/// 8. それ以外(ssh)の経路は今のまま: プロバイダを `resolve(` して `read_bytes(` →
///    `print_pdf_in_window(`(この順)。パスの経路はそこに現れない。各呼び出しは本体に 1 回ずつ。
#[test]
fn print_pdf_other_route_still_reads_bytes_into_print_pdf_in_window() {
    let code = print_command_code();
    let body = fn_body(&code, "print_pdf", "commands/print.rs");
    let branch = file_branch(body);
    let rest = body.replacen(branch, "", 1);

    for (call, expected) in [
        ("read_bytes(", 1usize),
        ("print_pdf_in_window(", 1),
        ("print_pdf_path_in_window(", 1),
    ] {
        assert_eq!(
            body.matches(call).count(),
            expected,
            "print_pdf must call {call} exactly {expected} time(s):\n{body}"
        );
    }
    assert!(
        rest.contains("resolve("),
        "the ssh route still resolves the provider (契約 2):\n{rest}"
    );
    let read_at = rest
        .find("read_bytes(")
        .unwrap_or_else(|| panic!("the ssh route must still call read_bytes (契約 2):\n{rest}"));
    let print_at = rest
        .find("print_pdf_in_window(")
        .unwrap_or_else(|| panic!("the ssh route must still call print_pdf_in_window (契約 2):\n{rest}"));
    assert!(
        read_at < print_at,
        "the ssh route reads the bytes first, then prints them (契約 2):\n{rest}"
    );
    assert!(
        !rest.contains("print_pdf_path_in_window("),
        "only the file route opens by path:\n{rest}"
    );
}

/// 9. `print.rs` はパスを PDFKit に渡して開き(`initWithURL`)、ファイルを自分では読まない
///    (`std::fs::read` / `tokio::fs::read` / `read_to_end` / `read_bytes` が無い=契約 1 の
///    「アプリのメモリへ全部を写さない」)。bytes 経路の `initWithData` は残る(契約 2)。
#[test]
fn print_module_opens_the_path_with_pdfkit_and_never_reads_the_file_itself() {
    let code = print_module_code();
    assert!(
        code.contains("initWithURL"),
        "print.rs must open the local PDF from its path with PDFDocument initWithURL: (契約 1)"
    );
    assert!(
        code.contains("initWithData"),
        "print.rs must keep the bytes route's PDFDocument initWithData: (契約 2)"
    );
    for forbidden in [
        "fs::read(",
        "fs::read_to_string(",
        "read_to_end(",
        "read_bytes(",
        "dataWithContentsOfFile",
        "dataWithContentsOfURL",
    ] {
        assert!(
            !code.contains(forbidden),
            "print.rs must not copy the file into memory itself (`{forbidden}`): PDFKit reads it (契約 1)"
        );
    }
}

/// 10. `print_pdf_path_in_window` は `pub async fn`・呼び出し元の窓とパスを受け、シートは
///     bytes 経路と同じくメインスレッドで出す(契約 3=シートの出し方は不変)。
#[test]
fn print_pdf_path_in_window_takes_the_window_and_a_path_and_runs_on_the_main_thread() {
    let code = print_module_code();
    let definitions = fn_definitions(&code, "print_pdf_path_in_window");
    assert!(
        !definitions.is_empty(),
        "print.rs must define print_pdf_path_in_window"
    );
    for at in &definitions {
        assert!(
            code[..*at].ends_with("pub async "),
            "every print_pdf_path_in_window (macOS and the stub) must be `pub async fn`"
        );
    }

    let params = function_params(&code, "print_pdf_path_in_window", "print.rs");
    assert!(
        params.contains("Window"),
        "print_pdf_path_in_window takes the calling window (tauri::Window<R>): {params}"
    );
    assert!(
        params.contains("Path"),
        "print_pdf_path_in_window takes the file's path (PathBuf / &Path): {params}"
    );
    assert!(
        !params.contains("Vec<u8>") && !params.contains("&[u8]"),
        "print_pdf_path_in_window takes a path, not bytes: {params}"
    );

    // macOS 版の本体(どちらの cfg が先でも、本体のどれかがメインスレッドへ渡す)
    let found_main_thread = definitions.iter().any(|start| {
        let open = code[*start..].find('{').expect("body") + start;
        let body = &code[open..block_end(&code, open)];
        body.contains("run_on_main_thread(") || body.contains("MainThreadMarker")
    });
    assert!(
        found_main_thread,
        "print_pdf_path_in_window must dispatch the print operation to the main thread like print_pdf_in_window (契約 3)"
    );
}
