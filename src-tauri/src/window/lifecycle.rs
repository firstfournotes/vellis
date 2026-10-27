//! When the app ends (requirements.md #12 追補a).
//!
//! The wiring is in `lib.rs` (`on_window_event`'s `WindowEvent::Destroyed`);
//! what lives here is the decision, which needs no running app.

/// Whether the app should exit once a window has been destroyed
/// (要件#12 追補a 契約2・要件#38 追補m 契約2).
///
/// - `document_windows`: the document windows still registered in the
///   `WindowManager` after the destroyed one was taken out.
/// - `print_windows`: the print windows still open
///   ([`crate::print::is_print_window`] labels), the destroyed one left out.
///
/// `true` only when both are 0: a print window still open keeps the app
/// alive, so closing the last document window mid-print does not end it.
pub fn should_exit_after_destroy(document_windows: usize, print_windows: usize) -> bool {
    document_windows == 0 && print_windows == 0
}
