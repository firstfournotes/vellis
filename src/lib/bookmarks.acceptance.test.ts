/**
 * 要件#83 の受け入れテスト(docs/requirements/req-83.md)— Bookmark の口・正規化・失敗の文言
 * (AC-83-21 のうち純関数と command の口=契約 7・9・16【(ad)(ap) 決定】)
 *
 * ストア(`stores/bookmarks.svelte` の `init()`)は Svelte 5 の rune を使うので unit プロジェクトでは動かない。
 * その判定は `src/lib/bookmarks.store.wiring.test.ts`(component プロジェクト)に置いた(test-writer の置き場の判断。
 * AC-83-21 の「ストア」の 1 文はそちらが持つ)。
 *
 * ## 確定契約(implementer はこれに従う=推奨名は req-83.md のもの・無いものは test-writer が固定)
 *
 * ```ts
 * // --- src/lib/bookmarks.ts(新規)
 * export const BOOKMARKS_CHANGED_EVENT = 'bookmarks_changed';     // Rust の bookmarks::BOOKMARKS_CHANGED_EVENT と同じ値
 * export const LIST_BOOKMARKS_COMMAND = 'list_bookmarks';
 * export const ADD_BOOKMARK_COMMAND = 'add_bookmark';
 * export const REMOVE_BOOKMARK_COMMAND = 'remove_bookmark';
 * export const MOVE_BOOKMARK_COMMAND = 'move_bookmark';
 * export type BookmarkKind = 'folder' | 'file';
 * export type Bookmark = { uri: string; kind: BookmarkKind };
 * // command の口(どれも `$lib/ipc` の invoke を 1 回)
 * export function loadBookmarks(): Promise<Bookmark[]>;                           // 失敗は [](reject しない)
 * export function addBookmark(uri: string, kind: BookmarkKind): Promise<Bookmark[]>;   // invoke('add_bookmark', { uri, kind })・失敗は reject
 * export function removeBookmark(uri: string): Promise<Bookmark[]>;              // invoke('remove_bookmark', { uri })
 * export function moveBookmark(uri: string, to: number): Promise<Bookmark[]>;    // invoke('move_bookmark', { uri, to })
 * // 正規化(Rust の history::normalize_uri の鏡)と済みの判定
 * export function normalizeBookmarkUri(uri: string): string;
 * export function isBookmarked(list: Bookmark[], uri: string): boolean;
 * // 失敗の文言(契約 7)
 * export function bookmarkSaveFailedMessage(err: unknown): string;               // 'Could not save the bookmarks: <err>'
 * ```
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));

import { invoke } from '$lib/ipc';
import {
	ADD_BOOKMARK_COMMAND,
	BOOKMARKS_CHANGED_EVENT,
	LIST_BOOKMARKS_COMMAND,
	MOVE_BOOKMARK_COMMAND,
	REMOVE_BOOKMARK_COMMAND,
	addBookmark,
	bookmarkSaveFailedMessage,
	isBookmarked,
	loadBookmarks,
	moveBookmark,
	normalizeBookmarkUri,
	removeBookmark,
	type Bookmark,
} from './bookmarks';

const invokeMock = vi.mocked(invoke);

const LIST: Bookmark[] = [
	{ uri: 'file:///Users/x/aurora', kind: 'folder' },
	{ uri: 'file:///Users/x/aurora/plan.md', kind: 'file' },
	{ uri: 'ssh://alice@host:22/srv/notes', kind: 'folder' },
];

beforeEach(() => {
	invokeMock.mockReset();
});

// ---------------------------------------------------------------------------
// 定数(契約 16)
// ---------------------------------------------------------------------------

describe('AC-83-21: 定数は Rust と同じ値', () => {
	test('event と command の名前', () => {
		expect(BOOKMARKS_CHANGED_EVENT).toBe('bookmarks_changed');
		expect(LIST_BOOKMARKS_COMMAND).toBe('list_bookmarks');
		expect(ADD_BOOKMARK_COMMAND).toBe('add_bookmark');
		expect(REMOVE_BOOKMARK_COMMAND).toBe('remove_bookmark');
		expect(MOVE_BOOKMARK_COMMAND).toBe('move_bookmark');
	});
});

// ---------------------------------------------------------------------------
// command の口(契約 16)
// ---------------------------------------------------------------------------

describe('AC-83-21: command の口は invoke を契約 16 の名前と引数で 1 回呼び、返った一覧を返す', () => {
	test("loadBookmarks() → invoke('list_bookmarks') が 1 回(引数なし)・返った一覧", async () => {
		invokeMock.mockResolvedValueOnce(LIST);
		await expect(loadBookmarks()).resolves.toEqual(LIST);
		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock.mock.calls[0]?.[0]).toBe('list_bookmarks');
		expect(invokeMock.mock.calls[0]?.[1] ?? undefined).toBeUndefined();
	});

	test('loadBookmarks() の失敗は [](reject しない)', async () => {
		invokeMock.mockRejectedValueOnce(new Error('no config dir'));
		await expect(loadBookmarks()).resolves.toEqual([]);
	});

	test("addBookmark(uri, kind) → invoke('add_bookmark', { uri, kind }) が 1 回・返った一覧", async () => {
		invokeMock.mockResolvedValueOnce(LIST);
		await expect(addBookmark('file:///Users/x/aurora/plan.md', 'file')).resolves.toEqual(LIST);
		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock).toHaveBeenCalledWith('add_bookmark', { uri: 'file:///Users/x/aurora/plan.md', kind: 'file' });

		invokeMock.mockResolvedValueOnce(LIST);
		await addBookmark('file:///Users/x/aurora', 'folder');
		expect(invokeMock).toHaveBeenLastCalledWith('add_bookmark', { uri: 'file:///Users/x/aurora', kind: 'folder' });
	});

	test("removeBookmark(uri) → invoke('remove_bookmark', { uri }) が 1 回・返った一覧", async () => {
		invokeMock.mockResolvedValueOnce(LIST.slice(0, 2));
		await expect(removeBookmark('ssh://alice@host:22/srv/notes')).resolves.toEqual(LIST.slice(0, 2));
		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock).toHaveBeenCalledWith('remove_bookmark', { uri: 'ssh://alice@host:22/srv/notes' });
	});

	test("moveBookmark(uri, to) → invoke('move_bookmark', { uri, to }) が 1 回・返った一覧", async () => {
		invokeMock.mockResolvedValueOnce(LIST);
		await expect(moveBookmark('file:///Users/x/aurora', 2)).resolves.toEqual(LIST);
		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock).toHaveBeenCalledWith('move_bookmark', { uri: 'file:///Users/x/aurora', to: 2 });
	});

	test('変える口(add / remove / move)の失敗は reject する(呼び手が alert)', async () => {
		invokeMock.mockRejectedValueOnce(new Error('disk full'));
		await expect(addBookmark('file:///x', 'folder')).rejects.toThrow('disk full');
		invokeMock.mockRejectedValueOnce(new Error('disk full'));
		await expect(removeBookmark('file:///x')).rejects.toThrow('disk full');
		invokeMock.mockRejectedValueOnce(new Error('disk full'));
		await expect(moveBookmark('file:///x', 0)).rejects.toThrow('disk full');
	});

	test('URI は変形せずそのまま渡す(正規化は Rust の持ち場)', async () => {
		invokeMock.mockResolvedValue([]);
		await addBookmark('file:///Users/x/My Docs/', 'folder');
		expect(invokeMock).toHaveBeenLastCalledWith('add_bookmark', { uri: 'file:///Users/x/My Docs/', kind: 'folder' });
	});
});

// ---------------------------------------------------------------------------
// 正規化と済みの判定(契約 7・9【(ad)】)
// ---------------------------------------------------------------------------

describe('AC-83-21: normalizeBookmarkUri は Rust の history::normalize_uri の鏡(AC-83-6 の 3 と同じ表)', () => {
	test.each([
		['file:///a/b/', 'file:///a/b'],
		['file:///a//b', 'file:///a/b'],
		['file:///a/b', 'file:///a/b'],
		['file:////a', 'file:///a'],
		['file:///', 'file:///'],
		['ssh://host', 'ssh://host/'],
		['ssh://host/', 'ssh://host/'],
		['ssh://host//', 'ssh://host/'],
		['ssh://alice@host:22/srv/notes/', 'ssh://alice@host:22/srv/notes'],
		['ssh://alice@host:22/srv//notes', 'ssh://alice@host:22/srv/notes'],
		['not a uri', 'not a uri'],
	])('%s → %s', (raw, expected) => {
		expect(normalizeBookmarkUri(raw)).toBe(expected);
	});

	test('空白や日本語は符号化しない', () => {
		expect(normalizeBookmarkUri('file:///Users/x/My Docs/')).toBe('file:///Users/x/My Docs');
		expect(normalizeBookmarkUri('file:///Users/x/資料//メモ')).toBe('file:///Users/x/資料/メモ');
	});
});

describe('AC-83-21: isBookmarked(list, uri) は正規化して比べる', () => {
	test('同じ綴り・末尾の /・二重の / のどれでも済み', () => {
		expect(isBookmarked(LIST, 'file:///Users/x/aurora')).toBe(true);
		expect(isBookmarked(LIST, 'file:///Users/x/aurora/')).toBe(true);
		expect(isBookmarked(LIST, 'file:///Users/x//aurora')).toBe(true);
		expect(isBookmarked(LIST, 'file:///Users/x/aurora/plan.md')).toBe(true);
		expect(isBookmarked(LIST, 'ssh://alice@host:22/srv/notes/')).toBe(true);
	});

	test('無いもの・前方一致だけのもの・空の一覧は済みでない', () => {
		expect(isBookmarked(LIST, 'file:///Users/x/aurora2')).toBe(false);
		expect(isBookmarked(LIST, 'file:///Users/x')).toBe(false);
		expect(isBookmarked(LIST, 'file:///Users/x/aurora/other.md')).toBe(false);
		expect(isBookmarked([], 'file:///Users/x/aurora')).toBe(false);
	});

	test('一覧の綴りが正規化されていなくても比べられる', () => {
		expect(isBookmarked([{ uri: 'file:///a/b/', kind: 'folder' }], 'file:///a//b')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 失敗の文言(契約 7【(al)】)
// ---------------------------------------------------------------------------

describe('AC-83-21: bookmarkSaveFailedMessage', () => {
	test("文字列エラー → 'Could not save the bookmarks: <err>'(値固定)", () => {
		expect(bookmarkSaveFailedMessage('boom')).toBe('Could not save the bookmarks: boom');
	});

	test('Error でも接頭辞は固定で、エラー内容を本文に含む', () => {
		const message = bookmarkSaveFailedMessage(new Error('disk full'));
		expect(message.startsWith('Could not save the bookmarks: ')).toBe(true);
		expect(message).toContain('disk full');
	});

	test('日本語(CJK)を含まない(エラー内容の素通し分は除く)', () => {
		expect(bookmarkSaveFailedMessage('x')).not.toMatch(/[　-〿぀-ヿ一-鿿＀-￯]/);
	});
});
