/**
 * `rehype-vellis-mermaid` — hast walker that replaces fenced code blocks
 * with `language-mermaid` by an inert placeholder `<div>`.
 *
 * Spec: `docs/mermaid.md` §5.  The actual diagram rendering happens
 * Webview-side in `$lib/mermaid-mounter` after the HTML is mounted
 * into the Viewer DOM (`docs/mermaid.md` §6).
 *
 * The placeholder carries:
 *  - `class="vellis-mermaid"` — selector for the mounter.
 *  - `data-mermaid-source` — the raw mermaid source string.
 *  - The `<code>` element's `data-vellis-*` attributes (set by
 *    `remark-vellis-source-map` via `data.hProperties` on the mdast
 *    `code` node) so that selection / copy-original-markdown / Mark
 *    anchor resolution keep working at code-fence granularity.
 *
 * The plugin must run *before* `@shikijs/rehype` (`renderer.ts`) so
 * Shiki never sees the mermaid block.
 */
import { visit } from 'unist-util-visit';
import type { Root, Element, Properties } from 'hast';

const VELLIS_DATA_KEYS = [
	'dataVellisNodeId',
	'dataSourceStart',
	'dataSourceEnd',
	'dataSourceStartLine',
	'dataSourceEndLine',
	'dataVellisNodeType',
] as const;

function pickVellisDataAttrs(props: Properties | undefined): Properties {
	if (!props) return {};
	const picked: Properties = {};
	for (const key of VELLIS_DATA_KEYS) {
		if (key in props) picked[key] = props[key];
	}
	return picked;
}

function classNameIncludesMermaid(value: unknown): boolean {
	if (Array.isArray(value)) {
		return value.some(
			(v) => typeof v === 'string' && v === 'language-mermaid',
		);
	}
	if (typeof value === 'string') {
		return value.split(/\s+/).includes('language-mermaid');
	}
	return false;
}

function extractTextContent(node: Element): string {
	let out = '';
	for (const child of node.children) {
		if (child.type === 'text') out += child.value;
		else if (child.type === 'element') out += extractTextContent(child);
	}
	return out;
}

export function rehypeVellisMermaid() {
	return (tree: Root) => {
		visit(tree, 'element', (node, index, parent) => {
			if (node.tagName !== 'pre' || !parent || index === undefined || index === null)
				return;
			const code = node.children.find(
				(c): c is Element => c.type === 'element' && c.tagName === 'code',
			);
			if (!code) return;
			if (!classNameIncludesMermaid(code.properties?.className)) return;

			const source = extractTextContent(code);

			// Source-map attrs live on the inner <code> (set by
			// remark-vellis-source-map via data.hProperties on the mdast `code`
			// node, which mdast-util-to-hast then attaches to the <code> element).
			// The wrapping <pre> has no such attrs — pull them from <code>.
			const inheritedDataAttrs = pickVellisDataAttrs(code.properties);

			const placeholder: Element = {
				type: 'element',
				tagName: 'div',
				properties: {
					className: ['vellis-mermaid'],
					dataMermaidSource: source,
					...inheritedDataAttrs,
				},
				children: [
					{
						type: 'element',
						tagName: 'pre',
						properties: { className: ['vellis-mermaid-fallback'] },
						children: [{ type: 'text', value: source }],
					},
				],
			};

			parent.children[index] = placeholder;
			// Skip into the placeholder's subtree (no nested mermaid blocks).
			return ['skip', index + 1];
		});
	};
}
