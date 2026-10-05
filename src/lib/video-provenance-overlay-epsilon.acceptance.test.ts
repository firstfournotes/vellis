/**
 * 要件#40 追補5(backlog 245)の受け入れテスト AC-40-19
 * 「オーバーレイの判定にも丸めの許容幅を持たせる」
 *
 * 契約の正本: docs/requirements/req-40.md「### 追補5(2026-10-01・backlog 245=…)」
 *
 * ## 背景
 * マップの秒は小数第6位で丸められて書かれる(丸め粒度 `SECOND_EPSILON` = 1e-6 秒)。
 * 30fps で割り切れない時刻(31/30 = 1.0333…)は切り上がって書かれ得るので、
 * `overlaysAt` の判定が `t >= start.sec && t < end.sec` のまま(許容幅なし)だと
 * - 開始秒が切り上がったオーバーレイは、本当の開始フレーム(31/30)で一覧から漏れ
 * - 終了秒が切り上がったオーバーレイは、本当の終了フレーム(62/30)=終端の次の
 *   1フレームまで載る
 * 区間の表引き(`segmentIndexAt`・追補3)は同じ許容幅で見ているので、オーバーレイも揃える。
 *
 * ## 本ファイルの判定範囲(AC-40-19=純関数のテスト)
 * 契約: `t >= start.sec - SECOND_EPSILON && t < end.sec - SECOND_EPSILON`
 * - 開始 `Math.ceil(31/30*1e6)/1e6`・終了 `Math.ceil(62/30*1e6)/1e6` のオーバーレイで
 *   (切り上げが**実際に起きている**ことをテスト内で確かめたうえで)
 *   - 本当の開始時刻 `31/30` では掛かる
 *   - 本当の終了時刻 `62/30` では掛からない
 *   - `start.sec - 2e-6`(許容幅の外側)では掛からない
 *   - `end.sec - 2e-6`(許容幅の内側)では掛かる
 * - 複数オーバーレイの並び(配列順=index 順)は、許容幅が効く時刻でも効かない時刻でも
 *   変わらない
 * - 不変: 「境界は半開」「並びは配列順」「どれにも掛からない時刻は []」
 *
 * ## 既存 acceptance との関係
 * `src/lib/video-provenance.acceptance.test.ts` の `overlaysAt` の describe(契約⑥c)は
 * 丸めの絡まない整数秒の境界を見ている。本ファイルはそれに丸めの許容幅の分だけを足す
 * (既存テストは無改変)。オーバーレイは既存と同じく `parseProvenanceMap` を通した
 * `ProvenanceOverlay` で組み立てる(型どおりの手作りオブジェクトで判定を通しても、
 * 実際の読み込み経路で同じ値が得られる保証にならないため)。
 */

import { describe, expect, it } from 'vitest';

import { overlaysAt, parseProvenanceMap } from './video-provenance';
import type { ProvenanceMap, ProvenanceOverlay } from './video-provenance';

// ---------------------------------------------------------------------------
// 丸めた開始・終了秒(切り上げが起きていることを本文のテストで確かめる)
// ---------------------------------------------------------------------------

/** 丸め粒度(実装の `SECOND_EPSILON` と同じ値。export されていないので基準側で固定)。 */
const EPSILON = 1e-6;

/** 本当の開始時刻(30fps の 31 フレーム目)。 */
const TRUE_START = 31 / 30;
/** 本当の終了時刻(30fps の 62 フレーム目)。 */
const TRUE_END = 62 / 30;

/** マップに書かれる開始秒(小数第6位へ切り上げ)。 */
const WRITTEN_START = Math.ceil(TRUE_START * 1e6) / 1e6;
/** マップに書かれる終了秒(小数第6位へ切り上げ)。 */
const WRITTEN_END = Math.ceil(TRUE_END * 1e6) / 1e6;

// ---------------------------------------------------------------------------
// フィクスチャ(vedit-map v1 の最小形。区間列は [0, 5.5) の clip 1件で辻褄を取る)
// ---------------------------------------------------------------------------

type OverlayRaw = {
	index: number;
	kind: 'image' | 'video' | 'text';
	start: { sec: number; frame: number | null };
	end: { sec: number; frame: number | null };
	path: string | null;
	scenario_path: string | null;
	text: string | null;
	fps: { num: number; den: number } | null;
	extract: { from: { sec: number; frame: number | null }; to: { sec: number; frame: number | null } }[] | null;
	loop: boolean;
};

/** 切り上げられた秒で書かれたテロップ(index は呼び出し側で与える)。 */
function roundedTextOverlay(index: number): OverlayRaw {
	return {
		index,
		kind: 'text',
		start: { sec: WRITTEN_START, frame: 31 },
		end: { sec: WRITTEN_END, frame: 62 },
		path: null,
		scenario_path: null,
		text: '切り上げられたテロップ',
		fps: null,
		extract: null,
		loop: false,
	};
}

/** 丸めの絡まない整数秒 [1.0, 3.0) のロゴ(index は呼び出し側で与える)。 */
function integralLogoOverlay(index: number): OverlayRaw {
	return {
		index,
		kind: 'video',
		start: { sec: 1.0, frame: 30 },
		end: { sec: 3.0, frame: 90 },
		path: '../media/logo.mov',
		scenario_path: 'media/logo.mov',
		text: null,
		fps: { num: 30, den: 1 },
		extract: [{ from: { sec: 0.0, frame: 0 }, to: { sec: 2.0, frame: 60 } }],
		loop: false,
	};
}

function mapJsonWith(overlays: OverlayRaw[]): string {
	return JSON.stringify({
		format: 'vedit-map',
		version: 1,
		scenario: { path: '../final.vedit.json' },
		video: { path: 'final.mp4', scenario_path: 'out/final.mp4' },
		fps: { num: 30, den: 1 },
		duration: { sec: 5.5, frame: 165 },
		inputs: {
			raw: {
				path: '../media/raw.mov',
				scenario_path: 'media/raw.mov',
				fps: { num: 30, den: 1 },
				duration: { sec: 10.0, frame: 300 },
			},
		},
		segments: [
			{
				kind: 'clip',
				start: { sec: 0.0, frame: 0 },
				end: { sec: 5.5, frame: 165 },
				sources: [
					{
						input: 'raw',
						clip: 'opening',
						mode: 'extract',
						speed: 1,
						from: { sec: 0.0, frame: 0 },
						to: { sec: 5.5, frame: 165 },
					},
				],
			},
		],
		overlays,
	});
}

/** parse が ok であることを確かめて map を取り出す(縮退フィクスチャの誤用防止)。 */
function parseOk(text: string): ProvenanceMap {
	const parsed = parseProvenanceMap(text);
	if (!parsed.ok) throw new Error(`fixture must parse, got: ${parsed.error}`);
	return parsed.map;
}

/** parse を通した、切り上げ済みテロップ 1 件だけのオーバーレイ列。 */
function roundedOverlays(): ProvenanceOverlay[] {
	return parseOk(mapJsonWith([roundedTextOverlay(0)])).overlays;
}

function indicesAt(overlays: ProvenanceOverlay[], t: number): number[] {
	return overlaysAt(overlays, t).map((o) => o.index);
}

// ---------------------------------------------------------------------------
// 前提: フィクスチャの秒が本当に切り上がっている(切り上げが起きないと基準が空振りする)
// ---------------------------------------------------------------------------

describe('AC-40-19 前提 — フィクスチャの開始・終了秒は小数第6位で切り上がっている', () => {
	it('開始秒は 31/30 より大きく、差は丸め粒度(1e-6)未満', () => {
		expect(WRITTEN_START).toBeGreaterThan(TRUE_START);
		expect(WRITTEN_START - TRUE_START).toBeLessThan(EPSILON);
	});

	it('終了秒は 62/30 より大きく、差は丸め粒度(1e-6)未満', () => {
		expect(WRITTEN_END).toBeGreaterThan(TRUE_END);
		expect(WRITTEN_END - TRUE_END).toBeLessThan(EPSILON);
	});

	it('parse を通しても書いた秒がそのまま載る(丸め直されない)', () => {
		const [overlay] = roundedOverlays();
		expect(overlay.start.sec).toBe(WRITTEN_START);
		expect(overlay.end.sec).toBe(WRITTEN_END);
	});
});

// ---------------------------------------------------------------------------
// AC-40-19 本体: 丸めの許容幅
// ---------------------------------------------------------------------------

describe('AC-40-19 overlaysAt — 丸めの許容幅(要件#40 追補5・backlog 245)', () => {
	it('本当の開始時刻 31/30(書かれた開始秒より僅かに前)で掛かる=頭の1フレームが漏れない', () => {
		expect(indicesAt(roundedOverlays(), TRUE_START)).toEqual([0]);
	});

	it('本当の終了時刻 62/30(書かれた終了秒より僅かに前)では掛からない=終端の次のフレームに載らない', () => {
		expect(indicesAt(roundedOverlays(), TRUE_END)).toEqual([]);
	});

	it('start.sec - 2e-6(許容幅の外側)では掛からない', () => {
		expect(indicesAt(roundedOverlays(), WRITTEN_START - 2e-6)).toEqual([]);
	});

	it('end.sec - 2e-6(許容幅の内側)では掛かる', () => {
		expect(indicesAt(roundedOverlays(), WRITTEN_END - 2e-6)).toEqual([0]);
	});

	it('書かれた秒ちょうどの半開は不変: start.sec は掛かる・end.sec は掛からない', () => {
		expect(indicesAt(roundedOverlays(), WRITTEN_START)).toEqual([0]);
		expect(indicesAt(roundedOverlays(), WRITTEN_END)).toEqual([]);
	});

	it('区間の内側(1.5 秒)は従来どおり掛かり、外側(0.5 秒・4.5 秒)は []', () => {
		expect(indicesAt(roundedOverlays(), 1.5)).toEqual([0]);
		expect(indicesAt(roundedOverlays(), 0.5)).toEqual([]);
		expect(indicesAt(roundedOverlays(), 4.5)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 並び: 許容幅の有無で配列順が変わらない
// ---------------------------------------------------------------------------

describe('AC-40-19 overlaysAt — 複数オーバーレイの並びは許容幅の有無で変わらない', () => {
	it('切り上げ済み(index 0)→整数秒(index 1)の配列順が、許容幅が効く時刻でも効かない時刻でも同じ', () => {
		// 配列順を開始時刻の順と**逆**にする(index 1 のロゴのほうが 1.0 秒で先に始まる)。
		// 並びが開始時刻順に並べ替えられていないことも同時に確かめる。
		const overlays = parseOk(mapJsonWith([roundedTextOverlay(0), integralLogoOverlay(1)])).overlays;

		// 許容幅が効く時刻(31/30: テロップは許容幅があって初めて掛かる)
		expect(indicesAt(overlays, TRUE_START)).toEqual([0, 1]);
		// 許容幅が効かない時刻(1.5 秒: どちらも素直に掛かる)
		expect(indicesAt(overlays, 1.5)).toEqual([0, 1]);
		// 逆向きに並べても配列順のまま
		const reversed = parseOk(mapJsonWith([integralLogoOverlay(0), roundedTextOverlay(1)])).overlays;
		expect(indicesAt(reversed, TRUE_START)).toEqual([0, 1]);
		expect(indicesAt(reversed, 1.5)).toEqual([0, 1]);
	});

	it('返るのは parse 済みオーバーレイそのもの(切り上げ済みの秒を持ったまま)', () => {
		const overlays = roundedOverlays();
		const [hit] = overlaysAt(overlays, TRUE_START);
		expect(hit).toBe(overlays[0]);
		expect(hit.start).toEqual({ sec: WRITTEN_START, frame: 31 });
		expect(hit.end).toEqual({ sec: WRITTEN_END, frame: 62 });
	});
});
