/**
 * 要件#40 追補10(backlog 232・Issue #602)の受け入れテスト AC-40-追10
 * 「素材側の参考フレームの切り捨てに、丸めのぶんの手前の許容を持たせる」
 *
 * 契約の正本: docs/requirements/req-40.md「### 追補10(2026-10-20)」
 *
 * ## 背景
 * `sourceFrameAt(fps, inputSec)` は素材の時刻を 1e-6 秒の刻み(`SECOND_SCALE`)に丸めてから
 * `floor(刻み × num / (den × 1e6))` で番号にする。フレーム n の境目 `n × den / num` 秒は 24 / 30 /
 * 29.97 / 59.94 fps では割り切れず、刻みに丸めると 1/3 の境目で**切り捨て側**(真の境目より手前)に
 * 落ちる。そこへ `sourceTimeAt` の `from.sec`(切り捨て側)と `start.sec`(切り上げ側)の丸めが重なると、
 * 素材の時刻は境目より最大 1 刻み手前になり、参考フレームが 1 小さく出る(人間ゲート12 の −1 の偏り)。
 *
 * ## 契約(追補10)
 * 1. フレーム n の境目を 1e-6 秒の刻みに丸めた値を r_n とし、素材の時刻の刻み k が `k ≥ r_n − 1` なら
 *    n 以上とみなす(整数で比べる)。「切り捨ての前に 1 刻みを足す」では、境目が丸めで切り捨てられた側の
 *    `r_n − 1` を拾えない(29.97fps n=2: 境目 0.0667333…→ r=66733・r−1 を 1 刻み足しても 66733 ×
 *    30000 / 1001e6 = 1.99999 → 1)
 * 2. −2 の偏りは丸めでは説明できない= backlog 229(区間の表引き)によるもので追補3 で解消済み。
 *    追補10 の対象は −1 の偏りだけ(このファイルの範囲外)
 * 3. 不変: フレーム番号の数え方(0 始まり・`fps` の有理数)・`null` を返す場合・区間の判定
 *
 * ## 本ファイルの判定範囲(AC-40-追10=純関数のテスト)
 * - (a) 24・25・30・30000/1001・60000/1001 fps で、各フレームの境目の時刻(`n × den / num`)・それを
 *   1e-6 秒に丸めた時刻(r_n / 1e6)・その 1 刻み手前((r_n − 1) / 1e6)を渡すと `n` が返る
 * - (b) フレームの中ほど(1/4・1/2・3/4)の時刻は今までどおり `n`
 * - (c) r_n − 2 以下((r_n − 2) / 1e6・(r_n − 3) / 1e6)は `n − 1`(許容は 1 刻みだけ)
 * - 不変(契約 3): 0 秒は 0・`fps` が null なら null・1 時間級の大きな n でも (a)(c) が成り立つ
 * - フィクスチャの前提: 25fps 以外では境目の丸めに切り上げ・切り捨ての両方があること(切り捨て側の
 *   r_n − 1 が「1 刻み足す」では拾えない側= 空振りの緑を防ぐ)
 *
 * n は 0〜N(fps ごとに全数)+ 1 時間級の疎な n。刻みへの丸めは `Math.round(sec × 1e6)`(`sourceFrameAt`
 * と同じ粒度)で、テスト側は秒の値だけを渡す(整数比較の仕方は実装裁量)。
 *
 * ## 既存 acceptance との関係(AC (d))
 * `video-provenance.acceptance.test.ts`(#40 / #46)ほかの既存テストは書き換えない。`sourceFrameAt` の
 * 既存ケース(NTSC 100.1 秒 = 3000 フレーム目ちょうど など)は境目・丸めた時刻の形なので、本契約でも同じ値。
 *
 * ## 赤になる理由(実装前)
 * 現行は `floor(k × num / (den × 1e6))` で許容が無い: (a)-1・(a)-2 は境目が切り捨て側に丸まる n(24 / 30 /
 * 29.97 / 59.94 fps の 1/3。25fps は 0)で `n − 1` になり赤、(a)-3(r_n − 1)は 5 fps の全 n で `n − 1` になり
 * 赤。(b)・(c)・不変の各件は今の振る舞いの固定(退行防止)で最初から緑。
 */

import { describe, expect, it } from 'vitest';

import { sourceFrameAt } from './video-provenance';
import type { Rational } from './video-provenance';

/** 刻みの粒度(`sourceFrameAt` の `SECOND_SCALE` と同じ= 1e-6 秒)。 */
const SCALE = 1e6;

/** 全数で確かめる n の上限(60000/1001 fps で約 333 秒・30 fps で約 11 分)。 */
const DENSE_N = 20000;

/** 1 時間級の疎な n(60000/1001 fps で 2e6 ≈ 9.3 時間。`k × num` が倍精度の整数の範囲に収まること)。 */
const SPARSE_N = [100_000, 1_000_000, 2_000_000];

const FPS_CASES: { label: string; fps: Rational }[] = [
	{ label: '24 fps', fps: { num: 24, den: 1 } },
	{ label: '25 fps', fps: { num: 25, den: 1 } },
	{ label: '30 fps', fps: { num: 30, den: 1 } },
	{ label: '30000/1001 fps(29.97)', fps: { num: 30000, den: 1001 } },
	{ label: '60000/1001 fps(59.94)', fps: { num: 60000, den: 1001 } },
];

/** フレーム n の境目の時刻(秒・倍精度)。 */
function boundarySec(fps: Rational, n: number): number {
	return (n * fps.den) / fps.num;
}

/** 境目を 1e-6 秒の刻みに丸めた整数 r_n。 */
function boundaryTicks(fps: Rational, n: number): number {
	return Math.round(boundarySec(fps, n) * SCALE);
}

/** 刻み k の秒。 */
function secOfTicks(k: number): number {
	return k / SCALE;
}

/** 全数の n と疎な n を順に。 */
function* sampleN(): Generator<number> {
	for (let n = 0; n <= DENSE_N; n++) yield n;
	for (const n of SPARSE_N) yield n;
}

describe('AC-40-追10: 参考フレームの切り捨てに丸めのぶんの手前の許容を持たせる(要件#40 追補10・backlog 232)', () => {
	it('フィクスチャの前提: 25fps 以外では境目の丸めに切り上げ・切り捨ての両方が起きる(切り捨て側が r_n − 1 の難しい側)', () => {
		for (const { label, fps } of FPS_CASES) {
			let roundedDown = 0;
			let roundedUp = 0;
			let exact = 0;
			for (let n = 0; n <= DENSE_N; n++) {
				const trueTicks = boundarySec(fps, n) * SCALE;
				const r = boundaryTicks(fps, n);
				// 丸めの差は半刻み以内。
				const diff = r - trueTicks;
				expect(Math.abs(diff), `${label} n=${n}`).toBeLessThanOrEqual(0.5);
				// 端数は 0・1/3・2/3 なので、倍精度の揺れ(1e-11 程度)を「ちょうど」に含める。
				if (diff < -1e-6) roundedDown++;
				else if (diff > 1e-6) roundedUp++;
				else exact++;
			}
			if (fps.num === 25) {
				expect(exact, `${label} は境目が刻みで割り切れる`).toBe(DENSE_N + 1);
			} else {
				// 端数は 0・1/3・2/3 を巡るので、切り捨て・切り上げが各およそ 1/3。倍精度の揺れを見込んで下限は 1/4。
				expect(roundedDown, `${label} で切り捨て側に丸まる境目が多数ある`).toBeGreaterThan(DENSE_N / 4);
				expect(roundedUp, `${label} で切り上げ側に丸まる境目が多数ある`).toBeGreaterThan(DENSE_N / 4);
			}
			// 隣り合う境目は 1 刻みよりはるかに離れている(許容が隣のフレームへ届かない前提)。
			for (let n = 0; n < DENSE_N; n++) {
				expect(boundaryTicks(fps, n + 1) - boundaryTicks(fps, n), `${label} n=${n}`).toBeGreaterThan(
					16000,
				);
			}
		}
	});

	describe.each(FPS_CASES)('$label', ({ label, fps }) => {
		// -------------------------------------------------------------------
		// (a) 境目の時刻・丸めた時刻・その 1 刻み手前 → n
		// -------------------------------------------------------------------

		it('AC-40-追10 (a)-1: 各フレームの境目の時刻(n × den / num)は n を返す', () => {
			for (const n of sampleN()) {
				expect(sourceFrameAt(fps, boundarySec(fps, n)), `${label} n=${n}`).toBe(n);
			}
		});

		it('AC-40-追10 (a)-2: 境目を 1e-6 秒に丸めた時刻(r_n)は n を返す', () => {
			for (const n of sampleN()) {
				const r = boundaryTicks(fps, n);
				expect(sourceFrameAt(fps, secOfTicks(r)), `${label} n=${n} r=${r}`).toBe(n);
			}
		});

		it('AC-40-追10 (a)-3: 丸めた境目の 1 刻み手前(r_n − 1)は n を返す', () => {
			for (const n of sampleN()) {
				if (n === 0) continue; // r_0 − 1 は負の時刻= 素材の時刻として現れない(clamp 済み)
				const r = boundaryTicks(fps, n);
				expect(sourceFrameAt(fps, secOfTicks(r - 1)), `${label} n=${n} r−1=${r - 1}`).toBe(n);
			}
		});

		// -------------------------------------------------------------------
		// (b) フレームの中ほどは今までどおり n
		// -------------------------------------------------------------------

		it('AC-40-追10 (b): フレームの中ほど(1/4・1/2・3/4)の時刻は今までどおり n を返す', () => {
			for (const n of sampleN()) {
				for (const fraction of [0.25, 0.5, 0.75]) {
					const t = ((n + fraction) * fps.den) / fps.num;
					expect(sourceFrameAt(fps, t), `${label} n=${n} +${fraction}`).toBe(n);
				}
			}
		});

		// -------------------------------------------------------------------
		// (c) r_n − 2 以下は n − 1(許容は 1 刻みだけ)
		// -------------------------------------------------------------------

		it('AC-40-追10 (c): 丸めた境目の 2 刻み手前(r_n − 2)と 3 刻み手前(r_n − 3)は n − 1 を返す', () => {
			for (const n of sampleN()) {
				if (n === 0) continue; // 0 より前の時刻は素材の時刻として現れない
				const r = boundaryTicks(fps, n);
				expect(sourceFrameAt(fps, secOfTicks(r - 2)), `${label} n=${n} r−2=${r - 2}`).toBe(n - 1);
				expect(sourceFrameAt(fps, secOfTicks(r - 3)), `${label} n=${n} r−3=${r - 3}`).toBe(n - 1);
			}
		});
	});

	// -----------------------------------------------------------------------
	// 不変(契約 3): 0 始まり・fps null は null
	// -----------------------------------------------------------------------

	it('契約 3(不変): 0 秒は 0 フレーム(0 始まり)で、どの fps でも同じ', () => {
		for (const { label, fps } of FPS_CASES) {
			expect(sourceFrameAt(fps, 0), label).toBe(0);
		}
	});

	it('契約 3(不変): fps が null(VFR)なら null を返す(境目・丸めた時刻・1 刻み手前でも)', () => {
		expect(sourceFrameAt(null, 0)).toBeNull();
		expect(sourceFrameAt(null, 1.0333)).toBeNull();
		expect(sourceFrameAt(null, 100.1)).toBeNull();
		expect(sourceFrameAt(null, secOfTicks(boundaryTicks({ num: 30000, den: 1001 }, 2) - 1))).toBeNull();
	});

	it('契約 3(不変): 既存ケースの値は変わらない(NTSC 100.1 秒 = 3000 フレーム目ちょうど・30fps 1 秒 = 30)', () => {
		expect(sourceFrameAt({ num: 30000, den: 1001 }, 100.1)).toBe(3000);
		expect(sourceFrameAt({ num: 30, den: 1 }, 1)).toBe(30);
		expect(sourceFrameAt({ num: 24, den: 1 }, 0.5)).toBe(12);
	});
});
