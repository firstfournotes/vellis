//! Themes — the look swapped without touching the code (requirements.md #56
//! 契約 2・3; the design record is docs/theme-architecture.md).
//!
//! A theme is a JSON file of design-token values: `version`, `meta`, `code`
//! (the Shiki theme names) and three blocks `common` / `light` / `dark` of
//! `"token-name": "value"`, the token names written without their leading
//! `--`. The built-in Default is `themes/default.json` of the repository,
//! embedded at build time; a user's theme is
//! `~/.config/vellis/themes/<name>.json`, chosen with `appearance.theme` in
//! `settings.json`.
//!
//! Rust is the single source of truth (§1): it reads the files, checks every
//! value against the grammar of its type ([`TOKENS`], §3.2), fills whatever is
//! missing or broken with the Default value, watches the two folders and sends
//! the resolved theme to every window. The front end only writes it into
//! `<style id="vellis-theme">` (`src/lib/theme.ts`).
//!
//! Resolution never fails: an unknown name is ignored, a missing one is the
//! Default value, a value outside its grammar falls back to Default with one
//! warning per resolve, an unreadable file is the whole Default with a warning.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::settings;

/// Event sent to every window when the resolved theme changed. Must match
/// `THEME_CHANGED_EVENT` in `src/lib/theme.ts`.
pub const THEME_CHANGED_EVENT: &str = "theme_changed";

/// The built-in theme's name, reserved: `themes/default.json` of the user is
/// never listed nor read (theme-architecture (d)).
pub const DEFAULT_THEME_NAME: &str = "default";

/// The source of truth of the Default theme, embedded at build time. The same
/// file `scripts/build-theme-css.mjs` turns into `src/styles/theme.css`.
pub const DEFAULT_THEME_JSON: &str = include_str!("../../themes/default.json");

/// Folder of the user's themes, next to `settings.json`.
pub const THEMES_DIR: &str = "themes";

/// File stem View ▸ Appearance ▸ Export Default Theme… writes: `my-theme.json`,
/// then `my-theme-2.json`, `my-theme-3.json`, … (theme-architecture (e)).
pub const EXPORT_THEME_STEM: &str = "my-theme";

/// `meta.name` of an exported theme (theme-architecture (e)).
pub const EXPORT_THEME_META_NAME: &str = "My Theme";

/// The version of the token set this Vellis understands (§3.3).
const THEME_VERSION: u64 = 1;

/// Longest value accepted, in characters (§3.2).
const MAX_VALUE_CHARS: usize = 256;

/// How long the watcher waits for a burst of file events to settle (§5.2).
const DEBOUNCE: Duration = Duration::from_millis(150);

/// Title of the warning dialog (a different text from the exclude-list one).
const DIALOG_TITLE: &str = "Vellis Theme";

/// The grammar a token's value must follow (§3.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenType {
    Color,
    Length,
    FontFamily,
    FontSize,
    LineHeight,
    FontWeight,
    LetterSpacing,
    Shadow,
    Duration,
    Easing,
}

impl TokenType {
    /// What the value should have been, for the warning.
    fn expected(self) -> &'static str {
        match self {
            TokenType::Color => "not a color",
            TokenType::Length => "not a length",
            TokenType::FontFamily => "not a font family list",
            TokenType::FontSize => "not a font size",
            TokenType::LineHeight => "not a line height",
            TokenType::FontWeight => "not a font weight",
            TokenType::LetterSpacing => "not a letter spacing",
            TokenType::Shadow => "not a shadow",
            TokenType::Duration => "not a duration",
            TokenType::Easing => "not an easing",
        }
    }

    fn accepts(self, value: &str) -> bool {
        match self {
            TokenType::Color => is_color(value),
            TokenType::Length | TokenType::FontSize => is_length(value),
            TokenType::FontFamily => is_font_family(value),
            TokenType::LineHeight => {
                parse_number(value).is_some_and(|n| n > 0.0) || is_length(value)
            }
            TokenType::FontWeight => is_font_weight(value),
            TokenType::LetterSpacing => value == "normal" || is_length(value),
            TokenType::Shadow => is_shadow(value),
            TokenType::Duration => is_duration(value),
            TokenType::Easing => is_easing(value),
        }
    }
}

/// Every token a theme can set, with its type (§3.1; 65 rows). The names are
/// the JSON keys, i.e. the CSS custom property without its `--`. Names are only
/// ever added, never removed or renamed (§1), so an old theme keeps working.
pub const TOKENS: &[(&str, TokenType)] = &[
    // Colours (23 + emphasis)
    ("color-bg-base", TokenType::Color),
    ("color-bg-surface", TokenType::Color),
    ("color-bg-raised", TokenType::Color),
    ("color-bg-hover", TokenType::Color),
    ("color-bg-active", TokenType::Color),
    ("color-text-primary", TokenType::Color),
    ("color-text-secondary", TokenType::Color),
    ("color-text-muted", TokenType::Color),
    ("color-border", TokenType::Color),
    ("color-border-strong", TokenType::Color),
    ("color-accent", TokenType::Color),
    ("color-accent-text", TokenType::Color),
    ("color-on-accent", TokenType::Color),
    ("color-accent-soft", TokenType::Color),
    ("color-selection", TokenType::Color),
    ("color-focus-ring", TokenType::Color),
    ("color-danger", TokenType::Color),
    ("color-success", TokenType::Color),
    ("color-warning", TokenType::Color),
    ("color-danger-soft", TokenType::Color),
    ("color-success-soft", TokenType::Color),
    ("color-warning-soft", TokenType::Color),
    ("color-shadow", TokenType::Color),
    ("color-emphasis", TokenType::Color),
    // Spacing (6)
    ("space-1", TokenType::Length),
    ("space-2", TokenType::Length),
    ("space-3", TokenType::Length),
    ("space-4", TokenType::Length),
    ("space-5", TokenType::Length),
    ("space-6", TokenType::Length),
    // Radii (2)
    ("radius-sm", TokenType::Length),
    ("radius-md", TokenType::Length),
    // Typography (15)
    ("font-ui", TokenType::FontFamily),
    ("font-doc", TokenType::FontFamily),
    ("font-mono", TokenType::FontFamily),
    ("text-xs", TokenType::FontSize),
    ("text-sm", TokenType::FontSize),
    ("text-md", TokenType::FontSize),
    ("text-lg", TokenType::FontSize),
    ("text-xl", TokenType::FontSize),
    ("doc-size", TokenType::FontSize),
    ("doc-leading", TokenType::LineHeight),
    ("doc-measure", TokenType::Length),
    ("leading-ui", TokenType::LineHeight),
    ("pane-header-font-size", TokenType::FontSize),
    ("pane-header-font-weight", TokenType::FontWeight),
    ("pane-header-letter-spacing", TokenType::LetterSpacing),
    // Shadows (2)
    ("shadow-1", TokenType::Shadow),
    ("shadow-2", TokenType::Shadow),
    // Motion (4)
    ("duration-fast", TokenType::Duration),
    ("duration-base", TokenType::Duration),
    ("duration-slow", TokenType::Duration),
    ("ease-out", TokenType::Easing),
    // File types (9)
    ("ft-md", TokenType::Color),
    ("ft-html", TokenType::Color),
    ("ft-pdf", TokenType::Color),
    ("ft-img", TokenType::Color),
    ("ft-video", TokenType::Color),
    ("ft-audio", TokenType::Color),
    ("ft-3d", TokenType::Color),
    ("ft-code", TokenType::Color),
    ("ft-folder", TokenType::Color),
    // Find matches (3)
    ("color-find-match", TokenType::Color),
    ("color-find-current", TokenType::Color),
    ("color-find-current-text", TokenType::Color),
];

/// A resolved theme, as sent to the front end (`get_theme`, `theme_changed`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ResolvedTheme {
    /// The theme in effect: its file stem, or `"default"` when the Default is
    /// used as a whole (no theme chosen, not found, unreadable).
    pub name: String,
    /// Every token, light values.
    pub light: BTreeMap<&'static str, String>,
    /// Every token, dark values.
    pub dark: BTreeMap<&'static str, String>,
    /// Shiki theme names `(light, dark)`.
    pub code: (String, String),
    /// English; the broken values of one resolve are gathered into one entry.
    pub warnings: Vec<String>,
}

/// The values of a theme without its name and warnings.
#[derive(Clone, Debug)]
struct Values {
    light: BTreeMap<&'static str, String>,
    dark: BTreeMap<&'static str, String>,
    code: (String, String),
}

impl Values {
    fn into_resolved(self, name: &str, warnings: Vec<String>) -> ResolvedTheme {
        ResolvedTheme {
            name: name.to_string(),
            light: self.light,
            dark: self.dark,
            code: self.code,
            warnings,
        }
    }
}

/// The Default theme's values: `themes/default.json` passed through the same
/// layering as a user theme, on top of nothing.
fn builtin() -> &'static Values {
    static BUILTIN: OnceLock<Values> = OnceLock::new();
    BUILTIN.get_or_init(|| {
        let empty = Values {
            light: BTreeMap::new(),
            dark: BTreeMap::new(),
            code: (String::new(), String::new()),
        };
        match parse_theme_object(DEFAULT_THEME_JSON) {
            Ok(object) => {
                let layered = layer(&empty, &object);
                for problem in &layered.problems {
                    tracing::error!("themes/default.json: {problem}");
                }
                layered.values
            }
            Err(reason) => {
                tracing::error!("themes/default.json {reason}");
                empty
            }
        }
    })
}

/// Resolve the theme in effect (§5.2). `settings_text` is the content of
/// `settings.json` (`None` when there is none); `read_theme` maps a theme name
/// to the content of `themes/<name>.json` (`None` when there is none). Pure:
/// no file system, no app handle. Never panics, never fails.
pub fn resolve_theme(
    settings_text: Option<&str>,
    read_theme: impl Fn(&str) -> Option<String>,
) -> ResolvedTheme {
    let mut warnings = Vec::new();
    let default = || builtin().clone();
    let Some(name) = selected_theme(settings_text, &mut warnings) else {
        return default().into_resolved(DEFAULT_THEME_NAME, warnings);
    };
    let Some(text) = read_theme(&name) else {
        warnings.push(format!(
            "Theme \"{name}\" was not found in ~/.config/vellis/themes; using Default"
        ));
        return default().into_resolved(DEFAULT_THEME_NAME, warnings);
    };
    let object = match parse_theme_object(&text) {
        Ok(object) => object,
        Err(reason) => {
            warnings.push(format!("Theme \"{name}\" {reason}; using Default"));
            return default().into_resolved(DEFAULT_THEME_NAME, warnings);
        }
    };
    let layered = layer(builtin(), &object);
    if let Some(version) = layered.unknown_version {
        warnings.push(format!(
            "Theme \"{name}\" has version {version}; this Vellis understands version {THEME_VERSION}"
        ));
    }
    if !layered.problems.is_empty() {
        warnings.push(format!(
            "Theme \"{name}\" has values Vellis cannot use; using Default for: {}",
            layered.problems.join(", ")
        ));
    }
    layered.values.into_resolved(&name, warnings)
}

/// The theme `settings.json` chooses: `None` for the built-in Default (no
/// file, a broken file — its warning belongs to the exclude lists — no key,
/// `"default"`, or a value that is not a usable name, with a warning).
fn selected_theme(settings_text: Option<&str>, warnings: &mut Vec<String>) -> Option<String> {
    let text = settings_text?;
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(text) else {
        return None;
    };
    let name = match settings::appearance_theme_of(&object) {
        Ok(name) => name,
        Err(warning) => {
            warnings.push(warning);
            return None;
        }
    };
    if name.eq_ignore_ascii_case(DEFAULT_THEME_NAME) {
        return None;
    }
    if !is_theme_name(&name) {
        warnings.push(format!(
            "Settings file has errors; {name:?} is not a theme name (the value of {} names a file in ~/.config/vellis/themes); using Default",
            settings::APPEARANCE_THEME_KEY
        ));
        return None;
    }
    Some(name)
}

/// A theme file's top-level object, or why there is none.
fn parse_theme_object(text: &str) -> Result<Map<String, Value>, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(object)) => Ok(object),
        Ok(_) => Err("must be a JSON object".to_string()),
        Err(e) => Err(format!("is not valid JSON ({e})")),
    }
}

/// The outcome of laying one theme file over a base.
struct Layered {
    values: Values,
    /// `"light.color-accent (not a color)"`, … — the values left at the base.
    problems: Vec<String>,
    /// The `version` given when it is not one this Vellis understands.
    unknown_version: Option<String>,
}

/// Lay `object` over `base` in the order of §4.1: base → `common` (both
/// modes) → `light` / `dark`. Unknown names are skipped silently; a value
/// outside its grammar keeps the base value and is reported.
fn layer(base: &Values, object: &Map<String, Value>) -> Layered {
    let mut values = base.clone();
    let mut problems = Vec::new();

    let unknown_version = match object.get("version") {
        None => None,
        Some(v)
            if v.as_u64() == Some(THEME_VERSION) || v.as_f64() == Some(THEME_VERSION as f64) =>
        {
            None
        }
        Some(v) => Some(v.to_string()),
    };

    for (token, value) in valid_entries(object, "common", &mut problems) {
        values.light.insert(token, value.clone());
        values.dark.insert(token, value);
    }
    for (token, value) in valid_entries(object, "light", &mut problems) {
        values.light.insert(token, value);
    }
    for (token, value) in valid_entries(object, "dark", &mut problems) {
        values.dark.insert(token, value);
    }

    match object.get("code") {
        None => {}
        Some(Value::Object(code)) => {
            for (slot, target) in [("light", &mut values.code.0), ("dark", &mut values.code.1)] {
                match code.get(slot) {
                    None => {}
                    Some(Value::String(name)) if is_code_theme_name(name) => *target = name.clone(),
                    Some(_) => problems.push(format!("code.{slot} (not a Shiki theme name)")),
                }
            }
        }
        Some(_) => problems.push("code (must be an object)".to_string()),
    }

    Layered {
        values,
        problems,
        unknown_version,
    }
}

/// The usable `(token, value)` pairs of the block `block` of a theme file.
fn valid_entries(
    object: &Map<String, Value>,
    block: &str,
    problems: &mut Vec<String>,
) -> Vec<(&'static str, String)> {
    let entries = match object.get(block) {
        None => return Vec::new(),
        Some(Value::Object(entries)) => entries,
        Some(_) => {
            problems.push(format!("{block} (must be an object)"));
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    for (key, value) in entries {
        let Some(&(token, ty)) = TOKENS.iter().find(|(name, _)| name == key) else {
            continue;
        };
        match value {
            Value::String(text) => match validate(ty, text) {
                Ok(value) => out.push((token, value)),
                Err(reason) => problems.push(format!("{block}.{key} ({reason})")),
            },
            _ => problems.push(format!("{block}.{key} (must be a string)")),
        }
    }
    out
}

/// Check one value (§3.2): the rules shared by every type, then its type's
/// grammar. The accepted value is trimmed.
fn validate(ty: TokenType, raw: &str) -> Result<String, &'static str> {
    if raw.chars().count() > MAX_VALUE_CHARS {
        return Err("longer than 256 characters");
    }
    if has_forbidden(raw) {
        return Err("contains characters a theme cannot use");
    }
    let value = raw.trim();
    if ty.accepts(value) {
        Ok(value.to_string())
    } else {
        Err(ty.expected())
    }
}

/// The rules shared by every type: no control character, none of
/// `; { } < > \ @`, no comment, no `url(` / `var(` / `env(` / `attr(` /
/// `expression(`, no `!important`.
fn has_forbidden(value: &str) -> bool {
    if value
        .chars()
        .any(|c| c.is_ascii_control() || matches!(c, ';' | '{' | '}' | '<' | '>' | '\\' | '@'))
    {
        return true;
    }
    let lower = value.to_ascii_lowercase();
    let squeezed: String = lower.chars().filter(|c| !c.is_whitespace()).collect();
    ["/*", "*/", "url(", "var(", "env(", "attr(", "expression("]
        .iter()
        .any(|needle| lower.contains(needle))
        || squeezed.contains("!important")
}

/// An unsigned decimal: `12`, `1.5`, `.06`.
fn parse_number(s: &str) -> Option<f64> {
    let (int, frac) = match s.split_once('.') {
        Some((int, frac)) => (int, Some(frac)),
        None => (s, None),
    };
    let digits = |part: &str| part.chars().all(|c| c.is_ascii_digit());
    let ok = digits(int)
        && match frac {
            Some(frac) => !frac.is_empty() && digits(frac),
            None => !int.is_empty(),
        };
    if ok {
        s.parse().ok()
    } else {
        None
    }
}

/// A number with an optional leading `-` (only where CSS needs one).
fn parse_signed_number(s: &str) -> Option<f64> {
    match s.strip_prefix('-') {
        Some(rest) => parse_number(rest).map(|n| -n),
        None => parse_number(s),
    }
}

/// `0`, or a number with `px` / `em` / `rem` / `ch`.
fn is_length(s: &str) -> bool {
    if s == "0" {
        return true;
    }
    let Some(at) = s.find(|c: char| c.is_ascii_alphabetic()) else {
        return false;
    };
    let (number, unit) = s.split_at(at);
    parse_number(number).is_some() && matches!(unit, "px" | "em" | "rem" | "ch")
}

/// `0`, or a number with `ms` / `s`.
fn is_duration(s: &str) -> bool {
    if s == "0" {
        return true;
    }
    let number = s.strip_suffix("ms").or_else(|| s.strip_suffix('s'));
    number.and_then(parse_number).is_some()
}

/// `normal`, `bold`, or a whole number from 100 to 900.
fn is_font_weight(s: &str) -> bool {
    matches!(s, "normal" | "bold")
        || (!s.is_empty()
            && s.chars().all(|c| c.is_ascii_digit())
            && s.parse::<u32>().is_ok_and(|n| (100..=900).contains(&n)))
}

/// A keyword easing, or `cubic-bezier(x1, y1, x2, y2)` with x in 0..=1.
fn is_easing(s: &str) -> bool {
    if matches!(
        s,
        "ease" | "ease-in" | "ease-out" | "ease-in-out" | "linear"
    ) {
        return true;
    }
    let Some(inner) = function_args(s, &["cubic-bezier"]) else {
        return false;
    };
    let numbers: Vec<Option<f64>> = inner
        .split(',')
        .map(|n| parse_signed_number(n.trim()))
        .collect();
    match numbers.as_slice() {
        [Some(x1), Some(_), Some(x2), Some(_)] => {
            (0.0..=1.0).contains(x1) && (0.0..=1.0).contains(x2)
        }
        _ => false,
    }
}

/// `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`, `rgb()` / `rgba()`, `hsl()` /
/// `hsla()`, or `transparent`. Named colours and newer functions are not
/// accepted (§3.2).
fn is_color(s: &str) -> bool {
    if s.eq_ignore_ascii_case("transparent") {
        return true;
    }
    if let Some(hex) = s.strip_prefix('#') {
        return matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit());
    }
    let lower = s.to_ascii_lowercase();
    if let Some(inner) = function_args(&lower, &["rgba", "rgb"]) {
        return color_args(inner).is_some_and(|(channels, alpha)| {
            channels.iter().all(|c| is_rgb_channel(c)) && alpha.is_none_or(is_alpha)
        });
    }
    if let Some(inner) = function_args(&lower, &["hsla", "hsl"]) {
        return color_args(inner).is_some_and(|(channels, alpha)| {
            is_hue(channels[0])
                && channels[1..].iter().all(|c| is_percentage(c))
                && alpha.is_none_or(is_alpha)
        });
    }
    false
}

/// The arguments between `name(` and the final `)` for the first matching name.
fn function_args<'a>(s: &'a str, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|name| s.strip_prefix(name)?.strip_prefix('(')?.strip_suffix(')'))
}

/// The three channels and the optional alpha of a colour function, written
/// with commas (`1, 2, 3, .5`) or with spaces (`1 2 3 / .5`).
fn color_args(inner: &str) -> Option<(Vec<&str>, Option<&str>)> {
    let inner = inner.trim();
    if inner.contains(',') {
        let parts: Vec<&str> = inner.split(',').map(str::trim).collect();
        return match parts.len() {
            3 => Some((parts, None)),
            4 => Some((parts[..3].to_vec(), Some(parts[3]))),
            _ => None,
        };
    }
    let (channels, alpha) = match inner.split_once('/') {
        Some((channels, alpha)) => (channels, Some(alpha.trim())),
        None => (inner, None),
    };
    let channels: Vec<&str> = channels.split_whitespace().collect();
    (channels.len() == 3).then_some((channels, alpha))
}

fn is_percentage(s: &str) -> bool {
    s.strip_suffix('%')
        .and_then(parse_number)
        .is_some_and(|n| n <= 100.0)
}

fn is_rgb_channel(s: &str) -> bool {
    is_percentage(s) || parse_number(s).is_some_and(|n| n <= 255.0)
}

fn is_alpha(s: &str) -> bool {
    is_percentage(s) || parse_number(s).is_some_and(|n| n <= 1.0)
}

fn is_hue(s: &str) -> bool {
    parse_signed_number(s.strip_suffix("deg").unwrap_or(s)).is_some()
}

/// `none`, or shadows separated by commas: each an optional `inset`, two to
/// four lengths in a row and one colour.
fn is_shadow(s: &str) -> bool {
    if s == "none" {
        return true;
    }
    split_top_level(s, |c| c == ',').iter().all(|shadow| {
        let mut insets = 0;
        let mut colors = 0;
        let mut lengths = 0;
        let mut lengths_done = false;
        for part in split_top_level(shadow, char::is_whitespace) {
            if is_length(part) {
                if lengths_done {
                    return false;
                }
                lengths += 1;
                continue;
            }
            if lengths > 0 {
                lengths_done = true;
            }
            if part == "inset" {
                insets += 1;
            } else if is_color(part) {
                colors += 1;
            } else {
                return false;
            }
        }
        insets <= 1 && colors == 1 && (2..=4).contains(&lengths)
    })
}

/// The non-empty pieces of `s` between the separators found outside
/// parentheses.
fn split_top_level(s: &str, is_separator: impl Fn(char) -> bool) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0usize;
    let mut start = 0;
    for (at, c) in s.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            c if depth == 0 && is_separator(c) => {
                parts.push(&s[start..at]);
                start = at + c.len_utf8();
            }
            _ => {}
        }
    }
    parts.push(&s[start..]);
    parts
        .into_iter()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect()
}

/// One or more font families separated by commas: a quoted name, or words of
/// letters, digits, `-` and `_`.
fn is_font_family(s: &str) -> bool {
    let mut rest = s.trim();
    if rest.is_empty() {
        return false;
    }
    loop {
        let family;
        if let Some(quote) = rest.chars().next().filter(|c| *c == '"' || *c == '\'') {
            let Some(end) = rest[1..].find(quote) else {
                return false;
            };
            family = &rest[1..=end];
            rest = rest[end + 2..].trim_start();
            if family.trim().is_empty() {
                return false;
            }
        } else {
            let end = rest.find(',').unwrap_or(rest.len());
            family = rest[..end].trim();
            rest = &rest[end..];
            if family.is_empty()
                || !family
                    .chars()
                    .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | ' '))
            {
                return false;
            }
        }
        if rest.is_empty() {
            return true;
        }
        match rest.strip_prefix(',') {
            Some(next) => rest = next.trim_start(),
            None => return false,
        }
        if rest.is_empty() {
            return false;
        }
    }
}

/// A Shiki theme name as far as Rust checks it (`^[a-z0-9][a-z0-9-]*$`);
/// whether Shiki bundles it is checked by the front end (theme-architecture (o)).
fn is_code_theme_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A theme name = a file stem of `themes/` (`^[A-Za-z0-9][A-Za-z0-9._-]*$`,
/// so never a path).
fn is_theme_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// The theme list of View ▸ Appearance from the file names of `themes/`: the
/// stems of the `*.json` files, in name order. `default.json` is reserved for
/// the built-in theme: left out, with a warning. Returns `(names, warnings)`.
pub fn list_theme_names(file_names: &[&str]) -> (Vec<String>, Vec<String>) {
    let mut names = BTreeSet::new();
    let mut warnings = Vec::new();
    for file in file_names {
        let Some(stem) = file.strip_suffix(".json") else {
            continue;
        };
        if stem.eq_ignore_ascii_case(DEFAULT_THEME_NAME) {
            warnings.push(format!(
                "{THEMES_DIR}/{file} is ignored: \"{DEFAULT_THEME_NAME}\" is the name of the built-in theme"
            ));
        } else if is_theme_name(stem) {
            names.insert(stem.to_string());
        }
    }
    let mut names: Vec<String> = names.into_iter().collect();
    names.sort_by(|a, b| {
        a.to_lowercase()
            .cmp(&b.to_lowercase())
            .then_with(|| a.cmp(b))
    });
    (names, warnings)
}

/// `settings_text` with `appearance.theme` set to `name` and nothing else
/// changed: the other keys keep their order (`preserve_order`), a missing key
/// is added first (where the template of Settings… has it), the output is
/// `to_string_pretty`. A file that is not a JSON object is an `Err` — it is
/// never rewritten (要件#65 契約8).
pub fn replace_appearance_theme(settings_text: &str, name: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(settings_text).map_err(|e| {
        format!("Settings file is not valid JSON ({e}); fix it before choosing a theme")
    })?;
    let Value::Object(mut object) = value else {
        return Err(
            "Settings file must be a JSON object; fix it before choosing a theme".to_string(),
        );
    };
    let chosen = Value::String(name.to_string());
    let object = match object.get_mut(settings::APPEARANCE_THEME_KEY) {
        Some(slot) => {
            *slot = chosen;
            object
        }
        None => {
            let mut first = Map::new();
            first.insert(settings::APPEARANCE_THEME_KEY.to_string(), chosen);
            first.extend(object);
            first
        }
    };
    let mut text = serde_json::to_string_pretty(&Value::Object(object))
        .map_err(|e| format!("Settings file could not be written ({e})"))?;
    text.push('\n');
    Ok(text)
}

/// [`replace_appearance_theme`] on the file at `path`. A missing file is
/// created with its folders, holding the template of Settings… with
/// `appearance.theme` = `name`. A broken file is an `Err` and stays byte for
/// byte as it was.
pub fn set_appearance_theme(path: &Path, name: &str) -> Result<(), String> {
    if std::fs::symlink_metadata(path).is_err() {
        let text = replace_appearance_theme(&settings::default_settings_json(), name)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Settings folder could not be created ({e})"))?;
        }
        // `create_new` so a file that appeared in the meantime is never overwritten.
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(mut file) => {
                return file
                    .write_all(text.as_bytes())
                    .map_err(|e| format!("Settings file could not be written ({e})"));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(format!("Settings file could not be written ({e})")),
        }
    }
    let current = std::fs::read_to_string(path)
        .map_err(|e| format!("Settings file could not be read ({e})"))?;
    let text = replace_appearance_theme(&current, name)?;
    std::fs::write(path, text).map_err(|e| format!("Settings file could not be written ({e})"))
}

// ---------------------------------------------------------------------------
// Export Default Theme… (requirements.md #56 AC-56-23・theme-architecture (e))
// ---------------------------------------------------------------------------

/// The file name Export Default Theme… writes, given the file names already in
/// `themes/`: `my-theme.json`, else the first free `my-theme-<n>.json` from 2
/// up. Names are compared without regard to case (the macOS file system, as
/// the reserved `default`); other extensions do not count.
pub fn export_file_name(existing: &[&str]) -> String {
    let taken: BTreeSet<String> = existing.iter().map(|name| name.to_lowercase()).collect();
    let mut n: u64 = 1;
    loop {
        let candidate = if n == 1 {
            format!("{EXPORT_THEME_STEM}.json")
        } else {
            format!("{EXPORT_THEME_STEM}-{n}.json")
        };
        if !taken.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// The text Export Default Theme… writes: the whole Default theme
/// ([`DEFAULT_THEME_JSON`]) with `meta.name` = `"My Theme"` and
/// `meta.description` = `"Exported from Vellis <version>"`, everything else as
/// it is (the keys keep their order: `preserve_order`). Pretty-printed with a
/// final newline, ready to edit.
pub fn exported_theme_json(version: &str) -> String {
    let mut value: Value =
        serde_json::from_str(DEFAULT_THEME_JSON).unwrap_or_else(|_| Value::Object(Map::new()));
    if let Value::Object(object) = &mut value {
        let meta = object
            .entry("meta")
            .or_insert_with(|| Value::Object(Map::new()));
        if let Value::Object(meta) = meta {
            meta.insert(
                "name".to_string(),
                Value::String(EXPORT_THEME_META_NAME.to_string()),
            );
            meta.insert(
                "description".to_string(),
                Value::String(format!("Exported from Vellis {version}")),
            );
        }
    }
    let mut text = serde_json::to_string_pretty(&value).unwrap_or_default();
    text.push('\n');
    text
}

/// Write [`exported_theme_json`] into `themes_dir` (created with its parents)
/// under [`export_file_name`] and return the path written. An existing file is
/// never overwritten (`create_new`): a name taken between the listing and the
/// write moves on to the next number. Every failure is an `Err`.
pub fn export_default_theme(themes_dir: &Path, version: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(themes_dir)
        .map_err(|e| format!("Theme folder could not be created ({e})"))?;
    let text = exported_theme_json(version);
    // A few rounds only for files appearing at the same moment; one is the rule.
    for _ in 0..8 {
        let existing: Vec<String> = std::fs::read_dir(themes_dir)
            .map_err(|e| format!("Theme folder could not be read ({e})"))?
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        let borrowed: Vec<&str> = existing.iter().map(String::as_str).collect();
        let path = themes_dir.join(export_file_name(&borrowed));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(text.as_bytes())
                    .map_err(|e| format!("Theme file could not be written ({e})"))?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Theme file could not be written ({e})")),
        }
    }
    Err("Theme file could not be written: no free my-theme file name".to_string())
}

// ---------------------------------------------------------------------------
// The app's theme: files, managed state, watcher (§2.2・§5.4)
// ---------------------------------------------------------------------------

/// `~/.config/vellis/` (or `$XDG_CONFIG_HOME/vellis/`): the folder of
/// `settings.json`, decided by the same function.
fn config_dir() -> Option<PathBuf> {
    settings::default_settings_path().and_then(|path| path.parent().map(Path::to_path_buf))
}

/// `~/.config/vellis/themes/` (Export Default Theme… writes there too).
pub fn themes_dir() -> Option<PathBuf> {
    config_dir().map(|dir| dir.join(THEMES_DIR))
}

/// What a resolve read: when it is the same again, nothing is resolved anew
/// (§5.3: no second dialog while the files stay as they are).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Inputs {
    settings: Option<String>,
    theme: Option<String>,
}

/// Resolve the theme from the user's files.
fn load() -> (ResolvedTheme, Inputs) {
    let settings_text =
        settings::default_settings_path().and_then(|p| std::fs::read_to_string(p).ok());
    let folder = themes_dir();
    let read = Mutex::new(None);
    let theme = resolve_theme(settings_text.as_deref(), |name| {
        let text = folder
            .as_ref()
            .and_then(|dir| std::fs::read_to_string(dir.join(format!("{name}.json"))).ok());
        if let Ok(mut slot) = read.lock() {
            slot.clone_from(&text);
        }
        text
    });
    let theme_text = read.into_inner().unwrap_or_default();
    (
        theme,
        Inputs {
            settings: settings_text,
            theme: theme_text,
        },
    )
}

/// The themes of `themes/` as View ▸ Appearance lists them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ThemeList {
    pub names: Vec<String>,
    pub warnings: Vec<String>,
}

/// List `~/.config/vellis/themes/` (empty when there is no such folder).
pub fn installed_themes() -> ThemeList {
    let files: Vec<String> = themes_dir()
        .and_then(|dir| std::fs::read_dir(dir).ok())
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_file())
                .filter_map(|entry| entry.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default();
    let borrowed: Vec<&str> = files.iter().map(String::as_str).collect();
    let (names, warnings) = list_theme_names(&borrowed);
    ThemeList { names, warnings }
}

/// The app's theme (managed state): one for the whole app, as `settings.json`
/// is (§2.3). `get_theme` reads it; the watcher replaces it.
pub struct ThemeState {
    current: Mutex<ResolvedTheme>,
    /// What the startup resolve read, handed to the watcher once.
    startup: Mutex<Option<Inputs>>,
    /// Wakes the watcher up (`poke_watcher`).
    poke: Mutex<Option<mpsc::Sender<()>>>,
}

impl ThemeState {
    /// Resolve the theme from the user's files. Warnings are logged here (also
    /// for `--self-check`) and shown by [`start`].
    pub fn load() -> Self {
        let (theme, inputs) = load();
        for warning in &theme.warnings {
            tracing::warn!("{warning}");
        }
        Self {
            current: Mutex::new(theme),
            startup: Mutex::new(Some(inputs)),
            poke: Mutex::new(None),
        }
    }

    /// The resolved theme now in effect.
    pub fn current(&self) -> ResolvedTheme {
        self.current
            .lock()
            .map(|theme| theme.clone())
            .unwrap_or_else(|e| e.into_inner().clone())
    }

    /// Put `theme` in effect; whether it differs from the one before.
    fn replace(&self, theme: &ResolvedTheme) -> bool {
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        if *current == *theme {
            return false;
        }
        *current = theme.clone();
        true
    }
}

/// Show `warnings` in one dialog (§5.3: English, one per resolve, from Rust
/// so N windows do not mean N dialogs). Logging is the caller's.
fn show_warnings(app: &AppHandle<Wry>, warnings: &[String]) {
    if warnings.is_empty() {
        return;
    }
    app.dialog()
        .message(warnings.join("\n\n"))
        .title(DIALOG_TITLE)
        .kind(MessageDialogKind::Warning)
        .show(|_| {});
}

/// After `setup`: show what the startup resolve found wrong (§5.3: at startup
/// too) and start watching `~/.config/vellis/` and its `themes/`. Not for
/// `vellis --self-check`, which neither shows dialogs nor keeps watching.
pub fn start(app: &AppHandle<Wry>) {
    let Some(state) = app.try_state::<ThemeState>() else {
        return;
    };
    let theme = state.current();
    let list = installed_themes();
    for warning in &list.warnings {
        tracing::warn!("{warning}");
    }
    let warnings: Vec<String> = theme
        .warnings
        .iter()
        .chain(&list.warnings)
        .cloned()
        .collect();
    show_warnings(app, &warnings);
    let inputs = state
        .startup
        .lock()
        .ok()
        .and_then(|mut startup| startup.take())
        .unwrap_or_default();
    let sender = spawn_watcher(app.clone(), Snapshot { inputs, list });
    let mut poke = state.poke.lock().unwrap_or_else(|e| e.into_inner());
    *poke = Some(sender);
}

/// Ask the watcher to look at the files again now — after View ▸ Appearance
/// wrote `settings.json`, in case its folder did not exist when watching began.
/// The watcher is still the one that broadcasts (one route, §2.2).
pub fn poke_watcher(app: &AppHandle<Wry>) {
    let Some(state) = app.try_state::<ThemeState>() else {
        return;
    };
    let sender = state.poke.lock().ok().and_then(|poke| poke.clone());
    if let Some(sender) = sender {
        let _ = sender.send(());
    }
}

/// What the watcher last acted on.
struct Snapshot {
    inputs: Inputs,
    list: ThemeList,
}

/// The folders to watch now: `~/.config/vellis/` and its `themes/` when they
/// exist; while the config folder does not, the folder it will appear in.
fn folders_to_watch() -> Vec<PathBuf> {
    let Some(config) = config_dir() else {
        return Vec::new();
    };
    if config.is_dir() {
        let themes = config.join(THEMES_DIR);
        return if themes.is_dir() {
            vec![config, themes]
        } else {
            vec![config]
        };
    }
    config
        .parent()
        .filter(|parent| parent.is_dir())
        .map(|p| vec![p.to_path_buf()])
        .unwrap_or_default()
}

/// Watch the folders [`folders_to_watch`] names, dropping the ones it no
/// longer names. `watched` holds the folders a watch succeeded on.
fn rewatch(watcher: &mut impl Watcher, watched: &mut Vec<PathBuf>) {
    let wanted = folders_to_watch();
    watched.retain(|folder| {
        if wanted.contains(folder) {
            return true;
        }
        let _ = watcher.unwatch(folder);
        false
    });
    for folder in wanted {
        if watched.contains(&folder) {
            continue;
        }
        match watcher.watch(&folder, RecursiveMode::NonRecursive) {
            Ok(()) => watched.push(folder),
            Err(e) => tracing::warn!("theme: cannot watch {}: {e}", folder.display()),
        }
    }
}

/// One watcher for the app (not per window, not in `watch::hub`): any event
/// in the two folders — or a poke — is debounced, then the theme is resolved
/// again and broadcast when it changed, and the Appearance list is rebuilt
/// when the set of theme files changed. The events are not inspected: an
/// atomic save, a rename or an editor's temporary file all end the same way.
/// Keeps running while the app lives, with no window open too.
fn spawn_watcher(app: AppHandle<Wry>, mut last: Snapshot) -> mpsc::Sender<()> {
    let (sender, receiver) = mpsc::channel::<()>();
    let events = sender.clone();
    let watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        if result.is_ok() {
            let _ = events.send(());
        }
    });
    let mut watcher = match watcher {
        Ok(watcher) => Some(watcher),
        Err(e) => {
            tracing::warn!("theme: cannot start the watcher: {e}");
            None
        }
    };
    let spawned = std::thread::Builder::new()
        .name("vellis-theme-watch".into())
        .spawn(move || {
            let mut watched = Vec::new();
            if let Some(watcher) = watcher.as_mut() {
                rewatch(watcher, &mut watched);
            }
            while receiver.recv().is_ok() {
                while receiver.recv_timeout(DEBOUNCE).is_ok() {}
                if let Some(watcher) = watcher.as_mut() {
                    rewatch(watcher, &mut watched);
                }
                last = reconcile(&app, last);
            }
        });
    if let Err(e) = spawned {
        tracing::warn!("theme: cannot start the watcher thread: {e}");
    }
    sender
}

/// Resolve again after a change: broadcast the theme when it differs from
/// the one in effect, warn when the files read changed and are broken, and
/// rebuild the Appearance list when the theme files changed.
fn reconcile(app: &AppHandle<Wry>, last: Snapshot) -> Snapshot {
    let (theme, inputs) = load();
    let list = installed_themes();
    let mut warnings = Vec::new();
    if inputs != last.inputs {
        warnings.extend(theme.warnings.iter().cloned());
        let changed = app
            .try_state::<ThemeState>()
            .is_some_and(|state| state.replace(&theme));
        if changed {
            if let Err(e) = app.emit(THEME_CHANGED_EVENT, &theme) {
                tracing::warn!("{THEME_CHANGED_EVENT} emit failed: {e}");
            }
        }
    }
    if list.names != last.list.names {
        crate::menu::rebuild_theme_items(app, &list.names);
    }
    if list.warnings != last.list.warnings {
        warnings.extend(list.warnings.iter().cloned());
    }
    for warning in &warnings {
        tracing::warn!("{warning}");
    }
    show_warnings(app, &warnings);
    Snapshot { inputs, list }
}
