/**
 * 要件#70 追補a の受け入れテスト(docs/requirements/req-70.md「追補a(2026-10-06・backlog 304)」)
 * — リンク切れの印のコントラスト(AC-70-追a。component プロジェクト・ソース読みだけでマウントしない=
 * Explorer.symlink.wiring.test.ts の AC-70-10 と theme.acceptance.test.ts と同じ家風)
 *
 * 「リンク切れの印の縁が WCAG 1.4.11 の 3:1 を下回る」を直す。リンク切れの行の印
 * (`.is-broken-link .link-badge`=矢印と白い四角の縁)を `--color-text-muted`(#8b949e)から
 * `--color-text-secondary`(#656d76)へ替え、名前(`.is-broken-link .name`)は muted のまま。
 *
 * ## 判定(AC-70-追a)
 * - (a) `ExplorerItem.svelte` の `<style>` に、セレクタに `is-broken-link` と `.link-badge` を含み
 *   `color: var(--color-text-secondary)` を当てる規則がある。`is-broken-link` と `.name` を含む規則は
 *   `color: var(--color-text-muted)` のまま
 * - (b) `theme.css` のトークンの値で計算したコントラスト比(WCAG 2.x の相対輝度):
 *   `--color-text-secondary` と `--color-bg-primary`・`--color-bg-secondary`・`--color-bg-tree-hover`・
 *   `--color-bg-tree-active` のどれとも 3.0 以上。
 *   **要件側更新(2026-11-03・要件#56 契約 2=由谷承認)**: theme.css は `themes/default.json` からの生成物になり、
 *   (1) 要件#7 の別名 7 個は `var()` で定義され、(2) hover / accent-soft(tree-hover / tree-active の別名先)は
 *   `rgba()` の半透明、(3) ダークの組(`:root[data-theme="dark"]` と `@media (prefers-color-scheme: dark)`)が
 *   後ろに並ぶ。そこで判定を「**ライトの組(at-rule の外・属性なしの `:root{}`)だけ**を読み、`var()` の別名を
 *   解決し、半透明の値はツリーの行が載る面(`--color-bg-secondary`=Explorer の地)に合成してから比を計算する」に
 *   改めた。要件#70 の趣旨(印の文字色と各面のコントラスト 3:1)は不変。ダークの組は判定しない(人間ゲート)
 * - (c) リンク切れの `.link-badge` に `--color-text-muted` を当てる規則が残っていない
 *
 * ## 判断の記録(test-writer 2026-10-06)
 * - セレクタはカンマ区切りの1つずつ(セレクタリストの各要素)で判定する。今の
 *   `.is-broken-link .name, .is-broken-link .link-badge { color: muted }` のように1つの規則に
 *   まとめてあっても、`.link-badge` 側の要素だけを見て (a)(c) を判定するため
 * - `.link-badge` は `.link-badge-bg` と区別する(後ろに `-` や英数字が続かない)。(c) は
 *   「印(矢印と白い四角の縁)」の全体を対象にするため、`.link-badge-bg` を含むリンク切れの
 *   セレクタも含め、どの宣言(color / stroke / fill)の値にも `--color-text-muted` が無いことを見る
 *   (契約(追補a)1 の「矢印と白い四角の縁は secondary」の字義)
 * - (b) は今の theme.css の値でも満たす(契約 3=theme.css は変えない)。トークンの値が変わって
 *   比が落ちたら赤になる見張りとして置く
 *
 * ## 判定しないもの
 * - 実機の描画での比(ホバー・選択中の重なり)→ /verify と E2E(`req70-symlink-gate.e2e.ts`)の記録
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EXPLORER_ITEM_PATH = resolve(__dirname, 'ExplorerItem.svelte');
const THEME_CSS_PATH = resolve(__dirname, '../styles/theme.css');

type Decl = { prop: string; value: string };
type Rule = { selectors: string[]; declarations: Decl[] };

function stripCssComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** セレクタリストを、括弧の中のカンマでは切らずに1つずつへ分ける。 */
function splitSelectorList(selector: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of selector) {
		if (ch === '(') depth++;
		if (ch === ')') depth--;
		if (ch === ',' && depth === 0) {
			out.push(current);
			current = '';
			continue;
		}
		current += ch;
	}
	out.push(current);
	return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length > 0);
}

function rulesOf(css: string): Rule[] {
	const rules: Rule[] = [];
	const re = /([^{}]+)\{([^{}]*)\}/g;
	for (let r = re.exec(css); r !== null; r = re.exec(css)) {
		const declarations = r[2]
			.split(';')
			.map((d) => d.trim())
			.filter((d) => d.length > 0 && d.includes(':'))
			.map((d) => {
				const idx = d.indexOf(':');
				return { prop: d.slice(0, idx).trim(), value: d.slice(idx + 1).replace(/\s+/g, '') };
			});
		rules.push({ selectors: splitSelectorList(r[1]), declarations });
	}
	return rules;
}

function explorerItemRules(): Rule[] {
	const source = readFileSync(EXPLORER_ITEM_PATH, 'utf8');
	const m = source.match(/<style[^>]*>([\s\S]*?)<\/style>/);
	expect(m, 'ExplorerItem.svelte has a <style> block').not.toBeNull();
	return rulesOf(stripCssComments(m![1]));
}

/** `.link-badge` そのもの(`.link-badge-bg` は含まない)。 */
const LINK_BADGE = /\.link-badge(?![-\w])/;
/** `.link-badge` と `.link-badge-bg`(印の全体)。 */
const LINK_BADGE_ANY = /\.link-badge(?:-bg)?(?![-\w])/;
const NAME = /\.name(?![-\w])/;
const BROKEN = /(?:^|[^-\w])is-broken-link(?![-\w])/;

/** セレクタの1要素ごとに、その規則の宣言を並べる。 */
function selectorDecls(rules: Rule[]): { selector: string; declarations: Decl[] }[] {
	return rules.flatMap((rule) => rule.selectors.map((selector) => ({ selector, declarations: rule.declarations })));
}

const hasColor = (decls: Decl[], value: string) => decls.some((d) => d.prop === 'color' && d.value === value);

// ---------------------------------------------------------------------------
// theme.css のトークンとコントラスト比(WCAG 2.x)
// ---------------------------------------------------------------------------

/**
 * theme.css の**ライトの組**だけのトークン(最後の宣言が勝つ)。生成物の theme.css は
 * `:root{}`(ライト)・`:root[data-theme="dark"]{}`・`@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){} }`
 * の 3 ブロックを持つ(要件#56 契約 2)。at-rule の中と `data-theme` 属性付きのセレクタは読まない。
 */
function lightThemeTokens(): Map<string, string> {
	const css = stripCssComments(readFileSync(THEME_CSS_PATH, 'utf8'));
	const out = new Map<string, string>();
	let depth = 0; // at-rule の入れ子の深さ(0 = トップレベル)
	let prelude = '';
	let i = 0;
	while (i < css.length) {
		const ch = css[i];
		if (ch === '{') {
			const selector = prelude.replace(/\s+/g, ' ').trim();
			prelude = '';
			if (selector.startsWith('@')) {
				depth++;
				i++;
				continue;
			}
			const end = css.indexOf('}', i);
			const body = css.slice(i + 1, end < 0 ? css.length : end);
			if (depth === 0 && /:root/.test(selector) && !/\[data-theme/.test(selector)) {
				const re = /(--[-\w]+)\s*:\s*([^{};]+)(?=[;}]|$)/g;
				for (let m = re.exec(body); m !== null; m = re.exec(body)) out.set(m[1], m[2].trim());
			}
			i = end < 0 ? css.length : end + 1;
			continue;
		}
		if (ch === '}') {
			if (depth > 0) depth--;
			prelude = '';
			i++;
			continue;
		}
		prelude += ch;
		i++;
	}
	return out;
}

type Rgba = { r: number; g: number; b: number; a: number };

/** `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()`(数値・0〜1 か % のアルファ)を読む。 */
function parseColor(value: string): Rgba {
	const v = value.trim().toLowerCase();
	const hex = v.match(/^#([0-9a-f]{3,8})$/);
	if (hex) {
		let h = hex[1];
		if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
		expect(h, `${value} is a #rgb / #rgba / #rrggbb / #rrggbbaa colour`).toMatch(/^[0-9a-f]{6}([0-9a-f]{2})?$/);
		const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
		const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
		return { r, g, b, a };
	}
	const fn = v.match(/^rgba?\(\s*([^)]*)\)$/);
	expect(fn, `${value} is a hex or rgb()/rgba() colour`).not.toBeNull();
	const parts = fn![1].split(/[\s,/]+/).filter((p) => p.length > 0);
	expect(parts.length, `${value} has 3 or 4 components`).toBeGreaterThanOrEqual(3);
	const channel = (p: string) => (p.endsWith('%') ? (parseFloat(p) * 255) / 100 : parseFloat(p));
	const alpha = (p: string | undefined) => (p === undefined ? 1 : p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p));
	return { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a: alpha(parts[3]) };
}

/** `var(--x)` / `var(--x, fallback)` の参照先(先頭の 1 つ)。参照でなければ null。 */
function varTarget(value: string): string | null {
	const m = value.trim().match(/^var\(\s*(--[-\w]+)/);
	return m ? m[1] : null;
}

/** 別名(`var()`)を辿って値を得る(循環や未定義は失敗)。 */
function resolveToken(tokens: Map<string, string>, name: string): string {
	const seen = new Set<string>();
	let current = name;
	for (;;) {
		expect(seen.has(current), `${name} does not reference itself (${[...seen].join(' -> ')})`).toBe(false);
		seen.add(current);
		const v = tokens.get(current);
		expect(v, `theme.css (light block) defines ${current} (needed by ${name})`).toBeDefined();
		const target = varTarget(v as string);
		if (target === null) return v as string;
		current = target;
	}
}

/** 半透明の色を面 `base`(不透明)に合成した不透明の色。 */
function compositeOver(top: Rgba, base: Rgba): Rgba {
	const a = top.a;
	return {
		r: top.r * a + base.r * (1 - a),
		g: top.g * a + base.g * (1 - a),
		b: top.b * a + base.b * (1 - a),
		a: 1,
	};
}

/** WCAG 2.x の相対輝度(不透明の色)。 */
function relativeLuminance(c: Rgba): number {
	const [r, g, b] = [c.r, c.g, c.b].map((x) => {
		const s = x / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: Rgba, b: Rgba): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 面の色。半透明ならツリーの行が載る面(`--color-bg-secondary`= Explorer の地)に合成する。 */
function opaqueSurface(tokens: Map<string, string>, name: string): Rgba {
	const colour = parseColor(resolveToken(tokens, name));
	if (colour.a >= 1) return colour;
	const pane = parseColor(resolveToken(tokens, '--color-bg-secondary'));
	expect(pane.a, '--color-bg-secondary (the Explorer pane) is opaque').toBe(1);
	return compositeOver(colour, pane);
}

const hexOf = (c: Rgba) =>
	'#' + [c.r, c.g, c.b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------------------
// (a) リンク切れの印は secondary・名前は muted のまま
// ---------------------------------------------------------------------------

describe('AC-70-追a (a): ExplorerItem.svelte <style> draws the broken-link badge with --color-text-secondary', () => {
	it('a selector containing is-broken-link and .link-badge sets color: var(--color-text-secondary)', () => {
		const matching = selectorDecls(explorerItemRules()).filter(
			(s) =>
				BROKEN.test(s.selector) &&
				LINK_BADGE.test(s.selector) &&
				hasColor(s.declarations, 'var(--color-text-secondary)')
		);
		expect(
			matching.length,
			'ExplorerItem.svelte needs e.g. `.is-broken-link .link-badge { color: var(--color-text-secondary); }`'
		).toBeGreaterThanOrEqual(1);
	});

	it('a selector containing is-broken-link and .name still sets color: var(--color-text-muted) (contract 6 unchanged)', () => {
		const matching = selectorDecls(explorerItemRules()).filter(
			(s) => BROKEN.test(s.selector) && NAME.test(s.selector) && hasColor(s.declarations, 'var(--color-text-muted)')
		);
		expect(matching.length, '`.is-broken-link .name { color: var(--color-text-muted); }` stays').toBeGreaterThanOrEqual(1);
	});
});

// ---------------------------------------------------------------------------
// (b) theme.css のトークン値で 3:1 以上
// ---------------------------------------------------------------------------

describe('AC-70-追a (b): --color-text-secondary reaches 3:1 against every row background (WCAG 1.4.11, light set of theme.css)', () => {
	const backgrounds = [
		'--color-bg-primary',
		'--color-bg-secondary',
		'--color-bg-tree-hover',
		'--color-bg-tree-active',
	] as const;

	it.each(backgrounds)('contrast(--color-text-secondary, %s) >= 3.0 (aliases resolved, translucent surfaces composited over the pane)', (bg) => {
		const tokens = lightThemeTokens();
		const fg = parseColor(resolveToken(tokens, '--color-text-secondary'));
		expect(fg.a, '--color-text-secondary is opaque').toBe(1);
		const back = opaqueSurface(tokens, bg);
		const ratio = contrastRatio(fg, back);
		expect(ratio, `${hexOf(fg)} on ${bg} = ${hexOf(back)}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3.0);
	});
});

// ---------------------------------------------------------------------------
// (c) リンク切れの印に muted が残っていない
// ---------------------------------------------------------------------------

describe('AC-70-追a (c): no rule paints the broken-link badge with --color-text-muted', () => {
	it('no selector containing is-broken-link and .link-badge / .link-badge-bg declares a value using --color-text-muted', () => {
		const offending = selectorDecls(explorerItemRules())
			.filter((s) => BROKEN.test(s.selector) && LINK_BADGE_ANY.test(s.selector))
			.flatMap((s) =>
				s.declarations
					.filter((d) => d.value.includes('--color-text-muted'))
					.map((d) => `${s.selector} { ${d.prop}: ${d.value} }`)
			);
		expect(offending, 'the broken-link badge must not be drawn with --color-text-muted any more').toEqual([]);
	});
});
