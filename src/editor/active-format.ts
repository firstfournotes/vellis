/**
 * 今の装飾(要件#74 第3段 3-4・右クリックの Format ▸ のチェック。第4段のツールバーの押下と共有する純関数)。
 *
 * - mark(Bold / Italic / Strikethrough / Inline Code): 範囲の選択なら、その中の文字が全部その mark を持つとき。
 *   空の選択なら stored mark(あれば)か、カーソルの位置の mark
 * - 段落の種類(Body Text / Heading 1〜6 / Code Block): カーソル($from)のある文字のブロックの種類。表のセルの中は無し
 * - リスト(Bulleted / Numbered / Task)・Quote・Alert: 祖先。タスクの項目(checked が null でない)の中は Task List
 */
import type { EditorState } from 'prosemirror-state';
import type { MarkType } from 'prosemirror-model';
import type { FormatItemId } from './commands';
import { markdownSchema as schema } from './markdown-schema';

export type ActiveFormat = ReadonlySet<FormatItemId>;

const nodes = schema.nodes;
const marks = schema.marks;

const MARK_ITEMS: Array<[FormatItemId, MarkType]> = [
	['format-bold', marks.strong!],
	['format-italic', marks.em!],
	['format-strikethrough', marks.strike!],
	['format-inline-code', marks.code!],
];

/** 範囲の中の文字が全部 type の mark を持つか(文字が無ければ偽)。 */
function rangeHasMark(state: EditorState, from: number, to: number, type: MarkType): boolean {
	let seen = false;
	let all = true;
	state.doc.nodesBetween(from, to, (node) => {
		if (!all) return false;
		if (node.isText) {
			seen = true;
			if (!type.isInSet(node.marks)) all = false;
		}
		return true;
	});
	return seen && all;
}

/** 今の選択で「付いている」Format の項目。 */
export function activeFormat(state: EditorState): ActiveFormat {
	const out = new Set<FormatItemId>();
	const { selection } = state;
	const { $from } = selection;

	for (const [id, type] of MARK_ITEMS) {
		const on = selection.empty
			? !!type.isInSet(state.storedMarks ?? $from.marks())
			: rangeHasMark(state, selection.from, selection.to, type);
		if (on) out.add(id);
	}

	const block = $from.parent;
	const inCell = block.type === nodes.table_cell || block.type === nodes.table_header;
	if (!inCell) {
		if (block.type === nodes.paragraph) out.add('format-body-text');
		else if (block.type === nodes.heading) {
			const level = Math.min(6, Math.max(1, Number(block.attrs.level) || 1));
			out.add(`format-heading-${level}` as FormatItemId);
		} else if (block.type === nodes.code_block) out.add('format-code-block');
	}

	for (let d = $from.depth - 1; d > 0; d--) {
		const node = $from.node(d);
		if (node.type === nodes.list_item && node.attrs.checked !== null && node.attrs.checked !== undefined) {
			out.add('format-task-list');
		} else if (node.type === nodes.bullet_list) {
			if (!out.has('format-task-list')) out.add('format-bulleted-list');
		} else if (node.type === nodes.ordered_list) {
			out.add('format-numbered-list');
		} else if (node.type === nodes.blockquote) {
			out.add('format-quote');
		} else if (node.type === nodes.alert) {
			out.add(`format-alert-${String(node.attrs.kind)}` as FormatItemId);
		}
	}
	return out;
}
