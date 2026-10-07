/**
 * 要件#69 の受け入れテスト(docs/requirements/req-69.md)— Viewer の配線
 * (component プロジェクト)
 *
 * 純関数側(言語の表・色付きの html の形・上限・検索の一致計算)は
 * src/lib/code-highlight.acceptance.test.ts(unit 側)。ここは `Viewer.svelte` を JSDOM
 * にマウントし、**本番の `renderForDisplay` が返す色付きの html** を props に渡して、
 * 閲覧(色付き)⇄ 編集(素テキスト)の往復と、検索バーの件数が色付きでも変わらない
 * ことを判定する。既存の wiring テスト(Viewer.edit / Viewer.find / Viewer.codeedit)は
 * 書き換えず、本要件用に新設(家風はそこに倣う)。
 *
 * ## 判定するもの(AC 番号は req-69.md の受け入れ基準)
 * - **AC-69-7(契約4)**: `.ts` の文書と色付きの html を渡すと、閲覧中の
 *   `pre.vellis-plaintext` は contenteditable でなく、中に `span`(style 付き)がある。
 *   その `span` をダブルクリックすると `editMode` が `edit` になり、
 *   `pre.vellis-plaintext[contenteditable="true"]` の `textContent` は `document.content`
 *   と一致し、子要素を持たない(素テキスト)。Command + E で入っても同じ ――
 *   `menu_edit` は +page.svelte が受けて `windowState.beginEdit()` を呼ぶ(Viewer は
 *   購読しない)ので、ここでは `beginEdit()` を直接呼んで到着を写す(Viewer.edit の家風)。
 *   編集を破棄(非 dirty の Esc)して閲覧に戻ると、色付きの `span` が再び見える
 * - **AC-69-8(契約7)の Viewer の部分**: 色付きの `.ts` に検索を開いて語を入れると、
 *   件数の表示がプレーン表示(`<pre class="vellis-plaintext">\n…</pre>`)のときと同じ。
 *   Next の送り・Esc で閉じてハイライトが消える動きも変わらない
 *
 * ## 判定しないもの
 * - 言語の判定・上限・エスケープ・一致範囲の中身 → unit 側
 * - +page.svelte の `menu_edit` 購読そのもの → 既存の要件48 の照合
 * - 色の見た目・保存後に色が戻る見え方 → 人間ゲート
 *
 * ## スタブの設計(Viewer.find.wiring の家風)
 * - $lib/ipc / @tauri-apps/plugin-opener / @tauri-apps/plugin-dialog / $lib/mermaid-mounter:
 *   モジュールモック(Tauri 実体なし)
 * - $lib/events: `listen` を控えて `menu_find` の到着を写す(__eventHandlers は裏口)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { renderForDisplay } from '$lib/file-type';

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

/** menu.rs / find-in-document.ts の MENU_FIND_EVENT と同綴り(値固定は要件54 の unit 側)。 */
const MENU_FIND = 'menu_find';

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const TS_URI = 'file:///Users/a/src/app.ts';
/** `const` が 2 行・`a = 1` はトークンをまたいで 1 箇所。 */
const TS_CONTENT = 'const a = 1;\nconst b = a + 1;\n';

/** file-type.ts の renderPlainText と同形(色付けしない表示=比較の基準)。 */
function plainTextHtml(content: string): string {
	const escaped = content.replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
	);
	return `<pre class="vellis-plaintext">\n${escaped}</pre>`;
}

/** 本番の `renderForDisplay` が `.ts` に返す html(実装後は色付き)。 */
let coloredHtml: string;

beforeAll(async () => {
	const result = await renderForDisplay(TS_URI, TS_CONTENT);
	coloredHtml = result.html;
});

function tsDoc(): DocumentPayload {
	return { uri: TS_URI, content: TS_CONTENT, modified: 1 };
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

/** `.ts` 文書を windowState と Viewer の両方に載せてマウントする(html は引数)。 */
function mountTs(html: string) {
	const doc = tsDoc();
	windowState.setDocument(doc);
	return render(Viewer, { props: baseProps(doc, html) });
}

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}

function viewingPre(container: HTMLElement): HTMLElement {
	const pre = container.querySelector('.markdown-body pre.vellis-plaintext');
	if (!pre) throw new Error('pre.vellis-plaintext が見つからない');
	return pre as HTMLElement;
}

function isEditable(el: Element): boolean {
	return el.getAttribute('contenteditable') === 'true';
}

function editables(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll('[contenteditable="true"]')] as HTMLElement[];
}

function styledSpans(scope: ParentNode): HTMLElement[] {
	return [...scope.querySelectorAll('span[style]')] as HTMLElement[];
}

/** 編集面(素テキストの `<pre contenteditable>`)が契約4 の形であることを確かめる。 */
function expectPlainEditor(container: HTMLElement) {
	expect(windowState.editMode).toBe('edit');
	const list = editables(container);
	expect(list, 'contenteditable は 1 つだけ').toHaveLength(1);
	const editor = list[0];
	expect(editor.matches('pre.vellis-plaintext[contenteditable="true"]')).toBe(true);
	expect(editor.textContent).toBe(TS_CONTENT);
	expect(editor.children, '編集面は子要素を持たない(色付きの span を持ち込まない)').toHaveLength(0);
	return editor;
}

async function emitMenuFind() {
	await settle();
	const list = [...(menuHandlers.get(MENU_FIND) ?? [])];
	expect(list.length, "Viewer が $lib/events の listen で 'menu_find' を購読していること").toBeGreaterThan(
		0,
	);
	for (const handler of list) handler({ payload: undefined });
	await settle();
}

function findBar(container: HTMLElement): HTMLElement | null {
	return container.querySelector('[data-testid="find-bar"]');
}

function findInput(container: HTMLElement): HTMLInputElement {
	const el = container.querySelector('[data-testid="find-input"]');
	expect(el, '検索バーの入力欄(data-testid="find-input")があること').toBeTruthy();
	return el as HTMLInputElement;
}

function countText(container: HTMLElement): string {
	const el = container.querySelector('[data-testid="find-count"]');
	expect(el, '件数表示(data-testid="find-count")があること').toBeTruthy();
	return ((el as HTMLElement).textContent ?? '').trim();
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

/** 検索バーで語を入れたときの件数(マウント→menu_find→入力→件数→後始末)。 */
async function countFor(html: string, query: string): Promise<string> {
	const { container } = mountTs(html);
	await emitMenuFind();
	await typeQuery(container, query);
	const count = countText(container);
	cleanup();
	windowState.endEdit();
	windowState.clearDocument();
	menuHandlers.clear();
	return count;
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
// AC-69-7 — 閲覧は色付き・編集は素テキスト・戻ると色が戻る(契約4)
// ---------------------------------------------------------------------------

describe('AC-69-7 — 閲覧は色付きの pre・編集は素テキストの pre(契約4)', () => {
	it('閲覧中の pre.vellis-plaintext は contenteditable でなく、中に style 付きの span がある', () => {
		const { container } = mountTs(coloredHtml);
		const pre = viewingPre(container);

		expect(isEditable(pre)).toBe(false);
		expect(pre.getAttribute('data-vellis-lang')).toBe('typescript');
		expect(pre.querySelector('span')).not.toBeNull();
		expect(styledSpans(pre).length).toBeGreaterThan(0);
		expect(windowState.editMode).toBe('view');
		expect(editables(container)).toHaveLength(0);
	});

	it('色付きの span の上でダブルクリックするとソース編集に入り、編集面は document.content の素テキスト', async () => {
		const { container } = mountTs(coloredHtml);
		const span = styledSpans(viewingPre(container))[0];
		expect(span, '前提: 閲覧中に style 付きの span がある').toBeTruthy();

		await fireEvent.dblClick(span);
		await settle();

		expectPlainEditor(container);
		expect(windowState.dirty).toBe(false);
	});

	it('Command + E(menu_edit → windowState.beginEdit)で入っても同じ素テキストの編集面', async () => {
		const { container } = mountTs(coloredHtml);
		expect(styledSpans(viewingPre(container)).length).toBeGreaterThan(0);

		expect(windowState.beginEdit()).toBe(true);
		await settle();

		expectPlainEditor(container);
	});

	it('編集を破棄(非 dirty の Esc)して閲覧に戻ると、色付きの span が再び見える', async () => {
		const { container } = mountTs(coloredHtml);
		const before = viewingPre(container).innerHTML;
		await fireEvent.dblClick(styledSpans(viewingPre(container))[0]);
		await settle();
		const editor = expectPlainEditor(container);

		await fireEvent.keyDown(editor, { key: 'Escape' });
		await settle();

		expect(windowState.editMode).toBe('view');
		expect(editables(container)).toHaveLength(0);
		const pre = viewingPre(container);
		expect(isEditable(pre)).toBe(false);
		expect(styledSpans(pre).length).toBeGreaterThan(0);
		expect(pre.innerHTML).toBe(before);
	});

	it('Command + E で入ったあと Esc で戻っても色付きの span が再び見える', async () => {
		const { container } = mountTs(coloredHtml);
		windowState.beginEdit();
		await settle();
		const editor = expectPlainEditor(container);

		await fireEvent.keyDown(editor, { key: 'Escape' });
		await settle();

		expect(windowState.editMode).toBe('view');
		expect(styledSpans(viewingPre(container)).length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// AC-69-8 — 検索の件数は色付きでもプレーンと同じ(契約7)
// ---------------------------------------------------------------------------

describe('AC-69-8 — 色付きの .ts に検索を開いても件数はプレーン表示と同じ(契約7)', () => {
	it.each([
		['const', '1 of 2'],
		['a = 1', '1 of 1'],
		['CONST', '1 of 2'],
	])('語 %s: 色付きとプレーンで件数が同じ(%s)', async (query, expected) => {
		const plainCount = await countFor(plainTextHtml(TS_CONTENT), query);
		const coloredCount = await countFor(coloredHtml, query);
		expect(plainCount).toBe(expected);
		expect(coloredCount).toBe(plainCount);
	});

	it('色付きの表示でも Next で送れ、Esc で閉じるとハイライト(フォールバックの mark)が消える', async () => {
		const { container } = mountTs(coloredHtml);
		expect(styledSpans(viewingPre(container)).length, '前提: 色付き').toBeGreaterThan(0);
		await emitMenuFind();
		await typeQuery(container, 'const');
		expect(countText(container)).toBe('1 of 2');
		expect(marks(container).length).toBeGreaterThan(0);
		// 検索は閲覧のまま(編集に入らない)。
		expect(windowState.editMode).toBe('view');

		await keyOn(findInput(container), 'Enter');
		expect(countText(container)).toBe('2 of 2');

		await keyOn(findInput(container), 'Escape');
		expect(findBar(container)).toBeNull();
		expect(marks(container)).toHaveLength(0);
		// 閉じたあとも色付きのまま。
		expect(styledSpans(viewingPre(container)).length).toBeGreaterThan(0);
	});
});
