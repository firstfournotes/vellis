//! 要件#5 追補b の受け入れテスト(docs/requirements/req-05.md「追補b」・backlog 325)— Rust 層
//!
//! 325: ssh の監視(`poll_loop`)は 2 秒待ってから最初の stat を取り、それを基準にするだけなので、
//! 監視を始めてから最初の stat までの約 2 秒に起きた変更は届かない(次の変更からは届く)。
//! 直し方(2026-10-11 オーケストレーター判断)= **監視を始めたらすぐ(2 秒待たずに)最初の stat を
//! 取る**(監視の側だけで直り、フォルダの監視にも同じく効く)。
//!
//! 契約(追補b):
//! 1. `poll_loop` は、始まったら**待たずに**最初の stat を取り(それが基準)、以後は `POLL_INTERVAL`
//!    (2 秒)ごとに取る。停止の合図は今までどおり待機の `select!` で見る
//! 2. 不変: `poll_step` の判定・2 秒・毎周 入れ物から取り出す(`.run(`)・`watch` は接続を取り出さずに
//!    Ok を返す・Remove の扱い・つながらないホストでも監視は始まり、つながった周回から見る
//!
//! 受け入れ基準 AC-5-追b:
//!   (a) ソース走査(`provider-ssh` の feature の下): `ssh.rs` の `POLL_INTERVAL` を待つ唯一の
//!       `loop { … }` の中で、接続の取り出し(`.run(`)と `poll_step(` が `POLL_INTERVAL` の待機より
//!       **前**にある(周回の最後で待つ形)。その `loop` より前の `poll_loop` の本文で `POLL_INTERVAL`
//!       を待たない
//!       → `ac5b_a_poll_loop_stats_before_it_waits_and_does_not_wait_before_its_loop`
//!       **追補c(2026-10-19)での要件側更新**: 追補c 契約1 で周回の待ち時間は `next_poll_delay` の
//!       値になり、`POLL_INTERVAL` を直に待たなくなる(初期値として `loop` の前に現れうる)。
//!       そのため「`POLL_INTERVAL` の字面」(追補b reviewer P3 の記録どおり)ではなく、
//!       `poll_loop` の唯一の `loop` と、その中の待機(`select!`)の位置で同じことを判定する。
//!       判定の中身(取り出し・判定が待機より前・`loop` の前で待たない・`select!` + `stop_rx`)は不変
//!   (b) E2E(`tests/e2e/specs/ssh-watch-first-stat.e2e.ts`・周回では回さず `scripts/e2e.sh --ssh
//!       --spec tests/e2e/specs/ssh-watch-first-stat.e2e.ts` で回す): ssh の root のテキストファイルを
//!       開き、本文が出たら待たずに書き換えると、`file_changed` が 4 秒以内に届いて本文に出る
//!
//! 修正前の見込み: (a) は赤(今の `poll_loop` は周回の先頭の `select!` で `POLL_INTERVAL` を待ってから
//! `.run(` → `poll_step(` なので、両方が待機より後にある)。
//!
//! ## 本テストの組み立て
//!
//! - `acceptance_req5a.rs` の f7 と同じ流儀: 行コメントを落とした `ssh.rs` から `poll_loop` の本文を
//!   切り出し、その中の `loop {` の塊を括弧の釣り合いで切り出す(`poll_loop` に `loop` はちょうど 1 つ)
//! - 「待機より前」= その `loop` の中で `.run(` と `poll_step(` の最初の位置が待機(`select!`)の最初の
//!   位置より前。「`loop` より前で待たない」= `poll_loop` の本文の、その `loop` までの部分に
//!   `select!` も `sleep(` も無い(追補c 以前は `POLL_INTERVAL` の字面で見ていた)

#![cfg(feature = "provider-ssh")]

const SSH_RS: &str = include_str!("../src/fs/ssh.rs");

/// 行ごとに `//` 以降(コメント)を落とす。`://` は落とさない(acceptance_req5a.rs と同じ)。
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

/// `from` 以降で最初に現れる `open` から、対応する `close` までを切り出す(acceptance_req5a.rs と同じ)。
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

/// `fn <name>` の (引数リスト, 本体)(acceptance_req5a.rs と同じ)。
fn function_parts<'a>(code: &'a str, name: &str) -> (&'a str, &'a str) {
    let needle = format!("fn {name}");
    let start = code
        .match_indices(&needle)
        .map(|(i, _)| i)
        .find(|i| {
            let rest = &code[i + needle.len()..];
            rest.starts_with('(') || rest.starts_with('<')
        })
        .unwrap_or_else(|| panic!("ssh.rs must define {name}"));
    let params = balanced(code, start + needle.len(), '(', ')');
    let params_end = params.as_ptr() as usize - code.as_ptr() as usize + params.len();
    let body = balanced(code, params_end, '{', '}');
    (params, body)
}

fn offset_in(code: &str, part: &str) -> usize {
    part.as_ptr() as usize - code.as_ptr() as usize
}

/// (a) `poll_loop` の唯一の `loop` の中で `.run(` と `poll_step(` が待機(`select!`)より前にあり、
/// その `loop` より前の `poll_loop` の本文で待たない(`select!` / `sleep(` が無い)。
/// (追補c での要件側更新: 待機の目印を `POLL_INTERVAL` の字面から `select!` の位置に替えた)
#[test]
fn ac5b_a_poll_loop_stats_before_it_waits_and_does_not_wait_before_its_loop() {
    let code = strip_line_comments(SSH_RS);
    let (_, poll_loop_body) = function_parts(&code, "poll_loop");
    let poll_loop_start = offset_in(&code, poll_loop_body);

    let poll_loops: Vec<(usize, &str)> = poll_loop_body
        .match_indices("loop {")
        .map(|(i, _)| (poll_loop_start + i, balanced(&code, poll_loop_start + i, '{', '}')))
        .collect();
    assert_eq!(
        poll_loops.len(),
        1,
        "exactly one `loop {{ … }}` inside `poll_loop` (the polling round); found {}",
        poll_loops.len()
    );
    let (loop_at, body) = poll_loops[0];

    // 周回の最後で待つ形: 取り出し(.run()と判定(poll_step()が待機(select!)より前。
    let wait = body
        .find("select!")
        .expect("the polling loop waits inside `select!` (contract 1)");
    let run = body
        .find(".run(")
        .expect("the polling loop must take the connection out of the pool with `.run(` (contract 2)");
    let step = body
        .find("poll_step(")
        .expect("the polling loop must decide events with `poll_step(` (contract 2)");
    assert!(
        run < wait,
        "`.run(` (the stat of this round) must come BEFORE the wait inside the loop \
         (contract 1: the first stat is taken without waiting; the wait closes the round); loop:\n{body}"
    );
    assert!(
        step < wait,
        "`poll_step(` must come BEFORE the wait inside the loop (contract 1); loop:\n{body}"
    );

    // その loop より前の poll_loop の本文では待たない(select! も sleep( も無い)。
    let before_loop = &poll_loop_body[..loop_at - poll_loop_start];
    assert!(
        !before_loop.contains("select!") && !before_loop.contains("sleep("),
        "poll_loop must not wait before its loop (contract 1: no wait before the \
         first stat); the body before the loop is:\n{before_loop}"
    );

    // 停止の合図は今までどおり待機の select! で見る(契約1)。
    assert!(
        body.contains("select!"),
        "the wait inside the loop still goes through `select!` (contract 1); loop:\n{body}"
    );
    assert!(
        body.contains("stop_rx"),
        "the stop signal (`stop_rx`) is still seen in the loop's wait (contract 1); loop:\n{body}"
    );
}
