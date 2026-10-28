/**
 * 要件#48 追補o の受け入れテスト(docs/requirements/req-48.md「追補o」・Issue #766)
 * — 未保存の確認を 1 枚の 3 択(Save / Don't Save / Cancel)にする
 *
 * 今の `askUnsavedChoice` は `ask`(2 択)を 2 枚続けて出す(Continue / Cancel → Save /
 * Don't Save)。追補o は plugin-dialog の `message()` の `buttons: { yes, no, cancel }` で
 * 3 択を 1 枚に出し、押されたボタンの文言(戻り値)で `save` / `discard` / `cancel` を決める。
 * 本ファイルは **実物の関門**(`confirmDiscardEdits`)と実物の `windowState` を通し、
 * ダイアログの境目(`@tauri-apps/plugin-dialog` の `message` / `ask`)で判定する。
 *
 * ## 判定するもの(契約番号は req-48.md 追補o の 1〜5・AC は AC-48-追o の (a)〜(e))
 * - **AC (a)・契約1**: dirty で関門に入ると `message` が **1 回だけ**呼ばれ、文言=
 *   `UNSAVED_SAVE_MESSAGE`・題=`UNSAVED_TITLE`・kind=`'warning'`・buttons=
 *   `{ yes: 'Save', no: "Don't Save", cancel: 'Cancel' }`。`ask` は呼ばれない。
 *   1 枚目の文言 `UNSAVED_PROCEED_MESSAGE` は使わなくなるので export から消える
 * - **契約2**: 戻り値の読み方。`'Save'` → `save`・`"Don't Save"` → `discard`・それ以外
 *   (`'Cancel'`・想定外の値=`'Yes'`・`'Ok'`・`undefined`・`null` など)→ `cancel`
 * - **AC (b)・契約4**: `'Save'` → `save_document` が**成功してから**進む(true・閲覧へ)。
 *   保存の失敗は `Could not save: …` の alert 1 回で取りやめ(false・編集を残す)。
 *   `"Don't Save"` → 保存せずに `endEdit` して進む。`'Cancel'`・想定外の値 → 進まず、
 *   editMode・editBuffer・dirty はそのまま
 * - **AC (c)・契約3**: `message` が reject → false・`console.error` 1 回・保存も `endEdit`
 *   もしない・alert は出ない(追補k を 1 枚に)
 * - **AC (d)**: dirty でなければ `message` も `ask` も呼ばれず、そのまま進む
 * - **AC (e)**: 閉窓(`close-window.ts`)・別ファイル(Explorer の行のクリック)・root 変更
 *   (`root-picker.ts` の `pickFolderAndSetRoot`=履歴選択画面と同じ deps)・CLI の切り替え
 *   (`root-switch-request.ts`)のどの経路でも、確認は `message` 1 枚だけ(`ask` 0 回)
 *
 * ## 判定しないもの
 * - 契約5(既存テストの書き換え)→ 書き換えた各ファイルで判定・フルスイートで緑
 * - macOS のシートの見た目(ボタンの並び・Return / Esc の既定)→ 人間ゲート
 * - `console.error` に渡す文言(「1 回残す」だけ)
 *
 * ## 実装前の見立て(赤の理由)
 * - 今の関門は `ask` を呼び `message` を呼ばないので、`message` の回数・引数・`ask` 0 回の
 *   判定が落ちる。`ask` のモックは `vi.fn()`(undefined を返す)なので、今の実装では
 *   1 枚目が「Cancel」になり、進む側(`'Save'`・`"Don't Save"`)の判定も落ちる
 * - `UNSAVED_PROCEED_MESSAGE` の不在・非 dirty の節は最初から緑のはず(退行の守り)
 *
 * ## スタブの設計(edit-guard.dialog-failure.wiring.test.ts の家風)
 * - $lib/ipc: モジュールモック(`save_document`・`switch_root_confirmed`・`set_root`・
 *   `open_document` の観測と順序)
 * - @tauri-apps/plugin-dialog: `message` と `ask` の両方をモック(`ask` は「呼ばれない」
 *   ことの観測台)。edit-guard 自体はモックしない
 * - `alert` は `vi.stubGlobal` で差し替え(jsdom の alert は未実装で console.error へ流れる
 *   ため、(c) の回数の判定に紛れないよう必ず差し替える)・`console.error` は spy
 * - runes を含む windowState と Explorer を通すため component プロジェクト
 *   (*.wiring.test.ts)に置く
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { windowState, type DocumentPayload, type Entry } from '../stores/window-state.svelte';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), message: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({
	revealItemInDir: vi.fn(async () => undefined),
	openPath: vi.fn(async () => undefined),
	openUrl: vi.fn(async () => undefined),
}));

import { ask, message } from '@tauri-apps/plugin-dialog';
import { invoke } from '$lib/ipc';
import * as editGuard from './edit-guard';
import { askUnsavedChoice, confirmDiscardEdits, UNSAVED_SAVE_MESSAGE, UNSAVED_TITLE } from './edit-guard';
import { handleCloseRequested } from './close-window';
import { pickFolderAndSetRoot } from './root-picker';
import { handleRootSwitchRequest, switchRootConfirmed } from './root-switch-request';
import Explorer from '../components/Explorer.svelte';

/**
 * `message` の戻り値は押されたボタンの文言(string)。想定外の値(undefined・null・
 * boolean)も流し込めるよう、型は緩めに取る。
 */
const messageMock = message as unknown as Mock<
	(message: string, options?: Record<string, unknown>) => Promise<unknown>
>;
const askMock = vi.mocked(ask);
const invokeMock = vi.mocked(invoke);

const OLD_ROOT = 'file:///Users/a/notes';
const NEW_ROOT = 'file:///Users/a/other';
const TXT_URI = `${OLD_ROOT}/memo.txt`;
const OTHER_URI = `${OLD_ROOT}/plan.md`;
const TXT_CONTENT = 'first line\nsecond line\n';
const EDITED = TXT_CONTENT + 'my edit\n';

const SAVE = 'Save';
const DONT_SAVE = "Don't Save";
const CANCEL = 'Cancel';

/** 契約1 のボタン(yes / no / cancel の順に Save / Don't Save / Cancel)。 */
const EXPECTED_BUTTONS = { yes: SAVE, no: DONT_SAVE, cancel: CANCEL };

/**
 * 契約2 の「それ以外」。`ask` の時代の `'Yes'`・`'Ok'`、大文字小文字の違い、空文字、
 * 値なし(undefined・null)、boolean(`ask` の戻り値の名残)—— どれも「進んでよい」と
 * 取らない。
 */
const UNEXPECTED_ANSWERS: [string, unknown][] = [
	["'Yes'", 'Yes'],
	["'No'", 'No'],
	["'Ok'", 'Ok'],
	["'save'(小文字)", 'save'],
	["'SAVE'(大文字)", 'SAVE'],
	["'Dont Save'(アポストロフィ無し)", 'Dont Save'],
	['空文字', ''],
	['undefined', undefined],
	['null', null],
	['true(boolean)', true],
	['false(boolean)', false],
];

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

/** 閲覧へ戻り、バッファは捨てられている(endEdit 済み)。 */
function expectEnded() {
	expect(windowState.editMode).toBe('view');
	expect(windowState.editBuffer).toBe(null);
	expect(windowState.dirty).toBe(false);
}

const callsOf = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd);
const saveCalls = () => callsOf('save_document');

function expectNoSave() {
	expect(saveCalls()).toHaveLength(0);
}

/** 確認は `message` 1 枚だけ・`ask` は 0 回。 */
function expectSingleDialog() {
	expect(messageMock).toHaveBeenCalledTimes(1);
	expect(askMock).not.toHaveBeenCalled();
}

/** 確認は 1 枚も出ていない。 */
function expectNoDialog() {
	expect(messageMock).not.toHaveBeenCalled();
	expect(askMock).not.toHaveBeenCalled();
}

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

/** message → (保存) → endEdit → 後続の invoke と await を連ねる処理を流しきる。 */
async function flush() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

let errorSpy: MockInstance<typeof console.error>;
let alertMock: Mock<(message?: unknown) => void>;

beforeEach(() => {
	windowState.endEdit();
	windowState.clearDocument();
	windowState.applyRoot(OLD_ROOT, [], false);
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
	alertMock = vi.fn();
	vi.stubGlobal('alert', alertMock);
	invokeMock.mockReset();
	invokeMock.mockResolvedValue(null);
	messageMock.mockReset();
	askMock.mockReset();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC-48-追o (a) — 確認は 1 枚・3 択(契約1)
// ---------------------------------------------------------------------------

describe('AC-48-追o (a): dirty で関門に入ると message が 1 回だけ・ask は呼ばれない(契約1)', () => {
	it('dirty で confirmDiscardEdits → message が 1 回・ask は 0 回', async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce(CANCEL);

		await confirmDiscardEdits();

		expectSingleDialog();
	});

	it("message の引数は契約1 のとおり(UNSAVED_SAVE_MESSAGE・title=UNSAVED_TITLE・kind='warning'・buttons={ yes: 'Save', no: \"Don't Save\", cancel: 'Cancel' })", async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce(CANCEL);

		await confirmDiscardEdits();

		const [text, options] = messageMock.mock.calls[0]!;
		expect(text).toBe(UNSAVED_SAVE_MESSAGE);
		expect(options).toEqual({
			title: UNSAVED_TITLE,
			kind: 'warning',
			buttons: EXPECTED_BUTTONS,
		});
	});

	it('文言は今の 2 枚目のまま(題 `Unsaved Changes`・本文 `Do you want to save your changes before continuing?`)', () => {
		expect(UNSAVED_TITLE).toBe('Unsaved Changes');
		expect(UNSAVED_SAVE_MESSAGE).toBe('Do you want to save your changes before continuing?');
	});

	it('1 枚目の文言 UNSAVED_PROCEED_MESSAGE は使わなくなるので export から消えている', () => {
		expect('UNSAVED_PROCEED_MESSAGE' in editGuard).toBe(false);
	});

	it('askUnsavedChoice(true) も同じ 1 枚(message 1 回・ask 0 回・引数は契約1)', async () => {
		messageMock.mockResolvedValueOnce(CANCEL);

		await askUnsavedChoice(true);

		expectSingleDialog();
		expect(messageMock.mock.calls[0]![0]).toBe(UNSAVED_SAVE_MESSAGE);
		expect(messageMock.mock.calls[0]![1]).toEqual({
			title: UNSAVED_TITLE,
			kind: 'warning',
			buttons: EXPECTED_BUTTONS,
		});
	});
});

// ---------------------------------------------------------------------------
// 契約2 — 戻り値の読み方(askUnsavedChoice)
// ---------------------------------------------------------------------------

describe("契約2: 戻り値の読み方 — 'Save' → save・\"Don't Save\" → discard・それ以外 → cancel", () => {
	it("'Save' → 'save'", async () => {
		messageMock.mockResolvedValueOnce(SAVE);
		await expect(askUnsavedChoice(true)).resolves.toBe('save');
	});

	it("\"Don't Save\" → 'discard'", async () => {
		messageMock.mockResolvedValueOnce(DONT_SAVE);
		await expect(askUnsavedChoice(true)).resolves.toBe('discard');
	});

	it("'Cancel' → 'cancel'", async () => {
		messageMock.mockResolvedValueOnce(CANCEL);
		await expect(askUnsavedChoice(true)).resolves.toBe('cancel');
	});

	it.each(UNEXPECTED_ANSWERS)("想定外の値 %s → 'cancel'(分からない答えは「進んでよい」と取らない)", async (_label, answer) => {
		messageMock.mockResolvedValueOnce(answer);
		await expect(askUnsavedChoice(true)).resolves.toBe('cancel');
		expectSingleDialog();
	});

	it("dirty でなければ聞かずに 'discard'(message も ask も 0 回)", async () => {
		await expect(askUnsavedChoice(false)).resolves.toBe('discard');
		expectNoDialog();
	});
});

// ---------------------------------------------------------------------------
// AC-48-追o (b) — 答えごとの振る舞い(契約4 は不変)
// ---------------------------------------------------------------------------

describe("AC-48-追o (b): 'Save' は保存が成功してから進む・\"Don't Save\" は畳んで進む・'Cancel' と想定外は進まない", () => {
	it("'Save' → save_document が { uri, content } で 1 回 → true・閲覧へ戻りバッファ破棄・dirty 解除", async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce(SAVE);

		await expect(confirmDiscardEdits()).resolves.toBe(true);

		expectSingleDialog();
		expect(saveCalls()).toEqual([['save_document', { uri: TXT_URI, content: EDITED }]]);
		expectEnded();
		expect(alertMock).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it("'Save' → 保存が終わるまでは true にならず、編集も畳まない(保存の完了を待ってから進む)", async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce(SAVE);
		const save = deferred<null>();
		invokeMock.mockImplementation(async (cmd) => {
			if (cmd === 'save_document') return save.promise;
			return null;
		});
		let settled: boolean | null = null;

		const outcome = confirmDiscardEdits().then((v) => {
			settled = v;
			return v;
		});
		await flush();
		expect(saveCalls()).toHaveLength(1);
		expect(settled).toBe(null);
		expect(windowState.editMode).toBe('edit');
		expect(windowState.editBuffer).toBe(EDITED);

		save.resolve(null);
		await expect(outcome).resolves.toBe(true);
		expectEnded();
	});

	it("'Save' → 保存が失敗したら `Could not save: …` の alert を 1 回出して false・編集中のまま(確認は 1 枚だけ)", async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce(SAVE);
		invokeMock.mockImplementation(async (cmd) => {
			if (cmd === 'save_document') throw new Error('disk full');
			return null;
		});

		await expect(confirmDiscardEdits()).resolves.toBe(false);

		expectSingleDialog();
		expect(saveCalls()).toHaveLength(1);
		expect(alertMock).toHaveBeenCalledTimes(1);
		expect(String(alertMock.mock.calls[0]![0])).toMatch(/^Could not save: /);
		expectStillEditing();
	});

	it("\"Don't Save\" → true・保存は走らず・閲覧へ戻りバッファ破棄", async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce(DONT_SAVE);

		await expect(confirmDiscardEdits()).resolves.toBe(true);

		expectSingleDialog();
		expectNoSave();
		expectEnded();
		expect(alertMock).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it("'Cancel' → false・進まず、editMode・editBuffer・dirty はそのまま・保存も alert も console.error も無い", async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce(CANCEL);

		await expect(confirmDiscardEdits()).resolves.toBe(false);

		expectSingleDialog();
		expectNoSave();
		expectStillEditing();
		expect(alertMock).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it.each(UNEXPECTED_ANSWERS)('想定外の値 %s → false・進まず、editMode・editBuffer・dirty はそのまま・保存しない', async (_label, answer) => {
		makeDirty();
		messageMock.mockResolvedValueOnce(answer);

		await expect(confirmDiscardEdits()).resolves.toBe(false);

		expectSingleDialog();
		expectNoSave();
		expectStillEditing();
		expect(alertMock).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// AC-48-追o (c) — ダイアログが失敗したら取りやめる(契約3=追補k を 1 枚に)
// ---------------------------------------------------------------------------

describe('AC-48-追o (c): message が reject → false・console.error 1 回・保存も endEdit もしない', () => {
	it('reject(Error)→ false で解決し、console.error 1 回・alert 無し・編集中のまま・保存されない', async () => {
		makeDirty();
		messageMock.mockRejectedValueOnce(new Error('dialog plugin unavailable'));

		await expect(confirmDiscardEdits()).resolves.toBe(false);

		expectSingleDialog();
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(alertMock).not.toHaveBeenCalled();
		expectStillEditing();
		expectNoSave();
	});

	it('reject の値が Error でなくても(文字列)同じ', async () => {
		// Tauri の IPC 失敗は文字列で reject されることがある。
		makeDirty();
		messageMock.mockRejectedValueOnce('message failed: plugin not registered');

		await expect(confirmDiscardEdits()).resolves.toBe(false);

		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(alertMock).not.toHaveBeenCalled();
		expectStillEditing();
		expectNoSave();
	});

	it("askUnsavedChoice 単体でも reject → 'cancel'(呼び出し元へ投げない)", async () => {
		messageMock.mockRejectedValueOnce(new Error('dialog plugin unavailable'));

		await expect(askUnsavedChoice(true)).resolves.toBe('cancel');

		expect(errorSpy).toHaveBeenCalledTimes(1);
	});

	it('失敗のあと、ダイアログが復帰すれば次の呼び出しは従来どおり進める(状態を壊していない)', async () => {
		makeDirty();
		messageMock.mockRejectedValueOnce(new Error('dialog plugin unavailable'));
		await expect(confirmDiscardEdits()).resolves.toBe(false);
		expectStillEditing();

		messageMock.mockResolvedValueOnce(DONT_SAVE);
		await expect(confirmDiscardEdits()).resolves.toBe(true);

		expectEnded();
		expectNoSave();
		expect(messageMock).toHaveBeenCalledTimes(2);
		expect(askMock).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// AC-48-追o (d) — dirty でなければ何も聞かない
// ---------------------------------------------------------------------------

describe('AC-48-追o (d): dirty でなければ message も ask も呼ばれず、そのまま進む', () => {
	it('閲覧中(編集モードでない)→ true・確認なし・console.error なし', async () => {
		windowState.setDocument(txtDoc());
		expect(windowState.dirty).toBe(false);

		await expect(confirmDiscardEdits()).resolves.toBe(true);

		expectNoDialog();
		expect(errorSpy).not.toHaveBeenCalled();
		expectNoSave();
	});

	it('編集モードでも未変更なら聞かずに true・閲覧へ戻る', async () => {
		windowState.setDocument(txtDoc());
		expect(windowState.beginEdit()).toBe(true);
		expect(windowState.dirty).toBe(false);

		await expect(confirmDiscardEdits()).resolves.toBe(true);

		expectNoDialog();
		expect(windowState.editMode).toBe('view');
		expectNoSave();
	});

	it('文書を開いていない窓も聞かずに true', async () => {
		expect(windowState.currentDocument).toBeNull();

		await expect(confirmDiscardEdits()).resolves.toBe(true);

		expectNoDialog();
	});
});

// ---------------------------------------------------------------------------
// AC-48-追o (e) — 関門を通る経路のどれでも確認は 1 枚だけ
// ---------------------------------------------------------------------------

describe('AC-48-追o (e) 閉窓(handleCloseRequested): 確認は 1 枚だけ', () => {
	/** preventDefault と destroy の観測台。1 回の閉窓要求ぶん。 */
	function closeRequest() {
		return {
			event: { preventDefault: vi.fn() },
			appWindow: { destroy: vi.fn(async () => undefined) },
		};
	}

	it("'Cancel' → message 1 回・ask 0 回・preventDefault のうえ destroy されず、編集中のまま", async () => {
		makeDirty();
		const { event, appWindow } = closeRequest();
		messageMock.mockResolvedValueOnce(CANCEL);

		await handleCloseRequested(event, appWindow);

		expectSingleDialog();
		expect(event.preventDefault).toHaveBeenCalledTimes(1);
		expect(appWindow.destroy).not.toHaveBeenCalled();
		expectStillEditing();
	});

	it("\"Don't Save\" → message 1 回・ask 0 回・保存せずに destroy", async () => {
		makeDirty();
		const { event, appWindow } = closeRequest();
		messageMock.mockResolvedValueOnce(DONT_SAVE);

		await handleCloseRequested(event, appWindow);

		expectSingleDialog();
		expect(event.preventDefault).toHaveBeenCalledTimes(1);
		expect(appWindow.destroy).toHaveBeenCalledTimes(1);
		expectNoSave();
	});

	it("'Save' → message 1 回・ask 0 回・save_document が成功してから destroy", async () => {
		makeDirty();
		const { event, appWindow } = closeRequest();
		messageMock.mockResolvedValueOnce(SAVE);

		await handleCloseRequested(event, appWindow);

		expectSingleDialog();
		expect(saveCalls()).toEqual([['save_document', { uri: TXT_URI, content: EDITED }]]);
		expect(appWindow.destroy).toHaveBeenCalledTimes(1);
		const saveOrder = invokeMock.mock.invocationCallOrder[
			invokeMock.mock.calls.findIndex(([command]) => command === 'save_document')
		]!;
		const destroyOrder = appWindow.destroy.mock.invocationCallOrder[0]!;
		expect(saveOrder).toBeLessThan(destroyOrder);
	});

	it("'Save' で保存が失敗 → alert 1 回・destroy されず、編集中のまま(確認は 1 枚だけ)", async () => {
		makeDirty();
		const { event, appWindow } = closeRequest();
		messageMock.mockResolvedValueOnce(SAVE);
		invokeMock.mockImplementation(async (cmd) => {
			if (cmd === 'save_document') throw new Error('disk full');
			return null;
		});

		await handleCloseRequested(event, appWindow);

		expectSingleDialog();
		expect(alertMock).toHaveBeenCalledTimes(1);
		expect(appWindow.destroy).not.toHaveBeenCalled();
		expectStillEditing();
	});

	it('非 dirty → 確認なし(message も ask も 0 回)・preventDefault も destroy も呼ばない', async () => {
		windowState.setDocument(txtDoc());
		const { event, appWindow } = closeRequest();

		await handleCloseRequested(event, appWindow);

		expectNoDialog();
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(appWindow.destroy).not.toHaveBeenCalled();
	});
});

describe('AC-48-追o (e) 別ファイル(Explorer の行のクリック): 確認は 1 枚だけ', () => {
	const entries: Entry[] = [
		{ uri: TXT_URI, name: 'memo.txt', kind: 'file' },
		{ uri: OTHER_URI, name: 'plan.md', kind: 'file' },
	];

	/** Explorer を最小の props でマウントし、dirty の text 文書を開いた状態にする。 */
	function mountDirtyExplorer() {
		windowState.applyRoot(OLD_ROOT, entries, false);
		makeDirty();
		invokeMock.mockImplementation(async (cmd, args) => {
			if (cmd === 'open_document' || cmd === 'open_binary_document') {
				return { uri: (args as { uri: string } | undefined)?.uri, content: '# plan\n', modified: null };
			}
			return null;
		});
		render(Explorer, {
			props: {
				root: OLD_ROOT,
				entries,
				selectedUri: TXT_URI,
				onDuplicateWindow: vi.fn(),
				onOpenInNewWindow: vi.fn(),
			},
		});
	}

	/** ツリーのファイル行(ExplorerItem の button は title に URI を持つ)。 */
	const otherRow = () => screen.getByTitle(OTHER_URI);

	it("'Cancel' → message 1 回・ask 0 回・open_document は呼ばれず、文書も編集もそのまま", async () => {
		mountDirtyExplorer();
		messageMock.mockResolvedValueOnce(CANCEL);

		await fireEvent.click(otherRow());
		await flush();

		expectSingleDialog();
		expect(callsOf('open_document')).toHaveLength(0);
		expectNoSave();
		expectStillEditing();
	});

	it("\"Don't Save\" → message 1 回・ask 0 回・保存せずに open_document で別ファイルが開く", async () => {
		mountDirtyExplorer();
		messageMock.mockResolvedValueOnce(DONT_SAVE);

		await fireEvent.click(otherRow());
		await flush();

		expectSingleDialog();
		expectNoSave();
		expect(callsOf('open_document')).toEqual([['open_document', { uri: OTHER_URI }]]);
		expect(windowState.currentDocument?.uri).toBe(OTHER_URI);
		expect(windowState.editMode).toBe('view');
	});

	it("'Save' → message 1 回・ask 0 回・save_document が成功してから open_document", async () => {
		mountDirtyExplorer();
		messageMock.mockResolvedValueOnce(SAVE);

		await fireEvent.click(otherRow());
		await flush();

		expectSingleDialog();
		const names = invokeMock.mock.calls.map((c) => c[0]);
		const saveAt = names.indexOf('save_document');
		const openAt = names.indexOf('open_document');
		expect(saveAt).toBeGreaterThanOrEqual(0);
		expect(openAt).toBeGreaterThan(saveAt);
		expect(saveCalls()).toEqual([['save_document', { uri: TXT_URI, content: EDITED }]]);
		expect(windowState.currentDocument?.uri).toBe(OTHER_URI);
	});
});

describe('AC-48-追o (e) root 変更(pickFolderAndSetRoot=履歴選択画面のフォルダ選択と同じ deps): 確認は 1 枚だけ', () => {
	const NEW_ROOT_PATH = '/Users/a/other';

	/** +page.svelte の selectFolderFromPicker と同じ組み合わせ(関門→ダイアログ→set_root)。 */
	function pick(selected: string | null = NEW_ROOT_PATH) {
		const pickFolder = vi.fn(async () => selected);
		const outcome = pickFolderAndSetRoot({
			confirmDiscard: confirmDiscardEdits,
			pickFolder,
			setRoot: (uri) => invoke('set_root', { uri }),
		});
		return { outcome, pickFolder };
	}

	it("'Cancel' → message 1 回・ask 0 回・フォルダ選択も set_root も呼ばれず、編集はそのまま", async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce(CANCEL);

		const { outcome, pickFolder } = pick();
		await expect(outcome).resolves.toEqual({ kind: 'cancelled' });

		expectSingleDialog();
		expect(pickFolder).not.toHaveBeenCalled();
		expect(callsOf('set_root')).toHaveLength(0);
		expectNoSave();
		expectStillEditing();
	});

	it("\"Don't Save\" → message 1 回・ask 0 回・保存せずにフォルダ選択 → set_root", async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce(DONT_SAVE);

		const { outcome, pickFolder } = pick();
		await expect(outcome).resolves.toEqual({ kind: 'applied', root: null });

		expectSingleDialog();
		expect(pickFolder).toHaveBeenCalledTimes(1);
		expect(callsOf('set_root')).toEqual([['set_root', { uri: NEW_ROOT }]]);
		expectNoSave();
		expectEnded();
	});

	it("'Save' → message 1 回・ask 0 回・save_document が成功してから set_root", async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce(SAVE);

		const { outcome } = pick();
		await expect(outcome).resolves.toEqual({ kind: 'applied', root: null });

		expectSingleDialog();
		const names = invokeMock.mock.calls.map((c) => c[0]);
		const saveAt = names.indexOf('save_document');
		const rootAt = names.indexOf('set_root');
		expect(saveAt).toBeGreaterThanOrEqual(0);
		expect(rootAt).toBeGreaterThan(saveAt);
		expect(saveCalls()).toEqual([['save_document', { uri: TXT_URI, content: EDITED }]]);
	});
});

describe('AC-48-追o (e) CLI の切り替え(handleRootSwitchRequest): 確認は 1 枚だけ', () => {
	/** +page.svelte と同じ組み合わせで依頼 1 件を処理する。 */
	function requestSwitch(onError?: (err: unknown) => void) {
		return handleRootSwitchRequest(
			{ root_uri: NEW_ROOT },
			{ confirmDiscard: confirmDiscardEdits, switchRoot: switchRootConfirmed, onError }
		);
	}

	/** 何も変わっていない: root・文書・編集(モード・バッファ・dirty)がそのまま。 */
	function expectUntouched() {
		expect(windowState.root).toBe(OLD_ROOT);
		expectStillEditing();
	}

	it("'Cancel' → 'cancelled'・message 1 回・ask 0 回・switch_root_confirmed は invoke されず、root も文書も編集もそのまま", async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce(CANCEL);

		await expect(requestSwitch()).resolves.toBe('cancelled');

		expectSingleDialog();
		expect(callsOf('switch_root_confirmed')).toHaveLength(0);
		expectNoSave();
		expectUntouched();
		expect(alertMock).not.toHaveBeenCalled();
	});

	it("\"Don't Save\" → 'switched'・message 1 回・ask 0 回・switch_root_confirmed を { uri } で 1 回・保存は走らない", async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce(DONT_SAVE);

		await expect(requestSwitch()).resolves.toBe('switched');

		expectSingleDialog();
		expect(callsOf('switch_root_confirmed')).toEqual([['switch_root_confirmed', { uri: NEW_ROOT }]]);
		expectNoSave();
		expectEnded();
	});

	it("'Save' → 'switched'・message 1 回・ask 0 回・save_document が先・switch_root_confirmed が後", async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce(SAVE);

		await expect(requestSwitch()).resolves.toBe('switched');

		expectSingleDialog();
		const names = invokeMock.mock.calls.map((c) => c[0]);
		const saveAt = names.indexOf('save_document');
		const switchAt = names.indexOf('switch_root_confirmed');
		expect(saveAt).toBeGreaterThanOrEqual(0);
		expect(switchAt).toBeGreaterThan(saveAt);
		expect(saveCalls()).toEqual([['save_document', { uri: TXT_URI, content: EDITED }]]);
		expect(callsOf('switch_root_confirmed')).toHaveLength(1);
	});

	it("'Save' で保存が失敗 → 'cancelled'・alert 1 回・切り替えを頼まず編集を残す(確認は 1 枚だけ)", async () => {
		makeDirty();
		messageMock.mockResolvedValueOnce(SAVE);
		invokeMock.mockImplementation(async (cmd) => {
			if (cmd === 'save_document') throw new Error('disk full');
			return null;
		});

		await expect(requestSwitch()).resolves.toBe('cancelled');

		expectSingleDialog();
		expect(callsOf('switch_root_confirmed')).toHaveLength(0);
		expect(alertMock).toHaveBeenCalledTimes(1);
		expect(String(alertMock.mock.calls[0]![0])).toMatch(/^Could not save: /);
		expectUntouched();
	});

	it("ダイアログの失敗(契約3)→ 'cancelled'・console.error 1 回・切り替えを頼まず編集を残す", async () => {
		makeDirty();
		messageMock.mockRejectedValueOnce(new Error('dialog plugin unavailable'));

		await expect(requestSwitch()).resolves.toBe('cancelled');

		expectSingleDialog();
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(callsOf('switch_root_confirmed')).toHaveLength(0);
		expectUntouched();
	});

	it('編集が無ければ確認なし(message も ask も 0 回)で switch_root_confirmed', async () => {
		windowState.setDocument(txtDoc());
		expect(windowState.dirty).toBe(false);

		await expect(requestSwitch()).resolves.toBe('switched');

		expectNoDialog();
		expect(callsOf('switch_root_confirmed')).toHaveLength(1);
	});
});
