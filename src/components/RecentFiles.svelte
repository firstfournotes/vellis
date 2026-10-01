<script lang="ts">
	/**
	 * Recent Files の区画(要件#64 契約6〜10)。左ペインで Explorer の下端に積む、
	 * 折りたためる区画(VS Code の Outline / Timeline と同じ形)。
	 *
	 * - 見出し行=開閉の目印・見出し・Clear。見出し行のクリック(3px 未満の移動)で開閉し、
	 *   開いているときの上下ドラッグ(3px 以上)で高さを変える。閉じているときのドラッグは
	 *   何もしない。Clear の上の押し・クリックは開閉にもドラッグにも使わない
	 * - 開いているときは、ツリーとの境目(上端の枠線)にドラッグ専用のつかみ所を置く
	 *   (追補c)。載せるとリサイズのカーソルになり、見出し行と同じ処理で高さを変える
	 * - 開閉と高さの規則と保存は `$lib/recent-files-section`(ここは localStorage に触れない)。
	 *   高さは離した時点で保存する
	 * - 一覧は Rust の `list_recent_files`(今の root 配下・新しい順・最大 10 件)。読むのは
	 *   開いた状態で描かれたとき・開いたとき・開いている間に root / 今の文書が変わったとき・
	 *   開くのに失敗したとき・Clear の後。閉じている間は読まない
	 * - 行のクリック=この窓で開く(未保存確認 → `openForDisplay` → `setDocument` →
	 *   `onOpened`)。Command + クリック=新しいタブ・Shift + クリック=新しい窓(ツリーと
	 *   同じ線引き・未保存確認なし)。区画は開いたまま
	 * - 要件#63: 区画は Explorer の領域(`data-zoom-region="explorer"`)に属し、一覧にだけ
	 *   ツリーと同じ倍率を当てる(見出し行には当てない)
	 * - 文言は英語(要件#51)
	 */
	import { tick, untrack } from 'svelte';
	import { invoke } from '$lib/ipc';
	import { confirmDiscardEdits } from '$lib/edit-guard';
	import { newTabFailedMessage, openNewTab, planNewTab } from '$lib/new-tab';
	import { openInNewWindowFailedMessage } from '$lib/open-in-new-window';
	import { openForDisplay } from '$lib/open-document';
	import { DEFAULT_ZOOM } from '$lib/zoom';
	import {
		RECENT_FILES_CLEAR_LABEL,
		RECENT_FILES_EMPTY_MESSAGE,
		RECENT_FILES_TITLE,
		clearRecentFiles,
		loadRecentFiles,
		recentFileLabel,
		recentFileOpenFailedMessage
	} from '$lib/recent-files';
	import {
		clampSectionHeight,
		dragSectionHeight,
		isSectionDrag,
		loadSectionExpanded,
		loadSectionHeight,
		saveSectionExpanded,
		saveSectionHeight
	} from '$lib/recent-files-section';
	import { windowState, type DocumentPayload } from '../stores/window-state.svelte';

	let {
		rootUri,
		currentUri,
		paneHeight,
		explorerZoom = DEFAULT_ZOOM,
		onOpened
	}: {
		/** 今の窓の root(末尾 `/` 無し)。一覧はこの配下だけ。 */
		rootUri: string;
		/** 今開いている文書の URI(選択色と、開いている間の読み直しの合図)。 */
		currentUri: string | null;
		/** 左ペインの高さ(px)。区画の高さの上限 = これ − ツリーの最低 100px。 */
		paneHeight: number;
		/** ツリーの倍率(%・要件#63)。一覧にだけ CSS `zoom` で当てる。 */
		explorerZoom?: number;
		/** この窓で文書を開いた**後**に呼ぶ(ページがツリーのその行を見せる)。 */
		onOpened: (uri: string) => void;
	} = $props();

	let expanded = $state(loadSectionExpanded());

	/**
	 * 使いたい高さ(下限だけ当てた保存値・ドラッグの結果)。表示する高さはこれを今の
	 * 左ペインの高さで収めたもの —— 窓が低くなって上限を割れば詰め、戻れば元に戻る
	 * (保存値はユーザーが選んだ高さで、窓の都合では書き換えない)。左ペインの高さは
	 * マウント直後にはまだ測れていないことがあるので、ここでは上限を当てずに読む。
	 */
	let preferredHeight = $state(loadSectionHeight(Number.POSITIVE_INFINITY));
	let height = $derived(clampSectionHeight(preferredHeight, paneHeight));

	/** Rust から読んだ一覧(新しい順・最大 10 件)。 */
	let items = $state.raw<string[]>([]);
	/** 一度でも読み終えたか。読み終える前に「No recent files」をちらつかせない。 */
	let loaded = $state(false);

	/** 読み直しの合図(Clear の後・開くのに失敗した後・Go メニュー)。 */
	let reloadNonce = $state(0);

	/**
	 * 読み直しの合図に使う値。派生にしておくと、同じ文書の中身の差し替え(外部変更の
	 * 反映)のように URI が変わらない更新では読み直さない。
	 */
	let watchedRoot = $derived(rootUri);
	let watchedCurrent = $derived(currentUri);

	/** 最後に出した読み込みの札。古い応答(root の切り替え中など)は捨てる。 */
	let loadToken = 0;
	/** 最後に出した読み込み(Go メニューが読み終わりを待ってからフォーカスするため)。 */
	let pendingLoad: Promise<void> = Promise.resolve();

	/** `items` がどの root の一覧か。root が変わったら、読み終えるまで前の root の行を出さない。 */
	let itemsRoot: string | null = null;

	function reload(): Promise<void> {
		const token = ++loadToken;
		const root = rootUri;
		if (itemsRoot !== root) {
			items = [];
			loaded = false;
		}
		pendingLoad = loadRecentFiles(root).then((uris) => {
			if (token !== loadToken) return;
			items = uris;
			itemsRoot = root;
			loaded = true;
		});
		return pendingLoad;
	}

	// 開いている間だけ読む(閉じている間は開いたときにまとめて読む=契約10)。
	$effect(() => {
		if (!expanded) return;
		void watchedRoot;
		void watchedCurrent;
		void reloadNonce;
		untrack(() => void reload());
	});

	let sectionEl: HTMLElement | undefined = $state();
	let clearEl: HTMLButtonElement | undefined = $state();

	function setExpanded(next: boolean) {
		expanded = next;
		saveSectionExpanded(next);
	}

	/**
	 * Go メニュー「Recent Files」(Command + Shift + R)の受け口(契約5)。区画を開き
	 * (開閉の記憶も「開」に)、一覧を読み直し、先頭の行へフォーカスを移す。0 件なら
	 * 開くだけでフォーカスは移さない。
	 */
	export async function reveal(): Promise<void> {
		if (expanded) {
			saveSectionExpanded(true);
			reloadNonce += 1;
		} else {
			setExpanded(true);
		}
		// 読み直しは開閉の effect が出す。出たのを待ってから、読み終わりを待つ。
		await tick();
		await pendingLoad;
		await tick();
		sectionEl?.querySelector<HTMLButtonElement>('.recent-files-row')?.focus();
	}

	// --- 見出し行とつかみ所: 上下ドラッグで高さ(契約6・追補c) ------------------------
	//
	// 押す → 動かす → 離すの処理は見出し行とつかみ所(区画の上端の境目)で共有する。
	// 違いは、見出し行は 3px 未満で離すとクリック(開閉)になることだけ。つかみ所は
	// ドラッグ専用で、見出し行の外に置くので click も pointer も見出し行の開閉に届かない。

	/** 押している間の記録。null = 押していない。 */
	let press: { startY: number; startHeight: number; moved: boolean; pointerId: number } | null =
		null;
	/** ドラッグで高さを変えている最中か(見た目のため)。 */
	let dragging = $state(false);
	/** 直前の押しがドラッグだった=続いて届く click を開閉に使わない。 */
	let suppressClick = false;

	function isOnClear(target: EventTarget | null): boolean {
		return !!clearEl && target instanceof Node && clearEl.contains(target);
	}

	/** 押し始め(見出し行・つかみ所で共通)。 */
	function beginPress(event: PointerEvent) {
		press = { startY: event.clientY, startHeight: height, moved: false, pointerId: event.pointerId };
		// ポインタを捕まえて、押した要素の外へ速く振ってもドラッグが続くようにする(要件#9 の仕切りと同じ)。
		(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
		event.preventDefault(); // ドラッグ中のテキスト選択を抑止
	}

	/** 動かす(見出し行・つかみ所で共通)。3px 以上動いてから高さを追わせる。 */
	function handlePressMove(event: PointerEvent) {
		if (!press) return;
		if (!press.moved && !isSectionDrag(press.startY, event.clientY)) return;
		press.moved = true;
		// 閉じているときのドラッグは何もしない(開閉もしない=クリックとは扱わない)。
		if (!expanded) return;
		dragging = true;
		preferredHeight = dragSectionHeight(press.startHeight, press.startY, event.clientY, paneHeight);
	}

	/**
	 * 離す・取り消す(見出し行・つかみ所で共通)。押していなければ null、押していれば
	 * ドラッグだったか(3px 以上動いたか)を返す。
	 */
	function endPress(event: PointerEvent): boolean | null {
		if (!press) return null;
		const current = press;
		press = null;
		const el = event.currentTarget as HTMLElement;
		if (el.hasPointerCapture?.(current.pointerId)) el.releasePointerCapture(current.pointerId);
		if (dragging) {
			dragging = false;
			// 保存は離した時点だけ(移動中に毎回書かない=要件#9 の幅と同じ)。
			saveSectionHeight(preferredHeight);
		}
		return current.moved || isSectionDrag(current.startY, event.clientY);
	}

	function handleHeaderPointerDown(event: PointerEvent) {
		suppressClick = false;
		// Clear の上で押したときは捕まえない(捕まえると Clear の click が見出し行へ回りうる)。
		if (event.button !== 0 || isOnClear(event.target)) return;
		beginPress(event);
	}

	function handleHeaderPointerUp(event: PointerEvent) {
		const moved = endPress(event);
		// ドラッグの後に届く click は開閉に使わない。
		if (moved !== null) suppressClick = moved;
	}

	function handleHeaderPointerCancel(event: PointerEvent) {
		if (!press) return;
		handleHeaderPointerUp(event);
	}

	function handleSashPointerDown(event: PointerEvent) {
		if (event.button !== 0) return;
		beginPress(event);
	}

	/** つかみ所はドラッグ専用: 離したときに動きが 3px 未満でも何もしない(開閉しない)。 */
	function handleSashPointerUp(event: PointerEvent) {
		endPress(event);
	}

	function handleHeaderClick(event: MouseEvent) {
		if (suppressClick) {
			suppressClick = false;
			return;
		}
		// Clear のクリックは見出し行へ伝わってくるが、開閉には使わない。
		if (isOnClear(event.target)) return;
		setExpanded(!expanded);
	}

	function handleHeaderKeyDown(event: KeyboardEvent) {
		// Clear の上のキーは Clear のもの(ボタンが自分で click を出す)。
		if (event.target !== event.currentTarget) return;
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		setExpanded(!expanded);
	}

	// --- Clear(契約9) ------------------------------------------------------------------

	async function handleClear() {
		try {
			await clearRecentFiles(rootUri);
		} catch (err) {
			console.warn('clear_recent_files failed:', err);
		}
		items = [];
		reloadNonce += 1;
	}

	// --- 行のクリック(契約7・8) --------------------------------------------------------

	async function openRow(event: MouseEvent, uri: string) {
		// Command + クリック(Shift なし)=新しいタブ(要件#62 契約3)。今のタブは動かないので
		// 未保存確認は挟まない。
		if (event.metaKey && !event.shiftKey) {
			const plan = planNewTab({ rootUri, docUri: uri, expandedDirs: windowState.expandedDirs });
			if (plan === null) return;
			try {
				await openNewTab(plan);
			} catch (err) {
				alert(newTabFailedMessage(err));
			}
			return;
		}
		// Shift + クリック=新しい窓(ツリーと同じ `new_window { path, root }`)。
		if (event.shiftKey) {
			try {
				await invoke('new_window', { path: uri, root: rootUri });
			} catch (err) {
				alert(openInNewWindowFailedMessage(err));
			}
			return;
		}
		// 要件#48 契約④: この窓で別のファイルを開くと編集は消える。先に始末を聞く。
		if (!(await confirmDiscardEdits())) return;
		let opened: DocumentPayload;
		try {
			opened = await openForDisplay(uri);
		} catch (err) {
			// 「見つからない」なら Rust が記録から除いている(契約8)。読み直して消えた行を落とす。
			alert(recentFileOpenFailedMessage(err));
			reloadNonce += 1;
			return;
		}
		windowState.setDocument(opened);
		onOpened(uri);
	}
</script>

<!-- data-zoom-region=要件#63 契約3の領域の目印(区画はツリーと同じ Explorer の領域)。 -->
<section
	class="recent-files"
	class:dragging
	data-testid="recent-files"
	data-zoom-region="explorer"
	aria-label={RECENT_FILES_TITLE}
	style:height={expanded ? `${height}px` : null}
	bind:this={sectionEl}
>
	{#if expanded}
		<!--
			追補c: ツリーと区画の境目(区画の上端の枠線)のつかみ所。枠線をまたぐ帯で、ポインタを
			載せるとリサイズのカーソルになる。ドラッグ専用で、見出し行の外(区画の子)に置くので
			押しもクリックも見出し行の開閉に届かない。閉じているときは出さない。
		-->
		<div
			class="recent-files-sash"
			data-testid="recent-files-sash"
			role="separator"
			aria-orientation="horizontal"
			aria-label="Resize Recent Files"
			onpointerdown={handleSashPointerDown}
			onpointermove={handlePressMove}
			onpointerup={handleSashPointerUp}
			onpointercancel={handleSashPointerUp}
		></div>
	{/if}
	<!--
		見出し行は開閉のボタンとして振る舞う。中に Clear の <button> を持つので <button> には
		できない(ボタンの入れ子)。キーボードでも Enter / Space で開閉できる。
	-->
	<div
		class="recent-files-header"
		data-testid="recent-files-header"
		role="button"
		tabindex="0"
		aria-expanded={expanded}
		onpointerdown={handleHeaderPointerDown}
		onpointermove={handlePressMove}
		onpointerup={handleHeaderPointerUp}
		onpointercancel={handleHeaderPointerCancel}
		onclick={handleHeaderClick}
		onkeydown={handleHeaderKeyDown}
	>
		<span class="recent-files-marker" data-testid="recent-files-marker" aria-hidden="true"
			>{expanded ? '⌄' : '›'}</span
		>
		<span class="recent-files-title" data-testid="recent-files-title">{RECENT_FILES_TITLE}</span>
		<button
			class="recent-files-clear"
			data-testid="recent-files-clear"
			bind:this={clearEl}
			onclick={() => void handleClear()}
		>
			{RECENT_FILES_CLEAR_LABEL}
		</button>
	</div>
	{#if expanded}
		<!-- 等倍では宣言を出さない(Explorer の nav.explorer-list と同じ流儀)。 -->
		<div
			class="recent-files-list"
			data-testid="recent-files-list"
			style:zoom={explorerZoom === DEFAULT_ZOOM ? null : `${explorerZoom}%`}
		>
			{#each items as uri (uri)}
				{@const label = recentFileLabel(uri, rootUri)}
				<button
					class="recent-files-row"
					class:active={uri === currentUri}
					data-testid="recent-files-row"
					data-uri={uri}
					title={uri}
					aria-current={uri === currentUri ? 'true' : undefined}
					onclick={(event) => void openRow(event, uri)}
				>
					<span class="recent-files-row-name" data-testid="recent-files-row-name">{label.name}</span>
					<span class="recent-files-row-folder" data-testid="recent-files-row-folder"
						>{label.folder}</span
					>
				</button>
			{:else}
				{#if loaded}
					<div class="recent-files-empty" data-testid="recent-files-empty">
						{RECENT_FILES_EMPTY_MESSAGE}
					</div>
				{/if}
			{/each}
		</div>
	{/if}
</section>

<style>
	/*
	 * 区画の外形。開いているときの高さは inline の `height`(見出し行を含む)。閉じている
	 * ときは見出し行の 1 行だけ。見た目は Explorer の `aside.explorer` に揃える。
	 * 追補c: つかみ所(.recent-files-sash)を上端の枠線の上へはみ出させるため、区画は
	 * `overflow: hidden` を持たない(中身は見出し行の固定の高さと、一覧の `overflow-y: auto`
	 * で区画に収まる。左ペインの外へのはみ出しは `.explorer-pane` の `overflow: hidden` が切る)。
	 */
	.recent-files {
		position: relative; /* つかみ所の基準 */
		flex: 0 0 auto;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		min-height: 0;
		/* 1px は `$lib/recent-files-section` の SECTION_BORDER_TOP と同じ(高さの計算に入っている)。 */
		border-top: 1px solid var(--color-border);
		border-right: 1px solid var(--color-border);
		background-color: var(--color-bg-secondary);
	}

	/*
	 * 見出し行の文字は大文字・色を Explorer の `.explorer-header` に揃える。高さは
	 * `SECTION_HEADER_HEIGHT`(`$lib/recent-files-section`)と同じ 28px に固定する。
	 * 追補b(2026-09-30)で文字の大きさ・太さ・字間を Explorer の見出しと同じトークン
	 * (theme.css の `--pane-header-*`=13px・500・0.04em)にした(追補a の 16px・700 は撤回)。
	 */
	.recent-files-header {
		flex: 0 0 auto;
		box-sizing: border-box;
		height: 28px;
		padding: 0 8px 0 6px;
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: var(--pane-header-font-size);
		font-weight: var(--pane-header-font-weight);
		text-transform: uppercase;
		letter-spacing: var(--pane-header-letter-spacing);
		color: var(--color-text-secondary);
		cursor: pointer;
		user-select: none;
		touch-action: none; /* ドラッグがスクロールに取られないように */
	}

	.recent-files-header:focus-visible {
		outline: 2px solid #93c5fd;
		outline-offset: -2px;
	}

	/*
	 * 追補c: ツリーと区画の境目のつかみ所。上端の枠線(1px)の上 3px・下 3px をまたぐ帯で、
	 * 載せただけでリサイズのカーソルになる(ドラッグ中と同じ)。区画の上端の外へはみ出して
	 * ツリーの下端 3px に重なるので、ツリーより手前に描く。見出し行の上端 3px にも重なる。
	 */
	.recent-files-sash {
		position: absolute;
		top: -4px;
		left: 0;
		right: 0;
		height: 7px;
		z-index: 1;
		cursor: ns-resize;
		touch-action: none; /* ドラッグがスクロールに取られないように */
	}

	/*
	 * ドラッグ中は区画のどこにポインタがあってもリサイズのカーソル(見出し行・つかみ所の
	 * どちらから始めても。最小で止まった後に一覧の上へ下りても変わらない)。
	 */
	.recent-files.dragging,
	.recent-files.dragging * {
		cursor: ns-resize;
	}

	/*
	 * 開閉の目印 › / ⌄(大きさは見出し行の追補a に合わせて 24px・閉じたときは下の規則で 30px)。
	 * Apple Symbols(macOS 標準)は › と ⌄ の形が揃う。見出し行の字の太さは継がない。
	 */
	.recent-files-marker {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		font-family: 'Apple Symbols', 'STIX Two Math', sans-serif;
		font-size: 24px;
		font-weight: 400;
		line-height: 1;
		flex-shrink: 0;
	}

	/* › の字形は ⌄ より小さいので、閉じたときだけ大きくして塗りを見出しの大文字の高さに揃える。 */
	.recent-files-header[aria-expanded='false'] .recent-files-marker {
		font-size: 30px;
	}

	.recent-files-title {
		margin-right: auto;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.recent-files-clear {
		flex-shrink: 0;
		font-size: 11px;
		text-transform: none;
		letter-spacing: normal;
		font-weight: 400;
		padding: 1px 8px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background: transparent;
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.recent-files-clear:hover {
		background-color: var(--color-bg-hover);
	}

	/* 上下の余白の合計は `$lib/recent-files-section` の SECTION_LIST_PADDING(8px)と同じ。 */
	.recent-files-list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 4px 0;
	}

	/* 1 行の高さは `SECTION_ROW_HEIGHT`(24px)。ツリーの行と同じ見た目の選択色とホバー。 */
	.recent-files-row {
		display: flex;
		align-items: baseline;
		gap: 6px;
		box-sizing: border-box;
		width: 100%;
		height: 24px;
		padding: 4px 12px 4px 24px;
		border: none;
		background: none;
		color: inherit;
		font: inherit;
		font-size: 13px;
		line-height: 16px;
		text-align: left;
		cursor: pointer;
		white-space: nowrap;
		overflow: hidden;
	}

	.recent-files-row:hover {
		background-color: var(--color-bg-tree-hover);
	}

	.recent-files-row.active {
		background-color: var(--color-bg-tree-active);
	}

	.recent-files-row-name {
		flex-shrink: 0;
		max-width: 100%;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.recent-files-row-folder {
		min-width: 0;
		font-size: 12px;
		color: var(--color-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.recent-files-empty {
		padding: 4px 12px 4px 24px;
		font-size: 12px;
		font-style: italic;
		color: var(--color-text-muted);
	}
</style>
