/**
 * Markdown の面の入力規則(要件#74 契約9・10・11・第3段 3-1・由谷の決定 2026-11-17 昼)。
 *
 * - ブロック: 段落の先頭だけ。`# `〜`###### `・`- ` `* ` `+ `・`1. ` `1) `・`> `・``` / ~~~ + 言語名 + 空白・
 *   リスト項目の段落の先頭の `[ ] ` / `[x] `。見出し・表のセル・code fence の中では発火しない
 * - インライン: 閉じの記号を打った瞬間に、候補(開きの 1 つ前の字と、カーソルの後ろの 1 字を含む)を remark-parse +
 *   remark-gfm で読み、その mark 1 つが中身をちょうど覆うときだけ変える(`snake_case` や `2 * 3 * 4` は変わらない)
 * - どの規則も inline code / code fence の中では効かず、取り消せる(`undoInputRule`)。半角の記号だけ。
 *   smartQuotes・emDash・ellipsis は入れない
 *
 * 規則の当て方は `prosemirror-inputrules` の `inputRules` と同じ(plugin の state の形も同じ=`undoInputRule` が効く)。
 * 違いは IME の確定(compositionend): 確定した文字(`event.data`)がカーソルの直前にあるときだけ 1 回判定する
 * (変換の取り消し=data が空では何もしない。素の plugin は毎回カーソルの前を読み直す)。
 */
import { InputRule, undoInputRule } from 'prosemirror-inputrules';
import { Plugin, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { canJoin, findWrapping } from 'prosemirror-transform';
import type { MarkType, Node as PMNode, NodeType } from 'prosemirror-model';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { markdownSchema as schema } from './markdown-schema';

const nodes = schema.nodes;
const marks = schema.marks;
const MAX_MATCH = 500;
const RULE_OPTIONS = { inCode: false, inCodeMark: false, undoable: true } as const;

// ---------------------------------------------------------------------------
// ブロックの規則
// ---------------------------------------------------------------------------

/** 規則の始まりが段落(paragraph)の先頭か。見出し・表のセル・code fence では偽。 */
function atParagraphStart(state: EditorState, start: number): boolean {
	const $start = state.doc.resolve(start);
	return $start.parent.type === nodes.paragraph && $start.parentOffset === 0;
}

function textblockRule(regexp: RegExp, type: NodeType, attrs: (m: RegExpMatchArray) => Record<string, unknown>, onlyMarker = false): InputRule {
	return new InputRule(
		regexp,
		(state, match, start, end) => {
			if (!atParagraphStart(state, start)) return null;
			const $start = state.doc.resolve(start);
			// code fence は段落の中身が記号だけのときだけ(後ろに文字があれば文字のまま)
			if (onlyMarker && $start.parent.content.size !== end - start) return null;
			if (!$start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), type)) return null;
			return state.tr.delete(start, end).setBlockType(start, start, type, attrs(match));
		},
		RULE_OPTIONS,
	);
}

function wrappingRule(regexp: RegExp, type: NodeType, attrs: (m: RegExpMatchArray) => Record<string, unknown>, join: (m: RegExpMatchArray, before: PMNode) => boolean): InputRule {
	return new InputRule(
		regexp,
		(state, match, start, end) => {
			if (!atParagraphStart(state, start)) return null;
			const tr = state.tr.delete(start, end);
			const $start = tr.doc.resolve(start);
			const range = $start.blockRange();
			const wrapping = range && findWrapping(range, type, attrs(match));
			if (!range || !wrapping) return null;
			tr.wrap(range, wrapping);
			const before = tr.doc.resolve(start - 1).nodeBefore;
			if (before && before.type === type && canJoin(tr.doc, start - 1) && join(match, before)) tr.join(start - 1);
			return tr;
		},
		RULE_OPTIONS,
	);
}

/** リスト項目の最初の段落の先頭で `[ ] ` / `[x] ` → タスク。 */
const taskRule = new InputRule(
	/^\[([ xX])\] $/,
	(state, match, start, end) => {
		if (!atParagraphStart(state, start)) return null;
		const $start = state.doc.resolve(start);
		if ($start.depth < 2 || $start.node(-1).type !== nodes.list_item || $start.index(-1) !== 0) return null;
		const itemPos = $start.before(-1);
		const item = $start.node(-1);
		return state.tr.delete(start, end).setNodeMarkup(itemPos, undefined, { ...item.attrs, checked: match[1] !== ' ' });
	},
	RULE_OPTIONS,
);

const BLOCK_RULES: InputRule[] = [
	textblockRule(/^(#{1,6}) $/, nodes.heading!, (m) => ({ level: m[1]!.length, setext: false })),
	wrappingRule(/^([-*+]) $/, nodes.bullet_list!, () => ({}), () => true),
	wrappingRule(
		/^(\d{1,9})[.)] $/,
		nodes.ordered_list!,
		(m) => ({ start: Number(m[1]) }),
		(m, before) => (before.attrs.start as number) + before.childCount === Number(m[1]),
	),
	wrappingRule(/^> $/, nodes.blockquote!, () => ({}), () => false),
	textblockRule(/^(?:```|~~~)([^\s`~]*) $/, nodes.code_block!, (m) => ({ lang: m[1] ?? '' }), true),
	taskRule,
];

// ---------------------------------------------------------------------------
// インラインの規則(remark の判定)
// ---------------------------------------------------------------------------

const parser = unified().use(remarkParse).use(remarkGfm);

type MdNode = { type: string; value?: string; children?: MdNode[]; position?: { start: { offset?: number }; end: { offset?: number } } };

/** 区切り記号ごとの mark と mdast の型。打った字が閉じの最後の字になるものだけを順に試す。 */
const DELIMS: Array<{ delim: string; mark: MarkType; mdType: string }> = [
	{ delim: '**', mark: marks.strong!, mdType: 'strong' },
	{ delim: '__', mark: marks.strong!, mdType: 'strong' },
	{ delim: '~~', mark: marks.strike!, mdType: 'delete' },
	{ delim: '*', mark: marks.em!, mdType: 'emphasis' },
	{ delim: '_', mark: marks.em!, mdType: 'emphasis' },
	{ delim: '`', mark: marks.code!, mdType: 'inlineCode' },
];

function textOf(n: MdNode): string {
	if (typeof n.value === 'string') return n.value;
	return (n.children ?? []).map(textOf).join('');
}

/** snippet の [open, close) をちょうど覆う mdType の節があり、中身が content か。 */
function remarkAgrees(snippet: string, open: number, close: number, mdType: string, content: string): boolean {
	const tree = parser.parse(snippet) as MdNode;
	const para = tree.children?.[0];
	if (!para || para.type !== 'paragraph' || (tree.children?.length ?? 0) !== 1) return false;
	const stack: MdNode[] = [...(para.children ?? [])];
	while (stack.length) {
		const n = stack.shift()!;
		if (n.type === mdType && n.position?.start.offset === open && n.position?.end.offset === close) return textOf(n) === content;
		if (n.children) stack.push(...n.children);
	}
	return false;
}

const inlineRule = new InputRule(
	/[*_~`]$/,
	(state, match, start, end) => {
		const $start = state.doc.resolve(start);
		const parent = $start.parent;
		if (!parent.isTextblock || parent.type.spec.code) return null;
		const parentStart = $start.start();
		const lead = parent.textBetween(Math.max(0, $start.parentOffset - MAX_MATCH), $start.parentOffset, undefined, '\ufffc');
		const T = lead + match[0]; // 最後の字=打った字(確定の判定では文書の中の字)
		// T[i] の文書の位置
		const posOf = (i: number) => start - (T.length - 1 - i);
		const after = state.doc.resolve(end).parent === parent ? parent.textBetween(end - parentStart, Math.min(parent.content.size, end - parentStart + 1), undefined, '\ufffc') : '';
		for (const { delim, mark, mdType } of DELIMS) {
			if (!T.endsWith(delim)) continue;
			const close = T.length - delim.length;
			const open = T.lastIndexOf(delim, close - 1 - (delim.length - 1));
			if (open < 0 || close - (open + delim.length) < 1) continue;
			const content = T.slice(open + delim.length, close);
			// atom・hard break を挟む範囲は変えない
			if (content.includes('\ufffc')) continue;
			const prefixFrom = Math.max(0, open - 1);
			const before = T.slice(prefixFrom, open);
			if (before === '\ufffc') continue;
			// 前に字があれば、さらに前に 'a' を置いて行頭の記法(`>` `#` `-` `1.`)に読まれないようにする(開きの判定は隣の字だけで決まる)
			const pad = before ? 'a' : '';
			const snippet = pad + before + T.slice(open) + (after === '\ufffc' ? '' : after);
			const shift = pad.length - prefixFrom;
			if (!remarkAgrees(snippet, open + shift, T.length + shift, mdType, content)) continue;
			const openPos = posOf(open);
			if (openPos < parentStart) continue;
			const tr = state.tr;
			// 閉じ(文書にある分と打った字)を消し、開きを消して、中身に mark を付ける
			tr.delete(posOf(close), end);
			tr.delete(openPos, openPos + delim.length);
			const from = openPos;
			const to = openPos + content.length;
			if (mark === marks.code) tr.removeMark(from, to);
			tr.addMark(from, to, mark.create());
			tr.setSelection(TextSelection.create(tr.doc, to));
			const xMarks = tr.doc.nodeAt(from)?.marks ?? [];
			tr.setStoredMarks(xMarks.filter((m) => m.type !== mark));
			return tr;
		}
		return null;
	},
	RULE_OPTIONS,
);

/** Markdown の面の入力規則(ブロック → インラインの順)。 */
export const MARKDOWN_INPUT_RULES: readonly InputRule[] = [...BLOCK_RULES, inlineRule];

// ---------------------------------------------------------------------------
// plugin(prosemirror-inputrules の inputRules と同じ形+IME の確定の扱い)
// ---------------------------------------------------------------------------

/** inline code の mark か(schema の code の mark は spec.code を持たないので型でも見る)。 */
function isCodeMark(m: { type: MarkType }): boolean {
	return m.type === marks.code || m.type.spec.code === true;
}

const UNDO_RULE_META = 'vellisUndoInputRule';

/**
 * 規則の直後なら記号の文字に戻す(`undoInputRule`)。戻す取引は打鍵と規則の undo の段に入れる(履歴の新しい段にしない)ので、
 * 続く普通の undo は打つ前の原文に戻る(契約11: 2 回目は普通の undo)。
 */
export const undoMarkdownInputRule: Command = (state, dispatch) =>
	undoInputRule(
		state,
		dispatch &&
			((tr: Transaction) => {
				// prosemirror-history は appendedTransaction の印がある取引を直前の段に足す
				tr.setMeta('appendedTransaction', tr).setMeta(UNDO_RULE_META, true);
				dispatch(tr);
			}),
	);

type RuleInternals = InputRule & {
	match: RegExp;
	handler: (state: EditorState, match: RegExpMatchArray, start: number, end: number) => Transaction | null;
	undoable: boolean;
	inCode: boolean | 'only';
	inCodeMark: boolean;
};

function run(view: EditorView, from: number, to: number, text: string, rules: readonly InputRule[], plugin: Plugin): boolean {
	if (view.composing) return false;
	const state = view.state;
	const $from = state.doc.resolve(from);
	// gap cursor など、文字のブロックの外(gap の打鍵は gap cursor の plugin が受ける)
	if (!$from.parent.isTextblock) return false;
	const textBefore = $from.parent.textBetween(Math.max(0, $from.parentOffset - MAX_MATCH), $from.parentOffset, undefined, '\ufffc') + text;
	const sel = state.selection;
	const marksHere = (from === sel.from && to === sel.to && state.storedMarks) || (from === to ? $from.marks() : $from.marksAcross(state.doc.resolve(to)) || []);
	for (const r of rules) {
		const rule = r as RuleInternals;
		if (!rule.inCodeMark && marksHere.some(isCodeMark)) continue;
		if ($from.parent.type.spec.code) {
			if (!rule.inCode) continue;
		} else if (rule.inCode === 'only') continue;
		const match = rule.match.exec(textBefore);
		if (!match || match[0].length < text.length) continue;
		const startPos = from - (match[0].length - text.length);
		if (!rule.inCodeMark) {
			let hasMark = false;
			state.doc.nodesBetween(startPos, $from.pos, (node) => {
				if (node.isInline && node.marks.some(isCodeMark)) hasMark = true;
			});
			if (hasMark) continue;
		}
		const tr = rule.handler(state, match, startPos, to);
		if (!tr) continue;
		if (rule.undoable) tr.setMeta(plugin, { transform: tr, from, to, text });
		view.dispatch(tr);
		return true;
	}
	return false;
}

/**
 * 入力規則の plugin(`spec.isInputRules` が真=`undoInputRule` が効く)。compositionend は、確定した文字(`event.data`)が
 * カーソルの直前にあるとき=規則の終わりに掛かるときだけ 1 回判定する(data が空=変換の取り消しでは何もしない)。
 */
export function markdownInputRules(): Plugin {
	const rules = MARKDOWN_INPUT_RULES;
	const plugin: Plugin = new Plugin({
		state: {
			init: () => null,
			apply(tr, prev) {
				if (tr.getMeta(UNDO_RULE_META)) return null;
				const stored = tr.getMeta(plugin);
				if (stored) return stored;
				// 規則の取引に続けて足される取引(bid の付け直し=bidPlugin)では、取り消せる印を落とさない
				if (tr.getMeta('appendedTransaction')) return prev;
				return tr.selectionSet || tr.docChanged ? null : prev;
			},
		},
		props: {
			handleTextInput(view, from, to, text) {
				return run(view, from, to, text, rules, plugin);
			},
			handleDOMEvents: {
				compositionend: (view, event) => {
					const data = (event as CompositionEvent).data ?? '';
					if (!data) return false;
					setTimeout(() => {
						const { $cursor } = view.state.selection as TextSelection;
						if (!$cursor || !$cursor.parent.isTextblock) return;
						const before = $cursor.parent.textBetween(Math.max(0, $cursor.parentOffset - data.length), $cursor.parentOffset, undefined, '\ufffc');
						if (before !== data) return;
						run(view, $cursor.pos, $cursor.pos, '', rules, plugin);
					});
					return false;
				},
			},
		},
		isInputRules: true,
	});
	return plugin;
}
