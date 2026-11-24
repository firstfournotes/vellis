/**
 * 要件#74 /code-review 不具合 C — 窓を前面に戻しても View ▸ Show Formatting Toolbar(と、Markdown の面が無いときの Raw Source)の
 * チェック印が追従しない(2026-11-22)。
 *
 * 今の `Viewer.svelte` はツールバーの状態を `$effect` で mount 時と変化時だけ `announceFormatToolbar` する。Raw Source は
 * `MarkdownEditor` が `watchFocusForRawSource`(`src/editor/raw-sync.ts`)で前面化のたびに知らせ直すが、`MarkdownEditor` が無い窓
 * (コードのファイル・テキスト・画像・Dashboard など)では誰も知らせない。Rust 側(`listen_*_state`)は「前面の窓の報告」でしか
 * チェック印を動かさないので、別の窓から戻ってきた窓の値に印が追従しない。
 *
 * ## 直し方(オーケストレーターの決定)
 * Viewer が窓の `onFocusChanged(focused=true)` のたびに、`format_toolbar_state` { label, shown: いま見えているか
 * (formatToolbarAvailable && formatToolbarShown) } と `raw_source_state` { label, raw: Markdown の面が raw か(面が無ければ false) }
 * の両方を送る。`format-toolbar.ts` に `watchFocusForRawSource` と同じ形の購読関数を足す想定(名前はテストで固定しない)。
 *
 * ## 対応する受け入れ基準(req-74.md に記帳)
 * - AC-74-C1 ツールバーを出していない Markdown の窓: focus=true → `format_toolbar_state` { label:'main', shown:false }
 * - AC-74-C2 ツールバーを出している(localStorage 'vellis.formatToolbar'='true')Markdown の窓: focus=true → shown:true
 * - AC-74-C3 コードのファイル(.ts)の窓: focus=true → `raw_source_state` { label:'main', raw:false } と `format_toolbar_state` { shown:false }
 * - AC-74-C4 解除(unmount)後は focus で送らない
 * - AC-74-C5 raw の Markdown の窓: focus=true の後の `raw_source_state` はすべて raw:true(Viewer と面の知らせが食い違わない)・
 *   `format_toolbar_state` は shown:false(raw ではツールバーを出せない)
 * - AC-74-C6 focus=false(背面へ)では送らない(`watchFocusForRawSource` と同じ形)
 *
 * ## 確定契約(implementer はこれに従う)
 * - 購読は `getCurrentWindow().onFocusChanged(({ payload: focused }) => …)`。payload が真のときだけ 2 つを emit
 *   (`win.emit(FORMAT_TOOLBAR_STATE_EVENT, { label: win.label, shown })`・`win.emit(RAW_SOURCE_STATE_EVENT, { label: win.label, raw })`)
 * - `shown` = その時点の `formatToolbarAvailable && formatToolbarShown`・`raw` = その時点の `mdRaw`(Markdown の面が raw)。面が無ければ false
 * - Viewer の unmount で購読を解く(onFocusChanged が返す unlisten を呼ぶ)
 *
 * ## 判断の記録(test-writer・2026-11-22)
 * - C5 を足した: Markdown の面がある窓では `MarkdownEditor` も `watchFocusForRawSource` で raw を知らせるので、Viewer の値が面の値と
 *   食い違う(Viewer が false・面が true)と、届く順でチェック印が外れる。「focus の後の raw_source_state は全部同じ値」で縛る
 * - C4 は「残っている購読を叩いても送らない」で見る(購読の集合が空であることまでは縛らない=守りのある残りは許す)
 *
 * ## 修正前に赤になる理由
 * - C1・C2: Viewer は focus を購読しておらず、focus=true の後に `format_toolbar_state` が 1 件も届かない
 * - C3: コードの窓には `MarkdownEditor` が無く、focus=true の後に `raw_source_state` も `format_toolbar_state` も届かない
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import { FORMAT_TOOLBAR_STATE_EVENT, FORMAT_TOOLBAR_STORAGE_KEY } from '../editor/format-toolbar';
import { MENU_RAW_SOURCE_EVENT, RAW_SOURCE_STATE_EVENT } from '../editor/raw-sync';

const win = vi.hoisted(() => ({
	emit: vi.fn(async (_event: string, _payload?: unknown) => undefined),
	focusHandlers: new Set<(e: { payload: boolean }) => void>(),
}));

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
	const fake = {
		label: 'main',
		emit: (event: string, payload?: unknown) => win.emit(event, payload),
		onFocusChanged: async (handler: (e: { payload: boolean }) => void) => {
			win.focusHandlers.add(handler);
			return () => {
				win.focusHandlers.delete(handler);
			};
		},
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

const MD_URI = 'file:///Users/a/notes/plan.md';
const MD = '# Plan\n\nIntro paragraph with **bold** word.\n\n## Second\n\n- item one\n- item two\n';
const TS_URI = 'file:///Users/a/src/main.ts';
const TS = 'export const a = 1;\nexport const b = 2;\n';

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
async function mountCode(content = TS, uri = TS_URI) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const result = render(Viewer, { props: baseProps(d, `<pre class="vellis-plaintext">\n${content}</pre>`, null) });
	await settleLong();
	return result;
}
function q(container: ParentNode, selector: string): HTMLElement | null {
	return container.querySelector(selector);
}
/** 窓の前面化(focused)/ 背面化(!focused)を、登録されているすべての購読に届ける。 */
async function focusWindow(focused: boolean) {
	const list = [...win.focusHandlers];
	for (const h of list) h({ payload: focused });
	await settleLong();
}
function toolbarEmits(): Array<{ label: string; shown: boolean }> {
	return win.emit.mock.calls.filter(([e]) => e === FORMAT_TOOLBAR_STATE_EVENT).map(([, p]) => p as { label: string; shown: boolean });
}
function rawEmits(): Array<{ label: string; raw: boolean }> {
	return win.emit.mock.calls.filter(([e]) => e === RAW_SOURCE_STATE_EVENT).map(([, p]) => p as { label: string; raw: boolean });
}
/** View ▸ Raw Source(lib.rs → 前面の窓の `menu_raw_source`)。 */
async function emitRawSource() {
	await settle();
	const list = [...(menuHandlers.get(MENU_RAW_SOURCE_EVENT) ?? [])];
	expect(list.length, `面が '${MENU_RAW_SOURCE_EVENT}' を購読していること`).toBeGreaterThan(0);
	for (const h of list) h({ payload: undefined });
	await settleLong();
	await new Promise((r) => setTimeout(r, 20));
	await settle();
}

beforeEach(() => {
	windowState.clearDocument();
	windowState.fileEditor = null;
	windowState.editBlocked = false;
	windowState.externalRemoved = false;
	menuHandlers.clear();
	win.emit.mockClear();
	win.focusHandlers.clear();
	localStorage.clear();
	vi.stubGlobal('alert', vi.fn());
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('AC-74-C1 / C2: Markdown の窓が前面に戻ると、ツールバーの見え方を format_toolbar_state で知らせ直す', () => {
	it('C1: ツールバーを出していない Markdown の窓: focus=true → format_toolbar_state { label:"main", shown:false }', async () => {
		const { container } = await mountMd();
		expect(q(container, '[data-testid="markdown-editor"] .ProseMirror')).not.toBeNull();
		expect(q(container, '[data-testid="format-toolbar"]'), 'ツールバーは出ていない').toBeNull();
		win.emit.mockClear();

		await focusWindow(true);

		const emits = toolbarEmits();
		expect(emits.length, 'focus=true で format_toolbar_state が届く').toBeGreaterThan(0);
		expect(emits.at(-1)).toEqual({ label: 'main', shown: false });
		expect(emits.some((e) => e.shown === true), '出していないのに true を送らない').toBe(false);
	});

	it('C2: ツールバーを出している Markdown の窓(localStorage true): focus=true → shown:true', async () => {
		localStorage.setItem(FORMAT_TOOLBAR_STORAGE_KEY, 'true');
		const { container } = await mountMd();
		expect(q(container, '[data-testid="format-toolbar"]'), 'ツールバーが出ている').not.toBeNull();
		win.emit.mockClear();

		await focusWindow(true);

		const emits = toolbarEmits();
		expect(emits.length).toBeGreaterThan(0);
		expect(emits.at(-1)).toEqual({ label: 'main', shown: true });
		expect(emits.some((e) => e.shown === false), '出しているのに false を送らない').toBe(false);
	});

	it('前面化が繰り返されるたびに知らせ直す(2 回目も届く)', async () => {
		await mountMd();
		win.emit.mockClear();
		await focusWindow(true);
		const first = toolbarEmits().length;
		expect(first).toBeGreaterThan(0);
		await focusWindow(true);
		expect(toolbarEmits().length).toBeGreaterThan(first);
	});
});

describe('AC-74-C3: Markdown の面が無い窓(コードのファイル)でも、前面に戻ると両方を知らせる', () => {
	it('.ts の窓: focus=true → raw_source_state { label:"main", raw:false } と format_toolbar_state { label:"main", shown:false }', async () => {
		const { container } = await mountCode();
		expect(q(container, '[data-testid="code-editor"] .cm-editor'), 'CodeMirror の面').not.toBeNull();
		expect(q(container, '[data-testid="markdown-editor"]'), 'Markdown の面は無い').toBeNull();
		win.emit.mockClear();

		await focusWindow(true);

		const raws = rawEmits();
		expect(raws.length, 'Markdown の面が無くても raw_source_state が届く(面が無い=raw ではない)').toBeGreaterThan(0);
		expect(raws.at(-1)).toEqual({ label: 'main', raw: false });
		expect(raws.some((e) => e.raw === true)).toBe(false);

		const bars = toolbarEmits();
		expect(bars.length, 'format_toolbar_state も届く').toBeGreaterThan(0);
		expect(bars.at(-1)).toEqual({ label: 'main', shown: false });
		expect(bars.some((e) => e.shown === true)).toBe(false);
	});

	it('.ts の窓で localStorage が true でも、出せない面なので shown:false', async () => {
		localStorage.setItem(FORMAT_TOOLBAR_STORAGE_KEY, 'true');
		await mountCode();
		win.emit.mockClear();
		await focusWindow(true);
		const bars = toolbarEmits();
		expect(bars.length).toBeGreaterThan(0);
		expect(bars.at(-1)).toEqual({ label: 'main', shown: false });
		expect(bars.some((e) => e.shown === true)).toBe(false);
	});
});

describe('AC-74-C4: 解除(unmount)後は focus で送らない', () => {
	it('コードの窓を unmount した後に残っている購読を叩いても、raw_source_state も format_toolbar_state も届かない', async () => {
		const { unmount } = await mountCode();
		await focusWindow(true);
		expect(toolbarEmits().length, '前提: mount 中は届く').toBeGreaterThan(0);
		unmount();
		await settleLong();
		win.emit.mockClear();

		await focusWindow(true);

		expect(toolbarEmits()).toEqual([]);
		expect(rawEmits()).toEqual([]);
	});

	it('Markdown の窓を unmount した後も同じ(面の購読も Viewer の購読も解ける)', async () => {
		const { unmount } = await mountMd();
		await focusWindow(true);
		expect(toolbarEmits().length).toBeGreaterThan(0);
		unmount();
		await settleLong();
		win.emit.mockClear();

		await focusWindow(true);

		expect(toolbarEmits()).toEqual([]);
		expect(rawEmits()).toEqual([]);
	});
});

describe('AC-74-C5: raw の Markdown の窓では、Viewer の知らせが面の知らせと食い違わない', () => {
	it('View ▸ Raw Source で raw にした後の focus=true: raw_source_state はすべて raw:true・format_toolbar_state は shown:false', async () => {
		localStorage.setItem(FORMAT_TOOLBAR_STORAGE_KEY, 'true');
		const { container } = await mountMd();
		await emitRawSource();
		expect(q(container, '[data-testid="raw-source-editor"] .cm-editor'), 'raw の面(CodeMirror)').not.toBeNull();
		expect(q(container, '[data-testid="format-toolbar"]'), 'raw ではツールバーは出ない').toBeNull();
		win.emit.mockClear();

		await focusWindow(true);

		const raws = rawEmits();
		expect(raws.length).toBeGreaterThan(0);
		expect(raws.every((e) => e.label === 'main' && e.raw === true), `focus 後の raw_source_state は全部 raw:true: ${JSON.stringify(raws)}`).toBe(true);

		const bars = toolbarEmits();
		expect(bars.length).toBeGreaterThan(0);
		expect(bars.at(-1)).toEqual({ label: 'main', shown: false });
		expect(bars.some((e) => e.shown === true), 'raw で true を送らない').toBe(false);
	});

	it('rendered の Markdown の窓の focus=true: raw_source_state はすべて raw:false', async () => {
		await mountMd();
		win.emit.mockClear();
		await focusWindow(true);
		const raws = rawEmits();
		expect(raws.length).toBeGreaterThan(0);
		expect(raws.every((e) => e.label === 'main' && e.raw === false), JSON.stringify(raws)).toBe(true);
	});
});

describe('AC-74-C6: focus=false(背面へ)では送らない', () => {
	it('コードの窓: focus=false → format_toolbar_state も raw_source_state も届かない', async () => {
		await mountCode();
		win.emit.mockClear();
		await focusWindow(false);
		expect(toolbarEmits()).toEqual([]);
		expect(rawEmits()).toEqual([]);
	});

	it('Markdown の窓: focus=false → format_toolbar_state は届かない', async () => {
		await mountMd();
		win.emit.mockClear();
		await focusWindow(false);
		expect(toolbarEmits()).toEqual([]);
	});
});
