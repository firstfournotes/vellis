/**
 * `vellisSchema` — extends rehype-sanitize's defaultSchema to permit:
 *
 * - Vellis source-map data attributes (`data-vellis-node-id`,
 *   `data-source-start/-end/-start-line/-end-line`,
 *   `data-vellis-node-type`) on every element.
 * - `data-vellis-link` on `<a>` (Viewer click interception).
 * - `className` and `style` on `<code>` / `<pre>` / `<span>` so Shiki's
 *   inline highlight styles survive sanitization.
 * - the `markdown-alert*` classes on `<blockquote>` / `<p>` — and only those
 *   values — for GitHub-style alerts (`plugins/alert.ts`).
 * - `vellis-asset:`, `ssh:`, `et:`, `file:` URI schemes for href/src
 *   (the Tauri custom protocol + remote scheme support).
 *
 * Spec: `docs/archives/rendering-engine.md` §3.5.  The dual-defence story —
 * `script-src 'self'` in CSP (architecture.md §8.5) — still holds even
 * if a sanitizer bypass is found.
 */
import { defaultSchema } from 'rehype-sanitize';

type Schema = typeof defaultSchema;

/**
 * One entry of an `attributes` list: either a bare property name (any value
 * passes) or `[name, ...allowedValues]` (only those values pass).
 */
type AttrDefinition = NonNullable<Schema['attributes']>[string][number];

/**
 * Data attributes are stored under two property naming conventions in the
 * pipeline:
 *
 * 1. kebab-case (`data-vellis-node-id`) when set directly via
 *    `data.hProperties` and passed through remark-rehype without an HTML
 *    round-trip.
 * 2. camelCase (`dataVellisNodeId`) after rehype-raw re-parses the HTML
 *    through parse5 + property-information.
 *
 * The schema must permit both names so the attribute survives either path.
 */
const VELLIS_DATA_ATTRS = [
	'data-vellis-node-id',
	'data-source-start',
	'data-source-end',
	'data-source-start-line',
	'data-source-end-line',
	'data-vellis-node-type',
	'dataVellisNodeId',
	'dataSourceStart',
	'dataSourceEnd',
	'dataSourceStartLine',
	'dataSourceEndLine',
	'dataVellisNodeType',
] as const;

function uniq<T extends string>(items: readonly T[]): T[] {
	return [...new Set(items)];
}

const baseAttrs = (defaultSchema.attributes ?? {}) as Record<string, unknown[]>;

const starAttrs = uniq([
	...((baseAttrs['*'] as string[] | undefined) ?? []),
	...VELLIS_DATA_ATTRS,
]);

const aAttrs = uniq([
	...((baseAttrs.a as string[] | undefined) ?? []),
	'data-vellis-link',
	'dataVellisLink',
]);

const codeAttrs = uniq([
	...((baseAttrs.code as string[] | undefined) ?? []),
	'className',
	'style',
]);

const preAttrs = uniq([
	...((baseAttrs.pre as string[] | undefined) ?? []),
	'className',
	'style',
]);

const spanAttrs = uniq([
	...((baseAttrs.span as string[] | undefined) ?? []),
	'className',
	'style',
]);

// GitHub-style alert blockquotes (`plugins/alert.ts`, requirement #15 / Issue
// 24) tag the `<blockquote>` and its title `<p>` with `markdown-alert*` classes.
// The allow list is by *value* — the `[name, ...values]` form the default schema
// itself uses for `task-list-item` — so only the alert classes pass and an
// unrelated class on a raw HTML `blockquote` / `p` stays blocked.
const alertBlockquoteClass: AttrDefinition = [
	'className',
	'markdown-alert',
	'markdown-alert-note',
	'markdown-alert-tip',
	'markdown-alert-important',
	'markdown-alert-warning',
	'markdown-alert-caution',
];

const alertTitleClass: AttrDefinition = ['className', 'markdown-alert-title'];

const blockquoteAttrs: AttrDefinition[] = [
	...((baseAttrs.blockquote as AttrDefinition[] | undefined) ?? []),
	alertBlockquoteClass,
];

const pAttrs: AttrDefinition[] = [
	...((baseAttrs.p as AttrDefinition[] | undefined) ?? []),
	alertTitleClass,
];

// Mermaid placeholder (`docs/mermaid.md` §7.1). The `<div class="vellis-mermaid"
// data-mermaid-source="...">` carries the diagram source for the Webview-side
// `MermaidMounter` to consume after the HTML is inserted into the DOM. The
// rendered SVG is inserted by `mermaid.render()` *outside* this sanitizer
// (mermaid uses DOMPurify internally with `securityLevel: 'strict'`), so only
// the placeholder needs to survive sanitization.
const divAttrs = uniq([
	...((baseAttrs.div as string[] | undefined) ?? []),
	'className',
	'data-mermaid-source',
	'dataMermaidSource',
]);

const baseProtocols = (defaultSchema.protocols ?? {}) as Record<string, string[]>;

const hrefProtocols = uniq([
	...(baseProtocols.href ?? []),
	'ssh',
	'et',
	'file',
	'vellis-asset',
]);

const srcProtocols = uniq([...(baseProtocols.src ?? []), 'vellis-asset']);

export const vellisSchema: Schema = {
	...defaultSchema,
	attributes: {
		...baseAttrs,
		'*': starAttrs,
		a: aAttrs,
		blockquote: blockquoteAttrs,
		code: codeAttrs,
		p: pAttrs,
		pre: preAttrs,
		span: spanAttrs,
		div: divAttrs,
	},
	protocols: {
		...baseProtocols,
		href: hrefProtocols,
		src: srcProtocols,
	},
};
