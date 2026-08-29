/**
 * 要件#34 の受け入れテスト(requirements.md #34)— フロント層
 * 「開いているウィンドウと同じ内容の新規ウィンドウを開く複製(Duplicate Window)機能。
 *  メニューバーとファイルツリーの右クリックメニューのどちらからでも起動できる」
 *
 * 契約(2026-08-29 由谷決定):
 * - ①「同じ内容」= {rootUri, docUri, expandedDirs}(reload-state=要件#10 と同じ
 *   3点セット。スクロール位置・マーク一覧開閉はスコープ外・ペイン幅は全窓共有=要件#9)
 * - ② メニューバー= File > Duplicate Window(New Window の直後・CmdOrCtrl+Shift+N)
 * - ③ ツリー側右クリック=アイテムメニュー末尾に区切り+「ウィンドウを複製」+
 *   空白部の右クリックでも同項目(出し分けは context-menu.acceptance.test.ts の持ち場)
 * - ④ root 未設定(履歴選択画面)の窓での複製=履歴選択画面をもう1枚(New Window 相当)
 *
 * 判定範囲(本ファイル): スナップショット → 新窓引数の計画(純関数)と、
 * メニューイベント購読 → invoke('new_window') の実行列。実装先
 * `src/lib/duplicate-window.ts`(新規)。メニュー項目・アクセラレータ・Rust 側 emit・
 * 画面配線(getSnapshot が windowState から現在状態を集めること)は reviewer 照合、
 * 実機の複製結果は人間ゲート(末尾参照)。
 *
 * ## 確定契約(公開 API・implementer はこれに従う)
 *
 * ```ts
 * // Rust メニュー(menu.rs の MENU_DUPLICATE_WINDOW_EVENT)→ Webview の通知イベント名。
 * // フォーカス中ウィンドウ宛の emit_to(menu_open_* と同型=要件#33 の窓限定購読が受信側)。
 * export const MENU_DUPLICATE_WINDOW_EVENT = 'menu_duplicate_window';
 *
 * // 複製元の現在状態。rootUri は未設定(履歴選択画面)のとき null または ''。
 * // 配線側は windowState / Explorer の展開 Set から組む(Set で持つ想定なので Iterable)。
 * type Snapshot = { rootUri: string | null; docUri: string | null; expandedDirs: Iterable<string> };
 *
 * // スナップショット → `invoke('new_window', …)` の引数(純関数)。
 * // - rootUri あり → { path: docUri, root: rootUri, expandedDirs: 重複除去・初出順 }
 * //   (docUri が null なら path: null。expandedDirs の重複除去・初出順は
 * //    reload-state の normalizeExpandedDirs と同じ発想。それ以外の整形 —
 * //    root 配下フィルタ等 — は実装裁量で本テストは判定しない)
 * // - rootUri が null / 空文字 → { path: null, root: null, expandedDirs: [] }
 * //   = New Window 相当(契約④)。docUri は rootUri があるときだけ意味を持つ
 * export function planDuplicateWindow(snapshot: Snapshot):
 *   { path: string | null; root: string | null; expandedDirs: string[] };
 *
 * // イベント購読: $lib/events の listen で MENU_DUPLICATE_WINDOW_EVENT を購読し、
 * // 発火で getSnapshot() → planDuplicateWindow → invoke('new_window', 引数) を実行する。
 * // - getSnapshot は発火のたびに呼ぶ(購読時に固定しない — 複製はその時点の内容)
 * // - 成功時のみ onOpened(引数の形は実装裁量=本テストは呼び出し回数のみ判定)
 * // - 失敗(invoke の reject・getSnapshot の throw)は onError へ渡し、ハンドラの
 * //   外へは投げない。onError 省略時も落とさない(menu-open の家風)
 * // - 返り値は購読を解除する関数
 * export function registerDuplicateWindowListener(handlers: {
 *   getSnapshot: () => Snapshot;
 *   onOpened: (opened: unknown) => void;
 *   onError?: (err: unknown) => void;
 * }): Promise<() => void>;
 * ```
 *
 * invoke は `$lib/ipc`・listen は `$lib/events` の薄いラッパを vi.mock する。
 * 実装側も同じ場所から import すること(menu-open / reload-state と同じ家風)。
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - menu.rs: File > Duplicate Window(New Window の直後・CmdOrCtrl+Shift+N)を追加し、
 *   クリックでフォーカス中ウィンドウへ MENU_DUPLICATE_WINDOW_EVENT を emit_to する
 * - +page.svelte: mount 時に registerDuplicateWindowListener を購読し、getSnapshot が
 *   現在の {rootUri, docUri, expandedDirs} を windowState / Explorer の展開状態から集める。
 *   ツリー右クリックの 'duplicate-window' アクションも同じ複製列(plan → invoke)へ合流する
 * - Rust 側: new_window コマンドが expandedDirs を WindowArgs へ流し、新窓の
 *   init_window が InitWindowResponse.expanded_dirs で返す(acceptance_req34.rs)。
 *   新窓側の初期化(set_root → 文書コマンド → 展開)は reload-state の復元機構を流用
 *
 * ## 人間ゲート(acceptance/acceptance.md)
 * - 実機での複製結果(同 root・同文書・同展開・履歴選択画面の複製・
 *   メニューのアクセラレータ・空白部メニュー)
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('$lib/events', () => ({ listen: vi.fn() }));

import { invoke } from '$lib/ipc';
import { listen } from '$lib/events';
import {
	MENU_DUPLICATE_WINDOW_EVENT,
	planDuplicateWindow,
	registerDuplicateWindowListener,
} from './duplicate-window';

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

/** 複製元の現在状態(契約①の3点セット)。実装の型名には依存しない。 */
type Snapshot = {
	rootUri: string | null;
	docUri: string | null;
	expandedDirs: Iterable<string>;
};

const ROOT_URI = 'file:///Users/a/docs';
const DOC_URI = 'file:///Users/a/docs/plan.md';
const DIRS = ['file:///Users/a/docs/sub', 'file:///Users/a/docs/My Notes'];
const SNAPSHOT: Snapshot = { rootUri: ROOT_URI, docUri: DOC_URI, expandedDirs: DIRS };

/** fire-and-forget なハンドラ実装でも完了を待てるように1マクロタスク挟む(menu-open と同じ)。 */
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
	// 既定: 購読は成功し no-op の unlisten・new_window は新ラベルで解決(必要なテストで上書き)。
	listenMock.mockResolvedValue(() => {});
	invokeMock.mockResolvedValue('vellis-2');
});

// ---------------------------------------------------------------------------
// イベント名 — Rust 側 menu.rs の定数と同じリテラル
// ---------------------------------------------------------------------------

test("イベント名は 'menu_duplicate_window'(menu_open_* と同じ snake_case・Rust 側と同値)", () => {
	expect(MENU_DUPLICATE_WINDOW_EVENT).toBe('menu_duplicate_window');
});

// ---------------------------------------------------------------------------
// planDuplicateWindow — スナップショット → 新窓引数の計画(純関数)
// ---------------------------------------------------------------------------

describe('planDuplicateWindow — 同じ内容の3点セットを new_window 引数へ(契約①)', () => {
	test('root+文書+展開 → { path: docUri, root: rootUri, expandedDirs }', () => {
		expect(planDuplicateWindow(SNAPSHOT)).toEqual({
			path: DOC_URI,
			root: ROOT_URI,
			expandedDirs: DIRS,
		});
	});

	test('文書なし(docUri: null)→ path は null・root と展開は維持', () => {
		expect(
			planDuplicateWindow({ rootUri: ROOT_URI, docUri: null, expandedDirs: DIRS })
		).toEqual({ path: null, root: ROOT_URI, expandedDirs: DIRS });
	});

	test('展開なし → expandedDirs は空配列(発明しない)', () => {
		expect(
			planDuplicateWindow({ rootUri: ROOT_URI, docUri: DOC_URI, expandedDirs: [] })
		).toEqual({ path: DOC_URI, root: ROOT_URI, expandedDirs: [] });
	});

	test('展開の重複は除去し初出順を維持する(normalizeExpandedDirs と同じ発想)', () => {
		const sub = 'file:///Users/a/docs/sub';
		const notes = 'file:///Users/a/docs/My Notes';
		const deep = 'file:///Users/a/docs/sub/deep';
		expect(
			planDuplicateWindow({
				rootUri: ROOT_URI,
				docUri: null,
				expandedDirs: [sub, notes, sub, deep, notes],
			}).expandedDirs
		).toEqual([sub, notes, deep]);
	});

	test('展開は Iterable(配線側の Set)でも受け、配列にして返す', () => {
		expect(
			planDuplicateWindow({ rootUri: ROOT_URI, docUri: null, expandedDirs: new Set(DIRS) })
				.expandedDirs
		).toEqual(DIRS);
	});

	test('root なし(null)→ 全 null+空配列= New Window 相当(契約④)。docUri・展開があっても', () => {
		expect(
			planDuplicateWindow({ rootUri: null, docUri: DOC_URI, expandedDirs: DIRS })
		).toEqual({ path: null, root: null, expandedDirs: [] });
	});

	test("root が空文字 '' でも同じ(init_window 前の未初期化状態)", () => {
		expect(planDuplicateWindow({ rootUri: '', docUri: DOC_URI, expandedDirs: DIRS })).toEqual({
			path: null,
			root: null,
			expandedDirs: [],
		});
	});
});

// ---------------------------------------------------------------------------
// registerDuplicateWindowListener — メニューイベントの購読と実行列
// ---------------------------------------------------------------------------

describe('registerDuplicateWindowListener — 発火 → getSnapshot → invoke(new_window)', () => {
	/** 登録済みハンドラを取り出す(登録順には依存しない)。 */
	const handlerFor = () =>
		listenMock.mock.calls.find((c) => c[0] === MENU_DUPLICATE_WINDOW_EVENT)?.[1];

	test('$lib/events の listen で MENU_DUPLICATE_WINDOW_EVENT を1回だけ購読する', async () => {
		await registerDuplicateWindowListener({ getSnapshot: () => SNAPSHOT, onOpened: vi.fn() });

		expect(listenMock.mock.calls.map((c) => c[0])).toEqual([MENU_DUPLICATE_WINDOW_EVENT]);
	});

	test('購読しただけでは getSnapshot も invoke も呼ばない(複製は発火時)', async () => {
		const getSnapshot = vi.fn(() => SNAPSHOT);
		await registerDuplicateWindowListener({ getSnapshot, onOpened: vi.fn() });

		expect(getSnapshot).not.toHaveBeenCalled();
		expect(invokeMock).not.toHaveBeenCalled();
	});

	test('発火 → getSnapshot → invoke(new_window, {path, root, expandedDirs})→ onOpened', async () => {
		const getSnapshot = vi.fn(() => SNAPSHOT);
		const onOpened = vi.fn();
		await registerDuplicateWindowListener({ getSnapshot, onOpened });

		await handlerFor()?.({ payload: undefined });
		await flushAsync();

		expect(getSnapshot).toHaveBeenCalledTimes(1);
		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock.mock.calls[0]?.[0]).toBe('new_window');
		expect(invokeMock.mock.calls[0]?.[1]).toEqual({
			path: DOC_URI,
			root: ROOT_URI,
			expandedDirs: DIRS,
		});
		expect(onOpened).toHaveBeenCalledTimes(1);
	});

	test('snapshot の重複展開は dedupe した引数で invoke する(plan を経由する)', async () => {
		const sub = 'file:///Users/a/docs/sub';
		await registerDuplicateWindowListener({
			getSnapshot: () => ({ rootUri: ROOT_URI, docUri: null, expandedDirs: [sub, sub] }),
			onOpened: vi.fn(),
		});

		await handlerFor()?.({ payload: undefined });
		await flushAsync();

		expect(invokeMock.mock.calls[0]?.[1]).toEqual({
			path: null,
			root: ROOT_URI,
			expandedDirs: [sub],
		});
	});

	test('root なしの窓でも invoke する — 履歴選択画面をもう1枚(契約④・グレーアウトしない)', async () => {
		const onOpened = vi.fn();
		await registerDuplicateWindowListener({
			getSnapshot: () => ({ rootUri: null, docUri: null, expandedDirs: [] }),
			onOpened,
		});

		await handlerFor()?.({ payload: undefined });
		await flushAsync();

		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock.mock.calls[0]?.[0]).toBe('new_window');
		expect(invokeMock.mock.calls[0]?.[1]).toEqual({ path: null, root: null, expandedDirs: [] });
		expect(onOpened).toHaveBeenCalledTimes(1);
	});

	test('発火のたびに getSnapshot を読み直す(複製はその時点の内容=購読時に固定しない)', async () => {
		let current: Snapshot = SNAPSHOT;
		const getSnapshot = vi.fn(() => current);
		await registerDuplicateWindowListener({ getSnapshot, onOpened: vi.fn() });

		await handlerFor()?.({ payload: undefined });
		await flushAsync();
		current = { rootUri: 'file:///Users/b/notes', docUri: null, expandedDirs: [] };
		await handlerFor()?.({ payload: undefined });
		await flushAsync();

		expect(getSnapshot).toHaveBeenCalledTimes(2);
		expect(invokeMock.mock.calls.map((c) => c[1])).toEqual([
			{ path: DOC_URI, root: ROOT_URI, expandedDirs: DIRS },
			{ path: null, root: 'file:///Users/b/notes', expandedDirs: [] },
		]);
	});

	test('new_window 失敗 → onError に渡り onOpened は呼ばれない(ハンドラ外へ投げない)', async () => {
		const onOpened = vi.fn();
		const onError = vi.fn();
		await registerDuplicateWindowListener({ getSnapshot: () => SNAPSHOT, onOpened, onError });
		const failure = new Error('window creation failed');
		invokeMock.mockRejectedValueOnce(failure);

		// ここで reject が漏れたらテスト自体が失敗する=「外へ投げない」の判定を兼ねる。
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
		await registerDuplicateWindowListener({
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
		await registerDuplicateWindowListener({ getSnapshot: () => SNAPSHOT, onOpened: vi.fn() });
		invokeMock.mockRejectedValueOnce(new Error('window creation failed'));

		await handlerFor()?.({ payload: undefined });
		await flushAsync();
	});

	test('返り値の解除関数で unlisten が呼ばれる', async () => {
		const unlisten = vi.fn();
		listenMock.mockResolvedValue(unlisten);

		const dispose = await registerDuplicateWindowListener({
			getSnapshot: () => SNAPSHOT,
			onOpened: vi.fn(),
		});
		dispose();

		expect(unlisten).toHaveBeenCalledTimes(1);
	});
});
