/**
 * 要件#84 AC-84-12(今の AI 連携のボタンの出し分け)— 要件74 第2段 2-5(2026-11-17 仮・契約21・棚卸し 8「書き直し」=承認済み (as))で
 * `editable` の分(ダブルクリックで編集に入らない)を外した。面は開いた時点から常に編集できる(契約3)ので、`editable` の prop は無い。
 * 残るのは `aiTools`(Add Instruction・Marks)。
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


import { screen } from '@testing-library/svelte';

function toolbarButton(name: string): HTMLElement | null {
	return screen.queryByRole('button', { name });
}
async function mountTextWith(aiTools: boolean | undefined) {
	const d = doc(TXT_URI, TXT_CONTENT);
	windowState.setDocument(d);
	const props = aiTools === undefined ? baseProps(d, plainTextHtml(TXT_CONTENT), null) : { ...baseProps(d, plainTextHtml(TXT_CONTENT), null), aiTools };
	const r = render(Viewer, { props });
	await settleLong();
	return r;
}
async function mountMdWith(aiTools: boolean | undefined) {
	const d = doc(MD_URI, MD);
	windowState.setDocument(d);
	const rendered = await renderMarkdown(MD, MD_URI);
	const props = aiTools === undefined ? baseProps(d, rendered.html, rendered.index) : { ...baseProps(d, rendered.html, rendered.index), aiTools };
	const r = render(Viewer, { props });
	await settleLong();
	return r;
}

describe('AC-84-12 (1): aiTools={false} — ツールバーは Copy Markdown だけ', () => {
	it('text: Copy Markdown はあり、Add Instruction と Marks のボタンが無い(契約5)', async () => {
		await mountTextWith(false);
		expect(toolbarButton('Copy Markdown')).not.toBeNull();
		expect(toolbarButton('Add Instruction')).toBeNull();
		expect(toolbarButton('Marks')).toBeNull();
	});
	it('Markdown でも同じ', async () => {
		await mountMdWith(false);
		expect(toolbarButton('Copy Markdown')).not.toBeNull();
		expect(toolbarButton('Add Instruction')).toBeNull();
		expect(toolbarButton('Marks')).toBeNull();
	});
});

describe.each([
	{ label: 'aiTools={true}', aiTools: true as boolean | undefined },
	{ label: 'props を渡さない(既定=出る側・契約10)', aiTools: undefined as boolean | undefined },
])('AC-84-12 (2): $label', ({ aiTools }) => {
	it('Copy Markdown・Add Instruction・Marks の 3 つのボタンがある', async () => {
		await mountTextWith(aiTools);
		expect(toolbarButton('Copy Markdown')).not.toBeNull();
		expect(toolbarButton('Add Instruction')).not.toBeNull();
		expect(toolbarButton('Marks')).not.toBeNull();
	});
	it('Marks ボタンは onToggleMarks を呼ぶ(今どおり)', async () => {
		const d = doc(TXT_URI, TXT_CONTENT);
		windowState.setDocument(d);
		const onToggleMarks = vi.fn();
		render(Viewer, { props: { ...baseProps(d, plainTextHtml(TXT_CONTENT), null), ...(aiTools === undefined ? {} : { aiTools }), onToggleMarks } });
		await settleLong();
		await fireEvent.click(toolbarButton('Marks') as HTMLElement);
		expect(onToggleMarks).toHaveBeenCalledTimes(1);
	});
});

describe('撤去の後(契約3・AC-74-25): editable の prop は無く、面は常に編集できる', () => {
	it('aiTools={false} でも面(CodeMirror)は出て打てる・Done Editing のボタンは無い', async () => {
		const { container } = await mountTextWith(false);
		expect(q(container, '[data-testid="code-editor"] .cm-editor')).not.toBeNull();
		expect(toolbarButton('Done Editing')).toBeNull();
		expect(q(container, '[data-testid="edit-done"]')).toBeNull();
		typeCm(container, 'x');
		await settle();
		expect(handle().dirty).toBe(true);
	});
	it('Markdown: ダブルクリックしても contenteditable の数は変わらない(PM の根だけ)', async () => {
		const { container } = await mountMdWith(false);
		const before = editables(container).length;
		expect(before).toBeGreaterThanOrEqual(1);
		await fireEvent.dblClick(q(container, '.markdown-body p')!);
		await settleLong();
		expect(editables(container)).toHaveLength(before);
	});
});

describe('AC-84-10 補: get_build_info が返らないままの featureFlags を legacyUi に通すと閉じた側', () => {
	it('ready が偽のまま・isEnabled は偽・legacyUi → { ai: false }', async () => {
		const { legacyUi } = await import('$lib/legacy-features');
		expect(legacyUi(() => false)).toEqual({ ai: false });
	});
});
