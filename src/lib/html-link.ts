/**
 * Links inside the HTML preview (要件#88 — docs/requirements/req-88.md).
 *
 * `buildSrcdoc` with `links` points every link of the preview at
 * `vellis-asset://link/<token>?href=<the attribute value as written>`. A click
 * makes the sandboxed frame try to navigate there; the Rust side refuses the
 * navigation (the preview stays) and tells only the window that shows the
 * frame, with the event below. This module holds what the window needs for
 * that: the token, the event name, and the pure function that turns a reported
 * URL into what to do.
 *
 * The token keeps a document from opening things without a click: a nested
 * `<iframe src="vellis-asset://link/…">` reaches the same navigation handler,
 * but the document cannot read its own srcdoc (no script runs), so it cannot
 * know the token, and a report whose token does not match is dropped.
 */

/** The event the Rust side sends (`navigation.rs`'s constant of the same name). */
export const HTML_LINK_CLICKED_EVENT = 'html_link_clicked';

/** Bytes of randomness in a token: 128 bits. */
const TOKEN_BYTES = 16;

/**
 * A fresh token for one window: 128 random bits from `crypto.getRandomValues`,
 * written in base64url without padding (`[A-Za-z0-9_-]`, 22 characters) so it
 * sits in a URL path as it is.
 */
export function createLinkToken(): string {
	const bytes = new Uint8Array(TOKEN_BYTES);
	crypto.getRandomValues(bytes);
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** What a reported click asks for. */
export type HtmlLinkAction =
	| { kind: 'none' }
	| { kind: 'external'; url: string }
	| { kind: 'open'; uri: string };

const NONE: HtmlLinkAction = { kind: 'none' };

/** Schemes handed to the OS (契約 1). Compared in lower case. */
const EXTERNAL_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

/** Schemes whose URIs are files Vellis opens itself (契約 2). */
const DOCUMENT_PROTOCOLS = new Set(['file:', 'ssh:']);

/** A URL's scheme as written (`javascript`, `HTTPS`), or null when it has none. */
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

/** The five characters HTML counts as whitespace. */
function isSpace(c: string): boolean {
	return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
}

/** `value` with HTML whitespace taken off both ends. */
function trimSpace(value: string): string {
	let start = 0;
	let end = value.length;
	while (start < end && isSpace(value[start])) {
		start += 1;
	}
	while (end > start && isSpace(value[end - 1])) {
		end -= 1;
	}
	return value.slice(start, end);
}

/** The named references the fallback below knows. */
const BASIC_NAMED_REFERENCES = new Map([
	['amp', '&'],
	['lt', '<'],
	['gt', '>'],
	['quot', '"'],
	['apos', "'"],
	['nbsp', ' '],
]);

/** A numeric reference's character: out of range or a surrogate is U+FFFD, as the HTML parser has it. */
function codePointChar(code: number): string {
	if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
		return '�';
	}
	return String.fromCodePoint(code);
}

/**
 * Character references decoded without a DOM: numeric ones (`&#47;`,
 * `&#x2F;`) and the basic named ones written with their `;`. Anything else
 * stays as written.
 */
function decodeBasicReferences(raw: string): string {
	return raw.replace(/&(?:#(\d+)|#[xX]([0-9A-Fa-f]+)|([A-Za-z][A-Za-z0-9]*));?/g, (whole, dec, hex, name) => {
		if (dec !== undefined) return codePointChar(Number.parseInt(dec, 10));
		if (hex !== undefined) return codePointChar(Number.parseInt(hex, 16));
		if (whole.endsWith(';')) return BASIC_NAMED_REFERENCES.get(name) ?? whole;
		return whole;
	});
}

/**
 * The attribute value `raw` (as written in the document) with its character
 * references decoded by the rules for attribute values. Where there is a DOM,
 * the HTML parser does it — an inert document from `DOMParser` (nothing in it
 * runs or loads) holding `raw` as an attribute value; elsewhere the basic
 * fallback above.
 */
function decodeAttributeValue(raw: string): string {
	if (!raw.includes('&')) {
		return raw;
	}
	if (typeof DOMParser !== 'undefined') {
		const parsed = new DOMParser().parseFromString(`<a title="${raw.replace(/"/g, '&quot;')}"></a>`, 'text/html');
		const value = parsed.body?.firstElementChild?.getAttribute('title');
		if (typeof value === 'string') {
			return value;
		}
	}
	return decodeBasicReferences(raw);
}

/**
 * `uri` without its query and fragment, in the URL parser's form, or null when
 * it does not parse. A file's URI has no use for either (契約 4).
 */
function fileTarget(uri: string, base?: string): URL | null {
	let url: URL;
	try {
		url = base === undefined ? new URL(uri) : new URL(uri, base);
	} catch {
		return null;
	}
	url.search = '';
	url.hash = '';
	return url;
}

/**
 * What to do with the URL a click reported (req-88.md 作り 3):
 *
 * - not `vellis-asset://link/<token>?href=…`, or another token → nothing;
 * - the `href` (character references decoded, HTML whitespace trimmed) with
 *   http / https / mailto / tel → hand it to the OS as it is;
 * - with any other scheme but `file:` → nothing;
 * - else resolved against the document's URI (`new URL(href, docUri)`) and its
 *   `?…` and `#…` dropped: a `file:` / `ssh:` URI other than the document itself is the
 *   file to open; the document itself, or what does not resolve, is nothing.
 */
export function decideHtmlLink(input: { url: string; token: string; docUri: string }): HtmlLinkAction {
	const { url, token, docUri } = input;
	if (token === '') {
		return NONE;
	}
	let reported: URL;
	try {
		reported = new URL(url);
	} catch {
		return NONE;
	}
	if (
		reported.protocol !== 'vellis-asset:' ||
		reported.host !== 'link' ||
		reported.username !== '' ||
		reported.password !== '' ||
		reported.pathname !== `/${token}`
	) {
		return NONE;
	}
	const raw = reported.searchParams.get('href');
	if (raw === null) {
		return NONE;
	}
	const href = trimSpace(decodeAttributeValue(raw));
	if (href === '') {
		return NONE;
	}
	const scheme = SCHEME.exec(href)?.[1].toLowerCase();
	if (scheme !== undefined && EXTERNAL_SCHEMES.has(scheme)) {
		return { kind: 'external', url: href };
	}
	if (scheme !== undefined && scheme !== 'file') {
		return NONE;
	}
	const document = fileTarget(docUri);
	const target = fileTarget(href, docUri);
	if (document === null || target === null || !DOCUMENT_PROTOCOLS.has(target.protocol)) {
		return NONE;
	}
	if (target.href === document.href) {
		return NONE;
	}
	return { kind: 'open', uri: target.href };
}

/**
 * The URI the app's own file commands take for a URI `decideHtmlLink` opened.
 * The URL parser percent-encodes the path (`My%20Docs`, `%E8%B3%87…`), while
 * the app's URIs — the Explorer's rows, `open_document` — carry the path as it
 * is (`fs/uri.rs` does not decode), so the path is decoded back. One that does
 * not decode is left as it is.
 */
export function toDocumentUri(uri: string): string {
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return uri;
	}
	try {
		const user = url.username === '' ? '' : `${decodeURIComponent(url.username)}@`;
		return `${url.protocol}//${user}${url.host}${decodeURIComponent(url.pathname)}`;
	} catch {
		return uri;
	}
}
