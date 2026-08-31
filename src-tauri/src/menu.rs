//! Native macOS menu bar for the Vellis app.

use crate::cli_install::InstallCliResult;
use tauri::menu::{AboutMetadataBuilder, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// Stable identifier for the "Install 'vellis' Command in PATH" menu item.
pub const INSTALL_CLI_ITEM_ID: &str = "install-cli";

/// Stable identifier for the "Toggle Developer Tools" menu item.
pub const TOGGLE_DEVTOOLS_ITEM_ID: &str = "toggle-devtools";

/// Stable identifier for the "Print…" menu item (issue #24).
pub const PRINT_ITEM_ID: &str = "print";

/// Stable identifier for the "New Window" menu item (requirements.md #12).
pub const NEW_WINDOW_ITEM_ID: &str = "new-window";

/// Stable identifier for the "Duplicate Window" menu item (requirements.md #34).
pub const DUPLICATE_WINDOW_ITEM_ID: &str = "duplicate-window";

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

/// Event emitted to the focused window when "Duplicate Window" is clicked
/// (requirements.md #34).
///
/// Same shape as the Open events, and for the same reason: only the window
/// itself knows what it is currently showing — root, document and expanded
/// directories — so it is the one that collects that triple and asks for the
/// new window (`src/lib/duplicate-window.ts`).  Name must stay in sync with
/// `MENU_DUPLICATE_WINDOW_EVENT` there.
pub const MENU_DUPLICATE_WINDOW_EVENT: &str = "menu_duplicate_window";

/// Event emitted to the focused window when "Print…" is clicked
/// (requirements.md #38).
///
/// Same shape as the Open events, and for the same reason: the paper's contents
/// depend on which viewer is on screen — Markdown and text print the window's
/// main frame the way they always have, while the HTML viewer needs a print
/// window of its own (its sandboxed iframe never reaches the main frame's print
/// output, which is what made ⌘P over an HTML file produce a blank sheet —
/// backlog #82). The choice lives in `src/lib/print-html.ts`; name must stay in
/// sync with `MENU_PRINT_EVENT` there.
pub const MENU_PRINT_EVENT: &str = "menu_print";

/// Stable identifiers for the View menu's zoom items (requirements.md #36).
pub const ZOOM_IN_ITEM_ID: &str = "zoom-in";
pub const ZOOM_OUT_ITEM_ID: &str = "zoom-out";
pub const ACTUAL_SIZE_ITEM_ID: &str = "actual-size";

/// Events emitted to the focused window when the zoom items are clicked
/// (requirements.md #36).
///
/// Same shape as the Open events: the menu only says "the user asked to zoom",
/// and the whole notion of a zoom level — its steps, its bounds, which viewers
/// it applies to and where it is persisted — lives in the frontend
/// (`src/lib/zoom.ts`). Names must stay in sync with the same-named constants
/// there. Actual Size emits `menu_zoom_reset` because it resets the *zoom
/// level*; it is not the ImageViewer's "actual size" toggle (contract ⑧).
pub const MENU_ZOOM_IN_EVENT: &str = "menu_zoom_in";
pub const MENU_ZOOM_OUT_EVENT: &str = "menu_zoom_out";
pub const MENU_ZOOM_RESET_EVENT: &str = "menu_zoom_reset";

/// Accelerators for the zoom items (requirements.md #36 ②).
///
/// Zoom In is spelled `=`, not `Plus`: tauri parses an accelerator with
/// `s.parse::<muda::accelerator::Accelerator>().ok()` and **drops a failure
/// silently** (`tauri::menu::normal`), and muda 0.17 has no `PLUS` key — so
/// "CmdOrCtrl+Plus" would leave the item with no shortcut at all and no error
/// anywhere. `acceptance_req36.rs` pins both the spelling and the fact that it
/// parses. The constants are passed to `MenuItem::with_id` rather than inline
/// literals so that what the test checks is what the menu registers.
pub const ZOOM_IN_ACCELERATOR: &str = "CmdOrCtrl+=";
pub const ZOOM_OUT_ACCELERATOR: &str = "CmdOrCtrl+-";
pub const ACTUAL_SIZE_ACCELERATOR: &str = "CmdOrCtrl+0";

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
        // 公開リポジトリを指す。開発は private の product-vellis で行うが、
        // 公開ユーザーがここを開くと 404 になるため (backlog #41)。
        .website(Some("https://github.com/firstfournotes/vellis".to_string()))
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
    // Duplicate Window sits right after New Window (requirements.md #34): the
    // two are the same gesture, one starting empty and one starting from what
    // this window already shows.
    let duplicate_window_item = MenuItem::with_id(
        app,
        DUPLICATE_WINDOW_ITEM_ID,
        "Duplicate Window",
        true,
        Some("CmdOrCtrl+Shift+N"),
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
            &duplicate_window_item,
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

    // View menu — the zoom items (requirements.md #36) sit at the top, the way
    // macOS browsers arrange them, with Toggle Developer Tools kept at the
    // bottom behind a separator. All three are enabled unconditionally
    // (contract ⑧): the menu does not know which viewer is on screen, and a
    // non-text viewer simply ignores the event.
    let zoom_in_item = MenuItem::with_id(
        app,
        ZOOM_IN_ITEM_ID,
        "Zoom In",
        true,
        Some(ZOOM_IN_ACCELERATOR),
    )?;
    let zoom_out_item = MenuItem::with_id(
        app,
        ZOOM_OUT_ITEM_ID,
        "Zoom Out",
        true,
        Some(ZOOM_OUT_ACCELERATOR),
    )?;
    let actual_size_item = MenuItem::with_id(
        app,
        ACTUAL_SIZE_ITEM_ID,
        "Actual Size",
        true,
        Some(ACTUAL_SIZE_ACCELERATOR),
    )?;
    let view_sep = PredefinedMenuItem::separator(app)?;
    let toggle_devtools = MenuItem::with_id(
        app,
        TOGGLE_DEVTOOLS_ITEM_ID,
        "Toggle Developer Tools",
        true,
        Some("CmdOrCtrl+Alt+I"),
    )?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &zoom_in_item,
            &zoom_out_item,
            &actual_size_item,
            &view_sep,
            &toggle_devtools,
        ],
    )?;

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

/// The window a menu click applies to: the focused one, or — when no window
/// reports focus — whichever comes first. `is_focused()` can fail (the query
/// goes to the window manager), and a failure is treated as "not focused"
/// rather than aborting the click.
///
/// Print windows (requirements.md #38) are skipped in both passes. They are
/// webview windows, so they would otherwise be eligible, but they carry a
/// static document instead of the app — a menu event delivered to one is a
/// click that silently does nothing.
///
/// Returns `None` only when the app has no document windows at all.
fn focused_or_first_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    let windows = app.webview_windows();
    let document_windows = || {
        windows
            .values()
            .filter(|w| !crate::print::is_print_window(w.label()))
    };
    document_windows()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| document_windows().next())
        .cloned()
}

/// Handle the "Print…" menu click (requirements.md #38) — notify the focused
/// window and let the frontend pick the route.
///
/// This used to call `window.print()` here. That prints the window's main
/// frame, which is right for Markdown and text but produced a blank sheet for
/// the HTML viewer, whose document lives in a sandboxed iframe that WebKit does
/// not expand into the print output (backlog #82). Only the window knows which
/// viewer is on screen, so the choice moved to `src/lib/print-html.ts`, exactly
/// like the Open items and the zoom items before it.
///
/// Neither route lost anything: `print_current_window` calls the same
/// `Webview::print()` on the same window for every non-HTML viewer, and HTML
/// goes to `print_html` and a print window of its own.
pub fn handle_print_click(app: &AppHandle<Wry>) {
    handle_menu_open_click(app, MENU_PRINT_EVENT);
}

/// Handle a menu click whose work belongs to the window itself
/// (requirements.md #11 の Open… / Open Folder…、#34 の Duplicate Window) —
/// notify the focused window and let the frontend do the rest.
///
/// Nothing about the open happens here: `src/lib/menu-open.ts` shows the
/// dialog, derives the new root (a file's parent folder, a folder itself)
/// and calls `set_root` / `open_document`. Keeping the whole sequence on
/// one side means the "現在のウインドウで開き直す" contract — including the
/// history record that `set_root` writes (requirements.md #3) — has a single
/// implementation, shared with any other trigger we add later.
///
/// Duplicate Window rides the same seam for the mirror-image reason: the
/// contents to copy (root, document, expanded directories) live only in the
/// window, so it is the window that collects them and calls `new_window`
/// (`src/lib/duplicate-window.ts`).
///
/// The zoom items (requirements.md #36) ride it too: only the window knows
/// which viewer is showing and what the current level is, and the zoom itself
/// is applied by the frontend (`src/lib/zoom.ts`), never by the webview's own
/// zoom — that would scale the Explorer along with the text.
///
/// Emitted with `emit_to` so only the window the user is looking at reacts;
/// a plain `emit` would open a dialog in every window (`show_marks` in
/// `ipc::handler` targets a single window for the same reason). The payload
/// is empty — the event itself is the whole message.
pub fn handle_menu_open_click(app: &AppHandle<Wry>, event: &str) {
    let Some(window) = focused_or_first_window(app) else {
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
        if let Err(e) = crate::commands::window::create_window(&app, None, None, Vec::new()).await {
            tracing::warn!("failed to open a new window from the menu: {}", e);
        }
    });
}

/// Handle the "Toggle Developer Tools" menu click — opens or closes the
/// Webview inspector on the currently focused window. Requires the `devtools`
/// feature on the `tauri` crate, which is enabled in `Cargo.toml`.
pub fn handle_toggle_devtools_click(app: &AppHandle<Wry>) {
    let Some(window) = focused_or_first_window(app) else {
        return;
    };
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
}

/// 成功ダイアログの本文(要件#35 ③=英語固定)。作られたリンクと指し先の2行に、
/// インストール先が PATH 上かどうかで案内か警告(追記例つき)を続ける。
pub fn install_cli_success_body(result: &InstallCliResult) -> String {
    let paths = format!(
        "Installed:\n  {}\n  → {}",
        result.target_path.display(),
        result.source_path.display(),
    );
    if result.target_dir_on_path {
        format!("{}\n\nThe `vellis` command is now available in new shells.", paths)
    } else {
        format!(
            "{}\n\n⚠ {} is not on your PATH.\nAdd the following to your ~/.zshrc or similar:\n\n  export PATH=\"$HOME/.local/bin:$PATH\"",
            paths,
            result
                .target_path
                .parent()
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
        )
    }
}

/// 失敗ダイアログの本文(要件#35 ③)。`install_cli()` の Err をそのまま挟む。
pub fn install_cli_failure_body(err: &str) -> String {
    format!("Failed to install the CLI:\n{}", err)
}

/// Handle the "Install 'vellis' Command in PATH" menu click — runs the shared
/// install logic and displays a native dialog with the result.
pub fn handle_install_cli_click(app: &AppHandle<Wry>) {
    match crate::cli_install::install_cli() {
        Ok(result) => {
            app.dialog()
                .message(install_cli_success_body(&result))
                .title("Vellis CLI")
                .kind(MessageDialogKind::Info)
                .blocking_show();
        }
        Err(e) => {
            app.dialog()
                .message(install_cli_failure_body(&e))
                .title("Vellis CLI")
                .kind(MessageDialogKind::Error)
                .blocking_show();
        }
    }
}
