/**
 * 要件#54 追補d の受け入れテスト(docs/requirements/req-54.md「追補d(2026-10-06・backlog 306)」)
 * — 現在の一致の文字色(AC-54-追d。component プロジェクト・ソース読みだけでマウントしない=
 * Viewer.findfix.wiring.test.ts の「repo 読みの流儀」と Explorer.symlink.wiring.test.ts の
 * `<style>` の規則の読み方に合わせる)
 *
 * **要件側更新(2026-11-03・要件#56 第2段・棚卸し 3・起案時判断 (k))**: 要件#56 契約 2「ハードコード色ゼロ」
 * と原理的に両立しないため(ダークで黄色の面に明るい文字が載ると読めない=値も変わる)、判定を
 * 「リテラル `#1f2328` / `#fb923c` / `#fef08a` を持つ」から**「3 トークン `--color-find-current-text` /
 * `--color-find-current` / `--color-find-match` を `var()` で参照する」と「`themes/default.json` のライト/ダーク
 * それぞれの定義値で対比 4.5 以上」**に改めた。追補d の趣旨(現在の一致の文字色を固定して読めるようにする・
 * 他の一致は文字色を固定しない)は変えない。ライトの値は従来の 3 色のまま(判断 (k))。
 *
 * ## 判定(AC-54-追d・要件#56 判断 (k))
 * - (a) `Viewer.svelte` の `<style>` で、`::highlight(vellis-find-current)` と `mark[data-vellis-find-current]` の規則が
 *   `color: var(--color-find-current-text)` を持ち、`mark[data-vellis-find-current]` の子孫にも同じ色を当てる規則がある
 * - (b) 複製面の CSS(`Viewer.svelte` のスクリプト内の `FIND_SURFACE_CSS` の文字列)も同じ3つを持つ
 *   (custom property は shadow root にも継承されるので `var()` で書ける=判断 (k))
 * - (c) 他の一致(`vellis-find`・`mark[data-vellis-find]`)の背景は `var(--color-find-match)`・文字色は固定しない
 * - (d) `themes/default.json` のライトとダークそれぞれで、現在の一致の文字色と背景の比が 4.5 以上(WCAG 2.x の
 *   相対輝度で計算)。加えて他の一致でも、本文の文字色(`color-text-primary`)と一致の背景(半透明なら面の色
 *   `color-bg-surface` に合成)の比が 4.5 以上(ダークの `rgba(229,180,80,.32)` が読める値であること)。
 *   ライトの値は従来どおり `#1f2328` / `#fb923c` / `#fef08a`
 *
 * ## 判断の記録(test-writer 2026-10-06・2026-11-03 更新)
 * - `<style>` の `:global(…)` は外して読む(`.markdown-body :global(mark[data-vellis-find-current])` →
 *   `.markdown-body mark[data-vellis-find-current]`)。セレクタはカンマ区切りの1つずつで判定する
 * - 「`mark[data-vellis-find-current]` の規則」=その mark が主体(セレクタの最後の複合)の規則。
 *   「子孫」=`mark[data-vellis-find-current]` の後ろに子孫結合子(空白)で続く主体がある規則
 *   (例 `mark[data-vellis-find-current] *`)。子結合子 `>` だけでは子孫全体にならないので数えない
 * - 色の値は空白と大文字小文字を問わず、`!important` の有無も問わない(`var(--color-find-current-text) !important` も可)
 * - `FIND_SURFACE_CSS` は export されていないので、`Viewer.svelte` のソースから
 *   `const FIND_SURFACE_CSS =` の右辺の文字列リテラルを順に連結して取り出す(配列の `.join('')` の形も
 *   1本の文字列の形も読める。コメントは飛ばす)
 * - (c)「文字色は固定しない」=他の一致のセレクタ(子孫を含む)の `color` は無いか `inherit`
 * - (d) の値は `themes/default.json`(正本)から読む。`theme.css` は生成物なので読まない。半透明(`rgba(…, a)`)は
 *   面の色に合成してから比を取る
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VIEWER_PATH = resolve(__dirname, 'Viewer.svelte');
const DEFAULT_THEME_JSON = resolve(__dirname, '../../themes/default.json');

const CURRENT_FG_VAR = 'var(--color-find-current-text)';
const CURRENT_BG_VAR = 'var(--color-find-current)';
const OTHER_BG_VAR = 'var(--color-find-match)';

/** ライトの値は追補d のまま(判断 (k))。 */
const LIGHT_CURRENT_FG = '#1f2328';
const LIGHT_CURRENT_BG = '#fb923c';
const LIGHT_OTHER_BG = '#fef08a';

type Decl = { prop: string; value: string };
type Piece = { selector: string; declarations: Decl[] };

function viewerSource(): string {
	return readFileSync(VIEWER_PATH, 'utf8');
}

function stripCssComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** `:global(X)` を `X` に置き換える(括弧の対応を見る)。 */
function unglobal(selector: string): string {
	let out = selector;
	for (let idx = out.indexOf(':global('); idx !== -1; idx = out.indexOf(':global(')) {
		const start = idx + ':global('.length;
		let depth = 1;
		let i = start;
		for (; i < out.length && depth > 0; i++) {
			if (out[i] === '(') depth++;
			if (out[i] === ')') depth--;
		}
		const inner = out.slice(start, i - 1);
		out = out.slice(0, idx) + inner + out.slice(i);
	}
	return out;
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

/** CSS の規則を、セレクタの1要素ごとに宣言を付けて並べる。 */
function piecesOf(css: string): Piece[] {
	const pieces: Piece[] = [];
	const text = stripCssComments(css);
	const re = /([^{}]+)\{([^{}]*)\}/g;
	for (let r = re.exec(text); r !== null; r = re.exec(text)) {
		const declarations = r[2]
			.split(';')
			.map((d) => d.trim())
			.filter((d) => d.length > 0 && d.includes(':'))
			.map((d) => {
				const idx = d.indexOf(':');
				return { prop: d.slice(0, idx).trim().toLowerCase(), value: d.slice(idx + 1).trim() };
			});
		for (const selector of splitSelectorList(unglobal(r[1]))) {
			pieces.push({ selector, declarations });
		}
	}
	return pieces;
}

/** `Viewer.svelte` の `<style>`(行頭の `<style>` から行頭の `</style>` まで)。 */
function viewerStyleCss(): string {
	const m = viewerSource().match(/^<style[^>]*>([\s\S]*?)^<\/style>/m);
	expect(m, 'Viewer.svelte has a top-level <style> block').not.toBeNull();
	return m![1];
}

/**
 * `const FIND_SURFACE_CSS = …` の右辺の文字列リテラルを順に連結する。
 * `;`・`.join(` で止める。コメントは飛ばす。エスケープは `\'` `\"` `` \` `` `\\` だけ戻す。
 */
function findSurfaceCss(): string {
	const source = viewerSource();
	const m = /\bconst\s+FIND_SURFACE_CSS\s*(?::[^=]+)?=/.exec(source);
	expect(m, 'Viewer.svelte declares `const FIND_SURFACE_CSS =`').not.toBeNull();
	let i = m!.index + m![0].length;
	const parts: string[] = [];
	while (i < source.length) {
		const ch = source[i];
		if (ch === ';') break;
		if (source.startsWith('.join(', i)) break;
		if (ch === '/' && source[i + 1] === '/') {
			const nl = source.indexOf('\n', i);
			i = nl === -1 ? source.length : nl + 1;
			continue;
		}
		if (ch === '/' && source[i + 1] === '*') {
			const end = source.indexOf('*/', i + 2);
			i = end === -1 ? source.length : end + 2;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			let j = i + 1;
			let text = '';
			while (j < source.length && source[j] !== ch) {
				if (source[j] === '\\' && j + 1 < source.length) {
					text += source[j + 1];
					j += 2;
					continue;
				}
				text += source[j];
				j++;
			}
			parts.push(text);
			i = j + 1;
			continue;
		}
		i++;
	}
	const css = parts.join('');
	expect(css.length, 'FIND_SURFACE_CSS has string content').toBeGreaterThan(0);
	return css;
}

/** 値から `!important` を落として小文字・空白なしにする。 */
function normValue(value: string): string {
	return value.replace(/!\s*important/i, '').replace(/\s+/g, '').toLowerCase();
}

function valuesOf(pieces: Piece[], props: string[]): string[] {
	return pieces.flatMap((p) => p.declarations.filter((d) => props.includes(d.prop)).map((d) => normValue(d.value)));
}

const isCurrentHighlight = (s: string) => /::highlight\(\s*vellis-find-current\s*\)/.test(s);
/** 現在の一致の mark が主体(セレクタの最後の複合)。 */
const isCurrentMark = (s: string) => /mark\[data-vellis-find-current\]$/.test(s);
/** 現在の一致の mark の子孫が主体(子孫結合子=空白で続く)。 */
const isCurrentMarkDescendant = (s: string) => /mark\[data-vellis-find-current\]\s+[^\s>+~]/.test(s);

const isOtherHighlight = (s: string) => /::highlight\(\s*vellis-find\s*\)/.test(s);
const isOtherMarkSubject = (s: string) => /mark\[data-vellis-find\]$/.test(s);
const touchesOtherMark = (s: string) => /mark\[data-vellis-find\]/.test(s);

function expectCurrentColorTriple(pieces: Piece[], where: string) {
	const highlight = pieces.filter((p) => isCurrentHighlight(p.selector));
	expect(
		valuesOf(highlight, ['color']),
		`${where}: ::highlight(vellis-find-current) { color: ${CURRENT_FG_VAR} }`
	).toContain(CURRENT_FG_VAR);

	const mark = pieces.filter((p) => isCurrentMark(p.selector));
	expect(
		valuesOf(mark, ['color']),
		`${where}: mark[data-vellis-find-current] { color: ${CURRENT_FG_VAR} }`
	).toContain(CURRENT_FG_VAR);

	const descendant = pieces.filter((p) => isCurrentMarkDescendant(p.selector));
	expect(
		valuesOf(descendant, ['color']),
		`${where}: a rule like mark[data-vellis-find-current] * { color: ${CURRENT_FG_VAR} } for its descendants`
	).toContain(CURRENT_FG_VAR);
}

function expectCurrentBackgroundToken(pieces: Piece[], where: string) {
	const current = pieces.filter((p) => isCurrentHighlight(p.selector) || isCurrentMark(p.selector));
	const backgrounds = valuesOf(current, ['background-color', 'background']);
	expect(backgrounds.length, `${where}: the current match has a background`).toBeGreaterThanOrEqual(1);
	expect(
		backgrounds.every((v) => v === CURRENT_BG_VAR),
		`${where}: current match background is ${CURRENT_BG_VAR} (${backgrounds.join(', ')})`
	).toBe(true);
}

function expectOtherMatchesUnchanged(pieces: Piece[], where: string) {
	const highlight = pieces.filter((p) => isOtherHighlight(p.selector));
	const mark = pieces.filter((p) => isOtherMarkSubject(p.selector));
	for (const [label, group] of [
		['::highlight(vellis-find)', highlight],
		['mark[data-vellis-find]', mark],
	] as const) {
		const backgrounds = valuesOf(group, ['background-color', 'background']);
		expect(backgrounds.length, `${where}: ${label} has a background`).toBeGreaterThanOrEqual(1);
		expect(
			backgrounds.every((v) => v === OTHER_BG_VAR),
			`${where}: ${label} background is ${OTHER_BG_VAR} (${backgrounds.join(', ')})`
		).toBe(true);
	}
	const colors = valuesOf(
		pieces.filter((p) => isOtherHighlight(p.selector) || touchesOtherMark(p.selector)),
		['color']
	);
	expect(
		colors.filter((v) => v !== 'inherit'),
		`${where}: other matches do not fix the text colour (color absent or inherit)`
	).toEqual([]);
}

// ---------------------------------------------------------------------------
// 正本 themes/default.json の値と WCAG 2.x のコントラスト比
// ---------------------------------------------------------------------------

type ThemeJson = { common?: Record<string, string>; light?: Record<string, string>; dark?: Record<string, string> };

function defaultTheme(): ThemeJson {
	return JSON.parse(readFileSync(DEFAULT_THEME_JSON, 'utf8')) as ThemeJson;
}

/** モードの解決値(common → mode の順で後勝ち)。鍵は `--` 無し。 */
function valuesFor(mode: 'light' | 'dark'): Record<string, string> {
	const theme = defaultTheme();
	return { ...(theme.common ?? {}), ...(theme[mode] ?? {}) };
}

type Rgba = { r: number; g: number; b: number; a: number };

/** `#rgb` / `#rrggbb` / `rgb(…)` / `rgba(…)`(カンマ区切り・小数のアルファ)を読む。 */
function parseColor(value: string): Rgba {
	const v = value.trim().toLowerCase();
	const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
	if (hex) {
		const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
		return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
	}
	const fn = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
	expect(fn, `${value} is #rgb / #rrggbb / rgb() / rgba()`).not.toBeNull();
	return { r: Number(fn![1]), g: Number(fn![2]), b: Number(fn![3]), a: fn![4] === undefined ? 1 : Number(fn![4]) };
}

/** `top` を `under`(不透明)に合成する。 */
function composite(top: Rgba, under: Rgba): Rgba {
	const a = top.a;
	return {
		r: top.r * a + under.r * (1 - a),
		g: top.g * a + under.g * (1 - a),
		b: top.b * a + under.b * (1 - a),
		a: 1,
	};
}

function relativeLuminance(c: Rgba): number {
	const [r, g, b] = [c.r, c.g, c.b].map((n) => {
		const s = n / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: Rgba, b: Rgba): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `value`(半透明かもしれない)を面 `surface` の上に置いた不透明の色。 */
function onSurface(value: string, surface: string): Rgba {
	const c = parseColor(value);
	return c.a >= 1 ? c : composite(c, parseColor(surface));
}

// ---------------------------------------------------------------------------
// (a) 閲覧面
// ---------------------------------------------------------------------------

describe('AC-54-追d (a): Viewer.svelte <style> fixes the current match text colour to var(--color-find-current-text)', () => {
	it('::highlight(vellis-find-current)・mark[data-vellis-find-current]・その子孫に color: var(--color-find-current-text)', () => {
		expectCurrentColorTriple(piecesOf(viewerStyleCss()), 'Viewer.svelte <style>');
	});

	it('現在の一致の背景は var(--color-find-current)', () => {
		expectCurrentBackgroundToken(piecesOf(viewerStyleCss()), 'Viewer.svelte <style>');
	});
});

// ---------------------------------------------------------------------------
// (b) html の複製面
// ---------------------------------------------------------------------------

describe('AC-54-追d (b): FIND_SURFACE_CSS (html find surface) has the same three rules', () => {
	it('::highlight(vellis-find-current)・mark[data-vellis-find-current]・その子孫に color: var(--color-find-current-text)', () => {
		expectCurrentColorTriple(piecesOf(findSurfaceCss()), 'FIND_SURFACE_CSS');
	});

	it('現在の一致の背景は var(--color-find-current)', () => {
		expectCurrentBackgroundToken(piecesOf(findSurfaceCss()), 'FIND_SURFACE_CSS');
	});
});

// ---------------------------------------------------------------------------
// (c) 他の一致は不変(背景はトークン・文字色は固定しない)
// ---------------------------------------------------------------------------

describe('AC-54-追d (c): other matches use var(--color-find-match) and do not fix the text colour', () => {
	it('Viewer.svelte <style>', () => {
		expectOtherMatchesUnchanged(piecesOf(viewerStyleCss()), 'Viewer.svelte <style>');
	});

	it('FIND_SURFACE_CSS', () => {
		expectOtherMatchesUnchanged(piecesOf(findSurfaceCss()), 'FIND_SURFACE_CSS');
	});
});

// ---------------------------------------------------------------------------
// (d) コントラスト比(themes/default.json のライト/ダーク)
// ---------------------------------------------------------------------------

describe('AC-54-追d (d): the current match reaches 4.5:1 in both modes of themes/default.json', () => {
	it('light keeps the 追補d values: #1f2328 on #fb923c, other matches #fef08a', () => {
		const light = valuesFor('light');
		expect(light['color-find-current-text'].toLowerCase()).toBe(LIGHT_CURRENT_FG);
		expect(light['color-find-current'].toLowerCase()).toBe(LIGHT_CURRENT_BG);
		expect(light['color-find-match'].toLowerCase()).toBe(LIGHT_OTHER_BG);
	});

	it.each(['light', 'dark'] as const)('%s: contrast(color-find-current-text, color-find-current) >= 4.5', (mode) => {
		const v = valuesFor(mode);
		const bg = onSurface(v['color-find-current'], v['color-bg-surface']);
		const text = parseColor(v['color-find-current-text']);
		const fg = text.a >= 1 ? text : composite(text, bg);
		const ratio = contrastRatio(fg, bg);
		expect(ratio, `${mode}: ${v['color-find-current-text']} on ${v['color-find-current']} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
	});

	it.each(['light', 'dark'] as const)('%s: the other matches stay readable= contrast(color-text-primary, color-find-match on color-bg-surface) >= 4.5', (mode) => {
		const v = valuesFor(mode);
		const bg = onSurface(v['color-find-match'], v['color-bg-surface']);
		const fg = parseColor(v['color-text-primary']);
		const ratio = contrastRatio(fg, bg);
		expect(ratio, `${mode}: ${v['color-text-primary']} on ${v['color-find-match']} over ${v['color-bg-surface']} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
	});

	it.each([
		['Viewer.svelte <style>', () => piecesOf(viewerStyleCss())],
		['FIND_SURFACE_CSS', () => piecesOf(findSurfaceCss())],
	] as const)('%s: the current match declares the text colour as the token (not a fixed #rrggbb, not inherit)', (_where, load) => {
		const current = load().filter((p) => isCurrentHighlight(p.selector) || isCurrentMark(p.selector));
		const colors = valuesOf(current, ['color']);
		expect(colors.length, 'the current match declares a text colour').toBeGreaterThanOrEqual(1);
		for (const fg of colors) {
			expect(fg, 'current match text colour is var(--color-find-current-text)').toBe(CURRENT_FG_VAR);
		}
	});
});
