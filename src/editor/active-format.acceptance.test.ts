/**
 * 要件#74 第3段 3-4 — 今の装飾(右クリックの Format ▸ のチェック。第4段のツールバーの押下と共有する純関数)。
 * 正本: docs/review/req74-stage34-prep.md の (A) 6「チェック=activeFormat(state)」と (B) AC-74-27 (2)。
 *
 * ## 対応する受け入れ基準
 * - AC-74-27 (2): `activeFormat` の値固定表=太字の範囲の全部 / 一部・空の選択の stored mark・カーソルの位置の mark・見出し 2・リストの中・引用の中 → チェック
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * ```ts
 * // --- src/editor/active-format.ts(新規・純関数)
 * export type ActiveFormat = ReadonlySet<FormatItemId>;
 * /** 今の選択で「付いている」Format の項目。mark(bold / italic / strikethrough / inline-code)は範囲の選択が全部その mark を持つか、
 *  *  空の選択なら stored mark か カーソルの位置($from.marks())の mark。段落の種類(body-text / heading-1〜6 / code-block)はカーソル($from)の
 *  *  textblock の種類(見出しは段まで)。リスト(bulleted / numbered / task)と引用・alert-<kind> は祖先。表のセルの中は段落の種類なし。 *\/
 * export function activeFormat(state: EditorState): ActiveFormat;
 * ```
 *
 * ## 修正前に赤になる理由
 * - `src/editor/active-format.ts` が無いので import で落ちる
 */
import { describe, expect, test } from 'vitest';
import { TextSelection, type EditorState } from 'prosemirror-state';
import { createMarkdownDocument } from './markdown-document';
import { textSpots } from './markdown.testkit';
import { activeFormat } from './active-format';

const URI = 'file:///Users/a/notes/active.md';

function open(src: string) {
	return createMarkdownDocument(src, { uri: URI, readOnly: false });
}
/** block 番目の最初の text の先頭+from 〜 +to を選んだ state(to 省略で空の選択)。 */
function select(src: string, block: number, from: number, to = from, spotIndex = 0): EditorState {
	const doc = open(src);
	const spot = textSpots(doc.state.doc, block)[spotIndex]!;
	return doc.state.apply(doc.state.tr.setSelection(TextSelection.create(doc.state.doc, spot.pos + from, spot.pos + to)));
}
const has = (state: EditorState, id: string) => activeFormat(state).has(id as never);

describe('AC-74-27 (2): activeFormat の値固定表 — mark', () => {
	test('太字の範囲を全部選ぶと bold。一部(太字の外を含む)なら bold でない', () => {
		const src = 'plain **bold words** tail\n';
		// text: 'plain ' [0..6), 'bold words' (strong) [6..16), ' tail'
		const all = select(src, 0, 0, 10, 1); // 'bold words' 全部
		expect(has(all, 'format-bold')).toBe(true);
		expect(has(all, 'format-italic')).toBe(false);
		const doc = open(src);
		const plain = textSpots(doc.state.doc, 0)[0]!;
		const partial = doc.state.apply(doc.state.tr.setSelection(TextSelection.create(doc.state.doc, plain.pos + 2, plain.pos + 9)));
		expect(has(partial, 'format-bold'), '太字の外を含む範囲').toBe(false);
	});

	test('空の選択はカーソルの位置の mark(太字の中なら bold・外なら無し)', () => {
		const src = 'plain **bold words** tail\n';
		const inside = select(src, 0, 3, 3, 1);
		expect(has(inside, 'format-bold')).toBe(true);
		const outside = select(src, 0, 2, 2, 0);
		expect(has(outside, 'format-bold')).toBe(false);
	});

	test('空の選択で stored mark があればそれを見る(stored mark が bold なら bold・stored mark が空なら位置の mark でも無し)', () => {
		const src = 'plain **bold words** tail\n';
		const doc = open(src);
		const plain = textSpots(doc.state.doc, 0)[0]!;
		const base = doc.state.apply(doc.state.tr.setSelection(TextSelection.create(doc.state.doc, plain.pos + 2)));
		const stored = base.apply(base.tr.setStoredMarks([base.schema.marks.strong!.create()]));
		expect(has(stored, 'format-bold')).toBe(true);
		const bold = textSpots(doc.state.doc, 0)[1]!;
		const insideBold = doc.state.apply(doc.state.tr.setSelection(TextSelection.create(doc.state.doc, bold.pos + 3)));
		const cleared = insideBold.apply(insideBold.tr.setStoredMarks([]));
		expect(has(cleared, 'format-bold')).toBe(false);
	});

	test('italic / strikethrough / inline code もそれぞれ(重なりは両方)', () => {
		const em = select('*it* x\n', 0, 0, 2, 0);
		expect(has(em, 'format-italic')).toBe(true);
		expect(has(em, 'format-bold')).toBe(false);
		const strike = select('~~gone~~ x\n', 0, 0, 4, 0);
		expect(has(strike, 'format-strikethrough')).toBe(true);
		const code = select('`code` x\n', 0, 0, 4, 0);
		expect(has(code, 'format-inline-code')).toBe(true);
		const both = select('***both*** x\n', 0, 0, 4, 0);
		expect(has(both, 'format-bold')).toBe(true);
		expect(has(both, 'format-italic')).toBe(true);
	});
});

describe('AC-74-27 (2): activeFormat の値固定表 — 段落の種類・リスト・引用', () => {
	test('段落 → body-text だけ。見出し 2 → heading-2(body-text でない・heading-1 でない)', () => {
		const para = select('plain words\n', 0, 2);
		expect(has(para, 'format-body-text')).toBe(true);
		expect(has(para, 'format-heading-2')).toBe(false);
		const h2 = select('## Title\n', 0, 2);
		expect(has(h2, 'format-heading-2')).toBe(true);
		expect(has(h2, 'format-heading-1')).toBe(false);
		expect(has(h2, 'format-body-text')).toBe(false);
	});

	test('箇条書きの中 → bulleted-list(+ 段落の種類は body-text)。順序つき → numbered-list。タスク → task-list', () => {
		const bullet = select('- item\n', 0, 1);
		expect(has(bullet, 'format-bulleted-list')).toBe(true);
		expect(has(bullet, 'format-numbered-list')).toBe(false);
		expect(has(bullet, 'format-body-text')).toBe(true);
		const numbered = select('1. item\n', 0, 1);
		expect(has(numbered, 'format-numbered-list')).toBe(true);
		expect(has(numbered, 'format-bulleted-list')).toBe(false);
		const task = select('- [ ] todo\n', 0, 1);
		expect(has(task, 'format-task-list')).toBe(true);
	});

	test('引用の中 → quote。引用の中の見出し → quote + heading-3。alert → alert-<kind>。code fence → code-block', () => {
		const quote = select('> quoted\n', 0, 1);
		expect(has(quote, 'format-quote')).toBe(true);
		expect(has(quote, 'format-body-text')).toBe(true);
		const qh = select('> ### Head\n', 0, 1);
		expect(has(qh, 'format-quote')).toBe(true);
		expect(has(qh, 'format-heading-3')).toBe(true);
		const alert = select('> [!WARNING]\n> careful\n', 0, 1);
		expect(has(alert, 'format-alert-warning')).toBe(true);
		expect(has(alert, 'format-alert-note')).toBe(false);
		expect(has(alert, 'format-quote')).toBe(false);
		const code = select('```ts\nlet a = 1\n```\n', 0, 1);
		expect(has(code, 'format-code-block')).toBe(true);
		expect(has(code, 'format-body-text')).toBe(false);
	});

	test('mark の無い段落では mark は何も付かず、Link… / Clear Formatting / Insert の項目は入らない', () => {
		const state = select('plain words\n', 0, 2);
		const active = activeFormat(state);
		for (const id of ['format-bold', 'format-italic', 'format-strikethrough', 'format-inline-code', 'format-link', 'format-clear', 'format-insert-table', 'format-insert-image']) {
			expect(active.has(id as never), id).toBe(false);
		}
		expect([...active]).toEqual(['format-body-text']);
	});
});

// 第3段の P3 の穴(後追いの固定): A7
describe('P3 A7: タスクのリストの項目の中では Task List にだけチェック(Bulleted List には付かない)', () => {
	test('- [ ] と - [x] の項目は task-list だけ。普通の - の項目は bulleted-list だけ。混ざったリストでも項目ごと', () => {
		const unchecked = select('- [ ] todo\n', 0, 1);
		expect(has(unchecked, 'format-task-list')).toBe(true);
		expect(has(unchecked, 'format-bulleted-list')).toBe(false);
		expect(has(unchecked, 'format-numbered-list')).toBe(false);
		const checked = select('- [x] done\n', 0, 1);
		expect(has(checked, 'format-task-list')).toBe(true);
		expect(has(checked, 'format-bulleted-list')).toBe(false);
		const plain = select('- item\n', 0, 1);
		expect(has(plain, 'format-bulleted-list')).toBe(true);
		expect(has(plain, 'format-task-list')).toBe(false);
		// 混ざったリスト: 1 つ目は普通・2 つ目はタスク
		const mixedPlain = select('- item\n- [ ] todo\n', 0, 1, 1, 0);
		expect(has(mixedPlain, 'format-bulleted-list')).toBe(true);
		expect(has(mixedPlain, 'format-task-list')).toBe(false);
		const mixedTask = select('- item\n- [ ] todo\n', 0, 1, 1, 1);
		expect(has(mixedTask, 'format-task-list')).toBe(true);
		expect(has(mixedTask, 'format-bulleted-list')).toBe(false);
	});
});
