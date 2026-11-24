/**
 * 要件#74 第2段 2-6 — 編集面の文字の上の右クリックの配線(契約8・契約17・由谷の決定 2026-11-17 朝・stage34-prep の 3-15)。
 *
 * ## 対応する受け入れ基準(AC-74-27 の 2-6 の分)
 * - 編集面(Markdown の ProseMirror の根・コードの面と raw の `.cm-content`)の `contextmenu` で、Option を押していなければ
 *   `preventDefault` + `stopPropagation`(`+page.svelte` の `handleViewerContextMenu` に届かせない)し、`popupMenu` を 2-6 の並び
 *   (Cut / Copy / Paste / ─ / Reload File / Pin to Bookmarks)で 1 回呼ぶ
 * - `altKey` つき(Option + 右クリック)は `preventDefault` されず `popupMenu` も呼ばれない(WebKit の既定のメニュー=Look Up・翻訳・スペル候補)
 * - 読み取り専用の面(SSH の text=CodeMirror の editable=false)は今のまま(止めない・popup しない=`+page` の `viewerContextMenuMode` が app を出す)
 * - 項目を押したとき: `reload-file` → 要件80 と同じ読み直し(`requestReloadFile(null)`=+page の `fileReloader.reload` に委ねる)/
 *   `pin-to-bookmarks` → `addBookmark(uri, 'file')`(invoke add_bookmark)・済みなら `unpin-from-bookmarks` → `removeBookmark(uri)`(invoke remove_bookmark)
 * - `navigator.clipboard` を呼ばない(Cut / Copy / Paste はネイティブ)。余白の右クリック(`buildViewerMenu`・AC-80-10・要件83 のテスト)は変えない
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * ```ts
 * // --- src/lib/reload-file.ts に足す
 * /** +page が Reload File の実体(fileReloader.reload)を登録する。null で外す。 *\/
 * export function setReloadFileRequestHandler(handler: ((target?: string | null) => void) | null): void;
 * /** 面のメニューの Reload File。登録があれば呼んで true、無ければ false(何もしない)。 *\/
 * export function requestReloadFile(target?: string | null): boolean;
 * // +page.svelte: registerReloadFileListener の隣で setReloadFileRequestHandler((t) => void fileReloader.reload(t))
 *
 * // --- 面(MarkdownEditor / CodeEditor / RawSourceEditor): contextmenu の受け手
 * //   if (event.altKey || readOnly) return;  event.preventDefault(); event.stopPropagation();
 * //   void popupMenu(buildEditorContextMenu({ surface, inTable, pinned: isBookmarked(bookmarks.list, uri) }), onAction);
 * //   (位置は渡さない=カーソルの位置に開く。事後確認 (17) 2026-11-18。client 座標を渡すとタイトルバーの分だけ上にずれた)
 * //   onAction: 'reload-file' → requestReloadFile(null) / 'pin-to-bookmarks' → addBookmark(uri, 'file') / 'unpin-from-bookmarks' → removeBookmark(uri)
 * //   (addBookmark / removeBookmark の失敗は bookmarkSaveFailedMessage で alert=ContextMenu.svelte と同じ)
 * ```
 *
 * ## 修正前に赤になる理由
 * - `$lib/native-menu`・`setReloadFileRequestHandler` が無く、面に contextmenu の受け手が無い(今は WebKit の既定のメニューに落ちる)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { TextSelection } from 'prosemirror-state';
import { undoDepth } from 'prosemirror-history';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { bookmarks } from '../stores/bookmarks.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import type { FileEditorHandle, MarkdownEditorHandle } from '../editor/file-editor';
import { MENU_RAW_SOURCE_EVENT } from '../editor/raw-sync';
import { textSpots } from '../editor/markdown.testkit';
import { setReloadFileRequestHandler } from '$lib/reload-file';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => undefined), openPath: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), message: vi.fn(), open: vi.fn() }));
vi.mock('$lib/mermaid-mounter', () => ({ mountMermaid: vi.fn(async () => undefined) }));
vi.mock('$lib/native-menu', () => ({ popupMenu: vi.fn(async () => undefined) }));
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
import { popupMenu } from '$lib/native-menu';
import { invoke } from '$lib/ipc';
import * as eventsModule from '$lib/events';

const popupMock = vi.mocked(popupMenu);
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

const MD_URI = 'file:///Users/a/notes/plan.md';
const TXT_URI = 'file:///Users/a/notes/memo.txt';
const SSH_TXT_URI = 'ssh://host/srv/notes/memo.txt';
const MD = '# Plan\n\nIntro paragraph with **bold** word.\n\n| a | b |\n| - | - |\n| c | d |\n';
const TXT = 'first line\nsecond line\n';

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
async function mountText(content = TXT, uri = TXT_URI) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const result = render(Viewer, { props: baseProps(d, plainTextHtml(content), null) });
	await settleLong();
	return result;
}
const PM = 'article.viewer [data-testid="markdown-editor"] .ProseMirror';
const CM_CONTENT = 'article.viewer [data-testid="code-editor"] .cm-content';
const RAW_CONTENT = 'article.viewer [data-testid="raw-source-editor"] .cm-content';

function q(container: ParentNode, selector: string): HTMLElement {
	const el = container.querySelector<HTMLElement>(selector);
	if (!el) throw new Error(`見つからない: ${selector}`);
	return el;
}
function handle(): FileEditorHandle {
	const h = windowState.fileEditor;
	if (!h) throw new Error('windowState.fileEditor が登録されていない');
	return h;
}
/** 右クリック。祖先(container)に届いたかも数える。 */
function rightClick(target: HTMLElement, container: HTMLElement, init: MouseEventInit = {}) {
	const reached = vi.fn();
	container.addEventListener('contextmenu', reached, { once: true });
	const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 50, ...init });
	target.dispatchEvent(ev);
	container.removeEventListener('contextmenu', reached);
	return { ev, reachedAncestor: reached.mock.calls.length > 0 };
}
function lastPopup() {
	const call = popupMock.mock.calls.at(-1);
	if (!call) throw new Error('popupMenu が呼ばれていない');
	const [entries, onAction, at] = call as unknown as [Array<Record<string, unknown>>, (id: string) => void, { x: number; y: number } | undefined];
	return { entries, onAction, at };
}
function shape(entries: Array<Record<string, unknown>>): string[] {
	return entries.map((e) => (e.kind === 'predefined' ? `predefined:${e.item}` : e.kind === 'separator' ? '—' : `${e.kind}:${e.id}`));
}
const EXPECTED_UNPINNED = ['predefined:Cut', 'predefined:Copy', 'predefined:Paste', '—', 'item:reload-file', 'item:pin-to-bookmarks'];
const EXPECTED_PINNED = ['predefined:Cut', 'predefined:Copy', 'predefined:Paste', '—', 'item:reload-file', 'item:unpin-from-bookmarks'];
// 第3段 3-4(3-15・3-16): Markdown の編集面は Format ▸(表の中なら Table ▸ も)。コード・raw は 2-6 のまま
const EXPECTED_MD_UNPINNED = ['predefined:Cut', 'predefined:Copy', 'predefined:Paste', '—', 'submenu:ctx-format-menu', '—', 'item:reload-file', 'item:pin-to-bookmarks'];
const EXPECTED_MD_PINNED = ['predefined:Cut', 'predefined:Copy', 'predefined:Paste', '—', 'submenu:ctx-format-menu', '—', 'item:reload-file', 'item:unpin-from-bookmarks'];
const EXPECTED_MD_TABLE = ['predefined:Cut', 'predefined:Copy', 'predefined:Paste', '—', 'submenu:ctx-format-menu', 'submenu:ctx-table-menu', '—', 'item:reload-file', 'item:pin-to-bookmarks'];
function submenuOf(entries: Array<Record<string, unknown>>, id: string): Array<Record<string, unknown>> {
	const found = entries.find((e) => e.kind === 'submenu' && e.id === id);
	if (!found) throw new Error(`submenu ${id} が無い`);
	return found.items as Array<Record<string, unknown>>;
}
function itemOf(entries: Array<Record<string, unknown>>, id: string): Record<string, unknown> {
	for (const e of entries) {
		if (e.kind === 'item' && e.id === id) return e;
		if (e.kind === 'submenu') {
			try {
				return itemOf(e.items as Array<Record<string, unknown>>, id);
			} catch {
				/* 次へ */
			}
		}
	}
	throw new Error(`item ${id} が無い`);
}
async function emitRawSource() {
	for (const h of menuHandlers.get(MENU_RAW_SOURCE_EVENT) ?? []) h({ payload: undefined });
	await settleLong();
	await new Promise((r) => setTimeout(r, 20));
	await settle();
}

const reloadHandler = vi.fn((_t?: string | null) => undefined);
const clip = { readText: vi.fn(), writeText: vi.fn() };

beforeEach(() => {
	windowState.clearDocument();
	windowState.fileEditor = null;
	windowState.editBlocked = false;
	bookmarks.list = [];
	menuHandlers.clear();
	invokeMock.mockReset();
	invokeMock.mockImplementation(async () => null);
	popupMock.mockClear();
	reloadHandler.mockClear();
	setReloadFileRequestHandler(reloadHandler);
	clip.readText.mockClear();
	clip.writeText.mockClear();
	Object.defineProperty(navigator, 'clipboard', { value: clip, configurable: true });
	vi.stubGlobal('alert', vi.fn());
});
afterEach(() => {
	setReloadFileRequestHandler(null);
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('AC-74-27(2-6): Markdown の編集面の文字の上の右クリック', () => {
	it('preventDefault + stopPropagation され、popupMenu が Markdown の並び(Format ▸ つき=3-4)で 1 回(位置はクリックの座標)', async () => {
		const { container } = await mountMd();
		const pm = q(container, PM);
		const { ev, reachedAncestor } = rightClick(pm.querySelector('p') ?? pm, container);
		await settleLong();
		expect(ev.defaultPrevented).toBe(true);
		expect(reachedAncestor, '+page の handleViewerContextMenu(祖先)に届かない').toBe(false);
		expect(popupMock).toHaveBeenCalledTimes(1);
		const { entries, at } = lastPopup();
		expect(shape(entries)).toEqual(EXPECTED_MD_UNPINNED);
		// 事後確認 (17)(2026-11-18): 位置を渡さない(カーソルの位置に開く。client 座標を渡すとタイトルバーの分だけ上にずれた)
		expect(at).toBeUndefined();
		expect(handle().dirty, '右クリックで文書は変わらない').toBe(false);
	});

	it('Option + 右クリック(altKey)は止めず、popupMenu も呼ばない(WebKit の既定のメニュー)', async () => {
		const { container } = await mountMd();
		const { ev, reachedAncestor } = rightClick(q(container, PM), container, { altKey: true });
		await settleLong();
		expect(ev.defaultPrevented).toBe(false);
		expect(reachedAncestor).toBe(true);
		expect(popupMock).not.toHaveBeenCalled();
	});

	it('表のセルの上では Format ▸ の直後に Table ▸(3-4)。中身は 3-2 の 7 つ', async () => {
		const { container } = await mountMd();
		const cell = q(container, `${PM} td`);
		const h = handle() as MarkdownEditorHandle;
		const spot = textSpots(h.view.state.doc, 2).find((s) => s.text === 'c')!;
		h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, spot.pos)));
		rightClick(cell, container);
		await settleLong();
		expect(shape(lastPopup().entries)).toEqual(EXPECTED_MD_TABLE);
		expect(submenuOf(lastPopup().entries, 'ctx-table-menu').map((e) => (e.kind === 'separator' ? '—' : e.id))).toEqual([
			'format-table-row-above',
			'format-table-row-below',
			'format-table-column-left',
			'format-table-column-right',
			'—',
			'format-table-delete-row',
			'format-table-delete-column',
			'format-table-delete',
		]);
	});

	it('この文書が Bookmark 済みなら Unpin from Bookmarks(bookmarks.list で判定)', async () => {
		bookmarks.list = [{ uri: MD_URI, kind: 'file' }];
		const { container } = await mountMd();
		rightClick(q(container, PM), container);
		await settleLong();
		expect(shape(lastPopup().entries)).toEqual(EXPECTED_MD_PINNED);
	});

	it('Reload File を押すと要件80 の読み直しの入口(requestReloadFile → +page の fileReloader.reload)が 1 回呼ばれる', async () => {
		const { container } = await mountMd();
		rightClick(q(container, PM), container);
		await settleLong();
		lastPopup().onAction('reload-file');
		await settleLong();
		expect(reloadHandler).toHaveBeenCalledTimes(1);
		expect(reloadHandler.mock.calls[0]![0] ?? null).toBeNull();
		expect(invokeMock, 'Reload の実体は +page が持つ(面は open_document を呼ばない)').not.toHaveBeenCalledWith('open_document', expect.anything());
	});

	it('Pin to Bookmarks を押すと add_bookmark { uri, kind: file }・Unpin なら remove_bookmark { uri }(要件83 と同じ経路)', async () => {
		const { container } = await mountMd();
		rightClick(q(container, PM), container);
		await settleLong();
		lastPopup().onAction('pin-to-bookmarks');
		await settleLong();
		expect(invokeMock).toHaveBeenCalledWith('add_bookmark', { uri: MD_URI, kind: 'file' });
		invokeMock.mockClear();
		bookmarks.list = [{ uri: MD_URI, kind: 'file' }];
		await settle();
		rightClick(q(container, PM), container);
		await settleLong();
		lastPopup().onAction('unpin-from-bookmarks');
		await settleLong();
		expect(invokeMock).toHaveBeenCalledWith('remove_bookmark', { uri: MD_URI });
	});

	it('navigator.clipboard は読み書きされない(Cut / Copy / Paste はネイティブの定義済みの項目)', async () => {
		const { container } = await mountMd();
		rightClick(q(container, PM), container);
		await settleLong();
		expect(clip.readText).not.toHaveBeenCalled();
		expect(clip.writeText).not.toHaveBeenCalled();
	});

	it('右クリックの前に選んでいた範囲は残る(選択の内側の右クリック)', async () => {
		const { container } = await mountMd();
		const h = handle() as MarkdownEditorHandle;
		const spot = textSpots(h.view.state.doc, 1)[0]!;
		h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, spot.pos, spot.pos + 5)));
		rightClick(q(container, PM), container);
		await settleLong();
		expect(h.view.state.selection.from).toBe(spot.pos);
		expect(h.view.state.selection.to).toBe(spot.pos + 5);
	});
});

describe('AC-74-27(2-6): コードの面(CodeMirror)と raw', () => {
	it('コードの面の .cm-content の右クリック → 止めて popupMenu(2-6 の並び)', async () => {
		const { container } = await mountText();
		const { ev, reachedAncestor } = rightClick(q(container, CM_CONTENT), container);
		await settleLong();
		expect(ev.defaultPrevented).toBe(true);
		expect(reachedAncestor).toBe(false);
		expect(popupMock).toHaveBeenCalledTimes(1);
		expect(shape(lastPopup().entries)).toEqual(EXPECTED_UNPINNED);
		lastPopup().onAction('pin-to-bookmarks');
		await settleLong();
		expect(invokeMock).toHaveBeenCalledWith('add_bookmark', { uri: TXT_URI, kind: 'file' });
	});

	it('コードの面でも Option + 右クリックは止めない', async () => {
		const { container } = await mountText();
		const { ev } = rightClick(q(container, CM_CONTENT), container, { altKey: true });
		await settleLong();
		expect(ev.defaultPrevented).toBe(false);
		expect(popupMock).not.toHaveBeenCalled();
	});

	it('raw(View ▸ Raw Source)の .cm-content の右クリック → 止めて popupMenu(2-6 の並び)。Reload File は同じ入口', async () => {
		const { container } = await mountMd();
		await emitRawSource();
		const { ev, reachedAncestor } = rightClick(q(container, RAW_CONTENT), container);
		await settleLong();
		expect(ev.defaultPrevented).toBe(true);
		expect(reachedAncestor).toBe(false);
		expect(shape(lastPopup().entries)).toEqual(EXPECTED_UNPINNED);
		lastPopup().onAction('reload-file');
		await settleLong();
		expect(reloadHandler).toHaveBeenCalledTimes(1);
	});

	it('読み取り専用の面(SSH の text=editable=false)は今のまま: 止めず・popup せず(+page の app のメニューに任せる)', async () => {
		const { container } = await mountText(TXT, SSH_TXT_URI);
		const content = q(container, CM_CONTENT);
		expect(content.getAttribute('contenteditable')).toBe('false');
		const { ev, reachedAncestor } = rightClick(content, container);
		await settleLong();
		expect(ev.defaultPrevented).toBe(false);
		expect(reachedAncestor).toBe(true);
		expect(popupMock).not.toHaveBeenCalled();
	});
});

describe('AC-74-27(2-6): 余白の右クリック(面の外)は今のまま=面は受けない', () => {
	it('.markdown-body の面の外(article.viewer)の右クリックは止めず、popupMenu も呼ばれない(+page の buildViewerMenu の持ち場)', async () => {
		const { container } = await mountMd();
		const viewer = q(container, 'article.viewer');
		const { ev, reachedAncestor } = rightClick(viewer, container);
		await settleLong();
		expect(ev.defaultPrevented).toBe(false);
		expect(reachedAncestor).toBe(true);
		expect(popupMock).not.toHaveBeenCalled();
	});
});

describe('配線(ソース走査): +page が Reload File の実体を登録する', () => {
	it('+page.svelte が setReloadFileRequestHandler( に fileReloader.reload を渡す', async () => {
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const src = readFileSync(resolve(__dirname, '../routes/+page.svelte'), 'utf8');
		const at = src.indexOf('setReloadFileRequestHandler(');
		expect(at, '+page.svelte calls setReloadFileRequestHandler(').toBeGreaterThanOrEqual(0);
		expect(src.slice(at, at + 200)).toContain('fileReloader.reload(');
		expect(src).toMatch(/import\s*\{[^}]*\bsetReloadFileRequestHandler\b[^}]*\}\s*from\s*'\$lib\/reload-file'/);
	});
	it('viewerContextMenuMode(AC-80-10)と buildViewerMenu は無改変=余白の右クリックの判定は今のまま', async () => {
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const page = readFileSync(resolve(__dirname, '../routes/+page.svelte'), 'utf8');
		expect(page).toContain('viewerContextMenuMode({');
		expect(page).toContain('contextMenu.openViewerAt(');
		const menu = readFileSync(resolve(__dirname, '../lib/context-menu.ts'), 'utf8');
		expect(menu).toContain('export function buildViewerMenu(pinned: boolean = false): ContextMenuItem[] {');
	});
});

// ---------------------------------------------------------------------------
// 要件74 第3段 3-4 — 右クリックの Format ▸ と Table ▸(AC-74-27 (2)(3)(4)・3-15・3-16)。契約は src/editor/editor-context-menu.acceptance.test.ts
// と src/editor/active-format.acceptance.test.ts の先頭。
// 配線: handleEditorContextMenu(event, { surface: 'markdown', uri, readOnly, handle }) → active = activeFormat(handle.view.state)・inTable は選択が
// table_cell / table_header の中か → popupMenu。項目を押したら format-* → runFormatCommand(id, handle)(メニューバーと同じ経路・取引 1 つ・
// 変換中は確定後に 1 回)。コード・raw は Format ▸ を出さない。
// ---------------------------------------------------------------------------

describe('AC-74-27(3-4): Markdown の面の右クリック=Format ▸ / Table ▸ と項目の実行', () => {
	it('Format ▸ のチェックは今の装飾: 太字の範囲を選んで右クリック → Bold ✓・Italic は空。段落なので Body Text ✓・Heading 2 は空', async () => {
		const { container } = await mountMd();
		const h = handle() as MarkdownEditorHandle;
		const bold = textSpots(h.view.state.doc, 1).find((s) => s.text === 'bold')!;
		h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, bold.pos, bold.pos + 4)));
		rightClick(q(container, PM), container);
		await settleLong();
		const format = submenuOf(lastPopup().entries, 'ctx-format-menu');
		expect(itemOf(format, 'format-bold').checked).toBe(true);
		expect(itemOf(format, 'format-italic').checked).toBe(false);
		expect(itemOf(format, 'format-body-text').checked).toBe(true);
		expect(itemOf(format, 'format-heading-2').checked).toBe(false);
		expect(itemOf(format, 'format-bold').accelerator).toBe('CmdOrCtrl+B');
	});

	it('見出しの上で右クリック → Heading 1 ✓・Body Text は空。表の外なので Table ▸ は無い', async () => {
		const { container } = await mountMd();
		const h = handle() as MarkdownEditorHandle;
		const spot = textSpots(h.view.state.doc, 0)[0]!;
		h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, spot.pos + 1)));
		rightClick(q(container, PM), container);
		await settleLong();
		const format = submenuOf(lastPopup().entries, 'ctx-format-menu');
		expect(itemOf(format, 'format-heading-1').checked).toBe(true);
		expect(itemOf(format, 'format-body-text').checked).toBe(false);
		expect(shape(lastPopup().entries)).toEqual(EXPECTED_MD_UNPINNED);
	});

	it('Format ▸ Bold を押すとメニューバーの Format と同じ結果(選んだ語が **…**・取引 1 つ・dirty)。Heading 2 も同じ経路', async () => {
		const { container } = await mountMd();
		const h = handle() as MarkdownEditorHandle;
		const intro = textSpots(h.view.state.doc, 1)[0]!; // 'Intro paragraph with '
		h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, intro.pos, intro.pos + 5)));
		rightClick(q(container, PM), container);
		await settleLong();
		const depth = undoDepth(h.view.state);
		lastPopup().onAction('format-bold');
		await settleLong();
		expect(h.text()).toBe(MD.replace('Intro paragraph', '**Intro** paragraph'));
		expect(undoDepth(h.view.state)).toBe(depth + 1);
		expect(h.dirty).toBe(true);
		lastPopup().onAction('format-heading-2');
		await settleLong();
		expect(h.text()).toBe(MD.replace('Intro paragraph', '## **Intro** paragraph'));
	});

	it('Table ▸ Insert Row Below を押すと表の行が 1 つ増える(3-2 と同じ Command・取引 1 つ)', async () => {
		const { container } = await mountMd();
		const h = handle() as MarkdownEditorHandle;
		const spot = textSpots(h.view.state.doc, 2).find((s) => s.text === 'c')!;
		h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, spot.pos)));
		rightClick(q(container, `${PM} td`), container);
		await settleLong();
		expect(shape(lastPopup().entries)).toEqual(EXPECTED_MD_TABLE);
		const depth = undoDepth(h.view.state);
		lastPopup().onAction('format-table-row-below');
		await settleLong();
		expect(h.view.state.doc.child(2).type.name).toBe('table');
		expect(h.view.state.doc.child(2).childCount).toBe(3);
		expect(undoDepth(h.view.state)).toBe(depth + 1);
	});

	it('変換中(view.composing)に押した Format の項目は確定の後に 1 回だけ当たる', async () => {
		const { container } = await mountMd();
		const h = handle() as MarkdownEditorHandle;
		const intro = textSpots(h.view.state.doc, 1)[0]!;
		h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, intro.pos, intro.pos + 5)));
		rightClick(q(container, PM), container);
		await settleLong();
		h.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
		await settle();
		expect(h.view.composing).toBe(true);
		lastPopup().onAction('format-bold');
		lastPopup().onAction('format-bold');
		await settle();
		expect(h.text(), '変換中は当たらない').toBe(MD);
		h.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
		await settleLong();
		await new Promise((r) => setTimeout(r, 50));
		expect(h.text(), '確定後に 1 回だけ(トグルが戻らない)').toBe(MD.replace('Intro paragraph', '**Intro** paragraph'));
	});

	it('Reload File / Pin は 3-4 でも同じ入口(Format ▸ の後ろの組)', async () => {
		const { container } = await mountMd();
		rightClick(q(container, PM), container);
		await settleLong();
		lastPopup().onAction('reload-file');
		await settleLong();
		expect(reloadHandler).toHaveBeenCalledTimes(1);
		lastPopup().onAction('pin-to-bookmarks');
		await settleLong();
		expect(invokeMock).toHaveBeenCalledWith('add_bookmark', { uri: MD_URI, kind: 'file' });
	});

	it('コードの面と raw には Format ▸ / Table ▸ が無い(2-6 の並びのまま)', async () => {
		const { container } = await mountText();
		rightClick(q(container, CM_CONTENT), container);
		await settleLong();
		expect(shape(lastPopup().entries)).toEqual(EXPECTED_UNPINNED);
		cleanup();
		windowState.clearDocument();
		windowState.fileEditor = null;
		const md = await mountMd();
		await emitRawSource();
		rightClick(q(md.container, RAW_CONTENT), md.container);
		await settleLong();
		expect(shape(lastPopup().entries)).toEqual(EXPECTED_UNPINNED);
	});
});
