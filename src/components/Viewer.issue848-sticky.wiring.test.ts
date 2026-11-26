/**
 * Issue #848 (1) — 重なりの帯・削除の帯・取り込みの知らせの `top` がどこに来るか(component プロジェクト・JSDOM に Viewer を載せる)。
 *
 * jsdom は配置も CSS も持たないので、ソースの `top` の宣言(Viewer.issue848-sticky.acceptance.test.ts が sticky と
 * `var(--vellis-…)` を固定)を、帯とその祖先(`article.viewer`)の inline style に Viewer が置くカスタムプロパティで解いて
 * px にし、「ツールバーの直下」「検索バーが開いていればその下」を値で見る(検索バーの追補c(1) と同じ仕組み)。
 *
 * ## 契約(implementer はこれに従う)
 * - 帯/知らせが出ている間、その `top` の式(Viewer.svelte の `.external-change` / `.merged-notice` の宣言)を、帯から祖先へ向かって
 *   inline style のカスタムプロパティで解くと:
 *   - 検索バーが閉じている: ツールバー(`header.viewer-toolbar`)の `offsetHeight` と一致(= 直下)。**検索バーを開いていなくても測る**
 *     (今の `toolbarHeight` は検索バーを開いたときにしか測られない)
 *   - 検索バーが開いている: 検索バー(`.find-bar--sticky`)の貼り付いた下端(FindBar.svelte の `.find-bar--sticky` の `top` を同じ
 *     やり方で解いた値 + その `offsetHeight`)以上(= 検索バーと重ならない)
 * - 保存の照合で断られて出た帯(`showSaveConflict` 経由)も同じ(同じ要素)。
 *
 * ## 判断の記録(test-writer 2026-11-26)
 * - 実寸は jsdom で 0 なので `HTMLElement.prototype.offsetHeight` を差し替える(ツールバー 44・検索バー 36・ほかは 0)。
 *   instance でなく prototype なのは、実装がいつ測るか(mount・帯の出現・検索バーの開閉)に依らないため
 * - カスタムプロパティの名前・式の形は固定しない(解いた値だけ見る)。検索バーの下端は FindBar の `top` の式から求め、
 *   8px の margin のような FindBar 側の値を書き写さない
 * - 検索バーの下端「以上」とだけ言い、間(gap)の px は固定しない
 *
 * ## 修正前に赤になる理由
 * - `.external-change` / `.merged-notice` に `top` の宣言が無い(`resolvedTopPx` が投げる)
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { EditorView as CMView } from '@codemirror/view';
import type { EditorView as PMView } from 'prosemirror-view';

import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import { SAVE_CONFLICT_PREFIX, saveFileEditor, type MarkdownEditorHandle } from '../editor/file-editor';
import { textSpots } from '../editor/markdown.testkit';
import { componentSource, resolvedTopPx, styleOf } from './viewer-sticky.testkit';

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
	// sticky の帯の実寸(jsdom は 0): ツールバー 44・検索バー 36・ほかは 0。
	Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
		configurable: true,
		get(this: HTMLElement) {
			if (this.matches('header.viewer-toolbar')) return TOOLBAR_H;
			if (this.matches('.find-bar--sticky')) return FINDBAR_H;
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

const CONFLICT = '[data-testid="external-conflict-banner"]';
const MERGED = '[data-testid="external-merged-notice"]';
const REMOVED = '[data-testid="external-removed-banner"]';
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
function q(container: ParentNode, selector: string): HTMLElement | null {
	return container.querySelector(selector);
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
/** 帯/知らせの `top` を px で(ソースの宣言 × DOM のカスタムプロパティ)。 */
function bannerTop(el: HTMLElement): number {
	const selector = el.classList.contains('external-change') ? '.external-change' : el.classList.contains('merged-notice') ? '.merged-notice' : null;
	if (!selector) throw new Error(`帯の class が external-change / merged-notice でない: ${el.className}`);
	return resolvedTopPx(VIEWER_CSS, selector, el);
}
/** 検索バーが貼り付いたときの下端(FindBar の `top` の式を同じやり方で解いた値 + 実寸)。 */
function findBarBottom(container: ParentNode): number {
	const bar = q(container, FIND_BAR);
	if (!bar) throw new Error('検索バーが開いていない');
	return resolvedTopPx(FINDBAR_CSS, '.find-bar--sticky', bar) + FINDBAR_H;
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
	vi.unstubAllGlobals();
});

describe('Issue #848 (1): 帯と知らせの top はツールバーの直下(検索バーは閉じている)', () => {
	it('重なりの帯(Markdown の面・外部変更が重なった): top = ツールバーの offsetHeight', async () => {
		const { container } = await mountMd();
		typeMd('MINE ', 1);
		await settle();
		expect(windowState.applyFileChanged(doc(MD_URI, MD.replace('Intro paragraph', 'THEIRS paragraph')))).toBe('external-conflict');
		await settleLong();
		const banner = q(container, CONFLICT);
		expect(banner, '重なりの帯').not.toBeNull();
		expect(q(container, FIND_BAR), '検索バーは閉じている').toBeNull();
		expect(bannerTop(banner!)).toBe(TOOLBAR_H);
	});

	it('重なりの帯(保存の照合で断られた=showSaveConflict 経由・同じ要素): top = ツールバーの offsetHeight', async () => {
		const { container } = await mountMd();
		typeMd('MINE ', 1);
		await settle();
		invokeMock.mockRejectedValueOnce(`${SAVE_CONFLICT_PREFIX}: expected 3-7aigaz-3772q3`);
		await saveFileEditor(mdHandle());
		await settleLong();
		const banner = q(container, CONFLICT);
		expect(banner, '断られた保存の後の重なりの帯').not.toBeNull();
		expect(mdHandle().conflict).toBe(true);
		expect(bannerTop(banner!)).toBe(TOOLBAR_H);
	});

	it('取り込みの知らせ(重ならない外部変更をマージした): top = ツールバーの offsetHeight', async () => {
		const { container } = await mountMd();
		typeMd('MINE ', 1);
		await settle();
		expect(windowState.applyFileChanged(doc(MD_URI, MD.replace('Tail paragraph.', 'Tail paragraph THEIRS.')))).toBe('apply');
		await settleLong();
		const notice = q(container, MERGED);
		expect(notice, '取り込みの知らせ').not.toBeNull();
		expect(bannerTop(notice!)).toBe(TOOLBAR_H);
	});

	it('削除の帯(CodeMirror の面・dirty の文書のファイルが消えた): top = ツールバーの offsetHeight', async () => {
		const { container } = await mountText();
		cm(container).dispatch({ changes: { from: 0, insert: 'MINE ' } });
		await settle();
		expect(windowState.applyFileRemoved(TXT_URI)).toBe('keep');
		await settleLong();
		const banner = q(container, REMOVED);
		expect(banner, '削除の帯').not.toBeNull();
		expect(bannerTop(banner!)).toBe(TOOLBAR_H);
	});
});

describe('Issue #848 (1): 検索バーが開いている間は、帯と知らせはその下に積まれる(重ならない)', () => {
	it('検索バーを開いてから重なりの帯が出る: 帯の top ≥ 検索バーの貼り付いた下端、かつ閉じているときの値より大きい', async () => {
		const { container } = await mountMd();
		await emitMenuFind();
		expect(q(container, FIND_BAR), '検索バーが開いた').not.toBeNull();
		typeMd('MINE ', 1);
		await settle();
		expect(windowState.applyFileChanged(doc(MD_URI, MD.replace('Intro paragraph', 'THEIRS paragraph')))).toBe('external-conflict');
		await settleLong();
		const banner = q(container, CONFLICT)!;
		expect(banner).not.toBeNull();
		const barBottom = findBarBottom(container);
		expect(barBottom, '検索バーの下端はツールバーより下').toBeGreaterThan(TOOLBAR_H);
		expect(bannerTop(banner)).toBeGreaterThanOrEqual(barBottom);
		expect(bannerTop(banner)).toBeGreaterThan(TOOLBAR_H);
	});

	it('帯が出ている状態で検索バーを開く: 帯の top が検索バーの下端以上に動く', async () => {
		const { container } = await mountMd();
		typeMd('MINE ', 1);
		await settle();
		expect(windowState.applyFileChanged(doc(MD_URI, MD.replace('Intro paragraph', 'THEIRS paragraph')))).toBe('external-conflict');
		await settleLong();
		const banner = q(container, CONFLICT)!;
		expect(bannerTop(banner)).toBe(TOOLBAR_H);
		await emitMenuFind();
		await settleLong();
		expect(q(container, FIND_BAR)).not.toBeNull();
		expect(q(container, CONFLICT), '帯は検索バーを開いても残る').toBe(banner);
		expect(bannerTop(banner)).toBeGreaterThanOrEqual(findBarBottom(container));
	});

	it('取り込みの知らせも同じ(検索バーの下)', async () => {
		const { container } = await mountMd();
		await emitMenuFind();
		typeMd('MINE ', 1);
		await settle();
		expect(windowState.applyFileChanged(doc(MD_URI, MD.replace('Tail paragraph.', 'Tail paragraph THEIRS.')))).toBe('apply');
		await settleLong();
		const notice = q(container, MERGED)!;
		expect(notice).not.toBeNull();
		expect(bannerTop(notice)).toBeGreaterThanOrEqual(findBarBottom(container));
	});
});
