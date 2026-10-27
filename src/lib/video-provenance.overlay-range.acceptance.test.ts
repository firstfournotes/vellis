/**
 * 要件#40 追補a(2026-10-26・Issue #619)の受け入れテスト AC-40-追a (a)(b)(d)
 * (docs/requirements/req-40.md「追補a」。unit プロジェクト・純関数の判定)
 *
 * 「幅 0・負のオーバーレイが黙って一度も表示されない」の直し= `provenanceWarnings` が、
 * map のオーバーレイに**終了の秒 ≤ 開始の秒**(幅 0・負)のものが 1 つ以上あれば警告
 * `overlay-empty-range` を出す。いくつあっても 1 件。並びは既存の 2 つの後ろ
 * (`[名前, 尺, オーバーレイ]`)。表示しないこと(`overlaysAt`)と読み込み・正規化
 * (`parseProvenanceMap`)は今までどおり。
 *
 * ## 確定契約(implementer はこれに従う)
 * - `ProvenanceWarning` に文字列の値 `'overlay-empty-range'` を 1 つ足す(型は文字列の
 *   ユニオンのまま)
 * - `provenanceWarnings(map, videoUri, actualDurationSec)` は、`map.overlays` のうち
 *   `end.sec <= start.sec` のものが 1 つ以上あれば末尾に `'overlay-empty-range'` を 1 件だけ
 *   足す。判定は `sec` だけで行い `frame` は見ない(契約(追補a)1 の文言どおり)。
 *   `actualDurationSec` が null でも(尺を判定しなくても)オーバーレイは判定する
 * - 開始か終了の秒が読めないオーバーレイ(`sec` が NaN など数値として比べられないもの)は
 *   判定の対象にしない(起案時判断 (b))。今の正規化(`asNumber`=有限の数だけ受理・それ以外は
 *   malformed)では JSON からは作れないので、手で組んだ map で固定する
 * - `overlaysAt` と `parseProvenanceMap` は変えない(契約(追補a)3)。幅 0・負のオーバーレイは
 *   どの時刻でも返らず、正規化の形(snake→camel・null 補完)も変わらない。読み込みの入口で
 *   弾かない(parse は ok のまま=警告は帯に出すだけで、パネルは動き続ける)
 *
 * ## フィクスチャ
 * `video-provenance.acceptance.test.ts` の spec 実例(tool-video-editor/docs/spec.md の
 * 「出所マップ(`map`)」節)と同じ骨組みの map を JSON の object から組み、overlays だけを
 * 差し替える(同じ家風=既存の `overlaysJson` と同じ overlay の形)。
 *
 * ## 判定しないもの
 * - 警告帯の文言と DOM への到達 → `ProvenancePanel.overlay-range.wiring.test.ts`(AC (c))
 * - 既存の 2 つの警告の判定・文言・区間の検証・縮退 → 既存の要件#40・#46 のテスト(無改変)
 */
import { describe, expect, it } from 'vitest';
import { overlaysAt, parseProvenanceMap, provenanceWarnings } from './video-provenance';
import type { ProvenanceMap, ProvenanceOverlay } from './video-provenance';

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const VIDEO = 'file:///Users/a/movies/final.mp4';
const OTHER_VIDEO = 'file:///Users/a/movies/other.mp4';
/** map の尺(`duration.sec`)。これと 0.05 秒を超えて違えば `duration-mismatch`。 */
const MAP_DURATION = 5.5;

/** 1 入力の宣言(spec 実例と同じ形)。 */
function input(path: string, scenarioPath: string) {
	return {
		path,
		scenario_path: scenarioPath,
		fps: { num: 30, den: 1 },
		duration: { sec: 10.0, frame: 300 },
	};
}

/** spec 実例と同じ 3 区間(clip → crossfade → clip)。 */
function segments() {
	return [
		{
			kind: 'clip',
			start: { sec: 0.0, frame: 0 },
			end: { sec: 2.5, frame: 75 },
			sources: [
				{
					input: 'raw',
					clip: 'opening',
					mode: 'extract',
					speed: 1,
					from: { sec: 2.0, frame: 60 },
					to: { sec: 4.5, frame: 135 },
				},
			],
		},
		{
			kind: 'transition',
			type: 'crossfade',
			start: { sec: 2.5, frame: 75 },
			end: { sec: 3.0, frame: 90 },
			sources: [
				{
					role: 'out',
					input: 'raw',
					clip: 'opening',
					mode: 'extract',
					speed: 1,
					from: { sec: 4.5, frame: 135 },
					to: { sec: 5.0, frame: 150 },
				},
				{
					role: 'in',
					input: 'broll',
					clip: 'scene2',
					mode: 'extract',
					speed: 1,
					from: { sec: 1.0, frame: 30 },
					to: { sec: 1.5, frame: 45 },
				},
			],
		},
		{
			kind: 'clip',
			start: { sec: 3.0, frame: 90 },
			end: { sec: 5.5, frame: 165 },
			sources: [
				{
					input: 'broll',
					clip: 'scene2',
					mode: 'extract',
					speed: 1,
					from: { sec: 1.5, frame: 45 },
					to: { sec: 4.0, frame: 120 },
				},
			],
		},
	];
}

/** overlays だけを差し替えた map の JSON テキスト。 */
function mapJson(overlays: unknown[]): string {
	return JSON.stringify({
		format: 'vedit-map',
		version: 1,
		scenario: { path: '../final.vedit.json' },
		video: { path: 'final.mp4', scenario_path: 'out/final.mp4' },
		fps: { num: 30, den: 1 },
		duration: { sec: MAP_DURATION, frame: 165 },
		inputs: {
			raw: input('../media/raw.mov', 'media/raw.mov'),
			broll: input('../media/broll.mp4', 'media/broll.mp4'),
		},
		segments: segments(),
		overlays,
	});
}

type RawTime = { sec: number; frame: number | null };

/** 30fps の時刻(frame は sec から)。 */
function at(sec: number): RawTime {
	return { sec, frame: Math.round(sec * 30) };
}

/** テロップのオーバーレイ(JSON の形=既存の `overlaysJson` と同じキー)。 */
function textOverlayRaw(index: number, start: RawTime, end: RawTime) {
	return {
		index,
		kind: 'text',
		start,
		end,
		path: null,
		scenario_path: null,
		text: `caption ${index}`,
		fps: null,
		extract: null,
		loop: false,
	};
}

/** 同じオーバーレイの正規化後の期待形(snake→camel・それ以外は値そのまま)。 */
function textOverlayExpected(index: number, start: RawTime, end: RawTime): ProvenanceOverlay {
	return {
		index,
		kind: 'text',
		start,
		end,
		path: null,
		scenarioPath: null,
		text: `caption ${index}`,
		fps: null,
		extract: null,
		loop: false,
	};
}

/** parse が ok であることを確かめて map を取り出す。 */
function parseOk(text: string): ProvenanceMap {
	const parsed = parseProvenanceMap(text);
	if (!parsed.ok) throw new Error(`fixture must parse, got: ${parsed.error}`);
	return parsed.map;
}

/** strict mode では凍結オブジェクトへの書き込みが throw する=被検関数の変異検出。 */
function deepFreeze<T>(value: T): T {
	if (value && typeof value === 'object') {
		for (const child of Object.values(value as object)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

// 代表の 3 種: 正しい(幅 > 0)・幅 0(start == end)・負(start > end)
const VALID = textOverlayRaw(0, at(1.0), at(4.0));
const ZERO_WIDTH = textOverlayRaw(1, at(2.0), at(2.0));
const NEGATIVE = textOverlayRaw(2, at(3.0), at(2.0));

const validOnly = () => parseOk(mapJson([VALID]));
const noOverlays = () => parseOk(mapJson([]));
const withZeroWidth = () => parseOk(mapJson([VALID, ZERO_WIDTH]));
const withNegative = () => parseOk(mapJson([VALID, NEGATIVE]));
const withBoth = () => parseOk(mapJson([VALID, ZERO_WIDTH, NEGATIVE]));

// ---------------------------------------------------------------------------
// AC-40-追a (a) — 幅 0・負のオーバーレイがあれば末尾に overlay-empty-range が 1 件
// ---------------------------------------------------------------------------

describe('AC-40-追a (a): overlay-empty-range for overlays whose end.sec <= start.sec (contract 1)', () => {
	it('width 0 (start == end) → ["overlay-empty-range"]', () => {
		expect(provenanceWarnings(withZeroWidth(), VIDEO, MAP_DURATION)).toEqual(['overlay-empty-range']);
	});

	it('negative (start > end) → ["overlay-empty-range"]', () => {
		expect(provenanceWarnings(withNegative(), VIDEO, MAP_DURATION)).toEqual(['overlay-empty-range']);
	});

	it('both a width-0 and a negative overlay → still exactly one warning', () => {
		expect(provenanceWarnings(withBoth(), VIDEO, MAP_DURATION)).toEqual(['overlay-empty-range']);
	});

	it('three empty-range overlays and no valid one → exactly one warning', () => {
		const map = parseOk(
			mapJson([
				textOverlayRaw(0, at(0.5), at(0.5)),
				textOverlayRaw(1, at(4.0), at(1.0)),
				textOverlayRaw(2, at(5.0), at(5.0)),
			]),
		);
		expect(provenanceWarnings(map, VIDEO, MAP_DURATION)).toEqual(['overlay-empty-range']);
	});

	it('end one rounding step (1e-6 s) before start counts as negative', () => {
		const map = parseOk(mapJson([textOverlayRaw(0, { sec: 1.0, frame: 30 }, { sec: 0.999999, frame: 30 })]));
		expect(provenanceWarnings(map, VIDEO, MAP_DURATION)).toEqual(['overlay-empty-range']);
	});

	it('the judgement is on sec only: equal sec with a larger end frame is still width 0', () => {
		const map = parseOk(mapJson([textOverlayRaw(0, { sec: 2.0, frame: 60 }, { sec: 2.0, frame: 61 })]));
		expect(provenanceWarnings(map, VIDEO, MAP_DURATION)).toEqual(['overlay-empty-range']);
	});

	it('the warning is emitted even when the actual duration is unknown (null)', () => {
		expect(provenanceWarnings(withZeroWidth(), VIDEO, null)).toEqual(['overlay-empty-range']);
	});

	it('order with both existing warnings: [video-name-mismatch, duration-mismatch, overlay-empty-range]', () => {
		expect(provenanceWarnings(withBoth(), OTHER_VIDEO, MAP_DURATION + 0.5)).toEqual([
			'video-name-mismatch',
			'duration-mismatch',
			'overlay-empty-range',
		]);
	});

	it('order with the name warning only: [video-name-mismatch, overlay-empty-range]', () => {
		expect(provenanceWarnings(withNegative(), OTHER_VIDEO, MAP_DURATION)).toEqual([
			'video-name-mismatch',
			'overlay-empty-range',
		]);
	});

	it('order with the duration warning only: [duration-mismatch, overlay-empty-range]', () => {
		expect(provenanceWarnings(withZeroWidth(), VIDEO, MAP_DURATION - 0.5)).toEqual([
			'duration-mismatch',
			'overlay-empty-range',
		]);
	});

	it('does not mutate the map (deep-frozen input)', () => {
		const map = deepFreeze(withBoth());
		expect(() => provenanceWarnings(map, VIDEO, MAP_DURATION)).not.toThrow();
		expect(provenanceWarnings(map, VIDEO, MAP_DURATION)).toEqual(['overlay-empty-range']);
	});
});

// ---------------------------------------------------------------------------
// AC-40-追a (b) — 正しいオーバーレイだけ・オーバーレイ無しの map は今と同じ
// ---------------------------------------------------------------------------

describe('AC-40-追a (b): valid-only and no-overlay maps are unchanged (contract 4)', () => {
	it('valid overlays only → no warning', () => {
		expect(provenanceWarnings(validOnly(), VIDEO, MAP_DURATION)).toEqual([]);
		expect(provenanceWarnings(validOnly(), VIDEO, null)).toEqual([]);
	});

	it('no overlays → no warning', () => {
		expect(provenanceWarnings(noOverlays(), VIDEO, MAP_DURATION)).toEqual([]);
	});

	it('existing warnings are untouched when every overlay is valid', () => {
		expect(provenanceWarnings(validOnly(), OTHER_VIDEO, MAP_DURATION)).toEqual(['video-name-mismatch']);
		expect(provenanceWarnings(validOnly(), VIDEO, MAP_DURATION + 0.5)).toEqual(['duration-mismatch']);
		expect(provenanceWarnings(validOnly(), OTHER_VIDEO, MAP_DURATION + 0.5)).toEqual([
			'video-name-mismatch',
			'duration-mismatch',
		]);
		expect(provenanceWarnings(noOverlays(), OTHER_VIDEO, MAP_DURATION + 0.5)).toEqual([
			'video-name-mismatch',
			'duration-mismatch',
		]);
	});

	it('a 1e-6 s wide overlay (end > start by one rounding step) is not empty', () => {
		const map = parseOk(mapJson([textOverlayRaw(0, { sec: 1.0, frame: 30 }, { sec: 1.000001, frame: 30 })]));
		expect(provenanceWarnings(map, VIDEO, MAP_DURATION)).toEqual([]);
	});

	it('an overlay whose start or end sec cannot be read (NaN) is not judged (decision (b))', () => {
		// 今の正規化(asNumber=有限の数だけ)では JSON からは作れないので、手で組んで固定する。
		const startUnreadable = validOnly();
		startUnreadable.overlays[0].start = { sec: Number.NaN, frame: null };
		expect(provenanceWarnings(startUnreadable, VIDEO, MAP_DURATION)).toEqual([]);

		const endUnreadable = validOnly();
		endUnreadable.overlays[0].end = { sec: Number.NaN, frame: null };
		expect(provenanceWarnings(endUnreadable, VIDEO, MAP_DURATION)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// AC-40-追a (d) — overlaysAt と parseProvenanceMap は今と同じ(契約(追補a)3)
// ---------------------------------------------------------------------------

describe('AC-40-追a (d): overlaysAt never returns an empty-range overlay (contract 3)', () => {
	const indicesAt = (map: ProvenanceMap, t: number) => overlaysAt(map.overlays, t).map((o) => o.index);

	it('width 0 at 2.0: not shown at, around, or one rounding step beside its instant', () => {
		const map = withZeroWidth();
		for (const t of [1.999998, 1.999999, 2.0, 2.000001, 2.5, 3.999, 4.0, 4.5]) {
			expect(indicesAt(map, t), `t=${t}`).not.toContain(1);
		}
	});

	it('negative (3.0 → 2.0): not shown between end and start nor at either edge', () => {
		const map = withNegative();
		for (const t of [1.999999, 2.0, 2.5, 2.999999, 3.0, 3.000001, 3.5, 4.0]) {
			expect(indicesAt(map, t), `t=${t}`).not.toContain(2);
		}
	});

	it('the valid overlay beside them is shown exactly as before (half-open [1.0, 4.0))', () => {
		const map = withBoth();
		expect(indicesAt(map, 0.999998)).toEqual([]);
		expect(indicesAt(map, 1.0)).toEqual([0]);
		expect(indicesAt(map, 2.0)).toEqual([0]);
		expect(indicesAt(map, 3.0)).toEqual([0]);
		expect(indicesAt(map, 3.999998)).toEqual([0]);
		expect(indicesAt(map, 4.0)).toEqual([]);
		expect(indicesAt(map, 5.0)).toEqual([]);
	});

	it('a map with only empty-range overlays shows nothing at any time', () => {
		const map = parseOk(mapJson([ZERO_WIDTH, NEGATIVE]));
		for (const t of [0, 1.0, 2.0, 2.5, 3.0, 4.0, 5.5]) {
			expect(overlaysAt(map.overlays, t), `t=${t}`).toEqual([]);
		}
	});
});

describe('AC-40-追a (d): parseProvenanceMap accepts and normalizes empty-range overlays as before (contract 3)', () => {
	it('parse is ok (the warning is for the band, not a parse error)', () => {
		expect(parseProvenanceMap(mapJson([VALID, ZERO_WIDTH, NEGATIVE])).ok).toBe(true);
		expect(parseProvenanceMap(mapJson([ZERO_WIDTH])).ok).toBe(true);
		expect(parseProvenanceMap(mapJson([NEGATIVE])).ok).toBe(true);
	});

	it('the normalized overlays keep the same shape and values (snake→camel, order, no extra keys)', () => {
		const map = withBoth();
		expect(map.overlays).toEqual([
			textOverlayExpected(0, at(1.0), at(4.0)),
			textOverlayExpected(1, at(2.0), at(2.0)),
			textOverlayExpected(2, at(3.0), at(2.0)),
		]);
	});

	it('the rest of the map is identical to the same map without overlays', () => {
		const withEmpty = withBoth();
		const without = noOverlays();
		expect({ ...withEmpty, overlays: [] }).toEqual(without);
	});

	it('parsing the same text twice gives equal results (deterministic)', () => {
		const text = mapJson([VALID, ZERO_WIDTH, NEGATIVE]);
		expect(parseProvenanceMap(text)).toEqual(parseProvenanceMap(text));
	});
});
