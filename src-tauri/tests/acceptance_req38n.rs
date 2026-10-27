//! 要件#38 追補n の受け入れテスト(docs/requirements/req-38.md 追補n・Issue #718)— Rust 層
//!
//! 「印刷窓を、印刷の終わりの通知で閉じる」
//!
//! 発見: 追補m は印刷窓のシートの有無を 250ms ごとに見て「付いた → 外れた」で閉じていたが、
//! パネルを 0.5 秒未満で閉じると最初の確かめより前にシートが付いて外れ、「一度も付かなかった」と
//! 区別できずに印刷窓が残る(reviewer の P3・2026-10-21 の機械駆動で 3/3 再現)。wry 0.54.4 の
//! `print()` は `runOperationModalForWindow:delegate:nil didRunSelector:nil contextInfo:NULL` で、
//! 印刷操作の終わりを知らせる口を持たない。
//!
//! 契約(追補n):
//! 1. **印刷窓の印刷は自前の印刷操作で出す**: `open_print_window` は印刷窓に wry の `print()` を使わない。
//!    メインスレッドで、印刷窓の WKWebView に `printOperationWithPrintInfo:` で印刷操作を作らせ、印刷窓の
//!    シートとして `runOperationModalForWindow:delegate:didRunSelector:contextInfo:` で出す。このとき
//!    終わりを受け取る相手(delegate)と選択子 `printOperationDidRun:success:contextInfo:` を渡す。
//!    印刷情報は `NSPrintInfo sharedPrintInfo`、余白は 4 辺とも 0、`setCanSpawnSeparateThread:` は YES
//!    = wry 0.54.4 の `print()` と同じ設定
//! 2. **終わりの通知で印刷窓を閉じる**: 通知が来たら(`success` は問わない)印刷窓を `close()` する。
//!    窓がもう無ければ何もしない。通知の処理の中では窓を閉じる頼みを出すだけにする
//! 3. **シートの見張りはやめる**: `SheetWatch`・`SheetWatchAction`・`SHEET_WATCH_INTERVAL`・
//!    `SHEET_WATCH_GRACE`・`SHEET_WATCH_TIMEOUT`・`PRINT_BLOCKED_AFTER`・`attachedSheet` を消す
//! 4. **始められなければ窓を閉じて Err**: メインスレッドに届かない・WKWebView か NSWindow が取れない・
//!    WKWebView が `printOperationWithPrintInfo:` に応えないか nil を返す → 印刷窓を閉じて `Err`
//! 5. **依存は足さない**: 新しいクレートも `objc2-app-kit` の features も足さない。AppKit / WebKit は
//!    型なしの `msg_send!` で呼ぶ。delegate のクラスは objc2 の `define_class!` で作り、名前は `Vellis`
//!    で始める。NSPrintOperation は delegate を保持しないので、アプリ側が終わりまで生かしておく
//! 6. **不変**: 追補m の 2・3・4・Finished 待ち(`LOAD_TIMEOUT`)と猶予(`PRINT_SETTLE`)・markdown / text
//!    の印刷・PDF の印刷・`print.css`・印刷窓の protocol と CSP・`print_html` の応答は印刷の終わりを
//!    待たない。macOS 以外は今のまま wry の `print()` を呼ぶ(自動では閉じない)
//!
//! 本ファイルの持ち場= AC-38-追n の (a)〜(e)。AppKit 依存で振る舞いは試せないので全部ソース走査
//! (`print.rs` のコメントを落とした本文。(b)〜(d) は `#[cfg(not(target_os = "macos"))]` の項目を
//! 除いた**macOS の経路**で見る):
//! - (a) `print.rs` に見張りの記号(契約 3 の 6 つ・`attachedSheet`)が無い
//! - (b) `open_print_window` は `.print()` を呼ばず(macOS)、`LOAD_TIMEOUT` の Finished 待ちと
//!   `PRINT_SETTLE` の猶予のあとに自前の印刷操作を始める fn を呼ぶ。その fn は(推移的に)メインスレッドで
//!   `printOperationWithPrintInfo`・`sharedPrintInfo`・余白 4 辺=0・`setCanSpawnSeparateThread`=true・
//!   `runOperationModalForWindow` を使い、delegate(null でない)と選択子
//!   `printOperationDidRun:success:contextInfo:` を渡す。macOS 以外の経路は `.print()` のまま。
//!   **追補o の要件側の更新(2026-10-25 由谷承認)**: テスト 5・6 の「推移的に届く」は、関数呼び出しの
//!   名前(`<name>(`)に加えて、`performSelector:` に渡した `sel!(<名前>)` から `#[unsafe(method(<名前>))]`
//!   の fn へ進む(追補o 契約 1 で印刷操作を走らせるのが、0 秒のタイマーで呼ばれる delegate の method に
//!   なるため)。2 件の主張(wry と同じ設定・delegate と選択子を渡す)は変えない。ほかのテストの辿り方は
//!   そのまま(`reachable_segments`)
//! - (c) delegate は `define_class!` で `Vellis` で始まる名前・`printOperationDidRun:success:contextInfo:`
//!   を実装し、そのメソッドの本体から(推移的に)印刷窓の `.close()` に届く
//! - (d) 始められない経路: 始める fn は `Result` を返し、`respondsToSelector` を見る。`open_print_window` は
//!   始める fn の結果を受ける `Err` の腕の**ブロックの中で**印刷窓を `.close()` して `return Err(` する
//!   (腕のブロックを波括弧の対応で切り出して見る。推移的には辿らない)。印刷操作を作る fn は
//!   `printOperationWithPrintInfo:` を送る文**以降**で、nil の戻りを `Err` にする(`let Some(..) = .. else { Err }`
//!   / `None => Err` / `.ok_or(`)。`.unwrap()` / `.expect(` で済ませない
//! - (e) 依存のクレート名の集合と `objc2-app-kit` の features の集合が起案時点(2026-10-21)と同一
//!
//! 持ち場の外:
//! - (f) 既存の要件#38 のテストが(要件側の更新= `acceptance_req38m.rs` の見張りの固定を消したことを
//!   除いて)無改変で緑=同じ周回のフルスイート
//! - 契約 2(印刷窓が残っていればアプリを終えない)= `acceptance_req12a.rs`・契約 3(印刷窓は1つまで)
//!   = `acceptance_req38m.rs` の (c)
//!
//! ## 確定契約(implementer はこれに従う。ソース走査はこの形を前提に書いてある)
//!
//! ```ignore
//! // src-tauri/src/print.rs
//!
//! // - `open_print_window`(シグネチャ・呼び出し元は不変)の macOS の経路は、`tokio::time::sleep(PRINT_SETTLE)`
//! //   のあとで、印刷操作を始める fn(名前は自由。本体に書いてもよい)を呼ぶ。その fn(または本体)から
//! //   (推移的に)次が届く:
//! //     `run_on_main_thread(`(または `MainThreadMarker`)の中で
//! //     `respondsToSelector`(WKWebView が `printOperationWithPrintInfo:` に応えるか)、
//! //     `msg_send![class!(NSPrintInfo), sharedPrintInfo]`、
//! //     `setTopMargin: 0.0` / `setRightMargin: 0.0` / `setBottomMargin: 0.0` / `setLeftMargin: 0.0`
//! //       (`0`・`0.0`・`0.0_f64`、または `= 0.0` の const の名前。4 辺とも)、
//! //     `printOperationWithPrintInfo: &*info`(nil → `Err`)、
//! //     `setCanSpawnSeparateThread: true`(`Bool::YES` でも可)、
//! //     `runOperationModalForWindow: &*ns_window, delegate: <delegate(null / None でない)>,
//! //       didRunSelector: Some(sel!(printOperationDidRun:success:contextInfo:)), contextInfo: …`
//! //       (選択子は `sel!` の中に空白なしでこのまま書く。別の fn が返す形でもよい)
//! //     追補o(2026-10-25)以降: `runOperationModalForWindow:…` は `performSelector: sel!(<名前>), …,
//! //       afterDelay: 0` で予約した `#[unsafe(method(<名前>))]` の fn(から名前でたどれる fn)に書いてよい。
//! //       テスト 5・6 はその選択子をたどる(`acceptance_req38o.rs` が予約の形を固定する)
//! // - 始める fn は `Result<_, String>` を返し、`open_print_window` はその `Err` で印刷窓を `.close()`
//! //   して `Err` を返す。形は `if let Err(e) = <呼び出し> { … }`・`let Err(e) = <呼び出し> else { … }`・
//! //   `match <呼び出し> { …, Err(e) => { … } }`(結果を変数に受けてから同じ形で見てもよい)のどれかで、
//! //   その腕のブロックの中に `.close()` と `return Err(`(または腕の末尾の式が `Err(`)の両方を書く
//! //   (`.map_err(` + `?` だけの形は走査が腕を見つけられない=その形にするなら test-writer に戻す)
//! // - 印刷操作を作る fn は `printOperationWithPrintInfo:` の戻りを `Option` に受け、送る文のあとで
//! //   `let Some(op) = op else { return Err(…) }` / `match` の `None => Err` / `.ok_or(_else)(` のどれかで
//! //   nil を `Err` にする。送る文のあとに `.unwrap()` / `.expect(` を書かない
//! // - macOS の経路の `print.rs` には `.print(` / `.print_with_options(` が現れない。macOS 以外の経路は
//! //   `#[cfg(not(target_os = "macos"))]` を付けた fn かブロック(`#[cfg(not(target_os = "macos"))] { … }`)
//! //   の中で今までどおり `.print()` を呼ぶ(`if cfg!(…)` では分けない=走査が cfg 属性で経路を分けるため)
//! // - delegate は `define_class!( … )` で作る(`#[cfg(target_os = "macos")]`)。`#[name = "Vellis…"]`
//! //   (省略するなら struct の名前が `Vellis` で始まる)。
//! //   `#[unsafe(method(printOperationDidRun:success:contextInfo:))]` を付けたメソッド(空白なし)の本体
//! //   (または、そこから呼ぶ fn)に印刷窓の `.close()` が現れる(`get_webview_window(&label)` で探して
//! //   あれば `close()`。`run_on_main_thread` / `spawn` の閉包の中でもよい。チャネルで別の task に渡し、
//! //   受け手が閉じる作りは、本ファイルの走査では「届く」と判定できない=その形にするなら test-writer に戻す)
//! // - `SheetWatch`・`SheetWatchAction`・`SHEET_WATCH_INTERVAL`・`SHEET_WATCH_GRACE`・`SHEET_WATCH_TIMEOUT`・
//! //   `PRINT_BLOCKED_AFTER`・`attachedSheet` の識別子は `print.rs` から消す(コメント以外)
//! // - Cargo.toml の依存のクレート名と `objc2-app-kit` の features は今のまま
//! ```
//!
//! ## reviewer 照合に委ねる配線(AppHandle / AppKit 依存で機械判定不能)
//! - delegate の寿命: NSPrintOperation は delegate を retain しないので、アプリ側が印刷操作の終わりまで
//!   生かし(`Retained` を持ち続ける)、通知のあとで手放すこと(契約 5)
//! - 通知で閉じる窓が印刷窓(`label`)であること・窓がもう無ければ何もしないこと(契約 2)
//! - `print_html` の応答(`open_print_window` の `Ok`)が印刷の終わりの通知を待たないこと(契約 6)
//! - 余白の 0 と `sharedPrintInfo` が印刷窓の印刷操作(PDF の経路ではなく)に渡っていること(契約 1)
//! - `respondsToSelector` が false のとき・`ns_window()` が取れないときのそれぞれが `Err` に流れること
//!   (契約 4。`printOperationWithPrintInfo:` が nil のときは 14 で見る)
//!
//! ## 人間ゲート(機械で駆動できる=req-38.md 追補n)
//! - パネルを 0.5 秒未満で閉じても印刷窓が閉じる(Issue #718 の再現手順で 0/3)・パネルを 2 秒以上出して
//!   からの Cancel と PDF に保存でも閉じる・PDF にページが全部載る・パネルを出したまま文書の窓を閉じると
//!   アプリが残り、パネルを閉じると終わる・連打で印刷窓は 1 枚

use std::collections::BTreeSet;

// ---------------------------------------------------------------------------
// 走査の道具 — acceptance_req38m.rs / acceptance_req38k.rs の strip_line_comments / fn_body /
// block_end / all_functions / reaches の流儀(テスト間でコードは共有しないので写す)
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

/// `#[cfg(…)]` が macOS だけの条件か(`target_os = "macos"` を含み、`not(…)` ではない)。
fn cfg_only_macos(attr: &str) -> bool {
    let f = flat(attr);
    f.contains("target_os=\"macos\"") && !f.contains("not(target_os=\"macos\")")
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

/// `print.rs` の macOS 以外の経路(`#[cfg(target_os = "macos")]` の項目を除いた本文)。
fn non_macos_code() -> String {
    without_cfg_items(&print_module_code(), cfg_only_macos)
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

/// `fn <name>` の定義からシグネチャ(`fn` から本体の `{` の前まで)。
fn fn_signature<'a>(code: &'a str, name: &str) -> &'a str {
    let start = fn_definition(code, name).unwrap_or_else(|| panic!("print.rs must define {name}"));
    let open = code[start..].find('{').unwrap_or_else(|| panic!("{name} must have a body")) + start;
    &code[start..open]
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
/// (同名の fn は全部を候補にする)。
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

/// `sel!(<名前>)`(`Some(sel!(…))` も可)の `<名前>`。`sel!` の形でなければ `None`。
fn selector_literal(arg: &str) -> Option<&str> {
    let at = arg.find("sel!(")?;
    let inner = &arg[at + "sel!(".len()..];
    let close = inner.find(')')?;
    Some(inner[..close].trim())
}

/// `text` の中で `performSelector:` に渡した `sel!(<名前>)` の `<名前>` を全部(追補o 契約 1 のタイマー
/// `performSelector:withObject:afterDelay:`)。
fn performed_selectors(text: &str) -> Vec<&str> {
    message_args(text, "performSelector")
        .into_iter()
        .filter_map(selector_literal)
        .collect()
}

/// `#[unsafe(method(<selector>))]`(`method_id` でも可)を付けた fn の名前。無ければ `None`。
fn method_fn_name<'a>(code: &'a str, selector: &str) -> Option<&'a str> {
    ["method(", "method_id("].iter().find_map(|kw| {
        let needle = format!("{kw}{selector})");
        let at = code.find(&needle)?;
        let fn_at = code[at..].find("fn ")? + at + "fn ".len();
        let name_len = code[fn_at..]
            .find(|c: char| !is_ident_char(c))
            .unwrap_or(code.len() - fn_at);
        (name_len > 0).then(|| &code[fn_at..fn_at + name_len])
    })
}

/// `reachable_segments` に、`performSelector:` に渡した `sel!(<名前>)` から `#[unsafe(method(<名前>))]`
/// の fn の本体へ進む辿り方を足したもの(追補o の要件側の更新・2026-10-25 由谷承認。テスト 5・6 だけが使う)。
fn reachable_segments_through_performed_selectors<'a>(segment: &'a str, code: &'a str) -> Vec<&'a str> {
    let functions = all_functions(code);
    let mut out: Vec<&'a str> = vec![segment];
    let mut seen: BTreeSet<usize> = BTreeSet::new();
    let mut i = 0;
    while i < out.len() {
        let text = out[i];
        let performed: Vec<&str> = performed_selectors(text)
            .into_iter()
            .filter_map(|selector| method_fn_name(code, selector))
            .collect();
        for (index, (name, body)) in functions.iter().enumerate() {
            let called = text.contains(&format!("{name}(")) || performed.contains(&name.as_str());
            if called && seen.insert(index) {
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
        let bytes = text.as_bytes();
        let mut depth = 0isize;
        let mut i = start;
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
            } else if c == b',' && depth == 0 && !paren_form {
                break;
            }
            i += 1;
        }
        out.push(text[start..i].trim());
    }
    out
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

/// 印刷の終わりの通知の選択子(契約 1・2)。`sel!(…)` と `#[unsafe(method(…))]` の両方にこのまま現れる。
const DID_RUN_SELECTOR: &str = "printOperationDidRun:success:contextInfo:";

/// `open_print_window`(macOS の経路)の、印刷操作を始める筋。
struct PrintStart<'a> {
    /// `PRINT_SETTLE` の sleep より前の本体(Finished 待ちがここにある)。
    before_settle: &'a str,
    /// `PRINT_SETTLE` の sleep の文のあとの本体(印刷操作はここから始まる)。
    after_settle: &'a str,
    /// 印刷操作を始める fn の名前(本体に直接書いてあれば `open_print_window`)。
    starter_name: String,
    /// その fn の本体(本体に直接書いてあれば `after_settle`)。
    starter_body: &'a str,
    /// `after_settle` の中で、始める fn を呼ぶ位置(直接なら `printOperationWithPrintInfo` の位置)。
    call_at: usize,
}

fn builds_print_operation(text: &str) -> bool {
    contains_word(text, "printOperationWithPrintInfo")
}

/// `open_print_window`(macOS の経路)を `PRINT_SETTLE` の前後に分け、猶予のあとで印刷操作を始める
/// fn(`printOperationWithPrintInfo` に推移的に届く fn のうち、猶予のあとの本体で最初に呼ばれるもの)
/// を見つける。無ければ理由つきで panic。
fn print_start(code: &str) -> PrintStart<'_> {
    let body = fn_body(code, "open_print_window", "print.rs");
    let settle_at = body.find("PRINT_SETTLE").unwrap_or_else(|| {
        panic!("open_print_window must still pause for PRINT_SETTLE before printing (契約 6):\n{body}")
    });
    let settle_end = settle_at + body[settle_at..].find(';').map_or(0, |i| i + 1);
    let before_settle = &body[..settle_at];
    let after_settle = &body[settle_end..];
    if let Some(call_at) = word_positions(after_settle, "printOperationWithPrintInfo").next() {
        return PrintStart {
            before_settle,
            after_settle,
            starter_name: String::from("open_print_window"),
            starter_body: after_settle,
            call_at,
        };
    }
    let functions = all_functions(code);
    let (call_at, starter_name, starter_body) = functions
        .iter()
        .filter(|(name, fbody)| name != "open_print_window" && reaches_by(fbody, code, builds_print_operation))
        .filter_map(|(name, fbody)| {
            after_settle
                .find(&format!("{name}("))
                .map(|at| (at, name.clone(), *fbody))
        })
        .min_by_key(|(at, _, _)| *at)
        .unwrap_or_else(|| {
            panic!(
                "after the PRINT_SETTLE pause, open_print_window must start its own print operation: \
                 call a fn that (transitively) sends printOperationWithPrintInfo: to the print window's \
                 WKWebView (契約 1):\n{after_settle}"
            )
        });
    PrintStart {
        before_settle,
        after_settle,
        starter_name,
        starter_body,
        call_at,
    }
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

/// 印刷の終わりを受け取る delegate の `define_class!` ブロック(`printOperationDidRun:success:contextInfo:`
/// のメソッドを持つもの)。無ければ理由つきで panic。
fn delegate_class(code: &str) -> &str {
    let blocks = define_class_blocks(code);
    assert!(
        !blocks.is_empty(),
        "print.rs must define the print-done delegate's class with objc2's define_class! (契約 5)"
    );
    let needle = format!("method({DID_RUN_SELECTOR})");
    blocks
        .into_iter()
        .find(|block| block.contains(&needle))
        .unwrap_or_else(|| {
            panic!(
                "one define_class! in print.rs must implement #[unsafe(method({DID_RUN_SELECTOR}))] \
                 — the print operation's did-run selector (契約 1・2)"
            )
        })
}

/// `define_class!` ブロックの Objective-C のクラス名: `#[name = "…"]` があればその文字列、無ければ
/// `struct <Name>` の名前(objc2 はそれをクラス名にする)。
fn objc_class_name(block: &str) -> String {
    if let Some(at) = block.find("#[name") {
        let rest = &block[at..];
        let open = rest.find('"').expect("#[name = …] must carry a string literal");
        let close = rest[open + 1..].find('"').expect("#[name = \"…\"] must close its string") + open + 1;
        return rest[open + 1..close].to_string();
    }
    let at = block.find("struct ").expect("define_class! must declare a struct");
    block[at + "struct ".len()..]
        .chars()
        .take_while(|c| is_ident_char(*c))
        .collect()
}

/// `define_class!` ブロックの中の、`method(<selector>)` を付けたメソッドの本体。
fn method_body<'a>(block: &'a str, selector: &str) -> &'a str {
    let needle = format!("method({selector})");
    let at = block
        .find(&needle)
        .unwrap_or_else(|| panic!("the delegate must implement #[unsafe(method({selector}))]"));
    let fn_at = block[at..]
        .find("fn ")
        .unwrap_or_else(|| panic!("#[unsafe(method({selector}))] must be followed by a fn"))
        + at;
    let open = block[fn_at..].find('{').expect("the did-run method must have a body") + fn_at;
    &block[open..block_end(block, open)]
}

// ---------------------------------------------------------------------------
// (a) 見張りの記号が無い(契約 3)
// ---------------------------------------------------------------------------

/// 1. (a) `SheetWatch`・`SheetWatchAction`・`SHEET_WATCH_INTERVAL`・`SHEET_WATCH_GRACE`・
///    `SHEET_WATCH_TIMEOUT`・`PRINT_BLOCKED_AFTER` が `print.rs` の本文(コメント以外)に無い。
#[test]
fn the_sheet_watch_types_and_constants_are_gone() {
    let code = print_module_code();
    for symbol in [
        "SheetWatch",
        "SheetWatchAction",
        "SHEET_WATCH_INTERVAL",
        "SHEET_WATCH_GRACE",
        "SHEET_WATCH_TIMEOUT",
        "PRINT_BLOCKED_AFTER",
    ] {
        assert!(
            !contains_word(&code, symbol),
            "{symbol} belongs to the 追補m sheet watch and must be removed from print.rs (契約 3)"
        );
    }
}

/// 2. (a) `attachedSheet` を読まない(シートの有無を見る作りが無い)。
#[test]
fn attached_sheet_is_no_longer_read() {
    let code = print_module_code();
    assert!(
        !contains_word(&code, "attachedSheet"),
        "print.rs must no longer look at the print window's attachedSheet — the end of printing is \
         told by the print operation's delegate instead (契約 3)"
    );
}

// ---------------------------------------------------------------------------
// (b) macOS の `open_print_window` は wry の print() を使わず、猶予のあとに自前の印刷操作を始める
// ---------------------------------------------------------------------------

/// 3. (b) macOS の経路の `open_print_window` は `.print()` / `.print_with_options()` を呼ばず、そこから
///    (推移的に)呼ぶ fn も呼ばない(契約 1)。
#[test]
fn open_print_window_does_not_print_through_wry_on_macos() {
    let code = macos_code();
    let body = fn_body(&code, "open_print_window", "print.rs");
    for call in [".print(", ".print_with_options("] {
        assert!(
            !body.contains(call),
            "on macOS open_print_window must not call wry's {call}) on the print window (契約 1):\n{body}"
        );
        assert!(
            !reaches(body, call, &code),
            "on macOS nothing open_print_window calls may fall back to wry's {call}) (契約 1)"
        );
    }
}

/// 4. (b) 印刷操作は Finished 待ち(`LOAD_TIMEOUT`)と猶予(`PRINT_SETTLE`)の**あと**に始める:
///    猶予のあとの本体が(推移的に)`printOperationWithPrintInfo` に届き、猶予の前の本体は届かない
///    (契約 1・6=wry の panic を避けるモジュールの前提)。
#[test]
fn the_print_operation_starts_after_the_load_wait_and_the_settle() {
    let code = macos_code();
    let start = print_start(&code);
    assert!(
        start.before_settle.contains("LOAD_TIMEOUT"),
        "open_print_window must still wait for the document to finish loading (LOAD_TIMEOUT) before \
         the settle pause (契約 6):\n{}",
        start.before_settle
    );
    assert!(
        !reaches_by(start.before_settle, &code, builds_print_operation),
        "the print operation must not be started before the PRINT_SETTLE pause (契約 1・6):\n{}",
        start.before_settle
    );
    assert!(
        reaches_by(start.starter_body, &code, builds_print_operation),
        "{} must (transitively) build the print operation with printOperationWithPrintInfo:",
        start.starter_name
    );
}

/// 5. (b) 印刷操作は wry 0.54.4 の `print()` と同じ設定で作る: `sharedPrintInfo`・余白 4 辺が 0・
///    `setCanSpawnSeparateThread` が true・`runOperationModalForWindow`(契約 1)。辿り方は関数呼び出しの
///    名前と、`performSelector:` に渡した選択子の method(追補o の要件側の更新)。
#[test]
fn the_print_operation_is_set_up_like_wrys_print() {
    let code = macos_code();
    let start = print_start(&code);
    let chain = reachable_segments_through_performed_selectors(start.starter_body, &code);
    for needle in ["sharedPrintInfo", "runOperationModalForWindow"] {
        assert!(
            chain.iter().any(|s| contains_word(s, needle)),
            "{} must (transitively) use {needle} (契約 1: the same set-up as wry's print())",
            start.starter_name
        );
    }
    for side in ["Top", "Right", "Bottom", "Left"] {
        let selector = format!("set{side}Margin");
        let args: Vec<&str> = chain.iter().flat_map(|s| message_args(*s, &selector)).collect();
        assert!(
            !args.is_empty(),
            "{} must (transitively) set the print info's {selector}: (契約 1: all four margins are 0)",
            start.starter_name
        );
        for arg in args {
            assert!(
                is_zero(arg, &code),
                "{selector}: must be 0 like wry's PrintMargin::default(), got `{arg}` (契約 1)"
            );
        }
    }
    let spawn: Vec<&str> = chain
        .iter()
        .flat_map(|s| message_args(*s, "setCanSpawnSeparateThread"))
        .collect();
    assert!(
        !spawn.is_empty(),
        "{} must (transitively) call setCanSpawnSeparateThread: on the print operation (契約 1)",
        start.starter_name
    );
    for arg in spawn {
        assert!(
            arg == "true" || arg.contains("YES"),
            "setCanSpawnSeparateThread: must be YES like wry's print(), got `{arg}` (契約 1)"
        );
    }
}

/// 6. (b) `runOperationModalForWindow:` には終わりを受け取る delegate(null / None でない)と選択子
///    `printOperationDidRun:success:contextInfo:`(`didRunSelector:` に)を渡す(契約 1)。辿り方は関数呼び出しの
///    名前と、`performSelector:` に渡した選択子の method(追補o の要件側の更新)。
#[test]
fn the_print_operation_is_run_with_a_delegate_and_the_did_run_selector() {
    let code = macos_code();
    let start = print_start(&code);
    let chain = reachable_segments_through_performed_selectors(start.starter_body, &code);
    let calls: Vec<&str> = chain
        .iter()
        .flat_map(|s| {
            let s: &str = *s;
            word_positions(s, "runOperationModalForWindow").map(move |at| &s[at..])
        })
        .collect();
    assert!(
        !calls.is_empty(),
        "{} must (transitively) run the print operation with runOperationModalForWindow: (契約 1)",
        start.starter_name
    );
    let with_delegate = calls.iter().any(|call| {
        let call: &str = *call;
        let delegate = message_args(call, "delegate").into_iter().next();
        let selector = message_args(call, "didRunSelector").into_iter().next();
        let delegate_ok = delegate.map_or(false, |d| {
            !d.is_empty() && !d.contains("null") && d != "None" && !d.starts_with("None")
        });
        let selector_ok = selector.map_or(false, |s| {
            s != "None" && !s.contains("null") && reaches(s, DID_RUN_SELECTOR, &code)
        });
        delegate_ok && selector_ok
    });
    assert!(
        with_delegate,
        "runOperationModalForWindow: must be sent with a delegate (not null) and \
         didRunSelector: sel!({DID_RUN_SELECTOR}) — wry passes nil for both, which is why the end \
         of printing was never heard (契約 1). Calls seen:\n{}",
        calls.join("\n----\n")
    );
    assert!(
        chain.iter().any(|s| s.contains(DID_RUN_SELECTOR)),
        "the selector {DID_RUN_SELECTOR} must be spelled out (sel!) on the print window's route"
    );
}

/// 7. (b) 印刷操作はメインスレッドで作る: `printOperationWithPrintInfo` を送る fn の本体が
///    `run_on_main_thread(` の中にあるか `MainThreadMarker` を取るか、その fn を `run_on_main_thread(`
///    を使う fn が呼ぶ(追補g の PDF の経路と同じ)。
#[test]
fn the_print_operation_is_built_on_the_main_thread() {
    let code = macos_code();
    let functions = all_functions(&code);
    let builders: Vec<&(String, &str)> = functions
        .iter()
        .filter(|(_, body)| builds_print_operation(body))
        .collect();
    assert!(
        !builders.is_empty(),
        "print.rs must build the print window's print operation with printOperationWithPrintInfo: (契約 1)"
    );
    for (name, body) in builders {
        let in_place = body.contains("run_on_main_thread(") || body.contains("MainThreadMarker");
        let via_caller = functions.iter().any(|(_, caller)| {
            caller.contains("run_on_main_thread(") && caller.contains(&format!("{name}("))
        });
        assert!(
            in_place || via_caller,
            "{name} builds the print operation and must do so on the main thread (run_on_main_thread \
             or MainThreadMarker) — AppKit's print panel is main-thread only (契約 1):\n{body}"
        );
    }
}

/// 8. (b・契約 6) macOS 以外の経路の `open_print_window` は今までどおり wry の `.print()` を呼ぶ
///    (`#[cfg(not(target_os = "macos"))]` の fn かブロックの中。自動では閉じない)。
#[test]
fn other_platforms_still_print_through_wry() {
    let code = non_macos_code();
    let body = fn_body(&code, "open_print_window", "print.rs");
    assert!(
        reaches(body, ".print(", &code),
        "outside macOS open_print_window must still print the window with wry's print() (契約 6):\n{body}"
    );
}

// ---------------------------------------------------------------------------
// (c) delegate — define_class! で作り、Vellis で始まる名前、通知で印刷窓を閉じる
// ---------------------------------------------------------------------------

/// 9. (c) delegate のクラスは objc2 の `define_class!` で作り、Objective-C のクラス名(`#[name = "…"]`、
///    無ければ struct の名前)が `Vellis` で始まる(ほかのクラスと重ならない=契約 5)。
#[test]
fn the_delegate_is_a_define_class_named_after_vellis() {
    let code = macos_code();
    let block = delegate_class(&code);
    let name = objc_class_name(block);
    assert!(
        name.starts_with("Vellis"),
        "the delegate's Objective-C class name must start with `Vellis` (got {name:?}) so it cannot \
         collide with another class in the process (契約 5)"
    );
    assert!(
        name.len() > "Vellis".len(),
        "the class name must say what the delegate is, not just `Vellis` (got {name:?})"
    );
}

/// 10. (c) delegate は `printOperationDidRun:success:contextInfo:` を実装し、その本体から(推移的に)
///     印刷窓の `.close()` に届く(契約 2)。
#[test]
fn the_did_run_method_closes_the_print_window() {
    let code = macos_code();
    let block = delegate_class(&code);
    let body = method_body(block, DID_RUN_SELECTOR);
    assert!(
        reaches(body, ".close()", &code),
        "{DID_RUN_SELECTOR} must close the print window (.close(), directly or through a fn it calls) \
         — printed, saved or cancelled alike (契約 2):\n{body}"
    );
}

// ---------------------------------------------------------------------------
// (d) 始められなければ印刷窓を閉じて Err
// ---------------------------------------------------------------------------

/// `body` の中で `=>` の直後(`from`)から始まる match の腕の本体: `{ … }` ならそのブロック、式なら
/// 括弧の深さ 0 の `,` か match の閉じ `}` の手前まで。
fn match_arm_body(body: &str, from: usize) -> &str {
    let rest = &body[from..];
    let start = from + (rest.len() - rest.trim_start().len());
    let bytes = body.as_bytes();
    if start < bytes.len() && bytes[start] == b'{' {
        return &body[start..block_end(body, start)];
    }
    let mut depth = 0isize;
    let mut in_str = false;
    let mut i = start;
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
        } else if c == b',' && depth == 0 {
            break;
        }
        i += 1;
    }
    body[start..i].trim()
}

/// match の本体 `{ … }` の中の、`Err(..) =>` の腕の本体(最初のもの)。
fn err_arm_in_match(body: &str) -> Option<&str> {
    for (at, _) in body.match_indices("Err(") {
        if body[..at].chars().last().map_or(false, is_ident_char) {
            continue;
        }
        let close = block_end(body, at + "Err".len());
        let rest = &body[close..];
        let trimmed = rest.trim_start();
        if !trimmed.starts_with("=>") {
            continue;
        }
        let arrow_end = close + (rest.len() - trimmed.len()) + "=>".len();
        return Some(match_arm_body(body, arrow_end));
    }
    None
}

/// `text[call_at..]` が `<name>(` で始まる呼び出しとして、その結果を受ける `Err` の腕の本体:
/// `if let Err(..) = <call> { … }`・`let Err(..) = <call> else { … }`・`match <call> { … Err(..) => … }`。
/// 結果を変数に受けてから見る形は、呼び出しのあとで最初に現れる `let Err(` / `match` を腕とする。
/// 腕が見つからなければ `None`(`.map_err(` + `?` だけの形など)。
fn err_arm_of_call(text: &str, call_at: usize) -> Option<&str> {
    /// `text[at..]` で最初の `{` から始まるブロック。
    fn block_from(text: &str, at: usize) -> Option<&str> {
        let open = at + text[at..].find('{')?;
        Some(&text[open..block_end(text, open)])
    }
    let paren = call_at + text[call_at..].find('(')?;
    let call_end = block_end(text, paren);
    let stmt_start = text[..call_at]
        .rfind(|c: char| matches!(c, ';' | '{' | '}'))
        .map_or(0, |i| i + 1);
    let head = &text[stmt_start..call_at];
    let after = &text[call_end..];
    if head.contains("let Err(") {
        return block_from(text, call_end);
    }
    if contains_word(head, "match") {
        return err_arm_in_match(block_from(text, call_end)?);
    }
    let next_let = after.find("let Err(").map(|i| call_end + i);
    let next_match = word_positions(after, "match").next().map(|i| call_end + i);
    match (next_let, next_match) {
        (Some(l), m) if m.map_or(true, |m| l < m) => block_from(text, l),
        (_, Some(m)) => err_arm_in_match(block_from(text, m)?),
        // `(Some(_), None)` は上のガードが常に真で第 1 腕に入る(網羅性の検査はガードを見ない)
        _ => None,
    }
}

/// ブロック `{ … }` の末尾の式(深さ 0 の最後の `;` か、深さ 0 に戻る `}` のあと。無ければ空)。
fn tail_expression(block: &str) -> &str {
    let inner = &block[1..block.len() - 1];
    let bytes = inner.as_bytes();
    let mut depth = 0usize;
    let mut start = 0;
    let mut in_str = false;
    let mut i = 0;
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
        } else if matches!(c, b'{' | b'(' | b'[') {
            depth += 1;
        } else if matches!(c, b'}' | b')' | b']') {
            depth = depth.saturating_sub(1);
            if depth == 0 && c == b'}' {
                start = i + 1;
            }
        } else if c == b';' && depth == 0 {
            start = i + 1;
        }
        i += 1;
    }
    inner[start..].trim()
}

/// 腕の本体が `Err` を返すか: `return Err(` を含む、または末尾の式が `Err(` で始まる(match の
/// 式の腕 `Err(e) => Err(e)` も含む)。`if let Err(x) = window.close()` のような**パターン**の `Err(` は
/// 数えない。
fn arm_returns_err(arm: &str) -> bool {
    if arm.contains("return Err(") {
        return true;
    }
    let tail = if arm.starts_with('{') { tail_expression(arm) } else { arm.trim() };
    tail.starts_with("Err(")
}

/// `text` の中で `printOperationWithPrintInfo:` を**送っている**位置(`sel!(printOperationWithPrintInfo:)`
/// のように引数の無い選択子の綴りは除く)。
fn print_operation_sends(text: &str) -> Vec<usize> {
    word_positions(text, "printOperationWithPrintInfo")
        .filter(|&at| {
            let after = &text[at + "printOperationWithPrintInfo".len()..];
            after.starts_with(':')
                && !matches!(after[1..].trim_start().chars().next(), Some(')') | Some(']') | None)
        })
        .collect()
}

/// `rest`(印刷操作を受け取る文以降)が nil の戻りを `Err` にしているか:
/// `let Some(..) = .. else { … Err( … }`・`match` の `None => … Err( …`・`.ok_or(` / `.ok_or_else(`・
/// `.is_none()` / `.is_null()` に続く `{ … Err( … }` のどれか。
fn nil_becomes_err(rest: &str) -> bool {
    let let_else = rest.match_indices("let Some(").any(|(i, _)| {
        let after = &rest[i..];
        let Some(else_at) = word_positions(after, "else").next() else {
            return false;
        };
        let Some(open) = after[else_at..].find('{').map(|o| else_at + o) else {
            return false;
        };
        after[open..block_end(after, open)].contains("Err(")
    });
    let none_arm = word_positions(rest, "None").any(|at| {
        let after = &rest[at + "None".len()..];
        let trimmed = after.trim_start();
        trimmed.starts_with("=>") && {
            let arrow_end = at + "None".len() + (after.len() - trimmed.len()) + "=>".len();
            match_arm_body(rest, arrow_end).contains("Err(")
        }
    });
    let ok_or = rest.contains(".ok_or(") || rest.contains(".ok_or_else(");
    let is_none = [".is_none()", ".is_null()"].iter().any(|needle| {
        rest.match_indices(needle).any(|(i, _)| {
            let after = &rest[i..];
            after
                .find('{')
                .map_or(false, |open| after[open..block_end(after, open)].contains("Err("))
        })
    });
    let_else || none_arm || ok_or || is_none
}

/// 11. (d) 印刷操作を始める fn は `Result` を返し、WKWebView が応えるか(`respondsToSelector`)を見る。
///     `open_print_window` はその fn の結果を受ける `Err` の腕の**ブロックの中で**印刷窓を `.close()` して
///     `return Err(` する(契約 4)。腕のブロックは波括弧の対応で切り出し、推移的には辿らない(始める fn の
///     本体にある別の `.close()` や、`if let Err(e)` のパターンの `Err(` に当たらないため)。
#[test]
fn a_print_operation_that_cannot_start_closes_the_window_and_errs() {
    let code = macos_code();
    let start = print_start(&code);
    if start.starter_name != "open_print_window" {
        let signature = fn_signature(&code, &start.starter_name);
        assert!(
            signature.contains("Result<"),
            "{} starts the print operation and must return Result so a failure reaches the caller \
             (契約 4):\n{signature}",
            start.starter_name
        );
    }
    let chain = reachable_segments(start.starter_body, &code);
    assert!(
        chain.iter().any(|s| s.contains("respondsToSelector")),
        "the route must ask the WKWebView whether it responds to printOperationWithPrintInfo: \
         (respondsToSelector), as wry does, and fail when it does not (契約 4)"
    );
    let arm = if start.starter_name == "open_print_window" {
        // 本体に直接書いた形: 印刷操作を受け取る文以降の全部を「始められない経路」として見る。
        &start.after_settle[start.call_at..]
    } else {
        err_arm_of_call(start.after_settle, start.call_at).unwrap_or_else(|| {
            panic!(
                "open_print_window must take the Err of {}(…) in an `if let Err(..) = … {{ … }}`, \
                 `let Err(..) = … else {{ … }}` or `match … {{ Err(..) => … }}` arm that closes the \
                 print window and returns Err (契約 4):\n{}",
                start.starter_name, start.after_settle
            )
        })
    };
    assert!(
        arm.contains(".close()"),
        "when {}(…) fails, the Err arm of open_print_window must itself close the print window \
         (.close() inside the arm — no delegate will ever close it) (契約 4). Arm seen:\n{arm}",
        start.starter_name
    );
    assert!(
        arm_returns_err(arm),
        "when {}(…) fails, the Err arm of open_print_window must return Err (`return Err(` or an \
         `Err(` tail expression) so the frontend shows 'Could not print: …' — logging and falling \
         through to Ok is not enough (契約 4). Arm seen:\n{arm}",
        start.starter_name
    );
}

/// 14. (d) 印刷操作を作る fn は `printOperationWithPrintInfo:` の戻りが nil のとき `Err` を返す: 送る文
///     **以降**に nil を `Err` にする形(`let Some(..) = .. else { Err }` / `None => Err` / `.ok_or(`)が
///     あり、`.unwrap()` / `.expect(` で済ませていない(契約 4。wry はここを unwrap する)。送る文より前の
///     `ns_window` / `web_view` の `ok_or_else` には当たらないよう範囲を絞る。
#[test]
fn a_nil_print_operation_is_an_err_not_an_unwrap() {
    let code = macos_code();
    let functions = all_functions(&code);
    let builders: Vec<(&String, &str, usize)> = functions
        .iter()
        .filter_map(|(name, body)| {
            print_operation_sends(body)
                .into_iter()
                .last()
                .map(|send_at| (name, *body, send_at))
        })
        .collect();
    assert!(
        !builders.is_empty(),
        "print.rs must send printOperationWithPrintInfo: to the print window's WKWebView (契約 1)"
    );
    for (name, body, send_at) in builders {
        let rest = &body[send_at..];
        for shortcut in [".unwrap()", ".expect("] {
            assert!(
                !rest.contains(shortcut),
                "{name} must not {shortcut}) after sending printOperationWithPrintInfo: — a nil \
                 operation must become an Err, not a panic (契約 4):\n{rest}"
            );
        }
        assert!(
            nil_becomes_err(rest),
            "{name} must turn a nil printOperationWithPrintInfo: result into an Err after sending it \
             (`let Some(op) = op else {{ return Err(…) }}`, `None => Err(…)` or `.ok_or(…)`) (契約 4):\n{rest}"
        );
    }
}

// ---------------------------------------------------------------------------
// (e) 依存は足さない — Cargo.toml のクレート名の集合と objc2-app-kit の features が起案時点
// (2026-10-21)と同一(acceptance_req38m.rs / acceptance_req62a.rs と同じ流儀)
// ---------------------------------------------------------------------------

/// Cargo.toml の `section` の表にある依存クレート名(表の直下の `name = …` の `name`。コメント行と、
/// 複数行に割った `{ … }` / `[ … ]` の内側の行は除く)。
fn dependency_names(section: &str) -> BTreeSet<String> {
    let toml = include_str!("../Cargo.toml");
    let mut current = String::new();
    let mut names = BTreeSet::new();
    let mut depth = 0isize;
    for line in toml.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        let at_top = depth == 0;
        // 文字列の外の括弧だけ数える(値が次の行へ続いているかを知るため)。
        let mut in_str: Option<char> = None;
        for c in line.chars() {
            match in_str {
                Some(q) if c == q => in_str = None,
                Some(_) => {}
                None => match c {
                    '"' | '\'' => in_str = Some(c),
                    '{' | '[' => depth += 1,
                    '}' | ']' => depth -= 1,
                    '#' => break,
                    _ => {}
                },
            }
        }
        if !at_top {
            continue;
        }
        if line.starts_with('[') {
            current = line.to_string();
            depth = 0;
            continue;
        }
        if current == section {
            if let Some((name, _)) = line.split_once('=') {
                names.insert(name.trim().to_string());
            }
        }
    }
    names
}

/// 12. (e) 依存の表(`[dependencies]`・macOS の表・`[dev-dependencies]`・`[build-dependencies]`)の
///     クレート名の集合が本追補の起案時点と同一(契約 5: `objc2-web-kit` も何も足さない。WKWebView と
///     NSPrintOperation は型なしの `msg_send!` で呼ぶ)。
#[test]
fn no_new_dependency_is_declared() {
    let expected: [(&str, &[&str]); 4] = [
        (
            "[dependencies]",
            &[
                "tauri",
                "tauri-plugin-opener",
                "serde",
                "serde_json",
                "clap",
                "thiserror",
                "tokio",
                "async-trait",
                "notify",
                "libc",
                "tracing",
                "tracing-subscriber",
                "mime_guess",
                "http",
                "percent-encoding",
                "tauri-plugin-dialog",
                "reqwest",
                "russh",
                "russh-sftp",
                "bytes",
                "dirs",
                "ulid",
                "chrono",
                "strsim",
                "sha2",
                "similar",
                "hidapi",
                "toml",
                "regex",
                "tauri-plugin-webdriver",
                "tauri-plugin-window-state",
            ],
        ),
        (
            "[target.'cfg(target_os = \"macos\")'.dependencies]",
            &["objc2", "objc2-app-kit", "objc2-foundation"],
        ),
        ("[dev-dependencies]", &["tempfile", "tauri", "muda"]),
        ("[build-dependencies]", &["tauri-build", "chrono"]),
    ];
    for (section, names) in expected {
        let want: BTreeSet<String> = names.iter().map(|s| s.to_string()).collect();
        let got = dependency_names(section);
        assert_eq!(
            got, want,
            "{section} must list exactly the crates it listed on 2026-10-21 (契約 5: no new dependency)"
        );
    }
}

/// 二重引用符の文字列リテラルの中身(acceptance_req62a.rs の string_literals と同じ)。
fn string_literals(code: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = code;
    while let Some(open) = rest.find('"') {
        let Some(close) = rest[open + 1..].find('"') else {
            break;
        };
        out.push(rest[open + 1..open + 1 + close].to_string());
        rest = &rest[open + 1 + close + 1..];
    }
    out
}

/// Cargo.toml の `objc2-app-kit` の `features = [...]` の中身(コメント行を除く)。
fn objc2_app_kit_features() -> BTreeSet<String> {
    let code = include_str!("../Cargo.toml")
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n");
    let entry = code
        .find("objc2-app-kit")
        .expect("Cargo.toml must declare objc2-app-kit");
    let mut search = entry;
    let features = loop {
        let rel = code[search..]
            .find("features")
            .expect("objc2-app-kit must list features");
        let at = search + rel;
        // `default-features = false` は飛ばす
        if code[..at].ends_with('-') {
            search = at + "features".len();
            continue;
        }
        break at;
    };
    let open = code[features..].find('[').expect("features must be an array") + features;
    let close = code[open..].find(']').expect("features array must close") + open;
    string_literals(&code[open..=close]).into_iter().collect()
}

/// 13. (e) `objc2-app-kit` の features の集合が本追補の起案時点と同一(契約 5: `NSPrintInfo` /
///     `NSPrintOperation` の feature を足さず、型なしの `msg_send!` で呼ぶ=要件#62 追補a の固定と同じ)。
#[test]
fn objc2_app_kit_features_are_unchanged() {
    let expected: BTreeSet<String> = [
        "std",
        "NSGraphics",
        "NSResponder",
        "NSWindow",
        "NSWindowTab",
        "NSWindowTabGroup",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    assert_eq!(
        objc2_app_kit_features(),
        expected,
        "objc2-app-kit features must stay exactly as they were on 2026-10-21 (契約 5)"
    );
}
