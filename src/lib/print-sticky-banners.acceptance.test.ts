/**
 * Issue #851 (5) — 貼り付く帯・知らせ(重なりの帯・削除の帯・取り込みの知らせ・閾値超えの知らせ)は紙に載らない。
 * 要件#38 追補d(print-edit-notices.acceptance.test.ts)の判定の仕方そのまま: `print.css` の `@media print` の隠す規則を
 * JSDOM の DOM に当てる。
 *
 * Issue #848 で `.merged-notice` を sticky にしたが、`print.css` の隠す一覧に `.merged-notice` は無い(#851 の 5)。
 * 帯の class 名は文書の HTML も使いうるので、隠す規則は `.external-change` と同じく本文(`.markdown-body`)の中の要素には
 * 当たらない書き方にする(セレクタの書き方は実装裁量。`:not(.markdown-body *)` が既存の家風)。
 *
 * ## 契約(implementer はこれに従う)
 * - markdown / text の印刷(メインフレーム印刷)で、`Viewer.svelte` の次の要素は出ていても紙に載らない:
 *   `external-conflict-banner`・`external-removed-banner`(`.external-change`・既存)・`external-merged-notice`(`.merged-notice`)・
 *   `markdown-too-large-notice`(Issue #851 (6) で class が変わるならその class)
 * - 隠す規則は本文(`.markdown-body`)の中の同名クラスの要素には当たらない
 * - 既存の隠す規則は不変(既存テストが無改変で緑のまま判定する)
 *
 * ## 判断の記録(test-writer 2026-11-26)
 * - 帯の class は `Viewer.svelte` のテンプレートの `data-testid` から取り出す(viewer-sticky-stack.testkit.ts の `templateClassOf`)。
 *   (6) で閾値超えの知らせの class が変わっても、ここは書き換えずに追う
 * - `.structure-notice` は Viewer から消えた使われていないセレクタ(#851 の 5)だが、print-edit-notices.acceptance.test.ts(AC-38-追d (a))が
 *   `div.structure-notice` が隠れることを固定している。既存テストは書き換えないので、ここでは**消すことを固定しない**
 *   (消すなら AC-38-追d の要件側の判断=オーケストレーターへ報告)
 *
 * ## 修正前に赤になる理由
 * - `print.css` に `.merged-notice` を隠す規則が無い(external-merged-notice と markdown-too-large-notice が紙に載る)
 *
 * @vitest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { templateClassOf } from '../components/viewer-sticky-stack.testkit';

const REPO_ROOT = resolve(__dirname, '../..');
const PRINT_CSS_PATH = resolve(REPO_ROOT, 'src/styles/print.css');
const VIEWER_SOURCE = readFileSync(resolve(REPO_ROOT, 'src/components/Viewer.svelte'), 'utf8');

// ---------------------------------------------------------------------------
// CSS のヘルパ(print-edit-notices.acceptance.test.ts と同じ家風。既存テストは改変しない=export を足さない)
// ---------------------------------------------------------------------------

function stripCssComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

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
	const re = /([-\w]+)\s*:\s*([^{};]+)(?=[;}]|$)/g;
	for (let m = re.exec(css); m !== null; m = re.exec(css)) {
		out.push({ prop: m[1], value: m[2].trim() });
	}
	return out;
}

type Rule = { selector: string; body: string };

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

function printHidingSelectors(css: string): string[] {
	const contents = printMediaContents(stripCssComments(css));
	return rulesOf(contents)
		.filter((r) => declarationsOf(r.body).some(isDisplayNone))
		.flatMap((r) => splitSelectorList(r.selector));
}

function readPrintCss(): string {
	const css = readFileSync(PRINT_CSS_PATH, 'utf8');
	expect(printMediaContents(stripCssComments(css)).length, '@media print スコープがあること').toBeGreaterThan(0);
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

/** 帯・知らせの data-testid(Viewer.svelte のテンプレートにある順)。 */
const BANNER_TESTIDS = ['external-conflict-banner', 'external-merged-notice', 'markdown-too-large-notice', 'external-removed-banner'] as const;
type BannerTestid = (typeof BANNER_TESTIDS)[number];

type AppDom = { banners: Record<BannerTestid, HTMLElement>; markdownBody: HTMLElement };

/**
 * アプリの実際の入れ子を再現する(print-edit-notices.acceptance.test.ts の `buildAppDom` と同じ入れ子)。帯・知らせは
 * `Viewer.svelte` の実物の位置(header と FindBar の後・`.markdown-body` の前の兄弟)に、実物の class(テンプレートから取り出す)で置く。
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
	const banners = {} as Record<BannerTestid, HTMLElement>;
	for (const testid of BANNER_TESTIDS) {
		const node = el('div', templateClassOf(VIEWER_SOURCE, testid).join(' '), viewer);
		node.setAttribute('data-testid', testid);
		banners[testid] = node;
	}
	const markdownBody = el('div', 'markdown-body', viewer);

	el('div', 'status-bar', app);

	return { banners, markdownBody };
}

// ---------------------------------------------------------------------------
// 前提: 帯・知らせはテンプレートに class を持つ(見た目の規則が当たる=隠す規則も class で書ける)
// ---------------------------------------------------------------------------

describe('Issue #851 (5) 前提: Viewer.svelte の帯・知らせはテンプレートに静的な class を持つ', () => {
	test.each(BANNER_TESTIDS)('%s に class 属性がある', (testid) => {
		expect(templateClassOf(VIEWER_SOURCE, testid).length).toBeGreaterThan(0);
	});

	test('判定器の自己検査: 既存の隠す規則(.external-change… / .find-bar…)が集まる', () => {
		const selectors = printHidingSelectors(readPrintCss());
		expect(selectors.some((s) => /^\.external-change\b/.test(s))).toBe(true);
		expect(selectors.some((s) => /^\.find-bar\b/.test(s))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// (a) article.viewer の中・.markdown-body の兄弟の帯・知らせは自身か祖先が隠す規則に当たる
// ---------------------------------------------------------------------------

describe('Issue #851 (5): 帯・知らせは紙に載らない(自身か祖先が @media print の display: none に当たる)', () => {
	test.each(BANNER_TESTIDS)('(a) %s(article.viewer の中・.markdown-body の兄弟)は隠れる', (testid) => {
		const dom = buildAppDom();
		const selectors = printHidingSelectors(readPrintCss());
		const target = dom.banners[testid];
		const hit = hidingHit(target, selectors);
		expect(
			hit,
			`${describeElement(target)}(data-testid="${testid}")の自身か祖先が、@media print で display: none を宣言する規則のどれかに当たること。` +
				`集めたセレクタ: ${JSON.stringify(selectors)}`,
		).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// (b) 本文(.markdown-body)の中の同名クラスは隠れない
// ---------------------------------------------------------------------------

describe('Issue #851 (5): 本文の中の同名クラスは紙に載る', () => {
	test.each(BANNER_TESTIDS)('(b) .markdown-body の中の %s と同じ class の <div> は自身も祖先も隠す規則に当たらない', (testid) => {
		const dom = buildAppDom();
		const selectors = printHidingSelectors(readPrintCss());
		const className = templateClassOf(VIEWER_SOURCE, testid).join(' ');

		const direct = el('div', className, dom.markdownBody);
		const hitDirect = hidingHit(direct, selectors);
		expect(hitDirect, `.markdown-body 直下の ${describeElement(direct)} が隠れないこと(当たった: ${JSON.stringify(hitDirect)})`).toBeNull();

		const wrapper = el('div', 'doc-wrapper', dom.markdownBody);
		const nested = el('div', className, wrapper);
		const hitNested = hidingHit(nested, selectors);
		expect(hitNested, `.markdown-body の中で一段包まれた ${describeElement(nested)} が隠れないこと(当たった: ${JSON.stringify(hitNested)})`).toBeNull();
	});
});
