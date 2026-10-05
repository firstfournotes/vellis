/**
 * 要件#38 追補d の受け入れテスト(docs/requirements/req-38.md「追補d」・backlog 242)
 * 「編集中の外部変更の帯・構造変化の通知が紙に載りうる」— AC-38-追d
 *
 * 発見(2026-10-01): 追補c(backlog 237)の reviewer P2。`Viewer.svelte` の
 * `article.viewer` の中・`.markdown-body` の兄弟に、編集中に外部変更が届いたことを
 * 知らせる帯 `div.external-change`(要件#48 契約⑥・Overwrite / Reload のボタン付き)と、
 * HTML のレンダリング済み編集で構造の変わった編集を戻したことを知らせる
 * `div.structure-notice`(要件#53 契約④)があり、どちらも `print.css` の隠す一覧に無い。
 *
 * 契約(追補d): markdown / text の印刷(メインフレーム印刷=契約④の `'main-frame'`
 * 経路)では、`.external-change` と `.structure-notice` は出ていても紙に載らない。
 * 追補c と同じく `print.css` の `@media print` で隠す。ただし
 *   1. 隠す規則は本文(`.markdown-body`)の中の要素には当たらない(文書の HTML が
 *      同じクラス名を持っていても本文は紙に載る。セレクタの書き方は実装裁量)
 *   2. 既存の隠す規則(AC-64-21・AC-38-追c が固定しているもの)・本文の体裁・倍率・
 *      印刷窓の経路は不変(それらは既存テストが無改変で緑のまま判定する)
 *
 * ## 判定の仕方(AC-38-追d・AC-38-追c と同じ=print.css の規則を JSDOM の DOM に当てる)
 *
 * 1. `src/styles/print.css` の `@media print { … }` スコープの中で `display: none`
 *    (`!important` 付きも可)を宣言する規則のセレクタを集める(セレクタリストは
 *    `:not(a, b)` の中のカンマで割らないよう、括弧の外のカンマだけで分ける)。
 *    `@page` などの at-rule はセレクタではないので集めない
 * 2. アプリの実際の入れ子を再現した DOM を JSDOM で組む(入れ子の根拠は下の
 *    `buildAppDom` のコメント=ファイル:行)
 * 3. 要素ごとに、自身と祖先を `Element.matches` で集めたセレクタに当てる
 *    - (a) `article.viewer` の中・`.markdown-body` の兄弟に置いた `div.external-change`
 *      と `div.structure-notice`: 自身か祖先のどれかが当たる(2 件)
 *    - (b) `.markdown-body` の中に置いた同名クラスの要素(根と同じタグ): 自身も
 *      祖先も当たらない(直下と、さらに一段入れ子にした置き方の両方)(2 件)
 *    - (c) 判定器の最小の自己検査: 実物の print.css から既存の隠す規則(AC-64-21 と
 *      AC-38-追c の対象)が集まる=収集が空振りしていない
 * 4. セレクタを jsdom のセレクタエンジン(jsdom 29 は @asamuzakjp/dom-selector)が
 *    解釈できず `matches` が例外を投げたら、それは**失敗**(黙って飛ばさない)。
 *    隠す規則は jsdom で検査できる書き方にすること
 *
 * CSS のヘルパ(stripCssComments / printMediaContents / declarationsOf / rulesOf /
 * splitSelectorList / printHidingSelectors)と DOM のヘルパ(hidingHit ほか)は
 * `print-transient-ui.acceptance.test.ts`(AC-38-追c)と同じ作り。既存テストは改変
 * しない(export を足さない)ので、本ファイルに同等のものを持つ。
 *
 * 実行環境: vitest の unit プロジェクトは `environment: 'jsdom'`(vitest.config.ts)
 * なので `document` が使える。念のため下の directive でも明示する。
 *
 * @vitest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');
const PRINT_CSS_PATH = resolve(REPO_ROOT, 'src/styles/print.css');

// ---------------------------------------------------------------------------
// CSS のヘルパ(print-transient-ui.acceptance.test.ts / print-side-panes.acceptance.test.ts と同じ家風)
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

/**
 * 宣言ブロックの中身(`rulesOf` が `{`/`}` を除いて渡す)を宣言に分ける。
 * 最後の宣言は `;` 無しで書かれることがある(`.x { display: none }`)ので、
 * `;`・`}` に加えて文字列の終わりでも区切る(`(?=[;}]|$)`)。値は trim する
 * ので末尾の空白・改行は残らない。
 */
function declarationsOf(css: string): Decl[] {
	const out: Decl[] = [];
	const re = /([-\w]+)\s*:\s*([^{};]+)(?=[;}]|$)/g;
	for (let m = re.exec(css); m !== null; m = re.exec(css)) {
		out.push({ prop: m[1], value: m[2].trim() });
	}
	return out;
}

type Rule = { selector: string; body: string };

/**
 * スコープの中身を規則(セレクタ+宣言ブロック)に分ける。
 * ネストした at-rule(`@supports` 等)の中身は規則として平たく拾い、
 * at-rule 自身(`@page` 等)はセレクタとして数えない。
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

function isDisplayNone(d: Decl): boolean {
	return d.prop.toLowerCase() === 'display' && /^none(\s*!important)?$/i.test(d.value);
}

/**
 * セレクタリストを個々のセレクタに分ける。`:not(a, b)` / `:is(a, b)` /
 * `[attr="a,b"]` の中のカンマでは割らない(括弧の深さ 0 のカンマだけで分ける)。
 */
function splitSelectorList(list: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let cur = '';
	for (const ch of list) {
		if (ch === '(' || ch === '[') depth += 1;
		else if (ch === ')' || ch === ']') depth -= 1;
		if (ch === ',' && depth === 0) {
			out.push(cur);
			cur = '';
		} else {
			cur += ch;
		}
	}
	out.push(cur);
	return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** `@media print` の中で `display: none` を宣言する規則のセレクタ(個々)をすべて集める。 */
function printHidingSelectors(css: string): string[] {
	const contents = printMediaContents(stripCssComments(css));
	return rulesOf(contents)
		.filter((r) => declarationsOf(r.body).some(isDisplayNone))
		.flatMap((r) => splitSelectorList(r.selector));
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
// DOM に当てるヘルパ
// ---------------------------------------------------------------------------

function describeElement(el: Element): string {
	const cls = Array.from(el.classList)
		.map((c) => `.${c}`)
		.join('');
	return `${el.tagName.toLowerCase()}${cls}`;
}

/**
 * `Element.matches` を呼ぶ。jsdom のセレクタエンジンがセレクタを解釈できず例外を投げたら、
 * それを飛ばさずに失敗として投げ直す(判定の仕方 4)。
 */
function matchesOrThrow(el: Element, selector: string): boolean {
	try {
		return el.matches(selector);
	} catch (e) {
		throw new Error(
			`print.css の隠す規則のセレクタ「${selector}」を jsdom が解釈できない(${String(e)})。` +
				'隠す規則は jsdom で検査できる書き方にすること',
		);
	}
}

type Hit = { element: string; selector: string };

/**
 * 要素自身とその祖先(document.documentElement まで)を順に、集めたセレクタに
 * `matches` で当てる。最初に当たった(要素, セレクタ)を返す。当たらなければ null。
 */
function hidingHit(el: Element, selectors: string[]): Hit | null {
	for (let node: Element | null = el; node !== null; node = node.parentElement) {
		for (const selector of selectors) {
			if (matchesOrThrow(node, selector)) {
				return { element: describeElement(node), selector };
			}
		}
	}
	return null;
}

function el(tag: string, className: string, parent: Node): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	parent.appendChild(node);
	return node;
}

type AppDom = {
	externalChange: HTMLElement;
	structureNotice: HTMLElement;
	markdownBody: HTMLElement;
};

/**
 * アプリの実際の入れ子を再現する(document.body を空にしてから組む)。
 * `print-transient-ui.acceptance.test.ts`(AC-38-追c)の `buildAppDom` と同じ入れ子に、
 * 追補d の 2 要素を `Viewer.svelte` の実物の位置へ足したもの。
 * タグ・クラスは根の要素の実物どおり。根拠(ファイル:行)=
 *
 * src/routes/+page.svelte
 *   1268  <div class="app">
 *   1269-1276   {#if updateBanner} <UpdateBanner/>          … .app の直下・.app-body の前
 *   1277        <div class="app-body">
 *   1304-1329     <div class="explorer-pane">
 *   1309            <Explorer/>                              … aside.explorer(Explorer.svelte:122-127)
 *   1335-1346     <div class="pane-divider">
 *   1353          <div class="viewer-stack">
 *   1363            <div class="viewer-main">
 *   1468              <Viewer/>                              … Viewer.svelte を展開
 *   1504        <StatusBar/>
 *   1505  </div>                                             … ここまで .app
 *
 * src/components/Viewer.svelte
 *   1517  <article class="viewer">
 *   1518  <header class="viewer-toolbar">                    … 1575 </header>
 *   1576-1591  {#if findOpen} <FindBar/>                    … header の後(兄弟)
 *   1592-1620  {#if windowState.externalChange !== null}
 *   1597         <div class="external-change" data-testid="external-change-banner" role="alert">
 *                                                           … 要件#48 契約⑥。FindBar の後・.markdown-body の前(兄弟)
 *   1621-1629  {#if htmlStructureNotice !== null}
 *   1626         <div class="structure-notice" data-testid="htmledit-structure-notice" role="status">
 *                                                           … 要件#53 契約④。external-change の後・.markdown-body の前(兄弟)
 *   1646-1653  <div class="markdown-body">
 *
 * src/components/FindBar.svelte  64  <div class="find-bar find-bar--sticky">
 */
function buildAppDom(): AppDom {
	document.body.innerHTML = '';
	const body = document.body;

	const app = el('div', 'app', body);
	el('div', 'update-banner', app);
	const appBody = el('div', 'app-body', app);

	const explorerPane = el('div', 'explorer-pane', appBody);
	el('aside', 'explorer', explorerPane);

	el('div', 'pane-divider', appBody);

	const viewerStack = el('div', 'viewer-stack', appBody);
	const viewerMain = el('div', 'viewer-main', viewerStack);
	const viewer = el('article', 'viewer', viewerMain);
	el('header', 'viewer-toolbar', viewer);
	el('div', 'find-bar find-bar--sticky', viewer);
	const externalChange = el('div', 'external-change', viewer);
	externalChange.setAttribute('data-testid', 'external-change-banner');
	externalChange.setAttribute('role', 'alert');
	el('span', 'external-change-text', externalChange);
	const structureNotice = el('div', 'structure-notice', viewer);
	structureNotice.setAttribute('data-testid', 'htmledit-structure-notice');
	structureNotice.setAttribute('role', 'status');
	const markdownBody = el('div', 'markdown-body', viewer);

	el('div', 'status-bar', app);

	return { externalChange, structureNotice, markdownBody };
}

// ---------------------------------------------------------------------------
// AC-38-追d (c) — 判定器の最小の自己検査(収集が空振りして (b) が緑になるのを防ぐ)
// ---------------------------------------------------------------------------

describe('print.css 検査の判定器(AC-38-追d の判定が甘くないこと)', () => {
	test('(c) 実物の print.css から既存の隠す規則(AC-64-21・AC-38-追c の対象)が集まる=収集が空振りしていない', () => {
		const selectors = printHidingSelectors(readPrintCss());
		for (const existing of ['.explorer', '.explorer-pane', '.viewer-toolbar', '.status-bar']) {
			expect(selectors, `既存の隠す規則 ${existing}(AC-64-21)が集まること`).toContain(existing);
		}
		// 追補c の規則は `:not(.markdown-body *)` 付き。括弧の中のカンマで割れていないことも兼ねて確かめる
		expect(
			selectors.some((s) => /^\.find-bar\b/.test(s)),
			`追補c の隠す規則 .find-bar… が集まること(集めたセレクタ: ${JSON.stringify(selectors)})`,
		).toBe(true);
		for (const s of selectors) {
			expect(s, 'セレクタの括弧が閉じていること(リストの分け方が壊れていない)').not.toMatch(/\([^)]*$/);
		}
	});

	test('(c) 自身か祖先が当たれば hit・どれも当たらなければ null・解釈できないセレクタは例外', () => {
		document.body.innerHTML = '<div class="outer"><div class="inner"></div></div>';
		const inner = document.querySelector('.inner') as Element;
		expect(hidingHit(inner, ['.outer'])).toEqual({ element: 'div.outer', selector: '.outer' });
		expect(hidingHit(inner, ['.inner'])).toEqual({ element: 'div.inner', selector: '.inner' });
		expect(hidingHit(inner, ['.nope'])).toBeNull();
		expect(() => hidingHit(inner, ['.a['])).toThrow(/解釈できない/);
	});
});

// ---------------------------------------------------------------------------
// AC-38-追d (a) — article.viewer の中・.markdown-body の兄弟の 2 要素は自身か祖先が隠す規則に当たる
// ---------------------------------------------------------------------------

type RootCase = [shape: string, what: string, key: keyof AppDom];

const ROOT_CASES: RootCase[] = [
	[
		'div.external-change',
		'編集中の外部変更の帯(要件#48 契約⑥・Viewer.svelte:1597・article.viewer の中・.markdown-body の兄弟)',
		'externalChange',
	],
	[
		'div.structure-notice',
		'構造変化の通知(要件#53 契約④・Viewer.svelte:1626・article.viewer の中・.markdown-body の兄弟)',
		'structureNotice',
	],
];

describe('print.css — 編集中の帯・通知は紙に載らない(要件#38 追補d・AC-38-追d (a))', () => {
	test.each(ROOT_CASES)(
		'(a) %s は自身か祖先が @media print の display: none に当たる(%s)',
		(shape, what, key) => {
			const dom = buildAppDom();
			const selectors = printHidingSelectors(readPrintCss());
			const hit = hidingHit(dom[key], selectors);
			expect(
				hit,
				`${shape}(${what})の自身か祖先が、@media print で display: none を宣言する規則のどれかに当たること。` +
					`集めたセレクタ: ${JSON.stringify(selectors)}`,
			).not.toBeNull();
		},
	);
});

// ---------------------------------------------------------------------------
// AC-38-追d (b) — 本文(.markdown-body)の中の同名クラスは隠れない
// ---------------------------------------------------------------------------

type BodyCase = [tag: string, className: string];

const BODY_CASES: BodyCase[] = [
	['div', 'external-change'],
	['div', 'structure-notice'],
];

describe('print.css — 本文の中の同名クラスは紙に載る(要件#38 追補d・AC-38-追d (b))', () => {
	test.each(BODY_CASES)(
		'(b) .markdown-body の中の <%s class="%s"> は自身も祖先も隠す規則に当たらない',
		(tag, className) => {
			const dom = buildAppDom();
			const selectors = printHidingSelectors(readPrintCss());

			// .markdown-body の直下
			const direct = el(tag, className, dom.markdownBody);
			const hitDirect = hidingHit(direct, selectors);
			expect(
				hitDirect,
				`.markdown-body 直下の ${describeElement(direct)} が隠れないこと(当たった: ${JSON.stringify(hitDirect)})`,
			).toBeNull();

			// さらに一段入れ子(文書の HTML が包んでいる場合)
			const wrapper = el('div', 'doc-wrapper', dom.markdownBody);
			const nested = el(tag, className, wrapper);
			const hitNested = hidingHit(nested, selectors);
			expect(
				hitNested,
				`.markdown-body の中で一段包まれた ${describeElement(nested)} が隠れないこと(当たった: ${JSON.stringify(hitNested)})`,
			).toBeNull();
		},
	);
});
