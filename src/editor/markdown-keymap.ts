/**
 * Markdown の編集面のキー割り当て(要件#74 契約8・第2段の作り(案)の項目 8)。`prosemirror-keymap` の `keymap(…)` に渡す。
 *
 * 必要なものだけを選んで組む(`baseKeymap` を丸ごとは使わない=`Mod-[` などが入るため)。Format の表のキー・`menu.rs` の
 * アクセラレータ・raw のキー・複数カーソル・分割の案・行の移動・コメントのキーは入れない(Format は メニュー →
 * `menu_format` の 1 本の経路で当てる)。矢印・選択・行頭 / 行末はブラウザの既定。
 */
import type { Command } from 'prosemirror-state';
import {
	chainCommands,
	deleteSelection,
	joinBackward,
	joinForward,
	newlineInCode,
	selectNodeBackward,
	selectNodeForward,
	splitBlock,
} from 'prosemirror-commands';
import { liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list';
import { goToNextCell } from 'prosemirror-tables';
import { redo, undo } from 'prosemirror-history';
import { undoMarkdownInputRule } from './input-rules';
import { insertParagraphAtGap } from './gap-cursor';
import { goToCellBelow } from './table-commands';

import { markdownSchema as schema } from './markdown-schema';

const listItem = schema.nodes.list_item!;

/** 表のセル(見出しのセルも)の中か。GFM の表のセルは 1 行なので改行を入れない(AC-74-54)。 */
export function inTableCell(state: import('prosemirror-state').EditorState): boolean {
	const name = state.selection.$from.parent.type.name;
	return name === 'table_cell' || name === 'table_header';
}

/**
 * Shift + Enter: hard break(綴りは空白 2 つ+改行)。表のセルの中では何もしない(取引なし)が鍵は食う=ブラウザの
 * 既定の改行も入れない(AC-74-54・由谷の決定 2026-11-17 朝)。
 */
const insertHardBreak: Command = (state, dispatch) => {
	if (inTableCell(state)) return true;
	// 見出しの中も何もしない(見出しは 1 行。h3〜h6 は割れ、h1 / h2 は setext に変わってしまう)
	if (state.selection.$from.parent.type === schema.nodes.heading) return true;
	const { $from, empty } = state.selection;
	if (!$from.parent.inlineContent || $from.parent.type.spec.code) return false;
	if (dispatch) {
		const hardBreak = schema.nodes.hard_break!.create();
		const soft = schema.nodes.soft_break!;
		// 行末(継続行の改行=soft_break の手前か直後)の Shift + Enter は、その改行を hard break にする(改行を 2 つ重ねると
		// 書き出しで空行になり段落が割れる)
		if (empty && $from.nodeAfter?.type === soft) {
			dispatch(state.tr.replaceWith($from.pos, $from.pos + 1, hardBreak).scrollIntoView());
		} else if (empty && $from.nodeBefore?.type === soft) {
			dispatch(state.tr.replaceWith($from.pos - 1, $from.pos, hardBreak).scrollIntoView());
		} else {
			dispatch(state.tr.replaceSelectionWith(hardBreak).scrollIntoView());
		}
	}
	return true;
};

/** リスト項目の先頭の Backspace は項目を外す。 */
const liftAtItemStart: Command = (state, dispatch) => {
	const { $cursor } = state.selection as { $cursor?: import('prosemirror-model').ResolvedPos | null };
	if (!$cursor || $cursor.parentOffset > 0) return false;
	if ($cursor.depth < 2 || $cursor.node(-1).type !== listItem || $cursor.index(-1) > 0) return false;
	return liftListItem(listItem)(state, dispatch);
};

/** フォーカスを面の外へ逃がさない(Tab で何もしないとき)。 */
const swallow: Command = () => true;

/** キー名 → Command。 */
export const MARKDOWN_KEYMAP: Readonly<Record<string, Command>> = {
	// gap cursor の上の Enter は空の段落を作る(第3段 3-1)。表のセルでは 1 つ下のセルの先頭へ(セルは割れない=3-10)
	Enter: chainCommands(insertParagraphAtGap, goToCellBelow, newlineInCode, splitListItem(listItem), splitBlock),
	'Shift-Enter': insertHardBreak,
	// 入力規則の直後の Backspace は記号の文字に戻す(契約11・第3段 3-1)
	Backspace: chainCommands(undoMarkdownInputRule, deleteSelection, liftAtItemStart, joinBackward, selectNodeBackward),
	Delete: chainCommands(deleteSelection, joinForward, selectNodeForward),
	Tab: chainCommands(sinkListItem(listItem), goToNextCell(1), swallow),
	'Shift-Tab': chainCommands(liftListItem(listItem), goToNextCell(-1), swallow),
	// 入力規則の直後の Command + Z は記号の文字に戻す(2 回目は普通の undo=契約11)
	'Mod-z': chainCommands(undoMarkdownInputRule, undo),
	'Shift-Mod-z': redo,
};
