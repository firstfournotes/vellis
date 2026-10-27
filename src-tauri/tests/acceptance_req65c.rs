//! 要件#65 追補c の受け入れテスト(docs/requirements/req-65.md「追補c 末尾が `/` の除外を、
//! `/` を外したのと同じに当てる」・Issue #585=backlog 215)— AC-65-追c (a)〜(c)
//!
//! 発端: `files.exclude` に `docs/` のように末尾が `/` の glob を書くと、`exclude.rs` の
//! `glob_match` が `split('/')` で空の要素を作るので何にも当たらない。Cursor や `.gitignore`
//! から写す人がつまずきうる(要件#65 の reviewer P3)。
//!
//! 契約(追補c):
//! 1. 除外の glob の末尾の `/`(1つ以上)は外してから照合する。`docs/` は `docs` と、`**/build/` は
//!    `**/build` と同じに当たる(当たったフォルダの下も今までどおり除く=`path_or_ancestor_matches`)
//! 2. `.gitignore` の「末尾の `/` はフォルダにだけ当てる」は採らない(照合はパスの文字列だけで、
//!    種類を見ていない。`docs` という名前のファイルにも当たる)
//! 3. 不変: 末尾以外の `/` の扱い・`**`・`*`・`?`・既定値・大文字と小文字
//!
//! 判定範囲:
//! - (a) `docs/` は `docs` と同じ: `glob_match("docs/", "docs")` が当たり、`docs/a.md` は祖先の規則
//!   (`path_or_ancestor_matches`)で除かれる。`docs` と答えが揃う(当たらないものも同じ)
//! - (b) `**/build/` は `**/build` と同じ: `x/build` に当たり、`x/build/y` は祖先の規則で除かれる
//! - (c) `docs//`(2つ以上)も `docs` と同じ。`/` だけ・`//`・空の glob は何にも当たらない(今のまま)
//! - 契約 2・3 の不変: 末尾以外の `/`(先頭・途中)・`**`・`*`・`?`・大文字小文字は変わらない。
//!   設定経由(`is_hidden_from_tree`)でも `docs/` がツリーから隠す(Issue #585 の使い方そのもの)
//! - (d) 既存の要件#65 の受け入れテスト(`acceptance_req65.rs` ほか)は無改変で緑=本ファイルの外
//!   (同じ周回のフルスイートで確かめる)
//!
//! 注(test-writer 2026-10-19): AC-65-追c (a)(b) の字面は `glob_match("docs/", "docs/a.md")` が
//! 「当たる(`docs` と同じ)」と書くが、`glob_match` は path 全体の照合で `glob_match("docs", "docs/a.md")`
//! は今も false(配下は `path_or_ancestor_matches` が除く=acceptance_req65.rs の 8)。契約 1 の
//! 「`/` を外してから照合する=`docs` と同じ」に従い、配下のケースは `path_or_ancestor_matches`
//! で表した(`glob_match` は `docs` と答えが揃うことを見る)。
//!
//! ## 確定契約(implementer はこれに従う=公開 API は不変)
//!
//! ```ignore
//! // src-tauri/src/exclude.rs — シグネチャは今のまま。pattern の末尾の `/`(1つ以上)を外してから
//! // 今までどおり照合する。外した結果が空(`/` だけ・`//`)なら、空の glob と同じく何にも当たらない。
//! pub fn glob_match(pattern: &str, rel_path: &str) -> bool;
//! pub fn path_or_ancestor_matches(patterns: &[&str], rel_path: &str) -> bool;  // 不変
//! ```

use vellis_lib::exclude::{glob_match, is_hidden_from_tree, path_or_ancestor_matches};
use vellis_lib::settings::{ExcludeMap, Settings};

// ---------------------------------------------------------------------------
// 補助(acceptance_req65.rs の `assert_glob_table` の写し)
// ---------------------------------------------------------------------------

fn assert_glob_table(cases: &[(&str, &str, bool)]) {
    for (pattern, path, expected) in cases {
        assert_eq!(
            glob_match(pattern, path),
            *expected,
            "glob_match({pattern:?}, {path:?}) must be {expected}"
        );
    }
}

/// `with_slash` と `without` が、`glob_match` でも `path_or_ancestor_matches` でも同じ答えになる。
fn assert_same_as(with_slash: &str, without: &str, paths: &[&str]) {
    for path in paths {
        assert_eq!(
            glob_match(with_slash, path),
            glob_match(without, path),
            "glob_match({with_slash:?}, {path:?}) must equal glob_match({without:?}, {path:?})"
        );
        assert_eq!(
            path_or_ancestor_matches(&[with_slash], path),
            path_or_ancestor_matches(&[without], path),
            "path_or_ancestor_matches([{with_slash:?}], {path:?}) must equal the pattern without the slash"
        );
    }
}

/// 何にも当たらない: `glob_match` でも祖先の規則でも、どのパスにも当たらない。
fn assert_matches_nothing(pattern: &str, paths: &[&str]) {
    for path in paths {
        assert!(
            !glob_match(pattern, path),
            "glob_match({pattern:?}, {path:?}) must be false"
        );
        assert!(
            !path_or_ancestor_matches(&[pattern], path),
            "path_or_ancestor_matches([{pattern:?}], {path:?}) must be false"
        );
    }
}

const SAMPLE_PATHS: &[&str] = &[
    "docs",
    "docs/a.md",
    "docs/sub/b.md",
    "docsx",
    "doc",
    "docs.md",
    "other/docs",
    "other/docs/a.md",
    "a",
    ".git",
    "x/y/z",
    "build",
    "x/build",
    "x/build/y",
    "x/builds",
];

// ---------------------------------------------------------------------------
// (a) `docs/` は `docs` と同じ
// ---------------------------------------------------------------------------

/// 1. `docs/` はフォルダ(またはファイル)`docs` 自身に当たり、`docs/a.md` は配下として除かれる。
///    `docs` と同じ(契約 1)。種類は見ない=`docs` という名前のファイルにも当たる(契約 2)。
#[test]
fn ac65c_a_trailing_slash_matches_the_name_itself_and_covers_what_is_below() {
    assert_glob_table(&[("docs/", "docs", true), ("docs", "docs", true)]);
    assert!(
        path_or_ancestor_matches(&["docs/"], "docs"),
        "docs/ must exclude docs itself"
    );
    assert!(
        path_or_ancestor_matches(&["docs/"], "docs/a.md"),
        "docs/ must exclude what is below docs (like docs does)"
    );
    assert!(
        path_or_ancestor_matches(&["docs/"], "docs/sub/b.md"),
        "docs/ must exclude deeper paths below docs too"
    );
}

/// 2. `docs/` が当たらないものは `docs` と同じ: 前方一致・部分一致・root 以外の `docs`。
#[test]
fn ac65c_a_trailing_slash_does_not_match_more_than_the_bare_pattern() {
    assert_glob_table(&[
        ("docs/", "docsx", false),
        ("docs/", "doc", false),
        ("docs/", "docs.md", false),
        ("docs/", "other/docs", false),
    ]);
    assert!(
        !path_or_ancestor_matches(&["docs/"], "other/docs/a.md"),
        "patterns stay anchored at the root"
    );
}

/// 3. `docs/` と `docs` は、`glob_match` でも祖先の規則でも、どのパスでも同じ答え。
#[test]
fn ac65c_a_trailing_slash_gives_the_same_answers_as_the_bare_pattern() {
    assert_same_as("docs/", "docs", SAMPLE_PATHS);
    assert_same_as("*.md/", "*.md", SAMPLE_PATHS);
    assert_same_as("**/.*/", "**/.*", SAMPLE_PATHS);
}

// ---------------------------------------------------------------------------
// (b) `**/build/` は `**/build` と同じ
// ---------------------------------------------------------------------------

/// 4. `**/build/` はどの深さの `build` にも当たり、`x/build/y` は配下として除かれる。
#[test]
fn ac65c_b_double_star_with_trailing_slash_matches_at_any_depth_and_covers_below() {
    assert_glob_table(&[
        ("**/build/", "x/build", true),
        ("**/build/", "build", true),
        ("**/build/", "a/b/build", true),
        ("**/build/", "x/builds", false),
        ("**/build/", "x/build.md", false),
    ]);
    assert!(
        path_or_ancestor_matches(&["**/build/"], "x/build/y"),
        "**/build/ must exclude what is below x/build (like **/build does)"
    );
    assert!(
        path_or_ancestor_matches(&["**/build/"], "x/build"),
        "**/build/ must exclude x/build itself"
    );
    assert_same_as("**/build/", "**/build", SAMPLE_PATHS);
}

// ---------------------------------------------------------------------------
// (c) `docs//` も `docs` と同じ・`/` だけ・空の glob は何にも当たらない(今のまま)
// ---------------------------------------------------------------------------

/// 5. 末尾の `/` が 2 つ以上でも `docs` と同じ(契約 1 の「1つ以上」)。
#[test]
fn ac65c_c_several_trailing_slashes_are_the_same_as_one() {
    assert_glob_table(&[
        ("docs//", "docs", true),
        ("docs///", "docs", true),
        ("docs//", "docsx", false),
        ("**/build//", "x/build", true),
    ]);
    assert!(path_or_ancestor_matches(&["docs//"], "docs/a.md"));
    assert_same_as("docs//", "docs", SAMPLE_PATHS);
    assert_same_as("docs///", "docs", SAMPLE_PATHS);
}

/// 6. `/` だけ・`//`・空の glob は何にも当たらない(今のまま)。`/` を外して空になっても
///    「全部に当たる」にはならない。
#[test]
fn ac65c_c_slash_only_and_empty_globs_match_nothing() {
    for pattern in ["/", "//", "///", ""] {
        assert_matches_nothing(pattern, SAMPLE_PATHS);
    }
}

// ---------------------------------------------------------------------------
// 契約 2・3 の不変 — 末尾以外の `/`・`**`・`*`・`?`・大文字小文字は変わらない
// ---------------------------------------------------------------------------

/// 7. 先頭や途中の `/` は今までどおり(外さない): `/docs` は `docs` に当たらず、`a//b` は `a/b` に当たらない。
#[test]
fn ac65c_leading_and_inner_slashes_are_untouched() {
    assert_glob_table(&[
        ("/docs", "docs", false),
        ("a//b", "a/b", false),
        ("a/b", "a/b", true),
        ("a/b/", "a/b", true),
        ("/docs/", "docs", false),
    ]);
    assert!(
        !path_or_ancestor_matches(&["/docs"], "docs/a.md"),
        "a leading slash is not stripped"
    );
}

/// 8. `/` を外したあとの照合は今までどおり: `**`・`*`・`?`・大文字小文字(AC-65-1 の形を `/` 付きで)。
#[test]
fn ac65c_matching_after_the_slash_is_stripped_is_unchanged() {
    assert_glob_table(&[
        ("**/node_modules/", "a/b/node_modules", true),
        ("**/node_modules/", "node_modules_x", false),
        ("*.log/", "a.log", true),
        ("*.log/", "sub/a.log", false),
        ("**/*.log/", "sub/a.log", true),
        ("docs/drafts/**/", "docs/drafts", true),
        ("docs/drafts/**/", "docs/drafts/x/y.md", true),
        ("?.md/", "a.md", true),
        ("?.md/", "ab.md", false),
        ("**/Build/", "build", false),
        ("**/build/", "Build", false),
        ("{a,b}.md/", "{a,b}.md", true),
        ("{a,b}.md/", "a.md", false),
    ]);
}

/// 9. 設定経由でも効く(Issue #585 の使い方そのもの): `files.exclude` に `docs/` と書くと
///    ツリーから `docs` と `docs/a.md` が隠れ、`docsx` は隠れない。`false` の行は効かない。
#[test]
fn ac65c_files_exclude_entry_with_a_trailing_slash_hides_the_folder_from_the_tree() {
    let settings = Settings {
        files_exclude: ExcludeMap::from([("docs/".to_string(), true)]),
        search_exclude: ExcludeMap::new(),
    };
    assert!(is_hidden_from_tree("docs", &settings), "docs/ hides docs");
    assert!(is_hidden_from_tree("docs/a.md", &settings), "docs/ hides docs/a.md");
    assert!(is_hidden_from_tree("docs/sub/b.md", &settings), "docs/ hides docs/sub/b.md");
    assert!(!is_hidden_from_tree("docsx", &settings), "docs/ does not hide docsx");
    assert!(!is_hidden_from_tree("other/docs", &settings), "docs/ stays anchored at the root");

    let disabled = Settings {
        files_exclude: ExcludeMap::from([("docs/".to_string(), false)]),
        search_exclude: ExcludeMap::new(),
    };
    assert!(!is_hidden_from_tree("docs", &disabled), "a false entry is off");
    assert!(!is_hidden_from_tree("docs/a.md", &disabled), "a false entry is off");
}
