/**
 * Fixture-driven regression test against `fixtures/sample.md`.
 *
 * Spec: `tasks/todo.md` P0.14.  The original plan called for an A/B
 * comparison with the legacy markdown-it pipeline; that is no longer
 * possible after P0.6 removed the legacy code.  Instead we lock down the
 * unified pipeline output via:
 *
 * 1. Structural invariants over the rendered HTML and built `SourceIndex`
 *    (heading levels present, code blocks rendered, every NodeMeta's
 *    offset slice matches the source).
 * 2. A landmark JSON fixture (`fixtures/sample.lines.json`) that pins the
 *    line-number anchor for each top-level `##` heading.  Updating the
 *    sample is allowed; updating the fixture should be a deliberate diff.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { render } from './renderer';

const samplePath = resolve(__dirname, '../../fixtures/sample.md');
const fixturePath = resolve(__dirname, '../../fixtures/sample.lines.json');

const source = readFileSync(samplePath, 'utf8');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
	headings: Array<{
		text: string;
		startLine: number;
		endLine: number;
		depth: number;
	}>;
};

const baseUri = 'file:///fixtures/sample.md';

describe('fixtures/sample.md — unified pipeline regression', () => {
	test('renders without throwing and produces a non-empty SourceIndex', async () => {
		const { html, index } = await render(source, baseUri);
		expect(html.length).toBeGreaterThan(0);
		expect(index.byId.size).toBeGreaterThan(50);
	});

	test('every NodeMeta offset slices back to a substring of the source', async () => {
		const { index } = await render(source, baseUri);
		for (const meta of index.byId.values()) {
			const slice = index.sliceOf(meta.id);
			// `slice` may be empty for zero-length nodes (rare), but never undefined
			expect(typeof slice).toBe('string');
			// slice must equal source.slice for the same offsets
			expect(slice).toBe(
				source.slice(meta.position.startOffset, meta.position.endOffset),
			);
		}
	});

	test('all six heading levels are present in the output', async () => {
		const { html } = await render(source, baseUri);
		for (let i = 1; i <= 6; i++) {
			expect(html).toContain(`<h${i}`);
		}
	});

	test('code blocks render as <pre> blocks (Shiki or fallback)', async () => {
		const { html } = await render(source, baseUri);
		expect(html.match(/<pre[^>]*>/g)?.length ?? 0).toBeGreaterThan(0);
	});

	test('GFM table renders with thead/tbody/td', async () => {
		const { html } = await render(source, baseUri);
		expect(html).toContain('<table');
		expect(html).toContain('<thead');
		expect(html).toContain('<tbody');
		expect(html).toContain('<td');
	});

	test('fixture: each landmark heading appears at the recorded line', async () => {
		const { index } = await render(source, baseUri);
		const headings = [...index.byId.values()].filter((m) => m.type === 'heading');

		for (const expected of fixture.headings) {
			const match = headings.find(
				(h) => h.position.startLine === expected.startLine,
			);
			expect(match, `missing heading at line ${expected.startLine}`).toBeDefined();
			expect(match!.extra?.depth).toBe(expected.depth);
			// The recorded text must occur inside the source slice for that heading
			const text = source.slice(
				match!.position.startOffset,
				match!.position.endOffset,
			);
			expect(text).toContain(expected.text);
		}
	});

	test('Vellis data attributes survive sanitize for paragraphs', async () => {
		const { html } = await render(source, baseUri);
		const paraAttrs = html.match(/data-vellis-node-type="paragraph"/g) ?? [];
		expect(paraAttrs.length).toBeGreaterThan(5);
	});

	test('relative img links are rewritten to vellis-asset', async () => {
		const { html } = await render(source, baseUri);
		// sample.md references images/cat.png style paths
		if (/!\[[^\]]*\]\(\.\.?\//.test(source)) {
			expect(html).toMatch(/src="vellis-asset:/);
		}
	});
});
