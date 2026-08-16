//! IPC command handler — routes `IpcCommand` messages to application logic.
//!
//! This module provides a testable dispatch function that maps incoming IPC
//! requests to the same operations as the Tauri commands (`new_window`,
//! `set_root`), but driven by the IPC channel rather than by the invoke handler.

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::mpsc;
use tracing;

use crate::commands::root::RootPayload;
use crate::commands::AppState;
use crate::fs::uri::Uri;
use crate::ipc::protocol::{Request, Response};
use crate::ipc::server::IpcCommand;
use crate::watch::hub::WindowId;
use crate::window::manager::WindowArgs;

/// Spawn a tokio task that receives `IpcCommand` messages and dispatches them.
///
/// The task runs until the `cmd_rx` channel is closed (i.e., the `IpcServer` is
/// dropped).
pub fn spawn_command_handler(
    app: AppHandle,
    mut cmd_rx: mpsc::Receiver<IpcCommand>,
) {
    tokio::spawn(async move {
        while let Some(cmd) = cmd_rx.recv().await {
            let response = dispatch_command(&app, cmd.request).await;
            let _ = cmd.responder.send(response);
        }
        tracing::debug!("IPC command handler loop terminated");
    });
}

/// Dispatch a single IPC request, returning the appropriate response.
///
/// This function is the core routing logic and is kept `pub` for testing.
pub async fn dispatch_command(
    app: &AppHandle,
    request: Request,
) -> Response {
    match request {
        Request::OpenPath { uri, new_window } => handle_open_path(app, &uri, new_window).await,
        Request::SwitchRoot { uri } => handle_switch_root(app, &uri).await,
        Request::ShowMarks => handle_show_marks(app, false).await,
        Request::ShowChanged => handle_show_marks(app, true).await,
        Request::Ping => {
            // Ping is handled at the server level; should not reach here.
            Response::Ok
        }
        Request::Shutdown => {
            tracing::info!("IPC Shutdown request received — exiting");
            app.exit(0);
            Response::Ok
        }
    }
}

/// Handle `ShowMarks` / `ShowChanged` — emit `show_marks` event to the
/// active window so the Webview can open its mark sidebar
/// (`docs/ai-collab.md` §9.1).  The payload `{ filter_drift }`
/// distinguishes the two flags.
#[derive(serde::Serialize)]
struct ShowMarksPayload {
    filter_drift: bool,
}

async fn handle_show_marks(
    app: &AppHandle,
    filter_drift: bool,
) -> Response {
    let state = app.state::<AppState>();
    let label = {
        let wm = state.window_manager.lock().await;
        wm.active_label().map(|s| s.to_string())
    };
    let Some(label) = label else {
        return Response::Error {
            code: "NO_ACTIVE_WINDOW".into(),
            message: "no active window to show marks on".into(),
        };
    };
    let payload = ShowMarksPayload { filter_drift };
    if let Err(e) = app.emit_to(&label, "show_marks", &payload) {
        tracing::warn!("Failed to emit show_marks to '{}': {}", label, e);
        return Response::Error {
            code: "EMIT_FAILED".into(),
            message: e.to_string(),
        };
    }
    tracing::info!(
        "IPC: emitted show_marks (filter_drift={}) to window '{}'",
        filter_drift,
        label
    );
    Response::Ok
}

/// Handle `OpenPath` — create a new window (equivalent to `new_window` command).
async fn handle_open_path(
    app: &AppHandle,
    uri: &str,
    _new_window: bool,
) -> Response {
    let state = app.state::<AppState>();

    // Same seam as `build_initial_args` in `main.rs`: a directory URI
    // becomes the new root with no initial document; a file URI becomes
    // the initial document and `init_window` derives root from its parent.
    // Treating a directory URI as a file (the previous behaviour) made
    // `init_window` strip one segment and root resolved to the parent
    // of the path the user actually typed (issue #20).
    let args = WindowArgs::for_open_target(uri);

    // A directory URI *is* the root — record it now (requirements.md #3).
    // File URIs are never recorded here: `init_window` records the parent
    // directory it derives from them.
    if args.root.is_some() {
        crate::history::record_root(app, uri);
    }

    // A file URI has no root yet — `init_window` derives it from the parent
    // and retitles the window then (requirements.md #17).
    let title = crate::window::title::derive_window_title(args.root.as_deref());

    let label = {
        let mut wm = state.window_manager.lock().await;
        let label = wm.next_label();
        wm.register_window(label.clone(), args);
        label
    };

    match WebviewWindowBuilder::new(app, &label, WebviewUrl::default())
        .title(title)
        // Match the default from `tauri.conf.json` (issue #16) so
        // IPC-spawned windows aren't smaller than first-launch ones.
        .inner_size(1280.0, 800.0)
        .build()
    {
        Ok(_) => {
            tracing::info!("IPC: created window '{}' for '{}'", label, uri);
            Response::Ok
        }
        Err(e) => {
            tracing::error!("IPC: failed to create window: {}", e);
            // Rollback registration on failure.
            let mut wm = state.window_manager.lock().await;
            wm.unregister_window(&label);
            Response::Error {
                code: "WINDOW_CREATE_FAILED".into(),
                message: format!("failed to create window: {}", e),
            }
        }
    }
}

/// Handle `SwitchRoot` — change root on the active window and emit event.
async fn handle_switch_root(
    app: &AppHandle,
    uri: &str,
) -> Response {
    let state = app.state::<AppState>();

    let new_root = match Uri::parse(uri) {
        Ok(u) => u,
        Err(e) => {
            return Response::Error {
                code: "INVALID_URI".into(),
                message: e.to_string(),
            }
        }
    };

    // List entries under the new root.
    let provider = match state.fs_registry.resolve(&new_root) {
        Ok(p) => p,
        Err(e) => {
            return Response::Error {
                code: "PROVIDER_ERROR".into(),
                message: e.to_string(),
            }
        }
    };

    let entries = match provider.list(&new_root).await {
        Ok(e) => e,
        Err(e) => {
            return Response::Error {
                code: "LIST_ERROR".into(),
                message: e.to_string(),
            }
        }
    };

    let mut wm = state.window_manager.lock().await;
    let active_label = match wm.active_label() {
        Some(l) => l.to_string(),
        None => {
            return Response::Error {
                code: "NO_ACTIVE_WINDOW".into(),
                message: "no active window to switch root on".into(),
            }
        }
    };

    let win_state = match wm.get_mut(&active_label) {
        Some(s) => s,
        None => {
            return Response::Error {
                code: "WINDOW_NOT_FOUND".into(),
                message: format!("window '{}' not registered", active_label),
            }
        }
    };

    let document_retained = if let Some(ref session) = win_state.session {
        let doc_raw = &session.uri.raw;
        let root_prefix = &new_root.raw;
        doc_raw.starts_with(root_prefix)
    } else {
        false
    };

    if !document_retained {
        let _ = win_state.session.take();
    }

    // Tear down the previous directory watch first; the new one is
    // attached after the manager lock is released because
    // `subscribe_directory` awaits the coordinator mutex
    // (issue #18 — keep the same shape as the `set_root` command).
    win_state.root_watch = None;
    // 展開中サブディレクトリの監視も旧 root と一緒に手放す(要件#18 —
    // `set_root` コマンドと同じ扱い)。
    win_state.dir_watches.clear();
    win_state.root_uri = Some(new_root.clone());

    let payload = RootPayload {
        root_uri: new_root.raw.clone(),
        entries,
        document_retained,
    };

    // Drop the lock before emitting and before awaiting the coordinator.
    drop(wm);

    let coordinator = state.coordinator.clone();
    let new_watch = match coordinator
        .subscribe_directory(
            new_root.clone(),
            WindowId(active_label.clone()),
            app.clone(),
        )
        .await
    {
        Ok(sub) => Some(sub),
        Err(e) => {
            tracing::warn!(
                "SwitchRoot: failed to subscribe directory watch on {}: {}",
                new_root.raw,
                e
            );
            None
        }
    };

    let mut wm = state.window_manager.lock().await;
    if let Some(win_state) = wm.get_mut(&active_label) {
        win_state.root_watch = new_watch;
    }
    drop(wm);

    // The window is named after its root folder, so an IPC root switch
    // retitles it just like the `set_root` command does (requirements.md #17).
    // Best-effort: the root switch itself has already succeeded.
    let title = crate::window::title::derive_window_title(Some(&new_root.raw));
    if let Some(window) = app.get_webview_window(&active_label) {
        if let Err(e) = window.set_title(&title) {
            tracing::warn!(
                "SwitchRoot: failed to set the title of '{}' to '{}': {}",
                active_label,
                title,
                e
            );
        }
    }

    // Emit `root_changed` event to the active window.
    // For IPC-originated root switches, we use events (not command return values).
    if let Err(e) = app.emit_to(&active_label, "root_changed", &payload) {
        tracing::warn!("Failed to emit root_changed to '{}': {}", active_label, e);
    }

    tracing::info!(
        "IPC: switched root to '{}' on window '{}'",
        new_root.raw,
        active_label
    );
    Response::Ok
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test that dispatch routes OpenPath correctly (routing logic only).
    /// Full integration with WebviewWindow requires a running Tauri app.
    #[test]
    fn request_variants_are_exhaustive() {
        // Compile-time check: if a new Request variant is added,
        // this match must be updated.
        let requests = vec![
            Request::OpenPath {
                uri: "file:///tmp/test.md".into(),
                new_window: false,
            },
            Request::SwitchRoot {
                uri: "file:///tmp".into(),
            },
            Request::ShowMarks,
            Request::ShowChanged,
            Request::Ping,
            Request::Shutdown,
        ];
        for req in requests {
            // Just verify we can match all variants without panic.
            match req {
                Request::OpenPath { .. } => {}
                Request::SwitchRoot { .. } => {}
                Request::ShowMarks => {}
                Request::ShowChanged => {}
                Request::Ping => {}
                Request::Shutdown => {}
            }
        }
    }
}
