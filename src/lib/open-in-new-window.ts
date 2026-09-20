/**
 * 「Open in New Window」の実行列(requirements.md #59)。
 *
 * ツリーの右クリックから、右クリックした項目のフォルダを root にした新しい
 * ウィンドウを開く。入口はコンテキストメニュー1つで、計画(root と path の
 * 決定)は `$lib/context-menu` の純関数が持ち、ここは **既存の `new_window`
 * command を1回呼ぶだけ**にする — Rust 側は無改変(契約③⑧)。
 *
 * 契約(2026-09-18 登録・docs/requirements/req-59.md):
 * - ③ 引数は `{ path, root, expandedDirs: [] }`。`new_window` は verbatim に
 *   登録するので、URI の正規化も親の導出もこちら側では行わない
 * - ⑤ `expandedDirs` は常に空配列。展開を引き継ぐのは複製(要件#34)の持ち場で、
 *   本要件は「新しい起点で開き直す」ものなので展開を発明しない
 * - ④ `set_root` は呼ばない。root を開くのも履歴に残すのも新窓側の `init_window`
 *   の仕事で、こちらが代わりに触ると **現在の窓が動いてしまう**
 *
 * 失敗の catch と alert は `+page.svelte` の合流点(Duplicate Window とまったく
 * 同じ分担)。ここは reject をそのまま伝える。
 */
import { invoke } from '$lib/ipc';
import type { NewWindowAction } from '$lib/context-menu';

/** `new_window` に渡す引数。Rust 側は verbatim に登録する(要件#34 の Rust 契約)。 */
export type OpenInNewWindowArgs = {
	path: string | null;
	root: string;
	expandedDirs: string[];
};

/** 計画 → `new_window` の引数(純関数)。展開は常に空=契約⑤。 */
function argsFor(plan: NewWindowAction): OpenInNewWindowArgs {
	return { path: plan.path, root: plan.root, expandedDirs: [] };
}

/**
 * 計画したフォルダを root にした新しいウィンドウを開く。解決値は新窓のラベル。
 *
 * 現在の窓には何も触らない(契約④)ので、未保存の編集があっても確認は挟まない —
 * ツリーの Shift+クリック(別窓で開く)と同じ線引き。
 */
export async function openInNewWindow<Label = string>(plan: NewWindowAction): Promise<Label> {
	return await invoke<Label>('new_window', argsFor(plan));
}

/**
 * 新しい窓を開けなかったことを伝える文言(要件#35 ③。エラー内容はそのまま挟む)。
 *
 * `console.warn` に留めないのは、**窓が開かない失敗には OS 側の手応えが一切無く**、
 * 利用者には「押しても何も起きない」としか見えないため(要件#34 と同じ判断)。
 */
export function openInNewWindowFailedMessage(err: unknown): string {
	return `Could not open a new window: ${err}`;
}
