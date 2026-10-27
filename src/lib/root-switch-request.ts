/**
 * CLI の `vellis -r`(IPC の `SwitchRoot`)からの root の切り替え(要件#48 追補m)。
 *
 * backend(`src-tauri/src/ipc/handler.rs` の `handle_switch_root_request`)は URI の解釈と
 * 一覧の取得の判定だけを済ませて CLI へ応答し、前面の窓へ「切り替えの依頼」の事象を送る。
 * 窓はここで編集の始末を聞き(画面からの切り替えと同じ関門=契約④)、通ったときだけ
 * 切り替えの実体(backend の `handle_switch_root`)を command で頼む。
 *
 * 切り替えの結果は今までどおり backend が `root_changed` で窓へ送り、+page.svelte の
 * 既存の購読が `applyRoot` する — ここでは画面の状態に触らない。Cancel されたことは
 * CLI には返らない(CLI は確認を待たない=契約4)。
 */
import { invoke } from '$lib/ipc';
import { listen } from '$lib/events';

/** backend が判定のあと前面の窓へ送る「切り替えの依頼」の事象名(Rust の同名の定数と同じ綴り)。 */
export const ROOT_SWITCH_REQUESTED_EVENT = 'root_switch_requested';

/** 依頼の payload。backend の `RootSwitchRequestPayload { root_uri }` と同じ綴り。 */
export type RootSwitchRequestPayload = { root_uri: string };

/** 確認が通ったあと、切り替えの実体(backend の `handle_switch_root`)を頼む command 名。 */
export const SWITCH_ROOT_CONFIRMED_COMMAND = 'switch_root_confirmed';

/**
 * 切り替えの実体を頼む。解決値は使わない — 結果は backend が `root_changed` で窓へ送り、
 * 既存の購読が `applyRoot` する(payload を二重に受け取らない)。失敗は reject のまま返す。
 */
export async function switchRootConfirmed(uri: string): Promise<void> {
	await invoke(SWITCH_ROOT_CONFIRMED_COMMAND, { uri });
}

export type RootSwitchRequestDeps = {
	/** 編集の始末を聞く関門(+page は `confirmDiscardEdits`)。false なら何もしない。 */
	confirmDiscard: () => Promise<boolean>;
	/** 切り替えの実体を頼む(+page は `switchRootConfirmed`)。 */
	switchRoot: (uri: string) => Promise<unknown>;
	/** `switchRoot` の失敗の通知先。省略しても例外は外へ出さない。 */
	onError?: (err: unknown) => void;
};

export type RootSwitchRequestOutcome = 'switched' | 'cancelled' | 'failed';

/**
 * 依頼 1 件の判断: 関門 → true なら切り替えを頼む。
 *
 * 関門が終わるまで頼まない — Save を選んだときは保存の完了を関門の中で待つので、
 * 保存が失敗すれば false が返って切り替えない。関門そのものが reject するのは契約上
 * 起きない(ダイアログの失敗は関門が false にする=追補k)が、起きても「聞けなかった」
 * として切り替えずに取りやめる。
 *
 * 失敗は `onError` に渡して 'failed' で解決し、reject しない(事象のハンドラから
 * unhandled rejection を出さない=menu-open と同じ家風)。
 */
export async function handleRootSwitchRequest(
	payload: RootSwitchRequestPayload,
	deps: RootSwitchRequestDeps
): Promise<RootSwitchRequestOutcome> {
	let proceed: boolean;
	try {
		proceed = await deps.confirmDiscard();
	} catch (err) {
		console.error('Unsaved Changes check failed; not switching the root', err);
		return 'cancelled';
	}
	if (!proceed) return 'cancelled';
	try {
		await deps.switchRoot(payload.root_uri);
		return 'switched';
	} catch (err) {
		deps.onError?.(err);
		return 'failed';
	}
}

/**
 * 依頼の事象を購読し、届くたびに `handleRootSwitchRequest` を呼ぶ。戻り値は購読の解除。
 *
 * ハンドラは判断の Promise を返す(listen の型は void だが、返しておくとテストと
 * 配線側が完了を待てる=menu-open と同じ)。
 */
export async function registerRootSwitchRequestListener(
	deps: RootSwitchRequestDeps
): Promise<() => void> {
	return listen<RootSwitchRequestPayload>(ROOT_SWITCH_REQUESTED_EVENT, (e) =>
		handleRootSwitchRequest(e.payload, deps)
	);
}
