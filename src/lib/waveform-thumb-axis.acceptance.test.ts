/**
 * 要件#41 追補g(backlog 236)の受け入れテスト — 純関数(AC-41-追g (b))。
 * 正本: docs/requirements/req-41.md「追補g」(契約1・2・4・5・8 と受け入れ基準 (b))。
 *
 * 「シークバーのつまみの中心と波形の横軸が、両端で最大 ±10px ずれる」の直し=波形の
 * 横軸をつまみの可動域(両端を `inset` ずつ内側)に合わせる。純関数側に足すのは
 * `src/lib/waveform-zoom.ts` の**定数1つと関数1つだけ**(契約8=既存の純関数は無改変)。
 *
 * ## AC 対応表
 * - (b)1 `SEEK_THUMB_INSET_PX` が `waveform-zoom.ts` から export され、事前実測で記帳した
 *   値 **12**(CSS px・「周回の進め方」0 (i)=2026-10-09 の実測)である
 * - (b)2 `seekThumbWindowIndicator(windowStart, windowSeconds, durationSeconds, barWidth,
 *   inset = SEEK_THUMB_INSET_PX): { left; width } | null`
 *   - 等倍でない窓 [s, s+w](s は `clampWaveformWindowStart` の後)で
 *     `left = inset + s / 尺 × (barWidth − 2 × inset)`・
 *     `left + width = inset + (s + w) / 尺 × (barWidth − 2 × inset)`
 *   - 窓が先頭(s = 0)で `left = inset`・末尾(s = 尺 − w)で `left + width = barWidth − inset`
 *   - 具体値 `(15, 30, 60, 320, 11)` → `{ left: 85.5, width: 149 }`(要件の例=inset を
 *     明示した呼び出しなので実測値 12 とは独立に成り立つ)。実測値での対応は
 *     `(15, 30, 60, 320, 12)` → `{ left: 86, width: 148 }`(本ファイルで式から計算)
 *   - 等倍(w ≥ 尺)・尺が 0 以下/非有限・w が 0 以下/非有限・barWidth が 2 × inset 以下/
 *     非有限 → null(fail-open=指標を出さない)
 *   - `inset = 0` で入力によらず `waveformWindowIndicator` と完全一致(等式契約・契約4)
 *   - `inset` を省くと `SEEK_THUMB_INSET_PX` を使う
 * - (b)3 余白の写像(契約5)=新しい関数を足さず、既存関数の clamp で端へ寄ることを固定する。
 *   横軸の幅 W・余白の x を −1・−m・W+1・W+m(m = SEEK_THUMB_INSET_PX − 1)として:
 *   - 音声の写像 `windowXToTime` は等倍で 0 / 尺・拡大中(窓 [s, s+w])で s / s+w(判断4)
 *   - 動画の写像 `waveformZoomSeekTime` は等倍・索引ありで
 *     `seekTimeForFrame(index, nearestFrame(index, 0))` / `…(index, 尺))`(=シークバーを
 *     0 / 尺 で離したときの `onScrubCommit` の着地と同じ・尺ちょうどには行かない)・
 *     索引なしで 0 / 尺。拡大中は索引ありで `…nearestFrame(index, s)` / `…(index, s+w)`・
 *     索引なしで s / s+w
 *
 * ## 確定契約(implementer はこれに従う)
 * - `export const SEEK_THUMB_INSET_PX = 12`(`waveform-zoom.ts` に1つだけ。両ビューアが import)
 * - `export function seekThumbWindowIndicator(windowStart, windowSeconds, durationSeconds,
 *   barWidth, inset = SEEK_THUMB_INSET_PX)`: 中身は
 *   `waveformWindowIndicator(windowStart, windowSeconds, durationSeconds, barWidth − 2 × inset)`
 *   の `left` に `inset` を足したもの(`width` はそのまま・null は null のまま)。
 *   `barWidth − 2 × inset` が 0 以下・非有限なら null
 * - `waveformWindowIndicator` / `windowXToTime` / `waveformZoomSeekTime` /
 *   `clampWaveformWindowStart` は無改変(契約8。(b)3 は既存の clamp だけで成り立つ)
 *
 * ## 判定しないもの(ほかのテスト・人間ゲート)
 * - 両ビューアの配線(器 `.waveform-axis`・窓指標の配線・余白のクリック・Option+ホイールの
 *   アンカー)= `VideoViewer.waveform-axis.wiring.test.ts` / `AudioViewer.waveform-axis.wiring.test.ts`
 * - 実機のつまみの中心と横軸の一致(AC (d)= `tests/e2e/specs/req41-waveform-axis-gate.e2e.ts`)
 *
 * ## 修正前の見込み(赤の理由)
 * `SEEK_THUMB_INSET_PX` と `seekThumbWindowIndicator` が未実装(import が undefined)なので
 * (b)1・(b)2 は全件赤。(b)3 は既存関数の固定だが、余白の x を `SEEK_THUMB_INSET_PX` から
 * 導くため定数が無い間は右側の x が NaN になり赤(定数が入れば実装前の写像のまま緑=
 * 契約8 の「新しい写像を足さない」をそのまま固定する)。
 *
 * ## フィクスチャ方針
 * - FrameIndex は CFR 合成(waveform-zoom.acceptance.test.ts と同じ作り・freeze で変異検出)
 * - 期待値は要件の式を本ファイル内の小さな参照実装で計算し、実装の式に依存しない
 */
import { describe, expect, it } from 'vitest';

import {
	SEEK_THUMB_INSET_PX,
	clampWaveformWindowStart,
	seekThumbWindowIndicator,
	waveformWindowIndicator,
	waveformZoomSeekTime,
	windowXToTime,
} from './waveform-zoom';
import { nearestFrame, seekTimeForFrame } from './video-frame';
import type { FrameIndex } from './video-frame';

// ---------------------------------------------------------------------------
// フィクスチャとヘルパー
// ---------------------------------------------------------------------------

/** CFR フレーム索引を合成する(times[i] = i × fpsDen / fpsNum。#39/#41/#47 と同じ作り)。 */
function cfrIndex(fpsNum: number, fpsDen: number, frameCount: number): FrameIndex {
	const times = Array.from({ length: frameCount }, (_, i) => (i * fpsDen) / fpsNum);
	const index: FrameIndex = {
		times,
		duration: (frameCount * fpsDen) / fpsNum,
		fpsNum,
		fpsDen,
		isCfr: true,
	};
	Object.freeze(index.times);
	return Object.freeze(index);
}

/** 要件の式(契約4)の参照実装: 窓 [s, s+w] の指標の left と right(= left + width)。 */
function expectedEdges(
	windowStart: number,
	windowSeconds: number,
	durationSeconds: number,
	barWidth: number,
	inset: number,
): { left: number; right: number } {
	const travel = barWidth - 2 * inset;
	const start = clampWaveformWindowStart(windowStart, windowSeconds, durationSeconds);
	return {
		left: inset + (start / durationSeconds) * travel,
		right: inset + ((start + windowSeconds) / durationSeconds) * travel,
	};
}

/**
 * シークバーを `value` で離したときの着地(`VideoViewer.svelte` の `onScrubCommit` と同じ式:
 * 索引があれば `nearestFrame` → `seekTimeForFrame`・無ければ値そのまま)。
 * (b)3 の「シークバーの端と同じ着地」の比較対象。
 */
function scrubLanding(index: FrameIndex | null, value: number): number {
	if (!index) return value;
	return seekTimeForFrame(index, nearestFrame(index, value));
}

// ---------------------------------------------------------------------------
// (b)1 — 定数
// ---------------------------------------------------------------------------

describe('AC-41-追g (b)1: SEEK_THUMB_INSET_PX(契約2)', () => {
	it('waveform-zoom.ts から export され、事前実測で記帳した 12(CSS px)である', () => {
		expect(SEEK_THUMB_INSET_PX).toBe(12);
	});
});

// ---------------------------------------------------------------------------
// (b)2 — seekThumbWindowIndicator
// ---------------------------------------------------------------------------

describe('AC-41-追g (b)2: seekThumbWindowIndicator — つまみの可動域に乗せた窓指標(契約4)', () => {
	it('要件の具体値: (15, 30, 60, 320, 11) → { left: 85.5, width: 149 }', () => {
		expect(seekThumbWindowIndicator(15, 30, 60, 320, 11)).toEqual({ left: 85.5, width: 149 });
	});

	it('実測値 12 での具体値: (15, 30, 60, 320, 12) → { left: 86, width: 148 }', () => {
		// 320 − 2 × 12 = 296。left = 12 + 15/60 × 296 = 86・width = 30/60 × 296 = 148。
		expect(seekThumbWindowIndicator(15, 30, 60, 320, 12)).toEqual({ left: 86, width: 148 });
	});

	it('inset を省くと SEEK_THUMB_INSET_PX(=12)を使う', () => {
		expect(seekThumbWindowIndicator(15, 30, 60, 320)).toStrictEqual(
			seekThumbWindowIndicator(15, 30, 60, 320, SEEK_THUMB_INSET_PX),
		);
		expect(seekThumbWindowIndicator(15, 30, 60, 320)).toEqual({ left: 86, width: 148 });
	});

	it('式: left = inset + s/尺 × (B − 2·inset)・left + width = inset + (s+w)/尺 × (B − 2·inset)', () => {
		const cases: [number, number, number, number, number][] = [
			[15, 30, 60, 320, 12],
			[0, 30, 60, 320, 12],
			[30, 30, 60, 320, 12],
			[7.5, 15, 60, 320, 12],
			[25, 25, 100, 400, 11],
			[3, 0.25, 10, 640, 12],
			[12.3, 4.7, 61.9, 333, 9.5],
		];
		for (const [s, w, d, b, inset] of cases) {
			const actual = seekThumbWindowIndicator(s, w, d, b, inset);
			expect(actual, `(${s}, ${w}, ${d}, ${b}, ${inset})`).not.toBeNull();
			const { left, right } = expectedEdges(s, w, d, b, inset);
			expect(actual!.left).toBeCloseTo(left, 9);
			expect(actual!.left + actual!.width).toBeCloseTo(right, 9);
			expect(actual!.width).toBeCloseTo((w / d) * (b - 2 * inset), 9);
		}
	});

	it('両端: 窓が先頭で left = inset・窓が末尾で left + width = barWidth − inset', () => {
		const first = seekThumbWindowIndicator(0, 30, 60, 320, 12);
		expect(first).not.toBeNull();
		expect(first!.left).toBe(12);

		const last = seekThumbWindowIndicator(30, 30, 60, 320, 12);
		expect(last).not.toBeNull();
		expect(last!.left + last!.width).toBeCloseTo(320 - 12, 9);

		// 明示 inset でも同じ形(要件の例の 11)。
		const first11 = seekThumbWindowIndicator(0, 25, 100, 400, 11);
		expect(first11!.left).toBe(11);
		const last11 = seekThumbWindowIndicator(75, 25, 100, 400, 11);
		expect(last11!.left + last11!.width).toBeCloseTo(400 - 11, 9);
	});

	it('窓の開始は clampWaveformWindowStart の後(範囲外の s は端の窓として写す)', () => {
		expect(seekThumbWindowIndicator(-10, 30, 60, 320, 12)).toStrictEqual(
			seekThumbWindowIndicator(0, 30, 60, 320, 12),
		);
		expect(seekThumbWindowIndicator(100, 30, 60, 320, 12)).toStrictEqual(
			seekThumbWindowIndicator(30, 30, 60, 320, 12),
		);
		expect(seekThumbWindowIndicator(Number.NaN, 30, 60, 320, 12)).toStrictEqual(
			seekThumbWindowIndicator(0, 30, 60, 320, 12),
		);
	});

	it('等倍(w ≥ 尺)は null(指標を出さない)', () => {
		expect(seekThumbWindowIndicator(0, 60, 60, 320, 12)).toBeNull();
		expect(seekThumbWindowIndicator(0, 90, 60, 320, 12)).toBeNull();
		expect(seekThumbWindowIndicator(0, 60, 60, 320)).toBeNull();
	});

	it('尺が 0 以下/非有限・w が 0 以下/非有限は null', () => {
		for (const d of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(seekThumbWindowIndicator(15, 30, d, 320, 12), `尺=${d}`).toBeNull();
		}
		for (const w of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(seekThumbWindowIndicator(15, w, 60, 320, 12), `w=${w}`).toBeNull();
		}
	});

	it('barWidth が 2 × inset 以下/非有限は null(可動域が無い=fail-open)', () => {
		for (const b of [24, 23, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(seekThumbWindowIndicator(15, 30, 60, b, 12), `barWidth=${b}`).toBeNull();
		}
		// inset を省いても同じ境界(= 2 × SEEK_THUMB_INSET_PX = 24)。
		expect(seekThumbWindowIndicator(15, 30, 60, 24)).toBeNull();
		// 境界のすぐ上は出す(可動域 0.5px)。
		const justAbove = seekThumbWindowIndicator(15, 30, 60, 24.5, 12);
		expect(justAbove).not.toBeNull();
		expect(justAbove!.left).toBeCloseTo(12 + 0.25 * 0.5, 9);
		expect(justAbove!.width).toBeCloseTo(0.5 * 0.5, 9);
		// 明示 inset 11 では 22 が境界。
		expect(seekThumbWindowIndicator(15, 30, 60, 22, 11)).toBeNull();
		expect(seekThumbWindowIndicator(15, 30, 60, 22.5, 11)).not.toBeNull();
	});

	it('等式契約: inset = 0 では入力によらず waveformWindowIndicator と完全一致', () => {
		const inputs: [number, number, number, number][] = [
			[25, 25, 100, 400],
			[0, 50, 100, 400],
			[75, 25, 100, 400],
			[15, 30, 60, 320],
			[-10, 30, 60, 320],
			[100, 30, 60, 320],
			[Number.NaN, 30, 60, 320],
			[0, 100, 100, 400],
			[0, 120, 100, 400],
			[25, 25, 0, 400],
			[25, 25, Number.NaN, 400],
			[25, 25, 100, 0],
			[25, 25, 100, Number.NaN],
			[25, 25, 100, Number.POSITIVE_INFINITY],
			[25, 0, 100, 400],
			[25, Number.NaN, 100, 400],
			[12.3, 4.7, 61.9, 333],
		];
		for (const [s, w, d, b] of inputs) {
			expect(seekThumbWindowIndicator(s, w, d, b, 0), `(${s}, ${w}, ${d}, ${b})`).toStrictEqual(
				waveformWindowIndicator(s, w, d, b),
			);
		}
	});
});

// ---------------------------------------------------------------------------
// (b)3 — 余白の写像(既存関数の clamp で端へ寄ることの固定・契約5)
// ---------------------------------------------------------------------------

describe('AC-41-追g (b)3: 余白の x は既存の写像の clamp で端へ寄る(契約5・新しい写像を足さない)', () => {
	/** 横軸の幅(px)。 */
	const W = 320;
	/** 余白の幅(px)=器の left/right(契約2)。 */
	const m = SEEK_THUMB_INSET_PX - 1;
	/** 尺 60 秒。 */
	const D = 60;
	/** 30fps・60 秒(1800 フレーム)の CFR 索引。freeze 済み=写像が索引を書き換えないことも検出。 */
	const INDEX = cfrIndex(30, 1, 1800);
	const leftMargin = () => [-1, -m];
	const rightMargin = () => [W + 1, W + m];

	it('前提: 余白の x が有限(m = SEEK_THUMB_INSET_PX − 1)', () => {
		expect(Number.isFinite(m)).toBe(true);
		expect(m).toBeGreaterThan(0);
	});

	it('音声(windowXToTime): 等倍の左の余白 → 0・右の余白 → 尺', () => {
		for (const x of leftMargin()) expect(windowXToTime(x, W, 0, D), `x=${x}`).toBe(0);
		for (const x of rightMargin()) expect(windowXToTime(x, W, 0, D), `x=${x}`).toBe(D);
	});

	it('動画(waveformZoomSeekTime)・等倍・索引あり: 先頭/最終フレームの中=シークバーを 0 / 尺 で離した着地と同じ', () => {
		const first = seekTimeForFrame(INDEX, nearestFrame(INDEX, 0));
		const last = seekTimeForFrame(INDEX, nearestFrame(INDEX, D));
		for (const x of leftMargin()) {
			expect(waveformZoomSeekTime(x, W, 0, D, INDEX), `x=${x}`).toBe(first);
			expect(waveformZoomSeekTime(x, W, 0, D, INDEX), `x=${x}`).toBe(scrubLanding(INDEX, 0));
		}
		for (const x of rightMargin()) {
			expect(waveformZoomSeekTime(x, W, 0, D, INDEX), `x=${x}`).toBe(last);
			expect(waveformZoomSeekTime(x, W, 0, D, INDEX), `x=${x}`).toBe(scrubLanding(INDEX, D));
		}
		// 吸着先はフレームの中=先頭は 0 より後ろ・末尾は尺ちょうどには行かない。
		expect(first).toBeGreaterThan(0);
		expect(last).toBeLessThan(D);
	});

	it('動画(waveformZoomSeekTime)・等倍・索引なし: 0 / 尺(シークバーの端と同じ・fail-open)', () => {
		for (const x of leftMargin()) expect(waveformZoomSeekTime(x, W, 0, D, null), `x=${x}`).toBe(0);
		for (const x of rightMargin()) expect(waveformZoomSeekTime(x, W, 0, D, null), `x=${x}`).toBe(D);
		expect(waveformZoomSeekTime(-1, W, 0, D, null)).toBe(scrubLanding(null, 0));
		expect(waveformZoomSeekTime(W + 1, W, 0, D, null)).toBe(scrubLanding(null, D));
	});

	it('拡大中(窓 [15, 45])の余白 → 窓の端(判断4): 音声は s / s+w', () => {
		const s = 15;
		const w = 30;
		for (const x of leftMargin()) expect(windowXToTime(x, W, s, w), `x=${x}`).toBe(s);
		for (const x of rightMargin()) expect(windowXToTime(x, W, s, w), `x=${x}`).toBe(s + w);
	});

	it('拡大中(窓 [15, 45])の余白 → 窓の端(判断4): 動画は索引ありで吸着・索引なしで s / s+w', () => {
		const s = 15;
		const w = 30;
		const atStart = seekTimeForFrame(INDEX, nearestFrame(INDEX, s));
		const atEnd = seekTimeForFrame(INDEX, nearestFrame(INDEX, s + w));
		for (const x of leftMargin()) {
			expect(waveformZoomSeekTime(x, W, s, w, INDEX), `x=${x}`).toBe(atStart);
			expect(waveformZoomSeekTime(x, W, s, w, null), `x=${x}`).toBe(s);
		}
		for (const x of rightMargin()) {
			expect(waveformZoomSeekTime(x, W, s, w, INDEX), `x=${x}`).toBe(atEnd);
			expect(waveformZoomSeekTime(x, W, s, w, null), `x=${x}`).toBe(s + w);
		}
	});

	it('横軸の端の 1px 内側と 1px 外側で着地が飛ばない(判断4=写像を余白へ延ばしただけ)', () => {
		// 等倍: x = 1 と x = −1 の差は 1px ぶんの時刻(D / W)以内。
		expect(Math.abs(windowXToTime(1, W, 0, D) - windowXToTime(-1, W, 0, D))).toBeLessThanOrEqual(D / W + 1e-9);
		expect(Math.abs(windowXToTime(W - 1, W, 0, D) - windowXToTime(W + 1, W, 0, D))).toBeLessThanOrEqual(D / W + 1e-9);
		// 拡大中(窓 30 秒): 1px = 30 / 320 秒。
		expect(Math.abs(windowXToTime(1, W, 15, 30) - windowXToTime(-1, W, 15, 30))).toBeLessThanOrEqual(30 / W + 1e-9);
		expect(Math.abs(windowXToTime(W - 1, W, 15, 30) - windowXToTime(W + 1, W, 15, 30))).toBeLessThanOrEqual(30 / W + 1e-9);
	});
});
