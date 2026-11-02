/**
 * 要件#48 追補q の受け入れテスト(docs/requirements/req-48.md「追補q」・Issue #774)
 * — HTML の編集面(Shadow DOM)でダブルクリックした位置にキャレットを置く配線(component プロジェクト)
 *
 * HTML の編集面(要件#53。中身は Shadow DOM)では、ダブルクリックで段落の編集に入っても
 * キャレットがダブルクリックした位置ではなく段落の先頭に置かれる。原因は
 * `document.caretRangeFromPoint` が Shadow の中の点をホストへ寄せた Range(ホストの親)で
 * 返すこと。追補q は、HTML の編集面だけ `document.caretPositionFromPoint(x, y,
 * { shadowRoots: [編集面の ShadowRoot] })` で位置を取り(契約1)、取れなければ今までどおり
 * ブロックの先頭(契約2)、Shadow の外の経路は `caretRangeFromPoint` のまま(契約3)と決める。
 * ここは `Viewer.svelte` を JSDOM にマウントし、追補p の wiring(`Viewer.edit-caret.wiring.test.ts`)
 * の家風で判定する。既存テストは書き換えず、本追補用に新設。
 *
 * ## 判定するもの(契約番号は req-48.md 追補q の 1〜3・AC は AC-48-追q の (a)〜(d))
 * - **AC (a)・契約1**: HTML の編集面で段落の途中をダブルクリックすると、そのブロックだけが
 *   contenteditable になり、ブロックの中のダブルクリックした文字の位置に**潰れた**キャレットを
 *   置こうとする(単語は選ばない)。インラインの要素(`<strong>`・`<a>`)の中・見出し・
 *   リスト項目・表のセルでも同じ。位置は `caretPositionFromPoint` に編集面の ShadowRoot を
 *   `shadowRoots` で渡して取っている
 * - **AC (b)・契約2**: `caretPositionFromPoint` が無い・例外を投げる・null を返す・
 *   `shadowRoots` を渡しても Shadow の外(ホスト側)を返す・ブロックの外(隣のブロック・
 *   編集面のルート)を返す → 編集面には入り、キャレットはそのブロックの先頭(0 文字目)。
 *   隣のブロックは contenteditable にならない
 * - **AC (c)・契約3**: text 文書のソース編集と markdown のブロック編集(Shadow の外)は
 *   `caretRangeFromPoint` のままで位置を取り、`caretPositionFromPoint` は呼ばれない
 * - **AC (d)**: 既存テストの無改変は本ファイルでは判定しない(フルスイート)
 *
 * ## 判定しないもの
 * - 本物の WKWebView での `caretPositionFromPoint` の実寸と、Shadow の中の本物の選択に
 *   そのまま打てること(「そのまま打つとそこに入る」)→ E2E
 *   (tests/e2e/specs/req48q-html-caret-gate.e2e.ts)と人間ゲート(req-48.md 追補q)
 *
 * ## JSDOM での判定の形(偽物の作り=2026-10-29 に WKWebView で確かめた事実のとおり)
 * JSDOM には `caretPositionFromPoint` も `caretRangeFromPoint` もレイアウトも無い。そこで
 * 1 つのレイアウトの模型を決め、2 つの API をその模型から答える偽物にする:
 * - 模型: 編集面の葉ブロック(Shadow の中の `data-vellis-hid` 付きの p / h2 / li / td …)は
 *   DOM 順に 1 つ `BLOCK_H`=60px を占め(文書座標 `BODY_TOP` から)、ブロックの中では x から
 *   文字数(`floor(x / CHAR_W)`=そのブロックの `textContent` 上の文字数)を決める。text の
 *   閲覧の `<pre>` は 1 行 `LINE_H`=20px・markdown の本文の直下のブロックは `BLOCK_H`
 * - **`document.caretPositionFromPoint(x, y, options)` の偽物**(WebKit の事実): `options.shadowRoots`
 *   に編集面の ShadowRoot が入っているときだけ Shadow の中のテキストノードと文字の位置
 *   (`{ offsetNode, offset }`)を返す。入っていなければ Shadow の外=ホスト側
 *   (ホストの親と、その中のホストの位置)を返す。Shadow の外の点は光の DOM の位置を返す。
 *   よって `shadowRoots` を渡さない実装は、ブロックの先頭に落ちて赤になる
 * - **`document.caretRangeFromPoint(x, y)` の偽物**(WebKit の事実): 編集面の点はホスト側の
 *   Range(ホストの親の中のホストの位置に潰れたもの)を返す。Shadow の外の点は光の DOM の位置
 * - Shadow DOM の中の Range は JSDOM の `Selection` が捨てる(root が document でない)ので、
 *   編集面のケースは追補p と同じ**選択の記録係**(`Selection.prototype` の置き口を包む)で
 *   「Viewer が置こうとした位置」を判定する。`focus()` の中で JSDOM 自身が置く選択は
 *   記録に載せない。Shadow の外のケースは本物の `window.getSelection()` で判定する
 *
 * ## スタブの設計(Viewer.edit.wiring.test.ts の家風)
 * - $lib/ipc / @tauri-apps/plugin-opener / @tauri-apps/plugin-dialog: モジュールモック
 * - $lib/mermaid-mounter: markdown は本番パイプライン(`render`)を通すので、mermaid の
 *   dynamic import を発火させない
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';

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

/** 本文(編集面・閲覧の `<pre>`・markdown の本文)の文書座標の上端。 */
const BODY_TOP = 40;
/** 編集面の葉ブロック・markdown の本文の直下のブロックが 1 つ占める高さ。 */
const BLOCK_H = 60;
/** text の閲覧の `<pre>` の 1 行の高さ。 */
const LINE_H = 20;
/** 1 文字の幅(等幅)。 */
const CHAR_W = 10;

/** ブロック j の真ん中の viewport y(スクロール無し)。 */
function blockClientY(block: number): number {
	return BODY_TOP + block * BLOCK_H + BLOCK_H / 2;
}

/** `<pre>` の行 i の真ん中の viewport y。 */
function lineClientY(line: number): number {
	return BODY_TOP + line * LINE_H + LINE_H / 2;
}

/** 文字数 col の文字の真ん中の viewport x。 */
function colClientX(col: number): number {
	return col * CHAR_W + CHAR_W / 2;
}

// ---------------------------------------------------------------------------
// 文書
// ---------------------------------------------------------------------------

const HTML_URI = 'file:///Users/a/site/caret.html';
/**
 * 編集面の葉ブロック(DOM 順・模型の j): 0=#p01・1=#p02(インライン入り)・2=#h01・
 * 3=#li01・4=#li02(太字入り)・5=#td01・6=#td02。
 */
const HTML_SRC = [
	'<!doctype html>',
	'<html>',
	'<head>',
	'<title>Caret</title>',
	'</head>',
	'<body>',
	'<p id="p01">P01 w01 w02 w03 w04 w05 w06 w07 w08 w09 w10.</p>',
	'<p id="p02">P02 w01 <strong>w02 strong w03</strong> w04 <a href="#p01">w05 link w06</a> w07.</p>',
	'<h2 id="h01">H01 heading w01 w02</h2>',
	'<ul>',
	'<li id="li01">LI01 w01 w02</li>',
	'<li id="li02">LI02 w01 <strong>w02 w03</strong> w04</li>',
	'</ul>',
	'<table>',
	'<tr><td id="td01">TD01 w01 w02</td><td id="td02">TD02 w01 w02</td></tr>',
	'</table>',
	'</body>',
	'</html>',
	'',
].join('\n');
const BLOCK_P01 = 0;
const BLOCK_P02 = 1;
const BLOCK_H01 = 2;
const BLOCK_LI02 = 4;
const BLOCK_TD01 = 5;

const TXT_URI = 'file:///Users/a/notes/caret.txt';
const TXT_LINES = ['line 00 alpha beta gamma', 'line 01 delta epsilon zeta', 'line 02 eta theta iota'];
const TXT_CONTENT = TXT_LINES.join('\n') + '\n';
const TXT_CLICK_LINE = 1;
/** 'delta' の 'l'(行の中の 9 文字目)。 */
const TXT_CLICK_COL = 9;
const TXT_CLICK_OFFSET = TXT_LINES[0]!.length + 1 + TXT_CLICK_COL;

const MD_URI = 'file:///Users/a/notes/caret.md';
const MD = ['# Caret Title', '', 'Target paragraph with **bold** word.', ''].join('\n');
/** 本文の直下のブロック: 0=h1・1=対象の段落。 */
const MD_BLOCK_TARGET = 1;
/** 対象の段落の 'bold' の 'o'(23)。 */
const MD_COL_IN_BOLD = 23;

let rendered: { html: string; index: SourceIndex };

beforeAll(async () => {
	const result = await renderMarkdown(MD, MD_URI);
	rendered = { html: result.html, index: result.index };
	expect(rendered.index.byId.size).toBeGreaterThan(0);
});

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

/** html 文書をマウントする(閲覧は HtmlViewer 側なので html:'' / index:null)。 */
function renderHtmlDoc() {
	const doc: DocumentPayload = { uri: HTML_URI, content: HTML_SRC, modified: 1 };
	windowState.setDocument(doc);
	return render(Viewer, { props: baseProps(doc, '') });
}

/** text 文書を windowState と Viewer の両方に載せてマウントする。 */
function renderTextDoc() {
	const doc: DocumentPayload = { uri: TXT_URI, content: TXT_CONTENT, modified: 1 };
	windowState.setDocument(doc);
	return render(Viewer, { props: baseProps(doc, plainTextHtml(TXT_CONTENT)) });
}

/** markdown 文書を本番パイプラインの html と索引でマウントする。 */
function renderMarkdownDoc() {
	const doc: DocumentPayload = { uri: MD_URI, content: MD, modified: 1 };
	windowState.setDocument(doc);
	return render(Viewer, { props: baseProps(doc, rendered.html, rendered.index) });
}

function q(scope: ParentNode, selector: string): HTMLElement {
	const el = scope.querySelector(selector);
	if (!el) throw new Error(`要素が見つからない: ${selector}`);
	return el as HTMLElement;
}

function editables(scope: ParentNode): HTMLElement[] {
	return [...scope.querySelectorAll('[contenteditable="true"]')] as HTMLElement[];
}

/** ハンドラが await を連ねても連鎖全体を確定させる(edit wiring の家風)。 */
async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}

/** html 文書で Command + E 相当(`beginEdit`)で編集面に入り、ホストと Shadow を返す。 */
async function enterHtmlSurface(container: HTMLElement): Promise<{ host: HTMLElement; shadow: ShadowRoot }> {
	expect(windowState.beginEdit(), 'html 文書で beginEdit が true').toBe(true);
	await settle();
	const host = q(container, '[data-testid="html-edit-surface"]');
	const shadow = host.shadowRoot;
	if (!shadow) throw new Error('編集面の Shadow DOM が無い');
	return { host, shadow };
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

function clearSelection() {
	window.getSelection()?.removeAllRanges();
}

/** 本物の `window.getSelection()` が `el` の中の `offset` 文字目に潰れていること。 */
function expectRealCaretAt(el: HTMLElement, offset: number, label = 'キャレット') {
	const sel = window.getSelection();
	expect(sel && sel.rangeCount, `${label}: 選択が 1 つあること`).toBe(1);
	const range = sel!.getRangeAt(0);
	expect(
		el.contains(range.startContainer) && el.contains(range.endContainer),
		`${label}: 選択が編集する要素の中にあること`,
	).toBe(true);
	expect(range.collapsed, `${label}: 潰れている(範囲を選んでいない)こと`).toBe(true);
	expect(textOffsetOf(el, range.startContainer, range.startOffset), `${label}: 文字数の位置`).toBe(offset);
}

// ---------------------------------------------------------------------------
// 選択の記録係(Shadow DOM の中の Range は JSDOM の Selection が捨てるため=追補p と同じ)
// ---------------------------------------------------------------------------

interface Placement {
	start: Node;
	startOffset: number;
	end: Node;
	endOffset: number;
}

const placements: Placement[] = [];
/** false の間は記録しない(偽 focus の中で JSDOM 自身が置く選択を載せないため)。 */
let recording = true;

function record(p: Placement) {
	if (recording) placements.push(p);
}

/** `Selection.prototype` の置き口を包み、置こうとした位置を順に記録する。戻す関数を返す。 */
function installSelectionRecorder(): () => void {
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
	return () => {
		Object.assign(proto, orig);
	};
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

/** Viewer が最後に `el` の中へ置こうとした選択が、`offset` に潰れていること。 */
function expectPlacedCaretAt(el: Element, offset: number, label = 'キャレット') {
	const placed = placementsIn(el);
	expect(placed.length, `${label}: ブロックの中へ選択を置こうとした記録があること`).toBeGreaterThan(0);
	const last = placed[placed.length - 1]!;
	expect(last.collapsed, `${label}: 最後に置いた選択が潰れている(単語を選んでいない)こと`).toBe(true);
	expect(last.start, `${label}: 文字数の位置`).toBe(offset);
}

// ---------------------------------------------------------------------------
// 偽物の caretPositionFromPoint / caretRangeFromPoint(ヘッダ「JSDOM での判定の形」)
// ---------------------------------------------------------------------------

/** WebKit の `CaretPosition` の形(TS 5.6 の lib.dom には無いので、ここで最小の形を持つ)。 */
interface FakeCaretPosition {
	offsetNode: Node;
	offset: number;
	getClientRect: () => DOMRect | null;
}

interface CaretPositionOptions {
	shadowRoots?: Iterable<ShadowRoot>;
}

interface PositionCall {
	x: number;
	y: number;
	shadowRoots: ShadowRoot[];
}

interface Modelled {
	kind: 'lines' | 'block';
	el: Element;
	docTop: number;
	height: number;
}

/** 偽物の動かし方(WebKit の事実からずらすのは契約2 のケースだけ)。 */
interface FakeBehaviour {
	/** `caretPositionFromPoint` の返し方。'webkit' が事実どおり。 */
	position: 'webkit' | 'absent' | 'throws' | 'null' | 'host-even-with-shadowRoots' | 'neighbour-block' | 'surface-root';
}

class Layout {
	readonly positionCalls: PositionCall[] = [];
	readonly rangeCalls: Array<{ x: number; y: number }> = [];
	behaviour: FakeBehaviour = { position: 'webkit' };
	private readonly bodyEl: HTMLElement;

	constructor(container: HTMLElement) {
		this.bodyEl = q(container, '.markdown-body');
	}

	private host(): HTMLElement | null {
		return this.bodyEl.querySelector<HTMLElement>('[data-testid="html-edit-surface"]');
	}

	private shadow(): ShadowRoot | null {
		return this.host()?.shadowRoot ?? null;
	}

	/** 模型に載っている要素(HTML 編集面の葉ブロックを先に・本文の直下のブロックを後に)。 */
	private modelled(): Modelled[] {
		const list: Modelled[] = [];
		const shadow = this.shadow();
		if (shadow) {
			const leaves = [...shadow.querySelectorAll('p, h1, h2, h3, h4, h5, h6, pre, li, td, th')].filter((el) =>
				el.hasAttribute('data-vellis-hid'),
			);
			leaves.forEach((el, j) => {
				list.push({ kind: 'block', el, docTop: BODY_TOP + j * BLOCK_H, height: BLOCK_H });
			});
		}
		[...this.bodyEl.children].forEach((el, i) => {
			if (el.matches('[data-testid="html-edit-surface"]')) return;
			if (el.matches('pre.vellis-plaintext')) {
				const lines = (el.textContent ?? '').split('\n').length;
				list.push({ kind: 'lines', el, docTop: BODY_TOP, height: lines * LINE_H });
				return;
			}
			list.push({ kind: 'block', el, docTop: BODY_TOP + i * BLOCK_H, height: BLOCK_H });
		});
		return list;
	}

	/** 模型でその点にある要素と、その中の文字数。 */
	private hit(x: number, y: number): { m: Modelled; offset: number } | null {
		const col = Math.max(0, Math.floor(x / CHAR_W));
		for (const m of this.modelled()) {
			if (y < m.docTop || y >= m.docTop + m.height) continue;
			const text = m.el.textContent ?? '';
			if (m.kind === 'block') return { m, offset: Math.min(col, text.length) };
			const line = Math.floor((y - m.docTop) / LINE_H);
			const lines = text.split('\n');
			const lineText = lines[line];
			if (lineText === undefined) return null;
			let offset = 0;
			for (let i = 0; i < line; i++) offset += (lines[i]?.length ?? 0) + 1;
			return { m, offset: offset + Math.min(col, lineText.length) };
		}
		return null;
	}

	private inShadow(m: Modelled): boolean {
		const shadow = this.shadow();
		return shadow !== null && shadow.contains(m.el);
	}

	/** WebKit がホストへ寄せる位置: ホストの親と、その中のホストの位置。 */
	private hostSide(): [Node, number] {
		const host = this.host();
		if (!host || !host.parentNode) throw new Error('編集面のホストが無い');
		return [host.parentNode, [...host.parentNode.childNodes].indexOf(host)];
	}

	/** `caretRangeFromPoint`(WebKit の事実): Shadow の中の点はホスト側に潰れた Range。 */
	caretRangeFromPoint(x: number, y: number): Range | null {
		this.rangeCalls.push({ x, y });
		const hit = this.hit(x, y);
		if (!hit) return null;
		const r = document.createRange();
		if (this.inShadow(hit.m)) {
			const [node, offset] = this.hostSide();
			r.setStart(node, offset);
		} else {
			const at = locate(hit.m.el, hit.offset);
			if (!at) return null;
			r.setStart(at[0], at[1]);
		}
		r.collapse(true);
		return r;
	}

	/**
	 * `caretPositionFromPoint`(WebKit の事実): `shadowRoots` に編集面の ShadowRoot が
	 * 入っているときだけ Shadow の中の位置。入っていなければホスト側。
	 */
	caretPositionFromPoint(x: number, y: number, options?: CaretPositionOptions): FakeCaretPosition | null {
		const roots = [...(options?.shadowRoots ?? [])];
		this.positionCalls.push({ x, y, shadowRoots: roots });
		const mode = this.behaviour.position;
		if (mode === 'throws') throw new TypeError('caretPositionFromPoint: unsupported options');
		if (mode === 'null') return null;
		const hit = this.hit(x, y);
		if (!hit) return null;
		if (!this.inShadow(hit.m)) {
			const at = locate(hit.m.el, hit.offset);
			return at ? position(at[0], at[1]) : null;
		}
		const shadow = this.shadow();
		const pierced = shadow !== null && roots.includes(shadow) && mode !== 'host-even-with-shadowRoots';
		if (!pierced) {
			const [node, offset] = this.hostSide();
			return position(node, offset);
		}
		if (mode === 'surface-root') {
			const root = shadow!.querySelector('.vellis-html-edit-root');
			if (!root) throw new Error('編集面のルートが無い');
			return position(root, 0);
		}
		if (mode === 'neighbour-block') {
			const blocks = this.modelled().filter((m) => this.inShadow(m));
			const neighbour = blocks.find((m) => m.el !== hit.m.el);
			if (!neighbour) throw new Error('隣のブロックが無い');
			const at = locate(neighbour.el, 1);
			if (!at) throw new Error('隣のブロックにテキストが無い');
			return position(at[0], at[1]);
		}
		const at = locate(hit.m.el, hit.offset);
		return at ? position(at[0], at[1]) : null;
	}
}

function position(offsetNode: Node, offset: number): FakeCaretPosition {
	return { offsetNode, offset, getClientRect: () => null };
}

let layout: Layout | null = null;
const restorers: Array<() => void> = [];

/**
 * マウント済みの Viewer にレイアウトの模型を付け、`caretPositionFromPoint` と
 * `caretRangeFromPoint` を模型から答える偽物にする。`focus()` の中で JSDOM 自身が置く
 * 選択は記録係に載せない。
 */
function installLayout(container: HTMLElement): Layout {
	const model = new Layout(container);
	layout = model;

	restorers.push(installSelectionRecorder());

	const docAny = document as unknown as Record<string, unknown>;
	const hadRange = 'caretRangeFromPoint' in docAny;
	const hadPosition = 'caretPositionFromPoint' in docAny;
	Object.defineProperty(document, 'caretRangeFromPoint', {
		configurable: true,
		writable: true,
		value: (x: number, y: number) => layout?.caretRangeFromPoint(x, y) ?? null,
	});
	Object.defineProperty(document, 'caretPositionFromPoint', {
		configurable: true,
		writable: true,
		value: (x: number, y: number, options?: CaretPositionOptions) =>
			layout?.caretPositionFromPoint(x, y, options) ?? null,
	});
	restorers.push(() => {
		if (!hadRange) delete docAny.caretRangeFromPoint;
		if (!hadPosition) delete docAny.caretPositionFromPoint;
	});

	const origFocus = HTMLElement.prototype.focus;
	HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
		recording = false;
		try {
			origFocus.call(this, options);
		} finally {
			recording = true;
		}
	};
	restorers.push(() => {
		HTMLElement.prototype.focus = origFocus;
	});

	return model;
}

/** `caretPositionFromPoint` を無い状態にする(契約2「無い」)。 */
function removeCaretPositionFromPoint() {
	delete (document as unknown as Record<string, unknown>).caretPositionFromPoint;
}

/** 座標付きの composed な dblclick を送る(Shadow の中の要素にも届く)。 */
async function doubleClickAt(target: Element, clientX: number, clientY: number) {
	target.dispatchEvent(
		new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, clientX, clientY }),
	);
	await settle();
}

/** `shadow` の `#id`(`inner` があればその中のインライン要素)と、ダブルクリックの的の文字数。 */
function surfaceTarget(
	shadow: ShadowRoot,
	id: string,
	word: string,
	inner: string | null = null,
): { block: HTMLElement; target: HTMLElement; col: number } {
	const block = shadow.querySelector<HTMLElement>(`#${id}`);
	if (!block) throw new Error(`編集面に #${id} が無い`);
	const target = inner ? block.querySelector<HTMLElement>(inner) : block;
	if (!target) throw new Error(`#${id} の中に ${inner} が無い`);
	const text = block.textContent ?? '';
	const at = text.indexOf(word);
	if (at < 0) throw new Error(`#${id} に '${word}' が無い`);
	// 単語の 2 文字目(単語の中)を的にする。
	const col = at + 1;
	const located = locate(block, col);
	if (!located || !target.contains(located[0])) throw new Error(`'${word}' が ${inner ?? id} の中に無い`);
	return { block, target, col };
}

beforeEach(() => {
	const docAny = document as unknown as Record<string, unknown>;
	expect(typeof docAny.caretRangeFromPoint, 'JSDOM の既定では caretRangeFromPoint が無いこと(前提)').toBe('undefined');
	expect(typeof docAny.caretPositionFromPoint, 'JSDOM の既定では caretPositionFromPoint が無いこと(前提)').toBe(
		'undefined',
	);
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
// AC (a) — 段落の途中・インラインの中・見出し・リスト・表(契約1)
// ---------------------------------------------------------------------------

describe('AC-48-追q (a) — HTML の編集面のダブルクリックで、ダブルクリックした文字の位置に潰れたキャレット(契約1)', () => {
	it('段落の途中(テキストノードの直下): その文字の位置に潰れたキャレット・単語は選ばない・shadowRoots に編集面の ShadowRoot を渡して取っている', async () => {
		const { container } = renderHtmlDoc();
		const { shadow } = await enterHtmlSurface(container);
		const model = installLayout(container);
		const { block, target, col } = surfaceTarget(shadow, 'p01', 'w05');
		placements.length = 0;

		await doubleClickAt(target, colClientX(col), blockClientY(BLOCK_P01));

		expect(editables(shadow), '#p01 だけが contenteditable').toEqual([block]);
		expectPlacedCaretAt(block, col);
		expect(
			model.positionCalls.some((c) => c.shadowRoots.includes(shadow)),
			'caretPositionFromPoint に編集面の ShadowRoot を shadowRoots で渡していること',
		).toBe(true);
	});

	it('インラインの要素(<strong>)の中: 段落の中の同じ文字数の位置', async () => {
		const { container } = renderHtmlDoc();
		const { shadow } = await enterHtmlSurface(container);
		installLayout(container);
		const { block, target, col } = surfaceTarget(shadow, 'p02', 'strong', 'strong');
		placements.length = 0;

		await doubleClickAt(target, colClientX(col), blockClientY(BLOCK_P02));

		expect(editables(shadow), '#p02 だけが contenteditable').toEqual([block]);
		expectPlacedCaretAt(block, col);
	});

	it('リンク(<a>)の中: 段落の中の同じ文字数の位置', async () => {
		const { container } = renderHtmlDoc();
		const { shadow } = await enterHtmlSurface(container);
		installLayout(container);
		const { block, target, col } = surfaceTarget(shadow, 'p02', 'link', 'a');
		placements.length = 0;

		await doubleClickAt(target, colClientX(col), blockClientY(BLOCK_P02));

		expect(editables(shadow), '#p02 だけが contenteditable').toEqual([block]);
		expectPlacedCaretAt(block, col);
	});

	const others: Array<[string, string, string, string | null, number]> = [
		['見出し(h2)', 'h01', 'heading', null, BLOCK_H01],
		['リスト項目の中の太字(li > strong)', 'li02', 'w03', 'strong', BLOCK_LI02],
		['表のセル(td)', 'td01', 'w02', null, BLOCK_TD01],
	];
	it.each(others)('%s: そのブロックの中の同じ文字数の位置', async (_label, id, word, inner, blockIndex) => {
		const { container } = renderHtmlDoc();
		const { shadow } = await enterHtmlSurface(container);
		installLayout(container);
		const { block, target, col } = surfaceTarget(shadow, id, word, inner);
		placements.length = 0;

		await doubleClickAt(target, colClientX(col), blockClientY(blockIndex));

		expect(editables(shadow), `#${id} だけが contenteditable`).toEqual([block]);
		expectPlacedCaretAt(block, col);
	});
});

// ---------------------------------------------------------------------------
// AC (b) — 取れないときはブロックの先頭(契約2)
// ---------------------------------------------------------------------------

describe('AC-48-追q (b) — caretPositionFromPoint が使えない・Shadow の外を返すときは、そのブロックの先頭(契約2)', () => {
	const cases: Array<[string, (model: Layout) => void]> = [
		['caretPositionFromPoint が無い', () => removeCaretPositionFromPoint()],
		[
			'caretPositionFromPoint が例外を投げる',
			(model) => {
				model.behaviour = { position: 'throws' };
			},
		],
		[
			'caretPositionFromPoint が null を返す',
			(model) => {
				model.behaviour = { position: 'null' };
			},
		],
		[
			'shadowRoots を渡しても Shadow の外(ホスト側)を返す',
			(model) => {
				model.behaviour = { position: 'host-even-with-shadowRoots' };
			},
		],
		[
			'ブロックの外(編集面のルート)を返す',
			(model) => {
				model.behaviour = { position: 'surface-root' };
			},
		],
	];
	it.each(cases)('%s: 編集面には入り、キャレットはブロックの先頭(0 文字目)に潰れる', async (_label, setup) => {
		const { container } = renderHtmlDoc();
		const { shadow } = await enterHtmlSurface(container);
		const model = installLayout(container);
		setup(model);
		const { block, target, col } = surfaceTarget(shadow, 'p01', 'w05');
		placements.length = 0;

		await doubleClickAt(target, colClientX(col), blockClientY(BLOCK_P01));

		expect(editables(shadow), '#p01 だけが contenteditable').toEqual([block]);
		expectPlacedCaretAt(block, 0);
	});

	it('ブロックの外(隣のブロックの中)を返す: ダブルクリックしたブロックの先頭・隣のブロックは contenteditable にならない', async () => {
		const { container } = renderHtmlDoc();
		const { shadow } = await enterHtmlSurface(container);
		const model = installLayout(container);
		model.behaviour = { position: 'neighbour-block' };
		const { block, target, col } = surfaceTarget(shadow, 'p01', 'w05');
		const neighbour = q(shadow, '#p02');
		placements.length = 0;

		await doubleClickAt(target, colClientX(col), blockClientY(BLOCK_P01));

		expect(editables(shadow), '#p01 だけが contenteditable').toEqual([block]);
		expectPlacedCaretAt(block, 0);
		expect(placementsIn(neighbour), '隣のブロックの中へ選択を置こうとしていないこと').toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// AC (c) — Shadow の外の経路は caretRangeFromPoint のまま(契約3)
// ---------------------------------------------------------------------------

describe('AC-48-追q (c) — Shadow の外(text のソース編集・markdown のブロック編集)は caretRangeFromPoint のまま(契約3)', () => {
	it('text のダブルクリック: 編集の pre の同じ文字の位置に潰れたキャレット・caretRangeFromPoint で取り、caretPositionFromPoint は呼ばれない', async () => {
		const { container } = renderTextDoc();
		const model = installLayout(container);
		const view = q(container, 'pre.vellis-plaintext:not([contenteditable="true"])');
		expect(view.textContent).toBe(TXT_CONTENT);

		await doubleClickAt(view, colClientX(TXT_CLICK_COL), lineClientY(TXT_CLICK_LINE));

		const editor = q(container, 'pre.vellis-plaintext[contenteditable="true"]');
		expect(windowState.editMode).toBe('edit');
		expectRealCaretAt(editor, TXT_CLICK_OFFSET);
		expect(model.rangeCalls.length, 'caretRangeFromPoint で位置を取っていること').toBeGreaterThan(0);
		expect(model.positionCalls, 'caretPositionFromPoint は呼ばれないこと').toEqual([]);
	});

	it('markdown の段落(inline 要素の上)のダブルクリック: 段落の中の同じ文字数の位置・caretRangeFromPoint で取り、caretPositionFromPoint は呼ばれない', async () => {
		const { container } = renderMarkdownDoc();
		const model = installLayout(container);
		const p = [...container.querySelectorAll('p[data-vellis-node-type="paragraph"]')].find((el) =>
			(el.textContent ?? '').startsWith('Target'),
		) as HTMLElement | undefined;
		if (!p) throw new Error('対象の段落が無い');
		const strong = q(p, 'strong');
		expect(p.textContent).toBe('Target paragraph with bold word.');

		await doubleClickAt(strong, colClientX(MD_COL_IN_BOLD), blockClientY(MD_BLOCK_TARGET));

		expect(editables(container), '対象の段落だけが contenteditable').toEqual([p]);
		expectRealCaretAt(p, MD_COL_IN_BOLD);
		expect(model.rangeCalls.length, 'caretRangeFromPoint で位置を取っていること').toBeGreaterThan(0);
		expect(model.positionCalls, 'caretPositionFromPoint は呼ばれないこと').toEqual([]);
	});
});
