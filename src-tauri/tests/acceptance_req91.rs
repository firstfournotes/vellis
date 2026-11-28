//! Requirement #91 (docs/requirements/req-91.md) — the Rust layer (the native menu): AC-91-8, contract 11.
//! View ▸ Show Audio Spectrum: a check item, no shortcut, checked at the start (the spectrum is shown by default),
//! grey unless the front window shows a video or audio document, one app-wide setting (all windows).
//!
//! muda's menu needs the main thread and an `AppHandle`, so this file scans the sources (menu.rs / lib.rs) like
//! acceptance_req90.rs / req80.rs / req74_menu.rs and calls the `pub` constants of `vellis_lib::menu` directly.
//! The front end is `src/lib/spectrum-visibility.acceptance.test.ts`; the device is `tests/e2e/specs/req91-gate.e2e.ts`.
//!
//! ## Fixed contract (the implementer follows this)
//!
//! ```text
//! // --- src-tauri/src/menu.rs
//! pub const SHOW_SPECTRUM_ITEM_ID: &str = "show-audio-spectrum";     // View ▸ Show Audio Spectrum (CheckMenuItem)
//! pub const MENU_SHOW_SPECTRUM_EVENT: &str = "menu_show_spectrum";   // Rust → the focused window (no payload): toggle the setting
//! pub const SPECTRUM_STATE_EVENT: &str = "spectrum_state";           // window → Rust { label, shown, available }
//! // build():
//!   let show_spectrum_item = CheckMenuItem::with_id(app, SHOW_SPECTRUM_ITEM_ID, "Show Audio Spectrum", false, true, None::<&str>)?;
//!   //   enabled = false (grey until a window reports a video / audio document), checked = true (shown by default), no accelerator
//!   // View is 17 entries: …, show_format_toolbar_item, alerts_menu, show_spectrum_item, view_chrome_sep, … (right after Alerts)
//! #[derive(serde::Deserialize)] struct SpectrumState { label: String, shown: bool, available: bool }
//! pub fn listen_spectrum_state(app: &AppHandle<Wry>);
//!   // app.listen(SPECTRUM_STATE_EVENT, …): set_checked(shown) — the setting is app-wide, any window's report applies;
//!   // set_enabled(available) only when the report comes from the front window (focused_or_first_window / raw_check_applies),
//!   // as Raw Source does. Found through find_check_menu_item(&menu, SHOW_SPECTRUM_ITEM_ID) (View is one level down)
//! // --- src-tauri/src/lib.rs
//!   setup: menu::listen_spectrum_state(app.handle()) once
//!   on_menu_event: id if id == menu::SHOW_SPECTRUM_ITEM_ID => menu::handle_menu_open_click(app_handle, menu::MENU_SHOW_SPECTRUM_EVENT)
//!     (no revert_check_toggle: the window's spectrum_state sets the check, like the alert kinds — the count stays 2)
//! ```
//!
//! ## Judgement record (test-writer 2026-11-27)
//! - The item goes right after View ▸ Alerts, with the other "show / hide something" toggles (Raw Source, Show Formatting
//!   Toolbar, Alerts), before the Zoom separator. View grows 16 → 17, which is a requirement-side update of the existing
//!   fixtures (req-91.md"requirement-side update").
//! - Built disabled: at launch the front window shows Markdown or the Dashboard, so grey is the right start; the viewer's report
//!   enables it. Built checked: contract 11 "shown at first".
//! - No revert of muda's click flip: the window answers with spectrum_state and the check follows it (requirement #90's way).
//!
//! ## Why this is red before the implementation
//! - `vellis_lib::menu` has no SHOW_SPECTRUM_ITEM_ID / MENU_SHOW_SPECTRUM_EVENT / SPECTRUM_STATE_EVENT → this binary fails to compile.

use std::collections::BTreeSet;
use std::path::PathBuf;

use vellis_lib::menu::{MENU_SHOW_SPECTRUM_EVENT, SHOW_SPECTRUM_ITEM_ID, SPECTRUM_STATE_EVENT};

// ---------------------------------------------------------------------------
// helpers — the same as acceptance_req90.rs (comments stripped, balanced brackets)
// ---------------------------------------------------------------------------

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_source_or_empty(rel: &str) -> String {
    std::fs::read_to_string(manifest_dir().join(rel)).unwrap_or_default()
}

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

fn spectrum_visibility_ts() -> String {
    read_source_or_empty("../src/lib/spectrum-visibility.ts")
}

fn matching_close(code: &str, open: usize) -> usize {
    let mut depth = 0usize;
    for (i, c) in code[open..].char_indices() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => {
                depth -= 1;
                if depth == 0 {
                    return open + i;
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced bracket starting at byte {open}");
}

fn balanced_call(code: &str, start: usize) -> &str {
    let open = code[start..].find('(').expect("call must have '('") + start;
    let close = matching_close(code, open);
    &code[start..=close]
}

fn first_string_literal(s: &str) -> Option<&str> {
    let a = s.find('"')? + 1;
    let b = s[a..].find('"')? + a;
    Some(&s[a..b])
}

fn arguments(call: &str) -> Vec<&str> {
    let open = call.find('(').expect("call must have '('");
    let inner = &call[open + 1..call.len() - 1];
    inner.split(',').map(str::trim).filter(|s| !s.is_empty()).collect()
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

fn submenu_item_idents(call: &str) -> Vec<&str> {
    let slice_open = call.find("&[").expect("submenu must take an item slice");
    let slice_end = matching_close(call, slice_open + 1);
    call[slice_open + 2..slice_end]
        .split(',')
        .map(|s| s.trim().trim_start_matches('&'))
        .filter(|s| !s.is_empty())
        .collect()
}

/// The `CheckMenuItem::with_id(` call that names `const_name`.
fn check_item_call_using<'a>(code: &'a str, const_name: &str) -> Option<&'a str> {
    let mut search = 0;
    while let Some(rel) = code[search..].find("CheckMenuItem::with_id(") {
        let start = search + rel;
        let call = balanced_call(code, start);
        search = start + "CheckMenuItem::with_id(".len();
        if call.contains(const_name) {
            return Some(call);
        }
    }
    None
}

fn let_binding_before<'a>(code: &'a str, use_pos: usize, what: &str) -> &'a str {
    let let_pos = code[..use_pos]
        .rfind("let ")
        .unwrap_or_else(|| panic!("{what} must be used inside a let binding"));
    code[let_pos + 4..use_pos]
        .split(|c: char| c == '=' || c.is_whitespace())
        .find(|s| !s.is_empty())
        .expect("binding name after `let`")
}

fn separator_bindings(code: &str) -> BTreeSet<&str> {
    code.match_indices("PredefinedMenuItem::separator(")
        .map(|(pos, _)| let_binding_before(code, pos, "PredefinedMenuItem::separator"))
        .collect()
}

fn str_const<'a>(code: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("pub const {name}: &str = \"");
    let start = code.find(&needle)? + needle.len();
    let end = code[start..].find('"')? + start;
    Some(&code[start..end])
}

fn fn_decl_start(code: &str, name: &str) -> Option<usize> {
    let paren = format!("fn {name}(");
    let generic = format!("fn {name}<");
    code.find(&paren).or_else(|| code.find(&generic))
}

fn fn_body(code: &str, name: &str) -> String {
    let start = fn_decl_start(code, name).unwrap_or_else(|| panic!("source must define `fn {name}(` (or `fn {name}<`)"));
    let params_open = code[start..].find('(').expect("fn must take parameters") + start;
    let params_close = matching_close(code, params_open);
    let open = code[params_close..].find('{').expect("fn must have a body") + params_close;
    let close = matching_close(code, open);
    code[open + 1..close].to_string()
}

fn on_menu_event_block(code: &str) -> &str {
    let start = code.find("on_menu_event(").expect("lib.rs must call on_menu_event");
    balanced_call(code, start)
}

fn menu_arm_body<'a>(block: &'a str, const_name: &str) -> &'a str {
    let needle = format!("menu::{const_name}");
    let pos = block
        .find(&needle)
        .unwrap_or_else(|| panic!("on_menu_event must dispatch menu::{const_name}"));
    let arrow = block[pos..].find("=>").expect("match arm must have =>") + pos;
    let open = block[arrow..].find('{').expect("arm body must be a block") + arrow;
    let close = matching_close(block, open);
    &block[open..=close]
}

fn menu_rs_string_literals(code: &str) -> Vec<String> {
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

fn ts_string_const(src: &str, name: &str) -> String {
    let marker = format!("export const {name}");
    let at = src
        .find(&marker)
        .unwrap_or_else(|| panic!("src/lib/spectrum-visibility.ts must `{marker}` (AC-91-8)"));
    let rest = &src[at + marker.len()..];
    let eq = rest.find('=').expect("`=` after the const name");
    let after = rest[eq + 1..].trim_start();
    let quote = after.chars().next().expect("a quoted string");
    assert!(quote == '\'' || quote == '"' || quote == '`', "{name} must be a string literal, got {after:?}");
    let body = &after[quote.len_utf8()..];
    let end = body.find(quote).expect("closing quote");
    body[..end].to_string()
}

fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

// Requirement-side update (2026-11-27, requirement #91 contract 11): `show_spectrum_item` right after `alerts_menu`. 16 → 17.
const EXPECTED_VIEW: [&str; 17] = [
    "show_tab_bar_item",
    "show_all_tabs_item",
    "view_tab_sep",
    "reload_file_item",
    "view_reload_sep",
    "appearance_menu",
    "toggle_full_width_item",
    "raw_source_item",
    "show_format_toolbar_item",
    "alerts_menu",
    "show_spectrum_item",
    "view_chrome_sep",
    "zoom_in_item",
    "zoom_out_item",
    "actual_size_item",
    "view_sep",
    "toggle_devtools",
];

// ---------------------------------------------------------------------------
// AC-91-8 — constants (contract 11)
// ---------------------------------------------------------------------------

/// 1. The constants are fixed (id, the two event names) and declared as `pub const … &str` in menu.rs.
#[test]
fn ac91_8_constants_are_fixed() {
    assert_eq!(SHOW_SPECTRUM_ITEM_ID, "show-audio-spectrum");
    assert_eq!(MENU_SHOW_SPECTRUM_EVENT, "menu_show_spectrum");
    assert_eq!(SPECTRUM_STATE_EVENT, "spectrum_state");
    let code = menu_rs_code();
    for (name, value) in [
        ("SHOW_SPECTRUM_ITEM_ID", "show-audio-spectrum"),
        ("MENU_SHOW_SPECTRUM_EVENT", "menu_show_spectrum"),
        ("SPECTRUM_STATE_EVENT", "spectrum_state"),
    ] {
        assert_eq!(str_const(&code, name), Some(value), "menu.rs must declare `pub const {name}: &str = \"{value}\";`");
    }
}

// ---------------------------------------------------------------------------
// AC-91-8 — the item (contract 11: check item, no shortcut, checked, grey at build)
// ---------------------------------------------------------------------------

/// 2. `let show_spectrum_item = CheckMenuItem::with_id(app, SHOW_SPECTRUM_ITEM_ID, "Show Audio Spectrum", false, true, None::<&str>)?;`
#[test]
fn ac91_8_show_audio_spectrum_is_a_check_item_without_shortcut_checked_and_grey_at_build() {
    let code = menu_rs_code();
    let call = check_item_call_using(&code, "SHOW_SPECTRUM_ITEM_ID")
        .expect("menu.rs must build a CheckMenuItem::with_id(... SHOW_SPECTRUM_ITEM_ID ...)");
    let use_pos = call.as_ptr() as usize - code.as_ptr() as usize;
    assert_eq!(let_binding_before(&code, use_pos, "SHOW_SPECTRUM_ITEM_ID"), "show_spectrum_item");
    let args = arguments(call);
    assert_eq!(args.len(), 6, "CheckMenuItem::with_id takes 6 arguments: {call}");
    assert_eq!(args[1], "SHOW_SPECTRUM_ITEM_ID", "the id must be the constant: {call}");
    assert_eq!(args[2], "\"Show Audio Spectrum\"", "the label is \"Show Audio Spectrum\": {call}");
    assert_eq!(args[3], "false", "grey at build: no window has reported a video / audio document yet: {call}");
    assert_eq!(args[4], "true", "checked at build: the spectrum is shown by default (contract 11): {call}");
    assert!(args[5].starts_with("None"), "no accelerator (decision 15): {call}");
    assert!(!call.contains('+'), "no inline accelerator literal: {call}");
    let literals = menu_rs_string_literals(&code);
    assert_eq!(literals.iter().filter(|s| s.as_str() == "Show Audio Spectrum").count(), 1, "one label literal");
}

/// 3. No accelerator anywhere near the spectrum: the set of accelerator-looking literals of menu.rs does not grow
///    with a spectrum one (every `+` literal belongs to an item that existed before; counted here as "no literal is on the
///    same line as SHOW_SPECTRUM_ITEM_ID").
#[test]
fn ac91_8_no_shortcut_is_registered_for_the_spectrum() {
    let code = menu_rs_code();
    for line in code.lines().filter(|l| l.contains("SHOW_SPECTRUM_ITEM_ID")) {
        assert!(!line.contains("Some(\""), "no inline accelerator on the spectrum item's line: {line}");
        assert!(!line.contains("ACCELERATOR"), "no accelerator constant on the spectrum item's line: {line}");
    }
}

// ---------------------------------------------------------------------------
// AC-91-8 — View's order (contract 11; source scan)
// ---------------------------------------------------------------------------

/// 4. View holds 17 entries with `show_spectrum_item` right after `alerts_menu`, before the Zoom separator.
#[test]
fn ac91_8_view_menu_holds_show_audio_spectrum_right_after_alerts() {
    let code = menu_rs_code();
    let view = submenu_call_with_label(&code, "View").expect("menu.rs must build a \"View\" submenu");
    let idents = submenu_item_idents(view);
    assert_eq!(idents, EXPECTED_VIEW, "the View menu must hold exactly these 17 entries in this order: found {idents:?}");
    let alerts_at = idents.iter().position(|i| *i == "alerts_menu").expect("Alerts in View");
    assert_eq!(idents.get(alerts_at + 1), Some(&"show_spectrum_item"), "right after Alerts");
    let separators = separator_bindings(&code);
    assert!(separators.contains(idents[alerts_at + 2]), "the Zoom separator follows the spectrum item ({idents:?})");
    assert_eq!(idents.iter().filter(|i| separators.contains(**i)).count(), 4, "View keeps its 4 separators");
}

/// 5. Four CheckMenuItems in menu.rs: Raw Source, Show Formatting Toolbar, the alert kinds' helper and Show Audio Spectrum.
#[test]
fn ac91_8_show_audio_spectrum_is_the_fourth_check_item() {
    let code = menu_rs_code();
    let checks: Vec<usize> = code.match_indices("CheckMenuItem::with_id(").map(|(i, _)| i).collect();
    assert_eq!(checks.len(), 4, "Raw Source, Show Formatting Toolbar, alert_kind_item and Show Audio Spectrum are the CheckMenuItems");
    let calls: Vec<&str> = checks.iter().map(|&at| balanced_call(&code, at)).collect();
    assert!(calls.iter().any(|c| c.contains("SHOW_SPECTRUM_ITEM_ID")), "one of them is Show Audio Spectrum: {calls:?}");
}

// ---------------------------------------------------------------------------
// AC-91-8 — lib.rs (contract 11; source scan)
// ---------------------------------------------------------------------------

/// 6. The arm sends `menu_show_spectrum` to the focused window through `handle_menu_open_click`; muda's click flip is not
///    reverted (the window's `spectrum_state` sets the check) — `revert_check_toggle(` stays at its 2 arms.
#[test]
fn ac91_8_lib_rs_dispatches_the_item_to_the_focused_window_without_reverting_the_check() {
    let lib = lib_rs_code();
    let block = on_menu_event_block(&lib);
    let body = menu_arm_body(block, "SHOW_SPECTRUM_ITEM_ID");
    assert!(
        squash(body).contains("menu::handle_menu_open_click(app_handle,menu::MENU_SHOW_SPECTRUM_EVENT)"),
        "the arm must call menu::handle_menu_open_click(app_handle, menu::MENU_SHOW_SPECTRUM_EVENT) ({body})"
    );
    assert!(!body.contains("revert_check_toggle("), "the spectrum arm does not revert the check ({body})");
    assert_eq!(block.matches("menu::SHOW_SPECTRUM_ITEM_ID").count(), 1, "on_menu_event dispatches the id exactly once");
    assert_eq!(block.matches("revert_check_toggle(").count(), 2, "Raw Source and Show Formatting Toolbar remain the only reverting arms");
}

/// 7. `listen_spectrum_state` reads { label, shown, available }: the check follows `shown` (app-wide), the enabled state follows
///    `available` of the FRONT window; lib.rs subscribes it once in setup.
#[test]
fn ac91_8_listen_spectrum_state_sets_the_check_and_greys_by_the_front_window() {
    let code = menu_rs_code();
    assert!(code.contains("pub fn listen_spectrum_state("), "menu.rs defines pub fn listen_spectrum_state");
    let body = fn_body(&code, "listen_spectrum_state");
    assert!(body.contains("SPECTRUM_STATE_EVENT"), "subscribes SPECTRUM_STATE_EVENT ({body})");
    assert!(body.contains("set_checked("), "sets the check from `shown` ({body})");
    assert!(body.contains("set_enabled("), "enables / greys from `available` ({body})");
    assert!(body.contains("SHOW_SPECTRUM_ITEM_ID"), "finds the item by its id ({body})");
    assert!(
        body.contains("focused_or_first_window(") || body.contains("raw_check_applies("),
        "the enabled state follows the FRONT window's report ({body})"
    );
    let state_struct = code.find("struct SpectrumState").expect("menu.rs declares struct SpectrumState for the payload");
    let struct_body = &code[state_struct..state_struct + 400];
    for field in ["label", "shown: bool", "available: bool"] {
        assert!(struct_body.contains(field), "SpectrumState has `{field}` ({struct_body})");
    }
    let lib = lib_rs_code();
    assert_eq!(lib.matches("menu::listen_spectrum_state(app.handle())").count(), 1, "lib.rs setup subscribes the spectrum state once");
}

// ---------------------------------------------------------------------------
// AC-91-8 — the front end spells the same events
// ---------------------------------------------------------------------------

/// 8. `src/lib/spectrum-visibility.ts` exists and its two event names equal the Rust constants.
#[test]
fn ac91_8_front_end_event_names_match_menu_rs() {
    let ts = spectrum_visibility_ts();
    assert!(!ts.is_empty(), "src/lib/spectrum-visibility.ts must exist");
    assert_eq!(ts_string_const(&ts, "MENU_SHOW_SPECTRUM_EVENT"), MENU_SHOW_SPECTRUM_EVENT);
    assert_eq!(ts_string_const(&ts, "SPECTRUM_STATE_EVENT"), SPECTRUM_STATE_EVENT);
}
