/**
 * `rehype-vellis-uri-rewrite` — hast walker that rewrites relative URIs
 * so the rendered HTML can navigate inside the project root and load
 * assets through the Tauri custom protocol.
 *
 * Spec: `docs/archives/rendering-engine.md` §3.6.  Replaces the legacy
 * `rewrite-uri.ts` HTML-string regex pass with a structured tree walk
 * that operates *before* sanitization.
 *
 * Behaviour mirrors the legacy implementation:
 * - `<img src>`: relative → `vellis-asset://...` (served by Tauri custom
 *   protocol).  `vellis-asset:` URIs and external schemes are left alone.
 * - `<a href>`: relative → absolute, with `data-vellis-link=""` so the
 *   Viewer can intercept clicks.  External and fragment-only links are
 *   left alone.
 */
import { visit } from 'unist-util-visit';
import type { Root, Element } from 'hast';
import { resolveRelative, toAssetUri, isExternal } from '$lib/uri';

export interface RehypeVellisUriRewriteOptions {
	baseUri: string;
}

function rewriteImgSrc(node: Element, baseUri: string): void {
	const props = node.properties;
	if (!props) return;
	const src = props.src;
	if (typeof src !== 'string' || src.length === 0) return;
	if (src.startsWith('vellis-asset:')) return;
	if (isExternal(src)) return;
	const absolute = resolveRelative(baseUri, src);
	props.src = toAssetUri(absolute);
}

function markInternalLink(node: Element, baseUri: string): void {
	const props = node.properties;
	if (!props) return;
	const href = props.href;
	if (typeof href !== 'string' || href.length === 0) return;
	if (href.startsWith('#')) return;
	if (isExternal(href)) return;
	props.href = resolveRelative(baseUri, href);
	props['data-vellis-link'] = '';
}

export function rehypeVellisUriRewrite(opts: RehypeVellisUriRewriteOptions) {
	return (tree: Root) => {
		visit(tree, 'element', (node: Element) => {
			if (node.tagName === 'img') rewriteImgSrc(node, opts.baseUri);
			else if (node.tagName === 'a') markInternalLink(node, opts.baseUri);
		});
	};
}
