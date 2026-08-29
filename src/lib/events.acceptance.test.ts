/**
 * 要件#33 の受け入れテスト(requirements.md #33)
 * 「メニューの Open… / Open Folder…(要件#11)のダイアログをアクティブ(フォーカス中)の
 *  ウィンドウにのみ表示する(現状は開いている全ウィンドウにそれぞれダイアログが出る)。
 *  同一原因の show_marks・root_changed も宛先ウィンドウのみが反応するよう修正する」
 *
 * 契約:
 * - 原因: フロントの購読($lib/events の listen)が @tauri-apps/api/event の既定
 *   ターゲット { kind: 'Any' } で登録されるため、Rust 側が emit_to(宛先ラベル指定)で
 *   発行しても全ウィンドウの listener が受信する — Tauri 2 のイベント配送は
 *   受信側 listener の target でフィルタされる(node_modules/@tauri-apps/api/event.js:
 *   options なし・target 省略 → { kind: 'Any' } で登録)
 * - 修正: 受信側を現在ウィンドウ限定ターゲット WebviewWindow{label: 現在ラベル} で
 *   購読する。events.ts の listen 一点修正(全リスナーはこの薄いラッパ経由=
 *   menu-open.ts / +page.svelte / ModelViewer.svelte)。全窓ブロードキャストの emit は
 *   全ターゲットの listener に届くため挙動不変
 * - emit 側(menu.rs の menu_open_file / menu_open_folder・ipc/handler.rs の
 *   show_marks / root_changed)は既に emit_to で宛先指定済み=変更しない
 *   (Rust 変更なし・依存追加なし)
 *
 * 判定範囲(本ファイル): $lib/events の listen が下位 @tauri-apps/api/event の listen へ
 * **現在ウィンドウ限定ターゲット { kind: 'WebviewWindow', label: 現在ラベル } で購読登録
 * すること**+既存ラッパの責務(イベント名・payload の素通し・unlisten 返却)の維持。
 * 現在ラベルは @tauri-apps/api/webviewWindow の getCurrentWebviewWindow 由来とする
 * (モックのラベルは意図的に 'main' 以外=既定ラベルのハードコードでは通らない)。
 * getCurrentWebviewWindow() の返す窓オブジェクトの .listen() に委ねる実装も、実物
 * (webviewWindow.js は target: { kind: 'WebviewWindow', label: this.label } で
 * event.js の listen へ委譲)と同挙動のフェイクで受け入れる。
 *
 * 補足: 現在ラベルの取得を購読ごとに行うかモジュール読込時に1回で済ませるかは
 * 実装の自由(実窓のラベルは webview の生存中は不変)なので、本テストは
 * getCurrentWebviewWindow の呼び出し回数・時点を判定しない。
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - Rust 側 emit_to(menu.rs / ipc/handler.rs)の宛先指定が維持されていること
 *   (契約=emit 側は変更しない)
 * - $lib/events を経由しない tauri listen の新設がないこと(窓限定の抜け道防止)
 *
 * ## 人間ゲート(acceptance/acceptance.md 側=オーケストレーターが記帳)
 * - 実アプリで2窓開き、メニューの Open… / Open Folder… のダイアログが
 *   フォーカス中の窓にのみ出ること(非フォーカス窓は無反応)
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

/** 下位 listen が受け取る購読オプション(event.js の第3引数)。 */
type ListenOptions = { target?: string | { kind: string; label?: string } };
/** 下位 listen に登録されるハンドラ。 */
type RegisteredHandler = (e: { payload: unknown }) => void;

const { CURRENT_LABEL, tauriListenMock } = vi.hoisted(() => ({
	// 意図的に既定の 'main' 以外にする=ラベルのハードコード実装では通らない。
	CURRENT_LABEL: 'req33-acceptance-window',
	tauriListenMock: vi.fn<
		(
			event: string,
			handler: (e: { payload: unknown }) => void,
			options?: { target?: string | { kind: string; label?: string } }
		) => Promise<() => void>
	>(),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: tauriListenMock }));

vi.mock('@tauri-apps/api/webviewWindow', () => {
	/**
	 * 実物の WebviewWindow と同じ判定面だけを持つフェイク:
	 * .label と、target: WebviewWindow{label} で event.js の listen へ委譲する .listen()
	 * (node_modules/@tauri-apps/api/webviewWindow.js と同挙動)。
	 * ラベルを読んで options を自組みする実装・.listen() へ委ねる実装のどちらも
	 * 同じ tauriListenMock の記録に落ちる。
	 */
	class FakeWebviewWindow {
		constructor(public readonly label: string) {}
		listen(event: string, handler: (e: { payload: unknown }) => void): Promise<() => void> {
			return tauriListenMock(event, handler, {
				target: { kind: 'WebviewWindow', label: this.label },
			});
		}
	}
	return {
		WebviewWindow: FakeWebviewWindow,
		getCurrentWebviewWindow: vi.fn(() => new FakeWebviewWindow(CURRENT_LABEL)),
	};
});

import { listen } from './events';

/** 下位 listen への登録をイベント名で取り出す(登録順には依存しない)。 */
const registrationFor = (event: string) =>
	tauriListenMock.mock.calls.find((c) => c[0] === event);

beforeEach(() => {
	tauriListenMock.mockReset();
	// 既定: 購読は成功し、no-op の unlisten を返す(必要なテストで上書きする)。
	tauriListenMock.mockResolvedValue(() => {});
});

// ---------------------------------------------------------------------------
// 窓限定ターゲットでの購読登録 — 要件#33 の判定点(実装前は赤)
// ---------------------------------------------------------------------------

describe('listen — 現在ウィンドウ限定ターゲットでの購読登録(要件#33)', () => {
	test('下位 listen へ target: WebviewWindow{現在ラベル} を渡して登録する', async () => {
		await listen('root_changed', vi.fn());

		expect(tauriListenMock).toHaveBeenCalledTimes(1);
		const call = tauriListenMock.mock.calls[0];
		expect(call?.[0]).toBe('root_changed');
		const options: ListenOptions | undefined = call?.[2];
		// AnyLabel(文字列 target)や Window/Webview kind では窓限定の契約を満たさない。
		expect(options?.target).toEqual({ kind: 'WebviewWindow', label: CURRENT_LABEL });
	});

	test('既定の Any ターゲット(options なし・target 省略)では登録しない', async () => {
		await listen('show_marks', vi.fn());

		expect(tauriListenMock).toHaveBeenCalledTimes(1);
		const options: ListenOptions | undefined = tauriListenMock.mock.calls[0]?.[2];
		// options / target の省略は event.js 内部で { kind: 'Any' } になる=全窓受信。
		expect(options).toBeDefined();
		expect(options?.target).toBeDefined();
		expect(options?.target).not.toEqual({ kind: 'Any' });
	});

	test('要件#33 の対象イベント4種すべて窓限定で購読される(共有ラッパの一点修正の効き)', async () => {
		const events = ['menu_open_file', 'menu_open_folder', 'show_marks', 'root_changed'];
		for (const name of events) {
			await listen(name, vi.fn());
		}

		for (const name of events) {
			const call = registrationFor(name);
			expect(call, `${name} の購読が下位 listen に渡っていない`).toBeDefined();
			expect(call?.[2]?.target, `${name} の購読ターゲットが窓限定でない`).toEqual({
				kind: 'WebviewWindow',
				label: CURRENT_LABEL,
			});
		}
	});
});

// ---------------------------------------------------------------------------
// 薄いラッパの既存責務の維持 — 修正が素通し・解除を壊さないこと(退行ガード)
// ---------------------------------------------------------------------------

describe('listen — 薄いラッパの既存責務の維持', () => {
	test('イベント名を変えずに下位 listen へ渡す', async () => {
		await listen('menu_open_file', vi.fn());

		expect(tauriListenMock.mock.calls[0]?.[0]).toBe('menu_open_file');
	});

	test('ハンドラへ payload が素通しで届く(ラッパは変換しない=同一参照)', async () => {
		const received: unknown[] = [];
		await listen<{ root_uri: string }>('root_changed', (e) => {
			received.push(e.payload);
		});

		const registered: RegisteredHandler | undefined = tauriListenMock.mock.calls[0]?.[1];
		expect(registered).toBeTypeOf('function');
		const payload = { root_uri: 'file:///Users/a/docs' };
		registered?.({ payload });

		expect(received).toHaveLength(1);
		expect(received[0]).toBe(payload);
	});

	test('返り値を呼ぶと下位の unlisten で解除される', async () => {
		const unlisten = vi.fn();
		tauriListenMock.mockResolvedValueOnce(unlisten);

		const returned = await listen('show_marks', vi.fn());
		expect(unlisten).not.toHaveBeenCalled();

		returned();
		expect(unlisten).toHaveBeenCalledTimes(1);
	});
});
