/**
 * 要件#64 の受け入れテスト(docs/requirements/req-64.md)— 区画の開閉と高さの純関数と保存
 * (AC-64-13・契約6)
 *
 * 「Explorer の下端の折りたためる区画(VS Code 型)。見出し行のクリックで開閉・見出し行の上下
 *  ドラッグで高さを変える(3px 以上動いたらドラッグ)・最小=見出し行+一覧 2 行・最大=ツリーが
 *  100px 残るまで。開閉と高さはアプリ全体で 1 つ localStorage に覚える(初回は開いた状態)」
 *
 * 判定範囲(本ファイル): `src/lib/recent-files-section.ts`(新規)の純関数と localStorage の
 * 読み書き。`pane-resize.ts`・`waveform-resize.ts` と同じ作り(読み込みは呼ばれるたびに
 * localStorage を読む・解釈不能は既定・storage 例外は黙殺)。区画の DOM 側の配線は
 * src/components/RecentFiles.wiring.test.ts。
 *
 * ## 確定契約(公開 API・implementer はこれに従う=test-writer 決定 2026-09-28)
 *
 * ```ts
 * // --- 新規 src/lib/recent-files-section.ts(Tauri を import しない)---
 * export const SECTION_EXPANDED_STORAGE_KEY = 'vellis.recent-files-expanded'; // 開閉('true' / 'false')
 * export const SECTION_HEIGHT_STORAGE_KEY = 'vellis.recent-files-height';     // 高さ(数値文字列)
 * export const MIN_TREE_HEIGHT = 100;         // ツリーに最低残す高さ(px)
 * export const SECTION_DRAG_THRESHOLD = 3;    // これ以上(>=)上下に動いたらドラッグ(px)
 * export const MIN_SECTION_HEIGHT: number;    // 見出し行+一覧 2 行分(正の数・値は実装裁量)
 * export const DEFAULT_SECTION_HEIGHT: number; // 一覧がおよそ 10 行収まる高さ(>= MIN_SECTION_HEIGHT・実装裁量)
 *
 * // [MIN_SECTION_HEIGHT, paneHeight - MIN_TREE_HEIGHT] に収める。上限が下限を下回るときは MIN_SECTION_HEIGHT。
 * export function clampSectionHeight(height: number, paneHeight: number): number;
 * // ドラッグ中の高さ(純関数): clampSectionHeight(startHeight + (startY - currentY), paneHeight)。
 * // 上へ動かす(currentY < startY)と高く・下へ動かすと低く。
 * export function dragSectionHeight(startHeight: number, startY: number, currentY: number, paneHeight: number): number;
 * // 上下の移動が SECTION_DRAG_THRESHOLD 以上なら true(どちら向きでも)。
 * export function isSectionDrag(startY: number, currentY: number): boolean;
 * // 未保存・壊れた値・localStorage が使えない → true(初回は開いた状態)。
 * export function loadSectionExpanded(): boolean;
 * export function saveSectionExpanded(expanded: boolean): void; // 'true' / 'false' を書く。例外は黙殺
 * // 保存値を clamp して返す。未保存・解釈不能は DEFAULT_SECTION_HEIGHT(を clamp したもの)。例外は黙殺
 * export function loadSectionHeight(paneHeight: number): number;
 * export function saveSectionHeight(height: number): void; // 数値文字列。非有限は書かない。例外は黙殺
 * ```
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { PANE_WIDTH_STORAGE_KEY } from './pane-resize';
import { WAVEFORM_HEIGHT_STORAGE_KEY } from './waveform-resize';
import { ZOOM_STORAGE_KEY } from './zoom';
import { EXPLORER_ZOOM_STORAGE_KEY } from './zoom-target';
import { RELOAD_STATE_STORAGE_KEY } from './reload-state';
import {
	DEFAULT_SECTION_HEIGHT,
	MIN_SECTION_HEIGHT,
	MIN_TREE_HEIGHT,
	SECTION_DRAG_THRESHOLD,
	SECTION_EXPANDED_STORAGE_KEY,
	SECTION_HEIGHT_STORAGE_KEY,
	clampSectionHeight,
	dragSectionHeight,
	isSectionDrag,
	loadSectionExpanded,
	loadSectionHeight,
	saveSectionExpanded,
	saveSectionHeight,
} from './recent-files-section';

/** 左ペインの高さ(px)。上限= 1000 - 100 = 900。 */
const PANE = 1000;

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 保存キー — 2 つあり、既存のキーと重ならない
// ---------------------------------------------------------------------------

describe('AC-64-13: 保存キーは開閉と高さの 2 つで、既存のキー(幅・波形・ズーム 2 つ・reload)と重ならない', () => {
	test("キーは 'vellis.recent-files-expanded' / 'vellis.recent-files-height' に固定(窓間・再起動間の互換)", () => {
		expect(SECTION_EXPANDED_STORAGE_KEY).toBe('vellis.recent-files-expanded');
		expect(SECTION_HEIGHT_STORAGE_KEY).toBe('vellis.recent-files-height');
	});

	test('2 つのキーは互いに違い、pane-resize / waveform-resize / zoom / zoom-target / reload-state のどれとも違う', () => {
		const keys = [
			SECTION_EXPANDED_STORAGE_KEY,
			SECTION_HEIGHT_STORAGE_KEY,
			PANE_WIDTH_STORAGE_KEY,
			WAVEFORM_HEIGHT_STORAGE_KEY,
			ZOOM_STORAGE_KEY,
			EXPLORER_ZOOM_STORAGE_KEY,
			RELOAD_STATE_STORAGE_KEY,
		];
		expect(new Set(keys).size).toBe(keys.length);
	});

	test('開閉と高さを保存しても、ほかの機能のキーには書かない', () => {
		saveSectionExpanded(false);
		saveSectionHeight(240);
		expect(Object.keys(localStorage).sort()).toEqual(
			[SECTION_EXPANDED_STORAGE_KEY, SECTION_HEIGHT_STORAGE_KEY].sort()
		);
		expect(Object.keys(sessionStorage)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

describe('AC-64-13: 定数 — MIN_TREE_HEIGHT=100・SECTION_DRAG_THRESHOLD=3・MIN_SECTION_HEIGHT は正の数', () => {
	test('MIN_TREE_HEIGHT === 100(ツリーに最低 100px 残す)', () => {
		expect(MIN_TREE_HEIGHT).toBe(100);
	});

	test('SECTION_DRAG_THRESHOLD === 3(判断3)', () => {
		expect(SECTION_DRAG_THRESHOLD).toBe(3);
	});

	test('MIN_SECTION_HEIGHT は正の有限数(見出し行+一覧 2 行分)・DEFAULT_SECTION_HEIGHT はそれ以上', () => {
		expect(Number.isFinite(MIN_SECTION_HEIGHT)).toBe(true);
		expect(MIN_SECTION_HEIGHT).toBeGreaterThan(0);
		expect(Number.isFinite(DEFAULT_SECTION_HEIGHT)).toBe(true);
		expect(DEFAULT_SECTION_HEIGHT).toBeGreaterThanOrEqual(MIN_SECTION_HEIGHT);
		// 既定の高さは普通の窓(左ペイン 1000px)の範囲に収まる=そのまま使われる。
		expect(clampSectionHeight(DEFAULT_SECTION_HEIGHT, PANE)).toBe(DEFAULT_SECTION_HEIGHT);
	});
});

// ---------------------------------------------------------------------------
// loadSectionExpanded / saveSectionExpanded — 初回は開いた状態(判断1)
// ---------------------------------------------------------------------------

describe('AC-64-13: loadSectionExpanded — 未保存・壊れた値・localStorage が使えないときは true', () => {
	test('何も保存されていない(初回)→ true(開いた状態)', () => {
		expect(loadSectionExpanded()).toBe(true);
	});

	test('壊れた値(空文字・garbage・null・JSON)→ true', () => {
		for (const raw of ['', 'garbage', 'null', '{"expanded":false}', 'yes']) {
			localStorage.setItem(SECTION_EXPANDED_STORAGE_KEY, raw);
			expect(loadSectionExpanded(), `raw=${JSON.stringify(raw)}`).toBe(true);
		}
	});

	test('getItem が throw する(localStorage が使えない)→ true で、例外を投げない', () => {
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('storage unavailable');
		});
		expect(() => loadSectionExpanded()).not.toThrow();
		expect(loadSectionExpanded()).toBe(true);
	});

	test('saveSectionExpanded(false) の後は false・true の後は true(往復)', () => {
		saveSectionExpanded(false);
		expect(loadSectionExpanded()).toBe(false);
		saveSectionExpanded(true);
		expect(loadSectionExpanded()).toBe(true);
		saveSectionExpanded(false);
		expect(loadSectionExpanded()).toBe(false);
	});

	test("保存表現は 'true' / 'false'(別ウインドウ・別バージョンが読める表現)", () => {
		saveSectionExpanded(false);
		expect(localStorage.getItem(SECTION_EXPANDED_STORAGE_KEY)).toBe('false');
		saveSectionExpanded(true);
		expect(localStorage.getItem(SECTION_EXPANDED_STORAGE_KEY)).toBe('true');
	});

	test('モジュール再読込(=再起動・新しい窓相当)後も保存値が読める', async () => {
		saveSectionExpanded(false);
		vi.resetModules();
		const fresh = await import('./recent-files-section');
		expect(fresh.loadSectionExpanded()).toBe(false);
	});

	test('setItem が throw しても saveSectionExpanded は例外を投げない', () => {
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('quota exceeded');
		});
		expect(() => saveSectionExpanded(false)).not.toThrow();
		expect(() => saveSectionExpanded(true)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// clampSectionHeight — [MIN_SECTION_HEIGHT, paneHeight - MIN_TREE_HEIGHT]
// ---------------------------------------------------------------------------

describe('AC-64-13: clampSectionHeight — 最小=MIN_SECTION_HEIGHT・最大=左ペインの高さ − 100', () => {
	test('範囲内はそのまま(境界値=下限・上限ちょうどを含む)', () => {
		expect(clampSectionHeight(300, PANE)).toBe(300);
		expect(clampSectionHeight(MIN_SECTION_HEIGHT, PANE)).toBe(MIN_SECTION_HEIGHT);
		expect(clampSectionHeight(PANE - MIN_TREE_HEIGHT, PANE)).toBe(PANE - MIN_TREE_HEIGHT);
	});

	test('下限未満は MIN_SECTION_HEIGHT へ切り上げる(0・負も)', () => {
		expect(clampSectionHeight(MIN_SECTION_HEIGHT - 1, PANE)).toBe(MIN_SECTION_HEIGHT);
		expect(clampSectionHeight(0, PANE)).toBe(MIN_SECTION_HEIGHT);
		expect(clampSectionHeight(-50, PANE)).toBe(MIN_SECTION_HEIGHT);
	});

	test('上限(paneHeight − MIN_TREE_HEIGHT)を超えると上限へ切り下げる', () => {
		expect(clampSectionHeight(PANE - MIN_TREE_HEIGHT + 1, PANE)).toBe(PANE - MIN_TREE_HEIGHT);
		expect(clampSectionHeight(9999, PANE)).toBe(PANE - MIN_TREE_HEIGHT);
		expect(clampSectionHeight(500, 600)).toBe(500);
		expect(clampSectionHeight(501, 600)).toBe(500);
	});

	test('上限が下限を下回るほど低い窓では MIN_SECTION_HEIGHT(最小優先=clampPaneWidth と同じ規則)', () => {
		const tooLow = MIN_SECTION_HEIGHT + MIN_TREE_HEIGHT - 1; // 上限 = MIN_SECTION_HEIGHT - 1
		expect(clampSectionHeight(MIN_SECTION_HEIGHT, tooLow)).toBe(MIN_SECTION_HEIGHT);
		expect(clampSectionHeight(10, tooLow)).toBe(MIN_SECTION_HEIGHT);
		expect(clampSectionHeight(500, tooLow)).toBe(MIN_SECTION_HEIGHT);
		expect(clampSectionHeight(300, 0)).toBe(MIN_SECTION_HEIGHT);
		expect(clampSectionHeight(300, MIN_TREE_HEIGHT)).toBe(MIN_SECTION_HEIGHT);
	});

	test('上限=下限ちょうどの窓(paneHeight = MIN_SECTION_HEIGHT + 100)では常に MIN_SECTION_HEIGHT', () => {
		const exact = MIN_SECTION_HEIGHT + MIN_TREE_HEIGHT;
		expect(clampSectionHeight(MIN_SECTION_HEIGHT, exact)).toBe(MIN_SECTION_HEIGHT);
		expect(clampSectionHeight(MIN_SECTION_HEIGHT + 50, exact)).toBe(MIN_SECTION_HEIGHT);
	});
});

// ---------------------------------------------------------------------------
// dragSectionHeight — 上へ動かすと高く・下へ動かすと低く(純関数)
// ---------------------------------------------------------------------------

describe('AC-64-13: dragSectionHeight(startHeight, startY, currentY, paneHeight) — 上=高く・下=低く・範囲内', () => {
	test('移動 0 なら開始時の高さのまま', () => {
		expect(dragSectionHeight(300, 500, 500, PANE)).toBe(300);
	});

	test('上へ 40px(currentY < startY)→ 40px 高くなる', () => {
		expect(dragSectionHeight(300, 500, 460, PANE)).toBe(340);
		expect(dragSectionHeight(300, 500, 499, PANE)).toBe(301);
	});

	test('下へ 30px(currentY > startY)→ 30px 低くなる', () => {
		expect(dragSectionHeight(300, 500, 530, PANE)).toBe(270);
		expect(dragSectionHeight(300, 500, 501, PANE)).toBe(299);
	});

	test('結果は clampSectionHeight の範囲(上限で切られる・下限で切られる・低い窓は最小)', () => {
		expect(dragSectionHeight(300, 500, -5000, PANE)).toBe(PANE - MIN_TREE_HEIGHT);
		expect(dragSectionHeight(300, 500, 5000, PANE)).toBe(MIN_SECTION_HEIGHT);
		expect(dragSectionHeight(300, 500, 460, 600)).toBe(340);
		expect(dragSectionHeight(300, 500, 100, 600)).toBe(500); // 700 → 上限 600 − 100
		expect(dragSectionHeight(300, 500, 460, 60)).toBe(MIN_SECTION_HEIGHT);
	});

	test('どの入力でも clampSectionHeight(startHeight + (startY − currentY), paneHeight) と一致する', () => {
		for (const [start, from, to, pane] of [
			[300, 500, 460, PANE],
			[300, 500, 540, PANE],
			[120, 200, 0, 700],
			[120, 200, 900, 700],
			[MIN_SECTION_HEIGHT, 10, 10, 50],
		]) {
			expect(dragSectionHeight(start, from, to, pane)).toBe(clampSectionHeight(start + (from - to), pane));
		}
	});

	test('状態を持たない — 同じ引数なら呼び出し順・回数によらず同じ値(clamp の後に戻れば自己回復)', () => {
		const sequence = [500, 460, -5000, 540, 460, 5000, 470];
		const first = sequence.map((y) => dragSectionHeight(300, 500, y, PANE));
		const second = sequence.map((y) => dragSectionHeight(300, 500, y, PANE));
		expect(second).toEqual(first);
		expect(dragSectionHeight(300, 500, 470, PANE)).toBe(330);
	});
});

// ---------------------------------------------------------------------------
// isSectionDrag — 3px 以上でドラッグ(判断3)
// ---------------------------------------------------------------------------

describe('AC-64-13: isSectionDrag(startY, currentY) — 上下の移動が 3px 以上で true・2px で false', () => {
	test('3px 以上は true(上下どちら向きでも)', () => {
		expect(isSectionDrag(100, 97)).toBe(true);
		expect(isSectionDrag(100, 103)).toBe(true);
		expect(isSectionDrag(100, 60)).toBe(true);
		expect(isSectionDrag(100, 140)).toBe(true);
	});

	test('2px 以下は false(0・1・2・上下どちら向きでも)', () => {
		expect(isSectionDrag(100, 100)).toBe(false);
		expect(isSectionDrag(100, 99)).toBe(false);
		expect(isSectionDrag(100, 101)).toBe(false);
		expect(isSectionDrag(100, 98)).toBe(false);
		expect(isSectionDrag(100, 102)).toBe(false);
	});

	test('閾値は SECTION_DRAG_THRESHOLD そのもの(ちょうどで true・1 つ手前で false)', () => {
		expect(isSectionDrag(100, 100 - SECTION_DRAG_THRESHOLD)).toBe(true);
		expect(isSectionDrag(100, 100 + SECTION_DRAG_THRESHOLD)).toBe(true);
		expect(isSectionDrag(100, 100 - (SECTION_DRAG_THRESHOLD - 1))).toBe(false);
		expect(isSectionDrag(100, 100 + (SECTION_DRAG_THRESHOLD - 1))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// loadSectionHeight / saveSectionHeight — 保存値を範囲に収める・既定・往復
// ---------------------------------------------------------------------------

describe('AC-64-13: loadSectionHeight — 保存値を範囲に収めて返す。無い・壊れた値は既定(を範囲に収めたもの)', () => {
	test('未保存(初回)は既定の高さ(通常の窓では clamp されずそのまま)', () => {
		expect(loadSectionHeight(PANE)).toBe(clampSectionHeight(DEFAULT_SECTION_HEIGHT, PANE));
		expect(loadSectionHeight(PANE)).toBe(DEFAULT_SECTION_HEIGHT);
	});

	test('未保存かつ低い窓では既定にも clamp が掛かる', () => {
		expect(loadSectionHeight(MIN_TREE_HEIGHT + 10)).toBe(MIN_SECTION_HEIGHT);
		expect(loadSectionHeight(0)).toBe(MIN_SECTION_HEIGHT);
	});

	test('解釈不能な保存値(非数値・非有限・空)は既定へフォールバックする', () => {
		for (const raw of ['garbage', '', '   ', 'NaN', 'Infinity', '-Infinity', '{"height":300}']) {
			localStorage.setItem(SECTION_HEIGHT_STORAGE_KEY, raw);
			expect(loadSectionHeight(PANE), `raw=${JSON.stringify(raw)}`).toBe(DEFAULT_SECTION_HEIGHT);
		}
	});

	test('有限数値の範囲外は既定に落とさず clamp で吸収する', () => {
		localStorage.setItem(SECTION_HEIGHT_STORAGE_KEY, '-100');
		expect(loadSectionHeight(PANE)).toBe(MIN_SECTION_HEIGHT);
		localStorage.setItem(SECTION_HEIGHT_STORAGE_KEY, '0');
		expect(loadSectionHeight(PANE)).toBe(MIN_SECTION_HEIGHT);
		localStorage.setItem(SECTION_HEIGHT_STORAGE_KEY, '9999');
		expect(loadSectionHeight(PANE)).toBe(PANE - MIN_TREE_HEIGHT);
	});

	test('保存後に窓が低くなっていたら現在の左ペインの高さ基準で clamp する(clampWaveformHeight と同じ考え方)', () => {
		localStorage.setItem(SECTION_HEIGHT_STORAGE_KEY, '450');
		expect(loadSectionHeight(PANE)).toBe(450);
		expect(loadSectionHeight(500)).toBe(400); // 500 − 100
		expect(loadSectionHeight(60)).toBe(MIN_SECTION_HEIGHT);
	});

	test('getItem が throw する → 既定の高さで、例外を投げない', () => {
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('storage unavailable');
		});
		expect(() => loadSectionHeight(PANE)).not.toThrow();
		expect(loadSectionHeight(PANE)).toBe(DEFAULT_SECTION_HEIGHT);
	});
});

describe('AC-64-13: saveSectionHeight — localStorage への保存と往復', () => {
	test('固定キーへ数値文字列として保存される(別ウインドウが Number() で読める表現)', () => {
		saveSectionHeight(240);
		const raw = localStorage.getItem(SECTION_HEIGHT_STORAGE_KEY);
		expect(raw).not.toBeNull();
		expect(Number(raw)).toBe(240);
	});

	test('save → load の往復で同じ高さが返る・上書きは最後の値が勝つ', () => {
		saveSectionHeight(240);
		expect(loadSectionHeight(PANE)).toBe(240);
		saveSectionHeight(320);
		expect(loadSectionHeight(PANE)).toBe(320);
	});

	test('モジュール再読込(=再起動・新しい窓相当)後も保存値が適用される', async () => {
		saveSectionHeight(240);
		vi.resetModules();
		const fresh = await import('./recent-files-section');
		expect(fresh.loadSectionHeight(PANE)).toBe(240);
	});

	test('非有限値(NaN / Infinity)は書かない — 直前の正常値を壊さない', () => {
		saveSectionHeight(240);
		saveSectionHeight(Number.NaN);
		saveSectionHeight(Number.POSITIVE_INFINITY);
		saveSectionHeight(Number.NEGATIVE_INFINITY);
		expect(localStorage.getItem(SECTION_HEIGHT_STORAGE_KEY)).toBe('240');
		expect(loadSectionHeight(PANE)).toBe(240);
	});

	test('未保存状態で NaN の保存を試みても次回読込は既定(不正値を持ち込まない)', () => {
		saveSectionHeight(Number.NaN);
		expect(localStorage.getItem(SECTION_HEIGHT_STORAGE_KEY)).toBeNull();
		expect(loadSectionHeight(PANE)).toBe(DEFAULT_SECTION_HEIGHT);
	});

	test('setItem が throw しても例外を投げない', () => {
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('quota exceeded');
		});
		expect(() => saveSectionHeight(240)).not.toThrow();
	});
});
