/**
 * `rehype-vellis-footnote-ids` — 脚注の id の二重前置を防ぐ(要件#73 契約 3・4)。
 *
 * remark-rehype(mdast-util-to-hast)は脚注の id と href の両方に既定の
 * clobberPrefix `user-content-` を付けて出す:
 *   参照 `<a href="#user-content-fn-1" id="user-content-fnref-1">`
 *   定義 `<li id="user-content-fn-1">`・戻りリンク `href="#user-content-fnref-1"`
 * その後の rehype-sanitize(`vellisSchema`)の clobber が **id にだけ**もう一度
 * `user-content-` を付けるため、id が `user-content-user-content-…` になって
 * href の行き先が宙に浮いていた(backlog 301)。
 *
 * そこで remark-rehype の直後(rehype-raw より前=raw HTML はまだ `raw` ノードの
 * まま)で、remark-rehype が付けた id の前置を一度外す。sanitize が付け直すので
 * 最終 HTML の id は `user-content-fn-1` の一重になり、href(`#user-content-fn-1`
 * の形のまま=要件#49 AC-49-30)と一致する。
 *
 * - sanitize の規則(`sanitize-schema.ts`)は変えない。raw HTML の id はこの段では
 *   まだ要素になっていないので触れず、従来どおり sanitize が `user-content-` を
 *   付ける(要件#61 契約 8 と同じ方針)。
 * - 対象は脚注の参照(`user-content-fnref-…`)と定義(`user-content-fn-…`)の id
 *   だけ。脚注欄見出しの `footnote-label` は前置なしで出るので対象外。将来 remark 側で
 *   id を出すプラグインを足しても巻き込まない。href は sanitize が前置しないので触らない。
 */
import { visit } from 'unist-util-visit';
import type { Root } from 'hast';

/** remark-rehype(mdast-util-to-hast)の既定の clobberPrefix。 */
const REMARK_REHYPE_CLOBBER_PREFIX = 'user-content-';

/** 脚注の定義(`fn-`)と参照(`fnref-`)の id。前置を外すのはこれだけ。 */
const FOOTNOTE_ID = /^user-content-fn(?:ref)?-/;

export function rehypeVellisFootnoteIds() {
	return (tree: Root) => {
		visit(tree, 'element', (node) => {
			const id = node.properties?.id;
			if (typeof id === 'string' && FOOTNOTE_ID.test(id)) {
				node.properties.id = id.slice(REMARK_REHYPE_CLOBBER_PREFIX.length);
			}
		});
	};
}
