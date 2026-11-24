/**
 * コードのファイルと plain text の面のキー割り当て(要件#74 契約5・契約19 の「第1段の作り」16・AC-74-33)。
 *
 * `@codemirror/commands` から必要なものだけを選んで組む(`basicSetup`・`defaultKeymap` 丸ごと・
 * `searchKeymap` は使わない)。入れないもの: `menu.rs` のアクセラレータ・Format の表のキー(契約8)・
 * Option + Command + U(raw=契約23)・Command + D / Command + Shift + D(複数カーソル)・
 * Command + Option + 矢印(要件75 の分割の案)・Option + 上下(行の移動=第3段)・Command + /(コメント=
 * 第3段)・Command + ] / Command + [(Format の字下げ)。
 *
 * 文字の入力は CodeMirror の既定(contenteditable の入力)のまま。括弧・引用符の補完は入れない。
 */
import { EditorSelection, type EditorState, type StateCommand } from '@codemirror/state';
import type { KeyBinding } from '@codemirror/view';
import { getIndentUnit, indentUnit } from '@codemirror/language';
import {
	cursorCharLeft,
	cursorCharRight,
	cursorDocEnd,
	cursorDocStart,
	cursorGroupLeft,
	cursorGroupRight,
	cursorLineBoundaryBackward,
	cursorLineBoundaryForward,
	cursorLineBoundaryLeft,
	cursorLineBoundaryRight,
	cursorLineDown,
	cursorLineUp,
	cursorPageDown,
	cursorPageUp,
	deleteCharBackward,
	deleteCharForward,
	deleteGroupBackward,
	deleteGroupForward,
	deleteLineBoundaryBackward,
	indentLess,
	indentMore,
	insertNewlineKeepIndent,
	redo,
	selectAll,
	selectCharLeft,
	selectCharRight,
	selectDocEnd,
	selectDocStart,
	selectGroupLeft,
	selectGroupRight,
	selectLineBoundaryBackward,
	selectLineBoundaryForward,
	selectLineBoundaryLeft,
	selectLineBoundaryRight,
	selectLineDown,
	selectLineUp,
	selectPageDown,
	selectPageUp,
	simplifySelection,
	toggleComment,
	undo,
} from '@codemirror/commands';

/** 字下げの単位の文字列(`indentUnit` の facet。タブの文書ではタブ 1 つ)。 */
function unitOf(state: EditorState): string {
	return state.facet(indentUnit);
}

/**
 * Tab: 選択が空なら字下げの単位を 1 つカーソルに入れ、行をまたぐ選択(か範囲の選択)があれば
 * その行をまとめて 1 段深くする(`indentMore`)。
 */
const insertIndentUnit: StateCommand = ({ state, dispatch }) => {
	if (state.readOnly) return false;
	if (state.selection.ranges.some((r) => !r.empty)) return indentMore({ state, dispatch });
	const unit = unitOf(state) || ' '.repeat(getIndentUnit(state));
	dispatch(
		state.update(state.replaceSelection(unit), {
			scrollIntoView: true,
			userEvent: 'input.indent',
		}),
	);
	return true;
};

/** Enter: 改行+前の行の字下げ(構文による字下げはしない)。読み取り専用では何もしない。 */
const newlineKeepIndent: StateCommand = (target) => !target.state.readOnly && insertNewlineKeepIndent(target);

/**
 * Option + 上 / 下: 選択を含む行(複数行なら全部)を 1 行上 / 下と入れ替え、選択も一緒に動かす(第3段 3-3・3-13)。
 * `@codemirror/commands` の moveLineUp / Down と同じ振る舞いだが、入れ替える範囲の改行(動かした行と入れ替わった行の終わりの
 * 改行も)をまとめて書き直すので、それらは文書の主たる改行になり(改行の印が消える=契約15)、ほかの行は byte 等価。
 * BOM(文書の先頭の U+FEFF)は先頭のまま残す。先頭の行で上・末尾の行で下・読み取り専用では何もしない(false)。
 */
function moveLines(dir: -1 | 1): StateCommand {
	return ({ state, dispatch }) => {
		if (state.readOnly) return false;
		const doc = state.doc;
		const main = state.selection.main;
		const first = doc.lineAt(main.from);
		let last = doc.lineAt(main.to);
		if (main.to > main.from && main.to === last.from && last.number > first.number) last = doc.line(last.number - 1);
		const other = dir < 0 ? first.number - 1 : last.number + 1;
		if (other < 1 || other > doc.lines) return false;
		const top = dir < 0 ? doc.line(other) : first;
		const bottom = dir < 0 ? last : doc.line(other);
		const bom = top.from === 0 && doc.sliceString(0, 1) === '\uFEFF' ? 1 : 0;
		const from = top.from + bom;
		// 下の行の終わりの改行も書き直す(文書の終わりで改行が無ければ足さない)
		const hasBreak = bottom.to < doc.length;
		const to = hasBreak ? bottom.to + 1 : bottom.to;
		const blockText = doc.sliceString(first.from + (first.from === top.from ? bom : 0), last.to, '\n');
		const otherLine = doc.line(other);
		const otherText = doc.sliceString(otherLine.from + (otherLine.from === top.from ? bom : 0), otherLine.to);
		const insert = (dir < 0 ? `${blockText}\n${otherText}` : `${otherText}\n${blockText}`) + (hasBreak ? '\n' : '');
		const shift = dir < 0 ? -(otherText.length + 1) : otherText.length + 1;
		const ranges = state.selection.ranges.map((r) =>
			r.from >= first.from && r.to <= last.to + 1 ? EditorSelection.range(r.anchor + shift, r.head + shift) : r,
		);
		dispatch(
			state.update({
				changes: { from, to, insert },
				selection: EditorSelection.create(ranges, state.selection.mainIndex),
				scrollIntoView: true,
				userEvent: 'move.line',
			}),
		);
		return true;
	};
}

/** Command + /: その言語の注釈の記号で切り替える(言語・注釈の記号が無ければ何もしない)。読み取り専用では何もしない。 */
const toggleCommentIfEditable: StateCommand = (target) => !target.state.readOnly && toggleComment(target);

/** `@codemirror/commands` から選んで組んだ割り当て。 */
export const CODE_KEYMAP: readonly KeyBinding[] = [
	{ key: 'Enter', run: newlineKeepIndent },
	{ key: 'Tab', run: insertIndentUnit, shift: indentLess, preventDefault: true },
	{ key: 'Mod-z', run: undo, preventDefault: true },
	{ key: 'Mod-Shift-z', run: redo, preventDefault: true },
	{ key: 'ArrowLeft', run: cursorCharLeft, shift: selectCharLeft, preventDefault: true },
	{ key: 'ArrowRight', run: cursorCharRight, shift: selectCharRight, preventDefault: true },
	{ key: 'ArrowUp', run: cursorLineUp, shift: selectLineUp, preventDefault: true },
	{ key: 'ArrowDown', run: cursorLineDown, shift: selectLineDown, preventDefault: true },
	{ key: 'Alt-ArrowLeft', run: cursorGroupLeft, shift: selectGroupLeft, preventDefault: true },
	{ key: 'Alt-ArrowRight', run: cursorGroupRight, shift: selectGroupRight, preventDefault: true },
	// 第3段 3-3(3-13): 行の移動と注釈の切り替え
	{ key: 'Alt-ArrowUp', run: moveLines(-1) },
	{ key: 'Alt-ArrowDown', run: moveLines(1) },
	{ key: 'Mod-/', run: toggleCommentIfEditable, preventDefault: true },
	{ key: 'Mod-ArrowLeft', run: cursorLineBoundaryLeft, shift: selectLineBoundaryLeft, preventDefault: true },
	{ key: 'Mod-ArrowRight', run: cursorLineBoundaryRight, shift: selectLineBoundaryRight, preventDefault: true },
	{ key: 'Mod-ArrowUp', run: cursorDocStart, shift: selectDocStart, preventDefault: true },
	{ key: 'Mod-ArrowDown', run: cursorDocEnd, shift: selectDocEnd, preventDefault: true },
	{ key: 'Home', run: cursorLineBoundaryBackward, shift: selectLineBoundaryBackward, preventDefault: true },
	{ key: 'End', run: cursorLineBoundaryForward, shift: selectLineBoundaryForward, preventDefault: true },
	{ key: 'PageUp', run: cursorPageUp, shift: selectPageUp },
	{ key: 'PageDown', run: cursorPageDown, shift: selectPageDown },
	{ key: 'Backspace', run: deleteCharBackward, shift: deleteCharBackward },
	{ key: 'Delete', run: deleteCharForward },
	{ key: 'Alt-Backspace', run: deleteGroupBackward },
	{ key: 'Alt-Delete', run: deleteGroupForward },
	{ key: 'Mod-Backspace', run: deleteLineBoundaryBackward },
	{ key: 'Mod-a', run: selectAll },
	{ key: 'Escape', run: simplifySelection },
];
