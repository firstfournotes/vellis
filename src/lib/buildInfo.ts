/**
 * Build info IPC wrapper + cache.
 *
 * `version` / `buildNumber` / `buildTime` / `buildName` are baked at compile time by
 * `src-tauri/build.rs` and exposed via the `get_build_info` Tauri command.
 * The values never change for a running process, so we cache the first
 * successful fetch and serve subsequent calls from memory; a failed fetch is
 * not cached and the next call retries.
 */
import { invoke } from './ipc';

export interface BuildInfo {
	version: string;
	buildNumber: string;
	buildTime: string;
	/**
	 * The preview build's name, `dev-<name> #<n>(YYYY-MM-DD HH:MM JST)`
	 * (requirements.md #87); empty on release and dev builds. Optional so a
	 * payload from before requirements.md #87 still type-checks.
	 */
	buildName?: string;
	/** Single source of truth for gating, resolved in Rust. */
	channel: 'dev' | 'preview' | 'release';
	/**
	 * Resolved flag booleans. On `release` / `preview` the backend omits `kind=dev`
	 * entries (feature-flags.md §3.5); never carries registry metadata.
	 */
	flags: Record<string, boolean>;
}

let cached: BuildInfo | null = null;
let inflight: Promise<BuildInfo> | null = null;

export async function getBuildInfo(): Promise<BuildInfo> {
	if (cached) return cached;
	if (inflight) return inflight;
	// Issue #831: clear `inflight` on failure too, so one rejected invoke (e.g. an
	// IPC race at startup) is returned only to the callers sharing it, and the
	// next call retries instead of replaying the rejection for the whole process.
	inflight = invoke<BuildInfo>('get_build_info').then(
		(info) => {
			cached = info;
			inflight = null;
			return info;
		},
		(err: unknown) => {
			inflight = null;
			throw err;
		}
	);
	return inflight;
}
