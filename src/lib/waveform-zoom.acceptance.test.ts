/**
 * 要件#47 の受け入れテスト(requirements.md #47)
 * 「音声波形帯(要件#41〜#45)を時間軸方向に拡大縮小できるようにする:
 *  拡大時は帯を窓表示にして横スクロールでき、拡大した状態でもクリックで
 *  映像ごとその位置へジャンプできる」
 *
 * ## 判定範囲(本ファイル)
 * 契約⑩の機械判定のうち純関数部分(契約②⑤⑥⑦⑧)。実装先は新設
 * `src/lib/waveform-zoom.ts`(契約⑧・waveform-resize.ts と同じ家風=状態を持たない
 * 純関数モジュール)と、`src/lib/audio-waveform.ts` の analyzeWaveform 拡張(契約⑦)。
 * 3ボタン・ホイールの配線は VideoViewer.wiring.test.ts の追加分・体感は人間ゲート。
 *
 * ## 確定契約(公開 API =implementer はこれに従う)
 *
 * ### 定数(exported const)
 * - `WAVEFORM_MIN_WINDOW_SECONDS = 0.25`(契約②。8kHz×0.25s=2000 サンプル=1バケット1サンプル)
 * - `WAVEFORM_MAX_RETAINED_SAMPLES = 67108864`(256MB 相当=256×1024×1024/4 float32。契約②⑦の初期値)
 * - `WAVEFORM_COARSE_STEP = 512`(粗レベルの刻み。契約⑦)
 * - `WAVEFORM_WHEEL_LINE_PIXELS = 16` / `WAVEFORM_WHEEL_PAGE_PIXELS = 800`
 *   (deltaMode 1/2 → pixel 相当への正規化係数。契約④)
 * - `WAVEFORM_WHEEL_ZOOM_PIXELS = 240`(このピクセル量で倍率が2倍になる指数写像の刻み。契約④)
 *
 * ### 関数(すべて waveform-zoom.ts から export・入力を書き換えない)
 * 1. `waveformMinWindowSeconds(coarseOnly: boolean, sampleRate: number): number`
 *    - false → WAVEFORM_MIN_WINDOW_SECONDS
 *    - true(粗レベルのみ保持=契約⑦の縮退)→ max(WAVEFORM_MIN_WINDOW_SECONDS,
 *      WAVEFORM_BUCKETS × WAVEFORM_COARSE_STEP / sampleRate)=「1バケット=1粗レベル要素」で止まる
 * 2. `maxWaveformZoom(durationSeconds: number, minWindowSeconds = WAVEFORM_MIN_WINDOW_SECONDS): number`
 *    - duration / minWindowSeconds。duration ≤ minWindowSeconds・非有限・0 以下 → 1
 * 3. `clampWaveformZoom(zoom: number, durationSeconds: number, minWindowSeconds?): number`
 *    - [1, maxWaveformZoom(duration, minWindowSeconds)] へ clamp。非有限 zoom → 1
 * 4. `waveformWindowSeconds(zoom: number, durationSeconds: number): number`
 *    - duration / zoom(zoom < 1・非有限は 1 扱い)。duration 非有限・0 以下 → 0
 * 5. `clampWaveformWindowStart(windowStart: number, windowSeconds: number, durationSeconds: number): number`
 *    - [0, duration − windowSeconds] へ clamp。windowSeconds ≥ duration(倍率1)→ 0。非有限 → 0
 * 6. `zoomWaveformAtAnchor(zoom, windowStart, nextZoom, anchorX, width, durationSeconds,
 *     minWindowSeconds?): { zoom: number; windowStart: number }`
 *    - 結果 zoom = clampWaveformZoom(nextZoom, …)。アンカー不変=x に対応する時刻が倍率変更の
 *      前後で同じ x に留まる(clamp が効かない範囲で厳密)。結果 zoom が 1 なら windowStart = 0
 *    - ボタン操作は nextZoom = zoom×2 / zoom÷2 / 1 をこの関数へ渡すだけ(契約④)
 * 7. `normalizeWheelDelta(delta: number, deltaMode: number): number`
 *    - mode 0 → そのまま・1 → ×WAVEFORM_WHEEL_LINE_PIXELS・2 → ×WAVEFORM_WHEEL_PAGE_PIXELS。
 *      未知 mode は pixel 扱い。非有限 → 0
 * 8. `wheelZoomFactor(deltaPixels: number): number`
 *    - 2^(−deltaPixels / WAVEFORM_WHEEL_ZOOM_PIXELS)。deltaY<0(上=拡大)で >1・
 *      f(0)=1・f(−d)=1/f(d)・f(a+b)=f(a)×f(b)(連続倍率=契約②④)
 * 9. `scrollWaveformWindow(windowStart, windowSeconds, durationSeconds, deltaPixels, width): number`
 *    - windowStart + (deltaPixels / width) × windowSeconds を clampWaveformWindowStart で clamp。
 *      正の delta = 後ろ(未来)へ。width 0 以下・非有限 delta は移動なし(clamp のみ)
 * 10. `windowXToTime(x, width, windowStart, windowSeconds): number`
 *     - x を [0, width] へ clamp し windowStart + (x/width)×windowSeconds。
 *       退化(width・windowSeconds が正の有限でない・x 非有限)→ windowStart(fail-open)
 * 11. `windowTimeToX(time, width, windowStart, windowSeconds): number`
 *     - time を窓 [windowStart, windowStart+windowSeconds] へ clamp し (t−s)/w × width。
 *       退化・非有限 time → 0
 *     - **等式契約(契約⑤系)**: 倍率1(windowStart=0・windowSeconds=duration)のとき
 *       windowXToTime ≡ xToSeconds・windowTimeToX ≡ positionToX(退化入力含め完全一致)
 * 12. `waveformZoomSeekTime(x, width, windowStart, windowSeconds, index: FrameIndex | null): number`
 *     - windowXToTime → nearestFrame → seekTimeForFrame(要件#37 の吸着経路)。index null は時刻そのまま。
 *       **等倍のとき既存 waveformSeekTime と完全一致**(契約⑤の等式契約)
 * 13. `waveformZoomHeadX(seconds, windowStart, windowSeconds, width): number | null`
 *     - 窓内(両端含む)→ x。窓外 → null(端に貼り付けない=契約⑥)。退化・非有限 → null
 * 14. `followWaveformWindow(position, windowStart, windowSeconds, durationSeconds): number`
 *     - 窓内(両端含む)→ windowStart 現状維持。窓外 → clampWaveformWindowStart(position, …)
 *       =**再生位置を窓の先頭側に置く**(契約⑥の追従規則をこの形で固定)
 * 15. `waveformWindowIndicator(windowStart, windowSeconds, durationSeconds, barWidth):
 *      { left: number; width: number } | null`
 *     - 窓が全尺(windowSeconds ≥ duration=倍率1)→ null(指標を出さない)。
 *       それ以外 → left = windowStart/duration × barWidth・width = windowSeconds/duration × barWidth。
 *       退化(duration・barWidth が正の有限でない)→ null(契約③)
 * 16. `waveformSampleRange(sampleRate, windowStart, windowSeconds, totalSamples):
 *      { from: number; to: number }`
 *     - from = floor(windowStart×rate)・to = ceil((windowStart+windowSeconds)×rate) を
 *       [0, totalSamples] へ clamp した半開区間 [from, to)。常に整数・from ≤ to(契約⑧)
 * 17. `windowPeaks(samples: Float32Array, sampleRate, windowStart, windowSeconds, buckets): WaveformPeaks`
 *     - waveformSampleRange の [from, to) に対する extractPeaks と完全一致(合成契約)。
 *       **窓が全尺・buckets=WAVEFORM_BUCKETS のとき extractPeaks(samples, WAVEFORM_BUCKETS) と完全一致**(契約⑦)
 * 18. `buildCoarsePeaks(samples: Float32Array): WaveformPeaks`
 *     - WAVEFORM_COARSE_STEP 刻みの min/max。長さ = ceil(N/512)・末尾チャンクは端数のまま。
 *       非有限サンプルは 0 扱い(extractPeaks と同じ防御)
 * 19. `windowPeaksFromCoarse(coarse: WaveformPeaks, sampleRate, windowStart, windowSeconds, buckets): WaveformPeaks`
 *     - 粗レベルから窓の包絡を作る。**生サンプル由来(windowPeaks)の包絡を包含する**
 *       (min は同じか小さい・max は同じか大きい=契約⑦)。バケット数は windowPeaks と同じ
 *
 * ### audio-waveform.ts の変更契約(契約⑦。既存 export・既存テストの判定は不変)
 * - **型注意**: WaveformResult の ready 枝への追加フィールドは**型上は省略可**
 *   (`samples?: …` 等)にすること ―― 既存テスト(audio-waveform.acceptance.test.ts の
 *   READY リテラル)が `{ state: 'ready', lanes }` を WaveformResult として構築しており、
 *   必須にすると pnpm check で既存が壊れる(契約⑨)。**analyzeWaveform の戻り値では
 *   常に埋める**(本ファイルは値の存在を runtime で判定する)
 * - `analyzeWaveform` の ready 結果に追加: `samples: Float32Array[] | null`(レーンごとの
 *   デコード済みサンプル。レーン構成は lanes と 1:1=ステレオは [L, R]・3ch 以上は mono 平均1本)・
 *   `coarse: WaveformPeaks[]`(レーンごとの buildCoarsePeaks と完全一致)・
 *   `sampleRate: number`(デコード結果の sampleRate)
 * - input に `maxRetainedSamples?: number` を追加(既定 WAVEFORM_MAX_RETAINED_SAMPLES。
 *   テスト注入 seam=buckets と同型)。**総サンプル数(レーン数×長さ)が上限を超えたら
 *   samples: null(粗レベルのみ保持=契約⑦の縮退)・coarse と lanes は従来どおり返す**
 * - 既存フィールド(state/lanes)と toMatchObject 判定・WAVEFORM_BUCKETS=2000・
 *   extractPeaks の既存契約は不変(契約⑦⑨)
 *
 * ## 本ファイルの判定対象外(reviewer 照合・人間ゲート)
 * - 3ボタン・Option+wheel・Shift+wheel・src リセットの配線(VideoViewer.wiring.test.ts 追加分)
 * - 倍率・windowStart を localStorage に保存しないこと(契約①)・キーボード操作を設けないこと(契約④)
 * - canvas 実幅の据え置き(契約⑨)・ピンチ/スクロールの体感・窓指標の見え方(契約⑩)
 *
 * ## フィクスチャ方針
 * - 決定的な擬似ノイズは 2 進小数(k/128)のみ=float32 で正確、等式判定が丸めに依存しない
 * - FrameIndex は CFR 合成(audio-waveform.acceptance.test.ts と同じ作り)・plain object は
 *   Object.freeze で変異検出(前例踏襲。TypedArray は freeze 不可のため写しとの比較で判定)
 * - analyzeWaveform は構造的 AudioBuffer+注入 decode/extract(既存の注入 seam の前例踏襲)
 */
import { describe, expect, it, vi } from 'vitest';

import {
	WAVEFORM_COARSE_STEP,
	WAVEFORM_MAX_RETAINED_SAMPLES,
	WAVEFORM_MIN_WINDOW_SECONDS,
	WAVEFORM_WHEEL_LINE_PIXELS,
	WAVEFORM_WHEEL_PAGE_PIXELS,
	WAVEFORM_WHEEL_ZOOM_PIXELS,
	buildCoarsePeaks,
	clampWaveformWindowStart,
	clampWaveformZoom,
	followWaveformWindow,
	maxWaveformZoom,
	normalizeWheelDelta,
	scrollWaveformWindow,
	waveformMinWindowSeconds,
	waveformSampleRange,
	waveformWindowIndicator,
	waveformWindowSeconds,
	waveformZoomHeadX,
	waveformZoomSeekTime,
	wheelZoomFactor,
	windowPeaks,
	windowPeaksFromCoarse,
	windowTimeToX,
	windowXToTime,
	zoomWaveformAtAnchor,
} from './waveform-zoom';
import {
	WAVEFORM_BUCKETS,
	analyzeWaveform,
	extractPeaks,
	mixToMono,
	positionToX,
	waveformSeekTime,
	xToSeconds,
} from './audio-waveform';
import type {
	WaveformAudioBuffer,
	WaveformExtraction,
	WaveformPeaks,
} from './audio-waveform';
import { nearestFrame, seekTimeForFrame } from './video-frame';
import type { FrameIndex } from './video-frame';

// ---------------------------------------------------------------------------
// フィクスチャとヘルパー
// ---------------------------------------------------------------------------

const VIDEO_MP4 = 'file:///Users/a/movies/final.mp4';

/** 決定的な擬似ノイズ(k/128 の2進小数=float32 で正確に表せる値だけを使う)。 */
function dyadicNoise(length: number): Float32Array {
	return Float32Array.from({ length }, (_, i) => (((i * 37 + 11) % 257) - 128) / 128);
}

/** CFR フレーム索引を合成する(times[i] = i × fpsDen / fpsNum。#39/#41 と同じ作り)。 */
function cfrIndex(fpsNum: number, fpsDen: number, frameCount: number): FrameIndex {
	const times = Array.from({ length: frameCount }, (_, i) => (i * fpsDen) / fpsNum);
	const index: FrameIndex = {
		times,
		duration: (frameCount * fpsDen) / fpsNum,
		fpsNum,
		fpsDen,
		isCfr: true,
	};
	// 変異検出(前例踏襲=video-initial-frame.acceptance.test.ts)。
	Object.freeze(index.times);
	return Object.freeze(index);
}

/** 構造的 AudioBuffer(要件#41 契約⑦の前例踏襲)。 */
function audioBuf(channels: (number[] | Float32Array)[], sampleRate = 8000): WaveformAudioBuffer {
	const data = channels.map((ch) => Float32Array.from(ch));
	return {
		numberOfChannels: data.length,
		length: data[0]?.length ?? 0,
		sampleRate,
		getChannelData: (channel: number) => data[channel],
	};
}

/** decode モック(受け取ったバイト列を無視して固定の AudioBuffer を返す)。 */
function decodeTo(buffer: WaveformAudioBuffer) {
	return vi.fn(async (_bytes: ArrayBuffer) => buffer);
}

/** extract モック(mp4/mov 抽出経路の応答を固定で返す)。 */
function extractTo(extraction: WaveformExtraction) {
	return vi.fn(async (_videoUri: string) => extraction);
}

/**
 * ready 結果の契約⑦拡張の形(実装後は WaveformResult の ready 枝がこの形を含む)。
 * 実装前でも本ファイルのコンパイルが型エラーで全滅しないよう、参照はこの型経由で行う
 * (赤は各ケースの assertion で出る=既存前例の namespace 参照と同じ狙い)。
 */
type ZoomReadyResult = {
	state: 'ready';
	lanes: WaveformPeaks[];
	samples: Float32Array[] | null;
	coarse: WaveformPeaks[];
	sampleRate: number;
};

/** 粗レベルの参照実装(WAVEFORM_COARSE_STEP 刻みの min/max・非有限は 0 扱い)。 */
function refCoarse(samples: Float32Array, step: number): { mins: number[]; maxs: number[] } {
	const mins: number[] = [];
	const maxs: number[] = [];
	for (let from = 0; from < samples.length; from += step) {
		const to = Math.min(from + step, samples.length);
		let mn = Infinity;
		let mx = -Infinity;
		for (let j = from; j < to; j++) {
			const v = Number.isFinite(samples[j]) ? samples[j] : 0;
			mn = Math.min(mn, v);
			mx = Math.max(mx, v);
		}
		mins.push(mn);
		maxs.push(mx);
	}
	return { mins, maxs };
}

// ---------------------------------------------------------------------------
// 定数 — 最小窓・保持上限・粗レベル刻み・ホイール係数(契約②④⑦)
// ---------------------------------------------------------------------------

describe('定数 — 最小窓 0.25 秒・保持上限 256MB 相当・粗レベル 512 刻み(要件#47 契約②⑦)', () => {
	it('WAVEFORM_MIN_WINDOW_SECONDS=0.25・WAVEFORM_MAX_RETAINED_SAMPLES=256MB/4・WAVEFORM_COARSE_STEP=512', () => {
		expect(WAVEFORM_MIN_WINDOW_SECONDS).toBe(0.25);
		expect(WAVEFORM_MAX_RETAINED_SAMPLES).toBe((256 * 1024 * 1024) / 4);
		expect(WAVEFORM_COARSE_STEP).toBe(512);
	});

	it('ホイール正規化と指数写像の係数(deltaMode 1=16px・2=800px・240px で2倍)', () => {
		expect(WAVEFORM_WHEEL_LINE_PIXELS).toBe(16);
		expect(WAVEFORM_WHEEL_PAGE_PIXELS).toBe(800);
		expect(WAVEFORM_WHEEL_ZOOM_PIXELS).toBe(240);
	});
});

// ---------------------------------------------------------------------------
// waveformMinWindowSeconds — 粗レベルのみ保持のときの下限窓(契約②⑦)
// ---------------------------------------------------------------------------

describe('waveformMinWindowSeconds — 保持縮退時は「1バケット=1粗レベル要素」で止まる(契約②⑦)', () => {
	it('生サンプル保持時は 0.25 秒', () => {
		expect(waveformMinWindowSeconds(false, 8000)).toBe(WAVEFORM_MIN_WINDOW_SECONDS);
		expect(waveformMinWindowSeconds(false, 48000)).toBe(WAVEFORM_MIN_WINDOW_SECONDS);
	});

	it('粗レベルのみ保持時は WAVEFORM_BUCKETS×WAVEFORM_COARSE_STEP/sampleRate(8kHz なら 128 秒)', () => {
		expect(waveformMinWindowSeconds(true, 8000)).toBe(
			(WAVEFORM_BUCKETS * WAVEFORM_COARSE_STEP) / 8000,
		);
		// 高サンプルレートで式が 0.25 を下回っても最小窓 0.25 は割らない。
		expect(waveformMinWindowSeconds(true, 8_000_000)).toBe(WAVEFORM_MIN_WINDOW_SECONDS);
	});
});

// ---------------------------------------------------------------------------
// maxWaveformZoom / clampWaveformZoom — 倍率の上下限(契約②)
// ---------------------------------------------------------------------------

describe('maxWaveformZoom / clampWaveformZoom — 下限 1・上限 duration/0.25(契約②)', () => {
	it('上限は duration / WAVEFORM_MIN_WINDOW_SECONDS(100 秒なら 400 倍)', () => {
		expect(maxWaveformZoom(100)).toBe(400);
		expect(maxWaveformZoom(1)).toBe(4);
	});

	it('duration が 0.25 秒以下・0・非有限なら上限 1(ズームできない)', () => {
		expect(maxWaveformZoom(0.25)).toBe(1);
		expect(maxWaveformZoom(0.1)).toBe(1);
		expect(maxWaveformZoom(0)).toBe(1);
		expect(maxWaveformZoom(-5)).toBe(1);
		expect(maxWaveformZoom(Number.NaN)).toBe(1);
		expect(maxWaveformZoom(Number.POSITIVE_INFINITY)).toBe(1);
	});

	it('minWindowSeconds を差し替えると上限が下がる(保持縮退=契約⑦との接続)', () => {
		expect(maxWaveformZoom(1280, waveformMinWindowSeconds(true, 8000))).toBe(10);
	});

	it('clamp: 範囲内はそのまま・下限 1・上限 max で切る', () => {
		expect(clampWaveformZoom(2, 100)).toBe(2);
		expect(clampWaveformZoom(400, 100)).toBe(400); // 上限ちょうど
		expect(clampWaveformZoom(0.5, 100)).toBe(1);
		expect(clampWaveformZoom(0, 100)).toBe(1);
		expect(clampWaveformZoom(401, 100)).toBe(400);
		expect(clampWaveformZoom(1e9, 100)).toBe(400);
	});

	it('clamp: 非有限 zoom は 1 へ(fail-open)・×2/÷2 ボタンの列は上限で止まり等倍で 1 に戻る', () => {
		expect(clampWaveformZoom(Number.NaN, 100)).toBe(1);
		expect(clampWaveformZoom(Number.POSITIVE_INFINITY, 100)).toBe(400);
		expect(clampWaveformZoom(Number.NEGATIVE_INFINITY, 100)).toBe(1);

		// ボタン契約(契約④)=nextZoom は zoom×2 / zoom÷2 / 1 を clamp へ通すだけ。
		let zoom = 1;
		for (let i = 0; i < 12; i++) zoom = clampWaveformZoom(zoom * 2, 100);
		expect(zoom).toBe(400); // 2^12=4096 は上限 400 で止まる
		zoom = clampWaveformZoom(zoom / 2, 100);
		expect(zoom).toBe(200);
		expect(clampWaveformZoom(1, 100)).toBe(1); // 等倍
	});
});

// ---------------------------------------------------------------------------
// waveformWindowSeconds / clampWaveformWindowStart — 窓の実尺と開始位置(契約②)
// ---------------------------------------------------------------------------

describe('waveformWindowSeconds / clampWaveformWindowStart — 窓の clamp(契約②)', () => {
	it('windowSeconds = duration / zoom(倍率 1 で全尺)', () => {
		expect(waveformWindowSeconds(1, 100)).toBe(100);
		expect(waveformWindowSeconds(4, 100)).toBe(25);
		expect(waveformWindowSeconds(400, 100)).toBe(0.25);
	});

	it('windowSeconds: zoom < 1・非有限は 1 扱い・duration 退化は 0', () => {
		expect(waveformWindowSeconds(0.5, 100)).toBe(100);
		expect(waveformWindowSeconds(Number.NaN, 100)).toBe(100);
		expect(waveformWindowSeconds(2, 0)).toBe(0);
		expect(waveformWindowSeconds(2, Number.NaN)).toBe(0);
		expect(waveformWindowSeconds(2, Number.POSITIVE_INFINITY)).toBe(0);
	});

	it('windowStart は [0, duration − windowSeconds] へ clamp', () => {
		expect(clampWaveformWindowStart(20, 25, 100)).toBe(20);
		expect(clampWaveformWindowStart(75, 25, 100)).toBe(75); // 上限ちょうど
		expect(clampWaveformWindowStart(80, 25, 100)).toBe(75);
		expect(clampWaveformWindowStart(-3, 25, 100)).toBe(0);
	});

	it('倍率 1(windowSeconds ≥ duration)は windowStart=0 に固定・非有限 → 0', () => {
		expect(clampWaveformWindowStart(50, 100, 100)).toBe(0);
		expect(clampWaveformWindowStart(50, 120, 100)).toBe(0);
		expect(clampWaveformWindowStart(Number.NaN, 25, 100)).toBe(0);
		expect(clampWaveformWindowStart(Number.POSITIVE_INFINITY, 25, 100)).toBe(75);
	});
});

// ---------------------------------------------------------------------------
// zoomWaveformAtAnchor — アンカー拡大(契約②④・ポインタ下の時刻が動かない)
// ---------------------------------------------------------------------------

describe('zoomWaveformAtAnchor — ポインタ位置の時刻が倍率変更の前後で同じ x に留まる(契約②④)', () => {
	const DURATION = 100;
	const WIDTH = 500;

	it('拡大: アンカー x の時刻が前後で不変(往復等式)', () => {
		// z=2・s=20・x=125(帯の 1/4)→ アンカー時刻 = 20 + 0.25×50 = 32.5
		const before = windowXToTime(125, WIDTH, 20, waveformWindowSeconds(2, DURATION));
		expect(before).toBe(32.5);

		const next = zoomWaveformAtAnchor(2, 20, 4, 125, WIDTH, DURATION);
		expect(next.zoom).toBe(4);
		expect(next.windowStart).toBeCloseTo(26.25, 12);
		const after = windowXToTime(
			125,
			WIDTH,
			next.windowStart,
			waveformWindowSeconds(next.zoom, DURATION),
		);
		expect(after).toBeCloseTo(before, 12);
	});

	it('縮小して戻すと元の窓に戻る(×2 → ÷2 の往復)', () => {
		const zoomed = zoomWaveformAtAnchor(2, 20, 4, 125, WIDTH, DURATION);
		const back = zoomWaveformAtAnchor(zoomed.zoom, zoomed.windowStart, 2, 125, WIDTH, DURATION);
		expect(back.zoom).toBe(2);
		expect(back.windowStart).toBeCloseTo(20, 12);
	});

	it('縮小で窓が尺からはみ出すときは clamp が勝つ(アンカーより境界優先)', () => {
		// z=4・s=75(末尾窓)・x=0 → アンカー時刻 75。z=2 の素の開始 75 は上限 50 を超える。
		const next = zoomWaveformAtAnchor(4, 75, 2, 0, WIDTH, DURATION);
		expect(next.zoom).toBe(2);
		expect(next.windowStart).toBe(50);
	});

	it('等倍(nextZoom=1 以下)は {zoom: 1, windowStart: 0}', () => {
		expect(zoomWaveformAtAnchor(4, 26.25, 1, 125, WIDTH, DURATION)).toEqual({
			zoom: 1,
			windowStart: 0,
		});
		expect(zoomWaveformAtAnchor(4, 26.25, 0.25, 125, WIDTH, DURATION)).toEqual({
			zoom: 1,
			windowStart: 0,
		});
	});

	it('nextZoom は clampWaveformZoom を通る(上限 400・非有限は 1)', () => {
		const capped = zoomWaveformAtAnchor(2, 20, 1e9, 250, WIDTH, DURATION);
		expect(capped.zoom).toBe(400);
		const invalid = zoomWaveformAtAnchor(2, 20, Number.NaN, 250, WIDTH, DURATION);
		expect(invalid).toEqual({ zoom: 1, windowStart: 0 });
	});

	it('minWindowSeconds の差し替えが上限に効く(保持縮退時の上限低下=契約⑦)', () => {
		const coarseMin = waveformMinWindowSeconds(true, 8000); // 128 秒
		const next = zoomWaveformAtAnchor(1, 0, 1e9, 0, WIDTH, 1280, coarseMin);
		expect(next.zoom).toBe(10);
	});
});

// ---------------------------------------------------------------------------
// normalizeWheelDelta / wheelZoomFactor — ホイール量の正規化と指数写像(契約④)
// ---------------------------------------------------------------------------

describe('normalizeWheelDelta / wheelZoomFactor — deltaMode 正規化 → 指数写像(契約④)', () => {
	it('deltaMode 0(pixel)はそのまま・1(line)は ×16・2(page)は ×800', () => {
		expect(normalizeWheelDelta(5, 0)).toBe(5);
		expect(normalizeWheelDelta(-3, 0)).toBe(-3);
		expect(normalizeWheelDelta(3, 1)).toBe(3 * WAVEFORM_WHEEL_LINE_PIXELS);
		expect(normalizeWheelDelta(-1, 1)).toBe(-WAVEFORM_WHEEL_LINE_PIXELS);
		expect(normalizeWheelDelta(2, 2)).toBe(2 * WAVEFORM_WHEEL_PAGE_PIXELS);
	});

	it('未知の deltaMode は pixel 扱い・非有限 delta は 0(fail-open)', () => {
		expect(normalizeWheelDelta(7, 9)).toBe(7);
		expect(normalizeWheelDelta(Number.NaN, 0)).toBe(0);
		expect(normalizeWheelDelta(Number.POSITIVE_INFINITY, 1)).toBe(0);
	});

	it('指数写像: f(0)=1・240px で2倍・符号は deltaY<0 で拡大', () => {
		expect(wheelZoomFactor(0)).toBe(1);
		expect(wheelZoomFactor(-WAVEFORM_WHEEL_ZOOM_PIXELS)).toBeCloseTo(2, 12);
		expect(wheelZoomFactor(WAVEFORM_WHEEL_ZOOM_PIXELS)).toBeCloseTo(0.5, 12);
		expect(wheelZoomFactor(-2 * WAVEFORM_WHEEL_ZOOM_PIXELS)).toBeCloseTo(4, 12);
		expect(wheelZoomFactor(-1)).toBeGreaterThan(1);
		expect(wheelZoomFactor(1)).toBeLessThan(1);
	});

	it('連続倍率: f(a+b) = f(a)×f(b)・f(−d) = 1/f(d)(小刻みなホイールの合成が一回分と一致)', () => {
		expect(wheelZoomFactor(-100) * wheelZoomFactor(-140)).toBeCloseTo(wheelZoomFactor(-240), 12);
		expect(wheelZoomFactor(-37) * wheelZoomFactor(37)).toBeCloseTo(1, 12);
	});

	it('非有限 delta は 1(倍率を動かさない)', () => {
		expect(wheelZoomFactor(Number.NaN)).toBe(1);
		expect(wheelZoomFactor(Number.POSITIVE_INFINITY)).toBe(1);
		expect(wheelZoomFactor(Number.NEGATIVE_INFINITY)).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// scrollWaveformWindow — 横スクロール(帯のピクセル → 窓の時間。契約④)
// ---------------------------------------------------------------------------

describe('scrollWaveformWindow — 横成分/Shift+ホイールを窓の時間へ写像(契約④)', () => {
	it('正の delta で後ろへ: 移動量 = (delta/width) × windowSeconds', () => {
		expect(scrollWaveformWindow(20, 50, 100, 100, 500)).toBe(30);
		expect(scrollWaveformWindow(20, 50, 100, -50, 500)).toBe(15);
	});

	it('端で clamp される(先頭より前・末尾より後ろへは動かない)', () => {
		expect(scrollWaveformWindow(20, 50, 100, -250, 500)).toBe(0);
		expect(scrollWaveformWindow(40, 50, 100, 200, 500)).toBe(50);
	});

	it('width が正の有限でない・delta 非有限は移動なし(clamp のみ)', () => {
		expect(scrollWaveformWindow(20, 50, 100, 100, 0)).toBe(20);
		expect(scrollWaveformWindow(20, 50, 100, 100, Number.NaN)).toBe(20);
		expect(scrollWaveformWindow(20, 50, 100, Number.NaN, 500)).toBe(20);
		// 移動なしでも clamp は掛かる(範囲外の windowStart を持ち込まない)。
		expect(scrollWaveformWindow(80, 50, 100, Number.NaN, 500)).toBe(50);
	});

	it('倍率 1(窓=全尺)ではどれだけ回しても 0 のまま', () => {
		expect(scrollWaveformWindow(0, 100, 100, 500, 500)).toBe(0);
		expect(scrollWaveformWindow(0, 100, 100, -500, 500)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// windowXToTime / windowTimeToX — 座標往復と倍率 1 の等式契約(契約⑤⑧)
// ---------------------------------------------------------------------------

describe('windowXToTime / windowTimeToX — 窓と帯幅の間の往復変換(契約⑧)', () => {
	it('x → 時刻: 窓 [20, 70]・幅 500 の線形写像', () => {
		expect(windowXToTime(0, 500, 20, 50)).toBe(20);
		expect(windowXToTime(125, 500, 20, 50)).toBe(32.5);
		expect(windowXToTime(500, 500, 20, 50)).toBe(70);
	});

	it('時刻 → x: 逆写像(同じ窓で往復すると元へ戻る)', () => {
		expect(windowTimeToX(20, 500, 20, 50)).toBe(0);
		expect(windowTimeToX(32.5, 500, 20, 50)).toBe(125);
		expect(windowTimeToX(70, 500, 20, 50)).toBe(500);
		for (const x of [0, 1, 77.5, 250, 499, 500]) {
			expect(windowTimeToX(windowXToTime(x, 500, 20, 50), 500, 20, 50)).toBeCloseTo(x, 9);
		}
	});

	it('clamp: 帯の外の x は端の時刻・窓の外の時刻は端の x', () => {
		expect(windowXToTime(-10, 500, 20, 50)).toBe(20);
		expect(windowXToTime(600, 500, 20, 50)).toBe(70);
		expect(windowTimeToX(10, 500, 20, 50)).toBe(0);
		expect(windowTimeToX(90, 500, 20, 50)).toBe(500);
	});

	it('退化入力の fail-open: x 側は windowStart・時刻側は 0', () => {
		expect(windowXToTime(Number.NaN, 500, 20, 50)).toBe(20);
		expect(windowXToTime(100, 0, 20, 50)).toBe(20);
		expect(windowXToTime(100, 500, 20, 0)).toBe(20);
		expect(windowTimeToX(Number.NaN, 500, 20, 50)).toBe(0);
		expect(windowTimeToX(30, 0, 20, 50)).toBe(0);
		expect(windowTimeToX(30, 500, 20, Number.NaN)).toBe(0);
	});

	it('等式契約(契約⑤系): 倍率 1 のとき windowXToTime ≡ xToSeconds(退化入力含め完全一致)', () => {
		const D = 100;
		const W = 500;
		for (const x of [0, 1, 125, 250, 499.5, 500, -10, 600, Number.NaN]) {
			expect(windowXToTime(x, W, 0, D)).toBe(xToSeconds(x, W, D));
		}
		// 退化(幅 0・尺 0)でも既存関数と同じ値に落ちる。
		expect(windowXToTime(100, 0, 0, D)).toBe(xToSeconds(100, 0, D));
		expect(windowXToTime(100, W, 0, 0)).toBe(xToSeconds(100, W, 0));
	});

	it('等式契約(契約⑤系): 倍率 1 のとき windowTimeToX ≡ positionToX(退化入力含め完全一致)', () => {
		const D = 100;
		const W = 500;
		for (const t of [0, 0.5, 32.5, 99, 100, -5, 150, Number.NaN]) {
			expect(windowTimeToX(t, W, 0, D)).toBe(positionToX(t, D, W));
		}
		expect(windowTimeToX(50, 0, 0, D)).toBe(positionToX(50, D, 0));
		expect(windowTimeToX(50, W, 0, 0)).toBe(positionToX(50, 0, W));
	});
});

// ---------------------------------------------------------------------------
// waveformZoomSeekTime — 拡大状態のクリックシーク(契約⑤・要件#37 の吸着経路)
// ---------------------------------------------------------------------------

describe('waveformZoomSeekTime — 窓を通した x から吸着シーク先へ(契約⑤)', () => {
	// 30fps・120 秒(3600 フレーム)の CFR 索引。freeze 済み=吸着経路が索引を書き換えないことも検出。
	const INDEX = cfrIndex(30, 1, 3600);

	it('索引なしは windowXToTime の時刻そのまま(fail-open=要件#41 契約⑥の家風)', () => {
		expect(waveformZoomSeekTime(125, 500, 20, 50, null)).toBe(32.5);
	});

	it('索引ありは nearestFrame → seekTimeForFrame の吸着経路を通る(要件#37)', () => {
		for (const x of [0, 60, 125, 333, 500]) {
			const t = windowXToTime(x, 500, 20, 50);
			const expected = seekTimeForFrame(INDEX, nearestFrame(INDEX, t));
			expect(waveformZoomSeekTime(x, 500, 20, 50, INDEX)).toBe(expected);
		}
	});

	it('等式契約: 等倍(windowStart=0・windowSeconds=duration)のとき既存 waveformSeekTime と完全一致', () => {
		const D = INDEX.duration;
		for (const x of [0, 1, 125, 250, 499.5, 500, -10, 600, Number.NaN]) {
			expect(waveformZoomSeekTime(x, 500, 0, D, INDEX)).toBe(waveformSeekTime(x, 500, D, INDEX));
			expect(waveformZoomSeekTime(x, 500, 0, D, null)).toBe(waveformSeekTime(x, 500, D, null));
		}
	});
});

// ---------------------------------------------------------------------------
// waveformZoomHeadX — 再生ヘッド(窓外は描かない。契約⑥)
// ---------------------------------------------------------------------------

describe('waveformZoomHeadX — 窓内は x・窓外は null(端に貼り付けない=契約⑥)', () => {
	it('窓内の再生位置は線形写像の x', () => {
		expect(waveformZoomHeadX(32.5, 20, 50, 500)).toBe(125);
		expect(waveformZoomHeadX(45, 20, 50, 500)).toBe(250);
	});

	it('両端は窓内扱い(x=0 / x=width)', () => {
		expect(waveformZoomHeadX(20, 20, 50, 500)).toBe(0);
		expect(waveformZoomHeadX(70, 20, 50, 500)).toBe(500);
	});

	it('窓外は null(positionToX の clamp のような嘘の位置を返さない)', () => {
		expect(waveformZoomHeadX(19.999, 20, 50, 500)).toBeNull();
		expect(waveformZoomHeadX(70.001, 20, 50, 500)).toBeNull();
		expect(waveformZoomHeadX(0, 20, 50, 500)).toBeNull();
		expect(waveformZoomHeadX(120, 20, 50, 500)).toBeNull();
	});

	it('退化・非有限は null(描かない側へ倒す)', () => {
		expect(waveformZoomHeadX(Number.NaN, 20, 50, 500)).toBeNull();
		expect(waveformZoomHeadX(30, 20, 50, 0)).toBeNull();
		expect(waveformZoomHeadX(30, 20, 0, 500)).toBeNull();
		expect(waveformZoomHeadX(30, 20, Number.NaN, 500)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// followWaveformWindow — 再生追従(契約⑥・規則=窓外に出たら再生位置を窓の先頭へ)
// ---------------------------------------------------------------------------

describe('followWaveformWindow — 窓内は現状維持・窓外は位置を窓の先頭に置く(契約⑥)', () => {
	it('窓内(両端含む)は windowStart を動かさない', () => {
		expect(followWaveformWindow(30, 20, 50, 100)).toBe(20);
		expect(followWaveformWindow(20, 20, 50, 100)).toBe(20);
		expect(followWaveformWindow(70, 20, 50, 100)).toBe(20);
	});

	it('前方へ出たら再生位置が窓の先頭になる(clamp 込み)', () => {
		expect(followWaveformWindow(71, 20, 50, 100)).toBe(50); // 素の 71 は上限 50 で clamp
		expect(followWaveformWindow(45, 0, 25, 100)).toBe(45);
	});

	it('後方(巻き戻し・クリックシーク)へ出ても同じ規則で窓が跳ぶ', () => {
		expect(followWaveformWindow(5, 20, 50, 100)).toBe(5);
		expect(followWaveformWindow(0, 20, 50, 100)).toBe(0);
	});

	it('倍率 1(窓=全尺)は常に 0・非有限 position は現状維持(clamp 済みの値を返す)', () => {
		expect(followWaveformWindow(30, 0, 100, 100)).toBe(0);
		expect(followWaveformWindow(Number.NaN, 20, 50, 100)).toBe(20);
	});
});

// ---------------------------------------------------------------------------
// waveformWindowIndicator — シークバーへ重ねる窓指標の幾何(契約③)
// ---------------------------------------------------------------------------

describe('waveformWindowIndicator — シークバー幅に対する窓の left/width(契約③)', () => {
	it('拡大中は窓の位置と幅をシークバー座標へ写す', () => {
		expect(waveformWindowIndicator(25, 25, 100, 400)).toEqual({ left: 100, width: 100 });
		expect(waveformWindowIndicator(0, 50, 100, 400)).toEqual({ left: 0, width: 200 });
		expect(waveformWindowIndicator(75, 25, 100, 400)).toEqual({ left: 300, width: 100 });
	});

	it('倍率 1(窓 ≥ 全尺)は null(指標を出さない)', () => {
		expect(waveformWindowIndicator(0, 100, 100, 400)).toBeNull();
		expect(waveformWindowIndicator(0, 120, 100, 400)).toBeNull();
	});

	it('退化(尺・バー幅が正の有限でない)は null', () => {
		expect(waveformWindowIndicator(25, 25, 0, 400)).toBeNull();
		expect(waveformWindowIndicator(25, 25, Number.NaN, 400)).toBeNull();
		expect(waveformWindowIndicator(25, 25, 100, 0)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// waveformSampleRange — 窓に対応するサンプル範囲(契約⑧)
// ---------------------------------------------------------------------------

describe('waveformSampleRange — 窓 → 半開区間 [from, to) の整数サンプル範囲(契約⑧)', () => {
	it('from=floor(start×rate)・to=ceil(end×rate)', () => {
		expect(waveformSampleRange(8000, 1, 0.5, 100000)).toEqual({ from: 8000, to: 12000 });
		expect(waveformSampleRange(8000, 0, 0.25, 100000)).toEqual({ from: 0, to: 2000 });
	});

	it('端数は窓を欠けさせない向きに丸める(from は floor・to は ceil)', () => {
		expect(waveformSampleRange(8000, 0.0001, 0.5, 100000)).toEqual({ from: 0, to: 4001 });
	});

	it('境界 clamp: 末尾を越えない・負は 0・常に from ≤ to', () => {
		expect(waveformSampleRange(8000, 12, 1, 100000)).toEqual({ from: 96000, to: 100000 });
		expect(waveformSampleRange(8000, 13, 1, 100000)).toEqual({ from: 100000, to: 100000 });
		expect(waveformSampleRange(8000, -1, 0.5, 100000)).toEqual({ from: 0, to: 0 });
		const range = waveformSampleRange(8000, 11.9, 1, 100000);
		expect(range.from).toBeLessThanOrEqual(range.to);
	});

	it('結果は常に整数(TypedArray の添字にそのまま使える)', () => {
		const range = waveformSampleRange(8000, 1.23456, 0.7891, 100000);
		expect(Number.isInteger(range.from)).toBe(true);
		expect(Number.isInteger(range.to)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// windowPeaks — 窓の再バケット化(契約⑦・全尺で既存 extractPeaks と完全一致)
// ---------------------------------------------------------------------------

describe('windowPeaks — 窓のサンプルを既存 extractPeaks の規則でバケット化(契約⑦)', () => {
	it('窓が全尺のとき extractPeaks(samples, WAVEFORM_BUCKETS) と完全一致(等価性=契約⑦)', () => {
		const samples = dyadicNoise(12345);
		const rate = 8000;
		const result = windowPeaks(samples, rate, 0, samples.length / rate, WAVEFORM_BUCKETS);
		const expected = extractPeaks(samples, WAVEFORM_BUCKETS);
		expect(result.mins).toEqual(expected.mins);
		expect(result.maxs).toEqual(expected.maxs);
	});

	it('部分窓は waveformSampleRange の [from, to) に対する extractPeaks と完全一致(合成契約)', () => {
		const samples = dyadicNoise(16000);
		const rate = 8000;
		const { from, to } = waveformSampleRange(rate, 0.5, 0.75, samples.length);
		const result = windowPeaks(samples, rate, 0.5, 0.75, 40);
		const expected = extractPeaks(samples.slice(from, to), 40);
		expect(result.mins).toEqual(expected.mins);
		expect(result.maxs).toEqual(expected.maxs);
	});

	it('入力サンプルを書き換えない(変異検出)', () => {
		const samples = dyadicNoise(4096);
		const copy = samples.slice();
		windowPeaks(samples, 8000, 0.1, 0.2, 16);
		expect(samples).toEqual(copy);
	});
});

// ---------------------------------------------------------------------------
// buildCoarsePeaks / windowPeaksFromCoarse — 粗レベルと包含契約(契約⑦)
// ---------------------------------------------------------------------------

describe('buildCoarsePeaks — WAVEFORM_COARSE_STEP=512 刻みの min/max(契約⑦)', () => {
	it('長さ = ceil(N/512)・各要素はチャンクの min/max(末尾は端数のまま)', () => {
		const samples = dyadicNoise(512 * 3 + 100);
		const coarse = buildCoarsePeaks(samples);
		const expected = refCoarse(samples, WAVEFORM_COARSE_STEP);
		expect(coarse.mins.length).toBe(4);
		expect(coarse.maxs.length).toBe(4);
		expect(Array.from(coarse.mins)).toEqual(expected.mins);
		expect(Array.from(coarse.maxs)).toEqual(expected.maxs);
	});

	it('非有限サンプルは 0 扱い(extractPeaks と同じ防御)', () => {
		const samples = new Float32Array(WAVEFORM_COARSE_STEP).fill(0.5);
		samples[10] = Number.NaN;
		samples[20] = Number.POSITIVE_INFINITY;
		const coarse = buildCoarsePeaks(samples);
		expect(coarse.mins[0]).toBe(0);
		expect(coarse.maxs[0]).toBe(0.5);
	});

	it('空入力は空の粗レベル・入力を書き換えない', () => {
		const empty = buildCoarsePeaks(new Float32Array(0));
		expect(empty.mins.length).toBe(0);
		expect(empty.maxs.length).toBe(0);

		const samples = dyadicNoise(2048);
		const copy = samples.slice();
		buildCoarsePeaks(samples);
		expect(samples).toEqual(copy);
	});
});

describe('windowPeaksFromCoarse — 粗レベル経由の包絡が生サンプル由来を包含する(契約⑦)', () => {
	it('部分窓: min ≤ 生・max ≥ 生(全バケット・バケット数は windowPeaks と同じ)', () => {
		const samples = dyadicNoise(512 * 400); // 204800 サンプル=25.6 秒(8kHz)
		const rate = 8000;
		const coarse = buildCoarsePeaks(samples);
		Object.freeze(coarse); // 粗レベルの器を書き換えないこと(変異検出)。

		const buckets = 50;
		const raw = windowPeaks(samples, rate, 3.2, 12.8, buckets);
		const via = windowPeaksFromCoarse(coarse, rate, 3.2, 12.8, buckets);
		expect(via.mins.length).toBe(buckets);
		expect(via.maxs.length).toBe(buckets);
		for (let i = 0; i < buckets; i++) {
			expect(via.mins[i]).toBeLessThanOrEqual(raw.mins[i]);
			expect(via.maxs[i]).toBeGreaterThanOrEqual(raw.maxs[i]);
		}
	});

	it('全尺の窓でも包含が成り立つ(粗レベルだけで全体表示が描ける)', () => {
		const samples = dyadicNoise(512 * 300);
		const rate = 8000;
		const coarse = buildCoarsePeaks(samples);
		const buckets = 64;
		const seconds = samples.length / rate;
		const raw = windowPeaks(samples, rate, 0, seconds, buckets);
		const via = windowPeaksFromCoarse(coarse, rate, 0, seconds, buckets);
		expect(via.mins.length).toBe(buckets);
		for (let i = 0; i < buckets; i++) {
			expect(via.mins[i]).toBeLessThanOrEqual(raw.mins[i]);
			expect(via.maxs[i]).toBeGreaterThanOrEqual(raw.maxs[i]);
		}
	});
});

// ---------------------------------------------------------------------------
// analyzeWaveform の契約⑦拡張 — samples / coarse / sampleRate と保持縮退
// ---------------------------------------------------------------------------

describe('analyzeWaveform 拡張 — ready 結果に samples/coarse/sampleRate を持つ(要件#47 契約⑦)', () => {
	const OK_EXTRACTION: WaveformExtraction = { state: 'ok', bytes: new ArrayBuffer(8) };

	it('ステレオ: samples はレーンと 1:1([L, R])・coarse は各レーンの buildCoarsePeaks・sampleRate はデコード結果の値', async () => {
		const L = dyadicNoise(1000);
		const R = dyadicNoise(1000).map((v) => -v);
		const result = await analyzeWaveform(VIDEO_MP4, {
			durationSeconds: 1,
			hasAudioTrack: true,
			decode: decodeTo(audioBuf([L, R])),
			extract: extractTo(OK_EXTRACTION),
		});
		// 既存の toMatchObject 判定(state/lanes)は不変のまま成り立つ(契約⑦⑨)。
		expect(result).toMatchObject({ state: 'ready' });

		const ready = result as unknown as ZoomReadyResult;
		expect(ready.lanes).toHaveLength(2);
		expect(ready.sampleRate).toBe(8000);
		expect(ready.samples).not.toBeNull();
		expect(ready.samples).toHaveLength(2);
		expect(ready.samples?.[0]).toEqual(L);
		expect(ready.samples?.[1]).toEqual(Float32Array.from(R));
		expect(ready.coarse).toHaveLength(2);
		expect(ready.coarse[0]).toEqual(buildCoarsePeaks(L));
		expect(ready.coarse[1]).toEqual(buildCoarsePeaks(Float32Array.from(R)));
	});

	it('mono: samples は1本(チャンネルの写し)・coarse も1本', async () => {
		const ch = dyadicNoise(700);
		const result = await analyzeWaveform(VIDEO_MP4, {
			durationSeconds: 1,
			hasAudioTrack: true,
			decode: decodeTo(audioBuf([ch])),
			extract: extractTo(OK_EXTRACTION),
		});
		const ready = result as unknown as ZoomReadyResult;
		expect(ready.state).toBe('ready');
		expect(ready.samples).toHaveLength(1);
		expect(ready.samples?.[0]).toEqual(ch);
		expect(ready.coarse).toHaveLength(1);
		expect(ready.coarse[0]).toEqual(buildCoarsePeaks(ch));
	});

	it('3ch 以上: samples は mono 平均1本(mixToMono と完全一致=レーン構成と 1:1)', async () => {
		const a = dyadicNoise(600);
		const b = dyadicNoise(600).map((v) => v / 2);
		const c = new Float32Array(600).fill(0.25);
		const result = await analyzeWaveform(VIDEO_MP4, {
			durationSeconds: 1,
			hasAudioTrack: true,
			decode: decodeTo(audioBuf([a, Float32Array.from(b), c])),
			extract: extractTo(OK_EXTRACTION),
		});
		const ready = result as unknown as ZoomReadyResult;
		expect(ready.state).toBe('ready');
		expect(ready.lanes).toHaveLength(1);
		expect(ready.samples).toHaveLength(1);
		const mono = mixToMono([a, Float32Array.from(b), c]);
		expect(ready.samples?.[0]).toEqual(mono);
		expect(ready.coarse[0]).toEqual(buildCoarsePeaks(mono));
	});

	it('保持縮退: 総サンプル数(レーン数×長さ)が上限超過なら samples: null・coarse と lanes は残る', async () => {
		// 実サイズ(256MB)は unit テストで作れないので、注入 seam(maxRetainedSamples)で
		// 上限だけ下げて規則を判定する(buckets 注入と同型の seam=契約⑦)。
		const L = dyadicNoise(10);
		const R = dyadicNoise(10);
		const over = await analyzeWaveform(VIDEO_MP4, {
			durationSeconds: 1,
			hasAudioTrack: true,
			decode: decodeTo(audioBuf([L, R])),
			extract: extractTo(OK_EXTRACTION),
			maxRetainedSamples: 16, // 2 レーン×10 = 20 > 16
		});
		const readyOver = over as unknown as ZoomReadyResult;
		expect(readyOver.state).toBe('ready');
		expect(readyOver.samples).toBeNull();
		expect(readyOver.coarse).toHaveLength(2);
		expect(readyOver.lanes).toHaveLength(2);

		const within = await analyzeWaveform(VIDEO_MP4, {
			durationSeconds: 1,
			hasAudioTrack: true,
			decode: decodeTo(audioBuf([L, R])),
			extract: extractTo(OK_EXTRACTION),
			maxRetainedSamples: 20, // ちょうど上限=保持する(超「えたら」だけ落とす)
		});
		const readyWithin = within as unknown as ZoomReadyResult;
		expect(readyWithin.samples).toHaveLength(2);
	});
});
