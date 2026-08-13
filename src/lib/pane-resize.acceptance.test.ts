/**
 * 要件#9 の受け入れテスト(requirements.md #9)
 * 「左ペイン(ファイルツリー)の幅をドラッグで変更できる」
 *
 * 契約(2026-08-08 由谷決定。implementer はこれに従う):
 * - 範囲 = 最小200px(現行 Explorer.svelte の min-width 踏襲)〜ウインドウ幅の50%で clamp
 *   (上限50%は要件側判断)
 * - 既定 = 250px(現行 Explorer.svelte の width 踏襲)
 * - 変更した幅は localStorage に保存し、再起動・新規ウインドウにも適用
 * - 既定幅へ戻す専用手段は含めない(UI に設けないこと自体は reviewer 照合)
 *
 * 判定範囲(本ファイル): 機械判定できる純ロジック。実装先 `src/lib/pane-resize.ts`(新規)。
 *
 * ## 確定契約(公開 API)
 *
 * 1. `MIN_PANE_WIDTH = 200` / `DEFAULT_PANE_WIDTH = 250`(exported const・現行CSS踏襲)
 * 2. `PANE_WIDTH_STORAGE_KEY = 'vellis.explorer-width'`(exported const)
 *    - キー名の固定は本テストの設計判断(既存の localStorage 利用なし=先例なし)。
 *      新規ウインドウ・再起動・将来バージョン間で同じ値を読むため固定する
 * 3. `clampPaneWidth(width: number, windowWidth: number): number`
 *    - [200, windowWidth * 0.5] へ clamp(境界値は含む)
 *    - windowWidth * 0.5 < 200(= windowWidth < 400)のときは**最小200が優先**され、
 *      結果は常に200(CSS の min-width > max-width 時は min-width が勝つ解決規則に合わせた
 *      本テストの設計判断。最小値の趣旨=Explorer の可用性の下限を守る)
 * 4. `savePaneWidth(width: number): void`
 *    - localStorage の PANE_WIDTH_STORAGE_KEY へ保存する。保存表現は数値文字列
 *      (`Number(localStorage.getItem(key))` で元の幅が復元できること。
 *       別ウインドウ・別バージョンの読込互換のため表現も契約に含める=本テストの設計判断)
 * 5. `loadPaneWidth(windowWidth: number): number`
 *    - 保存値を読み、clamp して返す(ウインドウが小さくなっていた場合も範囲内に収まる)
 *    - 欠損(未保存)・非数値・非有限(NaN / Infinity 等)は DEFAULT_PANE_WIDTH(250)へ
 *      フォールバックし、その値も clamp を通す
 *    - 有限数値は範囲外でも既定に落とさず clamp で吸収する('-100'→200・'9999'→上限。
 *      不正=解釈不能のみ既定、解釈可能な数値は clamp という切り分け=本テストの設計判断)
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - 仕切りハンドル(Explorer と Viewer の間)の設置とドラッグイベント配線
 * - ドラッグ中の clampPaneWidth 適用と Explorer への幅反映(現行 CSS の固定 width 250px
 *   との整合)・windowWidth の供給(window.innerWidth 等)
 * - 起動時(onMount)に loadPaneWidth を適用すること・変更確定時に savePaneWidth を
 *   呼ぶこと
 * - 既定幅へ戻す専用手段(ダブルクリックリセット等)を設けないこと
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
	DEFAULT_PANE_WIDTH,
	MIN_PANE_WIDTH,
	PANE_WIDTH_STORAGE_KEY,
	clampPaneWidth,
	loadPaneWidth,
	savePaneWidth,
} from './pane-resize';

beforeEach(() => {
	localStorage.clear();
});

// ---------------------------------------------------------------------------
// 定数 — 現行踏襲の値と保存キー
// ---------------------------------------------------------------------------

describe('定数 — 現行CSS踏襲の既定・最小と保存キー', () => {
	test('最小=200(現行 min-width 踏襲)・既定=250(現行 width 踏襲)', () => {
		expect(MIN_PANE_WIDTH).toBe(200);
		expect(DEFAULT_PANE_WIDTH).toBe(250);
	});

	test("保存キーは 'vellis.explorer-width' に固定(新規ウインドウ・再起動間の互換)", () => {
		expect(PANE_WIDTH_STORAGE_KEY).toBe('vellis.explorer-width');
	});
});

// ---------------------------------------------------------------------------
// clampPaneWidth — 幅の clamp 計算(最小200〜ウインドウ幅の50%)
// ---------------------------------------------------------------------------

describe('clampPaneWidth — 最小200〜ウインドウ幅50%の clamp', () => {
	test('範囲内はそのまま返す(境界値=下限200・上限50%ちょうどを含む)', () => {
		expect(clampPaneWidth(300, 1200)).toBe(300);
		expect(clampPaneWidth(200, 1200)).toBe(200); // 下限ちょうど
		expect(clampPaneWidth(600, 1200)).toBe(600); // 上限ちょうど(1200 の 50%)
	});

	test('200未満は下限200へ切り上げる', () => {
		expect(clampPaneWidth(199, 1200)).toBe(200);
		expect(clampPaneWidth(150, 1200)).toBe(200);
		expect(clampPaneWidth(0, 1200)).toBe(200);
		expect(clampPaneWidth(-50, 1200)).toBe(200);
	});

	test('ウインドウ幅の50%を超えると50%へ切り下げる', () => {
		expect(clampPaneWidth(601, 1200)).toBe(600);
		expect(clampPaneWidth(700, 1200)).toBe(600);
		expect(clampPaneWidth(9999, 1200)).toBe(600);
		expect(clampPaneWidth(250, 480)).toBe(240); // 既定値でも上限50%に従う
	});

	test('小さいウインドウ(50% < 200px)では最小200が優先される', () => {
		// windowWidth=400 は 50%=200 で上下限が一致する境界
		expect(clampPaneWidth(300, 400)).toBe(200);
		expect(clampPaneWidth(100, 400)).toBe(200);
		// windowWidth<400 は 50%<200 — 最小優先で常に200
		expect(clampPaneWidth(250, 300)).toBe(200);
		expect(clampPaneWidth(120, 300)).toBe(200);
		expect(clampPaneWidth(250, 0)).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// loadPaneWidth — 読込・既定へのフォールバック・clamp 適用
// ---------------------------------------------------------------------------

describe('loadPaneWidth — 保存値の読込と既定へのフォールバック', () => {
	test('未保存(初回起動)は既定250を返す', () => {
		expect(loadPaneWidth(1200)).toBe(DEFAULT_PANE_WIDTH);
	});

	test('未保存かつ小さいウインドウでは既定にも clamp が掛かる(250→200)', () => {
		expect(loadPaneWidth(360)).toBe(200);
	});

	test('解釈不能な保存値(非数値・非有限)は既定250へフォールバックする', () => {
		const cases = ['garbage', '', 'NaN', 'Infinity', '-Infinity', '{"width":300}'];
		const results = Object.fromEntries(
			cases.map((raw) => {
				localStorage.setItem(PANE_WIDTH_STORAGE_KEY, raw);
				return [raw === '' ? '(空文字)' : raw, loadPaneWidth(1200)];
			}),
		);
		expect(results).toEqual(
			Object.fromEntries(
				cases.map((raw) => [raw === '' ? '(空文字)' : raw, DEFAULT_PANE_WIDTH]),
			),
		);
	});

	test('有限数値の範囲外は既定に落とさず clamp で吸収する', () => {
		localStorage.setItem(PANE_WIDTH_STORAGE_KEY, '-100');
		expect(loadPaneWidth(1200)).toBe(200);
		localStorage.setItem(PANE_WIDTH_STORAGE_KEY, '0');
		expect(loadPaneWidth(1200)).toBe(200);
		localStorage.setItem(PANE_WIDTH_STORAGE_KEY, '9999');
		expect(loadPaneWidth(1200)).toBe(600);
	});

	test('保存後にウインドウが小さくなっていたら現ウインドウ基準で clamp する', () => {
		localStorage.setItem(PANE_WIDTH_STORAGE_KEY, '600');
		expect(loadPaneWidth(1000)).toBe(500); // 50% of 1000
		expect(loadPaneWidth(360)).toBe(200); // 50%<200 → 最小優先
	});
});

// ---------------------------------------------------------------------------
// savePaneWidth — localStorage への保存と往復(再起動・新規ウインドウへの適用)
// ---------------------------------------------------------------------------

describe('savePaneWidth — localStorage への保存と往復', () => {
	test('固定キーへ数値文字列として保存される(別ウインドウが読める表現)', () => {
		savePaneWidth(320);
		const raw = localStorage.getItem(PANE_WIDTH_STORAGE_KEY);
		expect(raw).not.toBeNull();
		expect(Number(raw)).toBe(320);
	});

	test('save→load の往復で同じ幅が返る', () => {
		savePaneWidth(320);
		expect(loadPaneWidth(1200)).toBe(320);
	});

	test('上書き保存は最後の値が勝つ', () => {
		savePaneWidth(320);
		savePaneWidth(280);
		expect(loadPaneWidth(1200)).toBe(280);
	});

	test('モジュール再読込(=再起動・新規ウインドウ相当)後も保存値が適用される', async () => {
		savePaneWidth(320);
		vi.resetModules();
		const fresh = await import('./pane-resize');
		expect(fresh.loadPaneWidth(1200)).toBe(320);
	});

	test('NaN の保存を試みても次回読込は既定250(不正値を持ち込まない)', () => {
		savePaneWidth(Number.NaN);
		expect(loadPaneWidth(1200)).toBe(DEFAULT_PANE_WIDTH);
	});
});
