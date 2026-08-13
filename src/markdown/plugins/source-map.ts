/**
 * `remark-vellis-source-map` — assigns each mdast node a stable `nodeId`
 * and stamps Vellis-specific data attributes onto `data.hProperties` so
 * that `remark-rehype` propagates them to the final HTML.
 *
 * Spec: `docs/archives/rendering-engine.md` §3.3.  Heading paths are tracked by
 * depth; block ancestry is tracked by an explicit stack so that inline
 * nodes carry the id of the nearest enclosing block (used by
 * `nearestBlock` in `selection.ts`).
 *
 * The plugin is paired with `buildSourceIndex(metas, source)` from
 * `../source-index.ts`.  The `onIndex` callback emits one `NodeMeta`
 * per visited node in document order.
 */
import { toString as mdastToString } from 'mdast-util-to-string';
import type { Root } from 'mdast';
import type { NodeMeta, SourcePosition } from '../types';
import { isBlockType } from '../source-index';

export interface RemarkVellisSourceMapOptions {
	onIndex?: (meta: NodeMeta) => void;
}

interface NodeWithChildren {
	type: string;
	position?: {
		start: { line: number; column: number; offset?: number };
		end: { line: number; column: number; offset?: number };
	};
	data?: { hProperties?: Record<string, string> };
	children?: NodeWithChildren[];
	depth?: number;
	lang?: string | null;
}

function makeId(counter: number): string {
	return `n_${String(counter).padStart(4, '0')}`;
}

function toSourcePosition(
	pos: NonNullable<NodeWithChildren['position']>,
): SourcePosition {
	return {
		startLine: pos.start.line,
		startColumn: pos.start.column,
		startOffset: pos.start.offset ?? 0,
		endLine: pos.end.line,
		endColumn: pos.end.column,
		endOffset: pos.end.offset ?? 0,
	};
}

function extractExtra(node: NodeWithChildren): NodeMeta['extra'] {
	if (node.type === 'code' && node.lang) return { lang: node.lang };
	if (node.type === 'heading' && typeof node.depth === 'number') {
		return { depth: node.depth };
	}
	return undefined;
}

export function remarkVellisSourceMap(
	opts: RemarkVellisSourceMapOptions = {},
) {
	return (tree: Root) => {
		let counter = 0;
		const headingStack: string[] = [];

		function walk(
			node: NodeWithChildren,
			ancestorBlockIds: readonly string[],
		): void {
			if (!node.position) {
				if (node.children) {
					for (const child of node.children) walk(child, ancestorBlockIds);
				}
				return;
			}

			const id = makeId(counter++);
			const block = isBlockType(node.type);
			const parentBlockId =
				ancestorBlockIds.length > 0
					? ancestorBlockIds[ancestorBlockIds.length - 1]
					: null;

			let headingPathForNode: string[];
			if (node.type === 'heading' && typeof node.depth === 'number') {
				// Heading's own path is the chain of *ancestor* headings: snapshot
				// the stack truncated to depth-1, then push self for descendants
				// and following siblings.
				headingStack.length = node.depth - 1;
				headingPathForNode = [...headingStack];
				headingStack[node.depth - 1] = mdastToString(node);
			} else {
				headingPathForNode = [...headingStack];
			}

			const data = (node.data ??= {});
			const props = (data.hProperties ??= {});
			props['data-vellis-node-id'] = id;
			props['data-source-start'] = String(node.position.start.offset ?? '');
			props['data-source-end'] = String(node.position.end.offset ?? '');
			props['data-source-start-line'] = String(node.position.start.line);
			props['data-source-end-line'] = String(node.position.end.line);
			props['data-vellis-node-type'] = node.type;

			opts.onIndex?.({
				id,
				type: node.type,
				position: toSourcePosition(node.position),
				parentBlockId,
				headingPath: headingPathForNode,
				extra: extractExtra(node),
			});

			if (node.children && node.children.length > 0) {
				const nextAncestors = block
					? [...ancestorBlockIds, id]
					: ancestorBlockIds;
				for (const child of node.children) walk(child, nextAncestors);
			}
		}

		walk(tree as unknown as NodeWithChildren, []);
	};
}
