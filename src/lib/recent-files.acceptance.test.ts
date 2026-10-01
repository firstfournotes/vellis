/**
 * 要件#64 の受け入れテスト(docs/requirements/req-64.md)— フロントの純関数と VM(AC-64-12)
 * 「最近開いたファイルの履歴(Recent Files)。今の root 配下で開いたファイルを新しい順に
 *  最大 10 件出し、クリック一発で開ける」
 *
 * 判定範囲(本ファイル): `src/lib/recent-files.ts`(新規)の純関数と読み込み。
 * - イベント名(Rust の menu.rs と同じ値)・command 名・文言(英語=要件#51)
 * - `recentFileLabel(uri, root)`(ファイル名+root からの相対フォルダ。%エンコードしない)
 * - `ancestorDirs(uri, root)`(root を除く祖先フォルダの URI を浅い順に)
 * - `shouldShowRecentFiles(root, pickerOpen, findInFolderOpen)`
 * - `loadRecentFiles(root)`(command の失敗で `[]`・reject しない)
 * 開閉と高さの純関数は recent-files-section.acceptance.test.ts、区画の配線は
 * src/components/RecentFiles.wiring.test.ts、Rust 側は src-tauri/tests/acceptance_req64.rs。
 *
 * ## 確定契約(公開 API・implementer はこれに従う=test-writer 決定 2026-09-28)
 *
 * ```ts
 * // --- 新規 src/lib/recent-files.ts(Tauri は `$lib/ipc` の invoke だけ。ストレージに触れない)---
 * export const MENU_RECENT_FILES_EVENT = 'menu_recent_files';        // menu.rs と同じ値
 * export const LIST_RECENT_FILES_COMMAND = 'list_recent_files';      // invoke の第 1 引数
 * export const CLEAR_RECENT_FILES_COMMAND = 'clear_recent_files';
 * export const RECENT_FILES_TITLE = 'Recent Files';                  // 区画の見出し
 * export const RECENT_FILES_EMPTY_MESSAGE = 'No recent files';       // 0 件
 * export const RECENT_FILES_CLEAR_LABEL = 'Clear';                   // 見出し行のボタン
 * // 開くのに失敗したときの alert 文言(契約8)
 * export function recentFileOpenFailedMessage(err: unknown): string; // `Could not open the file: ${err}`
 *
 * export type RecentFileLabel = { name: string; folder: string };
 * // 文字列だけで作る(`new URL()` は使わない=root-picker.ts の labelFor と同じ理由)。
 * // root の末尾 `/` は 1 つ落として `/` を足した前方一致で相対部分を取る(Rust の is_under_root と同じ規則)。
 * // 例: ('file:///proj/docs/spec/a.md', 'file:///proj') → { name: 'a.md', folder: 'docs/spec' }。root 直下は folder ''。
 * export function recentFileLabel(uri: string, root: string): RecentFileLabel;
 *
 * // root を除く祖先フォルダの URI を浅い順に(末尾 `/` 無し・root 直下のファイルは [])。
 * // 例: ('file:///proj/a/b/c.md', 'file:///proj') → ['file:///proj/a', 'file:///proj/a/b']
 * export function ancestorDirs(uri: string, root: string): string[];
 *
 * // root があり・履歴選択画面でなく・検索パネルを出していないときだけ true(契約5・6)。
 * export function shouldShowRecentFiles(
 *   rootUri: string | null | undefined, rootPickerOpen: boolean, findInFolderOpen: boolean): boolean;
 *
 * // invoke(LIST_RECENT_FILES_COMMAND, { root }) の結果(新しい順・最大 10 件は Rust が絞る)。
 * // 失敗は [] に解決する(reject しない=root-picker.ts の loadHistory と同じ)。
 * export async function loadRecentFiles(root: string): Promise<string[]>;
 *
 * // invoke(CLEAR_RECENT_FILES_COMMAND, { root })。
 * export async function clearRecentFiles(root: string): Promise<void>;
 * ```
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));

import { invoke } from '$lib/ipc';
import {
	CLEAR_RECENT_FILES_COMMAND,
	LIST_RECENT_FILES_COMMAND,
	MENU_RECENT_FILES_EVENT,
	RECENT_FILES_CLEAR_LABEL,
	RECENT_FILES_EMPTY_MESSAGE,
	RECENT_FILES_TITLE,
	ancestorDirs,
	clearRecentFiles,
	loadRecentFiles,
	recentFileLabel,
	recentFileOpenFailedMessage,
	shouldShowRecentFiles,
} from './recent-files';

const invokeMock = vi.mocked(invoke);

/** CJK を含まない=英語の判定(要件#51 の走査と同じ考え方)。 */
const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;

beforeEach(() => {
	invokeMock.mockReset();
});

// ---------------------------------------------------------------------------
// AC-64-12 — イベント名・command 名・文言(契約4〜7・要件#51)
// ---------------------------------------------------------------------------

describe('AC-64-12: イベント名は Rust と同じ値・command 名・文言は英語(契約5・6・8)', () => {
	test("MENU_RECENT_FILES_EVENT === 'menu_recent_files'(menu.rs の MENU_RECENT_FILES_EVENT と同じ)", () => {
		expect(MENU_RECENT_FILES_EVENT).toBe('menu_recent_files');
	});

	test('command 名は list_recent_files / clear_recent_files(契約11 で承認された 2 つ)', () => {
		expect(LIST_RECENT_FILES_COMMAND).toBe('list_recent_files');
		expect(CLEAR_RECENT_FILES_COMMAND).toBe('clear_recent_files');
	});

	test('文言は値固定: Recent Files / No recent files / Clear(英語=要件#51)', () => {
		expect(RECENT_FILES_TITLE).toBe('Recent Files');
		expect(RECENT_FILES_EMPTY_MESSAGE).toBe('No recent files');
		expect(RECENT_FILES_CLEAR_LABEL).toBe('Clear');
		for (const text of [RECENT_FILES_TITLE, RECENT_FILES_EMPTY_MESSAGE, RECENT_FILES_CLEAR_LABEL]) {
			expect(text).not.toMatch(CJK);
		}
	});

	test('開けなかったときの文言は `Could not open the file: <err>`(契約8・英語)', () => {
		expect(recentFileOpenFailedMessage('not found: file:///proj/gone.md')).toBe(
			'Could not open the file: not found: file:///proj/gone.md'
		);
		expect(recentFileOpenFailedMessage(new Error('boom'))).toBe('Could not open the file: Error: boom');
		expect(recentFileOpenFailedMessage('x')).not.toMatch(CJK);
	});
});

// ---------------------------------------------------------------------------
// AC-64-12 — recentFileLabel(契約6)
// ---------------------------------------------------------------------------

describe('AC-64-12: recentFileLabel — ファイル名+root からの相対フォルダ(契約6)', () => {
	test("('file:///proj/docs/spec/a.md', 'file:///proj') → { name: 'a.md', folder: 'docs/spec' }", () => {
		expect(recentFileLabel('file:///proj/docs/spec/a.md', 'file:///proj')).toEqual({
			name: 'a.md',
			folder: 'docs/spec',
		});
	});

	test("root 直下は folder ''", () => {
		expect(recentFileLabel('file:///proj/a.md', 'file:///proj')).toEqual({ name: 'a.md', folder: '' });
	});

	test('深い階層はフォルダを `/` で繋ぐ(先頭・末尾に `/` を付けない)', () => {
		expect(recentFileLabel('file:///proj/a/b/c/d.md', 'file:///proj')).toEqual({
			name: 'd.md',
			folder: 'a/b/c',
		});
	});

	test('空白を %エンコードしない(new URL() を使わない=root-picker.ts と同じ理由)', () => {
		expect(recentFileLabel('file:///proj/my docs/plan two.md', 'file:///proj')).toEqual({
			name: 'plan two.md',
			folder: 'my docs',
		});
	});

	test('日本語を含むパスも生のまま', () => {
		expect(recentFileLabel('file:///proj/資料/仕様 書.md', 'file:///proj')).toEqual({
			name: '仕様 書.md',
			folder: '資料',
		});
	});

	test('ssh の root でも同様(authority は出さない)', () => {
		expect(recentFileLabel('ssh://alice@host/repo/src/lib/x.md', 'ssh://alice@host/repo')).toEqual({
			name: 'x.md',
			folder: 'src/lib',
		});
		expect(recentFileLabel('ssh://alice@host/repo/x.md', 'ssh://alice@host/repo')).toEqual({
			name: 'x.md',
			folder: '',
		});
	});

	test('root の末尾 `/` は 1 つ落として読む(Rust の is_under_root と同じ規則)・root が file:/// でも同じ', () => {
		expect(recentFileLabel('file:///proj/docs/a.md', 'file:///proj/')).toEqual({
			name: 'a.md',
			folder: 'docs',
		});
		expect(recentFileLabel('file:///x/y.md', 'file:///')).toEqual({ name: 'y.md', folder: 'x' });
	});

	test('種別を問わない(画像・PDF・動画も同じ形)', () => {
		expect(recentFileLabel('file:///proj/img/p.png', 'file:///proj')).toEqual({ name: 'p.png', folder: 'img' });
		expect(recentFileLabel('file:///proj/paper.pdf', 'file:///proj')).toEqual({ name: 'paper.pdf', folder: '' });
	});
});

// ---------------------------------------------------------------------------
// AC-64-12 — ancestorDirs(契約7)
// ---------------------------------------------------------------------------

describe('AC-64-12: ancestorDirs — root を除く祖先フォルダの URI を浅い順に(契約7)', () => {
	test("('file:///proj/a/b/c.md', 'file:///proj') → ['file:///proj/a', 'file:///proj/a/b']", () => {
		expect(ancestorDirs('file:///proj/a/b/c.md', 'file:///proj')).toEqual([
			'file:///proj/a',
			'file:///proj/a/b',
		]);
	});

	test('root 直下のファイルは []', () => {
		expect(ancestorDirs('file:///proj/a.md', 'file:///proj')).toEqual([]);
	});

	test('1 段なら 1 つ', () => {
		expect(ancestorDirs('file:///proj/a/b.md', 'file:///proj')).toEqual(['file:///proj/a']);
	});

	test('root の末尾 `/` があっても祖先の URI は末尾 `/` 無し(ツリーのエントリ URI と同じ綴り)', () => {
		expect(ancestorDirs('file:///proj/a/b/c.md', 'file:///proj/')).toEqual([
			'file:///proj/a',
			'file:///proj/a/b',
		]);
	});

	test('空白を %エンコードしない', () => {
		expect(ancestorDirs('file:///proj/my docs/x.md', 'file:///proj')).toEqual(['file:///proj/my docs']);
	});

	test('ssh の root でも同様(scheme と authority を保つ)', () => {
		expect(ancestorDirs('ssh://alice@host/repo/src/lib/x.md', 'ssh://alice@host/repo')).toEqual([
			'ssh://alice@host/repo/src',
			'ssh://alice@host/repo/src/lib',
		]);
	});

	test('入力を変更せず、同じ入力には同じ結果(純関数)', () => {
		const a = ancestorDirs('file:///proj/a/b/c.md', 'file:///proj');
		const b = ancestorDirs('file:///proj/a/b/c.md', 'file:///proj');
		expect(a).toEqual(b);
		expect(a).not.toBe(b);
	});
});

// ---------------------------------------------------------------------------
// AC-64-12 — shouldShowRecentFiles(契約5・6)
// ---------------------------------------------------------------------------

describe('AC-64-12: shouldShowRecentFiles — root があり・履歴選択画面でなく・検索パネルを出していないときだけ(契約5・6)', () => {
	test('root あり・履歴選択画面でない・検索パネルなし → true', () => {
		expect(shouldShowRecentFiles('file:///proj', false, false)).toBe(true);
		expect(shouldShowRecentFiles('ssh://alice@host/repo', false, false)).toBe(true);
	});

	test('root が無い(空文字・null・undefined)→ false', () => {
		expect(shouldShowRecentFiles('', false, false)).toBe(false);
		expect(shouldShowRecentFiles(null, false, false)).toBe(false);
		expect(shouldShowRecentFiles(undefined, false, false)).toBe(false);
	});

	test('履歴選択画面(要件#4)を表示中 → false', () => {
		expect(shouldShowRecentFiles('file:///proj', true, false)).toBe(false);
	});

	test('検索パネル(要件#55)を出している間 → false(区画を隠す=判断4)', () => {
		expect(shouldShowRecentFiles('file:///proj', false, true)).toBe(false);
		expect(shouldShowRecentFiles('file:///proj', true, true)).toBe(false);
		expect(shouldShowRecentFiles('', false, true)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC-64-12 — loadRecentFiles / clearRecentFiles(契約4・9・10)
// ---------------------------------------------------------------------------

describe('AC-64-12: loadRecentFiles — invoke(list_recent_files, { root })・失敗は [](契約4・10)', () => {
	test('command の結果(新しい順)をそのまま返す', async () => {
		invokeMock.mockResolvedValueOnce(['file:///proj/c.md', 'file:///proj/a.md']);

		const result = await loadRecentFiles('file:///proj');

		expect(result).toEqual(['file:///proj/c.md', 'file:///proj/a.md']);
		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock).toHaveBeenCalledWith('list_recent_files', { root: 'file:///proj' });
	});

	test('command が reject しても [] に解決する(reject しない)', async () => {
		invokeMock.mockRejectedValueOnce(new Error('no config dir'));

		await expect(loadRecentFiles('file:///proj')).resolves.toEqual([]);
	});

	test('0 件は [](空配列をそのまま)', async () => {
		invokeMock.mockResolvedValueOnce([]);
		await expect(loadRecentFiles('file:///proj')).resolves.toEqual([]);
	});
});

describe('AC-64-12: clearRecentFiles — invoke(clear_recent_files, { root })(契約9)', () => {
	test('今の root を渡して 1 回呼ぶ', async () => {
		invokeMock.mockResolvedValueOnce(null);

		await clearRecentFiles('file:///proj');

		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock).toHaveBeenCalledWith('clear_recent_files', { root: 'file:///proj' });
	});
});
