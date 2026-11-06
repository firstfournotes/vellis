// Tauri doesn't have a Node.js server to do proper SSR
// so we use adapter-static with a fallback to index.html to put the site in SPA mode
// See: https://svelte.dev/docs/kit/single-page-apps
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info
import { fetchTheme, type ResolvedTheme } from '$lib/theme';

export const ssr = false;
export const prerender = true;

/**
 * The resolved theme (要件#56 契約 3・判断 (j)), awaited before `+page.svelte` is
 * drawn so the first paint already carries the user's theme. `null` when the
 * command is unavailable: the Default of `theme.css` stays in effect.
 */
export async function load(): Promise<{ theme: ResolvedTheme | null }> {
	return { theme: await fetchTheme() };
}
