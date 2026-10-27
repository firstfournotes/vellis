//! 要件#38 追補o の受け入れテスト(docs/requirements/req-38.md 追補o・Issue #715)— Rust 層
//!
//! 「印刷窓の印刷を、main run loop の次の回から始める」
//!
//! 根拠: #715(HTML の印刷でパネルが出る瞬間に PrintingUI の `RemotePDEServiceInterface` の中で落ちる)の
//! 切り分け 3。印刷窓の印刷操作を `run_on_main_thread` の閉包(tao の run loop の observer の中)で直接
//! 走らせるのをやめ、`performSelector:withObject:afterDelay:0` で AppKit の main run loop の次の回から
//! 走らせた試験用のビルドは、OKI が見える環境で 0/30(main は 8/30・p≈0.005)。
//!
//! 契約(追補o):
//! 1. 印刷窓の印刷操作の `runOperationModalForWindow:delegate:didRunSelector:contextInfo:` は、
//!    `start_print_operation` の `run_on_main_thread(` の閉包の中で直接呼ばない。閉包の中でするのは、
//!    印刷操作の組み立て(メインスレッド)と、main run loop の default mode に 0 秒のタイマーを予約すること
//!    (`performSelector:withObject:afterDelay:` に 0)まで。タイマーが鳴ったら、追補n の delegate
//!    (`printOperationDidRun:success:contextInfo:` を受ける)が印刷操作をシートとして走らせる
//! 2. タイマーが鳴ったときに印刷窓がもう無ければ(`get_webview_window` が `None`)、印刷しないで返す。
//!    シートを走らせる処理は `catch_unwind` で包み、panic したら印刷窓を閉じる(終わりの通知が来ないため)。
//!    タイマーが鳴るまで、印刷操作と窓はタイマーが保持する delegate が持つ
//! 3. 不変: 印刷操作の設定(追補n 契約 1)・印刷窓を終わりの通知で閉じる(追補n)・`PRINT_SETTLE`・
//!    `print_html` の返事は印刷操作を組み立てたあと(シートを出す前)に返す・Markdown の印刷
//!    (`print_current_window`)・要件27 追補b の印刷窓の持ち主の記録。依存の追加なし
//!
//! 本ファイルの持ち場= AC-38-追o の (a)〜(d)。AppKit 依存で振る舞いは試せないので全部ソース走査
//! (`print.rs` のコメントを落とした本文から `#[cfg(not(target_os = "macos"))]` の項目を除いた
//! **macOS の経路**。「閉包」= `start_print_operation` の `run_on_main_thread(` の引数の括弧の中身):
//! - (a) 閉包から、関数呼び出しの名前(`<name>(`)だけをたどって `runOperationModalForWindow` に届かない
//! - (b) 閉包から(名前で)`performSelector` と `afterDelay`(値は 0)に届き、その `sel!(<名前>)` の
//!   `#[unsafe(method(<名前>))]` の fn から(名前で)`runOperationModalForWindow` に届く。その method は
//!   追補n の delegate(`printOperationDidRun:success:contextInfo:` を実装する `define_class!`)のもの(契約 1)
//! - (c) その method は印刷窓が無いとき(`get_webview_window` が `None`)印刷せずに返し、シートを走らせる
//!   処理を `catch_unwind(` で包み(`runOperationModalForWindow` にはその括弧の中からだけ届く)、
//!   panic なら印刷窓を `.close()` する
//! - (d) 閉包の中の `print_html` への返事(`start_print_operation` の channel の送り手の `.send(Ok(`)は、
//!   タイマーの予約(`performSelector` に届く呼び出し)より前にあり、印刷操作の組み立て
//!   (`printOperationWithPrintInfo` に届く呼び出し)より後にある(契約 3)
//!
//! 持ち場の外:
//! - 契約 3 の印刷操作の設定と delegate・選択子= `acceptance_req38n.rs` のテスト 5・6(辿り方だけを
//!   追補o の要件側の更新で `performSelector:` の選択子へ進むようにした)。`PRINT_SETTLE`・始められない
//!   経路・依存の固定も `acceptance_req38n.rs`・`acceptance_req38m.rs` のまま
//! - Markdown の印刷(`print_current_window`)・要件27 追補b の持ち主の記録=既存のテストが無改変で緑
//!   (同じ周回のフルスイート)
//!
//! ## 確定契約(implementer はこれに従う。ソース走査はこの形を前提に書いてある)
//!
//! ```ignore
//! // src-tauri/src/print.rs(macOS の経路)
//!
//! // - `start_print_operation` の `run_on_main_thread(` の閉包の順: 印刷操作を組み立てる(名前で
//! //   `printOperationWithPrintInfo` に届く呼び出し)→ `<tx>.send(Ok(()))`(`<tx>` は本体の
//! //   `let (<tx>, <rx>) = … channel()` の送り手)→ タイマーの予約。閉包から名前でたどれる fn のどこにも
//! //   `runOperationModalForWindow` を書かない(組み立ての fn にも)
//! // - タイマーの予約は型なしの `msg_send![&*delegate, performSelector: sel!(<名前>), withObject: …,
//! //   afterDelay: 0.0]` の形(`afterDelay:` は `0`・`0.0`・`0.0f64`・`0.0_f64`、または `= 0.0` の const の
//! //   名前。`inModes:` は付けない=default mode)。閉包の中に直接書くか、閉包から名前でたどれる fn に書く。
//! //   `performSelector_withObject_afterDelay(` のような typed 呼び出しは走査が見つけない(契約 5 of 追補n の
//! //   型なし `msg_send!` と同じ)。選択子の名前は自由(走査は `sel!(…)` から読む)
//! // - `sel!(<名前>)` の method は、追補n の delegate の `define_class!` の中の `#[unsafe(method(<名前>))]`
//! //   を付けた fn(空白なし)。その本体は、この順で:
//! //     1. `get_webview_window(` で印刷窓を探し、無ければ早く返す。形は
//! //        `if … get_webview_window(…).is_none() { … return … }`・
//! //        `let Some(..) = … get_webview_window(…) else { … return … }`・
//! //        `match … get_webview_window(…) { None => … return … , … }` のどれか(`catch_unwind(` より前)
//! //     2. `catch_unwind(AssertUnwindSafe(|| <runOperationModalForWindow に名前で届く呼び出し>))`
//! //        (`runOperationModalForWindow` には method の本体からこの括弧の中を通ってだけ届く)
//! //     3. その結果が Err のとき(`<r>.is_err() { … }`・`if let Err(..) = <r> { … }`・`Err(..) => …`)
//! //        印刷窓を `.close()` する(そのブロックの中に直接か、名前でたどれる fn)
//! ```
//!
//! ## reviewer 照合に委ねる配線(AppHandle / AppKit 依存で機械判定不能)
//! - タイマーが鳴るまで印刷操作と窓を delegate が持ち、鳴ったら手放すこと(契約 2 の末尾)
//! - `performSelector:withObject:afterDelay:` の受け手が追補n の delegate のインスタンスであること・
//!   `inModes:` を付けない(default mode)こと(契約 1)
//! - panic の腕で閉じる窓が印刷窓(`label`)であること・窓がもう無ければ何もしないこと(契約 2)
//! - Ok の腕(シートが付いた)では窓を閉じないこと(閉じるのは追補n の終わりの通知)
//!
//! ## 人間ゲート(機械で駆動できる=req-38.md 追補o)
//! - OKI が見える環境で `req38-crash-probe.sh` を修正後と main で各 30 回(修正後が落ちない)
//! - `req38-print.sh` の Cancel・PDF に保存・印刷窓が閉じる・連打で 1 枚、が今までどおり

use std::collections::BTreeSet;

// ---------------------------------------------------------------------------
// 走査の道具 — acceptance_req38n.rs の strip_line_comments / without_cfg_items / block_end /
// fn_body / all_functions / reachable_segments / message_args / is_zero の写し(テスト間でコードは
// 共有しないので写す)
// ---------------------------------------------------------------------------

/// 行コメント(`//`・`///`・`//!`)を落とす。`://`(URL)は残す。
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

/// `print.rs` の本文(コメントなし・全 OS の経路)。
fn print_module_code() -> String {
    strip_line_comments(include_str!("../src/print.rs"))
}

/// 空白を全部落とした形(`not(target_os = "macos")` と `not(target_os="macos")` を同じに見るため)。
fn flat(text: &str) -> String {
    text.split_whitespace().collect()
}

/// `#[cfg(…)]` が macOS を除く条件か(`not(target_os = "macos")` を含む)。
fn cfg_excludes_macos(attr: &str) -> bool {
    flat(attr).contains("not(target_os=\"macos\")")
}

/// `code` から、`excluded` が真の `#[cfg(…)]` が付いた項目(属性から、`;` か `{ … }` ブロックの終わりまで)
/// を落とす。fn・const・use・mod・impl のほか、本体の中の `#[cfg(…)] { … }` ブロックも落ちる。
fn without_cfg_items(code: &str, excluded: impl Fn(&str) -> bool) -> String {
    let mut out = String::new();
    let mut rest = code;
    while let Some(at) = rest.find("#[cfg(") {
        let attr_end = rest[at..]
            .find(']')
            .map(|i| at + i + 1)
            .expect("a #[cfg( attribute must close with ]");
        let attr = &rest[at..attr_end];
        out.push_str(&rest[..at]);
        if !excluded(attr) {
            out.push_str(attr);
            rest = &rest[attr_end..];
            continue;
        }
        let after = &rest[attr_end..];
        let end = match (after.find(';'), after.find('{')) {
            (Some(s), Some(b)) if s < b => attr_end + s + 1,
            (_, Some(b)) => block_end(rest, attr_end + b),
            (Some(s), None) => attr_end + s + 1,
            (None, None) => rest.len(),
        };
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

/// `print.rs` の macOS の経路(`#[cfg(not(target_os = "macos"))]` の項目を除いた本文)。
fn macos_code() -> String {
    without_cfg_items(&print_module_code(), cfg_excludes_macos)
}

/// `code[open..]` が `{` か `(` で始まるとして、対応する閉じ括弧の次の位置(文字列リテラル・
/// 文字リテラルの中の括弧は数えない)。
fn block_end(code: &str, open: usize) -> usize {
    let bytes = code.as_bytes();
    let (open_ch, close_ch) = match bytes[open] {
        b'{' => (b'{', b'}'),
        b'(' => (b'(', b')'),
        other => panic!("block must start at a brace or a paren, got {:?}", other as char),
    };
    let mut depth = 0usize;
    let mut i = open;
    let mut in_str = false;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if c == b'\\' {
                i += 1;
            } else if c == b'"' {
                in_str = false;
            }
        } else if c == b'"' {
            in_str = true;
        } else if c == b'\'' && i + 2 < bytes.len() && bytes[i + 2] == b'\'' {
            // 文字リテラル `'x'`(`'{'` のような括弧を数えない)。生存期間 `'a` は当たらない
            i += 2;
        } else if c == b'\'' && i + 3 < bytes.len() && bytes[i + 1] == b'\\' && bytes[i + 3] == b'\'' {
            // `'\n'` の形
            i += 3;
        } else if c == open_ch {
            depth += 1;
        } else if c == close_ch {
            depth -= 1;
            if depth == 0 {
                return i + 1;
            }
        }
        i += 1;
    }
    panic!("block starting at {open} never closes");
}

/// `fn <name>` の最初の定義の位置(`fn <name>(` と `fn <name><R: …>(` の両方。`fn <name>_x` は拾わない)。
fn fn_definition(code: &str, name: &str) -> Option<usize> {
    let needle = format!("fn {name}");
    code.match_indices(&needle)
        .find(|(i, _)| matches!(code[i + needle.len()..].chars().next(), Some('(') | Some('<')))
        .map(|(i, _)| i)
}

/// `fn <name>(` または `fn <name><` の本体(外側の `{ … }` を含む)。
fn fn_body<'a>(code: &'a str, name: &str, file: &str) -> &'a str {
    let start = fn_definition(code, name).unwrap_or_else(|| panic!("{file} must define {name}"));
    let open = code[start..]
        .find('{')
        .unwrap_or_else(|| panic!("{name} must have a body"))
        + start;
    &code[open..block_end(code, open)]
}

/// `code` の中のすべての `fn` の (名前, 本体)。`fn` の直前が空白か行頭で、名前が識別子のもの
/// (`FnOnce(` などは大文字なので当たらない)。`define_class!` の中のメソッドも拾う。
fn all_functions(code: &str) -> Vec<(String, &str)> {
    let mut out = Vec::new();
    for (i, _) in code.match_indices("fn ") {
        if i > 0 && !code[..i].ends_with(|c: char| c.is_whitespace()) {
            continue;
        }
        let rest = &code[i + 3..];
        let name_len = rest
            .char_indices()
            .find(|(_, c)| !(c.is_alphanumeric() || *c == '_'))
            .map(|(j, _)| j)
            .unwrap_or(rest.len());
        if name_len == 0 {
            continue;
        }
        let name = &rest[..name_len];
        if !matches!(rest[name_len..].chars().next(), Some('(') | Some('<')) {
            continue;
        }
        let Some(open_rel) = rest.find('{') else {
            continue;
        };
        let open = i + 3 + open_rel;
        out.push((name.to_string(), &code[open..block_end(code, open)]));
    }
    out
}

/// `segment` と、そこから(推移的に)呼ぶ(`<name>(` が現れる)`code` の fn の本体の全部
/// (同名の fn は全部を候補にする)。**関数呼び出しの名前だけ**をたどる= `sel!(…)` の選択子は進まない
/// ((a) はこの辿り方で「届かない」を見る)。
fn reachable_segments<'a>(segment: &'a str, code: &'a str) -> Vec<&'a str> {
    let functions = all_functions(code);
    let mut out: Vec<&'a str> = vec![segment];
    let mut seen: BTreeSet<usize> = BTreeSet::new();
    let mut i = 0;
    while i < out.len() {
        let text = out[i];
        for (index, (name, body)) in functions.iter().enumerate() {
            if text.contains(&format!("{name}(")) && seen.insert(index) {
                out.push(*body);
            }
        }
        i += 1;
    }
    out
}

/// `segment` か、そこから(推移的に)届く fn の本体のどれかが `hit` を満たすか。
fn reaches_by(segment: &str, code: &str, hit: impl Fn(&str) -> bool) -> bool {
    reachable_segments(segment, code).iter().any(|s| hit(s))
}

/// `segment` か、そこから(推移的に)届く fn の本体のどれかが `needle` を含むか。
fn reaches(segment: &str, needle: &str, code: &str) -> bool {
    reaches_by(segment, code, |s| s.contains(needle))
}

fn is_ident_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// `text` に識別子 `word` が(ほかの識別子の一部でなく)現れるか。
fn contains_word(text: &str, word: &str) -> bool {
    word_positions(text, word).next().is_some()
}

/// `text` の中で識別子 `word` が(ほかの識別子の一部でなく)現れる位置。
fn word_positions<'a>(text: &'a str, word: &'a str) -> impl Iterator<Item = usize> + 'a {
    text.match_indices(word).filter_map(move |(i, _)| {
        let before_ok = text[..i].chars().last().map_or(true, |c| !is_ident_char(c));
        let after_ok = text[i + word.len()..]
            .chars()
            .next()
            .map_or(true, |c| !is_ident_char(c));
        (before_ok && after_ok).then_some(i)
    })
}

/// `text[from..]` を、括弧の深さ 0 の `,`・`]`・`)`・`}` の手前まで(`stop_at_comma` が偽なら `,` では
/// 止まらない)。
fn until_depth_zero_stop(text: &str, from: usize, stop_at_comma: bool) -> &str {
    let bytes = text.as_bytes();
    let mut depth = 0isize;
    let mut i = from;
    let mut in_str = false;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if c == b'\\' {
                i += 1;
            } else if c == b'"' {
                in_str = false;
            }
        } else if c == b'"' {
            in_str = true;
        } else if matches!(c, b'(' | b'[' | b'{') {
            depth += 1;
        } else if matches!(c, b')' | b']' | b'}') {
            if depth == 0 {
                break;
            }
            depth -= 1;
        } else if c == b',' && depth == 0 && stop_at_comma {
            break;
        }
        i += 1;
    }
    &text[from..i]
}

/// `text` の中の `selector: <arg>`(msg_send の引数)または `selector(<arg>)`(メソッド呼び出し)の
/// `<arg>` を全部。`<arg>` は括弧の深さ 0 の `,` / `]` / `)` の手前まで。
fn message_args<'a>(text: &'a str, selector: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    for at in word_positions(text, selector) {
        let after = &text[at + selector.len()..];
        let (start, paren_form) = match after.chars().next() {
            Some(':') => (at + selector.len() + 1, false),
            Some('(') => (at + selector.len() + 1, true),
            _ => continue,
        };
        out.push(until_depth_zero_stop(text, start, !paren_form).trim());
    }
    out
}

/// `text` の中で `selector:` が現れる位置それぞれから、その msg_send の残り(括弧の深さ 0 の `]` / `)` の
/// 手前まで)。同じ msg_send のあとの引数(`withObject:`・`afterDelay:`)を見るため。
fn message_rests<'a>(text: &'a str, selector: &str) -> Vec<&'a str> {
    word_positions(text, selector)
        .filter(|&at| text[at + selector.len()..].starts_with(':'))
        .map(|at| until_depth_zero_stop(text, at, false))
        .collect()
}

/// `arg` が 0 か: `0`・`0.0`・`0.0_f64`・`0f64`(`.into()` 付きも可)、または `const`/`static` の
/// 初期値が 0 の名前。
fn is_zero(arg: &str, code: &str) -> bool {
    let arg = arg.trim().trim_end_matches(".into()").trim();
    fn literal_is_zero(lit: &str) -> bool {
        let lit = lit
            .trim()
            .trim_end_matches("_f64")
            .trim_end_matches("f64")
            .trim_end_matches("_f32")
            .trim_end_matches("f32")
            .replace('_', "");
        lit.parse::<f64>().map_or(false, |v| v == 0.0)
    }
    if arg.starts_with(|c: char| c.is_ascii_digit()) {
        return literal_is_zero(arg);
    }
    let name = arg.rsplit("::").next().unwrap_or(arg);
    if !name.chars().all(is_ident_char) || name.is_empty() {
        return false;
    }
    ["const ", "static "].iter().any(|kw| {
        code.match_indices(&format!("{kw}{name}")).any(|(i, _)| {
            let decl = &code[i..];
            let Some(eq) = decl.find('=') else {
                return false;
            };
            let Some(semi) = decl[eq..].find(';') else {
                return false;
            };
            literal_is_zero(&decl[eq + 1..eq + semi])
        })
    })
}

/// `body` の中で `=>` の直後(`from`)から始まる match の腕の本体: `{ … }` ならそのブロック、式なら
/// 括弧の深さ 0 の `,` か match の閉じ `}` の手前まで。
fn match_arm_body(body: &str, from: usize) -> &str {
    let rest = &body[from..];
    let start = from + (rest.len() - rest.trim_start().len());
    let bytes = body.as_bytes();
    if start < bytes.len() && bytes[start] == b'{' {
        return &body[start..block_end(body, start)];
    }
    until_depth_zero_stop(body, start, true).trim()
}

/// `text[at..]` で最初の `{` から始まるブロック。
fn block_from(text: &str, at: usize) -> Option<&str> {
    let open = at + text[at..].find('{')?;
    Some(&text[open..block_end(text, open)])
}

/// `define_class!( … )` のブロック(括弧の中身を含む)を全部。
fn define_class_blocks(code: &str) -> Vec<&str> {
    code.match_indices("define_class!")
        .filter_map(|(i, m)| {
            let after = i + m.len();
            let open = after + code[after..].find(|c: char| !c.is_whitespace())?;
            (code.as_bytes()[open] == b'(').then(|| &code[open..block_end(code, open)])
        })
        .collect()
}

/// 印刷の終わりの通知の選択子(追補n 契約 1・2)。`#[unsafe(method(…))]` にこのまま現れる。
const DID_RUN_SELECTOR: &str = "printOperationDidRun:success:contextInfo:";

/// 追補n の delegate の `define_class!` ブロック(`printOperationDidRun:success:contextInfo:` のメソッドを
/// 持つもの)。無ければ理由つきで panic。
fn delegate_class(code: &str) -> &str {
    let needle = format!("method({DID_RUN_SELECTOR})");
    define_class_blocks(code)
        .into_iter()
        .find(|block| block.contains(&needle))
        .unwrap_or_else(|| {
            panic!(
                "one define_class! in print.rs must implement #[unsafe(method({DID_RUN_SELECTOR}))] \
                 — the 追補n print-done delegate (追補o 契約 1 hands the timer to that delegate)"
            )
        })
}

// ---------------------------------------------------------------------------
// 追補o の道具 — 閉包・タイマーの予約・選択子の method
// ---------------------------------------------------------------------------

/// `sel!(<名前>)`(`Some(sel!(…))` も可)の `<名前>`。`sel!` の形でなければ `None`。
fn selector_literal(arg: &str) -> Option<&str> {
    let at = arg.find("sel!(")?;
    let inner = &arg[at + "sel!(".len()..];
    let close = inner.find(')')?;
    Some(inner[..close].trim())
}

/// `#[unsafe(method(<selector>))]`(`method_id` でも可)を付けた fn の本体。無ければ `None`。
fn method_fn_body<'a>(code: &'a str, selector: &str) -> Option<&'a str> {
    ["method(", "method_id("].iter().find_map(|kw| {
        let needle = format!("{kw}{selector})");
        let at = code.find(&needle)?;
        let fn_at = code[at..].find("fn ")? + at;
        block_from(code, fn_at)
    })
}

/// `start_print_operation`(macOS)の `run_on_main_thread(` の引数=閉包(括弧の中身。`move || { … }` を
/// 含む)。無ければ理由つきで panic(契約 1 は閉包の中身を定める)。
fn main_thread_closure(code: &str) -> &str {
    let body = fn_body(code, "start_print_operation", "print.rs");
    let at = body.find("run_on_main_thread(").unwrap_or_else(|| {
        panic!(
            "start_print_operation must still build the print operation inside run_on_main_thread( \
             (追補n 契約 1 / 追補o 契約 1):\n{body}"
        )
    });
    let open = at + "run_on_main_thread".len();
    &body[open..block_end(body, open)]
}

/// 閉包から(関数呼び出しの名前で)届く `performSelector:` の msg_send のうち、`sel!(<名前>)` の method が
/// (名前で)`runOperationModalForWindow` に届くもの: (msg_send の残り, 選択子の名前, method の本体)。
struct ScheduledSheet<'a> {
    message: &'a str,
    selector: &'a str,
    method: &'a str,
}

fn runs_the_sheet(text: &str) -> bool {
    contains_word(text, "runOperationModalForWindow")
}

/// 閉包から届く `performSelector:` の予約を全部(選択子が `sel!` でないものや method が無いものは、
/// 理由つきで panic)。1 つも無ければ理由つきで panic。
fn scheduled_sheets<'a>(closure: &'a str, code: &'a str) -> Vec<ScheduledSheet<'a>> {
    let chain = reachable_segments(closure, code);
    let messages: Vec<&str> = chain
        .iter()
        .flat_map(|s| message_rests(*s, "performSelector"))
        .collect();
    assert!(
        !messages.is_empty(),
        "the run_on_main_thread closure of start_print_operation must (transitively) schedule the \
         print sheet with performSelector:withObject:afterDelay: — a 0-second timer on the main run \
         loop — instead of running it inside tao's callback (契約 1). Closure seen:\n{closure}"
    );
    messages
        .into_iter()
        .map(|message| {
            let arg = message_args(message, "performSelector")
                .into_iter()
                .next()
                .unwrap_or_default();
            let selector = selector_literal(arg).unwrap_or_else(|| {
                panic!(
                    "performSelector: must be given a literal sel!(<name>) so the scan can follow it \
                     to the delegate's method, got `{arg}` (契約 1):\n{message}"
                )
            });
            let method = method_fn_body(code, selector).unwrap_or_else(|| {
                panic!(
                    "the selector sel!({selector}) passed to performSelector: must be implemented by a \
                     #[unsafe(method({selector}))] fn in print.rs (契約 1)"
                )
            });
            ScheduledSheet {
                message,
                selector,
                method,
            }
        })
        .collect()
}

/// 閉包から予約した method のうち、(名前で)`runOperationModalForWindow` に届くもの。無ければ理由つきで
/// panic(契約 1: タイマーが鳴ったら delegate がシートを走らせる)。
fn sheet_running_method<'a>(closure: &'a str, code: &'a str) -> ScheduledSheet<'a> {
    let sheets = scheduled_sheets(closure, code);
    let selectors: Vec<&str> = sheets.iter().map(|s| s.selector).collect();
    sheets
        .into_iter()
        .find(|s| reaches_by(s.method, code, runs_the_sheet))
        .unwrap_or_else(|| {
            panic!(
                "the method of a selector the closure schedules with performSelector: must \
                 (transitively) run the print operation with runOperationModalForWindow: \
                 (契約 1). Selectors scheduled: {selectors:?}"
            )
        })
}

// ---------------------------------------------------------------------------
// (a) 閉包からは runOperationModalForWindow に届かない
// ---------------------------------------------------------------------------

/// 1. (a) `start_print_operation` の `run_on_main_thread(` の閉包から、関数呼び出しの名前だけをたどって
///    `runOperationModalForWindow` に届かない(契約 1: tao の run loop の observer の中では走らせない)。
#[test]
fn the_main_thread_closure_does_not_run_the_print_sheet_itself() {
    let code = macos_code();
    let closure = main_thread_closure(&code);
    assert!(
        !runs_the_sheet(closure),
        "the run_on_main_thread closure of start_print_operation must not send \
         runOperationModalForWindow: itself — #715 crashes when the sheet is started from inside \
         tao's run loop observer (契約 1):\n{closure}"
    );
    assert!(
        !reaches_by(closure, &code, runs_the_sheet),
        "nothing the run_on_main_thread closure of start_print_operation calls (by name) may send \
         runOperationModalForWindow: — the sheet must start from a timer on the next pass of the \
         main run loop, not from inside tao's callback (契約 1):\n{closure}"
    );
}

// ---------------------------------------------------------------------------
// (b) 閉包は 0 秒のタイマーを予約し、その選択子の method がシートを走らせる
// ---------------------------------------------------------------------------

/// 2. (b) 閉包から `performSelector:` と `afterDelay:`(値は 0)に届き、その `sel!(<名前>)` の
///    `#[unsafe(method(<名前>))]` の fn から(名前で)`runOperationModalForWindow` に届く(契約 1)。
///    シートを走らせる method を予約する msg_send は、どれも `withObject:` と `afterDelay: 0` を持つ。
#[test]
fn the_closure_schedules_the_print_sheet_on_a_zero_delay_timer() {
    let code = macos_code();
    let closure = main_thread_closure(&code);
    let sheets = scheduled_sheets(closure, &code);
    let running: Vec<&ScheduledSheet> = sheets
        .iter()
        .filter(|s| reaches_by(s.method, &code, runs_the_sheet))
        .collect();
    assert!(
        !running.is_empty(),
        "the method of a selector the closure schedules with performSelector: must (transitively) \
         run the print operation with runOperationModalForWindow: (契約 1). Selectors scheduled: {:?}",
        sheets.iter().map(|s| s.selector).collect::<Vec<_>>()
    );
    for sheet in running {
        assert!(
            contains_word(sheet.message, "withObject"),
            "the timer must be performSelector:withObject:afterDelay: (withObject: in the same \
             msg_send) (契約 1):\n{}",
            sheet.message
        );
        let delays = message_args(sheet.message, "afterDelay");
        assert!(
            !delays.is_empty(),
            "the timer must be performSelector:withObject:afterDelay: (afterDelay: in the same \
             msg_send) — a plain performSelector: would still run inside tao's callback (契約 1):\n{}",
            sheet.message
        );
        for delay in delays {
            assert!(
                is_zero(delay, &code),
                "afterDelay: must be 0 — the next pass of the main run loop, not later — got `{delay}` \
                 (契約 1):\n{}",
                sheet.message
            );
        }
        assert!(
            !contains_word(sheet.message, "inModes"),
            "the timer must go on the run loop's default mode: performSelector:withObject:afterDelay: \
             without inModes: (契約 1):\n{}",
            sheet.message
        );
    }
}

/// 3. (b・契約 1) シートを走らせる method は、追補n の delegate(`printOperationDidRun:success:contextInfo:`
///    を実装する `define_class!`)のもの=タイマーが鳴ったら、終わりの通知を受ける同じ delegate が走らせる。
#[test]
fn the_scheduled_method_belongs_to_the_print_done_delegate() {
    let code = macos_code();
    let closure = main_thread_closure(&code);
    let sheet = sheet_running_method(closure, &code);
    let delegate = delegate_class(&code);
    let implemented = ["method(", "method_id("]
        .iter()
        .any(|kw| delegate.contains(&format!("{kw}{})", sheet.selector)));
    assert!(
        implemented,
        "#[unsafe(method({}))] must be implemented on the 追補n delegate — the define_class! that \
         also implements {DID_RUN_SELECTOR} — so the same object schedules the sheet and hears its end \
         (契約 1)",
        sheet.selector
    );
}

// ---------------------------------------------------------------------------
// (c) その method: 窓が無ければ印刷しないで返す・catch_unwind で包む・panic なら閉じる
// ---------------------------------------------------------------------------

/// `body` の中で、`get_webview_window(` の結果が無いときに早く返す(`return` を含む)腕の本体:
/// `… get_webview_window(…).is_none() { … }`・`let Some(..) = … get_webview_window(…) else { … }`・
/// `match … get_webview_window(…) { None => … }`。見つかれば (腕の位置, 腕の本体)。
fn no_window_early_return(body: &str) -> Option<(usize, &str)> {
    let is_none = body.match_indices(".is_none()").find_map(|(at, m)| {
        let stmt_start = body[..at]
            .rfind(|c: char| matches!(c, ';' | '{' | '}'))
            .map_or(0, |i| i + 1);
        if !body[stmt_start..at].contains("get_webview_window(") {
            return None;
        }
        let after = at + m.len();
        let open = after + body[after..].find('{')?;
        // `.is_none() {` の直後のブロック(途中に `;` が挟まれば別の文)
        if body[after..open].contains(';') {
            return None;
        }
        let arm = &body[open..block_end(body, open)];
        contains_word(arm, "return").then_some((at, arm))
    });
    let let_else = body.match_indices("let Some(").find_map(|(at, _)| {
        let after = &body[at..];
        let else_at = word_positions(after, "else").next()?;
        if !after[..else_at].contains("get_webview_window(") || after[..else_at].contains(';') {
            return None;
        }
        let open = after[else_at..].find('{')? + else_at;
        let arm = &after[open..block_end(after, open)];
        contains_word(arm, "return").then_some((at, arm))
    });
    let none_arm = word_positions(body, "match").find_map(|at| {
        let open = at + body[at..].find('{')?;
        if !body[at..open].contains("get_webview_window(") {
            return None;
        }
        let block = &body[open..block_end(body, open)];
        word_positions(block, "None").find_map(|none_at| {
            let after = &block[none_at + "None".len()..];
            let trimmed = after.trim_start();
            if !trimmed.starts_with("=>") {
                return None;
            }
            let arrow_end = none_at + "None".len() + (after.len() - trimmed.len()) + "=>".len();
            let arm = match_arm_body(block, arrow_end);
            contains_word(arm, "return").then_some((at, arm))
        })
    });
    [is_none, let_else, none_arm]
        .into_iter()
        .flatten()
        .min_by_key(|(at, _)| *at)
}

/// 4. (c) シートを走らせる method は、印刷窓が無いとき(`get_webview_window` が `None`)印刷せずに返す:
///    `catch_unwind(` より前に、`get_webview_window(` の結果が無ければ `return` する腕があり、その腕は
///    `runOperationModalForWindow` に届かない(契約 2)。
#[test]
fn the_scheduled_method_returns_without_printing_when_the_window_is_gone() {
    let code = macos_code();
    let closure = main_thread_closure(&code);
    let sheet = sheet_running_method(closure, &code);
    let body = sheet.method;
    assert!(
        body.contains("get_webview_window("),
        "the method for sel!({}) must look the print window up with get_webview_window( before \
         running its sheet — the window may have gone while the timer was pending (契約 2):\n{body}",
        sheet.selector
    );
    let (guard_at, arm) = no_window_early_return(body).unwrap_or_else(|| {
        panic!(
            "the method for sel!({}) must return early when get_webview_window( finds no print \
             window: `… .is_none() {{ … return … }}`, `let Some(..) = … else {{ … return … }}` or \
             `match … {{ None => … return … }}` (契約 2):\n{body}",
            sheet.selector
        )
    });
    assert!(
        !reaches_by(arm, &code, runs_the_sheet),
        "the no-window arm must not run the sheet (契約 2):\n{arm}"
    );
    let unwind_at = body.find("catch_unwind(").unwrap_or_else(|| {
        panic!(
            "the method for sel!({}) must run the sheet under catch_unwind( (契約 2):\n{body}",
            sheet.selector
        )
    });
    assert!(
        guard_at < unwind_at,
        "the print window must be looked up (and the early return taken) before the sheet is run \
         under catch_unwind( (契約 2):\n{body}"
    );
}

/// `after`(`catch_unwind(…)` のあとの本体)の中の、panic の腕の本体: `<r>.is_err() { … }`・
/// `if let Err(..) = <r> { … }`・`Err(..) => …` のうち最初のもの。
fn panic_arm(after: &str) -> Option<&str> {
    let is_err = after
        .find(".is_err()")
        .and_then(|at| block_from(after, at + ".is_err()".len()));
    let let_err = after
        .find("let Err(")
        .and_then(|at| block_from(after, at));
    let match_err = after.match_indices("Err(").find_map(|(at, _)| {
        if after[..at].chars().last().map_or(false, is_ident_char) {
            return None;
        }
        let close = block_end(after, at + "Err".len());
        let rest = &after[close..];
        let trimmed = rest.trim_start();
        if !trimmed.starts_with("=>") {
            return None;
        }
        let arrow_end = close + (rest.len() - trimmed.len()) + "=>".len();
        Some(match_arm_body(after, arrow_end))
    });
    let candidates = [
        is_err.map(|arm| (after.find(".is_err()").unwrap_or(0), arm)),
        let_err.map(|arm| (after.find("let Err(").unwrap_or(0), arm)),
        match_err.map(|arm| (after.find(arm).unwrap_or(0), arm)),
    ];
    candidates
        .into_iter()
        .flatten()
        .min_by_key(|(at, _)| *at)
        .map(|(_, arm)| arm)
}

/// 5. (c) シートを走らせる処理は `catch_unwind(` で包む(`runOperationModalForWindow` には method の本体から
///    その括弧の中を通ってだけ届く)。panic なら(`is_err()` / `Err` の腕で)印刷窓を `.close()` する=
///    終わりの通知が来ないため(契約 2)。
#[test]
fn the_scheduled_method_runs_the_sheet_under_catch_unwind_and_closes_the_window_on_panic() {
    let code = macos_code();
    let closure = main_thread_closure(&code);
    let sheet = sheet_running_method(closure, &code);
    let body = sheet.method;
    let unwinds: Vec<(usize, &str)> = body
        .match_indices("catch_unwind(")
        .map(|(at, _)| {
            let open = at + "catch_unwind".len();
            (at, &body[open..block_end(body, open)])
        })
        .collect();
    let (unwind_at, guarded) = unwinds
        .iter()
        .copied()
        .find(|(_, inner)| reaches_by(*inner, &code, runs_the_sheet))
        .unwrap_or_else(|| {
            panic!(
                "the method for sel!({}) must run the sheet inside catch_unwind(AssertUnwindSafe(|| …)) \
                 — it runs from the run loop's timer callout, where an unwinding panic would stop \
                 the app (契約 2):\n{body}",
                sheet.selector
            )
        });
    let outside = format!("{}{}", &body[..unwind_at], &body[unwind_at + guarded.len() + "catch_unwind".len()..]);
    assert!(
        !reaches_by(&outside, &code, runs_the_sheet),
        "runOperationModalForWindow: must be reached only through the catch_unwind( of the method for \
         sel!({}) — never from the method outside it (契約 2):\n{outside}",
        sheet.selector
    );
    let after = &body[unwind_at + "catch_unwind".len() + guarded.len()..];
    let arm = panic_arm(after).unwrap_or_else(|| {
        panic!(
            "after catch_unwind( the method for sel!({}) must take the panic in an `.is_err() {{ … }}`, \
             `if let Err(..) = … {{ … }}` or `Err(..) => …` arm (契約 2):\n{after}",
            sheet.selector
        )
    });
    assert!(
        reaches(arm, ".close()", &code),
        "when running the sheet panics, the method for sel!({}) must close the print window (.close() \
         in the panic arm, directly or through a fn it calls) — no printOperationDidRun: will come \
         (契約 2). Arm seen:\n{arm}",
        sheet.selector
    );
}

// ---------------------------------------------------------------------------
// (d) print_html への返事はタイマーの予約より前(組み立てより後)
// ---------------------------------------------------------------------------

/// `start_print_operation` の本体の `let (<tx>, <rx>) = … channel(…)` の送り手 `<tx>` の名前。
fn reply_sender(body: &str) -> &str {
    let at = word_positions(body, "channel")
        .find(|&at| body[at + "channel".len()..].starts_with('('))
        .unwrap_or_else(|| {
            panic!(
                "start_print_operation must answer print_html through a channel (`let (<tx>, <rx>) = \
                 … channel()`) so the reply is sent from inside the closure (契約 3):\n{body}"
            )
        });
    let stmt_start = body[..at]
        .rfind(|c: char| matches!(c, ';' | '{' | '}'))
        .map_or(0, |i| i + 1);
    let head = &body[stmt_start..at];
    let open = head.find("let (").unwrap_or_else(|| {
        panic!("the channel must be bound as `let (<tx>, <rx>) = …` (契約 3):\n{head}")
    }) + "let (".len();
    let name: &str = &head[open..];
    let name = name.trim_start();
    let len = name
        .find(|c: char| !is_ident_char(c))
        .unwrap_or(name.len());
    assert!(len > 0, "the channel's sender must have a name:\n{head}");
    &name[..len]
}

/// `closure` の中で `<tx>.send(Ok(` が現れる位置(最初のもの)。
fn ok_reply_at(closure: &str, tx: &str) -> Option<usize> {
    word_positions(closure, tx).find(|&at| {
        let after = closure[at + tx.len()..].trim_start();
        after.starts_with(".send(") && after[".send(".len()..].trim_start().starts_with("Ok(")
    })
}

/// `closure` の中で、`hit` を満たす文字列を(名前で)届かせる最初の呼び出しの位置: `closure` 自身に
/// 現れる `direct` の位置と、`hit` に届く fn の `<name>(` の位置の最小。
fn first_call_reaching(closure: &str, code: &str, direct: &str, hit: impl Fn(&str) -> bool + Copy) -> Option<usize> {
    let own = word_positions(closure, direct).next();
    let via_fn = all_functions(code)
        .into_iter()
        .filter(|(_, body)| reaches_by(*body, code, hit))
        .filter_map(|(name, _)| closure.find(&format!("{name}(")))
        .min();
    [own, via_fn].into_iter().flatten().min()
}

/// 6. (d) 閉包の中の `print_html` への返事(channel の送り手の `.send(Ok(`)は、タイマーの予約
///    (`performSelector` に届く呼び出し)より前にあり、印刷操作の組み立て(`printOperationWithPrintInfo`
///    に届く呼び出し)より後にある(契約 1・3: 返事は組み立てたあと・シートを出す前)。
#[test]
fn the_reply_to_print_html_is_sent_before_the_timer_is_scheduled() {
    let code = macos_code();
    let body = fn_body(&code, "start_print_operation", "print.rs");
    let tx = reply_sender(body);
    let closure = main_thread_closure(&code);
    let reply_at = ok_reply_at(closure, tx).unwrap_or_else(|| {
        panic!(
            "the run_on_main_thread closure of start_print_operation must answer print_html itself \
             with `{tx}.send(Ok(` — not from the scheduled method (契約 3):\n{closure}"
        )
    });
    let schedule_at = first_call_reaching(closure, &code, "performSelector", |s| {
        contains_word(s, "performSelector")
    })
    .unwrap_or_else(|| {
        panic!(
            "the run_on_main_thread closure of start_print_operation must (transitively) schedule the \
             sheet with performSelector: (契約 1):\n{closure}"
        )
    });
    assert!(
        reply_at < schedule_at,
        "`{tx}.send(Ok(` (the reply to print_html) must come before the timer is scheduled \
         (performSelector:), so the reply never waits on the sheet (契約 3):\n{closure}"
    );
    let build_at = first_call_reaching(closure, &code, "printOperationWithPrintInfo", |s| {
        contains_word(s, "printOperationWithPrintInfo")
    })
    .unwrap_or_else(|| {
        panic!(
            "the run_on_main_thread closure of start_print_operation must (transitively) build the \
             print operation (printOperationWithPrintInfo:) (追補n 契約 1):\n{closure}"
        )
    });
    assert!(
        build_at < reply_at,
        "the print operation must be built before `{tx}.send(Ok(` answers print_html — a build that \
         fails must reach the caller as Err (契約 3):\n{closure}"
    );
}
