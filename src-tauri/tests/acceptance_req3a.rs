//! 要件#3 追補a の受け入れテスト(docs/requirements/req-03.md「追補a」・backlog 303)
//!
//! 「複数の窓が同時に開くと root の履歴の書き込みが競合する」の修正を判定する。
//! 受け入れ基準 AC-03-追a:
//!   (a) 1つの一時フォルダの履歴ファイルに対し、複数のスレッドが(開始をそろえて)
//!       別々の root を `add` する試行を繰り返しても、すべて `Ok`・終わった後の
//!       `list()` に全部の root がある・ファイルが JSON の配列として読める
//!   (b) 同じ root を同時に `add` しても `Ok` で、履歴に1件だけ残る
//!   (c) ソース走査: `history.rs` がプロセス全体のロック(`static` の `Mutex`)を持ち、
//!       `add` がそれを取る
//!
//! ## 確定契約(implementer はこれに従う。実装先: src-tauri/src/history.rs)
//!
//! 1. 同じプロセスの中で `HistoryStore::add` が複数のスレッドから同時に呼ばれても、
//!    **すべての呼び出しが `Ok`** で終わり、**呼ばれた root がすべて履歴に残る**
//!    (上限 `MAX_HISTORY` の範囲で)。履歴ファイルは常に JSON の配列として読める。
//! 2. 直し方は `recent_files.rs`(`WRITE_LOCK`)と同じく、読み込み〜書き戻しを
//!    プロセス全体のロックで順番にする。ストアは呼び出しのたびに作り直される
//!    (`record_root` が毎回 `HistoryStore::new`)ので、インスタンスのロックではなく
//!    `history.rs` のモジュール直下の `static` な `Mutex`。ロックが毒されても
//!    (別スレッドの panic)次の書き込みは進む。
//!    - `add` の本体で直接 `<STATIC>.lock(` するか、`recent_files.rs` の
//!      `lock_writes()` のような同じファイル内の補助関数(本体で `<STATIC>` を
//!      `.lock(` する関数)を `add` の本体から呼ぶか、のどちらでもよい。
//! 3. 不変: `history.json` の形(`Vec<String>` の JSON 配列・先頭=最新)・
//!    `MAX_HISTORY`・正規化(要件6)・最近順と重複の扱い・`record_root` の
//!    「失敗しても開くことは止めない」・要件72 の `--self-check` での書き込み抑止。
//!    依存の追加なし。既存の受け入れテスト(acceptance_req3.rs・acceptance_req6.rs
//!    ほか)は無改変で緑。
//!
//! ## 本テストの組み立て
//!
//! - 本番と同じく、各スレッドは `add` のたびに `HistoryStore::new(&path)` で
//!   ストアを作り直す(インスタンスに持たせたロックでは通らない)。
//! - 開始は `std::sync::Barrier` でそろえ、試行を `TRIALS` 回くり返す。試行ごとに
//!   新しい一時フォルダを使う(root の総数が `MAX_HISTORY` を超えないように)。
//! - ロックの無い実装では、同じ一時ファイル `history.json.tmp` の奪い合いで
//!   `rename` が `NotFound` になる(=`Err`)か、読み込み〜書き戻しの間に割り込まれて
//!   root が消える(=`list()` に足りない)ため、試行のどこかで赤になる。

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Barrier;
use std::thread;

use tempfile::TempDir;

use vellis_lib::history::{HistoryStore, MAX_HISTORY};

/// 同時に `add` するスレッドの数。
const THREADS: usize = 8;
/// (a) で 1 スレッドが 1 試行の中で続けて `add` する root の数。
const ADDS_PER_THREAD: usize = 2;
/// 試行の回数(確率的な競合を確実に拾うため厚めに)。
const TRIALS: usize = 150;

// (a) の root の総数は MAX_HISTORY の範囲内(契約1「上限の範囲で」)。
const _: () = assert!(THREADS * ADDS_PER_THREAD <= MAX_HISTORY);

fn history_path(tmp: &TempDir) -> PathBuf {
    tmp.path().join("history.json")
}

/// 履歴ファイルを JSON の配列(`Vec<String>`)として直接読む。
/// `list()` は壊れたファイルを空にフォールバックするので、それとは別にファイルそのものを見る。
fn read_raw_array(path: &Path, ctx: &str) -> Vec<String> {
    let raw = fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("{ctx}: history file must exist after adds: {e}"));
    serde_json::from_str::<Vec<String>>(&raw)
        .unwrap_or_else(|e| panic!("{ctx}: history file must be a JSON array of strings: {e}; raw={raw:?}"))
}

/// 正規化(要件6)で形が変わらない root(末尾 `/` なし・`/` の重ねなし)。
fn root_uri(trial: usize, thread: usize, k: usize) -> String {
    format!("file:///tmp/vellis-req3a/trial{trial}/t{thread}/r{k}")
}

// ---------------------------------------------------------------------------
// (a) 別々の root を同時に add → すべて Ok・全部残る・JSON 配列
// ---------------------------------------------------------------------------

#[test]
fn ac03a_a_concurrent_adds_of_distinct_roots_all_succeed_and_all_remain() {
    for trial in 0..TRIALS {
        let tmp = TempDir::new().unwrap();
        let path = history_path(&tmp);
        let barrier = Barrier::new(THREADS);

        let results: Vec<(String, Result<(), String>)> = thread::scope(|s| {
            let handles: Vec<_> = (0..THREADS)
                .map(|t| {
                    let path = &path;
                    let barrier = &barrier;
                    s.spawn(move || {
                        barrier.wait();
                        let mut out = Vec::new();
                        for k in 0..ADDS_PER_THREAD {
                            let root = root_uri(trial, t, k);
                            // 本番(record_root)と同じく呼び出しのたびにストアを作り直す。
                            let r = HistoryStore::new(path)
                                .add(&root)
                                .map_err(|e| format!("{e:?}"));
                            out.push((root, r));
                        }
                        out
                    })
                })
                .collect();
            handles
                .into_iter()
                .flat_map(|h| h.join().expect("add must not panic"))
                .collect()
        });

        let ctx = format!("trial {trial}");
        let errors: Vec<_> = results
            .iter()
            .filter_map(|(root, r)| r.as_ref().err().map(|e| format!("{root}: {e}")))
            .collect();
        assert!(
            errors.is_empty(),
            "{ctx}: every concurrent add must return Ok, but {} failed: {errors:?}",
            errors.len()
        );

        let expected: BTreeSet<String> = results.iter().map(|(root, _)| root.clone()).collect();
        assert_eq!(expected.len(), THREADS * ADDS_PER_THREAD);

        let listed = HistoryStore::new(&path).list().expect("list must succeed");
        let listed_set: BTreeSet<String> = listed.iter().cloned().collect();
        let missing: Vec<_> = expected.difference(&listed_set).collect();
        assert!(
            missing.is_empty(),
            "{ctx}: every added root must remain in list(); missing {missing:?}; list={listed:?}"
        );
        assert_eq!(
            listed.len(),
            expected.len(),
            "{ctx}: list() must hold exactly the added roots once each; list={listed:?}"
        );

        let raw = read_raw_array(&path, &ctx);
        assert_eq!(
            raw.iter().cloned().collect::<BTreeSet<_>>(),
            expected,
            "{ctx}: the file itself must hold every added root"
        );
    }
}

// ---------------------------------------------------------------------------
// (b) 同じ root を同時に add → すべて Ok・1件だけ
// ---------------------------------------------------------------------------

#[test]
fn ac03a_b_concurrent_adds_of_the_same_root_all_succeed_and_leave_one_entry() {
    for trial in 0..TRIALS {
        let tmp = TempDir::new().unwrap();
        let path = history_path(&tmp);
        let barrier = Barrier::new(THREADS);
        let root = format!("file:///tmp/vellis-req3a/same/trial{trial}");

        let results: Vec<Result<(), String>> = thread::scope(|s| {
            let handles: Vec<_> = (0..THREADS)
                .map(|_| {
                    let path = &path;
                    let barrier = &barrier;
                    let root = &root;
                    s.spawn(move || {
                        barrier.wait();
                        HistoryStore::new(path)
                            .add(root)
                            .map_err(|e| format!("{e:?}"))
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().expect("add must not panic"))
                .collect()
        });

        let ctx = format!("trial {trial}");
        let errors: Vec<_> = results.iter().filter_map(|r| r.as_ref().err()).collect();
        assert!(
            errors.is_empty(),
            "{ctx}: every concurrent add of the same root must return Ok, but {} failed: {errors:?}",
            errors.len()
        );

        let listed = HistoryStore::new(&path).list().expect("list must succeed");
        assert_eq!(
            listed,
            vec![root.clone()],
            "{ctx}: the same root added concurrently must remain exactly once"
        );
        assert_eq!(
            read_raw_array(&path, &ctx),
            vec![root.clone()],
            "{ctx}: the file itself must hold the root exactly once"
        );
    }
}

// ---------------------------------------------------------------------------
// (c) ソース走査: static な Mutex があり、add がそれを取る
// ---------------------------------------------------------------------------

/// 行ごとに `//` 以降(コメント)を落とす。`://` は落とさない(acceptance_req64 と同じ流儀)。
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

fn history_rs_code() -> String {
    let code = strip_line_comments(include_str!("../src/history.rs"));
    // 単体テストのモジュールは対象外(本体のロックを判定する)。
    match code.find("#[cfg(test)]") {
        Some(i) => code[..i].to_string(),
        None => code,
    }
}

/// `history.rs` のモジュール直下(行頭)にある `static` で、型に `Mutex` を含むものの名前。
/// `static X: Mutex<()> = …`・`pub(crate) static X: LazyLock<Mutex<…>> = …` などを拾う。
fn static_mutex_names(code: &str) -> Vec<String> {
    code.lines()
        .filter_map(|line| {
            let t = line.trim_end();
            // モジュール直下=字下げなし(関数内の static は「プロセス全体」でも add 以外から
            // 共有できないので、ここではモジュール直下に限る)。
            if t.starts_with(char::is_whitespace) {
                return None;
            }
            let after = t
                .strip_prefix("static ")
                .or_else(|| t.strip_prefix("pub static "))
                .or_else(|| t.strip_prefix("pub(crate) static "))
                .or_else(|| t.strip_prefix("pub(super) static "))?;
            let after = after.strip_prefix("mut ").unwrap_or(after);
            let (name, ty) = after.split_once(':')?;
            if ty.contains("Mutex") {
                Some(name.trim().to_string())
            } else {
                None
            }
        })
        .collect()
}

/// `fn <name>(` の本体(最初の `{` から対応する `}` まで)。見つからなければ None。
fn fn_body<'a>(code: &'a str, name: &str) -> Option<&'a str> {
    let marker = format!("fn {name}(");
    let at = code.find(&marker)?;
    let open = code[at..].find('{')? + at;
    let mut depth = 0usize;
    for (i, c) in code[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&code[open..=open + i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// ファイル内で定義されている関数名(`fn name(` / `fn name<`)。
fn fn_names(code: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = code;
    while let Some(i) = rest.find("fn ") {
        let before_ok = i == 0
            || (!rest.as_bytes()[i - 1].is_ascii_alphanumeric() && rest.as_bytes()[i - 1] != b'_');
        let tail = &rest[i + 3..];
        let name: String = tail
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        if before_ok && !name.is_empty() {
            names.push(name);
        }
        rest = &rest[i + 3..];
    }
    names
}

/// 本体が `<lock_name>` を取っているか(名前に触れ、`.lock(` を呼ぶ)。
/// `LOCK.lock()`・`LOCK\n    .lock()`・`LOCK.get_or_init(..).lock()` などを許す。
fn body_locks(body: &str, lock_name: &str) -> bool {
    body.contains(lock_name) && body.contains(".lock(")
}

#[test]
fn ac03a_c_history_rs_has_a_process_wide_static_mutex() {
    let code = history_rs_code();
    let names = static_mutex_names(&code);
    assert!(
        !names.is_empty(),
        "history.rs must hold a process-wide lock: a module-level `static` whose type is a `Mutex` \
         (like recent_files.rs `static WRITE_LOCK: Mutex<()> = Mutex::new(());`)"
    );
}

#[test]
fn ac03a_c_add_takes_the_process_wide_lock() {
    let code = history_rs_code();
    let names = static_mutex_names(&code);
    assert!(
        !names.is_empty(),
        "history.rs must hold a module-level `static` Mutex for add to take"
    );
    let add = fn_body(&code, "add").expect("history.rs must define `fn add(`");

    // add の本体で直接取るか、本体でそれを取る同じファイル内の補助関数を add から呼ぶ。
    let helpers: Vec<String> = fn_names(&code)
        .into_iter()
        .filter(|f| f != "add")
        .filter(|f| {
            fn_body(&code, f)
                .map(|b| names.iter().any(|n| body_locks(b, n)))
                .unwrap_or(false)
        })
        .collect();

    let direct = names.iter().any(|n| body_locks(add, n));
    let via_helper = helpers.iter().any(|h| add.contains(&format!("{h}(")));
    assert!(
        direct || via_helper,
        "HistoryStore::add must take the process-wide lock ({names:?}) — either `<LOCK>.lock(` in its \
         body or a call to a helper that does (helpers found: {helpers:?})"
    );
}
