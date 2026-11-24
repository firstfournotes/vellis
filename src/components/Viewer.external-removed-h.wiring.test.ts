/**
 * 要件#48 追補h — 外部変更の帯の上の削除・原文に戻したときの帯・同じ中身の作り直し・画像の削除。
 * 要件74 第2段 2-5(2026-11-17 仮・契約21・契約12・13・棚卸し 4「書き直し」=承認済み (r)(as)): 今の編集の代わりに新しい面の handle。
 * 「外部変更の帯」は面の重なりの帯(`external-conflict-banner`)。文言と title は今のまま。
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
const CONFLICT = '[data-testid="external-conflict-banner"]';
const SAVE = '[data-testid="external-removed-save"]';
const CLOSE = '[data-testid="external-removed-close"]';
const THEIRS = 'THEIRS first line\nsecond line\nthird line\n';

async function mountDirty() {
	const r = await mountText();
	typeCm(r.container, 'MINE ', 0);
	await settle();
	expect(windowState.dirty).toBe(true);
	return r;
}
/** 打った文字を消して原文に戻す(dirty が偽に)。 */
async function revert(container: ParentNode) {
	const v = cm(container);
	v.dispatch({ changes: { from: 0, to: 'MINE '.length, insert: '' } });
	await settle();
	expect(handle().text()).toBe(TXT_CONTENT);
	expect(windowState.dirty).toBe(false);
}

describe('AC-48-追h (a): 重なりの帯が出ている dirty の面の削除 → 削除の帯だけが出る', () => {
	it('external-conflict-banner が出ている dirty の面の削除 → 重なりの帯が消え、削除の帯が出る。面と文字列は残る', async () => {
		const { container } = await mountDirty();
		expect(windowState.applyFileChanged(doc(TXT_URI, THEIRS))).toBe('external-conflict');
		await settleLong();
		expect(q(container, CONFLICT)).not.toBeNull();
		expect(windowState.applyFileRemoved(TXT_URI)).toBe('keep');
		await settleLong();
		expect(q(container, CONFLICT), '重なりの帯は畳む(同時に出さない)').toBeNull();
		expect(q(container, REMOVED)).not.toBeNull();
		expect(handle().text()).toBe('MINE ' + TXT_CONTENT);
		expect(windowState.dirty).toBe(true);
		expect(q(container, '[data-testid="code-editor"] .cm-editor')).not.toBeNull();
	});
});

describe('AC-48-追h (b): 印が立ったあと原文に戻す → 帯は残り、文言と title が dirty でない版になる', () => {
	it('原文に戻す → dirty が偽・印は下ろさない・帯は残る・文言は未保存の一文を含まない・title は "Save the file again" / "Close the file"', async () => {
		const { container } = await mountDirty();
		windowState.applyFileRemoved(TXT_URI);
		await settleLong();
		await revert(container);
		await settleLong();
		expect(windowState.externalRemoved).toBe(true);
		const banner = q(container, REMOVED)!;
		expect(banner).not.toBeNull();
		expect(banner.textContent).toContain('This file was deleted outside the app.');
		expect(banner.textContent).not.toContain('Your edits have not been saved');
		expect(q(container, SAVE)!.getAttribute('title')).toBe('Save the file again');
		expect(q(container, CLOSE)!.getAttribute('title')).toBe('Close the file');
	});
	it('原文に戻してからもう一度打つ(dirty)→ 追補g の文言と title に戻る', async () => {
		const { container } = await mountDirty();
		windowState.applyFileRemoved(TXT_URI);
		await settleLong();
		await revert(container);
		typeCm(container, 'AGAIN ', 0);
		await settleLong();
		expect(q(container, REMOVED)!.textContent).toContain('Your edits have not been saved.');
		expect(q(container, SAVE)!.getAttribute('title')).toBe('Save your edits to the file again');
		expect(q(container, CLOSE)!.getAttribute('title')).toBe('Close the file (your edits are discarded)');
	});
	it('原文に戻してから Save → save_document が同じ uri と原文で(expectedHash なし)呼ばれ、印と帯が消える', async () => {
		const { container } = await mountDirty();
		windowState.applyFileRemoved(TXT_URI);
		await settleLong();
		await revert(container);
		await fireEvent.click(q(container, SAVE)!);
		await settleLong();
		expect(invokeMock.mock.calls).toEqual([['save_document', { uri: TXT_URI, content: TXT_CONTENT }]]);
		expect(windowState.externalRemoved).toBe(false);
		expect(q(container, REMOVED)).toBeNull();
	});
	it('原文に戻してから Close → 文書が閉じ、save_document は呼ばれない', async () => {
		const { container } = await mountDirty();
		windowState.applyFileRemoved(TXT_URI);
		await settleLong();
		await revert(container);
		await fireEvent.click(q(container, CLOSE)!);
		await settleLong();
		expect(windowState.currentDocument).toBeNull();
		expect(invokeMock).not.toHaveBeenCalled();
	});
});

describe('AC-48-追h (d): dirty の面に、面の文字列と同じ中身の file_changed → apply(帯は出ない)', () => {
	it('同じ中身 → apply・dirty が偽・帯は無し・面は残る', async () => {
		const { container } = await mountDirty();
		expect(windowState.applyFileChanged(doc(TXT_URI, 'MINE ' + TXT_CONTENT))).toBe('apply');
		await settleLong();
		expect(windowState.dirty).toBe(false);
		expect(q(container, CONFLICT)).toBeNull();
		expect(q(container, REMOVED)).toBeNull();
		expect(handle().text()).toBe('MINE ' + TXT_CONTENT);
	});
	it('削除の印が立ったあと同じ中身で作り直された → apply・印も帯も無く dirty が偽', async () => {
		const { container } = await mountDirty();
		windowState.applyFileRemoved(TXT_URI);
		await settleLong();
		expect(windowState.applyFileChanged(doc(TXT_URI, 'MINE ' + TXT_CONTENT))).toBe('apply');
		await settleLong();
		expect(windowState.externalRemoved).toBe(false);
		expect(q(container, REMOVED)).toBeNull();
		expect(q(container, CONFLICT)).toBeNull();
		expect(windowState.dirty).toBe(false);
	});
	it('重なりの帯が出ているところへ、面と同じ中身が届く → apply・帯が畳まれる', async () => {
		const { container } = await mountDirty();
		windowState.applyFileChanged(doc(TXT_URI, THEIRS));
		await settleLong();
		expect(q(container, CONFLICT)).not.toBeNull();
		expect(windowState.applyFileChanged(doc(TXT_URI, 'MINE ' + TXT_CONTENT))).toBe('apply');
		await settleLong();
		expect(q(container, CONFLICT)).toBeNull();
		expect(windowState.dirty).toBe(false);
	});
	it('保存した内容のエコーは ignore-echo(同じ中身の判定より先)', async () => {
		await mountDirty();
		await saveFileEditor(handle());
		await settleLong();
		expect(windowState.applyFileChanged(doc(TXT_URI, 'MINE ' + TXT_CONTENT))).toBe('ignore-echo');
	});
});

describe('AC-48-追h (e): 画像(.png)を表示中にその uri の削除 → close(面が無い=dirty になり得ない)', () => {
	it('close・currentDocument=null・印は立たない・帯なし', async () => {
		const PNG = 'file:///Users/a/notes/pic.png';
		const d = doc(PNG, '');
		windowState.setDocument(d);
		const { container } = render(Viewer, { props: baseProps(d, '', null) });
		await settleLong();
		expect(windowState.fileEditor).toBeNull();
		expect(windowState.applyFileRemoved(PNG)).toBe('close');
		await settleLong();
		expect(windowState.currentDocument).toBeNull();
		expect(windowState.externalRemoved).toBe(false);
		expect(q(container, REMOVED)).toBeNull();
	});
	it('.png を表示中に別の uri の削除 → ignore(画像は残る)', async () => {
		const PNG = 'file:///Users/a/notes/pic.png';
		const d = doc(PNG, '');
		windowState.setDocument(d);
		render(Viewer, { props: baseProps(d, '', null) });
		await settleLong();
		expect(windowState.applyFileRemoved(TXT_URI)).toBe('ignore');
		expect(windowState.currentDocument?.uri).toBe(PNG);
	});
});
