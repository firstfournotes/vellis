/**
 * 要件#83 の受け入れテスト(docs/requirements/req-83.md)— 起動時の Dashboard のフォーカス
 * (AC-83-24 補(起動時のフォーカス)= 契約13【(o)(am)】の「開いたときは最初のタイル」「Bookmark が 0 件なら
 * `Add Bookmark…`」が、窓のストア(契約9)が読み終わる前に Dashboard が開く起動時にも成り立つこと。
 * component プロジェクト・`Dashboard.svelte` を JSDOM にマウントする= Dashboard.wiring.test.ts と同じ家風)
 *
 * 実機のゲート(2026-11-05)で見つかった不具合: 起動時の Dashboard は、ストアが `list_bookmarks` を読み終わる前に
 * マウントされる(`+page.svelte` の onMount の `void bookmarks.init()` と同じ周回で Dashboard が出る)。そのため
 * Dashboard の onMount の `tick().then(() => focusTile(0))` は、まだ空の一覧の 0 番目= `Add Bookmark…` にフォーカスを
 * 付け、あとから 6 件届いてもそのまま。Go ▸ Dashboard(ストアは読み込み済み)では最初のタイルに当たる。
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * ```ts
 * // --- src/stores/bookmarks.svelte.ts(足す)
 * class BookmarksStore {
 *   list = $state<Bookmark[]>([]);
 *   /** 最初の一覧が届いたか。`init()` の `list_bookmarks` が解決したとき、またはそれより先に `bookmarks_changed` が
 *       届いたときに true。以後 true のまま(`list_bookmarks` の失敗は loadBookmarks が [] にするのでやはり true)。
 *       `init()` を呼ぶ前と読んでいる間は false。 *\/
 *   loaded = $state(false); // 推奨名
 *   init(): Promise<void>;
 * }
 * ```
 *
 * Dashboard のフォーカス(契約13 の補): 開いたときのフォーカスは **ストアの最初の一覧が届いてから** 決める。
 * - マウント時に `loaded` なら今までどおり、tick の後に最初のタイル(0 件なら `Add Bookmark…`)
 * - マウント時に未読なら、`loaded` が true になったとき(`list_bookmarks` の解決でも `bookmarks_changed` でも)に
 *   最初のタイル(0 件なら `Add Bookmark…`)へ
 * - ただし、届いたときに利用者がすでに Bookmarks の区画の外へフォーカスを動かしていたら奪わない
 *   (= `document.activeElement` が `section.dashboard-bookmarks` の中でも body / null でもないとき。
 *   周回中の推奨の判断=2026-11-05)。区画の止まり先(`tabindex="0"`)は最初のタイルのまま
 * - 届く前のフォーカスの場所は決めない(このテストは見ない)
 * - 届いた一覧より先に `bookmarks_changed` が来ていたら、遅れて解決した `list_bookmarks` は捨てる(契約9 のまま)=
 *   フォーカスも動かさない
 *
 * ## 準備(Dashboard.wiring.test.ts の写し。違いは「未読のストア」の作り方)
 * ストアは窓(= モジュール)に 1 つで `init()` は 1 回きり(契約9)。未読のストアを it ごとに作るため、it ごとに
 * `vi.resetModules()` の後に動的 import で新しいストアと Dashboard を取る(svelte / testing-library / `$lib/ipc` /
 * `$lib/events` のモックも同じ graph から取り、runtime とモックの実体が食い違わないようにする)。testing-library の
 * 自動 cleanup は元の実体に付くので、afterEach で新しい実体の `cleanup()` を呼ぶ。
 * - $lib/ipc の invoke: command 名で応答(`installInvoke`)。`list_bookmarks` は各テストが deferred にできる
 * - $lib/events の listen: event 名ごとに handler を記録し、テストが起こす(ストアの `bookmarks_changed` と Dashboard の
 *   `recently_modified_progress`)
 * - ページと同じく `void bookmarks.init()`(待たない)で起動時の経路を作る
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ComponentProps } from 'svelte';

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

import type { Bookmark } from '$lib/bookmarks';
import type { DocumentPayload } from '../stores/window-state.svelte';

// ---------------------------------------------------------------------------
// フィクスチャ(Dashboard.wiring.test.ts と同じ)
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

type Scan = { generation: number; files: unknown[]; folders: number; truncated: boolean };
type RootPayload = { root_uri: string; entries: unknown[]; document_retained: boolean };

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

// ---------------------------------------------------------------------------
// it ごとに新しいモジュールの graph(未読のストアを作るため)
// ---------------------------------------------------------------------------

type Handler = (e: { payload: unknown }) => void;
const handlers: Record<string, Handler[]> = {};

async function loadFresh() {
	vi.resetModules();
	// 依存の順に 1 つずつ(同じ graph の実体を取る)。
	const ipc = await import('$lib/ipc');
	const events = await import('$lib/events');
	const svelte = await import('svelte');
	const stl = await import('@testing-library/svelte');
	const store = await import('../stores/bookmarks.svelte');
	const dashboard = await import('./Dashboard.svelte');
	return {
		invokeMock: vi.mocked(ipc.invoke),
		listenMock: vi.mocked(events.listen) as unknown as Mock<
			(event: string, handler: Handler) => Promise<() => void>
		>,
		tick: svelte.tick,
		render: stl.render,
		cleanup: stl.cleanup,
		bookmarks: store.bookmarks,
		Dashboard: dashboard.default,
	};
}
type Fresh = Awaited<ReturnType<typeof loadFresh>>;
let fresh: Fresh;

/** `list_bookmarks` の応答。各テストが差す(deferred にして「読んでいる間」を作る)。 */
let listBookmarksResponse: () => Promise<Bookmark[]> = async () => BOOKMARKS;
let history: string[] = [];

function installInvoke() {
	fresh.invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
		switch (cmd) {
			case 'set_root':
				return { root_uri: String(args?.uri), entries: [], document_retained: false } satisfies RootPayload;
			case 'open_document':
			case 'open_binary_document':
				return { uri: String(args?.uri), content: '# doc\n', modified: 1 } satisfies DocumentPayload;
			case 'list_history':
				return history;
			case 'list_bookmarks':
				return listBookmarksResponse();
			case 'list_missing_paths': {
				const uris = (args?.uris as string[] | undefined) ?? [];
				return uris.filter((u) => MISSING.has(u));
			}
			case 'scan_recently_modified': {
				const generation = Number(args?.generation);
				return { generation, files: [], folders: 2, truncated: false } satisfies Scan;
			}
			case 'add_bookmark':
			case 'remove_bookmark':
			case 'move_bookmark':
				return fresh.bookmarks.list;
			case 'remove_history_entry': {
				history = history.filter((u) => u !== String(args?.uri));
				return history;
			}
			default:
				return null;
		}
	});
}

const callsOf = (cmd: string) => fresh.invokeMock.mock.calls.filter((c) => c[0] === cmd);

const alertMock = vi.fn((_message?: unknown) => {});
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await fresh.tick();
	await flushAsync();
	await flushAsync();
	await fresh.tick();
}

function emit(event: string, payload: unknown) {
	const hs = handlers[event] ?? [];
	expect(hs.length, `someone subscribed to ${event}`).toBeGreaterThan(0);
	for (const h of hs) h({ payload });
}

type DashboardProps = ComponentProps<Fresh['Dashboard']>;

async function mountDashboard(extra: Partial<DashboardProps> = {}) {
	const onPickFolder = vi.fn();
	const onClose = vi.fn();
	const onOpened = vi.fn((_root: RootPayload | null, _doc: DocumentPayload | null) => {});
	const confirmDiscard = vi.fn(async () => true);
	const props: DashboardProps = {
		error: null,
		currentRoot: null,
		confirmDiscard,
		onOpened,
		onClose,
		onPickFolder,
		...extra,
	};
	const result = fresh.render(fresh.Dashboard, { props });
	await settle();
	await settle();
	return { ...result, onPickFolder, onClose, onOpened, confirmDiscard };
}

/**
 * 起動時と同じ経路: ページの onMount の `void bookmarks.init()`(待たない)。`list_bookmarks` は deferred のまま=
 * 購読は済み・一覧はまだ。戻り値の deferred を解決すると「読み終わる」。
 */
async function startInitPending(): Promise<Deferred<Bookmark[]>> {
	const lb = deferred<Bookmark[]>();
	listBookmarksResponse = () => lb.promise;
	void fresh.bookmarks.init();
	await settle();
	expect(callsOf('list_bookmarks'), 'init() started reading').toHaveLength(1);
	expect(handlers['bookmarks_changed']?.length ?? 0, 'init() subscribed before the read').toBe(1);
	return lb;
}

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
const section = (name: 'bookmarks' | 'recent-folders' | 'recently-modified') =>
	document.querySelector<HTMLElement>(`section.dashboard-${name}`)!;
const textOf = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

beforeEach(async () => {
	for (const k of Object.keys(handlers)) delete handlers[k];
	fresh = await loadFresh();
	fresh.listenMock.mockImplementation(async (event, handler) => {
		(handlers[event] ??= []).push(handler);
		return () => {};
	});
	history = [...HISTORY];
	listBookmarksResponse = async () => BOOKMARKS;
	installInvoke();
	alertMock.mockClear();
	vi.stubGlobal('alert', alertMock);
	expect(fresh.bookmarks.list, 'a fresh store per test').toEqual([]);
});

afterEach(() => {
	fresh.cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC-83-24 補(起動時のフォーカス)— 契約13 (o)(am) × 契約9 (ap)
// ---------------------------------------------------------------------------

describe('AC-83-24 補(起動時のフォーカス): ストアが読み終わる前に開いた Dashboard', () => {
	it('起動時の経路(init の list_bookmarks が後から解決)で 3 件届くと、最初のタイルにフォーカスが付く。ストアの loaded は false → true', async () => {
		const lb = await startInitPending();
		expect(fresh.bookmarks.loaded, 'loaded is false while list_bookmarks is in flight').toBe(false);

		await mountDashboard();
		expect(tiles(), 'nothing has arrived yet').toHaveLength(0);
		expect(fresh.bookmarks.loaded).toBe(false);

		lb.resolve(BOOKMARKS);
		await settle();

		expect(fresh.bookmarks.loaded, 'loaded turns true when list_bookmarks resolves').toBe(true);
		expect(tiles()).toHaveLength(3);
		expect(textOf(section('bookmarks').querySelector('.count'))).toBe('3');
		expect(document.activeElement, 'the first tile is focused once the list arrives').toBe(tileOf(AURORA));
		expect(tileOf(AURORA).tabIndex, 'the section stop is the first tile').toBe(0);
		expect(addTile().tabIndex).toBe(-1);
	});

	it('読んでいる間に bookmarks_changed で 3 件届いても最初のタイルにフォーカスが付く。遅れて解決した list_bookmarks は捨てられ、フォーカスも動かない', async () => {
		const lb = await startInitPending();
		await mountDashboard();
		expect(tiles()).toHaveLength(0);

		emit('bookmarks_changed', BOOKMARKS);
		await settle();

		expect(fresh.bookmarks.loaded, 'loaded turns true on the event that lands before the read').toBe(true);
		expect(tiles()).toHaveLength(3);
		expect(document.activeElement, 'the first tile is focused once the event lands').toBe(tileOf(AURORA));
		expect(tileOf(AURORA).tabIndex).toBe(0);

		// 契約9: 先に届いた event のほうが新しい。遅れた read は一覧もフォーカスも変えない。
		lb.resolve([]);
		await settle();
		expect(tiles(), 'the stale read is dropped').toHaveLength(3);
		expect(document.activeElement).toBe(tileOf(AURORA));
	});

	it('読んでいる間に開き、0 件が届いたら Add Bookmark… にフォーカス', async () => {
		const lb = await startInitPending();
		await mountDashboard();

		lb.resolve([]);
		await settle();

		expect(tiles()).toHaveLength(0);
		expect(textOf(section('bookmarks').querySelector('.count'))).toBe('0');
		expect(document.activeElement, 'Add Bookmark… is the only tile').toBe(addTile());
		expect(addTile().tabIndex).toBe(0);
	});

	it('読み終わる前に利用者が Recent Folders の行へフォーカスを動かしていたら、届いてもフォーカスを奪わない(止まり先は最初のタイル)', async () => {
		const lb = await startInitPending();
		await mountDashboard();
		expect(recentRows().length, 'the history is shown before the bookmarks arrive').toBeGreaterThan(0);

		recentRowOf(AURORA).focus();
		expect(document.activeElement).toBe(recentRowOf(AURORA));

		lb.resolve(BOOKMARKS);
		await settle();

		expect(tiles()).toHaveLength(3);
		expect(document.activeElement, 'the focus the user placed stays where it is').toBe(recentRowOf(AURORA));
		expect(section('bookmarks').contains(document.activeElement), 'the focus is still outside Bookmarks').toBe(false);
		expect(tileOf(AURORA).tabIndex, 'Tab back into Bookmarks lands on the first tile').toBe(0);
		expect(addTile().tabIndex).toBe(-1);
	});

	it('読み込み済みのストアで開いたとき(Go ▸ Dashboard の経路)は今までどおり最初のタイル(回帰)', async () => {
		listBookmarksResponse = async () => BOOKMARKS;
		await fresh.bookmarks.init();
		expect(fresh.bookmarks.list).toEqual(BOOKMARKS);

		await mountDashboard();

		expect(tiles()).toHaveLength(3);
		expect(document.activeElement).toBe(tileOf(AURORA));
		expect(tileOf(AURORA).tabIndex).toBe(0);
	});

	it('読み込み済みで 0 件のストアで開いたときは Add Bookmark…(回帰)', async () => {
		listBookmarksResponse = async () => [];
		await fresh.bookmarks.init();
		expect(fresh.bookmarks.list).toEqual([]);

		await mountDashboard();

		expect(tiles()).toHaveLength(0);
		expect(document.activeElement).toBe(addTile());
		expect(addTile().tabIndex).toBe(0);
	});
});
