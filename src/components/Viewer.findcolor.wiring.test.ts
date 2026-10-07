/**
 * 要件#54 追補d の受け入れテスト(docs/requirements/req-54.md「追補d(2026-10-06・backlog 306)」)
 * — 現在の一致の文字色(AC-54-追d。component プロジェクト・ソース読みだけでマウントしない=
 * Viewer.findfix.wiring.test.ts の「repo 読みの流儀」と Explorer.symlink.wiring.test.ts の
 * `<style>` の規則の読み方に合わせる)
 *
 * 「いま選んでいる一致」の背景 #fb923c の上で Shiki の橙のトークン(rgb(227,98,9))の比が 1.54 しか
 * ない。現在の一致は**文字の色を #1f2328 に固定**する(背景 #fb923c との比 7.0)。
 *
 * ## 判定(AC-54-追d)
 * - (a) `Viewer.svelte` の `<style>` で、`::highlight(vellis-find-current)` と
 *   `mark[data-vellis-find-current]` の規則が `color: #1f2328` を持ち、`mark[data-vellis-find-current]`
 *   の子孫にも同じ色を当てる規則がある
 * - (b) 複製面の CSS(`Viewer.svelte` のスクリプト内の `FIND_SURFACE_CSS` の文字列)も同じ3つを持つ
 * - (c) 他の一致(`vellis-find`・`mark[data-vellis-find]`)の背景は #fef08a・文字色は固定しない
 * - (d) #1f2328 と #fb923c の比が 4.5 以上(WCAG 2.x の相対輝度で計算)
 *
 * ## 判断の記録(test-writer 2026-10-06)
 * - `<style>` の `:global(…)` は外して読む(`.markdown-body :global(mark[data-vellis-find-current])` →
 *   `.markdown-body mark[data-vellis-find-current]`)。セレクタはカンマ区切りの1つずつで判定する
 * - 「`mark[data-vellis-find-current]` の規則」=その mark が主体(セレクタの最後の複合)の規則。
 *   「子孫」=`mark[data-vellis-find-current]` の後ろに子孫結合子(空白)で続く主体がある規則
 *   (例 `mark[data-vellis-find-current] *`)。子結合子 `>` だけでは子孫全体にならないので数えない
 * - 色の値は大文字小文字を問わず、`!important` の有無も問わない(`#1F2328 !important` も可)。
 *   ※ Shiki のトークンは `style="color:…"` のインラインで色を持つため、`<mark>` のフォールバックで
 *   mark が要素をまたぐときに子孫の規則がインラインに勝つには `!important` が要る。ただし受け入れ基準は
 *   「同じ色を当てる規則がある」までなので、ここでは要求しない(報告事項)
 * - `FIND_SURFACE_CSS` は export されていないので、`Viewer.svelte` のソースから
 *   `const FIND_SURFACE_CSS =` の右辺の文字列リテラルを順に連結して取り出す(配列の `.join('')` の形も
 *   1本の文字列の形も読める。コメントは飛ばす)
 * - (c)「文字色は固定しない」=他の一致のセレクタ(子孫を含む)の `color` は無いか `inherit`
 * - (d) は計算だけなら今でも緑になるので、両面の現在の一致の規則が宣言する背景と文字色の組
 *   (#fb923c と #1f2328)でも比を確かめる(背景色は不変=契約(追補d))
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VIEWER_PATH = resolve(__dirname, 'Viewer.svelte');

const CURRENT_FG = '#1f2328';
const CURRENT_BG = '#fb923c';
const OTHER_BG = '#fef08a';

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
		`${where}: ::highlight(vellis-find-current) { color: ${CURRENT_FG} }`
	).toContain(CURRENT_FG);

	const mark = pieces.filter((p) => isCurrentMark(p.selector));
	expect(
		valuesOf(mark, ['color']),
		`${where}: mark[data-vellis-find-current] { color: ${CURRENT_FG} }`
	).toContain(CURRENT_FG);

	const descendant = pieces.filter((p) => isCurrentMarkDescendant(p.selector));
	expect(
		valuesOf(descendant, ['color']),
		`${where}: a rule like mark[data-vellis-find-current] * { color: ${CURRENT_FG} } for its descendants`
	).toContain(CURRENT_FG);
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
		expect(backgrounds.every((v) => v === OTHER_BG), `${where}: ${label} background stays ${OTHER_BG} (${backgrounds.join(', ')})`).toBe(true);
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
// WCAG 2.x のコントラスト比
// ---------------------------------------------------------------------------

function relativeLuminance(hex: string): number {
	const h = hex.replace(/^#/, '').toLowerCase();
	expect(h, `${hex} is #rrggbb`).toMatch(/^[0-9a-f]{6}$/);
	const [r, g, b] = [0, 2, 4].map((i) => {
		const s = parseInt(h.slice(i, i + 2), 16) / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ---------------------------------------------------------------------------
// (a) 閲覧面
// ---------------------------------------------------------------------------

describe('AC-54-追d (a): Viewer.svelte <style> fixes the current match text colour to #1f2328', () => {
	it('::highlight(vellis-find-current)・mark[data-vellis-find-current]・その子孫に color: #1f2328', () => {
		expectCurrentColorTriple(piecesOf(viewerStyleCss()), 'Viewer.svelte <style>');
	});
});

// ---------------------------------------------------------------------------
// (b) html の複製面
// ---------------------------------------------------------------------------

describe('AC-54-追d (b): FIND_SURFACE_CSS (html find surface) has the same three rules', () => {
	it('::highlight(vellis-find-current)・mark[data-vellis-find-current]・その子孫に color: #1f2328', () => {
		expectCurrentColorTriple(piecesOf(findSurfaceCss()), 'FIND_SURFACE_CSS');
	});
});

// ---------------------------------------------------------------------------
// (c) 他の一致は不変
// ---------------------------------------------------------------------------

describe('AC-54-追d (c): other matches keep #fef08a and do not fix the text colour', () => {
	it('Viewer.svelte <style>', () => {
		expectOtherMatchesUnchanged(piecesOf(viewerStyleCss()), 'Viewer.svelte <style>');
	});

	it('FIND_SURFACE_CSS', () => {
		expectOtherMatchesUnchanged(piecesOf(findSurfaceCss()), 'FIND_SURFACE_CSS');
	});
});

// ---------------------------------------------------------------------------
// (d) コントラスト比
// ---------------------------------------------------------------------------

describe('AC-54-追d (d): #1f2328 on #fb923c reaches 4.5:1', () => {
	it('contrast(#1f2328, #fb923c) >= 4.5', () => {
		const ratio = contrastRatio(CURRENT_FG, CURRENT_BG);
		expect(ratio, `ratio = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
	});

	it.each([
		['Viewer.svelte <style>', () => piecesOf(viewerStyleCss())],
		['FIND_SURFACE_CSS', () => piecesOf(findSurfaceCss())],
	] as const)('%s: the declared current-match background/text pair is #fb923c / #1f2328 and reaches 4.5:1', (_where, load) => {
		const current = load().filter((p) => isCurrentHighlight(p.selector) || isCurrentMark(p.selector));
		const backgrounds = valuesOf(current, ['background-color', 'background']);
		const colors = valuesOf(current, ['color']);
		expect(backgrounds.length).toBeGreaterThanOrEqual(1);
		expect(backgrounds.every((v) => v === CURRENT_BG), `background stays ${CURRENT_BG}: ${backgrounds.join(', ')}`).toBe(true);
		expect(colors.length, 'the current match declares a text colour').toBeGreaterThanOrEqual(1);
		for (const fg of colors) {
			expect(fg, 'current match text colour is a fixed #rrggbb (not inherit)').toMatch(/^#[0-9a-f]{6}$/);
			expect(contrastRatio(fg, CURRENT_BG), `${fg} on ${CURRENT_BG}`).toBeGreaterThanOrEqual(4.5);
		}
	});
});
