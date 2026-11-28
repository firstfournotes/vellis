/**
 * 装飾のコマンド(要件#74 契約8・10・11・第2段の作り(案)の項目 7・11)。純関数(prosemirror の Command)。
 *
 * どのコマンドも取引 1 つ(=undo 1 段)。mark は綴りを持たないので、外すときは綴りを問わず外れる(`__x__` も
 * `**x**` も Bold で外れる)。原文への現れ方は書き出しの規則(契約6)で決まる。
 *
 * Link… と Image… は入力欄・ファイルを選ぶダイアログを出す面の仕事なので、ここの Command は「リンクの中なら
 * リンクを外す・それ以外は false」/「false」。
 */
import { Fragment, type Mark, type MarkType, type Node as PMNode, type NodeType, type ResolvedPos } from 'prosemirror-model';
import { TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { lift, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { liftListItem, sinkListItem, wrapInList } from 'prosemirror-schema-list';
import type { EditorView } from 'prosemirror-view';

import { markdownSchema as schema } from './markdown-schema';
import { TABLE_COMMANDS } from './table-commands';
import type { FileEditorHandle, MarkdownEditorHandle } from './file-editor';

export type FormatItemId =
	| 'format-bold'
	| 'format-italic'
	| 'format-strikethrough'
	| 'format-inline-code'
	| 'format-link'
	| 'format-body-text'
	| 'format-heading-1'
	| 'format-heading-2'
	| 'format-heading-3'
	| 'format-heading-4'
	| 'format-heading-5'
	| 'format-heading-6'
	| 'format-bulleted-list'
	| 'format-numbered-list'
	| 'format-task-list'
	| 'format-quote'
	| 'format-code-block'
	| 'format-alert-note'
	| 'format-alert-tip'
	| 'format-alert-important'
	| 'format-alert-warning'
	| 'format-alert-caution'
	| 'format-indent'
	| 'format-outdent'
	| 'format-insert-table'
	| 'format-insert-rule'
	| 'format-insert-footnote'
	| 'format-insert-image'
	// 第3段 3-2: Format ▸ Table ▸(行と列の追加と削除=table-commands.ts の TableFormatItemId と同じ 7 つ)
	| 'format-table-row-above'
	| 'format-table-row-below'
	| 'format-table-column-left'
	| 'format-table-column-right'
	| 'format-table-delete-row'
	| 'format-table-delete-column'
	| 'format-table-delete'
	| 'format-clear';

/** lib.rs が前面の窓へ送るイベント(payload=項目の ID)。 */
export const MENU_FORMAT_EVENT = 'menu_format';

const nodes = schema.nodes;
const marks = schema.marks;

// ---------------------------------------------------------------------------
// 文字の装飾
// ---------------------------------------------------------------------------

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** `$pos` を含む単語の範囲(前後どちらも語の文字のときだけ)。文字のブロックの外・単語の上でなければ null。 */
export function wordRangeAt($pos: ResolvedPos): { from: number; to: number } | null {
	const parent = $pos.parent;
	if (!parent.isTextblock) return null;
	const text = parent.textBetween(0, parent.content.size, '\0', '\0');
	const offset = $pos.parentOffset;
	if (!WORD_CHAR.test(text[offset - 1] ?? '') || !WORD_CHAR.test(text[offset] ?? '')) return null;
	let start = offset;
	while (start > 0 && WORD_CHAR.test(text[start - 1]!)) start--;
	let end = offset;
	while (end < text.length && WORD_CHAR.test(text[end]!)) end++;
	return { from: $pos.start() + start, to: $pos.start() + end };
}

/**
 * mark の付け外し。範囲の選択はそのまま `toggleMark`。空の選択はカーソルの単語(前後どちらも語の文字の位置)に付ける
 * / 外す。単語の上でなければ、以後打つ文字に付く(stored mark)。
 */
function markCommand(type: MarkType): Command {
	const toggle = toggleMark(type);
	return (state, dispatch) => {
		const { selection } = state;
		if (!selection.empty || !(selection instanceof TextSelection)) return toggle(state, dispatch);
		const $cursor = selection.$cursor;
		if (!$cursor) return toggle(state, dispatch);
		const parent = $cursor.parent;
		if (!parent.isTextblock || !parent.type.allowsMarkType(type)) return false;
		const word = wordRangeAt($cursor);
		if (!word) return toggle(state, dispatch);
		const { from, to } = word;
		if (dispatch) {
			const tr = state.doc.rangeHasMark(from, to, type) ? state.tr.removeMark(from, to, type) : state.tr.addMark(from, to, type.create());
			dispatch(tr);
		}
		return true;
	};
}

/** 選択の mark を全部外す(Clear Formatting=(an))。空の選択なら以後打つ文字の mark を外す。 */
const clearFormatting: Command = (state, dispatch) => {
	const { from, to, empty } = state.selection;
	if (dispatch) {
		const tr = state.tr;
		if (empty) tr.setStoredMarks([]);
		else tr.removeMark(from, to);
		dispatch(tr);
	}
	return true;
};

/**
 * カーソルか選択がリンクの mark の中なら、そのリンクの範囲(同じ mark が続く範囲)と mark。リンクの外なら null
 * (第4段 4-5: Link… の欄がリンクの中で開くときの範囲)。
 */
export function linkRangeAt(state: EditorState): { from: number; to: number; mark: Mark } | null {
	const { $from, from, to, empty } = state.selection;
	const linkAt = (pos: number): Mark | undefined =>
		state.doc.resolve(pos).marks().find((m) => m.type === marks.link) ??
		state.doc.nodeAt(pos)?.marks.find((m) => m.type === marks.link);
	const link = empty ? linkAt(from) : state.doc.rangeHasMark(from, to, marks.link!) ? linkAt(from) ?? linkAt(from + 1) : undefined;
	if (!link) return null;
	const parent = $from.parent;
	const base = $from.start();
	let start = -1;
	let end = -1;
	let done = false;
	parent.forEach((child, offset) => {
		if (done) return;
		const at = base + offset;
		if (link.isInSet(child.marks)) {
			if (start < 0) start = at;
			end = at + child.nodeSize;
		} else if (start >= 0) {
			if (from >= start && from <= end) done = true;
			else start = end = -1;
		}
	});
	if (start < 0 || from < start || from > end) {
		start = from;
		end = to;
	}
	return { from: start, to: end, mark: link };
}

/**
 * Link…(第4段 4-5・4-10): リンクの中でも外でも文書は変えない(false)。面が欄(Text と Link・Remove Link・Done)を開く
 * (`runFormatCommand` が false を受けて `openLinkInput`)。
 */
const linkCommand: Command = () => false;

// ---------------------------------------------------------------------------
// ブロックの種類
// ---------------------------------------------------------------------------

/** 選択のすべての textblock がその型(と属性)か。 */
function allTextblocksAre(state: EditorState, type: NodeType, attrs?: Record<string, unknown>): boolean {
	const { from, to } = state.selection;
	let all = true;
	let any = false;
	state.doc.nodesBetween(from, to, (node) => {
		if (!node.isTextblock) return true;
		any = true;
		if (node.type !== type) all = false;
		else if (attrs) for (const [k, v] of Object.entries(attrs)) if (node.attrs[k] !== v) all = false;
		return false;
	});
	return any && all;
}

function headingCommand(level: number): Command {
	const toHeading = setBlockType(nodes.heading!, { level });
	const toParagraph = setBlockType(nodes.paragraph!);
	return (state, dispatch) => {
		if (allTextblocksAre(state, nodes.heading!, { level })) return toParagraph(state, dispatch);
		if (!dispatch) return toHeading(state);
		let tr: Transaction | null = null;
		if (!toHeading(state, (t) => (tr = t))) return false;
		const built = tr as Transaction | null;
		if (!built) return false;
		// 見出しは 1 行: 見出しにした段落の中の hard break は soft break に替える(同じ取引=undo 1 回で戻る)。空白 2 つの
		// hard break を残すと、書き出しが見出しを 2 つに割る(h1 / h2 は setext に変わる)
		const from = built.mapping.map(state.selection.from, -1);
		const to = built.mapping.map(state.selection.to, 1);
		const breaks: number[] = [];
		built.doc.nodesBetween(from, to, (node, pos) => {
			if (node.type === nodes.heading) {
				node.forEach((child, offset) => {
					if (child.type === nodes.hard_break) breaks.push(pos + 1 + offset);
				});
				return false;
			}
			return true;
		});
		for (const at of breaks.reverse()) built.replaceWith(at, at + 1, nodes.soft_break!.create());
		dispatch(built);
		return true;
	};
}

/** 選択を含むいちばん内側の、指定の型のノードの深さ(無ければ -1)。 */
function ancestorDepth(state: EditorState, types: NodeType[]): number {
	const $from = state.selection.$from;
	for (let d = $from.depth; d > 0; d--) if (types.includes($from.node(d).type)) return d;
	return -1;
}

/** リストにする / 外す / 種類を替える。 */
function listCommand(type: NodeType): Command {
	const wrap = wrapInList(type);
	const liftItem = liftListItem(nodes.list_item!);
	return (state, dispatch) => {
		const depth = ancestorDepth(state, [nodes.bullet_list!, nodes.ordered_list!]);
		if (depth < 0) return wrap(state, dispatch);
		const $from = state.selection.$from;
		const list = $from.node(depth);
		if (list.type === type) return liftItem(state, dispatch);
		if (dispatch) dispatch(state.tr.setNodeMarkup($from.before(depth), type, { ...list.attrs }));
		return true;
	};
}

/** タスクの項目にする / 外す。 */
const taskListCommand: Command = (state, dispatch) => {
	const itemDepth = ancestorDepth(state, [nodes.list_item!]);
	if (itemDepth >= 0) {
		const $from = state.selection.$from;
		const item = $from.node(itemDepth);
		if (item.attrs.checked !== null) return liftListItem(nodes.list_item!)(state, dispatch);
		if (dispatch) dispatch(state.tr.setNodeMarkup($from.before(itemDepth), undefined, { ...item.attrs, checked: false }));
		return true;
	}
	let wrapped: Transaction | null = null;
	if (!wrapInList(nodes.bullet_list!)(state, (tr) => (wrapped = tr))) return false;
	if (dispatch && wrapped) {
		const tr = wrapped as Transaction;
		const { from, to } = tr.selection;
		tr.doc.nodesBetween(Math.max(0, from - 2), Math.min(tr.doc.content.size, to + 2), (node, pos) => {
			if (node.type === nodes.list_item && node.attrs.checked === null) tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false });
			return true;
		});
		dispatch(tr);
	}
	return true;
};

/** 引用 / アラートで包む・外す。 */
function wrapToggle(type: NodeType, attrs?: Record<string, unknown>): Command {
	const wrap = wrapIn(type, attrs);
	return (state, dispatch) => {
		const depth = ancestorDepth(state, [type]);
		if (depth >= 0) {
			const node = state.selection.$from.node(depth);
			if (attrs && Object.entries(attrs).some(([k, v]) => node.attrs[k] !== v)) {
				if (dispatch) dispatch(state.tr.setNodeMarkup(state.selection.$from.before(depth), undefined, { ...node.attrs, ...attrs }));
				return true;
			}
			return lift(state, dispatch);
		}
		return wrap(state, dispatch);
	};
}

const codeBlockCommand: Command = (state, dispatch) =>
	allTextblocksAre(state, nodes.code_block!) ? setBlockType(nodes.paragraph!)(state, dispatch) : setBlockType(nodes.code_block!)(state, dispatch);

// ---------------------------------------------------------------------------
// 挿入
// ---------------------------------------------------------------------------

/** カーソルを含む最上位ブロックの直後の位置。 */
function afterTopBlock(state: EditorState): number {
	const $from = state.selection.$from;
	return $from.depth >= 1 ? $from.after(1) : state.selection.from;
}

const insertTable: Command = (state, dispatch) => {
	if (dispatch) {
		const header = nodes.table_row!.create(null, [nodes.table_header!.create(), nodes.table_header!.create()]);
		const body = nodes.table_row!.create(null, [nodes.table_cell!.create(), nodes.table_cell!.create()]);
		const table = nodes.table!.create(null, [header, body]);
		const at = afterTopBlock(state);
		const tr = state.tr.insert(at, table);
		tr.setSelection(TextSelection.near(tr.doc.resolve(at + 3)));
		dispatch(tr.scrollIntoView());
	}
	return true;
};

const insertRule: Command = (state, dispatch) => {
	if (dispatch) {
		const at = afterTopBlock(state);
		dispatch(state.tr.insert(at, nodes.horizontal_rule!.create()).scrollIntoView());
	}
	return true;
};

/** 脚注参照(文書でまだ使っていない最小の番号)をカーソルに置き、文書の末尾に定義を足してそこへ移る。 */
const insertFootnote: Command = (state, dispatch) => {
	const used = new Set<string>();
	state.doc.descendants((n) => {
		if (n.type === nodes.footnote_reference || n.type === nodes.footnote_definition) used.add(String(n.attrs.label));
		return true;
	});
	let n = 1;
	while (used.has(String(n))) n++;
	const label = String(n);
	if (!state.selection.$from.parent.inlineContent) return false;
	if (dispatch) {
		const tr = state.tr.replaceSelectionWith(nodes.footnote_reference!.create({ label }), false);
		const end = tr.doc.content.size;
		tr.insert(end, nodes.footnote_definition!.create({ label }, nodes.paragraph!.create()));
		tr.setSelection(TextSelection.near(tr.doc.resolve(end + 2)));
		dispatch(tr.scrollIntoView());
	}
	return true;
};

const never: Command = () => false;

/** 項目 10 の表の ID → Command。 */
export const FORMAT_COMMANDS: Record<FormatItemId, Command> = {
	'format-bold': markCommand(marks.strong!),
	'format-italic': markCommand(marks.em!),
	'format-strikethrough': markCommand(marks.strike!),
	'format-inline-code': markCommand(marks.code!),
	'format-link': linkCommand,
	'format-body-text': setBlockType(nodes.paragraph!),
	'format-heading-1': headingCommand(1),
	'format-heading-2': headingCommand(2),
	'format-heading-3': headingCommand(3),
	'format-heading-4': headingCommand(4),
	'format-heading-5': headingCommand(5),
	'format-heading-6': headingCommand(6),
	'format-bulleted-list': listCommand(nodes.bullet_list!),
	'format-numbered-list': listCommand(nodes.ordered_list!),
	'format-task-list': taskListCommand,
	'format-quote': wrapToggle(nodes.blockquote!),
	'format-code-block': codeBlockCommand,
	'format-alert-note': wrapToggle(nodes.alert!, { kind: 'note' }),
	'format-alert-tip': wrapToggle(nodes.alert!, { kind: 'tip' }),
	'format-alert-important': wrapToggle(nodes.alert!, { kind: 'important' }),
	'format-alert-warning': wrapToggle(nodes.alert!, { kind: 'warning' }),
	'format-alert-caution': wrapToggle(nodes.alert!, { kind: 'caution' }),
	'format-indent': sinkListItem(nodes.list_item!),
	'format-outdent': liftListItem(nodes.list_item!),
	'format-insert-table': insertTable,
	'format-insert-rule': insertRule,
	'format-insert-footnote': insertFootnote,
	'format-insert-image': never,
	...TABLE_COMMANDS,
	'format-clear': clearFormatting,
};

export const FORMAT_ITEM_IDS: readonly FormatItemId[] = Object.keys(FORMAT_COMMANDS) as FormatItemId[];

// ---------------------------------------------------------------------------
// Format のイベントの受け手(契約8・10)
// ---------------------------------------------------------------------------

/** 変換中に届いた Format の最後の 1 つと、確定を待つ受け手を外す関数(変換が終わったら 1 回だけ当てる)。 */
const deferred = new WeakMap<EditorView, { id: FormatItemId; stopWaiting: () => void }>();

function deferUntilComposed(view: EditorView, id: FormatItemId): void {
	const waiting = deferred.get(view);
	if (waiting) {
		waiting.id = id;
		return;
	}
	// 確定(compositionend)か、変換中の blur(WebKit は compositionend を出さないことがある=契約10)で 1 回だけ当てる
	const onEnd = () => {
		stopWaiting();
		setTimeout(() => {
			const last = deferred.get(view);
			deferred.delete(view);
			if (last === undefined || view.isDestroyed) return;
			FORMAT_COMMANDS[last.id](view.state, view.dispatch, view);
		}, 0);
	};
	const stopWaiting = () => {
		view.dom.removeEventListener('compositionend', onEnd);
		view.dom.removeEventListener('blur', onEnd);
	};
	deferred.set(view, { id, stopWaiting });
	view.dom.addEventListener('compositionend', onEnd);
	view.dom.addEventListener('blur', onEnd);
}

/**
 * 変換中に控えた Format を捨てる(当てない)。確定が来ないまま面の文書を入れ替えたとき(Reload File・開き直し= 面の
 * resetDocument)に呼ぶ: 確定の来ない控えが、後の blur や次の変換の確定でその時の選択に当たらないように(要件#74
 * 差し戻し P3)。Format ▸ Bold・ツールバー・変換中の Command + B / I の控えはどれもこの 1 つ。
 */
export function discardDeferredFormat(view: EditorView): void {
	deferred.get(view)?.stopWaiting();
	deferred.delete(view);
}

/** Format の項目を当てられる面(Markdown の編集面・raw でない・読み取り専用でない)。それ以外は null。 */
function formatTarget(handle: FileEditorHandle | MarkdownEditorHandle | null): MarkdownEditorHandle | null {
	if (!handle || handle.kind !== 'markdown') return null;
	const md = handle as MarkdownEditorHandle;
	return md.raw || md.readOnly ? null : md;
}

/**
 * Format のイベントの受け手: handle が Markdown の編集面(kind 'markdown'・raw でない・readOnly でない)のときだけ
 * Command を当てて true。raw・コード(kind 'text')・読み取り専用・null では何もせず false。変換中は控え、
 * compositionend の後に 1 回だけ当てる(返り値は false)。
 */
export function runFormatCommand(id: FormatItemId, handle: FileEditorHandle | MarkdownEditorHandle | null): boolean {
	const md = formatTarget(handle);
	const command = FORMAT_COMMANDS[id];
	if (!md || !command) return false;
	const view = md.view;
	if (view.composing) {
		deferUntilComposed(view, id);
		return false;
	}
	const done = command(view.state, view.dispatch, view);
	// Link…(リンクの外)と Image… は面が続きを持つ(URL の入力欄・ファイルのダイアログ)
	if (!done && id === 'format-link') md.openLinkInput?.();
	if (!done && id === 'format-insert-image') md.chooseImage?.();
	return done;
}

/**
 * 変換中に面が受けた Command + B / I(isComposing の keydown。要件#74 由谷の決定 2026-11-20 21:40): 変換中に届いた
 * Format ▸ Bold / Italic と同じく控え、確定(か変換中の blur)の後に 1 回だけ当てる(控えは Format と共有=最後の 1 つ)。
 * 呼ぶのは面が変換中のときだけ(面の keydown が view.composing と面の変換中の印を見る。変換中でない面に来た isComposing の
 * 鍵は捨てる=差し戻し P2)。当てられない面(raw・コード・読み取り専用)では何もしない。
 */
export function deferFormatCommand(id: FormatItemId, handle: FileEditorHandle | MarkdownEditorHandle | null): void {
	const md = formatTarget(handle);
	if (!md || !FORMAT_COMMANDS[id]) return;
	deferUntilComposed(md.view, id);
}

/** 貼り付けの text/plain を、空行で段落に分けた文字の切片にする(Markdown として読まない=契約17)。 */
export function plainTextParagraphs(text: string): PMNode[] {
	const blocks = text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/);
	return blocks.map((block) => {
		const lines = block.split('\n');
		const inline: PMNode[] = [];
		lines.forEach((line, i) => {
			if (i > 0) inline.push(nodes.soft_break!.create({ raw: '\n' }));
			if (line) inline.push(schema.text(line));
		});
		return nodes.paragraph!.create(null, Fragment.fromArray(inline));
	});
}
