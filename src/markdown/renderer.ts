/**
 * Markdown render pipeline (unified / remark / rehype).
 *
 * Pipeline (`docs/archives/rendering-engine.md` §2.1 / §3.7,
 * Mermaid extension at `docs/mermaid.md` §3 / §5.2):
 *   remark-parse
 *     → remark-gfm
 *     → remark-vellis-alert       (GitHub `> [!NOTE]` blockquotes → alerts)
 *     → remark-vellis-source-map  (collects NodeMeta into `metas`)
 *     → remark-rehype { allowDangerousHtml: true }
 *     → rehype-raw                (re-parse inline HTML into hast)
 *     → rehype-vellis-mermaid     (pre>code[lang=mermaid] → placeholder div)
 *     → @shikijs/rehype           (syntax highlighting; preserves data-* attrs)
 *     → rehype-vellis-uri-rewrite (relative img/a → vellis-asset / data-vellis-link)
 *     → rehype-sanitize(vellisSchema)
 *     → rehype-stringify
 *
 * Each call returns the rendered HTML string and an immutable `SourceIndex`
 * keyed by the per-node `data-vellis-node-id` set by the source-map plugin.
 * The index is used by `selection.ts` (P0.8) to resolve DOM selections back
 * to Markdown source ranges.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeShiki from '@shikijs/rehype';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import type { BundledLanguage } from 'shiki';
import { remarkVellisAlert } from './plugins/alert';
import { remarkVellisSourceMap } from './plugins/source-map';
import { rehypeVellisMermaid } from './plugins/mermaid';
import { rehypeVellisUriRewrite } from './plugins/rewrite-uri';
import { vellisSchema } from './sanitize-schema';
import { buildSourceIndex } from './source-index';
import type { NodeMeta, SourceIndex } from './types';

const PRELOAD_LANGS: BundledLanguage[] = [
	'typescript',
	'javascript',
	'rust',
	'python',
	'bash',
	'json',
	'yaml',
	'html',
	'css',
	'markdown',
	'toml',
];

export interface RenderResult {
	html: string;
	index: SourceIndex;
}

export async function render(source: string, baseUri: string): Promise<RenderResult> {
	const metas: NodeMeta[] = [];

	const file = await unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkVellisAlert)
		.use(remarkVellisSourceMap, { onIndex: (m) => metas.push(m) })
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeRaw)
		.use(rehypeVellisMermaid)
		.use(rehypeShiki, {
			theme: 'github-light',
			langs: PRELOAD_LANGS,
		})
		.use(rehypeVellisUriRewrite, { baseUri })
		.use(rehypeSanitize, vellisSchema)
		.use(rehypeStringify)
		.process(source);

	return {
		html: String(file),
		index: buildSourceIndex(metas, source),
	};
}
