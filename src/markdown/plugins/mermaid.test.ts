/**
 * Unit tests for `rehype-vellis-mermaid` (`docs/mermaid.md` §9.1).
 *
 * Drives a minimal pipeline (without Shiki) to keep assertions focused on
 * the placeholder transform itself.  An additional integration assertion
 * lives in `renderer.test.ts` to verify the plugin's wiring inside the
 * full pipeline.
 */
import { describe, expect, test } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { remarkVellisSourceMap } from './source-map';
import { rehypeVellisMermaid } from './mermaid';
import { vellisSchema } from '../sanitize-schema';

async function pipeline(source: string): Promise<string> {
	const file = await unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkVellisSourceMap)
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeRaw)
		.use(rehypeVellisMermaid)
		.use(rehypeSanitize, vellisSchema)
		.use(rehypeStringify)
		.process(source);
	return String(file);
}

describe('rehype-vellis-mermaid — placeholder generation', () => {
	test('```mermaid block becomes a div.vellis-mermaid placeholder', async () => {
		const html = await pipeline('```mermaid\ngraph TD\n  A-->B\n```\n');
		expect(html).toMatch(/<div\b[^>]*class="vellis-mermaid"/);
		// Original code-fence DOM no longer present at the top level.
		expect(html).not.toMatch(/<code[^>]*class="language-mermaid"/);
	});

	test('placeholder carries data-mermaid-source with the raw fence body', async () => {
		const html = await pipeline('```mermaid\ngraph TD\n```\n');
		expect(html).toMatch(/data-mermaid-source="graph TD/);
	});

	test('placeholder wraps a fallback <pre> with the same source text', async () => {
		const html = await pipeline('```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n');
		expect(html).toMatch(/<pre[^>]*class="vellis-mermaid-fallback"[^>]*>[\s\S]*sequenceDiagram/);
	});
});

describe('rehype-vellis-mermaid — non-mermaid blocks unaffected', () => {
	test('plain ```ts``` block is left alone (Shiki-style class survives sanitize)', async () => {
		const html = await pipeline('```ts\nconst x = 1;\n```\n');
		// We never insert a Shiki step here, but the language-ts class on <code>
		// must survive without the mermaid plugin touching it.
		expect(html).toMatch(/<code[^>]*class="language-ts"/);
		expect(html).not.toMatch(/class="vellis-mermaid"/);
	});

	test('plain ``` (no lang) block is left alone', async () => {
		const html = await pipeline('```\nhello\n```\n');
		expect(html).toContain('<pre>');
		expect(html).toContain('hello');
		expect(html).not.toMatch(/class="vellis-mermaid"/);
	});

	test('inline `mermaid` code is left alone (only fenced blocks transform)', async () => {
		const html = await pipeline('Use `mermaid` for diagrams.\n');
		expect(html).toMatch(/<code[^>]*>mermaid<\/code>/);
		expect(html).not.toMatch(/class="vellis-mermaid"/);
	});
});

describe('rehype-vellis-mermaid — source-map continuity (Codex P2 regression)', () => {
	test('placeholder inherits data-vellis-* from the inner <code>, not the outer <pre>', async () => {
		// Because remarkVellisSourceMap writes data.hProperties on the mdast `code`
		// node, mdast-util-to-hast attaches them to the <code> element. The
		// wrapping <pre> has no Vellis attrs to inherit from. The plugin must
		// pull from <code>; otherwise selection / Mark anchors break.
		// (Avoid `<div[^>]*` regex shape — the data-mermaid-source value can
		// contain literal `>` which would terminate `[^>]*` early.)
		const html = await pipeline('```mermaid\ngraph TD\n```\n');
		const placeholderTag = html.match(/<div\s[^]*?>/);
		expect(placeholderTag).not.toBeNull();
		const tag = placeholderTag![0];
		expect(tag).toContain('class="vellis-mermaid"');
		expect(tag).toMatch(/data-vellis-node-id="n_/);
		expect(tag).toContain('data-source-start="');
		expect(tag).toContain('data-source-end="');
		expect(tag).toContain('data-source-start-line="');
		expect(tag).toContain('data-source-end-line="');
		expect(tag).toContain('data-vellis-node-type="code"');
	});
});

describe('rehype-vellis-mermaid — edge cases', () => {
	test('empty mermaid block emits placeholder with empty source', async () => {
		const html = await pipeline('```mermaid\n```\n');
		expect(html).toMatch(/<div[^>]*class="vellis-mermaid"/);
		expect(html).toMatch(/data-mermaid-source=""/);
	});

	test('uppercase `Mermaid` is not a mermaid block (lang is case-sensitive in GFM)', async () => {
		const html = await pipeline('```Mermaid\ngraph TD\n```\n');
		expect(html).not.toMatch(/class="vellis-mermaid"/);
		expect(html).toMatch(/<code[^>]*class="language-Mermaid"/);
	});

	test('multiple mermaid blocks each produce their own placeholder', async () => {
		const html = await pipeline(
			'```mermaid\ngraph A\n```\n\n```mermaid\ngraph B\n```\n',
		);
		const matches = html.match(/class="vellis-mermaid"/g) ?? [];
		expect(matches.length).toBe(2);
	});
});
