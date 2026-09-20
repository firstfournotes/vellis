//! 要件#60 の受け入れテスト(docs/requirements/req-60.md)— Rust 層(AC-60-19)
//!
//! 「Go to Path…」の入口= **Go メニュー(新設・⇧⌘G)**(追補c=2026-09-20 由谷
//! 「新たに "Go" メニューを追加して、そこに入れてください」。初版の File メニューから
//! 移す)。メニューバーの並びは App / File / Edit / View / Go / Window(Finder と
//! 同じ位置=View と Window の間)。Rust 側の変更は menu.rs の Go メニュー(項目1つ)
//! と定数3つ、lib.rs のクリック→ emit 分岐1つだけ(契約⑨)。
//! acceptance_req54(Find…)と同じ形で、メニュー定数の値固定・アクセラレータの
//! parse 妥当性・既存アクセラレータとの重複なし・menu.rs のソース走査を行う。
//! 追補c で足したソース走査= Go メニューの新設・File メニューからの除去・
//! メニューバーの並び(`Menu::with_items` のスライス順)。
//!
//! ## 確定契約(implementer はこれに従う=オーケストレーター指定 2026-09-20)
//!
//! ```ignore
//! // src-tauri/src/menu.rs — FIND_* と同じ家風で export
//! pub const GO_TO_ITEM_ID: &str = "go-to-path";
//!
//! /// Go メニュー(追補c で新設)の「Go to Path…」クリックでフォーカス中ウィンドウへ
//! /// emit するイベント名(menu_find と同型・ペイロードなし)。フロント側
//! /// src/lib/go-to-path.ts(または受信側の配線)の MENU_GO_TO_EVENT と同じ
//! /// リテラルであることが両側のテストで固定される(要件#34/#54 の家風)。
//! pub const MENU_GO_TO_EVENT: &str = "menu_go_to";
//!
//! /// MenuItem::with_id の accelerator にこの定数を渡す(インラインリテラルに
//! /// しない — 値の固定と parse 妥当性の判定がこの定数を参照するため)。
//! pub const GO_TO_ACCELERATOR: &str = "CmdOrCtrl+Shift+G";
//! ```
//!
//! ## AC-60-13 の Rust 側(「list が `.` 始まりを返さない」の固定)
//! 既存の acceptance_req31.rs::list_still_skips_hidden_entries_including_symlinks
//! (要件#31)が LocalProvider::list のドット始まりスキップを固定済みなので、
//! 本ファイルでは重複して書かない(参照のみ)。フロント側の帰結
//! (`.github/…` は「無い」)は go-to-path.acceptance.test.ts AC-60-13。
//!
//! ## reviewer 照合に委ねる項目(AppHandle 依存で機械判定不能な配線)
//! - ラベル・ID・アクセラレータ定数が同じ MenuItem::with_id に束ねられること
//!   (Go メニューの中に居ること自体はソース走査=下のテストで固定)
//! - クリックで handle_menu_open_click と同型にフォーカス中ウィンドウへ
//!   emit すること
//! - Rust 側の変更が menu.rs の Go メニュー(項目1つ)と定数、lib.rs の分岐
//!   1つのみ(契約⑨)
//!
//! ## 人間ゲート(acceptance/acceptance.md 要件#60)
//! - 実機での ⇧⌘G の発火・メニュー表示・バーの見た目と体感・跳躍のスクロール

use std::str::FromStr;

use muda::accelerator::Accelerator;
use vellis_lib::menu::{GO_TO_ACCELERATOR, GO_TO_ITEM_ID, MENU_GO_TO_EVENT};

// ---------------------------------------------------------------------------
// メニュー定数 — 項目 ID・イベント名・アクセラレータの値固定(AC-60-19)
// ---------------------------------------------------------------------------

/// 1. 項目 ID は kebab-case で固定(find / open-file と同じ家風)。
#[test]
fn go_to_menu_item_id_is_fixed() {
    assert_eq!(GO_TO_ITEM_ID, "go-to-path");
}

/// 2. Webview への通知イベント名は menu_find と同じ snake_case の menu_* 固定。
///    フロント側の受信(+page.svelte の配線=reviewer 照合)と同じリテラル。
#[test]
fn go_to_menu_event_name_is_fixed() {
    assert_eq!(MENU_GO_TO_EVENT, "menu_go_to");
}

/// 3. アクセラレータは ⇧⌘G(Finder の「フォルダへ移動」と同じ)。値固定。
#[test]
fn go_to_accelerator_string_is_fixed() {
    assert_eq!(GO_TO_ACCELERATOR, "CmdOrCtrl+Shift+G");
}

/// 4. parse 妥当性(acceptance_req36/54 の家風): tauri 2 はメニュー項目の
///    accelerator を `s.parse::<muda::accelerator::Accelerator>().ok()` で解析して
///    失敗を黙って捨てるため、この Ok こそが「⇧⌘G が実際に登録される」ことの
///    機械判定点になる。
#[test]
fn go_to_accelerator_parses_as_tauri_accelerator() {
    assert!(
        Accelerator::from_str(GO_TO_ACCELERATOR).is_ok(),
        "accelerator '{}' must parse — tauri silently drops unparsable ones",
        GO_TO_ACCELERATOR
    );
}

// ---------------------------------------------------------------------------
// menu.rs のソース走査 — ラベル・定数の使用・重複なし(acceptance_req35/36/54 の家風)
// ---------------------------------------------------------------------------

/// 行ごとに最初の `//` 以降(コメント)を落としたコード部分を連結して返す
/// (acceptance_req35 / req36 / req54 の走査と同じ流儀)。
fn menu_rs_code() -> String {
    include_str!("../src/menu.rs")
        .lines()
        .map(|line| line.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

/// 5. 「Go to Path…」の英語ラベル(Open… / Find… と同じ三点リーダ付き)が
///    menu.rs のコード行に文字列リテラルとして存在する。Go メニューへの束ねは
///    下の go_menu_holds_the_go_to_item が固定する(追補c)。
#[test]
fn menu_rs_declares_english_go_to_label() {
    assert!(
        menu_rs_code().contains("\"Go to Path…\""),
        "menu.rs must carry the literal \"Go to Path…\" for the Go menu (契約①・追補c)"
    );
}

/// 6. 項目 ID とアクセラレータの定数がインラインリテラルではなく実際に使われて
///    いる(宣言+ MenuItem::with_id への使用で2回以上現れる)。値の固定と parse
///    妥当性の判定が menu.rs の登録と同じ文字列を見ていることの担保。
#[test]
fn menu_rs_uses_go_to_constants() {
    let code = menu_rs_code();
    for name in ["GO_TO_ITEM_ID", "GO_TO_ACCELERATOR"] {
        let count = code.matches(name).count();
        assert!(
            count >= 2,
            "menu.rs must declare AND use {} (found {} occurrence(s))",
            name,
            count
        );
    }
}

/// 7. クリック→ emit の配線が MENU_GO_TO_EVENT 定数を参照している(宣言が
///    menu.rs・dispatch が lib.rs の match = MENU_FIND_EVENT と同型)。宣言
///    (1回)以外に少なくとも1回の使用があること。
#[test]
fn go_to_event_constant_is_dispatched() {
    let combined = format!(
        "{}\n{}",
        menu_rs_code(),
        include_str!("../src/lib.rs")
            .lines()
            .map(|line| line.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let count = combined.matches("MENU_GO_TO_EVENT").count();
    assert!(
        count >= 2,
        "MENU_GO_TO_EVENT must be declared and dispatched (found {} occurrence(s) across menu.rs + lib.rs)",
        count
    );
}

/// menu.rs のコード部分から二重引用符の文字列リテラルを取り出す(重複判定用の
/// 素朴な走査。エスケープは中身ごと保持するだけで復号しない — アクセラレータの
/// リテラルにエスケープは現れない)。
fn menu_rs_string_literals() -> Vec<String> {
    let code = menu_rs_code();
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_str = false;
    let mut chars = code.chars();
    while let Some(c) = chars.next() {
        if in_str {
            match c {
                '\\' => {
                    cur.push(c);
                    if let Some(next) = chars.next() {
                        cur.push(next);
                    }
                }
                '"' => {
                    out.push(std::mem::take(&mut cur));
                    in_str = false;
                }
                _ => cur.push(c),
            }
        } else if c == '"' {
            in_str = true;
        }
    }
    out
}

/// 8. 既存のアクセラレータと重複しない(AC-60-19)。menu.rs のコード中の
///    「`+` を含む文字列リテラル」のうち Accelerator として parse できるもの
///    (= ショートカット登録に使われる形)をすべて集め、
///    (a) ⇧⌘G がその中に1つだけあること、(b) parse 結果に重複が無いことを固定する。
///    現行の一覧(2026-09-20 登録時)= ⌘N / ⇧⌘N / ⌘O / ⇧⌘O / ⌘S / ⌘P / ⌘E /
///    ⌘F / ⌘= / ⌘- / ⌘0 / ⌘⌥I に ⇧⌘G が加わる。
#[test]
fn go_to_accelerator_does_not_collide_with_existing_ones() {
    let parsed: Vec<(String, Accelerator)> = menu_rs_string_literals()
        .into_iter()
        .filter(|s| s.contains('+'))
        .filter_map(|s| Accelerator::from_str(&s).ok().map(|a| (s, a)))
        .collect();

    let go_to = Accelerator::from_str(GO_TO_ACCELERATOR).expect("⇧⌘G must parse");
    let go_to_count = parsed.iter().filter(|(_, a)| *a == go_to).count();
    assert_eq!(
        go_to_count, 1,
        "menu.rs must register CmdOrCtrl+Shift+G exactly once (found {})",
        go_to_count
    );

    for (i, (raw_a, acc_a)) in parsed.iter().enumerate() {
        for (raw_b, acc_b) in parsed.iter().skip(i + 1) {
            assert!(
                acc_a != acc_b,
                "duplicate accelerator in menu.rs: '{}' collides with '{}'",
                raw_a,
                raw_b
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Go メニュー(追補c)— 新設・File からの除去・メニューバーの並びのソース走査
// ---------------------------------------------------------------------------

/// `start`(`Xxx::with_…` の先頭)から、最初の `(` に対応する閉じ括弧までの
/// 呼び出し全体を返す。`(`/`[` と `)`/`]` を同じ深さで数える素朴な走査
/// (menu.rs の Submenu / Menu 呼び出しの文字列リテラルに括弧は現れない)。
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

/// 呼び出しテキスト中の最初の二重引用符リテラルの中身。
fn first_string_literal(s: &str) -> Option<&str> {
    let a = s.find('"')? + 1;
    let b = s[a..].find('"')? + a;
    Some(&s[a..b])
}

/// ラベル(呼び出し内の最初の文字列リテラル)が `label` の
/// Submenu::with_items / with_id_and_items 呼び出し全体を返す。
/// with_id_and_items の ID は定数識別子なので最初のリテラル=ラベルで足りる。
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

/// GO_TO_ITEM_ID で束ねられた MenuItem の束縛名(`let go_to_item = …` の
/// go_to_item)。最後の使用箇所(= MenuItem::with_id への引数。宣言は先頭の
/// pub const 節)から直前の `let ` を遡る。
fn go_to_item_binding(code: &str) -> &str {
    let use_pos = code
        .rfind("GO_TO_ITEM_ID")
        .expect("menu.rs must use GO_TO_ITEM_ID");
    let let_pos = code[..use_pos]
        .rfind("let ")
        .expect("GO_TO_ITEM_ID must be used inside a let binding");
    code[let_pos + 4..use_pos]
        .split(|c: char| c == '=' || c.is_whitespace())
        .find(|s| !s.is_empty())
        .expect("binding name after `let`")
}

/// 9. (追補c)Go メニュー(ラベル `Go`)が新設され、「Go to Path…」の項目
///    (GO_TO_ITEM_ID の MenuItem)がその項目列に入っている(契約①)。
#[test]
fn go_menu_holds_the_go_to_item() {
    let code = menu_rs_code();
    let go_menu = submenu_call_with_label(&code, "Go")
        .expect("menu.rs must build a submenu labelled \"Go\" (契約①・追補c)");
    let item = go_to_item_binding(&code);
    assert!(
        go_menu.contains(&format!("&{item}")),
        "the Go submenu must hold the Go to Path… item `&{item}` (契約①・追補c)"
    );
}

/// 10. (追補c)File メニューの項目列に Go to Path… が現れない
///     (同じ項目を2箇所に出さない=振る舞い「入口と入力バー」)。
#[test]
fn file_menu_does_not_hold_the_go_to_item() {
    let code = menu_rs_code();
    let file_menu = submenu_call_with_label(&code, "File")
        .expect("menu.rs must build a submenu labelled \"File\"");
    let item = go_to_item_binding(&code);
    assert!(
        !file_menu.contains(&format!("&{item}")),
        "the File menu must no longer hold `&{item}` (追補c: moved to the Go menu)"
    );
    assert!(
        !file_menu.contains("GO_TO_ITEM_ID"),
        "the File menu must not reference GO_TO_ITEM_ID (追補c)"
    );
}

/// 11. (追補c)メニューバーの並びが App(Vellis) / File / Edit / View / Go /
///     Window(`Menu::with_items` のスライス順を各 Submenu のラベルへ写して
///     固定。Finder と同じく Go は View と Window の間)。
#[test]
fn menu_bar_orders_app_file_edit_view_go_window() {
    let code = menu_rs_code();
    // メニューバー本体の Menu::with_items(Submenu::with_items は小文字の
    // "menu::" なので match しない)。
    let bar_start = code
        .match_indices("Menu::with_items")
        .map(|(i, _)| i)
        .find(|&i| !code[..i].ends_with("Sub"))
        .expect("menu.rs must build the bar with Menu::with_items");
    let bar = balanced_call(&code, bar_start);
    let slice_open = bar.find("&[").expect("Menu::with_items must take a slice");
    let slice_end = bar[slice_open..].find(']').expect("slice must close") + slice_open;
    let idents: Vec<&str> = bar[slice_open + 2..slice_end]
        .split(',')
        .map(|s| s.trim().trim_start_matches('&'))
        .filter(|s| !s.is_empty())
        .collect();

    // 各識別子 → その Submenu のラベル(`let <ident> = Submenu::with_…("Label"…)`)。
    let labels: Vec<String> = idents
        .iter()
        .map(|ident| {
            let let_pos = code
                .find(&format!("let {ident} ="))
                .unwrap_or_else(|| panic!("menu.rs must bind `{ident}` with a let"));
            let call = balanced_call(&code, let_pos);
            first_string_literal(call)
                .unwrap_or_else(|| panic!("submenu `{ident}` must carry a label literal"))
                .to_string()
        })
        .collect();

    assert_eq!(
        labels,
        ["Vellis", "File", "Edit", "View", "Go", "Window"],
        "menu bar must order App(Vellis) / File / Edit / View / Go / Window (契約①・追補c)"
    );
}
