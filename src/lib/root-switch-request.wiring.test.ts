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
import type { FileEditorHandle } from '../editor/file-editor';
import { contentHash } from '$lib/document-edit';

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


/**
 * 要件74 第2段 2-5(2026-11-17 仮・契約21・オーケストレーターの仮の承認=朝に由谷に確かめる): 今の編集の store の口
 * (beginEdit / updateBuffer / editMode / editBuffer / endEdit)は撤去で消えるため、用意だけを新しい面の偽の handle
 * (`windowState.fileEditor`=edit-guard の 2 本と同じ形)に置き換えた。見ている振る舞いの期待値は変えていない。
 * `windowState.dirty` は面の dirty を映す(確定契約)。
 */
type FakeFace = FileEditorHandle & { setText(next: string): void };
function fakeFace(uri: string, base: string): FakeFace {
	let current = base;
	let savedBase = base;
	return {
		kind: 'text',
		uri,
		readOnly: false,
		get dirty() {
			return current !== savedBase;
		},
		conflict: false,
		notice: null,
		text: () => current,
		expectedHash: () => contentHash(savedBase),
		markSaved(text: string) {
			savedBase = text;
			current = text;
		},
		applyFileChanged: () => 'apply',
		keepMyEdits() {},
		useFileOnDisk() {},
		showSaveConflict() {},
		reset(content: string) {
			current = content;
			savedBase = content;
		},
		preparePrint: async () => undefined,
		setText(next: string) {
			current = next;
		},
	};
}
let face: FakeFace | null = null;
/** text 文書を面に載せて dirty にする。 */
function makeDirty() {
	windowState.setDocument(txtDoc());
	face = fakeFace(TXT_URI, TXT_CONTENT);
	windowState.fileEditor = face;
	face.setText(EDITED);
	expect(windowState.dirty).toBe(true);
}

/** 何も変わっていない: root・文書・編集(モード・バッファ・dirty)がそのまま。 */
function expectUntouched() {
	expect(windowState.root).toBe(OLD_ROOT);
	expect(windowState.currentDocument?.uri).toBe(TXT_URI);
	expect(face?.dirty).toBe(true);
	expect(face?.text()).toBe(EDITED);
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
	windowState.fileEditor = null;
	face = null;
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
		// 捨てる=面は切り替え(applyRoot)で文書ごと外れる。関門は面に触らない(ここでは保存が走っていないことだけ)。
		expect(face?.text()).toBe(EDITED);
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
		expect(saveCalls()[0][1]).toEqual({ uri: TXT_URI, content: EDITED, expectedHash: contentHash(TXT_CONTENT) });
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
		face = fakeFace(TXT_URI, TXT_CONTENT);
		windowState.fileEditor = face;
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

// ---------------------------------------------------------------------------
// reviewer の照合(2026-11-17・P2 の穴 F11)— root を変えて文書が残る(documentRetained)ときの面の reset
// ---------------------------------------------------------------------------

describe('F11・契約16・(ak): Don\'t Save の後に root が変わり文書が残る(applyRoot の documentRetained=true)と、dirty の面は読み直した中身で reset される', () => {
	it('documentRetained=true: 文書は残り、面は currentDocument の中身に戻って dirty でない(root の外へ出た編集を書き戻す先は無い)', async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce("Don't Save");
		await expect(requestSwitch()).resolves.toBe('switched');
		expect(saveCalls()).toHaveLength(0);
		expect(face?.dirty, '切り替えを頼んだ時点では面はまだ dirty(Rust の root_changed を待つ)').toBe(true);

		// Rust からの root_changed(文書が残る形)を store に当てる。
		windowState.applyRoot(NEW_ROOT, [], true);

		expect(windowState.root).toBe(NEW_ROOT);
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
		expect(windowState.fileEditor).toBe(face);
		expect(face?.text(), '面は文書の中身(読み直した版)に戻る').toBe(TXT_CONTENT);
		expect(face?.dirty).toBe(false);
		expect(windowState.dirty).toBe(false);
		expect(windowState.externalRemoved).toBe(false);
	});

	it('documentRetained=false: 文書が閉じ、面の handle も外れる', async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce("Don't Save");
		await expect(requestSwitch()).resolves.toBe('switched');

		windowState.applyRoot(NEW_ROOT, [], false);

		expect(windowState.root).toBe(NEW_ROOT);
		expect(windowState.currentDocument).toBeNull();
		expect(windowState.fileEditor).toBeNull();
		expect(windowState.dirty).toBe(false);
	});

	it('dirty でない面は documentRetained=true でも触らない(reset が呼ばれない)', async () => {
		windowState.setDocument(txtDoc());
		face = fakeFace(TXT_URI, TXT_CONTENT);
		windowState.fileEditor = face;
		const spy = vi.spyOn(face, 'reset');
		await expect(requestSwitch()).resolves.toBe('switched');
		windowState.applyRoot(NEW_ROOT, [], true);
		expect(spy).not.toHaveBeenCalled();
		expect(windowState.fileEditor).toBe(face);
		expect(windowState.dirty).toBe(false);
	});
});
