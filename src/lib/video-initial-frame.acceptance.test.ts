/**
 * 要件#39 の受け入れテスト(requirements.md #39)
 * 「動画ファイルを開いたとき、先頭フレーム(1フレーム目)を静止表示する
 *  (現状は再生開始まで黒表示)」
 *
 * 本ファイルの判定範囲(要件の機械判定分=初期シーク計画の純関数):
 * ①初期シーク先の値: 索引あり=先頭フレームへの半フレームオフセット精密シーク
 * (要件#37 の seekTimeForFrame(index, 0) 再利用=契約③)・索引なし=先頭付近への
 * 微小シーク(縮退=契約③)②分岐: 索引あり/索引なし(webm 等の縮退)/読み込み失敗
 * (loadFrameIndex の fail-open 経由=いずれも null 到着で縮退へ合流)③再生状態に
 * 触れないこと(契約②=計画関数はシーク先の秒を返すだけ)④初期位置の表示整合
 * (契約④=フレーム番号 #0・時間 00:00:00.000)。
 *
 * ## 要件#37 acceptance との関係
 * 索引ありの初期シークは要件#37 の seekTimeForFrame(frame=0)の再利用で、その値・
 * clamp・半フレームオフセットの根拠は video-frame.acceptance.test.ts が固定済み。
 * 本ファイルは「初期シークがその値と同値であること」を等式で固定し(要件#38 の
 * buildSrcdoc 等式契約と同じ家風)、要件#37 の受け入れには手を触れない(#39 分を独立)。
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * 実装先: src/lib/video-frame.ts への追加(既存 export は変更しない=既存 acceptance が防衛線)
 *
 * - `initialSeekTime(index: FrameIndex | null): number`
 *   動画を開いた直後に `<video>.currentTime` へ代入する初期シーク先(秒)。
 *   - 索引あり: `seekTimeForFrame(index, 0)` と同値(先頭フレームの提示時刻+
 *     半フレーム=契約③の精密シーク。先頭の提示開始が 0 でない索引でも frame 0 の内側)
 *   - 索引なし(null=webm 等の縮退・解析不能 MP4/MOV・読み込み失敗): `0.0001` 固定。
 *     理由: (a) 0 は不可 — 初期位置 0 への同位置シークは WebKit が描画なしで済ませ得る
 *     (=黒のままという本要件の現象そのもの)。0 より大きい値でシーク機構を確実に
 *     起動する (b) 現実的なフレームレート(〜240fps=先頭フレームの継続 約4.2ms 以上)
 *     の先頭フレーム内側に収まり、先頭フレームを外さない (c) formatMilliTime の
 *     最近接 ms 丸めで時間表示が 00:00:00.000 のまま(契約④の表示と整合)
 *   - 純関数: 引数は索引1つのみ・入力を書き換えない・戻り値は number のみ。
 *     `<video>` 要素を受けないシグネチャにより再生状態(play/pause/muted)に触れられ
 *     ないことを構造的に担保(契約②。要件#32 planSelectionCopy の家風)
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - VideoViewer.svelte が開いた直後に el.currentTime = initialSeekTime(frameIndex) を
 *   適用するタイミング(loadedmetadata / 索引到着。索引到着前に縮退値で先行シークし
 *   到着後に精密シークへ寄せる二段構えも可=どちらも frame 0 内のため実装裁量)
 * - {#key src} 再生成後の再適用(変更追従=要件#22。契約⑤)
 * - 初期シークで play()/pause()/muted を呼ばない=自動再生なし・無音の不変(契約②)・
 *   preload 属性変更の裁量(契約③)・ユーザー操作後の挙動と mkv/avi/ssh プレース
 *   ホルダの不変(契約⑤)・依存追加なし・Rust 変更なし(契約⑥)
 *
 * ## 人間ゲート(acceptance/acceptance.md)
 * - 実機の見た目: 開いた直後に黒でなく先頭フレームが見える・音が出ない・
 *   勝手に再生されない(契約①②)
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));

import { invoke } from '$lib/ipc';
import {
	describePosition,
	formatMilliTime,
	frameNumberForMediaTime,
	initialSeekTime,
	loadFrameIndex,
	seekTimeForFrame,
} from './video-frame';
import type { FrameIndex } from './video-frame';

const invokeMock = vi.mocked(invoke);

const MP4 = 'file:///Users/a/work/movies/clip.mp4';

/** CFR インデックスを合成する(times[i] = i × fpsDen / fpsNum)。 */
function cfrIndex(fpsNum: number, fpsDen: number, frameCount: number): FrameIndex {
	const times = Array.from({ length: frameCount }, (_, i) => (i * fpsDen) / fpsNum);
	return { times, duration: (frameCount * fpsDen) / fpsNum, fpsNum, fpsDen, isCfr: true };
}

/** 25fps・4フレーム: times=[0, 0.04, 0.08, 0.12]・duration=0.16。 */
const PAL4 = cfrIndex(25, 1, 4);
/** 29.97fps(NTSC)。frame0 の継続=1001/30000≈33.37ms。 */
const NTSC = cfrIndex(30000, 1001, 2000);
/** 不等間隔(VFR): frame0 の継続 0.5s。 */
const VFR: FrameIndex = {
	times: [0, 0.5, 0.6, 2.0],
	duration: 2.5,
	fpsNum: 30,
	fpsDen: 1,
	isCfr: false,
};
/** 単一フレームの動画(静止画的な 25fps 1枚)。次の提示時刻がなく duration から測る枝。 */
const SINGLE = cfrIndex(25, 1, 1);
/** 先頭フレームの提示開始が 0 でない索引(編集リスト等でずれた素材の形)。 */
const SHIFTED: FrameIndex = {
	times: [0.1, 0.14, 0.18],
	duration: 0.22,
	fpsNum: 25,
	fpsDen: 1,
	isCfr: true,
};

beforeEach(() => {
	invokeMock.mockReset();
});

// ---------------------------------------------------------------------------
// initialSeekTime — 索引あり: 先頭フレームへの精密シーク(契約③)
// ---------------------------------------------------------------------------

describe('initialSeekTime — 索引ありは先頭フレームの半フレームオフセット(要件#39 契約③)', () => {
	test('25fps は 0.02s(提示時刻 0+半フレーム 0.04/2=精密シーク先)', () => {
		expect(initialSeekTime(PAL4)).toBeCloseTo(0.02, 10);
	});

	test('seekTimeForFrame(index, 0) と同値(要件#37 の再利用を等式で固定。CFR/NTSC/VFR/単一フレーム/先頭ずれ)', () => {
		for (const index of [PAL4, NTSC, VFR, SINGLE, SHIFTED]) {
			expect(initialSeekTime(index)).toBeCloseTo(seekTimeForFrame(index, 0), 12);
		}
	});

	test('シーク先は常に先頭フレームの内側(表引きで frame 0 に落ちる=先頭フレームを外さない)', () => {
		for (const index of [PAL4, NTSC, VFR, SINGLE, SHIFTED]) {
			expect(frameNumberForMediaTime(index, initialSeekTime(index))).toBe(0);
		}
	});
});

// ---------------------------------------------------------------------------
// initialSeekTime — 索引なし(縮退)と読み込み失敗(契約③)
// ---------------------------------------------------------------------------

describe('initialSeekTime — 索引なしは先頭付近への微小シーク(要件#39 契約③縮退)', () => {
	test('null(縮退)は 0.0001s 固定・0 ちょうどではない(同位置シークは描画されない=黒のまま)', () => {
		expect(initialSeekTime(null)).toBe(0.0001);
		expect(initialSeekTime(null)).toBeGreaterThan(0);
	});

	test('微小値は高フレームレートでも先頭フレームを外さない(240fps の frame0 の内側)', () => {
		expect(frameNumberForMediaTime(cfrIndex(240, 1, 100), initialSeekTime(null))).toBe(0);
	});

	test('読み込み失敗(invoke reject)も null 応答(webm 等)も縮退の初期シークへ合流する(fail-open の合成)', async () => {
		invokeMock.mockRejectedValueOnce('parse failed');
		expect(initialSeekTime(await loadFrameIndex(MP4))).toBe(0.0001);

		invokeMock.mockResolvedValueOnce(null);
		expect(initialSeekTime(await loadFrameIndex(MP4))).toBe(0.0001);
	});
});

// ---------------------------------------------------------------------------
// 契約④ — 初期位置の表示整合(#0・00:00:00.000)
// ---------------------------------------------------------------------------

describe('初期シーク位置の表示整合(要件#39 契約④)', () => {
	test('索引あり: 初期シーク位置の3表記は #0・00:00:00.000・00:00:00:00(要件#37 の位置表示と整合)', () => {
		expect(describePosition(NTSC, initialSeekTime(NTSC))).toEqual({
			frame: 0,
			frameText: '#0',
			timeText: '00:00:00.000',
			smpteText: '00:00:00:00',
		});
	});

	test('縮退のミリ秒表示も 00:00:00.000 のまま(0.0001s は最近接 ms 丸めで 0=微小値選定の根拠)', () => {
		expect(formatMilliTime(initialSeekTime(null))).toBe('00:00:00.000');
	});
});

// ---------------------------------------------------------------------------
// 契約② — 再生状態に触れない純関数
// ---------------------------------------------------------------------------

describe('initialSeekTime — 再生状態に触れない純関数(要件#39 契約②)', () => {
	test('戻り値は有限の number のみ(両分岐とも=副作用のない計画値)', () => {
		for (const value of [initialSeekTime(NTSC), initialSeekTime(null)]) {
			expect(typeof value).toBe('number');
			expect(Number.isFinite(value)).toBe(true);
		}
	});

	test('引数は索引1つだけ・入力を書き換えない(<video> に触れる経路がない=構造的担保)', () => {
		expect(initialSeekTime.length).toBe(1);

		// strict mode では凍結オブジェクトへの書き込みが throw する=変異があればここで落ちる。
		const index = cfrIndex(25, 1, 4);
		Object.freeze(index);
		Object.freeze(index.times);
		const before = JSON.parse(JSON.stringify(index));
		expect(initialSeekTime(index)).toBeCloseTo(0.02, 10);
		expect(index).toEqual(before);
	});
});
