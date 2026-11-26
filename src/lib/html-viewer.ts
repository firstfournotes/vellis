/**
 * Sandboxed HTML preview surface (要件#8).
 *
 * 「HTML ファイル(html/htm)はソースではなくレンダリング結果を表示する
 *  (スクリプトは実行しない)」 — 決定記録: docs/html-viewing.md(案B)
 *
 * The document is handed to an `<iframe srcdoc>` as it is, so the viewer shows
 * the file itself — inline `<style>`, inline SVG and all. Nothing is stripped:
 * scripts are stopped by the sandbox (no `allow-scripts`) and, as a second
 * line, by the CSP the srcdoc document inherits from the app window
 * (`script-src 'self'` without `'unsafe-inline'`).
 *
 * Links are the one exception (追補 2026-08-10 由谷決定=案A). A sandbox does not
 * stop a document from navigating *its own* frame, so a click used to replace
 * the preview — with example.com for an external link, or with a `vellis-asset:`
 * URL for a relative one, since the injected `<base>` resolves it. The fix is to
 * take the target out of the browser's reach: on `<a>` / `<area>` the `href` is
 * renamed to `data-vellis-href` — and an SVG link's `xlink:href` to
 * `data-vellis-xlink-href` — which keeps the value verbatim while making the
 * element inert, and a `<style>` restores the look of a link.
 *
 * The on-screen preview passes `links` (要件#88): every link then also gets a
 * target of the app's own — `vellis-asset://link/<token>?href=…`, which the
 * navigation plugin refuses and reports to the window, or `about:srcdoc#…` for
 * an in-page jump — so a click opens the file in Vellis or the URL in the
 * browser while the preview itself stays. The print document leaves `links`
 * out and gets exactly the bytes it always did.
 */
import { toAssetUri } from './uri';
import { DEFAULT_ZOOM } from './zoom';

/**
 * `sandbox` value for the preview iframe. The empty string is the strictest
 * form — every sandbox restriction applies. `allow-scripts` and
 * `allow-same-origin` must stay out: the first keeps the document static, the
 * second keeps it on an opaque origin instead of the app's own.
 */
export const SANDBOX_ATTRIBUTE: string = '';

/**
 * Where the injections are spliced in, in order of preference: right after the
 * opening `<head>`, else after `<html>`, else after the doctype, else at the
 * very start of a bare fragment. `head\b` does not match `<header>`.
 */
const INJECTION_ANCHORS = [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype\b[^>]*>/i];

/**
 * The offset in `document` at which an injection belongs — just past the first
 * anchor above, or 0 for a bare fragment (where the parser lifts a `<meta>` /
 * `<base>` into the head it synthesises).
 *
 * Exported because the print document (要件#38) splices its CSP `<meta>` in at
 * the same place: it is built by re-splicing into what `buildSrcdoc` returned,
 * so the two must agree on where "before the body" is without either of them
 * keeping a second copy of the anchor list.
 */
export function injectionOffset(document: string): number {
	for (const anchor of INJECTION_ANCHORS) {
		const match = anchor.exec(document);
		if (match !== null) {
			return match.index + match[0].length;
		}
	}
	return 0;
}

/**
 * Per element, the attributes that make it navigate and the inert name each is
 * renamed to: the target stays verbatim but stops being a target. `<a>` can
 * also navigate through SVG's `xlink:href`, which parks under a name of its own
 * so that the rename stays reversible one-to-one.
 *
 * Everything absent from this table keeps its attribute — the `href` of
 * `<base>` and `<link>`, and `<image xlink:href>`, are references, not links.
 */
const NAVIGATING_ATTRIBUTES = new Map<string, Map<string, string>>([
	[
		'a',
		new Map([
			['href', 'data-vellis-href'],
			['xlink:href', 'data-vellis-xlink-href'],
		]),
	],
	['area', new Map([['href', 'data-vellis-href']])],
]);

/**
 * The same table for a preview whose links are made clickable (要件#88): on top
 * of the targets, `target` and `download` are parked too. A sandboxed frame
 * drops a `_blank` (or a `<base target>`) navigation without asking anyone, and
 * WebKit turns a `download` link into a download, which never reaches the
 * navigation handler — the injected `target="_self"` has to be the only target.
 */
const CLICKABLE_ATTRIBUTES = new Map<string, Map<string, string>>(
	[...NAVIGATING_ATTRIBUTES].map(([element, renames]) => [
		element,
		new Map([...renames, ['target', 'data-vellis-target'], ['download', 'data-vellis-download']]),
	]),
);

/** What `buildSrcdoc` needs to make links clickable: the window's token (`[A-Za-z0-9_-]+`). */
export type SrcdocLinks = { token: string };

/**
 * Elements whose content is raw text, mapped to the search for their end tag.
 * An `<a href=…>` written inside one of these is characters rather than a tag,
 * so it is left alone — `<textarea>` and `<xmp>` even put it on screen as
 * written. The set follows the HTML parser (追補a 2026-10-19): `<noscript>` is
 * absent because the sandbox runs no script, which makes its content markup.
 * `<plaintext>` has no end tag at all (null) — everything after it, to the end
 * of the document, is text.
 */
const RAW_TEXT_END = new Map<string, RegExp | null>([
	['script', endTagSearch('script')],
	['style', endTagSearch('style')],
	['textarea', endTagSearch('textarea')],
	['title', endTagSearch('title')],
	['xmp', endTagSearch('xmp')],
	['iframe', endTagSearch('iframe')],
	['noembed', endTagSearch('noembed')],
	['noframes', endTagSearch('noframes')],
	['plaintext', null],
]);

/**
 * The search for a raw text element's end tag. It closes only when the name is
 * followed by a boundary — whitespace, `/`, `>` or the end of the document
 * (追補d 2026-10-25) — so `</xmpx>` is still text inside an `<xmp>`, as it is
 * to the HTML parser.
 */
function endTagSearch(name: string): RegExp {
	return new RegExp(`</${name}(?=[\\t\\n\\f\\r />]|$)`, 'gi');
}

/**
 * Elements inside which the raw text elements above are ordinary markup
 * (追補d 2026-10-25): in SVG and MathML (foreign content) and in a `<select>`,
 * `<xmp>` or `<style>` does not swallow what follows, so a real link after it
 * still has to be retargeted. Only "inside or not" is tracked — the finer
 * tree-building rules (an HTML `<p>` breaking out of foreign content, …) are
 * not followed; a miss there still sits inside the sandbox.
 */
const FOREIGN_ROOTS = new Set(['svg', 'math']);

/**
 * Where the comment opened by the `<!--` just before `from` ends — the offset
 * past its closer, or the end of the document when it is never closed. Read as
 * the HTML parser does (追補a 2026-10-19): `<!-->` and `<!--->` close at once,
 * anything else at the first `-->` or `--!>`. Looking for `-->` alone would
 * swallow the real links that follow the other three forms.
 */
function commentEnd(html: string, from: number): number {
	if (html.startsWith('>', from)) {
		return from + 1;
	}
	if (html.startsWith('->', from)) {
		return from + 2;
	}
	const close = html.indexOf('-->', from);
	const bangClose = html.indexOf('--!>', from);
	if (bangClose !== -1 && (close === -1 || bangClose < close)) {
		return bangClose + 4;
	}
	return close === -1 ? html.length : close + 3;
}

/**
 * Keeps a retargeted link looking like a link: the UA stylesheet only paints
 * `a[href]`, so without this the text would fall back to body colour. The
 * `-webkit-link` system colour matches WKWebView's own default and wins over
 * the literal that precedes it wherever it is understood.
 */
const LINK_STYLE =
	'<style>[data-vellis-href],[data-vellis-xlink-href]{color:#0000ee;color:-webkit-link;' +
	'text-decoration:underline;cursor:pointer}</style>';

/** The five characters HTML counts as whitespace (`\s` would also take NBSP). */
function isSpace(c: string): boolean {
	return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
}

function isAsciiAlpha(c: string): boolean {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

/** Where an element or attribute name stops. */
function isNameEnd(c: string): boolean {
	return isSpace(c) || c === '/' || c === '>' || c === '=';
}

/**
 * Advance past ` = value` when the attribute at `from` has one. Returns `from`
 * unchanged for a bare attribute (the caller's loop handles the terminator),
 * and -1 when a quoted value never closes.
 */
function skipAttributeValue(html: string, from: number): number {
	let i = from;
	while (i < html.length && isSpace(html[i])) {
		i += 1;
	}
	if (html[i] !== '=') {
		return from;
	}
	i += 1;
	while (i < html.length && isSpace(html[i])) {
		i += 1;
	}
	const quote = html[i];
	if (quote === '"' || quote === "'") {
		const close = html.indexOf(quote, i + 1);
		return close === -1 ? -1 : close + 1;
	}
	while (i < html.length && !isSpace(html[i]) && html[i] !== '>') {
		i += 1;
	}
	return i;
}

/**
 * The value of the attribute whose name ends at `from` and whose value (if
 * any) ends at `end`, as written: without its quotes, character references
 * left alone. A bare attribute's value is the empty string.
 */
function attributeValue(html: string, from: number, end: number): string {
	let i = from;
	while (i < end && isSpace(html[i])) {
		i += 1;
	}
	if (html[i] !== '=') {
		return '';
	}
	i += 1;
	while (i < end && isSpace(html[i])) {
		i += 1;
	}
	const quote = html[i];
	if (quote === '"' || quote === "'") {
		return html.slice(i + 1, end - 1);
	}
	return html.slice(i, end);
}

/**
 * One attribute name to rename: `length` characters at `at` become `inert`.
 * `name` is the lowercased attribute name and `value` its value as written.
 */
type Rename = { at: number; length: number; inert: string; name: string; value: string };

/**
 * Walk one open tag's attributes, starting just past the element name. Returns
 * where the tag ends together with the rename for every attribute name found in
 * `navigating`, or null when the tag is never closed. `selfClosing` is true for
 * a tag that ends in `/>` — a `/` inside an unquoted value (`<svg a=b/>`) is
 * part of the value and does not count.
 *
 * Attributes are walked one at a time rather than pattern-matched, because a
 * value may itself read like an attribute — `<a title="see href=docs" href="…">`
 * has two `href=` in it and only the second one is one.
 */
function scanTag(
	html: string,
	from: number,
	navigating: Map<string, string> | undefined,
): { end: number; renames: Rename[]; selfClosing: boolean } | null {
	const renames: Rename[] = [];
	let selfClosing = false;
	let i = from;
	while (i < html.length) {
		const c = html[i];
		if (c === '>') {
			return { end: i + 1, renames, selfClosing };
		}
		if (c === '/' || isSpace(c)) {
			selfClosing = c === '/';
			i += 1;
			continue;
		}
		selfClosing = false;
		const nameAt = i;
		while (i < html.length && !isNameEnd(html[i])) {
			i += 1;
		}
		const name = html.slice(nameAt, i);
		const valueFrom = i;
		i = skipAttributeValue(html, i);
		if (i === -1) {
			return null;
		}
		const lower = name.toLowerCase();
		const inert = navigating?.get(lower);
		if (inert !== undefined) {
			renames.push({
				at: nameAt,
				length: name.length,
				inert,
				name: lower,
				value: attributeValue(html, valueFrom, i),
			});
		}
	}
	return null;
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

/**
 * What goes right after a clickable link's element name (要件#88 作り 1):
 * ` href="<target>" target="_self"`, or nothing when the link has no target.
 *
 * The link's target is its first `href`, else its first `xlink:href`; an empty
 * (or all-whitespace) one is no target. A `#…` value jumps inside the frame
 * through `about:srcdoc#…`; anything else becomes
 * `vellis-asset://link/<token>?href=<the value as written, URI-component
 * encoded>` — character references are decoded by the window that receives the
 * click, so this stays a plain splice.
 */
function clickTarget(renames: Rename[], token: string): string {
	const link =
		renames.find((rename) => rename.name === 'href') ?? renames.find((rename) => rename.name === 'xlink:href');
	if (link === undefined) {
		return '';
	}
	const trimmed = trimSpace(link.value);
	if (trimmed === '') {
		return '';
	}
	let target: string;
	if (trimmed.startsWith('#')) {
		target = `about:srcdoc${trimmed.replace(/"/g, '&quot;')}`;
	} else {
		let encoded: string;
		try {
			encoded = encodeURIComponent(link.value);
		} catch {
			return ''; // a lone surrogate: the link stays inert
		}
		target = `vellis-asset://link/${token}?href=${encoded}`;
	}
	return ` href="${target}" target="_self"`;
}

/**
 * Park the navigating attribute of every `<a>` / `<area>` under an inert name,
 * so a click cannot navigate the frame. External, relative and in-page targets
 * all go, in HTML links and in SVG ones alike.
 *
 * The document is walked tag by tag and only attribute names are touched, so
 * `href=` appearing anywhere else survives: escaped source (`&lt;a href=…&gt;`),
 * prose, an attribute's value, raw text inside `<script>` / `<textarea>`,
 * comments, and the `href` of `<base>` / `<link>`. A real `<a>` inside `<pre>`
 * *is* retargeted — it is a link, and the point is that links do not navigate.
 * Inside `<svg>` / `<math>` / `<select>` the raw text elements are markup, so
 * the walk goes on through them (追補d 2026-10-25).
 *
 * With `links` (要件#88), `target` and `download` are parked as well and every
 * link with a target gets one of the app's own spliced in right after its
 * element name (`clickTarget`).
 *
 * Returns the input itself when there was nothing to rename.
 */
function retargetLinks(content: string, links?: SrcdocLinks): string {
	const table = links === undefined ? NAVIGATING_ATTRIBUTES : CLICKABLE_ATTRIBUTES;
	let out = '';
	let copied = 0;
	let foreignDepth = 0; // open <svg> / <math>, nested ones counted
	let inSelect = false;
	let i = 0;
	while (i < content.length) {
		const lt = content.indexOf('<', i);
		if (lt === -1) {
			break;
		}
		i = lt + 1;
		if (content.startsWith('!--', i)) {
			i = commentEnd(content, i + 3);
			continue;
		}
		const first = content[i];
		if (first === '/') {
			let closingEnd = i + 1;
			while (closingEnd < content.length && !isNameEnd(content[closingEnd])) {
				closingEnd += 1;
			}
			const closing = content.slice(i + 1, closingEnd).toLowerCase();
			if (FOREIGN_ROOTS.has(closing)) {
				foreignDepth = Math.max(0, foreignDepth - 1);
			} else if (closing === 'select') {
				inSelect = false;
			}
		}
		if (first === '!' || first === '?' || first === '/') {
			const close = content.indexOf('>', i);
			i = close === -1 ? content.length : close + 1;
			continue;
		}
		if (!isAsciiAlpha(first)) {
			continue; // a stray `<` in the text, not the start of a tag
		}
		let nameEnd = i;
		while (nameEnd < content.length && !isNameEnd(content[nameEnd])) {
			nameEnd += 1;
		}
		const name = content.slice(i, nameEnd).toLowerCase();
		const tag = scanTag(content, nameEnd, table.get(name));
		if (tag === null) {
			break; // unterminated tag: leave the remainder verbatim
		}
		const injection = links === undefined ? '' : clickTarget(tag.renames, links.token);
		if (injection !== '') {
			out += content.slice(copied, nameEnd) + injection;
			copied = nameEnd;
		}
		for (const rename of tag.renames) {
			out += content.slice(copied, rename.at) + rename.inert;
			copied = rename.at + rename.length;
		}
		i = tag.end;
		if (FOREIGN_ROOTS.has(name)) {
			if (!tag.selfClosing) {
				foreignDepth += 1; // `<svg/>` opens nothing
			}
			continue;
		}
		if (name === 'select') {
			inSelect = true;
			continue;
		}
		if (foreignDepth > 0 || inSelect) {
			continue; // raw text elements are markup here
		}
		const rawTextEnd = RAW_TEXT_END.get(name);
		if (rawTextEnd === null) {
			break; // <plaintext>: the rest of the document is text
		}
		if (rawTextEnd !== undefined) {
			rawTextEnd.lastIndex = i;
			const end = rawTextEnd.exec(content);
			i = end === null ? content.length : end.index;
		}
	}
	return copied === 0 ? content : out + content.slice(copied);
}

/**
 * The zoom the preview is shown at, as a stylesheet to inject (要件#36 ⑥).
 *
 * The iframe is sandboxed with an empty `sandbox` attribute, so its document
 * sits on an opaque origin and the parent cannot reach in to style it — any
 * attempt is a `SecurityError`. Scaling the iframe element from outside is no
 * good either: the layout viewport stays the unscaled size, so the document
 * gets clipped instead of reflowed. What is left is to build the zoom into the
 * document itself, which means rebuilding `srcdoc` on every ⌘± (the iframe
 * remounts and loses its scroll position — accepted for the first version).
 *
 * `zoom` on the root element scales everything inside — text, images, tables,
 * inline SVG — and shrinks the layout viewport to match, so the content
 * reflows to the iframe's width instead of overflowing it.
 *
 * The default level injects nothing at all: `buildSrcdoc` then produces exactly
 * the bytes it did before ズーム existed.
 */
export function zoomStyleTag(zoom: number): string {
	if (zoom === DEFAULT_ZOOM) return '';
	return `<style>:root{zoom:${zoom}%}</style>`;
}

/**
 * Build the iframe body for an HTML document: the source with a single `<base>`
 * inserted, so that relative images resolve to `vellis-asset:` the same way
 * Markdown images do (rewrite-uri: `resolveRelative` → `toAssetUri`), and with
 * links retargeted so a click cannot navigate the preview away. The link
 * stylesheet rides along only when there was a link to retarget, and the zoom
 * stylesheet only when the level is not the default (要件#36 ⑥).
 *
 * All insertions are plain string splices — the document is never parsed and
 * re-serialised, so everything around them survives verbatim. They land ahead
 * of any `<base>` the document carries itself, because the first one wins.
 *
 * `links` makes the links clickable for the on-screen preview (要件#88); left
 * out — as the print document does — the result is what it always was.
 */
export function buildSrcdoc(
	content: string,
	docUri: string,
	zoom: number = DEFAULT_ZOOM,
	links?: SrcdocLinks,
): string {
	const body = retargetLinks(content, links);
	// The href is an attribute value, so `&` is escaped: a folder named `&copy`
	// would otherwise decode to `©` and shift the base (追補d 2026-10-25). `URL`
	// already percent-encodes `"` in the path; it is escaped all the same.
	const href = toAssetUri(docUri).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
	const base = `<base href="${href}">`;
	const injection = (body === content ? base : base + LINK_STYLE) + zoomStyleTag(zoom);
	const at = injectionOffset(body);
	return body.slice(0, at) + injection + body.slice(at);
}
