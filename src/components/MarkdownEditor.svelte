<script lang="ts">
	/**
	 * Markdown の編集面(要件#74 契約1・3・8・10〜14・16〜18・第2段の作り(案)の項目 1・8・11〜19)。
	 *
	 * 開いた時点から ProseMirror の `EditorView` がレンダリング結果の面であり編集面。`.markdown-body` の中に置き、
	 * 今の描画と同じ CSS(markdown.css)で描く。文書モデルは `src/editor/markdown-document.ts`(書き出しは 3 段の規則)。
	 * 窓の状態とのつなぎ(保存・外部変更・未保存の確認・Reload File・Format)は `windowState.fileEditor` に置く handle。
	 *
	 * - 外部変更: 未編集なら変わったブロックだけを置き換え、編集中なら 3 方向マージ(第1段と同じ規則)
	 * - 変換中(IME)は外部変更の取り込みを待ち、確定後に 1 回だけ当てる(Format は `runFormatCommand` が待つ)
	 * - コピーの text/plain は見えている文字。貼り付けは ProseMirror の切片でなければ text/plain を文字として入れる
	 * - リンクの普通のクリックで航行(文書も選択も変えない)。Option + クリックは航行しない
	 * - 印刷は刷る直前に今の文字列を今の描画(`render`)にしたものを置き、面を隠す
	 */
	import { flushSync, onMount, tick, untrack } from 'svelte';
	import { handleEditorContextMenu } from '../editor/editor-context-menu-handler';
	import { buildTableHandleMenu } from '../editor/editor-context-menu';
	import {
		commandAtCell,
		selectionTableCell,
		TABLE_COMMANDS,
		TABLE_HANDLE_COMMANDS,
		tableCellAt,
		tableCellPos,
		type TableCellTarget,
	} from '../editor/table-commands';
	import { popupMenu } from '$lib/native-menu';
	import { Slice, Fragment, type Node as PMNode } from 'prosemirror-model';
	import { TextSelection } from 'prosemirror-state';
	import type { Command, EditorState, Transaction } from 'prosemirror-state';
	import { EditorView } from 'prosemirror-view';
	import { keymap } from 'prosemirror-keymap';
	import { dropCursor } from 'prosemirror-dropcursor';
	import SelectionBar from './SelectionBar.svelte';
	import { SELECTION_BAR_SETTLE_MS, selectionBarPosition } from '../editor/format-toolbar';
	import { deferFormatCommand, discardDeferredFormat, linkRangeAt, runFormatCommand, type FormatItemId } from '../editor/commands';
	import { closeHistory } from 'prosemirror-history';
	import {
		PASTE_AS_MARKDOWN_LABEL,
		PASTE_AS_MARKDOWN_TESTID,
		parseMarkdownFragment,
		shouldOfferMarkdownPaste,
	} from '../editor/paste-markdown';
	import { openUrl } from '@tauri-apps/plugin-opener';
	import { open as openDialog } from '@tauri-apps/plugin-dialog';

	import { contentHash, type FileChangedDecision } from '$lib/document-edit';
	import { confirmDiscardEdits } from '$lib/edit-guard';
	import { invoke } from '$lib/ipc';
	import { isExternal } from '$lib/uri';
	import { mountMermaid } from '$lib/mermaid-mounter';
	import { openFileFailedMessage } from '$lib/open-document';
	import { openInNewWindowFailedMessage } from '$lib/open-in-new-window';
	import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
	import { render } from '../markdown/renderer';
	import {
		createMarkdownDocument,
		markdownText,
		rekeyAfterSave,
		replaceChangedBlocks,
		withFacePlugins,
		withState,
		type MarkdownDocument,
	} from '../editor/markdown-document';
	import { merge3 } from '../editor/merge';
	import { markdownInputRules, undoMarkdownInputRule } from '../editor/input-rules';
	import { headingSoftBreakPlugin } from '../editor/heading-breaks';
	import { frontMatterGuardPlugin } from '../editor/front-matter-guard';
	import { markdownGapCursor } from '../editor/gap-cursor';
	import { inTableCell, MARKDOWN_KEYMAP } from '../editor/markdown-keymap';
	import { plainTextParagraphs } from '../editor/commands';
	import { MERGED_NOTICE, type MarkdownEditorHandle } from '../editor/file-editor';
	import { announceRawSource, fromRaw, MENU_RAW_SOURCE_EVENT, toRaw, watchFocusForRawSource } from '../editor/raw-sync';
	import { listen } from '$lib/events';
	import { DEFAULT_ZOOM } from '$lib/zoom';
	import RawSourceEditor from './RawSourceEditor.svelte';
	import {
		applyCodeTheme,
		createMarkViews,
		createNodeViews,
		mermaidActivePlugin,
		refreshFootnoteNumbers,
		taskMarksPlugin,
		type NodeViewContext,
	} from '../editor/node-views';

	let {
		uri,
		content,
		readOnly = false,
		rawOnly = false,
		zoom = DEFAULT_ZOOM,
		codeTheme = 'github-light',
		findQuery = '',
		findCurrent = 0,
		onFindResults,
		onExitRaw,
		onComposingChange,
		onDocChange,
		scrollIntoViewer,
	}: {
		uri: string;
		/** 開いたときの文字列(この面は uri ごとに作り直す。中身の差し替えは handle の reset)。 */
		content: string;
		readOnly?: boolean;
		/**
		 * 閾値を超えた Markdown(契約18・項目 21)の raw: 編集面(ProseMirror)を作らず raw だけで開く。Raw Source を
		 * もう一度押すと `onExitRaw`(Viewer が今の描画に戻す)。
		 */
		rawOnly?: boolean;
		/** 表示倍率(raw の間は CodeMirror の文字の大きさに掛ける=項目 16)。 */
		zoom?: number;
		/** raw の配色(Shiki の同梱テーマの名前)。 */
		codeTheme?: string;
		/** raw の間の検索(文書全体を数える=契約17)。rendered の検索は Viewer が見えている文字で数える。 */
		findQuery?: string;
		findCurrent?: number;
		onFindResults?: (result: { query: string; ranges: import('$lib/find-in-document').MatchRange[]; current?: number }) => void;
		onExitRaw?: () => void;
		/** 変換中かを Viewer へ返す(検索の色の張り替えを待たせる=契約10)。 */
		onComposingChange?: (composing: boolean) => void;
		/** 文書が変わった(検索の張り直しの契機)。 */
		onDocChange?: () => void;
		/**
		 * #836・要件73 契約1・2・項目20: 面の中の航行(脚注の参照 → 定義・戻りリンク → 参照・`#id`)の行き先を運ぶ。Viewer の
		 * scrollElementIntoViewer(article.viewer の scrollTop だけを動かし、ツールバーと検索バーの実寸 + 8px の下へ)。
		 * 渡されないとき(Viewer の外で載せたとき)は scrollIntoView に落とす。
		 */
		scrollIntoViewer?: (el: HTMLElement) => void;
	} = $props();

	let host: HTMLDivElement | undefined = $state();
	let view: EditorView | null = null;

	/** 文書モデル(base・origin・generation)。state は view が持つ。 */
	let model: MarkdownDocument;
	let currentText = untrack(() => content);
	let selfHash: string | null = null;

	let dirty = $state(false);
	let conflict = $state(false);
	let notice = $state<string | null>(null);
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;
	let theirs: string | null = null;
	let pendingFile: DocumentPayload | null = null;
	/**
	 * 変換中(compositionstart〜compositionend か、変換中の blur まで)。ProseMirror の `view.composing` は変換中の
	 * blur では下りないので、外部変更の待ちは自前の印で見る(契約10)。
	 */
	let composing = false;
	/** 変換中に届いた Raw Source(確定の後に 1 回だけ切り替える=契約10)。 */
	let pendingToggle = false;

	/** raw(原文の CodeMirror)を出しているか(契約23)。 */
	let raw = $state(untrack(() => rawOnly));
	/** raw に入ったときの原文と選択。 */
	let rawStart = $state<{ text: string; anchor: number; head: number }>({ text: untrack(() => content), anchor: 0, head: 0 });
	let rawEditor: RawSourceEditor | undefined = $state();

	/** Link… の URL の入力欄(選んだ範囲と入力中の値)。 */
	/**
	 * 第4段 4-5: リンクの欄(Text と Link・Remove Link・Done)。[from, to) が対象の範囲。existing=リンクの中から開いた
	 * (その mark)。origText / origUrl は開いたときの値(変えずに Done なら何もしない)。
	 */
	let linkEditor = $state<{
		from: number;
		to: number;
		text: string;
		url: string;
		origText: string;
		origUrl: string;
		existing: import('prosemirror-model').Mark | null;
	} | null>(null);
	let linkUrlEl: HTMLInputElement | undefined = $state();

	let printHtml = $state<string | null>(null);
	let printEl: HTMLDivElement | undefined = $state();
	let preparedPrint: { text: string; html: string } | null = null;

	// --- 文書モデルと窓のつなぎ ---------------------------------------------

	function current(): MarkdownDocument {
		return view ? withState(model, view.state) : model;
	}

	function recompute() {
		currentText = raw ? (rawEditor?.getText() ?? currentText) : markdownText(current());
		dirty = currentText !== model.base;
	}

	/** raw の文字列が変わった(打鍵・外部変更の取り込み・作り直し)。 */
	function onRawChange(text: string) {
		currentText = text;
		dirty = currentText !== model.base;
		stateVersion++;
		onDocChange?.();
	}

	/** 閾値を超えた文書の raw だけの面の文書モデル(ProseMirror は作らない=基準の版だけを持つ)。 */
	function rawOnlyModel(text: string): MarkdownDocument {
		return { uri, readOnly, base: text, baseHash: contentHash(text) } as unknown as MarkdownDocument;
	}

	/** Command + B / Command + I(修飾は Command だけ。変換中も)なら、メニューと同じ Format の命令の id。 */
	function commandFormatKey(e: KeyboardEvent): FormatItemId | null {
		if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
		const k = e.key.toLowerCase();
		if (k === 'b') return 'format-bold';
		if (k === 'i') return 'format-italic';
		return null;
	}

	/** rendered ⇄ raw(契約23)。変換中は確定まで待つ。切り替えでは確認を出さない。 */
	function toggleRaw() {
		if (composing) {
			pendingToggle = true;
			return;
		}
		if (!raw) {
			if (!view) return;
			rawStart = toRaw(current());
			// 同じ場所で切り替わる: 編集面の DOM を外す(raw の間は ProseMirror を出さない)
			host?.replaceChildren();
			raw = true;
			hoverCell = null;
			refreshTableHandles();
			void announceRawSource(true);
			return;
		}
		if (rawOnly) {
			// 閾値超えの raw から今の描画へ。未保存の編集があれば raw のまま(黙って捨てない)。
			if (dirty) return;
			onExitRaw?.();
			return;
		}
		if (!view || !rawEditor) return;
		const text = rawEditor.getText();
		const cursor = rawEditor.getSelection();
		const r = fromRaw(current(), text, cursor);
		model = { ...model, origin: r.origin, generation: r.generation };
		raw = false;
		host?.appendChild(view.dom);
		view.dispatch(r.tr);
		// 実機ゲート (6)・契約23: 面の DOM を付け直したらフォーカスを面へ(body に残ると Command + Z が面に届かない)
		view.focus();
		recompute();
		refreshTableHandles();
		onDocChange?.();
		void announceRawSource(false);
	}

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
		stateVersion++;
	}

	function syncWindowDocument(next: string, modified: number | null | undefined) {
		const doc = windowState.currentDocument;
		if (!doc || doc.uri !== uri) return;
		windowState.currentDocument = { ...doc, content: next, modified: modified ?? doc.modified };
	}

	/** 文書を `target` にする(変わったブロックだけを置き換え・履歴に積まない)。 */
	function replaceText(target: string) {
		if (raw) {
			rawEditor?.replaceText(target);
			return;
		}
		if (!view) return;
		const { tr, origin, generation } = replaceChangedBlocks(view.state, target);
		model = { ...model, origin, generation };
		if (tr) view.dispatch(tr);
		else recompute();
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

	function flushPending() {
		if (composing) return;
		const file = pendingFile;
		pendingFile = null;
		if (file) applyNow(file);
		if (pendingToggle) {
			pendingToggle = false;
			toggleRaw();
		}
	}

	function facePlugins() {
		// 第3段 3-1: 入力規則は keymap より前(打鍵を先に見る)・gap cursor は keymap の後ろ
		// 第3段 3-5: ドロップの位置の印(見た目は下の CSS の .vellis-dropcursor)
		return [
			markdownInputRules(),
			// 実機ゲート A・事後確認 (19)(20): front matter は編集面のどの操作でも消えず、先頭以外にはできない。札の
			// Backspace / Delete は keymap より先に食う(取引を起こさない)
			frontMatterGuardPlugin(),
			keymap(MARKDOWN_KEYMAP),
			...markdownGapCursor(),
			dropCursor({ color: false, class: 'vellis-dropcursor' }),
			mermaidActivePlugin,
			// #835: タスクの項目の頭の印(押すと checked を反転)
			taskMarksPlugin(),
			// 締め 5 周目 P2-a: 見出しの中の hard_break はどの経路でも soft_break に(取引の後で 1 か所)
			headingSoftBreakPlugin(),
		];
	}

	/** 文書モデルを作り直す(履歴 0・dirty でない)。 */
	function resetDocument(next: string) {
		model = rawOnly ? rawOnlyModel(next) : withFacePlugins(createMarkdownDocument(next, { uri, readOnly }), facePlugins());
		currentText = next;
		selfHash = null;
		dirty = false;
		conflict = false;
		theirs = null;
		if (view) {
			// 確定の来ない Format の控え(変換中の Format ▸ Bold・Command + B / I)は新しい文書に持ち越さない(差し戻し P3)
			discardDeferredFormat(view);
			view.updateState(model.state);
			refreshTableHandles();
		}
		if (raw) rawEditor?.resetText(next);
		onDocChange?.();
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

	// --- 印刷(契約17・刷るのは今の描画) -----------------------------------

	async function renderForPrint(text: string): Promise<string> {
		const result = await render(text, uri, { codeTheme: 'github-light' });
		return result.html;
	}

	async function preparePrint(): Promise<void> {
		const text = currentText;
		try {
			preparedPrint = { text, html: await renderForPrint(text) };
		} catch {
			preparedPrint = null;
		}
	}

	function onBeforePrint() {
		const text = currentText;
		if (preparedPrint && preparedPrint.text === text) {
			printHtml = preparedPrint.html;
			flushSync();
			if (printEl) void mountMermaid(printEl);
			return;
		}
		// 準備が間に合わなかった(印刷のシートの外から刷られた)ときは、描けた時点で差す。
		void renderForPrint(text).then((html) => {
			preparedPrint = { text, html };
			printHtml = html;
			flushSync();
			if (printEl) void mountMermaid(printEl);
		});
	}

	function onAfterPrint() {
		printHtml = null;
	}

	// --- handle -------------------------------------------------------------

	const handle: MarkdownEditorHandle = {
		kind: 'markdown',
		get raw() {
			return raw;
		},
		toggleRaw,
		get version() {
			return stateVersion;
		},
		// 第3段 3-3(3-11): 置換は raw のときだけ(rendered・読み取り専用では undefined=検索だけ)
		get replaceCurrent() {
			return raw && !readOnly && rawEditor ? (replacement: string) => rawEditor?.replaceCurrent(replacement) ?? false : undefined;
		},
		get replaceAll() {
			return raw && !readOnly && rawEditor ? (replacement: string) => rawEditor?.replaceAll(replacement) ?? 0 : undefined;
		},
		get view() {
			return view!;
		},
		uri: untrack(() => uri),
		readOnly: untrack(() => readOnly),
		get dirty() {
			return dirty;
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
			// 保存の後は全ブロックが「触っていない」(続けて直すと 2 段目)=項目 13。raw の間は基準の版だけを進め、
			// raw から戻るとき(fromRaw)に保存した文字列が新しい原文になる。
			if (raw) setBase(text);
			else model = rekeyAfterSave(current(), text);
			selfHash = contentHash(text);
			conflict = false;
			theirs = null;
			recompute();
		},
		applyFileChanged(payload: DocumentPayload): FileChangedDecision {
			const hash = contentHash(payload.content);
			if (selfHash !== null && hash === selfHash) return 'ignore-echo';
			// 同じ全文が続けて届く(周回0 の 0-6)・削除+作成で元のまま戻った=取り込み済み
			if (hash === model.baseHash && !conflict) {
				pendingFile = null;
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
		preparePrint,
		model: () => current(),
		openLinkInput,
		chooseImage,
	};

	// --- Link… / Image…(契約8・項目 7・11) --------------------------------

	const WORD_CHAR = /[\p{L}\p{N}_]/u;
	const URL_LIKE = /^(https?:\/\/|mailto:|www\.)\S+$/i;

	/** 選択の範囲。空ならカーソルの単語(前後どちらも語の文字)。単語の上でもなければ null。 */
	function linkRange(): { from: number; to: number } | null {
		if (!view) return null;
		const { from, to, empty } = view.state.selection;
		if (!empty) return { from, to };
		const at = view.state.selection.$from;
		const parent = at.parent;
		if (!parent.isTextblock) return null;
		const text = parent.textBetween(0, parent.content.size, '\0', '\0');
		const offset = at.parentOffset;
		if (!WORD_CHAR.test(text[offset - 1] ?? '') || !WORD_CHAR.test(text[offset] ?? '')) return null;
		let start = offset;
		while (start > 0 && WORD_CHAR.test(text[start - 1]!)) start--;
		let end = offset;
		while (end < text.length && WORD_CHAR.test(text[end]!)) end++;
		return { from: at.start() + start, to: at.start() + end };
	}

	/**
	 * Link…(第4段 4-5・4-10): 欄を開く。リンクの中(カーソルか選択がリンクの mark の中)=範囲はそのリンク・Text=文言・
	 * Link=href。リンクの外=選んだ範囲(空なら単語。単語の上でもなければ開かない)・Text=選んだ文字・Link=URL なら選んだ文字。
	 * フォーカスは Link の欄。
	 */
	function openLinkInput() {
		if (!view || readOnly) return;
		const inLink = linkRangeAt(view.state);
		const range = inLink ?? linkRange();
		if (!range) return;
		const text = view.state.doc.textBetween(range.from, range.to, ' ', ' ');
		const url = inLink ? String(inLink.mark.attrs.href ?? '') : URL_LIKE.test(text) ? text : '';
		linkEditor = { from: range.from, to: range.to, text, url, origText: text, origUrl: url, existing: inLink?.mark ?? null };
		void tick().then(() => {
			linkUrlEl?.focus();
			linkUrlEl?.select();
		});
	}

	function closeLinkInput() {
		linkEditor = null;
		view?.focus();
	}

	/**
	 * Done / Enter: 1 取引で文言と行き先を替える(Text が変われば範囲の文字を Text に・Link を href に。Text と Link が同じなら
	 * literal=素の URL・違えば inline)。Link が空なら何もしない。リンクの中で何も変えていなければ何もしない。
	 */
	function applyLink() {
		const pending = linkEditor;
		if (!view || !pending) return;
		const href = pending.url.trim();
		const text = pending.text;
		const size = view.state.doc.content.size;
		const unchanged = pending.existing !== null && text === pending.origText && href === pending.origUrl;
		// 参照のリンクで行き先を変えていない(定義から読むので href は空のこともある)=文言だけの直し
		const keepReference = pending.existing?.attrs.kind === 'reference' && href === pending.origUrl;
		if ((href || keepReference) && !unchanged && pending.to <= size && pending.from < pending.to && text.length > 0) {
			const linkType = view.state.schema.marks.link!;
			const tr = view.state.tr;
			let to = pending.to;
			if (text !== pending.origText) {
				const marksHere = (view.state.doc.nodeAt(pending.from)?.marks ?? []).filter((m) => m.type !== linkType);
				tr.replaceWith(pending.from, pending.to, view.state.schema.text(text, marksHere));
				to = pending.from + text.length;
			}
			const existing = pending.existing;
			let attrs: Record<string, unknown>;
			if (existing && keepReference) {
				// 参照のリンク(`[文言][ref]`)の文言だけの直しは参照のまま(由谷の決定)。文言が鍵を兼ねる形(`[文言][]`・`[文言]`)は、
				// 文言を変えると参照が切れるので、元の鍵で明示する形(`[文言][ref]`)にする。定義の行はそのまま
				attrs = { ...existing.attrs, referenceType: 'full' };
			} else {
				// 行き先を替えた(か、参照でない)リンク: Text と Link が同じなら literal=素の URL・違えば inline の `[文言](URL)`
				const kind = text === href ? 'literal' : 'inline';
				attrs = { href, kind, title: (existing?.attrs.title as string | null | undefined) ?? null };
			}
			tr.removeMark(pending.from, to, linkType).addMark(pending.from, to, linkType.create(attrs));
			view.dispatch(tr);
		}
		closeLinkInput();
	}

	/** Remove Link: 1 取引で範囲のリンクの mark を外す(文言は残る)。 */
	function removeLink() {
		const pending = linkEditor;
		if (!view || !pending || !pending.existing) return;
		view.dispatch(view.state.tr.removeMark(pending.from, pending.to, view.state.schema.marks.link!));
		closeLinkInput();
	}

	function onLinkKeydown(event: KeyboardEvent) {
		if (event.isComposing) return;
		if (event.key === 'Enter') {
			event.preventDefault();
			applyLink();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			closeLinkInput();
		}
	}

	/** 文書(uri)のフォルダからの相対パス(`/` 区切り)。 */
	function relativeFromDocument(path: string): string {
		let dir: string[];
		try {
			dir = decodeURIComponent(new URL(uri).pathname).split('/').slice(0, -1);
		} catch {
			return path;
		}
		const target = path.split('/');
		let common = 0;
		while (common < dir.length && common < target.length && dir[common] === target[common]) common++;
		const up = dir.slice(common).filter((p) => p !== '').map(() => '..');
		return [...up, ...target.slice(common)].join('/');
	}

	/** Image…: ファイルを選ぶダイアログ(今の dialog:default の範囲)→ 文書からの相対パスの image をカーソルに。 */
	async function chooseImage() {
		if (!view || readOnly) return;
		let picked: string | string[] | null = null;
		try {
			picked = await openDialog({
				multiple: false,
				directory: false,
				filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'] }],
			});
		} catch (err) {
			alert(`Could not choose an image: ${err}`);
			return;
		}
		const path = Array.isArray(picked) ? picked[0] : picked;
		if (!path || !view) return;
		const src = relativeFromDocument(path);
		const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');
		const image = view.state.schema.nodes.image!.create({ src, alt: name });
		view.dispatch(view.state.tr.replaceSelectionWith(image, false).scrollIntoView());
	}

	// --- コピーの text/plain(項目 18) -------------------------------------

	/** 見えている文字: soft break は空白・hard break は改行・atom は描画の文字(脚注の番号・画像の alt・生 HTML の文字)。 */
	function visibleLeafText(node: PMNode): string {
		switch (node.type.name) {
			case 'soft_break':
				return ' ';
			case 'hard_break':
				return '\n';
			case 'footnote_reference':
				return `[${node.attrs.label}]`;
			case 'image':
				return String(node.attrs.alt ?? '');
			case 'html_inline':
				return String(node.attrs.raw ?? '')
					.replace(/<!--[\s\S]*?-->/g, '')
					.replace(/<[^>]*>/g, '')
					.replace(/&lt;/g, '<')
					.replace(/&gt;/g, '>')
					.replace(/&quot;/g, '"')
					.replace(/&#39;/g, "'")
					.replace(/&amp;/g, '&');
			default:
				return '';
		}
	}

	// --- 航行(契約17・(aa)・判断 5・7) ------------------------------------

	function resolveHref(href: string): string {
		try {
			return new URL(href, uri).toString();
		} catch {
			return href;
		}
	}

	/** id を持つ要素を面(と Viewer の本文)から探す。無ければ null(判断 5: 見出しには id が無いので飛ばない)。 */
	function inDocumentTarget(fragment: string): HTMLElement | null {
		const root = host?.closest('.markdown-body') ?? host;
		if (!root || fragment === '') return null;
		let decoded = fragment;
		try {
			decoded = decodeURIComponent(fragment);
		} catch {
			// 不正な百分率符号化は綴りのまま
		}
		const withId = [...root.querySelectorAll<HTMLElement>('[id]')];
		// 生 HTML の id は今の描画と同じ sanitize で `user-content-` が前に付く
		const ids = [fragment, decoded, `user-content-${fragment}`, `user-content-${decoded}`];
		for (const id of ids) {
			const found = withId.find((el) => el.id === id);
			if (found) return found;
		}
		return null;
	}

	async function navigate(href: string, newWindow: boolean) {
		if (isExternal(href)) {
			await openUrl(href);
			return;
		}
		if (href.startsWith('#')) {
			const target = inDocumentTarget(href.slice(1));
			if (!target) return;
			if (scrollIntoViewer) scrollIntoViewer(target);
			else target.scrollIntoView?.({ block: 'start' });
			return;
		}
		if (!/\.(md|markdown|mdx)(#.*)?$/i.test(href)) return;
		const target = resolveHref(href.replace(/#.*$/, ''));
		if (newWindow) {
			try {
				await invoke('new_window', { path: target, root: windowState.root });
			} catch (err) {
				alert(openInNewWindowFailedMessage(err));
			}
			return;
		}
		// 判断 7: 本文のリンクで別の文書を開くときも未保存の確認を通す(AC-74-48)
		if (!(await confirmDiscardEdits())) return;
		try {
			const doc = await invoke<DocumentPayload>('open_document', { uri: target });
			if (doc) windowState.setDocument(doc);
		} catch (err) {
			alert(openFileFailedMessage(err));
		}
	}

	function handleClickEvent(_view: EditorView, event: MouseEvent): boolean {
		const target = event.target as Element | null;
		const anchor = target?.closest?.('a');
		if (!anchor || !host?.contains(anchor)) return false;
		// Option + クリックは航行せずカーソルを置く(ProseMirror の既定に任せる)
		if (event.altKey) return false;
		const href = anchor.getAttribute('href');
		if (!href) return false;
		event.preventDefault();
		void navigate(href, event.shiftKey);
		return true;
	}

	// --- 貼り付け(契約17・項目 18) ------------------------------------------

	/**
	 * 第3段 3-5: 直前の文字の貼り付け(Markdown として読むと構造になるとき)。札「Paste as Markdown」を出し、押すと
	 * [from, to) を読み直す。次の取引(打鍵・選択の移動・外部変更)か Esc で消え、別の貼り付けで差し替わる。
	 */
	// --- 浮遊バー(第4段 4-3) -------------------------------------------------

	/** 面の根(浮遊バーの位置の基準)。 */
	let rootEl: HTMLDivElement | undefined = $state();
	/** 浮遊バーの要素(大きさを測る)。 */
	let barEl: HTMLElement | undefined = $state();
	let barShown = $state(false);
	let barPos = $state<{ left: number; top: number; placement: 'above' | 'below' }>({ left: 0, top: 0, placement: 'above' });
	let barTimer: ReturnType<typeof setTimeout> | undefined;
	/** マウスで選んでいる最中(mousedown〜mouseup)。離したときにすぐ出す。 */
	let mouseSelecting = false;
	/** 浮遊バーの項目を当てている最中(その取引ではバーを消さずに位置を直す)。 */
	let barCommand = false;

	function clearBarTimer() {
		if (barTimer) clearTimeout(barTimer);
		barTimer = undefined;
	}

	/** 出してよいか: 空でない文字の選択・変換中でない・書ける rendered の面。 */
	function canShowBar(): boolean {
		if (!view || readOnly || raw || composing || view.composing) return false;
		const sel = view.state.selection;
		return sel instanceof TextSelection && !sel.empty;
	}

	function hideBar() {
		clearBarTimer();
		barShown = false;
	}

	/** 位置を選択に合わせる(面の根からの相対)。 */
	function placeBar() {
		if (!view || !rootEl) return;
		const bounds = rootEl.getBoundingClientRect();
		const anchor = view.coordsAtPos(view.state.selection.from);
		const p = selectionBarPosition({
			anchor: { left: anchor.left, top: anchor.top, bottom: anchor.bottom },
			bar: { width: barEl?.offsetWidth ?? 0, height: barEl?.offsetHeight ?? 0 },
			bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
		});
		barPos = { left: p.left - bounds.left, top: p.top - bounds.top, placement: p.placement };
	}

	function showBarNow() {
		clearBarTimer();
		if (!canShowBar()) {
			barShown = false;
			return;
		}
		placeBar();
		barShown = true;
		// 大きさが分かってから置き直す(上に入るか・右にはみ出すか)
		void tick().then(() => {
			if (barShown) placeBar();
		});
	}

	/** 浮遊バーの項目: メニューと同じ経路(取引 1 つ・変換中は確定の後に 1 回)。 */
	function runBarItem(id: FormatItemId) {
		barCommand = true;
		try {
			runFormatCommand(id, handle);
		} finally {
			barCommand = false;
		}
	}

	/** 取引のたびに: 打鍵(文書の変更)で消す・キーボードの選択は落ち着くのを待って出す。 */
	function barAfterTransaction(tr: Transaction) {
		if (barCommand) {
			if (barShown) void tick().then(() => (canShowBar() ? placeBar() : hideBar()));
			return;
		}
		if (tr.docChanged) {
			hideBar();
			return;
		}
		if (!tr.selectionSet || mouseSelecting) return;
		hideBar();
		barTimer = setTimeout(showBarNow, SELECTION_BAR_SETTLE_MS);
	}

	/** 第4段 4-2: 取引のたびに進む数(handle.version)。 */
	let stateVersion = $state(0);
	let pasteOffer = $state<{ from: number; to: number; text: string } | null>(null);
	const PASTE_OFFER_META = 'vellisPasteOffer';

	/**
	 * 文字を今の選択に文字のまま入れる取引(貼り付けとドロップの共通=契約17)。表のセルは 1 行(AC-74-54): 改行(LF / CRLF / CR・
	 * 空行も)を空白 1 つにした 1 行の文字。ほかは空行で段落に分け、行の中の改行は soft break。
	 */
	function plainTextTransaction(state: EditorState, tr: Transaction, text: string): Transaction {
		if (inTableCell(state)) {
			const line = text.split(/\r\n|\r|\n/).filter((l) => l !== '').join(' ');
			return tr.insertText(line);
		}
		const paragraphs = plainTextParagraphs(text);
		if (paragraphs.length === 1) return tr.replaceSelection(new Slice(paragraphs[0]!.content, 0, 0));
		return tr.replaceSelection(new Slice(Fragment.fromArray(paragraphs), 1, 1));
	}

	function handlePaste(v: EditorView, event: ClipboardEvent): boolean {
		const data = event.clipboardData;
		if (!data) return false;
		const html = data.getData('text/html');
		// ProseMirror の切片(Vellis の編集面どうし)は既定のまま(構造が残る)
		if (html && html.includes('data-pm-slice')) return false;
		const text = data.getData('text/plain');
		if (!text) return false;
		if (v.state.selection.$from.parent.type.spec.code) return false;
		event.preventDefault();
		const cell = inTableCell(v.state);
		const from = v.state.selection.from;
		const tr = plainTextTransaction(v.state, v.state.tr, text);
		v.dispatch(tr.scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste').setMeta(PASTE_OFFER_META, true));
		// 第3段 3-5: 読むと構造になるなら札を出す(表のセル・読み取り専用では出さない)
		pasteOffer = !cell && !readOnly && shouldOfferMarkdownPaste(text) ? { from, to: v.state.selection.to, text } : null;
		return true;
	}

	/** 札を押した: 貼った範囲を Markdown として読み直す(取引 1 つ・undo の段は貼り付けと分ける)。 */
	function pasteAsMarkdown() {
		const offer = pasteOffer;
		pasteOffer = null;
		if (!view || !offer) return;
		const state = view.state;
		const nodes = parseMarkdownFragment(offer.text, state.doc);
		if (nodes.length === 0) return;
		const tr = state.tr;
		if (nodes.length === 1 && nodes[0]!.type.name === 'paragraph') {
			// 段落 1 つ=今の文字のブロックの中にインラインで(新しいブロックを作らない)
			tr.replaceWith(offer.from, offer.to, nodes[0]!.content);
		} else {
			tr.replaceRange(offer.from, offer.to, new Slice(Fragment.fromArray(nodes), 0, 0));
		}
		view.dispatch(closeHistory(tr).scrollIntoView().setMeta(PASTE_OFFER_META, true));
		view.focus();
	}

	/**
	 * 第3段 3-5: ドロップは貼り付けと同じ規則。外の文字(data-pm-slice の無い text/html・text/plain)は text/plain の文字で入れる
	 * (外の HTML を構造にしない)。同じ面の中の選択のドロップ(moved)と ProseMirror の切片は既定(移動=取引 1 つ)に任せる。
	 */
	function handleDrop(v: EditorView, event: DragEvent, _slice: Slice, moved: boolean): boolean {
		if (moved) return false;
		const data = event.dataTransfer;
		if (!data) return false;
		const html = data.getData('text/html');
		if (html && html.includes('data-pm-slice')) return false;
		const text = data.getData('text/plain');
		if (!text) return false;
		const at = v.posAtCoords({ left: event.clientX, top: event.clientY });
		if (!at) return false;
		const dropPos = v.state.doc.resolve(at.pos);
		if (dropPos.parent.type.spec.code) return false;
		event.preventDefault();
		const base = v.state.tr.setSelection(TextSelection.near(dropPos));
		const after = v.state.apply(base);
		const tr = plainTextTransaction(after, base, text);
		v.dispatch(tr.scrollIntoView().setMeta('uiEvent', 'drop'));
		return true;
	}

	// --- 表の行と列の頭の印(要件#74 Issue #832) -------------------------------

	/**
	 * 印と端の +(T1〜T7)。カーソルのあるセルとマウスを乗せたセル(td / th の要素)の行と列に、行の左端・列の上端の印と、
	 * 表の下端に行の +・右端に列の + を出す。部品は面の根の中・ProseMirror の外(文書の node は足さない)で、位置は表の
	 * 要素の矩形から面の根に対して置く。字は CSS(::before)で描き、textContent は空(書き出し・検索・コピーに出ない)。
	 * 読み取り専用と raw では出さない。
	 */
	type RowHandle = TableCellTarget & { key: string; top: number; left: number; height: number };
	type ColumnHandle = TableCellTarget & { key: string; top: number; left: number; width: number };
	type AppendHandle = TableCellTarget & { key: string; top: number; left: number; size: number };
	let tableHandles = $state<{ rows: RowHandle[]; columns: ColumnHandle[]; appendRows: AppendHandle[]; appendColumns: AppendHandle[] } | null>(
		null,
	);
	/** マウスを乗せているセルの要素(面の中の td / th)。 */
	let hoverCell: HTMLElement | null = null;

	/** 印の大きさ(px)。表の外側に置く幅。 */
	const HANDLE_SIZE = 14;
	const HANDLE_GAP = 2;

	function hoverTarget(): TableCellTarget | null {
		if (!view || !hoverCell) return null;
		if (!hoverCell.isConnected || !view.dom.contains(hoverCell)) {
			hoverCell = null;
			return null;
		}
		let pos: number;
		try {
			pos = view.posAtDOM(hoverCell, 0);
		} catch {
			return null;
		}
		return tableCellAt(view.state.doc, pos);
	}

	function cellElement(target: TableCellTarget): HTMLElement | null {
		if (!view) return null;
		const at = tableCellPos(view.state.doc, target);
		if (at === null) return null;
		const dom = view.nodeDOM(at);
		return dom instanceof HTMLElement ? dom : null;
	}

	/** 印と + を、今のカーソルとマウスから作り直す(取引のたび・マウスのセルが変わったとき・raw の切り替え)。 */
	function refreshTableHandles() {
		if (!view || readOnly || raw || !rootEl) {
			tableHandles = null;
			return;
		}
		const targets = [selectionTableCell(view.state), hoverTarget()].filter((t): t is TableCellTarget => t !== null);
		if (targets.length === 0) {
			tableHandles = null;
			return;
		}
		const base = rootEl.getBoundingClientRect();
		const rows: RowHandle[] = [];
		const columns: ColumnHandle[] = [];
		const appendRows: AppendHandle[] = [];
		const appendColumns: AppendHandle[] = [];
		const seen = new Set<string>();
		for (const t of targets) {
			const cell = cellElement(t);
			const table = cell?.closest('table');
			const tr = cell?.closest('tr');
			if (!cell || !table || !tr) continue;
			const tableNode = view.state.doc.nodeAt(t.tablePos)!;
			const tableRect = table.getBoundingClientRect();
			const rowKey = `r:${t.tablePos}:${t.row}`;
			if (!seen.has(rowKey)) {
				seen.add(rowKey);
				const r = tr.getBoundingClientRect();
				rows.push({ ...t, key: rowKey, top: r.top - base.top, left: tableRect.left - base.left - HANDLE_SIZE - HANDLE_GAP, height: r.height });
			}
			// 列の位置は見出しの行で数える(見出しより右の余分なセルには列の印を出さない)
			const colKey = `c:${t.tablePos}:${t.col}`;
			if (t.col < tableNode.child(0).childCount && !seen.has(colKey)) {
				seen.add(colKey);
				const head = cellElement({ tablePos: t.tablePos, row: 0, col: t.col }) ?? cell;
				const r = head.getBoundingClientRect();
				columns.push({ ...t, key: colKey, top: tableRect.top - base.top - HANDLE_SIZE - HANDLE_GAP, left: r.left - base.left, width: r.width });
			}
			const tableKey = `t:${t.tablePos}`;
			if (!seen.has(tableKey)) {
				seen.add(tableKey);
				appendRows.push({ ...t, key: tableKey, top: tableRect.bottom - base.top + HANDLE_GAP, left: tableRect.left - base.left, size: tableRect.width });
				appendColumns.push({ ...t, key: tableKey, top: tableRect.top - base.top, left: tableRect.right - base.left + HANDLE_GAP, size: tableRect.height });
			}
		}
		tableHandles = { rows, columns, appendRows, appendColumns };
	}

	/** マウスの下のセルが変わったら印を出し直す(印と + の上にいる間は今のセルのまま)。 */
	function onTableHover(event: MouseEvent) {
		if (!view) return;
		const target = event.target instanceof Element ? event.target : null;
		if (target?.closest('.table-handle')) return;
		const cell = target?.closest<HTMLElement>('td, th') ?? null;
		const next = cell && view.dom.contains(cell) ? cell : null;
		if (next === hoverCell) return;
		hoverCell = next;
		refreshTableHandles();
	}

	function onTableHoverLeave() {
		if (hoverCell === null) return;
		hoverCell = null;
		refreshTableHandles();
	}

	/** 印の行・列を対象に Command を 1 回(取引 1 つ)。表が無くなっていたら何もしない。 */
	function runTableHandleItem(id: string, target: TableCellTarget) {
		if (!view || readOnly || raw || view.composing) return;
		const command = (TABLE_HANDLE_COMMANDS as Record<string, Command>)[id] ?? (TABLE_COMMANDS as Record<string, Command>)[id];
		if (!command) return;
		commandAtCell(command, target)(view.state, view.dispatch, view);
		view.focus();
	}

	function openTableHandleMenu(kind: 'row' | 'column', target: TableCellTarget) {
		hideBar();
		const at = { tablePos: target.tablePos, row: target.row, col: target.col };
		void popupMenu(buildTableHandleMenu(kind), (id) => runTableHandleItem(id, at));
	}

	/** 印を押しても面のフォーカスと選択を動かさない。 */
	function keepEditorFocus(event: MouseEvent) {
		event.preventDefault();
	}

	// --- 組み立て ----------------------------------------------------------

	/** NodeView に渡す文脈(開いている code fence にテーマの切り替えを配る)。 */
	const nodeViewContext: NodeViewContext = {
		uri: untrack(() => uri),
		codeTheme: () => untrack(() => codeTheme),
		codeBlocks: new Set(),
	};

	// 面のテーマが変わったら、埋め込みの CodeMirror の配色を替える(契約5)
	$effect(() => {
		const name = codeTheme;
		untrack(() => applyCodeTheme(nodeViewContext, name));
	});

	onMount(() => {
		currentText = untrack(() => content);
		let unlistenRaw: (() => void) | null = null;
		let unlistenFocus: (() => void) | null = null;
		let disposed = false;
		// View ▸ Raw Source(lib.rs → 前面の窓)。Tauri の外では購読そのものが失敗してよい。
		void listen(MENU_RAW_SOURCE_EVENT, () => toggleRaw())
			.then((off) => {
				if (disposed) off();
				else unlistenRaw = off;
			})
			.catch(() => {});
		// 窓が前面になったら、その窓の raw を知らせ直す(チェック印は前面の窓の値=判断 9)
		void watchFocusForRawSource(() => raw).then((off) => {
			if (disposed) off();
			else unlistenFocus = off;
		});
		void announceRawSource(untrack(() => rawOnly));
		const cleanup = () => {
			disposed = true;
			unlistenRaw?.();
			unlistenFocus?.();
			void announceRawSource(false);
		};
		if (untrack(() => rawOnly)) {
			model = rawOnlyModel(untrack(() => content));
			windowState.fileEditor = handle;
			window.addEventListener('beforeprint', onBeforePrint);
			window.addEventListener('afterprint', onAfterPrint);
			return () => {
				cleanup();
				window.removeEventListener('beforeprint', onBeforePrint);
				window.removeEventListener('afterprint', onAfterPrint);
				if (noticeTimer) clearTimeout(noticeTimer);
				if (windowState.fileEditor === handle) windowState.fileEditor = null;
			};
		}
		model = withFacePlugins(createMarkdownDocument(untrack(() => content), { uri, readOnly }), facePlugins());
		view = new EditorView(host!, {
			state: model.state,
			editable: () => !readOnly,
			// 面の根にも markdown-body を持たせ、最上位のブロックが `.markdown-body > p` などの直下の子になるようにする
			// (markdown.css の本文の幅の規則がそのまま当たる=契約4。余白は下の CSS で外側の本文に任せる)。
			// 事後確認 (18): 編集面では自動の大文字化と自動修正を切る(spellcheck は既定のまま)
			attributes: { class: 'markdown-body', autocapitalize: 'off', autocorrect: 'off' },
			// 描画のまま直しにくいものの見せ方(契約7・17・項目 20・22〜25)
			nodeViews: createNodeViews(nodeViewContext),
			markViews: createMarkViews(),
			dispatchTransaction(tr: Transaction) {
				if (!view) return;
				// 第4段 4-2: 書式のツールバーが今の装飾を追う
				stateVersion++;
				// 第3段 3-5: 札は次の取引(打鍵・選択の移動・外部変更)で消える
				if (pasteOffer && !tr.getMeta(PASTE_OFFER_META) && (tr.docChanged || tr.selectionSet)) pasteOffer = null;
				const next: EditorState = view.state.apply(tr);
				view.updateState(next);
				// 第4段 4-3: 浮遊バー
				barAfterTransaction(tr);
				// #832: 表の行と列の頭の印(カーソルの行・列が変わる・表の形が変わる)
				refreshTableHandles();
				if (next.doc !== tr.before) {
					refreshFootnoteNumbers(view);
					recompute();
					onDocChange?.();
				}
			},
			clipboardTextSerializer: (slice) => slice.content.textBetween(0, slice.content.size, '\n\n', visibleLeafText),
			handlePaste,
			handleDrop,
			handleDOMEvents: {
				click: (v, event) => handleClickEvent(v, event as MouseEvent),
				// 第3段 3-5: Esc で貼り付けの札を消す(文書は変えない)
				keydown: (v, event) => {
					// 実機ゲート (1)・契約8 の例外: WKWebView は Command + B / I をメニューのアクセラレータに届けずに持っていくので、
					// 面の keydown で受けて既定の動作を止め、メニューと同じ命令へ(MARKDOWN_KEYMAP には入れない)
					const formatKey = commandFormatKey(event as KeyboardEvent);
					if (formatKey && (event as KeyboardEvent).isComposing) {
						// 由谷の決定 2026-11-20 21:40: 変換中は Format ▸ Bold / Italic と同じく控え、確定の後に 1 回だけ当てる。
						// 既定の動作は止めない(IME が受けて捨てる)。その場では当てない。面が変換中でなければ(確定の来ない
						// isComposing の鍵)控えも立てずに捨てる(差し戻し P2)
						if (composing || v.composing) deferFormatCommand(formatKey, handle);
						return false;
					}
					if (formatKey) {
						event.preventDefault();
						runFormatCommand(formatKey, handle);
						return true;
					}
					if (pasteOffer && (event as KeyboardEvent).key === 'Escape') pasteOffer = null;
					// 第4段 4-3: Esc で浮遊バーを消す(選択と文書は変えない)
					if (barShown && (event as KeyboardEvent).key === 'Escape') hideBar();
					return false;
				},
				// 第4段 4-3: マウスで選び終えたら浮遊バーをすぐ出す
				mousedown: () => {
					mouseSelecting = true;
					hideBar();
					return false;
				},
				mouseup: () => {
					mouseSelecting = false;
					showBarNow();
					return false;
				},
				// 契約11: Edit ▸ Undo(historyUndo)も入力規則の直後なら記号の文字に戻す(Command + Z と同じ結果)
				beforeinput: (v, event) => {
					if ((event as InputEvent).inputType !== 'historyUndo') return false;
					if (!undoMarkdownInputRule(v.state, v.dispatch)) return false;
					event.preventDefault();
					return true;
				},
				// 要件#74 第2段 2-6: 文字の上の右クリックはネイティブのメニュー(Option + 右クリック・読み取り専用は既定のまま)
				contextmenu: (_v, event) => {
					// 第4段 4-3: 右クリックのメニューを出している間は浮遊バーを消す
					hideBar();
					return handleEditorContextMenu(event as MouseEvent, { surface: 'markdown', uri, readOnly, handle });
				},
				compositionstart: () => {
					// 第4段 4-3: 変換中は浮遊バーを出さない
					hideBar();
					composing = true;
					onComposingChange?.(true);
					return false;
				},
				compositionend: () => {
					if (!composing) return false;
					composing = false;
					setTimeout(() => {
						onComposingChange?.(false);
						flushPending();
					}, 0);
					return false;
				},
				blur: () => {
					// WebKit は変換中の blur で compositionend を出さないことがある(契約10)=確定として扱い、控えた分を 1 回流す
					if (!composing) return false;
					composing = false;
					setTimeout(() => {
						onComposingChange?.(false);
						flushPending();
					}, 0);
					return false;
				},
			},
		});
		windowState.fileEditor = handle;
		window.addEventListener('beforeprint', onBeforePrint);
		window.addEventListener('afterprint', onAfterPrint);
		// 第4段 4-3: ペインのスクロールで浮遊バーの位置を写し直す
		const scroller = rootEl?.closest('article.viewer') ?? null;
		const onScroll = () => {
			if (barShown) placeBar();
		};
		scroller?.addEventListener('scroll', onScroll);
		// #832: マウスを乗せたセルの印・表の横のスクロールと窓の大きさで位置を置き直す
		const root = rootEl;
		const onLayout = () => {
			if (tableHandles) refreshTableHandles();
		};
		root?.addEventListener('mouseover', onTableHover);
		root?.addEventListener('mousemove', onTableHover);
		root?.addEventListener('mouseleave', onTableHoverLeave);
		root?.addEventListener('scroll', onLayout, true);
		window.addEventListener('resize', onLayout);
		return () => {
			root?.removeEventListener('mouseover', onTableHover);
			root?.removeEventListener('mousemove', onTableHover);
			root?.removeEventListener('mouseleave', onTableHoverLeave);
			root?.removeEventListener('scroll', onLayout, true);
			window.removeEventListener('resize', onLayout);
			scroller?.removeEventListener('scroll', onScroll);
			clearBarTimer();
			cleanup();
			window.removeEventListener('beforeprint', onBeforePrint);
			window.removeEventListener('afterprint', onAfterPrint);
			if (noticeTimer) clearTimeout(noticeTimer);
			if (windowState.fileEditor === handle) windowState.fileEditor = null;
			view?.destroy();
			view = null;
		};
	});
</script>

<div class="markdown-editor" data-testid="markdown-editor" bind:this={rootEl}>
	{#if barShown && !raw && !readOnly}
		<!-- 第4段 4-3: 浮遊バー(面の根の中・.ProseMirror の兄弟) -->
		<SelectionBar handle={handle} left={barPos.left} top={barPos.top} placement={barPos.placement} run={runBarItem} bind:el={barEl} />
	{/if}
	{#if tableHandles && !raw && !readOnly}
		<!-- #832: 表の行と列の頭の印・端の +(面の根の中・ProseMirror の外。字は CSS で描き textContent は空。
		     {#each} は間に空白を置かずに続ける=空白の文字のノードを .markdown-body の文字に足さない) -->{#each tableHandles.rows as h (h.key)}
			<button
				type="button"
				class="table-handle table-row-handle"
				data-testid="table-row-handle"
				data-row={h.row}
				aria-label="Row actions"
				style:top="{h.top}px"
				style:left="{h.left}px"
				style:height="{h.height}px"
				onmousedown={keepEditorFocus}
				onclick={() => openTableHandleMenu('row', h)}
			></button>
		{/each}{#each tableHandles.columns as h (h.key)}
			<button
				type="button"
				class="table-handle table-column-handle"
				data-testid="table-column-handle"
				data-col={h.col}
				aria-label="Column actions"
				style:top="{h.top}px"
				style:left="{h.left}px"
				style:width="{h.width}px"
				onmousedown={keepEditorFocus}
				onclick={() => openTableHandleMenu('column', h)}
			></button>
		{/each}{#each tableHandles.appendRows as h (h.key)}
			<button
				type="button"
				class="table-handle table-append-row"
				data-testid="table-append-row"
				aria-label="Add Row"
				style:top="{h.top}px"
				style:left="{h.left}px"
				style:width="{h.size}px"
				onmousedown={keepEditorFocus}
				onclick={() => runTableHandleItem('format-table-append-row', h)}
			></button>
		{/each}{#each tableHandles.appendColumns as h (h.key)}
			<button
				type="button"
				class="table-handle table-append-column"
				data-testid="table-append-column"
				aria-label="Add Column"
				style:top="{h.top}px"
				style:left="{h.left}px"
				style:height="{h.size}px"
				onmousedown={keepEditorFocus}
				onclick={() => runTableHandleItem('format-table-append-column', h)}
			></button>
		{/each}
	{/if}
	{#if pasteOffer}
		<!-- 第3段 3-5: 直前の貼り付けを Markdown として読み直す札(押すと構造に・Esc で消える) -->
		<button type="button" class="paste-as-markdown" data-testid={PASTE_AS_MARKDOWN_TESTID} onclick={pasteAsMarkdown}>
			{PASTE_AS_MARKDOWN_LABEL}
		</button>
	{/if}
	{#if linkEditor}
		<!-- 第4段 4-5(4-10): Link… の欄(モックの D)。Done / Enter で 1 取引・Esc で閉じる(文書は変えない)・Remove Link で外す。 -->
		<div class="link-editor" data-testid="link-editor" role="dialog" aria-label="Link">
			<label class="link-field">
				<span>Text</span>
				<input
					type="text"
					class="link-input"
					data-testid="link-text"
					aria-label="Text"
					spellcheck="false"
					autocapitalize="off"
					autocorrect="off"
					autocomplete="off"
					value={linkEditor.text}
					oninput={(e) => linkEditor && (linkEditor = { ...linkEditor, text: (e.currentTarget as HTMLInputElement).value })}
					onkeydown={onLinkKeydown}
				/>
			</label>
			<label class="link-field">
				<span>Link</span>
				<input
					type="url"
					class="link-input"
					data-testid="link-url"
					aria-label="Link"
					placeholder="https://"
					spellcheck="false"
					autocapitalize="off"
					autocorrect="off"
					autocomplete="off"
					value={linkEditor.url}
					bind:this={linkUrlEl}
					oninput={(e) => linkEditor && (linkEditor = { ...linkEditor, url: (e.currentTarget as HTMLInputElement).value })}
					onkeydown={onLinkKeydown}
				/>
			</label>
			<button type="button" class="link-button" data-testid="link-remove" disabled={!linkEditor.existing} onclick={removeLink}>
				Remove Link
			</button>
			<button type="button" class="link-button" data-testid="link-done" onclick={applyLink}>Done</button>
		</div>
	{/if}
	{#if raw}
		<!-- 契約23: raw(原文)の面。同じ場所で切り替わる(横並びではない)。 -->
		<RawSourceEditor
			bind:this={rawEditor}
			{uri}
			content={rawStart.text}
			selection={{ anchor: rawStart.anchor, head: rawStart.head }}
			{readOnly}
			{zoom}
			{codeTheme}
			{findQuery}
			{findCurrent}
			{onFindResults}
			onChange={onRawChange}
		/>
	{/if}
	<div class="markdown-editor-surface" bind:this={host}></div>
	{#if printHtml !== null}
		<div class="markdown-editor-print" data-testid="markdown-editor-print" bind:this={printEl}>
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			{@html printHtml}
		</div>
	{/if}
</div>

<style>
	.markdown-editor-surface :global(.ProseMirror) {
		/* gap cursor(絶対配置)の基準 */
		position: relative;
		outline: none;
		white-space: pre-wrap;
		word-wrap: break-word;
	}

	/*
	 * 面の根(class markdown-body)の余白は外側の `.markdown-body` が持つ(中央寄せの padding-left も外側)。
	 * 根で二重に掛けない。文字の大きさ・行間・書体はトークンの絶対値なので二重に掛かっても同じ値、
	 * ズーム(CSS zoom)は外側の inline style だけに掛かる。
	 */
	.markdown-editor-surface :global(.ProseMirror.markdown-body) {
		padding: 0;
	}

	/* 第4段 4-5: リンクの欄(オーバーレイの 1 段=要件56 のトークン) */
	.link-editor {
		position: sticky;
		top: 0;
		z-index: 16;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		padding: 6px 8px;
		margin-bottom: 4px;
		background-color: var(--color-bg-raised);
		box-shadow: var(--shadow-2);
		border-radius: var(--radius-md);
	}

	.link-field {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.link-button {
		font: inherit;
		font-size: var(--text-sm);
		padding: 2px 8px;
		border: 1px solid var(--color-border-strong);
		border-radius: 6px;
		background-color: var(--color-bg-raised);
		color: var(--color-text-primary);
		cursor: pointer;
	}

	.link-button:disabled {
		color: var(--color-text-muted);
		cursor: default;
	}

	.link-input {
		width: min(100%, 20rem);
		font: inherit;
		font-size: var(--text-sm);
		padding: 2px 6px;
		color: var(--color-text-primary);
		background-color: var(--color-bg-raised);
		border: 1px solid var(--color-border-strong);
		border-radius: 4px;
	}

	@media screen {
		.markdown-editor-print {
			display: none;
		}
	}

	@media print {
		.markdown-editor-surface {
			display: none;
		}

		/* 第4段 4-5: リンクの欄は刷らない(print.css は触らない) */
		.link-editor {
			display: none;
		}
	}

	/* 第3段 3-1: gap cursor(塊と塊の間・文書の端)の横線のカーソル。prosemirror-gapcursor の style/gapcursor.css と同じ形 */
	.markdown-editor-surface :global(.ProseMirror-gapcursor) {
		display: none;
		pointer-events: none;
		position: absolute;
	}

	.markdown-editor-surface :global(.ProseMirror-gapcursor::after) {
		content: '';
		display: block;
		position: absolute;
		top: -2px;
		width: 20px;
		border-top: 1px solid var(--color-text-primary);
		animation: markdown-gapcursor-blink 1.1s steps(2, start) infinite;
	}

	@keyframes markdown-gapcursor-blink {
		to {
			visibility: hidden;
		}
	}

	.markdown-editor-surface :global(.ProseMirror-focused .ProseMirror-gapcursor) {
		display: block;
	}

	/* 第3段 3-5: 貼り付けの札(面の右上に浮かぶ小さなボタン) */
	.paste-as-markdown {
		position: sticky;
		top: 0;
		float: right;
		z-index: 2;
		font: inherit;
		font-size: var(--text-sm);
		padding: 2px 8px;
		color: var(--color-text-primary);
		background-color: var(--color-bg-raised);
		border: 1px solid var(--color-border-strong);
		border-radius: 6px;
		box-shadow: var(--shadow-2);
		cursor: pointer;
	}

	/* 第3段 3-5: ドロップの位置の印(prosemirror-dropcursor の class) */
	:global(.vellis-dropcursor) {
		background-color: var(--color-accent);
	}

	/* #832: 表の行と列の頭の印・端の +(色はトークン=要件56。字は ::before で描き、文書の文字にしない) */
	.table-handle {
		position: absolute;
		z-index: 3;
		display: flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		margin: 0;
		padding: 0;
		font: inherit;
		font-size: var(--text-xs);
		line-height: 1;
		color: var(--color-text-muted);
		background-color: var(--color-bg-raised);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		cursor: pointer;
		user-select: none;
		-webkit-user-select: none;
		opacity: 0.85;
		transition: opacity var(--duration-fast) var(--ease-out);
	}

	.table-handle:hover,
	.table-handle:focus-visible {
		opacity: 1;
		color: var(--color-text-primary);
		background-color: var(--color-bg-hover);
		border-color: var(--color-border-strong);
	}

	.table-handle:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 1px;
	}

	.table-row-handle {
		width: 14px;
	}

	.table-row-handle::before {
		content: '⋮';
	}

	.table-column-handle {
		height: 14px;
	}

	.table-column-handle::before {
		content: '⋯';
	}

	.table-append-row {
		height: 14px;
	}

	.table-append-column {
		width: 14px;
	}

	.table-append-row::before,
	.table-append-column::before {
		content: '+';
	}

	@media print {
		.table-handle {
			display: none;
		}
	}

	/* 第4段 4-3: 浮遊バーの位置の基準 */
	.markdown-editor {
		position: relative;
	}
</style>
