/**
 * 要件#40 追補3(backlog 229)の受け入れテスト AC-40-17
 * 「区間の表引きにマップの丸めのぶんの許容幅を持たせる」
 *
 * 契約の正本: docs/requirements/req-40.md「### 追補3(2026-10-01・backlog 229=区間の
 * 境目の判定で1区間手前を指す)」
 *
 * ## 背景
 * マップ(vedit-map v1)の `sec` は小数第6位で丸められている。区間の頭の本当の時刻
 * (例 31/30 = 1.0333…秒)が `1.033334` のように**切り上がって**書かれると、その頭の
 * フレームの再生位置(1.033333…)は `start.sec` より 1e-6 未満だけ小さくなり、
 * 許容幅なしの `start.sec <= t` では前の区間に入る(30fps の境目の約3分の1で発生)。
 *
 * ## 契約(追補3)
 * 区間の表引き(契約⑤)は、再生位置 `t` が次の区間の `start.sec` より**マップの丸め粒度
 * (`SECOND_EPSILON` = 1e-6 秒)以内**だけ手前にあるとき、その次の区間とみなす。
 * すなわち境目の比較は `t >= start.sec - SECOND_EPSILON`。hint の判定も同じ許容幅で
 * 行い、「hint は結果を変えない」(契約⑪)を保つ。
 *
 * ## 本ファイルの判定範囲(AC-40-17=純関数のテスト)
 * - 30fps の境目が割り切れない 300 区間列(各区間の `start.sec` を
 *   `Math.ceil(k * 31 / 30 * 1e6) / 1e6` で小数第6位へ切り上げて作る)について、各区間 k の
 *   頭の本当の時刻(`k * 31 / 30` を倍精度で計算した値)を `segmentIndexAt` に渡すと k が
 *   返る。hint なし・正しい hint(k)・1つ前の区間の hint(k-1)・`null` のどれでも同じ
 * - `start.sec - 2e-6`(許容幅の外)は前の区間 k-1 のまま
 * - 300 区間ぶん全部で成り立つ
 * - フィクスチャで切り上げが実際に起きている(本当の時刻 < `start.sec` となる k が多数ある)
 *   ことをテスト内で確かめ、空振りの緑を防ぐ
 *
 * ## 既存 acceptance との関係
 * - 既存 `video-provenance.acceptance.test.ts`(AC-40-8=半開区間・境界ちょうどは後ろの
 *   区間・端 clamp・hint 同値)は書き換えない。区間列の形は同ファイルの `simpleSegments`
 *   と同じ最小形(clip 1源・speed 1)に合わせる
 */

import { describe, expect, it } from 'vitest';

import { segmentIndexAt } from './video-provenance';
import type { ProvenanceSegment } from './video-provenance';

/** 区間数(backlog 229 の発見時の素材と同じ規模)。 */
const SEGMENT_COUNT = 300;

/** 区間 k の頭の本当の時刻(30fps で 31 フレームずつ=割り切れない境目)。 */
function trueStart(k: number): number {
	return (k * 31) / 30;
}

/** マップに書かれる `sec`(小数第6位へ切り上げ=生成側の丸めで切り上がったケースを再現)。 */
function mapSec(k: number): number {
	return Math.ceil(trueStart(k) * 1e6) / 1e6;
}

/**
 * `[mapSec(k), mapSec(k+1))` の clip 区間列(AC-40-8 の `simpleSegments` と同じ最小形)。
 * 最後の区間の end は mapSec(SEGMENT_COUNT)(= 310 秒ちょうど)。
 */
function roundedSegments(): ProvenanceSegment[] {
	const segments: ProvenanceSegment[] = [];
	for (let k = 0; k < SEGMENT_COUNT; k++) {
		const startSec = mapSec(k);
		const endSec = mapSec(k + 1);
		segments.push({
			kind: 'clip',
			type: null,
			start: { sec: startSec, frame: null },
			end: { sec: endSec, frame: null },
			sources: [
				{
					role: null,
					input: 'raw',
					clip: `c${k}`,
					mode: 'extract',
					speed: 1,
					from: { sec: 0, frame: null },
					to: { sec: endSec - startSec, frame: null },
				},
			],
		});
	}
	return segments;
}

describe('AC-40-17: 区間の表引きはマップの丸め粒度(1e-6 秒)ぶん手前を次の区間とみなす(要件#40 追補3・backlog 229)', () => {
	it('フィクスチャの前提: 切り上げが実際に起きている区間が多数ある(本当の時刻 < start.sec)', () => {
		const segments = roundedSegments();
		expect(segments).toHaveLength(SEGMENT_COUNT);

		let roundedUp = 0;
		for (let k = 0; k < SEGMENT_COUNT; k++) {
			const t = trueStart(k);
			const startSec = segments[k].start.sec;
			// 切り上げなので start.sec は本当の時刻以上、かつ差は丸め粒度 1e-6 未満。
			expect(startSec).toBeGreaterThanOrEqual(t);
			expect(startSec - t).toBeLessThan(1e-6);
			if (t < startSec) roundedUp++;
		}
		// k mod 3 ≠ 0 の区間(300 中 200)で切り上がる。倍精度の揺れを見込んで下限は 150。
		expect(roundedUp).toBeGreaterThanOrEqual(150);

		// 区間列は連続(end は次の start)で、境目は 1 フレーム(約 0.033 秒)以上離れている。
		for (let k = 0; k + 1 < SEGMENT_COUNT; k++) {
			expect(segments[k].end.sec).toBe(segments[k + 1].start.sec);
			expect(segments[k + 1].start.sec - segments[k].start.sec).toBeGreaterThan(0.03);
		}
	});

	it('各区間の頭の本当の時刻(hint なし)はその区間 k を返す(300 区間全部)', () => {
		const segments = roundedSegments();
		for (let k = 0; k < SEGMENT_COUNT; k++) {
			expect(segmentIndexAt(segments, trueStart(k)), `k=${k}`).toBe(k);
		}
	});

	it('各区間の頭の本当の時刻は hint=null でもその区間 k を返す(300 区間全部)', () => {
		const segments = roundedSegments();
		for (let k = 0; k < SEGMENT_COUNT; k++) {
			expect(segmentIndexAt(segments, trueStart(k), null), `k=${k}`).toBe(k);
		}
	});

	it('各区間の頭の本当の時刻は正しい hint(k)でもその区間 k を返す(300 区間全部)', () => {
		const segments = roundedSegments();
		for (let k = 0; k < SEGMENT_COUNT; k++) {
			expect(segmentIndexAt(segments, trueStart(k), k), `k=${k}`).toBe(k);
		}
	});

	it('各区間の頭の本当の時刻は1つ前の区間の hint(k-1)でもその区間 k を返す(連続再生の形・300 区間全部)', () => {
		const segments = roundedSegments();
		for (let k = 1; k < SEGMENT_COUNT; k++) {
			expect(segmentIndexAt(segments, trueStart(k), k - 1), `k=${k}`).toBe(k);
		}
	});

	it('start.sec - 2e-6(許容幅の外)は前の区間 k-1 のまま(hint なし・null・k・k-1 のどれでも・300 区間全部)', () => {
		const segments = roundedSegments();
		for (let k = 1; k < SEGMENT_COUNT; k++) {
			const t = segments[k].start.sec - 2e-6;
			expect(segmentIndexAt(segments, t), `k=${k} hint なし`).toBe(k - 1);
			expect(segmentIndexAt(segments, t, null), `k=${k} hint=null`).toBe(k - 1);
			expect(segmentIndexAt(segments, t, k), `k=${k} hint=k`).toBe(k - 1);
			expect(segmentIndexAt(segments, t, k - 1), `k=${k} hint=k-1`).toBe(k - 1);
		}
	});

	it('start.sec ちょうどはその区間 k のまま(AC-40-8 の半開区間は不変・300 区間全部)', () => {
		const segments = roundedSegments();
		for (let k = 0; k < SEGMENT_COUNT; k++) {
			const t = segments[k].start.sec;
			expect(segmentIndexAt(segments, t), `k=${k} hint なし`).toBe(k);
			expect(segmentIndexAt(segments, t, k), `k=${k} hint=k`).toBe(k);
			expect(segmentIndexAt(segments, t, k - 1), `k=${k} hint=k-1`).toBe(k);
		}
	});
});
