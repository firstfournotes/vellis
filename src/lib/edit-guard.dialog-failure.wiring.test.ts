/**
 * 要件#48 追補k の受け入れテスト(docs/requirements/req-48.md 追補k・Issue #484)。
 *
 * 閲覧へ戻る関門 `confirmDiscardEdits` は、確認のダイアログ(`ask`)そのものが
 * 失敗する(Promise が reject する)と、今はその reject を呼び出し元へそのまま投げる。
 * Esc / Done は `void confirmDiscardEdits()` で受けるので未処理の rejection になり、
 * await する呼び出し元でも例外が捨てられる。本ファイルは「ダイアログが失敗したら
 * 取りやめて編集を残す」を固定する。
 *
 * ## 判定するもの
 * - **AC-48-追k(a)** `ask` の 1 回目(Continue / Cancel)が reject すると、
 *   `confirmDiscardEdits()` は reject せず `false` で解決し、`endEdit` されず
 *   (editMode=edit・editBuffer・dirty はそのまま)、保存(`save_document`)もされない
 * - **AC-48-追k(b)** 2 回目(Save / Don't Save)が reject しても同じ
 * - **AC-48-追k(c)** どちらも `console.error` が **1 回** 呼ばれる。alert は出さない
 *   (契約(2): ダイアログが出せない状況で別のダイアログを重ねない)
 * - **AC-48-追k(d)** 既存の関門のテスト(Viewer.edit / close-window の wiring)は無改変で緑
 *   → フルスイートで判定。本ファイルでは不変の要点(成功時の Cancel / Don't Save /
 *   Save・非 dirty は聞かずに進む・保存失敗は `Could not save:` の alert で取りやめ)を
 *   同じ観測台で押さえ直す
 *
 * ## 判定しないもの
 * - `askUnsavedChoice` 単体が reject するか `cancel` を返すか(契約は `confirmDiscardEdits`
 *   の戻り値で言っている。どちらの作りでも `confirmDiscardEdits` が false なら可)
 * - `console.error` に渡す文言・引数の形(「1 回残す」だけ)
 *
 * ## 実装前の見立て(赤の理由)
 * - (a)(b) は現状 `askUnsavedChoice` の `await ask(...)` がそのまま throw し、
 *   `confirmDiscardEdits()` は reject する → `resolves.toBe(false)` が落ちる=赤。
 *   `console.error` も呼ばれない → (c) の `toHaveBeenCalledTimes(1)` も赤
 * - 不変の節は最初から緑のはず(退行の守り)
 *
 * ## スタブの設計(close-window.wiring.test.ts の家風)
 * - $lib/ipc: モジュールモック(`save_document` の観測)
 * - @tauri-apps/plugin-dialog: `ask` をモック。edit-guard 自体はモックしない —
 *   関門の実体を通し、`ask` の返り値 / reject で場面を再現する
 * - `console.error` は spy(出力は握りつぶす)・`alert` は `vi.stubGlobal` で差し替え
 *   (jsdom の `alert` は未実装で、呼ぶと jsdom が console.error へ流すため、
 *   回数の判定に紛れないよう必ず差し替える)
 * - runes を含む windowState を通すため component プロジェクト(*.wiring.test.ts)に置く
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn() }));

import { ask } from '@tauri-apps/plugin-dialog';
import { invoke } from '$lib/ipc';
import { confirmDiscardEdits, UNSAVED_PROCEED_MESSAGE, UNSAVED_SAVE_MESSAGE } from './edit-guard';

const askMock = vi.mocked(ask);
const invokeMock = vi.mocked(invoke);

const TXT_URI = 'file:///Users/a/notes/memo.txt';
const TXT_CONTENT = 'first line\nsecond line\n';
const EDITED = TXT_CONTENT + 'my edit\n';

function txtDoc(): DocumentPayload {
	return { uri: TXT_URI, content: TXT_CONTENT, modified: 1 };
}

/** text 文書を編集モードに入れて dirty にする。 */
function makeDirty() {
	windowState.setDocument(txtDoc());
	expect(windowState.beginEdit()).toBe(true);
	windowState.updateBuffer(EDITED);
	expect(windowState.dirty).toBe(true);
}

/** 編集中のまま何も変わっていないこと(endEdit されていない・バッファ・dirty が維持)。 */
function expectStillEditing() {
	expect(windowState.editMode).toBe('edit');
	expect(windowState.editBuffer).toBe(EDITED);
	expect(windowState.dirty).toBe(true);
	expect(windowState.currentDocument?.uri).toBe(TXT_URI);
}

function expectNoSave() {
	expect(invokeMock).not.toHaveBeenCalledWith('save_document', expect.anything());
}

let errorSpy: MockInstance<typeof console.error>;
let alertMock: Mock<(message?: unknown) => void>;

beforeEach(() => {
	windowState.endEdit();
	windowState.clearDocument();
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
	alertMock = vi.fn();
	vi.stubGlobal('alert', alertMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe('confirmDiscardEdits — ダイアログ(ask)が失敗したら取りやめて編集を残す(要件#48 追補k / AC-48-追k)', () => {
	it('(a) 1 回目の ask が reject → false で解決し、endEdit されず保存もされない', async () => {
		makeDirty();
		askMock.mockRejectedValueOnce(new Error('dialog plugin unavailable'));

		await expect(confirmDiscardEdits()).resolves.toBe(false);

		expect(askMock).toHaveBeenCalledTimes(1);
		expect(askMock.mock.calls[0][0]).toBe(UNSAVED_PROCEED_MESSAGE);
		expectStillEditing();
		expectNoSave();
	});

	it('(b) 2 回目の ask が reject(1 回目は Continue)→ false で解決し、endEdit されず保存もされない', async () => {
		makeDirty();
		askMock.mockResolvedValueOnce(true); // 1 枚目: Continue
		askMock.mockRejectedValueOnce(new Error('dialog plugin unavailable')); // 2 枚目: 失敗

		await expect(confirmDiscardEdits()).resolves.toBe(false);

		expect(askMock).toHaveBeenCalledTimes(2);
		expect(askMock.mock.calls[1][0]).toBe(UNSAVED_SAVE_MESSAGE);
		expectStillEditing();
		expectNoSave();
	});

	it('(c) 1 回目の失敗は console.error に 1 回残り、alert は出ない', async () => {
		makeDirty();
		askMock.mockRejectedValueOnce(new Error('dialog plugin unavailable'));

		await expect(confirmDiscardEdits()).resolves.toBe(false);

		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(alertMock).not.toHaveBeenCalled();
	});

	it('(c) 2 回目の失敗も console.error に 1 回残り、alert は出ない', async () => {
		makeDirty();
		askMock.mockResolvedValueOnce(true);
		askMock.mockRejectedValueOnce(new Error('dialog plugin unavailable'));

		await expect(confirmDiscardEdits()).resolves.toBe(false);

		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(alertMock).not.toHaveBeenCalled();
	});

	it('(a) reject の値が Error でなくても(文字列)同じく false・console.error 1 回', async () => {
		// Tauri の IPC 失敗は文字列で reject されることがある。Error 前提の処理で
		// 取りこぼさないこと。
		makeDirty();
		askMock.mockRejectedValueOnce('ask failed: plugin not registered');

		await expect(confirmDiscardEdits()).resolves.toBe(false);

		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(alertMock).not.toHaveBeenCalled();
		expectStillEditing();
		expectNoSave();
	});

	it('(a) 失敗のあと、ダイアログが復帰すれば次の呼び出しは従来どおり進める(状態を壊していない)', async () => {
		makeDirty();
		askMock.mockRejectedValueOnce(new Error('dialog plugin unavailable'));
		await expect(confirmDiscardEdits()).resolves.toBe(false);
		expectStillEditing();

		askMock.mockResolvedValueOnce(true); // 1 枚目: Continue
		askMock.mockResolvedValueOnce(false); // 2 枚目: Don't Save
		await expect(confirmDiscardEdits()).resolves.toBe(true);

		expect(windowState.editMode).toBe('view');
		expect(windowState.editBuffer).toBe(null);
		expectNoSave();
	});
});

describe('confirmDiscardEdits — ダイアログが成功したときの振る舞いは不変(追補k(3) / AC-48-追k(d))', () => {
	it('非 dirty なら聞かずに true(ask は呼ばれない・console.error も無い)', async () => {
		windowState.setDocument(txtDoc());
		windowState.beginEdit();
		expect(windowState.dirty).toBe(false);

		await expect(confirmDiscardEdits()).resolves.toBe(true);

		expect(askMock).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
		expect(windowState.editMode).toBe('view');
	});

	it('1 枚目 Cancel → false・編集中のまま・console.error は無い', async () => {
		makeDirty();
		askMock.mockResolvedValueOnce(false);

		await expect(confirmDiscardEdits()).resolves.toBe(false);

		expect(askMock).toHaveBeenCalledTimes(1);
		expectStillEditing();
		expectNoSave();
		expect(errorSpy).not.toHaveBeenCalled();
		expect(alertMock).not.toHaveBeenCalled();
	});

	it("Continue → Don't Save → true・閲覧へ戻りバッファ破棄・保存は走らない", async () => {
		makeDirty();
		askMock.mockResolvedValueOnce(true);
		askMock.mockResolvedValueOnce(false);

		await expect(confirmDiscardEdits()).resolves.toBe(true);

		expect(windowState.editMode).toBe('view');
		expect(windowState.editBuffer).toBe(null);
		expectNoSave();
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it('Continue → Save → save_document が成功してから true・閲覧へ戻る', async () => {
		makeDirty();
		askMock.mockResolvedValueOnce(true);
		askMock.mockResolvedValueOnce(true);

		await expect(confirmDiscardEdits()).resolves.toBe(true);

		expect(invokeMock).toHaveBeenCalledWith('save_document', { uri: TXT_URI, content: EDITED });
		expect(windowState.editMode).toBe('view');
		expect(windowState.editBuffer).toBe(null);
		expect(windowState.dirty).toBe(false);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it('Continue → Save → 保存が失敗したら `Could not save:` の alert を出して false・編集中のまま', async () => {
		makeDirty();
		askMock.mockResolvedValueOnce(true);
		askMock.mockResolvedValueOnce(true);
		invokeMock.mockRejectedValueOnce(new Error('disk full'));

		await expect(confirmDiscardEdits()).resolves.toBe(false);

		expect(alertMock).toHaveBeenCalledTimes(1);
		expect(String(alertMock.mock.calls[0][0])).toMatch(/^Could not save: /);
		expectStillEditing();
	});
});
