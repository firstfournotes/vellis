/**
 * Issue #851 (4) — 帯・知らせ(と検索バー)を貼り付ける高さは、ツールバー自身の大きさが変わったときに測り直す
 * (window の resize だけでなく。ペインの幅が変わってツールバーが折り返す、など)。component プロジェクト・JSDOM。
 *
 * ## 契約(implementer はこれに従う)
 * - `ResizeObserver` があれば、Viewer は `header.viewer-toolbar` を observe し、通知が来たらツールバーの高さを測り直す
 *   (帯の `top`=`--vellis-banner-top` と検索バーの `top`=`--vellis-find-bar-top` がそれに従う)。window の resize イベントは要らない
 * - 検索バーが開いている間は `.find-bar--sticky` も observe し、通知で測り直す(帯はその下に積まれる)
 * - `ResizeObserver` が無い環境(jsdom)では今までどおり: mount でき、window の resize で測り直す
 * - Viewer が消えたら observe をやめる(disconnect か unobserve)
 *
 * ## 判断の記録(test-writer 2026-11-26)
 * - jsdom に ResizeObserver は無いので、スタブ(viewer-sticky-stack.testkit.ts の `makeFakeResizeObserver`)を mount の前に
 *   global に置き、observe された要素と callback を記録して手で鳴らす。entry には `contentRect.height` と
 *   `borderBoxSize[0].blockSize` を入れ、prototype の `offsetHeight` / `clientHeight` も同じ値を返す(実装がどれを読んでも同じ)
 * - 「ツールバーを observe」は header そのもの(祖先の大きさはツールバーの折り返しで変わらないので、祖先の observe では足りない)
 * - 測った値の行き先は、帯の `top` を解いた px で見る(カスタムプロパティの名前は固定しない)
 *
 * ## 修正前に赤になる理由
 * - Viewer は ResizeObserver を作らない(window の resize だけを見る)ので、header を observe している observer が無い
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { EditorView as PMView } from 'prosemirror-view';

import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import type { MarkdownEditorHandle } from '../editor/file-editor';
import { textSpots } from '../editor/markdown.testkit';
import { componentSource, resolvedTopPx, styleOf } from './viewer-sticky.testkit';
import { effectiveTopPx, makeFakeResizeObserver } from './viewer-sticky-stack.testkit';

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

const VIEWER_CSS = styleOf(componentSource('src/components/Viewer.svelte'));
const FINDBAR_CSS = styleOf(componentSource('src/components/FindBar.svelte'));

/** 実寸(mutable: テストの途中で変える=折り返し)。 */
let toolbarH = 44;
let findBarH = 36;

const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');

function measured(this: HTMLElement): number {
	if (this.matches('header.viewer-toolbar')) return toolbarH;
	if (this.matches('.find-bar--sticky')) return findBarH;
	return 0;
}

beforeAll(() => {
	const zeroRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
	const emptyRects = () => Object.assign([] as DOMRect[], { item: (_i: number) => null }) as unknown as DOMRectList;
	const rangeProto = Range.prototype as unknown as Record<string, unknown>;
	if (typeof rangeProto.getClientRects !== 'function') rangeProto.getClientRects = emptyRects;
	if (typeof rangeProto.getBoundingClientRect !== 'function') rangeProto.getBoundingClientRect = zeroRect;
	if (typeof (document as unknown as Record<string, unknown>).elementFromPoint !== 'function') {
		(document as unknown as Record<string, unknown>).elementFromPoint = () => null;
	}
	Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: measured });
	Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: measured });
});
afterAll(() => {
	for (const [name, desc] of [
		['offsetHeight', originalOffsetHeight],
		['clientHeight', originalClientHeight],
	] as const) {
		if (desc) Object.defineProperty(HTMLElement.prototype, name, desc);
		else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
	}
});

const MD_URI = 'file:///Users/a/notes/plan.md';
const MD = ['# Plan', '', 'Intro paragraph with **bold** word.', '', 'Second paragraph here.', '', 'Tail paragraph.', ''].join('\n');
const CONFLICT = '[data-testid="external-conflict-banner"]';
const TOOLBAR = 'article.viewer header.viewer-toolbar';
const FIND_BAR = 'article.viewer .find-bar--sticky';

function doc(uri: string, content: string): DocumentPayload {
	return { uri, content, modified: 1 };
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
function must(container: ParentNode, selector: string, what: string): HTMLElement {
	const el = container.querySelector<HTMLElement>(selector);
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
function typeMd(s: string, block: number) {
	const v = pmView();
	const spot = textSpots(v.state.doc, block).find((t) => !t.inCode)!;
	v.dispatch(v.state.tr.insertText(s, spot.pos));
}
async function emitMenuFind() {
	await settle();
	const list = [...(menuHandlers.get('menu_find') ?? [])];
	expect(list.length, "Viewer が 'menu_find' を購読していること").toBeGreaterThan(0);
	for (const h of list) h({ payload: undefined });
	await settleLong();
}
/** 重なりの帯を出して返す(帯の `top` で測った高さの行き先を見る)。 */
async function showConflict(container: ParentNode): Promise<HTMLElement> {
	typeMd('MINE ', 1);
	await settle();
	expect(windowState.applyFileChanged(doc(MD_URI, MD.replace('Intro paragraph', 'THEIRS paragraph')))).toBe('external-conflict');
	await settleLong();
	return must(container, CONFLICT, 'conflict banner');
}
function bannerTop(el: HTMLElement): number {
	return effectiveTopPx(VIEWER_CSS, el);
}
function findBarBottom(container: ParentNode): number {
	const bar = must(container, FIND_BAR, 'find bar');
	return resolvedTopPx(FINDBAR_CSS, '.find-bar--sticky', bar) + findBarH;
}

let fakeRO: ReturnType<typeof makeFakeResizeObserver>;

beforeEach(() => {
	toolbarH = 44;
	findBarH = 36;
	windowState.clearDocument();
	windowState.fileEditor = null;
	windowState.editBlocked = false;
	windowState.externalRemoved = false;
	menuHandlers.clear();
	invokeMock.mockReset();
	invokeMock.mockImplementation(async () => null);
	alertMock.mockClear();
	vi.stubGlobal('alert', alertMock);
	fakeRO = makeFakeResizeObserver();
	vi.stubGlobal('ResizeObserver', fakeRO.FakeResizeObserver);
});
afterEach(() => {
	cleanup();
	windowState.clearDocument();
	vi.unstubAllGlobals();
});

describe('Issue #851 (4): ツールバーの大きさの変化で貼り付ける高さを測り直す(ResizeObserver)', () => {
	it('R1 mount すると header.viewer-toolbar を observe している ResizeObserver がある', async () => {
		const { container } = await mountMd();
		const header = must(container, TOOLBAR, 'toolbar');
		expect(fakeRO.observing(header).length, 'header.viewer-toolbar を observe している observer').toBeGreaterThan(0);
	});

	it('R2 ツールバーが折り返して高くなった(ResizeObserver の通知・window の resize は無し)→ 帯の top が新しい高さになる', async () => {
		const { container } = await mountMd();
		const banner = await showConflict(container);
		expect(bannerTop(banner)).toBe(44);
		const header = must(container, TOOLBAR, 'toolbar');
		const resizeSpy = vi.fn();
		window.addEventListener('resize', resizeSpy);
		try {
			toolbarH = 70;
			fakeRO.fire(header, 70);
			await settleLong();
			expect(bannerTop(banner), 'ツールバーの新しい高さ(70)に追う').toBe(70);
			expect(resizeSpy, 'window の resize は起きていない(通知だけで測り直した)').not.toHaveBeenCalled();
			toolbarH = 44;
			fakeRO.fire(header, 44);
			await settleLong();
			expect(bannerTop(banner), '戻れば戻る').toBe(44);
		} finally {
			window.removeEventListener('resize', resizeSpy);
		}
	});

	it('R3 検索バーが開いている間は .find-bar--sticky も observe し、その通知で帯がその下に積み直される', async () => {
		const { container } = await mountMd();
		await emitMenuFind();
		const bar = must(container, FIND_BAR, 'find bar');
		expect(fakeRO.observing(bar).length, '.find-bar--sticky を observe している observer').toBeGreaterThan(0);
		const banner = await showConflict(container);
		expect(bannerTop(banner)).toBeGreaterThanOrEqual(findBarBottom(container));
		findBarH = 72;
		fakeRO.fire(bar, 72);
		await settleLong();
		expect(findBarBottom(container)).toBe(44 + 8 + 72);
		expect(bannerTop(banner), '検索バーの新しい下端以上').toBeGreaterThanOrEqual(findBarBottom(container));
	});

	it('R4 Viewer が消えたら header の observe をやめる(disconnect か unobserve)', async () => {
		const { container, unmount } = await mountMd();
		const header = must(container, TOOLBAR, 'toolbar');
		expect(fakeRO.observing(header).length).toBeGreaterThan(0);
		unmount();
		await settleLong();
		expect(fakeRO.observing(header), 'unmount の後に header を observe し続ける observer が無い').toHaveLength(0);
	});
});

describe('Issue #851 (4): ResizeObserver が無い環境(jsdom)では今までどおり', () => {
	it('R5 ResizeObserver 無しでも mount でき、window の resize でツールバーの高さを測り直す', async () => {
		// beforeEach のスタブを外す(jsdom は ResizeObserver を持たない)。alert のスタブだけ戻す
		vi.unstubAllGlobals();
		vi.stubGlobal('alert', alertMock);
		expect('ResizeObserver' in globalThis, 'jsdom に ResizeObserver は無い').toBe(false);
		const { container } = await mountMd();
		const banner = await showConflict(container);
		expect(bannerTop(banner)).toBe(44);
		toolbarH = 70;
		window.dispatchEvent(new Event('resize'));
		await settleLong();
		expect(bannerTop(banner), 'window の resize で測り直す(従来の契機は残る)').toBe(70);
	});
});
