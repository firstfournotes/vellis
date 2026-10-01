//! 要件#67 の受け入れテスト(docs/requirements/req-67.md)— Rust 層
//!
//! 「起動のたびに新しいバージョンの有無を確認する(起動時は6時間の間引きをしない)。
//!  メニューの Check for Updates… でいつでも確認できる」
//!
//! 判定範囲(AC 番号は req-67.md の受け入れ基準):
//! - AC-67-1 起動時の判定は最終チェック時刻にかかわらず「要チェック」(契約1・5)
//! - AC-67-2 周期の判定は `should_check` と同じ答え(契約2・5)
//! - AC-67-3 `channel_allows_check` は dev=false / release=true のまま(契約9・11)
//! - AC-67-4 menu.rs の App メニューに「Check for Updates…」が about の直後・最初の
//!   区切り線より前にある。ID 定数が宣言され使われる。ショートカット無し。他メニューに無い(契約6)
//! - AC-67-5 lib.rs の `on_menu_event` がこの ID を扱う(契約6)
//! - AC-67-6 結果の振り分け(新しい版 / 同じ・古い版 / 取得失敗・版番号が読めない)(契約8)
//! - AC-67-7 ダイアログの文言(英語・両方の版・ボタン)(契約8)
//! - AC-67-8 要件14・35・60・65 の受け入れテストが無改変で緑=本ファイルの外(フルスイート)
//!
//! reviewer 照合(機械判定しない): `spawn_poller` の1回目= Startup・2回目以降= Poll の配線・
//! 最終チェック時刻を実行前に書く順序(起動時・メニュー)・メニューの確認が
//! `channel_allows_check` を通らないこと・`update_available` を emit しないこと・
//! 2重押しを弾くこと・Download が opener で `html_url` を開くこと・フロントとバナーが無改変。
//! 人間ゲート(バナーの再表示・ダイアログの見た目・オフラインの手応え)は判定しない。
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前・公開パス)
//!
//! ```ignore
//! // --- src-tauri/src/update_check.rs に追加(既存の pub は無改変)---
//!
//! /// 自動の確認の種別(契約5)。起動時の1回目= Startup・以後の周期= Poll。
//! #[derive(Clone, Copy, Debug, PartialEq, Eq)]
//! pub enum CheckTrigger { Startup, Poll }
//!
//! /// 自動の確認の要否(契約1・2・5)。Startup なら常に true。
//! /// Poll なら `should_check(last_check_unix, now_unix)` と同じ答え。
//! pub fn should_check_on(trigger: CheckTrigger, last_check_unix: Option<i64>, now_unix: i64) -> bool;
//!
//! /// メニューからの確認の結果(契約8・10)。
//! #[derive(Clone, Debug, PartialEq, Eq)]
//! pub enum ManualCheckOutcome {
//!     /// 新しい版あり。`version` は先頭の `v` を除いた `x.y.z`・`url` は `html_url`。
//!     Available { version: String, url: String },
//!     /// 取得した版が今の版と同じか古い。`current` は今の版(渡した文字列そのまま)。
//!     UpToDate { current: String },
//!     /// 不通・タイムアウト・パース失敗、または取得した版の番号が `x.y.z` で読めない。
//!     Failed,
//! }
//!
//! /// 取得の結果(`fetch_latest_release` の戻り)と今の版(`CARGO_PKG_VERSION`)から結果を振り分ける純関数。
//! /// `is_newer` が真 → Available・tag が `x.y.z`(先頭 v 任意)で読めて新しくない → UpToDate・
//! /// Err または tag が読めない → Failed。
//! pub fn manual_check_outcome(fetched: Result<ReleaseInfo, UpdateCheckError>, current: &str) -> ManualCheckOutcome;
//!
//! /// ダイアログの中身(契約8)。`buttons` はラベルの列で、先頭が既定のボタン。
//! #[derive(Clone, Debug, PartialEq, Eq)]
//! pub struct ManualCheckDialog { pub title: String, pub body: String, pub buttons: Vec<String> }
//!
//! /// 結果 → ダイアログの文言(英語)。本テストが値を固定する:
//! ///   Available { version: "0.5.0", .. }, current "0.4.0"
//! ///     → title "A new version of Vellis is available"
//! ///       body  "Vellis v0.5.0 is available. You have v0.4.0."
//! ///       buttons ["Download", "Later"]
//! ///   UpToDate { current: "0.4.0" }
//! ///     → title "You're up to date" / body "Vellis v0.4.0 is the latest version." / buttons ["OK"]
//! ///   Failed
//! ///     → title "Couldn't check for updates" / body "Check your internet connection and try again." / buttons ["OK"]
//! /// `current` は Available の本文に今の版を出すために受ける(UpToDate は自身の current を使う)。
//! pub fn manual_check_dialog(outcome: &ManualCheckOutcome, current: &str) -> ManualCheckDialog;
//!
//! // --- src-tauri/src/menu.rs に追加(SETTINGS_ITEM_ID と同じ家風)---
//! pub const CHECK_FOR_UPDATES_ITEM_ID: &str = "check-for-updates";
//! // ラベル "Check for Updates…"(三点は U+2026 の1文字)。App メニュー(最初の Submenu・ラベル "Vellis")の
//! // 項目スライスで `&about` の**直後**、その次が区切り線(`PredefinedMenuItem::separator` で束ねた項目)。
//! // accelerator は `None`。File / Edit / View / Go / Window には出さない。
//! // `CHECK_FOR_UPDATES_ITEM_ID` を渡す `MenuItem::with_id(app, CHECK_FOR_UPDATES_ITEM_ID, "Check for Updates…", true, None::<&str>)`
//! // は 1 つだけ(束縛名は裁量。本テストはその呼び出しから `let` を遡って束縛名を取る。定数をハンドラ等で別途使うのは可)。
//! // lib.rs: `id if id == menu::CHECK_FOR_UPDATES_ITEM_ID => menu::handle_check_for_updates_click(app_handle)`(関数名は裁量)
//! ```

use std::io;

use vellis_lib::channel::Channel;
use vellis_lib::menu::CHECK_FOR_UPDATES_ITEM_ID;
use vellis_lib::update_check::{
    channel_allows_check, manual_check_dialog, manual_check_outcome, should_check,
    should_check_on, CheckTrigger, ManualCheckDialog, ManualCheckOutcome, ReleaseInfo,
    UpdateCheckError, CHECK_INTERVAL_SECS,
};

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/// 日本語(CJK)の検知(要件#35 と同じ範囲)。"…"(U+2026)・"'"(U+2019)は英語 UI でも使う記号なので対象外。
fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| {
        matches!(c,
            '\u{3000}'..='\u{30FF}'
                | '\u{4E00}'..='\u{9FFF}'
                | '\u{FF00}'..='\u{FFEF}'
        )
    })
}

fn release(tag: &str, url: &str) -> Result<ReleaseInfo, UpdateCheckError> {
    Ok(ReleaseInfo {
        tag_name: tag.to_string(),
        html_url: url.to_string(),
    })
}

const RELEASE_URL: &str = "https://github.com/firstfournotes/vellis/releases/tag/v0.5.0";

/// 行ごとに `//` 以降(コメント)を落としたコード部分を連結して返す。`://` は落とさない
/// (acceptance_req65 の写し)。
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

fn menu_rs_code() -> String {
    strip_line_comments(include_str!("../src/menu.rs"))
}

fn lib_rs_code() -> String {
    strip_line_comments(include_str!("../src/lib.rs"))
}

/// `start` から最初の `(` に対応する閉じ括弧までの呼び出し全体(acceptance_req60 の写し)。
fn balanced_call(code: &str, start: usize) -> &str {
    let open = code[start..].find('(').expect("call must have '('") + start;
    let mut depth = 0usize;
    for (i, c) in code[open..].char_indices() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => {
                depth -= 1;
                if depth == 0 {
                    return &code[start..=open + i];
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced call starting at byte {start}");
}

fn first_string_literal(s: &str) -> Option<&str> {
    let a = s.find('"')? + 1;
    let b = s[a..].find('"')? + a;
    Some(&s[a..b])
}

fn submenu_call_with_label<'a>(code: &'a str, label: &str) -> Option<&'a str> {
    let mut search = 0;
    while let Some(rel) = code[search..].find("Submenu::with_") {
        let start = search + rel;
        let call = balanced_call(code, start);
        search = start + "Submenu::with_".len();
        if first_string_literal(call) == Some(label) {
            return Some(call);
        }
    }
    None
}

/// Submenu 呼び出しの項目スライス(`&[…]`)の識別子列(`&name` の name)。
fn slice_idents(call: &str) -> Vec<String> {
    let open = call.find("&[").expect("Submenu::with_items must take a slice");
    let end = call[open..].find(']').expect("slice must close") + open;
    call[open + 2..end]
        .split(',')
        .map(|s| s.trim().trim_start_matches('&').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// `const_name` を渡している `MenuItem::with_id(…)` の呼び出しの開始位置と呼び出し全体。
/// 定数がほかの場所(ハンドラ等)で使われていても、MenuItem::with_id の呼び出しだけを見る。
fn item_call_at<'a>(code: &'a str, const_name: &str) -> (usize, &'a str) {
    let mut search = 0;
    let mut found = None;
    while let Some(rel) = code[search..].find("MenuItem::with_id") {
        let start = search + rel;
        let call = balanced_call(code, start);
        search = start + "MenuItem::with_id".len();
        if call.contains(const_name) {
            assert!(found.is_none(), "{const_name} must bind exactly one MenuItem");
            found = Some((start, call));
        }
    }
    found.unwrap_or_else(|| panic!("{const_name} must be passed to MenuItem::with_id"))
}

fn item_call<'a>(code: &'a str, const_name: &str) -> &'a str {
    item_call_at(code, const_name).1
}

/// `const_name` で束ねられた MenuItem の束縛名(`let xxx = MenuItem::with_id(app, CONST, …)`)。
fn item_binding<'a>(code: &'a str, const_name: &str) -> &'a str {
    let (call_pos, _) = item_call_at(code, const_name);
    let let_pos = code[..call_pos]
        .rfind("let ")
        .unwrap_or_else(|| panic!("{const_name} must be used inside a let binding"));
    code[let_pos + 4..call_pos]
        .split(|c: char| c == '=' || c.is_whitespace())
        .find(|s| !s.is_empty())
        .expect("binding name after `let`")
}

fn app_menu_idents(code: &str) -> Vec<String> {
    let first_call = balanced_call(
        code,
        code.find("Submenu::with_")
            .expect("menu.rs must build at least one submenu"),
    );
    assert_eq!(
        first_string_literal(first_call),
        Some("Vellis"),
        "the App menu is the first submenu"
    );
    slice_idents(first_call)
}

// ---------------------------------------------------------------------------
// AC-67-1 — 起動時の判定は最終チェック時刻にかかわらず「要チェック」(契約1・5)
// ---------------------------------------------------------------------------

/// 1. 最終チェック時刻が無い・0秒前・1時間前・6時間の1秒前・6時間以上前・未来(時計の巻き戻り)
///    のいずれでも、起動時は要チェック。
#[test]
fn startup_trigger_always_requires_a_check() {
    let now = 1_700_000_000_i64;
    let cases: [(Option<i64>, &str); 7] = [
        (None, "never checked"),
        (Some(now), "checked 0 seconds ago"),
        (Some(now - 60 * 60), "checked 1 hour ago"),
        (Some(now - CHECK_INTERVAL_SECS + 1), "checked one second short of 6 hours ago"),
        (Some(now - CHECK_INTERVAL_SECS), "checked exactly 6 hours ago"),
        (Some(now - 7 * 24 * 60 * 60), "checked 7 days ago"),
        (Some(now + 100), "last check is in the future (clock went backwards)"),
    ];
    for (last, label) in cases {
        assert!(
            should_check_on(CheckTrigger::Startup, last, now),
            "a launch must always check ({label})"
        );
    }
}

/// 2. 起動時の判定は now の値にも依らない(0 でも負でも要チェック)。
#[test]
fn startup_trigger_does_not_depend_on_the_clock() {
    for now in [0_i64, -1, 1, 1_700_000_000, i64::MAX] {
        assert!(should_check_on(CheckTrigger::Startup, None, now));
        assert!(should_check_on(CheckTrigger::Startup, Some(now), now));
        assert!(should_check_on(CheckTrigger::Startup, Some(i64::MAX), now));
    }
}

// ---------------------------------------------------------------------------
// AC-67-2 — 周期の判定は `should_check` と同じ答え(契約2・5)
// ---------------------------------------------------------------------------

/// 3. Poll は同じ入力で `should_check` と同じ答え(境界と巻き戻りを含む表で照合)。
#[test]
fn poll_trigger_matches_should_check_on_every_input() {
    let last = 1_700_000_000_i64;
    let table: [(Option<i64>, i64); 9] = [
        (None, 0),
        (None, last),
        (Some(last), last),
        (Some(last), last + 1),
        (Some(last), last + CHECK_INTERVAL_SECS - 1),
        (Some(last), last + CHECK_INTERVAL_SECS),
        (Some(last), last + CHECK_INTERVAL_SECS + 1),
        (Some(last), last + 7 * 24 * 60 * 60),
        (Some(last), last - 100),
    ];
    for (last_check, now) in table {
        assert_eq!(
            should_check_on(CheckTrigger::Poll, last_check, now),
            should_check(last_check, now),
            "Poll must agree with should_check for last={last_check:?}, now={now}"
        );
    }
}

/// 4. 周期の判定の中身: 6時間ちょうどで要チェック・1秒前で見送り・未チェックは要(契約2)。
#[test]
fn poll_trigger_keeps_the_six_hour_rule() {
    let last = 1_700_000_000_i64;
    assert!(should_check_on(CheckTrigger::Poll, None, last));
    assert!(should_check_on(CheckTrigger::Poll, Some(last), last + CHECK_INTERVAL_SECS));
    assert!(!should_check_on(CheckTrigger::Poll, Some(last), last + CHECK_INTERVAL_SECS - 1));
    assert!(!should_check_on(CheckTrigger::Poll, Some(last), last));
    assert!(!should_check_on(CheckTrigger::Poll, Some(last), last - 100));
    assert_eq!(CHECK_INTERVAL_SECS, 6 * 60 * 60, "the interval stays at 6 hours (契約11)");
}

/// 5. トリガは Startup と Poll の2つだけ(網羅 match =コンパイル時の固定)。
#[test]
fn check_trigger_has_exactly_startup_and_poll() {
    for trigger in [CheckTrigger::Startup, CheckTrigger::Poll] {
        let expect_always = match trigger {
            CheckTrigger::Startup => true,
            CheckTrigger::Poll => false,
        };
        // 6時間の1秒前: Startup だけが要チェック。
        assert_eq!(
            should_check_on(trigger, Some(1_700_000_000), 1_700_000_000 + CHECK_INTERVAL_SECS - 1),
            expect_always,
            "{trigger:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// AC-67-3 — 自動の確認の門は dev=false / release=true のまま(契約9・11)
// ---------------------------------------------------------------------------

/// 6. `channel_allows_check` は自動の確認の門として変わらない(メニューの確認はこれを通らない=reviewer 照合)。
#[test]
fn automatic_check_gate_is_unchanged() {
    assert!(!channel_allows_check(Channel::Dev), "automatic checks stay off on dev");
    assert!(channel_allows_check(Channel::Release), "automatic checks stay on for release");
}

// ---------------------------------------------------------------------------
// AC-67-6 — 結果の振り分け(契約8)
// ---------------------------------------------------------------------------

/// 7. 新しい版の tag → Available。version は先頭の `v` を除いた `x.y.z`・url は `html_url`。
#[test]
fn newer_release_is_available_with_bare_version_and_html_url() {
    assert_eq!(
        manual_check_outcome(release("v0.5.0", RELEASE_URL), "0.4.0"),
        ManualCheckOutcome::Available {
            version: "0.5.0".to_string(),
            url: RELEASE_URL.to_string(),
        }
    );
    assert_eq!(
        manual_check_outcome(release("0.5.0", RELEASE_URL), "0.4.0"),
        ManualCheckOutcome::Available {
            version: "0.5.0".to_string(),
            url: RELEASE_URL.to_string(),
        },
        "a bare tag (no v prefix) must also count as available"
    );
    assert_eq!(
        manual_check_outcome(release("v0.4.10", RELEASE_URL), "0.4.9"),
        ManualCheckOutcome::Available {
            version: "0.4.10".to_string(),
            url: RELEASE_URL.to_string(),
        },
        "the compare is numeric (0.4.10 > 0.4.9), same as is_newer"
    );
}

/// 8. 同じ版・古い版 → UpToDate { current }(current は渡した文字列そのまま)。
#[test]
fn same_or_older_release_is_up_to_date() {
    for tag in ["v0.4.0", "0.4.0", "v0.3.9", "v0.3.99", "0.0.1"] {
        assert_eq!(
            manual_check_outcome(release(tag, RELEASE_URL), "0.4.0"),
            ManualCheckOutcome::UpToDate {
                current: "0.4.0".to_string()
            },
            "tag {tag:?} is not newer than 0.4.0"
        );
    }
}

/// 9. 取得の失敗(Err)→ Failed。エラーの種類を問わない。
#[test]
fn fetch_error_is_failed() {
    let errors: Vec<UpdateCheckError> = vec![
        UpdateCheckError::EmptyTagName,
        UpdateCheckError::Io(io::Error::new(io::ErrorKind::TimedOut, "timed out")),
        UpdateCheckError::Io(io::Error::new(io::ErrorKind::NotConnected, "offline")),
        UpdateCheckError::Json(serde_json::from_str::<serde_json::Value>("{{{").unwrap_err()),
    ];
    for err in errors {
        let label = format!("{err}");
        assert_eq!(
            manual_check_outcome(Err(err), "0.4.0"),
            ManualCheckOutcome::Failed,
            "an Err from the fetch must be Failed ({label})"
        );
    }
}

/// 10. 版の番号が `x.y.z` で読めない tag → Failed(`is_newer` の偽を「最新」と言わない=契約8)。
#[test]
fn unreadable_version_tag_is_failed_not_up_to_date() {
    for tag in ["nightly", "1.2", "1.2.3.4", "0.5.0-rc1", "v", "abc", "0.1.x"] {
        assert_eq!(
            manual_check_outcome(release(tag, RELEASE_URL), "0.4.0"),
            ManualCheckOutcome::Failed,
            "an unreadable tag {tag:?} must be Failed, never UpToDate"
        );
    }
}

/// 11. 結果は Available / UpToDate / Failed の3つだけ(網羅 match =コンパイル時の固定)。
#[test]
fn manual_check_outcome_has_exactly_three_variants() {
    let outcomes = [
        manual_check_outcome(release("v0.5.0", RELEASE_URL), "0.4.0"),
        manual_check_outcome(release("v0.4.0", RELEASE_URL), "0.4.0"),
        manual_check_outcome(Err(UpdateCheckError::EmptyTagName), "0.4.0"),
    ];
    let kinds: Vec<&str> = outcomes
        .iter()
        .map(|o| match o {
            ManualCheckOutcome::Available { version, url } => {
                assert_eq!(version, "0.5.0");
                assert_eq!(url, RELEASE_URL);
                "available"
            }
            ManualCheckOutcome::UpToDate { current } => {
                assert_eq!(current, "0.4.0");
                "up-to-date"
            }
            ManualCheckOutcome::Failed => "failed",
        })
        .collect();
    assert_eq!(kinds, ["available", "up-to-date", "failed"]);
}

// ---------------------------------------------------------------------------
// AC-67-7 — ダイアログの文言(契約8)
// ---------------------------------------------------------------------------

fn available_dialog() -> ManualCheckDialog {
    manual_check_dialog(
        &ManualCheckOutcome::Available {
            version: "0.5.0".to_string(),
            url: RELEASE_URL.to_string(),
        },
        "0.4.0",
    )
}

fn up_to_date_dialog() -> ManualCheckDialog {
    manual_check_dialog(
        &ManualCheckOutcome::UpToDate {
            current: "0.4.0".to_string(),
        },
        "0.4.0",
    )
}

fn failed_dialog() -> ManualCheckDialog {
    manual_check_dialog(&ManualCheckOutcome::Failed, "0.4.0")
}

/// 12. 新しい版あり: タイトル固定・本文は新しい版と今の版の両方を含む・ボタンは Download(既定)/ Later。
#[test]
fn available_dialog_names_both_versions_and_offers_download_or_later() {
    let dialog = available_dialog();
    assert_eq!(dialog.title, "A new version of Vellis is available");
    assert_eq!(dialog.body, "Vellis v0.5.0 is available. You have v0.4.0.");
    assert!(dialog.body.contains("0.5.0"), "body names the new version: {}", dialog.body);
    assert!(dialog.body.contains("0.4.0"), "body names the current version: {}", dialog.body);
    assert_eq!(dialog.buttons, ["Download", "Later"], "Download is the default (first) button");
}

/// 13. 最新: タイトル固定・本文は今の版を含む・ボタンは OK だけ。
#[test]
fn up_to_date_dialog_names_the_current_version_with_ok() {
    let dialog = up_to_date_dialog();
    assert_eq!(dialog.title, "You're up to date");
    assert_eq!(dialog.body, "Vellis v0.4.0 is the latest version.");
    assert!(dialog.body.contains("0.4.0"), "body names the current version: {}", dialog.body);
    assert_eq!(dialog.buttons, ["OK"]);
}

/// 14. 失敗: タイトル固定・本文は理由の細部を出さない定型文・ボタンは OK だけ。
#[test]
fn failed_dialog_is_generic_with_ok() {
    let dialog = failed_dialog();
    assert_eq!(dialog.title, "Couldn't check for updates");
    assert_eq!(dialog.body, "Check your internet connection and try again.");
    assert_eq!(dialog.buttons, ["OK"]);
    assert!(!dialog.body.contains("0.4.0"), "no version in the failure body");
}

/// 15. 3通りとも英語(CJK を含まない)。タイトル・本文・ボタンのどれにも。
#[test]
fn every_dialog_is_english() {
    for dialog in [available_dialog(), up_to_date_dialog(), failed_dialog()] {
        assert!(!has_cjk(&dialog.title), "title is English: {}", dialog.title);
        assert!(!has_cjk(&dialog.body), "body is English: {}", dialog.body);
        assert!(!dialog.title.is_empty() && !dialog.body.is_empty());
        for button in &dialog.buttons {
            assert!(!has_cjk(button), "button label is English: {button}");
        }
    }
}

/// 16. 振り分けから文言まで一続きで通る(取得結果 → outcome → dialog の合成)。
#[test]
fn outcome_composes_into_dialog() {
    let outcome = manual_check_outcome(release("v0.5.0", RELEASE_URL), "0.4.0");
    let dialog = manual_check_dialog(&outcome, "0.4.0");
    assert_eq!(dialog.title, "A new version of Vellis is available");
    assert_eq!(dialog.buttons, ["Download", "Later"]);

    let outcome = manual_check_outcome(release("weird-tag", RELEASE_URL), "0.4.0");
    let dialog = manual_check_dialog(&outcome, "0.4.0");
    assert_eq!(dialog.title, "Couldn't check for updates");
}

// ---------------------------------------------------------------------------
// AC-67-4 — menu.rs の App メニュー(契約6)
// ---------------------------------------------------------------------------

/// 17. ID 定数は kebab-case で固定(settings / go-to-path と同じ家風)。
#[test]
fn check_for_updates_item_id_is_fixed() {
    assert_eq!(CHECK_FOR_UPDATES_ITEM_ID, "check-for-updates");
}

/// 18. ラベル "Check for Updates…"(三点は U+2026 の1文字)が menu.rs のコード行に文字列リテラルとして在る。
///     3ドット("...")の綴りは使わない。
#[test]
fn menu_rs_declares_the_check_for_updates_label_with_an_ellipsis() {
    let code = menu_rs_code();
    assert!(
        code.contains("\"Check for Updates\u{2026}\""),
        "menu.rs must carry the literal \"Check for Updates…\" (U+2026)"
    );
    assert!(
        !code.contains("\"Check for Updates...\""),
        "menu.rs must not spell the ellipsis as three dots"
    );
}

/// 19. ID 定数がインラインリテラルではなく実際に使われている(宣言+ MenuItem::with_id への使用)。
#[test]
fn menu_rs_declares_and_uses_the_item_id_constant() {
    let code = menu_rs_code();
    let count = code.matches("CHECK_FOR_UPDATES_ITEM_ID").count();
    assert!(count >= 2, "menu.rs must declare AND use CHECK_FOR_UPDATES_ITEM_ID (found {count})");
    let call = item_call(&code, "CHECK_FOR_UPDATES_ITEM_ID");
    assert!(
        call.contains("\"Check for Updates\u{2026}\""),
        "the MenuItem bound to CHECK_FOR_UPDATES_ITEM_ID carries the label: {call}"
    );
}

/// 20. ショートカットは付けない: 同じ MenuItem::with_id の accelerator 引数が None。
#[test]
fn check_for_updates_item_has_no_accelerator() {
    let code = menu_rs_code();
    let call = item_call(&code, "CHECK_FOR_UPDATES_ITEM_ID");
    assert!(call.contains("None"), "the accelerator argument must be None: {call}");
    assert!(!call.contains("Some("), "the item must not register an accelerator: {call}");
    assert!(
        !code.contains("CHECK_FOR_UPDATES_ACCELERATOR"),
        "no accelerator constant for Check for Updates…"
    );
}

/// 21. App メニュー(最初の Submenu・ラベル "Vellis")の項目列で `&about` の**直後**にあり、
///     その次の項目が区切り線(最初の区切り線より上)。Settings… と Quit より前。
#[test]
fn app_menu_places_the_item_right_under_about_and_above_the_first_separator() {
    let code = menu_rs_code();
    let idents = app_menu_idents(&code);
    let item = item_binding(&code, "CHECK_FOR_UPDATES_ITEM_ID");

    let about_at = idents.iter().position(|s| s == "about").expect("App menu must still hold &about");
    let item_at = idents
        .iter()
        .position(|s| s == item)
        .unwrap_or_else(|| panic!("App menu must hold &{item} (Check for Updates…): {idents:?}"));
    assert_eq!(item_at, about_at + 1, "Check for Updates… sits right under About Vellis: {idents:?}");

    let next = idents
        .get(item_at + 1)
        .unwrap_or_else(|| panic!("something must follow &{item}: {idents:?}"));
    assert!(
        code.contains(&format!("let {next} = PredefinedMenuItem::separator(")),
        "the item after Check for Updates… must be a separator (found `{next}`): {idents:?}"
    );

    let settings = item_binding(&code, "SETTINGS_ITEM_ID");
    let settings_at = idents.iter().position(|s| s == settings).expect("App menu must hold Settings…");
    let quit_at = idents.iter().position(|s| s == "quit").expect("App menu must still hold &quit");
    assert!(item_at < settings_at, "Check for Updates… comes before Settings…: {idents:?}");
    assert!(item_at < quit_at, "Check for Updates… comes before Quit: {idents:?}");
}

/// 22. File / Edit / View / Go / Window のメニューには出さない。
#[test]
fn other_menus_do_not_hold_the_item() {
    let code = menu_rs_code();
    let item = item_binding(&code, "CHECK_FOR_UPDATES_ITEM_ID");
    for label in ["File", "Edit", "View", "Go", "Window"] {
        let call = submenu_call_with_label(&code, label)
            .unwrap_or_else(|| panic!("menu.rs must build a submenu labelled {label:?}"));
        assert!(!call.contains(&format!("&{item}")), "{label} menu must not hold &{item}");
        assert!(
            !call.contains("CHECK_FOR_UPDATES_ITEM_ID"),
            "{label} menu must not reference CHECK_FOR_UPDATES_ITEM_ID"
        );
    }
    assert!(
        submenu_call_with_label(&code, "Help").is_none(),
        "no Help menu is added (the bar stays Vellis / File / Edit / View / Go / Window)"
    );
}

/// 23. ラベルが1か所だけ(同じ項目を2つのメニューに出さない)。
#[test]
fn the_label_appears_once_in_menu_rs() {
    let code = menu_rs_code();
    assert_eq!(
        code.matches("\"Check for Updates\u{2026}\"").count(),
        1,
        "the label literal appears exactly once"
    );
}

// ---------------------------------------------------------------------------
// AC-67-5 — lib.rs の `on_menu_event` が ID を扱う(契約6)
// ---------------------------------------------------------------------------

/// 24. lib.rs が `menu::CHECK_FOR_UPDATES_ITEM_ID` を `on_menu_event` の中で照合する。
#[test]
fn lib_rs_dispatches_the_check_for_updates_item() {
    let lib = lib_rs_code();
    let handler_at = lib.find("on_menu_event").expect("lib.rs must install on_menu_event");
    let after = &lib[handler_at..];
    assert!(
        after.contains("menu::CHECK_FOR_UPDATES_ITEM_ID"),
        "on_menu_event must match on menu::CHECK_FOR_UPDATES_ITEM_ID"
    );
    assert!(
        after.contains("id if id == menu::CHECK_FOR_UPDATES_ITEM_ID"),
        "the dispatch uses the same `id if id == menu::…` arm shape as the other items"
    );
}
