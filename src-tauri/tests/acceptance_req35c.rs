//! 要件#35 追補c の受け入れテスト(docs/requirements/req-35.md「追補c」・backlog 319)
//!
//! 319: `is_on_read_only_volume` は `libc::statfs` の `f_flags`(`u32`)と `libc::MNT_RDONLY` を
//! 使う macOS / BSD の書き方で、Linux の `libc` には `MNT_RDONLY` が無く `statfs` の `f_flags` の
//! 型も違うため、Linux を対象にするとこのファイルがコンパイルできない。
//! 直し方(2026-10-11 オーケストレーター判断)= **macOS の実装を一字も変えずに cfg で分け、
//! macOS 以外に `statvfs` の実装を置く**。
//!
//! 契約(追補c):
//! 1. 今の `is_on_read_only_volume`(`statfs` と `MNT_RDONLY`)を `#[cfg(target_os = "macos")]` の
//!    下に置く。本体は変えない
//! 2. `#[cfg(not(target_os = "macos"))]` の下に、同じ名前・同じ型
//!    (`pub fn is_on_read_only_volume(path: &Path) -> bool`)の実装を置く。POSIX の
//!    `libc::statvfs` で調べ、`f_flag` に `libc::ST_RDONLY` が立っていれば真。`statvfs` が
//!    失敗したとき(パスが無いなど)は偽
//! 3. 不変: macOS での振る舞い・`install_cli_for` の判定の順と文言・`READ_ONLY_VOLUME_ERROR`・
//!    依存。既存のテストは無改変で緑
//!
//! 受け入れ基準 AC-35-追c:
//!   (a) ソース走査: `cli_install.rs` の本文(`#[cfg(test)]` より前・行コメントを除く)に
//!       `fn is_on_read_only_volume` の定義がちょうど2つある。片方の定義の前(前の項目との間)に
//!       `#[cfg(target_os = "macos")]` があり、その本体に `statfs` と `MNT_RDONLY` がある。
//!       もう片方の定義の前に `#[cfg(not(target_os = "macos"))]` があり、その本体に `statvfs` と
//!       `ST_RDONLY` があって `MNT_RDONLY` が無い
//!       → `ac35c_a_is_on_read_only_volume_is_defined_twice_split_by_cfg_target_os`
//!   (b) macOS での振る舞いは AC-35-追b(a)(`acceptance_req35b.rs`)が引き続き固定する
//!       (本ファイルでは重ねない)
//!
//! 修正前の見込み: 定義が1つ(cfg なし)なので (a) は赤(「ちょうど2つ」で落ちる)。
//!
//! ## 本テストの組み立て
//!
//! - `strip_line_comments` / `code_body` は `acceptance_req35b.rs` と同じ流儀(行コメントを
//!   落とし、`#[cfg(test)]` より前だけを見る)。`///` の doc コメントも行コメントとして落ちる
//!   ので、「定義の前」に残るのは属性と `pub` だけになる
//! - 定義の本体は `fn is_on_read_only_volume` に続く `(` … `)` のあとの `{` … `}` を括弧の
//!   釣り合いで切り出す
//! - 「前の項目との間」= 定義の直前にある、前の項目の終わり(`}` か `;`)から定義までの文字列

// ---------------------------------------------------------------------------
// 補助(acceptance_req35b.rs の strip_line_comments / code_body と同じ流儀)
// ---------------------------------------------------------------------------

/// 行ごとに `//` 以降(コメント)を落とす。`://` は落とさない。
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

/// ソースの `#[cfg(test)]` より前・行コメントを除いた本文。
fn code_body(src: &str) -> String {
    let code = strip_line_comments(src);
    match code.find("#[cfg(test)]") {
        Some(i) => code[..i].to_string(),
        None => code,
    }
}

/// `from` 以降で最初に現れる `open` から、対応する `close` までを切り出す
/// (acceptance_req5a.rs の `balanced` と同じ)。
fn balanced(code: &str, from: usize, open: char, close: char) -> &str {
    let start = code[from..]
        .find(open)
        .unwrap_or_else(|| panic!("`{open}` must follow offset {from}"))
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
    panic!("`{open}` at {start} never closes");
}

const FN_NEEDLE: &str = "fn is_on_read_only_volume";
const CFG_MACOS: &str = "#[cfg(target_os = \"macos\")]";
const CFG_NOT_MACOS: &str = "#[cfg(not(target_os = \"macos\"))]";

/// `fn is_on_read_only_volume` の定義 1 つ分。
struct Definition {
    /// 前の項目の終わり(`}` / `;`)から `fn` まで(属性と `pub` が残る)。
    before: String,
    /// `(` … `)`。
    params: String,
    /// `->` から `{` の手前まで(戻りの型)。
    ret: String,
    /// `{` … `}`。
    body: String,
}

/// `cli_install.rs` の本文にある `fn is_on_read_only_volume` の定義を全部切り出す。
fn definitions(code: &str) -> Vec<Definition> {
    code.match_indices(FN_NEEDLE)
        .filter(|(i, _)| code[i + FN_NEEDLE.len()..].starts_with('('))
        .map(|(i, _)| {
            let params = balanced(code, i + FN_NEEDLE.len(), '(', ')');
            let params_end = params.as_ptr() as usize - code.as_ptr() as usize + params.len();
            let body = balanced(code, params_end, '{', '}');
            let body_start = body.as_ptr() as usize - code.as_ptr() as usize;
            let ret = code[params_end..body_start].trim().to_string();
            let prev_item_end = code[..i].rfind(['}', ';']).map(|p| p + 1).unwrap_or(0);
            Definition {
                before: code[prev_item_end..i].to_string(),
                params: params.to_string(),
                ret,
                body: body.to_string(),
            }
        })
        .collect()
}

fn normalized(s: &str) -> String {
    s.split_whitespace().collect()
}

// ---------------------------------------------------------------------------
// (a) ソース走査: 定義がちょうど2つ・cfg で分かれ・本体が statfs/MNT_RDONLY と statvfs/ST_RDONLY
// ---------------------------------------------------------------------------

#[test]
fn ac35c_a_is_on_read_only_volume_is_defined_twice_split_by_cfg_target_os() {
    let code = code_body(include_str!("../src/cli_install.rs"));
    let defs = definitions(&code);
    assert_eq!(
        defs.len(),
        2,
        "cli_install.rs must define `fn is_on_read_only_volume` exactly twice (one per cfg of \
         contract 1 / 2); found {}",
        defs.len()
    );

    // 同じ名前・同じ型(契約2)。
    for (n, d) in defs.iter().enumerate() {
        assert_eq!(
            normalized(&d.params),
            "(path:&Path)",
            "definition #{n} must take `(path: &Path)` (contract 2: the same signature); got {}",
            d.params
        );
        assert_eq!(
            normalized(&d.ret),
            "->bool",
            "definition #{n} must return `bool` (contract 2: the same signature); got {}",
            d.ret
        );
        assert!(
            normalized(&d.before).ends_with("pub"),
            "definition #{n} must stay `pub` (contract 2); the text before `fn` is: {:?}",
            d.before
        );
    }

    // 属性は空白を除いて比べる(`target_os="macos"` の書き方も同じ属性)。
    let has_attr = |d: &Definition, attr: &str| normalized(&d.before).contains(&normalized(attr));
    let macos: Vec<&Definition> = defs.iter().filter(|d| has_attr(d, CFG_MACOS)).collect();
    let others: Vec<&Definition> = defs.iter().filter(|d| has_attr(d, CFG_NOT_MACOS)).collect();
    assert_eq!(
        macos.len(),
        1,
        "exactly one definition must sit under `{CFG_MACOS}` (contract 1); the text before each \
         `fn` is: {:?}",
        defs.iter().map(|d| d.before.as_str()).collect::<Vec<_>>()
    );
    assert_eq!(
        others.len(),
        1,
        "exactly one definition must sit under `{CFG_NOT_MACOS}` (contract 2); the text before \
         each `fn` is: {:?}",
        defs.iter().map(|d| d.before.as_str()).collect::<Vec<_>>()
    );
    assert!(
        !std::ptr::eq(macos[0], others[0]),
        "the two cfg attributes must not both sit on the same definition"
    );

    // macOS 側: 今の本体のまま(statfs と MNT_RDONLY)。
    let mac_body = &macos[0].body;
    assert!(
        mac_body.contains("statfs"),
        "the macOS definition must keep calling `statfs` (contract 1: body unchanged): {mac_body}"
    );
    assert!(
        mac_body.contains("MNT_RDONLY"),
        "the macOS definition must keep testing `MNT_RDONLY` (contract 1: body unchanged): {mac_body}"
    );

    // macOS 以外: statvfs と ST_RDONLY で、MNT_RDONLY は無い。
    let other_body = &others[0].body;
    assert!(
        other_body.contains("statvfs"),
        "the non-macOS definition must call `statvfs` (contract 2): {other_body}"
    );
    assert!(
        other_body.contains("ST_RDONLY"),
        "the non-macOS definition must test `ST_RDONLY` (contract 2): {other_body}"
    );
    assert!(
        !other_body.contains("MNT_RDONLY"),
        "the non-macOS definition must not mention `MNT_RDONLY` (it does not exist in the Linux \
         libc; contract 2): {other_body}"
    );
}
