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
 *   `--color-bg-tree-active` のどれとも 3.0 以上
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

function themeTokens(): Map<string, string> {
	const css = stripCssComments(readFileSync(THEME_CSS_PATH, 'utf8'));
	const out = new Map<string, string>();
	const re = /(--[-\w]+)\s*:\s*([^{};]+)(?=[;}])/g;
	for (let m = re.exec(css); m !== null; m = re.exec(css)) {
		out.set(m[1], m[2].trim());
	}
	return out;
}

function hexToRgb(hex: string): [number, number, number] {
	let h = hex.trim().replace(/^#/, '').toLowerCase();
	if (h.length === 3) h = h.split('').map((c) => c + c).join('');
	expect(h, `${hex} is an opaque #rgb / #rrggbb colour`).toMatch(/^[0-9a-f]{6}$/);
	return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG 2.x の相対輝度。 */
function relativeLuminance(hex: string): number {
	const [r, g, b] = hexToRgb(hex).map((c) => {
		const s = c / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function tokenValue(tokens: Map<string, string>, name: string): string {
	const v = tokens.get(name);
	expect(v, `theme.css defines ${name}`).toBeDefined();
	return v as string;
}

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

describe('AC-70-追a (b): --color-text-secondary reaches 3:1 against every row background (WCAG 1.4.11)', () => {
	const backgrounds = [
		'--color-bg-primary',
		'--color-bg-secondary',
		'--color-bg-tree-hover',
		'--color-bg-tree-active',
	] as const;

	it.each(backgrounds)('contrast(--color-text-secondary, %s) >= 3.0', (bg) => {
		const tokens = themeTokens();
		const fg = tokenValue(tokens, '--color-text-secondary');
		const back = tokenValue(tokens, bg);
		const ratio = contrastRatio(fg, back);
		expect(ratio, `${fg} on ${back} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3.0);
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
