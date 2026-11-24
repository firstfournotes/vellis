/**
 * 要件#74 第2段 2-1 の受け入れテスト(docs/requirements/req-74.md)— 文書モデル(Markdown)
 * (AC-74-1(第2段の分)・AC-74-5・AC-74-21・AC-74-47(書き直し案)・契約2・6・15。unit プロジェクト・DOM なし)
 *
 * ## 仮の前提(由谷の確認待ち=「第2段の準備で出た判断」1〜3 を推奨の答えと仮定。違えばこのファイルは捨てる)
 * - 判断 1: 原文の切片は Node の属性に持たず、属性は `bid` だけ(切片は文書モデルの `origin` の表)
 * - 判断 2: 2 段目の検算に落ちたら打った文字だけをエスケープして 2 段目で再試行(ここでは AC-74-21 の段の判定に関わる)
 * - 判断 3: `prosemirror-schema-list` を依存に足す(ここでは使わない)
 * - 受け入れ基準「第2段」の書き直し案=AC-74-1 は `createMarkdownDocument` で読み `markdownText` で書き出す・フィクスチャの変種に
 *   BOM+front matter / BOM+CRLF / CR だけを足す・AC-74-47(保存の後の付け直し)を足す
 *
 * ## 確定契約(implementer はこれに従う=推奨名は req-74.md 第2段の作り(案)5・6。無いものは test-writer が固定)
 *
 * ```ts
 * // --- src/editor/markdown-document.ts(新規・純関数・DOM なし。第1段の text-document.ts と同じ骨格)
 * export interface MarkdownDocument {
 *   readonly uri: string; readonly readOnly: boolean;
 *   readonly state: EditorState;          // prosemirror-state(履歴の plugin を含む)
 *   readonly base: string; readonly baseHash: string;   // contentHash(base)
 *   readonly origin: OriginTable;         // bid → 切片(to-markdown.ts)
 *   readonly generation: Generation;      // 今の原文(読んだ文字列)の世代
 * }
 * export function createMarkdownDocument(content: string, opts: { uri: string; readOnly: boolean }): MarkdownDocument;
 * export function markdownText(doc: MarkdownDocument): string;          // = serializeMarkdown(doc.state.doc, doc.origin, doc.generation).text
 * export function withState(doc: MarkdownDocument, state: EditorState): MarkdownDocument;   // state だけ替える
 * export function isMarkdownDirty(doc: MarkdownDocument): boolean;      // = isDirty(markdownText(doc), doc.base)
 * /** 保存した文字列を読み直し、形が同じ最上位ブロックは Node をそのまま新しい世代の切片に付け直す(履歴に積まない)。
 *  *  base・baseHash ← savedText。保存の後は全ブロックが「触っていない」(1 段目)。 *\/
 * export function rekeyAfterSave(doc: MarkdownDocument, savedText: string): MarkdownDocument;
 *
 * // --- src/editor/to-markdown.ts の serializeMarkdown(段の判定に使う。契約は to-markdown.acceptance.test.ts)
 * ```
 *
 * ## 修正前に赤になる理由
 * - `src/editor/markdown-document.ts` ほかが無く、`prosemirror-*` も依存に無いので import で落ちる
 */
import { describe, expect, test } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { setBlockType, splitBlock, wrapIn } from 'prosemirror-commands';
import { wrapInList } from 'prosemirror-schema-list';
import { undo, undoDepth } from 'prosemirror-history';

import { contentHash } from '$lib/document-edit';
import { createMarkdownDocument, isMarkdownDirty, markdownText, rekeyAfterSave, withState, type MarkdownDocument } from './markdown-document';
import { serializeMarkdown } from './to-markdown';
import { BOM, MD_FILES, blockPos, fixture, textSpots, variants } from './markdown.testkit';

function open(src: string, uri = 'file:///Users/a/doc.md'): MarkdownDocument {
	return createMarkdownDocument(src, { uri, readOnly: false });
}

/** 取引を当てた文書。 */
function apply(doc: MarkdownDocument, build: (tr: import('prosemirror-state').Transaction, d: MarkdownDocument) => import('prosemirror-state').Transaction): MarkdownDocument {
	const tr = build(doc.state.tr, doc);
	return withState(doc, doc.state.apply(tr));
}

// ---------------------------------------------------------------------------
// AC-74-1(第2段の分)— 原文の往復
// ---------------------------------------------------------------------------

describe('AC-74-1: createMarkdownDocument → markdownText の往復が byte で一致する(編集なし)', () => {
	const cases = MD_FILES.flatMap((name) => variants(name, fixture(name)));

	test.each(cases)('%s', (_label, src) => {
		const doc = open(src);
		expect(markdownText(doc)).toBe(src);
		expect(doc.base).toBe(src);
		expect(doc.baseHash).toBe(contentHash(src));
		expect(isMarkdownDirty(doc)).toBe(false);
	});

	test('書き出しは決定的(同じ文書モデルからは同じ文字列)', () => {
		const doc = open(fixture('ai-report.md'));
		expect(markdownText(doc)).toBe(markdownText(doc));
	});

	test('readOnly・uri は opts のまま。開いた直後の undo の段数は 0', () => {
		const doc = createMarkdownDocument('# a\n', { uri: 'ssh://host/a.md', readOnly: true });
		expect(doc.readOnly).toBe(true);
		expect(doc.uri).toBe('ssh://host/a.md');
		expect(undoDepth(doc.state)).toBe(0);
	});

	test('空の文書・改行だけの文書・BOM だけの文書も往復する', () => {
		for (const src of ['', '\n', '\r\n', BOM, `${BOM}\n`, '\n\n\n']) {
			expect(markdownText(open(src)), JSON.stringify(src)).toBe(src);
		}
	});
});

// ---------------------------------------------------------------------------
// 契約2 — dirty は文字列の比較
// ---------------------------------------------------------------------------

describe('契約2: dirty は取引の有無でなく文字列の比較(打って戻したら dirty でない)', () => {
	test('段落に 1 文字打つと dirty・消すと戻る', () => {
		const src = 'Hello world\n';
		const doc = open(src);
		const spot = textSpots(doc.state.doc, 0)[0]!;
		const typed = apply(doc, (tr) => tr.insertText('X', spot.pos + 5));
		expect(markdownText(typed)).toBe('HelloX world\n');
		expect(isMarkdownDirty(typed)).toBe(true);
		const back = apply(typed, (tr) => tr.delete(spot.pos + 5, spot.pos + 6));
		expect(markdownText(back)).toBe(src);
		expect(isMarkdownDirty(back)).toBe(false);
	});

	test('undo で原文に戻ると dirty でない(履歴は文書モデルに付く=契約11)', () => {
		const doc = open('Hello world\n');
		const spot = textSpots(doc.state.doc, 0)[0]!;
		const typed = apply(doc, (tr) => tr.insertText('X', spot.pos + 5));
		expect(undoDepth(typed.state)).toBe(1);
		let undone = typed.state;
		undo(typed.state, (tr) => (undone = typed.state.apply(tr)));
		expect(markdownText(withState(typed, undone))).toBe('Hello world\n');
		expect(isMarkdownDirty(withState(typed, undone))).toBe(false);
	});

	test('withState は state だけを替え、base・baseHash・uri・generation は変えない。元の文書は不変', () => {
		const doc = open('a\n\nb\n');
		const spot = textSpots(doc.state.doc, 1)[0]!;
		const next = apply(doc, (tr) => tr.insertText('X', spot.pos));
		expect(next.base).toBe(doc.base);
		expect(next.baseHash).toBe(doc.baseHash);
		expect(next.uri).toBe(doc.uri);
		expect(next.generation).toBe(doc.generation);
		expect(markdownText(doc)).toBe('a\n\nb\n');
		expect(markdownText(next)).toBe('a\n\nXb\n');
	});
});

// ---------------------------------------------------------------------------
// AC-74-5 — 改行コード(契約15)
// ---------------------------------------------------------------------------

/** 最上位の段落 `index` の text の中(col)でブロックを割る。 */
function splitParagraph(doc: MarkdownDocument, index: number, col: number): MarkdownDocument {
	const spot = textSpots(doc.state.doc, index)[0]!;
	const state = doc.state.apply(doc.state.tr.setSelection(TextSelection.create(doc.state.doc, spot.pos + col)));
	let next = state;
	const ok = splitBlock(state, (tr) => (next = state.apply(tr)));
	expect(ok, 'splitBlock ran').toBe(true);
	return withState(doc, next);
}

describe('AC-74-5: ブロックを足したときの改行は文書の主たる改行。触っていないブロックの改行はそのまま。BOM は保たれる', () => {
	// 割る位置は語の中(`alphabeta` の 5 文字目)にして、割った後の段落に先頭・末尾の空白が残らないようにする
	// (空白があると読み直しで落ちる=契約6 の 3 段目の検算の対象であり、改行コードの判定の対象ではない)。
	test('CRLF の文書で段落を割ると \\r\\n\\r\\n で繋がれ、\\n だけの改行が生まれない', () => {
		const src = 'first para\r\n\r\nalphabeta\r\n\r\nthird\r\n';
		const out = markdownText(splitParagraph(open(src), 1, 5));
		expect(out).toBe('first para\r\n\r\nalpha\r\n\r\nbeta\r\n\r\nthird\r\n');
		expect(out.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
	});

	test('LF の文書では \\n', () => {
		const out = markdownText(splitParagraph(open('first\n\nalphabeta\n\nthird\n'), 1, 5));
		expect(out).toBe('first\n\nalpha\n\nbeta\n\nthird\n');
	});

	test('CR だけの文書では \\r', () => {
		const out = markdownText(splitParagraph(open('first\r\ralphabeta\r\rthird\r'), 1, 5));
		expect(out).toBe('first\r\ralpha\r\rbeta\r\rthird\r');
		expect(out).not.toContain('\n');
	});

	test('混在の文書(CRLF が多い)で触っていないブロックの改行コードが保たれ、新しい改行は CRLF', () => {
		// 1〜2 ブロック目の間は LF、ほかは CRLF(dominant=CRLF)。3 ブロック目を割る。
		const src = 'one\n\ntwo\r\n\r\nalphabeta\r\n\r\nfive\r\n';
		const out = markdownText(splitParagraph(open(src), 2, 5));
		expect(out).toBe('one\n\ntwo\r\n\r\nalpha\r\n\r\nbeta\r\n\r\nfive\r\n');
	});

	test('BOM+CRLF の文書で割っても BOM が先頭に残る', () => {
		const src = `${BOM}alphabeta\r\n\r\ngamma\r\n`;
		const out = markdownText(splitParagraph(open(src), 0, 5));
		expect(out.startsWith(BOM)).toBe(true);
		expect(out).toBe(`${BOM}alpha\r\n\r\nbeta\r\n\r\ngamma\r\n`);
	});

	test('BOM+front matter の文書で本文を割っても、BOM と front matter は byte のまま', () => {
		const fm = `${BOM}---\r\ntitle: x\r\n---\r\n\r\nalphabeta\r\n`;
		const out = markdownText(splitParagraph(open(fm), 1, 5));
		expect(out).toBe(`${BOM}---\r\ntitle: x\r\n---\r\n\r\nalpha\r\n\r\nbeta\r\n`);
	});

	test('末尾の改行が無い文書で最後の段落を割っても、末尾に改行を足さない', () => {
		const out = markdownText(splitParagraph(open('a\n\nbcde'), 1, 2));
		expect(out).toBe('a\n\nbc\n\nde');
	});
});

// ---------------------------------------------------------------------------
// AC-74-21 — タスクの印(契約17)
// ---------------------------------------------------------------------------

describe('AC-74-21: タスクの印を切り替えると書き出しで `[ ]` ⇄ `[x]` の 1 文字だけが変わる', () => {
	function toggleFirstTask(doc: MarkdownDocument, blockIndex: number, itemIndex: number): MarkdownDocument {
		const list = doc.state.doc.child(blockIndex);
		let pos = blockPos(doc.state.doc, blockIndex) + 1;
		for (let i = 0; i < itemIndex; i++) pos += list.child(i).nodeSize;
		const item = list.child(itemIndex);
		return apply(doc, (tr) => tr.setNodeMarkup(pos, undefined, { ...item.attrs, checked: !item.attrs.checked }));
	}

	for (const [label, eol] of [
		['LF', '\n'],
		['CRLF', '\r\n'],
	] as const) {
		test(`${label}: 未完 → 完了・完了 → 未完で、変わる文字はちょうど 1 つ(段=2)`, () => {
			const src = ['- [ ] open task', '- [x] done task', '- plain item', ''].join(eol);
			const doc = open(src);
			const a = toggleFirstTask(doc, 0, 0);
			const outA = markdownText(a);
			expect(outA).toBe(src.replace('- [ ] open', '- [x] open'));
			expect(outA.length).toBe(src.length);
			const segA = serializeMarkdown(a.state.doc, a.origin, a.generation).segments[0]!;
			expect(segA.stage).toBe(2);
			const b = toggleFirstTask(doc, 0, 1);
			expect(markdownText(b)).toBe(src.replace('- [x] done', '- [ ] done'));
		});
	}

	test('ai-report.md のタスクの印を切り替えても、項目の本文とほかの項目・ほかのブロックは byte 等価', () => {
		const src = fixture('ai-report.md');
		const doc = open(src);
		let listIndex = -1;
		doc.state.doc.forEach((c, _o, i) => {
			if (listIndex < 0 && c.type.name === 'bullet_list' && c.child(0).attrs.checked !== null) listIndex = i;
		});
		expect(listIndex).toBeGreaterThanOrEqual(0);
		const out = markdownText(toggleFirstTask(doc, listIndex, 1));
		const diff = [...src].map((ch, i) => (ch !== out[i] ? i : -1)).filter((i) => i >= 0);
		expect(out.length).toBe(src.length);
		expect(diff).toHaveLength(1);
		expect(src[diff[0]!]).toBe(' ');
		expect(out[diff[0]!]).toBe('x');
	});

	test('印の切り替えは undo 1 回で戻り、書き出しが原文に戻る', () => {
		const src = '- [ ] a\n- [ ] b\n';
		const doc = toggleFirstTask(open(src), 0, 0);
		let undone = doc.state;
		undo(doc.state, (tr) => (undone = doc.state.apply(tr)));
		expect(markdownText(withState(doc, undone))).toBe(src);
	});
});

// ---------------------------------------------------------------------------
// AC-74-47(書き直し案)— 保存の後の付け直し(契約14)
// ---------------------------------------------------------------------------

describe('AC-74-47: rekeyAfterSave の後は全ブロックが「触っていない」になり、続けて直すと 2 段目', () => {
	test('太字を付けて保存 → 付け直し → 同じブロックに文字を足すと、保存した文字列からその文字だけが違う', () => {
		const src = 'first para\n\nsecond para here\n\nthird\n';
		const doc = open(src);
		const spot = textSpots(doc.state.doc, 1)[0]!;
		const bold = apply(doc, (tr, d) => tr.addMark(spot.pos, spot.pos + 6, d.state.schema.marks.strong!.create()));
		const saved = markdownText(bold);
		expect(saved).toBe('first para\n\n**second** para here\n\nthird\n');
		const rekeyed = rekeyAfterSave(bold, saved);
		expect(rekeyed.base).toBe(saved);
		expect(rekeyed.baseHash).toBe(contentHash(saved));
		expect(isMarkdownDirty(rekeyed)).toBe(false);
		expect(markdownText(rekeyed)).toBe(saved);
		// 最上位の Node は同一のまま(履歴も選択も保たれる)。
		for (let i = 0; i < bold.state.doc.childCount; i++) expect(rekeyed.state.doc.child(i), `block ${i}`).toBe(bold.state.doc.child(i));
		expect(undoDepth(rekeyed.state)).toBe(undoDepth(bold.state));
		// 保存の後に同じブロックへ 1 文字: 2 段目で、保存した文字列からその 1 文字だけが違う。
		const spots = textSpots(rekeyed.state.doc, 1);
		const plain = spots.find((s) => s.marks.length === 0)!;
		const typed = apply(rekeyed, (tr) => tr.insertText('X', plain.pos + 1));
		const out = markdownText(typed);
		expect(out).toBe('first para\n\n**second** Xpara here\n\nthird\n');
		expect(serializeMarkdown(typed.state.doc, typed.origin, typed.generation).segments[1]!.stage).toBe(2);
	});

	test('CRLF でも同じ', () => {
		const src = 'first\r\n\r\nsecond para\r\n';
		const doc = open(src);
		const spot = textSpots(doc.state.doc, 1)[0]!;
		const bold = apply(doc, (tr, d) => tr.addMark(spot.pos, spot.pos + 6, d.state.schema.marks.strong!.create()));
		const saved = markdownText(bold);
		expect(saved).toBe('first\r\n\r\n**second** para\r\n');
		const rekeyed = rekeyAfterSave(bold, saved);
		const plain = textSpots(rekeyed.state.doc, 1).find((s) => s.marks.length === 0)!;
		expect(markdownText(apply(rekeyed, (tr) => tr.insertText('X', plain.pos + 1)))).toBe('first\r\n\r\n**second** Xpara\r\n');
	});
});

// ---------------------------------------------------------------------------
// AC-74-47 の追加(reviewer の照合 2026-11-17)— 3 段目で作ったブロック(wrapInList・setBlockType・wrapIn)の保存の後の系譜
// ---------------------------------------------------------------------------

describe('AC-74-47(追加): 3 段目で作ったブロックも、保存の後は 1 段目になり、続けて打つと 2 段目', () => {
	/** 2 段落目(`plain words`)にカーソルを置いて command を当てる。 */
	function onSecond(doc: MarkdownDocument, command: (state: import('prosemirror-state').EditorState, dispatch?: (tr: import('prosemirror-state').Transaction) => void) => boolean): MarkdownDocument {
		const spot = textSpots(doc.state.doc, 1)[0]!;
		const state = doc.state.apply(doc.state.tr.setSelection(TextSelection.create(doc.state.doc, spot.pos + 1)));
		let next = state;
		const ok = command(state, (tr) => (next = state.apply(tr)));
		expect(ok, 'the command ran').toBe(true);
		return withState(doc, next);
	}

	const cases: Array<{
		label: string;
		command: Parameters<typeof onSecond>[1];
		saved: string;
		typed: string;
	}> = [
		{
			label: 'Bulleted List(wrapInList)',
			command: (st, d) => wrapInList(st.schema.nodes.bullet_list!)(st, d),
			saved: 'intro\n\n- plain words\n',
			typed: 'intro\n\n- Xplain words\n',
		},
		{
			label: 'Heading 2(setBlockType)',
			command: (st, d) => setBlockType(st.schema.nodes.heading!, { level: 2 })(st, d),
			saved: 'intro\n\n## plain words\n',
			typed: 'intro\n\n## Xplain words\n',
		},
		{
			label: 'Quote(wrapIn blockquote)',
			command: (st, d) => wrapIn(st.schema.nodes.blockquote!)(st, d),
			saved: 'intro\n\n> plain words\n',
			typed: 'intro\n\n> Xplain words\n',
		},
	];

	test.each(cases)('$label: 保存 → 全ブロックが 1 段目・Node 同一・履歴の段数不変 → 1 文字打つとそのブロックだけ 2 段目', ({ command, saved, typed }) => {
		const doc = open('intro\n\nplain words\n');
		const edited = onSecond(doc, command);
		const before = serializeMarkdown(edited.state.doc, edited.origin, edited.generation);
		expect(before.text).toBe(saved);
		expect(before.segments.map((s) => s.stage)).toEqual([1, 3]);
		// 保存=付け直し。
		const rekeyed = rekeyAfterSave(edited, saved);
		expect(rekeyed.base).toBe(saved);
		expect(isMarkdownDirty(rekeyed)).toBe(false);
		const after = serializeMarkdown(rekeyed.state.doc, rekeyed.origin, rekeyed.generation);
		expect(after.text).toBe(saved);
		expect(after.segments.map((s) => s.stage), 'after the save every block is stage 1 (untouched)').toEqual([1, 1]);
		for (let i = 0; i < edited.state.doc.childCount; i++) expect(rekeyed.state.doc.child(i), `block ${i} identical`).toBe(edited.state.doc.child(i));
		expect(undoDepth(rekeyed.state)).toBe(undoDepth(edited.state));
		// 続けて 1 文字: そのブロックだけが 2 段目で、保存した文字列からその 1 文字だけが違う。
		const spot = textSpots(rekeyed.state.doc, 1)[0]!;
		const next = apply(rekeyed, (tr) => tr.insertText('X', spot.pos));
		const r = serializeMarkdown(next.state.doc, next.origin, next.generation);
		expect(r.text).toBe(typed);
		expect(r.segments.map((s) => s.stage)).toEqual([1, 2]);
		expect(isMarkdownDirty(next)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// AC-74-47 の追加(reviewer の当て直し 2026-11-17)— 段落を割った後の保存(bid が 2 つになる経路)
// ---------------------------------------------------------------------------

describe('AC-74-47(追加): 段落を割って保存すると、割れた両方が 1 段目になり、どちらに打ってもそのブロックだけ 2 段目', () => {
	// `hello|world` で割る(`hello| world` だと後半の段落が空白で始まり、読み直しで字下げとして落ちる=改行や系譜ではなく
	// 契約6 の 3 段目の検算の話になるので、ここでは語の中で割る)。
	function splitAndSave() {
		const doc = open('intro\n\nhelloworld\n');
		const split = splitParagraph(doc, 1, 5); // `hello|` で Enter
		const saved = markdownText(split);
		expect(saved).toBe('intro\n\nhello\n\nworld\n');
		expect(serializeMarkdown(split.state.doc, split.origin, split.generation).segments.map((s) => s.stage)).toEqual([1, 3, 3]);
		const rekeyed = rekeyAfterSave(split, saved);
		return { split, saved, rekeyed };
	}

	test('保存の後は編集なしで [1, 1, 1]・最上位の Node 同一・履歴の段数不変・dirty でない', () => {
		const { split, saved, rekeyed } = splitAndSave();
		const after = serializeMarkdown(rekeyed.state.doc, rekeyed.origin, rekeyed.generation);
		expect(after.text).toBe(saved);
		expect(after.segments.map((s) => s.stage), '割れた両方(同じ bid を持っていた 2 つ)が付け直されて 1 段目').toEqual([1, 1, 1]);
		for (let i = 0; i < split.state.doc.childCount; i++) expect(rekeyed.state.doc.child(i), `block ${i} identical`).toBe(split.state.doc.child(i));
		expect(undoDepth(rekeyed.state)).toBe(undoDepth(split.state));
		expect(isMarkdownDirty(rekeyed)).toBe(false);
	});

	test('前半(hello)に 1 文字打つと [1, 2, 1] で、保存した文字列からその 1 文字だけ違う', () => {
		const { saved, rekeyed } = splitAndSave();
		const spot = textSpots(rekeyed.state.doc, 1)[0]!;
		const next = apply(rekeyed, (tr) => tr.insertText('X', spot.pos + 5));
		const r = serializeMarkdown(next.state.doc, next.origin, next.generation);
		expect(r.segments.map((s) => s.stage)).toEqual([1, 2, 1]);
		expect(r.text).toBe(saved.replace('hello\n', 'helloX\n'));
	});

	test('後半(world)に 1 文字打つと [1, 1, 2](対)', () => {
		const { saved, rekeyed } = splitAndSave();
		const spot = textSpots(rekeyed.state.doc, 2)[0]!;
		const next = apply(rekeyed, (tr) => tr.insertText('X', spot.pos + spot.text.length));
		const r = serializeMarkdown(next.state.doc, next.origin, next.generation);
		expect(r.segments.map((s) => s.stage)).toEqual([1, 1, 2]);
		expect(r.text).toBe(saved.replace('world\n', 'worldX\n'));
	});
});
