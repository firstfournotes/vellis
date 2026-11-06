/**
 * Bookmarks — the folders and files pinned to the Dashboard (requirements.md #83 契約7・9・16).
 *
 * The list lives in Rust (`<app_config_dir>/bookmarks.json`, `src-tauri/src/bookmarks.rs`): one for
 * the whole app, in the user's order. Every command that changes it sends the list as it stands to
 * every window as `bookmarks_changed`, and each window's store (`stores/bookmarks.svelte`) replaces
 * its copy with it. This module holds the command names and their thin wrappers, the mirror of the
 * URI normalization the store compares with (`history::normalize_uri`), and the failure message.
 */
import { invoke } from '$lib/ipc';

/** Sent to every window with the whole list after a change. Same value as Rust's `BOOKMARKS_CHANGED_EVENT`. */
export const BOOKMARKS_CHANGED_EVENT = 'bookmarks_changed';
export const LIST_BOOKMARKS_COMMAND = 'list_bookmarks';
export const ADD_BOOKMARK_COMMAND = 'add_bookmark';
export const REMOVE_BOOKMARK_COMMAND = 'remove_bookmark';
export const MOVE_BOOKMARK_COMMAND = 'move_bookmark';

export type BookmarkKind = 'folder' | 'file';
export type Bookmark = { uri: string; kind: BookmarkKind };

/** Every bookmark in the user's order. A failure is an empty list: the Dashboard must still render. */
export async function loadBookmarks(): Promise<Bookmark[]> {
	try {
		return await invoke<Bookmark[]>(LIST_BOOKMARKS_COMMAND);
	} catch {
		return [];
	}
}

/**
 * Pin `uri` at the tail (already pinned → left where it is). Returns the list afterwards. A failure
 * rejects: the caller tells the user (`bookmarkSaveFailedMessage`). The URI is passed verbatim — the
 * normalization is Rust's.
 */
export async function addBookmark(uri: string, kind: BookmarkKind): Promise<Bookmark[]> {
	return invoke<Bookmark[]>(ADD_BOOKMARK_COMMAND, { uri, kind });
}

/** Unpin `uri`. Returns the list afterwards; a failure rejects. */
export async function removeBookmark(uri: string): Promise<Bookmark[]> {
	return invoke<Bookmark[]>(REMOVE_BOOKMARK_COMMAND, { uri });
}

/** Move `uri` to position `to` of the list without it (out of range = the tail). A failure rejects. */
export async function moveBookmark(uri: string, to: number): Promise<Bookmark[]> {
	return invoke<Bookmark[]>(MOVE_BOOKMARK_COMMAND, { uri, to });
}

/**
 * The spelling Rust stores and compares (`history::normalize_uri`): runs of `/` in the path collapse
 * to one, a trailing `/` is dropped unless the path is `/`, and an authority with no path gains the
 * root `/`. A string without `://` is returned unchanged. Purely textual (no percent-encoding).
 */
export function normalizeBookmarkUri(uri: string): string {
	const sepAt = uri.indexOf('://');
	if (sepAt === -1) return uri;
	const prefix = uri.slice(0, sepAt + 3);
	const rest = uri.slice(sepAt + 3);
	const pathAt = rest.indexOf('/');
	if (pathAt === -1) return `${prefix}${rest}/`;
	const authority = rest.slice(0, pathAt);
	let path = rest.slice(pathAt).replace(/\/{2,}/g, '/');
	if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
	return `${prefix}${authority}${path}`;
}

/** Whether `uri` is pinned (normalized comparison, like Rust's). */
export function isBookmarked(list: readonly Bookmark[], uri: string): boolean {
	const target = normalizeBookmarkUri(uri);
	return list.some((b) => normalizeBookmarkUri(b.uri) === target);
}

/** The alert when a change could not be saved (契約7 (al)). Rust's error text is passed through (#51). */
export function bookmarkSaveFailedMessage(err: unknown): string {
	return `Could not save the bookmarks: ${err}`;
}
