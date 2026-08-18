/**
 * 文書を開く一手(requirements.md #16 ⑦・#22)。
 *
 * これまで「開く」は `invoke('open_document')` 一本だったが、ラスタ画像は
 * UTF-8 テキストとして読めない(`FsError::InvalidUtf8`)ため、読まずに URI だけで
 * 表示する経路が要る。どの経路になるかは `readsAsText` が一箇所で決め、
 * 呼ぶ側(ツリークリック・起動時引数・メニュー Open…)は結果を画面へ移すだけにする。
 *
 * ラスタ画像も文書セッションは張る(要件#22): `open_binary_document` は
 * 読まない監視だけを張るコマンドで、これを通ることで変更の自動反映・削除時の
 * 自動クローズ・reload 復元(要件#10)がテキスト文書と同じ機構に乗る。
 * SVG はテキスト経路のままなのでどれも従来どおり効く。
 */
import { invoke } from '$lib/ipc';
import { readsAsText } from '$lib/image-viewing';
import type { DocumentPayload } from '../stores/window-state.svelte';

/**
 * 開く URI に対応する文書コマンド。テキストとして読めるものは `open_document`、
 * ラスタ画像は読まない監視だけを張る `open_binary_document`(要件#22)。
 */
export function openCommandFor(uri: string): 'open_document' | 'open_binary_document' {
	return readsAsText(uri) ? 'open_document' : 'open_binary_document';
}

/** URI を表示用に開く。どちらの経路でも文書セッションが張られる。 */
export async function openForDisplay(uri: string): Promise<DocumentPayload> {
	return await invoke<DocumentPayload>(openCommandFor(uri), { uri });
}
