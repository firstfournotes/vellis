/**
 * The window's copy of the bookmarks (requirements.md #83 契約9 (ap)).
 *
 * Read once with `list_bookmarks` when the window starts (`+page.svelte` calls `init()`), then
 * replaced by the list each `bookmarks_changed` carries — Rust sends it to every window after any
 * change, so a Pin in another window shows here too. The Dashboard's tiles and the Pin / Unpin of
 * the Explorer's rows and the document's context menu all read `list`.
 */
import { listen } from '$lib/events';
import { BOOKMARKS_CHANGED_EVENT, loadBookmarks, type Bookmark } from '$lib/bookmarks';

class BookmarksStore {
	/** The bookmarks this window knows of, in the user's order. */
	list = $state<Bookmark[]>([]);
	/**
	 * Whether the first list has arrived: the first read resolved, or a `bookmarks_changed` landed
	 * before it. Stays true afterwards (a failed read still lands, as []). The Dashboard waits for it
	 * before it places the first focus (契約13).
	 */
	loaded = $state(false);

	#started = false;

	/** Subscribe and read the list. Once per window: later calls do nothing. */
	async init(): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		// An event that lands while the first read is in flight is newer than that read.
		let replaced = false;
		await listen<Bookmark[]>(BOOKMARKS_CHANGED_EVENT, (e) => {
			replaced = true;
			this.list = e.payload;
			this.loaded = true;
		});
		const list = await loadBookmarks();
		if (!replaced) {
			this.list = list;
			this.loaded = true;
		}
	}
}

export const bookmarks = new BookmarksStore();
