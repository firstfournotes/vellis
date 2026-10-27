//! Where a window opens (requirements.md #12 追補b, Issue #569 / #570).
//!
//! Window labels are handed out afresh every launch (`WindowManager::next_label`
//! starts again at `vellis-1`), while `tauri-plugin-window-state` remembers
//! geometry per label. A label is therefore not a window's identity: restoring
//! `vellis-2` would put a New Window wherever some other window labelled
//! `vellis-2` sat in an earlier launch (#569), and the plugin's exit-time save —
//! which walks every entry on disk and ignores its filter — could write a tab's
//! position back under such a label (#570).
//!
//! Only the first window of a launch has a stable meaning across launches, so
//! only it is restored and saved ([`tracks_window_state`]). Every later window
//! (New Window, Duplicate Window, a second CLI call) opens a little down and to
//! the right of the front window ([`new_window_position`]); a tab is left to
//! the tab bar (requirements.md #62).

use tauri::{AppHandle, Manager, Runtime};

use super::manager::WindowManager;
use super::tab::WindowKind;

/// The first window of every launch: the window `tauri.conf.json` describes
/// (no `label` there, so Tauri's default `"main"` — `lib.rs` registers it under
/// this name).
pub const FIRST_WINDOW_LABEL: &str = "main";

/// How far a new window is moved from the front window, right and down
/// (logical px).
pub const CASCADE_OFFSET: f64 = 24.0;

/// Whether the window-state plugin restores and saves the window `label`
/// (契約1): only the first window, by exact match.
///
/// `vellis-N`, print windows and tabs are all left out — a tab is an ordinary
/// numbered window, so leaving out every numbered label covers it too.
pub fn tracks_window_state(label: &str) -> bool {
    label == FIRST_WINDOW_LABEL
}

/// Where the top-left corner of a new window goes (契約2).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum NewWindowPosition {
    /// Put the top-left corner here (logical px).
    At { x: f64, y: f64 },
    /// The centre of the screen (`WebviewWindowBuilder::center()`).
    Center,
}

/// The position of a window opened in front of another (契約2): the front
/// window's top-left `(x, y)` moved by [`CASCADE_OFFSET`] both ways, or the
/// centre of the screen when there is no front window (or its position could
/// not be read).
pub fn cascade_from(front: Option<(f64, f64)>) -> NewWindowPosition {
    match front {
        Some((x, y)) => NewWindowPosition::At {
            x: x + CASCADE_OFFSET,
            y: y + CASCADE_OFFSET,
        },
        None => NewWindowPosition::Center,
    }
}

/// The position a new window of `kind` is given (契約2「タブを除く」).
///
/// A standalone window cascades from the front window ([`cascade_from`]). A tab
/// is given none: the tab bar places it (requirements.md #62), so `None` means
/// "leave the builder as it is".
pub fn new_window_position(
    kind: WindowKind,
    front: Option<(f64, f64)>,
) -> Option<NewWindowPosition> {
    match kind {
        WindowKind::Standalone => Some(cascade_from(front)),
        _ => None,
    }
}

/// The top-left corner of the front document window (requirements.md #12
/// 追補a's `active_label`), in logical px — what [`new_window_position`] takes
/// as `front`.
///
/// `outer_position` reports physical px while `WebviewWindowBuilder::position`
/// takes logical px, so the position is divided by the window's own
/// `scale_factor`. `None` when there is no active window, it is not open, or
/// either value cannot be read.
///
/// Takes the already-locked manager: the callers read this while they hold the
/// lock to register the new window, and must read it before registering — a
/// newly registered window becomes the active one.
pub fn front_window_position<R: Runtime>(
    app: &AppHandle<R>,
    wm: &WindowManager<R>,
) -> Option<(f64, f64)> {
    let window = app.get_webview_window(wm.active_label()?)?;
    let scale = window.scale_factor().ok()?;
    let position = window.outer_position().ok()?.to_logical::<f64>(scale);
    Some((position.x, position.y))
}
