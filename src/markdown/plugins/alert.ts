/**
 * `remark-vellis-alert` — recognises GitHub-style alert blockquotes and turns
 * them into structured alert blocks.
 *
 * Spec: requirement #15 (GitHub Issue 24).  GitHub renders a blockquote whose
 * first line is `[!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` /
 * `[!CAUTION]` as a coloured callout with a title, instead of showing the
 * literal marker text.  The stock `remark-gfm` pipeline does not, so `> [!NOTE]`
 * leaks the raw `[!NOTE]` string into the paragraph — the "blockquote
 * formatting breaks" symptom reported in Issue 24.
 *
 * The plugin runs on the mdast (after `remark-gfm`, before the source-map
 * plugin) and:
 *   1. tags the `<blockquote>` with `class="markdown-alert markdown-alert-<type>"`
 *      (GitHub-compatible class names, so the CSS in `../../styles/markdown.css`
 *      matches),
 *   2. strips the `[!TYPE]` marker line from the first paragraph,
 *   3. prepends a `<p class="markdown-alert-title">Note</p>` title node.
 *
 * The container stays a `<blockquote>`, so `remark-vellis-source-map` still
 * stamps the Vellis data attributes onto it and the left-border styling holds.
 * The title paragraph is generated (no `position`), so the source-map plugin
 * skips it — it carries no node id, which is what keeps `selection.ts` from
 * pairing it with an mdast text node.
 *
 * The `markdown-alert*` class names must be permitted on `blockquote` / `p` by
 * `vellisSchema` (see `../sanitize-schema.ts`).
 */
import { visit } from 'unist-util-visit';
import type { Blockquote, Paragraph, Root, Text } from 'mdast';

const ALERT_LABELS: Record<string, string> = {
	note: 'Note',
	tip: 'Tip',
	important: 'Important',
	warning: 'Warning',
	caution: 'Caution',
};

// The marker must occupy the whole first line: `[!TYPE]` optionally followed
// by trailing spaces, then a newline or end-of-text.  Body text on the same
// line means it is not an alert (GitHub behaves the same way).
const MARKER = /^\[!(note|tip|important|warning|caution)\][^\S\n]*(\n|$)/i;

interface HData {
	hProperties?: Record<string, unknown>;
}

function addClass(node: { data?: HData }, ...classes: string[]): void {
	const data = (node.data ??= {});
	const props = (data.hProperties ??= {});
	const existing = props.className;
	const list = Array.isArray(existing)
		? [...(existing as string[])]
		: typeof existing === 'string' && existing.length > 0
			? existing.split(/\s+/)
			: [];
	props.className = [...list, ...classes];
}

function makeTitle(label: string): Paragraph {
	const title: Paragraph & { data: HData } = {
		type: 'paragraph',
		data: { hProperties: { className: ['markdown-alert-title'] } },
		children: [{ type: 'text', value: label } as Text],
	};
	return title;
}

export function remarkVellisAlert() {
	return (tree: Root) => {
		visit(tree, 'blockquote', (node: Blockquote) => {
			const first = node.children[0];
			if (!first || first.type !== 'paragraph') return;

			const firstText = first.children[0];
			if (!firstText || firstText.type !== 'text') return;

			const match = MARKER.exec(firstText.value);
			if (!match) return;

			const type = match[1].toLowerCase();
			const label = ALERT_LABELS[type];
			if (!label) return;

			addClass(node, 'markdown-alert', `markdown-alert-${type}`);

			firstText.value = firstText.value.slice(match[0].length);
			if (firstText.value.length === 0) {
				// Nothing of the marker line is left to render. Drop the emptied text
				// node — and the hard break that trailing spaces on the marker line
				// produce, which belongs to that line too — so the body starts clean.
				first.children.shift();
				if (first.children[0]?.type === 'break') first.children.shift();
				// Marker-only paragraph (`> [!NOTE]` with the body in a later block,
				// or no body at all): drop the now-empty leading paragraph.
				if (first.children.length === 0) node.children.shift();
			}

			node.children.unshift(makeTitle(label));
		});
	};
}
