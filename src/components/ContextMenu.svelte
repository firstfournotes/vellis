<script lang="ts">
	/**
	 * ツリーのコンテキストメニュー(要件#19)。ネイティブ popup_menu は使わず
	 * 自前の div を絶対配置する(契約①)。開いているメニューは常に1つで、
	 * 状態は `stores/context-menu.svelte` が持つ。
	 *
	 * アイテムを右クリックしたメニューと、ツリーの空白部分のメニュー(要件#34)と、
	 * 文書の本文のメニュー(要件#80 契約 8)のどれもここが描く。違いは項目だけ
	 * (空白部と本文は entry を持たない)。Dashboard のタイルと行のメニュー(要件#83 契約 14)
	 * も、Dashboard の中に置いたもう 1 つのこの部品が描く(項目の実行は `onDashboardItem`)。
	 */
	import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
	import { open as openDialog } from '@tauri-apps/plugin-dialog';
	import {
		clampMenuPosition,
		planContextAction,
		planOpenWith,
		type BookmarkAction,
		type ContextAction,
		type ContextMenuEntry,
		type ContextMenuItemId,
		type DashboardMenuTarget,
		type NewWindowAction
	} from '$lib/context-menu';
	import { addBookmark, bookmarkSaveFailedMessage, removeBookmark } from '$lib/bookmarks';
	import { contextMenu } from '../stores/context-menu.svelte';

	let {
		onDuplicateWindow,
		onOpenInNewWindow,
		onOpenInNewTab,
		onReloadFile,
		onReloadFolder,
		onDashboardItem
	}: {
		/**
		 * 「ウィンドウを複製」(要件#34)。中身(root・文書・展開)を知っているのは
		 * ページ側なので、複製の実行列はそちらに置いて呼ぶだけにする —
		 * File メニューの Duplicate Window と同じ関数を通る。
		 */
		onDuplicateWindow: () => void;
		/**
		 * 「Open in New Window」(要件#59)。計画(root と path)は純関数が決め、
		 * `new_window` の呼び出しと失敗の通知はページ側 — 複製とまったく同じ分担。
		 */
		onOpenInNewWindow: (plan: NewWindowAction) => void;
		/**
		 * 「Open in New Tab」(要件#62)。受け取るのはファイルの URI だけで、root と
		 * 展開を足して `new_tab` を呼ぶのは Explorer 側 — ツリーの Command + クリックと
		 * 同じ関数を通る。省略時は何もしない(メニュー単体のマウント用)。
		 */
		onOpenInNewTab?: (path: string) => void;
		/**
		 * 「Reload File」(要件#80 契約 8・9)。行の URI(本文のメニューは null=今の文書)を
		 * 渡すだけで、確認・読み直し・ツリーの読み直しはページ側の実行列。省略時は何もしない。
		 */
		onReloadFile?: (uri: string | null) => void;
		/**
		 * 「Reload Folder」(要件#80 契約 14・15)。フォルダの行の URI(空白は null=root)を
		 * 渡すだけで、一覧の読み直しは Explorer 側の実行列。省略時は何もしない。
		 */
		onReloadFolder?: (uri: string | null) => void;
		/**
		 * Dashboard のメニューの項目(要件#83 契約 14・7)。押した項目と、メニューを開いた対象
		 * (タイル・行・Add Bookmark…)を渡すだけで、実行は Dashboard 側。省略時は何もしない。
		 */
		onDashboardItem?: (id: ContextMenuItemId, target: DashboardMenuTarget) => void;
	} = $props();

	let el = $state<HTMLDivElement | null>(null);
	/**
	 * 実寸を測ってからクランプするので、初回描画の1フレームだけ座標が決まらない。
	 * その間は非表示にしておき、ウインドウ端で一瞬はみ出して見えるのを避ける。
	 */
	let pos = $state<{ x: number; y: number } | null>(null);

	$effect(() => {
		if (!contextMenu.open) {
			pos = null;
			return;
		}
		const node = el;
		if (!node) return;
		const raw = { x: contextMenu.x, y: contextMenu.y };
		const rect = node.getBoundingClientRect();
		pos = clampMenuPosition(
			raw,
			{ width: rect.width, height: rect.height },
			{ width: window.innerWidth, height: window.innerHeight }
		);
	});

	/**
	 * 項目の実行。計画は純関数側が持ち、ここは呼ぶだけ。失敗しても警告に留めて
	 * アプリは壊さない(Finder / 既定アプリが応えないことはある)。
	 */
	/**
	 * 押された項目の実行計画。ツリーの空白部から開いたメニュー(要件#34)は
	 * entry を持たないが、そこに並ぶのは entry を読まない窓操作だけなので、
	 * アイテムから開いたときと同じ計画に落ちる。本文のメニューの Reload File と
	 * 空白部の Reload Folder(要件#80)は URI を null にする(=今の文書・root)。
	 */
	function planFor(
		id: ContextMenuItemId,
		entry: ContextMenuEntry | null,
		viewerUri: string | null
	): ContextAction | null {
		if (entry !== null) return planContextAction(id, entry);
		if (id === 'duplicate-window') return { command: 'duplicate-window' };
		if (id === 'reload-file') return { command: 'reload-file', uri: null };
		if (id === 'reload-folder') return { command: 'reload-folder', uri: null };
		// 本文のメニューの Pin / Unpin(要件#83 契約 7)= 今の文書をファイルとして。
		if (id === 'pin-to-bookmarks' && viewerUri !== null) {
			return { command: 'pin-bookmark', uri: viewerUri, kind: 'file' };
		}
		if (id === 'unpin-from-bookmarks' && viewerUri !== null) {
			return { command: 'unpin-bookmark', uri: viewerUri };
		}
		return null;
	}

	/**
	 * Bookmark に足す・外す(要件#83 契約 7)。一覧の反映は Rust の `bookmarks_changed` が全窓へ
	 * 届けるので、ここは呼ぶだけ。書けなかったら 1 回知らせる(一覧は前のまま)。
	 */
	async function changeBookmark(action: BookmarkAction) {
		try {
			if (action.command === 'pin-bookmark') await addBookmark(action.uri, action.kind);
			else await removeBookmark(action.uri);
		} catch (err) {
			alert(bookmarkSaveFailedMessage(err));
		}
	}

	async function activate(id: ContextMenuItemId) {
		const entry = contextMenu.entry;
		const viewerUri = contextMenu.viewerUri;
		const dashboardTarget = contextMenu.dashboardTarget;
		contextMenu.close();
		if (dashboardTarget !== null) {
			onDashboardItem?.(id, dashboardTarget);
			return;
		}
		const action = planFor(id, entry, viewerUri);
		if (!action) return;
		if (action.command === 'pin-bookmark' || action.command === 'unpin-bookmark') {
			await changeBookmark(action);
			return;
		}
		try {
			if (action.command === 'duplicate-window') {
				onDuplicateWindow();
			} else if (action.command === 'new-window') {
				onOpenInNewWindow(action);
			} else if (action.command === 'new-tab') {
				onOpenInNewTab?.(action.path);
			} else if (action.command === 'reload-file') {
				onReloadFile?.(action.uri);
			} else if (action.command === 'reload-folder') {
				onReloadFolder?.(action.uri);
			} else if (action.command === 'reveal_item_in_dir') {
				await revealItemInDir(action.path);
			} else if (action.command === 'open_path') {
				await openPath(action.path);
			} else if (action.command === 'pick-app') {
				// pick-app は entry を読んだ計画なので、ここへ来るのは entry がある場合だけ。
				if (entry) await openWithPickedApp(entry);
			} else {
				await navigator.clipboard.writeText(action.text);
			}
		} catch (err) {
			console.warn(`context menu action ${id} failed for ${entry?.uri ?? '(no item)'}:`, err);
		}
	}

	/**
	 * 「アプリを選択して開く…」(要件#21)。/Applications を既定に .app を選ばせ、
	 * 選ばれた .app で開く。macOS のダイアログは .app をファイルとして選べる。
	 * キャンセルは無変化(計画側が null を返す)。
	 */
	async function openWithPickedApp(entry: ContextMenuEntry) {
		const selected = await openDialog({
			multiple: false,
			directory: false,
			defaultPath: '/Applications',
			filters: [{ name: 'Applications', extensions: ['app'] }]
		});
		const plan = planOpenWith(entry, typeof selected === 'string' ? selected : null);
		if (!plan) return;
		await openPath(plan.path, plan.with);
	}

	function handleWindowPointerDown(e: PointerEvent) {
		if (!contextMenu.open) return;
		// メニュー内のクリックは項目の実行が受け持つ。外側なら閉じる。
		if (el && e.target instanceof Node && el.contains(e.target)) return;
		contextMenu.close();
	}

	function handleWindowKeyDown(e: KeyboardEvent) {
		if (contextMenu.open && e.key === 'Escape') contextMenu.close();
	}

	/**
	 * 追補b: 開いている間にページのどこかがスクロールしたら閉じる(メニューは `position: fixed`
	 * なので、残すと項目の行から離れて浮いて見える)。要素の `scroll` はバブルしないので、
	 * `window` の capture 段で受けて中の要素のスクロールも拾う。メニュー自身の中の
	 * スクロールでは閉じない。閉じるだけで項目は実行しない。
	 */
	function handleWindowScroll(e: Event) {
		if (!contextMenu.open) return;
		if (el && e.target instanceof Node && el.contains(e.target)) return;
		contextMenu.close();
	}
</script>

<svelte:window
	onpointerdown={handleWindowPointerDown}
	onkeydown={handleWindowKeyDown}
	onscrollcapture={handleWindowScroll}
/>

{#if contextMenu.open}
	<!-- 自前メニューの上では webview 既定のメニューを出さない(ツリー上と同じ扱い)。 -->
	<div
		class="context-menu"
		bind:this={el}
		role="menu"
		tabindex="-1"
		style="left: {(pos?.x ?? contextMenu.x)}px; top: {(pos?.y ?? contextMenu.y)}px; visibility: {pos
			? 'visible'
			: 'hidden'}"
		oncontextmenu={(e) => e.preventDefault()}
	>
		{#each contextMenu.items as item, i (item.id)}
			{#if item.separatorBefore || (item.id === 'duplicate-window' && i > 0)}
				<!--
					アイテムに効く項目と窓に効く項目の境目(要件#34③)。区切りは見た目
					だけのものなので VM の項目には現れない。空白部のメニュー(項目が
					これ1つ)では境目が無いので出さない。
				-->
				<div class="context-menu-separator" role="separator"></div>
			{/if}
			<!--
				無効の項目は押しても何もしない(メニューも閉じない)。WebKit は disabled のボタンに
				click を送らないが、届いた場合も同じにする(要件#80 契約 9 の Reload File=開いていない行)。
			-->
			<button
				class="context-menu-item"
				role="menuitem"
				disabled={!item.enabled}
				onclick={() => {
					if (item.enabled) void activate(item.id);
				}}
			>
				{item.label}
			</button>
		{/each}
	</div>
{/if}

<style>
	/*
	 * 重なりの 1 段(要件#56 契約 4= `--color-bg-raised` + `--shadow-2` + `--radius-md`)。
	 * 縁の線は `--shadow-2` の 1px の輪が持つ(モックの右クリックメニュー)。
	 */
	.context-menu {
		position: fixed;
		z-index: 100;
		min-width: 200px;
		padding: 5px;
		border-radius: var(--radius-md);
		background-color: var(--color-bg-raised);
		box-shadow: var(--shadow-2);
		outline: none;
	}

	/* 項目(モックの `.mi`= 26px・角丸)。選ぶ行はアクセントの面に白い文字(macOS のメニューと同じ)。 */
	.context-menu-item {
		display: flex;
		align-items: center;
		box-sizing: border-box;
		width: 100%;
		height: 26px;
		padding: 0 8px;
		border: none;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--color-text-primary);
		font: inherit;
		font-size: var(--text-md);
		line-height: 1.2;
		text-align: left;
		white-space: nowrap;
		cursor: pointer;
	}

	.context-menu-item:hover:not(:disabled) {
		background-color: var(--color-accent);
		color: var(--color-on-accent);
	}

	.context-menu-item:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: -2px;
	}

	/* 「ウィンドウを複製」(要件#34)を他の項目から切る線。 */
	.context-menu-separator {
		height: 1px;
		margin: 5px 6px;
		background-color: var(--color-border);
	}

	/* ssh リモートの「Finder で表示」「既定アプリで開く」= 出すが押せない(契約⑤)。 */
	.context-menu-item:disabled {
		color: var(--color-text-muted);
		cursor: default;
	}
</style>
