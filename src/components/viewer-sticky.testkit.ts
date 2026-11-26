/**
 * Issue #848 のテストの補助 — Svelte コンポーネントの `<style>` から規則を取り出し、`top: calc(var(--x, 0px) + 8px)` の
 * ような長さの式を、要素(とその祖先)の inline style のカスタムプロパティで解いて px の数にする。
 *
 * jsdom は CSS を当てない(vitest は component の CSS を読み込まない)ので、「帯の `top` がどこに来るか」は
 * ソースの宣言 × DOM に置かれたカスタムプロパティの値で計算して判定する(検索バーの追補c(1) と同じ仕組み)。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const REPO_ROOT = resolve(__dirname, '../..');

export function componentSource(rel: string): string {
	return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

/** `<style>…</style>` の中身(無ければ空文字)。 */
export function styleOf(source: string): string {
	const m = /<style[^>]*>([\s\S]*?)<\/style>/.exec(source);
	return m ? m[1]! : '';
}

export interface CssRule {
	/** セレクタの一覧(`a, b { … }` は ['a', 'b'])。 */
	selectors: string[];
	/** セレクタの先頭の、`css` の中での位置(直前のコメントを探すため)。 */
	start: number;
	/** `{` と `}` の間(コメントは残したまま)。 */
	body: string;
}

/** 最上位の規則を順に(`@media` などの入れ子は中まで見ない)。 */
export function cssRules(css: string): CssRule[] {
	const rules: CssRule[] = [];
	let i = 0;
	const n = css.length;
	while (i < n) {
		while (i < n && /\s/.test(css[i]!)) i++;
		if (i >= n) break;
		if (css.startsWith('/*', i)) {
			const end = css.indexOf('*/', i + 2);
			i = end < 0 ? n : end + 2;
			continue;
		}
		const start = i;
		const open = css.indexOf('{', i);
		if (open < 0) break;
		const selectorText = css.slice(start, open);
		let depth = 1;
		let j = open + 1;
		while (j < n && depth > 0) {
			if (css.startsWith('/*', j)) {
				const end = css.indexOf('*/', j + 2);
				j = end < 0 ? n : end + 2;
				continue;
			}
			if (css[j] === '{') depth++;
			else if (css[j] === '}') depth--;
			j++;
		}
		const body = css.slice(open + 1, Math.max(open + 1, j - 1));
		if (!selectorText.trim().startsWith('@')) {
			rules.push({
				selectors: selectorText
					.replace(/\/\*[\s\S]*?\*\//g, '')
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean),
				start,
				body,
			});
		}
		i = j;
	}
	return rules;
}

/** `selector` をセレクタに持つ規則すべて(書かれた順)。 */
export function rulesFor(css: string, selector: string): CssRule[] {
	return cssRules(css).filter((r) => r.selectors.includes(selector));
}

/** `selector` の規則の宣言(複数の規則は後が勝つ)。無ければ空の Map。 */
export function declarationsOf(css: string, selector: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const rule of rulesFor(css, selector)) {
		const body = rule.body.replace(/\/\*[\s\S]*?\*\//g, '');
		for (const part of body.split(';')) {
			const colon = part.indexOf(':');
			if (colon < 0) continue;
			const prop = part.slice(0, colon).trim();
			const value = part.slice(colon + 1).trim();
			if (prop) out.set(prop, value);
		}
	}
	return out;
}

/** `selector` の(最初の)規則の直前にある `/* … *\/` のコメントの中身。コメントが無ければ null。 */
export function commentBefore(css: string, selector: string): string | null {
	const rule = rulesFor(css, selector)[0];
	if (!rule) return null;
	let k = rule.start - 1;
	while (k >= 0 && /\s/.test(css[k]!)) k--;
	if (k < 1 || css[k] !== '/' || css[k - 1] !== '*') return null;
	const open = css.lastIndexOf('/*', k - 1);
	if (open < 0) return null;
	return css.slice(open + 2, k - 1);
}

/**
 * `var(--name[, fallback])` を `lookup` の値(無ければ fallback)で置き換える。値も fallback も無ければ投げる
 * (= その式は解けない)。
 */
export function substituteVars(expr: string, lookup: (name: string) => string | null): string {
	let out = '';
	let i = 0;
	while (i < expr.length) {
		if (expr.startsWith('var(', i)) {
			let depth = 1;
			let j = i + 4;
			while (j < expr.length && depth > 0) {
				if (expr[j] === '(') depth++;
				else if (expr[j] === ')') depth--;
				j++;
			}
			const inner = expr.slice(i + 4, j - 1);
			const comma = inner.indexOf(',');
			const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
			const fallback = comma < 0 ? null : inner.slice(comma + 1).trim();
			const value = lookup(name);
			if (value !== null && value.trim() !== '') out += value;
			else if (fallback !== null) out += substituteVars(fallback, lookup);
			else throw new Error(`${name} is not set on the element or its ancestors and has no fallback: ${expr}`);
			i = j;
		} else {
			out += expr[i];
			i++;
		}
	}
	return out;
}

/** `calc(44px + 8px)`・`0px`・`(1 + 2) * 3px` のような px の式を数にする(+ − × ÷ と括弧)。他の単位は解けない。 */
export function evaluatePx(expr: string): number {
	const s = expr.replace(/calc\(/g, '(').replace(/px/g, '').replace(/\s+/g, '');
	let pos = 0;
	const fail = (): never => {
		throw new Error(`cannot evaluate as a px expression: ${JSON.stringify(expr)} (stuck before ${JSON.stringify(s.slice(pos))})`);
	};
	function factor(): number {
		if (s[pos] === '(') {
			pos++;
			const v = sum();
			if (s[pos] !== ')') fail();
			pos++;
			return v;
		}
		const m = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(s.slice(pos));
		if (!m) fail();
		pos += m![0].length;
		return Number(m![0]);
	}
	function product(): number {
		let v = factor();
		while (s[pos] === '*' || s[pos] === '/') {
			const op = s[pos++];
			const r = factor();
			v = op === '*' ? v * r : v / r;
		}
		return v;
	}
	function sum(): number {
		let v = product();
		while (s[pos] === '+' || s[pos] === '-') {
			const op = s[pos++];
			const r = product();
			v = op === '+' ? v + r : v - r;
		}
		return v;
	}
	const v = sum();
	if (pos !== s.length) fail();
	return v;
}

/** 要素から祖先へ、inline style にあるカスタムプロパティの値を探す(CSS の継承の代わり)。 */
export function inlineCustomProperty(el: Element, name: string): string | null {
	for (let node: Element | null = el; node; node = node.parentElement) {
		const value = (node as HTMLElement).style?.getPropertyValue(name);
		if (value && value.trim() !== '') return value.trim();
	}
	return null;
}

/**
 * `selector` の `top` の宣言(`css` から)を、`el` とその祖先のカスタムプロパティで解いて px にする。
 * 宣言が無ければ投げる。
 */
export function resolvedTopPx(css: string, selector: string, el: Element): number {
	const top = declarationsOf(css, selector).get('top');
	if (top === undefined) throw new Error(`${selector} has no top declaration`);
	return evaluatePx(substituteVars(top, (name) => inlineCustomProperty(el, name)));
}
