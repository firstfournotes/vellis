<script lang="ts">
	/**
	 * raw(View ▸ Raw Source)の面(要件#74 契約23・第2段の作り(案)の項目 9)。Markdown の原文を CodeMirror 6 で直す。
	 *
	 * 第1段のコードの面と同じ部品を使う: 文書モデル `text-document.ts`(改行コード・BOM を byte のまま保つ)・
	 * キー割り当て `CODE_KEYMAP`・配色 `highlightStyleFor`。色付けは `@codemirror/language-data` の Markdown の文法
	 * (遅延読み込み)。raw に入るたびに新しい文書(=履歴は新しく始まる)。文書の持ち主は MarkdownEditor で、ここは
	 * 文字列の変化を `onChange` で返し、外からの差し替え(`replaceText`・`resetText`)を受ける。
	 */
	import { onMount, untrack } from 'svelte';
	import { handleEditorContextMenu } from '../editor/editor-context-menu-handler';
	import { Compartment, StateEffect, Transaction, type Extension } from '@codemirror/state';
	import { EditorView, keymap } from '@codemirror/view';
	import { LanguageDescription, bracketMatching } from '@codemirror/language';
	import { isolateHistory } from '@codemirror/commands';
	import { languages } from '@codemirror/language-data';

	import { DEFAULT_ZOOM } from '$lib/zoom';
	import { createTextDocument, replaceWith, sliceStateText } from '../editor/text-document';
	import { CODE_KEYMAP } from '../editor/code-keymap';
	import { findField } from '../editor/cm-find';
	import { copySelection, createCmFinder, createCompositionWatch, createHighlightLoader } from '../editor/cm-face';
	import type { MatchRange } from '$lib/find-in-document';

	let {
		uri,
		content,
		selection = { anchor: 0, head: 0 },
		readOnly = false,
		zoom = DEFAULT_ZOOM,
		codeTheme = 'github-light',
		findQuery = '',
		findCurrent = 0,
		onFindResults,
		onChange,
		onComposition,
	}: {
		uri: string;
		/** raw に入ったときの原文(契約6 の書き出し)。 */
		content: string;
		/** 原文の文字の位置の選択。 */
		selection?: { anchor: number; head: number };
		readOnly?: boolean;
		zoom?: number;
		codeTheme?: string;
		/** FindBar の語(閉じていれば空)。raw の検索は文書全体(第1段のコードの面と同じ=契約17)。 */
		findQuery?: string;
		/** 現在の一致の番目(Viewer が持つ)。 */
		findCurrent?: number;
		/** 数えた一致を Viewer へ返す(位置は CodeMirror の文書の位置)。 */
		onFindResults?: (result: { query: string; ranges: MatchRange[]; current?: number }) => void;
		/** 文字列が変わった(原文の綴りのまま)。 */
		onChange?: (text: string) => void;
		/**
		 * 変換中(IME)に入った(true)・終わった(false=compositionend か変換中の blur)。持ち主(MarkdownEditor)は変換中に届いた
		 * 外部変更を確定の後に 1 回だけ当てる(要件#74 契約10・Issue #840)。
		 */
		onComposition?: (composing: boolean) => void;
	} = $props();

	let host: HTMLDivElement | undefined = $state();
	let view: EditorView | null = null;
	const themeCompartment = new Compartment();
	const languageCompartment = new Compartment();

	// --- 検索と置換(運転は `src/editor/cm-face.ts`=第1段のコードの面と同じ) ----------

	// 変換中は語の変更と打鍵の後の数え直しを控え、確定の後に 1 回流す(第1段のコードの面と同じ=契約10・Issue #840)
	const composition = createCompositionWatch({
		onStart: () => onComposition?.(true),
		onEnd: () => {
			onComposition?.(false);
			setTimeout(() => {
				if (!composition.active) finder.flush();
			}, 0);
		},
	});

	const finder = createCmFinder({
		view: () => view,
		current: () => untrack(() => findCurrent),
		composing: () => composition.active,
		onResults: (result) => onFindResults?.(result),
	});
	const loadTheme = createHighlightLoader(() => view, themeCompartment);

	// 語が変わったら数え直して先頭の一致へ移る。
	$effect(() => {
		const query = findQuery;
		if (!view) return;
		untrack(() => finder.setQuery(query));
	});

	// 現在の一致が変わったら(Prev / Next)選択をそこへ移してスクロールする。
	$effect(() => {
		const current = findCurrent;
		untrack(() => finder.setCurrent(current));
	});

	/** 今の語の現在の一致を替える(替えた文字の終わり以降の最初の一致を現在に)。読み取り専用・一致なしなら false。 */
	export function replaceCurrent(replacement: string): boolean {
		return !readOnly && finder.replaceCurrent(replacement);
	}

	/** 今の語の全部を取引 1 つで替える。返り値は替えた数。 */
	export function replaceAll(replacement: string): number {
		return readOnly ? 0 : finder.replaceAll(replacement);
	}

	/** 原文の位置 → CodeMirror の位置(CRLF は CodeMirror の中では 1 文字)。 */
	function toCm(text: string, offset: number): number {
		let crlf = 0;
		for (let i = text.indexOf('\r\n'); i >= 0 && i + 1 < offset; i = text.indexOf('\r\n', i + 2)) crlf++;
		return Math.max(0, offset - crlf);
	}

	/** 今の原文。 */
	export function getText(): string {
		return view ? sliceStateText(view.state) : untrack(() => content);
	}

	/** 今の選択(原文の文字の位置)。 */
	export function getSelection(): { anchor: number; head: number } {
		if (!view) return { anchor: 0, head: 0 };
		const { anchor, head } = view.state.selection.main;
		return { anchor: sliceStateText(view.state, 0, anchor).length, head: sliceStateText(view.state, 0, head).length };
	}

	/** 外部変更・マージの結果を当てる(変わった範囲だけ・履歴に積まない)。 */
	export function replaceText(target: string): void {
		if (!view) return;
		view.dispatch({ ...replaceWith(view.state, target), annotations: Transaction.addToHistory.of(false) });
	}

	/** 要件#89 契約11: 文書を `target` にする取引 1 つ(マージの Apply。履歴に積む=Command + Z 1 回で戻る)。 */
	export function applyText(target: string): void {
		if (!view || target === sliceStateText(view.state)) return;
		view.dispatch({ ...replaceWith(view.state, target), annotations: isolateHistory.of('full'), userEvent: 'merge' });
	}

	/** 文書を作り直す(Reload File・Use the File on Disk=履歴 0)。 */
	export function resetText(next: string): void {
		if (!view) return;
		view.setState(stateFor(next, { anchor: 0, head: 0 }));
		void loadLanguage();
		void loadTheme(untrack(() => codeTheme));
		onChange?.(next);
		finder.recount();
	}

	function faceExtensions(): Extension {
		return [
			bracketMatching(),
			keymap.of(CODE_KEYMAP),
			EditorView.editable.of(!readOnly),
			EditorView.lineWrapping,
			EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
			themeCompartment.of([]),
			languageCompartment.of([]),
			findField,
			EditorView.updateListener.of((update) => {
				if (!update.docChanged) return;
				onChange?.(sliceStateText(update.state));
				finder.scheduleRecount();
			}),
			EditorView.domEventHandlers({
				copy: (event, v) => copySelection(event, v, false),
				cut: (event, v) => copySelection(event, v, true),
				// 要件#74 第2段 2-6: 文字の上の右クリックはネイティブのメニュー(Option + 右クリック・読み取り専用は既定のまま)
				contextmenu: (event) => handleEditorContextMenu(event, { surface: 'raw', uri, readOnly }),
				// 変換中の印(変換中の blur は確定として扱う=契約10)
				...composition.handlers,
			}),
		];
	}

	function stateFor(text: string, sel: { anchor: number; head: number }) {
		const doc = createTextDocument(text, { uri, readOnly });
		const length = doc.state.doc.length;
		const clamp = (p: number) => Math.max(0, Math.min(p, length));
		return doc.state.update({
			effects: StateEffect.appendConfig.of(faceExtensions()),
			selection: { anchor: clamp(toCm(text, sel.anchor)), head: clamp(toCm(text, sel.head)) },
		}).state;
	}

	async function loadLanguage() {
		const desc = LanguageDescription.matchLanguageName(languages, 'Markdown', false);
		if (!desc) return;
		try {
			const support = await desc.load();
			view?.dispatch({ effects: languageCompartment.reconfigure(support) });
		} catch (err) {
			console.warn('Could not load the Markdown grammar', err);
		}
	}

	$effect(() => {
		const name = codeTheme;
		if (!view) return;
		void loadTheme(name);
	});

	onMount(() => {
		view = new EditorView({ parent: host!, state: stateFor(untrack(() => content), untrack(() => selection)) });
		void loadLanguage();
		void loadTheme(untrack(() => codeTheme));
		const initialQuery = untrack(() => findQuery);
		if (initialQuery) finder.run(initialQuery, true);
		view.focus();
		return () => {
			finder.dispose();
			view?.destroy();
			view = null;
		};
	});
</script>

<div
	class="raw-source-editor"
	data-testid="raw-source-editor"
	data-vellis-lang="markdown"
	style:font-size={zoom === DEFAULT_ZOOM ? null : `${zoom}%`}
>
	<div class="raw-source-surface" bind:this={host}></div>
</div>

<style>
	/* 書体・文字の大きさ・行間は第1段のコードの面(と今の pre.vellis-plaintext)と同じ。幅の上限なし。 */
	.raw-source-surface {
		font-family: var(--font-mono);
		font-size: 90%;
		line-height: 1.5;
	}

	.raw-source-surface :global(.cm-editor) {
		background-color: transparent;
		color: var(--color-text-primary);
	}

	.raw-source-surface :global(.cm-editor.cm-focused) {
		outline: none;
	}

	.raw-source-surface :global(.cm-scroller) {
		font-family: inherit;
		line-height: inherit;
		overflow: visible;
	}

	.raw-source-surface :global(.cm-content) {
		padding: 0;
		caret-color: var(--color-text-primary);
	}

	.raw-source-surface :global(.cm-line) {
		padding: 0;
	}

	.raw-source-surface :global(.cm-selectionBackground),
	.raw-source-surface :global(.cm-focused .cm-selectionBackground) {
		background-color: var(--color-selection);
	}

	.raw-source-surface :global(.cm-cursor) {
		border-left-color: var(--color-text-primary);
	}

	.raw-source-surface :global(.cm-vellis-find) {
		background-color: var(--color-find-match);
	}

	.raw-source-surface :global(.cm-vellis-find-current) {
		background-color: var(--color-find-current);
		color: var(--color-find-current-text);
	}

	.raw-source-surface :global(.cm-matchingBracket) {
		background-color: var(--color-accent-soft);
		color: inherit;
	}
</style>
