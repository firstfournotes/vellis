//! Native macOS menu bar for the Vellis app.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::cli_install::InstallCliResult;
use crate::update_check::ManualCheckOutcome;
use tauri::menu::{AboutMetadataBuilder, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

/// Stable identifier for the "Install 'vellis' Command in PATH" menu item.
pub const INSTALL_CLI_ITEM_ID: &str = "install-cli";

/// Stable identifier for the "Toggle Developer Tools" menu item.
pub const TOGGLE_DEVTOOLS_ITEM_ID: &str = "toggle-devtools";

/// Stable identifier for the App menu's "Settings…" item (requirements.md #65
/// 契約6).
pub const SETTINGS_ITEM_ID: &str = "settings";

/// Stable identifier for the App menu's "Check for Updates…" item
/// (requirements.md #67 契約6). No accelerator, as is usual on macOS.
pub const CHECK_FOR_UPDATES_ITEM_ID: &str = "check-for-updates";

/// Accelerator for the Settings… item (requirements.md #65 契約6): Command + ,
/// — the key every macOS app uses for its settings.
///
/// A constant for the same reason as `FIND_ACCELERATOR`: tauri drops an
/// unparseable accelerator silently, so the test and the menu read the same
/// literal.
pub const SETTINGS_ACCELERATOR: &str = "CmdOrCtrl+,";

/// Stable identifier for the "Print…" menu item (issue #24).
pub const PRINT_ITEM_ID: &str = "print";

/// Stable identifier for the "Save" menu item (requirements.md #48).
pub const SAVE_ITEM_ID: &str = "save";

/// Event emitted to the focused window when "Save" is clicked
/// (requirements.md #48 契約⑤).
///
/// Same shape and same reason as the Open / Print / zoom events: the menu can
/// only say "the user asked to save". Whether anything is being edited, what
/// the edit buffer holds and which document it belongs to are known only to
/// the window, so it decides and calls `save_document` itself
/// (`src/lib/save-document.ts`). Name must stay in sync with `MENU_SAVE_EVENT`
/// there. Nothing is saved automatically — this event is the only trigger.
pub const MENU_SAVE_EVENT: &str = "menu_save";

/// Stable identifier for the Edit menu's "Edit" item (requirements.md #48 追補b).
pub const EDIT_ITEM_ID: &str = "edit";

/// Event emitted to the focused window when "Edit" is clicked
/// (requirements.md #48 契約③・追補b).
///
/// Toggles the focused window between viewing and editing. Same division of
/// labour as Save: the menu cannot know whether the window is showing an
/// editable document or is already in edit mode, so it only reports the
/// gesture and the window decides (`src/lib/document-edit.ts`).
///
/// This is the *only* way into edit mode for HTML documents: while viewing,
/// they are rendered inside `HtmlViewer`'s sandboxed iframe, where the
/// double-click that starts editing in the Markdown / text viewer never
/// reaches the app.
pub const MENU_EDIT_EVENT: &str = "menu_edit";

/// Accelerator for the Edit item (requirements.md #48 追補b).
pub const EDIT_ACCELERATOR: &str = "CmdOrCtrl+E";

/// Stable identifier for the Edit menu's "Find…" item (requirements.md #54 契約①).
pub const FIND_ITEM_ID: &str = "find";

/// Event emitted to the focused window when "Find…" is clicked
/// (requirements.md #54 契約①).
///
/// Same shape and same division of labour as Edit and Save: the menu can only
/// say "the user asked to search". What is on screen, which of its texts is
/// searchable and where the matches are all live in the frontend
/// (`src/lib/find-in-document.ts` and the viewer's find bar), so the window
/// decides. Name must stay in sync with `MENU_FIND_EVENT` there. Documents
/// with no displayed text (PDF, images, audio, video, 3D) simply ignore it.
pub const MENU_FIND_EVENT: &str = "menu_find";

/// Accelerator for the Find… item (requirements.md #54 契約①).
///
/// Spelled out as a constant for the same reason the zoom and Save ones are:
/// tauri drops an unparseable accelerator silently, so the test and the menu
/// read the same literal.
pub const FIND_ACCELERATOR: &str = "CmdOrCtrl+F";

/// Stable identifier for the Edit menu's "Find in Folder…" item
/// (requirements.md #55 契約①).
pub const FIND_IN_FOLDER_ITEM_ID: &str = "find-in-folder";

/// Event emitted to the focused window when "Find in Folder…" is clicked
/// (requirements.md #55 契約①).
///
/// Same division of labour as Find…: the menu only reports the gesture. Which
/// root is open (or whether any is — the history picker ignores it) and the
/// search panel itself live in the frontend (`src/lib/find-in-folder.ts`).
/// Name must stay in sync with `MENU_FIND_IN_FOLDER_EVENT` there.
pub const MENU_FIND_IN_FOLDER_EVENT: &str = "menu_find_in_folder";

/// Accelerator for the Find in Folder… item (requirements.md #55 契約①).
///
/// A constant for the same reason as `FIND_ACCELERATOR`: tauri drops an
/// unparseable accelerator silently, so the test and the menu read the same
/// literal.
pub const FIND_IN_FOLDER_ACCELERATOR: &str = "CmdOrCtrl+Shift+F";

/// Accelerator for the Save item (requirements.md #48 契約⑤).
///
/// Spelled out as a constant for the same reason the zoom ones are: tauri
/// drops an unparseable accelerator silently, so the test and the menu read
/// the same literal.
pub const SAVE_ACCELERATOR: &str = "CmdOrCtrl+S";

/// Stable identifier for the "New Window" menu item (requirements.md #12).
pub const NEW_WINDOW_ITEM_ID: &str = "new-window";

/// Stable identifier for the "New Tab" menu item (requirements.md #62 契約3).
pub const NEW_TAB_ITEM_ID: &str = "new-tab";

/// Event emitted to the focused window when "New Tab" is clicked
/// (requirements.md #62 契約3・4).
///
/// Same shape and same reason as Duplicate Window: the new tab starts from this
/// window's root and expanded directories, which only the window knows, so the
/// window collects them and calls `new_tab` (`src/lib/new-tab.ts`). Name must
/// stay in sync with `MENU_NEW_TAB_EVENT` there. A window with no root (the
/// history picker) ignores it — there is nothing to open a tab on.
pub const MENU_NEW_TAB_EVENT: &str = "menu_new_tab";

/// Accelerator for the New Tab item (requirements.md #62 契約3). Spelled out as
/// a constant for the same reason the zoom ones are: tauri drops an
/// unparseable accelerator silently, so the test and the menu read the same
/// literal.
pub const NEW_TAB_ACCELERATOR: &str = "CmdOrCtrl+T";

/// Stable identifiers for the Window menu's "Show Previous Tab" / "Show Next
/// Tab" items (requirements.md #62 契約7).
pub const PREVIOUS_TAB_ITEM_ID: &str = "previous-tab";
pub const NEXT_TAB_ITEM_ID: &str = "next-tab";

/// Accelerators for Show Previous / Next Tab: Shift+Command+[ and
/// Shift+Command+], the keys Safari, Terminal and Xcode use (requirements.md
/// #62 起案時判断 (g)). AppKit's own Control+Tab / Control+Shift+Tab keep
/// working next to them.
pub const PREVIOUS_TAB_ACCELERATOR: &str = "CmdOrCtrl+Shift+[";
pub const NEXT_TAB_ACCELERATOR: &str = "CmdOrCtrl+Shift+]";

/// Stable identifiers for the tab items AppKit adds on its own only to a nib
/// menu, never to one built in code like this one (requirements.md #62
/// 追補b): View ▸ Show Tab Bar / Show All Tabs and Window ▸ Move Tab to New
/// Window / Merge All Windows.
pub const SHOW_TAB_BAR_ITEM_ID: &str = "show-tab-bar";
pub const SHOW_ALL_TABS_ITEM_ID: &str = "show-all-tabs";
pub const MOVE_TAB_TO_NEW_WINDOW_ITEM_ID: &str = "move-tab-to-new-window";
pub const MERGE_ALL_WINDOWS_ITEM_ID: &str = "merge-all-windows";

/// Accelerators for Show Tab Bar (Shift+Command+T) and Show All Tabs
/// (Shift+Command+Backslash), AppKit's own keys (requirements.md #62 追補b).
/// Backslash is spelled out by name: an escaped backslash would parse too,
/// but the accelerator collision scan of `acceptance_req60.rs` reads the
/// literal without unescaping it and would miss it. Move Tab to New Window and Merge All
/// Windows have no key, as in AppKit.
pub const SHOW_TAB_BAR_ACCELERATOR: &str = "CmdOrCtrl+Shift+T";
pub const SHOW_ALL_TABS_ACCELERATOR: &str = "CmdOrCtrl+Shift+Backslash";

/// Stable identifier for the "Duplicate Window" menu item (requirements.md #34).
pub const DUPLICATE_WINDOW_ITEM_ID: &str = "duplicate-window";

/// Stable identifier for the "Open…" menu item (requirements.md #11).
pub const OPEN_FILE_ITEM_ID: &str = "open-file";

/// Stable identifier for the "Open Folder…" menu item (requirements.md #11).
pub const OPEN_FOLDER_ITEM_ID: &str = "open-folder";

/// Stable identifier for the Go menu's "Go to Path…" item (requirements.md #60
/// 契約①・追補c — it used to sit in the File menu, next to the Open items).
pub const GO_TO_ITEM_ID: &str = "go-to-path";

/// Event emitted to the focused window when "Go to Path…" is clicked
/// (requirements.md #60 契約①).
///
/// Same shape and same division of labour as the Open items: the menu can only
/// say "the user asked to go somewhere". What the current root is, how the typed
/// path folds, which directories have to be expanded and whether the target even
/// exists all live in the frontend (`src/lib/go-to-path.ts` and the window's go
/// to bar), so the window decides. Name must stay in sync with
/// `MENU_GO_TO_EVENT` there. A window with no root (the history picker) simply
/// ignores it — there is nowhere to jump.
pub const MENU_GO_TO_EVENT: &str = "menu_go_to";

/// Accelerator for the Go to Path… item (requirements.md #60 契約①).
///
/// ⇧⌘G, the same key Finder gives "Go to Folder". Spelled out as a constant for
/// the same reason Find and the zoom ones are: tauri drops an unparseable
/// accelerator silently, so the test and the menu read the same literal.
pub const GO_TO_ACCELERATOR: &str = "CmdOrCtrl+Shift+G";

/// Stable identifier for the Go menu's "Recent Files" item (requirements.md #64
/// 契約5).
pub const RECENT_FILES_ITEM_ID: &str = "recent-files";

/// Event emitted to the focused window when "Recent Files" is clicked
/// (requirements.md #64 契約5).
///
/// Same division of labour as Go to Path…: the menu only reports the gesture.
/// The Recent Files section lives at the bottom of the window's Explorer, and
/// whether there is one (a root, no history picker), whether the search panel
/// has to make way for it and which row gets the focus are all the window's to
/// decide (`src/lib/recent-files.ts`). Name must stay in sync with
/// `MENU_RECENT_FILES_EVENT` there. No payload.
pub const MENU_RECENT_FILES_EVENT: &str = "menu_recent_files";

/// Accelerator for the Recent Files item (requirements.md #64 契約5): Command +
/// Shift + R — R for "Recent". A constant for the same reason as
/// `GO_TO_ACCELERATOR`: tauri drops an unparseable accelerator silently, so the
/// test and the menu read the same literal.
pub const RECENT_FILES_ACCELERATOR: &str = "CmdOrCtrl+Shift+R";

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
    // Check for Updates… sits right under About, above the first separator —
    // the usual place in macOS apps (requirements.md #67 契約6).
    let check_for_updates_item = MenuItem::with_id(
        app,
        CHECK_FOR_UPDATES_ITEM_ID,
        "Check for Updates…",
        true,
        None::<&str>,
    )?;
    // Settings… sits right under About, after its separator — where macOS apps
    // put it (requirements.md #65 契約6).
    let settings_item = MenuItem::with_id(
        app,
        SETTINGS_ITEM_ID,
        "Settings…",
        true,
        Some(SETTINGS_ACCELERATOR),
    )?;
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
            &check_for_updates_item,
            &sep1,
            &settings_item,
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
    // New Tab sits between New Window and Duplicate Window (requirements.md #62
    // 契約3), the way Safari lines up its "new" items.
    let new_tab_item = MenuItem::with_id(
        app,
        NEW_TAB_ITEM_ID,
        "New Tab",
        true,
        Some(NEW_TAB_ACCELERATOR),
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
    // Save sits between the Open items and Print, where macOS puts it
    // (requirements.md #48 契約⑤). Enabled unconditionally, like the zoom
    // items: the menu does not know whether anything is being edited, and a
    // window with nothing to save simply ignores the event.
    let save_item = MenuItem::with_id(app, SAVE_ITEM_ID, "Save", true, Some(SAVE_ACCELERATOR))?;
    let save_sep = PredefinedMenuItem::separator(app)?;
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
            &new_tab_item,
            &duplicate_window_item,
            &new_window_sep,
            &open_file_item,
            &open_folder_item,
            &file_sep,
            &save_item,
            &save_sep,
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
    // Entering / leaving edit mode (requirements.md #48 契約③・追補b). Placed
    // after the standard block rather than above Undo so the macOS ordering
    // every app shares stays where users expect it. Enabled unconditionally,
    // like Save and the zoom items: a window showing an image (or an SSH
    // document, which stays read-only) simply ignores the event.
    let edit_mode_sep = PredefinedMenuItem::separator(app)?;
    let edit_mode_item =
        MenuItem::with_id(app, EDIT_ITEM_ID, "Edit", true, Some(EDIT_ACCELERATOR))?;
    // 文書内検索 (requirements.md #54 契約①). Sits next to Edit, after the
    // standard block, so the macOS ordering every app shares stays where users
    // expect it. Enabled unconditionally, like Edit and Save: only the window
    // knows whether what it displays has any text to search, so a PDF or an
    // image window simply ignores the event.
    let find_item = MenuItem::with_id(app, FIND_ITEM_ID, "Find…", true, Some(FIND_ACCELERATOR))?;
    // フォルダ横断検索 (requirements.md #55 契約①). Directly after Find…, the
    // in-document search it builds on. Enabled unconditionally: a window with no
    // root open (the history picker) simply ignores the event.
    let find_in_folder_item = MenuItem::with_id(
        app,
        FIND_IN_FOLDER_ITEM_ID,
        "Find in Folder…",
        true,
        Some(FIND_IN_FOLDER_ACCELERATOR),
    )?;
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
            &edit_mode_sep,
            &edit_mode_item,
            &find_item,
            &find_in_folder_item,
        ],
    )?;

    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let close = PredefinedMenuItem::close_window(app, None)?;
    // Tab switching (requirements.md #62 契約7). A tab is a window, and Close
    // Window already closes just that tab; these two move between the tabs of
    // the front window. Enabled unconditionally: a window without tabs simply
    // has nowhere to move.
    let tab_sep = PredefinedMenuItem::separator(app)?;
    let previous_tab_item = MenuItem::with_id(
        app,
        PREVIOUS_TAB_ITEM_ID,
        "Show Previous Tab",
        true,
        Some(PREVIOUS_TAB_ACCELERATOR),
    )?;
    let next_tab_item = MenuItem::with_id(
        app,
        NEXT_TAB_ITEM_ID,
        "Show Next Tab",
        true,
        Some(NEXT_TAB_ACCELERATOR),
    )?;
    // Moving a tab out and merging windows back (requirements.md #62 追補b),
    // right after the tab switching, where AppKit's own menu has them. Merge
    // All Windows only merges windows with the same tab group key, i.e. the
    // same root (契約6).
    let move_tab_to_new_window_item = MenuItem::with_id(
        app,
        MOVE_TAB_TO_NEW_WINDOW_ITEM_ID,
        "Move Tab to New Window",
        true,
        None::<&str>,
    )?;
    let merge_all_windows_item = MenuItem::with_id(
        app,
        MERGE_ALL_WINDOWS_ITEM_ID,
        "Merge All Windows",
        true,
        None::<&str>,
    )?;
    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_MENU_ID,
        "Window",
        true,
        &[
            &minimize,
            &close,
            &tab_sep,
            &previous_tab_item,
            &next_tab_item,
            &move_tab_to_new_window_item,
            &merge_all_windows_item,
        ],
    )?;

    // View menu — the zoom items (requirements.md #36) sit at the top, the way
    // macOS browsers arrange them, with Toggle Developer Tools kept at the
    // bottom behind a separator. All three are enabled unconditionally
    // (contract ⑧): the menu does not know which viewer is on screen, and a
    // non-text viewer simply ignores the event.
    //
    // Above them, Show Tab Bar and Show All Tabs (requirements.md #62 追補b),
    // where AppKit's own View menu has them. A window with a single tab shows
    // no tab bar, so Show Tab Bar is what lets another window be dragged into
    // it. The title stays "Show Tab Bar" even while the bar is shown.
    let show_tab_bar_item = MenuItem::with_id(
        app,
        SHOW_TAB_BAR_ITEM_ID,
        "Show Tab Bar",
        true,
        Some(SHOW_TAB_BAR_ACCELERATOR),
    )?;
    let show_all_tabs_item = MenuItem::with_id(
        app,
        SHOW_ALL_TABS_ITEM_ID,
        "Show All Tabs",
        true,
        Some(SHOW_ALL_TABS_ACCELERATOR),
    )?;
    let view_tab_sep = PredefinedMenuItem::separator(app)?;
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
            &show_tab_bar_item,
            &show_all_tabs_item,
            &view_tab_sep,
            &zoom_in_item,
            &zoom_out_item,
            &actual_size_item,
            &view_sep,
            &toggle_devtools,
        ],
    )?;

    // Go menu (requirements.md #60 契約①・追補c = 2026-09-20 由谷「新たに "Go"
    // メニューを追加して、そこに入れてください」). One item for now, and the place
    // where Back / Forward / Enclosing Folder would go later. Finder puts its Go
    // menu between View and Window, so the bar reads App / File / Edit / View /
    // Go / Window. Enabled unconditionally, like Save and the zoom items: only
    // the window knows whether it has a root to jump inside, and a window showing
    // the history picker ignores the event.
    let go_to_item =
        MenuItem::with_id(app, GO_TO_ITEM_ID, "Go to Path…", true, Some(GO_TO_ACCELERATOR))?;
    // Recent Files sits right under Go to Path… (requirements.md #64 契約5). No
    // ellipsis: it opens the Explorer's Recent Files section, not a dialog.
    let recent_files_item = MenuItem::with_id(
        app,
        RECENT_FILES_ITEM_ID,
        "Recent Files",
        true,
        Some(RECENT_FILES_ACCELERATOR),
    )?;
    let go_menu = Submenu::with_items(app, "Go", true, &[&go_to_item, &recent_files_item])?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &go_menu,
            &window_menu,
        ],
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
        if let Err(e) = crate::commands::window::create_window(
            &app,
            None,
            None,
            Vec::new(),
            crate::window::tab::WindowKind::Standalone,
        )
        .await
        {
            tracing::warn!("failed to open a new window from the menu: {}", e);
        }
    });
}

/// Handle the App menu's "Settings…" click (requirements.md #65 契約6).
///
/// Everything stays in Rust: when `settings.json` is missing it is written with
/// the defaults first (an existing file — even a broken one — is left as it
/// is), then a new window opens with the settings folder as its root and the
/// file as its document, built the same way as File ▸ New Window. The file is
/// JSON, i.e. text, so it is edited and saved with the editor of
/// requirements.md #48. Failures are logged: the menu has nowhere to return an
/// error to.
pub fn handle_settings_click(app: &AppHandle<Wry>) {
    let Some(path) = crate::settings::default_settings_path() else {
        tracing::warn!("Settings…: no home directory to keep the settings file in");
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::settings::ensure_settings_file(&path) {
            tracing::warn!("Settings…: could not create {}: {}", path.display(), e);
            return;
        }
        let Some(folder) = path.parent() else {
            tracing::warn!("Settings…: {} has no parent folder", path.display());
            return;
        };
        let document = format!("file://{}", path.display());
        let root = format!("file://{}", folder.display());
        if let Err(e) = crate::commands::window::create_window(
            &app,
            Some(document),
            Some(root),
            Vec::new(),
            crate::window::tab::WindowKind::Standalone,
        )
        .await
        {
            tracing::warn!("Settings…: failed to open the settings window: {}", e);
        }
    });
}

/// Handle Show Previous Tab / Show Next Tab (requirements.md #62 契約7) — move
/// to the neighbouring tab of the front window.
///
/// Unlike New Tab this never reaches the frontend: which tab comes next is
/// AppKit's knowledge, not the window's, so the front `NSWindow` is sent
/// `selectPreviousTab:` / `selectNextTab:` directly.
pub fn handle_select_tab_click(app: &AppHandle<Wry>, direction: crate::window::tab::TabDirection) {
    let Some(window) = focused_or_first_window(app) else {
        return;
    };
    crate::window::tab::select_adjacent_tab(app, window.label(), direction);
}

/// Handle View ▸ Show Tab Bar / Show All Tabs and Window ▸ Move Tab to New
/// Window / Merge All Windows (requirements.md #62 追補b). Same route as Show
/// Previous / Next Tab: the front `NSWindow` is sent AppKit's own action.
pub fn handle_tab_menu_click(app: &AppHandle<Wry>, action: crate::window::tab::TabMenuAction) {
    let Some(window) = focused_or_first_window(app) else {
        return;
    };
    crate::window::tab::perform_tab_menu_action(app, window.label(), action);
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

/// Set while a Check for Updates… is in flight, from the click until its
/// dialog is dismissed (requirements.md #67 契約10).
static CHECK_FOR_UPDATES_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Clears [`CHECK_FOR_UPDATES_IN_FLIGHT`] when dropped, so every path out of
/// the check — including one that never reaches the dialog — releases it.
struct CheckForUpdatesInFlight;

impl Drop for CheckForUpdatesInFlight {
    fn drop(&mut self) {
        CHECK_FOR_UPDATES_IN_FLIGHT.store(false, Ordering::Release);
    }
}

/// Handle the App menu's "Check for Updates…" click (requirements.md #67
/// 契約7・8・10): check right away and always answer with a native dialog —
/// Download / Later when a newer release exists, otherwise a single OK.
///
/// A click while a check (or its dialog) is still up is ignored, so a
/// double press never sends a second request or stacks a second dialog.
/// `show` (not `blocking_show`) keeps an async-runtime worker from being
/// parked for as long as the dialog stays open; the in-flight guard rides
/// into its callback and is released there.
pub fn handle_check_for_updates_click(app: &AppHandle<Wry>) {
    if CHECK_FOR_UPDATES_IN_FLIGHT
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    let guard = CheckForUpdatesInFlight;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = crate::update_check::run_manual_check(&app).await;
        let dialog = crate::update_check::manual_check_dialog(&outcome, env!("CARGO_PKG_VERSION"));
        let kind = match outcome {
            ManualCheckOutcome::Failed => MessageDialogKind::Error,
            _ => MessageDialogKind::Info,
        };
        let mut builder = app
            .dialog()
            .message(dialog.body)
            .title(dialog.title)
            .kind(kind);
        if let [ok, cancel] = dialog.buttons.as_slice() {
            builder = builder.buttons(MessageDialogButtons::OkCancelCustom(
                ok.clone(),
                cancel.clone(),
            ));
        }
        let opener_app = app.clone();
        builder.show(move |pressed_default| {
            let _guard = guard;
            let ManualCheckOutcome::Available { url, .. } = outcome else {
                return;
            };
            if !pressed_default {
                return;
            }
            if let Err(e) = opener_app.opener().open_url(&url, None::<&str>) {
                tracing::warn!("Check for Updates…: cannot open {}: {}", url, e);
            }
        });
    });
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
