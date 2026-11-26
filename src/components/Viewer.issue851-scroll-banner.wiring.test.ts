/**
 * Issue #851 (1) — `scrollElementIntoViewer` が、貼り付いた帯・知らせの高さを「隠れる量(covered)」に含める。
 * 帯が出ている間に脚注のリンクで飛んでも、行き先の上端が帯の下に隠れない(component プロジェクト・JSDOM に Viewer を載せる)。
 *
 * ## 契約(implementer はこれに従う)
 * ```ts
 * // Viewer.svelte の scrollElementIntoViewer(要件#73・#836 の式に、見えている sticky の帯・知らせの実寸を足す):
 * //   const gap = 8;
 * //   const covered = toolbar.offsetHeight + (find bar の offsetHeight) + Σ(見えている .external-change / .merged-notice の offsetHeight);
 * //   scroller.scrollTop = Math.max(0, scroller.scrollTop + (dest.getBoundingClientRect().top - scroller.getBoundingClientRect().top - covered - gap));
 * // 「見えている」= DOM にある貼り付いた帯(重なりの帯・削除の帯・取り込みの知らせ)。閾値超えの知らせ(Issue #851 (6) で
 * // 貼り付かなくする)は含めない。
 * ```
 *
 * ## 判断の記録(test-writer 2026-11-26)
 * - MarkdownEditor.footnote-scroll.wiring.test.ts(#836)と同じ見立て: article.viewer の矩形 top=0 height=600・scrollTop は accessor・
 *   ツールバー 44・検索バー 36・行き先の矩形は instance。帯の実寸は出てから instance で差し替える(重なりの帯 37・取り込みの知らせ 30)
 * - 脚注の参照のクリックは Markdown の面(MarkdownEditor が Viewer の scrollElementIntoViewer を受け取って呼ぶ)経由。式は Viewer の 1 か所
 * - 帯が 2 つ出ているときは両方の高さを足す(Issue #851 (2) で積むので、隠れる量は和)
 * - 帯が無いときは #836 の式のまま(閉じた側の固定)
 *
 * ## 修正前に赤になる理由
 * - `covered` がツールバーと検索バーだけなので、帯の高さ(37 / 30)分だけ scrollTop が大きい(行き先が帯の下に入る)
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
import { textSpots } from '../editor/markdown.testkit';

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

const MD_URI = 'file:///Users/a/notes/notes.md';
// ブロック: 0 Intro(脚注の参照)・1 Middle・2 Tail・(脚注の定義は末尾)
const FN = ['Intro[^1] and more.', '', 'Middle paragraph.', '', 'Tail paragraph.', '', '[^1]: First note.', ''].join('\n');

const TOOLBAR_H = 44;
const FIND_BAR_H = 36;
const CONFLICT_H = 37;
const MERGED_H = 30;
const GAP = 8;

const BODY = 'article.viewer .markdown-body';
const PM = `${BODY} [data-testid="markdown-editor"] .ProseMirror`;
const CONFLICT = '[data-testid="external-conflict-banner"]';
const MERGED = '[data-testid="external-merged-notice"]';

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
async function mountMd(content: string, uri = MD_URI) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const r = await renderMarkdown(content, uri);
	const result = render(Viewer, { props: baseProps(d, r.html, r.index) });
	await settleLong();
	return result;
}
function q(container: ParentNode, selector: string): HTMLElement | null {
	return container.querySelector(selector);
}
function qa(container: ParentNode, selector: string): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>(selector)];
}
function must(container: ParentNode, selector: string, what: string): HTMLElement {
	const el = q(container, selector);
	if (!el) throw new Error(`${what} is missing (${selector})`);
	return el;
}
function handle(): MarkdownEditorHandle {
	const h = windowState.fileEditor as MarkdownEditorHandle | null;
	if (!h || h.kind !== 'markdown') throw new Error('Markdown の面の handle が無い');
	return h;
}
function pm(): EditorView {
	return handle().view;
}
function typeMd(s: string, block: number) {
	const v = pm();
	const spot = textSpots(v.state.doc, block).find((t) => !t.inCode)!;
	v.dispatch(v.state.tr.insertText(s, spot.pos));
}

function rect(top: number, height: number): DOMRect {
	return { top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}
function placeAt(el: HTMLElement, top: number, height = 20) {
	el.getBoundingClientRect = () => rect(top, height);
}
function setOffsetHeight(el: HTMLElement, h: number) {
	Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => h });
}
function stubScroller(container: ParentNode, initial = 0): { el: HTMLElement; value: () => number; sets: number[] } {
	const el = must(container, 'article.viewer', 'article.viewer');
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
	return must(container, 'article.viewer header.viewer-toolbar', 'header.viewer-toolbar');
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
function footnoteRef(container: ParentNode, label: string): HTMLElement {
	const sup = qa(container, `${PM} sup.footnote-ref`).find((s) => s.querySelector('a')?.getAttribute('href') === `#fn-${label}`);
	if (!sup) throw new Error(`footnote reference [^${label}] is missing`);
	return sup;
}
function footnoteDef(container: ParentNode, label: string): HTMLElement {
	return must(container, `${BODY} section.footnote-definition[data-label="${label}"]`, `footnote definition [^${label}]`);
}
/** 重なりの帯を出す(Middle を打ち、外部が Middle を変える)。帯の実寸を 37 にして返す。 */
async function showConflict(container: ParentNode): Promise<HTMLElement> {
	typeMd('MINE ', 1);
	await settle();
	const theirs = handle().text().replace('MINE Middle paragraph', 'THEIRS Middle paragraph');
	expect(windowState.applyFileChanged(doc(MD_URI, theirs))).toBe('external-conflict');
	await settleLong();
	const banner = must(container, CONFLICT, 'conflict banner');
	setOffsetHeight(banner, CONFLICT_H);
	return banner;
}
/** 取り込みの知らせを出す(Middle を打ち、外部が Tail を変える=重ならない)。知らせの実寸を 30 にして返す。 */
async function showMerged(container: ParentNode): Promise<HTMLElement> {
	typeMd('MINE ', 1);
	await settle();
	const theirs = handle().text().replace('MINE Middle paragraph', 'Middle paragraph').replace('Tail paragraph.', 'Tail paragraph THEIRS.');
	expect(windowState.applyFileChanged(doc(MD_URI, theirs))).toBe('apply');
	await settleLong();
	const notice = must(container, MERGED, 'merged notice');
	setOffsetHeight(notice, MERGED_H);
	return notice;
}
async function clickFootnote(container: ParentNode, label: string) {
	const sup = footnoteRef(container, label);
	await fireEvent.click(sup.querySelector('a') ?? sup);
	await settleLong();
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
	windowState.fileEditor = null;
	vi.unstubAllGlobals();
});

describe('Issue #851 (1): 脚注へ飛ぶとき、貼り付いた帯・知らせの高さも隠れる量に数える', () => {
	it('B1 重なりの帯(37px)が出ている: scrollTop = 今 + (定義の top − ツールバー − 帯 − 8)', async () => {
		const { container } = await mountMd(FN);
		const scroller = stubScroller(container, 120);
		setOffsetHeight(toolbar(container), TOOLBAR_H);
		await showConflict(container);
		const def = footnoteDef(container, '1');
		placeAt(def, 500);
		await clickFootnote(container, '1');
		expect(scroller.sets.length, 'article.viewer の scrollTop が書かれた').toBeGreaterThan(0);
		expect(scroller.value(), '定義の上端が帯の下端 + 8px').toBe(expectedScrollTop(120, 500, TOOLBAR_H + CONFLICT_H));
		expect(scroller.value()).toBe(531);
	});

	it('B2 取り込みの知らせ(30px)が出ている: 知らせの高さも引く', async () => {
		const { container } = await mountMd(FN);
		const scroller = stubScroller(container, 0);
		setOffsetHeight(toolbar(container), TOOLBAR_H);
		await showMerged(container);
		const def = footnoteDef(container, '1');
		placeAt(def, 900);
		await clickFootnote(container, '1');
		expect(scroller.value()).toBe(expectedScrollTop(0, 900, TOOLBAR_H + MERGED_H));
		expect(scroller.value()).toBe(818);
	});

	it('B3 知らせと帯が同時に出ている(Issue #851 (2) で積まれる): 両方の高さを引く', async () => {
		const { container } = await mountMd(FN);
		const scroller = stubScroller(container, 200);
		setOffsetHeight(toolbar(container), TOOLBAR_H);
		await showMerged(container);
		// 取り込みの後の文書を基準に、Middle が重なる外部変更を届ける
		const theirs = handle().text().replace('MINE Middle paragraph', 'THEIRS Middle paragraph');
		expect(windowState.applyFileChanged(doc(MD_URI, theirs))).toBe('external-conflict');
		await settleLong();
		const banner = must(container, CONFLICT, 'conflict banner');
		setOffsetHeight(banner, CONFLICT_H);
		expect(q(container, MERGED), '知らせも出たまま').not.toBeNull();
		const def = footnoteDef(container, '1');
		placeAt(def, 700);
		await clickFootnote(container, '1');
		expect(scroller.value()).toBe(expectedScrollTop(200, 700, TOOLBAR_H + MERGED_H + CONFLICT_H));
		expect(scroller.value()).toBe(781);
	});

	it('B4 検索バーも開いている: ツールバー + 検索バー + 帯', async () => {
		const { container } = await mountMd(FN);
		const scroller = stubScroller(container, 50);
		setOffsetHeight(toolbar(container), TOOLBAR_H);
		await emitMenuFind();
		const bar = must(container, 'article.viewer .find-bar--sticky', 'find bar');
		setOffsetHeight(bar, FIND_BAR_H);
		await showConflict(container);
		const def = footnoteDef(container, '1');
		placeAt(def, 600);
		await clickFootnote(container, '1');
		expect(scroller.value()).toBe(expectedScrollTop(50, 600, TOOLBAR_H + FIND_BAR_H + CONFLICT_H));
		expect(scroller.value()).toBe(525);
	});

	it('B5 帯が下りた後は元の式に戻る(Use the File on Disk → 帯なし)', async () => {
		const { container } = await mountMd(FN);
		const scroller = stubScroller(container, 120);
		setOffsetHeight(toolbar(container), TOOLBAR_H);
		await showConflict(container);
		await fireEvent.click(must(container, '[data-testid="external-conflict-disk"]', 'Use the File on Disk'));
		await settleLong();
		expect(q(container, CONFLICT)).toBeNull();
		const def = footnoteDef(container, '1');
		placeAt(def, 500);
		await clickFootnote(container, '1');
		expect(scroller.value()).toBe(expectedScrollTop(120, 500, TOOLBAR_H));
		expect(scroller.value()).toBe(568);
	});

	it('B6 帯が無いときは #836 の式のまま(閉じた側の固定)', async () => {
		const { container } = await mountMd(FN);
		const scroller = stubScroller(container, 120);
		setOffsetHeight(toolbar(container), TOOLBAR_H);
		expect(q(container, CONFLICT)).toBeNull();
		expect(q(container, MERGED)).toBeNull();
		const def = footnoteDef(container, '1');
		placeAt(def, 500);
		await clickFootnote(container, '1');
		expect(scroller.value()).toBe(568);
	});
});
