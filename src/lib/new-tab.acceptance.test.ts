/**
 * 要件#62 の受け入れテスト(docs/requirements/req-62.md)— 新しいタブの計画と実行列
 * (AC-62-8〜10・AC-62-14 のフロント側。契約 3・4・11)
 *
 * 「タブで1つのウィンドウに複数のファイルを開く」— タブの実体は macOS 標準の
 * ウィンドウタブ(1タブ=既存の Vellis ウィンドウ1枚・契約1【(a) 確定】)。
 * 新しいタブは Rust の新規 command `new_tab` 1本で開く(`create_window` で窓を作り、
 * 呼んだ窓の NSWindow に `addTabbedWindow:ordered:` で加える=契約4)。
 *
 * 判定範囲(本ファイル): 計画の純関数 `planNewTab` と、`invoke('new_tab', …)` の実行列、
 * File ▸ New Tab(`menu_new_tab`)の購読。実装先 `src/lib/new-tab.ts`(新規)。
 * ツリーの Command+クリックの配線は Explorer.newtab.wiring.test.ts、右クリック
 * 「Open in New Tab」の項目と計画は context-menu.acceptance.test.ts(契約12の更新)、
 * Rust 側(鍵・メニュー定数・生成経路の走査)は src-tauri/tests/acceptance_req62.rs。
 *
 * ## 確定契約(公開 API・implementer はこれに従う)
 *
 * ```ts
 * // --- 新規 src/lib/new-tab.ts ---
 * // Rust メニュー(menu.rs の MENU_NEW_TAB_EVENT)→ Webview の通知イベント名。
 * // フォーカス中ウィンドウ宛の emit_to(menu_duplicate_window と同型)。
 * export const MENU_NEW_TAB_EVENT = 'menu_new_tab';
 *
 * // 今の窓の状態(duplicate-window の DuplicateSnapshot と同じ3点セットの形)。
 * // rootUri は未設定(履歴選択画面)のとき null または ''。
 * export type NewTabSnapshot = {
 *   rootUri: string | null;
 *   docUri: string | null;
 *   expandedDirs: Iterable<string>;
 * };
 *
 * // `new_tab` に渡す引数。Rust 側は verbatim に登録する(要件#34 の Rust 契約と同じ)。
 * export type NewTabArgs = { root: string; path: string | null; expandedDirs: string[] };
 *
 * // スナップショット → `new_tab` の引数(純関数)。
 * // - rootUri あり → { root: rootUri, path: docUri, expandedDirs: normalizeExpandedDirs(root, dirs) }
 * //   (展開の整形= reload-state の normalizeExpandedDirs と同じ規則: 重複除去・初出順・
 * //    末尾スラッシュ除去・root 配下のみ・root 自身は除く=契約4)
 * // - rootUri が null / '' → null(何もしない=履歴選択画面では並べる root が無い・契約3)
 * export function planNewTab(snapshot: NewTabSnapshot): NewTabArgs | null;
 *
 * // 計画 → invoke('new_tab', { path, root, expandedDirs }) を1回。解決値(新しい
 * // 窓=タブのラベル)をそのまま返す。new_window / set_root は呼ばない。
 * // 失敗は reject をそのまま伝える(catch と alert は +page.svelte の合流点=
 * // duplicateWindow / openInNewWindow とまったく同じ分担。reviewer 照合)。
 * export function openNewTab<Label = string>(plan: NewTabArgs): Promise<Label>;
 *
 * // 失敗 alert の文言(要件#35 ③・要件#51=英語。duplicateWindowFailedMessage と同じ形)。
 * export function newTabFailedMessage(err: unknown): string;
 * // => `Could not open a new tab: ${err}`
 *
 * // メニュー起点(契約3): $lib/events の listen で MENU_NEW_TAB_EVENT を購読し、
 * // 発火で getSnapshot() → planNewTab({ …snapshot, docUri: null }) → openNewTab を実行する。
 * // - 文書は引き継がない(Command+T は空のタブ=契約4「⌘T では無し」)。
 *   // - getSnapshot は発火のたびに呼ぶ(購読時に固定しない)
 * // - root の無い窓(plan が null)では invoke しない・onOpened も呼ばない
 * // - 成功時のみ onOpened。失敗(invoke の reject・getSnapshot の throw)は onError へ渡し、
 * //   ハンドラの外へは投げない。onError 省略時も落とさない(registerDuplicateWindowListener の家風)
 * // - 返り値は購読を解除する関数
 * export function registerNewTabListener(handlers: {
 *   getSnapshot: () => NewTabSnapshot;
 *   onOpened: (opened: unknown) => void;
 *   onError?: (err: unknown) => void;
 * }): Promise<() => void>;
 * ```
 *
 * invoke は `$lib/ipc`・listen は `$lib/events` の薄いラッパを vi.mock する。
 * 実装側も同じ場所から import すること(duplicate-window と同じ家風)。
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - +page.svelte: mount 時に registerNewTabListener を購読し、getSnapshot が現在の
 *   { rootUri, docUri, expandedDirs } を windowState から集める(currentSnapshot の流用可)。
 *   失敗は alert(newTabFailedMessage(err))
 * - Explorer.svelte の Command+クリック・ContextMenu の「Open in New Tab」が同じ
 *   planNewTab → openNewTab の列へ合流する
 * - Rust 側 `new_tab` command の実体(create_window + addTabbedWindow)
 *
 * ## 人間ゲート(acceptance/acceptance.md 要件#62 — AppKit の実挙動)
 * - 実機で今の窓のタブとして右隣に開くこと・展開が引き継がれること・
 *   ドラッグでの取り出しと戻す・Merge All Windows・root が違う窓へ戻せないこと
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('$lib/events', () => ({ listen: vi.fn() }));

import { invoke } from '$lib/ipc';
import { listen } from '$lib/events';
import { normalizeExpandedDirs } from '$lib/reload-state';
import {
	MENU_NEW_TAB_EVENT,
	newTabFailedMessage,
	openNewTab,
	planNewTab,
	registerNewTabListener,
} from './new-tab';

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

const REPO_ROOT = resolve(__dirname, '../..');

/** 今の窓の状態(3点セット)。実装の型名には依存しない。 */
type Snapshot = {
	rootUri: string | null;
	docUri: string | null;
	expandedDirs: Iterable<string>;
};

const ROOT_URI = 'file:///Users/a/docs';
const DOC_URI = 'file:///Users/a/docs/plan.md';
const SUB = 'file:///Users/a/docs/sub';
const NOTES = 'file:///Users/a/docs/My Notes';
const DEEP = 'file:///Users/a/docs/sub/deep';
const DIRS = [SUB, NOTES];
const SNAPSHOT: Snapshot = { rootUri: ROOT_URI, docUri: DOC_URI, expandedDirs: DIRS };

/** fire-and-forget なハンドラ実装でも完了を待てるように1マクロタスク挟む。 */
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
	listenMock.mockResolvedValue(() => {});
	invokeMock.mockResolvedValue('vellis-2');
});

// ---------------------------------------------------------------------------
// イベント名 — Rust 側 menu.rs の MENU_NEW_TAB_EVENT と同じリテラル
// ---------------------------------------------------------------------------

test("イベント名は 'menu_new_tab'(menu_duplicate_window と同じ snake_case・Rust 側と同値)", () => {
	expect(MENU_NEW_TAB_EVENT).toBe('menu_new_tab');
});

// ---------------------------------------------------------------------------
// AC-62-8 — planNewTab: スナップショット → new_tab 引数(契約4)
// ---------------------------------------------------------------------------

describe('AC-62-8: planNewTab — 今の窓の root・文書・展開を new_tab の引数へ(契約4)', () => {
	test('root+文書+展開 → { root, path: docUri, expandedDirs }', () => {
		expect(planNewTab(SNAPSHOT)).toEqual({ root: ROOT_URI, path: DOC_URI, expandedDirs: DIRS });
	});

	test('文書なし(docUri: null)→ path は null・root と展開は維持(Command+T の形)', () => {
		expect(planNewTab({ rootUri: ROOT_URI, docUri: null, expandedDirs: DIRS })).toEqual({
			root: ROOT_URI,
			path: null,
			expandedDirs: DIRS,
		});
	});

	test('展開なし → expandedDirs は空配列(発明しない)', () => {
		expect(planNewTab({ rootUri: ROOT_URI, docUri: DOC_URI, expandedDirs: [] })).toEqual({
			root: ROOT_URI,
			path: DOC_URI,
			expandedDirs: [],
		});
	});

	test('展開の重複は除去し初出順を維持する(normalizeExpandedDirs と同じ)', () => {
		expect(
			planNewTab({ rootUri: ROOT_URI, docUri: null, expandedDirs: [SUB, NOTES, SUB, DEEP, NOTES] })
				?.expandedDirs
		).toEqual([SUB, NOTES, DEEP]);
	});

	test('root 配下でない展開と root 自身は落とす(normalizeExpandedDirs と同じ)', () => {
		const outside = 'file:///Users/a/other';
		expect(
			planNewTab({ rootUri: ROOT_URI, docUri: null, expandedDirs: [outside, ROOT_URI, SUB] })
				?.expandedDirs
		).toEqual([SUB]);
	});

	test('整形は normalizeExpandedDirs と完全に同じ結果(末尾スラッシュ・重複・root 外の混在)', () => {
		const messy = [`${SUB}/`, SUB, `${ROOT_URI}/`, 'file:///Users/a/elsewhere', NOTES, DEEP];
		expect(planNewTab({ rootUri: ROOT_URI, docUri: null, expandedDirs: messy })?.expandedDirs).toEqual(
			normalizeExpandedDirs(ROOT_URI, messy)
		);
	});

	test('展開は Iterable(配線側の Set)でも受け、配列にして返す', () => {
		expect(
			planNewTab({ rootUri: ROOT_URI, docUri: null, expandedDirs: new Set(DIRS) })?.expandedDirs
		).toEqual(DIRS);
	});

	test('root なし(null)→ null=何もしない(履歴選択画面には並べる root が無い・契約3)', () => {
		expect(planNewTab({ rootUri: null, docUri: DOC_URI, expandedDirs: DIRS })).toBeNull();
	});

	test("root が空文字 '' でも null(init_window 前の未初期化状態)", () => {
		expect(planNewTab({ rootUri: '', docUri: DOC_URI, expandedDirs: DIRS })).toBeNull();
	});

	test('ssh の root でも同じ形(特別扱いしない)', () => {
		const sshRoot = 'ssh://alice@host:22/srv/notes';
		expect(
			planNewTab({
				rootUri: sshRoot,
				docUri: `${sshRoot}/plan.md`,
				expandedDirs: [`${sshRoot}/sub`],
			})
		).toEqual({ root: sshRoot, path: `${sshRoot}/plan.md`, expandedDirs: [`${sshRoot}/sub`] });
	});
});

// ---------------------------------------------------------------------------
// AC-62-9 — openNewTab: new_tab を1回・new_window / set_root は呼ばない(契約4)
// ---------------------------------------------------------------------------

describe('AC-62-9: openNewTab — invoke(new_tab, { path, root, expandedDirs }) を1回だけ(契約4)', () => {
	test("計画 → invoke('new_tab', { path, root, expandedDirs }) を1回", async () => {
		await openNewTab({ root: ROOT_URI, path: DOC_URI, expandedDirs: DIRS });

		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock.mock.calls[0]?.[0]).toBe('new_tab');
		expect(invokeMock.mock.calls[0]?.[1]).toEqual({
			path: DOC_URI,
			root: ROOT_URI,
			expandedDirs: DIRS,
		});
	});

	test('文書なしの計画 → path: null のまま渡す', async () => {
		await openNewTab({ root: ROOT_URI, path: null, expandedDirs: [] });

		expect(invokeMock.mock.calls[0]?.[1]).toEqual({ path: null, root: ROOT_URI, expandedDirs: [] });
	});

	test('解決値(新しいタブのラベル)をそのまま返す', async () => {
		invokeMock.mockResolvedValueOnce('vellis-7');
		await expect(openNewTab({ root: ROOT_URI, path: null, expandedDirs: [] })).resolves.toBe(
			'vellis-7'
		);
	});

	test('new_window と set_root は呼ばない(タブに加えるのは Rust の new_tab の仕事)', async () => {
		await openNewTab({ root: ROOT_URI, path: DOC_URI, expandedDirs: DIRS });

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['new_tab']);
	});

	test('invoke の reject はそのまま伝わる(合流点の catch → alert が受ける)', async () => {
		const failure = new Error('window creation failed');
		invokeMock.mockRejectedValueOnce(failure);

		await expect(openNewTab({ root: ROOT_URI, path: null, expandedDirs: [] })).rejects.toBe(failure);
		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['new_tab']);
	});

	test("失敗の文言は 'Could not open a new tab: <err>'(値固定・英語=要件#51)", () => {
		expect(newTabFailedMessage('no window')).toBe('Could not open a new tab: no window');
	});

	test('Error オブジェクトは文字列化して挟む(duplicateWindowFailedMessage と同じ形)', () => {
		expect(newTabFailedMessage(new Error('boom'))).toBe('Could not open a new tab: Error: boom');
	});
});

// ---------------------------------------------------------------------------
// AC-62-10 — registerNewTabListener: menu_new_tab → 今の root・展開で new_tab(契約3)
// ---------------------------------------------------------------------------

describe('AC-62-10: registerNewTabListener — 発火 → getSnapshot → invoke(new_tab)・文書は null(契約3)', () => {
	const handlerFor = () => listenMock.mock.calls.find((c) => c[0] === MENU_NEW_TAB_EVENT)?.[1];

	test('$lib/events の listen で MENU_NEW_TAB_EVENT を1回だけ購読する', async () => {
		await registerNewTabListener({ getSnapshot: () => SNAPSHOT, onOpened: vi.fn() });

		expect(listenMock.mock.calls.map((c) => c[0])).toEqual([MENU_NEW_TAB_EVENT]);
	});

	test('購読しただけでは getSnapshot も invoke も呼ばない(発火時に読む)', async () => {
		const getSnapshot = vi.fn(() => SNAPSHOT);
		await registerNewTabListener({ getSnapshot, onOpened: vi.fn() });

		expect(getSnapshot).not.toHaveBeenCalled();
		expect(invokeMock).not.toHaveBeenCalled();
	});

	test('発火 → その時点の root・展開で new_tab・文書は null(文書を開いていても引き継がない)→ onOpened', async () => {
		const getSnapshot = vi.fn(() => SNAPSHOT);
		const onOpened = vi.fn();
		await registerNewTabListener({ getSnapshot, onOpened });

		await handlerFor()?.({ payload: undefined });
		await flushAsync();

		expect(getSnapshot).toHaveBeenCalledTimes(1);
		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock.mock.calls[0]?.[0]).toBe('new_tab');
		expect(invokeMock.mock.calls[0]?.[1]).toEqual({ path: null, root: ROOT_URI, expandedDirs: DIRS });
		expect(onOpened).toHaveBeenCalledTimes(1);
	});

	test('展開は plan を経由して整形される(重複除去)', async () => {
		await registerNewTabListener({
			getSnapshot: () => ({ rootUri: ROOT_URI, docUri: null, expandedDirs: [SUB, SUB] }),
			onOpened: vi.fn(),
		});

		await handlerFor()?.({ payload: undefined });
		await flushAsync();

		expect(invokeMock.mock.calls[0]?.[1]).toEqual({ path: null, root: ROOT_URI, expandedDirs: [SUB] });
	});

	test('root の無い窓(履歴選択画面)では invoke しない・onOpened も呼ばない', async () => {
		const onOpened = vi.fn();
		await registerNewTabListener({
			getSnapshot: () => ({ rootUri: null, docUri: null, expandedDirs: [] }),
			onOpened,
		});

		await handlerFor()?.({ payload: undefined });
		await flushAsync();

		expect(invokeMock).not.toHaveBeenCalled();
		expect(onOpened).not.toHaveBeenCalled();
	});

	test("root が '' の窓でも invoke しない", async () => {
		await registerNewTabListener({
			getSnapshot: () => ({ rootUri: '', docUri: DOC_URI, expandedDirs: DIRS }),
			onOpened: vi.fn(),
		});

		await handlerFor()?.({ payload: undefined });
		await flushAsync();

		expect(invokeMock).not.toHaveBeenCalled();
	});

	test('発火のたびに getSnapshot を読み直す(その時点の root・展開)', async () => {
		let current: Snapshot = SNAPSHOT;
		const getSnapshot = vi.fn(() => current);
		await registerNewTabListener({ getSnapshot, onOpened: vi.fn() });

		await handlerFor()?.({ payload: undefined });
		await flushAsync();
		current = { rootUri: 'file:///Users/b/notes', docUri: null, expandedDirs: [] };
		await handlerFor()?.({ payload: undefined });
		await flushAsync();

		expect(getSnapshot).toHaveBeenCalledTimes(2);
		expect(invokeMock.mock.calls.map((c) => c[1])).toEqual([
			{ path: null, root: ROOT_URI, expandedDirs: DIRS },
			{ path: null, root: 'file:///Users/b/notes', expandedDirs: [] },
		]);
	});

	test('new_tab 失敗 → onError に渡り onOpened は呼ばれない(ハンドラ外へ投げない)', async () => {
		const onOpened = vi.fn();
		const onError = vi.fn();
		await registerNewTabListener({ getSnapshot: () => SNAPSHOT, onOpened, onError });
		const failure = new Error('window creation failed');
		invokeMock.mockRejectedValueOnce(failure);

		await handlerFor()?.({ payload: undefined });
		await flushAsync();

		expect(onOpened).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0]?.[0]).toBe(failure);
	});

	test('getSnapshot が throw しても onError 経由(invoke は呼ばない)', async () => {
		const onOpened = vi.fn();
		const onError = vi.fn();
		const failure = new Error('state unavailable');
		await registerNewTabListener({
			getSnapshot: () => {
				throw failure;
			},
			onOpened,
			onError,
		});

		await handlerFor()?.({ payload: undefined });
		await flushAsync();

		expect(invokeMock).not.toHaveBeenCalled();
		expect(onOpened).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0]?.[0]).toBe(failure);
	});

	test('onError 省略時も失敗で落ちない(unhandled rejection にしない)', async () => {
		await registerNewTabListener({ getSnapshot: () => SNAPSHOT, onOpened: vi.fn() });
		invokeMock.mockRejectedValueOnce(new Error('window creation failed'));

		await handlerFor()?.({ payload: undefined });
		await flushAsync();
	});

	test('返り値の解除関数で unlisten が呼ばれる', async () => {
		const unlisten = vi.fn();
		listenMock.mockResolvedValue(unlisten);

		const dispose = await registerNewTabListener({ getSnapshot: () => SNAPSHOT, onOpened: vi.fn() });
		dispose();

		expect(unlisten).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// AC-62-14 — 不変(契約11): capability と package.json は登録時点と同一
// ---------------------------------------------------------------------------

describe('AC-62-14: capabilities/default.json と package.json は無改変(契約11)', () => {
	test('capabilities/default.json の permission 一覧が登録時点と同一(new_tab はアプリの command=capability 不要)', () => {
		const capability = JSON.parse(
			readFileSync(resolve(REPO_ROOT, 'src-tauri/capabilities/default.json'), 'utf-8')
		) as { permissions: Array<string | { identifier: string }> };
		const identifiers = capability.permissions.map((p) =>
			typeof p === 'string' ? p : p.identifier
		);
		// 要件#62 登録時点(2026-09-23)の permission 一覧(この順)。追加も削除も並べ替えもしない。
		expect(identifiers).toEqual([
			'core:default',
			'opener:allow-open-url',
			'opener:allow-reveal-item-in-dir',
			'opener:allow-open-path',
			'dialog:default',
			'window-state:default',
			'core:window:allow-destroy',
		]);
	});

	test('package.json の依存キーが登録時点と同一(runtime / dev とも)', () => {
		const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8')) as {
			dependencies: Record<string, string>;
			devDependencies: Record<string, string>;
		};
		// 要件#62 登録時点(2026-09-23)の依存(AC-59-14 と同じ固定方式)。
		expect(Object.keys(pkg.dependencies).sort()).toEqual(
			[
				'@shikijs/rehype',
				'@tauri-apps/api',
				'@tauri-apps/plugin-dialog',
				'@tauri-apps/plugin-opener',
				'hast-util-to-mdast',
				'mdast-util-to-markdown',
				'mdast-util-to-string',
				'mermaid',
				'rehype-parse',
				'rehype-raw',
				'rehype-sanitize',
				'rehype-stringify',
				'remark-gfm',
				'remark-parse',
				'remark-rehype',
				'three',
				'unified',
				'unist-util-visit',
			].sort()
		);
		expect(Object.keys(pkg.devDependencies).sort()).toEqual(
			[
				'@sveltejs/adapter-static',
				'@sveltejs/kit',
				'@sveltejs/vite-plugin-svelte',
				'@tauri-apps/cli',
				'@testing-library/svelte',
				'@testing-library/user-event',
				'@types/hast',
				'@types/mdast',
				'@types/node',
				'@types/three',
				'@wdio/cli',
				'@wdio/globals',
				'@wdio/local-runner',
				'@wdio/mocha-framework',
				'@wdio/spec-reporter',
				'expect-webdriverio',
				'happy-dom',
				'jsdom',
				'shiki',
				'svelte',
				'svelte-check',
				'tsx',
				'typescript',
				'vite',
				'vitest',
				'webdriverio',
			].sort()
		);
	});
});
