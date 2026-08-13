/**
 * Tauri invoke wrapper.
 *
 * Thin abstraction so the rest of the frontend imports from one place,
 * making it easy to mock in tests or swap if the Tauri API changes.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
	return tauriInvoke<T>(cmd, args);
}
