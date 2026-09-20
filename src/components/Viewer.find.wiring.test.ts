/**
 * 要件#54 の受け入れテスト(docs/requirements/req-54.md)— Viewer の検索バー配線
 * (component プロジェクト)
 *
 * 純関数(findMatches / formatCount / stepIndex / applyHighlights ほか)の判定は
 * src/lib/find-in-document.acceptance.test.ts(unit 側)。ここは `Viewer.svelte` を
 * JSDOM にマウントし、**menu_find → 検索バー → 入力 → 件数 → Prev/Next → Esc**
 * の配線を判定する。既存の wiring テスト(Viewer.edit / Viewer.blockedit /
 * Viewer.codeedit / Viewer.htmledit)は書き換えず、本要件用に新設(家風はそこに倣う)。
 *
 * ## 配線に求める契約(本テストが決める。unit 側の API 契約とセット)
 * - **入口**: Viewer が `$lib/events` の `listen` で `'menu_find'`
 *   (= src/lib/find-in-document.ts の MENU_FIND_EVENT。menu.rs 側と同綴り)を購読する。
 *   ⌘E(MENU_EDIT_EVENT)が +page.svelte 経由で windowState を動かすのと違い、
 *   検索バーは Viewer の中で完結する一時 UI なので Viewer 自身が受ける
 *   (本テストは $lib/events をモジュールモックし、登録されたハンドラを直接呼んで
 *   イベント到着を写す)。Tauri 外の文脈(既存 wiring テスト)で listen が失敗しても
 *   マウントが壊れないこと(AC-54-14「既存テストは無改変で緑」の成立条件)
 * - **検索バーの DOM**: `data-testid="find-bar"`(バー)・`find-input`(<input>)・
 *   `find-count`(件数)・`find-prev` / `find-next` / `find-close`(ボタン)。
 *   ボタンの文言(aria-label があればそれ・無ければ textContent)は英語で
 *   **Prev / Next / Close**(要件#51)。件数は `n of m` / `No results` / 空(値固定)
 * - **html の複製面**: `data-testid="html-find-surface"` のホストが open な
 *   Shadow DOM を持ち、`buildEditSurface` 由来の sanitize 済み複製が入る
 *   (htmledit の `html-edit-surface` と同型・ただし読み取り専用)
 * - **ハイライト**: JSDOM は CSS.highlights を持たない= `<mark data-vellis-find>`
 *   フォールバック経路が本テストで通る(API 経路は unit 側で判定済み)
 *
 * ## 判定するもの(AC 番号は req-54.md の受け入れ基準)
 * - AC-54-7 ⌘F で検索バー(契約①): markdown / text / html で出る・再送は入力欄へ
 *   フォーカスを戻して全選択・文言は英語(値固定)
 * - AC-54-8 入力で件数が出る(契約①③④): 語を入れると `n of m`、Enter / Shift+Enter
 *   で現在一致が進む・戻る
 * - AC-54-5/6 の配線面: Prev/Next ボタンと両端の循環・語を変えると 1 件目へ
 * - AC-54-9 Esc で閉じてハイライトが消える(契約⑤): isComposing 中は閉じない。
 *   検索バーが開いているときの Esc は検索バーが先に食う(req-54「既存テストの
 *   棚卸し」の推奨=編集の破棄はされない。バーが閉じた後の Esc は従来どおり破棄)
 * - AC-54-10 html は複製面を読み取り専用(契約②⑦): contenteditable が付かない・
 *   ダブルクリックでも編集に入らない・editMode は view のまま・SANDBOX_ATTRIBUTE と
 *   buildSrcdoc の出力は不変(AC-53-11 と同じ値固定)
 * - AC-54-11 種別ごとの対象(契約②⑥): markdown はレンダリング済み DOM・text は
 *   `<pre>` の中身・記法文字(`**`)は当たらない・pdf / image / audio / video /
 *   model では検索バーが出ない
 * - AC-54-12 再検索の契機(契約⑤): 文書切替で語は保持・件数は新文書のもの。
 *   file_changed の取り込み(apply → props 差し替え=blockedit AC-49-17 の写し方)後に
 *   件数が更新される
 * - AC-54-13 索引を壊さない(契約④⑦): ハイライト中も data-vellis-node-id /
 *   data-vellis-hid の値と数が不変。フォールバックの `<mark>` は確定の直前に外れて
 *   いる(確定後の editBuffer に mark / data-vellis-find が混入しない)
 *
 * ## 判定しないもの
 * - 一致計算・循環・件数文字列・ハイライト API 分岐の中身 → unit 側
 * - +page.svelte の分岐(html 閲覧の iframe と複製面の切り替え・検索バー表示中に
 *   Viewer がマウントされる配線)→ reviewer 照合
 * - メニュー項目(Find…・⌘F)→ src-tauri/tests/acceptance_req54.rs
 * - ハイライトの見た目・scrollIntoView の体感・実 IME・「閉じたらフォーカスが
 *   閲覧面へ戻る」の焦点先 → reviewer 照合+人間ゲート(acceptance.md 要件#54)
 *
 * ## JSDOM 上の注意(blockedit / htmledit wiring の家風)
 * - scrollIntoView は JSDOM に無いので beforeEach でスタブする(現在一致への
 *   スクロールが呼んでも落ちない)
 * - Shadow DOM 内の要素へのイベントは `composed: true` で dispatch する
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import { buildSrcdoc, SANDBOX_ATTRIBUTE } from '$lib/html-viewer';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
	openUrl: vi.fn(async () => undefined),
	openPath: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn() }));
vi.mock('$lib/mermaid-mounter', () => ({
	mountMermaid: vi.fn(async () => undefined),
}));

// menu_find の到着を写すための $lib/events モック。実装は listen(MENU_FIND_EVENT,…)
// で購読すること(契約=ヘッダ)。__eventHandlers はテスト専用の裏口。
vi.mock('$lib/events', () => {
	const handlers = new Map<string, Array<(e: { payload: unknown }) => void>>();
	return {
		listen: async (event: string, handler: (e: { payload: unknown }) => void) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {
				const cur = handlers.get(event) ?? [];
				const at = cur.indexOf(handler);
				if (at >= 0) cur.splice(at, 1);
			};
		},
		__eventHandlers: handlers,
	};
});

import * as eventsModule from '$lib/events';

const menuHandlers = (
	eventsModule as unknown as {
		__eventHandlers: Map<string, Array<(e: { payload: unknown }) => void>>;
	}
).__eventHandlers;

/** menu.rs / find-in-document.ts の MENU_FIND_EVENT と同綴り(値固定は unit 側)。 */
const MENU_FIND = 'menu_find';

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const MD_URI = 'file:///Users/a/notes/zebra.md';
/** 'zebra'(大文字小文字無視)が見出し1・段落2・リスト項目1の計4箇所。段落の
 * 2つ目は **強調** の中=記法文字(`**`)は表示テキストに出ない(契約⑥の判定)。 */
const MD = ['# Zebra Title', '', 'Zebra crossing sees a **ZEBRA** daily.', '', '- zebra item', ''].join(
	'\n',
);
/** 段落の 'crossing' を 'crawling' に変えて確定したときの原文(AC-54-13)。 */
const MD_COMMITTED = MD.replace('crossing', 'crawling');

const MD_B_URI = 'file:///Users/a/notes/other.md';
const MD_B = '# Other\n\nOne zebra here.\n';

/** 外部変更後の同一 URI の内容('zebra' は2箇所)。 */
const MD_CHANGED = '# Plain Title\n\nzebra pair: zebra.\n';

const TXT_URI = 'file:///Users/a/notes/memo.txt';
const TXT = 'one two one\n';

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

/** 検索バーを出さない種別(契約⑥)。 */
const NON_SEARCHABLE = [
	['pdf', 'file:///Users/a/docs/paper.pdf'],
	['image', 'file:///Users/a/pics/photo.png'],
	['audio', 'file:///Users/a/sounds/song.mp3'],
	['video', 'file:///Users/a/movies/clip.mp4'],
	['model', 'file:///Users/a/models/shape.glb'],
] as const;

let renderedMd: { html: string; index: SourceIndex };
let renderedMdB: { html: string; index: SourceIndex };
let renderedMdChanged: { html: string; index: SourceIndex };

beforeAll(async () => {
	// 本番パイプラインの出力を使う(data-vellis-node-id がそのまま載る=blockedit の家風)。
	const a = await renderMarkdown(MD, MD_URI);
	renderedMd = { html: a.html, index: a.index };
	const b = await renderMarkdown(MD_B, MD_B_URI);
	renderedMdB = { html: b.html, index: b.index };
	const c = await renderMarkdown(MD_CHANGED, MD_URI);
	renderedMdChanged = { html: c.html, index: c.index };
	expect(renderedMd.index.byId.size).toBeGreaterThan(0);
});

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

function mountMd() {
	const doc: DocumentPayload = { uri: MD_URI, content: MD, modified: 1 };
	windowState.setDocument(doc);
	return render(Viewer, { props: baseProps(doc, renderedMd.html, renderedMd.index) });
}

function mountText() {
	const doc: DocumentPayload = { uri: TXT_URI, content: TXT, modified: 1 };
	windowState.setDocument(doc);
	return render(Viewer, {
		props: baseProps(doc, '<pre class="vellis-plaintext">\n' + TXT + '</pre>'),
	});
}

function mountHtml() {
	const doc: DocumentPayload = { uri: HTML_URI, content: HTML_SRC, modified: 1 };
	windowState.setDocument(doc);
	// html 種別の Viewer には file-type.ts が html:'' / index:null を渡す(htmledit の家風)。
	return render(Viewer, { props: baseProps(doc, '') });
}

function mountBinary(uri: string) {
	const doc: DocumentPayload = { uri, content: '', modified: 1 };
	windowState.setDocument(doc);
	return render(Viewer, { props: baseProps(doc, '') });
}

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}

/** menu_find の到着を写す。Viewer が購読していなければここで落ちる(AC-54-7)。 */
async function emitMenuFind() {
	await settle(); // マウント時の listen(async)が済むのを待つ
	const list = [...(menuHandlers.get(MENU_FIND) ?? [])];
	expect(
		list.length,
		"Viewer が $lib/events の listen で 'menu_find' を購読していること",
	).toBeGreaterThan(0);
	for (const handler of list) handler({ payload: undefined });
	await settle();
}

/** 購読が無くても失敗しない発火(検索バーを出さない種別=契約⑥の判定用)。 */
async function emitMenuFindIfAny() {
	await settle();
	for (const handler of [...(menuHandlers.get(MENU_FIND) ?? [])]) handler({ payload: undefined });
	await settle();
}

function findBar(container: HTMLElement): HTMLElement | null {
	return container.querySelector('[data-testid="find-bar"]');
}

function findInput(container: HTMLElement): HTMLInputElement {
	const el = container.querySelector('[data-testid="find-input"]');
	expect(el, '検索バーの入力欄(data-testid="find-input")があること').toBeTruthy();
	expect((el as HTMLElement).tagName).toBe('INPUT');
	return el as HTMLInputElement;
}

function countText(container: HTMLElement): string {
	const el = container.querySelector('[data-testid="find-count"]');
	expect(el, '件数表示(data-testid="find-count")があること').toBeTruthy();
	return ((el as HTMLElement).textContent ?? '').trim();
}

function button(container: HTMLElement, testid: string): HTMLElement {
	const el = container.querySelector('[data-testid="' + testid + '"]');
	expect(el, testid + ' があること').toBeTruthy();
	return el as HTMLElement;
}

/** aria-label があればそれ・無ければ textContent(英語文言の値固定=要件#51)。 */
function accessibleName(el: HTMLElement): string {
	return el.getAttribute('aria-label') ?? (el.textContent ?? '').trim();
}

async function typeQuery(container: HTMLElement, value: string) {
	await fireEvent.input(findInput(container), { target: { value } });
	await settle();
}

async function keyOn(el: Element, key: string, init: KeyboardEventInit = {}) {
	el.dispatchEvent(
		new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true, ...init }),
	);
	await settle();
}

function marks(scope: ParentNode): HTMLElement[] {
	return [...scope.querySelectorAll('mark[data-vellis-find]')] as HTMLElement[];
}

function nodeIds(container: HTMLElement): (string | null)[] {
	return [...container.querySelectorAll('[data-vellis-node-id]')].map((el) =>
		el.getAttribute('data-vellis-node-id'),
	);
}

function surfaceShadow(container: HTMLElement): ShadowRoot {
	const host = container.querySelector('[data-testid="html-find-surface"]');
	expect(host, 'html の複製面(data-testid="html-find-surface")が出ること').toBeTruthy();
	const shadow = (host as HTMLElement).shadowRoot;
	expect(shadow, 'ホストが open な Shadow DOM を持つこと').toBeTruthy();
	return shadow as ShadowRoot;
}

function editables(scope: ParentNode): HTMLElement[] {
	return [...scope.querySelectorAll('[contenteditable="true"]')] as HTMLElement[];
}

/** blockquote 等の外にある最初の段落(blockedit の家風)。 */
function plainParagraph(container: HTMLElement): HTMLElement {
	const p = container.querySelector('p[data-vellis-node-type="paragraph"]');
	if (!p) throw new Error('段落が無い');
	return p as HTMLElement;
}

/** 編集中の要素から、`needle` を含むテキストノードを探す(mark で分割されていても
 * 素のテキストノードは残る=フィクスチャは 'crossing' を検索語に含めない)。 */
function textNodeContaining(el: HTMLElement, needle: string): Text {
	const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	let node = walker.nextNode();
	while (node) {
		if ((node.nodeValue ?? '').includes(needle)) return node as Text;
		node = walker.nextNode();
	}
	throw new Error("テキストノードが見つからない: " + needle);
}

async function dblClickOn(el: Element) {
	el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true }));
	await settle();
}

async function mouseDownOn(el: Element) {
	el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
	await settle();
}

beforeEach(() => {
	windowState.endEdit();
	windowState.clearDocument();
	menuHandlers.clear();
	// JSDOM に scrollIntoView が無い(現在一致へのスクロールが呼んでも落ちないように)。
	Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView;
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC-54-7 — ⌘F で検索バー(契約①)
// ---------------------------------------------------------------------------

describe('AC-54-7 — ⌘F で検索バー(契約①)', () => {
	it('markdown: menu_find で検索バー(入力・件数・Prev・Next・Close)が出る・文言は英語・編集には入らない', async () => {
		const { container } = mountMd();
		expect(findBar(container)).toBeNull();

		await emitMenuFind();

		expect(findBar(container)).toBeTruthy();
		findInput(container);
		expect(countText(container)).toBe('');
		expect(accessibleName(button(container, 'find-prev'))).toBe('Prev');
		expect(accessibleName(button(container, 'find-next'))).toBe('Next');
		expect(accessibleName(button(container, 'find-close'))).toBe('Close');
		// 検索は閲覧のまま(編集モードに入らない・ソース編集の pre も出ない)。
		expect(windowState.editMode).toBe('view');
		expect(container.querySelector('pre.vellis-plaintext[contenteditable]')).toBeNull();
	});

	it('text: menu_find で検索バーが出る', async () => {
		const { container } = mountText();
		await emitMenuFind();
		expect(findBar(container)).toBeTruthy();
	});

	it('html: menu_find で検索バーが出る', async () => {
		const { container } = mountHtml();
		await emitMenuFind();
		expect(findBar(container)).toBeTruthy();
	});

	it('既に出ているときの再送は入力欄へフォーカスを戻し、現在の語を全選択する(バーは1つのまま)', async () => {
		const { container } = mountMd();
		await emitMenuFind();
		await typeQuery(container, 'zebra');
		const input = findInput(container);
		input.blur();
		expect(document.activeElement).not.toBe(input);

		await emitMenuFind();

		expect(container.querySelectorAll('[data-testid="find-bar"]')).toHaveLength(1);
		expect(document.activeElement).toBe(input);
		expect(input.value).toBe('zebra');
		expect(input.selectionStart).toBe(0);
		expect(input.selectionEnd).toBe('zebra'.length);
	});
});

// ---------------------------------------------------------------------------
// AC-54-8 — 入力で件数が出る・Enter / Shift+Enter で送る(契約①③④)
// ---------------------------------------------------------------------------

describe('AC-54-8 — 入力で件数が出る・Enter / Shift+Enter(契約①③④)', () => {
	it('語を入れると件数が n of m になり、Enter で進み Shift+Enter で戻る', async () => {
		const { container } = mountMd();
		await emitMenuFind();

		await typeQuery(container, 'zebra');
		expect(countText(container)).toBe('1 of 4');

		await keyOn(findInput(container), 'Enter');
		expect(countText(container)).toBe('2 of 4');

		await keyOn(findInput(container), 'Enter', { shiftKey: true });
		expect(countText(container)).toBe('1 of 4');
	});

	it('当たらない語は No results・空文字に戻すと表示は空でハイライトも消える', async () => {
		const { container } = mountMd();
		await emitMenuFind();

		await typeQuery(container, 'zzzzz');
		expect(countText(container)).toBe('No results');
		expect(marks(container)).toHaveLength(0);

		await typeQuery(container, '');
		expect(countText(container)).toBe('');
		expect(marks(container)).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// AC-54-5/6 の配線面 — Prev/Next の循環・語を変えると先頭へ(契約④)
// ---------------------------------------------------------------------------

describe('AC-54-5/6 の配線面 — 循環と再検索(契約④)', () => {
	it('Prev/Next ボタンは両端で循環する(1 of 4 → Prev → 4 of 4 → Next → 1 of 4)', async () => {
		const { container } = mountMd();
		await emitMenuFind();
		await typeQuery(container, 'zebra');
		expect(countText(container)).toBe('1 of 4');

		await fireEvent.click(button(container, 'find-prev'));
		await settle();
		expect(countText(container)).toBe('4 of 4');

		await fireEvent.click(button(container, 'find-next'));
		await settle();
		expect(countText(container)).toBe('1 of 4');
	});

	it('1件だけのときは Enter / Shift+Enter どちらでも 1 of 1 に留まる', async () => {
		const { container } = mountText();
		await emitMenuFind();
		await typeQuery(container, 'two');
		expect(countText(container)).toBe('1 of 1');

		await keyOn(findInput(container), 'Enter');
		expect(countText(container)).toBe('1 of 1');
		await keyOn(findInput(container), 'Enter', { shiftKey: true });
		expect(countText(container)).toBe('1 of 1');
	});

	it('語を変えて再検索すると現在一致は1件目に戻る', async () => {
		const { container } = mountMd();
		await emitMenuFind();
		await typeQuery(container, 'zebra');
		await keyOn(findInput(container), 'Enter');
		await keyOn(findInput(container), 'Enter');
		expect(countText(container)).toBe('3 of 4');

		await typeQuery(container, 'title');
		expect(countText(container)).toBe('1 of 1');
	});
});

// ---------------------------------------------------------------------------
// AC-54-9 — Esc で閉じてハイライトが消える(契約⑤)
// ---------------------------------------------------------------------------

describe('AC-54-9 — Esc で閉じてハイライトが消える(契約⑤)', () => {
	it('Esc で検索バーが消え、ハイライト(フォールバックの mark)が残らない', async () => {
		const { container } = mountMd();
		await emitMenuFind();
		await typeQuery(container, 'zebra');
		expect(marks(container).length).toBeGreaterThan(0);

		await keyOn(findInput(container), 'Escape');

		expect(findBar(container)).toBeNull();
		expect(marks(container)).toHaveLength(0);
	});

	it('IME の変換中(isComposing)の Esc では閉じない', async () => {
		const { container } = mountMd();
		await emitMenuFind();
		await typeQuery(container, 'zebra');

		await keyOn(findInput(container), 'Escape', { isComposing: true });

		expect(findBar(container)).toBeTruthy();
		expect(countText(container)).toBe('1 of 4');
	});

	it('検索バーが開いているときの Esc は検索バーが先に食う(ブロック編集は破棄されない。閉じた後の Esc は従来どおり破棄)', async () => {
		const { container } = mountMd();
		await emitMenuFind();
		await typeQuery(container, 'zebra');

		// ブロック編集に入る(要件#49 の経路はそのまま生きている)。
		const p = plainParagraph(container);
		await dblClickOn(p);
		expect(editables(container)).toHaveLength(1);

		// 編集面の上の Esc: 検索バーだけが閉じ、編集は続く(req-54 棚卸しの推奨)。
		await keyOn(editables(container)[0], 'Escape');
		expect(findBar(container)).toBeNull();
		expect(editables(container)).toHaveLength(1);
		expect(windowState.dirty).toBe(false);

		// バーが閉じた後の Esc は既存どおりブロック編集の破棄(退行しない)。
		await keyOn(editables(container)[0], 'Escape');
		expect(editables(container)).toHaveLength(0);
		expect(windowState.dirty).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC-54-10 — html は複製面を読み取り専用で使う(契約②⑦)
// ---------------------------------------------------------------------------

describe('AC-54-10 — html は複製面を読み取り専用で使う(契約②⑦)', () => {
	it('menu_find で buildEditSurface 由来の複製面が出て検索でき、contenteditable は付かない', async () => {
		const { container } = mountHtml();
		await emitMenuFind();

		const shadow = surfaceShadow(container);
		const a = shadow.querySelector('#a');
		expect(a, 'sanitize 済み複製に #a が入ること').toBeTruthy();
		expect((a as HTMLElement).textContent).toBe('Hello bold & world');
		// 読み取り専用: どの要素にも contenteditable が付かない。
		expect(editables(shadow)).toHaveLength(0);

		// ダブルクリックしても編集に入らない(⌘F は編集の入口ではない)。
		await dblClickOn(a as Element);
		expect(editables(shadow)).toHaveLength(0);
		expect(windowState.editMode).toBe('view');
		expect(windowState.dirty).toBe(false);

		// 検索できる('Hello' は #a に1つ)。
		await typeQuery(container, 'hello');
		expect(countText(container)).toBe('1 of 1');
		expect(marks(shadow).length).toBeGreaterThan(0);
	});

	it('data-vellis-hid の値と数はハイライト中も変わらない(契約⑦=索引を壊さない)', async () => {
		const { container } = mountHtml();
		await emitMenuFind();
		const shadow = surfaceShadow(container);
		const hidsBefore = [...shadow.querySelectorAll('[data-vellis-hid]')].map((el) =>
			el.getAttribute('data-vellis-hid'),
		);
		expect(hidsBefore.length).toBeGreaterThan(0);

		await typeQuery(container, 'hello');
		expect(marks(shadow).length).toBeGreaterThan(0);

		expect(
			[...shadow.querySelectorAll('[data-vellis-hid]')].map((el) =>
				el.getAttribute('data-vellis-hid'),
			),
		).toEqual(hidsBefore);
	});

	it('Esc で閉じると複製面も消え、ハイライトが残らない', async () => {
		const { container } = mountHtml();
		await emitMenuFind();
		const shadow = surfaceShadow(container);
		await typeQuery(container, 'hello');
		expect(marks(shadow).length).toBeGreaterThan(0);

		await keyOn(findInput(container), 'Escape');

		expect(findBar(container)).toBeNull();
		expect(container.querySelector('[data-testid="html-find-surface"]')).toBeNull();
	});

	it('SANDBOX_ATTRIBUTE は空文字列のまま・buildSrcdoc の出力は不変(AC-53-11 と同じ値固定)', () => {
		expect(SANDBOX_ATTRIBUTE).toBe('');
		const doc =
			'<!doctype html>\n<html>\n<head>\n<title>T</title>\n</head>\n<body>\n' +
			'<p>Hello <a href="./x.html">link</a></p>\n</body>\n</html>\n';
		expect(buildSrcdoc(doc, HTML_URI)).toBe(
			'<!doctype html>\n<html>\n<head><base href="vellis-asset://local/Users/a/site/page.html">' +
				'<style>[data-vellis-href],[data-vellis-xlink-href]{color:#0000ee;color:-webkit-link;' +
				'text-decoration:underline;cursor:pointer}</style>\n<title>T</title>\n</head>\n<body>\n' +
				'<p>Hello <a data-vellis-href="./x.html">link</a></p>\n</body>\n</html>\n',
		);
		expect(buildSrcdoc('<p>bare fragment</p>', HTML_URI)).toBe(
			'<base href="vellis-asset://local/Users/a/site/page.html"><p>bare fragment</p>',
		);
	});
});

// ---------------------------------------------------------------------------
// AC-54-11 — 種別ごとの対象(契約②⑥)
// ---------------------------------------------------------------------------

describe('AC-54-11 — 種別ごとの対象(契約②⑥)', () => {
	it('markdown はレンダリング済み DOM の表示テキストが対象(記法文字 ** は当たらない)', async () => {
		const { container } = mountMd();
		await emitMenuFind();

		// 原文には **ZEBRA** の ** があるが、表示テキストには無い(契約⑥)。
		await typeQuery(container, '**');
		expect(countText(container)).toBe('No results');

		// 強調の中の語は表示テキストとして当たる。
		await typeQuery(container, 'zebra');
		expect(countText(container)).toBe('1 of 4');
	});

	it('text は <pre> の中身が対象', async () => {
		const { container } = mountText();
		await emitMenuFind();
		await typeQuery(container, 'one');
		expect(countText(container)).toBe('1 of 2');
	});

	for (const [label, uri] of NON_SEARCHABLE) {
		it(label + ': menu_find を受けても検索バーが出ない', async () => {
			const { container } = mountBinary(uri);
			await emitMenuFindIfAny();
			expect(findBar(container)).toBeNull();
		});
	}
});

// ---------------------------------------------------------------------------
// AC-54-12 — 再検索の契機(契約⑤)
// ---------------------------------------------------------------------------

describe('AC-54-12 — 再検索の契機(契約⑤)', () => {
	it('別の文書を開くと語は保持したまま件数が新しい文書のものになる', async () => {
		const { container, rerender } = mountMd();
		await emitMenuFind();
		await typeQuery(container, 'zebra');
		expect(countText(container)).toBe('1 of 4');

		const docB: DocumentPayload = { uri: MD_B_URI, content: MD_B, modified: 1 };
		windowState.setDocument(docB);
		await rerender(baseProps(docB, renderedMdB.html, renderedMdB.index));
		await settle();

		expect(findBar(container), '検索バーは開いたまま').toBeTruthy();
		expect(findInput(container).value).toBe('zebra');
		expect(countText(container)).toBe('1 of 1');
	});

	it('外部変更(file_changed)の取り込み後に件数が更新される', async () => {
		const { container, rerender } = mountMd();
		await emitMenuFind();
		await typeQuery(container, 'zebra');
		expect(countText(container)).toBe('1 of 4');

		// 閲覧中の外部変更は apply(要件#48 契約⑥)→ +page が再レンダーして
		// props が差し替わる(blockedit AC-49-17 と同じ写し方)。
		const decision = windowState.applyFileChanged({
			uri: MD_URI,
			content: MD_CHANGED,
			modified: 2,
		});
		expect(decision).toBe('apply');
		const changed = windowState.currentDocument as DocumentPayload;
		await rerender(baseProps(changed, renderedMdChanged.html, renderedMdChanged.index));
		await settle();

		expect(findBar(container)).toBeTruthy();
		expect(findInput(container).value).toBe('zebra');
		expect(countText(container)).toBe('1 of 2');
	});
});

// ---------------------------------------------------------------------------
// AC-54-13 — 索引を壊さない(契約④⑦)
// ---------------------------------------------------------------------------

describe('AC-54-13 — 索引を壊さない(契約④⑦)', () => {
	it('ハイライトを出した状態でも data-vellis-node-id の値と数が変わらない', async () => {
		const { container } = mountMd();
		const idsBefore = nodeIds(container);
		expect(idsBefore.length).toBeGreaterThan(0);

		await emitMenuFind();
		await typeQuery(container, 'zebra');
		expect(marks(container).length).toBeGreaterThan(0);

		expect(nodeIds(container)).toEqual(idsBefore);
	});

	it('フォールバックの mark は確定の直前に外れている(確定後の原文に mark / data-vellis-find が混入しない)', async () => {
		const { container } = mountMd();
		await emitMenuFind();
		await typeQuery(container, 'zebra');
		expect(marks(container).length).toBeGreaterThan(0);

		// ハイライトの残る段落をブロック編集(検索語 'zebra' は 'crossing' を含む
		// テキストノードを包まないので、編集操作は mark の分割の影響を受けない)。
		const p = plainParagraph(container);
		await dblClickOn(p);
		expect(editables(container)).toHaveLength(1);
		const node = textNodeContaining(editables(container)[0], 'crossing');
		node.nodeValue = (node.nodeValue as string).replace('crossing', 'crawling');

		// ブロック外クリックで確定(blockedit の家風)。
		const heading = container.querySelector('h1[data-vellis-node-id]') as HTMLElement;
		expect(heading).toBeTruthy();
		await mouseDownOn(heading);

		expect(windowState.dirty).toBe(true);
		const buffer = windowState.editBuffer as string;
		expect(buffer).toBe(MD_COMMITTED);
		expect(buffer).not.toContain('<mark');
		expect(buffer).not.toContain('data-vellis-find');
	});
});
