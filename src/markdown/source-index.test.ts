import { describe, expect, test } from 'vitest';
import { buildSourceIndex, isBlockType } from './source-index';
import type { NodeMeta } from './types';

function meta(
	id: string,
	type: string,
	startOffset: number,
	endOffset: number,
	startLine: number,
	endLine: number,
	parentBlockId: string | null = null,
	headingPath: string[] = [],
): NodeMeta {
	return {
		id,
		type,
		parentBlockId,
		headingPath,
		position: {
			startLine,
			startColumn: 1,
			startOffset,
			endLine,
			endColumn: 1,
			endOffset,
		},
	};
}

describe('isBlockType', () => {
	test.each([
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
	])('%s is block', (type) => {
		expect(isBlockType(type)).toBe(true);
	});

	test.each([
		'text',
		'emphasis',
		'strong',
		'delete',
		'inlineCode',
		'link',
		'image',
		'linkReference',
		'imageReference',
		'footnoteReference',
		'break',
	])('%s is inline', (type) => {
		expect(isBlockType(type)).toBe(false);
	});
});

describe('buildSourceIndex', () => {
	const source = '# Heading\n\nA paragraph with **bold** text.\n';

	test('byId maps every id to its NodeMeta', () => {
		const h = meta('n_0000', 'heading', 0, 9, 1, 1);
		const p = meta('n_0001', 'paragraph', 11, 42, 3, 3);
		const index = buildSourceIndex([h, p], source);

		expect(index.byId.size).toBe(2);
		expect(index.byId.get('n_0000')).toBe(h);
		expect(index.byId.get('n_0001')).toBe(p);
	});

	test('sliceOf returns source.slice(startOffset, endOffset)', () => {
		const h = meta('n_0000', 'heading', 0, 9, 1, 1);
		const index = buildSourceIndex([h], source);
		expect(index.sliceOf('n_0000')).toBe('# Heading');
	});

	test('sliceOf returns empty string for unknown id', () => {
		const index = buildSourceIndex([], source);
		expect(index.sliceOf('missing')).toBe('');
	});

	test('blockAtLine returns the most specific block covering the line', () => {
		// list (lines 1-3) > listItem (lines 1-1) > paragraph (lines 1-1)
		const list = meta('n_0000', 'list', 0, 30, 1, 3);
		const item = meta('n_0001', 'listItem', 0, 10, 1, 1, 'n_0000');
		const para = meta('n_0002', 'paragraph', 2, 9, 1, 1, 'n_0001');
		const index = buildSourceIndex([list, item, para], '- one\n- two\n- three\n');

		const result = index.blockAtLine(1);
		// paragraph has the smallest offset span
		expect(result?.id).toBe('n_0002');
	});

	test('blockAtLine ignores inline nodes', () => {
		const para = meta('n_0000', 'paragraph', 0, 30, 1, 1);
		const strong = meta('n_0001', 'strong', 18, 26, 1, 1, 'n_0000');
		const index = buildSourceIndex([para, strong], 'A paragraph with **bold** text.');
		// Even though strong has a smaller span, it's inline so paragraph wins
		expect(index.blockAtLine(1)?.id).toBe('n_0000');
	});

	test('blockAtLine returns null for a line outside any block', () => {
		const h = meta('n_0000', 'heading', 0, 9, 1, 1);
		const index = buildSourceIndex([h], '# Heading\n');
		expect(index.blockAtLine(99)).toBeNull();
	});

	test('byId is a ReadonlyMap (mutation prevented at type level)', () => {
		const h = meta('n_0000', 'heading', 0, 9, 1, 1);
		const index = buildSourceIndex([h], '# Heading');
		// `byId` is exposed as ReadonlyMap; runtime is still a Map but the
		// interface contract forbids set/delete.  This test verifies the
		// expected access pattern works.
		expect(Array.from(index.byId.keys())).toEqual(['n_0000']);
	});
});
