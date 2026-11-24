//! 要件#74 第2段の先行分(docs/requirements/req-74.md)— 保存前の写しの置き場
//! (AC-74-44・契約14「保存前の写し」・(ag) 決定・第2段の作り(案)の項目 28)
//!
//! 配布版(`ai_marks` が偽)では、保存前の写しを開いたフォルダの外=アプリのデータの置き場に取り、
//! `<root>/.vellis/` を作らない。`ai_marks` が真なら今どおり `<root>/.vellis/snapshots/`(`store_for`)。
//! 古い写しは今の `DEFAULT_RETENTION` で片付く。
//!
//! 判定の形: 純関数(`snapshot_store_dir`)・`SnapshotManager::at` を一時ディレクトリで実際に動かす・
//! `save_document` の本文のソース走査(`ai_marks` の判定で経路が分かれ、偽の側は `store_for(` を通らない)。
//! Window / AppState の要る `save_document` の実走は、第1段の人間ゲート 6 の運転手(req74-gate.sh)の家風で
//! 実機に回す(ここでは判定しない)。
//!
//! ## 確定契約(implementer はこれに従う=推奨名は req-74.md 項目 28。無いものは test-writer が固定)
//!
//! ```ignore
//! // --- src-tauri/src/annotation/snapshot.rs
//! /// 配布版の写しの置き場(純関数・fs に触れない)= <app_data>/snapshots/<canonical_root の SHA-256 の先頭 16 桁>/
//! /// SHA-256 は `canonical_root.to_string_lossy()` の UTF-8 に `annotation::sha256_hex` を当てたもの(小文字の hex)。
//! pub fn snapshot_store_dir(app_data: &Path, canonical_root: &Path) -> PathBuf;
//! impl SnapshotManager<'a> {
//!     /// 置き場を受け取る作り: `store_dir` の**直下**に `<id>/manifest.json` と写しを置き、相対パスは `root_dir` で解く。
//!     /// 今の `new(vellis_dir)` は `at(&vellis_dir.join("snapshots"), vellis_dir の親)` と同じ振る舞い(無改変)。
//!     pub fn at(store_dir: &'a Path, root_dir: PathBuf) -> Self;
//! }
//! // retention は `at` でも DEFAULT_RETENTION(20)。`with_retention` は今のまま
//!
//! // --- src-tauri/src/commands/document.rs の save_document
//! //   門(`features::require_any(&[EDITOR_INLINE, EDITOR_FILE], "Saving")?;`)と照合(`check_expected_hash(`)は今のまま。
//! //   写しの置き場は `features::is_enabled(features::AI_MARKS)` で分ける:
//! //     真 → 今どおり `store_for(` → `SnapshotManager::new(store.vellis_dir())`
//! //     偽 → `app.path().app_data_dir()`(`app_data_dir(` の字面)→ `snapshot_store_dir(` → `SnapshotManager::at(`。
//! //          この枝では `store_for(` を呼ばない(`.vellis/` を作らない)
//! //   `vellis_dir_allowed(edit, ai)` と `store_for` の判定は今のまま(撤去の周回=項目 26 で改める)
//! ```
//!
//! ## 判断の記録(test-writer 2026-11-17)
//! - `snapshot_store_dir` が返す `<app_data>/snapshots/<hash>/` を `at` の `store_dir` にそのまま渡す作りにするため、
//!   `at(store_dir, …)` は **`store_dir` の直下に `<id>/`** を置く(`new(vellis_dir)` の `<vellis>/snapshots/<id>/` と
//!   同じ深さになる。`<app_data>/snapshots/<hash>/snapshots/<id>/` の二重を避ける)
//! - ハッシュの元は canonical な root の文字列(`to_string_lossy`)。同じ root は同じ置き場・別の root は別の置き場
//!
//! ## 修正前に赤になる理由
//! - `snapshot_store_dir`・`SnapshotManager::at` が無いのでコンパイルできない(ファイル全体が赤)。
//!   `new(vellis_dir)` の無改変のケースと `vellis_dir_allowed` の不変は実装前から緑(不変の固定)

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{TimeZone, Utc};
use tempfile::TempDir;
use vellis_lib::annotation::sha256_hex;
use vellis_lib::annotation::snapshot::{
    snapshot_store_dir, SnapshotManager, DEFAULT_RETENTION, MANIFEST_FILENAME, SNAPSHOTS_DIRNAME,
};
use vellis_lib::commands::annotation::vellis_dir_allowed;

// ---------------------------------------------------------------------------
// 共通ヘルパ(acceptance_req84.rs / acceptance_req74.rs の写し)
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

fn document_rs_code() -> String {
    strip_line_comments(include_str!("../src/commands/document.rs"))
}

fn snapshot_rs_code() -> String {
    strip_line_comments(include_str!("../src/annotation/snapshot.rs"))
}

fn fn_decl_start(code: &str, name: &str) -> Option<usize> {
    let marker = format!("fn {name}");
    let mut search = 0;
    while let Some(rel) = code[search..].find(&marker) {
        let at = search + rel;
        let after = code[at + marker.len()..].chars().next();
        if matches!(after, Some('(') | Some('<')) {
            return Some(at);
        }
        search = at + marker.len();
    }
    None
}

fn matching_close(code: &str, open: usize) -> usize {
    let bytes = code.as_bytes();
    let (inc, dec) = match bytes[open] {
        b'{' => (b'{', b'}'),
        b'(' => (b'(', b')'),
        b'[' => (b'[', b']'),
        other => panic!("not an opening bracket at {open}: {}", other as char),
    };
    let mut depth = 0usize;
    let mut in_str = false;
    let mut i = open;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if c == b'\\' {
                i += 2;
                continue;
            }
            if c == b'"' {
                in_str = false;
            }
        } else if c == b'"' {
            in_str = true;
        } else if c == inc {
            depth += 1;
        } else if c == dec {
            depth -= 1;
            if depth == 0 {
                return i;
            }
        }
        i += 1;
    }
    panic!("unbalanced bracket starting at byte {open}");
}

fn fn_body(code: &str, name: &str) -> String {
    let start = fn_decl_start(code, name)
        .unwrap_or_else(|| panic!("source must define `fn {name}(` (or `fn {name}<`)"));
    let params_open = code[start..].find('(').expect("fn must take parameters") + start;
    let params_close = matching_close(code, params_open);
    let open = code[params_close..].find('{').expect("fn must have a body") + params_close;
    let close = matching_close(code, open);
    code[open + 1..close].to_string()
}

fn fn_params(code: &str, name: &str) -> String {
    let start = fn_decl_start(code, name)
        .unwrap_or_else(|| panic!("source must define `fn {name}(`"));
    let params_open = code[start..].find('(').expect("fn must take parameters") + start;
    let params_close = matching_close(code, params_open);
    code[params_open + 1..params_close].to_string()
}

fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

fn first_statement(code: &str, name: &str) -> String {
    let body = fn_body(code, name);
    let trimmed = body.trim_start();
    let end = trimmed.find(';').unwrap_or(trimmed.len());
    squash(&trimmed[..end])
}

/// `if <cond> { <block> }` の一覧(`else if` も拾う。`cond` は `if` から `{` の手前まで・`block` は括弧を含む)。
/// `else { … }` が続けばそれも `else_block` に。
fn if_statements(body: &str) -> Vec<(String, String, Option<String>)> {
    let bytes = body.as_bytes();
    let mut out = Vec::new();
    let mut search = 0;
    while let Some(rel) = body[search..].find("if ") {
        let at = search + rel;
        let word_start = at == 0 || !(bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_');
        search = at + 3;
        if !word_start {
            continue;
        }
        let mut depth = 0i32;
        let mut i = at + 3;
        let mut block_open = None;
        while i < bytes.len() {
            match bytes[i] {
                b'(' | b'[' => depth += 1,
                b')' | b']' => depth -= 1,
                b'{' if depth == 0 => {
                    block_open = Some(i);
                    break;
                }
                b';' if depth == 0 => break,
                _ => {}
            }
            i += 1;
        }
        let Some(open) = block_open else { continue };
        let close = matching_close(body, open);
        let rest = body[close + 1..].trim_start();
        let else_block = if rest.starts_with("else") && !rest.starts_with("else if") {
            rest.find('{').map(|eo| {
                let ec = matching_close(rest, eo);
                rest[eo..=ec].to_string()
            })
        } else {
            None
        };
        out.push((body[at + 3..open].trim().to_string(), body[open..=close].to_string(), else_block));
    }
    out
}

fn canonical_temp() -> (TempDir, PathBuf) {
    let tmp = TempDir::new().unwrap();
    let canonical = tmp.path().canonicalize().unwrap();
    (tmp, canonical)
}

fn at(minute: u32) -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 17, 9, minute, 0).unwrap()
}

/// `dir` の直下の名前(`ls -A` 相当)。
fn names_in(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    v.sort();
    v
}

// ---------------------------------------------------------------------------
// AC-74-44 (1) — snapshot_store_dir(純関数)
// ---------------------------------------------------------------------------

/// 1. `<app_data>/snapshots/<canonical_root の SHA-256 の先頭 16 桁>/`。
#[test]
fn ac74_44_snapshot_store_dir_is_app_data_snapshots_hash16() {
    let app_data = Path::new("/Users/example/Library/Application Support/com.tetsuo.vellis");
    let root = Path::new("/Users/example/project");
    let expected_hash = &sha256_hex(&root.to_string_lossy())[..16];
    let dir = snapshot_store_dir(app_data, root);
    assert_eq!(dir, app_data.join(SNAPSHOTS_DIRNAME).join(expected_hash));
    assert_eq!(dir.parent().unwrap().parent().unwrap(), app_data, "the store sits two levels under app_data");
    assert_eq!(dir.parent().unwrap().file_name().unwrap(), SNAPSHOTS_DIRNAME);
    let leaf = dir.file_name().unwrap().to_string_lossy().into_owned();
    assert_eq!(leaf.len(), 16, "the leaf is the first 16 hex digits: {leaf}");
    assert!(leaf.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "lowercase hex: {leaf}");
}

/// 2. 同じ root は同じ置き場・別の root は別の置き場・app_data が違えば違う。純関数(fs に触れない)。
#[test]
fn ac74_44_snapshot_store_dir_is_deterministic_and_keyed_by_root() {
    let app_data = Path::new("/tmp/vellis-app-data-that-does-not-exist");
    let a = snapshot_store_dir(app_data, Path::new("/Users/a/project"));
    let b = snapshot_store_dir(app_data, Path::new("/Users/a/project"));
    let c = snapshot_store_dir(app_data, Path::new("/Users/a/other"));
    let d = snapshot_store_dir(Path::new("/elsewhere"), Path::new("/Users/a/project"));
    assert_eq!(a, b, "the same root maps to the same store");
    assert_ne!(a, c, "another root maps to another store");
    assert_ne!(a, d, "another app_data maps to another store");
    assert_eq!(a.file_name(), d.file_name(), "the hash leaf depends on the root only");
    assert!(!app_data.exists(), "snapshot_store_dir creates nothing");
    assert!(!a.exists());
}

/// 3. 日本語・空白のある root も同じ規則(文字列の UTF-8 の SHA-256)。
#[test]
fn ac74_44_snapshot_store_dir_hashes_the_root_string_as_utf8() {
    let app_data = Path::new("/app");
    let root = Path::new("/Users/由谷/ffn works/製品");
    let dir = snapshot_store_dir(app_data, root);
    assert_eq!(dir.file_name().unwrap().to_string_lossy(), &sha256_hex("/Users/由谷/ffn works/製品")[..16]);
}

// ---------------------------------------------------------------------------
// AC-74-44 (2) — SnapshotManager::at を一時ディレクトリで動かす
// ---------------------------------------------------------------------------

/// 4. `at(store_dir, root)`: 写しは `store_dir` の直下の `<id>/` にでき、`<root>/.vellis/` は作られない(`ls -A` 相当)。
#[test]
fn ac74_44_at_writes_under_the_store_dir_and_creates_no_vellis_in_the_root() {
    let (_root_tmp, root) = canonical_temp();
    let (_data_tmp, app_data) = canonical_temp();
    fs::write(root.join("a.md"), "hello\n").unwrap();
    fs::create_dir_all(root.join("docs")).unwrap();
    fs::write(root.join("docs/spec.md"), "world\n").unwrap();
    let store = snapshot_store_dir(&app_data, &root);
    assert!(!store.exists(), "the store does not exist before the first snapshot");

    let manager = SnapshotManager::at(&store, root.clone());
    let manifest = manager
        .take_snapshot(&["a.md".to_string(), "docs/spec.md".to_string()], &[], at(0))
        .expect("take_snapshot through the app-data store");

    let snap_dir = store.join(&manifest.snapshot_id);
    assert!(snap_dir.is_dir(), "<store>/<id>/ exists: {}", snap_dir.display());
    assert_eq!(fs::read_to_string(snap_dir.join("a.md")).unwrap(), "hello\n");
    assert_eq!(fs::read_to_string(snap_dir.join("docs/spec.md")).unwrap(), "world\n");
    assert!(snap_dir.join(MANIFEST_FILENAME).is_file());
    assert_eq!(manifest.files, vec!["a.md".to_string(), "docs/spec.md".to_string()]);
    // `ls -A <root>`: only what was there.
    assert_eq!(names_in(&root), vec!["a.md".to_string(), "docs".to_string()]);
    assert!(!root.join(".vellis").exists(), "<root>/.vellis/ is never created by the app-data store");
    // The store is outside the root (and the root outside the store).
    assert!(!store.starts_with(&root));
    assert!(!root.starts_with(&store));
}

/// 5. `list` / `read_before` / `revert` は `at` でも root の相対パスで動く。
#[test]
fn ac74_44_at_lists_reads_and_reverts_through_the_root() {
    let (_root_tmp, root) = canonical_temp();
    let (_data_tmp, app_data) = canonical_temp();
    fs::write(root.join("a.md"), "before edit\n").unwrap();
    let store = snapshot_store_dir(&app_data, &root);
    let manager = SnapshotManager::at(&store, root.clone());
    let m = manager.take_snapshot(&["a.md".to_string()], &[], at(1)).unwrap();
    fs::write(root.join("a.md"), "after edit\n").unwrap();

    let listed = manager.list().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].snapshot_id, m.snapshot_id);
    assert_eq!(manager.read_before(&m.snapshot_id, "a.md").unwrap(), "before edit\n");
    manager.revert(&m.snapshot_id, &["a.md".to_string()]).unwrap();
    assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "before edit\n");
    assert!(!root.join(".vellis").exists());
}

/// 6. 相対パスの脱出(`..`・絶対)は `at` でも断る。
#[test]
fn ac74_44_at_refuses_escaping_relative_paths() {
    let (_root_tmp, root) = canonical_temp();
    let (_data_tmp, app_data) = canonical_temp();
    let store = snapshot_store_dir(&app_data, &root);
    let manager = SnapshotManager::at(&store, root.clone());
    assert!(manager.take_snapshot(&["../outside.md".to_string()], &[], at(2)).is_err());
    assert!(manager.take_snapshot(&["/etc/hosts".to_string()], &[], at(3)).is_err());
}

/// 7. 古い写しは `DEFAULT_RETENTION`(20)で片付く(`at` でも)。
#[test]
fn ac74_44_at_prunes_to_default_retention() {
    let (_root_tmp, root) = canonical_temp();
    let (_data_tmp, app_data) = canonical_temp();
    fs::write(root.join("a.md"), "x\n").unwrap();
    let store = snapshot_store_dir(&app_data, &root);
    let manager = SnapshotManager::at(&store, root.clone());
    assert_eq!(DEFAULT_RETENTION, 20, "the retention this test counts against");
    for minute in 0..(DEFAULT_RETENTION as u32 + 5) {
        manager.take_snapshot(&["a.md".to_string()], &[], at(minute)).unwrap();
    }
    let listed = manager.list().unwrap();
    assert_eq!(listed.len(), DEFAULT_RETENTION, "the oldest beyond the retention are removed");
    // Newest first; the first 5 (minutes 0〜4) are gone.
    assert_eq!(listed[0].created_at, at(DEFAULT_RETENTION as u32 + 4));
    assert_eq!(listed.last().unwrap().created_at, at(5));
    let dirs = names_in(&store).into_iter().filter(|n| store.join(n).is_dir()).count();
    assert_eq!(dirs, DEFAULT_RETENTION, "the directories on disk match the manifests");
}

/// 8. `with_retention` は `at` でも効く。
#[test]
fn ac74_44_at_honours_with_retention() {
    let (_root_tmp, root) = canonical_temp();
    let (_data_tmp, app_data) = canonical_temp();
    fs::write(root.join("a.md"), "x\n").unwrap();
    let store = snapshot_store_dir(&app_data, &root);
    let manager = SnapshotManager::at(&store, root.clone()).with_retention(2);
    for minute in 0..4 {
        manager.take_snapshot(&["a.md".to_string()], &[], at(minute)).unwrap();
    }
    assert_eq!(manager.list().unwrap().len(), 2);
}

/// 9. 2 つの root は別の置き場に分かれ、互いの写しを見ない。
#[test]
fn ac74_44_two_roots_do_not_share_a_store() {
    let (_a_tmp, root_a) = canonical_temp();
    let (_b_tmp, root_b) = canonical_temp();
    let (_data_tmp, app_data) = canonical_temp();
    fs::write(root_a.join("a.md"), "A\n").unwrap();
    fs::write(root_b.join("b.md"), "B\n").unwrap();
    let store_a = snapshot_store_dir(&app_data, &root_a);
    let store_b = snapshot_store_dir(&app_data, &root_b);
    assert_ne!(store_a, store_b);
    SnapshotManager::at(&store_a, root_a.clone()).take_snapshot(&["a.md".to_string()], &[], at(0)).unwrap();
    assert_eq!(SnapshotManager::at(&store_a, root_a.clone()).list().unwrap().len(), 1);
    assert_eq!(SnapshotManager::at(&store_b, root_b.clone()).list().unwrap().len(), 0);
    assert_eq!(names_in(&app_data.join(SNAPSHOTS_DIRNAME)).len(), 1, "only root A's store exists so far");
}

/// 10. 今の `new(vellis_dir)` は無改変: `<vellis>/snapshots/<id>/` に写し、root は `vellis_dir` の親。
#[test]
fn ac74_44_new_keeps_the_vellis_snapshots_layout() {
    let (_root_tmp, root) = canonical_temp();
    fs::write(root.join("a.md"), "hello\n").unwrap();
    let vellis = root.join(".vellis");
    fs::create_dir_all(&vellis).unwrap();
    let manager = SnapshotManager::new(&vellis);
    let m = manager.take_snapshot(&["a.md".to_string()], &[], at(0)).unwrap();
    let snap_dir = vellis.join(SNAPSHOTS_DIRNAME).join(&m.snapshot_id);
    assert!(snap_dir.join("a.md").is_file(), "{}", snap_dir.display());
    assert!(snap_dir.join(MANIFEST_FILENAME).is_file());
    // `at` with the same layout behaves the same as `new`.
    let same = SnapshotManager::at(&vellis.join(SNAPSHOTS_DIRNAME), root.clone());
    assert_eq!(same.list().unwrap().len(), 1);
    assert_eq!(same.read_before(&m.snapshot_id, "a.md").unwrap(), "hello\n");
}

// ---------------------------------------------------------------------------
// AC-74-44 (3) — save_document のソース走査(ai_marks で経路が分かれる)
// ---------------------------------------------------------------------------

/// 11. `save_document` は `features::is_enabled(features::AI_MARKS)` で写しの置き場を分ける: 真の側に `store_for(` と
///     `SnapshotManager::new(`、偽の側に `app_data_dir(`・`snapshot_store_dir(`・`SnapshotManager::at(`。偽の側は `store_for(` を通らない。
#[test]
fn ac74_44_save_document_picks_the_store_by_ai_marks() {
    let code = document_rs_code();
    let body = fn_body(&code, "save_document");
    assert!(body.contains("AI_MARKS"), "save_document reads features::AI_MARKS to pick the store: {body}");
    let ifs = if_statements(&body);
    let (cond, then_block, else_block) = ifs
        .iter()
        .find(|(cond, then_block, else_block)| {
            cond.contains("AI_MARKS")
                && (then_block.contains("store_for(") || else_block.as_deref().is_some_and(|e| e.contains("store_for(")))
        })
        .cloned()
        .expect("an `if … is_enabled(features::AI_MARKS) …` whose one side calls store_for(");
    let cond_s = squash(&cond);
    assert!(
        cond_s.contains("features::is_enabled(features::AI_MARKS)") || cond_s.contains("crate::features::is_enabled(crate::features::AI_MARKS)"),
        "the decision is the registry's: {cond}"
    );
    let negated = cond_s.starts_with('!');
    let (vellis_side, app_side) = if negated {
        (else_block.clone().expect("a negated if needs an else holding the .vellis/ side"), then_block.clone())
    } else {
        (then_block.clone(), else_block.clone().expect("the ai_marks=false side needs an else"))
    };
    assert!(vellis_side.contains("store_for("), "ai_marks=true: today's store_for (<root>/.vellis/snapshots/): {vellis_side}");
    assert!(vellis_side.contains("SnapshotManager::new("), "ai_marks=true: SnapshotManager::new(store.vellis_dir()): {vellis_side}");
    assert!(!app_side.contains("store_for("), "ai_marks=false: store_for( is not called (no <root>/.vellis/): {app_side}");
    assert!(app_side.contains("app_data_dir("), "ai_marks=false: the store is under app.path().app_data_dir(): {app_side}");
    assert!(app_side.contains("snapshot_store_dir("), "ai_marks=false: snapshot_store_dir(app_data, canonical_root): {app_side}");
    assert!(app_side.contains("SnapshotManager::at("), "ai_marks=false: SnapshotManager::at(store_dir, root): {app_side}");
    assert_eq!(body.matches("store_for(").count(), 1, "store_for( is called in one place only (the ai_marks=true side)");
    assert!(body.contains("take_snapshot("), "the snapshot is still taken before the write");
    // S6 (reviewer 2026-11-17): the app-data side's `take_snapshot(` returns its failure with `?` in the same
    // statement — no snapshot, no save (要件48 の注記 3。第1段の `check_expected_hash(…)?` と同じ形)。
    let take = app_side.find("take_snapshot(").expect("ai_marks=false: the snapshot is taken through SnapshotManager::at");
    let take_rest = &app_side[take..];
    let take_stmt = &take_rest[..take_rest.find(';').unwrap_or(take_rest.len())];
    assert!(
        take_stmt.contains('?'),
        "ai_marks=false: take_snapshot(…) must return its failure with `?` in the same statement (a save without a snapshot is not performed): {take_stmt}"
    );
    // S8 (reviewer 2026-11-17): the root is canonicalised before the relative path is cut (a symlinked root
    // such as /tmp → /private/tmp would otherwise make strip_prefix fail and the save with it).
    assert!(
        app_side.contains("canonicalize("),
        "ai_marks=false: the root must be canonicalised (canonicalize() before strip_prefix): {app_side}"
    );
}

/// 12. 照合と写しと書き込みの順は第1段のまま: `check_expected_hash(` → 写し → `write_text_within_root(`(門は 2-5 で撤去)。
#[test]
fn ac74_44_save_document_keeps_the_gate_the_check_and_the_order() {
    let code = document_rs_code();
    // 要件74 第2段 2-5(2026-11-17 仮・契約21・AC-74-46=要件側更新): 門は撤去(最初の文は require ではない)。照合と写しと書き込みの順はそのまま。
    let first = first_statement(&code, "save_document");
    assert!(!first.contains("require"), "the gate is gone after the removal round (AC-74-46): `{first}`");
    let body = fn_body(&code, "save_document");
    assert!(!body.contains("require_any(") && !body.contains("EDITOR_INLINE") && !body.contains("EDITOR_FILE"), "no gate in save_document: {body}");
    let check = body.find("check_expected_hash(").expect("the hash check stays");
    let snap = body.find("take_snapshot(").expect("the snapshot stays");
    let write = body.find("write_text_within_root(").expect("the write stays");
    let pick = body.find("AI_MARKS").expect("the store is picked");
    assert!(check < pick && pick < snap && snap < write, "order: check → pick the store → snapshot → write");
}

/// 13. `snapshot.rs` の公開の口の形: `snapshot_store_dir(app_data: &Path, canonical_root: &Path) -> PathBuf`・
///     `at(store_dir: &'a Path, root_dir: PathBuf)`。`new(vellis_dir)` は残る。
#[test]
fn ac74_44_snapshot_rs_declares_the_two_entry_points() {
    let code = snapshot_rs_code();
    let params = squash(&fn_params(&code, "snapshot_store_dir"));
    assert_eq!(params, "app_data:&Path,canonical_root:&Path", "snapshot_store_dir's parameters");
    let at_params = squash(&fn_params(&code, "at"));
    assert!(
        at_params == "store_dir:&'aPath,root_dir:PathBuf" || at_params == "store_dir:&Path,root_dir:PathBuf",
        "SnapshotManager::at(store_dir: &Path, root_dir: PathBuf): got `{at_params}`"
    );
    assert!(fn_decl_start(&code, "new").is_some(), "SnapshotManager::new(vellis_dir) stays for the .vellis/ side");
    assert!(code.contains("pub fn snapshot_store_dir"), "snapshot_store_dir is public");
    assert!(code.contains("pub fn at"), "at is public");
}

// ---------------------------------------------------------------------------
// 不変 — `vellis_dir_allowed` は今の意味のまま(撤去の周回=項目 26 で改める)
// ---------------------------------------------------------------------------

/// 14. `vellis_dir_allowed(ai) == ai`(要件84 AC-84-7 の 24 と同じ。2-5 の撤去で 1 引数に)。
#[test]
fn vellis_dir_allowed_is_unchanged_in_this_round() {
    // 要件74 第2段 2-5(2026-11-17 仮・項目 28): 撤去で `vellis_dir_allowed(ai)` の 1 引数に(acceptance_req84.rs の 24 と同じ)。
    assert!(!vellis_dir_allowed(false));
    assert!(vellis_dir_allowed(true));
}
