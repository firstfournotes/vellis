/**
 * Issue #851 (2)(6) — 貼り付いた帯と知らせが同時に出たとき重ならない(積む)・閾値超えの知らせは貼り付かない
 * (component プロジェクト・JSDOM に Viewer を載せる)。
 *
 * ## 契約(implementer はこれに従う)
 * - (2) `.external-change`(重なりの帯 / 削除の帯)と `.merged-notice`(取り込みの知らせ)が同時に出ているとき、
 *   2 つの `top` は違う: 一方はツールバーの直下(Issue #848 の位置=検索バーが開いていればその下端以上)、もう一方は
 *   **その直下**(前者の `top` + 前者の `offsetHeight`)。どちらが先かは実装裁量(DOM の順が自然)。
 *   先の帯が下りたら、残った方はツールバーの直下に戻る。
 * - (6) `markdown-too-large-notice`(2 MiB 超の読み取り専用の知らせ)は貼り付かない(#848 の前のとおり本文と一緒に
 *   スクロールする)。専用の class か修飾 class で `position` を sticky 以外にする。取り込みの知らせ(`external-merged-notice`)
 *   は sticky のまま(Issue #848 の受け入れ)。
 *
 * ## 判断の記録(test-writer 2026-11-26)
 * - 帯の `top` は、要素の inline style の `top` があればそれを、無ければ Viewer.svelte の `<style>` の class の規則を詳細度と
 *   順で重ねた `top` を、要素と祖先の inline のカスタムプロパティで解く(viewer-sticky-stack.testkit.ts)。実装が
 *   「要素ごとのカスタムプロパティ(例 `--vellis-banner-offset`)」でも「inline の `top`」でも「修飾 class」でも通る。
 *   同じ理由で `position` も重ねた宣言で見る
 * - 実寸は jsdom で 0 なので prototype の `offsetHeight` を差し替える(ツールバー 44・検索バー 36・重なりの帯 37・
 *   取り込みの知らせ 30・削除の帯 41。値を違えて「どちらの高さ分ずれたか」が分かるようにする)
 * - 「どのスクロール位置でも」は sticky の性質で、jsdom では見ない(Issue #848 の実機ゲートが帯の位置を見る)
 * - (6) の知らせの class 名は固定しない(「`.merged-notice` のまま修飾 class を足す」も「別の class」も通る)
 *
 * ## 修正前に赤になる理由
 * - (2) 2 つの帯の `top` がどちらも `var(--vellis-banner-top)`=同じ値(重なる)
 * - (6) `markdown-too-large-notice` の class が `merged-notice` だけで、`.merged-notice { position: sticky }` が当たる
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { EditorView as CMView } from '@codemirror/view';
import type { EditorView as PMView } from 'prosemirror-view';

import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import type { MarkdownEditorHandle } from '../editor/file-editor';
import { textSpots } from '../editor/markdown.testkit';
import { MARKDOWN_EDIT_LIMIT_BYTES } from '../editor/markdown-limits';
import { componentSource, resolvedTopPx, styleOf } from './viewer-sticky.testkit';
import { effectivePosition, effectiveTopPx } from './viewer-sticky-stack.testkit';

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
vi.mock('@tauri-apps/api/window', async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	const fake = { label: 'main', emit: vi.fn(async () => undefined), onFocusChanged: vi.fn(async () => () => {}), listen: vi.fn(async () => () => {}) };
	return { ...actual, getCurrentWindow: () => fake };
});
import { invoke } from '$lib/ipc';
import * as eventsModule from '$lib/events';

const invokeMock = vi.mocked(invoke);
const menuHandlers = (eventsModule as unknown as { __eventHandlers: Map<string, Array<(e: { payload: unknown }) => void>> }).__eventHandlers;
const alertMock = vi.fn((_m?: unknown) => {});

const TOOLBAR_H = 44;
const FINDBAR_H = 36;
const CONFLICT_H = 37;
const MERGED_H = 30;
const REMOVED_H = 41;
const VIEWER_CSS = styleOf(componentSource('src/components/Viewer.svelte'));
const FINDBAR_CSS = styleOf(componentSource('src/components/FindBar.svelte'));

const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

beforeAll(() => {
	const zeroRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
	const emptyRects = () => Object.assign([] as DOMRect[], { item: (_i: number) => null }) as unknown as DOMRectList;
	const rangeProto = Range.prototype as unknown as Record<string, unknown>;
	if (typeof rangeProto.getClientRects !== 'function') rangeProto.getClientRects = emptyRects;
	if (typeof rangeProto.getBoundingClientRect !== 'function') rangeProto.getBoundingClientRect = zeroRect;
	if (typeof (document as unknown as Record<string, unknown>).elementFromPoint !== 'function') {
		(document as unknown as Record<string, unknown>).elementFromPoint = () => null;
	}
	Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
		configurable: true,
		get(this: HTMLElement) {
			if (this.matches('header.viewer-toolbar')) return TOOLBAR_H;
			if (this.matches('.find-bar--sticky')) return FINDBAR_H;
			if (this.matches('[data-testid="external-conflict-banner"]')) return CONFLICT_H;
			if (this.matches('[data-testid="external-merged-notice"]')) return MERGED_H;
			if (this.matches('[data-testid="external-removed-banner"]')) return REMOVED_H;
			return 0;
		},
	});
});
afterAll(() => {
	if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
	else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
});

const TXT_URI = 'file:///Users/a/notes/memo.txt';
const TXT_CONTENT = 'first line\nsecond line\nthird line\n';
const MD_URI = 'file:///Users/a/notes/plan.md';
const MD = ['# Plan', '', 'Intro paragraph with **bold** word.', '', 'Second paragraph here.', '', 'Tail paragraph.', ''].join('\n');
const BIG_URI = 'file:///Users/a/notes/big.md';
/** 2 MiB をはっきり超える(ASCII だけなので byte 数=文字数)。 */
const BIG = '# Big\n\n' + 'a'.repeat(MARKDOWN_EDIT_LIMIT_BYTES + 64) + '\n';
const BIG_HTML = '<h1>Big</h1><p>(large body)</p>';

const CONFLICT = '[data-testid="external-conflict-banner"]';
const MERGED = '[data-testid="external-merged-notice"]';
const REMOVED = '[data-testid="external-removed-banner"]';
const TOO_LARGE = '[data-testid="markdown-too-large-notice"]';
const FIND_BAR = 'article.viewer .find-bar--sticky';

function doc(uri: string, content: string): DocumentPayload {
	return { uri, content, modified: 1 };
}
function plainTextHtml(content: string): string {
	const escaped = content.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
	return `<pre class="vellis-plaintext">\n${escaped}</pre>`;
}
function baseProps(d: DocumentPayload, html: string, index: SourceIndex | null) {
	return { document: d, html, index, onRequestAddMark: vi.fn(), onToggleMarks: vi.fn(), marksOpen: false };
}
async function settle(rounds = 8) {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
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
async function mountText(content = TXT_CONTENT, uri = TXT_URI) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const result = render(Viewer, { props: baseProps(d, plainTextHtml(content), null) });
	await settleLong();
	return result;
}
async function mountBig() {
	const d = doc(BIG_URI, BIG);
	windowState.setDocument(d);
	const result = render(Viewer, { props: baseProps(d, BIG_HTML, null) });
	await settleLong();
	return result;
}
function q(container: ParentNode, selector: string): HTMLElement | null {
	return container.querySelector(selector);
}
function must(container: ParentNode, selector: string, what: string): HTMLElement {
	const el = q(container, selector);
	if (!el) throw new Error(`${what} is missing (${selector})`);
	return el;
}
function mdHandle(): MarkdownEditorHandle {
	const h = windowState.fileEditor as MarkdownEditorHandle | null;
	if (!h || h.kind !== 'markdown') throw new Error('Markdown の面の handle が無い');
	return h;
}
function pmView(): PMView {
	return mdHandle().view;
}
/** Markdown の面: 最上位ブロック `block` の最初の text の先頭に `s` を打つ。 */
function typeMd(s: string, block: number) {
	const v = pmView();
	const spot = textSpots(v.state.doc, block).find((t) => !t.inCode)!;
	v.dispatch(v.state.tr.insertText(s, spot.pos));
}
function cm(container: ParentNode): CMView {
	const el = q(container, '[data-testid="code-editor"] .cm-editor');
	if (!el) throw new Error('CodeMirror の面が無い');
	const v = CMView.findFromDOM(el);
	if (!v) throw new Error('EditorView.findFromDOM が null');
	return v;
}
async function emitMenuFind() {
	await settle();
	const list = [...(menuHandlers.get('menu_find') ?? [])];
	expect(list.length, "Viewer が 'menu_find' を購読していること").toBeGreaterThan(0);
	for (const h of list) h({ payload: undefined });
	await settleLong();
}
function top(el: HTMLElement): number {
	return effectiveTopPx(VIEWER_CSS, el);
}
/** 検索バーが貼り付いたときの下端(FindBar の `top` の式を同じやり方で解いた値 + 実寸)。 */
function findBarBottom(container: ParentNode): number {
	const bar = must(container, FIND_BAR, 'find bar');
	return resolvedTopPx(FINDBAR_CSS, '.find-bar--sticky', bar) + FINDBAR_H;
}
/**
 * 2 つの帯が積まれていること: 一方が `base`(ツールバーの直下 or 検索バーの下端)に、もう一方がその直下(= base + 先の実寸)に。
 */
function expectStacked(a: HTMLElement, b: HTMLElement, base: number) {
	const ta = top(a);
	const tb = top(b);
	expect(ta, '2 つの帯の top は同じではない(重なっている)').not.toBe(tb);
	const [first, second] = ta < tb ? [a, b] : [b, a];
	expect(top(first), '先の帯はツールバー(検索バー)の直下').toBe(base);
	expect(top(second), '後の帯は先の帯の直下(top + offsetHeight)').toBe(base + first.offsetHeight);
}

/** 取り込みの知らせ(Tail をマージ)と重なりの帯(Intro が重なる)を同時に出す(Markdown の面)。 */
async function showMergedAndConflict(container: ParentNode) {
	typeMd('MINE ', 1);
	await settle();
	expect(windowState.applyFileChanged(doc(MD_URI, MD.replace('Tail paragraph.', 'Tail paragraph THEIRS.')))).toBe('apply');
	await settleLong();
	const base = mdHandle().text();
	expect(windowState.applyFileChanged(doc(MD_URI, base.replace('MINE Intro paragraph', 'OTHER Intro paragraph')))).toBe('external-conflict');
	await settleLong();
	const notice = must(container, MERGED, 'merged notice');
	const banner = must(container, CONFLICT, 'conflict banner');
	return { notice, banner };
}

beforeEach(() => {
	windowState.clearDocument();
	windowState.fileEditor = null;
	windowState.editBlocked = false;
	windowState.externalRemoved = false;
	menuHandlers.clear();
	invokeMock.mockReset();
	invokeMock.mockImplementation(async () => null);
	alertMock.mockClear();
	vi.stubGlobal('alert', alertMock);
});
afterEach(() => {
	cleanup();
	windowState.clearDocument();
	windowState.externalRemoved = false;
	vi.unstubAllGlobals();
});

describe('Issue #851 (2): 取り込みの知らせと帯が同時に出ても重ならない(積む)', () => {
	it('S1 Markdown の面: 取り込みの知らせ + 重なりの帯 → 一方がツールバーの直下・他方はその直下(top + offsetHeight)', async () => {
		const { container } = await mountMd();
		const { notice, banner } = await showMergedAndConflict(container);
		expect(q(container, FIND_BAR), '検索バーは閉じている').toBeNull();
		expectStacked(notice, banner, TOOLBAR_H);
	});

	it('S2 CodeMirror の面: 取り込みの知らせ + 削除の帯 → 積まれる', async () => {
		const { container } = await mountText();
		cm(container).dispatch({ changes: { from: 0, insert: 'MINE ' } });
		await settle();
		expect(windowState.applyFileChanged(doc(TXT_URI, TXT_CONTENT.replace('third line', 'third line THEIRS')))).toBe('apply');
		await settleLong();
		expect(windowState.applyFileRemoved(TXT_URI)).toBe('keep');
		await settleLong();
		const notice = must(container, MERGED, 'merged notice');
		const banner = must(container, REMOVED, 'removed banner');
		expect(q(container, CONFLICT), '削除の間は重なりの帯を出さない(要件#48 追補h)').toBeNull();
		expectStacked(notice, banner, TOOLBAR_H);
	});

	it('S3 検索バーが開いている: 2 つとも検索バーの下端以上で、積まれる', async () => {
		const { container } = await mountMd();
		await emitMenuFind();
		const { notice, banner } = await showMergedAndConflict(container);
		const barBottom = findBarBottom(container);
		expect(barBottom).toBeGreaterThan(TOOLBAR_H);
		expect(top(notice)).toBeGreaterThanOrEqual(barBottom);
		expect(top(banner)).toBeGreaterThanOrEqual(barBottom);
		const base = Math.min(top(notice), top(banner));
		expectStacked(notice, banner, base);
	});

	it('S4 先の帯が下りたら、残った知らせはツールバーの直下に戻る(Use the File on Disk で重なりが解ける)', async () => {
		const { container } = await mountMd();
		const { notice } = await showMergedAndConflict(container);
		await fireEvent.click(must(container, '[data-testid="external-conflict-disk"]', 'Use the File on Disk'));
		await settleLong();
		expect(q(container, CONFLICT), '重なりの帯が下りた').toBeNull();
		expect(q(container, MERGED), '知らせは残る').toBe(notice);
		expect(top(notice)).toBe(TOOLBAR_H);
	});

	it('S5 1 つだけのときは Issue #848 のまま: ツールバーの直下', async () => {
		const { container } = await mountMd();
		typeMd('MINE ', 1);
		await settle();
		expect(windowState.applyFileChanged(doc(MD_URI, MD.replace('Intro paragraph', 'THEIRS paragraph')))).toBe('external-conflict');
		await settleLong();
		expect(q(container, MERGED)).toBeNull();
		expect(top(must(container, CONFLICT, 'conflict banner'))).toBe(TOOLBAR_H);
	});
});

describe('Issue #851 (6): 閾値超えの知らせは貼り付かない・取り込みの知らせは貼り付いたまま', () => {
	it('T1 markdown-too-large-notice の class を Viewer.svelte の <style> で重ねると position は sticky でない', async () => {
		const { container } = await mountBig();
		const notice = must(container, TOO_LARGE, 'too-large notice');
		expect(notice.classList.length, '知らせに class がある(見た目の規則が当たる)').toBeGreaterThan(0);
		expect(effectivePosition(VIEWER_CSS, notice)).not.toBe('sticky');
	});

	it('T2 external-merged-notice は sticky のまま(Issue #848 の受け入れ)', async () => {
		const { container } = await mountMd();
		typeMd('MINE ', 1);
		await settle();
		expect(windowState.applyFileChanged(doc(MD_URI, MD.replace('Tail paragraph.', 'Tail paragraph THEIRS.')))).toBe('apply');
		await settleLong();
		const notice = must(container, MERGED, 'merged notice');
		expect(effectivePosition(VIEWER_CSS, notice)).toBe('sticky');
		expect(top(notice)).toBe(TOOLBAR_H);
	});
});
