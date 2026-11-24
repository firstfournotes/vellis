/**
 * 要件#74 第4段 4-2 — 書式のツールバー(要件56 のモックの画面2 の 5・6・契約8・契約10・由谷の決定 2026-11-17 午後 4-5・4-6)。
 * 正本: docs/review/req74-stage34-prep.md の (C) 2 と (D) AC-74-62。定数と純関数は src/editor/format-toolbar.acceptance.test.ts。
 *
 * ## 対応する受け入れ基準(AC-74-62 のフロントの分)
 * - Markdown の編集面(rendered・書ける)でだけ出し入れでき(`format-toolbar-toggle`・`menu_show_format_toolbar`)、既定は隠す。コード・raw・読み取り専用・
 *   HTML・閾値超えでは出ない(トグルも無い)
 * - 各ボタンが `runFormatCommand` と同じ結果(取引 1 つ)。押しても編集面の選択が変わらない(`mousedown` が defaultPrevented)。
 *   段落の種類の select は `mousedown` を止めない(事後確認 (15)=止めると本物のクリックで選択肢が開かない)。選ぶ前の編集面の選択に当たる
 * - `aria-pressed` が `activeFormat` どおり(太字の中・見出し 2 の中=select の値・リストの中)。変換中に押すと確定の後に 1 回だけ
 * - 状態はアプリ全体で 1 つ(`localStorage` の `vellis.formatToolbar`)=窓を作り直しても残る。View のチェック印のために `format_toolbar_state` を emit
 * - 印刷の CSS で隠れる。Unsaved の札は 1 段目のまま
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * ```ts
 * // --- src/components/FormatToolbar.svelte(新規・AC-56-3 の一覧に足す)
 * //   <div class="format-toolbar" data-testid="format-toolbar" role="toolbar" aria-label="Formatting">
 * //     <select data-testid="format-block-type" aria-label="Paragraph style"> <option value="format-body-text">Body Text</option> … Heading 1〜6 </select>
 * //     ボタン(FORMAT_TOOLBAR_ITEMS の順・'|' は <span class="format-toolbar-sep">)= <button type="button" data-format-id="format-bold" title="Bold (Command + B)"
 * //       aria-label="Bold" aria-pressed={active.has(id)}>…</button>(aria-pressed は activeFormat にある項目=mark 4・リスト 3・Quote・Code Block だけ。Link… / Insert / Clear は持たない)
 * //     ボタンの mousedown は preventDefault(面のフォーカスと選択を奪わない)。select の mousedown は止めない(事後確認 (15))。click / change → runFormatCommand(id, handle)
 * //   <style>: トークンだけ。@media print { .format-toolbar { display: none } }(部品自身で隠す。print.css は第1段から触らないもの=AC-56-16)
 * // --- Viewer.svelte
 * //   header.viewer-toolbar に <button data-testid="format-toolbar-toggle" aria-label="Show Formatting Toolbar" aria-pressed={shown}>(モックの「A」)=
 * //     Markdown の編集面(rendered・書ける)のときだけ。押すと shown を反転し localStorage('vellis.formatToolbar')に書き、
 * //     getCurrentWindow().emit(FORMAT_TOOLBAR_STATE_EVENT, { label, shown })
 * //   shown && 面が Markdown の rendered のとき、ツールバーの下の 2 段目に <FormatToolbar>(.markdown-body の外・article.viewer の中)
 * //   $lib/events の listen(MENU_SHOW_FORMAT_TOOLBAR_EVENT) → 同じ反転(出せない面では何もしない)。mount と面の切り替えで状態を emit
 * //   --vellis-find-bar-top は 2 段の高さで測る。Unsaved の札は 1 段目のまま
 * ```
 *
 * ## 修正前に赤になる理由
 * - `format-toolbar-toggle` も `format-toolbar` も無く、`menu_show_format_toolbar` の購読も `src/editor/format-toolbar.ts` も無い
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TextSelection } from 'prosemirror-state';
import { undoDepth } from 'prosemirror-history';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import type { MarkdownEditorHandle } from '../editor/file-editor';
import { MARKDOWN_EDIT_LIMIT_BYTES } from '../editor/markdown-limits';
import { textSpots } from '../editor/markdown.testkit';
import { FORMAT_TOOLBAR_ITEMS, FORMAT_TOOLBAR_STATE_EVENT, FORMAT_TOOLBAR_STORAGE_KEY, MENU_SHOW_FORMAT_TOOLBAR_EVENT } from '../editor/format-toolbar';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => undefined), openPath: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), message: vi.fn(), open: vi.fn() }));
vi.mock('$lib/mermaid-mounter', () => ({ mountMermaid: vi.fn(async () => undefined) }));
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
const windowEmitMock = vi.fn(async (_event: string, _payload?: unknown) => undefined);
vi.mock('@tauri-apps/api/window', async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	const fake = {
		label: 'main',
		emit: (event: string, payload?: unknown) => windowEmitMock(event, payload),
		onFocusChanged: vi.fn(async () => () => {}),
		listen: vi.fn(async () => () => {}),
	};
	return { ...actual, getCurrentWindow: () => fake };
});
import * as eventsModule from '$lib/events';
const menuHandlers = (eventsModule as unknown as { __eventHandlers: Map<string, Array<(e: { payload: unknown }) => void>> }).__eventHandlers;

beforeAll(() => {
	const zeroRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
	const emptyRects = () => Object.assign([] as DOMRect[], { item: (_i: number) => null }) as unknown as DOMRectList;
	const rangeProto = Range.prototype as unknown as Record<string, unknown>;
	if (typeof rangeProto.getClientRects !== 'function') rangeProto.getClientRects = emptyRects;
	if (typeof rangeProto.getBoundingClientRect !== 'function') rangeProto.getBoundingClientRect = zeroRect;
	if (typeof (document as unknown as Record<string, unknown>).elementFromPoint !== 'function') {
		(document as unknown as Record<string, unknown>).elementFromPoint = () => null;
	}
});

const REPO_ROOT = resolve(__dirname, '../..');
const MD_URI = 'file:///Users/a/notes/plan.md';
const SSH_MD_URI = 'ssh://host/srv/notes/plan.md';
const TXT_URI = 'file:///Users/a/notes/memo.txt';
const HTML_URI = 'file:///Users/a/pages/index.html';
const MD = '# Plan\n\nIntro paragraph with **bold** word.\n\n## Second\n\n- item one\n- item two\n';

function doc(uri: string, content: string): DocumentPayload {
	return { uri, content, modified: 1 };
}
function baseProps(d: DocumentPayload, html: string, index: SourceIndex | null) {
	return { document: d, html, index, onRequestAddMark: vi.fn(), onToggleMarks: vi.fn(), marksOpen: false };
}
async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}
async function settleLong() {
	await settle();
	await new Promise((r) => setTimeout(r, 0));
	await settle();
}
async function mountMd(content = MD, uri = MD_URI) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const r = await renderMarkdown(content, uri);
	const result = render(Viewer, { props: baseProps(d, r.html, r.index) });
	await settleLong();
	return result;
}
async function mountText(content = 'one\ntwo\n', uri = TXT_URI) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const result = render(Viewer, { props: baseProps(d, `<pre class="vellis-plaintext">\n${content}</pre>`, null) });
	await settleLong();
	return result;
}
async function mountHtml() {
	const d = doc(HTML_URI, '<p>hi</p>');
	windowState.setDocument(d);
	const result = render(Viewer, { props: baseProps(d, '', null) });
	await settleLong();
	return result;
}
function q(container: ParentNode, testid: string): HTMLElement | null {
	return container.querySelector(`[data-testid="${testid}"]`);
}
function must(container: ParentNode, testid: string): HTMLElement {
	const el = q(container, testid);
	if (!el) throw new Error(`[data-testid="${testid}"] が無い`);
	return el;
}
function button(container: ParentNode, id: string): HTMLButtonElement {
	const el = container.querySelector<HTMLButtonElement>(`[data-testid="format-toolbar"] [data-format-id="${id}"]`);
	if (!el) throw new Error(`ツールバーのボタン ${id} が無い`);
	return el;
}
function handle(): MarkdownEditorHandle {
	const h = windowState.fileEditor as MarkdownEditorHandle | null;
	if (!h || h.kind !== 'markdown') throw new Error('Markdown の handle が無い');
	return h;
}
function selectText(block: number, from: number, to = from) {
	const v = handle().view;
	const spot = textSpots(v.state.doc, block)[0]!;
	v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, spot.pos + from, spot.pos + to)));
}
async function emitMenu(event: string) {
	await settle();
	const list = [...(menuHandlers.get(event) ?? [])];
	expect(list.length, `Viewer が $lib/events の listen で '${event}' を購読していること`).toBeGreaterThan(0);
	for (const h of list) h({ payload: undefined });
	await settleLong();
}
function stateEmits(): Array<{ label: string; shown: boolean }> {
	return windowEmitMock.mock.calls.filter(([e]) => e === FORMAT_TOOLBAR_STATE_EVENT).map(([, p]) => p as { label: string; shown: boolean });
}
async function show(container: HTMLElement) {
	if (!q(container, 'format-toolbar')) {
		await fireEvent.click(must(container, 'format-toolbar-toggle'));
		await settleLong();
	}
	return must(container, 'format-toolbar');
}

beforeEach(() => {
	windowState.clearDocument();
	windowState.fileEditor = null;
	windowState.editBlocked = false;
	menuHandlers.clear();
	windowEmitMock.mockClear();
	localStorage.clear();
	vi.stubGlobal('alert', vi.fn());
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('AC-74-62: 出し入れ(既定は隠す・「A」のボタン・View ▸ Show Formatting Toolbar・状態はアプリ全体で 1 つ)', () => {
	it('Markdown の編集面: 既定ではツールバーは無く、header に「A」(format-toolbar-toggle・aria-pressed=false・aria-label)。押すと 2 段目に format-toolbar(role toolbar)。もう一度で消える', async () => {
		const { container } = await mountMd();
		expect(q(container, 'format-toolbar'), '既定は隠す(4-5)').toBeNull();
		const toggle = must(container, 'format-toolbar-toggle');
		expect(toggle.tagName).toBe('BUTTON');
		expect(toggle.closest('header.viewer-toolbar'), '「A」はビューアのツールバーの中').not.toBeNull();
		expect(toggle.getAttribute('aria-label')).toBe('Show Formatting Toolbar');
		expect(toggle.getAttribute('aria-pressed')).toBe('false');
		await fireEvent.click(toggle);
		await settleLong();
		const bar = must(container, 'format-toolbar');
		expect(bar.getAttribute('role')).toBe('toolbar');
		expect(bar.getAttribute('aria-label')).toBe('Formatting');
		expect(bar.closest('article.viewer'), 'ペインの中').not.toBeNull();
		expect(bar.closest('.markdown-body'), '本文の外(2 段目)').toBeNull();
		expect(toggle.getAttribute('aria-pressed')).toBe('true');
		expect(localStorage.getItem(FORMAT_TOOLBAR_STORAGE_KEY)).toBe('true');
		await fireEvent.click(toggle);
		await settleLong();
		expect(q(container, 'format-toolbar')).toBeNull();
		expect(toggle.getAttribute('aria-pressed')).toBe('false');
		expect(localStorage.getItem(FORMAT_TOOLBAR_STORAGE_KEY)).toBe('false');
	});

	it('menu_show_format_toolbar(View ▸ Show Formatting Toolbar)でも出し入れ。状態は format_toolbar_state { label, shown } で Rust へ', async () => {
		const { container } = await mountMd();
		const before = stateEmits().length;
		await emitMenu(MENU_SHOW_FORMAT_TOOLBAR_EVENT);
		expect(q(container, 'format-toolbar')).not.toBeNull();
		expect(must(container, 'format-toolbar-toggle').getAttribute('aria-pressed')).toBe('true');
		const emits = stateEmits();
		expect(emits.length).toBeGreaterThan(before);
		expect(emits.at(-1)).toEqual({ label: 'main', shown: true });
		await emitMenu(MENU_SHOW_FORMAT_TOOLBAR_EVENT);
		expect(q(container, 'format-toolbar')).toBeNull();
		expect(stateEmits().at(-1)).toEqual({ label: 'main', shown: false });
	});

	it('状態はアプリ全体で 1 つ: localStorage が true なら開いた時点から出ていて、窓を作り直しても残る', async () => {
		localStorage.setItem(FORMAT_TOOLBAR_STORAGE_KEY, 'true');
		const first = await mountMd();
		expect(q(first.container, 'format-toolbar')).not.toBeNull();
		expect(must(first.container, 'format-toolbar-toggle').getAttribute('aria-pressed')).toBe('true');
		expect(stateEmits().some((s) => s.shown === true), 'mount で状態を知らせる(チェック印)').toBe(true);
		cleanup();
		windowState.clearDocument();
		windowState.fileEditor = null;
		const second = await mountMd();
		expect(q(second.container, 'format-toolbar'), '作り直しても残る').not.toBeNull();
	});

	it('コード・HTML・読み取り専用(SSH の Markdown)・閾値超えでは、localStorage が true でもツールバーも「A」も出ない', async () => {
		localStorage.setItem(FORMAT_TOOLBAR_STORAGE_KEY, 'true');
		const txt = await mountText();
		expect(q(txt.container, 'format-toolbar')).toBeNull();
		expect(q(txt.container, 'format-toolbar-toggle')).toBeNull();
		cleanup();
		windowState.clearDocument();
		windowState.fileEditor = null;
		const html = await mountHtml();
		expect(q(html.container, 'format-toolbar')).toBeNull();
		expect(q(html.container, 'format-toolbar-toggle')).toBeNull();
		cleanup();
		windowState.clearDocument();
		windowState.fileEditor = null;
		const ssh = await mountMd(MD, SSH_MD_URI);
		expect(q(ssh.container, 'format-toolbar')).toBeNull();
		expect(q(ssh.container, 'format-toolbar-toggle')).toBeNull();
		cleanup();
		windowState.clearDocument();
		windowState.fileEditor = null;
		const big = 'x'.repeat(MARKDOWN_EDIT_LIMIT_BYTES + 1) + '\n';
		const large = await mountMd(big);
		expect(q(large.container, 'markdown-too-large-notice'), '閾値超えの描画').not.toBeNull();
		expect(q(large.container, 'format-toolbar')).toBeNull();
		expect(q(large.container, 'format-toolbar-toggle')).toBeNull();
	});

	it('raw(View ▸ Raw Source)の間は消え、rendered に戻ると戻る。menu_show_format_toolbar は raw では何もしない', async () => {
		localStorage.setItem(FORMAT_TOOLBAR_STORAGE_KEY, 'true');
		const { container } = await mountMd();
		expect(q(container, 'format-toolbar')).not.toBeNull();
		handle().toggleRaw();
		await settleLong();
		await new Promise((r) => setTimeout(r, 30));
		await settle();
		expect(handle().raw).toBe(true);
		expect(q(container, 'format-toolbar'), 'raw では出ない').toBeNull();
		for (const h of menuHandlers.get(MENU_SHOW_FORMAT_TOOLBAR_EVENT) ?? []) h({ payload: undefined });
		await settleLong();
		expect(localStorage.getItem(FORMAT_TOOLBAR_STORAGE_KEY), 'raw では状態を変えない').toBe('true');
		handle().toggleRaw();
		await settleLong();
		await new Promise((r) => setTimeout(r, 30));
		await settle();
		expect(q(container, 'format-toolbar'), 'rendered に戻ると戻る').not.toBeNull();
	});

	it('Unsaved の札は 1 段目(format-toolbar の中ではない)のまま', async () => {
		const { container } = await mountMd();
		await show(container);
		selectText(1, 0);
		handle().view.dispatch(handle().view.state.tr.insertText('x'));
		await settleLong();
		const badge = must(container, 'unsaved-badge');
		expect(badge.closest('[data-testid="format-toolbar"]')).toBeNull();
		expect(badge.closest('header.viewer-toolbar')).not.toBeNull();
	});
});

describe('AC-74-62: 中身と押下(モックの順・runFormatCommand と同じ結果・選択を奪わない・aria-pressed=activeFormat・IME)', () => {
	it('中身の順: select(Body Text / Heading 1〜6)→ ボタンが FORMAT_TOOLBAR_ITEMS の順(data-format-id)。title は英語の名前+キー名', async () => {
		const { container } = await mountMd();
		const bar = await show(container);
		const select = must(bar, 'format-block-type') as HTMLSelectElement;
		expect(select.tagName).toBe('SELECT');
		expect([...select.options].map((o) => o.value)).toEqual([
			'format-body-text',
			'format-heading-1',
			'format-heading-2',
			'format-heading-3',
			'format-heading-4',
			'format-heading-5',
			'format-heading-6',
		]);
		expect([...select.options].map((o) => o.textContent?.trim())).toEqual(['Body Text', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6']);
		const ids = [...bar.querySelectorAll<HTMLElement>('[data-format-id]')].map((b) => b.getAttribute('data-format-id'));
		expect(ids).toEqual((FORMAT_TOOLBAR_ITEMS as readonly string[]).filter((x: string) => x !== '|'));
		expect(button(bar, 'format-bold').getAttribute('title')).toBe('Bold (Command + B)');
		expect(button(bar, 'format-bulleted-list').getAttribute('title')).toBe('Bulleted List (Command + Shift + 8)');
		expect(button(bar, 'format-clear').getAttribute('title')).toBe('Clear Formatting');
		expect(button(bar, 'format-bold').getAttribute('aria-label')).toBe('Bold');
		for (const b of bar.querySelectorAll<HTMLButtonElement>('[data-format-id]')) expect(b.type, b.dataset.formatId).toBe('button');
	});

	it('Bold を押すと選んだ語が **…**(取引 1 つ・メニューと同じ)。mousedown は preventDefault され、面の選択は変わらない', async () => {
		const { container } = await mountMd();
		const bar = await show(container);
		selectText(1, 0, 5); // 'Intro'
		const v = handle().view;
		const selBefore = { from: v.state.selection.from, to: v.state.selection.to };
		const depth = undoDepth(v.state);
		const bold = button(bar, 'format-bold');
		const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		bold.dispatchEvent(down);
		expect(down.defaultPrevented, '面のフォーカスと選択を奪わない').toBe(true);
		await fireEvent.click(bold);
		await settleLong();
		expect(handle().text()).toBe(MD.replace('Intro paragraph', '**Intro** paragraph'));
		expect(undoDepth(v.state)).toBe(depth + 1);
		expect({ from: v.state.selection.from, to: v.state.selection.to }, '選択はそのまま').toEqual(selBefore);
		expect(handle().dirty).toBe(true);
	});

	it('select で Heading 2 を選ぶと見出し 2(取引 1 つ)。Bulleted List / Quote / Clear Formatting もメニューと同じ結果', async () => {
		const { container } = await mountMd();
		const bar = await show(container);
		selectText(1, 2);
		const select = must(bar, 'format-block-type') as HTMLSelectElement;
		const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		select.dispatchEvent(down);
		// 事後確認 (15)(2026-11-18): select の mousedown は止めない(止めると本物のクリックで選択肢が開かない)
		expect(down.defaultPrevented).toBe(false);
		await fireEvent.change(select, { target: { value: 'format-heading-2' } });
		await settleLong();
		expect(handle().text()).toBe(MD.replace('Intro paragraph with **bold** word.', '## Intro paragraph with **bold** word.'));
		await fireEvent.change(select, { target: { value: 'format-body-text' } });
		await settleLong();
		expect(handle().text()).toBe(MD);
		await fireEvent.click(button(bar, 'format-quote'));
		await settleLong();
		expect(handle().text()).toBe(MD.replace('Intro paragraph with **bold** word.', '> Intro paragraph with **bold** word.'));
		await fireEvent.click(button(bar, 'format-quote'));
		await settleLong();
		await fireEvent.click(button(bar, 'format-bulleted-list'));
		await settleLong();
		expect(handle().text()).toBe(MD.replace('Intro paragraph with **bold** word.', '- Intro paragraph with **bold** word.'));
		await fireEvent.click(button(bar, 'format-bulleted-list'));
		await settleLong();
		const v = handle().view;
		const spots = textSpots(v.state.doc, 1);
		v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, spots[0]!.pos, spots.at(-1)!.pos + spots.at(-1)!.text.length)));
		await fireEvent.click(button(bar, 'format-clear'));
		await settleLong();
		expect(handle().text()).toBe(MD.replace('**bold**', 'bold'));
	});

	it('aria-pressed は activeFormat どおり: 太字の中なら Bold=true・Italic=false、select は段落の種類(Heading 2 の中なら format-heading-2)、リストの中なら Bulleted List=true', async () => {
		const { container } = await mountMd();
		const bar = await show(container);
		const v = handle().view;
		const bold = textSpots(v.state.doc, 1).find((s) => s.text === 'bold')!;
		v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, bold.pos + 1)));
		await settleLong();
		expect(button(bar, 'format-bold').getAttribute('aria-pressed')).toBe('true');
		expect(button(bar, 'format-italic').getAttribute('aria-pressed')).toBe('false');
		expect((must(bar, 'format-block-type') as HTMLSelectElement).value).toBe('format-body-text');
		expect(button(bar, 'format-link').hasAttribute('aria-pressed'), 'Link… は押下を持たない').toBe(false);
		expect(button(bar, 'format-clear').hasAttribute('aria-pressed')).toBe(false);
		selectText(2, 1); // '## Second'
		await settleLong();
		expect((must(bar, 'format-block-type') as HTMLSelectElement).value).toBe('format-heading-2');
		expect(button(bar, 'format-bold').getAttribute('aria-pressed')).toBe('false');
		selectText(3, 1); // list item
		await settleLong();
		expect(button(bar, 'format-bulleted-list').getAttribute('aria-pressed')).toBe('true');
		expect(button(bar, 'format-numbered-list').getAttribute('aria-pressed')).toBe('false');
		expect((must(bar, 'format-block-type') as HTMLSelectElement).value).toBe('format-body-text');
	});

	it('変換中(view.composing)に押すと確定の後に 1 回だけ当たる(2 回押してもトグルが戻らない)', async () => {
		const { container } = await mountMd();
		const bar = await show(container);
		selectText(1, 0, 5);
		const v = handle().view;
		v.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
		await settle();
		expect(v.composing).toBe(true);
		await fireEvent.click(button(bar, 'format-bold'));
		await fireEvent.click(button(bar, 'format-bold'));
		await settle();
		expect(handle().text(), '変換中は当たらない').toBe(MD);
		v.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
		await settleLong();
		await new Promise((r) => setTimeout(r, 50));
		expect(handle().text()).toBe(MD.replace('Intro paragraph', '**Intro** paragraph'));
	});
});

describe('4-2: 見た目と印刷(ソース走査)', () => {
	it('FormatToolbar.svelte はトークンだけで描き(hex / 色関数の直書きなし)、印刷では部品自身の @media print で隠す(print.css は無改変)', () => {
		const src = readFileSync(resolve(REPO_ROOT, 'src/components/FormatToolbar.svelte'), 'utf8');
		const style = (src.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
		expect(style.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], 'hex の直書き').toEqual([]);
		expect(style.match(/\b(?:rgba?|hsla?)\(/g) ?? [], '色関数の直書き').toEqual([]);
		expect(src).toContain('data-testid="format-toolbar"');
		const inComponent = /@media\s+print\s*\{[\s\S]*?\.format-toolbar[^{}]*\{[^}]*display\s*:\s*none/.test(style);
		expect(inComponent, '部品の <style> の @media print で .format-toolbar を display: none').toBe(true);
		const printCss = readFileSync(resolve(REPO_ROOT, 'src/styles/print.css'), 'utf8');
		expect(printCss, 'print.css には足さない').not.toContain('format-toolbar');
	});
});

// 第4段の P3 の穴(H2・H5)
describe('P3 H2 / H5: 読み取り専用の門だけで出ない・Markdown 以外の面では shown:false を知らせる', () => {
	it('H2: Markdown の面で出ている「A」とツールバーは、handle が読み取り専用になるだけで消える(SSH の有無とは別の門)', async () => {
		localStorage.setItem(FORMAT_TOOLBAR_STORAGE_KEY, 'true');
		const { container } = await mountMd();
		expect(q(container, 'format-toolbar')).not.toBeNull();
		expect(q(container, 'format-toolbar-toggle')).not.toBeNull();
		const real = windowState.fileEditor!;
		const readOnlyHandle = new Proxy(real, {
			get(target, prop, receiver) {
				if (prop === 'readOnly') return true;
				const v = Reflect.get(target, prop, receiver);
				return typeof v === 'function' ? v.bind(target) : v;
			},
		});
		windowState.fileEditor = readOnlyHandle as typeof real;
		await settleLong();
		expect(q(container, 'format-toolbar'), '読み取り専用の門でツールバーが消える').toBeNull();
		expect(q(container, 'format-toolbar-toggle'), '「A」も消える').toBeNull();
		expect(stateEmits().at(-1)).toEqual({ label: 'main', shown: false });
		windowState.fileEditor = real;
		await settleLong();
		expect(q(container, 'format-toolbar'), '戻せば戻る').not.toBeNull();
	});

	it('H5: localStorage が true でも Markdown 以外の面(plain text)では format_toolbar_state に shown:false を送る(チェック印が消える)', async () => {
		localStorage.setItem(FORMAT_TOOLBAR_STORAGE_KEY, 'true');
		await mountText();
		const emits = stateEmits();
		expect(emits.length).toBeGreaterThan(0);
		expect(emits.at(-1)).toEqual({ label: 'main', shown: false });
		expect(emits.some((e) => e.shown === true), 'コードの面で true を送らない').toBe(false);
	});
});
