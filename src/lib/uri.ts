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
 * Derive the parent directory URI of an absolute URI, or null when there is none.
 *
 * 純粋な文字列操作で完結する(OS へ問い合わせない)。規則=末尾のスラッシュを
 * 落としてから最後の `/` で切る。スキームと authority(`[user@]host[:port]`)は
 * 跨がないので、authority 直下(`file:///notes.md` / `ssh://host/notes.md`)と
 * スキームの無い文字列は null になる。パーセントエンコードは復号しない —
 * 呼び出し側(`set_root` / `new_window`)へは URI のまま渡すため。
 *
 * ツリーの「親フォルダへ移動」(Explorer.svelte)と、コンテキストメニューの
 * 「Open in New Window」(要件#59 契約②)が同じ規則を共有する。
 *
 * @example
 * parentUri('file:///a/b/c.md')      // => 'file:///a/b'
 * parentUri('ssh://user@h:22/a/b')   // => 'ssh://user@h:22/a'
 * parentUri('file:///c.md')          // => null
 */
export function parentUri(uri: string): string | null {
	const trimmed = uri.replace(/\/+$/, '');
	const schemeIdx = trimmed.indexOf('://');
	if (schemeIdx === -1) return null;
	const pathStart = trimmed.indexOf('/', schemeIdx + 3);
	if (pathStart === -1) return null;
	const lastSlash = trimmed.lastIndexOf('/');
	if (lastSlash <= pathStart) return null;
	return trimmed.slice(0, lastSlash);
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
