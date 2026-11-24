/**
 * 要件#74 第3段 3-1 — 入力規則(契約9・10・11・由谷の決定 2026-11-17 昼: 3-1〜3-5 推奨・3-18 の依存)。
 * 正本: docs/review/req74-stage34-prep.md の (A) 1 と (B) AC-74-26・AC-74-50・AC-74-51。
 *
 * ## 対応する受け入れ基準
 * - AC-74-26 ブロックの規則(段落の先頭だけ・記号は消える・結合・取引 1 つ・書き出しは文書の流儀で外は byte 等価)
 * - AC-74-50 インラインの規則(記号は消え x だけに mark・直後の字は mark の外・remark の判定・`__` の文書で `__x__`)
 * - AC-74-51 取り消しと止まる場所(Command + Z / Backspace で記号の文字に戻る・2 回目は普通の undo・戻した後は再発火しない・
 *   IME の変換中は変わらず確定後に 1 回・全角では変わらない・code の中 / stored mark が code / code fence では変わらない・`--` `...` `"` は打ったとおり)
 *   ※ Edit ▸ Undo(`beforeinput` の historyUndo)・読み取り専用・raw・貼り付けは `MarkdownEditor.wiring.test.ts` の 3-1 の describe
 *
 * ## 確定契約(implementer はこれに従う=推奨名は stage34-prep の (A) 1)
 *
 * ```ts
 * // --- src/editor/input-rules.ts(新規)
 * import { InputRule, inputRules, undoInputRule } from 'prosemirror-inputrules';   // 依存 ^1.5.1(3-18)
 * export const MARKDOWN_INPUT_RULES: readonly InputRule[];
 * /** inputRules({ rules }) を包んだ plugin。spec.isInputRules が真(= undoInputRule が効く)。compositionend は
 *  *  event.data(確定した文字)が規則の終わりに掛かるときだけ 1 回判定する(data が空=変換の取り消しでは何もしない)。 *\/
 * export function markdownInputRules(): Plugin;
 * //   ブロック: 段落(paragraph)の先頭だけ。`# `〜`###### ` → heading(level, setext:false)・`- ` `* ` `+ ` → bullet_list(直前が bullet_list なら join)・
 * //           `1. ` `1) `(1〜9 桁)→ ordered_list(start=数。直前が ordered_list で start+項目数=数なら join)・`> ` → blockquote・
 * //           ``` / ~~~ +言語名+空白(段落の中身が記号だけ)→ code_block(lang=言語名・無ければ '')・
 * //           リスト項目の段落の先頭で `[ ] ` / `[x] ` → list_item.checked=false / true。見出し・表のセル・code_block の中では発火しない
 * //   インライン: 閉じの記号を打った瞬間に候補(開きの 1 つ前の字を含む)を remark-parse + remark-gfm で読み、その mark 1 つが x をちょうど
 * //           覆うときだけ変える。`**x**` `__x__` → strong・`*x*` `_x_` → em・`~~x~~` → strike・`` `x` `` → code(中の他の mark は外す)。
 * //           x に元からある mark は残す。変えた直後の stored mark はその mark を除いたもの(直後に打つ字は mark の外)
 * //   どの規則も inCode:false・inCodeMark:false・undoable:true。半角だけ(全角 ＃ － ＞ ＊ ｀ と全角空白では発火しない)。smartQuotes 等は入れない
 * // --- src/editor/markdown-keymap.ts
 * //   'Mod-z': chainCommands(undoInputRule, undo)・Backspace の先頭に undoInputRule
 * // --- MarkdownEditor.svelte の facePlugins(): [markdownInputRules(), keymap(MARKDOWN_KEYMAP), ...markdownGapCursor(), mermaidActivePlugin]
 * ```
 *
 * jsdom の打鍵=`view.someProp('handleTextInput', f => f(view, from, to, ch))` が偽なら `insertText` を当てる 1 文字ずつの道具
 * (prosemirror の公式のテストと同じ形)。`Mod` は jsdom では Control。
 *
 * ## 修正前に赤になる理由
 * - `src/editor/input-rules.ts` と `prosemirror-inputrules` が無いので import で落ちる
 */
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EditorView } from 'prosemirror-view';
import { TextSelection, type Plugin } from 'prosemirror-state';
import { keymap } from 'prosemirror-keymap';
import { undoDepth } from 'prosemirror-history';
import { createMarkdownDocument, isMarkdownDirty, markdownText, withFacePlugins, withState, type MarkdownDocument } from './markdown-document';
import { MARKDOWN_KEYMAP } from './markdown-keymap';
import { blockNames, textSpots } from './markdown.testkit';
import { markdownInputRules, MARKDOWN_INPUT_RULES } from './input-rules';

const URI = 'file:///Users/a/notes/rules.md';

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

type Face = {
	view: EditorView;
	model: MarkdownDocument;
	text(): string;
	dirty(): boolean;
	tx(): number;
	names(): string[];
};
const mounted: EditorView[] = [];

function mount(src: string, extraPlugins: Plugin[] = []): Face {
	const model = withFacePlugins(createMarkdownDocument(src, { uri: URI, readOnly: false }), [markdownInputRules(), keymap(MARKDOWN_KEYMAP), ...extraPlugins]);
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
	return {
		view,
		model,
		text: () => markdownText(withState(model, view.state)),
		dirty: () => isMarkdownDirty(withState(model, view.state)),
		tx: () => count,
		names: () => blockNames(view.state.doc),
	};
}
afterEach(() => {
	for (const v of mounted.splice(0)) {
		const host = v.dom.parentElement;
		v.destroy();
		host?.remove();
	}
});

/** 1 文字ずつ打つ(handleTextInput が偽なら insertText)。 */
function typeChars(view: EditorView, s: string) {
	for (const ch of Array.from(s)) {
		const { from, to } = view.state.selection;
		const deflt = () => view.state.tr.insertText(ch, from, to);
		const handled = view.someProp('handleTextInput', (f) => f(view, from, to, ch, deflt));
		if (!handled) view.dispatch(deflt());
	}
}
function cursor(view: EditorView, pos: number) {
	view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}
/** 最上位ブロック block の最初の text の先頭(+col)。 */
function textStart(view: EditorView, block: number, col = 0): number {
	const spot = textSpots(view.state.doc, block)[0];
	if (!spot) throw new Error(`ブロック ${block} に text が無い`);
	return spot.pos + col;
}
function key(view: EditorView, k: string, init: KeyboardEventInit = {}) {
	view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
}
function composition(view: EditorView, kind: 'compositionstart' | 'compositionend', data = '') {
	view.dom.dispatchEvent(new CompositionEvent(kind, { bubbles: true, data }));
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 段落の text 子の [文字, mark 名の並び]。 */
function inlineShape(view: EditorView, block: number): Array<[string, string[]]> {
	const out: Array<[string, string[]]> = [];
	view.state.doc.child(block).forEach((n) => out.push([n.text ?? `<${n.type.name}>`, n.marks.map((m) => m.type.name).sort()]));
	return out;
}
/** 規則が当たる最後の 1 文字を打ち、その取引の数を返す。 */
function typeLast(face: Face, head: string, last: string): number {
	typeChars(face.view, head);
	const before = face.tx();
	typeChars(face.view, last);
	return face.tx() - before;
}

// ---------------------------------------------------------------------------

describe('AC-74-26: ブロックの規則(段落の先頭)', () => {
	test('MARKDOWN_INPUT_RULES は空でなく、markdownInputRules() は isInputRules の plugin(undoInputRule が効く形)', () => {
		expect(MARKDOWN_INPUT_RULES.length).toBeGreaterThan(0);
		const p = markdownInputRules();
		expect((p.spec as { isInputRules?: boolean }).isInputRules).toBe(true);
		expect(typeof p.props.handleTextInput).toBe('function');
	});

	for (const level of [1, 2, 3, 4, 5, 6]) {
		test(`'${'#'.repeat(level)} ' → 見出し ${level}(setext:false)・記号は消え abc は残る・取引 1 つ・書き出し`, () => {
			const face = mount('abc\n');
			cursor(face.view, textStart(face.view, 0));
			expect(typeLast(face, '#'.repeat(level), ' ')).toBe(1);
			expect(face.names()).toEqual(['heading']);
			expect(face.view.state.doc.child(0).attrs).toMatchObject({ level, setext: false });
			expect(face.view.state.doc.child(0).textContent).toBe('abc');
			expect(face.text()).toBe(`${'#'.repeat(level)} abc\n`);
			expect(face.dirty()).toBe(true);
		});
	}

	test("'####### '(7 つ)は見出しにならない(文字のまま)", () => {
		const face = mount('abc\n');
		cursor(face.view, textStart(face.view, 0));
		typeChars(face.view, '####### ');
		expect(face.names()).toEqual(['paragraph']);
		expect(face.view.state.doc.child(0).textContent).toBe('####### abc');
	});

	for (const marker of ['- ', '* ', '+ ']) {
		test(`'${marker}' → 箇条書き(bullet_list > list_item > paragraph)・書き出しは文書の流儀(既定 '-')`, () => {
			const face = mount('abc\n');
			cursor(face.view, textStart(face.view, 0));
			expect(typeLast(face, marker[0]!, ' ')).toBe(1);
			expect(face.names()).toEqual(['bullet_list']);
			const li = face.view.state.doc.child(0).child(0);
			expect(li.type.name).toBe('list_item');
			expect(li.child(0).type.name).toBe('paragraph');
			expect(li.textContent).toBe('abc');
			expect(face.text()).toBe('- abc\n');
		});
	}

	test("'1. ' → 順序つき(start 1)・'7. ' → start 7・'1) ' も同じ(書き出しの区切りは文書の流儀=既定 '.')", () => {
		const a = mount('abc\n');
		cursor(a.view, textStart(a.view, 0));
		expect(typeLast(a, '1.', ' ')).toBe(1);
		expect(a.names()).toEqual(['ordered_list']);
		expect(a.view.state.doc.child(0).attrs.start).toBe(1);
		expect(a.text()).toBe('1. abc\n');

		const b = mount('abc\n');
		cursor(b.view, textStart(b.view, 0));
		typeChars(b.view, '7. ');
		expect(b.names()).toEqual(['ordered_list']);
		expect(b.view.state.doc.child(0).attrs.start).toBe(7);
		expect(b.text()).toBe('7. abc\n');

		const c = mount('abc\n');
		cursor(c.view, textStart(c.view, 0));
		typeChars(c.view, '1) ');
		expect(c.names()).toEqual(['ordered_list']);
		expect(c.text()).toBe('1. abc\n');
	});

	test("'> ' → 引用。引用の中の段落の先頭で '## ' → 引用の中の見出し", () => {
		const face = mount('abc\n');
		cursor(face.view, textStart(face.view, 0));
		expect(typeLast(face, '>', ' ')).toBe(1);
		expect(face.names()).toEqual(['blockquote']);
		expect(face.text()).toBe('> abc\n');
		cursor(face.view, textStart(face.view, 0));
		typeChars(face.view, '## ');
		expect(face.view.state.doc.child(0).child(0).type.name).toBe('heading');
		expect(face.text()).toBe('> ## abc\n');
	});

	test('空の段落で ```ts + 空白 → code fence(lang ts)・``` + 空白 → lang \'\'・~~~ + 空白 → code fence(書き出しの fence は文書の流儀=既定 `)', () => {
		const a = mount('abc\n');
		cursor(a.view, textStart(a.view, 0, 3));
		key(a.view, 'Enter');
		expect(a.names()).toEqual(['paragraph', 'paragraph']);
		expect(typeLast(a, '```ts', ' ')).toBe(1);
		expect(a.names()).toEqual(['paragraph', 'code_block']);
		expect(a.view.state.doc.child(1).attrs.lang).toBe('ts');
		expect(a.text()).toBe('abc\n\n```ts\n```\n');

		const b = mount('abc\n');
		cursor(b.view, textStart(b.view, 0, 3));
		key(b.view, 'Enter');
		typeChars(b.view, '``` ');
		expect(b.names()).toEqual(['paragraph', 'code_block']);
		expect(b.view.state.doc.child(1).attrs.lang).toBe('');

		const c = mount('abc\n');
		cursor(c.view, textStart(c.view, 0, 3));
		key(c.view, 'Enter');
		typeChars(c.view, '~~~py ');
		expect(c.names()).toEqual(['paragraph', 'code_block']);
		expect(c.view.state.doc.child(1).attrs.lang).toBe('py');
		expect(c.text()).toBe('abc\n\n```py\n```\n');
	});

	test('段落の後ろに文字があれば ``` + 空白は code fence にならない', () => {
		const face = mount('abc\n');
		cursor(face.view, textStart(face.view, 0));
		typeChars(face.view, '``` ');
		expect(face.names()).toEqual(['paragraph']);
		expect(face.view.state.doc.child(0).textContent).toBe('``` abc');
	});

	test("'abc' の途中('a' の後ろ)で '## ' → 文字のまま", () => {
		const face = mount('abc\n');
		cursor(face.view, textStart(face.view, 0, 1));
		typeChars(face.view, '## ');
		expect(face.names()).toEqual(['paragraph']);
		expect(face.text()).toBe('a## bc\n');
	});

	test("見出しの先頭で '## ' / '- ' → 文字のまま(見出し 1 のまま)", () => {
		const face = mount('# Title\n');
		cursor(face.view, textStart(face.view, 0));
		typeChars(face.view, '## ');
		expect(face.names()).toEqual(['heading']);
		expect(face.view.state.doc.child(0).attrs.level).toBe(1);
		expect(face.view.state.doc.child(0).textContent).toBe('## Title');
		cursor(face.view, textStart(face.view, 0));
		typeChars(face.view, '- ');
		expect(face.names()).toEqual(['heading']);
		expect(face.view.state.doc.child(0).textContent).toBe('- ## Title');
	});

	test("表のセルの先頭で '- ' / '## ' → 文字のまま(表は 1 つ・行の数も同じ)", () => {
		const face = mount('| a | b |\n| - | - |\n| c | d |\n');
		const spot = textSpots(face.view.state.doc, 0).find((s) => s.text === 'c')!;
		cursor(face.view, spot.pos);
		typeChars(face.view, '- ');
		typeChars(face.view, '## ');
		expect(face.names()).toEqual(['table']);
		expect(face.view.state.doc.child(0).childCount).toBe(2);
		expect(face.view.state.doc.textContent).toContain('- ## c');
	});

	test("リスト項目の段落の先頭で '> ' → 項目の中の引用", () => {
		const face = mount('- a\n- b\n');
		cursor(face.view, textStart(face.view, 0));
		expect(typeLast(face, '>', ' ')).toBe(1);
		const li = face.view.state.doc.child(0).child(0);
		expect(li.child(0).type.name).toBe('blockquote');
		expect(li.child(0).child(0).type.name).toBe('paragraph');
		expect(face.text()).toBe('- > a\n- b\n');
	});

	test("箇条書きの直後の段落で '- ' → 前のリストの末尾の項目になる(リストは 1 つ)。'*' の文書なら '* ' で書かれる(3-1=文書の流儀)", () => {
		const face = mount('* a\n* b\n\nabc\n');
		cursor(face.view, textStart(face.view, 1));
		expect(typeLast(face, '-', ' ')).toBe(1);
		expect(face.names()).toEqual(['bullet_list']);
		expect(face.view.state.doc.child(0).childCount).toBe(3);
		expect(face.text()).toBe('* a\n* b\n* abc\n');
	});

	test("順序つきの直後の段落で '3. '(start 1 + 2 項目)→ 繋がる。'7. ' は繋がらず別のリスト(start 7)", () => {
		const a = mount('1. a\n2. b\n\nabc\n');
		cursor(a.view, textStart(a.view, 1));
		typeChars(a.view, '3. ');
		expect(a.names()).toEqual(['ordered_list']);
		expect(a.view.state.doc.child(0).childCount).toBe(3);
		expect(a.text()).toBe('1. a\n2. b\n3. abc\n');

		const b = mount('1. a\n2. b\n\nabc\n');
		cursor(b.view, textStart(b.view, 1));
		typeChars(b.view, '7. ');
		expect(b.names()).toEqual(['ordered_list', 'ordered_list']);
		expect(b.view.state.doc.child(1).attrs.start).toBe(7);
	});

	test("リスト項目の段落の先頭で '[ ] ' → checked=false・'[x] ' → checked=true(書き出し `- [ ] a`)。リストの外では文字のまま", () => {
		const a = mount('- a\n- b\n');
		cursor(a.view, textStart(a.view, 0));
		expect(typeLast(a, '[ ]', ' ')).toBe(1);
		expect(a.view.state.doc.child(0).child(0).attrs.checked).toBe(false);
		expect(a.view.state.doc.child(0).child(0).textContent).toBe('a');
		expect(a.text()).toBe('- [ ] a\n- b\n');

		const b = mount('- a\n- b\n');
		cursor(b.view, textStart(b.view, 0));
		typeChars(b.view, '[x] ');
		expect(b.view.state.doc.child(0).child(0).attrs.checked).toBe(true);
		expect(b.text()).toBe('- [x] a\n- b\n');

		const c = mount('abc\n');
		cursor(c.view, textStart(c.view, 0));
		typeChars(c.view, '[ ] ');
		expect(c.names()).toEqual(['paragraph']);
		expect(c.view.state.doc.child(0).textContent).toBe('[ ] abc');
	});

	test('変わったブロックの外は byte 等価(前後の段落と生 HTML がそのまま)', () => {
		const src = '<div>\nraw\n</div>\n\nfirst  para\n\nabc\n\n| a |\n| - |\n| b |\n';
		const face = mount(src);
		cursor(face.view, textStart(face.view, 2));
		typeChars(face.view, '## ');
		expect(face.text()).toBe(src.replace('\nabc\n', '\n## abc\n'));
	});
});

// ---------------------------------------------------------------------------

describe('AC-74-50: インラインの規則(閉じの記号を打った瞬間・remark の判定)', () => {
	const CASES: Array<[string, string, string]> = [
		['**x**', 'strong', '**x**'],
		['__x__', 'strong', '**x**'],
		['*x*', 'em', '*x*'],
		['_x_', 'em', '*x*'],
		['~~x~~', 'strike', '~~x~~'],
		['`x`', 'code', '`x`'],
	];
	for (const [typed, mark, written] of CASES) {
		test(`'abc ' の後ろで '${typed}' → ${mark}(記号は消え x だけ)・取引 1 つ・書き出しは文書の流儀(既定)で '${written}'`, () => {
			const face = mount('abc\n');
			cursor(face.view, textStart(face.view, 0, 3));
			expect(typeLast(face, ` ${typed.slice(0, -1)}`, typed.slice(-1))).toBe(1);
			expect(inlineShape(face.view, 0)).toEqual([
				['abc ', []],
				['x', [mark]],
			]);
			expect(face.text()).toBe(`abc ${written}\n`);
		});
	}

	test("段落の先頭で '**x**' → strong(前に字が無くても効く。後ろに 'abc' が続いても `*` は語の中で閉じられる)", () => {
		const face = mount('abc\n');
		cursor(face.view, textStart(face.view, 0));
		expect(typeLast(face, '**x*', '*')).toBe(1);
		expect(inlineShape(face.view, 0)).toEqual([
			['x', ['strong']],
			['abc', []],
		]);
		expect(face.text()).toBe('**x**abc\n');
	});

	test("'**x**' の直後に打つ 'y' は mark の外(stored mark を外す)", () => {
		const face = mount('abc\n');
		cursor(face.view, textStart(face.view, 0, 3));
		typeChars(face.view, ' **x**');
		expect(inlineShape(face.view, 0)).toEqual([
			['abc ', []],
			['x', ['strong']],
		]);
		typeChars(face.view, 'y');
		expect(inlineShape(face.view, 0)).toEqual([
			['abc ', []],
			['x', ['strong']],
			['y', []],
		]);
		expect(face.text()).toBe('abc **x**y\n');
	});

	test("強調の中で '**x**' → x は強調+強い強調(元の mark は残る)。直後の 'y' は強調だけ", () => {
		const face = mount('*abc*\n');
		cursor(face.view, textStart(face.view, 0, 1));
		typeChars(face.view, '**x**');
		expect(inlineShape(face.view, 0)).toEqual([
			['a', ['em']],
			['x', ['em', 'strong']],
			['bc', ['em']],
		]);
		typeChars(face.view, 'y');
		// ProseMirror は同じ mark の隣り合う text を 1 つにまとめる(y と bc は em だけ=1 つの text)
		expect(inlineShape(face.view, 0)).toEqual([
			['a', ['em']],
			['x', ['em', 'strong']],
			['ybc', ['em']],
		]);
	});

	test("'`x`' の中に他の mark があれば外す(強調の中で打った inline code は code だけ)", () => {
		const face = mount('*abc*\n');
		cursor(face.view, textStart(face.view, 0, 1));
		typeChars(face.view, '`x`');
		const x = inlineShape(face.view, 0).find(([t]) => t === 'x');
		expect(x).toEqual(['x', ['code']]);
	});

	test("'__' の強い強調の文書で '**x**' を打つと書き出しは '__x__'(文書の流儀)", () => {
		const face = mount('x __b__ y\n\nabc\n');
		cursor(face.view, textStart(face.view, 1, 3));
		typeChars(face.view, ' **x**');
		expect(inlineShape(face.view, 1)).toEqual([
			['abc ', []],
			['x', ['strong']],
		]);
		expect(face.text()).toBe('x __b__ y\n\nabc __x__\n');
	});

	test("remark が mark にしない並びは変わらない: 'snake_case_name'・'2 * 3 * 4'・'** x**'・'****'(文字のまま・mark なし)", () => {
		for (const s of ['snake_case_name', '2 * 3 * 4', '** x**', '****', 'abc_x_', '_x_abc']) {
			const face = mount('z\n');
			cursor(face.view, textStart(face.view, 0, 1));
			typeChars(face.view, s);
			expect(face.view.state.doc.child(0).textContent, s).toBe(`z${s}`);
			expect(
				inlineShape(face.view, 0).every(([, marks]) => marks.length === 0),
				`${s}: mark が付かない`
			).toBe(true);
		}
	});

	test('atom(脚注参照)や hard break を挟む範囲は変わらない', () => {
		const a = mount('a[^1]b\n\n[^1]: note\n');
		// 脚注参照の後ろで `*`、前に `*` があっても範囲が atom を挟む → 変わらない
		cursor(a.view, textStart(a.view, 0));
		typeChars(a.view, '**');
		const after = textSpots(a.view.state.doc, 0).find((s) => s.text === 'b')!;
		cursor(a.view, after.pos);
		typeChars(a.view, '**');
		expect(a.view.state.doc.child(0).childCount).toBeGreaterThan(1);
		expect(inlineShape(a.view, 0).every(([, marks]) => !marks.includes('strong'))).toBe(true);

		const b = mount('ab  \ncd\n');
		cursor(b.view, textStart(b.view, 0));
		typeChars(b.view, '**');
		const cd = textSpots(b.view.state.doc, 0).find((s) => s.text === 'cd')!;
		cursor(b.view, cd.pos);
		typeChars(b.view, '**');
		expect(inlineShape(b.view, 0).every(([, marks]) => !marks.includes('strong'))).toBe(true);
	});
});

// ---------------------------------------------------------------------------

describe('AC-74-51: 取り消し(Command + Z / Backspace)と、変わらない・待つ場所', () => {
	test("'## ' の直後の Control + Z(jsdom の Mod)→ '## abc' の文字に戻りカーソルはその後ろ。2 回目は普通の undo で 'abc'", () => {
		const face = mount('abc\n');
		cursor(face.view, textStart(face.view, 0));
		typeChars(face.view, '## ');
		expect(face.names()).toEqual(['heading']);
		key(face.view, 'z', { ctrlKey: true });
		expect(face.names()).toEqual(['paragraph']);
		expect(face.view.state.doc.child(0).textContent).toBe('## abc');
		expect(face.view.state.selection.from).toBe(textStart(face.view, 0, 3));
		key(face.view, 'z', { ctrlKey: true });
		expect(face.text()).toBe('abc\n');
		expect(face.dirty()).toBe(false);
	});

	test("'**x**' の直後の Control + Z → '**x**' の文字(mark なし)", () => {
		const face = mount('abc\n');
		cursor(face.view, textStart(face.view, 0));
		typeChars(face.view, '**x**');
		key(face.view, 'z', { ctrlKey: true });
		expect(inlineShape(face.view, 0)).toEqual([['**x**abc', []]]);
		expect(face.view.state.selection.from).toBe(textStart(face.view, 0, 5));
	});

	test("'- ' の直後の Backspace → '- abc' の文字(3-5)。(2 回目の Backspace=ブラウザの既定の削除は jsdom に無い → 人間ゲート 12)", () => {
		const face = mount('abc\n');
		cursor(face.view, textStart(face.view, 0));
		typeChars(face.view, '- ');
		expect(face.names()).toEqual(['bullet_list']);
		key(face.view, 'Backspace');
		expect(face.names()).toEqual(['paragraph']);
		expect(face.view.state.doc.child(0).textContent).toBe('- abc');
	});

	test('戻した記号の文字は、続けて打っても再び変わらない', () => {
		const a = mount('abc\n');
		cursor(a.view, textStart(a.view, 0));
		typeChars(a.view, '## ');
		key(a.view, 'z', { ctrlKey: true });
		typeChars(a.view, 'd');
		expect(a.names()).toEqual(['paragraph']);
		expect(a.view.state.doc.child(0).textContent).toBe('## dabc');

		const b = mount('abc\n');
		cursor(b.view, textStart(b.view, 0));
		typeChars(b.view, '**x**');
		key(b.view, 'z', { ctrlKey: true });
		typeChars(b.view, 'y');
		expect(inlineShape(b.view, 0)).toEqual([['**x**yabc', []]]);
	});

	test('undo の段数: 規則 1 回=打鍵と合わせて 1 段(すべて undo すると原文・dirty でない)', () => {
		const face = mount('abc\n');
		cursor(face.view, textStart(face.view, 0));
		typeChars(face.view, '> ');
		expect(face.names()).toEqual(['blockquote']);
		for (let i = 0; i < 6 && undoDepth(face.view.state) > 0; i++) key(face.view, 'z', { ctrlKey: true });
		expect(face.text()).toBe('abc\n');
		expect(face.dirty()).toBe(false);
	});

	test('view.composing の間は変わらない。確定した文字が規則の終わりに掛かる compositionend の後に 1 回だけ変わる', async () => {
		const face = mount('abc\n');
		cursor(face.view, textStart(face.view, 0));
		composition(face.view, 'compositionstart');
		expect(face.view.composing).toBe(true);
		typeChars(face.view, '## ');
		expect(face.names(), '変換中は文字のまま').toEqual(['paragraph']);
		expect(face.view.state.doc.child(0).textContent).toBe('## abc');
		const before = face.tx();
		composition(face.view, 'compositionend', '## ');
		await wait(40);
		expect(face.names()).toEqual(['heading']);
		expect(face.view.state.doc.child(0).attrs.level).toBe(2);
		expect(face.tx() - before, '確定の後の取引は 1 つ').toBe(1);
		await wait(40);
		expect(face.tx() - before, '2 回目は無い').toBe(1);
	});

	test('確定した文字の一部(最後の空白だけ)が規則の終わりに掛かっても変わる', async () => {
		const face = mount('abc\n');
		cursor(face.view, textStart(face.view, 0));
		typeChars(face.view, '##');
		composition(face.view, 'compositionstart');
		typeChars(face.view, ' ');
		expect(face.names()).toEqual(['paragraph']);
		composition(face.view, 'compositionend', ' ');
		await wait(40);
		expect(face.names()).toEqual(['heading']);
	});

	test("確定した文字が無い compositionend(変換の取り消し)では、カーソルの前が '**x**' でも変わらない", async () => {
		const face = mount('abc\n');
		cursor(face.view, textStart(face.view, 0));
		composition(face.view, 'compositionstart');
		typeChars(face.view, '**x**');
		expect(inlineShape(face.view, 0)).toEqual([['**x**abc', []]]);
		composition(face.view, 'compositionend', '');
		await wait(40);
		expect(inlineShape(face.view, 0)).toEqual([['**x**abc', []]]);
	});

	test('全角の記号(＃＃　・＊＊x＊＊・－　・＞　)と半角の ## + 全角空白では変わらない(3-2=半角だけ。閲覧も記号にしない)', () => {
		for (const s of ['＃＃　', '＊＊x＊＊', '－　', '＞　', '##　', '｀x｀']) {
			const face = mount('abc\n');
			cursor(face.view, textStart(face.view, 0));
			typeChars(face.view, s);
			expect(face.names(), s).toEqual(['paragraph']);
			expect(face.view.state.doc.child(0).textContent, s).toBe(`${s}abc`);
			expect(inlineShape(face.view, 0).every(([, marks]) => marks.length === 0), s).toBe(true);
		}
	});

	test('inline code の中・stored mark が code のとき・code fence の中では変わらない', () => {
		const a = mount('`abc`\n');
		cursor(a.view, textStart(a.view, 0, 1));
		typeChars(a.view, '**x**');
		expect(inlineShape(a.view, 0)).toEqual([['a**x**bc', ['code']]]);

		const b = mount('abc\n');
		cursor(b.view, textStart(b.view, 0, 3));
		b.view.dispatch(b.view.state.tr.setStoredMarks([b.view.state.schema.marks.code!.create()]));
		typeChars(b.view, '**x**');
		expect(inlineShape(b.view, 0)).toEqual([
			['abc', []],
			['**x**', ['code']],
		]);

		const c = mount('```\ncode\n```\n');
		cursor(c.view, textStart(c.view, 0));
		typeChars(c.view, '## ');
		typeChars(c.view, '**x**');
		expect(c.names()).toEqual(['code_block']);
		expect(c.view.state.doc.child(0).textContent).toBe('## **x**code');
	});

	test("'--'・'...'・'\"' は打ったとおり(smartQuotes・emDash・ellipsis は入れない)", () => {
		const face = mount('abc\n');
		cursor(face.view, textStart(face.view, 0, 3));
		typeChars(face.view, ' -- ... "q" ');
		expect(face.view.state.doc.child(0).textContent).toBe('abc -- ... "q" ');
	});
});

// ---------------------------------------------------------------------------
// 第3段の P3 の穴(後追いの固定): I5・I19
// ---------------------------------------------------------------------------

describe('P3 I5 / I19: タスクの規則はリスト項目の最初の段落の先頭だけ・インラインの判定はカーソルの後ろの 1 字も読む', () => {
	test("I5: リスト項目の 2 つ目の段落の先頭で '[ ] ' を打っても変わらない(文字のまま・checked は null のまま)", () => {
		const face = mount('- a\n\n  second\n- b\n');
		expect(face.names()).toEqual(['bullet_list']);
		const item = face.view.state.doc.child(0).child(0);
		expect(item.childCount, '項目は段落 2 つ').toBe(2);
		const second = textSpots(face.view.state.doc, 0).find((s) => s.text === 'second')!;
		cursor(face.view, second.pos);
		typeChars(face.view, '[ ] ');
		const after = face.view.state.doc.child(0).child(0);
		expect(after.attrs.checked).toBeNull();
		expect(after.child(1).textContent).toBe('[ ] second');
		// 最初の段落の先頭なら変わる(対照)
		const first = textSpots(face.view.state.doc, 0).find((s) => s.text === 'a')!;
		cursor(face.view, first.pos);
		typeChars(face.view, '[ ] ');
		expect(face.view.state.doc.child(0).child(0).attrs.checked).toBe(false);
	});

	test("I19: '_x_' の直後に字があると('_x_a')強調にならない。後ろが空白なら強調", () => {
		const a = mount('b  a\n'); // 'b', 空白 2 つ, 'a'
		cursor(a.view, textStart(a.view, 0, 2)); // 'b ' の後ろ(次は ' a')
		typeChars(a.view, '_x_');
		expect(inlineShape(a.view, 0)).toEqual([
			['b ', []],
			['x', ['em']],
			[' a', []],
		]);

		const b = mount('b a\n');
		cursor(b.view, textStart(b.view, 0, 2)); // 'b ' の後ろ(次は 'a'=語の中で閉じられない)
		typeChars(b.view, '_x_');
		expect(inlineShape(b.view, 0)).toEqual([['b _x_a', []]]);

		const c = mount('a\n');
		cursor(c.view, textStart(c.view, 0));
		typeChars(c.view, '_x_');
		expect(inlineShape(c.view, 0)).toEqual([['_x_a', []]]);
	});
});
