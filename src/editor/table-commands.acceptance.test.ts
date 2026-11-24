/**
 * 要件#74 第3段 3-2 — Format ▸ Table の行と列の追加と削除(契約8「第3段で Format ▸ Table に行・列の追加と削除を足す」・契約6・
 * 由谷の決定 2026-11-17 昼: 3-6=追加 4+削除 3 だけ・3-7=代案 2・3-8・3-9)。正本: docs/review/req74-stage34-prep.md の (A) 3 と (B) AC-74-52・53。
 *
 * ## 対応する受け入れ基準
 * - AC-74-52(フロントの分): `FormatItemId` / `FORMAT_COMMANDS` に 7 つの ID があり、`TABLE_COMMANDS` と同じ Command
 * - AC-74-53: フィクスチャ(そろえた表・詰めた表・寄せ・全角・行ごとのセルの数がそろっていない表・リスト項目の中の表)×操作×位置で
 *   (1) 行と列の数・各セルの align・カーソルの位置 (2) 書き出しは表だけが文書の流儀で書き直され(読み直して同じ形)、外は byte 等価
 *   (3) 見出しの行の Insert Row Above / Delete Row【3-7 代案 2】 (4) 最後の 1 列の Delete Column で表が消える (5) 余分なセルが残る
 *   (6) undo 1 回で byte 等価 (7) 表の外では false で取引なし。(8) IME は MarkdownEditor.wiring の 3-2
 *
 * ## 確定契約(implementer はこれに従う=推奨名は stage34-prep の (A) 3)
 *
 * ```ts
 * // --- src/editor/commands.ts
 * export type FormatItemId = … | 'format-table-row-above' | 'format-table-row-below' | 'format-table-column-left' | 'format-table-column-right'
 *   | 'format-table-delete-row' | 'format-table-delete-column' | 'format-table-delete';
 * //   FORMAT_COMMANDS に 7 つ(= TABLE_COMMANDS の同じ関数)。経路は runFormatCommand(Markdown の編集面だけ・変換中は確定後に 1 回)
 * // --- src/editor/table-commands.ts(新規・prosemirror-tables の addRowBefore / addRowAfter / addColumnBefore / addColumnAfter /
 * //     deleteRow / deleteColumn / deleteTable を包む。tableEditing() は入れない)
 * export type TableFormatItemId = 'format-table-row-above' | … | 'format-table-delete';
 * export const TABLE_COMMANDS: Record<TableFormatItemId, Command>;
 * /** 表のセルの Enter: 同じ列の 1 つ下のセルの先頭へ(最後の行なら何もしない=true・取引なし)。表の外では false。 *\/
 * export const goToCellBelow: Command;
 * //   a. 見出しの行(1 行目)【3-7 代案 2】: Insert Row Above → 見出しのすぐ下に本文の行を足す(Insert Row Below と同じ)。
 * //      Delete Row → 見出しのすぐ下の本文の行を消す(本文の行が無ければ何もしない=false・取引なし)。見出しの行そのものは作り替えない
 * //   b. 新しいセルは空。行を足したら各セルはその列の寄せ(見出しのセルの align)を引き継ぐ。列を足したら寄せなし(align null)。
 * //      見出しの行に足した列のセルは table_header
 * //   c. 本文の行を全部消しても表は残る。最後の 1 列を消すと表ごと消える(Delete Table と同じ)
 * //   d. 行ごとのセルの数がそろっていない表: 列の位置は見出しの行で数える。列を足す・消すのはその位置にセルがある行だけ。余分なセルは保つ。
 * //      新しい行のセルの数は見出しの列の数(GFM の形)
 * //   e. 操作の後のカーソル: Insert Row Above / Below=新しい行の同じ列のセルの先頭・Insert Column Left / Right=今の行の新しいセルの先頭・
 * //      Delete Row=同じ列の、消した行の位置に来た行のセル(最後の行を消したら前の行)・Delete Column=同じ行の左のセル(最初の列なら右)・
 * //      Delete Table / 最後の列の削除=表があった位置の次のブロックの先頭(次が無ければ空の段落を足してそこ)
 * //   f. どれも取引 1 つ(undo 1 段で byte 等価)。表の外では false・取引なし
 * //   g. 書き出し: 触った表だけが 3 段目(文書の表の流儀)。表の外は byte 等価
 * ```
 *
 * ## 修正前に赤になる理由
 * - `src/editor/table-commands.ts` が無く、`FORMAT_COMMANDS` に `format-table-*` が無いので import と値の表で落ちる
 */
import { describe, expect, test } from 'vitest';
import { TextSelection, type Command, type EditorState } from 'prosemirror-state';
import { undo, undoDepth } from 'prosemirror-history';
import type { Node as PMNode } from 'prosemirror-model';
import { createMarkdownDocument, markdownText, withState, type MarkdownDocument } from './markdown-document';
import { FORMAT_COMMANDS, FORMAT_ITEM_IDS, type FormatItemId } from './commands';
import { TABLE_COMMANDS, goToCellBelow, type TableFormatItemId } from './table-commands';
import { blockNames } from './markdown.testkit';

const URI = 'file:///Users/a/notes/tables.md';
const TABLE_IDS: TableFormatItemId[] = [
	'format-table-row-above',
	'format-table-row-below',
	'format-table-column-left',
	'format-table-column-right',
	'format-table-delete-row',
	'format-table-delete-column',
	'format-table-delete',
];

/** そろえた表・寄せ 3 種(外のブロックなし)。 */
const ALIGNED = '| h1  | h2  | h3  |\n| :-- | :-: | --: |\n| a1  | a2  | a3  |\n| b1  | b2  | b3  |\n';
/** 詰めた表(前後に段落)。 */
const COMPACT = 'intro  text\n\n| h1 | h2 |\n| - | - |\n| a1 | a2 |\n| b1 | b2 |\n\nafter\n';
/** 行ごとのセルの数がそろっていない表(AI の表)。 */
const UNEVEN = '| h1 | h2 |\n| - | - |\n| a1 | a2 | extra |\n| b1 | b2 |\n';
/** リスト項目の中の表。 */
const IN_LIST = '- item\n\n  | h1 | h2 |\n  | - | - |\n  | a1 | a2 |\n\n- next\n';
/** 全角を含む表。 */
const WIDE = '| 列 | 値 |\n| --- | --- |\n| 全角の字 | 1 |\n';
/** 見出しの行だけの表。 */
const HEADER_ONLY = '| h1 | h2 |\n| - | - |\n';
/** 1 列の表(前後に段落)。 */
const ONE_COLUMN = 'intro\n\n| h1 |\n| - |\n| a1 |\n\nafter\n';

type Cell = { text: string; align: string | null; header: boolean };

function open(src: string): MarkdownDocument {
	return createMarkdownDocument(src, { uri: URI, readOnly: false });
}
/** 文書の最初の表(ノードと位置)。 */
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
/** 空のセル(位置 row, col)の中にカーソルを置いた state(表の行・列の番号で)。 */
function inEmptyCell(state: EditorState, row: number, col: number): EditorState {
	const t = firstTable(state.doc)!;
	let pos = t.pos + 1;
	let target = -1;
	t.node.forEach((r, rowOffset, ri) => {
		if (ri !== row) return;
		let cpos = pos + rowOffset + 1;
		r.forEach((c, cellOffset, ci) => {
			if (ci === col) target = cpos + cellOffset + 1;
		});
	});
	if (target < 0) throw new Error(`セル (${row}, ${col}) が無い`);
	return state.apply(state.tr.setSelection(TextSelection.create(state.doc, target)));
}
/** 選択のあるセルの (行, 列, 先頭か)。表の外なら null。 */
function cellAt(state: EditorState): { row: number; col: number; atStart: boolean; text: string } | null {
	const $from = state.selection.$from;
	for (let d = $from.depth; d > 0; d--) {
		const n = $from.node(d);
		if (n.type.name === 'table_cell' || n.type.name === 'table_header') {
			const row = $from.index(d - 2);
			const col = $from.index(d - 1);
			return { row, col, atStart: $from.parentOffset === 0 && $from.depth === d, text: n.textContent };
		}
	}
	return null;
}
function run(state: EditorState, id: TableFormatItemId | 'enter'): { ok: boolean; next: EditorState; dispatched: number } {
	let next = state;
	let dispatched = 0;
	const cmd: Command = id === 'enter' ? goToCellBelow : TABLE_COMMANDS[id];
	const ok = cmd(state, (tr) => {
		dispatched++;
		next = state.apply(tr);
	});
	return { ok, next, dispatched };
}
/** 書き出しを読み直して表の形(文字・寄せ・見出し)が同じ。前後(表の外)は byte 等価。もう一度書いても同じ。 */
function expectWrittenShape(doc: MarkdownDocument, state: EditorState, src: string, outside: { prefix: string; suffix: string }) {
	const out = markdownText(withState(doc, state));
	expect(out.startsWith(outside.prefix), `表の前は byte 等価: ${JSON.stringify(out)}`).toBe(true);
	expect(out.endsWith(outside.suffix), `表の後ろは byte 等価: ${JSON.stringify(out)}`).toBe(true);
	const reread = open(out);
	const a = firstTable(state.doc);
	const b = firstTable(reread.state.doc);
	if (!a) {
		expect(b, '表は消えている').toBeNull();
	} else {
		expect(b, '読み直しても表').not.toBeNull();
		expect(grid(b!.node)).toEqual(grid(a.node));
	}
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

// ---------------------------------------------------------------------------

describe('AC-74-52(フロントの分): FORMAT_COMMANDS に Table ▸ の 7 つがあり TABLE_COMMANDS と同じ', () => {
	test('7 つの ID が FORMAT_ITEM_IDS にあり、Command は TABLE_COMMANDS のもの', () => {
		for (const id of TABLE_IDS) {
			expect(FORMAT_ITEM_IDS).toContain(id);
			expect(typeof TABLE_COMMANDS[id]).toBe('function');
			expect(FORMAT_COMMANDS[id as FormatItemId]).toBe(TABLE_COMMANDS[id]);
		}
		expect(Object.keys(TABLE_COMMANDS).sort()).toEqual([...TABLE_IDS].sort());
	});
	test('Move / Align の項目は無い(3-6=追加 4・削除 3 だけ)', () => {
		for (const id of FORMAT_ITEM_IDS) {
			expect(id).not.toMatch(/^format-table-(move|align)/);
		}
		expect(FORMAT_ITEM_IDS.filter((id) => id.startsWith('format-table-'))).toHaveLength(7);
	});
});

describe('AC-74-53 (1)(2)(6): そろえた表(寄せ 3 種)— 行の追加と削除', () => {
	test('Insert Row Above(本文 1 行目 a2): 空の行が a の上に・各セルは列の寄せを引き継ぐ・カーソルは新しい行の同じ列の先頭', () => {
		const doc = open(ALIGNED);
		const s0 = inCell(doc, 'a2');
		const { ok, next, dispatched } = run(s0, 'format-table-row-above');
		expect(ok).toBe(true);
		expect(dispatched).toBe(1);
		const t = firstTable(next.doc)!.node;
		expect(texts(t)).toEqual([
			['h1', 'h2', 'h3'],
			['', '', ''],
			['a1', 'a2', 'a3'],
			['b1', 'b2', 'b3'],
		]);
		expect(aligns(t)[1]).toEqual(['left', 'center', 'right']);
		expect(grid(t)[1]!.every((c) => !c.header)).toBe(true);
		expect(cellAt(next)).toMatchObject({ row: 1, col: 1, atStart: true });
		const out = expectWrittenShape(doc, next, ALIGNED, { prefix: '| h1', suffix: '|\n' });
		expect(out.split('\n')[1], '区切りの行の寄せの綴り').toMatch(/^\|\s*:-+\s*\|\s*:-+:\s*\|\s*-+:\s*\|$/);
		expectUndoRestores(doc, s0, next, ALIGNED);
	});

	test('Insert Row Below(最後の行 b3): 末尾に空の行・寄せを引き継ぐ・カーソルは新しい行の列 2', () => {
		const doc = open(ALIGNED);
		const s0 = inCell(doc, 'b3');
		const { ok, next } = run(s0, 'format-table-row-below');
		expect(ok).toBe(true);
		const t = firstTable(next.doc)!.node;
		expect(texts(t)).toEqual([
			['h1', 'h2', 'h3'],
			['a1', 'a2', 'a3'],
			['b1', 'b2', 'b3'],
			['', '', ''],
		]);
		expect(aligns(t)[3]).toEqual(['left', 'center', 'right']);
		expect(cellAt(next)).toMatchObject({ row: 3, col: 2, atStart: true });
		expectWrittenShape(doc, next, ALIGNED, { prefix: '| h1', suffix: '|\n' });
		expectUndoRestores(doc, s0, next, ALIGNED);
	});

	test('Delete Row(a1): a の行が消え、カーソルは同じ列の、その位置に来た行(b)のセル', () => {
		const doc = open(ALIGNED);
		const s0 = inCell(doc, 'a1');
		const { ok, next } = run(s0, 'format-table-delete-row');
		expect(ok).toBe(true);
		expect(texts(firstTable(next.doc)!.node)).toEqual([
			['h1', 'h2', 'h3'],
			['b1', 'b2', 'b3'],
		]);
		expect(cellAt(next)).toMatchObject({ row: 1, col: 0, text: 'b1' });
		expectWrittenShape(doc, next, ALIGNED, { prefix: '| h1', suffix: '|\n' });
		expectUndoRestores(doc, s0, next, ALIGNED);
	});

	test('Delete Row(最後の行 b2): 前の行(a)の同じ列へ', () => {
		const doc = open(ALIGNED);
		const s0 = inCell(doc, 'b2');
		const { ok, next } = run(s0, 'format-table-delete-row');
		expect(ok).toBe(true);
		expect(texts(firstTable(next.doc)!.node)).toEqual([
			['h1', 'h2', 'h3'],
			['a1', 'a2', 'a3'],
		]);
		expect(cellAt(next)).toMatchObject({ row: 1, col: 1, text: 'a2' });
		expectUndoRestores(doc, s0, next, ALIGNED);
	});

	test('本文の行を全部消しても表は残る(見出しの行だけの表)。書き出しを読み直しても表', () => {
		const doc = open(ALIGNED);
		let state = inCell(doc, 'a1');
		state = run(state, 'format-table-delete-row').next;
		state = run(state, 'format-table-delete-row').next;
		const t = firstTable(state.doc)!.node;
		expect(texts(t)).toEqual([['h1', 'h2', 'h3']]);
		expectWrittenShape(doc, state, ALIGNED, { prefix: '| h1', suffix: '|\n' });
	});
});

describe('AC-74-53 (3)【3-7 代案 2】: 見出しの行での Insert Row Above / Delete Row', () => {
	test('見出しの行で Insert Row Above → 見出しのすぐ下に本文の行(見出しの行は作り替えない)・カーソルは新しい行の同じ列', () => {
		const doc = open(ALIGNED);
		const s0 = inCell(doc, 'h2');
		const { ok, next } = run(s0, 'format-table-row-above');
		expect(ok).toBe(true);
		const t = firstTable(next.doc)!.node;
		expect(texts(t)).toEqual([
			['h1', 'h2', 'h3'],
			['', '', ''],
			['a1', 'a2', 'a3'],
			['b1', 'b2', 'b3'],
		]);
		expect(grid(t)[0]!.every((c) => c.header)).toBe(true);
		expect(grid(t)[1]!.every((c) => !c.header)).toBe(true);
		expect(aligns(t)[1]).toEqual(['left', 'center', 'right']);
		expect(cellAt(next)).toMatchObject({ row: 1, col: 1, atStart: true });
		expectUndoRestores(doc, s0, next, ALIGNED);
	});

	test('見出しの行で Insert Row Below → 同じ(本文の 1 行目を足す)', () => {
		const doc = open(ALIGNED);
		const { ok, next } = run(inCell(doc, 'h1'), 'format-table-row-below');
		expect(ok).toBe(true);
		expect(texts(firstTable(next.doc)!.node)[1]).toEqual(['', '', '']);
		expect(cellAt(next)).toMatchObject({ row: 1, col: 0, atStart: true });
	});

	test('見出しの行で Delete Row → 見出しのすぐ下の本文の行(a)が消え、見出しは残る', () => {
		const doc = open(ALIGNED);
		const s0 = inCell(doc, 'h3');
		const { ok, next } = run(s0, 'format-table-delete-row');
		expect(ok).toBe(true);
		const t = firstTable(next.doc)!.node;
		expect(texts(t)).toEqual([
			['h1', 'h2', 'h3'],
			['b1', 'b2', 'b3'],
		]);
		expect(grid(t)[0]!.every((c) => c.header)).toBe(true);
		expect(cellAt(next), 'カーソルは表の中').not.toBeNull();
		expectWrittenShape(doc, next, ALIGNED, { prefix: '| h1', suffix: '|\n' });
		expectUndoRestores(doc, s0, next, ALIGNED);
	});

	test('見出しの行だけの表で Delete Row → 何もしない(false・取引なし)', () => {
		const doc = open(HEADER_ONLY);
		const s0 = inCell(doc, 'h1');
		const { ok, next, dispatched } = run(s0, 'format-table-delete-row');
		expect(ok).toBe(false);
		expect(dispatched).toBe(0);
		expect(markdownText(withState(doc, next))).toBe(HEADER_ONLY);
	});
});

describe('AC-74-53 (1)(2)(4)(6): 詰めた表(前後に段落)— 列の追加と削除・表の削除', () => {
	const OUTSIDE = { prefix: 'intro  text\n\n|', suffix: '|\n\nafter\n' };

	test('Insert Column Left(a2=列 1): 全行に空のセル(寄せなし)が列 1 に・見出しの行は table_header・カーソルは今の行の新しいセル', () => {
		const doc = open(COMPACT);
		const s0 = inCell(doc, 'a2');
		const { ok, next } = run(s0, 'format-table-column-left');
		expect(ok).toBe(true);
		const t = firstTable(next.doc)!.node;
		expect(texts(t)).toEqual([
			['h1', '', 'h2'],
			['a1', '', 'a2'],
			['b1', '', 'b2'],
		]);
		expect(aligns(t).map((r) => r[1])).toEqual([null, null, null]);
		expect(grid(t)[0]![1]!.header).toBe(true);
		expect(grid(t)[1]![1]!.header).toBe(false);
		expect(cellAt(next)).toMatchObject({ row: 1, col: 1, atStart: true });
		expectWrittenShape(doc, next, COMPACT, OUTSIDE);
		expectUndoRestores(doc, s0, next, COMPACT);
	});

	test('Insert Column Right(最後の列 b2): 列 2 に・カーソルは b の行の新しいセル', () => {
		const doc = open(COMPACT);
		const s0 = inCell(doc, 'b2');
		const { ok, next } = run(s0, 'format-table-column-right');
		expect(ok).toBe(true);
		expect(texts(firstTable(next.doc)!.node)).toEqual([
			['h1', 'h2', ''],
			['a1', 'a2', ''],
			['b1', 'b2', ''],
		]);
		expect(cellAt(next)).toMatchObject({ row: 2, col: 2, atStart: true });
		expectWrittenShape(doc, next, COMPACT, OUTSIDE);
		expectUndoRestores(doc, s0, next, COMPACT);
	});

	test('Delete Column(a2=列 1): 列が消え、カーソルは同じ行の左のセル(a1)', () => {
		const doc = open(COMPACT);
		const s0 = inCell(doc, 'a2');
		const { ok, next } = run(s0, 'format-table-delete-column');
		expect(ok).toBe(true);
		expect(texts(firstTable(next.doc)!.node)).toEqual([['h1'], ['a1'], ['b1']]);
		expect(cellAt(next)).toMatchObject({ row: 1, col: 0, text: 'a1' });
		expectWrittenShape(doc, next, COMPACT, OUTSIDE);
		expectUndoRestores(doc, s0, next, COMPACT);
	});

	test('Delete Column(最初の列 a1): カーソルは右のセル(a2=列 0 になる)', () => {
		const doc = open(COMPACT);
		const { ok, next } = run(inCell(doc, 'a1'), 'format-table-delete-column');
		expect(ok).toBe(true);
		expect(texts(firstTable(next.doc)!.node)).toEqual([['h2'], ['a2'], ['b2']]);
		expect(cellAt(next)).toMatchObject({ row: 1, col: 0, text: 'a2' });
	});

	test('最後の 1 列の Delete Column → 表ごと消え、カーソルは次のブロック(after)の先頭。書き出しは表だけが無い', () => {
		const doc = open(ONE_COLUMN);
		const s0 = inCell(doc, 'a1');
		const { ok, next } = run(s0, 'format-table-delete-column');
		expect(ok).toBe(true);
		expect(blockNames(next.doc)).toEqual(['paragraph', 'paragraph']);
		expect(next.selection.$from.parent.textContent).toBe('after');
		expect(next.selection.$from.parentOffset).toBe(0);
		expect(markdownText(withState(doc, next))).toBe('intro\n\nafter\n');
		expectUndoRestores(doc, s0, next, ONE_COLUMN);
	});

	test('Delete Table → 同じ(表が消え、カーソルは after の先頭)', () => {
		const doc = open(COMPACT);
		const s0 = inCell(doc, 'b1');
		const { ok, next } = run(s0, 'format-table-delete');
		expect(ok).toBe(true);
		expect(blockNames(next.doc)).toEqual(['paragraph', 'paragraph']);
		expect(next.selection.$from.parent.textContent).toBe('after');
		expect(markdownText(withState(doc, next))).toBe('intro  text\n\nafter\n');
		expectUndoRestores(doc, s0, next, COMPACT);
	});

	test('次のブロックが無い表の Delete Table → 空の段落を足してそこへ', () => {
		const doc = open(ALIGNED);
		const { ok, next } = run(inCell(doc, 'a1'), 'format-table-delete');
		expect(ok).toBe(true);
		expect(blockNames(next.doc)).toEqual(['paragraph']);
		expect(next.doc.child(0).content.size).toBe(0);
		expect(next.selection.$from.parent).toBe(next.doc.child(0));
	});
});

describe('AC-74-53 (5): 行ごとのセルの数がそろっていない表(見出しより多いセルの行)', () => {
	test('Insert Column Right(h1=列 0): その位置にセルがある行に足し、余分なセル(extra)は保つ', () => {
		const doc = open(UNEVEN);
		const s0 = inCell(doc, 'h1');
		const { ok, next } = run(s0, 'format-table-column-right');
		expect(ok).toBe(true);
		expect(texts(firstTable(next.doc)!.node)).toEqual([
			['h1', '', 'h2'],
			['a1', '', 'a2', 'extra'],
			['b1', '', 'b2'],
		]);
		expect(cellAt(next)).toMatchObject({ row: 0, col: 1, atStart: true });
		const out = markdownText(withState(doc, next));
		expect(out).toContain('extra');
		expect(texts(firstTable(open(out).state.doc)!.node)[1]).toEqual(['a1', '', 'a2', 'extra']);
		expectUndoRestores(doc, s0, next, UNEVEN);
	});

	test('Delete Column(h2=列 1): 列 1 が消え、余分なセルは残る(a の行は a1 | extra)', () => {
		const doc = open(UNEVEN);
		const s0 = inCell(doc, 'h2');
		const { ok, next } = run(s0, 'format-table-delete-column');
		expect(ok).toBe(true);
		expect(texts(firstTable(next.doc)!.node)).toEqual([['h1'], ['a1', 'extra'], ['b1']]);
		expectUndoRestores(doc, s0, next, UNEVEN);
	});

	test('Insert Row Below(a1): 新しい行のセルの数は見出しの列の数(2)・余分なセルの行はそのまま', () => {
		const doc = open(UNEVEN);
		const { ok, next } = run(inCell(doc, 'a1'), 'format-table-row-below');
		expect(ok).toBe(true);
		expect(texts(firstTable(next.doc)!.node)).toEqual([
			['h1', 'h2'],
			['a1', 'a2', 'extra'],
			['', ''],
			['b1', 'b2'],
		]);
		expect(cellAt(next)).toMatchObject({ row: 2, col: 0, atStart: true });
	});

	test('Delete Row(余分なセルの行 a2)→ その行ごと消える', () => {
		const doc = open(UNEVEN);
		const { ok, next } = run(inCell(doc, 'a2'), 'format-table-delete-row');
		expect(ok).toBe(true);
		expect(texts(firstTable(next.doc)!.node)).toEqual([
			['h1', 'h2'],
			['b1', 'b2'],
		]);
	});
});

describe('AC-74-53 (2): リスト項目の中の表・全角を含む表', () => {
	test('リスト項目の中の表に Insert Row Below → 項目の外(- item / - next)は byte 等価・読み直して同じ形', () => {
		const doc = open(IN_LIST);
		const s0 = inCell(doc, 'a1');
		const { ok, next } = run(s0, 'format-table-row-below');
		expect(ok).toBe(true);
		expect(texts(firstTable(next.doc)!.node)).toEqual([
			['h1', 'h2'],
			['a1', 'a2'],
			['', ''],
		]);
		const out = markdownText(withState(doc, next));
		expect(out.startsWith('- item\n\n  | h1 | h2 |\n')).toBe(true);
		expect(out.endsWith('\n- next\n')).toBe(true);
		const reread = open(out);
		expect(grid(firstTable(reread.state.doc)!.node)).toEqual(grid(firstTable(next.doc)!.node));
		expect(blockNames(reread.state.doc)).toEqual(blockNames(next.doc));
		expectUndoRestores(doc, s0, next, IN_LIST);
	});

	test('全角を含む表に Insert Column Right(値)→ 読み直して同じ形・GFM の形(各行の列の数がそろう)', () => {
		const doc = open(WIDE);
		const s0 = inCell(doc, '値');
		const { ok, next } = run(s0, 'format-table-column-right');
		expect(ok).toBe(true);
		expect(texts(firstTable(next.doc)!.node)).toEqual([
			['列', '値', ''],
			['全角の字', '1', ''],
		]);
		const out = expectWrittenShape(doc, next, WIDE, { prefix: '| 列', suffix: '|\n' });
		const cols = out
			.trimEnd()
			.split('\n')
			.map((l) => l.split('|').length - 2);
		expect(new Set(cols).size, '各行の列の数がそろう').toBe(1);
		expectUndoRestores(doc, s0, next, WIDE);
	});
});

describe('AC-74-53 (7): 表の外では何もしない', () => {
	test('段落にカーソルがあるとき 7 つとも false・取引なし・文書は不変', () => {
		const doc = open(COMPACT);
		let pos = -1;
		doc.state.doc.descendants((n, p) => {
			if (pos >= 0) return false;
			if (n.isText && n.text === 'intro  text') pos = p;
			return pos < 0;
		});
		const s0 = doc.state.apply(doc.state.tr.setSelection(TextSelection.create(doc.state.doc, pos + 2)));
		for (const id of TABLE_IDS) {
			const { ok, dispatched, next } = run(s0, id);
			expect(ok, id).toBe(false);
			expect(dispatched, id).toBe(0);
			expect(markdownText(withState(doc, next)), id).toBe(COMPACT);
		}
		expect(run(s0, 'enter').ok, 'goToCellBelow も表の外では false').toBe(false);
	});
});

describe('AC-74-54【3-10】: セルの Enter(goToCellBelow)は同じ列の 1 つ下のセルの先頭へ・最後の行では何もしない', () => {
	test('a2 の途中で Enter → b2 の先頭(文書は不変)', () => {
		const doc = open(ALIGNED);
		const s0 = inCell(doc, 'a2', 1);
		const { ok, next, dispatched } = run(s0, 'enter');
		expect(ok).toBe(true);
		expect(dispatched).toBe(1);
		expect(next.doc.eq(s0.doc), '文書は変わらない').toBe(true);
		expect(cellAt(next)).toMatchObject({ row: 2, col: 1, atStart: true, text: 'b2' });
	});

	test('見出しの h3 で Enter → 本文 1 行目の a3 の先頭', () => {
		const doc = open(ALIGNED);
		const { ok, next } = run(inCell(doc, 'h3'), 'enter');
		expect(ok).toBe(true);
		expect(cellAt(next)).toMatchObject({ row: 1, col: 2, atStart: true, text: 'a3' });
	});

	test('最後の行 b1 で Enter → 何もしない(true・取引なし・カーソルはそのまま)', () => {
		const doc = open(ALIGNED);
		const s0 = inCell(doc, 'b1', 1);
		const { ok, next, dispatched } = run(s0, 'enter');
		expect(ok).toBe(true);
		expect(dispatched).toBe(0);
		expect(next.selection.eq(s0.selection)).toBe(true);
	});

	test('空のセルへも移れる(Insert Row Below の後の Enter で新しい行の同じ列へ)', () => {
		const doc = open(COMPACT);
		const added = run(inCell(doc, 'a2'), 'format-table-row-below').next;
		const back = inEmptyCell(added, 1, 1); // a2
		const { ok, next } = run(back, 'enter');
		expect(ok).toBe(true);
		expect(cellAt(next)).toMatchObject({ row: 2, col: 1, atStart: true, text: '' });
	});
});

// ---------------------------------------------------------------------------
// 第3段の P3 の穴(後追いの固定): T4=見出しより短い行には列を足さない(その位置にセルがある行だけ)・T6=足した列は寄せなし
// ---------------------------------------------------------------------------

describe('P3 T4 / T6: 短い行への列の追加と、足した列の寄せ', () => {
	const SHORT = '| h1 | h2 | h3 |\n| - | - | - |\n| a1 |\n| b1 | b2 | b3 |\n';

	test('T4: 見出しより短い行(a1 だけ)がある表で、h2 の右に列を足すと短い行には足さない(位置 2 にセルが無い)。h1 の左なら短い行にも足す', () => {
		const doc = open(SHORT);
		expect(texts(firstTable(doc.state.doc)!.node), '短い行は 1 セルのまま読まれる').toEqual([
			['h1', 'h2', 'h3'],
			['a1'],
			['b1', 'b2', 'b3'],
		]);
		const right = run(inCell(doc, 'h2'), 'format-table-column-right');
		expect(right.ok).toBe(true);
		expect(texts(firstTable(right.next.doc)!.node)).toEqual([
			['h1', 'h2', '', 'h3'],
			['a1'],
			['b1', 'b2', '', 'b3'],
		]);
		const out = markdownText(withState(doc, right.next));
		expect(texts(firstTable(open(out).state.doc)!.node)[1], '読み直しても短い行は短いまま').toEqual(['a1']);

		const left = run(inCell(doc, 'h1'), 'format-table-column-left');
		expect(left.ok).toBe(true);
		expect(texts(firstTable(left.next.doc)!.node)).toEqual([
			['', 'h1', 'h2', 'h3'],
			['', 'a1'],
			['', 'b1', 'b2', 'b3'],
		]);
	});

	test('T6: 寄せのある表に列を足すと、足した列は全行 align null(見出しの寄せを引き継がない)で、区切り行のそのセルは - だけ', () => {
		const doc = open(ALIGNED);
		const { ok, next } = run(inCell(doc, 'h2'), 'format-table-column-right');
		expect(ok).toBe(true);
		expect(aligns(firstTable(next.doc)!.node)).toEqual([
			['left', 'center', null, 'right'],
			['left', 'center', null, 'right'],
			['left', 'center', null, 'right'],
		]);
		const out = markdownText(withState(doc, next));
		const delimiter = out.split('\n')[1]!;
		const cells = delimiter.split('|').slice(1, -1).map((c) => c.trim());
		expect(cells).toHaveLength(4);
		expect(cells[0]).toMatch(/^:-+$/);
		expect(cells[1]).toMatch(/^:-+:$/);
		expect(cells[2], '足した列は寄せなし').toMatch(/^-+$/);
		expect(cells[3]).toMatch(/^-+:$/);
		expect(aligns(firstTable(open(out).state.doc)!.node)[0]).toEqual(['left', 'center', null, 'right']);
	});
});
