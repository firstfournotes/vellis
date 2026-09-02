/**
 * Waveform band height: clamp rules and persistence (requirements.md #42).
 *
 * 「音声波形帯(要件#41)の高さを既定 1.5 倍にし、帯の上端境界をドラッグで
 *  拡大・縮小できるようにする」の判定ロジックを一箇所に集める。ドラッグ中の
 * 高さ計算・起動時の復元・保存はすべてここを通り、コンポーネント側
 * (`VideoViewer.svelte`)は結果を反映するだけ。
 *
 * 契約(2026-09-02 由谷決定):
 * - 範囲 = 最小 40px 〜 ウインドウ高の 40%
 * - 既定 = 84px(現行 VideoViewer.svelte の 56px の 1.5 倍)
 * - 変更した高さは localStorage に保存し、再起動・新規ウインドウにも適用
 *
 * 状態はモジュール内に保持しない。各ウインドウは独立したページ読み込みであり、
 * 「保存済みの高さ」の唯一の在り処は localStorage である — `loadWaveformHeight`
 * は呼ばれるたびに localStorage を読む。
 */

/** 下限。これより低いと波形が判読できないため、常に優先される。 */
export const MIN_WAVEFORM_HEIGHT = 40;

/** 既定高。未保存時と、保存値が解釈不能だった場合のフォールバック。 */
export const DEFAULT_WAVEFORM_HEIGHT = 84;

/**
 * 保存キー。ウインドウ間・バージョン間で同じ値を読むため固定文字列とする
 * (`waveform-resize.acceptance.test.ts` が固定を担保)。
 */
export const WAVEFORM_HEIGHT_STORAGE_KEY = 'vellis.waveform-height';

/** 上限はウインドウ高のこの割合。映像側が過度に潰れないようにする。 */
const MAX_WAVEFORM_HEIGHT_RATIO = 0.4;

/**
 * `height` を [MIN_WAVEFORM_HEIGHT, windowHeight * 0.4] に収める。
 *
 * 上下限が逆転する低いウインドウ(windowHeight < 100)では最小が勝つ —
 * CSS が min-height と max-height の矛盾を解決する規則と同じ振る舞いで、
 * 「波形の判読性の下限を守る」という最小値の趣旨に沿う。
 *
 * 呼び出し側は有限数を渡すこと(非数値の吸収は `loadWaveformHeight` の責務)。
 */
export function clampWaveformHeight(height: number, windowHeight: number): number {
	const max = windowHeight * MAX_WAVEFORM_HEIGHT_RATIO;
	return Math.max(MIN_WAVEFORM_HEIGHT, Math.min(height, max));
}

/**
 * ドラッグ中の高さ(要件#43 契約④)。開始時に捕まえた `startHeight` と `freeSpace`
 * だけを基準にし、移動量 `d`(上向きが正)から高さを求める純関数。
 *
 * 中央寄せ(要件#43 契約①)では帯が Δh 伸びると塊の下端が Δh/2 下がるので、
 * 上端ハンドルの移動は Δh/2 にしかならない。指に 1:1 で追従させるには、自由余白が
 * 残る間は Δh = 2d。余白が尽きた後(d > t = freeSpace/2)は塊の下端が動かず
 * ハンドル移動 = Δh になるので、そこからは 1:1 の増分に切り替える折れ線になる。
 * d = t では両枝が 2t = freeSpace で一致し、段差ができない。
 *
 * 逐次の相対計算をしないのが要点 ―― clamp で切られてもポインタが戻れば同じ d が
 * 同じ高さに対応し、指と上端のずれ(ヒステリシス)が残らない。
 *
 * 呼び出し側は有限数・`freeSpace >= 0` を渡すこと(レイアウト実測の吸収は
 * 呼び出し側の責務 — `clampWaveformHeight` と同じ切り分け)。
 */
export function dragWaveformHeight(
	startHeight: number,
	d: number,
	freeSpace: number,
	windowHeight: number,
): number {
	const t = freeSpace / 2;
	const delta = d <= t ? 2 * d : freeSpace + (d - t);
	return clampWaveformHeight(startHeight + delta, windowHeight);
}

/**
 * localStorage への参照。Tauri の WebView 以外(テストの SSR 相当・
 * ストレージが無効なコンテキスト)でも例外で落とさないための保険。
 */
function storage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

/**
 * 高さを保存する。表現は数値文字列 — 別ウインドウ・別バージョンが
 * `Number(...)` だけで読めるようにするため。
 *
 * 非有限値(NaN / Infinity)は書かない。保存領域に解釈不能な値を持ち込まず、
 * 直前の正常な値も壊さない。
 */
export function saveWaveformHeight(height: number): void {
	if (!Number.isFinite(height)) return;
	try {
		storage()?.setItem(WAVEFORM_HEIGHT_STORAGE_KEY, String(height));
	} catch {
		// 保存に失敗しても表示中の高さは有効。次回が既定に戻るだけなので黙って諦める。
	}
}

/**
 * 保存済みの高さを現在のウインドウ高基準で clamp して返す。
 *
 * 解釈不能(未保存・空文字・非数値・非有限)のときだけ既定へ落とす。
 * 解釈できる有限数は範囲外でも既定に落とさず clamp で吸収する —
 * ウインドウが低くなった後の起動でも、保存値の意図(高め/低め)は残る。
 */
export function loadWaveformHeight(windowHeight: number): number {
	let raw: string | null = null;
	try {
		raw = storage()?.getItem(WAVEFORM_HEIGHT_STORAGE_KEY) ?? null;
	} catch {
		raw = null;
	}
	// Number('') === 0 なので、空(空白のみ含む)は数値化する前に弾く。
	const parsed = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
	const height = Number.isFinite(parsed) ? parsed : DEFAULT_WAVEFORM_HEIGHT;
	return clampWaveformHeight(height, windowHeight);
}
