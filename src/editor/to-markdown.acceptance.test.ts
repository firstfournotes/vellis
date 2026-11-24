/**
 * 要件#74 第2段 2-1 の受け入れテスト(docs/requirements/req-74.md)— 書き出し(契約6 の 3 段の規則)
 * (AC-74-2・AC-74-3・AC-74-4・契約6・15・第2段の作り(案)の項目 5。unit プロジェクト・DOM なし)
 *
 * ## 仮の前提(由谷の確認待ち=「第2段の準備で出た判断」1〜3 を推奨の答えと仮定。違えばこのファイルは捨てる)
 * - 判断 1: 原文の切片は Node の属性に持たず `bid` だけ(1 段目の判定は Node の同一性・2 段目は `bid` の系譜)
 * - **判断 2: 2 段目の検算に落ちたら、打った文字だけをエスケープして 2 段目で再試行する**(表のセルの `|` は `\|` の 2 文字だけ・
 *   段落の `*x*` は `\*x\*`)。契約6 の字面(「2 段目で一致しなければ 3 段目」)の読み替え
 * - **判断 3: `prosemirror-schema-list` を直接の依存に足す**(AC-74-4 の Bulleted List を `wrapInList` で当てる)
 * - 受け入れ基準「第2段」の書き直し案=AC-74-3 の「形を変える記号だけエスケープ(`*` 1 つはそのまま)」・AC-74-2・3・4 の検算は
 *   「前後のブロックと一緒に読み直して `shapeEqual`」。装飾のコマンド(`commands.ts`=項目 7)は 2-2 の AC-74-8 で判定し、
 *   ここでは prosemirror-commands / prosemirror-schema-list の取引を直に当てる
 *
 * ## 確定契約(implementer はこれに従う=推奨名は req-74.md 第2段の作り(案)5。無いものは test-writer が固定)
 *
 * ```ts
 * // --- src/editor/to-markdown.ts(新規・純関数)
 * export interface MarkdownStyle { bullet: '-' | '*' | '+'; emphasis: '*' | '_'; strong: '*' | '_'; fence: '`' | '~'; rule: '-' | '*' | '_';
 *                                  bulletOrdered: '.' | ')'; listItemIndent: 'one' | 'tab' | 'mixed'; tableAlign: boolean }
 * export const FIXED_STYLE: MarkdownStyle;   // 例の無い文書の綴り= { bullet: '-', emphasis: '*', strong: '*', fence: '`', rule: '-', bulletOrdered: '.', listItemIndent: 'one', tableAlign: true }
 * export function detectMarkdownStyle(src: string): MarkdownStyle;   // 多いほう。数が同じなら FIXED_STYLE の値
 * export interface OriginTable { byBid: Map<number, OriginEntry>; style: MarkdownStyle }   // ほかの欄は実装裁量
 * export function createOriginTable(entries: OriginEntry[], style?: MarkdownStyle): OriginTable;
 * export type Stage = 1 | 2 | 3;
 * export interface Segment { stage: Stage; start: number; end: number; fellBack?: boolean; escaped?: boolean; warn?: boolean }
 * export function serializeMarkdown(doc: Node, origin: OriginTable, generation: Generation, opts?: { check?: boolean }): { text: string; segments: Segment[] };
 * //   segments[i] は doc.child(i) の書き出しの範囲と段
 * /** 形の比較(bid・raw(綴り)・setext・リンクの kind を見ない。front_matter / html_block / html_inline / definition の raw は改行の綴りを除いて比べる) *\/
 * export function shapeEqual(a: Node, b: Node): boolean;
 * ```
 *
 * ## 修正前に赤になる理由
 * - `src/editor/to-markdown.ts` ほかが無く、`prosemirror-*` / `prosemirror-schema-list` も依存に無いので import で落ちる
 */
import { describe, expect, test } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { wrapInList } from 'prosemirror-schema-list';

import { markdownSchema } from './markdown-schema';
import { parseMarkdownDocument } from './from-mdast';
import { FIXED_STYLE, createOriginTable, detectMarkdownStyle, serializeMarkdown, shapeEqual } from './to-markdown';
import { MD_FILES, blockPos, changedWithin, fixture, rng, safeCol, textSpots, variants } from './markdown.testkit';

// ---------------------------------------------------------------------------
// 道具
// ---------------------------------------------------------------------------

interface Session {
	src: string;
	state: EditorState;
	origin: ReturnType<typeof createOriginTable>;
	generation: ReturnType<typeof parseMarkdownDocument>['generation'];
	entries: ReturnType<typeof parseMarkdownDocument>['entries'];
}

function open(src: string): Session {
	const { doc, generation, entries } = parseMarkdownDocument(src);
	const origin = createOriginTable(entries);
	const state = EditorState.create({ doc, schema: markdownSchema });
	return { src, state, origin, generation, entries };
}

function out(s: Session) {
	return serializeMarkdown(s.state.doc, s.origin, s.generation);
}

function withTr(s: Session, build: (tr: import('prosemirror-state').Transaction) => import('prosemirror-state').Transaction): Session {
	return { ...s, state: s.state.apply(build(s.state.tr)) };
}

function select(s: Session, from: number, to = from): Session {
	return withTr(s, (tr) => tr.setSelection(TextSelection.create(tr.doc, from, to)));
}

function run(s: Session, command: (state: EditorState, dispatch?: (tr: import('prosemirror-state').Transaction) => void) => boolean): Session {
	let next = s.state;
	const ok = command(s.state, (tr) => (next = s.state.apply(tr)));
	expect(ok, 'the command ran').toBe(true);
	return { ...s, state: next };
}

/** 書き出しを読み直して、今の文書と最上位ブロックごとに同じ形か(契約6 の 4)。 */
function reparsesToSameShape(text: string, doc: import('prosemirror-model').Node): boolean {
	const back = parseMarkdownDocument(text).doc;
	if (back.childCount !== doc.childCount) return false;
	for (let i = 0; i < doc.childCount; i++) if (!shapeEqual(back.child(i), doc.child(i))) return false;
	return true;
}

/** 最上位ブロック `index` の最初の、code でない text の位置と中身。 */
function plainSpot(s: Session, index: number) {
	const spots = textSpots(s.state.doc, index).filter((t) => !t.inCode && t.text.length >= 2);
	return spots[0] ?? null;
}

// ---------------------------------------------------------------------------
// 契約6 — detectMarkdownStyle / FIXED_STYLE
// ---------------------------------------------------------------------------

describe('契約6 の 3: detectMarkdownStyle は文書の記号を数えて多いほうを選ぶ。例が無ければ FIXED_STYLE', () => {
	test('FIXED_STYLE の値', () => {
		expect(FIXED_STYLE).toEqual({ bullet: '-', emphasis: '*', strong: '*', fence: '`', rule: '-', bulletOrdered: '.', listItemIndent: 'one', tableAlign: true });
	});

	test.each([
		['bullet `*` が多い', '* a\n* b\n- c\n', { bullet: '*' }],
		['bullet `+` が多い', '+ a\n+ b\n+ c\n- d\n', { bullet: '+' }],
		['強調 `_` だけ', '_a_ and _b_\n', { emphasis: '_' }],
		['強い強調 `__` だけ', '__a__ and __b__\n', { strong: '_' }],
		['フェンス `~~~` が多い', '~~~\nx\n~~~\n\n~~~\ny\n~~~\n\n```\nz\n```\n', { fence: '~' }],
		['区切り線 `***`', '***\n\n***\n', { rule: '*' }],
		['順序つきの `)`', '1) a\n2) b\n', { bulletOrdered: ')' }],
		['例が無い → 固定', 'plain\n', FIXED_STYLE],
		['数が同じ → 固定', '* a\n\n- b\n', { bullet: '-' }],
	] as Array<[string, string, Partial<ReturnType<typeof detectMarkdownStyle>>]>)('%s', (_label, src, expected) => {
		expect(detectMarkdownStyle(src)).toEqual(expect.objectContaining(expected));
	});

	test('tableAlign: 表の行がそろっていれば true、そろっていなければ false', () => {
		expect(detectMarkdownStyle('| a   | b |\n| --- | - |\n| ccc | d |\n').tableAlign).toBe(true);
		expect(detectMarkdownStyle('| a | b |\n|---|---|\n| cccccc | d |\n').tableAlign).toBe(false);
	});

	test('フィクスチャの流儀: ai-report.md は `-` のリスト・notation.md は `*` のリスト', () => {
		expect(detectMarkdownStyle(fixture('ai-report.md')).bullet).toBe('-');
		expect(detectMarkdownStyle(fixture('notation.md')).bullet).toBe('*');
	});
});

// ---------------------------------------------------------------------------
// 契約6 の 1 — 1 段目(未編集=byte 等価・segments の段)
// ---------------------------------------------------------------------------

describe('契約6 の 1: 触っていないブロックは 1 段目で、切片が byte のまま', () => {
	test.each(MD_FILES)('%s: すべての segment が stage 1 で、書き出しが原文', (name) => {
		const s = open(fixture(name));
		const r = out(s);
		expect(r.text).toBe(s.src);
		expect(r.segments).toHaveLength(s.state.doc.childCount);
		expect(r.segments.every((seg) => seg.stage === 1)).toBe(true);
		r.segments.forEach((seg, i) => {
			expect(r.text.slice(seg.start, seg.end), `segment ${i}`).toBe(s.src.slice(s.entries[i]!.start, s.entries[i]!.end));
		});
	});

	test('check: false でも未編集の書き出しは同じ', () => {
		const s = open(fixture('notation.md'));
		expect(serializeMarkdown(s.state.doc, s.origin, s.generation, { check: false }).text).toBe(s.src);
	});
});

// ---------------------------------------------------------------------------
// AC-74-2 — 触っていないブロックの不変(決め打ち+乱数)
// ---------------------------------------------------------------------------

type Edit = 'insert' | 'delete' | 'strong';

function applyEdit(s: Session, block: number, kind: Edit, random: () => number): Session | null {
	const spot = plainSpot(s, block);
	if (!spot) return null;
	const col = safeCol(spot.text, 1 + Math.floor(random() * Math.max(1, spot.text.length - 2)));
	const at = spot.pos + col;
	switch (kind) {
		case 'insert':
			return withTr(s, (tr) => tr.insertText('あ', at));
		case 'delete': {
			const width = spot.text.charCodeAt(col) >= 0xd800 && spot.text.charCodeAt(col) <= 0xdbff ? 2 : 1;
			return withTr(s, (tr) => tr.delete(at, at + width));
		}
		case 'strong':
			if (spot.marks.includes('strong')) return null;
			return withTr(s, (tr) => tr.addMark(spot.pos, at, markdownSchema.marks.strong!.create()));
	}
}

function assertOutside(s0: Session, edited: Session, block: number, label: string) {
	const r = out(edited);
	const e = s0.entries[block]!;
	const w = changedWithin(s0.src, r.text, e.start, e.end);
	expect(w.ok, `${label}: 触ったブロック #${block}(${e.node.type.name})の外が byte 等価 — prefix ${w.prefix} start ${e.start} / suffix ${s0.src.length - w.suffix} end ${e.end}`).toBe(true);
	// ほかのブロックの segment は 1 段目のまま。
	r.segments.forEach((seg, i) => {
		if (i !== block) expect(seg.stage, `${label}: block ${i} stays stage 1`).toBe(1);
	});
	return r;
}

describe('AC-74-2: 打鍵(挿入・削除)と装飾を 1 ブロックに当てても、そのブロックの外は byte 等価', () => {
	const DETERMINISTIC: Array<{ name: string; block: number; kind: Edit }> = [
		{ name: 'ai-report.md', block: 2, kind: 'insert' },
		{ name: 'ai-report.md', block: 3, kind: 'delete' },
		{ name: 'ai-report.md', block: 4, kind: 'strong' },
		{ name: 'ai-report.md', block: 7, kind: 'insert' },
		{ name: 'notation.md', block: 0, kind: 'insert' },
		{ name: 'notation.md', block: 2, kind: 'strong' },
		{ name: 'notation.md', block: 9, kind: 'insert' },
		{ name: 'breakers.md', block: 1, kind: 'insert' },
		{ name: 'breakers.md', block: 3, kind: 'strong' },
		{ name: 'breakers.md', block: 8, kind: 'insert' },
		{ name: 'ime.md', block: 1, kind: 'delete' },
	];

	test.each(DETERMINISTIC)('$name #$block $kind(LF と CRLF)', ({ name, block, kind }) => {
		for (const [label, src] of variants(name, fixture(name)).filter(([l]) => l.endsWith(' LF') || l.endsWith(' CRLF'))) {
			const s0 = open(src);
			const edited = applyEdit(s0, block, kind, rng(1));
			if (!edited) continue; // そのブロックに打てる text が無い(表の区切りなど)=決め打ちの表の側の都合
			const r = assertOutside(s0, edited, block, label);
			expect(reparsesToSameShape(r.text, edited.state.doc), `${label}: 読み直しが同じ形`).toBe(true);
		}
	});

	test.each(MD_FILES)('%s: 乱数の種を固定した 60 か所(挿入・削除・太字)', (name) => {
		const src = fixture(name);
		const s0 = open(src);
		const random = rng(0x74_0002 ^ name.length);
		let done = 0;
		for (let i = 0; i < 200 && done < 60; i++) {
			const block = Math.floor(random() * s0.state.doc.childCount);
			const kind = (['insert', 'delete', 'strong'] as const)[Math.floor(random() * 3)]!;
			const edited = applyEdit(s0, block, kind, random);
			if (!edited) continue;
			done++;
			assertOutside(s0, edited, block, `${name} #${block} ${kind} (try ${i})`);
		}
		expect(done).toBeGreaterThan(20);
	});

	test('2 つのブロックを触ると、最初から最後までの外が byte 等価(間のブロックは触っていなくても範囲の中)', () => {
		const s0 = open(fixture('ai-report.md'));
		const a = plainSpot(s0, 2)!;
		const b = plainSpot(s0, 7)!;
		const edited = withTr(withTr(s0, (tr) => tr.insertText('X', a.pos + 1)), (tr) => tr.insertText('Y', b.pos + 1));
		const r = out(edited);
		const w = changedWithin(s0.src, r.text, s0.entries[2]!.start, s0.entries[7]!.end);
		expect(w.ok).toBe(true);
		expect(r.segments[2]!.stage).toBe(2);
		expect(r.segments[7]!.stage).toBe(2);
		for (const i of [0, 1, 3, 4, 5, 6, 8]) expect(r.segments[i]!.stage, `block ${i}`).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// AC-74-3 — 文字だけ触ったブロック(2 段目)とエスケープ
// ---------------------------------------------------------------------------

describe('AC-74-3: 文字だけ触ったブロックは、その文字の範囲の外が byte 等価(2 段目)', () => {
	/** 1 段落の文書: 原文の offset = PM の位置 - 1。 */
	function singleParagraph(src: string, at: number, insert: string) {
		const s0 = open(src);
		const spot = textSpots(s0.state.doc, 0)[0]!;
		const edited = withTr(s0, (tr) => tr.insertText(insert, spot.pos + at));
		return { s0, edited, r: out(edited) };
	}

	test.each([
		['段落', 'Hello world\n', 5, 'X', 'HelloX world\n'],
		['見出し', '## Title here\n', 5, 'X', '## TitleX here\n'],
		['リスト項目', '- item one\n- item two\n', 4, 'X', '- itemX one\n- item two\n'],
		['引用の段落', '> quoted text\n', 6, 'X', '> quotedX text\n'],
		['表のセル', '| a | bb |\n| --- | --- |\n| cc | dd |\n', 0, 'X', '| Xa | bb |\n| --- | --- |\n| cc | dd |\n'],
		['CRLF の段落', 'Hello world\r\n\r\nnext\r\n', 5, 'X', 'HelloX world\r\n\r\nnext\r\n'],
		['`*` 1 つは形を変えないのでエスケープしない', 'a b\n', 1, '*', 'a* b\n'],
		['`#` を行の途中に打ってもエスケープしない', 'a b\n', 1, '#', 'a# b\n'],
		['日本語', 'こんにちは世界\n', 5, 'X', 'こんにちはX世界\n'],
	])('%s: 1 文字の挿入は 2 段目で、その文字以外は byte 等価', (_label, src, at, insert, expected) => {
		const { edited, r } = singleParagraph(src, at, insert);
		expect(r.text).toBe(expected);
		expect(r.segments[0]!.stage).toBe(2);
		expect(r.segments[0]!.escaped ?? false).toBe(false);
		expect(reparsesToSameShape(r.text, edited.state.doc)).toBe(true);
	});

	test('soft break・hard break の綴りは触ったブロックの中でもそのまま(2 段目)', () => {
		const src = 'first line\n  second line  \nthird\\\nfourth\n';
		const s0 = open(src);
		const spot = textSpots(s0.state.doc, 0)[0]!;
		const r = out(withTr(s0, (tr) => tr.insertText('X', spot.pos + 5)));
		expect(r.text).toBe('firstX line\n  second line  \nthird\\\nfourth\n');
		expect(r.segments[0]!.stage).toBe(2);
	});

	test('リストの印と表の `|` と寄せの行は 2 段目で変わらない', () => {
		const list = open('* first item\n* second item\n');
		const spot = textSpots(list.state.doc, 0)[0]!;
		expect(out(withTr(list, (tr) => tr.insertText('X', spot.pos + 2))).text).toBe('* fiXrst item\n* second item\n');
		const table = open('| h1 | h2 |\n| :--- | ---: |\n| cell | x |\n');
		const cell = textSpots(table.state.doc, 0).find((t) => t.text === 'cell')!;
		const r = out(withTr(table, (tr) => tr.insertText('X', cell.pos + 1)));
		expect(r.text).toBe('| h1 | h2 |\n| :--- | ---: |\n| cXell | x |\n');
		expect(r.segments[0]!.stage).toBe(2);
	});

	test('削除も 2 段目: 文字を 1 つ消すと、その文字だけが消える', () => {
		const s0 = open('Hello world\n\nnext\n');
		const spot = textSpots(s0.state.doc, 0)[0]!;
		const r = out(withTr(s0, (tr) => tr.delete(spot.pos + 5, spot.pos + 6)));
		expect(r.text).toBe('Helloworld\n\nnext\n');
		expect(r.segments[0]!.stage).toBe(2);
	});

	test('2 段目の条件を満たさないブロック(エスケープ・文字参照を含む run)に打つと 3 段目に落ち、読み直しは同じ形・外は byte 等価', () => {
		const src = 'plain\n\nesc \\* and &amp; here\n\nafter\n';
		const s0 = open(src);
		const spot = textSpots(s0.state.doc, 1)[0]!;
		const edited = withTr(s0, (tr) => tr.insertText('X', spot.pos + 1));
		const r = out(edited);
		expect(r.segments[1]!.stage).toBe(3);
		expect(reparsesToSameShape(r.text, edited.state.doc)).toBe(true);
		expect(changedWithin(src, r.text, s0.entries[1]!.start, s0.entries[1]!.end).ok).toBe(true);
		expect(r.segments[0]!.stage).toBe(1);
		expect(r.segments[2]!.stage).toBe(1);
	});

	describe('仮の前提 2: 形を変える記号は、打った範囲だけをエスケープして 2 段目で差し替える', () => {
		test('段落に `*x*` → `\\*x\\*`(2 段目・escaped)。読み直すと文字のまま', () => {
			const { edited, r } = singleParagraph('a b\n', 1, '*x*');
			expect(r.text).toBe('a\\*x\\* b\n');
			expect(r.segments[0]!.stage).toBe(2);
			expect(r.segments[0]!.escaped).toBe(true);
			expect(reparsesToSameShape(r.text, edited.state.doc)).toBe(true);
			expect(parseMarkdownDocument(r.text).doc.child(0).textContent).toBe('a*x* b');
		});

		test('表のセルに `|` → `\\|` の 2 文字だけが増え、表のほかの行(区切りの行 `:---`)は byte のまま', () => {
			const src = '| 項目 | 件数 |\n| :--- | ---: |\n| テスト | 5115 |\n| 変異 | 30 |\n';
			const s0 = open(src);
			const cell = textSpots(s0.state.doc, 0).find((t) => t.text === 'テスト')!;
			const edited = withTr(s0, (tr) => tr.insertText('|', cell.pos + 1));
			const r = out(edited);
			expect(r.text).toBe('| 項目 | 件数 |\n| :--- | ---: |\n| テ\\|スト | 5115 |\n| 変異 | 30 |\n');
			expect(r.text.length - src.length).toBe(2);
			expect(r.segments[0]!.stage).toBe(2);
			expect(r.segments[0]!.escaped).toBe(true);
			expect(reparsesToSameShape(r.text, edited.state.doc)).toBe(true);
		});

		test('見出しに `[x](y)` → エスケープされて 2 段目。読み直すとリンクにならない', () => {
			const { edited, r } = singleParagraph('## Title here\n', 5, '[x](y)');
			expect(r.segments[0]!.stage).toBe(2);
			expect(r.segments[0]!.escaped).toBe(true);
			expect(reparsesToSameShape(r.text, edited.state.doc)).toBe(true);
			const back = parseMarkdownDocument(r.text).doc.child(0);
			expect(back.textContent).toBe('Title[x](y) here');
			let hasLink = false;
			back.descendants((n) => {
				if (n.marks.some((m) => m.type.name === 'link')) hasLink = true;
				return true;
			});
			expect(hasLink).toBe(false);
		});

		test('行頭に `# ` を打つ(段落が見出しになる形)→ エスケープして 2 段目か、3 段目。どちらでも読み直すと段落のまま', () => {
			const { edited, r } = singleParagraph('plain words\n', 0, '# ');
			expect([2, 3]).toContain(r.segments[0]!.stage);
			expect(reparsesToSameShape(r.text, edited.state.doc)).toBe(true);
			expect(parseMarkdownDocument(r.text).doc.child(0).type.name).toBe('paragraph');
			expect(parseMarkdownDocument(r.text).doc.child(0).textContent).toBe('# plain words');
		});

		test('CRLF の段落でも同じ(`*x*` → `\\*x\\*`・改行は \\r\\n のまま)', () => {
			const { r } = singleParagraph('a b\r\n\r\nc\r\n', 1, '*x*');
			expect(r.text).toBe('a\\*x\\* b\r\n\r\nc\r\n');
		});
	});
});

// ---------------------------------------------------------------------------
// AC-74-4 — 構造を触ったブロックと綴りの流儀(3 段目)
// ---------------------------------------------------------------------------

describe('AC-74-4: 構造を触ったブロックだけが 3 段目で書き直され、綴りは文書の流儀', () => {
	/** `block` の最初の text の `[from, to)` 文字を選び、`command` を当てる。 */
	function onRange(s: Session, block: number, from: number, to: number, command: Parameters<typeof run>[1]): Session {
		const spot = textSpots(s.state.doc, block)[0]!;
		return run(select(s, spot.pos + from, spot.pos + to), command);
	}

	const strong = (st: EditorState, d?: (tr: import('prosemirror-state').Transaction) => void) => toggleMark(markdownSchema.marks.strong!)(st, d);
	const em = (st: EditorState, d?: (tr: import('prosemirror-state').Transaction) => void) => toggleMark(markdownSchema.marks.em!)(st, d);

	test.each([
		['例の無い文書で Bold → `**`', 'plain words here\n', strong, 0, 5, '**plain** words here\n'],
		['`__` の文書で Bold → `__`', '__x__ and __y__\n\nplain words\n', strong, 0, 5, '__x__ and __y__\n\n__plain__ words\n'],
		['例の無い文書で Italic → `*`', 'plain words here\n', em, 0, 5, '*plain* words here\n'],
		['`_` の文書で Italic → `_`', '_x_ and _y_\n\nplain words\n', em, 0, 5, '_x_ and _y_\n\n_plain_ words\n'],
		['CRLF の文書で Bold → \\r\\n はそのまま', 'plain words\r\n\r\nnext\r\n', strong, 0, 5, '**plain** words\r\n\r\nnext\r\n'],
	] as Array<[string, string, Parameters<typeof run>[1], number, number, string]>)('%s', (_label, src, command, from, to, expected) => {
		const s0 = open(src);
		const block = s0.state.doc.childCount - 1 === 0 ? 0 : src.startsWith('plain') ? 0 : 1;
		const edited = onRange(s0, block, from, to, command);
		const r = out(edited);
		expect(r.text).toBe(expected);
		expect(r.segments[block]!.stage).toBe(3);
		expect(reparsesToSameShape(r.text, edited.state.doc)).toBe(true);
	});

	test('外すときは綴りを問わず外す: `__x__` も `**x**` も Bold で外れる', () => {
		for (const src of ['__word__ rest\n', '**word** rest\n']) {
			const s0 = open(src);
			const spot = textSpots(s0.state.doc, 0)[0]!; // 太字の text
			const edited = run(select(s0, spot.pos, spot.pos + 4), strong);
			const r = out(edited);
			expect(r.text).toBe('word rest\n');
			expect(reparsesToSameShape(r.text, edited.state.doc)).toBe(true);
		}
	});

	test('空の選択(カーソル)で toggleMark → stored mark だけで文書は変わらない(書き出しは原文)', () => {
		const s0 = open('plain words\n');
		const spot = textSpots(s0.state.doc, 0)[0]!;
		const edited = run(select(s0, spot.pos + 2), strong);
		expect(out(edited).text).toBe('plain words\n');
		expect(edited.state.storedMarks?.some((m) => m.type.name === 'strong')).toBe(true);
	});

	test('複数ブロックの選択に Bold → 触った 2 ブロックが 3 段目、外は byte 等価', () => {
		const src = 'intro\n\nfirst para\n\nsecond para\n\noutro\n';
		const s0 = open(src);
		const a = textSpots(s0.state.doc, 1)[0]!;
		const b = textSpots(s0.state.doc, 2)[0]!;
		const edited = run(select(s0, a.pos + 6, b.pos + 6), strong);
		const r = out(edited);
		expect(r.text).toBe('intro\n\nfirst **para**\n\n**second** para\n\noutro\n');
		expect(r.segments.map((x) => x.stage)).toEqual([1, 3, 3, 1]);
		expect(reparsesToSameShape(r.text, edited.state.doc)).toBe(true);
	});

	test('リストの中・引用の中の段落に Bold → その最上位ブロック(リスト / 引用)だけが 3 段目で、印は文書の流儀', () => {
		const list = open('* one two\n* three\n\nafter\n');
		const spotL = textSpots(list.state.doc, 0)[0]!;
		const rl = out(run(select(list, spotL.pos, spotL.pos + 3), strong));
		expect(rl.text).toBe('* **one** two\n* three\n\nafter\n');
		expect(rl.segments.map((x) => x.stage)).toEqual([3, 1]);
		const quote = open('> quoted words\n\nafter\n');
		const spotQ = textSpots(quote.state.doc, 0)[0]!;
		const rq = out(run(select(quote, spotQ.pos, spotQ.pos + 6), strong));
		expect(rq.text).toBe('> **quoted** words\n\nafter\n');
		expect(rq.segments.map((x) => x.stage)).toEqual([3, 1]);
	});

	test('Heading 2(setBlockType)→ `## `。同じ段の見出しを段落に戻すと記号が消える', () => {
		const s0 = open('intro\n\nplain words\n');
		const spot = textSpots(s0.state.doc, 1)[0]!;
		const h = run(select(s0, spot.pos + 1), setBlockType(markdownSchema.nodes.heading!, { level: 2 }));
		const r = out(h);
		expect(r.text).toBe('intro\n\n## plain words\n');
		expect(r.segments.map((x) => x.stage)).toEqual([1, 3]);
		const spot2 = textSpots(h.state.doc, 1)[0]!;
		const p = run(select(h, spot2.pos + 1), setBlockType(markdownSchema.nodes.paragraph!));
		expect(out(p).text).toBe('intro\n\nplain words\n');
	});

	test('setext の見出しを Bold で触ると、その段だけ setext で書き直される(契約6 の 3)', () => {
		const src = 'Title here\n==========\n\nbody\n';
		const s0 = open(src);
		const spot = textSpots(s0.state.doc, 0)[0]!;
		const r = out(run(select(s0, spot.pos, spot.pos + 5), strong));
		expect(r.text).toMatch(/^\*\*Title\*\* here\n=+\n\nbody\n$/);
		expect(r.segments[0]!.stage).toBe(3);
	});

	describe('仮の前提 3: Bulleted List は prosemirror-schema-list の wrapInList。印は文書の流儀', () => {
		const bullet = (st: EditorState, d?: (tr: import('prosemirror-state').Transaction) => void) => wrapInList(markdownSchema.nodes.bullet_list!)(st, d);

		test('`*` のリストの直後の段落をリストにすると、流儀の `*` ではつながってしまう(CommonMark は同じ印のリストを空行を挟んでも 1 つに読む)ので、つながらない綴り `-` で書き、読み直しが同じ形(bullet_list 2 つ)', () => {
			// 契約6: 綴りは文書の流儀に寄せるが、「読み直して一致」が先。前のブロックと一緒に読み直して落ちたら綴りを替える。
			const s0 = open('* a\n* b\n\nplain words\n');
			const spot = textSpots(s0.state.doc, 1)[0]!;
			const edited = run(select(s0, spot.pos + 1), bullet);
			const r = out(edited);
			expect(r.text).toBe('* a\n* b\n\n- plain words\n');
			expect(r.segments[1]!.stage).toBe(3);
			expect(reparsesToSameShape(r.text, edited.state.doc)).toBe(true);
			expect(parseMarkdownDocument(r.text).doc.childCount).toBe(2);
		});

		test('`*` のリストが隣に無ければ、文書の流儀の `*` で書く', () => {
			const s0 = open('* a\n* b\n\nintro paragraph\n\nplain words\n');
			const spot = textSpots(s0.state.doc, 2)[0]!;
			const edited = run(select(s0, spot.pos + 1), bullet);
			const r = out(edited);
			expect(r.text).toBe('* a\n* b\n\nintro paragraph\n\n* plain words\n');
			expect(reparsesToSameShape(r.text, edited.state.doc)).toBe(true);
		});

		test('例の無い文書では `-`', () => {
			const s0 = open('intro\n\nplain words\n');
			const spot = textSpots(s0.state.doc, 1)[0]!;
			const r = out(run(select(s0, spot.pos + 1), bullet));
			expect(r.text).toBe('intro\n\n- plain words\n');
		});

		test('`*` のリストの直後の段落を `+` の流儀で…ではなく、隣のリストとつながらない綴りで書く(周回0 の 7)', () => {
			// 文書の流儀は `*`(3 項目)だが、直前のブロックが `*` のリストなので `*` で書くと 1 つのリストにつながる。
			// 前後のブロックと一緒に読み直して落ちたら綴りを替える=結果が 2 つのリストのままで、読み直しが同じ形。
			const src = '* a\n* b\n* c\n\nplain words\n\nafter\n';
			const s0 = open(src);
			const spot = textSpots(s0.state.doc, 1)[0]!;
			const edited = run(select(s0, spot.pos + 1), bullet);
			const r = out(edited);
			expect(reparsesToSameShape(r.text, edited.state.doc), r.text).toBe(true);
			expect(parseMarkdownDocument(r.text).doc.childCount).toBe(3);
			expect(r.text.startsWith('* a\n* b\n* c\n\n')).toBe(true);
			expect(r.text.endsWith('\n\nafter\n')).toBe(true);
			expect(r.segments[1]!.warn ?? false).toBe(false);
		});
	});

	test('Quote(wrapIn blockquote)→ `> `。外は byte 等価', () => {
		const s0 = open('intro\n\nplain words\n\nafter\n');
		const spot = textSpots(s0.state.doc, 1)[0]!;
		const r = out(run(select(s0, spot.pos + 1), wrapIn(markdownSchema.nodes.blockquote!)));
		expect(r.text).toBe('intro\n\n> plain words\n\nafter\n');
		expect(r.segments.map((x) => x.stage)).toEqual([1, 3, 1]);
	});

	test('周回0 の 9: `~~a b c~~` の一部に太字 → 取り消し線が割れず、読み直しが同じ形', () => {
		const s0 = open('~~a b c~~ tail\n');
		const spot = textSpots(s0.state.doc, 0)[0]!; // 'a b c'(strike)
		const edited = run(select(s0, spot.pos + 2, spot.pos + 3), strong);
		const r = out(edited);
		expect(reparsesToSameShape(r.text, edited.state.doc), r.text).toBe(true);
		const back = parseMarkdownDocument(r.text).doc.child(0);
		const struck: string[] = [];
		back.forEach((n) => {
			if (n.marks.some((m) => m.type.name === 'strike')) struck.push(n.text ?? '');
		});
		expect(struck.join('')).toBe('a b c');
	});

	test('周回0 の 8・10: 行ごとのセルの数がそろっていない表のセルに太字 → 列を足さず、行ごとの数のまま書く', () => {
		const src = '| 列 | 値 |\n| --- | --- |\n| a | b | 余分 |\n| c |\n';
		const s0 = open(src);
		const cell = textSpots(s0.state.doc, 0).find((t) => t.text === 'a')!;
		const edited = run(select(s0, cell.pos, cell.pos + 1), strong);
		const r = out(edited);
		expect(r.segments[0]!.stage).toBe(3);
		const rows = r.text.trimEnd().split('\n');
		expect(rows).toHaveLength(4);
		expect(rows[0]!.split('|').length - 2).toBe(2);
		expect(rows[2]!.split('|').length - 2).toBe(3);
		expect(rows[3]!.split('|').length - 2).toBe(1);
		expect(rows[2]).toContain('**a**');
		expect(reparsesToSameShape(r.text, edited.state.doc), r.text).toBe(true);
	});

	test('周回0 の 10: そろっていない表の書き直しで列をそろえる詰め物を入れない(tableAlign=false)', () => {
		const src = '| 項目 | 件数 |\n|---|---|\n| テスト | 5115 |\n';
		const s0 = open(src);
		const cell = textSpots(s0.state.doc, 0).find((t) => t.text === 'テスト')!;
		const r = out(run(select(s0, cell.pos, cell.pos + 3), strong));
		expect(r.text).toBe('| 項目 | 件数 |\n|---|---|\n| **テスト** | 5115 |\n');
	});

	test('書き直したブロックの読み直しは、前後のブロックと一緒に読んでも同じ形(全フィクスチャの各ブロックに Bold)', () => {
		for (const name of MD_FILES) {
			const s0 = open(fixture(name));
			for (let i = 0; i < s0.state.doc.childCount; i++) {
				const spot = plainSpot(s0, i);
				if (!spot || spot.marks.includes('strong')) continue;
				const edited = withTr(s0, (tr) => tr.addMark(spot.pos, spot.pos + 1, markdownSchema.marks.strong!.create()));
				const r = out(edited);
				expect(reparsesToSameShape(r.text, edited.state.doc), `${name} #${i} ${spot.text.slice(0, 20)}`).toBe(true);
				expect(changedWithin(s0.src, r.text, s0.entries[i]!.start, s0.entries[i]!.end).ok, `${name} #${i} outside`).toBe(true);
				expect(r.segments[i]!.warn ?? false, `${name} #${i} warn`).toBe(false);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// shapeEqual
// ---------------------------------------------------------------------------

describe('shapeEqual: bid・綴りの属性(raw・setext・リンクの kind)を見ない', () => {
	test('同じ原文を 2 回読んだ文書は同じ形(bid が違っても)', () => {
		const a = parseMarkdownDocument(fixture('notation.md')).doc;
		const b = parseMarkdownDocument(fixture('notation.md')).doc;
		expect(a.child(0).attrs.bid).not.toBe(b.child(0).attrs.bid);
		for (let i = 0; i < a.childCount; i++) expect(shapeEqual(a.child(i), b.child(i)), `block ${i}`).toBe(true);
	});

	test('綴りだけ違う(`*b*` と `_b_`・setext と ATX・`<url>` と素の URL)は同じ形、文字が違えば違う形', () => {
		expect(shapeEqual(parseMarkdownDocument('a *b* c\n').doc.child(0), parseMarkdownDocument('a _b_ c\n').doc.child(0))).toBe(true);
		expect(shapeEqual(parseMarkdownDocument('T\n=\n').doc.child(0), parseMarkdownDocument('# T\n').doc.child(0))).toBe(true);
		expect(shapeEqual(parseMarkdownDocument('<https://a.example>\n').doc.child(0), parseMarkdownDocument('https://a.example\n').doc.child(0))).toBe(true);
		expect(shapeEqual(parseMarkdownDocument('a b\n').doc.child(0), parseMarkdownDocument('a c\n').doc.child(0))).toBe(false);
		expect(shapeEqual(parseMarkdownDocument('a\n').doc.child(0), parseMarkdownDocument('# a\n').doc.child(0))).toBe(false);
	});

	test('生 HTML のブロックの raw は改行の綴りを除いて比べる', () => {
		expect(shapeEqual(parseMarkdownDocument('<div>\nx\n</div>\n').doc.child(0), parseMarkdownDocument('<div>\r\nx\r\n</div>\r\n').doc.child(0))).toBe(true);
		expect(shapeEqual(parseMarkdownDocument('<div>\nx\n</div>\n').doc.child(0), parseMarkdownDocument('<div>\ny\n</div>\n').doc.child(0))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// reviewer の照合(2026-11-17)の追加 — T19・T22
// ---------------------------------------------------------------------------

describe('追加(T19・T22): 3 段目の `\\` の hard break・空白で囲った inline code', () => {
	test('T19: `\\` の hard break を含む段落を 3 段目で書き直しても、原文の綴り `\\` が残る(`  ` にならない)', () => {
		const src = 'alpha\\\nbeta\n';
		const s0 = open(src);
		const spot = textSpots(s0.state.doc, 0)[0]!; // 'alpha'
		const edited = run(select(s0, spot.pos, spot.pos + 5), (st, d) => toggleMark(markdownSchema.marks.strong!)(st, d));
		const r = out(edited);
		expect(r.segments[0]!.stage).toBe(3);
		expect(r.text).toBe('**alpha**\\\nbeta\n');
		expect(r.text).not.toContain('  \n');
		expect(reparsesToSameShape(r.text, edited.state.doc)).toBe(true);
	});

	test('T19 の対: 2 つの空白の hard break も、3 段目で綴りが残る', () => {
		const src = 'alpha  \nbeta\n';
		const s0 = open(src);
		const spot = textSpots(s0.state.doc, 0)[0]!;
		const r = out(run(select(s0, spot.pos, spot.pos + 5), (st, d) => toggleMark(markdownSchema.marks.strong!)(st, d)));
		expect(r.text).toBe('**alpha**  \nbeta\n');
		expect(r.text).not.toContain('\\\n');
	});

	test('T22: 空白で囲った inline code(`` `` ` `` ``)の中身を直すと 2 段目で、両端の空白と `` `` `` はそのまま', () => {
		const src = 'use `` ` `` here\n';
		const s0 = open(src);
		const code = textSpots(s0.state.doc, 0).find((t) => t.marks.includes('code'))!;
		expect(code.text).toBe('`');
		const edited = withTr(s0, (tr) => tr.insertText('x', code.pos + 1));
		const r = out(edited);
		expect(r.text).toBe('use `` `x `` here\n');
		expect(r.segments[0]!.stage).toBe(2);
		expect(reparsesToSameShape(r.text, edited.state.doc)).toBe(true);
	});

	test('T22 の対: 普通の inline code の中身を直しても 2 段目', () => {
		const s0 = open('use `code` here\n');
		const code = textSpots(s0.state.doc, 0).find((t) => t.marks.includes('code'))!;
		const r = out(withTr(s0, (tr) => tr.insertText('x', code.pos + 4)));
		expect(r.text).toBe('use `codex` here\n');
		expect(r.segments[0]!.stage).toBe(2);
	});
});
