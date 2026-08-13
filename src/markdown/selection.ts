/**
 * DOM `Selection` ↔ Markdown source resolution.
 *
 * Spec: `docs/archives/rendering-engine.md` §3.8.  Both Phase B "Copy as Markdown"
 * (copy-original-markdown.md) and Phase 4.1 mark creation (ai-collab.md
 * §10.1) build on the helpers exposed here, so the selection logic lives
 * in one place.
 *
 * Inputs:
 * - a live `Selection` (from `window.getSelection()`)
 * - the `SourceIndex` produced by the most recent `render(source, ...)`
 * - the original Markdown source text
 *
 * Outputs:
 * - `resolveSelectionToMarkdown` — the source slice covered by the selection
 *   plus its endpoint nodeIds and a hint at whether the endpoints are
 *   block- or inline-level.  The slice is narrowed to the selected characters
 *   when the endpoints can be mapped back to source offsets with certainty
 *   (requirement #13 / GitHub issue 26); `nodeIds` stay node-level either way.
 * - `nearestBlock` — walks `parentBlockId` until a block ancestor is found
 *   (used by callers that want to roll inline selections up to their block)
 * - `buildAnchor` — assembles an `AnchorInput` for ai-collab `add_mark`
 *   (rendering-engine.md §3.8.3, ai-collab.md §4.1.1)
 */
import type { NodeMeta, SourceIndex } from './types';
import type { AnchorInput } from '$lib/annotation';
import { isBlockType } from './source-index';

export interface ResolvedSelection {
	markdown: string;
	nodeIds: [string, string];
	mode: 'inline' | 'block';
}

/**
 * `BuiltAnchor` extends the IPC payload with the originating nodeId /
 * nodeType so the Webview can resolve a mark's DOM position later
 * (e.g. for MarkPin placement).  These two fields are intentionally
 * dropped before persistence — `nodeId` is renumbered on every render
 * (`docs/ai-collab.md` §10.1, rendering-engine.md §3.10).
 */
export interface BuiltAnchor extends AnchorInput {
	nodeId: string;
	nodeType: string;
}

function closestNode(n: Node | null): Element | null {
	let cur: Node | null = n;
	while (cur && cur.nodeType !== Node.ELEMENT_NODE) cur = cur.parentNode;
	if (!cur) return null;
	return (cur as Element).closest('[data-vellis-node-id]');
}

function metaOfElement(el: Element, index: SourceIndex): NodeMeta | null {
	const id = el.getAttribute('data-vellis-node-id');
	if (!id) return null;
	return index.byId.get(id) ?? null;
}

function enclosingNode(el: Element): Element | null {
	return el.parentElement?.closest('[data-vellis-node-id]') ?? null;
}

function textNodesIn(root: Element): Text[] {
	const out: Text[] = [];
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
	return out;
}

/**
 * The block an endpoint lives in — the scope character-level narrowing works
 * within (requirement #13 ① only covers selections inside one block).  Falls
 * back to the outermost inline node when the endpoint has no block ancestor.
 */
function scopeOf(
	node: Node | null,
	index: SourceIndex,
): { el: Element; meta: NodeMeta } | null {
	let el = closestNode(node);
	while (el) {
		const meta = metaOfElement(el, index);
		if (!meta) return null;
		if (isBlockType(meta.type)) return { el, meta };
		const parent = enclosingNode(el);
		if (!parent) return { el, meta };
		el = parent;
	}
	return null;
}

/**
 * Maps every DOM text node inside `scope` to the source offset its first
 * character came from, by pairing them with the mdast `text` nodes recorded
 * in the index (they carry exact source positions).
 *
 * The pairing is only trusted when the counts match *and* every source slice
 * is byte-identical to the rendered text.  Backslash escapes (`\*`) and
 * character references (`&amp;`) break that identity, as does any generated
 * text with no mdast counterpart (Shiki spans, footnote markers, raw HTML
 * blocks) — those return `null` so the caller keeps the node-level slice
 * (requirement #13 ③).
 */
function buildTextSourceMap(
	scope: { el: Element; meta: NodeMeta },
	index: SourceIndex,
	source: string,
): ReadonlyMap<Text, number> | null {
	const { startOffset, endOffset } = scope.meta.position;
	const metas: NodeMeta[] = [];
	for (const meta of index.byId.values()) {
		if (meta.type !== 'text') continue;
		if (meta.position.startOffset < startOffset) continue;
		if (meta.position.endOffset > endOffset) continue;
		metas.push(meta);
	}
	metas.sort((a, b) => a.position.startOffset - b.position.startOffset);

	const texts = textNodesIn(scope.el);
	if (texts.length === 0 || texts.length !== metas.length) return null;

	const map = new Map<Text, number>();
	for (let i = 0; i < texts.length; i += 1) {
		const pos = metas[i].position;
		if (source.slice(pos.startOffset, pos.endOffset) !== texts[i].data) return null;
		map.set(texts[i], pos.startOffset);
	}
	return map;
}

/** Source range covered by the rendered text inside `el`, markers excluded. */
function contentBounds(
	el: Element,
	map: ReadonlyMap<Text, number>,
): { start: number; end: number } | null {
	const texts = textNodesIn(el).filter((t) => map.has(t));
	if (texts.length === 0) return null;
	const last = texts[texts.length - 1];
	return {
		start: map.get(texts[0]) as number,
		end: (map.get(last) as number) + last.data.length,
	};
}

/**
 * Grows an endpoint outward over inline markers it sits flush against, so a
 * selection covering all of `<strong>bold</strong>` yields `**bold**` rather
 * than `bold` (requirement #13 ②).  Block markers (`# `, `- `) are left alone:
 * the loop stops at the first block ancestor.
 */
function expandOverInlineMarkers(
	offset: number,
	from: Text,
	index: SourceIndex,
	map: ReadonlyMap<Text, number>,
	side: 'start' | 'end',
): number {
	let result = offset;
	let el = closestNode(from);
	while (el) {
		const meta = metaOfElement(el, index);
		if (!meta || isBlockType(meta.type)) break;
		const bounds = contentBounds(el, map);
		if (!bounds) break;
		if (side === 'start') {
			if (result !== bounds.start) break;
			result = Math.min(result, meta.position.startOffset);
		} else {
			if (result !== bounds.end) break;
			result = Math.max(result, meta.position.endOffset);
		}
		el = enclosingNode(el);
	}
	return result;
}

/**
 * Narrows a node-level source range `[nodeStart, nodeEnd)` down to the source
 * fragment the user actually selected (requirement #13 ①).
 *
 * Returns `null` whenever the narrowing cannot be established with certainty,
 * which keeps the caller on the node-level slice.  That covers endpoints
 * anchored on elements rather than text (`selectNodeContents`, select-all —
 * whole-node intent), endpoints in different blocks (out of scope for #13),
 * and sources whose rendered text does not correspond 1:1 to the Markdown.
 */
function narrowToSelection(
	sel: Selection,
	index: SourceIndex,
	source: string,
	nodeStart: number,
	nodeEnd: number,
): { start: number; end: number } | null {
	if (sel.rangeCount === 0) return null;
	// `getRangeAt` is already in document order, so right-to-left drags
	// (anchor after focus) need no extra handling here.
	const range = sel.getRangeAt(0);
	const from = range.startContainer;
	const to = range.endContainer;
	if (from.nodeType !== Node.TEXT_NODE || to.nodeType !== Node.TEXT_NODE) return null;

	const scope = scopeOf(from, index);
	const toScope = scopeOf(to, index);
	if (!scope || !toScope || scope.el !== toScope.el) return null;

	const map = buildTextSourceMap(scope, index, source);
	if (!map) return null;

	const fromBase = map.get(from as Text);
	const toBase = map.get(to as Text);
	if (fromBase === undefined || toBase === undefined) return null;

	let start = fromBase + Math.min(range.startOffset, (from as Text).data.length);
	let end = toBase + Math.min(range.endOffset, (to as Text).data.length);
	if (end < start) return null;

	// Whole rendered content of the block: keep the block's own source,
	// markers included (requirement #13 ① "selecting the block still yields
	// the block").
	const scopeBounds = contentBounds(scope.el, map);
	if (scopeBounds && start === scopeBounds.start && end === scopeBounds.end) {
		return {
			start: scope.meta.position.startOffset,
			end: scope.meta.position.endOffset,
		};
	}

	start = expandOverInlineMarkers(start, from as Text, index, map, 'start');
	end = expandOverInlineMarkers(end, to as Text, index, map, 'end');

	// Never widen past what the node-level resolution would have returned.
	start = Math.max(start, nodeStart);
	end = Math.min(end, nodeEnd);
	if (end <= start) return null;
	return { start, end };
}

export function nearestBlock(meta: NodeMeta, index: SourceIndex): NodeMeta {
	let cur: NodeMeta | null = meta;
	while (cur && !isBlockType(cur.type) && cur.parentBlockId) {
		cur = index.byId.get(cur.parentBlockId) ?? null;
	}
	return cur ?? meta;
}

export function resolveSelectionToMarkdown(
	sel: Selection,
	index: SourceIndex,
	source: string,
): ResolvedSelection | null {
	if (sel.isCollapsed) return null;

	const startEl = closestNode(sel.anchorNode);
	const endEl = closestNode(sel.focusNode);
	if (!startEl || !endEl) return null;

	const startId = startEl.getAttribute('data-vellis-node-id');
	const endId = endEl.getAttribute('data-vellis-node-id');
	if (!startId || !endId) return null;

	const startMeta = index.byId.get(startId);
	const endMeta = index.byId.get(endId);
	if (!startMeta || !endMeta) return null;

	// Selection direction (anchor before/after focus) is unknown at this
	// level; min/max normalises both directions to a positive range.
	const startOffset = Math.min(
		startMeta.position.startOffset,
		endMeta.position.startOffset,
	);
	const endOffset = Math.max(
		startMeta.position.endOffset,
		endMeta.position.endOffset,
	);
	const mode: 'inline' | 'block' =
		isBlockType(startMeta.type) && isBlockType(endMeta.type) ? 'block' : 'inline';

	// Emit ids in selection order: the lower-offset endpoint first.
	const orderedIds: [string, string] =
		startMeta.position.startOffset <= endMeta.position.startOffset
			? [startId, endId]
			: [endId, startId];

	// `nodeIds` / `mode` stay node-level — mark placement is anchored on them
	// (requirement #13 ④).  Only the copied fragment narrows.
	const narrowed = narrowToSelection(sel, index, source, startOffset, endOffset);

	return {
		markdown: source.slice(narrowed?.start ?? startOffset, narrowed?.end ?? endOffset),
		nodeIds: orderedIds,
		mode,
	};
}

function lineBefore(source: string, startLine: number): string {
	if (startLine <= 1) return '';
	const lines = source.split('\n');
	return lines[startLine - 2] ?? '';
}

function lineAfter(source: string, endLine: number): string {
	const lines = source.split('\n');
	return lines[endLine] ?? '';
}

export function buildAnchor(
	sel: Selection,
	index: SourceIndex,
	source: string,
	fileHash: string,
): BuiltAnchor | null {
	const resolved = resolveSelectionToMarkdown(sel, index, source);
	if (!resolved) return null;

	const [firstId, secondId] = resolved.nodeIds;
	const firstMeta = index.byId.get(firstId);
	const secondMeta = index.byId.get(secondId);
	if (!firstMeta || !secondMeta) return null;

	const startLine = Math.min(firstMeta.position.startLine, secondMeta.position.startLine);
	const endLine = Math.max(firstMeta.position.endLine, secondMeta.position.endLine);
	const startOffset = Math.min(firstMeta.position.startOffset, secondMeta.position.startOffset);
	const endOffset = Math.max(firstMeta.position.endOffset, secondMeta.position.endOffset);

	return {
		nodeId: firstId,
		nodeType: firstMeta.type,
		startLine,
		endLine,
		startOffset,
		endOffset,
		selectedMarkdown: resolved.markdown,
		selectedText: sel.toString(),
		headingPath: [...firstMeta.headingPath],
		contextBefore: lineBefore(source, startLine),
		contextAfter: lineAfter(source, endLine),
		fileHash,
	};
}
