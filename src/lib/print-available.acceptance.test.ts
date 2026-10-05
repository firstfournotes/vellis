/**
 * 要件#38 追補f の受け入れテスト(docs/requirements/req-38.md 追補f・backlog 251)— フロント層
 *
 * 「文書を開いていない窓(履歴選択画面・空の状態)が前面のとき、File > Print… は
 *  無効(灰色)になり、Command + P を押しても印刷ダイアログは開かない」
 * (2026-10-02 由谷「メニューを無効にして開かないようにして」)
 *
 * 契約(追補f)のうちフロントの持ち場:
 * - 3. 各窓は「文書を開いているか」を純関数で決め(`currentDocument` があり、履歴選択
 *   画面を出していない)、変わるたびに `set_print_available`(引数は真偽1つ)で本体へ
 *   知らせる。知らせる配線(+page.svelte の $effect)は reviewer 照合
 * - 4. 念のための止め: メニューのイベントが届いても、文書を開いていない窓は何もしない
 *   (`registerPrintListener` が無視する=`print_current_window` も印刷窓も呼ばない)
 * - Print… 項目・印刷の経路・`print.css` は不変(既存の print-html.acceptance.test.ts が
 *   そのまま緑=AC-38-追f (e))
 *
 * 本ファイルの持ち場= AC-38-追f の (c)(d)。Rust 側((a) 純関数・(b) ソース走査)は
 * `src-tauri/tests/acceptance_req38f.rs`。
 *
 * ## 確定契約(公開 API・implementer はこれに従う)
 *
 * ```ts
 * // src/lib/print-html.ts(既存モジュールに追加)
 *
 * // (c) 「この窓は印刷できる文書を開いているか」(純関数)。
 * // 入力は +page.svelte の windowState.currentDocument と rootPicker.open に対応する
 * // (shouldShowFindInFolder(rootUri, rootPickerOpen) と同じ家風の位置引数)。
 * // 文書があり、履歴選択画面を出していないときだけ true。文書の種類は見ない
 * // (markdown / text はメインフレーム印刷・HTML は印刷窓=従来どおり印刷できる)。
 * export function isPrintAvailable(
 *   currentDocument: { uri: string } | null | undefined,
 *   rootPickerOpen: boolean
 * ): boolean;
 *
 * // (d) registerPrintListener に「印刷できるか」を返す口を足す。
 * // 発火のたびに呼ぶ(押した時点の状態で決まる=getFileType と同じ理由)。false なら
 * // 何もしない: invoke('print_current_window') も invoke('print_html') も呼ばず、
 * // getHtmlSource も呼ばず、onError も呼ばない(失敗ではなく「対象外」)。
 * // 省略時は従来どおり印刷する(既存の呼び出し・既存テストとの互換= (e))。
 * export type PrintHandlers = {
 *   getFileType: () => FileType;
 *   getHtmlSource: () => { content: string; docUri: string };
 *   canPrint?: () => boolean;      // 追補f で追加
 *   onError?: (err: unknown) => void;
 * };
 * export function registerPrintListener(handlers: PrintHandlers): Promise<() => void>;
 * ```
 *
 * ## reviewer 照合に委ねる配線
 * - +page.svelte: `isPrintAvailable(windowState.currentDocument, rootPicker.open)` の値が
 *   変わるたびに `invoke('set_print_available', { available })` を呼ぶ(初期値も1回
 *   知らせる=既定が「開いていない」なので、起動直後に文書を開いた窓も知らせないと
 *   Print… が灰色のまま)。registerPrintListener には `canPrint: () =>
 *   isPrintAvailable(windowState.currentDocument, rootPicker.open)` を渡す
 * - Rust 側の command の引数名が `available` であること(acceptance_req38f.rs が固定)
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('$lib/events', () => ({ listen: vi.fn() }));

import { invoke } from '$lib/ipc';
import { listen } from '$lib/events';
import type { FileType } from './file-type';
import { MENU_PRINT_EVENT, isPrintAvailable, registerPrintListener } from './print-html';

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

const DOC = { uri: 'file:///Users/a/notes/today.md' };
const HTML_VIEW = { content: '<p>doc</p>', docUri: 'file:///Users/a/site/page.html' };

/** fire-and-forget なハンドラ実装でも完了を待てるように1マクロタスク挟む(print-html と同じ)。 */
const flushAsync = () => new Promise<void>((r) => setTimeout(r, 0));

/** 登録済みハンドラを取り出す(登録順には依存しない)。 */
const handlerFor = () => listenMock.mock.calls.find((c) => c[0] === MENU_PRINT_EVENT)?.[1];

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
	listenMock.mockResolvedValue(() => {});
	invokeMock.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// (c) isPrintAvailable — 文書があり、履歴選択画面を出していないときだけ印刷できる
// ---------------------------------------------------------------------------

describe('isPrintAvailable — 文書を開いているか(契約 3 の純関数)', () => {
	test('文書を開いていて履歴選択画面を出していない → 印刷できる', () => {
		expect(isPrintAvailable(DOC, false)).toBe(true);
	});

	test('currentDocument が null(空の状態)→ 印刷できない', () => {
		expect(isPrintAvailable(null, false)).toBe(false);
	});

	test('currentDocument が undefined でも印刷できない(null と同じ扱い)', () => {
		expect(isPrintAvailable(undefined, false)).toBe(false);
	});

	test('履歴選択画面を出している → 印刷できない(文書が残っていても)', () => {
		expect(isPrintAvailable(DOC, true)).toBe(false);
	});

	test('文書も無く履歴選択画面も出している → 印刷できない', () => {
		expect(isPrintAvailable(null, true)).toBe(false);
	});

	test('文書の種類は見ない: markdown / text / html / pdf のどれでも開いていれば印刷できる', () => {
		for (const uri of [
			'file:///a/doc.md',
			'file:///a/doc.txt',
			'file:///a/page.html',
			'file:///a/paper.pdf',
			'ssh://dev@box/srv/www/index.html'
		]) {
			expect(isPrintAvailable({ uri }, false)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// (d) registerPrintListener — 印刷できないときはイベントが届いても何もしない
// ---------------------------------------------------------------------------

describe('registerPrintListener — canPrint が false なら何もしない(契約 4 の止め)', () => {
	test('canPrint=false・markdown 表示: 発火しても print_current_window を呼ばない', async () => {
		const getHtmlSource = vi.fn(() => HTML_VIEW);
		const onError = vi.fn();
		await registerPrintListener({
			getFileType: () => 'markdown',
			getHtmlSource,
			canPrint: () => false,
			onError
		});

		await handlerFor()?.({ payload: undefined });
		await flushAsync();

		expect(invokeMock).not.toHaveBeenCalled();
		expect(getHtmlSource).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
	});

	test('canPrint=false・html 表示: 発火しても print_html(印刷窓)を呼ばない', async () => {
		const getHtmlSource = vi.fn(() => HTML_VIEW);
		const onError = vi.fn();
		await registerPrintListener({
			getFileType: () => 'html',
			getHtmlSource,
			canPrint: () => false,
			onError
		});

		await handlerFor()?.({ payload: undefined });
		await flushAsync();

		expect(invokeMock).not.toHaveBeenCalled();
		expect(getHtmlSource).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
	});

	test('canPrint=false は全ビューア種別で止まる(経路に依らない)', async () => {
		let current: FileType = 'markdown';
		await registerPrintListener({
			getFileType: () => current,
			getHtmlSource: () => HTML_VIEW,
			canPrint: () => false
		});

		const types: FileType[] = ['markdown', 'text', 'html', 'image', 'model3d', 'video', 'audio', 'pdf', 'binary'];
		for (const type of types) {
			current = type;
			await handlerFor()?.({ payload: undefined });
			await flushAsync();
		}

		expect(invokeMock).not.toHaveBeenCalled();
	});

	test('canPrint=true なら従来どおり印刷する(markdown → print_current_window)', async () => {
		await registerPrintListener({
			getFileType: () => 'markdown',
			getHtmlSource: () => HTML_VIEW,
			canPrint: () => true
		});

		await handlerFor()?.({ payload: undefined });
		await flushAsync();

		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock.mock.calls[0]?.[0]).toBe('print_current_window');
	});

	test('canPrint=true なら従来どおり印刷する(html → print_html)', async () => {
		await registerPrintListener({
			getFileType: () => 'html',
			getHtmlSource: () => HTML_VIEW,
			canPrint: () => true
		});

		await handlerFor()?.({ payload: undefined });
		await flushAsync();

		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock.mock.calls[0]?.[0]).toBe('print_html');
	});

	test('発火のたびに canPrint を読み直す(履歴選択画面 → 文書 → 空の状態、と追う)', async () => {
		let available = false;
		const canPrint = vi.fn(() => available);
		await registerPrintListener({
			getFileType: () => 'markdown',
			getHtmlSource: () => HTML_VIEW,
			canPrint
		});

		await handlerFor()?.({ payload: undefined }); // 履歴選択画面: 何もしない
		await flushAsync();
		available = true;
		await handlerFor()?.({ payload: undefined }); // 文書を開いた: 印刷する
		await flushAsync();
		available = false;
		await handlerFor()?.({ payload: undefined }); // 空の状態: 何もしない
		await flushAsync();

		expect(canPrint).toHaveBeenCalledTimes(3);
		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['print_current_window']);
	});

	test('購読しただけでは canPrint を呼ばない(判定は発火時)', async () => {
		const canPrint = vi.fn(() => true);
		await registerPrintListener({
			getFileType: () => 'markdown',
			getHtmlSource: () => HTML_VIEW,
			canPrint
		});

		expect(canPrint).not.toHaveBeenCalled();
		expect(invokeMock).not.toHaveBeenCalled();
	});

	test('canPrint 省略時は従来どおり印刷する(既存の呼び出しとの互換= (e))', async () => {
		await registerPrintListener({
			getFileType: () => 'markdown',
			getHtmlSource: () => HTML_VIEW
		});

		await handlerFor()?.({ payload: undefined });
		await flushAsync();

		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock.mock.calls[0]?.[0]).toBe('print_current_window');
	});

	test('canPrint=false でも購読自体は MENU_PRINT_EVENT 1本のまま(止めるのは発火時であって購読ではない)', async () => {
		await registerPrintListener({
			getFileType: () => 'markdown',
			getHtmlSource: () => HTML_VIEW,
			canPrint: () => false
		});

		expect(listenMock.mock.calls.map((c) => c[0])).toEqual([MENU_PRINT_EVENT]);
	});
});
