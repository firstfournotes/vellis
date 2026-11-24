import { NodeSelection, Plugin, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { isHistoryTransaction } from 'prosemirror-history';
import { FROM_SOURCE_META } from './markdown-document';
import { undoMarkdownInputRule } from './input-rules';

/**
 * front matter の守り(要件#74 契約7・AC-74-6・AC-74-35・事後確認 (19)(20))。front matter は編集面では札で、中も打てず消せない
 * (直すのは raw)。
 * - 札を選んで打つ・貼り付け・切り取り・またいだ範囲や全選択からの置き換えで先頭の front_matter が消えたら、同じ取引の続きで
 *   元のノード(同じ Node=書き出しは byte 等価)を文書の先頭に戻す。打った字・貼った字は戻した front matter の後ろに来る
 *   (先頭への挿入で選択は後ろへ写る)
 * - 先頭以外の front_matter は編集面では作らない(貼った切片に入っていたものなど。front matter の無い文書の先頭にも作らない)
 * - 札を選んだ Backspace / Delete と、front matter の直後の文字のブロックの先頭の Backspace は、取引を起こさずに食う
 *   (文書も履歴も変わらない)
 * 原文から作った取引(raw の読み直し・外部の変更=`FROM_SOURCE_META`)と undo / redo は見逃す(raw で front matter を直す/消す経路)。
 */
export function frontMatterGuardPlugin(): Plugin {
	return new Plugin({
		props: {
			handleKeyDown(view, event) {
				if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
				if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
				// 入力規則の直後の Backspace は規則の取り消し(keymap の undoMarkdownInputRule=契約11)に任せる。front matter は消さない
				if (event.key === 'Backspace' && undoMarkdownInputRule(view.state)) return false;
				return wouldDeleteFrontMatter(view.state, event.key === 'Backspace');
			},
		},
		appendTransaction(transactions, oldState, state) {
			if (!transactions.some((tr) => tr.docChanged)) return null;
			if (transactions.some((tr: Transaction) => tr.getMeta(FROM_SOURCE_META) || isHistoryTransaction(tr))) return null;
			const old = oldState.doc.firstChild;
			const keep = old && isFrontMatter(old) ? old : null;
			const first = state.doc.firstChild;
			const keepFirst = keep !== null && first !== null && isFrontMatter(first);
			// 消す front_matter(先頭に残すもの以外。入れ子も見る)
			const drop: Array<{ pos: number; node: PMNode; parent: PMNode }> = [];
			state.doc.descendants((node, pos, parent) => {
				if (!isFrontMatter(node)) return !node.isTextblock;
				if (!(keepFirst && pos === 0)) drop.push({ pos, node, parent: parent! });
				return false;
			});
			if (drop.length === 0 && (keep === null || keepFirst)) return null;
			const tr = state.tr;
			for (const { pos, node, parent } of drop.reverse()) {
				// 親の中身がそれだけなら空の段落に替える(親の中身の決まり=block+ を崩さない)
				if (parent.childCount === 1 && parent !== state.doc) tr.replaceWith(pos, pos + node.nodeSize, state.schema.nodes.paragraph!.create());
				else if (parent === state.doc && state.doc.childCount === 1) tr.replaceWith(pos, pos + node.nodeSize, state.schema.nodes.paragraph!.create());
				else tr.delete(pos, pos + node.nodeSize);
			}
			if (keep && !keepFirst) tr.insert(0, keep);
			return tr;
		},
	});
}

function isFrontMatter(node: PMNode): boolean {
	return node.type.name === 'front_matter';
}

/** Backspace / Delete が先頭の front matter を消すか(札が選ばれている・直後の文字のブロックの先頭で Backspace)。 */
function wouldDeleteFrontMatter(state: EditorState, backward: boolean): boolean {
	const first = state.doc.firstChild;
	if (!first || !isFrontMatter(first)) return false;
	const sel = state.selection;
	if (sel instanceof NodeSelection) return sel.from === 0 && sel.node === first;
	if (!backward || !(sel instanceof TextSelection) || !sel.empty) return false;
	const $head = sel.$head;
	// 空の文字のブロックなら既定の Backspace(そのブロックを消して札を選ぶ=front matter は消えない)に任せる
	return $head.depth === 1 && $head.parentOffset === 0 && $head.index(0) === 1 && $head.parent.content.size > 0;
}
