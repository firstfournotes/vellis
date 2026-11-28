/**
 * Markdown の面の gap cursor(要件#74 第3段 3-1・契約20 の第3段の部品・AC-74-58)。
 *
 * 文字のカーソルを置けない場所(2 つの塊=表・code fence・mermaid・生 HTML・区切り線の間、文書の先頭 / 末尾がそれらの
 * ときの前 / 後ろ)に横線のカーソルを置き、そこで打つと段落ができる(Enter は `MARKDOWN_KEYMAP` の `insertParagraphAtGap`)。
 * code fence は文字のブロックなので素の `GapCursor.valid` では隣に gap が立たない → schema の code_block に
 * `createGapCursor: true` を付けて許す(`isolating` は Backspace の結合を変えるので使わない)。
 *
 * Vellis の制約: 文書の先頭の front matter の前(位置 0)の gap は front matter の後ろへ寄せ(次が段落ならその先頭の
 * 文字のカーソル)、definition(参照定義=見えない行)の隣には gap を置かない。
 */
import { GapCursor, gapCursor } from 'prosemirror-gapcursor';
import { Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import type { ResolvedPos } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { markdownSchema as schema } from './markdown-schema';

/** gap に段落を作る(`text` があればその字を入れてカーソルを後ろへ)。gap でなければ null。 */
export function paragraphAtGap(state: EditorState, text = ''): Transaction | null {
	const sel = state.selection;
	if (!(sel instanceof GapCursor)) return null;
	const $pos = sel.$head;
	const paragraph = schema.nodes.paragraph!;
	if (!$pos.parent.canReplaceWith($pos.index(), $pos.index(), paragraph)) return null;
	const content = text ? schema.text(text, state.storedMarks ?? undefined) : undefined;
	const tr = state.tr.insert($pos.pos, paragraph.create(null, content));
	tr.setSelection(TextSelection.create(tr.doc, $pos.pos + 1 + text.length));
	return tr.scrollIntoView();
}

/** Enter: gap なら空の段落を作ってその中へ。 */
export const insertParagraphAtGap = (state: EditorState, dispatch?: (tr: Transaction) => void): boolean => {
	const tr = paragraphAtGap(state);
	if (!tr) return false;
	if (dispatch) dispatch(tr);
	return true;
};

/** `GapCursor.valid` は型の宣言で @internal(実装には在る)。 */
export const gapValid = (GapCursor as unknown as { valid($pos: ResolvedPos): boolean }).valid;

/** 置いてはいけない gap なら、置き直した選択を返す(そのままでよければ null)。 */
function correctedSelection(state: EditorState): Selection | null {
	const sel = state.selection;
	if (!(sel instanceof GapCursor)) return null;
	const doc = state.doc;
	const first = doc.firstChild;
	if (sel.head === 0 && first?.type === schema.nodes.front_matter) {
		const $after = doc.resolve(first.nodeSize);
		if (gapValid($after)) return new GapCursor($after);
		return Selection.near($after, 1);
	}
	const $pos = sel.$head;
	const definition = schema.nodes.definition;
	if ($pos.nodeBefore?.type === definition || $pos.nodeAfter?.type === definition) {
		const near = Selection.near($pos, -1);
		return near instanceof GapCursor ? TextSelection.near($pos, -1) : near;
	}
	return null;
}

/** gap cursor なら空の段落を作ってその中へ(変換の始まり)。 */
/**
 * 変換の始まりに gap に作った段落の範囲(字なしで終わったら消す)。取引ごとに写す(変換の途中で字が入って段落の Node が
 * 替わっても追える)。設定は作る取引の meta。次のときは忘れる(null): 段落が消えた(範囲が潰れた)・選択が段落の外へ出た。
 * 写し方: 開きの前は assoc 1(ちょうど前の境目に足されたものの後ろへ)、閉じの後は assoc -1(ちょうど後ろの境目に足されたもの
 * の前へ)。setNodeMarkup(系譜の番号)の付け替えは開き / 閉じの印の置き換えなので、範囲はそのまま写る。
 */
type CompositionParagraph = { from: number; to: number; closeBy?: number } | null;
const compositionParagraphKey = new PluginKey<CompositionParagraph>('vellis-gap-composition-paragraph');

/**
 * 字なしの compositionend の時点で ProseMirror がまだ DOM の変化(deleteCompositionText)を読んでいないとき、読んだ後の
 * 取引で判定する待ちの長さ(ms)。この間の最初の文書の変わる取引で 1 回だけ判定する(空なら消す・空でなければ忘れる)。
 */
const CLOSE_AFTER_READ_MS = 500;

/** 覚えた範囲がまだ空の段落で、カーソルがその中(先頭)か。 */
function emptyCompositionParagraph(state: EditorState, range: { from: number; to: number }): boolean {
	const node = state.doc.nodeAt(range.from);
	const sel = state.selection;
	return (
		node !== null &&
		node.type === schema.nodes.paragraph &&
		node.content.size === 0 &&
		range.from + node.nodeSize === range.to &&
		sel.empty &&
		sel.from === range.from + 1
	);
}

/** 覚えた空の段落を消して gap に戻す取引(履歴に積まない・覚えた範囲は忘れる)。 */
function removeCompositionParagraph(tr: Transaction, range: { from: number; to: number }): Transaction {
	tr.delete(range.from, range.to);
	const $at = tr.doc.resolve(range.from);
	tr.setSelection(gapValid($at) ? new GapCursor($at) : Selection.near($at, 1));
	return tr.setMeta(compositionParagraphKey, null).setMeta('addToHistory', false);
}

const compositionParagraph = new Plugin<CompositionParagraph>({
	key: compositionParagraphKey,
	state: {
		init: () => null,
		apply(tr, prev, _old, state) {
			const set = tr.getMeta(compositionParagraphKey) as CompositionParagraph | undefined;
			if (set !== undefined) return set;
			if (prev === null) return null;
			let next = prev;
			if (tr.docChanged) {
				next = { ...prev, from: tr.mapping.map(prev.from, 1), to: tr.mapping.map(prev.to, -1) };
				if (next.to - next.from < 2) return null;
			}
			const { from, to } = state.selection;
			if (from <= next.from || to >= next.to) return null;
			return next;
		},
	},
	// 字なしの compositionend の後の、ProseMirror が DOM を読んだ取引で判定する(待ちの間の最初の文書の変わる取引で 1 回だけ)
	appendTransaction(trs, _old, state) {
		const range = compositionParagraphKey.getState(state);
		if (!range || range.closeBy === undefined) return null;
		if (!trs.some((tr) => tr.docChanged)) return null;
		if (Date.now() > range.closeBy || !emptyCompositionParagraph(state, range)) {
			return state.tr.setMeta(compositionParagraphKey, null).setMeta('addToHistory', false);
		}
		return removeCompositionParagraph(state.tr, range);
	},
});

function openParagraphForComposition(view: EditorView): void {
	if (!(view.state.selection instanceof GapCursor)) return;
	const at = view.state.selection.head;
	const tr = paragraphAtGap(view.state);
	if (!tr) return;
	const made = tr.doc.nodeAt(at);
	view.dispatch(made ? tr.setMeta(compositionParagraphKey, { from: at, to: at + made.nodeSize }) : tr);
	// WebKit は変換の字を DOM の選択の所に置くので、DOM の選択が作った段落の中にあることを確かめ、無ければ移す
	// (実機: compositionstart の時点の DOM の選択は面の根の offset 0=gap の位置。最初の insertCompositionText を待つと遅い)
	const paragraph = view.nodeDOM(view.state.selection.from - 1);
	const domSel = (view.root as Document).getSelection?.();
	if (!paragraph || !domSel) return;
	if (domSel.anchorNode && paragraph.contains(domSel.anchorNode)) return;
	const { node, offset } = view.domAtPos(view.state.selection.from);
	domSel.collapse(node, offset);
}

/**
 * 変換が字なしで終わった(compositionend の data が空)とき、始まりに作った段落(写した位置)が空の段落で、カーソルがまだその中
 * (ほかの所へ動かしていない)なら消して gap に戻す(文書は元の byte・dirty でない。差し戻し P3・事後確認 (20)=途中で字が入り
 * Escape で消えた場合も)。字が残っていれば何もしない。compositionend の時点で ProseMirror がまだ DOM の変化を読んでおらず
 * 字が見えているときは、読んだ後の最初の文書の変わる取引で判定する(実機の Escape の順=空白 → 削除 → 読む前の compositionend)。
 */
function closeEmptyCompositionParagraph(view: EditorView, data: string): void {
	const range = compositionParagraphKey.getState(view.state) ?? null;
	if (range === null) return;
	const forget = view.state.tr.setMeta(compositionParagraphKey, null).setMeta('addToHistory', false);
	if (data) {
		view.dispatch(forget);
		return;
	}
	if (emptyCompositionParagraph(view.state, range)) {
		view.dispatch(removeCompositionParagraph(view.state.tr, range));
		return;
	}
	// まだ字が見えている: ProseMirror が DOM の変化(deleteCompositionText)を読む前かもしれない。読んだ後の取引で判定する
	const sel = view.state.selection;
	if (!(sel.empty && sel.from > range.from && sel.from < range.to)) {
		view.dispatch(forget);
		return;
	}
	view.dispatch(
		view.state.tr.setMeta(compositionParagraphKey, { from: range.from, to: range.to, closeBy: Date.now() + CLOSE_AFTER_READ_MS }).setMeta('addToHistory', false),
	);
}

/** 制約(front matter の前・definition の隣)と、gap での打鍵。 */
const gapRules = new Plugin({
	appendTransaction(trs, _old, state) {
		if (!trs.some((tr) => tr.selectionSet || tr.docChanged)) return null;
		const next = correctedSelection(state);
		return next ? state.tr.setSelection(next) : null;
	},
	props: {
		handleTextInput(view, _from, _to, text) {
			const tr = paragraphAtGap(view.state, text);
			if (!tr) return false;
			view.dispatch(tr);
			return true;
		},
		handleDOMEvents: {
			// 実機ゲート B・AC-74-58: 変換の始まり(keydown の keyCode 229 / compositionstart)の時点で gap cursor なら、先に gap に
			// 段落を作って選択(DOM の選択も)をその中に置く。WebKit は変換を DOM の選択の所で始め、gap の DOM の位置(表の前など)
			// では字を置ける隣(1 つ目のセル)へ寄せてしまう
			keydown(view, event) {
				// 変換の始まりとみなすのは key が 'Process' か 1 文字の鍵だけ。変換の後に keyCode 229 で届く名前のある鍵
				// (Escape・Enter・Backspace・矢印・Tab など)では作らない(実機: 字なしの compositionend の 6 ms 後の Escape)
				const e = event as KeyboardEvent;
				if (e.keyCode !== 229) return false;
				if (e.key === 'Process' || Array.from(e.key ?? '').length === 1) {
					openParagraphForComposition(view);
					return false;
				}
				// 名前のある鍵の 229 は変換(IME)が持っている鍵。gap では面の keymap(Enter=gap に段落など)にも渡さない
				// (既定の動作は止めない)
				return view.state.selection instanceof GapCursor;
			},
			compositionstart(view) {
				openParagraphForComposition(view);
				return false;
			},
			compositionend(view, event) {
				closeEmptyCompositionParagraph(view, (event as CompositionEvent).data ?? '');
				return false;
			},
			// 実機ゲート (8)・AC-74-58: WebKit は gap の DOM の位置(文書の先頭の表の前など)に字を置けず、キャレットを隣の
			// 文字の位置(1 つ目のセル)へ寄せて字を入れる。gap cursor のときは打鍵(insertText)を止めて、gap に段落を作る
			beforeinput(view, event) {
				const e = event as InputEvent;
				if (e.inputType !== 'insertText' || !e.data || e.isComposing || view.composing) return false;
				const tr = paragraphAtGap(view.state, e.data);
				if (!tr) return false;
				e.preventDefault();
				view.dispatch(tr);
				return true;
			},
		},
	},
});

/**
 * 表の 1 行目で ↑ / 最後の行で ↓ → 表の外へ(実機ゲート 12-8)。gapCursor() の矢印は今の位置から隣のセルの中へ探しに
 * 入って止まるので、1 つ目でないセルからは表の外の gap に出られない。表の外の隣が文字のブロックならその中(端)、
 * そうでなく gap が立つなら表の外の gap、どちらでもなければその向きの最寄りの選択。
 */
function leaveTableVertically(view: EditorView, dir: -1 | 1): boolean {
	const sel = view.state.selection;
	if (!(sel instanceof TextSelection) || !sel.empty) return false;
	const $head = sel.$head;
	let tableDepth = -1;
	for (let d = $head.depth; d > 0; d--) {
		if ($head.node(d).type === schema.nodes.table) {
			tableDepth = d;
			break;
		}
	}
	if (tableDepth < 0 || $head.depth !== tableDepth + 2) return false;
	const table = $head.node(tableDepth);
	const row = $head.index(tableDepth);
	if (dir < 0 ? row !== 0 : row !== table.childCount - 1) return false;
	if (!view.endOfTextblock(dir < 0 ? 'up' : 'down')) return false;
	const $out = view.state.doc.resolve(dir < 0 ? $head.before(tableDepth) : $head.after(tableDepth));
	const adjacent = dir < 0 ? $out.nodeBefore : $out.nodeAfter;
	let next: Selection | null = null;
	if (adjacent?.isTextblock) next = Selection.findFrom($out, dir, true);
	if (!next && gapValid($out)) next = new GapCursor($out);
	next ??= Selection.findFrom($out, dir) ?? Selection.near($out, dir);
	view.dispatch(view.state.tr.setSelection(next).scrollIntoView());
	return true;
}

const tableEdges = new Plugin({
	props: {
		handleKeyDown(view, event) {
			if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
			if (event.key === 'ArrowUp') return leaveTableVertically(view, -1);
			if (event.key === 'ArrowDown') return leaveTableVertically(view, 1);
			return false;
		},
	},
});

/** gapCursor() と Vellis の制約。面の plugin に展開して足す。 */
export function markdownGapCursor(): Plugin[] {
	return [tableEdges, gapCursor(), gapRules, compositionParagraph];
}
