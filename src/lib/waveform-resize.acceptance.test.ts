/**
 * 要件#42 の受け入れテスト(requirements.md #42)
 * 「音声波形帯(要件#41)の高さを既定 1.5 倍にし、帯の上端境界を
 *  マウスドラッグで拡大・縮小できるようにする」
 *
 * 契約(2026-09-02 由谷決定。implementer はこれに従う):
 * - 既定高 = 84px(現行 56px の 1.5 倍)
 * - 可動範囲 = 最小 40px 〜 最大 window.innerHeight × 0.4 で clamp
 * - 上下限逆転時(windowHeight × 0.4 < 40)は最小 40 が優先
 *   (要件#9 clampPaneWidth と同じ解決規則 = CSS の min > max 時は min が勝つ)
 * - 変更した高さは localStorage キー 'vellis.waveform-height' に保存し、
 *   再起動・新規ウインドウにも適用
 * - 解釈不能な保存値は既定 84 へフォールバック・範囲外の有限数は clamp で吸収
 * - save は非有限値(NaN / Infinity)を書かない・storage 例外は黙殺
 *
 * 判定範囲(本ファイル): 機械判定できる純ロジック。
 * 実装先 `src/lib/waveform-resize.ts`(新規)。
 *
 * ## 確定契約(公開 API)
 *
 * 1. `MIN_WAVEFORM_HEIGHT = 40` / `DEFAULT_WAVEFORM_HEIGHT = 84`(exported const)
 * 2. `WAVEFORM_HEIGHT_STORAGE_KEY = 'vellis.waveform-height'`(exported const)
 *    - 新規ウインドウ・再起動・将来バージョン間で同じ値を読むため固定する
 *      (pane-resize の 'vellis.explorer-width' と同じ命名系)
 * 3. `clampWaveformHeight(height: number, windowHeight: number): number`
 *    - [40, windowHeight * 0.4] へ clamp(境界値は含む)
 *    - windowHeight * 0.4 < 40(= windowHeight < 100)のときは**最小 40 が優先**され、
 *      結果は常に 40
 *    - 呼び出し側は有限数を渡す前提(非有限の吸収は loadWaveformHeight の責務 —
 *      pane-resize と同じ切り分け)
 * 4. `saveWaveformHeight(height: number): void`
 *    - WAVEFORM_HEIGHT_STORAGE_KEY へ数値文字列として保存する
 *      (`Number(localStorage.getItem(key))` で元の高さが復元できること)
 *    - 非有限値(NaN / Infinity)は書かない(直前の正常な保存値を壊さない)
 *    - storage 例外(setItem throw)は黙殺し、呼び出し元に伝播させない
 * 5. `loadWaveformHeight(windowHeight: number): number`
 *    - 保存値を読み、clamp して返す(ウインドウが小さくなっていた場合も範囲内)
 *    - 欠損(未保存)・非数値・非有限は DEFAULT_WAVEFORM_HEIGHT(84)へフォールバックし、
 *      その値も clamp を通す
 *    - 有限数値は範囲外でも既定に落とさず clamp で吸収する('-100'→40・'9999'→上限)
 *    - storage 例外(getItem throw)は黙殺し、既定 84(clamp 済)を返す
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - 帯の上端境界へのドラッグハンドル設置とポインタイベント配線
 * - ドラッグ中の clampWaveformHeight 適用と波形帯への高さ反映・effect の依存追従
 *   (windowHeight の供給 = window.innerHeight 等)
 * - 起動時(onMount)に loadWaveformHeight を適用すること・
 *   保存タイミング = pointerup のみ(ドラッグ中は保存しない)
 * - 既定高へ戻す専用リセット UI を設けないこと
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
	DEFAULT_WAVEFORM_HEIGHT,
	MIN_WAVEFORM_HEIGHT,
	WAVEFORM_HEIGHT_STORAGE_KEY,
	clampWaveformHeight,
	dragWaveformHeight,
	loadWaveformHeight,
	saveWaveformHeight,
} from './waveform-resize';

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 定数 — 既定 84(現行 56 の 1.5 倍)・最小 40 と保存キー
// ---------------------------------------------------------------------------

describe('定数 — 既定 84(現行 56 の 1.5 倍)・最小 40 と保存キー', () => {
	test('最小=40・既定=84(現行 56px の 1.5 倍)', () => {
		expect(MIN_WAVEFORM_HEIGHT).toBe(40);
		expect(DEFAULT_WAVEFORM_HEIGHT).toBe(84);
	});

	test("保存キーは 'vellis.waveform-height' に固定(新規ウインドウ・再起動間の互換)", () => {
		expect(WAVEFORM_HEIGHT_STORAGE_KEY).toBe('vellis.waveform-height');
	});
});

// ---------------------------------------------------------------------------
// clampWaveformHeight — 高さの clamp 計算(最小 40〜ウインドウ高の 40%)
// ---------------------------------------------------------------------------

describe('clampWaveformHeight — 最小 40〜ウインドウ高 40% の clamp', () => {
	test('範囲内はそのまま返す(境界値=下限 40・上限 40% ちょうどを含む)', () => {
		expect(clampWaveformHeight(100, 800)).toBe(100);
		expect(clampWaveformHeight(84, 800)).toBe(84); // 既定値は通常ウインドウで範囲内
		expect(clampWaveformHeight(40, 800)).toBe(40); // 下限ちょうど
		expect(clampWaveformHeight(320, 800)).toBe(320); // 上限ちょうど(800 の 40%)
	});

	test('40 未満は下限 40 へ切り上げる', () => {
		expect(clampWaveformHeight(39, 800)).toBe(40);
		expect(clampWaveformHeight(10, 800)).toBe(40);
		expect(clampWaveformHeight(0, 800)).toBe(40);
		expect(clampWaveformHeight(-50, 800)).toBe(40);
	});

	test('ウインドウ高の 40% を超えると 40% へ切り下げる', () => {
		expect(clampWaveformHeight(321, 800)).toBe(320);
		expect(clampWaveformHeight(400, 800)).toBe(320);
		expect(clampWaveformHeight(9999, 800)).toBe(320);
		expect(clampWaveformHeight(84, 150)).toBe(60); // 既定値でも上限 40% に従う
	});

	test('小さいウインドウ(40% < 40px)では最小 40 が優先される', () => {
		// windowHeight=100 は 40%=40 で上下限が一致する境界
		expect(clampWaveformHeight(80, 100)).toBe(40);
		expect(clampWaveformHeight(20, 100)).toBe(40);
		// windowHeight<100 は 40%<40 — 最小優先で常に 40
		expect(clampWaveformHeight(84, 60)).toBe(40);
		expect(clampWaveformHeight(30, 60)).toBe(40);
		expect(clampWaveformHeight(84, 0)).toBe(40);
	});
});

// ---------------------------------------------------------------------------
// loadWaveformHeight — 読込・既定へのフォールバック・clamp 適用
// ---------------------------------------------------------------------------

describe('loadWaveformHeight — 保存値の読込と既定へのフォールバック', () => {
	test('未保存(初回起動)は既定 84 を返す', () => {
		expect(loadWaveformHeight(800)).toBe(DEFAULT_WAVEFORM_HEIGHT);
	});

	test('未保存かつ小さいウインドウでは既定にも clamp が掛かる(84→40% 上限)', () => {
		expect(loadWaveformHeight(150)).toBe(60); // 40% of 150
		expect(loadWaveformHeight(60)).toBe(40); // 40%<40 → 最小優先
	});

	test('解釈不能な保存値(非数値・非有限)は既定 84 へフォールバックする', () => {
		const cases = ['garbage', '', 'NaN', 'Infinity', '-Infinity', '{"height":100}'];
		const results = Object.fromEntries(
			cases.map((raw) => {
				localStorage.setItem(WAVEFORM_HEIGHT_STORAGE_KEY, raw);
				return [raw === '' ? '(空文字)' : raw, loadWaveformHeight(800)];
			}),
		);
		expect(results).toEqual(
			Object.fromEntries(
				cases.map((raw) => [raw === '' ? '(空文字)' : raw, DEFAULT_WAVEFORM_HEIGHT]),
			),
		);
	});

	test('有限数値の範囲外は既定に落とさず clamp で吸収する', () => {
		localStorage.setItem(WAVEFORM_HEIGHT_STORAGE_KEY, '-100');
		expect(loadWaveformHeight(800)).toBe(40);
		localStorage.setItem(WAVEFORM_HEIGHT_STORAGE_KEY, '0');
		expect(loadWaveformHeight(800)).toBe(40);
		localStorage.setItem(WAVEFORM_HEIGHT_STORAGE_KEY, '9999');
		expect(loadWaveformHeight(800)).toBe(320);
	});

	test('保存後にウインドウが小さくなっていたら現ウインドウ基準で clamp する', () => {
		localStorage.setItem(WAVEFORM_HEIGHT_STORAGE_KEY, '300');
		expect(loadWaveformHeight(1000)).toBe(300); // 40% of 1000 = 400 の範囲内
		expect(loadWaveformHeight(500)).toBe(200); // 40% of 500
		expect(loadWaveformHeight(60)).toBe(40); // 40%<40 → 最小優先
	});

	test('storage 例外(getItem throw)は黙殺して既定 84 を返す', () => {
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('storage unavailable');
		});
		expect(() => loadWaveformHeight(800)).not.toThrow();
		expect(loadWaveformHeight(800)).toBe(DEFAULT_WAVEFORM_HEIGHT);
	});
});

// ---------------------------------------------------------------------------
// saveWaveformHeight — localStorage への保存と往復(再起動・新規ウインドウへの適用)
// ---------------------------------------------------------------------------

describe('saveWaveformHeight — localStorage への保存と往復', () => {
	test('固定キーへ数値文字列として保存される(別ウインドウが読める表現)', () => {
		saveWaveformHeight(120);
		const raw = localStorage.getItem(WAVEFORM_HEIGHT_STORAGE_KEY);
		expect(raw).not.toBeNull();
		expect(Number(raw)).toBe(120);
	});

	test('save→load の往復で同じ高さが返る', () => {
		saveWaveformHeight(120);
		expect(loadWaveformHeight(800)).toBe(120);
	});

	test('上書き保存は最後の値が勝つ', () => {
		saveWaveformHeight(120);
		saveWaveformHeight(96);
		expect(loadWaveformHeight(800)).toBe(96);
	});

	test('モジュール再読込(=再起動・新規ウインドウ相当)後も保存値が適用される', async () => {
		saveWaveformHeight(120);
		vi.resetModules();
		const fresh = await import('./waveform-resize');
		expect(fresh.loadWaveformHeight(800)).toBe(120);
	});

	test('非有限値(NaN / Infinity)は書かない — 直前の正常値を壊さない', () => {
		saveWaveformHeight(120);
		saveWaveformHeight(Number.NaN);
		saveWaveformHeight(Number.POSITIVE_INFINITY);
		saveWaveformHeight(Number.NEGATIVE_INFINITY);
		expect(localStorage.getItem(WAVEFORM_HEIGHT_STORAGE_KEY)).toBe('120');
		expect(loadWaveformHeight(800)).toBe(120);
	});

	test('未保存状態で NaN の保存を試みても次回読込は既定 84(不正値を持ち込まない)', () => {
		saveWaveformHeight(Number.NaN);
		expect(localStorage.getItem(WAVEFORM_HEIGHT_STORAGE_KEY)).toBeNull();
		expect(loadWaveformHeight(800)).toBe(DEFAULT_WAVEFORM_HEIGHT);
	});

	test('storage 例外(setItem throw)は黙殺して呼び出し元へ伝播させない', () => {
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('quota exceeded');
		});
		expect(() => saveWaveformHeight(120)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// 要件#43 契約④ — dragWaveformHeight(開始時キャプチャ+自由余白の折れ線補正)
// ---------------------------------------------------------------------------
//
// 「動画ビューアで映像+操作部をひと塊として上下中央に置く」(requirements.md #43)
// に伴う要件#42 ドラッグ計算の整合(契約④・2026-09-02 由谷決定):
//
// - ドラッグ基準は「開始時キャプチャ」— ドラッグ開始時の高さ startHeight と
//   塊の上下自由余白の合計 freeSpace を捕まえ、以後は移動量 d だけから計算する
//   (逐次の相対計算をしない = clamp で切られてもポインタが戻れば対応が自己回復)
// - d = 上向き移動量(px。下向きは負)・t = freeSpace / 2 として
//   Δh = d ≤ t ? 2d : freeSpace + (d − t)
//   折れ線の根拠: 中央寄せでは帯が Δh 伸びると塊の下端が Δh/2 下がるため、
//   自由余白が残る間はハンドル移動 = Δh/2 — 指に 1:1 で追従させるには Δh = 2d。
//   余白が尽きた後(d > t)は塊の下端が動かずハンドル移動 = Δh — 1:1 は Δh 増分 = d 増分。
// - 結果は clampWaveformHeight を通す(範囲 = 40〜windowHeight × 0.4・最小優先)
//
// ## 確定契約(公開 API・要件#43 で追加)
//
// 6. `dragWaveformHeight(startHeight: number, d: number, freeSpace: number, windowHeight: number): number`
//    - startHeight = ドラッグ開始時の帯の高さ(px)
//    - d = 開始位置からの上向き移動量(px。下向きドラッグは負値)
//    - freeSpace = ドラッグ開始時の塊の上下自由余白の合計(px)
//    - 戻り値 = clampWaveformHeight(startHeight + Δh, windowHeight)
//    - 純関数(状態を持たない)。同じ開始キャプチャに対し d だけを変えて何度
//      呼んでも、各 d について直接その d で呼んだ場合と同じ値を返す
//    - 呼び出し側は有限数・freeSpace >= 0 を渡す前提(clampWaveformHeight と同じ
//      切り分け = レイアウト実測の吸収は呼び出し側の責務)
//
// ## reviewer 照合に委ねる配線(本テストの判定対象外)
// - VideoViewer.svelte でのドラッグ開始時キャプチャ(startHeight・freeSpace の実測)と
//   pointermove ごとの d 算出(startY − clientY)
// - 契約①②③⑥(CSS 中央寄せ・縮退・横幅・プレースホルダ)

describe('dragWaveformHeight — 開始時キャプチャ+自由余白の折れ線補正(要件#43 契約④)', () => {
	// 基本形: windowHeight=800(上限 320)・startHeight=84・freeSpace=100(t=50)
	const START = 84;
	const FREE = 100;
	const WIN = 800;

	test('移動量 0 なら開始時の高さのまま(clamp 済)', () => {
		expect(dragWaveformHeight(START, 0, FREE, WIN)).toBe(84);
	});

	test('自由余白が残る間(d ≤ t)は Δh = 2d — 中央寄せ下でハンドルが指に 1:1 追従', () => {
		expect(dragWaveformHeight(START, 10, FREE, WIN)).toBe(84 + 20);
		expect(dragWaveformHeight(START, 49, FREE, WIN)).toBe(84 + 98);
	});

	test('折れ点 d = t ちょうどで Δh = freeSpace(両枝が連続する)', () => {
		// d=t=50: 2d = 100 = freeSpace + (d−t) = 100 + 0 — 折れ線に段差がない
		expect(dragWaveformHeight(START, 50, FREE, WIN)).toBe(84 + 100);
	});

	test('自由余白が尽きた後(d > t)は Δh = freeSpace + (d − t)', () => {
		expect(dragWaveformHeight(START, 51, FREE, WIN)).toBe(84 + 100 + 1);
		expect(dragWaveformHeight(START, 100, FREE, WIN)).toBe(84 + 100 + 50);
	});

	test('下向きドラッグ(d < 0)は Δh = 2d — 縮小方向は常に余白が開くので 2 倍則', () => {
		expect(dragWaveformHeight(START, -10, FREE, WIN)).toBe(84 - 20);
		expect(dragWaveformHeight(START, -22, FREE, WIN)).toBe(84 - 44);
	});

	test('freeSpace = 0(塊が pane を満たす)では拡大は 1:1(Δh = d)・縮小は 2 倍則', () => {
		// t=0: d>0 は即座に余白なし枝 Δh = 0 + (d − 0) = d
		expect(dragWaveformHeight(START, 30, 0, WIN)).toBe(84 + 30);
		// d<0 ≤ t=0 は縮小で余白が開く側 — Δh = 2d
		expect(dragWaveformHeight(START, -15, 0, WIN)).toBe(84 - 30);
	});

	test('端数の移動量でも折れ線どおり(t 自体が端数になる freeSpace 奇数)', () => {
		// freeSpace=25 → t=12.5
		expect(dragWaveformHeight(START, 12.5, 25, WIN)).toBe(84 + 25);
		expect(dragWaveformHeight(START, 12, 25, WIN)).toBe(84 + 24);
		expect(dragWaveformHeight(START, 13, 25, WIN)).toBe(84 + 25.5);
	});

	test('結果は clampWaveformHeight を通す — 上限 windowHeight × 0.4 で切られる', () => {
		// raw = 84 + 100 + (300 − 50) = 434 > 320(800 の 40%)
		expect(dragWaveformHeight(START, 300, FREE, WIN)).toBe(320);
	});

	test('結果は clampWaveformHeight を通す — 下限 40 で切られる', () => {
		// raw = 84 − 60 = 24 < 40
		expect(dragWaveformHeight(START, -30, FREE, WIN)).toBe(40);
	});

	test('小さいウインドウ(40% < 40px)では最小 40 が優先される(clamp の規則を継承)', () => {
		expect(dragWaveformHeight(START, 20, FREE, 60)).toBe(40);
	});

	test('clamp 後にポインタが戻れば対応が自己回復する(開始時キャプチャ基準の純関数)', () => {
		// 上限 320 を大きく超えるまでドラッグ(d=300 → clamp 320)した後、
		// ポインタを d=118 まで戻すと、最初から d=118 へ動かした場合と同じ値に戻る
		// — 逐次相対計算のようなヒステリシスを持たない
		const overshoot = dragWaveformHeight(START, 300, FREE, WIN);
		expect(overshoot).toBe(320);
		const recovered = dragWaveformHeight(START, 118, FREE, WIN);
		expect(recovered).toBe(84 + 100 + 68); // = 252(折れ線の素の値)
		expect(recovered).toBe(dragWaveformHeight(START, 118, FREE, WIN));
	});

	test('clamp 境界を跨ぐ復帰でも 1:1 — 境界の内側 1px で素の折れ線値に戻る', () => {
		// raw が上限 320 に達する d: 84 + 100 + (d − 50) = 320 → d = 186
		expect(dragWaveformHeight(START, 186, FREE, WIN)).toBe(320);
		expect(dragWaveformHeight(START, 187, FREE, WIN)).toBe(320); // 超過は clamp
		expect(dragWaveformHeight(START, 185, FREE, WIN)).toBe(319); // 戻れば 1px 単位で追従
	});

	test('状態を持たない — 引数が同じなら呼び出し順・回数によらず同じ値', () => {
		const sequence = [0, 40, 300, -30, 50, 300, 118];
		const first = sequence.map((d) => dragWaveformHeight(START, d, FREE, WIN));
		const second = sequence.map((d) => dragWaveformHeight(START, d, FREE, WIN));
		expect(second).toEqual(first);
	});
});
