/**
 * Issue #851 (3) — `showSaveConflict` → `keepMyEdits` でディスクを読み直す経路(`theirs === null`)でも selfHash を忘れる
 * (コード / plain text の面=CodeMirror。component プロジェクト・JSDOM に Viewer を載せる。
 * Markdown の面は MarkdownEditor.issue851-keep-echo.wiring.test.ts。契約と判断の記録はそちら)。
 *
 * ## 修正前に赤になる理由
 * - `CodeEditor.svelte` の `keepMyEdits` の `readDisk().then(setBase)` が selfHash に触らないので、A が届くと最初の
 *   `hash === selfHash` で 'ignore-echo'(K1)。K2 は今も緑(閉じた側の固定)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { EditorView } from '@codemirror/view';

import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { contentHash } from '$lib/document-edit';
import { SAVE_CONFLICT_PREFIX, saveFileEditor, type FileEditorHandle } from '../editor/file-editor';

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
import { invoke } from '$lib/ipc';

const invokeMock = vi.mocked(invoke);
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
const CONFLICT = '[data-testid="external-conflict-banner"]';
const MERGED = '[data-testid="external-merged-notice"]';
const KEEP = '[data-testid="external-conflict-keep"]';

let diskContent: string | null = null;
let rejectNextSave = false;

function doc(uri: string, content: string): DocumentPayload {
	return { uri, content, modified: 1 };
}
function plainTextHtml(content: string): string {
	const escaped = content.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
	return `<pre class="vellis-plaintext">\n${escaped}</pre>`;
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
	const result = render(Viewer, { props: { document: d, html: plainTextHtml(content), index: null, onRequestAddMark: vi.fn(), onToggleMarks: vi.fn(), marksOpen: false } });
	await settleLong();
	return result;
}
function q(container: ParentNode, selector: string): HTMLElement | null {
	return container.querySelector(selector);
}
function must(container: ParentNode, selector: string, what: string): HTMLElement {
	const el = q(container, selector);
	if (!el) throw new Error(`${what} is missing (${selector})`);
	return el;
}
function handle(): FileEditorHandle {
	const h = windowState.fileEditor;
	if (!h) throw new Error('windowState.fileEditor が登録されていない');
	return h;
}
function text(): string {
	return handle().text();
}
function viewOf(container: ParentNode): EditorView {
	const el = q(container, '[data-testid="code-editor"] .cm-editor');
	if (!el) throw new Error('CodeMirror の面が無い');
	const v = EditorView.findFromDOM(el);
	if (!v) throw new Error('EditorView.findFromDOM が null');
	return v;
}
/** `line` 行目(1 始まり)の先頭に `s` を打つ。 */
function typeAtLine(view: EditorView, s: string, line: number) {
	const from = view.state.doc.line(line).from;
	view.dispatch({ changes: { from, insert: s }, selection: { anchor: from + s.length }, userEvent: 'input.type' });
}
async function save(): Promise<string> {
	const saved = text();
	await saveFileEditor(handle());
	await settle();
	expect(invokeMock).toHaveBeenLastCalledWith('save_document', expect.objectContaining({ uri: TXT_URI, content: saved }));
	expect(handle().dirty).toBe(false);
	expect(handle().expectedHash()).toBe(contentHash(saved));
	return saved;
}
async function saveRejected(container: ParentNode) {
	rejectNextSave = true;
	await saveFileEditor(handle());
	await settleLong();
	expect(rejectNextSave, 'save_document was called').toBe(false);
	expect(handle().conflict).toBe(true);
	expect(handle().dirty).toBe(true);
	expect(q(container, CONFLICT), '断られた保存の後の重なりの帯').not.toBeNull();
}
function arrive(content: string) {
	return windowState.applyFileChanged(doc(TXT_URI, content));
}

beforeEach(() => {
	diskContent = null;
	rejectNextSave = false;
	vi.stubGlobal('alert', alertMock);
	invokeMock.mockReset();
	invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
		if (cmd === 'save_document' && rejectNextSave) {
			rejectNextSave = false;
			throw `${SAVE_CONFLICT_PREFIX}: expected 3-7aigaz-3772q3`;
		}
		if (cmd === 'open_document') {
			if (diskContent === null) throw new Error('open_document: no disk content in this test');
			const uri = (args as { uri?: string } | undefined)?.uri ?? TXT_URI;
			return { uri, content: diskContent, modified: 2 } satisfies DocumentPayload;
		}
		return null;
	});
	alertMock.mockReset();
	windowState.clearDocument();
});
afterEach(() => {
	cleanup();
	windowState.clearDocument();
	vi.unstubAllGlobals();
});

describe('Issue #851 (3) CodeMirror の面: 保存の照合で断られ Keep My Edits でディスクを読み直した後は、以前の保存と同じ中身が届いても捨てない', () => {
	it('K1 保存 A → 2 行目を打つ → 保存が断られる(ディスクは D=3 行目が違う)→ Keep My Edits(D を読む)→ 外部 A が届く → apply(マージ)・2 行目の編集は残る・基準は A', async () => {
		const { container } = await mountText();
		const view = viewOf(container);
		typeAtLine(view, 'x', 1);
		const A = await save();
		expect(A).toBe('x' + TXT_CONTENT);
		typeAtLine(view, 'y', 2);
		await settle();
		const mine = text();
		expect(mine).toBe('xfirst line\nysecond line\nthird line\n');
		const D = A.replace('third line', 'third line AI1');
		diskContent = D;
		await saveRejected(container);
		await fireEvent.click(must(container, KEEP, 'Keep My Edits'));
		await settleLong();
		expect(invokeMock).toHaveBeenCalledWith('open_document', expect.objectContaining({ uri: TXT_URI }));
		expect(handle().conflict).toBe(false);
		expect(q(container, CONFLICT)).toBeNull();
		expect(handle().expectedHash(), 'Keep My Edits はディスクの版 D を基準にする').toBe(contentHash(D));
		expect(windowState.currentDocument?.content).toBe(D);
		expect(text(), '自分の編集はそのまま').toBe(mine);
		expect(handle().dirty).toBe(true);
		expect(arrive(A), 'ディスクを読み直した後の A は捨てない').toBe('apply');
		await settle();
		expect(text(), '3 行目は A の版・2 行目の編集は残る').toBe('xfirst line\nysecond line\nthird line\n');
		expect(handle().dirty).toBe(true);
		expect(handle().expectedHash(), '基準の版が A に進む').toBe(contentHash(A));
		expect(windowState.currentDocument?.content).toBe(A);
		expect(q(container, MERGED), '取り込みの知らせ').not.toBeNull();
		expect(q(container, CONFLICT)).toBeNull();
		expect(alertMock).not.toHaveBeenCalled();
	});

	it('K2 Keep My Edits(読み直し)の後にもう一度保存したら、その保存のエコーは ignore-echo のまま(閉じた側の固定)', async () => {
		const { container } = await mountText();
		const view = viewOf(container);
		typeAtLine(view, 'x', 1);
		const A1 = await save();
		typeAtLine(view, 'y', 2);
		await settle();
		diskContent = A1.replace('third line', 'third line AI1');
		await saveRejected(container);
		await fireEvent.click(must(container, KEEP, 'Keep My Edits'));
		await settleLong();
		expect(handle().conflict).toBe(false);
		const A2 = await save();
		expect(A2).toBe('xfirst line\nysecond line\nthird line\n');
		const stateBefore = view.state;
		expect(arrive(A2), '新しい保存のエコー').toBe('ignore-echo');
		await settle();
		expect(view.state).toBe(stateBefore);
		expect(text()).toBe(A2);
		expect(arrive(A1), '以前の保存 A1 は今の selfHash ではない').toBe('apply');
		await settle();
		expect(text()).toBe(A1);
	});
});
