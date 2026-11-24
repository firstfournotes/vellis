/**
 * 要件#74 の再発防止テスト — 編集面とその容れ物に、枠(none 以外の outline / box-shadow)を付ける規則が無い
 * (docs/requirements/req-74.md 状態節「2026-11-20 午後 由谷の手試し(B.1 の前半)と青い枠」・
 *  docs/requirements/req-38.md 追補l「要件側の更新(2026-11-20)」。component プロジェクト・JSDOM)
 *
 * ## 何が起きたか
 * 由谷の手試しで「文書全体が青い枠で囲まれている」。原因は Viewer.svelte の `<style>` に残った撤去済みの編集の印
 * (要件49 契約①のブロック編集の枠 `.markdown-body :global([contenteditable='true']) { outline: 2px solid … }`)が、
 * `.markdown-body` の中にある要件#74 の ProseMirror の面の根(contenteditable="true")全体に当たったこと。
 * MarkdownEditor の scoped な `outline: none` と詳細度が同じ (0,3,0) で、後から読まれる Viewer の規則が勝っていた。
 * 同じ規則は CodeEditor / RawSourceEditor の CodeMirror の `.cm-content[contenteditable="true"]` にも当たる。
 * 由谷の決定(2026-11-20): Viewer の 2 つの規則(上と、要件48 契約②の `.vellis-plaintext[contenteditable='true']`
 * の縦帯)を消す。本テストは、同じ種類の枠が編集面に戻らないことを判定する(Viewer.svelte だけを見る AC-38-追l (c)
 * は `src/lib/print-edit-marks.acceptance.test.ts`)。
 *
 * ## 判定するもの
 * 1. アプリの実際の入れ子を再現した要素(下の「面」)に、`src/components/*.svelte` の `<style>` と
 *    `src/styles/*.css` の規則のうち、値が none 以外の `outline` / `box-shadow` を宣言して当たるものが無い。
 *    例外= 全体の `:focus-visible` のリング(`src/styles/app.css` の `:focus-visible`。要件#56 契約 4)
 * 2. その例外について: 面のフォーカスが乗る要素に全体のリングが当たり(前提)、それより強い `outline: none` が
 *    画面で効く(`!important` か、詳細度が厳密に大きい。等しいは読み込み順に依存するので不合格)
 * 3. CodeMirror 自身の点線の枠(既定のテーマの `.ͼ….cm-focused { outline: 1px dotted … }`): CodeEditor と
 *    RawSourceEditor の面(code / text / raw)で、フォーカスのある `.cm-editor.cm-focused` にその枠が当たり(前提)、
 *    それより強い src の規則の `outline: none` が画面で効く(強さの判定は 2 と同じ。2026-11-20 オーケストレーターの指示)
 *
 * ## 面(アプリの入れ子。根拠=ファイル:行)
 * 共通: src/routes/+page.svelte `.app > .app-body > .viewer-stack > .viewer-main > <Viewer/>`
 *       src/components/Viewer.svelte 956 `<article class="viewer">` > 1161 `<div class="markdown-body">`(本文の容れ物)
 * - markdown: Viewer 1192 `<MarkdownEditor>`(mdSurface)
 *     MarkdownEditor.svelte 1076 `.markdown-editor` > 1146 `.markdown-editor-surface` > ProseMirror の面の根
 *     (961 `attributes: { class: 'markdown-body', autocapitalize: 'off', autocorrect: 'off' }`。prosemirror-view が
 *     class `ProseMirror`・contenteditable="true"・translate="no" を付け、フォーカス中は `ProseMirror-focused`)> ブロック
 * - code / text: Viewer 1174 `<CodeEditor>`(faceActive。コードは `data-vellis-lang` あり・plain text は無し)
 *     CodeEditor.svelte 583 `.code-editor.vellis-plaintext` > 590 `.code-editor-surface` > CodeMirror
 * - raw: MarkdownEditor 1132 `<RawSourceEditor>`(raw の間。1146 の面の中身は外す= 203 `host?.replaceChildren()`)
 *     RawSourceEditor.svelte 276 `.raw-source-editor` > 282 `.raw-source-surface` > CodeMirror
 * - CodeMirror は本物の `EditorView`(@codemirror/view)を JSDOM に載せる: `.cm-editor`(フォーカス中は
 *   `cm-focused`= テストで足す)> `.cm-scroller` > `.cm-content[contenteditable="true"]` > `.cm-line`
 * 判定の対象の要素= 本文の容れ物(Viewer の `.markdown-body`)・各コンポーネントの面の要素・エディタの根・その中身
 * (ProseMirror のブロック/CodeMirror の `.cm-scroller`・`.cm-content`・`.cm-line`)。面の上に浮かぶもの(浮遊バー・
 * リンクの欄・貼り付けの札)は対象外(影は要件#56 契約 4 のオーバーレイの 1 段で、面の枠ではない)
 *
 * ## 判定の仕方
 * - 規則の集め方: `.svelte` は行頭の `<style>`〜`</style>`(コメントの中の `<style>` の字は拾わない)・`.css` は全体。
 *   コメントを落とし、セレクタリストは括弧の外のカンマで分ける。at-rule の中(`@media print` も)は数える。
 *   `@keyframes` の中は数えない
 * - 当て方: Svelte の `:global()` を外して jsdom の `matches` で当てる。scoped な規則(`.svelte`)で主語(最後の
 *   複合セレクタ)が `:global()` でないものは、そのコンポーネント自身が出す要素にしか当たらない(Svelte の scoping
 *   class)ので、要素の持ち主(`data-vellis-test-owner`)が同じときだけ当たりとする。ProseMirror / CodeMirror が
 *   作る要素は持ち主なし(`:global()` の主語だけが当たる)。祖先側の scoped な部分は確かめない(当たりを広く取る側)
 * - 状態の擬似クラス: `:focus` / `:focus-visible` はフォーカスの乗る要素(エディタの contenteditable の根)に、
 *   `:focus-within` はその要素と祖先に当たるとみなす。`:hover` / `:active` / ベンダー接頭辞付きの擬似クラスは
 *   どの要素にも当たりうるとみなす。擬似要素(`::before` など)はその元の要素に当てる
 * - 強さ(判定 2): `.svelte` の scoped な部分を持つ規則は Svelte の scoping class の (0,1,0) を足す(Svelte 5 は
 *   1 回だけ足す= print-edit-marks.acceptance.test.ts と同じ)。`outline: none` は画面で効くもの(at-rule の外か
 *   `@media screen` の中・擬似要素なし)だけを数える(`@media print` の打ち消しは画面の守りにならない)
 * - CodeMirror の面のフォーカスが乗る要素は `.cm-content`。その `outline: none` は CodeMirror の既定のテーマ
 *   (@codemirror/view が実行時に `<head>` の `<style>` へ差す `.ͼ… .cm-content { … outline: none }`)が持つ。
 *   CodeEditor / RawSourceEditor の `.cm-editor.cm-focused { outline: none }` は CodeMirror の点線の枠を消すもので
 *   `.cm-content` には当たらない。よって判定 2 の守りには、本物の EditorView が差した `<style>` の規則も数える
 *   (判定 1 は src の規則だけ)
 * - 判定 3 の CodeMirror の枠は、本物の EditorView が `<head>` に差した `<style>` から読む(値が none 以外の
 *   outline / box-shadow で `.cm-editor.cm-focused` に当たる規則・画面で効くもの)。守りは src の規則の `none` だけを数える
 *
 * ## 赤になる理由(実装前)
 * Viewer.svelte の `.markdown-body :global([contenteditable='true']) { outline: 2px solid var(--color-focus-ring) }`
 * が、4 つの面すべてでエディタの根(markdown= ProseMirror の根・code / text / raw= `.cm-content`)に当たるので、
 * 判定 1 の 4 件が赤。この規則を消すと緑。`.vellis-plaintext[contenteditable='true']` の縦帯は今の面には当たらない
 * (CodeEditor の根は `.vellis-plaintext` だが contenteditable を持たない)ので、こちらは print-edit-marks の (c) が
 * 拾う。判定 2・判定 3 と自己検査は最初から緑(判定 2 は MarkdownEditor の `outline: none` と CodeMirror の既定の
 * テーマが今もあるので緑。判定 3 は CodeEditor / RawSourceEditor の
 * `.{code-editor,raw-source}-surface :global(.cm-editor.cm-focused) { outline: none }` (0,4,0) が CodeMirror の
 * `.ͼ1.cm-focused` (0,2,0) に勝っているので緑。どれもそれを外すと赤になる守り)
 *
 * ## 判断の記録(test-writer 2026-11-20)
 * - 本文の容れ物(Viewer の `.markdown-body`)も対象に入れる(容れ物の枠も「文書全体の枠」になるため)
 * - 判定 1 は at-rule の中も数える(印刷の紙に枠が出るのも同じ種類の不具合。今の src に該当は無い)
 * - CodeMirror の面の判定 2 は、CodeMirror の既定のテーマを守りとして数える(上の「判定の仕方」)。CodeEditor /
 *   RawSourceEditor に `.cm-content` の `outline: none` を足すことは求めない(決定に含まれないため)
 * - CSS のヘルパ・詳細度の計算は print-edit-marks.acceptance.test.ts / ui-invariants-stage2.acceptance.test.ts の
 *   コピー(既存テストは改変しない= export を足さない)
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');
const COMPONENTS_DIR = resolve(REPO_ROOT, 'src/components');
const STYLES_DIR = resolve(REPO_ROOT, 'src/styles');

/** 例外= 全体のフォーカスリング(要件#56 契約 4)の置き場とセレクタ。 */
const GLOBAL_RING_FILE = 'src/styles/app.css';
const GLOBAL_RING_SELECTOR = ':focus-visible';

/** CodeMirror が実行時に差す `<style>` の規則の置き場(表示用)。 */
const CODEMIRROR_FILE = '@codemirror/view(実行時に <head> へ差す <style>)';

/** テストだけが付ける属性。 */
const OWNER_ATTR = 'data-vellis-test-owner';
const FOCUS_ATTR = 'data-vellis-test-focus';
const FOCUS_WITHIN_ATTR = 'data-vellis-test-focus-within';
/** どの要素にも付けない属性(`:not([…])` で「常に当たる」を表す)。 */
const NEVER_ATTR = 'data-vellis-test-never';

/** src/routes/+page.svelte が出す要素の持ち主。 */
const PAGE_OWNER = '+page';

// ---------------------------------------------------------------------------
// JSDOM の polyfill(CodeMirror の計測が落ちないように。座標は 0= CodeEditor.wiring.test.ts と同じ)
// ---------------------------------------------------------------------------

beforeAll(() => {
	const zeroRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
	const emptyRects = () => {
		const list: DOMRect[] = [];
		return Object.assign(list, { item: (_i: number) => null }) as unknown as DOMRectList;
	};
	const rangeProto = Range.prototype as unknown as Record<string, unknown>;
	if (typeof rangeProto.getClientRects !== 'function') rangeProto.getClientRects = emptyRects;
	if (typeof rangeProto.getBoundingClientRect !== 'function') rangeProto.getBoundingClientRect = zeroRect;
	if (typeof (document as unknown as Record<string, unknown>).elementFromPoint !== 'function') {
		(document as unknown as Record<string, unknown>).elementFromPoint = () => null;
	}
});

const views: EditorView[] = [];

afterEach(() => {
	for (const view of views.splice(0)) view.destroy();
	document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// CSS のヘルパ(print-edit-marks.acceptance.test.ts / ui-invariants-stage2.acceptance.test.ts と同じ作り)
// ---------------------------------------------------------------------------

function stripCssComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

type Decl = { prop: string; value: string };

/** 宣言ブロックの中身を宣言に分ける(最後の宣言は `;` 無しでもよい)。 */
function declarationsOf(css: string): Decl[] {
	const out: Decl[] = [];
	const re = /([-\w]+)\s*:\s*([^{};]+)(?=[;}]|$)/g;
	for (let m = re.exec(css); m !== null; m = re.exec(css)) {
		out.push({ prop: m[1], value: m[2].trim() });
	}
	return out;
}

type CssRule = { selector: string; body: string; atRules: string[] };

/** 規則(セレクタ+宣言ブロック)に分ける。ネストした at-rule の中身は平たく拾い、包む at-rule を記録する。 */
function rulesOf(css: string, atRules: string[] = []): CssRule[] {
	const out: CssRule[] = [];
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

/** セレクタリストを括弧の外のカンマで分ける。 */
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

function normalizeSelector(selector: string): string {
	return selector.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// 詳細度(CSS Selectors Level 4 §17。print-edit-marks.acceptance.test.ts のコピー)
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
	return /[-\w\u0080-￿]/.test(ch);
}

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
const FORWARDING_PSEUDO_CLASSES = new Set(['not', 'is', 'has', 'matches', '-webkit-any', '-moz-any']);

/** 複合セレクタ 1 本(カンマで分けた後)の詳細度。 */
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

// ---------------------------------------------------------------------------
// Svelte の scoped セレクタ
// ---------------------------------------------------------------------------

/** Svelte 5 が scoped な規則に足す scoping class(1 回だけ= +(0,1,0))。 */
const SVELTE_SCOPE_CLASS: Specificity = [0, 1, 0];

/** 複合セレクタに分ける(結合子= 空白・`>`・`+`・`~`。括弧と引用符の中では分けない)。 */
function compoundsOf(selector: string): string[] {
	const out: string[] = [];
	let cur = '';
	let depth = 0;
	let quote: string | null = null;
	for (let i = 0; i < selector.length; i += 1) {
		const ch = selector[i];
		if (quote !== null) {
			cur += ch;
			if (ch === '\\' && i + 1 < selector.length) {
				cur += selector[i + 1];
				i += 1;
			} else if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			cur += ch;
			continue;
		}
		if (ch === '(' || ch === '[') depth += 1;
		else if (ch === ')' || ch === ']') depth -= 1;
		if (depth === 0 && /[\s>+~]/.test(ch)) {
			if (cur.trim().length > 0) out.push(cur.trim());
			cur = '';
			continue;
		}
		cur += ch;
	}
	if (cur.trim().length > 0) out.push(cur.trim());
	return out;
}

/** `:global(...)` だけで出来た複合セレクタか(後ろに擬似クラス・擬似要素だけが続くものも含む)。 */
function isGlobalCompound(compound: string): boolean {
	if (!compound.startsWith(':global(')) return false;
	const close = matchingClose(compound, ':global'.length);
	return /^(::?[-\w]+(\([^()]*\))?)*$/.test(compound.slice(close + 1));
}

/** 主語(最後の複合セレクタ)が scoped(= コンポーネント自身の要素にしか当たらない)。 */
function subjectIsScoped(selector: string): boolean {
	const compounds = compoundsOf(selector);
	return compounds.length > 0 && !isGlobalCompound(compounds[compounds.length - 1]);
}

/** `:global()` の外に scoped な部分を持つ(Svelte が scoping class を足す)。 */
function hasScopedPart(selector: string): boolean {
	return compoundsOf(selector).some((c) => !isGlobalCompound(c));
}

// ---------------------------------------------------------------------------
// 規則の集め方
// ---------------------------------------------------------------------------

type SourceRule = {
	/** 置き場(表示用。リポジトリからの相対パスか、CodeMirror の印)。 */
	file: string;
	/** scoped な規則の持ち主(`.svelte` のコンポーネント名)。`.css` と CodeMirror の規則は null(全体に効く)。 */
	component: string | null;
	/** 個々のセレクタ(リストは分けてある・原文)。 */
	selector: string;
	atRules: string[];
	decls: Decl[];
};

const isKeyframes = (atRule: string) => /^@(-[a-z]+-)?keyframes\b/i.test(atRule);

function rulesFromCss(css: string, file: string, component: string | null): SourceRule[] {
	const out: SourceRule[] = [];
	for (const rule of rulesOf(stripCssComments(css))) {
		const atRules = rule.atRules.map(normalizeSelector);
		if (atRules.some(isKeyframes)) continue;
		const decls = declarationsOf(rule.body);
		for (const selector of splitSelectorList(rule.selector)) {
			out.push({ file, component, selector, atRules, decls });
		}
	}
	return out;
}

/** `.svelte` の `<style>` の中身(行頭の `<style>` 〜 行頭の `</style>`。コメントの中の `<style>` の字は拾わない)。 */
function styleBlocksOf(source: string): string[] {
	return [...source.matchAll(/^<style[^>]*>([\s\S]*?)^<\/style>/gm)].map((m) => m[1]);
}

function componentRules(): SourceRule[] {
	const out: SourceRule[] = [];
	const names = readdirSync(COMPONENTS_DIR)
		.filter((f) => f.endsWith('.svelte'))
		.sort();
	for (const name of names) {
		const source = readFileSync(join(COMPONENTS_DIR, name), 'utf8');
		const component = name.replace(/\.svelte$/, '');
		for (const css of styleBlocksOf(source)) out.push(...rulesFromCss(css, `src/components/${name}`, component));
	}
	return out;
}

function stylesheetRules(): SourceRule[] {
	const out: SourceRule[] = [];
	const names = readdirSync(STYLES_DIR)
		.filter((f) => f.endsWith('.css'))
		.sort();
	for (const name of names) {
		out.push(...rulesFromCss(readFileSync(join(STYLES_DIR, name), 'utf8'), `src/styles/${name}`, null));
	}
	return out;
}

/** src の規則(判定 1 の対象)。 */
function srcRules(): SourceRule[] {
	return [...componentRules(), ...stylesheetRules()];
}

/** CodeMirror(style-mod)が `<head>` に差した `<style>` の規則(判定 2 の守りにだけ数える)。 */
function codeMirrorInjectedRules(): SourceRule[] {
	const css = Array.from(document.head.querySelectorAll('style'))
		.map((s) => s.textContent ?? '')
		.filter((text) => text.includes('.cm-content'))
		.join('\n');
	return rulesFromCss(css, CODEMIRROR_FILE, null);
}

// ---------------------------------------------------------------------------
// 枠の宣言・状態の擬似クラス・当て方
// ---------------------------------------------------------------------------

const FRAME_PROPS: readonly string[] = ['outline', 'box-shadow'];
const NONE_VALUE = /^none(\s*!\s*important)?$/i;

/** 枠を付ける宣言(値が none 以外の outline / box-shadow)。 */
function frameDecls(rule: SourceRule): Decl[] {
	return rule.decls.filter((d) => FRAME_PROPS.includes(d.prop.toLowerCase()) && !NONE_VALUE.test(d.value));
}

/** `prop: none`(`!important` 付きも可)の宣言。 */
function noneDecls(rule: SourceRule, prop: string): Decl[] {
	return rule.decls.filter((d) => d.prop.toLowerCase() === prop && NONE_VALUE.test(d.value));
}

function isGlobalFocusRing(rule: SourceRule): boolean {
	return rule.file === GLOBAL_RING_FILE && normalizeSelector(rule.selector) === GLOBAL_RING_SELECTOR;
}

/**
 * 状態の擬似クラスを「その状態にある」とみなす形に置き換える。
 * `:focus` / `:focus-visible` → フォーカスの乗る要素・`:focus-within` → その要素と祖先・
 * `:hover` / `:active` / ベンダー接頭辞付きの擬似クラス → どの要素にも当たりうる(常に真)。
 */
function assumeUserStates(selector: string): string {
	return selector
		.replace(/:focus-visible(?![-\w])/g, `[${FOCUS_ATTR}]`)
		.replace(/:focus-within(?![-\w])/g, `[${FOCUS_WITHIN_ATTR}]`)
		.replace(/:focus(?![-\w])/g, `[${FOCUS_ATTR}]`)
		.replace(/:(hover|active)(?![-\w])/g, `:not([${NEVER_ATTR}])`)
		.replace(/(?<!:):-(webkit|moz|ms)-[-\w]+(\([^()]*\))?/g, `:not([${NEVER_ATTR}])`);
}

const PSEUDO_ELEMENT = /::[-\w]+(\([^()]*\))?|:(?:before|after|first-line|first-letter)(?![-\w])/gi;

function hasPseudoElement(selector: string): boolean {
	return /::|:(?:before|after|first-line|first-letter)(?![-\w])/i.test(selector);
}

/** 擬似要素を外して元の要素に当てる形にする(複合セレクタの頭の擬似要素は全称に)。 */
function stripPseudoElements(selector: string): string {
	return selector
		.replace(PSEUDO_ELEMENT, (_m: string, _args: string | undefined, offset: number, whole: string) =>
			offset === 0 || /[\s>+~(,]$/.test(whole.slice(0, offset)) ? '*' : '',
		)
		.trim();
}

/** jsdom の `matches` に渡す形(`:global()` を外し・擬似要素を外し・状態をみなす)。 */
function nativeSelector(selector: string): string {
	return assumeUserStates(stripPseudoElements(unwrapGlobal(selector)));
}

function matchesOrThrow(el: Element, selector: string): boolean {
	try {
		return el.matches(selector);
	} catch (e) {
		throw new Error(`セレクタ「${selector}」を jsdom が解釈できない(${String(e)})`);
	}
}

/** 規則がその要素に当たるか(scoped な主語は持ち主の要素にだけ当たる)。 */
function ruleHits(rule: SourceRule, el: Element): boolean {
	if (!matchesOrThrow(el, nativeSelector(rule.selector))) return false;
	if (rule.component !== null && subjectIsScoped(rule.selector)) return el.getAttribute(OWNER_ATTR) === rule.component;
	return true;
}

function describeElement(el: Element): string {
	const cls = Array.from(el.classList)
		.map((c) => `.${c}`)
		.join('');
	const ce = el.hasAttribute('contenteditable') ? `[contenteditable=${el.getAttribute('contenteditable')}]` : '';
	return `${el.tagName.toLowerCase()}${cls}${ce}`;
}

/** 枠を付ける規則のうち対象の要素に当たるもの(全体の :focus-visible のリングは例外として除く)。 */
function frameAttachers(targets: Element[], rules: SourceRule[]): string[] {
	const out: string[] = [];
	for (const rule of rules) {
		if (isGlobalFocusRing(rule)) continue;
		const frames = frameDecls(rule);
		if (frames.length === 0) continue;
		for (const target of targets) {
			if (!ruleHits(rule, target)) continue;
			const at = rule.atRules.length > 0 ? `${rule.atRules.join(' ')} ` : '';
			const decls = frames.map((d) => `${d.prop}: ${d.value}`).join('; ');
			out.push(`${rule.file}: ${at}${normalizeSelector(rule.selector)} { ${decls} } → ${describeElement(target)}`);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// 強さ(判定 2)
// ---------------------------------------------------------------------------

type Strength = { important: boolean; specificity: Specificity };

/** 画面での詳細度(scoped な部分を持つ `.svelte` の規則は scoping class の (0,1,0) を足す)。 */
function effectiveSpecificity(rule: SourceRule): Specificity {
	const base = specificityOf(unwrapGlobal(rule.selector));
	return rule.component !== null && hasScopedPart(rule.selector) ? add(base, SVELTE_SCOPE_CLASS) : base;
}

function strengthOf(rule: SourceRule, decl: Decl): Strength {
	return { important: /!\s*important$/i.test(decl.value), specificity: effectiveSpecificity(rule) };
}

/** a が b に勝つ(`!important` が先・同じなら詳細度が厳密に大きい)。 */
function beats(a: Strength, b: Strength): boolean {
	if (a.important !== b.important) return a.important;
	return compareSpecificity(a.specificity, b.specificity) > 0;
}

function formatStrength(s: Strength): string {
	return `${formatSpecificity(s.specificity)}${s.important ? ' !important' : ''}`;
}

/** 画面で効く規則(at-rule の外か、`@media screen` の中)。 */
function appliesOnScreen(rule: SourceRule): boolean {
	return rule.atRules.every((a) => /^@media screen$/i.test(a));
}

// ---------------------------------------------------------------------------
// 面(アプリの入れ子)
// ---------------------------------------------------------------------------

type Face = {
	/** 枠が付いてはいけない要素(本文の容れ物・面の要素・エディタの根・中身)。 */
	targets: Element[];
	/** フォーカスが乗る要素(エディタの contenteditable の根)。 */
	focusTarget: Element;
};

function el(tag: string, className: string, parent: Element, owner: string | null): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (owner !== null) node.setAttribute(OWNER_ATTR, owner);
	parent.appendChild(node);
	return node;
}

/** 共通の入れ子(+page → Viewer)。Viewer の本文の容れ物 `.markdown-body` を返す。 */
function buildViewerShell(): HTMLElement {
	document.body.innerHTML = '';
	const app = el('div', 'app', document.body, PAGE_OWNER);
	const appBody = el('div', 'app-body', app, PAGE_OWNER);
	const viewerStack = el('div', 'viewer-stack', appBody, PAGE_OWNER);
	const viewerMain = el('div', 'viewer-main', viewerStack, PAGE_OWNER);
	const viewer = el('article', 'viewer', viewerMain, 'Viewer');
	el('header', 'viewer-toolbar', viewer, 'Viewer');
	return el('div', 'markdown-body', viewer, 'Viewer');
}

/**
 * 本物の CodeMirror を `host` に載せ、[.cm-editor, .cm-scroller, .cm-content, .cm-line] を返す。
 * 拡張は面と同じ折り返し・content の属性(CodeEditor.svelte 438〜439・RawSourceEditor.svelte 189〜190)。
 */
function mountCodeMirror(host: HTMLElement): Element[] {
	const view = new EditorView({
		parent: host,
		doc: 'first line\nsecond line\n',
		extensions: [
			EditorView.lineWrapping,
			EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
		],
	});
	views.push(view);
	// フォーカス中の面(CodeMirror はフォーカス中に .cm-editor へ cm-focused を付ける)
	view.dom.classList.add('cm-focused');
	const line = view.contentDOM.querySelector('.cm-line');
	expect(view.dom.classList.contains('cm-editor'), '前提: CodeMirror の根は .cm-editor').toBe(true);
	expect(view.scrollDOM.classList.contains('cm-scroller'), '前提: .cm-scroller がある').toBe(true);
	expect(view.contentDOM.classList.contains('cm-content'), '前提: .cm-content がある').toBe(true);
	expect(view.contentDOM.getAttribute('contenteditable'), '前提: .cm-content は contenteditable="true"').toBe('true');
	expect(line, '前提: .cm-line がある').not.toBeNull();
	return [view.dom, view.scrollDOM, view.contentDOM, line!];
}

function buildMarkdownFace(): Face {
	const body = buildViewerShell();
	const editor = el('div', 'markdown-editor', body, 'MarkdownEditor');
	editor.setAttribute('data-testid', 'markdown-editor');
	const surface = el('div', 'markdown-editor-surface', editor, 'MarkdownEditor');
	const root = el('div', 'ProseMirror markdown-body ProseMirror-focused', surface, null);
	root.setAttribute('contenteditable', 'true');
	root.setAttribute('translate', 'no');
	root.setAttribute('autocapitalize', 'off');
	root.setAttribute('autocorrect', 'off');
	el('h1', '', root, null).textContent = 'Heading';
	el('p', '', root, null).textContent = 'Paragraph.';
	el('p', '', el('li', '', el('ul', '', root, null), null), null).textContent = 'Item';
	el('p', '', el('blockquote', '', root, null), null).textContent = 'Quote';
	el('code', '', el('pre', '', root, null), null).textContent = 'code';
	const row = el('tr', '', el('tbody', '', el('table', '', root, null), null), null);
	el('p', '', el('td', '', row, null), null).textContent = 'Cell';
	return { targets: [body, editor, surface, root, ...Array.from(root.querySelectorAll('*'))], focusTarget: root };
}

function buildCodeFace(lang: string | null): Face {
	const body = buildViewerShell();
	const wrapper = el('div', 'code-editor vellis-plaintext', body, 'CodeEditor');
	wrapper.setAttribute('data-testid', 'code-editor');
	wrapper.setAttribute('data-code-theme', 'github-light');
	if (lang !== null) wrapper.setAttribute('data-vellis-lang', lang);
	const surface = el('div', 'code-editor-surface', wrapper, 'CodeEditor');
	const cm = mountCodeMirror(surface);
	return { targets: [body, wrapper, surface, ...cm], focusTarget: cm[2] };
}

function buildRawFace(): Face {
	const body = buildViewerShell();
	const editor = el('div', 'markdown-editor', body, 'MarkdownEditor');
	editor.setAttribute('data-testid', 'markdown-editor');
	const raw = el('div', 'raw-source-editor', editor, 'RawSourceEditor');
	raw.setAttribute('data-testid', 'raw-source-editor');
	raw.setAttribute('data-vellis-lang', 'markdown');
	const rawSurface = el('div', 'raw-source-surface', raw, 'RawSourceEditor');
	// raw の間、ProseMirror の面の host は空(MarkdownEditor.svelte 203)
	const surface = el('div', 'markdown-editor-surface', editor, 'MarkdownEditor');
	const cm = mountCodeMirror(rawSurface);
	return { targets: [body, editor, raw, rawSurface, ...cm, surface], focusTarget: cm[2] };
}

/** フォーカスが乗っているとみなす印を付ける(自身に focus・自身と祖先に focus-within)。 */
function markAssumedFocus(target: Element): void {
	target.setAttribute(FOCUS_ATTR, '');
	for (let n: Element | null = target; n !== null; n = n.parentElement) n.setAttribute(FOCUS_WITHIN_ATTR, '');
}

function buildFocused(build: () => Face): Face {
	const face = build();
	expect(face.focusTarget.getAttribute('contenteditable'), '前提: フォーカスが乗る要素は contenteditable="true"').toBe('true');
	expect(face.targets[0].classList.contains('markdown-body'), '前提: 最初の対象は Viewer の本文の容れ物').toBe(true);
	expect(face.targets[0].contains(face.focusTarget), '前提: 面は Viewer の .markdown-body の中にある').toBe(true);
	markAssumedFocus(face.focusTarget);
	return face;
}

const FACES: [name: string, build: () => Face][] = [
	['markdown(MarkdownEditor の ProseMirror の面)', buildMarkdownFace],
	['code(CodeEditor・コードのファイル)', () => buildCodeFace('typescript')],
	['text(CodeEditor・plain text)', () => buildCodeFace(null)],
	['raw(MarkdownEditor の raw = RawSourceEditor の面)', buildRawFace],
];

/** CodeMirror の面(CodeEditor と RawSourceEditor)。判定 3 の対象。 */
const CODEMIRROR_FACES: [name: string, build: () => Face][] = [
	['code(CodeEditor・コードのファイル)', () => buildCodeFace('typescript')],
	['text(CodeEditor・plain text)', () => buildCodeFace(null)],
	['raw(MarkdownEditor の raw = RawSourceEditor の面)', buildRawFace],
];

// ---------------------------------------------------------------------------
// 判定器の自己検査
// ---------------------------------------------------------------------------

describe('判定器の自己検査(編集面の枠の判定が甘くないこと)', () => {
	test.each<[selector: string, expected: Specificity]>([
		['.a', [0, 1, 0]],
		[':focus-visible', [0, 1, 0]],
		['.markdown-editor-surface .ProseMirror', [0, 2, 0]],
		[".markdown-body [contenteditable='true']", [0, 2, 0]],
		['.ͼ1 .cm-content', [0, 2, 0]],
		['.code-editor-surface .cm-editor.cm-focused', [0, 3, 0]],
		['.a :not(.b, #c)', [1, 1, 0]],
		[':where(.a .b) .c', [0, 1, 0]],
		['#x::before', [1, 0, 1]],
		['li:nth-child(2n+1)', [0, 1, 1]],
	])('詳細度: %s = %j', (selector, expected) => {
		expect(specificityOf(selector)).toEqual(expected);
	});

	test('Svelte の scoped: 複合セレクタの分け方・主語が :global() か・scoped な部分があるか・画面での詳細度', () => {
		expect(compoundsOf('.a > .b + .c ~ .d .e')).toEqual(['.a', '.b', '.c', '.d', '.e']);
		expect(compoundsOf("li:nth-child(2n+1) [data-x='a b'] :global(.p .q)")).toEqual([
			'li:nth-child(2n+1)',
			"[data-x='a b']",
			':global(.p .q)',
		]);
		expect(subjectIsScoped(".markdown-body :global([contenteditable='true'])")).toBe(false);
		expect(subjectIsScoped('.markdown-editor-surface :global(.ProseMirror)')).toBe(false);
		expect(subjectIsScoped('.markdown-editor-surface :global(.ProseMirror::after)')).toBe(false);
		expect(subjectIsScoped(':global(.a .b)')).toBe(false);
		expect(subjectIsScoped(':global(.a) .b')).toBe(true);
		expect(subjectIsScoped('.find-input:focus')).toBe(true);
		expect(hasScopedPart(':global(.a .b)')).toBe(false);
		expect(hasScopedPart(".markdown-body :global([contenteditable='true'])")).toBe(true);

		const one = (css: string, component: string | null) => {
			const rules = rulesFromCss(css, 'x', component);
			expect(rules).toHaveLength(1);
			return effectiveSpecificity(rules[0]);
		};
		expect(one('.markdown-editor-surface :global(.ProseMirror) { outline: none }', 'MarkdownEditor')).toEqual([0, 3, 0]);
		expect(one(".markdown-body :global([contenteditable='true']) { outline: 2px solid red }", 'Viewer')).toEqual([0, 3, 0]);
		expect(one('.code-editor-surface :global(.cm-editor.cm-focused) { outline: none }', 'CodeEditor')).toEqual([0, 4, 0]);
		expect(one(':global(.ProseMirror) { outline: none }', 'MarkdownEditor')).toEqual([0, 1, 0]);
		expect(one(':focus-visible { outline: 2px solid red }', null)).toEqual([0, 1, 0]);
		expect(one('.ͼ1 .cm-content {margin: 0; outline: none}', null)).toEqual([0, 2, 0]);
	});

	test('状態の擬似クラスと擬似要素の当て方', () => {
		expect(assumeUserStates('.a:focus-visible')).toBe(`.a[${FOCUS_ATTR}]`);
		expect(assumeUserStates('.a:focus')).toBe(`.a[${FOCUS_ATTR}]`);
		expect(assumeUserStates('.a:focus-within')).toBe(`.a[${FOCUS_WITHIN_ATTR}]`);
		expect(assumeUserStates('.a:hover')).toBe(`.a:not([${NEVER_ATTR}])`);
		expect(assumeUserStates('.a:active')).toBe(`.a:not([${NEVER_ATTR}])`);
		expect(assumeUserStates('input:-webkit-autofill')).toBe(`input:not([${NEVER_ATTR}])`);
		expect(assumeUserStates('.a:not(:focus)')).toBe(`.a:not([${FOCUS_ATTR}])`);
		expect(stripPseudoElements('.a::before')).toBe('.a');
		expect(stripPseudoElements('.a:after')).toBe('.a');
		expect(stripPseudoElements('::selection')).toBe('*');
		expect(stripPseudoElements('.a ::marker')).toBe('.a *');
		expect(nativeSelector(':global(.ProseMirror:focus-visible::after)')).toBe(`.ProseMirror[${FOCUS_ATTR}]`);
		expect(hasPseudoElement('.a::before')).toBe(true);
		expect(hasPseudoElement('.a:hover')).toBe(false);
	});

	test('強さの比較と、画面で効く規則', () => {
		const s = (important: boolean, specificity: Specificity): Strength => ({ important, specificity });
		expect(beats(s(false, [0, 3, 0]), s(false, [0, 1, 0]))).toBe(true);
		expect(beats(s(false, [0, 2, 0]), s(false, [0, 1, 0]))).toBe(true);
		expect(beats(s(false, [0, 1, 0]), s(false, [0, 1, 0]))).toBe(false);
		expect(beats(s(false, [0, 0, 1]), s(false, [0, 1, 0]))).toBe(false);
		expect(beats(s(true, [0, 0, 0]), s(false, [1, 0, 0]))).toBe(true);
		expect(beats(s(false, [1, 0, 0]), s(true, [0, 0, 0]))).toBe(false);
		const at = (css: string) => rulesFromCss(css, 'x', null).map(appliesOnScreen);
		expect(at('.a { outline: none }')).toEqual([true]);
		expect(at('@media screen { .a { outline: none } }')).toEqual([true]);
		expect(at('@media print { .a { outline: none } }')).toEqual([false]);
		expect(at('@media (prefers-color-scheme: dark) { .a { outline: none } }')).toEqual([false]);
		expect(rulesFromCss('@keyframes k { to { outline: 1px solid red } }', 'x', null)).toEqual([]);
	});

	test('実物の規則が集まる(解析が空振りしていない)', () => {
		const rings = stylesheetRules().filter(isGlobalFocusRing);
		expect(rings.length, `${GLOBAL_RING_FILE} の ${GLOBAL_RING_SELECTOR} が読める`).toBeGreaterThan(0);
		expect(rings.some((r) => frameDecls(r).some((d) => d.prop === 'outline'))).toBe(true);

		const comps = componentRules();
		const pm = comps.find(
			(r) => r.component === 'MarkdownEditor' && normalizeSelector(r.selector) === '.markdown-editor-surface :global(.ProseMirror)',
		);
		expect(pm, 'MarkdownEditor の面の outline: none が読める').toBeDefined();
		expect(noneDecls(pm!, 'outline')).toHaveLength(1);
		const cmFocused = comps
			.filter((r) => /:global\(\.cm-editor\.cm-focused\)$/.test(normalizeSelector(r.selector)) && noneDecls(r, 'outline').length > 0)
			.map((r) => r.component)
			.sort();
		expect(cmFocused, 'CodeEditor / RawSourceEditor の .cm-editor.cm-focused の outline: none が読める').toEqual([
			'CodeEditor',
			'RawSourceEditor',
		]);
		const findBar = comps.filter((r) => r.component === 'FindBar');
		expect(findBar.some((r) => normalizeSelector(r.selector) === '.find-bar')).toBe(true);
		expect(
			findBar.every((r) => !r.selector.includes('`') && !r.selector.includes('<')),
			'コメントの中の `<style>` の字から規則を拾っていない',
		).toBe(true);
	});

	test('検出器(markdown の面): 撤去した枠の形・フォーカスの規則・容れ物の枠を拾い、持ち主の違う scoped な規則・none・@keyframes は拾わない', () => {
		const face = buildFocused(buildMarkdownFace);
		const [body, editor, surface, root] = face.targets;
		expect(describeElement(root)).toBe('div.ProseMirror.markdown-body.ProseMirror-focused[contenteditable=true]');
		const component = (css: string, name: string) => rulesFromCss(css, `src/components/${name}.svelte`, name);
		const sheet = (css: string, file = 'src/styles/markdown.css') => rulesFromCss(css, file, null);
		const hits = (rules: SourceRule[]) => frameAttachers(face.targets, rules);

		// 撤去したブロック編集の枠(Viewer の scoped な規則・主語は :global)は ProseMirror の根に当たる= 文書全体の枠
		const removed = hits(
			component(
				".markdown-body :global([contenteditable='true']) { outline: 2px solid var(--color-focus-ring); outline-offset: 2px; border-radius: 2px; }",
				'Viewer',
			),
		);
		expect(removed).toEqual([
			`src/components/Viewer.svelte: .markdown-body :global([contenteditable='true']) { outline: 2px solid var(--color-focus-ring) } → ${describeElement(root)}`,
		]);
		// 全体の CSS のフォーカスの規則(状態はその状態とみなす)
		expect(hits(sheet('[contenteditable]:focus { box-shadow: 0 0 0 2px red; }'))).toHaveLength(1);
		// 例外は app.css の :focus-visible だけ(同じ規則でも別の置き場なら拾う)
		expect(hits(sheet(':focus-visible { outline: 2px solid var(--color-focus-ring); }', GLOBAL_RING_FILE))).toEqual([]);
		expect(hits(sheet(':focus-visible { outline: 2px solid var(--color-focus-ring); }'))).toHaveLength(1);
		// 容れ物の focus-within(文書全体の枠になる形)。ProseMirror の根も class markdown-body だが Viewer の持ち物ではない
		expect(hits(component('.markdown-body:focus-within { box-shadow: inset 0 0 0 1px red; }', 'Viewer'))).toEqual([
			`src/components/Viewer.svelte: .markdown-body:focus-within { box-shadow: inset 0 0 0 1px red } → ${describeElement(body)}`,
		]);
		// scoped な主語は持ち主の要素にだけ当たる
		expect(hits(component('div:focus-visible { outline: 2px solid red; }', 'ContextMenu'))).toEqual([]);
		expect(hits(component('div:hover { outline: 1px solid red; }', 'MarkdownEditor'))).toEqual([
			`src/components/MarkdownEditor.svelte: div:hover { outline: 1px solid red } → ${describeElement(editor)}`,
			`src/components/MarkdownEditor.svelte: div:hover { outline: 1px solid red } → ${describeElement(surface)}`,
		]);
		// at-rule の中も数える・擬似要素は元の要素に当てる・none と @keyframes の中は数えない
		expect(hits(component('@media print { :global(.ProseMirror) { outline: 1px solid red; } }', 'MarkdownEditor'))).toHaveLength(1);
		expect(hits(component('.markdown-editor-surface :global(.ProseMirror::after) { box-shadow: 0 0 0 1px red; }', 'MarkdownEditor'))).toHaveLength(1);
		expect(hits(component(':global(.ProseMirror) { outline: none; box-shadow: none !important; }', 'MarkdownEditor'))).toEqual([]);
		expect(hits(component('@keyframes k { to { outline: 1px solid red; } }', 'MarkdownEditor'))).toEqual([]);
		// 中身のブロックにも当てる
		expect(hits(sheet('.ProseMirror td p { box-shadow: 0 0 0 1px red; }'))).toHaveLength(1);
	});

	test('検出器(code の面): 撤去した枠の形は本物の CodeMirror の .cm-content に当たり、ソース編集の縦帯の形は今の面に当たらない', () => {
		const face = buildFocused(() => buildCodeFace('typescript'));
		const content = face.focusTarget;
		const viewer = (css: string) => rulesFromCss(css, 'src/components/Viewer.svelte', 'Viewer');
		expect(
			frameAttachers(face.targets, viewer(".markdown-body :global([contenteditable='true']) { outline: 2px solid var(--color-focus-ring); }")),
		).toEqual([
			`src/components/Viewer.svelte: .markdown-body :global([contenteditable='true']) { outline: 2px solid var(--color-focus-ring) } → ${describeElement(content)}`,
		]);
		// CodeEditor の根は .vellis-plaintext だが contenteditable を持たない(縦帯の形は print-edit-marks の (c) が拾う)
		expect(
			frameAttachers(face.targets, viewer(".vellis-plaintext[contenteditable='true'] { outline: none; box-shadow: inset 3px 0 0 var(--color-focus-ring); }")),
		).toEqual([]);
		// 判定 2 の前提: 本物の EditorView が <head> に既定のテーマを差している
		const cmRules = codeMirrorInjectedRules();
		expect(cmRules.length, `${CODEMIRROR_FILE} が読める`).toBeGreaterThan(0);
		expect(
			cmRules.some((r) => noneDecls(r, 'outline').length > 0 && ruleHits(r, content)),
			'CodeMirror の既定のテーマが .cm-content に outline: none を当てている',
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 判定 1 — 編集面とその容れ物に、枠を付ける規則が無い
// ---------------------------------------------------------------------------

describe('要件#74 — 編集面とその容れ物に、枠(none 以外の outline / box-shadow)を付ける規則が無い', () => {
	test.each(FACES)(
		'%s: src/components/*.svelte と src/styles/*.css の規則のうち、none 以外の outline / box-shadow を宣言して当たるものが無い(全体の :focus-visible のリングを除く)',
		(_name, build) => {
			const face = buildFocused(build);
			const offenders = frameAttachers(face.targets, srcRules());
			expect(
				offenders,
				'編集面(本文の容れ物・面の要素・エディタの根・中身)に枠を付ける規則が無いこと' +
					'(撤去した要件49 契約①のブロック編集の枠が文書全体を囲んでいた= 2026-11-20 由谷の手試し)',
			).toEqual([]);
		},
	);
});

// ---------------------------------------------------------------------------
// 判定 2 — 例外の全体の :focus-visible のリングより、各面の outline: none が強い
// ---------------------------------------------------------------------------

describe('要件#56 契約 4 の例外 — 全体の :focus-visible のリングより、各面の outline: none が強い', () => {
	test.each(FACES)(
		'%s: フォーカスの乗る要素に全体のリングが当たり、それより強い outline: none が画面で効く',
		(_name, build) => {
			const face = buildFocused(build);
			const target = face.focusTarget;
			const src = srcRules();
			const rings = src.filter((r) => isGlobalFocusRing(r) && frameDecls(r).length > 0);
			expect(rings.length, `前提: ${GLOBAL_RING_FILE} に全体の ${GLOBAL_RING_SELECTOR} のリングがある`).toBeGreaterThan(0);
			const guards = [...src, ...codeMirrorInjectedRules()].filter(
				(r) => appliesOnScreen(r) && !hasPseudoElement(r.selector),
			);
			for (const ring of rings) {
				expect(
					ruleHits(ring, target),
					`前提: 全体のリングがフォーカスの乗る要素 ${describeElement(target)} に当たる`,
				).toBe(true);
				for (const decl of frameDecls(ring)) {
					const prop = decl.prop.toLowerCase();
					const ringStrength = strengthOf(ring, decl);
					const hitting = guards.flatMap((rule) => {
						const nones = noneDecls(rule, prop);
						if (nones.length === 0 || !ruleHits(rule, target)) return [];
						return nones.map((d) => ({ rule, strength: strengthOf(rule, d) }));
					});
					const winners = hitting.filter((h) => beats(h.strength, ringStrength));
					expect(
						winners.length,
						`${describeElement(target)}: 画面で効く「${prop}: none」のうち、全体のリング` +
							`(${GLOBAL_RING_FILE} ${GLOBAL_RING_SELECTOR} = ${formatStrength(ringStrength)})より強いものが 1 つはあること` +
							`(等しいは読み込み順に依存するので不合格)。当たった ${prop}: none: ` +
							JSON.stringify(hitting.map((h) => `${h.rule.file}: ${normalizeSelector(h.rule.selector)} = ${formatStrength(h.strength)}`)),
					).toBeGreaterThan(0);
				}
			}
		},
	);
});

// ---------------------------------------------------------------------------
// 判定 3 — CodeMirror 自身の点線の枠より、CodeEditor / RawSourceEditor の outline: none が強い
// ---------------------------------------------------------------------------

describe('CodeMirror の点線の枠 — CodeEditor / RawSourceEditor の面で、src の outline: none が CodeMirror の既定のテーマより強い', () => {
	test.each(CODEMIRROR_FACES)(
		'%s: フォーカスのある .cm-editor.cm-focused に CodeMirror の既定のテーマの枠が当たり、それより強い src の outline: none が画面で効く',
		(_name, build) => {
			const face = buildFocused(build);
			const editor = face.targets.find((e) => e.classList.contains('cm-editor'));
			expect(editor, '前提: 面の中に本物の CodeMirror の .cm-editor がある').toBeDefined();
			expect(editor!.classList.contains('cm-focused'), '前提: .cm-editor はフォーカス中(cm-focused)').toBe(true);
			const onScreen = (r: SourceRule) => appliesOnScreen(r) && !hasPseudoElement(r.selector);

			const frames = codeMirrorInjectedRules()
				.filter(onScreen)
				.flatMap((rule) => {
					const decls = frameDecls(rule);
					if (decls.length === 0 || !ruleHits(rule, editor!)) return [];
					return decls.map((d) => ({ rule, prop: d.prop.toLowerCase(), value: d.value, strength: strengthOf(rule, d) }));
				});
			expect(
				frames.some((f) => f.prop === 'outline'),
				`前提: CodeMirror の既定のテーマ(${CODEMIRROR_FILE})の点線の枠が ${describeElement(editor!)} に当たる`,
			).toBe(true);

			const guards = srcRules().filter(onScreen);
			for (const frame of frames) {
				const hitting = guards.flatMap((rule) => {
					const nones = noneDecls(rule, frame.prop);
					if (nones.length === 0 || !ruleHits(rule, editor!)) return [];
					return nones.map((d) => ({ rule, strength: strengthOf(rule, d) }));
				});
				const winners = hitting.filter((h) => beats(h.strength, frame.strength));
				expect(
					winners.length,
					`${describeElement(editor!)}: src の画面で効く「${frame.prop}: none」のうち、CodeMirror の枠` +
						`(${normalizeSelector(frame.rule.selector)} { ${frame.prop}: ${frame.value} } = ${formatStrength(frame.strength)})` +
						'より強いものが 1 つはあること(等しいは読み込み順に依存するので不合格)。当たった none: ' +
						JSON.stringify(hitting.map((h) => `${h.rule.file}: ${normalizeSelector(h.rule.selector)} = ${formatStrength(h.strength)}`)),
				).toBeGreaterThan(0);
			}
		},
	);
});
