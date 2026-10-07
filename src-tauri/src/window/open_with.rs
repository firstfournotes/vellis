//! Finder's "Open With" (requirements.md #68).
//!
//! macOS hands the files to open over as `RunEvent::Opened { urls }`. The
//! wiring is in `lib.rs`; what lives here is the part that needs no running
//! app: turning the URLs into the URIs the CLI would have produced
//! ([`opened_file_uris`]), deciding which of them the initial window takes
//! ([`plan_initial_open`]), and holding on to the ones that arrive before
//! `setup` ([`PendingOpens`]). Opening itself goes the CLI's `OpenPath` road
//! (`ipc::handler::dispatch_command`) — no window is built here (契約4).

use std::sync::Mutex;

use super::manager::{uri_looks_like_dir, WindowArgs};

/// The `file://` URIs to open for the URLs macOS handed over (契約3・4).
///
/// Same form as `vellis <path>` (`resolve_path_to_uri` in `main.rs`): the
/// percent-encoding is decoded and the path canonicalized (kept as is when it
/// cannot be). Other schemes and folders are dropped silently (起案時判断 (e));
/// a missing file is kept and left to the window's own error, like
/// `vellis <missing>`. The order is kept.
pub fn opened_file_uris(urls: &[tauri::Url]) -> Vec<String> {
    urls.iter()
        .filter(|url| url.scheme() == "file")
        .filter_map(|url| url.to_file_path().ok())
        .map(|path| {
            let canonical = path.canonicalize().unwrap_or(path);
            format!("file://{}", canonical.display())
        })
        .filter(|uri| !uri_looks_like_dir(uri))
        .collect()
}

/// Split the files opened before `setup` between the initial window and new
/// windows: `(initial window's arguments, URIs for new windows)` (契約3・5).
///
/// An argument-less initial window (launched from Finder) takes the first
/// file, the way `vellis <file>` would have built it, so no empty history
/// picker is left behind (オーケストレーター判断 (h)); the sidebar flags are
/// kept. A window the CLI gave a path or root to is left alone and every file
/// goes to a new window.
pub fn plan_initial_open(initial: WindowArgs, opened: Vec<String>) -> (WindowArgs, Vec<String>) {
    if !initial.needs_root_selection() || opened.is_empty() {
        return (initial, opened);
    }
    let mut opened = opened.into_iter();
    let first = opened.next().expect("checked non-empty above");
    let args = WindowArgs {
        show_marks: initial.show_marks,
        show_changed: initial.show_changed,
        ..WindowArgs::for_open_target(&first)
    };
    (args, opened.collect())
}

/// Files opened before `setup`, kept until the initial window is planned
/// (契約3).
///
/// When Vellis is launched to open a file, the first `Opened` arrives before
/// `setup` — there is no initial window and no IPC server yet. Until
/// [`take_at_setup`](Self::take_at_setup) the URIs are buffered; after it
/// they pass straight through.
#[derive(Default)]
pub struct PendingOpens {
    state: Mutex<Pending>,
}

#[derive(Default)]
struct Pending {
    after_setup: bool,
    buffered: Vec<String>,
}

impl PendingOpens {
    /// The URIs to open now: none before `setup` (they are buffered), all of
    /// them after it.
    pub fn receive(&self, uris: Vec<String>) -> Vec<String> {
        let mut pending = self.lock();
        if pending.after_setup {
            uris
        } else {
            pending.buffered.extend(uris);
            Vec::new()
        }
    }

    /// Everything buffered so far, in arrival order; from here on
    /// [`receive`](Self::receive) passes through.
    pub fn take_at_setup(&self) -> Vec<String> {
        let mut pending = self.lock();
        pending.after_setup = true;
        std::mem::take(&mut pending.buffered)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Pending> {
        // Nothing here can leave the buffer half-written, so a poisoned lock
        // is still good to use.
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}
