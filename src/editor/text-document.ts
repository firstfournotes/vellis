/**
 * コードのファイルと plain text の文書モデル(要件#74 契約2・15・契約19 の「第1段の作り」3)。
 *
 * 文書は CodeMirror の `EditorState`(履歴を含む)で持つ。CodeMirror は既定で `\r\n`・`\r`・`\n` を
 * どれも 1 つの改行として読み、取り出すときは `\n` で繋ぐ(`EditorState.lineSeparator` なし)。それでは
 * CRLF・CR・混在の文書が保存で LF になる(契約15 が禁じる形)ので、次の作りで原文の byte を保つ
 * (周回0 の 0-3 の案 C・2026-11-16 由谷決定):
 *
 * - 改行は既定のまま全部で割る(表示は今の閲覧と同じ=どの改行も行の区切り)
 * - 文書の主たる改行(`detectLineEnding` の `dominant`)と違う改行だけを、その改行の位置の印として
 *   `StateField` に持つ。打鍵・貼り付けで印が動き、改行を消せば印も消える
 * - 消した印は `invertedEffects` で履歴に積む(積まないと undo で戻った改行が主たる改行になる=実測)
 * - 取り出すときは印のある改行をその綴りで、ほかを主たる改行で繋ぐ(新しく入れた改行は主たる改行)
 *
 * BOM(U+FEFF)は文書の中の 1 文字として持つ(受け入れテストが行の長さ・位置に BOM を含めて固定して
 * いるため=案 C の「BOM は文書の外」とは違う。打鍵で壊さない守りは面の側=`bomGuard`)。
 *
 * DOM を使わない(`@codemirror/state` と `@codemirror/commands` の履歴だけ)。
 */
import {
	EditorSelection,
	EditorState,
	Facet,
	StateEffect,
	StateField,
	type ChangeDesc,
	type Extension,
	type Transaction,
} from '@codemirror/state';
import { history, invertedEffects } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';

import { contentHash, isDirty } from '$lib/document-edit';

export type LineEnding = '\n' | '\r\n' | '\r';

export interface TextDocument {
	readonly uri: string;
	readonly readOnly: boolean;
	/** CodeMirror の文書(履歴の拡張を含む)。 */
	readonly state: EditorState;
	/** 基準の版(最後にディスクと揃えた文字列)。 */
	readonly base: string;
	/** contentHash(base)(保存の照合に渡す `expectedHash`=契約14)。 */
	readonly baseHash: string;
	readonly lineEnding: { dominant: LineEnding; mixed: boolean };
	readonly indentUnit: string;
}

// ---------------------------------------------------------------------------
// 改行コードと字下げの検出(純関数)
// ---------------------------------------------------------------------------

/** 改行コードの検出。数が同じなら '\n'。1 つも無ければ { dominant: '\n', mixed: false }。 */
export function detectLineEnding(content: string): { dominant: LineEnding; mixed: boolean } {
	let lf = 0;
	let crlf = 0;
	let cr = 0;
	for (let i = 0; i < content.length; i++) {
		const c = content.charCodeAt(i);
		if (c === 13) {
			if (content.charCodeAt(i + 1) === 10) {
				crlf++;
				i++;
			} else cr++;
		} else if (c === 10) lf++;
	}
	const kinds = (lf > 0 ? 1 : 0) + (crlf > 0 ? 1 : 0) + (cr > 0 ? 1 : 0);
	const max = Math.max(lf, crlf, cr);
	let dominant: LineEnding = '\n';
	const leaders = [lf === max, crlf === max, cr === max].filter(Boolean).length;
	if (max > 0 && leaders === 1) dominant = crlf === max ? '\r\n' : cr === max ? '\r' : '\n';
	return { dominant, mixed: kinds >= 2 };
}

/** 字下げの単位を決める空白の数の上限(これより深い差は単位と見ない)。 */
const MAX_SPACE_UNIT = 8;

/**
 * 字下げの単位(行頭の字下げから。タブか空白 N 個。決められなければ '\t')。
 *
 * タブで始まる行と空白で始まる行を数えて多いほう(同じならタブ)。空白なら、字下げの深さが前の
 * 字下げのある行から変わった幅のうち最も多いもの(同じなら小さいほう)を単位にする。
 */
export function detectIndentUnit(content: string): string {
	let tabLines = 0;
	let spaceLines = 0;
	const steps = new Map<number, number>();
	let previous = 0;
	for (const line of content.split(/\r\n?|\n/)) {
		if (line.trim().length === 0) continue;
		const lead = /^[ \t]*/.exec(line)![0];
		if (lead.startsWith('\t')) {
			tabLines++;
			continue;
		}
		const width = lead.length;
		if (width > 0) spaceLines++;
		const step = Math.abs(width - previous);
		if (step > 0 && step <= MAX_SPACE_UNIT && (width > 0 || previous > 0)) {
			steps.set(step, (steps.get(step) ?? 0) + 1);
		}
		previous = width;
	}
	if (spaceLines === 0 || tabLines >= spaceLines) return '\t';
	let best = 0;
	let bestCount = 0;
	for (const [step, count] of steps) {
		if (count > bestCount || (count === bestCount && step < best)) {
			best = step;
			bestCount = count;
		}
	}
	return best > 0 ? ' '.repeat(best) : '\t';
}

// ---------------------------------------------------------------------------
// 改行の印(主たる改行と違う改行の位置)
// ---------------------------------------------------------------------------

/** 改行の印 1 つ。`pos` は CodeMirror の文書の中の、その改行の位置(行の `to`)。 */
export interface LineBreakMark {
	readonly pos: number;
	readonly text: LineEnding;
}

/** 文書の主たる改行(取り出しで印の無い改行に使う)。 */
const dominantFacet = Facet.define<LineEnding, LineEnding>({
	combine: (values) => values[0] ?? '\n',
});

function mapMarks(marks: readonly LineBreakMark[], changes: ChangeDesc): LineBreakMark[] {
	if (marks.length === 0 || changes.empty) return marks as LineBreakMark[];
	const deleted: Array<[number, number]> = [];
	changes.iterChangedRanges((fromA, toA) => {
		if (toA > fromA) deleted.push([fromA, toA]);
	});
	const out: LineBreakMark[] = [];
	for (const mark of marks) {
		// 改行の文字 [pos, pos + 1) が消されたら印も消える。
		if (deleted.some(([from, to]) => from <= mark.pos && to >= mark.pos + 1)) continue;
		out.push({ pos: changes.mapPos(mark.pos, 1), text: mark.text });
	}
	return out;
}

function sortMarks(marks: LineBreakMark[]): LineBreakMark[] {
	return marks.sort((a, b) => a.pos - b.pos);
}

/** 消した印を戻す(undo の取引に積まれる)。位置は取引の後の文書のもの。 */
const restoreMarks = StateEffect.define<readonly LineBreakMark[]>({
	map: (marks, mapping) => mapMarks(marks, mapping),
});

/** 印をまるごと差し替える(外部変更の取り込み・読み直し)。位置は取引の後の文書のもの。 */
export const replaceLineBreakMarks = StateEffect.define<readonly LineBreakMark[]>({
	map: (marks, mapping) => mapMarks(marks, mapping),
});

const marksField = StateField.define<readonly LineBreakMark[]>({
	create: () => [],
	update(marks, tr) {
		let next = mapMarks(marks, tr.changes);
		for (const effect of tr.effects) {
			if (effect.is(replaceLineBreakMarks)) next = [...effect.value];
			else if (effect.is(restoreMarks)) {
				const known = new Set(next.map((m) => m.pos));
				next = sortMarks([...next, ...effect.value.filter((m) => !known.has(m.pos))]);
			}
		}
		return next;
	},
});

/** 取引が消す印を、undo のときに戻す効果として返す。 */
const invertMarks = invertedEffects.of((tr: Transaction) => {
	const marks = tr.startState.field(marksField, false);
	if (!marks || marks.length === 0 || tr.changes.empty) return [];
	const removed: LineBreakMark[] = [];
	tr.changes.iterChangedRanges((fromA, toA) => {
		for (const mark of marks) {
			if (fromA <= mark.pos && toA >= mark.pos + 1) removed.push(mark);
		}
	});
	return removed.length > 0 ? [restoreMarks.of(removed)] : [];
});

/** 原文から、主たる改行と違う改行の印を作る(CodeMirror の文書の位置で)。 */
export function lineBreakMarksOf(content: string, dominant: LineEnding): LineBreakMark[] {
	const marks: LineBreakMark[] = [];
	let removed = 0; // CRLF を 1 文字に数えるので、原文の位置から引く量
	for (let i = 0; i < content.length; i++) {
		const c = content.charCodeAt(i);
		let text: LineEnding | null = null;
		if (c === 13) {
			if (content.charCodeAt(i + 1) === 10) text = '\r\n';
			else text = '\r';
		} else if (c === 10) text = '\n';
		if (text === null) continue;
		if (text !== dominant) marks.push({ pos: i - removed, text });
		if (text === '\r\n') {
			removed++;
			i++;
		}
	}
	return marks;
}

/**
 * 文書の `from`〜`to`(CodeMirror の位置)を原文の綴りで取り出す。印のある改行はその綴り、
 * ほかの改行は主たる改行。
 */
export function sliceStateText(state: EditorState, from = 0, to = state.doc.length): string {
	const dominant = state.facet(dominantFacet);
	const marks = state.field(marksField, false) ?? [];
	if (marks.length === 0) return state.doc.sliceString(from, to, dominant);
	let out = '';
	let at = from;
	for (const mark of marks) {
		if (mark.pos < from) continue;
		if (mark.pos >= to) break;
		out += state.doc.sliceString(at, mark.pos, dominant) + mark.text;
		at = mark.pos + 1;
	}
	return out + state.doc.sliceString(at, to, dominant);
}

/** 文書の主たる改行。 */
export function stateLineEnding(state: EditorState): LineEnding {
	return state.facet(dominantFacet);
}

/**
 * 文書モデルの拡張(履歴・改行の印・主たる改行・字下げの単位・読み取り専用)。面(CodeEditor)は
 * この上に表示の拡張を足す(`StateEffect.appendConfig`)。
 */
function documentExtensions(dominant: LineEnding, unit: string, readOnly: boolean, marks: LineBreakMark[]): Extension {
	return [
		history(),
		dominantFacet.of(dominant),
		marksField.init(() => marks),
		invertMarks,
		indentUnit.of(unit),
		EditorState.tabSize.of(unit === '\t' ? 4 : unit.length),
		EditorState.readOnly.of(readOnly),
	];
}

export function createTextDocument(
	content: string,
	opts: { uri: string; readOnly: boolean; extensions?: Extension },
): TextDocument {
	const lineEnding = detectLineEnding(content);
	const unit = detectIndentUnit(content);
	const state = EditorState.create({
		doc: content,
		selection: EditorSelection.cursor(0),
		extensions: [
			documentExtensions(lineEnding.dominant, unit, opts.readOnly, lineBreakMarksOf(content, lineEnding.dominant)),
			opts.extensions ?? [],
		],
	});
	return {
		uri: opts.uri,
		readOnly: opts.readOnly,
		state,
		base: content,
		baseHash: contentHash(content),
		lineEnding,
		indentUnit: unit,
	};
}

/** 取り出し。原文を byte のまま返す(CRLF・CR・混在・BOM をそのまま)。 */
export function documentText(doc: TextDocument): string {
	return sliceStateText(doc.state);
}

/** 取引を当てた後の文書(state だけ替える・base は変えない)。 */
export function withState(doc: TextDocument, state: EditorState): TextDocument {
	return { ...doc, state };
}

/** dirty = isDirty(documentText(doc), doc.base)(byte 比較)。 */
export function isDocumentDirty(doc: TextDocument): boolean {
	return isDirty(documentText(doc), doc.base);
}

/**
 * 今の文書を `target`(原文の綴りの文字列)にする取引の中身。変わった範囲だけを 1 つの変更で
 * 置き換え(選択とスクロールは写像で保たれる)、改行の印は `target` のものに差し替える。
 * 呼び手が `addToHistory: false` を付けて当てる(外部変更は履歴に積まない=契約11)。
 */
export function replaceWith(state: EditorState, target: string) {
	const dominant = state.facet(dominantFacet);
	const current = state.doc.toString();
	const next = target.split(/\r\n?|\n/).join('\n');
	let prefix = 0;
	const max = Math.min(current.length, next.length);
	while (prefix < max && current.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
	let suffix = 0;
	while (
		suffix < max - prefix &&
		current.charCodeAt(current.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
	) {
		suffix++;
	}
	// サロゲート対の間で切らない。
	if (prefix > 0 && isLowSurrogate(next.charCodeAt(prefix))) prefix--;
	if (suffix > 0 && isLowSurrogate(next.charCodeAt(next.length - suffix))) suffix--;
	const changes =
		current === next
			? []
			: [{ from: prefix, to: current.length - suffix, insert: next.slice(prefix, next.length - suffix) }];
	return {
		changes,
		effects: replaceLineBreakMarks.of(lineBreakMarksOf(target, dominant)),
	};
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}
