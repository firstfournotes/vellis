/**
 * 要件#41 追補h(2026-10-11・backlog 326)の受け入れテスト AC-41-追h (a)。
 * 「解析尺と横軸の尺が違っても、等倍と ×4 で山が同じ時刻に乗る」を純関数で固定する
 * (契約(追補h)5=回帰の見張り。**今の実装で緑**。製品のコードは変えない=契約1)。
 *
 * ## 背景(req-41.md 追補h「調査」)
 * backlog 326「m4a を ×4 に拡大すると 5 秒の山が再生ヘッドより約 6.5px 右に見える」は
 * 製品ではなく測り方の誤りだった。ffmpeg で作った m4a は `<audio>.duration` が
 * 478912/48000 = 9.977333 秒(AVFoundation が AAC の既定の遅延 2112 サンプルを引く)で、
 * 解析のバッファは 80042 サンプル(10.00525 秒)。(d) の spec は再生ヘッドを `seek(D / 2)`
 * = 4.988667 秒に置いて 5 秒の山と比べていたので、×4(649px/秒)で 7.36px ずれて見えた。
 * 等倍(`peakRects` + `waveformLaneDrawWidth`)も拡大(`windowPeaks`)も、5 秒の山を
 * 5 秒の位置に描いている。
 *
 * ## 判定するもの(AC-41-追h (a) の列挙そのまま。数値は実際の関数で実測して固定した)
 * rate 8000・全長 80042 サンプル・横軸の尺 D = 478912/48000・幅 W = 1619・
 * 1 サンプルのクリックを 40000 番目(5 秒)に置く。
 * - 等倍: `peakRects(extractPeaks(s, 2000), waveformLaneDrawWidth(1, 1619, 10.00525, D), h)` の
 *   クリックの入った矩形(x = 810.953・w = 0.812)が `positionToX(5, D, 1619)`(= 811.339)を
 *   含み、D/2 の x(= 809.5)を含まない
 * - ×4: `zoomWaveformAtAnchor` を帯の中央で 2 回かけた窓(start 3.7415 = 3D/8・
 *   seconds 2.494333 = D/4)で `peakRects(windowPeaks(s, 8000, start, seconds, 2000), 1619, h)` の
 *   クリックの矩形(x = 816.786・w = 0.810)が `windowTimeToX(5, 1619, start, seconds)`
 *   (= 816.856)を含み、D/2 の x(= 809.5)を含まない
 * - 同じ時刻: 等倍の矩形を `xToSeconds`・×4 の矩形を `windowXToTime` で時刻に戻すと、
 *   どちらも 5 秒を含む(「山が同じ時刻に乗る」の直接の表現)
 *
 * 「クリックの入った矩形」は `maxs` がクリックの振幅になっているバケット ―― バケット境界の
 * 式をテスト側で再計算せず、実物の `extractPeaks` / `windowPeaks` の分け方をそのまま使う
 * (`waveform-zoom.lanewidth.acceptance.test.ts` と同じ流儀)。
 *
 * ## 判別力(回帰の見張りとして赤になる変異・実測済み)
 * - 等倍の幅に解析尺の伸縮を掛けない(`peakRects(lane, 1619, h)`)→ 矩形は [808.69, 809.5)
 *   で 811.339 を含まない(逆に D/2 の 809.5 の直前に来る=backlog 252 の形)
 * - 拡大の窓を横軸の尺ではなく解析尺で切る(start 3·10.00525/8・seconds 10.00525/4)→
 *   矩形は [807.88, 808.69) で 816.856 を含まない
 * - `windowPeaks` の切り出しがサンプル 1 つぶん以上ずれる → バケット幅 0.81px(≈ 1.25ms =
 *   10 サンプル)なので 10 サンプル以上のずれで含まなくなる(契約の「同じ時刻」は
 *   バケット 1 つの粒度で見張る)
 *
 * ## 判定しないもの
 * - E2E の実機の測り直し= AC-41-追h (b)(`tests/e2e/specs/req41-waveform-axis-gate.e2e.ts`・
 *   オーケストレーターが回す)
 * - ビューアの配線(`AudioViewer.svelte` が `waveformLaneDrawWidth` / `windowPeaks` に
 *   解析尺と `barDuration` を渡すこと)= 要件#47 追補b (c) の配線テストが持つ
 */
import { describe, expect, it } from 'vitest';
import { WAVEFORM_BUCKETS, extractPeaks, peakRects, positionToX, xToSeconds } from './audio-waveform';
import {
	waveformLaneDrawWidth,
	waveformWindowSeconds,
	waveformZoomHeadX,
	windowPeaks,
	windowTimeToX,
	windowXToTime,
	zoomWaveformAtAnchor,
} from './waveform-zoom';

// ---------------------------------------------------------------------------
// 条件(AC-41-追h (a))
// ---------------------------------------------------------------------------

/** 解析のサンプリング周波数(`WAVEFORM_SAMPLE_RATE` と同じ 8kHz)。 */
const SAMPLE_RATE = 8000;
/** 解析のバッファ全長(サンプル)= m4a の実測。 */
const TOTAL_SAMPLES = 80042;
/** 解析尺(秒)= 10.00525。 */
const ANALYZED_SECONDS = TOTAL_SAMPLES / SAMPLE_RATE;
/** 横軸の尺(秒)= `<audio>.duration` の申告 478912/48000 = 9.977333…。 */
const AXIS_SECONDS = 478912 / 48000;
/** 帯の幅(px)。 */
const BAND_WIDTH = 1619;
/** 帯の高さ(px)。矩形の x だけを見るので値は何でもよい。 */
const BAND_HEIGHT = 56;
/** クリックのサンプル番号(5 秒)と振幅。 */
const CLICK_SAMPLE = 40000;
const CLICK_SECONDS = CLICK_SAMPLE / SAMPLE_RATE;
const CLICK_AMPLITUDE = 0.5;

/** `[x, x + w)` が `value` を含むか(矩形の左端は含み・右端は含まない)。 */
function contains(rect: { x: number; w: number }, value: number): boolean {
	return rect.x <= value && value < rect.x + rect.w;
}

/** 80042 サンプルの無音に、40000 番目へ 1 本だけクリックを立てた標本。 */
function clickSamples(): Float32Array {
	const samples = new Float32Array(TOTAL_SAMPLES);
	samples[CLICK_SAMPLE] = CLICK_AMPLITUDE;
	return samples;
}

/** クリックの振幅を持つバケットの添字(ちょうど 1 つだけ存在すること)。 */
function clickBucket(peaks: { maxs: Float32Array }): number {
	const hits: number[] = [];
	for (let i = 0; i < peaks.maxs.length; i++) {
		if (Math.abs(peaks.maxs[i] - CLICK_AMPLITUDE) < 1e-6) hits.push(i);
	}
	expect(hits, 'クリックはちょうど 1 つのバケットに属す').toHaveLength(1);
	return hits[0];
}

/** `zoomWaveformAtAnchor` を帯の中央で ×2 → ×2 とかけた窓(ボタン操作=AudioViewer の `zoomWaveformBy`)。 */
function zoomedWindowByButtons(): { zoom: number; windowStart: number; windowSeconds: number } {
	const center = BAND_WIDTH / 2;
	const once = zoomWaveformAtAnchor(1, 0, 2, center, BAND_WIDTH, AXIS_SECONDS);
	const twice = zoomWaveformAtAnchor(once.zoom, once.windowStart, once.zoom * 2, center, BAND_WIDTH, AXIS_SECONDS);
	return { ...twice, windowSeconds: waveformWindowSeconds(twice.zoom, AXIS_SECONDS) };
}

describe('AC-41-追h (a): 条件の確認(解析尺 10.00525 秒・横軸 9.977333 秒・幅 1619・クリック 5 秒)', () => {
	it('解析尺は 10.00525 秒・横軸の尺は 9.977333 秒で、解析尺のほうが 27.9ms 長い', () => {
		expect(ANALYZED_SECONDS).toBeCloseTo(10.00525, 9);
		expect(AXIS_SECONDS).toBeCloseTo(9.977333, 6);
		expect(ANALYZED_SECONDS - AXIS_SECONDS).toBeCloseTo(0.027917, 6);
	});

	it('クリックは 5 秒(40000 / 8000)で、D/2 = 4.988667 秒とは 11.3ms 違う', () => {
		expect(CLICK_SECONDS).toBe(5);
		expect(AXIS_SECONDS / 2).toBeCloseTo(4.988667, 6);
		expect(CLICK_SECONDS - AXIS_SECONDS / 2).toBeCloseTo(0.011333, 6);
	});
});

// ---------------------------------------------------------------------------
// 等倍
// ---------------------------------------------------------------------------

describe('AC-41-追h (a) 等倍: peakRects(extractPeaks, waveformLaneDrawWidth) のクリックの矩形が 5 秒のヘッドを含む', () => {
	it('レーンの描画幅は 1619 × 10.00525 / D = 1623.530', () => {
		expect(waveformLaneDrawWidth(1, BAND_WIDTH, ANALYZED_SECONDS, AXIS_SECONDS)).toBeCloseTo(1623.53, 3);
	});

	it('クリックの矩形は x = 810.953・w = 0.812(バケット 999)', () => {
		const lane = extractPeaks(clickSamples(), WAVEFORM_BUCKETS);
		const i = clickBucket(lane);
		expect(i).toBe(999);
		const laneWidth = waveformLaneDrawWidth(1, BAND_WIDTH, ANALYZED_SECONDS, AXIS_SECONDS);
		const rect = peakRects(lane, laneWidth, BAND_HEIGHT)[i];
		expect(rect.x).toBeCloseTo(810.953, 3);
		expect(rect.w).toBeCloseTo(0.812, 3);
	});

	it('positionToX(5, D, 1619) = 811.339 を矩形が含み、D/2 の x = 809.5 は含まない', () => {
		const lane = extractPeaks(clickSamples(), WAVEFORM_BUCKETS);
		const laneWidth = waveformLaneDrawWidth(1, BAND_WIDTH, ANALYZED_SECONDS, AXIS_SECONDS);
		const rect = peakRects(lane, laneWidth, BAND_HEIGHT)[clickBucket(lane)];

		const headX = positionToX(CLICK_SECONDS, AXIS_SECONDS, BAND_WIDTH);
		expect(headX).toBeCloseTo(811.339, 3);
		expect(contains(rect, headX), `矩形 [${rect.x}, ${rect.x + rect.w}) が 5 秒のヘッド ${headX} を含む`).toBe(true);

		const halfX = positionToX(AXIS_SECONDS / 2, AXIS_SECONDS, BAND_WIDTH);
		expect(halfX).toBeCloseTo(809.5, 3);
		expect(contains(rect, halfX), `矩形 [${rect.x}, ${rect.x + rect.w}) は D/2 の x ${halfX} を含まない`).toBe(false);
	});

	it('矩形を xToSeconds で時刻に戻すと 5 秒を含む(山は 5 秒に乗っている)', () => {
		const lane = extractPeaks(clickSamples(), WAVEFORM_BUCKETS);
		const laneWidth = waveformLaneDrawWidth(1, BAND_WIDTH, ANALYZED_SECONDS, AXIS_SECONDS);
		const rect = peakRects(lane, laneWidth, BAND_HEIGHT)[clickBucket(lane)];
		const from = xToSeconds(rect.x, BAND_WIDTH, AXIS_SECONDS);
		const to = xToSeconds(rect.x + rect.w, BAND_WIDTH, AXIS_SECONDS);
		expect(from).toBeLessThanOrEqual(CLICK_SECONDS);
		expect(to).toBeGreaterThan(CLICK_SECONDS);
		expect(to - from, 'バケット 1 つは約 5ms').toBeCloseTo(0.005, 3);
	});
});

// ---------------------------------------------------------------------------
// ×4
// ---------------------------------------------------------------------------

describe('AC-41-追h (a) ×4: peakRects(windowPeaks) のクリックの矩形が 5 秒のヘッドを含む', () => {
	it('中央で ×2 を 2 回かけた窓は start = 3D/8 = 3.7415・seconds = D/4 = 2.494333', () => {
		const win = zoomedWindowByButtons();
		expect(win.zoom).toBe(4);
		expect(win.windowStart).toBeCloseTo(3.7415, 6);
		expect(win.windowStart).toBeCloseTo((3 * AXIS_SECONDS) / 8, 9);
		expect(win.windowSeconds).toBeCloseTo(2.494333, 6);
		expect(win.windowSeconds).toBeCloseTo(AXIS_SECONDS / 4, 9);
	});

	it('クリックの矩形は x = 816.786・w = 0.810(バケット 1009)', () => {
		const win = zoomedWindowByButtons();
		const peaks = windowPeaks(clickSamples(), SAMPLE_RATE, win.windowStart, win.windowSeconds, WAVEFORM_BUCKETS);
		expect(peaks.maxs.length, '窓は 2000 バケット').toBe(WAVEFORM_BUCKETS);
		const i = clickBucket(peaks);
		expect(i).toBe(1009);
		const rect = peakRects(peaks, BAND_WIDTH, BAND_HEIGHT)[i];
		expect(rect.x).toBeCloseTo(816.7855, 3);
		expect(rect.w).toBeCloseTo(0.8095, 3);
	});

	it('windowTimeToX(5, 1619, start, seconds) = 816.856 を矩形が含み、D/2 の x = 809.5 は含まない', () => {
		const win = zoomedWindowByButtons();
		const peaks = windowPeaks(clickSamples(), SAMPLE_RATE, win.windowStart, win.windowSeconds, WAVEFORM_BUCKETS);
		const rect = peakRects(peaks, BAND_WIDTH, BAND_HEIGHT)[clickBucket(peaks)];

		const headX = windowTimeToX(CLICK_SECONDS, BAND_WIDTH, win.windowStart, win.windowSeconds);
		expect(headX).toBeCloseTo(816.856, 3);
		expect(
			waveformZoomHeadX(CLICK_SECONDS, win.windowStart, win.windowSeconds, BAND_WIDTH),
			'再生ヘッドの x(waveformZoomHeadX)も同じ値',
		).toBeCloseTo(headX, 9);
		expect(contains(rect, headX), `矩形 [${rect.x}, ${rect.x + rect.w}) が 5 秒のヘッド ${headX} を含む`).toBe(true);

		const halfX = windowTimeToX(AXIS_SECONDS / 2, BAND_WIDTH, win.windowStart, win.windowSeconds);
		expect(halfX).toBeCloseTo(809.5, 3);
		expect(contains(rect, halfX), `矩形 [${rect.x}, ${rect.x + rect.w}) は D/2 の x ${halfX} を含まない`).toBe(false);
		expect(headX - halfX, 'D/2 と 5 秒は ×4 で 7.36px 離れる(backlog 326 の見かけのずれ)').toBeCloseTo(7.356, 2);
	});

	it('矩形を windowXToTime で時刻に戻すと 5 秒を含む(等倍と同じ時刻に乗っている)', () => {
		const win = zoomedWindowByButtons();
		const peaks = windowPeaks(clickSamples(), SAMPLE_RATE, win.windowStart, win.windowSeconds, WAVEFORM_BUCKETS);
		const rect = peakRects(peaks, BAND_WIDTH, BAND_HEIGHT)[clickBucket(peaks)];
		const from = windowXToTime(rect.x, BAND_WIDTH, win.windowStart, win.windowSeconds);
		const to = windowXToTime(rect.x + rect.w, BAND_WIDTH, win.windowStart, win.windowSeconds);
		expect(from).toBeLessThanOrEqual(CLICK_SECONDS);
		expect(to).toBeGreaterThan(CLICK_SECONDS);
		expect(to - from, 'バケット 1 つは約 1.25ms').toBeCloseTo(0.00125, 4);
	});
});

// ---------------------------------------------------------------------------
// 等倍と ×4 の一致
// ---------------------------------------------------------------------------

describe('AC-41-追h (a) 等倍と ×4: 山の時刻が一致する(ヘッドからのずれは ±1px 以内)', () => {
	it('等倍・×4 とも「ヘッドの x − 矩形の中心」は ±1px 以内(E2E (b) の許容と同じ)', () => {
		const samples = clickSamples();

		const lane = extractPeaks(samples, WAVEFORM_BUCKETS);
		const laneWidth = waveformLaneDrawWidth(1, BAND_WIDTH, ANALYZED_SECONDS, AXIS_SECONDS);
		const rect1 = peakRects(lane, laneWidth, BAND_HEIGHT)[clickBucket(lane)];
		const head1 = positionToX(CLICK_SECONDS, AXIS_SECONDS, BAND_WIDTH);
		expect(Math.abs(head1 - (rect1.x + rect1.w / 2))).toBeLessThanOrEqual(1);

		const win = zoomedWindowByButtons();
		const peaks = windowPeaks(samples, SAMPLE_RATE, win.windowStart, win.windowSeconds, WAVEFORM_BUCKETS);
		const rect4 = peakRects(peaks, BAND_WIDTH, BAND_HEIGHT)[clickBucket(peaks)];
		const head4 = windowTimeToX(CLICK_SECONDS, BAND_WIDTH, win.windowStart, win.windowSeconds);
		expect(Math.abs(head4 - (rect4.x + rect4.w / 2))).toBeLessThanOrEqual(1);
	});

	it('等倍の矩形の中心と ×4 の矩形の中心を時刻に戻すと 1 バケット(等倍 5ms)以内で一致する', () => {
		const samples = clickSamples();

		const lane = extractPeaks(samples, WAVEFORM_BUCKETS);
		const laneWidth = waveformLaneDrawWidth(1, BAND_WIDTH, ANALYZED_SECONDS, AXIS_SECONDS);
		const rect1 = peakRects(lane, laneWidth, BAND_HEIGHT)[clickBucket(lane)];
		const t1 = xToSeconds(rect1.x + rect1.w / 2, BAND_WIDTH, AXIS_SECONDS);

		const win = zoomedWindowByButtons();
		const peaks = windowPeaks(samples, SAMPLE_RATE, win.windowStart, win.windowSeconds, WAVEFORM_BUCKETS);
		const rect4 = peakRects(peaks, BAND_WIDTH, BAND_HEIGHT)[clickBucket(peaks)];
		const t4 = windowXToTime(rect4.x + rect4.w / 2, BAND_WIDTH, win.windowStart, win.windowSeconds);

		expect(Math.abs(t1 - t4)).toBeLessThanOrEqual(0.005);
		expect(Math.abs(t1 - CLICK_SECONDS)).toBeLessThanOrEqual(0.005);
		expect(Math.abs(t4 - CLICK_SECONDS)).toBeLessThanOrEqual(0.00125);
	});
});
