<script lang="ts">
	import { tick } from 'svelte';
	import { invoke } from '$lib/ipc';
	import { openUrl } from '@tauri-apps/plugin-opener';
	import { isExternal } from '$lib/uri';
	import { sha256 } from '$lib/annotation';
	import { mountMermaid } from '$lib/mermaid-mounter';
	import { planSelectionCopy } from '$lib/copy-selection';
	import { bufferFromPre } from '$lib/document-edit';
	import { saveDocument } from '$lib/save-document';
	import { confirmDiscardEdits } from '$lib/edit-guard';
	import { DEFAULT_ZOOM } from '$lib/zoom';
	import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
	import type { SourceIndex } from '../markdown/types';
	import { buildAnchor, type BuiltAnchor } from '../markdown/selection';

	let {
		document,
		html,
		index,
		onRequestAddMark,
		onToggleMarks,
		marksOpen,
		zoom = DEFAULT_ZOOM,
	}: {
		document: DocumentPayload;
		html: string;
		index: SourceIndex | null;
		onRequestAddMark: (anchor: BuiltAnchor) => void;
		onToggleMarks: () => void;
		marksOpen: boolean;
		/**
		 * 本文の表示倍率(パーセント・要件#36)。非対象の表示(バイナリの
		 * プレースホルダ)には既定=等倍が渡る。
		 */
		zoom?: number;
	} = $props();

	let copyLabel = $state('マークダウンをコピー');
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	let bodyEl: HTMLDivElement | undefined = $state();

	// --- その場編集(要件#48) ------------------------------------------
	// 編集に入れるか・dirty か・届いた外部変更をどう扱うかは `WindowState` と
	// `$lib/document-edit` の持ち場。ここは DOM の配線だけを持つ。

	/** 編集中か。モードを持つのはウインドウ状態なので、ここは映すだけ。 */
	let editing = $derived(windowState.editMode === 'edit');

	/** 編集中の `<pre contenteditable>`。 */
	let editorEl: HTMLPreElement | undefined = $state();

	/**
	 * 編集中に `<pre>` へ流し込む原文。text 種別はレンダリング結果がそのまま原文
	 * だが、markdown / html は違う — 編集するのは**ソース**なので `document.content`
	 * を出す(契約②のソース編集モード)。バッファがあればそちらが正(保存前の
	 * 編集内容を持っているのはバッファの側)。
	 */
	let editSource = $derived(windowState.editBuffer ?? document.content);

	/**
	 * `<pre>` の中身は Svelte のテキスト補間ではなく、ここで直接入れる。
	 *
	 * `{@html}` も `{expr}` も、依存が動くたびにテキストノードを作り直す =
	 * 編集中のキャレットと IME の変換中候補が飛ぶ。そこで「原文と DOM が食い違う
	 * ときだけ書く」形にしてある: 利用者の入力で動いたときは `oninput` が
	 * バッファを DOM と同じ値へ揃えるのでここは何もせず、外部変更に追従した
	 * (契約⑥ の `apply`)ときだけ書き戻しが走る。
	 */
	$effect(() => {
		const el = editorEl;
		const source = editSource;
		if (!el || el.textContent === source) return;
		el.textContent = source;
	});

	/** 編集へ入った直後だけキャレットを本文へ置く(書き戻しのたびに奪わない)。 */
	let focusedEditor: HTMLElement | null = null;
	$effect(() => {
		const el = editorEl;
		if (!el) {
			focusedEditor = null;
			return;
		}
		if (focusedEditor === el) return;
		focusedEditor = el;
		el.focus();
	});

	/**
	 * 編集開始は明示操作だけ(契約③)。ダブルクリックがその1つで、単クリックや
	 * キー入力では入らない — 閲覧中の誤タッチで dirty にならないため。
	 * 編集に入れない文書(画像・SSH root 等)では `beginEdit` が false を返して
	 * 何も起きない。
	 */
	function handleDoubleClick() {
		if (editing) return;
		windowState.beginEdit();
	}

	function handleEditInput(e: Event) {
		windowState.updateBuffer(bufferFromPre(e.currentTarget as HTMLElement));
	}

	/**
	 * Esc で閲覧へ戻る(契約③)。編集中の文字入力は素通しする。
	 *
	 * 追補c: 閲覧へ戻る=編集バッファを捨てる操作なので、⌘E トグルと同じ関門を
	 * 通す。`confirmDiscardEdits` は非 dirty なら何も聞かずに畳み、dirty なら
	 * 保存 / 破棄 / キャンセルを聞いて、保存なら成功後・破棄なら即・キャンセル
	 * なら何もせず編集中のまま — こちらで戻り値を見て分岐するものは無い。
	 */
	function handleEditKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		e.preventDefault();
		void confirmDiscardEdits();
	}

	/** ツールバーの「編集を終える」(契約③)。出口は Esc と同じ関門を通る。 */
	function handleEditDone() {
		void confirmDiscardEdits();
	}

	/** 衝突表示の「上書き保存」(契約⑥)。編集中の内容で外部版を上書きする。 */
	async function overwriteExternal() {
		try {
			await saveDocument(document.uri, windowState.editBuffer ?? document.content);
		} catch (err) {
			alert(`保存に失敗しました: ${err}`);
		}
	}

	// After every html prop change, look for `.vellis-mermaid` placeholders
	// in the rendered body and have the mounter replace them with SVG.
	// Mermaid is dynamic-imported on first need; documents without mermaid
	// blocks never trigger the import (`docs/mermaid.md` §6.3 / §9.4 #3).
	$effect(() => {
		// Re-run whenever the html prop changes.
		void html;
		tick().then(() => {
			if (bodyEl) void mountMermaid(bodyEl);
		});
	});

	async function copyAllAsMarkdown() {
		await navigator.clipboard.writeText(document.content);
		copyLabel = 'コピーしました';
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => {
			copyLabel = 'マークダウンをコピー';
		}, 1000);
	}

	async function addInstructionFromSelection() {
		if (!index) {
			alert('レンダリング中です。少し待ってから再度お試しください。');
			return;
		}
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed) {
			alert('本文の範囲を選択してから「指示を追加」を押してください。');
			return;
		}
		const fileHash = await sha256(document.content);
		const anchor = buildAnchor(sel, index, document.content, fileHash);
		if (!anchor) {
			alert('選択範囲を解決できません。レンダー範囲内で選択してください。');
			return;
		}
		onRequestAddMark(anchor);
	}

	function handleCopy(e: ClipboardEvent) {
		// Requirement #32: copy exactly the visible text of the selection.
		// The Markdown-source resolution that used to run here (requirement
		// #13 / copy-original-markdown.md §B-3) is gone from the copy path —
		// it widened partial selections to whole blocks and reintroduced
		// notation markers (backlog #20-#22, #27, #71).  `index` is not
		// consulted at all any more; it stays for mark creation (buildAnchor).
		const sel = window.getSelection();
		if (!sel) return;
		const text = planSelectionCopy(sel);
		if (text === null) return; // browser default (collapsed selection etc.)
		e.preventDefault();
		e.clipboardData?.setData('text/plain', text);
	}

	async function handleClick(e: MouseEvent) {
		// 編集中はリンク航行を止める(要件#48 契約②)。ソース編集の `<pre>` に
		// リンクは無いが、preventDefault が残っているとキャレットの置き直しを
		// 邪魔しうるので、経路そのものを通さない。
		if (editing) return;
		const target = (e.target as HTMLElement).closest('a');
		if (!target) return;
		const href = target.getAttribute('href');
		if (!href) return;

		// External links (http/https/mailto/tel) are delegated to the OS.
		if (isExternal(href)) {
			e.preventDefault();
			openUrl(href);
			return;
		}

		// Internal links (data-vellis-link): .md files navigate within Viewer.
		if (target.hasAttribute('data-vellis-link')) {
			e.preventDefault();
			if (/\.(md|markdown|mdx)$/i.test(href)) {
				if (e.shiftKey) {
					await invoke('new_window', { path: href, root: windowState.root });
				} else {
					const doc = await invoke<DocumentPayload>('open_document', { uri: href });
					windowState.setDocument(doc);
				}
			}
			// Non-md files (PDF, etc.) are noop in Phase 1.
		}
	}
</script>

<article class="viewer">
	<header class="viewer-toolbar">
		<button
			type="button"
			class="toolbar-button"
			title="文書全体のマークダウン原文をクリップボードにコピー"
			onclick={copyAllAsMarkdown}
		>
			{copyLabel}
		</button>
		<button
			type="button"
			class="toolbar-button"
			title="選択範囲に AI 指示を追加 (ai-collab)"
			onclick={addInstructionFromSelection}
		>
			指示を追加
		</button>
		<button
			type="button"
			class="toolbar-button"
			class:active={marksOpen}
			title="マーク一覧サイドバーを開閉"
			onclick={onToggleMarks}
			aria-pressed={marksOpen}
		>
			マーク一覧
		</button>
		{#if editing}
			<!--
				要件#48 契約③: 閲覧へ戻る明示操作。Esc と対になるもう1つの出口で、
				キーボードを知らなくても抜けられるようにツールバーへ出す。
			-->
			<button
				type="button"
				class="toolbar-button"
				data-testid="edit-done"
				title="編集を終えて閲覧へ戻る (Esc)"
				onclick={handleEditDone}
			>
				編集を終える
			</button>
		{/if}
	</header>
	{#if windowState.externalChange !== null}
		<!--
			要件#48 契約⑥: 編集中に届いた外部変更。再レンダーはせず(編集中の内容を
			勝手に捨てない)、どちらを残すかを利用者に選ばせる。
		-->
		<div class="external-change" data-testid="external-change-banner" role="alert">
			<span class="external-change-text">
				このファイルは外部で変更されました。編集中の内容と食い違っています。
			</span>
			<button
				type="button"
				class="toolbar-button"
				data-testid="external-overwrite"
				title="編集中の内容で外部の変更を上書きする"
				onclick={overwriteExternal}
			>
				上書き保存
			</button>
			<button
				type="button"
				class="toolbar-button"
				data-testid="external-reload"
				title="外部の変更を読み直す (編集中の内容は破棄)"
				onclick={() => windowState.acceptExternalChange()}
			>
				読み直す
			</button>
		</div>
	{/if}
	<!--
		要件#36: ズームは本文コンテナだけに掛ける。`zoom` は `transform: scale` と
		違ってレイアウトごと拡大するので、本文中の画像・表・コードブロック・
		mermaid 図が一体で拡縮しつつ、行はウインドウ幅で折り返し直される
		(要件#20 の「幅はウインドウに追従」がそのまま生きる)。ツールバーは
		外にあるので UI の大きさは変わらない。等倍のときは宣言そのものを出さない
		— ズームを入れる前と同じ DOM に戻す(srcdoc 側の `zoomStyleTag` と同じ)。

		要件#48 契約③: ダブルクリックが編集開始の明示操作。単クリック(リンク航行)
		とコピーは従来どおりで、キー入力では入らない。
	-->
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div
		class="markdown-body"
		style:zoom={zoom === DEFAULT_ZOOM ? null : `${zoom}%`}
		bind:this={bodyEl}
		onclick={handleClick}
		ondblclick={handleDoubleClick}
		oncopy={handleCopy}
	>
		{#if editing}
			<!--
				要件#48 契約②: 編集中はレンダリング結果を出さない。text 種別は
				`renderPlainText` と同じ `<pre class="vellis-plaintext">` を自前で置き、
				markdown / html は同じ `<pre>` に**ソース**を出す(ソース編集モード)。
				中身を入れるのは上の $effect — 補間で書くと再描画のたびにキャレットが
				飛ぶため、Svelte にはこのノードの中を触らせない。
			-->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<pre
				class="vellis-plaintext"
				contenteditable="true"
				spellcheck="false"
				bind:this={editorEl}
				oninput={handleEditInput}
				onkeydown={handleEditKeydown}></pre>
		{:else}
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			{@html html}
		{/if}
	</div>
</article>

<style>
	.viewer {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow-y: auto;
		min-width: 0;
		background-color: #ffffff;
	}

	.viewer-toolbar {
		position: sticky;
		top: 0;
		z-index: 10;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 12px;
		background-color: #ffffff;
		border-bottom: 1px solid #e5e7eb;
	}

	.toolbar-button {
		font-size: 12px;
		padding: 4px 10px;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		background-color: #f9fafb;
		color: #374151;
		cursor: pointer;
	}

	.toolbar-button:hover {
		background-color: #f3f4f6;
	}

	.toolbar-button.active {
		background-color: #dbeafe;
		border-color: #93c5fd;
		color: #1e40af;
	}

	/*
	 * 要件#48 契約⑥: 外部変更の衝突表示。ツールバーの直下に敷く1行で、本文の
	 * 上に重ねない — 編集中の文字を隠さないため。sticky はツールバー側だけに
	 * 掛かっているので、この帯は本文と一緒にスクロールして退く。
	 */
	.external-change {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 12px;
		background-color: #fef3c7;
		border-bottom: 1px solid #fcd34d;
		font-size: 12px;
		color: #78350f;
	}

	.external-change-text {
		flex: 1;
		min-width: 0;
	}

	/*
	 * 要件#48 契約②: 編集中の `<pre>`。見た目は閲覧中のプレーンテキスト
	 * (styles/markdown.css の .vellis-plaintext)のままにして、編集に入った
	 * 瞬間に本文が動かないようにする。ここで足すのは編集中であることの手掛かり
	 * (キャレットの帯)だけ。
	 */
	.vellis-plaintext[contenteditable='true'] {
		outline: none;
		box-shadow: inset 3px 0 0 #93c5fd;
	}
</style>
