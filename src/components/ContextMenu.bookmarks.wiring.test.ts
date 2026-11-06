/**
 * 要件#83 の受け入れテスト(docs/requirements/req-83.md)— Explorer と本文の Pin の配線
 * (AC-83-25=契約 7・9【(e)(ab)(ap) 決定】。component プロジェクト・`Explorer.svelte` を JSDOM にマウントする=
 * ContextMenu.reload.wiring.test.ts と同じ家風)
 *
 * 純関数(項目列・計画)は context-menu.acceptance.test.ts(AC-83-22)、command の口とストアは bookmarks.acceptance.test.ts /
 * bookmarks.store.wiring.test.ts の持ち場。ここは **Explorer をマウントし、右クリック → Pin / Unpin → add_bookmark /
 * remove_bookmark / alert・`bookmarks_changed` の後の出し分け** を判定する。
 *
 * ## 配線に求める契約(implementer はこれに従う)
 * - 窓の Bookmark の一覧は `stores/bookmarks.svelte` の `bookmarks`(`list`・`init()`)。ページが起動時に `init()` を 1 回呼ぶ
 *   (このテストではマウントの前にテストが呼ぶ)。Explorer の行と本文のメニューの Pin / Unpin の出し分けはこのストアの
 *   `list` と `isBookmarked`(履歴と同じ正規化)で決める
 * - `ExplorerItem.svelte` の右クリックは今の `contextMenu.openAt(entry, x, y, openDocUri)` のまま。ストアの `openAt` が
 *   `buildContextMenu(entry, openDocUri, pinned)` で項目を組む(`pinned` はストアが `bookmarks.list` から決める。
 *   第 5 引数で渡してもよいが、4 引数の呼び出しでも正しく出ること)
 * - 本文のメニューは今の `contextMenu.openViewerAt(x, y)` のまま(entry は null)。Pin / Unpin の対象と済みかは
 *   `windowState.currentDocument?.uri` で決める(省略可の第 3 引数を足してもよいが、2 引数の呼び出しでも正しく出ること)
 * - `ContextMenu.svelte` が `pin-bookmark` の計画で `addBookmark(uri, kind)`(`$lib/bookmarks`= invoke('add_bookmark'))・
 *   `unpin-bookmark` で `removeBookmark(uri)` を呼ぶ。メニューは実行の前に閉じる(既存の `activate` の家風)。
 *   失敗は `alert(bookmarkSaveFailedMessage(err))` を 1 回(一覧は前のまま)
 * - 一覧の反映は Rust の `bookmarks_changed`(全窓)で届く=ストアが置き換える。ContextMenu は返り値で描き直さなくてよい
 *   (描き直しても、event で同じ一覧が届くので結果は同じ)
 *
 * ## スタブの設計(ContextMenu.reload.wiring.test.ts の家風)
 * - $lib/ipc: `list_bookmarks` は `[]`・`add_bookmark` / `remove_bookmark` は各テストが差す応答(Error なら reject)・
 *   `open_document` は DocumentPayload 形・他は null。観測は command 名と引数
 * - $lib/events: `listen` は event 名ごとに handler を記録し、テストが `bookmarks_changed` を起こす
 * - $lib/edit-guard / plugin-opener / plugin-dialog: Explorer が抱える ContextMenu.svelte の import を成立させるだけ
 * - `alert` は `vi.stubGlobal`
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('$lib/events', () => ({ listen: vi.fn() }));
vi.mock('$lib/edit-guard', () => ({ confirmDiscardEdits: vi.fn(async () => true) }));
vi.mock('@tauri-apps/plugin-opener', () => ({
	revealItemInDir: vi.fn(async () => undefined),
	openPath: vi.fn(async () => undefined),
	openUrl: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
	open: vi.fn(async () => null),
	ask: vi.fn(async () => false),
}));

import { invoke } from '$lib/ipc';
import { listen } from '$lib/events';
import type { Bookmark } from '$lib/bookmarks';
import Explorer from './Explorer.svelte';
import { windowState, type DocumentPayload, type Entry } from '../stores/window-state.svelte';
import { contextMenu } from '../stores/context-menu.svelte';
import { bookmarks } from '../stores/bookmarks.svelte';

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

type Handler = (e: { payload: unknown }) => void;
const handlers: Record<string, Handler[]> = {};
/**
 * ストアの `bookmarks_changed` の handler。ストアは窓(=このモジュール)に 1 つで、契約 9 のとおり最初の `init()` で
 * 1 回だけ購読し 2 回目以降は購読し直さない。そのため最初の init の直後(まだ何もマウントしていない)に控え、
 * 各テストの準備で `handlers` を空にした後にこれだけ戻す(コンポーネントが登録した handler はテストごとに消す)。
 */
let storeHandlers: Handler[] | null = null;

const ROOT = 'file:///Users/x/notes';
const DIR_A = `${ROOT}/a`;
const FILE_A = `${ROOT}/one.md`;
const FILE_B = `${ROOT}/two.md`;
const rootEntries: Entry[] = [
	{ uri: DIR_A, name: 'a', kind: 'dir' },
	{ uri: FILE_A, name: 'one.md', kind: 'file' },
	{ uri: FILE_B, name: 'two.md', kind: 'file' },
];

/** `add_bookmark` / `remove_bookmark` の応答(Error なら reject)。各テストが差し替える。 */
let saveResponse: Bookmark[] | Error = [];

function installInvoke() {
	invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
		if (cmd === 'open_document' || cmd === 'open_binary_document') {
			return { uri: args?.uri, content: '', modified: null };
		}
		if (cmd === 'list_bookmarks') return [];
		if (cmd === 'add_bookmark' || cmd === 'remove_bookmark') {
			if (saveResponse instanceof Error) throw saveResponse;
			return saveResponse;
		}
		if (cmd === 'list_dir') return [];
		return null;
	});
}

const callsOf = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd);
const argsOf = (cmd: string) => callsOf(cmd).map((c) => c[1]);

const alertMock = vi.fn((_message?: unknown) => {});

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
	await flushAsync();
	await flushAsync();
	await tick();
}

function emitBookmarksChanged(list: Bookmark[]) {
	const hs = handlers['bookmarks_changed'] ?? [];
	expect(hs.length, 'the bookmarks store subscribed to bookmarks_changed').toBeGreaterThan(0);
	for (const h of hs) h({ payload: list });
}

function mountExplorer() {
	const result = render(Explorer, {
		props: {
			root: ROOT,
			entries: rootEntries,
			selectedUri: undefined,
			onDuplicateWindow: vi.fn(),
			onOpenInNewWindow: vi.fn(),
			onReloadFile: vi.fn(),
		},
	});
	const nav = result.container.querySelector('nav.explorer-list');
	if (!(nav instanceof HTMLElement)) throw new Error('Explorer must render nav.explorer-list');
	return { ...result, nav };
}

function rowOf(uri: string): HTMLButtonElement {
	const rows = [...document.querySelectorAll<HTMLElement>('.explorer-item')].filter((row) => row.title === uri);
	expect(rows, `exactly one row with title === ${uri}`).toHaveLength(1);
	return rows[0] as HTMLButtonElement;
}

async function rightClick(target: Element) {
	await fireEvent.contextMenu(target, { clientX: 20, clientY: 20 });
	await tick();
}

const menuLabels = () => screen.queryAllByRole('menuitem').map((b) => b.textContent?.trim() ?? '');
const menuItem = (name: string) => screen.getByRole('menuitem', { name }) as HTMLButtonElement;
const queryMenuItem = (name: string) => screen.queryByRole('menuitem', { name }) as HTMLButtonElement | null;
const menuCount = () => document.querySelectorAll('.context-menu').length;
const separatorCount = () => document.querySelectorAll('.context-menu [role="separator"]').length;

async function clickItem(name: string) {
	await fireEvent.click(menuItem(name));
	await settle();
}

const docOf = (uri: string): DocumentPayload => ({ uri, content: '# doc\n', modified: 1 });

beforeEach(async () => {
	for (const k of Object.keys(handlers)) delete handlers[k];
	listenMock.mockImplementation(async (event, handler) => {
		(handlers[event] ??= []).push(handler as Handler);
		return () => {};
	});
	saveResponse = [];
	installInvoke();
	alertMock.mockClear();
	vi.stubGlobal('alert', alertMock);
	windowState.applyRoot(ROOT, rootEntries, false);
	windowState.setExpandedDirs([]);
	windowState.clearDocument();
	// ページと同じく起動時に 1 回(2 回目以降は何もしない=契約 9)。最初の init の購読を控えて毎回戻し、
	// 直前のテストの一覧を event で消す(ストアは窓に 1 つ)。購読していなければここで落ちる。
	await bookmarks.init();
	storeHandlers ??= [...(handlers['bookmarks_changed'] ?? [])];
	handlers['bookmarks_changed'] = [...storeHandlers];
	emitBookmarksChanged([]);
	await tick();
	invokeMock.mockClear();
});

afterEach(() => {
	contextMenu.close();
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC-83-25 — Explorer の行の Pin / Unpin
// ---------------------------------------------------------------------------

describe('AC-83-25: Explorer のファイルの行の Pin to Bookmarks / Unpin from Bookmarks(契約 7・9)', () => {
	it("ファイルの行の右クリック → Pin to Bookmarks(Copy Path の後・Duplicate Window の前・有効)→ 押すと add_bookmark(その URI・'file') が 1 回・メニューが閉じる", async () => {
		mountExplorer();

		await rightClick(rowOf(FILE_A));
		const labels = menuLabels();
		expect(labels).toEqual([
			'Reveal in Finder',
			'Open with Default App',
			'Open With…',
			'Open in New Tab',
			'Open in New Window',
			'Reload File',
			'Copy Path',
			'Pin to Bookmarks',
			'Duplicate Window',
		]);
		expect(separatorCount(), 'the only separator stays before Duplicate Window').toBe(1);
		expect(menuItem('Pin to Bookmarks').disabled).toBe(false);

		await clickItem('Pin to Bookmarks');

		expect(callsOf('add_bookmark')).toHaveLength(1);
		expect(argsOf('add_bookmark')[0]).toEqual({ uri: FILE_A, kind: 'file' });
		expect(callsOf('remove_bookmark')).toHaveLength(0);
		expect(contextMenu.open).toBe(false);
		expect(menuCount()).toBe(0);
		expect(alertMock).not.toHaveBeenCalled();
	});

	it('bookmarks_changed でその URI が届いた後は同じ行が Unpin from Bookmarks(同じ位置)で、押すと remove_bookmark(その URI) が 1 回。ほかの行は Pin のまま', async () => {
		mountExplorer();

		emitBookmarksChanged([{ uri: FILE_A, kind: 'file' }]);
		await tick();

		await rightClick(rowOf(FILE_A));
		expect(menuLabels()[7]).toBe('Unpin from Bookmarks');
		expect(queryMenuItem('Pin to Bookmarks')).toBeNull();
		await clickItem('Unpin from Bookmarks');

		expect(callsOf('remove_bookmark')).toHaveLength(1);
		expect(argsOf('remove_bookmark')[0]).toEqual({ uri: FILE_A });
		expect(callsOf('add_bookmark')).toHaveLength(0);
		expect(contextMenu.open).toBe(false);

		await rightClick(rowOf(FILE_B));
		expect(menuLabels()[7]).toBe('Pin to Bookmarks');
		expect(queryMenuItem('Unpin from Bookmarks')).toBeNull();
	});

	it('済みの判定は正規化して比べる(一覧の綴りが file:///…/one.md/ でも Unpin)', async () => {
		mountExplorer();
		emitBookmarksChanged([{ uri: `${FILE_A}/`, kind: 'file' }]);
		await tick();

		await rightClick(rowOf(FILE_A));
		expect(queryMenuItem('Unpin from Bookmarks')).not.toBeNull();
	});

	it("フォルダの行 → Pin to Bookmarks(Copy Path の後)→ add_bookmark(その URI・'folder')。済みなら Unpin → remove_bookmark", async () => {
		mountExplorer();

		await rightClick(rowOf(DIR_A));
		expect(menuLabels()).toEqual([
			'Reveal in Finder',
			'Open in New Window',
			'Reload Folder',
			'Copy Path',
			'Pin to Bookmarks',
			'Duplicate Window',
		]);
		await clickItem('Pin to Bookmarks');
		expect(callsOf('add_bookmark')).toHaveLength(1);
		expect(argsOf('add_bookmark')[0]).toEqual({ uri: DIR_A, kind: 'folder' });

		emitBookmarksChanged([{ uri: DIR_A, kind: 'folder' }]);
		await tick();
		await rightClick(rowOf(DIR_A));
		expect(menuLabels()[4]).toBe('Unpin from Bookmarks');
		await clickItem('Unpin from Bookmarks');
		expect(callsOf('remove_bookmark')).toHaveLength(1);
		expect(argsOf('remove_bookmark')[0]).toEqual({ uri: DIR_A });
	});

	it('ツリーの空白のメニューに Pin は無い(Reload Folder・Duplicate Window の 2 つのまま)', async () => {
		const { nav } = mountExplorer();
		await rightClick(nav);
		expect(menuLabels()).toEqual(['Reload Folder', 'Duplicate Window']);
	});
});

// ---------------------------------------------------------------------------
// AC-83-25 — 本文のメニューの Pin / Unpin
// ---------------------------------------------------------------------------

describe('AC-83-25: 本文のメニュー(openViewerAt)の Pin to Bookmarks は今の文書を file として(契約 7)', () => {
	it("Pin to Bookmarks → add_bookmark(今の文書の URI・'file') が 1 回・メニューが閉じる", async () => {
		windowState.setDocument(docOf(FILE_B));
		mountExplorer();

		contextMenu.openViewerAt(30, 40);
		await tick();
		expect(menuLabels()).toEqual(['Reload File', 'Pin to Bookmarks']);
		expect(separatorCount()).toBe(0);

		await clickItem('Pin to Bookmarks');

		expect(callsOf('add_bookmark')).toHaveLength(1);
		expect(argsOf('add_bookmark')[0]).toEqual({ uri: FILE_B, kind: 'file' });
		expect(contextMenu.open).toBe(false);
		expect(menuCount()).toBe(0);
	});

	it('今の文書が Bookmark 済みなら本文のメニューは Unpin from Bookmarks → remove_bookmark(今の文書の URI)', async () => {
		windowState.setDocument(docOf(FILE_B));
		mountExplorer();
		emitBookmarksChanged([{ uri: FILE_B, kind: 'file' }]);
		await tick();

		contextMenu.openViewerAt(30, 40);
		await tick();
		expect(menuLabels()).toEqual(['Reload File', 'Unpin from Bookmarks']);

		await clickItem('Unpin from Bookmarks');
		expect(callsOf('remove_bookmark')).toHaveLength(1);
		expect(argsOf('remove_bookmark')[0]).toEqual({ uri: FILE_B });
	});
});

// ---------------------------------------------------------------------------
// AC-83-25 — 書けなかったとき
// ---------------------------------------------------------------------------

describe("AC-83-25: add_bookmark が reject → alert 'Could not save the bookmarks: …' が 1 回(契約 7)", () => {
	it('Explorer の行の Pin で失敗 → alert が 1 回・理由を含む・例外は外へ出ない', async () => {
		saveResponse = new Error('Permission denied (os error 13)');
		mountExplorer();

		await rightClick(rowOf(FILE_A));
		await expect(clickItem('Pin to Bookmarks')).resolves.toBeUndefined();
		await settle();

		expect(callsOf('add_bookmark')).toHaveLength(1);
		expect(alertMock).toHaveBeenCalledTimes(1);
		const message = String(alertMock.mock.calls[0]?.[0]);
		expect(message.startsWith('Could not save the bookmarks: ')).toBe(true);
		expect(message).toContain('Permission denied (os error 13)');
		expect(contextMenu.open).toBe(false);
		// 一覧は前のまま(済みにならない)。
		await rightClick(rowOf(FILE_A));
		expect(queryMenuItem('Pin to Bookmarks')).not.toBeNull();
	});

	it('本文のメニューの Pin で失敗 → alert が 1 回。remove_bookmark の失敗も同じ文言で 1 回', async () => {
		saveResponse = new Error('disk full');
		windowState.setDocument(docOf(FILE_B));
		mountExplorer();

		contextMenu.openViewerAt(30, 40);
		await tick();
		await clickItem('Pin to Bookmarks');
		await settle();
		expect(alertMock).toHaveBeenCalledTimes(1);
		expect(String(alertMock.mock.calls[0]?.[0]).startsWith('Could not save the bookmarks: ')).toBe(true);
		expect(String(alertMock.mock.calls[0]?.[0])).toContain('disk full');

		alertMock.mockClear();
		emitBookmarksChanged([{ uri: FILE_A, kind: 'file' }]);
		await tick();
		await rightClick(rowOf(FILE_A));
		await clickItem('Unpin from Bookmarks');
		await settle();
		expect(callsOf('remove_bookmark')).toHaveLength(1);
		expect(alertMock).toHaveBeenCalledTimes(1);
		expect(String(alertMock.mock.calls[0]?.[0]).startsWith('Could not save the bookmarks: ')).toBe(true);
	});
});
