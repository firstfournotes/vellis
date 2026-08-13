import { describe, expect, test } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { remarkVellisSourceMap } from './plugins/source-map';
import { rehypeVellisUriRewrite } from './plugins/rewrite-uri';
import { vellisSchema } from './sanitize-schema';

const baseUri = 'file:///home/user/notes/doc.md';

async function pipeline(source: string): Promise<string> {
	const file = await unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkVellisSourceMap)
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeRaw)
		.use(rehypeVellisUriRewrite, { baseUri })
		.use(rehypeSanitize, vellisSchema)
		.use(rehypeStringify)
		.process(source);
	return String(file);
}

describe('vellisSchema — Vellis data attributes survive sanitization', () => {
	test('data-vellis-node-id is preserved', async () => {
		const html = await pipeline('# title\n');
		expect(html).toMatch(/data-vellis-node-id="n_/);
	});

	test('data-source-start / -end / -start-line / -end-line are preserved', async () => {
		const html = await pipeline('# title\n');
		expect(html).toContain('data-source-start="');
		expect(html).toContain('data-source-end="');
		expect(html).toContain('data-source-start-line="');
		expect(html).toContain('data-source-end-line="');
	});

	test('data-vellis-node-type is preserved', async () => {
		const html = await pipeline('# title\n');
		expect(html).toContain('data-vellis-node-type="heading"');
	});

	test('data-vellis-link on internal anchor is preserved', async () => {
		const html = await pipeline('[link](./other.md)\n');
		expect(html).toContain('data-vellis-link');
		expect(html).toContain('href="file:///home/user/notes/other.md"');
	});
});

describe('vellisSchema — XSS vectors are blocked', () => {
	test('<script> tags are stripped', async () => {
		const html = await pipeline('<script>alert(1)</script>\nhello\n');
		expect(html).not.toContain('<script');
		expect(html).not.toContain('alert(1)');
		expect(html).toContain('hello');
	});

	test('javascript: href is rejected', async () => {
		const html = await pipeline('[click](javascript:alert(1))\n');
		expect(html).not.toContain('javascript:');
	});

	test('onerror attribute on <img> is stripped', async () => {
		const html = await pipeline('<img src="x" onerror="alert(1)">\n');
		expect(html).not.toContain('onerror');
		expect(html).not.toContain('alert(1)');
	});

	test('inline event handlers on raw HTML are stripped', async () => {
		const html = await pipeline('<a href="#x" onclick="alert(1)">x</a>\n');
		expect(html).not.toContain('onclick');
		expect(html).not.toContain('alert(1)');
	});
});

describe('vellisSchema — URI schemes', () => {
	test('vellis-asset:// img src passes through (set by uri-rewrite)', async () => {
		const html = await pipeline('![alt](./pic.png)\n');
		expect(html).toContain('src="vellis-asset://local/home/user/notes/pic.png"');
	});

	test('https external link passes through', async () => {
		const html = await pipeline('[ext](https://example.test/p)\n');
		expect(html).toContain('href="https://example.test/p"');
	});

	test('mailto link passes through', async () => {
		const html = await pipeline('[mail](mailto:foo@bar.test)\n');
		expect(html).toContain('href="mailto:foo@bar.test"');
	});

	test('ssh:// href passes through (relative resolved against ssh base would already be ssh)', async () => {
		// Build an absolute ssh href via raw HTML to bypass mdast's relative resolution.
		const html = await pipeline('<a href="ssh://alice@host/notes/x.md">x</a>\n');
		expect(html).toContain('href="ssh://alice@host/notes/x.md"');
	});
});

describe('vellisSchema — Shiki / code attributes', () => {
	test('className is allowed on <code>', async () => {
		// Hand-author HTML so we can assert the class survives sanitize even
		// though @shikijs/rehype is not in this pipeline.
		const html = await pipeline(
			'<pre><code class="language-ts">const x = 1;</code></pre>\n',
		);
		expect(html).toContain('class="language-ts"');
	});

	test('style attribute is allowed on <span> (Shiki inline style)', async () => {
		const html = await pipeline('<span style="color: #abc">x</span>\n');
		expect(html).toContain('style="color: #abc"');
	});
});

describe('vellisSchema — task list checkbox', () => {
	test('input type=checkbox is preserved (default schema covers it)', async () => {
		const html = await pipeline('- [ ] todo\n- [x] done\n');
		expect(html).toContain('type="checkbox"');
	});
});

describe('vellisSchema — mermaid placeholder div', () => {
	test('div.vellis-mermaid with data-mermaid-source survives sanitize', async () => {
		const html = await pipeline(
			'<div class="vellis-mermaid" data-mermaid-source="graph TD;A--&gt;B">\n<pre class="vellis-mermaid-fallback">graph TD;A--&gt;B</pre>\n</div>\n',
		);
		expect(html).toMatch(/<div[^>]*class="vellis-mermaid"/);
		expect(html).toMatch(/data-mermaid-source="graph TD;A/);
		expect(html).toMatch(/<pre[^>]*class="vellis-mermaid-fallback"/);
	});

	test('script inside a fake placeholder div is still stripped', async () => {
		const html = await pipeline(
			'<div class="vellis-mermaid" data-mermaid-source="x"><script>alert(1)</script></div>\n',
		);
		expect(html).not.toContain('<script');
		expect(html).not.toContain('alert(1)');
	});
});
