/**
 * 要件#74 — 変換中の Command + B / I を Format ▸ Bold・ツールバーとそろえる(面が受け取り、確定の後に 1 回だけ当てる)
 * (docs/requirements/req-74.md 状態節「2026-11-20 21:40 由谷の決定」(1)。契約8 の例外・契約10。component プロジェクト・JSDOM)
 *
 * ## 何が起きたか(2026-11-20 夜の実機)
 * 変換中に Command + B を押すと、keydown は keyCode 229・isComposing・key 'b'・metaKey で来て、そのあと IME が受けて捨てる。
 * 面の `commandFormatKey`(MarkdownEditor.svelte・契約8 の例外=Command + B / I の keydown → runFormatCommand)は isComposing なら
 * null を返して取らないので、何も当たらない。Format ▸ Bold(AX)とツールバーは `runFormatCommand` が変換中を見て
 * `deferUntilComposed`(src/editor/commands.ts)で控え、確定の後に 1 回だけ当てる(契約10)。
 *
 * ## そろえる先(今の Format ▸ Bold の振る舞い= commands.ts の deferUntilComposed を読んだ結果)
 * - 変換中は当てず、`compositionend` か変換中の `blur`(WebKit は compositionend を出さないことがある)の後に 1 回だけ当てる
 * - 変換中に何回押しても、当たるのは最後の 1 つを 1 回(同じ Bold を 2 回押しても付けて外さない=AC-74-8 の既存のテストの
 *   「2 回押しても 1 回=トグルが戻らない」と同じ)
 * - 変換を Escape で取り消したとき(字なしの compositionend)も**当てる**(deferUntilComposed は data を見ない)。範囲はその時の
 *   選択(空なら語の中のカーソルの語= markCommand)
 * - 範囲: 確定の後の選択に当てる。空の選択で語の中なら、確定した字を含む語(markCommand の語の広げ方)
 *
 * ## 判定するもの
 * 1. 変換中(compositionstart の後・compositionend の前)に keydown(metaKey・key 'b'/'i'・isComposing・keyCode 229)が来ても、
 *    変換中は文書が変わらない。compositionend の後に 1 回だけ Bold / Italic が当たる。範囲・取引の数・文書は、変換中に
 *    Format ▸ Bold / Italic(runFormatCommand)を押したときと同じ(同じ手順を 2 回=Format とキーで回して比べる)。値でも固定する
 *    (確定した字を含む語 'abc日本def' に mark・mark の取引ちょうど 1 つ)。変換中の blur で終わったときも同じ
 * 2. 変換中に Command + B を 2 回押しても、当たるのは 1 回(Format ▸ Bold を 2 回押したときと同じ)
 * 3. 変換を Escape で取り消したときも、溜めた Command + B は当たる(Format ▸ Bold と同じ)
 * 4. 変換中でない Command + B / I は今のまま(その場で 1 回の打鍵で命令ちょうど 1 回・既定の動作を止める=事後確認 (14))。
 *    変換の後の Command + B もその場で 1 回だけ当たり、溜めた分は確定の後の 1 回で尽きている(残らない)
 * 5. Control・Option・Shift 付きと、metaKey の無い b / i は取らない(変換中も、変換中でないときも。今のまま)
 *
 * ## 決めたこと(test-writer 2026-11-20)
 * - 変換中の Command + B / I の keydown の既定の動作は止めない(`defaultPrevented` は false のまま)。既存の
 *   MarkdownEditor.gate24.wiring.test.ts「締め (1) の門」の「変換中(isComposing)の Command + B: defaultPrevented は false」が
 *   そう固定しているのに合わせる(実機では IME が受けて捨てるので、止めなくても字は入らない)。あわせて、その既存のテストは
 *   compositionstart の無い isComposing の keydown を送り、確定も blur も来ないまま「書式は付かない・文書は変わらない」を見る。
 *   よって実装は、isComposing の Command + B / I を**その場では当てない**
 * - (2026-11-20 差し戻しの後の直し・照合役の P2 / P3)控えを立てるのは**面が変換中のとき**(compositionstart の後・確定と
 *   変換中の blur の前)**だけ**。面が変換中でないところに来た isComposing の Command + B / I(WebKit が変換を黙って捨てた
 *   ときなど)は**捨てる**(その場でも、後の blur・次の変換の確定でも当てない)。変換中に立てた控えも、確定が来ないまま
 *   文書が入れ替わったら(resetDocument= Reload File・同じ文書の開き直し)捨てる。由谷の決定「確定の後に 1 回だけ」から
 *   見て、確定の来ない控えが後でその時の選択に当たるのは外れる(初めの注記の「view.composing が偽でも控えを立てる」は誤り。
 *   判定は変えていない=その形の判定はこのファイルに無かった)
 * - 変換中の IME の字は、既存のテストと同じく compositionstart の後に `insertText` で入れ、確定は data つきの compositionend、
 *   Escape の取り消しは字を消してから data '' の compositionend で模す
 *
 * ## 赤になる理由(実装前)
 * `commandFormatKey` が isComposing の keydown に null を返すので、1・2・3 と 4 の後半(変換の後)は確定の後に何も当たらず赤
 * (Format ▸ Bold の側は当たるので、比べても食い違う)。4 の前半と 5 は今の作りのままで緑(守り)。
 *
 * (2026-11-20 差し戻しの後に足した 6・7= 末尾の describe「確定の来ない控えは残さない」)dab863d の作りでは:
 * - 6(変換中でないところの isComposing の Command + B / I のあとの blur・次の変換の確定)は赤。`deferFormatCommand` が
 *   view.composing を見ずに `deferUntilComposed` で控えを立て、その控えは view.dom の blur か compositionend で解ける
 *   (その時の選択に当たる)
 * - 7(変換中の Command + B のあと、確定が来ないまま文書を入れ替えて blur / 字なしの compositionend)は赤。resetDocument は
 *   `view.updateState` で同じ view を使い回し、控え(commands.ts の `deferred` の WeakMap と view.dom の受け手)を消さない。
 *   変換中の Format ▸ Bold(runFormatCommand → deferUntilComposed)の控えも同じ控えなので、同じ理由で赤
 * - 8(照合の P3 の穴・0dcb08c の後): 入れ替えた後の次の変換で Command + B / Format ▸ Bold を押して確定すると、確定の後に
 *   1 回だけ当たる。0dcb08c では緑(discardDeferredFormat が受け手を外し、WeakMap の項目も消す)。項目を消さない変異では、
 *   次の deferUntilComposed が「待っている」と見なして受け手を付けないので、確定の後に何も当たらず赤
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { TextSelection, type Transaction } from 'prosemirror-state';
import type { EditorView as PMView } from 'prosemirror-view';
import { undoDepth } from 'prosemirror-history';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { MarkdownEditorHandle } from '../editor/file-editor';
import { textSpots } from '../editor/markdown.testkit';
import { runFormatCommand, type FormatItemId } from '../editor/commands';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => undefined), openPath: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), message: vi.fn(), open: vi.fn() }));
vi.mock('$lib/mermaid-mounter', () => ({ mountMermaid: vi.fn(async () => undefined) }));
vi.mock('$lib/events', () => ({ listen: async () => () => {} }));
vi.mock('@tauri-apps/api/window', async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	const fake = { label: 'main', emit: vi.fn(async () => undefined), onFocusChanged: vi.fn(async () => () => {}), listen: vi.fn(async () => () => {}) };
	return { ...actual, getCurrentWindow: () => fake };
});

// ---------------------------------------------------------------------------
// JSDOM の polyfill と面の載せ方(MarkdownEditor.gate24.wiring.test.ts と同じ)
// ---------------------------------------------------------------------------

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

const MD_URI = 'file:///Users/a/notes/compose.md';
/** 1 つ目の段落の 'abc|def' の間で変換し、'日本' を確定する。 */
const SRC = 'abcdef\n\nafter\n';
const COMPOSED = '日本';

async function settle(rounds = 8) {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
	await tick();
}
async function settleLong() {
	await settle();
	await new Promise((r) => setTimeout(r, 0));
	await settle();
}
/** 確定の後(MarkdownEditor と deferUntilComposed はどちらも setTimeout 0 で流す)まで待つ。 */
async function settleAfterComposition() {
	await settleLong();
	await new Promise((r) => setTimeout(r, 50));
	await settleLong();
}

async function mountMd(content: string) {
	const d: DocumentPayload = { uri: MD_URI, content, modified: 1 };
	windowState.setDocument(d);
	const r = await renderMarkdown(content, MD_URI);
	const result = render(Viewer, {
		props: { document: d, html: r.html, index: r.index, onRequestAddMark: vi.fn(), onToggleMarks: vi.fn(), marksOpen: false },
	});
	await settleLong();
	return result;
}
function handle(): MarkdownEditorHandle {
	const h = windowState.fileEditor as MarkdownEditorHandle | null;
	if (!h) throw new Error('windowState.fileEditor が登録されていない');
	if (h.kind !== 'markdown') throw new Error(`handle.kind が markdown でない: ${String(h.kind)}`);
	return h;
}
function pm(): PMView {
	return handle().view;
}
function text(): string {
	return handle().text();
}
function caretAt(pos: number) {
	const v = pm();
	v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos)));
}

beforeEach(() => {
	windowState.clearDocument();
});
afterEach(() => {
	cleanup();
	windowState.clearDocument();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 鍵・変換・取引の記録
// ---------------------------------------------------------------------------

type Key = 'b' | 'i';
const MARK_OF: Record<Key, 'strong' | 'em'> = { b: 'strong', i: 'em' };
const FORMAT_OF: Record<Key, FormatItemId> = { b: 'format-bold', i: 'format-italic' };

/** 変換中の Command + B / I(実機の記録どおり keyCode 229・isComposing・metaKey)。`extra` で修飾を足す・外す。 */
function composingKey(key: Key, extra: KeyboardEventInit = {}): KeyboardEvent {
	const ev = new KeyboardEvent('keydown', { key, keyCode: 229, metaKey: true, isComposing: true, bubbles: true, cancelable: true, ...extra });
	pm().dom.dispatchEvent(ev);
	return ev;
}
/** 変換中でない鍵。 */
function plainKey(key: Key, init: KeyboardEventInit): KeyboardEvent {
	const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
	pm().dom.dispatchEvent(ev);
	return ev;
}

/** 面の view.dispatch を包んで、以後の取引を記録する(命令は呼ばれた時点の view.dispatch を使う)。 */
function recordTransactions(v: PMView): Transaction[] {
	const txs: Transaction[] = [];
	const original = v.dispatch;
	(v as unknown as { dispatch: (tr: Transaction) => void }).dispatch = (tr: Transaction) => {
		txs.push(tr);
		original(tr);
	};
	return txs;
}
/** mark を付け外しする取引の数。 */
function markTransactions(txs: Transaction[]): number {
	return txs.filter((tr) => tr.steps.some((s) => /^(addMark|removeMark)$/.test(String((s.toJSON() as { stepType?: string }).stepType)))).length;
}
/** 1 つ目の段落で `mark` の付いた字(つなげたもの)。 */
function markedIn(block: number, mark: string): string {
	let out = '';
	pm().state.doc.child(block).forEach((n) => {
		if (n.isText && n.marks.some((m) => m.type.name === mark)) out += n.text ?? '';
	});
	return out;
}

async function compositionStart() {
	pm().dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
	await settle();
}
/** IME が変換中の字を出す(既存のテストと同じく insertText で模す)。 */
function composeText(s: string) {
	const v = pm();
	v.dispatch(v.state.tr.insertText(s));
}

type Ending = 'commit' | 'escape' | 'blur';
type Path = 'menu' | 'key';

type Outcome = {
	/** 変換中(押した後・確定の前)の文書と、その時の mark の付いた字。 */
	during: string;
	duringMarked: string;
	/** 確定の後の文書・mark の付いた字・mark の取引の数・undo の段の増え方。 */
	after: string;
	marked: string;
	markTxsAfterEnd: number;
	undoDelta: number;
	/** キーの経路の keydown の defaultPrevented(Format の経路は空)。 */
	prevented: boolean[];
};

/**
 * 'abc|def' の間で変換を始め、'日本' を出し、変換中に Format(runFormatCommand=Format ▸ Bold / Italic・ツールバーの経路)か
 * Command + B / I の keydown を `presses` 回送り、`ending` で終える。面は毎回載せ直す。
 */
async function scenario(path: Path, key: Key, presses: number, ending: Ending): Promise<Outcome> {
	await mountMd(SRC);
	const v = pm();
	const spot = textSpots(v.state.doc, 0)[0]!;
	expect(spot.text, '前提: 1 つ目の段落').toBe('abcdef');
	caretAt(spot.pos + 3);
	v.focus();
	const depth0 = undoDepth(v.state);
	const txs = recordTransactions(v);

	await compositionStart();
	expect(pm().composing, '前提: 変換中(view.composing)').toBe(true);
	composeText(COMPOSED);
	await settle();

	const prevented: boolean[] = [];
	for (let n = 0; n < presses; n++) {
		if (path === 'key') prevented.push(composingKey(key).defaultPrevented);
		else expect(runFormatCommand(FORMAT_OF[key], handle()), '変換中の Format は控える(false)').toBe(false);
		await settle();
	}
	await settleLong();
	const during = text();
	const duringMarked = markedIn(0, MARK_OF[key]);

	if (ending === 'escape') {
		// IME が変換中の字を消し、字なしの compositionend を出す
		const now = pm();
		now.dispatch(now.state.tr.delete(spot.pos + 3, spot.pos + 3 + COMPOSED.length));
		await settle();
	}
	const endAt = txs.length;
	if (ending === 'blur') pm().dom.dispatchEvent(new FocusEvent('blur'));
	else pm().dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: ending === 'commit' ? COMPOSED : '' }));
	await settleAfterComposition();

	const outcome: Outcome = {
		during,
		duringMarked,
		after: text(),
		marked: markedIn(0, MARK_OF[key]),
		markTxsAfterEnd: markTransactions(txs.slice(endAt)),
		undoDelta: undoDepth(pm().state) - depth0,
		prevented,
	};
	cleanup();
	windowState.clearDocument();
	return outcome;
}

/** Format の経路とキーの経路を同じ手順で回し、両方を返す。 */
async function bothPaths(key: Key, presses: number, ending: Ending) {
	const menu = await scenario('menu', key, presses, ending);
	const keyed = await scenario('key', key, presses, ending);
	return { menu, keyed };
}

/** キーの経路が Format の経路と同じ結果(文書・範囲・取引の数・undo の段)。 */
function expectSameAsMenu(menu: Outcome, keyed: Outcome) {
	expect(keyed.during, '変換中の文書は Format と同じ(当てていない)').toBe(menu.during);
	expect(keyed.duringMarked, '変換中は mark が付かない(Format と同じ)').toBe(menu.duringMarked);
	expect(keyed.after, '確定の後の文書は Format と同じ').toBe(menu.after);
	expect(keyed.marked, '当たる範囲は Format と同じ').toBe(menu.marked);
	expect(keyed.markTxsAfterEnd, 'mark の取引の数は Format と同じ').toBe(menu.markTxsAfterEnd);
	expect(keyed.undoDelta, 'undo の段の増え方は Format と同じ').toBe(menu.undoDelta);
}

// ---------------------------------------------------------------------------
// 1 — 変換中の Command + B / I は確定の後に 1 回だけ(Format ▸ Bold / Italic と同じ)
// ---------------------------------------------------------------------------

describe('変換中の Command + B / I は、面が受け取り確定の後に 1 回だけ当てる(由谷の決定 2026-11-20 21:40・Format ▸ Bold とそろえる)', () => {
	for (const key of ['b', 'i'] as const) {
		it(`Command + ${key.toUpperCase()}: 変換中は文書が変わらず、compositionend の後に確定した字を含む語('abc日本def')へ ${MARK_OF[key]} が 1 回だけ当たる(範囲・取引の数・文書は Format と同じ)`, async () => {
			const { menu, keyed } = await bothPaths(key, 1, 'commit');
			// そろえる先(Format の経路)の今の値
			expect(menu.marked, '前提: Format の経路は確定した字を含む語に当たる').toBe(`abc${COMPOSED}def`);
			expect(menu.markTxsAfterEnd, '前提: Format の経路は mark の取引 1 つ').toBe(1);
			// キーの経路
			expect(keyed.during, '変換中は文書が変わらない(確定した字が入っているだけ)').toBe(`abc${COMPOSED}def\n\nafter\n`);
			expect(keyed.duringMarked, '変換中は mark が付かない').toBe('');
			expect(keyed.marked, `確定の後、確定した字を含む語に ${MARK_OF[key]}`).toBe(`abc${COMPOSED}def`);
			expect(keyed.markTxsAfterEnd, '当たるのは 1 回(mark の取引ちょうど 1 つ)').toBe(1);
			expect(keyed.prevented, '変換中の keydown の既定の動作は止めない(IME が受けて捨てる=gate24「締め (1) の門」と同じ)').toEqual([false]);
			expectSameAsMenu(menu, keyed);
		});
	}

	it('変換中の blur で終わったとき(WebKit は compositionend を出さないことがある)も、確定として 1 回だけ当たる(Format と同じ)', async () => {
		const { menu, keyed } = await bothPaths('b', 1, 'blur');
		expect(menu.marked, '前提: Format の経路は blur でも当たる').toBe(`abc${COMPOSED}def`);
		expect(keyed.marked).toBe(`abc${COMPOSED}def`);
		expect(keyed.markTxsAfterEnd).toBe(1);
		expectSameAsMenu(menu, keyed);
	});

	it('変換の後の Command + B はその場で 1 回だけ当たり、溜めた分は確定の後の 1 回で尽きている(残らない)', async () => {
		await mountMd(SRC);
		const v = pm();
		const spot = textSpots(v.state.doc, 0)[0]!;
		caretAt(spot.pos + 3);
		v.focus();
		const txs = recordTransactions(v);
		await compositionStart();
		composeText(COMPOSED);
		await settle();
		composingKey('b');
		pm().dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: COMPOSED }));
		await settleAfterComposition();
		expect(markedIn(0, 'strong'), '確定の後に 1 つ目の語が太字').toBe(`abc${COMPOSED}def`);
		// 2 つ目の段落の語の中で、変換中でない Command + B
		const after = textSpots(pm().state.doc, 1)[0]!;
		caretAt(after.pos + 2);
		const start = txs.length;
		const ev = plainKey('b', { metaKey: true });
		expect(ev.defaultPrevented, '変換中でない Command + B は既定の動作を止める(今のまま)').toBe(true);
		expect(markTransactions(txs.slice(start)), 'その場で 1 回').toBe(1);
		await settleAfterComposition();
		expect(markTransactions(txs.slice(start)), '溜めた分がもう一度当たらない').toBe(1);
		expect(markedIn(1, 'strong')).toBe('after');
		expect(markedIn(0, 'strong'), '1 つ目の語の太字はそのまま(打ち消されない)').toBe(`abc${COMPOSED}def`);
	});
});

// ---------------------------------------------------------------------------
// 2・3 — 2 回押したとき・Escape で取り消したとき(Format ▸ Bold の今の振る舞いにそろえる)
// ---------------------------------------------------------------------------

describe('変換中の Command + B の 2 回押しと Escape の取り消しは、Format ▸ Bold の今の振る舞いと同じ', () => {
	it('変換中に Command + B を 2 回押しても、当たるのは 1 回(付けて外さない=Format ▸ Bold を 2 回押したときと同じ)', async () => {
		const { menu, keyed } = await bothPaths('b', 2, 'commit');
		expect(menu.marked, '前提: Format の経路は 2 回押しても 1 回(AC-74-8 の既存のテストと同じ)').toBe(`abc${COMPOSED}def`);
		expect(menu.markTxsAfterEnd).toBe(1);
		expect(keyed.marked, '2 回押しても太字のまま').toBe(`abc${COMPOSED}def`);
		expect(keyed.markTxsAfterEnd, '当たるのは 1 回').toBe(1);
		expect(keyed.prevented).toEqual([false, false]);
		expectSameAsMenu(menu, keyed);
	});

	it('変換を Escape で取り消しても(字なしの compositionend)、溜めた Command + B は当たる(Format ▸ Bold の deferUntilComposed と同じ)。範囲はカーソルの語', async () => {
		const { menu, keyed } = await bothPaths('b', 1, 'escape');
		expect(menu.after.replace(/[*_]/g, ''), '前提: 変換の字は消えている(記号を除けば元の文書)').toBe(SRC);
		expect(menu.marked, '前提: Format の経路は取り消しでも当てる(カーソルの語 abcdef)').toBe('abcdef');
		expect(menu.markTxsAfterEnd).toBe(1);
		expect(keyed.marked, '取り消しでも当たる(Format と同じ)').toBe('abcdef');
		expect(keyed.markTxsAfterEnd).toBe(1);
		expectSameAsMenu(menu, keyed);
	});
});

// ---------------------------------------------------------------------------
// 4・5 — 変換中でない Command + B / I は今のまま・ほかの修飾は取らない
// ---------------------------------------------------------------------------

describe('変換中でない Command + B / I は今のまま(事後確認 (14))・Control / Option / Shift 付きと metaKey の無い鍵は取らない', () => {
	for (const key of ['b', 'i'] as const) {
		it(`変換中でない Command + ${key.toUpperCase()}: その場で 1 回の打鍵で命令ちょうど 1 回(既定の動作を止め、カーソルの語に ${MARK_OF[key]})`, async () => {
			await mountMd(SRC);
			const v = pm();
			const spot = textSpots(v.state.doc, 0)[0]!;
			caretAt(spot.pos + 3);
			v.focus();
			const depth0 = undoDepth(v.state);
			const txs = recordTransactions(v);
			const ev = plainKey(key, { metaKey: true });
			expect(ev.defaultPrevented, '既定の動作を止める').toBe(true);
			expect(markTransactions(txs), 'その場で 1 回').toBe(1);
			await settleAfterComposition();
			expect(markTransactions(txs), '後から足されない').toBe(1);
			expect(markedIn(0, MARK_OF[key])).toBe('abcdef');
			expect(undoDepth(pm().state) - depth0, '取引ちょうど 1 つ').toBe(1);
		});
	}

	const OTHERS: Array<[label: string, key: Key, init: KeyboardEventInit]> = [
		['Command + Shift + B', 'b', { metaKey: true, shiftKey: true }],
		['Command + Option + B', 'b', { metaKey: true, altKey: true }],
		['Command + Control + B', 'b', { metaKey: true, ctrlKey: true }],
		['Command + Shift + I', 'i', { metaKey: true, shiftKey: true }],
		['Control + B(Command なし)', 'b', { metaKey: false, ctrlKey: true }],
		['Option + I(Command なし)', 'i', { metaKey: false, altKey: true }],
		['b(修飾なし)', 'b', { metaKey: false }],
	];

	for (const [label, key, init] of OTHERS) {
		it(`変換中の ${label}: 取らない(確定の後も mark は付かず、文書は確定した字だけ・既定の動作も止めない)`, async () => {
			await mountMd(SRC);
			const v = pm();
			const spot = textSpots(v.state.doc, 0)[0]!;
			caretAt(spot.pos + 3);
			v.focus();
			const txs = recordTransactions(v);
			await compositionStart();
			composeText(COMPOSED);
			await settle();
			const ev = composingKey(key, init);
			expect(ev.defaultPrevented, `${label} は面が止めない`).toBe(false);
			pm().dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: COMPOSED }));
			await settleAfterComposition();
			expect(markTransactions(txs), `${label} は確定の後も当たらない`).toBe(0);
			expect(markedIn(0, MARK_OF[key])).toBe('');
			expect(text()).toBe(`abc${COMPOSED}def\n\nafter\n`);
		});

		it(`変換中でない ${label}: 取らない(mark は付かず、文書は変わらない・既定の動作も止めない)`, async () => {
			await mountMd(SRC);
			const v = pm();
			const spot = textSpots(v.state.doc, 0)[0]!;
			caretAt(spot.pos + 3);
			v.focus();
			const txs = recordTransactions(v);
			const ev = plainKey(key, { metaKey: true, ...init });
			expect(ev.defaultPrevented, `${label} は面が止めない`).toBe(false);
			await settleAfterComposition();
			expect(markTransactions(txs)).toBe(0);
			expect(markedIn(0, MARK_OF[key])).toBe('');
			expect(text()).toBe(SRC);
		});
	}
});

// ---------------------------------------------------------------------------
// 6・7 — 確定の来ない控えは残さない(2026-11-20 差し戻し P2・P3=由谷の決定「確定の後に 1 回だけ」)
// ---------------------------------------------------------------------------

describe('確定の来ない控えは残さない(差し戻し P2・P3): 面が変換中でないところの isComposing の鍵は捨て、文書を入れ替えたら控えを捨てる', () => {
	function selectRange(from: number, to: number) {
		const v = pm();
		v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from, to)));
	}

	for (const key of ['b', 'i'] as const) {
		it(`面が変換中でない(compositionstart の無い)ところの isComposing の Command + ${key.toUpperCase()}: そのあと語を選んで blur しても書式は当たらず、文書は変わらない`, async () => {
			await mountMd(SRC);
			const v = pm();
			const spot = textSpots(v.state.doc, 0)[0]!;
			caretAt(spot.pos + 3);
			v.focus();
			expect(v.composing, '前提: 面は変換中でない').toBe(false);
			const txs = recordTransactions(v);
			const ev = composingKey(key);
			expect(ev.defaultPrevented, '既定の動作は止めない(今のまま)').toBe(false);
			await settleAfterComposition();
			expect(markTransactions(txs), 'その場では当たらない').toBe(0);
			// 控えが残っていれば、blur の時の選択(語 abcdef)に当たる
			selectRange(spot.pos, spot.pos + 'abcdef'.length);
			pm().dom.dispatchEvent(new FocusEvent('blur'));
			await settleAfterComposition();
			expect(markTransactions(txs), 'blur の後も当たらない').toBe(0);
			expect(markedIn(0, MARK_OF[key])).toBe('');
			expect(text(), '文書は変わらない').toBe(SRC);
		});

		it(`面が変換中でないところの isComposing の Command + ${key.toUpperCase()}: そのあと別の変換を確定しても書式は当たらない(文書は確定した字だけ)`, async () => {
			await mountMd(SRC);
			const v = pm();
			const spot = textSpots(v.state.doc, 0)[0]!;
			caretAt(spot.pos + 3);
			v.focus();
			expect(v.composing, '前提: 面は変換中でない').toBe(false);
			const txs = recordTransactions(v);
			composingKey(key);
			await settleAfterComposition();
			// 別の変換(Command + B / I は押さない)を始めて確定する
			await compositionStart();
			expect(pm().composing, '前提: 次の変換').toBe(true);
			composeText(COMPOSED);
			await settle();
			pm().dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: COMPOSED }));
			await settleAfterComposition();
			expect(markTransactions(txs), '次の変換の確定で当たらない').toBe(0);
			expect(markedIn(0, MARK_OF[key])).toBe('');
			expect(text(), '文書は確定した字だけ').toBe(`abc${COMPOSED}def\n\nafter\n`);
		});
	}

	const NEXT = 'ghijkl words\n\nafter\n';
	const RESETS: Array<[label: string, reset: (content: string) => void]> = [
		['Reload File(windowState.applyReloadedText → 面の reset)', (content) => windowState.applyReloadedText({ uri: MD_URI, content, modified: 2 })],
		['同じ文書の開き直し(windowState.setDocument → 面の reset)', (content) => windowState.setDocument({ uri: MD_URI, content, modified: 2 })],
	];
	const ENDINGS: Array<[label: string, end: () => void]> = [
		['blur', () => pm().dom.dispatchEvent(new FocusEvent('blur'))],
		['字なしの compositionend', () => pm().dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))],
	];

	for (const [resetLabel, reset] of RESETS) {
		for (const [endLabel, end] of ENDINGS) {
			it(`変換中の Command + B のあと、確定が来ないまま文書を入れ替えた(${resetLabel}): そのあとの ${endLabel} で書式は当たらない`, async () => {
				await mountMd(SRC);
				const v = pm();
				const spot = textSpots(v.state.doc, 0)[0]!;
				caretAt(spot.pos + 3);
				v.focus();
				await compositionStart();
				expect(pm().composing, '前提: 変換中').toBe(true);
				composingKey('b');
				await settle();
				expect(handle().dirty, '前提: 未保存の編集は無い(入れ替えが文書モデルを作り直す)').toBe(false);
				reset(NEXT);
				await settle();
				expect(text(), '前提: 文書が入れ替わった(resetDocument)').toBe(NEXT);
				const now = pm();
				const txs = recordTransactions(now);
				// 控えが残っていれば、その時の選択(新しい文書の語 ghijkl)に当たる
				const first = textSpots(now.state.doc, 0)[0]!;
				selectRange(first.pos, first.pos + 'ghijkl'.length);
				end();
				await settleAfterComposition();
				expect(markTransactions(txs), `${endLabel} の後も当たらない`).toBe(0);
				expect(markedIn(0, 'strong')).toBe('');
				expect(text(), '文書は入れ替えたまま').toBe(NEXT);
			});
		}
	}

	// 控えは Format ▸ Bold(runFormatCommand → deferUntilComposed)と共有なので、Format の経路の控えも同じく捨てる
	// (2026-11-20 オーケストレーターの指示。面が変換中でないときは runFormatCommand が view.composing を見てその場で当てるので、
	//  1 の形は Format の経路には無い)
	for (const [resetLabel, reset] of RESETS) {
		for (const [endLabel, end] of ENDINGS) {
			it(`変換中の Format ▸ Bold(runFormatCommand)のあと、確定が来ないまま文書を入れ替えた(${resetLabel}): そのあとの ${endLabel} で書式は当たらない`, async () => {
				await mountMd(SRC);
				const v = pm();
				const spot = textSpots(v.state.doc, 0)[0]!;
				caretAt(spot.pos + 3);
				v.focus();
				await compositionStart();
				expect(pm().composing, '前提: 変換中').toBe(true);
				expect(runFormatCommand('format-bold', handle()), '前提: 変換中の Format は控える(false)').toBe(false);
				await settle();
				expect(handle().dirty, '前提: 未保存の編集は無い(入れ替えが文書モデルを作り直す)').toBe(false);
				reset(NEXT);
				await settle();
				expect(text(), '前提: 文書が入れ替わった(resetDocument)').toBe(NEXT);
				const now = pm();
				const txs = recordTransactions(now);
				// 控えが残っていれば、その時の選択(新しい文書の語 ghijkl)に当たる
				const first = textSpots(now.state.doc, 0)[0]!;
				selectRange(first.pos, first.pos + 'ghijkl'.length);
				end();
				await settleAfterComposition();
				expect(markTransactions(txs), `${endLabel} の後も当たらない`).toBe(0);
				expect(markedIn(0, 'strong')).toBe('');
				expect(text(), '文書は入れ替えたまま').toBe(NEXT);
			});
		}
	}

	// 捨てた控えは跡を残さない(照合の P3 の穴): 控えの受け手を外すだけで WeakMap の項目を残すと、次の変換の控えが「待っている」と
	// 見なされて受け手が付かず、二度と当たらない。入れ替えた後の次の変換の Command + B / Format ▸ Bold が、確定の後に 1 回だけ当たる
	const [reloadLabel, reload] = RESETS[0]!;
	const PATHS: Array<[label: string, press: () => void]> = [
		['Command + B(isComposing の keydown)', () => void composingKey('b')],
		['Format ▸ Bold(runFormatCommand)', () => expect(runFormatCommand('format-bold', handle()), '変換中の Format は控える(false)').toBe(false)],
	];
	for (const [pathLabel, press] of PATHS) {
		it(`変換中の ${pathLabel} のあと、確定が来ないまま文書を入れ替えた(${reloadLabel}): 次の変換で ${pathLabel} を押して確定すると、確定の後に 1 回だけ当たる`, async () => {
			await mountMd(SRC);
			const v = pm();
			const spot = textSpots(v.state.doc, 0)[0]!;
			caretAt(spot.pos + 3);
			v.focus();
			await compositionStart();
			expect(pm().composing, '前提: 変換中').toBe(true);
			press();
			await settle();
			expect(handle().dirty, '前提: 未保存の編集は無い(入れ替えが文書モデルを作り直す)').toBe(false);
			reload(NEXT);
			await settle();
			expect(text(), '前提: 文書が入れ替わった(resetDocument)').toBe(NEXT);
			const now = pm();
			const txs = recordTransactions(now);
			// 次の変換: 'ghi|jkl' の間で '日本' を出し、変換中に押して確定する
			const first = textSpots(now.state.doc, 0)[0]!;
			caretAt(first.pos + 3);
			await compositionStart();
			expect(pm().composing, '前提: 次の変換').toBe(true);
			composeText(COMPOSED);
			await settle();
			press();
			await settle();
			expect(markedIn(0, 'strong'), '変換中は当たらない').toBe('');
			pm().dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: COMPOSED }));
			await settleAfterComposition();
			expect(markTransactions(txs), '確定の後に 1 回だけ当たる').toBe(1);
			expect(markedIn(0, 'strong'), '確定した字を含む語に太字').toBe(`ghi${COMPOSED}jkl`);
		});
	}
});
