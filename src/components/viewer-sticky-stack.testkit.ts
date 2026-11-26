/**
 * Issue #851 のテストの補助 — viewer-sticky.testkit.ts(Issue #848)の上に、次を足す。
 *
 * - `templateClassOf`: Svelte のテンプレートから `data-testid="…"` の要素の `class="…"` を取り出す(ソース走査)
 * - `cascadedDeclarations`: 要素の class の集合に当たる規則(class だけで書かれたセレクタ)を、詳細度と書かれた順で
 *   重ねた宣言(`.a { top: x } .a.b { top: y }` なら `.a.b` が勝つ)
 * - `effectiveTopPx`: 要素の `top` を px で。inline style の `top` があればそれ、無ければ重ねた宣言の `top` を
 *   inline のカスタムプロパティで解く
 *
 * jsdom は CSS を当てないので、「帯がどこに来るか」はソースの宣言 × DOM の inline style で計算する。
 * `*.testkit.ts` は AC-51-1 の走査対象(コメント以外の行に CJK を置かない)。
 */
import { cssRules, evaluatePx, inlineCustomProperty, substituteVars } from './viewer-sticky.testkit';

/**
 * `data-testid="testid"` を持つ開きタグの `class` 属性(空白区切りの class の一覧)。無ければ投げる。
 * `class:name` の指令(動的な class)は拾わない。
 */
export function templateClassOf(source: string, testid: string): string[] {
	const tags = source.match(/<[a-zA-Z][^>]*>/g) ?? [];
	const tag = tags.find((t) => t.includes(`data-testid="${testid}"`));
	if (!tag) throw new Error(`no element with data-testid="${testid}" in the template`);
	const m = /\sclass="([^"]*)"/.exec(tag);
	if (!m) return [];
	return m[1]!.split(/\s+/).filter(Boolean);
}

/** `.a.b` のような class だけのセレクタの class の一覧。class 以外を含むセレクタは null。 */
function classOnlySelector(selector: string): string[] | null {
	const trimmed = selector.trim();
	if (!/^(\.[A-Za-z_][\w-]*)+$/.test(trimmed)) return null;
	return trimmed.split('.').filter(Boolean);
}

/**
 * `classes` を持つ要素に当たる規則(セレクタが class だけで、その class がすべて `classes` にある)の宣言を、
 * 詳細度(class の数)の低い順・同じなら書かれた順に重ねる。後が勝つ。
 */
export function cascadedDeclarations(css: string, classes: readonly string[]): Map<string, string> {
	const have = new Set(classes);
	const matched: Array<{ specificity: number; order: number; body: string }> = [];
	cssRules(css).forEach((rule, order) => {
		for (const selector of rule.selectors) {
			const needed = classOnlySelector(selector);
			if (!needed || !needed.every((c) => have.has(c))) continue;
			matched.push({ specificity: needed.length, order, body: rule.body });
			break;
		}
	});
	matched.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
	const out = new Map<string, string>();
	for (const { body } of matched) {
		const clean = body.replace(/\/\*[\s\S]*?\*\//g, '');
		for (const part of clean.split(';')) {
			const colon = part.indexOf(':');
			if (colon < 0) continue;
			const prop = part.slice(0, colon).trim();
			const value = part.slice(colon + 1).trim();
			if (prop) out.set(prop, value);
		}
	}
	return out;
}

/** 要素の `position`(inline style が優先・無ければ重ねた宣言)。宣言が無ければ undefined。 */
export function effectivePosition(css: string, el: HTMLElement): string | undefined {
	const inline = el.style.getPropertyValue('position').trim();
	if (inline) return inline;
	return cascadedDeclarations(css, [...el.classList]).get('position');
}

/**
 * 要素の `top` を px で。inline style の `top` があればそれを、無ければ重ねた宣言の `top` を、
 * 要素と祖先の inline のカスタムプロパティで解く。どちらも無ければ投げる。
 */
export function effectiveTopPx(css: string, el: HTMLElement): number {
	const inline = el.style.getPropertyValue('top').trim();
	const expr = inline || cascadedDeclarations(css, [...el.classList]).get('top');
	if (!expr) throw new Error(`no top declaration for <${el.tagName.toLowerCase()} class="${el.className}">`);
	return evaluatePx(substituteVars(expr, (name) => inlineCustomProperty(el, name)));
}

/** ResizeObserver のスタブ 1 つ分の記録。 */
export interface FakeResizeObserverRecord {
	callback: ResizeObserverCallback;
	observed: Set<Element>;
	unobserved: Set<Element>;
	disconnected: boolean;
}

/**
 * ResizeObserver のスタブを作る(jsdom には無い)。`records` に生成した observer ごとの記録が積まれる。
 * `fire(target, height)` で、その要素を observe している observer すべてに entry を届ける
 * (`contentRect.height`・`borderBoxSize[0].blockSize` とも `height`)。
 */
export function makeFakeResizeObserver() {
	const records: FakeResizeObserverRecord[] = [];
	class FakeResizeObserver {
		private readonly record: FakeResizeObserverRecord;
		constructor(callback: ResizeObserverCallback) {
			this.record = { callback, observed: new Set(), unobserved: new Set(), disconnected: false };
			records.push(this.record);
		}
		observe(target: Element) {
			this.record.observed.add(target);
			this.record.unobserved.delete(target);
		}
		unobserve(target: Element) {
			this.record.unobserved.add(target);
		}
		disconnect() {
			this.record.disconnected = true;
		}
	}
	function observing(target: Element): FakeResizeObserverRecord[] {
		return records.filter((r) => r.observed.has(target) && !r.unobserved.has(target) && !r.disconnected);
	}
	function fire(target: Element, height: number) {
		const size = { blockSize: height, inlineSize: 0 };
		const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height, toJSON: () => ({}) } as DOMRectReadOnly;
		const entry = {
			target,
			contentRect: rect,
			borderBoxSize: [size],
			contentBoxSize: [size],
			devicePixelContentBoxSize: [size],
		} as unknown as ResizeObserverEntry;
		for (const r of observing(target)) r.callback([entry], r as unknown as ResizeObserver);
	}
	return { FakeResizeObserver, records, observing, fire };
}
