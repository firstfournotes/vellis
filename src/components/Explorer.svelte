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
	import { createFolderReloader } from '$lib/reload-file';
	import type { NewWindowAction } from '$lib/context-menu';
	import { windowState, type Entry } from '../stores/window-state.svelte';
	import { contextMenu } from '../stores/context-menu.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import ExplorerItem from './ExplorerItem.svelte';
	import Icon from './Icon.svelte';

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
		onFindInFolder,
		onReloadFile
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
		/**
		 * 右クリックの Reload File(要件#80 契約 8・9)。実行列(確認・読み直し・ツリー)は
		 * ページ側にあり、View ▸ Reload File と同じものを呼ぶ=ここは中継するだけ。
		 * 引数は行の URI(本文のメニューは null=今の文書)。省略時は何もしない。
		 */
		onReloadFile?: (uri: string | null) => void;
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
	 * 右クリックの Reload Folder(要件#80 契約 14・15)。フォルダの行はそのフォルダとその下の
	 * 展開中のフォルダ、空白(null)は root と展開中のフォルダを `list_dir` で読み直し、
	 * 監視の `directory_changed` と同じ当て方で当てる(展開の状態は保つ)。畳んである行は
	 * 開くだけ(読むのは ExplorerItem の展開の effect)。失敗は 1 回だけ知らせる。
	 * 窓に 1 つ=最中の重ね押しは実行列が捨てる。
	 */
	const folderReloader = createFolderReloader({
		root: () => windowState.root,
		expandedDirs: () => windowState.expandedDirs,
		isExpanded: (uri) => windowState.isExpanded(uri),
		expand: (uri) => windowState.toggleExpanded(uri),
		listDir: (uri) => invoke<Entry[]>('list_dir', { uri }),
		apply: (uri, entries) => windowState.applyDirectoryEvent(uri, entries),
		notify: (message) => alert(message)
	});

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
			<!-- 虫眼鏡はモックの i-search(要件#56 契約 5)。追補c-3 の 20px 角のまま。 -->
			<Icon name="search" size={20} />
		</button>
		<button
			class="up-button"
			onclick={goUp}
			disabled={!parent}
			title="Go to Parent Folder"
			aria-label="Go to Parent Folder"
		>
			<Icon name="arrow-u" size={18} />
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
	アイテムのメニューも空白部のメニュー(要件#34)も文書の本文のメニュー(要件#80)もこの1つが描く。
-->
<ContextMenu
	{onDuplicateWindow}
	{onOpenInNewWindow}
	onOpenInNewTab={openInNewTab}
	{onReloadFile}
	onReloadFolder={(uri) => void folderReloader.reload(uri)}
/>

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
		background-color: var(--color-bg-base);
		overflow: hidden;
	}

	/*
	 * 区画の見出し行(モックの `.sh`=大文字・小さく・薄く。要件#56 判断 (q))。高さは
	 * モックのペインの見出しと同じ 34px にそろえ、右端に 28px 角のボタンを並べる。
	 */
	.explorer-header {
		box-sizing: border-box;
		min-height: 34px;
		padding: 3px 6px 3px 14px;
		/* 要件#64 追補b: 文字は下の区画の見出しと同じトークン(theme.css)。 */
		font-size: var(--pane-header-font-size);
		font-weight: var(--pane-header-font-weight);
		text-transform: uppercase;
		letter-spacing: var(--pane-header-letter-spacing);
		color: var(--color-text-muted);
		border-bottom: 1px solid var(--color-border);
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 2px;
	}

	/* 要件#55 追補c: ボタンが 2 つになったので、見出しを左に寄せ、↑ と検索を右に並べる。 */
	.explorer-title {
		margin-right: auto;
	}

	.up-button {
		background: transparent;
		border: 1px solid transparent;
		border-radius: 6px;
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
		color: var(--color-text-primary);
	}

	.up-button:disabled {
		cursor: default;
		opacity: 0.3;
	}

	/* 行の角丸の選択色を区画の縁から離す(モックの `.tree`= 左右 6px)。 */
	.explorer-list {
		flex: 1;
		overflow-y: auto;
		padding: 4px 6px;
	}
</style>
