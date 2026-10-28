/**
 * 要件#48 追補p の受け入れテスト(docs/requirements/req-48.md「追補p」・Issue #773)
 * — 編集に入った直後のキャレットの位置とスクロールの配線(component プロジェクト)
 *
 * 編集に入ると、キャレットがダブルクリックした位置ではなく文書やブロックの先頭へ行き、
 * ソース編集ではスクロールも先頭へ戻る(閲覧の `<pre>` を消して編集の `<pre>` を新しく
 * 作り `focus()` するため)。追補p は、入り方ごとに「どこへキャレットを置くか」と
 * 「スクロールを跳ばさない」を決める。ここは `Viewer.svelte` を JSDOM にマウントし、
 * text 文書・markdown(ブロック編集・コードブロック・ソース編集への誘導)・HTML の
 * 編集面のそれぞれで、**入った直後のキャレットとスクロール**を判定する。既存の
 * wiring(Viewer.edit / blockedit / codeedit / htmledit / source-edit-newline)は
 * 書き換えず、本追補用に新設(家風はそこに倣う)。
 *
 * ## 判定するもの(契約番号は req-48.md 追補p の 1〜5・AC は AC-48-追p の (a)〜(h))
 * - **AC (a)・契約1(a)・3**: text をダブルクリックして入ると、キャレットは閲覧の `<pre>`
 *   でダブルクリックした文字の位置(先頭からの文字数)と同じ文字数の位置に**潰れて**
 *   あり、ダブルクリックで選ばれた単語は選ばれていない。`scrollTop` は入る前と同じで、
 *   キャレットの行が見えている。行頭・行末でも同じ写し
 * - **AC (b)・契約1(b)(d)**: markdown の段落(inline 要素の上を含む)と HTML の編集面の
 *   ブロックのダブルクリックで、そのブロックの中のダブルクリックした文字の位置に潰れた
 *   キャレット(単語は選ばない)。`scrollTop` は入る前のまま
 * - **契約1(a) CRLF・契約2(a)**: CRLF の .txt は閲覧の `<pre>` では HTML の解析で LF 1 文字に
 *   なるが、編集の `<pre>` は原文の `\r\n` を持つ。ダブルクリック(潰れたキャレット)も
 *   Command + E の範囲の両端も、閲覧の位置の手前の改行の数だけ足した**原文の同じ文字**へ写る
 * - **契約3 後段**: 閲覧の選択が画面の外にあるまま Command + E → `scrollTop` を保ち、
 *   キャレットはその位置(画面の外)
 * - **AC (c)・契約1(c)**: コードブロックのダブルクリックで、Shiki の `<span>` を素テキスト
 *   に置き換えた後の、中身の先頭から数えて同じ文字数の位置に潰れたキャレット
 * - **AC (d)・契約1(e)**: 編集できない場所(索引に載るリスト内 fence=入れ子の
 *   **いちばん内側**の索引の要素)のダブルクリックでソース編集に入り、その要素の原文の
 *   範囲の先頭(索引の `position.startOffset`)にキャレット。索引に載らない生 HTML は
 *   2(b) と同じ=画面に見えている最初のブロックの原文の先頭(文書の途中で先頭へ跳ばない)。
 *   どちらもキャレットの行が見えている(契約3)
 * - **AC (e)・契約2**: Command + E(`windowState.beginEdit()`)で、閲覧の本文の中に選択が
 *   あればその位置(text は文字数で写し、範囲は範囲のまま・markdown は選択の始まりを
 *   含む、索引に載るいちばん内側のブロック(引用の中の段落なら段落)の原文の先頭に
 *   潰して)。無ければ画面の位置を保つ(text は `scrollTop` を保って見えている最初の行の
 *   先頭・markdown は見えている最初のブロックの原文の先頭に置き、その行が画面の上の方に
 *   見えるようにスクロール)。本文の外の選択は「無い」扱い
 * - **AC (f)・契約1 末尾**: 位置が取れない(`caretRangeFromPoint` が無い・null を返す・
 *   閲覧の要素の外=ツールバーの中を返す)ときは、閲覧の選択(ダブルクリックの単語)が
 *   あればその**始まりに潰して**(2(a) の位置)、無ければ 2(b)(text: `scrollTop` を保ち、
 *   見えている最初の行の先頭)。ブロック編集で位置が取れなければそのブロックの先頭
 * - **AC (g)・契約4**: 入った後の書き戻し(外部変更の `apply`)でキャレットを置き直さず、
 *   フォーカスも奪わない(今の `focusedEditor` の約束のまま。入り方は (a) なので実装前は
 *   (a) の前提で赤・実装後に置き直しが無いことを固定する)
 * - **AC (h)・契約5**: 既存テストの無改変は本ファイルでは判定しない(フルスイート)
 *
 * ## 判定しないもの
 * - 本物の WKWebView でのダブルクリック(ネイティブの単語選択・`caretRangeFromPoint` の
 *   実寸・`focus()` のスクロール)・Shadow DOM の中の本物の選択 → E2E
 *   (tests/e2e/specs/req48p-edit-caret-gate.e2e.ts)と人間ゲート(req-48.md 追補p)
 * - html 文書のソース編集(契約2(c)=今のまま先頭)・HTML の編集面で位置が取れないとき
 *   (ブロックの先頭。markdown のブロック編集の同じ形で判定している)
 *
 * ## JSDOM での判定の形(偽物のレイアウト)
 * JSDOM にはレイアウトが無い(`getBoundingClientRect` は全部 0・`caretRangeFromPoint` と
 * `elementFromPoint` は無い・`Range` に矩形が無い)。そこで**1 つのレイアウトの模型**を
 * 決め、位置に関わる API をすべてその模型から答える偽物に差し替える(`installLayout`)。
 * どの経路(`caretRangeFromPoint` / `elementFromPoint` / 要素や Range の矩形 /
 * `scrollTop` と行の高さの計算)で位置を求めても同じ答えになる:
 * - スクロール容器 `article.viewer`: 矩形 top=0・高さ `VIEW_H`=400・`scrollTop` は
 *   accessor(JSDOM の実装差を避ける=findfix wiring の家風)。sticky のツールバー
 *   `header.viewer-toolbar` は viewport 座標で常に 0..`TOOLBAR_H`=40 を覆う。
 *   **見えている**=viewport の y が `TOOLBAR_H` 以上 `VIEW_H` 未満(ツールバーの裏は
 *   見えていない。tasks/lessons.md 2026-10-05「sticky ツールバーの下端を基準に」)
 * - 本文 `.markdown-body` は文書座標 `BODY_TOP`=40 から始まる。`pre.vellis-plaintext`
 *   (閲覧の text・編集の `<pre>` どちらも)は 1 行 `LINE_H`=20px・1 文字 `CHAR_W`=10px
 *   の等幅で、行 i の文書座標の上端は `BODY_TOP + i*LINE_H`。markdown の本文の直下の
 *   ブロック(と HTML 編集面の葉ブロック)は DOM 順に 1 つ `BLOCK_H`=60px を占め、
 *   ブロックの中では x から文字数(`floor(x / CHAR_W)`=そのブロックの `textContent` 上の
 *   文字数。見た目の行には畳まない)を決める
 * - `document.caretRangeFromPoint(x, y)`: 模型でその点にある文字の直前に潰れた Range。
 *   ツールバーの上(y < 40)はツールバーの中の Range(閲覧の要素の外)、模型のどこにも
 *   当たらなければ null
 * - `Range.prototype.getBoundingClientRect` / `getClientRects`: Range の始点の文字の
 *   行の矩形(`pre` は行ごと・ブロックは `BLOCK_H`)
 * - `getComputedStyle(pre).lineHeight` が `LINE_H` を返すよう `<style>` を入れる
 * - **`HTMLElement.prototype.focus` の偽物**(WKWebView で 2026-10-28 に確かめた事実の
 *   再現): WebKit は、選択が**すでにその要素の中にあれば保ち**(同じ要素を contenteditable
 *   にして focus すると単語の選択が残る)、外にあれば要素の先頭へ潰れたキャレットを置く。
 *   JSDOM 29 の本物の `focus()` は無条件に `collapse(this, 0)` するので、偽物は中にある
 *   選択を控えて本物を呼んだ後に戻す(本物が置く選択は記録係に載せない)。さらに
 *   `preventScroll` が無ければそのキャレットの行が見えるまで容器の `scrollTop` を動かす
 *   (新しい `<pre>` の 0 文字目へ=先頭へ戻る)。`preventScroll: true` なら動かさない。
 *   よって「`scrollTop` が入る前のまま」は、`focus({ preventScroll: true })` でも入った
 *   あとに戻しても緑で、何もしなければ赤。同じ要素のブロック編集では、単語の選択を
 *   潰さない実装が赤になる(WebKit と同じ理由)
 * - `offsetTop` / `offsetHeight`(`HTMLElement.prototype` の getter)も模型どおり
 *   (容器を offsetParent とみなした文書座標の上端と高さ)。`getBoundingClientRect` と
 *   同じ答えになるので、どちらで位置を求める実装でも縛らない
 * - ダブルクリックの**単語選択**は JSDOM では起きないので、dblclick を送る前にその単語を
 *   閲覧の DOM で選んでおく(ブラウザは 2 回目の mouseup で選び、そのあと dblclick が届く)
 * - Shadow DOM の中の Range は JSDOM の `Selection.addRange` が捨てる(root が document で
 *   ない)。HTML の編集面(契約1(d))だけは、`Selection.prototype` の置き口
 *   (`addRange` / `collapse` / `setPosition` / `setBaseAndExtent` / `extend` /
 *   `selectAllChildren`)を記録する**選択の記録係**で「Viewer が置こうとした位置」を判定する
 *   (offset の計算は `caretRangeFromPoint` が返した Range と同じ文字数へ写っていること)。
 *   Shadow の外のケースは本物の `window.getSelection()` で判定する
 *
 * ## スタブの設計(Viewer.edit.wiring.test.ts の家風)
 * - $lib/ipc / @tauri-apps/plugin-opener / @tauri-apps/plugin-dialog: モジュールモック
 *   (dialog は `ask` と `message` の両方を置く=Issue #769)
 * - $lib/mermaid-mounter: markdown は本番パイプライン(`render`)を通すので、mermaid の
 *   dynamic import を発火させない
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { NodeMeta, SourceIndex } from '../markdown/types';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
	openUrl: vi.fn(async () => undefined),
	openPath: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), message: vi.fn() }));
vi.mock('$lib/mermaid-mounter', () => ({
	mountMermaid: vi.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// レイアウトの模型(ヘッダ「JSDOM での判定の形」)
// ---------------------------------------------------------------------------

/** スクロール容器(`article.viewer`)の高さ。 */
const VIEW_H = 400;
/** sticky のツールバーの高さ=本文の見えている範囲の上端。 */
const TOOLBAR_H = 40;
/** 本文(`.markdown-body`)の文書座標の上端(ツールバーの直下)。 */
const BODY_TOP = TOOLBAR_H;
/** `pre.vellis-plaintext` の 1 行の高さ。 */
const LINE_H = 20;
/** 1 文字の幅(等幅)。 */
const CHAR_W = 10;
/** markdown の本文の直下のブロック・HTML 編集面の葉ブロックが 1 つ占める高さ。 */
const BLOCK_H = 60;
/** 見えている範囲の高さ。 */
const VISIBLE_H = VIEW_H - TOOLBAR_H;

/** `pre.vellis-plaintext` の行 i(0 起点)の viewport の y(行の真ん中)。 */
function lineClientY(line: number, scrollTop: number): number {
	return BODY_TOP + line * LINE_H - scrollTop + LINE_H / 2;
}

/** 文字 col(0 起点)の viewport の x(文字の真ん中)。 */
function colClientX(col: number): number {
	return col * CHAR_W + CHAR_W / 2;
}

/** 本文の直下のブロック i の viewport の y(ブロックの真ん中)。 */
function blockClientY(block: number, scrollTop: number): number {
	return BODY_TOP + block * BLOCK_H - scrollTop + BLOCK_H / 2;
}

/** ブロック i の上端がちょうど見えている範囲の上端に来る `scrollTop`。 */
function scrollTopShowingBlock(block: number): number {
	return block * BLOCK_H;
}

/** 行 i の上端がちょうど見えている範囲の上端に来る `scrollTop`。 */
function scrollTopShowingLine(line: number): number {
	return line * LINE_H;
}

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const TXT_URI = 'file:///Users/a/notes/long.txt';
const LINE_COUNT = 80;
/** 全行 24 文字(`line NN alpha beta gamma`)。'alpha' = 8..13・'beta' = 14..18。 */
function lineText(i: number): string {
	return `line ${String(i).padStart(2, '0')} alpha beta gamma`;
}
const LINE_LEN = lineText(0).length;
const LINE_STRIDE = LINE_LEN + 1;
const TXT_CONTENT = Array.from({ length: LINE_COUNT }, (_, i) => lineText(i)).join('\n') + '\n';
/** 行 i の先頭の文字数。 */
function lineStart(i: number): number {
	return i * LINE_STRIDE;
}

/** 途中までスクロールした状態(行 50 の上端が見えている範囲の上端)。 */
const SCROLLED = scrollTopShowingLine(50);
/** `SCROLLED` で見えている最初の行。 */
const FIRST_VISIBLE_LINE = 50;
/** ダブルクリックする行と文字('alpha' の 'p')。 */
const CLICK_LINE = 55;
const CLICK_COL = 10;
const CLICK_OFFSET = lineStart(CLICK_LINE) + CLICK_COL;
/** 'alpha' の範囲(ダブルクリックでブラウザが選ぶ単語)。 */
const ALPHA: [number, number] = [8, 13];

const MD_URI = 'file:///Users/a/notes/caret.md';
const LONG_PARA_LINES = 30;
/**
 * 本文の直下のブロック(DOM 順): 0=h1・1=長い段落(原文 30 行)・2=code fence・
 * 3=対象の段落・4=生 HTML(索引に載らない)・5=リスト(fence 入り=ソース編集へ誘導)・
 * 6=引用(中に段落=入れ子の「いちばん内側」の判定用)。
 * 対象の段落は原文 39 行目(0 起点 38)= `scrollTop` 0 では編集の `<pre>` で見えない。
 */
const MD_LINES = [
	'# Caret Title',
	'',
	...Array.from(
		{ length: LONG_PARA_LINES },
		(_, i) => `Long paragraph line ${String(i + 1).padStart(2, '0')} keeps going.`,
	),
	'',
	'```javascript',
	'const x = 1;',
	'let y = 2;',
	'```',
	'',
	'Target paragraph with **bold** word.',
	'',
	'<div class="raw">raw html block</div>',
	'',
	'- listed item with fence:',
	'  ```javascript',
	'  const nested = 2;',
	'  ```',
	'',
	'> quoted paragraph inside a blockquote.',
	'',
];
const MD = MD_LINES.join('\n');
const TARGET_TEXT = 'Target paragraph with bold word.';
const CODE_BODY = 'const x = 1;\nlet y = 2;';
const BLOCK_HEADING = 0;
const BLOCK_CODE = 2;
const BLOCK_TARGET = 3;
const BLOCK_RAW = 4;
const BLOCK_LIST = 5;
const BLOCK_QUOTE = 6;
/** 対象の段落の 'paragraph' の先頭(7)と 'bold' の 'o'(23)。 */
const TARGET_COL_PARAGRAPH = 7;
const TARGET_WORD_PARAGRAPH: [number, number] = [7, 16];
const TARGET_COL_IN_BOLD = 23;
/** code fence の中身の 'x'(6)と 'y'(17。`textContent` 上の文字数=見た目の行には畳まない)。 */
const CODE_COL_X = 6;
const CODE_COL_Y = 17;
/** リスト項目の `textContent`('listed item with fence:' の 23 文字の後ろ)で fence の中に当たる文字数。 */
const LIST_COL_IN_FENCE = 30;

const HTML_URI = 'file:///Users/a/site/page.html';
const HTML_SRC = [
	'<!doctype html>',
	'<html>',
	'<head>',
	'<title>Page</title>',
	'</head>',
	'<body>',
	'<p id="a" class="x">Hello <b>bold</b> &amp; world</p>',
	'<h2 id="h">Heading</h2>',
	'<pre id="pr">alpha</pre>',
	'</body>',
	'</html>',
	'',
].join('\n');
/** #a の 'bold' の 'b'(6)。 */
const HTML_COL_IN_BOLD = 6;
const HTML_WORD_HELLO: [number, number] = [0, 5];

let rendered: { html: string; index: SourceIndex };

beforeAll(async () => {
	const result = await renderMarkdown(MD, MD_URI);
	rendered = { html: result.html, index: result.index };
	expect(rendered.index.byId.size).toBeGreaterThan(0);
});

function txtDoc(content: string = TXT_CONTENT): DocumentPayload {
	return { uri: TXT_URI, content, modified: 1 };
}

/** file-type.ts の renderPlainText と同形のマークアップ(text 種別の html prop)。 */
function plainTextHtml(content: string): string {
	const escaped = content.replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
	);
	return `<pre class="vellis-plaintext">\n${escaped}</pre>`;
}

function baseProps(doc: DocumentPayload, html: string, index: SourceIndex | null = null) {
	return {
		document: doc,
		html,
		index,
		onRequestAddMark: vi.fn(),
		onToggleMarks: vi.fn(),
		marksOpen: false,
	};
}

/** text 文書を windowState と Viewer の両方に載せてマウントする。 */
function renderText(content: string = TXT_CONTENT) {
	const doc = txtDoc(content);
	windowState.setDocument(doc);
	return render(Viewer, { props: baseProps(doc, plainTextHtml(content)) });
}

/** markdown 文書を本番パイプラインの html と索引でマウントする。 */
function renderMarkdownDoc() {
	const doc: DocumentPayload = { uri: MD_URI, content: MD, modified: 1 };
	windowState.setDocument(doc);
	return render(Viewer, { props: baseProps(doc, rendered.html, rendered.index) });
}

/** html 文書をマウントする(閲覧は HtmlViewer 側なので html:'' / index:null)。 */
function renderHtmlDoc() {
	const doc: DocumentPayload = { uri: HTML_URI, content: HTML_SRC, modified: 1 };
	windowState.setDocument(doc);
	return render(Viewer, { props: baseProps(doc, '') });
}

function q(scope: ParentNode, selector: string): HTMLElement {
	const el = scope.querySelector(selector);
	if (!el) throw new Error(`要素が見つからない: ${selector}`);
	return el as HTMLElement;
}

function body(container: HTMLElement): HTMLElement {
	return q(container, '.markdown-body');
}

/** 本文の直下のブロック(要素だけ・DOM 順)。 */
function blocksOf(container: HTMLElement): HTMLElement[] {
	return [...body(container).children] as HTMLElement[];
}

/** 閲覧の text の `<pre>`(contenteditable でない方)。 */
function viewPre(container: HTMLElement): HTMLElement {
	const pre = container.querySelector('pre.vellis-plaintext:not([contenteditable="true"])');
	if (!pre) throw new Error('閲覧の pre.vellis-plaintext が無い');
	return pre as HTMLElement;
}

/** ソース編集の `<pre contenteditable>`。無ければ落ちる。 */
function editorPre(container: HTMLElement): HTMLElement {
	const pre = container.querySelector('pre.vellis-plaintext[contenteditable="true"]');
	if (!pre) throw new Error('ソース編集の pre(contenteditable="true")が出ていない');
	return pre as HTMLElement;
}

function editables(scope: ParentNode): HTMLElement[] {
	return [...scope.querySelectorAll('[contenteditable="true"]')] as HTMLElement[];
}

/** 対象の段落(`Target paragraph …`)。 */
function targetParagraph(container: HTMLElement): HTMLElement {
	const p = [...container.querySelectorAll('p[data-vellis-node-type="paragraph"]')].find((el) =>
		(el.textContent ?? '').startsWith('Target'),
	);
	if (!p) throw new Error('対象の段落が無い');
	return p as HTMLElement;
}

/** トップレベルの code fence の `<pre>`。 */
function codePre(container: HTMLElement): HTMLElement {
	const pre = blocksOf(container).find((el) => el.matches('pre[data-vellis-node-type="code"]'));
	if (!pre) throw new Error('トップレベルの code fence が無い');
	return pre;
}

/** リスト項目の中の fence の `<pre>`(索引に載るが編集不可=ソース編集へ誘導)。 */
function nestedPre(container: HTMLElement): HTMLElement {
	return q(container, 'li pre[data-vellis-node-type="code"]');
}

/** 引用の中の段落(索引に載る要素の入れ子: blockquote > p)。 */
function quotedParagraph(container: HTMLElement): HTMLElement {
	const bq = blocksOf(container)[BLOCK_QUOTE];
	if (!bq || bq.tagName.toLowerCase() !== 'blockquote') throw new Error('ブロック 6 が blockquote でない');
	return q(bq, 'p[data-vellis-node-type="paragraph"]');
}

/** 索引の meta(`data-vellis-node-id` から)。 */
function metaOf(el: Element): NodeMeta {
	const id = el.getAttribute('data-vellis-node-id');
	const meta = id === null ? undefined : rendered.index.byId.get(id);
	if (!meta) throw new Error('索引に無い要素: ' + el.outerHTML.slice(0, 60));
	return meta;
}

/** 原文の文字数 offset が原文の何行目(0 起点)か。 */
function lineOfOffset(source: string, offset: number): number {
	return (source.slice(0, offset).match(/\n/g) ?? []).length;
}

/** ハンドラが await を連ねても連鎖全体を確定させる(edit wiring の家風)。 */
async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}

// ---------------------------------------------------------------------------
// 選択のヘルパー
// ---------------------------------------------------------------------------

/** `root` の中の文字数 offset(`textContent` 基準)に当たるテキストノードと位置。 */
function locate(root: Node, offset: number): [Text, number] | null {
	const doc = root.ownerDocument ?? document;
	const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
	let seen = 0;
	let last: Text | null = null;
	while (walker.nextNode()) {
		const t = walker.currentNode as Text;
		last = t;
		const len = t.data.length;
		if (offset <= seen + len) return [t, offset - seen];
		seen += len;
	}
	return last ? [last, last.data.length] : null;
}

/** (node, offset) が `root` の `textContent` 上で何文字目か。 */
function textOffsetOf(root: Node, node: Node, offset: number): number {
	const doc = root.ownerDocument ?? document;
	const probe = doc.createRange();
	probe.selectNodeContents(root);
	probe.setEnd(node, offset);
	return probe.toString().length;
}

/** `el` の中の文字数 offset へ、本物の `Selection` でキャレット(または範囲)を置く。 */
function placeSelection(el: HTMLElement, start: number, end: number = start) {
	const a = locate(el, start);
	const b = locate(el, end);
	if (!a || !b) throw new Error('テキストノードが無い');
	const range = document.createRange();
	range.setStart(a[0], a[1]);
	range.setEnd(b[0], b[1]);
	const sel = window.getSelection();
	if (!sel) throw new Error('Selection が取れない');
	sel.removeAllRanges();
	sel.addRange(range);
}

function clearSelection() {
	window.getSelection()?.removeAllRanges();
}

interface SelectionShape {
	/** 選択が 1 つあり、始点も終点も `el` の中にある。 */
	inside: boolean;
	collapsed: boolean;
	/** `el` の `textContent` 上の文字数。`inside` でなければ -1。 */
	start: number;
	end: number;
}

/** 本物の `window.getSelection()` を `el` の中の文字数で読む。 */
function selectionIn(el: HTMLElement): SelectionShape {
	const sel = window.getSelection();
	if (!sel || sel.rangeCount !== 1) return { inside: false, collapsed: false, start: -1, end: -1 };
	const range = sel.getRangeAt(0);
	const inside = el.contains(range.startContainer) && el.contains(range.endContainer);
	if (!inside) return { inside: false, collapsed: range.collapsed, start: -1, end: -1 };
	return {
		inside: true,
		collapsed: range.collapsed,
		start: textOffsetOf(el, range.startContainer, range.startOffset),
		end: textOffsetOf(el, range.endContainer, range.endOffset),
	};
}

/** 潰れたキャレットが `el` の中の `offset` 文字目にあること。 */
function expectCaretAt(el: HTMLElement, offset: number, label = 'キャレット') {
	const shape = selectionIn(el);
	expect(shape.inside, `${label}: 選択が編集する要素の中にあること`).toBe(true);
	expect(shape.collapsed, `${label}: 潰れている(範囲を選んでいない)こと`).toBe(true);
	expect(shape.start, `${label}: 文字数の位置`).toBe(offset);
}

// ---------------------------------------------------------------------------
// 選択の記録係(Shadow DOM の中の Range は JSDOM の Selection が捨てるため)
// ---------------------------------------------------------------------------

interface Placement {
	start: Node;
	startOffset: number;
	end: Node;
	endOffset: number;
}

const placements: Placement[] = [];
let restoreSelectionRecorder: (() => void) | null = null;
/** false の間は記録しない(偽 focus の中で本物の focus が置く選択を載せないため)。 */
let recording = true;

function record(p: Placement) {
	if (recording) placements.push(p);
}

/** `Selection.prototype` の置き口を包み、置こうとした位置を順に記録する。 */
function installSelectionRecorder() {
	const proto = Selection.prototype;
	const orig = {
		addRange: proto.addRange,
		collapse: proto.collapse,
		setPosition: proto.setPosition,
		setBaseAndExtent: proto.setBaseAndExtent,
		extend: proto.extend,
		selectAllChildren: proto.selectAllChildren,
	};
	proto.addRange = function (this: Selection, range: Range) {
		record({
			start: range.startContainer,
			startOffset: range.startOffset,
			end: range.endContainer,
			endOffset: range.endOffset,
		});
		return orig.addRange.call(this, range);
	};
	const collapseLike = (fn: typeof orig.collapse) =>
		function (this: Selection, node: Node | null, offset = 0) {
			if (node) record({ start: node, startOffset: offset, end: node, endOffset: offset });
			return fn.call(this, node, offset);
		};
	proto.collapse = collapseLike(orig.collapse);
	proto.setPosition = collapseLike(orig.setPosition);
	proto.setBaseAndExtent = function (
		this: Selection,
		anchor: Node,
		anchorOffset: number,
		focus: Node,
		focusOffset: number,
	) {
		record({ start: anchor, startOffset: anchorOffset, end: focus, endOffset: focusOffset });
		return orig.setBaseAndExtent.call(this, anchor, anchorOffset, focus, focusOffset);
	};
	proto.extend = function (this: Selection, node: Node, offset = 0) {
		const last = placements[placements.length - 1];
		record({
			start: last?.start ?? node,
			startOffset: last?.startOffset ?? 0,
			end: node,
			endOffset: offset,
		});
		return orig.extend.call(this, node, offset);
	};
	proto.selectAllChildren = function (this: Selection, node: Node) {
		record({ start: node, startOffset: 0, end: node, endOffset: node.childNodes.length });
		return orig.selectAllChildren.call(this, node);
	};
	restoreSelectionRecorder = () => {
		Object.assign(proto, orig);
		restoreSelectionRecorder = null;
	};
	return orig;
}

/** `el` の中に置こうとした記録(順に)。 */
function placementsIn(el: Element): Array<{ collapsed: boolean; start: number; end: number }> {
	return placements
		.filter((p) => el.contains(p.start) && el.contains(p.end))
		.map((p) => ({
			collapsed: p.start === p.end && p.startOffset === p.endOffset,
			start: textOffsetOf(el, p.start, p.startOffset),
			end: textOffsetOf(el, p.end, p.endOffset),
		}));
}

// ---------------------------------------------------------------------------
// レイアウトの模型と偽物の API
// ---------------------------------------------------------------------------

interface Modelled {
	kind: 'lines' | 'block';
	el: Element;
	/** 文書座標(スクロール容器の中)の上端。 */
	docTop: number;
	height: number;
}

interface FocusCall {
	el: Element;
	options: FocusOptions | undefined;
}

function rect(top: number, height: number, left = 0, width = 800): DOMRect {
	return {
		top,
		height,
		bottom: top + height,
		left,
		right: left + width,
		width,
		x: left,
		y: top,
		toJSON: () => ({}),
	} as DOMRect;
}

const EMPTY_RECT = rect(0, 0, 0, 0);

class Layout {
	scrollTop: number;
	readonly focusCalls: FocusCall[] = [];
	private readonly viewer: HTMLElement;
	private readonly toolbar: HTMLElement;
	private readonly bodyEl: HTMLElement;

	constructor(container: HTMLElement, initialScrollTop: number) {
		this.viewer = q(container, 'article.viewer');
		this.toolbar = q(container, 'header.viewer-toolbar');
		this.bodyEl = body(container);
		this.scrollTop = initialScrollTop;
	}

	isViewer(el: Element): boolean {
		return el === this.viewer;
	}

	isToolbar(el: Element): boolean {
		return el === this.toolbar || this.toolbar.contains(el);
	}

	/** 模型に載っている要素(HTML 編集面の葉ブロックを先に・本文の直下のブロックを後に)。 */
	modelled(): Modelled[] {
		const list: Modelled[] = [];
		const host = this.bodyEl.querySelector('[data-testid="html-edit-surface"]');
		const shadow = host?.shadowRoot;
		if (shadow) {
			const leaves = [...shadow.querySelectorAll('p, h1, h2, h3, h4, h5, h6, pre, li')].filter(
				(el) => el.hasAttribute('data-vellis-hid'),
			);
			leaves.forEach((el, j) => {
				list.push({ kind: 'block', el, docTop: BODY_TOP + j * BLOCK_H, height: BLOCK_H });
			});
		}
		[...this.bodyEl.children].forEach((el, i) => {
			if (el.matches('pre.vellis-plaintext')) {
				const lines = (el.textContent ?? '').split('\n').length;
				list.push({ kind: 'lines', el, docTop: BODY_TOP, height: lines * LINE_H });
				return;
			}
			list.push({ kind: 'block', el, docTop: BODY_TOP + i * BLOCK_H, height: BLOCK_H });
		});
		return list;
	}

	blockOf(node: Node | null): Modelled | null {
		if (!node) return null;
		const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
		if (!el) return null;
		for (const m of this.modelled()) {
			if (m.el === el || m.el.contains(el)) return m;
		}
		return null;
	}

	/** 要素の矩形(viewport 座標)。 */
	rectOf(el: Element): DOMRect {
		if (this.isViewer(el)) return rect(0, VIEW_H);
		if (this.isToolbar(el)) return rect(0, TOOLBAR_H);
		const m = this.blockOf(el);
		if (!m) return EMPTY_RECT;
		return rect(m.docTop - this.scrollTop, m.height);
	}

	/** Range の始点の文字の行の矩形(viewport 座標)。 */
	rectOfRange(range: Range): DOMRect {
		const m = this.blockOf(range.startContainer);
		if (!m) return EMPTY_RECT;
		const offset = textOffsetOf(m.el, range.startContainer, range.startOffset);
		if (m.kind === 'block') return rect(m.docTop - this.scrollTop, BLOCK_H, offset * CHAR_W, CHAR_W);
		const text = m.el.textContent ?? '';
		const line = lineOfOffset(text, offset);
		const col = offset - (text.lastIndexOf('\n', offset - 1) + 1);
		return rect(m.docTop + line * LINE_H - this.scrollTop, LINE_H, col * CHAR_W, CHAR_W);
	}

	/** 模型でその点にある要素と、その中の文字数。 */
	private hit(x: number, y: number): { m: Modelled; offset: number } | null {
		const docY = y + this.scrollTop;
		const col = Math.max(0, Math.floor(x / CHAR_W));
		for (const m of this.modelled()) {
			if (docY < m.docTop || docY >= m.docTop + m.height) continue;
			const text = m.el.textContent ?? '';
			if (m.kind === 'block') return { m, offset: Math.min(col, text.length) };
			const line = Math.floor((docY - m.docTop) / LINE_H);
			const lines = text.split('\n');
			const lineText = lines[line];
			if (lineText === undefined) return null;
			let offset = 0;
			for (let i = 0; i < line; i++) offset += (lines[i]?.length ?? 0) + 1;
			return { m, offset: offset + Math.min(col, lineText.length) };
		}
		return null;
	}

	caretRangeFromPoint(x: number, y: number): Range | null {
		if (y < TOOLBAR_H) {
			const r = document.createRange();
			r.setStart(this.toolbar, 0);
			r.collapse(true);
			return r;
		}
		const hit = this.hit(x, y);
		if (!hit) return null;
		const at = locate(hit.m.el, hit.offset);
		if (!at) return null;
		const r = document.createRange();
		r.setStart(at[0], at[1]);
		r.collapse(true);
		return r;
	}

	elementFromPoint(x: number, y: number): Element | null {
		if (y < TOOLBAR_H) return this.toolbar;
		const hit = this.hit(x, y);
		if (hit) {
			const at = locate(hit.m.el, hit.offset);
			return at?.[0].parentElement ?? hit.m.el;
		}
		return y < VIEW_H ? this.viewer : null;
	}

	/**
	 * 本物の focus のあと(ブラウザの既定): 外に選択があれば先頭へ潰し(中にあった選択は
	 * 偽 focus が戻している)、`preventScroll` が無ければキャレットの行が見えるまで動かす。
	 */
	afterFocus(el: HTMLElement, options: FocusOptions | undefined, orig: SelectionOriginals) {
		if (el.getAttribute('contenteditable') !== 'true') return;
		const sel = window.getSelection();
		if (!sel) return;
		const inside = sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).commonAncestorContainer);
		if (!inside) {
			const r = document.createRange();
			r.setStart(el, 0);
			r.collapse(true);
			sel.removeAllRanges();
			orig.addRange.call(sel, r);
		}
		if (options?.preventScroll) return;
		if (sel.rangeCount === 0) return;
		const caret = this.rectOfRange(sel.getRangeAt(0));
		if (caret === EMPTY_RECT) return;
		if (caret.top >= TOOLBAR_H && caret.bottom <= VIEW_H) return;
		this.scrollTop = Math.max(0, caret.top + this.scrollTop - TOOLBAR_H);
	}

	/** 本物の選択のキャレットの行が見えている範囲(ツールバーの下・容器の中)にあるか。 */
	caretVisible(): { visible: boolean; top: number; bottom: number } {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return { visible: false, top: NaN, bottom: NaN };
		const r = this.rectOfRange(sel.getRangeAt(0));
		if (r === EMPTY_RECT) return { visible: false, top: NaN, bottom: NaN };
		return { visible: r.top >= TOOLBAR_H && r.bottom <= VIEW_H, top: r.top, bottom: r.bottom };
	}

	/** 容器の `scrollTop` / 高さ / `scrollTo` と、ツールバーの高さを模型に結ぶ。 */
	install() {
		const viewer = this.viewer;
		const self = this;
		Object.defineProperty(viewer, 'scrollTop', {
			configurable: true,
			get: () => self.scrollTop,
			set: (v: number) => {
				self.scrollTop = Math.max(0, v);
			},
		});
		Object.defineProperty(viewer, 'clientHeight', { value: VIEW_H, configurable: true });
		Object.defineProperty(viewer, 'scrollHeight', {
			get: () => Math.max(VIEW_H, ...self.modelled().map((m) => m.docTop + m.height)),
			configurable: true,
		});
		Object.defineProperty(viewer, 'scrollTo', {
			configurable: true,
			value: (a: ScrollToOptions | number, b?: number) => {
				const top = typeof a === 'number' ? (b ?? 0) : (a.top ?? self.scrollTop);
				self.scrollTop = Math.max(0, top);
			},
		});
		Object.defineProperty(viewer, 'scrollBy', {
			configurable: true,
			value: (a: ScrollToOptions | number, b?: number) => {
				const dy = typeof a === 'number' ? (b ?? 0) : (a.top ?? 0);
				self.scrollTop = Math.max(0, self.scrollTop + dy);
			},
		});
		Object.defineProperty(this.toolbar, 'offsetHeight', { value: TOOLBAR_H, configurable: true });
		Object.defineProperty(this.toolbar, 'clientHeight', { value: TOOLBAR_H, configurable: true });
	}
}

interface SelectionOriginals {
	addRange: Selection['addRange'];
}

let layout: Layout | null = null;
const restorers: Array<() => void> = [];

/**
 * マウント済みの Viewer にレイアウトの模型を付ける(ヘッダ「JSDOM での判定の形」)。
 * 位置に関わる API(矩形・`caretRangeFromPoint`・`elementFromPoint`・`focus`・
 * 行の高さ)をすべて模型から答える偽物にし、`scrollTop` を `initialScrollTop` にする。
 */
function installLayout(container: HTMLElement, initialScrollTop: number): Layout {
	const model = new Layout(container, initialScrollTop);
	model.install();
	layout = model;

	const selOrig = installSelectionRecorder();
	restorers.push(() => restoreSelectionRecorder?.());

	const elRect = Element.prototype.getBoundingClientRect;
	const elRects = Element.prototype.getClientRects;
	Element.prototype.getBoundingClientRect = function (this: Element) {
		return layout ? layout.rectOf(this) : elRect.call(this);
	};
	Element.prototype.getClientRects = function (this: Element) {
		const r = layout ? layout.rectOf(this) : EMPTY_RECT;
		return (r === EMPTY_RECT ? [] : [r]) as unknown as DOMRectList;
	};
	restorers.push(() => {
		Element.prototype.getBoundingClientRect = elRect;
		Element.prototype.getClientRects = elRects;
	});

	const rangeProto = Range.prototype as unknown as Record<string, unknown>;
	const hadRangeRect = Object.prototype.hasOwnProperty.call(rangeProto, 'getBoundingClientRect');
	const hadRangeRects = Object.prototype.hasOwnProperty.call(rangeProto, 'getClientRects');
	const rangeRect = rangeProto.getBoundingClientRect;
	const rangeRects = rangeProto.getClientRects;
	rangeProto.getBoundingClientRect = function (this: Range) {
		return layout ? layout.rectOfRange(this) : EMPTY_RECT;
	};
	rangeProto.getClientRects = function (this: Range) {
		const r = layout ? layout.rectOfRange(this) : EMPTY_RECT;
		return (r === EMPTY_RECT ? [] : [r]) as unknown as DOMRectList;
	};
	restorers.push(() => {
		if (hadRangeRect) rangeProto.getBoundingClientRect = rangeRect;
		else delete rangeProto.getBoundingClientRect;
		if (hadRangeRects) rangeProto.getClientRects = rangeRects;
		else delete rangeProto.getClientRects;
	});

	const docAny = document as unknown as Record<string, unknown>;
	const hadCaret = 'caretRangeFromPoint' in docAny;
	const hadElement = 'elementFromPoint' in docAny;
	Object.defineProperty(document, 'caretRangeFromPoint', {
		configurable: true,
		writable: true,
		value: (x: number, y: number) => layout?.caretRangeFromPoint(x, y) ?? null,
	});
	Object.defineProperty(document, 'elementFromPoint', {
		configurable: true,
		writable: true,
		value: (x: number, y: number) => layout?.elementFromPoint(x, y) ?? null,
	});
	restorers.push(() => {
		if (!hadCaret) delete docAny.caretRangeFromPoint;
		if (!hadElement) delete docAny.elementFromPoint;
	});

	const origFocus = HTMLElement.prototype.focus;
	HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
		layout?.focusCalls.push({ el: this, options });
		// JSDOM 29 の本物の focus は、選択がどこにあっても無条件に `collapse(this, 0)` する
		// (HTMLOrSVGElement-impl.js)。WebKit は選択が**すでにその要素の中にあれば保つ**
		// (req-48 追補p 冒頭の WKWebView の確認)ので、中にある選択は控えて呼んだ後に戻す。
		// 本物の focus が内部で置く選択は記録係に載せない。
		const sel = window.getSelection();
		const current = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
		const kept = current && this.contains(current.commonAncestorContainer) ? current.cloneRange() : null;
		recording = false;
		try {
			origFocus.call(this, options);
		} finally {
			recording = true;
		}
		if (kept && sel) {
			sel.removeAllRanges();
			selOrig.addRange.call(sel, kept);
		}
		layout?.afterFocus(this, options, selOrig);
	};
	restorers.push(() => {
		HTMLElement.prototype.focus = origFocus;
	});

	// 模型の `offsetTop` / `offsetHeight`(実装が `getBoundingClientRect` でなくこちらで
	// 位置を求めても同じ答えになるように。offsetParent は容器とみなし、文書座標の上端を返す)。
	const htmlProto = HTMLElement.prototype;
	const offsetTopDesc = Object.getOwnPropertyDescriptor(htmlProto, 'offsetTop');
	const offsetHeightDesc = Object.getOwnPropertyDescriptor(htmlProto, 'offsetHeight');
	Object.defineProperty(htmlProto, 'offsetTop', {
		configurable: true,
		get(this: HTMLElement) {
			if (!layout) return offsetTopDesc?.get?.call(this) ?? 0;
			if (layout.isToolbar(this) || layout.isViewer(this)) return 0;
			const m = layout.blockOf(this);
			return m && m.el === this ? m.docTop : (offsetTopDesc?.get?.call(this) ?? 0);
		},
	});
	Object.defineProperty(htmlProto, 'offsetHeight', {
		configurable: true,
		get(this: HTMLElement) {
			if (!layout) return offsetHeightDesc?.get?.call(this) ?? 0;
			if (layout.isViewer(this)) return VIEW_H;
			const m = layout.blockOf(this);
			return m && m.el === this ? m.height : (offsetHeightDesc?.get?.call(this) ?? 0);
		},
	});
	restorers.push(() => {
		if (offsetTopDesc) Object.defineProperty(htmlProto, 'offsetTop', offsetTopDesc);
		else delete (htmlProto as unknown as Record<string, unknown>).offsetTop;
		if (offsetHeightDesc) Object.defineProperty(htmlProto, 'offsetHeight', offsetHeightDesc);
		else delete (htmlProto as unknown as Record<string, unknown>).offsetHeight;
	});

	const style = document.createElement('style');
	style.setAttribute('data-testid', 'req48p-layout');
	style.textContent = `pre.vellis-plaintext, .markdown-body > * { line-height: ${LINE_H}px; }`;
	document.head.appendChild(style);
	restorers.push(() => style.remove());

	return model;
}

/** 閲覧の DOM でダブルクリックの単語を選んでから、座標付きの dblclick を送る。 */
async function doubleClickAt(
	target: HTMLElement,
	clientX: number,
	clientY: number,
	opts: { wordIn?: HTMLElement; word?: [number, number]; composed?: boolean } = {},
) {
	if (opts.wordIn && opts.word) placeSelection(opts.wordIn, opts.word[0], opts.word[1]);
	if (opts.composed) {
		target.dispatchEvent(
			new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, clientX, clientY }),
		);
	} else {
		await fireEvent.dblClick(target, { clientX, clientY });
	}
	await settle();
}

/** 本文の外(文書の中・Viewer の外)の段落。契約2(a) の「閲覧の本文の中」の外側。 */
function outsideParagraph(): HTMLElement {
	const p = document.createElement('p');
	p.id = 'req48p-outside';
	p.textContent = 'outside the viewer body';
	document.body.appendChild(p);
	restorers.push(() => p.remove());
	return p;
}

beforeEach(() => {
	expect(
		typeof (document as unknown as { caretRangeFromPoint?: unknown }).caretRangeFromPoint,
		'JSDOM の既定では caretRangeFromPoint が無いこと(前提)',
	).toBe('undefined');
	windowState.endEdit();
	windowState.clearDocument();
	placements.length = 0;
	clearSelection();
});

afterEach(() => {
	while (restorers.length > 0) restorers.pop()?.();
	layout = null;
	cleanup();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC (a) — text のダブルクリック(契約1(a)・3)
// ---------------------------------------------------------------------------

describe('AC-48-追p (a) — text のダブルクリックで、その文字の位置に潰れたキャレット・scrollTop は入る前のまま(契約1(a)・3)', () => {
	it('途中までスクロールして行の真ん中をダブルクリック: 同じ文字数の位置に潰れたキャレット・単語は選ばれない・scrollTop 不変・その行が見えている', async () => {
		const { container } = renderText();
		const model = installLayout(container, SCROLLED);
		const view = viewPre(container);
		expect(view.textContent, '閲覧の pre の文字が原文と同じ(前提)').toBe(TXT_CONTENT);

		await doubleClickAt(view, colClientX(CLICK_COL), lineClientY(CLICK_LINE, SCROLLED), {
			wordIn: view,
			word: [lineStart(CLICK_LINE) + ALPHA[0], lineStart(CLICK_LINE) + ALPHA[1]],
		});

		const editor = editorPre(container);
		expect(windowState.editMode).toBe('edit');
		expect(editor.textContent).toBe(TXT_CONTENT);
		expect(document.activeElement, '編集の pre にフォーカスがあること').toBe(editor);
		expectCaretAt(editor, CLICK_OFFSET);
		expect(model.scrollTop, 'scrollTop が入る前のまま(先頭へ戻らない=契約3)').toBe(SCROLLED);
		const visible = model.caretVisible();
		expect(visible.visible, `キャレットの行が見えている(top=${visible.top})`).toBe(true);
	});

	const positions: Array<[string, number, number, number]> = [
		// [label, line, col, clientX]
		['見えている最初の行の行頭', FIRST_VISIBLE_LINE, 0, colClientX(0)],
		['行末(行の長さより右をダブルクリック)', 67, LINE_LEN, colClientX(LINE_LEN + 5)],
		['2 行目の文字', 51, 3, colClientX(3)],
	];
	it.each(positions)('%s でも同じ文字数の位置に写る', async (_label, line, col, clientX) => {
		const { container } = renderText();
		const model = installLayout(container, SCROLLED);
		const view = viewPre(container);

		await doubleClickAt(view, clientX, lineClientY(line, SCROLLED));

		expectCaretAt(editorPre(container), lineStart(line) + col);
		expect(model.scrollTop).toBe(SCROLLED);
	});

	it('スクロールしていない(scrollTop 0)状態でも同じ', async () => {
		const { container } = renderText();
		const model = installLayout(container, 0);
		const view = viewPre(container);

		await doubleClickAt(view, colClientX(5), lineClientY(3, 0));

		expectCaretAt(editorPre(container), lineStart(3) + 5);
		expect(model.scrollTop).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// AC (b) — markdown の段落・HTML のブロック(契約1(b)(d))
// ---------------------------------------------------------------------------

describe('AC-48-追p (b) — markdown の段落と HTML のブロックのダブルクリック(契約1(b)(d))', () => {
	it('段落: ダブルクリックした位置に潰れたキャレット・単語は選ばない・scrollTop 不変', async () => {
		const { container } = renderMarkdownDoc();
		const scrollTop = scrollTopShowingBlock(BLOCK_TARGET);
		const model = installLayout(container, scrollTop);
		const p = targetParagraph(container);
		expect(p.textContent).toBe(TARGET_TEXT);
		expect(blocksOf(container)[BLOCK_TARGET], 'フィクスチャの前提: 対象の段落がブロック 3').toBe(p);

		await doubleClickAt(p, colClientX(TARGET_COL_PARAGRAPH), blockClientY(BLOCK_TARGET, scrollTop), {
			wordIn: p,
			word: TARGET_WORD_PARAGRAPH,
		});

		expect(editables(container), 'そのブロックだけが contenteditable').toEqual([p]);
		expect(document.activeElement).toBe(p);
		expectCaretAt(p, TARGET_COL_PARAGRAPH);
		expect(model.scrollTop).toBe(scrollTop);
	});

	it('段落の inline 要素(strong)の上: 段落の中の同じ文字数の位置', async () => {
		const { container } = renderMarkdownDoc();
		const scrollTop = scrollTopShowingBlock(BLOCK_TARGET);
		const model = installLayout(container, scrollTop);
		const p = targetParagraph(container);
		const strong = q(p, 'strong');

		await doubleClickAt(strong, colClientX(TARGET_COL_IN_BOLD), blockClientY(BLOCK_TARGET, scrollTop), {
			wordIn: p,
			word: [22, 26],
		});

		expect(editables(container)).toEqual([p]);
		expectCaretAt(p, TARGET_COL_IN_BOLD);
		expect(model.scrollTop).toBe(scrollTop);
	});

	it('HTML の編集面のブロック: ダブルクリックした位置に潰れたキャレットを置こうとする(記録係で判定)・単語は選ばない', async () => {
		const { container } = renderHtmlDoc();
		expect(windowState.beginEdit(), 'html 文書で beginEdit が true').toBe(true);
		await settle();
		const host = q(container, '[data-testid="html-edit-surface"]');
		const shadow = host.shadowRoot;
		if (!shadow) throw new Error('編集面の Shadow DOM が無い');
		const model = installLayout(container, 0);
		const a = shadow.querySelector('#a') as HTMLElement;
		const b = shadow.querySelector('#a b') as HTMLElement;
		expect(a.textContent).toBe('Hello bold & world');
		// 模型: 葉ブロック #a は 0 番目(文書座標 40..100)。
		expect(model.rectOf(a).top).toBe(BODY_TOP);
		placements.length = 0;

		await doubleClickAt(b, colClientX(HTML_COL_IN_BOLD), blockClientY(0, 0), {
			wordIn: a,
			word: HTML_WORD_HELLO,
			composed: true,
		});

		expect([...shadow.querySelectorAll('[contenteditable="true"]')], '#a だけが contenteditable').toEqual([a]);
		const placed = placementsIn(a);
		expect(placed.length, '編集面のブロックの中へ選択を置こうとした記録があること').toBeGreaterThan(0);
		const last = placed[placed.length - 1]!;
		expect(last.collapsed, '最後に置いた選択が潰れていること').toBe(true);
		expect(last.start, 'ダブルクリックした文字の位置').toBe(HTML_COL_IN_BOLD);
		expect(model.scrollTop).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// AC (c) — コードブロック(契約1(c))
// ---------------------------------------------------------------------------

describe('AC-48-追p (c) — コードブロックのダブルクリックで、素テキスト化した後の同じ文字数の位置(契約1(c))', () => {
	const cols: Array<[string, number]> = [
		['1 行目の途中(x)', CODE_COL_X],
		['2 行目の途中(y)', CODE_COL_Y],
	];
	it.each(cols)('%s', async (_label, col) => {
		const { container } = renderMarkdownDoc();
		const scrollTop = scrollTopShowingBlock(BLOCK_CODE);
		const model = installLayout(container, scrollTop);
		const pre = codePre(container);
		expect(blocksOf(container)[BLOCK_CODE], 'フィクスチャの前提: fence がブロック 2').toBe(pre);
		expect(pre.querySelector('span'), 'Shiki の span が付いている(前提)').not.toBeNull();
		expect((pre.textContent ?? '').slice(0, CODE_BODY.length)).toBe(CODE_BODY);

		await doubleClickAt(pre, colClientX(col), blockClientY(BLOCK_CODE, scrollTop));

		const list = editables(container);
		expect(list, 'contenteditable が 1 つだけ').toHaveLength(1);
		const ed = list[0]!;
		expect(ed === pre || ed.parentElement === pre, '編集要素は fence の pre かその中の code').toBe(true);
		expect(ed.querySelector('span'), '素テキストに置き換わっている').toBeNull();
		expect(ed.textContent).toBe(CODE_BODY);
		expectCaretAt(ed, col);
		expect(model.scrollTop).toBe(scrollTop);
	});
});

// ---------------------------------------------------------------------------
// AC (d) — 編集できない場所からのソース編集(契約1(e)・3)
// ---------------------------------------------------------------------------

describe('AC-48-追p (d) — 編集できない場所のダブルクリックは、その要素の原文の先頭へ(契約1(e)・3)', () => {
	it('リスト項目の中の fence(索引に載る・編集不可): 索引の position.startOffset に潰れたキャレット・その行が見えている', async () => {
		const { container } = renderMarkdownDoc();
		const scrollTop = scrollTopShowingBlock(BLOCK_LIST);
		const model = installLayout(container, scrollTop);
		const pre = nestedPre(container);
		const meta = metaOf(pre);
		expect(meta.type).toBe('code');
		expect(meta.parentBlockId, 'フィクスチャの前提: リストの中の fence').not.toBeNull();
		const expected = meta.position.startOffset;
		expect(expected).toBeGreaterThan(0);
		// 模型の点が fence の中の文字に当たること(前提)。
		const probe = model.caretRangeFromPoint(colClientX(LIST_COL_IN_FENCE), blockClientY(BLOCK_LIST, scrollTop));
		expect(probe && pre.contains(probe.startContainer), '点が fence の中に当たる(前提)').toBe(true);

		await doubleClickAt(pre, colClientX(LIST_COL_IN_FENCE), blockClientY(BLOCK_LIST, scrollTop));

		const editor = editorPre(container);
		expect(editor.textContent).toBe(MD);
		expectCaretAt(editor, expected);
		const visible = model.caretVisible();
		expect(
			visible.visible,
			`原文 ${lineOfOffset(MD, expected) + 1} 行目が見えている(top=${visible.top}・scrollTop=${model.scrollTop})`,
		).toBe(true);
	});

	it('索引に載らない生 HTML(文書の途中): 画面に見えている最初のブロックの原文の先頭(2(b) と同じ・先頭へ跳ばない)', async () => {
		const { container } = renderMarkdownDoc();
		// 対象の段落(ブロック 3)が見えている最初のブロック。生 HTML(ブロック 4)はその下に見えている。
		const scrollTop = scrollTopShowingBlock(BLOCK_TARGET);
		const model = installLayout(container, scrollTop);
		const raw = q(container, 'div.raw');
		expect(raw.hasAttribute('data-vellis-node-id'), 'フィクスチャの前提: 索引に載らない').toBe(false);
		expect(blocksOf(container)[BLOCK_RAW]).toBe(raw);
		const first = targetParagraph(container);
		expect(model.rectOf(first).top, '前提: 対象の段落が見えている最初のブロック').toBe(TOOLBAR_H);
		expect(model.rectOf(raw).top).toBe(TOOLBAR_H + BLOCK_H);
		const expected = metaOf(first).position.startOffset;

		await doubleClickAt(raw, colClientX(3), blockClientY(BLOCK_RAW, scrollTop));

		const editor = editorPre(container);
		expectCaretAt(editor, expected);
		const visible = model.caretVisible();
		expect(
			visible.visible,
			`原文 ${lineOfOffset(MD, expected) + 1} 行目が見えている(top=${visible.top}・scrollTop=${model.scrollTop})`,
		).toBe(true);
		expect(visible.top, '先頭へ跳ばず、その行が画面の上の方にある').toBeLessThan(TOOLBAR_H + VISIBLE_H / 2);
	});
});

// ---------------------------------------------------------------------------
// AC (e) — Command + E(契約2・3)
// ---------------------------------------------------------------------------

describe('AC-48-追p (e) — Command + E: 選択があればその位置・無ければ画面の位置を保つ(契約2・3)', () => {
	it('text・潰れた選択(クリックで置いたキャレット)がある: 同じ文字数の位置・scrollTop 不変', async () => {
		const { container } = renderText();
		const model = installLayout(container, SCROLLED);
		placeSelection(viewPre(container), CLICK_OFFSET);

		expect(windowState.beginEdit()).toBe(true);
		await settle();

		const editor = editorPre(container);
		expect(document.activeElement).toBe(editor);
		expectCaretAt(editor, CLICK_OFFSET);
		expect(model.scrollTop).toBe(SCROLLED);
		expect(model.caretVisible().visible).toBe(true);
	});

	it('text・範囲の選択がある: 範囲のまま写る(そのまま打つと置き換わる)・scrollTop 不変', async () => {
		const { container } = renderText();
		const model = installLayout(container, SCROLLED);
		const start = lineStart(CLICK_LINE) + ALPHA[0];
		const end = lineStart(CLICK_LINE) + ALPHA[1];
		placeSelection(viewPre(container), start, end);

		expect(windowState.beginEdit()).toBe(true);
		await settle();

		const editor = editorPre(container);
		const shape = selectionIn(editor);
		expect(shape.inside).toBe(true);
		expect(shape.collapsed, '範囲は潰さない').toBe(false);
		expect([shape.start, shape.end]).toEqual([start, end]);
		expect(model.scrollTop).toBe(SCROLLED);
	});

	it('text・選択が無い: scrollTop を保ち、見えている最初の行の先頭に潰れたキャレット', async () => {
		const { container } = renderText();
		const model = installLayout(container, SCROLLED);
		clearSelection();

		expect(windowState.beginEdit()).toBe(true);
		await settle();

		const editor = editorPre(container);
		expect(document.activeElement).toBe(editor);
		expectCaretAt(editor, lineStart(FIRST_VISIBLE_LINE));
		expect(model.scrollTop, 'scrollTop を保つ').toBe(SCROLLED);
	});

	it('text・選択が本文の外にある: 「無い」と同じ(見えている最初の行の先頭・scrollTop 不変)', async () => {
		const { container } = renderText();
		const model = installLayout(container, SCROLLED);
		placeSelection(outsideParagraph(), 3, 9);

		expect(windowState.beginEdit()).toBe(true);
		await settle();

		expectCaretAt(editorPre(container), lineStart(FIRST_VISIBLE_LINE));
		expect(model.scrollTop).toBe(SCROLLED);
	});

	it('text・選択が無く scrollTop 0: 1 行目の先頭(0 文字目)・scrollTop 0 のまま', async () => {
		const { container } = renderText();
		const model = installLayout(container, 0);
		clearSelection();

		expect(windowState.beginEdit()).toBe(true);
		await settle();

		expectCaretAt(editorPre(container), 0);
		expect(model.scrollTop).toBe(0);
	});

	it('markdown・段落の中に選択がある: そのブロックの原文の先頭に潰れたキャレット・その行が見えている', async () => {
		const { container } = renderMarkdownDoc();
		const model = installLayout(container, 0);
		const p = targetParagraph(container);
		const expected = metaOf(p).position.startOffset;
		placeSelection(p, 10, 14);

		expect(windowState.beginEdit()).toBe(true);
		await settle();

		const editor = editorPre(container);
		expect(editor.textContent).toBe(MD);
		expectCaretAt(editor, expected);
		const visible = model.caretVisible();
		expect(
			visible.visible,
			`原文 ${lineOfOffset(MD, expected) + 1} 行目が見えている(top=${visible.top}・scrollTop=${model.scrollTop})`,
		).toBe(true);
	});

	it('markdown・入れ子(引用の中の段落)に選択がある: 索引に載るいちばん内側の段落の原文の先頭(引用の先頭ではない)', async () => {
		const { container } = renderMarkdownDoc();
		const model = installLayout(container, 0);
		const bq = blocksOf(container)[BLOCK_QUOTE]!;
		const p = quotedParagraph(container);
		const inner = metaOf(p).position.startOffset;
		const outer = metaOf(bq).position.startOffset;
		expect(inner, '前提: 段落の先頭は引用の `> ` の後ろ').toBeGreaterThan(outer);
		placeSelection(p, 7, 13);

		expect(windowState.beginEdit()).toBe(true);
		await settle();

		const editor = editorPre(container);
		expectCaretAt(editor, inner);
		expect(model.caretVisible().visible).toBe(true);
	});

	it('markdown・選択が無い: 見えている最初のブロックの原文の先頭に潰れたキャレット・その行が画面の上の方に見える', async () => {
		const { container } = renderMarkdownDoc();
		const scrollTop = scrollTopShowingBlock(BLOCK_TARGET);
		const model = installLayout(container, scrollTop);
		const p = targetParagraph(container);
		const expected = metaOf(p).position.startOffset;
		// 前提: 模型で見えている最初のブロックが対象の段落(上端がちょうど見える範囲の上端)。
		expect(model.rectOf(p).top).toBe(TOOLBAR_H);
		expect(model.rectOf(blocksOf(container)[BLOCK_CODE]!).bottom).toBe(TOOLBAR_H);
		clearSelection();

		expect(windowState.beginEdit()).toBe(true);
		await settle();

		const editor = editorPre(container);
		expectCaretAt(editor, expected);
		const visible = model.caretVisible();
		expect(
			visible.visible,
			`原文 ${lineOfOffset(MD, expected) + 1} 行目が見えている(top=${visible.top}・scrollTop=${model.scrollTop})`,
		).toBe(true);
		expect(
			visible.top,
			`その行が画面の上の方(見えている範囲の上半分)にある(top=${visible.top})`,
		).toBeLessThan(TOOLBAR_H + VISIBLE_H / 2);
	});

	it('markdown・選択が無く scrollTop 0: 最初のブロック(見出し)の原文の先頭=0 文字目・1 行目が見えている', async () => {
		const { container } = renderMarkdownDoc();
		const model = installLayout(container, 0);
		expect(metaOf(blocksOf(container)[BLOCK_HEADING]!).position.startOffset).toBe(0);
		clearSelection();

		expect(windowState.beginEdit()).toBe(true);
		await settle();

		expectCaretAt(editorPre(container), 0);
		expect(model.caretVisible().visible).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// AC (f) — 位置が取れないときは 2(b)(契約1 末尾)
// ---------------------------------------------------------------------------

describe('AC-48-追p (f) — 位置が取れないダブルクリックは 2(b): scrollTop を保ち、見えている最初の行の先頭(契約1 末尾)', () => {
	type Setup = (model: Layout) => { clientX: number; clientY: number };
	const cases: Array<[string, Setup]> = [
		[
			'document.caretRangeFromPoint が無い',
			() => {
				delete (document as unknown as Record<string, unknown>).caretRangeFromPoint;
				return { clientX: colClientX(CLICK_COL), clientY: lineClientY(CLICK_LINE, SCROLLED) };
			},
		],
		[
			'caretRangeFromPoint が null を返す',
			() => {
				Object.defineProperty(document, 'caretRangeFromPoint', {
					configurable: true,
					writable: true,
					value: () => null,
				});
				return { clientX: colClientX(CLICK_COL), clientY: lineClientY(CLICK_LINE, SCROLLED) };
			},
		],
		[
			'閲覧の要素の外(ツールバーの中)を返す',
			() => ({ clientX: colClientX(CLICK_COL), clientY: TOOLBAR_H / 2 }),
		],
	];
	it.each(cases)('%s', async (_label, setup) => {
		const { container } = renderText();
		const model = installLayout(container, SCROLLED);
		const view = viewPre(container);
		clearSelection();
		const { clientX, clientY } = setup(model);

		await doubleClickAt(view, clientX, clientY);

		const editor = editorPre(container);
		expect(windowState.editMode).toBe('edit');
		expect(document.activeElement).toBe(editor);
		expectCaretAt(editor, lineStart(FIRST_VISIBLE_LINE));
		expect(model.scrollTop, 'scrollTop を保つ').toBe(SCROLLED);
	});

	it('text・位置が取れず、ダブルクリックの単語が閲覧で選ばれている: その始まりに潰して置く(単語は選ばない)・scrollTop 不変', async () => {
		const { container } = renderText();
		const model = installLayout(container, SCROLLED);
		const view = viewPre(container);
		Object.defineProperty(document, 'caretRangeFromPoint', {
			configurable: true,
			writable: true,
			value: () => null,
		});
		const wordStart = lineStart(CLICK_LINE) + ALPHA[0];

		await doubleClickAt(view, colClientX(CLICK_COL), lineClientY(CLICK_LINE, SCROLLED), {
			wordIn: view,
			word: [wordStart, lineStart(CLICK_LINE) + ALPHA[1]],
		});

		expectCaretAt(editorPre(container), wordStart);
		expect(model.scrollTop).toBe(SCROLLED);
	});

	it('markdown のブロック編集で位置が取れない: そのブロックの先頭に潰して置く(単語は選ばない)', async () => {
		const { container } = renderMarkdownDoc();
		const scrollTop = scrollTopShowingBlock(BLOCK_TARGET);
		const model = installLayout(container, scrollTop);
		const p = targetParagraph(container);
		Object.defineProperty(document, 'caretRangeFromPoint', {
			configurable: true,
			writable: true,
			value: () => null,
		});

		await doubleClickAt(p, colClientX(TARGET_COL_PARAGRAPH), blockClientY(BLOCK_TARGET, scrollTop), {
			wordIn: p,
			word: TARGET_WORD_PARAGRAPH,
		});

		expect(editables(container)).toEqual([p]);
		expectCaretAt(p, 0);
		expect(model.scrollTop).toBe(scrollTop);
	});
});

// ---------------------------------------------------------------------------
// AC (g) — 入った後の書き戻しでキャレットを奪わない(契約4)
// ---------------------------------------------------------------------------

describe('AC-48-追p (g) — 入った後の書き戻し(外部変更の apply)でキャレットを置き直さず、フォーカスも奪わない(契約4)', () => {
	it('text: 書き戻しのあと、編集の pre への選択の置き直しも focus も無い', async () => {
		const { container } = renderText();
		const model = installLayout(container, SCROLLED);
		await doubleClickAt(viewPre(container), colClientX(CLICK_COL), lineClientY(CLICK_LINE, SCROLLED));
		const editor = editorPre(container);
		expectCaretAt(editor, CLICK_OFFSET);

		// 利用者がフォーカスを別の場所へ移した(書き戻しはそれを奪ってはいけない)。
		editor.blur();
		expect(document.activeElement).not.toBe(editor);
		placements.length = 0;
		model.focusCalls.length = 0;

		const rewritten = TXT_CONTENT.replace('line 00', 'LINE 00');
		expect(windowState.applyFileChanged({ uri: TXT_URI, content: rewritten, modified: 2 })).toBe('apply');
		await settle();

		expect(editor.textContent, '書き戻しが届いている(前提)').toBe(rewritten);
		expect(editables(container)).toEqual([editor]);
		expect(placementsIn(editor), '書き戻しで選択を置き直さない').toEqual([]);
		expect(model.focusCalls.filter((c) => c.el === editor), '書き戻しで focus しない').toEqual([]);
		expect(document.activeElement).not.toBe(editor);
	});
});

// ---------------------------------------------------------------------------
// 契約1(a) CRLF・契約2(a) — 閲覧の LF 1 文字=原文の `\r\n` 2 文字(手前の改行の数だけ足す)
// ---------------------------------------------------------------------------

/** 同じ 80 行を CRLF で結んだ原文(閲覧の `<pre>` では LF に畳まれる)。 */
const TXT_CRLF = Array.from({ length: LINE_COUNT }, (_, i) => lineText(i)).join('\r\n') + '\r\n';
/** CRLF の原文での行 i の先頭の文字数(1 行= 24 文字+ `\r\n`)。 */
function crlfLineStart(i: number): number {
	return i * (LINE_LEN + 2);
}

describe('AC-48-追p 契約1(a) CRLF・契約2(a) — CRLF の文書では原文の同じ文字へ写す(手前の改行の数だけ足す)', () => {
	it('ダブルクリック: 閲覧(LF)の行 55 の 10 文字目 → 編集(CRLF)の原文の同じ文字(手前の 55 個の `\\r` の分だけ後ろ)に潰れたキャレット', async () => {
		const { container } = renderText(TXT_CRLF);
		const model = installLayout(container, SCROLLED);
		const view = viewPre(container);
		expect(view.textContent, '前提: 閲覧の pre では CRLF が LF 1 文字になる').toBe(TXT_CONTENT);
		expect(view.textContent).not.toContain('\r');

		await doubleClickAt(view, colClientX(CLICK_COL), lineClientY(CLICK_LINE, SCROLLED), {
			wordIn: view,
			word: [lineStart(CLICK_LINE) + ALPHA[0], lineStart(CLICK_LINE) + ALPHA[1]],
		});

		const editor = editorPre(container);
		expect(editor.textContent, '編集の pre は原文の `\\r\\n` をそのまま持つ').toBe(TXT_CRLF);
		const expected = crlfLineStart(CLICK_LINE) + CLICK_COL;
		expectCaretAt(editor, expected);
		expect(TXT_CRLF[expected], '同じ文字(行 55 の "alpha" の "p")').toBe(TXT_CONTENT[CLICK_OFFSET]);
		expect(model.scrollTop).toBe(SCROLLED);
	});

	it('Command + E・複数行にまたがる範囲: 両端が原文の同じ文字(それぞれの手前の改行の数だけ足す)', async () => {
		const { container } = renderText(TXT_CRLF);
		const model = installLayout(container, SCROLLED);
		const view = viewPre(container);
		expect(view.textContent).toBe(TXT_CONTENT);
		// 閲覧(LF)の行 55 の 8 文字目 〜 行 57 の 3 文字目。
		const viewStart = lineStart(55) + 8;
		const viewEnd = lineStart(57) + 3;
		placeSelection(view, viewStart, viewEnd);

		expect(windowState.beginEdit()).toBe(true);
		await settle();

		const editor = editorPre(container);
		expect(editor.textContent).toBe(TXT_CRLF);
		const shape = selectionIn(editor);
		expect(shape.inside).toBe(true);
		expect(shape.collapsed, '範囲は潰さない').toBe(false);
		expect([shape.start, shape.end]).toEqual([crlfLineStart(55) + 8, crlfLineStart(57) + 3]);
		expect(TXT_CRLF.slice(shape.start, shape.end).replace(/\r\n/g, '\n'), '同じ文字の範囲').toBe(
			TXT_CONTENT.slice(viewStart, viewEnd),
		);
		expect(model.scrollTop).toBe(SCROLLED);
	});
});

// ---------------------------------------------------------------------------
// 契約3 後段 — 閲覧の選択が画面の外にあるまま Command + E: 画面の位置を保ち、キャレットは画面の外
// ---------------------------------------------------------------------------

describe('AC-48-追p 契約3 後段 — 画面の外の選択のまま Command + E は、scrollTop を保ちキャレットを画面の外に置く', () => {
	it('text・行 5 に潰れた選択・scrollTop 1000(行 50〜67 が見えている): キャレットは行 5・scrollTop 不変・キャレットの行は見えていない', async () => {
		const { container } = renderText();
		const model = installLayout(container, SCROLLED);
		const offscreen = lineStart(5) + 4;
		placeSelection(viewPre(container), offscreen);

		expect(windowState.beginEdit()).toBe(true);
		await settle();

		const editor = editorPre(container);
		expectCaretAt(editor, offscreen);
		expect(model.scrollTop, '画面の位置を保つ').toBe(SCROLLED);
		const visible = model.caretVisible();
		expect(visible.visible, `キャレットの行は画面の外(top=${visible.top})`).toBe(false);
	});
});
