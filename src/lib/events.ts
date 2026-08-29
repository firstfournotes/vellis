/**
 * Tauri event wrapper.
 *
 * Thin abstraction over the Tauri event API for the same reasons as ipc.ts.
 *
 * 購読は「現在のウィンドウ限定」ターゲット(WebviewWindow{label})で登録する(要件#33)。
 * Tauri 2 のイベント配送は**受信側 listener の target でフィルタされる**ため、
 * `@tauri-apps/api/event` の listen を既定のまま(target 省略 = { kind: 'Any' })で使うと、
 * Rust 側が emit_to(宛先ラベル指定)で発行しても全ウィンドウの listener が受信してしまう。
 * これがメニューの Open… / Open Folder… のダイアログが全窓に出た原因で、
 * show_marks・root_changed も同じ理由で宛先外の窓が反応していた。
 * 現在窓のラベルは getCurrentWebviewWindow() から取り(ハードコードしない)、その
 * `.listen()` に委ねる = target: { kind: 'WebviewWindow', label } での登録になる。
 * 全窓へのブロードキャスト emit(file_changed・update_available・spacemouse_input 等)は
 * 全ターゲットの listener に届くため、この変更による挙動の差はない。
 *
 * getCurrentWebviewWindow() は window.__TAURI_INTERNALS__ を参照するので、モジュール読込時
 * ではなく購読ごとに呼ぶ(Tauri 外の文脈で import しただけで落ちないようにする)。
 */
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

export async function listen<T>(
	event: string,
	handler: (e: { payload: T }) => void
): Promise<() => void> {
	const unlisten = await getCurrentWebviewWindow().listen<T>(event, handler);
	return unlisten;
}
