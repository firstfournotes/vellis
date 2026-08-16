//! Native macOS menu bar for the Vellis app.

use tauri::menu::{AboutMetadataBuilder, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// Stable identifier for the "Install 'vellis' Command in PATH" menu item.
pub const INSTALL_CLI_ITEM_ID: &str = "install-cli";

/// Stable identifier for the "Toggle Developer Tools" menu item.
pub const TOGGLE_DEVTOOLS_ITEM_ID: &str = "toggle-devtools";

/// Stable identifier for the "Print…" menu item (issue #24).
pub const PRINT_ITEM_ID: &str = "print";

/// Stable identifier for the "New Window" menu item (requirements.md #12).
pub const NEW_WINDOW_ITEM_ID: &str = "new-window";

/// Stable identifier for the "Open…" menu item (requirements.md #11).
pub const OPEN_FILE_ITEM_ID: &str = "open-file";

/// Stable identifier for the "Open Folder…" menu item (requirements.md #11).
pub const OPEN_FOLDER_ITEM_ID: &str = "open-folder";

/// Events emitted to the focused window when the Open items are clicked.
///
/// The dialog, the root derivation and the command sequence all live in the
/// frontend (`src/lib/menu-open.ts`) — the menu only says "the user asked to
/// open something". Names must stay in sync with `MENU_OPEN_FILE_EVENT` /
/// `MENU_OPEN_FOLDER_EVENT` there.
pub const MENU_OPEN_FILE_EVENT: &str = "menu_open_file";
pub const MENU_OPEN_FOLDER_EVENT: &str = "menu_open_folder";

/// Stable identifier for the Window submenu, so it can be found again after
/// the menu is installed (see [`attach_windows_menu_to_nsapp`]).
pub const WINDOW_MENU_ID: &str = "window-menu";

/// Build the application's native menu bar.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // macOS の muda About ダイアログは `<version> (<short_version>)` の順で
    // 連結して表示する (NSApp 標準の `Version X (Y)` 慣習と field の対応は逆)。
    // 主表示の semver を `version` に、build 識別子を `short_version` に入れる。
    // `comments` にはビルド日時のみ載せる。
    let about_metadata = AboutMetadataBuilder::new()
        .name(Some("Vellis"))
        .version(Some(env!("CARGO_PKG_VERSION").to_string()))
        .short_version(Some(env!("VELLIS_BUILD_NUMBER").to_string()))
        .comments(Some(format!("Built: {}", env!("VELLIS_BUILD_TIME"))))
        .website(Some(
            "https://github.com/firstfournotes/product-vellis".to_string(),
        ))
        .website_label(Some("GitHub".to_string()))
        .build();
    let about = PredefinedMenuItem::about(app, Some("About Vellis"), Some(about_metadata))?;
    let install_cli = MenuItem::with_id(
        app,
        INSTALL_CLI_ITEM_ID,
        "Install 'vellis' Command in PATH",
        true,
        None::<&str>,
    )?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let hide = PredefinedMenuItem::hide(app, None)?;
    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
    let show_all = PredefinedMenuItem::show_all(app, None)?;
    let quit = PredefinedMenuItem::quit(app, None)?;

    let app_menu = Submenu::with_items(
        app,
        "Vellis",
        true,
        &[
            &about,
            &sep1,
            &install_cli,
            &sep2,
            &hide,
            &hide_others,
            &show_all,
            &sep3,
            &quit,
        ],
    )?;

    // File menu — New Window (requirements.md #12)、Open… / Open Folder…
    // (requirements.md #11) と `Print…`。macOS の慣習で File に置く方が
    // Cmd+N / Cmd+O / Cmd+P を探したユーザーが見つけやすい (issue #24)。
    // plugin-dialog は1つのダイアログでファイルとフォルダを同時に選ばせられ
    // ないので、Open の項目を2つに割っている。
    let new_window_item = MenuItem::with_id(
        app,
        NEW_WINDOW_ITEM_ID,
        "New Window",
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let new_window_sep = PredefinedMenuItem::separator(app)?;
    let open_file_item = MenuItem::with_id(
        app,
        OPEN_FILE_ITEM_ID,
        "Open…",
        true,
        Some("CmdOrCtrl+O"),
    )?;
    let open_folder_item = MenuItem::with_id(
        app,
        OPEN_FOLDER_ITEM_ID,
        "Open Folder…",
        true,
        Some("CmdOrCtrl+Shift+O"),
    )?;
    let file_sep = PredefinedMenuItem::separator(app)?;
    let print_item = MenuItem::with_id(
        app,
        PRINT_ITEM_ID,
        "Print…",
        true,
        Some("CmdOrCtrl+P"),
    )?;
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_window_item,
            &new_window_sep,
            &open_file_item,
            &open_folder_item,
            &file_sep,
            &print_item,
        ],
    )?;

    // Standard macOS Edit menu. Cut/Copy/Paste/Undo/Redo must be present:
    // on WKWebView, Cmd+V and macOS dictation insert text through the
    // responder chain via these menu items' native selectors (`paste:`
    // etc.). Without Paste, raw keystrokes still reach the focused field
    // (typing works) but pasting and voice input silently no-op
    // (issue #45). `select_all` was already here; the rest restore the
    // full standard editing surface.
    let undo = PredefinedMenuItem::undo(app, None)?;
    let redo = PredefinedMenuItem::redo(app, None)?;
    let edit_sep = PredefinedMenuItem::separator(app)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &undo,
            &redo,
            &edit_sep,
            &cut,
            &copy,
            &paste,
            &select_all,
        ],
    )?;

    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let close = PredefinedMenuItem::close_window(app, None)?;
    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_MENU_ID,
        "Window",
        true,
        &[&minimize, &close],
    )?;

    let toggle_devtools = MenuItem::with_id(
        app,
        TOGGLE_DEVTOOLS_ITEM_ID,
        "Toggle Developer Tools",
        true,
        Some("CmdOrCtrl+Alt+I"),
    )?;
    let view_menu = Submenu::with_items(app, "View", true, &[&toggle_devtools])?;

    Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
    )
}

/// Hand the Window submenu to NSApp as *the* Window menu (requirements.md
/// #17). macOS then maintains the list of open windows inside it on its own —
/// the entries, the checkmark on the frontmost window and the switch on click
/// are all AppKit's, which is why nothing here manages menu items.
///
/// Must run **after** the menu is installed: `set_as_windows_menu_for_nsapp`
/// requires muda's `init_for_nsapp` to have run, and `App::set_menu` is what
/// does that. Failure is logged rather than propagated — a menu without the
/// window list is still a working menu.
#[cfg(target_os = "macos")]
pub fn attach_windows_menu_to_nsapp<R: Runtime>(menu: &Menu<R>) {
    let Some(window_menu) = menu
        .get(WINDOW_MENU_ID)
        .and_then(|kind| kind.as_submenu().cloned())
    else {
        tracing::warn!("Window submenu '{}' not found in the app menu", WINDOW_MENU_ID);
        return;
    };
    if let Err(e) = window_menu.set_as_windows_menu_for_nsapp() {
        tracing::warn!("failed to set the Window menu as NSApp's windows menu: {}", e);
    }
}

/// Handle the "Print…" menu click — opens the native OS print dialog on
/// the focused Webview. Uses Tauri's `Webview::print()` rather than
/// JavaScript `window.print()`: WKWebView does **not** implement the JS
/// API on macOS (known platform limitation, see issue #24), so eval'ing
/// `window.print()` is a silent no-op. The native call wraps each
/// platform's correct API (NSPrintInfo on macOS, etc.). The actual
/// formatting is handled by `@media print` in `src/styles/print.css`
/// (issue #21).
pub fn handle_print_click(app: &AppHandle<Wry>) {
    let Some(window) = app
        .webview_windows()
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .cloned()
        .or_else(|| app.webview_windows().values().next().cloned())
    else {
        return;
    };
    if let Err(e) = window.print() {
        tracing::warn!("failed to open print dialog: {}", e);
    }
}

/// Handle the "Open…" / "Open Folder…" menu clicks (requirements.md #11) —
/// notify the focused window and let the frontend do the rest.
///
/// Nothing about the open happens here: `src/lib/menu-open.ts` shows the
/// dialog, derives the new root (a file's parent folder, a folder itself)
/// and calls `set_root` / `open_document`. Keeping the whole sequence on
/// one side means the "現在のウインドウで開き直す" contract — including the
/// history record that `set_root` writes (requirements.md #3) — has a single
/// implementation, shared with any other trigger we add later.
///
/// Emitted with `emit_to` so only the window the user is looking at reacts;
/// a plain `emit` would open a dialog in every window (`show_marks` in
/// `ipc::handler` targets a single window for the same reason). The payload
/// is empty — the event itself is the whole message.
pub fn handle_menu_open_click(app: &AppHandle<Wry>, event: &str) {
    let Some(window) = app
        .webview_windows()
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .cloned()
        .or_else(|| app.webview_windows().values().next().cloned())
    else {
        return;
    };
    if let Err(e) = app.emit_to(window.label(), event, ()) {
        tracing::warn!("failed to emit {} to '{}': {}", event, window.label(), e);
    }
}

/// Handle the "New Window" menu click (requirements.md #12) — open another
/// window with no target at all, i.e. the same state as launching `vellis`
/// with no arguments: `needs_root_selection()` is true, so the new window
/// shows the history picker screen (requirements.md #4).
///
/// Unlike the Open items this does **not** emit to the focused window. Those
/// re-open a folder *in* an existing window, so the frontend has to run the
/// dialog and root derivation; a new window has no frontend state to consult
/// — asking a window to create its own sibling would only add a hop. It goes
/// straight through `create_window`, the same seam the `new_window` command
/// uses, so both routes register identical `WindowArgs` and both have their
/// geometry restored by the window-state plugin's `window_created` hook.
///
/// Window creation is async (the manager is behind an async mutex) while the
/// menu callback is not, so the work is spawned; failures are logged rather
/// than surfaced — the menu has nowhere to return an error to.
pub fn handle_new_window_click(app: &AppHandle<Wry>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::commands::window::create_window(&app, None, None).await {
            tracing::warn!("failed to open a new window from the menu: {}", e);
        }
    });
}

/// Handle the "Toggle Developer Tools" menu click — opens or closes the
/// Webview inspector on the currently focused window. Requires the `devtools`
/// feature on the `tauri` crate, which is enabled in `Cargo.toml`.
pub fn handle_toggle_devtools_click(app: &AppHandle<Wry>) {
    let Some(window) = app
        .webview_windows()
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .cloned()
        .or_else(|| app.webview_windows().values().next().cloned())
    else {
        return;
    };
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
}

/// Handle the "Install 'vellis' Command in PATH" menu click — runs the shared
/// install logic and displays a native dialog with the result.
pub fn handle_install_cli_click(app: &AppHandle<Wry>) {
    match crate::cli_install::install_cli() {
        Ok(result) => {
            let body = if result.target_dir_on_path {
                format!(
                    "インストール完了:\n  {}\n  → {}\n\n新しいシェルで `vellis` が使えます。",
                    result.target_path.display(),
                    result.source_path.display(),
                )
            } else {
                format!(
                    "インストール完了:\n  {}\n  → {}\n\n⚠ {} は PATH に含まれていません。\n以下を ~/.zshrc などに追加してください:\n\n  export PATH=\"$HOME/.local/bin:$PATH\"",
                    result.target_path.display(),
                    result.source_path.display(),
                    result
                        .target_path
                        .parent()
                        .map(|p| p.display().to_string())
                        .unwrap_or_default(),
                )
            };
            app.dialog()
                .message(body)
                .title("Vellis CLI")
                .kind(MessageDialogKind::Info)
                .blocking_show();
        }
        Err(e) => {
            app.dialog()
                .message(format!("CLI のインストールに失敗しました:\n{}", e))
                .title("Vellis CLI")
                .kind(MessageDialogKind::Error)
                .blocking_show();
        }
    }
}
