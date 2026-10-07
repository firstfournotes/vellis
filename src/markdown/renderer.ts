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
 *     → rehype-vellis-footnote-ids (drop remark-rehype's `user-content-` on footnote
 *                                  ids; sanitize re-adds it once — requirement #73)
 *     → rehype-raw                (re-parse inline HTML into hast)
 *     → rehype-vellis-mermaid     (pre>code[lang=mermaid] → placeholder div)
 *     → rehype-vellis-code-attrs  (hoist: <code>'s data-* onto the wrapping <pre>)
 *     → rehype-vellis-fence-langs (load the fences' languages from the code-file
 *                                  table on demand — requirement #69)
 *     → @shikijs/rehype           (syntax highlighting; rebuilds <pre>, dropping
 *                                  every attribute it carried)
 *     → rehype-vellis-code-attrs  (restore: re-attach the data-* onto Shiki's <pre>)
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
import { rehypeVellisFootnoteIds } from './plugins/footnote-ids';
import { rehypeVellisMermaid } from './plugins/mermaid';
import { createVellisCodeAttrs } from './plugins/code-attrs';
import { rehypeVellisFenceLangs } from './plugins/fence-langs';
import { rehypeVellisUriRewrite } from './plugins/rewrite-uri';
import { vellisSchema } from './sanitize-schema';
import { buildSourceIndex } from './source-index';
import type { NodeMeta, SourceIndex } from './types';

const SHIKI_THEME = 'github-light';

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
	// 要件#52 契約④: Shiki は fence の <pre> を作り直して属性を落とすので、
	// 前後で挟んで source-map の属性を引き継ぐ。控えはレンダーごとに作る。
	const codeAttrs = createVellisCodeAttrs();

	const file = await unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkVellisAlert)
		.use(remarkVellisSourceMap, { onIndex: (m) => metas.push(m) })
		.use(remarkRehype, { allowDangerousHtml: true })
		// 要件#73: rehype-raw より前(raw HTML の id には触れない)。
		.use(rehypeVellisFootnoteIds)
		.use(rehypeRaw)
		.use(rehypeVellisMermaid)
		.use(codeAttrs.hoist)
		// 要件#69 契約9: 表の言語のフェンスは、出てきたものだけをここで読み込む。
		.use(rehypeVellisFenceLangs, { theme: SHIKI_THEME })
		.use(rehypeShiki, {
			theme: SHIKI_THEME,
			langs: PRELOAD_LANGS,
		})
		.use(codeAttrs.restore)
		.use(rehypeVellisUriRewrite, { baseUri })
		.use(rehypeSanitize, vellisSchema)
		.use(rehypeStringify)
		.process(source);

	return {
		html: String(file),
		index: buildSourceIndex(metas, source),
	};
}
