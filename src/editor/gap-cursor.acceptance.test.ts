/**
 * 要件#74 第3段 3-1 — gap cursor(契約20 の第3段の部品・由谷の決定 2026-11-17 昼・3-18 の依存 `prosemirror-gapcursor` ^1.4.1)。
 * 正本: docs/review/req74-stage34-prep.md の (A) 2 と (B) AC-74-58 の (2)(3)。(1) の「面の plugin にある」は
 * `MarkdownEditor.wiring.test.ts` の 3-1 の describe、(4) のドロップは 3-5 で書く。
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * ```ts
 * // --- src/editor/gap-cursor.ts(新規)
 * import { gapCursor, GapCursor } from 'prosemirror-gapcursor';
 * /** gapCursor() と Vellis の制約(front matter の前・definition の隣に gap を置かない)。面の plugin に展開して足す。 *\/
 * export function markdownGapCursor(): Plugin[];
 * //   gap が立つ場所=2 つの atom / 非 textblock のブロック(表・code fence・mermaid・生 HTML の塊・区切り線)の間、
 * //   文書の先頭がそれらのときその前、末尾がそれらのときその後ろ。そこで打つと段落ができ、Enter で空の段落ができる
 * //   (MARKDOWN_KEYMAP の Enter の先頭に gap 用のコマンド)。前後のブロックは触っていない=1 段目で byte 等価
 * //   ※ code_block は inlineContent なので素の GapCursor.valid では末尾の fence の後ろに gap が立たない → code_block に
 * //     `isolating: true` を付ける(推奨)か同等の手で許す(実装裁量)
 * //   文書の先頭の front matter の前(位置 0)を指す選択は front matter の後ろへ寄せる(次が表なら gap・段落なら先頭の TextSelection)。
 * //   definition の隣(前後)に GapCursor を置かない(見えない場所にカーソルが出るため)
 * ```
 *
 * ## 修正前に赤になる理由
 * - `src/editor/gap-cursor.ts` と `prosemirror-gapcursor` が無いので import で落ちる
 */
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EditorView } from 'prosemirror-view';
import { NodeSelection, TextSelection, type Plugin } from 'prosemirror-state';
import type { ResolvedPos } from 'prosemirror-model';
import { keymap } from 'prosemirror-keymap';
import { GapCursor } from 'prosemirror-gapcursor';
import { createMarkdownDocument, markdownText, withFacePlugins, withState, type MarkdownDocument } from './markdown-document';
import { MARKDOWN_KEYMAP } from './markdown-keymap';
import { blockNames } from './markdown.testkit';
import { markdownGapCursor } from './gap-cursor';
import { markdownInputRules } from './input-rules';

const URI = 'file:///Users/a/notes/gap.md';

beforeAll(() => {
	const zeroRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
	const emptyRects = () => Object.assign([] as DOMRect[], { item: (_i: number) => null }) as unknown as DOMRectList;
	const rangeProto = Range.prototype as unknown as Record<string, unknown>;
	if (typeof rangeProto.getClientRects !== 'function') rangeProto.getClientRects = emptyRects;
	if (typeof rangeProto.getBoundingClientRect !== 'function') rangeProto.getBoundingClientRect = zeroRect;
	if (typeof (document as unknown as Record<string, unknown>).elementFromPoint !== 'function') {
		(document as unknown as Record<string, unknown>).elementFromPoint = () => null;
	}
});

type Face = { view: EditorView; model: MarkdownDocument; text(): string; names(): string[]; tx(): number };
const mounted: EditorView[] = [];

function mount(src: string): Face {
	const plugins: Plugin[] = [markdownInputRules(), keymap(MARKDOWN_KEYMAP), ...markdownGapCursor()];
	const model = withFacePlugins(createMarkdownDocument(src, { uri: URI, readOnly: false }), plugins);
	const host = document.createElement('div');
	document.body.appendChild(host);
	let count = 0;
	const view: EditorView = new EditorView(host, {
		state: model.state,
		dispatchTransaction(tr) {
			count++;
			view.updateState(view.state.apply(tr));
		},
	});
	mounted.push(view);
	return { view, model, text: () => markdownText(withState(model, view.state)), names: () => blockNames(view.state.doc), tx: () => count };
}
afterEach(() => {
	for (const v of mounted.splice(0)) {
		const host = v.dom.parentElement;
		v.destroy();
		host?.remove();
	}
});
function typeChars(view: EditorView, s: string) {
	for (const ch of Array.from(s)) {
		const { from, to } = view.state.selection;
		const deflt = () => view.state.tr.insertText(ch, from, to);
		const handled = view.someProp('handleTextInput', (f) => f(view, from, to, ch, deflt));
		if (!handled) view.dispatch(deflt());
	}
}
function gapAt(view: EditorView, pos: number) {
	view.dispatch(view.state.tr.setSelection(new GapCursor(view.state.doc.resolve(pos))));
}
function key(view: EditorView, k: string, init: KeyboardEventInit = {}) {
	view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
}

const HTML2 = '<div>\na\n</div>\n\n<div>\nb\n</div>\n';
const FENCE_LAST = 'para\n\n```ts\nlet a = 1\n```\n';
const TABLE_FIRST = '| a | b |\n| - | - |\n| c | d |\n\npara\n';
const FM_PARA = '---\ntitle: x\n---\n\nabc\n';
const FM_TABLE = '---\ntitle: x\n---\n\n| a |\n| - |\n| b |\n';
const DEFS = 'see [x][r].\n\n[r]: https://e.com\n[s]: https://f.com\n';

describe('AC-74-58 (2): 文字のカーソルを置けない場所に gap を置いて打つと段落ができ、前後のブロックは byte 等価', () => {
	test('生 HTML の塊が 2 つ続く間(位置 1)', () => {
		const face = mount(HTML2);
		expect(face.names()).toEqual(['html_block', 'html_block']);
		gapAt(face.view, 1);
		expect(face.view.state.selection).toBeInstanceOf(GapCursor);
		typeChars(face.view, 'x');
		expect(face.names()).toEqual(['html_block', 'paragraph', 'html_block']);
		expect(face.view.state.selection).toBeInstanceOf(TextSelection);
		expect(face.view.state.selection.$from.parent.textContent).toBe('x');
		expect(face.text()).toBe('<div>\na\n</div>\n\nx\n\n<div>\nb\n</div>\n');
	});

	test('末尾の code fence の後ろ(文書の終わり)', () => {
		const face = mount(FENCE_LAST);
		const end = face.view.state.doc.content.size;
		gapAt(face.view, end);
		expect(face.view.state.selection, 'code fence の後ろに gap が立つ').toBeInstanceOf(GapCursor);
		typeChars(face.view, 'x');
		expect(face.names()).toEqual(['paragraph', 'code_block', 'paragraph']);
		expect(face.view.state.doc.child(1).textContent, 'code fence の中身は触らない').toBe('let a = 1');
		expect(face.text()).toBe('para\n\n```ts\nlet a = 1\n```\n\nx\n');
	});

	test('先頭の表の前(位置 0)', () => {
		const face = mount(TABLE_FIRST);
		gapAt(face.view, 0);
		expect(face.view.state.selection).toBeInstanceOf(GapCursor);
		typeChars(face.view, 'x');
		expect(face.names()).toEqual(['paragraph', 'table', 'paragraph']);
		expect(face.text()).toBe('x\n\n| a | b |\n| - | - |\n| c | d |\n\npara\n');
	});

	test('gap で Enter → 空の段落ができてカーソルがその中(取引 1 つ)。続けて打つと同じ結果', () => {
		const face = mount(HTML2);
		gapAt(face.view, 1);
		const before = face.tx();
		key(face.view, 'Enter');
		expect(face.tx() - before).toBe(1);
		expect(face.names()).toEqual(['html_block', 'paragraph', 'html_block']);
		const sel = face.view.state.selection;
		expect(sel).toBeInstanceOf(TextSelection);
		expect(sel.$from.parent.type.name).toBe('paragraph');
		expect(sel.$from.parent.content.size).toBe(0);
		typeChars(face.view, 'x');
		expect(face.text()).toBe('<div>\na\n</div>\n\nx\n\n<div>\nb\n</div>\n');
	});

	test('gap で打った字から入力規則も効く(gap の段落の先頭で "## " → 見出し)', () => {
		const face = mount(HTML2);
		gapAt(face.view, 1);
		typeChars(face.view, '## x');
		expect(face.names()).toEqual(['html_block', 'heading', 'html_block']);
		expect(face.text()).toBe('<div>\na\n</div>\n\n## x\n\n<div>\nb\n</div>\n');
	});

	test('段落の隣(段落と区切り線の間)には gap が立たない(素の GapCursor.valid どおり=文字のカーソルで足りる)', () => {
		const face = mount('a\n\n---\n\nb\n');
		expect(face.names()).toEqual(['paragraph', 'horizontal_rule', 'paragraph']);
		// GapCursor.valid は型の宣言で @internal(実体は公開)
		const valid = (GapCursor as unknown as { valid($pos: ResolvedPos): boolean }).valid;
		expect(valid(face.view.state.doc.resolve(3))).toBe(false);
		expect(valid(face.view.state.doc.resolve(4))).toBe(false);
	});
});

describe('AC-74-58 (3): front matter の前と definition の隣には gap を置かない', () => {
	test('front matter の前(位置 0)を指す GapCursor は front matter の後ろへ寄る(次が表なら位置 1 の gap)。打った字は front matter の後ろ', () => {
		const face = mount(FM_TABLE);
		expect(face.names()).toEqual(['front_matter', 'table']);
		gapAt(face.view, 0);
		const sel = face.view.state.selection;
		expect(sel.from, 'front matter の前には止まらない').toBeGreaterThanOrEqual(1);
		expect(sel).toBeInstanceOf(GapCursor);
		expect(sel.from).toBe(1);
		typeChars(face.view, 'x');
		expect(face.names()).toEqual(['front_matter', 'paragraph', 'table']);
		expect(face.text()).toBe('---\ntitle: x\n---\n\nx\n\n| a |\n| - |\n| b |\n');
	});

	test('次が段落なら、その先頭の文字のカーソルへ。front matter の書き出しは byte 等価', () => {
		const face = mount(FM_PARA);
		gapAt(face.view, 0);
		const sel = face.view.state.selection;
		expect(sel.from).toBeGreaterThanOrEqual(1);
		expect(sel instanceof GapCursor && sel.from === 0).toBe(false);
		typeChars(face.view, 'x');
		expect(face.names()).toEqual(['front_matter', 'paragraph']);
		expect(face.text().startsWith('---\ntitle: x\n---\n')).toBe(true);
		expect(face.text()).toBe('---\ntitle: x\n---\n\nxabc\n');
	});

	test('文書の先頭が front matter でない表なら位置 0 の gap は今のまま立つ(制約は front matter だけ)', () => {
		const face = mount(TABLE_FIRST);
		gapAt(face.view, 0);
		expect(face.view.state.selection).toBeInstanceOf(GapCursor);
		expect(face.view.state.selection.from).toBe(0);
	});

	test('definition の隣(2 つの definition の間・末尾の definition の後ろ)に GapCursor が残らない', () => {
		const face = mount(DEFS);
		expect(face.names()).toEqual(['paragraph', 'definition', 'definition']);
		const doc = face.view.state.doc;
		const between = doc.child(0).nodeSize + doc.child(1).nodeSize; // 2 つの definition の間
		const end = doc.content.size;
		for (const pos of [between, end]) {
			gapAt(face.view, pos);
			const sel = face.view.state.selection;
			const adjacentToDefinition =
				sel instanceof GapCursor &&
				(sel.$from.nodeBefore?.type.name === 'definition' || sel.$from.nodeAfter?.type.name === 'definition');
			expect(adjacentToDefinition, `位置 ${pos} に definition 隣の gap が残らない`).toBe(false);
		}
		expect(face.text(), '文書は変わらない').toBe(DEFS);
	});
});

// ---------------------------------------------------------------------------
// 第3段の P3 の穴(後追いの固定): I17=矢印キー(PM の keydown → gapcursor の受け手)で gap が立つ
// ---------------------------------------------------------------------------

describe('P3 I17: 矢印キーで gap cursor が立つ(GapCursor を直接置かない経路)', () => {
	test('末尾の code fence の中の終わりで → キー → 文書の終わりに GapCursor(code_block の createGapCursor を外すと立たない)', () => {
		const face = mount(FENCE_LAST);
		const code = face.view.state.doc.child(1);
		expect(code.type.name).toBe('code_block');
		const end = face.view.state.doc.child(0).nodeSize + 1 + code.content.size; // code_block の中の終わり
		face.view.dispatch(face.view.state.tr.setSelection(TextSelection.create(face.view.state.doc, end)));
		expect(face.view.state.selection.$from.parent.type.name).toBe('code_block');
		key(face.view, 'ArrowRight');
		expect(face.view.state.selection).toBeInstanceOf(GapCursor);
		expect(face.view.state.selection.from).toBe(face.view.state.doc.content.size);
		typeChars(face.view, 'x');
		expect(face.names()).toEqual(['paragraph', 'code_block', 'paragraph']);
		expect(face.text()).toBe('para\n\n```ts\nlet a = 1\n```\n\nx\n');
	});

	test('2 つの生 HTML の塊: 1 つ目を選んで → キー → 間(位置 1)に GapCursor。← キーで 1 つ目の前(位置 0)', () => {
		const face = mount(HTML2);
		face.view.dispatch(face.view.state.tr.setSelection(NodeSelection.create(face.view.state.doc, 0)));
		key(face.view, 'ArrowRight');
		expect(face.view.state.selection).toBeInstanceOf(GapCursor);
		expect(face.view.state.selection.from).toBe(1);
		face.view.dispatch(face.view.state.tr.setSelection(NodeSelection.create(face.view.state.doc, 0)));
		key(face.view, 'ArrowLeft');
		expect(face.view.state.selection).toBeInstanceOf(GapCursor);
		expect(face.view.state.selection.from).toBe(0);
	});

	test('段落の終わりで → キーを押しても、次が段落なら gap は立たない(文字のカーソルのまま)', () => {
		const face = mount('a\n\nb\n');
		face.view.dispatch(face.view.state.tr.setSelection(TextSelection.create(face.view.state.doc, 2)));
		key(face.view, 'ArrowRight');
		expect(face.view.state.selection).not.toBeInstanceOf(GapCursor);
	});
});
