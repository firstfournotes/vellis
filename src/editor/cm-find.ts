/**
 * CodeMirror の面の検索(要件#74 契約17・AC-74-31・第2段の作り(案)の項目 15)。第1段のコードの面と raw の面が共有する。
 *
 * - 件数は文書全体の文字列に要件54 の `findMatches` を当てた数(見えている範囲の外を含む)
 * - 一致は CodeMirror の装飾で塗る(現在の一致は別の色)
 */
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

import { findMatches, type MatchRange } from '$lib/find-in-document';

/** 一致と現在の一致を塗り直す効果。 */
export const setFindMarks = StateEffect.define<{ ranges: MatchRange[]; current: number }>();

const findMark = Decoration.mark({ class: 'cm-vellis-find' });
const findCurrentMark = Decoration.mark({ class: 'cm-vellis-find-current' });

/** 一致の装飾(面の拡張に入れる)。 */
export const findField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(marks, tr) {
		let next = marks.map(tr.changes);
		for (const effect of tr.effects) {
			if (!effect.is(setFindMarks)) continue;
			const { ranges, current } = effect.value;
			const length = tr.state.doc.length;
			next = Decoration.set(
				ranges
					.filter((r) => r.end <= length && r.end > r.start)
					.map((r, i) => (i === current ? findCurrentMark : findMark).range(r.start, r.end)),
			);
		}
		return next;
	},
	provide: (field) => EditorView.decorations.from(field),
});

/**
 * 語を文書に当てる(要件54 の `findMatches`)。`toLowerCase` で長さが変わる文字(`İ` など)が文書に
 * あるときだけ、一致の位置を元の文字列の位置へ写し直す(`find-in-document.ts` は直さない)。
 */
export function matchesIn(text: string, query: string): MatchRange[] {
	const found = findMatches(text, query);
	if (found.length === 0) return found;
	const lower = text.toLowerCase();
	if (lower.length === text.length) return found;
	const map = new Int32Array(lower.length + 1);
	let li = 0;
	for (let i = 0; i < text.length; ) {
		const cp = text.codePointAt(i)!;
		const width = cp > 0xffff ? 2 : 1;
		const lowered = String.fromCodePoint(cp).toLowerCase().length;
		for (let j = 0; j < lowered && li + j < map.length; j++) map[li + j] = i;
		li += lowered;
		i += width;
	}
	if (li !== lower.length) return found;
	const endOf = (lowEnd: number) => {
		if (lowEnd <= 0) return 0;
		const at = map[lowEnd - 1]!;
		return at + (text.codePointAt(at)! > 0xffff ? 2 : 1);
	};
	return found.map((r) => ({ start: map[r.start]!, end: endOf(r.end) }));
}
