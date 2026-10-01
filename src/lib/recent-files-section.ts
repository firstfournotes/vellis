/**
 * Recent Files の区画(requirements.md #64 契約6)の開閉と高さ: 範囲の規則・ドラッグと
 * クリックの判定・保存。
 *
 * 区画は Explorer の下端に積む折りたためる区画(VS Code の Outline / Timeline と同じ形)。
 * 見出し行のクリックで開閉し、開いているときは見出し行の上下ドラッグで高さを変える。
 * ドラッグ中の高さ計算・起動時の復元・保存はすべてここを通り、区画
 * (`RecentFiles.svelte`)は結果を反映するだけ(`pane-resize.ts`・`waveform-resize.ts` と
 * 同じ作り)。
 *
 * 契約(2026-09-27 由谷「1-5は推奨通りで良いです」=判断1〜3):
 * - 初回は開いた状態
 * - 開閉と高さはアプリ全体で 1 つ、localStorage に保存(再起動・新しい窓・新しいタブにも)
 * - 押してから離すまでに上下 3px 以上動いたらドラッグ・未満はクリック(開閉)
 * - 高さの範囲 = 最小(見出し行+一覧 2 行)〜 左ペインの高さからツリーの 100px を引いた値
 *
 * 状態はモジュール内に保持しない。各ウインドウは独立したページ読み込みであり、
 * 「保存済みの開閉と高さ」の唯一の在り処は localStorage である — `load*` は呼ばれるたびに
 * localStorage を読む。
 */

/**
 * 保存キー。ウインドウ間・バージョン間で同じ値を読むため固定文字列とする
 * (`recent-files-section.acceptance.test.ts` が固定を担保)。
 */
export const SECTION_EXPANDED_STORAGE_KEY = 'vellis.recent-files-expanded';
export const SECTION_HEIGHT_STORAGE_KEY = 'vellis.recent-files-height';

/** ツリーに最低残す高さ(px)。区画の高さの上限 = 左ペインの高さ − これ。 */
export const MIN_TREE_HEIGHT = 100;

/** これ以上(>=)上下に動いたらドラッグ(px)。未満はクリック(開閉)。 */
export const SECTION_DRAG_THRESHOLD = 3;

/** 見出し行の高さ(px)。区画の CSS(`.recent-files-header`)と同じ値。 */
export const SECTION_HEADER_HEIGHT = 28;

/** 一覧の 1 行の高さ(px)。区画の CSS(`.recent-files-row`)と同じ値(等倍のとき)。 */
export const SECTION_ROW_HEIGHT = 24;

/** 一覧の上下の余白の合計(px)。区画の CSS(`.recent-files-list` の padding)と同じ値。 */
const SECTION_LIST_PADDING = 8;

/**
 * 区画の上端の枠線(px)。区画の CSS(`.recent-files` の `border-top: 1px`)と同じ値。
 * 区画は `box-sizing: border-box` なので、inline の `height` はこの枠線を含む —— 足さないと
 * 一覧が 1px 足りずにスクロールバーが出る。
 */
const SECTION_BORDER_TOP = 1;

/** 下限 = 枠線+見出し行+一覧 2 行分。これより低いと一覧として使えないので、常に優先される。 */
export const MIN_SECTION_HEIGHT =
	SECTION_BORDER_TOP + SECTION_HEADER_HEIGHT + SECTION_ROW_HEIGHT * 2 + SECTION_LIST_PADDING;

/** 既定 = 一覧がおよそ 10 行収まる高さ。未保存時と、保存値が解釈不能だった場合のフォールバック。 */
export const DEFAULT_SECTION_HEIGHT =
	SECTION_BORDER_TOP + SECTION_HEADER_HEIGHT + SECTION_ROW_HEIGHT * 10 + SECTION_LIST_PADDING;

/**
 * `height` を [MIN_SECTION_HEIGHT, paneHeight - MIN_TREE_HEIGHT] に収める。
 *
 * 上下限が逆転する低いウインドウでは最小が勝つ — `clampPaneWidth` /
 * `clampWaveformHeight` と同じ規則。
 *
 * 呼び出し側は有限数を渡すこと(非数値の吸収は `loadSectionHeight` の責務)。
 */
export function clampSectionHeight(height: number, paneHeight: number): number {
	const max = paneHeight - MIN_TREE_HEIGHT;
	return Math.max(MIN_SECTION_HEIGHT, Math.min(height, max));
}

/**
 * ドラッグ中の高さ。押した時点の高さと位置だけを基準にする純関数 —— 上へ動かす
 * (`currentY < startY`)と高く、下へ動かすと低くなる(VS Code と同じ向き)。
 * 逐次の相対計算をしないので、clamp で切られた後にポインタが戻れば同じ位置は
 * 同じ高さに対応する(指と見出し行のずれが残らない)。
 */
export function dragSectionHeight(
	startHeight: number,
	startY: number,
	currentY: number,
	paneHeight: number
): number {
	return clampSectionHeight(startHeight + (startY - currentY), paneHeight);
}

/** 押した位置から上下に `SECTION_DRAG_THRESHOLD` 以上動いたか(=クリックではなくドラッグ)。 */
export function isSectionDrag(startY: number, currentY: number): boolean {
	return Math.abs(currentY - startY) >= SECTION_DRAG_THRESHOLD;
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

function read(key: string): string | null {
	try {
		return storage()?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

function write(key: string, value: string): void {
	try {
		storage()?.setItem(key, value);
	} catch {
		// 保存に失敗しても表示中の状態は有効。次回が既定に戻るだけなので黙って諦める。
	}
}

/**
 * 開いているか。`'false'` のときだけ閉じている — 未保存(初回)・解釈不能・
 * localStorage が使えないときは開いた状態(判断1)。
 */
export function loadSectionExpanded(): boolean {
	return read(SECTION_EXPANDED_STORAGE_KEY) !== 'false';
}

/** 開閉を保存する。表現は `'true'` / `'false'`。 */
export function saveSectionExpanded(expanded: boolean): void {
	write(SECTION_EXPANDED_STORAGE_KEY, expanded ? 'true' : 'false');
}

/**
 * 高さを保存する。表現は数値文字列 — 別ウインドウ・別バージョンが `Number(...)` だけで
 * 読めるようにするため。非有限値(NaN / Infinity)は書かない(直前の正常な値を壊さない)。
 */
export function saveSectionHeight(height: number): void {
	if (!Number.isFinite(height)) return;
	write(SECTION_HEIGHT_STORAGE_KEY, String(height));
}

/**
 * 保存済みの高さを今の左ペインの高さ基準で clamp して返す。
 *
 * 解釈不能(未保存・空文字・非数値・非有限)のときだけ既定へ落とす。解釈できる有限数は
 * 範囲外でも既定に落とさず clamp で吸収する — 窓が低くなった後の起動でも、保存値の
 * 意図(高め/低め)は残る。
 */
export function loadSectionHeight(paneHeight: number): number {
	const raw = read(SECTION_HEIGHT_STORAGE_KEY);
	// Number('') === 0 なので、空(空白のみ含む)は数値化する前に弾く。
	const parsed = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
	const height = Number.isFinite(parsed) ? parsed : DEFAULT_SECTION_HEIGHT;
	return clampSectionHeight(height, paneHeight);
}
