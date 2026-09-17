/**
 * 要件#53 の受け入れテスト(docs/requirements/req-53.md)— Viewer の HTML
 * レンダリング済み編集の配線(component プロジェクト)
 *
 * 純関数(buildEditSurface / resolveLeafBlock / snapshotBlock / commitBlock)の
 * 判定は src/html/edit.acceptance.test.ts(unit 側)。ここは `Viewer.svelte` を
 * JSDOM にマウントし、**⌘E → 編集面(Shadow DOM)→ ダブルクリック → 確定/破棄 →
 * 要件#48 の保存経路**の配線を判定する。既存の wiring テスト
 * (Viewer.edit / Viewer.blockedit / Viewer.codeedit)は書き換えず、本要件用に
 * 新設(家風はそこに倣う)。
 *
 * ## 配線に求める契約(本テストが決める。unit 側の API 契約とセット)
 * - 編集面のホスト要素: `data-testid="html-edit-surface"`。`attachShadow({mode:
 *   'open'})` で Shadow DOM を持つ(JSDOM は attachShadow を持つ=要件本文)
 * - ツールバー: 既存の「Done」(data-testid="edit-done")に加えて
 *   **「Source」= data-testid="edit-source"**(押すとソース編集モード)
 * - 契約④の拒否通知: `data-testid="htmledit-structure-notice"` の要素に
 *   STRUCTURE_CHANGED_MESSAGE の文言が出る(置き場は light DOM でも Shadow 内でも可)
 * - ⌘E(MENU_EDIT_EVENT)の遷移: +page.svelte の `toggleEditMode` の実体は
 *   `windowState.beginEdit()`(契約⑧が beginEdit の流用を固定)なので、wiring は
 *   その遷移を直接呼んで写す(Viewer.blockedit.wiring.test.ts の家風)。
 *   閲覧の iframe(HtmlViewer)は +page.svelte の `editMode === 'view'` 分岐
 *   (要件#48 契約②・本要件で無改変=req-53「既存テストの棚卸し」)にあるので、
 *   「iframe が消える」は editMode が 'edit' へ動くことで判定する
 *
 * ## 判定するもの(AC 番号は req-53.md の受け入れ基準)
 * - AC-53-10 入口の付け替え(契約①): html の ⌘E で編集面(Shadow DOM+Source/Done)。
 *   ソースの `<pre contenteditable>` は出ない。「Source」でソース編集モードへ・
 *   確定済みの編集はバッファに残る。text / markdown の ⌘E は従来どおり
 * - 契約③の配線面: ダブルクリックした葉ブロック1つだけが contenteditable。
 *   別ブロックへの mousedown で先のブロックを確定してから移る
 * - AC-53-9 確定・破棄・Enter・Esc(契約④⑥): ブロック外クリック / Enter で確定し
 *   dirty。Esc は破棄(原文不変・非 dirty・DOM は編集前)。`<pre>` の Enter は
 *   `\n` 挿入で確定しない。Tab は `<pre>` で `\t`・それ以外で無視。IME 中
 *   (composition 中)の Enter / Esc は無視。paste は text/plain だけ
 * - AC-53-7 の配線面(契約④): 構造変化の確定は拒否され、原文不変・非 dirty・
 *   ブロックの DOM は編集前へ戻り、通知の文言が出る
 * - AC-53-12 保存経路の流用(契約⑧): 確定後の ⌘S 本体(saveDocument)が
 *   書き戻し後の原文で `save_document` を呼び、エコーの file_changed は
 *   ignore-echo。SSH root の html は ⌘E で何も起きない
 *
 * ## 判定しないもの
 * - 編集面の HTML・索引・書き戻しの中身 → src/html/edit.acceptance.test.ts
 * - 編集面の見た目(文書 CSS の効き・閲覧との差)・実 IME・git diff の実地確認
 *   → reviewer 照合+人間ゲート(acceptance/acceptance.md 要件#53 ①〜⑥)
 *
 * ## JSDOM 上の編集操作について(codeedit wiring の家風)
 * JSDOM の contenteditable には既定の編集動作が無いので、テキストの変更は
 * `nodeValue` の書き換えで行い、Enter の改行・Tab のタブ挿入・paste のテキスト
 * 挿入は Viewer 側のハンドラが Selection/Range API で明示的に行う前提で判定する。
 * Shadow DOM の中の要素へのイベントは `composed: true` で dispatch する(document
 * レベルの契機にも Shadow 内の契機にも届く形)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { STRUCTURE_CHANGED_MESSAGE } from '../html/edit';

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

import { invoke } from '$lib/ipc';
import { saveDocument } from '$lib/save-document';

const invokeMock = vi.mocked(invoke);

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const HTML_URI = 'file:///Users/a/site/page.html';
const SSH_HTML_URI = 'ssh://host/site/page.html';
const TXT_URI = 'file:///Users/a/notes/memo.txt';
const MD_URI = 'file:///Users/a/notes/plan.md';

const HTML_SRC = [
	'<!doctype html>',
	'<html>',
	'<head>',
	'<title>Page</title>',
	'<style>p { color: rgb(9, 8, 7); }</style>',
	'</head>',
	'<body>',
	'<p id="a" class="x">Hello <b>bold</b> &amp; world</p>',
	'<h2 id="h">Heading</h2>',
	'<pre id="pr">alpha</pre>',
	'</body>',
	'</html>',
	'',
].join('\n');

/** #a の先頭テキストノードを 'Hi ' へ変えて確定したときの原文。 */
const COMMIT_HI = HTML_SRC.replace('Hello <b>', 'Hi <b>');

function htmlDoc(uri: string = HTML_URI): DocumentPayload {
	return { uri, content: HTML_SRC, modified: 1 };
}

function baseProps(doc: DocumentPayload, html: string) {
	return {
		document: doc,
		html,
		index: null,
		onRequestAddMark: vi.fn(),
		onToggleMarks: vi.fn(),
		marksOpen: false,
	};
}

/** html 文書を windowState と Viewer の両方に載せてマウントする。 */
function renderHtmlDoc(uri: string = HTML_URI) {
	const doc = htmlDoc(uri);
	windowState.setDocument(doc);
	// html 種別の Viewer には file-type.ts が html:'' / index:null を渡す(閲覧は
	// HtmlViewer 側)。編集面は document.content(編集バッファ)から作られる。
	return render(Viewer, { props: baseProps(doc, '') });
}

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}

function surfaceHost(container: HTMLElement): HTMLElement | null {
	return container.querySelector('[data-testid="html-edit-surface"]') as HTMLElement | null;
}

/** ⌘E(MENU_EDIT_EVENT → toggleEditMode)の遷移を写して編集面の ShadowRoot を返す。 */
async function enterHtmlEdit(container: HTMLElement): Promise<ShadowRoot> {
	expect(windowState.beginEdit(), 'html 文書で beginEdit が true を返すこと').toBe(true);
	await settle();
	const host = surfaceHost(container);
	expect(host, '編集面のホスト(data-testid="html-edit-surface")が出ること').toBeTruthy();
	const shadow = (host as HTMLElement).shadowRoot;
	expect(shadow, 'ホストが open な Shadow DOM を持つこと').toBeTruthy();
	return shadow as ShadowRoot;
}

function sq(shadow: ShadowRoot, selector: string): HTMLElement {
	const el = shadow.querySelector(selector);
	if (!el) throw new Error('編集面に要素が見つからない: ' + selector);
	return el as HTMLElement;
}

function editables(shadow: ShadowRoot): HTMLElement[] {
	return [...shadow.querySelectorAll('[contenteditable="true"]')] as HTMLElement[];
}

function sourcePre(container: HTMLElement): HTMLElement | null {
	return container.querySelector('pre.vellis-plaintext');
}

/** Shadow 内の要素へ composed なマウス/キーイベントを送る。 */
async function dblClickOn(el: Element) {
	el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true }));
	await settle();
}

async function mouseDownOn(el: Element) {
	el.dispatchEvent(
		new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }),
	);
	await settle();
}

async function keyOn(el: Element, key: string, init: KeyboardEventInit = {}) {
	el.dispatchEvent(
		new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true, ...init }),
	);
	await settle();
}

async function composition(el: Element, type: 'compositionstart' | 'compositionend') {
	el.dispatchEvent(new CompositionEvent(type, { bubbles: true, composed: true }));
	await settle();
}

/** 要素の childNodes[i] がテキストノードであることを確かめて返す。 */
function textNodeAt(el: Element, i: number): Text {
	const node = el.childNodes[i];
	expect(node?.nodeType, i + ' 番目の子がテキストノードであること').toBe(3);
	return node as Text;
}

/** キャレットを編集要素の末尾に置く(Tab・paste・Enter の挿入位置)。 */
function placeCaretAtEnd(el: HTMLElement) {
	const doc = el.ownerDocument;
	const range = doc.createRange();
	range.selectNodeContents(el);
	range.collapse(false);
	const sel = doc.defaultView?.getSelection();
	if (!sel) throw new Error('Selection が取れない');
	sel.removeAllRanges();
	sel.addRange(range);
}

/** #a をダブルクリックして編集に入り、その要素を返す。 */
async function beginBlockA(shadow: ShadowRoot): Promise<HTMLElement> {
	const a = sq(shadow, '#a');
	await dblClickOn(a);
	const list = editables(shadow);
	expect(list, 'ダブルクリックで contenteditable が1つだけ生まれること').toHaveLength(1);
	expect(list[0]).toBe(a);
	return a;
}

/** 契約④の拒否通知の要素(light DOM でも Shadow 内でも可)。 */
function structureNotice(container: HTMLElement, shadow: ShadowRoot): HTMLElement | null {
	return (
		(container.querySelector('[data-testid="htmledit-structure-notice"]') as HTMLElement) ??
		(shadow.querySelector('[data-testid="htmledit-structure-notice"]') as HTMLElement) ??
		null
	);
}

beforeEach(() => {
	windowState.endEdit();
	windowState.clearDocument();
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC-53-10 — 入口の付け替え(契約①)
// ---------------------------------------------------------------------------

describe('AC-53-10 — 入口の付け替え(契約①)', () => {
	it('html 文書の ⌘E でレンダリング済み編集面が出る(ソースの pre は出ない・iframe は editMode で消える)', async () => {
		const { container } = renderHtmlDoc();
		expect(surfaceHost(container)).toBeNull();
		expect(windowState.editMode).toBe('view'); // 閲覧中= +page の分岐で HtmlViewer(iframe)側

		const shadow = await enterHtmlEdit(container);

		// iframe(HtmlViewer)は +page.svelte の `editMode === 'view'` 分岐(無改変=
		// AC-53-11)にあるので、'edit' へ動いたこと=iframe が消えること。
		expect(windowState.editMode).toBe('edit');
		// 編集面にはレンダリング済みの文書が出ている(ソース文字列ではない)。
		const a = sq(shadow, '#a');
		expect(a.textContent).toBe('Hello bold & world');
		expect(sq(shadow, '#a b').textContent).toBe('bold');
		// ソース編集モードの `<pre contenteditable>` は出ない。
		expect(sourcePre(container)).toBeNull();
		// ツールバーに「Source」と「Done」。
		expect(container.querySelector('[data-testid="edit-source"]')).toBeTruthy();
		expect(container.querySelector('[data-testid="edit-done"]')).toBeTruthy();
	});

	it('「Source」でソース編集モードへ切り替わり、確定済みの編集はバッファに残る', async () => {
		const { container } = renderHtmlDoc();
		const shadow = await enterHtmlEdit(container);

		// 1ブロック編集して Enter で確定(バッファへ書き戻される)。
		const a = await beginBlockA(shadow);
		textNodeAt(a, 0).nodeValue = 'Hi ';
		await keyOn(a, 'Enter');
		expect(windowState.editBuffer).toBe(COMMIT_HI);
		expect(windowState.dirty).toBe(true);

		await fireEvent.click(container.querySelector('[data-testid="edit-source"]') as HTMLElement);
		await settle();

		// ソース編集モード=要件#48 の `<pre contenteditable>` に確定済みの原文が出る。
		const pre = sourcePre(container);
		expect(pre, 'Source でソース編集の pre が出ること').toBeTruthy();
		expect((pre as HTMLElement).getAttribute('contenteditable')).toBe('true');
		expect((pre as HTMLElement).textContent).toBe(COMMIT_HI);
		// 編集面は消え、バッファと dirty は保持(確定済みの編集は失われない)。
		expect(surfaceHost(container)).toBeNull();
		expect(windowState.editBuffer).toBe(COMMIT_HI);
		expect(windowState.dirty).toBe(true);
	});

	it('text の ⌘E は従来どおりソース編集(編集面は出ない)', async () => {
		const doc: DocumentPayload = { uri: TXT_URI, content: 'first\nsecond\n', modified: 1 };
		windowState.setDocument(doc);
		const { container } = render(Viewer, {
			props: baseProps(doc, '<pre class="vellis-plaintext">\nfirst\nsecond\n</pre>'),
		});

		expect(windowState.beginEdit()).toBe(true);
		await settle();

		expect(sourcePre(container)).toBeTruthy();
		expect((sourcePre(container) as HTMLElement).getAttribute('contenteditable')).toBe('true');
		expect(surfaceHost(container)).toBeNull();
	});

	it('markdown の ⌘E は従来どおりソース編集(編集面は出ない)', async () => {
		const doc: DocumentPayload = { uri: MD_URI, content: '# Plan\n\n- item\n', modified: 1 };
		windowState.setDocument(doc);
		const { container } = render(Viewer, {
			props: baseProps(doc, '<h1>Plan</h1>\n<ul><li>item</li></ul>'),
		});

		expect(windowState.beginEdit()).toBe(true);
		await settle();

		const pre = sourcePre(container);
		expect(pre).toBeTruthy();
		expect((pre as HTMLElement).textContent).toBe('# Plan\n\n- item\n');
		expect(surfaceHost(container)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 編集単位の配線(契約③)
// ---------------------------------------------------------------------------

describe('編集単位の配線(契約③)', () => {
	it('インライン要素(b)のダブルクリックで葉ブロック(p)1つだけが contenteditable・ルートは不可', async () => {
		const { container } = renderHtmlDoc();
		const shadow = await enterHtmlEdit(container);

		await dblClickOn(sq(shadow, '#a b'));

		const list = editables(shadow);
		expect(list).toHaveLength(1);
		expect(list[0]).toBe(sq(shadow, '#a'));
		// 編集面のホストにも contenteditable は付かない(コンテナ全体の編集は不可)。
		expect(
			(surfaceHost(container) as HTMLElement).getAttribute('contenteditable'),
		).not.toBe('true');
	});

	it('別ブロックのダブルクリック(mousedown 経路)で先のブロックを確定してから移る', async () => {
		const { container } = renderHtmlDoc();
		const shadow = await enterHtmlEdit(container);
		const a = await beginBlockA(shadow);
		textNodeAt(a, 0).nodeValue = 'Hi ';

		const h = sq(shadow, '#h');
		await mouseDownOn(h);
		await dblClickOn(h);

		// 先のブロック(#a)は確定済み=バッファへ書き戻され、編集は #h へ移る。
		expect(windowState.editBuffer).toBe(COMMIT_HI);
		const list = editables(shadow);
		expect(list).toHaveLength(1);
		expect(list[0]).toBe(h);
		expect(sq(shadow, '#a').getAttribute('contenteditable')).not.toBe('true');
	});
});

// ---------------------------------------------------------------------------
// AC-53-9 — 確定・破棄・Enter・Esc(契約④⑥)
// ---------------------------------------------------------------------------

describe('AC-53-9 — 確定・破棄・Enter・Esc(契約④⑥)', () => {
	it('ブロック外クリックで確定し dirty(editMode は edit のまま=保存の門が開く)', async () => {
		const { container } = renderHtmlDoc();
		const shadow = await enterHtmlEdit(container);
		const a = await beginBlockA(shadow);
		textNodeAt(a, 0).nodeValue = 'Hi ';

		await mouseDownOn(sq(shadow, '#h'));

		expect(a.getAttribute('contenteditable')).not.toBe('true');
		expect(windowState.editBuffer).toBe(COMMIT_HI);
		expect(windowState.dirty).toBe(true);
		expect(windowState.editMode).toBe('edit');
	});

	it('Enter で確定し dirty(p の中に改行は入らない)', async () => {
		const { container } = renderHtmlDoc();
		const shadow = await enterHtmlEdit(container);
		const a = await beginBlockA(shadow);
		textNodeAt(a, 0).nodeValue = 'Hi ';

		await keyOn(a, 'Enter');

		expect(a.getAttribute('contenteditable')).not.toBe('true');
		// 確定後の原文は COMMIT_HI そのもの= Enter が `\n` や `<br>` を足していない。
		expect(windowState.editBuffer).toBe(COMMIT_HI);
		expect(windowState.dirty).toBe(true);
	});

	it('Esc は破棄(原文不変・非 dirty・DOM は編集前へ戻る)', async () => {
		const { container } = renderHtmlDoc();
		const shadow = await enterHtmlEdit(container);
		const a = await beginBlockA(shadow);
		textNodeAt(a, 0).nodeValue = 'XXX ';

		await keyOn(a, 'Escape');

		expect(a.getAttribute('contenteditable')).not.toBe('true');
		expect(a.textContent).toBe('Hello bold & world');
		expect(sq(shadow, '#a b')).toBeTruthy();
		expect(windowState.dirty).toBe(false);
		expect(windowState.editBuffer ?? HTML_SRC).toBe(HTML_SRC);
	});

	it('<pre> の中の Enter は \\n 挿入で確定しない・Tab は \\t 挿入', async () => {
		const { container } = renderHtmlDoc();
		const shadow = await enterHtmlEdit(container);
		const pre = sq(shadow, '#pr');
		await dblClickOn(pre);
		expect(editables(shadow)).toHaveLength(1);

		placeCaretAtEnd(pre);
		await keyOn(pre, 'Enter');

		// 確定していない(編集は続く)・改行が入った。
		expect(editables(shadow)).toHaveLength(1);
		expect(windowState.dirty).toBe(false);
		expect(pre.textContent).toContain('alpha\n');

		placeCaretAtEnd(pre);
		await keyOn(pre, 'Tab');
		expect(pre.textContent).toContain('\t');
		expect(editables(shadow)).toHaveLength(1);
	});

	it('<pre> 以外の Tab は無視(タブ文字は入らず編集は続く)', async () => {
		const { container } = renderHtmlDoc();
		const shadow = await enterHtmlEdit(container);
		const a = await beginBlockA(shadow);

		placeCaretAtEnd(a);
		await keyOn(a, 'Tab');

		expect(a.textContent).not.toContain('\t');
		expect(editables(shadow)).toHaveLength(1);
	});

	it('IME の変換中(composition 中)の Enter / Esc は無視される', async () => {
		const { container } = renderHtmlDoc();
		const shadow = await enterHtmlEdit(container);
		const a = await beginBlockA(shadow);
		textNodeAt(a, 0).nodeValue = 'IME ';

		await composition(a, 'compositionstart');
		await keyOn(a, 'Enter');
		// 確定していない(編集は続く・バッファも動かない)。
		expect(editables(shadow)).toHaveLength(1);
		expect(windowState.dirty).toBe(false);

		await keyOn(a, 'Escape');
		// 破棄もされていない(DOM は編集中の値のまま)。
		expect(editables(shadow)).toHaveLength(1);
		expect(a.textContent).toBe('IME bold & world');

		await composition(a, 'compositionend');
		await keyOn(a, 'Escape');
		// 変換が終われば Esc は通常どおり破棄。
		expect(editables(shadow)).toHaveLength(0);
		expect(a.textContent).toBe('Hello bold & world');
	});

	it('貼り付けは text/plain だけ(HTML の要素は混入しない)', async () => {
		const { container } = renderHtmlDoc();
		const shadow = await enterHtmlEdit(container);
		const a = await beginBlockA(shadow);
		placeCaretAtEnd(a);

		await fireEvent.paste(a, {
			clipboardData: {
				getData: (type: string) =>
					type === 'text/plain' ? 'pasted plain text' : '<span>rich</span>',
			},
		});
		await settle();

		expect(a.textContent).toContain('pasted plain text');
		expect(a.querySelector('span')).toBeNull();
		// 要素が混入していないので確定は拒否されない。
		await keyOn(a, 'Enter');
		expect(windowState.dirty).toBe(true);
		expect(windowState.editBuffer).toContain('pasted plain text');
	});
});

// ---------------------------------------------------------------------------
// AC-53-7 — 構造変化の拒否の配線(契約④)
// ---------------------------------------------------------------------------

describe('AC-53-7 — 構造変化の拒否の配線(契約④)', () => {
	it('要素を消した確定は拒否され、原文不変・非 dirty・DOM は編集前へ戻り、通知の文言が出る', async () => {
		const { container } = renderHtmlDoc();
		const shadow = await enterHtmlEdit(container);
		const a = await beginBlockA(shadow);
		a.removeChild(a.querySelector('b') as HTMLElement);

		await mouseDownOn(sq(shadow, '#h'));

		// 原文不変・非 dirty。
		expect(windowState.editBuffer ?? HTML_SRC).toBe(HTML_SRC);
		expect(windowState.dirty).toBe(false);
		// ブロックの DOM は編集前へ戻る(<b> が復元される)。
		expect(a.getAttribute('contenteditable')).not.toBe('true');
		expect(sq(shadow, '#a b').textContent).toBe('bold');
		expect(a.textContent).toBe('Hello bold & world');
		// 通知の文言(用語集=unit 側で値固定)が出る。
		const notice = structureNotice(container, shadow);
		expect(notice, '拒否通知(data-testid="htmledit-structure-notice")が出ること').toBeTruthy();
		expect((notice as HTMLElement).textContent).toContain(STRUCTURE_CHANGED_MESSAGE);
	});
});

// ---------------------------------------------------------------------------
// AC-53-12 — 保存経路の流用(契約⑧)
// ---------------------------------------------------------------------------

describe('AC-53-12 — 保存経路の流用(契約⑧)', () => {
	it('確定後の ⌘S 本体が書き戻し後の原文で save_document を呼び、エコーは ignore-echo', async () => {
		const { container } = renderHtmlDoc();
		const shadow = await enterHtmlEdit(container);
		const a = await beginBlockA(shadow);
		textNodeAt(a, 0).nodeValue = 'Hi ';
		await keyOn(a, 'Enter');
		expect(windowState.dirty).toBe(true);

		await saveDocument(HTML_URI, windowState.editBuffer as string);

		expect(invokeMock).toHaveBeenCalledWith('save_document', {
			uri: HTML_URI,
			content: COMMIT_HI,
		});
		expect(windowState.dirty).toBe(false);

		// 自己書き込みのエコーは ignore-echo(編集面が再レンダーで飛ばない)。
		const decision = windowState.applyFileChanged({
			uri: HTML_URI,
			content: COMMIT_HI,
			modified: 2,
		});
		expect(decision).toBe('ignore-echo');
	});

	it('SSH root の html は ⌘E で何も起きない(beginEdit が false・編集面もソース pre も出ない)', async () => {
		const { container } = renderHtmlDoc(SSH_HTML_URI);

		expect(windowState.beginEdit()).toBe(false);
		await settle();

		expect(windowState.editMode).toBe('view');
		expect(surfaceHost(container)).toBeNull();
		expect(sourcePre(container)).toBeNull();
	});
});
