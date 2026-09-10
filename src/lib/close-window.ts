/**
 * 閉窓要求のハンドラ本体(要件#48 契約④)。
 *
 * `+page.svelte` は
 * `appWindow.onCloseRequested((event) => handleCloseRequested(event, appWindow))`
 * の形でこれを渡すだけにする — 判断はここ・購読の管理(unlisten)は +page 側。
 *
 * Tauri 2 の JS API は「JS リスナがあると OS の閉じる動作を止めて JS に委ね、
 * ハンドラが preventDefault しなければ自分で `destroy()` を呼ぶ」実装なので、
 * **非 dirty では preventDefault を呼ばない**(=既定の閉じる動作に委ねる)。
 * dirty のときだけいったん止めて確認し、進んでよいと決まったときだけ改めて
 * 閉じる。確認と保存の実体は `$lib/edit-guard`(保存が成功してから true)。
 */
import { confirmDiscardEdits } from '$lib/edit-guard';
import { windowState } from '../stores/window-state.svelte';

export async function handleCloseRequested(
	event: { preventDefault: () => void },
	appWindow: { destroy: () => Promise<void> }
): Promise<void> {
	if (!windowState.dirty) return;
	event.preventDefault();
	if (await confirmDiscardEdits()) await appWindow.destroy();
}
