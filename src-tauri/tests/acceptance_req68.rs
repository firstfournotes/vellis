//! 要件#68 の受け入れテスト(docs/requirements/req-68.md)— AC-68-1〜8
//!
//! 「Finder の『このアプリケーションで開く(Open With)』の一覧に Vellis が出て、選べばその
//! ファイルを開く」。一覧に出ること・選んで開くことそのものは LaunchServices の登録が要るので
//! 人間ゲート(1〜3)。ここでは Tauri を起動せずに判定できる面を固定する ――
//! 宣言(`tauri.conf.json` の `bundle.fileAssociations`)・file-type.ts との突き合わせ・
//! URL の変換・初期窓への振り分け・`setup` 前の貯め込み・`lib.rs` の配線・依存の不変。
//!
//! 判定範囲(AC 番号は req-68.md の受け入れ基準):
//! - AC-68-1 `tauri.conf.json` が `tauri::utils::config::Config` として読める(`deny_unknown_fields`)。
//!   `fileAssociations` は8項目・名前8つ・全項目 `Viewer` / `Alternate` / `exportedType` 無し
//! - AC-68-2 項目ごとの `ext` が表どおり。`Text` は `ext = ["txt"]`(bundler のための飾り=判断 (l))
//!   + `contentTypes = ["public.text"]`。他は `contentTypes` 無し。`ext` は小文字・`.` 無し(生の JSON
//!   でも)・8項目を通して重複無し
//! - AC-68-3 `Text` 以外の項目が file-type.ts(正本)から導いた集合と一致。`Text` の `ext` は `txt` だけで、
//!   `txt` はどの `*_EXTENSIONS` にも無い(=text 分類)。`BINARY_EXTENSIONS` を宣言しない。mkv・avi 無し
//! - AC-68-4 `opened_file_uris`: 符号を解いて canonicalize・順序保持・`file` 以外を捨てる・
//!   フォルダを捨てる・存在しないファイルは残す・空は空
//! - AC-68-5 `plan_initial_open`: 引数無しの初期窓は1件目を受け取る・CLI の path / root があれば
//!   変えない・`show_marks` / `show_changed` を保つ
//! - AC-68-6 `PendingOpens`: `take_at_setup` の前は貯めて空を返す・取り出しは届いた順に全部・
//!   その後は素通し・2回目の取り出しは空
//! - AC-68-7 配線(ソース走査・行コメントを除く): `RunEvent::Opened` の分岐が `lib.rs` の
//!   `#[cfg(target_os = "macos")]` の下・通常起動側の `run` コールバックにあり、そこから
//!   `opened_file_uris` → `receive` → `Request::OpenPath` / `dispatch_command` へ届く。`setup` の中で
//!   `take_at_setup` → `plan_initial_open` → `register_window("main", …)` の順。`PendingOpens` を
//!   `Builder` に `manage`。`.run(generate_context!())` の形が無い。`window/open_with.rs` に
//!   `WebviewWindowBuilder` も `cfg(target_os` も無い
//! - AC-68-8 不変: Cargo.toml の各依存節のクレート集合が周回開始時点(2026-10-05)と同一
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前・公開パス)
//!
//! ```ignore
//! // src-tauri/src/window/open_with.rs(新規・window/mod.rs に `pub mod open_with;`)
//! pub fn opened_file_uris(urls: &[tauri::Url]) -> Vec<String>;
//! pub fn plan_initial_open(initial: WindowArgs, opened: Vec<String>) -> (WindowArgs, Vec<String>);
//!
//! #[derive(Default)]
//! pub struct PendingOpens { /* std::sync::Mutex。manage する状態なので &self で動く */ }
//! impl PendingOpens {
//!     pub fn receive(&self, uris: Vec<String>) -> Vec<String>;
//!     pub fn take_at_setup(&self) -> Vec<String>;
//! }
//! ```
//!
//! - 3つの公開面は macOS 以外でもコンパイルされる(本テストは cfg で分けない)。
//!   `cfg(target_os = "macos")` は `lib.rs` の `RunEvent::Opened` の分岐だけ
//! - AC-68-7 の走査が通る `lib.rs` の形: `if is_self_check { … app.run(|_, _| {}); } else { … .run(<コールバック>) }`
//!   を保ち、`RunEvent::Opened` の分岐は `else` 側のコールバックに直接書くか、`lib.rs` の自由関数に
//!   出してそこから呼ぶ(走査は `lib.rs` と `open_with.rs` の自由関数の本体を呼び出し名で辿る)。
//!   `#[cfg(target_os = "macos")]` は `RunEvent::Opened` の分岐(match の腕・`if let`・`match` 全体)の
//!   直前に置く(間に別の腕 `=>` を挟まない)

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use tauri::utils::config::{BundleTypeRole, Config, FileAssociation, HandlerRank};
use tauri::Url;

use vellis_lib::window::manager::WindowArgs;
use vellis_lib::window::open_with::{opened_file_uris, plan_initial_open, PendingOpens};

const TAURI_CONF: &str = include_str!("../tauri.conf.json");
const FILE_TYPE_TS: &str = include_str!("../../src/lib/file-type.ts");
const VIDEO_VIEWING_TS: &str = include_str!("../../src/lib/video-viewing.ts");
const CARGO_TOML: &str = include_str!("../Cargo.toml");
const LIB_RS: &str = include_str!("../src/lib.rs");

/// 「宣言の形」(契約1)の表。`Text` は飾りの `txt`(判断 (l))+ `contentTypes`。
const EXPECTED_ASSOCIATIONS: &[(&str, &[&str])] = &[
    ("Markdown", &["md", "markdown", "mdx"]),
    ("HTML", &["html", "htm"]),
    (
        "Image",
        &["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"],
    ),
    ("3D Model", &["stl", "3mf", "obj", "ply"]),
    ("Video", &["mp4", "mov", "webm"]),
    ("Audio", &["wav", "mp3", "m4a"]),
    ("PDF", &["pdf"]),
    ("Text", &["txt"]),
];

// ---------------------------------------------------------------------------
// 共通ヘルパ
// ---------------------------------------------------------------------------

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_source(rel: &str) -> String {
    let path = manifest_dir().join(rel);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {}", path.display(), e))
}

fn config() -> Config {
    serde_json::from_str::<Config>(TAURI_CONF).unwrap_or_else(|e| {
        panic!("tauri.conf.json must parse as tauri::utils::config::Config (deny_unknown_fields): {e}")
    })
}

fn associations() -> Vec<FileAssociation> {
    config()
        .bundle
        .file_associations
        .expect("tauri.conf.json must declare bundle.fileAssociations (契約1)")
}

fn association<'a>(all: &'a [FileAssociation], name: &str) -> &'a FileAssociation {
    all.iter()
        .find(|a| a.name.as_deref() == Some(name))
        .unwrap_or_else(|| panic!("fileAssociations must have an item named {name:?}"))
}

fn ext_set(a: &FileAssociation) -> BTreeSet<String> {
    a.ext.iter().map(|e| e.0.clone()).collect()
}

/// TS ソースの `marker` から `close` までの間にある `'…'` の文字列(行コメントは落とす)。
fn ts_string_list(src: &str, marker: &str, close: &str) -> BTreeSet<String> {
    let start = src
        .find(marker)
        .unwrap_or_else(|| panic!("TS source must contain {marker:?}"))
        + marker.len();
    let end = src[start..]
        .find(close)
        .unwrap_or_else(|| panic!("{marker:?} must close with {close:?}"))
        + start;
    let body: String = src[start..end]
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    let mut out = BTreeSet::new();
    let mut rest = body.as_str();
    while let Some(a) = rest.find('\'') {
        let after = &rest[a + 1..];
        let b = after.find('\'').expect("unterminated quote");
        out.insert(after[..b].to_string());
        rest = &after[b + 1..];
    }
    assert!(!out.is_empty(), "{marker:?} must not be empty");
    out
}

/// file-type.ts の `const NAME = new Set([...])`(要件55 AC-55-4 の `extension_set` と同じ方式)。
fn extension_set(name: &str) -> BTreeSet<String> {
    ts_string_list(FILE_TYPE_TS, &format!("const {name} = new Set(["), "])")
}

/// 行ごとに `//` 以降(コメント)を落とす。`://`(`file://` のリテラル)は落とさない
/// (acceptance_req62 と同じ流儀)。
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
    strip_line_comments(LIB_RS)
}

fn open_with_code() -> String {
    strip_line_comments(&read_source("src/window/open_with.rs"))
}

/// `from` 以降の最初の `open` から対応する `close` までを切り出す(文字列リテラルに括弧は
/// 現れない前提の素朴な走査)。
fn balanced(code: &str, from: usize, open: char, close: char) -> &str {
    let start = code[from..]
        .find(open)
        .unwrap_or_else(|| panic!("block must open with {open:?}"))
        + from;
    let mut depth = 0usize;
    for (offset, ch) in code[start..].char_indices() {
        if ch == open {
            depth += 1;
        } else if ch == close {
            depth -= 1;
            if depth == 0 {
                return &code[start..start + offset + ch.len_utf8()];
            }
        }
    }
    panic!("block must close with {close:?}");
}

fn balanced_block(code: &str, from: usize) -> &str {
    balanced(code, from, '{', '}')
}

/// `pos` を含むいちばん内側の `{ … }` ブロック。
fn enclosing_block(code: &str, pos: usize) -> &str {
    let mut depth = 0isize;
    let mut open = None;
    for (i, ch) in code[..pos].char_indices().rev() {
        match ch {
            '}' => depth += 1,
            '{' => {
                if depth == 0 {
                    open = Some(i);
                    break;
                }
                depth -= 1;
            }
            _ => {}
        }
    }
    let open = open.expect("position must be inside a block");
    balanced_block(code, open)
}

fn is_ident_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// `code` 中の自由関数 `(名前, 本体)` の一覧(`fn name(` を素朴に拾う)。
fn fn_bodies(code: &str) -> Vec<(String, &str)> {
    let bytes = code.as_bytes();
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(i) = code[from..].find("fn ") {
        let at = from + i;
        from = at + 3;
        if at > 0 && is_ident_char(bytes[at - 1]) {
            continue;
        }
        let name_start = at + 3;
        let name_end = code[name_start..]
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .map(|n| name_start + n)
            .unwrap_or(code.len());
        let name = &code[name_start..name_end];
        if name.is_empty() {
            continue;
        }
        let Some(paren) = code[name_end..].find('(') else { continue };
        let params = balanced(code, name_end + paren, '(', ')');
        let body_from = name_end + paren + params.len();
        // `fn x();`(トレイトの宣言)は本体が無い
        let next_brace = code[body_from..].find('{');
        let next_semi = code[body_from..].find(';');
        if let (Some(b), Some(s)) = (next_brace, next_semi) {
            if s < b {
                continue;
            }
        }
        if next_brace.is_none() {
            continue;
        }
        out.push((name.to_string(), balanced_block(code, body_from)));
    }
    out
}

/// `start` のテキストから `needle` へ届くか。テキストに現れる自由関数の呼び出し
/// (`name(`・直前が `.` でも識別子でもない)を本体へ辿って再帰する。
fn reaches(start: &str, fns: &[(String, &str)], needle: &str) -> bool {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut frontier = vec![start.to_string()];
    while let Some(text) = frontier.pop() {
        if text.contains(needle) {
            return true;
        }
        for (name, body) in fns {
            if seen.contains(name) {
                continue;
            }
            let call = format!("{name}(");
            let mut from = 0;
            let mut called = false;
            while let Some(i) = text[from..].find(&call) {
                let at = from + i;
                from = at + call.len();
                let prev = if at == 0 { b' ' } else { text.as_bytes()[at - 1] };
                if prev != b'.' && !is_ident_char(prev) {
                    called = true;
                    break;
                }
            }
            if called {
                seen.insert(name.clone());
                frontier.push(body.to_string());
            }
        }
    }
    false
}

/// `[header]` 節の `name = …` のキー集合(次の `[` で始まる行まで。acceptance_req55 と同じ)。
fn cargo_section_keys(header: &str) -> BTreeSet<String> {
    let marker = format!("\n{header}\n");
    let start = CARGO_TOML
        .find(&marker)
        .unwrap_or_else(|| panic!("Cargo.toml must have section {header}"))
        + marker.len();
    let body = &CARGO_TOML[start..];
    let end = body
        .lines()
        .scan(0usize, |acc, l| {
            let at = *acc;
            *acc += l.len() + 1;
            Some((at, l))
        })
        .find(|(_, l)| l.starts_with('['))
        .map(|(at, _)| at)
        .unwrap_or(body.len());
    body[..end]
        .lines()
        .filter_map(|l| {
            let l = l.trim_start();
            if l.starts_with('#') {
                return None;
            }
            let (key, _) = l.split_once('=')?;
            let key = key.trim().trim_matches('"');
            if key.is_empty() || key.contains(' ') {
                None
            } else {
                Some(key.to_string())
            }
        })
        .collect()
}

/// テンポラリの実在ファイル(親フォルダは canonicalize 済み)。
fn make_file(dir: &Path, rel: &str) -> PathBuf {
    let path = dir.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent");
    }
    std::fs::write(&path, "# req68\n").expect("write file");
    path
}

fn file_uri(path: &Path) -> String {
    format!("file://{}", path.display())
}

fn fake_file_uri(name: &str) -> String {
    format!("file:///req68-does-not-exist/{name}")
}

// ---------------------------------------------------------------------------
// AC-68-1 — 宣言の読み取りと8項目の名前・役割・順位(契約1)
// ---------------------------------------------------------------------------

#[test]
fn ac68_1_config_parses_and_declares_eight_named_associations() {
    let all = associations();
    assert_eq!(all.len(), 8, "bundle.fileAssociations must have exactly 8 items");

    let names: Vec<&str> = all.iter().map(|a| a.name.as_deref().unwrap_or("")).collect();
    let name_set: BTreeSet<String> = names.iter().map(|s| s.to_string()).collect();
    assert_eq!(name_set.len(), 8, "names must be unique: {names:?}");
    assert_eq!(
        name_set,
        set(&["Markdown", "HTML", "Image", "3D Model", "Video", "Audio", "PDF", "Text"])
    );
}

#[test]
fn ac68_1_every_association_is_viewer_alternate_without_exported_type() {
    for a in associations() {
        let name = a.name.clone().unwrap_or_default();
        assert_eq!(a.role, BundleTypeRole::Viewer, "{name}: role must be Viewer");
        assert_eq!(a.rank, HandlerRank::Alternate, "{name}: rank must be Alternate");
        assert!(a.exported_type.is_none(), "{name}: exportedType must not be declared");
        assert!(a.description.is_none(), "{name}: description (Windows-only) must not be declared");
        assert!(a.mime_type.is_none(), "{name}: mimeType (Linux-only) must not be declared");
    }
}

// ---------------------------------------------------------------------------
// AC-68-2 — 項目ごとの ext・Text の contentTypes・小文字と重複(契約1)
// ---------------------------------------------------------------------------

#[test]
fn ac68_2_ext_per_association_matches_the_table() {
    let all = associations();
    for (name, exts) in EXPECTED_ASSOCIATIONS {
        let a = association(&all, name);
        assert_eq!(ext_set(a), set(exts), "{name}: ext must match 宣言の形");
    }
}

#[test]
fn ac68_2_text_is_content_type_only_and_others_have_no_content_types() {
    let all = associations();
    let text = association(&all, "Text");
    assert_eq!(
        ext_set(text),
        set(&["txt"]),
        "Text declares exactly the decorative `txt` (判断 (l): an empty ext panics the bundler)"
    );
    assert_eq!(
        text.content_types.as_deref(),
        Some(&["public.text".to_string()][..]),
        "Text must declare contentTypes = [\"public.text\"]"
    );
    for a in &all {
        if a.name.as_deref() == Some("Text") {
            continue;
        }
        assert!(
            a.content_types.is_none(),
            "{:?}: an item with ext must not carry contentTypes (macOS ignores CFBundleTypeExtensions then)",
            a.name
        );
    }
}

#[test]
fn ac68_2_ext_are_lowercase_dotless_and_unique_across_items() {
    // 型に通すと先頭の `.` は落とされてしまうので、生の JSON の文字列を見る。
    let raw: serde_json::Value = serde_json::from_str(TAURI_CONF).expect("tauri.conf.json is JSON");
    let items = raw["bundle"]["fileAssociations"]
        .as_array()
        .expect("bundle.fileAssociations must be an array");
    assert_eq!(items.len(), 8);
    let mut seen = BTreeSet::new();
    let mut total = 0usize;
    for item in items {
        let exts = item["ext"].as_array().expect("ext must be an array");
        for e in exts {
            let e = e.as_str().expect("ext entries are strings");
            total += 1;
            assert!(!e.is_empty(), "ext must not be empty");
            assert!(!e.contains('.'), "ext must not contain '.': {e:?}");
            assert_eq!(e, e.to_lowercase(), "ext must be lowercase: {e:?}");
            assert!(seen.insert(e.to_string()), "ext declared twice: {e:?}");
        }
    }
    assert_eq!(seen.len(), total, "no extension may be declared twice");
}

// ---------------------------------------------------------------------------
// AC-68-3 — file-type.ts(正本)との突き合わせ(契約6)
// ---------------------------------------------------------------------------

/// 分類 → 宣言の `name`。video は `video-viewing.ts` の `INLINE_EXTENSIONS` と重ねる。
fn expected_from_file_type_ts() -> Vec<(&'static str, BTreeSet<String>)> {
    let inline = ts_string_list(VIDEO_VIEWING_TS, "const INLINE_EXTENSIONS = [", "]");
    let video: BTreeSet<String> = extension_set("VIDEO_EXTENSIONS")
        .intersection(&inline)
        .cloned()
        .collect();
    vec![
        ("Markdown", extension_set("MARKDOWN_EXTENSIONS")),
        ("HTML", extension_set("HTML_EXTENSIONS")),
        ("Image", extension_set("IMAGE_EXTENSIONS")),
        ("3D Model", extension_set("MODEL3D_EXTENSIONS")),
        ("Video", video),
        ("Audio", extension_set("AUDIO_EXTENSIONS")),
        ("PDF", extension_set("PDF_EXTENSIONS")),
    ]
}

#[test]
fn ac68_3_declared_ext_mirror_file_type_ts() {
    let all = associations();
    for (name, expected) in expected_from_file_type_ts() {
        let a = association(&all, name);
        assert_eq!(
            ext_set(a),
            expected,
            "{name}: ext must equal the set derived from src/lib/file-type.ts (正本)"
        );
    }
    // text 分類は拡張子を列挙しない(public.text で受ける)。`Text` の `txt` は bundler のための
    // 飾り(判断 (l))で、file-type.ts ではどの集合にも無い=text 分類であることを確かめる。
    assert_eq!(ext_set(association(&all, "Text")), set(&["txt"]));
    for name in [
        "MARKDOWN_EXTENSIONS",
        "HTML_EXTENSIONS",
        "IMAGE_EXTENSIONS",
        "MODEL3D_EXTENSIONS",
        "VIDEO_EXTENSIONS",
        "AUDIO_EXTENSIONS",
        "PDF_EXTENSIONS",
        "BINARY_EXTENSIONS",
    ] {
        assert!(
            !extension_set(name).contains("txt"),
            "txt must stay in file-type.ts's text classification (not in {name})"
        );
    }
}

#[test]
fn ac68_3_no_binary_extension_and_no_mkv_avi_is_declared() {
    let all = associations();
    let declared: BTreeSet<String> = all.iter().flat_map(ext_set).collect();
    let binary = extension_set("BINARY_EXTENSIONS");
    let overlap: Vec<&String> = declared.intersection(&binary).collect();
    assert!(overlap.is_empty(), "BINARY_EXTENSIONS must not be declared: {overlap:?}");
    for ext in ["mkv", "avi"] {
        assert!(!declared.contains(ext), "{ext} cannot be viewed inline and must not be declared");
    }
}

/// file-type.ts に分類が増えたら(新しい `*_EXTENSIONS` の Set)ここが赤になり、宣言の見直しを促す。
#[test]
fn ac68_3_file_type_ts_categories_are_all_accounted_for() {
    let names: BTreeSet<String> = FILE_TYPE_TS
        .lines()
        .filter_map(|line| {
            let decl = line.trim_start().strip_prefix("const ")?;
            let (name, _) = decl.split_once(" = new Set([")?;
            name.ends_with("_EXTENSIONS").then(|| name.to_string())
        })
        .collect();
    assert_eq!(
        names,
        set(&[
            "MARKDOWN_EXTENSIONS",
            "HTML_EXTENSIONS",
            "IMAGE_EXTENSIONS",
            "MODEL3D_EXTENSIONS",
            "VIDEO_EXTENSIONS",
            "AUDIO_EXTENSIONS",
            "PDF_EXTENSIONS",
            "BINARY_EXTENSIONS",
        ]),
        "a new category in file-type.ts needs a matching fileAssociations item (契約6)"
    );
}

// ---------------------------------------------------------------------------
// AC-68-4 — opened_file_uris(契約3・4・起案時判断 (e))
// ---------------------------------------------------------------------------

#[test]
fn ac68_4_decodes_percent_encoding_and_canonicalizes() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let file = make_file(tmp.path(), "My Notes/日 本.md");
    let url = Url::from_file_path(&file).expect("absolute path → file URL");
    assert!(url.as_str().contains('%'), "precondition: NSURL-style URL is percent-encoded");

    let canonical = file.canonicalize().expect("canonicalize");
    let got = opened_file_uris(&[url]);
    assert_eq!(got, vec![file_uri(&canonical)]);
    assert!(!got[0].contains('%'), "percent-encoding must be decoded: {}", got[0]);
    assert!(got[0].ends_with("/My Notes/日 本.md"), "{}", got[0]);
}

#[cfg(unix)]
#[test]
fn ac68_4_canonicalizes_through_a_symlink_like_the_cli() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path().canonicalize().expect("canonicalize tempdir");
    let real = make_file(&dir, "real.md");
    let link = dir.join("link.md");
    std::os::unix::fs::symlink(&real, &link).expect("symlink");

    let got = opened_file_uris(&[Url::from_file_path(&link).unwrap()]);
    assert_eq!(got, vec![file_uri(&real)], "same form as resolve_path_to_uri (canonicalized)");
}

#[test]
fn ac68_4_keeps_the_order_of_multiple_urls() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path().canonicalize().expect("canonicalize tempdir");
    let a = make_file(&dir, "a.md");
    let b = make_file(&dir, "b.png");
    let c = make_file(&dir, "c.pdf");
    let urls: Vec<Url> = [&a, &b, &c]
        .iter()
        .map(|p| Url::from_file_path(p).unwrap())
        .collect();

    assert_eq!(
        opened_file_uris(&urls),
        vec![file_uri(&a), file_uri(&b), file_uri(&c)]
    );
    let reversed: Vec<Url> = urls.iter().rev().cloned().collect();
    assert_eq!(
        opened_file_uris(&reversed),
        vec![file_uri(&c), file_uri(&b), file_uri(&a)]
    );
}

#[test]
fn ac68_4_drops_non_file_schemes() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path().canonicalize().expect("canonicalize tempdir");
    let a = make_file(&dir, "a.md");
    let urls = vec![
        Url::parse("https://example.com/notes.md").unwrap(),
        Url::from_file_path(&a).unwrap(),
        Url::parse("ssh://alice@host/notes/x.md").unwrap(),
        Url::parse("vellis-asset://localhost/a.md").unwrap(),
    ];
    assert_eq!(opened_file_uris(&urls), vec![file_uri(&a)]);
    assert!(
        opened_file_uris(&[Url::parse("https://example.com/x.md").unwrap()]).is_empty(),
        "a lone non-file URL yields nothing"
    );
}

#[test]
fn ac68_4_drops_directories_but_keeps_files() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path().canonicalize().expect("canonicalize tempdir");
    let a = make_file(&dir, "docs/a.md");
    let sub = dir.join("docs");
    let other_dir = dir.join("empty");
    std::fs::create_dir_all(&other_dir).unwrap();

    let urls = vec![
        Url::from_directory_path(&sub).unwrap(),
        Url::from_file_path(&a).unwrap(),
        Url::from_file_path(&other_dir).unwrap(),
    ];
    assert_eq!(opened_file_uris(&urls), vec![file_uri(&a)], "folders are dropped silently");
    assert!(
        opened_file_uris(&[Url::from_directory_path(&dir).unwrap()]).is_empty(),
        "a lone folder yields nothing"
    );
}

#[test]
fn ac68_4_keeps_missing_files() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path().canonicalize().expect("canonicalize tempdir");
    let missing = dir.join("missing.md");
    assert!(!missing.exists());
    assert_eq!(
        opened_file_uris(&[Url::from_file_path(&missing).unwrap()]),
        vec![file_uri(&missing)],
        "a missing file is left to the window's own error (same as `vellis <missing>`)"
    );
}

#[test]
fn ac68_4_empty_input_is_empty() {
    assert!(opened_file_uris(&[]).is_empty());
}

// ---------------------------------------------------------------------------
// AC-68-5 — plan_initial_open(契約3・4・5)
// ---------------------------------------------------------------------------

fn assert_argless(args: &WindowArgs) {
    assert!(args.needs_root_selection(), "initial window must stay argument-less");
    assert!(args.initial_path.is_none());
    assert!(args.root.is_none());
}

#[test]
fn ac68_5_argless_initial_takes_the_first_and_the_rest_go_to_new_windows() {
    let (a, b, c) = (fake_file_uri("a.md"), fake_file_uri("b.md"), fake_file_uri("c.md"));
    let (initial, rest) =
        plan_initial_open(WindowArgs::default(), vec![a.clone(), b.clone(), c.clone()]);
    assert_eq!(initial.initial_path.as_deref(), Some(a.as_str()));
    assert!(initial.root.is_none(), "root is derived from the parent by init_window");
    assert!(!initial.show_marks);
    assert!(!initial.show_changed);
    assert!(initial.expanded_dirs.is_empty());
    assert_eq!(rest, vec![b, c]);
}

#[test]
fn ac68_5_argless_initial_with_nothing_opened_stays_argless() {
    let (initial, rest) = plan_initial_open(WindowArgs::default(), vec![]);
    assert_argless(&initial);
    assert!(rest.is_empty());
}

#[test]
fn ac68_5_initial_with_cli_path_is_left_alone() {
    let cli = WindowArgs {
        initial_path: Some(fake_file_uri("cli.md")),
        ..WindowArgs::default()
    };
    let a = fake_file_uri("a.md");
    let (initial, rest) = plan_initial_open(cli.clone(), vec![a.clone()]);
    assert_eq!(initial.initial_path, cli.initial_path);
    assert!(initial.root.is_none());
    assert_eq!(rest, vec![a]);
}

#[test]
fn ac68_5_initial_with_cli_root_is_left_alone() {
    let cli = WindowArgs {
        root: Some("file:///req68-does-not-exist/notes".to_string()),
        ..WindowArgs::default()
    };
    let (a, b) = (fake_file_uri("a.md"), fake_file_uri("b.md"));
    let (initial, rest) = plan_initial_open(cli.clone(), vec![a.clone(), b.clone()]);
    assert_eq!(initial.root, cli.root);
    assert!(initial.initial_path.is_none());
    assert_eq!(rest, vec![a, b]);
}

#[test]
fn ac68_5_sidebar_flags_survive_taking_the_first_file() {
    let flagged = WindowArgs {
        show_marks: true,
        show_changed: true,
        ..WindowArgs::default()
    };
    assert!(flagged.needs_root_selection(), "precondition: `vellis --changed` is argument-less");
    let a = fake_file_uri("a.md");
    let (initial, rest) = plan_initial_open(flagged, vec![a.clone()]);
    assert_eq!(initial.initial_path.as_deref(), Some(a.as_str()));
    assert!(initial.show_marks, "show_marks must be kept");
    assert!(initial.show_changed, "show_changed must be kept");
    assert!(rest.is_empty());
}

// ---------------------------------------------------------------------------
// AC-68-6 — PendingOpens(契約3)
// ---------------------------------------------------------------------------

#[test]
fn ac68_6_receive_before_setup_buffers_and_returns_empty() {
    let pending = PendingOpens::default();
    assert!(pending.receive(vec![fake_file_uri("a.md")]).is_empty());
    assert!(pending.receive(vec![fake_file_uri("b.md"), fake_file_uri("c.md")]).is_empty());
    assert!(pending.receive(vec![]).is_empty());
}

#[test]
fn ac68_6_take_at_setup_returns_everything_in_arrival_order_then_passes_through() {
    let pending = PendingOpens::default();
    let (a, b, c, d) = (
        fake_file_uri("a.md"),
        fake_file_uri("b.md"),
        fake_file_uri("c.md"),
        fake_file_uri("d.md"),
    );
    pending.receive(vec![a.clone()]);
    pending.receive(vec![b.clone(), c.clone()]);
    assert_eq!(pending.take_at_setup(), vec![a, b, c], "buffered across two receives, in order");

    assert_eq!(pending.receive(vec![d.clone()]), vec![d], "after setup: pass-through");
    assert!(pending.receive(vec![]).is_empty());
    assert!(pending.take_at_setup().is_empty(), "nothing is buffered after setup");
}

#[test]
fn ac68_6_second_take_at_setup_is_empty() {
    let pending = PendingOpens::default();
    pending.receive(vec![fake_file_uri("a.md")]);
    assert_eq!(pending.take_at_setup().len(), 1);
    assert!(pending.take_at_setup().is_empty());
    assert!(pending.take_at_setup().is_empty());
}

#[test]
fn ac68_6_take_at_setup_without_any_receive_is_empty_and_switches_to_pass_through() {
    let pending = PendingOpens::default();
    assert!(pending.take_at_setup().is_empty());
    let a = fake_file_uri("a.md");
    assert_eq!(pending.receive(vec![a.clone()]), vec![a]);
}

/// `Builder::manage` に渡せる(`Send + Sync + 'static`)ことと `&self` で動くことの型レベル確認。
#[test]
fn ac68_6_pending_opens_is_manageable_state() {
    fn assert_manageable<T: Send + Sync + 'static>(_: &T) {}
    let pending = PendingOpens::default();
    assert_manageable(&pending);
    let shared: &PendingOpens = &pending;
    assert!(shared.receive(vec![fake_file_uri("a.md")]).is_empty());
    assert_eq!(shared.take_at_setup().len(), 1);
}

// ---------------------------------------------------------------------------
// AC-68-7 — 配線(ソース走査・行コメントを除く)(契約3・4)
// ---------------------------------------------------------------------------

#[test]
fn ac68_7_opened_branch_is_in_lib_rs_under_macos_cfg() {
    let code = lib_rs_code();
    let pos = code
        .find("RunEvent::Opened")
        .expect("lib.rs must handle RunEvent::Opened");
    let before = &code[..pos];
    let attr_start = before
        .rfind("#[cfg(")
        .expect("RunEvent::Opened must be preceded by a #[cfg(...)] attribute");
    let attr_end = before[attr_start..].find(")]").expect("attribute must close") + attr_start + 2;
    let attr: String = before[attr_start..attr_end].split_whitespace().collect();
    assert_eq!(
        attr, r##"#[cfg(target_os="macos")]"##,
        "the nearest #[cfg] before RunEvent::Opened must be target_os = \"macos\""
    );
    // 属性と分岐の間に別の腕(`=>`)や文(`;`)が挟まると、その cfg は別のものに付いている。
    let gap = &before[attr_end..];
    assert!(
        !gap.contains("=>") && !gap.contains(';') && gap.len() <= 120,
        "the #[cfg(target_os = \"macos\")] must sit right on the Opened branch (gap: {gap:?})"
    );
}

#[test]
fn ac68_7_opened_branch_runs_in_the_normal_launch_callback_not_in_self_check() {
    let code = lib_rs_code();
    let fns = fn_bodies(&code);

    let self_check_pos = code
        .find("if is_self_check {")
        .expect("lib.rs must keep the `if is_self_check {` split of the launch (要件72)");
    let self_check_block = balanced_block(&code, self_check_pos);
    assert!(
        !self_check_block.contains("Opened") && !self_check_block.contains("opened_file_uris"),
        "the self-check launch must not handle Opened"
    );

    let block_start = self_check_block.as_ptr() as usize - code.as_ptr() as usize;
    let after = block_start + self_check_block.len();
    let else_rel = code[after..].find("else").expect("`if is_self_check {…}` must have an else");
    let else_block = balanced_block(&code, after + else_rel);
    assert!(else_block.contains(".run("), "the normal launch must call App::run in the else branch");
    assert!(
        reaches(else_block, &fns, "RunEvent::Opened"),
        "the normal launch's run callback must handle RunEvent::Opened (directly or via a lib.rs fn)"
    );
    assert!(
        !else_block.contains("|_, _| {}"),
        "the normal launch's run callback must not be the inert `|_, _| {{}}`"
    );
}

#[test]
fn ac68_7_opened_branch_reaches_open_with_receive_and_dispatch_command() {
    let code = lib_rs_code();
    let open_with = open_with_code();
    // 辿る先は lib.rs と open_with.rs の自由関数(ヘルパをどちらに置いても届く)。
    let mut fns = fn_bodies(&code);
    fns.extend(fn_bodies(&open_with));

    let pos = code.find("RunEvent::Opened").expect("lib.rs must handle RunEvent::Opened");
    let branch = enclosing_block(&code, pos);
    for needle in ["opened_file_uris", "receive(", "Request::OpenPath", "dispatch_command"] {
        assert!(
            reaches(branch, &fns, needle),
            "the Opened branch must reach {needle} (契約4: same road as the CLI's OpenPath)"
        );
    }
    assert!(
        !reaches(branch, &fns, "WebviewWindowBuilder"),
        "the Opened branch must not build windows itself"
    );
}

#[test]
fn ac68_7_setup_takes_pending_opens_and_plans_before_registering_main() {
    let code = lib_rs_code();
    let setup_pos = code.find(".setup(").expect("lib.rs must have .setup(");
    let setup = balanced_block(&code, setup_pos);
    let take = setup
        .find("take_at_setup")
        .expect("setup must call PendingOpens::take_at_setup");
    let plan = setup
        .find("plan_initial_open")
        .expect("setup must call plan_initial_open");
    let main = setup
        .find("register_window(\"main\"")
        .expect("setup must register the initial window \"main\"");
    assert!(take < plan, "take_at_setup must come before plan_initial_open");
    assert!(plan < main, "plan_initial_open must come before register_window(\"main\", …)");
}

#[test]
fn ac68_7_pending_opens_is_managed_on_the_builder_before_setup() {
    let code = lib_rs_code();
    let setup_pos = code.find(".setup(").expect("lib.rs must have .setup(");
    let mut managed_at = None;
    let mut from = 0;
    while let Some(i) = code[from..].find(".manage(") {
        let at = from + i;
        let arg = balanced(&code, at + ".manage".len(), '(', ')');
        if arg.contains("PendingOpens") {
            managed_at = Some(at);
            break;
        }
        from = at + ".manage(".len();
    }
    let at = managed_at.expect("lib.rs must `.manage(PendingOpens…)`");
    assert!(
        at < setup_pos,
        "PendingOpens must be managed on the Builder (before .setup) so an Opened arriving before setup finds it"
    );
}

#[test]
fn ac68_7_no_run_generate_context_and_open_with_builds_no_window() {
    let code = lib_rs_code();
    let compact: String = code.split_whitespace().collect();
    assert!(
        !compact.contains(".run(tauri::generate_context!())") && !compact.contains(".run(generate_context!())"),
        "lib.rs must build the app and run it with a callback"
    );

    let mod_rs = strip_line_comments(&read_source("src/window/mod.rs"));
    assert!(mod_rs.contains("pub mod open_with;"), "window/mod.rs must export open_with");

    let open_with = open_with_code();
    assert!(
        !open_with.contains("WebviewWindowBuilder"),
        "window/open_with.rs must not build windows (handle_open_path does)"
    );
    assert!(
        !open_with.contains("cfg(target_os"),
        "window/open_with.rs compiles on every platform; the macOS cfg lives on the Opened branch in lib.rs only"
    );
}

// ---------------------------------------------------------------------------
// AC-68-8 — 不変: 依存の追加なし(契約7)
// ---------------------------------------------------------------------------

#[test]
fn ac68_8_cargo_dependencies_are_unchanged() {
    assert_eq!(
        cargo_section_keys("[dependencies]"),
        set(&[
            "tauri",
            "tauri-plugin-opener",
            "serde",
            "serde_json",
            "clap",
            "thiserror",
            "tokio",
            "async-trait",
            "notify",
            "libc",
            "tracing",
            "tracing-subscriber",
            "mime_guess",
            "http",
            "percent-encoding",
            "tauri-plugin-dialog",
            "reqwest",
            "russh",
            "russh-sftp",
            "bytes",
            "dirs",
            "ulid",
            "chrono",
            "strsim",
            "sha2",
            "similar",
            "hidapi",
            "toml",
            "tauri-plugin-webdriver",
            "tauri-plugin-window-state",
        ])
    );
    assert_eq!(
        cargo_section_keys("[target.'cfg(target_os = \"macos\")'.dependencies]"),
        set(&["objc2", "objc2-app-kit", "objc2-foundation"])
    );
    assert_eq!(cargo_section_keys("[dev-dependencies]"), set(&["tempfile", "tauri", "muda"]));
    assert_eq!(cargo_section_keys("[build-dependencies]"), set(&["tauri-build", "chrono"]));
}
