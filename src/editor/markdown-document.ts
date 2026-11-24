/**
 * Markdown の文書モデル(要件#74 契約2・6・14・15・第2段の作り(案)の項目 6)。純関数・DOM なし。
 *
 * 第1段の `text-document.ts` と同じ骨格: ProseMirror の `EditorState`(履歴を含む)・基準の版(`base`)と
 * そのハッシュ・dirty(書き出した文字列と基準の版の byte 比較=打って戻したら dirty でない)。原文の切片は
 * Node の属性に持たず、origin の表(bid → 切片)に持つ(仮の前提=判断 1)。
 */
import { EditorState, Plugin, type Transaction } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { history } from 'prosemirror-history';

import { contentHash, isDirty } from '$lib/document-edit';
import { freshBid, parseMarkdownDocument, type Generation, type OriginEntry } from './from-mdast';
import { markdownSchema } from './markdown-schema';
import {
	createOriginTable,
	detectMarkdownStyle,
	serializeMarkdown,
	shapeEqual,
	type OriginTable,
} from './to-markdown';

export interface MarkdownDocument {
	readonly uri: string;
	readonly readOnly: boolean;
	/** prosemirror-state(履歴の plugin を含む) */
	readonly state: EditorState;
	readonly base: string;
	/** contentHash(base) */
	readonly baseHash: string;
	/** bid → 切片 */
	readonly origin: OriginTable;
	/** 今の原文(読んだ文字列)の世代 */
	readonly generation: Generation;
}

/**
 * 系譜の番号を振る plugin。コマンドで作られた最上位のブロック(`setBlockType`・`wrapIn`・`wrapInList` は
 * 属性の既定=`bid: null` のノードを作る)と、段落を割って同じ `bid` が複製されたブロック(重なった全部)に、
 * その取引の続きで新しい `bid` を振る。振らないと保存の後の
 * 付け直し(`rekeyAfterSave`)で系譜が付かず、保存の直後から 3 段目になる(AC-74-47)。振る取引は履歴に積まない
 * (undo の段数を変えない・undo で消えない)。
 */
const bidPlugin = new Plugin({
	appendTransaction(transactions, _oldState, state) {
		if (!transactions.some((tr) => tr.docChanged)) return null;
		let tr: Transaction | null = null;
		// 段落を割ると属性ごと複製されて同じ bid が 2 つ以上になる。割ったのは構造を触ったこと(契約6 の 3 段目)
		// なので、重なった bid は全部を振り直す(前半だけに系譜を残すと、前半が 2 段目で書かれる)。
		const counts = new Map<number, number>();
		state.doc.forEach((child) => {
			const bid = child.attrs.bid as number | null | undefined;
			if (bid !== null && bid !== undefined) counts.set(bid, (counts.get(bid) ?? 0) + 1);
		});
		state.doc.forEach((child, offset) => {
			if (!('bid' in child.attrs)) return;
			const bid = child.attrs.bid as number | null;
			if (bid !== null && counts.get(bid) === 1) return;
			tr ??= state.tr;
			tr.setNodeMarkup(offset, undefined, { ...child.attrs, bid: freshBid() });
		});
		if (!tr) return null;
		return (tr as Transaction).setMeta('addToHistory', false);
	},
});

export function createMarkdownDocument(content: string, opts: { uri: string; readOnly: boolean }): MarkdownDocument {
	const { doc, generation, entries } = parseMarkdownDocument(content);
	const state = EditorState.create({ doc, schema: markdownSchema, plugins: [history(), bidPlugin] });
	return {
		uri: opts.uri,
		readOnly: opts.readOnly,
		state,
		base: content,
		baseHash: contentHash(content),
		origin: createOriginTable(entries, detectMarkdownStyle(content)),
		generation,
	};
}

/** 書き出し(契約6 の 3 段の規則)。 */
export function markdownText(doc: MarkdownDocument): string {
	return serializeMarkdown(doc.state.doc, doc.origin, doc.generation).text;
}

/** 取引を当てた後の文書(state だけ替える)。 */
export function withState(doc: MarkdownDocument, state: EditorState): MarkdownDocument {
	return { ...doc, state };
}

/** dirty = isDirty(markdownText(doc), doc.base)。 */
export function isMarkdownDirty(doc: MarkdownDocument): boolean {
	return isDirty(markdownText(doc), doc.base);
}

/**
 * 保存した文字列を読み直し、形が同じ最上位ブロックは Node をそのまま新しい世代の切片に付け直す
 * (履歴に積まない・state は替えない)。base・baseHash ← savedText。保存の後は全ブロックが「触っていない」
 * (1 段目)になり、続けて直すと 2 段目で差し替わる。形が合わないブロックには系譜を付けない(次の書き出しで
 * 3 段目になる)。
 */
export function rekeyAfterSave(doc: MarkdownDocument, savedText: string): MarkdownDocument {
	const parsed = parseMarkdownDocument(savedText);
	const current = doc.state.doc;
	const entries: OriginEntry[] = [];
	if (parsed.doc.childCount === current.childCount) {
		parsed.entries.forEach((entry, i) => {
			const node = current.child(i);
			if (node.attrs.bid === null || !shapeEqual(entry.node, node)) return;
			entries.push({ ...entry, node });
		});
	}
	return {
		...doc,
		base: savedText,
		baseHash: contentHash(savedText),
		origin: createOriginTable(entries, detectMarkdownStyle(savedText)),
		generation: parsed.generation,
	};
}

/**
 * 文書を `target`(原文の綴りの文字列)にする取引(外部変更の取り込み・マージの結果の当て方=契約12・13)。
 * `target` を読み直し、前後から形が同じ(`shapeEqual`)最上位ブロックは Node をそのまま残して新しい世代の切片に
 * 付け直し、間のブロックだけを読み直した Node で置き換える。取引は `addToHistory: false`(Command + Z で他人の
 * 書き換えは戻らない)。置き換えが要らなければ `tr` は null(origin と generation だけ新しくなる)。
 */
/** 原文(raw の読み直し・外部の変更)から作った取引の印。front matter の守り(front-matter-guard)はこの取引を見逃す。 */
export const FROM_SOURCE_META = 'vellisFromSource';

export function replaceChangedBlocks(
	state: EditorState,
	target: string,
	opts: { addToHistory?: boolean; keepOrigin?: OriginTable } = {},
): { tr: Transaction | null; origin: OriginTable; generation: Generation; entries: OriginEntry[] } {
	const parsed = parseMarkdownDocument(target);
	const oldDoc = state.doc;
	const newDoc = parsed.doc;
	const oldCount = oldDoc.childCount;
	const newCount = newDoc.childCount;
	let prefix = 0;
	while (prefix < oldCount && prefix < newCount && shapeEqual(oldDoc.child(prefix), newDoc.child(prefix))) prefix++;
	let suffix = 0;
	while (
		suffix < oldCount - prefix &&
		suffix < newCount - prefix &&
		shapeEqual(oldDoc.child(oldCount - 1 - suffix), newDoc.child(newCount - 1 - suffix))
	) {
		suffix++;
	}
	const entries: OriginEntry[] = parsed.entries.map((entry, i) => {
		if (i < prefix) return { ...entry, node: oldDoc.child(i) };
		if (i >= newCount - suffix) return { ...entry, node: oldDoc.child(oldCount - (newCount - i)) };
		return entry;
	});
	let tr: Transaction | null = null;
	if (prefix < oldCount - suffix || prefix < newCount - suffix) {
		let from = 0;
		for (let i = 0; i < prefix; i++) from += oldDoc.child(i).nodeSize;
		let to = oldDoc.content.size;
		for (let i = 0; i < suffix; i++) to -= oldDoc.child(oldCount - 1 - i).nodeSize;
		const nodes: PMNode[] = [];
		for (let i = prefix; i < newCount - suffix; i++) nodes.push(newDoc.child(i));
		tr = state.tr.replaceWith(from, to, nodes);
		// 原文(raw・外部の変更)から作った取引: front matter が変わっても消えても守り直さない(AC-74-6)
		tr.setMeta(FROM_SOURCE_META, true);
		if (!opts.addToHistory) tr.setMeta('addToHistory', false);
	}
	// keepOrigin: 置き換えたブロックの前の切片も残す(undo で前の Node に戻ったとき 1 段目で書けるように)
	const kept = opts.keepOrigin ? [...opts.keepOrigin.byBid.values()] : [];
	const origin = createOriginTable([...kept, ...entries], detectMarkdownStyle(target));
	return { tr, origin, generation: parsed.generation, entries };
}

/** 面の state に足す plugin を付けた state(履歴と系譜の番号の plugin は文書モデルが持つ)。 */
export function withFacePlugins(doc: MarkdownDocument, plugins: Plugin[]): MarkdownDocument {
	return { ...doc, state: doc.state.reconfigure({ plugins: [...doc.state.plugins, ...plugins] }) };
}
