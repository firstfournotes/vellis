/**
 * 要件#4 の受け入れテスト(requirements.md #4)— フロント層
 * 「引数なし起動時は履歴選択画面を表示し、選択したフォルダを開ける」
 *
 * 判定範囲(本ファイル): 履歴選択画面のビューモデル契約。実装先 `src/lib/root-picker.ts`。
 * UI(コンポーネント構造・文言・レイアウト)は断定しない。
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * 1. `type RootPickerEntry = { uri: string; label: string }`(追加フィールドは実装の自由)
 * 2. `toPickerEntries(uris: string[]): RootPickerEntry[]`
 *    - 入力は履歴 URI の配列(最近順)。出力は同数・同順
 *    - `uri` は入力文字列をそのまま保持する(選択時に set_root へ渡す値)
 *    - `label` は表示名 = URI パスの最後の非空セグメント
 *      (末尾スラッシュは無視。スペース等の文字はそのまま。file:// / ssh:// 共通。
 *       backend の URI は percent-encode されない生文字列 — init_window の
 *       `format!("file://{}", ...)` 参照 — なのでデコードは要求しない)
 *    - 非空セグメントが取れない URI でも label を空にしない(内容は実装の自由)
 * 3. `loadHistory(): Promise<string[]>`
 *    - `$lib/ipc` の `invoke('list_history')` で履歴(最近順)を取得して返す
 *    - invoke が失敗しても reject せず [] にフォールバックする
 *      (壊れた履歴で起動を阻害しない — 要件#3・acceptance_req3.rs と同じ家風)
 * 4. `openHistoryEntry(uri: string): Promise<unknown>`
 *    - `$lib/ipc` の `invoke('set_root', { uri })` を呼び、その解決値
 *      (RootPayload 相当)をそのまま返す(呼び出し側が windowState へ反映する)
 *    - invoke の失敗はそのまま reject する(握りつぶさない。UI 側の対処に委ねる)
 *
 * invoke は `$lib/ipc` の薄いラッパ(ipc.ts 自身が「テストでモックしやすいように」
 * と明記)を vi.mock する。実装側も invoke は `$lib/ipc` から import すること。
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - +page.svelte: `needs_root_selection=true` のとき現行の pickFolderAndSetRoot
 *   直行を置き換えて履歴選択画面を初期表示すること。従来のフォルダ選択
 *   (OS ダイアログ)も選択画面から引き続き行えること
 * - backend: `list_history` コマンドの追加・invoke_handler 登録
 *   (契約は src-tauri/tests/acceptance_req4.rs のヘッダ参照)
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));

import { invoke } from '$lib/ipc';
import { loadHistory, openHistoryEntry, toPickerEntries } from './root-picker';

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
	invokeMock.mockReset();
});

describe('toPickerEntries — 履歴 URI → 表示用エントリ', () => {
	test('表示名(パス末尾)+フル URI へ変換し、最近順の並びを保つ', () => {
		const uris = [
			'file:///Users/a/work',
			'file:///Users/a/notes',
			'file:///Users/a/docs',
		];
		const entries = toPickerEntries(uris);
		expect(entries.map((e) => e.uri)).toEqual(uris);
		expect(entries.map((e) => e.label)).toEqual(['work', 'notes', 'docs']);
	});

	test('末尾スラッシュは無視し、スペースを含むフォルダ名はそのまま表示名にする', () => {
		expect(toPickerEntries(['file:///Users/a/docs/'])[0]?.label).toBe('docs');
		expect(toPickerEntries(['file:///Users/a/My Docs'])[0]?.label).toBe('My Docs');
	});

	test('ssh:// URI でも同じ規則で表示名を取り、URI は保持する', () => {
		const entries = toPickerEntries(['ssh://alice@host/notes/work', 'ssh://host/repo']);
		expect(entries.map((e) => e.label)).toEqual(['work', 'repo']);
		expect(entries.map((e) => e.uri)).toEqual([
			'ssh://alice@host/notes/work',
			'ssh://host/repo',
		]);
	});

	test('空の履歴(初回起動)は空配列(選択画面はフォルダ選択のみで成立)', () => {
		expect(toPickerEntries([])).toEqual([]);
	});

	test('パスセグメントが取れない URI でも label を空にしない', () => {
		const entries = toPickerEntries(['file:///']);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.uri).toBe('file:///');
		expect(entries[0]?.label).toBeTruthy();
	});
});

describe('loadHistory — 履歴一覧の取得', () => {
	test("invoke('list_history') を呼び、返った履歴(最近順)をそのまま返す", async () => {
		const history = ['file:///Users/a/work', 'file:///Users/a/docs'];
		invokeMock.mockResolvedValueOnce(history);

		await expect(loadHistory()).resolves.toEqual(history);
		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock.mock.calls[0]?.[0]).toBe('list_history');
	});

	test('invoke が失敗しても reject せず空配列にフォールバックする(起動を阻害しない)', async () => {
		invokeMock.mockRejectedValueOnce(new Error('backend unavailable'));

		await expect(loadHistory()).resolves.toEqual([]);
		expect(invokeMock.mock.calls[0]?.[0]).toBe('list_history');
	});
});

describe('openHistoryEntry — エントリ選択で該当フォルダを開く', () => {
	test("選択した URI で invoke('set_root', { uri }) を呼び、解決値を返す", async () => {
		const payload = {
			root_uri: 'file:///Users/a/docs',
			entries: [],
			document_retained: false,
		};
		invokeMock.mockResolvedValueOnce(payload);

		const res = await openHistoryEntry('file:///Users/a/docs');

		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock.mock.calls[0]?.[0]).toBe('set_root');
		expect(invokeMock.mock.calls[0]?.[1]).toEqual({ uri: 'file:///Users/a/docs' });
		expect(res).toEqual(payload);
	});

	test('オープン失敗(フォルダ消失等)はそのまま reject する(黙って握りつぶさない)', async () => {
		invokeMock.mockRejectedValueOnce(new Error('no such directory'));

		await expect(openHistoryEntry('file:///Users/a/gone')).rejects.toThrow(
			'no such directory'
		);
		expect(invokeMock.mock.calls[0]?.[0]).toBe('set_root');
	});
});
