/**
 * 要件#83 の受け入れテスト(docs/requirements/req-83.md)— Dashboard の配線
 * (AC-83-24 の 1〜13=契約 1・2・4・5・6・7・8・10・12・13・14。component プロジェクト・`Dashboard.svelte` を JSDOM に
 * マウントする=ContextMenu.reload.wiring.test.ts と同じ家風)
 *
 * 開く列(AC-83-24 の 3・4・5・9 の Return)は **Dashboard が自分で回す**(2026-11-05 オーケストレーター決定=案A・
 * 事後確認に回す): `planDashboardOpen(target, currentRoot)` → 文書か root が替わるなら `confirmDiscard()` → `root` が
 * あれば `invoke('set_root', { uri })` → `doc` があれば `openForDisplay(doc)`(= invoke('open_document' | 'open_binary_document'))
 * → `onOpened(root, doc)`。ページは `onOpened` で `applyRoot` / `setDocument` / `handleRecentFileOpened` / Dashboard を閉じる。
 * 今の `onSelect` は落とす(走査する既存テストは無い)。
 *
 * ## 配線に求める契約(implementer はこれに従う。props と DOM は test-writer が固定)
 * - props(契約 1・4・5):
 *   - `error: string | null`(ページからの注記=Select Folder… の失敗)・`onPickFolder: () => void`(Select Folder…)
 *   - `onClose: () => void`(推奨名=戻る口。Escape で、メニューもドラッグも開いていないときに 1 回呼ぶ。戻れるかの判定は
 *     ページ側の `toggleDashboard`)
 *   - `currentRoot: string | null`(戻れる Dashboard の後ろの root。起動時・init の失敗・New Window の Dashboard は null=(w))
 *   - `confirmDiscard?: () => Promise<boolean>`(省略時は `$lib/edit-guard` の `confirmDiscardEdits`)
 *   - `onOpened: (root: RootPayload | null, doc: DocumentPayload | null) => void`(開けたとき 1 回。root は `set_root` の
 *     解決値(切り替えなかったら null)・doc は `openForDisplay` の解決値(文書が無ければ null)。両方 null = 同じ root の
 *     フォルダ=閉じるだけ)
 * - 開く列の判定(契約 5): 確認が false → 何も呼ばない。`set_root` が reject → `onOpened` を呼ばず、Dashboard の中の
 *   `[role="alert"]` に `Could not open the folder: <理由>`。root を替えずに文書だけ reject → `[role="alert"]` に
 *   `Could not open the file: <理由>`(Dashboard のまま)。root を替えた後に文書だけ reject → `onOpened(root, null)` と
 *   `alert('Could not open the file: <理由>')` を 1 回ずつ【(aa)】。押したのが今の文書で root も同じ → 確認なしで
 *   `onOpened(null, null)`。Return / Space はクリックと同じ(button)
 * - データ(契約 6・10・12【(ap)】): マウントで `invoke('list_history')`(Recent Folders)・`invoke('list_missing_paths',
 *   { uris })`(Bookmark と履歴の local の URI)・`invoke('scan_recently_modified', { generation })` を呼ぶ。Bookmark の一覧は
 *   `stores/bookmarks.svelte` の `bookmarks.list`(ページが `init()` 済み=このテストでは先に呼ぶ)。
 *   `listen('recently_modified_progress')` と `bookmarks_changed`(ストア)を購読する
 * - DOM(契約 2):
 *   - 一番外の要素に class `root-picker`
 *   - 上の段のボタン: テキスト `Open…`・`New Window`・`Select Folder…`
 *   - Bookmarks: `section.dashboard-bookmarks`、見出しの件数 `.count`、タイル `button.bookmark-tile`(`title` = URI・
 *     見つからないものは class `missing`・ssh は中に `.ssh-badge`(テキスト `SSH`)・掴み手 `.bookmark-grip`)、末尾に
 *     `button.add-bookmark`(テキスト `Add Bookmark…`)
 *   - Recent Folders: `section.dashboard-recent-folders`、行 `button.recent-folder`(`title` = URI・`missing`・`.ssh-badge`)、
 *     補足のテキスト `6 of 14`、ボタン `Show All` / `Show Less`
 *   - Recently Modified: `section.dashboard-recently-modified`、行 `button.modified-row`(`title` = URI)、補足 `in N folders`、
 *     `button[aria-label="Rescan"]`、打ち切りの知らせ・空の文言はテキスト
 *   - 注記: `[role="alert"]`。足元: Tip のテキスト
 *   - 右クリックのメニュー: Dashboard の中の `ContextMenu.svelte`(`.context-menu`・`[role="menuitem"]`・`[role="separator"]`)
 * - フォーカス(契約 13): 区画は roving tabindex(区画で 1 つだけ `tabindex="0"`)。マウント後は最初のタイル(0 件なら
 *   `Add Bookmark…`)にフォーカス。← / → でタイル間・Option + 矢印で `move_bookmark`
 * - ドラッグ(契約 8): 掴み手の pointerdown → 4px 以上の pointermove で始まり、pointerup の位置のタイルの index へ
 *   `move_bookmark(uri, to)`。落とす先は pointer の位置(`document.elementFromPoint` かタイルの rect)で決める=このテストは
 *   両方を同じ値で差す。`setPointerCapture` は無い環境(JSDOM)でも落ちないこと。Escape で取りやめ・動かずに離す=何もしない・
 *   タイルの本体からは始まらない
 *
 * ## スタブの設計
 * - $lib/ipc の invoke: command 名で応答(下の `installInvoke`)。`scan_recently_modified` は各テストが deferred にできる
 * - $lib/events の listen: event 名ごとに handler を記録し、テストが起こす
 * - @tauri-apps/plugin-dialog の open: 各テストが応答を差す
 * - `alert` は `vi.stubGlobal`。`document.elementFromPoint`・`Element.prototype.setPointerCapture` 系は JSDOM に無いので差す
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick, type ComponentProps } from 'svelte';

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
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type { Bookmark } from '$lib/bookmarks';
import Dashboard from './Dashboard.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { contextMenu } from '../stores/context-menu.svelte';
import { bookmarks } from '../stores/bookmarks.svelte';

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
// menu-language.acceptance.test.ts と同じ型付け(open は overload なので vi.mocked の型が合わない)。
const openDialogMock = openDialog as unknown as Mock<
	(options?: Record<string, unknown>) => Promise<string | string[] | null>
>;

type Handler = (e: { payload: unknown }) => void;
const handlers: Record<string, Handler[]> = {};
/**
 * ストアの `bookmarks_changed` の handler。ストアは窓(=このモジュール)に 1 つで、契約 9 のとおり最初の `init()` で
 * 1 回だけ購読し 2 回目以降は購読し直さない。そのため最初の init の直後(まだ何もマウントしていない)に控え、
 * 各テストの準備で `handlers` を空にした後にこれだけ戻す(コンポーネントが登録した handler はテストごとに消す)。
 */
let storeHandlers: Handler[] | null = null;

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const AURORA = 'file:///Users/x/aurora';
const GONE_FOLDER = 'file:///Users/x/gone';
const SSH_FOLDER = 'ssh://alice@host:22/srv/notes';
const PLAN = 'file:///Users/x/aurora/plan.md';
const HISTORY: string[] = [
	AURORA,
	SSH_FOLDER,
	GONE_FOLDER,
	...Array.from({ length: 11 }, (_, i) => `file:///Users/x/folder-${i}`),
];
const BOOKMARKS: Bookmark[] = [
	{ uri: AURORA, kind: 'folder' },
	{ uri: PLAN, kind: 'file' },
	{ uri: SSH_FOLDER, kind: 'folder' },
];
const MISSING = new Set([GONE_FOLDER, PLAN]);

type ModifiedFile = { uri: string; folder: string; modified: number };
type Scan = { generation: number; files: ModifiedFile[]; folders: number; truncated: boolean };
const F1: ModifiedFile = { uri: `${AURORA}/docs/design/a.html`, folder: AURORA, modified: 1_700_000_300_000 };
const F2: ModifiedFile = { uri: `${AURORA}/README.md`, folder: AURORA, modified: 1_700_000_200_000 };
const F3: ModifiedFile = { uri: 'file:///Users/x/folder-0/notes.md', folder: 'file:///Users/x/folder-0', modified: 1_700_000_100_000 };

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

type RootPayload = { root_uri: string; entries: unknown[]; document_retained: boolean };

/** 各テストが差し替える応答。 */
let history: string[] = [];
let scanResponse: ((generation: number) => Promise<Scan>) | null = null;
/** `set_root` / `open_document`(`open_binary_document`)の応答。Error なら reject。 */
let setRootResponse: ((uri: string) => RootPayload) | Error = (uri) => ({ root_uri: uri, entries: [], document_retained: false });
let openDocResponse: ((uri: string) => DocumentPayload) | Error = (uri) => ({ uri, content: '# doc\n', modified: 1 });

function installInvoke() {
	invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
		switch (cmd) {
			case 'set_root': {
				if (setRootResponse instanceof Error) throw setRootResponse;
				return setRootResponse(String(args?.uri));
			}
			case 'open_document':
			case 'open_binary_document': {
				if (openDocResponse instanceof Error) throw openDocResponse;
				return openDocResponse(String(args?.uri));
			}
			case 'list_history':
				return history;
			case 'list_bookmarks':
				return BOOKMARKS;
			case 'list_missing_paths': {
				const uris = (args?.uris as string[] | undefined) ?? [];
				return uris.filter((u) => MISSING.has(u));
			}
			case 'scan_recently_modified': {
				const generation = Number(args?.generation);
				if (scanResponse) return scanResponse(generation);
				return { generation, files: [], folders: 2, truncated: false } satisfies Scan;
			}
			case 'add_bookmark':
			case 'remove_bookmark':
			case 'move_bookmark':
				return bookmarks.list;
			case 'remove_history_entry': {
				history = history.filter((u) => u !== String(args?.uri));
				return history;
			}
			default:
				return null;
		}
	});
}

const callsOf = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd);
const argsOf = (cmd: string) => callsOf(cmd).map((c) => c[1] as Record<string, unknown> | undefined);

const alertMock = vi.fn((_message?: unknown) => {});
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
	await flushAsync();
	await flushAsync();
	await tick();
}

function emit(event: string, payload: unknown) {
	const hs = handlers[event] ?? [];
	expect(hs.length, `someone subscribed to ${event}`).toBeGreaterThan(0);
	for (const h of hs) h({ payload });
}

type DashboardProps = ComponentProps<typeof Dashboard>;

/** 確認(注入)。各テストが true / false を差す。 */
let confirmAnswer = true;

async function mountDashboard(extra: Partial<DashboardProps> = {}) {
	const onPickFolder = vi.fn();
	const onClose = vi.fn();
	const onOpened = vi.fn((_root: RootPayload | null, _doc: DocumentPayload | null) => {});
	const confirmDiscard = vi.fn(async () => confirmAnswer);
	const props: DashboardProps = {
		error: null,
		currentRoot: null,
		confirmDiscard,
		onOpened,
		onClose,
		onPickFolder,
		...extra,
	};
	const result = render(Dashboard, { props });
	await settle();
	await settle();
	return { ...result, onPickFolder, onClose, onOpened, confirmDiscard };
}

/** 呼ばれた command の名前の列(順序の判定に使う)。 */
const commandSequence = (...names: string[]) => invokeMock.mock.calls.map((c) => c[0]).filter((n) => names.includes(n));

const tiles = () => [...document.querySelectorAll<HTMLButtonElement>('.bookmark-tile')];
const tileOf = (uri: string) => {
	const found = tiles().filter((t) => t.title === uri);
	expect(found, `exactly one tile with title === ${uri}`).toHaveLength(1);
	return found[0]!;
};
const addTile = () => document.querySelector<HTMLButtonElement>('.add-bookmark')!;
const recentRows = () => [...document.querySelectorAll<HTMLButtonElement>('.recent-folder')];
const recentRowOf = (uri: string) => {
	const found = recentRows().filter((r) => r.title === uri);
	expect(found, `exactly one recent row with title === ${uri}`).toHaveLength(1);
	return found[0]!;
};
const modifiedRows = () => [...document.querySelectorAll<HTMLButtonElement>('.modified-row')];
const section = (name: 'bookmarks' | 'recent-folders' | 'recently-modified') =>
	document.querySelector<HTMLElement>(`section.dashboard-${name}`)!;
const textOf = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
/** テキストで始まるボタン(上の段のボタンはショートカットの表示を伴ってよい)。 */
const buttonByText = (text: string) =>
	[...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => textOf(b).startsWith(text)) ?? null;

async function rightClick(target: Element) {
	await fireEvent.contextMenu(target, { clientX: 20, clientY: 20 });
	await tick();
}

const menuLabels = () => screen.queryAllByRole('menuitem').map((b) => b.textContent?.trim() ?? '');
const menuItem = (name: string) => screen.getByRole('menuitem', { name }) as HTMLButtonElement;
const menuCount = () => document.querySelectorAll('.context-menu').length;
const separatorCount = () => document.querySelectorAll('.context-menu [role="separator"]').length;

async function clickItem(name: string) {
	await fireEvent.click(menuItem(name));
	await settle();
}

beforeEach(async () => {
	for (const k of Object.keys(handlers)) delete handlers[k];
	listenMock.mockImplementation(async (event, handler) => {
		(handlers[event] ??= []).push(handler as Handler);
		return () => {};
	});
	history = [...HISTORY];
	scanResponse = null;
	setRootResponse = (uri) => ({ root_uri: uri, entries: [], document_retained: false });
	openDocResponse = (uri) => ({ uri, content: '# doc\n', modified: 1 });
	confirmAnswer = true;
	installInvoke();
	alertMock.mockClear();
	vi.stubGlobal('alert', alertMock);
	openDialogMock.mockReset();
	openDialogMock.mockResolvedValue(null);
	windowState.version = '1.2.3';
	// ページと同じく起動時に 1 回(2 回目以降は何もしない=契約 9)。最初の init の購読を控えて毎回戻し、
	// 直前のテストの一覧を event で BOOKMARKS に戻す(ストアは窓に 1 つ)。購読していなければここで落ちる。
	await bookmarks.init();
	storeHandlers ??= [...(handlers['bookmarks_changed'] ?? [])];
	handlers['bookmarks_changed'] = [...storeHandlers];
	emit('bookmarks_changed', BOOKMARKS);
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
// AC-83-24 の 1 — 3 区画と見出し・件数・補足・missing・SSH・器の class(契約 1・2・6・10)
// ---------------------------------------------------------------------------

describe('AC-83-24 (1): 履歴 14 件(ssh 1・消えたもの 1)と Bookmark 3 件(フォルダ・ファイル・ssh)', () => {
	it('3 区画と見出し・件数・補足が出て、一番外の要素が class root-picker を持つ', async () => {
		const { container } = await mountDashboard();

		const outer = container.firstElementChild;
		expect(outer, 'the component renders an element').not.toBeNull();
		expect(outer!.classList.contains('root-picker'), 'the outermost element keeps .root-picker ((r))').toBe(true);

		expect(textOf(section('bookmarks'))).toContain('Bookmarks');
		expect(textOf(section('bookmarks').querySelector('.count'))).toBe('3');
		expect(textOf(section('recent-folders'))).toContain('Recent Folders');
		expect(textOf(section('recently-modified'))).toContain('Recently Modified');
		expect(textOf(section('recently-modified'))).toContain('in 2 folders');

		expect(callsOf('list_history')).toHaveLength(1);
		expect(callsOf('scan_recently_modified')).toHaveLength(1);
		expect(callsOf('list_missing_paths').length).toBeGreaterThanOrEqual(1);
		const asked = new Set(argsOf('list_missing_paths').flatMap((a) => (a?.uris as string[]) ?? []));
		expect(asked.has(GONE_FOLDER), 'the local history folders are checked').toBe(true);
		expect(asked.has(PLAN), 'the local bookmarks are checked').toBe(true);

		// 上の段と足元(契約 2)。
		expect(buttonByText('Open…')).not.toBeNull();
		expect(buttonByText('New Window')).not.toBeNull();
		expect(buttonByText('Select Folder…')).not.toBeNull();
		expect(document.body.textContent).toContain('Version 1.2.3');
		expect(document.body.textContent).toContain('Tip: Press Shift + Command + H to open this Dashboard at any time.');
	});

	it('Bookmark のタイルは保存の順に 3 枚+Add Bookmark…。消えたタイルは class missing・ssh は SSH の札', async () => {
		await mountDashboard();

		expect(tiles().map((t) => t.title)).toEqual([AURORA, PLAN, SSH_FOLDER]);
		expect(addTile()).not.toBeNull();
		expect(textOf(addTile())).toBe('Add Bookmark…');
		expect(tileOf(PLAN).classList.contains('missing')).toBe(true);
		expect(tileOf(AURORA).classList.contains('missing')).toBe(false);
		expect(tileOf(SSH_FOLDER).classList.contains('missing'), 'ssh is shown as present without checking').toBe(false);
		expect(textOf(tileOf(SSH_FOLDER).querySelector('.ssh-badge'))).toBe('SSH');
		expect(tileOf(AURORA).querySelector('.ssh-badge')).toBeNull();
		expect(textOf(tileOf(AURORA))).toContain('aurora');
		expect(textOf(tileOf(PLAN))).toContain('plan.md');
	});

	it("Recent Folders は 6 行と '6 of 14'、Show All で 14 行と Show Less。消えた行は missing・ssh は SSH の札", async () => {
		await mountDashboard();

		expect(recentRows().map((r) => r.title)).toEqual(HISTORY.slice(0, 6));
		expect(textOf(section('recent-folders'))).toContain('6 of 14');
		expect(recentRowOf(GONE_FOLDER).classList.contains('missing')).toBe(true);
		expect(recentRowOf(AURORA).classList.contains('missing')).toBe(false);
		expect(textOf(recentRowOf(SSH_FOLDER).querySelector('.ssh-badge'))).toBe('SSH');
		expect(recentRowOf(AURORA).querySelector('.ssh-badge')).toBeNull();

		const showAll = buttonByText('Show All');
		expect(showAll).not.toBeNull();
		expect(buttonByText('Show Less')).toBeNull();
		await fireEvent.click(showAll!);
		await tick();
		expect(recentRows().map((r) => r.title)).toEqual(HISTORY);
		expect(buttonByText('Show Less')).not.toBeNull();
		expect(buttonByText('Show All')).toBeNull();

		await fireEvent.click(buttonByText('Show Less')!);
		await tick();
		expect(recentRows()).toHaveLength(6);
	});

	it("履歴が空 → 'No recently opened folders'・Show All なし", async () => {
		history = [];
		await mountDashboard();
		expect(recentRows()).toHaveLength(0);
		expect(textOf(section('recent-folders'))).toContain('No recently opened folders');
		expect(buttonByText('Show All')).toBeNull();
	});

	it('error を渡すと role="alert" の注記として出る', async () => {
		await mountDashboard({ error: 'Could not open the folder: No such file or directory' });
		const alert = document.querySelector('[role="alert"]');
		expect(textOf(alert)).toBe('Could not open the folder: No such file or directory');
	});
});

// ---------------------------------------------------------------------------
// AC-83-24 の 2 — 開いたときのフォーカス(契約 13)
// ---------------------------------------------------------------------------

describe('AC-83-24 (2): マウントの後のフォーカス', () => {
	it('最初のタイルにフォーカス', async () => {
		await mountDashboard();
		expect(document.activeElement).toBe(tileOf(AURORA));
	});

	it('Bookmark が 0 件なら Add Bookmark…', async () => {
		emit('bookmarks_changed', []);
		await tick();
		await mountDashboard();
		expect(tiles()).toHaveLength(0);
		expect(document.activeElement).toBe(addTile());
		expect(textOf(section('bookmarks').querySelector('.count'))).toBe('0');
	});
});

// ---------------------------------------------------------------------------
// AC-83-24 の 3 — Recent Folders の行を押す(契約 5【(c)】・確認は注入)
// ---------------------------------------------------------------------------

describe('AC-83-24 (3): Recent Folders の行を押す → 確認(注入)の後に set_root(その URI) が 1 回', () => {
	it('確認が true → confirmDiscard 1 回 → set_root(その URI) 1 回(文書は開かない)→ onOpened(root の解決値, null) 1 回', async () => {
		const { confirmDiscard, onOpened } = await mountDashboard({ currentRoot: null });
		invokeMock.mockClear();

		await fireEvent.click(recentRowOf(HISTORY[3]!));
		await settle();

		expect(confirmDiscard).toHaveBeenCalledTimes(1);
		expect(argsOf('set_root')).toEqual([{ uri: HISTORY[3] }]);
		expect(callsOf('open_document')).toHaveLength(0);
		expect(callsOf('open_binary_document')).toHaveLength(0);
		expect(onOpened).toHaveBeenCalledTimes(1);
		expect(onOpened.mock.calls[0]?.[0]).toMatchObject({ root_uri: HISTORY[3] });
		expect(onOpened.mock.calls[0]?.[1]).toBeNull();
		expect(document.querySelector('[role="alert"]')).toBeNull();
	});

	it('確認が false → 何も呼ばない(set_root も open_document も onOpened も)・Dashboard のまま', async () => {
		confirmAnswer = false;
		const { confirmDiscard, onOpened, onClose } = await mountDashboard({ currentRoot: 'file:///Users/x/other' });
		invokeMock.mockClear();

		await fireEvent.click(recentRowOf(HISTORY[3]!));
		await settle();

		expect(confirmDiscard).toHaveBeenCalledTimes(1);
		expect(callsOf('set_root')).toHaveLength(0);
		expect(callsOf('open_document')).toHaveLength(0);
		expect(onOpened).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
		expect(recentRows()).toHaveLength(6);
	});

	it('消えたフォルダの行も ssh の行も押せる(確かめずに set_root へ)。消えた行は履歴から消えない', async () => {
		const { onOpened } = await mountDashboard();
		invokeMock.mockClear();

		await fireEvent.click(recentRowOf(SSH_FOLDER));
		await settle();
		expect(argsOf('set_root')).toEqual([{ uri: SSH_FOLDER }]);
		expect(onOpened).toHaveBeenCalledTimes(1);

		setRootResponse = new Error('No such file or directory (os error 2)');
		await fireEvent.click(recentRowOf(GONE_FOLDER));
		await settle();
		expect(argsOf('set_root')).toEqual([{ uri: SSH_FOLDER }, { uri: GONE_FOLDER }]);
		expect(callsOf('remove_history_entry')).toHaveLength(0);
		expect(recentRows().some((r) => r.title === GONE_FOLDER)).toBe(true);
	});

	it('confirmDiscard を渡さなければ $lib/edit-guard の confirmDiscardEdits を使う', async () => {
		const { confirmDiscardEdits } = await import('$lib/edit-guard');
		const guard = vi.mocked(confirmDiscardEdits);
		guard.mockClear();
		const onOpened = vi.fn();
		render(Dashboard, {
			props: { error: null, currentRoot: null, onOpened, onClose: vi.fn(), onPickFolder: vi.fn() } as DashboardProps,
		});
		await settle();
		await settle();
		invokeMock.mockClear();

		await fireEvent.click(recentRowOf(HISTORY[3]!));
		await settle();
		expect(guard).toHaveBeenCalledTimes(1);
		expect(argsOf('set_root')).toEqual([{ uri: HISTORY[3] }]);
		expect(onOpened).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// AC-83-24 の 4 — Bookmark のファイル・Recently Modified の行(契約 5【(d)(w)】)
// ---------------------------------------------------------------------------

describe('AC-83-24 (4): ファイルを開くときの root(契約 5 の表)', () => {
	it('Bookmark のファイルが今の root の下 → set_root を呼ばず open_document(そのファイル) → onOpened(null, doc)', async () => {
		const { confirmDiscard, onOpened } = await mountDashboard({ currentRoot: AURORA });
		invokeMock.mockClear();

		await fireEvent.click(tileOf(PLAN));
		await settle();

		expect(confirmDiscard).toHaveBeenCalledTimes(1);
		expect(callsOf('set_root')).toHaveLength(0);
		expect(argsOf('open_document')).toEqual([{ uri: PLAN }]);
		expect(onOpened).toHaveBeenCalledTimes(1);
		expect(onOpened.mock.calls[0]?.[0]).toBeNull();
		expect(onOpened.mock.calls[0]?.[1]).toMatchObject({ uri: PLAN });
	});

	it('今の root が末尾 / つきでも「下」(file:///Users/x/aurora/ の下の plan.md)→ set_root を呼ばない', async () => {
		const { onOpened } = await mountDashboard({ currentRoot: `${AURORA}/` });
		invokeMock.mockClear();
		await fireEvent.click(tileOf(PLAN));
		await settle();
		expect(callsOf('set_root')).toHaveLength(0);
		expect(argsOf('open_document')).toEqual([{ uri: PLAN }]);
		expect(onOpened).toHaveBeenCalledTimes(1);
	});

	it('Bookmark のファイルが今の root の外 → set_root(親フォルダ) の後に open_document → onOpened(root, doc)', async () => {
		const { onOpened } = await mountDashboard({ currentRoot: 'file:///Users/x/other' });
		invokeMock.mockClear();

		await fireEvent.click(tileOf(PLAN));
		await settle();

		expect(argsOf('set_root')).toEqual([{ uri: AURORA }]);
		expect(argsOf('open_document')).toEqual([{ uri: PLAN }]);
		expect(commandSequence('set_root', 'open_document')).toEqual(['set_root', 'open_document']);
		expect(onOpened).toHaveBeenCalledTimes(1);
		expect(onOpened.mock.calls[0]?.[0]).toMatchObject({ root_uri: AURORA });
		expect(onOpened.mock.calls[0]?.[1]).toMatchObject({ uri: PLAN });
	});

	it('今の root が無い(currentRoot: null=起動時の仮の root は数えない)→ set_root(親フォルダ) の後に open_document', async () => {
		const { onOpened } = await mountDashboard({ currentRoot: null });
		invokeMock.mockClear();
		await fireEvent.click(tileOf(PLAN));
		await settle();
		expect(argsOf('set_root')).toEqual([{ uri: AURORA }]);
		expect(argsOf('open_document')).toEqual([{ uri: PLAN }]);
		expect(commandSequence('set_root', 'open_document')).toEqual(['set_root', 'open_document']);
		expect(onOpened).toHaveBeenCalledTimes(1);
	});

	it('Recently Modified の行 → set_root(見つけた元のフォルダ) の後に open_document(そのファイル) → onOpened(root, doc)', async () => {
		scanResponse = async (generation) => ({ generation, files: [F3, F1], folders: 2, truncated: false });
		const { confirmDiscard, onOpened } = await mountDashboard({ currentRoot: AURORA });
		invokeMock.mockClear();

		await fireEvent.click(modifiedRows()[0]!);
		await settle();

		expect(confirmDiscard).toHaveBeenCalledTimes(1);
		expect(argsOf('set_root')).toEqual([{ uri: F3.folder }]);
		expect(argsOf('open_document')).toEqual([{ uri: F3.uri }]);
		expect(commandSequence('set_root', 'open_document')).toEqual(['set_root', 'open_document']);
		expect(onOpened).toHaveBeenCalledTimes(1);
		expect(onOpened.mock.calls[0]?.[0]).toMatchObject({ root_uri: F3.folder });
		expect(onOpened.mock.calls[0]?.[1]).toMatchObject({ uri: F3.uri });

		// 元のフォルダが今の root と同じ行 → set_root を呼ばず文書だけ。
		invokeMock.mockClear();
		await fireEvent.click(modifiedRows()[1]!);
		await settle();
		expect(callsOf('set_root')).toHaveLength(0);
		expect(argsOf('open_document')).toEqual([{ uri: F1.uri }]);
	});

	it('Bookmark のフォルダ → set_root(そのフォルダ)・文書は開かない。今の root と同じフォルダ → set_root を呼ばず、確認なしで onOpened(null, null)(閉じるだけ=(w))', async () => {
		const { confirmDiscard, onOpened } = await mountDashboard({ currentRoot: 'file:///Users/x/other' });
		invokeMock.mockClear();

		await fireEvent.click(tileOf(AURORA));
		await settle();
		expect(argsOf('set_root')).toEqual([{ uri: AURORA }]);
		expect(callsOf('open_document')).toHaveLength(0);
		expect(onOpened).toHaveBeenCalledTimes(1);
		expect(onOpened.mock.calls[0]?.[0]).toMatchObject({ root_uri: AURORA });
		expect(onOpened.mock.calls[0]?.[1]).toBeNull();

		cleanup();
		const second = await mountDashboard({ currentRoot: `${AURORA}/` });
		invokeMock.mockClear();
		await fireEvent.click(tileOf(AURORA));
		await settle();
		expect(callsOf('set_root')).toHaveLength(0);
		expect(callsOf('open_document')).toHaveLength(0);
		expect(second.confirmDiscard).not.toHaveBeenCalled();
		expect(second.onOpened).toHaveBeenCalledTimes(1);
		expect(second.onOpened.mock.calls[0]).toEqual([null, null]);
		expect(confirmDiscard).toHaveBeenCalledTimes(1);
	});

	it('右クリックの Open も押したときと同じ列(契約 14)', async () => {
		const { onOpened } = await mountDashboard({ currentRoot: 'file:///Users/x/other' });
		invokeMock.mockClear();
		await rightClick(tileOf(PLAN));
		await clickItem('Open');
		expect(argsOf('set_root')).toEqual([{ uri: AURORA }]);
		expect(argsOf('open_document')).toEqual([{ uri: PLAN }]);
		expect(onOpened).toHaveBeenCalledTimes(1);

		invokeMock.mockClear();
		await rightClick(recentRowOf(HISTORY[3]!));
		await clickItem('Open');
		expect(argsOf('set_root')).toEqual([{ uri: HISTORY[3] }]);
		expect(onOpened).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// AC-83-24 の 5 — 開けなかったとき(契約 5【(aa)】)
// ---------------------------------------------------------------------------

describe('AC-83-24 (5): set_root が reject → Could not open the folder: … の注記(role="alert")が出て Dashboard のまま', () => {
	it('Recent Folders の行で set_root が reject → 注記に理由・onOpened は呼ばれない・alert は出ない・行は残る', async () => {
		setRootResponse = new Error('No such file or directory (os error 2)');
		const { onOpened, onClose } = await mountDashboard();
		invokeMock.mockClear();

		await fireEvent.click(recentRowOf(GONE_FOLDER));
		await settle();

		expect(argsOf('set_root')).toEqual([{ uri: GONE_FOLDER }]);
		const note = document.querySelector('[role="alert"]');
		expect(note).not.toBeNull();
		expect(textOf(note).startsWith('Could not open the folder: ')).toBe(true);
		expect(textOf(note)).toContain('No such file or directory (os error 2)');
		expect(onOpened).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
		expect(alertMock).not.toHaveBeenCalled();
		expect(recentRows().some((r) => r.title === GONE_FOLDER)).toBe(true);
		expect(callsOf('open_document')).toHaveLength(0);
	});

	it('Bookmark のファイル(root の外)で set_root が reject → 文書は開きに行かず、注記は Could not open the folder: …', async () => {
		setRootResponse = new Error('Permission denied (os error 13)');
		const { onOpened } = await mountDashboard({ currentRoot: 'file:///Users/x/other' });
		invokeMock.mockClear();

		await fireEvent.click(tileOf(PLAN));
		await settle();

		expect(argsOf('set_root')).toEqual([{ uri: AURORA }]);
		expect(callsOf('open_document')).toHaveLength(0);
		expect(textOf(document.querySelector('[role="alert"]')).startsWith('Could not open the folder: ')).toBe(true);
		expect(onOpened).not.toHaveBeenCalled();
		expect(tiles().some((t) => t.title === PLAN), 'the bookmark is not removed').toBe(true);
	});

	it('root を替えずに文書だけ reject(今の root の下の Bookmark)→ 注記は Could not open the file: …・Dashboard のまま・onOpened なし', async () => {
		openDocResponse = new Error('invalid UTF-8');
		const { onOpened } = await mountDashboard({ currentRoot: AURORA });
		invokeMock.mockClear();

		await fireEvent.click(tileOf(PLAN));
		await settle();

		expect(callsOf('set_root')).toHaveLength(0);
		expect(argsOf('open_document')).toEqual([{ uri: PLAN }]);
		const note = document.querySelector('[role="alert"]');
		expect(textOf(note).startsWith('Could not open the file: ')).toBe(true);
		expect(textOf(note)).toContain('invalid UTF-8');
		expect(onOpened).not.toHaveBeenCalled();
		expect(alertMock).not.toHaveBeenCalled();
	});

	it("root を替えた後に文書だけ reject → onOpened(root, null) 1 回と alert('Could not open the file: …') 1 回(注記は出さない)【(aa)】", async () => {
		openDocResponse = new Error('invalid UTF-8');
		const { onOpened } = await mountDashboard({ currentRoot: 'file:///Users/x/other' });
		invokeMock.mockClear();

		await fireEvent.click(tileOf(PLAN));
		await settle();

		expect(argsOf('set_root')).toEqual([{ uri: AURORA }]);
		expect(argsOf('open_document')).toEqual([{ uri: PLAN }]);
		expect(onOpened).toHaveBeenCalledTimes(1);
		expect(onOpened.mock.calls[0]?.[0]).toMatchObject({ root_uri: AURORA });
		expect(onOpened.mock.calls[0]?.[1]).toBeNull();
		expect(alertMock).toHaveBeenCalledTimes(1);
		const message = String(alertMock.mock.calls[0]?.[0]);
		expect(message.startsWith('Could not open the file: ')).toBe(true);
		expect(message).toContain('invalid UTF-8');
		expect(document.querySelector('[role="alert"]')).toBeNull();
	});

	it('注記が出た後に別の行を押して開けたら注記は消える', async () => {
		setRootResponse = new Error('No such file or directory (os error 2)');
		const { onOpened } = await mountDashboard();
		await fireEvent.click(recentRowOf(GONE_FOLDER));
		await settle();
		expect(document.querySelector('[role="alert"]')).not.toBeNull();

		setRootResponse = (uri) => ({ root_uri: uri, entries: [], document_retained: false });
		await fireEvent.click(recentRowOf(HISTORY[3]!));
		await settle();
		expect(onOpened).toHaveBeenCalledTimes(1);
		expect(document.querySelector('[role="alert"]')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC-83-24 の 6 — Add Bookmark…(契約 7【(ac)】)
// ---------------------------------------------------------------------------

describe('AC-83-24 (6): Add Bookmark… → Add Folder… / Add File… → OS のダイアログ → add_bookmark', () => {
	it("Add Folder… → open が directory: true・題 'Add Bookmark' で 1 回 → add_bookmark(file://<選んだパス>・'folder') が 1 回", async () => {
		await mountDashboard();
		openDialogMock.mockResolvedValueOnce('/Users/x/picked');

		await fireEvent.click(addTile());
		await tick();
		expect(menuCount()).toBe(1);
		expect(menuLabels()).toEqual(['Add Folder…', 'Add File…']);
		expect(separatorCount()).toBe(0);

		await clickItem('Add Folder…');

		expect(openDialogMock).toHaveBeenCalledTimes(1);
		expect(openDialogMock.mock.calls[0]?.[0]).toMatchObject({ directory: true, title: 'Add Bookmark' });
		expect(callsOf('add_bookmark')).toHaveLength(1);
		expect(argsOf('add_bookmark')[0]).toEqual({ uri: 'file:///Users/x/picked', kind: 'folder' });
		expect(contextMenu.open).toBe(false);
		expect(alertMock).not.toHaveBeenCalled();
	});

	it("Add File… → open が directory: false で 1 回 → add_bookmark(file://<選んだパス>・'file')", async () => {
		await mountDashboard();
		openDialogMock.mockResolvedValueOnce('/Users/x/picked/a.md');

		await fireEvent.click(addTile());
		await tick();
		await clickItem('Add File…');

		expect(openDialogMock).toHaveBeenCalledTimes(1);
		expect(openDialogMock.mock.calls[0]?.[0]).toMatchObject({ directory: false, title: 'Add Bookmark' });
		expect(argsOf('add_bookmark')).toEqual([{ uri: 'file:///Users/x/picked/a.md', kind: 'file' }]);
	});

	it('取消(null)→ add_bookmark を呼ばない', async () => {
		await mountDashboard();
		openDialogMock.mockResolvedValueOnce(null);

		await fireEvent.click(addTile());
		await tick();
		await clickItem('Add Folder…');

		expect(openDialogMock).toHaveBeenCalledTimes(1);
		expect(callsOf('add_bookmark')).toHaveLength(0);
	});

	it('Add Bookmark… のタイルの右クリックにはメニューを出さない', async () => {
		await mountDashboard();
		await rightClick(addTile());
		expect(menuCount()).toBe(0);
		expect(contextMenu.open).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC-83-24 の 7 — タイルの右クリック(契約 14【(ae)】・契約 8)
// ---------------------------------------------------------------------------

describe('AC-83-24 (7): タイルの右クリック → 契約 14 の項目 → Move Down / Unpin from Bookmarks', () => {
	it('項目は Open・Open in New Window / Move Up・Move Down / Unpin from Bookmarks(区切り 2)。先頭は Move Up 無効', async () => {
		await mountDashboard();

		await rightClick(tileOf(AURORA));
		expect(menuCount()).toBe(1);
		expect(menuLabels()).toEqual(['Open', 'Open in New Window', 'Move Up', 'Move Down', 'Unpin from Bookmarks']);
		expect(separatorCount()).toBe(2);
		expect(menuItem('Move Up').disabled).toBe(true);
		expect(menuItem('Move Down').disabled).toBe(false);
		expect(menuItem('Unpin from Bookmarks').disabled).toBe(false);
	});

	it('末尾のタイルは Move Down 無効', async () => {
		await mountDashboard();
		await rightClick(tileOf(SSH_FOLDER));
		expect(menuItem('Move Down').disabled).toBe(true);
		expect(menuItem('Move Up').disabled).toBe(false);
	});

	it('Move Down → move_bookmark(その URI・index + 1) が 1 回・メニューが閉じる', async () => {
		await mountDashboard();
		await rightClick(tileOf(AURORA));
		await clickItem('Move Down');
		expect(argsOf('move_bookmark')).toEqual([{ uri: AURORA, to: 1 }]);
		expect(contextMenu.open).toBe(false);

		await rightClick(tileOf(SSH_FOLDER));
		await clickItem('Move Up');
		expect(argsOf('move_bookmark')).toEqual([
			{ uri: AURORA, to: 1 },
			{ uri: SSH_FOLDER, to: 1 },
		]);
	});

	it('Unpin from Bookmarks → remove_bookmark(その URI) が 1 回(確認なし)', async () => {
		await mountDashboard();
		await rightClick(tileOf(PLAN));
		await clickItem('Unpin from Bookmarks');
		expect(argsOf('remove_bookmark')).toEqual([{ uri: PLAN }]);
		expect(callsOf('move_bookmark')).toHaveLength(0);
		expect(contextMenu.open).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC-83-24 の 8 — 掴み手のドラッグ(契約 8【(f)(af)】)
// ---------------------------------------------------------------------------

describe('AC-83-24 (8): 掴み手の pointer のドラッグ', () => {
	const TILE_W = 100;

	/** タイルの rect を横一列に差し、`document.elementFromPoint` も同じ値で答える。 */
	function layoutTiles() {
		const all = [...tiles(), addTile()];
		all.forEach((tile, i) => {
			const rect = { x: i * TILE_W, y: 0, left: i * TILE_W, right: (i + 1) * TILE_W, top: 0, bottom: 50, width: TILE_W, height: 50, toJSON: () => ({}) };
			tile.getBoundingClientRect = () => rect as DOMRect;
			for (const child of tile.querySelectorAll<HTMLElement>('*')) child.getBoundingClientRect = () => rect as DOMRect;
		});
		document.elementFromPoint = (x: number, y: number) => {
			if (y < 0 || y > 50) return null;
			return all[Math.floor(x / TILE_W)] ?? null;
		};
	}

	beforeEach(() => {
		const proto = Element.prototype as unknown as Record<string, unknown>;
		if (typeof proto['setPointerCapture'] !== 'function') proto['setPointerCapture'] = () => {};
		if (typeof proto['releasePointerCapture'] !== 'function') proto['releasePointerCapture'] = () => {};
		if (typeof proto['hasPointerCapture'] !== 'function') proto['hasPointerCapture'] = () => false;
	});

	const pointer = (x: number, y = 25) => ({ clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, isPrimary: true });
	const gripOf = (uri: string) => {
		const grip = tileOf(uri).querySelector<HTMLElement>('.bookmark-grip');
		expect(grip, `tile ${uri} has a grip`).not.toBeNull();
		return grip!;
	};

	it('1 枚目の掴み手を押して 3 枚目の上で離す → move_bookmark(その URI・2) が 1 回', async () => {
		await mountDashboard();
		layoutTiles();
		const grip = gripOf(AURORA);

		await fireEvent.pointerDown(grip, pointer(10));
		await fireEvent.pointerMove(grip, pointer(30));
		await fireEvent.pointerMove(grip, pointer(250));
		await fireEvent.pointerUp(grip, { ...pointer(250), buttons: 0 });
		await settle();

		expect(argsOf('move_bookmark')).toEqual([{ uri: AURORA, to: 2 }]);
		expect(alertMock).not.toHaveBeenCalled();
	});

	it('途中で Escape → 呼ばない(onClose も呼ばない=Escape はドラッグをやめるだけ)', async () => {
		const { onClose } = await mountDashboard();
		layoutTiles();
		const grip = gripOf(AURORA);

		await fireEvent.pointerDown(grip, pointer(10));
		await fireEvent.pointerMove(grip, pointer(30));
		await fireEvent.pointerMove(grip, pointer(150));
		await fireEvent.keyDown(grip, { key: 'Escape' });
		await fireEvent.pointerUp(grip, { ...pointer(250), buttons: 0 });
		await settle();

		expect(callsOf('move_bookmark')).toHaveLength(0);
		expect(onClose).not.toHaveBeenCalled();
	});

	it('タイルの本体から動かしても始まらない・動かずに離しても何もしない', async () => {
		await mountDashboard();
		layoutTiles();
		const tile = tileOf(AURORA);

		await fireEvent.pointerDown(tile, pointer(60));
		await fireEvent.pointerMove(tile, pointer(90));
		await fireEvent.pointerMove(tile, pointer(250));
		await fireEvent.pointerUp(tile, { ...pointer(250), buttons: 0 });
		await settle();
		expect(callsOf('move_bookmark')).toHaveLength(0);

		const grip = gripOf(AURORA);
		await fireEvent.pointerDown(grip, pointer(10));
		await fireEvent.pointerMove(grip, pointer(12));
		await fireEvent.pointerUp(grip, { ...pointer(12), buttons: 0 });
		await settle();
		expect(callsOf('move_bookmark')).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// AC-83-24 の 9 — キーボード(契約 8・13【(af)(am)】)
// ---------------------------------------------------------------------------

describe('AC-83-24 (9): キーボード', () => {
	it('Return で開く(フォーカス中のタイル → 押したときと同じ列)。Space も同じ。行の区画でも Return で開く', async () => {
		const user = userEvent.setup();
		const { onOpened } = await mountDashboard({ currentRoot: 'file:///Users/x/other' });
		invokeMock.mockClear();
		expect(document.activeElement).toBe(tileOf(AURORA));

		await user.keyboard('{Enter}');
		await settle();
		expect(argsOf('set_root')).toEqual([{ uri: AURORA }]);
		expect(callsOf('open_document')).toHaveLength(0);
		expect(onOpened).toHaveBeenCalledTimes(1);

		invokeMock.mockClear();
		await fireEvent.keyDown(tileOf(AURORA), { key: 'ArrowRight' });
		await tick();
		expect(document.activeElement).toBe(tileOf(PLAN));
		await user.keyboard(' ');
		await settle();
		expect(argsOf('set_root')).toEqual([{ uri: AURORA }]);
		expect(argsOf('open_document')).toEqual([{ uri: PLAN }]);
		expect(onOpened).toHaveBeenCalledTimes(2);

		invokeMock.mockClear();
		await user.tab();
		expect((document.activeElement as HTMLElement).classList.contains('recent-folder')).toBe(true);
		await user.keyboard('{Enter}');
		await settle();
		expect(argsOf('set_root')).toEqual([{ uri: HISTORY[0] }]);
		expect(onOpened).toHaveBeenCalledTimes(3);
	});

	it('→ でフォーカスが次のタイルへ・← で戻る・端で止まる', async () => {
		await mountDashboard();
		expect(document.activeElement).toBe(tileOf(AURORA));

		await fireEvent.keyDown(tileOf(AURORA), { key: 'ArrowRight' });
		await tick();
		expect(document.activeElement).toBe(tileOf(PLAN));

		await fireEvent.keyDown(tileOf(PLAN), { key: 'ArrowLeft' });
		await tick();
		expect(document.activeElement).toBe(tileOf(AURORA));

		await fireEvent.keyDown(tileOf(AURORA), { key: 'ArrowLeft' });
		await tick();
		expect(document.activeElement).toBe(tileOf(AURORA));
		expect(callsOf('move_bookmark')).toHaveLength(0);
	});

	it('Option + → で move_bookmark(その URI・index + 1)・Option + ← で index − 1・先頭の Option + ← は呼ばない', async () => {
		await mountDashboard();

		await fireEvent.keyDown(tileOf(AURORA), { key: 'ArrowRight' });
		await tick();
		await fireEvent.keyDown(tileOf(PLAN), { key: 'ArrowRight', altKey: true });
		await settle();
		expect(argsOf('move_bookmark')).toEqual([{ uri: PLAN, to: 2 }]);

		await fireEvent.keyDown(tileOf(PLAN), { key: 'ArrowLeft', altKey: true });
		await settle();
		expect(argsOf('move_bookmark')).toEqual([
			{ uri: PLAN, to: 2 },
			{ uri: PLAN, to: 0 },
		]);

		// 先頭へ戻してから(一覧は event が来るまで変わらないので PLAN は index 1 のまま)。
		await fireEvent.keyDown(tileOf(PLAN), { key: 'ArrowLeft' });
		await tick();
		expect(document.activeElement).toBe(tileOf(AURORA));
		await fireEvent.keyDown(tileOf(AURORA), { key: 'ArrowLeft', altKey: true });
		await settle();
		expect(callsOf('move_bookmark')).toHaveLength(2);
	});

	it('Tab で Recent Folders の区画へ(区画で 1 つの止まり先=roving tabindex)。区画の中は矢印', async () => {
		await mountDashboard();
		const user = userEvent.setup();
		expect(document.activeElement).toBe(tileOf(AURORA));

		expect(tiles().filter((t) => t.tabIndex === 0), 'one tab stop among the tiles').toHaveLength(1);
		expect(recentRows().filter((r) => r.tabIndex === 0), 'one tab stop among the recent rows').toHaveLength(1);

		await user.tab();
		const landed = document.activeElement as HTMLElement;
		expect(landed.classList.contains('recent-folder'), `Tab lands in Recent Folders (got ${landed.outerHTML.slice(0, 80)})`).toBe(true);
		expect(landed.title).toBe(HISTORY[0]);

		await fireEvent.keyDown(landed, { key: 'ArrowDown' });
		await tick();
		expect((document.activeElement as HTMLElement).title).toBe(HISTORY[1]);

		await user.tab();
		expect(textOf(document.activeElement)).toBe('Show All');
	});
});

// ---------------------------------------------------------------------------
// AC-83-24 の 10 — 走査と世代(契約 12【(aj)(al)】)
// ---------------------------------------------------------------------------

describe('AC-83-24 (10): scan_recently_modified と recently_modified_progress', () => {
	it('マウントで 1 回(世代つき)。同じ世代の知らせで行が新しい順に出る・別の世代は当たらない・truncated の知らせ・Rescan で新しい世代', async () => {
		const first = deferred<Scan>();
		scanResponse = () => first.promise;
		await mountDashboard();

		expect(callsOf('scan_recently_modified')).toHaveLength(1);
		const generation = Number(argsOf('scan_recently_modified')[0]?.generation);
		expect(Number.isFinite(generation)).toBe(true);
		expect(modifiedRows()).toHaveLength(0);
		expect(textOf(section('recently-modified'))).toContain('Scanning…');

		emit('recently_modified_progress', { generation, files: [F1, F2], folders: 2, truncated: false } satisfies Scan);
		await settle();
		expect(modifiedRows().map((r) => r.title)).toEqual([F1.uri, F2.uri]);
		expect(textOf(section('recently-modified'))).not.toContain('Scanning…');
		expect(textOf(section('recently-modified'))).toContain('in 2 folders');
		expect(textOf(modifiedRows()[0]!)).toContain('a.html');
		expect(textOf(modifiedRows()[0]!)).toContain('aurora');

		emit('recently_modified_progress', { generation: generation + 1000, files: [F3], folders: 9, truncated: false } satisfies Scan);
		await settle();
		expect(modifiedRows().map((r) => r.title), 'another generation is ignored').toEqual([F1.uri, F2.uri]);

		first.resolve({ generation, files: [F1, F2, F3], folders: 3, truncated: true });
		await settle();
		expect(modifiedRows().map((r) => r.title)).toEqual([F1.uri, F2.uri, F3.uri]);
		expect(textOf(section('recently-modified'))).toContain('in 3 folders');
		expect(textOf(section('recently-modified'))).toContain('Partial results: the scan stopped after 2 seconds');

		const second = deferred<Scan>();
		scanResponse = () => second.promise;
		const rescan = document.querySelector<HTMLButtonElement>('button[aria-label="Rescan"]');
		expect(rescan).not.toBeNull();
		await fireEvent.click(rescan!);
		await settle();
		expect(callsOf('scan_recently_modified')).toHaveLength(2);
		const generation2 = Number(argsOf('scan_recently_modified')[1]?.generation);
		expect(generation2).not.toBe(generation);

		// 古い世代の知らせはもう当たらない。
		emit('recently_modified_progress', { generation, files: [F3], folders: 1, truncated: false } satisfies Scan);
		await settle();
		expect(modifiedRows().map((r) => r.title)).toEqual([F1.uri, F2.uri, F3.uri]);

		second.resolve({ generation: generation2, files: [F2], folders: 2, truncated: false });
		await settle();
		expect(modifiedRows().map((r) => r.title)).toEqual([F2.uri]);
		expect(textOf(section('recently-modified'))).not.toContain('Partial results');
	});

	it("終わって何も無い → 'No recently modified files'・対象のフォルダが無い → 'No folders to scan'", async () => {
		scanResponse = async (generation) => ({ generation, files: [], folders: 2, truncated: false });
		await mountDashboard();
		expect(textOf(section('recently-modified'))).toContain('No recently modified files');
		cleanup();

		scanResponse = async (generation) => ({ generation, files: [], folders: 0, truncated: false });
		await mountDashboard();
		expect(textOf(section('recently-modified'))).toContain('No folders to scan');
	});

	it('Recently Modified の行の右クリックにはメニューを出さない', async () => {
		scanResponse = async (generation) => ({ generation, files: [F1], folders: 1, truncated: false });
		await mountDashboard();
		expect(modifiedRows()).toHaveLength(1);
		await rightClick(modifiedRows()[0]!);
		expect(menuCount()).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// AC-83-24 の 11 — Recent Folders の行の右クリック(契約 10・14)
// ---------------------------------------------------------------------------

describe('AC-83-24 (11): Recent Folders の行の右クリック → Remove from Recent Folders', () => {
	it('項目は Open・Open in New Window / Pin to Bookmarks / Remove from Recent Folders(区切り 2)。Bookmark 済みの行は Unpin', async () => {
		await mountDashboard();

		await rightClick(recentRowOf(GONE_FOLDER));
		expect(menuLabels()).toEqual(['Open', 'Open in New Window', 'Pin to Bookmarks', 'Remove from Recent Folders']);
		expect(separatorCount()).toBe(2);

		await rightClick(recentRowOf(AURORA));
		expect(menuLabels()).toEqual(['Open', 'Open in New Window', 'Unpin from Bookmarks', 'Remove from Recent Folders']);
	});

	it('Remove from Recent Folders → remove_history_entry(その URI) が 1 回・その行が消える(確認なし)', async () => {
		await mountDashboard();

		await rightClick(recentRowOf(GONE_FOLDER));
		await clickItem('Remove from Recent Folders');

		expect(argsOf('remove_history_entry')).toEqual([{ uri: GONE_FOLDER }]);
		expect(recentRows().some((r) => r.title === GONE_FOLDER)).toBe(false);
		expect(recentRows()).toHaveLength(6);
		expect(textOf(section('recent-folders'))).toContain('6 of 13');
		expect(contextMenu.open).toBe(false);
		expect(callsOf('remove_bookmark')).toHaveLength(0);
	});

	it("Pin to Bookmarks → add_bookmark(その URI・'folder')", async () => {
		await mountDashboard();
		await rightClick(recentRowOf(GONE_FOLDER));
		await clickItem('Pin to Bookmarks');
		expect(argsOf('add_bookmark')).toEqual([{ uri: GONE_FOLDER, kind: 'folder' }]);
	});
});

// ---------------------------------------------------------------------------
// AC-83-24 の 12 — bookmarks_changed(契約 9【(ap)】)
// ---------------------------------------------------------------------------

describe('AC-83-24 (12): bookmarks_changed が届くとタイルが描き直される', () => {
	it('一覧が 2 件に替わる → タイルが 2 枚・件数 2・見つからないかを確かめ直す', async () => {
		await mountDashboard();
		invokeMock.mockClear();

		const next: Bookmark[] = [
			{ uri: 'file:///Users/x/other', kind: 'folder' },
			{ uri: PLAN, kind: 'file' },
		];
		emit('bookmarks_changed', next);
		await settle();

		expect(tiles().map((t) => t.title)).toEqual(['file:///Users/x/other', PLAN]);
		expect(textOf(section('bookmarks').querySelector('.count'))).toBe('2');
		expect(tileOf(PLAN).classList.contains('missing')).toBe(true);
		expect(callsOf('list_missing_paths').length, 'missing is re-checked when the list changes').toBeGreaterThanOrEqual(1);
	});
});

// ---------------------------------------------------------------------------
// AC-83-24 の 13 — Escape の順(契約 4)
// ---------------------------------------------------------------------------

describe('AC-83-24 (13): Escape', () => {
	it('メニューが開いているときの Escape はメニューを閉じるだけ(onClose は呼ばれない)。もう一度 Escape → onClose が 1 回', async () => {
		const { onClose } = await mountDashboard();

		await rightClick(tileOf(AURORA));
		expect(menuCount()).toBe(1);

		await fireEvent.keyDown(window, { key: 'Escape' });
		await tick();
		expect(menuCount()).toBe(0);
		expect(contextMenu.open).toBe(false);
		expect(onClose).not.toHaveBeenCalled();

		await fireEvent.keyDown(window, { key: 'Escape' });
		await tick();
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('IME の変換中(isComposing)の Escape は何もしない', async () => {
		const { onClose } = await mountDashboard();
		await fireEvent.keyDown(window, { key: 'Escape', isComposing: true });
		await tick();
		expect(onClose).not.toHaveBeenCalled();
	});
});
