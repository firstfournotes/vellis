<script lang="ts">
	/**
	 * コードのファイルと plain text の面(要件#74 契約5・契約19 の「第1段の作り」2〜16)。
	 *
	 * 開いた時点から CodeMirror 6 の `EditorView` が表示であり編集面になる(由谷 2026-10-10 (b))。
	 * 文書モデルは `src/editor/text-document.ts`(改行コード・BOM を byte のまま保つ)。窓の状態との
	 * つなぎ(保存・外部変更・未保存の確認・Reload File)は `windowState.fileEditor` に置く handle。
	 *
	 * - 色付け: 言語は `languageForFile`(要件69)→ `@codemirror/language-data` の文法を遅延読み込み。
	 *   配色は Shiki のテーマから作る(`highlightStyleFor`)。テーマが変われば Compartment を差し替える
	 *   (文書・選択・履歴を保つ)
	 * - 行番号はコードのファイルにだけ。括弧の対応の強調あり。補完・折り畳み・lint・括弧の自動補完なし
	 * - ズームは面の文字の大きさに掛ける(CSS の `zoom` / `transform` を使わない=契約17)
	 * - 検索は FindBar の語を文書全体に当て(`findMatches`)、一致を装飾で塗る
	 * - 印刷は刷る直前に今の文字列を今の描画(Shiki の `<pre>`)にしたものを置き、面を隠す
	 * - 変換中(IME)は外部変更の取り込みと検索の語の変更を待ち、確定後に 1 回だけ当てる
	 */
	import { flushSync, onMount, untrack } from 'svelte';
	import { handleEditorContextMenu } from '../editor/editor-context-menu-handler';
	import { Compartment, EditorState, StateEffect, Transaction, type Extension } from '@codemirror/state';
	import { EditorView, keymap, lineNumbers } from '@codemirror/view';
	import { bracketMatching } from '@codemirror/language';
	import { isolateHistory } from '@codemirror/commands';

	import { contentHash, type FileChangedDecision } from '$lib/document-edit';
	import { languageForFile } from '$lib/code-language';
	import type { MatchRange } from '$lib/find-in-document';
	import { findField } from '../editor/cm-find';
	import { copySelection, createCmFinder, createCompositionWatch, createHighlightLoader } from '../editor/cm-face';
	import { renderForDisplay, renderPlainText } from '$lib/file-type';
	import { DEFAULT_ZOOM } from '$lib/zoom';
	import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
	import {
		createTextDocument,
		replaceWith,
		sliceStateText,
		type TextDocument,
	} from '../editor/text-document';
	import { CODE_KEYMAP } from '../editor/code-keymap';
	import { languageSupportFor } from '../editor/code-languages';
	import {
		MERGED_NOTICE,
		planExternalChange,
		readDiskText,
		syncWindowDocument,
		withDiskVersion,
		type FileEditorHandle,
	} from '../editor/file-editor';

	let {
		uri,
		content,
		readOnly = false,
		codeTheme = 'github-light',
		zoom = DEFAULT_ZOOM,
		findQuery = '',
		findCurrent = 0,
		onFindResults,
	}: {
		uri: string;
		/** 開いたときの文字列(この面は uri ごとに作り直す。中身の差し替えは handle の reset)。 */
		content: string;
		/** SSH root の文書(`canEnterEdit` が偽)。同じ面を editable=false で出す。 */
		readOnly?: boolean;
		/** Shiki の同梱テーマの名前(今のモードのもの)。 */
		codeTheme?: string;
		/** 表示倍率(パーセント)。 */
		zoom?: number;
		/** FindBar の語(閉じていれば空)。 */
		findQuery?: string;
		/** 現在の一致の番目(Viewer が持つ)。 */
		findCurrent?: number;
		/** 数えた一致を Viewer へ返す(位置は CodeMirror の文書の位置)。 */
		onFindResults?: (result: { query: string; ranges: MatchRange[]; current?: number }) => void;
	} = $props();

	/** 言語(コードのファイルだけ)。`data-vellis-lang` と行番号の有無を決める。 */
	const lang = untrack(() => languageForFile(uri));

	let host: HTMLDivElement | undefined = $state();
	let view: EditorView | null = null;

	/** 文書モデル(base と改行・字下げの検出)。state は view が持つ。 */
	let model: TextDocument;
	/** 今の documentText(取引のたびに作る)。 */
	let currentText = untrack(() => content);
	/** 自己書き込みのハッシュ(保存のエコー抑止)。 */
	let selfHash: string | null = null;

	let dirty = $state(false);
	let conflict = $state(false);
	let notice = $state<string | null>(null);
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;
	/** 重なった外部変更の中身(Use the File on Disk / Keep My Edits で使う)。保存の照合の衝突では null。 */
	let theirs: string | null = null;

	/** 変換中(contentDOM の compositionstart〜compositionend を自前で数える)。終わったら控えた分を 1 回流す。 */
	const composition = createCompositionWatch({ onEnd: () => setTimeout(flushPending, 0) });
	let pendingFile: DocumentPayload | null = null;

	/** 刷る直前の描画(beforeprint〜afterprint の間だけ)。 */
	let printHtml = $state<string | null>(null);
	/** 印刷の準備で作った今の描画(その文字列のときだけ使う)。 */
	let preparedPrint: { text: string; html: string } | null = null;

	const themeCompartment = new Compartment();
	const languageCompartment = new Compartment();

	// --- 検索と置換(運転は `src/editor/cm-face.ts`=raw の面と共有) ----------------

	const finder = createCmFinder({
		view: () => view,
		current: () => untrack(() => findCurrent),
		composing: () => composition.active,
		onResults: (result) => onFindResults?.(result),
	});
	const loadTheme = createHighlightLoader(() => view, themeCompartment);

	// 語が変わったら数え直して、先頭の一致へ移る(変換中は確定まで待つ)。
	$effect(() => {
		const query = findQuery;
		if (!view) return;
		untrack(() => finder.setQuery(query));
	});

	// 現在の一致が変わったら(Prev / Next・番目合わせ)選択をそこへ移す。
	$effect(() => {
		const current = findCurrent;
		untrack(() => finder.setCurrent(current));
	});

	// --- 文書モデルと窓のつなぎ --------------------------------------------

	function showNotice(text: string) {
		notice = text;
		if (noticeTimer) clearTimeout(noticeTimer);
		noticeTimer = setTimeout(() => {
			notice = null;
		}, 4000);
	}

	function setBase(next: string) {
		model = { ...model, base: next, baseHash: contentHash(next) };
		dirty = currentText !== model.base;
		version++;
	}

	/** 第4段 4-1: 文字列か基準の版が変わるたびに進む(handle.version=開いている差分の画面が追う)。 */
	let version = $state(0);

	/** 今の文書を `target` にする(外部変更・マージの取り込み)。履歴に積まない。 */
	function replaceText(target: string) {
		if (!view || target === currentText) return;
		view.dispatch({
			...replaceWith(view.state, target),
			annotations: Transaction.addToHistory.of(false),
		});
	}

	function applyNow(payload: DocumentPayload): FileChangedDecision {
		// Issue #848: 自分のエコーでない外部変更を取り込んだ(当てた・マージした・帯にした)ら、自分の保存のハッシュは
		// 忘れる。残すと、外部が自分の以前の保存と同じ中身に戻した書き込みがエコーとして捨てられる。
		selfHash = null;
		const incoming = payload.content;
		const plan = planExternalChange({ base: model.base, current: currentText, incoming, dirty });
		if (plan.kind === 'conflict') {
			// 要件#89 契約12: 重なりの相手が変わったら version を進める(開いているマージの画面が塊を作り直す)
			if (theirs !== incoming) version++;
			theirs = incoming;
			conflict = true;
			return 'external-conflict';
		}
		if (plan.kind !== 'same') replaceText(plan.text);
		setBase(incoming);
		// 未編集の置き換えでは、出ている帯(保存の照合の衝突など)はそのまま
		if (plan.kind !== 'replace') {
			conflict = false;
			theirs = null;
		}
		syncWindowDocument(uri, incoming, payload.modified);
		if (plan.kind === 'merged') showNotice(MERGED_NOTICE);
		return 'apply';
	}

	/** 変換が終わってから、待たせた外部変更と検索の語を 1 回だけ当てる。 */
	function flushPending() {
		if (composition.active) return;
		const file = pendingFile;
		pendingFile = null;
		if (file) applyNow(file);
		finder.flush();
	}

	/** 文書モデルを作り直す(履歴 0・dirty でない)。 */
	function resetDocument(next: string) {
		model = createTextDocument(next, { uri, readOnly });
		currentText = next;
		selfHash = null;
		dirty = false;
		conflict = false;
		theirs = null;
		if (view) {
			view.setState(model.state.update({ effects: StateEffect.appendConfig.of(faceExtensions()) }).state);
			void loadLanguage();
			void loadTheme(untrack(() => codeTheme));
			finder.recount();
		}
	}

	const handle: FileEditorHandle = {
		kind: 'text',
		uri: untrack(() => uri),
		readOnly: untrack(() => readOnly),
		get dirty() {
			return dirty;
		},
		get version() {
			return version;
		},
		get conflict() {
			return conflict;
		},
		get notice() {
			return notice;
		},
		text: () => currentText,
		expectedHash: () => model.baseHash,
		// 第4段 4-1: 差分表示の左右(未保存の差分=基準の版 ↔ 今・衝突の差分=今 ↔ 届いた内容 / ディスク)
		baseText: () => model.base,
		conflictText: async () => (conflict ? (theirs ?? readDiskText(uri)) : null),
		markSaved(text: string) {
			setBase(text);
			selfHash = contentHash(text);
			conflict = false;
			theirs = null;
		},
		applyFileChanged(payload: DocumentPayload): FileChangedDecision {
			const hash = contentHash(payload.content);
			if (selfHash !== null && hash === selfHash) return 'ignore-echo';
			// 周回0 の 0-6: 1 回の書き込みで同じ全文の file_changed が 2〜5 回届く。基準の版と同じ内容
			// (続けて届いた同じ内容・削除+作成で元のまま戻った内容)は取り込み済みなので何もしない
			// (マージと知らせを繰り返さない)。重なりの帯を出している間は、その版が届き直しただけ。
			if (hash === model.baseHash && !conflict) {
				if (composition.active) pendingFile = null;
				return 'ignore-echo';
			}
			if (conflict && theirs !== null && payload.content === theirs) return 'external-conflict';
			if (composition.active) {
				// Issue #848: 待たせた外部変更も取り込みに数える(変換中に自分の以前の保存の中身が届いても捨てない)。
				selfHash = null;
				pendingFile = payload;
				return 'apply';
			}
			return applyNow(payload);
		},
		keepMyEdits() {
			const disk = theirs;
			conflict = false;
			theirs = null;
			// 保存の照合の衝突から来たときは、ディスクの今の版を読んで基準にする。
			withDiskVersion(uri, disk, (next) => {
				// Issue #851 (3): ディスクの版を取り込んだので、自分の以前の保存の印も忘れる(applyNow と同じ)。
				// 外部がその中身に戻しても、エコーとして捨てずに普通の外部変更として扱う。
				selfHash = null;
				setBase(next);
				syncWindowDocument(uri, next);
			});
		},
		useFileOnDisk() {
			const disk = theirs;
			conflict = false;
			theirs = null;
			withDiskVersion(uri, disk, (next) => {
				resetDocument(next);
				syncWindowDocument(uri, next);
			});
		},
		showSaveConflict() {
			theirs = null;
			conflict = true;
		},
		// 要件#89 契約11: マージの Apply(取引 1 つ・履歴に積む)。基準の版はマージに使ったディスクの版
		applyMerge(merged: string, disk: string) {
			if (view && merged !== currentText) {
				view.dispatch({ ...replaceWith(view.state, merged), annotations: isolateHistory.of('full'), userEvent: 'merge' });
			}
			selfHash = null;
			conflict = false;
			theirs = null;
			setBase(disk);
			syncWindowDocument(uri, disk);
		},
		reset(next: string) {
			resetDocument(next);
		},
		preparePrint: () => preparePrint(),
		// 第3段 3-3: 置換(読み取り専用の面には無い)
		...(untrack(() => readOnly) ? {} : { replaceCurrent: finder.replaceCurrent, replaceAll: finder.replaceAll }),
	};

	// --- 面の拡張 ----------------------------------------------------------

	/** BOM で始まる文書では、打鍵・削除で BOM を壊さず、カーソルを BOM の前に置かない。 */
	function bomGuard(): Extension {
		const isUser = (tr: Transaction) =>
			tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move') || tr.isUserEvent('select');
		return [
			EditorState.changeFilter.of((tr) => {
				if (!tr.startState.doc.sliceString(0, 1).startsWith('\uFEFF')) return true;
				return isUser(tr) ? [0, 1] : true;
			}),
			EditorState.transactionFilter.of((tr) => {
				if (!tr.selection || !tr.newDoc.sliceString(0, 1).startsWith('\uFEFF')) return tr;
				if (!tr.selection.ranges.some((r) => r.from === 0)) return tr;
				const ranges = tr.selection.ranges.map((r) => ({
					anchor: Math.max(1, r.anchor),
					head: Math.max(1, r.head),
				}));
				return [tr, { selection: { anchor: ranges[0]!.anchor, head: ranges[0]!.head }, sequential: true }];
			}),
		];
	}

	function onUpdate(update: import('@codemirror/view').ViewUpdate) {
		if (!update.docChanged) return;
		currentText = sliceStateText(update.state);
		dirty = currentText !== model.base;
		version++;
		finder.scheduleRecount();
	}

	function faceExtensions(): Extension {
		return [
			lang ? lineNumbers() : [],
			bracketMatching(),
			keymap.of(CODE_KEYMAP),
			EditorView.editable.of(!readOnly),
			EditorView.lineWrapping,
			EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
			themeCompartment.of([]),
			languageCompartment.of([]),
			findField,
			model.state.doc.sliceString(0, 1) === '\uFEFF' ? bomGuard() : [],
			EditorView.updateListener.of(onUpdate),
			EditorView.domEventHandlers({
				copy: (event, v) => copySelection(event, v, false),
				cut: (event, v) => copySelection(event, v, true),
				// 要件#74 第2段 2-6: 文字の上の右クリックはネイティブのメニュー(Option + 右クリック・読み取り専用は既定のまま)
				contextmenu: (event) => handleEditorContextMenu(event, { surface: 'code', uri, readOnly }),
				// 変換中の印(変換中の blur は確定として扱う=契約10)
				...composition.handlers,
			}),
		];
	}

	async function loadLanguage() {
		if (!lang) return;
		const support = await languageSupportFor(lang);
		if (!support || !view) return;
		view.dispatch({ effects: languageCompartment.reconfigure(support) });
	}

	// テーマが変わったら色だけ差し替える(EditorState を作り直さない)。
	$effect(() => {
		const name = codeTheme;
		if (!view) return;
		void loadTheme(name);
	});

	// --- 印刷(契約17・刷るのは今の描画) -----------------------------------

	/** 今の文字列を今の描画(Shiki の `<pre>`・色なしなら plain の `<pre>`)にする。紙はいつもライト。 */
	async function preparePrint(): Promise<void> {
		const text = currentText;
		try {
			const result = await renderForDisplay(uri, text, undefined, 'github-light');
			preparedPrint = { text, html: result.html };
		} catch {
			preparedPrint = null;
		}
	}

	function onBeforePrint() {
		const text = currentText;
		printHtml = preparedPrint && preparedPrint.text === text ? preparedPrint.html : renderPlainText(text);
		flushSync();
		if (!preparedPrint || preparedPrint.text !== text) {
			// 準備が間に合わなかったとき(印刷のシートの外から刷られた)は、色付きの描画を後から差す。
			void preparePrint().then(() => {
				if (printHtml !== null && preparedPrint?.text === currentText) printHtml = preparedPrint.html;
			});
		}
	}

	function onAfterPrint() {
		printHtml = null;
	}

	// --- 組み立て ----------------------------------------------------------

	onMount(() => {
		model = createTextDocument(untrack(() => content), { uri, readOnly });
		currentText = untrack(() => content);
		view = new EditorView({
			parent: host!,
			state: model.state.update({ effects: StateEffect.appendConfig.of(faceExtensions()) }).state,
		});
		windowState.fileEditor = handle;
		void loadLanguage();
		void loadTheme(untrack(() => codeTheme));
		const initialQuery = untrack(() => findQuery);
		if (initialQuery) finder.run(initialQuery, true);
		window.addEventListener('beforeprint', onBeforePrint);
		window.addEventListener('afterprint', onAfterPrint);
		return () => {
			window.removeEventListener('beforeprint', onBeforePrint);
			window.removeEventListener('afterprint', onAfterPrint);
			if (noticeTimer) clearTimeout(noticeTimer);
			finder.dispose();
			if (windowState.fileEditor === handle) windowState.fileEditor = null;
			view?.destroy();
			view = null;
		};
	});
</script>

<div
	class="code-editor vellis-plaintext"
	data-testid="code-editor"
	data-code-theme={codeTheme}
	data-vellis-lang={lang ?? undefined}
	style:font-size={zoom === DEFAULT_ZOOM ? null : `${zoom}%`}
>
	<div class="code-editor-surface" bind:this={host}></div>
	{#if printHtml !== null}
		<div class="code-editor-print" data-testid="code-editor-print">
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			{@html printHtml}
		</div>
	{/if}
</div>

<style>
	/*
	 * 書体・文字の大きさ・行間・折り返しは今の閲覧の pre.vellis-plaintext と同じ(契約4・5)。
	 * 幅は plain text が --doc-measure まで・コードは上限なし(要件56 契約 4)。
	 */
	.code-editor {
		display: block;
		min-width: 0;
	}

	.code-editor-surface {
		font-family: var(--font-mono);
		font-size: 90%;
		line-height: 1.5;
	}

	.code-editor:not([data-vellis-lang]) .code-editor-surface {
		max-width: var(--doc-measure);
	}

	:root[data-doc-measure="full"] .code-editor:not([data-vellis-lang]) .code-editor-surface {
		max-width: none;
	}

	.code-editor-surface :global(.cm-editor) {
		background-color: transparent;
		color: var(--color-text-primary);
	}

	.code-editor-surface :global(.cm-editor.cm-focused) {
		outline: none;
	}

	.code-editor-surface :global(.cm-scroller) {
		font-family: inherit;
		line-height: inherit;
		overflow: visible;
	}

	.code-editor-surface :global(.cm-content) {
		padding: 0;
		caret-color: var(--color-text-primary);
	}

	.code-editor-surface :global(.cm-line) {
		padding: 0;
	}

	.code-editor-surface :global(.cm-gutters) {
		background-color: transparent;
		border-right: none;
		color: var(--color-text-muted);
		padding-right: 1em;
	}

	.code-editor-surface :global(.cm-selectionBackground),
	.code-editor-surface :global(.cm-focused .cm-selectionBackground) {
		background-color: var(--color-selection);
	}

	.code-editor-surface :global(.cm-cursor) {
		border-left-color: var(--color-text-primary);
	}

	.code-editor-surface :global(.cm-matchingBracket) {
		background-color: var(--color-accent-soft);
		color: inherit;
	}

	.code-editor-surface :global(.cm-vellis-find) {
		background-color: var(--color-find-match);
	}

	.code-editor-surface :global(.cm-vellis-find-current) {
		background-color: var(--color-find-current);
		color: var(--color-find-current-text);
	}

	@media screen {
		.code-editor-print {
			display: none;
		}
	}

	@media print {
		.code-editor-surface {
			display: none;
		}
	}
</style>
