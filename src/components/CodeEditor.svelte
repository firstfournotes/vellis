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
	import { replaceAllIn, replaceCurrentIn, type ReplaceOutcome } from '../editor/cm-replace';
	import { handleEditorContextMenu } from '../editor/editor-context-menu-handler';
	import { Compartment, EditorState, StateEffect, Transaction, type Extension } from '@codemirror/state';
	import { EditorView, keymap, lineNumbers } from '@codemirror/view';
	import { bracketMatching, syntaxHighlighting } from '@codemirror/language';

	import { contentHash, type FileChangedDecision } from '$lib/document-edit';
	import { languageForFile } from '$lib/code-language';
	import type { MatchRange } from '$lib/find-in-document';
	import { findField, matchesIn, setFindMarks } from '../editor/cm-find';
	import { renderForDisplay } from '$lib/file-type';
	import { invoke } from '$lib/ipc';
	import { DEFAULT_ZOOM } from '$lib/zoom';
	import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
	import {
		createTextDocument,
		replaceWith,
		sliceStateText,
		stateLineEnding,
		type TextDocument,
	} from '../editor/text-document';
	import { merge3 } from '../editor/merge';
	import { CODE_KEYMAP } from '../editor/code-keymap';
	import { highlightStyleFor } from '../editor/code-theme';
	import { languageSupportFor } from '../editor/code-languages';
	import { MERGED_NOTICE, type FileEditorHandle } from '../editor/file-editor';

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

	/** 変換中(contentDOM の compositionstart〜compositionend を自前で数える)。 */
	let composing = false;
	let pendingFile: DocumentPayload | null = null;
	let pendingQuery: string | null = null;

	/** 刷る直前の描画(beforeprint〜afterprint の間だけ)。 */
	let printHtml = $state<string | null>(null);
	/** 印刷の準備で作った今の描画(その文字列のときだけ使う)。 */
	let preparedPrint: { text: string; html: string } | null = null;

	const themeCompartment = new Compartment();
	const languageCompartment = new Compartment();

	// --- 検索(一致の装飾と数え方は `src/editor/cm-find.ts`=raw の面と共有) ----------------

	let appliedQuery = '';
	let appliedRanges: MatchRange[] = [];
	let recountTimer: ReturnType<typeof setTimeout> | undefined;
	/** 変換中の打鍵で止めた数え直しがある(確定後に 1 回流す=契約10)。 */
	let recountPending = false;

	function runFind(query: string, moveSelection: boolean) {
		if (!view) return;
		const ranges = query.length === 0 ? [] : matchesIn(view.state.doc.toString(), query);
		appliedQuery = query;
		appliedRanges = ranges;
		const current = moveSelection ? 0 : Math.min(untrack(() => findCurrent), Math.max(0, ranges.length - 1));
		const target = ranges[current];
		view.dispatch({
			effects: setFindMarks.of({ ranges, current }),
			...(moveSelection && target
				? { selection: { anchor: target.start, head: target.end }, scrollIntoView: true }
				: {}),
		});
		onFindResults?.({ query, ranges });
	}

	// 語が変わったら数え直して、先頭の一致へ移る(変換中は確定まで待つ)。
	$effect(() => {
		const query = findQuery;
		if (!view) return;
		untrack(() => {
			if (composing) {
				pendingQuery = query;
				return;
			}
			if (query !== appliedQuery) runFind(query, true);
		});
	});

	// 現在の一致が変わったら(Prev / Next・番目合わせ)選択をそこへ移す。
	$effect(() => {
		const current = findCurrent;
		untrack(() => {
			if (!view || appliedRanges.length === 0) return;
			const target = appliedRanges[current];
			if (!target) return;
			view.dispatch({
				selection: { anchor: target.start, head: target.end },
				scrollIntoView: true,
				effects: setFindMarks.of({ ranges: appliedRanges, current }),
			});
		});
	});

	/** 打鍵の後の数え直しは間をおく(語の入力ではすぐ数える)。選択は動かさない。 */
	function scheduleRecount() {
		if (appliedQuery.length === 0) return;
		if (recountTimer) clearTimeout(recountTimer);
		recountTimer = setTimeout(() => {
			recountTimer = undefined;
			if (composing) {
				recountPending = true;
				return;
			}
			runFind(appliedQuery, false);
		}, 150);
	}

	// --- 置換(第3段 3-3。純関数は `src/editor/cm-replace.ts`) ----------------

	/** 置換の後: 間をおいた数え直しを捨てて、今数え直した一致と現在を当て、Viewer へ返す(Replace は現在へ選択も移す)。 */
	function applyReplaceOutcome(outcome: ReplaceOutcome, moveSelection: boolean) {
		if (!view) return;
		if (recountTimer) {
			clearTimeout(recountTimer);
			recountTimer = undefined;
		}
		appliedRanges = outcome.ranges;
		const target = outcome.ranges[outcome.current];
		view.dispatch({
			effects: setFindMarks.of({ ranges: outcome.ranges, current: outcome.current }),
			...(moveSelection && target ? { selection: { anchor: target.start, head: target.end }, scrollIntoView: true } : {}),
		});
		onFindResults?.({ query: appliedQuery, ranges: outcome.ranges, current: outcome.current });
	}

	function replaceCurrent(replacement: string): boolean {
		if (!view) return false;
		const outcome = replaceCurrentIn(view, appliedQuery, untrack(() => findCurrent), replacement);
		if (!outcome) return false;
		applyReplaceOutcome(outcome, true);
		return true;
	}

	function replaceAllMatches(replacement: string): number {
		if (!view) return 0;
		const outcome = replaceAllIn(view, appliedQuery, replacement);
		if (!outcome) return 0;
		applyReplaceOutcome(outcome, false);
		return outcome.count;
	}

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

	/** 窓の文書(currentDocument)を基準の版にそろえる(page の再描画・Copy の元)。 */
	function syncWindowDocument(next: string, modified: number | null | undefined) {
		const doc = windowState.currentDocument;
		if (!doc || doc.uri !== uri) return;
		windowState.currentDocument = { ...doc, content: next, modified: modified ?? doc.modified };
	}

	function applyNow(payload: DocumentPayload): FileChangedDecision {
		// Issue #848: 自分のエコーでない外部変更を取り込んだ(当てた・マージした・帯にした)ら、自分の保存のハッシュは
		// 忘れる。残すと、外部が自分の以前の保存と同じ中身に戻した書き込みがエコーとして捨てられる。
		selfHash = null;
		const incoming = payload.content;
		if (incoming === currentText) {
			setBase(incoming);
			conflict = false;
			theirs = null;
			syncWindowDocument(incoming, payload.modified);
			return 'apply';
		}
		if (!dirty) {
			replaceText(incoming);
			setBase(incoming);
			syncWindowDocument(incoming, payload.modified);
			return 'apply';
		}
		const merged = merge3(model.base, currentText, incoming);
		if (merged.kind === 'clean') {
			replaceText(merged.text);
			setBase(incoming);
			conflict = false;
			theirs = null;
			syncWindowDocument(incoming, payload.modified);
			showNotice(MERGED_NOTICE);
			return 'apply';
		}
		theirs = incoming;
		conflict = true;
		return 'external-conflict';
	}

	/** 変換が終わってから、待たせた外部変更と検索の語を 1 回だけ当てる。 */
	function flushPending() {
		if (composing) return;
		const file = pendingFile;
		pendingFile = null;
		if (file) applyNow(file);
		const query = pendingQuery;
		pendingQuery = null;
		const recount = recountPending;
		recountPending = false;
		if (query !== null && query !== appliedQuery) runFind(query, true);
		else if (recount && appliedQuery.length > 0) runFind(appliedQuery, false);
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
			if (appliedQuery) runFind(appliedQuery, false);
		}
	}

	async function readDisk(): Promise<string | null> {
		try {
			const doc = await invoke<DocumentPayload>('open_document', { uri });
			return doc.content;
		} catch (err) {
			alert(`Could not read the file: ${err}`);
			return null;
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
		conflictText: async () => {
			if (!conflict) return null;
			if (theirs !== null) return theirs;
			return readDisk();
		},
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
				if (composing) pendingFile = null;
				return 'ignore-echo';
			}
			if (conflict && theirs !== null && payload.content === theirs) return 'external-conflict';
			if (composing) {
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
			if (disk !== null) {
				setBase(disk);
				syncWindowDocument(disk, undefined);
				return;
			}
			// 保存の照合の衝突から来たときは、ディスクの今の版を読んで基準にする。
			void readDisk().then((read) => {
				if (read === null) return;
				setBase(read);
				syncWindowDocument(read, undefined);
			});
		},
		useFileOnDisk() {
			const disk = theirs;
			conflict = false;
			theirs = null;
			const apply = (next: string) => {
				resetDocument(next);
				syncWindowDocument(next, undefined);
			};
			if (disk !== null) apply(disk);
			else
				void readDisk().then((read) => {
					if (read !== null) apply(read);
				});
		},
		showSaveConflict() {
			theirs = null;
			conflict = true;
		},
		reset(next: string) {
			resetDocument(next);
		},
		preparePrint: () => preparePrint(),
		// 第3段 3-3: 置換(読み取り専用の面には無い)
		...(untrack(() => readOnly) ? {} : { replaceCurrent, replaceAll: replaceAllMatches }),
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
		scheduleRecount();
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
				compositionstart: () => {
					composing = true;
					return false;
				},
				compositionend: () => {
					composing = false;
					setTimeout(flushPending, 0);
					return false;
				},
				blur: () => {
					// WebKit は変換中の blur で compositionend を出さないことがある(契約10)。
					if (composing) {
						composing = false;
						setTimeout(flushPending, 0);
					}
					return false;
				},
			}),
		];
	}

	/**
	 * コピー / 切り取り(契約17): `text/plain` は選んだ文字列そのもの(改行は文書の改行コード)。
	 * 何も選んでいないときは何もしない(CodeMirror の既定の行ごとのコピーを止める=2026-11-16 由谷決定)。
	 */
	function copySelection(event: ClipboardEvent, v: EditorView, cut: boolean): boolean {
		event.preventDefault();
		const ranges = v.state.selection.ranges.filter((r) => !r.empty);
		if (ranges.length === 0) return true;
		const text = ranges.map((r) => sliceStateText(v.state, r.from, r.to)).join(stateLineEnding(v.state));
		event.clipboardData?.clearData();
		event.clipboardData?.setData('text/plain', text);
		if (cut && !v.state.readOnly) {
			v.dispatch({
				changes: ranges.map((r) => ({ from: r.from, to: r.to })),
				userEvent: 'delete.cut',
				scrollIntoView: true,
			});
		}
		return true;
	}

	async function loadLanguage() {
		if (!lang) return;
		const support = await languageSupportFor(lang);
		if (!support || !view) return;
		view.dispatch({ effects: languageCompartment.reconfigure(support) });
	}

	let themeRequest = 0;
	async function loadTheme(name: string) {
		const request = ++themeRequest;
		try {
			const style = await highlightStyleFor(name);
			if (request !== themeRequest || !view) return;
			view.dispatch({ effects: themeCompartment.reconfigure(syntaxHighlighting(style)) });
		} catch (err) {
			console.warn(`Could not load the ${name} colours`, err);
		}
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

	function plainHtml(text: string): string {
		const escaped = text.replace(
			/[&<>"']/g,
			(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
		);
		return `<pre class="vellis-plaintext">\n${escaped}</pre>`;
	}

	function onBeforePrint() {
		const text = currentText;
		printHtml = preparedPrint && preparedPrint.text === text ? preparedPrint.html : plainHtml(text);
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
		if (initialQuery) runFind(initialQuery, true);
		window.addEventListener('beforeprint', onBeforePrint);
		window.addEventListener('afterprint', onAfterPrint);
		return () => {
			window.removeEventListener('beforeprint', onBeforePrint);
			window.removeEventListener('afterprint', onAfterPrint);
			if (noticeTimer) clearTimeout(noticeTimer);
			if (recountTimer) clearTimeout(recountTimer);
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
