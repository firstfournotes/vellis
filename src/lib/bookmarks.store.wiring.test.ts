/**
 * 要件#83 の受け入れテスト(docs/requirements/req-83.md)— 窓の Bookmark のストア
 * (AC-83-21 のうち「ストア」=契約 9【(ap) 決定】。component プロジェクト= rune を使う `.svelte.ts` を読むため)
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * ```ts
 * // --- src/stores/bookmarks.svelte.ts(新規)
 * class BookmarksStore {
 *   /** 窓が知っている Bookmark の一覧(表示の順)。 *\/
 *   list = $state<Bookmark[]>([]);
 *   /** 起動時に 1 回: `list_bookmarks`(loadBookmarks)で読み、`bookmarks_changed` を listen して一覧を置き換える。
 *       2 回目以降は何もしない(購読を二重にしない)。 *\/
 *   init(): Promise<void>;
 * }
 * export const bookmarks = new BookmarksStore();
 * ```
 *
 * 判定: `init()` は `invoke('list_bookmarks')` を 1 回・`listen('bookmarks_changed', …)` を 1 回。読んだ一覧が `list` に入る。
 * event の payload(一覧)で `list` が置き換わる。2 回目の `init()` は invoke も listen も増やさない。
 * (`list_bookmarks` の失敗が [] になることは bookmarks.acceptance.test.ts の `loadBookmarks` が持つ=ストアは
 * それを呼ぶだけ。ストアは窓に 1 つの singleton なので、ここでは 1 本の it に順を追って書く)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('$lib/events', () => ({ listen: vi.fn() }));

import { invoke } from '$lib/ipc';
import { listen } from '$lib/events';
import type { Bookmark } from '$lib/bookmarks';
import { bookmarks } from '../stores/bookmarks.svelte';

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

type Handler = (e: { payload: Bookmark[] }) => void;
const handlers: Record<string, Handler[]> = {};

const INITIAL: Bookmark[] = [
	{ uri: 'file:///Users/x/aurora', kind: 'folder' },
	{ uri: 'file:///Users/x/aurora/plan.md', kind: 'file' },
];
const CHANGED: Bookmark[] = [
	{ uri: 'file:///Users/x/aurora/plan.md', kind: 'file' },
	{ uri: 'ssh://alice@host:22/srv/notes', kind: 'folder' },
	{ uri: 'file:///Users/x/other', kind: 'folder' },
];

beforeEach(() => {
	for (const k of Object.keys(handlers)) delete handlers[k];
	listenMock.mockImplementation(async (event, handler) => {
		(handlers[event] ??= []).push(handler as Handler);
		return () => {};
	});
});

const callsOf = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd);

describe('AC-83-21: stores/bookmarks.svelte の init()', () => {
	it('init() は list_bookmarks を 1 回・listen(bookmarks_changed) を 1 回。event の一覧で置き換える。2 回目の init() は何もしない', async () => {
		invokeMock.mockImplementation(async (cmd: string) => (cmd === 'list_bookmarks' ? INITIAL : null));

		expect(bookmarks.list).toEqual([]);
		await bookmarks.init();

		expect(callsOf('list_bookmarks')).toHaveLength(1);
		expect(listenMock).toHaveBeenCalledTimes(1);
		expect(listenMock.mock.calls[0]?.[0]).toBe('bookmarks_changed');
		expect(bookmarks.list).toEqual(INITIAL);

		for (const h of handlers['bookmarks_changed'] ?? []) h({ payload: CHANGED });
		expect(bookmarks.list).toEqual(CHANGED);

		await bookmarks.init();
		expect(callsOf('list_bookmarks'), 'the second init() does not read again').toHaveLength(1);
		expect(listenMock, 'the second init() does not subscribe again').toHaveBeenCalledTimes(1);
		expect(bookmarks.list).toEqual(CHANGED);

		for (const h of handlers['bookmarks_changed'] ?? []) h({ payload: [] });
		expect(bookmarks.list).toEqual([]);
	});
});
