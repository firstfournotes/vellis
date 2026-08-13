/**
 * Tauri event wrapper.
 *
 * Thin abstraction over the Tauri event API for the same reasons as ipc.ts.
 */
import { listen as tauriListen } from '@tauri-apps/api/event';

export async function listen<T>(
	event: string,
	handler: (e: { payload: T }) => void
): Promise<() => void> {
	const unlisten = await tauriListen<T>(event, handler);
	return unlisten;
}
