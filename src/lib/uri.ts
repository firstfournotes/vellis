/**
 * URI utility helpers.
 *
 * Used by rewrite-uri.ts and Viewer.svelte to classify and transform URIs.
 */

/** Returns true if the URI starts with an external scheme (http, https, mailto, tel, data). */
export function isExternal(uri: string): boolean {
	return /^(https?|mailto|tel|data):/i.test(uri);
}

/**
 * Resolve a relative path against a base URI.
 *
 * @example
 * resolveRelative('file:///a/b/README.md', './assets/x.png')
 * // => 'file:///a/b/assets/x.png'
 *
 * resolveRelative('ssh://alice@h/notes/README.md', '../images/y.png')
 * // => 'ssh://alice@h/images/y.png'
 */
export function resolveRelative(baseUri: string, relative: string): string {
	return new URL(relative, baseUri).toString();
}

/**
 * Convert an absolute file:// or ssh:// URI to a vellis-asset:// URI
 * that the Tauri custom protocol handler can serve.
 *
 * - file:///abs/path        => vellis-asset://local/abs/path
 * - ssh://alice@h:22/p/q    => vellis-asset://ssh/alice@h:22/p/q
 * - ssh://h/p/q             => vellis-asset://ssh/h/p/q  (no leading "@")
 */
export function toAssetUri(absolute: string): string {
	const u = new URL(absolute);
	if (u.protocol === 'file:') return `vellis-asset://local${u.pathname}`;
	if (u.protocol === 'ssh:') {
		// `URL.username` is the empty string when no user is present; do not
		// emit a stray `@` in that case.
		const auth = u.username ? `${u.username}@${u.host}` : u.host;
		return `vellis-asset://ssh/${auth}${u.pathname}`;
	}
	throw new Error(`unsupported scheme for asset: ${u.protocol}`);
}
