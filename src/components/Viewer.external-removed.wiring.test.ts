/**
 * 要件#48 追補g — 編集中のファイルの削除(印・帯・Save / Close・印が消えるとき)。
 * 要件74 第2段 2-5(2026-11-17 仮・契約21・契約13・棚卸し 4「書き直し」=承認済み (r)(as)): 今の編集(editMode / editBuffer)の
 * 代わりに新しい面の handle(`windowState.fileEditor`)の dirty で決める。帯・ボタン・文言・title は今のまま(testid も今のまま)。
 * Save は `saveFileEditor`(削除の印があれば expectedHash を省く=契約14)。
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
const SAVE = '[data-testid="external-removed-save"]';
const CLOSE = '[data-testid="external-removed-close"]';
const DIRTY_MESSAGE = 'This file was deleted outside the app. Your edits have not been saved.';

async function mountDirty() {
	const r = await mountText();
	typeCm(r.container, 'my edit\n', 0);
	await settle();
	expect(windowState.dirty).toBe(true);
	return r;
}

describe('AC-48-追g (a): applyFileRemoved — dirty なら保つ・そうでなければ閉じる・別の uri は無視(面の dirty で決める)', () => {
	it('既定では印は立っていない', async () => {
		await mountText();
		expect(windowState.externalRemoved).toBe(false);
	});
	it('dirty の面に同じ uri の削除 → keep: 文書・面・文字列が残り、印が立つ・dirty のまま', async () => {
		const { container } = await mountDirty();
		expect(windowState.applyFileRemoved(TXT_URI)).toBe('keep');
		await settle();
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
		expect(windowState.fileEditor).not.toBeNull();
		expect(handle().text()).toBe('my edit\n' + TXT_CONTENT);
		expect(windowState.externalRemoved).toBe(true);
		expect(windowState.dirty).toBe(true);
		expect(cm(container).state.doc.toString()).toBe('my edit\n' + TXT_CONTENT);
	});
	it('dirty でない面に同じ uri の削除 → close: 閉じて面も外れる(印は立たない)', async () => {
		await mountText();
		expect(windowState.applyFileRemoved(TXT_URI)).toBe('close');
		await settle();
		expect(windowState.currentDocument).toBeNull();
		expect(windowState.fileEditor).toBeNull();
		expect(windowState.externalRemoved).toBe(false);
	});
	it('dirty でも別の uri の削除 → ignore', async () => {
		await mountDirty();
		expect(windowState.applyFileRemoved('file:///Users/a/notes/other.txt')).toBe('ignore');
		expect(windowState.externalRemoved).toBe(false);
		expect(windowState.dirty).toBe(true);
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
	});
	it('文書が無いときの削除 → ignore(落ちない)', () => {
		expect(windowState.applyFileRemoved(TXT_URI)).toBe('ignore');
		expect(windowState.externalRemoved).toBe(false);
	});
});

describe('AC-48-追g (c)(d)(e): 印が消えるとき', () => {
	it('(c) 保存の成功(saveFileEditor)で印と dirty が消え、面は残る。save_document は expectedHash なし', async () => {
		const { container } = await mountDirty();
		windowState.applyFileRemoved(TXT_URI);
		await settle();
		await saveFileEditor(handle());
		await settleLong();
		expect(invokeMock.mock.calls).toEqual([['save_document', { uri: TXT_URI, content: 'my edit\n' + TXT_CONTENT }]]);
		expect(windowState.externalRemoved).toBe(false);
		expect(windowState.dirty).toBe(false);
		expect(q(container, '[data-testid="code-editor"]')).not.toBeNull();
	});
	it('(c) 保存に失敗したら印も dirty も残る', async () => {
		await mountDirty();
		windowState.applyFileRemoved(TXT_URI);
		invokeMock.mockRejectedValueOnce(new Error('disk full'));
		await saveFileEditor(handle());
		await settleLong();
		expect(windowState.externalRemoved).toBe(true);
		expect(windowState.dirty).toBe(true);
		expect(alertMock).toHaveBeenCalledTimes(1);
	});
	it('(d) 印のあと同じ文書の file_changed → 印が消える(置き換えとして扱う=契約12 (e))', async () => {
		await mountDirty();
		windowState.applyFileRemoved(TXT_URI);
		windowState.applyFileChanged(doc(TXT_URI, 'recreated\n'));
		await settleLong();
		expect(windowState.externalRemoved).toBe(false);
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
	});
	it('(e) 別の文書を開く(setDocument)・clearDocument・applyRoot で印が消える', async () => {
		for (const step of ['setDocument', 'clearDocument', 'applyRoot'] as const) {
			cleanup();
			await mountDirty();
			windowState.applyFileRemoved(TXT_URI);
			expect(windowState.externalRemoved).toBe(true);
			if (step === 'setDocument') windowState.setDocument(doc('file:///Users/a/notes/other.txt', 'other\n'));
			else if (step === 'clearDocument') windowState.clearDocument();
			else windowState.applyRoot('file:///Users/b', [], false);
			await settle();
			expect(windowState.externalRemoved, step).toBe(false);
		}
	});
});

describe('AC-48-追g (b)(c): Viewer — 帯(文言・ボタン・title・role)と Save / Close', () => {
	it('dirty の面の削除 → external-removed-banner(role=alert・追補g の文言)が出て、面と文字列は残る', async () => {
		const { container } = await mountDirty();
		windowState.applyFileRemoved(TXT_URI);
		await settleLong();
		const banner = q(container, REMOVED)!;
		expect(banner).not.toBeNull();
		expect(banner.getAttribute('role')).toBe('alert');
		expect(banner.textContent).toContain(DIRTY_MESSAGE);
		expect(q(container, SAVE)!.textContent?.trim()).toBe('Save');
		expect(q(container, SAVE)!.getAttribute('title')).toBe('Save your edits to the file again');
		expect(q(container, CLOSE)!.textContent?.trim()).toBe('Close');
		expect(q(container, CLOSE)!.getAttribute('title')).toBe('Close the file (your edits are discarded)');
		expect(q(container, '[data-testid="code-editor"] .cm-editor')).not.toBeNull();
		expect(handle().text()).toBe('my edit\n' + TXT_CONTENT);
	});
	it('印が無いときは帯が出ない', async () => {
		const { container } = await mountDirty();
		expect(q(container, REMOVED)).toBeNull();
	});
	it('Save → save_document(同じ uri・面の文字列・expectedHash なし)→ 印と dirty と帯が消える', async () => {
		const { container } = await mountDirty();
		windowState.applyFileRemoved(TXT_URI);
		await settleLong();
		await fireEvent.click(q(container, SAVE)!);
		await settleLong();
		expect(invokeMock.mock.calls).toEqual([['save_document', { uri: TXT_URI, content: 'my edit\n' + TXT_CONTENT }]]);
		expect(windowState.externalRemoved).toBe(false);
		expect(windowState.dirty).toBe(false);
		expect(q(container, REMOVED)).toBeNull();
	});
	it('Save が失敗したら印・dirty・帯は残る(文書は閉じない)', async () => {
		const { container } = await mountDirty();
		windowState.applyFileRemoved(TXT_URI);
		await settleLong();
		invokeMock.mockRejectedValueOnce(new Error('EACCES'));
		await fireEvent.click(q(container, SAVE)!);
		await settleLong();
		expect(windowState.externalRemoved).toBe(true);
		expect(windowState.dirty).toBe(true);
		expect(q(container, REMOVED)).not.toBeNull();
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
	});
	it('Close → 文書が閉じ(編集は捨てられ)、save_document は呼ばれない', async () => {
		const { container } = await mountDirty();
		windowState.applyFileRemoved(TXT_URI);
		await settleLong();
		await fireEvent.click(q(container, CLOSE)!);
		await settleLong();
		expect(windowState.currentDocument).toBeNull();
		expect(windowState.fileEditor).toBeNull();
		expect(invokeMock).not.toHaveBeenCalled();
		expect(windowState.externalRemoved).toBe(false);
	});
});

describe('AC-48-追g (f): 配線(ソース走査)', () => {
	const read = async (rel: string) => {
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		return readFileSync(resolve(__dirname, '../..', rel), 'utf8');
	};
	it("+page.svelte の listen('file_removed') の listener は windowState.applyFileRemoved( を通り、直に clearDocument( を呼ばない", async () => {
		const src = await read('src/routes/+page.svelte');
		const at = src.indexOf("'file_removed'");
		expect(at).toBeGreaterThanOrEqual(0);
		const body = src.slice(at, at + 400);
		expect(body).toContain('windowState.applyFileRemoved(');
		expect(body).not.toContain('clearDocument(');
		expect(src.split("'file_removed'").length - 1).toBe(1);
	});
	it('window-state.svelte.ts の applyFileRemoved の本体が dirty(面の dirty)を見て clearDocument( に分岐する', async () => {
		const src = await read('src/stores/window-state.svelte.ts');
		const at = src.indexOf('applyFileRemoved(uri');
		expect(at).toBeGreaterThanOrEqual(0);
		const body = src.slice(at, at + 700);
		expect(body).toMatch(/this\.dirty|fileEditor\?\.dirty|fileEditor\.dirty/);
		expect(body).toContain('clearDocument(');
		expect(body).not.toContain('externalChange');
	});
});
