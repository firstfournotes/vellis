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
 */
import { toAssetUri } from './uri';

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
 * Elements whose content is raw text, mapped to the search for their end tag.
 * An `<a href=…>` written inside one of these is characters rather than a tag,
 * so it is left alone — `<textarea>` even puts it on screen as written.
 */
const RAW_TEXT_END = new Map<string, RegExp>([
	['script', /<\/script/gi],
	['style', /<\/style/gi],
	['textarea', /<\/textarea/gi],
	['title', /<\/title/gi],
]);

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

/** One attribute name to rename: `length` characters at `at` become `inert`. */
type Rename = { at: number; length: number; inert: string };

/**
 * Walk one open tag's attributes, starting just past the element name. Returns
 * where the tag ends together with the rename for every attribute name found in
 * `navigating`, or null when the tag is never closed.
 *
 * Attributes are walked one at a time rather than pattern-matched, because a
 * value may itself read like an attribute — `<a title="see href=docs" href="…">`
 * has two `href=` in it and only the second one is one.
 */
function scanTag(
	html: string,
	from: number,
	navigating: Map<string, string> | undefined,
): { end: number; renames: Rename[] } | null {
	const renames: Rename[] = [];
	let i = from;
	while (i < html.length) {
		const c = html[i];
		if (c === '>') {
			return { end: i + 1, renames };
		}
		if (c === '/' || isSpace(c)) {
			i += 1;
			continue;
		}
		const nameAt = i;
		while (i < html.length && !isNameEnd(html[i])) {
			i += 1;
		}
		const name = html.slice(nameAt, i);
		i = skipAttributeValue(html, i);
		if (i === -1) {
			return null;
		}
		const inert = navigating?.get(name.toLowerCase());
		if (inert !== undefined) {
			renames.push({ at: nameAt, length: name.length, inert });
		}
	}
	return null;
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
 *
 * Returns the input itself when there was nothing to rename.
 */
function retargetLinks(content: string): string {
	let out = '';
	let copied = 0;
	let i = 0;
	while (i < content.length) {
		const lt = content.indexOf('<', i);
		if (lt === -1) {
			break;
		}
		i = lt + 1;
		if (content.startsWith('!--', i)) {
			const close = content.indexOf('-->', i + 3);
			i = close === -1 ? content.length : close + 3;
			continue;
		}
		const first = content[i];
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
		const tag = scanTag(content, nameEnd, NAVIGATING_ATTRIBUTES.get(name));
		if (tag === null) {
			break; // unterminated tag: leave the remainder verbatim
		}
		for (const rename of tag.renames) {
			out += content.slice(copied, rename.at) + rename.inert;
			copied = rename.at + rename.length;
		}
		i = tag.end;
		const rawTextEnd = RAW_TEXT_END.get(name);
		if (rawTextEnd !== undefined) {
			rawTextEnd.lastIndex = i;
			const end = rawTextEnd.exec(content);
			i = end === null ? content.length : end.index;
		}
	}
	return copied === 0 ? content : out + content.slice(copied);
}

/**
 * Build the iframe body for an HTML document: the source with a single `<base>`
 * inserted, so that relative images resolve to `vellis-asset:` the same way
 * Markdown images do (rewrite-uri: `resolveRelative` → `toAssetUri`), and with
 * links retargeted so a click cannot navigate the preview away. The link
 * stylesheet rides along only when there was a link to retarget.
 *
 * Both insertions are plain string splices — the document is never parsed and
 * re-serialised, so everything around them survives verbatim. They land ahead
 * of any `<base>` the document carries itself, because the first one wins.
 */
export function buildSrcdoc(content: string, docUri: string): string {
	const body = retargetLinks(content);
	// `URL` percent-encodes `"` in the path, so the href needs no escaping.
	const base = `<base href="${toAssetUri(docUri)}">`;
	const injection = body === content ? base : base + LINK_STYLE;
	for (const anchor of INJECTION_ANCHORS) {
		const match = anchor.exec(body);
		if (match !== null) {
			const at = match.index + match[0].length;
			return body.slice(0, at) + injection + body.slice(at);
		}
	}
	return injection + body;
}
