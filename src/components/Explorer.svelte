<script lang="ts">
	import { invoke } from '$lib/ipc';
	import { confirmDiscardEdits } from '$lib/edit-guard';
	import { newTabFailedMessage, openNewTab, planNewTab } from '$lib/new-tab';
	import { detectFileType } from '$lib/file-type';
	import { openFileFailedMessage, openForDisplay } from '$lib/open-document';
	import { openInNewWindowFailedMessage } from '$lib/open-in-new-window';
	import { openFolderFailedMessage } from '$lib/root-picker';
	import { DEFAULT_PANE_WIDTH } from '$lib/pane-resize';
	import { DEFAULT_ZOOM } from '$lib/zoom';
	import { parentUri } from '$lib/uri';
	import type { NewWindowAction } from '$lib/context-menu';
	import { windowState, type Entry } from '../stores/window-state.svelte';
	import { contextMenu } from '../stores/context-menu.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import ExplorerItem from './ExplorerItem.svelte';

	type RootPayload = {
		root_uri: string;
		entries: Entry[];
		document_retained: boolean;
	};

	let {
		root,
		entries,
		selectedUri,
		width = DEFAULT_PANE_WIDTH,
		explorerZoom = DEFAULT_ZOOM,
		onDuplicateWindow,
		onOpenInNewWindow,
		onFindInFolder
	}: {
		root: string;
		entries: Entry[];
		selectedUri: string | undefined;
		/**
		 * ペイン幅(px・要件#9)。値の妥当性(下限200・ウインドウ幅50%の上限)は
		 * `$lib/pane-resize` が持ち、ここは受け取った幅を反映するだけ。
		 */
		width?: number;
		/**
		 * ツリーの倍率(%・要件#63 契約1)。`nav.explorer-list` にだけ CSS `zoom` で当てる
		 * (ペイン幅・見出し行は動かさない)。判別と保存は `$lib/zoom-target` の持ち場。
		 */
		explorerZoom?: number;
		/** 「ウィンドウを複製」(要件#34)。ここは右クリックから呼ぶだけ。 */
		onDuplicateWindow: () => void;
		/** 「Open in New Window」(要件#59)。実行列はページ側=ここは中継するだけ。 */
		onOpenInNewWindow: (plan: NewWindowAction) => void;
		/**
		 * 見出し行の検索ボタン(要件#55 追補c)。メニューの Find in Folder… と同じ受け口を
		 * ページ側から受け取って呼ぶだけ(パネルの出し入れはページ側の持ち場)。
		 */
		onFindInFolder?: () => void;
	} = $props();

	// 親フォルダの導出は `$lib/uri` の共有実装(要件#59 起案時判断 (f))。
	// 「↑」ボタンとコンテキストメニューの Open in New Window が同じ規則を使う。
	let parent = $derived(parentUri(root));

	async function goUp() {
		if (!parent) return;
		// 要件#48 契約④: root を上げると編集は持ち越せない。先に始末を聞く。
		if (!(await confirmDiscardEdits())) return;
		let res: RootPayload;
		try {
			res = await invoke<RootPayload>('set_root', { uri: parent });
		} catch (err) {
			// 要件#71 契約3: 開けなかったら知らせて、root はそのまま。
			alert(openFolderFailedMessage(err));
			return;
		}
		windowState.applyRoot(res.root_uri, res.entries, res.document_retained);
	}

	/**
	 * ファイルを今の窓の新しいタブで開く(要件#62 契約3・4)。ツリーの Command +
	 * クリックと右クリックの Open in New Tab がここを通る。新しいタブの root と
	 * 展開は今の窓のもの。今のタブの文書は動かないので未保存確認は挟まない
	 * (Shift+クリック=新しい窓と同じ線引き)。失敗は手応えが無いので alert。
	 */
	async function openInNewTab(path: string) {
		const plan = planNewTab({ rootUri: root, docUri: path, expandedDirs: windowState.expandedDirs });
		if (plan === null) return;
		try {
			await openNewTab(plan);
		} catch (err) {
			alert(newTabFailedMessage(err));
		}
	}

	async function handleFileClick(e: MouseEvent, entry: Entry) {
		// 要件#2: バイナリは表示対象外。エラーにはせず、開かないだけにする。
		// 画像(要件#16)・動画(要件#28)はここを通る — どちらも binary ではない。
		if (detectFileType(entry.uri) === 'binary') return;
		// 要件#70 契約6: リンク切れは開けないので、修飾キーによらず何もしない
		// (未保存確認も alert も出さず、表示中の文書と選択はそのまま)。
		if (entry.link?.broken) return;
		// 要件#62 契約3: Command + クリックは新しいタブ。Shift が一緒なら従来どおり
		// 新しい窓(Shift の意味を変えない)。
		if (e.metaKey && !e.shiftKey) {
			await openInNewTab(entry.uri);
			return;
		}
		// 要件#48 契約④: この窓で別のファイルを開くと編集は消える。新しい窓で
		// 開く(Shift)ときはこの窓の文書が動かないので聞かない。
		if (!e.shiftKey && !(await confirmDiscardEdits())) return;
		if (e.shiftKey) {
			// Open in a new window -- current window state is unaffected.
			try {
				await invoke('new_window', { path: entry.uri, root });
			} catch (err) {
				// 要件#71 契約4
				alert(openInNewWindowFailedMessage(err));
			}
		} else {
			// Open in this window. Main swaps the DocumentSession only once the new
			// one opened (要件#71 契約1). ラスタ画像だけは `open_document` を通らない(要件#16 ⑦)。
			try {
				windowState.setDocument(await openForDisplay(entry.uri));
			} catch (err) {
				// 要件#71 契約2: 知らせて、表示中の文書とツリーの選択は前のまま。
				alert(openFileFailedMessage(err));
			}
		}
	}

	/**
	 * ツリーの空白部分の右クリック(要件#34③)。アイテムを指していないので、
	 * 出すのは窓に効く項目だけのメニュー。
	 *
	 * アイテムの上で押したときは ExplorerItem 側が先に受けて `preventDefault` する
	 * ので、バブリングでここまで来ても割り込まない(既存のアイテムメニューが優先)。
	 */
	function handlePaneContextMenu(e: MouseEvent) {
		if (e.defaultPrevented) return;
		e.preventDefault();
		contextMenu.openTreePaneAt(e.clientX, e.clientY);
	}
</script>

<!-- data-zoom-region=要件#63 契約3の領域の目印(見出し行の上もツリー側とみなす)。 -->
<aside
	class="explorer"
	data-zoom-region="explorer"
	style="width: {width}px"
	oncontextmenu={handlePaneContextMenu}
>
	<div class="explorer-header">
		<span class="explorer-title">Explorer</span>
		<button
			class="up-button find-button"
			onclick={() => onFindInFolder?.()}
			title="Find in Folder"
			aria-label="Find in Folder"
		>
			<svg
				aria-hidden="true"
				width="20"
				height="20"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				><circle cx="11" cy="11" r="7" /><line x1="16.5" y1="16.5" x2="21" y2="21" /></svg
			>
		</button>
		<button
			class="up-button"
			onclick={goUp}
			disabled={!parent}
			title="Go to Parent Folder"
			aria-label="Go to Parent Folder"
		>
			↑
		</button>
	</div>
	<!-- 等倍では宣言を出さない(Viewer.svelte の .markdown-body と同じ流儀=導入前と同じ DOM)。 -->
	<nav
		class="explorer-list"
		style:zoom={explorerZoom === DEFAULT_ZOOM ? null : `${explorerZoom}%`}
	>
		{#each entries as entry (entry.uri)}
			<ExplorerItem
				{entry}
				depth={0}
				{selectedUri}
				onFileClick={handleFileClick}
			/>
		{/each}
	</nav>
</aside>

<!--
	コンテキストメニューはウインドウにつき1つ(要件#19)。position: fixed なので
	Explorer の overflow には切られず、ツリーの外にもはみ出して表示できる。
	アイテムのメニューも空白部のメニュー(要件#34)もこの1つが描く。
-->
<ContextMenu {onDuplicateWindow} {onOpenInNewWindow} onOpenInNewTab={openInNewTab} />

<style>
	/*
	 * 幅は `width` prop(既定 = DEFAULT_PANE_WIDTH)からインラインで与える(要件#9)。
	 * 以前ここにあった width / min-width / max-width の固定値は、判定を一箇所に
	 * まとめるため `$lib/pane-resize` の clamp に移した。ここでは伸縮だけ止める。
	 */
	.explorer {
		flex: 0 0 auto;
		display: flex;
		flex-direction: column;
		border-right: 1px solid var(--color-border);
		background-color: var(--color-bg-secondary);
		overflow: hidden;
	}

	.explorer-header {
		padding: 6px 8px 6px 12px;
		/* 要件#64 追補b: 文字は下の区画の見出しと同じトークン(theme.css)。 */
		font-size: var(--pane-header-font-size);
		font-weight: var(--pane-header-font-weight);
		text-transform: uppercase;
		letter-spacing: var(--pane-header-letter-spacing);
		color: var(--color-text-secondary);
		border-bottom: 1px solid var(--color-border);
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	/* 要件#55 追補c: ボタンが 2 つになったので、見出しを左に寄せ、↑ と検索を右に並べる。 */
	.explorer-title {
		margin-right: auto;
	}

	.up-button {
		background: transparent;
		border: 1px solid transparent;
		border-radius: 4px;
		color: var(--color-text-secondary);
		cursor: pointer;
		/* 要件#55 追補c-3: ↑ も ⌕ と同じ約 28px 角の外形に揃え、文字を 18px に上げる。 */
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		font-size: 18px;
		line-height: 1;
		padding: 0;
	}

	/*
	 * 要件#55 追補c-3: ⌕ は文字をやめ、20px 角のインライン SVG の虫眼鏡にする(文字グリフは黒みが小さい)。
	 * ボタンの外形は約 28px 角(↑ と同じ)で、SVG を中央に置く。
	 */
	.find-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
	}

	.up-button:hover:not(:disabled) {
		background-color: var(--color-bg-hover);
		border-color: var(--color-border);
		color: var(--color-text-hover);
	}

	.up-button:disabled {
		cursor: default;
		opacity: 0.3;
	}

	.explorer-list {
		flex: 1;
		overflow-y: auto;
		padding: 4px 0;
	}
</style>
