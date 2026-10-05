/**
 * 要件#38 追補e の受け入れテスト(docs/requirements/req-38.md「追補e」・backlog 243)
 * 「履歴選択画面・空の状態の文言が紙に載りうる」— AC-38-追e
 *
 * 発見(2026-10-01): 追補c(backlog 237)の reviewer P3。`print.css` の隠す一覧に、
 * 履歴選択画面 `RootPicker`(`div.root-picker`・`+page.svelte` の `.app-body` の直下)と、
 * 文書が無いときの案内 `EmptyState`(`div.empty-state`・`.viewer-main` の中)が無い。
 * 履歴選択画面は文書と同時には出ないが `.viewer-stack` の外側の条件分岐の中にあるので、
 * 開いたまま印刷すると「Vellis / Choose a folder to open / 履歴」が紙に載る。
 * 空の状態で印刷すると「Vellis / vX.Y.Z / Select a file」が紙に出る。
 *
 * あわせて、追補c・追補d の受け入れテストは DOM で SvelteKit の app.html の包み
 * (`<div style="display: contents">`=src/app.html:11)を省いている。将来 `body > .dialog`
 * のような親子関係で絞る書き方に変わると、包みの無い DOM では当たって偽の緑になる。
 * 本ファイルは**包みありの DOM**で、追補c・追補d の部品も検査する。
 *
 * 契約(追補e): markdown / text の印刷(メインフレーム印刷=契約④の `'main-frame'`
 * 経路)では、`.root-picker` と `.empty-state` も紙に載らない。追補c と同じく
 * `print.css` の `@media print` で隠す。ただし
 *   1. 隠す規則は本文(`.markdown-body`)の中の要素には当たらない(文書の HTML が
 *      同じクラス名を持っていても本文は紙に載る。セレクタの書き方は実装裁量)
 *   2. 既存の隠す規則(AC-64-21・AC-38-追c・AC-38-追d が固定しているもの)・本文の体裁・
 *      倍率・印刷窓の経路は不変(それらは既存テストが無改変で緑のまま判定する)
 *
 * ## 判定の仕方(AC-38-追e・AC-38-追c と同じ=print.css の規則を JSDOM の DOM に当てる)
 *
 * 1. `src/styles/print.css` の `@media print { … }` スコープの中で `display: none`
 *    (`!important` 付きも可)を宣言する規則のセレクタを集める(セレクタリストは
 *    `:not(a, b)` の中のカンマで割らないよう、括弧の外のカンマだけで分ける)。
 *    `@page` などの at-rule はセレクタではないので集めない
 * 2. アプリの実際の入れ子を再現した DOM を JSDOM で組む(入れ子の根拠は下の
 *    `buildAppDom` のコメント=ファイル:行)。**`body` と `.app` の間に app.html の包み
 *    `<div style="display: contents">` を入れる**(追補c・追補d のテストとの違い)。
 *    履歴選択画面・空の状態・文書表示は同時には出ないので、`mode` で 3 通りの DOM を組む
 * 3. 要素ごとに、自身と祖先を `Element.matches` で集めたセレクタに当てる
 *    - (a) `div.root-picker`(mode 'root-picker')と `div.empty-state`(mode 'empty'):
 *      自身か祖先のどれかが当たる(2 件)
 *    - (b) `.markdown-body` の中に置いた同名クラスの要素(根と同じタグ): 自身も
 *      祖先も当たらない(直下と、さらに一段入れ子にした置き方の両方)(2 件)
 *    - (c) 包みありの DOM(mode 'viewer')で、追補c・追補d の部品 9 要素(検索バー・
 *      Go to バー・更新のお知らせ・差分表示の幕と本体・指示ダイアログの幕と本体・
 *      外部変更の帯・構造変化の通知)も自身か祖先が当たる(9 件)
 * 4. セレクタを jsdom のセレクタエンジン(jsdom 29 は @asamuzakjp/dom-selector)が
 *    解釈できず `matches` が例外を投げたら、それは**失敗**(黙って飛ばさない)。
 *    隠す規則は jsdom で検査できる書き方にすること
 *
 * CSS のヘルパ(stripCssComments / printMediaContents / declarationsOf / rulesOf /
 * splitSelectorList / printHidingSelectors)と DOM のヘルパ(hidingHit ほか)は
 * `print-transient-ui.acceptance.test.ts`(AC-38-追c)・`print-edit-notices.acceptance.test.ts`
 * (AC-38-追d)と同じ作り。既存テストは改変しない(export を足さない)ので、本ファイルに
 * 同等のものを持つ。
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
// CSS のヘルパ(print-transient-ui / print-edit-notices / print-side-panes の各 acceptance と同じ家風)
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

/**
 * `+page.svelte` の `.app-body` の中は 3 通りの状態のどれか 1 つ(同時には出ない)。
 * - 'root-picker': `rootPicker.open`=履歴選択画面だけ(+page.svelte:1278-1284)
 * - 'empty':       文書なし=`.viewer-main` の中が `<EmptyState/>`(+page.svelte:1487-1488)
 * - 'viewer':      文書あり=`.viewer-main` の中が `<Viewer/>`(+page.svelte:1467-1486)
 */
type Mode = 'root-picker' | 'empty' | 'viewer';

type AppDom = {
	/** app.html の包み(`body` の直下・`.app` の親)。AC-38-追e (c) の要。 */
	wrapper: HTMLElement;
	app: HTMLElement;
	/** mode 'root-picker' のときだけ */
	rootPicker: HTMLElement | null;
	/** mode 'empty' のときだけ */
	emptyState: HTMLElement | null;
	/** mode 'viewer' のときだけ(以下 markdownBody まで) */
	updateBanner: HTMLElement;
	goToBar: HTMLElement | null;
	findBar: HTMLElement | null;
	externalChange: HTMLElement | null;
	structureNotice: HTMLElement | null;
	markdownBody: HTMLElement | null;
	/** `.app` の外(包みの直下・`.app` の兄弟)。全 mode で置く */
	backdrop: HTMLElement;
	dialog: HTMLElement;
	overlay: HTMLElement;
	diffView: HTMLElement;
};

/**
 * アプリの実際の入れ子を再現する(document.body を空にしてから組む)。
 * 追補c・追補d の `buildAppDom` との違いは、SvelteKit の app.html の包みを
 * `body` と `.app` の間に入れること。タグ・クラスは根の要素の実物どおり。根拠(ファイル:行)=
 *
 * src/app.html
 *   10  <body data-sveltekit-preload-data="hover">
 *   11    <div style="display: contents">%sveltekit.body%</div>   … +page.svelte の出力はこの包みの中
 *
 * src/routes/+page.svelte(%sveltekit.body% の中身)
 *   1268  <div class="app">
 *   1269-1276   {#if updateBanner} <UpdateBanner/>          … .app の直下・.app-body の前
 *   1277        <div class="app-body">
 *   1278          {#if rootPicker.open}
 *   1279-1284       <RootPicker/>                            … mode 'root-picker': .app-body の直下(他の子は無い)
 *   1285          {:else}
 *   1305            <div class="explorer-pane">
 *                     <Explorer/>                            … aside.explorer(Explorer.svelte:123)
 *   1336            <div class="pane-divider">
 *   1353            <div class="viewer-stack">
 *   1354-1362         {#if goToOpen} <GoToBar/>              … .viewer-stack の直下・.viewer-main の前
 *   1363              <div class="viewer-main">
 *   1364                {#if windowState.currentDocument}
 *   1467-1486             … {:else} <Viewer/>                … mode 'viewer': Viewer.svelte を展開
 *   1487                {:else}
 *   1488                  <EmptyState/>                      … mode 'empty': .viewer-main の直下
 *   1489                {/if}
 *   1504        <StatusBar/>                                 … footer.status-bar(StatusBar.svelte:37)
 *   1505  </div>                                             … ここまで .app
 *   1507-1512  <InstructionDialog/>                          … .app の外(兄弟)=包みの直下
 *   1514-1519  <DiffView/>                                   … .app の外(兄弟)=包みの直下
 *
 * src/components/RootPicker.svelte
 *   24  <div class="root-picker">
 *   25    <div class="picker-content">
 *   26      <h1 class="app-name">Vellis</h1>
 *   27      <p class="hint">Choose a folder to open</p>
 *   30      <ul class="history-list">
 *
 * src/components/EmptyState.svelte
 *   5   <div class="empty-state">
 *   6     <div class="empty-content">
 *   7       <h1 class="app-name">Vellis</h1>
 *   9       <p class="version">v…</p>
 *   11      <p class="hint">Select a file</p>
 *
 * src/components/Viewer.svelte
 *   1517  <article class="viewer">
 *   1518  <header class="viewer-toolbar">
 *   1581  {#if findOpen} <FindBar/>                          … header の後(兄弟)
 *   1597  <div class="external-change" data-testid="external-change-banner" role="alert">
 *   1626  <div class="structure-notice" data-testid="htmledit-structure-notice" role="status">
 *   1647  <div class="markdown-body">
 *
 * src/components/FindBar.svelte            64   <div class="find-bar find-bar--sticky">
 * src/components/GoToBar.svelte            80   <div class="go-to-bar">
 * src/components/UpdateBanner.svelte       30   <div class="update-banner">
 * src/components/DiffView.svelte           119  <div class="overlay">     121  <section class="diff-view">
 * src/components/InstructionDialog.svelte  51   <div class="backdrop">    52   <div class="dialog">
 */
function buildAppDom(mode: Mode): AppDom {
	document.body.innerHTML = '';
	const body = document.body;
	body.setAttribute('data-sveltekit-preload-data', 'hover');

	// app.html:11 の包み。class は無く、inline style の display: contents だけ
	const wrapper = el('div', '', body);
	wrapper.setAttribute('style', 'display: contents');

	const app = el('div', 'app', wrapper);
	const updateBanner = el('div', 'update-banner', app);
	updateBanner.setAttribute('role', 'status');
	const appBody = el('div', 'app-body', app);

	let rootPicker: HTMLElement | null = null;
	let emptyState: HTMLElement | null = null;
	let goToBar: HTMLElement | null = null;
	let findBar: HTMLElement | null = null;
	let externalChange: HTMLElement | null = null;
	let structureNotice: HTMLElement | null = null;
	let markdownBody: HTMLElement | null = null;

	if (mode === 'root-picker') {
		rootPicker = el('div', 'root-picker', appBody);
		const pickerContent = el('div', 'picker-content', rootPicker);
		el('h1', 'app-name', pickerContent).textContent = 'Vellis';
		el('p', 'hint', pickerContent).textContent = 'Choose a folder to open';
		el('ul', 'history-list', pickerContent);
	} else {
		const explorerPane = el('div', 'explorer-pane', appBody);
		el('aside', 'explorer', explorerPane);
		el('div', 'pane-divider', appBody);
		const viewerStack = el('div', 'viewer-stack', appBody);
		viewerStack.setAttribute('data-zoom-region', 'viewer');
		goToBar = el('div', 'go-to-bar', viewerStack);
		goToBar.setAttribute('data-testid', 'go-to-bar');
		goToBar.setAttribute('role', 'search');
		const viewerMain = el('div', 'viewer-main', viewerStack);

		if (mode === 'empty') {
			emptyState = el('div', 'empty-state', viewerMain);
			const emptyContent = el('div', 'empty-content', emptyState);
			el('h1', 'app-name', emptyContent).textContent = 'Vellis';
			el('p', 'version', emptyContent).textContent = 'v0.0.0';
			el('p', 'hint', emptyContent).textContent = 'Select a file';
		} else {
			const viewer = el('article', 'viewer', viewerMain);
			el('header', 'viewer-toolbar', viewer);
			findBar = el('div', 'find-bar find-bar--sticky', viewer);
			findBar.setAttribute('data-testid', 'find-bar');
			findBar.setAttribute('role', 'search');
			externalChange = el('div', 'external-change', viewer);
			externalChange.setAttribute('data-testid', 'external-change-banner');
			externalChange.setAttribute('role', 'alert');
			structureNotice = el('div', 'structure-notice', viewer);
			structureNotice.setAttribute('data-testid', 'htmledit-structure-notice');
			structureNotice.setAttribute('role', 'status');
			markdownBody = el('div', 'markdown-body', viewer);
		}
	}

	el('footer', 'status-bar', app);

	// .app の外=包みの直下(body の直下ではない)
	const backdrop = el('div', 'backdrop', wrapper);
	const dialog = el('div', 'dialog', wrapper);
	dialog.setAttribute('role', 'dialog');
	dialog.setAttribute('aria-modal', 'true');
	const overlay = el('div', 'overlay', wrapper);
	const diffView = el('section', 'diff-view', wrapper);

	return {
		wrapper,
		app,
		rootPicker,
		emptyState,
		updateBanner,
		goToBar,
		findBar,
		externalChange,
		structureNotice,
		markdownBody,
		backdrop,
		dialog,
		overlay,
		diffView,
	};
}

function mustExist(node: HTMLElement | null, what: string): HTMLElement {
	if (node === null) throw new Error(`テストの DOM に ${what} が無い(mode の選び方の誤り)`);
	return node;
}

// ---------------------------------------------------------------------------
// 判定器・フィクスチャの自己検査(判定が甘くて緑になるのを防ぐ)
// ---------------------------------------------------------------------------

describe('print.css 検査の判定器と包みありの DOM(AC-38-追e の判定が甘くないこと)', () => {
	test('実物の print.css から既存の隠す規則(AC-64-21・AC-38-追c・AC-38-追d の対象)が集まる=収集が空振りしていない', () => {
		const selectors = printHidingSelectors(readPrintCss());
		for (const existing of ['.explorer', '.explorer-pane', '.viewer-toolbar', '.status-bar']) {
			expect(selectors, `既存の隠す規則 ${existing}(AC-64-21)が集まること`).toContain(existing);
		}
		for (const head of ['.find-bar', '.dialog', '.external-change', '.structure-notice']) {
			expect(
				selectors.some((s) => s.startsWith(head)),
				`追補c・追補d の隠す規則 ${head}… が集まること(集めたセレクタ: ${JSON.stringify(selectors)})`,
			).toBe(true);
		}
		for (const s of selectors) {
			expect(s, 'セレクタの括弧が閉じていること(リストの分け方が壊れていない)').not.toMatch(/\([^)]*$/);
		}
	});

	test('自身か祖先が当たれば hit・どれも当たらなければ null・解釈できないセレクタは例外', () => {
		document.body.innerHTML = '<div class="outer"><div class="inner"></div></div>';
		const inner = document.querySelector('.inner') as Element;
		expect(hidingHit(inner, ['.outer'])).toEqual({ element: 'div.outer', selector: '.outer' });
		expect(hidingHit(inner, ['.inner'])).toEqual({ element: 'div.inner', selector: '.inner' });
		expect(hidingHit(inner, ['.nope'])).toBeNull();
		expect(() => hidingHit(inner, ['.a['])).toThrow(/解釈できない/);
	});

	test.each<Mode>(['root-picker', 'empty', 'viewer'])(
		'mode %s の DOM で app.html の包み(div[style="display: contents"]・class なし)が body と .app の間にあり、DiffView / InstructionDialog は包みの直下にある',
		(mode) => {
			const dom = buildAppDom(mode);
			expect(dom.wrapper.parentElement).toBe(document.body);
			expect(dom.wrapper.tagName.toLowerCase()).toBe('div');
			expect(dom.wrapper.className).toBe('');
			expect(dom.wrapper.getAttribute('style')).toBe('display: contents');
			expect(dom.app.parentElement).toBe(dom.wrapper);
			for (const outside of [dom.backdrop, dom.dialog, dom.overlay, dom.diffView]) {
				expect(outside.parentElement, `${describeElement(outside)} は包みの直下`).toBe(dom.wrapper);
				expect(outside.parentElement, `${describeElement(outside)} は body の直下ではない`).not.toBe(document.body);
			}
		},
	);

	test('包みがあるので body > .dialog のような親子関係で絞る書き方は当たらない(包みを省いた追補c・追補d のテストでは見えない差)', () => {
		const dom = buildAppDom('viewer');
		expect(hidingHit(dom.dialog, ['body > .dialog'])).toBeNull();
		expect(hidingHit(dom.diffView, ['body > section.diff-view'])).toBeNull();
		// 子孫セレクタなら当たる(包みの有無に依らない書き方の例)
		expect(hidingHit(dom.dialog, ['body .dialog'])).toEqual({ element: 'div.dialog', selector: 'body .dialog' });
	});

	test('回帰防止: 包みありの DOM でも .markdown-body 自身とその中の段落は隠す規則に当たらない', () => {
		const dom = buildAppDom('viewer');
		const markdownBody = mustExist(dom.markdownBody, '.markdown-body');
		const selectors = printHidingSelectors(readPrintCss());
		const hitBody = hidingHit(markdownBody, selectors);
		expect(hitBody, `.markdown-body が隠れないこと(当たった: ${JSON.stringify(hitBody)})`).toBeNull();
		const p = el('p', '', markdownBody);
		p.textContent = '本文の段落';
		const hitP = hidingHit(p, selectors);
		expect(hitP, `本文の段落が隠れないこと(当たった: ${JSON.stringify(hitP)})`).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC-38-追e (a) — 履歴選択画面・空の状態の根の要素は自身か祖先が隠す規則に当たる
// ---------------------------------------------------------------------------

type RootCase = [shape: string, what: string, mode: Mode, pick: (dom: AppDom) => HTMLElement | null];

const ROOT_CASES: RootCase[] = [
	[
		'div.root-picker',
		'履歴選択画面 RootPicker(RootPicker.svelte:24・+page.svelte:1279・.app-body の直下)',
		'root-picker',
		(dom) => dom.rootPicker,
	],
	[
		'div.empty-state',
		'文書なしの案内 EmptyState(EmptyState.svelte:5・+page.svelte:1488・.viewer-main の直下)',
		'empty',
		(dom) => dom.emptyState,
	],
];

describe('print.css — 履歴選択画面・空の状態は紙に載らない(要件#38 追補e・AC-38-追e (a))', () => {
	test.each(ROOT_CASES)(
		'(a) %s は自身か祖先が @media print の display: none に当たる(%s)',
		(shape, what, mode, pick) => {
			const dom = buildAppDom(mode);
			const target = mustExist(pick(dom), shape);
			const selectors = printHidingSelectors(readPrintCss());
			const hit = hidingHit(target, selectors);
			expect(
				hit,
				`${shape}(${what})の自身か祖先が、@media print で display: none を宣言する規則のどれかに当たること。` +
					`集めたセレクタ: ${JSON.stringify(selectors)}`,
			).not.toBeNull();
		},
	);
});

// ---------------------------------------------------------------------------
// AC-38-追e (b) — 本文(.markdown-body)の中の同名クラスは隠れない
// ---------------------------------------------------------------------------

type BodyCase = [tag: string, className: string];

const BODY_CASES: BodyCase[] = [
	['div', 'root-picker'],
	['div', 'empty-state'],
];

describe('print.css — 本文の中の同名クラスは紙に載る(要件#38 追補e・AC-38-追e (b))', () => {
	test.each(BODY_CASES)(
		'(b) .markdown-body の中の <%s class="%s"> は自身も祖先も隠す規則に当たらない',
		(tag, className) => {
			const dom = buildAppDom('viewer');
			const markdownBody = mustExist(dom.markdownBody, '.markdown-body');
			const selectors = printHidingSelectors(readPrintCss());

			// .markdown-body の直下
			const direct = el(tag, className, markdownBody);
			const hitDirect = hidingHit(direct, selectors);
			expect(
				hitDirect,
				`.markdown-body 直下の ${describeElement(direct)} が隠れないこと(当たった: ${JSON.stringify(hitDirect)})`,
			).toBeNull();

			// さらに一段入れ子(文書の HTML が包んでいる場合)
			const wrapper = el('div', 'doc-wrapper', markdownBody);
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
// AC-38-追e (c) — 包みありの DOM で、追補c・追補d の部品も自身か祖先が隠す規則に当たる
// ---------------------------------------------------------------------------

type WrappedCase = [shape: string, what: string, pick: (dom: AppDom) => HTMLElement | null];

const WRAPPED_CASES: WrappedCase[] = [
	['div.find-bar', '⌘F の検索バー FindBar(追補c・article.viewer の中)', (dom) => dom.findBar],
	['div.go-to-bar', 'Go to バー GoToBar(追補c・.viewer-stack の直下)', (dom) => dom.goToBar],
	['div.update-banner', '更新のお知らせ UpdateBanner(追補c・.app の直下)', (dom) => dom.updateBanner],
	['div.overlay', '差分表示 DiffView の幕(追補c・.app の外=包みの直下)', (dom) => dom.overlay],
	['section.diff-view', '差分表示 DiffView の本体(追補c・.app の外=包みの直下)', (dom) => dom.diffView],
	['div.backdrop', '指示ダイアログ InstructionDialog の幕(追補c・.app の外=包みの直下)', (dom) => dom.backdrop],
	['div.dialog', '指示ダイアログ InstructionDialog の本体(追補c・.app の外=包みの直下)', (dom) => dom.dialog],
	['div.external-change', '編集中の外部変更の帯(追補d・article.viewer の中)', (dom) => dom.externalChange],
	['div.structure-notice', '構造変化の通知(追補d・article.viewer の中)', (dom) => dom.structureNotice],
];

describe('print.css — app.html の包みを入れた DOM でも追補c・追補d の部品は紙に載らない(要件#38 追補e・AC-38-追e (c))', () => {
	test.each(WRAPPED_CASES)(
		'(c) 包みありで %s は自身か祖先が @media print の display: none に当たる(%s)',
		(shape, what, pick) => {
			const dom = buildAppDom('viewer');
			const target = mustExist(pick(dom), shape);
			const selectors = printHidingSelectors(readPrintCss());
			const hit = hidingHit(target, selectors);
			expect(
				hit,
				`${shape}(${what})の自身か祖先が、body と .app の間に app.html の包みがある DOM でも、` +
					`@media print で display: none を宣言する規則のどれかに当たること。集めたセレクタ: ${JSON.stringify(selectors)}`,
			).not.toBeNull();
		},
	);
});
