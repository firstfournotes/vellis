/**
 * 要件#38 追補l の受け入れテスト(docs/requirements/req-38.md「追補l」・Issue #617 = backlog 247)
 * 「Markdown / テキストの編集中の印が紙に残る」— AC-38-追l (a)〜(c)
 *
 * 発見: backlog 242 の修正時の reviewer P3。Markdown / テキストのソース編集中・ブロック編集中に
 * 印刷すると、編集中の印(ソース編集の青い縦帯 `box-shadow: inset 3px 0 0 #93c5fd`・ブロック編集の
 * 枠 `outline: 2px solid #93c5fd`)が `print-color-adjust: exact` で紙に残る。
 *
 * 判断(要件側): 紙に載せるのは今のまま「画面の本文」(ソース編集中はソース・ブロック編集中は
 * 編集中の中身=要件#48 契約②)。編集中の**印だけ**を紙から消す。
 *
 * ## 契約(追補l)
 * 1. `src/styles/print.css` の `@media print` で、Markdown / テキストの本文の編集中の印
 *    (ソース編集の縦帯・ブロック編集の枠)を消す(`box-shadow: none`・`outline: none`)
 * 2. 不変: 画面の印(印刷のとき以外は今のまま)・紙に載る中身・ほかの印刷の規則
 *
 * ## 画面の印の規則(Viewer.svelte の `<style>`・本テストが比較の基準にするもの)
 * - ソース編集: `.vellis-plaintext[contenteditable='true'] { outline: none; box-shadow: inset 3px 0 0 #93c5fd }`
 *   (要件#48 契約②。要素は `.markdown-body` の中の `<pre class="vellis-plaintext" contenteditable="true">`
 *   = Viewer.svelte の sourceEditing 分岐)
 * - ブロック編集: `.markdown-body :global([contenteditable='true']) { outline: 2px solid #93c5fd; outline-offset: 2px; border-radius: 2px }`
 *   (要件#49 契約①。要素は `.markdown-body` の中で `setAttribute('contenteditable', 'true')` された
 *   ブロック 1 つ= 段落・フェンス・入れ子のブロックなど)
 * - Svelte 5 は scoped な規則に `.svelte-xxxx` を **1 回だけ**足す(2 回目以降は `:where()` で
 *   詳細度を上げない= Svelte 5 docs「Scoped styles / Specificity」)。ビルド出力でも
 *   `.vellis-plaintext[contenteditable=true].svelte-1t3vvp2` /
 *   `.markdown-body.svelte-1t3vvp2 [contenteditable=true]` だった。よって画面の規則の詳細度は
 *   どちらも **(0,3,0)**。ソース編集の `<pre>` は `.markdown-body` の中にあるので、ブロック編集の
 *   規則(outline)にも当たる= `<pre>` の印は box-shadow と outline の両方
 *
 * ## 判定の仕方(AC-38-追l)
 *
 * 1. `src/styles/print.css` の `@media print { … }` スコープの中で `box-shadow: none` /
 *    `outline: none`(`!important` 付きも可)を宣言する規則を集める(「消す規則」。契約 1 の
 *    文言どおり値は `none` だけを認める。`outline: 0` 等は数えない)。セレクタリストは括弧の外の
 *    カンマだけで分け、`@page` などの at-rule はセレクタとして数えない
 * 2. アプリの実際の入れ子を再現した DOM を JSDOM で組み(`buildAppDom`。根拠は同関数のコメント)、
 *    編集中の要素を `.markdown-body` の中に置く。各要素が **Viewer.svelte の画面の印のセレクタ
 *    (`:global()` を外したもの)に当たる**ことを前提として確かめる(DOM が Viewer の印の対象を
 *    正しく再現していることの自己検査)
 * 3. (a) 要素**自身**が消す規則に当たる(`box-shadow` / `outline` は継承しないので祖先では足りない):
 *    - ソース編集の `<pre>`: `box-shadow: none` の規則と `outline: none` の規則の両方
 *    - ブロック編集の要素(直下の `<p>`・フェンスの `<pre>`・`<blockquote>` の中の `<p>`): `outline: none` の規則
 * 4. (b) 当たった消す規則のうち少なくとも 1 つが、画面の規則より強い。**判定は「`!important` が
 *    付いている」か「詳細度が画面の規則(Svelte の scoping class を足した値= (0,3,0))より厳密に
 *    大きい」のどちらか**(AC の文言「詳細度か `!important`」どおり両方を認める)。詳細度が等しい
 *    ときは読み込み順で決まり(print.css は `+page.svelte` の import・Viewer の CSS と同じ束)、
 *    静的には保証できないので **等しいは不合格**
 * 5. 契約 2(印だけを消す・本文は不変): 編集中でない `<p>`(contenteditable 無し)には消す規則が
 *    当たらない(文書の HTML が持つ outline / box-shadow を紙から奪わない)
 * 6. (c) Viewer.svelte の `<style>` で、編集中の要素に当たり `outline` / `box-shadow` を宣言する規則は
 *    上の 2 つ **だけ**で、セレクタ・宣言(値・`!important` 無し)が今のまま・at-rule の中に無い
 *    (= 画面の印の規則は変わらない。印刷の直しを Viewer 側に足していないことも兼ねる)
 * 7. セレクタを jsdom のセレクタエンジンが解釈できず `matches` が例外を投げたら、それは**失敗**
 *    (黙って飛ばさない)。消す規則は jsdom で検査できる書き方にすること
 *
 * CSS のヘルパ(stripCssComments / printMediaContents / declarationsOf / rulesOf / splitSelectorList)は
 * `print-edit-notices.acceptance.test.ts`(AC-38-追d)と同じ作り。既存テストは改変しない(export を
 * 足さない)ので本ファイルに同等のものを持つ。詳細度の計算(`specificityOf`)は本ファイルで新設し、
 * 自己検査の表で固定する。
 *
 * ## 赤になる理由(実装前)
 * 現行の print.css の `@media print` に `box-shadow: none` / `outline: none` の規則が無いので、
 * (a) の 4 件と (b) の 4 件が「当たる規則が無い」で赤。(c)・契約 2・自己検査は不変条件・判定器の
 * 検査なので最初から緑。
 *
 * ## 判断の記録(test-writer 2026-10-20)
 * - (a) は「Viewer.svelte で印を付けているセレクタと同じもの」を、セレクタ文字列の一致ではなく
 *   **同じ要素に当たるか**で判定する(`:global()` は print.css に書けないので文字列一致は不可能。
 *   書き方は実装裁量)
 * - ブロック編集の要素の box-shadow は Viewer が触っていないので要求しない(付いていても可)
 *
 * @vitest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');
const PRINT_CSS_PATH = resolve(REPO_ROOT, 'src/styles/print.css');
const VIEWER_SVELTE_PATH = resolve(REPO_ROOT, 'src/components/Viewer.svelte');

/** Viewer.svelte が画面の印を付けている規則(原文のセレクタ。要件#48 契約②/要件#49 契約①)。 */
const VIEWER_SOURCE_EDIT_SELECTOR = ".vellis-plaintext[contenteditable='true']";
const VIEWER_BLOCK_EDIT_SELECTOR = ".markdown-body :global([contenteditable='true'])";

type ResetProp = 'box-shadow' | 'outline';
const RESET_PROPS: readonly ResetProp[] = ['box-shadow', 'outline'];

// ---------------------------------------------------------------------------
// CSS のヘルパ(print-edit-notices.acceptance.test.ts / print-transient-ui.acceptance.test.ts と同じ家風)
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
 * 最後の宣言は `;` 無しで書かれることがあるので、`;`・`}` に加えて文字列の終わりでも区切る。
 */
function declarationsOf(css: string): Decl[] {
	const out: Decl[] = [];
	const re = /([-\w]+)\s*:\s*([^{};]+)(?=[;}]|$)/g;
	for (let m = re.exec(css); m !== null; m = re.exec(css)) {
		out.push({ prop: m[1], value: m[2].trim() });
	}
	return out;
}

type Rule = {
	selector: string;
	body: string;
	/** この規則を包む at-rule の前置き(外側から順)。トップレベルなら空。 */
	atRules: string[];
};

/**
 * スコープの中身を規則(セレクタ+宣言ブロック)に分ける。
 * ネストした at-rule(`@media` / `@supports` 等)の中身は規則として平たく拾い(包んでいる
 * at-rule は `atRules` に記録)、at-rule 自身(`@page` 等)はセレクタとして数えない。
 */
function rulesOf(css: string, atRules: string[] = []): Rule[] {
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
			out.push(...rulesOf(body, [...atRules, selector]));
		} else if (selector.length > 0) {
			out.push({ selector, body, atRules });
		}
		i = j;
	}
	return out;
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

/** セレクタの空白を 1 つに畳む(原文の改行・字下げの違いを吸収して比べる)。 */
function normalizeSelector(selector: string): string {
	return selector.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// 詳細度(CSS Selectors Level 4 §17)と Svelte の scoped セレクタ
// ---------------------------------------------------------------------------

/** [id, class/attribute/pseudo-class, type/pseudo-element]。 */
type Specificity = [number, number, number];

const ZERO: Specificity = [0, 0, 0];

function add(a: Specificity, b: Specificity): Specificity {
	return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** 正なら a が強い・負なら b が強い・0 なら同じ。 */
function compareSpecificity(a: Specificity, b: Specificity): number {
	for (let k = 0; k < 3; k += 1) if (a[k] !== b[k]) return a[k] - b[k];
	return 0;
}

function maxSpecificity(list: Specificity[]): Specificity {
	return list.reduce((m, s) => (compareSpecificity(s, m) > 0 ? s : m), ZERO);
}

function formatSpecificity(s: Specificity): string {
	return `(${s[0]},${s[1]},${s[2]})`;
}

function isIdentChar(ch: string): boolean {
	return /[-\w -￿]/.test(ch);
}

/** 位置 i から識別子を読む(`\` エスケープは次の 1 文字ごと飲む)。戻りは次の位置。 */
function readIdent(s: string, i: number): number {
	while (i < s.length) {
		if (s[i] === '\\') {
			i += 2;
			continue;
		}
		if (!isIdentChar(s[i])) break;
		i += 1;
	}
	return i;
}

/** `open` にある `(` / `[` に対応する閉じ括弧の位置(引用符の中は見ない)。 */
function matchingClose(s: string, open: number): number {
	const openCh = s[open];
	const closeCh = openCh === '(' ? ')' : ']';
	let depth = 0;
	let quote: string | null = null;
	for (let i = open; i < s.length; i += 1) {
		const ch = s[i];
		if (quote !== null) {
			if (ch === '\\') {
				i += 1;
				continue;
			}
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === openCh) depth += 1;
		else if (ch === closeCh) {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	throw new Error(`セレクタの括弧が閉じていない: ${s}`);
}

const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);
/** 引数のセレクタリストの最大の詳細度を取る擬似クラス。 */
const FORWARDING_PSEUDO_CLASSES = new Set(['not', 'is', 'has', 'matches', '-webkit-any', '-moz-any']);

/**
 * 複合セレクタ 1 本(カンマで分けた後)の詳細度。
 * `:is()` / `:not()` / `:has()` は引数の最大・`:where()` は 0・`*` と結合子は 0・
 * `::x` と `:before` 等の旧擬似要素は type 扱い。`:nth-child()` 等の引数は数えない。
 */
function specificityOf(selector: string): Specificity {
	let spec: Specificity = [0, 0, 0];
	const s = selector.trim();
	let i = 0;
	while (i < s.length) {
		const ch = s[i];
		if (ch === '[') {
			spec = add(spec, [0, 1, 0]);
			i = matchingClose(s, i) + 1;
		} else if (ch === '#') {
			spec = add(spec, [1, 0, 0]);
			i = readIdent(s, i + 1);
		} else if (ch === '.') {
			spec = add(spec, [0, 1, 0]);
			i = readIdent(s, i + 1);
		} else if (ch === ':') {
			const isElement = s[i + 1] === ':';
			const nameStart = i + (isElement ? 2 : 1);
			const nameEnd = readIdent(s, nameStart);
			const name = s.slice(nameStart, nameEnd).toLowerCase();
			let next = nameEnd;
			let args: string | null = null;
			if (s[nameEnd] === '(') {
				const close = matchingClose(s, nameEnd);
				args = s.slice(nameEnd + 1, close);
				next = close + 1;
			}
			if (isElement || LEGACY_PSEUDO_ELEMENTS.has(name)) {
				spec = add(spec, [0, 0, 1]);
			} else if (name === 'where') {
				// 0 を足す
			} else if (FORWARDING_PSEUDO_CLASSES.has(name) && args !== null) {
				spec = add(spec, maxSpecificity(splitSelectorList(args).map(specificityOf)));
			} else {
				spec = add(spec, [0, 1, 0]);
			}
			i = next;
		} else if (ch === '*') {
			i += 1;
		} else if (isIdentChar(ch) || ch === '\\') {
			spec = add(spec, [0, 0, 1]);
			i = readIdent(s, i);
		} else {
			// 結合子(` ` `>` `+` `~`)・名前空間の `|` など
			i += 1;
		}
	}
	return spec;
}

/** Svelte の `:global(...)` を外して素の CSS セレクタにする(入れ子の括弧も追う)。 */
function unwrapGlobal(selector: string): string {
	let s = selector;
	for (;;) {
		const at = s.indexOf(':global(');
		if (at < 0) return s;
		const open = at + ':global'.length;
		const close = matchingClose(s, open);
		s = s.slice(0, at) + s.slice(open + 1, close) + s.slice(close + 1);
	}
}

/**
 * Svelte 5 は scoped な規則(`:global()` だけで出来ていない規則)に scoping class
 * `.svelte-xxxx` を 1 回だけ足す(2 回目以降は `:where()`)= 詳細度 +(0,1,0)。
 * Viewer の 2 つの規則はどちらも非 global の部分を持つので、この加算が効く。
 */
const SVELTE_SCOPE_CLASS: Specificity = [0, 1, 0];

/** Viewer.svelte の原文セレクタが、コンパイル後に画面で持つ詳細度。 */
function compiledSpecificityOf(viewerSelector: string): Specificity {
	return add(specificityOf(unwrapGlobal(viewerSelector)), SVELTE_SCOPE_CLASS);
}

// ---------------------------------------------------------------------------
// print.css の「消す規則」の収集
// ---------------------------------------------------------------------------

type ResetRule = {
	/** 個々のセレクタ(リストは分けてある)。 */
	selector: string;
	prop: ResetProp;
	important: boolean;
	specificity: Specificity;
};

/** `prop: none`(`!important` 付きも可)なら important の有無を返す。それ以外は null。 */
function noneDeclaration(d: Decl, prop: ResetProp): { important: boolean } | null {
	if (d.prop.toLowerCase() !== prop) return null;
	const m = d.value.match(/^none(\s*!\s*important)?$/i);
	if (!m) return null;
	return { important: m[1] !== undefined };
}

/** `@media print` の中で `box-shadow: none` / `outline: none` を宣言する規則(セレクタごと)を集める。 */
function printResetRules(css: string): ResetRule[] {
	const contents = printMediaContents(stripCssComments(css));
	const out: ResetRule[] = [];
	for (const rule of rulesOf(contents)) {
		for (const decl of declarationsOf(rule.body)) {
			for (const prop of RESET_PROPS) {
				const none = noneDeclaration(decl, prop);
				if (!none) continue;
				for (const selector of splitSelectorList(rule.selector)) {
					out.push({ selector, prop, important: none.important, specificity: specificityOf(selector) });
				}
			}
		}
	}
	return out;
}

function readPrintCss(): string {
	const css = readFileSync(PRINT_CSS_PATH, 'utf8');
	expect(
		printMediaContents(stripCssComments(css)).length,
		'@media print スコープがあること',
	).toBeGreaterThan(0);
	return css;
}

/** Viewer.svelte の `<style>` の中身(コメント除去済み)。 */
function viewerStyleContents(): string {
	const source = readFileSync(VIEWER_SVELTE_PATH, 'utf8');
	const open = source.lastIndexOf('<style');
	const close = source.lastIndexOf('</style>');
	expect(open >= 0 && close > open, 'Viewer.svelte に <style> があること').toBe(true);
	const start = source.indexOf('>', open) + 1;
	return stripCssComments(source.slice(start, close));
}

// ---------------------------------------------------------------------------
// DOM に当てるヘルパ
// ---------------------------------------------------------------------------

function describeElement(el: Element): string {
	const cls = Array.from(el.classList)
		.map((c) => `.${c}`)
		.join('');
	const ce = el.hasAttribute('contenteditable')
		? `[contenteditable=${el.getAttribute('contenteditable')}]`
		: '';
	return `${el.tagName.toLowerCase()}${cls}${ce}`;
}

/**
 * `Element.matches` を呼ぶ。jsdom のセレクタエンジンがセレクタを解釈できず例外を投げたら、
 * それを飛ばさずに失敗として投げ直す(判定の仕方 7)。
 */
function matchesOrThrow(el: Element, selector: string): boolean {
	try {
		return el.matches(selector);
	} catch (e) {
		throw new Error(
			`セレクタ「${selector}」を jsdom が解釈できない(${String(e)})。` +
				'消す規則は jsdom で検査できる書き方にすること',
		);
	}
}

/** 要素**自身**に当たる消す規則(prop 指定)。box-shadow / outline は継承しないので祖先は見ない。 */
function resetsHitting(el: Element, prop: ResetProp, rules: ResetRule[]): ResetRule[] {
	return rules.filter((r) => r.prop === prop && matchesOrThrow(el, r.selector));
}

function describeRules(rules: ResetRule[]): string {
	return JSON.stringify(
		rules.map((r) => ({
			selector: r.selector,
			prop: r.prop,
			important: r.important,
			specificity: formatSpecificity(r.specificity),
		})),
	);
}

function el(tag: string, className: string, parent: Node): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	parent.appendChild(node);
	return node;
}

type AppDom = {
	markdownBody: HTMLElement;
	/** ソース編集中の `<pre class="vellis-plaintext" contenteditable="true">`。 */
	sourcePre: HTMLElement;
	/** ブロック編集中の段落(`.markdown-body` 直下)。 */
	blockP: HTMLElement;
	/** ブロック編集中のフェンス(`<pre>`・`.markdown-body` 直下・vellis-plaintext ではない)。 */
	blockFence: HTMLElement;
	/** ブロック編集中の入れ子の段落(`<blockquote>` の中)。 */
	blockNested: HTMLElement;
	/** 編集中でない段落(contenteditable 無し)。 */
	plainP: HTMLElement;
};

/**
 * アプリの実際の入れ子を再現する(document.body を空にしてから組む)。
 * `print-edit-notices.acceptance.test.ts`(AC-38-追d)の `buildAppDom` と同じ入れ子に、
 * 追補l の編集中の要素を `.markdown-body` の中へ足したもの。根拠(ファイル:行)=
 *
 * src/routes/+page.svelte   <div class="app"> > <div class="app-body"> > <div class="viewer-stack">
 *                           > <div class="viewer-main"> > <Viewer/>
 * src/components/Viewer.svelte
 *   1673  <article class="viewer">
 *   1836  <div class="markdown-body">                         … 本文の容れ物(bodyEl)
 *   1870  <pre class="vellis-plaintext" contenteditable="true" spellcheck="false">
 *                                                            … sourceEditing 分岐(要件#48 契約②)。
 *                                                              `.markdown-body` の中
 *   446 / 496  el.setAttribute('contenteditable', 'true')    … ブロック編集(要件#49 契約①)。
 *                                                              `.markdown-body` の中のブロック 1 つ
 *                                                              (段落・フェンスの <pre> など)
 */
function buildAppDom(): AppDom {
	document.body.innerHTML = '';
	const body = document.body;

	const app = el('div', 'app', body);
	const appBody = el('div', 'app-body', app);
	const viewerStack = el('div', 'viewer-stack', appBody);
	const viewerMain = el('div', 'viewer-main', viewerStack);
	const viewer = el('article', 'viewer', viewerMain);
	el('header', 'viewer-toolbar', viewer);
	const markdownBody = el('div', 'markdown-body', viewer);

	const sourcePre = el('pre', 'vellis-plaintext', markdownBody);
	sourcePre.setAttribute('contenteditable', 'true');
	sourcePre.setAttribute('spellcheck', 'false');

	const plainP = el('p', '', markdownBody);
	plainP.textContent = 'plain paragraph';

	const blockP = el('p', '', markdownBody);
	blockP.setAttribute('contenteditable', 'true');

	const blockFence = el('pre', '', markdownBody);
	blockFence.setAttribute('contenteditable', 'true');

	const blockquote = el('blockquote', '', markdownBody);
	const blockNested = el('p', '', blockquote);
	blockNested.setAttribute('contenteditable', 'true');

	el('div', 'status-bar', app);

	return { markdownBody, sourcePre, blockP, blockFence, blockNested, plainP };
}

// ---------------------------------------------------------------------------
// 判定の表: 編集中の要素 × 要る消す規則 × 比較する画面の規則
// ---------------------------------------------------------------------------

type EditCase = [
	shape: string,
	key: keyof AppDom,
	/** 要素が当たるべき Viewer.svelte の印のセレクタ(原文)。前提の自己検査に使う。 */
	viewerSelectors: string[],
	/** 要る消す規則の prop と、その prop を画面で当てている Viewer の規則(比較の基準)。 */
	needs: { prop: ResetProp; against: string[] }[],
];

const EDIT_CASES: EditCase[] = [
	[
		'pre.vellis-plaintext[contenteditable=true](ソース編集・要件#48 契約②)',
		'sourcePre',
		[VIEWER_SOURCE_EDIT_SELECTOR, VIEWER_BLOCK_EDIT_SELECTOR],
		[
			// 縦帯(box-shadow)はソース編集の規則が当てている
			{ prop: 'box-shadow', against: [VIEWER_SOURCE_EDIT_SELECTOR] },
			// `.markdown-body` の中なのでブロック編集の規則(outline)にも当たる= 枠も消す
			{ prop: 'outline', against: [VIEWER_SOURCE_EDIT_SELECTOR, VIEWER_BLOCK_EDIT_SELECTOR] },
		],
	],
	[
		'p[contenteditable=true](ブロック編集・.markdown-body 直下の段落・要件#49 契約①)',
		'blockP',
		[VIEWER_BLOCK_EDIT_SELECTOR],
		[{ prop: 'outline', against: [VIEWER_BLOCK_EDIT_SELECTOR] }],
	],
	[
		'pre[contenteditable=true](ブロック編集・フェンス)',
		'blockFence',
		[VIEWER_BLOCK_EDIT_SELECTOR],
		[{ prop: 'outline', against: [VIEWER_BLOCK_EDIT_SELECTOR] }],
	],
	[
		'blockquote > p[contenteditable=true](ブロック編集・入れ子のブロック)',
		'blockNested',
		[VIEWER_BLOCK_EDIT_SELECTOR],
		[{ prop: 'outline', against: [VIEWER_BLOCK_EDIT_SELECTOR] }],
	],
];

/** 前提の自己検査: DOM の要素が Viewer.svelte の印のセレクタに当たる(= 印の対象を再現している)。 */
function expectMarkedByViewer(target: Element, viewerSelectors: string[]): void {
	for (const viewerSelector of viewerSelectors) {
		expect(
			matchesOrThrow(target, unwrapGlobal(viewerSelector)),
			`前提: ${describeElement(target)} が Viewer.svelte の印のセレクタ「${viewerSelector}」に当たること`,
		).toBe(true);
	}
}

// ---------------------------------------------------------------------------
// 判定器の自己検査(AC-38-追l の判定が甘くないこと)
// ---------------------------------------------------------------------------

describe('判定器の自己検査(AC-38-追l の判定が甘くないこと)', () => {
	test.each<[selector: string, expected: Specificity]>([
		['.a', [0, 1, 0]],
		[".markdown-body [contenteditable='true']", [0, 2, 0]],
		[".vellis-plaintext[contenteditable='true']", [0, 2, 0]],
		['.markdown-body.svelte-1t3vvp2 [contenteditable=true]', [0, 3, 0]],
		['.vellis-plaintext[contenteditable=true].svelte-1t3vvp2', [0, 3, 0]],
		["pre.vellis-plaintext[contenteditable='true']", [0, 2, 1]],
		[".viewer .markdown-body [contenteditable='true']", [0, 3, 0]],
		[".viewer .markdown-body .vellis-plaintext[contenteditable='true']", [0, 4, 0]],
		['.a :not(.b, #c)', [1, 1, 0]],
		[':where(.a .b) .c', [0, 1, 0]],
		['.a :is(p, .b)', [0, 2, 0]],
		['#x::before', [1, 0, 1]],
		['a:hover', [0, 1, 1]],
		['li:nth-child(2n+1)', [0, 1, 1]],
		['*', [0, 0, 0]],
		['.a[data-x="a]b"]', [0, 2, 0]],
		['.a > .b + .c ~ .d', [0, 4, 0]],
	])('詳細度: %s = %j', (selector, expected) => {
		expect(specificityOf(selector)).toEqual(expected);
	});

	test('詳細度の比較は [id, class, type] の辞書順', () => {
		expect(compareSpecificity([0, 3, 0], [0, 3, 0])).toBe(0);
		expect(compareSpecificity([0, 3, 1], [0, 3, 0])).toBeGreaterThan(0);
		expect(compareSpecificity([0, 4, 0], [0, 3, 9])).toBeGreaterThan(0);
		expect(compareSpecificity([1, 0, 0], [0, 9, 9])).toBeGreaterThan(0);
		expect(compareSpecificity([0, 2, 9], [0, 3, 0])).toBeLessThan(0);
	});

	test(':global() を外し、Svelte の scoping class を足した画面の規則の詳細度は (0,3,0)', () => {
		expect(unwrapGlobal(VIEWER_BLOCK_EDIT_SELECTOR)).toBe(".markdown-body [contenteditable='true']");
		expect(unwrapGlobal(VIEWER_SOURCE_EDIT_SELECTOR)).toBe(VIEWER_SOURCE_EDIT_SELECTOR);
		expect(unwrapGlobal(':global(.a :not(.b, :global(.c))) .d')).toBe('.a :not(.b, .c) .d');
		expect(compiledSpecificityOf(VIEWER_SOURCE_EDIT_SELECTOR)).toEqual([0, 3, 0]);
		expect(compiledSpecificityOf(VIEWER_BLOCK_EDIT_SELECTOR)).toEqual([0, 3, 0]);
	});

	test('消す規則の収集: box-shadow / outline の none(!important の有無)だけを、セレクタごとに集める', () => {
		const css = `
			.screen-only { outline: none; }
			@media print {
				.a, .b > .c { outline: none !important; box-shadow: none }
				.d { outline: 0; box-shadow: initial }
				.e { OUTLINE: NONE ! important }
				@page { margin: 1cm }
			}
		`;
		const rules = printResetRules(css).map((r) => ({
			selector: r.selector,
			prop: r.prop,
			important: r.important,
			specificity: r.specificity,
		}));
		expect(rules).toEqual([
			{ selector: '.a', prop: 'outline', important: true, specificity: [0, 1, 0] },
			{ selector: '.b > .c', prop: 'outline', important: true, specificity: [0, 2, 0] },
			{ selector: '.a', prop: 'box-shadow', important: false, specificity: [0, 1, 0] },
			{ selector: '.b > .c', prop: 'box-shadow', important: false, specificity: [0, 2, 0] },
			{ selector: '.e', prop: 'outline', important: true, specificity: [0, 1, 0] },
		]);
	});

	test('実物の print.css の @media print から既存の規則が集まる(解析が空振りしていない)', () => {
		const rules = rulesOf(printMediaContents(stripCssComments(readPrintCss())));
		const body = rules.find((r) => normalizeSelector(r.selector) === '.markdown-body');
		expect(body, '.markdown-body の規則(要件#36 契約⑦の zoom リセット)が読めること').toBeDefined();
		expect(declarationsOf(body!.body).some((d) => d.prop === 'zoom')).toBe(true);
	});

	test('DOM の編集中の要素は Viewer.svelte の印のセレクタに当たり、編集中でない段落は当たらない', () => {
		const dom = buildAppDom();
		for (const [, key, viewerSelectors] of EDIT_CASES) expectMarkedByViewer(dom[key], viewerSelectors);
		expect(matchesOrThrow(dom.plainP, unwrapGlobal(VIEWER_BLOCK_EDIT_SELECTOR))).toBe(false);
		expect(matchesOrThrow(dom.plainP, unwrapGlobal(VIEWER_SOURCE_EDIT_SELECTOR))).toBe(false);
		expect(() => matchesOrThrow(dom.plainP, '.a[')).toThrow(/解釈できない/);
	});
});

// ---------------------------------------------------------------------------
// AC-38-追l (a) — print.css の @media print に、編集中の要素の box-shadow: none / outline: none がある
// ---------------------------------------------------------------------------

describe('print.css — 編集中の印を消す規則がある(要件#38 追補l・AC-38-追l (a))', () => {
	test.each(EDIT_CASES)('(a) %s 自身が消す規則に当たる', (shape, key, viewerSelectors, needs) => {
		const dom = buildAppDom();
		const target = dom[key];
		expectMarkedByViewer(target, viewerSelectors);

		const rules = printResetRules(readPrintCss());
		for (const { prop } of needs) {
			const hits = resetsHitting(target, prop, rules);
			expect(
				hits.length,
				`${shape}: @media print で「${prop}: none」を宣言する規則のどれかが要素自身に当たること` +
					`(${prop} は継承しないので祖先では足りない)。集めた消す規則: ${describeRules(rules)}`,
			).toBeGreaterThan(0);
		}
	});
});

// ---------------------------------------------------------------------------
// AC-38-追l (b) — その指定が画面の規則(Viewer.svelte の scoped な規則)より強い
// ---------------------------------------------------------------------------

describe('print.css — 消す規則は画面の規則より強い(要件#38 追補l・AC-38-追l (b))', () => {
	test.each(EDIT_CASES)(
		'(b) %s に当たる消す規則のどれかが !important か、詳細度で画面の規則に厳密に勝つ',
		(shape, key, viewerSelectors, needs) => {
			const dom = buildAppDom();
			const target = dom[key];
			expectMarkedByViewer(target, viewerSelectors);

			const rules = printResetRules(readPrintCss());
			for (const { prop, against } of needs) {
				const screen = maxSpecificity(against.map(compiledSpecificityOf));
				const hits = resetsHitting(target, prop, rules);
				const strong = hits.filter(
					(r) => r.important || compareSpecificity(r.specificity, screen) > 0,
				);
				expect(
					strong.length,
					`${shape}: 「${prop}: none」の規則のうち、!important が付くか、詳細度が画面の規則` +
						`(${against.join(' / ')} + Svelte の .svelte-xxxx = ${formatSpecificity(screen)})より` +
						`厳密に大きいものが 1 つはあること(等しいは読み込み順に依存するので不合格)。` +
						`当たった消す規則: ${describeRules(hits)}`,
				).toBeGreaterThan(0);
			}
		},
	);
});

// ---------------------------------------------------------------------------
// 契約 2 — 編集中でない本文には当たらない(印だけを消す・紙に載る中身は不変)
// ---------------------------------------------------------------------------

describe('print.css — 消す規則は編集中でない本文に当たらない(要件#38 追補l 契約 2)', () => {
	test('contenteditable の無い <p>(.markdown-body の中)には box-shadow / outline を消す規則が当たらない', () => {
		const dom = buildAppDom();
		const rules = printResetRules(readPrintCss());
		for (const prop of RESET_PROPS) {
			const hits = resetsHitting(dom.plainP, prop, rules);
			expect(
				hits,
				`編集中でない ${describeElement(dom.plainP)} に「${prop}: none」の規則が当たらないこと` +
					`(文書の HTML が持つ ${prop} を紙から奪わない)。当たった: ${describeRules(hits)}`,
			).toEqual([]);
		}
	});
});

// ---------------------------------------------------------------------------
// AC-38-追l (c) — Viewer.svelte の画面の印の規則は変わらない
// ---------------------------------------------------------------------------

type ViewerMarkRule = { selector: string; atRules: string[]; declarations: Decl[] };

function sortDecls(decls: Decl[]): Decl[] {
	return [...decls].sort((a, b) => a.prop.localeCompare(b.prop));
}

/** 今の画面の印の規則(原文のセレクタ・宣言。順序は問わない)。 */
const EXPECTED_VIEWER_MARK_RULES: ViewerMarkRule[] = [
	{
		selector: VIEWER_SOURCE_EDIT_SELECTOR,
		atRules: [],
		declarations: sortDecls([
			{ prop: 'outline', value: 'none' },
			{ prop: 'box-shadow', value: 'inset 3px 0 0 #93c5fd' },
		]),
	},
	{
		selector: VIEWER_BLOCK_EDIT_SELECTOR,
		atRules: [],
		declarations: sortDecls([
			{ prop: 'outline', value: '2px solid #93c5fd' },
			{ prop: 'outline-offset', value: '2px' },
			{ prop: 'border-radius', value: '2px' },
		]),
	},
];

describe('Viewer.svelte — 画面の印の規則は変わらない(要件#38 追補l・AC-38-追l (c))', () => {
	test('(c) 編集中の要素に当たり outline / box-shadow を宣言する規則は今の 2 つだけで、セレクタ・宣言・置き場が同じ', () => {
		const dom = buildAppDom();
		const editing = EDIT_CASES.map(([, key]) => dom[key]);
		const found: ViewerMarkRule[] = [];
		for (const rule of rulesOf(viewerStyleContents())) {
			const declarations = declarationsOf(rule.body);
			if (!declarations.some((d) => RESET_PROPS.includes(d.prop.toLowerCase() as ResetProp))) continue;
			const selectors = splitSelectorList(rule.selector);
			const hits = selectors.some((s) => editing.some((e) => matchesOrThrow(e, unwrapGlobal(s))));
			if (!hits) continue;
			found.push({
				selector: normalizeSelector(rule.selector),
				atRules: rule.atRules.map(normalizeSelector),
				declarations: sortDecls(declarations),
			});
		}
		found.sort((a, b) => a.selector.localeCompare(b.selector));
		const expected = [...EXPECTED_VIEWER_MARK_RULES].sort((a, b) => a.selector.localeCompare(b.selector));
		expect(
			found,
			'Viewer.svelte の <style> で編集中の要素に outline / box-shadow を当てる規則は、' +
				'要件#48 契約②・要件#49 契約① の 2 つだけ・宣言(値・!important 無し)も同じ・トップレベル(at-rule の中でない)であること',
		).toEqual(expected);
	});
});
