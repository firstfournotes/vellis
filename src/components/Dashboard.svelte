<script lang="ts" module>
	/**
	 * The generation of the last Recently Modified scan this window started. Module-wide so a
	 * Dashboard opened again never reuses the number of an older scan still running (Rust tags its
	 * progress and result with it, 契約12 (aj)).
	 */
	let lastScanGeneration = 0;
</script>

<script lang="ts">
	/**
	 * The Dashboard (requirements.md #83): what an argument-less launch shows instead of a folder,
	 * and what Go ▸ Dashboard swaps the window's view for. It replaces the history picker
	 * (RootPicker, 要件#4) and keeps its jobs — Select Folder… and opening a recent folder — next to
	 * Bookmarks, Recent Folders and Recently Modified (契約2).
	 *
	 * The component runs its own open sequence (案A=2026-11-05): `planDashboardOpen` → the unsaved
	 * edits question → `set_root` when the root changes → the document → `onOpened(root, doc)`. The
	 * page moves the results onto the window and closes the Dashboard. What cannot be opened stays
	 * here as a note (`role="alert"`, 契約5 (aa)).
	 *
	 * The outermost element keeps the `root-picker` class: `print.css` leaves it out of printing and
	 * the existing gates look for it (契約1 (r)).
	 */
	import { onMount, tick } from 'svelte';
	import { open as openDialog } from '@tauri-apps/plugin-dialog';
	import { invoke } from '$lib/ipc';
	import { listen } from '$lib/events';
	import { confirmDiscardEdits } from '$lib/edit-guard';
	import { detectFileType } from '$lib/file-type';
	import { languageForFile } from '$lib/code-language';
	import { openFileFailedMessage, openForDisplay } from '$lib/open-document';
	import { loadHistory, openFolderFailedMessage } from '$lib/root-picker';
	import { openInNewWindow, openInNewWindowFailedMessage } from '$lib/open-in-new-window';
	import {
		addBookmark,
		bookmarkSaveFailedMessage,
		isBookmarked,
		moveBookmark,
		normalizeBookmarkUri,
		removeBookmark,
		type BookmarkKind
	} from '$lib/bookmarks';
	import {
		ADD_BOOKMARK_DIALOG_TITLE,
		ADD_BOOKMARK_LABEL,
		BOOKMARKS_HEADING,
		DASHBOARD_TIP,
		LIST_MISSING_PATHS_COMMAND,
		NO_FOLDERS_TO_SCAN_MESSAGE,
		NO_RECENTLY_MODIFIED_MESSAGE,
		NO_RECENT_FOLDERS_MESSAGE,
		RECENTLY_MODIFIED_HEADING,
		RECENTLY_MODIFIED_PROGRESS_EVENT,
		RECENT_FOLDERS_HEADING,
		REMOVE_FROM_RECENT_FOLDERS_LABEL,
		REMOVE_HISTORY_ENTRY_COMMAND,
		RESCAN_LABEL,
		SCANNING_MESSAGE,
		SCAN_RECENTLY_MODIFIED_COMMAND,
		SCAN_TRUNCATED_MESSAGE,
		displayPath,
		folderOf,
		foldersScannedLabel,
		formatModifiedAt,
		iconFor,
		listMove,
		modifiedRowLabel,
		nameOf,
		parentPathOf,
		planDashboardOpen,
		recentFoldersView,
		removeRecentFolderFailedMessage,
		reorderMove,
		tileMove,
		type DashboardOpenTarget
	} from '$lib/dashboard';
	import {
		buildAddBookmarkMenu,
		buildBookmarkTileMenu,
		buildRecentFolderMenu,
		type ContextMenuItemId,
		type DashboardMenuTarget
	} from '$lib/context-menu';
	import { contextMenu } from '../stores/context-menu.svelte';
	import { bookmarks } from '../stores/bookmarks.svelte';
	import { windowState, type DocumentPayload, type Entry } from '../stores/window-state.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import Icon from './Icon.svelte';

	/** What `set_root` resolves to (the page's `RootPayload`). */
	type RootPayload = { root_uri: string; entries: Entry[]; document_retained: boolean };
	type ModifiedFile = { uri: string; folder: string; modified: number };
	type RecentlyModifiedScan = { generation: number; files: ModifiedFile[]; folders: number; truncated: boolean };

	let {
		error,
		currentRoot,
		confirmDiscard = confirmDiscardEdits,
		onOpened,
		onClose,
		onPickFolder,
		onOpenFile
	}: {
		/** The page's note (a failed launch root, a failed Select Folder…). */
		error: string | null;
		/** The root behind a Dashboard the user can go back to; null for the launch's (w). */
		currentRoot: string | null;
		/** The unsaved edits question (要件#48). Defaults to `confirmDiscardEdits`. */
		confirmDiscard?: () => Promise<boolean>;
		/**
		 * Something was opened: `root` = what `set_root` returned (null = the root did not change),
		 * `doc` = the opened document (null = none). Both null = the current root again (go back).
		 */
		onOpened: (root: RootPayload | null, doc: DocumentPayload | null) => void;
		/** Escape with nothing else to close (the page decides whether the Dashboard can go back). */
		onClose: () => void;
		/** Select Folder… (the page's `pickFolderAndSetRoot` sequence). */
		onPickFolder: () => void;
		/** Open… (the page runs File ▸ Open…'s sequence). Omitted = the button does nothing. */
		onOpenFile?: () => void;
	} = $props();

	const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
	/** How far the pointer moves before a grip drag starts (契約8 (af)). */
	const DRAG_THRESHOLD = 4;

	let rootEl = $state<HTMLDivElement | null>(null);
	let bookmarksEl = $state<HTMLElement | null>(null);
	let tilesEl = $state<HTMLDivElement | null>(null);

	/** What a press here could not open (契約5 (aa)). Shown instead of the page's `error`. */
	let note = $state<string | null>(null);
	let opening = false;

	// --- Recent Folders(契約10) ------------------------------------------------

	let history = $state<string[]>([]);
	let historyLoaded = $state(false);
	let expanded = $state(false);
	/** The local URIs (history and bookmarks) not on disk any more (契約6・10). */
	let missing = $state<string[]>([]);
	let missingRequest = 0;

	let recentView = $derived(recentFoldersView(history, missing, expanded));

	$effect(() => {
		if (!historyLoaded) return;
		const uris = [...new Set([...history, ...bookmarks.list.map((b) => b.uri)])].filter((u) =>
			u.startsWith('file://')
		);
		const request = ++missingRequest;
		if (uris.length === 0) {
			missing = [];
			return;
		}
		invoke<string[]>(LIST_MISSING_PATHS_COMMAND, { uris })
			.then((gone) => {
				if (request === missingRequest) missing = gone;
			})
			.catch((err) => console.warn('list_missing_paths failed:', err));
	});

	// --- Recently Modified(契約12) ---------------------------------------------

	let scanGeneration = 0;
	let scanning = $state(true);
	let scan = $state<{ files: ModifiedFile[]; folders: number; truncated: boolean; now: number }>({
		files: [],
		folders: 0,
		truncated: false,
		now: Date.now()
	});

	function applyScan(result: RecentlyModifiedScan) {
		// The times are counted when the list arrives and not again while it is shown (ak).
		scan = { files: result.files, folders: result.folders, truncated: result.truncated, now: Date.now() };
	}

	function startScan() {
		const generation = ++lastScanGeneration;
		scanGeneration = generation;
		scanning = true;
		invoke<RecentlyModifiedScan>(SCAN_RECENTLY_MODIFIED_COMMAND, { generation })
			.then((result) => {
				if (generation !== scanGeneration) return;
				applyScan(result);
				scanning = false;
			})
			.catch((err) => {
				if (generation !== scanGeneration) return;
				console.warn('scan_recently_modified failed:', err);
				scanning = false;
			});
	}

	function handleScanProgress(progress: RecentlyModifiedScan) {
		// Only this window's newest scan, and only until its result is in.
		if (progress.generation !== scanGeneration || !scanning) return;
		applyScan(progress);
	}

	let modifiedEmpty = $derived(
		scanning ? SCANNING_MESSAGE : scan.folders === 0 ? NO_FOLDERS_TO_SCAN_MESSAGE : NO_RECENTLY_MODIFIED_MESSAGE
	);

	// --- Focus(契約13 (am)= 区画で 1 つの止まり先・矢印で項目) -----------------------

	let tileFocus = $state(0);
	let recentFocus = $state(0);
	let modifiedFocus = $state(0);
	let tileStop = $derived(Math.min(tileFocus, bookmarks.list.length));
	let recentStop = $derived(Math.min(recentFocus, Math.max(0, recentView.rows.length - 1)));
	let modifiedStop = $derived(Math.min(modifiedFocus, Math.max(0, scan.files.length - 1)));
	/** The tile a keyboard reorder moved: focus follows it once the new list arrives (契約8 (af)). */
	let followUri: string | null = null;

	function tileElements(): HTMLElement[] {
		return tilesEl ? [...tilesEl.querySelectorAll<HTMLElement>('.bookmark-tile, .add-bookmark')] : [];
	}

	function focusTile(index: number) {
		followUri = null;
		tileFocus = index;
		tileElements()[index]?.focus();
	}

	function focusRow(selector: string, index: number) {
		rootEl?.querySelectorAll<HTMLElement>(selector)[index]?.focus();
	}

	/** Tiles in the first row of the grid (the layout decides; 1 when it cannot tell). */
	function columnCount(): number {
		const els = tileElements();
		if (els.length === 0) return 1;
		const top = els[0]!.offsetTop;
		let n = 0;
		for (const el of els) {
			if (el.offsetTop !== top) break;
			n++;
		}
		return Math.max(1, n);
	}

	/**
	 * The focus on opening = the first tile (`Add Bookmark…` when there are none; 契約13 (o)(am)).
	 * It waits for the window's first list (契約9): on launch the Dashboard mounts before
	 * `list_bookmarks` is in. A list that arrives after the mount does not take the focus from where
	 * the user has moved it outside Bookmarks — only the section's stop goes to the first tile.
	 */
	let firstFocusPending = true;
	const loadedAtMount = bookmarks.loaded;

	$effect(() => {
		if (!firstFocusPending || !bookmarks.loaded) return;
		firstFocusPending = false;
		let cancelled = false;
		void tick().then(() => {
			if (cancelled) return;
			const active = document.activeElement;
			const movedAway = active !== null && active !== document.body && !bookmarksEl?.contains(active);
			if (!loadedAtMount && movedAway) {
				tileFocus = 0;
				return;
			}
			focusTile(0);
		});
		return () => {
			cancelled = true;
		};
	});

	$effect(() => {
		const list = bookmarks.list;
		const uri = followUri;
		if (uri === null) return;
		const index = list.findIndex((b) => b.uri === uri);
		if (index === -1) return;
		void tick().then(() => {
			if (followUri !== uri) return;
			followUri = null;
			tileFocus = index;
			tileElements()[index]?.focus();
		});
	});

	function handleTileKeyDown(e: KeyboardEvent, index: number) {
		if (!ARROWS.has(e.key) || e.metaKey || e.ctrlKey) return;
		e.preventDefault();
		const count = bookmarks.list.length;
		if (e.altKey) {
			const bookmark = bookmarks.list[index];
			if (!bookmark) return; // Add Bookmark… is not reordered
			const to = reorderMove(index, e.key, count);
			if (to !== index) void reorder(bookmark.uri, to, true);
			return;
		}
		focusTile(tileMove(index, e.key, count + 1, columnCount()));
	}

	function handleRowKeyDown(e: KeyboardEvent, index: number, count: number, which: 'recent' | 'modified') {
		if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
		e.preventDefault();
		const next = listMove(index, e.key, count);
		if (which === 'recent') {
			recentFocus = next;
			focusRow('.recent-folder', next);
		} else {
			modifiedFocus = next;
			focusRow('.modified-row', next);
		}
	}

	/**
	 * A Recent Folders row's keys: ↑ / ↓ as in any list, and Backspace / Delete without a modifier
	 * remove the row like its × (契約13 追補a). Nothing while composing or while the context menu is open.
	 */
	function handleRecentKeyDown(e: KeyboardEvent, index: number, uri: string) {
		if (e.key === 'Backspace' || e.key === 'Delete') {
			if (e.metaKey || e.altKey || e.ctrlKey || e.shiftKey || e.isComposing || contextMenu.open) return;
			e.preventDefault();
			void removeRecentFolder(uri, true);
			return;
		}
		handleRowKeyDown(e, index, recentView.rows.length, 'recent');
	}

	// --- Opening(契約5) --------------------------------------------------------

	async function openTarget(target: DashboardOpenTarget) {
		if (opening) return;
		opening = true;
		try {
			const plan = planDashboardOpen(target, currentRoot);
			const currentDoc = windowState.currentDocument?.uri ?? null;
			// Nothing would change (the root behind, or its document again): just go back.
			if (plan.root === null && (plan.doc === null || plan.doc === currentDoc)) {
				note = null;
				onOpened(null, null);
				return;
			}
			if (!(await confirmDiscard())) return;
			let root: RootPayload | null = null;
			if (plan.root !== null) {
				try {
					root = await invoke<RootPayload>('set_root', { uri: plan.root });
				} catch (err) {
					note = openFolderFailedMessage(err);
					return;
				}
			}
			let doc: DocumentPayload | null = null;
			if (plan.doc !== null) {
				try {
					doc = await openForDisplay(plan.doc);
				} catch (err) {
					if (root !== null) {
						// The root has already switched: show it, then say the file did not open (aa).
						note = null;
						onOpened(root, null);
						alert(openFileFailedMessage(err));
						return;
					}
					note = openFileFailedMessage(err);
					return;
				}
			}
			note = null;
			onOpened(root, doc);
		} finally {
			opening = false;
		}
	}

	function bookmarkTarget(uri: string, kind: BookmarkKind): DashboardOpenTarget {
		return kind === 'folder' ? { kind: 'folder', uri } : { kind: 'file', uri };
	}

	async function openElsewhere(uri: string, kind: BookmarkKind) {
		const plan =
			kind === 'folder'
				? { command: 'new-window' as const, root: uri, path: null }
				: { command: 'new-window' as const, root: folderOf(uri), path: uri };
		try {
			await openInNewWindow(plan);
		} catch (err) {
			alert(openInNewWindowFailedMessage(err));
		}
	}

	async function openNewWindow() {
		try {
			await invoke('new_window', {});
		} catch (err) {
			alert(openInNewWindowFailedMessage(err));
		}
	}

	// --- Bookmarks(契約7・8) ---------------------------------------------------

	async function saving(change: () => Promise<unknown>) {
		try {
			await change();
		} catch (err) {
			alert(bookmarkSaveFailedMessage(err));
		}
	}

	async function reorder(uri: string, to: number, follow = false) {
		if (follow) followUri = uri;
		await saving(() => moveBookmark(uri, to));
	}

	async function addFromDialog(kind: BookmarkKind) {
		let selected: string | string[] | null;
		try {
			selected = await openDialog({ directory: kind === 'folder', multiple: false, title: ADD_BOOKMARK_DIALOG_TITLE });
		} catch (err) {
			console.warn('Add Bookmark dialog failed:', err);
			return;
		}
		if (typeof selected !== 'string') return; // cancelled
		await saving(() => addBookmark(`file://${selected}`, kind));
	}

	/**
	 * Takes a folder off Recent Folders — the row's ×, Backspace / Delete, or the context menu
	 * (契約10・13・14 追補a) — without asking. The rows are drawn again from the history Rust returns.
	 * When a key did it, or the focus was in that row, the focus goes to the row that took its place
	 * (the one before when it was the last; Bookmarks' stop when no row is left). A ×-press with the
	 * focus elsewhere leaves the focus alone. A failure keeps the row and says why in the note
	 * (契約5 (aa)), which goes the way the open notes go.
	 */
	async function removeRecentFolder(uri: string, byKey = false) {
		const index = recentView.rows.findIndex((r) => r.uri === uri);
		const wrap = index === -1 ? undefined : rootEl?.querySelectorAll<HTMLElement>('.recent-row')[index];
		const moveFocus = index !== -1 && (byKey || (wrap?.contains(document.activeElement) ?? false));
		try {
			history = await invoke<string[]>(REMOVE_HISTORY_ENTRY_COMMAND, { uri });
		} catch (err) {
			note = removeRecentFolderFailedMessage(err);
			return;
		}
		note = null;
		if (!moveFocus) return;
		await tick();
		const count = recentView.rows.length;
		if (count === 0) {
			focusTile(tileStop);
			return;
		}
		const next = Math.min(index, count - 1);
		recentFocus = next;
		focusRow('.recent-folder', next);
	}

	function bookmarkIndex(uri: string): number {
		const target = normalizeBookmarkUri(uri);
		return bookmarks.list.findIndex((b) => normalizeBookmarkUri(b.uri) === target);
	}

	/** The Dashboard's context menu items (契約14・7). */
	function handleDashboardItem(id: ContextMenuItemId, target: DashboardMenuTarget) {
		if (target.kind === 'add-bookmark') {
			if (id === 'add-folder-bookmark') void addFromDialog('folder');
			else if (id === 'add-file-bookmark') void addFromDialog('file');
			return;
		}
		if (target.kind === 'recent-folder') {
			if (id === 'dashboard-open') void openTarget({ kind: 'folder', uri: target.uri });
			else if (id === 'dashboard-open-in-new-window') void openElsewhere(target.uri, 'folder');
			else if (id === 'pin-to-bookmarks') void saving(() => addBookmark(target.uri, 'folder'));
			else if (id === 'unpin-from-bookmarks') void saving(() => removeBookmark(target.uri));
			else if (id === 'remove-from-recent-folders') void removeRecentFolder(target.uri);
			return;
		}
		if (id === 'dashboard-open') void openTarget(bookmarkTarget(target.uri, target.bookmarkKind));
		else if (id === 'dashboard-open-in-new-window') void openElsewhere(target.uri, target.bookmarkKind);
		else if (id === 'unpin-from-bookmarks') void saving(() => removeBookmark(target.uri));
		else if (id === 'move-up' || id === 'move-down') {
			// The position as it is now (another window may have changed the list meanwhile).
			const index = bookmarkIndex(target.uri);
			if (index === -1) return;
			const to = id === 'move-up' ? index - 1 : index + 1;
			if (to < 0 || to >= bookmarks.list.length) return;
			void reorder(target.uri, to);
		}
	}

	function openTileMenu(e: MouseEvent, index: number) {
		const bookmark = bookmarks.list[index];
		if (!bookmark) return;
		e.preventDefault();
		contextMenu.openDashboardAt(
			{ kind: 'bookmark', uri: bookmark.uri, bookmarkKind: bookmark.kind, index },
			buildBookmarkTileMenu(index, bookmarks.list.length),
			e.clientX,
			e.clientY
		);
	}

	function openRecentMenu(e: MouseEvent, uri: string) {
		e.preventDefault();
		contextMenu.openDashboardAt(
			{ kind: 'recent-folder', uri },
			buildRecentFolderMenu(isBookmarked(bookmarks.list, uri)),
			e.clientX,
			e.clientY
		);
	}

	async function openAddMenu(e: MouseEvent) {
		const el = e.currentTarget as HTMLElement;
		const rect = el.getBoundingClientRect();
		contextMenu.openDashboardAt({ kind: 'add-bookmark' }, buildAddBookmarkMenu(), rect.left, rect.bottom + 4);
		// From the keyboard (Return / Space): put the focus on the first item so it can be chosen.
		if (e.detail === 0) {
			await tick();
			rootEl?.querySelector<HTMLElement>('.context-menu [role="menuitem"]')?.focus();
		}
	}

	// --- Grip drag(契約8 (f)(af)= pointer の event と pointer capture。HTML5 DnD は使わない) ---

	let drag = $state<{
		uri: string;
		from: number;
		x: number;
		y: number;
		pointerId: number;
		active: boolean;
		over: number | null;
	} | null>(null);

	/** The bookmark index a drop at (x, y) lands on, or null outside the tiles. */
	function dropIndexAt(x: number, y: number): number | null {
		const hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
		const tile = hit instanceof Element ? hit.closest<HTMLElement>('.bookmark-tile, .add-bookmark') : null;
		if (!tile || !rootEl?.contains(tile)) return null;
		if (tile.classList.contains('add-bookmark')) return bookmarks.list.length - 1;
		const index = Number(tile.dataset.index);
		return Number.isInteger(index) ? index : null;
	}

	function releaseCapture(el: EventTarget | null, pointerId: number) {
		if (!(el instanceof Element)) return;
		try {
			if (typeof el.hasPointerCapture === 'function' && el.hasPointerCapture(pointerId)) {
				el.releasePointerCapture(pointerId);
			}
		} catch {
			// Nothing to release.
		}
	}

	function handleGripPointerDown(e: PointerEvent, index: number, uri: string) {
		if (e.button !== 0) return;
		// Not the tile's press (that opens), and no text selection or focus change.
		e.preventDefault();
		e.stopPropagation();
		const el = e.currentTarget as Element;
		try {
			if (typeof el.setPointerCapture === 'function') el.setPointerCapture(e.pointerId);
		} catch {
			// No capture: the move and up still reach the grip while the pointer is over it.
		}
		drag = { uri, from: index, x: e.clientX, y: e.clientY, pointerId: e.pointerId, active: false, over: null };
	}

	function handleGripPointerMove(e: PointerEvent) {
		const d = drag;
		if (!d || e.pointerId !== d.pointerId) return;
		if (!d.active) {
			if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD) return;
			d.active = true;
		}
		d.over = dropIndexAt(e.clientX, e.clientY);
	}

	function handleGripPointerUp(e: PointerEvent) {
		const d = drag;
		if (!d || e.pointerId !== d.pointerId) return;
		drag = null;
		releaseCapture(e.currentTarget, e.pointerId);
		if (!d.active) return; // released without moving
		const to = dropIndexAt(e.clientX, e.clientY);
		if (to === null || to === d.from) return; // outside the tiles, or back where it was
		void reorder(d.uri, to);
	}

	function cancelDrag() {
		drag = null;
	}

	function dropMark(index: number): 'before' | 'after' | null {
		const d = drag;
		if (!d || !d.active || d.over !== index || d.over === d.from) return null;
		return index < d.from ? 'before' : 'after';
	}

	// --- Escape(契約4) ---------------------------------------------------------

	/**
	 * Escape closes the context menu, or stops a drag, or (neither) asks the page to go back. Taken
	 * in the capture phase so this decides before the menu's own Escape closes it.
	 */
	function handleWindowKeyDown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || e.isComposing) return;
		if (drag) {
			e.preventDefault();
			cancelDrag();
			return;
		}
		if (contextMenu.open) {
			contextMenu.close();
			return;
		}
		onClose();
	}

	// --- Mount -----------------------------------------------------------------

	onMount(() => {
		let disposed = false;
		let unlisten: (() => void) | null = null;
		void (async () => {
			const off = await listen<RecentlyModifiedScan>(RECENTLY_MODIFIED_PROGRESS_EVENT, (e) =>
				handleScanProgress(e.payload)
			);
			if (disposed) {
				off();
				return;
			}
			unlisten = off;
			startScan();
		})();
		void loadHistory().then((uris) => {
			if (disposed) return;
			history = uris;
			historyLoaded = true;
		});
		return () => {
			disposed = true;
			unlisten?.();
		};
	});

	function tileView(uri: string, kind: BookmarkKind) {
		const type = detectFileType(uri);
		return {
			name: nameOf(uri),
			path: kind === 'folder' ? displayPath(uri) : parentPathOf(uri),
			icon: iconFor(kind, uri, type, languageForFile(uri) !== null),
			ssh: /^ssh:/i.test(uri)
		};
	}

	function modifiedView(file: ModifiedFile) {
		return {
			...modifiedRowLabel(file),
			icon: iconFor('file', file.uri, detectFileType(file.uri), languageForFile(file.uri) !== null),
			when: formatModifiedAt(file.modified, scan.now)
		};
	}
</script>

<svelte:window onkeydowncapture={handleWindowKeyDown} />

<div class="root-picker dashboard" bind:this={rootEl}>
	<div class="dashboard-content">
		<header class="dashboard-top">
			<div class="brand">
				<div class="wordmark">Vellis</div>
				{#if windowState.version}
					<div class="version">Version {windowState.version}</div>
				{/if}
			</div>
			<div class="top-actions">
				<button class="top-button" onclick={() => onOpenFile?.()}
					><Icon name="file" size={16} />Open…<span class="kbd">Command + O</span></button
				>
				<button class="top-button" onclick={() => void openNewWindow()}
					><Icon name="window" size={16} />New Window<span class="kbd">Command + N</span></button
				>
				<button class="pick-folder" onclick={onPickFolder}
					><Icon name="folder-open" size={16} />Select Folder…</button
				>
			</div>
		</header>

		{#if note ?? error}
			<p class="error" role="alert">{note ?? error}</p>
		{/if}

		<section class="dashboard-bookmarks" bind:this={bookmarksEl}>
			<h2 class="section-header">
				<Icon name="pin" size={14} />{BOOKMARKS_HEADING}<span class="count">{bookmarks.list.length}</span>
			</h2>
			<div class="tiles" bind:this={tilesEl}>
				{#each bookmarks.list as bookmark, i (bookmark.uri)}
					{@const view = tileView(bookmark.uri, bookmark.kind)}
					{@const mark = dropMark(i)}
					<button
						class="bookmark-tile"
						class:missing={missing.includes(bookmark.uri)}
						class:drop-before={mark === 'before'}
						class:drop-after={mark === 'after'}
						class:dragging={drag?.active && drag.from === i}
						title={bookmark.uri}
						data-index={i}
						tabindex={i === tileStop ? 0 : -1}
						onclick={(e) => {
							// A press on the grip is a drag, not an open (契約8 (af)).
							if (e.target instanceof Element && e.target.closest('.bookmark-grip')) return;
							void openTarget(bookmarkTarget(bookmark.uri, bookmark.kind));
						}}
						oncontextmenu={(e) => openTileMenu(e, i)}
						onkeydown={(e) => handleTileKeyDown(e, i)}
						onfocus={() => (tileFocus = i)}
					>
						<span class="tile-icon" style:color={`var(${view.icon.color})`}
							><Icon name={view.icon.name} size={20} /></span
						>
						<span class="tile-text">
							<span class="tile-name">{view.name}</span>
							<span class="tile-path">{view.path}</span>
						</span>
						{#if view.ssh}
							<span class="ssh-badge">SSH</span>
						{/if}
						<!-- 掴み手(契約8)。押すのは「開く」ではない(タイルのクリックは掴み手の上なら開かない)。 -->
						<span
							class="bookmark-grip"
							aria-hidden="true"
							onpointerdown={(e) => handleGripPointerDown(e, i, bookmark.uri)}
							onpointermove={handleGripPointerMove}
							onpointerup={handleGripPointerUp}
							onpointercancel={cancelDrag}
							onlostpointercapture={() => {
								if (drag) cancelDrag();
							}}><Icon name="grip" size={16} /></span
						>
					</button>
				{/each}
				<button
					class="add-bookmark"
					tabindex={tileStop === bookmarks.list.length ? 0 : -1}
					onclick={(e) => void openAddMenu(e)}
					onkeydown={(e) => handleTileKeyDown(e, bookmarks.list.length)}
					onfocus={() => (tileFocus = bookmarks.list.length)}><Icon name="plus" size={16} />{ADD_BOOKMARK_LABEL}</button
				>
			</div>
		</section>

		<div class="lower">
			<section class="dashboard-recent-folders">
				<h2 class="section-header">
					<Icon name="history" size={14} />{RECENT_FOLDERS_HEADING}{#if recentView.summary}<span
							class="sub">{recentView.summary}</span
						>{/if}
				</h2>
				{#if recentView.rows.length > 0}
					<div class="list">
						{#each recentView.rows as row, i (row.uri)}
							<!-- 行= 行のボタンと × を兄弟に並べる包み(契約10 追補a。ボタンを入れ子にしない)。 -->
							<div class="recent-row">
								<button
									class="recent-folder"
									class:missing={row.missing}
									title={row.uri}
									tabindex={i === recentStop ? 0 : -1}
									onclick={() => void openTarget({ kind: 'folder', uri: row.uri })}
									oncontextmenu={(e) => openRecentMenu(e, row.uri)}
									onkeydown={(e) => handleRecentKeyDown(e, i, row.uri)}
									onfocus={() => (recentFocus = i)}
								>
									<span class="row-icon folder-icon"><Icon name={row.ssh ? 'server' : 'folder'} size={20} /></span>
									<span class="row-text">
										<span class="row-name">{row.label}</span>
										<span class="row-path">{row.path}</span>
									</span>
									{#if row.ssh}
										<span class="ssh-badge">SSH</span>
									{/if}
								</button>
								<!--
									× は Tab の止まり先にしない(Delete キーが同じことをする=契約13 追補a)。押してもフォーカスを
									取らない: macOS の WebKit はマウスでフォーカスを取らないボタンの mousedown でフォーカスを body
									に落とすので、既定を止めて元の場所に残す(外した後のフォーカスの規則がそれを見る)。
									右クリックは行と同じメニュー(WebKit の既定のメニューを出さない)。
								-->
								<button
									class="recent-remove"
									aria-label={REMOVE_FROM_RECENT_FOLDERS_LABEL}
									title={REMOVE_FROM_RECENT_FOLDERS_LABEL}
									tabindex="-1"
									onmousedown={(e) => e.preventDefault()}
									onclick={() => void removeRecentFolder(row.uri)}
									oncontextmenu={(e) => openRecentMenu(e, row.uri)}><Icon name="x" size={14} /></button
								>
							</div>
						{/each}
					</div>
				{:else}
					<p class="empty">{NO_RECENT_FOLDERS_MESSAGE}</p>
				{/if}
				{#if recentView.toggleLabel}
					<!-- 見出しの右に描くが、Tab の順は行の後(契約13 (am))。 -->
					<button class="section-action" onclick={() => (expanded = !expanded)}>{recentView.toggleLabel}</button>
				{/if}
			</section>

			<section class="dashboard-recently-modified">
				<h2 class="section-header">
					<Icon name="pencil" size={14} />{RECENTLY_MODIFIED_HEADING}{#if scan.folders > 0}<span
							class="sub">{foldersScannedLabel(scan.folders)}</span
						>{/if}
				</h2>
				{#if scan.files.length > 0}
					<div class="list">
						{#each scan.files as file, i (file.uri)}
							{@const row = modifiedView(file)}
							<button
								class="modified-row"
								title={file.uri}
								tabindex={i === modifiedStop ? 0 : -1}
								onclick={() => void openTarget({ kind: 'modified', uri: file.uri, folder: file.folder })}
								onkeydown={(e) => handleRowKeyDown(e, i, scan.files.length, 'modified')}
								onfocus={() => (modifiedFocus = i)}
							>
								<span class="row-icon" style:color={`var(${row.icon.color})`}
									><Icon name={row.icon.name} size={20} /></span
								>
								<span class="row-text">
									<span class="row-name">{row.name}</span>
									<span class="row-path">
										{#each row.segments as segment, j (j)}
											{#if j > 0}<span class="segment-sep"><Icon name="chev-r" size={11} /></span>{/if}<span
												>{segment}</span
											>
										{/each}
									</span>
								</span>
								<span class="when">{row.when}</span>
							</button>
						{/each}
					</div>
				{:else}
					<p class="empty">{modifiedEmpty}</p>
				{/if}
				{#if scan.truncated}
					<p class="scan-note">{SCAN_TRUNCATED_MESSAGE}</p>
				{/if}
				<button class="section-action rescan" aria-label={RESCAN_LABEL} onclick={startScan}
					><Icon name="restart" size={14} /></button
				>
			</section>
		</div>

		<footer class="tip">{DASHBOARD_TIP}</footer>
	</div>

	<!-- タイルと行の右クリックのメニュー(契約14 (an)= 同じストア・窓に開くメニューは 1 つ)。 -->
	<ContextMenu
		onDuplicateWindow={() => {}}
		onOpenInNewWindow={() => {}}
		onDashboardItem={handleDashboardItem}
	/>
</div>

<style>
	/*
	 * Dashboard(要件#83 契約2・モックの画面 1)。中身は 1120px を上限に中央・タイルは最小 220px で
	 * 列を減らす・880px 未満で下の段を 1 列に積む((u))。縦にはみ出したら Dashboard の中で巻く。
	 */
	.dashboard {
		flex: 1;
		min-height: 0;
		min-width: 0;
		overflow-y: auto;
		background-color: var(--color-bg-surface);
		container-type: inline-size;
	}

	.dashboard-content {
		box-sizing: border-box;
		width: 100%;
		max-width: 1152px;
		margin: 0 auto;
		padding: 34px var(--space-4) var(--space-6);
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
		color: var(--color-text-primary);
	}

	/* 上の段(銘と版・右に操作)。 */
	.dashboard-top {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.wordmark {
		font-size: 30px;
		font-weight: 700;
		line-height: 1.1;
		letter-spacing: -0.02em;
	}

	.version {
		margin-top: 3px;
		font-size: var(--text-sm);
		color: var(--color-text-muted);
	}

	.top-actions {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.top-button {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 28px;
		padding: 0 12px;
		border: 1px solid transparent;
		border-radius: 6px;
		background: transparent;
		color: var(--color-text-secondary);
		font: inherit;
		font-size: 12.5px;
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
	}

	.top-button:hover {
		background-color: var(--color-bg-hover);
		color: var(--color-text-primary);
	}

	.kbd {
		display: inline-flex;
		align-items: center;
		height: 18px;
		margin-left: 4px;
		padding: 0 5px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background-color: var(--color-bg-surface);
		color: var(--color-text-muted);
		font-size: 11px;
		font-weight: 500;
	}

	/* 主ボタン(モックの `.btn.pri.lg`)。 */
	.pick-folder {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 34px;
		padding: 0 16px;
		border: 1px solid transparent;
		border-radius: 7px;
		background-color: var(--color-accent);
		color: var(--color-on-accent);
		font: inherit;
		font-size: var(--text-md);
		font-weight: 500;
		cursor: pointer;
	}

	.pick-folder:hover {
		filter: brightness(1.1);
	}

	.error {
		margin: 0;
		font-size: var(--text-md);
		color: var(--color-danger);
	}

	section {
		position: relative;
		min-width: 0;
	}

	/* 区画の見出し(区画の見出しの 3 トークン=要件#56)。 */
	.section-header {
		display: flex;
		align-items: center;
		gap: 7px;
		height: 22px;
		margin: 0 0 10px;
		padding-right: 96px;
		color: var(--color-text-muted);
		font-size: var(--pane-header-font-size);
		font-weight: var(--pane-header-font-weight);
		letter-spacing: var(--pane-header-letter-spacing);
		text-transform: uppercase;
	}

	.sub {
		font-weight: 500;
		letter-spacing: 0;
		text-transform: none;
	}

	.count {
		padding: 0 5px;
		border-radius: 4px;
		background-color: var(--color-bg-hover);
		color: var(--color-text-muted);
		font-size: 10.5px;
		line-height: 16px;
		letter-spacing: 0;
	}

	/* 見出しの右の操作(Show All・走査し直し)。DOM では一覧の後(Tab の順)に置き、ここで見出しの行へ。 */
	.section-action {
		position: absolute;
		top: 0;
		right: 0;
		height: 22px;
		padding: 0 6px;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--color-accent-text);
		font: inherit;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
	}

	.section-action:hover {
		background-color: var(--color-bg-hover);
	}

	.rescan {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		padding: 0;
		color: var(--color-text-secondary);
	}

	/* Bookmarks のタイル(モックの `.db-tile`)。 */
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 12px;
	}

	.bookmark-tile,
	.add-bookmark {
		position: relative;
		box-sizing: border-box;
		height: 78px;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 0 12px 0 14px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background-color: var(--color-bg-base);
		color: var(--color-text-primary);
		font: inherit;
		text-align: left;
		cursor: pointer;
		user-select: none;
		-webkit-user-select: none;
	}

	.bookmark-tile:hover {
		background-color: var(--color-bg-hover);
		border-color: var(--color-border-strong);
	}

	.bookmark-tile.missing {
		opacity: 0.5;
	}

	.bookmark-tile.dragging {
		opacity: 0.6;
	}

	/* 落とす先の印(契約8 (af))。前へ運ぶときはタイルの前・後ろへ運ぶときは後。 */
	.bookmark-tile.drop-before::before,
	.bookmark-tile.drop-after::after {
		content: '';
		position: absolute;
		top: 6px;
		bottom: 6px;
		width: 3px;
		border-radius: 2px;
		background-color: var(--color-accent);
	}

	.bookmark-tile.drop-before::before {
		left: -8px;
	}

	.bookmark-tile.drop-after::after {
		right: -8px;
	}

	.add-bookmark {
		justify-content: center;
		gap: 8px;
		border-style: dashed;
		background: transparent;
		color: var(--color-text-secondary);
		font-size: 13px;
		font-weight: 500;
	}

	.add-bookmark:hover {
		background-color: var(--color-bg-hover);
	}

	.tile-icon {
		width: 36px;
		height: 36px;
		flex: none;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 9px;
		background-color: var(--color-bg-hover);
	}

	.tile-text,
	.row-text {
		min-width: 0;
		flex: 1;
		display: flex;
		flex-direction: column;
	}

	.tile-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13.5px;
		font-weight: 600;
		line-height: 1.3;
	}

	.tile-path,
	.row-path {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-text-muted);
		font-family: var(--font-mono);
		font-size: 11.5px;
		line-height: 1.4;
	}

	.ssh-badge {
		flex: none;
		padding: 1px 6px;
		border-radius: 4px;
		background-color: var(--color-bg-hover);
		color: var(--color-text-secondary);
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.05em;
	}

	.bookmark-tile .ssh-badge {
		position: absolute;
		top: 9px;
		right: 10px;
	}

	/* 掴み手はホバーとフォーカスのときだけ(モックの注記 4)。 */
	.bookmark-grip {
		position: absolute;
		top: 50%;
		right: 8px;
		margin-top: -8px;
		display: none;
		color: var(--color-text-muted);
		cursor: grab;
		touch-action: none;
	}

	.bookmark-tile:hover .bookmark-grip,
	.bookmark-tile:focus-visible .bookmark-grip,
	.bookmark-tile.dragging .bookmark-grip {
		display: block;
	}

	.bookmark-tile:hover .ssh-badge,
	.bookmark-tile:focus-visible .ssh-badge {
		right: 30px;
	}

	/* 下の段 2 列(左= Recent Folders・右= Recently Modified)。狭い窓では 1 列に積む。 */
	.lower {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr);
		gap: 28px;
		align-items: start;
	}

	@container (max-width: 911px) {
		.lower {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	/* 行の一覧(モックの `.rf-list`)。 */
	.list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 5px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background-color: var(--color-bg-base);
	}

	.recent-folder,
	.modified-row {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		padding: 8px 10px;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--color-text-primary);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	/* Recent Folders の行は包みに地を敷く(× の上にポインタがあっても行のホバーのまま)。 */
	.recent-row:hover,
	.modified-row:hover {
		background-color: var(--color-bg-hover);
	}

	.recent-folder.missing {
		opacity: 0.5;
	}

	/* Recent Folders の行の包み(行のボタンと ×=契約10 追補a)。 */
	.recent-row {
		display: flex;
		align-items: center;
		border-radius: 6px;
	}

	.recent-row .recent-folder {
		flex: 1;
		min-width: 0;
	}

	/*
	 * 行の ×。マウスを乗せた行とフォーカスのある行だけに見せる。見えないときも場所は取ったまま
	 * (行の幅と名前の切り詰めが揺れない)。
	 */
	.recent-remove {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		margin-right: 6px;
		padding: 0;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		visibility: hidden;
	}

	.recent-row:hover .recent-remove,
	.recent-row:focus-within .recent-remove {
		visibility: visible;
	}

	.recent-remove:hover {
		background-color: var(--color-bg-hover);
		color: var(--color-text-primary);
	}

	.row-icon {
		display: inline-flex;
		flex: none;
	}

	.folder-icon {
		color: var(--ft-folder);
	}

	.row-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13.5px;
		font-weight: 500;
		line-height: 1.3;
	}

	.row-path {
		display: flex;
		align-items: center;
		font-size: 12px;
	}

	.segment-sep {
		display: inline-flex;
		margin: 0 3px;
		opacity: 0.6;
	}

	.when {
		margin-left: auto;
		padding-left: 12px;
		flex: none;
		color: var(--color-text-muted);
		font-size: 11.5px;
		white-space: nowrap;
	}

	.empty,
	.scan-note {
		margin: 0;
		color: var(--color-text-muted);
		font-size: var(--text-md);
	}

	.scan-note {
		margin-top: 8px;
		font-size: var(--text-sm);
	}

	/* 足元(Tip)。 */
	.tip {
		padding-top: var(--space-4);
		border-top: 1px solid var(--color-border);
		color: var(--color-text-muted);
		font-size: var(--text-sm);
	}
</style>
