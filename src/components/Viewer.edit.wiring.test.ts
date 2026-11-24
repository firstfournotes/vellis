/**
 * 要件#48 契約①〜⑥の配線の後継 — 要件74 第2段 2-5(撤去)で書き直し(2026-11-17 仮・契約21・棚卸し 4「書き直し」=承認済み (r)(as))。
 *
 * 今の編集(`<pre contenteditable>`・editMode・editBuffer・Done Editing・Esc で閲覧へ・外部変更の帯の Overwrite / Reload)は撤去され、
 * 要件48 の入口・出口・外部変更の配線は新しい面(CodeMirror / ProseMirror の handle=`windowState.fileEditor`)に変わる。
 *
 * ## 対応する受け入れ基準
 * - AC-74-25 現行の編集の撤去(契約21): `Viewer.svelte` に閲覧の DOM へ `contenteditable` を付ける経路が無い(`html-edit-surface` の編集も無い)。
 *   開いた時点から新しい面(prop `fileEditor` / `editable` は無い)。`windowState` に `editMode` / `beginEdit` / `endEdit` / `editBuffer` /
 *   `externalChange` / `acceptExternalChange` / `updateBuffer` が無い。`dirty` は面の handle の dirty を映す
 * - 契約3(要件48 の入口): ダブルクリック・単クリック・スクロールでは何も変わらない(面は常に編集できる=打鍵で dirty)
 * - 契約4〜6(要件48 の dirty・保存・外部変更): 面の handle と `saveFileEditor`・`applyFileChanged`(契約12〜14)で成り立つ
 *
 * ## 確定契約(implementer はこれに従う)
 * - `windowState`: `dirty` getter = `fileEditor?.dirty ?? false`。`editMode` / `editBuffer` / `externalChange` / `beginEdit` / `endEdit` /
 *   `updateBuffer` / `acceptExternalChange` は無い(`'editMode' in windowState` が false)。`applyFileChanged(payload)` は面があれば handle に委ね、
 *   無ければ `setDocument`。`applyFileRemoved(uri)` は面の dirty で keep / close
 * - `Viewer.svelte`: props に `fileEditor` / `editable` が無い。`.markdown-body` の中に `pre.vellis-plaintext[contenteditable]` も `html-edit-surface` も
 *   `edit-done` / `edit-source` / `external-change-banner` / `external-overwrite` / `external-reload` の testid も無い
 *
 * ## 修正前に赤になる理由
 * - `windowState.editMode` ほかが残っている・Viewer に `fileEditor` の prop があり、渡さないと今の表示になる
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

describe('AC-74-25: 開いた時点から新しい面(prop なし)で、今の編集の入口は無い', () => {
	it('.txt: prop を渡さなくても CodeMirror の面が出て handle が登録される。pre.vellis-plaintext は無い', async () => {
		const { container } = await mountText();
		expect(q(container, '[data-testid="code-editor"] .cm-editor')).not.toBeNull();
		expect(handle().kind).toBe('text');
		expect(q(container, 'pre.vellis-plaintext')).toBeNull();
		expect(editables(container)).toHaveLength(1);
		expect(editables(container)[0]!.classList.contains('cm-content')).toBe(true);
	});

	it('.md: prop を渡さなくても ProseMirror の面が出る。今の編集の掴み手(edit-done / edit-source)は無い', async () => {
		const { container } = await mountMd();
		expect(q(container, '[data-testid="markdown-editor"] .ProseMirror[contenteditable="true"]')).not.toBeNull();
		expect(handle().kind).toBe('markdown');
		for (const id of ['edit-done', 'edit-source', 'external-change-banner', 'external-overwrite', 'external-reload', 'html-edit-surface']) {
			expect(q(container, `[data-testid="${id}"]`), id).toBeNull();
		}
	});

	it('ダブルクリック・単クリック・キー入力(矢印)では文書も dirty も変わらない(契約3=誤編集の守りは打鍵だけ)', async () => {
		const { container } = await mountText();
		const body = q(container, '.markdown-body')!;
		await fireEvent.click(body);
		await fireEvent.dblClick(body);
		cm(container).contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		await settleLong();
		expect(handle().dirty).toBe(false);
		expect(windowState.dirty).toBe(false);
		expect(handle().text()).toBe(TXT_CONTENT);
		expect(editables(container), '面は 1 つのまま(今の編集の <pre contenteditable> は生まれない)').toHaveLength(1);
	});

	it('打つと dirty(windowState.dirty は面の dirty を映す)。元に戻すと消える', async () => {
		const { container } = await mountText();
		typeCm(container, 'x');
		await settle();
		expect(handle().dirty).toBe(true);
		expect(windowState.dirty).toBe(true);
		cm(container).dispatch({ changes: { from: 0, to: 1, insert: '' } });
		await settle();
		expect(windowState.dirty).toBe(false);
	});
});

describe('AC-74-25: windowState から今の編集の口が消えている', () => {
	it('editMode / editBuffer / externalChange / beginEdit / endEdit / updateBuffer / acceptExternalChange が無い', () => {
		const ws = windowState as unknown as Record<string, unknown>;
		for (const key of ['editMode', 'editBuffer', 'externalChange', 'beginEdit', 'endEdit', 'updateBuffer', 'acceptExternalChange']) {
			expect(key in ws, `windowState.${key} は撤去`).toBe(false);
		}
	});

	it('clearDocument / applyRoot で面の handle と削除の印が外れる(契約2=別の文書へ持ち越さない)', async () => {
		await mountText();
		typeCm(document.body, 'x');
		await settle();
		expect(windowState.dirty).toBe(true);
		windowState.clearDocument();
		await settleLong();
		expect(windowState.fileEditor).toBeNull();
		expect(windowState.dirty).toBe(false);
		expect(windowState.externalRemoved).toBe(false);
	});
});

describe('契約4〜6(要件48)の後継: 保存と外部変更は面の handle で', () => {
	it('Command + S の経路(saveFileEditor)で save_document に { uri, content, expectedHash }・dirty が消える', async () => {
		const { container } = await mountText();
		typeCm(container, 'x');
		await settle();
		await saveFileEditor(handle());
		await settleLong();
		expect(invokeMock.mock.calls).toEqual([['save_document', { uri: TXT_URI, content: 'x' + TXT_CONTENT, expectedHash: contentHash(TXT_CONTENT) }]]);
		expect(windowState.dirty).toBe(false);
	});

	it('閲覧中(dirty でない)の外部変更 → 静かに追従(applyFileChanged は handle に委ねる)', async () => {
		const { container } = await mountText();
		const incoming = TXT_CONTENT + 'fourth line\n';
		expect(windowState.applyFileChanged(doc(TXT_URI, incoming))).toBe('apply');
		await settleLong();
		expect(handle().text()).toBe(incoming);
		expect(cm(container).state.doc.toString()).toBe(incoming);
		expect(q(container, '[data-testid="external-change-banner"]'), '今の帯は無い').toBeNull();
	});

	it('dirty で重なる外部変更 → 面の帯(external-conflict-banner)。Overwrite / Reload の帯は無い', async () => {
		const { container } = await mountText();
		typeCm(container, 'MINE ', 0);
		await settle();
		const theirs = 'THEIRS first line\nsecond line\nthird line\n';
		expect(windowState.applyFileChanged(doc(TXT_URI, theirs))).toBe('external-conflict');
		await settleLong();
		expect(q(container, '[data-testid="external-conflict-banner"]')).not.toBeNull();
		expect(q(container, '[data-testid="external-change-banner"]')).toBeNull();
		expect(q(container, '[data-testid="external-overwrite"]')).toBeNull();
		expect(q(container, '[data-testid="external-reload"]')).toBeNull();
		expect(handle().text()).toBe('MINE ' + TXT_CONTENT);
	});

	it('自己書き込みのエコーは ignore-echo', async () => {
		const { container } = await mountText();
		typeCm(container, 'x');
		await settle();
		await saveFileEditor(handle());
		await settleLong();
		expect(windowState.applyFileChanged(doc(TXT_URI, 'x' + TXT_CONTENT))).toBe('ignore-echo');
	});
});

describe('AC-74-25(ソース走査): Viewer.svelte と +page.svelte に今の編集の経路が無い', () => {
	const read = async (rel: string) => {
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		return readFileSync(resolve(__dirname, '../..', rel), 'utf8');
	};
	it('Viewer.svelte: contenteditable を閲覧の DOM に付ける経路・html-edit-surface・edit-done・fileEditor / editable の prop が無い', async () => {
		// <style> の中(print-edit-marks の AC-38-追l (c) が求める印の規則)は見ず、マークアップとスクリプトだけを見る。
		const src = (await read('src/components/Viewer.svelte')).replace(/<style[\s\S]*?<\/style>/g, '');
		expect(src).not.toMatch(/(?<!\[)contenteditable\s*=\s*["']?true|setAttribute\('contenteditable'|\.contentEditable\s*=/);
		for (const needle of ['html-edit-surface', 'edit-done', 'edit-source', 'external-overwrite', 'external-reload', 'external-change-banner', 'htmlEditing', 'editMode', 'editBuffer', "from '../markdown/edit'", 'bufferFromPre', 'fileEditor = ', 'editable = ']) {
			expect(src, needle).not.toContain(needle);
		}
	});
	it('+page.svelte: MENU_EDIT_EVENT の受け手・toggleEditMode・legacy.edit・EDITOR_FILE_FLAG が無い', async () => {
		const src = await read('src/routes/+page.svelte');
		for (const needle of ['MENU_EDIT_EVENT', 'toggleEditMode', 'legacy.edit', 'EDITOR_FILE_FLAG', 'editor-flags', 'editMode', 'editable={']) {
			expect(src, needle).not.toContain(needle);
		}
	});
	it('src/markdown/edit.ts と src/lib/editor-flags.ts が無い', async () => {
		const { existsSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		expect(existsSync(resolve(__dirname, '../..', 'src/markdown/edit.ts'))).toBe(false);
		expect(existsSync(resolve(__dirname, '../..', 'src/lib/editor-flags.ts'))).toBe(false);
	});
});
