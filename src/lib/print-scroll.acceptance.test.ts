/**
 * 要件#38 追補h の受け入れテスト(docs/requirements/req-38.md「追補h(2026-10-07・backlog 244)」)
 * 「印刷が本文の欄のスクロール位置の影響を受ける」— AC-38-追h (a)(純関数・unit プロジェクト)
 *
 * 発見(2026-10-01・gate-38): 200% で Command + F の検索をすると本文の欄(`article.viewer`)が
 * 12px スクロールし、印刷プレビューの 1 ページ目が約 7mm 上にずれる。`print.css` は `.viewer` を
 * `overflow: visible` にしているが、WebKit は印刷のレイアウトに要素のスクロール位置を持ち込む。
 * CSS では戻せないので、`beforeprint` で位置を覚えて 0 にし、`afterprint` で元へ戻す。
 *
 * ## 契約(追補h 1・本テストが判定する API)
 * `src/lib/print-scroll.ts`:
 *   `export function holdScrollForPrint(
 *      target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
 *      getElements: () => (HTMLElement | null | undefined)[],
 *    ): () => void`
 * - `target` の `beforeprint` で、`getElements()` の各要素(null / undefined は飛ばす)の
 *   `scrollTop` / `scrollLeft` を覚えてから 0 にする
 * - `afterprint` で、覚えた要素の位置を元に戻して記録を捨てる
 * - `beforeprint` を経ていない `afterprint` は何もしない
 * - `beforeprint` が続けて 2 回来たら、2 回目は位置を覚え直さない(1 回目に覚えた元の位置を戻す)
 * - 返り値は 2 つの購読を外す関数
 *
 * ## 判定するもの(AC-38-追h (a))
 * - `beforeprint` で各要素の `scrollTop` / `scrollLeft` が 0 になる
 * - `afterprint` で元の値(12 / 3000 と 40)に戻る
 * - null / undefined の要素は飛ばして例外を出さない
 * - `beforeprint` なしの `afterprint` は何も変えない
 * - `beforeprint` 2 回 → `afterprint` で 1 回目より前の値に戻る
 * - 解除関数の後はどちらのイベントでも何も変わらない(購読も残らない)
 * - `afterprint` の後にもう一度 `beforeprint` → `afterprint` で、そのときの位置に戻る
 *
 * ## 判断の記録(test-writer 2026-10-07)
 * - 2 回目の `beforeprint` が scrollTop を改めて 0 にするかは契約に無いので判定しない
 *   (判定するのは「覚え直さない=afterprint で 1 回目より前の値へ戻る」だけ)
 * - `getElements` は購読時ではなく `beforeprint` のたびに呼ばれる前提で書く(Viewer は
 *   `() => [viewerEl]` を渡し、`viewerEl` は mount 後に bind される)。最後のケースで、
 *   2 周目に別の要素を返して「そのときの位置に戻る」ことを見る
 * - 偽の target は addEventListener / removeEventListener と、テスト側から発火する
 *   dispatch を持つ最小のもの(購読の数を数えられるので「2 つの購読を外す」も判定できる)。
 *   偽の要素は jsdom の `<div>` に scrollTop / scrollLeft の accessor を定義したもの
 *   (jsdom はレイアウトを持たず scrollTop の set が効かないため。
 *   `Viewer.findfix.wiring.test.ts` の stubScrollContainer と同じ作法)
 *
 * ## 赤になる理由(実装前)
 * `src/lib/print-scroll.ts` が存在せず import で落ちる(全ケース赤)
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { holdScrollForPrint } from './print-scroll';

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

type PrintTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

type Listener = EventListenerOrEventListenerObject;

/**
 * `beforeprint` / `afterprint` を受ける最小の偽 window。
 * 購読の出し入れを記録し、テスト側から `dispatch(type)` で発火する。
 */
class FakePrintTarget implements PrintTarget {
	readonly #listeners = new Map<string, Listener[]>();

	addEventListener(type: string, listener: Listener | null): void {
		if (!listener) return;
		const list = this.#listeners.get(type) ?? [];
		list.push(listener);
		this.#listeners.set(type, list);
	}

	removeEventListener(type: string, listener: Listener | null): void {
		if (!listener) return;
		const list = this.#listeners.get(type) ?? [];
		const at = list.indexOf(listener);
		if (at >= 0) list.splice(at, 1);
		this.#listeners.set(type, list);
	}

	/** 登録されている購読の数(type を省くと全部)。 */
	listenerCount(type?: string): number {
		if (type !== undefined) return (this.#listeners.get(type) ?? []).length;
		let n = 0;
		for (const list of this.#listeners.values()) n += list.length;
		return n;
	}

	dispatch(type: 'beforeprint' | 'afterprint'): void {
		const event = new Event(type);
		for (const listener of [...(this.#listeners.get(type) ?? [])]) {
			if (typeof listener === 'function') listener.call(this, event);
			else listener.handleEvent(event);
		}
	}
}

/** scrollTop / scrollLeft を実際に読み書きできる偽のスクロール容器。 */
function scrollable(top: number, left: number): HTMLElement {
	const el = document.createElement('div');
	let scrollTop = top;
	let scrollLeft = left;
	Object.defineProperty(el, 'scrollTop', {
		configurable: true,
		get: () => scrollTop,
		set: (v: number) => {
			scrollTop = v;
		},
	});
	Object.defineProperty(el, 'scrollLeft', {
		configurable: true,
		get: () => scrollLeft,
		set: (v: number) => {
			scrollLeft = v;
		},
	});
	return el;
}

function pos(el: HTMLElement): { top: number; left: number } {
	return { top: el.scrollTop, left: el.scrollLeft };
}

// ---------------------------------------------------------------------------
// AC-38-追h (a)
// ---------------------------------------------------------------------------

describe('AC-38-追h (a): holdScrollForPrint — beforeprint で 0・afterprint で元に戻す', () => {
	it('beforeprint で各要素の scrollTop / scrollLeft が 0 になる', () => {
		const target = new FakePrintTarget();
		const a = scrollable(12, 0);
		const b = scrollable(3000, 40);
		holdScrollForPrint(target, () => [a, b]);

		target.dispatch('beforeprint');

		expect(pos(a), '要素 a(12 / 0)が 0 / 0 になること').toEqual({ top: 0, left: 0 });
		expect(pos(b), '要素 b(3000 / 40)が 0 / 0 になること').toEqual({ top: 0, left: 0 });
	});

	it('afterprint で元の値(12 / 3000 と 40)に戻る', () => {
		const target = new FakePrintTarget();
		const a = scrollable(12, 0);
		const b = scrollable(3000, 40);
		holdScrollForPrint(target, () => [a, b]);

		target.dispatch('beforeprint');
		target.dispatch('afterprint');

		expect(pos(a), '要素 a が 12 / 0 に戻ること').toEqual({ top: 12, left: 0 });
		expect(pos(b), '要素 b が 3000 / 40 に戻ること').toEqual({ top: 3000, left: 40 });
	});

	it('null / undefined の要素は飛ばして例外を出さない(残りの要素は扱う)', () => {
		const target = new FakePrintTarget();
		const a = scrollable(12, 0);
		holdScrollForPrint(target, () => [null, a, undefined]);

		expect(() => target.dispatch('beforeprint'), 'beforeprint で例外を出さないこと').not.toThrow();
		expect(pos(a), 'null / undefined の隣の要素は 0 になること').toEqual({ top: 0, left: 0 });

		expect(() => target.dispatch('afterprint'), 'afterprint で例外を出さないこと').not.toThrow();
		expect(pos(a), 'null / undefined の隣の要素は元に戻ること').toEqual({ top: 12, left: 0 });
	});

	it('getElements が null / undefined だけを返しても例外を出さない', () => {
		const target = new FakePrintTarget();
		holdScrollForPrint(target, () => [null, undefined]);

		expect(() => {
			target.dispatch('beforeprint');
			target.dispatch('afterprint');
		}).not.toThrow();
	});

	it('beforeprint を経ていない afterprint は何も変えない', () => {
		const target = new FakePrintTarget();
		const a = scrollable(12, 0);
		const b = scrollable(3000, 40);
		holdScrollForPrint(target, () => [a, b]);

		expect(() => target.dispatch('afterprint')).not.toThrow();

		expect(pos(a), '要素 a は 12 / 0 のまま').toEqual({ top: 12, left: 0 });
		expect(pos(b), '要素 b は 3000 / 40 のまま').toEqual({ top: 3000, left: 40 });
	});

	it('beforeprint が続けて 2 回来ても、afterprint で 1 回目より前の値に戻る(2 回目は覚え直さない)', () => {
		const target = new FakePrintTarget();
		const a = scrollable(12, 0);
		const b = scrollable(3000, 40);
		holdScrollForPrint(target, () => [a, b]);

		target.dispatch('beforeprint');
		// 1 回目で 0 になった後、何かが欄を動かした状態で 2 回目が来る。
		a.scrollTop = 5;
		b.scrollTop = 7;
		b.scrollLeft = 9;
		target.dispatch('beforeprint');
		target.dispatch('afterprint');

		expect(pos(a), '要素 a は 2 回目の直前(5)ではなく 1 回目より前の 12 / 0 へ').toEqual({
			top: 12,
			left: 0,
		});
		expect(pos(b), '要素 b は 2 回目の直前(7 / 9)ではなく 1 回目より前の 3000 / 40 へ').toEqual({
			top: 3000,
			left: 40,
		});
	});

	it('beforeprint 2 回 → afterprint の後は記録が捨てられ、さらに afterprint が来ても何も変えない', () => {
		const target = new FakePrintTarget();
		const a = scrollable(12, 0);
		holdScrollForPrint(target, () => [a]);

		target.dispatch('beforeprint');
		target.dispatch('beforeprint');
		target.dispatch('afterprint');
		expect(pos(a)).toEqual({ top: 12, left: 0 });

		// 記録は捨てられているので、利用者がその後に動かした位置は afterprint で変わらない。
		a.scrollTop = 100;
		target.dispatch('afterprint');
		expect(pos(a), '記録を捨てた後の afterprint は何も変えない').toEqual({ top: 100, left: 0 });
	});

	it('解除関数の後は beforeprint でも afterprint でも何も変わらず、購読も残らない', () => {
		const target = new FakePrintTarget();
		const a = scrollable(12, 0);
		const b = scrollable(3000, 40);
		const release = holdScrollForPrint(target, () => [a, b]);

		expect(target.listenerCount('beforeprint'), '購読: beforeprint').toBeGreaterThan(0);
		expect(target.listenerCount('afterprint'), '購読: afterprint').toBeGreaterThan(0);

		release();

		expect(target.listenerCount(), '解除後は購読が 1 つも残らないこと').toBe(0);

		target.dispatch('beforeprint');
		expect(pos(a), '解除後の beforeprint で要素 a は変わらない').toEqual({ top: 12, left: 0 });
		expect(pos(b), '解除後の beforeprint で要素 b は変わらない').toEqual({ top: 3000, left: 40 });

		a.scrollTop = 1;
		target.dispatch('afterprint');
		expect(pos(a), '解除後の afterprint で要素 a は変わらない').toEqual({ top: 1, left: 0 });
		expect(pos(b), '解除後の afterprint で要素 b は変わらない').toEqual({ top: 3000, left: 40 });
	});

	it('beforeprint → afterprint の途中で解除しても、afterprint は何も変えない(覚えた記録は戻さない)', () => {
		const target = new FakePrintTarget();
		const a = scrollable(12, 0);
		const release = holdScrollForPrint(target, () => [a]);

		target.dispatch('beforeprint');
		expect(pos(a)).toEqual({ top: 0, left: 0 });
		release();
		target.dispatch('afterprint');

		expect(pos(a), '購読が外れているので afterprint は届かない').toEqual({ top: 0, left: 0 });
	});

	it('afterprint の後にもう一度 beforeprint → afterprint で、そのときの位置に戻る', () => {
		const target = new FakePrintTarget();
		const a = scrollable(12, 0);
		const b = scrollable(3000, 40);
		holdScrollForPrint(target, () => [a, b]);

		// 1 周目。
		target.dispatch('beforeprint');
		target.dispatch('afterprint');
		expect(pos(a)).toEqual({ top: 12, left: 0 });
		expect(pos(b)).toEqual({ top: 3000, left: 40 });

		// 利用者が欄を動かしてから 2 周目。
		a.scrollTop = 250;
		a.scrollLeft = 8;
		b.scrollTop = 0;
		b.scrollLeft = 0;
		target.dispatch('beforeprint');
		expect(pos(a), '2 周目の beforeprint でも 0 / 0').toEqual({ top: 0, left: 0 });
		expect(pos(b)).toEqual({ top: 0, left: 0 });

		target.dispatch('afterprint');
		expect(pos(a), '2 周目は 12 ではなく、そのときの 250 / 8 に戻る').toEqual({ top: 250, left: 8 });
		expect(pos(b), '2 周目は 3000 / 40 ではなく、そのときの 0 / 0 に戻る').toEqual({ top: 0, left: 0 });
	});

	it('getElements は beforeprint のたびに呼ばれ、2 周目に別の要素を返せばその要素を扱う', () => {
		const target = new FakePrintTarget();
		const first = scrollable(12, 0);
		const second = scrollable(600, 30);
		let current: HTMLElement | undefined = undefined;
		holdScrollForPrint(target, () => [current]);

		// 購読時点では要素が無い(Viewer の viewerEl は mount 後に bind される)。
		current = first;
		target.dispatch('beforeprint');
		expect(pos(first), '1 周目は first を 0 に').toEqual({ top: 0, left: 0 });
		target.dispatch('afterprint');
		expect(pos(first)).toEqual({ top: 12, left: 0 });

		current = second;
		target.dispatch('beforeprint');
		expect(pos(second), '2 周目は second を 0 に').toEqual({ top: 0, left: 0 });
		expect(pos(first), '2 周目に first は触らない').toEqual({ top: 12, left: 0 });
		target.dispatch('afterprint');
		expect(pos(second), '2 周目は second のそのときの位置(600 / 30)に戻る').toEqual({
			top: 600,
			left: 30,
		});
		expect(pos(first)).toEqual({ top: 12, left: 0 });
	});
});
