/**
 * 文書を開く一手(requirements.md #16 ⑦)。
 *
 * これまで「開く」は `invoke('open_document')` 一本だったが、ラスタ画像は
 * UTF-8 テキストとして読めない(`FsError::InvalidUtf8`)ため、読まずに URI だけで
 * 表示する経路が要る。どの経路になるかは `readsAsText` が一箇所で決め、
 * 呼ぶ側(ツリークリック・起動時引数・メニュー Open…)は結果を画面へ移すだけにする。
 *
 * 割り切り(要件#16 ⑦・docs/image-viewing.md §4.5 案1): ラスタ画像は文書セッションを
 * 持たない = 監視されない(内容更新の自動反映・削除時の自動クローズがない)・
 * reload 復元(要件#10)の対象外。SVG はテキスト経路のままなのでどれも従来どおり効く。
 */
import { invoke } from '$lib/ipc';
import { readsAsText } from '$lib/image-viewing';
import type { DocumentPayload } from '../stores/window-state.svelte';

/**
 * 読まずに表示する文書のペイロード。本文は空 — 中身は `<img>` が
 * `vellis-asset:` を取りに行くときに初めて読まれる(IPC には載せない)。
 */
export function unreadDocument(uri: string): DocumentPayload {
	return { uri, content: '', modified: null };
}

/** URI を表示用に開く。テキストとして読めるものだけが `open_document` を通る。 */
export async function openForDisplay(uri: string): Promise<DocumentPayload> {
	if (!readsAsText(uri)) return unreadDocument(uri);
	return await invoke<DocumentPayload>('open_document', { uri });
}
