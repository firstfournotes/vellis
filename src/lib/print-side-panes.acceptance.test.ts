/**
 * 要件#64 追補d の受け入れテスト(docs/requirements/req-64.md「追補d」・backlog 225)
 * 「印刷の紙に RECENT FILES が載る回帰」— print.css のソース検査(AC-64-21)
 *
 * 発見(2026-10-01): markdown / text を ⌘P で印刷すると、紙の 1 ページ目の先頭に
 * RECENT FILES の一覧が載る。`print.css`(issue 21 由来)は画面の飾りを `.explorer`
 * などのクラスで隠しているが、Recent Files の区画 `section.recent-files` は
 * `aside.explorer` の**外**(兄弟)にあるので `.explorer { display: none }` が
 * 効かない。左ペインの器 `.explorer-pane`・検索パネルの器 `.find-in-folder-pane`・
 * Explorer と Viewer の仕切り `.pane-divider` も同じく隠す一覧に無い。
 *
 * 契約(追補d): markdown / text の印刷(メインフレーム印刷=要件#38 の
 * `'main-frame'` 経路)では、**左ペインの区画はどれも紙に載らない**。
 * `src/styles/print.css` の `@media print` で次をすべて `display: none` にする
 * (既存の `.explorer` / `.viewer-toolbar` / `.status-bar` / `.mark-list` /
 * `.dialog-overlay` はそのまま残す):
 *   1. `.recent-files`(区画そのもの。置き場所が変わっても隠れるよう器ではなく
 *      区画のクラスでも隠す)
 *   2. `.explorer-pane`(左ペインの器=Explorer と区画を縦に積む器)
 *   3. `.find-in-folder-pane`(検索パネルを出しているときの器=要件#55)
 *   4. `.pane-divider`(Explorer と Viewer の仕切り=要件#9)
 *
 * ## 判定の仕方(AC-64-21・ソース検査)
 *
 * - `@media print { … }` スコープの中の規則だけを見る(スコープの外にあっても
 *   数えない)
 * - 「セレクタにそのクラスを含む」= セレクタリスト(カンマ区切り)のいずれかの
 *   セレクタが **そのクラスで終わる**(例 `.recent-files` 単独・`section.recent-files`)。
 *   `.recent-files-sash` / `.recent-files-row` のような別クラスの前方一致や、
 *   `.recent-files:hover` のように擬似クラスで限定した形は数えない
 * - その規則の宣言に `display: none`(`!important` 付きも可)がある
 *
 * ヘルパ(stripCssComments / printMediaContents / declarationsOf)は
 * `zoom.acceptance.test.ts`(要件#36 契約⑦)の print.css 検査と同じ作り。
 * 既存テストは改変しないので、本ファイルに同等のものを持つ。
 *
 * 実装側(implementer)は `src/styles/print.css` の `@media print` に 4 クラスを
 * 隠す規則を足すだけでよい。本文(`.markdown-body`)の体裁・倍率の扱い
 * (要件#36 契約⑦)・HTML の印刷窓の経路(要件#38)は不変。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');
const PRINT_CSS_PATH = resolve(REPO_ROOT, 'src/styles/print.css');

// ---------------------------------------------------------------------------
// ヘルパ(zoom.acceptance.test.ts の print.css 検査と同じ家風)
// ---------------------------------------------------------------------------

function stripCssComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** `@media print { … }` スコープの中身だけを(ネストした括弧ごと)連結して返す。 */
function printMediaContents(css: string): string {
	let out = '';
	let i = 0;
	while (i < css.length) {
		const m = css.slice(i).match(/@media[^{]*\bprint\b[^{]*\{/);
		if (!m || m.index === undefined) break;
		let depth = 1;
		let j = i + m.index + m[0].length;
		const start = j;
		while (j < css.length && depth > 0) {
			if (css[j] === '{') depth += 1;
			else if (css[j] === '}') depth -= 1;
			j += 1;
		}
		out += css.slice(start, j);
		i = j;
	}
	return out;
}

type Decl = { prop: string; value: string };

function declarationsOf(css: string): Decl[] {
	const out: Decl[] = [];
	const re = /([-\w]+)\s*:\s*([^{};]+)(?=[;}])/g;
	for (let m = re.exec(css); m !== null; m = re.exec(css)) {
		out.push({ prop: m[1], value: m[2].trim() });
	}
	return out;
}

type Rule = { selector: string; body: string };

/**
 * スコープの中身を規則(セレクタ+宣言ブロック)に分ける。
 * ネストした at-rule(`@supports` 等)の中身も規則として平たく拾う。
 */
function rulesOf(css: string): Rule[] {
	const out: Rule[] = [];
	let i = 0;
	while (i < css.length) {
		const open = css.indexOf('{', i);
		if (open < 0) break;
		const selector = css.slice(i, open).trim();
		let depth = 1;
		let j = open + 1;
		while (j < css.length && depth > 0) {
			if (css[j] === '{') depth += 1;
			else if (css[j] === '}') depth -= 1;
			j += 1;
		}
		const body = css.slice(open + 1, j - 1);
		if (selector.startsWith('@')) {
			out.push(...rulesOf(body));
		} else if (selector.length > 0) {
			out.push({ selector, body });
		}
		i = j;
	}
	return out;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** セレクタリストのいずれかが `.cls` で終わるか(別クラスの前方一致・擬似クラス付きは数えない)。 */
function selectorEndsWithClass(selectorList: string, cls: string): boolean {
	const tail = new RegExp(`\\.${escapeRegExp(cls)}$`);
	return selectorList
		.split(',')
		.map((s) => s.trim())
		.some((s) => tail.test(s));
}

function isDisplayNone(d: Decl): boolean {
	return d.prop.toLowerCase() === 'display' && /^none(\s*!important)?$/i.test(d.value);
}

/** `@media print` の中に、`.cls` で終わるセレクタを持ち `display: none` を宣言する規則があるか。 */
function printHidesClass(css: string, cls: string): boolean {
	const contents = printMediaContents(stripCssComments(css));
	return rulesOf(contents).some(
		(r) => selectorEndsWithClass(r.selector, cls) && declarationsOf(r.body).some(isDisplayNone),
	);
}

function readPrintCss(): string {
	const css = readFileSync(PRINT_CSS_PATH, 'utf8');
	expect(
		printMediaContents(stripCssComments(css)).length,
		'@media print スコープがあること',
	).toBeGreaterThan(0);
	return css;
}

// ---------------------------------------------------------------------------
// 判定器の自己検査(判定が甘くて緑になるのを防ぐ・フィクスチャは文字列)
// ---------------------------------------------------------------------------

describe('print.css 検査の判定器(AC-64-21 の判定が甘くないこと)', () => {
	test('@media print の外の display: none は数えない', () => {
		const css = `.recent-files { display: none; } @media print { .explorer { display: none; } }`;
		expect(printHidesClass(css, 'recent-files')).toBe(false);
		expect(printHidesClass(css, 'explorer')).toBe(true);
	});

	test('別クラスの前方一致(.recent-files-sash / .recent-files-row)は数えない', () => {
		const css = `@media print { .recent-files-sash, .recent-files-row { display: none !important; } }`;
		expect(printHidesClass(css, 'recent-files')).toBe(false);
	});

	test('擬似クラスで限定した形(.pane-divider:hover)は数えない', () => {
		const css = `@media print { .pane-divider:hover { display: none; } }`;
		expect(printHidesClass(css, 'pane-divider')).toBe(false);
	});

	test('display: none 以外の宣言しか無い規則は数えない', () => {
		const css = `@media print { .recent-files { visibility: hidden; display: block; } }`;
		expect(printHidesClass(css, 'recent-files')).toBe(false);
	});

	test('セレクタリストの途中・要素名付き・!important 付きは数える', () => {
		const css = `@media print {
			.explorer,
			section.recent-files,
			.status-bar { display: none !important; }
		}`;
		expect(printHidesClass(css, 'recent-files')).toBe(true);
		expect(printHidesClass(css, 'explorer')).toBe(true);
		expect(printHidesClass(css, 'status-bar')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// AC-64-21 — print.css の @media print で左ペインの区画をすべて隠す
// ---------------------------------------------------------------------------

describe('print.css — 左ペインの区画は紙に載らない(要件#64 追補d・AC-64-21)', () => {
	test.each([
		['recent-files', 'Recent Files の区画そのもの'],
		['explorer-pane', '左ペインの器(Explorer と区画を縦に積む器)'],
		['find-in-folder-pane', '検索パネルを出しているときの器(要件#55)'],
		['pane-divider', 'Explorer と Viewer の仕切り(要件#9)'],
	])('@media print に .%s を display: none にする規則がある(%s)', (cls, what) => {
		expect(
			printHidesClass(readPrintCss(), cls),
			`@media print の中に、セレクタが .${cls} で終わり display: none を宣言する規則があること(${what})`,
		).toBe(true);
	});

	test('既存の .explorer / .viewer-toolbar / .status-bar / .mark-list / .dialog-overlay を隠す規則も残っている', () => {
		const css = readPrintCss();
		for (const cls of ['explorer', 'viewer-toolbar', 'status-bar', 'mark-list', 'dialog-overlay']) {
			expect(
				printHidesClass(css, cls),
				`@media print の .${cls} を display: none にする規則が残っていること`,
			).toBe(true);
		}
	});
});
