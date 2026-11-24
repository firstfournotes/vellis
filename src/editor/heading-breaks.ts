import { Plugin, type Transaction } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';

/**
 * 見出しの中の hard_break を soft_break(raw 既定)に替える plugin(要件74 締め 5 周目 P2-a)。
 * 見出しに hard_break が入る経路(Backspace・Delete でつなぐ・`### ` の入力規則・ProseMirror の切片を貼る・
 * Markdown として貼る・見出しのコマンド)を、取引の後の 1 か所で塞ぐ。ATX の見出しは 1 行なので、
 * 中の hard_break は書けない(書くと見出しが割れる)。
 * setext の見出しは hard_break を書ける(複数行)ので替えない(読み込みの後に別の所を打っても変わらない)。
 * 替える取引は履歴に積む(既定=元の取引と同じ段にまとまる。undo で元の取引ごと戻る)。
 */
export function headingSoftBreakPlugin(): Plugin {
	return new Plugin({
		appendTransaction(transactions, _oldState, state) {
			if (!transactions.some((tr) => tr.docChanged)) return null;
			const softBreak = state.schema.nodes.soft_break;
			if (!softBreak) return null;
			const breaks: number[] = [];
			state.doc.descendants((node: PMNode, pos: number) => {
				if (node.type.name === 'heading') {
					// setext の見出しは hard_break を書ける(複数行)ので替えない(ATX の見出しに入ったものだけ替える)
					if (node.attrs.setext) return false;
					node.forEach((child, offset) => {
						if (child.type.name === 'hard_break') breaks.push(pos + 1 + offset);
					});
					return false;
				}
				// 文字のブロックの中(見出し以外)は見ない
				return !node.isTextblock;
			});
			if (breaks.length === 0) return null;
			let tr: Transaction = state.tr;
			for (const at of breaks.reverse()) tr = tr.replaceWith(at, at + 1, softBreak.create());
			return tr;
		},
	});
}
