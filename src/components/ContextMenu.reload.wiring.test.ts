/**
 * 要件#80 の受け入れテスト(docs/requirements/req-80.md)— Explorer と本文のメニューの配線
 * (AC-80-12・13・17=契約 8・9・14・15。component プロジェクト・`Explorer.svelte` を JSDOM にマウントする=
 * Explorer.newtab / Explorer.symlink.wiring.test.ts と同じ家風)
 *
 * 純関数(項目列・計画・実行列)は context-menu.acceptance.test.ts と reload-file.acceptance.test.ts(unit 側)。
 * ここは **Explorer をマウントし、右クリック → 項目 → prop / list_dir / alert / ツリーの行** の配線を判定する。
 *
 * ## 配線に求める契約(implementer はこれに従う)
 * - `Explorer.svelte` に prop **`onReloadFile?: (uri: string | null) => void`**(省略可)を足し、`ContextMenu` へ
 *   同名の prop で渡す。`ContextMenu.svelte` は `reload-file` の計画 `{ command: 'reload-file', uri }` を受けたら
 *   `onReloadFile?.(uri)` を呼ぶだけ(メニューは実行の前に閉じる=既存の `activate` の家風)
 * - `ExplorerItem.svelte` の右クリックは `contextMenu.openAt(entry, x, y, windowState.currentDocument?.uri)` で
 *   開く(第 4 引数=開いている文書の URI・省略可)。ストアは `buildContextMenu(entry, openDocUri)` で項目を組む
 * - ストアに **`openViewerAt(x, y)`** を足す(entry は null・items は `buildViewerMenu()`)。本文のメニューも
 *   ツリーのメニューも同じ 1 つの `ContextMenu` が描く(窓に開くメニューは常に 1 つ)。`ContextMenu.svelte` の
 *   `planFor` は entry の無いメニューで `reload-file` → `{ command: 'reload-file', uri: null }`・
 *   `reload-folder` → `{ command: 'reload-folder', uri: null }` を返す
 * - `Explorer.svelte` が `createFolderReloader(...)`(`$lib/reload-file`)を 1 つ作り、`windowState`(root / expandedDirs /
 *   isExpanded / toggleExpanded / applyDirectoryEvent)・`invoke('list_dir', { uri })`・`alert` を渡す。`ContextMenu` の
 *   prop **`onReloadFolder(uri: string | null)`** からその `reload(uri)` を呼ぶ(フォルダの行=その URI・空白=null)
 * - 区切り線は今の描き方のまま(Duplicate Window の前に、先頭でなければ引く)。本文のメニューには出ない
 *
 * ## 判定するもの
 * - AC-80-12 Explorer のファイルの行: 開いている文書の行だけ Reload File が有効 → 押すと `onReloadFile(そのURI)` が
 *   1 回・メニューが閉じる。他の行は無効で押しても呼ばれずメニューは開いたまま。フォルダの行には無い
 * - AC-80-13 本文のメニュー: `openViewerAt` で Reload File の 1 項目(区切り線なし)→ 押すと `onReloadFile(null)` が
 *   1 回・閉じる。ツリーのメニューが開いていても `.context-menu` は 1 つだけ。Escape で閉じる
 * - AC-80-17 Reload Folder: A(展開中・下に展開中の B)の行 → `list_dir` が A と B(root・C・兄弟は呼ばれない)・
 *   差し替えた一覧の新しい行が出る・展開は保つ。畳んである C → 開くだけで `list_dir` は C で 1 回(二重に読まない)。
 *   空白 → Reload Folder・区切り線・Duplicate Window → root・A・B。A の `list_dir` が失敗 → `alert` 1 回・前の行は残る。
 *   root が ssh でも同じ
 *
 * ## 判断の記録(test-writer 2026-11-04)
 * - A の一覧を差し替えると、B の行は親の `{#each}` から**新しい entry オブジェクト**を受け取る。`ExplorerItem` の
 *   展開の `$effect` は `entry.uri` を読むので、Svelte 5 では prop の差し替えで再実行され、`list_dir(B)` を
 *   **もう一度**読みうる(既存の作り=契約 13 で変えない。監視の `directory_changed` でも同じことが起きる)。
 *   そのため B は「1 回以上」で見て、**押した直後の呼び出し列の先頭が [A, B](空白は [root, A, B])**であること・
 *   A と root が 1 回だけであること・C と兄弟が 0 回であることで「実行列が読む範囲」を固定する
 * - 「新しい行が出る」は A の下に足した `a2.md` の行(`title === uri`)で見る(B の下の行は `$effect` の再読みと
 *   区別できないので A で見る)
 *
 * ## スタブの設計(Explorer.symlink.wiring.test.ts の家風)
 * - $lib/ipc: `list_dir` は各テストが `listings` に差す一覧(Error なら reject)・`open_document` は DocumentPayload 形・
 *   他は null。観測は command 名と引数
 * - $lib/edit-guard / plugin-opener / plugin-dialog: Explorer が抱える ContextMenu.svelte の import を成立させるだけ
 * - `alert` は `vi.stubGlobal`
 * - ツリーのデータは props(root / entries)と windowState(root / expandedDirs / childEntries)に直接入れる。
 *   マウントで落ち着いた後に `invoke` の記録を消してから数える
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
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
import Explorer from './Explorer.svelte';
import { windowState, type DocumentPayload, type Entry } from '../stores/window-state.svelte';
import { contextMenu } from '../stores/context-menu.svelte';

const invokeMock = vi.mocked(invoke);

// ---------------------------------------------------------------------------
// フィクスチャ(base ごとに組む=local と ssh で同じ形)
// ---------------------------------------------------------------------------

type Tree = {
	ROOT: string;
	A: string;
	B: string;
	C: string;
	FILE_A: string;
	FILE_B: string;
	A1: string;
	A2_NEW: string;
	B1: string;
	C1: string;
	rootEntries: Entry[];
	listingA: Entry[];
	listingB: Entry[];
	listingC: Entry[];
};

function treeOf(base: string): Tree {
	const ROOT = base;
	const A = `${ROOT}/a`;
	const B = `${A}/b`;
	const C = `${ROOT}/c`;
	const FILE_A = `${ROOT}/one.md`;
	const FILE_B = `${ROOT}/two.md`;
	const A1 = `${A}/a1.md`;
	const A2_NEW = `${A}/a2-new.md`;
	const B1 = `${B}/b1.md`;
	const C1 = `${C}/c1.md`;
	return {
		ROOT,
		A,
		B,
		C,
		FILE_A,
		FILE_B,
		A1,
		A2_NEW,
		B1,
		C1,
		rootEntries: [
			{ uri: A, name: 'a', kind: 'dir' },
			{ uri: C, name: 'c', kind: 'dir' },
			{ uri: FILE_A, name: 'one.md', kind: 'file' },
			{ uri: FILE_B, name: 'two.md', kind: 'file' },
		],
		listingA: [
			{ uri: B, name: 'b', kind: 'dir' },
			{ uri: A1, name: 'a1.md', kind: 'file' },
		],
		listingB: [{ uri: B1, name: 'b1.md', kind: 'file' }],
		listingC: [{ uri: C1, name: 'c1.md', kind: 'file' }],
	};
}

/** `list_dir` の応答(URI → 一覧。Error なら reject)。各テストが差し替える。 */
let listings: Record<string, Entry[] | Error> = {};

function installInvoke() {
	invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
		if (cmd === 'open_document' || cmd === 'open_binary_document') {
			return { uri: args?.uri, content: '', modified: null };
		}
		if (cmd === 'list_dir') {
			const uri = String(args?.uri);
			const listing = listings[uri];
			if (listing instanceof Error) throw listing;
			return listing ?? [];
		}
		return null;
	});
}

const callsOf = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd);
const listDirUris = () => callsOf('list_dir').map((c) => String((c[1] as { uri?: unknown } | undefined)?.uri));

const alertMock = vi.fn((_message?: unknown) => {});

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** 非同期のクリック処理・展開 effect・store の反映を流しきる。 */
async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
	await flushAsync();
	await flushAsync();
	await tick();
}

function mountExplorer(tree: Tree) {
	const onReloadFile = vi.fn((_uri: string | null) => {});
	const onDuplicateWindow = vi.fn();
	const onOpenInNewWindow = vi.fn();
	const result = render(Explorer, {
		props: {
			root: tree.ROOT,
			entries: tree.rootEntries,
			selectedUri: undefined,
			onDuplicateWindow,
			onOpenInNewWindow,
			onReloadFile,
		},
	});
	const nav = result.container.querySelector('nav.explorer-list');
	if (!(nav instanceof HTMLElement)) throw new Error('Explorer must render nav.explorer-list');
	return { ...result, nav, onReloadFile, onDuplicateWindow, onOpenInNewWindow };
}

/** `.explorer-item` を `title === uri` で探す(scrollTreeItemIntoView と同じ引き方)。 */
function rowsByTitle(uri: string): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>('.explorer-item')].filter((row) => row.title === uri);
}

function rowOf(uri: string): HTMLButtonElement {
	const rows = rowsByTitle(uri);
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

beforeEach(() => {
	listings = {};
	installInvoke();
	alertMock.mockClear();
	vi.stubGlobal('alert', alertMock);
});

afterEach(() => {
	contextMenu.close();
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC-80-12 — Explorer のファイルの行の配線(契約 9)
// ---------------------------------------------------------------------------

describe('AC-80-12: Explorer のファイルの行の Reload File(契約 9)', () => {
	const tree = treeOf('file:///Users/x/notes');

	beforeEach(() => {
		windowState.applyRoot(tree.ROOT, tree.rootEntries, false);
		windowState.setExpandedDirs([]);
	});

	it('文書 A を開いた状態で A の行を右クリック → Reload File が有効 → 押すと onReloadFile(A の URI) が 1 回・メニューが閉じる', async () => {
		windowState.setDocument(docOf(tree.FILE_A));
		const { onReloadFile } = mountExplorer(tree);

		await rightClick(rowOf(tree.FILE_A));
		const item = menuItem('Reload File');
		expect(item.disabled, 'the open document row has Reload File enabled').toBe(false);

		await clickItem('Reload File');

		expect(onReloadFile).toHaveBeenCalledTimes(1);
		expect(onReloadFile).toHaveBeenCalledWith(tree.FILE_A);
		expect(contextMenu.open).toBe(false);
		expect(menuCount()).toBe(0);
	});

	it('文書 A を開いた状態で B の行を右クリック → Reload File は無効で、押しても呼ばれず、メニューは開いたまま', async () => {
		windowState.setDocument(docOf(tree.FILE_A));
		const { onReloadFile } = mountExplorer(tree);

		await rightClick(rowOf(tree.FILE_B));
		const item = menuItem('Reload File');
		expect(item.disabled, 'another row has Reload File greyed').toBe(true);

		await fireEvent.click(item);
		await settle();

		expect(onReloadFile).not.toHaveBeenCalled();
		expect(contextMenu.open).toBe(true);
		expect(menuCount()).toBe(1);
	});

	it('文書を開いていない窓では、どのファイルの行でも Reload File は無効', async () => {
		const { onReloadFile } = mountExplorer(tree);

		await rightClick(rowOf(tree.FILE_A));
		expect(menuItem('Reload File').disabled).toBe(true);

		await fireEvent.click(menuItem('Reload File'));
		await settle();
		expect(onReloadFile).not.toHaveBeenCalled();
	});

	it('フォルダの行のメニューに Reload File は無い(Reload Folder がある)', async () => {
		windowState.setDocument(docOf(tree.FILE_A));
		mountExplorer(tree);

		await rightClick(rowOf(tree.C));

		expect(queryMenuItem('Reload File')).toBeNull();
		expect(queryMenuItem('Reload Folder')).not.toBeNull();
	});

	it('A の行の Reload File を押しても、ContextMenu からは invoke も confirm も走らない(実行列はページ側)', async () => {
		windowState.setDocument(docOf(tree.FILE_A));
		mountExplorer(tree);
		await settle();
		invokeMock.mockClear();

		await rightClick(rowOf(tree.FILE_A));
		await clickItem('Reload File');

		expect(callsOf('open_document')).toHaveLength(0);
		expect(callsOf('open_binary_document')).toHaveLength(0);
		expect(callsOf('list_dir')).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// AC-80-13 — 本文のメニューの配線(契約 8)
// ---------------------------------------------------------------------------

// 要件#83 契約 7(2026-11-05 承認 3 の要件側更新): 本文のメニューは Reload File の後に Pin to Bookmarks が増えて 2 項目
// (済みなら Unpin=ContextMenu.bookmarks.wiring.test.ts の持ち場)。題と期待の列挙だけ改め、区切り線 0・押したときの assert・
// 「窓に開くメニューは 1 つ」はそのまま。
describe('AC-80-13: 本文のメニュー(openViewerAt)は Reload File と Pin to Bookmarks の 2 項目(要件#83)で、窓に開くメニューは 1 つ(契約 8)', () => {
	const tree = treeOf('file:///Users/x/notes');

	beforeEach(() => {
		windowState.applyRoot(tree.ROOT, tree.rootEntries, false);
		windowState.setExpandedDirs([]);
		windowState.setDocument(docOf(tree.FILE_A));
	});

	// 要件#83 契約 7(2026-11-05 承認 3 の要件側更新): 本文のメニューは Reload File の後に Pin to Bookmarks が増えて 2 つ。
	// 区切り線 0・押したときの assert はそのまま。
	it('openViewerAt(x, y) → 項目は Reload File と Pin to Bookmarks の 2 つ(区切り線なし)→ Reload File を押すと onReloadFile(null) が 1 回・閉じる', async () => {
		const { onReloadFile } = mountExplorer(tree);

		contextMenu.openViewerAt(30, 40);
		await tick();

		expect(contextMenu.open).toBe(true);
		expect(menuCount()).toBe(1);
		expect(menuLabels()).toEqual(['Reload File', 'Pin to Bookmarks']);
		expect(separatorCount()).toBe(0);
		expect(menuItem('Reload File').disabled).toBe(false);

		await clickItem('Reload File');

		expect(onReloadFile).toHaveBeenCalledTimes(1);
		expect(onReloadFile).toHaveBeenCalledWith(null);
		expect(contextMenu.open).toBe(false);
		expect(menuCount()).toBe(0);
	});

	it('ツリーのメニューが開いているときに本文のメニューを開くと、ツリーのメニューは閉じて .context-menu は 1 つだけ', async () => {
		mountExplorer(tree);

		await rightClick(rowOf(tree.FILE_A));
		expect(menuLabels()).toContain('Copy Path');
		expect(menuCount()).toBe(1);

		contextMenu.openViewerAt(30, 40);
		await tick();

		expect(menuCount()).toBe(1);
		expect(menuLabels()).toEqual(['Reload File', 'Pin to Bookmarks']);
		expect(contextMenu.entry).toBeNull();
	});

	it('本文のメニューが開いているときにツリーの行を右クリックすると、本文のメニューは閉じて行のメニューだけになる(逆も同じ)', async () => {
		mountExplorer(tree);

		contextMenu.openViewerAt(30, 40);
		await tick();
		expect(menuLabels()).toEqual(['Reload File', 'Pin to Bookmarks']);

		await rightClick(rowOf(tree.FILE_B));

		expect(menuCount()).toBe(1);
		expect(menuLabels()).toContain('Copy Path');
		expect(menuLabels()).toContain('Reload File');
		expect(menuLabels().length).toBeGreaterThan(1);
	});

	it('Escape で閉じる', async () => {
		mountExplorer(tree);

		contextMenu.openViewerAt(30, 40);
		await tick();
		expect(menuCount()).toBe(1);

		await fireEvent.keyDown(window, { key: 'Escape' });
		await tick();

		expect(contextMenu.open).toBe(false);
		expect(menuCount()).toBe(0);
	});

	it('onReloadFile を渡さずにマウントしても、本文のメニューの Reload File を押して例外が出ない(省略可)', async () => {
		render(Explorer, {
			props: {
				root: tree.ROOT,
				entries: tree.rootEntries,
				selectedUri: undefined,
				onDuplicateWindow: vi.fn(),
				onOpenInNewWindow: vi.fn(),
			},
		});

		contextMenu.openViewerAt(30, 40);
		await tick();

		await expect(clickItem('Reload File')).resolves.toBeUndefined();
		expect(contextMenu.open).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC-80-17 — Reload Folder の配線(契約 14・15)。root が local でも ssh でも同じ
// ---------------------------------------------------------------------------

describe.each([
	['local', 'file:///Users/x/notes'],
	['ssh', 'ssh://alice@host:22/srv/notes'],
])('AC-80-17 (%s): Explorer の Reload Folder(契約 14・15)', (_label, base) => {
	const tree = treeOf(base);

	beforeEach(async () => {
		listings = {
			[tree.ROOT]: tree.rootEntries,
			[tree.A]: tree.listingA,
			[tree.B]: tree.listingB,
			[tree.C]: tree.listingC,
		};
		windowState.applyRoot(tree.ROOT, tree.rootEntries, false);
		// A は展開中・その下の B も展開中・C は畳んである。
		windowState.setExpandedDirs([tree.A, tree.B]);
	});

	/** マウントして展開の effect(subscribe_dir / list_dir)が落ち着くのを待ち、記録を消す。 */
	async function mountSettled() {
		const mounted = mountExplorer(tree);
		await settle();
		await settle();
		// 展開中の A と B の行が出ていること(前提の確認)。
		expect(rowsByTitle(tree.B)).toHaveLength(1);
		expect(rowsByTitle(tree.A1)).toHaveLength(1);
		expect(rowsByTitle(tree.B1)).toHaveLength(1);
		invokeMock.mockClear();
		alertMock.mockClear();
		return mounted;
	}

	it('1. A の行 → Reveal in Finder・Open in New Window・Reload Folder・Copy Path・Duplicate Window(Reload File は無い)・Reload Folder は有効 → 押すと list_dir が A と B(root・C は呼ばれない)・メニューが閉じ・新しい行が出て・展開は同じ', async () => {
		await mountSettled();

		await rightClick(rowOf(tree.A));
		// 要件#83 契約 7(2026-11-05 承認 3 の要件側更新): Copy Path の後に Pin to Bookmarks。
		expect(menuLabels()).toEqual([
			'Reveal in Finder',
			'Open in New Window',
			'Reload Folder',
			'Copy Path',
			'Pin to Bookmarks',
			'Duplicate Window',
		]);
		expect(menuItem('Reload Folder').disabled).toBe(false);

		// 外で A に a2-new.md が足され、B の中身も変わった。
		listings[tree.A] = [...tree.listingA, { uri: tree.A2_NEW, name: 'a2-new.md', kind: 'file' }];
		listings[tree.B] = [{ uri: `${tree.B}/b2-new.md`, name: 'b2-new.md', kind: 'file' }];

		await clickItem('Reload Folder');

		const uris = listDirUris();
		expect(uris.slice(0, 2), 'the reloader lists A then B together').toEqual([tree.A, tree.B]);
		expect(uris.filter((u) => u === tree.A), 'A is listed once').toHaveLength(1);
		expect(uris.filter((u) => u === tree.ROOT), 'root is not listed').toHaveLength(0);
		expect(uris.filter((u) => u === tree.C), 'C (sibling, collapsed) is not listed').toHaveLength(0);
		expect(contextMenu.open).toBe(false);
		expect(rowsByTitle(tree.A2_NEW), 'the new file under A shows in the tree').toHaveLength(1);
		expect(windowState.expandedDirs, 'the expansion is kept').toEqual([tree.A, tree.B]);
		expect(windowState.isExpanded(tree.B)).toBe(true);
		expect(alertMock).not.toHaveBeenCalled();
	});

	it('2. 畳んである C の行で Reload Folder → C が開き、list_dir は C で 1 回だけ(二重に読まない)【(w) 決定】', async () => {
		await mountSettled();
		expect(windowState.isExpanded(tree.C)).toBe(false);

		await rightClick(rowOf(tree.C));
		expect(menuItem('Reload Folder').disabled).toBe(false);
		await clickItem('Reload Folder');
		await settle();

		expect(windowState.isExpanded(tree.C)).toBe(true);
		expect(listDirUris().filter((u) => u === tree.C), 'C is read once, by the expansion effect').toHaveLength(1);
		expect(rowsByTitle(tree.C1), "C's children show").toHaveLength(1);
		expect(listDirUris().filter((u) => u === tree.A || u === tree.B || u === tree.ROOT)).toHaveLength(0);
		expect(contextMenu.open).toBe(false);
		expect(alertMock).not.toHaveBeenCalled();
	});

	it('3. 空白を右クリック → Reload Folder・Duplicate Window の 2 つで、間に区切り線が 1 本【(v) 決定】。Reload Folder を押すと root・A・B で list_dir', async () => {
		const { nav } = await mountSettled();

		await rightClick(nav);
		expect(contextMenu.open).toBe(true);
		expect(contextMenu.entry).toBeNull();
		expect(menuLabels()).toEqual(['Reload Folder', 'Duplicate Window']);
		expect(separatorCount()).toBe(1);
		expect(menuItem('Reload Folder').disabled).toBe(false);

		await clickItem('Reload Folder');

		const uris = listDirUris();
		expect(uris.slice(0, 3), 'the reloader lists root, A, B together').toEqual([tree.ROOT, tree.A, tree.B]);
		expect(uris.filter((u) => u === tree.ROOT)).toHaveLength(1);
		expect(uris.filter((u) => u === tree.A)).toHaveLength(1);
		expect(uris.filter((u) => u === tree.C), 'C (collapsed) is not listed').toHaveLength(0);
		expect(contextMenu.open).toBe(false);
		expect(windowState.expandedDirs).toEqual([tree.A, tree.B]);
		expect(alertMock).not.toHaveBeenCalled();
	});

	it("4. A の list_dir が reject → alert が 1 回 'Could not reload the folder: …'・A の下の前の行は残る", async () => {
		await mountSettled();
		listings[tree.A] = new Error('Permission denied (os error 13)');

		await rightClick(rowOf(tree.A));
		await clickItem('Reload Folder');
		await settle();

		expect(alertMock).toHaveBeenCalledTimes(1);
		const message = String(alertMock.mock.calls[0]?.[0]);
		expect(message.startsWith('Could not reload the folder: ')).toBe(true);
		expect(message).toContain('Permission denied (os error 13)');
		expect(rowsByTitle(tree.B), 'the previous rows under A remain').toHaveLength(1);
		expect(rowsByTitle(tree.A1)).toHaveLength(1);
		expect(windowState.isExpanded(tree.A)).toBe(true);
		expect(contextMenu.open).toBe(false);
	});

	it('4b. 空白の Reload Folder で root の list_dir が reject → alert は 1 回だけ', async () => {
		const { nav } = await mountSettled();
		listings[tree.ROOT] = new Error('Connection reset');

		await rightClick(nav);
		await clickItem('Reload Folder');
		await settle();

		expect(alertMock).toHaveBeenCalledTimes(1);
		expect(String(alertMock.mock.calls[0]?.[0])).toBe('Could not reload the folder: Connection reset');
	});
});
