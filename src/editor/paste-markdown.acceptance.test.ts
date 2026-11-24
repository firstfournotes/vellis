/**
 * 要件#74 第3段 3-5 — Markdown として貼り付け(契約17 の (t)・由谷の決定 2026-11-17 昼 3-17: 貼り付けは文字のまま。貼った直後に Markdown として
 * 読めるときだけ「Paste as Markdown」の札を出し、押すと構造に読み直す=undo 1 段で文字に戻る)。正本: docs/review/req74-stage34-prep.md の (A) 7 と
 * (B) AC-74-57。ここは純関数の分。札と面の配線は MarkdownEditor.wiring の「3-5」。
 *
 * ## 対応する受け入れ基準
 * - AC-74-57 (4)(6)(7) の純関数の分: 札を出す判定(Markdown として読んでも文字のときと同じなら出さない)・先頭の `---` でも front matter にならない・
 *   文書に `[^1]` があるとき `[^1]` を含む文字を読むと入れた側が `[^2]`(参照と定義の両方)・段落 1 つならインライン(新しいブロックを作らない)
 *
 * ## 確定契約(implementer はこれに従う=推奨名は stage34-prep の (A) 7)
 *
 * ```ts
 * // --- src/editor/paste-markdown.ts(新規)
 * export const PASTE_AS_MARKDOWN_TESTID = 'paste-as-markdown';
 * export const PASTE_AS_MARKDOWN_LABEL = 'Paste as Markdown';
 * /** 貼った文字を Markdown として読んだ結果が、文字として入れた結果(plainTextParagraphs)と違うか=札を出すか。 *\/
 * export function shouldOfferMarkdownPaste(text: string): boolean;
 * /** 文字を from-mdast と同じ remark の道(remark-parse + remark-gfm + remarkVellisAlert)で読んだ最上位ブロック。front matter は作らない
 *  *  (先頭の --- は remark が読むとおり)。doc があれば、脚注のラベルが doc に既にあるものは doc でまだ使っていない最小の数字に振り直す
 *  *  (参照と定義の両方)。新しいノードは系譜なし(bid: null)。 *\/
 * export function parseMarkdownFragment(text: string, doc?: PMNode): PMNode[];
 * ```
 *
 * ## 修正前に赤になる理由
 * - `src/editor/paste-markdown.ts` が無いので import で落ちる
 */
import { describe, expect, test } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { createMarkdownDocument } from './markdown-document';
import { PASTE_AS_MARKDOWN_LABEL, PASTE_AS_MARKDOWN_TESTID, parseMarkdownFragment, shouldOfferMarkdownPaste } from './paste-markdown';

function labelsOf(nodes: PMNode[]): string[] {
	const out: string[] = [];
	for (const n of nodes) {
		if (n.type.name === 'footnote_definition') out.push(`def:${n.attrs.label}`);
		n.descendants((c) => {
			if (c.type.name === 'footnote_reference') out.push(`ref:${c.attrs.label}`);
			return true;
		});
	}
	return out;
}

describe('AC-74-57: 定数', () => {
	test("testid 'paste-as-markdown'・文言 'Paste as Markdown'(英語)", () => {
		expect(PASTE_AS_MARKDOWN_TESTID).toBe('paste-as-markdown');
		expect(PASTE_AS_MARKDOWN_LABEL).toBe('Paste as Markdown');
	});
});

describe('AC-74-57 (1)(4): shouldOfferMarkdownPaste=読むと構造になるときだけ', () => {
	test.each([
		['## a\n\n- b', true],
		['**x**', true],
		['[link](https://e.example)', true],
		['| a | b |\n| - | - |\n| c | d |', true],
		['> quote', true],
		['1. one\n2. two', true],
		['`code`', true],
		['see[^1]\n\n[^1]: note', true],
	])('%j → %s(構造になる)', (text, expected) => {
		expect(shouldOfferMarkdownPaste(text)).toBe(expected);
	});

	test.each([
		['abc', false],
		['plain words here', false],
		['first\n\nsecond', false],
		['line one\nline two', false],
		['', false],
		['   ', false],
		['2 * 3 * 4', false],
	])('%j → %s(文字と同じ=札を出さない)', (text, expected) => {
		expect(shouldOfferMarkdownPaste(text)).toBe(expected);
	});
});

describe('AC-74-57 (2)(3)(6)(7): parseMarkdownFragment', () => {
	test("'## a\\n\\n- b' → 見出し 2 と箇条書き(bid は null=系譜なし)", () => {
		const nodes = parseMarkdownFragment('## a\n\n- b');
		expect((nodes as PMNode[]).map((n) => n.type.name)).toEqual(['heading', 'bullet_list']);
		expect(nodes[0]!.attrs.level).toBe(2);
		expect(nodes[0]!.textContent).toBe('a');
		expect(nodes[1]!.child(0).textContent).toBe('b');
		for (const n of nodes as PMNode[]) expect(n.attrs.bid ?? null, n.type.name).toBeNull();
	});

	test("'**x**' → 段落 1 つ(中身は strong の x)=呼び手が今の textblock にインラインで入れる", () => {
		const nodes = parseMarkdownFragment('**x**');
		expect(nodes).toHaveLength(1);
		expect(nodes[0]!.type.name).toBe('paragraph');
		expect(nodes[0]!.childCount).toBe(1);
		expect(nodes[0]!.child(0).text).toBe('x');
		expect((nodes[0] as PMNode).child(0).marks.map((m) => m.type.name)).toEqual(['strong']);
	});

	test("先頭が '---' でも front matter にならない(remark が読むとおりの区切り線・setext)", () => {
		const nodes = parseMarkdownFragment('---\ntitle: x\n---\n');
		expect((nodes as PMNode[]).some((n) => n.type.name === 'front_matter')).toBe(false);
		expect(nodes[0]!.type.name).toBe('horizontal_rule');
		expect((nodes as PMNode[]).some((n) => n.type.name === 'heading' && n.textContent === 'title: x')).toBe(true);
	});

	test('文書に [^1] があるとき、[^1] を含む文字の脚注は [^2] に(参照と定義の両方)。文書が無ければそのまま', () => {
		const doc = createMarkdownDocument('Text[^1] here.\n\n[^1]: first.\n', { uri: 'file:///Users/a/n.md', readOnly: false }).state.doc;
		const renumbered = parseMarkdownFragment('see[^1]\n\n[^1]: note', doc);
		expect(labelsOf(renumbered).sort()).toEqual(['def:2', 'ref:2']);
		const plain = parseMarkdownFragment('see[^1]\n\n[^1]: note');
		expect(labelsOf(plain).sort()).toEqual(['def:1', 'ref:1']);
	});

	test('文書に [^1] と [^2] があれば [^3](まだ使っていない最小の数字)。文書に無いラベルはそのまま', () => {
		const doc = createMarkdownDocument('A[^1] B[^2].\n\n[^1]: one.\n\n[^2]: two.\n', { uri: 'file:///Users/a/n.md', readOnly: false }).state.doc;
		expect(labelsOf(parseMarkdownFragment('x[^1]\n\n[^1]: n', doc)).sort()).toEqual(['def:3', 'ref:3']);
		expect(labelsOf(parseMarkdownFragment('x[^note]\n\n[^note]: n', doc)).sort()).toEqual(['def:note', 'ref:note']);
	});

	test('表・引用・code fence・alert も読める(from-mdast と同じ道)', () => {
		const nodes = parseMarkdownFragment('> [!NOTE]\n> hi\n\n| a |\n| - |\n| b |\n\n```ts\nlet a = 1\n```\n');
		expect((nodes as PMNode[]).map((n) => n.type.name)).toEqual(['alert', 'table', 'code_block']);
		expect(nodes[0]!.attrs.kind).toBe('note');
		expect(nodes[2]!.attrs.lang).toBe('ts');
	});

	test('空や空白だけは何も返さない', () => {
		expect(parseMarkdownFragment('')).toEqual([]);
		expect(parseMarkdownFragment('   \n')).toEqual([]);
	});
});
