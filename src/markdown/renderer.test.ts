/**
 * Renderer regression tests for the unified pipeline.
 *
 * Exercises `render(source, baseUri) -> { html, index }` end-to-end:
 * remark-parse → remark-gfm → remark-vellis-source-map → remark-rehype
 *   → rehype-raw → @shikijs/rehype → rehype-vellis-uri-rewrite
 *   → rehype-sanitize(vellisSchema) → rehype-stringify
 *
 * Spec: `docs/archives/rendering-engine.md` §2.1 / §3.7.
 */
import { describe, expect, test } from 'vitest';
import { render } from './renderer';

const baseUri = 'file:///home/user/notes/doc.md';

async function html(source: string, base = baseUri): Promise<string> {
	const result = await render(source, base);
	return result.html;
}

describe('render — return shape', () => {
	test('returns { html, index } where index is built from collected NodeMeta', async () => {
		const result = await render('# title\n\npara\n', baseUri);
		expect(typeof result.html).toBe('string');
		expect(result.index.byId.size).toBeGreaterThan(0);
		// Heading node id should slice back to the source
		const headingMeta = [...result.index.byId.values()].find((m) => m.type === 'heading');
		expect(headingMeta).toBeDefined();
		expect(result.index.sliceOf(headingMeta!.id)).toBe('# title');
	});
});

describe('renderer — headings', () => {
	test('renders all six levels', async () => {
		const out = await html('# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n');
		for (let i = 1; i <= 6; i++) {
			expect(out).toContain(`<h${i}`);
			expect(out).toContain(`</h${i}>`);
		}
	});
});

describe('renderer — inline marks', () => {
	test('strong + emphasis + code', async () => {
		const out = await html('**bold** *em* `code`\n');
		expect(out).toContain('<strong');
		expect(out).toContain('bold');
		expect(out).toContain('<em');
		expect(out).toContain('em');
		expect(out).toContain('<code');
		expect(out).toContain('code');
	});

	test('GFM strikethrough via built-in ~~', async () => {
		const out = await html('~~gone~~\n');
		expect(out).toMatch(/<(?:s|del)/);
		expect(out).toContain('gone');
	});
});

describe('renderer — GFM', () => {
	test('tables render with thead / tbody / th / td', async () => {
		const out = await html('| A | B |\n|---|---|\n| 1 | 2 |\n');
		expect(out).toContain('<table');
		expect(out).toContain('<thead');
		expect(out).toContain('A');
		expect(out).toContain('1');
	});

	test('task lists render checkbox inputs', async () => {
		const out = await html('- [x] done\n- [ ] todo\n');
		expect(out).toContain('type="checkbox"');
		expect(out).toMatch(/<input[^>]*\bchecked/);
	});
});

describe('renderer — code blocks', () => {
	test('plain fenced code survives sanitize', async () => {
		const out = await html('```\nhello\n```\n');
		expect(out).toContain('<pre');
		expect(out).toContain('hello');
		expect(out).toContain('</pre>');
	});

	test('typescript fenced code is rendered (Shiki may emit spans, fallback ok)', async () => {
		const out = await html('```typescript\nconst x: number = 1;\n```\n');
		expect(out).toContain('<pre');
		expect(out).toContain('const');
	});
});

describe('renderer — blockquote and rules', () => {
	test('blockquotes and horizontal rules are preserved', async () => {
		const out = await html('> quoted\n\n---\n\nparagraph\n');
		expect(out).toContain('<blockquote');
		expect(out).toContain('quoted');
		expect(out).toMatch(/<hr/);
	});
});

describe('renderer — lists', () => {
	test('ordered and unordered lists', async () => {
		const out = await html('- a\n- b\n\n1. one\n2. two\n');
		expect(out).toContain('<ul');
		expect(out).toContain('<ol');
		expect(out).toContain('a');
		expect(out).toContain('one');
	});
});

describe('renderer — relative URI rewriting', () => {
	test('relative image src is rewritten to vellis-asset://', async () => {
		const out = await html('![](./img/logo.png)\n');
		expect(out).toMatch(/src="vellis-asset:\/\/[^"]*logo\.png"/);
	});

	test('relative .md links get absolutised and tagged', async () => {
		const out = await html('[next](chapter2.md)\n');
		expect(out).toContain('data-vellis-link');
		expect(out).toMatch(/href="file:\/\/[^"]*chapter2\.md"/);
	});

	test('external http links are not tagged with data-vellis-link', async () => {
		const out = await html('[ext](https://example.com)\n');
		expect(out).toContain('href="https://example.com"');
		expect(out).not.toMatch(/href="https:\/\/example\.com"[^>]*data-vellis-link/);
	});

	test('mailto links are left untouched', async () => {
		const out = await html('[mail](mailto:a@example.com)\n');
		expect(out).toContain('href="mailto:a@example.com"');
		expect(out).not.toMatch(/href="mailto:[^"]*"[^>]*data-vellis-link/);
	});

	test('fragment-only links (#anchor) are preserved', async () => {
		const out = await html('[top](#top)\n');
		expect(out).toContain('href="#top"');
	});
});

describe('renderer — Vellis source attributes survive the full pipeline', () => {
	test('block elements carry data-vellis-node-id and data-source-* attributes', async () => {
		const out = await html('# Heading\n\nA paragraph.\n');
		expect(out).toContain('data-vellis-node-id="n_');
		expect(out).toContain('data-source-start="');
		expect(out).toContain('data-source-end="');
		expect(out).toContain('data-source-start-line="');
		expect(out).toContain('data-source-end-line="');
		expect(out).toContain('data-vellis-node-type="heading"');
		expect(out).toContain('data-vellis-node-type="paragraph"');
	});
});
