/**
 * Issue #848 (2) — 自分の保存のエコーの判定が、外部変更を取り込んだ後も残る不具合(コード / plain text の面=CodeMirror。
 * component プロジェクト・JSDOM に Viewer を載せる。Markdown の面は MarkdownEditor.issue848-echo.wiring.test.ts。契約と判断の記録はそちら)。
 *
 * ## 修正前に赤になる理由
 * - `CodeEditor.svelte` の `applyFileChanged` の最初の `if (selfHash !== null && hash === selfHash) return 'ignore-echo'` が、
 *   取り込みの後も A を捨てる(E1〜E4)。E5 は今も緑(閉じた側の固定)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { EditorView } from '@codemirror/view';

import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
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
function arrive(content: string) {
	return windowState.applyFileChanged(doc(TXT_URI, content));
}

beforeEach(() => {
	vi.stubGlobal('alert', alertMock);
	invokeMock.mockReset();
	invokeMock.mockResolvedValue(null);
	alertMock.mockReset();
	windowState.clearDocument();
});
afterEach(() => {
	cleanup();
	windowState.clearDocument();
	vi.unstubAllGlobals();
});

describe('Issue #848 (2) CodeMirror の面: 外部変更を取り込んだ後は、以前の保存と同じ中身が届いても捨てない', () => {
	it('E1 clean の面: 保存 A → エコー A は ignore-echo → 外部 B を当てる → 外部 A が届く → apply・面は A・基準の版も A', async () => {
		const { container } = await mountText();
		const view = viewOf(container);
		typeAtLine(view, 'x', 1);
		const A = await save();
		expect(A).toBe('x' + TXT_CONTENT);
		const stateBefore = view.state;
		expect(arrive(A)).toBe('ignore-echo');
		await settle();
		expect(view.state).toBe(stateBefore);
		const B = A.replace('third line', 'third line AI1');
		expect(arrive(B)).toBe('apply');
		await settle();
		expect(text()).toBe(B);
		expect(handle().dirty).toBe(false);
		expect(arrive(A), '取り込みの後の A は捨てない').toBe('apply');
		await settle();
		expect(text(), '面は A に従う').toBe(A);
		expect(handle().dirty).toBe(false);
		expect(handle().expectedHash(), '基準の版が A に進む').toBe(contentHash(A));
		expect(windowState.currentDocument?.content).toBe(A);
		expect(q(container, CONFLICT)).toBeNull();
	});

	it('E2 dirty・重ならない: 保存 A → 外部 B(3 行目)を当てる → 2 行目を打つ → 外部 A が届く → apply(マージ)・3 行目は A の版・2 行目の編集は残る', async () => {
		const { container } = await mountText();
		const view = viewOf(container);
		typeAtLine(view, 'x', 1);
		const A = await save();
		const B = A.replace('third line', 'third line AI1');
		expect(arrive(B)).toBe('apply');
		await settle();
		typeAtLine(view, 'y', 2);
		await settle();
		expect(text()).toBe('xfirst line\nysecond line\nthird line AI1\n');
		expect(handle().dirty).toBe(true);
		expect(arrive(A), '取り込みの後の A は捨てない(重ならないのでマージ)').toBe('apply');
		await settle();
		expect(text()).toBe('xfirst line\nysecond line\nthird line\n');
		expect(handle().dirty).toBe(true);
		expect(handle().expectedHash()).toBe(contentHash(A));
		expect(q(container, MERGED), '取り込みの知らせ').not.toBeNull();
		expect(q(container, CONFLICT)).toBeNull();
	});

	it('E3 dirty・重なる: 保存 A → 外部 B(3 行目)を当てる → 3 行目を打つ → 外部 A が届く → external-conflict・帯・文書は変わらない。Use the File on Disk で A', async () => {
		const { container } = await mountText();
		const view = viewOf(container);
		typeAtLine(view, 'x', 1);
		const A = await save();
		const B = A.replace('third line', 'third line AI1');
		expect(arrive(B)).toBe('apply');
		await settle();
		typeAtLine(view, 'y', 3);
		await settle();
		const mine = text();
		expect(mine).toBe('xfirst line\nsecond line\nythird line AI1\n');
		expect(arrive(A), '取り込みの後の A は捨てない(重なるので帯)').toBe('external-conflict');
		await settle();
		expect(text(), '選ぶまで文書は変わらない').toBe(mine);
		expect(handle().conflict).toBe(true);
		expect(q(container, CONFLICT), '重なりの帯').not.toBeNull();
		await fireEvent.click(q(container, '[data-testid="external-conflict-disk"]')!);
		await settleLong();
		expect(text()).toBe(A);
		expect(handle().dirty).toBe(false);
		expect(q(container, CONFLICT)).toBeNull();
	});

	it('E4 帯にした後: 保存 A → 3 行目を打つ → 外部 B(3 行目)で帯 → ディスクが A に戻る → 捨てずに当てる(衝突が解ける): 帯が下り・自分の編集は残る', async () => {
		const { container } = await mountText();
		const view = viewOf(container);
		typeAtLine(view, 'x', 1);
		const A = await save();
		typeAtLine(view, 'y', 3);
		await settle();
		const mine = text();
		const B = A.replace('third line', 'third line AI1');
		expect(arrive(B)).toBe('external-conflict');
		await settle();
		expect(q(container, CONFLICT)).not.toBeNull();
		expect(arrive(A), '帯にしたのも取り込み。基準の版と同じ A が戻ったのはエコーではない').toBe('apply');
		await settle();
		expect(handle().conflict, '衝突が解ける').toBe(false);
		expect(q(container, CONFLICT)).toBeNull();
		expect(text(), '自分の編集は残る').toBe(mine);
		expect(handle().dirty).toBe(true);
		expect(handle().expectedHash()).toBe(contentHash(A));
	});

	it('E5 取り込みの後にもう一度保存したら、その保存のエコーは ignore-echo のまま(閉じた側の固定)', async () => {
		const { container } = await mountText();
		const view = viewOf(container);
		typeAtLine(view, 'x', 1);
		const A1 = await save();
		const B = A1.replace('third line', 'third line AI1');
		expect(arrive(B)).toBe('apply');
		await settle();
		typeAtLine(view, 'z', 2);
		await settle();
		const A2 = await save();
		expect(A2).not.toBe(B);
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
