//! Native macOS menu bar for the Vellis app.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::cli_install::InstallCliResult;
use crate::print::{PrintAvailability, PrintItemState};
use crate::update_check::ManualCheckOutcome;
use tauri::menu::{AboutMetadataBuilder, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Listener, Manager, Runtime, WebviewWindow, Wry};
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

/// Stable identifier for the "Save As…" menu item (requirements.md #89 契約1).
pub const SAVE_AS_ITEM_ID: &str = "save-as";

/// Event emitted to the focused window when "Save As…" is clicked
/// (requirements.md #89 契約1・2).
///
/// Same division of labour as Save: whether the window holds an editable
/// document, what it holds and where it came from are known only to the
/// window, so it asks for the path (the save dialog) and calls
/// `save_document_as` itself (`src/lib/save-as.ts`). Name must stay in sync
/// with `MENU_SAVE_AS_EVENT` there.
pub const MENU_SAVE_AS_EVENT: &str = "menu_save_as";

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

/// Stable identifier for the Edit menu's "Find and Replace…" item
/// (requirements.md #74 第3段 3-3・3-12): right after Find…. Like Find…, the
/// window decides: the code, plain-text and raw surfaces open the find bar
/// with its replace row, the others just the find bar.
pub const FIND_REPLACE_ITEM_ID: &str = "find-replace";

/// Event emitted to the focused window when Find and Replace… is clicked.
/// Same spelling as `MENU_FIND_REPLACE_EVENT` in `src/editor/cm-replace.ts`.
pub const MENU_FIND_REPLACE_EVENT: &str = "menu_find_replace";

/// Accelerator for Find and Replace…: Option + Command + F.
pub const FIND_REPLACE_ACCELERATOR: &str = "CmdOrCtrl+Alt+F";

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

/// Accelerator for the Save As… item (requirements.md #89 契約1): Shift +
/// Command + S, as macOS apps have it. A constant for the same reason as
/// `SAVE_ACCELERATOR`.
pub const SAVE_AS_ACCELERATOR: &str = "CmdOrCtrl+Shift+S";

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

/// Stable identifier for the Go menu's "Dashboard" item (requirements.md #83
/// 契約3).
pub const DASHBOARD_ITEM_ID: &str = "dashboard";

/// Event emitted to the focused window when "Dashboard" is clicked
/// (requirements.md #83 契約3).
///
/// Same division of labour as Go to Path… and Recent Files: the menu only
/// reports the gesture. Whether the window swaps its root view for the
/// Dashboard, goes back to the root behind it, or does nothing (a Dashboard with
/// nowhere to go back to) is the window's to decide (`src/lib/dashboard.ts`).
/// Name must stay in sync with `MENU_DASHBOARD_EVENT` there. No payload.
pub const MENU_DASHBOARD_EVENT: &str = "menu_dashboard";

/// Accelerator for the Dashboard item (requirements.md #83 契約3・(a)): Shift +
/// Command + H — unused (Hide is Command + H, Hide Others Option + Command + H)
/// and the key Finder gives Go ▸ Home. A constant for the same reason as
/// `GO_TO_ACCELERATOR`: tauri drops an unparseable accelerator silently, so the
/// test and the menu read the same literal.
pub const DASHBOARD_ACCELERATOR: &str = "CmdOrCtrl+Shift+H";

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

/// Stable identifier for View ▸ Reload File (requirements.md #80 契約 1・2).
pub const RELOAD_FILE_ITEM_ID: &str = "reload-file";

/// Event emitted to the focused window when View ▸ Reload File is clicked
/// (requirements.md #80 契約 2).
///
/// Same division of labour as the zoom and Open items: the menu only reports
/// the gesture. Which document the window shows, whether it has unsaved edits
/// to settle first, which command opened it and how its tree is reloaded all
/// live in the frontend (`src/lib/reload-file.ts`). Name must stay in sync
/// with `MENU_RELOAD_FILE_EVENT` there. A window with no document ignores it.
pub const MENU_RELOAD_FILE_EVENT: &str = "menu_reload_file";

/// Accelerator for View ▸ Reload File (requirements.md #80 契約 2): Command +
/// R, as Safari's Reload Page. A constant for the same reason as the zoom
/// ones: tauri drops an unparseable accelerator silently, so the test and the
/// menu read the same literal. Command + Shift + R stays Recent Files.
pub const RELOAD_FILE_ACCELERATOR: &str = "CmdOrCtrl+R";

/// Stable identifiers for View ▸ Appearance ▸ Light / Dark / System
/// (requirements.md #56 契約 3・判断 (a)). Plain items with no check mark, like
/// Show Tab Bar: which mode a window shows is the window's to know.
pub const APPEARANCE_LIGHT_ITEM_ID: &str = "appearance-light";
pub const APPEARANCE_DARK_ITEM_ID: &str = "appearance-dark";
pub const APPEARANCE_SYSTEM_ITEM_ID: &str = "appearance-system";

/// Events emitted to the focused window for Light / Dark / System
/// (requirements.md #56 契約 3).
///
/// Same shape as the zoom events: the mode is a preference of the window's
/// look, kept in its localStorage and put on `<html data-theme>`
/// (`src/lib/ui-chrome.ts`), so the menu only reports the choice. Names must
/// stay in sync with the same-named constants there.
pub const MENU_APPEARANCE_LIGHT_EVENT: &str = "menu_appearance_light";
pub const MENU_APPEARANCE_DARK_EVENT: &str = "menu_appearance_dark";
pub const MENU_APPEARANCE_SYSTEM_EVENT: &str = "menu_appearance_system";

/// Identifier of the Appearance submenu, so its theme list can be rebuilt
/// when `themes/` changes ([`rebuild_theme_items`]).
pub const APPEARANCE_MENU_ID: &str = "appearance-menu";

/// Prefix of the theme items of View ▸ Appearance (requirements.md #56 契約 3・
/// 由谷決定 8): `appearance-theme:<name>`, built from the file stems of
/// `~/.config/vellis/themes/`. The built-in Default is
/// [`APPEARANCE_DEFAULT_THEME_ITEM_ID`].
pub const APPEARANCE_THEME_ITEM_PREFIX: &str = "appearance-theme:";
pub const APPEARANCE_DEFAULT_THEME_ITEM_ID: &str = "appearance-theme:default";

/// Stable identifier for View ▸ Appearance ▸ Export Default Theme…
/// (requirements.md #56 AC-56-23・theme-architecture (e)): the last item of
/// Appearance, behind a separator. No check mark, no shortcut.
pub const EXPORT_DEFAULT_THEME_ITEM_ID: &str = "export-default-theme";

/// Stable identifier for View ▸ Toggle Full Width (requirements.md #56 契約 4・
/// 判断 (g)): no check mark, no shortcut.
pub const TOGGLE_FULL_WIDTH_ITEM_ID: &str = "toggle-full-width";

/// Event emitted to the focused window for Toggle Full Width (requirements.md
/// #56 契約 4). The window flips `<html data-doc-measure="full">` and keeps the
/// choice in localStorage (`src/lib/ui-chrome.ts`, same-named constant).
pub const MENU_TOGGLE_FULL_WIDTH_EVENT: &str = "menu_toggle_full_width";

// --- Format (requirements.md #74 契約8・第2段の作り(案)の項目 10) ------------
// Every Format item id starts with `format-`; on_menu_event forwards all of
// them through one arm to the focused window as `menu_format` (payload = id),
// where `src/editor/commands.ts` (same ids) applies the command to the
// Markdown editing surface. The items are always enabled: a window without a
// Markdown surface simply does nothing (like Save and the zoom items).

/// Prefix shared by every Format item id.
pub const FORMAT_ITEM_ID_PREFIX: &str = "format-";

/// Event emitted to the focused window for a Format item (payload = the id).
/// Same spelling as `MENU_FORMAT_EVENT` in `src/editor/commands.ts`.
pub const MENU_FORMAT_EVENT: &str = "menu_format";

/// The Format ▸ Alert submenu.
pub const FORMAT_ALERT_MENU_ID: &str = "format-alert-menu";
/// The Format ▸ Insert submenu.
pub const FORMAT_INSERT_MENU_ID: &str = "format-insert-menu";
/// The Format ▸ Table submenu (requirements.md #74 第3段 3-2・3-6・3-8): rows and
/// columns of the table under the cursor, right after Insert ▸.
pub const FORMAT_TABLE_MENU_ID: &str = "format-table-menu";
/// Format ▸ Table ▸ Insert Row Above (in the header row: a body row right below it=3-7).
pub const FORMAT_TABLE_ROW_ABOVE_ITEM_ID: &str = "format-table-row-above";
/// Format ▸ Table ▸ Insert Row Below.
pub const FORMAT_TABLE_ROW_BELOW_ITEM_ID: &str = "format-table-row-below";
/// Format ▸ Table ▸ Insert Column Left.
pub const FORMAT_TABLE_COLUMN_LEFT_ITEM_ID: &str = "format-table-column-left";
/// Format ▸ Table ▸ Insert Column Right.
pub const FORMAT_TABLE_COLUMN_RIGHT_ITEM_ID: &str = "format-table-column-right";
/// Format ▸ Table ▸ Delete Row (in the header row: the body row right below it=3-7).
pub const FORMAT_TABLE_DELETE_ROW_ITEM_ID: &str = "format-table-delete-row";
/// Format ▸ Table ▸ Delete Column (the last column takes the table with it).
pub const FORMAT_TABLE_DELETE_COLUMN_ITEM_ID: &str = "format-table-delete-column";
/// Format ▸ Table ▸ Delete Table.
pub const FORMAT_TABLE_DELETE_ITEM_ID: &str = "format-table-delete";
/// Format ▸ Bold.
pub const FORMAT_BOLD_ITEM_ID: &str = "format-bold";
pub const FORMAT_BOLD_ACCELERATOR: &str = "CmdOrCtrl+B";
/// Format ▸ Italic.
pub const FORMAT_ITALIC_ITEM_ID: &str = "format-italic";
pub const FORMAT_ITALIC_ACCELERATOR: &str = "CmdOrCtrl+I";
/// Format ▸ Strikethrough.
pub const FORMAT_STRIKETHROUGH_ITEM_ID: &str = "format-strikethrough";
pub const FORMAT_STRIKETHROUGH_ACCELERATOR: &str = "CmdOrCtrl+Shift+X";
/// Format ▸ Inline Code.
pub const FORMAT_INLINE_CODE_ITEM_ID: &str = "format-inline-code";
pub const FORMAT_INLINE_CODE_ACCELERATOR: &str = "CmdOrCtrl+Shift+C";
/// Format ▸ Link….
pub const FORMAT_LINK_ITEM_ID: &str = "format-link";
pub const FORMAT_LINK_ACCELERATOR: &str = "CmdOrCtrl+K";
/// Format ▸ Body Text.
pub const FORMAT_BODY_TEXT_ITEM_ID: &str = "format-body-text";
pub const FORMAT_BODY_TEXT_ACCELERATOR: &str = "CmdOrCtrl+Alt+0";
/// Format ▸ Heading 1.
pub const FORMAT_HEADING_1_ITEM_ID: &str = "format-heading-1";
pub const FORMAT_HEADING_1_ACCELERATOR: &str = "CmdOrCtrl+Alt+1";
/// Format ▸ Heading 2.
pub const FORMAT_HEADING_2_ITEM_ID: &str = "format-heading-2";
pub const FORMAT_HEADING_2_ACCELERATOR: &str = "CmdOrCtrl+Alt+2";
/// Format ▸ Heading 3.
pub const FORMAT_HEADING_3_ITEM_ID: &str = "format-heading-3";
pub const FORMAT_HEADING_3_ACCELERATOR: &str = "CmdOrCtrl+Alt+3";
/// Format ▸ Heading 4.
pub const FORMAT_HEADING_4_ITEM_ID: &str = "format-heading-4";
pub const FORMAT_HEADING_4_ACCELERATOR: &str = "CmdOrCtrl+Alt+4";
/// Format ▸ Heading 5.
pub const FORMAT_HEADING_5_ITEM_ID: &str = "format-heading-5";
pub const FORMAT_HEADING_5_ACCELERATOR: &str = "CmdOrCtrl+Alt+5";
/// Format ▸ Heading 6.
pub const FORMAT_HEADING_6_ITEM_ID: &str = "format-heading-6";
pub const FORMAT_HEADING_6_ACCELERATOR: &str = "CmdOrCtrl+Alt+6";
/// Format ▸ Bulleted List.
pub const FORMAT_BULLETED_LIST_ITEM_ID: &str = "format-bulleted-list";
pub const FORMAT_BULLETED_LIST_ACCELERATOR: &str = "CmdOrCtrl+Shift+8";
/// Format ▸ Numbered List.
pub const FORMAT_NUMBERED_LIST_ITEM_ID: &str = "format-numbered-list";
pub const FORMAT_NUMBERED_LIST_ACCELERATOR: &str = "CmdOrCtrl+Shift+7";
/// Format ▸ Task List.
pub const FORMAT_TASK_LIST_ITEM_ID: &str = "format-task-list";
pub const FORMAT_TASK_LIST_ACCELERATOR: &str = "CmdOrCtrl+Shift+L";
/// Format ▸ Quote.
pub const FORMAT_QUOTE_ITEM_ID: &str = "format-quote";
pub const FORMAT_QUOTE_ACCELERATOR: &str = "CmdOrCtrl+Shift+Period";
/// Format ▸ Code Block.
pub const FORMAT_CODE_BLOCK_ITEM_ID: &str = "format-code-block";
pub const FORMAT_CODE_BLOCK_ACCELERATOR: &str = "CmdOrCtrl+Alt+C";
/// Format ▸ Note.
pub const FORMAT_ALERT_NOTE_ITEM_ID: &str = "format-alert-note";
/// Format ▸ Tip.
pub const FORMAT_ALERT_TIP_ITEM_ID: &str = "format-alert-tip";
/// Format ▸ Important.
pub const FORMAT_ALERT_IMPORTANT_ITEM_ID: &str = "format-alert-important";
/// Format ▸ Warning.
pub const FORMAT_ALERT_WARNING_ITEM_ID: &str = "format-alert-warning";
/// Format ▸ Caution.
pub const FORMAT_ALERT_CAUTION_ITEM_ID: &str = "format-alert-caution";
/// Format ▸ Increase Indent.
pub const FORMAT_INDENT_ITEM_ID: &str = "format-indent";
pub const FORMAT_INDENT_ACCELERATOR: &str = "CmdOrCtrl+]";
/// Format ▸ Decrease Indent.
pub const FORMAT_OUTDENT_ITEM_ID: &str = "format-outdent";
pub const FORMAT_OUTDENT_ACCELERATOR: &str = "CmdOrCtrl+[";
/// Format ▸ Table.
pub const FORMAT_INSERT_TABLE_ITEM_ID: &str = "format-insert-table";
/// Format ▸ Horizontal Rule.
pub const FORMAT_INSERT_RULE_ITEM_ID: &str = "format-insert-rule";
/// Format ▸ Footnote.
pub const FORMAT_INSERT_FOOTNOTE_ITEM_ID: &str = "format-insert-footnote";
/// Format ▸ Image….
pub const FORMAT_INSERT_IMAGE_ITEM_ID: &str = "format-insert-image";
/// Format ▸ Clear Formatting.
pub const FORMAT_CLEAR_ITEM_ID: &str = "format-clear";

/// View ▸ Raw Source (requirements.md #74 契約23・(z)(ao)): a check item right
/// after Toggle Full Width that switches the Markdown editing surface between
/// the rendered view and the raw source (CodeMirror). The check follows the
/// front window (`raw_source_state` from the frontend, 判断 9).
pub const RAW_SOURCE_ITEM_ID: &str = "raw-source";
pub const RAW_SOURCE_ACCELERATOR: &str = "CmdOrCtrl+Alt+U";
/// Event emitted to the focused window for View ▸ Raw Source (no payload).
pub const MENU_RAW_SOURCE_EVENT: &str = "menu_raw_source";
/// Event the frontend sends with `{ label, raw }` whenever the raw state of a
/// window may have changed (its surface appeared or went away, it toggled, it
/// came to the front).
pub const RAW_SOURCE_STATE_EVENT: &str = "raw_source_state";

/// View ▸ Show Formatting Toolbar (requirements.md #74 第4段 4-2・4-5): a check
/// item right after Raw Source, unchecked at build (the toolbar is hidden by
/// default) and without an accelerator. The window decides whether it can show
/// the toolbar (the Markdown surface only); the check follows the front
/// window's report (`format_toolbar_state`), like Raw Source.
pub const SHOW_FORMAT_TOOLBAR_ITEM_ID: &str = "show-format-toolbar";
/// Event emitted to the focused window for View ▸ Show Formatting Toolbar (no payload).
/// Same spelling as `MENU_SHOW_FORMAT_TOOLBAR_EVENT` in `src/editor/format-toolbar.ts`.
pub const MENU_SHOW_FORMAT_TOOLBAR_EVENT: &str = "menu_show_format_toolbar";
/// Event the frontend sends with `{ label, shown }` whenever the toolbar state of
/// a window may have changed. Same spelling as `FORMAT_TOOLBAR_STATE_EVENT` there.
pub const FORMAT_TOOLBAR_STATE_EVENT: &str = "format_toolbar_state";

/// View ▸ Alerts (requirements.md #90 契約1): Show All / Hide All Alerts and a
/// check per GitHub Alert kind, right after Show Formatting Toolbar. Hiding and
/// collapsing happen on the screen only; the settings live in the window
/// (`localStorage`, `src/lib/alert-visibility.ts`) and are shared by all windows.
pub const ALERTS_MENU_ID: &str = "alerts-menu";
/// "Show All Alerts": enabled only while every kind is hidden.
pub const SHOW_ALL_ALERTS_ITEM_ID: &str = "show-all-alerts";
/// "Hide All Alerts": enabled while at least one kind is shown.
pub const HIDE_ALL_ALERTS_ITEM_ID: &str = "hide-all-alerts";
/// Option + Command + A toggles all alerts (決定⑨). Both Show All and Hide All
/// carry it; only the enabled one takes the key (AppKit's key equivalents), so
/// the key hides all while any kind is shown and shows all when all are hidden.
pub const TOGGLE_ALL_ALERTS_ACCELERATOR: &str = "CmdOrCtrl+Alt+A";
/// Head of the id of a kind's check item: `alerts-kind:note` and so on.
pub const ALERT_KIND_ITEM_ID_PREFIX: &str = "alerts-kind:";
/// The five kinds of requirement #15, in this order (same as `ALERT_KINDS` there).
pub const ALERT_KINDS: [&str; 5] = ["note", "tip", "important", "warning", "caution"];
/// Events emitted to the focused window (no payload / the kind as payload).
/// Same spelling as the constants of `src/lib/alert-visibility.ts`.
pub const MENU_ALERTS_SHOW_ALL_EVENT: &str = "menu_alerts_show_all";
pub const MENU_ALERTS_HIDE_ALL_EVENT: &str = "menu_alerts_hide_all";
pub const MENU_ALERTS_TOGGLE_KIND_EVENT: &str = "menu_alerts_toggle_kind";
/// Event a window sends with `{ label, visibility: { note: bool, … } }` whenever
/// the app-wide alert settings may have changed (see [`listen_alerts_state`]).
pub const ALERTS_STATE_EVENT: &str = "alerts_state";

/// View ▸ Show Audio Spectrum (requirements.md #91 contract 11): a check item right
/// after Alerts, without an accelerator. The setting is app-wide (`localStorage`,
/// `src/lib/spectrum-visibility.ts`); the item is grey unless the front window
/// shows a video or audio document.
pub const SHOW_SPECTRUM_ITEM_ID: &str = "show-audio-spectrum";
/// Event emitted to the focused window for View ▸ Show Audio Spectrum (no payload).
/// Same spelling as `MENU_SHOW_SPECTRUM_EVENT` in `src/lib/spectrum-visibility.ts`.
pub const MENU_SHOW_SPECTRUM_EVENT: &str = "menu_show_spectrum";
/// Event a window sends with `{ label, shown, available }` (see [`listen_spectrum_state`]).
pub const SPECTRUM_STATE_EVENT: &str = "spectrum_state";

/// The id of the check item of `kind` in View ▸ Alerts.
pub fn alert_kind_item_id(kind: &str) -> String {
    format!("{ALERT_KIND_ITEM_ID_PREFIX}{kind}")
}

/// The kind of a View ▸ Alerts check item id; `None` for any other id.
pub fn alert_kind_of_item_id(id: &str) -> Option<&str> {
    let rest = id.strip_prefix(ALERT_KIND_ITEM_ID_PREFIX)?;
    ALERT_KINDS.iter().copied().find(|kind| *kind == rest)
}

/// The label of the check item of `kind` (the English canonical form).
pub fn alert_kind_label(kind: &str) -> Option<&'static str> {
    match kind {
        "note" => Some("Note"),
        "tip" => Some("Tip"),
        "important" => Some("Important"),
        "warning" => Some("Warning"),
        "caution" => Some("Caution"),
        _ => None,
    }
}

/// Show All Alerts is enabled only while every kind is hidden (契約1).
pub fn show_all_alerts_enabled(shown: &[bool]) -> bool {
    !shown.iter().any(|s| *s)
}

/// Hide All Alerts is enabled while at least one kind is shown (契約1).
pub fn hide_all_alerts_enabled(shown: &[bool]) -> bool {
    shown.iter().any(|s| *s)
}

/// Stable identifier for the Window submenu, so it can be found again after
/// the menu is installed (see [`attach_windows_menu_to_nsapp`]).
pub const WINDOW_MENU_ID: &str = "window-menu";

/// Build the application's native menu bar.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // macOS の muda About ダイアログは `<version> (<short_version>)` の順で
    // 連結して表示する (NSApp 標準の `Version X (Y)` 慣習と field の対応は逆)。
    // 主表示の semver を `version` に、build 識別子を `short_version` に入れる。
    // `comments` にはビルド日時のみ載せる (macOS の About には出ない)。
    // 開発版 (要件87 契約2) は版の名前 `dev-<開発名> #<n>(日時)` を、About の
    // 下の行 (`copyright` の欄) に出す。release / dev は名前が空なので出さない。
    let build_name = env!("VELLIS_BUILD_NAME");
    let about_metadata = AboutMetadataBuilder::new()
        .name(Some("Vellis"))
        .version(Some(env!("CARGO_PKG_VERSION").to_string()))
        .short_version(Some(env!("VELLIS_BUILD_NUMBER").to_string()))
        .copyright((!build_name.is_empty()).then(|| build_name.to_string()))
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
    // Save As… right after Save (requirements.md #89 契約1). Enabled like Save:
    // the window decides whether it does anything (an editable document) or
    // ignores the event.
    let save_as_item = MenuItem::with_id(app, SAVE_AS_ITEM_ID, "Save As…", true, Some(SAVE_AS_ACCELERATOR))?;
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
            &save_as_item,
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
    // The separator after the standard block, in front of Find…. (Edit ▸ Edit
    // went with the current editing: a document is editable as soon as it is
    // open — requirements.md #74 契約3・(ad).)
    let edit_mode_sep = PredefinedMenuItem::separator(app)?;
    // 文書内検索 (requirements.md #54 契約①). Sits next to Edit, after the
    // standard block, so the macOS ordering every app shares stays where users
    // expect it. Enabled unconditionally, like Edit and Save: only the window
    // knows whether what it displays has any text to search, so a PDF or an
    // image window simply ignores the event.
    let find_item = MenuItem::with_id(app, FIND_ITEM_ID, "Find…", true, Some(FIND_ACCELERATOR))?;
    // Find and Replace… (requirements.md #74 第3段 3-12): right after Find….
    let find_replace_item = MenuItem::with_id(app, FIND_REPLACE_ITEM_ID, "Find and Replace…", true, Some(FIND_REPLACE_ACCELERATOR))?;
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
            &find_item,
            &find_replace_item,
            &find_in_folder_item,
        ],
    )?;
    // Format (requirements.md #74 契約8・判断 4): between Edit and View, the way
    // macOS text apps place it. Always built (契約21: the editor is a regular feature).
    let format_bold_item = MenuItem::with_id(app, FORMAT_BOLD_ITEM_ID, "Bold", true, Some(FORMAT_BOLD_ACCELERATOR))?;
    let format_italic_item = MenuItem::with_id(app, FORMAT_ITALIC_ITEM_ID, "Italic", true, Some(FORMAT_ITALIC_ACCELERATOR))?;
    let format_strikethrough_item = MenuItem::with_id(app, FORMAT_STRIKETHROUGH_ITEM_ID, "Strikethrough", true, Some(FORMAT_STRIKETHROUGH_ACCELERATOR))?;
    let format_inline_code_item = MenuItem::with_id(app, FORMAT_INLINE_CODE_ITEM_ID, "Inline Code", true, Some(FORMAT_INLINE_CODE_ACCELERATOR))?;
    let format_link_item = MenuItem::with_id(app, FORMAT_LINK_ITEM_ID, "Link…", true, Some(FORMAT_LINK_ACCELERATOR))?;
    let format_body_text_item = MenuItem::with_id(app, FORMAT_BODY_TEXT_ITEM_ID, "Body Text", true, Some(FORMAT_BODY_TEXT_ACCELERATOR))?;
    let format_heading_1_item = MenuItem::with_id(app, FORMAT_HEADING_1_ITEM_ID, "Heading 1", true, Some(FORMAT_HEADING_1_ACCELERATOR))?;
    let format_heading_2_item = MenuItem::with_id(app, FORMAT_HEADING_2_ITEM_ID, "Heading 2", true, Some(FORMAT_HEADING_2_ACCELERATOR))?;
    let format_heading_3_item = MenuItem::with_id(app, FORMAT_HEADING_3_ITEM_ID, "Heading 3", true, Some(FORMAT_HEADING_3_ACCELERATOR))?;
    let format_heading_4_item = MenuItem::with_id(app, FORMAT_HEADING_4_ITEM_ID, "Heading 4", true, Some(FORMAT_HEADING_4_ACCELERATOR))?;
    let format_heading_5_item = MenuItem::with_id(app, FORMAT_HEADING_5_ITEM_ID, "Heading 5", true, Some(FORMAT_HEADING_5_ACCELERATOR))?;
    let format_heading_6_item = MenuItem::with_id(app, FORMAT_HEADING_6_ITEM_ID, "Heading 6", true, Some(FORMAT_HEADING_6_ACCELERATOR))?;
    let format_bulleted_list_item = MenuItem::with_id(app, FORMAT_BULLETED_LIST_ITEM_ID, "Bulleted List", true, Some(FORMAT_BULLETED_LIST_ACCELERATOR))?;
    let format_numbered_list_item = MenuItem::with_id(app, FORMAT_NUMBERED_LIST_ITEM_ID, "Numbered List", true, Some(FORMAT_NUMBERED_LIST_ACCELERATOR))?;
    let format_task_list_item = MenuItem::with_id(app, FORMAT_TASK_LIST_ITEM_ID, "Task List", true, Some(FORMAT_TASK_LIST_ACCELERATOR))?;
    let format_quote_item = MenuItem::with_id(app, FORMAT_QUOTE_ITEM_ID, "Quote", true, Some(FORMAT_QUOTE_ACCELERATOR))?;
    let format_code_block_item = MenuItem::with_id(app, FORMAT_CODE_BLOCK_ITEM_ID, "Code Block", true, Some(FORMAT_CODE_BLOCK_ACCELERATOR))?;
    let format_alert_note_item = MenuItem::with_id(app, FORMAT_ALERT_NOTE_ITEM_ID, "Note", true, None::<&str>)?;
    let format_alert_tip_item = MenuItem::with_id(app, FORMAT_ALERT_TIP_ITEM_ID, "Tip", true, None::<&str>)?;
    let format_alert_important_item = MenuItem::with_id(app, FORMAT_ALERT_IMPORTANT_ITEM_ID, "Important", true, None::<&str>)?;
    let format_alert_warning_item = MenuItem::with_id(app, FORMAT_ALERT_WARNING_ITEM_ID, "Warning", true, None::<&str>)?;
    let format_alert_caution_item = MenuItem::with_id(app, FORMAT_ALERT_CAUTION_ITEM_ID, "Caution", true, None::<&str>)?;
    let format_indent_item = MenuItem::with_id(app, FORMAT_INDENT_ITEM_ID, "Increase Indent", true, Some(FORMAT_INDENT_ACCELERATOR))?;
    let format_outdent_item = MenuItem::with_id(app, FORMAT_OUTDENT_ITEM_ID, "Decrease Indent", true, Some(FORMAT_OUTDENT_ACCELERATOR))?;
    let format_insert_table_item = MenuItem::with_id(app, FORMAT_INSERT_TABLE_ITEM_ID, "Table", true, None::<&str>)?;
    let format_insert_rule_item = MenuItem::with_id(app, FORMAT_INSERT_RULE_ITEM_ID, "Horizontal Rule", true, None::<&str>)?;
    let format_insert_footnote_item = MenuItem::with_id(app, FORMAT_INSERT_FOOTNOTE_ITEM_ID, "Footnote", true, None::<&str>)?;
    let format_insert_image_item = MenuItem::with_id(app, FORMAT_INSERT_IMAGE_ITEM_ID, "Image…", true, None::<&str>)?;
    let format_clear_item = MenuItem::with_id(app, FORMAT_CLEAR_ITEM_ID, "Clear Formatting", true, None::<&str>)?;
    // Format ▸ Table ▸ (第3段 3-2): no accelerators (3-9).
    let format_table_row_above_item = MenuItem::with_id(app, FORMAT_TABLE_ROW_ABOVE_ITEM_ID, "Insert Row Above", true, None::<&str>)?;
    let format_table_row_below_item = MenuItem::with_id(app, FORMAT_TABLE_ROW_BELOW_ITEM_ID, "Insert Row Below", true, None::<&str>)?;
    let format_table_column_left_item = MenuItem::with_id(app, FORMAT_TABLE_COLUMN_LEFT_ITEM_ID, "Insert Column Left", true, None::<&str>)?;
    let format_table_column_right_item = MenuItem::with_id(app, FORMAT_TABLE_COLUMN_RIGHT_ITEM_ID, "Insert Column Right", true, None::<&str>)?;
    let format_table_delete_row_item = MenuItem::with_id(app, FORMAT_TABLE_DELETE_ROW_ITEM_ID, "Delete Row", true, None::<&str>)?;
    let format_table_delete_column_item = MenuItem::with_id(app, FORMAT_TABLE_DELETE_COLUMN_ITEM_ID, "Delete Column", true, None::<&str>)?;
    let format_table_delete_item = MenuItem::with_id(app, FORMAT_TABLE_DELETE_ITEM_ID, "Delete Table", true, None::<&str>)?;
    let format_table_sep = PredefinedMenuItem::separator(app)?;
    let format_sep1 = PredefinedMenuItem::separator(app)?;
    let format_sep2 = PredefinedMenuItem::separator(app)?;
    let format_sep3 = PredefinedMenuItem::separator(app)?;
    let format_sep4 = PredefinedMenuItem::separator(app)?;
    let format_sep5 = PredefinedMenuItem::separator(app)?;
    let format_alert_menu = Submenu::with_id_and_items(app, FORMAT_ALERT_MENU_ID, "Alert", true, &[&format_alert_note_item, &format_alert_tip_item, &format_alert_important_item, &format_alert_warning_item, &format_alert_caution_item])?;
    let format_insert_menu = Submenu::with_id_and_items(app, FORMAT_INSERT_MENU_ID, "Insert", true, &[&format_insert_table_item, &format_insert_rule_item, &format_insert_footnote_item, &format_insert_image_item])?;
    let format_table_menu = Submenu::with_id_and_items(app, FORMAT_TABLE_MENU_ID, "Table", true, &[&format_table_row_above_item, &format_table_row_below_item, &format_table_column_left_item, &format_table_column_right_item, &format_table_sep, &format_table_delete_row_item, &format_table_delete_column_item, &format_table_delete_item])?;
    let format_menu = Submenu::with_items(
        app,
        "Format",
        true,
        &[
            &format_bold_item,
            &format_italic_item,
            &format_strikethrough_item,
            &format_inline_code_item,
            &format_link_item,
            &format_sep1,
            &format_body_text_item,
            &format_heading_1_item,
            &format_heading_2_item,
            &format_heading_3_item,
            &format_heading_4_item,
            &format_heading_5_item,
            &format_heading_6_item,
            &format_sep2,
            &format_bulleted_list_item,
            &format_numbered_list_item,
            &format_task_list_item,
            &format_quote_item,
            &format_code_block_item,
            &format_alert_menu,
            &format_sep3,
            &format_indent_item,
            &format_outdent_item,
            &format_sep4,
            &format_insert_menu,
            &format_table_menu,
            &format_sep5,
            &format_clear_item,
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
    // Reload File sits right under the tab items, behind its own separator
    // (requirements.md #80 契約 2), where Safari's View menu keeps Reload Page.
    // Always enabled: a window with no document simply ignores the event.
    let reload_file_item = MenuItem::with_id(
        app,
        RELOAD_FILE_ITEM_ID,
        "Reload File",
        true,
        Some(RELOAD_FILE_ACCELERATOR),
    )?;
    let view_reload_sep = PredefinedMenuItem::separator(app)?;
    // Appearance and Toggle Full Width sit under the tab items, above the zoom
    // ones, so the items about the look stay together (requirements.md #56
    // 契約 3・4, 2026-11-02 由谷決定). Appearance holds the mode (Light / Dark /
    // System) and, behind a separator, the theme: the built-in Default and the
    // files of ~/.config/vellis/themes/ (由谷決定 8). None of them carries a check
    // mark; choosing a theme rewrites `appearance.theme` in settings.json.
    let appearance_light_item = MenuItem::with_id(
        app,
        APPEARANCE_LIGHT_ITEM_ID,
        "Light",
        true,
        None::<&str>,
    )?;
    let appearance_dark_item = MenuItem::with_id(
        app,
        APPEARANCE_DARK_ITEM_ID,
        "Dark",
        true,
        None::<&str>,
    )?;
    let appearance_system_item = MenuItem::with_id(
        app,
        APPEARANCE_SYSTEM_ITEM_ID,
        "System",
        true,
        None::<&str>,
    )?;
    let appearance_theme_sep = PredefinedMenuItem::separator(app)?;
    let appearance_default_item = MenuItem::with_id(
        app,
        APPEARANCE_DEFAULT_THEME_ITEM_ID,
        "Default",
        true,
        None::<&str>,
    )?;
    // Export Default Theme… closes the submenu behind its own separator
    // (requirements.md #56 AC-56-23): it writes the Default theme into
    // themes/ and opens it, all in Rust like Settings….
    let appearance_export_sep = PredefinedMenuItem::separator(app)?;
    let export_default_theme_item = MenuItem::with_id(
        app,
        EXPORT_DEFAULT_THEME_ITEM_ID,
        "Export Default Theme…",
        true,
        None::<&str>,
    )?;
    let appearance_menu = Submenu::with_id_and_items(
        app,
        APPEARANCE_MENU_ID,
        "Appearance",
        true,
        &[
            &appearance_light_item,
            &appearance_dark_item,
            &appearance_system_item,
            &appearance_theme_sep,
            &appearance_default_item,
            &appearance_export_sep,
            &export_default_theme_item,
        ],
    )?;
    // The files of themes/ go right under Default, before the separator of
    // Export (the same items `rebuild_theme_items` makes when themes/ changes).
    for (offset, name) in crate::theme::installed_themes().names.iter().enumerate() {
        appearance_menu.insert(&theme_item(app, name)?, THEME_LIST_START + offset)?;
    }
    let toggle_full_width_item = MenuItem::with_id(
        app,
        TOGGLE_FULL_WIDTH_ITEM_ID,
        "Toggle Full Width",
        true,
        None::<&str>,
    )?;
    let raw_source_item = CheckMenuItem::with_id(app, RAW_SOURCE_ITEM_ID, "Raw Source", true, false, Some(RAW_SOURCE_ACCELERATOR))?;
    // 第4段 4-2(4-5): the formatting toolbar, hidden by default, no accelerator.
    let show_format_toolbar_item = CheckMenuItem::with_id(app, SHOW_FORMAT_TOOLBAR_ITEM_ID, "Show Formatting Toolbar", true, false, None::<&str>)?;
    // 要件#90 契約1: View ▸ Alerts. Built with everything shown (the default);
    // the window's `alerts_state` brings the checks and the enabled items in line.
    let show_all_alerts_item = MenuItem::with_id(app, SHOW_ALL_ALERTS_ITEM_ID, "Show All Alerts", false, Some(TOGGLE_ALL_ALERTS_ACCELERATOR))?;
    let hide_all_alerts_item = MenuItem::with_id(app, HIDE_ALL_ALERTS_ITEM_ID, "Hide All Alerts", true, Some(TOGGLE_ALL_ALERTS_ACCELERATOR))?;
    let alerts_kind_sep = PredefinedMenuItem::separator(app)?;
    let alerts_note_item = alert_kind_item(app, "note")?;
    let alerts_tip_item = alert_kind_item(app, "tip")?;
    let alerts_important_item = alert_kind_item(app, "important")?;
    let alerts_warning_item = alert_kind_item(app, "warning")?;
    let alerts_caution_item = alert_kind_item(app, "caution")?;
    let alerts_menu = Submenu::with_id_and_items(app, ALERTS_MENU_ID, "Alerts", true, &[&show_all_alerts_item, &hide_all_alerts_item, &alerts_kind_sep, &alerts_note_item, &alerts_tip_item, &alerts_important_item, &alerts_warning_item, &alerts_caution_item])?;
    // Requirement #91 contract 11: grey until a window reports a video / audio document, checked (shown by default).
    let show_spectrum_item = CheckMenuItem::with_id(app, SHOW_SPECTRUM_ITEM_ID, "Show Audio Spectrum", false, true, None::<&str>)?;
    let view_chrome_sep = PredefinedMenuItem::separator(app)?;
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
            &reload_file_item,
            &view_reload_sep,
            &appearance_menu,
            &toggle_full_width_item,
            &raw_source_item,
            &show_format_toolbar_item,
            &alerts_menu,
            &show_spectrum_item,
            &view_chrome_sep,
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
    // Dashboard (requirements.md #83 契約3・(v)) comes last, behind a separator
    // of its own: it swaps the whole window view rather than moving inside the
    // root. No ellipsis — it is not a dialog. Always enabled, like the two above.
    let go_dashboard_sep = PredefinedMenuItem::separator(app)?;
    let dashboard_item =
        MenuItem::with_id(app, DASHBOARD_ITEM_ID, "Dashboard", true, Some(DASHBOARD_ACCELERATOR))?;
    let go_menu = Submenu::with_items(
        app,
        "Go",
        true,
        &[&go_to_item, &recent_files_item, &go_dashboard_sep, &dashboard_item],
    )?;

    let menu = Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &format_menu,
            &view_menu,
            &go_menu,
            &window_menu,
        ],
    )?;
    Ok(menu)
}

/// Position of the first theme of `themes/` in View ▸ Appearance: after Light,
/// Dark, System, the separator and Default.
const THEME_LIST_START: usize = 5;

/// The View ▸ Appearance item of the user's theme `name` (a file stem of
/// `themes/`, labelled as it is).
fn theme_item<R: Runtime>(app: &AppHandle<R>, name: &str) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(
        app,
        format!("{APPEARANCE_THEME_ITEM_PREFIX}{name}"),
        name,
        true,
        None::<&str>,
    )
}

/// The View ▸ Alerts check item of `kind`: enabled, checked (shown by default),
/// no accelerator. The single place the five kind items are made.
fn alert_kind_item<R: Runtime>(app: &AppHandle<R>, kind: &str) -> tauri::Result<CheckMenuItem<R>> {
    CheckMenuItem::with_id(app, alert_kind_item_id(kind), alert_kind_label(kind).unwrap_or(kind), true, true, None::<&str>)
}

/// Replace the theme list of View ▸ Appearance with `names` — called when the
/// files of `themes/` changed (requirements.md #56 契約 3). The items before
/// it (the modes, the separator, Default) stay. The separator and Export
/// Default Theme… after it are taken off and appended again behind the new
/// list, so Export stays the last item. Failures are logged: a stale list
/// still works, and a theme can be chosen in settings.json too.
pub fn rebuild_theme_items<R: Runtime>(app: &AppHandle<R>, names: &[String]) {
    let appearance = app.menu().and_then(|menu| {
        menu.items().unwrap_or_default().into_iter().find_map(|kind| {
            kind.as_submenu()
                .and_then(|submenu| submenu.get(APPEARANCE_MENU_ID))
                .and_then(|found| found.as_submenu().cloned())
        })
    });
    let Some(appearance) = appearance else {
        tracing::warn!("Appearance submenu '{}' not found in the app menu", APPEARANCE_MENU_ID);
        return;
    };
    let items = appearance.items().unwrap_or_default();
    // Export Default Theme… and the separator right above it.
    let tail: Vec<_> = match items
        .iter()
        .position(|item| item.id().as_ref() == EXPORT_DEFAULT_THEME_ITEM_ID)
    {
        Some(at) if at > 0 && items[at - 1].as_predefined_menuitem().is_some() => {
            items[at - 1..=at].to_vec()
        }
        Some(at) => vec![items[at].clone()],
        None => Vec::new(),
    };
    for item in &items {
        let id = item.id().as_ref();
        let theme = id.starts_with(APPEARANCE_THEME_ITEM_PREFIX) && id != APPEARANCE_DEFAULT_THEME_ITEM_ID;
        if theme || tail.iter().any(|kept| kept.id() == item.id()) {
            if let Err(e) = appearance.remove(item) {
                tracing::warn!("failed to remove the Appearance item '{}': {}", id, e);
            }
        }
    }
    for name in names {
        if let Err(e) = theme_item(app, name).and_then(|item| appearance.append(&item)) {
            tracing::warn!("failed to add the theme item '{}': {}", name, e);
        }
    }
    for item in &tail {
        if let Err(e) = appearance.append(item) {
            tracing::warn!("failed to put back the Appearance item '{}': {}", item.id().as_ref(), e);
        }
    }
}

/// Handle a theme of View ▸ Appearance (requirements.md #56 契約 3・由谷決定 8):
/// write `name` as `appearance.theme` into settings.json — that key only, the
/// others keep their order; a missing file is created like Settings… does. A
/// broken file is left as it is, with one dialog.
///
/// Nothing is sent to the windows from here: the theme watcher (`theme.rs`)
/// sees the write and broadcasts the resolved theme, so there is one route.
/// It is only asked to look now, in case the settings folder is new.
pub fn handle_appearance_theme_click(app: &AppHandle<Wry>, name: &str) {
    let Some(path) = crate::settings::default_settings_path() else {
        tracing::warn!("Appearance: no home directory to keep the settings file in");
        return;
    };
    if let Err(message) = crate::theme::set_appearance_theme(&path, name) {
        tracing::warn!("Appearance: {}", message);
        app.dialog()
            .message(message)
            .title("Vellis Theme")
            .kind(MessageDialogKind::Warning)
            .show(|_| {});
        return;
    }
    crate::theme::poke_watcher(app);
}

/// Handle View ▸ Appearance ▸ Export Default Theme… (requirements.md #56
/// AC-56-23・theme-architecture (e)). Everything stays in Rust, like Settings…:
/// the whole Default theme is written into `~/.config/vellis/themes/` as
/// `my-theme.json` (or the next free `my-theme-<n>.json` — an existing file is
/// never overwritten), then a new window opens with that folder as its root
/// and the written file as its document (requirements.md #74 (ah): always a
/// Vellis window, where the theme is edited).
///
/// Nothing is sent to the windows: the theme watcher sees the new file and
/// rebuilds the Appearance list (it is only asked to look now, in case the
/// folder is new). A failure to write is shown in one dialog.
pub fn handle_export_default_theme_click(app: &AppHandle<Wry>) {
    let Some(folder) = crate::theme::themes_dir() else {
        tracing::warn!("Export Default Theme…: no home directory to keep the themes in");
        return;
    };
    let written = match crate::theme::export_default_theme(&folder, env!("CARGO_PKG_VERSION")) {
        Ok(path) => path,
        Err(message) => {
            tracing::warn!("Export Default Theme…: {}", message);
            app.dialog()
                .message(message)
                .title("Vellis Theme")
                .kind(MessageDialogKind::Warning)
                .show(|_| {});
            return;
        }
    };
    crate::theme::poke_watcher(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let document = format!("file://{}", written.display());
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
            tracing::warn!("Export Default Theme…: failed to open the theme window: {}", e);
        }
    });
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
///
/// Since 追補f (backlog 251) the event goes out only when the frontmost window
/// has reported a printable document. The item is greyed out for any other
/// window ([`sync_print_item`]), so this is the second stop, for a click that
/// races a report — a window on the history picker or the empty state would
/// otherwise open the print dialog on a blank sheet.
///
/// Since 追補i (backlog 253) the target comes from [`print_click_target`]
/// over every window, print windows included, rather than from
/// [`focused_or_first_window`]. That helper skips print windows, so with a
/// print window in front it fell back to a document window behind it and
/// started printing there; now a click with a print window in front does
/// nothing (the intended no-op of backlog #91).
pub fn handle_print_click(app: &AppHandle<Wry>) {
    let windows: Vec<(String, bool)> = app
        .webview_windows()
        .values()
        .map(|w| (w.label().to_string(), w.is_focused().unwrap_or(false)))
        .collect();
    let borrowed: Vec<(&str, bool)> = windows
        .iter()
        .map(|(label, focused)| (label.as_str(), *focused))
        .collect();
    let Some(label) = print_click_target(&borrowed) else {
        return;
    };
    let enabled = app
        .try_state::<PrintAvailability>()
        .is_some_and(|state| state.print_item_state(label) == PrintItemState::Enabled);
    if !enabled {
        return;
    }
    if let Err(e) = app.emit_to(label, MENU_PRINT_EVENT, ()) {
        tracing::warn!("failed to emit {} to '{}': {}", MENU_PRINT_EVENT, label, e);
    }
}

/// The window File > Print… applies to (requirements.md #38 追補i).
///
/// `windows` is `(label, focused)` for every webview window, print windows
/// included, in `app.webview_windows()` order.
/// - If any focused window is a print window, `None`: the click is a no-op
///   rather than printing a document window behind it (backlog 253).
/// - Otherwise the first focused document window.
/// - Otherwise the first document window.
/// - `None` when there are no document windows.
pub fn print_click_target<'a>(windows: &[(&'a str, bool)]) -> Option<&'a str> {
    let is_print = |label: &str| crate::print::is_print_window(label);
    if windows.iter().any(|&(label, focused)| focused && is_print(label)) {
        return None;
    }
    let mut documents = windows.iter().filter(|&&(label, _)| !is_print(label));
    let first = documents.clone().next().map(|&(label, _)| label);
    documents
        .find(|&&(_, focused)| focused)
        .map(|&(label, _)| label)
        .or(first)
}

/// Enable or disable File > Print… for the window `label` that is now
/// frontmost (requirements.md #38 追補f).
///
/// Called when a window gains focus and when the frontmost window reports
/// whether it has a printable document (`set_print_available`). A print
/// window answers [`PrintItemState::Unchanged`] and the item is left as it was.
///
/// The item sits inside the File submenu, and `Menu::get` only looks at the
/// top level, so the lookup walks the submenus ([`find_menu_item`]). Failures
/// are logged: a Print… item stuck in the wrong state is still guarded by
/// [`handle_print_click`] and by the frontend.
pub fn sync_print_item(app: &AppHandle<Wry>, label: &str) {
    let Some(state) = app.try_state::<PrintAvailability>() else {
        return;
    };
    let enabled = match state.print_item_state(label) {
        PrintItemState::Enabled => true,
        PrintItemState::Disabled => false,
        PrintItemState::Unchanged => return,
    };
    let Some(item) = app.menu().and_then(|menu| find_menu_item(&menu, PRINT_ITEM_ID)) else {
        tracing::warn!("Print… item '{}' not found in the app menu", PRINT_ITEM_ID);
        return;
    };
    if let Err(e) = item.set_enabled(enabled) {
        tracing::warn!("failed to set the Print… item enabled={}: {}", enabled, e);
    }
}

/// Emit `event` with `payload` to the focused window only (requirements.md #74
/// 契約8: a Format item carries its id). The payload-less sibling is
/// [`handle_menu_open_click`].
pub fn emit_to_focused<S: serde::Serialize + Clone>(app: &AppHandle<Wry>, event: &str, payload: S) {
    let Some(window) = focused_or_first_window(app) else {
        return;
    };
    if let Err(e) = app.emit_to(window.label(), event, payload) {
        tracing::warn!("failed to emit {} to '{}': {}", event, window.label(), e);
    }
}

/// The payload of [`RAW_SOURCE_STATE_EVENT`].
#[derive(serde::Deserialize)]
struct RawSourceState {
    label: String,
    raw: bool,
}

/// Keep the check of View ▸ Raw Source on the front window's value
/// (requirements.md #74 契約23・判断 9). The frontend sends `{ label, raw }`
/// when its surface appears or goes away, when it toggles and when its window
/// comes to the front; only the front window's report moves the check. No
/// Tauri command: the frontend emits an event.
pub fn listen_raw_source_state(app: &AppHandle<Wry>) {
    let handle = app.clone();
    app.listen(RAW_SOURCE_STATE_EVENT, move |event| {
        let state: RawSourceState = match serde_json::from_str(event.payload()) {
            Ok(state) => state,
            Err(e) => {
                tracing::warn!("{}: unreadable payload: {}", RAW_SOURCE_STATE_EVENT, e);
                return;
            }
        };
        let label = state.label;
        let raw = state.raw;
        let front = focused_or_first_window(&handle).map(|w| w.label().to_string());
        if !raw_check_applies(front.as_deref(), &label) {
            return;
        }
        let Some(item) = handle.menu().and_then(|menu| find_check_menu_item(&menu, RAW_SOURCE_ITEM_ID)) else {
            return;
        };
        if let Err(e) = item.set_checked(raw) {
            tracing::warn!("failed to set the Raw Source check to {}: {}", raw, e);
        }
    });
}

/// The payload of [`FORMAT_TOOLBAR_STATE_EVENT`].
#[derive(serde::Deserialize)]
struct FormatToolbarState {
    label: String,
    shown: bool,
}

/// Keep the check of View ▸ Show Formatting Toolbar on the front window's value
/// (requirements.md #74 第4段 4-2), the same way as Raw Source: only the front
/// window's report moves the check. No Tauri command: the frontend emits an event.
pub fn listen_format_toolbar_state(app: &AppHandle<Wry>) {
    let handle = app.clone();
    app.listen(FORMAT_TOOLBAR_STATE_EVENT, move |event| {
        let state: FormatToolbarState = match serde_json::from_str(event.payload()) {
            Ok(state) => state,
            Err(e) => {
                tracing::warn!("{}: unreadable payload: {}", FORMAT_TOOLBAR_STATE_EVENT, e);
                return;
            }
        };
        let front = focused_or_first_window(&handle).map(|w| w.label().to_string());
        if !raw_check_applies(front.as_deref(), &state.label) {
            return;
        }
        let Some(item) = handle.menu().and_then(|menu| find_check_menu_item(&menu, SHOW_FORMAT_TOOLBAR_ITEM_ID)) else {
            return;
        };
        if let Err(e) = item.set_checked(state.shown) {
            tracing::warn!("failed to set the Show Formatting Toolbar check to {}: {}", state.shown, e);
        }
    });
}

/// The payload of [`ALERTS_STATE_EVENT`]. The sender's `label` is not read: the
/// settings are app-wide, so any window's report applies.
#[derive(serde::Deserialize)]
struct AlertsState {
    visibility: std::collections::HashMap<String, bool>,
}

/// The View ▸ Alerts submenu (two levels down: menu bar ▸ View ▸ Alerts).
fn find_alerts_submenu<R: Runtime>(menu: &Menu<R>) -> Option<Submenu<R>> {
    menu.items().unwrap_or_default().into_iter().find_map(|kind| {
        kind.as_submenu()
            .and_then(|submenu| submenu.get(ALERTS_MENU_ID))
            .and_then(|found| found.as_submenu().cloned())
    })
}

/// Keep View ▸ Alerts on the app-wide settings (requirements.md #90 契約1・7):
/// each kind's check is its "shown", Show All is enabled only while all are
/// hidden and Hide All while any is shown — so Option + Command + A reaches the
/// right one. A kind item flipped by muda's own click is set again here from
/// the window's report (no `revert_check_toggle`). No Tauri command: the
/// frontend emits an event.
pub fn listen_alerts_state(app: &AppHandle<Wry>) {
    let handle = app.clone();
    app.listen(ALERTS_STATE_EVENT, move |event| {
        let state: AlertsState = match serde_json::from_str(event.payload()) {
            Ok(state) => state,
            Err(e) => {
                tracing::warn!("{}: unreadable payload: {}", ALERTS_STATE_EVENT, e);
                return;
            }
        };
        let shown: Vec<bool> = ALERT_KINDS
            .iter()
            .map(|kind| state.visibility.get(*kind).copied().unwrap_or(true))
            .collect();
        let Some(alerts) = handle.menu().and_then(|menu| find_alerts_submenu(&menu)) else {
            tracing::warn!("Alerts submenu '{}' not found in the app menu", ALERTS_MENU_ID);
            return;
        };
        for (kind, on) in ALERT_KINDS.iter().zip(shown.iter()) {
            let id = alert_kind_item_id(kind);
            let Some(item) = alerts.get(&id).and_then(|found| found.as_check_menuitem().cloned()) else {
                continue;
            };
            if let Err(e) = item.set_checked(*on) {
                tracing::warn!("failed to set the check of {} to {}: {}", id, on, e);
            }
        }
        for (id, enabled) in [
            (SHOW_ALL_ALERTS_ITEM_ID, show_all_alerts_enabled(&shown)),
            (HIDE_ALL_ALERTS_ITEM_ID, hide_all_alerts_enabled(&shown)),
        ] {
            let Some(item) = alerts.get(id).and_then(|found| found.as_menuitem().cloned()) else {
                continue;
            };
            if let Err(e) = item.set_enabled(enabled) {
                tracing::warn!("failed to set {} enabled={}: {}", id, enabled, e);
            }
        }
    });
}

/// The payload of [`SPECTRUM_STATE_EVENT`]: the app-wide setting and whether the
/// sending window shows a video or audio document.
#[derive(serde::Deserialize)]
struct SpectrumState {
    label: String,
    shown: bool,
    available: bool,
}

/// Keep View ▸ Show Audio Spectrum on the windows' reports (requirements.md #91
/// contract 11): the check is the app-wide `shown`, so any window's report sets
/// it; the item is enabled only by the front window's `available`, as Raw Source
/// follows the front window. muda's own click flip is set again here from the
/// window's answer (no `revert_check_toggle`).
pub fn listen_spectrum_state(app: &AppHandle<Wry>) {
    let handle = app.clone();
    app.listen(SPECTRUM_STATE_EVENT, move |event| {
        let state: SpectrumState = match serde_json::from_str(event.payload()) {
            Ok(state) => state,
            Err(e) => {
                tracing::warn!("{}: unreadable payload: {}", SPECTRUM_STATE_EVENT, e);
                return;
            }
        };
        let Some(item) = handle.menu().and_then(|menu| find_check_menu_item(&menu, SHOW_SPECTRUM_ITEM_ID)) else {
            return;
        };
        if let Err(e) = item.set_checked(state.shown) {
            tracing::warn!("failed to set the Show Audio Spectrum check to {}: {}", state.shown, e);
        }
        let front = focused_or_first_window(&handle).map(|w| w.label().to_string());
        if !raw_check_applies(front.as_deref(), &state.label) {
            return;
        }
        if let Err(e) = item.set_enabled(state.available) {
            tracing::warn!("failed to set Show Audio Spectrum enabled={}: {}", state.available, e);
        }
    });
}

/// muda flips a `CheckMenuItem`'s check on every click before the event arrives.
/// Undo that flip so the check of View ▸ Raw Source / Show Formatting Toolbar
/// follows only the window's report (`raw_source_state` / `format_toolbar_state`,
/// see [`listen_raw_source_state`] / [`listen_format_toolbar_state`]). A surface
/// with no listener (code, text, image, Dashboard …) then leaves the check as is.
pub fn revert_check_toggle(app: &AppHandle<Wry>, id: &str) {
    let Some(item) = app.menu().and_then(|menu| find_check_menu_item(&menu, id)) else {
        return;
    };
    match item.is_checked() {
        Ok(checked) => {
            if let Err(e) = item.set_checked(!checked) {
                tracing::warn!("failed to revert the check of {}: {}", id, e);
            }
        }
        Err(e) => tracing::warn!("failed to read the check of {}: {}", id, e),
    }
}

/// Whether a `raw_source_state` report from the window `label` moves the check
/// of View ▸ Raw Source: only the front window's value does (判断 9).
pub fn raw_check_applies(front: Option<&str>, label: &str) -> bool {
    front == Some(label)
}

/// The check menu item `id`, at the top level of `menu` or one level down in a
/// submenu (see [`find_menu_item`]).
fn find_check_menu_item<R: Runtime>(menu: &Menu<R>, id: &str) -> Option<CheckMenuItem<R>> {
    if let Some(item) = menu.get(id).and_then(|kind| kind.as_check_menuitem().cloned()) {
        return Some(item);
    }
    menu.items().unwrap_or_default().into_iter().find_map(|kind| {
        kind.as_submenu()
            .and_then(|submenu| submenu.get(id))
            .and_then(|found| found.as_check_menuitem().cloned())
    })
}

/// The plain menu item `id`, looked up at the top level of `menu` and then one
/// level down in each submenu — where every item of this app's menu bar lives.
fn find_menu_item<R: Runtime>(menu: &Menu<R>, id: &str) -> Option<MenuItem<R>> {
    if let Some(item) = menu.get(id).and_then(|kind| kind.as_menuitem().cloned()) {
        return Some(item);
    }
    menu.items().unwrap_or_default().into_iter().find_map(|kind| {
        kind.as_submenu()
            .and_then(|submenu| submenu.get(id))
            .and_then(|found| found.as_menuitem().cloned())
    })
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
/// uses, so both routes register identical `WindowArgs` and both place the
/// window the same way: 24px down and to the right of the front window, or
/// centred when there is none (requirements.md #12 追補b). The window-state
/// plugin restores only the first window of a launch (`main`), never a window
/// opened later.
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
/// JSON, i.e. text, so it is edited and saved in the code editor of
/// requirements.md #74 (契約5・(ah)). Failures are logged: the menu has
/// nowhere to return an error to.
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
/// 断定しない案内と追記例を続ける。Finder から起動したアプリは PATH を正しく
/// 判定できないため `target_dir_on_path` は見ない(要件#35 追補b 契約3)。
/// どの行も字下げしない(要件#35 追補d 改訂 d-2: macOS 27 の NSAlert は行頭の
/// 空白を消すため)。
pub fn install_cli_success_body(result: &InstallCliResult) -> String {
    format!(
        "Installed:\n{}\n→ {}\n\nOpen a new terminal window and run `vellis`.\nIf the command is not found, add the following to your ~/.zshrc or similar:\n\nexport PATH=\"$HOME/.local/bin:$PATH\"",
        result.target_path.display(),
        result.source_path.display(),
    )
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
/// On a preview build (requirements.md #87 契約4) nothing is fetched: the
/// dialog says it is a development build and names `scripts/install-dev.sh`.
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
    // A preview (開発版, requirements.md #87 契約4) does not ask GitHub: its
    // releases are in the private development repository. Say so, and how
    // newer ones are installed.
    if crate::features::current_channel() == crate::channel::Channel::Preview {
        let dialog = crate::update_check::preview_check_dialog(env!("VELLIS_BUILD_NAME"));
        app.dialog()
            .message(dialog.body)
            .title(dialog.title)
            .kind(MessageDialogKind::Info)
            .show(move |_| drop(guard));
        return;
    }
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

/// Set while an Install 'vellis' Command in PATH result dialog is up, from the
/// click until the dialog is dismissed (requirements.md #35 追補d 契約3).
static INSTALL_CLI_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Clears [`INSTALL_CLI_IN_FLIGHT`] when dropped, so every path out of the
/// install — including one that never reaches the dialog — releases it.
struct InstallCliInFlight;

impl Drop for InstallCliInFlight {
    fn drop(&mut self) {
        INSTALL_CLI_IN_FLIGHT.store(false, Ordering::Release);
    }
}

/// The window the Install CLI result dialog is attached to as a sheet
/// (requirements.md #35 追補d 契約2).
///
/// `windows` is `(label, focused, visible and not minimized)` for every
/// webview window, print windows included, in `app.webview_windows()` order.
/// - Print windows are never chosen: they close once printing is done.
/// - The focused document window, if any.
/// - Otherwise the first visible, non-minimized document window.
/// - Otherwise `None`, and the dialog is shown without a parent.
pub fn install_cli_dialog_parent<'a>(windows: &[(&'a str, bool, bool)]) -> Option<&'a str> {
    let mut documents = windows
        .iter()
        .filter(|&&(label, _, _)| !crate::print::is_print_window(label));
    documents
        .clone()
        .find(|&&(_, focused, _)| focused)
        .or_else(|| documents.find(|&&(_, _, visible)| visible))
        .map(|&(label, _, _)| label)
}

/// Handle the "Install 'vellis' Command in PATH" menu click — runs the shared
/// install logic and displays a native dialog with the result.
///
/// Since 追補d (Issue #720・#721) the dialog is a sheet on the frontmost
/// document window ([`install_cli_dialog_parent`]), shown with `show`:
/// - Without a parent, rfd hands the message to the system's
///   UserNotificationCenter. The success body used to be indented, and the
///   indentation never showed (#720); a sheet loses it too, since NSAlert on
///   macOS 27 strips each line's leading whitespace, so the body is no longer
///   indented (追補d 改訂 d-2).
/// - `blocking_show` waited on the main thread (this handler runs in the menu
///   event), freezing every window until the dialog closed (#721). With a
///   parent it would never return at all, since the sheet's completion has to
///   come back through the main thread.
///
/// When no document window is visible the dialog has no parent; it still
/// does not freeze. A click while the dialog is up is ignored; the in-flight
/// guard rides into its callback.
pub fn handle_install_cli_click(app: &AppHandle<Wry>) {
    if INSTALL_CLI_IN_FLIGHT
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    let guard = InstallCliInFlight;
    let (body, kind) = match crate::cli_install::install_cli() {
        Ok(result) => (install_cli_success_body(&result), MessageDialogKind::Info),
        Err(e) => (install_cli_failure_body(&e), MessageDialogKind::Error),
    };
    let windows = app.webview_windows();
    let table: Vec<(&str, bool, bool)> = windows
        .iter()
        .map(|(label, w)| {
            let focused = w.is_focused().unwrap_or(false);
            let visible = w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false);
            (label.as_str(), focused, visible)
        })
        .collect();
    let mut builder = app.dialog().message(body).title("Vellis CLI").kind(kind);
    if let Some(window) = install_cli_dialog_parent(&table).and_then(|label| windows.get(label)) {
        builder = builder.parent(window);
    }
    builder.show(move |_| {
        let _guard = guard;
    });
}
