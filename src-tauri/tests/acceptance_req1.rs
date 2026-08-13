//! 要件#1 の受け入れテスト(requirements.md #1)
//!
//! 「ファイルツリーに Markdown 以外も含む全ファイルを表示する(現行は md/markdown/mdx のみ)」
//! 受け入れ基準: fs の list が混在フィクスチャ(md・txt・json・画像等)で全ファイルを列挙する。
//!
//! 前提:
//! - `FileProvider::list` は非再帰(単一ディレクトリの列挙)。サブディレクトリ配下の
//!   ファイルは、そのサブディレクトリの URI に対して list を呼んで検証する。
//! - 隠しファイル(ドットファイル)の扱いは現行仕様踏襲のため、フィクスチャに含めず
//!   assert もしない。

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use tempfile::TempDir;

use vellis_lib::fs::entry::FileKind;
use vellis_lib::fs::local::LocalProvider;
use vellis_lib::fs::provider::FileProvider;
use vellis_lib::fs::uri::Uri;

/// 既存ユニットテスト(src/fs/local.rs)と同じ流儀で file:// URI を直接構築する。
fn make_uri(path: &Path) -> Uri {
    Uri {
        scheme: "file".into(),
        authority: None,
        path: path.to_path_buf(),
        raw: format!("file://{}", path.display()),
    }
}

/// list の結果からエントリ名の集合を得る。
fn names_of(entries: &[vellis_lib::fs::entry::Entry]) -> BTreeSet<String> {
    entries.iter().map(|e| e.name.clone()).collect()
}

/// 混在フィクスチャ(md・markdown・mdx・txt・json・png + サブディレクトリ)で、
/// list が「全ファイル+ディレクトリ」を過不足なく列挙することを assert する。
#[tokio::test]
async fn list_enumerates_all_files_in_mixed_fixture() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();

    fs::write(root.join("readme.md"), "# Hello").unwrap();
    fs::write(root.join("notes.markdown"), "# Notes").unwrap();
    fs::write(root.join("design.mdx"), "# Design").unwrap();
    fs::write(root.join("memo.txt"), "plain text").unwrap();
    fs::write(root.join("data.json"), "{}").unwrap();
    fs::write(root.join("image.png"), [0u8; 16]).unwrap();
    fs::create_dir(root.join("assets")).unwrap();

    let provider = LocalProvider::new();
    let entries = provider.list(&make_uri(root)).await.unwrap();

    let expected: BTreeSet<String> = [
        "assets",
        "readme.md",
        "notes.markdown",
        "design.mdx",
        "memo.txt",
        "data.json",
        "image.png",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();

    assert_eq!(
        names_of(&entries),
        expected,
        "list must enumerate every file (not just Markdown) plus the sub-directory"
    );

    // 種別の検証: ディレクトリは Dir、それ以外はすべて File
    for entry in &entries {
        if entry.name == "assets" {
            assert_eq!(entry.kind, FileKind::Dir, "assets must be listed as Dir");
        } else {
            assert_eq!(
                entry.kind,
                FileKind::File,
                "{} must be listed as File",
                entry.name
            );
        }
    }
}

/// 任意拡張子(py・tar.gz・csv)および拡張子なし(Makefile・LICENSE)のファイルも
/// list に含まれることを assert する。
#[tokio::test]
async fn list_includes_arbitrary_and_missing_extensions() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();

    fs::write(root.join("script.py"), "print('hi')").unwrap();
    fs::write(root.join("archive.tar.gz"), [0u8; 8]).unwrap();
    fs::write(root.join("table.csv"), "a,b,c").unwrap();
    fs::write(root.join("Makefile"), "all:\n").unwrap();
    fs::write(root.join("LICENSE"), "MIT").unwrap();

    let provider = LocalProvider::new();
    let entries = provider.list(&make_uri(root)).await.unwrap();

    let names = names_of(&entries);
    for expected in ["script.py", "archive.tar.gz", "table.csv", "Makefile", "LICENSE"] {
        assert!(
            names.contains(expected),
            "list must include {:?} (got: {:?})",
            expected,
            names
        );
    }
    assert_eq!(entries.len(), 5, "exactly the 5 fixture files must be listed");
}

/// サブディレクトリの URI に対する list も、Markdown 以外を含む全ファイルを
/// 列挙することを assert する(list は非再帰のため個別に呼ぶ)。
#[tokio::test]
async fn list_enumerates_all_files_in_subdirectory() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    let sub = root.join("docs");
    fs::create_dir(&sub).unwrap();

    fs::write(sub.join("page.md"), "# Page").unwrap();
    fs::write(sub.join("style.css"), "body {}").unwrap();
    fs::write(sub.join("diagram.svg"), "<svg/>").unwrap();

    let provider = LocalProvider::new();

    // ルート側: サブディレクトリ自体は Dir として現れる
    let root_entries = provider.list(&make_uri(root)).await.unwrap();
    assert!(
        root_entries
            .iter()
            .any(|e| e.name == "docs" && e.kind == FileKind::Dir),
        "docs must be listed as Dir in the root listing"
    );

    // サブディレクトリ側: md も非 md も全件列挙される
    let sub_entries = provider.list(&make_uri(&sub)).await.unwrap();
    let expected: BTreeSet<String> = ["page.md", "style.css", "diagram.svg"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(
        names_of(&sub_entries),
        expected,
        "list on the sub-directory must enumerate every file, not just Markdown"
    );
}
