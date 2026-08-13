//! 要件#14 の受け入れテスト(requirements.md #14)— Rust 層
//!
//! 「新しいバージョンが GitHub Releases に公開されたら、起動時および起動中の
//! 定期チェックで検知しアプリ内に通知を表示する(更新の適用は行わない。
//! 「ダウンロード」で Releases ページを既定ブラウザで開く)」
//!
//! 契約(2026-08-11 由谷決定。検討記録=docs/update-notification.md §7):
//! - 情報源=GET https://api.github.com/repos/firstfournotes/product-vellis/
//!   releases/latest の tag_name
//! - 比較=先頭 v を除いた x.y.z と CARGO_PKG_VERSION の数値比較で
//!   **厳密に新しいときだけ**通知(同値・降格・パース不能は通知しない)
//! - トリガ=起動時1回+前回チェックから6時間以上経過で再チェック
//!   (単純 interval でなく経過時間判定=スリープ復帰対応)
//! - 配信=Rust 側から全ウインドウへ update_available { version, url } を emit
//! - 失敗時=タイムアウト/不通/パース失敗は warn ログのみ(fail open)
//! - channel=dev ではチェックしない
//! - 永続化=最終チェック時刻のみ(app_config_dir 配下 JSON・破損は
//!   「未チェック」へフォールバック=history.rs の家風)
//!
//! 判定範囲(本ファイル): 判定ロジックと永続化ストアの契約のみ。すべて入力を
//! 引数で受ける純関数/構造体で、**ネットワーク・実時間・AppHandle に一切
//! 依存しない**。HTTP 取得(タイムアウト・warn ログ)・ポーラーの起動配線・
//! emit と listen の対応・バナー UI・opener は reviewer 照合、実 Release での
//! バナー表示・ブラウザ起動・複数窓・オフライン無害性は人間ゲート
//! (acceptance/acceptance.md)。
//!
//! ## 確定契約(implementer はこれに従う。実装先: src-tauri/src/update_check.rs、
//! ## lib.rs に `pub mod update_check;` を追加)
//!
//! ```ignore
//! use crate::channel::Channel;
//!
//! /// 再チェック間隔(6時間)を秒で固定する。
//! pub const CHECK_INTERVAL_SECS: i64 = 6 * 60 * 60;
//!
//! /// remote_tag(GitHub の tag_name。先頭 v は任意)が current
//! /// (CARGO_PKG_VERSION 形式の x.y.z)より**厳密に新しい**ときだけ true。
//! /// 同値・降格は false。どちらかが x.y.z の数値3成分としてパースできない
//! /// 場合も false(パース不能は通知しない)。数値比較であること
//! /// (文字列比較では 0.1.10 < 0.1.9 になる)。
//! pub fn is_newer(remote_tag: &str, current: &str) -> bool;
//!
//! /// 前回チェック時刻(unix 秒。None=未チェック)と現在時刻(unix 秒)から
//! /// チェック要否を返す。未チェック=要。経過が CHECK_INTERVAL_SECS 以上=要。
//! /// 未満=不要。現在時刻を引数で受けるため実時間・スリープに依存しない
//! /// (スリープ復帰は「大きく経過した now を渡す」ことに還元される)。
//! pub fn should_check(last_check_unix: Option<i64>, now_unix: i64) -> bool;
//!
//! /// channel=dev ではチェックしない(開発・テスト中に外部通信を走らせない)。
//! /// Release=true / Dev=false。
//! pub fn channel_allows_check(channel: Channel) -> bool;
//!
//! /// releases/latest レスポンスから通知に要る2値を取り出したもの。
//! /// tag_name は生のまま(先頭 v を剥がさない — 剥がすのは比較側の責務)。
//! /// emit ペイロード { version, url } への写像は実装側(reviewer 照合)。
//! pub struct ReleaseInfo {
//!     pub tag_name: String,
//!     pub html_url: String,
//! }
//!
//! /// releases/latest のレスポンスボディをパースする。tag_name 欠落・
//! /// 空文字列・不正 JSON はいずれも Err(panic しない)。GitHub の実
//! /// レスポンスに大量にある未知フィールドは無視して成功すること。
//! pub fn parse_latest_release(body: &str) -> Result<ReleaseInfo, E>;
//!     // E: Debug(型は実装自由)
//!
//! /// 最終チェック時刻(unix 秒)だけを保存する永続化ストア
//! /// (history.rs の家風: 保存先パス注入・JSON・atomic write 推奨・
//! /// 読みは呼び出し側を失敗させない)。
//! pub struct LastCheckStore { /* 実装自由 */ }
//!
//! impl LastCheckStore {
//!     /// 保存先ファイルパスを注入して構築する。ファイル・親ディレクトリが
//!     /// 未存在でもエラーにしない(生成は保存時まで遅延)ため infallible。
//!     pub fn new(file: &Path) -> LastCheckStore;
//!
//!     /// 最終チェック時刻(unix 秒)。ファイル不在・破損はいずれも
//!     /// None=「未チェック」へフォールバック(エラーで呼び出し側を
//!     /// 失敗させない。warn ログは実装側)。
//!     pub fn last_check(&self) -> Option<i64>;
//!
//!     /// 最終チェック時刻を即座に永続化する。保存先の親ディレクトリが
//!     /// 無ければ作成する。
//!     pub fn set_last_check(&self, unix_secs: i64) -> Result<(), E>;
//! }
//! ```
//!
//! ## reviewer 照合に委ねる項目(機械判定不能な配線)
//! - HTTP 取得(reqwest/ureq いずれか1つの依存追加・タイムアウト5秒程度・
//!   失敗は warn ログのみで UI に出さない)
//! - ポーラーの起動配線(起動時1回+周期判定が should_check /
//!   channel_allows_check / LastCheckStore を通ること・保存先が
//!   app_config_dir 配下であること)
//! - 全ウインドウへの update_available { version, url } emit と
//!   フロント listen・バナーの +page.svelte 組み込み・opener 起動
//!
//! ## 人間ゲート(acceptance/acceptance.md)
//! - 実 Release 公開状態でのバナー表示・「ダウンロード」でブラウザが
//!   Releases ページを開くこと・複数窓の出方・オフライン無害性・バナーの視覚

use std::fs;

use tempfile::TempDir;

use vellis_lib::channel::Channel;
use vellis_lib::update_check::{
    channel_allows_check, is_newer, parse_latest_release, should_check,
    LastCheckStore, CHECK_INTERVAL_SECS,
};

// ---------------------------------------------------------------------------
// 1. バージョン比較の純関数(is_newer)
// ---------------------------------------------------------------------------

/// 1-1. 新しいリモート版は通知する。tag_name の先頭 v は剥がして比較する。
#[test]
fn newer_remote_with_v_prefix_notifies() {
    assert!(
        is_newer("v0.1.22", "0.1.21"),
        "a strictly newer remote tag (with the v prefix) must notify"
    );
    assert!(
        is_newer("v1.0.0", "0.9.9"),
        "a major bump must notify"
    );
    assert!(
        is_newer("v0.2.0", "0.1.21"),
        "a minor bump must notify even when the patch number goes down"
    );
}

/// 1-2. 先頭 v なしの tag も扱える(GitHub のタグ運用が変わっても比較できる)。
#[test]
fn remote_without_v_prefix_is_accepted() {
    assert!(
        is_newer("0.1.22", "0.1.21"),
        "a bare x.y.z remote tag (no v prefix) must still compare"
    );
    assert!(
        !is_newer("0.1.21", "0.1.21"),
        "a bare equal tag must not notify"
    );
}

/// 1-3. 同値は通知しない(「厳密に新しいときだけ」)。
#[test]
fn equal_version_does_not_notify() {
    assert!(!is_newer("v0.1.21", "0.1.21"), "same version must not notify");
}

/// 1-4. 降格(リモートが古い)は通知しない。
#[test]
fn older_remote_does_not_notify() {
    assert!(!is_newer("v0.1.20", "0.1.21"), "a downgrade must not notify");
    assert!(
        !is_newer("v0.0.99", "0.1.21"),
        "an older minor must not notify regardless of a large patch number"
    );
}

/// 1-5. 数値比較であること: 2桁への繰り上がりで文字列比較は逆転する
///      ("0.1.10" < "0.1.9" lexicographically)。各成分で確認する。
#[test]
fn numeric_compare_handles_multi_digit_components() {
    assert!(is_newer("0.1.10", "0.1.9"), "patch 9 -> 10 must notify");
    assert!(is_newer("v0.10.0", "0.9.9"), "minor 9 -> 10 must notify");
    assert!(is_newer("v10.0.0", "9.9.9"), "major 9 -> 10 must notify");
    assert!(!is_newer("0.1.9", "0.1.10"), "patch 10 -> 9 is a downgrade");
    assert!(!is_newer("v0.9.9", "0.10.0"), "minor 10 -> 9 is a downgrade");
}

/// 1-6. リモート側がパース不能(x.y.z の数値3成分でない)なら通知しない。
#[test]
fn malformed_remote_never_notifies() {
    for tag in [
        "1.2",         // 2成分
        "1.2.3.4",     // 4成分
        "abc",         // 非数値
        "0.1.x",       // 成分が非数値
        "0.1.22-rc1",  // x.y.z 厳密形でない(prerelease は GitHub 側で除外済み)
        "",            // 空
        "v",           // v のみ
    ] {
        assert!(
            !is_newer(tag, "0.1.21"),
            "unparsable remote tag {tag:?} must not notify (fail closed)"
        );
    }
}

/// 1-7. 自バージョン側がパース不能でも通知しない(panic もしない)。
#[test]
fn malformed_current_never_notifies() {
    assert!(
        !is_newer("0.2.0", "garbage"),
        "an unparsable current version must not notify"
    );
    assert!(!is_newer("0.2.0", ""), "an empty current version must not notify");
}

// ---------------------------------------------------------------------------
// 2. チェック要否の純関数(should_check)— 現在時刻は引数で渡す
// ---------------------------------------------------------------------------

/// 2-1. 契約は間隔を6時間に固定する。
#[test]
fn interval_constant_is_six_hours() {
    assert_eq!(
        CHECK_INTERVAL_SECS,
        6 * 60 * 60,
        "contract fixes the re-check interval at 6 hours"
    );
}

/// 2-2. 未チェック(初回)は要チェック。
#[test]
fn never_checked_requires_check() {
    assert!(
        should_check(None, 1_700_000_000),
        "a first launch (no persisted last check) must check"
    );
    assert!(
        should_check(None, 0),
        "never-checked must not depend on the value of now"
    );
}

/// 2-3. 6時間以上経過=要チェック。境界(ちょうど6時間)も「以上」に含む。
///      スリープ復帰は「大きく経過した now」に還元される(実時間に依存しない)。
#[test]
fn six_hours_elapsed_requires_check() {
    let last = 1_700_000_000_i64;
    assert!(
        should_check(Some(last), last + CHECK_INTERVAL_SECS),
        "exactly 6h elapsed must check (the contract says 6h *or more*)"
    );
    assert!(
        should_check(Some(last), last + CHECK_INTERVAL_SECS + 1),
        "just over 6h must check"
    );
    assert!(
        should_check(Some(last), last + 7 * 24 * 60 * 60),
        "a long sleep/resume gap (7 days) must check — elapsed-time \
         judgement, not a live interval timer"
    );
}

/// 2-4. 6時間未満=不要。時計の巻き戻り(now < last)も「6時間以上経過」
///      ではないので不要。
#[test]
fn under_six_hours_does_not_require_check() {
    let last = 1_700_000_000_i64;
    assert!(
        !should_check(Some(last), last + CHECK_INTERVAL_SECS - 1),
        "one second short of 6h must not check"
    );
    assert!(
        !should_check(Some(last), last),
        "zero elapsed must not check"
    );
    assert!(
        !should_check(Some(last), last - 100),
        "a clock that went backwards has not elapsed 6h — must not check"
    );
}

// ---------------------------------------------------------------------------
// 3. GitHub releases/latest レスポンスのパース(parse_latest_release)
// ---------------------------------------------------------------------------

/// 3-1. 正常形: tag_name と html_url が取れる。GitHub の実レスポンスにある
///      未知フィールドは無視される(deny_unknown_fields で壊れない)。
#[test]
fn parses_tag_and_url_from_realistic_response() {
    let body = r#"{
        "url": "https://api.github.com/repos/firstfournotes/product-vellis/releases/241119",
        "id": 241119,
        "tag_name": "v0.1.22",
        "target_commitish": "main",
        "name": "v0.1.22",
        "draft": false,
        "prerelease": false,
        "html_url": "https://github.com/firstfournotes/product-vellis/releases/tag/v0.1.22",
        "body": "release notes here",
        "assets": [{"name": "Vellis_0.1.22_aarch64.dmg", "size": 1}]
    }"#;

    let info = parse_latest_release(body)
        .expect("a realistic releases/latest body must parse");
    assert_eq!(
        info.tag_name, "v0.1.22",
        "tag_name must come through verbatim (v prefix kept for the compare side)"
    );
    assert_eq!(
        info.html_url,
        "https://github.com/firstfournotes/product-vellis/releases/tag/v0.1.22",
        "html_url is the page the Download button opens"
    );
}

/// 3-2. パース結果が比較関数へそのまま流れる(v 付き tag_name を is_newer が
///      受ける)— 検知パイプラインの合成が成立すること。
#[test]
fn parsed_tag_feeds_version_compare() {
    let body = r#"{"tag_name": "v0.1.22", "html_url": "https://example.invalid/r"}"#;
    let info = parse_latest_release(body).expect("minimal valid body must parse");
    assert!(
        is_newer(&info.tag_name, "0.1.21"),
        "the parsed tag must be directly comparable against CARGO_PKG_VERSION"
    );
    assert!(
        !is_newer(&info.tag_name, "0.1.22"),
        "the parsed tag must not notify against the same version"
    );
}

/// 3-3. tag_name 欠落はエラーで返る(panic しない)。
#[test]
fn missing_tag_name_is_error() {
    let body = r#"{"html_url": "https://example.invalid/r"}"#;
    assert!(
        parse_latest_release(body).is_err(),
        "a body without tag_name must be an error, not a panic"
    );
}

/// 3-4. tag_name が空文字列でもエラーで返る(空 tag で通知経路に進ませない)。
#[test]
fn empty_tag_name_is_error() {
    let body = r#"{"tag_name": "", "html_url": "https://example.invalid/r"}"#;
    assert!(
        parse_latest_release(body).is_err(),
        "an empty tag_name must be an error"
    );
}

/// 3-5. 不正 JSON・JSON だが object でない形はエラーで返る(panic しない)。
#[test]
fn invalid_json_is_error() {
    assert!(
        parse_latest_release("this is not json {{{").is_err(),
        "garbage must be an error, not a panic"
    );
    assert!(
        parse_latest_release("").is_err(),
        "an empty body must be an error"
    );
    assert!(
        parse_latest_release("[]").is_err(),
        "a non-object JSON body must be an error"
    );
}

// ---------------------------------------------------------------------------
// 4. 最終チェック時刻ストア(LastCheckStore)— history.rs の家風
// ---------------------------------------------------------------------------

/// 4-1. ファイル不在(初回)=「未チェック」。親ディレクトリごと無くても同様
///      (初回起動で config dir が無いケース)。エラーにも panic にもならない。
#[test]
fn missing_file_means_never_checked() {
    let tmp = TempDir::new().unwrap();
    let store = LastCheckStore::new(&tmp.path().join("update-check.json"));
    assert_eq!(
        store.last_check(),
        None,
        "a missing store file must read as never-checked"
    );

    let nested = tmp.path().join("no-such-dir").join("update-check.json");
    let store = LastCheckStore::new(&nested);
    assert_eq!(
        store.last_check(),
        None,
        "a missing parent directory must also read as never-checked"
    );
}

/// 4-2. 往復: 保存した時刻が別インスタンスから読み戻せる。保存先の親
///      ディレクトリは保存時に作成される。上書き保存は最新値を返す。
#[test]
fn round_trip_persists_last_check() {
    let tmp = TempDir::new().unwrap();
    // "state/" は事前に作らない — set 側で作成されること。
    let path = tmp.path().join("state").join("update-check.json");

    {
        let first = LastCheckStore::new(&path);
        first
            .set_last_check(1_700_000_000)
            .expect("persisting the last-check time must succeed");
    } // drop = 保存はここまでに完了していること(set 時点で永続化)

    let second = LastCheckStore::new(&path);
    assert_eq!(
        second.last_check(),
        Some(1_700_000_000),
        "a new instance on the same file must read the persisted time back"
    );

    // 上書き: 次のチェックで時刻が進む。
    second.set_last_check(1_700_100_000).unwrap();
    let third = LastCheckStore::new(&path);
    assert_eq!(
        third.last_check(),
        Some(1_700_100_000),
        "a later set must overwrite the persisted time"
    );
}

/// 4-3. 破損ファイル(不正 JSON)=「未チェック」へフォールバックし、次の
///      保存で正常状態に復帰する(壊れたストアが起動もチェックも阻害しない)。
#[test]
fn corrupted_file_falls_back_to_never_checked_and_recovers() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("update-check.json");
    fs::write(&path, "this is not json {{{").unwrap();

    let store = LastCheckStore::new(&path);
    assert_eq!(
        store.last_check(),
        None,
        "a corrupted store file must fall back to never-checked"
    );

    store
        .set_last_check(1_700_000_000)
        .expect("recovering from corruption via set must succeed");
    assert_eq!(
        store.last_check(),
        Some(1_700_000_000),
        "a set after corruption must leave the store in a clean state"
    );
}

/// 4-4. 未チェックへのフォールバックは should_check と合成して「要チェック」
///      になる(破損がチェックを止める向きに倒れない=fail open)。
#[test]
fn corrupted_store_composes_to_check_required() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("update-check.json");
    fs::write(&path, "\u{0000}broken").unwrap();

    let store = LastCheckStore::new(&path);
    assert!(
        should_check(store.last_check(), 1_700_000_000),
        "corruption must degrade to never-checked, which requires a check"
    );
}

// ---------------------------------------------------------------------------
// 5. channel=dev での抑止(channel_allows_check)
// ---------------------------------------------------------------------------

/// 5-1. dev channel ではチェックしない(開発・テスト中に外部通信を走らせない)。
#[test]
fn dev_channel_never_checks() {
    assert!(
        !channel_allows_check(Channel::Dev),
        "the dev channel must not run the update check"
    );
}

/// 5-2. release channel ではチェックする(既定 ON・無効化手段なし)。
#[test]
fn release_channel_checks() {
    assert!(
        channel_allows_check(Channel::Release),
        "the release channel must run the update check (default ON)"
    );
}
