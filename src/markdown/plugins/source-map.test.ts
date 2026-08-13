import { describe, expect, test } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { remarkVellisSourceMap } from './source-map';
import { buildSourceIndex } from '../source-index';
import type { NodeMeta } from '../types';

async function collect(source: string): Promise<{ html: string; metas: NodeMeta[] }> {
	const metas: NodeMeta[] = [];
	const file = await unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkVellisSourceMap, { onIndex: (m) => metas.push(m) })
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeStringify, { allowDangerousHtml: true })
		.process(source);
	return { html: String(file), metas };
}

function byType(metas: NodeMeta[], type: string): NodeMeta[] {
	return metas.filter((m) => m.type === type);
}

describe('remarkVellisSourceMap — node id assignment', () => {
	test('assigns sequential zero-padded ids in document order', async () => {
		const { metas } = await collect('# A\n\nparagraph\n');
		expect(metas[0].id).toBe('n_0000');
		expect(metas[1].id).toBe('n_0001');
		// Each subsequent id strictly increases
		for (let i = 1; i < metas.length; i++) {
			expect(metas[i].id > metas[i - 1].id).toBe(true);
		}
	});

	test('id format is n_NNNN with 4-digit zero pad', async () => {
		const { metas } = await collect('para\n');
		for (const meta of metas) {
			expect(meta.id).toMatch(/^n_\d{4}$/);
		}
	});
});

describe('remarkVellisSourceMap — hProperties propagation to HTML', () => {
	test('block tags carry data-vellis-node-id and data-source-* attributes', async () => {
		const { html } = await collect('# Heading\n\nA paragraph.\n');
		expect(html).toContain('data-vellis-node-id="n_');
		expect(html).toContain('data-source-start="');
		expect(html).toContain('data-source-end="');
		expect(html).toContain('data-source-start-line="');
		expect(html).toContain('data-source-end-line="');
		expect(html).toContain('data-vellis-node-type="heading"');
		expect(html).toContain('data-vellis-node-type="paragraph"');
	});

	test('inline tags carry their own attributes', async () => {
		const { html } = await collect('A *emph* and **strong** word.\n');
		expect(html).toContain('data-vellis-node-type="emphasis"');
		expect(html).toContain('data-vellis-node-type="strong"');
	});
});

describe('remarkVellisSourceMap — position values', () => {
	test('startLine is 1-origin', async () => {
		const { metas } = await collect('# A\n\nB\n');
		const heading = byType(metas, 'heading')[0];
		expect(heading.position.startLine).toBe(1);
	});

	test('startOffset is 0-origin and matches source.slice', async () => {
		const source = '# Heading\n\nparagraph\n';
		const { metas } = await collect(source);
		const para = byType(metas, 'paragraph')[0];
		const slice = source.slice(para.position.startOffset, para.position.endOffset);
		expect(slice).toBe('paragraph');
	});

	test('inline node offsets allow precise slicing of bold text', async () => {
		const source = 'A **bold** word.\n';
		const { metas } = await collect(source);
		const strong = byType(metas, 'strong')[0];
		const slice = source.slice(strong.position.startOffset, strong.position.endOffset);
		expect(slice).toBe('**bold**');
	});
});

describe('remarkVellisSourceMap — headingPath', () => {
	test('top-level heading has empty headingPath', async () => {
		const { metas } = await collect('# Top\n');
		const heading = byType(metas, 'heading')[0];
		expect(heading.headingPath).toEqual([]);
	});

	test('paragraph under heading inherits the heading text', async () => {
		const { metas } = await collect('# API\n\ncontent\n');
		const para = byType(metas, 'paragraph')[0];
		expect(para.headingPath).toEqual(['API']);
	});

	test('nested headings build the path', async () => {
		const source = '# A\n\n## B\n\ncontent\n';
		const { metas } = await collect(source);
		const headingA = byType(metas, 'heading').find((m) => m.extra?.depth === 1)!;
		const headingB = byType(metas, 'heading').find((m) => m.extra?.depth === 2)!;
		const para = byType(metas, 'paragraph')[0];
		expect(headingA.headingPath).toEqual([]);
		expect(headingB.headingPath).toEqual(['A']);
		expect(para.headingPath).toEqual(['A', 'B']);
	});

	test('sibling headings replace the deeper level', async () => {
		const source = '# Top\n\n## B\n\nin B\n\n## C\n\nin C\n';
		const { metas } = await collect(source);
		const paras = byType(metas, 'paragraph');
		expect(paras[0].headingPath).toEqual(['Top', 'B']);
		expect(paras[1].headingPath).toEqual(['Top', 'C']);
	});

	test('returning to a shallower heading drops deeper entries', async () => {
		const source = '# A\n\n## B\n\nin B\n\n# D\n\nin D\n';
		const { metas } = await collect(source);
		const paras = byType(metas, 'paragraph');
		expect(paras[0].headingPath).toEqual(['A', 'B']);
		expect(paras[1].headingPath).toEqual(['D']);
	});
});

describe('remarkVellisSourceMap — parentBlockId', () => {
	test('top-level block has null parentBlockId', async () => {
		const { metas } = await collect('paragraph\n');
		const para = byType(metas, 'paragraph')[0];
		expect(para.parentBlockId).toBeNull();
	});

	test('inline node points at its enclosing block', async () => {
		const { metas } = await collect('A **bold** word.\n');
		const para = byType(metas, 'paragraph')[0];
		const strong = byType(metas, 'strong')[0];
		expect(strong.parentBlockId).toBe(para.id);
	});

	test('nested list items track the listItem as parent block', async () => {
		const { metas } = await collect('- item one\n- item two\n');
		const list = byType(metas, 'list')[0];
		const items = byType(metas, 'listItem');
		expect(list.parentBlockId).toBeNull();
		for (const item of items) {
			expect(item.parentBlockId).toBe(list.id);
		}
	});
});

describe('remarkVellisSourceMap — node type coverage', () => {
	test('paragraph / heading / list / listItem / blockquote / code / thematicBreak', async () => {
		const source = [
			'# Heading',
			'',
			'paragraph text',
			'',
			'> a blockquote',
			'',
			'- list item',
			'',
			'```ts',
			'const x = 1;',
			'```',
			'',
			'---',
			'',
		].join('\n');
		const { metas } = await collect(source);
		const types = new Set(metas.map((m) => m.type));
		expect(types).toContain('heading');
		expect(types).toContain('paragraph');
		expect(types).toContain('list');
		expect(types).toContain('listItem');
		expect(types).toContain('blockquote');
		expect(types).toContain('code');
		expect(types).toContain('thematicBreak');
	});

	test('GFM table emits table / tableRow / tableCell', async () => {
		const source = '| a | b |\n|---|---|\n| 1 | 2 |\n';
		const { metas } = await collect(source);
		const types = new Set(metas.map((m) => m.type));
		expect(types).toContain('table');
		expect(types).toContain('tableRow');
		expect(types).toContain('tableCell');
	});

	test('inline coverage: emphasis / strong / delete / inlineCode / link', async () => {
		const source = 'A *em* **str** ~~del~~ `code` [link](https://x.test).\n';
		const { metas } = await collect(source);
		const types = new Set(metas.map((m) => m.type));
		expect(types).toContain('emphasis');
		expect(types).toContain('strong');
		expect(types).toContain('delete');
		expect(types).toContain('inlineCode');
		expect(types).toContain('link');
	});

	test('code block extra carries lang', async () => {
		const { metas } = await collect('```rust\nfn main() {}\n```\n');
		const code = byType(metas, 'code')[0];
		expect(code.extra?.lang).toBe('rust');
	});

	test('heading extra carries depth', async () => {
		const { metas } = await collect('### third level\n');
		const heading = byType(metas, 'heading')[0];
		expect(heading.extra?.depth).toBe(3);
	});

	test('block html node receives a NodeMeta with offset', async () => {
		const source = '<div class="x">raw block</div>\n';
		const { metas } = await collect(source);
		const htmlNodes = metas.filter((m) => m.type === 'html');
		expect(htmlNodes.length).toBeGreaterThanOrEqual(1);
		const slice = source.slice(
			htmlNodes[0].position.startOffset,
			htmlNodes[0].position.endOffset,
		);
		expect(slice).toContain('<div class="x">');
	});

	test('inline html node inside paragraph also gets a NodeMeta', async () => {
		const source = 'Press <kbd>Cmd</kbd>+<kbd>C</kbd>.\n';
		const { metas } = await collect(source);
		expect(metas.filter((m) => m.type === 'html').length).toBeGreaterThanOrEqual(2);
	});

	test('GFM footnote definition + reference are both indexed', async () => {
		const source = 'fact[^1]\n\n[^1]: the note\n';
		const { metas } = await collect(source);
		const types = new Set(metas.map((m) => m.type));
		expect(types).toContain('footnoteReference');
		expect(types).toContain('footnoteDefinition');

		const def = byType(metas, 'footnoteDefinition')[0];
		const ref = byType(metas, 'footnoteReference')[0];
		// Definition is block, parentBlockId is null at the top level
		expect(def.parentBlockId).toBeNull();
		// Reference is inline; its parentBlockId points at the enclosing paragraph
		const para = byType(metas, 'paragraph')[0];
		expect(ref.parentBlockId).toBe(para.id);
	});

	test('image extra has the alt or title not propagated; node still indexed', async () => {
		const source = '![alt text](pic.png "title")\n';
		const { metas } = await collect(source);
		const img = byType(metas, 'image')[0];
		expect(img).toBeDefined();
		const slice = source.slice(img.position.startOffset, img.position.endOffset);
		expect(slice).toBe('![alt text](pic.png "title")');
	});
});

describe('remarkVellisSourceMap — integration with buildSourceIndex', () => {
	test('built index can slice arbitrary nodes from the source', async () => {
		const source = '# Title\n\nbody text\n';
		const { metas } = await collect(source);
		const index = buildSourceIndex(metas, source);

		const heading = byType(metas, 'heading')[0];
		const para = byType(metas, 'paragraph')[0];
		expect(index.sliceOf(heading.id)).toBe('# Title');
		expect(index.sliceOf(para.id)).toBe('body text');
	});

	test('blockAtLine resolves to the most specific block containing a line', async () => {
		const source = '# H\n\nparagraph\n';
		const { metas } = await collect(source);
		const index = buildSourceIndex(metas, source);

		expect(index.blockAtLine(1)?.type).toBe('heading');
		expect(index.blockAtLine(3)?.type).toBe('paragraph');
	});
});
