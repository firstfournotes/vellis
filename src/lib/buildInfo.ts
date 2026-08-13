/**
 * Build info IPC wrapper + cache.
 *
 * `version` / `buildNumber` / `buildTime` are baked at compile time by
 * `src-tauri/build.rs` and exposed via the `get_build_info` Tauri command.
 * The values never change for a running process, so we cache the first
 * fetch and serve subsequent calls from memory.
 */
import { invoke } from './ipc';

export interface BuildInfo {
	version: string;
	buildNumber: string;
	buildTime: string;
	/** Single source of truth for gating, resolved in Rust. */
	channel: 'dev' | 'release';
	/**
	 * Resolved flag booleans. On `release` the backend omits `kind=dev`
	 * entries (feature-flags.md §3.5); never carries registry metadata.
	 */
	flags: Record<string, boolean>;
}

let cached: BuildInfo | null = null;
let inflight: Promise<BuildInfo> | null = null;

export async function getBuildInfo(): Promise<BuildInfo> {
	if (cached) return cached;
	if (inflight) return inflight;
	inflight = invoke<BuildInfo>('get_build_info').then((info) => {
		cached = info;
		inflight = null;
		return info;
	});
	return inflight;
}
