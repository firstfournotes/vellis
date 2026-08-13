import { describe, expect, test } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import type { Element, Root } from 'hast';
import { rehypeVellisUriRewrite } from './rewrite-uri';

const baseUri = 'file:///home/user/notes/doc.md';

async function render(source: string, base = baseUri): Promise<string> {
	const file = await unified()
		.use(remarkParse)
		.use(remarkRehype)
		.use(rehypeVellisUriRewrite, { baseUri: base })
		.use(rehypeStringify)
		.process(source);
	return String(file);
}

describe('rehypeVellisUriRewrite — img', () => {
	test('rewrites a relative img src to vellis-asset://local', async () => {
		const html = await render('![alt](./images/cat.png)\n');
		expect(html).toContain('src="vellis-asset://local/home/user/notes/images/cat.png"');
		expect(html).toContain('alt="alt"');
	});

	test('leaves http(s) img src untouched', async () => {
		const html = await render('![alt](https://example.test/cat.png)\n');
		expect(html).toContain('src="https://example.test/cat.png"');
	});

	test('leaves data: img src untouched', async () => {
		const html = await render('![tiny](data:image/png;base64,AAAA)\n');
		expect(html).toContain('src="data:image/png;base64,AAAA"');
	});

	test('does not double-rewrite a vellis-asset: src (direct hast)', () => {
		// Markdown source cannot author vellis-asset:// via [link](url), so
		// drive the plugin directly on a hand-built hast tree.
		const img: Element = {
			type: 'element',
			tagName: 'img',
			properties: { src: 'vellis-asset://local/already/absolute.png' },
			children: [],
		};
		const tree: Root = { type: 'root', children: [img] };
		rehypeVellisUriRewrite({ baseUri })(tree);
		expect(img.properties?.src).toBe('vellis-asset://local/already/absolute.png');
	});

	test('rewrites against ssh:// base URI', async () => {
		const html = await render(
			'![alt](./pic.jpg)\n',
			'ssh://alice@host:22/notes/doc.md',
		);
		expect(html).toContain('src="vellis-asset://ssh/alice@host:22/notes/pic.jpg"');
	});
});

describe('rehypeVellisUriRewrite — a', () => {
	test('rewrites a relative href to absolute and tags with data-vellis-link', async () => {
		const html = await render('[link](./other.md)\n');
		expect(html).toContain('href="file:///home/user/notes/other.md"');
		expect(html).toContain('data-vellis-link=""');
	});

	test('leaves http(s) anchors untouched and untagged', async () => {
		const html = await render('[ext](https://example.test/page)\n');
		expect(html).toContain('href="https://example.test/page"');
		expect(html).not.toContain('data-vellis-link');
	});

	test('leaves mailto: anchors untouched and untagged', async () => {
		const html = await render('[mail](mailto:foo@bar.test)\n');
		expect(html).toContain('href="mailto:foo@bar.test"');
		expect(html).not.toContain('data-vellis-link');
	});

	test('leaves fragment-only anchors untouched and untagged', async () => {
		const html = await render('[top](#section)\n');
		expect(html).toContain('href="#section"');
		expect(html).not.toContain('data-vellis-link');
	});

	test('rewrites a parent-relative href against ssh:// base', async () => {
		const html = await render(
			'[up](../sibling.md)\n',
			'ssh://alice@host/notes/sub/doc.md',
		);
		expect(html).toContain('href="ssh://alice@host/notes/sibling.md"');
		expect(html).toContain('data-vellis-link=""');
	});
});
