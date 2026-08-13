/**
 * Explorer pane width: clamp rules and persistence (requirements.md #9).
 *
 * 「左ペイン(ファイルツリー)の幅をドラッグで変更できる」の判定ロジックを
 * 一箇所に集める。ドラッグ中の幅計算・起動時の復元・保存はすべてここを通り、
 * コンポーネント側(`+page.svelte` / `Explorer.svelte`)は結果を反映するだけ。
 *
 * 契約(2026-08-08 由谷決定):
 * - 範囲 = 最小 200px 〜 ウインドウ幅の 50%
 * - 既定 = 250px(現行 Explorer.svelte の width / min-width 踏襲)
 * - 変更した幅は localStorage に保存し、再起動・新規ウインドウにも適用
 *
 * 状態はモジュール内に保持しない。各ウインドウは独立したページ読み込みであり、
 * 「保存済みの幅」の唯一の在り処は localStorage である — `loadPaneWidth` は
 * 呼ばれるたびに localStorage を読む。
 */

/** 下限。これより狭いと Explorer が実用に耐えないため、常に優先される。 */
export const MIN_PANE_WIDTH = 200;

/** 既定幅。未保存時と、保存値が解釈不能だった場合のフォールバック。 */
export const DEFAULT_PANE_WIDTH = 250;

/**
 * 保存キー。ウインドウ間・バージョン間で同じ値を読むため固定文字列とする
 * (`pane-resize.acceptance.test.ts` が固定を担保)。
 */
export const PANE_WIDTH_STORAGE_KEY = 'vellis.explorer-width';

/** 上限はウインドウ幅のこの割合。Viewer 側が半分を下回らないようにする。 */
const MAX_PANE_WIDTH_RATIO = 0.5;

/**
 * `width` を [MIN_PANE_WIDTH, windowWidth * 0.5] に収める。
 *
 * 上下限が逆転する狭いウインドウ(windowWidth < 400)では最小が勝つ —
 * CSS が min-width と max-width の矛盾を解決する規則と同じ振る舞いで、
 * 「Explorer の可用性の下限を守る」という最小値の趣旨に沿う。
 *
 * 呼び出し側は有限数を渡すこと(非数値の吸収は `loadPaneWidth` の責務)。
 */
export function clampPaneWidth(width: number, windowWidth: number): number {
	const max = windowWidth * MAX_PANE_WIDTH_RATIO;
	return Math.max(MIN_PANE_WIDTH, Math.min(width, max));
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
 * 幅を保存する。表現は数値文字列 — 別ウインドウ・別バージョンが
 * `Number(...)` だけで読めるようにするため。
 *
 * 非有限値(NaN / Infinity)は書かない。保存領域に解釈不能な値を持ち込まず、
 * 直前の正常な値も壊さない。
 */
export function savePaneWidth(width: number): void {
	if (!Number.isFinite(width)) return;
	try {
		storage()?.setItem(PANE_WIDTH_STORAGE_KEY, String(width));
	} catch {
		// 保存に失敗しても表示中の幅は有効。次回が既定に戻るだけなので黙って諦める。
	}
}

/**
 * 保存済みの幅を現在のウインドウ幅基準で clamp して返す。
 *
 * 解釈不能(未保存・空文字・非数値・非有限)のときだけ既定へ落とす。
 * 解釈できる有限数は範囲外でも既定に落とさず clamp で吸収する —
 * ウインドウが小さくなった後の起動でも、保存値の意図(広め/狭め)は残る。
 */
export function loadPaneWidth(windowWidth: number): number {
	let raw: string | null = null;
	try {
		raw = storage()?.getItem(PANE_WIDTH_STORAGE_KEY) ?? null;
	} catch {
		raw = null;
	}
	// Number('') === 0 なので、空(空白のみ含む)は数値化する前に弾く。
	const parsed = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
	const width = Number.isFinite(parsed) ? parsed : DEFAULT_PANE_WIDTH;
	return clampPaneWidth(width, windowWidth);
}
