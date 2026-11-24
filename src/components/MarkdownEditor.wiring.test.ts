/**
 * 要件#74 第2段 2-2 の受け入れテスト(docs/requirements/req-74.md)— Markdown の編集面(ProseMirror)と配線
 * (AC-74-8(配線の分)・10・11(第2段)・12(第2段)・13(第2段)・14(第2段)・18・19・20(第2段)・22・37・38(第2段)・48・49。
 *  契約 1・3・8・10〜14・16〜18。第2段の作り(案)の項目 1・8・11〜19・21。component プロジェクト・JSDOM に Viewer を載せる)
 *
 * ## 仮の前提(由谷の確認待ち。違えばこのファイルの該当の describe を捨てる)
 * - 2-1 の判断 1〜3(origin の表・エスケープの再試行・prosemirror-schema-list)
 * - 判断 5: `#見出し` のリンクは飛ばさない(今の閲覧と同じ。`#…` はその id を持つ要素があるときだけ)→ describe「航行」
 * - 判断 7: 本文のリンクで別の `.md` を開くときも未保存の確認を出す(AC-74-48)→ describe「AC-74-48」
 * - 判断 8: 閾値 2 MiB(`MARKDOWN_EDIT_LIMIT_BYTES`)→ describe「AC-74-22」
 * - 受け入れ基準「第2段」の書き直し案: AC-74-10(埋め込みの CodeMirror の `.cm-content` は除く=2-4 まで無い)・AC-74-18(`findMatches(容器の
 *   textContent, 語)`)・AC-74-22(閾値の値)・AC-74-48・AC-74-49
 *
 * ## 確定契約(implementer はこれに従う=推奨名は req-74.md 第2段の作り(案)1・8・11〜19・21。無いものは test-writer が固定)
 *
 * ```ts
 * // --- src/components/MarkdownEditor.svelte(新規)
 * // 根: <div class="markdown-editor" data-testid="markdown-editor"> を `.markdown-body` の直下に。中に ProseMirror の EditorView
 * //   (`.ProseMirror[contenteditable="true"]`=`view.dom`)。今の描画と同じ CSS(markdown.css)で描く
 * // 印刷: window の beforeprint で <div data-testid="markdown-editor-print"> に `render(markdownText(doc), uri, { codeTheme })`(今の描画)
 * //   を入れ、afterprint で消す
 * // mount で windowState.fileEditor = handle(MarkdownEditorHandle)・unmount で null
 * // 変換中(view.composing)は外部変更・Format・検索の塗り替えを待ち、compositionend の後に 1 回だけ当てる
 * // 貼り付け: text/html に data-pm-slice が無ければ text/plain を空行で段落に分けて文字として入れる(Markdown として読まない)
 * // コピー: clipboardTextSerializer=見えている文字(soft_break は空白・hard_break は改行)。text/html は ProseMirror の既定
 * // 航行(plugin の handleClick): リンクの mark のクリック=外部 URL → openUrl(`@tauri-apps/plugin-opener`)・相対の `.md` → 未保存の確認
 * //   (`confirmDiscardEdits`)→ `open_document` → windowState.setDocument・`#…` → id を持つ要素があれば運ぶ、無ければ何もしない。
 * //   クリックで文書は変わらない・選択も動かさない。Option(altKey)+クリックは航行せずカーソルを置く
 *
 * // --- src/components/Viewer.svelte
 * // fileEditor が真で種別 markdown: (a) SSH root(canEnterEdit が偽)→ 今の描画 {@html html}(contenteditable なし・handle 登録なし)
 * //   (b) markdownTooLarge(document.content) → 今の描画+<div data-testid="markdown-too-large-notice" role="status">
 * //       This file is too large to edit in Vellis. Use View ▸ Raw Source to edit it.</div>(handle 登録なし)
 * //   (c) それ以外 → <MarkdownEditor>。Command + E(windowState.beginEdit)とダブルクリックで今の編集に入らない
 * //   ズームは `.markdown-body` の CSS zoom のまま(面は .markdown-body の中)。検索は `.markdown-body` の textContent に findMatches
 * //   Unsaved の札・重なりの帯・知らせ・削除の帯は第1段と同じ testid
 *
 * // --- src/editor/file-editor.ts に足す
 * export interface FileEditorHandle { kind?: 'text' | 'markdown'; … (第1段のまま) }
 * export interface MarkdownEditorHandle extends FileEditorHandle { kind: 'markdown'; readonly view: EditorView; readonly raw: boolean;
 *   /** 今の文書モデル(state・origin・generation・base)。serializeMarkdown の段を外から見る口(reviewer の照合 U7 で足した)。 *\/
 *   model(): MarkdownDocument }
 * //   raw は 2-3 まで常に false
 *
 * // --- 面の入力欄とダイアログ(契約8・項目 7・11。reviewer の照合で足した)
 * // Link…(runFormatCommand('format-link') が false を返した=リンクの外): 選択が空ならカーソルの単語(前後どちらも \p{L}\p{N}_)を範囲にし、
 * //   単語の上でもなければ何もしない(V19)。範囲があれば面の根の中に <input data-testid="link-input"> を出す。URL を打って Enter → 選んだ範囲に link の mark(取引 1 つ=undo 1 段)・欄が閉じる。
 * //   Esc → 閉じて文書は不変。選んだ文字が URL なら欄にその URL が入っていて(か、欄を出さずに)Enter でその URL が href になる
 * // Image…(runFormatCommand('format-insert-image') が false を返した): `@tauri-apps/plugin-dialog` の open() でファイルを選び、
 * //   文書(uri)からの相対パス(フォルダの外は `../`・`/` 区切り)を src に、ファイル名から拡張子を除いたものを alt にした image を
 * //   カーソルに入れる(取引 1 つ)。取り消し(null)なら何もしない(V6・V18)
 * // Link… の文言と URL が同じなら link の kind は literal=書き出しは素の URL のまま(`[url](url)` にしない)(V3)
 *
 * // --- src/stores/window-state.svelte.ts に足す(項目 1 (a)(b)=読み取り専用の描画のとき今の編集に入らない)
 * editBlocked: boolean   // $state・既定 false。Viewer が fileEditor の markdown の読み取り専用の描画(SSH・閾値超え)を出している間は true
 * beginEdit(): fileEditor が登録されているか editBlocked が真なら false(今の編集に入らない)
 * ```
 *
 * ## 判断の記録(test-writer 2026-11-17)
 * - 打鍵は `view.dispatch(tr.insertText)`。undo のキーは contentDOM(`view.dom`)への keydown で、jsdom では Mod=Ctrl(周回0 の実測)。
 *   `beforeinput` の historyUndo も当てる(prosemirror-history が受ける=周回0)
 * - 変換中は `view.dom` に `compositionstart` を送る(周回0: `view.composing` が真になる)
 * - 外部変更の到着は `windowState.applyFileChanged(payload)`(第1段と同じ)
 * - 文書の文字列は `handle.text()`(=markdownText)。ProseMirror の文書は `handle.view.state.doc`
 *
 * ## 修正前に赤になる理由
 * - `./MarkdownEditor.svelte`・`../editor/commands` ほかが無く、`prosemirror-*` も依存に無いので import で落ちる
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { TextSelection } from 'prosemirror-state';
import { undoDepth } from 'prosemirror-history';
import type { EditorView } from 'prosemirror-view';

import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import { contentHash } from '$lib/document-edit';
import { findMatches, formatCount } from '$lib/find-in-document';
import { createFileReloader } from '$lib/reload-file';
import { MERGED_NOTICE, saveFileEditor, type MarkdownEditorHandle } from '../editor/file-editor';
import { runFormatCommand } from '../editor/commands';
import { MARKDOWN_EDIT_LIMIT_BYTES } from '../editor/markdown-limits';
import { blockPos, textSpots } from '../editor/markdown.testkit';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
	openUrl: vi.fn(async () => undefined),
	openPath: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), message: vi.fn(), open: vi.fn() }));
vi.mock('$lib/mermaid-mounter', () => ({
	mountMermaid: vi.fn(async () => undefined),
}));
vi.mock('$lib/events', () => {
	const handlers = new Map<string, Array<(e: { payload: unknown }) => void>>();
	return {
		listen: async (event: string, handler: (e: { payload: unknown }) => void) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {
				const cur = handlers.get(event) ?? [];
				const at = cur.indexOf(handler);
				if (at >= 0) cur.splice(at, 1);
			};
		},
		__eventHandlers: handlers,
	};
});

import { message, open as openDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { serializeMarkdown, shapeEqual } from '../editor/to-markdown';
import { parseMarkdownDocument } from '../editor/from-mdast';
import { invoke } from '$lib/ipc';
import { confirmDiscardEdits } from '$lib/edit-guard';
import * as eventsModule from '$lib/events';

const messageMock = vi.mocked(message);
const openDialogMock = vi.mocked(openDialog);
const openUrlMock = vi.mocked(openUrl);
const invokeMock = vi.mocked(invoke);
const alertMock = vi.fn((_m?: unknown) => {});
const menuHandlers = (eventsModule as unknown as { __eventHandlers: Map<string, Array<(e: { payload: unknown }) => void>> }).__eventHandlers;

// ---------------------------------------------------------------------------
// JSDOM の polyfill(ProseMirror の計測が落ちないように)
// ---------------------------------------------------------------------------

beforeAll(() => {
	const zeroRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
	const emptyRects = () => Object.assign([] as DOMRect[], { item: (_i: number) => null }) as unknown as DOMRectList;
	const rangeProto = Range.prototype as unknown as Record<string, unknown>;
	if (typeof rangeProto.getClientRects !== 'function') rangeProto.getClientRects = emptyRects;
	if (typeof rangeProto.getBoundingClientRect !== 'function') rangeProto.getBoundingClientRect = zeroRect;
	if (typeof (document as unknown as Record<string, unknown>).elementFromPoint !== 'function') {
		(document as unknown as Record<string, unknown>).elementFromPoint = () => null;
	}
});

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const MD_URI = 'file:///Users/a/notes/plan.md';
const SSH_URI = 'ssh://host/srv/notes/plan.md';
const MD = ['# Plan', '', 'Intro paragraph with **bold** word.', '', 'Second paragraph here.', '', '- item one', '- item two', '', 'Tail paragraph.', ''].join('\n');
const LINKS = ['See [docs](./other.md) and [site](https://example.com/x) and [top](#plan).', '', '# Plan', ''].join('\n');

function doc(uri: string, content: string): DocumentPayload {
	return { uri, content, modified: 1 };
}

let renderedCache = new Map<string, { html: string; index: SourceIndex }>();
async function rendered(content: string, uri = MD_URI) {
	const key = `${uri}\n${content}`;
	let r = renderedCache.get(key);
	if (!r) {
		const result = await renderMarkdown(content, uri);
		r = { html: result.html, index: result.index };
		renderedCache.set(key, r);
	}
	return r;
}

type ViewerProps = { fileEditor?: boolean; zoom?: number; codeTheme?: string };
function baseProps(d: DocumentPayload, html: string, index: SourceIndex | null, extra: ViewerProps) {
	return { document: d, html, index, onRequestAddMark: vi.fn(), onToggleMarks: vi.fn(), marksOpen: false, ...extra };
}

async function settle(rounds = 8) {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
	await tick();
}
async function settleLong() {
	await settle();
	await new Promise((r) => setTimeout(r, 0));
	await settle();
}

/** Markdown の文書を windowState と Viewer に載せ、fileEditor=true で描く(ページと同じく今の描画の html も渡す)。 */
async function mountMd(content: string, extra: ViewerProps = {}, uri = MD_URI) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const r = await rendered(content, uri);
	const result = render(Viewer, { props: baseProps(d, r.html, r.index, { fileEditor: true, ...extra }) });
	await settleLong();
	return result;
}

const FACE = 'article.viewer .markdown-body [data-testid="markdown-editor"]';
const PM = `${FACE} .ProseMirror`;
const BADGE = '[data-testid="unsaved-badge"]';
const CONFLICT = '[data-testid="external-conflict-banner"]';
const MERGED = '[data-testid="external-merged-notice"]';
const REMOVED = '[data-testid="external-removed-banner"]';
const TOO_LARGE = '[data-testid="markdown-too-large-notice"]';
const PRINT = '[data-testid="markdown-editor-print"]';

function q(container: ParentNode, selector: string): HTMLElement | null {
	return container.querySelector(selector);
}
function handle(): MarkdownEditorHandle {
	const h = windowState.fileEditor as MarkdownEditorHandle | null;
	if (!h) throw new Error('windowState.fileEditor が登録されていない');
	if (h.kind !== 'markdown') throw new Error(`handle.kind が markdown でない: ${String(h.kind)}`);
	return h;
}
function view(): EditorView {
	return handle().view;
}
function text(): string {
	return handle().text();
}
/** 最上位ブロック `block` の最初の code でない text に `s` を打つ(col 文字目)。 */
function type(s: string, block: number, col = 0) {
	const v = view();
	const spot = textSpots(v.state.doc, block).find((t) => !t.inCode)!;
	v.dispatch(v.state.tr.insertText(s, spot.pos + col));
}
function selectRange(from: number, to: number) {
	const v = view();
	v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from, to)));
}
function key(k: string, init: KeyboardEventInit = {}) {
	view().dom.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
}
function beforeInput(inputType: string) {
	view().dom.dispatchEvent(new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true }));
}
function composition(kind: 'compositionstart' | 'compositionend') {
	view().dom.dispatchEvent(new CompositionEvent(kind, { bubbles: true, data: '' }));
}
async function emitMenuFind() {
	await settle();
	const list = [...(menuHandlers.get('menu_find') ?? [])];
	expect(list.length, "Viewer が 'menu_find' を購読していること").toBeGreaterThan(0);
	for (const h of list) h({ payload: undefined });
	await settle();
}
async function typeQuery(container: ParentNode, value: string) {
	const input = q(container, '[data-testid="find-input"]') as HTMLInputElement | null;
	expect(input, '検索バーの入力欄').toBeTruthy();
	await fireEvent.input(input!, { target: { value } });
	await settleLong();
	await new Promise((r) => setTimeout(r, 200));
	await settle();
}
function countText(container: ParentNode): string {
	return (q(container, '[data-testid="find-count"]')?.textContent ?? '').trim();
}
function clipboard(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	return {
		data,
		api: {
			setData: (t: string, v: string) => void data.set(t, v),
			getData: (t: string) => data.get(t) ?? '',
			clearData: () => data.clear(),
			types: [...data.keys()],
		},
	};
}

beforeEach(() => {
	vi.stubGlobal('alert', alertMock);
	invokeMock.mockReset();
	invokeMock.mockResolvedValue(null);
	messageMock.mockReset();
	openUrlMock.mockReset();
	alertMock.mockReset();
	menuHandlers.clear();
	windowState.clearDocument();
});
afterEach(() => {
	cleanup();
	windowState.clearDocument();
	vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// AC-74-10 / 38 / 22 — 単一の面・読み取り専用・閾値
// ---------------------------------------------------------------------------

describe('AC-74-10: Markdown を開いた直後から文書全体が 1 つの ProseMirror の面', () => {
	it('fileEditor が真で markdown: .markdown-body の中に ProseMirror の編集面があり、contenteditable はその根だけ。ソースの UI は無い', async () => {
		const { container } = await mountMd(MD);
		expect(q(container, PM)).not.toBeNull();
		const editables = [...container.querySelectorAll('[contenteditable="true"]')];
		expect(editables).toHaveLength(1);
		expect(editables[0]!.classList.contains('ProseMirror')).toBe(true);
		expect(q(container, 'pre[contenteditable]')).toBeNull();
		expect(q(container, '[data-testid="edit-source"]')).toBeNull();
		expect(q(container, '[data-testid="edit-done"]')).toBeNull();
		expect(q(container, '.cm-editor')).toBeNull();
		expect(windowState.dirty).toBe(false);
		// 文書全体が 1 つの文書: 見出し・段落・リストが同じ view.state.doc に。
		const names: string[] = [];
		view().state.doc.forEach((c) => names.push(c.type.name));
		expect(names).toEqual(['heading', 'paragraph', 'paragraph', 'bullet_list', 'paragraph']);
		expect(q(container, `${PM} h1`)?.textContent).toBe('Plan');
	});

	it('handle は kind=markdown・uri・readOnly 偽・dirty 偽・expectedHash=contentHash(原文)・text()=原文', async () => {
		await mountMd(MD);
		const h = handle();
		expect(h.uri).toBe(MD_URI);
		expect(h.readOnly).toBe(false);
		expect(h.dirty).toBe(false);
		expect(h.raw).toBe(false);
		expect(h.text()).toBe(MD);
		expect(h.expectedHash()).toBe(contentHash(MD));
		expect(undoDepth(h.view.state)).toBe(0);
	});

	it('ブロックをまたぐ選択で削除・mark の付与ができる', async () => {
		await mountMd(MD);
		const v = view();
		const p1 = textSpots(v.state.doc, 1)[0]!; // 'Intro paragraph with '
		const p2 = textSpots(v.state.doc, 2)[0]!; // 'Second paragraph here.'
		v.dispatch(v.state.tr.addMark(p1.pos + 6, p2.pos + 6, v.state.schema.marks.strong!.create()));
		expect(text()).toContain('**');
		// `Intro ` の後ろから `Second ` の後ろ(空白の次)まで消す= `Intro ` + `paragraph here.`(原文の空白は詰めない)。
		v.dispatch(v.state.tr.delete(p1.pos + 6, p2.pos + 7));
		expect(v.state.doc.childCount).toBe(4);
		expect(text()).toContain('Intro paragraph here.');
	});

	it('ダブルクリックで今の編集に入らない(撤去の後は store に beginEdit も editMode も無い)', async () => {
		const { container } = await mountMd(MD);
		await fireEvent.dblClick(q(container, '.markdown-body p')!);
		await settleLong();
		expect(container.querySelectorAll('[contenteditable="true"]')).toHaveLength(1);
		expect(q(container, 'pre[contenteditable]')).toBeNull();
		expect('beginEdit' in windowState).toBe(false);
		expect('editMode' in windowState).toBe(false);
		expect(handle().dirty).toBe(false);
	});

	// 要件74 第2段 2-5(2026-11-17 仮・契約21・AC-74-46): フラグと prop `fileEditor` は撤去。偽でも渡さなくても常に ProseMirror の面。
	it('fileEditor を渡さなくても(偽を渡しても)ProseMirror の面と handle が出る', async () => {
		for (const extra of [{}, { fileEditor: false }]) {
			cleanup();
			const d = doc(MD_URI, MD);
			windowState.setDocument(d);
			const r = await rendered(MD);
			const { container } = render(Viewer, { props: baseProps(d, r.html, r.index, extra) });
			await settleLong();
			expect(q(container, PM), JSON.stringify(extra)).not.toBeNull();
			expect(windowState.fileEditor).not.toBeNull();
		}
	});
});

describe('AC-74-38: SSH root の Markdown は今の描画(contenteditable 無し)で開く', () => {
	it('面も handle も無く、Format・打鍵で変わらない', async () => {
		const { container } = await mountMd(MD, {}, SSH_URI);
		expect(q(container, PM)).toBeNull();
		expect(container.querySelectorAll('[contenteditable="true"]')).toHaveLength(0);
		expect(windowState.fileEditor).toBeNull();
		expect(q(container, '.markdown-body h1')?.textContent).toContain('Plan');
		expect(runFormatCommand('format-bold', windowState.fileEditor)).toBe(false);
		expect(windowState.dirty).toBe(false);
	});
});

describe('AC-74-22(判断 8): 閾値を超えた Markdown は今の描画+知らせ、ちょうど 2 MiB は編集面', () => {
	it('2 MiB + 1 byte → 今の描画・markdown-too-large-notice・handle なし', async () => {
		const big = `# Big\n\n${'a'.repeat(MARKDOWN_EDIT_LIMIT_BYTES - 6)}\n`;
		expect(new TextEncoder().encode(big).length).toBeGreaterThan(MARKDOWN_EDIT_LIMIT_BYTES);
		const d = doc(MD_URI, big);
		windowState.setDocument(d);
		const { container } = render(Viewer, { props: baseProps(d, '<h1>Big</h1><p>…</p>', null, { fileEditor: true }) });
		await settleLong();
		expect(q(container, PM)).toBeNull();
		expect(container.querySelectorAll('[contenteditable="true"]')).toHaveLength(0);
		expect(windowState.fileEditor).toBeNull();
		const notice = q(container, TOO_LARGE);
		expect(notice).not.toBeNull();
		expect(notice!.textContent?.trim()).toBe('This file is too large to edit in Vellis. Use View ▸ Raw Source to edit it.');
		expect(notice!.getAttribute('role')).toBe('status');
	});

	it('ちょうど 2 MiB → 編集面・知らせなし', async () => {
		const head = '# Big\n\n';
		const exact = head + 'a'.repeat(MARKDOWN_EDIT_LIMIT_BYTES - head.length - 1) + '\n';
		expect(new TextEncoder().encode(exact).length).toBe(MARKDOWN_EDIT_LIMIT_BYTES);
		const d = doc(MD_URI, exact);
		windowState.setDocument(d);
		const { container } = render(Viewer, { props: baseProps(d, '<h1>Big</h1>', null, { fileEditor: true }) });
		await settleLong();
		await new Promise((r) => setTimeout(r, 50));
		expect(q(container, PM)).not.toBeNull();
		expect(q(container, TOO_LARGE)).toBeNull();
		expect(windowState.fileEditor).not.toBeNull();
	}, 60_000);
});

// ---------------------------------------------------------------------------
// 契約3 / AC-74-11 — dirty・札・undo / redo
// ---------------------------------------------------------------------------

describe('契約3・AC-74-11: dirty は文字列の比較。undo / redo はキーと beforeinput で', () => {
	it('打つと dirty・Unsaved の札。消すと戻る。書き出しは打った文字だけ違う(2 段目)', async () => {
		const { container } = await mountMd(MD);
		type('X', 2, 6);
		await settle();
		expect(handle().dirty).toBe(true);
		expect(windowState.dirty).toBe(true);
		expect(q(container, BADGE)?.textContent?.trim()).toBe('Unsaved');
		expect(text()).toBe(MD.replace('Second paragraph', 'SecondX paragraph'));
		const v = view();
		const spot = textSpots(v.state.doc, 2)[0]!;
		v.dispatch(v.state.tr.delete(spot.pos + 6, spot.pos + 7));
		await settle();
		expect(handle().dirty).toBe(false);
		expect(q(container, BADGE)).toBeNull();
		expect(text()).toBe(MD);
	});

	it('Ctrl+Z(jsdom の Mod)で undo・Ctrl+Shift+Z で redo。すべて undo すると書き出しが原文', async () => {
		await mountMd(MD);
		type('A', 2, 0);
		await new Promise((r) => setTimeout(r, 600));
		type('B', 4, 0);
		expect(text()).not.toBe(MD);
		key('z', { ctrlKey: true });
		await settle();
		expect(text()).toBe(MD.replace('Second', 'ASecond'));
		key('z', { ctrlKey: true, shiftKey: true });
		await settle();
		expect(text()).toBe(MD.replace('Second', 'ASecond').replace('Tail', 'BTail'));
		for (let i = 0; i < 6 && undoDepth(view().state) > 0; i++) {
			key('z', { ctrlKey: true });
			await settle();
		}
		expect(text()).toBe(MD);
		expect(handle().dirty).toBe(false);
	});

	it('beforeinput の historyUndo / historyRedo(Edit ▸ Undo / Redo の経路)', async () => {
		await mountMd(MD);
		type('Q', 2, 0);
		beforeInput('historyUndo');
		await settle();
		expect(text()).toBe(MD);
		beforeInput('historyRedo');
		await settle();
		expect(text()).toBe(MD.replace('Second', 'QSecond'));
	});

	it('装飾のコマンド(runFormatCommand)1 回は undo 1 回で戻る', async () => {
		await mountMd(MD);
		const v = view();
		const spot = textSpots(v.state.doc, 2)[0]!;
		selectRange(spot.pos, spot.pos + 6);
		const depth = undoDepth(v.state);
		expect(runFormatCommand('format-bold', handle())).toBe(true);
		await settle();
		expect(text()).toBe(MD.replace('Second paragraph', '**Second** paragraph'));
		expect(undoDepth(view().state)).toBe(depth + 1);
		key('z', { ctrlKey: true });
		await settle();
		expect(text()).toBe(MD);
	});

	it('Esc では確認が出ず面から出ない', async () => {
		const { container } = await mountMd(MD);
		type('X', 2, 0);
		key('Escape');
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await settle();
		expect(messageMock).not.toHaveBeenCalled();
		expect(q(container, PM)).not.toBeNull();
		expect(text()).toContain('XSecond');
	});
});

// ---------------------------------------------------------------------------
// AC-74-8 — Format の配線
// ---------------------------------------------------------------------------

describe('AC-74-8: Format は Markdown の編集面に当たり、ほかでは何も変わらない', () => {
	it('Markdown の面: Heading 2 が当たる(取引 1 つ)', async () => {
		await mountMd(MD);
		const v = view();
		const spot = textSpots(v.state.doc, 2)[0]!;
		selectRange(spot.pos + 1, spot.pos + 1);
		expect(runFormatCommand('format-heading-2', handle())).toBe(true);
		expect(text()).toBe(MD.replace('Second paragraph here.', '## Second paragraph here.'));
	});

	it('変換中に届いた Format は当たらず、compositionend の後に 1 回だけ当たる(契約10)', async () => {
		await mountMd(MD);
		const v = view();
		const spot = textSpots(v.state.doc, 2)[0]!;
		selectRange(spot.pos, spot.pos + 6);
		composition('compositionstart');
		await settle();
		expect(v.composing).toBe(true);
		expect(runFormatCommand('format-bold', handle())).toBe(false);
		expect(runFormatCommand('format-bold', handle())).toBe(false);
		expect(text(), '変換中は当たらない').toBe(MD);
		composition('compositionend');
		await settleLong();
		await new Promise((r) => setTimeout(r, 50));
		expect(text(), '確定後に 1 回だけ(2 回押しても 1 回=トグルが戻らない)').toBe(MD.replace('Second paragraph', '**Second** paragraph'));
	});
});

// ---------------------------------------------------------------------------
// AC-74-12 / 13 / 14 — IME・外部変更
// ---------------------------------------------------------------------------

describe('AC-74-13: dirty でない面に file_changed が届く', () => {
	it('届いた内容を読み直したものが文書になり、変わっていないブロックの Node は同一、dirty でなく帯が無い、選択が写される', async () => {
		const { container } = await mountMd(MD);
		const v = view();
		const before = v.state.doc;
		const line = textSpots(before, 4)[0]!; // Tail paragraph
		selectRange(line.pos + 2, line.pos + 2);
		const incoming = MD.replace('Second paragraph here.', 'Second paragraph CHANGED here.');
		expect(windowState.applyFileChanged(doc(MD_URI, incoming))).toBe('apply');
		await settle();
		expect(text()).toBe(incoming);
		expect(handle().dirty).toBe(false);
		expect(handle().expectedHash()).toBe(contentHash(incoming));
		expect(q(container, CONFLICT)).toBeNull();
		expect(q(container, MERGED)).toBeNull();
		expect(q(container, '[data-testid="external-change-banner"]')).toBeNull();
		const after = view().state.doc;
		expect(after.child(0), 'heading identical').toBe(before.child(0));
		expect(after.child(1), 'first paragraph identical').toBe(before.child(1));
		expect(after.child(3), 'list identical').toBe(before.child(3));
		expect(after.child(4), 'tail identical').toBe(before.child(4));
		expect(after.child(2), 'changed paragraph replaced').not.toBe(before.child(2));
		// 選択(変わったブロックの後ろ)は差分の長さだけずれて同じ文字の前に。
		const $head = view().state.selection.$head;
		expect($head.parent.textContent).toBe('Tail paragraph.');
		expect($head.parentOffset).toBe(2);
	});

	it('自分の保存のエコーでは何も起きない(取引なし)', async () => {
		await mountMd(MD);
		type('x', 2, 0);
		const saved = text();
		await saveFileEditor(handle());
		expect(invokeMock).toHaveBeenCalledWith('save_document', { uri: MD_URI, content: saved, expectedHash: contentHash(MD) });
		const stateBefore = view().state;
		expect(windowState.applyFileChanged(doc(MD_URI, saved))).toBe('ignore-echo');
		await settle();
		expect(view().state).toBe(stateBefore);
	});

	it('基準の版と同じ内容が続けて届いても取引なし(周回0 の 0-6)', async () => {
		await mountMd(MD);
		const stateBefore = view().state;
		expect(windowState.applyFileChanged(doc(MD_URI, MD))).toBe('ignore-echo');
		await settle();
		expect(view().state).toBe(stateBefore);
	});
});

describe('AC-74-14(第2段): dirty の面に外部変更が届く(3 方向マージ=行の単位・第1段の merge3)', () => {
	it('重ならなければマージして知らせ、触っていたブロックの Node は同一、undo の段数は変わらない', async () => {
		const { container } = await mountMd(MD);
		type('MINE ', 1, 0);
		const mineNode = view().state.doc.child(1);
		const depth = undoDepth(view().state);
		const incoming = MD.replace('Tail paragraph.', 'Tail paragraph THEIRS.');
		expect(windowState.applyFileChanged(doc(MD_URI, incoming))).toBe('apply');
		await settle();
		expect(text()).toBe(incoming.replace('Intro paragraph', 'MINE Intro paragraph'));
		expect(handle().dirty).toBe(true);
		expect(view().state.doc.child(1), '触っていたブロックの Node は同一').toBe(mineNode);
		expect(undoDepth(view().state)).toBe(depth);
		const notice = q(container, MERGED);
		expect(notice?.textContent?.trim()).toBe(MERGED_NOTICE);
		expect(q(container, CONFLICT)).toBeNull();
		expect(handle().expectedHash()).toBe(contentHash(incoming));
		key('z', { ctrlKey: true });
		await settle();
		expect(text(), 'undo で自分の分だけ戻り、届いた分は残る').toBe(incoming);
	});

	it('重なると帯が出て選ぶまで変わらない。Keep My Edits / Use the File on Disk', async () => {
		const { container } = await mountMd(MD);
		type('MINE ', 2, 0);
		const mine = text();
		const incoming = MD.replace('Second paragraph here.', 'THEIRS paragraph here.');
		expect(windowState.applyFileChanged(doc(MD_URI, incoming))).toBe('external-conflict');
		await settle();
		expect(text()).toBe(mine);
		expect(handle().conflict).toBe(true);
		expect(q(container, CONFLICT)).not.toBeNull();
		await fireEvent.click(q(container, '[data-testid="external-conflict-keep"]')!);
		await settle();
		expect(text()).toBe(mine);
		expect(handle().expectedHash()).toBe(contentHash(incoming));
		expect(q(container, CONFLICT)).toBeNull();
		// もう一度重ねて、今度はディスクを採る。
		const incoming2 = incoming.replace('THEIRS', 'THEIRS2');
		expect(windowState.applyFileChanged(doc(MD_URI, incoming2))).toBe('external-conflict');
		await settle();
		await fireEvent.click(q(container, '[data-testid="external-conflict-disk"]')!);
		await settleLong();
		expect(text()).toBe(incoming2);
		expect(handle().dirty).toBe(false);
	});

	it('file_removed: dirty なら文書が残り帯が出る。Save は expectedHash なしで同じ URI に書く', async () => {
		const { container } = await mountMd(MD);
		type('x', 2, 0);
		const mine = text();
		expect(windowState.applyFileRemoved(MD_URI)).toBe('keep');
		await settle();
		expect(q(container, REMOVED)).not.toBeNull();
		expect(text()).toBe(mine);
		await fireEvent.click(q(container, '[data-testid="external-removed-save"]')!);
		await settleLong();
		expect(invokeMock.mock.calls).toEqual([['save_document', { uri: MD_URI, content: mine }]]);
		expect(handle().dirty).toBe(false);
		expect(q(container, REMOVED)).toBeNull();
	});
});

describe('AC-74-12(第2段): 変換中に届いた外部変更と検索の語の変更は compositionend の後に 1 回だけ', () => {
	it('file_changed', async () => {
		await mountMd(MD);
		composition('compositionstart');
		await settle();
		expect(view().composing).toBe(true);
		const incoming = MD + '\nMore.\n';
		windowState.applyFileChanged(doc(MD_URI, incoming));
		await settle();
		expect(text()).toBe(MD);
		composition('compositionend');
		await settleLong();
		await new Promise((r) => setTimeout(r, 50));
		expect(text()).toBe(incoming);
		expect(handle().dirty).toBe(false);
	});

	it('FindBar の語の変更', async () => {
		const { container } = await mountMd(MD);
		await emitMenuFind();
		composition('compositionstart');
		await settle();
		await typeQuery(container, 'paragraph');
		expect(countText(container), '変換中は張り替えない').toBe('');
		composition('compositionend');
		await settleLong();
		await new Promise((r) => setTimeout(r, 200));
		await settle();
		expect(countText(container)).toBe('1 of 3');
	});
});

// ---------------------------------------------------------------------------
// AC-74-18 / 19 / 37 — 検索・ズーム・印刷
// ---------------------------------------------------------------------------

describe('AC-74-18 / 37: 編集面の検索は見えている文字を数える', () => {
	it('件数が findMatches(容器の textContent, 語) と一致し、記号(**)は数えない', async () => {
		const { container } = await mountMd(MD);
		await emitMenuFind();
		await typeQuery(container, 'paragraph');
		const visible = q(container, 'article.viewer .markdown-body')!.textContent ?? '';
		expect(countText(container)).toBe(formatCount(0, findMatches(visible, 'paragraph').length, 'paragraph'));
		expect(countText(container)).toBe('1 of 3');
		await typeQuery(container, 'bold');
		expect(countText(container)).toBe('1 of 1');
		await typeQuery(container, '**');
		expect(countText(container)).toBe('No results');
	});

	it('打鍵の後に張り直される(件数が増える)', async () => {
		const { container } = await mountMd(MD);
		await emitMenuFind();
		await typeQuery(container, 'paragraph');
		expect(countText(container)).toBe('1 of 3');
		type(' paragraph', 4, 0);
		await settleLong();
		await new Promise((r) => setTimeout(r, 250));
		await settle();
		expect(countText(container)).toBe('1 of 4');
	});
});

describe('AC-74-19 / 37: ズームは .markdown-body の CSS zoom のまま(面はその中)。印刷は今の描画', () => {
	it('zoom=150 のとき .markdown-body の style.zoom が 150% で、面はその子孫', async () => {
		const { container } = await mountMd(MD, { zoom: 150 });
		const body = q(container, 'article.viewer .markdown-body')!;
		expect(body.style.zoom).toBe('150%');
		expect(body.contains(q(container, PM))).toBe(true);
	});

	it('beforeprint で markdownText を今の描画にしたものが出て、afterprint で消える(未保存の編集を含む)', async () => {
		const { container } = await mountMd(MD);
		type('PRINTME ', 2, 0);
		window.dispatchEvent(new Event('beforeprint'));
		await settleLong();
		await new Promise((r) => setTimeout(r, 50));
		await settle();
		const print = q(container, PRINT);
		expect(print, '刷る直前の描画の置き場').not.toBeNull();
		expect(print!.querySelector('h1')?.textContent).toBe('Plan');
		expect(print!.textContent).toContain('PRINTME Second paragraph here.');
		expect(print!.querySelector('strong')?.textContent).toBe('bold');
		window.dispatchEvent(new Event('afterprint'));
		await settleLong();
		expect(q(container, PRINT)).toBeNull();
		expect(q(container, PM)).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC-74-20 / 49 — コピーと貼り付け
// ---------------------------------------------------------------------------

describe('AC-74-20 / 49: コピーの text/plain は見えている文字、貼り付けは文字として入る', () => {
	it('コピー: text/plain に記号が無く(**bold** → bold)、text/html が入る', async () => {
		await mountMd(MD);
		const v = view();
		const p = textSpots(v.state.doc, 1);
		const from = p[0]!.pos;
		const last = p[p.length - 1]!;
		selectRange(from, last.pos + last.text.length);
		const clip = clipboard();
		await fireEvent.copy(v.dom, { clipboardData: clip.api });
		await settle();
		expect(clip.data.get('text/plain')).toBe('Intro paragraph with bold word.');
		expect(clip.data.get('text/html')).toContain('<strong>bold</strong>');
	});

	it('text/plain の貼り付けは空行で段落に分かれ、**x** は文字のまま(書き出しで \\*\\*x\\*\\*)', async () => {
		await mountMd(MD);
		const v = view();
		const tail = textSpots(v.state.doc, 4)[0]!;
		selectRange(tail.pos + tail.text.length, tail.pos + tail.text.length);
		const clip = clipboard({ 'text/plain': ' **x** end\n\nnew para' });
		await fireEvent.paste(v.dom, { clipboardData: clip.api });
		await settleLong();
		const out = text();
		expect(out).toContain('Tail paragraph. \\*\\*x\\*\\* end');
		expect(out).toContain('\n\nnew para');
		expect(view().state.doc.childCount).toBe(6);
		let strong = false;
		view().state.doc.descendants((n) => {
			if (n.marks.some((m) => m.type.name === 'strong') && n.text?.includes('x')) strong = true;
			return true;
		});
		expect(strong, 'Markdown として解釈しない').toBe(false);
	});

	it('AC-74-49: data-pm-slice の無い text/html は text/plain として入る(外の HTML を構造にしない)', async () => {
		await mountMd(MD);
		const v = view();
		const tail = textSpots(v.state.doc, 4)[0]!;
		selectRange(tail.pos, tail.pos);
		const clip = clipboard({ 'text/html': '<b>bold</b> <a href="https://x.example">link</a>', 'text/plain': 'bold link' });
		await fireEvent.paste(v.dom, { clipboardData: clip.api });
		await settleLong();
		expect(text()).toContain('bold linkTail paragraph.');
		const node = view().state.doc.child(4);
		node.descendants((n) => {
			expect(n.marks.map((m) => m.type.name)).toEqual([]);
			return true;
		});
	});

	it('ProseMirror の面どうしの貼り付け(data-pm-slice あり)は構造が残る', async () => {
		await mountMd(MD);
		const v = view();
		const p = textSpots(v.state.doc, 1);
		selectRange(p[0]!.pos, p[p.length - 1]!.pos + p[p.length - 1]!.text.length);
		const clip = clipboard();
		await fireEvent.copy(v.dom, { clipboardData: clip.api });
		await settle();
		const html = clip.data.get('text/html') ?? '';
		expect(html).toContain('data-pm-slice');
		const tail = textSpots(view().state.doc, 4)[0]!;
		selectRange(tail.pos, tail.pos);
		await fireEvent.paste(v.dom, { clipboardData: clipboard({ 'text/html': html, 'text/plain': clip.data.get('text/plain') ?? '' }).api });
		await settleLong();
		expect(text()).toContain('**bold**');
		expect(text().match(/\*\*bold\*\*/g)?.length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// 契約14・16 — 保存・Reload File・未保存の確認
// ---------------------------------------------------------------------------

describe('契約14・16: 保存(照合つき・保存の後は 1 段目に戻る)・Reload File・未保存の確認', () => {
	it('saveFileEditor: expectedHash=contentHash(base)。成功後に同じブロックに打つと保存した文字列からその文字だけ違う', async () => {
		await mountMd(MD);
		const v = view();
		const spot = textSpots(v.state.doc, 2)[0]!;
		selectRange(spot.pos, spot.pos + 6);
		runFormatCommand('format-bold', handle());
		const saved = text();
		expect(saved).toBe(MD.replace('Second paragraph', '**Second** paragraph'));
		await saveFileEditor(handle());
		expect(invokeMock.mock.calls).toEqual([['save_document', { uri: MD_URI, content: saved, expectedHash: contentHash(MD) }]]);
		expect(handle().dirty).toBe(false);
		expect(handle().expectedHash()).toBe(contentHash(saved));
		const plain = textSpots(view().state.doc, 2).find((s) => s.marks.length === 0)!;
		view().dispatch(view().state.tr.insertText('X', plain.pos + 1));
		expect(text()).toBe(saved.replace('** paragraph', '** Xparagraph'));
	});

	it('Reload File: dirty なら確認、Cancel で不変、Don\'t Save で読み直し(履歴 0)', async () => {
		await mountMd(MD);
		type('x', 2, 0);
		const disk = MD + '\nFrom disk.\n';
		const open = vi.fn(async (uri: string) => doc(uri, disk));
		const reload = createFileReloader<DocumentPayload>({
			current: () => windowState.currentDocument?.uri ?? null,
			confirm: confirmDiscardEdits,
			open,
			// +page.svelte の applyText と同じ経路(確認 → 当てる → dirty の面を reset)。
			applyText: (d) => {
				windowState.applyReloadedText(d);
				const face = windowState.fileEditor;
				if (face && face.uri === d.uri && face.dirty) face.reset(d.content);
			},
			bumpBinary: vi.fn(),
			notify: (m) => alertMock(m),
			changeStamp: () => 0,
			refreshTree: async () => {},
		});
		messageMock.mockResolvedValueOnce('Cancel');
		expect(await reload.reload()).toBe('cancelled');
		expect(open).not.toHaveBeenCalled();
		expect(text()).toContain('xSecond');
		messageMock.mockResolvedValueOnce("Don't Save");
		expect(await reload.reload()).toBe('reloaded');
		await settleLong();
		expect(text()).toBe(disk);
		expect(handle().dirty).toBe(false);
		expect(undoDepth(view().state)).toBe(0);
	});

	it('confirmDiscardEdits の Save は saveFileEditor の経路', async () => {
		await mountMd(MD);
		type('x', 2, 0);
		const mine = text();
		messageMock.mockResolvedValueOnce('Save');
		expect(await confirmDiscardEdits()).toBe(true);
		expect(invokeMock.mock.calls).toEqual([['save_document', { uri: MD_URI, content: mine, expectedHash: contentHash(MD) }]]);
		expect(handle().dirty).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 航行(項目 19・判断 5)/ AC-74-48(判断 7)
// ---------------------------------------------------------------------------

describe('航行(契約17・(aa)・判断 5): リンクのクリックで航行し、文書は変わらない', () => {
	it('外部リンクのクリック → openUrl。dirty にならない', async () => {
		const { container } = await mountMd(LINKS);
		const a = [...container.querySelectorAll<HTMLAnchorElement>(`${PM} a`)].find((x) => x.getAttribute('href')?.startsWith('https://'))!;
		await fireEvent.click(a);
		await settleLong();
		expect(openUrlMock).toHaveBeenCalledWith('https://example.com/x');
		expect(handle().dirty).toBe(false);
		expect(text()).toBe(LINKS);
	});

	it('Option + クリックは航行せずカーソルを置く', async () => {
		const { container } = await mountMd(LINKS);
		const a = [...container.querySelectorAll<HTMLAnchorElement>(`${PM} a`)].find((x) => x.getAttribute('href')?.startsWith('https://'))!;
		await fireEvent.click(a, { altKey: true });
		await settleLong();
		expect(openUrlMock).not.toHaveBeenCalled();
		expect(invokeMock).not.toHaveBeenCalledWith('open_document', expect.anything());
	});

	it('判断 5: `#plan`(見出しの id は無い)のクリックでは何も起きない(openUrl も open_document も無し・dirty でない)', async () => {
		const { container } = await mountMd(LINKS);
		const a = [...container.querySelectorAll<HTMLAnchorElement>(`${PM} a`)].find((x) => x.getAttribute('href') === '#plan')!;
		await fireEvent.click(a);
		await settleLong();
		expect(openUrlMock).not.toHaveBeenCalled();
		expect(invokeMock).not.toHaveBeenCalledWith('open_document', expect.anything());
		expect(handle().dirty).toBe(false);
	});
});

describe('AC-74-48(判断 7): dirty の面で別の .md のリンクをクリックすると未保存の確認を通る', () => {
	function mdLink(container: ParentNode) {
		return [...container.querySelectorAll<HTMLAnchorElement>(`${PM} a`)].find((x) => (x.getAttribute('href') ?? '').endsWith('other.md'))!;
	}

	it('Cancel なら open_document を呼ばず、文書はそのまま', async () => {
		const { container } = await mountMd(LINKS);
		type('x', 0, 0);
		messageMock.mockResolvedValueOnce('Cancel');
		await fireEvent.click(mdLink(container));
		await settleLong();
		expect(messageMock).toHaveBeenCalledTimes(1);
		expect(invokeMock).not.toHaveBeenCalledWith('open_document', expect.anything());
		expect(text()).toContain('xSee');
		expect(windowState.currentDocument?.uri).toBe(MD_URI);
	});

	it("Don't Save なら open_document が呼ばれる(行き先は other.md)", async () => {
		const { container } = await mountMd(LINKS);
		type('x', 0, 0);
		messageMock.mockResolvedValueOnce("Don't Save");
		invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
			if (cmd === 'open_document') return doc((args as { uri: string }).uri, '# Other\n');
			return null;
		});
		await fireEvent.click(mdLink(container));
		await settleLong();
		const call = invokeMock.mock.calls.find((c) => c[0] === 'open_document');
		expect(call).toBeDefined();
		expect(String((call![1] as { uri: string }).uri)).toMatch(/other\.md$/);
	});

	it('dirty でなければ確認なしで open_document', async () => {
		const { container } = await mountMd(LINKS);
		invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
			if (cmd === 'open_document') return doc((args as { uri: string }).uri, '# Other\n');
			return null;
		});
		await fireEvent.click(mdLink(container));
		await settleLong();
		expect(messageMock).not.toHaveBeenCalled();
		expect(invokeMock.mock.calls.some((c) => c[0] === 'open_document')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 契約2 — 面が消えると handle が外れる
// ---------------------------------------------------------------------------

describe('契約2: 文書を閉じる・別の文書へ移ると handle が替わる', () => {
	it('clearDocument で null。別の Markdown へ移ると新しい handle(uri が替わり dirty でない・履歴 0)', async () => {
		const d1 = doc(MD_URI, MD);
		windowState.setDocument(d1);
		const r1 = await rendered(MD);
		const props = baseProps(d1, r1.html, r1.index, { fileEditor: true });
		const { rerender } = render(Viewer, { props });
		await settleLong();
		type('x', 2, 0);
		const other = 'file:///Users/a/notes/other.md';
		const d2 = doc(other, '# Other\n\nbody\n');
		windowState.setDocument(d2);
		const r2 = await rendered(d2.content, other);
		await rerender({ ...props, document: d2, html: r2.html, index: r2.index });
		await settleLong();
		expect(handle().uri).toBe(other);
		expect(handle().dirty).toBe(false);
		expect(text()).toBe(d2.content);
		expect(undoDepth(view().state)).toBe(0);
		windowState.clearDocument();
		await settleLong();
		expect(windowState.fileEditor).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 契約4(reviewer の照合 2026-11-17)— 面の幅は閲覧と同じ規則(markdown.css の `.markdown-body > p` などの直下の子の規則)に乗る
// ---------------------------------------------------------------------------

describe('契約4: 面の最上位のブロックの DOM は、class markdown-body を持つ要素の直下の子(markdown.css の幅の規則が当たる)', () => {
	const KINDS = ['# H', '', 'para', '', '- a', '- b', '', '> q', '', '| a | b |', '| - | - |', '| c | d |', '', '```', 'code', '```', ''].join('\n');

	it('段落・見出し・リスト・引用・表・code fence の DOM が .markdown-body の直下にある', async () => {
		const { container } = await mountMd(KINDS);
		const v = view();
		const names: string[] = [];
		v.state.doc.forEach((c) => names.push(c.type.name));
		expect(names).toEqual(['heading', 'paragraph', 'bullet_list', 'blockquote', 'table', 'code_block']);
		for (let i = 0; i < v.state.doc.childCount; i++) {
			const pos = blockPos(v.state.doc, i);
			const dom = v.nodeDOM(pos) as HTMLElement | null;
			expect(dom, `block ${i} (${names[i]}) has a DOM`).not.toBeNull();
			expect(dom!.parentElement?.classList.contains('markdown-body'), `block ${i} (${names[i]}) <${dom!.tagName.toLowerCase()}> sits directly under an element with class markdown-body (parent: ${dom!.parentElement?.className})`).toBe(true);
		}
		// jsdom ではレイアウトを測れないので、幅の規則の当たり先(セレクタの形)で見る。
		expect(q(container, '.markdown-body > p'), '.markdown-body > p が面の段落に当たる').not.toBeNull();
		expect(q(container, '.markdown-body > h1')).not.toBeNull();
		expect(q(container, '.markdown-body > ul')).not.toBeNull();
		expect(q(container, '.markdown-body > blockquote')).not.toBeNull();
		expect(q(container, '.markdown-body > table')).not.toBeNull();
		expect(q(container, '.markdown-body > pre')).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// reviewer の照合(2026-11-17・CHANGES REQUESTED)の追加 — Link… / Image… の面の側・保存の後の段・閾値超えの守り・Tab・blur・atom のコピー
// ---------------------------------------------------------------------------

describe('契約8・項目 7・11: Link… は面の入力欄で、Image… はファイルのダイアログで(runFormatCommand は false を返し、面が続きを持つ)', () => {
	// 第4段 4-5(4-10): URL の欄 1 つ(link-input)はモックの D の形(Text と Link の 2 つの欄・Remove Link・Done)に。URL の欄は link-url
	const LINK_INPUT = `${FACE} [data-testid="link-url"]`;

	it('選択があれば link-input が出る。URL を打って Enter → 選んだ範囲に link(undo 1 段)・欄が閉じる', async () => {
		const { container } = await mountMd(MD);
		const v = view();
		const spot = textSpots(v.state.doc, 2)[0]!; // 'Second paragraph here.'
		selectRange(spot.pos, spot.pos + 6);
		const depth = undoDepth(v.state);
		runFormatCommand('format-link', handle());
		await settleLong();
		const input = q(container, LINK_INPUT) as HTMLInputElement | null;
		expect(input, 'URL の入力欄').not.toBeNull();
		await fireEvent.input(input!, { target: { value: 'https://example.com/second' } });
		await fireEvent.keyDown(input!, { key: 'Enter' });
		await settleLong();
		expect(text()).toBe(MD.replace('Second paragraph here.', '[Second](https://example.com/second) paragraph here.'));
		expect(undoDepth(view().state)).toBe(depth + 1);
		expect(q(container, LINK_INPUT), '欄が閉じる').toBeNull();
		key('z', { ctrlKey: true });
		await settle();
		expect(text()).toBe(MD);
	});

	it('Esc で閉じて文書は不変', async () => {
		const { container } = await mountMd(MD);
		const v = view();
		const spot = textSpots(v.state.doc, 2)[0]!;
		selectRange(spot.pos, spot.pos + 6);
		runFormatCommand('format-link', handle());
		await settleLong();
		const input = q(container, LINK_INPUT) as HTMLInputElement | null;
		expect(input).not.toBeNull();
		await fireEvent.input(input!, { target: { value: 'https://example.com/x' } });
		await fireEvent.keyDown(input!, { key: 'Escape' });
		await settleLong();
		expect(q(container, LINK_INPUT)).toBeNull();
		expect(text()).toBe(MD);
		expect(handle().dirty).toBe(false);
	});

	it('V19: 選択が空でカーソルが単語の上なら、その単語を文言にして欄を出す(Enter でその単語だけが link)', async () => {
		const { container } = await mountMd(MD);
		const v = view();
		const spot = textSpots(v.state.doc, 2)[0]!; // 'Second paragraph here.'
		selectRange(spot.pos + 2, spot.pos + 2); // `Se|cond` の中
		runFormatCommand('format-link', handle());
		await settleLong();
		const input = q(container, LINK_INPUT) as HTMLInputElement | null;
		expect(input, '単語の上なら欄が出る').not.toBeNull();
		expect(input!.value, 'URL でない単語なので欄は空').toBe('');
		await fireEvent.input(input!, { target: { value: 'https://example.com/w' } });
		await fireEvent.keyDown(input!, { key: 'Enter' });
		await settleLong();
		expect(text()).toBe(MD.replace('Second paragraph here.', '[Second](https://example.com/w) paragraph here.'));
	});

	it('V19: 選択が空で単語の境目(空白の手前・直後)や空の段落なら欄を出さず、文書は不変', async () => {
		const { container } = await mountMd(MD);
		const v = view();
		const spot = textSpots(v.state.doc, 2)[0]!;
		for (const col of [6, 7]) {
			// 6=`Second| paragraph`(空白の手前)・7=`Second |paragraph`(空白の直後)。前後どちらも語の文字でなければ単語の上ではない。
			selectRange(spot.pos + col, spot.pos + col);
			runFormatCommand('format-link', handle());
			await settleLong();
			expect(q(container, LINK_INPUT), `col ${col} には欄が出ない`).toBeNull();
		}
		// 空の段落(段落の末尾に空の段落を足して、その中)
		const tail = textSpots(v.state.doc, 4)[0]!;
		const end = tail.pos + tail.text.length;
		view().dispatch(view().state.tr.split(end));
		await settle();
		selectRange(end + 2, end + 2); // 新しい空の段落の中
		const after = text();
		runFormatCommand('format-link', handle());
		await settleLong();
		expect(q(container, LINK_INPUT)).toBeNull();
		expect(text()).toBe(after);
	});

	it('選んだ文字が URL なら、その URL が href になる(欄が出れば URL が入っていて Enter だけ)', async () => {
		const src = 'go to https://a.example/path now\n';
		const { container } = await mountMd(src);
		const v = view();
		// GFM の素の URL は link(kind literal)で読まれる。第4段 4-5: リンクの中の Link… は欄を開く(Command は false)ので、Remove Link で外して
		// 文字だけにしてから選ぶ。
		const link = textSpots(v.state.doc, 0).find((s) => s.marks.includes('link'))!;
		selectRange(link.pos + 1, link.pos + 1);
		expect(runFormatCommand('format-link', handle()), 'リンクの中でも Command は false(欄は面の側)').toBe(false);
		await settleLong();
		await fireEvent.click(q(container, `${FACE} [data-testid="link-remove"]`)!);
		await settleLong();
		const plain = textSpots(view().state.doc, 0).find((s) => s.text.includes('https://a.example/path'))!;
		const start = plain.pos + plain.text.indexOf('https://a.example/path');
		selectRange(start, start + 'https://a.example/path'.length);
		runFormatCommand('format-link', handle());
		await settleLong();
		const input = q(container, LINK_INPUT) as HTMLInputElement | null;
		if (input) {
			expect(input.value).toBe('https://a.example/path');
			await fireEvent.keyDown(input, { key: 'Enter' });
			await settleLong();
		}
		let href: string | null = null;
		view().state.doc.descendants((n) => {
			const m = n.marks.find((x) => x.type.name === 'link');
			if (m && n.text?.includes('a.example')) href = m.attrs.href as string;
			return true;
		});
		expect(href).toBe('https://a.example/path');
		expect(text()).toContain('https://a.example/path');
	});

	it('Image…: ダイアログで選んだファイルが文書からの相対パスの image として入る(undo 1 段)。取り消しなら何もしない', async () => {
		await mountMd(MD);
		const v = view();
		const tail = textSpots(v.state.doc, 4)[0]!;
		selectRange(tail.pos + tail.text.length, tail.pos + tail.text.length);
		openDialogMock.mockResolvedValueOnce(null as never);
		expect(runFormatCommand('format-insert-image', handle())).toBe(false);
		await settleLong();
		expect(openDialogMock).toHaveBeenCalledTimes(1);
		expect(text(), '取り消しなら不変').toBe(MD);
		const depth = undoDepth(view().state);
		openDialogMock.mockResolvedValueOnce('/Users/a/notes/images/fig.png' as never);
		runFormatCommand('format-insert-image', handle());
		await settleLong();
		await new Promise((r) => setTimeout(r, 50));
		await settle();
		let img: { src: string; alt: string } | null = null;
		view().state.doc.descendants((n) => {
			if (n.type.name === 'image') img = { src: n.attrs.src as string, alt: n.attrs.alt as string };
			return true;
		});
		expect(img, 'image のノードが入る').not.toBeNull();
		expect(img!.src).toBe('images/fig.png');
		expect(text()).toContain('](images/fig.png)');
		expect(undoDepth(view().state)).toBe(depth + 1);
	});
});

describe('U7・項目 13: 面で保存した後は全ブロックが 1 段目、続けて打つとそのブロックだけ 2 段目(handle.model() で段を見る)', () => {
	it('Bold を付けて保存 → segments 全部 1 → 1 文字打つと [1, 1, 2, 1, 1]', async () => {
		await mountMd(MD);
		const v = view();
		const spot = textSpots(v.state.doc, 2)[0]!;
		selectRange(spot.pos, spot.pos + 6);
		runFormatCommand('format-bold', handle());
		const before = handle().model();
		expect(serializeMarkdown(before.state.doc, before.origin, before.generation).segments.map((s) => s.stage)).toEqual([1, 1, 3, 1, 1]);
		await saveFileEditor(handle());
		expect(handle().dirty).toBe(false);
		const saved = handle().model();
		expect(saved.base).toBe(text());
		expect(serializeMarkdown(saved.state.doc, saved.origin, saved.generation).segments.map((s) => s.stage), '保存の後は全部 1 段目').toEqual([1, 1, 1, 1, 1]);
		const plain = textSpots(view().state.doc, 2).find((s) => s.marks.length === 0)!;
		view().dispatch(view().state.tr.insertText('X', plain.pos + 1));
		const after = handle().model();
		const r = serializeMarkdown(after.state.doc, after.origin, after.generation);
		expect(r.segments.map((s) => s.stage)).toEqual([1, 1, 2, 1, 1]);
		expect(r.text).toBe(saved.base.replace('** paragraph', '** Xparagraph'));
	});
});

describe('U14・U15・AC-74-22・項目 1 (b): 閾値を超えた Markdown(handle なし)でも編集面は出ない(今の編集は撤去)', () => {
	it('ダブルクリックしても contenteditable が出ず、面の handle も登録されない。editBlocked は真', async () => {
		const big = `# Big\n\nfirst paragraph\n\n${'a'.repeat(MARKDOWN_EDIT_LIMIT_BYTES)}\n`;
		const d = doc(MD_URI, big);
		windowState.setDocument(d);
		const { container } = render(Viewer, { props: baseProps(d, '<h1>Big</h1><p>first paragraph</p><p>…</p>', null, {}) });
		await settleLong();
		expect(q(container, TOO_LARGE)).not.toBeNull();
		expect(windowState.fileEditor).toBeNull();
		await fireEvent.dblClick(q(container, '.markdown-body p')!);
		await settle();
		expect(container.querySelectorAll('[contenteditable="true"]')).toHaveLength(0);
		expect(windowState.fileEditor).toBeNull();
		expect(windowState.dirty).toBe(false);
		expect(windowState.editBlocked).toBe(true);
	});

	it('SSH root の Markdown でも同じ(読み取り専用の描画・editBlocked)', async () => {
		const { container } = await mountMd(MD, {}, SSH_URI);
		expect(windowState.editBlocked).toBe(true);
		expect(windowState.fileEditor).toBeNull();
		await fireEvent.dblClick(q(container, '.markdown-body p')!);
		await settle();
		expect(container.querySelectorAll('[contenteditable="true"]')).toHaveLength(0);
		expect(windowState.dirty).toBe(false);
	});

	it('面を閉じると editBlocked は偽に戻る', async () => {
		await mountMd(MD, {}, SSH_URI);
		expect(windowState.editBlocked).toBe(true);
		windowState.clearDocument();
		await settleLong();
		expect(windowState.editBlocked).toBe(false);
	});
});

describe('U16・項目 8: Tab / Shift + Tab はほかに当てる操作が無くても面の外へフォーカスを逃がさない', () => {
	it('段落の中の Tab / Shift+Tab は keymap が受けて(defaultPrevented)文書は変わらない', async () => {
		await mountMd(MD);
		const v = view();
		const spot = textSpots(v.state.doc, 2)[0]!;
		selectRange(spot.pos + 2, spot.pos + 2);
		for (const shift of [false, true]) {
			const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true });
			v.dom.dispatchEvent(ev);
			expect(ev.defaultPrevented, `Tab${shift ? ' (shift)' : ''} is handled by the keymap`).toBe(true);
		}
		await settle();
		expect(text()).toBe(MD);
	});

	it('リストの中の Tab は項目を 1 段深く、Shift+Tab で戻す', async () => {
		await mountMd(MD);
		const v = view();
		const two = textSpots(v.state.doc, 3).find((s) => s.text === 'item two')!;
		selectRange(two.pos, two.pos);
		v.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
		await settle();
		expect(text()).toBe(MD.replace('- item two', '  - item two'));
		v.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
		await settle();
		expect(text()).toBe(MD);
	});
});

describe('U28・契約10: 変換中に blur したら、控えていた外部変更と Format を 1 回だけ流す(第1段の M28 と同じ型)', () => {
	it('外部変更', async () => {
		await mountMd(MD);
		composition('compositionstart');
		await settle();
		const incoming = MD + '\nMore.\n';
		windowState.applyFileChanged(doc(MD_URI, incoming));
		await settle();
		expect(text()).toBe(MD);
		view().dom.dispatchEvent(new FocusEvent('blur'));
		await settleLong();
		await new Promise((r) => setTimeout(r, 50));
		await settle();
		expect(text(), 'blur で確定扱い=当たる').toBe(incoming);
		// 遅れて compositionend が来ても二重には当たらない。
		composition('compositionend');
		await settleLong();
		expect(text()).toBe(incoming);
		expect(handle().dirty).toBe(false);
	});

	it('Format', async () => {
		await mountMd(MD);
		const v = view();
		const spot = textSpots(v.state.doc, 2)[0]!;
		selectRange(spot.pos, spot.pos + 6);
		composition('compositionstart');
		await settle();
		expect(runFormatCommand('format-bold', handle())).toBe(false);
		expect(text()).toBe(MD);
		v.dom.dispatchEvent(new FocusEvent('blur'));
		await settleLong();
		await new Promise((r) => setTimeout(r, 50));
		await settle();
		expect(text()).toBe(MD.replace('Second paragraph', '**Second** paragraph'));
		composition('compositionend');
		await settleLong();
		expect(text(), '二重に当たらない(トグルが戻らない)').toBe(MD.replace('Second paragraph', '**Second** paragraph'));
	});
});

describe('項目 18: コピーの text/plain に atom の描画の文字が入る(脚注の参照の番号・画像の alt・インラインの生 HTML の見えている文字)', () => {
	it('text/plain', async () => {
		const src = 'note[^1] and ![alt text](a.png) and <kbd>Cmd</kbd> end\n\n[^1]: the note\n';
		await mountMd(src);
		const v = view();
		const spots = textSpots(v.state.doc, 0);
		const first = spots[0]!;
		const last = spots[spots.length - 1]!;
		selectRange(first.pos, last.pos + last.text.length);
		const clip = clipboard();
		await fireEvent.copy(v.dom, { clipboardData: clip.api });
		await settle();
		const plain = clip.data.get('text/plain') ?? '';
		expect(plain).toMatch(/note\s*\[?1\]?/);
		expect(plain).toContain('alt text');
		expect(plain).toContain('Cmd');
		expect(plain).not.toContain('<kbd>');
		expect(plain).not.toContain('![');
	});
});

describe('P3 の穴(reviewer 2026-11-17): literal・alt・`..`', () => {
	// 第4段 4-5(4-10): URL の欄 1 つ(link-input)はモックの D の形(Text と Link の 2 つの欄・Remove Link・Done)に。URL の欄は link-url
	const LINK_INPUT = `${FACE} [data-testid="link-url"]`;

	it('V3: Link… で文言と URL が同じなら、書き出しは素の URL のまま(`[url](url)` にならない)', async () => {
		const src = 'see https://a.example/path now\n';
		const { container } = await mountMd(src);
		const v = view();
		// 読み込みで literal の link が付いているので、まず Remove Link で外して素の文字にする(第4段 4-5)
		const link = textSpots(v.state.doc, 0).find((s) => s.marks.includes('link'))!;
		selectRange(link.pos + 1, link.pos + 1);
		expect(runFormatCommand('format-link', handle())).toBe(false);
		await settleLong();
		await fireEvent.click(q(container, `${FACE} [data-testid="link-remove"]`)!);
		await settleLong();
		const plain = textSpots(view().state.doc, 0).find((s) => s.text.includes('https://a.example/path'))!;
		const start = plain.pos + plain.text.indexOf('https://a.example/path');
		selectRange(start, start + 'https://a.example/path'.length);
		runFormatCommand('format-link', handle());
		await settleLong();
		const input = q(container, LINK_INPUT) as HTMLInputElement | null;
		expect(input).not.toBeNull();
		expect(input!.value).toBe('https://a.example/path');
		await fireEvent.keyDown(input!, { key: 'Enter' });
		await settleLong();
		let kind: string | null = null;
		view().state.doc.descendants((n) => {
			const m = n.marks.find((x) => x.type.name === 'link');
			if (m && n.text?.includes('a.example')) kind = m.attrs.kind as string;
			return true;
		});
		expect(kind).toBe('literal');
		expect(text()).toBe(src);
		expect(text()).not.toContain('](');
	});

	it('V3 の対: 文言と URL が違えば `[文言](URL)`', async () => {
		const src = 'see docs now\n';
		const { container } = await mountMd(src);
		const spot = textSpots(view().state.doc, 0)[0]!;
		const start = spot.pos + 'see '.length;
		selectRange(start, start + 4);
		runFormatCommand('format-link', handle());
		await settleLong();
		const input = q(container, LINK_INPUT) as HTMLInputElement | null;
		await fireEvent.input(input!, { target: { value: 'https://a.example/docs' } });
		await fireEvent.keyDown(input!, { key: 'Enter' });
		await settleLong();
		expect(text()).toBe('see [docs](https://a.example/docs) now\n');
	});

	it('V6: Image… の alt はファイル名から拡張子を除いたもの(`fig.png` → `fig`、`a.b.jpeg` → `a.b`)', async () => {
		await mountMd(MD);
		const tail = textSpots(view().state.doc, 4)[0]!;
		selectRange(tail.pos + tail.text.length, tail.pos + tail.text.length);
		openDialogMock.mockResolvedValueOnce('/Users/a/notes/images/fig.png' as never);
		runFormatCommand('format-insert-image', handle());
		await settleLong();
		await new Promise((r) => setTimeout(r, 50));
		await settle();
		openDialogMock.mockResolvedValueOnce('/Users/a/notes/a.b.jpeg' as never);
		runFormatCommand('format-insert-image', handle());
		await settleLong();
		await new Promise((r) => setTimeout(r, 50));
		await settle();
		const imgs: { src: string; alt: string }[] = [];
		view().state.doc.descendants((n) => {
			if (n.type.name === 'image') imgs.push({ src: n.attrs.src as string, alt: n.attrs.alt as string });
			return true;
		});
		expect(imgs).toEqual([
			{ src: 'images/fig.png', alt: 'fig' },
			{ src: 'a.b.jpeg', alt: 'a.b' },
		]);
		expect(text()).toContain('![fig](images/fig.png)');
		expect(text()).toContain('![a.b](a.b.jpeg)');
	});

	it('V18: 文書のフォルダの外の画像は `../` で辿る(/Users/a/other/x.png を /Users/a/notes/doc.md から → ../other/x.png)', async () => {
		await mountMd(MD, {}, 'file:///Users/a/notes/doc.md');
		const tail = textSpots(view().state.doc, 4)[0]!;
		selectRange(tail.pos + tail.text.length, tail.pos + tail.text.length);
		openDialogMock.mockResolvedValueOnce('/Users/a/other/x.png' as never);
		runFormatCommand('format-insert-image', handle());
		await settleLong();
		await new Promise((r) => setTimeout(r, 50));
		await settle();
		let src: string | null = null;
		view().state.doc.descendants((n) => {
			if (n.type.name === 'image') src = n.attrs.src as string;
			return true;
		});
		expect(src).toBe('../other/x.png');
		expect(text()).toContain('![x](../other/x.png)');
	});

	it('V18 の対: 2 つ上のフォルダは `../../`', async () => {
		await mountMd(MD, {}, 'file:///Users/a/notes/deep/doc.md');
		const tail = textSpots(view().state.doc, 4)[0]!;
		selectRange(tail.pos + tail.text.length, tail.pos + tail.text.length);
		openDialogMock.mockResolvedValueOnce('/Users/a/img/y.png' as never);
		runFormatCommand('format-insert-image', handle());
		await settleLong();
		await new Promise((r) => setTimeout(r, 50));
		await settle();
		expect(text()).toContain('](../../img/y.png)');
	});
});

// ---------------------------------------------------------------------------
// 要件74 第2段 2-6(配布の前に直す退行 2)— 表のセルに改行を入れない(AC-74-54 の 2-6 の分・由谷の決定 2026-11-17 朝)
// ---------------------------------------------------------------------------

describe('AC-74-54(2-6): 表のセルの中では Shift + Enter は何もせず、複数行の貼り付けは改行を空白にして 1 行で入る。保存しても表が割れない', () => {
	const TABLE = ['# T', '', '| a | b |', '| - | - |', '| c1 | d1 |', '| c2 | d2 |', '', 'After.', ''].join('\n');

	function cellSpot(cellText: string) {
		const v = view();
		return textSpots(v.state.doc, 1).find((s) => s.text === cellText)!;
	}
	function tableRows(src: string): number {
		return src.split('\n').filter((l) => /^\|.*\|\s*$/.test(l)).length;
	}

	it('セルの中の Shift + Enter: 取引なし(文書・undo の段数・dirty が不変)、keydown は面が受ける(defaultPrevented)', async () => {
		await mountMd(TABLE);
		const spot = cellSpot('c1');
		selectRange(spot.pos + 1, spot.pos + 1);
		const depth = undoDepth(view().state);
		const ev = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
		view().dom.dispatchEvent(ev);
		await settle();
		expect(ev.defaultPrevented, 'Shift + Enter は面が受ける(ブラウザの既定の改行も入れない)').toBe(true);
		expect(text()).toBe(TABLE);
		expect(undoDepth(view().state)).toBe(depth);
		expect(handle().dirty).toBe(false);
		let hardBreaks = 0;
		view().state.doc.descendants((n) => {
			if (n.type.name === 'hard_break') hardBreaks++;
			return true;
		});
		expect(hardBreaks).toBe(0);
	});

	it('段落の Shift + Enter は今のまま hard break(退行なし)', async () => {
		await mountMd(TABLE);
		const spot = textSpots(view().state.doc, 2)[0]!; // 'After.'
		selectRange(spot.pos + 5, spot.pos + 5);
		key('Enter', { shiftKey: true });
		await settle();
		expect(text()).toBe(TABLE.replace('After.', 'After  \n.'));
	});

	it('複数行の text/plain をセルに貼ると、改行(LF / CRLF / 空行)が空白 1 つになった 1 行の文字で入る', async () => {
		await mountMd(TABLE);
		const spot = cellSpot('d1');
		selectRange(spot.pos + 2, spot.pos + 2); // d1| の末尾
		const clip = clipboard({ 'text/plain': 'one\ntwo\r\n\r\nthree\n' });
		await fireEvent.paste(view().dom, { clipboardData: clip.api });
		await settle();
		const out = text();
		expect(out).toBe(TABLE.replace('| c1 | d1 |', '| c1 | d1one two three |'));
		expect(tableRows(out), '表の行の数は変わらない').toBe(tableRows(TABLE));
		expect(cellSpot('d1one two three')).toBeTruthy();
		let breaks = 0;
		view().state.doc.descendants((n) => {
			if (n.type.name === 'hard_break' || n.type.name === 'soft_break') breaks++;
			return true;
		});
		expect(breaks, 'セルの中に改行のノードが無い').toBe(0);
	});

	it('セルに貼った後に保存しても書き出しの検算に落ちない(表の段=fellBack / warn なし)・読み直しても表の行の数が同じ', async () => {
		await mountMd(TABLE);
		const spot = cellSpot('c2');
		selectRange(spot.pos, spot.pos + 2);
		const clip = clipboard({ 'text/plain': 'x\ny' });
		await fireEvent.paste(view().dom, { clipboardData: clip.api });
		await settle();
		const m = handle().model();
		const r = serializeMarkdown(m.state.doc, m.origin, m.generation);
		const tableSeg = r.segments[1]!;
		expect(tableSeg.fellBack ?? false, '表のブロックが 3 段目に落ちない').toBe(false);
		expect(tableSeg.warn ?? false).toBe(false);
		expect(r.text).toBe(TABLE.replace('| c2 | d2 |', '| x y | d2 |'));
		await saveFileEditor(handle());
		await settleLong();
		expect(handle().dirty).toBe(false);
		const saved = invokeMock.mock.calls.find(([n]) => n === 'save_document')![1] as { content: string };
		expect(tableRows(saved.content)).toBe(tableRows(TABLE));
		const reparsed = handle().model().state.doc;
		expect(reparsed.child(1).type.name).toBe('table');
		expect(reparsed.child(1).childCount, '表の行の数(見出し+2)').toBe(3);
	});

	it('セルの中の Tab / Shift + Tab は今のまま(次 / 前のセルへ)', async () => {
		await mountMd(TABLE);
		const spot = cellSpot('c1');
		selectRange(spot.pos + 1, spot.pos + 1);
		key('Tab');
		await settle();
		expect(view().state.selection.$from.parent.textContent).toBe('d1');
		key('Tab', { shiftKey: true });
		await settle();
		expect(view().state.selection.$from.parent.textContent).toBe('c1');
		expect(text()).toBe(TABLE);
	});

	it('段落への複数行の貼り付けは今のまま(空行で段落に分け、行の中の改行は soft break)=退行なし', async () => {
		await mountMd(TABLE);
		const spot = textSpots(view().state.doc, 2)[0]!;
		selectRange(spot.pos + 6, spot.pos + 6);
		const clip = clipboard({ 'text/plain': 'one\ntwo\n\nthree' });
		await fireEvent.paste(view().dom, { clipboardData: clip.api });
		await settle();
		expect(text()).toContain('After.one\ntwo\n\nthree');
	});
});

// ---------------------------------------------------------------------------
// 要件74 第3段 3-1 — 入力規則と gap cursor の配線(AC-74-26・AC-74-51・AC-74-58 (1) の面の分・由谷の決定 2026-11-17 昼)
// 確定契約は src/editor/input-rules.acceptance.test.ts と gap-cursor.acceptance.test.ts の先頭。面の plugin=
// [markdownInputRules(), keymap(MARKDOWN_KEYMAP), ...markdownGapCursor(), mermaidActivePlugin]。Edit ▸ Undo(beforeinput の historyUndo)は
// 面の handleDOMEvents.beforeinput で undoInputRule を先に当てる(契約11=Command + Z と同じ結果)。
// ---------------------------------------------------------------------------

describe('3-1: 入力規則と gap cursor の配線(AC-74-26・AC-74-51・AC-74-58 (1))', () => {
	const ABC = 'abc\n';

	function typeChars(s: string) {
		const v = view();
		for (const ch of Array.from(s)) {
			const { from, to } = v.state.selection;
			const deflt = () => v.state.tr.insertText(ch, from, to);
			const handled = v.someProp('handleTextInput', (f) => f(v, from, to, ch, deflt));
			if (!handled) v.dispatch(deflt());
		}
	}
	function cursorAt(block: number, col = 0) {
		const spot = textSpots(view().state.doc, block)[0]!;
		selectRange(spot.pos + col, spot.pos + col);
	}
	function blockNamesOf(): string[] {
		const out: string[] = [];
		view().state.doc.forEach((n) => out.push(n.type.name));
		return out;
	}

	it('面の plugin に入力規則(isInputRules)と gap cursor(createSelectionBetween)があり、入力規則は keymap より前', async () => {
		await mountMd(ABC);
		const plugins = view().state.plugins;
		const rulesAt = plugins.findIndex((p) => (p.spec as { isInputRules?: boolean }).isInputRules === true);
		expect(rulesAt, '入力規則の plugin').toBeGreaterThanOrEqual(0);
		const gapAt = plugins.findIndex((p) => typeof p.props.createSelectionBetween === 'function');
		expect(gapAt, 'gap cursor の plugin').toBeGreaterThanOrEqual(0);
		const keymapAt = plugins.findIndex(
			(p, i) => i !== rulesAt && i !== gapAt && typeof p.props.handleKeyDown === 'function' && typeof p.props.createSelectionBetween !== 'function'
		);
		expect(keymapAt, 'keymap の plugin').toBeGreaterThanOrEqual(0);
		expect(rulesAt).toBeLessThan(keymapAt);
	});

	it('MarkdownEditor.svelte の <style> に .ProseMirror-gapcursor の見た目がある(ソース走査)', async () => {
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const src = readFileSync(resolve(__dirname, 'MarkdownEditor.svelte'), 'utf8');
		expect(src).toContain('ProseMirror-gapcursor');
	});

	it("面で '## ' と打つと見出し 2 になり、dirty・text() が追う。Control + Z で '## abc' の文字に戻り、もう 1 回で原文(dirty でない)", async () => {
		await mountMd(ABC);
		cursorAt(0);
		typeChars('## ');
		expect(blockNamesOf()).toEqual(['heading']);
		expect(text()).toBe('## abc\n');
		expect(handle().dirty).toBe(true);
		key('z', { ctrlKey: true });
		await settle();
		expect(blockNamesOf()).toEqual(['paragraph']);
		expect(view().state.doc.child(0).textContent).toBe('## abc');
		key('z', { ctrlKey: true });
		await settle();
		expect(text()).toBe(ABC);
		expect(handle().dirty).toBe(false);
	});

	it("Edit ▸ Undo(beforeinput の historyUndo)も規則の直後なら '**x**' の文字に戻る(Command + Z と同じ結果)。もう 1 回で原文", async () => {
		await mountMd(ABC);
		cursorAt(0);
		typeChars('**x**');
		const x = view().state.doc.child(0).child(0);
		expect(x.text).toBe('x');
		expect(x.marks.map((m) => m.type.name)).toEqual(['strong']);
		beforeInput('historyUndo');
		await settle();
		expect(view().state.doc.child(0).textContent).toBe('**x**abc');
		expect(view().state.doc.child(0).child(0).marks).toHaveLength(0);
		beforeInput('historyUndo');
		await settle();
		expect(text()).toBe(ABC);
	});

	it("規則の直後の Backspace で '- abc' の文字に戻る(3-5)", async () => {
		await mountMd(ABC);
		cursorAt(0);
		typeChars('- ');
		expect(blockNamesOf()).toEqual(['bullet_list']);
		key('Backspace');
		await settle();
		expect(blockNamesOf()).toEqual(['paragraph']);
		expect(view().state.doc.child(0).textContent).toBe('- abc');
	});

	it('変換中(view.composing)は変わらず、確定した文字が規則の終わりに掛かる compositionend の後に 1 回だけ変わる', async () => {
		await mountMd(ABC);
		cursorAt(0);
		composition('compositionstart');
		await settle();
		expect(view().composing).toBe(true);
		typeChars('## ');
		expect(blockNamesOf(), '変換中は文字のまま').toEqual(['paragraph']);
		view().dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '## ' }));
		await settleLong();
		await new Promise((r) => setTimeout(r, 50));
		expect(blockNamesOf()).toEqual(['heading']);
		expect(text()).toBe('## abc\n');
	});

	it("確定した文字が無い compositionend(変換の取り消し)では、カーソルの前が '**x**' でも変わらない", async () => {
		await mountMd(ABC);
		cursorAt(0);
		composition('compositionstart');
		await settle();
		typeChars('**x**');
		view().dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
		await settleLong();
		await new Promise((r) => setTimeout(r, 50));
		expect(view().state.doc.child(0).textContent).toBe('**x**abc');
		expect(view().state.doc.child(0).child(0).marks).toHaveLength(0);
	});

	it("'## x' と '**y**' の text/plain の貼り付けは文字のまま(規則は打鍵だけ=AC-74-20 の第2段の分は無改変)", async () => {
		await mountMd(ABC);
		cursorAt(0);
		const clip = clipboard({ 'text/plain': '## x **y** ' });
		await fireEvent.paste(view().dom, { clipboardData: clip.api });
		await settle();
		expect(blockNamesOf()).toEqual(['paragraph']);
		expect(view().state.doc.child(0).textContent).toBe('## x **y** abc');
		view().state.doc.child(0).forEach((n) => expect(n.marks).toHaveLength(0));
	});

	it("raw(View ▸ Raw Source)の CodeMirror に '## ' を打っても文字のまま(規則は Markdown の面だけ)", async () => {
		const { container } = await mountMd(ABC);
		handle().toggleRaw();
		await settleLong();
		const root = container.querySelector<HTMLElement>('[data-testid="raw-source-editor"]');
		expect(root, 'raw の面').not.toBeNull();
		const { EditorView: CMView } = await import('@codemirror/view');
		const cm = CMView.findFromDOM(root!);
		expect(cm, 'CodeMirror の view').toBeTruthy();
		cm!.dispatch({ changes: { from: 0, insert: '## ' } });
		await settle();
		expect(handle().text()).toBe('## abc\n');
		expect(handle().raw).toBe(true);
	});

	it('gap cursor: 生 HTML の塊 2 つの間に段落を打てる(前後は byte 等価)', async () => {
		// prosemirror-gapcursor を直接 import しない(この file の既存の件を道連れにしない)。GapCursor は Selection.jsonID('gapcursor') で登録される
		const { Selection } = await import('prosemirror-state');
		const src = '<div>\na\n</div>\n\n<div>\nb\n</div>\n';
		await mountMd(src);
		expect(blockNamesOf()).toEqual(['html_block', 'html_block']);
		view().dispatch(view().state.tr.setSelection(Selection.fromJSON(view().state.doc, { type: 'gapcursor', pos: 1 })));
		expect(view().state.selection.toJSON()).toEqual({ type: 'gapcursor', pos: 1 });
		typeChars('x');
		await settle();
		expect(blockNamesOf()).toEqual(['html_block', 'paragraph', 'html_block']);
		expect(text()).toBe('<div>\na\n</div>\n\nx\n\n<div>\nb\n</div>\n');
		expect(handle().dirty).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 要件74 第3段 3-2 — Format ▸ Table の配線(AC-74-53 (6)(7)(8)・AC-74-54【3-10】の面の分)。契約は src/editor/table-commands.acceptance.test.ts の先頭。
// 経路は +page の menu_format → runFormatCommand(id, windowState.fileEditor)(既存の配線のまま=ID が増えるだけ)
// ---------------------------------------------------------------------------

describe('3-2: Format ▸ Table の配線(runFormatCommand 経由・IME・Enter)', () => {
	const TABLE_DOC = 'intro\n\n| h1 | h2 |\n| - | - |\n| a1 | a2 |\n| b1 | b2 |\n\nafter\n';
	type TableId = Parameters<typeof runFormatCommand>[0];

	function cursorInCell(cellText: string) {
		const v = view();
		let pos = -1;
		v.state.doc.descendants((n, p) => {
			if (pos >= 0) return false;
			if (n.isText && n.text === cellText) pos = p;
			return pos < 0;
		});
		expect(pos, `セル '${cellText}'`).toBeGreaterThan(0);
		selectRange(pos + 1, pos + 1);
	}
	function tableRows(): number {
		let rows = -1;
		view().state.doc.descendants((n) => {
			if (rows >= 0) return false;
			if (n.type.name === 'table') rows = n.childCount;
			return rows < 0;
		});
		return rows;
	}

	it('Insert Row Below を面に当てると表の行が 1 つ増え、dirty になり、text() の表の外は byte 等価。undo 1 回で原文', async () => {
		await mountMd(TABLE_DOC);
		cursorInCell('a1');
		const depth = undoDepth(view().state);
		expect(runFormatCommand('format-table-row-below' as TableId, handle())).toBe(true);
		await settle();
		expect(tableRows()).toBe(4);
		expect(handle().dirty).toBe(true);
		expect(undoDepth(view().state)).toBe(depth + 1);
		const out = text();
		expect(out.startsWith('intro\n\n| h1 | h2 |\n')).toBe(true);
		expect(out.endsWith('|\n\nafter\n')).toBe(true);
		key('z', { ctrlKey: true });
		await settle();
		expect(text()).toBe(TABLE_DOC);
		expect(handle().dirty).toBe(false);
	});

	it('Delete Table で表が消え、カーソルは after の先頭。Delete Column を列 2 つに 2 回で表が消える', async () => {
		await mountMd(TABLE_DOC);
		cursorInCell('b2');
		expect(runFormatCommand('format-table-delete' as TableId, handle())).toBe(true);
		await settle();
		expect(text()).toBe('intro\n\nafter\n');
		expect(view().state.selection.$from.parent.textContent).toBe('after');

		key('z', { ctrlKey: true });
		await settle();
		expect(text()).toBe(TABLE_DOC);
		cursorInCell('a1');
		expect(runFormatCommand('format-table-delete-column' as TableId, handle())).toBe(true);
		await settle();
		expect(runFormatCommand('format-table-delete-column' as TableId, handle())).toBe(true);
		await settle();
		expect(text()).toBe('intro\n\nafter\n');
	});

	it('表の外(段落)では 7 つとも false で文書は不変・dirty でない', async () => {
		await mountMd(TABLE_DOC);
		const spot = textSpots(view().state.doc, 0)[0]!;
		selectRange(spot.pos + 2, spot.pos + 2);
		for (const id of [
			'format-table-row-above',
			'format-table-row-below',
			'format-table-column-left',
			'format-table-column-right',
			'format-table-delete-row',
			'format-table-delete-column',
			'format-table-delete',
		] as TableId[]) {
			expect(runFormatCommand(id, handle()), id).toBe(false);
		}
		await settle();
		expect(text()).toBe(TABLE_DOC);
		expect(handle().dirty).toBe(false);
	});

	it('IME の変換中に来た Table の項目は確定の後に 1 回だけ当たる(2 回来ても 1 回=行は 1 つ増える)', async () => {
		await mountMd(TABLE_DOC);
		cursorInCell('a2');
		composition('compositionstart');
		await settle();
		expect(view().composing).toBe(true);
		expect(runFormatCommand('format-table-row-below' as TableId, handle())).toBe(false);
		expect(runFormatCommand('format-table-row-below' as TableId, handle())).toBe(false);
		expect(tableRows(), '変換中は当たらない').toBe(3);
		composition('compositionend');
		await settleLong();
		await new Promise((r) => setTimeout(r, 50));
		expect(tableRows(), '確定の後に 1 回だけ').toBe(4);
	});

	it('セルの中の Enter(keydown)で 1 つ下のセルの先頭へ・最後の行では何も起きない・文書は不変', async () => {
		await mountMd(TABLE_DOC);
		cursorInCell('a2');
		key('Enter');
		await settle();
		expect(view().state.selection.$from.parent.textContent).toBe('b2');
		expect(view().state.selection.$from.parentOffset).toBe(0);
		key('Enter');
		await settle();
		expect(view().state.selection.$from.parent.textContent).toBe('b2');
		expect(text()).toBe(TABLE_DOC);
		expect(handle().dirty).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 要件74 第3段 3-5 — Markdown として貼り付け(AC-74-57)とドロップ(AC-74-58 (1)(4))。由谷の決定 2026-11-17 昼 3-17・3-18。
// 純関数の契約は src/editor/paste-markdown.acceptance.test.ts の先頭。面の契約:
// - text/plain の貼り付け(ProseMirror の切片でない)の直後、shouldOfferMarkdownPaste(text) なら面の根の中に
//   <button data-testid="paste-as-markdown">Paste as Markdown</button> を出す(code fence の中・表のセル・読み取り専用・raw では出さない)
// - 押すと貼った範囲を parseMarkdownFragment(text, doc) で取引 1 つで置き換える(段落 1 つならインライン=新しいブロックを作らない。
//   undo 1 段で文字の貼り付け・もう 1 段で貼る前)。札は次の取引(打鍵・選択の移動・外部変更)か Esc で消え、別の貼り付けで差し替わる
// - facePlugins に dropCursor({ color: false, class: 'vellis-dropcursor' })(prosemirror-dropcursor)。handleDrop は handlePaste と同じ規則:
//   data-pm-slice の無い text/html は text/plain の文字で入れる(外の HTML を構造にしない)。同じ面の中の選択のドロップは移動(取引 1 つ)
// ---------------------------------------------------------------------------

describe('3-5: Markdown として貼り付け(AC-74-57)', () => {
	const BADGE = '[data-testid="paste-as-markdown"]';
	const PLAIN = 'abcdef\n\nafter\n';

	function badge(container: ParentNode): HTMLElement | null {
		return q(container, `${FACE} ${BADGE}`) ?? q(container, BADGE);
	}
	async function paste(s: string) {
		const clip = clipboard({ 'text/plain': s });
		await fireEvent.paste(view().dom, { clipboardData: clip.api });
		await settleLong();
	}
	async function press(container: ParentNode) {
		const b = badge(container);
		expect(b, '札 paste-as-markdown').not.toBeNull();
		await fireEvent.click(b!);
		await settleLong();
	}

	it("'## a\\n\\n- b' を段落に貼ると文字のまま入り、札が出る(文言は英語・button)。押すと見出し 2 と箇条書き(取引 1 つ)。undo 1 回で文字の貼り付け、もう 1 回で貼る前", async () => {
		const { container } = await mountMd(PLAIN);
		expect(badge(container), '貼る前は札なし').toBeNull();
		const spot = textSpots(view().state.doc, 0)[0]!;
		selectRange(spot.pos + 6, spot.pos + 6);
		await paste('## a\n\n- b');
		const literal = text();
		expect(view().state.doc.child(0).textContent).toBe('abcdef## a');
		expect(view().state.doc.child(1).textContent).toBe('- b');
		expect(view().state.doc.child(1).type.name).toBe('paragraph');
		const b = badge(container)!;
		expect(b).not.toBeNull();
		expect(b.tagName).toBe('BUTTON');
		expect(b.textContent?.trim()).toBe('Paste as Markdown');
		const depth = undoDepth(view().state);
		await press(container);
		const names: string[] = [];
		view().state.doc.forEach((n) => names.push(n.type.name));
		expect(names).toEqual(['paragraph', 'heading', 'bullet_list', 'paragraph']);
		expect(view().state.doc.child(1).attrs.level).toBe(2);
		expect(view().state.doc.child(1).textContent).toBe('a');
		expect(view().state.doc.child(2).textContent).toBe('b');
		expect(text()).toBe('abcdef\n\n## a\n\n- b\n\nafter\n');
		expect(undoDepth(view().state)).toBe(depth + 1);
		expect(badge(container), '押したら札は消える').toBeNull();
		key('z', { ctrlKey: true });
		await settle();
		expect(text(), 'undo 1 回で文字の貼り付け').toBe(literal);
		key('z', { ctrlKey: true });
		await settle();
		expect(text(), 'もう 1 回で貼る前').toBe(PLAIN);
	});

	it("'**x**' を段落の途中に貼って押すと、その段落の中で強い強調になる(新しいブロックを作らない)", async () => {
		const { container } = await mountMd(PLAIN);
		const spot = textSpots(view().state.doc, 0)[0]!;
		selectRange(spot.pos + 3, spot.pos + 3);
		await paste('**x**');
		expect(view().state.doc.child(0).textContent).toBe('abc**x**def');
		await press(container);
		expect(view().state.doc.childCount).toBe(2);
		const shape: Array<[string, string[]]> = [];
		view().state.doc.child(0).forEach((n) => shape.push([n.text ?? '', n.marks.map((m) => m.type.name)]));
		expect(shape).toEqual([
			['abc', []],
			['x', ['strong']],
			['def', []],
		]);
		expect(text()).toBe('abc**x**def\n\nafter\n');
	});

	it('札が出ない: 読んでも文字と同じ(abc)・ProseMirror の切片の貼り付け・code fence の中・表のセル', async () => {
		const { container } = await mountMd(PLAIN);
		const spot = textSpots(view().state.doc, 0)[0]!;
		selectRange(spot.pos + 6, spot.pos + 6);
		await paste('abc');
		expect(badge(container), 'abc').toBeNull();

		const clip = clipboard({ 'text/html': '<p data-pm-slice="1 1 []">## a</p>', 'text/plain': '## a' });
		await fireEvent.paste(view().dom, { clipboardData: clip.api });
		await settleLong();
		expect(badge(container), 'PM の切片').toBeNull();

		cleanup();
		windowState.clearDocument();
		windowState.fileEditor = null;
		const fence = await mountMd('```\ncode\n```\n\n| a | b |\n| - | - |\n| c | d |\n');
		const code = textSpots(view().state.doc, 0)[0]!;
		selectRange(code.pos, code.pos);
		await paste('## a\n\n- b');
		expect(badge(fence.container), 'code fence の中').toBeNull();
		const cell = textSpots(view().state.doc, 1).find((s) => s.text === 'c')!;
		selectRange(cell.pos + 1, cell.pos + 1);
		await paste('## a\n\n- b');
		expect(badge(fence.container), '表のセル').toBeNull();
		expect(view().state.doc.child(1).childCount, 'セルは 1 行の文字(2-6)で表は割れない').toBe(2);
	});

	it('札は次の打鍵・選択の移動・Esc で消え、別の貼り付けで差し替わる(押すと後の貼り付けだけが読み直される)', async () => {
		const { container } = await mountMd(PLAIN);
		const spot = textSpots(view().state.doc, 0)[0]!;
		selectRange(spot.pos + 6, spot.pos + 6);
		await paste('**x**');
		expect(badge(container)).not.toBeNull();
		type('q', 0, 0);
		await settleLong();
		expect(badge(container), '打鍵で消える').toBeNull();

		await paste('**x**');
		expect(badge(container)).not.toBeNull();
		selectRange(spot.pos, spot.pos);
		await settleLong();
		expect(badge(container), '選択の移動で消える').toBeNull();

		await paste('**y**');
		expect(badge(container)).not.toBeNull();
		key('Escape');
		await settleLong();
		expect(badge(container), 'Esc で消える').toBeNull();
		expect(view().state.doc.child(0).textContent, 'Esc では文書は変わらない').toContain('**y**');

		cleanup();
		windowState.clearDocument();
		windowState.fileEditor = null;
		const two = await mountMd(PLAIN);
		const s2 = textSpots(view().state.doc, 0)[0]!;
		selectRange(s2.pos + 6, s2.pos + 6);
		await paste('**a**');
		const after = textSpots(view().state.doc, 1)[0]!; // 'after'(PLAIN はブロック 2 つ・**a** はインラインなので増えない)
		selectRange(after.pos, after.pos);
		await paste('**b**');
		expect(two.container.querySelectorAll(BADGE)).toHaveLength(1);
		await press(two.container);
		expect(view().state.doc.child(0).textContent, '先の貼り付けは文字のまま').toBe('abcdef**a**');
		const shape: Array<[string, string[]]> = [];
		view().state.doc.child(1).forEach((n) => shape.push([n.text ?? '', n.marks.map((m) => m.type.name)]));
		expect(shape, '後の貼り付けだけが強調に').toEqual([
			['b', ['strong']],
			['after', []],
		]);
	});

	it("先頭が '---' の文字を押して入れても front matter にならない", async () => {
		const { container } = await mountMd(PLAIN);
		const spot = textSpots(view().state.doc, 0)[0]!;
		selectRange(spot.pos + 6, spot.pos + 6);
		await paste('---\ntitle: x\n---');
		await press(container);
		const names: string[] = [];
		view().state.doc.forEach((n) => names.push(n.type.name));
		expect(names).not.toContain('front_matter');
		expect(names).toContain('horizontal_rule');
	});

	it('文書に [^1] があるとき [^1] を含む文字を押して入れると、入れた側が [^2](参照と定義)', async () => {
		const { container } = await mountMd('Text[^1] here.\n\n[^1]: first.\n');
		const spot = textSpots(view().state.doc, 0)[0]!;
		selectRange(spot.pos + 4, spot.pos + 4);
		await paste('see[^1]\n\n[^1]: note');
		await press(container);
		const labels: string[] = [];
		view().state.doc.descendants((n) => {
			if (n.type.name === 'footnote_reference') labels.push(`ref:${n.attrs.label}`);
			if (n.type.name === 'footnote_definition') labels.push(`def:${n.attrs.label}`);
			return true;
		});
		expect(labels.sort()).toEqual(['def:1', 'def:2', 'ref:1', 'ref:2']);
		expect(text()).toContain('[^2]: note');
		expect(text()).toContain('[^1]: first.');
	});

	it("書き出し: 入れたブロックは文書の流儀('*' のリストの文書に '- b' を貼って押すと '* b')・外は byte 等価", async () => {
		const src = '* one\n* two\n\npara\n\ntail\n';
		const { container } = await mountMd(src);
		const spot = textSpots(view().state.doc, 1)[0]!; // 'para'
		selectRange(spot.pos + 4, spot.pos + 4);
		await paste('\n\n- b\n- c');
		await press(container);
		const out = text();
		expect(out.startsWith('* one\n* two\n\npara\n')).toBe(true);
		expect(out.endsWith('\ntail\n')).toBe(true);
		expect(out).toContain('* b\n* c');
		expect(out).not.toContain('- b');
	});
});

describe('3-5: ドロップ(AC-74-58 (1)(4))', () => {
	/** jsdom に DragEvent が無いので MouseEvent に dataTransfer を付ける。posAtCoords はレイアウトが無いので instance で差し替える。 */
	function dropAt(v: EditorView, pos: number, data: Record<string, string>) {
		const ev = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
		const types = Object.keys(data);
		Object.defineProperty(ev, 'dataTransfer', {
			value: { getData: (t: string) => data[t] ?? '', types, files: [], dropEffect: 'copy', effectAllowed: 'all' },
		});
		(v as unknown as { posAtCoords: () => { pos: number; inside: number } | null }).posAtCoords = () => ({ pos, inside: -1 });
		v.dom.dispatchEvent(ev);
		return ev;
	}

	it('facePlugins に dropCursor があり(ソース走査: prosemirror-dropcursor・vellis-dropcursor)、見た目は <style> に', async () => {
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const src = readFileSync(resolve(__dirname, 'MarkdownEditor.svelte'), 'utf8');
		expect(src).toMatch(/from 'prosemirror-dropcursor'/);
		expect(src).toContain('dropCursor(');
		expect(src).toContain('vellis-dropcursor');
	});

	it('data-pm-slice の無い text/html のドロップは text/plain の文字で入る(外の HTML を構造にしない)', async () => {
		await mountMd('abcdef\n');
		const v = view();
		const spot = textSpots(v.state.doc, 0)[0]!;
		const ev = dropAt(v, spot.pos + 3, { 'text/html': '<b>bold</b> <a href="https://x.example">link</a>', 'text/plain': 'bold link' });
		await settleLong();
		expect(ev.defaultPrevented).toBe(true);
		expect(v.state.doc.child(0).textContent).toBe('abcbold linkdef');
		v.state.doc.child(0).forEach((n) => expect(n.marks).toHaveLength(0));
		expect(text()).toBe('abcbold linkdef\n');
	});

	it('同じ面の中の選択のドロップは移動(取引 1 つ=undo 1 段で戻る)', async () => {
		await mountMd('abcdef\n\nafter\n');
		const v = view();
		const spot = textSpots(v.state.doc, 0)[0]!;
		selectRange(spot.pos, spot.pos + 3); // 'abc'
		const slice = v.state.selection.content();
		(v as unknown as { dragging: { slice: unknown; move: boolean } | null }).dragging = { slice, move: true };
		const after = textSpots(v.state.doc, 1)[0]!;
		const depth = undoDepth(v.state);
		dropAt(v, after.pos + 5, { 'text/html': '<p data-pm-slice="1 1 []">abc</p>', 'text/plain': 'abc' });
		await settleLong();
		expect(text()).toBe('def\n\nafterabc\n');
		expect(undoDepth(v.state)).toBe(depth + 1);
		key('z', { ctrlKey: true });
		await settle();
		expect(text()).toBe('abcdef\n\nafter\n');
	});
});

// ---------------------------------------------------------------------------
// 要件74 第4段 4-5 — リンクの欄(モックの画面2 の D・契約8 の Link…・契約17 の (aa)・由谷の決定 2026-11-17 午後 4-10)。
//
// 確定契約(implementer はこれに従う):
// - FORMAT_COMMANDS['format-link'] はリンクの中でも外でも false(取引なし)。runFormatCommand が false なら面の openLinkInput() が欄を開く(2-2 のまま)
// - 欄(2-2 の link-input を置き換える。面の根の中・.ProseMirror の兄弟。新しい .svelte にするなら AC-56-3 に足す=合図で):
//   <div class="link-editor" data-testid="link-editor" role="dialog" aria-label="Link">
//     <label>Text <input data-testid="link-text" aria-label="Text"></label> <label>Link <input data-testid="link-url" aria-label="Link" placeholder="https://"></label>
//     <button data-testid="link-remove">Remove Link</button>(リンクの外から開いたときは disabled か出さない) <button data-testid="link-done">Done</button>
//   開く: リンクの外=選んだ範囲(空なら単語。単語の上でもなければ開かない)。Text=選んだ文字・Link=選んだ文字が URL ならそれ、でなければ空。フォーカスは Link の欄
//        リンクの中(カーソルか選択がリンクの mark の中)=範囲はそのリンクの mark が続く範囲。Text=リンクの文言・Link=href。フォーカスは Link の欄
//   Done / どちらの欄の Enter(isComposing は送らない)= 1 取引で文言と行き先の両方を替える(Text が変われば範囲の文字を Text に・Link を href に。
//        Text と Link が同じなら kind literal=素の URL のまま・違えば inline)。Link が空なら何もしない(欄は閉じる)。欄は閉じる・undo 1 段で戻る
//   Remove Link= 1 取引で範囲の link の mark を外す(文言は残る)・欄は閉じる。Esc= 閉じて文書は不変
//   普通のクリックは航行のまま((aa))=欄は開かない。<style> はトークンだけ・@media print { .link-editor { display: none } }(print.css は触らない)
// ---------------------------------------------------------------------------

describe('4-5: リンクの欄(Text と Link・Remove Link・Done)', () => {
	const EDITOR = `${FACE} [data-testid="link-editor"]`;
	const TEXT = `${FACE} [data-testid="link-text"]`;
	const URL = `${FACE} [data-testid="link-url"]`;
	const REMOVE = `${FACE} [data-testid="link-remove"]`;
	const DONE = `${FACE} [data-testid="link-done"]`;
	const LINKED = 'see [here](https://a.example/old) now\n';

	function linkMark(): { href: string; kind: string; text: string } | null {
		let found: { href: string; kind: string; text: string } | null = null;
		view().state.doc.descendants((n) => {
			const m = n.marks.find((x) => x.type.name === 'link');
			if (m && !found) found = { href: m.attrs.href as string, kind: m.attrs.kind as string, text: n.text ?? '' };
			return !found;
		});
		return found;
	}
	async function openInLink() {
		const link = textSpots(view().state.doc, 0).find((s) => s.marks.includes('link'))!;
		selectRange(link.pos + 1, link.pos + 1);
		expect(runFormatCommand('format-link', handle()), 'Command は false').toBe(false);
		await settleLong();
	}

	it('リンクの中で Link…(Command + K)→ 欄が開き Text=文言・Link=href が入っている(すぐ外さない・文書は不変)。Remove Link は押せる', async () => {
		const { container } = await mountMd(LINKED);
		await openInLink();
		const editor = q(container, EDITOR);
		expect(editor, 'link-editor').not.toBeNull();
		expect(editor!.closest('.ProseMirror')).toBeNull();
		expect(q(container, `${FACE} [data-testid="link-input"]`), '2-2 の URL だけの欄は無い').toBeNull();
		const textInput = q(container, TEXT) as HTMLInputElement;
		const urlInput = q(container, URL) as HTMLInputElement;
		expect(textInput.value).toBe('here');
		expect(textInput.getAttribute('aria-label')).toBe('Text');
		expect(urlInput.value).toBe('https://a.example/old');
		expect(urlInput.getAttribute('aria-label')).toBe('Link');
		expect(document.activeElement).toBe(urlInput);
		const remove = q(container, REMOVE) as HTMLButtonElement;
		expect(remove.textContent?.trim()).toBe('Remove Link');
		expect(remove.disabled).toBe(false);
		expect(q(container, DONE)?.textContent?.trim()).toBe('Done');
		expect(text()).toBe(LINKED);
		expect(handle().dirty).toBe(false);
	});

	it('Done で文言と行き先の両方が 1 取引で変わる(undo 1 段で元)。欄は閉じる', async () => {
		const { container } = await mountMd(LINKED);
		await openInLink();
		const depth = undoDepth(view().state);
		await fireEvent.input(q(container, TEXT)!, { target: { value: 'there' } });
		await fireEvent.input(q(container, URL)!, { target: { value: 'https://b.example/new' } });
		await fireEvent.click(q(container, DONE)!);
		await settleLong();
		expect(text()).toBe('see [there](https://b.example/new) now\n');
		expect(linkMark()).toEqual({ href: 'https://b.example/new', kind: 'inline', text: 'there' });
		expect(undoDepth(view().state)).toBe(depth + 1);
		expect(q(container, EDITOR)).toBeNull();
		key('z', { ctrlKey: true });
		await settle();
		expect(text()).toBe(LINKED);
	});

	it('Text の欄の Enter でも Link の欄の Enter でも適用(isComposing の Enter は送らない)。行き先だけ・文言だけの変更も 1 取引', async () => {
		const { container } = await mountMd(LINKED);
		await openInLink();
		await fireEvent.input(q(container, URL)!, { target: { value: 'https://c.example' } });
		await fireEvent.keyDown(q(container, URL)!, { key: 'Enter', isComposing: true });
		await settleLong();
		expect(text(), '変換確定の Enter では適用しない').toBe(LINKED);
		expect(q(container, EDITOR)).not.toBeNull();
		await fireEvent.keyDown(q(container, URL)!, { key: 'Enter' });
		await settleLong();
		expect(text()).toBe('see [here](https://c.example) now\n');
		await openInLink();
		const depth = undoDepth(view().state);
		await fireEvent.input(q(container, TEXT)!, { target: { value: 'HERE' } });
		await fireEvent.keyDown(q(container, TEXT)!, { key: 'Enter' });
		await settleLong();
		expect(text()).toBe('see [HERE](https://c.example) now\n');
		expect(undoDepth(view().state)).toBe(depth + 1);
	});

	it('Esc で閉じて文書は不変(欄を書き換えていても)', async () => {
		const { container } = await mountMd(LINKED);
		await openInLink();
		await fireEvent.input(q(container, TEXT)!, { target: { value: 'changed' } });
		await fireEvent.input(q(container, URL)!, { target: { value: 'https://x.example' } });
		await fireEvent.keyDown(q(container, URL)!, { key: 'Escape' });
		await settleLong();
		expect(q(container, EDITOR)).toBeNull();
		expect(text()).toBe(LINKED);
		expect(handle().dirty).toBe(false);
	});

	it('Remove Link で mark が外れ、文言は残る(1 取引・undo 1 段)。欄は閉じる', async () => {
		const { container } = await mountMd(LINKED);
		await openInLink();
		const depth = undoDepth(view().state);
		await fireEvent.click(q(container, REMOVE)!);
		await settleLong();
		expect(text()).toBe('see here now\n');
		expect(linkMark()).toBeNull();
		expect(undoDepth(view().state)).toBe(depth + 1);
		expect(q(container, EDITOR)).toBeNull();
		key('z', { ctrlKey: true });
		await settle();
		expect(text()).toBe(LINKED);
	});

	it('リンクの外(選んだ範囲)から開くと Text=選んだ文字・Link=空。Remove Link は押せない(disabled か無い)。Done で新しく付く', async () => {
		const { container } = await mountMd(MD);
		const spot = textSpots(view().state.doc, 2)[0]!; // 'Second paragraph here.'
		selectRange(spot.pos, spot.pos + 6);
		runFormatCommand('format-link', handle());
		await settleLong();
		expect((q(container, TEXT) as HTMLInputElement).value).toBe('Second');
		expect((q(container, URL) as HTMLInputElement).value).toBe('');
		expect(document.activeElement).toBe(q(container, URL));
		const remove = q(container, REMOVE) as HTMLButtonElement | null;
		expect(remove === null || remove.disabled, 'リンクの外では Remove Link は押せない').toBe(true);
		await fireEvent.input(q(container, URL)!, { target: { value: 'https://example.com/second' } });
		await fireEvent.click(q(container, DONE)!);
		await settleLong();
		expect(text()).toBe(MD.replace('Second paragraph here.', '[Second](https://example.com/second) paragraph here.'));
	});

	it('Done で Text も替えると、選んだ範囲の文字が Text になってリンクが付く(1 取引)', async () => {
		const { container } = await mountMd(MD);
		const spot = textSpots(view().state.doc, 2)[0]!;
		selectRange(spot.pos, spot.pos + 6);
		runFormatCommand('format-link', handle());
		await settleLong();
		const depth = undoDepth(view().state);
		await fireEvent.input(q(container, TEXT)!, { target: { value: 'The second' } });
		await fireEvent.input(q(container, URL)!, { target: { value: 'https://example.com/2' } });
		await fireEvent.click(q(container, DONE)!);
		await settleLong();
		expect(text()).toBe(MD.replace('Second paragraph here.', '[The second](https://example.com/2) paragraph here.'));
		expect(undoDepth(view().state)).toBe(depth + 1);
	});

	it('Link が空のままの Done は何もしない(欄は閉じる・文書は不変)', async () => {
		const { container } = await mountMd(MD);
		const spot = textSpots(view().state.doc, 2)[0]!;
		selectRange(spot.pos, spot.pos + 6);
		runFormatCommand('format-link', handle());
		await settleLong();
		await fireEvent.click(q(container, DONE)!);
		await settleLong();
		expect(q(container, EDITOR)).toBeNull();
		expect(text()).toBe(MD);
		expect(handle().dirty).toBe(false);
	});

	it('literal のリンク(素の URL)の中で開くと Text も Link も URL。そのまま Done なら不変(literal のまま)。Text だけ替えると [文言](URL)', async () => {
		const src = 'see https://a.example/path now\n';
		const { container } = await mountMd(src);
		await openInLink();
		expect((q(container, TEXT) as HTMLInputElement).value).toBe('https://a.example/path');
		expect((q(container, URL) as HTMLInputElement).value).toBe('https://a.example/path');
		await fireEvent.click(q(container, DONE)!);
		await settleLong();
		expect(text()).toBe(src);
		expect(linkMark()?.kind).toBe('literal');
		expect(handle().dirty).toBe(false);
		await openInLink();
		await fireEvent.input(q(container, TEXT)!, { target: { value: 'the path' } });
		await fireEvent.click(q(container, DONE)!);
		await settleLong();
		expect(text()).toBe('see [the path](https://a.example/path) now\n');
		expect(linkMark()?.kind).toBe('inline');
	});

	it('Text と Link を同じ URL にして Done → literal(素の URL のまま・`[url](url)` にならない)', async () => {
		const { container } = await mountMd('see docs now\n');
		const spot = textSpots(view().state.doc, 0)[0]!;
		const start = spot.pos + 'see '.length;
		selectRange(start, start + 4);
		runFormatCommand('format-link', handle());
		await settleLong();
		await fireEvent.input(q(container, TEXT)!, { target: { value: 'https://d.example' } });
		await fireEvent.input(q(container, URL)!, { target: { value: 'https://d.example' } });
		await fireEvent.click(q(container, DONE)!);
		await settleLong();
		expect(text()).toBe('see https://d.example now\n');
		expect(linkMark()?.kind).toBe('literal');
	});

	it('普通のクリックは航行のまま((aa))=欄は開かない', async () => {
		const { container } = await mountMd(LINKED);
		const a = container.querySelector<HTMLAnchorElement>(`${PM} a[href="https://a.example/old"]`);
		expect(a, 'リンクの DOM').not.toBeNull();
		await fireEvent.click(a!, { button: 0 });
		await settleLong();
		expect(q(container, EDITOR), 'クリックでは欄を開かない').toBeNull();
		expect(openUrlMock).toHaveBeenCalledWith('https://a.example/old');
		expect(text()).toBe(LINKED);
	});

	it('見た目と印刷(ソース走査): 欄を持つ部品の <style> はトークンだけで、@media print で .link-editor を隠す。print.css は無改変', async () => {
		const { readFileSync, readdirSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const dir = resolve(__dirname);
		const owner = readdirSync(dir)
			.filter((f) => f.endsWith('.svelte'))
			.map((f) => ({ f, src: readFileSync(resolve(dir, f), 'utf8') }))
			.find(({ src }) => src.includes('data-testid="link-editor"'));
		expect(owner, 'link-editor を持つ .svelte').toBeTruthy();
		const style = (owner!.src.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
		expect(/@media\s+print\s*\{[\s\S]*?\.link-editor[^{}]*\{[^}]*display\s*:\s*none/.test(style), `${owner!.f} の @media print`).toBe(true);
		const printCss = readFileSync(resolve(__dirname, '../styles/print.css'), 'utf8');
		expect(printCss).not.toContain('link-editor');
	});
});

// 4-5 の参照のリンク(由谷の決定 2026-11-17): [文言][ref] の Text だけ直すと参照のまま・Link を替えると inline(定義の行は残る)・何も変えずに Done で取引なし
describe('4-5: 参照のリンク([文言][ref])', () => {
	const EDITOR = `${FACE} [data-testid="link-editor"]`;
	const TEXT = `${FACE} [data-testid="link-text"]`;
	const URL = `${FACE} [data-testid="link-url"]`;
	const DONE = `${FACE} [data-testid="link-done"]`;
	const REF = 'see [here][ref] now\n\n[ref]: https://e.example/r\n';

	function refMark(): Record<string, unknown> | null {
		let found: Record<string, unknown> | null = null;
		view().state.doc.descendants((n) => {
			const m = n.marks.find((x) => x.type.name === 'link');
			if (m && !found) found = { ...m.attrs, text: n.text };
			return !found;
		});
		return found;
	}
	async function openInRef() {
		const link = textSpots(view().state.doc, 0).find((s) => s.marks.includes('link'))!;
		selectRange(link.pos + 1, link.pos + 1);
		expect(runFormatCommand('format-link', handle())).toBe(false);
		await settleLong();
		expect(q(container!, EDITOR)).not.toBeNull();
	}
	let container: HTMLElement | null = null;

	it('開くと Text=文言。Link は空か定義の URL(参照なので)', async () => {
		({ container } = await mountMd(REF));
		expect(refMark()).toMatchObject({ kind: 'reference', identifier: 'ref' });
		await openInRef();
		expect((q(container, TEXT) as HTMLInputElement).value).toBe('here');
		expect(['', 'https://e.example/r']).toContain((q(container, URL) as HTMLInputElement).value);
	});

	it('Text だけ直して Done → [新しい文言][ref] のまま(referenceType・identifier を保つ)・定義の行は不変・1 取引', async () => {
		({ container } = await mountMd(REF));
		await openInRef();
		const depth = undoDepth(view().state);
		await fireEvent.input(q(container, TEXT)!, { target: { value: 'there' } });
		await fireEvent.click(q(container, DONE)!);
		await settleLong();
		expect(text()).toBe('see [there][ref] now\n\n[ref]: https://e.example/r\n');
		expect(refMark()).toMatchObject({ kind: 'reference', identifier: 'ref', referenceType: 'full', text: 'there' });
		expect(undoDepth(view().state)).toBe(depth + 1);
	});

	it('Link を替えて Done → [文言](新しい URL) の inline・定義の行はそのまま残る・1 取引', async () => {
		({ container } = await mountMd(REF));
		await openInRef();
		const depth = undoDepth(view().state);
		await fireEvent.input(q(container, URL)!, { target: { value: 'https://new.example/x' } });
		await fireEvent.click(q(container, DONE)!);
		await settleLong();
		expect(text()).toBe('see [here](https://new.example/x) now\n\n[ref]: https://e.example/r\n');
		expect(refMark()).toMatchObject({ kind: 'inline', href: 'https://new.example/x', text: 'here' });
		expect(undoDepth(view().state)).toBe(depth + 1);
	});

	it('何も変えずに Done → 取引が出ない(undoDepth 不変・dirty でない)。欄は閉じる', async () => {
		({ container } = await mountMd(REF));
		await openInRef();
		const depth = undoDepth(view().state);
		await fireEvent.click(q(container, DONE)!);
		await settleLong();
		expect(q(container, EDITOR)).toBeNull();
		expect(undoDepth(view().state)).toBe(depth);
		expect(text()).toBe(REF);
		expect(handle().dirty).toBe(false);
	});
});

// 4-5 の参照のリンクの形(オーケストレーター 2026-11-17): 文言が鍵を兼ねる collapsed([文言][])と shortcut([文言])は、文言だけ変えると参照が切れるので
// referenceType を full にして [新しい文言][元の鍵] にする。full([文言][ref])はそのまま [新しい文言][ref]。
describe('4-5: 参照のリンクの形(collapsed / shortcut は full に)', () => {
	const EDITOR = `${FACE} [data-testid="link-editor"]`;
	const TEXT = `${FACE} [data-testid="link-text"]`;
	const DONE = `${FACE} [data-testid="link-done"]`;

	function refMark(): Record<string, unknown> | null {
		let found: Record<string, unknown> | null = null;
		view().state.doc.descendants((n) => {
			const m = n.marks.find((x) => x.type.name === 'link');
			if (m && !found) found = { ...m.attrs, text: n.text };
			return !found;
		});
		return found;
	}
	async function renameLink(container: HTMLElement, to: string) {
		const link = textSpots(view().state.doc, 0).find((s) => s.marks.includes('link'))!;
		selectRange(link.pos + 1, link.pos + 1);
		expect(runFormatCommand('format-link', handle())).toBe(false);
		await settleLong();
		expect(q(container, EDITOR)).not.toBeNull();
		const depth = undoDepth(view().state);
		await fireEvent.input(q(container, TEXT)!, { target: { value: to } });
		await fireEvent.click(q(container, DONE)!);
		await settleLong();
		expect(undoDepth(view().state), '1 取引').toBe(depth + 1);
	}

	it('collapsed([here][])の Text を there に → [there][here](full・identifier は元の鍵)・定義の行は不変', async () => {
		const src = 'see [here][] now\n\n[here]: https://e.example/r\n';
		const { container } = await mountMd(src);
		expect(refMark()).toMatchObject({ kind: 'reference', identifier: 'here', referenceType: 'collapsed' });
		await renameLink(container, 'there');
		expect(text()).toBe('see [there][here] now\n\n[here]: https://e.example/r\n');
		expect(refMark()).toMatchObject({ kind: 'reference', identifier: 'here', referenceType: 'full', text: 'there' });
	});

	it('shortcut([here])の Text を there に → [there][here](full)・定義の行は不変', async () => {
		const src = 'see [here] now\n\n[here]: https://e.example/r\n';
		const { container } = await mountMd(src);
		expect(refMark()).toMatchObject({ kind: 'reference', identifier: 'here', referenceType: 'shortcut' });
		await renameLink(container, 'there');
		expect(text()).toBe('see [there][here] now\n\n[here]: https://e.example/r\n');
		expect(refMark()).toMatchObject({ kind: 'reference', identifier: 'here', referenceType: 'full', text: 'there' });
	});

	it('collapsed / shortcut で何も変えずに Done → 取引なし・綴りもそのまま', async () => {
		for (const src of ['see [here][] now\n\n[here]: https://e.example/r\n', 'see [here] now\n\n[here]: https://e.example/r\n']) {
			cleanup();
			windowState.clearDocument();
			windowState.fileEditor = null;
			const { container } = await mountMd(src);
			const link = textSpots(view().state.doc, 0).find((s) => s.marks.includes('link'))!;
			selectRange(link.pos + 1, link.pos + 1);
			runFormatCommand('format-link', handle());
			await settleLong();
			const depth = undoDepth(view().state);
			await fireEvent.click(q(container, DONE)!);
			await settleLong();
			expect(undoDepth(view().state), src).toBe(depth);
			expect(text(), src).toBe(src);
		}
	});
});

// 要件74 締め(P2): 見出しの中の Shift + Enter は取引なし(文書不変・dirty でない・undoDepth 不変)=AC-74-54 の表のセルと同じ扱い
describe('締め P2: 見出しの中の Shift + Enter は何もしない(h1・h2・h3・h6)', () => {
	for (const level of [1, 2, 3, 6]) {
		it(`h${level}: 文書不変・dirty でない・undoDepth 不変・keydown は面が受ける`, async () => {
			const src = `${'#'.repeat(level)} alpha beta\n\npara\n`;
			await mountMd(src);
			const spot = textSpots(view().state.doc, 0)[0]!;
			selectRange(spot.pos + 5, spot.pos + 5);
			const depth = undoDepth(view().state);
			const ev = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
			view().dom.dispatchEvent(ev);
			await settle();
			expect(ev.defaultPrevented).toBe(true);
			expect(text()).toBe(src);
			expect(handle().dirty).toBe(false);
			expect(undoDepth(view().state)).toBe(depth);
			let hb = 0;
			view().state.doc.descendants((n) => {
				if (n.type.name === 'hard_break') hb++;
				return true;
			});
			expect(hb).toBe(0);
		});
	}
});

// ---------------------------------------------------------------------------
// 要件74 締めの 5 周目(P2-a・reviewer の観察 2026-11-17 夜): 見出しに hard_break が入る Format ▸ Heading のほかの 5 経路
// (1) 見出しの直後の段落(hard_break を持つ)の先頭で Backspace(joinBackward)(2) 見出しの末尾で Delete(joinForward)
// (3) hard_break を持つ段落の先頭で `### ` を打つ入力規則(textblockRule の setBlockType)(4) ProseMirror の切片(hard_break を含む)を
// 見出しの中へ貼る(data-pm-slice は既定のまま通る)(5) Markdown として貼る札(段落 1 つは見出しの中へインラインで入る)。
// 期待(オーケストレーターの判断): どの経路でも見出しの中の hard_break は soft_break に替わる(実装の案=appendTransaction で 1 か所に寄せる。
// 作りは実装裁量=面の実物で見る)。見出しの中に hard_break 0・読み直して見出し 1 つ(同じ形)・warn なし・ほかは byte のまま。
// 修正前: 見出しに hard_break が残り、h3〜h6 は `### headalpha  \nbeta` と書かれて読み直すと見出しと段落に割れる(warn)。
// 見出しは ATX(`#`)だけで見る(setext の見出しは hard_break を正しく持てる=reviewer の注記。ここでは扱わない)。
// ---------------------------------------------------------------------------

describe('締め 5 周目 P2-a: 見出しに hard_break が入る経路(Backspace・Delete・入力規則・PM の切片・Markdown として貼る)→ 見出しの中は soft_break', () => {
	function typeChars(s: string) {
		const v = view();
		for (const ch of Array.from(s)) {
			const { from, to } = v.state.selection;
			const deflt = () => v.state.tr.insertText(ch, from, to);
			const handled = v.someProp('handleTextInput', (f) => f(v, from, to, ch, deflt));
			if (!handled) v.dispatch(deflt());
		}
	}
	function inlineNames(block: number): string[] {
		const out: string[] = [];
		view().state.doc.child(block).forEach((c) => out.push(c.isText ? `"${c.text}"` : c.type.name));
		return out;
	}
	/** 見出し(最上位ブロック `block`)が 1 行で書かれ、読み直して同じ形・warn なし・前後は byte のまま。 */
	function expectOneLineHeading(block: number, level: number, head: string, tail: string) {
		const h = view().state.doc.child(block);
		expect(h.type.name).toBe('heading');
		expect(h.attrs.level).toBe(level);
		expect(inlineNames(block), '見出しの中の hard_break は soft_break に替わる').toEqual(['"headalpha"', 'soft_break', '"beta"']);
		const m = handle().model();
		const r = serializeMarkdown(m.state.doc, m.origin, m.generation);
		expect(r.text).toBe(text());
		expect(r.text.startsWith(head), `前は byte のまま: ${JSON.stringify(r.text)}`).toBe(true);
		expect(r.text.endsWith(tail), `後ろは byte のまま: ${JSON.stringify(r.text)}`).toBe(true);
		const back = parseMarkdownDocument(r.text).doc;
		expect(back.childCount, `見出しが割れない: ${JSON.stringify(r.text)}`).toBe(m.state.doc.childCount);
		expect(back.child(block).type.name).toBe('heading');
		for (let i = 0; i < back.childCount; i++) expect(shapeEqual(back.child(i), m.state.doc.child(i)), `ブロック ${i} の形`).toBe(true);
		expect(
			r.segments.map((s) => s.warn ?? false),
			'検算に落ちない',
		).toEqual(r.segments.map(() => false));
	}

	for (const level of [1, 3, 6]) {
		it(`(1) h${level}: 見出しの直後の段落(\`alpha  \\nbeta\`)の先頭で Backspace → 見出しにつながり、中の hard_break は soft_break`, async () => {
			const src = `intro\n\n${'#'.repeat(level)} head\n\nalpha  \nbeta\n\nafter\n`;
			await mountMd(src);
			const alpha = textSpots(view().state.doc, 2)[0]!;
			selectRange(alpha.pos, alpha.pos);
			key('Backspace');
			await settle();
			expect(view().state.doc.childCount, '段落は見出しにつながる').toBe(3);
			expectOneLineHeading(1, level, 'intro\n\n', '\n\nafter\n');
		});
	}

	it('(2) h3: 見出しの末尾で Delete → 後ろの段落(`alpha  \\nbeta`)が見出しにつながり、中の hard_break は soft_break', async () => {
		const src = 'intro\n\n### head\n\nalpha  \nbeta\n\nafter\n';
		await mountMd(src);
		const head = textSpots(view().state.doc, 1)[0]!;
		selectRange(head.pos + 4, head.pos + 4);
		key('Delete');
		await settle();
		expect(view().state.doc.childCount, '段落は見出しにつながる').toBe(3);
		expectOneLineHeading(1, 3, 'intro\n\n', '\n\nafter\n');
	});

	it('(3) h3: hard_break を持つ段落(`headalpha  \\nbeta`)の先頭で `### ` を打つ(入力規則)→ 見出し 3・中の hard_break は soft_break', async () => {
		const src = 'intro\n\nheadalpha  \nbeta\n\nafter\n';
		await mountMd(src);
		const p = textSpots(view().state.doc, 1)[0]!;
		selectRange(p.pos, p.pos);
		typeChars('### ');
		await settle();
		expectOneLineHeading(1, 3, 'intro\n\n', '\n\nafter\n');
	});

	it('(4) h3: ProseMirror の切片(段落の中の `alpha` HB `beta`)を見出しの末尾に貼る → 中の hard_break は soft_break・元の段落は byte のまま', async () => {
		const src = 'intro\n\n### head\n\nalpha  \nbeta\n\nafter\n';
		await mountMd(src);
		const v = view();
		const spots = textSpots(v.state.doc, 2);
		const last = spots[spots.length - 1]!;
		selectRange(spots[0]!.pos, last.pos + last.text.length);
		const clip = clipboard();
		await fireEvent.copy(v.dom, { clipboardData: clip.api });
		await settle();
		const html = clip.data.get('text/html') ?? '';
		expect(html).toContain('data-pm-slice');
		const head = textSpots(view().state.doc, 1)[0]!;
		selectRange(head.pos + 4, head.pos + 4);
		await fireEvent.paste(v.dom, { clipboardData: clipboard({ 'text/html': html, 'text/plain': clip.data.get('text/plain') ?? '' }).api });
		await settleLong();
		expect(view().state.doc.childCount, '新しいブロックはできない').toBe(4);
		expectOneLineHeading(1, 3, 'intro\n\n', '\n\nalpha  \nbeta\n\nafter\n');
	});

	it('(5) h3: 見出しの末尾に `alpha  \\nbeta` を貼って札(Paste as Markdown)を押す → 段落 1 つが見出しの中に入り、中の hard_break は soft_break', async () => {
		const src = 'intro\n\n### head\n\nafter\n';
		const { container } = await mountMd(src);
		const head = textSpots(view().state.doc, 1)[0]!;
		selectRange(head.pos + 4, head.pos + 4);
		await fireEvent.paste(view().dom, { clipboardData: clipboard({ 'text/plain': 'alpha  \nbeta' }).api });
		await settleLong();
		const badge = q(container, '[data-testid="paste-as-markdown"]');
		expect(badge, '札 paste-as-markdown').not.toBeNull();
		await fireEvent.click(badge!);
		await settleLong();
		expect(view().state.doc.childCount, '新しいブロックはできない').toBe(3);
		expectOneLineHeading(1, 3, 'intro\n\n', '\n\nafter\n');
	});
});

// ---------------------------------------------------------------------------
// 要件74 締めの 6 周目(P2-c・reviewer の観察 2026-11-17 夜): setext の見出しの hard_break は触らない
// 5 周目の headingSoftBreakPlugin(見出しの中の hard_break を soft_break に替える appendTransaction)が、触っていない setext の見出しの
// hard_break まで替える(文書のどこかで 1 文字打つと `alpha  \nbeta\n=====` が `alpha\nbeta\n=====` に)。契約6 の 1(触っていない
// ブロックは byte のまま)に反し、見える改行も空白に変わる。undo の後もまた替わり元の byte に戻らない(dirty のまま)。
// 期待(オーケストレーターの判断): setext の見出し(attrs.setext が真)は替えない(setext は hard_break を正しく書ける)。
// ATX の見出しに入った hard_break は今のまま soft_break に替わる(対照=上の「締め 5 周目 P2-a」の 7 件で足りるので足さない)。
// ---------------------------------------------------------------------------

describe('締め 6 周目 P2-c: setext の見出しの hard_break は触らない(別のブロックを直しても見出しは byte のまま)', () => {
	const H1 = 'alpha  \nbeta\n=====';
	const H2 = 'alpha\\\nbeta\n-----';
	const CASES = [
		['setext h1(空白 2 つの hard break)', H1, 1],
		['setext h2(バックスラッシュの hard break)', H2, 2],
	] as const;

	function hardBreaksInHeading(): number {
		const h = view().state.doc.child(0);
		expect(h.type.name).toBe('heading');
		let n = 0;
		h.forEach((c) => {
			if (c.type.name === 'hard_break') n++;
		});
		return n;
	}
	function warns(): boolean[] {
		const m = handle().model();
		return serializeMarkdown(m.state.doc, m.origin, m.generation).segments.map((s) => s.warn ?? false);
	}

	for (const [label, heading, level] of CASES) {
		it(`${label}: 前提=開いた直後の見出しは level ${level}・setext・hard_break 1 つ`, async () => {
			await mountMd(`${heading}\n\npara\n`);
			const h = view().state.doc.child(0);
			expect(h.attrs.level).toBe(level);
			expect(h.attrs.setext).toBe(true);
			expect(hardBreaksInHeading()).toBe(1);
		});

		it(`${label}: para に 1 文字打つ → 見出しは byte のまま・hard_break も残る・書き出しの差は para の行だけ`, async () => {
			const src = `${heading}\n\npara\n`;
			await mountMd(src);
			type('X', 1, 4);
			await settle();
			expect(text()).toBe(`${heading}\n\nparaX\n`);
			expect(hardBreaksInHeading(), '見出しの hard_break は soft_break に替わらない').toBe(1);
			expect(warns()).toEqual([false, false]);
		});

		it(`${label}: para に打ってから undo → 元の byte に戻り dirty でない`, async () => {
			const src = `${heading}\n\npara\n`;
			await mountMd(src);
			type('X', 1, 4);
			await settle();
			key('z', { ctrlKey: true });
			await settle();
			expect(text()).toBe(src);
			expect(handle().dirty).toBe(false);
			expect(hardBreaksInHeading()).toBe(1);
		});

		it(`${label}: para に打った後に外部変更(tail の行・重ならない)を取り込む → 見出しは byte のまま`, async () => {
			const src = `${heading}\n\npara\n\ntail\n`;
			await mountMd(src);
			type('X', 1, 4);
			await settle();
			const incoming = src.replace('tail', 'tail THEIRS');
			expect(windowState.applyFileChanged(doc(MD_URI, incoming))).toBe('apply');
			await settle();
			expect(text()).toBe(`${heading}\n\nparaX\n\ntail THEIRS\n`);
			expect(hardBreaksInHeading()).toBe(1);
			expect(warns()).toEqual([false, false, false]);
		});

		it(`${label}: 触らずに外部変更(tail の行)を取り込む → 見出しは byte のまま`, async () => {
			const src = `${heading}\n\npara\n\ntail\n`;
			await mountMd(src);
			const incoming = src.replace('tail', 'tail THEIRS');
			windowState.applyFileChanged(doc(MD_URI, incoming));
			await settle();
			expect(text()).toBe(incoming);
			expect(hardBreaksInHeading()).toBe(1);
			expect(handle().dirty).toBe(false);
		});

		it(`${label}: raw(View ▸ Raw Source)で para を直して戻り、tail に打つ → 見出しは byte のまま`, async () => {
			const src = `${heading}\n\npara\n\ntail\n`;
			const { container } = await mountMd(src);
			handle().toggleRaw();
			await settleLong();
			const root = container.querySelector<HTMLElement>('[data-testid="raw-source-editor"]');
			expect(root, 'raw の面').not.toBeNull();
			const { EditorView: CMView } = await import('@codemirror/view');
			const cm = CMView.findFromDOM(root!);
			expect(cm, 'CodeMirror の view').toBeTruthy();
			const at = src.indexOf('para') + 4;
			cm!.dispatch({ changes: { from: at, insert: 'R' } });
			await settle();
			expect(handle().text()).toBe(src.replace('para', 'paraR'));
			handle().toggleRaw();
			await settleLong();
			expect(handle().raw).toBe(false);
			expect(text(), '戻った直後').toBe(src.replace('para', 'paraR'));
			expect(hardBreaksInHeading()).toBe(1);
			type('Y', 2, 4);
			await settle();
			expect(text()).toBe(`${heading}\n\nparaR\n\ntailY\n`);
			expect(hardBreaksInHeading()).toBe(1);
		});

		it(`${label}: 見出しの中(\`beta\` の後ろ)に 1 文字打つ → hard_break は残り、差はその文字だけ・読み直して同じ形・warn なし`, async () => {
			const src = `${heading}\n\npara\n`;
			await mountMd(src);
			const beta = textSpots(view().state.doc, 0).find((s) => s.text === 'beta')!;
			expect(beta, '見出しの中の beta').toBeTruthy();
			view().dispatch(view().state.tr.insertText('Z', beta.pos + 4));
			await settle();
			expect(hardBreaksInHeading(), 'setext の見出しは hard_break を持てる').toBe(1);
			expect(text()).toBe(src.replace('beta', 'betaZ'));
			const back = parseMarkdownDocument(text()).doc;
			expect(back.childCount).toBe(2);
			for (let i = 0; i < 2; i++) expect(shapeEqual(back.child(i), view().state.doc.child(i)), `ブロック ${i} の形`).toBe(true);
			expect(warns()).toEqual([false, false]);
		});
	}
});
