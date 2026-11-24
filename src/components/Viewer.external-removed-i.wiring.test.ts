/**
 * 要件#48 追補i — 印が立って dirty でないときの Command + S は書き戻す。
 * 要件74 第2段 2-5(2026-11-17 仮・契約21・契約14・棚卸し 4「書き直し」=承認済み (r)(as)): `shouldSaveOnCommand(mode, dirty, removed)` は
 * 撤去され、同じ判断は `saveFileEditor(handle)`(dirty でも externalRemoved でもなければ何もしない・removed なら expectedHash を省く)が持つ。
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

const REMOVED = '[data-testid="external-removed-banner"]';
const saveCalls = () => invokeMock.mock.calls.filter((c) => c[0] === 'save_document');

async function mountDirty() {
	const r = await mountText();
	typeCm(r.container, 'MINE ', 0);
	await settle();
	return r;
}
async function revert(container: ParentNode) {
	cm(container).dispatch({ changes: { from: 0, to: 'MINE '.length, insert: '' } });
	await settle();
	expect(windowState.dirty).toBe(false);
}

describe('AC-48-追i (c): 印が立って dirty でない面の Command + S(saveFileEditor)は書き戻す', () => {
	it('dirty → 削除(印)→ 原文に戻す → saveFileEditor → save_document が同じ uri と原文で 1 回(expectedHash なし)・印が消える', async () => {
		const { container } = await mountDirty();
		windowState.applyFileRemoved(TXT_URI);
		await revert(container);
		expect(windowState.externalRemoved).toBe(true);
		await saveFileEditor(handle());
		await settleLong();
		expect(saveCalls()).toEqual([['save_document', { uri: TXT_URI, content: TXT_CONTENT }]]);
		expect(windowState.externalRemoved).toBe(false);
	});
	it('印が消えたあとは(dirty も無いので)もう一度 saveFileEditor しても書かない(二重に書き戻さない)', async () => {
		const { container } = await mountDirty();
		windowState.applyFileRemoved(TXT_URI);
		await revert(container);
		await saveFileEditor(handle());
		await settleLong();
		await saveFileEditor(handle());
		await settleLong();
		expect(saveCalls()).toHaveLength(1);
	});
	it('保存が失敗したら印は残る(alert が 1 回)', async () => {
		const { container } = await mountDirty();
		windowState.applyFileRemoved(TXT_URI);
		await revert(container);
		invokeMock.mockRejectedValueOnce(new Error('EACCES'));
		await saveFileEditor(handle());
		await settleLong();
		expect(windowState.externalRemoved).toBe(true);
		expect(alertMock).toHaveBeenCalledTimes(1);
	});
});

describe('AC-48-追i (c) 対照: 印も dirty も無ければ書かない(契約14 の不変)', () => {
	it('未変更・印なし → save_document は呼ばれない(同じ内容を書き戻して mtime を動かさない)', async () => {
		await mountText();
		await saveFileEditor(handle());
		await settleLong();
		expect(saveCalls()).toHaveLength(0);
	});
	it('一度 dirty にして原文に戻した(印なし)→ 書かない', async () => {
		const { container } = await mountDirty();
		await revert(container);
		await saveFileEditor(handle());
		await settleLong();
		expect(saveCalls()).toHaveLength(0);
	});
	it('dirty・印なし → 書く(expectedHash つき)', async () => {
		await mountDirty();
		await saveFileEditor(handle());
		await settleLong();
		expect(saveCalls()).toEqual([['save_document', { uri: TXT_URI, content: 'MINE ' + TXT_CONTENT, expectedHash: contentHash(TXT_CONTENT) }]]);
	});
	it('dirty・印あり → 書く(expectedHash なし=追補g の帯の Save と同じ筋道)', async () => {
		await mountDirty();
		windowState.applyFileRemoved(TXT_URI);
		await saveFileEditor(handle());
		await settleLong();
		expect(saveCalls()).toEqual([['save_document', { uri: TXT_URI, content: 'MINE ' + TXT_CONTENT }]]);
	});
});

describe('AC-48-追i (c): Viewer — 原文に戻した状態で Command + S と同じ経路を通すと帯が消える', () => {
	it('帯あり → saveFileEditor 成功 → 帯が消え、面は残る', async () => {
		const { container } = await mountDirty();
		windowState.applyFileRemoved(TXT_URI);
		await settleLong();
		await revert(container);
		await settleLong();
		expect(q(container, REMOVED)).not.toBeNull();
		await saveFileEditor(handle());
		await settleLong();
		expect(q(container, REMOVED)).toBeNull();
		expect(q(container, '[data-testid="code-editor"] .cm-editor')).not.toBeNull();
	});
	it('保存が失敗したら帯は残る', async () => {
		const { container } = await mountDirty();
		windowState.applyFileRemoved(TXT_URI);
		await settleLong();
		await revert(container);
		invokeMock.mockRejectedValueOnce(new Error('EACCES'));
		await saveFileEditor(handle());
		await settleLong();
		expect(q(container, REMOVED)).not.toBeNull();
	});
});
