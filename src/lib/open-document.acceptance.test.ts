/**
 * 要件#22 の受け入れテスト(requirements.md #22)— フロント経路
 * 「表示中のラスタ画像(png/jpg/jpeg/gif/webp/avif/bmp/ico)の変更追従を
 *  テキスト文書と同等に揃える: ①変更の自動反映 ②削除で表示を閉じる
 *  ③reload 復元(要件#10)の対象に含める」
 *
 * 背景(要件#16 の既知の代償): これまで `openForDisplay` はラスタ画像を
 * `unreadDocument`(invoke なし)で返していたため文書セッション=監視が張られず、
 * reload 復元(restoreSnapshot)は `open_document` 直呼びで InvalidUtf8 に落ちて
 * ラスタは復元されなかった。
 *
 * 契約(2026-08-18 由谷決定・設計方針は requirements.md #22 の周回設計判断):
 * - ラスタ画像も watch-only の文書セッションを張る=新コマンド
 *   `open_binary_document` を invoke する(subscribe-first・session 差し替えは
 *   Rust 側の持ち場。イベント契約は src-tauri/tests/acceptance_req22.rs)
 * - reload 復元はラスタの docUri も復元経路(openForDisplay 相当)へ通す
 *
 * 判定範囲(本ファイル): 「どのコマンドを呼ぶか」の経路切替の純ロジック。
 * 実装先 `src/lib/open-document.ts`(openForDisplay)と
 * `src/lib/reload-state.ts`(restoreSnapshot)。
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * 1. `openForDisplay(uri)`:
 *    - テキストとして読めるもの(readsAsText=true。md/html/txt/svg …)は従来どおり
 *      `invoke('open_document', { uri })`(既存挙動の維持)
 *    - ラスタ画像8種は `invoke('open_binary_document', { uri })` を1回呼び、
 *      解決値(DocumentPayload)をそのまま返す。unreadDocument での即席合成はしない —
 *      invoke を通ることが「セッションが張られた」ことの機械判定点
 *    - ラスタで invoke が失敗(ファイル消滅等)→ reject を伝播する(テキスト経路と
 *      同じ。呼び出し側=reload 復元がフォールバックを選べる素材)
 * 2. `restoreSnapshot(snapshot)`(要件#10 の既存契約への追補。既存テスト
 *    reload-state.acceptance.test.ts の text 経路契約は不変):
 *    - docUri がラスタ画像 → `set_root` の後に `open_binary_document` を呼ぶ
 *      (`open_document` は呼ばない=InvalidUtf8 で必ず失敗する経路を通さない)。
 *      document には解決値を返す
 *    - ラスタの open_binary_document 失敗(画像消滅)→ root は復元したまま
 *      document:null(text 経路の部分フォールバックと同じ)
 *    - invoke は `$lib/ipc` の薄いラッパを使うこと(既存の家風・本テストは
 *      これを vi.mock して判定する)
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - +page.svelte / Explorer / menu-open がラスタを openForDisplay(相当)経由で
 *   開くこと・binary_file_changed / file_removed の listen 配線
 * - 要件#16 の契約コメント(image-viewing.ts / open-document.ts 冒頭・
 *   menu-open.ts)の「監視対象外」記述の更新
 *
 * ## 人間ゲート(gate)
 * - 実機で png の上書き→表示更新・削除→表示クローズ・reload→復元
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));

import { invoke } from '$lib/ipc';
import { openForDisplay } from './open-document';
import { restoreSnapshot } from './reload-state';

const invokeMock = vi.mocked(invoke);

// backend の URI 表現に合わせた生文字列(reload-state のテストと同じ前提)
const ROOT = 'file:///Users/a/work';
const IMG = `${ROOT}/pics/photo.png`;
const MD = `${ROOT}/notes/plan.md`;
const SVG = `${ROOT}/pics/diagram.svg`;

const RASTER_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico'] as const;

beforeEach(() => {
	invokeMock.mockReset();
});

/** invoke 呼び出しのコマンド名列(順序ごと判定する)。 */
function invokedCommands(): string[] {
	return invokeMock.mock.calls.map((c) => c[0] as string);
}

// ---------------------------------------------------------------------------
// openForDisplay — ラスタは open_binary_document・テキストは従来どおり
// ---------------------------------------------------------------------------

describe('openForDisplay — ラスタ画像も watch-only セッションを張る(要件#22 ①②)', () => {
	test('テキスト(.md)は従来どおり open_document を呼ぶ(既存挙動の維持)', async () => {
		const payload = { uri: MD, content: '# plan', modified: 1 };
		invokeMock.mockResolvedValue(payload);

		const res = await openForDisplay(MD);

		expect(invokeMock.mock.calls).toEqual([['open_document', { uri: MD }]]);
		expect(res).toBe(payload);
	});

	test('SVG はテキスト経路のまま open_document(要件#16 の契約を壊さない)', async () => {
		invokeMock.mockResolvedValue({ uri: SVG, content: '<svg/>', modified: null });

		await openForDisplay(SVG);

		expect(invokedCommands()).toEqual(['open_document']);
	});

	test('ラスタ(.png)は open_binary_document を1回呼び、解決値をそのまま返す', async () => {
		const payload = { uri: IMG, content: '', modified: null };
		invokeMock.mockResolvedValue(payload);

		const res = await openForDisplay(IMG);

		expect(invokeMock.mock.calls).toEqual([['open_binary_document', { uri: IMG }]]);
		expect(res).toBe(payload);
	});

	test('ラスタ8種すべてが open_binary_document 経路(拡張子の取りこぼしなし)', async () => {
		for (const ext of RASTER_EXTENSIONS) {
			invokeMock.mockReset();
			const uri = `${ROOT}/pics/sample.${ext}`;
			invokeMock.mockResolvedValue({ uri, content: '', modified: null });

			await openForDisplay(uri);

			expect(invokedCommands(), `.${ext} はラスタ経路を通ること`).toEqual([
				'open_binary_document',
			]);
		}
	});

	test('ラスタで invoke が失敗(ファイル消滅等)→ reject を伝播する', async () => {
		const err = 'watch failed: no such file';
		invokeMock.mockRejectedValue(err);

		await expect(openForDisplay(IMG)).rejects.toBe(err);
	});
});

// ---------------------------------------------------------------------------
// restoreSnapshot — ラスタの docUri も復元経路に含める(要件#22 ③)
// ---------------------------------------------------------------------------

describe('restoreSnapshot — ラスタ docUri の reload 復元(要件#22 ③)', () => {
	const snapWithImage = { rootUri: ROOT, docUri: IMG, expandedDirs: [] };
	const rootPayload = { root_uri: ROOT, entries: [], document_retained: false };
	const imagePayload = { uri: IMG, content: '', modified: null };

	test('ラスタ docUri は set_root → open_binary_document の順で呼び、document に解決値を返す', async () => {
		invokeMock.mockImplementation(async (cmd) => {
			if (cmd === 'set_root') return rootPayload;
			if (cmd === 'open_binary_document') return imagePayload;
			throw new Error(`unexpected command: ${cmd}`);
		});

		const res = await restoreSnapshot(snapWithImage);

		expect(invokedCommands()).toEqual(['set_root', 'open_binary_document']);
		expect(invokeMock.mock.calls[1]?.[1]).toEqual({ uri: IMG });
		expect(res).toEqual({ ok: true, root: rootPayload, document: imagePayload });
	});

	test('ラスタ docUri で open_document は呼ばない(InvalidUtf8 で必ず失敗する経路を通さない)', async () => {
		invokeMock.mockResolvedValue(rootPayload);

		await restoreSnapshot(snapWithImage);

		expect(invokedCommands()).not.toContain('open_document');
	});

	test('ラスタの復元失敗(画像消滅)→ root は復元したまま document:null(部分フォールバック)', async () => {
		invokeMock.mockImplementation(async (cmd) => {
			if (cmd === 'set_root') return rootPayload;
			throw new Error('no such file');
		});

		const res = await restoreSnapshot(snapWithImage);

		expect(res).toEqual({ ok: true, root: rootPayload, document: null });
	});
});
