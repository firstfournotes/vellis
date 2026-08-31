/**
 * 要件#37 の受け入れテスト(requirements.md #37)— フロント純関数分
 * 「動画ビューア(要件#28)をフレーム精度の編集下見に使えるようにする: 現在位置の
 *  フレーム番号・ミリ秒時間・SMPTE 表記の表示と、フレーム単位の送り/戻し・再生/停止・
 *  シークバーを備えた自作コントロールバーへの置き換え(フレーム機能の対象=MP4/MOV。
 *  用途=ビデオ編集のカット位置指定)」
 *
 * 本ファイルの判定範囲(契約⑪の TS 分): ①3表記の整形=時間 HH:MM:SS.mmm+
 * フレーム番号 #n(0起点=ffmpeg の n と一致)+SMPTE HH:MM:SS:FF(ノンドロップ固定・
 * CFR 判定時のみ)②rVFC mediaTime→フレーム番号の表引き(契約③=fps×時間の丸め
 * 計算をしない)③シーク先計算(±1/±10・半フレームオフセット・0〜末尾 clamp=契約④)
 * ④シークバー吸着計算(契約⑤)⑤縮退判定(契約⑦=FrameIndex なしではフレーム系
 * だけ落ちる)⑥Rust コマンド応答の受け取り(fail-open)。
 * 箱パース(timescale/fps 判定/提示時刻列)は Rust 側= src-tauri/tests/acceptance_req37.rs。
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * 実装先: src/lib/video-frame.ts(新規・純関数 VM。video-viewing.ts の家風=DOM なし)
 *
 * - `export const LARGE_FRAME_STEP = 10`
 *   Shift+←/→ の歩幅(契約④=定数1箇所で調整可。±1 側は固定)
 * - `export type VideoFrameIndexPayload = { timescale: number; sampleTimes: number[];
 *    duration: number; fpsNum: number; fpsDen: number; isCfr: boolean }`
 *   Rust コマンド `get_video_frame_index` の応答(serde camelCase)。sampleTimes=
 *   各フレームの提示開始時刻(ticks・昇順・index がフレーム番号)・duration=全フレーム
 *   の提示終了時刻(ticks=stts 総和)・fps は有理数(CFR は厳密値)
 * - `export type FrameIndex = { times: number[]; duration: number; fpsNum: number;
 *    fpsDen: number; isCfr: boolean }` — times/duration は秒(ticks/timescale)
 * - `frameIndexFromPayload(payload: VideoFrameIndexPayload | null | undefined): FrameIndex | null`
 *   timescale が正で1フレーム以上あるときだけ FrameIndex(それ以外は null=縮退)
 * - `loadFrameIndex(uri: string): Promise<FrameIndex | null>`
 *   invoke('get_video_frame_index', { uri }) を1回。reject・null 応答とも null 解決
 *   (契約⑦ fail-open=フレーム情報が無くてもパース失敗でも再生を止めない)
 * - `frameNumberForMediaTime(index, mediaTime): number`
 *   表引き: times[i] <= mediaTime を満たす最大の i。times[0] 未満は 0・末尾超は最終番号
 * - `formatMilliTime(seconds): string` — 'HH:MM:SS.mmm'(2桁ゼロ詰め・ms は最近接へ
 *   丸め=床関数は 3/25 秒×1000=119.999… の浮動小数点誤差で 1ms ずれるため不採用。
 *   テストで固定。カット位置の正本はフレーム番号で時間は換算表示=契約①)
 * - `formatSmpte(index, frame): string | null` — 'HH:MM:SS:FF' ノンドロップ固定
 *   (FF 基数=round(fpsNum/fpsDen)。29.97→30・23.976→24)。isCfr=false は null
 *   (契約①=SMPTE は CFR 判定時のみ)
 * - `describePosition(index, mediaTime): { frame: number; frameText: string;
 *    timeText: string; smpteText: string | null }` — frameText='#n'(0起点)・
 *   timeText は times[frame] の換算(生 mediaTime ではない=正本はフレーム番号)
 * - `seekTimeForFrame(index, frame): number` — times[frame] + そのフレームの
 *   継続時間/2(契約④=半フレームオフセットの精密シーク先。最終フレームの継続時間は
 *   duration − times[末尾]。frame は 0〜末尾へ clamp)
 * - `stepFrame(index, fromFrame, deltaFrames): number` — 加算して 0〜末尾へ clamp
 * - `nearestFrame(index, time): number` — 最寄りフレーム境界の番号(シークバー解放の
 *   吸着=契約⑤。範囲外は 0〜末尾へ clamp。等距離の扱いは実装裁量=テスト対象外)
 * - `frameKeyAction(key, shiftKey, index: FrameIndex | null):
 *    { kind: 'toggle-play' } | { kind: 'step'; frames: number } | null`
 *   ' '(Space)=toggle-play(index なしでも有効=縮退でも再生/停止は動く)・
 *   ArrowRight/ArrowLeft=±1・Shift+矢印=±LARGE_FRAME_STEP・index なしの矢印=null
 *   (縮退=コマ送り不可)・その他キー=null(J/K/L シャトルは契約⑥スコープ外)
 * - `barCapabilities(index: FrameIndex | null): { frameStepping: boolean;
 *    frameReadout: boolean; smpteReadout: boolean }` — null=全 false(契約⑦。
 *   再生/停止・シーク・ミリ秒時間はバーの常設機能でこのフラグの外)・CFR=全 true・
 *   VFR=smpteReadout のみ false
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - VideoViewer.svelte の自作コントロールバー全面置き換え(契約⑤=要件#28 契約②の
 *   仕様置き換え): 再生/停止(Space)・±10/±1 ボタン(±1 は長押し連射)・シークバー
 *   (ドラッグ中は粗シーク追従・解放で nearestFrame→seekTimeForFrame の吸着シーク)・
 *   3表記表示・消音トグル。音量スライダー/フルスクリーン/PiP/AirPlay は再実装しない・
 *   自動再生なし(クリック再生)は不変
 * - requestVideoFrameCallback の購読と mediaTime→describePosition の受け渡し(契約③)
 * - キーボードのフォーカスゲート(契約⑧=動画ペインのフォーカス時のみ
 *   frameKeyAction を呼ぶ。取り方は実装裁量)
 * - `get_video_frame_index` コマンドの Tauri 配線・登録(契約②⑨=Rust 追加は
 *   メタデータコマンド1本・capability/CSP 変更なし)
 *
 * ## 人間ゲート(acceptance/acceptance.md)
 * - 実機のコマ送り精度(1押し=表示が1フレーム変わる)・表示とフレームの一致・
 *   長 GOP 逆送りの体感・VFR 素材の挙動・バーの操作感
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));

import { invoke } from '$lib/ipc';
import {
	LARGE_FRAME_STEP,
	barCapabilities,
	describePosition,
	formatMilliTime,
	formatSmpte,
	frameIndexFromPayload,
	frameKeyAction,
	frameNumberForMediaTime,
	loadFrameIndex,
	nearestFrame,
	seekTimeForFrame,
	stepFrame,
} from './video-frame';
import type { FrameIndex, VideoFrameIndexPayload } from './video-frame';

const invokeMock = vi.mocked(invoke);

const MP4 = 'file:///Users/a/work/movies/clip.mp4';

/** CFR インデックスを合成する(times[i] = i × fpsDen / fpsNum)。 */
function cfrIndex(fpsNum: number, fpsDen: number, frameCount: number): FrameIndex {
	const times = Array.from({ length: frameCount }, (_, i) => (i * fpsDen) / fpsNum);
	return { times, duration: (frameCount * fpsDen) / fpsNum, fpsNum, fpsDen, isCfr: true };
}

/** VFR インデックス(不等間隔の提示時刻列)。fps は代表値で SMPTE には使われない。 */
function vfrIndex(times: number[], duration: number): FrameIndex {
	return { times, duration, fpsNum: 30, fpsDen: 1, isCfr: false };
}

/** 29.97fps(NTSC)。times[1]=1001/30000≈0.0333667s。 */
const NTSC = cfrIndex(30000, 1001, 2000);
/** 25fps・4フレーム: times=[0, 0.04, 0.08, 0.12]・duration=0.16。 */
const PAL4 = cfrIndex(25, 1, 4);
/** 不等間隔: [0, 0.5, 0.6, 2.0]・提示終了 2.5s。 */
const VFR = vfrIndex([0, 0.5, 0.6, 2.0], 2.5);

beforeEach(() => {
	invokeMock.mockReset();
});

// ---------------------------------------------------------------------------
// frameIndexFromPayload — Rust 応答 → FrameIndex(秒)変換と縮退(契約②⑦)
// ---------------------------------------------------------------------------

describe('frameIndexFromPayload — コマンド応答の秒変換と縮退判定(要件#37 契約②⑦)', () => {
	test('ticks を timescale で割った秒列へ変換する(NTSC 30000/1001)', () => {
		const payload: VideoFrameIndexPayload = {
			timescale: 30000,
			sampleTimes: [0, 1001, 2002],
			duration: 3003,
			fpsNum: 30000,
			fpsDen: 1001,
			isCfr: true,
		};
		const index = frameIndexFromPayload(payload);
		expect(index).not.toBeNull();
		expect(index?.times).toHaveLength(3);
		expect(index?.times[0]).toBe(0);
		expect(index?.times[1]).toBeCloseTo(1001 / 30000, 12);
		expect(index?.times[2]).toBeCloseTo(2002 / 30000, 12);
		expect(index?.duration).toBeCloseTo(3003 / 30000, 12);
		expect(index?.fpsNum).toBe(30000);
		expect(index?.fpsDen).toBe(1001);
		expect(index?.isCfr).toBe(true);
	});

	test('null / undefined は null(フレーム情報なし=縮退)', () => {
		expect(frameIndexFromPayload(null)).toBeNull();
		expect(frameIndexFromPayload(undefined)).toBeNull();
	});

	test('フレーム0件の応答は null(Some⇒1フレーム以上の不変条件を二重に守る)', () => {
		expect(
			frameIndexFromPayload({
				timescale: 30000,
				sampleTimes: [],
				duration: 0,
				fpsNum: 30,
				fpsDen: 1,
				isCfr: true,
			}),
		).toBeNull();
	});

	test('timescale 0 の応答は null(0除算を UI へ持ち込まない)', () => {
		expect(
			frameIndexFromPayload({
				timescale: 0,
				sampleTimes: [0, 1001],
				duration: 2002,
				fpsNum: 30,
				fpsDen: 1,
				isCfr: true,
			}),
		).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// loadFrameIndex — invoke 経路と fail-open(契約②⑦⑨)
// ---------------------------------------------------------------------------

describe('loadFrameIndex — get_video_frame_index の呼び出しと fail-open(要件#37 契約②⑦)', () => {
	test('コマンドを1回 invoke し、応答を FrameIndex(秒)にして返す', async () => {
		const payload: VideoFrameIndexPayload = {
			timescale: 25000,
			sampleTimes: [0, 1000, 2000],
			duration: 3000,
			fpsNum: 25,
			fpsDen: 1,
			isCfr: true,
		};
		invokeMock.mockResolvedValue(payload);

		const index = await loadFrameIndex(MP4);

		expect(invokeMock.mock.calls).toEqual([['get_video_frame_index', { uri: MP4 }]]);
		expect(index?.times[1]).toBeCloseTo(0.04, 12);
		expect(index?.duration).toBeCloseTo(0.12, 12);
	});

	test('invoke の失敗(解析不能・ファイル消滅等)は null 解決=throw しない(fail-open)', async () => {
		invokeMock.mockRejectedValue('parse failed');
		await expect(loadFrameIndex(MP4)).resolves.toBeNull();
	});

	test('null 応答(webm 等フレーム情報なし)は null', async () => {
		invokeMock.mockResolvedValue(null);
		await expect(loadFrameIndex(MP4)).resolves.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// frameNumberForMediaTime — 提示時刻列への表引き(契約③)
// ---------------------------------------------------------------------------

describe('frameNumberForMediaTime — rVFC mediaTime の表引き(要件#37 契約③)', () => {
	test('フレーム境界ちょうどはその番号(times[i] <= mediaTime の最大 i)', () => {
		expect(frameNumberForMediaTime(NTSC, 0)).toBe(0);
		expect(frameNumberForMediaTime(NTSC, NTSC.times[1])).toBe(1);
		expect(frameNumberForMediaTime(NTSC, NTSC.times[30])).toBe(30);
	});

	test('フレームの中途は手前の番号(丸め上げしない)', () => {
		// frame1=0.033367s〜・frame2=0.066733s〜。0.05s は frame1 の中
		expect(frameNumberForMediaTime(NTSC, 0.05)).toBe(1);
	});

	test('times[0] 未満(負値含む)は 0・最終フレーム以降は最終番号へ clamp', () => {
		expect(frameNumberForMediaTime(NTSC, -1)).toBe(0);
		expect(frameNumberForMediaTime(NTSC, 999)).toBe(1999);
	});

	test('VFR の不等間隔でも正しく引ける(fps×時間の計算では正解不能な列)', () => {
		expect(frameNumberForMediaTime(VFR, 0.49)).toBe(0);
		expect(frameNumberForMediaTime(VFR, 0.5)).toBe(1);
		expect(frameNumberForMediaTime(VFR, 0.7)).toBe(2);
		expect(frameNumberForMediaTime(VFR, 2.4)).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// formatMilliTime — HH:MM:SS.mmm(契約①)
// ---------------------------------------------------------------------------

describe('formatMilliTime — ミリ秒時間の整形(要件#37 契約①)', () => {
	test('0 秒は 00:00:00.000', () => {
		expect(formatMilliTime(0)).toBe('00:00:00.000');
	});

	test('NTSC のフレーム時刻を最近接 ms へ丸める(#1=33.3667ms→.033・#2=66.7333ms→.067)', () => {
		expect(formatMilliTime(1001 / 30000)).toBe('00:00:00.033');
		expect(formatMilliTime(2002 / 30000)).toBe('00:00:00.067');
	});

	test('浮動小数点誤差で 1ms 欠けない(3/25 秒=120ms ちょうど。0.12×1000=119.999… の床は不正解)', () => {
		expect(formatMilliTime(3 / 25)).toBe('00:00:00.120');
	});

	test('ms の丸めは秒・分へ繰り上がる(0.9996s → 00:00:01.000)', () => {
		expect(formatMilliTime(0.9996)).toBe('00:00:01.000');
	});

	test('時・分・秒の位取り(3661.5s → 01:01:01.500)', () => {
		expect(formatMilliTime(3661.5)).toBe('01:01:01.500');
	});
});

// ---------------------------------------------------------------------------
// formatSmpte — SMPTE HH:MM:SS:FF ノンドロップ固定・CFR のみ(契約①)
// ---------------------------------------------------------------------------

describe('formatSmpte — SMPTE ノンドロップ(要件#37 契約①)', () => {
	test('0起点: フレーム0は 00:00:00:00', () => {
		expect(formatSmpte(NTSC, 0)).toBe('00:00:00:00');
	});

	test('29.97fps の FF 基数は 30(#29→FF29・#30→1秒0フレーム)', () => {
		expect(formatSmpte(NTSC, 29)).toBe('00:00:00:29');
		expect(formatSmpte(NTSC, 30)).toBe('00:00:01:00');
	});

	test('ノンドロップ固定: 29.97fps のフレーム1800は 00:01:00:00(ドロップなら 00:01:00;02)', () => {
		expect(formatSmpte(NTSC, 1799)).toBe('00:00:59:29');
		expect(formatSmpte(NTSC, 1800)).toBe('00:01:00:00');
	});

	test('整数 fps(25)と 23.976fps(基数24)', () => {
		expect(formatSmpte(cfrIndex(25, 1, 60), 26)).toBe('00:00:01:01');
		expect(formatSmpte(cfrIndex(24000, 1001, 60), 24)).toBe('00:00:01:00');
	});

	test('VFR(isCfr=false)は null=表示しない(SMPTE は CFR 判定時のみ)', () => {
		expect(formatSmpte(VFR, 1)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// describePosition — 3表記併記・正本はフレーム番号(契約①③)
// ---------------------------------------------------------------------------

describe('describePosition — 現在位置の3表記(要件#37 契約①③)', () => {
	test('mediaTime 0 はフレーム #0・00:00:00.000・00:00:00:00(0起点)', () => {
		expect(describePosition(NTSC, 0)).toEqual({
			frame: 0,
			frameText: '#0',
			timeText: '00:00:00.000',
			smpteText: '00:00:00:00',
		});
	});

	test('時間表記はフレーム番号からの換算(生の mediaTime を表示しない=正本はフレーム番号)', () => {
		// 0.05s は frame1(提示開始 0.0333667s)の中途 → 表示は .033 であって .050 ではない
		expect(describePosition(NTSC, 0.05)).toEqual({
			frame: 1,
			frameText: '#1',
			timeText: '00:00:00.033',
			smpteText: '00:00:00:01',
		});
	});

	test('VFR は SMPTE のみ null・時間はフレーム提示時刻の換算', () => {
		expect(describePosition(VFR, 0.55)).toEqual({
			frame: 1,
			frameText: '#1',
			timeText: '00:00:00.500',
			smpteText: null,
		});
	});
});

// ---------------------------------------------------------------------------
// seekTimeForFrame — 半フレームオフセットの精密シーク先(契約④)
// ---------------------------------------------------------------------------

describe('seekTimeForFrame — 目的フレーム提示時刻+半フレーム(要件#37 契約④)', () => {
	test('CFR: times[n] + 1/(2fps)(25fps フレーム1 → 0.06s)', () => {
		expect(seekTimeForFrame(PAL4, 1)).toBeCloseTo(0.06, 10);
	});

	test('最終フレームは duration との差の半分(25fps フレーム3 → 0.14s=末尾 0.16s の内側)', () => {
		expect(seekTimeForFrame(PAL4, 3)).toBeCloseTo(0.14, 10);
	});

	test('VFR は各フレーム自身の継続時間の半分', () => {
		expect(seekTimeForFrame(VFR, 1)).toBeCloseTo(0.55, 10); // 0.5 + (0.6−0.5)/2
		expect(seekTimeForFrame(VFR, 3)).toBeCloseTo(2.25, 10); // 2.0 + (2.5−2.0)/2
	});

	test('フレーム番号は 0〜末尾へ clamp(範囲外を渡されても壊れない)', () => {
		expect(seekTimeForFrame(PAL4, -3)).toBeCloseTo(0.02, 10); // frame0 と同じ
		expect(seekTimeForFrame(PAL4, 99)).toBeCloseTo(0.14, 10); // frame3 と同じ
	});
});

// ---------------------------------------------------------------------------
// stepFrame — ±1/±10 の歩数計算と clamp(契約④)
// ---------------------------------------------------------------------------

describe('stepFrame — コマ送りの歩数計算(要件#37 契約④)', () => {
	test('±1 の送り/戻し', () => {
		expect(stepFrame(NTSC, 5, 1)).toBe(6);
		expect(stepFrame(NTSC, 5, -1)).toBe(4);
	});

	test('先頭・末尾で clamp(0未満にも最終番号超にもならない)', () => {
		expect(stepFrame(NTSC, 0, -1)).toBe(0);
		expect(stepFrame(NTSC, 3, -10)).toBe(0);
		expect(stepFrame(NTSC, 1999, 1)).toBe(1999);
		expect(stepFrame(NTSC, 1995, 10)).toBe(1999);
	});

	test('LARGE_FRAME_STEP は 10(契約④=歩幅は定数1箇所で調整可)', () => {
		expect(LARGE_FRAME_STEP).toBe(10);
	});
});

// ---------------------------------------------------------------------------
// nearestFrame — シークバー解放位置の吸着(契約⑤)
// ---------------------------------------------------------------------------

describe('nearestFrame — 最寄りフレーム境界への吸着(要件#37 契約⑤)', () => {
	test('前後の境界のうち近い方へ吸着する(25fps)', () => {
		expect(nearestFrame(PAL4, 0.055)).toBe(1); // |0.055−0.04| < |0.08−0.055|
		expect(nearestFrame(PAL4, 0.07)).toBe(2); // |0.07−0.08| < |0.07−0.04|
		expect(nearestFrame(PAL4, 0.08)).toBe(2); // 境界ちょうど
	});

	test('範囲外は 0〜末尾へ clamp', () => {
		expect(nearestFrame(PAL4, -1)).toBe(0);
		expect(nearestFrame(PAL4, 9)).toBe(3);
	});

	test('VFR の不等間隔でも最寄りへ吸着する', () => {
		expect(nearestFrame(VFR, 1.0)).toBe(2); // 0.6 まで 0.4 < 2.0 まで 1.0
		expect(nearestFrame(VFR, 1.5)).toBe(3); // 2.0 まで 0.5 < 0.6 まで 0.9
	});

	test('吸着→半フレームシークの合成(解放 0.055s → frame1 → シーク先 0.06s)', () => {
		expect(seekTimeForFrame(PAL4, nearestFrame(PAL4, 0.055))).toBeCloseTo(0.06, 10);
	});
});

// ---------------------------------------------------------------------------
// frameKeyAction — Space/矢印の割り当てと縮退(契約④⑤⑥⑦⑧)
// ---------------------------------------------------------------------------

describe('frameKeyAction — キー割り当て(要件#37 契約④⑤⑧)', () => {
	test('Space は再生/停止トグル(フレーム情報の有無によらず=縮退でも動く)', () => {
		expect(frameKeyAction(' ', false, NTSC)).toEqual({ kind: 'toggle-play' });
		expect(frameKeyAction(' ', false, null)).toEqual({ kind: 'toggle-play' });
	});

	test('←/→ は ±1 フレーム', () => {
		expect(frameKeyAction('ArrowRight', false, NTSC)).toEqual({ kind: 'step', frames: 1 });
		expect(frameKeyAction('ArrowLeft', false, NTSC)).toEqual({ kind: 'step', frames: -1 });
	});

	test('Shift+←/→ は ±LARGE_FRAME_STEP(=±10)フレーム', () => {
		expect(frameKeyAction('ArrowRight', true, NTSC)).toEqual({
			kind: 'step',
			frames: LARGE_FRAME_STEP,
		});
		expect(frameKeyAction('ArrowLeft', true, NTSC)).toEqual({
			kind: 'step',
			frames: -LARGE_FRAME_STEP,
		});
	});

	test('フレーム情報なしの矢印は null(縮退=コマ送り不可。契約⑦)', () => {
		expect(frameKeyAction('ArrowRight', false, null)).toBeNull();
		expect(frameKeyAction('ArrowLeft', true, null)).toBeNull();
	});

	test('割り当て外のキーは null(J/K/L シャトルは契約⑥でスコープ外)', () => {
		expect(frameKeyAction('j', false, NTSC)).toBeNull();
		expect(frameKeyAction('k', false, NTSC)).toBeNull();
		expect(frameKeyAction('l', false, NTSC)).toBeNull();
		expect(frameKeyAction('Enter', false, NTSC)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// barCapabilities — 縮退時の出し分け(契約①⑦)
// ---------------------------------------------------------------------------

describe('barCapabilities — フレーム系機能の出し分け(要件#37 契約①⑦)', () => {
	test('フレーム情報なしは全 false(番号・SMPTE・コマ送りを出さない。再生/停止・シーク・ミリ秒時間は常設)', () => {
		expect(barCapabilities(null)).toEqual({
			frameStepping: false,
			frameReadout: false,
			smpteReadout: false,
		});
	});

	test('CFR は全機能あり', () => {
		expect(barCapabilities(NTSC)).toEqual({
			frameStepping: true,
			frameReadout: true,
			smpteReadout: true,
		});
	});

	test('VFR は SMPTE のみ非表示(番号・コマ送りは使える)', () => {
		expect(barCapabilities(VFR)).toEqual({
			frameStepping: true,
			frameReadout: true,
			smpteReadout: false,
		});
	});
});
