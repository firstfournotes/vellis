/**
 * 要件#38 追補h(backlog 244): 印刷の間だけスクロール容器の位置を 0 にしておく。
 *
 * WebKit は印刷のレイアウトに要素のスクロール位置を持ち込む(`print.css` が
 * `overflow: visible` にしても、本文の欄がスクロールしていると紙の上で本文がずれる)。
 * CSS では戻せないので、`beforeprint` で位置を覚えて 0 にし、`afterprint` で元へ戻す。
 */

type PrintTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

type Saved = { el: HTMLElement; top: number; left: number };

/**
 * `target` の `beforeprint` で `getElements()` の各要素(null / undefined は飛ばす)の
 * `scrollTop` / `scrollLeft` を覚えて 0 にし、`afterprint` で元へ戻して記録を捨てる。
 *
 * - `getElements` は `beforeprint` のたびに呼ぶ(購読時点では要素がまだ無くてよい)
 * - `beforeprint` が続けて来ても覚え直さない(最初に覚えた元の位置を戻す)
 * - `beforeprint` を経ていない `afterprint` は何もしない
 *
 * 返り値は 2 つの購読を外す関数。
 */
export function holdScrollForPrint(
	target: PrintTarget,
	getElements: () => (HTMLElement | null | undefined)[],
): () => void {
	let saved: Saved[] | null = null;

	const onBeforePrint = () => {
		const els = getElements().filter((el): el is HTMLElement => el != null);
		if (saved === null) {
			saved = els.map((el) => ({ el, top: el.scrollTop, left: el.scrollLeft }));
		}
		for (const el of els) {
			el.scrollTop = 0;
			el.scrollLeft = 0;
		}
	};

	const onAfterPrint = () => {
		if (saved === null) return;
		for (const { el, top, left } of saved) {
			el.scrollTop = top;
			el.scrollLeft = left;
		}
		saved = null;
	};

	target.addEventListener('beforeprint', onBeforePrint);
	target.addEventListener('afterprint', onAfterPrint);
	return () => {
		target.removeEventListener('beforeprint', onBeforePrint);
		target.removeEventListener('afterprint', onAfterPrint);
	};
}
