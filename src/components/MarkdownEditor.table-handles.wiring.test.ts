/**
 * 要件#74 Issue #832「表の行と列の頭に、操作のメニューを開く印を出す」— 面の配線(docs/requirements/req-74.md 末尾の節
 * 「#832 表の行と列の頭の印」T1〜T7。由谷の決定 2026-11-22。component プロジェクト・JSDOM に Viewer を載せる)。
 * 純関数の分(複製・寄せ・末尾に足す・メニューの中身)は `src/editor/table-handle-commands.acceptance.test.ts`。
 *
 * ## 判定するもの
 * - T1: カーソルを表のセルに置くとその行の印と列の印が出る。表の外に動かすと消える。マウスを乗せた行と列にも出る
 *   (mouseover / mousemove の event.target の td / th から求める=jsdom の座標は 0)。表から離れると消える。カーソルの行と
 *   マウスの行が違えば両方に出る
 * - T2 / T3: 行の印を押すと 4 項目・列の印を押すと 7 項目のメニューが開く(英語・並びは契約)。押しただけでは文書も選択も変わらない
 * - T2 / T3 の項目を押すと文書が変わる(印の行・列に対して=カーソルの行ではない)。Insert Row Below で行が 1 つ増える・
 *   Delete Row で印の行が消える・Duplicate Column・Align Center で区切りの行が :---: になる。取引 1 つ(undo 1 段で元の文字列)
 * - T4: 下端の + で末尾に本文の行・右端の + で末尾に列(どちらも取引 1 つ)。カーソルかマウスが表にあるときだけ出る
 * - T6: 読み取り専用(SSH の今の描画・readOnly の面)と Raw Source では印も + も出ない。印と + は書き出し(handle.text())と
 *   面の見えている文字(`.markdown-body` の textContent=Viewer の検索の元)に出ない
 * - T7: 印の色は inline の色リテラルで塗らない(トークンは AC-56-3 の走査が MarkdownEditor.svelte を見る)。印は押せる部品
 *   (button か role=button)で英語の aria-label を持つ
 *
 * ## 確定契約(implementer はこれに従う。名前は test-writer の推奨=報告に列挙)
 *
 * ```ts
 * // --- src/components/MarkdownEditor.svelte(面の根 [data-testid="markdown-editor"] の中に出す。rendered・書けるときだけ)
 * // 行の印:   [data-testid="table-row-handle"]    data-row="<表の中の行の番号(見出し=0)>"   aria-label(英語)
 * // 列の印:   [data-testid="table-column-handle"] data-col="<見出しの行で数えた列の番号>"      aria-label(英語)
 * // 下端の +: [data-testid="table-append-row"]    aria-label(英語)
 * // 右端の +: [data-testid="table-append-column"] aria-label(英語)
 * //   出す条件: カーソルが表のセルにある(その行・列)・マウスが表のセルの上にある(その行・列)。両方あれば両方(同じ行なら 1 つ)。
 * //   どちらも無ければ 4 つとも出さない(DOM から外すか hidden / aria-hidden="true")
 * //   印の textContent は空(字は aria-label か CSS / SVG で)= .markdown-body の textContent を変えない
 * // 印を押す(click)→ メニュー。ネイティブ(`$lib/native-menu` の popupMenu(entries, onAction))か、面の中の DOM の
 * //   [data-testid="table-handle-menu"] の [role="menuitem"](textContent=項目の名前)のどちらでもよい(両方を受け付ける)
 * //   entries = buildTableHandleMenu('row' | 'column')。項目を押すと、その印の行 / 列を対象にして Command を 1 回(取引 1 つ)
 * // + を押す → TABLE_HANDLE_COMMANDS の append-row / append-column を 1 回
 * ```
 *
 * ## 判断の記録(test-writer 2026-11-22)
 * - メニューの出し方は固定しない(ネイティブ=右クリックのメニューと同じ経路が推奨。DOM でも通る)。T2 / T3 は「開いた項目の名前の並び」と
 *   「押した結果」で判定する
 * - 印の行と列は data-row / data-col で判定する(jsdom では位置の px を見られない。契約も位置を縛らない)
 * - 印の textContent を空にすることで T6 の「検索に出ない」を機械で判定する(Viewer の検索は .markdown-body の textContent)
 * - マウスの行と列は event.target(td / th)から求めるものとする(座標から求めると jsdom で判定できず、実機でも zoom の影響を受ける)
 *
 * ## 修正前に赤になる理由
 * - 面に印・+ の部品が無く(data-testid が無い)、T1 の「出る」・T2〜T4 の「押せる」が落ちる。T6 の「出ない」は守り(今も緑)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { TextSelection } from 'prosemirror-state';
import { undo, undoDepth } from 'prosemirror-history';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView as PMView } from 'prosemirror-view';

import Viewer from './Viewer.svelte';
import MarkdownEditor from './MarkdownEditor.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { MarkdownEditorHandle } from '../editor/file-editor';
import type { EditorMenuEntry } from '../editor/editor-context-menu';
import { findMatches } from '$lib/find-in-document';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => undefined), openPath: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), message: vi.fn(), open: vi.fn() }));
vi.mock('$lib/mermaid-mounter', () => ({ mountMermaid: vi.fn(async () => undefined) }));
vi.mock('$lib/events', () => ({ listen: async () => () => {} }));
vi.mock('@tauri-apps/api/window', async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	const fake = { label: 'main', emit: vi.fn(async () => undefined), onFocusChanged: vi.fn(async () => () => {}), listen: vi.fn(async () => () => {}) };
	return { ...actual, getCurrentWindow: () => fake };
});
vi.mock('$lib/native-menu', () => ({ popupMenu: vi.fn(async () => undefined) }));

import { popupMenu } from '$lib/native-menu';
const popupMock = vi.mocked(popupMenu);

// ---------------------------------------------------------------------------
// JSDOM の polyfill と面の載せ方(MarkdownEditor.compose-format-key.wiring.test.ts と同じ)
// ---------------------------------------------------------------------------

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

const MD_URI = 'file:///Users/a/notes/handles.md';
const SSH_URI = 'ssh://host/srv/notes/handles.md';
/** 段落・3×3 の表(見出し + 本文 2 行)・段落。 */
const SRC = 'intro\n\n| h1 | h2 | h3 |\n| - | - | - |\n| a1 | a2 | a3 |\n| b1 | b2 | b3 |\n\nafter\n';

const ROW_LABELS = ['Insert Row Above', 'Insert Row Below', 'Duplicate Row', 'Delete Row'];
const COLUMN_LABELS = ['Insert Column Left', 'Insert Column Right', 'Duplicate Column', 'Delete Column', 'Align Left', 'Align Center', 'Align Right'];

const FACE = '[data-testid="markdown-editor"]';
const ROW_HANDLE = '[data-testid="table-row-handle"]';
const COLUMN_HANDLE = '[data-testid="table-column-handle"]';
const APPEND_ROW = '[data-testid="table-append-row"]';
const APPEND_COLUMN = '[data-testid="table-append-column"]';
const DOM_MENU_ITEM = '[data-testid="table-handle-menu"] [role="menuitem"]';

async function settle(rounds = 8) {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
	await tick();
}
async function settleLong() {
	await settle();
	await new Promise((r) => setTimeout(r, 0));
	await settle();
}

async function mountMd(content: string, uri = MD_URI) {
	const d: DocumentPayload = { uri, content, modified: 1 };
	windowState.setDocument(d);
	const r = await renderMarkdown(content, uri);
	const result = render(Viewer, {
		props: { document: d, html: r.html, index: r.index, onRequestAddMark: vi.fn(), onToggleMarks: vi.fn(), marksOpen: false },
	});
	await settleLong();
	return result;
}
function handle(): MarkdownEditorHandle {
	const h = windowState.fileEditor as MarkdownEditorHandle | null;
	if (!h) throw new Error('windowState.fileEditor が登録されていない');
	if (h.kind !== 'markdown') throw new Error(`handle.kind が markdown でない: ${String(h.kind)}`);
	return h;
}
function pm(): PMView {
	return handle().view;
}
function text(): string {
	return handle().text();
}
function face(container: HTMLElement): HTMLElement {
	const el = container.querySelector<HTMLElement>(FACE);
	if (!el) throw new Error('面の根が無い');
	return el;
}
/** 見えている部品(hidden / aria-hidden="true" は出ていない扱い)。 */
function shown(container: HTMLElement, selector: string): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>(selector)].filter((el) => !el.hidden && el.getAttribute('aria-hidden') !== 'true');
}
function rowHandles(container: HTMLElement): number[] {
	return shown(container, ROW_HANDLE)
		.map((el) => Number(el.getAttribute('data-row')))
		.sort((a, b) => a - b);
}
function columnHandles(container: HTMLElement): number[] {
	return shown(container, COLUMN_HANDLE)
		.map((el) => Number(el.getAttribute('data-col')))
		.sort((a, b) => a - b);
}
function rowHandle(container: HTMLElement, row: number): HTMLElement {
	const el = shown(container, ROW_HANDLE).find((h) => Number(h.getAttribute('data-row')) === row);
	if (!el) throw new Error(`行 ${row} の印が無い(出ている行: ${rowHandles(container).join(',')})`);
	return el;
}
function columnHandle(container: HTMLElement, col: number): HTMLElement {
	const el = shown(container, COLUMN_HANDLE).find((h) => Number(h.getAttribute('data-col')) === col);
	if (!el) throw new Error(`列 ${col} の印が無い(出ている列: ${columnHandles(container).join(',')})`);
	return el;
}
function appendRow(container: HTMLElement): HTMLElement[] {
	return shown(container, APPEND_ROW);
}
function appendColumn(container: HTMLElement): HTMLElement[] {
	return shown(container, APPEND_COLUMN);
}
function nothingShown(container: HTMLElement) {
	expect(rowHandles(container), '行の印').toEqual([]);
	expect(columnHandles(container), '列の印').toEqual([]);
	expect(appendRow(container), '下端の +').toEqual([]);
	expect(appendColumn(container), '右端の +').toEqual([]);
}

/** 文書の中の文字 `t`(セルか段落)の先頭 +col にカーソルを置く(取引=選択だけ)。 */
async function placeCursor(view: PMView, t: string, col = 0) {
	let pos = -1;
	view.state.doc.descendants((n, p) => {
		if (pos >= 0) return false;
		if (n.isText && n.text === t) pos = p;
		return pos < 0;
	});
	if (pos < 0) throw new Error(`文字 '${t}' が無い`);
	view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + col)));
	await settleLong();
}
/** 面の中の文字 `t` を持つセル(td / th)。 */
function cellEl(container: HTMLElement, t: string): HTMLElement {
	const el = [...container.querySelectorAll<HTMLElement>(`${FACE} td, ${FACE} th`)].find((c) => c.textContent === t);
	if (!el) throw new Error(`セル '${t}' の要素が無い`);
	return el;
}
/** マウスをセルの上に乗せる(mouseover と mousemove。target はセル)。 */
async function hover(container: HTMLElement, t: string) {
	const el = cellEl(container, t);
	await fireEvent.mouseOver(el, { bubbles: true });
	await fireEvent.mouseMove(el, { bubbles: true });
	await settleLong();
}
/** マウスを表の外(段落 `after`)へ移す(mouseout・mouseleave・mouseover のどれで受けてもよい)。 */
async function leaveTable(container: HTMLElement, from: string) {
	const cell = cellEl(container, from);
	const table = cell.closest('table')!;
	const after = [...container.querySelectorAll<HTMLElement>(`${FACE} p`)].find((p) => p.textContent === 'after')!;
	await fireEvent.mouseOut(cell, { bubbles: true, relatedTarget: after });
	await fireEvent.mouseLeave(table, { relatedTarget: after });
	await fireEvent.mouseOver(after, { bubbles: true });
	await fireEvent.mouseMove(after, { bubbles: true });
	await settleLong();
}

function firstTable(doc: PMNode): PMNode {
	let found: PMNode | null = null;
	doc.descendants((n) => {
		if (found) return false;
		if (n.type.name === 'table') found = n;
		return !found;
	});
	if (!found) throw new Error('表が無い');
	return found;
}
function texts(table: PMNode): string[][] {
	const rows: string[][] = [];
	table.forEach((row) => {
		const cells: string[] = [];
		row.forEach((c) => cells.push(c.textContent));
		rows.push(cells);
	});
	return rows;
}
function aligns(table: PMNode): Array<string | null>[] {
	const rows: Array<string | null>[] = [];
	table.forEach((row) => {
		const cells: Array<string | null> = [];
		row.forEach((c) => cells.push((c.attrs.align as string | null) ?? null));
		rows.push(cells);
	});
	return rows;
}
/** 書き出しの区切りの行のセル。 */
function delimiterCells(out: string): string[] {
	const lines = out.split('\n');
	const first = lines.findIndex((l) => l.trimStart().startsWith('|'));
	return lines[first + 1]!.split('|').slice(1, -1).map((c) => c.trim());
}

/** 開いたメニュー(ネイティブの popupMenu か、面の中の DOM)。無ければ null。 */
function openedMenu(container: HTMLElement): { labels: string[]; pick: (label: string) => Promise<void> } | null {
	if (popupMock.mock.calls.length > 0) {
		const [entries, onAction] = popupMock.mock.calls[popupMock.mock.calls.length - 1]! as unknown as [EditorMenuEntry[], (id: string) => void];
		const items = entries.filter((e): e is Extract<EditorMenuEntry, { kind: 'item' }> => e.kind === 'item');
		expect(entries.some((e) => e.kind === 'submenu'), '印のメニューに submenu は無い').toBe(false);
		return {
			labels: items.map((e) => e.label),
			pick: async (label) => {
				const item = items.find((e) => e.label === label);
				if (!item) throw new Error(`項目 '${label}' が無い`);
				onAction(item.id);
				await settleLong();
			},
		};
	}
	const items = shown(container, DOM_MENU_ITEM);
	if (items.length === 0) return null;
	return {
		labels: items.map((el) => (el.textContent ?? '').trim()),
		pick: async (label) => {
			const item = items.find((el) => (el.textContent ?? '').trim() === label);
			if (!item) throw new Error(`項目 '${label}' が無い`);
			await fireEvent.click(item);
			await settleLong();
		},
	};
}
async function openMenu(container: HTMLElement, el: HTMLElement) {
	popupMock.mockClear();
	await fireEvent.click(el);
	await settleLong();
	const menu = openedMenu(container);
	if (!menu) throw new Error('印を押してもメニューが開かない(popupMenu も DOM の [data-testid="table-handle-menu"] も無い)');
	return menu;
}
function expectControl(el: HTMLElement, what: string) {
	expect(el.tagName === 'BUTTON' || el.getAttribute('role') === 'button', `${what} は押せる部品(button か role=button)`).toBe(true);
	const label = el.getAttribute('aria-label') ?? '';
	expect(label, `${what} の aria-label は英語`).toMatch(/^[A-Za-z][A-Za-z0-9 ,.…-]*$/);
	expect((el.textContent ?? '').trim(), `${what} の textContent は空(見えている文字に出ない)`).toBe('');
	expect(el.getAttribute('style') ?? '', `${what} は inline の色リテラルで塗らない(トークン)`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
}

beforeEach(() => {
	popupMock.mockClear();
	windowState.fileEditor = null;
	windowState.editBlocked = false;
});
afterEach(() => {
	cleanup();
	windowState.fileEditor = null;
});

// ---------------------------------------------------------------------------
// T1: 出すとき・出さないとき
// ---------------------------------------------------------------------------

describe('#832 T1: カーソルのある行と列に印が出る', () => {
	it('開いた直後(カーソルは段落)は印も + も無い。a2 にカーソル → 行 1 の印・列 1 の印・+ が 2 つ。after へ動かすと消える', async () => {
		const { container } = await mountMd(SRC);
		nothingShown(container);

		await placeCursor(pm(), 'a2');
		expect(rowHandles(container)).toEqual([1]);
		expect(columnHandles(container)).toEqual([1]);
		expect(appendRow(container)).toHaveLength(1);
		expect(appendColumn(container)).toHaveLength(1);
		expectControl(rowHandle(container, 1), '行の印');
		expectControl(columnHandle(container, 1), '列の印');
		expectControl(appendRow(container)[0]!, '下端の +');
		expectControl(appendColumn(container)[0]!, '右端の +');

		await placeCursor(pm(), 'after');
		nothingShown(container);
	});

	it('見出しの h3 → 行 0 の印・列 2 の印。b1 へ → 行 2・列 0(前の印は消える)', async () => {
		const { container } = await mountMd(SRC);
		await placeCursor(pm(), 'h3');
		expect(rowHandles(container)).toEqual([0]);
		expect(columnHandles(container)).toEqual([2]);

		await placeCursor(pm(), 'b1');
		expect(rowHandles(container)).toEqual([2]);
		expect(columnHandles(container)).toEqual([0]);
	});

	it('印は面の根の中にあり、ProseMirror の文書の文字ではない(書き出しは不変)', async () => {
		const { container } = await mountMd(SRC);
		await placeCursor(pm(), 'a2');
		expect(face(container).contains(rowHandle(container, 1))).toBe(true);
		expect(face(container).contains(columnHandle(container, 1))).toBe(true);
		expect(text()).toBe(SRC);
	});
});

describe('#832 T1: マウスを乗せた行と列にも出る', () => {
	it('カーソルは段落のまま、b1 に乗せる → 行 2・列 0・+。a3 に移す → 行 1・列 2(b の印は消える)。表から離れる → 消える', async () => {
		const { container } = await mountMd(SRC);
		await placeCursor(pm(), 'intro');
		nothingShown(container);

		await hover(container, 'b1');
		expect(rowHandles(container)).toEqual([2]);
		expect(columnHandles(container)).toEqual([0]);
		expect(appendRow(container)).toHaveLength(1);
		expect(appendColumn(container)).toHaveLength(1);

		await hover(container, 'a3');
		expect(rowHandles(container)).toEqual([1]);
		expect(columnHandles(container)).toEqual([2]);

		await leaveTable(container, 'a3');
		nothingShown(container);
	});

	it('カーソルが a2・マウスが b1 → 行は 1 と 2・列は 0 と 1 の両方。マウスが離れてもカーソルの分は残る', async () => {
		const { container } = await mountMd(SRC);
		await placeCursor(pm(), 'a2');
		await hover(container, 'b1');
		expect(rowHandles(container)).toEqual([1, 2]);
		expect(columnHandles(container)).toEqual([0, 1]);

		await leaveTable(container, 'b1');
		expect(rowHandles(container)).toEqual([1]);
		expect(columnHandles(container)).toEqual([1]);
	});

	it('カーソルとマウスが同じ行・列(a2 と a2)→ 印は 1 つずつ', async () => {
		const { container } = await mountMd(SRC);
		await placeCursor(pm(), 'a2');
		await hover(container, 'a2');
		expect(rowHandles(container)).toEqual([1]);
		expect(columnHandles(container)).toEqual([1]);
	});
});

// ---------------------------------------------------------------------------
// T2 / T3: 印を押すとメニュー・項目を押すと文書が変わる
// ---------------------------------------------------------------------------

describe('#832 T2 / T3: 印を押すとメニューが開く(押しただけでは文書も選択も変わらない)', () => {
	it('行の印 → Insert Row Above・Insert Row Below・Duplicate Row・Delete Row(この並び・Delete Table 無し)', async () => {
		const { container } = await mountMd(SRC);
		await placeCursor(pm(), 'a2');
		const before = pm().state.selection;
		const menu = await openMenu(container, rowHandle(container, 1));
		expect(menu.labels).toEqual(ROW_LABELS);
		expect(text(), '押しただけでは文書は変わらない').toBe(SRC);
		expect(pm().state.selection.eq(before), '選択も変わらない').toBe(true);
		if (popupMock.mock.calls.length > 0) expect(popupMock, 'メニューは 1 回だけ開く').toHaveBeenCalledTimes(1);
	});

	it('列の印 → Insert Column Left・Insert Column Right・Duplicate Column・Delete Column・Align Left・Align Center・Align Right', async () => {
		const { container } = await mountMd(SRC);
		await placeCursor(pm(), 'a2');
		const menu = await openMenu(container, columnHandle(container, 1));
		expect(menu.labels).toEqual(COLUMN_LABELS);
		expect(menu.labels).not.toContain('Delete Table');
		expect(text()).toBe(SRC);
	});

	it('マウスで出た印(カーソルの無い行)も押せてメニューが開く', async () => {
		const { container } = await mountMd(SRC);
		await placeCursor(pm(), 'intro');
		await hover(container, 'b2');
		const menu = await openMenu(container, rowHandle(container, 2));
		expect(menu.labels).toEqual(ROW_LABELS);
	});
});

describe('#832 T2 / T3 / T5: 項目を押すと、その印の行・列が変わる(取引 1 つ)', () => {
	it('行 1 の印 ▸ Insert Row Below → a の下に空の行(4 行)。undo 1 回で元の文字列', async () => {
		const { container } = await mountMd(SRC);
		await placeCursor(pm(), 'a2');
		const depth = undoDepth(pm().state);
		const menu = await openMenu(container, rowHandle(container, 1));
		await menu.pick('Insert Row Below');
		expect(texts(firstTable(pm().state.doc))).toEqual([
			['h1', 'h2', 'h3'],
			['a1', 'a2', 'a3'],
			['', '', ''],
			['b1', 'b2', 'b3'],
		]);
		expect(text().split('\n').filter((l) => l.startsWith('|'))).toHaveLength(5);
		expect(undoDepth(pm().state), '取引 1 つ').toBe(depth + 1);
		expect(undo(pm().state, pm().dispatch)).toBe(true);
		await settleLong();
		expect(text()).toBe(SRC);
	});

	it('カーソルは a2・マウスで出た行 2 の印 ▸ Delete Row → b の行が消える(カーソルの行 a は残る)', async () => {
		const { container } = await mountMd(SRC);
		await placeCursor(pm(), 'a2');
		await hover(container, 'b1');
		const menu = await openMenu(container, rowHandle(container, 2));
		await menu.pick('Delete Row');
		expect(texts(firstTable(pm().state.doc))).toEqual([
			['h1', 'h2', 'h3'],
			['a1', 'a2', 'a3'],
		]);
	});

	it('行 0(見出し)の印 ▸ Duplicate Row → 見出しのすぐ下に本文の行として写し', async () => {
		const { container } = await mountMd(SRC);
		await placeCursor(pm(), 'h1');
		const menu = await openMenu(container, rowHandle(container, 0));
		await menu.pick('Duplicate Row');
		const t = firstTable(pm().state.doc);
		expect(texts(t)).toEqual([
			['h1', 'h2', 'h3'],
			['h1', 'h2', 'h3'],
			['a1', 'a2', 'a3'],
			['b1', 'b2', 'b3'],
		]);
		expect(t.child(1).child(0).type.name).toBe('table_cell');
	});

	it('列 1 の印 ▸ Duplicate Column → h2 の列が 2 つ(4 列)', async () => {
		const { container } = await mountMd(SRC);
		await placeCursor(pm(), 'a2');
		const menu = await openMenu(container, columnHandle(container, 1));
		await menu.pick('Duplicate Column');
		expect(texts(firstTable(pm().state.doc))).toEqual([
			['h1', 'h2', 'h2', 'h3'],
			['a1', 'a2', 'a2', 'a3'],
			['b1', 'b2', 'b2', 'b3'],
		]);
	});

	it('カーソルは a2・マウスで出た列 2 の印 ▸ Align Center → 列 2 の全行が center・書き出しの区切りが :---:(列 1 は触らない)', async () => {
		const { container } = await mountMd(SRC);
		await placeCursor(pm(), 'a2');
		await hover(container, 'b3');
		const depth = undoDepth(pm().state);
		const menu = await openMenu(container, columnHandle(container, 2));
		await menu.pick('Align Center');
		expect(aligns(firstTable(pm().state.doc))).toEqual([
			[null, null, 'center'],
			[null, null, 'center'],
			[null, null, 'center'],
		]);
		const cells = delimiterCells(text());
		expect(cells).toHaveLength(3);
		expect(cells[1]).toMatch(/^-+$/);
		expect(cells[2]).toMatch(/^:-+:$/);
		expect(undoDepth(pm().state)).toBe(depth + 1);
		expect(undo(pm().state, pm().dispatch)).toBe(true);
		await settleLong();
		expect(text()).toBe(SRC);
	});

	it('列 0 の印 ▸ Align Right / Align Left → ---: / :---', async () => {
		const { container } = await mountMd(SRC);
		await placeCursor(pm(), 'b1');
		let menu = await openMenu(container, columnHandle(container, 0));
		await menu.pick('Align Right');
		expect(delimiterCells(text())[0]).toMatch(/^-+:$/);
		menu = await openMenu(container, columnHandle(container, 0));
		await menu.pick('Align Left');
		expect(delimiterCells(text())[0]).toMatch(/^:-+$/);
	});

	it('列 1 の印 ▸ Delete Column → 2 列になる', async () => {
		const { container } = await mountMd(SRC);
		await placeCursor(pm(), 'a2');
		const menu = await openMenu(container, columnHandle(container, 1));
		await menu.pick('Delete Column');
		expect(texts(firstTable(pm().state.doc))).toEqual([
			['h1', 'h3'],
			['a1', 'a3'],
			['b1', 'b3'],
		]);
	});
});

// ---------------------------------------------------------------------------
// T4: 端の +
// ---------------------------------------------------------------------------

describe('#832 T4: 下端の + で末尾に行・右端の + で末尾に列', () => {
	it('下端の + → 末尾に空の本文の行(取引 1 つ・undo で元)', async () => {
		const { container } = await mountMd(SRC);
		await placeCursor(pm(), 'h2');
		const depth = undoDepth(pm().state);
		await fireEvent.click(appendRow(container)[0]!);
		await settleLong();
		const t = firstTable(pm().state.doc);
		expect(texts(t)).toEqual([
			['h1', 'h2', 'h3'],
			['a1', 'a2', 'a3'],
			['b1', 'b2', 'b3'],
			['', '', ''],
		]);
		expect(t.child(3).child(0).type.name).toBe('table_cell');
		expect(undoDepth(pm().state)).toBe(depth + 1);
		expect(undo(pm().state, pm().dispatch)).toBe(true);
		await settleLong();
		expect(text()).toBe(SRC);
	});

	it('右端の + → 全行の末尾に空のセル(見出しは th)。取引 1 つ・undo で元', async () => {
		const { container } = await mountMd(SRC);
		await placeCursor(pm(), 'a1');
		const depth = undoDepth(pm().state);
		await fireEvent.click(appendColumn(container)[0]!);
		await settleLong();
		const t = firstTable(pm().state.doc);
		expect(texts(t)).toEqual([
			['h1', 'h2', 'h3', ''],
			['a1', 'a2', 'a3', ''],
			['b1', 'b2', 'b3', ''],
		]);
		expect(t.child(0).child(3).type.name).toBe('table_header');
		expect(t.child(1).child(3).type.name).toBe('table_cell');
		expect(text().split('\n').filter((l) => l.startsWith('|')).every((l) => l.split('|').length - 2 === 4), '書き出しは 4 列').toBe(true);
		expect(undoDepth(pm().state)).toBe(depth + 1);
		expect(undo(pm().state, pm().dispatch)).toBe(true);
		await settleLong();
		expect(text()).toBe(SRC);
	});

	it('マウスを乗せただけ(カーソルは段落)でも + は出て、押すと末尾に行', async () => {
		const { container } = await mountMd(SRC);
		await placeCursor(pm(), 'intro');
		await hover(container, 'b2');
		expect(appendRow(container)).toHaveLength(1);
		await fireEvent.click(appendRow(container)[0]!);
		await settleLong();
		expect(texts(firstTable(pm().state.doc))).toHaveLength(4);
		expect(texts(firstTable(pm().state.doc))[3]).toEqual(['', '', '']);
	});
});

// ---------------------------------------------------------------------------
// T6: 出さない面・文書の中身ではない
// ---------------------------------------------------------------------------

describe('#832 T6: 読み取り専用と Raw Source では出ない', () => {
	it('SSH の文書(今の描画・面なし): セルに乗せても印も + も無い', async () => {
		const { container } = await mountMd(SRC, SSH_URI);
		expect(container.querySelector(FACE), 'SSH は編集面を作らない').toBeNull();
		const td = [...container.querySelectorAll<HTMLElement>('.markdown-body td')].find((c) => c.textContent === 'b1');
		expect(td, '今の描画の表').toBeTruthy();
		await fireEvent.mouseOver(td!, { bubbles: true });
		await fireEvent.mouseMove(td!, { bubbles: true });
		await settleLong();
		nothingShown(container);
	});

	it('readOnly の面(MarkdownEditor を readOnly=true で載せる): カーソルを置いても乗せても出ない', async () => {
		const { container } = render(MarkdownEditor, { props: { uri: MD_URI, content: SRC, readOnly: true } });
		await settleLong();
		expect(handle().readOnly).toBe(true);
		await placeCursor(pm(), 'a2');
		nothingShown(container);
		await hover(container, 'b1');
		nothingShown(container);
	});

	it('Raw Source: 印が出ている状態で raw へ → 消える。戻ると(カーソルが表にあれば)また出る', async () => {
		const { container } = await mountMd(SRC);
		await placeCursor(pm(), 'a2');
		expect(rowHandles(container)).toEqual([1]);

		handle().toggleRaw();
		await settleLong();
		expect(handle().raw).toBe(true);
		expect(container.querySelector('[data-testid="raw-source-editor"]'), 'raw の面').not.toBeNull();
		nothingShown(container);

		handle().toggleRaw();
		await settleLong();
		expect(handle().raw).toBe(false);
		await placeCursor(pm(), 'a2');
		expect(rowHandles(container)).toEqual([1]);
	});
});

describe('#832 T6: 印と + は文書の中身ではない(書き出し・見えている文字=検索の元に出ない)', () => {
	it('印が出ても handle.text() は原文のまま・.markdown-body の textContent は印が無いときと同じ・"+" の検索の数も同じ', async () => {
		const { container } = await mountMd(SRC);
		const body = face(container).closest<HTMLElement>('.markdown-body')!;
		await placeCursor(pm(), 'after');
		nothingShown(container);
		const plain = body.textContent ?? '';
		const plusCount = findMatches(plain, '+').length;

		await placeCursor(pm(), 'a2');
		await hover(container, 'b3');
		expect(rowHandles(container)).toEqual([1, 2]);
		expect(appendRow(container)).toHaveLength(1);
		expect(text(), '書き出しは原文のまま').toBe(SRC);
		expect(body.textContent ?? '', '見えている文字は変わらない').toBe(plain);
		expect(findMatches(body.textContent ?? '', '+')).toHaveLength(plusCount);
		for (const el of [...shown(container, ROW_HANDLE), ...shown(container, COLUMN_HANDLE), ...appendRow(container), ...appendColumn(container)]) {
			expect((el.textContent ?? '').trim()).toBe('');
		}
	});

	it('印が出ている間に保存される文字列(handle.text())にも印は無く、dirty でもない', async () => {
		const { container } = await mountMd(SRC);
		await placeCursor(pm(), 'b2');
		expect(rowHandles(container)).toEqual([2]);
		expect(handle().dirty).toBe(false);
		expect(text()).toBe(SRC);
	});
});
