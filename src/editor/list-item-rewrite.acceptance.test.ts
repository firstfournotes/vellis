/**
 * 要件#74 第4段 4-4 — リストの項目単位の書き直し(契約6・契約19「3 段目の範囲をリスト全体から項目へ狭める」・由谷の決定 2026-11-17 午後
 * 4-12=順序つきに項目を足しても後ろの番号は振り直さない)。正本: docs/review/req74-stage34-prep.md の (C) 5 と (D) AC-74-64。
 *
 * ## 対応する受け入れ基準(AC-74-64)
 * - 100 項目のリスト(`-` / `*` / `1.` / `1)`・タスク・入れ子・loose / tight・CRLF)で、項目 50 に太字を付けると書き出しの差は項目 50 の行だけ
 * - 項目 50 の後ろに項目を足すと差は足した行だけ(順序つきは前の番号+1・後ろの項目は byte のまま=4-12)
 * - 項目を消すと差は消した行だけ。どれも読み直して shapeEqual
 * - リストの形が変わる操作(入れ子にする・リストの種類を替える)は今の 3 段目(リスト全体)で、外は byte 等価
 *
 * ## 確定契約(implementer はこれに従う=推奨は stage34-prep の (C) 5。外から見える約束は書き出しの差だけ)
 * - 書き出しの 3 段目で、リストの形(項目の数・入れ子・tight / loose)が読んだときと同じ、または項目の足し引きだけなら、触っていない項目は切片を byte のまま、
 *   触った項目だけをその項目の印の綴り(`-` / `*` / `1.` / `1)`・印の後ろの空白の数・字下げ)で書き直す。足した項目は前の項目の印の綴り(順序つきは前の番号+1。
 *   後ろの項目の番号は振り直さない)。消した項目はその行(loose なら続く空行も)だけが消える
 * - 入れ子は内側の項目まで同じ規則(いちばん内側の触った項目だけ)。前後とリスト全体を読み直して shapeEqual でなければ今の 3 段目(リスト全体)に落ちる
 * - 作りの推奨(`list_item` にも bid・origin に項目の切片)は実装裁量。`markdownText` の結果と `lineDiff` で判定する
 *
 * ## 修正前に赤になる理由(2026-11-17 の実測)
 * - 順序つき(`1.` / `1)`)に項目を足す・消すと、後ろの項目の番号がすべて振り直される(mdast-util-to-markdown の incrementListMarker=リスト全体の 3 段目)。
 *   4-12 の決定(後ろは振り直さない)と AC-74-64 の「差は足した / 消した行だけ」に反する
 * - 箇条書き・タスク・loose・CRLF・入れ子は今のリスト全体の書き直しでも同じ行になり、既に緑(後追いの固定=項目単位の書き直しに替えても緑を保つ)
 * - タスクのリストで足した項目の綴り(`- new` か `- [ ] new`)は決定に無いので、どちらも受ける
 */
import { describe, expect, test } from 'vitest';
import { TextSelection, type EditorState } from 'prosemirror-state';
import { sinkListItem } from 'prosemirror-schema-list';
import { createMarkdownDocument, markdownText, withState, type MarkdownDocument } from './markdown-document';
import { markdownSchema } from './markdown-schema';
import { MARKDOWN_KEYMAP } from './markdown-keymap';
import { FORMAT_COMMANDS, runFormatCommand } from './commands';
import { serializeMarkdown, shapeEqual } from './to-markdown';
import { undo, undoDepth } from 'prosemirror-history';
import { lineDiff, type DiffHunk } from './line-diff';

const URI = 'file:///Users/a/notes/list.md';
const N = 100;
type Variant = '-' | '*' | '1.' | '1)' | 'task' | 'loose' | 'crlf';

function marker(variant: Variant, i: number): string {
	switch (variant) {
		case '-':
		case 'loose':
		case 'crlf':
			return '-';
		case '*':
			return '*';
		case '1.':
			return `${i}.`;
		case '1)':
			return `${i})`;
		case 'task':
			return '- [ ]';
	}
}
/** intro / 100 項目のリスト / after。 */
function listDoc(variant: Variant): string {
	const eol = variant === 'crlf' ? '\r\n' : '\n';
	const items: string[] = [];
	for (let i = 1; i <= N; i++) items.push(`${marker(variant, i)} item ${i}`);
	const body = items.join(variant === 'loose' ? eol + eol : eol);
	return `intro${eol}${eol}${body}${eol}${eol}after${eol}`;
}
function open(src: string): MarkdownDocument {
	return createMarkdownDocument(src, { uri: URI, readOnly: false });
}
/** 文書の中の text `needle` の位置(先頭)。 */
function posOf(state: EditorState, needle: string): number {
	let found = -1;
	state.doc.descendants((n, pos) => {
		if (found >= 0) return false;
		if (n.isText && n.text === needle) found = pos;
		return found < 0;
	});
	if (found < 0) throw new Error(`'${needle}' が無い`);
	return found;
}
function apply(doc: MarkdownDocument, state: EditorState, build: (tr: import('prosemirror-state').Transaction) => import('prosemirror-state').Transaction): EditorState {
	void doc;
	return state.apply(build(state.tr));
}
function run(state: EditorState, cmd: (s: EditorState, d?: (tr: import('prosemirror-state').Transaction) => void) => boolean): EditorState {
	let next = state;
	const ok = cmd(state, (tr) => (next = state.apply(tr)));
	expect(ok, 'command ran').toBe(true);
	return next;
}
function text(doc: MarkdownDocument, state: EditorState): string {
	return markdownText(withState(doc, state));
}
function expectReparsesSame(out: string, state: EditorState) {
	const back = open(out).state.doc;
	expect(back.childCount, '最上位ブロックの数').toBe(state.doc.childCount);
	for (let i = 0; i < state.doc.childCount; i++) expect(shapeEqual(back.child(i), state.doc.child(i)), `ブロック ${i} の形`).toBe(true);
}
function hunksOf(a: string, b: string): DiffHunk[] {
	const h = lineDiff(a, b);
	expect(h, 'lineDiff').not.toBeNull();
	return h!;
}
const strip = (l: string) => l.replace(/\r\n$|\r$|\n$/, '');
function boldItem(doc: MarkdownDocument, needle: string): EditorState {
	const pos = posOf(doc.state, needle);
	const selected = apply(doc, doc.state, (tr) => tr.setSelection(TextSelection.create(tr.doc, pos, pos + needle.length)));
	return run(selected, FORMAT_COMMANDS['format-bold']);
}
/** 項目(needle を含む段落を持つ list_item)の終わりで Enter → 新しい項目に 'new' を打つ。 */
function addItemAfter(doc: MarkdownDocument, needle: string): EditorState {
	const pos = posOf(doc.state, needle);
	const atEnd = apply(doc, doc.state, (tr) => tr.setSelection(TextSelection.create(tr.doc, pos + needle.length)));
	const split = run(atEnd, MARKDOWN_KEYMAP.Enter!);
	return split.apply(split.tr.insertText('new'));
}
/** needle を含む list_item を丸ごと消す。 */
function deleteItem(doc: MarkdownDocument, needle: string): EditorState {
	const pos = posOf(doc.state, needle);
	const $pos = doc.state.doc.resolve(pos);
	let depth = $pos.depth;
	while (depth > 0 && $pos.node(depth).type !== markdownSchema.nodes.list_item) depth--;
	expect(depth).toBeGreaterThan(0);
	const from = $pos.before(depth);
	const to = $pos.after(depth);
	return doc.state.apply(doc.state.tr.delete(from, to));
}
const VARIANTS: Variant[] = ['-', '*', '1.', '1)', 'task', 'loose', 'crlf'];
const eolOf = (v: Variant) => (v === 'crlf' ? '\r\n' : '\n');

describe('AC-74-64: 項目 50 に太字 → 書き出しの差は項目 50 の行だけ(100 項目・7 変種)', () => {
	test.each(VARIANTS)('%s のリスト', (variant) => {
		const src = listDoc(variant);
		const doc = open(src);
		const state = boldItem(doc, 'item 50');
		const out = text(doc, state);
		const hunks = hunksOf(src, out);
		expect(hunks).toHaveLength(1);
		const [h] = hunks;
		expect(h!.aLines.map(strip)).toEqual([`${marker(variant, 50)} item 50`]);
		expect(h!.bLines.map(strip)).toEqual([`${marker(variant, 50)} **item 50**`]);
		expect(h!.aLines[0]!.endsWith(eolOf(variant)), '改行コードは元のまま').toBe(true);
		expect(h!.bLines[0]!.endsWith(eolOf(variant))).toBe(true);
		expect(out.startsWith(`intro${eolOf(variant)}${eolOf(variant)}`)).toBe(true);
		expect(out.endsWith(`${eolOf(variant)}${eolOf(variant)}after${eolOf(variant)}`)).toBe(true);
		expectReparsesSame(out, state);
	});

	test('項目 1(先頭)と項目 100(末尾)でも、その行だけ', () => {
		for (const needle of ['item 1', 'item 100']) {
			const src = listDoc('-');
			const doc = open(src);
			const state = boldItem(doc, needle);
			const hunks = hunksOf(src, text(doc, state));
			expect(hunks, needle).toHaveLength(1);
			expect(hunks[0]!.aLines.map(strip), needle).toEqual([`- ${needle}`]);
			expect(hunks[0]!.bLines.map(strip), needle).toEqual([`- **${needle}**`]);
		}
	});
});

describe('AC-74-64: 項目 50 の後ろに項目を足す → 差は足した行だけ(順序つきは前の番号+1・後ろは振り直さない=4-12)', () => {
	test.each(VARIANTS)('%s のリスト', (variant) => {
		const src = listDoc(variant);
		const doc = open(src);
		const state = addItemAfter(doc, 'item 50');
		const out = text(doc, state);
		const hunks = hunksOf(src, out);
		expect(hunks).toHaveLength(1);
		const [h] = hunks;
		expect(h!.aLines, '消える行は無い').toEqual([]);
		const added = h!.bLines.map(strip).filter((l) => l !== '');
		const expectedMarker = variant === '1.' ? '51.' : variant === '1)' ? '51)' : variant === '*' ? '*' : '-';
		if (variant === 'task') {
			// タスクの項目の後ろに足した項目が [ ] を持つかは決定に無い(前の項目の印の綴り=`-`。[ ] は中身)。どちらも受ける
			expect(added).toHaveLength(1);
			expect(['- new', '- [ ] new']).toContain(added[0]);
		} else {
			expect(added, '足した行は 1 行(loose は空行を伴ってよい)').toEqual([`${expectedMarker} new`]);
		}
		if (variant !== 'loose') expect(h!.bLines).toHaveLength(1);
		expect(h!.bLines[0]!.endsWith(eolOf(variant)), '改行コードは文書のもの').toBe(true);
		// 後ろの項目は byte のまま(順序つきの番号も)
		expect(out).toContain(`${marker(variant, 51)} item 51${eolOf(variant)}`);
		expect(out).toContain(`${marker(variant, 100)} item 100${eolOf(variant)}`);
		expectReparsesSame(out, state);
	});

	test('順序つき(1.)で足した項目は 51.、その後ろの 51. item 51 … 100. item 100 は 1 文字も変わらない', () => {
		const src = listDoc('1.');
		const doc = open(src);
		const out = text(doc, addItemAfter(doc, 'item 50'));
		const tail = src.slice(src.indexOf('51. item 51'));
		expect(out.endsWith(tail), '項目 51 以降は byte 等価').toBe(true);
		expect(out).toContain('50. item 50\n51. new\n51. item 51\n');
	});
});

describe('AC-74-64: 項目を消す → 差は消した行だけ', () => {
	test.each(VARIANTS)('%s のリスト', (variant) => {
		const src = listDoc(variant);
		const doc = open(src);
		const state = deleteItem(doc, 'item 50');
		const out = text(doc, state);
		const hunks = hunksOf(src, out);
		expect(hunks).toHaveLength(1);
		const [h] = hunks;
		expect(h!.bLines, '足される行は無い').toEqual([]);
		const removed = h!.aLines.map(strip).filter((l) => l !== '');
		expect(removed).toEqual([`${marker(variant, 50)} item 50`]);
		if (variant !== 'loose') expect(h!.aLines).toHaveLength(1);
		expect(out).toContain(`${marker(variant, 49)} item 49${eolOf(variant)}`);
		expect(out).toContain(`${marker(variant, 51)} item 51${eolOf(variant)}`);
		expectReparsesSame(out, state);
	});
});

describe('AC-74-64: 入れ子は内側の項目まで同じ規則', () => {
	const NESTED = (() => {
		const items: string[] = [];
		for (let i = 1; i <= N; i++) {
			items.push(`- item ${i}`);
			if (i === 50) items.push('  - sub 1', '  - sub 2', '  - sub 3');
		}
		return `intro\n\n${items.join('\n')}\n\nafter\n`;
	})();

	test('項目 50 の中の sub 2 に太字 → 差は sub 2 の行だけ(字下げも印もそのまま)', () => {
		const doc = open(NESTED);
		const state = boldItem(doc, 'sub 2');
		const out = text(doc, state);
		const hunks = hunksOf(NESTED, out);
		expect(hunks).toHaveLength(1);
		expect(hunks[0]!.aLines).toEqual(['  - sub 2\n']);
		expect(hunks[0]!.bLines).toEqual(['  - **sub 2**\n']);
		expectReparsesSame(out, state);
	});

	test('項目 50 の自身の文字に太字 → 差は item 50 の行だけ(入れ子の sub 1〜3 は byte のまま)', () => {
		const doc = open(NESTED);
		const state = boldItem(doc, 'item 50');
		const out = text(doc, state);
		const hunks = hunksOf(NESTED, out);
		expect(hunks).toHaveLength(1);
		expect(hunks[0]!.aLines).toEqual(['- item 50\n']);
		expect(hunks[0]!.bLines).toEqual(['- **item 50**\n']);
		expect(out).toContain('- **item 50**\n  - sub 1\n  - sub 2\n  - sub 3\n- item 51\n');
	});

	test('sub 2 の後ろに項目を足す → 差は足した行だけ(字下げと印は sub の綴り)', () => {
		const doc = open(NESTED);
		const state = addItemAfter(doc, 'sub 2');
		const out = text(doc, state);
		const hunks = hunksOf(NESTED, out);
		expect(hunks).toHaveLength(1);
		expect(hunks[0]!.aLines).toEqual([]);
		expect(hunks[0]!.bLines).toEqual(['  - new\n']);
		expect(out).toContain('  - sub 2\n  - new\n  - sub 3\n');
		expectReparsesSame(out, state);
	});
});

describe('AC-74-64: リストの形が変わる操作は今の 3 段目(リスト全体)で、外は byte 等価', () => {
	test('項目 50 を入れ子にする(sinkListItem)→ 読み直して同じ形・リストの外(intro / after)は byte 等価', () => {
		const src = listDoc('*');
		const doc = open(src);
		const pos = posOf(doc.state, 'item 50');
		const selected = apply(doc, doc.state, (tr) => tr.setSelection(TextSelection.create(tr.doc, pos)));
		const state = run(selected, sinkListItem(markdownSchema.nodes.list_item!));
		const out = text(doc, state);
		expect(out.startsWith('intro\n\n')).toBe(true);
		expect(out.endsWith('\n\nafter\n')).toBe(true);
		expect(out).toMatch(/\n\s+[*-] item 50\n/);
		expectReparsesSame(out, state);
	});

	test('リストの種類を替える(Numbered List)→ 読み直して同じ形・外は byte 等価', () => {
		const src = listDoc('-');
		const doc = open(src);
		const pos = posOf(doc.state, 'item 50');
		const selected = apply(doc, doc.state, (tr) => tr.setSelection(TextSelection.create(tr.doc, pos)));
		const state = run(selected, FORMAT_COMMANDS['format-numbered-list']);
		const out = text(doc, state);
		expect(out.startsWith('intro\n\n')).toBe(true);
		expect(out.endsWith('\n\nafter\n')).toBe(true);
		expect(out).toContain('1. item 1\n');
		expectReparsesSame(out, state);
	});
});

// ---------------------------------------------------------------------------
// 4-4 の照合(reviewer 2026-11-17・CHANGES REQUESTED)で足した変種: 触っていない項目に規範的でない綴り(mdast-util-to-markdown が
// 書き直すと変わる綴り)を含むリストで、ほかの項目を直しても触っていない行が byte のまま(差は直した行だけ)。
// ---------------------------------------------------------------------------

describe('AC-74-64(変種): 触っていない項目の規範的でない綴りは byte のまま(差は直した行だけ)', () => {
	const CASES: Array<[string, string, string, string]> = [
		// [名前, 原文, 太字にする文字, 期待する差の行(after)]
		['_x_ の強調を持つ項目が隣にある', '- one _x_ here\n- two\n- three _y_\n', 'two', '- **two**'],
		['`*` と snake_case を持つ項目が隣にある', '- a * b\n- two\n- snake_case_name and 2 * 3\n', 'two', '- **two**'],
		['4 空白の字下げの入れ子(4 番目=two)', '- one\n    - sub a\n    - sub b\n- two\n- three\n', 'two', '- **two**'],
		['~x~(波 1 つ)の取り消し線が隣にある', '- one ~x~\n- two\n- three\n', 'two', '- **two**'],
		['番号が全部 1. の順序つき(番号も byte のまま)', '1. one\n1. two\n1. three\n', 'two', '1. **two**'],
		['印の後ろの空白が 3 つ', '-   one\n-   two\n-   three\n', 'two', '-   **two**'],
		['`*` の印と 2 空白の字下げの入れ子', '* one\n  * sub a\n* two\n', 'two', '* **two**'],
		['loose な入れ子を持つ項目が隣にある', '- one\n\n    - sub a\n\n- two\n- three\n', 'two', '- **two**'],
	];
	test.each(CASES)('%s', (_name, src, needle, expectedAfter) => {
		const doc = open(`intro\n\n${src}\nafter\n`);
		const state = boldItem(doc, needle);
		const out = text(doc, state);
		const hunks = hunksOf(`intro\n\n${src}\nafter\n`, out);
		expect(hunks, `差は 1 塊: ${JSON.stringify(out)}`).toHaveLength(1);
		const [h] = hunks;
		expect(h!.aLines.map(strip)).toEqual([expectedAfter.replace('**', '').replace('**', '')]);
		expect(h!.bLines.map(strip)).toEqual([expectedAfter]);
		expectReparsesSame(out, state);
	});

	test('4 空白の入れ子の中の sub b に太字 → その行だけ(字下げ 4 空白のまま)', () => {
		const src = 'intro\n\n- one\n    - sub a\n    - sub b\n- two\n\nafter\n';
		const doc = open(src);
		const state = boldItem(doc, 'sub b');
		const out = text(doc, state);
		const hunks = hunksOf(src, out);
		expect(hunks).toHaveLength(1);
		expect(hunks[0]!.aLines).toEqual(['    - sub b\n']);
		expect(hunks[0]!.bLines).toEqual(['    - **sub b**\n']);
		expectReparsesSame(out, state);
	});

	test('番号が全部 1. の順序つきに項目を足す → 足した行(2.)だけ・後ろの 1. は byte のまま', () => {
		const src = 'intro\n\n1. one\n1. two\n1. three\n\nafter\n';
		const doc = open(src);
		const state = addItemAfter(doc, 'one');
		const out = text(doc, state);
		const hunks = hunksOf(src, out);
		expect(hunks).toHaveLength(1);
		expect(hunks[0]!.aLines).toEqual([]);
		expect(hunks[0]!.bLines.map(strip)).toEqual(['2. new']);
		expect(out).toContain('1. one\n2. new\n1. two\n1. three\n');
	});
});

// ---------------------------------------------------------------------------
// 4-4 の当て直し(reviewer 2026-11-17): リストの中の項目 / ブロックを消しても、前後の触っていない項目は byte のまま(差は消した行だけ=塊 1 つ・削除のみ)。
// P3 の M6(印の後ろの空白が多い項目の継続行の字下げ)・M7(2 段落の項目で 1 段落だけ直す)。
// ---------------------------------------------------------------------------

describe('AC-74-64(当て直し): 中の項目とブロックを消す → 差は消した行だけ(前後の規範的でない綴りは byte のまま)', () => {
	/** needle を含むブロック(段落)を丸ごと消す。 */
	function deleteBlockOf(doc: MarkdownDocument, needle: string): EditorState {
		const pos = posOf(doc.state, needle);
		const $pos = doc.state.doc.resolve(pos);
		const depth = $pos.depth; // text の親=段落
		return doc.state.apply(doc.state.tr.delete($pos.before(depth), $pos.after(depth)));
	}
	/** needleA を含む項目から needleB を含む項目まで(続く 2 項目)を消す。 */
	function deleteItems(doc: MarkdownDocument, needleA: string, needleB: string): EditorState {
		const itemRange = (needle: string) => {
			const $pos = doc.state.doc.resolve(posOf(doc.state, needle));
			let depth = $pos.depth;
			while (depth > 0 && $pos.node(depth).type !== markdownSchema.nodes.list_item) depth--;
			return { from: $pos.before(depth), to: $pos.after(depth) };
		};
		const a = itemRange(needleA);
		const b = itemRange(needleB);
		return doc.state.apply(doc.state.tr.delete(a.from, b.to));
	}
	/** text ノード nodeText の中の word だけを選んで太字。 */
	function boldWord(doc: MarkdownDocument, nodeText: string, word: string): EditorState {
		const pos = posOf(doc.state, nodeText) + nodeText.indexOf(word);
		const selected = apply(doc, doc.state, (tr) => tr.setSelection(TextSelection.create(tr.doc, pos, pos + word.length)));
		return run(selected, FORMAT_COMMANDS['format-bold']);
	}
	function expectOnlyDeleted(src: string, out: string, removedNonBlank: string[]) {
		const hunks = hunksOf(src, out);
		expect(hunks, `差は 1 塊: ${JSON.stringify(out)}`).toHaveLength(1);
		expect(hunks[0]!.bLines, '足される行は無い').toEqual([]);
		expect(hunks[0]!.aLines.map(strip).filter((l) => l !== '')).toEqual(removedNonBlank);
	}
	const FOUR = 'intro\n\n- one _x_\n- two\n- three _y_\n- four * b\n\nafter\n';

	test('1a: 項目 2(two)を消す → 差は `- two` の行だけ(_x_ / _y_ / `*` の項目は byte のまま)', () => {
		const doc = open(FOUR);
		const state = deleteItem(doc, 'two');
		const out = text(doc, state);
		expectOnlyDeleted(FOUR, out, ['- two']);
		expect(out).toBe('intro\n\n- one _x_\n- three _y_\n- four * b\n\nafter\n');
		expectReparsesSame(out, state);
	});

	test('1b: 項目 2 と 3(two・three)を消す → 差はその 2 行だけ', () => {
		const doc = open(FOUR);
		const state = deleteItems(doc, 'two', 'three ');
		const out = text(doc, state);
		expectOnlyDeleted(FOUR, out, ['- two', '- three _y_']);
		expect(out).toBe('intro\n\n- one _x_\n- four * b\n\nafter\n');
		expectReparsesSame(out, state);
	});

	test('2: 項目 2 の中の 3 ブロックの真ん中(middle para)を消す → 差はその段落(と空行 1 つ)だけ・隣の _x_ / _y_ / `a * b` は byte のまま(流儀は `*` に寄せてあるので 3 段目に落ちれば見える)', () => {
		// P3(reviewer): 流儀が `_` だと 3 段目に落ちても差が出ないので、`*s* *t* *u*` で流儀を `*` に寄せ、落ちたら `_x_` → `*x*`・`a * b` → `a \* b` に変わる形にする
		const src = 'intro\n\n- one *s* *t* *u*\n- two _x_\n\n  middle para\n\n  last para a * b\n- three _y_\n\nafter\n';
		const doc = open(src);
		const item = doc.state.doc.child(1).child(1);
		expect(item.childCount, '項目 2 は 3 ブロック').toBe(3);
		const state = deleteBlockOf(doc, 'middle para');
		const out = text(doc, state);
		expectOnlyDeleted(src, out, ['  middle para']);
		expect(out).toBe('intro\n\n- one *s* *t* *u*\n- two _x_\n\n  last para a * b\n- three _y_\n\nafter\n');
		expectReparsesSame(out, state);
	});

	test('3: 4 空白の入れ子の sub b を消す → 差は `    - sub b` だけ(sub a _s_ / sub c _c_ は字下げ 4 空白のまま)', () => {
		const src = 'intro\n\n- one\n    - sub a _s_\n    - sub b\n    - sub c _c_\n- two\n\nafter\n';
		const doc = open(src);
		const state = deleteItem(doc, 'sub b');
		const out = text(doc, state);
		expectOnlyDeleted(src, out, ['    - sub b']);
		expect(out).toBe('intro\n\n- one\n    - sub a _s_\n    - sub c _c_\n- two\n\nafter\n');
		expectReparsesSame(out, state);
	});

	test('M7: 2 段落の項目で 2 段落目だけ太字 → 差はその行だけ・1 段落目(_x_ と `a * b` を含む)は byte のまま(流儀は `*` に寄せてある)', () => {
		const src = 'intro\n\n- lead *s* *t* *u*\n- first _x_ para a * b\n\n  second para\n- two\n\nafter\n';
		const doc = open(src);
		const state = boldWord(doc, 'second para', 'second');
		const out = text(doc, state);
		const hunks = hunksOf(src, out);
		expect(hunks, JSON.stringify(out)).toHaveLength(1);
		expect(hunks[0]!.aLines).toEqual(['  second para\n']);
		expect(hunks[0]!.bLines).toEqual(['  **second** para\n']);
		expect(out).toContain('- first _x_ para a * b\n');
		expectReparsesSame(out, state);
	});

	test('M6: 印の幅(2)より深い継続行の字下げ(4 空白)を持つ項目の継続行を直す → 字下げは 4 空白のまま・差はその行だけ', () => {
		// P3(reviewer): `-   two` だと印の幅と継続行の字下げが同じで区別できないので、印 2・継続行 4 にする
		const src = 'intro\n\n- one\n- two\n    more two\n- three\n\nafter\n';
		const doc = open(src);
		const state = boldWord(doc, 'more two', 'more');
		const out = text(doc, state);
		const hunks = hunksOf(src, out);
		expect(hunks, JSON.stringify(out)).toHaveLength(1);
		expect(hunks[0]!.aLines).toEqual(['    more two\n']);
		expect(hunks[0]!.bLines).toEqual(['    **more** two\n']);
		expect(out).toContain('- two\n    **more** two\n- three\n');
		expectReparsesSame(out, state);
	});
});

// ---------------------------------------------------------------------------
// 締めの 1 周(reviewer の観察・2026-11-17): hard_break の並び(契約6)・4-4 の R2(行の数が変わる直し)・R3(code fence の字下げ)
// ---------------------------------------------------------------------------

function nodePos(state: EditorState, name: string, nth = 0): number {
	let n = 0;
	let found = -1;
	state.doc.descendants((node, pos) => {
		if (found >= 0) return false;
		if (node.type.name === name) {
			if (n === nth) found = pos;
			n++;
		}
		return found < 0;
	});
	if (found < 0) throw new Error(`${name} #${nth} が無い`);
	return found;
}
function countNodes(state: EditorState, name: string): number {
	let n = 0;
	state.doc.descendants((node) => {
		if (node.type.name === name) n++;
		return true;
	});
	return n;
}
/** intro と after の間(触ったブロックの書き出し)。 */
function middle(out: string): string {
	return out.slice('intro\n\n'.length, out.length - '\n\nafter\n'.length);
}
function shiftEnterAt(state: EditorState, pos: number): EditorState {
	const at = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
	return run(at, MARKDOWN_KEYMAP['Shift-Enter']!);
}
function typeAt(state: EditorState, pos: number, s: string): EditorState {
	return state.apply(state.tr.insertText(s, pos));
}

describe('締め: hard_break の並び(契約6)— soft_break と隣り合う / 段落の末尾でも、段落が割れず読み直して同じ形', () => {
	test('素の段落: 継続行のある行末(soft_break の手前)で Shift + Enter → 空行はできず、読み直して段落 1 つ・hard_break 1 つ。外は byte 等価', () => {
		const src = 'intro\n\none\ntwo\nmore two\n\nafter\n';
		const doc = open(src);
		const sb = nodePos(doc.state, 'soft_break', 1); // 'two' と 'more two' の間
		const state = shiftEnterAt(doc.state, sb);
		expect(countNodes(state, 'hard_break')).toBe(1);
		const out = text(doc, state);
		expect(out.startsWith('intro\n\n')).toBe(true);
		expect(out.endsWith('\n\nafter\n')).toBe(true);
		expect(middle(out), `段落の中に空行ができない: ${JSON.stringify(out)}`).not.toMatch(/\n[ \t]*\n/);
		const back = open(out).state;
		expect(back.doc.childCount).toBe(3);
		expect(countNodes(back, 'hard_break'), '読み直しても hard_break 1 つ').toBe(1);
		expectReparsesSame(out, state);
	});

	test('素の段落: 末尾で Shift + Enter して続けて打つ → hard_break の後ろに文字。段落は割れず読み直して同じ形', () => {
		const src = 'intro\n\none\ntwo\n\nafter\n';
		const doc = open(src);
		const two = posOf(doc.state, 'two');
		const broken = shiftEnterAt(doc.state, two + 3);
		const state = typeAt(broken, broken.selection.from, 'x');
		const out = text(doc, state);
		expect(middle(out), JSON.stringify(out)).not.toMatch(/\n[ \t]*\n/);
		expect(open(out).state.doc.childCount).toBe(3);
		expect(countNodes(open(out).state, 'hard_break')).toBe(1);
		expectReparsesSame(out, state);
	});

	test('素の段落: 末尾に hard_break だけが残っても(続けて打たない)段落は割れず、外は byte 等価', () => {
		const src = 'intro\n\none\ntwo\n\nafter\n';
		const doc = open(src);
		const two = posOf(doc.state, 'two');
		const state = shiftEnterAt(doc.state, two + 3);
		const out = text(doc, state);
		expect(out.startsWith('intro\n\n')).toBe(true);
		expect(out.endsWith('\n\nafter\n')).toBe(true);
		expect(middle(out), JSON.stringify(out)).not.toMatch(/\n[ \t]*\n/);
		expect(open(out).state.doc.childCount, '段落は割れない').toBe(3);
	});

	test('リストの項目の中: 継続行のある行末で Shift + Enter → その項目だけが変わり(空行なし)、ほかの項目は byte のまま。読み直して同じ形', () => {
		const src = 'intro\n\n- one _x_\n- two\n  more two\n- three _y_\n\nafter\n';
		const doc = open(src);
		const sb = nodePos(doc.state, 'soft_break', 0);
		const state = shiftEnterAt(doc.state, sb);
		const out = text(doc, state);
		const hunks = hunksOf(src, out);
		expect(hunks, JSON.stringify(out)).toHaveLength(1);
		expect(hunks[0]!.aLines).toEqual(['- two\n']);
		expect(hunks[0]!.bLines.map(strip)).toEqual(['- two  ']);
		expect(out).toContain('- one _x_\n');
		expect(out).toContain('- three _y_\n');
		expect(middle(out)).not.toMatch(/\n[ \t]*\n/);
		expect(countNodes(open(out).state, 'hard_break')).toBe(1);
		expectReparsesSame(out, state);
	});

	test('リストの項目の末尾で Shift + Enter して続けて打つ → その項目だけ(hard_break + 新しい行は中身の字下げ)', () => {
		const src = 'intro\n\n- one _x_\n- two\n- three _y_\n\nafter\n';
		const doc = open(src);
		const two = posOf(doc.state, 'two');
		const broken = shiftEnterAt(doc.state, two + 3);
		const state = typeAt(broken, broken.selection.from, 'x');
		const out = text(doc, state);
		const hunks = hunksOf(src, out);
		expect(hunks, JSON.stringify(out)).toHaveLength(1);
		expect(hunks[0]!.aLines).toEqual(['- two\n']);
		expect(hunks[0]!.bLines).toEqual(['- two  \n', '  x\n']);
		expectReparsesSame(out, state);
	});
});

describe('締め R2: 行の数が変わる直し(継続行を結合する・soft break を足す)→ その項目の継続行は中身の字下げ・ほかの項目は byte のまま', () => {
	test('継続行を結合(soft_break を空白に)→ `- two more two` の 1 行に・ほかは byte のまま', () => {
		const src = 'intro\n\n- one _x_\n- two\n  more two\n- three _y_\n\nafter\n';
		const doc = open(src);
		const sb = nodePos(doc.state, 'soft_break', 0);
		const state = doc.state.apply(doc.state.tr.replaceWith(sb, sb + 1, markdownSchema.text(' ')));
		const out = text(doc, state);
		const hunks = hunksOf(src, out);
		expect(hunks, JSON.stringify(out)).toHaveLength(1);
		expect(hunks[0]!.aLines).toEqual(['- two\n', '  more two\n']);
		expect(hunks[0]!.bLines).toEqual(['- two more two\n']);
		expectReparsesSame(out, state);
	});

	test('soft break を足す(印 `- `)→ 継続行は中身の字下げ 2 空白・ほかは byte のまま', () => {
		const src = 'intro\n\n- one _x_\n- two more two\n- three _y_\n\nafter\n';
		const doc = open(src);
		const t = posOf(doc.state, 'two more two');
		const at = t + 'two'.length; // 'two' と ' more two' の間
		const state = doc.state.apply(doc.state.tr.replaceWith(at, at + 1, markdownSchema.nodes.soft_break!.create()));
		const out = text(doc, state);
		const hunks = hunksOf(src, out);
		expect(hunks, JSON.stringify(out)).toHaveLength(1);
		expect(hunks[0]!.aLines).toEqual(['- two more two\n']);
		expect(hunks[0]!.bLines).toEqual(['- two\n', '  more two\n']);
		expectReparsesSame(out, state);
	});

	test('soft break を足す(印 `-   `=中身の字下げ 4)→ 継続行は 4 空白', () => {
		const src = 'intro\n\n-   one _x_\n-   two more two\n-   three _y_\n\nafter\n';
		const doc = open(src);
		const t = posOf(doc.state, 'two more two');
		const at = t + 'two'.length;
		const state = doc.state.apply(doc.state.tr.replaceWith(at, at + 1, markdownSchema.nodes.soft_break!.create()));
		const out = text(doc, state);
		const hunks = hunksOf(src, out);
		expect(hunks, JSON.stringify(out)).toHaveLength(1);
		expect(hunks[0]!.aLines).toEqual(['-   two more two\n']);
		expect(hunks[0]!.bLines).toEqual(['-   two\n', '    more two\n']);
		expectReparsesSame(out, state);
	});

	test('入れ子の項目(4 空白)で soft break を足す → 継続行は入れ子の中身の字下げ(6 空白)', () => {
		const src = 'intro\n\n- one\n    - sub a more\n    - sub b _s_\n- two\n\nafter\n';
		const doc = open(src);
		const t = posOf(doc.state, 'sub a more');
		const at = t + 'sub a'.length;
		const state = doc.state.apply(doc.state.tr.replaceWith(at, at + 1, markdownSchema.nodes.soft_break!.create()));
		const out = text(doc, state);
		const hunks = hunksOf(src, out);
		expect(hunks, JSON.stringify(out)).toHaveLength(1);
		expect(hunks[0]!.aLines).toEqual(['    - sub a more\n']);
		expect(hunks[0]!.bLines).toEqual(['    - sub a\n', '      more\n']);
		expectReparsesSame(out, state);
	});
});

describe('締め R3: 触った項目の code fence に字下げのあるコード行があっても、字下げが二重にならない', () => {
	for (const [label, marker, indent] of [
		['印 `- `(中身 2 空白)', '- ', '  '],
		['印 `-   `(中身 4 空白)', '-   ', '    '],
	] as const) {
		test(`${label}: 項目 2 の 1 行目を太字 → 差はその行だけ・fence の中の \`      deep();\` はそのまま`, () => {
			const fence = `${indent}\`\`\`ts\n${indent}if (a) {\n${indent}    deep();\n${indent}}\n${indent}\`\`\``;
			const src = `intro\n\n${marker}one _x_\n${marker}two\n\n${fence}\n${marker}three _y_\n\nafter\n`;
			const doc = open(src);
			const item = doc.state.doc.child(1).child(1);
			expect(item.childCount, '項目 2=段落と code fence').toBe(2);
			expect(item.child(1).type.name).toBe('code_block');
			expect(item.child(1).textContent, 'コードの字下げは fence の中身の相対').toBe('if (a) {\n    deep();\n}');
			const state = boldItem(doc, 'two');
			const out = text(doc, state);
			const hunks = hunksOf(src, out);
			expect(hunks, JSON.stringify(out)).toHaveLength(1);
			expect(hunks[0]!.aLines).toEqual([`${marker}two\n`]);
			expect(hunks[0]!.bLines).toEqual([`${marker}**two**\n`]);
			expect(out).toContain(`${fence}\n`);
			expectReparsesSame(out, state);
		});

		test(`${label}: code fence の中を直す(1 行足す)→ fence の行だけが変わり、字下げは中身の字下げ 1 回分`, () => {
			const fence = `${indent}\`\`\`ts\n${indent}if (a) {\n${indent}    deep();\n${indent}}\n${indent}\`\`\``;
			const src = `intro\n\n${marker}one _x_\n${marker}two\n\n${fence}\n${marker}three _y_\n\nafter\n`;
			const doc = open(src);
			const code = posOf(doc.state, 'if (a) {\n    deep();\n}');
			const state = doc.state.apply(doc.state.tr.insertText('\n    more();', code + 'if (a) {\n    deep();'.length));
			const out = text(doc, state);
			const hunks = hunksOf(src, out);
			expect(hunks, JSON.stringify(out)).toHaveLength(1);
			expect(hunks[0]!.aLines).toEqual([]);
			expect(hunks[0]!.bLines).toEqual([`${indent}    more();\n`]);
			expect(out).toContain(`${indent}    deep();\n${indent}    more();\n${indent}}\n`);
			expectReparsesSame(out, state);
		});
	}
});

// ---------------------------------------------------------------------------
// 締めの 2 周目(reviewer の観察・2026-11-17): hard_break の連続(P2)・SB → HB / HB → SB を Node で作る(G1)・R3 の 1 文字・K2 / K3
// 綴り(オーケストレーターの判断): 行末に既にある hard_break に続く hard_break と、行頭に来る hard_break はバックスラッシュ(`\` + 改行)で書く。
// remark(from-mdast と同じ道)で確かめた読み: `alpha  \n\\\nbeta` → [alpha HB HB beta]・`\\\nalpha` → [HB alpha]・`two  \n\\\nmore two` → [two HB HB more two]
// (hard_break の直後の soft_break は改行を持たない=読み直しで消える)。
// ---------------------------------------------------------------------------

describe('締め P2: hard_break の連続 — 段落は割れず、読み直して hard_break の数が同じ。ほかは byte のまま', () => {
	function reparsed(out: string) {
		return open(out).state;
	}

	test('素の段落の真ん中で Shift + Enter 2 回 → `alpha  \\n\\\\\\nbeta`(2 つ目はバックスラッシュ)。読み直して同じ形(HB 2 つ)・外は byte 等価', () => {
		const src = 'intro\n\nalphabeta\n\nafter\n';
		const doc = open(src);
		const at = posOf(doc.state, 'alphabeta') + 5;
		const once = shiftEnterAt(doc.state, at);
		const state = run(once, MARKDOWN_KEYMAP['Shift-Enter']!);
		expect(countNodes(state, 'hard_break')).toBe(2);
		const out = text(doc, state);
		expect(out.startsWith('intro\n\n')).toBe(true);
		expect(out.endsWith('\n\nafter\n')).toBe(true);
		expect(middle(out), `空白だけの行(空行)ができない: ${JSON.stringify(out)}`).not.toMatch(/\n[ \t]*\n/);
		expect(middle(out), '2 つ目はバックスラッシュ').toMatch(/^alpha( {2}|\\)\n\\\nbeta$/);
		expect(reparsed(out).doc.childCount).toBe(3);
		expect(countNodes(reparsed(out), 'hard_break')).toBe(2);
		expectReparsesSame(out, state);
	});

	test('継続行の行末で Shift + Enter 2 回(素の段落)→ 空行はできず、読み直して段落 1 つ・HB 2 つ', () => {
		const src = 'intro\n\none\ntwo\nmore two\n\nafter\n';
		const doc = open(src);
		const sb = nodePos(doc.state, 'soft_break', 1);
		const once = shiftEnterAt(doc.state, sb);
		const state = run(once, MARKDOWN_KEYMAP['Shift-Enter']!);
		expect(countNodes(state, 'hard_break')).toBe(2);
		const out = text(doc, state);
		expect(middle(out), JSON.stringify(out)).not.toMatch(/\n[ \t]*\n/);
		expect(middle(out)).toMatch(/two( {2}|\\)\n\\\nmore two/);
		expect(reparsed(out).doc.childCount).toBe(3);
		expect(countNodes(reparsed(out), 'hard_break')).toBe(2);
	});

	test('リストの項目の継続行の行末で Shift + Enter 2 回 → その項目だけ(ほかは byte のまま)・空行なし・読み直して項目 3 つ・HB 2 つ', () => {
		const src = 'intro\n\n- one _x_\n- two\n  more two\n- three _y_\n\nafter\n';
		const doc = open(src);
		const sb = nodePos(doc.state, 'soft_break', 0);
		const once = shiftEnterAt(doc.state, sb);
		const state = run(once, MARKDOWN_KEYMAP['Shift-Enter']!);
		const out = text(doc, state);
		expect(out).toContain('- one _x_\n');
		expect(out).toContain('- three _y_\n');
		expect(middle(out), JSON.stringify(out)).not.toMatch(/\n[ \t]*\n/);
		expect(out).toMatch(/- two( {2}|\\)\n {2}\\\n {2}more two\n/);
		const back = reparsed(out);
		expect(back.doc.child(1).childCount, '項目 3 つのまま').toBe(3);
		expect(countNodes(back, 'hard_break')).toBe(2);
	});

	test('段落の先頭で Shift + Enter 1 回 → `\\\\\\nalphabeta`(行頭の hard_break はバックスラッシュ)。読み直して同じ形(HB 1 つ・先頭)', () => {
		const src = 'intro\n\nalphabeta\n\nafter\n';
		const doc = open(src);
		const state = shiftEnterAt(doc.state, posOf(doc.state, 'alphabeta'));
		expect(state.doc.child(1).child(0).type.name).toBe('hard_break');
		const out = text(doc, state);
		expect(middle(out), JSON.stringify(out)).toBe('\\\nalphabeta');
		expect(reparsed(out).doc.childCount).toBe(3);
		expect(reparsed(out).doc.child(1).child(0).type.name, '先頭の hard_break が消えない').toBe('hard_break');
		expectReparsesSame(out, state);
	});

	test('リストの項目の先頭で Shift + Enter → `- \\\\\\n  two` の形で、ほかの項目は byte のまま・読み直して同じ形', () => {
		const src = 'intro\n\n- one _x_\n- two\n- three _y_\n\nafter\n';
		const doc = open(src);
		const state = shiftEnterAt(doc.state, posOf(doc.state, 'two'));
		const out = text(doc, state);
		const hunks = hunksOf(src, out);
		expect(hunks, JSON.stringify(out)).toHaveLength(1);
		expect(hunks[0]!.aLines).toEqual(['- two\n']);
		expect(hunks[0]!.bLines).toEqual(['- \\\n', '  two\n']);
		expectReparsesSame(out, state);
	});
});

describe('締め G1: soft_break と hard_break の並びを Node で直接作っても段落が割れない', () => {
	test('SB → HB(soft_break の直後に hard_break)→ 空行なし・読み直して段落 1 つ・HB 1 つ', () => {
		const src = 'intro\n\ntwo\nmore two\n\nafter\n';
		const doc = open(src);
		const sb = nodePos(doc.state, 'soft_break', 0);
		const state = doc.state.apply(doc.state.tr.insert(sb + 1, markdownSchema.nodes.hard_break!.create()));
		expect(countNodes(state, 'soft_break')).toBe(1);
		expect(countNodes(state, 'hard_break')).toBe(1);
		const out = text(doc, state);
		expect(middle(out), JSON.stringify(out)).not.toMatch(/\n[ \t]*\n/);
		expect(open(out).state.doc.childCount).toBe(3);
		expect(countNodes(open(out).state, 'hard_break')).toBe(1);
	});

	test('HB → SB(hard_break の直後に soft_break)→ 空行なし・読み直して段落 1 つ・HB 1 つ', () => {
		const src = 'intro\n\ntwo\nmore two\n\nafter\n';
		const doc = open(src);
		const sb = nodePos(doc.state, 'soft_break', 0);
		const state = doc.state.apply(doc.state.tr.insert(sb, markdownSchema.nodes.hard_break!.create()));
		const out = text(doc, state);
		expect(middle(out), JSON.stringify(out)).not.toMatch(/\n[ \t]*\n/);
		expect(open(out).state.doc.childCount).toBe(3);
		expect(countNodes(open(out).state, 'hard_break')).toBe(1);
	});

	test('リストの項目の中で SB → HB を Node で作る → その項目だけ・ほかは byte のまま・空行なし', () => {
		const src = 'intro\n\n- one _x_\n- two\n  more two\n- three _y_\n\nafter\n';
		const doc = open(src);
		const sb = nodePos(doc.state, 'soft_break', 0);
		const state = doc.state.apply(doc.state.tr.insert(sb + 1, markdownSchema.nodes.hard_break!.create()));
		const out = text(doc, state);
		expect(out).toContain('- one _x_\n');
		expect(out).toContain('- three _y_\n');
		expect(middle(out), JSON.stringify(out)).not.toMatch(/\n[ \t]*\n/);
		expect(open(out).state.doc.child(1).childCount).toBe(3);
		expect(countNodes(open(out).state, 'hard_break')).toBe(1);
	});
});

describe('締め R3(1 文字)・K2・K3', () => {
	test('R3: 触った項目の fence の中の 1 文字だけを直す(deep → Xdeep・行の数は同じ)→ 差はその行だけ・字下げは二重にならない(印 `- ` と `-   `)', () => {
		for (const [marker, indent] of [
			['- ', '  '],
			['-   ', '    '],
		] as const) {
			const fence = `${indent}\`\`\`ts\n${indent}if (a) {\n${indent}    deep();\n${indent}}\n${indent}\`\`\``;
			const src = `intro\n\n${marker}one _x_\n${marker}two\n\n${fence}\n${marker}three _y_\n\nafter\n`;
			const doc = open(src);
			const code = posOf(doc.state, 'if (a) {\n    deep();\n}');
			const state = doc.state.apply(doc.state.tr.insertText('X', code + 'if (a) {\n    '.length));
			const out = text(doc, state);
			const hunks = hunksOf(src, out);
			expect(hunks, `${marker}: ${JSON.stringify(out)}`).toHaveLength(1);
			expect(hunks[0]!.aLines).toEqual([`${indent}    deep();\n`]);
			expect(hunks[0]!.bLines).toEqual([`${indent}    Xdeep();\n`]);
			expectReparsesSame(out, state);
		}
	});

	test('K2: 継続行の行頭(soft_break の直後)で Shift + Enter → soft_break を置き換える=行末と同じ結果(`- two  ` / `  more two`)', () => {
		const src = 'intro\n\n- one _x_\n- two\n  more two\n- three _y_\n\nafter\n';
		const doc = open(src);
		const sb = nodePos(doc.state, 'soft_break', 0);
		const state = shiftEnterAt(doc.state, sb + 1);
		expect(countNodes(state, 'soft_break'), 'soft_break は置き換わる').toBe(0);
		expect(countNodes(state, 'hard_break')).toBe(1);
		const out = text(doc, state);
		const hunks = hunksOf(src, out);
		expect(hunks, JSON.stringify(out)).toHaveLength(1);
		expect(hunks[0]!.aLines).toEqual(['- two\n']);
		expect(hunks[0]!.bLines.map(strip)).toEqual(['- two  ']);
		expect(out).toContain('- two  \n  more two\n');
		expectReparsesSame(out, state);
	});

	test('K3: soft_break をまたぐ選択で Shift + Enter → 選択を hard_break で差し替える(`tw  ` / `re two`)・読み直して同じ形', () => {
		const src = 'intro\n\n- one _x_\n- two\n  more two\n- three _y_\n\nafter\n';
		const doc = open(src);
		const two = posOf(doc.state, 'two');
		const more = posOf(doc.state, 'more two');
		const selected = doc.state.apply(doc.state.tr.setSelection(TextSelection.create(doc.state.doc, two + 2, more + 2)));
		const state = run(selected, MARKDOWN_KEYMAP['Shift-Enter']!);
		expect(countNodes(state, 'soft_break')).toBe(0);
		expect(countNodes(state, 'hard_break')).toBe(1);
		const out = text(doc, state);
		const hunks = hunksOf(src, out);
		expect(hunks, JSON.stringify(out)).toHaveLength(1);
		expect(hunks[0]!.aLines).toEqual(['- two\n', '  more two\n']);
		expect(hunks[0]!.bLines).toEqual(['- tw  \n', '  re two\n']);
		expectReparsesSame(out, state);
	});
});

// 締めの 3 周目: R3(段落の太字+fence の 1 文字)・K3(選択の始点が soft_break の直前)
describe('締め 3 周目: R3 の組み合わせ・K3 の始点', () => {
	test('R3: 同じ項目の段落に太字を付け、fence の中の 1 文字も直す(行の数は同じ)→ 項目は `- **two**` と fence(字下げ 1 回分)で書かれ、ほかは byte', () => {
		const fence = '  ```js\n  if (a) {\n      deep();\n  }\n  ```';
		const src = `intro\n\n- one _x_\n- two\n\n${fence}\n- three _y_\n\nafter\n`;
		const doc = open(src);
		const bolded = boldItem(doc, 'two');
		const code = posOf(bolded, 'if (a) {\n    deep();\n}');
		const state = bolded.apply(bolded.tr.insertText('X', code + 'if (a) {\n    '.length));
		const out = text(doc, state);
		expect(out).toBe('intro\n\n- one _x_\n- **two**\n\n  ```js\n  if (a) {\n      Xdeep();\n  }\n  ```\n- three _y_\n\nafter\n');
		expectReparsesSame(out, state);
	});

	test('K3: 選択の始点が soft_break の直前(`two|\\nmo|re`)で Shift + Enter → `two  ` / `re two`(素の段落とリストの項目)', () => {
		const plain = 'intro\n\ntwo\nmore two\n\nafter\n';
		{
			const doc = open(plain);
			const two = posOf(doc.state, 'two');
			const more = posOf(doc.state, 'more two');
			const selected = doc.state.apply(doc.state.tr.setSelection(TextSelection.create(doc.state.doc, two + 3, more + 2)));
			const state = run(selected, MARKDOWN_KEYMAP['Shift-Enter']!);
			expect(countNodes(state, 'soft_break')).toBe(0);
			expect(countNodes(state, 'hard_break')).toBe(1);
			const out = text(doc, state);
			expect(middle(out)).toBe('two  \nre two');
			expectReparsesSame(out, state);
		}
		const list = 'intro\n\n- one _x_\n- two\n  more two\n- three _y_\n\nafter\n';
		{
			const doc = open(list);
			const two = posOf(doc.state, 'two');
			const more = posOf(doc.state, 'more two');
			const selected = doc.state.apply(doc.state.tr.setSelection(TextSelection.create(doc.state.doc, two + 3, more + 2)));
			const state = run(selected, MARKDOWN_KEYMAP['Shift-Enter']!);
			const out = text(doc, state);
			const hunks = hunksOf(list, out);
			expect(hunks, JSON.stringify(out)).toHaveLength(1);
			expect(hunks[0]!.aLines).toEqual(['- two\n', '  more two\n']);
			expect(hunks[0]!.bLines).toEqual(['- two  \n', '  re two\n']);
			expectReparsesSame(out, state);
		}
	});
});

// ---------------------------------------------------------------------------
// 締めの 4 周目(reviewer の観察・2026-11-17): P2 見出しにする経路の hard_break・P3-a 空白の直後の hard_break・P3-b R3 の対・P3-c K3 の対
//
// P2(オーケストレーターの判断): 見出しは 1 行。Format ▸ Heading 1〜6(runFormatCommand → headingCommand)で段落を見出しにするとき、
//   段落の中の hard_break は soft_break に替える(1 取引)。修正前は hard_break のまま見出しになり、h3〜h6 は `### alpha  \nbeta` と
//   書かれて読み直すと見出しと段落に割れる(warn)。h1 / h2 は setext(`alpha  \nbeta\n====`)で読み直しは同じ形だが、見出しに
//   hard_break が残る(判断は全レベルで soft_break に替える)。soft_break を持つ段落を見出しにしたときは今の動きのまま
//   (h1 / h2 は setext・h3〜h6 は `### alpha&#xA;beta`=どれも読み直して同じ形・warn なし)。
// P3-a: 空白の直後の hard_break。修正前は `para   \ntext`(空白 3 つ)と書かれ、CommonMark は hard break の前の空白を読まないので
//   読み直すと `para`(空白が落ちる)になり検算に落ちる(warn)。綴りは実装に任せる。remark(from-mdast と同じ道)で確かめた読み:
//   `para \\\ntext` → [`para ` HB `text`]・`para&#32;  \ntext` → [`para ` HB `text`](どちらも読み直して同じ形)。
//   段落の末尾の `para ` + HB: CommonMark は段落の末尾の hard break も末尾の空白も読まない(`para   ` → [`para`]・`para \\` → [`para \\`]
//   =バックスラッシュが字になる・`para&#32;` → [`para `])。末尾の hard break はどの綴りでも読み直しで消えるので、HB が消えることと
//   末尾の空白が消えること(どちらも描画は同じ)は許し、見るのは「検算に落ちない(warn なし)・段落が割れない・字が増えない
//   (読み直した段落の字は `para ` か `para`)・外は byte のまま」。
// P3-b: R3(3 周目)の fixture は触っていない項目が文書の流儀どおりの綴りなので、リスト全体の 3 段目に落ちても同じ byte になり
//   項目単位の書き直しの門(to-markdown.ts の reindentLike の `!child.type.spec.code`)を外しても緑のまま。流儀と違う綴り(`*x*`)を
//   触っていない項目に置いた対で、外すと赤になる(リスト全体の書き直しで `_x_` に替わる)ことを確かめた。
// P3-c: K3(3 周目)は始点が soft_break の直前。始点が soft_break の直後(`two\n|mo|re`)の非空の選択は、選択を hard_break で
//   差し替える(soft_break は残る)。書き出しは `two\n\\\nre two`(soft_break の直後の hard_break はバックスラッシュ)で、読み直して
//   同じ形。markdown-keymap.ts の 2 本目の分岐の `empty` を外すと soft_break が置き換わって選択が残る(`two  \nmore two`)=赤。
// ---------------------------------------------------------------------------

/** 書き出しの各ブロックの warn(検算に落ちたか)。 */
function warnsOf(doc: MarkdownDocument, state: EditorState): boolean[] {
	return serializeMarkdown(state.doc, doc.origin, doc.generation).segments.map((s) => s.warn ?? false);
}
/** Format ▸ Heading N をメニューの経路(runFormatCommand)で当てる。dispatch の回数を数える。 */
function headingViaMenu(state: EditorState, level: 1 | 2 | 3 | 4 | 5 | 6): { state: EditorState; dispatched: number; ok: boolean } {
	let next = state;
	let dispatched = 0;
	const view = {
		state,
		dispatch: (tr: import('prosemirror-state').Transaction) => {
			dispatched++;
			next = next.apply(tr);
		},
		composing: false,
	};
	const handle = {
		kind: 'markdown' as const,
		raw: false,
		view: view as unknown as import('prosemirror-view').EditorView,
		uri: URI,
		readOnly: false,
		dirty: false,
		conflict: false,
		notice: null,
		text: () => '',
		expectedHash: () => '',
		markSaved: () => {},
		applyFileChanged: () => 'apply' as const,
		keepMyEdits: () => {},
		useFileOnDisk: () => {},
		showSaveConflict: () => {},
		reset: () => {},
		preparePrint: async () => {},
	};
	const ok = runFormatCommand(`format-heading-${level}`, handle as unknown as Parameters<typeof runFormatCommand>[1]);
	return { state: next, dispatched, ok };
}
function cursorIn(state: EditorState, needle: string, offset: number): EditorState {
	const pos = posOf(state, needle) + offset;
	return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}
const childNames = (n: import('prosemirror-model').Node) => {
	const out: string[] = [];
	n.forEach((c) => out.push(c.isText ? `"${c.text}"` : c.type.name));
	return out;
};

describe('締め 4 周目 P2: hard_break を持つ段落を見出しにする → hard_break は soft_break に替わり、読み直して見出し 1 つ(1 取引)', () => {
	for (const level of [1, 2, 3, 6] as const) {
		test(`h${level}: \`alpha  \\nbeta\` に Heading ${level} → 見出しの中は [alpha, soft_break, beta]・読み直して同じ形・warn なし・外は byte のまま`, () => {
			const src = 'intro\n\nalpha  \nbeta\n\nafter\n';
			const doc = open(src);
			const before = cursorIn(doc.state, 'alpha', 2);
			expect(childNames(before.doc.child(1)), '前提: 段落に hard_break').toEqual(['"alpha"', 'hard_break', '"beta"']);
			const r = headingViaMenu(before, level);
			expect(r.ok).toBe(true);
			expect(r.dispatched, '1 取引').toBe(1);
			expect(undoDepth(r.state) - undoDepth(before), '履歴は 1 段').toBe(1);
			const state = r.state;
			const block = state.doc.child(1);
			expect(block.type.name).toBe('heading');
			expect(block.attrs.level).toBe(level);
			expect(childNames(block), 'hard_break は soft_break に替わる').toEqual(['"alpha"', 'soft_break', '"beta"']);
			expect(countNodes(state, 'hard_break')).toBe(0);
			const out = text(doc, state);
			expect(out.startsWith('intro\n\n'), JSON.stringify(out)).toBe(true);
			expect(out.endsWith('\n\nafter\n'), JSON.stringify(out)).toBe(true);
			const back = open(out).state.doc;
			expect(back.childCount, `見出し 1 つ(割れない): ${JSON.stringify(out)}`).toBe(3);
			expect(back.child(1).type.name).toBe('heading');
			expectReparsesSame(out, state);
			expect(warnsOf(doc, state), '検算に落ちない').toEqual([false, false, false]);
			// 1 回の undo で hard_break を持つ段落に戻る
			let undone = state;
			expect(undo(state, (tr) => (undone = state.apply(tr)))).toBe(true);
			expect(undone.doc.child(1).type.name).toBe('paragraph');
			expect(childNames(undone.doc.child(1))).toEqual(['"alpha"', 'hard_break', '"beta"']);
		});
	}

	test('h3: hard_break が 2 つ(空白 2 つとバックスラッシュ)の段落 → 2 つとも soft_break・読み直して見出し 1 つ・warn なし', () => {
		const src = 'intro\n\nalpha  \nbeta\\\ngamma\n\nafter\n';
		const doc = open(src);
		const before = cursorIn(doc.state, 'alpha', 2);
		expect(countNodes(before, 'hard_break'), '前提').toBe(2);
		const r = headingViaMenu(before, 3);
		expect(r.dispatched).toBe(1);
		const state = r.state;
		expect(childNames(state.doc.child(1))).toEqual(['"alpha"', 'soft_break', '"beta"', 'soft_break', '"gamma"']);
		const out = text(doc, state);
		expect(out.startsWith('intro\n\n')).toBe(true);
		expect(out.endsWith('\n\nafter\n')).toBe(true);
		expect(open(out).state.doc.childCount, JSON.stringify(out)).toBe(3);
		expectReparsesSame(out, state);
		expect(warnsOf(doc, state)).toEqual([false, false, false]);
	});

	for (const level of [1, 2, 3, 6] as const) {
		test(`h${level}: soft_break を持つ段落(\`alpha\\nbeta\`)に Heading ${level} → 今の動きのまま(soft_break のまま・読み直して同じ形・warn なし)`, () => {
			const src = 'intro\n\nalpha\nbeta\n\nafter\n';
			const doc = open(src);
			const r = headingViaMenu(cursorIn(doc.state, 'alpha', 2), level);
			expect(r.dispatched).toBe(1);
			const state = r.state;
			expect(state.doc.child(1).type.name).toBe('heading');
			expect(childNames(state.doc.child(1))).toEqual(['"alpha"', 'soft_break', '"beta"']);
			const out = text(doc, state);
			expect(out.startsWith('intro\n\n')).toBe(true);
			expect(out.endsWith('\n\nafter\n')).toBe(true);
			expectReparsesSame(out, state);
			expect(warnsOf(doc, state)).toEqual([false, false, false]);
		});
	}
});

describe('締め 4 周目 P3-a: 空白の直後の hard_break → 書き出しを読み直して同じ形・検算に落ちない', () => {
	test('素の段落 `para |text` で Shift + Enter → [`para `, HB, `text`] が読み直して同じ形(空白が落ちない)・warn なし・外は byte のまま', () => {
		const src = 'intro\n\npara text\n\nafter\n';
		const doc = open(src);
		const state = shiftEnterAt(doc.state, posOf(doc.state, 'para text') + 'para '.length);
		expect(childNames(state.doc.child(1)), '前提').toEqual(['"para "', 'hard_break', '"text"']);
		const out = text(doc, state);
		expect(out.startsWith('intro\n\n')).toBe(true);
		expect(out.endsWith('\n\nafter\n')).toBe(true);
		expect(middle(out), JSON.stringify(out)).not.toMatch(/\n[ \t]*\n/);
		expectReparsesSame(out, state);
		expect(warnsOf(doc, state), JSON.stringify(out)).toEqual([false, false, false]);
	});

	test('リストの項目 `- para |text` で Shift + Enter → その項目だけ変わり(ほかは byte のまま)・読み直して同じ形・warn なし', () => {
		const src = 'intro\n\n- one _x_\n- para text\n- three _y_\n\nafter\n';
		const doc = open(src);
		const state = shiftEnterAt(doc.state, posOf(doc.state, 'para text') + 'para '.length);
		const out = text(doc, state);
		const hunks = hunksOf(src, out);
		expect(hunks, JSON.stringify(out)).toHaveLength(1);
		expect(hunks[0]!.aLines).toEqual(['- para text\n']);
		expect(out).toContain('- one _x_\n');
		expect(out).toContain('- three _y_\n');
		expectReparsesSame(out, state);
		expect(warnsOf(doc, state), JSON.stringify(out)).toEqual([false, false, false]);
	});

	test('段落の末尾の `para ` + HB(空白を打ってから Shift + Enter)→ 検算に落ちない・段落は割れない・読み直した字は `para ` か `para`・外は byte のまま', () => {
		const src = 'intro\n\npara\n\nafter\n';
		const doc = open(src);
		const end = posOf(doc.state, 'para') + 'para'.length;
		const spaced = typeAt(doc.state, end, ' ');
		const state = shiftEnterAt(spaced, end + 1);
		expect(childNames(state.doc.child(1)), '前提').toEqual(['"para "', 'hard_break']);
		const out = text(doc, state);
		expect(out.startsWith('intro\n\n')).toBe(true);
		expect(out.endsWith('\n\nafter\n')).toBe(true);
		const back = open(out).state.doc;
		expect(back.childCount, `段落は割れない: ${JSON.stringify(out)}`).toBe(3);
		expect(back.child(1).type.name).toBe('paragraph');
		// 末尾の hard break と末尾の空白は CommonMark が読まない(描画は同じ)ので消えてよい。字が増える(`para \` など)のは不可
		expect(['para ', 'para'], JSON.stringify(out)).toContain(back.child(1).textContent);
		expect(warnsOf(doc, state), JSON.stringify(out)).toEqual([false, false, false]);
	});
});

describe('締め 4 周目 P3-b: R3 の対 — 触っていない項目が文書の流儀と違う綴りでも、触った項目以外は byte のまま', () => {
	test('流儀は `_`(intro と項目 3)・項目 1 は `*x*` → 項目 2 に太字+fence の 1 文字 → 項目 1 の `*x*` は替わらない', () => {
		const fence = '  ```js\n  if (a) {\n      deep();\n  }\n  ```';
		const src = `intro _z_ _w_\n\n- one *x*\n- two\n\n${fence}\n- three _y_\n\nafter\n`;
		const doc = open(src);
		const bolded = boldItem(doc, 'two');
		const code = posOf(bolded, 'if (a) {\n    deep();\n}');
		const state = bolded.apply(bolded.tr.insertText('X', code + 'if (a) {\n    '.length));
		const out = text(doc, state);
		expect(out).toBe(`intro _z_ _w_\n\n- one *x*\n- **two**\n\n  \`\`\`js\n  if (a) {\n      Xdeep();\n  }\n  \`\`\`\n- three _y_\n\nafter\n`);
		expectReparsesSame(out, state);
		expect(warnsOf(doc, state)).toEqual([false, false, false]);
	});
});

describe('締め 4 周目 P3-c: K3 の対 — 選択の始点が soft_break の直後(`two\\n|mo|re`)で Shift + Enter → 選択を hard_break で差し替える', () => {
	test('素の段落 → [two, soft_break, hard_break, `re two`]・書き出し `two\\n\\\\\\nre two`・読み直して同じ形', () => {
		const src = 'intro\n\ntwo\nmore two\n\nafter\n';
		const doc = open(src);
		const more = posOf(doc.state, 'more two');
		const selected = doc.state.apply(doc.state.tr.setSelection(TextSelection.create(doc.state.doc, more, more + 2)));
		const state = run(selected, MARKDOWN_KEYMAP['Shift-Enter']!);
		expect(childNames(state.doc.child(1)), '選択(`mo`)が hard_break に替わり、soft_break は残る').toEqual(['"two"', 'soft_break', 'hard_break', '"re two"']);
		const out = text(doc, state);
		expect(middle(out)).toBe('two\n\\\nre two');
		expectReparsesSame(out, state);
		expect(warnsOf(doc, state)).toEqual([false, false, false]);
	});

	test('リストの項目 → その項目だけ(`- two` / `  \\\\` / `  re two`)・ほかは byte のまま・読み直して同じ形', () => {
		const src = 'intro\n\n- one _x_\n- two\n  more two\n- three _y_\n\nafter\n';
		const doc = open(src);
		const more = posOf(doc.state, 'more two');
		const selected = doc.state.apply(doc.state.tr.setSelection(TextSelection.create(doc.state.doc, more, more + 2)));
		const state = run(selected, MARKDOWN_KEYMAP['Shift-Enter']!);
		expect(countNodes(state, 'soft_break')).toBe(1);
		expect(countNodes(state, 'hard_break')).toBe(1);
		const out = text(doc, state);
		expect(out).toBe('intro\n\n- one _x_\n- two\n  \\\n  re two\n- three _y_\n\nafter\n');
		expect(hunksOf(src, out), JSON.stringify(out)).toHaveLength(1);
		expectReparsesSame(out, state);
		expect(warnsOf(doc, state)).toEqual([false, false, false]);
	});
});

// ---------------------------------------------------------------------------
// 締めの 5 周目(reviewer の観察・2026-11-17 夜): P2-b 末尾の hard_break を書かない・P3 入れ子の検算
//
// P2-b(オーケストレーターの判断): 検算が「文字のブロックの末尾の hard_break は無いのと同じ」とみなす(契約6・2e52f65)のに合わせ、書くときも
//   末尾の hard_break(続くものを含む)を書かない。修正前は行頭に来る末尾の hard_break がバックスラッシュで書かれ、開き直すと `\` が見える
//   文字として残る(`alpha  \n\\\n` → [alpha, HB, `\`]・空の段落の `\\\n` → [`\`]・soft_break の直後の `alpha\n\\\n` → [alpha, SB, `\`])。
//   見るのは「書き出しに `\` が出ない・読み直した字に `\` が無い・warn なし・ほかは byte のまま」。
//   空の段落だけは別: 空の段落は Markdown に書けない(読み直すとブロックが 1 つ減る)ので、hard_break が無くても今は warn が出る
//   (Enter だけで作った空の段落でも [false, true, true, false])。ここでは「hard_break を足しても、空の段落と同じ書き出し・同じ warn」を見る
//   (空の段落の warn を消すかは別の判断=オーケストレーターへ)。
// P3: 検算の正規化(withoutTrailingBreak)の入れ子への再帰を固定する。リストの項目の段落の末尾(入れ子のリストが続く)と引用の中の段落の
//   末尾で、末尾の hard_break と、末尾の空白+hard_break。後者は P2-b で末尾の hard_break を書かなくなっても、生のまま書かれた末尾の空白
//   (開き直すと消える)の検算に再帰が要るので、変異を殺し続ける。to-markdown.ts の `kids.map(withoutTrailingBreak)` を `kids` にすると
//   赤になることを確かめた。
// ---------------------------------------------------------------------------

/** 読み直しの比較の正規化(契約6 の検算と同じ規則): 文字のブロックの末尾の hard_break と末尾の空白を落とす(入れ子も)。 */
function trimTrailing(node: import('prosemirror-model').Node): import('prosemirror-model').Node {
	if (node.isText || node.isLeaf) return node;
	const kids: import('prosemirror-model').Node[] = [];
	node.forEach((c) => kids.push(c));
	if (node.isTextblock && !node.type.spec.code) {
		while (kids.length > 0 && kids[kids.length - 1]!.type.name === 'hard_break') kids.pop();
		const last = kids[kids.length - 1];
		if (last?.isText) {
			const trimmed = last.text!.replace(/[ \t]+$/, '');
			kids.pop();
			if (trimmed) kids.push(last.type.schema.text(trimmed, last.marks));
		}
		return node.type.create(node.attrs, kids, node.marks);
	}
	return node.type.create(node.attrs, kids.map(trimTrailing), node.marks);
}
function expectReparsesSameModuloTrailing(out: string, state: EditorState) {
	const back = open(out).state.doc;
	expect(back.childCount, '最上位ブロックの数').toBe(state.doc.childCount);
	for (let i = 0; i < state.doc.childCount; i++) expect(shapeEqual(trimTrailing(back.child(i)), trimTrailing(state.doc.child(i))), `ブロック ${i} の形`).toBe(true);
}
/** 読み直した文書の text に `\` が無い。 */
function expectNoVisibleBackslash(out: string) {
	let found = '';
	open(out).state.doc.descendants((n) => {
		if (n.isText && n.text!.includes('\\')) found = n.text!;
		return true;
	});
	expect(found, `読み直して見える \`\\\`: ${JSON.stringify(out)}`).toBe('');
}

describe('締め 5 周目 P2-b: 末尾の hard_break を書かない — 書き出しに `\\` が出ない・warn なし・ほかは byte のまま', () => {
	test('段落の末尾で Shift + Enter を 2 回 → [alpha, HB, HB]。`\\` が出ず、読み直して段落 1 つ(字は `alpha`)・warn なし', () => {
		const src = 'intro\n\nalpha\n\nafter\n';
		const doc = open(src);
		const end = posOf(doc.state, 'alpha') + 'alpha'.length;
		const state = run(shiftEnterAt(doc.state, end), MARKDOWN_KEYMAP['Shift-Enter']!);
		expect(childNames(state.doc.child(1)), '前提').toEqual(['"alpha"', 'hard_break', 'hard_break']);
		const out = text(doc, state);
		expect(out.startsWith('intro\n\n')).toBe(true);
		expect(out.endsWith('\n\nafter\n')).toBe(true);
		expect(middle(out), JSON.stringify(out)).not.toContain('\\');
		expect(middle(out), `空行ができない: ${JSON.stringify(out)}`).not.toMatch(/\n[ \t]*\n/);
		expectNoVisibleBackslash(out);
		const back = open(out).state.doc;
		expect(back.childCount).toBe(3);
		expect(back.child(1).textContent).toBe('alpha');
		expectReparsesSameModuloTrailing(out, state);
		expect(warnsOf(doc, state), JSON.stringify(out)).toEqual([false, false, false]);
	});

	test('リストの項目の末尾で Shift + Enter を 2 回 → その項目の行だけ変わり(`\\` なし・空行なし=リストは tight のまま)・ほかは byte のまま・warn なし', () => {
		const src = 'intro\n\n- one _x_\n- two\n- three _y_\n\nafter\n';
		const doc = open(src);
		const end = posOf(doc.state, 'two') + 'two'.length;
		const state = run(shiftEnterAt(doc.state, end), MARKDOWN_KEYMAP['Shift-Enter']!);
		const out = text(doc, state);
		expect(out).toContain('intro\n\n- one _x_\n');
		expect(out).toContain('- three _y_\n\nafter\n');
		const hunks = lineDiff(src, out) ?? [];
		for (const h of hunks) {
			expect(h.aLines.every((l) => l === '- two\n'), `差は項目 2 の行だけ: ${JSON.stringify(out)}`).toBe(true);
			for (const l of h.bLines) {
				expect(l, JSON.stringify(out)).not.toContain('\\');
				expect(strip(l).trim(), `空行ができない: ${JSON.stringify(out)}`).not.toBe('');
			}
		}
		expectNoVisibleBackslash(out);
		const back = open(out).state.doc;
		expect(back.child(1).childCount, '項目 3 つのまま').toBe(3);
		expect(back.child(1).child(1).textContent).toBe('two');
		expectReparsesSameModuloTrailing(out, state);
		expect(warnsOf(doc, state), JSON.stringify(out)).toEqual([false, false, false]);
	});

	test('soft_break の直後の末尾の hard_break([alpha, SB, HB])→ `\\` が出ず、読み直して段落 1 つ(字は `alpha`)・warn なし', () => {
		const src = 'intro\n\nalpha\nbeta\n\nafter\n';
		const doc = open(src);
		const beta = posOf(doc.state, 'beta');
		const state = doc.state.apply(doc.state.tr.replaceWith(beta, beta + 'beta'.length, markdownSchema.nodes.hard_break!.create()));
		expect(childNames(state.doc.child(1)), '前提').toEqual(['"alpha"', 'soft_break', 'hard_break']);
		const out = text(doc, state);
		expect(out.startsWith('intro\n\n')).toBe(true);
		expect(out.endsWith('\n\nafter\n')).toBe(true);
		expect(middle(out), JSON.stringify(out)).not.toContain('\\');
		expectNoVisibleBackslash(out);
		const back = open(out).state.doc;
		expect(back.childCount, '段落は割れない').toBe(3);
		expect(back.child(1).textContent).toBe('alpha');
		expect(warnsOf(doc, state), JSON.stringify(out)).toEqual([false, false, false]);
	});

	test('空の段落で Shift + Enter → `\\` が出ない。書き出しと warn は hard_break の無い空の段落と同じ(ほかは byte のまま)', () => {
		const src = 'intro\n\nalpha\n\nafter\n';
		const doc = open(src);
		const end = posOf(doc.state, 'alpha') + 'alpha'.length;
		const emptied = run(doc.state.apply(doc.state.tr.setSelection(TextSelection.create(doc.state.doc, end))), MARKDOWN_KEYMAP.Enter!);
		expect(emptied.doc.child(2).childCount, '前提: 空の段落').toBe(0);
		const state = run(emptied, MARKDOWN_KEYMAP['Shift-Enter']!);
		expect(childNames(state.doc.child(2)), '前提').toEqual(['hard_break']);
		const out = text(doc, state);
		expect(out, JSON.stringify(out)).not.toContain('\\');
		expectNoVisibleBackslash(out);
		expect(out.startsWith('intro\n\nalpha')).toBe(true);
		expect(out.endsWith('\n\nafter\n')).toBe(true);
		expect(out, '空の段落と同じ書き出し').toBe(text(doc, emptied));
		expect(warnsOf(doc, state), '空の段落と同じ warn').toEqual(warnsOf(doc, emptied));
	});
});

describe('締め 5 周目 P3: 入れ子の検算 — リストの項目・引用の中の段落の末尾の hard_break(と末尾の空白)で warn が出ない', () => {
	test('`- one` の末尾で Shift + Enter(入れ子のリストが続く)→ warn なし・読み直して同じ形(末尾の HB は無いのと同じ)・ほかは byte のまま', () => {
		const src = 'intro\n\n- one\n  - sub\n- two\n\nafter\n';
		const doc = open(src);
		const state = shiftEnterAt(doc.state, posOf(doc.state, 'one') + 'one'.length);
		expect(childNames(state.doc.child(1).child(0).child(0)), '前提').toEqual(['"one"', 'hard_break']);
		const out = text(doc, state);
		expect(out.startsWith('intro\n\n')).toBe(true);
		expect(out).toContain('  - sub\n- two\n\nafter\n');
		expectReparsesSameModuloTrailing(out, state);
		expect(warnsOf(doc, state), JSON.stringify(out)).toEqual([false, false, false]);
	});

	test('`- one ` (末尾に空白を打って)Shift + Enter(入れ子のリストが続く)→ warn なし・読み直して同じ形(末尾の空白と HB は無いのと同じ)', () => {
		const src = 'intro\n\n- one\n  - sub\n- two\n\nafter\n';
		const doc = open(src);
		const end = posOf(doc.state, 'one') + 'one'.length;
		const state = shiftEnterAt(typeAt(doc.state, end, ' '), end + 1);
		expect(childNames(state.doc.child(1).child(0).child(0)), '前提').toEqual(['"one "', 'hard_break']);
		const out = text(doc, state);
		expect(out.startsWith('intro\n\n')).toBe(true);
		expect(out).toContain('  - sub\n- two\n\nafter\n');
		expectReparsesSameModuloTrailing(out, state);
		expect(warnsOf(doc, state), JSON.stringify(out)).toEqual([false, false, false]);
	});

	test('引用の中の段落の末尾で Shift + Enter → warn なし・読み直して同じ形・ほかは byte のまま', () => {
		const src = 'intro\n\n> quote para\n> more\n\nafter\n';
		const doc = open(src);
		const state = shiftEnterAt(doc.state, posOf(doc.state, 'more') + 'more'.length);
		const out = text(doc, state);
		expect(out.startsWith('intro\n\n')).toBe(true);
		expect(out.endsWith('\n\nafter\n')).toBe(true);
		expect(open(out).state.doc.child(1).type.name).toBe('blockquote');
		expectReparsesSameModuloTrailing(out, state);
		expect(warnsOf(doc, state), JSON.stringify(out)).toEqual([false, false, false]);
	});

	test('引用の中の段落の末尾に空白を打って Shift + Enter → warn なし・読み直して同じ形', () => {
		const src = 'intro\n\n> quote para\n> more\n\nafter\n';
		const doc = open(src);
		const end = posOf(doc.state, 'more') + 'more'.length;
		const state = shiftEnterAt(typeAt(doc.state, end, ' '), end + 1);
		const out = text(doc, state);
		expect(out.startsWith('intro\n\n')).toBe(true);
		expect(out.endsWith('\n\nafter\n')).toBe(true);
		expectReparsesSameModuloTrailing(out, state);
		expect(warnsOf(doc, state), JSON.stringify(out)).toEqual([false, false, false]);
	});
});
