/**
 * 要件#48 追補m の受け入れテスト(docs/requirements/req-48.md「追補m」= Issue #750)— 関門を通した場面
 *
 * `root-switch-request.acceptance.test.ts` が注入した関門で判断を固定するのに対し、本ファイルは
 * **実物の関門**(`confirmDiscardEdits`= `message` 1 枚の 3 択 + 保存)と実物の `windowState` を通して、
 * CLI からの「切り替えの依頼」が画面からの切り替えと同じ確認を出し、その答えどおりに切り替えを
 * 頼む/頼まないことを固定する(+page.svelte が渡す deps と同じ組み合わせ=
 * `{ confirmDiscard: confirmDiscardEdits, switchRoot: switchRootConfirmed }`)。
 *
 * 確定契約は `root-switch-request.acceptance.test.ts` の冒頭(同じ公開 API を使う)。
 *
 * ## 判定するもの(AC-48-追m)
 * - **(a)** 保存していない編集がある窓へ依頼が届くと確認(`message` の 1 枚= UNSAVED_SAVE_MESSAGE)が出て、
 *   Cancel なら `switch_root_confirmed` は invoke されず、root・文書・編集(editMode / editBuffer / dirty)は
 *   そのまま。ダイアログの失敗(追補k)も同じ
 * - **(b)** Don't Save なら `switch_root_confirmed` が invoke され、編集は捨てられる(保存は走らない)。
 *   Save なら `save_document` が成功してから `switch_root_confirmed` が invoke される
 *   (保存が終わる前には頼まない・保存が失敗したら頼まず編集を残す)
 * - **(c)** 編集が無ければ `message` は呼ばれず、そのまま `switch_root_confirmed` が invoke される
 *   (閲覧中・編集モードでも未変更の両方)
 *
 * ## 書き換え(要件#48 追補o・2026-10-28・由谷承認)
 * 確認は `ask` 2 枚(Continue / Cancel → Save / Don't Save)から `message` 1 枚の 3 択
 * (Save / Don't Save / Cancel)へ。確認の部分(モック・答え・回数・文言)だけを直し、
 * 確認の後の期待値(頼む / 頼まない・保存してから・保存の失敗で取りやめ)は変えていない。
 *
 * ## 判定しないもの
 * - backend が依頼のあとに root を切り替えないこと・切り替えの結果が今と同じこと → acceptance_req48m.rs
 * - `root_changed` を受けた窓の反映(`applyRoot`)→ 既存テスト・+page の走査(不変)
 *
 * ## 実装前の見立て(赤の理由)
 * - `./root-switch-request` が無いので import で全件赤
 *
 * ## スタブの設計(edit-guard.dialog-failure.wiring.test.ts の家風)
 * - $lib/ipc: モジュールモック(`save_document`・`switch_root_confirmed` の観測と順序)
 * - @tauri-apps/plugin-dialog: `message` をモック(`ask` は呼ばれない)。edit-guard 自体はモックしない
 * - `alert` は `vi.stubGlobal` で差し替え(jsdom の alert は未実装)
 * - runes を含む windowState を通すため component プロジェクト(*.wiring.test.ts)に置く
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), message: vi.fn() }));

import { message } from '@tauri-apps/plugin-dialog';
import { invoke } from '$lib/ipc';
import { confirmDiscardEdits, UNSAVED_SAVE_MESSAGE } from './edit-guard';
import { handleRootSwitchRequest, switchRootConfirmed } from './root-switch-request';

const messageMock = vi.mocked(message);
const invokeMock = vi.mocked(invoke);

const OLD_ROOT = 'file:///Users/a/notes';
const NEW_ROOT = 'file:///Users/a/other';
const TXT_URI = `${OLD_ROOT}/memo.txt`;
const TXT_CONTENT = 'first line\nsecond line\n';
const EDITED = TXT_CONTENT + 'my edit\n';

function txtDoc(): DocumentPayload {
	return { uri: TXT_URI, content: TXT_CONTENT, modified: 1 };
}

/** +page.svelte と同じ組み合わせで依頼 1 件を処理する。 */
function requestSwitch(onError?: (err: unknown) => void) {
	return handleRootSwitchRequest(
		{ root_uri: NEW_ROOT },
		{ confirmDiscard: confirmDiscardEdits, switchRoot: switchRootConfirmed, onError }
	);
}

/** text 文書を編集モードに入れて dirty にする。 */
function makeDirty() {
	windowState.setDocument(txtDoc());
	expect(windowState.beginEdit()).toBe(true);
	windowState.updateBuffer(EDITED);
	expect(windowState.dirty).toBe(true);
}

/** 何も変わっていない: root・文書・編集(モード・バッファ・dirty)がそのまま。 */
function expectUntouched() {
	expect(windowState.root).toBe(OLD_ROOT);
	expect(windowState.currentDocument?.uri).toBe(TXT_URI);
	expect(windowState.editMode).toBe('edit');
	expect(windowState.editBuffer).toBe(EDITED);
	expect(windowState.dirty).toBe(true);
}

const switchCalls = () => invokeMock.mock.calls.filter((c) => c[0] === 'switch_root_confirmed');
const saveCalls = () => invokeMock.mock.calls.filter((c) => c[0] === 'save_document');

/** 解決を手で進められる Promise。 */
function deferred<T>() {
	let resolveFn!: (v: T) => void;
	let rejectFn!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolveFn = res;
		rejectFn = rej;
	});
	return { promise, resolve: resolveFn, reject: rejectFn };
}

async function flush() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

let alertMock: Mock<(message?: unknown) => void>;

beforeEach(() => {
	windowState.endEdit();
	windowState.clearDocument();
	windowState.applyRoot(OLD_ROOT, [], false);
	alertMock = vi.fn();
	vi.stubGlobal('alert', alertMock);
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	invokeMock.mockReset();
	invokeMock.mockResolvedValue(null);
	messageMock.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('AC-48-追m (a): 保存していない編集がある窓へ CLI の切り替えが届くと確認が出て、Cancel ならそのまま', () => {
	it('確認(UNSAVED_SAVE_MESSAGE)が 1 枚出る', async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce('Cancel');

		await requestSwitch();

		expect(messageMock).toHaveBeenCalledTimes(1);
		expect(messageMock.mock.calls[0][0]).toBe(UNSAVED_SAVE_MESSAGE);
	});

	it("Cancel → 'cancelled'・switch_root_confirmed は invoke されず、root も文書も編集もそのまま", async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce('Cancel');

		await expect(requestSwitch()).resolves.toBe('cancelled');

		expect(switchCalls()).toHaveLength(0);
		expect(saveCalls()).toHaveLength(0);
		expectUntouched();
		expect(alertMock).not.toHaveBeenCalled();
	});

	it('ダイアログの失敗(追補k)も Cancel と同じ=頼まず、編集を残す', async () => {
		makeDirty();
		messageMock.mockRejectedValueOnce(new Error('dialog plugin unavailable'));

		await expect(requestSwitch()).resolves.toBe('cancelled');

		expect(switchCalls()).toHaveLength(0);
		expectUntouched();
	});
});

describe("AC-48-追m (b): Don't Save なら切り替わって編集は捨てられ、Save なら保存が成功してから切り替わる", () => {
	it("Don't Save → switch_root_confirmed を { uri } で 1 回 invoke・編集は捨てられ・保存は走らない", async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce("Don't Save");

		await expect(requestSwitch()).resolves.toBe('switched');

		expect(messageMock).toHaveBeenCalledTimes(1);
		expect(messageMock.mock.calls[0][0]).toBe(UNSAVED_SAVE_MESSAGE);
		expect(switchCalls()).toHaveLength(1);
		expect(switchCalls()[0][1]).toEqual({ uri: NEW_ROOT });
		expect(saveCalls()).toHaveLength(0);
		expect(windowState.editMode).toBe('view');
		expect(windowState.editBuffer).toBe(null);
		expect(windowState.dirty).toBe(false);
	});

	it('Save → save_document が先・switch_root_confirmed が後(どちらも 1 回)', async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce('Save');

		await expect(requestSwitch()).resolves.toBe('switched');

		const names = invokeMock.mock.calls.map((c) => c[0]);
		const saveAt = names.indexOf('save_document');
		const switchAt = names.indexOf('switch_root_confirmed');
		expect(saveAt).toBeGreaterThanOrEqual(0);
		expect(switchAt).toBeGreaterThan(saveAt);
		expect(saveCalls()).toHaveLength(1);
		expect(saveCalls()[0][1]).toEqual({ uri: TXT_URI, content: EDITED });
		expect(switchCalls()).toHaveLength(1);
		expect(switchCalls()[0][1]).toEqual({ uri: NEW_ROOT });
		expect(windowState.dirty).toBe(false);
	});

	it('Save → 保存が終わるまでは切り替えを頼まない(保存の完了を待ってから)', async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce('Save');
		const save = deferred<null>();
		invokeMock.mockImplementation(async (cmd) => {
			if (cmd === 'save_document') return save.promise;
			return null;
		});

		const outcome = requestSwitch();
		await flush();
		expect(saveCalls()).toHaveLength(1);
		expect(switchCalls()).toHaveLength(0);

		save.resolve(null);
		await expect(outcome).resolves.toBe('switched');
		expect(switchCalls()).toHaveLength(1);
	});

	it('Save → 保存が失敗したら切り替えを頼まず、編集を残す(`Could not save:` の alert)', async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce('Save');
		invokeMock.mockImplementation(async (cmd) => {
			if (cmd === 'save_document') throw new Error('disk full');
			return null;
		});

		await expect(requestSwitch()).resolves.toBe('cancelled');

		expect(switchCalls()).toHaveLength(0);
		expect(alertMock).toHaveBeenCalledTimes(1);
		expect(String(alertMock.mock.calls[0][0])).toMatch(/^Could not save: /);
		expectUntouched();
	});

	it("切り替えの実体(switch_root_confirmed)が失敗したら onError に渡り 'failed'(外へ投げない)", async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce("Don't Save");
		invokeMock.mockImplementation(async (cmd) => {
			if (cmd === 'switch_root_confirmed') throw 'LIST_ERROR: gone';
			return null;
		});
		const onError = vi.fn();

		await expect(requestSwitch(onError)).resolves.toBe('failed');

		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledWith('LIST_ERROR: gone');
	});
});

describe('AC-48-追m (c): 編集が無ければ確認なしで切り替えを頼む', () => {
	it('閲覧中(編集モードでない)→ message は呼ばれず switch_root_confirmed を { uri } で 1 回 invoke', async () => {
		windowState.setDocument(txtDoc());
		expect(windowState.dirty).toBe(false);

		await expect(requestSwitch()).resolves.toBe('switched');

		expect(messageMock).not.toHaveBeenCalled();
		expect(switchCalls()).toHaveLength(1);
		expect(switchCalls()[0][1]).toEqual({ uri: NEW_ROOT });
		expect(saveCalls()).toHaveLength(0);
	});

	it('編集モードでも未変更なら聞かずに頼む(関門は dirty でなければ聞かない)', async () => {
		windowState.setDocument(txtDoc());
		expect(windowState.beginEdit()).toBe(true);
		expect(windowState.dirty).toBe(false);

		await expect(requestSwitch()).resolves.toBe('switched');

		expect(messageMock).not.toHaveBeenCalled();
		expect(switchCalls()).toHaveLength(1);
	});

	it('文書を開いていない窓でも聞かずに頼む', async () => {
		expect(windowState.currentDocument).toBeNull();

		await expect(requestSwitch()).resolves.toBe('switched');

		expect(messageMock).not.toHaveBeenCalled();
		expect(switchCalls()).toHaveLength(1);
		expect(switchCalls()[0][1]).toEqual({ uri: NEW_ROOT });
	});
});
