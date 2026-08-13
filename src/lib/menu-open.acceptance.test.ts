/**
 * 要件#11 の受け入れテスト(requirements.md #11)
 * 「File メニューの Open でファイル/フォルダを現在のウインドウで開き直せる」
 *
 * 契約(2026-08-09 由谷決定=2項目案・root=常に親へ切替):
 * - File メニューに Open…(CmdOrCtrl+O=ファイル選択ダイアログ)と
 *   Open Folder…(CmdOrCtrl+Shift+O=フォルダ選択ダイアログ)の2項目
 *   (plugin-dialog は1ダイアログでファイル/フォルダの同時選択不可のため分割)
 * - ファイル選択時=root を親フォルダへ切替+当該ファイルを開く
 *   (要件#5 と同じ導出。現 root 配下でも常に親へ)
 * - フォルダ選択時=root を当該フォルダへ切替
 * - 履歴記録は set_root 経由(要件#3。ファイル時は親を記録=#5 踏襲)
 * - キャンセル=無変化
 *
 * 判定範囲(本ファイル): フロント側 VM ロジック=ダイアログ結果 → root 導出 →
 * 呼ぶべきコマンド列。実装先 `src/lib/menu-open.ts`(新規)。
 * メニュー項目・アクセラレータ・Rust 側 emit・画面配線は reviewer 照合、
 * 実ダイアログ操作は人間ゲート(末尾参照)。
 *
 * ## 確定契約(公開 API・implementer はこれに従う)
 *
 * パス→URI 変換: ダイアログが返す絶対パスに `file://` を前置した生文字列
 * (percent-encode しない。+page.svelte の pickFolderAndSetRoot / backend の
 *  `format!("file://{}", …)` と同じ規約。スペース等もそのまま)。
 *
 * 1. `planMenuOpen(kind: 'file' | 'folder', selected: string | string[] | null)
 *      : { rootUri: string; docUri: string | null } | null`
 *    - 純関数。ダイアログ結果から実行計画を導出する(lessons「同じ判定は純関数で共有」)
 *    - kind='file'・パス選択 → rootUri=親ディレクトリの URI・docUri=当該ファイルの URI
 *      (要件#5 の「root=親ディレクトリ」導出と同じ)。file/folder の別はダイアログ種別が
 *      正であり、拡張子ヒューリスティック(uri_looks_like_dir)は使わない —
 *      拡張子なしのファイルを選んでもファイルとして扱う
 *    - kind='folder'・パス選択 → rootUri=当該フォルダの URI・docUri=null
 *    - null(キャンセル)→ null。string[] 等の非文字列も null
 *      (既存 pickFolderAndSetRoot の `typeof selected !== 'string'` ガードと同じ家風)
 *    - 現在の root を入力に取らない=「現 root 配下でも常に親へ」を API の形で担保する
 *      (root との位置関係で分岐する余地を残さない)
 *    - 返りオブジェクトへの追加フィールドは実装の自由(rootUri / docUri の意味は上記固定)
 * 2. `openFileFromMenu(): Promise<{ root: unknown; document: unknown } | null>`
 *    - `@tauri-apps/plugin-dialog` の `open` をファイル選択で開く
 *      (directory・multiple とも truthy でない。タイトル・フィルタ等は実装の自由)
 *    - 選択 → `invoke('set_root', { uri: 親 })` → `invoke('open_document', { uri: 当該 })`
 *      の順に呼び、`{ root: set_root の解決値, document: open_document の解決値 }` を返す
 *      (追加フィールドは実装の自由)。履歴記録は set_root の backend 側 record_root が
 *      担う(要件#3・acceptance_req3.rs)ので、フロントの機械判定点は
 *      「set_root を経由すること」
 *    - キャンセル → invoke を一切呼ばず null(=無変化)
 *    - set_root 失敗(フォルダ消失等)→ そのまま reject し、open_document は呼ばない
 *      (root-picker の openHistoryEntry と同じ家風。握りつぶさず UI 側の対処に委ねる)
 *    - open_document 失敗時の挙動は契約外=実装の自由(本テストは判定しない)
 * 3. `openFolderFromMenu(): Promise<{ root: unknown; document: null } | null>`
 *    - `open` をフォルダ選択(directory: true・multiple は truthy でない)で開く
 *    - 選択 → `invoke('set_root', { uri: 当該フォルダ })` のみ。open_document は呼ばない
 *    - キャンセル → invoke を一切呼ばず null
 * 4. `MENU_OPEN_FILE_EVENT = 'menu_open_file'` /
 *    `MENU_OPEN_FOLDER_EVENT = 'menu_open_folder'`(exported const)
 *    - Rust メニューから frontend への通知イベント名。既存イベント
 *      (root_changed / file_changed / show_marks …)と同じ snake_case。
 *      Rust 側 menu.rs がこの名前で focused window へ emit すること自体は reviewer 照合
 * 5. `registerMenuOpenListeners(handlers: {
 *      onOpened: (opened: { root: unknown; document: unknown | null }) => void;
 *      onError?: (err: unknown) => void;
 *    }): Promise<() => void>`
 *    - `$lib/events` の `listen` で上記2イベントを購読する(payload は使わない —
 *      Rust 側はペイロードなしで emit する想定)
 *    - file イベント → openFileFromMenu 相当・folder イベント → openFolderFromMenu 相当を
 *      実行し、成功時のみ onOpened に結果(上記の形)を渡す。キャンセル時は何も呼ばない
 *    - 失敗は onError へ渡し、イベントハンドラの外へは投げない(onError 省略時も落とさない
 *      — メニュー起点の失敗が unhandled rejection にならないこと)
 *    - 登録するハンドラは処理完了で解決する Promise を返してよい(本テストは
 *      await+マイクロタスクのフラッシュで完了を待つ)
 *    - 返り値は両購読をまとめて解除する関数
 *
 * invoke は `$lib/ipc`・listen は `$lib/events` の薄いラッパを vi.mock する。
 * 実装側も同じ場所から import すること(root-picker / reload-state と同じ家風)。
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - menu.rs: File メニューに Open…(CmdOrCtrl+O)と Open Folder…(CmdOrCtrl+Shift+O)の
 *   2項目を追加し、クリックで focused window へ MENU_OPEN_FILE_EVENT /
 *   MENU_OPEN_FOLDER_EVENT を emit する(show_marks の emit_to と同じ流儀)
 * - +page.svelte: mount 時に registerMenuOpenListeners を購読し、onOpened で
 *   windowState への反映(applyRoot → document があれば setDocument)・onError で
 *   ユーザーへの通知を行う。履歴選択画面(要件#4)表示中の扱いも配線側
 * - capabilities: dialog:default は導入済み(要件#4 のフォルダ選択フォールバック)
 *
 * ## 人間ゲート(acceptance/acceptance.md)
 * - 実メニュー・実ダイアログの操作(Open…/Open Folder…・アクセラレータ・キャンセル)
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('$lib/events', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

import { invoke } from '$lib/ipc';
import { listen } from '$lib/events';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
	MENU_OPEN_FILE_EVENT,
	MENU_OPEN_FOLDER_EVENT,
	openFileFromMenu,
	openFolderFromMenu,
	planMenuOpen,
	registerMenuOpenListeners,
} from './menu-open';

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
// plugin-dialog の `open` は overload された条件付き返り型なので、テストで扱いやすい
// 単純なシグネチャへ寄せてモックする(multiple:false 相当= string | null が本線)。
const dialogMock = openDialog as unknown as Mock<
	(options?: Record<string, unknown>) => Promise<string | string[] | null>
>;

// ダイアログが返すのは URI ではなく絶対パス(plugin-dialog の仕様)。
const FILE_PATH = '/Users/a/docs/plan.md';
const FILE_URI = 'file:///Users/a/docs/plan.md';
const PARENT_URI = 'file:///Users/a/docs';
const FOLDER_PATH = '/Users/a/docs';
const FOLDER_URI = 'file:///Users/a/docs';

// backend ペイロードの代表形(root-picker / reload-state のテストと同じ想定)。
const rootPayload = { root_uri: PARENT_URI, entries: [], document_retained: false };
const docPayload = { uri: FILE_URI, content: '# plan', modified: null };

/**
 * fire-and-forget なハンドラ実装でも完了を待てるように1マクロタスク挟む。
 * ダイアログ・invoke のモックは即解決なので、await 連鎖のマイクロタスクは
 * setTimeout(0) のコールバックが走る前にすべて掃ける。
 */
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	invokeMock.mockReset();
	dialogMock.mockReset();
	listenMock.mockReset();
	// 既定: 購読は成功し、no-op の unlisten を返す(必要なテストで上書きする)。
	listenMock.mockResolvedValue(() => {});
});

// ---------------------------------------------------------------------------
// planMenuOpen — ダイアログ結果 → 実行計画の純関数
// ---------------------------------------------------------------------------

describe('planMenuOpen — ダイアログ結果から実行計画を導出する純関数', () => {
	test('ファイル選択 → root は親ディレクトリ・doc は当該ファイル(要件#5 と同じ導出)', () => {
		expect(planMenuOpen('file', FILE_PATH)).toMatchObject({
			rootUri: PARENT_URI,
			docUri: FILE_URI,
		});
	});

	test('スペースを含むパスも生のまま URI にする(percent-encode しない)', () => {
		expect(planMenuOpen('file', '/Users/a/My Docs/read me.md')).toMatchObject({
			rootUri: 'file:///Users/a/My Docs',
			docUri: 'file:///Users/a/My Docs/read me.md',
		});
	});

	test('拡張子なしのファイルでもファイル扱い(ダイアログ種別が正・#5 ヒューリスティックは使わない)', () => {
		expect(planMenuOpen('file', '/Users/a/docs/README')).toMatchObject({
			rootUri: PARENT_URI,
			docUri: 'file:///Users/a/docs/README',
		});
	});

	test("ルート直下のファイル '/plan.md' → 親は 'file:///'(境界)", () => {
		expect(planMenuOpen('file', '/plan.md')).toMatchObject({
			rootUri: 'file:///',
			docUri: 'file:///plan.md',
		});
	});

	test('フォルダ選択 → root は当該フォルダ・doc なし', () => {
		expect(planMenuOpen('folder', FOLDER_PATH)).toMatchObject({
			rootUri: FOLDER_URI,
			docUri: null,
		});
	});

	test('スペースを含むフォルダ名も生のまま root URI にする', () => {
		expect(planMenuOpen('folder', '/Users/a/My Docs')).toMatchObject({
			rootUri: 'file:///Users/a/My Docs',
			docUri: null,
		});
	});

	test('キャンセル(null)→ null(無変化の判定点)', () => {
		expect(planMenuOpen('file', null)).toBeNull();
		expect(planMenuOpen('folder', null)).toBeNull();
	});

	test('非文字列(string[] 等)も null(pickFolderAndSetRoot と同じ防御ガード)', () => {
		expect(planMenuOpen('file', [FILE_PATH])).toBeNull();
		expect(planMenuOpen('folder', [FOLDER_PATH])).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// openFileFromMenu — Open…(ファイル選択)の実行列
// ---------------------------------------------------------------------------

describe('openFileFromMenu — ファイル選択 → set_root(親) → open_document', () => {
	test('ダイアログはファイル選択・単一選択で開く(directory / multiple が truthy でない)', async () => {
		dialogMock.mockResolvedValueOnce(null);

		await openFileFromMenu();

		expect(dialogMock).toHaveBeenCalledTimes(1);
		const opts = dialogMock.mock.calls[0]?.[0] ?? {};
		expect(Boolean(opts['directory'])).toBe(false);
		expect(Boolean(opts['multiple'])).toBe(false);
	});

	test('選択 → set_root(親)→ open_document(当該)の順で呼び、両解決値を返す', async () => {
		dialogMock.mockResolvedValueOnce(FILE_PATH);
		invokeMock.mockResolvedValueOnce(rootPayload).mockResolvedValueOnce(docPayload);

		const res = await openFileFromMenu();

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['set_root', 'open_document']);
		expect(invokeMock.mock.calls[0]?.[1]).toEqual({ uri: PARENT_URI });
		expect(invokeMock.mock.calls[1]?.[1]).toEqual({ uri: FILE_URI });
		expect(res).not.toBeNull();
		expect(res).toMatchObject({ root: rootPayload, document: docPayload });
	});

	test('スペースを含むパスも生 URI のまま set_root / open_document へ渡す', async () => {
		dialogMock.mockResolvedValueOnce('/Users/a/My Docs/read me.md');
		invokeMock
			.mockResolvedValueOnce({ root_uri: 'file:///Users/a/My Docs', entries: [], document_retained: false })
			.mockResolvedValueOnce({ uri: 'file:///Users/a/My Docs/read me.md', content: '', modified: null });

		await openFileFromMenu();

		expect(invokeMock.mock.calls[0]?.[1]).toEqual({ uri: 'file:///Users/a/My Docs' });
		expect(invokeMock.mock.calls[1]?.[1]).toEqual({ uri: 'file:///Users/a/My Docs/read me.md' });
	});

	test('キャンセル → invoke を一切呼ばず null(無変化)', async () => {
		dialogMock.mockResolvedValueOnce(null);

		await expect(openFileFromMenu()).resolves.toBeNull();
		expect(invokeMock).not.toHaveBeenCalled();
	});

	test('set_root 失敗(親フォルダを開けない)→ そのまま reject し open_document は呼ばない', async () => {
		dialogMock.mockResolvedValueOnce(FILE_PATH);
		invokeMock.mockRejectedValueOnce(new Error('no such directory'));

		await expect(openFileFromMenu()).rejects.toThrow('no such directory');
		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['set_root']);
	});
});

// ---------------------------------------------------------------------------
// openFolderFromMenu — Open Folder…(フォルダ選択)の実行列
// ---------------------------------------------------------------------------

describe('openFolderFromMenu — フォルダ選択 → set_root のみ', () => {
	test('ダイアログはフォルダ選択・単一選択で開く(directory: true・multiple が truthy でない)', async () => {
		dialogMock.mockResolvedValueOnce(null);

		await openFolderFromMenu();

		expect(dialogMock).toHaveBeenCalledTimes(1);
		const opts = dialogMock.mock.calls[0]?.[0] ?? {};
		expect(opts['directory']).toBe(true);
		expect(Boolean(opts['multiple'])).toBe(false);
	});

	test('選択 → set_root(当該フォルダ)のみ。open_document は呼ばず document:null を返す', async () => {
		const folderPayload = { root_uri: FOLDER_URI, entries: [], document_retained: false };
		dialogMock.mockResolvedValueOnce(FOLDER_PATH);
		invokeMock.mockResolvedValueOnce(folderPayload);

		const res = await openFolderFromMenu();

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['set_root']);
		expect(invokeMock.mock.calls[0]?.[1]).toEqual({ uri: FOLDER_URI });
		expect(res).not.toBeNull();
		expect(res).toMatchObject({ root: folderPayload, document: null });
	});

	test('キャンセル → invoke を一切呼ばず null(無変化)', async () => {
		dialogMock.mockResolvedValueOnce(null);

		await expect(openFolderFromMenu()).resolves.toBeNull();
		expect(invokeMock).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// メニューイベントの受信配線 — Rust の emit → ダイアログ → コマンド列
// ---------------------------------------------------------------------------

describe('registerMenuOpenListeners — メニューイベントの購読と実行', () => {
	/** 登録済みハンドラをイベント名で取り出す(登録順には依存しない)。 */
	const handlerFor = (event: string) =>
		listenMock.mock.calls.find((c) => c[0] === event)?.[1];

	test("イベント名は 'menu_open_file' / 'menu_open_folder'(既存イベントと同じ snake_case)", () => {
		expect(MENU_OPEN_FILE_EVENT).toBe('menu_open_file');
		expect(MENU_OPEN_FOLDER_EVENT).toBe('menu_open_folder');
	});

	test('両イベントを $lib/events の listen で購読する(それぞれ1回ずつ)', async () => {
		await registerMenuOpenListeners({ onOpened: vi.fn() });

		const events = listenMock.mock.calls.map((c) => c[0]).sort();
		expect(events).toEqual(['menu_open_file', 'menu_open_folder']);
	});

	test('file イベント → ファイルダイアログ → set_root(親)→ open_document → onOpened', async () => {
		const onOpened = vi.fn();
		await registerMenuOpenListeners({ onOpened });
		dialogMock.mockResolvedValueOnce(FILE_PATH);
		invokeMock.mockResolvedValueOnce(rootPayload).mockResolvedValueOnce(docPayload);

		const handler = handlerFor(MENU_OPEN_FILE_EVENT);
		expect(handler).toBeDefined();
		await handler?.({ payload: undefined });
		await flushAsync();

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['set_root', 'open_document']);
		expect(invokeMock.mock.calls[0]?.[1]).toEqual({ uri: PARENT_URI });
		expect(invokeMock.mock.calls[1]?.[1]).toEqual({ uri: FILE_URI });
		expect(onOpened).toHaveBeenCalledTimes(1);
		expect(onOpened.mock.calls[0]?.[0]).toMatchObject({ root: rootPayload, document: docPayload });
	});

	test('folder イベント → フォルダダイアログ → set_root のみ → onOpened(document:null)', async () => {
		const folderPayload = { root_uri: FOLDER_URI, entries: [], document_retained: false };
		const onOpened = vi.fn();
		await registerMenuOpenListeners({ onOpened });
		dialogMock.mockResolvedValueOnce(FOLDER_PATH);
		invokeMock.mockResolvedValueOnce(folderPayload);

		const handler = handlerFor(MENU_OPEN_FOLDER_EVENT);
		expect(handler).toBeDefined();
		await handler?.({ payload: undefined });
		await flushAsync();

		expect(dialogMock.mock.calls[0]?.[0]?.['directory']).toBe(true);
		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['set_root']);
		expect(invokeMock.mock.calls[0]?.[1]).toEqual({ uri: FOLDER_URI });
		expect(onOpened).toHaveBeenCalledTimes(1);
		expect(onOpened.mock.calls[0]?.[0]).toMatchObject({ root: folderPayload, document: null });
	});

	test('キャンセル → onOpened は呼ばれず invoke もなし(無変化)', async () => {
		const onOpened = vi.fn();
		await registerMenuOpenListeners({ onOpened });
		dialogMock.mockResolvedValue(null); // file / folder どちらのダイアログもキャンセル

		await handlerFor(MENU_OPEN_FILE_EVENT)?.({ payload: undefined });
		await handlerFor(MENU_OPEN_FOLDER_EVENT)?.({ payload: undefined });
		await flushAsync();

		expect(onOpened).not.toHaveBeenCalled();
		expect(invokeMock).not.toHaveBeenCalled();
	});

	test('set_root 失敗 → onError に渡り onOpened は呼ばれない(ハンドラ外へ投げない)', async () => {
		const onOpened = vi.fn();
		const onError = vi.fn();
		await registerMenuOpenListeners({ onOpened, onError });
		dialogMock.mockResolvedValueOnce(FILE_PATH);
		const failure = new Error('no such directory');
		invokeMock.mockRejectedValueOnce(failure);

		// ここで reject が漏れたらテスト自体が失敗する=「外へ投げない」の判定を兼ねる。
		await handlerFor(MENU_OPEN_FILE_EVENT)?.({ payload: undefined });
		await flushAsync();

		expect(onOpened).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0]?.[0]).toBe(failure);
	});

	test('onError 省略時も失敗で落ちない(unhandled rejection にしない)', async () => {
		await registerMenuOpenListeners({ onOpened: vi.fn() });
		dialogMock.mockResolvedValueOnce(FOLDER_PATH);
		invokeMock.mockRejectedValueOnce(new Error('no such directory'));

		await handlerFor(MENU_OPEN_FOLDER_EVENT)?.({ payload: undefined });
		await flushAsync();
	});

	test('返り値の解除関数で両購読の unlisten がそれぞれ呼ばれる', async () => {
		const unlistenFile = vi.fn();
		const unlistenFolder = vi.fn();
		listenMock.mockImplementation(async (event) =>
			event === MENU_OPEN_FILE_EVENT ? unlistenFile : unlistenFolder,
		);

		const unlisten = await registerMenuOpenListeners({ onOpened: vi.fn() });
		unlisten();

		expect(unlistenFile).toHaveBeenCalledTimes(1);
		expect(unlistenFolder).toHaveBeenCalledTimes(1);
	});
});
