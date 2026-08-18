/**
 * 要件#22 の受け入れテスト(requirements.md #22)— `<img>` キャッシュ破り
 * 「①ディスク上で変更されたら表示へ自動反映」の表示側。
 *
 * 背景: ラスタ画像の表示は `<img src="vellis-asset:…">` の1経路(要件#16)。
 * 変更イベント(binary_file_changed。契約は src-tauri/tests/acceptance_req22.rs)を
 * 受けても src が同じ文字列のままでは WebView のキャッシュに当たって再取得されない。
 * そこで src に**版数クエリ**を付けてキャッシュキーを変え、再取得させる。
 *
 * 契約(2026-08-18 由谷決定・設計方針は requirements.md #22 の周回設計判断):
 * - 変更イベント受信のたびに版数を進め、`<img>` の src を版数付き URI に差し替える
 *
 * 判定範囲(本ファイル): 版数→src の純関数。実装先 `src/lib/image-watch.ts`(新規)。
 * イベント受信で版数を進める配線(+page.svelte / ImageViewer.svelte)は reviewer 照合。
 *
 * ## 確定契約(公開 API・implementer はこれに従う)
 *
 * `imageSrcWithVersion(src: string, version: number): string`
 * - version 0(初期表示)→ src をそのまま返す(要件#16 の初期表示挙動を変えない)
 * - version 1 以上 → src に**クエリ(?)** で版数を付けた URI を返す。
 *   フラグメント(#)は不可 — フラグメントはリクエスト URL に含まれず
 *   キャッシュキーが変わらないため
 * - 版数が異なれば src も異なる(連続変更で毎回再取得される)
 * - 同じ入力には同じ出力(決定的。再レンダーで src が揺れて無駄な再取得をしない)
 *
 * (クエリのパラメータ名・値の形式は実装裁量。本テストは上記の性質のみ判定する)
 */
import { describe, expect, test } from 'vitest';

import { imageSrcWithVersion } from './image-watch';

// toAssetUri(src/lib/uri.ts)が返す形の実例
const SRC = 'vellis-asset://local/Users/a/pics/photo.png';

describe('imageSrcWithVersion — 版数クエリでキャッシュを破る(要件#22 ①)', () => {
	test('版数0(初期表示)は素の URI のまま', () => {
		expect(imageSrcWithVersion(SRC, 0)).toBe(SRC);
	});

	test('版数1以上はクエリ(?)を付けて元 URI から変える(フラグメントではない)', () => {
		const bumped = imageSrcWithVersion(SRC, 1);
		expect(bumped).not.toBe(SRC);
		expect(
			bumped.startsWith(`${SRC}?`),
			'元 URI + "?" で始まること(# はリクエスト URL に含まれずキャッシュを破れない)',
		).toBe(true);
	});

	test('版数が異なれば src も異なる(連続変更で毎回再取得される)', () => {
		const versions = [1, 2, 3, 4, 5].map((v) => imageSrcWithVersion(SRC, v));
		expect(new Set(versions).size).toBe(versions.length);
		for (const src of versions) expect(src).not.toBe(SRC);
	});

	test('同じ版数は同じ src(決定的。再レンダーで揺れない)', () => {
		expect(imageSrcWithVersion(SRC, 3)).toBe(imageSrcWithVersion(SRC, 3));
	});

	test('ssh リモートの asset URI でも同じ規則(要件#16 ⑥ の経路を壊さない)', () => {
		const remote = 'vellis-asset://ssh/user@host/pics/photo.png';
		expect(imageSrcWithVersion(remote, 0)).toBe(remote);
		expect(imageSrcWithVersion(remote, 2).startsWith(`${remote}?`)).toBe(true);
	});
});
