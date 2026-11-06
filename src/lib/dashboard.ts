/**
 * The Dashboard (requirements.md #83): the screen an argument-less launch shows instead of a
 * folder, and that Go ▸ Dashboard (Shift + Command + H) brings up at any time.
 *
 * This module holds the pure parts — the constants and wording, when the screen opens and closes
 * (`toggleDashboard`), which root and document a press opens (`planDashboardOpen`), how the rows read
 * (`recentFoldersView`, `modifiedRowLabel`, `formatModifiedAt`), the keyboard moves, and the menu
 * subscription. The screen is `src/components/Dashboard.svelte`; the bookmarks' command wrappers are
 * `$lib/bookmarks`; the scan is Rust's (`src-tauri/src/dashboard.rs`).
 */
import { listen } from '$lib/events';
import { normalizeBookmarkUri } from './bookmarks';
import { toPickerEntries } from './root-picker';

/** Sent to the focused window by Go ▸ Dashboard. Same value as Rust's `menu::MENU_DASHBOARD_EVENT`. */
export const MENU_DASHBOARD_EVENT = 'menu_dashboard';
/** The Go menu item's label (Rust's `"Dashboard"`). */
export const DASHBOARD_LABEL = 'Dashboard';
/** Progress of `scan_recently_modified`, sent to the calling window. Same value as Rust's. */
export const RECENTLY_MODIFIED_PROGRESS_EVENT = 'recently_modified_progress';
export const SCAN_RECENTLY_MODIFIED_COMMAND = 'scan_recently_modified';
export const REMOVE_HISTORY_ENTRY_COMMAND = 'remove_history_entry';
export const LIST_MISSING_PATHS_COMMAND = 'list_missing_paths';

/** Recent Folders rows shown before Show All (契約10 (n)). */
export const RECENT_FOLDERS_SHOWN = 6;
/** Recently Modified rows (契約12 (m)). Same value as Rust's `RECENTLY_MODIFIED_LIMIT`. */
export const RECENTLY_MODIFIED_LIMIT = 8;

// Wording (契約2・6・10・12 (al)). English only (要件#35・#51).
export const BOOKMARKS_HEADING = 'Bookmarks';
export const RECENT_FOLDERS_HEADING = 'Recent Folders';
export const RECENTLY_MODIFIED_HEADING = 'Recently Modified';
export const ADD_BOOKMARK_LABEL = 'Add Bookmark…';
export const ADD_FOLDER_LABEL = 'Add Folder…';
export const ADD_FILE_LABEL = 'Add File…';
export const ADD_BOOKMARK_DIALOG_TITLE = 'Add Bookmark';
export const SHOW_ALL_LABEL = 'Show All';
export const SHOW_LESS_LABEL = 'Show Less';
/** The rescan button's `aria-label`. */
export const RESCAN_LABEL = 'Rescan';
/**
 * A Recent Folders row's × (`aria-label` and `title`) and the row's context menu item: the same words
 * (契約10・14 追補a).
 */
export const REMOVE_FROM_RECENT_FOLDERS_LABEL = 'Remove from Recent Folders';
export const NO_RECENT_FOLDERS_MESSAGE = 'No recently opened folders';
export const NO_RECENTLY_MODIFIED_MESSAGE = 'No recently modified files';
export const SCANNING_MESSAGE = 'Scanning…';
export const NO_FOLDERS_TO_SCAN_MESSAGE = 'No folders to scan';
export const SCAN_TRUNCATED_MESSAGE = 'Partial results: the scan stopped after 2 seconds';
export const DASHBOARD_TIP = 'Tip: Press Shift + Command + H to open this Dashboard at any time.';

/**
 * The Dashboard's note when a folder could not be removed from Recent Folders — by the ×, the Delete
 * key or the context menu (契約5 (aa)・追補a). Rust's error text is passed through (#51).
 */
export function removeRecentFolderFailedMessage(err: unknown): string {
	return `Could not remove the folder from Recent Folders: ${err}`;
}

/** Recently Modified's heading note: `in N folders` (`in 1 folder`). */
export function foldersScannedLabel(n: number): string {
	return n === 1 ? 'in 1 folder' : `in ${n} folders`;
}

// ---------------------------------------------------------------------------
// Opening and closing (契約4)
// ---------------------------------------------------------------------------

export type DashboardState = { open: boolean; returnable: boolean };
export type DashboardTrigger = 'menu' | 'escape';

/**
 * What Go ▸ Dashboard (`'menu'`) or Escape (`'escape'`) does to the window's Dashboard.
 *
 * - closed + menu → open, with the screen behind it to go back to
 * - open and returnable + menu / escape → closed (back to the root and document behind it)
 * - open without anything to go back to (the launch, a failed init, New Window) → unchanged (w)
 * - closed + escape → unchanged
 */
export function toggleDashboard(state: DashboardState, trigger: DashboardTrigger): DashboardState {
	if (!state.open) {
		return trigger === 'menu' ? { open: true, returnable: true } : { ...state };
	}
	if (state.returnable) return { open: false, returnable: false };
	return { ...state };
}

// ---------------------------------------------------------------------------
// What a press opens (契約5)
// ---------------------------------------------------------------------------

export type DashboardOpenTarget =
	/** A Recent Folders row or a folder bookmark. */
	| { kind: 'folder'; uri: string }
	/** A file bookmark. */
	| { kind: 'file'; uri: string }
	/** A Recently Modified row; `folder` is the scanned folder it was found under. */
	| { kind: 'modified'; uri: string; folder: string };

/** `root` = the folder to switch to (null = keep the current root); `doc` = the document to open. */
export type DashboardOpenPlan = { root: string | null; doc: string | null };

/** Same folder by the history's normalization (`file:///r/a/` = `file:///r/a` = `file:///r//a`). */
function sameFolder(a: string, b: string | null): boolean {
	return b !== null && normalizeBookmarkUri(a) === normalizeBookmarkUri(b);
}

/**
 * Whether `uri` is under `root`: the Recent Files rule (one trailing `/` dropped, then `/` added, then
 * a prefix match — `file:///r/ab` is not under `file:///r/a`).
 */
function isUnder(uri: string, root: string): boolean {
	const base = normalizeBookmarkUri(root).replace(/\/$/, '') + '/';
	return normalizeBookmarkUri(uri).startsWith(base);
}

/** The folder holding `uri` (string-based, never encoded); the authority's root for a top-level file. */
function parentFolder(uri: string): string {
	const trimmed = uri.replace(/\/+$/, '');
	const schemeEnd = trimmed.indexOf('://');
	const pathStart = schemeEnd === -1 ? -1 : trimmed.indexOf('/', schemeEnd + 3);
	const lastSlash = trimmed.lastIndexOf('/');
	if (pathStart === -1) return trimmed;
	if (lastSlash <= pathStart) return trimmed.slice(0, pathStart + 1);
	return trimmed.slice(0, lastSlash);
}

/**
 * The root and document a press on the Dashboard opens (契約5 の表).
 *
 * `currentRoot` is the root behind a Dashboard the user can go back to — null for the launch's
 * Dashboard, whose cwd root nobody chose (w). A switch to the folder that already is the root is no
 * switch (`root: null`), so the tree keeps its expansion.
 */
export function planDashboardOpen(target: DashboardOpenTarget, currentRoot: string | null): DashboardOpenPlan {
	switch (target.kind) {
		case 'folder':
			return { root: sameFolder(target.uri, currentRoot) ? null : target.uri, doc: null };
		case 'modified':
			return { root: sameFolder(target.folder, currentRoot) ? null : target.folder, doc: target.uri };
		case 'file': {
			if (currentRoot !== null && isUnder(target.uri, currentRoot)) return { root: null, doc: target.uri };
			const parent = parentFolder(target.uri);
			return { root: sameFolder(parent, currentRoot) ? null : parent, doc: target.uri };
		}
	}
}

// ---------------------------------------------------------------------------
// Time (契約12 (ak))
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Calendar days from `then` to `now` in the window's local time (DST-safe). */
function calendarDaysBetween(then: Date, now: Date): number {
	const a = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
	const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	return Math.round((b - a) / (24 * HOUR));
}

/**
 * How a Recently Modified row reads its time: `Just now` (under a minute, or in the future) /
 * `N min ago` (under an hour) / `N hr ago` (today) / `Yesterday` (the previous calendar day) /
 * `N days ago` (2 to 6 days) / `Oct 28` (this year) / `Oct 28, 2025` (another year). Days are the
 * window's local calendar days.
 */
export function formatModifiedAt(modifiedMs: number, nowMs: number): string {
	const elapsed = nowMs - modifiedMs;
	if (elapsed < MINUTE) return 'Just now';
	if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
	const then = new Date(modifiedMs);
	const now = new Date(nowMs);
	const days = calendarDaysBetween(then, now);
	if (days <= 0) return `${Math.floor(elapsed / HOUR)} hr ago`;
	if (days === 1) return 'Yesterday';
	if (days < 7) return `${days} days ago`;
	const date = `${MONTHS[then.getMonth()]} ${then.getDate()}`;
	return then.getFullYear() === now.getFullYear() ? date : `${date}, ${then.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// How the rows read (契約6・10・12 (ah))
// ---------------------------------------------------------------------------

function isSsh(uri: string): boolean {
	return /^ssh:/i.test(uri);
}

/** A path as the Dashboard shows it: local = the OS path (`file://` dropped, no `~`); ssh = the URI. */
export function displayPath(uri: string): string {
	return uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
}

/** The name a row or tile shows: the last path segment (`toPickerEntries`' rule). */
export function nameOf(uri: string): string {
	return toPickerEntries([uri])[0]!.label;
}

/** The folder holding a file (string-based): the root a file bookmark opens in outside the current root. */
export function folderOf(uri: string): string {
	return parentFolder(uri);
}

/** A file bookmark's second line: its folder's path (ah). */
export function parentPathOf(uri: string): string {
	return displayPath(parentFolder(uri));
}

export type RecentFolderRow = { uri: string; label: string; path: string; missing: boolean; ssh: boolean };

/**
 * Recent Folders (契約10): the first `RECENT_FOLDERS_SHOWN` rows, or all of them once expanded. The
 * note (`6 of 14`) and the Show All / Show Less button only appear when there are more than that.
 */
export function recentFoldersView(
	history: readonly string[],
	missing: readonly string[],
	expanded: boolean
): { rows: RecentFolderRow[]; summary: string | null; toggleLabel: string | null } {
	const gone = new Set(missing);
	const overflow = history.length > RECENT_FOLDERS_SHOWN;
	const shown = overflow && !expanded ? history.slice(0, RECENT_FOLDERS_SHOWN) : [...history];
	const labels = toPickerEntries(shown);
	const rows = shown.map((uri, i) => ({
		uri,
		label: labels[i]!.label,
		path: displayPath(uri),
		missing: gone.has(uri),
		ssh: isSsh(uri)
	}));
	return {
		rows,
		summary: overflow ? `${RECENT_FOLDERS_SHOWN} of ${history.length}` : null,
		toggleLabel: overflow ? (expanded ? SHOW_LESS_LABEL : SHOW_ALL_LABEL) : null
	};
}

/**
 * A Recently Modified row's text: the file's name, and the scanned folder's name followed by the
 * folders between it and the file (`['aurora', 'docs', 'design']`). String-based like
 * `toPickerEntries`, so spaces and non-ASCII names are never percent-encoded.
 */
export function modifiedRowLabel(file: { uri: string; folder: string; modified: number }): {
	name: string;
	segments: string[];
} {
	const name = file.uri.slice(file.uri.lastIndexOf('/') + 1);
	const folder = file.folder.replace(/\/+$/, '');
	const segments = [nameOf(file.folder)];
	if (file.uri.startsWith(`${folder}/`)) {
		const between = file.uri.slice(folder.length + 1).split('/').slice(0, -1);
		segments.push(...between.filter((s) => s.length > 0));
	}
	return { name, segments };
}

// ---------------------------------------------------------------------------
// Keyboard (契約8・13 (af)(am)). Each returns the index focus moves to (the same one when it stays).
// ---------------------------------------------------------------------------

/** Bookmarks' grid: ← / → step through the tiles, ↑ / ↓ go to the same column of the row above / below. */
export function tileMove(index: number, key: string, count: number, columns: number): number {
	const cols = Math.max(1, columns);
	switch (key) {
		case 'ArrowLeft':
			return index > 0 ? index - 1 : index;
		case 'ArrowRight':
			return index < count - 1 ? index + 1 : index;
		case 'ArrowUp':
			return index - cols >= 0 ? index - cols : index;
		case 'ArrowDown':
			return index + cols < count ? index + cols : index;
		default:
			return index;
	}
}

/** A list of rows: ↑ / ↓ step through them; the ends stop. */
export function listMove(index: number, key: string, count: number): number {
	if (key === 'ArrowUp') return index > 0 ? index - 1 : index;
	if (key === 'ArrowDown') return index < count - 1 ? index + 1 : index;
	return index;
}

/** Option + arrow on a tile: ← / ↑ move it one place earlier, → / ↓ one later; the ends stop. */
export function reorderMove(index: number, key: string, count: number): number {
	if (key === 'ArrowLeft' || key === 'ArrowUp') return index > 0 ? index - 1 : index;
	if (key === 'ArrowRight' || key === 'ArrowDown') return index < count - 1 ? index + 1 : index;
	return index;
}

// ---------------------------------------------------------------------------
// Icons (契約6 の表)
// ---------------------------------------------------------------------------

/** What the type icon depends on: the file type of `$lib/file-type` and whether a code language is known. */
export type DashboardIcon = { name: string; color: string };

/**
 * The icon and colour token of a bookmark or a Recently Modified row (契約6 の表). `type` is
 * `detectFileType`'s, `hasLanguage` whether `languageForFile` knows the file (a text file with a
 * language is code).
 */
export function iconFor(
	kind: 'folder' | 'file',
	uri: string,
	type: string,
	hasLanguage: boolean
): DashboardIcon {
	if (kind === 'folder') return { name: isSsh(uri) ? 'server' : 'folder', color: '--ft-folder' };
	switch (type) {
		case 'markdown':
			return { name: 'file-text', color: '--ft-md' };
		case 'html':
			return { name: 'file-code', color: '--ft-html' };
		case 'text':
			return hasLanguage ? { name: 'file-code', color: '--ft-code' } : { name: 'file', color: '--color-text-muted' };
		case 'image':
			return { name: 'image', color: '--ft-img' };
		case 'model3d':
			return { name: 'cube', color: '--ft-3d' };
		case 'video':
			return { name: 'video', color: '--ft-video' };
		case 'audio':
			return { name: 'audio', color: '--ft-audio' };
		case 'pdf':
			return { name: 'file-pdf', color: '--ft-pdf' };
		default:
			return { name: 'file', color: '--color-text-muted' };
	}
}

// ---------------------------------------------------------------------------
// The menu (契約3)
// ---------------------------------------------------------------------------

/**
 * Subscribe to Go ▸ Dashboard (`menu_dashboard`). One event runs `run` once; a failure of `run`
 * (a rejection or a synchronous throw) never escapes. Returns the unsubscribe function.
 */
export async function registerDashboardListener(run: () => Promise<unknown> | unknown): Promise<() => void> {
	const unlisten = await listen<unknown>(MENU_DASHBOARD_EVENT, () => {
		void (async () => {
			try {
				await run();
			} catch (err) {
				console.warn('Go > Dashboard failed:', err);
			}
		})();
	});
	return () => unlisten();
}
