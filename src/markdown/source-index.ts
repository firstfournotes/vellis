/**
 * Immutable `SourceIndex` over the mdast traversal result produced by
 * `remark-vellis-source-map` (P0.3).
 *
 * Spec: `docs/archives/rendering-engine.md` §3.2.  Block classification matches the
 * MVP scope in §4.1: `tableRow` / `tableCell` are recorded but selection
 * rolls them up to `table`; this module classifies them as block so that
 * `blockAtLine` can return them when the caller asks specifically.
 *
 * `nearestBlock` (used by `selection.ts`) walks `parentBlockId` upward
 * which the plugin assigns based on the same `BLOCK_TYPES` set.
 */
import type { NodeMeta, SourceIndex } from './types';

const BLOCK_TYPES: ReadonlySet<string> = new Set([
	'paragraph',
	'heading',
	'list',
	'listItem',
	'blockquote',
	'code',
	'html',
	'table',
	'tableRow',
	'tableCell',
	'thematicBreak',
	'footnoteDefinition',
	'definition',
]);

export function isBlockType(type: string): boolean {
	return BLOCK_TYPES.has(type);
}

export function buildSourceIndex(metas: readonly NodeMeta[], source: string): SourceIndex {
	const byId = new Map<string, NodeMeta>();
	for (const meta of metas) {
		byId.set(meta.id, meta);
	}

	function sliceOf(nodeId: string): string {
		const meta = byId.get(nodeId);
		if (!meta) return '';
		return source.slice(meta.position.startOffset, meta.position.endOffset);
	}

	function blockAtLine(line: number): NodeMeta | null {
		let best: NodeMeta | null = null;
		let bestSpan = Number.POSITIVE_INFINITY;
		for (const meta of byId.values()) {
			if (!isBlockType(meta.type)) continue;
			const { startLine, endLine, startOffset, endOffset } = meta.position;
			if (startLine > line || endLine < line) continue;
			const span = endOffset - startOffset;
			if (span < bestSpan) {
				best = meta;
				bestSpan = span;
			}
		}
		return best;
	}

	return { byId, sliceOf, blockAtLine };
}
