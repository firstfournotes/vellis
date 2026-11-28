/**
 * Issue #840 — Raw Source の面(`RawSourceEditor.svelte`)に変換中(IME)の待ちが無く、変換中に届いた外部変更と検索の数え直しがその場で当たる見込み。
 * component プロジェクト・JSDOM に Viewer を載せる(RawSource.wiring.test.ts と同じ家風)。要件74 契約10・契約23(「raw の間の外部変更・保存は
 * 第1段の CodeMirror の面と同じ」)。
 *
 * コードの面(`CodeEditor.svelte`)は contentDOM の compositionstart〜compositionend(と変換中の blur)を自前で数え、変換中は外部変更の取り込み・
 * 検索の語の変更・打鍵の後の数え直しを控えて確定の後に 1 回だけ流す(AC-74-12)。raw の面には composition の受け手が無く、raw の間は
 * ProseMirror の DOM が外れているので `MarkdownEditor` の `composing` も立たない。
 *
 * ## 固定する振る舞い(直った後。コードの面の AC-74-12 と同じ)
 * - raw の変換中に届いた外部変更(`windowState.applyFileChanged`)はその場では当たらず、compositionend の後に 1 回だけ当たる(履歴に積まない・dirty でない)
 * - raw の変換中の FindBar の語の変更は、確定の後に 1 回だけ数える(変換中は件数を張り替えない)
 * - raw の変換中の打鍵の後の数え直し(150ms)は確定まで控え、確定の後に 1 回数え直す
 * - 変換中の blur は確定として扱い、控えた外部変更を当てる(WebKit の compositionend 抜け)
 *
 * ## 判断の記録(test-writer 2026-11-28)
 * - 変換中の印は raw の CodeMirror の contentDOM(`.cm-content`)への CompositionEvent で立てる(CodeEditor.wiring.test.ts の `composition` と同じ)。
 *   直し方(raw の面で受けて MarkdownEditor に知らせる・`createCmFinder` に `composing` を渡す)は縛らない
 * - 件数は FindBar の `[data-testid="find-count"]` の文字で見る(raw の検索は `onFindResults` で Viewer へ返す=既存の作り)
 *
 * ## 修正前に赤になる理由
 * - raw の変換中でも外部変更がその場で当たる(`text()` が incoming になる)。語の変更の件数もその場で出る
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { EditorView as CMView } from '@codemirror/view';
import { undoDepth } from '@codemirror/commands';

import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import type { MarkdownEditorHandle } from '../editor/file-editor';
import { MENU_RAW_SOURCE_EVENT } from '../editor/raw-sync';
import { formatCount } from '$lib/find-in-document';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => undefined), openPath: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), message: vi.fn(), open: vi.fn() }));
vi.mock('$lib/mermaid-mounter', () => ({ mountMermaid: vi.fn(async () => undefined) }));
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
vi.mock('@tauri-apps/api/window', async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	const fake = { label: 'main', emit: vi.fn(async () => undefined), onFocusChanged: vi.fn(async () => () => {}), listen: vi.fn(async () => () => {}) };
	return { ...actual, getCurrentWindow: () => fake };
});
import * as eventsModule from '$lib/events';

const menuHandlers = (eventsModule as unknown as { __eventHandlers: Map<string, Array<(e: { payload: unknown }) => void>> }).__eventHandlers;

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
// フィクスチャと helper
// ---------------------------------------------------------------------------

const MD_URI = 'file:///Users/a/notes/plan.md';
const MD = ['# Plan', '', 'needle one here.', '', 'needle two here.', '', 'needle three here.', '', 'Tail paragraph.', ''].join('\n');

function doc(uri: string, content: string): DocumentPayload {
	return { uri, content, modified: 1 };
}
function baseProps(d: DocumentPayload, html: string, index: SourceIndex | null) {
	return { document: d, html, index, onRequestAddMark: vi.fn(), onToggleMarks: vi.fn(), marksOpen: false, fileEditor: true };
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
async function wait(ms: number) {
	await new Promise((r) => setTimeout(r, ms));
	await settle();
}
async function mountRaw(content = MD) {
	const d = doc(MD_URI, content);
	windowState.setDocument(d);
	const r = await renderMarkdown(content, MD_URI);
	const result = render(Viewer, { props: baseProps(d, r.html, r.index) });
	await settleLong();
	await emitRawSource();
	expect(handle().raw, '前提: raw の面').toBe(true);
	return result;
}

const RAW = 'article.viewer .markdown-body [data-testid="raw-source-editor"]';
const CM = `${RAW} .cm-editor`;

function q(container: ParentNode, selector: string): HTMLElement | null {
	return container.querySelector(selector);
}
function handle(): MarkdownEditorHandle {
	const h = windowState.fileEditor as MarkdownEditorHandle | null;
	if (!h || h.kind !== 'markdown') throw new Error('Markdown の handle が無い');
	return h;
}
function text(): string {
	return handle().text();
}
function cm(container: ParentNode): CMView {
	const el = q(container, CM);
	if (!el) throw new Error('raw の CodeMirror が無い');
	const v = CMView.findFromDOM(el);
	if (!v) throw new Error('EditorView.findFromDOM が null');
	return v;
}
async function emitMenu(event: string) {
	await settle();
	const list = [...(menuHandlers.get(event) ?? [])];
	expect(list.length, `Viewer(か面)が '${event}' を購読していること`).toBeGreaterThan(0);
	for (const h of list) h({ payload: undefined });
	await settleLong();
}
async function emitRawSource() {
	await emitMenu(MENU_RAW_SOURCE_EVENT);
	await wait(20);
}
async function emitMenuFind() {
	await emitMenu('menu_find');
}
async function typeQuery(container: ParentNode, value: string) {
	const input = q(container, '[data-testid="find-input"]') as HTMLInputElement | null;
	expect(input, '検索バーの入力欄').toBeTruthy();
	await fireEvent.input(input!, { target: { value } });
	await settleLong();
	await wait(200);
}
function countText(container: ParentNode): string {
	return (q(container, '[data-testid="find-count"]')?.textContent ?? '').trim();
}
/**
 * raw の変換中の印(CodeMirror の contentDOM への CompositionEvent)。
 * compositionstart の前に jsdom の文書の選択を外す: raw の面は mount で `view.focus()` するので文書の選択が CodeMirror の中にあり、
 * CodeMirror が変換中と見なしている間に行の DOM が差し替わる(文法の遅延読み込み・一致の装飾)と、外れた text node から変換の文脈を
 * 読もうとして jsdom で落ちる(本物のブラウザでは起きない計測の都合。コードの面のテストは面に焦点が無いので当たらない)。
 */
function composition(view: CMView, kind: 'compositionstart' | 'compositionend') {
	if (kind === 'compositionstart') document.getSelection()?.removeAllRanges();
	view.contentDOM.dispatchEvent(new CompositionEvent(kind, { bubbles: true, data: '' }));
}
/** raw での打鍵(1 文字の挿入)。 */
function type(view: CMView, s: string, at: number) {
	view.dispatch({ changes: { from: at, insert: s }, selection: { anchor: at + s.length }, userEvent: 'input.type' });
}

beforeEach(() => {
	windowState.clearDocument();
	windowState.fileEditor = null;
	windowState.editBlocked = false;
	windowState.externalRemoved = false;
	menuHandlers.clear();
	vi.stubGlobal('alert', vi.fn());
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 外部変更
// ---------------------------------------------------------------------------

describe('Issue #840(契約10・23): raw の変換中に届いた外部変更は compositionend の後に 1 回だけ当たる', () => {
	it('変換中は当たらず、確定の後に当たる(履歴に積まない・dirty でない)', async () => {
		const { container } = await mountRaw();
		const view = cm(container);
		composition(view, 'compositionstart');
		await settle();
		const incoming = MD.replace('Tail paragraph.', 'Tail from disk.');
		windowState.applyFileChanged(doc(MD_URI, incoming));
		await settleLong();
		expect(text(), '変換中は当たらない').toBe(MD);
		expect(view.state.doc.toString(), 'raw の文字列も変わらない').toBe(MD);
		const depth = undoDepth(view.state);
		composition(view, 'compositionend');
		await settleLong();
		await wait(20);
		expect(text(), '確定の後に当たる').toBe(incoming);
		expect(cm(container).state.doc.toString()).toBe(incoming);
		expect(undoDepth(cm(container).state), '取り込みは履歴に積まない').toBe(depth);
		expect(handle().dirty).toBe(false);
	});

	it('変換中に blur すると確定として扱い、控えた外部変更が当たる。その後の外部変更はすぐ当たる', async () => {
		const { container } = await mountRaw();
		const view = cm(container);
		composition(view, 'compositionstart');
		await settle();
		const incoming = MD.replace('Tail paragraph.', 'Tail from disk.');
		windowState.applyFileChanged(doc(MD_URI, incoming));
		await settleLong();
		expect(text(), '変換中は当たらない').toBe(MD);
		view.contentDOM.dispatchEvent(new FocusEvent('blur'));
		await settleLong();
		await wait(20);
		expect(text(), 'blur で確定扱い → 当たる').toBe(incoming);
		expect(handle().dirty).toBe(false);
		const again = incoming.replace('needle one', 'needle uno');
		windowState.applyFileChanged(doc(MD_URI, again));
		await settleLong();
		expect(text(), '変換中でないのですぐ当たる').toBe(again);
	});

	it('回帰の守り: 変換中でない raw の外部変更はすぐ当たる', async () => {
		await mountRaw();
		const incoming = MD.replace('Tail paragraph.', 'Tail now.');
		windowState.applyFileChanged(doc(MD_URI, incoming));
		await settleLong();
		expect(text()).toBe(incoming);
		expect(handle().dirty).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 検索
// ---------------------------------------------------------------------------

describe('Issue #840(契約10): raw の変換中の検索の語の変更と数え直しは、確定の後に 1 回だけ', () => {
	it('変換中の FindBar の語の変更は件数を張り替えず、確定の後に出る', async () => {
		const { container } = await mountRaw();
		const view = cm(container);
		await emitMenuFind();
		composition(view, 'compositionstart');
		await settle();
		await typeQuery(container, 'needle');
		expect(countText(container), '変換中は件数(色)を張り替えない').toBe('');
		composition(view, 'compositionend');
		await settleLong();
		await wait(20);
		expect(countText(container)).toBe(formatCount(0, 3, 'needle'));
	});

	it('変換中の打鍵の後は件数を張り直さず、確定の後に 1 回数え直す', async () => {
		const { container } = await mountRaw();
		const view = cm(container);
		await emitMenuFind();
		await typeQuery(container, 'needle');
		expect(countText(container), '前提: 3 件').toBe(formatCount(0, 3, 'needle'));
		composition(view, 'compositionstart');
		await settle();
		// 変換中の打鍵(擬似)で一致が 1 つ増える
		const at = view.state.doc.toString().indexOf('Tail paragraph.');
		type(view, 'needle ', at);
		await wait(300); // 間をおいた数え直し(150ms)を越える
		expect(countText(container), '変換中は張り直さない').toBe(formatCount(0, 3, 'needle'));
		composition(view, 'compositionend');
		await wait(300);
		await settleLong();
		expect(countText(container), '確定の後に 1 回流す').toBe(formatCount(0, 4, 'needle'));
	});

	it('変換中に blur した後の FindBar の語の変更はすぐ当たる', async () => {
		const { container } = await mountRaw();
		const view = cm(container);
		await emitMenuFind();
		composition(view, 'compositionstart');
		await settle();
		view.contentDOM.dispatchEvent(new FocusEvent('blur'));
		await settleLong();
		await typeQuery(container, 'needle');
		expect(countText(container)).toBe(formatCount(0, 3, 'needle'));
	});
});
