/**
 * 要件#74 第2段 2-1 の受け入れテスト(docs/requirements/req-74.md)— スキーマと読み込み
 * (契約2・7・15・第2段の作り(案)の項目 2〜4。unit プロジェクト・DOM なし)
 *
 * ## 仮の前提(由谷の確認待ち=「第2段の準備で出た判断」1〜3 を推奨の答えと仮定。違えばこのファイルは捨てる)
 * - 判断 1: 原文の切片は Node の属性に持たず、属性は系譜の番号 `bid` だけ。範囲は横の表(origin)
 * - 判断 2: 2 段目の検算に落ちたら、打った文字だけをエスケープして 2 段目で再試行する(to-markdown.acceptance.test.ts)
 * - 判断 3: `prosemirror-schema-list` を直接の依存に足す(to-markdown.acceptance.test.ts の AC-74-4)
 * - 受け入れ基準「第2段」の書き直し案(AC-74-1 の関数名・フィクスチャの BOM+front matter / BOM+CRLF / CR だけ)も推奨どおり
 *
 * ## 確定契約(implementer はこれに従う=推奨名は req-74.md 第2段の作り(案)2〜4。無いものは test-writer が固定)
 *
 * ```ts
 * // --- src/editor/markdown-schema.ts(新規)
 * export const markdownSchema: Schema;
 * //   nodes: doc(block+)・paragraph・heading(level・setext)・blockquote・alert(kind)・bullet_list(spread)・
 * //          ordered_list(start・spread)・list_item(checked=null|true|false・spread)・code_block(lang・meta・code: true・marks '')・
 * //          horizontal_rule・table / table_row / table_header / table_cell(prosemirror-tables・セルは inline*・align)・
 * //          footnote_definition(label)・front_matter(atom・raw)・html_block(atom・raw)・definition(atom・selectable: false・raw・
 * //          identifier・label・url・title)・text・image(atom・src・alt・title・ref・refType)・footnote_reference(atom・label)・
 * //          html_inline(atom・raw)・hard_break(raw)・soft_break(raw・leafText ' ')
 * //   marks: link(href・title・kind・identifier・label・referenceType)・strong・em・strike・code(他の mark を締め出さない)
 * //   最上位に来られるブロック(group 'block' の全ノード・table を含む)は attrs.bid(既定 null)を持つ
 *
 * // --- src/editor/from-mdast.ts(新規・純関数)
 * export interface Run { start: number; end: number; value: string; eligible: boolean; eol?: string }
 * export interface Generation { id: number; src: string; count: number; bom: boolean; dominantEol: string; endsWithEol: boolean }
 * export interface OriginEntry { node: Node; src: string; start: number; end: number; index: number; generation: Generation; runs: Run[]; tasks?: { start: number; value: string }[] }
 * export function parseMarkdownDocument(src: string): { doc: Node; generation: Generation; entries: OriginEntry[] }
 * //   entries[i] は doc.child(i) に対応(index = i・node === doc.child(i))。start / end は src の中の切片(BOM・front matter の
 * //   前置きを含む offset)。閲覧と同じ remark-parse → remark-gfm → remarkVellisAlert(src/markdown/plugins/alert.ts を import)
 * ```
 *
 * ## 修正前に赤になる理由
 * - `src/editor/markdown-schema.ts`・`src/editor/from-mdast.ts` が無く、`prosemirror-*` も依存に無いので import で落ちる
 */
import { describe, expect, test } from 'vitest';
import { Node as PMNode } from 'prosemirror-model';

import { markdownSchema } from './markdown-schema';
import { parseMarkdownDocument } from './from-mdast';
import { BOM, MD_FILES, blockNames, fixture, variants } from './markdown.testkit';

// ---------------------------------------------------------------------------
// 契約2 — スキーマ(項目 2)
// ---------------------------------------------------------------------------

const BLOCK_NODES = [
	'paragraph',
	'heading',
	'blockquote',
	'alert',
	'bullet_list',
	'ordered_list',
	'code_block',
	'horizontal_rule',
	'table',
	'footnote_definition',
	'front_matter',
	'html_block',
	'definition',
];
const INLINE_NODES = ['text', 'image', 'footnote_reference', 'html_inline', 'hard_break', 'soft_break'];
const MARKS = ['link', 'strong', 'em', 'strike', 'code'];

describe('契約2: markdownSchema のノードと mark', () => {
	test('ノードの名前(ブロック・インライン・表の 4 つ・list_item)が揃っている', () => {
		const names = Object.keys(markdownSchema.nodes);
		for (const n of [...BLOCK_NODES, ...INLINE_NODES, 'doc', 'list_item', 'table_row', 'table_header', 'table_cell']) {
			expect(names, n).toContain(n);
		}
	});

	test('mark の名前', () => {
		expect(Object.keys(markdownSchema.marks).sort()).toEqual([...MARKS].sort());
	});

	test('最上位に来られるブロック(table を含む)はすべて bid を持ち、既定は null', () => {
		for (const n of BLOCK_NODES) {
			const type = markdownSchema.nodes[n]!;
			expect(type.spec.attrs?.bid, `${n}.attrs.bid`).toBeDefined();
			expect(type.spec.attrs!.bid!.default, `${n}.attrs.bid.default`).toBeNull();
			expect(type.isBlock, `${n} is a block`).toBe(true);
		}
	});

	test('doc は block+ で、最上位に来られるのはブロックのノードだけ(list_item・table_row・セルは最上位に来ない)', () => {
		const doc = markdownSchema.nodes.doc!;
		for (const n of BLOCK_NODES) expect(doc.contentMatch.matchType(markdownSchema.nodes[n]!), `doc can hold ${n}`).not.toBeNull();
		for (const n of ['list_item', 'table_row', 'table_header', 'table_cell', 'text']) {
			expect(doc.contentMatch.matchType(markdownSchema.nodes[n]!), `doc must not hold ${n}`).toBeNull();
		}
	});

	test('atom のノード(front_matter・html_block・definition・image・footnote_reference・html_inline)と、definition は選べない', () => {
		for (const n of ['front_matter', 'html_block', 'definition', 'image', 'footnote_reference', 'html_inline']) {
			expect(markdownSchema.nodes[n]!.isAtom, `${n} is an atom`).toBe(true);
		}
		expect(markdownSchema.nodes.definition!.spec.selectable).toBe(false);
	});

	test('code_block は code: true で mark を持たない', () => {
		const cb = markdownSchema.nodes.code_block!;
		expect(cb.spec.code).toBe(true);
		expect(cb.allowsMarkType(markdownSchema.marks.strong!)).toBe(false);
		expect(cb.allowsMarkType(markdownSchema.marks.code!)).toBe(false);
	});

	test('code の mark は他の mark を締め出さない(~~`x`~~・**`x`**・[`x`](u) が読める=周回0 の 4)', () => {
		const code = markdownSchema.marks.code!;
		for (const other of ['strike', 'strong', 'link', 'em']) {
			expect(code.excludes(markdownSchema.marks[other]!), `code excludes ${other}`).toBe(false);
		}
	});

	test('属性: heading(level・setext)・list_item(checked・spread)・ordered_list(start)・alert(kind)・hard_break / soft_break(raw)・link(kind)', () => {
		const attrs = (n: string) => Object.keys(markdownSchema.nodes[n]!.spec.attrs ?? {});
		expect(attrs('heading')).toEqual(expect.arrayContaining(['bid', 'level', 'setext']));
		expect(attrs('list_item')).toEqual(expect.arrayContaining(['checked', 'spread']));
		expect(markdownSchema.nodes.list_item!.spec.attrs!.checked!.default).toBeNull();
		expect(attrs('ordered_list')).toEqual(expect.arrayContaining(['bid', 'start', 'spread']));
		expect(attrs('alert')).toEqual(expect.arrayContaining(['bid', 'kind']));
		expect(attrs('hard_break')).toContain('raw');
		expect(attrs('soft_break')).toContain('raw');
		expect(Object.keys(markdownSchema.marks.link!.spec.attrs ?? {})).toEqual(expect.arrayContaining(['href', 'title', 'kind']));
		expect(markdownSchema.nodes.soft_break!.spec.leafText?.(markdownSchema.nodes.soft_break!.create())).toBe(' ');
	});
});

// ---------------------------------------------------------------------------
// 契約2・7・15 — 読み込み(項目 4)
// ---------------------------------------------------------------------------

function parse(src: string) {
	return parseMarkdownDocument(src);
}

describe('項目 4: parseMarkdownDocument の entries は最上位ブロックと 1 対 1 で、切片は原文の範囲', () => {
	test.each(MD_FILES)('%s(LF): entries[i].node === doc.child(i)・index・切片の順', (name) => {
		const src = fixture(name);
		const { doc, entries, generation } = parse(src);
		expect(doc).toBeInstanceOf(PMNode);
		expect(entries).toHaveLength(doc.childCount);
		let last = 0;
		entries.forEach((e, i) => {
			expect(e.node, `entries[${i}].node`).toBe(doc.child(i));
			expect(e.index).toBe(i);
			expect(e.start, `entries[${i}].start`).toBeGreaterThanOrEqual(last);
			expect(e.end, `entries[${i}].end`).toBeGreaterThanOrEqual(e.start);
			expect(e.generation).toBe(generation);
			last = e.end;
		});
		expect(generation.src).toBe(src);
		expect(generation.count).toBe(doc.childCount);
		expect(generation.bom).toBe(false);
		expect(generation.dominantEol).toBe('\n');
		expect(generation.endsWithEol).toBe(src.endsWith('\n'));
	});

	test('各ブロックの切片を繋ぐと、間の空白を除いた原文になる(切片が重ならず、原文の文字を取りこぼさない)', () => {
		for (const name of MD_FILES) {
			const src = fixture(name);
			const { entries } = parse(src);
			const joined = entries.map((e) => src.slice(e.start, e.end)).join('');
			expect(joined.replace(/\s+/g, ''), name).toBe(src.replace(/\s+/g, ''));
		}
	});

	test('すべての bid が最上位ブロックで一意に振られている(null でない)', () => {
		const { doc } = parse(fixture('breakers.md'));
		const bids: number[] = [];
		doc.forEach((c) => bids.push(c.attrs.bid as number));
		expect(bids.every((b) => typeof b === 'number')).toBe(true);
		expect(new Set(bids).size).toBe(bids.length);
	});

	test('BOM: 剥がして読み、offset に 1 を足す(`\\uFEFF# a` の見出しの切片は 1〜4)。generation.bom が真', () => {
		const { doc, entries, generation } = parse(`${BOM}# a\n\nb\n`);
		expect(generation.bom).toBe(true);
		expect(blockNames(doc)).toEqual(['heading', 'paragraph']);
		expect(entries[0]!.start).toBe(1);
		expect(entries[0]!.end).toBe(4);
		expect(`${BOM}# a\n\nb\n`.slice(entries[0]!.start, entries[0]!.end)).toBe('# a');
		expect(`${BOM}# a\n\nb\n`.slice(entries[1]!.start, entries[1]!.end)).toBe('b');
	});

	test('front matter: 先頭の --- 〜 --- が front_matter(atom・raw=原文の綴り)になり、setext の見出しにならない', () => {
		const src = '---\ntitle: x\n---\n\n# h\n';
		const { doc, entries } = parse(src);
		expect(blockNames(doc)).toEqual(['front_matter', 'heading']);
		expect(doc.child(0).attrs.raw).toBe('---\ntitle: x\n---');
		expect(src.slice(entries[0]!.start, entries[0]!.end)).toBe('---\ntitle: x\n---');
		expect(doc.child(1).attrs.level).toBe(1);
	});

	test('BOM の後ろの front matter も検出する(周回0 の 2)', () => {
		const src = `${BOM}---\ntitle: x\n---\n\nbody\n`;
		const { doc, entries, generation } = parse(src);
		expect(generation.bom).toBe(true);
		expect(blockNames(doc)).toEqual(['front_matter', 'paragraph']);
		expect(src.slice(entries[0]!.start, entries[0]!.end)).toBe('---\ntitle: x\n---');
		expect(src.slice(entries[1]!.start, entries[1]!.end)).toBe('body');
	});

	test('先頭が HTML の注釈で、その次の --- 〜 --- は front matter にしない(判断 11 の推奨=契約7 のまま)', () => {
		const src = '<!-- template: x -->\n---\ntitle: y\n---\n\nbody\n';
		const { doc } = parse(src);
		expect(blockNames(doc)[0]).toBe('html_block');
		expect(blockNames(doc)).not.toContain('front_matter');
	});

	test('段落の中の改行: soft_break(raw=行末の空白+改行+次の行の字下げ)。見た目の文字は空白 1 つ', () => {
		const src = 'a \n  b\n\tc\n';
		const { doc } = parse(src);
		const p = doc.child(0);
		const kinds: string[] = [];
		const raws: string[] = [];
		p.forEach((n) => {
			kinds.push(n.type.name);
			if (n.type.name === 'soft_break') raws.push(n.attrs.raw as string);
		});
		expect(kinds).toEqual(['text', 'soft_break', 'text', 'soft_break', 'text']);
		expect(raws).toEqual([' \n  ', '\n\t']);
		expect(p.textContent).toBe('a b c');
	});

	test('CRLF の段落の中の改行は soft_break の raw に \\r\\n を持つ(契約15)', () => {
		const { doc } = parse('a\r\nb\r\n');
		const raws: string[] = [];
		doc.child(0).forEach((n) => {
			if (n.type.name === 'soft_break') raws.push(n.attrs.raw as string);
		});
		expect(raws).toEqual(['\r\n']);
	});

	test('hard break の綴り(2 つの空白・バックスラッシュ)を raw に持つ', () => {
		const { doc } = parse('a  \nb\\\nc\n');
		const raws: string[] = [];
		doc.child(0).forEach((n) => {
			if (n.type.name === 'hard_break') raws.push(n.attrs.raw as string);
		});
		expect(raws).toEqual(['  \n', '\\\n']);
	});

	test('アラート: kind を持ち、表題の段落は読まない(最初の段落は印の行を除いた本文)', () => {
		const { doc } = parse('> [!WARNING]\n> body line\n');
		const alert = doc.child(0);
		expect(alert.type.name).toBe('alert');
		expect(alert.attrs.kind).toBe('warning');
		expect(alert.childCount).toBe(1);
		expect(alert.child(0).type.name).toBe('paragraph');
		expect(alert.child(0).textContent).toBe('body line');
	});

	test('インラインの生 HTML: 開きタグから対応する閉じタグまでが 1 つの html_inline(raw=原文の切片)。閉じが無いものは単独', () => {
		const src = 'x <span style="c">red <b>b</b></span> y <br> z\n';
		const { doc } = parse(src);
		const inl: string[] = [];
		doc.child(0).forEach((n) => {
			if (n.type.name === 'html_inline') inl.push(n.attrs.raw as string);
		});
		expect(inl).toEqual(['<span style="c">red <b>b</b></span>', '<br>']);
	});

	test('生 HTML のブロックは html_block(raw=原文の綴り)、参照定義は definition(raw・identifier・url)', () => {
		const src = '<div>\n  <p>x</p>\n</div>\n\n[ref]: https://example.com "t"\n';
		const { doc } = parse(src);
		expect(blockNames(doc)).toEqual(['html_block', 'definition']);
		expect(doc.child(0).attrs.raw).toBe('<div>\n  <p>x</p>\n</div>');
		expect(doc.child(1).attrs.raw).toBe('[ref]: https://example.com "t"');
		expect(doc.child(1).attrs.identifier).toBe('ref');
		expect(doc.child(1).attrs.url).toBe('https://example.com');
	});

	test('GFM の素の URL(autolink literal)の link は kind=literal、<…> は autolink、[x](y) は inline、[x][r] は reference', () => {
		const src = 'see https://codemirror.net and <https://prosemirror.net> and [x](https://a.example) and [y][r]\n\n[r]: https://b.example\n';
		const { doc } = parse(src);
		const kinds: string[] = [];
		doc.child(0).forEach((n) => {
			const link = n.marks.find((m) => m.type.name === 'link');
			if (link) kinds.push(link.attrs.kind as string);
		});
		expect(kinds).toEqual(['literal', 'autolink', 'inline', 'reference']);
	});

	test('code fence の中身は PM の中では \\n で持ち、原文の改行の綴りを run の eol に持つ(CRLF)', () => {
		const src = '```ts\r\nconst a = 1;\r\nconst b = 2;\r\n```\r\n';
		const { doc, entries } = parse(src);
		expect(doc.child(0).type.name).toBe('code_block');
		expect(doc.child(0).attrs.lang).toBe('ts');
		expect(doc.child(0).textContent).toBe('const a = 1;\nconst b = 2;');
		expect(entries[0]!.runs.some((r) => r.eol === '\r\n')).toBe(true);
	});

	test('runs: 原文の切片と値が同じなら eligible、エスケープ・文字参照を含めば eligible でない', () => {
		const src = 'plain words\n\nesc \\* and &amp; here\n';
		const { entries } = parse(src);
		expect(entries[0]!.runs.length).toBeGreaterThan(0);
		expect(entries[0]!.runs.every((r) => r.eligible)).toBe(true);
		expect(entries[0]!.runs[0]!.value).toBe('plain words');
		expect(src.slice(entries[0]!.runs[0]!.start, entries[0]!.runs[0]!.end)).toBe('plain words');
		expect(entries[1]!.runs.some((r) => !r.eligible)).toBe(true);
	});

	test('tasks: 印のある list_item ごとに印の 1 文字の位置と値', () => {
		const src = '- [ ] open\n- [x] done\n- plain\n';
		const { doc, entries } = parse(src);
		const list = doc.child(0);
		expect(list.child(0).attrs.checked).toBe(false);
		expect(list.child(1).attrs.checked).toBe(true);
		expect(list.child(2).attrs.checked).toBeNull();
		const tasks = entries[0]!.tasks ?? [];
		expect(tasks).toHaveLength(2);
		expect(src[tasks[0]!.start]).toBe(' ');
		expect(tasks[0]!.value).toBe(' ');
		expect(src[tasks[1]!.start]).toBe('x');
		expect(tasks[1]!.value).toBe('x');
	});

	test('参照定義はリスト項目の中にも現れる(周回0 の 5)= breakers.md の `- [inlist]: …` が definition として読める', () => {
		const { doc } = parse(fixture('breakers.md'));
		let defs = 0;
		doc.descendants((n) => {
			if (n.type.name === 'definition') defs++;
			return true;
		});
		expect(defs).toBeGreaterThanOrEqual(1);
	});

	test('行ごとのセルの数がそろっていない表も読める(周回0 の 8)', () => {
		const { doc } = parse('| 列 | 値 |\n| --- | --- |\n| a | b | 余分 |\n| c |\n');
		const table = doc.child(0);
		expect(table.type.name).toBe('table');
		const cells: number[] = [];
		table.forEach((row) => cells.push(row.childCount));
		expect(cells[0]).toBe(2);
		expect(cells.length).toBe(3);
	});

	test('すべての変種(7+1)のすべてのフィクスチャが例外なく読め、ブロックの名前の列が LF と同じ', () => {
		for (const name of MD_FILES) {
			const src = fixture(name);
			const baseline = blockNames(parse(src).doc);
			for (const [label, v] of variants(name, src)) {
				const { doc, generation } = parse(v);
				const names = blockNames(doc);
				const expected = label.includes('front matter') ? ['front_matter', ...baseline] : baseline;
				expect(names, label).toEqual(expected);
				expect(generation.bom, label).toBe(v.startsWith(BOM));
			}
		}
	});
});

// ---------------------------------------------------------------------------
// reviewer の照合(2026-11-17)の追加 — T21: 改行の数が同じなら LF(第1段の detectLineEnding と同じ規則)
// ---------------------------------------------------------------------------

describe('追加(T21): generation.dominantEol は多いほうの改行。LF と CRLF が同数なら \\n', () => {
	test.each([
		['LF 1・CRLF 1 → \\n', 'a\nb\r\n', '\n'],
		['CR 1・CRLF 1 → \\n', 'a\rb\r\n', '\n'],
		['LF 1・CR 1 → \\n', 'a\nb\r', '\n'],
		['CRLF 2・LF 1 → \\r\\n', 'a\r\nb\r\nc\n', '\r\n'],
		['CR 2・LF 1 → \\r', 'a\rb\rc\n', '\r'],
		['改行なし → \\n', 'abc', '\n'],
		['空 → \\n', '', '\n'],
	])('%s', (_label, src, eol) => {
		expect(parse(src).generation.dominantEol).toBe(eol);
	});

	test('同数の文書(LF 1・CRLF 1)でブロックを足したときの改行は \\n(文書モデルの側=AC-74-5 の規則)', () => {
		expect(parse('a\nb\r\n').generation.dominantEol).toBe('\n');
	});
});
