/**
 * 要件#47 追補b(2026-10-07・backlog 252)の受け入れテスト AC-47-追b (a)(b)。
 * 「等倍の波形の帯の山が時間に比例して手前に寄る」の修正を純関数で機械判定する。
 *
 * ## 背景(req-47.md 追補b「発見」)
 * 等倍の帯は解析で作ったレーン(`result.lanes`=decode したバッファ全体を 2000 バケットに
 * 割ったもの)を帯の幅いっぱいに描く。バッファの尺(末尾の詰め物込み=10.025 秒)が
 * 横軸の尺(`barDuration`=10.0 秒)より長いと、時刻 t の山が `t / 10.025 × 幅` に描かれて
 * 手前に寄る(8 秒で −1.8px)。拡大表示は窓を sampleRate で時刻に直すのでずれない。
 *
 * ## 確定契約(契約(追補b)1=implementer はこれに従う)
 * `src/lib/waveform-zoom.ts` に新設:
 *   `export function waveformLaneDrawWidth(zoom: number, width: number,
 *     analyzedSeconds: number | null | undefined, axisSeconds: number): number`
 * - `zoom <= 1` かつ `analyzedSeconds`・`axisSeconds` がともに正の有限数 →
 *   `width × analyzedSeconds / axisSeconds`
 * - それ以外(拡大中 `zoom > 1`・どちらかが null/undefined/0/負/非有限・`width` が正の
 *   有限数でない)→ `width` をそのまま返す(`width` が壊れていても 0 に倒さず `width` のまま)
 * - throw しない(waveform-zoom.ts の家風=fail-open)
 *
 * ## 判定するもの
 * - (a) 純関数の値: req-47.md AC-47-追b (a) の列挙そのまま+契約1 から従う境界
 *   (`width` が正の有限数でないときは `width` のまま・`zoom` が 1 未満は等倍扱い)
 * - (b) 時刻の一致: 等倍・`analyzedSeconds = 10.025`・`axisSeconds = 10`・幅 1000 のとき、
 *   `peakRects` に 2000 バケットのレーンと `waveformLaneDrawWidth` の幅を渡すと、時刻 t
 *   (2・5・8 秒)のサンプルを含むバケットの矩形の x が `positionToX(t, 10, 1000)` と
 *   1px 以内で一致する(バケット幅は約 0.5px)。同じ条件で帯の幅 1000 をそのまま渡すと
 *   8 秒で 1.5px 以上ずれる(修正前の再現)
 *
 * ## (b) の合成レーン
 * 8kHz × 10.025 秒 = 80,200 サンプルの無音に、時刻 t のサンプル(`round(t × 8000)`)へ
 * 1本だけ振幅の違う尖り(2 秒=0.25・5 秒=0.5・8 秒=0.75)を立て、`extractPeaks` で
 * 2000 バケットにする。「時刻 t のサンプルを含むバケット」は `maxs` がその振幅に
 * なっているバケット ―― バケット境界の式をテスト側で再計算せず、実物の
 * `extractPeaks` の分け方をそのまま使う(境界が変われば追従する)。
 *
 * ## 想定される赤(実装前)
 * `waveformLaneDrawWidth` が `waveform-zoom.ts` に無い → import が undefined になり
 * 呼び出しで TypeError。(a)(b) の全ケースが赤。(b) の「修正前の再現」も同じケースの中で
 * 修正後の幅との対比として断言するので、実装前は赤。
 *
 * ## 判定しないもの
 * - 帯の配線(`VideoViewer.svelte` / `AudioViewer.svelte` で `peakRects` の第2引数が
 *   この幅になること・描画 effect が解析尺と横軸の尺を読むこと)= AC-47-追b (c)
 *   `src/components/waveform-lane-width.wiring.test.ts`
 * - 実機での山と再生ヘッドの一致(gate-41 の測り方で任意確認)
 */
import { describe, expect, it } from 'vitest';
import { WAVEFORM_BUCKETS, extractPeaks, peakRects, positionToX } from './audio-waveform';
import { waveformLaneDrawWidth } from './waveform-zoom';

// ---------------------------------------------------------------------------
// (a) 純関数の値
// ---------------------------------------------------------------------------

describe('AC-47-追b (a): waveformLaneDrawWidth ―― 等倍では帯の幅を解析尺/横軸の尺で伸縮する', () => {
	it('(1, 1000, 10.025, 10) は 1002.5(解析尺が長い=末尾の詰め物ぶん右へ伸びる)', () => {
		expect(waveformLaneDrawWidth(1, 1000, 10.025, 10)).toBeCloseTo(1002.5, 9);
	});

	it('(1, 1000, 9.5, 10) は 950(解析尺が短い=右端に空きが残る)', () => {
		expect(waveformLaneDrawWidth(1, 1000, 9.5, 10)).toBeCloseTo(950, 9);
	});

	it('(1, 1000, 10, 10) は 1000(一致しているときは帯の幅そのまま)', () => {
		expect(waveformLaneDrawWidth(1, 1000, 10, 10)).toBe(1000);
	});

	it('(2, 1000, 10.025, 10) は 1000(拡大中は窓が時刻を決めるので帯の幅のまま)', () => {
		expect(waveformLaneDrawWidth(2, 1000, 10.025, 10)).toBe(1000);
	});

	it('zoom が 1 をわずかに超えても拡大中扱い(1.0001 → 1000)', () => {
		expect(waveformLaneDrawWidth(1.0001, 1000, 10.025, 10)).toBe(1000);
	});

	it('(1, 1000, null, 10) は 1000(解析尺が不明)', () => {
		expect(waveformLaneDrawWidth(1, 1000, null, 10)).toBe(1000);
	});

	it('(1, 1000, undefined, 10) は 1000(解析尺が省略=既存の ready リテラル)', () => {
		expect(waveformLaneDrawWidth(1, 1000, undefined, 10)).toBe(1000);
	});

	it('(1, 1000, 0, 10) は 1000(解析尺 0)', () => {
		expect(waveformLaneDrawWidth(1, 1000, 0, 10)).toBe(1000);
	});

	it('(1, 1000, 10, 0) は 1000(横軸の尺 0)', () => {
		expect(waveformLaneDrawWidth(1, 1000, 10, 0)).toBe(1000);
	});

	it('(1, 1000, NaN, 10) は 1000(解析尺が非有限)', () => {
		expect(waveformLaneDrawWidth(1, 1000, NaN, 10)).toBe(1000);
	});

	it('(1, 1000, 10, Infinity) は 1000(横軸の尺が非有限)', () => {
		expect(waveformLaneDrawWidth(1, 1000, 10, Number.POSITIVE_INFINITY)).toBe(1000);
	});

	it('負の尺は「正の有限数」ではないので帯の幅のまま((1, 1000, -10.025, 10) / (1, 1000, 10, -10))', () => {
		expect(waveformLaneDrawWidth(1, 1000, -10.025, 10)).toBe(1000);
		expect(waveformLaneDrawWidth(1, 1000, 10, -10)).toBe(1000);
	});

	it('zoom が 1 未満(0.5)は等倍と同じ扱い → 1002.5', () => {
		expect(waveformLaneDrawWidth(0.5, 1000, 10.025, 10)).toBeCloseTo(1002.5, 9);
	});

	it('width が正の有限数でなければ 0 ではなく width をそのまま返す(契約1: 0 / 負 / NaN / Infinity)', () => {
		expect(waveformLaneDrawWidth(1, 0, 10.025, 10)).toBe(0);
		expect(waveformLaneDrawWidth(1, -320, 10.025, 10)).toBe(-320);
		expect(waveformLaneDrawWidth(1, NaN, 10.025, 10)).toBeNaN();
		expect(waveformLaneDrawWidth(1, Number.POSITIVE_INFINITY, 10.025, 10)).toBe(
			Number.POSITIVE_INFINITY,
		);
	});

	it('zoom が NaN のときは `zoom <= 1` が偽なので帯の幅のまま(契約1 の字義)', () => {
		expect(waveformLaneDrawWidth(NaN, 1000, 10.025, 10)).toBe(1000);
	});

	it('どの退化入力でも throw しない(fail-open)', () => {
		const inputs: [number, number, number | null | undefined, number][] = [
			[1, 1000, null, 10],
			[1, 1000, undefined, 10],
			[1, 1000, NaN, NaN],
			[NaN, NaN, NaN, NaN],
			[Number.NEGATIVE_INFINITY, 0, 0, 0],
			[1, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
		];
		for (const [zoom, width, analyzed, axis] of inputs) {
			expect(() => waveformLaneDrawWidth(zoom, width, analyzed, axis)).not.toThrow();
		}
	});
});

// ---------------------------------------------------------------------------
// (b) 時刻の一致(合成レーン × peakRects × positionToX)
// ---------------------------------------------------------------------------

/** 解析のサンプリング周波数(audio-waveform.ts の `WAVEFORM_SAMPLE_RATE` と同じ 8kHz)。 */
const SAMPLE_RATE = 8000;
/** 解析尺(末尾の詰め物込み=backlog 252 の実測値)。 */
const ANALYZED_SECONDS = 10.025;
/** 横軸の尺(`barDuration`=`<video>` の申告尺)。 */
const AXIS_SECONDS = 10;
/** 帯の幅(px)。 */
const BAND_WIDTH = 1000;
/** 帯の高さ(px)。矩形の x だけを見るので値は何でもよい。 */
const BAND_HEIGHT = 56;

/** 時刻 t(秒)→ 尖りの振幅。振幅でバケットを見分ける(バケット境界の式を再計算しない)。 */
const SPIKES: ReadonlyArray<{ seconds: number; amplitude: number }> = [
	{ seconds: 2, amplitude: 0.25 },
	{ seconds: 5, amplitude: 0.5 },
	{ seconds: 8, amplitude: 0.75 },
];

/** 8kHz × 10.025 秒の無音に、各時刻のサンプルへ尖りを1本ずつ立てたレーン(2000 バケット)。 */
function syntheticLane() {
	const total = Math.round(ANALYZED_SECONDS * SAMPLE_RATE); // 80,200
	const samples = new Float32Array(total);
	for (const spike of SPIKES) {
		samples[Math.round(spike.seconds * SAMPLE_RATE)] = spike.amplitude;
	}
	const lane = extractPeaks(samples, WAVEFORM_BUCKETS);
	expect(lane.maxs.length, 'レーンは 2000 バケット').toBe(WAVEFORM_BUCKETS);
	return lane;
}

/** 振幅 `amplitude` の尖りを含むバケットの添字(ちょうど1つだけ存在すること)。 */
function bucketOf(lane: { maxs: Float32Array }, amplitude: number): number {
	const hits: number[] = [];
	for (let i = 0; i < lane.maxs.length; i++) {
		if (Math.abs(lane.maxs[i] - amplitude) < 1e-6) hits.push(i);
	}
	expect(hits, `振幅 ${amplitude} の尖りはちょうど1つのバケットに属す`).toHaveLength(1);
	return hits[0];
}

describe('AC-47-追b (b): 等倍で解析尺 10.025 秒・横軸 10 秒・幅 1000 のとき、山の x が positionToX と一致する', () => {
	it('バケット幅は約 0.5px(2000 バケットで 1000px)', () => {
		expect(BAND_WIDTH / WAVEFORM_BUCKETS).toBeCloseTo(0.5, 9);
	});

	for (const spike of SPIKES) {
		it(`時刻 ${spike.seconds} 秒のサンプルを含むバケットの矩形の x は positionToX(${spike.seconds}, 10, 1000) と 1px 以内`, () => {
			const lane = syntheticLane();
			const laneWidth = waveformLaneDrawWidth(1, BAND_WIDTH, ANALYZED_SECONDS, AXIS_SECONDS);
			const rects = peakRects(lane, laneWidth, BAND_HEIGHT);
			expect(rects, '矩形はバケットと同数').toHaveLength(WAVEFORM_BUCKETS);

			const i = bucketOf(lane, spike.amplitude);
			const expectedX = positionToX(spike.seconds, AXIS_SECONDS, BAND_WIDTH);
			expect(expectedX, '横軸の写像(再生ヘッドの位置)').toBeCloseTo(spike.seconds * 100, 9);
			expect(
				Math.abs(rects[i].x - expectedX),
				`時刻 ${spike.seconds} 秒の山の x(${rects[i].x})が再生ヘッド(${expectedX})と 1px 以内`,
			).toBeLessThanOrEqual(1);
		});
	}

	it('修正前の再現: 帯の幅 1000 をそのまま peakRects に渡すと 8 秒で 1.5px 以上手前に寄る ―― waveformLaneDrawWidth の幅なら 1px 以内', () => {
		const lane = syntheticLane();
		const spike = SPIKES[2];
		expect(spike.seconds).toBe(8);
		const i = bucketOf(lane, spike.amplitude);
		const headX = positionToX(spike.seconds, AXIS_SECONDS, BAND_WIDTH);

		// 修正前: 帯の幅いっぱいに 2000 バケットを割る → 山が t / 10.025 × 幅 に描かれる。
		const before = peakRects(lane, BAND_WIDTH, BAND_HEIGHT)[i].x;
		expect(headX - before, '修正前は 8 秒の山が再生ヘッドより 1.5px 以上手前(左)に寄る').toBeGreaterThanOrEqual(
			1.5,
		);

		// 修正後: 解析尺/横軸の尺で伸ばした幅 → 山が時刻に合う。
		const laneWidth = waveformLaneDrawWidth(1, BAND_WIDTH, ANALYZED_SECONDS, AXIS_SECONDS);
		expect(laneWidth, '幅は 1000 × 10.025 / 10').toBeCloseTo(1002.5, 9);
		const after = peakRects(lane, laneWidth, BAND_HEIGHT)[i].x;
		expect(Math.abs(after - headX), '修正後は 8 秒の山が再生ヘッドと 1px 以内').toBeLessThanOrEqual(1);
		expect(Math.abs(after - headX), '修正後のずれは修正前より小さい').toBeLessThan(headX - before);
	});

	it('解析尺の方が長いときは末尾(詰め物)の矩形が帯の右端 1000px の外に出る(描かれない側)', () => {
		const lane = syntheticLane();
		const laneWidth = waveformLaneDrawWidth(1, BAND_WIDTH, ANALYZED_SECONDS, AXIS_SECONDS);
		const rects = peakRects(lane, laneWidth, BAND_HEIGHT);
		const last = rects[rects.length - 1];
		expect(last.x + last.w, '最後のバケットの右端はレーンの幅 1002.5').toBeCloseTo(laneWidth, 6);
		expect(last.x, '最後のバケットは帯の右端の外').toBeGreaterThanOrEqual(BAND_WIDTH);
	});
});
