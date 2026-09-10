/**
 * backlog 139 の受け入れテスト(その2・閉窓経路の wiring)。
 *
 * 要件#48 契約④の受け入れには「dirty で閉じようとすると確認ダイアログが出る」
 * までしか機械判定が無く、**①確認後に実際に閉じること ②非 dirty ならそのまま
 * 閉じること**が抜けていた(その抜けが v0.1.35 の「閉じるボタン無反応」を
 * 通した)。本ファイルはその2点をハンドラの分岐として固定する。
 *
 * ## 実装側に求める形(implementer はこれに従う)
 *
 * `+page.svelte` の `onCloseRequested` に渡している無名ハンドラを
 * **`src/lib/close-window.ts`(新規)へ切り出す**:
 *
 * ```ts
 * // 閉窓要求のハンドラ本体(要件#48 契約④)。+page.svelte は
 * // appWindow.onCloseRequested((event) => handleCloseRequested(event, appWindow))
 * // の形でこれを渡すだけにする(判断はここ・購読の管理は +page 側)。
 * export async function handleCloseRequested(
 * 	event: { preventDefault: () => void },
 * 	appWindow: { destroy: () => Promise<void> }
 * ): Promise<void>;
 * ```
 *
 * dirty の判定は `windowState.dirty`・確認と保存の実体は `$lib/edit-guard` の
 * `confirmDiscardEdits`(既存)をそのまま使うこと。runes を含む windowState を
 * 通すため component プロジェクト(*.wiring.test.ts)に置く。
 *
 * ## 判定するもの(要件#48 契約④の抜けの補完=backlog 139)
 * - (a) **非 dirty**: preventDefault を呼ばない(= Tauri 側の既定の閉じる動作に
 *   委ねる)・destroy も自分では呼ばない・確認ダイアログも出さない
 * - (b) **dirty → 確認で「破棄」**: preventDefault を呼んだうえで、確認の後に
 *   `appWindow.destroy()` が呼ばれる(「ダイアログが出る」で止めない)
 * - (b') **dirty → 確認で「保存」**: `save_document` が成功してから destroy
 * - (c) **dirty → 「キャンセル」**: destroy は呼ばれず、編集中のまま
 *
 * ## 判定しないもの
 * - +page.svelte が実際に onCloseRequested へこのハンドラを渡している配線
 *   → reviewer 照合
 * - destroy() が権限エラーにならないこと → close-window.acceptance.test.ts
 *   (capability 検査)+実機確認(人間ゲート)
 *
 * ## スタブの設計(Viewer.edit.wiring.test.ts の家風)
 * - $lib/ipc: モジュールモック(save_document の観測)
 * - @tauri-apps/plugin-dialog: `ask` をモック。edit-guard 自体はモックしない —
 *   関門の実体を通し、`ask` の回数・返り値で3択を再現する
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCloseRequested } from './close-window';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn() }));

import { ask } from '@tauri-apps/plugin-dialog';
import { invoke } from '$lib/ipc';

const askMock = vi.mocked(ask);
const invokeMock = vi.mocked(invoke);

const TXT_URI = 'file:///Users/a/notes/memo.txt';
const TXT_CONTENT = 'first line\nsecond line\n';
const EDITED = TXT_CONTENT + 'my edit\n';

function txtDoc(): DocumentPayload {
	return { uri: TXT_URI, content: TXT_CONTENT, modified: 1 };
}

/** preventDefault と destroy の観測台。1回の閉窓要求ぶん。 */
function closeRequest() {
	return {
		event: { preventDefault: vi.fn() },
		appWindow: { destroy: vi.fn(async () => undefined) },
	};
}

/** text 文書を編集モードに入れて dirty にする。 */
function makeDirty() {
	windowState.setDocument(txtDoc());
	windowState.beginEdit();
	windowState.updateBuffer(EDITED);
	expect(windowState.dirty).toBe(true);
}

beforeEach(() => {
	windowState.endEdit();
	windowState.clearDocument();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('handleCloseRequested — 閉窓要求の分岐(backlog 139・要件#48 契約④)', () => {
	it('(a) 非 dirty: preventDefault を呼ばず Tauri の既定の閉じる動作に委ねる(確認も destroy もなし)', async () => {
		windowState.setDocument(txtDoc());
		const { event, appWindow } = closeRequest();

		await handleCloseRequested(event, appWindow);

		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(askMock).not.toHaveBeenCalled();
		expect(appWindow.destroy).not.toHaveBeenCalled();
	});

	it('(a) 文書を開いていない窓も同じく委ねる(非 dirty の一種)', async () => {
		const { event, appWindow } = closeRequest();

		await handleCloseRequested(event, appWindow);

		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(appWindow.destroy).not.toHaveBeenCalled();
	});

	it('(b) dirty → 続ける→破棄: preventDefault のうえ確認後に destroy が呼ばれる(保存は走らない)', async () => {
		makeDirty();
		const { event, appWindow } = closeRequest();
		askMock.mockResolvedValueOnce(true); // 1枚目: 続ける
		askMock.mockResolvedValueOnce(false); // 2枚目: 破棄する

		await handleCloseRequested(event, appWindow);

		expect(event.preventDefault).toHaveBeenCalledTimes(1);
		expect(askMock).toHaveBeenCalledTimes(2);
		expect(appWindow.destroy).toHaveBeenCalledTimes(1);
		expect(invokeMock).not.toHaveBeenCalledWith('save_document', expect.anything());
	});

	it("(b') dirty → 続ける→保存: save_document が呼ばれてから destroy", async () => {
		makeDirty();
		const { event, appWindow } = closeRequest();
		askMock.mockResolvedValueOnce(true); // 1枚目: 続ける
		askMock.mockResolvedValueOnce(true); // 2枚目: 保存する

		await handleCloseRequested(event, appWindow);

		expect(invokeMock).toHaveBeenCalledWith('save_document', {
			uri: TXT_URI,
			content: EDITED,
		});
		expect(appWindow.destroy).toHaveBeenCalledTimes(1);
		// 保存 → destroy の順(保存できてから閉じる=edit-guard の意味論)。
		const saveOrder = invokeMock.mock.invocationCallOrder[
			invokeMock.mock.calls.findIndex(([command]) => command === 'save_document')
		];
		const destroyOrder = appWindow.destroy.mock.invocationCallOrder[0];
		expect(saveOrder).toBeLessThan(destroyOrder);
	});

	it('(c) dirty → キャンセル: preventDefault は呼ぶが destroy は呼ばれず、編集中のまま', async () => {
		makeDirty();
		const { event, appWindow } = closeRequest();
		askMock.mockResolvedValueOnce(false); // 1枚目: キャンセル

		await handleCloseRequested(event, appWindow);

		expect(event.preventDefault).toHaveBeenCalledTimes(1);
		expect(appWindow.destroy).not.toHaveBeenCalled();
		expect(windowState.editMode).toBe('edit');
		expect(windowState.editBuffer).toBe(EDITED);
	});
});
