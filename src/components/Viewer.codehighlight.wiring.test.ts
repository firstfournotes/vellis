/**
 * 要件#69(コードのファイルの色)の配線の後継 — 要件74 第2段 2-5(2026-11-17 仮・契約5・契約21・棚卸し 4・7「書き直し」=承認済み (r)(as))。
 *
 * 要件69 の「閲覧は Shiki の色付きの pre・ダブルクリック / Command + E で素テキストの編集面」は、要件74 契約5 で「開いた時点から
 * CodeMirror の面(色は Lezer・そのまま打てる)」に置き換わった。Shiki の `<pre>` は印刷の直前だけ(AC-74-39)。
 * AC-69-8(色付きでも検索の件数は同じ)は CodeMirror の面の全文検索(AC-74-31)として残る。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { EditorView as CMView } from '@codemirror/view';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import { contentHash } from '$lib/document-edit';
import { saveFileEditor, type FileEditorHandle } from '../editor/file-editor';

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
import { message } from '@tauri-apps/plugin-dialog';
import { invoke } from '$lib/ipc';
import * as eventsModule from '$lib/events';

const messageMock = vi.mocked(message);
const invokeMock = vi.mocked(invoke);
const menuHandlers = (eventsModule as unknown as { __eventHandlers: Map<string, Array<(e: { payload: unknown }) => void>> }).__eventHandlers;
const alertMock = vi.fn((_m?: unknown) => {});

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

const TXT_URI = 'file:///Users/a/notes/memo.txt';
const TXT_CONTENT = 'first line\nsecond line\nthird line\n';
const MD_URI = 'file:///Users/a/notes/plan.md';
const MD = '# Plan\n\nIntro paragraph with **bold** word.\n\nSecond paragraph here.\n';

function doc(uri: string, content: string): DocumentPayload {
	return { uri, content, modified: 1 };
}
function plainTextHtml(content: string): string {
	const escaped = content.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
	return `<pre class="vellis-plaintext">\n${escaped}</pre>`;
}
/** 撤去の後の Viewer の props(`fileEditor` / `editable` の prop は無い=常に新しい面)。 */
function baseProps(d: DocumentPayload, html: string, index: SourceIndex | null) {
	return { document: d, html, index, onRequestAddMark: vi.fn(), onToggleMarks: vi.fn(), marksOpen: false };
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
async function mountText(content = TXT_CONTENT, uri = TXT_URI) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const result = render(Viewer, { props: baseProps(d, plainTextHtml(content), null) });
	await settleLong();
	return result;
}
async function mountMd(content = MD, uri = MD_URI) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const r = await renderMarkdown(content, uri);
	const result = render(Viewer, { props: baseProps(d, r.html, r.index) });
	await settleLong();
	return result;
}
function q(container: ParentNode, selector: string): HTMLElement | null {
	return container.querySelector(selector);
}
function handle(): FileEditorHandle {
	const h = windowState.fileEditor;
	if (!h) throw new Error('windowState.fileEditor が登録されていない(新しい面が出ていない)');
	return h;
}
function cm(container: ParentNode): CMView {
	const el = q(container, '[data-testid="code-editor"] .cm-editor');
	if (!el) throw new Error('CodeMirror の面が無い');
	const v = CMView.findFromDOM(el as HTMLElement);
	if (!v) throw new Error('EditorView.findFromDOM が null');
	return v;
}
function typeCm(container: ParentNode, s: string, at = 0) {
	const v = cm(container);
	v.dispatch({ changes: { from: at, insert: s } });
}
function editables(container: ParentNode): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>('[contenteditable="true"]')];
}

beforeEach(() => {
	windowState.clearDocument();
	windowState.fileEditor = null;
	windowState.editBlocked = false;
	windowState.externalRemoved = false;
	menuHandlers.clear();
	invokeMock.mockReset();
	invokeMock.mockImplementation(async () => null);
	messageMock.mockReset();
	alertMock.mockClear();
	vi.stubGlobal('alert', alertMock);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});


const TS_URI = 'file:///Users/a/src/app.ts';
const TS_CONTENT = 'const a = 1;\nconst b = a + 1;\n';

async function mountTs() {
	return mountText(TS_CONTENT, TS_URI);
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
	expect(input).toBeTruthy();
	await fireEvent.input(input!, { target: { value } });
	await settleLong();
	await new Promise((r) => setTimeout(r, 200));
	await settle();
}
const countText = (c: ParentNode) => (q(c, '[data-testid="find-count"]')?.textContent ?? '').trim();

describe('AC-69-7 の後継(契約5): .ts は開いた時点から CodeMirror の面で、色付きのまま打てる', () => {
	it('pre.vellis-plaintext(Shiki)は出ず、.cm-editor の中にトークンの class 付きの span がある・data-vellis-lang=typescript', async () => {
		const { container } = await mountTs();
		expect(q(container, 'pre.vellis-plaintext')).toBeNull();
		const root = q(container, '[data-testid="code-editor"]')!;
		expect(root).not.toBeNull();
		expect(root.getAttribute('data-vellis-lang')).toBe('typescript');
		await new Promise((r) => setTimeout(r, 50));
		await settle();
		expect(cm(container).contentDOM.querySelectorAll('.cm-line span[class]').length, 'Lezer の色').toBeGreaterThan(0);
	});
	it('ダブルクリックしても面は同じ(素テキストの編集面に替わらない)・打つとそのまま dirty', async () => {
		const { container } = await mountTs();
		const before = cm(container);
		await fireEvent.dblClick(q(container, '.markdown-body')!);
		await settleLong();
		expect(cm(container)).toBe(before);
		expect(editables(container)).toHaveLength(1);
		expect(q(container, 'pre.vellis-plaintext')).toBeNull();
		typeCm(container, '// edited\n', 0);
		await settle();
		expect(handle().dirty).toBe(true);
		expect(handle().text()).toBe('// edited\n' + TS_CONTENT);
	});
	it('Command + E(menu_edit)の受け手は無い(撤去)。届いても面は変わらない', async () => {
		const { container } = await mountTs();
		expect(menuHandlers.get('menu_edit') ?? [], 'menu_edit の購読は無い').toHaveLength(0);
		expect(cm(container).state.doc.toString()).toBe(TS_CONTENT);
		expect(handle().dirty).toBe(false);
	});
});

describe('AC-69-8 の後継(AC-74-31): 色付きの .ts に検索を開いても件数は全文の一致の数で、Next で送れ、Esc で閉じる', () => {
	it('件数・Next・Esc', async () => {
		const { container } = await mountTs();
		await emitMenuFind();
		await typeQuery(container, 'const');
		expect(countText(container)).toBe('1 of 2');
		const v = cm(container);
		expect(v.state.doc.sliceString(v.state.selection.main.from, v.state.selection.main.to)).toBe('const');
		const input = q(container, '[data-testid="find-input"]')!;
		await fireEvent.keyDown(input, { key: 'Enter' });
		await settleLong();
		expect(countText(container)).toBe('2 of 2');
		expect(v.state.selection.main.from).toBe(TS_CONTENT.indexOf('const b'));
		await fireEvent.keyDown(input, { key: 'Escape' });
		await settleLong();
		expect(q(container, '[data-testid="find-bar"]')).toBeNull();
		expect(container.querySelectorAll('.cm-vellis-find, .cm-vellis-find-current')).toHaveLength(0);
		expect(handle().dirty).toBe(false);
	});
});
