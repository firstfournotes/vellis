//! 要件#25 追補b の受け入れテスト(docs/requirements/req-25.md「追補b webdriver 付きの
//! ビルドでは SpaceMouse の入力源を起動しない」・AC-25-9・backlog 190)
//!
//! 追補b(1)(2):
//! (1) `webdriver` feature のビルドでは `spacemouse::start` を呼ばず(3DxWare への登録も
//!     raw HID の読み取りもしない)、無効の入力源(`SpaceMouseHandle::Disabled`)を
//!     managed state に置く
//! (2) 不変: 通常のビルド(dev・release)は今のまま `spacemouse::start` を呼ぶ
//!
//! 判定は `src-tauri/src/lib.rs` の起動処理(`.setup(` クロージャ)のソース走査で行う。
//! `cfg` の書き方は実装に任せる — 文の直前の `#[cfg(...)]`、ブロックの直前の
//! `#[cfg(...)] { ... }`、`if cfg!(...) { ... } else { ... }`(`!cfg!` も可)、およびその
//! 入れ子を読み取り、`feature = "webdriver"` を真/偽と置いた三値論理(他の述語=不明)で
//! 「その文がコンパイルされるか」を評価する。評価が「不明」になる書き方(例:
//! `not(all(feature = "webdriver", debug_assertions))`・`match` の腕の属性)は
//! 「webdriver で呼ばれないとは言えない」として不合格にする(緩すぎない側に寄せる)。
//!
//! ケース:
//! ① `normal_build_still_calls_spacemouse_start` — 起動処理に `spacemouse::start(` が
//!    あり、通常ビルド(webdriver 無し)でコンパイルされ、その結果が managed state に置かれる
//!    (追補b(2)。既存の経路の保全なので実装前から緑=不変の守り)
//! ② `webdriver_build_does_not_compile_spacemouse_start` — `lib.rs` の `spacemouse::start(`
//!    のすべての呼び出しが、webdriver ありでは「コンパイルされない」と評価される(追補b(1))
//! ③ `webdriver_build_manages_disabled_spacemouse_handle` — 起動処理に
//!    `SpaceMouseHandle::Disabled` を置く文があり、webdriver ありでコンパイルされ、
//!    通常ビルドではコンパイルされず、その値が managed state に置かれる(追補b(1)(2))
//!
//! 本ファイルの外(テスト不能・test-runner / reviewer の仕事): `cargo check --features webdriver`
//! が通ること(AC-25-9)。`webdriver` feature が release に入らない守りは既存
//! (`#[cfg(all(feature = "webdriver", debug_assertions))]`)のまま。
//!
//! 既存の acceptance_req25.rs / acceptance_req25a.rs は変更しない。
//!
//! 赤の設計: 実装前の lib.rs は `app.manage(spacemouse::start(app.handle().clone()));` を
//! 無条件に置いているので、②は「webdriver ありでもコンパイルされる」、③は
//! 「`SpaceMouseHandle::Disabled` を置く文が無い」で、未実装が理由で失敗する。

use vellis_lib::spacemouse::SpaceMouseHandle;

/// 無効の入力源の名前を型で固定する(`SpaceMouseHandle::Disabled` が無くなれば
/// コンパイルが落ちる=追補b(1)の「無効の入力源」の実体)。
#[allow(dead_code)]
fn is_disabled(handle: &SpaceMouseHandle) -> bool {
    matches!(handle, SpaceMouseHandle::Disabled)
}

const LIB_RS: &str = include_str!("../src/lib.rs");

const START_CALL: &str = "spacemouse::start(";
const DISABLED_VALUE: &str = "SpaceMouseHandle::Disabled";

// ---------------------------------------------------------------------------
// ソースの読み取り(既存テスト acceptance_req38f / req55 ほかと同じ方式)
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

fn lib_rs_code() -> String {
    strip_line_comments(LIB_RS)
}

/// 文字列リテラルの中を空白に置き換えた同じ長さの写し(括弧の対応を数えるとき、
/// `"{}"` のようなリテラル内の括弧に惑わされないため。位置は元のソースと一致する)。
fn mask_string_literals(code: &str) -> Vec<u8> {
    let bytes = code.as_bytes();
    let mut out = bytes.to_vec();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j] != b'"' {
                if bytes[j] == b'\\' {
                    j += 1;
                }
                j += 1;
            }
            for k in (i + 1)..j.min(bytes.len()) {
                out[k] = b' ';
            }
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}

fn is_open(c: u8) -> bool {
    matches!(c, b'(' | b'[' | b'{')
}

fn is_close(c: u8) -> bool {
    matches!(c, b')' | b']' | b'}')
}

/// `open` の位置の開き括弧に対応する閉じ括弧の位置(前方)。
fn matching_close(masked: &[u8], open: usize) -> usize {
    let mut depth = 0usize;
    for i in open..masked.len() {
        if is_open(masked[i]) {
            depth += 1;
        } else if is_close(masked[i]) {
            depth -= 1;
            if depth == 0 {
                return i;
            }
        }
    }
    panic!("bracket at {open} never closes");
}

/// `close` の位置の閉じ括弧に対応する開き括弧の位置(後方)。
fn matching_open(masked: &[u8], close: usize) -> usize {
    let mut depth = 0usize;
    let mut i = close;
    loop {
        if is_close(masked[i]) {
            depth += 1;
        } else if is_open(masked[i]) {
            depth -= 1;
            if depth == 0 {
                return i;
            }
        }
        if i == 0 {
            panic!("bracket at {close} never opens");
        }
        i -= 1;
    }
}

/// `pos` を含む文の先頭(直前の `;` / 直前の完結したブロック `}` / 直前の属性 `#[...]` /
/// 囲むブロックの `{` の次の位置)。`pos` を囲む丸括弧(`manage(` など)は文の内側として
/// 通り抜ける。属性は文に含めない(attrs_before が別に読む)。
fn statement_start(masked: &[u8], pos: usize) -> usize {
    let mut depth = 0usize;
    let mut i = pos;
    while i > 0 {
        i -= 1;
        let c = masked[i];
        if is_close(c) {
            if depth == 0 && c == b'}' {
                return i + 1;
            }
            if depth == 0 && c == b']' {
                let open = matching_open(masked, i);
                let before = trim_end_len(&masked[..open]);
                if before > 0 && masked[before - 1] == b'#' {
                    return i + 1;
                }
            }
            depth += 1;
        } else if is_open(c) {
            if depth > 0 {
                depth -= 1;
            } else if c == b'{' {
                return i + 1;
            }
        } else if c == b';' && depth == 0 {
            return i + 1;
        }
    }
    0
}

/// `from` を囲む最も内側のブロックの `{` の位置。
fn enclosing_block_open(masked: &[u8], from: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut i = from;
    while i > 0 {
        i -= 1;
        let c = masked[i];
        if is_close(c) {
            depth += 1;
        } else if is_open(c) {
            if depth > 0 {
                depth -= 1;
            } else if c == b'{' {
                return Some(i);
            }
        }
    }
    None
}

/// 文の末尾(`start` から前方に、深さ 0 の `;` の次、または囲むブロックの `}` の位置)。
fn statement_end(masked: &[u8], start: usize) -> usize {
    let mut depth = 0usize;
    for i in start..masked.len() {
        let c = masked[i];
        if is_open(c) {
            depth += 1;
        } else if is_close(c) {
            if depth == 0 {
                return i;
            }
            depth -= 1;
        } else if c == b';' && depth == 0 {
            return i + 1;
        }
    }
    masked.len()
}

fn trim_end_len(bytes: &[u8]) -> usize {
    let mut n = bytes.len();
    while n > 0 && bytes[n - 1].is_ascii_whitespace() {
        n -= 1;
    }
    n
}

// ---------------------------------------------------------------------------
// cfg 述語の三値評価
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Tv {
    True,
    False,
    Unknown,
}

impl Tv {
    fn not(self) -> Tv {
        match self {
            Tv::True => Tv::False,
            Tv::False => Tv::True,
            Tv::Unknown => Tv::Unknown,
        }
    }
}

fn tv_all(vs: &[Tv]) -> Tv {
    if vs.iter().any(|v| *v == Tv::False) {
        Tv::False
    } else if vs.iter().any(|v| *v == Tv::Unknown) {
        Tv::Unknown
    } else {
        Tv::True
    }
}

fn tv_any(vs: &[Tv]) -> Tv {
    if vs.iter().any(|v| *v == Tv::True) {
        Tv::True
    } else if vs.iter().any(|v| *v == Tv::Unknown) {
        Tv::Unknown
    } else {
        Tv::False
    }
}

/// `cfg(...)` / `cfg!(...)` の中身を評価する。`feature = "webdriver"` だけが既知で、
/// 他の述語(`debug_assertions`・`target_os = ...`・他の feature)は不明とする。
fn eval_cfg(pred: &str, webdriver: bool) -> Tv {
    struct P<'a> {
        s: &'a [u8],
        i: usize,
    }
    impl P<'_> {
        fn ws(&mut self) {
            while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
                self.i += 1;
            }
        }
        fn ident(&mut self) -> String {
            let start = self.i;
            while self.i < self.s.len()
                && (self.s[self.i].is_ascii_alphanumeric() || self.s[self.i] == b'_')
            {
                self.i += 1;
            }
            String::from_utf8_lossy(&self.s[start..self.i]).into_owned()
        }
        fn string(&mut self) -> String {
            assert_eq!(self.s.get(self.i), Some(&b'"'), "cfg: string literal expected");
            self.i += 1;
            let start = self.i;
            while self.i < self.s.len() && self.s[self.i] != b'"' {
                self.i += 1;
            }
            let v = String::from_utf8_lossy(&self.s[start..self.i]).into_owned();
            self.i += 1;
            v
        }
        fn pred(&mut self, webdriver: bool) -> Tv {
            self.ws();
            let name = self.ident();
            self.ws();
            match self.s.get(self.i) {
                Some(b'(') => {
                    self.i += 1;
                    let mut args = Vec::new();
                    loop {
                        self.ws();
                        if self.s.get(self.i) == Some(&b')') {
                            self.i += 1;
                            break;
                        }
                        args.push(self.pred(webdriver));
                        self.ws();
                        if self.s.get(self.i) == Some(&b',') {
                            self.i += 1;
                        }
                    }
                    match name.as_str() {
                        "all" => tv_all(&args),
                        "any" => tv_any(&args),
                        "not" => {
                            assert_eq!(args.len(), 1, "cfg: not() takes one predicate");
                            args[0].not()
                        }
                        _ => Tv::Unknown,
                    }
                }
                Some(b'=') => {
                    self.i += 1;
                    self.ws();
                    let value = self.string();
                    if name == "feature" && value == "webdriver" {
                        if webdriver {
                            Tv::True
                        } else {
                            Tv::False
                        }
                    } else {
                        Tv::Unknown
                    }
                }
                _ => Tv::Unknown,
            }
        }
    }
    let mut p = P {
        s: pred.as_bytes(),
        i: 0,
    };
    p.pred(webdriver)
}

/// 条件 1 つ = (述語, 否定するか)。`else` 側や `!cfg!` は否定で表す。
type Cond = (String, bool);

/// `at` の直前に並ぶ `#[cfg(...)]` 属性(他の属性は読み飛ばす)。
fn attrs_before(code: &str, masked: &[u8], at: usize) -> Vec<Cond> {
    let mut conds = Vec::new();
    let mut end = at;
    loop {
        let n = trim_end_len(&masked[..end]);
        if n == 0 || masked[n - 1] != b']' {
            break;
        }
        let close = n - 1;
        let open = matching_open(masked, close);
        let before = trim_end_len(&masked[..open]);
        if before == 0 || masked[before - 1] != b'#' {
            break;
        }
        let inner = code[open + 1..close].trim();
        if let Some(rest) = inner.strip_prefix("cfg") {
            let rest = rest.trim_start();
            if rest.starts_with('(') && rest.ends_with(')') {
                conds.push((rest[1..rest.len() - 1].to_string(), false));
            }
        }
        end = before - 1;
    }
    conds
}

/// ブロック `{`(`open`)の直前が `if cfg!(...)` / `if !cfg!(...)` / `else`(対になる
/// `if cfg!(...)` を遡る)なら、そのブロックを通す条件。
fn cfg_macro_before(code: &str, masked: &[u8], open: usize) -> Option<Cond> {
    let n = trim_end_len(&masked[..open]);
    if n == 0 {
        return None;
    }
    if masked[n - 1] == b')' {
        let close = n - 1;
        let paren_open = matching_open(masked, close);
        let b = trim_end_len(&masked[..paren_open]);
        let before = &code[..b];
        let before = before.strip_suffix("cfg!")?;
        let before = before.trim_end();
        let (before, negate) = match before.strip_suffix('!') {
            Some(b) => (b.trim_end(), true),
            None => (before, false),
        };
        if before.ends_with("if") {
            return Some((code[paren_open + 1..close].to_string(), negate));
        }
        return None;
    }
    if code[..n].ends_with("else") {
        let b = trim_end_len(&masked[..n - 4]);
        if b == 0 || masked[b - 1] != b'}' {
            return None;
        }
        let then_open = matching_open(masked, b - 1);
        return cfg_macro_before(code, masked, then_open).map(|(p, neg)| (p, !neg));
    }
    None
}

/// `pos` の文を通す条件をすべて集める(文の属性 → 囲むブロックの属性 / `if cfg!` →
/// その外側の文 … と `limit`(起動処理の `{`)まで遡る)。
fn governing_conditions(code: &str, masked: &[u8], pos: usize, limit: usize) -> Vec<Cond> {
    let mut conds = Vec::new();
    let mut pos = pos;
    loop {
        let stmt = statement_start(masked, pos);
        conds.extend(attrs_before(code, masked, stmt));
        let Some(open) = enclosing_block_open(masked, stmt) else {
            break;
        };
        if open <= limit {
            break;
        }
        conds.extend(attrs_before(code, masked, open));
        conds.extend(cfg_macro_before(code, masked, open));
        pos = open;
    }
    conds
}

/// `pos` の文が、`feature = "webdriver"` を `webdriver` としたビルドでコンパイルされるか。
fn compiled_under(code: &str, masked: &[u8], pos: usize, limit: usize, webdriver: bool) -> Tv {
    let conds = governing_conditions(code, masked, pos, limit);
    let vs: Vec<Tv> = conds
        .iter()
        .map(|(pred, negate)| {
            let v = eval_cfg(pred, webdriver);
            if *negate {
                v.not()
            } else {
                v
            }
        })
        .collect();
    tv_all(&vs)
}

/// `pos` を含む、起動処理の直下の文(`limit` = 起動処理の `{`)の範囲。
fn top_statement(masked: &[u8], pos: usize, limit: usize) -> (usize, usize) {
    let mut pos = pos;
    loop {
        let stmt = statement_start(masked, pos);
        match enclosing_block_open(masked, stmt) {
            Some(open) if open > limit => pos = open,
            _ => return (stmt, statement_end(masked, stmt)),
        }
    }
}

/// `(start, end)` の文の値が managed state に置かれるか: 文自身が `manage(` を含む、
/// または `let NAME = ...;` で束縛した NAME を起動処理の中で `manage(NAME)` している。
fn statement_is_managed(code: &str, (start, end): (usize, usize), setup: (usize, usize)) -> bool {
    let stmt = &code[start..end];
    if stmt.contains("manage(") {
        return true;
    }
    let Some(rest) = stmt.trim_start().strip_prefix("let ") else {
        return false;
    };
    let rest = rest.trim_start();
    let rest = rest.strip_prefix("mut ").unwrap_or(rest).trim_start();
    let name: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    if name.is_empty() {
        return false;
    }
    let body = &code[setup.0..setup.1];
    body.match_indices("manage(").any(|(i, _)| {
        let after = body[i + "manage(".len()..].trim_start();
        after
            .strip_prefix(name.as_str())
            .map(|a| a.trim_start().starts_with(')'))
            .unwrap_or(false)
    })
}

/// 起動処理(`.setup(` クロージャ)の本体 `{`..`}` の位置。
fn setup_body(masked: &[u8], code: &str) -> (usize, usize) {
    let at = code.find(".setup(").expect("lib.rs has a .setup( closure");
    let open = at + code[at..].find('{').expect(".setup closure opens a block");
    (open, matching_close(masked, open))
}

fn occurrences(code: &str, needle: &str) -> Vec<usize> {
    code.match_indices(needle).map(|(i, _)| i).collect()
}

fn describe(code: &str, pos: usize) -> String {
    let line = code[..pos].matches('\n').count() + 1;
    let snippet: String = code[pos..].chars().take(60).collect();
    format!("line {line}: {}", snippet.replace('\n', " "))
}

// ---------------------------------------------------------------------------
// ケース
// ---------------------------------------------------------------------------

/// ① 追補b(2) 不変: 起動処理に `spacemouse::start(` があり、通常ビルドでコンパイルされ、
///    その結果が managed state に置かれる。
#[test]
fn normal_build_still_calls_spacemouse_start() {
    let code = lib_rs_code();
    let masked = mask_string_literals(&code);
    let setup = setup_body(&masked, &code);

    let calls = occurrences(&code, START_CALL);
    assert!(
        !calls.is_empty(),
        "lib.rs must still call `{START_CALL}` (normal builds keep the SpaceMouse input source)"
    );
    for pos in &calls {
        assert!(
            setup.0 < *pos && *pos < setup.1,
            "`{START_CALL}` must live in the startup processing (.setup closure) — {}",
            describe(&code, *pos)
        );
    }

    let live: Vec<usize> = calls
        .iter()
        .copied()
        .filter(|pos| compiled_under(&code, &masked, *pos, setup.0, false) == Tv::True)
        .collect();
    assert!(
        !live.is_empty(),
        "at least one `{START_CALL}` must be compiled in a build without the `webdriver` feature; conditions found: {:?}",
        calls
            .iter()
            .map(|p| governing_conditions(&code, &masked, *p, setup.0))
            .collect::<Vec<_>>()
    );
    for pos in live {
        let stmt = top_statement(&masked, pos, setup.0);
        assert!(
            statement_is_managed(&code, stmt, setup),
            "the SpaceMouse handle from `{START_CALL}` must be put into managed state (`manage(`) — {}",
            describe(&code, pos)
        );
    }
}

/// ② 追補b(1): `lib.rs` の `spacemouse::start(` は webdriver ありのビルドでは
///    どこもコンパイルされない(3DxWare への登録も raw HID の読み取りも始まらない)。
#[test]
fn webdriver_build_does_not_compile_spacemouse_start() {
    let code = lib_rs_code();
    let masked = mask_string_literals(&code);
    let setup = setup_body(&masked, &code);

    let calls = occurrences(&code, START_CALL);
    assert!(!calls.is_empty(), "lib.rs must call `{START_CALL}` somewhere (see case ①)");
    for pos in calls {
        let verdict = compiled_under(&code, &masked, pos, setup.0, true);
        assert_eq!(
            verdict,
            Tv::False,
            "`{START_CALL}` must be compiled out when the `webdriver` feature is on \
             (e.g. `#[cfg(not(feature = \"webdriver\"))]` on the statement, or the else branch \
             of `if cfg!(feature = \"webdriver\")`); got {verdict:?} from conditions {:?} — {}",
            governing_conditions(&code, &masked, pos, setup.0),
            describe(&code, pos)
        );
    }
}

/// ③ 追補b(1)(2): 起動処理に `SpaceMouseHandle::Disabled` を置く文があり、webdriver あり
///    ではコンパイルされ、通常ビルドではコンパイルされず、その値が managed state に置かれる。
#[test]
fn webdriver_build_manages_disabled_spacemouse_handle() {
    let code = lib_rs_code();
    let masked = mask_string_literals(&code);
    let setup = setup_body(&masked, &code);

    let uses: Vec<usize> = occurrences(&code, DISABLED_VALUE)
        .into_iter()
        .filter(|pos| setup.0 < *pos && *pos < setup.1)
        .collect();
    assert!(
        !uses.is_empty(),
        "the startup processing (.setup closure) in lib.rs must place a disabled input source \
         (`{DISABLED_VALUE}`) for the `webdriver` build"
    );

    let webdriver_only: Vec<usize> = uses
        .iter()
        .copied()
        .filter(|pos| {
            compiled_under(&code, &masked, *pos, setup.0, true) == Tv::True
                && compiled_under(&code, &masked, *pos, setup.0, false) == Tv::False
        })
        .collect();
    assert!(
        !webdriver_only.is_empty(),
        "`{DISABLED_VALUE}` must be compiled only when the `webdriver` feature is on \
         (and not in normal builds, which keep `{START_CALL}`); conditions found: {:?}",
        uses.iter()
            .map(|p| (describe(&code, *p), governing_conditions(&code, &masked, *p, setup.0)))
            .collect::<Vec<_>>()
    );

    assert!(
        webdriver_only.iter().any(|pos| {
            let stmt = top_statement(&masked, *pos, setup.0);
            statement_is_managed(&code, stmt, setup)
        }),
        "the webdriver build must put `{DISABLED_VALUE}` into managed state (`manage(`) so \
         `set_window_focus` and shutdown keep working — {:?}",
        webdriver_only
            .iter()
            .map(|p| describe(&code, *p))
            .collect::<Vec<_>>()
    );
}

// ---------------------------------------------------------------------------
// 走査器の自己検証(実装の書き方の自由度=受け付ける形と拒む形を固定する)
// ---------------------------------------------------------------------------

fn verdicts(src: &str) -> (Tv, Tv) {
    let code = strip_line_comments(src);
    let masked = mask_string_literals(&code);
    let setup = setup_body(&masked, &code);
    let pos = code.find(START_CALL).expect("fixture calls spacemouse::start");
    (
        compiled_under(&code, &masked, pos, setup.0, false),
        compiled_under(&code, &masked, pos, setup.0, true),
    )
}

#[test]
fn scanner_reads_cfg_attribute_on_statement() {
    let src = r#"
        .setup(move |app| {
            update_check::spawn_poller(app.handle().clone());
            #[cfg(not(feature = "webdriver"))]
            app.manage(spacemouse::start(app.handle().clone()));
            #[cfg(feature = "webdriver")]
            app.manage(spacemouse::SpaceMouseHandle::Disabled);
            Ok(())
        })
    "#;
    assert_eq!(verdicts(src), (Tv::True, Tv::False));
}

#[test]
fn scanner_reads_cfg_attribute_on_let_binding_managed_later() {
    let src = r#"
        .setup(move |app| {
            #[cfg(not(feature = "webdriver"))]
            let spacemouse_handle = spacemouse::start(app.handle().clone());
            #[cfg(feature = "webdriver")]
            let spacemouse_handle = spacemouse::SpaceMouseHandle::Disabled;
            app.manage(spacemouse_handle);
            Ok(())
        })
    "#;
    assert_eq!(verdicts(src), (Tv::True, Tv::False));
    let code = strip_line_comments(src);
    let masked = mask_string_literals(&code);
    let setup = setup_body(&masked, &code);
    let pos = code.find(DISABLED_VALUE).unwrap();
    assert!(statement_is_managed(&code, top_statement(&masked, pos, setup.0), setup));
}

#[test]
fn scanner_reads_if_cfg_macro_with_else_branch() {
    let src = r#"
        .setup(move |app| {
            let handle = if cfg!(feature = "webdriver") {
                tracing::info!("SpaceMouse: disabled under webdriver {}", 1);
                spacemouse::SpaceMouseHandle::Disabled
            } else {
                spacemouse::start(app.handle().clone())
            };
            app.manage(handle);
            Ok(())
        })
    "#;
    assert_eq!(verdicts(src), (Tv::True, Tv::False));
    let code = strip_line_comments(src);
    let masked = mask_string_literals(&code);
    let setup = setup_body(&masked, &code);
    let pos = code.find(DISABLED_VALUE).unwrap();
    assert_eq!(compiled_under(&code, &masked, pos, setup.0, true), Tv::True);
    assert_eq!(compiled_under(&code, &masked, pos, setup.0, false), Tv::False);
    assert!(statement_is_managed(&code, top_statement(&masked, pos, setup.0), setup));
}

#[test]
fn scanner_reads_negated_cfg_macro() {
    let src = r#"
        .setup(move |app| {
            if !cfg!(feature = "webdriver") {
                app.manage(spacemouse::start(app.handle().clone()));
            }
            Ok(())
        })
    "#;
    assert_eq!(verdicts(src), (Tv::True, Tv::False));
}

#[test]
fn scanner_rejects_ungated_and_insufficiently_gated_calls() {
    let ungated = r#"
        .setup(move |app| {
            app.manage(spacemouse::start(app.handle().clone()));
            Ok(())
        })
    "#;
    assert_eq!(verdicts(ungated), (Tv::True, Tv::True));

    // release + webdriver では呼ばれてしまう=「webdriver のビルドでは呼ばない」を満たさない
    let release_only = r#"
        .setup(move |app| {
            #[cfg(not(all(feature = "webdriver", debug_assertions)))]
            app.manage(spacemouse::start(app.handle().clone()));
            Ok(())
        })
    "#;
    assert_eq!(verdicts(release_only), (Tv::True, Tv::Unknown));

    // 逆向きの条件(webdriver のときだけ呼ぶ)
    let inverted = r#"
        .setup(move |app| {
            #[cfg(feature = "webdriver")]
            app.manage(spacemouse::start(app.handle().clone()));
            Ok(())
        })
    "#;
    assert_eq!(verdicts(inverted), (Tv::False, Tv::True));
}

#[test]
fn cfg_predicate_evaluator_handles_all_any_not() {
    assert_eq!(eval_cfg(r#"feature = "webdriver""#, true), Tv::True);
    assert_eq!(eval_cfg(r#"feature = "webdriver""#, false), Tv::False);
    assert_eq!(eval_cfg(r#"not(feature = "webdriver")"#, true), Tv::False);
    assert_eq!(eval_cfg(r#"all(not(feature = "webdriver"), target_os = "macos")"#, true), Tv::False);
    assert_eq!(eval_cfg(r#"all(not(feature = "webdriver"), target_os = "macos")"#, false), Tv::Unknown);
    assert_eq!(eval_cfg(r#"any(feature = "webdriver", debug_assertions)"#, true), Tv::True);
    assert_eq!(eval_cfg(r#"any(feature = "webdriver", debug_assertions)"#, false), Tv::Unknown);
    assert_eq!(eval_cfg(r#"all(feature = "webdriver", debug_assertions)"#, true), Tv::Unknown);
    assert_eq!(eval_cfg("debug_assertions", true), Tv::Unknown);
}
