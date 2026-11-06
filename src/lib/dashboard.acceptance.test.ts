/**
 * 要件#83 の受け入れテスト(docs/requirements/req-83.md)— Dashboard の純関数・文言・ページのソース走査
 * (AC-83-14〜20・26=契約 2・3・4・5・8・10・12・13・15)
 *
 * 「起動時の画面を Dashboard にし、Bookmarks・Recent Folders・Recently Modified を載せて、Go ▸ Dashboard で
 * いつでも開けるようにする」のうち、`src/lib/dashboard.ts`(新規)の純関数と定数、`+page.svelte` と
 * `Dashboard.svelte` のソース走査を判定する。部品の配線(マウント)は Dashboard.wiring.test.ts、Bookmark の口は
 * bookmarks.acceptance.test.ts、右クリックの項目列は context-menu.acceptance.test.ts の持ち場。
 *
 * ## 確定契約(implementer はこれに従う=推奨名は req-83.md のもの・無いものは test-writer が固定)
 *
 * ```ts
 * // --- src/lib/dashboard.ts(新規)
 * export const MENU_DASHBOARD_EVENT = 'menu_dashboard';            // Rust の menu::MENU_DASHBOARD_EVENT と同じ値
 * export const DASHBOARD_LABEL = 'Dashboard';                       // Go の項目名と同じ字面
 * export const RECENTLY_MODIFIED_PROGRESS_EVENT = 'recently_modified_progress';
 * export const SCAN_RECENTLY_MODIFIED_COMMAND = 'scan_recently_modified';
 * export const REMOVE_HISTORY_ENTRY_COMMAND = 'remove_history_entry';
 * export const LIST_MISSING_PATHS_COMMAND = 'list_missing_paths';
 * export const RECENT_FOLDERS_SHOWN = 6;
 * export const RECENTLY_MODIFIED_LIMIT = 8;
 * // 文言(契約 2・6・10・12【(al) 決定】・英語のみ)
 * export const BOOKMARKS_HEADING = 'Bookmarks';
 * export const RECENT_FOLDERS_HEADING = 'Recent Folders';
 * export const RECENTLY_MODIFIED_HEADING = 'Recently Modified';
 * export const ADD_BOOKMARK_LABEL = 'Add Bookmark…';
 * export const ADD_FOLDER_LABEL = 'Add Folder…';
 * export const ADD_FILE_LABEL = 'Add File…';
 * export const ADD_BOOKMARK_DIALOG_TITLE = 'Add Bookmark';
 * export const SHOW_ALL_LABEL = 'Show All';
 * export const SHOW_LESS_LABEL = 'Show Less';
 * export const RESCAN_LABEL = 'Rescan';                              // 走査し直しのボタンの aria-label
 * export const NO_RECENT_FOLDERS_MESSAGE = 'No recently opened folders';
 * export const NO_RECENTLY_MODIFIED_MESSAGE = 'No recently modified files';
 * export const SCANNING_MESSAGE = 'Scanning…';
 * export const NO_FOLDERS_TO_SCAN_MESSAGE = 'No folders to scan';
 * export const SCAN_TRUNCATED_MESSAGE = 'Partial results: the scan stopped after 2 seconds';
 * export const DASHBOARD_TIP = 'Tip: Press Shift + Command + H to open this Dashboard at any time.';
 * export function foldersScannedLabel(n: number): string;          // 'in N folders'・1 は 'in 1 folder'
 *
 * // 出方と戻り方(契約 4)
 * export type DashboardState = { open: boolean; returnable: boolean };
 * export type DashboardTrigger = 'menu' | 'escape';
 * export function toggleDashboard(state: DashboardState, trigger: DashboardTrigger): DashboardState;
 *
 * // 開き方の計画(契約 5)
 * export type DashboardOpenTarget =
 *   | { kind: 'folder'; uri: string }                              // Recent Folders の行・Bookmark のフォルダ
 *   | { kind: 'file'; uri: string }                                // Bookmark のファイル
 *   | { kind: 'modified'; uri: string; folder: string };          // Recently Modified の行(folder = 見つけた元のフォルダ)
 * export type DashboardOpenPlan = { root: string | null; doc: string | null };   // root が null = 切り替えない
 * export function planDashboardOpen(target: DashboardOpenTarget, currentRoot: string | null): DashboardOpenPlan;
 *
 * // 時刻(契約 12)。地方時の暦日で数える・未来は 'Just now'
 * export function formatModifiedAt(modifiedMs: number, nowMs: number): string;
 *
 * // Recent Folders の見せ方(契約 10)
 * export type RecentFolderRow = { uri: string; label: string; path: string; missing: boolean; ssh: boolean };
 * export function recentFoldersView(history: string[], missing: string[], expanded: boolean): {
 *   rows: RecentFolderRow[];
 *   summary: string | null;        // '6 of 14'(7 件以上のときだけ)
 *   toggleLabel: string | null;    // 'Show All' / 'Show Less'(7 件以上のときだけ)
 * };
 *
 * // Recently Modified の行の見せ方(契約 12)
 * export function modifiedRowLabel(file: { uri: string; folder: string; modified: number }): { name: string; segments: string[] };
 *
 * // キーボードの動き(契約 8・13)。返り値は移った先の index(動かないときは同じ index)
 * export function tileMove(index: number, key: string, count: number, columns: number): number;
 * export function listMove(index: number, key: string, count: number): number;
 * export function reorderMove(index: number, key: string, count: number): number;
 *
 * // メニューの購読(契約 3)= registerReloadFileListener と同じ作り
 * export function registerDashboardListener(run: () => Promise<unknown> | unknown): Promise<() => void>;
 * ```
 *
 * ## 判断の記録(test-writer 2026-11-05)
 * - `planDashboardOpen` の target は 3 種の判別つき union で固定した(契約 5 の表の 3 行に対応)。「今の root と同じ」は
 *   履歴と同じ正規化(`//` を 1 つに・末尾の `/` を落とす)で比べる。「下」は末尾の `/` を 1 つ落として `/` を足した
 *   前方一致(Recent Files の `is_under_root` と同じ)
 * - `recentFoldersView` の `path` は【(ah) 決定】(local= `file://` を外した OS のパス・ssh= URI のまま)を同じ関数で返す
 * - 時刻の境目(「今日」と「暦の前日」の判定)は地方時の `new Date(y, m, d, h, mi)` で組むので、走らせる場所の時間帯に依らない
 *
 * ## reviewer 照合に委ねるもの(本テストの判定対象外)
 * - Dashboard を開くときの `contextMenu.close()`・Go to バーを閉じること・Save が後ろの文書に効くこと・タブの見出し
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/events', () => ({ listen: vi.fn() }));

import { listen } from '$lib/events';
import { bookmarkSaveFailedMessage } from './bookmarks';
import { buildRecentFolderMenu } from './context-menu';
import {
	ADD_BOOKMARK_DIALOG_TITLE,
	ADD_BOOKMARK_LABEL,
	ADD_FILE_LABEL,
	ADD_FOLDER_LABEL,
	BOOKMARKS_HEADING,
	DASHBOARD_LABEL,
	DASHBOARD_TIP,
	LIST_MISSING_PATHS_COMMAND,
	MENU_DASHBOARD_EVENT,
	NO_FOLDERS_TO_SCAN_MESSAGE,
	NO_RECENTLY_MODIFIED_MESSAGE,
	NO_RECENT_FOLDERS_MESSAGE,
	RECENTLY_MODIFIED_HEADING,
	RECENTLY_MODIFIED_LIMIT,
	RECENTLY_MODIFIED_PROGRESS_EVENT,
	RECENT_FOLDERS_HEADING,
	RECENT_FOLDERS_SHOWN,
	REMOVE_HISTORY_ENTRY_COMMAND,
	RESCAN_LABEL,
	SCANNING_MESSAGE,
	SCAN_RECENTLY_MODIFIED_COMMAND,
	SCAN_TRUNCATED_MESSAGE,
	SHOW_ALL_LABEL,
	SHOW_LESS_LABEL,
	foldersScannedLabel,
	formatModifiedAt,
	listMove,
	modifiedRowLabel,
	planDashboardOpen,
	recentFoldersView,
	registerDashboardListener,
	reorderMove,
	tileMove,
	toggleDashboard,
} from './dashboard';
import { toPickerEntries } from './root-picker';

const listenMock = vi.mocked(listen);

const REPO_ROOT = resolve(__dirname, '../..');
const PAGE = resolve(REPO_ROOT, 'src/routes/+page.svelte');
const DASHBOARD_SVELTE = resolve(REPO_ROOT, 'src/components/Dashboard.svelte');
const ROOT_PICKER_SVELTE = resolve(REPO_ROOT, 'src/components/RootPicker.svelte');

const CJK = /[　-〿぀-ヿ一-鿿＀-￯]/;

// ---------------------------------------------------------------------------
// AC-83-14 — 出方と戻り方(契約 4)【(b) 決定・(w) 決定】
// ---------------------------------------------------------------------------

describe('AC-83-14: toggleDashboard(state, trigger) の表(契約 4)', () => {
	test("閉じている + 'menu' → { open: true, returnable: true }", () => {
		expect(toggleDashboard({ open: false, returnable: false }, 'menu')).toEqual({ open: true, returnable: true });
		expect(toggleDashboard({ open: false, returnable: true }, 'menu')).toEqual({ open: true, returnable: true });
	});

	test("開いて戻れる + 'menu' → 閉じる", () => {
		expect(toggleDashboard({ open: true, returnable: true }, 'menu')).toEqual({ open: false, returnable: false });
	});

	test("開いて戻れる + 'escape' → 閉じる", () => {
		expect(toggleDashboard({ open: true, returnable: true }, 'escape')).toEqual({ open: false, returnable: false });
	});

	test("開いて戻れない + 'menu' / 'escape' → そのまま(起動時・init の失敗・New Window の Dashboard=(w))", () => {
		expect(toggleDashboard({ open: true, returnable: false }, 'menu')).toEqual({ open: true, returnable: false });
		expect(toggleDashboard({ open: true, returnable: false }, 'escape')).toEqual({ open: true, returnable: false });
	});

	test("閉じている + 'escape' → そのまま", () => {
		expect(toggleDashboard({ open: false, returnable: false }, 'escape')).toEqual({ open: false, returnable: false });
	});

	test('入力の state は書き換えない(純関数)', () => {
		const state = { open: true, returnable: true };
		toggleDashboard(state, 'menu');
		expect(state).toEqual({ open: true, returnable: true });
	});
});

// ---------------------------------------------------------------------------
// AC-83-15 — 開き方の計画(契約 5)【(c)(d) 決定・(w) 決定】
// ---------------------------------------------------------------------------

describe('AC-83-15: planDashboardOpen(target, currentRoot) は契約 5 の表どおり', () => {
	test("Recent Folders の行・Bookmark のフォルダ → { root: そのフォルダ, doc: null }(今の root があっても無くても)", () => {
		expect(planDashboardOpen({ kind: 'folder', uri: 'file:///r/b' }, 'file:///r/a')).toEqual({ root: 'file:///r/b', doc: null });
		expect(planDashboardOpen({ kind: 'folder', uri: 'file:///r/b' }, null)).toEqual({ root: 'file:///r/b', doc: null });
	});

	test('Recently Modified の行 → { root: 見つけた元のフォルダ, doc: そのファイル }', () => {
		expect(
			planDashboardOpen({ kind: 'modified', uri: 'file:///r/b/docs/x.md', folder: 'file:///r/b' }, 'file:///r/a')
		).toEqual({ root: 'file:///r/b', doc: 'file:///r/b/docs/x.md' });
		expect(planDashboardOpen({ kind: 'modified', uri: 'file:///r/b/x.md', folder: 'file:///r/b' }, null)).toEqual({
			root: 'file:///r/b',
			doc: 'file:///r/b/x.md',
		});
	});

	test('Bookmark のファイルで今の root の下 → { root: null, doc }(set_root しない)', () => {
		expect(planDashboardOpen({ kind: 'file', uri: 'file:///r/a/docs/x.md' }, 'file:///r/a')).toEqual({
			root: null,
			doc: 'file:///r/a/docs/x.md',
		});
		expect(planDashboardOpen({ kind: 'file', uri: 'file:///r/a/x.md' }, 'file:///r/a')).toEqual({ root: null, doc: 'file:///r/a/x.md' });
	});

	test('Bookmark のファイルで今の root の外 → { root: 親フォルダ, doc }', () => {
		expect(planDashboardOpen({ kind: 'file', uri: 'file:///r/b/docs/x.md' }, 'file:///r/a')).toEqual({
			root: 'file:///r/b/docs',
			doc: 'file:///r/b/docs/x.md',
		});
	});

	test('currentRoot が null(起動時の仮の root は数えない=(w))→ { root: 親フォルダ, doc }', () => {
		expect(planDashboardOpen({ kind: 'file', uri: 'file:///r/a/docs/x.md' }, null)).toEqual({
			root: 'file:///r/a/docs',
			doc: 'file:///r/a/docs/x.md',
		});
	});

	test('file:///r/ab/x.md は file:///r/a の下ではない(前方一致は区切りまで)', () => {
		expect(planDashboardOpen({ kind: 'file', uri: 'file:///r/ab/x.md' }, 'file:///r/a')).toEqual({
			root: 'file:///r/ab',
			doc: 'file:///r/ab/x.md',
		});
	});

	test('切り替え先が今の root と同じ(file:///r/a/ と file:///r/a・file:///r//a)→ root: null', () => {
		expect(planDashboardOpen({ kind: 'folder', uri: 'file:///r/a/' }, 'file:///r/a')).toEqual({ root: null, doc: null });
		expect(planDashboardOpen({ kind: 'folder', uri: 'file:///r/a' }, 'file:///r/a/')).toEqual({ root: null, doc: null });
		expect(planDashboardOpen({ kind: 'folder', uri: 'file:///r//a' }, 'file:///r/a')).toEqual({ root: null, doc: null });
		expect(planDashboardOpen({ kind: 'modified', uri: 'file:///r/a/x.md', folder: 'file:///r/a/' }, 'file:///r/a')).toEqual({
			root: null,
			doc: 'file:///r/a/x.md',
		});
		// 今の root が末尾 `/` でも「下」の判定は同じ。
		expect(planDashboardOpen({ kind: 'file', uri: 'file:///r/a/x.md' }, 'file:///r/a/')).toEqual({ root: null, doc: 'file:///r/a/x.md' });
	});

	test('ssh の URI でも同じ規則', () => {
		expect(planDashboardOpen({ kind: 'file', uri: 'ssh://alice@host:22/srv/notes/x.md' }, 'ssh://alice@host:22/srv/notes')).toEqual({
			root: null,
			doc: 'ssh://alice@host:22/srv/notes/x.md',
		});
		expect(planDashboardOpen({ kind: 'file', uri: 'ssh://alice@host:22/srv/other/x.md' }, 'ssh://alice@host:22/srv/notes')).toEqual({
			root: 'ssh://alice@host:22/srv/other',
			doc: 'ssh://alice@host:22/srv/other/x.md',
		});
		expect(planDashboardOpen({ kind: 'file', uri: 'ssh://host/srv/notes/x.md' }, 'file:///srv/notes')).toEqual({
			root: 'ssh://host/srv/notes',
			doc: 'ssh://host/srv/notes/x.md',
		});
		expect(planDashboardOpen({ kind: 'folder', uri: 'ssh://host/srv/notes/' }, 'ssh://host/srv/notes')).toEqual({ root: null, doc: null });
	});

	test('空白を含む URI も文字列のまま(符号化しない)', () => {
		expect(planDashboardOpen({ kind: 'file', uri: 'file:///r/My Docs/read me.md' }, 'file:///r/Other')).toEqual({
			root: 'file:///r/My Docs',
			doc: 'file:///r/My Docs/read me.md',
		});
	});
});

// ---------------------------------------------------------------------------
// AC-83-16 — 時刻(契約 12)【(m) 決定・(ak) 決定】
// ---------------------------------------------------------------------------

describe('AC-83-16: formatModifiedAt(modifiedMs, nowMs) の表(地方時の暦日で数える)', () => {
	const at = (y: number, m: number, d: number, h: number, mi: number, s = 0) => new Date(y, m - 1, d, h, mi, s).getTime();
	const NOW = at(2026, 11, 5, 10, 0);

	test("30 秒前・未来 → 'Just now'", () => {
		expect(formatModifiedAt(NOW - 30_000, NOW)).toBe('Just now');
		expect(formatModifiedAt(NOW, NOW)).toBe('Just now');
		expect(formatModifiedAt(NOW + 5 * 60_000, NOW)).toBe('Just now');
		expect(formatModifiedAt(at(2027, 1, 1, 0, 0), NOW)).toBe('Just now');
	});

	test("1 分前 → '1 min ago'・59 分前 → '59 min ago'", () => {
		expect(formatModifiedAt(NOW - 60_000, NOW)).toBe('1 min ago');
		expect(formatModifiedAt(NOW - 59 * 60_000, NOW)).toBe('59 min ago');
		expect(formatModifiedAt(NOW - 2 * 60_000, NOW)).toBe('2 min ago');
	});

	test("同じ日の 3 時間前 → '3 hr ago'・1 時間前 → '1 hr ago'", () => {
		expect(formatModifiedAt(at(2026, 11, 5, 7, 0), NOW)).toBe('3 hr ago');
		expect(formatModifiedAt(at(2026, 11, 5, 9, 0), NOW)).toBe('1 hr ago');
		expect(formatModifiedAt(at(2026, 11, 5, 1, 0), NOW)).toBe('9 hr ago');
	});

	test("前日 → 'Yesterday'(0 時 10 分に前日 23 時 50 分=20 分前は '20 min ago'・90 分前でも暦の前日なら 'Yesterday')", () => {
		expect(formatModifiedAt(at(2026, 11, 4, 15, 0), NOW)).toBe('Yesterday');
		expect(formatModifiedAt(at(2026, 11, 4, 23, 50), at(2026, 11, 5, 0, 10))).toBe('20 min ago');
		expect(formatModifiedAt(at(2026, 11, 4, 23, 30), at(2026, 11, 5, 1, 0))).toBe('Yesterday');
	});

	test("2〜6 日前 → 'N days ago'(暦日で数える)", () => {
		expect(formatModifiedAt(at(2026, 11, 3, 12, 0), NOW)).toBe('2 days ago');
		expect(formatModifiedAt(at(2026, 11, 2, 12, 0), NOW)).toBe('3 days ago');
		expect(formatModifiedAt(at(2026, 10, 30, 23, 0), NOW)).toBe('6 days ago');
	});

	test("7 日前 → 'Oct 29'(同じ年)・それより前も日付", () => {
		expect(formatModifiedAt(at(2026, 10, 29, 12, 0), NOW)).toBe('Oct 29');
		expect(formatModifiedAt(at(2026, 10, 1, 12, 0), NOW)).toBe('Oct 1');
		expect(formatModifiedAt(at(2026, 1, 15, 12, 0), NOW)).toBe('Jan 15');
	});

	test("去年 → 'Oct 28, 2025'", () => {
		expect(formatModifiedAt(at(2025, 10, 28, 12, 0), NOW)).toBe('Oct 28, 2025');
		expect(formatModifiedAt(at(2025, 12, 31, 23, 59), at(2026, 1, 20, 10, 0))).toBe('Dec 31, 2025');
	});

	test('文言に CJK が無い', () => {
		for (const m of [NOW - 30_000, NOW - 60_000, at(2026, 11, 5, 7, 0), at(2026, 11, 4, 15, 0), at(2026, 11, 2, 12, 0), at(2025, 10, 28, 12, 0)]) {
			expect(formatModifiedAt(m, NOW)).not.toMatch(CJK);
		}
	});
});

// ---------------------------------------------------------------------------
// AC-83-17 — Recent Folders の見せ方(契約 10)【(n) 決定・(ag)(ah)(al) 決定】
// ---------------------------------------------------------------------------

describe('AC-83-17: recentFoldersView(history, missing, expanded)', () => {
	const history14 = [
		'file:///Users/x/aurora',
		'ssh://alice@host:22/srv/notes',
		'file:///Users/x/gone',
		...Array.from({ length: 11 }, (_, i) => `file:///Users/x/folder-${i}`),
	];
	const missing = ['file:///Users/x/gone'];

	test("14 件 → 畳んで 6 行・補足 '6 of 14'・'Show All'", () => {
		const view = recentFoldersView(history14, missing, false);
		expect(view.rows.map((r) => r.uri)).toEqual(history14.slice(0, 6));
		expect(view.summary).toBe('6 of 14');
		expect(view.toggleLabel).toBe(SHOW_ALL_LABEL);
		expect(RECENT_FOLDERS_SHOWN).toBe(6);
	});

	test("広げて 14 行・'Show Less'", () => {
		const view = recentFoldersView(history14, missing, true);
		expect(view.rows.map((r) => r.uri)).toEqual(history14);
		expect(view.summary).toBe('6 of 14');
		expect(view.toggleLabel).toBe(SHOW_LESS_LABEL);
	});

	test('6 件以下 → 全部・補足なし・ボタンなし(広げる印があっても同じ)', () => {
		const six = history14.slice(0, 6);
		for (const expanded of [false, true]) {
			const view = recentFoldersView(six, [], expanded);
			expect(view.rows.map((r) => r.uri)).toEqual(six);
			expect(view.summary).toBeNull();
			expect(view.toggleLabel).toBeNull();
		}
		const view = recentFoldersView([], [], false);
		expect(view.rows).toEqual([]);
		expect(view.summary).toBeNull();
		expect(view.toggleLabel).toBeNull();
	});

	test("7 件 → 畳んで 6 行・'6 of 7'・'Show All'(7 件以上のときだけ出す=(ag))", () => {
		const seven = history14.slice(0, 7);
		const view = recentFoldersView(seven, [], false);
		expect(view.rows).toHaveLength(6);
		expect(view.summary).toBe('6 of 7');
		expect(view.toggleLabel).toBe(SHOW_ALL_LABEL);
	});

	test('missing に入った URI の行は missing: true・ssh は ssh: true・ほかは false', () => {
		const rows = recentFoldersView(history14, missing, true).rows;
		const byUri = (u: string) => rows.find((r) => r.uri === u)!;
		expect(byUri('file:///Users/x/gone')).toMatchObject({ missing: true, ssh: false });
		expect(byUri('ssh://alice@host:22/srv/notes')).toMatchObject({ missing: false, ssh: true });
		expect(byUri('file:///Users/x/aurora')).toMatchObject({ missing: false, ssh: false });
	});

	test('label は toPickerEntries と同じ規則(最後の区切り・空白は符号化しない)', () => {
		const history = ['file:///Users/x/My Docs/', 'ssh://alice@host:22/srv/notes', 'file:///'];
		const rows = recentFoldersView(history, [], true).rows;
		const expected = toPickerEntries(history);
		expect(rows.map((r) => r.label)).toEqual(expected.map((e) => e.label));
		expect(rows[0]!.label).toBe('My Docs');
		expect(rows[1]!.label).toBe('notes');
	});

	test('path は local= file:// を外した OS のパス(~ に縮めない)・ssh= URI のまま【(ah)】', () => {
		const rows = recentFoldersView(['file:///Users/x/My Docs', 'ssh://alice@host:22/srv/notes'], [], true).rows;
		expect(rows[0]!.path).toBe('/Users/x/My Docs');
		expect(rows[1]!.path).toBe('ssh://alice@host:22/srv/notes');
	});

	test('入力の配列は書き換えない', () => {
		const copy = [...history14];
		recentFoldersView(history14, missing, false);
		expect(history14).toEqual(copy);
	});
});

// ---------------------------------------------------------------------------
// AC-83-18 — Recently Modified の行の見せ方(契約 12)
// ---------------------------------------------------------------------------

describe('AC-83-18: modifiedRowLabel(file) = { name, segments }', () => {
	test("folder が file:///p/aurora・uri が file:///p/aurora/docs/design/a.html → { name: 'a.html', segments: ['aurora', 'docs', 'design'] }", () => {
		expect(modifiedRowLabel({ uri: 'file:///p/aurora/docs/design/a.html', folder: 'file:///p/aurora', modified: 0 })).toEqual({
			name: 'a.html',
			segments: ['aurora', 'docs', 'design'],
		});
	});

	test("元のフォルダの直下 → segments: ['aurora']", () => {
		expect(modifiedRowLabel({ uri: 'file:///p/aurora/README.md', folder: 'file:///p/aurora', modified: 0 })).toEqual({
			name: 'README.md',
			segments: ['aurora'],
		});
	});

	test('folder の末尾の / の有無で変わらない', () => {
		expect(modifiedRowLabel({ uri: 'file:///p/aurora/docs/a.md', folder: 'file:///p/aurora/', modified: 0 })).toEqual({
			name: 'a.md',
			segments: ['aurora', 'docs'],
		});
	});

	test('空白を % で符号化しない(new URL() を使わない)', () => {
		expect(modifiedRowLabel({ uri: 'file:///p/My Docs/sub dir/read me.md', folder: 'file:///p/My Docs', modified: 0 })).toEqual({
			name: 'read me.md',
			segments: ['My Docs', 'sub dir'],
		});
		expect(modifiedRowLabel({ uri: 'file:///p/資料/メモ.md', folder: 'file:///p/資料', modified: 0 })).toEqual({
			name: 'メモ.md',
			segments: ['資料'],
		});
	});
});

// ---------------------------------------------------------------------------
// AC-83-19 — キーボードの動き(契約 8・13)【(o) 決定・(af)(am) 決定】
// ---------------------------------------------------------------------------

describe('AC-83-19: tileMove / listMove / reorderMove の表', () => {
	describe('tileMove(index, key, count, columns) — 12 枚・4 列', () => {
		const COUNT = 12;
		const COLS = 4;

		test('← / → で前後(段をまたぐ)・端では止まる', () => {
			expect(tileMove(0, 'ArrowRight', COUNT, COLS)).toBe(1);
			expect(tileMove(3, 'ArrowRight', COUNT, COLS)).toBe(4);
			expect(tileMove(11, 'ArrowRight', COUNT, COLS)).toBe(11);
			expect(tileMove(5, 'ArrowLeft', COUNT, COLS)).toBe(4);
			expect(tileMove(4, 'ArrowLeft', COUNT, COLS)).toBe(3);
			expect(tileMove(0, 'ArrowLeft', COUNT, COLS)).toBe(0);
		});

		test('↑ / ↓ で上下の段の同じ列・端では止まる', () => {
			expect(tileMove(5, 'ArrowDown', COUNT, COLS)).toBe(9);
			expect(tileMove(5, 'ArrowUp', COUNT, COLS)).toBe(1);
			expect(tileMove(1, 'ArrowUp', COUNT, COLS)).toBe(1);
			expect(tileMove(9, 'ArrowDown', COUNT, COLS)).toBe(9);
			expect(tileMove(0, 'ArrowDown', COUNT, COLS)).toBe(4);
			expect(tileMove(11, 'ArrowUp', COUNT, COLS)).toBe(7);
		});

		test('最後の段の欠けた列では ↓ が動かない(10 枚・4 列で 6 → 10 は無い)', () => {
			expect(tileMove(6, 'ArrowDown', 10, COLS)).toBe(6);
			expect(tileMove(7, 'ArrowDown', 10, COLS)).toBe(7);
			expect(tileMove(4, 'ArrowDown', 10, COLS)).toBe(8);
			expect(tileMove(5, 'ArrowDown', 10, COLS)).toBe(9);
		});

		test('1 列(狭い窓)では ↑ / ↓ が前後', () => {
			expect(tileMove(2, 'ArrowDown', 5, 1)).toBe(3);
			expect(tileMove(2, 'ArrowUp', 5, 1)).toBe(1);
		});

		test('ほかのキーでは動かない', () => {
			expect(tileMove(5, 'Enter', COUNT, COLS)).toBe(5);
			expect(tileMove(5, 'Tab', COUNT, COLS)).toBe(5);
			expect(tileMove(5, 'a', COUNT, COLS)).toBe(5);
		});
	});

	describe('listMove(index, key, count) — 行の区画', () => {
		test('↑ / ↓ で前後・端では止まる', () => {
			expect(listMove(0, 'ArrowDown', 6)).toBe(1);
			expect(listMove(5, 'ArrowDown', 6)).toBe(5);
			expect(listMove(3, 'ArrowUp', 6)).toBe(2);
			expect(listMove(0, 'ArrowUp', 6)).toBe(0);
		});

		test('← / → とほかのキーでは動かない', () => {
			expect(listMove(2, 'ArrowLeft', 6)).toBe(2);
			expect(listMove(2, 'ArrowRight', 6)).toBe(2);
			expect(listMove(2, 'Enter', 6)).toBe(2);
		});
	});

	describe('reorderMove(index, key, count) — Option + 矢印の並べ替え', () => {
		test('← / ↑ で −1・→ / ↓ で +1・端では止まる', () => {
			expect(reorderMove(2, 'ArrowLeft', 5)).toBe(1);
			expect(reorderMove(2, 'ArrowUp', 5)).toBe(1);
			expect(reorderMove(2, 'ArrowRight', 5)).toBe(3);
			expect(reorderMove(2, 'ArrowDown', 5)).toBe(3);
			expect(reorderMove(0, 'ArrowLeft', 5)).toBe(0);
			expect(reorderMove(0, 'ArrowUp', 5)).toBe(0);
			expect(reorderMove(4, 'ArrowRight', 5)).toBe(4);
			expect(reorderMove(4, 'ArrowDown', 5)).toBe(4);
		});

		test('1 件では動かない・ほかのキーでは動かない', () => {
			expect(reorderMove(0, 'ArrowRight', 1)).toBe(0);
			expect(reorderMove(2, 'Enter', 5)).toBe(2);
		});
	});
});

// ---------------------------------------------------------------------------
// AC-83-20 — 文言(契約 2・6・10・12)【(al) 決定】
// ---------------------------------------------------------------------------

describe('AC-83-20: 文言の値固定(英語・CJK なし)', () => {
	test("DASHBOARD_LABEL === 'Dashboard'・MENU_DASHBOARD_EVENT === 'menu_dashboard'", () => {
		expect(DASHBOARD_LABEL).toBe('Dashboard');
		expect(MENU_DASHBOARD_EVENT).toBe('menu_dashboard');
	});

	test('event と command の名前は Rust と同じ値', () => {
		expect(RECENTLY_MODIFIED_PROGRESS_EVENT).toBe('recently_modified_progress');
		expect(SCAN_RECENTLY_MODIFIED_COMMAND).toBe('scan_recently_modified');
		expect(REMOVE_HISTORY_ENTRY_COMMAND).toBe('remove_history_entry');
		expect(LIST_MISSING_PATHS_COMMAND).toBe('list_missing_paths');
		expect(RECENTLY_MODIFIED_LIMIT).toBe(8);
	});

	test('見出し・ボタン・空のときの文言', () => {
		expect(BOOKMARKS_HEADING).toBe('Bookmarks');
		expect(RECENT_FOLDERS_HEADING).toBe('Recent Folders');
		expect(RECENTLY_MODIFIED_HEADING).toBe('Recently Modified');
		expect(ADD_BOOKMARK_LABEL).toBe('Add Bookmark…');
		expect(ADD_FOLDER_LABEL).toBe('Add Folder…');
		expect(ADD_FILE_LABEL).toBe('Add File…');
		expect(ADD_BOOKMARK_DIALOG_TITLE).toBe('Add Bookmark');
		expect(SHOW_ALL_LABEL).toBe('Show All');
		expect(SHOW_LESS_LABEL).toBe('Show Less');
		expect(RESCAN_LABEL).toBe('Rescan');
		expect(NO_RECENT_FOLDERS_MESSAGE).toBe('No recently opened folders');
		expect(NO_RECENTLY_MODIFIED_MESSAGE).toBe('No recently modified files');
		expect(SCANNING_MESSAGE).toBe('Scanning…');
		expect(NO_FOLDERS_TO_SCAN_MESSAGE).toBe('No folders to scan');
		expect(SCAN_TRUNCATED_MESSAGE).toBe('Partial results: the scan stopped after 2 seconds');
		expect(DASHBOARD_TIP).toBe('Tip: Press Shift + Command + H to open this Dashboard at any time.');
	});

	test("foldersScannedLabel: 'in N folders'(1 は単数)", () => {
		expect(foldersScannedLabel(6)).toBe('in 6 folders');
		expect(foldersScannedLabel(1)).toBe('in 1 folder');
		expect(foldersScannedLabel(0)).toBe('in 0 folders');
		expect(foldersScannedLabel(20)).toBe('in 20 folders');
	});

	test("Remove from Recent Folders は Recent Folders の行のメニューの項目名", () => {
		const labels = buildRecentFolderMenu(false).map((i) => i.label);
		expect(labels).toContain('Remove from Recent Folders');
	});

	test("bookmarkSaveFailedMessage('boom') === 'Could not save the bookmarks: boom'", () => {
		expect(bookmarkSaveFailedMessage('boom')).toBe('Could not save the bookmarks: boom');
	});

	test('どれも CJK を含まない', () => {
		const all = [
			DASHBOARD_LABEL,
			BOOKMARKS_HEADING,
			RECENT_FOLDERS_HEADING,
			RECENTLY_MODIFIED_HEADING,
			ADD_BOOKMARK_LABEL,
			ADD_FOLDER_LABEL,
			ADD_FILE_LABEL,
			ADD_BOOKMARK_DIALOG_TITLE,
			SHOW_ALL_LABEL,
			SHOW_LESS_LABEL,
			RESCAN_LABEL,
			NO_RECENT_FOLDERS_MESSAGE,
			NO_RECENTLY_MODIFIED_MESSAGE,
			SCANNING_MESSAGE,
			NO_FOLDERS_TO_SCAN_MESSAGE,
			SCAN_TRUNCATED_MESSAGE,
			DASHBOARD_TIP,
			foldersScannedLabel(1),
			foldersScannedLabel(3),
			bookmarkSaveFailedMessage('x'),
			...buildRecentFolderMenu(false).map((i) => i.label),
			...buildRecentFolderMenu(true).map((i) => i.label),
		];
		for (const s of all) {
			expect(typeof s).toBe('string');
			expect(s.length).toBeGreaterThan(0);
			expect(s).not.toMatch(CJK);
		}
	});
});

// ---------------------------------------------------------------------------
// 契約 3 — メニューの購読(registerDashboardListener)
// ---------------------------------------------------------------------------

describe('契約 3: registerDashboardListener(run) は listen を 1 回・イベント 1 回で run を 1 回・reject を外へ出さない・解く関数を返す', () => {
	beforeEach(() => {
		listenMock.mockReset();
	});

	test('MENU_DASHBOARD_EVENT を 1 回 listen し、イベントごとに run を 1 回呼ぶ', async () => {
		let handler: ((e: { payload: unknown }) => void) | null = null;
		const unlisten = vi.fn();
		listenMock.mockImplementation(async (event, h) => {
			expect(event).toBe('menu_dashboard');
			handler = h as (e: { payload: unknown }) => void;
			return unlisten;
		});
		const run = vi.fn(async () => undefined);
		const off = await registerDashboardListener(run);
		expect(listenMock).toHaveBeenCalledTimes(1);
		expect(listenMock.mock.calls[0]?.[0]).toBe(MENU_DASHBOARD_EVENT);
		expect(run).not.toHaveBeenCalled();

		handler!({ payload: undefined });
		await Promise.resolve();
		expect(run).toHaveBeenCalledTimes(1);
		handler!({ payload: undefined });
		await Promise.resolve();
		expect(run).toHaveBeenCalledTimes(2);

		expect(unlisten).not.toHaveBeenCalled();
		off();
		expect(unlisten).toHaveBeenCalledTimes(1);
	});

	test('run の reject も同期の throw も外へ出ない', async () => {
		let handler: ((e: { payload: unknown }) => void) | null = null;
		listenMock.mockImplementation(async (_event, h) => {
			handler = h as (e: { payload: unknown }) => void;
			return () => {};
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			await registerDashboardListener(async () => {
				throw new Error('boom');
			});
			expect(() => handler!({ payload: undefined })).not.toThrow();
			await Promise.resolve();
			await Promise.resolve();

			await registerDashboardListener(() => {
				throw new Error('sync boom');
			});
			expect(() => handler!({ payload: undefined })).not.toThrow();
			await Promise.resolve();
		} finally {
			warn.mockRestore();
		}
	});
});

// ---------------------------------------------------------------------------
// AC-83-26 — ページの配線(契約 1・3・4・15・ソース走査)
// ---------------------------------------------------------------------------

/** `start` の位置から最初の `open` に対応する閉じ括弧までのテキスト(settings-changed.acceptance.test.ts と同じ)。 */
function balancedFrom(src: string, start: number, open: '(' | '{'): string {
	const close = open === '(' ? ')' : '}';
	const at = src.indexOf(open, start);
	if (at === -1) throw new Error(`no ${open} after ${start}`);
	let depth = 0;
	for (let i = at; i < src.length; i++) {
		const c = src[i];
		if (c === open) depth++;
		else if (c === close) {
			depth--;
			if (depth === 0) return src.slice(start, i + 1);
		}
	}
	throw new Error(`unbalanced ${open} starting at ${start}`);
}

/** `function <name>(` の本体(`{ … }`)。 */
function functionBody(src: string, name: string): string {
	const re = new RegExp(`\\bfunction\\s+${name}\\s*\\(`);
	const m = re.exec(src);
	if (!m) throw new Error(`+page.svelte must define function ${name}(`);
	const params = balancedFrom(src, m.index, '(');
	return balancedFrom(src, m.index + params.length, '{');
}

/** `.svelte` のマークアップ部分(script / style / コメントを除く)。 */
function markupOf(src: string): string {
	return src
		.replace(/<script[\s\S]*?<\/script>/g, '')
		.replace(/<style[\s\S]*?<\/style>/g, '')
		.replace(/<!--[\s\S]*?-->/g, '');
}

describe('AC-83-26: +page.svelte と Dashboard.svelte のソース走査(契約 1・3・4・15)', () => {
	const page = () => readFileSync(PAGE, 'utf-8');

	test('+page.svelte に <Dashboard … /> があって自己閉じ・<RootPicker は無い', () => {
		const src = page();
		expect(src).toMatch(/<Dashboard\b[\s\S]*?\/>/);
		expect(src).not.toMatch(/<\/Dashboard>/);
		expect(src).not.toMatch(/<RootPicker\b/);
		expect(src).toMatch(/import\s+Dashboard\s+from\s+'\.\.\/components\/Dashboard\.svelte'/);
		expect(src).not.toMatch(/RootPicker\.svelte/);
	});

	test('src/components/RootPicker.svelte は無く、Dashboard.svelte がある', () => {
		expect(existsSync(ROOT_PICKER_SVELTE)).toBe(false);
		expect(existsSync(DASHBOARD_SVELTE)).toBe(true);
	});

	test("Dashboard.svelte の一番外の要素の class に root-picker がある((r)=print.css を変えない)", () => {
		const markup = markupOf(readFileSync(DASHBOARD_SVELTE, 'utf-8'));
		// 最初の素の要素(`<svelte:…>` は飛ばす)。属性の中に `>`(矢印関数)があっても拾えるよう、
		// 開始タグは次の `<` までを見る(属性の中に `<` は書けない)。
		const starts = [...markup.matchAll(/<([a-zA-Z][\w-]*)(?=[\s>/])/g)].filter((m) => !m[1]!.startsWith('svelte'));
		expect(starts.length).toBeGreaterThan(0);
		const first = starts[0]!;
		const from = first.index! + first[0].length;
		const nextOpen = markup.indexOf('<', from);
		const attrs = markup.slice(from, nextOpen === -1 ? undefined : nextOpen);
		const classAttr = /\bclass\s*=\s*"([^"]*)"/.exec(attrs);
		expect(classAttr, `the outermost element <${first[1]}> must carry a class attribute`).not.toBeNull();
		expect(classAttr![1]!.split(/\s+/)).toContain('root-picker');
	});

	test('registerDashboardListener( と toggleDashboard( がそれぞれ現れ、$lib/dashboard から import している', () => {
		const src = page();
		expect(src).toMatch(/import\s*\{[^}]*\bregisterDashboardListener\b[^}]*\}\s*from\s*'\$lib\/dashboard'/);
		expect(src).toMatch(/import\s*\{[^}]*\btoggleDashboard\b[^}]*\}\s*from\s*'\$lib\/dashboard'/);
		const importEnd = src.indexOf("'$lib/dashboard'");
		expect(src.indexOf('registerDashboardListener(', importEnd)).toBeGreaterThan(-1);
		expect(src.indexOf('toggleDashboard(', importEnd)).toBeGreaterThan(-1);
	});

	test('Bookmark のストアの init( がページで 1 回', () => {
		const src = page();
		expect(src).toMatch(/from\s*'\.\.\/stores\/bookmarks\.svelte'/);
		const inits = src.match(/\bbookmarks\.init\(/g) ?? [];
		expect(inits).toHaveLength(1);
	});

	test('ズームの対象(zoomTarget)・toggleEditMode・handleMenuFind が rootPicker.open を見る(契約 15 の門)', () => {
		const src = page();
		const zoomAt = src.search(/\blet\s+zoomTarget\s*=\s*\$derived\s*\(/);
		expect(zoomAt, 'let zoomTarget = $derived(…)').toBeGreaterThan(-1);
		const derivedAt = src.indexOf('$derived', zoomAt);
		const zoomExpr = balancedFrom(src, derivedAt, '(');
		expect(zoomExpr).toContain('rootPicker.open');
		expect(functionBody(src, 'toggleEditMode')).toContain('rootPicker.open');
		expect(functionBody(src, 'handleMenuFind')).toContain('rootPicker.open');
	});

	test('ページの状態名 rootPicker と、Dashboard へ渡す error={rootPicker.error}・onPickFolder= は残る(承認 7 と同じ字面)', () => {
		const src = page();
		expect(src).toMatch(/\brootPicker\s*=\s*\{/);
		expect(src).toMatch(/<Dashboard[\s\S]*?error=\{rootPicker\.error\}[\s\S]*?\/>/);
		expect(src).toMatch(/<Dashboard[\s\S]*?onPickFolder=/);
	});
});
