/**
 * 音声波形帯の時間軸ズーム(requirements.md #47)。
 *
 * 「音声波形帯(要件#41〜#45)を時間軸方向に拡大縮小できるようにする: 拡大時は帯を
 *  窓表示にして横スクロールでき、拡大した状態でもクリックで映像ごとその位置へジャンプ
 *  できる」の判定を一箇所に集める(契約⑧・`waveform-resize.ts` と同じ家風=状態を
 * 持たない純関数モジュール)。`VideoViewer.svelte` は配線だけを持ち、「いま何倍か」
 * 「窓はどこから始まるか」「押した x はどの時刻か」「ヘッドは見えているか」は
 * すべてここが答える。
 *
 * 設計の要は3つ。
 *
 * 1. **窓は倍率と開始位置の2値で表す**(契約②)。倍率 1 =全尺が帯幅に収まる状態で、
 *    窓の実尺は `duration / zoom`。この形にすると「倍率 1 のとき窓 = 全尺」が
 *    定義から従い、**既存の横軸(要件#41 契約②)と等倍で完全一致**する等式契約
 *    (`windowXToTime ≡ xToSeconds` / `windowTimeToX ≡ positionToX`)を丸め誤差なしで
 *    保てる ―― 拡大機能を足したせいで等倍の挙動が変わることが無い、を機械で示すため
 * 2. **拡大はアンカー(ポインタ)の時刻を固定点にする**(契約④)。倍率だけ変えて
 *    窓の開始をそのままにすると、見ていた山が画面の外へ逃げる。`zoomWaveformAtAnchor`
 *    は「x に対応する時刻が前後で同じ x に留まる」を保つように開始位置を解き直す
 * 3. **どの関数も throw しない**(要件#41 契約⑤と同じ fail-open)。退化した入力
 *    (幅 0・尺 0・NaN)には「拡大しない・動かさない・描かない」側の値を返す ――
 *    波形が読めないことと再生できないことは別で、帯の都合で再生を止めない
 *
 * `extractPeaks` / `WAVEFORM_BUCKETS` は `audio-waveform.ts` から借り、逆に
 * `analyzeWaveform` は `buildCoarsePeaks` / `WAVEFORM_MAX_RETAINED_SAMPLES` を
 * こちらから借りる(2モジュールは相互参照になる)。参照はすべて**関数本体の中**で、
 * モジュール評価時に相手の束縛を読む箇所は無い ―― どちらから先に読み込まれても
 * TDZ に当たらない形に閉じてある。
 */
import { WAVEFORM_BUCKETS, extractPeaks, type WaveformPeaks } from './audio-waveform';
import { nearestFrame, seekTimeForFrame, type FrameIndex } from './video-frame';

// ---------------------------------------------------------------------------
// 定数(契約②④⑦)
// ---------------------------------------------------------------------------

/**
 * 窓の実尺の下限(秒・契約②)。
 *
 * 解析は 8kHz なので 0.25 秒 = 2000 サンプル ―― `WAVEFORM_BUCKETS` と同数で、
 * 「1バケット1サンプル」がちょうど底になる。これ以上寄っても新しい情報は出ない
 * (バケットが標本より細かくなるだけ)ので、そこを上限倍率の定義に使う。
 */
export const WAVEFORM_MIN_WINDOW_SECONDS = 0.25;

/**
 * 生サンプルを保持してよい総数(契約②⑦)。float32 で 256MiB 相当。
 *
 * 超えた素材は粗レベルだけを持ち、上限倍率が下がる(縮退=fail-open)。窓の再バケット化に
 * 生サンプルが要るのは深い倍率のときだけなので、失うのは「深く寄れること」であって
 * 波形そのものではない。
 */
export const WAVEFORM_MAX_RETAINED_SAMPLES = (256 * 1024 * 1024) / 4;

/**
 * 粗レベル(min/max)の刻み(サンプル数・契約⑦)。
 *
 * 512 サンプル = 8kHz で 64ms。粗レベルだけでも 2000 バケット × 512 = 128 秒ぶんの窓が
 * 「1バケット1粗レベル要素」で描ける ―― `waveformMinWindowSeconds` の縮退値がこれ。
 */
export const WAVEFORM_COARSE_STEP = 512;

/** `deltaMode: 1`(行単位)1行あたりのピクセル相当(契約④)。 */
export const WAVEFORM_WHEEL_LINE_PIXELS = 16;

/** `deltaMode: 2`(ページ単位)1ページあたりのピクセル相当(契約④)。 */
export const WAVEFORM_WHEEL_PAGE_PIXELS = 800;

/**
 * このピクセル量で倍率がちょうど 2 倍になる(契約④)。
 *
 * 指数写像にするのは、ホイールの刻みが荒くても細かくても**合成が一回分と一致する**
 * ため(`f(a+b) = f(a)×f(b)`)。トラックパッドの慣性で細かい delta が連続しても、
 * 一気に回したときと同じところへ着く。
 */
export const WAVEFORM_WHEEL_ZOOM_PIXELS = 240;

// ---------------------------------------------------------------------------
// 倍率(契約②)
// ---------------------------------------------------------------------------

/** 正の有限数か(退化入力の門番。0 と負と NaN と ±Infinity を落とす)。 */
function isPositiveFinite(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

/**
 * この素材で許される窓の下限(秒・契約②⑦)。
 *
 * 生サンプルを持っていれば `WAVEFORM_MIN_WINDOW_SECONDS`。粗レベルしか持っていない
 * (保持上限を超えた素材)ときは、粗レベルの1要素より細かくは描けないので
 * 「2000 バケット × 512 サンプル」ぶんの秒数で止める ―― そこから先へ寄っても
 * 同じ値が引き伸ばされるだけで、嘘の解像度を見せることになる。
 */
export function waveformMinWindowSeconds(coarseOnly: boolean, sampleRate: number): number {
	if (!coarseOnly) return WAVEFORM_MIN_WINDOW_SECONDS;
	if (!isPositiveFinite(sampleRate)) return WAVEFORM_MIN_WINDOW_SECONDS;
	const coarseFloor = (WAVEFORM_BUCKETS * WAVEFORM_COARSE_STEP) / sampleRate;
	return Math.max(WAVEFORM_MIN_WINDOW_SECONDS, coarseFloor);
}

/**
 * 上限倍率(契約②)。窓の実尺が下限を割らない最大値 = `duration / minWindowSeconds`。
 *
 * 尺が下限以下の短い素材(0.25 秒未満)は拡大の余地が無いので 1 ―― 「ズームできない」を
 * 上限 1 で表すと、以降の clamp が特別扱い無しでそのまま効く。
 */
export function maxWaveformZoom(
	durationSeconds: number,
	minWindowSeconds: number = WAVEFORM_MIN_WINDOW_SECONDS,
): number {
	if (!isPositiveFinite(durationSeconds)) return 1;
	if (!isPositiveFinite(minWindowSeconds)) return 1;
	const max = durationSeconds / minWindowSeconds;
	return max > 1 ? max : 1;
}

/**
 * 倍率を [1, 上限] へ収める(契約②)。
 *
 * ボタンの ×2 / ÷2 も、ホイールの連続倍率も、通り道はここ1本 ―― 「2倍を押し続けたら
 * 上限で止まり、等倍ボタンで 1 に戻る」が倍率の側の規則だけで決まる。
 *
 * `NaN` だけは 1 へ倒す(`Math.min/max` は NaN を伝播させるので明示的に落とす)。
 * `±Infinity` は比較が効くので clamp に任せる ―― 上限/下限そのものに落ちる。
 */
export function clampWaveformZoom(
	zoom: number,
	durationSeconds: number,
	minWindowSeconds: number = WAVEFORM_MIN_WINDOW_SECONDS,
): number {
	if (Number.isNaN(zoom)) return 1;
	const max = maxWaveformZoom(durationSeconds, minWindowSeconds);
	return Math.min(Math.max(zoom, 1), max);
}

/**
 * 窓の実尺(秒・契約②)。倍率 1 なら全尺そのもの。
 *
 * 倍率が 1 未満・非有限のときは 1 として扱う(縮小方向へは行かない=帯より広い窓は
 * 意味を持たない)。尺が退化していれば 0 ―― 窓が無いことを 0 で表すと、以降の
 * 「窓 ≥ 全尺なら倍率 1 扱い」の判定にそのまま乗る。
 */
export function waveformWindowSeconds(zoom: number, durationSeconds: number): number {
	if (!isPositiveFinite(durationSeconds)) return 0;
	const factor = Number.isFinite(zoom) && zoom > 1 ? zoom : 1;
	return durationSeconds / factor;
}

/**
 * 窓の開始位置を [0, 尺 − 窓幅] へ収める(契約②)。
 *
 * 窓が全尺以上(倍率 1)なら 0 に固定 ―― 動かせる余地が無いのだから、横スクロールを
 * どれだけ回しても先頭のまま。`NaN` は 0 へ倒し、`±Infinity` は clamp に任せる。
 */
export function clampWaveformWindowStart(
	windowStart: number,
	windowSeconds: number,
	durationSeconds: number,
): number {
	const max = durationSeconds - windowSeconds;
	if (!isPositiveFinite(max)) return 0;
	if (Number.isNaN(windowStart)) return 0;
	return Math.min(Math.max(windowStart, 0), max);
}

/** 帯の x を [0, width] の割合へ(退化した幅では 0 =先頭を指す)。 */
function anchorFraction(x: number, width: number): number {
	if (!isPositiveFinite(width)) return 0;
	if (!Number.isFinite(x)) return 0;
	return Math.min(Math.max(x, 0), width) / width;
}

/**
 * アンカー(ポインタ位置)を固定して倍率を変える(契約②④)。
 *
 * 押している場所の時刻 `t` が、倍率変更の**前後で同じ x に留まる**ように窓の開始を
 * 解き直す ―― `t = start + f × windowSeconds` を `start` について解くだけ
 * (`f` は帯の中の割合)。ボタン操作は `nextZoom` に `zoom×2` / `zoom÷2` / `1` を
 * 渡すだけでよく、アンカーを窓の中央にすれば「中央を保ったまま拡大」になる。
 *
 * 端では clamp が勝つ(アンカーより境界が優先)―― 窓を尺の外へはみ出させてまで
 * アンカーを守ると、存在しない時間を描くことになる。等倍まで戻ったときは窓の
 * 概念そのものが消えるので開始は 0。
 */
export function zoomWaveformAtAnchor(
	zoom: number,
	windowStart: number,
	nextZoom: number,
	anchorX: number,
	width: number,
	durationSeconds: number,
	minWindowSeconds: number = WAVEFORM_MIN_WINDOW_SECONDS,
): { zoom: number; windowStart: number } {
	const resolved = clampWaveformZoom(nextZoom, durationSeconds, minWindowSeconds);
	if (resolved <= 1) return { zoom: 1, windowStart: 0 };

	const currentSeconds = waveformWindowSeconds(zoom, durationSeconds);
	const fraction = anchorFraction(anchorX, width);
	const anchorTime = windowXToTime(anchorX, width, windowStart, currentSeconds);

	const nextSeconds = waveformWindowSeconds(resolved, durationSeconds);
	const nextStart = anchorTime - fraction * nextSeconds;
	return {
		zoom: resolved,
		windowStart: clampWaveformWindowStart(nextStart, nextSeconds, durationSeconds),
	};
}

// ---------------------------------------------------------------------------
// ホイール(契約④)
// ---------------------------------------------------------------------------

/**
 * `WheelEvent` の delta をピクセル相当へ揃える(契約④)。
 *
 * `deltaMode` は環境で変わる(トラックパッドは pixel・マウスホイールは line を返す
 * ブラウザがある)。指数写像に食わせる前にここで一本化しておかないと、同じ一回しが
 * 環境ごとに違う倍率になる。知らない `deltaMode` は pixel 扱い(fail-open)。
 */
export function normalizeWheelDelta(delta: number, deltaMode: number): number {
	if (!Number.isFinite(delta)) return 0;
	if (deltaMode === 1) return delta * WAVEFORM_WHEEL_LINE_PIXELS;
	if (deltaMode === 2) return delta * WAVEFORM_WHEEL_PAGE_PIXELS;
	return delta;
}

/**
 * ホイール量 → 倍率の掛け算係数(契約②④)。`2^(−d / 240)`。
 *
 * 上へ回す(`deltaY < 0`)と 1 より大きい=拡大。指数にするので `f(a+b) = f(a)×f(b)` が
 * 成り立ち、慣性で細かく刻まれた delta の合成が一回分と一致する。非有限は 1
 * (倍率を動かさない)。
 */
export function wheelZoomFactor(deltaPixels: number): number {
	if (!Number.isFinite(deltaPixels)) return 1;
	return Math.pow(2, -deltaPixels / WAVEFORM_WHEEL_ZOOM_PIXELS);
}

/**
 * 窓の横送り(契約④)。帯のピクセル移動量を窓の時間へ写す。
 *
 * `delta` が正で後ろ(未来)へ ―― 帯の中身が左へ流れる向き。移動量を窓の実尺に比例
 * させるので、深く寄るほど一回しで進む秒数が短くなる(見えている幅ぶんで一定)。
 * 幅が退化しているとき・delta が非有限のときは動かさないが、**clamp は掛ける** ――
 * 範囲外の開始位置を持ち込まないため。
 */
export function scrollWaveformWindow(
	windowStart: number,
	windowSeconds: number,
	durationSeconds: number,
	deltaPixels: number,
	width: number,
): number {
	if (!isPositiveFinite(width) || !Number.isFinite(deltaPixels)) {
		return clampWaveformWindowStart(windowStart, windowSeconds, durationSeconds);
	}
	const moved = windowStart + (deltaPixels / width) * windowSeconds;
	return clampWaveformWindowStart(moved, windowSeconds, durationSeconds);
}

// ---------------------------------------------------------------------------
// 座標往復(契約⑤⑧)
// ---------------------------------------------------------------------------

/**
 * 帯の x → 時刻(契約⑧)。窓 `[windowStart, windowStart + windowSeconds]` の線形写像。
 *
 * **等倍(`windowStart = 0` / `windowSeconds = duration`)のとき `xToSeconds` と
 * 完全に一致する**(退化入力も含む・契約⑤の等式契約)―― 拡大機能を足したせいで
 * 等倍のクリック位置が動かないことを、丸めの都合ではなく式の同一性で保証する。
 * 退化しているときは窓の先頭(fail-open)。
 */
export function windowXToTime(
	x: number,
	width: number,
	windowStart: number,
	windowSeconds: number,
): number {
	if (!isPositiveFinite(width)) return windowStart;
	if (!isPositiveFinite(windowSeconds)) return windowStart;
	if (!Number.isFinite(x)) return windowStart;

	const clamped = Math.min(Math.max(x, 0), width);
	return windowStart + (clamped / width) * windowSeconds;
}

/**
 * 時刻 → 帯の x(契約⑧)。`windowXToTime` の逆で、往復すると元へ戻る。
 *
 * 窓の外の時刻は端の x に丸める。等倍のとき `positionToX` と完全に一致する
 * (契約⑤の等式契約)。退化・非有限は 0。
 */
export function windowTimeToX(
	time: number,
	width: number,
	windowStart: number,
	windowSeconds: number,
): number {
	if (!isPositiveFinite(width)) return 0;
	if (!isPositiveFinite(windowSeconds)) return 0;
	if (!Number.isFinite(time)) return 0;

	const clamped = Math.min(Math.max(time, windowStart), windowStart + windowSeconds);
	return ((clamped - windowStart) / windowSeconds) * width;
}

/**
 * 拡大状態のクリックシーク先(秒・契約⑤)。
 *
 * 窓を通して時刻へ直したあとは**要件#37 の吸着経路をそのまま通す**
 * (`nearestFrame` → `seekTimeForFrame`)―― 拡大していてもシークバーを離したときと
 * 同じフレームに着く。索引の無い動画は時刻そのまま(fail-open)。
 *
 * 等倍のときは既存 `waveformSeekTime` と完全に一致する(契約⑤の等式契約)。
 */
export function waveformZoomSeekTime(
	x: number,
	width: number,
	windowStart: number,
	windowSeconds: number,
	index: FrameIndex | null,
): number {
	const t = windowXToTime(x, width, windowStart, windowSeconds);
	if (!index) return t;
	return seekTimeForFrame(index, nearestFrame(index, t));
}

// ---------------------------------------------------------------------------
// 再生ヘッドと追従(契約⑥)
// ---------------------------------------------------------------------------

/**
 * 再生ヘッドの x、または `null` =窓の外(契約⑥)。
 *
 * 窓の外を `positionToX` のように端へ clamp すると、**居ない場所にヘッドが立つ** ――
 * 拡大中は窓の外が大半なので、端に貼り付いたヘッドは「ここに居る」という嘘になる。
 * 描かないほうが読み手を騙さない。両端はちょうど窓の内側(x = 0 / x = width)。
 */
export function waveformZoomHeadX(
	seconds: number,
	windowStart: number,
	windowSeconds: number,
	width: number,
): number | null {
	if (!Number.isFinite(seconds) || !Number.isFinite(windowStart)) return null;
	if (!isPositiveFinite(windowSeconds) || !isPositiveFinite(width)) return null;
	if (seconds < windowStart || seconds > windowStart + windowSeconds) return null;
	return ((seconds - windowStart) / windowSeconds) * width;
}

/**
 * 再生位置に窓を追従させる(契約⑥)。
 *
 * 窓の中に居る間は動かさない ―― 毎フレーム窓が動くと波形が流れ続けて形が読めない。
 * 外へ出た瞬間だけ、**再生位置が窓の先頭に来る**ように送る(これから来る側を見せる)。
 * 巻き戻し・クリックシークで後ろへ出たときも同じ規則が効き、窓は跳ぶ。
 *
 * 非有限の位置は「判らない」なので現状維持(ただし clamp 済みの値を返す)。
 */
export function followWaveformWindow(
	position: number,
	windowStart: number,
	windowSeconds: number,
	durationSeconds: number,
): number {
	const stay = clampWaveformWindowStart(windowStart, windowSeconds, durationSeconds);
	if (!Number.isFinite(position)) return stay;
	if (position >= windowStart && position <= windowStart + windowSeconds) return stay;
	return clampWaveformWindowStart(position, windowSeconds, durationSeconds);
}

// ---------------------------------------------------------------------------
// シークバーへ重ねる窓指標(契約③)
// ---------------------------------------------------------------------------

/**
 * シークバー(全尺のまま据え置き)に重ねる窓指標の幾何(契約③・案B)。
 *
 * 帯だけが窓を映すので、**全体のどこを見ているか**はシークバーの側が語る。倍率 1 では
 * 窓 = 全尺で語ることが無いから `null`(指標を出さない)―― 常に全幅の枠が出ていると、
 * 拡大しているのかどうかが見た目から消える。
 */
export function waveformWindowIndicator(
	windowStart: number,
	windowSeconds: number,
	durationSeconds: number,
	barWidth: number,
): { left: number; width: number } | null {
	if (!isPositiveFinite(durationSeconds) || !isPositiveFinite(barWidth)) return null;
	if (!isPositiveFinite(windowSeconds)) return null;
	if (windowSeconds >= durationSeconds) return null;

	const start = clampWaveformWindowStart(windowStart, windowSeconds, durationSeconds);
	return {
		left: (start / durationSeconds) * barWidth,
		width: (windowSeconds / durationSeconds) * barWidth,
	};
}

// ---------------------------------------------------------------------------
// 窓の再バケット化(契約⑦⑧)
// ---------------------------------------------------------------------------

/**
 * 窓に対応する標本の半開区間 `[from, to)`(契約⑧)。
 *
 * 先頭は `floor`・末尾は `ceil` ―― どちらも**窓を欠けさせない向き**へ丸める。窓の端に
 * ある山が丸めで消えると、カット位置を1サンプル単位で詰めているときに嘘になる。
 * 常に整数で `0 ≤ from ≤ to ≤ totalSamples` なので、そのまま添字に使える。
 */
export function waveformSampleRange(
	sampleRate: number,
	windowStart: number,
	windowSeconds: number,
	totalSamples: number,
): { from: number; to: number } {
	if (!isPositiveFinite(sampleRate) || !Number.isFinite(totalSamples) || totalSamples <= 0) {
		return { from: 0, to: 0 };
	}
	if (!Number.isFinite(windowStart) || !Number.isFinite(windowSeconds)) {
		return { from: 0, to: 0 };
	}

	const total = Math.floor(totalSamples);
	const rawFrom = Math.floor(windowStart * sampleRate);
	const rawTo = Math.ceil((windowStart + windowSeconds) * sampleRate);
	const from = Math.min(Math.max(rawFrom, 0), total);
	const to = Math.min(Math.max(rawTo, from), total);
	return { from, to };
}

/**
 * 窓のサンプルを既存 `extractPeaks` の規則でバケット化する(契約⑦)。
 *
 * 切り出しは `subarray`(**写しを作らない**)―― 深い倍率ではこれが毎描画走るので、
 * 数十万サンプルを都度コピーする理由がない。`extractPeaks` は読むだけなので、
 * ビューを渡しても入力は書き換わらない。
 *
 * 窓が全尺・`buckets = WAVEFORM_BUCKETS` のときは `extractPeaks(samples, WAVEFORM_BUCKETS)`
 * と完全に一致する ―― 拡大機能を足しても等倍の帯の絵が変わらない、を式の同一性で保つ。
 */
export function windowPeaks(
	samples: Float32Array,
	sampleRate: number,
	windowStart: number,
	windowSeconds: number,
	buckets: number,
): WaveformPeaks {
	const { from, to } = waveformSampleRange(sampleRate, windowStart, windowSeconds, samples.length);
	return extractPeaks(samples.subarray(from, to), buckets);
}

/**
 * 粗レベル(`WAVEFORM_COARSE_STEP` 刻みの min/max)を作る(契約⑦)。
 *
 * 生サンプルを捨てざるを得ない素材(保持上限超過)でも、これがあれば窓の包絡は描ける。
 * 512 サンプルで 1 要素なのでメモリは 1/256 になり、失うのは深い倍率での精度だけ。
 * 非有限の標本は 0 扱い(`extractPeaks` と同じ防御)・入力は書き換えない。
 */
export function buildCoarsePeaks(samples: Float32Array): WaveformPeaks {
	const total = samples.length;
	const n = Math.ceil(total / WAVEFORM_COARSE_STEP);

	const mins = new Float32Array(n);
	const maxs = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const from = i * WAVEFORM_COARSE_STEP;
		const to = Math.min(from + WAVEFORM_COARSE_STEP, total);
		let mn = 0;
		let mx = 0;
		for (let j = from; j < to; j++) {
			const v = Number.isFinite(samples[j]) ? samples[j] : 0;
			if (j === from) {
				mn = v;
				mx = v;
			} else {
				if (v < mn) mn = v;
				if (v > mx) mx = v;
			}
		}
		mins[i] = mn;
		maxs[i] = mx;
	}
	return { mins, maxs };
}

/**
 * 粗レベルから窓の包絡を作る(契約⑦の縮退経路)。
 *
 * バケットに対応する標本範囲を**含むだけの粗レベル要素**(端は外側へ丸める)を畳むので、
 * 結果は生サンプル由来の包絡を**包含する**(min は同じか小さい・max は同じか大きい)。
 * 山を実際より小さく見せないことが要点 ―― 包絡が痩せる向きの誤差だと、あるはずの音が
 * 無いように見えてカット位置を外す。バケット本数は `windowPeaks` と揃える。
 *
 * 総標本数は粗レベルの長さから逆算する(端数は最後のチャンクに畳まれているので
 * `長さ × 512` は真の総数以上)―― 生サンプルが無い経路なので、これが唯一の手掛かり。
 */
export function windowPeaksFromCoarse(
	coarse: WaveformPeaks,
	sampleRate: number,
	windowStart: number,
	windowSeconds: number,
	buckets: number,
): WaveformPeaks {
	const coarseLength = Math.min(coarse.mins.length, coarse.maxs.length);
	const totalSamples = coarseLength * WAVEFORM_COARSE_STEP;
	const { from, to } = waveformSampleRange(sampleRate, windowStart, windowSeconds, totalSamples);

	const span = to - from;
	const n = buckets >= 1 ? Math.min(Math.floor(buckets), span) : 0;

	const mins = new Float32Array(n);
	const maxs = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		// バケットの標本範囲は extractPeaks と同じ境界の取り方(半開区間・floor)。
		const bucketFrom = from + Math.floor((i * span) / n);
		const bucketTo = from + Math.floor(((i + 1) * span) / n);
		if (bucketTo <= bucketFrom) continue; // 空のバケットは無音(0)として残す

		const chunkFrom = Math.floor(bucketFrom / WAVEFORM_COARSE_STEP);
		const chunkTo = Math.min(coarseLength, Math.ceil(bucketTo / WAVEFORM_COARSE_STEP));
		let mn = 0;
		let mx = 0;
		for (let c = chunkFrom; c < chunkTo; c++) {
			const lo = Number.isFinite(coarse.mins[c]) ? coarse.mins[c] : 0;
			const hi = Number.isFinite(coarse.maxs[c]) ? coarse.maxs[c] : 0;
			if (c === chunkFrom) {
				mn = lo;
				mx = hi;
			} else {
				if (lo < mn) mn = lo;
				if (hi > mx) mx = hi;
			}
		}
		mins[i] = mn;
		maxs[i] = mx;
	}
	return { mins, maxs };
}
