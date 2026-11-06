/**
 * 要件#56 の受け入れテスト(docs/requirements/req-56.md)— デザイントークン(AC-56-1〜7・18)
 *
 * 「UI の作り直し(見た目の刷新)」の第1段=トークン整備+テーマの構造+骨格(契約 2・3・4)のうち、
 * `themes/default.json`(正本)・`src/styles/theme.css`(生成物)・`app.css` / `markdown.css`・
 * `renderer.ts` / `code-highlight.ts`・`scripts/build-theme-css.mjs` を読んで機械判定できる部分。
 * テーマの構造の正本は docs/theme-architecture.md(§3 名前と値・§4 JSON の形式・§7 (a)〜(s))。
 *
 * 判定するもの:
 * - AC-56-1  トークンの集合= 生成物 `theme.css` の `:root` に 65 名がすべて定義されている。同じ 65 名が
 *   `themes/default.json` の鍵(`--` を省いた形・common ∪ light ∪ dark)の集合と一致する。契約 2 の本文に
 *   値まで書かれているもの(余白・角丸・行長・見出し行 3 個)は値も固定
 * - AC-56-2  既存トークンの温存= 要件#7 の 13 色+要件#64 追補b の 3 個の名前が残り、新名と違う 7 個は
 *   `var()` の別名(契約 2・theme-architecture (r))
 * - AC-56-3  ハードコード色ゼロ(第1段の範囲)= `app.css` と `markdown.css` の宣言値に色リテラルが無い。
 *   コンポーネントの `<style>` は第2段で `STAGE1_HARDCODE_FREE_FILES` に足す
 * - AC-56-4  `--md-color-*` 16 個が `var(--…)` 参照(名前は変えない)。導出先が決まっているもの(契約 2 の
 *   例・判断 (l))はそのとおり
 * - AC-56-5  ダークの組= `@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]) }` と
 *   `:root[data-theme="dark"]` の 2 ブロックが同じ名前の集合をトークンの再定義だけで差し替える・
 *   アクセント=藍の固定(CSS と JSON の両方)・`prefers-reduced-motion: reduce` で遷移時間 0
 * - AC-56-6  Shiki の対= `themes/default.json` の `code`・`renderer.ts` と `code-highlight.ts` が
 *   テーマ名を引数で受ける(省略時=Default のライト。既存 code-highlight.acceptance の実測値を守る)
 * - AC-56-7  本文の行長= 判断 (f) のブロックに `max-width: var(--doc-measure)`・表/`pre`/画像だけの
 *   段落/Mermaid は対象外・`<html data-doc-measure="full">`(判断 (g))で `none`・`.markdown-body` の
 *   padding 維持
 * - AC-56-18 生成物と正本の一致= `scripts/build-theme-css.mjs` の生成関数に `themes/default.json` を
 *   通した文字列が `theme.css` と一致・ヘッダ・別名 7 個・reduced-motion の規則・鍵をそのまま
 *   `--` 付きの変数名にする(名前の表を持たない)
 *
 * 判定しないもの(人間ゲート 1〜4・8): 配色の良し悪し・モックとの一致・中央寄せか左揃えか
 * (判断 (f) で実装裁量)・テーマが変わったときの描き直しの手応え。
 *
 * ## 確定契約(implementer はこれに従う。名前は theme-architecture §10 から取り、無いものは本ファイルが決める)
 *
 * ```js
 * // scripts/build-theme-css.mjs(Node 標準の fs と JSON.parse だけ・依存追加なし・`pnpm theme:css` で実行)
 * /** 正本の JSON(parse 済み)から theme.css の全文を作る。鍵は `--` を付けてそのまま変数名にする。 *\/
 * export function buildThemeCss(theme) { … }
 * // `node scripts/build-theme-css.mjs` として実行されたときだけ themes/default.json → src/styles/theme.css を書く
 * ```
 *
 * ```css
 * /* src/styles/theme.css(生成物・手で直さない)— 先頭のコメントに themes/default.json と pnpm theme:css を書く *\/
 * :root { --color-bg-base: …; …(65 名=ライトの値)… ; --color-bg-primary: var(--color-bg-surface); …(別名 7 個)… }
 * :root[data-theme="dark"] { …(ダークの値。すべて `--` の再定義)… }
 * @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { …(同じ組)… } }
 * @media (prefers-reduced-motion: reduce) { :root { --duration-fast: 0ms; --duration-base: 0ms; --duration-slow: 0ms; } }
 * ```
 *
 * ```ts
 * // src/markdown/renderer.ts(変更はテーマ名の選択だけ=契約 6)
 * export async function render(source: string, baseUri: string, options?: { codeTheme?: string }): Promise<RenderResult>;
 * // options.codeTheme = Shiki の同梱テーマ名。省略= 'github-light'(Default のライト)
 *
 * // src/lib/code-highlight.ts
 * export async function highlightCode(content: string, lang: string, theme?: string): Promise<string | null>;
 * // theme 省略= 'github-light'
 * ```
 *
 * ```css
 * /* src/styles/markdown.css(判断 (f)(g)) *\/
 * .markdown-body > p, .markdown-body > h1, …h6, > ul, > ol, > blockquote, > dl, > hr { max-width: var(--doc-measure); }
 * .markdown-body > p:has(> img:only-child) { max-width: none; }
 * :root[data-doc-measure="full"] .markdown-body > p, … { max-width: none; }
 * ```
 *
 * 判定方式: ソース検査型(CSS を自前の小さな字句解析で規則に分け、宣言は要件#7 のテストと同じ正規表現で
 * 取る)。Shiki は実際に `render` / `highlightCode` を呼ぶ(code-highlight.acceptance と同じ)。生成スクリプトは
 * 動的 import(無ければ赤)。
 *
 * 実装前の見立て(赤の理由): themes/default.json と build-theme-css.mjs が無い(AC-1・5・6・18)・theme.css に
 * 新トークンが無い(AC-1・2・5)・app.css / markdown.css に色リテラルがある(AC-3・4)・renderer.ts と
 * code-highlight.ts がテーマ名を受けない(AC-6)・行長の規則が無い(AC-7)。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { render } from '../markdown/renderer';
import { highlightCode } from '../lib/code-highlight';

const REPO_ROOT = resolve(__dirname, '../..');
const THEME_CSS = resolve(REPO_ROOT, 'src/styles/theme.css');
const APP_CSS = resolve(REPO_ROOT, 'src/styles/app.css');
const MARKDOWN_CSS = resolve(REPO_ROOT, 'src/styles/markdown.css');
const DEFAULT_THEME_JSON = resolve(REPO_ROOT, 'themes/default.json');
const BUILD_SCRIPT = resolve(REPO_ROOT, 'scripts/build-theme-css.mjs');

// ---------------------------------------------------------------------------
// 契約 2 の名前の集合(docs/theme-architecture.md §3.1 の表から転記。65 名)
// ---------------------------------------------------------------------------

const COLOR_TOKENS = [
	'--color-bg-base',
	'--color-bg-surface',
	'--color-bg-raised',
	'--color-bg-hover',
	'--color-bg-active',
	'--color-text-primary',
	'--color-text-secondary',
	'--color-text-muted',
	'--color-border',
	'--color-border-strong',
	'--color-accent',
	'--color-accent-text',
	'--color-on-accent',
	'--color-accent-soft',
	'--color-selection',
	'--color-focus-ring',
	'--color-danger',
	'--color-success',
	'--color-warning',
	'--color-danger-soft',
	'--color-success-soft',
	'--color-warning-soft',
	'--color-shadow',
] as const;
/** 起案時判断 (l)= important アラートの導出先として 1 つ足す(紫。ライト #8250df / ダーク #d2a8ff)。 */
const EMPHASIS_TOKEN = '--color-emphasis';
const SPACE_TOKENS = ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6'] as const;
const RADIUS_TOKENS = ['--radius-sm', '--radius-md'] as const;
/** タイポ 15(列挙 12+要件#64 追補b の既存 3。契約 2 の「13」は誤記=theme-architecture §3.1 で 15 に訂正)。 */
const TYPO_TOKENS = [
	'--font-ui',
	'--font-doc',
	'--font-mono',
	'--text-xs',
	'--text-sm',
	'--text-md',
	'--text-lg',
	'--text-xl',
	'--doc-size',
	'--doc-leading',
	'--doc-measure',
	'--leading-ui',
	'--pane-header-font-size',
	'--pane-header-font-weight',
	'--pane-header-letter-spacing',
] as const;
const SHADOW_TOKENS = ['--shadow-1', '--shadow-2'] as const;
const DURATION_TOKENS = ['--duration-fast', '--duration-base', '--duration-slow', '--ease-out'] as const;
const FILETYPE_TOKENS = [
	'--ft-md',
	'--ft-html',
	'--ft-pdf',
	'--ft-img',
	'--ft-video',
	'--ft-audio',
	'--ft-3d',
	'--ft-code',
	'--ft-folder',
] as const;
const FIND_TOKENS = ['--color-find-match', '--color-find-current', '--color-find-current-text'] as const;

const TOKEN_NAMES: readonly string[] = [
	...COLOR_TOKENS,
	EMPHASIS_TOKEN,
	...SPACE_TOKENS,
	...RADIUS_TOKENS,
	...TYPO_TOKENS,
	...SHADOW_TOKENS,
	...DURATION_TOKENS,
	...FILETYPE_TOKENS,
	...FIND_TOKENS,
];

/** 契約 2 の本文に値まで書かれているトークン(空白と先頭 0 の違いは吸収する)。 */
const FIXED_VALUES: Record<string, string> = {
	'--space-1': '4px',
	'--space-2': '8px',
	'--space-3': '12px',
	'--space-4': '16px',
	'--space-5': '24px',
	'--space-6': '32px',
	'--radius-sm': '5px',
	'--radius-md': '9px',
	'--doc-measure': '72ch',
	'--pane-header-font-size': '11px',
	'--pane-header-font-weight': '600',
	'--pane-header-letter-spacing': '0.06em',
};

/** 要件#7 の色 13 個(名前は削除も改名もしない)。 */
const LEGACY_COLOR_TOKENS = [
	'--color-bg-primary',
	'--color-bg-secondary',
	'--color-bg-hover',
	'--color-bg-tree-hover',
	'--color-bg-tree-active',
	'--color-text-primary',
	'--color-text-hover',
	'--color-text-secondary',
	'--color-text-muted',
	'--color-text-placeholder',
	'--color-text-danger',
	'--color-border',
	'--color-shadow',
] as const;
/** 要件#64 追補b の見出し行 3 個。 */
const LEGACY_PANE_HEADER_TOKENS = [
	'--pane-header-font-size',
	'--pane-header-font-weight',
	'--pane-header-letter-spacing',
] as const;

/**
 * 契約 2「既存のトークン 16 個」の対応=新しい集合と同名でない 7 個 → 別名先。
 * 同名の 6 個(--color-bg-hover 等)はそのまま新トークンになるので、ここには載らない。
 * 別名はテーマの鍵にしない(theme-architecture (r))= themes/default.json の鍵に現れてはいけない。
 */
const LEGACY_ALIASES: Record<string, string> = {
	'--color-bg-primary': '--color-bg-surface',
	'--color-bg-secondary': '--color-bg-base',
	'--color-bg-tree-hover': '--color-bg-hover',
	'--color-bg-tree-active': '--color-accent-soft',
	'--color-text-hover': '--color-text-primary',
	'--color-text-placeholder': '--color-text-muted',
	'--color-text-danger': '--color-danger',
};

/** アクセント=藍(2026-11-02 由谷決定・モックのまま)。 */
const ACCENT_LIGHT = '#4256e8';
const ACCENT_DARK = '#5566ee';

/** Default の Shiki の対(判断 (m))。 */
const DEFAULT_CODE = { light: 'github-light', dark: 'github-dark' };

/**
 * AC-56-3 の第1段の範囲。第2段で `src/components/*.svelte` の `<style>` を足す(要件 AC-56-3 の
 * 「コンポーネントは第2段」)。`theme.css` はトークン定義行が例外なので対象にしない。
 * `print.css` は契約 6 で不変(対象外)。
 */
const STAGE1_HARDCODE_FREE_FILES = [
	{ name: 'app.css', path: APP_CSS },
	{ name: 'markdown.css', path: MARKDOWN_CSS },
] as const;

/** `markdown.css` の `--md-color-*` 16 個(名前は変えない=343 行の参照を守る)。 */
const MD_COLOR_TOKENS = [
	'--md-color-text',
	'--md-color-text-secondary',
	'--md-color-bg',
	'--md-color-border',
	'--md-color-border-heavy',
	'--md-color-link',
	'--md-color-code-bg',
	'--md-color-blockquote-border',
	'--md-color-blockquote-text',
	'--md-color-table-row-alt',
	'--md-color-task-checked',
	'--md-color-alert-note',
	'--md-color-alert-tip',
	'--md-color-alert-important',
	'--md-color-alert-warning',
	'--md-color-alert-caution',
] as const;

/** 契約 2 の例(text)と起案時判断 (l) で導出先が決まっているもの。 */
const MD_COLOR_DERIVATIONS: Record<string, string> = {
	'--md-color-text': '--color-text-primary',
	'--md-color-link': '--color-accent-text',
	'--md-color-task-checked': '--color-accent',
	'--md-color-alert-note': '--color-accent-text',
	'--md-color-alert-tip': '--color-success',
	'--md-color-alert-warning': '--color-warning',
	'--md-color-alert-caution': '--color-danger',
	'--md-color-alert-important': EMPHASIS_TOKEN,
};

/** 判断 (f): 行長の上限を当てる「地の文のブロック」(`.markdown-body` の直下)。 */
const MEASURED_CHILDREN = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'blockquote', 'dl', 'hr'] as const;
/** 判断 (f): 幅いっぱいのまま(上限の対象外)。 */
const UNMEASURED_SELECTOR_HINTS = ['table', 'pre', '.vellis-mermaid'] as const;

// ---------------------------------------------------------------------------
// helpers — CSS の字句解析(要件#7 のテストと同じ宣言の取り方+規則の入れ子を追う)
// ---------------------------------------------------------------------------

function readText(path: string): string {
	return readFileSync(path, 'utf8');
}

function stripCssComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

type Decl = { prop: string; value: string };

/** CSS テキストから宣言(prop: value)だけを取り出す(要件#7 の theme.acceptance と同じ式)。 */
function declarationsOf(css: string): Decl[] {
	const out: Decl[] = [];
	const re = /([-\w]+)\s*:\s*([^{};]+)(?=[;}])/g;
	for (let m = re.exec(css); m !== null; m = re.exec(css)) {
		out.push({ prop: m[1], value: m[2].trim() });
	}
	return out;
}

/** 規則 1 つ= セレクタ・本文(宣言だけ)・外側の at-rule の列(内側が末尾)。 */
type Rule = { selector: string; body: string; at: string[] };

/**
 * CSS を規則に分ける。`@media … {` は at-rule として積み、その中の規則は `at` に持つ。
 * 規則の本文に `{` が現れる入れ子(CSS Nesting)は使っていない前提で、対応する `}` まで本文とする。
 */
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

function themeCssText(): string {
	return readText(THEME_CSS);
}

function themeRules(): Rule[] {
	return parseRules(stripCssComments(themeCssText()));
}

function isDarkMedia(at: string): boolean {
	return /^@media\b/.test(at) && /prefers-color-scheme\s*:\s*dark/.test(at);
}

function isReducedMotionMedia(at: string): boolean {
	return /^@media\b/.test(at) && /prefers-reduced-motion\s*:\s*reduce/.test(at);
}

/** `:not(…)` を除いたセレクタ。`[data-theme="dark"]` を「肯定で」狙っているかを見るため。 */
function withoutNot(selector: string): string {
	return selector.replace(/:not\([^)]*\)/g, '');
}

function targetsDataTheme(selector: string, value: 'light' | 'dark'): boolean {
	return new RegExp(`\\[data-theme\\s*=\\s*["']?${value}["']?\\s*\\]`).test(withoutNot(selector));
}

function excludesDataTheme(selector: string, value: 'light' | 'dark'): boolean {
	return new RegExp(`:not\\(\\s*\\[data-theme\\s*=\\s*["']?${value}["']?\\s*\\]\\s*\\)`).test(selector);
}

/** 規則群の custom property 宣言(`--` で始まるもの)。 */
function customProps(rules: Rule[]): Decl[] {
	return rules.flatMap((r) => declarationsOf(r.body)).filter((d) => d.prop.startsWith('--'));
}

/** `:root` 系セレクタの、at-rule の外にある規則= ライト(既定)の定義。 */
function rootLightRules(): Rule[] {
	return themeRules().filter(
		(r) =>
			r.at.length === 0 &&
			/:root|^html\b/.test(r.selector) &&
			!targetsDataTheme(r.selector, 'dark') &&
			!targetsDataTheme(r.selector, 'light'),
	);
}

/** `@media (prefers-color-scheme: dark)` の中の規則。 */
function darkMediaRules(): Rule[] {
	return themeRules().filter((r) => r.at.some(isDarkMedia));
}

/** at-rule の外で `[data-theme="dark"]` を肯定で狙う規則(手動ダーク)。 */
function darkAttrRules(): Rule[] {
	return themeRules().filter((r) => r.at.length === 0 && targetsDataTheme(r.selector, 'dark'));
}

function lastValue(decls: Decl[], prop: string): string | undefined {
	const hits = decls.filter((d) => d.prop === prop);
	return hits.length > 0 ? hits[hits.length - 1].value : undefined;
}

function uniqueNames(decls: Decl[]): string[] {
	return [...new Set(decls.map((d) => d.prop))].sort();
}

/** 値の比較用に空白と先頭 0(`.06em` と `0.06em`)の違いを吸収する。 */
function normalizeValue(v: string): string {
	return v
		.toLowerCase()
		.replace(/\s+/g, '')
		.replace(/(^|[^\d.])\.(\d)/g, '$10.$2');
}

/** `var(--x)` / `var(--x, fallback)` の参照先(先頭の 1 つ)。参照でなければ null。 */
function varTarget(value: string): string | null {
	const m = value.match(/^var\(\s*(--[-\w]+)/);
	return m ? m[1] : null;
}

/** 色リテラルの検査(要件#7 の theme.acceptance と同じ 3 種)。 */
const NAMED_COLORS = new Set([
	'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black',
	'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse',
	'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue',
	'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki',
	'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon',
	'darkseagreen', 'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise',
	'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick',
	'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod',
	'gray', 'green', 'greenyellow', 'grey', 'honeydew', 'hotpink', 'indianred', 'indigo',
	'ivory', 'khaki', 'lavender', 'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue',
	'lightcoral', 'lightcyan', 'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey',
	'lightpink', 'lightsalmon', 'lightseagreen', 'lightskyblue', 'lightslategray',
	'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime', 'limegreen', 'linen',
	'magenta', 'maroon', 'mediumaquamarine', 'mediumblue', 'mediumorchid', 'mediumpurple',
	'mediumseagreen', 'mediumslateblue', 'mediumspringgreen', 'mediumturquoise',
	'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose', 'moccasin', 'navajowhite',
	'navy', 'oldlace', 'olive', 'olivedrab', 'orange', 'orangered', 'orchid',
	'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip',
	'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple', 'red',
	'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell',
	'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow',
	'springgreen', 'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet',
	'wheat', 'white', 'whitesmoke', 'yellow', 'yellowgreen',
]);
const COLOR_FUNCTION_RE = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\s*\(/i;
const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;

function valueTokens(value: string): string[] {
	return value.split(/[\s,()/'"]+/).filter((t) => t.length > 0);
}

function isColorLiteral(value: string): boolean {
	return (
		HEX_RE.test(value) ||
		COLOR_FUNCTION_RE.test(value) ||
		valueTokens(value).some((t) => NAMED_COLORS.has(t.toLowerCase()))
	);
}

/**
 * セレクタ列を 1 つずつに分け、`.markdown-body > :is(p, h1)` / `:where(...)` は
 * `.markdown-body > p` / `.markdown-body > h1` に展開する(implementer の書き方の自由度を残す)。
 */
function expandSelectors(selectorList: string): string[] {
	const out: string[] = [];
	for (const raw of splitTopLevel(selectorList, ',')) {
		const s = raw.replace(/\s*>\s*/g, ' > ').replace(/\s+/g, ' ').trim();
		const m = s.match(/^(.*?):(?:is|where)\((.*)\)(.*)$/);
		if (m) {
			for (const inner of splitTopLevel(m[2], ',')) {
				out.push(`${m[1]}${inner.trim()}${m[3]}`.replace(/\s+/g, ' ').trim());
			}
		} else {
			out.push(s);
		}
	}
	return out;
}

/** 括弧の外にある `sep` でだけ分ける。 */
function splitTopLevel(s: string, sep: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let cur = '';
	for (const c of s) {
		if (c === '(' || c === '[') depth += 1;
		else if (c === ')' || c === ']') depth -= 1;
		if (c === sep && depth === 0) {
			parts.push(cur);
			cur = '';
		} else {
			cur += c;
		}
	}
	parts.push(cur);
	return parts.filter((p) => p.trim().length > 0);
}

function markdownRules(): Rule[] {
	return parseRules(stripCssComments(readText(MARKDOWN_CSS))).filter(
		(r) => !r.at.some((a) => /^@media[^{]*\bprint\b/.test(a)),
	);
}

/** `max-width` を持つ規則を、展開したセレクタごとに `{ selector, value }` へ平らにする。 */
function maxWidthBySelector(): Array<{ selector: string; value: string; at: string[] }> {
	const out: Array<{ selector: string; value: string; at: string[] }> = [];
	for (const r of markdownRules()) {
		const mw = lastValue(declarationsOf(r.body), 'max-width');
		if (mw === undefined) continue;
		for (const sel of expandSelectors(r.selector)) out.push({ selector: sel, value: mw, at: r.at });
	}
	return out;
}

/** `.markdown-body > X`(X= 要素名)を狙うセレクタか。`:root[data-doc-measure]` 等の前置きは許す。 */
function targetsMeasuredChild(selector: string, child: string): boolean {
	return new RegExp(`\\.markdown-body\\s*>\\s*${child}(?![-\\w])(?!:has)`).test(selector);
}

function hasFullWidthPrefix(selector: string): boolean {
	return /\[data-doc-measure\s*=\s*["']?full["']?\s*\]/.test(selector);
}

// ---------------------------------------------------------------------------
// helpers — 正本 themes/default.json(docs/theme-architecture.md §4)
// ---------------------------------------------------------------------------

type ThemeJson = {
	version?: unknown;
	meta?: unknown;
	code?: { light?: unknown; dark?: unknown };
	common?: Record<string, unknown>;
	light?: Record<string, unknown>;
	dark?: Record<string, unknown>;
};

function defaultThemeJson(): ThemeJson {
	return JSON.parse(readText(DEFAULT_THEME_JSON)) as ThemeJson;
}

/** JSON の鍵(`--` を省いた形)を CSS 変数名に直す。 */
function cssName(key: string): string {
	return `--${key}`;
}

function jsonKeys(theme: ThemeJson): string[] {
	return [
		...new Set([
			...Object.keys(theme.common ?? {}),
			...Object.keys(theme.light ?? {}),
			...Object.keys(theme.dark ?? {}),
		]),
	]
		.map(cssName)
		.sort();
}

/** 生成関数を動的 import(ファイルが無ければここで落ちる=未実装の赤)。 */
async function loadBuildThemeCss(): Promise<(theme: unknown) => string> {
	const mod = (await import(/* @vite-ignore */ pathToFileURL(BUILD_SCRIPT).href)) as {
		buildThemeCss?: unknown;
	};
	expect(typeof mod.buildThemeCss, 'scripts/build-theme-css.mjs は buildThemeCss を export すること').toBe(
		'function',
	);
	return mod.buildThemeCss as (theme: unknown) => string;
}

// ---------------------------------------------------------------------------
// AC-56-1 — トークンの集合
// ---------------------------------------------------------------------------

describe('AC-56-1 トークンの集合(契約 2): 生成物 theme.css の :root と正本 themes/default.json の鍵が同じ 65 名', () => {
	test('名前の集合は 65(色 23+emphasis 1・余白 6・角丸 2・タイポ 15・影 2・遷移 4・ファイル種別 9・検索 3)', () => {
		expect(TOKEN_NAMES.length).toBe(65);
		expect(new Set(TOKEN_NAMES).size).toBe(65);
	});

	test('65 名が theme.css の :root(at-rule の外・属性なし)に定義されている', () => {
		const defined = new Set(customProps(rootLightRules()).map((d) => d.prop));
		const missing = TOKEN_NAMES.filter((n) => !defined.has(n));
		expect(missing, ':root に定義が無いトークン').toEqual([]);
	});

	test('themes/default.json の鍵(common ∪ light ∪ dark・-- を省いた形)の集合が 65 名と一致する', () => {
		expect(jsonKeys(defaultThemeJson())).toEqual([...TOKEN_NAMES].sort());
	});

	test('themes/default.json は version 1 で、65 名すべてが common か light と dark の両方に値を持つ(補う先が無いので欠けてはいけない)', () => {
		const theme = defaultThemeJson();
		expect(theme.version).toBe(1);
		const common = new Set(Object.keys(theme.common ?? {}));
		const light = new Set(Object.keys(theme.light ?? {}));
		const dark = new Set(Object.keys(theme.dark ?? {}));
		const incomplete = TOKEN_NAMES.map((n) => n.slice(2)).filter(
			(k) => !(common.has(k) || (light.has(k) && dark.has(k))),
		);
		expect(incomplete, 'light か dark の片方にしか無い(common にも無い)鍵').toEqual([]);
		const values = [
			...Object.values(theme.common ?? {}),
			...Object.values(theme.light ?? {}),
			...Object.values(theme.dark ?? {}),
		];
		expect(values.every((v) => typeof v === 'string'), '値はすべて文字列').toBe(true);
		expect(values.filter((v) => /var\(/.test(String(v))), '値に var() は書けない(§4.4)').toEqual([]);
	});

	test('契約 2 の本文に値まで書かれたトークン(余白 4〜32px・角丸 5/9px・行長 72ch・見出し行 11px/600/.06em)は値も一致する', () => {
		const props = customProps(rootLightRules());
		const mismatches: string[] = [];
		for (const [name, want] of Object.entries(FIXED_VALUES)) {
			const got = lastValue(props, name);
			if (got === undefined || normalizeValue(got) !== normalizeValue(want)) {
				mismatches.push(`${name}: ${got ?? '(未定義)'} (期待 ${want})`);
			}
		}
		expect(mismatches, '契約 2 の値と違うトークン').toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// AC-56-2 — 既存トークンの温存
// ---------------------------------------------------------------------------

describe('AC-56-2 既存トークンの温存(契約 2): 要件#7 の 13 色と要件#64 追補b の 3 つの名前が残っている', () => {
	test('要件#7 の 13 色が :root に定義されている(削除・改名なし)', () => {
		const defined = new Set(customProps(rootLightRules()).map((d) => d.prop));
		const missing = LEGACY_COLOR_TOKENS.filter((n) => !defined.has(n));
		expect(missing, '消えた・改名された要件#7 のトークン').toEqual([]);
	});

	test('要件#64 追補b の見出し行 3 トークンが :root に定義されている', () => {
		const defined = new Set(customProps(rootLightRules()).map((d) => d.prop));
		const missing = LEGACY_PANE_HEADER_TOKENS.filter((n) => !defined.has(n));
		expect(missing, '消えた・改名された要件#64 追補b のトークン').toEqual([]);
	});

	test('新しい名前と違う既存名 7 つは契約 2 の対応どおりの var() の別名', () => {
		const props = customProps(rootLightRules());
		const wrong: string[] = [];
		for (const [legacy, target] of Object.entries(LEGACY_ALIASES)) {
			const got = lastValue(props, legacy);
			if (got === undefined || varTarget(got) !== target) {
				wrong.push(`${legacy}: ${got ?? '(未定義)'} (期待 var(${target}))`);
			}
		}
		expect(wrong, '別名になっていない既存トークン').toEqual([]);
	});

	test('別名 7 つはテーマの鍵にしない(themes/default.json に現れない=theme-architecture (r))', () => {
		const keys = new Set(jsonKeys(defaultThemeJson()));
		const leaked = Object.keys(LEGACY_ALIASES).filter((legacy) => keys.has(legacy));
		expect(leaked, '正本 JSON に紛れた別名').toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// AC-56-3 — ハードコード色ゼロ(第1段の範囲)
// ---------------------------------------------------------------------------

describe('AC-56-3 ハードコード色ゼロ(契約 2・第1段の範囲= app.css / markdown.css)', () => {
	for (const target of STAGE1_HARDCODE_FREE_FILES) {
		test(`${target.name}: 宣言値に #hex / 色関数 / 名前色が 1 件も無い(transparent / currentcolor / inherit は除く)`, () => {
			const css = stripCssComments(readText(target.path));
			const offenders = declarationsOf(css)
				.filter((d) => isColorLiteral(d.value))
				.map((d) => `${d.prop}: ${d.value}`);
			expect(offenders, `${target.name} に残る色リテラル宣言`).toEqual([]);
		});
	}
});

// ---------------------------------------------------------------------------
// AC-56-4 — --md-color-* の導出
// ---------------------------------------------------------------------------

describe('AC-56-4 --md-color-* の導出(契約 2): 16 個がトークンの var() 参照で定義されている', () => {
	function mdColorProps(): Decl[] {
		return customProps(parseRules(stripCssComments(readText(MARKDOWN_CSS)))).filter((d) =>
			d.prop.startsWith('--md-color-'),
		);
	}

	test('--md-color-* の名前の集合は 16 個のまま(増減・改名なし)', () => {
		expect(uniqueNames(mdColorProps())).toEqual([...MD_COLOR_TOKENS].sort());
	});

	test('16 個すべてが var(--…) 参照で、参照先は theme.css の :root に定義されている', () => {
		const defined = new Set(customProps(rootLightRules()).map((d) => d.prop));
		const props = mdColorProps();
		const offenders: string[] = [];
		for (const name of MD_COLOR_TOKENS) {
			const got = lastValue(props, name);
			const target = got === undefined ? null : varTarget(got);
			if (target === null) offenders.push(`${name}: ${got ?? '(未定義)'}(リテラル)`);
			else if (!defined.has(target)) offenders.push(`${name}: var(${target}) が theme.css に無い`);
		}
		expect(offenders, 'トークンから導出されていない --md-color-*').toEqual([]);
	});

	test('導出先が決まっているもの(契約 2 の例 text・判断 (l) の alert 5 色・link・task-checked)はそのとおり', () => {
		const props = mdColorProps();
		const wrong: string[] = [];
		for (const [name, target] of Object.entries(MD_COLOR_DERIVATIONS)) {
			const got = lastValue(props, name);
			if (got === undefined || varTarget(got) !== target) {
				wrong.push(`${name}: ${got ?? '(未定義)'} (期待 var(${target}))`);
			}
		}
		expect(wrong, '判断 (l) と違う導出先').toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// AC-56-5 — ダークの組
// ---------------------------------------------------------------------------

describe('AC-56-5 ダークの組(契約 2・判断 (b)): prefers-color-scheme と data-theme で同じ名前の集合を差し替える', () => {
	test('@media (prefers-color-scheme: dark) のブロックがあり、その中の宣言はすべてトークンの再定義(-- で始まる)', () => {
		const rules = darkMediaRules();
		expect(rules.length, '@media (prefers-color-scheme: dark) の中に規則があること').toBeGreaterThan(0);
		const nonToken = rules
			.flatMap((r) => declarationsOf(r.body))
			.filter((d) => !d.prop.startsWith('--'))
			.map((d) => `${d.prop}: ${d.value}`);
		expect(nonToken, 'ダークのブロックに混ざった通常の宣言(構造・セレクタは触らない)').toEqual([]);
	});

	test('メディアの規則のセレクタは :root:not([data-theme="light"])(OS がダークでも data-theme="light" ならライト)', () => {
		const media = darkMediaRules();
		expect(media.length).toBeGreaterThan(0);
		for (const r of media) {
			expect(excludesDataTheme(r.selector, 'light'), `${r.selector} が :not([data-theme="light"]) を持つこと`).toBe(true);
			expect(/:root/.test(r.selector), `${r.selector} は :root を狙うこと`).toBe(true);
		}
	});

	test('手動ダーク(:root[data-theme="dark"])のブロックが at-rule の外にあり、宣言はすべてトークンの再定義', () => {
		const attr = darkAttrRules();
		expect(attr.length, '[data-theme="dark"] を狙う規則が at-rule の外にあること').toBeGreaterThan(0);
		const nonToken = attr
			.flatMap((r) => declarationsOf(r.body))
			.filter((d) => !d.prop.startsWith('--'))
			.map((d) => `${d.prop}: ${d.value}`);
		expect(nonToken, '手動ダークのブロックに混ざった通常の宣言').toEqual([]);
	});

	test('手動ダークとメディアのダークで再定義する名前の集合が同じで、値も同じ(2 つのブロックが同じ組)', () => {
		const media = customProps(darkMediaRules());
		const attr = customProps(darkAttrRules());
		expect(uniqueNames(attr)).toEqual(uniqueNames(media));
		const differing: string[] = [];
		for (const name of uniqueNames(media)) {
			const a = lastValue(media, name);
			const b = lastValue(attr, name);
			if (a !== undefined && b !== undefined && normalizeValue(a) !== normalizeValue(b)) {
				differing.push(`${name}: media=${a} / attr=${b}`);
			}
		}
		expect(differing, '2 つのダークのブロックで値が食い違うトークン').toEqual([]);
	});

	test('ダークの組は正本の dark の鍵をすべて含み(値だけの差し替えに穴が無い)、65 名の外の名前を持たない', () => {
		const names = new Set(customProps(darkMediaRules()).map((d) => d.prop));
		const darkKeys = Object.keys(defaultThemeJson().dark ?? {}).map(cssName);
		expect(darkKeys.length, '正本に dark の鍵があること').toBeGreaterThan(0);
		expect(darkKeys.filter((k) => !names.has(k)), 'ダークで再定義されていない dark の鍵').toEqual([]);
		const known = new Set(TOKEN_NAMES);
		expect([...names].filter((n) => !known.has(n)), '65 名に無い名前のダーク宣言').toEqual([]);
		// 色 23+emphasis はライトとダークで値が違うので、必ずダークの組に入る
		expect([...COLOR_TOKENS, EMPHASIS_TOKEN].filter((n) => !names.has(n)), 'ダークで再定義されていない色トークン').toEqual([]);
	});

	test(`アクセント=藍の固定: :root の --color-accent は ${ACCENT_LIGHT}・ダーク(メディア・手動の両方)は ${ACCENT_DARK}`, () => {
		expect(lastValue(customProps(rootLightRules()), '--color-accent')?.toLowerCase()).toBe(ACCENT_LIGHT);
		expect(lastValue(customProps(darkMediaRules()), '--color-accent')?.toLowerCase()).toBe(ACCENT_DARK);
		expect(lastValue(customProps(darkAttrRules()), '--color-accent')?.toLowerCase()).toBe(ACCENT_DARK);
	});

	test(`themes/default.json の light / dark の color-accent も ${ACCENT_LIGHT} / ${ACCENT_DARK}`, () => {
		const theme = defaultThemeJson();
		expect(String(theme.light?.['color-accent']).toLowerCase()).toBe(ACCENT_LIGHT);
		expect(String(theme.dark?.['color-accent']).toLowerCase()).toBe(ACCENT_DARK);
	});

	test('遷移時間は prefers-reduced-motion: reduce で 0 になる(契約 2「遷移時間」の但し書き)', () => {
		const reduced = themeRules().filter((r) => r.at.some(isReducedMotionMedia));
		expect(reduced.length, '@media (prefers-reduced-motion: reduce) のブロックがあること').toBeGreaterThan(0);
		const props = customProps(reduced);
		for (const name of ['--duration-fast', '--duration-base', '--duration-slow']) {
			const got = lastValue(props, name);
			expect(got, `${name} が reduce で再定義されていること`).toBeDefined();
			expect(got, `${name} は 0 になること`).toMatch(/^0(ms|s)?$/);
		}
	});
});

// ---------------------------------------------------------------------------
// AC-56-6 — Shiki の対
// ---------------------------------------------------------------------------

describe('AC-56-6 Shiki の対(契約 2・3・判断 (m)(n)): Default の code と、テーマ名を引数で受ける renderer / code-highlight', () => {
	const MD_URI = 'file:///docs/sample.md';
	const FENCE = '```ts\nconst answer = 42;\n```\n';
	const TS_SOURCE = 'const answer = 42;\n';

	function firstSpanContaining(html: string, text: string): HTMLElement | null {
		const host = document.createElement('div');
		host.innerHTML = html;
		return [...host.querySelectorAll('pre span')].find((s) => s.textContent === text) as HTMLElement | null;
	}

	test('themes/default.json の code は { light: "github-light", dark: "github-dark" }', () => {
		expect(defaultThemeJson().code).toEqual(DEFAULT_CODE);
	});

	test('render の第 3 引数を省略するとライト(const が #D73A49= code-highlight.acceptance の実測値のまま)', async () => {
		const { html } = await render(FENCE, MD_URI);
		const span = firstSpanContaining(html, 'const');
		expect(span, 'const の span があること').not.toBeNull();
		expect(span!.getAttribute('style')).toBe('color:#D73A49');
	});

	test("render(source, baseUri, { codeTheme: 'github-light' }) は省略時と同じ出力", async () => {
		const plain = await render(FENCE, MD_URI);
		const light = await render(FENCE, MD_URI, { codeTheme: DEFAULT_CODE.light });
		expect(light.html).toBe(plain.html);
	});

	test("render(source, baseUri, { codeTheme: 'github-dark' }) は github-dark で描く(const の色がライトと違う・色は付く)", async () => {
		const light = await render(FENCE, MD_URI);
		const dark = await render(FENCE, MD_URI, { codeTheme: DEFAULT_CODE.dark });
		const lightSpan = firstSpanContaining(light.html, 'const');
		const darkSpan = firstSpanContaining(dark.html, 'const');
		expect(darkSpan, 'ダークでも const の span があること').not.toBeNull();
		expect(darkSpan!.getAttribute('style')).toMatch(/^color:#[0-9a-fA-F]{6}$/);
		expect(darkSpan!.getAttribute('style')).not.toBe(lightSpan!.getAttribute('style'));
	});

	test('highlightCode の第 3 引数を省略するとライト(const が #D73A49)', async () => {
		const html = await highlightCode(TS_SOURCE, 'typescript');
		expect(html, '色付けできること').not.toBeNull();
		expect(html!).toContain('color:#D73A49');
	});

	test("highlightCode(content, lang, 'github-dark') は github-dark で描く(#D73A49 が無く、別の色が付く)", async () => {
		const dark = await highlightCode(TS_SOURCE, 'typescript', DEFAULT_CODE.dark);
		expect(dark, '色付けできること').not.toBeNull();
		expect(dark!).not.toContain('color:#D73A49');
		expect(dark!).toMatch(/color:#[0-9a-fA-F]{6}/);
	});
});

// ---------------------------------------------------------------------------
// AC-56-7 — 本文の行長
// ---------------------------------------------------------------------------

describe('AC-56-7 本文の行長(契約 4・判断 (f)(g)): 地の文のブロックに 72ch の上限・幅いっぱいで none', () => {
	test('--doc-measure を参照する max-width が .markdown-body 直下の p / h1〜h6 / ul / ol / blockquote / dl / hr に当たっている', () => {
		const measured = maxWidthBySelector().filter(
			(e) => /var\(\s*--doc-measure\b/.test(e.value) && !hasFullWidthPrefix(e.selector),
		);
		expect(measured.length, 'max-width: var(--doc-measure) の規則があること').toBeGreaterThan(0);
		const uncovered = MEASURED_CHILDREN.filter(
			(child) => !measured.some((e) => targetsMeasuredChild(e.selector, child)),
		);
		expect(uncovered, '上限が当たっていない地の文のブロック').toEqual([]);
	});

	test('表・pre・Mermaid には --doc-measure の上限を当てていない(幅いっぱい)', () => {
		const measured = maxWidthBySelector().filter((e) => /var\(\s*--doc-measure\b/.test(e.value));
		const offenders = measured
			.filter((e) => UNMEASURED_SELECTOR_HINTS.some((hint) => e.selector.includes(hint)))
			.map((e) => e.selector);
		expect(offenders, '上限の対象外なのに --doc-measure が当たっているセレクタ').toEqual([]);
	});

	test('画像だけの段落(p:has(> img:only-child))は上限を外して幅いっぱい', () => {
		const entries = maxWidthBySelector().filter(
			(e) => /\.markdown-body\s*>\s*p:has\(/.test(e.selector) && /img/.test(e.selector) && !hasFullWidthPrefix(e.selector),
		);
		expect(entries.length, '.markdown-body > p:has(> img…) の max-width 規則があること').toBeGreaterThan(0);
		for (const e of entries) {
			expect(e.value, `${e.selector} の max-width`).toMatch(/^(none|100%)$/);
		}
	});

	test('幅いっぱいの状態(<html data-doc-measure="full">)では地の文のブロックの max-width が none に戻る', () => {
		const full = maxWidthBySelector().filter((e) => hasFullWidthPrefix(e.selector));
		expect(full.length, '[data-doc-measure="full"] を前置した max-width 規則があること').toBeGreaterThan(0);
		const notNone = full.filter((e) => e.value !== 'none').map((e) => `${e.selector} { max-width: ${e.value} }`);
		expect(notNone, '幅いっぱいなのに none 以外の max-width').toEqual([]);
		const uncovered = MEASURED_CHILDREN.filter(
			(child) => !full.some((e) => targetsMeasuredChild(e.selector, child)),
		);
		expect(uncovered, '幅いっぱいで上限が外れていない地の文のブロック').toEqual([]);
	});

	test('.markdown-body 単体ブロックに max-width は無く(本文の面は幅いっぱいのまま)、padding は維持(要件#20 (c) の趣旨)', () => {
		const base = markdownRules().filter((r) => r.selector === '.markdown-body');
		expect(base.length, '.markdown-body 単体セレクタのブロックがあること').toBeGreaterThan(0);
		const decls = base.flatMap((r) => declarationsOf(r.body));
		expect(decls.filter((d) => d.prop === 'max-width'), '.markdown-body 自体の max-width').toEqual([]);
		expect(decls.filter((d) => /^padding(-\w+)?$/.test(d.prop)).length, 'padding 宣言があること').toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// AC-56-18 — 生成物と正本の一致(vitest 側。Rust 側は acceptance_req56_theme.rs の AC-56-19)
// ---------------------------------------------------------------------------

describe('AC-56-18 生成物と正本の一致(契約 2・theme-architecture (l)(m)): build-theme-css.mjs の出力が theme.css と一致する', () => {
	test('buildThemeCss(themes/default.json) の文字列が src/styles/theme.css の中身と一致する(乖離したら pnpm theme:css)', async () => {
		const buildThemeCss = await loadBuildThemeCss();
		const generated = buildThemeCss(defaultThemeJson());
		expect(typeof generated).toBe('string');
		expect(generated, 'theme.css は生成物そのもの(手で直さない)').toBe(themeCssText());
	});

	test('生成物の先頭のコメントに「生成物・手で直さない」のヘッダ(正本 themes/default.json と pnpm theme:css の案内)がある', () => {
		const css = themeCssText();
		const firstComment = css.match(/^\s*\/\*([\s\S]*?)\*\//);
		expect(firstComment, '先頭がコメントであること').not.toBeNull();
		const header = firstComment![1];
		expect(header).toContain('themes/default.json');
		expect(header).toContain('pnpm theme:css');
		expect(header).toMatch(/generated|生成/i);
	});

	test('生成関数は JSON の鍵をそのまま -- 付きの変数名にする(名前の表を持たない)= 任意の鍵が 3 ブロックに現れる', async () => {
		const buildThemeCss = await loadBuildThemeCss();
		const synthetic = {
			version: 1,
			code: { light: 'github-light', dark: 'github-dark' },
			common: { 'probe-common': '7px' },
			light: { 'probe-light-dark': '#010203' },
			dark: { 'probe-light-dark': '#040506' },
		};
		const rules = parseRules(stripCssComments(buildThemeCss(synthetic)));
		const light = rules.filter(
			(r) => r.at.length === 0 && /:root/.test(r.selector) && !targetsDataTheme(r.selector, 'dark') && !targetsDataTheme(r.selector, 'light'),
		);
		const attrDark = rules.filter((r) => r.at.length === 0 && targetsDataTheme(r.selector, 'dark'));
		const mediaDark = rules.filter((r) => r.at.some(isDarkMedia));
		expect(lastValue(customProps(light), '--probe-common')).toBe('7px');
		expect(lastValue(customProps(light), '--probe-light-dark')).toBe('#010203');
		expect(lastValue(customProps(attrDark), '--probe-light-dark')).toBe('#040506');
		expect(lastValue(customProps(mediaDark), '--probe-light-dark')).toBe('#040506');
		expect(mediaDark.every((r) => excludesDataTheme(r.selector, 'light')), 'メディアの規則は :not([data-theme="light"])').toBe(true);
	});

	test('別名 7 個が生成物の :root に var() で定義され、prefers-reduced-motion: reduce の規則がある', () => {
		const props = customProps(rootLightRules());
		for (const [legacy, target] of Object.entries(LEGACY_ALIASES)) {
			expect(varTarget(lastValue(props, legacy) ?? ''), `${legacy} の別名先`).toBe(target);
		}
		const reduced = themeRules().filter((r) => r.at.some(isReducedMotionMedia));
		expect(reduced.length).toBeGreaterThan(0);
	});
});
