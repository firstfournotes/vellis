/**
 * 要件#74 Issue #832「表の行と列の頭に、操作のメニューを開く印を出す」— 純関数の分(docs/requirements/req-74.md 末尾の節
 * 「#832 表の行と列の頭の印」T2・T3・T4・T5・T7。由谷の決定 2026-11-22)。面の配線は
 * `src/components/MarkdownEditor.table-handles.wiring.test.ts`。
 *
 * ## 対応する受け入れ基準
 * - T2 / T3: 行の印のメニュー 4 項目・列の印のメニュー 7 項目(並び・英語の名前・id)。表ごと消す項目は入れない
 * - T4: 端の + の中身=末尾に本文の行を 1 つ足す・末尾に列を 1 つ足す
 * - T5: 複製=その行のすぐ下に同じ中身の行(見出しの行の複製は見出しのすぐ下に本文の行として)・その列のすぐ右に同じ中身の列
 *   (その位置にセルがある行だけ・余分なセルは保つ)。寄せ=その列の全部の行のセルの align(書き出しの区切りの行が :--- / :---: / ---:)。
 *   操作 1 つは取引 1 つ(undo 1 段で byte 等価)。表の外では false・取引なし
 * - T7: メニューの文字は英語で、Format ▸ Table と同じ項目は menu.rs と同じ綴り
 *
 * ## 確定契約(implementer はこれに従う。名前は test-writer の推奨=報告に列挙)
 *
 * ```ts
 * // --- src/editor/table-commands.ts に足す(既存の TABLE_COMMANDS / TableFormatItemId は変えない=既存のテストが 7 つに固定)
 * export type TableHandleItemId =
 *   | 'format-table-duplicate-row' | 'format-table-duplicate-column'
 *   | 'format-table-align-left' | 'format-table-align-center' | 'format-table-align-right'
 *   | 'format-table-append-row' | 'format-table-append-column';
 * /** 印のメニューと端の + だけが使う 7 つ(FORMAT_COMMANDS / FORMAT_ITEM_IDS には入れない)。表の外では false・取引なし。 *\/
 * export const TABLE_HANDLE_COMMANDS: Record<TableHandleItemId, Command>;
 * //   duplicate-row: ctx.row のすぐ下に同じ中身(セルの数・各セルの content と align)の行。見出しの行なら見出しのすぐ下に
 * //     table_cell の行として(3-7 と同じ扱い)。カーソルは新しい行の同じ列のセルの先頭
 * //   duplicate-column: ctx.col のすぐ右に、その位置にセルがある行だけ同じ中身のセル(見出しの行は table_header・align も写す)。
 * //     余分なセルは保つ。カーソルは今の行の新しいセルの先頭
 * //   align-left / center / right: ctx.col の位置にセルがある全部の行の、そのセルの align を 'left' / 'center' / 'right' に。
 * //     他の列と余分なセルは触らない。カーソルは動かさない(同じセルの同じ offset)。全部のセルが既にその寄せなら false・取引なし
 * //   append-row: 表の末尾に空の本文の行(= 最後の行で Insert Row Below と同じ中身)。カーソルは新しい行のセルの先頭
 * //   append-column: 見出しの最後の列の右に列(= 見出しの最後のセルで Insert Column Right と同じ中身)。カーソルは今の行の新しいセル
 * // --- src/editor/editor-context-menu.ts に足す
 * /** 印のメニュー(T2=row・T3=column)。項目は kind 'item'(区切りは任意)。submenu は無い。 *\/
 * export function buildTableHandleMenu(kind: 'row' | 'column'): EditorMenuEntry[];
 * ```
 *
 * ## 判断の記録(test-writer 2026-11-22)
 * - id は `format-table-*` のまま(ネイティブのメニューに写すとき native-menu.ts が `ctx-` を付けて Rust の転送と重ならない)。ただし
 *   既存の table-commands.acceptance.test.ts が TABLE_COMMANDS を 7 つ・FORMAT_ITEM_IDS に `format-table-align*` が無いことを固定して
 *   いるので、新しい 7 つは別の表 TABLE_HANDLE_COMMANDS に置き、FORMAT_COMMANDS には入れない(ここでも守る)
 * - 複製の後のカーソルは Insert Row / Column と同じ置き方(新しい行 / セルの先頭)。寄せはカーソルを動かさない
 * - 同じ寄せをもう一度 → 文書が変わらないので取引を積まない(false)。undo の段を無駄に増やさないため
 * - 端の + は既存の規則(Insert Row Below / Insert Column Right)の末尾版として定義し、そろっていない表では既存の操作と同じ結果
 *   になることを比べて固定する(余分なセルの前後は既存の規則に委ねる)
 *
 * ## 修正前に赤になる理由
 * - `TABLE_HANDLE_COMMANDS` と `buildTableHandleMenu` が無い(import は undefined)ので、表の形の検査と呼び出しで落ちる
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TextSelection, type Command, type EditorState } from 'prosemirror-state';
import { undo, undoDepth } from 'prosemirror-history';
import type { Node as PMNode } from 'prosemirror-model';
import { createMarkdownDocument, markdownText, withState, type MarkdownDocument } from './markdown-document';
import { FORMAT_ITEM_IDS } from './commands';
import { TABLE_COMMANDS, TABLE_HANDLE_COMMANDS, type TableFormatItemId, type TableHandleItemId } from './table-commands';
import { buildTableHandleMenu, type EditorMenuEntry } from './editor-context-menu';

const REPO_ROOT = resolve(__dirname, '../..');
const URI = 'file:///Users/a/notes/handles.md';

const HANDLE_IDS: TableHandleItemId[] = [
	'format-table-duplicate-row',
	'format-table-duplicate-column',
	'format-table-align-left',
	'format-table-align-center',
	'format-table-align-right',
	'format-table-append-row',
	'format-table-append-column',
];

/** T2: 行の印のメニュー(並びどおり)。 */
const ROW_MENU: Array<[string, string]> = [
	['format-table-row-above', 'Insert Row Above'],
	['format-table-row-below', 'Insert Row Below'],
	['format-table-duplicate-row', 'Duplicate Row'],
	['format-table-delete-row', 'Delete Row'],
];
/** T3: 列の印のメニュー(並びどおり)。 */
const COLUMN_MENU: Array<[string, string]> = [
	['format-table-column-left', 'Insert Column Left'],
	['format-table-column-right', 'Insert Column Right'],
	['format-table-duplicate-column', 'Duplicate Column'],
	['format-table-delete-column', 'Delete Column'],
	['format-table-align-left', 'Align Left'],
	['format-table-align-center', 'Align Center'],
	['format-table-align-right', 'Align Right'],
];

/** そろえた表・寄せ 3 種(外のブロックなし)。 */
const ALIGNED = '| h1  | h2  | h3  |\n| :-- | :-: | --: |\n| a1  | a2  | a3  |\n| b1  | b2  | b3  |\n';
/** 詰めた表(前後に段落・寄せなし)。 */
const COMPACT = 'intro  text\n\n| h1 | h2 |\n| - | - |\n| a1 | a2 |\n| b1 | b2 |\n\nafter\n';
/** 行ごとのセルの数がそろっていない表(見出しより多いセルの行)。 */
const UNEVEN = '| h1 | h2 |\n| - | - |\n| a1 | a2 | extra |\n| b1 | b2 |\n';
/** 見出しより短い行のある表。 */
const SHORT = '| h1 | h2 | h3 |\n| - | - | - |\n| a1 |\n| b1 | b2 | b3 |\n';
/** 見出しの行だけの表。 */
const HEADER_ONLY = '| h1 | h2 |\n| - | - |\n';
/** セルの中に装飾のある表。 */
const MARKED = '| h |\n| - |\n| **b** x |\n';
/** リスト項目の中の表。 */
const IN_LIST = '- item\n\n  | h1 | h2 |\n  | - | - |\n  | a1 | a2 |\n\n- next\n';

type Cell = { text: string; align: string | null; header: boolean };

function open(src: string): MarkdownDocument {
	return createMarkdownDocument(src, { uri: URI, readOnly: false });
}
function firstTable(doc: PMNode): { node: PMNode; pos: number } | null {
	let found: { node: PMNode; pos: number } | null = null;
	doc.descendants((n, pos) => {
		if (found) return false;
		if (n.type.name === 'table') {
			found = { node: n, pos };
			return false;
		}
		return true;
	});
	return found;
}
function grid(table: PMNode): Cell[][] {
	const rows: Cell[][] = [];
	table.forEach((row) => {
		const cells: Cell[] = [];
		row.forEach((c) => cells.push({ text: c.textContent, align: (c.attrs.align as string | null) ?? null, header: c.type.name === 'table_header' }));
		rows.push(cells);
	});
	return rows;
}
function texts(table: PMNode): string[][] {
	return grid(table).map((r) => r.map((c) => c.text));
}
function aligns(table: PMNode): Array<string | null>[] {
	return grid(table).map((r) => r.map((c) => c.align));
}
/** セルの文字 `cellText` の先頭(+col)にカーソルを置いた state。 */
function inCell(doc: MarkdownDocument, cellText: string, col = 0): EditorState {
	let pos = -1;
	doc.state.doc.descendants((n, p) => {
		if (pos >= 0) return false;
		if (n.isText && n.text === cellText) pos = p;
		return pos < 0;
	});
	if (pos < 0) throw new Error(`セル '${cellText}' が無い`);
	return doc.state.apply(doc.state.tr.setSelection(TextSelection.create(doc.state.doc, pos + col)));
}
/** 段落の文字 `text` の中(+col)にカーソルを置いた state(表の外)。 */
function inParagraph(doc: MarkdownDocument, text: string, col = 1): EditorState {
	return inCell(doc, text, col);
}
/** 選択のあるセルの (行, 列, 先頭か, 文字, offset)。表の外なら null。 */
function cellAt(state: EditorState): { row: number; col: number; atStart: boolean; text: string; offset: number } | null {
	const $from = state.selection.$from;
	for (let d = $from.depth; d > 0; d--) {
		const n = $from.node(d);
		if (n.type.name === 'table_cell' || n.type.name === 'table_header') {
			return {
				row: $from.index(d - 2),
				col: $from.index(d - 1),
				atStart: $from.parentOffset === 0 && $from.depth === d,
				text: n.textContent,
				offset: $from.pos - $from.start(d),
			};
		}
	}
	return null;
}
function commandOf(id: TableHandleItemId | TableFormatItemId): Command {
	const handle = (TABLE_HANDLE_COMMANDS as Record<string, Command> | undefined)?.[id];
	const format = (TABLE_COMMANDS as Record<string, Command>)[id];
	const cmd = handle ?? format;
	if (typeof cmd !== 'function') throw new Error(`Command '${id}' が無い(TABLE_HANDLE_COMMANDS / TABLE_COMMANDS)`);
	return cmd;
}
function run(state: EditorState, id: TableHandleItemId | TableFormatItemId): { ok: boolean; next: EditorState; dispatched: number } {
	let next = state;
	let dispatched = 0;
	const ok = commandOf(id)(state, (tr) => {
		dispatched++;
		next = state.apply(tr);
	});
	return { ok, next, dispatched };
}
/** 書き出しを読み直して表の形が同じ・表の外は byte 等価・もう一度書いても同じ・元とは違う。 */
function expectWrittenShape(doc: MarkdownDocument, state: EditorState, src: string, outside: { prefix: string; suffix: string }): string {
	const out = markdownText(withState(doc, state));
	expect(out.startsWith(outside.prefix), `表の前は byte 等価: ${JSON.stringify(out)}`).toBe(true);
	expect(out.endsWith(outside.suffix), `表の後ろは byte 等価: ${JSON.stringify(out)}`).toBe(true);
	const reread = open(out);
	const a = firstTable(state.doc)!;
	const b = firstTable(reread.state.doc);
	expect(b, '読み直しても表').not.toBeNull();
	expect(grid(b!.node)).toEqual(grid(a.node));
	expect(markdownText(reread), '書き直しは安定(もう一度書いても同じ)').toBe(out);
	expect(out, '元と同じではない(表が変わっている)').not.toBe(src);
	return out;
}
function expectUndoRestores(doc: MarkdownDocument, before: EditorState, after: EditorState, src: string) {
	expect(undoDepth(after), '取引 1 つ=undo 1 段').toBe(undoDepth(before) + 1);
	let undone = after;
	undo(after, (tr) => (undone = after.apply(tr)));
	expect(markdownText(withState(doc, undone)), 'undo 1 回で byte 等価').toBe(src);
}
/** 区切りの行(書き出しの 2 行目=表の最初の行の次)のセルの綴り。 */
function delimiterCells(out: string): string[] {
	const lines = out.split('\n');
	const first = lines.findIndex((l) => l.trimStart().startsWith('|'));
	expect(first, '表の行がある').toBeGreaterThanOrEqual(0);
	return lines[first + 1]!.split('|').slice(1, -1).map((c) => c.trim());
}
function menuItems(entries: EditorMenuEntry[]): Array<[string, string]> {
	const items: Array<[string, string]> = [];
	for (const e of entries) {
		if (e.kind === 'item') items.push([e.id, e.label]);
		if (e.kind === 'submenu') throw new Error(`印のメニューに submenu は無い: ${e.label}`);
	}
	return items;
}

// ---------------------------------------------------------------------------

describe('#832 T2 / T3 / T7: 印のメニューの中身(buildTableHandleMenu)', () => {
	test('行の印: Insert Row Above・Insert Row Below・Duplicate Row・Delete Row の 4 つ(この並び)。Delete Table は無い', () => {
		expect(typeof buildTableHandleMenu, 'buildTableHandleMenu がある').toBe('function');
		const items = menuItems(buildTableHandleMenu('row'));
		expect(items).toEqual(ROW_MENU);
		expect(items.map(([, label]) => label)).not.toContain('Delete Table');
	});

	test('列の印: Insert Column Left・Insert Column Right・Duplicate Column・Delete Column・Align Left・Align Center・Align Right の 7 つ(この並び)', () => {
		const items = menuItems(buildTableHandleMenu('column'));
		expect(items).toEqual(COLUMN_MENU);
		expect(items.map(([, label]) => label)).not.toContain('Delete Table');
	});

	test('どの項目の id も Command に結びつく(既存の 4 つは TABLE_COMMANDS のもの・新しい 7 つは TABLE_HANDLE_COMMANDS)', () => {
		for (const [id] of [...ROW_MENU, ...COLUMN_MENU]) {
			expect(typeof commandOf(id as TableHandleItemId | TableFormatItemId), id).toBe('function');
		}
		for (const id of ['format-table-row-above', 'format-table-row-below', 'format-table-delete-row', 'format-table-column-left', 'format-table-column-right', 'format-table-delete-column'] as TableFormatItemId[]) {
			expect(commandOf(id), `${id} は Format ▸ Table と同じ Command`).toBe(TABLE_COMMANDS[id]);
		}
	});

	test('T7: 英語の名前。Format ▸ Table と同じ項目は menu.rs と同じ綴り', () => {
		const rs = readFileSync(resolve(REPO_ROOT, 'src-tauri/src/menu.rs'), 'utf8');
		const labels = [...ROW_MENU, ...COLUMN_MENU].map(([, label]) => label);
		for (const label of labels) expect(label, 'ASCII の英語').toMatch(/^[A-Za-z ]+$/);
		for (const shared of ['Insert Row Above', 'Insert Row Below', 'Delete Row', 'Insert Column Left', 'Insert Column Right', 'Delete Column']) {
			expect(rs, `menu.rs に "${shared}"`).toContain(`"${shared}"`);
		}
	});
});

describe('#832 T5: TABLE_HANDLE_COMMANDS の形(7 つ・FORMAT_ITEM_IDS には入れない・既存の 7 つはそのまま)', () => {
	test('TABLE_HANDLE_COMMANDS は新しい 7 つの id をちょうど持つ', () => {
		expect(typeof TABLE_HANDLE_COMMANDS, 'TABLE_HANDLE_COMMANDS がある').toBe('object');
		expect(Object.keys(TABLE_HANDLE_COMMANDS).sort()).toEqual([...HANDLE_IDS].sort());
		for (const id of HANDLE_IDS) expect(typeof TABLE_HANDLE_COMMANDS[id], id).toBe('function');
	});

	test('FORMAT_ITEM_IDS には入れない(メニューバーの Format の表は 3-6 のまま)。TABLE_COMMANDS も 7 つのまま', () => {
		for (const id of HANDLE_IDS) expect(FORMAT_ITEM_IDS as readonly string[]).not.toContain(id);
		expect(Object.keys(TABLE_COMMANDS)).toHaveLength(7);
	});

	test('表の外(段落)では 7 つとも false・取引なし・文書は不変', () => {
		const doc = open(COMPACT);
		const s0 = inParagraph(doc, 'intro  text', 2);
		expect(cellAt(s0)).toBeNull();
		for (const id of HANDLE_IDS) {
			const { ok, dispatched, next } = run(s0, id);
			expect(ok, id).toBe(false);
			expect(dispatched, id).toBe(0);
			expect(markdownText(withState(doc, next)), id).toBe(COMPACT);
		}
	});
});

describe('#832 T5: Duplicate Row(その行のすぐ下に同じ中身の行)', () => {
	test('本文の行 a(a2 にカーソル): a のすぐ下に同じ文字・同じ寄せの本文の行。カーソルは新しい行の同じ列の先頭。取引 1 つ', () => {
		const doc = open(ALIGNED);
		const s0 = inCell(doc, 'a2');
		const { ok, next, dispatched } = run(s0, 'format-table-duplicate-row');
		expect(ok).toBe(true);
		expect(dispatched).toBe(1);
		const t = firstTable(next.doc)!.node;
		expect(texts(t)).toEqual([
			['h1', 'h2', 'h3'],
			['a1', 'a2', 'a3'],
			['a1', 'a2', 'a3'],
			['b1', 'b2', 'b3'],
		]);
		expect(aligns(t)[2]).toEqual(['left', 'center', 'right']);
		expect(grid(t)[2]!.every((c) => !c.header)).toBe(true);
		expect(cellAt(next)).toMatchObject({ row: 2, col: 1, atStart: true, text: 'a2' });
		expectWrittenShape(doc, next, ALIGNED, { prefix: '| h1', suffix: '|\n' });
		expectUndoRestores(doc, s0, next, ALIGNED);
	});

	test('最後の行 b: 末尾に b の写し', () => {
		const doc = open(COMPACT);
		const s0 = inCell(doc, 'b1');
		const { ok, next } = run(s0, 'format-table-duplicate-row');
		expect(ok).toBe(true);
		expect(texts(firstTable(next.doc)!.node)).toEqual([
			['h1', 'h2'],
			['a1', 'a2'],
			['b1', 'b2'],
			['b1', 'b2'],
		]);
		expect(cellAt(next)).toMatchObject({ row: 3, col: 0, atStart: true });
		expectWrittenShape(doc, next, COMPACT, { prefix: 'intro  text\n\n|', suffix: '|\n\nafter\n' });
		expectUndoRestores(doc, s0, next, COMPACT);
	});

	test('見出しの行(h2): 見出しのすぐ下に、見出しと同じ文字・寄せの本文の行(table_cell)。見出しの行は作り替えない', () => {
		const doc = open(ALIGNED);
		const s0 = inCell(doc, 'h2');
		const { ok, next } = run(s0, 'format-table-duplicate-row');
		expect(ok).toBe(true);
		const t = firstTable(next.doc)!.node;
		expect(texts(t)).toEqual([
			['h1', 'h2', 'h3'],
			['h1', 'h2', 'h3'],
			['a1', 'a2', 'a3'],
			['b1', 'b2', 'b3'],
		]);
		expect(grid(t)[0]!.every((c) => c.header)).toBe(true);
		expect(grid(t)[1]!.every((c) => !c.header)).toBe(true);
		expect(aligns(t)[1]).toEqual(['left', 'center', 'right']);
		expect(cellAt(next)).toMatchObject({ row: 1, col: 1, atStart: true });
		const out = expectWrittenShape(doc, next, ALIGNED, { prefix: '| h1', suffix: '|\n' });
		expect(delimiterCells(out)).toHaveLength(3);
		expectUndoRestores(doc, s0, next, ALIGNED);
	});

	test('見出しの行だけの表: 見出しの写しが本文の 1 行目になる(表が 2 行になる)', () => {
		const doc = open(HEADER_ONLY);
		const s0 = inCell(doc, 'h1');
		const { ok, next } = run(s0, 'format-table-duplicate-row');
		expect(ok).toBe(true);
		const t = firstTable(next.doc)!.node;
		expect(texts(t)).toEqual([
			['h1', 'h2'],
			['h1', 'h2'],
		]);
		expect(grid(t)[1]!.every((c) => !c.header)).toBe(true);
		expectUndoRestores(doc, s0, next, HEADER_ONLY);
	});

	test('余分なセルのある行(a2 | extra): 写しも 3 セル(extra を保つ)。書き出しに extra が 2 回', () => {
		const doc = open(UNEVEN);
		const s0 = inCell(doc, 'a2');
		const { ok, next } = run(s0, 'format-table-duplicate-row');
		expect(ok).toBe(true);
		expect(texts(firstTable(next.doc)!.node)).toEqual([
			['h1', 'h2'],
			['a1', 'a2', 'extra'],
			['a1', 'a2', 'extra'],
			['b1', 'b2'],
		]);
		const out = markdownText(withState(doc, next));
		expect(out.split('extra')).toHaveLength(3);
		expect(texts(firstTable(open(out).state.doc)!.node)[2]).toEqual(['a1', 'a2', 'extra']);
		expectUndoRestores(doc, s0, next, UNEVEN);
	});

	test('セルの装飾(**b**)も写す(セルの content が等しい)', () => {
		const doc = open(MARKED);
		const s0 = inCell(doc, 'b');
		const { ok, next } = run(s0, 'format-table-duplicate-row');
		expect(ok).toBe(true);
		const t = firstTable(next.doc)!.node;
		expect(t.childCount).toBe(3);
		expect(t.child(2).content.eq(t.child(1).content), '写しの行の中身は元の行と同じ').toBe(true);
		const out = markdownText(withState(doc, next));
		expect(out.split('**b**')).toHaveLength(3);
		expectUndoRestores(doc, s0, next, MARKED);
	});

	test('リスト項目の中の表: 項目の外は byte 等価', () => {
		const doc = open(IN_LIST);
		const s0 = inCell(doc, 'a1');
		const { ok, next } = run(s0, 'format-table-duplicate-row');
		expect(ok).toBe(true);
		const out = markdownText(withState(doc, next));
		expect(out.startsWith('- item\n\n  | h1 | h2 |\n')).toBe(true);
		expect(out.endsWith('\n- next\n')).toBe(true);
		expect(texts(firstTable(open(out).state.doc)!.node)).toEqual([
			['h1', 'h2'],
			['a1', 'a2'],
			['a1', 'a2'],
		]);
		expectUndoRestores(doc, s0, next, IN_LIST);
	});
});

describe('#832 T5: Duplicate Column(その列のすぐ右に同じ中身の列・その位置にセルがある行だけ)', () => {
	test('列 1(a2): 全行の列 2 に同じ文字のセル。見出しの行は table_header・寄せも写す。カーソルは今の行の新しいセルの先頭', () => {
		const doc = open(ALIGNED);
		const s0 = inCell(doc, 'a2');
		const { ok, next, dispatched } = run(s0, 'format-table-duplicate-column');
		expect(ok).toBe(true);
		expect(dispatched).toBe(1);
		const t = firstTable(next.doc)!.node;
		expect(texts(t)).toEqual([
			['h1', 'h2', 'h2', 'h3'],
			['a1', 'a2', 'a2', 'a3'],
			['b1', 'b2', 'b2', 'b3'],
		]);
		expect(aligns(t)).toEqual([
			['left', 'center', 'center', 'right'],
			['left', 'center', 'center', 'right'],
			['left', 'center', 'center', 'right'],
		]);
		expect(grid(t)[0]![2]!.header).toBe(true);
		expect(grid(t)[1]![2]!.header).toBe(false);
		expect(cellAt(next)).toMatchObject({ row: 1, col: 2, atStart: true, text: 'a2' });
		const out = expectWrittenShape(doc, next, ALIGNED, { prefix: '| h1', suffix: '|\n' });
		const cells = delimiterCells(out);
		expect(cells).toHaveLength(4);
		expect(cells[1]).toMatch(/^:-+:$/);
		expect(cells[2], '写した列の区切りも中央').toMatch(/^:-+:$/);
		expectUndoRestores(doc, s0, next, ALIGNED);
	});

	test('最後の列(b2): 末尾に写し。前後の段落は byte 等価', () => {
		const doc = open(COMPACT);
		const s0 = inCell(doc, 'b2');
		const { ok, next } = run(s0, 'format-table-duplicate-column');
		expect(ok).toBe(true);
		expect(texts(firstTable(next.doc)!.node)).toEqual([
			['h1', 'h2', 'h2'],
			['a1', 'a2', 'a2'],
			['b1', 'b2', 'b2'],
		]);
		expect(cellAt(next)).toMatchObject({ row: 2, col: 2, atStart: true });
		expectWrittenShape(doc, next, COMPACT, { prefix: 'intro  text\n\n|', suffix: '|\n\nafter\n' });
		expectUndoRestores(doc, s0, next, COMPACT);
	});

	test('見出しより短い行(a1 だけ)には足さない(位置 1 にセルが無い)。余分なセル(extra)は保つ', () => {
		const short = open(SHORT);
		const s0 = inCell(short, 'h2');
		const r = run(s0, 'format-table-duplicate-column');
		expect(r.ok).toBe(true);
		expect(texts(firstTable(r.next.doc)!.node)).toEqual([
			['h1', 'h2', 'h2', 'h3'],
			['a1'],
			['b1', 'b2', 'b2', 'b3'],
		]);
		expectUndoRestores(short, s0, r.next, SHORT);

		const uneven = open(UNEVEN);
		const u0 = inCell(uneven, 'h2');
		const u = run(u0, 'format-table-duplicate-column');
		expect(u.ok).toBe(true);
		expect(texts(firstTable(u.next.doc)!.node)).toEqual([
			['h1', 'h2', 'h2'],
			['a1', 'a2', 'a2', 'extra'],
			['b1', 'b2', 'b2'],
		]);
		const out = markdownText(withState(uneven, u.next));
		expect(texts(firstTable(open(out).state.doc)!.node)[1]).toEqual(['a1', 'a2', 'a2', 'extra']);
		expectUndoRestores(uneven, u0, u.next, UNEVEN);
	});

	test('セルの装飾(**b**)も写す', () => {
		const doc = open(MARKED);
		const s0 = inCell(doc, 'b');
		const { ok, next } = run(s0, 'format-table-duplicate-column');
		expect(ok).toBe(true);
		const t = firstTable(next.doc)!.node;
		expect(texts(t)).toEqual([
			['h', 'h'],
			['b x', 'b x'],
		]);
		expect(t.child(1).child(1).content.eq(t.child(1).child(0).content)).toBe(true);
		expect(markdownText(withState(doc, next)).split('**b**')).toHaveLength(3);
	});
});

describe('#832 T5: Align Left / Center / Right(その列の全部の行のセルの align・区切りの行が :--- / :---: / ---:)', () => {
	const cases: Array<[TableHandleItemId, string, RegExp]> = [
		['format-table-align-left', 'left', /^:-+$/],
		['format-table-align-center', 'center', /^:-+:$/],
		['format-table-align-right', 'right', /^-+:$/],
	];

	for (const [id, align, delimiter] of cases) {
		test(`${id}(寄せなしの表の列 1・a2 の途中): 列 1 の全行が ${align}・列 0 は触らない・カーソルは動かない・区切りは ${delimiter}`, () => {
			const doc = open(COMPACT);
			const s0 = inCell(doc, 'a2', 1);
			const { ok, next, dispatched } = run(s0, id);
			expect(ok).toBe(true);
			expect(dispatched).toBe(1);
			const t = firstTable(next.doc)!.node;
			expect(texts(t), '文字は変わらない').toEqual([
				['h1', 'h2'],
				['a1', 'a2'],
				['b1', 'b2'],
			]);
			expect(aligns(t)).toEqual([
				[null, align],
				[null, align],
				[null, align],
			]);
			expect(cellAt(next)).toMatchObject({ row: 1, col: 1, text: 'a2', offset: 1 });
			const out = expectWrittenShape(doc, next, COMPACT, { prefix: 'intro  text\n\n|', suffix: '|\n\nafter\n' });
			const cells = delimiterCells(out);
			expect(cells).toHaveLength(2);
			expect(cells[0], '触らない列は - だけ').toMatch(/^-+$/);
			expect(cells[1]).toMatch(delimiter);
			expect(aligns(firstTable(open(out).state.doc)!.node).map((r) => r[1])).toEqual([align, align, align]);
			expectUndoRestores(doc, s0, next, COMPACT);
		});
	}

	test('寄せのある列を替える(ALIGNED の列 1=center を right に): 他の列の寄せはそのまま', () => {
		const doc = open(ALIGNED);
		const s0 = inCell(doc, 'b2');
		const { ok, next } = run(s0, 'format-table-align-right');
		expect(ok).toBe(true);
		expect(aligns(firstTable(next.doc)!.node)).toEqual([
			['left', 'right', 'right'],
			['left', 'right', 'right'],
			['left', 'right', 'right'],
		]);
		const out = markdownText(withState(doc, next));
		const cells = delimiterCells(out);
		expect(cells[0]).toMatch(/^:-+$/);
		expect(cells[1]).toMatch(/^-+:$/);
		expect(cells[2]).toMatch(/^-+:$/);
		expectUndoRestores(doc, s0, next, ALIGNED);
	});

	test('既にその寄せの列に同じ寄せ → false・取引なし(undo の段は増えない)', () => {
		const doc = open(ALIGNED);
		const s0 = inCell(doc, 'a2');
		const { ok, dispatched, next } = run(s0, 'format-table-align-center');
		expect(ok).toBe(false);
		expect(dispatched).toBe(0);
		expect(undoDepth(next)).toBe(undoDepth(s0));
		expect(markdownText(withState(doc, next))).toBe(ALIGNED);
	});

	test('そろっていない表: その位置にセルがある行だけ・余分なセル(extra)と短い行は触らない', () => {
		const uneven = open(UNEVEN);
		const u0 = inCell(uneven, 'h2');
		const u = run(u0, 'format-table-align-center');
		expect(u.ok).toBe(true);
		expect(aligns(firstTable(u.next.doc)!.node)).toEqual([
			[null, 'center'],
			[null, 'center', null],
			[null, 'center'],
		]);
		expectUndoRestores(uneven, u0, u.next, UNEVEN);

		const short = open(SHORT);
		const s0 = inCell(short, 'b3');
		const s = run(s0, 'format-table-align-right');
		expect(s.ok).toBe(true);
		expect(aligns(firstTable(s.next.doc)!.node)).toEqual([
			[null, null, 'right'],
			[null],
			[null, null, 'right'],
		]);
		expectUndoRestores(short, s0, s.next, SHORT);
	});

	test('見出しの行だけの表でも寄せられる(見出しのセルの align)', () => {
		const doc = open(HEADER_ONLY);
		const s0 = inCell(doc, 'h1');
		const { ok, next } = run(s0, 'format-table-align-left');
		expect(ok).toBe(true);
		expect(aligns(firstTable(next.doc)!.node)).toEqual([['left', null]]);
		const cells = delimiterCells(markdownText(withState(doc, next)));
		expect(cells[0]).toMatch(/^:-+$/);
		expect(cells[1]).toMatch(/^-+$/);
		expectUndoRestores(doc, s0, next, HEADER_ONLY);
	});
});

describe('#832 T4: 端の +(append-row=末尾に本文の行・append-column=末尾に列)', () => {
	test('append-row(見出しの h1 から): 末尾に空の本文の行(見出しの列の数・寄せを引き継ぐ)。カーソルは新しい行の先頭。取引 1 つ', () => {
		const doc = open(ALIGNED);
		const s0 = inCell(doc, 'h1');
		const { ok, next, dispatched } = run(s0, 'format-table-append-row');
		expect(ok).toBe(true);
		expect(dispatched).toBe(1);
		const t = firstTable(next.doc)!.node;
		expect(texts(t)).toEqual([
			['h1', 'h2', 'h3'],
			['a1', 'a2', 'a3'],
			['b1', 'b2', 'b3'],
			['', '', ''],
		]);
		expect(aligns(t)[3]).toEqual(['left', 'center', 'right']);
		expect(grid(t)[3]!.every((c) => !c.header)).toBe(true);
		expect(cellAt(next)).toMatchObject({ row: 3, atStart: true });
		expectWrittenShape(doc, next, ALIGNED, { prefix: '| h1', suffix: '|\n' });
		expectUndoRestores(doc, s0, next, ALIGNED);
	});

	test('append-row は、どのセルから呼んでも「最後の行で Insert Row Below」と同じ表(そろっていない表も)', () => {
		for (const src of [COMPACT, UNEVEN, SHORT, HEADER_ONLY]) {
			const doc = open(src);
			const t0 = firstTable(doc.state.doc)!.node;
			const lastRow = t0.child(t0.childCount - 1);
			const lastText = lastRow.child(0).textContent;
			const expected = run(inCell(doc, lastText), 'format-table-row-below').next;
			const got = run(inCell(doc, 'h1'), 'format-table-append-row');
			expect(got.ok, src).toBe(true);
			expect(grid(firstTable(got.next.doc)!.node), src).toEqual(grid(firstTable(expected.doc)!.node));
			expect(markdownText(withState(doc, got.next)), src).toBe(markdownText(withState(doc, expected)));
		}
	});

	test('append-column(b1 から): 全行の末尾に空のセル(寄せなし・見出しは table_header)。カーソルは今の行の新しいセル。取引 1 つ', () => {
		const doc = open(COMPACT);
		const s0 = inCell(doc, 'b1');
		const { ok, next, dispatched } = run(s0, 'format-table-append-column');
		expect(ok).toBe(true);
		expect(dispatched).toBe(1);
		const t = firstTable(next.doc)!.node;
		expect(texts(t)).toEqual([
			['h1', 'h2', ''],
			['a1', 'a2', ''],
			['b1', 'b2', ''],
		]);
		expect(aligns(t).map((r) => r[2])).toEqual([null, null, null]);
		expect(grid(t)[0]![2]!.header).toBe(true);
		expect(grid(t)[2]![2]!.header).toBe(false);
		expect(cellAt(next)).toMatchObject({ row: 2, col: 2, atStart: true });
		expectWrittenShape(doc, next, COMPACT, { prefix: 'intro  text\n\n|', suffix: '|\n\nafter\n' });
		expectUndoRestores(doc, s0, next, COMPACT);
	});

	test('append-column は、どのセルから呼んでも「見出しの最後のセルで Insert Column Right」と同じ表(そろっていない表も)', () => {
		for (const src of [ALIGNED, UNEVEN, SHORT, HEADER_ONLY]) {
			const doc = open(src);
			const header = firstTable(doc.state.doc)!.node.child(0);
			const lastHeader = header.child(header.childCount - 1).textContent;
			const expected = run(inCell(doc, lastHeader), 'format-table-column-right').next;
			const got = run(inCell(doc, 'h1'), 'format-table-append-column');
			expect(got.ok, src).toBe(true);
			expect(grid(firstTable(got.next.doc)!.node), src).toEqual(grid(firstTable(expected.doc)!.node));
			expect(markdownText(withState(doc, got.next)), src).toBe(markdownText(withState(doc, expected)));
		}
	});
});
