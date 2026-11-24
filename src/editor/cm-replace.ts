/**
 * CodeMirror の面の置換(要件#74 第3段 3-3・契約5 の (x)・由谷の決定 3-11・3-12)。
 *
 * 置換はコードの面・plain text・raw だけ(Markdown の rendered は検索だけ)。語の当て方は検索と同じ(`matchesIn`=大文字小文字を
 * 区別しない・正規表現なし)、置換の語は文字どおり(`$&` も `\n` も文字)。Replace は現在の一致だけ、Replace All は全部を取引 1 つで
 * (undo 1 回で原文)。替えなかった範囲は触らないので、改行の印(CRLF・CR・混在)と BOM はそのまま。
 */
import type { EditorState, TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { MatchRange } from '$lib/find-in-document';
import { matchesIn } from './cm-find';

/** lib.rs が前面の窓へ送るイベント(Edit ▸ Find and Replace…)。menu.rs の `MENU_FIND_REPLACE_EVENT` と同じ綴り。 */
export const MENU_FIND_REPLACE_EVENT = 'menu_find_replace';

/**
 * 現在の一致(ranges[current])を replacement の文字どおりに替える取引 1 つ。選択は替えた文字の後ろ(空)。
 * ranges が空・current が範囲外・読み取り専用なら null。
 */
export function replaceOne(state: EditorState, ranges: readonly MatchRange[], current: number, replacement: string): TransactionSpec | null {
	if (state.readOnly) return null;
	const target = ranges[current];
	if (!target) return null;
	return {
		changes: { from: target.start, to: target.end, insert: replacement },
		selection: { anchor: target.start + replacement.length },
		scrollIntoView: true,
		userEvent: 'input.replace',
	};
}

/** 数え直した ranges のうち、替えた文字の終わり(replacedEnd)以降で最初の一致の番目。無ければ 0(先頭へ回る)。 */
export function nextCurrentAfter(ranges: readonly MatchRange[], replacedEnd: number): number {
	const at = ranges.findIndex((r) => r.start >= replacedEnd);
	return at < 0 ? 0 : at;
}

/** matchesIn(文書, query) の全部を取引 1 つで replacement に替える。count=替えた数。語が空・一致なし・読み取り専用なら spec null・count 0。 */
export function replaceAll(state: EditorState, query: string, replacement: string): { spec: TransactionSpec | null; count: number } {
	if (query.length === 0 || state.readOnly) return { spec: null, count: 0 };
	const ranges = matchesIn(state.doc.toString(), query);
	if (ranges.length === 0) return { spec: null, count: 0 };
	return {
		spec: {
			changes: ranges.map((r) => ({ from: r.start, to: r.end, insert: replacement })),
			userEvent: 'input.replace',
		},
		count: ranges.length,
	};
}

/** 面(コード・plain text・raw)の置換の結果: 数え直した一致と、現在にする番目。 */
export interface ReplaceOutcome {
	ranges: MatchRange[];
	current: number;
	count: number;
}

/**
 * 面の Replace: query の今の一致を数え、current 番目を替える。数え直した一致のうち替えた文字の終わり以降の最初の一致を
 * 現在にして返す(替えた文字の中の一致で止まらない)。語が空・一致なし・読み取り専用なら null(取引なし)。
 */
export function replaceCurrentIn(view: EditorView, query: string, current: number, replacement: string): ReplaceOutcome | null {
	if (query.length === 0) return null;
	const ranges = matchesIn(view.state.doc.toString(), query);
	if (ranges.length === 0) return null;
	const at = Math.min(Math.max(0, current), ranges.length - 1);
	const spec = replaceOne(view.state, ranges, at, replacement);
	if (!spec) return null;
	const end = ranges[at]!.start + replacement.length;
	view.dispatch(spec);
	const next = matchesIn(view.state.doc.toString(), query);
	return { ranges: next, current: nextCurrentAfter(next, end), count: 1 };
}

/** 面の Replace All(取引 1 つ)。替えたら数え直した一致(現在は先頭)を返す。替えなければ null。 */
export function replaceAllIn(view: EditorView, query: string, replacement: string): ReplaceOutcome | null {
	const { spec, count } = replaceAll(view.state, query, replacement);
	if (!spec) return null;
	view.dispatch(spec);
	return { ranges: matchesIn(view.state.doc.toString(), query), current: 0, count };
}
