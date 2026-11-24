/**
 * 要件#74 第4段 4-1 — 差分表示(契約13・契約19・由谷の決定 2026-11-17 午後 4-1〜4-4: 衝突の差分と未保存の変更の差分だけ・自前・1 列の unified・
 * 原文の文字列・塊ごとの選択はしない)。正本: docs/review/req74-stage34-prep.md の (C) 1 と (D) AC-74-60・AC-74-61。
 *
 * ## 対応する受け入れ基準
 * - AC-74-60 衝突の差分: 重なりの帯に `external-conflict-diff` があり、押すと `editor-diff` が出て、塊が `lineDiff(今の文字列, 届いた内容)` と一致。
 *   差分の画面の Keep My Edits / Use the File on Disk が帯と同じ結果(AC-74-14 (2) と同じ判定)。保存の照合の衝突でも同じ(右側=ディスクを読み直した内容)。
 *   Esc で閉じて文書は変わらない
 * - AC-74-61 未保存の変更の差分: dirty のとき `unsaved-badge` が button で、押すと `lineDiff(基準の版, 今の文字列)` の差分。打って戻すと札が消える。
 *   改行コードだけの差の行に `Line endings differ`。上限超えで `Too many differences to show.`
 * - 面の種類(コード・plain text・Markdown)によらず原文で見せる(Markdown は記号が見える)。印刷では隠す。読むだけ
 *
 * ## 確定契約(implementer はこれに従う=推奨名は stage34-prep の (C) 1)
 *
 * ```ts
 * // --- src/editor/file-editor.ts に足す(どの面も)
 * export interface FileEditorHandle { …;
 *   /** 基準の版(Save が照合する中身=未保存の差分の左側)。 *\/
 *   baseText(): string;
 *   /** 重なりの帯の相手(届いた内容)。保存の照合の衝突から来たときはディスクを読み直して返す。衝突でなければ null。 *\/
 *   conflictText(): Promise<string | null>;
 * }
 * // --- src/components/EditorDiffView.svelte(新規・読むだけ・testid editor-diff・ペインの文書の場所に重ねる 1 枚=要件56 のオーバーレイのトークン)
 * //   props: title・leftName・rightName・left(文字列)・right(文字列)・onClose・onKeep?・onUseDisk?
 * //   <section class="editor-diff" data-testid="editor-diff" role="dialog" aria-label={title}>
 * //     <header> <span data-testid="editor-diff-title">{title}</span> <span data-testid="editor-diff-left">{leftName}</span> ↔ <span data-testid="editor-diff-right">{rightName}</span>
 * //             <button data-testid="editor-diff-close" aria-label="Close">Close</button> </header>
 * //     本体=1 列の unified(行番号の溝 2 本・前後 3 行の文脈・変わらない連なりは <button data-testid="editor-diff-expand">N unchanged lines</button> に畳む)
 * //       行= <div class="diff-line" data-testid="editor-diff-line" data-kind="context|delete|insert" data-a="(a の行番号 1 始まり|空)" data-b="…">
 * //              <span class="diff-text">行の文字(行末の改行コードを除く)</span></div>
 * //       改行コードだけが違う行には <span data-testid="editor-diff-eol">Line endings differ</span>(その delete / insert の行の中)
 * //       lineDiff が null なら本体は <p data-testid="editor-diff-too-many">Too many differences to show.</p> だけ
 * //     footer(衝突のときだけ)= <button data-testid="editor-diff-keep">Keep My Edits</button> <button data-testid="editor-diff-disk">Use the File on Disk</button>
 * //   <style>: var(--color-bg-raised) + var(--shadow-2) + var(--radius-md)・本文は var(--font-mono)。色の直書きなし
 * // --- Viewer.svelte
 * //   重なりの帯に 3 つ目 <button data-testid="external-conflict-diff">Show Differences</button> → EditorDiffView(title 'Conflicting Changes'・
 * //     'Your Edits' ↔ 'On Disk'・left=handle.text()・right=await handle.conflictText())。Keep / Use は帯と同じ handle.keepMyEdits() / useFileOnDisk() → 閉じる
 * //   Unsaved の札= <button data-testid="unsaved-badge" aria-label="Show unsaved changes">Unsaved</button> → EditorDiffView(title 'Unsaved Changes'・
 * //     'On Disk' ↔ 'Your Edits'・left=handle.baseText()・right=handle.text()・Close だけ)
 * //   Esc・Close で閉じる(文書は変わらない)。開いている間に文字列が変わったら作り直す。印刷では隠す=部品自身の <style> の @media print で
 * //   いちばん外側の層(.editor-diff-layer)を display: none(code-editor-print と同じ家風。print.css は第1段から触らないもの=AC-56-16)
 * ```
 *
 * ## 修正前に赤になる理由
 * - `external-conflict-diff` も `editor-diff` も無く、`unsaved-badge` は span。`src/editor/line-diff.ts` が無い
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EditorView } from '@codemirror/view';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import { contentHash } from '$lib/document-edit';
import { SAVE_CONFLICT_PREFIX, saveFileEditor, type FileEditorHandle, type MarkdownEditorHandle } from '../editor/file-editor';
import { lineDiff } from '../editor/line-diff';
import { textSpots } from '../editor/markdown.testkit';
import { TextSelection } from 'prosemirror-state';

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
	};
});
import { invoke } from '$lib/ipc';
const invokeMock = vi.mocked(invoke);
const alertMock = vi.fn();

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

const REPO_ROOT = resolve(__dirname, '../..');
const TXT_URI = 'file:///Users/a/notes/memo.txt';
const MD_URI = 'file:///Users/a/notes/plan.md';
const TXT = 'first line\nsecond line\nthird line\n';
const MD = '# Plan\n\nIntro **bold** word.\n\nSecond paragraph.\n';

function doc(uri: string, content: string): DocumentPayload {
	return { uri, content, modified: 1 };
}
function plainHtml(content: string): string {
	return `<pre class="vellis-plaintext">\n${content.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)}</pre>`;
}
function baseProps(d: DocumentPayload, html: string, index: SourceIndex | null) {
	return { document: d, html, index, onRequestAddMark: vi.fn(), onToggleMarks: vi.fn(), marksOpen: false };
}
async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}
async function settleLong() {
	await settle();
	await new Promise((r) => setTimeout(r, 0));
	await settle();
}
async function mountText(content = TXT, uri = TXT_URI) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const result = render(Viewer, { props: baseProps(d, plainHtml(content), null) });
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
function q(container: ParentNode, testid: string): HTMLElement | null {
	return container.querySelector(`[data-testid="${testid}"]`);
}
function must(container: ParentNode, testid: string): HTMLElement {
	const el = q(container, testid);
	if (!el) throw new Error(`[data-testid="${testid}"] が無い`);
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
function cmView(container: ParentNode): EditorView {
	const root = container.querySelector<HTMLElement>('[data-testid="code-editor"]');
	if (!root) throw new Error('コードの面が無い');
	const v = EditorView.findFromDOM(root);
	if (!v) throw new Error('EditorView.findFromDOM が null');
	return v;
}
function typeCm(view: EditorView, s: string, at = 0) {
	view.dispatch({ changes: { from: at, insert: s }, selection: { anchor: at + s.length }, userEvent: 'input.type' });
}
/** 差分の画面の行(文脈は除く)を kind と文字で読む。 */
function diffRows(container: ParentNode): Array<{ kind: string; text: string; a: string; b: string }> {
	return [...container.querySelectorAll<HTMLElement>('[data-testid="editor-diff-line"]')].map((el) => ({
		kind: el.getAttribute('data-kind') ?? '',
		text: el.querySelector('.diff-text')?.textContent ?? el.textContent ?? '',
		a: el.getAttribute('data-a') ?? '',
		b: el.getAttribute('data-b') ?? '',
	}));
}
const strip = (line: string) => line.replace(/\r\n$|\r$|\n$/, '');
/** 画面の delete / insert の行が lineDiff の塊と同じ(順も)。 */
function expectRowsMatch(container: ParentNode, a: string, b: string) {
	const hunks = lineDiff(a, b);
	expect(hunks, 'lineDiff は塊を返す').not.toBeNull();
	const expected: Array<[string, string]> = [];
	for (const h of hunks!) {
		for (const l of h.aLines) expected.push(['delete', strip(l)]);
		for (const l of h.bLines) expected.push(['insert', strip(l)]);
	}
	const rows = diffRows(container).filter((r) => r.kind !== 'context');
	expect(rows.map((r) => [r.kind, r.text])).toEqual(expected);
	for (const r of diffRows(container)) {
		expect(['context', 'delete', 'insert']).toContain(r.kind);
		if (r.kind === 'delete') expect(r.b, '消えた行は b の行番号なし').toBe('');
		if (r.kind === 'insert') expect(r.a, '足された行は a の行番号なし').toBe('');
		if (r.kind === 'context') {
			expect(r.a).toMatch(/^\d+$/);
			expect(r.b).toMatch(/^\d+$/);
		}
	}
}
async function keyOn(el: Element, key: string, init: KeyboardEventInit = {}) {
	el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true, ...init }));
	await settleLong();
}
/** dirty の面に重なる外部変更を届けて帯を出す(AC-74-14 (2) と同じ手順)。 */
async function makeConflict(container: HTMLElement, theirs: string) {
	const view = cmView(container);
	typeCm(view, 'MINE ', 0);
	await settle();
	expect(windowState.applyFileChanged(doc(TXT_URI, theirs))).toBe('external-conflict');
	await settleLong();
	expect(q(container, 'external-conflict-banner')).not.toBeNull();
	return { mine: text(), view };
}

beforeEach(() => {
	windowState.clearDocument();
	windowState.fileEditor = null;
	invokeMock.mockReset();
	invokeMock.mockResolvedValue(null);
	alertMock.mockReset();
	vi.stubGlobal('alert', alertMock);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('AC-74-60: 衝突の差分(重なりの帯の Show Differences)', () => {
	it('帯に external-conflict-diff(Show Differences)があり、押すと editor-diff が出る: 題 Conflicting Changes・Your Edits ↔ On Disk・塊は lineDiff(今の文字列, 届いた内容)・読むだけ', async () => {
		const { container } = await mountText();
		const theirs = TXT.replace('first line', 'THEIRS first line');
		const { mine } = await makeConflict(container, theirs);
		const button = must(container, 'external-conflict-diff');
		expect(button.tagName).toBe('BUTTON');
		expect(button.textContent?.trim()).toBe('Show Differences');
		expect(q(container, 'editor-diff')).toBeNull();
		await fireEvent.click(button);
		await settleLong();
		const panel = must(container, 'editor-diff');
		expect(panel.getAttribute('role')).toBe('dialog');
		expect(must(container, 'editor-diff-title').textContent?.trim()).toBe('Conflicting Changes');
		expect(must(container, 'editor-diff-left').textContent?.trim()).toBe('Your Edits');
		expect(must(container, 'editor-diff-right').textContent?.trim()).toBe('On Disk');
		expectRowsMatch(container, mine, theirs);
		expect(panel.querySelector('[contenteditable="true"], textarea, input'), '読むだけ').toBeNull();
		expect(must(container, 'editor-diff-keep').textContent?.trim()).toBe('Keep My Edits');
		expect(must(container, 'editor-diff-disk').textContent?.trim()).toBe('Use the File on Disk');
		expect(text(), '開いただけでは文書は変わらない').toBe(mine);
		expect(q(container, 'external-conflict-banner'), '帯はそのまま').not.toBeNull();
	});

	it('差分の画面の Keep My Edits=帯と同じ(文書はそのまま・衝突が消え・基準の版が届いた内容)。画面は閉じる', async () => {
		const { container } = await mountText();
		const theirs = TXT.replace('first line', 'THEIRS first line');
		const { mine } = await makeConflict(container, theirs);
		await fireEvent.click(must(container, 'external-conflict-diff'));
		await settleLong();
		await fireEvent.click(must(container, 'editor-diff-keep'));
		await settleLong();
		expect(q(container, 'editor-diff')).toBeNull();
		expect(q(container, 'external-conflict-banner')).toBeNull();
		expect(text()).toBe(mine);
		expect(handle().conflict).toBe(false);
		expect(handle().dirty).toBe(true);
		expect(handle().expectedHash(), '次の保存は上書き(基準の版=届いた内容)').toBe(contentHash(theirs));
	});

	it('差分の画面の Use the File on Disk=帯と同じ(届いた内容になり dirty でない)。画面は閉じる', async () => {
		const { container } = await mountText();
		const theirs = TXT.replace('first line', 'THEIRS first line');
		await makeConflict(container, theirs);
		await fireEvent.click(must(container, 'external-conflict-diff'));
		await settleLong();
		await fireEvent.click(must(container, 'editor-diff-disk'));
		await settleLong();
		expect(q(container, 'editor-diff')).toBeNull();
		expect(q(container, 'external-conflict-banner')).toBeNull();
		expect(text()).toBe(theirs);
		expect(handle().dirty).toBe(false);
		expect(windowState.dirty).toBe(false);
	});

	it('Esc と Close で閉じる(文書も帯も変わらない)', async () => {
		const { container } = await mountText();
		const theirs = TXT.replace('first line', 'THEIRS first line');
		const { mine } = await makeConflict(container, theirs);
		await fireEvent.click(must(container, 'external-conflict-diff'));
		await settleLong();
		await keyOn(must(container, 'editor-diff'), 'Escape');
		expect(q(container, 'editor-diff'), 'Esc で閉じる').toBeNull();
		expect(text()).toBe(mine);
		expect(handle().conflict).toBe(true);
		expect(q(container, 'external-conflict-banner')).not.toBeNull();
		await fireEvent.click(must(container, 'external-conflict-diff'));
		await settleLong();
		await fireEvent.click(must(container, 'editor-diff-close'));
		await settleLong();
		expect(q(container, 'editor-diff'), 'Close で閉じる').toBeNull();
		expect(text()).toBe(mine);
	});

	it('保存の照合の衝突でも同じ(右側=ディスクを読み直した内容=open_document)', async () => {
		const { container } = await mountText();
		const view = cmView(container);
		typeCm(view, 'x', 0);
		const mine = text();
		const disk = TXT.replace('third line', 'DISK third line');
		invokeMock.mockRejectedValueOnce(`${SAVE_CONFLICT_PREFIX}: expected 3-7aigaz-3772q3`);
		await saveFileEditor(handle());
		await settleLong();
		expect(handle().conflict).toBe(true);
		invokeMock.mockImplementation(async (cmd: string) => (cmd === 'open_document' ? doc(TXT_URI, disk) : null));
		await fireEvent.click(must(container, 'external-conflict-diff'));
		await settleLong();
		await new Promise((r) => setTimeout(r, 20));
		await settle();
		expect(invokeMock).toHaveBeenCalledWith('open_document', { uri: TXT_URI });
		expect(must(container, 'editor-diff-right').textContent?.trim()).toBe('On Disk');
		expectRowsMatch(container, mine, disk);
		expect(text(), '読むだけ').toBe(mine);
	});

	it('Markdown の面でも同じで、中身は原文の文字列(**bold** の記号が見える)', async () => {
		const { container } = await mountMd();
		const h = handle() as MarkdownEditorHandle;
		const spot = textSpots(h.view.state.doc, 1)[0]!;
		h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, spot.pos)).insertText('MINE ', spot.pos));
		await settle();
		const mine = text();
		const theirs = MD.replace('Intro **bold** word.', 'THEIRS **bold** word.');
		expect(windowState.applyFileChanged(doc(MD_URI, theirs))).toBe('external-conflict');
		await settleLong();
		await fireEvent.click(must(container, 'external-conflict-diff'));
		await settleLong();
		expectRowsMatch(container, mine, theirs);
		const rows = diffRows(container);
		expect(rows.some((r) => r.text.includes('**bold**')), '原文の記号が見える').toBe(true);
		expect(text()).toBe(mine);
	});

	it('改行コードだけが違う行には Line endings differ の印', async () => {
		const base = 'a\r\nb\r\n';
		const { container } = await mountText(base);
		const view = cmView(container);
		const line2 = view.state.doc.line(2).from;
		typeCm(view, 'x', line2);
		await settle();
		const theirs = 'a\nTHEIRS\r\n';
		expect(windowState.applyFileChanged(doc(TXT_URI, theirs))).toBe('external-conflict');
		await settleLong();
		await fireEvent.click(must(container, 'external-conflict-diff'));
		await settleLong();
		expectRowsMatch(container, text(), theirs);
		const eol = container.querySelectorAll('[data-testid="editor-diff-eol"]');
		expect(eol.length).toBeGreaterThan(0);
		expect(eol[0]!.textContent?.trim()).toBe('Line endings differ');
		const marked = eol[0]!.closest('[data-testid="editor-diff-line"]');
		expect(marked?.querySelector('.diff-text')?.textContent).toBe('a');
	});

	it('上限を超える差分は Too many differences to show.', async () => {
		const n = 3000;
		const base = Array.from({ length: n }, (_, i) => `b${i}\n`).join('');
		const { container } = await mountText(base);
		const view = cmView(container);
		typeCm(view, 'x', 0);
		await settle();
		const theirs = Array.from({ length: n }, (_, i) => `t${i}\n`).join('');
		expect(windowState.applyFileChanged(doc(TXT_URI, theirs))).toBe('external-conflict');
		await settleLong();
		await fireEvent.click(must(container, 'external-conflict-diff'));
		await settleLong();
		expect(must(container, 'editor-diff-too-many').textContent?.trim()).toBe('Too many differences to show.');
		expect(container.querySelectorAll('[data-testid="editor-diff-line"]')).toHaveLength(0);
		expect(q(container, 'editor-diff-keep'), '選ぶボタンは残る').not.toBeNull();
	});
});

describe('AC-74-61: 未保存の変更の差分(Unsaved の札)', () => {
	it('dirty のとき unsaved-badge は button(aria-label Show unsaved changes)。押すと Unsaved Changes・On Disk ↔ Your Edits・塊は lineDiff(基準の版, 今の文字列)・Close だけ', async () => {
		const { container } = await mountText();
		expect(q(container, 'unsaved-badge')).toBeNull();
		const view = cmView(container);
		typeCm(view, 'NEW ', view.state.doc.line(2).from);
		await settle();
		const badge = must(container, 'unsaved-badge');
		expect(badge.tagName).toBe('BUTTON');
		expect(badge.getAttribute('aria-label')).toBe('Show unsaved changes');
		expect(badge.textContent?.trim()).toBe('Unsaved');
		await fireEvent.click(badge);
		await settleLong();
		expect(must(container, 'editor-diff-title').textContent?.trim()).toBe('Unsaved Changes');
		expect(must(container, 'editor-diff-left').textContent?.trim()).toBe('On Disk');
		expect(must(container, 'editor-diff-right').textContent?.trim()).toBe('Your Edits');
		expectRowsMatch(container, TXT, text());
		expect(q(container, 'editor-diff-keep')).toBeNull();
		expect(q(container, 'editor-diff-disk')).toBeNull();
		expect(must(container, 'editor-diff-close')).not.toBeNull();
		await fireEvent.click(must(container, 'editor-diff-close'));
		await settleLong();
		expect(q(container, 'editor-diff')).toBeNull();
		expect(text(), '読むだけ').toBe(TXT.replace('second line', 'NEW second line'));
	});

	it('打って戻すと札が消える(dirty でない)。Esc で閉じる', async () => {
		const { container } = await mountText();
		const view = cmView(container);
		typeCm(view, 'x', 0);
		await settle();
		await fireEvent.click(must(container, 'unsaved-badge'));
		await settleLong();
		expect(q(container, 'editor-diff')).not.toBeNull();
		await keyOn(must(container, 'editor-diff'), 'Escape');
		expect(q(container, 'editor-diff')).toBeNull();
		view.dispatch({ changes: { from: 0, to: 1 }, userEvent: 'delete.backward' });
		await settle();
		expect(handle().dirty).toBe(false);
		expect(q(container, 'unsaved-badge')).toBeNull();
	});

	it('Markdown の面でも同じ(原文の差分=記号が見える)。raw の間も', async () => {
		const { container } = await mountMd();
		const h = handle() as MarkdownEditorHandle;
		const spot = textSpots(h.view.state.doc, 1)[0]!;
		h.view.dispatch(h.view.state.tr.insertText('NEW ', spot.pos));
		await settle();
		await fireEvent.click(must(container, 'unsaved-badge'));
		await settleLong();
		expectRowsMatch(container, MD, text());
		expect(diffRows(container).some((r) => r.kind === 'insert' && r.text.includes('**bold**'))).toBe(true);
		await fireEvent.click(must(container, 'editor-diff-close'));
		await settleLong();
		h.toggleRaw();
		await settleLong();
		await new Promise((r) => setTimeout(r, 30));
		await settle();
		expect(h.raw).toBe(true);
		await fireEvent.click(must(container, 'unsaved-badge'));
		await settleLong();
		expectRowsMatch(container, MD, text());
	});

	it('変わらない連なりは N unchanged lines に畳まれ(前後 3 行の文脈は出る)、押すと開く', async () => {
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`);
		const base = lines.join('');
		const { container } = await mountText(base);
		const view = cmView(container);
		typeCm(view, 'X', view.state.doc.line(25).from);
		await settle();
		await fireEvent.click(must(container, 'unsaved-badge'));
		await settleLong();
		const expand = container.querySelectorAll<HTMLElement>('[data-testid="editor-diff-expand"]');
		expect(expand.length).toBeGreaterThan(0);
		expect(expand[0]!.textContent?.trim()).toMatch(/^\d+ unchanged lines$/);
		const contextBefore = diffRows(container).filter((r) => r.kind === 'context');
		expect(contextBefore.length, '前後 3 行の文脈').toBeGreaterThanOrEqual(3);
		expect(contextBefore.length).toBeLessThan(29);
		await fireEvent.click(expand[0]!);
		await settleLong();
		expect(diffRows(container).filter((r) => r.kind === 'context').length).toBeGreaterThan(contextBefore.length);
	});

	it('上限超えは Too many differences to show.', async () => {
		const n = 3000;
		const base = Array.from({ length: n }, (_, i) => `b${i}\n`).join('');
		const { container } = await mountText(base);
		const view = cmView(container);
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: Array.from({ length: n }, (_, i) => `t${i}\n`).join('') }, userEvent: 'input.paste' });
		await settle();
		await fireEvent.click(must(container, 'unsaved-badge'));
		await settleLong();
		expect(must(container, 'editor-diff-too-many').textContent?.trim()).toBe('Too many differences to show.');
	});
});

describe('4-1: 見た目と印刷(ソース走査)', () => {
	it('EditorDiffView.svelte は要件56 のオーバーレイのトークン(--color-bg-raised / --shadow-2 / --radius-md)と --font-mono、差分の色は既存の --color-success-soft / --color-danger-soft(由谷 2026-11-17 決定=新しいトークンは足さない)。色の直書きが無い', () => {
		const src = readFileSync(resolve(REPO_ROOT, 'src/components/EditorDiffView.svelte'), 'utf8');
		const style = src.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? '';
		expect(src, '新しいトークン --color-diff-* は使わない').not.toMatch(/--color-diff-/);
		for (const token of ['--color-bg-raised', '--shadow-2', '--radius-md', '--font-mono', '--color-success-soft', '--color-danger-soft']) {
			expect(style, token).toMatch(new RegExp(`var\\(\\s*${token}\\b`));
		}
		const css = style.replace(/\/\*[\s\S]*?\*\//g, '');
		expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], 'hex の直書き').toEqual([]);
		expect(css.match(/\b(?:rgba?|hsla?)\(/g) ?? [], '色関数の直書き').toEqual([]);
		expect(src).toContain('data-testid="editor-diff"');
	});

	it('印刷では部品自身の <style> の @media print で隠す(いちばん外側の層 .editor-diff-layer を display: none)。print.css は無改変(AC-56-16)', () => {
		const src = readFileSync(resolve(REPO_ROOT, 'src/components/EditorDiffView.svelte'), 'utf8');
		const style = (src.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
		const printBlocks = [...style.matchAll(/@media\s+print\s*\{/g)];
		expect(printBlocks.length, '@media print がある').toBeGreaterThan(0);
		const hidesLayer = /@media\s+print\s*\{[\s\S]*?\.editor-diff-layer[^{}]*\{[^}]*display\s*:\s*none/.test(style);
		expect(hidesLayer, '@media print の中で .editor-diff-layer を display: none').toBe(true);
		expect(src).toContain('class="editor-diff-layer');
		const css = readFileSync(resolve(REPO_ROOT, 'src/styles/print.css'), 'utf8');
		expect(css, 'print.css には足さない').not.toContain('editor-diff');
	});
});

// 第4段の P3 の穴(E1・V4)
describe('P3 E1 / V4: 文脈はちょうど 3 行・開いたまま打つ / 外部変更が来ると作り直す', () => {
	it('E1: 30 行の 15 行目だけを変えると、文脈は前後ちょうど 3 行(12〜14・16〜18)で、残りは 11 / 12 unchanged lines に畳まれる', async () => {
		const base = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join('');
		const { container } = await mountText(base);
		const view = cmView(container);
		typeCm(view, 'X', view.state.doc.line(15).from);
		await settle();
		await fireEvent.click(must(container, 'unsaved-badge'));
		await settleLong();
		const rows = diffRows(container);
		expect(rows.filter((r) => r.kind === 'context').map((r) => r.a)).toEqual(['12', '13', '14', '16', '17', '18']);
		expect(rows.filter((r) => r.kind === 'delete').map((r) => r.a)).toEqual(['15']);
		expect(rows.filter((r) => r.kind === 'insert').map((r) => r.b)).toEqual(['15']);
		const expands = [...container.querySelectorAll<HTMLElement>('[data-testid="editor-diff-expand"]')].map((e) => e.textContent?.trim());
		expect(expands).toEqual(['11 unchanged lines', '12 unchanged lines']);
	});

	it('V4: 未保存の差分を開いたまま打つと作り直される。外部変更(重ならない)が来ても作り直される(基準の版 ↔ 今の文字列)', async () => {
		const { container } = await mountText();
		const view = cmView(container);
		typeCm(view, 'ONE ', 0);
		await settle();
		await fireEvent.click(must(container, 'unsaved-badge'));
		await settleLong();
		expectRowsMatch(container, TXT, text());
		typeCm(view, 'MORE ', 0);
		await settleLong();
		expect(q(container, 'editor-diff'), '開いたまま').not.toBeNull();
		expectRowsMatch(container, TXT, text());
		expect(diffRows(container).some((r) => r.kind === 'insert' && r.text.startsWith('MORE ONE ')), '打った字が映る').toBe(true);
		const incoming = TXT.replace('third line', 'THEIRS');
		expect(windowState.applyFileChanged(doc(TXT_URI, incoming))).toBe('apply');
		await settleLong();
		expect(q(container, 'editor-diff'), '外部変更の後も開いたまま').not.toBeNull();
		expect(handle().expectedHash()).toBe(contentHash(incoming));
		expectRowsMatch(container, incoming, text());
		expect(diffRows(container).some((r) => r.text.includes('THEIRS') && r.kind !== 'context'), '取り込んだ行は差でない').toBe(false);
	});
});
