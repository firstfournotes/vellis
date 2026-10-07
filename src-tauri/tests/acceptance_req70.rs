//! 要件#70 の受け入れテスト(docs/requirements/req-70.md)— Rust 側
//!
//! 「Explorer(ツリー)でシンボリックリンクの行がそれと分かるように表示する」。
//! ここは **一覧の行がリンクかどうかを運ぶ**側(契約1・2・3)を機械判定する:
//! `Entry` に足す省略できる項目 `link: Option<LinkInfo>` の値と JSON の形、`kind` /
//! `size` / 並び順が要件#31 のままであること、`stat` と除外(`filter_tree_entries_with`)
//! が `link` を壊さないこと、`Entry { … }` を組み立てる場所が増えていないこと。
//! 見た目(印・ツールチップ・リンク切れのクリック)は
//! `src/components/Explorer.symlink.wiring.test.ts`(AC-70-8〜11)。ssh の形は実サーバが
//! 要るので reviewer 照合と人間ゲート 5(JSON の形だけ AC-70-5 で `LinkInfo` 直接構築で見る)。
//!
//! ## 前提にする公開面(契約1・オーケストレーター判断 (l)(q)=implementer はこれに従う)
//! - `vellis_lib::fs::entry::LinkInfo { target: Option<String>, broken: bool }`
//!   (`Clone`・`Debug`・`Serialize`・`PartialEq`)
//! - `vellis_lib::fs::entry::Entry` に `pub link: Option<LinkInfo>`(`skip_serializing_if` で
//!   `None` のときキーを出さない。`LinkInfo.target` も `None` のときキーを出さない)
//! - `LocalProvider::list`: リンクの行に `read_link` の文字列そのまま(正規化しない)の
//!   `target` と、辿れたかの `broken` を付ける。リンクでない行は `link: None`
//! - `LocalProvider::stat`: 今のまま(辿った先の `kind`)で `link` は `None`
//! - `exclude::filter_tree_entries_with`: 行を選ぶだけで中身を変えない
//!
//! ## 判定範囲(AC 番号は req-70.md の受け入れ基準)
//! - AC-70-1 ファイルへのリンク・フォルダへのリンクの `kind` / `size` / `link` / 並び順
//! - AC-70-2 リンク切れ・自分を指すリンク=`Symlink` + `broken: true`・一覧は成功する
//! - AC-70-3 `target` は `read_link` そのまま(相対は相対・絶対は絶対・リンクのリンクは 1 段目)
//! - AC-70-4 普通のファイル・フォルダは `link: None`
//! - AC-70-5 JSON の形(`serde_json::to_value`)
//! - AC-70-6 `stat` は辿った先の `kind`・`link: None`
//! - AC-70-7 除外を通しても `link` は同じ・`Entry { … }` の組み立て場所は 3 ファイルだけ
//! - AC-70-13 は本ファイルではなく既存 3 ファイルへの `link: None,` 追記(承認済みの要件側更新)
//!
//! ## 判定しないもの
//! - ssh の `list`(`{"broken": false}` の付与)→ reviewer 照合・人間ゲート 5
//! - 権限で辿れないリンク(`broken: true` の第 3 の経路)→ 実行ユーザーが root だと再現しないため
//!   機械判定しない(契約1 の文面で reviewer 照合)

// symlink 作成は Unix API 前提(macOS で実行。acceptance_req31.rs と同じ)。
#![cfg(unix)]

use std::collections::BTreeSet;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tempfile::TempDir;

use vellis_lib::exclude::filter_tree_entries_with;
use vellis_lib::fs::entry::{Entry, FileKind, LinkInfo};
use vellis_lib::fs::local::LocalProvider;
use vellis_lib::fs::provider::FileProvider;
use vellis_lib::fs::uri::Uri;
use vellis_lib::settings::Settings;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// acceptance_req31.rs と同じ流儀で file:// URI を直接構築する。
fn make_uri(path: &Path) -> Uri {
    Uri {
        scheme: "file".into(),
        authority: None,
        path: path.to_path_buf(),
        raw: format!("file://{}", path.display()),
    }
}

fn names_in_order(entries: &[Entry]) -> Vec<String> {
    entries.iter().map(|e| e.name.clone()).collect()
}

/// 名前でエントリを探す(見つからなければ panic=一覧に出ること自体も検証)。
fn find<'a>(entries: &'a [Entry], name: &str) -> &'a Entry {
    entries
        .iter()
        .find(|e| e.name == name)
        .unwrap_or_else(|| panic!("entry {:?} must be listed (got: {:?})", name, names_in_order(entries)))
}

/// 辿れるリンクの `link` の期待値(`target` は作ったときの文字列そのまま)。
fn ok_link(target: &str) -> Option<LinkInfo> {
    Some(LinkInfo { target: Some(target.to_string()), broken: false })
}

/// リンク切れの `link` の期待値。
fn broken_link(target: &str) -> Option<LinkInfo> {
    Some(LinkInfo { target: Some(target.to_string()), broken: true })
}

fn path_string(p: &Path) -> String {
    p.to_str().expect("fixture paths are UTF-8").to_string()
}

async fn list(root: &Path) -> Vec<Entry> {
    LocalProvider::new()
        .list(&make_uri(root))
        .await
        .expect("listing a folder with symlinks must succeed")
}

/// 一覧の 1 行を JSON にし、トップレベルのキー集合も返す。
fn to_json(entry: &Entry) -> (Value, BTreeSet<String>) {
    let v = serde_json::to_value(entry).expect("Entry must serialize");
    let keys = v
        .as_object()
        .expect("Entry must serialize to a JSON object")
        .keys()
        .cloned()
        .collect();
    (v, keys)
}

fn keys_of(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|s| s.to_string()).collect()
}

/// 標準的なフィクスチャ: `root/` の中に実ファイル・実フォルダ・各種リンクを置く。
///
/// ```text
/// tmp/
///   outside/a.md            リンク先(root の外・14 バイト)
///   target-dir/inside.md    リンク先フォルダ(root の外)
///   root/
///     alpha/                実フォルダ
///     beta.txt              実ファイル
///     gamma-link -> <abs tmp/target-dir>   フォルダへのリンク(絶対)
///     link.txt   -> <abs tmp/outside/a.md> ファイルへのリンク(絶対)
/// ```
struct Fixture {
    _tmp: TempDir,
    root: PathBuf,
    outside_file: PathBuf,
    target_dir: PathBuf,
}

fn fixture() -> Fixture {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("root");
    fs::create_dir(&root).unwrap();

    let outside = tmp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    let outside_file = outside.join("a.md");
    fs::write(&outside_file, b"vellis symlink").unwrap(); // 14 bytes

    let target_dir = tmp.path().join("target-dir");
    fs::create_dir(&target_dir).unwrap();
    fs::write(target_dir.join("inside.md"), "# inside").unwrap();

    fs::create_dir(root.join("alpha")).unwrap();
    fs::write(root.join("beta.txt"), "b").unwrap();
    symlink(&target_dir, root.join("gamma-link")).unwrap();
    symlink(&outside_file, root.join("link.txt")).unwrap();

    Fixture { _tmp: tmp, root, outside_file, target_dir }
}

// ---------------------------------------------------------------------------
// AC-70-1 — ファイルへのリンク・フォルダへのリンク(契約1・2)
// ---------------------------------------------------------------------------

/// AC-70-1: ファイルへのリンクは `kind: File`・`size` はリンク先の大きさ・`link` は
/// `{ target: <作ったときの文字列>, broken: false }`。
#[tokio::test]
async fn ac70_1_file_symlink_is_file_with_target_size_and_link_info() {
    let fx = fixture();
    let entries = list(&fx.root).await;

    let link = find(&entries, "link.txt");
    assert_eq!(link.kind, FileKind::File, "kind stays the target's kind (要件#31 契約1)");
    assert_eq!(link.size, Some(14), "size stays the target's byte count (要件#31 契約1)");
    assert_eq!(
        link.link,
        ok_link(&path_string(&fx.outside_file)),
        "a link to a file must carry link = {{ target: <readlink string>, broken: false }}"
    );
}

/// AC-70-1: フォルダへのリンクは `kind: Dir`・`size: None`・`link` は同じ形で、
/// 並び順はフォルダ群の中(フォルダが先・名前順)。
#[tokio::test]
async fn ac70_1_dir_symlink_is_dir_with_link_info_and_sorts_with_directories() {
    let fx = fixture();
    let entries = list(&fx.root).await;

    let link = find(&entries, "gamma-link");
    assert_eq!(link.kind, FileKind::Dir, "a link to a directory stays Dir (要件#31 契約1)");
    assert_eq!(link.size, None, "a dir-link has size=None like a directory");
    assert_eq!(
        link.link,
        ok_link(&path_string(&fx.target_dir)),
        "a link to a directory must carry link = {{ target: <readlink string>, broken: false }}"
    );
    assert_eq!(
        names_in_order(&entries),
        vec!["alpha", "gamma-link", "beta.txt", "link.txt"],
        "order is unchanged: directories (including dir-links) first, then names (要件#31 契約3)"
    );
}

// ---------------------------------------------------------------------------
// AC-70-2 — リンク切れ・自分を指すリンク(契約1・2)
// ---------------------------------------------------------------------------

/// AC-70-2: `missing.md -> no-such.md` は `kind: Symlink`・`link: { target: "no-such.md",
/// broken: true }`。`self -> self` も `Symlink`・`{ target: "self", broken: true }`。
/// どちらがあっても一覧は成功する。
#[tokio::test]
async fn ac70_2_broken_and_self_referencing_links_are_symlink_and_broken() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("root");
    fs::create_dir(&root).unwrap();
    symlink("no-such.md", root.join("missing.md")).unwrap();
    symlink("self", root.join("self")).unwrap();
    fs::write(root.join("normal.md"), "ok").unwrap();

    let entries = LocalProvider::new()
        .list(&make_uri(&root))
        .await
        .expect("a broken link and a self-referencing link must not fail the listing");

    let missing = find(&entries, "missing.md");
    assert_eq!(missing.kind, FileKind::Symlink, "an unreachable link stays Symlink (要件#31 契約2)");
    assert_eq!(missing.link, broken_link("no-such.md"), "a missing target is broken: true");

    let me = find(&entries, "self");
    assert_eq!(me.kind, FileKind::Symlink, "a self-referencing link (ELOOP) stays Symlink");
    assert_eq!(me.link, broken_link("self"), "a self-referencing link is broken: true");

    assert_eq!(find(&entries, "normal.md").kind, FileKind::File);
    assert_eq!(find(&entries, "normal.md").link, None);
}

// ---------------------------------------------------------------------------
// AC-70-3 — target は read_link の文字列そのまま(契約1)
// ---------------------------------------------------------------------------

/// AC-70-3: 相対のリンク先は相対のまま(`rel.md -> ../outside/a.md`・`sub-link -> sub`)、
/// 絶対パスで作ったリンクは絶対のまま、リンクのリンク(`chain.md -> rel.md`)は 1 段目の文字列。
#[tokio::test]
async fn ac70_3_target_is_the_raw_readlink_string() {
    let fx = fixture();
    symlink("../outside/a.md", fx.root.join("rel.md")).unwrap();
    fs::create_dir(fx.root.join("sub")).unwrap();
    symlink("sub", fx.root.join("sub-link")).unwrap();
    symlink("rel.md", fx.root.join("chain.md")).unwrap();

    let entries = list(&fx.root).await;

    let rel = find(&entries, "rel.md");
    assert_eq!(rel.kind, FileKind::File, "a relative link to a file resolves (kind File)");
    assert_eq!(rel.link, ok_link("../outside/a.md"), "a relative target is kept relative (not normalized)");

    let sub_link = find(&entries, "sub-link");
    assert_eq!(sub_link.kind, FileKind::Dir);
    assert_eq!(sub_link.link, ok_link("sub"), "a relative target to a sibling directory is kept as written");

    let abs = find(&entries, "link.txt");
    assert_eq!(
        abs.link,
        ok_link(&path_string(&fx.outside_file)),
        "an absolute target is kept absolute (not made relative, not canonicalized)"
    );

    let chain = find(&entries, "chain.md");
    assert_eq!(chain.kind, FileKind::File, "a link to a link resolves through to the file");
    assert_eq!(chain.link, ok_link("rel.md"), "a link to a link reports the first hop only");
}

// ---------------------------------------------------------------------------
// AC-70-4 — 普通のファイル・フォルダは link: None(契約1)
// ---------------------------------------------------------------------------

/// AC-70-4: 実ファイル・実フォルダ(隠しも含む)の行は `link` が `None`。
#[tokio::test]
async fn ac70_4_regular_entries_have_no_link() {
    let fx = fixture();
    fs::write(fx.root.join(".hidden.md"), "# h").unwrap();
    fs::create_dir(fx.root.join(".git")).unwrap();

    let entries = list(&fx.root).await;

    for name in ["alpha", "beta.txt", ".hidden.md", ".git"] {
        assert_eq!(find(&entries, name).link, None, "{name}: a regular entry must have link = None");
    }
    // 対照: リンクの行だけが Some
    let with_link: Vec<_> = entries.iter().filter(|e| e.link.is_some()).map(|e| e.name.as_str()).collect();
    assert_eq!(with_link, vec!["gamma-link", "link.txt"]);
}

// ---------------------------------------------------------------------------
// AC-70-5 — JSON の形(契約1)
// ---------------------------------------------------------------------------

/// AC-70-5: リンクでない行のキーは `uri`・`name`・`kind`・`size`・`modified` の 5 つだけ
/// (`link` のキーが無い)。
#[tokio::test]
async fn ac70_5_non_link_rows_serialize_to_the_five_existing_keys_only() {
    let fx = fixture();
    let entries = list(&fx.root).await;

    for name in ["alpha", "beta.txt"] {
        let (_, keys) = to_json(find(&entries, name));
        assert_eq!(
            keys,
            keys_of(&["uri", "name", "kind", "size", "modified"]),
            "{name}: a non-link row must not emit a `link` key (skip_serializing_if)"
        );
    }
}

/// AC-70-5: リンクの行は `"link": {"target": …, "broken": false}`、リンク切れは `"broken": true`。
#[tokio::test]
async fn ac70_5_link_rows_serialize_target_and_broken() {
    let fx = fixture();
    symlink("no-such.md", fx.root.join("missing.md")).unwrap();
    let entries = list(&fx.root).await;

    let (file_link, keys) = to_json(find(&entries, "link.txt"));
    assert_eq!(keys, keys_of(&["uri", "name", "kind", "size", "modified", "link"]));
    assert_eq!(
        file_link["link"],
        json!({ "target": path_string(&fx.outside_file), "broken": false }),
        "a resolvable link serializes target and broken: false"
    );
    assert_eq!(file_link["kind"], json!("file"), "kind keeps its lowercase JSON form");

    let (dir_link, _) = to_json(find(&entries, "gamma-link"));
    assert_eq!(dir_link["link"], json!({ "target": path_string(&fx.target_dir), "broken": false }));
    assert_eq!(dir_link["kind"], json!("dir"));

    let (missing, _) = to_json(find(&entries, "missing.md"));
    assert_eq!(
        missing["link"],
        json!({ "target": "no-such.md", "broken": true }),
        "a broken link serializes broken: true"
    );
    assert_eq!(missing["kind"], json!("symlink"));
}

/// AC-70-5: `LinkInfo { target: None, broken: false }` は `{"broken": false}`(`target` のキーが無い=ssh の形)。
#[test]
fn ac70_5_link_info_without_target_omits_the_target_key() {
    let info = LinkInfo { target: None, broken: false };
    assert_eq!(serde_json::to_value(&info).unwrap(), json!({ "broken": false }));

    let info = LinkInfo { target: None, broken: true };
    assert_eq!(serde_json::to_value(&info).unwrap(), json!({ "broken": true }));

    // Entry に乗せたときも同じ形で届く(ssh の一覧が運ぶ形)
    let entry = Entry {
        uri: "ssh://alice@host.example.com:2222/data/link.md".into(),
        name: "link.md".into(),
        kind: FileKind::Symlink,
        size: None,
        modified: None,
        link: Some(LinkInfo { target: None, broken: false }),
    };
    let (v, keys) = to_json(&entry);
    assert_eq!(keys, keys_of(&["uri", "name", "kind", "size", "modified", "link"]));
    assert_eq!(v["link"], json!({ "broken": false }));
}

/// AC-70-5(補助): `LinkInfo` は値で比べられ(`PartialEq`)、複製できる(`Clone`)。
#[test]
fn ac70_5_link_info_derives_partial_eq_and_clone() {
    let a = LinkInfo { target: Some("x".into()), broken: false };
    let b = a.clone();
    assert_eq!(a, b);
    assert_ne!(a, LinkInfo { target: Some("x".into()), broken: true });
    assert_ne!(a, LinkInfo { target: None, broken: false });
    // Debug も出せる(panic メッセージで使う)
    assert!(format!("{a:?}").contains("broken"));
}

// ---------------------------------------------------------------------------
// AC-70-6 — stat は辿った先の kind・link は None(契約1)
// ---------------------------------------------------------------------------

/// AC-70-6: `stat` はリンクを辿った先の `kind` を返し(要件#31 契約4 のまま)、`link` は `None`。
#[tokio::test]
async fn ac70_6_stat_follows_the_link_and_has_no_link_info() {
    let fx = fixture();
    let provider = LocalProvider::new();

    let dir_link = provider.stat(&make_uri(&fx.root.join("gamma-link"))).await.unwrap();
    assert_eq!(dir_link.kind, FileKind::Dir, "stat on a dir-link reports Dir (要件#31 契約4)");
    assert_eq!(dir_link.link, None, "stat does not attach link info");

    let file_link = provider.stat(&make_uri(&fx.root.join("link.txt"))).await.unwrap();
    assert_eq!(file_link.kind, FileKind::File);
    assert_eq!(file_link.size, Some(14));
    assert_eq!(file_link.link, None, "stat does not attach link info");

    let plain = provider.stat(&make_uri(&fx.root.join("beta.txt"))).await.unwrap();
    assert_eq!(plain.link, None);
}

// ---------------------------------------------------------------------------
// AC-70-7 — 除外は link を変えない・Entry { … } の組み立て場所は増えない(契約3)
// ---------------------------------------------------------------------------

fn entry_with_link(root: &Uri, rel: &str, kind: FileKind, link: Option<LinkInfo>) -> Entry {
    let uri = root.with_path(root.path.join(rel));
    Entry {
        uri: uri.raw,
        name: rel.rsplit('/').next().unwrap_or(rel).to_string(),
        kind,
        size: None,
        modified: None,
        link,
    }
}

/// AC-70-7: `filter_tree_entries_with` を通しても残った行の `link` は通す前と同じ。
/// 除外はリンクの名前(root からの相対パス)で判定し、リンク先は見ない(今のまま)。
#[test]
fn ac70_7_exclude_filter_keeps_link_info_and_judges_by_name() {
    let root = Uri::parse("file:///root").unwrap();
    let docs = root.with_path(root.path.join("docs"));
    let input = vec![
        entry_with_link(&root, "docs/sub-link", FileKind::Dir, ok_link("../shared")),
        entry_with_link(&root, "docs/plain-dir", FileKind::Dir, None),
        // 隠し名のリンク(リンク先は見えている名前でも、名前で隠れる)
        entry_with_link(&root, "docs/.hidden-link", FileKind::Dir, ok_link("/Users/x/visible")),
        entry_with_link(&root, "docs/link.md", FileKind::File, ok_link("../outside/a.md")),
        entry_with_link(&root, "docs/plain.md", FileKind::File, None),
        entry_with_link(&root, "docs/remote.md", FileKind::Symlink, Some(LinkInfo { target: None, broken: false })),
        entry_with_link(&root, "docs/missing.md", FileKind::Symlink, broken_link("no-such.md")),
        // 隠し名のリンク切れ
        entry_with_link(&root, "docs/.broken", FileKind::Symlink, broken_link("gone")),
    ];

    let kept = filter_tree_entries_with(&root, &docs, input.clone(), &Settings::default());

    assert_eq!(
        names_in_order(&kept),
        vec!["sub-link", "plain-dir", "link.md", "plain.md", "remote.md", "missing.md"],
        "hidden names drop regardless of link, the rest keep their order"
    );
    for kept_entry in &kept {
        let before = input.iter().find(|e| e.uri == kept_entry.uri).expect("kept rows come from the input");
        assert_eq!(kept_entry.link, before.link, "{}: link must pass through the exclude filter unchanged", kept_entry.name);
        assert_eq!(kept_entry.kind, before.kind);
    }
    assert_eq!(find(&kept, "sub-link").link, ok_link("../shared"));
    assert_eq!(find(&kept, "remote.md").link, Some(LinkInfo { target: None, broken: false }));
    assert_eq!(find(&kept, "missing.md").link, broken_link("no-such.md"));
    assert_eq!(find(&kept, "plain.md").link, None);
}

/// 行コメント(`//`)とブロックコメント(`/* */`)を落とす(文字列リテラルの中は見ない=
/// `Entry {` が文字列に現れることは無い前提)。
fn strip_rust_comments(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut rest = src;
    loop {
        let line_at = rest.find("//");
        let block_at = rest.find("/*");
        // 先に現れる方を処理する(どちらも無ければ残りをそのまま写して終わり)
        let block_first = match (line_at, block_at) {
            (None, None) => {
                out.push_str(rest);
                return out;
            }
            (Some(l), Some(b)) => b < l,
            (None, Some(_)) => true,
            (Some(_), None) => false,
        };
        if block_first {
            let b = block_at.unwrap();
            out.push_str(&rest[..b]);
            match rest[b + 2..].find("*/") {
                Some(end) => rest = &rest[b + 2 + end + 2..],
                None => return out,
            }
        } else {
            let l = line_at.unwrap();
            out.push_str(&rest[..l]);
            match rest[l..].find('\n') {
                Some(nl) => rest = &rest[l + nl..],
                None => return out,
            }
        }
    }
}

/// `\bEntry\s*\{` に相当する判定(regex クレートは依存に無い)。
fn has_entry_struct_literal(code: &str) -> bool {
    let bytes = code.as_bytes();
    let mut from = 0;
    while let Some(pos) = code[from..].find("Entry") {
        let i = from + pos;
        let prev_is_word = i > 0 && (bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_');
        let mut j = i + "Entry".len();
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        if !prev_is_word && j < bytes.len() && bytes[j] == b'{' {
            return true;
        }
        from = i + "Entry".len();
    }
    false
}

fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for de in fs::read_dir(dir).unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display())) {
        let path = de.unwrap().path();
        if path.is_dir() {
            collect_rs_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

/// AC-70-7: `src-tauri/src` の `.rs`(コメントを落とす)で `Entry` の構造体リテラル
/// (`\bEntry\s*\{`)が現れるのは `fs/entry.rs`(定義)・`fs/local.rs`・`fs/ssh.rs` だけ
/// (経路の途中で `Entry` を作り直して `link` を落とさない=契約3)。
#[test]
fn ac70_7_entry_struct_literals_appear_only_in_entry_local_and_ssh() {
    let src_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    collect_rs_files(&src_root, &mut files);
    assert!(!files.is_empty(), "src-tauri/src must contain .rs files");

    let allowed: BTreeSet<&str> = ["fs/entry.rs", "fs/local.rs", "fs/ssh.rs"].into_iter().collect();
    let mut with_literal = BTreeSet::new();
    for file in &files {
        let rel = file
            .strip_prefix(&src_root)
            .unwrap()
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("/");
        let code = strip_rust_comments(&fs::read_to_string(file).unwrap());
        if has_entry_struct_literal(&code) {
            with_literal.insert(rel);
        }
    }

    let offenders: Vec<_> = with_literal.iter().filter(|f| !allowed.contains(f.as_str())).cloned().collect();
    assert_eq!(offenders, Vec::<String>::new(), "Entry {{ … }} must be built only in fs/entry.rs, fs/local.rs and fs/ssh.rs (契約3)");
    // 3 ファイルは今もリテラルを持つ(走査そのものが機能している証左)
    for f in allowed {
        assert!(with_literal.contains(f), "{f} is expected to build Entry {{ … }} (sanity check of the scan)");
    }
}

/// 走査の自己検証: コメント除去と `\bEntry\s*\{` 判定が意図どおりに働く。
#[test]
fn ac70_7_scan_helpers_behave() {
    assert!(has_entry_struct_literal("let e = Entry { uri };"));
    assert!(has_entry_struct_literal("fn f() -> Entry {\n}"));
    assert!(has_entry_struct_literal("pub struct Entry {"));
    assert!(!has_entry_struct_literal("struct WatchEntry { x: u8 }"), "a word prefix is not Entry");
    assert!(!has_entry_struct_literal("use crate::fs::entry::Entry;"));
    assert!(!has_entry_struct_literal("Vec<Entry>"));
    assert!(!has_entry_struct_literal(&strip_rust_comments("// builds Entry { … } later\nlet x = 1;")));
    assert!(!has_entry_struct_literal(&strip_rust_comments("/* Entry {\n} */ let x = 1;")));
    assert!(has_entry_struct_literal(&strip_rust_comments("// note\nEntry { a }")));
}
