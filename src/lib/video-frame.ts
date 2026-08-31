/**
 * フレーム精度の位置計算(requirements.md #37)。
 *
 * 「動画ビューアをフレーム精度の編集下見に使えるようにする」のうち、DOM を持たない
 * 部分をここに集める(`video-viewing.ts` と同じ家風)。`VideoViewer.svelte` は
 * `<video>` と自作バーの描画だけを持ち、「いま何フレーム目か」「そのフレームへ跳ぶには
 * どこへシークするか」「この動画でフレーム機能を出してよいか」はすべてこの純関数群が答える。
 *
 * 設計の要は**フレーム番号が正本**であること(契約①)。表示する時間も SMPTE も
 * フレーム番号からの換算で、再生位置(`mediaTime`)そのものは表示しない。位置の解決も
 * `fps × 時間` の計算ではなく提示時刻列への表引き(契約③)で行う — 丸めが混じらない
 * ぶん表示と実フレームが構造的に一致し、そもそも fps が一定でない動画でも同じ式で通る。
 *
 * フレーム情報は Rust の `get_video_frame_index`(`src-tauri/src/commands/video.rs`)
 * から届く。得られない動画(webm・音声のみ・解析不能な MP4/MOV)は `null` で、
 * バーはフレーム系だけを畳んで再生を続ける(契約⑦ fail-open)。
 */
import { invoke } from '$lib/ipc';

/**
 * Shift+←/→ の歩幅(契約④)。±1 側は固定で、粗い方の歩幅だけをここで調整できる。
 */
export const LARGE_FRAME_STEP = 10;

/**
 * Rust コマンド `get_video_frame_index` の応答(serde camelCase)。
 * 時間の単位は ticks で、秒に直すには `timescale` で割る。
 */
export type VideoFrameIndexPayload = {
	/** ticks/秒(mdhd timescale)。 */
	timescale: number;
	/** 各フレームの提示開始時刻(ticks・昇順)。添字がフレーム番号(0起点)。 */
	sampleTimes: number[];
	/** 最終フレームの提示終了時刻(ticks)。 */
	duration: number;
	fpsNum: number;
	fpsDen: number;
	isCfr: boolean;
};

/** 秒に直したフレーム索引。UI 側はこちらだけを見る。 */
export type FrameIndex = {
	/** 各フレームの提示開始時刻(秒・昇順)。添字がフレーム番号(0起点)。 */
	times: number[];
	/** 最終フレームの提示終了時刻(秒)。 */
	duration: number;
	fpsNum: number;
	fpsDen: number;
	/** 一定フレームレートか。SMPTE 表記の可否(契約①)。 */
	isCfr: boolean;
};

/** キー入力が意味する操作(契約④⑧)。 */
export type FrameKeyAction = { kind: 'toggle-play' } | { kind: 'step'; frames: number };

/** バーに出してよいフレーム系機能(契約⑦)。 */
export type BarCapabilities = {
	frameStepping: boolean;
	frameReadout: boolean;
	smpteReadout: boolean;
};

/**
 * コマンド応答を秒の索引に直す。フレーム機能を成立させられない応答は `null`。
 *
 * Rust 側も「Some なら1フレーム以上」を守っているが、0除算とフレーム0件はここでも
 * 弾く — この関数が返した `FrameIndex` は以降どこでも `times[0]` が在ることを前提に
 * 使われるため、不変条件は境界の内側で閉じておく。
 */
export function frameIndexFromPayload(
	payload: VideoFrameIndexPayload | null | undefined,
): FrameIndex | null {
	if (!payload) return null;
	const { timescale, sampleTimes } = payload;
	if (!(timescale > 0) || sampleTimes.length === 0) return null;

	return {
		times: sampleTimes.map((ticks) => ticks / timescale),
		duration: payload.duration / timescale,
		fpsNum: payload.fpsNum,
		fpsDen: payload.fpsDen,
		isCfr: payload.isCfr,
	};
}

/**
 * 表示中の動画のフレーム索引を取りに行く(1文書につき1回)。
 *
 * 失敗しても投げない: フレーム情報が無いことと再生できないことは別で、解析に失敗した
 * 動画も再生・シーク・ミリ秒時間までは動く(契約⑦ fail-open)。
 */
export async function loadFrameIndex(uri: string): Promise<FrameIndex | null> {
	try {
		const payload = await invoke<VideoFrameIndexPayload | null>('get_video_frame_index', {
			uri,
		});
		return frameIndexFromPayload(payload);
	} catch {
		return null;
	}
}

/**
 * 再生位置(`requestVideoFrameCallback` の `mediaTime`)が何フレーム目か(契約③)。
 *
 * 提示時刻列への表引き — `times[i] <= mediaTime` を満たす最大の `i`。列は昇順なので
 * 二分探索で足りる(4K の長尺は数十万フレームになり、線形走査は毎フレーム走らせるには重い)。
 */
export function frameNumberForMediaTime(index: FrameIndex, mediaTime: number): number {
	const { times } = index;
	const last = times.length - 1;
	// 先頭より手前(負値・NaN を含む)は 0、末尾以降は最終フレーム。
	if (!(mediaTime > times[0])) return 0;
	if (mediaTime >= times[last]) return last;

	// 不変条件: times[lo] <= mediaTime < times[hi]。
	let lo = 0;
	let hi = last;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (times[mid] <= mediaTime) lo = mid;
		else hi = mid;
	}
	return lo;
}

/** 2桁ゼロ詰め。 */
function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

/**
 * 秒 → `HH:MM:SS.mmm`(契約①)。
 *
 * ミリ秒は**最近接へ丸める**。床関数だと 3/25 秒(=120ms ちょうど)のような値が
 * 浮動小数点の誤差で 119ms に落ちることがあり、フレーム境界の時間表記が 1ms 手前に
 * ずれて見える。
 */
export function formatMilliTime(seconds: number): string {
	const totalMs = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : 0;
	const ms = totalMs % 1000;
	const totalSeconds = (totalMs - ms) / 1000;
	return `${pad2(Math.floor(totalSeconds / 3600))}:${pad2(Math.floor(totalSeconds / 60) % 60)}:${pad2(totalSeconds % 60)}.${String(ms).padStart(3, '0')}`;
}

/** フレーム番号を 0〜末尾へ収める。 */
function clampFrame(index: FrameIndex, frame: number): number {
	const last = index.times.length - 1;
	if (!(frame > 0)) return 0;
	return Math.min(Math.floor(frame), last);
}

/**
 * SMPTE の FF 基数。29.97fps は 30・23.976fps は 24 と、名目 fps を四捨五入した整数。
 *
 * ノンドロップのタイムコードは「1秒 = 基数フレーム」で数えるので、実時間とは
 * 少しずつずれていく(29.97 の 1800 フレーム目が 00:01:00:00 になる)。それが
 * ノンドロップの定義であって誤差ではない。
 */
function smpteFrameBase(index: FrameIndex): number {
	const base = Math.round(index.fpsNum / index.fpsDen);
	return base > 0 ? base : 1;
}

/**
 * フレーム番号 → `HH:MM:SS:FF`(ノンドロップ固定・契約①)。
 *
 * 可変フレームレートでは1秒あたりのフレーム数が決まらず、タイムコード自体が
 * 定義されない。`null` を返して表示から落とす。
 */
export function formatSmpte(index: FrameIndex, frame: number): string | null {
	if (!index.isCfr) return null;

	const base = smpteFrameBase(index);
	const n = clampFrame(index, frame);
	const ff = n % base;
	const totalSeconds = (n - ff) / base;
	return `${pad2(Math.floor(totalSeconds / 3600))}:${pad2(Math.floor(totalSeconds / 60) % 60)}:${pad2(totalSeconds % 60)}:${pad2(ff)}`;
}

/**
 * 現在位置の3表記(契約①③)。
 *
 * 時間表記は**フレームの提示時刻**からの換算で、渡された `mediaTime` そのものではない。
 * 再生位置はフレームの途中にも来るが、カット位置として意味を持つのはフレームの頭で、
 * 3つの表記が同じ1点を指していなければ下見の役に立たない。
 */
export function describePosition(
	index: FrameIndex,
	mediaTime: number,
): { frame: number; frameText: string; timeText: string; smpteText: string | null } {
	const frame = frameNumberForMediaTime(index, mediaTime);
	return {
		frame,
		frameText: `#${frame}`,
		timeText: formatMilliTime(index.times[frame]),
		smpteText: formatSmpte(index, frame),
	};
}

/**
 * 目的のフレームを表示させるためのシーク先(秒・契約④)。
 *
 * 提示時刻ちょうどではなく**フレームの真ん中**へ跳ぶ。境界そのものは丸め次第で手前の
 * フレームに落ちることがあり、1回のコマ送りが空振りして見える。半フレーム内側なら
 * どちらへ転んでも目的のフレームに入る(コマ送りの定石)。
 */
export function seekTimeForFrame(index: FrameIndex, frame: number): number {
	const n = clampFrame(index, frame);
	const start = index.times[n];
	// 最終フレームの継続時間だけは次の提示時刻が無いので、全体の提示終了時刻から測る。
	const next = n + 1 < index.times.length ? index.times[n + 1] : index.duration;
	return start + Math.max(0, next - start) / 2;
}

/**
 * 索引の取れない動画の初期シーク先(秒・要件#39 契約③の縮退)。
 *
 * 0 ではなく「0 より大きい微小値」であることが要点 — 初期位置 0 への同位置シークは
 * WebKit が「もうそこに居る」と見て描画なしで済ませ得る(開いた直後が黒のままという
 * 要件#39 の現象そのもの)。0.0001 秒なら現実的な上限の 240fps(先頭フレームの継続は
 * 約 4.2ms)でも先頭フレームの内側に収まり、`formatMilliTime` の最近接丸めでも
 * 時間表示は `00:00:00.000` のまま(契約④の表示と整合)。
 */
const DEGRADED_INITIAL_SEEK_SECONDS = 0.0001;

/**
 * 動画を開いた直後に `<video>.currentTime` へ代入する初期シーク先(秒・要件#39)。
 *
 * 開いたばかりの `<video>` は最初のフレームを描かず黒いままなので、こちらから一度
 * 先頭フレームの中へ跳ばせて静止表示にする。索引があれば `seekTimeForFrame(index, 0)`
 * と同じ半フレーム内側へ、無ければ微小シークへ落とす(契約③・fail-open)。
 *
 * `<video>` を受け取らないシグネチャは意図したもので、この関数からは再生状態
 * (`play` / `pause` / `muted`)に触れられない — 自動再生しない・音を出さないという
 * 契約②を型で担保する(`planSelectionCopy` と同じ家風)。
 */
export function initialSeekTime(index: FrameIndex | null): number {
	return index ? seekTimeForFrame(index, 0) : DEGRADED_INITIAL_SEEK_SECONDS;
}

/** `fromFrame` から `deltaFrames` 進めた番号(0〜末尾へ clamp・契約④)。 */
export function stepFrame(index: FrameIndex, fromFrame: number, deltaFrames: number): number {
	return clampFrame(index, fromFrame + deltaFrames);
}

/**
 * その時刻に最も近いフレーム境界の番号(契約⑤)。
 *
 * シークバーを離した位置の吸着に使う。ドラッグ中は粗く追従し、離した瞬間にフレームへ
 * 揃える — 掴んだまま毎フレーム精密シークすると重く、また指を離した位置が
 * フレームの途中だと、そこから始めるコマ送りが半端な位置を基準にしてしまう。
 */
export function nearestFrame(index: FrameIndex, time: number): number {
	const lower = frameNumberForMediaTime(index, time);
	const upper = Math.min(lower + 1, index.times.length - 1);
	if (upper === lower) return lower;
	return time - index.times[lower] <= index.times[upper] - time ? lower : upper;
}

/**
 * キー入力の割り当て(契約④⑧)。呼ぶのは動画ペインにフォーカスがあるときだけ
 * (ゲートは呼び出し側=`VideoViewer.svelte`)。
 *
 * Space はフレーム情報の有無によらず効く: 縮退した動画でも再生/停止はバーの常設機能
 * (契約⑦)。矢印は跳ぶ先が決まらないので `null` を返して既定の動作に委ねる。
 */
export function frameKeyAction(
	key: string,
	shiftKey: boolean,
	index: FrameIndex | null,
): FrameKeyAction | null {
	if (key === ' ') return { kind: 'toggle-play' };
	if (!index) return null;

	const frames = shiftKey ? LARGE_FRAME_STEP : 1;
	if (key === 'ArrowRight') return { kind: 'step', frames };
	if (key === 'ArrowLeft') return { kind: 'step', frames: -frames };
	return null;
}

/**
 * この動画でバーに出してよいフレーム系機能(契約⑦)。
 *
 * 再生/停止・シーク・ミリ秒時間はここに含まれない — どの動画でも常設で、
 * フレーム情報の有無で消えるのは番号・SMPTE・コマ送りだけ。
 */
export function barCapabilities(index: FrameIndex | null): BarCapabilities {
	if (!index) {
		return { frameStepping: false, frameReadout: false, smpteReadout: false };
	}
	return { frameStepping: true, frameReadout: true, smpteReadout: index.isCfr };
}
