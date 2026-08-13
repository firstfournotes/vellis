/**
 * Feature-flag accessor (Svelte 5 Runes).
 *
 * The single source of truth is Rust (feature-flags.md §3.5). This
 * module does NOT re-evaluate gating in JS and does NOT open a second
 * IPC — it reuses the cached `get_build_info()` payload via
 * `getBuildInfo()` (impl #9: reuse the existing cache, don't reinvent).
 *
 * Fail-safe: until the payload resolves, every flag reads `false`
 * (a dev-only UI stays hidden, then appears once `ready`). `ready`
 * lets a consumer defer render to avoid a flash/relayout.
 *
 * Usage:
 *   import { featureFlags } from '$lib/flags.svelte';
 *   onMount(() => featureFlags.init());
 *   {#if featureFlags.isEnabled('editor_inline')} … {/if}
 */
import { getBuildInfo } from './buildInfo';

class FeatureFlags {
	ready = $state(false);
	channel = $state<'dev' | 'release'>('dev');
	#flags = $state<Record<string, boolean>>({});
	#started = false;

	/** Idempotent. Reuses the shared build-info cache (single IPC). */
	async init(): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		const info = await getBuildInfo();
		this.channel = info.channel;
		this.#flags = info.flags ?? {};
		this.ready = true;
	}

	/** Reactive, fail-safe. Unknown / not-yet-ready → false. */
	isEnabled(name: string): boolean {
		return this.#flags[name] === true;
	}
}

export const featureFlags = new FeatureFlags();
