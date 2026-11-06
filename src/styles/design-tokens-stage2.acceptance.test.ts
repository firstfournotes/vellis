/**
 * 要件#56 の受け入れテスト(docs/requirements/req-56.md)— 第2段のデザイントークン
 * (AC-56-3 の第2段・契約 4 の見出し行(判断 (q))・契約 7 第2段 (e) の `color-scheme`・AC-56-22 の CSS 側)
 *
 * 第1段の `design-tokens.acceptance.test.ts` は `app.css` / `markdown.css` までを対象にした(AC-56-3 の
 * 「コンポーネントは第2段」)。本ファイルはその対象を **`src/components/*.svelte` 全部**に広げる。
 * 第1段のファイルは書き換えない(「既存テストは書き換えない」= 第1段の `STAGE1_HARDCODE_FREE_FILES`
 * の注記はそのまま残り、本ファイルが第2段の集合を持つ)。
 *
 * 判定するもの:
 * - AC-56-3(第2段)  `src/components/*.svelte` の `<style>` の宣言値に色リテラル(`#hex` / 色関数 / 名前色)が
 *   1 件も無い(`transparent` / `currentcolor` / `inherit` は色扱いしない=要件#7 と同じ)。**加えて `<script>` の
 *   文字列リテラル**(`FIND_SURFACE_CSS`・`HTML_SURFACE_CSS` のような注入 CSS)にも `#hex` / 色関数が無い
 *   (`var(--…)` は可)。例外は `theme.css` のトークン定義行だけ(対象にしない)。`print.css` は契約 6 で不変
 * - 契約 4・判断 (q)  `--pane-header-font-size` / `--pane-header-font-weight` / `--pane-header-letter-spacing` の
 *   Default 値が 11px / 600 / .06em(`themes/default.json` の `common`)で、Explorer・Recent Files・Find in Folder の
 *   見出し行の規則が `text-transform: uppercase` と 3 トークンを使う(2026-11-03 第1段で既に満たしている=
 *   **現状の固定**。第2段の塗り替えで戻らないことを見る)
 * - 契約 7 第2段 (e)  標準部品(`<input>` / `<select>` / スクロールバー)もモードに従うよう `app.css` に
 *   `color-scheme` を置く: ライト= `light`・手動ダーク(`[data-theme="dark"]`)= `dark`・System= OS に従う。
 *   `theme.css` のダークのブロックは「トークンの再定義だけ」(AC-56-5)なので `theme.css` には書けない=
 *   `app.css` に書く。HTML の iframe を白地に固定する `color-scheme: light`(判断 (o)・第1段の実装の要点 6)は残す
 * - AC-56-22(CSS 側)  生成物 `theme.css` の `@media print` ブロックが**ちょうど 1 つ**・セレクタ `:root:root:root`・
 *   中は 65 名すべてで値は `themes/default.json` の `light`(`common` を含む)・他のセレクタ・他の宣言は無い。
 *   `scripts/build-theme-css.mjs` の生成関数が同じブロックを作る(任意の鍵で印刷ブロックに common と light が
 *   現れ dark は現れない)。配線側(`beforeMainFramePrint`・`afterprint`)は `src/lib/print-theme.acceptance.test.ts`
 *
 * 判定しないもの(人間ゲート 1・2・7): 配色の良し悪し・モックとの一致・塗り残しの見え方・刷り上がり。
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * ```css
 * /* src/styles/app.css — 形 A(推奨。theme.css と同じ 3 ブロックの流儀) *\/
 * :root { color-scheme: light; }
 * :root[data-theme="dark"] { color-scheme: dark; }
 * @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; } }
 * /* 形 B も可: :root { color-scheme: light dark } + :root[data-theme="dark"] { dark } + :root[data-theme="light"] { light } *\/
 * .app iframe.html-viewer { color-scheme: light; background-color: Canvas; }   /* 判断 (o)・残す *\/
 * ```
 *
 * 判定方式: ソース検査型(第1段と同じ小さな CSS 字句解析。`<script>` の文字列リテラルは JS の字句を
 * 追って取り出す=文字列・テンプレート・コメント・正規表現を区別する)。
 *
 * 実装前の見立て(赤の理由): `<style>` の色リテラル= DiffView 2・InstructionDialog 3・Viewer 10 宣言、
 * `<script>` の文字列= Viewer の `HTML_SURFACE_CSS` / `FIND_SURFACE_CSS`(`#93c5fd` `#0000ee` `#fef08a` `#fb923c`
 * `#1f2328`)、`app.css` に `:root` の `color-scheme` が無い。見出し行と印刷ブロックは第1段で満たしている(緑)。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');
const COMPONENTS_DIR = resolve(REPO_ROOT, 'src/components');
const THEME_CSS = resolve(REPO_ROOT, 'src/styles/theme.css');
const APP_CSS = resolve(REPO_ROOT, 'src/styles/app.css');
const DEFAULT_THEME_JSON = resolve(REPO_ROOT, 'themes/default.json');
const BUILD_SCRIPT = resolve(REPO_ROOT, 'scripts/build-theme-css.mjs');

/** 契約 2 の 65 名(第1段の design-tokens.acceptance と同じ集合。`--` 付き)。 */
const TOKEN_NAMES: readonly string[] = [
	'--color-bg-base', '--color-bg-surface', '--color-bg-raised', '--color-bg-hover', '--color-bg-active',
	'--color-text-primary', '--color-text-secondary', '--color-text-muted', '--color-border', '--color-border-strong',
	'--color-accent', '--color-accent-text', '--color-on-accent', '--color-accent-soft', '--color-selection',
	'--color-focus-ring', '--color-danger', '--color-success', '--color-warning', '--color-danger-soft',
	'--color-success-soft', '--color-warning-soft', '--color-shadow', '--color-emphasis',
	'--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6',
	'--radius-sm', '--radius-md',
	'--font-ui', '--font-doc', '--font-mono', '--text-xs', '--text-sm', '--text-md', '--text-lg', '--text-xl',
	'--doc-size', '--doc-leading', '--doc-measure', '--leading-ui',
	'--pane-header-font-size', '--pane-header-font-weight', '--pane-header-letter-spacing',
	'--shadow-1', '--shadow-2',
	'--duration-fast', '--duration-base', '--duration-slow', '--ease-out',
	'--ft-md', '--ft-html', '--ft-pdf', '--ft-img', '--ft-video', '--ft-audio', '--ft-3d', '--ft-code', '--ft-folder',
	'--color-find-match', '--color-find-current', '--color-find-current-text',
];

/**
 * AC-56-3 第2段の対象= 契約 4 の 22 個のコンポーネント(2026-11-02 実測)+ 契約 5・判断 (i) で足す `Icon.svelte`
 * (sprite は `+page.svelte` の先頭に置くので `src/components/` には増えない)。名前の集合で固定する。
 */
const STAGE2_COMPONENT_FILES = [
	'AudioViewer.svelte',
	'ContextMenu.svelte',
	// 要件#83 契約 1【(s) 決定】(2026-11-05 承認 1 の要件側更新): RootPicker.svelte を Dashboard.svelte に置き換え(23 個のまま)。
	'Dashboard.svelte',
	'DiffView.svelte',
	'EmptyState.svelte',
	'Explorer.svelte',
	'ExplorerItem.svelte',
	'FindBar.svelte',
	'FindInFolder.svelte',
	'GoToBar.svelte',
	'HtmlViewer.svelte',
	'Icon.svelte',
	'ImageViewer.svelte',
	'InstructionDialog.svelte',
	'MarkList.svelte',
	'ModelViewer.svelte',
	'PdfViewer.svelte',
	'ProvenancePanel.svelte',
	'RecentFiles.svelte',
	'StatusBar.svelte',
	'UpdateBanner.svelte',
	'VideoViewer.svelte',
	'Viewer.svelte',
] as const;

/** 判断 (q): 区画の見出し行の 3 トークンの Default 値(要件#64 追補b の名前・値は本要件で変える)。 */
const PANE_HEADER_VALUES: Record<string, string> = {
	'pane-header-font-size': '11px',
	'pane-header-font-weight': '600',
	'pane-header-letter-spacing': '0.06em',
};

/**
 * 判断 (q): 見出し行を共有する 3 区画(要件の本文どおり。Sources=ProvenancePanel は「出さない判定」なので含めない)。
 * セレクタは既存のクラス名(契約 6 で改名しない)。
 */
const PANE_HEADER_COMPONENTS: ReadonlyArray<{ file: string; selector: string }> = [
	{ file: 'Explorer.svelte', selector: '.explorer-header' },
	{ file: 'RecentFiles.svelte', selector: '.recent-files-header' },
	{ file: 'FindInFolder.svelte', selector: '.find-in-folder-header' },
];

// ---------------------------------------------------------------------------
// helpers — CSS(第1段と同じ字句解析)
// ---------------------------------------------------------------------------

function readText(path: string): string {
	return readFileSync(path, 'utf8');
}

function stripCssComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

type Decl = { prop: string; value: string };

function declarationsOf(css: string): Decl[] {
	const out: Decl[] = [];
	const re = /([-\w]+)\s*:\s*([^{};]+)(?=[;}])/g;
	for (let m = re.exec(css); m !== null; m = re.exec(css)) out.push({ prop: m[1], value: m[2].trim() });
	return out;
}

type Rule = { selector: string; body: string; at: string[] };

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

/** `.06em` と `0.06em`、空白の違いを吸収する。 */
function normalizeValue(v: string): string {
	return v
		.toLowerCase()
		.replace(/\s+/g, '')
		.replace(/(^|[^\d.])\.(\d)/g, '$10.$2');
}

// ---------------------------------------------------------------------------
// helpers — .svelte の <style> / <script>
// ---------------------------------------------------------------------------

function componentFiles(): string[] {
	return readdirSync(COMPONENTS_DIR)
		.filter((f) => f.endsWith('.svelte'))
		.sort();
}

function componentSource(name: string): string {
	return readText(join(COMPONENTS_DIR, name));
}

function styleBlocksOf(source: string): string[] {
	return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
}

function scriptBlocksOf(source: string): string[] {
	return [...source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

/**
 * JS / TS の文字列リテラル(`'…'` / `"…"` / `` `…` ``)の中身を順に集める。コメントと正規表現リテラルは
 * 飛ばす(正規表現は `(` `,` `=` `:` `[` `!` `&` `|` `?` `{` `}` `;` `return` の後ろの `/` と見なす)。
 * テンプレートの `${…}` の中は中身に含めない(その中の文字列は別のリテラルとして拾う)。
 */
function stringLiteralsOf(script: string): string[] {
	const out: string[] = [];
	const n = script.length;
	let i = 0;
	let lastSignificant = '';
	const regexPrecedes = (): boolean => {
		if (lastSignificant === '') return true;
		if (/[(,=:[!&|?{};+\-*%<>~^]$/.test(lastSignificant)) return true;
		return /\b(return|typeof|case|do|else|in|of|new|delete|void|throw)$/.test(lastSignificant);
	};
	const readTemplate = (start: number): number => {
		// start = 位置の "`"。中身を集め、閉じの "`" の次を返す。
		let j = start + 1;
		let text = '';
		while (j < n) {
			const c = script[j];
			if (c === '\\') {
				text += script[j + 1] ?? '';
				j += 2;
				continue;
			}
			if (c === '`') {
				out.push(text);
				return j + 1;
			}
			if (c === '$' && script[j + 1] === '{') {
				// `${ … }` の中は JS。入れ子の括弧と文字列を追って閉じ括弧へ。
				let depth = 1;
				let k = j + 2;
				while (k < n && depth > 0) {
					const d = script[k];
					if (d === "'" || d === '"') {
						k = readQuoted(k, d);
						continue;
					}
					if (d === '`') {
						k = readTemplate(k);
						continue;
					}
					if (d === '{') depth += 1;
					else if (d === '}') depth -= 1;
					k += 1;
				}
				text += ' ';
				j = k;
				continue;
			}
			text += c;
			j += 1;
		}
		out.push(text);
		return n;
	};
	const readQuoted = (start: number, quote: string): number => {
		let j = start + 1;
		let text = '';
		while (j < n) {
			const c = script[j];
			if (c === '\\') {
				text += script[j + 1] ?? '';
				j += 2;
				continue;
			}
			if (c === quote || c === '\n') {
				out.push(text);
				return j + 1;
			}
			text += c;
			j += 1;
		}
		out.push(text);
		return n;
	};
	while (i < n) {
		const c = script[i];
		if (c === '/' && script[i + 1] === '/') {
			const nl = script.indexOf('\n', i);
			i = nl === -1 ? n : nl + 1;
			continue;
		}
		if (c === '/' && script[i + 1] === '*') {
			const end = script.indexOf('*/', i + 2);
			i = end === -1 ? n : end + 2;
			continue;
		}
		if (c === "'" || c === '"') {
			i = readQuoted(i, c);
			lastSignificant = '"';
			continue;
		}
		if (c === '`') {
			i = readTemplate(i);
			lastSignificant = '"';
			continue;
		}
		if (c === '/' && regexPrecedes()) {
			let j = i + 1;
			let inClass = false;
			while (j < n) {
				const d = script[j];
				if (d === '\\') {
					j += 2;
					continue;
				}
				if (d === '\n') break;
				if (inClass) {
					if (d === ']') inClass = false;
				} else if (d === '[') inClass = true;
				else if (d === '/') break;
				j += 1;
			}
			i = j + 1;
			lastSignificant = ')';
			continue;
		}
		if (!/\s/.test(c)) lastSignificant = (lastSignificant + c).slice(-8);
		i += 1;
	}
	return out;
}

/** 文字列リテラルが「CSS の色を直書きしている」と見なす条件= `#hex` か色関数を含み、CSS らしい(`:` か `{` がある)。 */
function literalHasCssColor(text: string): boolean {
	if (!/[:{]/.test(text)) return false;
	return HEX_RE.test(text) || COLOR_FUNCTION_RE.test(text);
}

// ---------------------------------------------------------------------------
// helpers — 正本 themes/default.json と theme.css
// ---------------------------------------------------------------------------

type ThemeJson = {
	version?: unknown;
	code?: { light?: unknown; dark?: unknown };
	common?: Record<string, string>;
	light?: Record<string, string>;
	dark?: Record<string, string>;
};

function defaultThemeJson(): ThemeJson {
	return JSON.parse(readText(DEFAULT_THEME_JSON)) as ThemeJson;
}

/** ライトの解決値(common → light の順で後勝ち)。鍵は `--` 付き。 */
function lightValuesOf(theme: ThemeJson): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(theme.common ?? {})) out[`--${k}`] = String(v);
	for (const [k, v] of Object.entries(theme.light ?? {})) out[`--${k}`] = String(v);
	return out;
}

function isPrintMedia(at: string): boolean {
	return /^@media\b/.test(at) && /\bprint\b/.test(at);
}

function printRulesOf(css: string): { atRules: string[]; rules: Rule[] } {
	const rules = parseRules(stripCssComments(css));
	const atRules = [...new Set(rules.flatMap((r) => r.at).filter(isPrintMedia))];
	// `@media print {}` が空のときは規則が無く at-rule も拾えないので、テキストでも数える。
	const textual = (stripCssComments(css).match(/@media\s+print\b/g) ?? []).length;
	return { atRules: atRules.length > 0 ? atRules : new Array(textual).fill('@media print'), rules: rules.filter((r) => r.at.some(isPrintMedia)) };
}

async function loadBuildThemeCss(): Promise<(theme: unknown) => string> {
	const mod = (await import(/* @vite-ignore */ pathToFileURL(BUILD_SCRIPT).href)) as { buildThemeCss?: unknown };
	expect(typeof mod.buildThemeCss, 'scripts/build-theme-css.mjs は buildThemeCss を export すること').toBe('function');
	return mod.buildThemeCss as (theme: unknown) => string;
}

// ---------------------------------------------------------------------------
// AC-56-3(第2段)— コンポーネントのハードコード色ゼロ
// ---------------------------------------------------------------------------

describe('AC-56-3 ハードコード色ゼロ(契約 2・第2段= src/components/*.svelte の <style> 全部)', () => {
	test('対象は契約 4 の 22 個のコンポーネント+契約 5・判断 (i) の Icon.svelte = 23 個(名前の集合で固定。増減があれば要件側で確認)', () => {
		expect(componentFiles()).toEqual([...STAGE2_COMPONENT_FILES].sort());
	});

	for (const name of componentFiles()) {
		test(`${name}: <style> の宣言値に #hex / 色関数 / 名前色が 1 件も無い(transparent / currentcolor / inherit は除く)`, () => {
			const offenders = styleBlocksOf(componentSource(name))
				.flatMap((css) => declarationsOf(stripCssComments(css)))
				.filter((d) => isColorLiteral(d.value))
				.map((d) => `${d.prop}: ${d.value}`);
			expect(offenders, `${name} の <style> に残る色リテラル宣言`).toEqual([]);
		});
	}
});

describe('AC-56-3 ハードコード色ゼロ(契約 2・第2段= <script> の文字列リテラルに書かれた CSS も対象)', () => {
	test('字句解析の前提: 文字列・テンプレート・コメント・正規表現を区別できる', () => {
		const sample = [
			"const a = 'x{color:#111}'; // comment #222 { }",
			'const b = /#333[:{]/.test(s) ? "y{color:#444}" : `z{color:#555 ${v}}`;',
			'/* block #666 {} */ const c = 10 / 2 / 5;',
		].join('\n');
		expect(stringLiteralsOf(sample)).toEqual(['x{color:#111}', 'y{color:#444}', 'z{color:#555  }']);
	});

	for (const name of componentFiles()) {
		test(`${name}: <script> の文字列リテラル(注入 CSS 等)に #hex / 色関数が無い(var(--…) は可)`, () => {
			const offenders = scriptBlocksOf(componentSource(name))
				.flatMap(stringLiteralsOf)
				.filter(literalHasCssColor)
				.map((s) => (s.length > 120 ? `${s.slice(0, 120)}…` : s));
			expect(offenders, `${name} の <script> の文字列に残る色リテラル(FIND_SURFACE_CSS / HTML_SURFACE_CSS 等は var() で書く=契約 7 第2段 (b))`).toEqual([]);
		});
	}
});

// ---------------------------------------------------------------------------
// 契約 4・判断 (q)— 区画の見出し行(現状の固定)
// ---------------------------------------------------------------------------

describe('契約 4・判断 (q) 区画の見出し行: Default は 11px / 600 / .06em・Explorer / Recent Files / Find in Folder が共有し大文字にする(第1段で達成済み=固定)', () => {
	test('themes/default.json の common に 3 トークンがあり値は 11px / 600 / .06em', () => {
		const common = defaultThemeJson().common ?? {};
		for (const [key, want] of Object.entries(PANE_HEADER_VALUES)) {
			expect(common[key], `common.${key}`).toBeDefined();
			expect(normalizeValue(String(common[key])), key).toBe(normalizeValue(want));
		}
	});

	for (const { file, selector } of PANE_HEADER_COMPONENTS) {
		/** 見出し行そのもの(単体セレクタ `selector` だけの規則)。 */
		const headerRules = () =>
			styleBlocksOf(componentSource(file))
				.flatMap((css) => parseRules(stripCssComments(css)))
				.filter((r) => r.selector.split(',').map((s) => s.trim()).includes(selector));

		test(`${file}: ${selector} の規則が text-transform: uppercase と var(--pane-header-*) 3 つを持つ`, () => {
			const rules = headerRules();
			expect(rules.length, `${selector} の規則があること`).toBeGreaterThan(0);
			const decls = rules.flatMap((r) => declarationsOf(r.body));
			const value = (prop: string) => decls.filter((d) => d.prop === prop).map((d) => d.value.replace(/\s+/g, ''));
			expect(value('text-transform'), 'text-transform').toContain('uppercase');
			expect(value('font-size').some((v) => v.startsWith('var(--pane-header-font-size')), 'font-size はトークン').toBe(true);
			expect(value('font-weight').some((v) => v.startsWith('var(--pane-header-font-weight')), 'font-weight はトークン').toBe(true);
			expect(value('letter-spacing').some((v) => v.startsWith('var(--pane-header-letter-spacing')), 'letter-spacing はトークン').toBe(true);
		});

		test(`${file}: ${selector} の規則が font-size / font-weight / letter-spacing を直書きしていない`, () => {
			const literal = headerRules()
				.flatMap((r) => declarationsOf(r.body))
				.filter((d) => ['font-size', 'font-weight', 'letter-spacing'].includes(d.prop) && !/^var\(--pane-header-/.test(d.value))
				.map((d) => `${selector} { ${d.prop}: ${d.value} }`);
			expect(literal, '見出し行そのものの直書き').toEqual([]);
		});
	}
});

// ---------------------------------------------------------------------------
// 契約 7 第2段 (e)— color-scheme(標準部品もモードに従う)
// ---------------------------------------------------------------------------

function rootSelector(selector: string): boolean {
	return /^(:root|html)\b/.test(selector) && !/\[data-theme/.test(selector) && !/\s/.test(selector.trim());
}

function attrSelector(selector: string, value: 'light' | 'dark'): boolean {
	const stripped = selector.replace(/:not\([^)]*\)/g, '');
	return /^(:root|html)/.test(stripped) && new RegExp(`\\[data-theme\\s*=\\s*["']?${value}["']?\\s*\\]`).test(stripped);
}

function excludesLight(selector: string): boolean {
	return /:not\(\s*\[data-theme\s*=\s*["']?light["']?\s*\]\s*\)/.test(selector);
}

function isDarkMedia(at: string): boolean {
	return /^@media\b/.test(at) && /prefers-color-scheme\s*:\s*dark/.test(at);
}

function colorSchemeOf(rules: Rule[]): string | undefined {
	const hits = rules.flatMap((r) => declarationsOf(r.body)).filter((d) => d.prop === 'color-scheme');
	return hits.length > 0 ? hits[hits.length - 1].value.replace(/\s+/g, ' ').trim().toLowerCase() : undefined;
}

describe('契約 7 第2段 (e) color-scheme: app.css で標準部品もモードに従う(ライト= light・手動ダーク= dark・System= OS)', () => {
	const appRules = () => parseRules(stripCssComments(readText(APP_CSS)));

	test(':root(属性なし・at-rule の外)に color-scheme があり、値は light か light dark', () => {
		const root = appRules().filter((r) => r.at.length === 0 && rootSelector(r.selector));
		const value = colorSchemeOf(root);
		expect(value, ':root の color-scheme').toBeDefined();
		expect(['light', 'light dark']).toContain(value);
	});

	test(':root[data-theme="dark"](at-rule の外)の color-scheme が dark', () => {
		const dark = appRules().filter((r) => r.at.length === 0 && attrSelector(r.selector, 'dark'));
		expect(colorSchemeOf(dark), ':root[data-theme="dark"] の color-scheme').toBe('dark');
	});

	test('System で OS がダークなら dark・data-theme="light" なら light(形 A: @media + :not([data-theme="light"]) / 形 B: light dark + [data-theme="light"])', () => {
		const rules = appRules();
		const rootValue = colorSchemeOf(rules.filter((r) => r.at.length === 0 && rootSelector(r.selector)));
		if (rootValue === 'light') {
			const media = rules.filter((r) => r.at.some(isDarkMedia) && /:root|^html/.test(r.selector) && excludesLight(r.selector));
			expect(colorSchemeOf(media), '@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme } }').toBe('dark');
		} else {
			const light = rules.filter((r) => r.at.length === 0 && attrSelector(r.selector, 'light'));
			expect(colorSchemeOf(light), ':root[data-theme="light"] { color-scheme: light }').toBe('light');
		}
	});

	test('HTML の iframe は白地のまま(判断 (o)): .app iframe.html-viewer の color-scheme: light と background-color: Canvas は残る', () => {
		const iframe = appRules().filter((r) => /iframe\.html-viewer/.test(r.selector));
		expect(iframe.length).toBeGreaterThan(0);
		const decls = iframe.flatMap((r) => declarationsOf(r.body));
		expect(decls.find((d) => d.prop === 'color-scheme')?.value).toBe('light');
		expect(decls.find((d) => d.prop === 'background-color')?.value).toBe('Canvas');
	});

	test('theme.css には color-scheme を書かない(ダークのブロックはトークンの再定義だけ= AC-56-5)', () => {
		expect(declarationsOf(stripCssComments(readText(THEME_CSS))).filter((d) => d.prop === 'color-scheme')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// AC-56-22(CSS 側)— @media print ブロック
// ---------------------------------------------------------------------------

describe('AC-56-22 ダークのまま印刷の固定(CSS 側): theme.css の @media print は 1 つ・:root:root:root・65 名= Default のライトの値', () => {
	test('@media print のブロックがちょうど 1 つ', () => {
		expect(printRulesOf(readText(THEME_CSS)).atRules.length).toBe(1);
	});

	test('その中の規則は :root:root:root の 1 つだけ(他のセレクタ・入れ子の at-rule は無い)', () => {
		const { rules } = printRulesOf(readText(THEME_CSS));
		expect(rules.map((r) => r.selector)).toEqual([':root:root:root']);
		expect(rules[0].at.length, '入れ子の at-rule は無い').toBe(1);
	});

	test('宣言はすべてトークン(-- で始まる)で、65 名すべてが themes/default.json の light(common 含む)の値で書かれている', () => {
		const { rules } = printRulesOf(readText(THEME_CSS));
		const decls = declarationsOf(rules[0].body);
		const nonToken = decls.filter((d) => !d.prop.startsWith('--')).map((d) => `${d.prop}: ${d.value}`);
		expect(nonToken, 'トークン以外の宣言').toEqual([]);
		const got = Object.fromEntries(decls.map((d) => [d.prop, d.value]));
		const want = lightValuesOf(defaultThemeJson());
		const missing = TOKEN_NAMES.filter((n) => !(n in got));
		expect(missing, '印刷ブロックに無いトークン').toEqual([]);
		const extra = Object.keys(got).filter((n) => !TOKEN_NAMES.includes(n));
		expect(extra, '65 名の外の宣言(別名もここには書かない)').toEqual([]);
		const differing = TOKEN_NAMES.filter((n) => normalizeValue(got[n]) !== normalizeValue(want[n] ?? '')).map(
			(n) => `${n}: ${got[n]} (期待 ${want[n]})`,
		);
		expect(differing, 'ライトの値と違うトークン').toEqual([]);
	});

	test('生成関数も同じ印刷ブロックを作る: 任意の鍵で common と light が :root:root:root に現れ、dark は現れない', async () => {
		const buildThemeCss = await loadBuildThemeCss();
		const synthetic = {
			version: 1,
			code: { light: 'github-light', dark: 'github-dark' },
			common: { 'probe-common': '7px' },
			light: { 'probe-mode': '#010203' },
			dark: { 'probe-mode': '#040506', 'probe-dark-only': '#070809' },
		};
		const { atRules, rules } = printRulesOf(buildThemeCss(synthetic));
		expect(atRules.length).toBe(1);
		expect(rules.map((r) => r.selector)).toEqual([':root:root:root']);
		const got = Object.fromEntries(declarationsOf(rules[0].body).map((d) => [d.prop, d.value]));
		expect(got).toEqual({ '--probe-common': '7px', '--probe-mode': '#010203' });
	});
});
