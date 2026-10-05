/**
 * History picker view model (requirements.md #4).
 *
 * An argument-less launch (`needs_root_selection = true`) opens the history
 * picker screen instead of a folder. This module owns everything the screen
 * needs from the backend — the component stays presentational.
 *
 * Backend side: `list_history` reads the store written by `record_root`
 * (requirements.md #3); selecting an entry goes through the ordinary
 * `set_root` path, so the root switch behaves exactly like the Explorer's.
 */
import { invoke } from '$lib/ipc';

/** One row of the picker: the full URI plus its display name. */
export type RootPickerEntry = {
	/** History URI, passed verbatim to `set_root` on selection. */
	uri: string;
	/** Display name — the last path segment of `uri`. */
	label: string;
};

/**
 * Display name for a history URI: the last non-empty path segment.
 *
 * Deliberately string-based rather than `new URL()`: backend URIs are raw,
 * un-percent-encoded strings (`format!("file://{}", …)`), and `URL.pathname`
 * would re-encode them — turning `My Docs` into `My%20Docs`. The authority
 * (`alice@host`) is dropped so `ssh://host/repo` reads as `repo`.
 *
 * Falls back to the URI itself when no segment can be taken (e.g. `file:///`)
 * so a row is never rendered blank.
 */
function labelFor(uri: string): string {
	const schemeEnd = uri.indexOf('://');
	const afterScheme = schemeEnd === -1 ? uri : uri.slice(schemeEnd + 3);
	const pathStart = afterScheme.indexOf('/');
	const path = pathStart === -1 ? '' : afterScheme.slice(pathStart);
	const segments = path.split('/').filter((s) => s.length > 0);
	return segments[segments.length - 1] ?? uri;
}

/** Convert history URIs (most recent first) into picker rows, order kept. */
export function toPickerEntries(uris: string[]): RootPickerEntry[] {
	return uris.map((uri) => ({ uri, label: labelFor(uri) }));
}

/**
 * Recently opened folders, most recent first.
 *
 * Failures resolve to `[]` rather than rejecting: a broken history must not
 * block startup — the picker still offers the OS folder dialog.
 */
export async function loadHistory(): Promise<string[]> {
	try {
		return await invoke<string[]>('list_history');
	} catch {
		return [];
	}
}

/**
 * Open a history entry as the new root and return the `set_root` payload.
 *
 * Failures (the folder was moved or deleted) reject so the caller can tell
 * the user; swallowing them would leave the picker looking unresponsive.
 */
export async function openHistoryEntry<T = unknown>(uri: string): Promise<T> {
	return invoke<T>('set_root', { uri });
}

/**
 * Message for a folder that could not be opened (requirements.md #71 契約3).
 * Same value as the picker's note when a history entry fails to open; the
 * reason is the backend's error text, passed through verbatim (#51).
 */
export function openFolderFailedMessage(err: unknown): string {
	return `Could not open the folder: ${err}`;
}

/** What `pickFolderAndSetRoot` needs from the page (dialog, edit guard, `set_root`). */
export type PickFolderDeps<Root = unknown> = {
	/** Ask before dropping unsaved edits (requirements.md #48 契約④). */
	confirmDiscard: () => Promise<boolean>;
	/** The OS folder dialog: the chosen **path** (not a URI), or `null` when cancelled. */
	pickFolder: () => Promise<string | null>;
	/** Open `uri` as the new root (`set_root`). */
	setRoot: (uri: string) => Promise<Root>;
};

export type PickFolderOutcome<Root = unknown> =
	| { kind: 'applied'; root: Root }
	| { kind: 'cancelled' }
	| { kind: 'failed'; message: string };

/**
 * The picker's "Select Folder…" (requirements.md #4 / #71 契約3).
 *
 * A folder that cannot be opened (`set_root` rejects) does not reject here:
 * it comes back as `failed` with the note to show, so the picker stays open
 * and the user can choose again — the same treatment as a stale history entry.
 */
export async function pickFolderAndSetRoot<Root = unknown>(
	deps: PickFolderDeps<Root>
): Promise<PickFolderOutcome<Root>> {
	if (!(await deps.confirmDiscard())) return { kind: 'cancelled' };
	const selected = await deps.pickFolder();
	if (selected === null) return { kind: 'cancelled' };
	try {
		return { kind: 'applied', root: await deps.setRoot(`file://${selected}`) };
	} catch (err) {
		return { kind: 'failed', message: openFolderFailedMessage(err) };
	}
}
