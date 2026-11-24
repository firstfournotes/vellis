/**
 * Markdown として貼り付け(要件#74 第3段 3-5・契約17 の (t)・由谷の決定 3-17)。
 *
 * 貼り付けは文字のまま入れ、貼った文字を Markdown として読むと構造になるときだけ「Paste as Markdown」の札を出す。押すと貼った
 * 範囲を構造に読み直す(undo 1 段で文字の貼り付けに戻る)。読み方は編集面の読み込み(`from-mdast.ts`)と同じ remark の道。
 * 先頭の `---` は front matter にしない(文書の途中に入れるので)。脚注のラベルが文書に既にあれば、まだ使っていない最小の数字に振り直す。
 */
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { parseMarkdownDocument } from './from-mdast';
import { plainTextParagraphs } from './commands';

export const PASTE_AS_MARKDOWN_TESTID = 'paste-as-markdown';
export const PASTE_AS_MARKDOWN_LABEL = 'Paste as Markdown';

/** 系譜(bid)を外した写し(新しいノードは系譜なし=bidPlugin が振る)。 */
function withoutBid(node: PMNode): PMNode {
	if (node.isText) return node;
	const children: PMNode[] = [];
	node.forEach((c) => children.push(withoutBid(c)));
	const attrs = 'bid' in node.attrs ? { ...node.attrs, bid: null } : node.attrs;
	return node.type.create(attrs, Fragment.fromArray(children), node.marks);
}

function footnoteLabels(nodes: readonly PMNode[]): Set<string> {
	const out = new Set<string>();
	const visit = (n: PMNode) => {
		if (n.type.name === 'footnote_reference' || n.type.name === 'footnote_definition') out.add(String(n.attrs.label));
		n.forEach(visit);
	};
	nodes.forEach(visit);
	return out;
}

function relabel(node: PMNode, map: ReadonlyMap<string, string>): PMNode {
	if (node.isText) return node;
	const children: PMNode[] = [];
	node.forEach((c) => children.push(relabel(c, map)));
	const isFootnote = node.type.name === 'footnote_reference' || node.type.name === 'footnote_definition';
	const label = isFootnote ? map.get(String(node.attrs.label)) : undefined;
	const attrs = label !== undefined ? { ...node.attrs, label } : node.attrs;
	return node.type.create(attrs, Fragment.fromArray(children), node.marks);
}

/**
 * 文字を from-mdast と同じ remark の道で読んだ最上位ブロック(系譜なし)。front matter は作らない。doc があれば、
 * 脚注のラベルが doc に既にあるものは doc でまだ使っていない最小の数字に振り直す(参照と定義の両方)。
 */
export function parseMarkdownFragment(text: string, doc?: PMNode): PMNode[] {
	if (text.trim().length === 0) return [];
	// 先頭に空の行を置くと、先頭の `---` は front matter の印にならない(remark の読み方は変わらない)
	const parsed = parseMarkdownDocument(`\n${text}`).doc;
	let nodes: PMNode[] = [];
	parsed.forEach((n) => nodes.push(withoutBid(n)));
	if (doc) {
		const taken = footnoteLabels([doc]);
		const mine = footnoteLabels(nodes);
		const map = new Map<string, string>();
		let next = 1;
		for (const label of mine) {
			if (!taken.has(label)) continue;
			while (taken.has(String(next)) || mine.has(String(next)) || [...map.values()].includes(String(next))) next++;
			map.set(label, String(next));
			next++;
		}
		if (map.size > 0) nodes = nodes.map((n) => relabel(n, map));
	}
	return nodes;
}

/** 貼った文字を Markdown として読んだ結果が、文字として入れた結果(plainTextParagraphs)と違うか=札を出すか。 */
export function shouldOfferMarkdownPaste(text: string): boolean {
	if (text.trim().length === 0) return false;
	const parsed = Fragment.fromArray(parseMarkdownFragment(text));
	const literal = Fragment.fromArray(plainTextParagraphs(text.replace(/^(\r\n|\r|\n)+|(\r\n|\r|\n)+$/g, '')));
	return !parsed.eq(literal);
}
