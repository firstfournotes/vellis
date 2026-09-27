/**
 * ズームの対象の判別とツリー側の倍率(requirements.md #63)。
 *
 * View ▸ Zoom In / Zoom Out / Actual Size(Command + Plus / Minus / 0)を押したとき、
 * ツリー(Explorer)と本文(ビューア)のどちらを動かすかを「最後にポインタが入った領域」
 * で決める。判別・振り分け・ツリー側の保存はすべてここを通り、`+page.svelte` は
 * ポインタの領域を追いかけて結果を反映するだけ(`zoom.ts` と同じ分担)。
 *
 * 契約(docs/requirements/req-63.md・2026-09-24 由谷確定):
 * - 3 判別=押した時点の「最後にポインタが入った領域」。どちらでもない場所・窓の外では
 *   直前を保つ。未確定と Explorer が無い画面は本文側
 * - 4 本文側が拡縮できない(非対象ビューア)ときは何もしない。ツリーへ回さない
 * - 5 倍率の段(下限・上限・刻み・既定)は `zoom.ts` の定数と純関数を共用する。
 *   ここで数値を持たない(片方だけ変わって食い違うのを防ぐ)
 * - 6 ツリーの保存は別キー `vellis.explorer-zoom`(グローバル1値)。規則は `saveZoom` /
 *   `loadZoom` と同じ
 * - 7 窓どうしで即時同期しない。保存値は窓を開いたときに1回だけ読む(`storage`
 *   イベントは購読しない)
 */
import { listen } from '$lib/events';
import {
	DEFAULT_ZOOM,
	MENU_ZOOM_IN_EVENT,
	MENU_ZOOM_OUT_EVENT,
	MENU_ZOOM_RESET_EVENT,
	applyZoomCommand,
	normalizeZoom,
	saveZoom,
	type ZoomCommand,
} from './zoom';

/** ズームの領域。DOM の目印 `data-zoom-region` の値と同じ文字列。 */
export type ZoomRegion = 'explorer' | 'viewer';

/**
 * 最後にポインタが入った領域を更新する(契約3)。`hit` が null(どちらでもない・
 * 窓の外)なら直前の領域を保つ。
 */
export function nextPointerRegion(prev: ZoomRegion | null, hit: ZoomRegion | null): ZoomRegion | null {
	return hit === null ? prev : hit;
}

/**
 * 押した時点の対象を決める(契約3)。ツリーが対象になるのは、最後の領域が Explorer で、
 * かつ Explorer が出ている画面のときだけ。未確定・履歴選択画面は本文側。
 */
export function resolveZoomTarget(input: { region: ZoomRegion | null; explorerShown: boolean }): ZoomRegion {
	return input.region === 'explorer' && input.explorerShown ? 'explorer' : 'viewer';
}

/**
 * 要素が属する領域(契約3)。いちばん近い `data-zoom-region` の祖先の値が
 * `explorer` / `viewer` のときだけ返し、それ以外(目印なし・別の値・null)は null。
 */
export function regionOf(element: Element | null): ZoomRegion | null {
	const marked = element?.closest('[data-zoom-region]') ?? null;
	const value = marked?.getAttribute('data-zoom-region') ?? null;
	return value === 'explorer' || value === 'viewer' ? value : null;
}

/** 振り分けの入力(契約3・4)。 */
export type ZoomRouteInput = {
	command: ZoomCommand;
	/** `resolveZoomTarget` の結果。 */
	target: ZoomRegion;
	/** 本文側が拡縮できるか(要件#36 契約①⑧)。ツリー側には効かない。 */
	viewerZoomable: boolean;
	viewerLevel: number;
	explorerLevel: number;
};

/** 振り分けの結果。`changed` は値が変わった側で、null なら保存も通知もしない。 */
export type ZoomRouteResult = {
	viewerLevel: number;
	explorerLevel: number;
	changed: ZoomRegion | null;
};

/**
 * 操作を対象の側だけに適用する(契約3・4・純関数)。
 *
 * - ツリー側は本文の表示に関係なくいつでも効く
 * - 本文側は拡縮できるときだけ効く。できなければ何もしない(ツリーへ回さない)
 * - 頭打ち(上限で拡大・下限で縮小・既定で等倍)は値が変わらないので changed は null
 */
export function routeZoomCommand(input: ZoomRouteInput): ZoomRouteResult {
	const { command, target, viewerZoomable, viewerLevel, explorerLevel } = input;
	if (target === 'explorer') {
		const next = applyZoomCommand(command, explorerLevel);
		return { viewerLevel, explorerLevel: next, changed: next === explorerLevel ? null : 'explorer' };
	}
	if (!viewerZoomable) return { viewerLevel, explorerLevel, changed: null };
	const next = applyZoomCommand(command, viewerLevel);
	return { viewerLevel: next, explorerLevel, changed: next === viewerLevel ? null : 'viewer' };
}

/**
 * ツリーの倍率の保存キー(契約6)。本文の `vellis.viewer-zoom`・ペイン幅の
 * `vellis.explorer-width` とは別。
 */
export const EXPLORER_ZOOM_STORAGE_KEY = 'vellis.explorer-zoom';

/** localStorage への参照(`zoom.ts` と同じ保険)。 */
function storage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

/**
 * ツリーの倍率を保存する(契約6)。規則は `saveZoom` と同じ — 非有限値は書かず、
 * 直前の正常な値を壊さない。
 */
export function saveExplorerZoom(level: number): void {
	if (!Number.isFinite(level)) return;
	try {
		storage()?.setItem(EXPLORER_ZOOM_STORAGE_KEY, String(level));
	} catch {
		// 保存に失敗しても表示中の倍率は有効。次回が既定に戻るだけ。
	}
}

/**
 * 保存済みのツリーの倍率を返す(契約6)。規則は `loadZoom` と同じ — 未保存・解釈不能は
 * 既定、解釈できる有限数は `normalizeZoom` で最寄りの段へ寄せる。
 */
export function loadExplorerZoom(): number {
	let raw: string | null = null;
	try {
		raw = storage()?.getItem(EXPLORER_ZOOM_STORAGE_KEY) ?? null;
	} catch {
		raw = null;
	}
	// Number('') は 0 になるので、空(空白のみ含む)は数値化する前に弾く。
	const parsed = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
	return Number.isFinite(parsed) ? normalizeZoom(parsed) : DEFAULT_ZOOM;
}

/** メニュー起点のズームを振り分ける配線側のハンドラ。どれも発火のたびに呼ばれる。 */
export type RoutedZoomHandlers = {
	/** 押した時点の対象(`resolveZoomTarget` の結果)。 */
	getTarget: () => ZoomRegion;
	/** 押した時点で本文側が拡縮できるか(要件#36 契約⑧)。 */
	isViewerZoomable: () => boolean;
	getViewerLevel: () => number;
	getExplorerLevel: () => number;
	/** 本文の倍率が変わった(保存は済んでいる)。 */
	onViewerChange: (level: number) => void;
	/** ツリーの倍率が変わった(保存は済んでいる)。 */
	onExplorerChange: (level: number) => void;
};

/**
 * メニューイベント(Command + Plus / Minus / 0)を購読し、対象の側へ振り分けて
 * 倍率の更新と保存を引き受ける(契約2〜6)。返り値は3つの購読をまとめて解除する関数。
 *
 * 本文側の意味論は `registerZoomListeners`(要件#36)と同じ — 非対象ビューアでは倍率も
 * 保存値も動かさず、頭打ちなら書き込みも通知も走らない。保存先は変わった側のキーだけ。
 */
export async function registerRoutedZoomListeners(handlers: RoutedZoomHandlers): Promise<() => void> {
	const run = (command: ZoomCommand): void => {
		const result = routeZoomCommand({
			command,
			target: handlers.getTarget(),
			viewerZoomable: handlers.isViewerZoomable(),
			viewerLevel: handlers.getViewerLevel(),
			explorerLevel: handlers.getExplorerLevel(),
		});
		if (result.changed === 'viewer') {
			saveZoom(result.viewerLevel);
			handlers.onViewerChange(result.viewerLevel);
		} else if (result.changed === 'explorer') {
			saveExplorerZoom(result.explorerLevel);
			handlers.onExplorerChange(result.explorerLevel);
		}
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
