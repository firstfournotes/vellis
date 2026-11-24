/**
 * 要件#74 第4段 4-3 — 浮遊バー(要件56 のモックの画面2 の 8・契約8・契約10・由谷の決定 2026-11-17 午後 4-7=入れる)。
 * 正本: docs/review/req74-stage34-prep.md の (C) 3 と (D) AC-74-63。定数と位置の純関数は src/editor/format-toolbar.acceptance.test.ts。
 *
 * ## 対応する受け入れ基準(AC-74-63)
 * - Markdown の編集面で空でない文字の選択(TextSelection)ができて落ち着いたとき(マウスを離した・キーボードの選択の後 300 ms)に `selection-bar` が出る。
 *   選択のすぐ上(上に入らなければ下)・面の外にはみ出さない・スクロールで位置を写し直す
 * - 出さない / 消す: 選択が空・NodeSelection(画像)・変換中・打鍵・Esc・raw / コード / 読み取り専用・右クリックのメニューを出している間。
 *   書式のツールバーと同時に出てよい
 * - 中身=段落の種類(select)・Bold・Italic・Strikethrough・Inline Code・Link…・Clear Formatting。押下は `runFormatCommand` と同じ結果(取引 1 つ)・
 *   mousedown は preventDefault で選択を保つ・aria-pressed は activeFormat。印刷は部品の @media print で隠す(print.css は触らない)
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * ```ts
 * // --- src/components/SelectionBar.svelte(新規・AC-56-3 の一覧に足す)
 * //   <div class="selection-bar" data-testid="selection-bar" role="toolbar" aria-label="Formatting" style="left: …px; top: …px" data-placement="above|below">
 * //     <select data-testid="selection-block-type" aria-label="Paragraph style">(FORMAT_TOOLBAR_BLOCK_TYPES・値は activeFormat の段落の種類)
 * //     ボタン(SELECTION_BAR_ITEMS の順)= <button type="button" data-format-id title aria-label aria-pressed(activeFormat にある項目だけ)>
 * //   mousedown は preventDefault。click / change → runFormatCommand(id, handle)。<style> はトークンだけ・@media print { .selection-bar { display: none } }
 * // --- MarkdownEditor.svelte(面の根の中・.ProseMirror の兄弟)
 * //   表示の条件: 選択が TextSelection で空でない && !composing && !readOnly && !raw && 右クリックのメニューを出していない
 * //   契機: mouseup(面の上)=すぐ・selectionSet の取引=SELECTION_BAR_SETTLE_MS 後(その間に選択が変われば数え直す)。docChanged の取引(打鍵)と Esc で消す
 * //   位置: selectionBarPosition({ anchor: view.coordsAtPos(selection.from), bar: 自身の大きさ, bounds: 面の根の getBoundingClientRect() })を面の根からの相対に。
 * //     article.viewer の scroll で写し直す
 * ```
 *
 * jsdom にはレイアウトが無いので、`view.coordsAtPos` は instance で差し替え、面の根の getBoundingClientRect も差し替える。
 *
 * ## 修正前に赤になる理由
 * - `selection-bar` が無い(`src/components/SelectionBar.svelte` が無い)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { undoDepth } from 'prosemirror-history';
import type { EditorView } from 'prosemirror-view';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import type { MarkdownEditorHandle } from '../editor/file-editor';
import { runFormatCommand } from '../editor/commands';
import { textSpots } from '../editor/markdown.testkit';
import { SELECTION_BAR_SETTLE_MS } from '../editor/format-toolbar';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => undefined), openPath: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), message: vi.fn(), open: vi.fn() }));
vi.mock('$lib/mermaid-mounter', () => ({ mountMermaid: vi.fn(async () => undefined) }));
vi.mock('$lib/native-menu', () => ({ popupMenu: vi.fn(async () => undefined) }));
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
vi.mock('@tauri-apps/api/window', async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	const fake = { label: 'main', emit: vi.fn(async () => undefined), onFocusChanged: vi.fn(async () => () => {}), listen: vi.fn(async () => () => {}) };
	return { ...actual, getCurrentWindow: () => fake };
});

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
const MD_URI = 'file:///Users/a/notes/plan.md';
const TXT_URI = 'file:///Users/a/notes/memo.txt';
const MD = '# Plan\n\nIntro paragraph with **bold** word.\n\n![fig](./fig.png) image here.\n\n- item one\n';

function doc(uri: string, content: string): DocumentPayload {
	return { uri, content, modified: 1 };
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
async function wait(ms: number) {
	await new Promise((r) => setTimeout(r, ms));
	await settle();
}
async function mountMd(content = MD, uri = MD_URI) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const r = await renderMarkdown(content, uri);
	const result = render(Viewer, { props: baseProps(d, r.html, r.index) });
	await settleLong();
	return result;
}
async function mountText(content = 'one two\n', uri = TXT_URI) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const result = render(Viewer, { props: baseProps(d, `<pre class="vellis-plaintext">\n${content}</pre>`, null) });
	await settleLong();
	return result;
}
const BAR = '[data-testid="selection-bar"]';
function bar(container: ParentNode): HTMLElement | null {
	return container.querySelector(BAR);
}
function handle(): MarkdownEditorHandle {
	const h = windowState.fileEditor as MarkdownEditorHandle | null;
	if (!h || h.kind !== 'markdown') throw new Error('Markdown の handle が無い');
	return h;
}
function view(): EditorView {
	return handle().view;
}
/** レイアウトの代わり: coordsAtPos と面の根の矩形を差し替える。 */
function stubLayout(container: ParentNode, coords: { left: number; top: number; bottom: number }, bounds = { left: 0, top: 0, right: 800, bottom: 600 }) {
	const v = view();
	(v as unknown as { coordsAtPos: (pos: number) => { left: number; right: number; top: number; bottom: number } }).coordsAtPos = () => ({
		left: coords.left,
		right: coords.left + 10,
		top: coords.top,
		bottom: coords.bottom,
	});
	const face = container.querySelector<HTMLElement>('[data-testid="markdown-editor"]');
	if (!face) throw new Error('面の根が無い');
	face.getBoundingClientRect = () =>
		({ x: bounds.left, y: bounds.top, left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top, toJSON: () => ({}) }) as DOMRect;
}
/** 文字を選び、マウスを離す(すぐ出る契機)。 */
async function selectByMouse(block: number, from: number, to: number) {
	const v = view();
	const spot = textSpots(v.state.doc, block)[0]!;
	v.dom.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
	v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, spot.pos + from, spot.pos + to)));
	v.dom.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
	await settleLong();
}
function selectByKeys(block: number, from: number, to: number) {
	const v = view();
	const spot = textSpots(v.state.doc, block)[0]!;
	v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, spot.pos + from, spot.pos + to)));
}
function button(container: ParentNode, id: string): HTMLButtonElement {
	const el = container.querySelector<HTMLButtonElement>(`${BAR} [data-format-id="${id}"]`);
	if (!el) throw new Error(`浮遊バーのボタン ${id} が無い`);
	return el;
}
const px = (s: string) => Number.parseFloat(s);

beforeEach(() => {
	windowState.clearDocument();
	windowState.fileEditor = null;
	windowState.editBlocked = false;
	localStorage.clear();
	vi.stubGlobal('alert', vi.fn());
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('AC-74-63: 出る契機と消える条件', () => {
	it('空でない選択でマウスを離すと selection-bar(role toolbar)が出る。開いた直後・空の選択では出ない', async () => {
		const { container } = await mountMd();
		expect(bar(container)).toBeNull();
		stubLayout(container, { left: 120, top: 300, bottom: 320 });
		await selectByMouse(1, 0, 5);
		const el = bar(container);
		expect(el).not.toBeNull();
		expect(el!.getAttribute('role')).toBe('toolbar');
		expect(el!.closest('[data-testid="markdown-editor"]'), '面の根の中').not.toBeNull();
		expect(el!.closest('.ProseMirror'), '文書の中ではない').toBeNull();
		// 空の選択にすると消える
		const v = view();
		v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, v.state.selection.from)));
		await settleLong();
		await wait(SELECTION_BAR_SETTLE_MS + 50);
		expect(bar(container), '空の選択では消える').toBeNull();
	});

	it('キーボードの選択は 300 ms 落ち着いてから出る(途中で選択が変われば数え直す)', async () => {
		const { container } = await mountMd();
		stubLayout(container, { left: 120, top: 300, bottom: 320 });
		selectByKeys(1, 0, 3);
		await settleLong();
		expect(bar(container), 'すぐには出ない').toBeNull();
		await wait(SELECTION_BAR_SETTLE_MS / 2);
		selectByKeys(1, 0, 5);
		await wait(SELECTION_BAR_SETTLE_MS / 2 + 20);
		expect(bar(container), '選択が変わったので数え直し=まだ出ない').toBeNull();
		await wait(SELECTION_BAR_SETTLE_MS / 2 + 50);
		expect(bar(container), '落ち着いたら出る').not.toBeNull();
	});

	it('NodeSelection(画像)では出ない', async () => {
		const { container } = await mountMd();
		stubLayout(container, { left: 120, top: 300, bottom: 320 });
		const v = view();
		let imagePos = -1;
		v.state.doc.descendants((n, pos) => {
			if (imagePos < 0 && n.type.name === 'image') imagePos = pos;
			return imagePos < 0;
		});
		expect(imagePos).toBeGreaterThan(0);
		v.dom.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
		v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, imagePos)));
		v.dom.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
		await settleLong();
		await wait(SELECTION_BAR_SETTLE_MS + 50);
		expect(bar(container)).toBeNull();
	});

	it('変換中(compositionstart)は出ない・出ていても消える。打鍵(文書の変更)でも消える', async () => {
		const { container } = await mountMd();
		stubLayout(container, { left: 120, top: 300, bottom: 320 });
		const v = view();
		v.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
		await settle();
		expect(v.composing).toBe(true);
		await selectByMouse(1, 0, 5);
		await wait(SELECTION_BAR_SETTLE_MS + 50);
		expect(bar(container), '変換中は出ない').toBeNull();
		v.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
		await settleLong();
		await wait(50);
		await selectByMouse(1, 0, 5);
		expect(bar(container)).not.toBeNull();
		v.dispatch(v.state.tr.insertText('x'));
		await settleLong();
		await wait(SELECTION_BAR_SETTLE_MS + 50);
		expect(bar(container), '打鍵で消える').toBeNull();
	});

	it('Esc で消える(選択と文書は変わらない)', async () => {
		const { container } = await mountMd();
		stubLayout(container, { left: 120, top: 300, bottom: 320 });
		await selectByMouse(1, 0, 5);
		expect(bar(container)).not.toBeNull();
		const v = view();
		const sel = { from: v.state.selection.from, to: v.state.selection.to };
		v.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		await settleLong();
		expect(bar(container)).toBeNull();
		expect({ from: v.state.selection.from, to: v.state.selection.to }).toEqual(sel);
		expect(handle().text()).toBe(MD);
	});

	it('右クリックのメニューを出している間は消える', async () => {
		const { container } = await mountMd();
		stubLayout(container, { left: 120, top: 300, bottom: 320 });
		await selectByMouse(1, 0, 5);
		expect(bar(container)).not.toBeNull();
		view().dom.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 50 }));
		await settleLong();
		expect(bar(container)).toBeNull();
	});

	it('コードの面・raw・読み取り専用(SSH の Markdown)では出ない', async () => {
		const txt = await mountText();
		const root = txt.container.querySelector<HTMLElement>('[data-testid="code-editor"]')!;
		root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
		await wait(SELECTION_BAR_SETTLE_MS + 50);
		expect(bar(txt.container)).toBeNull();
		cleanup();
		windowState.clearDocument();
		windowState.fileEditor = null;

		const md = await mountMd();
		stubLayout(md.container, { left: 120, top: 300, bottom: 320 });
		await selectByMouse(1, 0, 5);
		expect(bar(md.container)).not.toBeNull();
		handle().toggleRaw();
		await settleLong();
		await wait(50);
		expect(handle().raw).toBe(true);
		expect(bar(md.container), 'raw では消える').toBeNull();
		cleanup();
		windowState.clearDocument();
		windowState.fileEditor = null;

		const ssh = await mountMd(MD, 'ssh://host/srv/notes/plan.md');
		expect(ssh.container.querySelector('.ProseMirror'), '読み取り専用の Markdown は面が無い').toBeNull();
		expect(bar(ssh.container)).toBeNull();
	});
});

describe('AC-74-63: 位置(選択のすぐ上・上に入らなければ下・面の外にはみ出さない・スクロールで写し直す)', () => {
	it('選択の上に出る(top < 選択の top・left は選択の左)。選択が面の上端に近ければ下に出る', async () => {
		const { container } = await mountMd();
		stubLayout(container, { left: 120, top: 300, bottom: 320 });
		await selectByMouse(1, 0, 5);
		const el = bar(container)!;
		expect(el.style.position || getComputedStyle(el).position).toMatch(/absolute|fixed/);
		expect(px(el.style.top)).toBeLessThan(300);
		expect(px(el.style.left)).toBe(120);
		expect(el.getAttribute('data-placement')).toBe('above');

		stubLayout(container, { left: 120, top: 4, bottom: 24 });
		await selectByMouse(1, 0, 7);
		const below = bar(container)!;
		expect(below.getAttribute('data-placement')).toBe('below');
		expect(px(below.style.top)).toBeGreaterThanOrEqual(24);
	});

	it('右端に寄った選択でも面の右端からはみ出さない(left は bounds.right - 幅以下)・負にならない', async () => {
		const { container } = await mountMd();
		stubLayout(container, { left: 790, top: 300, bottom: 320 }, { left: 0, top: 0, right: 800, bottom: 600 });
		await selectByMouse(1, 0, 5);
		const el = bar(container)!;
		expect(px(el.style.left)).toBeLessThanOrEqual(800 - el.offsetWidth);
		expect(px(el.style.left)).toBeGreaterThanOrEqual(0);
		expect(px(el.style.top)).toBeGreaterThanOrEqual(0);
	});

	it('article.viewer のスクロールで位置を写し直す', async () => {
		const { container } = await mountMd();
		stubLayout(container, { left: 120, top: 300, bottom: 320 });
		await selectByMouse(1, 0, 5);
		const before = px(bar(container)!.style.top);
		stubLayout(container, { left: 120, top: 200, bottom: 220 });
		container.querySelector('article.viewer')!.dispatchEvent(new Event('scroll', { bubbles: true }));
		await settleLong();
		await wait(50);
		expect(px(bar(container)!.style.top)).toBe(before - 100);
	});
});

describe('AC-74-63: 中身と押下(ツールバーと同じ関数)', () => {
	it('中身= select(段落の種類)+ Bold / Italic / Strikethrough / Inline Code / Link… | Clear Formatting。aria-pressed は activeFormat(太字の中)', async () => {
		const { container } = await mountMd();
		stubLayout(container, { left: 120, top: 300, bottom: 320 });
		const v = view();
		const bold = textSpots(v.state.doc, 1).find((s) => s.text === 'bold')!;
		v.dom.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
		v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, bold.pos, bold.pos + 4)));
		v.dom.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
		await settleLong();
		const el = bar(container)!;
		const select = el.querySelector<HTMLSelectElement>('[data-testid="selection-block-type"]')!;
		expect(select).not.toBeNull();
		expect([...select.options].map((o) => o.value)).toEqual([
			'format-body-text',
			'format-heading-1',
			'format-heading-2',
			'format-heading-3',
			'format-heading-4',
			'format-heading-5',
			'format-heading-6',
		]);
		expect(select.value).toBe('format-body-text');
		expect([...el.querySelectorAll<HTMLElement>('[data-format-id]')].map((b) => b.getAttribute('data-format-id'))).toEqual([
			'format-bold',
			'format-italic',
			'format-strikethrough',
			'format-inline-code',
			'format-link',
			'format-clear',
		]);
		expect(button(container, 'format-bold').getAttribute('aria-pressed')).toBe('true');
		expect(button(container, 'format-italic').getAttribute('aria-pressed')).toBe('false');
		expect(button(container, 'format-link').hasAttribute('aria-pressed')).toBe(false);
		expect(button(container, 'format-clear').hasAttribute('aria-pressed')).toBe(false);
		expect(button(container, 'format-bold').getAttribute('title')).toBe('Bold (Command + B)');
	});

	it('Bold を押すとメニューと同じ結果(取引 1 つ)。mousedown は preventDefault で選択は保たれ、バーは出たまま(押下が true に)', async () => {
		const { container } = await mountMd();
		stubLayout(container, { left: 120, top: 300, bottom: 320 });
		await selectByMouse(1, 0, 5); // 'Intro'
		const v = view();
		const sel = { from: v.state.selection.from, to: v.state.selection.to };
		const depth = undoDepth(v.state);
		const b = button(container, 'format-bold');
		const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		b.dispatchEvent(down);
		expect(down.defaultPrevented).toBe(true);
		await fireEvent.click(b);
		await settleLong();
		expect(handle().text()).toBe(MD.replace('Intro paragraph', '**Intro** paragraph'));
		expect(undoDepth(v.state)).toBe(depth + 1);
		expect({ from: v.state.selection.from, to: v.state.selection.to }).toEqual(sel);
		expect(bar(container), '選択は空でないので出たまま').not.toBeNull();
		expect(button(container, 'format-bold').getAttribute('aria-pressed')).toBe('true');
	});

	it('select で Heading 2・Clear Formatting もメニューと同じ結果', async () => {
		const { container } = await mountMd();
		stubLayout(container, { left: 120, top: 300, bottom: 320 });
		await selectByMouse(1, 0, 5);
		const select = bar(container)!.querySelector<HTMLSelectElement>('[data-testid="selection-block-type"]')!;
		await fireEvent.change(select, { target: { value: 'format-heading-2' } });
		await settleLong();
		expect(handle().text()).toBe(MD.replace('Intro paragraph with **bold** word.', '## Intro paragraph with **bold** word.'));
		expect(select.value).toBe('format-heading-2');
		const v = view();
		const spots = textSpots(v.state.doc, 1);
		v.dom.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
		v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, spots[0]!.pos, spots.at(-1)!.pos + spots.at(-1)!.text.length)));
		v.dom.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
		await settleLong();
		await fireEvent.click(button(container, 'format-clear'));
		await settleLong();
		expect(handle().text()).toBe(MD.replace('Intro paragraph with **bold** word.', '## Intro paragraph with bold word.'));
	});

	it('書式のツールバーと同時に出てよい', async () => {
		localStorage.setItem('vellis.formatToolbar', 'true');
		const { container } = await mountMd();
		expect(container.querySelector('[data-testid="format-toolbar"]')).not.toBeNull();
		stubLayout(container, { left: 120, top: 300, bottom: 320 });
		await selectByMouse(1, 0, 5);
		expect(bar(container)).not.toBeNull();
		expect(container.querySelector('[data-testid="format-toolbar"]')).not.toBeNull();
	});
});

describe('4-3: 見た目と印刷(ソース走査)', () => {
	it('SelectionBar.svelte はトークンだけで描き(hex / 色関数の直書きなし・オーバーレイの 1 段=--color-bg-raised / --shadow-2 / --radius-md)、@media print で隠す。print.css は無改変', () => {
		const src = readFileSync(resolve(REPO_ROOT, 'src/components/SelectionBar.svelte'), 'utf8');
		const style = (src.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
		expect(style.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], 'hex の直書き').toEqual([]);
		expect(style.match(/\b(?:rgba?|hsla?)\(/g) ?? [], '色関数の直書き').toEqual([]);
		for (const token of ['--color-bg-raised', '--shadow-2', '--radius-md']) expect(style, token).toMatch(new RegExp(`var\\(\\s*${token}\\b`));
		expect(src).toContain('data-testid="selection-bar"');
		expect(/@media\s+print\s*\{[\s\S]*?\.selection-bar[^{}]*\{[^}]*display\s*:\s*none/.test(style), '部品の @media print で隠す').toBe(true);
		const printCss = readFileSync(resolve(REPO_ROOT, 'src/styles/print.css'), 'utf8');
		expect(printCss).not.toContain('selection-bar');
	});
});

// 第4段の P3 の穴(S2): 選択を保ったまま文書が変わる取引=バー以外の経路(メニュー / Command + B)では消え、バーのボタンからなら出たまま(実装の規則を固定)
describe('P3 S2: 選択を保ったまま文書が変わる取引と浮遊バー', () => {
	it('メニュー / Command + B の経路(runFormatCommand)で太字にすると、選択は残るがバーは消える(文書の変更=打鍵と同じ扱い)。次の選択の契機で戻る', async () => {
		const { container } = await mountMd();
		stubLayout(container, { left: 120, top: 300, bottom: 320 });
		await selectByMouse(1, 0, 5);
		expect(bar(container)).not.toBeNull();
		const v = view();
		expect(runFormatCommand('format-bold', handle())).toBe(true);
		await settleLong();
		expect(v.state.selection.empty, '選択は残る').toBe(false);
		expect(handle().text()).toBe(MD.replace('Intro paragraph', '**Intro** paragraph'));
		expect(bar(container), 'バー以外の経路の文書の変更では消える').toBeNull();
		await selectByMouse(1, 0, 5);
		expect(bar(container), '次の選択の契機で戻る').not.toBeNull();
		expect(button(container, 'format-bold').getAttribute('aria-pressed')).toBe('true');
	});

	it('バーのボタンからの変更ではバーは出たまま(押下だけが変わる)=既存の件と対で固定', async () => {
		const { container } = await mountMd();
		stubLayout(container, { left: 120, top: 300, bottom: 320 });
		await selectByMouse(1, 0, 5);
		await fireEvent.click(button(container, 'format-italic'));
		await settleLong();
		expect(bar(container)).not.toBeNull();
		expect(button(container, 'format-italic').getAttribute('aria-pressed')).toBe('true');
		expect(handle().text()).toBe(MD.replace('Intro paragraph', '*Intro* paragraph'));
	});
});
