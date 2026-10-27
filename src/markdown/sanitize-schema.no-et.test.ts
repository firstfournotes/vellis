/**
 * Issue #701 の受け入れテスト — `et:` スキームの痕跡を消す(要件なし・契約は Issue #701 と本ファイル)
 *
 * ## 契約
 * - `src/markdown/sanitize-schema.ts` の `hrefProtocols` から `'et'` を外す。`et://` のリンクの href は
 *   sanitize で落ちる(Markdown のリンク記法・raw HTML の両方)
 * - 不変: `ssh://`・`file://`・`vellis-asset://`・`https://`・`mailto:` の href は今のまま通る。
 *   `<img src>` の `vellis-asset://` も今のまま通る。依存の追加なし
 *
 * 確定した API: 既存の `vellisSchema`(`protocols.href` の配列)。追加の export なし。
 * パイプラインは sanitize-schema.test.ts と同じ(remark → rehype-raw → uri-rewrite → sanitize → stringify)。
 * uri-rewrite は `et://…` を外部とみなさず(`isExternal` は https / mailto / tel / data だけ)絶対 URL の
 * まま通すので、落とすのは sanitize の仕事= `hrefProtocols` の判定そのもの。
 *
 * ## 判定
 * - (a) Markdown のリンク記法 `[x](et://host/p.md)` → 出力に `href="et:` が無い(落ちるのは href で、文「x」は残る)
 * - (b) raw HTML `<a href="et://host/p.md">x</a>` → 同じ
 * - (c) `vellisSchema.protocols.href` に `'et'` が無い(契約の字義)。ssh / file / vellis-asset / http / https /
 *   mailto は残る
 * - (d) 不変: ssh / file / vellis-asset / https / mailto の href は通る・img の vellis-asset src は通る
 *
 * 実装前に赤: (a)(b)(c)= `'et'` が `hrefProtocols` に残っているので `href="et://host/p.md"` が通る。
 * (d) は実装前から緑(退行防止)。
 */
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

/** `et:` の href が出力に残っていないことの観測(大文字小文字と空白の揺れも拾う)。 */
function expectNoEtHref(html: string): void {
	expect(html).not.toMatch(/href\s*=\s*"\s*et:/i);
	expect(html).not.toContain('et://host/p.md');
}

// ---------------------------------------------------------------------------
// (a)(b) et:// のリンクの href は落ちる
// ---------------------------------------------------------------------------

describe('Issue #701 — et:// の href は sanitize で落ちる', () => {
	test('(a) Markdown のリンク記法 [x](et://host/p.md) → href="et:…" が無く、文「x」は残る', async () => {
		const html = await pipeline('[x](et://host/p.md)\n');
		expectNoEtHref(html);
		expect(html).toContain('x');
	});

	test('(b) raw HTML <a href="et://host/p.md">x</a> → 同じ', async () => {
		const html = await pipeline('<a href="et://host/p.md">x</a>\n');
		expectNoEtHref(html);
		expect(html).toContain('x');
	});

	test('(b\') 他のリンクと並んでいても et:// の href だけが落ちる', async () => {
		const html = await pipeline('[ok](https://example.test/p) and [gone](et://host/p.md)\n');
		expectNoEtHref(html);
		expect(html).toContain('href="https://example.test/p"');
		expect(html).toContain('gone');
	});
});

// ---------------------------------------------------------------------------
// (c) スキーマの字義
// ---------------------------------------------------------------------------

describe('Issue #701 — vellisSchema.protocols.href', () => {
	test("(c) 'et' を含まない", () => {
		expect(vellisSchema.protocols?.href ?? []).not.toContain('et');
	});

	test('(c) ssh / file / vellis-asset / http / https / mailto は残る', () => {
		expect(vellisSchema.protocols?.href ?? []).toEqual(
			expect.arrayContaining(['ssh', 'file', 'vellis-asset', 'http', 'https', 'mailto']),
		);
	});

	test('src の vellis-asset は今のまま', () => {
		expect(vellisSchema.protocols?.src ?? []).toContain('vellis-asset');
	});
});

// ---------------------------------------------------------------------------
// (d) 不変: 他のスキームは今のまま通る
// ---------------------------------------------------------------------------

describe('Issue #701 — 不変: 他のスキームの href は今のまま通る', () => {
	test.each([
		['ssh://(raw HTML)', '<a href="ssh://alice@host/notes/x.md">x</a>\n', 'href="ssh://alice@host/notes/x.md"'],
		['file://(相対リンクの解決結果)', '[y](./other.md)\n', 'href="file:///home/user/notes/other.md"'],
		['file://(raw HTML の絶対)', '<a href="file:///tmp/z.md">z</a>\n', 'href="file:///tmp/z.md"'],
		[
			'vellis-asset://(raw HTML)',
			'<a href="vellis-asset://local/home/user/notes/pic.png">p</a>\n',
			'href="vellis-asset://local/home/user/notes/pic.png"',
		],
		['https://', '[ext](https://example.test/p)\n', 'href="https://example.test/p"'],
		['mailto:', '[mail](mailto:foo@bar.test)\n', 'href="mailto:foo@bar.test"'],
	])('%s は通る', async (_label, source, expected) => {
		const html = await pipeline(source);
		expect(html).toContain(expected);
	});

	test('img の vellis-asset:// src は通る(uri-rewrite が付ける)', async () => {
		const html = await pipeline('![alt](./pic.png)\n');
		expect(html).toContain('src="vellis-asset://local/home/user/notes/pic.png"');
	});
});
