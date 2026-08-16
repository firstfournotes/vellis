//! Window title derivation (requirements.md #17).
//!
//! The macOS Window menu lists open windows by their title, so a fixed
//! "vellis" on every window makes the list useless. The title is the root
//! folder's name instead.

/// Title used when a window has no root — the history picker screen
/// (requirements.md #4) — and when a root has no folder name of its own
/// (`/`, `ssh://host/`).
const APP_NAME: &str = "vellis";

/// Derive a window title from a root URI (or bare local path).
///
/// `None` (no root yet) yields the app name. Otherwise the title is the last
/// path segment: the same rule for local and `ssh://` roots, so the authority
/// (`user@host:port`) never reaches the title. A trailing slash is ignored and
/// dots in the folder name are kept verbatim — these are directory names, not
/// files, so there is no extension to strip.
///
/// Parsing is done on the string rather than through [`crate::fs::uri::Uri`]:
/// `Uri::parse` canonicalizes bare paths against the filesystem, which a title
/// must not depend on.
pub fn derive_window_title(root: Option<&str>) -> String {
    let Some(root) = root else {
        return APP_NAME.to_string();
    };

    let path = match root.split_once("://") {
        // `file://` carries no authority — everything after it is the path.
        Some(("file", rest)) => rest,
        // Any other scheme (`ssh://`) puts the authority first; skip to the
        // path so `user@host:2222` cannot leak into the title.
        Some((_, rest)) => rest.find('/').map_or("", |i| &rest[i..]),
        None => root,
    };

    match path.trim_end_matches('/').rsplit('/').next() {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => APP_NAME.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_root_string_is_not_an_empty_title() {
        assert_eq!(derive_window_title(Some("")), APP_NAME);
    }

    #[test]
    fn relative_path_uses_its_last_segment() {
        assert_eq!(derive_window_title(Some("docs/notes")), "notes");
    }
}
