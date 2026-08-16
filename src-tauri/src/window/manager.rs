//! Window Manager — tracks window state including the active DocumentSession,
//! root URI, and initial arguments for each window.

use std::collections::HashMap;

use crate::fs::uri::Uri;
use crate::session::document::DocumentSession;
use crate::watch::dir_watch::DirWatchSet;
use crate::watch::hub::WatchSubscription;
/// Per-window state held by the manager.
pub struct WindowState<R: tauri::Runtime = tauri::Wry> {
    /// Currently open document session (owns the watch subscription via RAII).
    pub session: Option<DocumentSession<R>>,
    /// The root URI for the explorer.
    pub root_uri: Option<Uri>,
    /// RAII handle for the directory watch on `root_uri` (issue #18).
    /// `Drop` decrements the refcount in `DocumentCoordinator` so a window
    /// closing or switching root automatically tears down its directory
    /// watch. `None` while the window has not yet resolved a root.
    pub root_watch: Option<WatchSubscription<R>>,
    /// Directory watches for the subdirectories this window currently has
    /// expanded in its tree (requirements.md #18). Same RAII story as
    /// `root_watch`: dropping the `WindowState` (window closed) releases
    /// every one of them.
    pub dir_watches: DirWatchSet<R>,
    /// Initial arguments passed when the window was created.
    pub initial_args: WindowArgs,
}

/// Arguments used to initialise a window.
#[derive(Clone, Debug, Default)]
pub struct WindowArgs {
    /// Initial file path to open (if any).
    pub initial_path: Option<String>,
    /// Root directory URI string.
    pub root: Option<String>,
    /// Open the marks sidebar on startup (`vellis --marks`,
    /// `docs/ai-collab.md` §9.1).
    pub show_marks: bool,
    /// Open the marks sidebar with the drift filter active
    /// (`vellis --changed`, `docs/ai-collab.md` §9.1).  Implies
    /// `show_marks = true`.
    pub show_changed: bool,
}

impl WindowArgs {
    /// `true` when the window was created without a path or root argument —
    /// the frontend shows the history picker screen instead of a folder
    /// (requirements.md #4).  `false` means "open the given target as
    /// before" (`initial_path` and/or `root`).
    ///
    /// Sidebar flags (`--marks` / `--changed`) are not path arguments, so
    /// `vellis --marks` is still an argument-less launch.
    pub fn needs_root_selection(&self) -> bool {
        self.initial_path.is_none() && self.root.is_none()
    }

    /// Resolve `<uri>` (from `vellis <uri>` or the IPC `OpenPath` request)
    /// into the arguments for the window that will show it.
    ///
    /// - directory URI → `root = Some(uri)`, no initial document.
    /// - file URI      → `initial_path = Some(uri)`, `root = None`; the root
    ///   is derived from the parent directory by `init_window`, which is
    ///   also what records the folder in the history (requirements.md #3 —
    ///   a file URI never enters the history itself).
    ///
    /// This is the single seam both launch paths share, so the first
    /// invocation (`build_initial_args` in `main.rs`) and every later one
    /// (`ipc::handler::handle_open_path`) classify a target identically
    /// (issue #20).  Sidebar flags are left `false`; callers overlay them.
    pub fn for_open_target(uri: &str) -> WindowArgs {
        if uri_looks_like_dir(uri) {
            WindowArgs {
                root: Some(uri.to_string()),
                ..WindowArgs::default()
            }
        } else {
            WindowArgs {
                initial_path: Some(uri.to_string()),
                ..WindowArgs::default()
            }
        }
    }
}

/// True if `uri` points to (or appears to point to) a directory.
///
/// For `file://` URIs this stats the local filesystem with `Path::is_dir()`.
/// For non-local URIs (e.g. `ssh://`) — which would require opening a
/// connection to stat — fall back to a path-shape heuristic on the final
/// path segment (requirements.md #5):
///
/// - a trailing slash always means directory (`ssh://host/notes.md/`);
/// - otherwise an extension in the final segment means file — "extension"
///   in the sense of [`std::path::Path::extension`], i.e. a `.` that is
///   not the segment's first character (`notes.txt`, `.env.local` and
///   `release-2.0` are files; `repo` and `.bashrc` are directories);
/// - the scheme and authority are skipped, so a dotted host name
///   (`ssh://host.example.com/repo`) never reads as an extension.
///
/// This replaces the earlier `.md` / `.markdown` / `.mdx` whitelist, which
/// opened every other extension (`notes.txt`, `report.pdf`) as a root
/// directory.  The trade-off — a version-like final segment such as
/// `release-2.0` classifying as a file — was accepted on 2026-08-04.
///
/// Used to decide whether `<path>` in `vellis <path>` should be treated
/// as the new root or as an initial document. Both the first-launch path
/// (`build_initial_args` in `main.rs`) and the IPC `OpenPath` handler
/// (`ipc::handler::handle_open_path`) must use the same rule, otherwise
/// the second invocation against an already-running instance derives the
/// root one level higher than the first invocation does (issue #20).
/// They share it through [`WindowArgs::for_open_target`].
pub fn uri_looks_like_dir(uri: &str) -> bool {
    if let Some(local) = uri.strip_prefix("file://") {
        return std::path::Path::new(local).is_dir();
    }

    // Drop `scheme://` and the authority (`[user@]host[:port]`) so their
    // dots never count as an extension.
    let after_scheme = match uri.split_once("://") {
        Some((_, rest)) => rest,
        None => uri,
    };
    let path = match after_scheme.find('/') {
        Some(i) => &after_scheme[i..],
        // Authority only, no path at all — nothing file-shaped to point at.
        None => return true,
    };

    if path.ends_with('/') {
        return true;
    }

    let last_segment = path.rsplit('/').next().unwrap_or("");
    std::path::Path::new(last_segment).extension().is_none()
}

/// Central registry of all open windows and their state.
pub struct WindowManager<R: tauri::Runtime = tauri::Wry> {
    windows: HashMap<String, WindowState<R>>,
    /// The label of the most recently focused window.
    active_label: Option<String>,
    /// Monotonic counter for generating unique window labels.
    next_id: u64,
}

impl<R: tauri::Runtime> WindowManager<R> {
    pub fn new() -> Self {
        Self {
            windows: HashMap::new(),
            active_label: None,
            next_id: 1,
        }
    }

    /// Generate a unique window label.
    pub fn next_label(&mut self) -> String {
        let label = format!("vellis-{}", self.next_id);
        self.next_id += 1;
        label
    }

    /// Register a new window with its initial arguments.
    pub fn register_window(&mut self, label: String, args: WindowArgs) {
        self.windows.insert(
            label.clone(),
            WindowState {
                session: None,
                root_uri: None,
                root_watch: None,
                dir_watches: DirWatchSet::new(),
                initial_args: args,
            },
        );
        self.active_label = Some(label);
    }

    /// Register a window that is about to be created, returning its label.
    ///
    /// The single registration seam shared by every "open another window"
    /// trigger: the `new_window` command (Explorer / Viewer links, with a
    /// path and root) and the File ▸ New Window menu item (no arguments at
    /// all — requirements.md #12).  A label is minted with [`next_label`],
    /// then `WindowArgs { initial_path: path, root, .. }` is registered so
    /// the new window's `init_window` finds them.
    ///
    /// `path` and `root` are registered **verbatim** — nothing is derived,
    /// invented or collapsed here.  Two None's therefore register exactly
    /// what an argument-less launch registers, which is what makes
    /// [`WindowArgs::needs_root_selection`] true and sends the new window to
    /// the history picker (requirements.md #4); one Some still opens that
    /// target as before (`init_window` derives the root of a path-only
    /// window from its parent).  Sidebar flags stay off: `--marks` /
    /// `--changed` belong to the launch that asked for them, not to windows
    /// opened later.
    ///
    /// Creating the actual window (`WebviewWindowBuilder`) is the caller's
    /// job — see `commands::window::create_window`. Restoring its geometry
    /// is nobody's job here: the window-state plugin does it from its own
    /// `window_created` hook.
    ///
    /// [`next_label`]: Self::next_label
    pub fn register_new_window(&mut self, path: Option<String>, root: Option<String>) -> String {
        let label = self.next_label();
        self.register_window(
            label.clone(),
            WindowArgs {
                initial_path: path,
                root,
                show_marks: false,
                show_changed: false,
            },
        );
        label
    }

    /// Unregister a window, dropping its DocumentSession (which triggers RAII unsubscribe).
    pub fn unregister_window(&mut self, label: &str) {
        self.windows.remove(label);
        if self.active_label.as_deref() == Some(label) {
            // Pick another window as active, or None.
            self.active_label = self.windows.keys().next().cloned();
        }
    }

    /// Get a reference to the state for a window.
    pub fn get(&self, label: &str) -> Option<&WindowState<R>> {
        self.windows.get(label)
    }

    /// Get a mutable reference to the state for a window.
    pub fn get_mut(&mut self, label: &str) -> Option<&mut WindowState<R>> {
        self.windows.get_mut(label)
    }

    /// Set the active (most recently focused) window.
    pub fn set_active(&mut self, label: &str) {
        if self.windows.contains_key(label) {
            self.active_label = Some(label.to_string());
        }
    }

    /// Return the label of the currently active window.
    pub fn active_label(&self) -> Option<&str> {
        self.active_label.as_deref()
    }

    /// Return the number of tracked windows.
    pub fn window_count(&self) -> usize {
        self.windows.len()
    }

    /// Iterate over `(label, &WindowState)` pairs for all registered windows.
    /// Used by the E2E test harness (issue #22) to verify backend state
    /// from the original window when WebDriver's `getWindowHandles` is
    /// brittle for runtime-created windows.
    pub fn iter(&self) -> impl Iterator<Item = (&String, &WindowState<R>)> {
        self.windows.iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::test::MockRuntime;

    #[test]
    fn register_and_unregister() {
        let mut wm: WindowManager<MockRuntime> = WindowManager::new();
        let label = wm.next_label();
        assert_eq!(label, "vellis-1");

        wm.register_window(label.clone(), WindowArgs::default());
        assert_eq!(wm.window_count(), 1);
        assert_eq!(wm.active_label(), Some("vellis-1"));

        wm.unregister_window(&label);
        assert_eq!(wm.window_count(), 0);
        assert_eq!(wm.active_label(), None);
    }

    #[test]
    fn next_label_increments() {
        let mut wm: WindowManager<MockRuntime> = WindowManager::new();
        assert_eq!(wm.next_label(), "vellis-1");
        assert_eq!(wm.next_label(), "vellis-2");
        assert_eq!(wm.next_label(), "vellis-3");
    }

    #[test]
    fn active_window_falls_back_on_unregister() {
        let mut wm: WindowManager<MockRuntime> = WindowManager::new();
        wm.register_window("win-a".into(), WindowArgs::default());
        wm.register_window("win-b".into(), WindowArgs::default());
        // active is "win-b" (last registered)
        assert_eq!(wm.active_label(), Some("win-b"));

        wm.unregister_window("win-b");
        // Should fall back to "win-a"
        assert!(wm.active_label().is_some());
        assert_eq!(wm.window_count(), 1);
    }

    #[test]
    fn set_active_only_works_for_known_windows() {
        let mut wm: WindowManager<MockRuntime> = WindowManager::new();
        wm.register_window("win-a".into(), WindowArgs::default());
        wm.register_window("win-b".into(), WindowArgs::default());

        wm.set_active("win-a");
        assert_eq!(wm.active_label(), Some("win-a"));

        // Unknown label is ignored
        wm.set_active("win-unknown");
        assert_eq!(wm.active_label(), Some("win-a"));
    }

    #[test]
    fn get_initial_args() {
        let mut wm: WindowManager<MockRuntime> = WindowManager::new();
        wm.register_window(
            "win-1".into(),
            WindowArgs {
                initial_path: Some("/tmp/doc.md".into()),
                root: Some("/tmp".into()),
                show_marks: false,
                show_changed: false,
            },
        );
        let state = wm.get("win-1").unwrap();
        assert_eq!(
            state.initial_args.initial_path.as_deref(),
            Some("/tmp/doc.md")
        );
        assert_eq!(state.initial_args.root.as_deref(), Some("/tmp"));
    }

    #[test]
    fn uri_looks_like_dir_for_existing_local_dir() {
        let tmp = tempfile::TempDir::new().unwrap();
        let uri = format!("file://{}", tmp.path().display());
        assert!(uri_looks_like_dir(&uri));
    }

    #[test]
    fn uri_looks_like_dir_for_existing_local_file() {
        let tmp = tempfile::TempDir::new().unwrap();
        let file = tmp.path().join("readme.md");
        std::fs::write(&file, "# hi").unwrap();
        let uri = format!("file://{}", file.display());
        assert!(!uri_looks_like_dir(&uri));
    }

    #[test]
    fn uri_looks_like_dir_for_remote_markdown_path_is_file() {
        // ssh:// can't be stat'd from this side; markdown extension wins.
        assert!(!uri_looks_like_dir("ssh://host/path/to/notes.md"));
        assert!(!uri_looks_like_dir("ssh://host/A.MARKDOWN"));
        assert!(!uri_looks_like_dir("ssh://host/a/b.mdx"));
    }

    #[test]
    fn uri_looks_like_dir_for_remote_non_markdown_path_is_dir() {
        assert!(uri_looks_like_dir("ssh://host/path/to/notes/"));
        assert!(uri_looks_like_dir("ssh://host/repo"));
    }
}
