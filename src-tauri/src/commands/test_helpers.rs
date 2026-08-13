//! Test-only Tauri commands used by the E2E spec harness.
//!
//! These are gated behind the `webdriver` Cargo feature, which is itself
//! a debug-only feature (the WebDriver plugin is registered behind
//! `#[cfg(all(feature = "webdriver", debug_assertions))]` in
//! `lib.rs`). They never ship in a release build.
//!
//! Why this module exists: WebDriver's `getWindowHandles` /
//! `switchToWindow` flow is brittle for windows created at runtime
//! through `WebviewWindowBuilder` (issue #22). Rather than fight the
//! WebDriver round-trip — which we don't really need to assert against
//! — the failing specs invoke `__test_list_windows` from the original
//! window via `__TAURI_INTERNALS__.invoke` and read the backend
//! `WindowManager` state directly. This is the layer the IPC OpenPath
//! and single-instance contracts actually live in (the new window's
//! Webview UI is independently covered by P1.5 / P1.11 unit tests).
//!
//! Naming: the `__test_` prefix marks these as not part of any user-
//! facing or stable API.  Do not call from production code.

use serde::Serialize;

use super::AppState;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WindowSnapshot {
    pub label: String,
    pub root: Option<String>,
    pub initial_path: Option<String>,
    pub show_marks: bool,
}

#[tauri::command]
pub async fn __test_list_windows(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<WindowSnapshot>, String> {
    let wm = state.window_manager.lock().await;
    let snapshots = wm
        .iter()
        .map(|(label, ws)| WindowSnapshot {
            label: label.clone(),
            root: ws.initial_args.root.clone(),
            initial_path: ws.initial_args.initial_path.clone(),
            show_marks: ws.initial_args.show_marks,
        })
        .collect();
    Ok(snapshots)
}
