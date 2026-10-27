/**
 * The exclude patterns the app under test applies to a folder search, read the
 * way the app reads its settings file (requirement #66 追補b・backlog 342).
 *
 * A mirror of `src-tauri/src/settings.rs` (`DEFAULT_FILES_EXCLUDE`,
 * `DEFAULT_SETTINGS_JSON`, `parse_settings`, `read_exclude_map`) for the E2E
 * oracle (`specs/req66-find-in-folder-gate.e2e.ts`). Pure: no wdio and no I/O —
 * the caller reads the file — so vitest can check it against the Rust source
 * (`src/lib/e2e-oracle-excludes.acceptance.test.ts`).
 *
 * The rules (`settings::parse_settings`):
 *  - no file (`null`) / not JSON / JSON that is not an object → both defaults
 *  - a missing key → that key's default
 *  - a key whose value is an object → only its lines whose value is `true`
 *    (the default is replaced, not added to; `false` lines and lines whose value
 *    is not a boolean do not count)
 *  - a key whose value is not an object (array, string, number, null, …) →
 *    that key's default
 */

/** `files.exclude` default (settings.rs `DEFAULT_FILES_EXCLUDE`). */
export const DEFAULT_FILES_EXCLUDE: readonly string[] = ['**/.*', '**/.git', '**/.DS_Store', '**/.vellis'];

/** `search.exclude` default (settings.rs `Settings::default`: one line per excluded dir name). */
export const DEFAULT_SEARCH_EXCLUDE: readonly string[] = [
	'**/node_modules',
	'**/target',
	'**/dist',
	'**/build',
	'**/.git',
	'**/.svelte-kit',
];

const FILES_EXCLUDE_KEY = 'files.exclude';
const SEARCH_EXCLUDE_KEY = 'search.exclude';

/** A JSON object (not `null`, not an array). */
function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One key, the way `settings::read_exclude_map` reads it, reduced to its lines in effect. */
function readExcludeKey(object: Record<string, unknown>, key: string, defaults: readonly string[]): string[] {
	if (!Object.prototype.hasOwnProperty.call(object, key)) return [...defaults];
	const dict = object[key];
	if (!isJsonObject(dict)) return [...defaults];
	return Object.entries(dict)
		.filter(([, on]) => on === true)
		.map(([pattern]) => pattern);
}

/**
 * The exclude patterns in effect for a folder search: the `true` lines of
 * `files.exclude` and `search.exclude`, without duplicates (order not
 * significant). `text` is the settings file's content, or `null` when there is
 * no file.
 */
export function activeExcludePatterns(text: string | null): string[] {
	let object: Record<string, unknown> | null = null;
	if (text !== null) {
		try {
			const value: unknown = JSON.parse(text);
			if (isJsonObject(value)) object = value;
		} catch {
			// Not JSON → both defaults, like the app.
		}
	}
	if (object === null) return [...new Set([...DEFAULT_FILES_EXCLUDE, ...DEFAULT_SEARCH_EXCLUDE])];
	return [
		...new Set([
			...readExcludeKey(object, FILES_EXCLUDE_KEY, DEFAULT_FILES_EXCLUDE),
			...readExcludeKey(object, SEARCH_EXCLUDE_KEY, DEFAULT_SEARCH_EXCLUDE),
		]),
	];
}
