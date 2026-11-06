/**
 * 要件#56 の受け入れテスト(docs/requirements/req-56.md)— 第2段のアイコンと状態表現
 * (AC-56-10・契約 5 と判断 (i) の SVG sprite・契約 4 のフォーカス/オーバーレイ)
 *
 * 判定するもの:
 * - AC-56-10  `src/components/*.svelte` の markup(`<style>`・`<script>`・`<!-- -->` 以外)に Unicode 記号アイコン
 *   `×` `✕` `−` `⌄` `›` `▶` `■` が残っていない。**記号の集合は本ファイルで固定**(`…` と `⌘` は文言の一部なので
 *   含めない)。属性値と markup 中の式(`{expanded ? '⌄' : '›'}`)も markup として見る
 *   (要件の脚注 [^unicode-icons] の測り方=`<style>` と `<script>` の外の行、と同じ)。
 *   **例外(要件側の決定・2026-11-03 オーケストレーター=推奨で確定)**: **数字に隣接する `−` と `×`**(コマ送りの
 *   `−1` `−{LARGE_FRAME_STEP}`(=−10)・等倍の `1×`・tooltip の `(×2)`)は数字付きの文言でアイコンではないので
 *   対象外。理由= 要件#51 の可視名のテスト(`ui-language.wiring.test.ts` の `−1/+1/−10/+10 は不変`)を無改変のまま
 *   保つ(AC-56-13)。モック画面 6 との差(コマ送りが SVG)は契約 1 どおり人間ゲート 1 で判定する。
 *   単独の `−`(Zoom Out Waveform のボタンの中身)は対象のまま
 * - 契約 5・判断 (i)  `src/components/Icon.svelte` があり、`name` を受けて `<svg><use href="#i-…"/></svg>` で描く。
 *   `<symbol id="i-…">` の定義は **1 つのファイル**(`+page.svelte` か 1 つの sprite コンポーネント)に 1 回だけ。
 *   symbol は `viewBox="0 0 24 24"`・id はモック(`docs/review/ui-mock.html`=契約 1 の正本)の 91 個の中にあり、
 *   字形(symbol の中身)はモックと同じ。`<use>` / `<Icon name>` で参照される名前はすべて定義済み。
 *   線は `currentColor`・`fill: none`・`stroke-width: 1.7`(契約 5)。sprite は画面に場所を取らず aria-hidden。
 *   Unicode 記号を置き換えた 7 ファイルは `Icon` を使う。依存追加なしは AC-56-11(ui-invariants.acceptance)のまま
 * - 契約 4(状態)  キーボードフォーカスが必ず見える= `:focus-visible` に `--color-focus-ring` の 2px のリング
 *   (`app.css` の全体規則か、掴める要素を持つ各コンポーネントの規則)。`:focus` 系で `outline: none` にする規則が
 *   あるファイルは同じファイルの `:focus-visible` でリングを戻す。オーバーレイ 6 つ(ContextMenu・UpdateBanner・
 *   InstructionDialog・DiffView・FindBar・GoToBar)は `--color-bg-raised` + `--shadow-2` + `--radius-md` の 1 段。
 *   暗くする層(DiffView・InstructionDialog の backdrop)は `--color-shadow`。影の `rgba(0,0,0,…)` 直書きは
 *   AC-56-3(design-tokens-stage2.acceptance)が止める
 *
 * 判定しないもの(人間ゲート 1・6): アイコンの形と大きさの揃い・ホバーと選択行の見え方・フォーカスの手応え。
 * `+` と `−` の字幅の不揃い(要件#51 人間ゲート 7)は AC-56-10 で `−` が消えることで機械側は尽きる。
 *
 * ## 確定契約(implementer はこれに従う=本テストが前提にする名前)
 *
 * ```svelte
 * <!-- src/components/Icon.svelte(新規) -->
 * <script lang="ts">
 *   let { name, size = 16 }: { name: string; size?: number } = $props();   // name = モックの id から i- を除いたもの
 * </script>
 * <svg class="icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"
 *      fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
 *   <use href={`#i-${name}`} />
 * </svg>
 *
 * <!-- src/routes/+page.svelte の先頭(または 1 つの sprite コンポーネント)に 1 回だけ -->
 * <svg class="icon-sprite" aria-hidden="true" width="0" height="0" style="position:absolute">
 *   <symbol id="i-x" viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></symbol>   <!-- モックから写す -->
 *   …
 * </svg>
 * ```
 *
 * ```css
 * /* app.css(推奨=全体で 1 つ)か各コンポーネント *\/
 * :focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 2px; }
 * ```
 *
 * 判定方式: ソース検査型(markup の切り出し・CSS の字句解析・モックの symbol の照合)。
 *
 * 実装前の見立て(赤の理由): Icon.svelte も sprite も無い・Unicode 記号が 8 行・9 箇所(要件の脚注の 14 箇所から
 * 数字に隣接する 5 箇所= VideoViewer の `−{LARGE_FRAME_STEP}` `−1` `(×2)` `1×`・AudioViewer の `(×2)` `1×` を除く:
 * VideoViewer `−` 1・AudioViewer `−` 1・RecentFiles `⌄` `›` 2・ProvenancePanel 1・MarkList 1・DiffView 1・
 * UpdateBanner 1)・`:focus-visible` のリングは
 * RecentFiles と FindInFolder だけ・オーバーレイ 6 つのどれも `--shadow-2` / `--radius-md` を参照していない。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');
const COMPONENTS_DIR = resolve(REPO_ROOT, 'src/components');
const ICON_SVELTE = resolve(COMPONENTS_DIR, 'Icon.svelte');
const MOCK_HTML = resolve(REPO_ROOT, 'docs/review/ui-mock.html');
const APP_CSS = resolve(REPO_ROOT, 'src/styles/app.css');

/** AC-56-10 の記号の集合(値固定)。`…`(Open With… 等)と `⌘`(案内文)はアイコンではないので含めない。 */
const ICON_SYMBOLS = ['×', '✕', '−', '⌄', '›', '▶', '■'] as const;
const NOT_ICON_SYMBOLS = ['…', '⌘'] as const;
/** 数字に隣接すれば文言(`−1` `1×` `(×2)`)として対象外にする記号(要件側の決定・2026-11-03)。 */
const NUMERIC_CONTEXT_SYMBOLS = ['−', '×'] as const;

/**
 * markup の 1 行から、対象の記号の位置(列)を集める。`−` と `×` は直前か直後が数字(0-9)、または直後が
 * `{`(`−{LARGE_FRAME_STEP}` のような数値の補間)なら文言として飛ばす。
 */
function iconSymbolColumns(line: string): number[] {
	const out: number[] = [];
	const chars = [...line];
	chars.forEach((ch, i) => {
		if (!(ICON_SYMBOLS as readonly string[]).includes(ch)) return;
		if ((NUMERIC_CONTEXT_SYMBOLS as readonly string[]).includes(ch)) {
			const prev = chars[i - 1] ?? '';
			const next = chars[i + 1] ?? '';
			if (/[0-9]/.test(prev) || /[0-9]/.test(next) || next === '{') return;
		}
		out.push(i + 1);
	});
	return out;
}

/** 再起案時点で Unicode 記号アイコンを持っていた 7 ファイル(要件の脚注 [^unicode-icons])。 */
const FILES_WITH_UNICODE_ICONS = [
	'AudioViewer.svelte',
	'DiffView.svelte',
	'MarkList.svelte',
	'ProvenancePanel.svelte',
	'RecentFiles.svelte',
	'UpdateBanner.svelte',
	'VideoViewer.svelte',
] as const;

/** 契約 4: 重なりの表現を揃えるオーバーレイ 6 つ。 */
const OVERLAY_COMPONENTS = [
	'ContextMenu.svelte',
	'UpdateBanner.svelte',
	'InstructionDialog.svelte',
	'DiffView.svelte',
	'FindBar.svelte',
	'GoToBar.svelte',
] as const;
const OVERLAY_TOKENS = ['--color-bg-raised', '--shadow-2', '--radius-md'] as const;
/** 暗くする層(backdrop)を持つモーダル 2 つ。 */
const BACKDROP_COMPONENTS = ['DiffView.svelte', 'InstructionDialog.svelte'] as const;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function readText(path: string): string {
	return readFileSync(path, 'utf8');
}

function componentFiles(): string[] {
	return readdirSync(COMPONENTS_DIR)
		.filter((f) => f.endsWith('.svelte'))
		.sort();
}

function componentSource(name: string): string {
	return readText(join(COMPONENTS_DIR, name));
}

/** 範囲を同じ行数の空行に置き換える(行番号を保つ)。 */
function blankOut(source: string, re: RegExp): string {
	return source.replace(re, (m) => m.replace(/[^\n]/g, ' '));
}

/** markup= `<script>`・`<style>`・`<!-- -->` を落としたもの(行番号は保つ)。 */
function markupOf(source: string): string {
	let out = blankOut(source, /<script[^>]*>[\s\S]*?<\/script>/g);
	out = blankOut(out, /<style[^>]*>[\s\S]*?<\/style>/g);
	out = blankOut(out, /<!--[\s\S]*?-->/g);
	return out;
}

function styleBlocksOf(source: string): string[] {
	return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
}

function stripCssComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

type Decl = { prop: string; value: string };
type Rule = { selector: string; body: string; at: string[] };

function declarationsOf(css: string): Decl[] {
	const out: Decl[] = [];
	const re = /([-\w]+)\s*:\s*([^{};]+)(?=[;}])/g;
	for (let m = re.exec(css); m !== null; m = re.exec(css)) out.push({ prop: m[1], value: m[2].trim() });
	return out;
}

function parseRules(css: string): Rule[] {
	const rules: Rule[] = [];
	const stack: string[] = [];
	let prelude = '';
	let i = 0;
	while (i < css.length) {
		const c = css[i];
		if (c === '{') {
			const p = prelude.replace(/\s+/g, ' ').trim();
			prelude = '';
			if (p.startsWith('@')) {
				stack.push(p);
				i += 1;
				continue;
			}
			let depth = 1;
			let j = i + 1;
			while (j < css.length && depth > 0) {
				if (css[j] === '{') depth += 1;
				else if (css[j] === '}') depth -= 1;
				j += 1;
			}
			rules.push({ selector: p, body: css.slice(i + 1, j - 1), at: [...stack] });
			i = j;
			continue;
		}
		if (c === '}') {
			stack.pop();
			prelude = '';
			i += 1;
			continue;
		}
		prelude += c;
		i += 1;
	}
	return rules;
}

function componentRules(name: string): Rule[] {
	return styleBlocksOf(componentSource(name)).flatMap((css) => parseRules(stripCssComments(css)));
}

/** `selector` がフォーカスの擬似クラスを持つ(`:focus` / `:focus-visible` / `:focus-within`)。 */
const hasFocusPseudo = (selector: string) => /:focus(-visible|-within)?\b/.test(selector);
const hasFocusVisible = (selector: string) => /:focus-visible\b/.test(selector);

/** リングの宣言= outline か box-shadow が `--color-focus-ring` を参照し、`2px` を含む。 */
function declaresFocusRing(decls: Decl[]): boolean {
	return decls.some(
		(d) => /^(outline|outline-color|box-shadow|border|border-color)$/.test(d.prop) && /var\(\s*--color-focus-ring\b/.test(d.value),
	);
}

function declaresTwoPxRing(decls: Decl[]): boolean {
	return decls.some((d) => /^(outline|box-shadow|outline-width)$/.test(d.prop) && /\b2px\b/.test(d.value));
}

/** `:focus-visible` のリングの規則(リングの参照と 2px の両方を、同じ規則か同じファイルの focus-visible 規則群で満たす)。 */
function hasFocusVisibleRing(rules: Rule[]): boolean {
	const fv = rules.filter((r) => hasFocusVisible(r.selector));
	const decls = fv.flatMap((r) => declarationsOf(r.body));
	return declaresFocusRing(decls) && declaresTwoPxRing(decls);
}

function appCssRules(): Rule[] {
	return parseRules(stripCssComments(readText(APP_CSS)));
}

/** 全体のフォーカスリング= app.css の `:focus-visible`(単独か `*:focus-visible` / `:where(:focus-visible)` 等)。 */
function globalFocusRing(): boolean {
	return hasFocusVisibleRing(appCssRules());
}

/** 掴める要素(キーボードで止まれるもの)を markup に持つか。 */
function hasFocusableMarkup(markup: string): boolean {
	return /<(button|input|select|textarea|a)\b|tabindex\s*=|contenteditable/.test(markup);
}

// --- モックの symbol ---------------------------------------------------------

type IconSymbol = { id: string; attrs: string; inner: string };

function symbolsIn(text: string): IconSymbol[] {
	return [...text.matchAll(/<symbol\s+id="(i-[\w-]+)"([^>]*)>([\s\S]*?)<\/symbol>/g)].map((m) => ({
		id: m[1],
		attrs: m[2],
		inner: m[3].replace(/\s+/g, ' ').trim(),
	}));
}

function mockSymbols(): Map<string, IconSymbol> {
	const map = new Map<string, IconSymbol>();
	for (const s of symbolsIn(readText(MOCK_HTML))) map.set(s.id, s);
	return map;
}

/** `src/**\/*.svelte` を集める(sprite とアイコンの参照の走査に使う)。 */
function allSvelteFiles(): Array<{ rel: string; text: string }> {
	const out: Array<{ rel: string; text: string }> = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, entry.name);
			if (entry.isDirectory()) walk(p);
			else if (entry.name.endsWith('.svelte')) out.push({ rel: relative(REPO_ROOT, p), text: readText(p) });
		}
	};
	walk(resolve(REPO_ROOT, 'src'));
	return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** sprite(`<symbol id="i-…">` を持つ)ファイル。 */
function spriteFiles(): Array<{ rel: string; text: string }> {
	return allSvelteFiles().filter((f) => /<symbol\s+id="i-/.test(f.text));
}

/** sprite の `<svg …>` の開始タグ(symbol を含む svg)。 */
function spriteSvgTag(text: string): string | null {
	const at = text.search(/<symbol\s+id="i-/);
	if (at < 0) return null;
	const before = text.slice(0, at);
	const open = before.lastIndexOf('<svg');
	if (open < 0) return null;
	const close = text.indexOf('>', open);
	return text.slice(open, close + 1);
}

/** `<use href="#i-…">` と `<Icon name="…">` で参照される名前(静的に書かれたものだけ)。 */
function referencedIconNames(): Array<{ rel: string; name: string }> {
	const out: Array<{ rel: string; name: string }> = [];
	for (const { rel, text } of allSvelteFiles()) {
		for (const m of text.matchAll(/<use\b[^>]*href=\{?["'`]?#i-([\w-]+)["'`]?\}?/g)) out.push({ rel, name: m[1] });
		for (const m of text.matchAll(/<Icon\b[^>]*\bname=["']([\w-]+)["']/g)) out.push({ rel, name: m[1] });
	}
	return out;
}

// ---------------------------------------------------------------------------
// AC-56-10 — Unicode 記号アイコンの撤去
// ---------------------------------------------------------------------------

describe('AC-56-10 Unicode 記号アイコンの撤去(契約 5・第2段): markup に × ✕ − ⌄ › ▶ ■ が残っていない', () => {
	test('記号の集合は値固定(7 個)。… と ⌘ はアイコンではないので対象外', () => {
		expect([...ICON_SYMBOLS]).toEqual(['×', '✕', '−', '⌄', '›', '▶', '■']);
		for (const s of NOT_ICON_SYMBOLS) expect(ICON_SYMBOLS as readonly string[]).not.toContain(s);
		// 似た文字と取り違えない: − は U+2212(ハイフンマイナス U+002D ではない)
		expect('−'.codePointAt(0)).toBe(0x2212);
		expect('×'.codePointAt(0)).toBe(0x00d7);
		expect('✕'.codePointAt(0)).toBe(0x2715);
	});

	test('数字に隣接する − と × は文言として対象外(−1・−{LARGE_FRAME_STEP}・1×・(×2))、単独の − と × は対象', () => {
		expect(iconSymbolColumns('<button>−1</button>')).toEqual([]);
		expect(iconSymbolColumns('−{LARGE_FRAME_STEP}')).toEqual([]);
		expect(iconSymbolColumns('1×')).toEqual([]);
		expect(iconSymbolColumns('title="Zoom In Waveform (×2)"')).toEqual([]);
		expect(iconSymbolColumns('<button>−</button>')).toEqual([9]);
		expect(iconSymbolColumns('>×<')).toEqual([2]);
		// 他の記号は数字が隣でも対象(例外は − と × だけ)
		expect(iconSymbolColumns('1✕2')).toEqual([2]);
		expect(iconSymbolColumns("{expanded ? '⌄' : '›'}")).toEqual([14, 20]);
	});

	test('<script> / <style> / <!-- --> の外(markup)に 7 つの記号が 1 つも無い(属性値と式を含む。数字に隣接する − × は除く)', () => {
		const offenders: string[] = [];
		for (const name of componentFiles()) {
			const lines = markupOf(componentSource(name)).split('\n');
			lines.forEach((line, i) => {
				const columns = iconSymbolColumns(line);
				if (columns.length > 0) offenders.push(`${name}:${i + 1}:${columns.join(',')}: ${line.trim()}`);
			});
		}
		expect(offenders, 'markup に残る Unicode 記号アイコン(SVG= Icon.svelte に置き換える)').toEqual([]);
	});

	test('markup の切り出しの前提: <style> と <script> と HTML コメントの中は見ない・行番号は保つ', () => {
		const sample = '<script>\nconst a = "×";\n</script>\n\n<!-- ✕ -->\n<div>{x ? "−" : "+"}</div>\n<style>\n.a::before { content: "▶"; }\n</style>\n';
		const markup = markupOf(sample);
		expect(markup.split('\n').length).toBe(sample.split('\n').length);
		expect(markup).not.toContain('×');
		expect(markup).not.toContain('✕');
		expect(markup).not.toContain('▶');
		expect(markup.split('\n')[5]).toContain('−');
	});
});

// ---------------------------------------------------------------------------
// 契約 5・判断 (i)— Icon.svelte と sprite
// ---------------------------------------------------------------------------

describe('契約 5・判断 (i) Icon.svelte: 名前で <svg><use href="#i-…"/></svg> を描く', () => {
	test('src/components/Icon.svelte がある', () => {
		expect(existsSync(ICON_SVELTE), 'Icon.svelte が無い').toBe(true);
	});

	test('name を $props() で受け、<use href="#i-…"> で sprite の symbol を参照する', () => {
		const src = readText(ICON_SVELTE);
		const propsAt = src.indexOf('$props()');
		expect(propsAt, '$props() を使うこと').toBeGreaterThanOrEqual(0);
		const destructure = src.slice(Math.max(0, src.lastIndexOf('let', propsAt)), propsAt);
		expect(destructure, 'name を受けること').toMatch(/\bname\b/);
		expect(src).toMatch(/<use\b[^>]*href=\{?["'`]?#i-/);
	});

	test('svg は viewBox="0 0 24 24"・aria-hidden="true"・線は currentColor・fill none・stroke-width 1.7(契約 5)', () => {
		const src = readText(ICON_SVELTE);
		const tag = src.match(/<svg\b[^>]*>/)?.[0] ?? '';
		expect(tag, '<svg> があること').not.toBe('');
		expect(tag).toMatch(/viewBox="0 0 24 24"/);
		expect(tag).toMatch(/aria-hidden="true"/);
		const styled = tag + styleBlocksOf(src).join('\n');
		expect(styled, 'stroke は currentColor').toMatch(/stroke\s*[:=]\s*["']?currentColor/i);
		expect(styled, 'fill は none').toMatch(/fill\s*[:=]\s*["']?none/);
		expect(styled, 'stroke-width 1.7').toMatch(/stroke-width\s*[:=]\s*["']?1\.7\b/);
	});
});

describe('契約 5・判断 (i) sprite: <symbol id="i-…"> は 1 つのファイルに 1 回だけ・モックの字形・viewBox 0 0 24 24', () => {
	test('<symbol id="i-…"> を持つ .svelte はちょうど 1 つ(+page.svelte か 1 つの sprite コンポーネント)', () => {
		const files = spriteFiles().map((f) => f.rel);
		expect(files, 'sprite を持つファイル').toHaveLength(1);
	});

	test('symbol の id は重複せず、すべてモック docs/review/ui-mock.html の <symbol id="i-…"> にある(正本=契約 1)', () => {
		const [sprite] = spriteFiles();
		expect(sprite, 'sprite があること').toBeDefined();
		const symbols = symbolsIn(sprite.text);
		expect(symbols.length).toBeGreaterThan(0);
		const ids = symbols.map((s) => s.id);
		expect(new Set(ids).size, '重複した id').toBe(ids.length);
		const mock = mockSymbols();
		expect(mock.size, 'モックの symbol を読めること').toBeGreaterThanOrEqual(90);
		expect(ids.filter((id) => !mock.has(id)), 'モックに無い id').toEqual([]);
	});

	test('symbol はすべて viewBox="0 0 24 24" で、中身(字形)はモックと同じ', () => {
		const [sprite] = spriteFiles();
		expect(sprite).toBeDefined();
		const mock = mockSymbols();
		const wrong: string[] = [];
		for (const s of symbolsIn(sprite.text)) {
			if (!/viewBox="0 0 24 24"/.test(s.attrs)) wrong.push(`${s.id}: viewBox が 0 0 24 24 でない(${s.attrs.trim()})`);
			const m = mock.get(s.id);
			if (m && m.inner !== s.inner) wrong.push(`${s.id}: 字形がモックと違う\n  得た: ${s.inner}\n  正本: ${m.inner}`);
		}
		expect(wrong).toEqual([]);
	});

	test('sprite の <svg> は aria-hidden="true" で、画面に場所を取らない(hidden / width="0" height="0" / display:none / position:absolute+width 0)', () => {
		const [sprite] = spriteFiles();
		expect(sprite).toBeDefined();
		const tag = spriteSvgTag(sprite.text);
		expect(tag, 'symbol を包む <svg> があること').not.toBeNull();
		expect(tag!).toMatch(/aria-hidden="true"/);
		const classes = tag!.match(/class="([^"]*)"/)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
		const classRules = parseRules(stripCssComments(styleBlocksOf(sprite.text).join('\n') + '\n' + readText(APP_CSS))).filter((r) =>
			classes.some((c) => r.selector.split(',').some((s) => s.trim() === `.${c}` || s.trim() === `svg.${c}`)),
		);
		const classCss = classRules.map((r) => r.body).join(';').replace(/\s+/g, '');
		const inline = (tag!.match(/style="([^"]*)"/)?.[1] ?? '').replace(/\s+/g, '');
		const hidden =
			/\bhidden\b/.test(tag!) ||
			/width="0"/.test(tag!) ||
			/display:none/.test(inline + classCss) ||
			(/width:0/.test(inline + classCss) && /height:0/.test(inline + classCss));
		expect(hidden, `sprite が場所を取らない指定: ${tag}`).toBe(true);
	});

	test('<use href="#i-…"> と <Icon name="…"> で参照される名前はすべて sprite に定義されている', () => {
		const [sprite] = spriteFiles();
		expect(sprite).toBeDefined();
		const defined = new Set(symbolsIn(sprite.text).map((s) => s.id));
		const refs = referencedIconNames();
		expect(refs.length, 'アイコンの参照があること').toBeGreaterThan(0);
		const dangling = refs.filter((r) => !defined.has(`i-${r.name}`)).map((r) => `${r.rel}: i-${r.name}`);
		expect(dangling, '定義の無い参照').toEqual([]);
	});

	test('Unicode 記号を置き換えた 7 ファイルは Icon.svelte を使う(import Icon … か <Icon)', () => {
		const missing = FILES_WITH_UNICODE_ICONS.filter((name) => {
			const src = componentSource(name);
			return !(/import\s+Icon\s+from\s+['"][^'"]*Icon\.svelte['"]/.test(src) && /<Icon\b/.test(src));
		});
		expect(missing, 'Icon を使っていないファイル').toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 契約 4 — フォーカスリング
// ---------------------------------------------------------------------------

describe('契約 4 フォーカス: キーボードフォーカスが必ず見える= :focus-visible に --color-focus-ring の 2px のリング', () => {
	test('app.css の全体規則か、掴める要素を持つ各コンポーネントの <style> に、:focus-visible のリングがある', () => {
		if (globalFocusRing()) return;
		const missing = componentFiles().filter((name) => {
			const src = componentSource(name);
			if (!hasFocusableMarkup(markupOf(src))) return false;
			return !hasFocusVisibleRing(componentRules(name));
		});
		expect(missing, 'app.css に全体の :focus-visible リングが無く、コンポーネント側にも無いファイル').toEqual([]);
	});

	test(':focus 系で outline を消す規則(outline: none / 0)を持つファイルは、同じファイルの :focus-visible でリングを戻す', () => {
		const offenders: string[] = [];
		for (const name of componentFiles()) {
			const rules = componentRules(name);
			const removes = rules.filter(
				(r) => hasFocusPseudo(r.selector) && declarationsOf(r.body).some((d) => d.prop === 'outline' && /^(none|0)$/.test(d.value)),
			);
			if (removes.length === 0) continue;
			if (hasFocusVisibleRing(rules)) continue;
			// outline を消した規則自身が box-shadow 等でリングを描くなら可
			const selfRing = removes.every((r) => declaresFocusRing(declarationsOf(r.body)));
			if (!selfRing) offenders.push(`${name}: ${removes.map((r) => r.selector).join(' / ')}`);
		}
		expect(offenders, 'フォーカスを消したまま戻さないファイル').toEqual([]);
	});

	test('フォーカスリングの色は --color-focus-ring 以外にしない(:focus-visible の outline / box-shadow に別のトークンや直書きが無い)', () => {
		const offenders: string[] = [];
		const check = (where: string, rules: Rule[]) => {
			for (const r of rules.filter((r) => hasFocusVisible(r.selector))) {
				for (const d of declarationsOf(r.body)) {
					if (!/^(outline|outline-color|box-shadow)$/.test(d.prop)) continue;
					if (/^(none|0)$/.test(d.value)) continue;
					if (!/var\(\s*--color-focus-ring\b/.test(d.value)) offenders.push(`${where}: ${r.selector} { ${d.prop}: ${d.value} }`);
				}
			}
		};
		check('app.css', appCssRules());
		for (const name of componentFiles()) check(name, componentRules(name));
		expect(offenders, '--color-focus-ring 以外のリング').toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 契約 4 — オーバーレイの重なり
// ---------------------------------------------------------------------------

describe('契約 4 オーバーレイ: ContextMenu / UpdateBanner / InstructionDialog / DiffView / FindBar / GoToBar は --color-bg-raised + --shadow-2 + --radius-md の 1 段', () => {
	for (const name of OVERLAY_COMPONENTS) {
		test(`${name}: <style> が ${OVERLAY_TOKENS.join(' / ')} を参照する`, () => {
			const css = styleBlocksOf(componentSource(name)).map(stripCssComments).join('\n');
			const missing = OVERLAY_TOKENS.filter((t) => !new RegExp(`var\\(\\s*${t}\\b`).test(css));
			expect(missing, `${name} が参照していないトークン`).toEqual([]);
		});
	}

	for (const name of BACKDROP_COMPONENTS) {
		test(`${name}: 暗くする層(backdrop)の背景は var(--color-shadow)`, () => {
			const decls = componentRules(name).flatMap((r) => declarationsOf(r.body));
			const backdrop = decls.filter((d) => /^background(-color)?$/.test(d.prop) && /var\(\s*--color-shadow\b/.test(d.value));
			expect(backdrop.length, `${name} に background: var(--color-shadow) の宣言があること`).toBeGreaterThan(0);
		});
	}

	test('コンポーネントの box-shadow は none か --shadow-1 / --shadow-2 の参照(色の直書きは AC-56-3・他のトークンで影を作らない)', () => {
		const offenders: string[] = [];
		for (const name of componentFiles()) {
			for (const r of componentRules(name)) {
				for (const d of declarationsOf(r.body)) {
					if (d.prop !== 'box-shadow') continue;
					const v = d.value.replace(/\s+/g, ' ');
					if (/^none$/.test(v)) continue;
					if (/^var\(\s*--shadow-[12]\s*\)$/.test(v)) continue;
					// inset の印(編集中の帯など)は色だけトークンなら可
					if (/^inset\b/.test(v) && /var\(\s*--color-[\w-]+\s*\)/.test(v) && !/#|rgba?\(|hsla?\(/.test(v)) continue;
					offenders.push(`${name}: ${r.selector} { box-shadow: ${d.value} }`);
				}
			}
		}
		expect(offenders, '--shadow-* 以外の影').toEqual([]);
	});
});
