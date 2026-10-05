/**
 * 要件#40 追補6(backlog 246)の受け入れテスト AC-40-20
 * 「区間の表引きの hint の範囲を二分探索と同じ境目で見る」
 *
 * 契約の正本: docs/requirements/req-40.md「### 追補6(2026-10-01 夜・backlog 246=隣り合う
 * 区間が 1e-6 以内で重なるマップでは hint が結果を変えうる)」
 *
 * ## 背景
 * 区間列の辻褄の検査(`segmentsAreConsistent`)は、区間 k の `end.sec` と区間 k+1 の
 * `start.sec` の差が丸め粒度(`SECOND_EPSILON` = 1e-6 秒)以内なら受け入れる。一方
 * `segmentIndexAt` の二分探索は各区間の `start.sec` だけで境目を決める。追補6 より前の
 * hint の判定は区間 k の `end.sec` を上限に見ていたので、`end_k` が `start_{k+1}` より
 * 後ろにずれた(重なった)マップでは、幅がそのずれの窓で「hint=k は k を返し、素引きは
 * k+1 を返す」食い違いが起き、契約⑪「hint は結果を変えない」が崩れていた。
 *
 * ## 契約(追補6)
 * hint の判定は二分探索と**同じ境目**で行う。区間 k の範囲は
 * `[start_k.sec − ε, start_{k+1}.sec − ε)`(最後の区間は上限なし=末尾以降の clamp と同じ)。
 * これで `end_k` と `start_{k+1}` の関係にかかわらず hint は結果を変えない。
 * 追補3 の許容幅・AC-40-8・AC-40-17 は不変。
 *
 * ## 本ファイルの判定範囲(AC-40-20=純関数のテスト)
 * - 隣り合う区間の `end_k` が `start_{k+1}` より g だけ後ろ(重なり)・前(隙間)にずれた
 *   区間列(g = 5e-7 と 1e-6 の両方・重なりと隙間の両方=4 通り)を、`parseProvenanceMap`
 *   を通して(辻褄の検査を通る形で)作る
 * - 各境目 b = `start_{k+1}.sec` の ± 3e-6 を 2.5e-7 刻みで並べた格子のすべての時刻 t で、
 *   `segmentIndexAt(segments, t, hint)` が hint なしの結果と同じになる
 *   (hint = 直前の区間 k・直後の区間 k+1・その他すべての添字・`null`・`undefined`・
 *   範囲外の値 −1・区間数・99)
 * - 末尾 `end`(最後の区間=上限なし)のまわりの格子でも同じ
 * - 連続再生の形(hint=直前の結果)でも全域で素引きと一致する
 * - 素引きの境目は `start_{k+1}.sec − ε`(追補3 の許容幅)のまま=`end_k` のずれで動かない
 * - フィクスチャの前提: 重なりの区間列では、追補6 より前の hint の判定(`end_k − ε` を上限)
 *   が k を受け入れるのに素引きが k+1 を返す格子点が各境目に実際にあることをテスト内で
 *   確かめ、空振りの緑を防ぐ(実装前はその点で本テストが赤になる)
 *
 * ## フィクスチャの境目の選び方
 * 境目を `b ± g` と書いて JSON で往復させると、倍精度の丸めで `|end_k − start_{k+1}|` が
 * 1e-6 をわずかに超えて辻褄の検査に落ちる b がある(例: 2 + 1e-6 → 差 1.0000000001e-6)。
 * そこで、g = 1e-6 の重なり・隙間の両方で往復後の差が 1e-6 以内に収まる [1, 2) 内の
 * 1/8 刻みの値(1.125〜1.875)を境目に使う。前提テストで parse が ok になることと、
 * ずれが実際に g だけ残っていることを確かめる。
 *
 * ## 既存 acceptance との関係
 * - 既存 `video-provenance.acceptance.test.ts`(AC-40-8)と
 *   `video-provenance-segment-epsilon.acceptance.test.ts`(AC-40-17)は書き換えない。
 *   区間列の形は両者と同じ最小形(clip 1源・speed 1)に合わせる
 */

import { describe, expect, it } from "vitest";

import { parseProvenanceMap, segmentIndexAt } from "./video-provenance";
import type { ProvenanceSegment } from "./video-provenance";

/** 丸め粒度(実装の `SECOND_EPSILON` と同じ値。追補3)。 */
const SECOND_EPSILON = 1e-6;

/**
 * 内側の境目(= 区間 k+1 の `start.sec`)。[1, 2) 内の 1/8 刻み=±5e-7・±1e-6 のどれを
 * 足して JSON で往復しても `|end_k − start_{k+1}| ≤ 1e-6` に収まる値(冒頭コメント参照)。
 */
const INNER_BOUNDS = [1.125, 1.25, 1.375, 1.5, 1.625, 1.75, 1.875];

/** 先頭は 0(辻褄の検査の要請)・末尾 `end` = duration。 */
const FIRST_START = 0;
const DURATION_SEC = 2;

/** ずれの大きさ(辻褄の検査が受け入れる上限 1e-6 と、その半分)。 */
const OFFSETS = [5e-7, 1e-6] as const;

/** `end_k` のずれの向き: overlap = `start_{k+1}` より後ろ・gap = 前。 */
type Shift = "overlap" | "gap";

const SHIFTS: readonly Shift[] = ["overlap", "gap"];

/** 格子: 境目 b の ± 3e-6 を 2.5e-7 刻み(25 点)。累積誤差を避けて b + i × 刻みで作る。 */
const GRID_STEP = 2.5e-7;
const GRID_HALF_COUNT = 12;

function gridAround(b: number): number[] {
  const ts: number[] = [];
  for (let i = -GRID_HALF_COUNT; i <= GRID_HALF_COUNT; i++) {
    ts.push(b + i * GRID_STEP);
  }
  return ts;
}

/** 区間 k の `end.sec`(k < last のときだけずらす。最後は duration ちょうど)。 */
function endSecOf(k: number, shift: Shift, g: number): number {
  const bounds = [FIRST_START, ...INNER_BOUNDS, DURATION_SEC];
  const next = bounds[k + 1];
  if (k + 1 === bounds.length - 1) return next;
  return shift === "overlap" ? next + g : next - g;
}

/**
 * ずれた区間列を持つマップの JSON(vedit-map v1)。形は spec 実例と同じトップレベル・
 * 区間は AC-40-8 の `simpleSegments` と同じ最小形(clip 1源・speed 1)。出力 fps と
 * 入力 fps は null(frame はすべて null)で、秒だけが正本(契約⑤)。
 */
function shiftedMapJson(shift: Shift, g: number): string {
  const bounds = [FIRST_START, ...INNER_BOUNDS, DURATION_SEC];
  const segments: Record<string, unknown>[] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const startSec = bounds[k];
    const endSec = endSecOf(k, shift, g);
    segments.push({
      kind: "clip",
      start: { sec: startSec, frame: null },
      end: { sec: endSec, frame: null },
      sources: [
        {
          input: "raw",
          clip: `c${k}`,
          mode: "extract",
          speed: 1,
          from: { sec: 0, frame: null },
          to: { sec: endSec - startSec, frame: null },
        },
      ],
    });
  }
  return JSON.stringify({
    format: "vedit-map",
    version: 1,
    scenario: { path: "../final.vedit.json" },
    video: { path: "final.mp4", scenario_path: "out/final.mp4" },
    fps: null,
    duration: { sec: DURATION_SEC, frame: null },
    inputs: {
      raw: {
        path: "../media/raw.mov",
        scenario_path: "media/raw.mov",
        fps: null,
        duration: { sec: 10, frame: null },
      },
    },
    segments,
    overlays: [],
  });
}

/** `parseProvenanceMap` を通した(辻褄の検査を通った)ずれた区間列。 */
function shiftedSegments(shift: Shift, g: number): ProvenanceSegment[] {
  const parsed = parseProvenanceMap(shiftedMapJson(shift, g));
  if (!parsed.ok) {
    throw new Error(
      `fixture (${shift}, g=${g}) must parse ok, got: ${parsed.error}`,
    );
  }
  return parsed.map.segments;
}

/** 4 通りのフィクスチャ(重なり/隙間 × g)。 */
const FIXTURES = SHIFTS.flatMap((shift) =>
  OFFSETS.map((g) => ({ shift, g, label: `${shift} g=${g}` })),
);

/**
 * 境目 k|k+1 で試す hint の一覧: 直前の区間 k・直後の区間 k+1・その他すべての添字・
 * `null`・`undefined`・範囲外の値(−1・区間数・99)。
 */
function hintsFor(
  segments: ProvenanceSegment[],
): (number | null | undefined)[] {
  const all = segments.map((_, i) => i);
  return [undefined, null, ...all, -1, segments.length, 99];
}

/**
 * 追補6 より前の hint の判定(`end_k − ε` を上限に見る)。実装前に赤になる格子点が
 * 本当にあることを確かめるための参照式で、実装の期待値には使わない。
 */
function legacyHintAccepts(segment: ProvenanceSegment, t: number): boolean {
  return (
    t >= segment.start.sec - SECOND_EPSILON &&
    t < segment.end.sec - SECOND_EPSILON
  );
}

describe("AC-40-20: hint の範囲は二分探索と同じ境目 [start_k − ε, start_{k+1} − ε)(要件#40 追補6・backlog 246)", () => {
  it("フィクスチャの前提: 4 通りの区間列は parseProvenanceMap を ok で通り、end_k は start_{k+1} から g だけずれている", () => {
    for (const { shift, g, label } of FIXTURES) {
      const parsed = parseProvenanceMap(shiftedMapJson(shift, g));
      expect(parsed, label).toMatchObject({ ok: true });
      if (!parsed.ok) continue;

      const segments = parsed.map.segments;
      expect(segments, label).toHaveLength(INNER_BOUNDS.length + 1);
      expect(segments[0].start.sec, label).toBe(FIRST_START);
      expect(segments[segments.length - 1].end.sec, label).toBe(DURATION_SEC);

      for (let k = 0; k + 1 < segments.length; k++) {
        const b = segments[k + 1].start.sec;
        expect(b, `${label} k=${k}`).toBe(INNER_BOUNDS[k]);
        const diff = segments[k].end.sec - b;
        // ずれは実際に残っている(向きも大きさも g のとおり)。
        expect(diff, `${label} k=${k}`).not.toBe(0);
        if (shift === "overlap")
          expect(diff, `${label} k=${k}`).toBeGreaterThan(0);
        else expect(diff, `${label} k=${k}`).toBeLessThan(0);
        expect(Math.abs(diff), `${label} k=${k}`).toBeCloseTo(g, 9);
        // 辻褄の検査の許容(1e-6)の内側。
        expect(Math.abs(diff), `${label} k=${k}`).toBeLessThanOrEqual(
          SECOND_EPSILON,
        );
        // 境目の間隔はずれよりはるかに広い(0.125 秒)。
        expect(b - segments[k].start.sec, `${label} k=${k}`).toBeGreaterThan(
          0.1,
        );
      }
    }
  });

  it("フィクスチャの前提: 重なりの区間列では、追補6 より前の hint 判定が k を受け入れるのに素引きが k+1 を返す格子点が各境目にある(空振りの緑の防止)", () => {
    for (const g of OFFSETS) {
      const segments = shiftedSegments("overlap", g);
      for (let k = 0; k + 1 < segments.length; k++) {
        const b = segments[k + 1].start.sec;
        const disagreeing = gridAround(b).filter(
          (t) =>
            legacyHintAccepts(segments[k], t) &&
            segmentIndexAt(segments, t) === k + 1,
        );
        // 窓 [b − 1e-6, b + g − 1e-6) には g=5e-7 で 2 点・g=1e-6 で 4 点の格子点が入る。
        expect(disagreeing.length, `g=${g} k=${k}`).toBeGreaterThanOrEqual(
          g >= 1e-6 ? 4 : 2,
        );
        // 代表点 b − 7.5e-7 は両方の g で窓の中。
        const representative = b - 3 * GRID_STEP;
        expect(
          legacyHintAccepts(segments[k], representative),
          `g=${g} k=${k}`,
        ).toBe(true);
        expect(segmentIndexAt(segments, representative), `g=${g} k=${k}`).toBe(
          k + 1,
        );
      }
    }
  });

  it.each(FIXTURES)(
    "$label: 各境目 ± 3e-6 の格子(2.5e-7 刻み)のすべてで hint(直前・直後・全添字・null・undefined・範囲外)は素引きと同じ",
    ({ shift, g }) => {
      const segments = shiftedSegments(shift, g);
      const hints = hintsFor(segments);
      for (let k = 0; k + 1 < segments.length; k++) {
        const b = segments[k + 1].start.sec;
        for (const t of gridAround(b)) {
          const expected = segmentIndexAt(segments, t);
          for (const hint of hints) {
            expect(
              segmentIndexAt(segments, t, hint),
              `${shift} g=${g} k=${k} t=b${t >= b ? "+" : ""}${(t - b).toExponential(3)} hint=${String(hint)}`,
            ).toBe(expected);
          }
        }
      }
    },
  );

  it.each(FIXTURES)(
    "$label: 素引きの境目は start_{k+1} − ε のまま(end_k のずれで動かない=追補3・AC-40-8・AC-40-17 は不変)",
    ({ shift, g }) => {
      const segments = shiftedSegments(shift, g);
      for (let k = 0; k + 1 < segments.length; k++) {
        const b = segments[k + 1].start.sec;
        for (const t of gridAround(b)) {
          const expected = t >= b - SECOND_EPSILON ? k + 1 : k;
          expect(
            segmentIndexAt(segments, t),
            `${shift} g=${g} k=${k} t=b${t >= b ? "+" : ""}${(t - b).toExponential(3)}`,
          ).toBe(expected);
        }
      }
    },
  );

  it.each(FIXTURES)(
    "$label: 末尾 end(最後の区間=上限なし)の ± 3e-6 の格子でも hint は素引きと同じで、どれも最終区間",
    ({ shift, g }) => {
      const segments = shiftedSegments(shift, g);
      const last = segments.length - 1;
      const hints = hintsFor(segments);
      for (const t of gridAround(segments[last].end.sec)) {
        const expected = segmentIndexAt(segments, t);
        expect(expected, `${shift} g=${g} t=${t}`).toBe(last);
        for (const hint of hints) {
          expect(
            segmentIndexAt(segments, t, hint),
            `${shift} g=${g} t=${t} hint=${String(hint)}`,
          ).toBe(expected);
        }
      }
    },
  );

  it.each(FIXTURES)(
    "$label: 連続再生の形(hint=直前の結果)で全域+各境目の格子を通しても素引きと一致する",
    ({ shift, g }) => {
      const segments = shiftedSegments(shift, g);
      const ts: number[] = [];
      for (let t = -1e-3; t <= DURATION_SEC + 1e-3; t += 1e-3) ts.push(t);
      for (let k = 0; k + 1 < segments.length; k++)
        ts.push(...gridAround(segments[k + 1].start.sec));
      ts.sort((a, b) => a - b);

      let hint: number | null = null;
      for (const t of ts) {
        const result = segmentIndexAt(segments, t, hint);
        expect(result, `${shift} g=${g} t=${t} hint=${String(hint)}`).toBe(
          segmentIndexAt(segments, t),
        );
        hint = result;
      }
    },
  );
});
