/**
 * `rehype-vellis-fence-langs` — フェンスに出てきた表の言語を `@shikijs/rehype` の
 * 前に読み込む(要件#69 契約9・判断 (o))。
 *
 * `@shikijs/rehype` はハイライタに読み込み済みの言語(と Shiki の別名)にしか
 * 色を付けない。表(`$lib/code-language`)の全言語を最初に読むと Markdown の
 * 最初の表示が遅くなる(80ms → 320ms=実測)ので、`pre > code.language-x` の x が
 * 表の言語(id か Shiki の別名)のものだけを、同じ `getSingletonHighlighter`
 * (窓に1つ)へその場で読み込む。表に無い言語には何もしない(今のまま色なし)。
 * 読み込みに失敗しても描画は止めない(そのフェンスが色なしになるだけ)。
 */
import { visit } from 'unist-util-visit';
import type { Root } from 'hast';
import { bundledLanguagesInfo, getSingletonHighlighter } from 'shiki';
import { CODE_LANGUAGES } from '../../lib/code-language';

/** フェンスの言語名(id・別名)→ 読み込む言語 id。表の言語だけを載せる。 */
const FENCE_LANGUAGES = new Map<string, string>(
	CODE_LANGUAGES.flatMap((id) => {
		const info = bundledLanguagesInfo.find((l) => l.id === id || l.aliases?.includes(id));
		const names = info ? [info.id, ...(info.aliases ?? [])] : [];
		return [id, ...names].map((name) => [name, id] as const);
	}),
);

const LANGUAGE_PREFIX = 'language-';

export function rehypeVellisFenceLangs(options: { theme: string }) {
	return async (tree: Root) => {
		const langs = new Set<string>();
		visit(tree, 'element', (node) => {
			if (node.tagName !== 'pre') return;
			const code = node.children[0];
			if (!code || code.type !== 'element' || code.tagName !== 'code') return;
			// `@shikijs/rehype` の PreHandler と同じく、最初の `language-` の class を見る。
			const classes = code.properties.className;
			const cls = Array.isArray(classes)
				? classes.find((c) => typeof c === 'string' && c.startsWith(LANGUAGE_PREFIX))
				: undefined;
			if (typeof cls !== 'string') return;
			const id = FENCE_LANGUAGES.get(cls.slice(LANGUAGE_PREFIX.length));
			if (id) langs.add(id);
		});
		if (langs.size === 0) return;
		try {
			await getSingletonHighlighter({ themes: [options.theme], langs: [...langs] });
		} catch {
			// 読み込めなかった言語のフェンスは色なしのまま(`@shikijs/rehype` が飛ばす)。
		}
	};
}
