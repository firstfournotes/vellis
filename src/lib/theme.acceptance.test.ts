/**
 * 要件#7 の受け入れテスト(requirements.md #7)
 * 「UI 配色を共通 CSS 変数パレットへ集約する(RootPicker・Explorer の直書き色を撤廃。
 *   見た目は現状維持)」
 *
 * 契約(2026-08-04 由谷決定=CSS変数集約案。implementer はこれに従う):
 *
 * (a) 共通パレット `src/styles/theme.css`(新規)に CSS custom properties を定義する。
 *     markdown.css の流儀(:root ブロックに --xxx: 値)に合わせる。変数名は実装の自由。
 * (b) `src/components/RootPicker.svelte`・`src/components/Explorer.svelte`・
 *     `src/components/ExplorerItem.svelte` の <style> から色リテラルを撤廃する
 *     (2026-08-04 由谷回答で ExplorerItem も対象に確定。requirements.md 反映済み)。
 *     hex(#xxx)だけでなく rgb()/hsl() 等の色関数・
 *     名前色(white 等)への書き換えによる回避も不可(transparent / currentcolor は
 *     色リテラル扱いしない — 現行スタイルが transparent を正当に使っているため)。
 * (c) 色は var(--…) 参照で指定し、参照する変数はすべて theme.css で定義されている
 *     こと(=共通パレットへの集約。コンポーネント内ローカル定義への逃げも不可)。
 * (d) theme.css がアプリの読み込み経路に乗っていること(+page.svelte / +layout /
 *     app.css の @import のいずれかから import されている)。
 *
 * 判定方式: ソース検査型(対象ファイルをテキストとして読み、機械判定する)。
 *
 * ## reviewer 照合に委ねる範囲(本テストの判定対象外)
 * - 「見た目は現状維持」の画素レベル判定(各セレクタの算出色が置換前後で一致する
 *   こと)は機械化しない。本テストは代替として「置換前に使われていた全 hex 値が
 *   theme.css の変数定義値として現れること」を固定する(下記 REQUIRED_PALETTE_HEXES)。
 * - import 配線が実際にレンダリングへ効くこと(app.css 経由なら app.css 自体が
 *   読み込まれていること)。
 *
 * ## 範囲の注記
 * - 対象は RootPicker.svelte・Explorer.svelte・ExplorerItem.svelte の3ファイル
 *   (由谷回答 2026-08-04 で確定)。ほかのコンポーネントは要件#7 の契約範囲外。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');
const THEME_CSS_PATH = resolve(REPO_ROOT, 'src/styles/theme.css');

const COMPONENT_TARGETS = [
	{ name: 'RootPicker.svelte', path: resolve(REPO_ROOT, 'src/components/RootPicker.svelte') },
	{ name: 'Explorer.svelte', path: resolve(REPO_ROOT, 'src/components/Explorer.svelte') },
	{ name: 'ExplorerItem.svelte', path: resolve(REPO_ROOT, 'src/components/ExplorerItem.svelte') },
] as const;

/**
 * 置換前(2026-08-04 時点)に RootPicker/Explorer/ExplorerItem の <style> で使われて
 * いた全 hex 値。「見た目は現状維持」の機械判定可能な代替として、これらが theme.css
 * の変数定義値に現れることを要求する(どの変数名に載せるかは実装の自由)。
 */
const REQUIRED_PALETTE_HEXES = [
	'#ffffff', // RootPicker .root-picker 背景
	'#f6f8fa', // Explorer 背景・RootPicker hover/ボタン背景
	'#eaeef2', // hover 背景(RootPicker/Explorer)
	'#d0d7de', // 枠線(RootPicker/Explorer)
	'#1f2328', // 主要文字色(RootPicker)
	'#24292f', // Explorer .up-button hover 文字色
	'#656d76', // 副次文字色(3ファイル共通。ExplorerItem .caret 含む)
	'#a0a8b0', // RootPicker 空履歴の文字色
	'#cf222e', // エラー文字色(RootPicker .error / ExplorerItem .tree-note.error)
	'#e8e8e8', // ExplorerItem .explorer-item:hover 背景
	'#d0e0f0', // ExplorerItem .explorer-item.active 背景
	'#8b949e', // ExplorerItem .tree-note 文字色
] as const;

/** CSS 拡張名前色キーワード(CSS Color Module)。回避防止のための禁止リスト。 */
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

/** 色関数リテラル(var 参照ではない色指定)の禁止パターン。 */
const COLOR_FUNCTION_RE = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\s*\(/i;

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;
const HEX_RE_G = /#[0-9a-fA-F]{3,8}\b/g;

// ---------------------------------------------------------------------------
// helpers(ソース検査)
// ---------------------------------------------------------------------------

function readText(path: string): string {
	return readFileSync(path, 'utf8');
}

function stripCssComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** .svelte ファイルから <style> 本文(コメント除去済み)を取り出す。 */
function styleBlockOf(sveltePath: string, name: string): string {
	const source = readText(sveltePath);
	const m = source.match(/<style[^>]*>([\s\S]*?)<\/style>/);
	expect(m, `${name} に <style> ブロックがあること`).not.toBeNull();
	return stripCssComments(m![1]);
}

type Decl = { prop: string; value: string };

/**
 * CSS テキストから宣言(prop: value)だけを取り出す。
 * セレクタ(`.x:hover {`)や @media 条件(`(prefers-color-scheme: dark)`)は
 * 値の直後に `;` / `}` が来ないため一致しない(誤検出防止)。
 */
function declarationsOf(css: string): Decl[] {
	const out: Decl[] = [];
	const re = /([-\w]+)\s*:\s*([^{};]+)(?=[;}])/g;
	for (let m = re.exec(css); m !== null; m = re.exec(css)) {
		out.push({ prop: m[1], value: m[2].trim() });
	}
	return out;
}

/** 宣言値を空白・カンマ・括弧・引用符で分割したトークン列(名前色検査用)。 */
function valueTokens(value: string): string[] {
	return value.split(/[\s,()/'"]+/).filter((t) => t.length > 0);
}

/** #abc / #abcd / #aabbccff を 6桁小文字 #aabbcc に正規化する(不透明のみ)。 */
function normalizeHex(hex: string): string {
	let h = hex.slice(1).toLowerCase();
	if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
	if (h.length === 8 && h.endsWith('ff')) h = h.slice(0, 6);
	return `#${h}`;
}

function themeCss(): string {
	return existsSync(THEME_CSS_PATH) ? stripCssComments(readText(THEME_CSS_PATH)) : '';
}

/** theme.css で定義されている custom property 宣言(--xxx: 値)。 */
function themeCustomProps(): Decl[] {
	return declarationsOf(themeCss()).filter((d) => d.prop.startsWith('--'));
}

// ---------------------------------------------------------------------------
// (a) theme.css — 共通パレットの定義
// ---------------------------------------------------------------------------

describe('契約(a): src/styles/theme.css に共通パレットを定義する', () => {
	test('theme.css が存在する', () => {
		expect(existsSync(THEME_CSS_PATH), `src/styles/theme.css が存在すること`).toBe(true);
	});

	test(':root ブロックで CSS custom properties を定義している(markdown.css の流儀)', () => {
		const css = themeCss();
		const rootBodies = [...css.matchAll(/:root[^{]*\{([^}]*)\}/g)].map((m) => m[1]);
		expect(rootBodies.length, ':root ブロックがあること').toBeGreaterThan(0);
		const propsInRoot = declarationsOf(rootBodies.join('\n')).filter((d) =>
			d.prop.startsWith('--'),
		);
		expect(propsInRoot.length, ':root 内に --xxx: 値 の定義があること').toBeGreaterThan(0);
	});

	test('現状の配色(RootPicker/Explorer/ExplorerItem で使用中の全 hex 値)が変数定義値として現れる', () => {
		const defined = new Set(
			themeCustomProps().flatMap((d) => (d.value.match(HEX_RE_G) ?? []).map(normalizeHex)),
		);
		const missing = REQUIRED_PALETTE_HEXES.filter((hex) => !defined.has(hex));
		expect(missing, 'theme.css の変数定義に現れない現行色').toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// (b) 直書き色の撤廃(hex/色関数/名前色)
// ---------------------------------------------------------------------------

describe('契約(b): RootPicker/Explorer/ExplorerItem の <style> から色リテラルを撤廃する', () => {
	for (const target of COMPONENT_TARGETS) {
		test(`${target.name}: hex 色リテラル(#xxx)が残っていない`, () => {
			const decls = declarationsOf(styleBlockOf(target.path, target.name));
			const offenders = decls
				.filter((d) => HEX_RE.test(d.value))
				.map((d) => `${d.prop}: ${d.value}`);
			expect(offenders, `${target.name} に残る hex 直書き宣言`).toEqual([]);
		});

		test(`${target.name}: rgb()/hsl() 等の色関数リテラルで回避していない`, () => {
			const decls = declarationsOf(styleBlockOf(target.path, target.name));
			const offenders = decls
				.filter((d) => COLOR_FUNCTION_RE.test(d.value))
				.map((d) => `${d.prop}: ${d.value}`);
			expect(offenders, `${target.name} に残る色関数リテラル宣言`).toEqual([]);
		});

		test(`${target.name}: 名前色(white 等)で回避していない`, () => {
			const decls = declarationsOf(styleBlockOf(target.path, target.name));
			const offenders = decls
				.filter((d) => valueTokens(d.value).some((t) => NAMED_COLORS.has(t.toLowerCase())))
				.map((d) => `${d.prop}: ${d.value}`);
			expect(offenders, `${target.name} に残る名前色宣言`).toEqual([]);
		});
	}
});

// ---------------------------------------------------------------------------
// (c) var(--…) 参照への置換と theme.css への集約
// ---------------------------------------------------------------------------

describe('契約(c): 色は var(--…) 参照とし、参照先はすべて theme.css で定義されている', () => {
	for (const target of COMPONENT_TARGETS) {
		test(`${target.name}: var(--…) を参照し、参照変数はすべて theme.css の定義に載っている`, () => {
			const style = styleBlockOf(target.path, target.name);
			const referenced = [...style.matchAll(/var\(\s*(--[-\w]+)/g)].map((m) => m[1]);
			expect(
				referenced.length,
				`${target.name} の <style> に var(--…) 参照があること`,
			).toBeGreaterThan(0);

			const definedNames = new Set(themeCustomProps().map((d) => d.prop));
			const undefinedRefs = [...new Set(referenced)].filter((n) => !definedNames.has(n));
			expect(undefinedRefs, `theme.css に定義がない参照変数`).toEqual([]);
		});
	}
});

// ---------------------------------------------------------------------------
// (d) theme.css の読み込み配線
// ---------------------------------------------------------------------------

describe('契約(d): theme.css がアプリの読み込み経路に乗っている', () => {
	test('+page.svelte / +layout / app.css のいずれかが theme.css を import している', () => {
		const candidates = [
			{ path: resolve(REPO_ROOT, 'src/routes/+page.svelte'), kind: 'js' },
			{ path: resolve(REPO_ROOT, 'src/routes/+layout.svelte'), kind: 'js' },
			{ path: resolve(REPO_ROOT, 'src/routes/+layout.ts'), kind: 'js' },
			{ path: resolve(REPO_ROOT, 'src/styles/app.css'), kind: 'css' },
		] as const;

		const importers = candidates
			.filter((c) => existsSync(c.path))
			.filter((c) => {
				const source = readText(c.path);
				return c.kind === 'css'
					? /@import\s+(?:url\(\s*)?['"]?[^'")]*theme\.css/.test(stripCssComments(source))
					: /import\s+['"][^'"]*theme\.css['"]/.test(source);
			})
			.map((c) => c.path);

		expect(
			importers.length,
			'theme.css を import する読み込み経路(+page.svelte / +layout.svelte / +layout.ts / app.css の @import)が少なくとも1つあること',
		).toBeGreaterThan(0);
	});
});
