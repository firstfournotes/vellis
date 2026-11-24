//! 要件#87 の受け入れテスト(docs/requirements/req-87.md)— Rust 層
//!
//! 「開発版のリリース(private のプレリリース・版の名前で新旧が分かる)」
//!
//! 判定範囲(AC 番号は req-87.md の受け入れ基準):
//! - AC-87-1 `derive_channel` が、CI の文脈で `dev/<開発名>/<n>` のタグを `preview`、`v x.y.z` を `release`、
//!   ほか(CI の文脈なしの dev タグ・形の崩れたタグ)を `dev` にする(契約1)
//! - AC-87-2 `preview` のビルドの名前の形 `dev-<開発名> #<n>（YYYY-MM-DD HH:MM JST）` と、タグからの取り出し。
//!   `--print-build-info` に `buildName` がある(契約2)
//! - AC-87-3 `preview` は dev-features を含まない・自動の更新の確かめをしない(既存の release の守りと同じ形)(契約1・4)
//!
//! 本ファイルの外: AC-87-4(About)・AC-87-5(dev-release.yml)・AC-87-7(手順の文書)は
//! `src/lib/dev-release.acceptance.test.ts`、AC-87-6(install-dev.sh)は `src/lib/install-dev.acceptance.test.ts`。
//! preview のビルドが dev-features を**コンパイルしない**こと(CI の `tauri build` の行)は
//! AC-87-5 側(`dev-release.yml` の静的な検査)で見る。
//!
//! ## 確定契約(implementer はこれに従う=本テストが前提にする名前・公開パス)
//!
//! ```ignore
//! // --- src-tauri/src/channel.rs(std だけ・build.rs から include! される。既存の pub は無改変)---
//!
//! pub enum Channel { Release, Preview, Dev }   // Preview を足す(derive は今のまま)
//! // Channel::Preview.as_str() == "preview"(Release = "release"・Dev = "dev" は今のまま)
//!
//! /// 署名は今のまま。CI の文脈(GITLAB_CI か CI_PIPELINE_ID が空でない)があって、
//! ///   タグが `^v\d+\.\d+\.\d+$`                      → Release(今のまま)
//! ///   タグが `^dev/[a-z0-9][a-z0-9-]*/[1-9][0-9]*$`   → Preview
//! /// ほかは全部 Dev。ASCII だけで判定する(全角の英数字は崩れた形)。
//! pub fn derive_channel(commit_tag: Option<&str>, gitlab_ci: Option<&str>, pipeline_id: Option<&str>) -> Channel;
//!
//! /// 開発版のタグ `dev/<開発名>/<n>`(上の正規表現)から (開発名, n) を取り出す。形が崩れていたら None。
//! /// n は符号なし整数(u32 か u64。テストは整数の字面で比べるので、どちらでもよい)。
//! pub fn parse_preview_tag(tag: &str) -> Option<(&str, u32)>;
//!
//! /// ビルドの名前(About・`--print-build-info` の buildName・GitHub Release の名前に出す同じ文字列)。
//! ///   Preview → `dev-<開発名> #<n>（<build_time>）`。括弧は全角の（〜）(U+FF08・U+FF09)。
//! ///             `build_time` は build.rs の VELLIS_BUILD_TIME と同じ `YYYY-MM-DD HH:MM JST` の文字列をそのまま入れる。
//! ///   Release・Dev → 空文字列 ""(版の名前を持つのは開発版だけ。About などは空なら出さない)。
//! pub fn build_name(channel: Channel, commit_tag: Option<&str>, build_time: &str) -> String;
//!
//! // --- src-tauri/build.rs ---
//! // 今の derive_channel の結果と VELLIS_BUILD_TIME の文字列から build_name(..) を呼び、
//! // `cargo:rustc-env=VELLIS_BUILD_NAME=<名前>`(cargo::rustc-env= でもよい)で焼き込む。
//! // VELLIS_BUILD_NUMBER(`<CI_PIPELINE_ID> <sha>` / `local <sha>`)は今のまま(短いコミットの番号を残す=契約2)。
//!
//! // --- src-tauri/src/commands/build_info.rs ---
//! // BuildInfo に `build_name: &'static str`(JSON では `buildName`)を足し、env!("VELLIS_BUILD_NAME") を入れる。
//! // `--print-build-info`(main.rs)は今のまま BuildInfo を JSON で出す → `buildName` の欄が増える。
//!
//! // --- src-tauri/src/features/mod.rs ---
//! /// build.rs が焼き込んだ VELLIS_CHANNEL の文字列 → Channel。
//! ///   Some("release") → Release・Some("preview") → Preview・ほか(None・"dev"・空・大文字違い・知らない字)→ Dev。
//! pub fn channel_from_baked(baked: Option<&str>) -> Channel;
//! // current_channel() はこれを `channel_from_baked(option_env!("VELLIS_CHANNEL"))` の形で呼ぶ。
//! // resolve / flags_map_for は Preview を Release と同じに扱う(kind=dev は常に false・payload から外す)。
//!
//! // --- src-tauri/src/update_check.rs ---
//! // channel_allows_check(Channel::Preview) == false(開発用のリポジトリは private で鍵なしでは読めない=契約4)。
//! ```
//!
//! ## 今の作りで赤になる理由
//! - `Channel::Preview`・`parse_preview_tag`・`build_name`・`channel_from_baked` が無いので、本ファイルはコンパイルできない
//!   (`derive_channel` は dev タグを全部 Dev にし、`as_str` に "preview" が無い)。
//! - `--print-build-info` の JSON に `buildName` の欄が無い。build.rs は VELLIS_BUILD_NAME を焼き込まない。
//! - `current_channel()` は "release" 以外を全部 Dev にする(preview のビルドが channel=dev と名乗ってしまう)。

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::Value;

use vellis_lib::channel::{build_name, derive_channel, parse_preview_tag, Channel};
use vellis_lib::features::{
    channel_from_baked, current_channel, flags_map_for, resolve_by_name, FlagKind, REGISTRY,
};
use vellis_lib::update_check::channel_allows_check;

/// GitHub Actions の文脈(release.yml は CI_PIPELINE_ID = github.run_id を渡す)。
const RUN_ID: Option<&str> = Some("19512345678");
/// GitLab CI の文脈(GITLAB_CI=true)。
const GITLAB: Option<&str> = Some("true");
/// ビルドの時刻(build.rs の VELLIS_BUILD_TIME と同じ形)。
const BUILT: &str = "2026-11-21 09:30 JST";

/// 正しい開発版のタグ → (開発名, n)。
const WELL_FORMED: &[(&str, &str, u64)] = &[
    ("dev/req-74/3", "req-74", 3),
    ("dev/req-74/12", "req-74", 12),
    ("dev/req-80/1", "req-80", 1),
    ("dev/a/1", "a", 1),
    ("dev/0/1", "0", 1),             // 開発名の頭は数字でもよい([a-z0-9])
    ("dev/a--b/7", "a--b", 7),       // 2 文字目からは - を含んでよい
    ("dev/req-74-/2", "req-74-", 2), // 末尾の - も [a-z0-9-]* の内
    ("dev/x/100", "x", 100),
];

/// 形の崩れた開発版のタグ(CI の文脈があっても Dev・取り出しは None)。
const MALFORMED: &[&str] = &[
    // 指示書の例
    "dev/req-74/0",   // n は 1 から
    "dev//3",         // 開発名が空
    "dev/Req/3",      // 大文字
    "dev/req-74/3/x", // 段が多い
    "dev/req-74/03",  // 頭の 0
    // 正規表現の端
    "dev/-req/3",    // 頭が -
    "dev/req_74/3",  // _ は使えない
    "dev/req.74/3",  // . は使えない
    "dev/req 74/3",  // 空白
    "dev/req-74/",   // n が空
    "dev/req-74",    // n の段が無い
    "dev/req-74/3a", // n に字
    "dev/req-74/-3", // 符号
    "dev/req-74/+3", // 符号
    "dev/req-74/1.0",
    "dev/req-74/3 ",  // 末尾の空白(アンカー)
    " dev/req-74/3",  // 頭の空白(アンカー)
    "dev/req-74/3\n", // 末尾の改行(アンカー)
    "Dev/req-74/3",   // 接頭辞の大文字
    "refs/tags/dev/req-74/3",
    "x/dev/req-74/3",
    "dev/ｒｅｑ/3",        // 全角の英字
    "dev/req-74/３",       // 全角の数字
    "dev/req-74/\u{0663}", // ASCII でない数字(アラビア・インド数字の 3)
    "dev",
    "dev/",
    "dev/req-74/3/",
    "",
];

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_src(rel: &str) -> String {
    let path = manifest_dir().join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

// ───────────────────────── AC-87-1: derive_channel の表 ─────────────────────────

/// 1. CI の文脈で `dev/<開発名>/<n>` は Preview(GitHub の CI_PIPELINE_ID でも GitLab の GITLAB_CI でも)。
#[test]
fn ac87_1_dev_tag_in_ci_is_preview() {
    for (tag, _, _) in WELL_FORMED {
        assert_eq!(
            derive_channel(Some(*tag), None, RUN_ID),
            Channel::Preview,
            "tag {tag:?} with CI_PIPELINE_ID must resolve to Preview"
        );
        assert_eq!(
            derive_channel(Some(*tag), GITLAB, None),
            Channel::Preview,
            "tag {tag:?} with GITLAB_CI must resolve to Preview"
        );
        assert_eq!(derive_channel(Some(*tag), GITLAB, RUN_ID), Channel::Preview);
    }
}

/// 2. `v x.y.z` は CI の文脈で今のまま Release(release の判定は変えない)。
#[test]
fn ac87_1_release_tag_in_ci_is_still_release() {
    assert_eq!(
        derive_channel(Some("v0.6.1"), None, RUN_ID),
        Channel::Release
    );
    assert_eq!(
        derive_channel(Some("v0.6.1"), GITLAB, None),
        Channel::Release
    );
    assert_eq!(
        derive_channel(Some("v12.30.400"), GITLAB, RUN_ID),
        Channel::Release
    );
    // release の形の崩れは今のまま Dev(Preview にもならない)
    for t in ["v0.6", "v0.6.1-rc1", "0.6.1", "v0.6.1 "] {
        assert_eq!(
            derive_channel(Some(t), GITLAB, RUN_ID),
            Channel::Dev,
            "tag {t:?}"
        );
    }
}

/// 3. CI の文脈なしの dev タグは Dev(手元で CI_COMMIT_TAG を偽っても開発版にならない)。
#[test]
fn ac87_1_dev_tag_without_ci_is_dev() {
    for (tag, _, _) in WELL_FORMED {
        assert_eq!(
            derive_channel(Some(*tag), None, None),
            Channel::Dev,
            "tag {tag:?} without CI"
        );
        assert_eq!(
            derive_channel(Some(*tag), Some(""), Some("")),
            Channel::Dev,
            "tag {tag:?} with empty CI vars"
        );
    }
    // タグなしの CI(ブランチのビルド・手動の試験ビルド)も今のまま Dev
    assert_eq!(derive_channel(None, GITLAB, RUN_ID), Channel::Dev);
    assert_eq!(derive_channel(Some(""), GITLAB, RUN_ID), Channel::Dev);
}

/// 4. 形の崩れた dev タグは CI の文脈があっても Dev。
#[test]
fn ac87_1_malformed_dev_tags_in_ci_are_dev() {
    for t in MALFORMED {
        assert_eq!(
            derive_channel(Some(*t), None, RUN_ID),
            Channel::Dev,
            "tag {t:?} must resolve to Dev (CI_PIPELINE_ID)"
        );
        assert_eq!(
            derive_channel(Some(*t), GITLAB, RUN_ID),
            Channel::Dev,
            "tag {t:?} must resolve to Dev (GITLAB_CI)"
        );
    }
}

/// 5. 経路の文字: preview / release / dev。
#[test]
fn ac87_1_channel_as_str() {
    assert_eq!(Channel::Preview.as_str(), "preview");
    assert_eq!(Channel::Release.as_str(), "release");
    assert_eq!(Channel::Dev.as_str(), "dev");
}

// ───────────────────────── AC-87-2: 版の名前とタグからの取り出し ─────────────────────────

/// 1. タグから (開発名, n) を取り出す。崩れた形は None。release のタグも None。
#[test]
fn ac87_2_parse_preview_tag_extracts_name_and_number() {
    for (tag, name, n) in WELL_FORMED {
        let got = parse_preview_tag(tag).unwrap_or_else(|| panic!("{tag:?} must parse"));
        assert_eq!(got.0, *name, "dev name of {tag:?}");
        assert_eq!(u64::from(got.1), *n, "number of {tag:?}");
    }
    for t in MALFORMED {
        assert!(parse_preview_tag(t).is_none(), "{t:?} must not parse");
    }
    for t in ["v0.6.1", "v1.2.3"] {
        assert!(
            parse_preview_tag(t).is_none(),
            "release tag {t:?} is not a preview tag"
        );
    }
}

/// 2. preview の名前は `dev-<開発名> #<n>（YYYY-MM-DD HH:MM JST）`(全角の括弧・由谷が見る画面の文字)。
#[test]
fn ac87_2_preview_build_name_shape() {
    assert_eq!(
        build_name(Channel::Preview, Some("dev/req-74/3"), BUILT),
        "dev-req-74 #3（2026-11-21 09:30 JST）"
    );
    assert_eq!(
        build_name(
            Channel::Preview,
            Some("dev/req-80/12"),
            "2026-12-01 23:05 JST"
        ),
        "dev-req-80 #12（2026-12-01 23:05 JST）"
    );
    assert_eq!(
        build_name(Channel::Preview, Some("dev/a--b/7"), "2027-01-02 00:00 JST"),
        "dev-a--b #7（2027-01-02 00:00 JST）"
    );

    let name = build_name(Channel::Preview, Some("dev/req-74/3"), BUILT);
    assert!(
        name.contains('\u{FF08}') && name.ends_with('\u{FF09}'),
        "full-width brackets: {name:?}"
    );
    assert!(
        !name.contains('(') && !name.contains(')'),
        "no ASCII brackets: {name:?}"
    );
    let shape =
        Regex::new(r"^dev-[a-z0-9][a-z0-9-]* #[1-9][0-9]*\x{FF08}[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} JST\x{FF09}$")
            .unwrap();
    assert!(shape.is_match(&name), "shape of {name:?}");
}

/// 3. 版の名前を持つのは開発版だけ。release と dev は空文字列(手元で dev タグを偽っても名前は付かない)。
#[test]
fn ac87_2_build_name_is_empty_off_preview() {
    assert_eq!(build_name(Channel::Release, Some("v0.6.1"), BUILT), "");
    assert_eq!(build_name(Channel::Release, None, BUILT), "");
    assert_eq!(build_name(Channel::Dev, Some("dev/req-74/3"), BUILT), "");
    assert_eq!(build_name(Channel::Dev, None, BUILT), "");
    assert_eq!(build_name(Channel::Dev, Some(""), BUILT), "");
}

/// 4. `--print-build-info` の JSON に `buildName` の欄がある。経路が preview なら名前の形、ほかは空。
///    短いコミットの番号(buildNumber の `<id> <sha>` / `local <sha>`)も残る(契約2)。
#[test]
fn ac87_2_print_build_info_carries_build_name() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let mut child = Command::new(env!("CARGO_BIN_EXE_vellis"))
        .arg("--print-build-info")
        .env_remove("VELLIS_FLAGS")
        .env("HOME", tmp.path())
        .env("XDG_RUNTIME_DIR", tmp.path())
        .current_dir(tmp.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn the built vellis binary");
    let started = Instant::now();
    loop {
        match child.try_wait().expect("poll vellis") {
            Some(_) => break,
            None if started.elapsed() > Duration::from_secs(30) => {
                let _ = child.kill();
                panic!("vellis --print-build-info did not exit within 30s");
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    let out = child.wait_with_output().expect("collect vellis output");
    assert!(
        out.status.success(),
        "--print-build-info exits 0: stderr={}",
        String::from_utf8_lossy(&out.stderr)
    );
    let info: Value = serde_json::from_slice(&out.stdout).unwrap_or_else(|e| {
        panic!(
            "--print-build-info prints JSON ({e}): {}",
            String::from_utf8_lossy(&out.stdout)
        )
    });
    let obj = info.as_object().expect("a JSON object");
    for key in [
        "version",
        "buildNumber",
        "buildTime",
        "buildName",
        "channel",
        "flags",
    ] {
        assert!(
            obj.contains_key(key),
            "--print-build-info has {key:?}: {info}"
        );
    }

    let channel = info["channel"].as_str().expect("channel is a string");
    let name = info["buildName"].as_str().expect("buildName is a string");
    if channel == "preview" {
        let shape = Regex::new(
            r"^dev-[a-z0-9][a-z0-9-]* #[1-9][0-9]*\x{FF08}[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} JST\x{FF09}$",
        )
        .unwrap();
        assert!(shape.is_match(name), "preview buildName shape: {name:?}");
    } else {
        assert_eq!(
            name, "",
            "buildName is empty on {channel} (only a preview build has a name)"
        );
    }

    let number = info["buildNumber"]
        .as_str()
        .expect("buildNumber is a string");
    let number_shape = Regex::new(r"^(local|[0-9]+) ([0-9a-f]{7,}|unknown)(-dirty)?$").unwrap();
    assert!(
        number_shape.is_match(number),
        "buildNumber keeps the short commit: {number:?}"
    );
}

/// 5. build.rs が、テストした `build_name` で名前を作って VELLIS_BUILD_NAME に焼き込み、
///    build_info.rs がそれを出す(About・`--print-build-info` が同じ文字列になる)。
#[test]
fn ac87_2_build_rs_bakes_the_name_from_build_name() {
    let build_rs = read_src("build.rs");
    assert!(
        build_rs.contains("rustc-env=VELLIS_BUILD_NAME="),
        "build.rs emits cargo:rustc-env=VELLIS_BUILD_NAME=…"
    );
    assert!(
        build_rs.contains("build_name("),
        "build.rs makes the name with channel.rs's build_name(..)"
    );
    assert!(
        build_rs.contains("rustc-env=VELLIS_BUILD_NUMBER="),
        "VELLIS_BUILD_NUMBER (short commit) is still baked"
    );

    let build_info = read_src("src/commands/build_info.rs");
    assert!(
        build_info.contains("VELLIS_BUILD_NAME"),
        "build_info.rs serves VELLIS_BUILD_NAME"
    );
}

// ───────────────────────── AC-87-3: preview の守り(release と同じ形)─────────────────────────

/// 1. preview は自動の更新の確かめをしない(release=true・dev=false は今のまま)。
#[test]
fn ac87_3_preview_never_checks_for_updates_automatically() {
    assert!(
        !channel_allows_check(Channel::Preview),
        "preview: no automatic update check (契約4)"
    );
    assert!(
        channel_allows_check(Channel::Release),
        "release keeps its automatic check"
    );
    assert!(
        !channel_allows_check(Channel::Dev),
        "dev stays off the network"
    );
}

/// 2. 機能の旗の解決は、preview でも release と同じ答え(kind=dev は dev-features の有無・
///    VELLIS_FLAGS・ops の停止にかかわらず false)。
#[test]
fn ac87_3_preview_resolves_flags_like_release() {
    let names: Vec<&str> = REGISTRY.iter().map(|f| f.name).collect();
    let none: &[&str] = &[];
    for spec in REGISTRY {
        for compiled in [false, true] {
            for listed in [none, names.as_slice()] {
                for killed in [false, true] {
                    let preview =
                        resolve_by_name(spec.name, Channel::Preview, compiled, listed, killed);
                    let release =
                        resolve_by_name(spec.name, Channel::Release, compiled, listed, killed);
                    assert_eq!(
                        preview, release,
                        "{}: preview resolves like release (compiled={compiled}, listed={listed:?}, killed={killed})",
                        spec.name
                    );
                    if spec.kind == FlagKind::Dev {
                        assert!(!preview, "{}: a kind=dev flag is off on preview", spec.name);
                    }
                }
            }
        }
    }
}

/// 3. `--print-build-info` / get_build_info の flags も release と同じ形(kind=dev の行を出さない)。
#[test]
fn ac87_3_preview_payload_omits_dev_flags_like_release() {
    let names: Vec<&str> = REGISTRY.iter().map(|f| f.name).collect();
    let none: &[&str] = &[];
    for compiled in [false, true] {
        for listed in [none, names.as_slice()] {
            let preview = flags_map_for(Channel::Preview, compiled, listed);
            let release = flags_map_for(Channel::Release, compiled, listed);
            assert_eq!(
                preview, release,
                "preview payload == release payload (compiled={compiled})"
            );
            for spec in REGISTRY.iter().filter(|f| f.kind == FlagKind::Dev) {
                assert!(
                    !preview.contains_key(spec.name),
                    "{} is not carried on preview",
                    spec.name
                );
            }
        }
    }
}

/// 4. 焼き込んだ VELLIS_CHANNEL の文字 → 経路。"preview" を Dev に落とさない。
#[test]
fn ac87_3_baked_channel_string_maps_back_to_the_channel() {
    assert_eq!(channel_from_baked(Some("preview")), Channel::Preview);
    assert_eq!(channel_from_baked(Some("release")), Channel::Release);
    assert_eq!(channel_from_baked(Some("dev")), Channel::Dev);
    for c in [Channel::Release, Channel::Preview, Channel::Dev] {
        assert_eq!(
            channel_from_baked(Some(c.as_str())),
            c,
            "round trip of {c:?}"
        );
    }
    // 知らない字・空・無しは今のまま Dev(fail-safe)
    for raw in [
        None,
        Some(""),
        Some("Preview"),
        Some("RELEASE"),
        Some("beta"),
        Some("preview "),
    ] {
        assert_eq!(
            channel_from_baked(raw),
            Channel::Dev,
            "{raw:?} falls back to Dev"
        );
    }
}

/// 5. current_channel は焼き込んだ値を channel_from_baked で読む(テストした写像が実際に使われる)。
#[test]
fn ac87_3_current_channel_goes_through_channel_from_baked() {
    let src = read_src("src/features/mod.rs");
    let start = src
        .find("pub fn current_channel()")
        .expect("features::current_channel exists");
    let body_end = src[start..]
        .find("\n}")
        .map(|i| start + i)
        .expect("end of current_channel");
    let body = &src[start..body_end];
    let call =
        Regex::new(r#"channel_from_baked\(\s*option_env!\(\s*"VELLIS_CHANNEL"\s*\)\s*\)"#).unwrap();
    assert!(
        call.is_match(body),
        "current_channel() reads channel_from_baked(option_env!(\"VELLIS_CHANNEL\")): {body}"
    );
    // 手元のテストのビルドでも、焼き込んだ文字と実行時の経路がそろう
    if let Some(baked) = option_env!("VELLIS_CHANNEL") {
        assert_eq!(current_channel().as_str(), baked);
    }
}
