/**
 * Selection resolution tests.
 *
 * Drives `resolveSelectionToMarkdown` / `buildAnchor` through a real
 * unified pipeline rendered into jsdom, then performs DOM Range / Selection
 * operations to mimic what the user does in the Webview.
 *
 * Spec: `docs/archives/rendering-engine.md` §3.8.  Covers part of P0.13 ahead of
 * the dedicated test task; see tasks/todo.md.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import { render } from './renderer';
import {
	buildAnchor,
	nearestBlock,
	resolveSelectionToMarkdown,
} from './selection';
import type { NodeMeta } from './types';

const baseUri = 'file:///home/user/notes/doc.md';

async function mount(source: string): Promise<{
	source: string;
	html: string;
	index: Awaited<ReturnType<typeof render>>['index'];
	root: HTMLDivElement;
}> {
	const result = await render(source, baseUri);
	const root = document.createElement('div');
	root.innerHTML = result.html;
	document.body.append(root);
	return { source, html: result.html, index: result.index, root };
}

beforeEach(() => {
	document.body.innerHTML = '';
});

function selectInside(el: Element): Selection {
	const sel = window.getSelection();
	if (!sel) throw new Error('no selection');
	sel.removeAllRanges();
	const range = document.createRange();
	range.selectNodeContents(el);
	sel.addRange(range);
	return sel;
}

function selectAcross(startEl: Element, endEl: Element): Selection {
	const sel = window.getSelection();
	if (!sel) throw new Error('no selection');
	sel.removeAllRanges();
	const range = document.createRange();
	range.setStart(startEl, 0);
	range.setEnd(endEl, endEl.childNodes.length);
	sel.addRange(range);
	return sel;
}

describe('resolveSelectionToMarkdown', () => {
	test('returns null for collapsed selection', async () => {
		const { index, source } = await mount('# title\n');
		const sel = window.getSelection()!;
		sel.removeAllRanges();
		expect(resolveSelectionToMarkdown(sel, index, source)).toBeNull();
	});

	test('inline selection inside a paragraph yields precise inline slice', async () => {
		const src = 'A **bold** word.\n';
		const { index, source, root } = await mount(src);

		const strong = root.querySelector('strong[data-vellis-node-id]');
		expect(strong).toBeTruthy();
		const sel = selectInside(strong!);

		const result = resolveSelectionToMarkdown(sel, index, source);
		expect(result).not.toBeNull();
		expect(result!.mode).toBe('inline');
		expect(result!.markdown).toBe('**bold**');
	});

	test('block-level selection yields the full block markdown', async () => {
		const src = '# title\n\nbody text\n';
		const { index, source, root } = await mount(src);

		const heading = root.querySelector('h1[data-vellis-node-id]');
		const sel = selectInside(heading!);
		const result = resolveSelectionToMarkdown(sel, index, source);

		expect(result).not.toBeNull();
		expect(result!.mode).toBe('block');
		expect(result!.markdown).toBe('# title');
	});

	test('selection spanning two block paragraphs covers both blocks', async () => {
		const src = 'first paragraph\n\nsecond paragraph\n';
		const { index, source, root } = await mount(src);

		const paragraphs = root.querySelectorAll('p[data-vellis-node-id]');
		expect(paragraphs.length).toBe(2);
		const sel = selectAcross(paragraphs[0], paragraphs[1]);

		const result = resolveSelectionToMarkdown(sel, index, source);
		expect(result).not.toBeNull();
		expect(result!.mode).toBe('block');
		// Slice should cover both paragraphs (with the blank line between).
		expect(result!.markdown).toContain('first paragraph');
		expect(result!.markdown).toContain('second paragraph');
	});

	test('returns null when selection has no [data-vellis-node-id] ancestor', async () => {
		const isolated = document.createElement('div');
		isolated.innerHTML = '<span>plain</span>';
		document.body.append(isolated);

		// Build an empty index to simulate "selection outside renderer DOM".
		const { source, index } = await mount('para\n');
		const sel = selectInside(isolated.querySelector('span')!);
		const result = resolveSelectionToMarkdown(sel, index, source);
		expect(result).toBeNull();
	});

	test('selection direction (focus before anchor) is normalised by min/max offsets', async () => {
		const src = 'A *one* and *two* word.\n';
		const { index, source, root } = await mount(src);

		const ems = root.querySelectorAll('em[data-vellis-node-id]');
		expect(ems.length).toBe(2);

		const sel = window.getSelection()!;
		sel.removeAllRanges();
		// Reverse direction: anchor at the *second* em, focus at the *first*.
		// Range itself enforces start ≤ end, so use setBaseAndExtent which
		// supports anchor-after-focus selections (matches real user behaviour
		// when dragging right-to-left).
		sel.setBaseAndExtent(ems[1], 0, ems[0], ems[0].childNodes.length);

		const result = resolveSelectionToMarkdown(sel, index, source);
		expect(result).not.toBeNull();
		// Whichever direction the user selected, the slice runs from the
		// earlier offset to the later one, which spans both ems and the text
		// between them.
		expect(result!.markdown).toContain('*one*');
		expect(result!.markdown).toContain('*two*');
		// First nodeId should refer to the lower-offset endpoint.
		const firstMeta = index.byId.get(result!.nodeIds[0])!;
		const secondMeta = index.byId.get(result!.nodeIds[1])!;
		expect(firstMeta.position.startOffset).toBeLessThanOrEqual(secondMeta.position.startOffset);
	});
});

describe('nearestBlock', () => {
	test('inline meta resolves to its enclosing block', async () => {
		const { index } = await mount('A **bold** word.\n');
		const strong = [...index.byId.values()].find((m) => m.type === 'strong');
		const para = [...index.byId.values()].find((m) => m.type === 'paragraph');
		expect(strong).toBeDefined();
		expect(para).toBeDefined();
		const result = nearestBlock(strong as NodeMeta, index);
		expect(result.id).toBe((para as NodeMeta).id);
	});

	test('block meta is returned as-is', async () => {
		const { index } = await mount('# title\n');
		const heading = [...index.byId.values()].find((m) => m.type === 'heading');
		expect(heading).toBeDefined();
		const result = nearestBlock(heading as NodeMeta, index);
		expect(result.id).toBe((heading as NodeMeta).id);
	});
});

describe('buildAnchor', () => {
	test('produces an AnchorInput with selected_markdown / start_offset / end_offset', async () => {
		const src = 'A **bold** word.\n';
		const { index, source, root } = await mount(src);
		const strong = root.querySelector('strong[data-vellis-node-id]')!;
		const sel = selectInside(strong);

		const anchor = buildAnchor(sel, index, source, 'sha256-abc');
		expect(anchor).not.toBeNull();
		expect(anchor!.fileHash).toBe('sha256-abc');
		expect(anchor!.selectedMarkdown).toBe('**bold**');
		// `selectedText` is the rendered text inside <strong>: "bold"
		expect(anchor!.selectedText).toBe('bold');
		expect(source.slice(anchor!.startOffset, anchor!.endOffset)).toBe('**bold**');
		expect(anchor!.startLine).toBe(1);
		expect(anchor!.endLine).toBe(1);
		expect(anchor!.nodeType).toBe('strong');
	});

	test('headingPath is taken from the first endpoint NodeMeta', async () => {
		const src = '# Top\n\n## Sub\n\nA *em* word.\n';
		const { index, source, root } = await mount(src);
		const em = root.querySelector('em[data-vellis-node-id]')!;
		const sel = selectInside(em);

		const anchor = buildAnchor(sel, index, source, 'h')!;
		expect(anchor.headingPath).toEqual(['Top', 'Sub']);
	});

	test('contextBefore / contextAfter capture neighbouring lines', async () => {
		const src = 'before line\n\n# title\n\nafter line\n';
		const { index, source, root } = await mount(src);
		const heading = root.querySelector('h1[data-vellis-node-id]')!;
		const sel = selectInside(heading);

		const anchor = buildAnchor(sel, index, source, 'h')!;
		// startLine=3, endLine=3 → before is line 2 ("" blank), after is line 4 ("" blank)
		// before line is at index 0, blank at index 1, "# title" at index 2,
		// blank at index 3, "after line" at index 4.
		expect(anchor.startLine).toBe(3);
		expect(anchor.endLine).toBe(3);
		// Lines 2 and 4 in the source split are blank lines around the heading
		expect(anchor.contextBefore).toBe('');
		expect(anchor.contextAfter).toBe('');
	});

	test('returns null when the selection cannot be resolved', async () => {
		const { index, source } = await mount('para\n');
		const sel = window.getSelection()!;
		sel.removeAllRanges();
		expect(buildAnchor(sel, index, source, 'h')).toBeNull();
	});
});
