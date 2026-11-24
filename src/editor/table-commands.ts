/**
 * Format ▸ Table の行と列の追加と削除・セルの Return(要件#74 契約8・第3段 3-2・由谷の決定 2026-11-17 昼 3-6〜3-10)。
 *
 * Markdown の表(GFM)は結合セルが無く、1 行目が見出しの行で、行ごとのセルの数がそろっていないこともある(AI の書いた表)。
 * prosemirror-tables の addRow / addColumn / deleteRow / deleteColumn は表を長方形の格子(TableMap)として扱い、そろっていない
 * 表で余分なセルを保てず、見出しの行の扱い(3-7 代案 2)と寄せの引き継ぎも Markdown に合わないので、表のノードを
 * 直接組み直す(どれも取引 1 つ=表を 1 つ置き換える。undo 1 段で byte 等価)。`tableEditing()` は入れない。
 *
 * - 列の位置は見出しの行で数える。列を足す・消すのはその位置にセルがある行だけ(余分なセルは保つ)
 * - 行を足すと、セルの数は見出しの列の数・各セルはその列の寄せ(見出しのセルの align)を引き継ぐ。列を足すと寄せなし
 * - 見出しの行で Insert Row Above / Below → 見出しのすぐ下に本文の行。Delete Row → 見出しのすぐ下の本文の行(無ければ false)
 * - 最後の 1 列を消すと表ごと消える(Delete Table と同じ)。カーソルは表があった位置の次のブロックの先頭(無ければ空の段落)
 */
import { Selection, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { Fragment, type Node as PMNode, type ResolvedPos } from 'prosemirror-model';
import { markdownSchema as schema } from './markdown-schema';

export type TableFormatItemId =
	| 'format-table-row-above'
	| 'format-table-row-below'
	| 'format-table-column-left'
	| 'format-table-column-right'
	| 'format-table-delete-row'
	| 'format-table-delete-column'
	| 'format-table-delete';

const nodes = schema.nodes;

/** カーソルのあるセルと、その表。表の外なら null。 */
interface CellContext {
	table: PMNode;
	/** 表の開始位置(表のノードの前)。 */
	tablePos: number;
	row: number;
	col: number;
	/** セルの中の offset。 */
	offset: number;
}

function cellContext(state: EditorState): CellContext | null {
	return cellContextAt(state.selection.$from);
}

function cellContextAt($from: ResolvedPos): CellContext | null {
	for (let d = $from.depth; d > 2; d--) {
		const node = $from.node(d);
		if (node.type === nodes.table_cell || node.type === nodes.table_header) {
			const table = $from.node(d - 2);
			if (table.type !== nodes.table) return null;
			return { table, tablePos: $from.before(d - 2), row: $from.index(d - 2), col: $from.index(d - 1), offset: $from.pos - $from.start(d) };
		}
	}
	return null;
}

/** 表の (row, col) のセルの中身の先頭の位置(表が tablePos にあるとき)。 */
function cellStart(table: PMNode, tablePos: number, row: number, col: number): number {
	let pos = tablePos + 1;
	for (let r = 0; r < row; r++) pos += table.child(r).nodeSize;
	pos += 1;
	const rowNode = table.child(row);
	for (let c = 0; c < col; c++) pos += rowNode.child(c).nodeSize;
	return pos + 1;
}

function emptyCell(header: boolean, align: unknown = null): PMNode {
	return (header ? nodes.table_header! : nodes.table_cell!).create({ align: align ?? null });
}

/** 見出しの列の数・寄せに合わせた空の本文の行。 */
function emptyBodyRow(table: PMNode): PMNode {
	const header = table.child(0);
	const cells: PMNode[] = [];
	header.forEach((h) => cells.push(emptyCell(false, h.attrs.align)));
	return nodes.table_row!.create(null, cells);
}

function withRows(table: PMNode, rows: PMNode[]): PMNode {
	return table.type.create(table.attrs, Fragment.fromArray(rows), table.marks);
}

function rowsOf(table: PMNode): PMNode[] {
	const rows: PMNode[] = [];
	table.forEach((r) => rows.push(r));
	return rows;
}

function cellsOf(row: PMNode): PMNode[] {
	const cells: PMNode[] = [];
	row.forEach((c) => cells.push(c));
	return cells;
}

/** 表を next に置き換え、(row, col) のセルの中身の offset にカーソルを置く。 */
function replaceTable(state: EditorState, ctx: CellContext, next: PMNode, row: number, col: number, offset = 0): Transaction {
	const tr = state.tr.replaceWith(ctx.tablePos, ctx.tablePos + ctx.table.nodeSize, next);
	const rowNode = next.child(row);
	const c = Math.min(col, rowNode.childCount - 1);
	const start = cellStart(next, ctx.tablePos, row, c);
	const at = start + Math.min(offset, rowNode.child(c).content.size);
	tr.setSelection(TextSelection.create(tr.doc, at));
	return tr.scrollIntoView();
}

/** 表を消し、表があった位置の次のブロックの先頭へ(無ければ空の段落を足してそこへ)。 */
function removeTable(state: EditorState, ctx: CellContext): Transaction {
	const tr = state.tr.delete(ctx.tablePos, ctx.tablePos + ctx.table.nodeSize);
	const $pos = tr.doc.resolve(ctx.tablePos);
	const next = $pos.nodeAfter;
	if (next && next.isTextblock) {
		tr.setSelection(TextSelection.create(tr.doc, ctx.tablePos + 1));
	} else if (next) {
		tr.setSelection(Selection.near(tr.doc.resolve(ctx.tablePos), 1));
	} else {
		tr.insert(ctx.tablePos, nodes.paragraph!.create());
		tr.setSelection(TextSelection.create(tr.doc, ctx.tablePos + 1));
	}
	return tr.scrollIntoView();
}

function tableCommand(build: (state: EditorState, ctx: CellContext) => Transaction | null): Command {
	return (state, dispatch) => {
		const ctx = cellContext(state);
		if (!ctx) return false;
		const tr = build(state, ctx);
		if (!tr) return false;
		if (dispatch) dispatch(tr);
		return true;
	};
}

/** 行を足す。見出しの行(0)では、上でも下でも見出しのすぐ下(3-7 代案 2)。 */
function insertRow(below: boolean): Command {
	return tableCommand((state, ctx) => {
		const at = ctx.row === 0 ? 1 : below ? ctx.row + 1 : ctx.row;
		const rows = rowsOf(ctx.table);
		rows.splice(at, 0, emptyBodyRow(ctx.table));
		return replaceTable(state, ctx, withRows(ctx.table, rows), at, ctx.col);
	});
}

/** 行を消す。見出しの行では見出しのすぐ下の本文の行(無ければ false=3-7 代案 2)。見出しの行そのものは消さない。 */
const deleteRow = tableCommand((state, ctx) => {
	const rows = rowsOf(ctx.table);
	if (ctx.row === 0) {
		if (rows.length < 2) return null;
		rows.splice(1, 1);
		return replaceTable(state, ctx, withRows(ctx.table, rows), 0, ctx.col, ctx.offset);
	}
	rows.splice(ctx.row, 1);
	const row = ctx.row < rows.length ? ctx.row : ctx.row - 1;
	return replaceTable(state, ctx, withRows(ctx.table, rows), row, ctx.col);
});

/** 列を足す(左=今の列の前・右=後ろ)。その列の位置にセルがある行だけ。新しいセルは寄せなし。 */
function insertColumn(right: boolean): Command {
	return tableCommand((state, ctx) => {
		const at = right ? ctx.col + 1 : ctx.col;
		const rows = rowsOf(ctx.table).map((row, r) => {
			if (row.childCount <= ctx.col) return row;
			const cells = cellsOf(row);
			cells.splice(at, 0, emptyCell(r === 0));
			return row.type.create(row.attrs, Fragment.fromArray(cells), row.marks);
		});
		return replaceTable(state, ctx, withRows(ctx.table, rows), ctx.row, at);
	});
}

/** 列を消す。その位置にセルがある行だけ(余分なセルは保つ)。見出しの最後の 1 列なら表ごと消す。 */
const deleteColumn = tableCommand((state, ctx) => {
	const header = ctx.table.child(0);
	if (header.childCount <= 1 && ctx.col === 0) return removeTable(state, ctx);
	const rows = rowsOf(ctx.table).map((row, r) => {
		if (row.childCount <= ctx.col) return row;
		const cells = cellsOf(row);
		cells.splice(ctx.col, 1);
		// 本文の行がそのセル 1 つだけだったら、空のセルを 1 つ残す(行は消さない)
		if (cells.length === 0) cells.push(emptyCell(r === 0));
		return row.type.create(row.attrs, Fragment.fromArray(cells), row.marks);
	});
	const col = ctx.col > 0 ? ctx.col - 1 : 0;
	return replaceTable(state, ctx, withRows(ctx.table, rows), ctx.row, col);
});

const deleteTable = tableCommand((state, ctx) => removeTable(state, ctx));

/** Format ▸ Table ▸ の 7 つ(表の外では false・取引なし)。 */
export const TABLE_COMMANDS: Record<TableFormatItemId, Command> = {
	'format-table-row-above': insertRow(false),
	'format-table-row-below': insertRow(true),
	'format-table-column-left': insertColumn(false),
	'format-table-column-right': insertColumn(true),
	'format-table-delete-row': deleteRow,
	'format-table-delete-column': deleteColumn,
	'format-table-delete': deleteTable,
};

// --- 要件#74 Issue #832: 表の行と列の頭の印(メニューと端の +)だけが使う 7 つ ---------------------------------

export type TableHandleItemId =
	| 'format-table-duplicate-row'
	| 'format-table-duplicate-column'
	| 'format-table-align-left'
	| 'format-table-align-center'
	| 'format-table-align-right'
	| 'format-table-append-row'
	| 'format-table-append-column';

function withCells(row: PMNode, cells: PMNode[]): PMNode {
	return row.type.create(row.attrs, Fragment.fromArray(cells), row.marks);
}

/** その行のすぐ下に同じ中身の行。見出しの行なら見出しのすぐ下に本文の行(table_cell)として(3-7 と同じ扱い)。 */
const duplicateRow = tableCommand((state, ctx) => {
	const source = ctx.table.child(ctx.row);
	const copy =
		ctx.row === 0
			? withCells(
					source,
					cellsOf(source).map((c) => nodes.table_cell!.create(c.attrs, c.content, c.marks)),
				)
			: source.copy(source.content);
	const at = ctx.row + 1;
	const rows = rowsOf(ctx.table);
	rows.splice(at, 0, copy);
	return replaceTable(state, ctx, withRows(ctx.table, rows), at, ctx.col);
});

/** その列のすぐ右に同じ中身の列(その位置にセルがある行だけ・余分なセルは保つ)。 */
const duplicateColumn = tableCommand((state, ctx) => {
	const rows = rowsOf(ctx.table).map((row) => {
		if (row.childCount <= ctx.col) return row;
		const cells = cellsOf(row);
		const source = cells[ctx.col]!;
		cells.splice(ctx.col + 1, 0, source.copy(source.content));
		return withCells(row, cells);
	});
	return replaceTable(state, ctx, withRows(ctx.table, rows), ctx.row, ctx.col + 1);
});

/** その列の全部の行のセルの寄せ。全部が既にその寄せなら false(取引なし)。カーソルは動かさない。 */
function alignColumn(align: 'left' | 'center' | 'right'): Command {
	return tableCommand((state, ctx) => {
		let changed = false;
		const rows = rowsOf(ctx.table).map((row) => {
			if (row.childCount <= ctx.col) return row;
			const cells = cellsOf(row);
			const cell = cells[ctx.col]!;
			if (cell.attrs.align === align) return row;
			changed = true;
			cells[ctx.col] = cell.type.create({ ...cell.attrs, align }, cell.content, cell.marks);
			return withCells(row, cells);
		});
		if (!changed) return null;
		return replaceTable(state, ctx, withRows(ctx.table, rows), ctx.row, ctx.col, ctx.offset);
	});
}

/** 表の末尾に空の本文の行(=最後の行で Insert Row Below)。カーソルは新しい行のセルの先頭。 */
const appendRow = tableCommand((state, ctx) => {
	const rows = rowsOf(ctx.table);
	rows.push(emptyBodyRow(ctx.table));
	return replaceTable(state, ctx, withRows(ctx.table, rows), rows.length - 1, ctx.col);
});

/** 見出しの最後の列の右に列(=見出しの最後のセルで Insert Column Right)。カーソルは今の行の新しいセル。 */
const appendColumn = tableCommand((state, ctx) => {
	const last = ctx.table.child(0).childCount - 1;
	const at = last + 1;
	const rows = rowsOf(ctx.table).map((row, r) => {
		if (row.childCount <= last) return row;
		const cells = cellsOf(row);
		cells.splice(at, 0, emptyCell(r === 0));
		return withCells(row, cells);
	});
	return replaceTable(state, ctx, withRows(ctx.table, rows), ctx.row, at);
});

/** 印のメニューと端の + だけが使う 7 つ(FORMAT_COMMANDS / FORMAT_ITEM_IDS には入れない)。表の外では false・取引なし。 */
export const TABLE_HANDLE_COMMANDS: Record<TableHandleItemId, Command> = {
	'format-table-duplicate-row': duplicateRow,
	'format-table-duplicate-column': duplicateColumn,
	'format-table-align-left': alignColumn('left'),
	'format-table-align-center': alignColumn('center'),
	'format-table-align-right': alignColumn('right'),
	'format-table-append-row': appendRow,
	'format-table-append-column': appendColumn,
};

/** 表の中のセルの位置(表の開始位置・行・列)。 */
export interface TableCellTarget {
	tablePos: number;
	row: number;
	col: number;
}

/** 位置 `pos` を含むセル(表の外なら null)。 */
export function tableCellAt(doc: PMNode, pos: number): TableCellTarget | null {
	const ctx = cellContextAt(doc.resolve(pos));
	return ctx ? { tablePos: ctx.tablePos, row: ctx.row, col: ctx.col } : null;
}

/** 選択のあるセル(表の外なら null)。 */
export function selectionTableCell(state: EditorState): TableCellTarget | null {
	const ctx = cellContext(state);
	return ctx ? { tablePos: ctx.tablePos, row: ctx.row, col: ctx.col } : null;
}

/** 表の (row, col) のセルの前の位置(セルのノードの位置)。無ければ null。 */
export function tableCellPos(doc: PMNode, target: TableCellTarget): number | null {
	const table = doc.nodeAt(target.tablePos);
	if (!table || table.type !== nodes.table || target.row >= table.childCount) return null;
	const row = table.child(target.row);
	if (target.col >= row.childCount) return null;
	return cellStart(table, target.tablePos, target.row, target.col) - 1;
}

/**
 * `command` を、カーソルのセルではなく `target` のセルを対象にして当てる(印の行・列に対する操作)。選択を target のセルの
 * 先頭に移した state で Command を作り、取引は 1 つ(選択の移動はその取引の中)。target が表のセルでなければ false。
 */
export function commandAtCell(command: Command, target: TableCellTarget): Command {
	return (state, dispatch, view) => {
		const at = tableCellPos(state.doc, target);
		if (at === null) return false;
		const moved = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at + 1)));
		return command(moved, dispatch, view);
	};
}

/** 表のセルの Enter: 同じ列の 1 つ下のセルの先頭へ(最後の行なら何もしない=true・取引なし)。表の外では false。 */
export const goToCellBelow: Command = (state, dispatch) => {
	const ctx = cellContext(state);
	if (!ctx) return false;
	if (ctx.row + 1 >= ctx.table.childCount) return true;
	const below = ctx.table.child(ctx.row + 1);
	const col = Math.min(ctx.col, below.childCount - 1);
	if (dispatch) {
		const at = cellStart(ctx.table, ctx.tablePos, ctx.row + 1, col);
		dispatch(state.tr.setSelection(TextSelection.create(state.doc, at)).scrollIntoView());
	}
	return true;
};
