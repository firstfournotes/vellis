/**
 * テキスト系ビューアのズーム(requirements.md #36)。
 *
 * 「テキスト系ビューアの表示を拡大縮小できるズーム機能(⌘+ / ⌘− / ⌘0)」の
 * 判定ロジックを一箇所に集める。倍率の刻みと上下限・対象ビューアの別・保存と
 * 復元はすべてここを通り、コンポーネント側(`+page.svelte` / `Viewer.svelte`)は
 * 結果を反映するだけ — Explorer 幅(`pane-resize.ts`)と同じ分担。
 *
 * 契約(2026-08-30 由谷決定=Q2〜Q4):
 * - ① 対象= markdown / text / html のビューア本体のみ。本文中の画像・表・
 *   コードブロック・mermaid 図も一体で拡大縮小する
 * - ③ 倍率=下限50%・上限300%・10%刻み・既定100%・Actual Size で 100% へ戻す
 * - ④ 保存はグローバル1値(localStorage・全窓共有)。どの窓で変えても設定は
 *   1つで、last-writer-wins は仕様。新規ウインドウと再起動に適用する
 * - ⑤ 適用はフロント自前(CSS の `zoom`)。Tauri の webview ズームは使わない —
 *   Explorer ごと拡大されて契約①と両立しないため
 * - ⑧ メニュー3項目は常時有効で、非対象ビューアでは no-op
 *
 * 状態はモジュール内に保持しない。各ウインドウは独立したページ読み込みであり、
 * 「保存済みの倍率」の唯一の在り処は localStorage である — `loadZoom` は
 * 呼ばれるたびに localStorage を読む(`pane-resize.ts` と同じ理由)。
 */
import { listen } from '$lib/events';
import type { FileType } from './file-type';

/** 下限。これより縮めても読めないので、常に優先される(契約③)。 */
export const MIN_ZOOM = 50;

/** 上限(契約③)。 */
export const MAX_ZOOM = 300;

/** ⌘+ / ⌘− 1回あたりの刻み(契約③)。 */
export const ZOOM_STEP = 10;

/** 既定倍率。未保存時のフォールバックであり、Actual Size(⌘0)の戻り先でもある。 */
export const DEFAULT_ZOOM = 100;

/**
 * 保存キー。全窓・再起動・バージョン間で同じ値を読むため固定文字列とする
 * (`pane-resize.ts` の 'vellis.explorer-width' と同じ家風)。
 */
export const ZOOM_STORAGE_KEY = 'vellis.viewer-zoom';

/**
 * Rust のメニュー項目 → Webview の通知イベント名(ペイロードなし)。
 * `src-tauri/src/menu.rs` の同名定数と同じリテラル。Actual Size が *_reset
 * なのは「倍率リセット専用」の意味論(契約⑧= ImageViewer の実寸表示トグルとは
 * 別概念)を名前に出すため。
 */
export const MENU_ZOOM_IN_EVENT = 'menu_zoom_in';
export const MENU_ZOOM_OUT_EVENT = 'menu_zoom_out';
export const MENU_ZOOM_RESET_EVENT = 'menu_zoom_reset';

/** ズームが効くビューア(契約①)。ここに無い型ではメニューは no-op。 */
const ZOOM_TARGET_TYPES: ReadonlySet<FileType> = new Set<FileType>(['markdown', 'text', 'html']);

/**
 * 倍率を 10%刻みへ丸めてから [MIN_ZOOM, MAX_ZOOM] に収める。
 *
 * 保存値の吸収にも使う — 刻み外・範囲外の値が入っていても、既定に落とさずに
 * 一番近い正規の段へ寄せる(`clampPaneWidth` と同じ考え方)。
 *
 * 呼び出し側は有限数を渡すこと(非数値の吸収は `loadZoom` の責務)。
 */
export function normalizeZoom(level: number): number {
	const stepped = Math.round(level / ZOOM_STEP) * ZOOM_STEP;
	return Math.max(MIN_ZOOM, Math.min(stepped, MAX_ZOOM));
}

/** 1段拡大する(契約③)。上限では動かない。 */
export function zoomIn(level: number): number {
	return Math.min(level + ZOOM_STEP, MAX_ZOOM);
}

/** 1段縮小する(契約③)。下限では動かない。 */
export function zoomOut(level: number): number {
	return Math.max(level - ZOOM_STEP, MIN_ZOOM);
}

/**
 * その型のビューアがズームの対象か(契約①)。
 *
 * `FileType` より細かい対象外(SVG のソース表示・DiffView・指示ダイアログの
 * プレビュー)は、この判定ではなく配線側の持ち場 — どれも「文書を表示している
 * ビューア本体」ではないので、そもそもここを通らない。
 */
export function isZoomTarget(type: FileType): boolean {
	return ZOOM_TARGET_TYPES.has(type);
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
 * 倍率を保存する。表現は数値文字列 — 別ウインドウ・別バージョンが
 * `Number(...)` だけで読めるようにするため。
 *
 * 非有限値(NaN / Infinity)は書かない。保存領域に解釈不能な値を持ち込まず、
 * 直前の正常な値も壊さない(`savePaneWidth` と同じ)。
 */
export function saveZoom(level: number): void {
	if (!Number.isFinite(level)) return;
	try {
		storage()?.setItem(ZOOM_STORAGE_KEY, String(level));
	} catch {
		// 保存に失敗しても表示中の倍率は有効。次回が既定に戻るだけなので黙って諦める。
	}
}

/**
 * 保存済みの倍率を返す。未保存・解釈不能(非数値・非有限)のときだけ既定へ落とし、
 * 解釈できる有限数は範囲外・刻み外でも `normalizeZoom` で吸収する — 保存値の
 * 意図(大きめ/小さめ)を残すため。
 */
export function loadZoom(): number {
	let raw: string | null = null;
	try {
		raw = storage()?.getItem(ZOOM_STORAGE_KEY) ?? null;
	} catch {
		raw = null;
	}
	// Number('') === 0 なので、空(空白のみ含む)は数値化する前に弾く。
	const parsed = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
	return Number.isFinite(parsed) ? normalizeZoom(parsed) : DEFAULT_ZOOM;
}

/** メニューの3項目に対応する操作。 */
export type ZoomCommand = 'in' | 'out' | 'reset';

/** 操作を1つ適用した後の倍率(純関数)。Actual Size は既定へ戻す(契約③⑧)。 */
export function applyZoomCommand(command: ZoomCommand, level: number): number {
	switch (command) {
		case 'in':
			return zoomIn(level);
		case 'out':
			return zoomOut(level);
		default:
			return DEFAULT_ZOOM;
	}
}

/** メニュー起点のズームを受け取る配線側のハンドラ。 */
export type ZoomHandlers = {
	/**
	 * いま表示中のビューアがズーム対象か(契約⑧)。発火のたびに呼ばれる —
	 * 対象かどうかは購読した時点ではなく押した時点の表示で決まる。
	 * false なら倍率も保存値も動かさない = 完全な no-op。
	 */
	isTarget: () => boolean;
	/** 現在の倍率。 */
	getLevel: () => number;
	/** 新しい倍率。変化があったときだけ呼ばれる(保存は済んでいる)。 */
	onChange: (level: number) => void;
};

/**
 * メニューイベント(⌘+ / ⌘− / ⌘0)を購読し、倍率の更新と保存を引き受ける。
 * 返り値は3つの購読をまとめて解除する関数。
 *
 * 保存(契約④)をここで済ませるのは、倍率が変わる経路がこの1本しかないため —
 * 配線側に「変えたら保存する」を覚えさせない。上下限で頭打ちになったときは
 * 値が変わらないので、書き込みも通知も走らない。
 */
export async function registerZoomListeners(handlers: ZoomHandlers): Promise<() => void> {
	const run = (command: ZoomCommand): void => {
		if (!handlers.isTarget()) return; // 非対象ビューア=何も起きない(契約⑧)
		const level = handlers.getLevel();
		const next = applyZoomCommand(command, level);
		if (next === level) return; // 上下限で頭打ち・既に等倍
		saveZoom(next);
		handlers.onChange(next);
	};

	const unlisten = await Promise.all([
		listen<unknown>(MENU_ZOOM_IN_EVENT, () => run('in')),
		listen<unknown>(MENU_ZOOM_OUT_EVENT, () => run('out')),
		listen<unknown>(MENU_ZOOM_RESET_EVENT, () => run('reset')),
	]);

	return () => {
		for (const off of unlisten) off();
	};
}
