/**
 * `rehype-vellis-code-attrs` — Shiki が作り直した `<pre>` に source-map の属性を
 * 引き継ぐ(要件#52 契約④)。
 *
 * Spec: `docs/requirements/req-52.md` 契約④。`remark-vellis-source-map` が
 * stamp する `data-vellis-node-id` / `data-source-*` / `data-vellis-node-type` は
 * mdast の `code` ノードに付くので、`mdast-util-to-hast` はそれを**内側の
 * `<code>`** に載せる(外側の `<pre>` は素のまま)。`@shikijs/rehype` は
 * ハイライトできた fence を `codeToHast` の結果で丸ごと差し替える
 * (`parent.children[index] = fragment`)ため、その `<pre>` も `<code>` も
 * **新しいノード**になり、属性は失われる ―― これが起案時の実測(backlog 171)で
 * 「Shiki 出力の `<pre>` に属性が付いていない」状態の正体。
 *
 * そこで Shiki の前後に挟んで、次の2段で引き継ぐ:
 *
 * 1. `hoist`(Shiki の**前**): `<code>` が持つ属性を外側の `<pre>` へ写し、
 *    あわせて**差し替え先の場所**(親ノードとその中の位置)を控える。
 * 2. `restore`(Shiki の**後**): 控えた場所を見て、そこに座っているノードへ
 *    属性を載せ直す。ハイライトされた fence はそこが `codeToHast` の返す
 *    `root` になっているので、その中の `<pre>` に載せる。ハイライトされ
 *    なかった fence(言語指定なし・未読み込み言語)は 1. の `<pre>` が
 *    そのまま残っているので、載せ直しても同じ値になる。
 *
 * 場所で対応づけるのは、Shiki が**同じ親の同じ位置**へ差し替えるから ――
 * 親ノードの同一性は差し替えを跨いで保たれるので、本文の中身(コード文字列や
 * 出現順)に頼らずに 1 対 1 で戻せる。生 HTML の `<pre>` や mermaid の
 * フォールバック `<pre>` が混ざっても、控えていない場所には何もしない。
 *
 * 引き継ぐのは `<pre>` だけでよい(Shiki の `<span>` には要らない=契約④)。
 * `rehype-sanitize` のスキーマ(`../sanitize-schema.ts`)は `*` の許可リストで
 * これらの属性を既に通している。
 */
import { visit } from 'unist-util-visit';
import type { Element, Properties, Root, RootContent } from 'hast';

/**
 * 引き継ぐ属性(camelCase / kebab-case の両綴り)。
 *
 * パイプラインでは 2 通りの綴りが現れる ―― `data.hProperties` 経由でそのまま
 * 渡ると kebab-case、`rehype-raw` が parse5 で読み直すと camelCase
 * (`../sanitize-schema.ts` の注記と同じ事情)。読むときは両方を見て、書くときは
 * camelCase に揃える(`hast-util-to-html` が `data-…` へ戻す)。
 */
const VELLIS_DATA_KEYS = [
	['dataVellisNodeId', 'data-vellis-node-id'],
	['dataSourceStart', 'data-source-start'],
	['dataSourceEnd', 'data-source-end'],
	['dataSourceStartLine', 'data-source-start-line'],
	['dataSourceEndLine', 'data-source-end-line'],
	['dataVellisNodeType', 'data-vellis-node-type'],
] as const;

/**
 * `<code>` の properties から引き継ぐ分を抜く。
 *
 * `data-vellis-node-id` を持ち `data-vellis-node-type` が `code` のものだけを
 * 採る ―― source-map が付けた code fence の印で、生 HTML の `<pre><code>` や
 * inline code は当たらない。
 */
function pickCodeFenceAttrs(props: Properties | undefined): Properties | null {
	if (!props) return null;
	const picked: Properties = {};
	for (const [camel, kebab] of VELLIS_DATA_KEYS) {
		const value = camel in props ? props[camel] : kebab in props ? props[kebab] : undefined;
		if (value === undefined || value === null) continue;
		picked[camel] = value;
	}
	if (picked.dataVellisNodeId === undefined) return null;
	if (picked.dataVellisNodeType !== 'code') return null;
	return picked;
}

/** Shiki が差し替えうる場所と、そこへ戻す属性。 */
interface FenceSlot {
	/** 差し替えの親。ノードの同一性は差し替えを跨いで保たれる。 */
	parent: { children: RootContent[] };
	/** 親の children の中の位置。Shiki は同じ位置へ書き戻す。 */
	index: number;
	props: Properties;
}

/** その位置に座っているノードから、属性を載せるべき `<pre>` を取り出す。 */
function preAt(node: RootContent | Root | undefined): Element | undefined {
	if (!node) return undefined;
	// Shiki は `codeToHast` の返す root をそのまま嵌める(入れ子の root)。
	if (node.type === 'root') {
		return node.children.find(
			(child): child is Element => child.type === 'element' && child.tagName === 'pre',
		);
	}
	if (node.type === 'element' && node.tagName === 'pre') return node;
	return undefined;
}

export interface VellisCodeAttrs {
	/** Shiki の**前**に挟む。`<code>` の属性を `<pre>` へ写し、場所を控える。 */
	hoist: () => (tree: Root) => void;
	/** Shiki の**後**に挟む。控えた場所の `<pre>` へ属性を載せ直す。 */
	restore: () => (tree: Root) => void;
}

/**
 * 1 回のレンダー用に、Shiki を挟む 2 つのプラグインを作る。
 *
 * 控えは `render()` の呼び出しごとに作り直す(= このクロージャ)ので、
 * 並行して走るレンダー同士が混ざらない。
 */
export function createVellisCodeAttrs(): VellisCodeAttrs {
	const slots: FenceSlot[] = [];

	const hoist = () => (tree: Root) => {
		slots.length = 0;
		visit(tree, 'element', (node, index, parent) => {
			if (node.tagName !== 'pre' || !parent || index === undefined || index === null) return;
			const code = node.children.find(
				(child): child is Element => child.type === 'element' && child.tagName === 'code',
			);
			if (!code) return;
			const props = pickCodeFenceAttrs(code.properties);
			if (!props) return;
			node.properties = { ...(node.properties ?? {}), ...props };
			slots.push({
				parent: parent as unknown as { children: RootContent[] },
				index,
				props,
			});
		});
	};

	const restore = () => () => {
		for (const slot of slots) {
			const pre = preAt(slot.parent.children[slot.index] as RootContent | Root | undefined);
			if (!pre) continue;
			pre.properties = { ...(pre.properties ?? {}), ...slot.props };
		}
		slots.length = 0;
	};

	return { hoist, restore };
}
