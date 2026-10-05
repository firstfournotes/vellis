/**
 * 要件#38 追補c の受け入れテスト(docs/requirements/req-38.md「追補c」・backlog 237)
 * 「開いているバー・バナー・ダイアログ・メニューが紙に載りうる」— AC-38-追c
 *
 * 発見(2026-10-01): `print.css` の `@media print` の隠す一覧に、画面に一時的に
 * 出る 6 つの部品が無い。⌘F の検索バー `FindBar`(`.find-bar`)・Go to バー
 * `GoToBar`(`.go-to-bar`)・更新のお知らせ `UpdateBanner`(`.update-banner`)・
 * 差分表示 `DiffView`(`section.diff-view` と幕 `.overlay`)・指示ダイアログ
 * `InstructionDialog`(`.dialog` と幕 `.backdrop`)・右クリックのメニュー
 * `ContextMenu`(`.context-menu`)。
 *
 * 契約(追補c): markdown / text の印刷(メインフレーム印刷=契約④の
 * `'main-frame'` 経路)では、上の 6 つの部品(幕も含む)は開いていても紙に
 * 載らない。`print.css` の `@media print` で隠す。ただし
 *   1. 隠す規則は本文(`.markdown-body`)の中の要素には当たらない(文書の HTML が
 *      同じクラス名を持っていても本文は紙に載る。セレクタの書き方は実装裁量)
 *   2. 既存の隠す規則・本文の体裁・倍率の扱い・HTML の印刷窓の経路は不変
 *
 * ## 判定の仕方(AC-38-追c・print.css の規則を JSDOM の DOM に当てる)
 *
 * 1. `src/styles/print.css` の `@media print { … }` スコープの中で `display: none`
 *    (`!important` 付きも可)を宣言する規則のセレクタを集める(セレクタリストは
 *    `:not(a, b)` の中のカンマで割らないよう、括弧の外のカンマだけで分ける)。
 *    `@page` などの at-rule はセレクタではないので集めない
 * 2. アプリの実際の入れ子を再現した DOM を JSDOM で組む(入れ子の根拠は下の
 *    `buildAppDom` のコメント=ファイル:行)
 * 3. 要素ごとに、自身と祖先を `Element.matches` で集めたセレクタに当てる
 *    - (a) 6 部品の根の要素(幕も含めて 8 要素): 自身か祖先のどれかが当たる
 *    - (b) `.markdown-body` の中に置いた同名クラスの要素(根と同じタグ): 自身も
 *      祖先も当たらない(直下と、さらに一段入れ子にした置き方の両方)
 *    - (c) 回帰防止: `.markdown-body` 自身と、その中の普通の段落は当たらない
 * 4. セレクタを jsdom のセレクタエンジン(jsdom 29 は @asamuzakjp/dom-selector)が解釈できず `matches` が例外を投げたら、それは
 *    **失敗**(黙って飛ばさない)。隠す規則は jsdom で検査できる書き方にすること
 *
 * CSS のヘルパ(stripCssComments / printMediaContents / declarationsOf / rulesOf)は
 * `print-side-panes.acceptance.test.ts`(AC-64-21)と同じ作り。既存テストは改変
 * しないので、本ファイルに同等のものを持つ。
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
// CSS のヘルパ(print-side-panes.acceptance.test.ts / zoom.acceptance.test.ts と同じ家風)
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
	updateBanner: HTMLElement;
	contextMenu: HTMLElement;
	goToBar: HTMLElement;
	findBar: HTMLElement;
	markdownBody: HTMLElement;
	backdrop: HTMLElement;
	dialog: HTMLElement;
	overlay: HTMLElement;
	diffView: HTMLElement;
};

/**
 * アプリの実際の入れ子を再現する(document.body を空にしてから組む)。
 * タグ・クラスは各部品の根の要素の実物どおり。根拠(ファイル:行)=
 *
 * src/routes/+page.svelte
 *   1268  <div class="app">
 *   1269-1276   {#if updateBanner} <UpdateBanner/>          … .app の直下・.app-body の前
 *   1277        <div class="app-body">
 *   1304-1329     <div class="explorer-pane">
 *   1309            <Explorer/>                              … Explorer.svelte を展開
 *   1335-1346     <div class="pane-divider">
 *   1353          <div class="viewer-stack">
 *   1354-1362       {#if goToOpen} <GoToBar/>                … .viewer-stack の直下・.viewer-main の前
 *   1363            <div class="viewer-main">
 *   1468              <Viewer/>                              … Viewer.svelte を展開
 *   1504        <StatusBar/>
 *   1505  </div>                                             … ここまで .app
 *   1507-1512  <InstructionDialog/>                          … .app の外(兄弟)
 *   1514-1519  <DiffView/>                                   … .app の外(兄弟)
 *
 * src/components/Explorer.svelte
 *   122-127  <aside class="explorer">
 *   173      </aside>
 *   180      <ContextMenu/>                                  … aside.explorer の兄弟=.explorer-pane の子
 *
 * src/components/ContextMenu.svelte
 *   144-153  <div class="context-menu">                      … position: fixed(176-177)。DOM 上は上の位置
 *
 * src/components/Viewer.svelte
 *   1517  <article class="viewer">
 *   1518  <header class="viewer-toolbar">
 *   1576-1591  {#if findOpen} <FindBar/>                    … header の後・.markdown-body の前(兄弟)
 *   1646-1653  <div class="markdown-body">
 *
 * src/components/FindBar.svelte        64   <div class="find-bar find-bar--sticky">
 * src/components/GoToBar.svelte        80   <div class="go-to-bar">
 * src/components/UpdateBanner.svelte   30   <div class="update-banner">
 * src/components/DiffView.svelte       119  <div class="overlay">      120-121  <section class="diff-view">
 * src/components/InstructionDialog.svelte  51  <div class="backdrop">  52  <div class="dialog">
 */
function buildAppDom(): AppDom {
	document.body.innerHTML = '';
	const body = document.body;

	const app = el('div', 'app', body);
	const updateBanner = el('div', 'update-banner', app);
	const appBody = el('div', 'app-body', app);

	const explorerPane = el('div', 'explorer-pane', appBody);
	el('aside', 'explorer', explorerPane);
	const contextMenu = el('div', 'context-menu', explorerPane);

	el('div', 'pane-divider', appBody);

	const viewerStack = el('div', 'viewer-stack', appBody);
	const goToBar = el('div', 'go-to-bar', viewerStack);
	const viewerMain = el('div', 'viewer-main', viewerStack);
	const viewer = el('article', 'viewer', viewerMain);
	el('header', 'viewer-toolbar', viewer);
	const findBar = el('div', 'find-bar find-bar--sticky', viewer);
	const markdownBody = el('div', 'markdown-body', viewer);

	el('div', 'status-bar', app);

	const backdrop = el('div', 'backdrop', body);
	const dialog = el('div', 'dialog', body);
	const overlay = el('div', 'overlay', body);
	const diffView = el('section', 'diff-view', body);

	return {
		updateBanner,
		contextMenu,
		goToBar,
		findBar,
		markdownBody,
		backdrop,
		dialog,
		overlay,
		diffView,
	};
}

// ---------------------------------------------------------------------------
// 判定器の自己検査(判定が甘くて緑になるのを防ぐ・フィクスチャは文字列)
// ---------------------------------------------------------------------------

describe('print.css 検査の判定器(AC-38-追c の判定が甘くないこと)', () => {
	test('@media print の外の display: none は集めない', () => {
		const css = `.find-bar { display: none; } @media print { .explorer { display: none; } }`;
		expect(printHidingSelectors(css)).toEqual(['.explorer']);
	});

	test('display: none 以外の宣言しか無い規則は集めない', () => {
		const css = `@media print { .find-bar { visibility: hidden; display: block; } .x { display: none } }`;
		expect(printHidingSelectors(css)).toEqual(['.x']);
	});

	test('最後の宣言が ; 無し・末尾に空白や改行があっても display: none を拾う(値は trim)', () => {
		const css = `@media print {\n\t.a {\n\t\tdisplay: none !important \n\t}\n\t.b { display: none }\n}`;
		expect(printHidingSelectors(css)).toEqual(['.a', '.b']);
		expect(declarationsOf('display: none !important \n')).toEqual([
			{ prop: 'display', value: 'none !important' },
		]);
	});

	test('セレクタリストは括弧の外のカンマで分け、:not(a, b) の中のカンマでは割らない', () => {
		const css = `@media print {
			.explorer,
			section.diff-view:not(.markdown-body .diff-view, .x),
			.status-bar { display: none !important; }
		}`;
		expect(printHidingSelectors(css)).toEqual([
			'.explorer',
			'section.diff-view:not(.markdown-body .diff-view, .x)',
			'.status-bar',
		]);
	});

	test('@page などの at-rule はセレクタとして集めない(中の規則は拾う)', () => {
		const css = `@media print { @supports (display: grid) { .a { display: none; } } } @page { margin: 16mm; }`;
		expect(printHidingSelectors(css)).toEqual(['.a']);
	});

	test('jsdom が解釈できないセレクタは例外=失敗(黙って飛ばさない)', () => {
		document.body.innerHTML = '<div class="a"></div>';
		const target = document.body.firstElementChild as Element;
		expect(() => hidingHit(target, ['.a['])).toThrow(/解釈できない/);
	});

	test('自身か祖先が当たれば hit・どれも当たらなければ null', () => {
		document.body.innerHTML = '<div class="outer"><div class="inner"></div></div>';
		const inner = document.querySelector('.inner') as Element;
		expect(hidingHit(inner, ['.outer'])).toEqual({ element: 'div.outer', selector: '.outer' });
		expect(hidingHit(inner, ['.inner'])).toEqual({ element: 'div.inner', selector: '.inner' });
		expect(hidingHit(inner, ['.nope'])).toBeNull();
	});

	test('実物の print.css から既存の隠す規則(AC-64-21 の対象)が集まる=収集が空振りしていない', () => {
		const selectors = printHidingSelectors(readPrintCss());
		for (const existing of ['.explorer', '.explorer-pane', '.viewer-toolbar', '.status-bar', '.dialog-overlay']) {
			expect(selectors, `既存の隠す規則 ${existing} が集まること`).toContain(existing);
		}
	});
});

// ---------------------------------------------------------------------------
// AC-38-追c (a) — 6 部品の根の要素(幕を含む 8 要素)は自身か祖先が隠す規則に当たる
// ---------------------------------------------------------------------------

type RootCase = [shape: string, what: string, key: keyof AppDom];

const ROOT_CASES: RootCase[] = [
	['div.find-bar', '⌘F の検索バー FindBar(article.viewer の中・header.viewer-toolbar の兄弟)', 'findBar'],
	['div.go-to-bar', 'Go to バー GoToBar(.viewer-stack の直下・要件#60)', 'goToBar'],
	['div.update-banner', '更新のお知らせ UpdateBanner(.app の直下・要件#14)', 'updateBanner'],
	['div.overlay', '差分表示 DiffView の幕(.app の外)', 'overlay'],
	['section.diff-view', '差分表示 DiffView の本体(.app の外)', 'diffView'],
	['div.backdrop', '指示ダイアログ InstructionDialog の幕(.app の外)', 'backdrop'],
	['div.dialog', '指示ダイアログ InstructionDialog の本体(.app の外)', 'dialog'],
	['div.context-menu', '右クリックのメニュー ContextMenu(.explorer-pane の中・aside.explorer の兄弟)', 'contextMenu'],
];

describe('print.css — 開いている部品は紙に載らない(要件#38 追補c・AC-38-追c (a))', () => {
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
// AC-38-追c (b) — 本文(.markdown-body)の中の同名クラスは隠れない
// ---------------------------------------------------------------------------

type BodyCase = [tag: string, className: string];

const BODY_CASES: BodyCase[] = [
	['div', 'dialog'],
	['div', 'overlay'],
	['div', 'backdrop'],
	['section', 'diff-view'],
	['div', 'find-bar find-bar--sticky'],
	['div', 'go-to-bar'],
	['div', 'update-banner'],
	['div', 'context-menu'],
];

describe('print.css — 本文の中の同名クラスは紙に載る(要件#38 追補c・AC-38-追c (b))', () => {
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

// ---------------------------------------------------------------------------
// AC-38-追c (c) — 回帰防止: 本文そのものは隠れない
// ---------------------------------------------------------------------------

describe('print.css — 本文そのものは紙に載る(要件#38 追補c・AC-38-追c (c) 回帰防止)', () => {
	test('(c) .markdown-body 自身は自身も祖先も隠す規則に当たらない', () => {
		const dom = buildAppDom();
		const selectors = printHidingSelectors(readPrintCss());
		const hit = hidingHit(dom.markdownBody, selectors);
		expect(hit, `.markdown-body が隠れないこと(当たった: ${JSON.stringify(hit)})`).toBeNull();
	});

	test('(c) .markdown-body の中の普通の段落は自身も祖先も隠す規則に当たらない', () => {
		const dom = buildAppDom();
		const selectors = printHidingSelectors(readPrintCss());
		const p = el('p', '', dom.markdownBody);
		p.textContent = '本文の段落';
		const hit = hidingHit(p, selectors);
		expect(hit, `本文の段落が隠れないこと(当たった: ${JSON.stringify(hit)})`).toBeNull();
	});
});
