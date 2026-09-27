//! The user's settings file (requirements.md #65 契約4〜8).
//!
//! `~/.config/vellis/settings.json` (or `$XDG_CONFIG_HOME/vellis/settings.json`)
//! holds the two exclude lists, written the way VS Code / Cursor write them:
//!
//! - `files.exclude`  — hidden from the tree **and** the search
//! - `search.exclude` — left out of the search only (on top of `files.exclude`)
//!
//! Each is a dictionary "glob pattern → true / false". A key that is present
//! replaces its default entirely; a missing key keeps the default. The defaults
//! reproduce the exclusions that used to be hard-coded (the dot-name skip in
//! `list` and `search::EXCLUDED_DIR_NAMES`), so an untouched setup looks the
//! same as before.
//!
//! The folder is the one `cli_fix::default_config_path` uses for `agents.toml`:
//! "settings a person edits" live under `~/.config/vellis/`, "state the app
//! manages" under the app config dir (`history.rs`).
//!
//! Reading never fails: a broken file (or a broken key, or a broken line) falls
//! back to the defaults for the broken part and reports English warnings. Only
//! a save from inside Vellis shows them to the user (契約8); every other read
//! only logs them.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::search::EXCLUDED_DIR_NAMES;

/// File name of the settings file (next to `agents.toml`).
pub const SETTINGS_FILENAME: &str = "settings.json";
/// Key of the list hidden from the tree and the search.
pub const FILES_EXCLUDE_KEY: &str = "files.exclude";
/// Key of the list left out of the search only.
pub const SEARCH_EXCLUDE_KEY: &str = "search.exclude";
/// Event sent to every window after Vellis saved `settings.json`
/// (契約7). Must match `SETTINGS_CHANGED_EVENT` in `src/lib/settings.ts`.
pub const SETTINGS_CHANGED_EVENT: &str = "settings_changed";

/// Folder under the config home (the same `vellis` folder as `cli_fix`).
const SETTINGS_DIR: &str = "vellis";

/// Default `files.exclude` (契約5): every dot name (the old rule of `list`),
/// plus `.git` and `.DS_Store`, which stay hidden when `**/.*` is turned off.
const DEFAULT_FILES_EXCLUDE: &[&str] = &["**/.*", "**/.git", "**/.DS_Store"];

/// What "Settings…" writes when the file is missing (契約6). The same content
/// as the example in req-65.md; it reads back as `Settings::default()` with no
/// warnings (checked by the acceptance tests, so it cannot drift from the
/// constants above).
const DEFAULT_SETTINGS_JSON: &str = r#"{
  "files.exclude": {
    "**/.*": true,
    "**/.git": true,
    "**/.DS_Store": true
  },
  "search.exclude": {
    "**/node_modules": true,
    "**/target": true,
    "**/dist": true,
    "**/build": true,
    "**/.git": true,
    "**/.svelte-kit": true
  }
}
"#;

/// One exclude list: pattern → `true` (exclude) / `false` (line turned off).
pub type ExcludeMap = BTreeMap<String, bool>;

/// The settings the app uses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settings {
    pub files_exclude: ExcludeMap,
    pub search_exclude: ExcludeMap,
}

impl Default for Settings {
    /// 契約5: `files.exclude` = [`DEFAULT_FILES_EXCLUDE`], `search.exclude` =
    /// `**/<name>` for each of [`EXCLUDED_DIR_NAMES`]. All lines are `true`.
    fn default() -> Self {
        Self {
            files_exclude: DEFAULT_FILES_EXCLUDE.iter().map(|p| (p.to_string(), true)).collect(),
            search_exclude: EXCLUDED_DIR_NAMES
                .iter()
                .map(|name| (format!("**/{name}"), true))
                .collect(),
        }
    }
}

impl Settings {
    /// The `files.exclude` patterns in effect (value `true`).
    pub fn active_files_exclude(&self) -> Vec<&str> {
        active(&self.files_exclude)
    }

    /// The `search.exclude` patterns in effect (value `true`).
    pub fn active_search_exclude(&self) -> Vec<&str> {
        active(&self.search_exclude)
    }
}

fn active(map: &ExcludeMap) -> Vec<&str> {
    map.iter().filter(|(_, on)| **on).map(|(pattern, _)| pattern.as_str()).collect()
}

/// The settings read, and what was wrong with them (English, one entry per
/// problem; empty when nothing was wrong).
#[derive(Clone, Debug)]
pub struct LoadedSettings {
    pub settings: Settings,
    pub warnings: Vec<String>,
}

impl LoadedSettings {
    fn defaults_with(warnings: Vec<String>) -> Self {
        Self { settings: Settings::default(), warnings }
    }
}

/// Read settings from `text` (契約4・8). Never panics, never errors:
///
/// - not JSON / not an object → both lists default, with a warning
/// - a key whose value is not an object → that list defaults, with a warning
/// - a line whose value is not true/false → that line is dropped, with a warning
/// - a present key replaces its default entirely; a missing key keeps it
/// - unknown keys are ignored silently
pub fn parse_settings(text: &str) -> LoadedSettings {
    let both = format!("{FILES_EXCLUDE_KEY}, {SEARCH_EXCLUDE_KEY}");
    let value: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(e) => {
            return LoadedSettings::defaults_with(vec![format!(
                "Settings file is not valid JSON ({e}); using defaults for: {both}"
            )]);
        }
    };
    let Some(object) = value.as_object() else {
        return LoadedSettings::defaults_with(vec![format!(
            "Settings file must be a JSON object; using defaults for: {both}"
        )]);
    };

    let defaults = Settings::default();
    let mut warnings = Vec::new();
    let files_exclude =
        read_exclude_map(object, FILES_EXCLUDE_KEY, defaults.files_exclude, &mut warnings);
    let search_exclude =
        read_exclude_map(object, SEARCH_EXCLUDE_KEY, defaults.search_exclude, &mut warnings);
    LoadedSettings { settings: Settings { files_exclude, search_exclude }, warnings }
}

fn read_exclude_map(
    object: &serde_json::Map<String, Value>,
    key: &str,
    default: ExcludeMap,
    warnings: &mut Vec<String>,
) -> ExcludeMap {
    match object.get(key) {
        None => default,
        Some(Value::Object(dict)) => {
            let mut map = ExcludeMap::new();
            for (pattern, value) in dict {
                match value.as_bool() {
                    Some(on) => {
                        map.insert(pattern.clone(), on);
                    }
                    None => warnings.push(format!(
                        "Settings file has errors; ignoring \"{pattern}\" in {key} (the value must be true or false)"
                    )),
                }
            }
            map
        }
        Some(_) => {
            warnings.push(format!(
                "Settings file has errors; using defaults for: {key} (the value must be an object of \"pattern\": true/false)"
            ));
            default
        }
    }
}

/// Read settings from `path`. A missing file is the defaults with no warning;
/// a file that cannot be read is the defaults with a warning.
pub fn read_settings(path: &Path) -> LoadedSettings {
    match std::fs::read_to_string(path) {
        Ok(text) => parse_settings(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => LoadedSettings::defaults_with(Vec::new()),
        Err(e) => LoadedSettings::defaults_with(vec![format!(
            "Settings file could not be read ({e}); using defaults for: {FILES_EXCLUDE_KEY}, {SEARCH_EXCLUDE_KEY}"
        )]),
    }
}

/// Read the user's settings file (defaults when there is none). Read at the
/// point of use — each listing and each search (契約7) — so every window sees
/// the latest file. Warnings are only logged here (契約8).
pub fn load_settings() -> LoadedSettings {
    let loaded = match default_settings_path() {
        Some(path) => read_settings(&path),
        None => LoadedSettings::defaults_with(Vec::new()),
    };
    for warning in &loaded.warnings {
        tracing::warn!("{warning}");
    }
    loaded
}

/// Where the settings file lives (契約4): `<xdg_config_home>/vellis/settings.json`
/// when `xdg_config_home` is set and non-empty, else
/// `<home>/.config/vellis/settings.json`; `None` without a home either.
/// The same folder and the same decision as `cli_fix::default_config_path`.
pub fn settings_path(xdg_config_home: Option<&str>, home: Option<&Path>) -> Option<PathBuf> {
    if let Some(xdg) = xdg_config_home.filter(|x| !x.is_empty()) {
        return Some(PathBuf::from(xdg).join(SETTINGS_DIR).join(SETTINGS_FILENAME));
    }
    home.map(|h| h.join(".config").join(SETTINGS_DIR).join(SETTINGS_FILENAME))
}

/// [`settings_path`] fed from `$XDG_CONFIG_HOME` and the home directory.
pub fn default_settings_path() -> Option<PathBuf> {
    let xdg = std::env::var_os("XDG_CONFIG_HOME");
    settings_path(xdg.as_deref().and_then(|x| x.to_str()), dirs::home_dir().as_deref())
}

/// Whether `path` is the user's settings file (how `save_document` tells a
/// settings save apart). Compared through `canonicalize` when both exist, so a
/// symlinked `~/.config` still matches the canonical path a save resolves to.
pub fn is_settings_file(path: &Path) -> bool {
    let Some(settings) = default_settings_path() else {
        return false;
    };
    if path == settings {
        return true;
    }
    match (std::fs::canonicalize(path), std::fs::canonicalize(&settings)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// The JSON "Settings…" writes when the file is missing: the two keys with
/// their defaults, and nothing else.
pub fn default_settings_json() -> String {
    DEFAULT_SETTINGS_JSON.to_string()
}

/// 契約6: when `path` does not exist, create its parent folders and write
/// [`default_settings_json`] (`Ok(true)`). When it exists — even broken, even
/// as a dangling symlink — leave it byte for byte as it is (`Ok(false)`).
pub fn ensure_settings_file(path: &Path) -> std::io::Result<bool> {
    if std::fs::symlink_metadata(path).is_ok() {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // `create_new` so a file that appeared in the meantime is never overwritten.
    let mut file = match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(e) => return Err(e),
    };
    file.write_all(default_settings_json().as_bytes())?;
    Ok(true)
}
