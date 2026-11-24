/**
 * #836 — Markdown の編集面で脚注へのジャンプの行き先がツールバーの裏に入る(要件73 契約1・2・要件74 項目20「`scrollElementIntoViewer`
 * と同じ運び方で運ぶ」・AC-74-36。component プロジェクト・JSDOM に Viewer を載せる)。
 *
 * 既存の `MarkdownNodeViews.wiring.test.ts` の AC-74-36 は「運んだこと」(scrollIntoView のスタブか article.viewer の scrollTop の setter の
 * どちらかが呼ばれた)までしか見ないので、`scrollIntoView({ block: 'start' })` でも緑になる。ここは**どこへ運んだか**を見る。
 *
 * ## 確定契約(オーケストレーターの決定 2026-11-24。implementer はこれに従う)
 *
 * ```ts
 * // 面の中の航行(脚注の参照 → 定義・戻りリンク → 参照・`#id` のリンク → その要素)は Viewer の scrollElementIntoViewer と同じ運び方:
 * //   const gap = 8;
 * //   const covered = (header.viewer-toolbar の offsetHeight) + (開いていれば .find-bar--sticky の offsetHeight);
 * //   scroller(article.viewer).scrollTop = Math.max(0, scroller.scrollTop + (dest.getBoundingClientRect().top - scroller.getBoundingClientRect().top - covered - gap));
 * // 容器(article.viewer)の scrollTop だけを動かし、祖先は巻き込まない(= 行き先の el.scrollIntoView は呼ばない。Viewer の追補c と同じ契約)。
 * // 作りは実装裁量(例: Viewer が MarkdownEditor に運ぶ関数を渡す)。文書・選択・dirty は変えない(AC-74-36 のまま)
 * ```
 *
 * ## 判断の記録(test-writer 2026-11-24)
 * - jsdom には配置が無いので、article.viewer の `getBoundingClientRect`(top 0・height 600)と `scrollTop`(accessor)・`header.viewer-toolbar` の
 *   `offsetHeight`(44)・開いているときの `.find-bar--sticky` の `offsetHeight`(36)・行き先の `getBoundingClientRect` を instance で差し替え、
 *   クリックの後の scrollTop の値を Viewer の式で計算した期待値と比べる(= 行き先の上端がツールバー(と検索バー)の下端 + 8px に来る)
 * - 「祖先を巻き込まない」は `Element.prototype.scrollIntoView` を記録するスタブに差し替え、行き先(とその中・外)に対して呼ばれないことで見る
 *   (Viewer.findfix.wiring.test.ts の契約と同じ)。実装が scrollIntoView を補助として呼ぶなら、この行だけが赤になる(その時は要件側で決める)
 * - `#見出し` は判断 5(飛ばさない)のままなので見ない。`#id` は生 HTML の id(`#target` か `#user-content-target`)で見る
 * - 戻りリンクは上へ戻るので、行き先の矩形を負の top にして `scrollTop + 負の offset` の経路を見る。`Math.max(0, …)` は上端に近い行き先で見る
 *
 * ## 修正前に赤になる理由
 * - `MarkdownEditor.svelte` の `navigate()` が `target?.scrollIntoView?.({ block: 'start' })` で、article.viewer の scrollTop を動かさない
 *   (期待値に来ない・scrollIntoView が行き先に対して呼ばれる)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { EditorView } from 'prosemirror-view';

import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import type { MarkdownEditorHandle } from '../editor/file-editor';

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
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '$lib/ipc';
import * as eventsModule from '$lib/events';

const openUrlMock = vi.mocked(openUrl);
const invokeMock = vi.mocked(invoke);
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

// ---------------------------------------------------------------------------
// フィクスチャと helper
// ---------------------------------------------------------------------------

const MD_URI = 'file:///Users/a/notes/notes.md';
const FN = [
	'Intro[^1] and more[^note].',
	'',
	'Middle paragraph.',
	'',
	'[^1]: First note.',
	'',
	'[^note]: Named note.',
	'',
	'<div id="target">raw block</div>',
	'',
	'See [here](#target).',
	'',
].join('\n');

/** 配置の見立て(px)。 */
const TOOLBAR_H = 44;
const FIND_BAR_H = 36;
const GAP = 8;

function doc(uri: string, content: string): DocumentPayload {
	return { uri, content, modified: 1 };
}
type ViewerProps = { fileEditor?: boolean; zoom?: number; codeTheme?: string };
function baseProps(d: DocumentPayload, html: string, index: SourceIndex | null, extra: ViewerProps) {
	return { document: d, html, index, onRequestAddMark: vi.fn(), onToggleMarks: vi.fn(), marksOpen: false, ...extra };
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
async function mountMd(content: string, uri = MD_URI) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const r = await renderMarkdown(content, uri);
	const result = render(Viewer, { props: baseProps(d, r.html, r.index, { fileEditor: true }) });
	await settleLong();
	return result;
}

const BODY = 'article.viewer .markdown-body';
const PM = `${BODY} [data-testid="markdown-editor"] .ProseMirror`;

function q(container: ParentNode, selector: string): HTMLElement | null {
	return container.querySelector(selector);
}
function qa(container: ParentNode, selector: string): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>(selector)];
}
function handle(): MarkdownEditorHandle {
	const h = windowState.fileEditor as MarkdownEditorHandle | null;
	if (!h) throw new Error('windowState.fileEditor が登録されていない');
	if (h.kind !== 'markdown') throw new Error(`handle.kind が markdown でない: ${String(h.kind)}`);
	return h;
}
function pm(): EditorView {
	return handle().view;
}
function text(): string {
	return handle().text();
}

/** getBoundingClientRect 用の矩形(top と height だけが契約に効く)。 */
function rect(top: number, height: number): DOMRect {
	return { top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}
/** 要素の矩形を instance で差し替える。 */
function placeAt(el: HTMLElement, top: number, height = 20) {
	el.getBoundingClientRect = () => rect(top, height);
}
/** 要素の offsetHeight を instance で差し替える(sticky の帯の実寸)。 */
function setOffsetHeight(el: HTMLElement, h: number) {
	Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => h });
}
/**
 * article.viewer をスクロール容器に見立てる: 矩形 top=0 height=600・scrollTop は accessor。
 * 現在値の読み書き口を返す。
 */
function stubScroller(container: ParentNode, initial = 0): { el: HTMLElement; value: () => number; sets: number[] } {
	const el = q(container, 'article.viewer');
	if (!el) throw new Error('article.viewer が無い');
	let scrollTop = initial;
	const sets: number[] = [];
	el.getBoundingClientRect = () => rect(0, 600);
	Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true });
	Object.defineProperty(el, 'scrollTop', {
		configurable: true,
		get: () => scrollTop,
		set: (v: number) => {
			sets.push(v);
			scrollTop = v;
		},
	});
	return { el, value: () => scrollTop, sets };
}
function toolbar(container: ParentNode): HTMLElement {
	const el = q(container, 'article.viewer header.viewer-toolbar');
	if (!el) throw new Error('header.viewer-toolbar が無い');
	return el;
}
/** 期待値: Viewer.scrollElementIntoViewer の式(容器の top は 0)。 */
function expectedScrollTop(current: number, destTop: number, covered: number): number {
	return Math.max(0, current + (destTop - 0 - covered - GAP));
}
async function emitMenuFind() {
	await settle();
	const list = [...(menuHandlers.get('menu_find') ?? [])];
	expect(list.length, "Viewer が 'menu_find' を購読していること").toBeGreaterThan(0);
	for (const h of list) h({ payload: undefined });
	await settleLong();
}

/** scrollIntoView の記録(祖先を巻き込む運び方を使っていないことの観測)。 */
const scrolledIntoView: Element[] = [];
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
function installScrollIntoViewSpy() {
	scrolledIntoView.length = 0;
	Object.defineProperty(Element.prototype, 'scrollIntoView', {
		configurable: true,
		writable: true,
		value: function (this: Element) {
			scrolledIntoView.push(this);
		},
	});
}
function restoreScrollIntoView() {
	if (originalScrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView);
	else delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView;
}
function scrolledIntoViewAround(dest: Element): Element[] {
	return scrolledIntoView.filter((el) => el === dest || dest.contains(el) || el.contains(dest));
}

function footnoteRef(container: ParentNode, label: string): HTMLElement {
	const sup = qa(container, `${PM} sup.footnote-ref`).find((s) => s.querySelector('a')?.getAttribute('href') === `#fn-${label}`);
	if (!sup) throw new Error(`脚注参照 [^${label}] が無い`);
	return sup;
}
function footnoteDef(container: ParentNode, label: string): HTMLElement {
	const def = q(container, `${BODY} section.footnote-definition[data-label="${label}"]`);
	if (!def) throw new Error(`脚注の定義 [^${label}] が無い`);
	return def;
}

beforeEach(() => {
	windowState.clearDocument();
	windowState.fileEditor = null;
	windowState.editBlocked = false;
	invokeMock.mockReset();
	invokeMock.mockImplementation(async () => null);
	openUrlMock.mockClear();
	menuHandlers.clear();
	installScrollIntoViewSpy();
});
afterEach(() => {
	cleanup();
	restoreScrollIntoView();
	windowState.clearDocument();
	windowState.fileEditor = null;
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 脚注の参照 → 定義
// ---------------------------------------------------------------------------

describe('#836 要件73 契約1・項目20: 脚注参照のクリックで、定義の上端がツールバーの下端 + 8px に来る(article.viewer の scrollTop で運ぶ)', () => {
	it('検索バーが閉じているとき: scrollTop = 今の scrollTop + (定義の top − ツールバーの高さ − 8)', async () => {
		const { container } = await mountMd(FN);
		const scroller = stubScroller(container, 120);
		setOffsetHeight(toolbar(container), TOOLBAR_H);
		const def = footnoteDef(container, '1');
		placeAt(def, 500);
		const before = pm().state.selection;
		const sup = footnoteRef(container, '1');
		await fireEvent.click(sup.querySelector('a') ?? sup);
		await settleLong();
		expect(scroller.sets.length, 'article.viewer の scrollTop が書かれた').toBeGreaterThan(0);
		expect(scroller.value(), '定義の上端がツールバーの下端 + 8px').toBe(expectedScrollTop(120, 500, TOOLBAR_H));
		expect(scroller.value()).toBe(568);
		expect(scrolledIntoViewAround(def), '行き先に scrollIntoView を使わない(祖先を巻き込まない)').toHaveLength(0);
		// AC-74-36 のまま: 文書・選択・dirty は変わらない・外へ開かない
		expect(text()).toBe(FN);
		expect(handle().dirty).toBe(false);
		expect(pm().state.selection.eq(before)).toBe(true);
		expect(openUrlMock).not.toHaveBeenCalled();
	});

	it('名前付きの脚注 [^note] でも同じ式', async () => {
		const { container } = await mountMd(FN);
		const scroller = stubScroller(container, 0);
		setOffsetHeight(toolbar(container), TOOLBAR_H);
		const def = footnoteDef(container, 'note');
		placeAt(def, 900);
		const sup = footnoteRef(container, 'note');
		await fireEvent.click(sup.querySelector('a') ?? sup);
		await settleLong();
		expect(scroller.value()).toBe(expectedScrollTop(0, 900, TOOLBAR_H));
		expect(scroller.value()).toBe(848);
		expect(scrolledIntoViewAround(def)).toHaveLength(0);
	});

	it('検索バーが開いているとき: ツールバーに加えて .find-bar--sticky の実寸も引く', async () => {
		const { container } = await mountMd(FN);
		await emitMenuFind();
		const findBar = q(container, 'article.viewer .find-bar--sticky');
		expect(findBar, '検索バー(sticky)が article.viewer の中に出ている').not.toBeNull();
		const scroller = stubScroller(container, 120);
		setOffsetHeight(toolbar(container), TOOLBAR_H);
		setOffsetHeight(findBar!, FIND_BAR_H);
		const def = footnoteDef(container, '1');
		placeAt(def, 500);
		const sup = footnoteRef(container, '1');
		await fireEvent.click(sup.querySelector('a') ?? sup);
		await settleLong();
		expect(scroller.value(), '定義の上端が検索バーの下端 + 8px').toBe(expectedScrollTop(120, 500, TOOLBAR_H + FIND_BAR_H));
		expect(scroller.value()).toBe(532);
		expect(scrolledIntoViewAround(def)).toHaveLength(0);
	});

	it('ツールバーの高さは押すたびに実寸を読む(高さが変わったら次のクリックの行き先も変わる)', async () => {
		const { container } = await mountMd(FN);
		const scroller = stubScroller(container, 0);
		const header = toolbar(container);
		setOffsetHeight(header, TOOLBAR_H);
		const def = footnoteDef(container, '1');
		placeAt(def, 500);
		const sup = footnoteRef(container, '1');
		await fireEvent.click(sup.querySelector('a') ?? sup);
		await settleLong();
		expect(scroller.value()).toBe(expectedScrollTop(0, 500, TOOLBAR_H));
		// 帯が高くなった(ボタンが増えた)。行き先の見た目の位置は同じと見立てる
		setOffsetHeight(header, TOOLBAR_H + 20);
		const current = scroller.value();
		await fireEvent.click(sup.querySelector('a') ?? sup);
		await settleLong();
		expect(scroller.value()).toBe(expectedScrollTop(current, 500, TOOLBAR_H + 20));
	});
});

// ---------------------------------------------------------------------------
// 戻りリンク → 参照
// ---------------------------------------------------------------------------

describe('#836 要件73 契約2・項目20: 戻りリンク ↩ のクリックで、参照の上端がツールバーの下端 + 8px に来る', () => {
	it('上へ戻る(行き先の top が負): scrollTop = 今の scrollTop + (負の top − ツールバーの高さ − 8)', async () => {
		const { container } = await mountMd(FN);
		const scroller = stubScroller(container, 800);
		setOffsetHeight(toolbar(container), TOOLBAR_H);
		const sup = footnoteRef(container, '1');
		placeAt(sup, -300);
		const back = footnoteDef(container, '1').querySelector<HTMLElement>('.footnote-backref');
		expect(back, '戻りリンク').not.toBeNull();
		await fireEvent.click(back!);
		await settleLong();
		expect(scroller.value()).toBe(expectedScrollTop(800, -300, TOOLBAR_H));
		expect(scroller.value()).toBe(448);
		expect(scrolledIntoViewAround(sup)).toHaveLength(0);
		expect(text()).toBe(FN);
		expect(handle().dirty).toBe(false);
	});

	it('上端に近い行き先は 0 で止まる(Math.max(0, …))', async () => {
		const { container } = await mountMd(FN);
		const scroller = stubScroller(container, 10);
		setOffsetHeight(toolbar(container), TOOLBAR_H);
		const sup = footnoteRef(container, 'note');
		placeAt(sup, 20);
		const back = footnoteDef(container, 'note').querySelector<HTMLElement>('.footnote-backref')!;
		await fireEvent.click(back);
		await settleLong();
		expect(scroller.sets.length, 'scrollTop が書かれた').toBeGreaterThan(0);
		expect(scroller.value()).toBe(0);
		expect(scroller.sets.every((v) => v >= 0), '負の scrollTop を書かない').toBe(true);
	});
});

// ---------------------------------------------------------------------------
// `#id` のリンク → その要素(生 HTML の id)
// ---------------------------------------------------------------------------

describe('#836 項目20・判断 5: `#id`(生 HTML の id)のリンクも同じ運び方', () => {
	it('scrollTop = 今の scrollTop + (要素の top − ツールバーの高さ − 8)。openUrl / open_document は呼ばない', async () => {
		const { container } = await mountMd(FN);
		const scroller = stubScroller(container, 0);
		setOffsetHeight(toolbar(container), TOOLBAR_H);
		const a = qa(container, `${PM} a`).find((x) => x.getAttribute('href') === '#target');
		expect(a, '#target のリンク').toBeTruthy();
		const dest = q(container, `${BODY} #target`) ?? q(container, `${BODY} #user-content-target`);
		expect(dest, '生 HTML の id を持つ要素').not.toBeNull();
		placeAt(dest!, 300);
		await fireEvent.click(a!);
		await settleLong();
		expect(scroller.value()).toBe(expectedScrollTop(0, 300, TOOLBAR_H));
		expect(scroller.value()).toBe(248);
		expect(scrolledIntoViewAround(dest!)).toHaveLength(0);
		expect(openUrlMock).not.toHaveBeenCalled();
		expect(invokeMock).not.toHaveBeenCalledWith('open_document', expect.anything());
		expect(handle().dirty).toBe(false);
	});
});
