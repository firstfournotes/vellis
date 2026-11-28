/**
 * Markdown の書き出し(要件#74 契約6 の 3 段の規則・契約15・第2段の作り(案)の項目 5)。純関数・DOM なし。
 *
 * 1. **触っていない最上位ブロック**(origin の表の Node と同一)は原文の切片を byte のまま返す。ブロックの間は、
 *    前後が同じ世代で隣り合っていれば原文の間(空行も)
 * 2. **文字だけを触ったブロック**(構造の指紋と run の数が読んだときと同じ)は、値の変わった run の原文の範囲だけを
 *    差し替える。タスクの印が変わったら印の 1 文字だけ
 * 3. **構造を触ったブロック**は `mdast-util-to-markdown` で書き直す。綴りは文書の流儀(`detectMarkdownStyle`)
 *
 * どの段でも、書いたブロックを**前後のブロックと一緒に読み直して**同じ形か(`shapeEqual`)を確かめる。2 段目で
 * 落ちたら打った範囲だけをエスケープして 2 段目で再試行し(仮の前提=判断 2)、それでも落ちたら 3 段目。3 段目で
 * 落ちたら綴りを替えて試し、全部落ちたら流儀の綴りで書いて `warn` を立てる。
 */
import { toMarkdown, defaultHandlers, type Handle, type Options, type State, type Info } from 'mdast-util-to-markdown';
import type * as M from 'mdast';
import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import { Mark, type Node as PMNode } from 'prosemirror-model';

import { markdownProcessor, parseMarkdownDocument, type Generation, type OriginEntry, type Run } from './from-mdast';

// ---------------------------------------------------------------------------
// 綴りの流儀(契約6 の 3 段目)
// ---------------------------------------------------------------------------

export interface MarkdownStyle {
	bullet: '-' | '*' | '+';
	emphasis: '*' | '_';
	strong: '*' | '_';
	fence: '`' | '~';
	rule: '-' | '*' | '_';
	bulletOrdered: '.' | ')';
	listItemIndent: 'one' | 'tab' | 'mixed';
	/** 表の列をそろえて書くか(文書の表がそろっていれば true) */
	tableAlign: boolean;
}

/** 例の無い文書の綴り。 */
export const FIXED_STYLE: MarkdownStyle = {
	bullet: '-',
	emphasis: '*',
	strong: '*',
	fence: '`',
	rule: '-',
	bulletOrdered: '.',
	listItemIndent: 'one',
	tableAlign: true,
};

/** 東アジアの全角は幅 2(表の列をそろえる幅)。 */
export function displayWidth(s: string): number {
	let w = 0;
	for (const ch of s) {
		w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u.test(ch)
			? 2
			: 1;
	}
	return w;
}

/** 一番多いもの。一番が並んだら(か 1 つも無ければ)`fallback`。 */
function vote<T>(counts: Map<T, number>, fallback: T): T {
	let best = fallback;
	let n = 0;
	let tie = false;
	for (const [k, v] of counts) {
		if (v > n) {
			best = k;
			n = v;
			tie = false;
		} else if (v === n) tie = true;
	}
	return n === 0 || tie ? fallback : best;
}

/**
 * 文書で使われている記号を数えて多いほう(例が無い・数が同じなら固定の綴り)。`parsed` は `src` の全体を読んだ mdast
 * (`parseMarkdownDocument(src).tree`)。渡せば読み直さない(数える種類のノードは alert の変換で変わらない)。
 */
export function detectMarkdownStyle(src: string, parsed?: M.Root | null): MarkdownStyle {
	const tree = parsed ?? (markdownProcessor.parse(src) as M.Root);
	const bullet = new Map<MarkdownStyle['bullet'], number>();
	const em = new Map<MarkdownStyle['emphasis'], number>();
	const strong = new Map<MarkdownStyle['strong'], number>();
	const fence = new Map<MarkdownStyle['fence'], number>();
	const rule = new Map<MarkdownStyle['rule'], number>();
	const ordered = new Map<MarkdownStyle['bulletOrdered'], number>();
	const indent = new Map<MarkdownStyle['listItemIndent'], number>();
	const align = new Map<boolean, number>();
	const inc = <T>(m: Map<T, number>, k: T) => m.set(k, (m.get(k) ?? 0) + 1);
	const walk = (n: M.Nodes) => {
		const s = n.position?.start.offset;
		if (s !== undefined) {
			const ch = src[s];
			if (n.type === 'listItem') {
				const m = /^([-*+]|\d+[.)])([ \t]+)/.exec(src.slice(s, s + 16));
				if (m) {
					if (/[-*+]/.test(m[1]!)) inc(bullet, m[1] as MarkdownStyle['bullet']);
					else inc(ordered, m[1]!.slice(-1) as MarkdownStyle['bulletOrdered']);
					inc(indent, m[2] === ' ' ? 'one' : 'tab');
				}
			} else if (n.type === 'emphasis' && (ch === '*' || ch === '_')) inc(em, ch);
			else if (n.type === 'strong' && (ch === '*' || ch === '_')) inc(strong, ch);
			else if (n.type === 'code' && (ch === '`' || ch === '~')) inc(fence, ch);
			else if (n.type === 'thematicBreak' && (ch === '-' || ch === '*' || ch === '_')) inc(rule, ch);
			else if (n.type === 'table' && n.position?.end.offset !== undefined) {
				// 行の表示幅がそろっていれば「列をそろえる」流儀
				const lines = src.slice(s, n.position.end.offset).split(/\r\n|\r|\n/);
				inc(align, lines.every((l) => displayWidth(l) === displayWidth(lines[0]!)));
			}
		}
		if ('children' in n) for (const c of n.children as M.Nodes[]) walk(c);
	};
	walk(tree);
	return {
		bullet: vote(bullet, FIXED_STYLE.bullet),
		emphasis: vote(em, FIXED_STYLE.emphasis),
		strong: vote(strong, FIXED_STYLE.strong),
		fence: vote(fence, FIXED_STYLE.fence),
		rule: vote(rule, FIXED_STYLE.rule),
		bulletOrdered: vote(ordered, FIXED_STYLE.bulletOrdered),
		listItemIndent: vote(indent, FIXED_STYLE.listItemIndent),
		tableAlign: vote(align, FIXED_STYLE.tableAlign),
	};
}

// ---------------------------------------------------------------------------
// PM → mdast(3 段目の書き出しに使う)
// ---------------------------------------------------------------------------

const MARK_ORDER = ['link', 'strong', 'em', 'strike', 'code'];

function wrapMark(m: Mark, children: M.PhrasingContent[]): M.PhrasingContent {
	switch (m.type.name) {
		case 'strong':
			return { type: 'strong', children };
		case 'em':
			return { type: 'emphasis', children };
		case 'strike':
			return { type: 'delete', children };
		case 'link':
			if (m.attrs.kind === 'reference') {
				return {
					type: 'linkReference',
					identifier: m.attrs.identifier as string,
					label: m.attrs.label as string | null,
					referenceType: m.attrs.referenceType as M.ReferenceType,
					children,
				} as M.PhrasingContent;
			}
			return {
				type: 'link',
				url: m.attrs.href as string,
				title: m.attrs.title as string | null,
				children,
				data: { vellisKind: m.attrs.kind },
			} as M.PhrasingContent;
		default:
			return children[0] ?? { type: 'text', value: '' };
	}
}

function leafToMdast(n: PMNode): M.PhrasingContent {
	switch (n.type.name) {
		case 'text':
			if (n.marks.some((m) => m.type.name === 'code')) return { type: 'inlineCode', value: n.text! };
			return { type: 'text', value: n.text! };
		case 'soft_break':
			return { type: 'text', value: '\n' };
		case 'hard_break':
			return { type: 'break', data: { vellisRaw: n.attrs.raw } } as M.PhrasingContent;
		case 'image':
			if (n.attrs.ref) {
				return {
					type: 'imageReference',
					identifier: n.attrs.ref as string,
					label: n.attrs.ref as string,
					referenceType: n.attrs.refType as M.ReferenceType,
					alt: n.attrs.alt as string,
				};
			}
			return { type: 'image', url: n.attrs.src as string, alt: n.attrs.alt as string, title: n.attrs.title as string | null };
		case 'footnote_reference':
			return { type: 'footnoteReference', identifier: String(n.attrs.label).toLowerCase(), label: n.attrs.label as string };
		case 'html_inline':
			return { type: 'html', value: n.attrs.raw as string };
		default:
			return { type: 'text', value: '' };
	}
}

function sortedMarks(n: PMNode): Mark[] {
	return n.marks
		.filter((m) => m.type.name !== 'code')
		.slice()
		.sort((a, b) => MARK_ORDER.indexOf(a.type.name) - MARK_ORDER.indexOf(b.type.name));
}

/**
 * インラインの並び → phrasing。mark の入れ子は、その位置から長く続く mark を外側に置く(固定の順だと
 * `~~a b c~~` の一部に太字を付けたとき取り消し線が割れて読み直しが崩れる=周回0 で実測)。長さが同じなら
 * MARK_ORDER の順。
 */
function inlineToMdast(nodes: PMNode[], applied: readonly Mark[] = []): M.PhrasingContent[] {
	const out: M.PhrasingContent[] = [];
	const open = (n: PMNode) => sortedMarks(n).filter((m) => !applied.some((a) => a.eq(m)));
	let i = 0;
	while (i < nodes.length) {
		const marks = open(nodes[i]!);
		if (marks.length === 0) {
			out.push(leafToMdast(nodes[i]!));
			i++;
			continue;
		}
		let best = marks[0]!;
		let bestEnd = i;
		for (const m of marks) {
			let j = i;
			while (j < nodes.length && open(nodes[j]!).some((x) => x.eq(m))) j++;
			if (j > bestEnd) {
				best = m;
				bestEnd = j;
			}
		}
		out.push(wrapMark(best, inlineToMdast(nodes.slice(i, bestEnd), [...applied, best])));
		i = bestEnd;
	}
	// 隣り合う text をつなぐ
	const merged: M.PhrasingContent[] = [];
	for (const c of out) {
		const last = merged[merged.length - 1];
		if (last && last.type === 'text' && c.type === 'text') last.value += c.value;
		else merged.push(c);
	}
	return merged;
}

function inlineOf(n: PMNode): M.PhrasingContent[] {
	const kids: PMNode[] = [];
	const all: PMNode[] = [];
	n.forEach((c) => all.push(c));
	// 締め 5 周目 P2-b: textblock の末尾の hard_break は書かない(`\` も空行も出さない)。続く hard_break と、
	// その前の soft_break(末尾の改行の連なり)も一緒に落とす。読み直すと末尾の改行は残らないので同じ形
	if (all[all.length - 1]?.type.name === 'hard_break') {
		while (all.length > 0 && ['hard_break', 'soft_break'].includes(all[all.length - 1]!.type.name)) all.pop();
	}
	all.forEach((c, index) => {
		// hard break の直後の soft break は書かない(hard break がもう行を終えている。重ねると空行になり段落が割れる)
		const prev = kids[kids.length - 1];
		if (c.type.name === 'soft_break' && prev?.type.name === 'hard_break') return;
		// 行頭に来る hard break(段落の先頭・hard break / soft break の直後)は空白 2 つでは書けない(空白だけの行=空行になる)
		// ので、バックスラッシュ+改行で書く
		// 空白の直後の hard break(段落の末尾でないもの)も、空白 2 つで書くと前の空白ごと行末の空白として落ちるので、
		// バックスラッシュで書く(`para \` + 改行=[`para `, HB, …])
		const afterSpace = prev?.isText === true && /[ \t]$/.test(prev.text ?? '') && index < all.length - 1;
		if (c.type.name === 'hard_break' && (!prev || afterSpace || prev.type.name === 'hard_break' || prev.type.name === 'soft_break')) {
			kids.push(c.type.create({ ...c.attrs, raw: '\\\n' }, null, c.marks));
			return;
		}
		kids.push(c);
	});
	return inlineToMdast(kids);
}

function blocksOf(n: PMNode): M.BlockContent[] {
	const out: M.BlockContent[] = [];
	n.forEach((c) => out.push(blockToMdast(c) as M.BlockContent));
	return out;
}

/** 最上位ブロック(とその中)を mdast にする。綴りの属性は handler が読む `data` に載せる。 */
export function blockToMdast(n: PMNode): M.RootContent {
	switch (n.type.name) {
		case 'paragraph':
			return { type: 'paragraph', children: inlineOf(n) };
		case 'heading':
			return { type: 'heading', depth: n.attrs.level as M.Heading['depth'], children: inlineOf(n) };
		case 'blockquote':
			return { type: 'blockquote', children: blocksOf(n) };
		case 'alert':
			return { type: 'vellisAlert', kind: n.attrs.kind, children: blocksOf(n) } as unknown as M.RootContent;
		case 'bullet_list':
		case 'ordered_list': {
			const ordered = n.type.name === 'ordered_list';
			const items: M.ListItem[] = [];
			// 第4段 4-4(4-12): 順序つきは読んだときの番号のまま書く。番号の無い項目(足した項目)と、前の項目と同じ番号を
			// 写し持つ項目(項目を割った後ろ)は前の番号+1。後ろの項目は振り直さない
			let prevNumber: number | null = null;
			let printed = ((n.attrs.start as number | null) ?? 1) - 1;
			n.forEach((li) => {
				const item: M.ListItem = { type: 'listItem', checked: li.attrs.checked as boolean | null, spread: li.attrs.spread as boolean, children: blocksOf(li) };
				if (ordered) {
					const own = li.attrs.number as number | null;
					printed = own !== null && own !== prevNumber ? own : printed + 1;
					prevNumber = own;
					item.data = { vellisNumber: printed } as M.ListItem['data'];
				}
				items.push(item);
			});
			return {
				type: 'list',
				ordered,
				start: ordered ? (n.attrs.start as number) : null,
				spread: n.attrs.spread as boolean,
				children: items,
			};
		}
		case 'code_block':
			return { type: 'code', lang: n.attrs.lang as string | null, meta: n.attrs.meta as string | null, value: n.textContent };
		case 'horizontal_rule':
			return { type: 'thematicBreak' };
		case 'front_matter':
		case 'html_block':
		case 'definition':
			return { type: 'vellisRaw', value: n.attrs.raw } as unknown as M.RootContent;
		case 'footnote_definition':
			return {
				type: 'footnoteDefinition',
				identifier: String(n.attrs.label).toLowerCase(),
				label: n.attrs.label as string,
				children: blocksOf(n),
			};
		case 'table': {
			const rows: M.TableRow[] = [];
			const align: M.AlignType[] = [];
			n.forEach((row, _o, r) => {
				const cells: M.TableCell[] = [];
				row.forEach((cell) => {
					if (r === 0) align.push(cell.attrs.align as M.AlignType);
					cells.push({ type: 'tableCell', children: inlineOf(cell) });
				});
				rows.push({ type: 'tableRow', children: cells });
			});
			return { type: 'table', align, children: rows };
		}
		default:
			return { type: 'paragraph', children: [] };
	}
}

type Extensions = NonNullable<Options['extensions']>;

/** GFM の書き出し(`mdast-util-gfm` を直接の依存にせず、remark-gfm が足すものを取る)。 */
function gfmExtensions(align: boolean): Extensions {
	const data = unified().use(remarkGfm, { tablePipeAlign: align, stringLength: displayWidth }).freeze().data() as {
		toMarkdownExtensions?: Extensions;
	};
	return data.toMarkdownExtensions ?? [];
}
const GFM_ALIGNED = gfmExtensions(true);
const GFM_COMPACT = gfmExtensions(false);

/** 拡張の中から表の handler を探す。 */
function findTableHandler(ext: unknown): Handle | null {
	if (!ext) return null;
	if (Array.isArray(ext)) {
		for (const e of ext) {
			const found = findTableHandler(e);
			if (found) return found;
		}
		return null;
	}
	const obj = ext as { handlers?: { table?: Handle }; extensions?: unknown };
	if (obj.handlers?.table) return obj.handlers.table;
	return findTableHandler(obj.extensions);
}
const gfmTableAligned = findTableHandler(GFM_ALIGNED);
const gfmTableCompact = findTableHandler(GFM_COMPACT);

/** 拡張の中から項目の handler(GFM のタスクの印を書くもの)を探す。 */
function findListItemHandler(ext: unknown): Handle | null {
	if (!ext) return null;
	if (Array.isArray(ext)) {
		for (const e of ext) {
			const found = findListItemHandler(e);
			if (found) return found;
		}
		return null;
	}
	const obj = ext as { handlers?: { listItem?: Handle }; extensions?: unknown };
	if (obj.handlers?.listItem) return obj.handlers.listItem;
	return findListItemHandler(obj.extensions);
}
/** 項目の書き方(GFM のタスクの印つき。無ければ既定)。 */
const gfmListItem = (findListItemHandler(GFM_ALIGNED) ?? defaultHandlers.listItem) as unknown as Handle;

const defaultLink = defaultHandlers.link as unknown as Handle;

type AnyHandle = (node: never, parent: M.Parents | undefined, state: State, info: Info) => string;
const asHandle = (h: AnyHandle) => h as unknown as Handle;

const handlers = {
	vellisRaw: asHandle((node: { value: string }) => node.value),
	vellisAlert: asHandle((node: { kind: string; children: M.BlockContent[] }, _parent, state, info) => {
		const exit = state.enter('blockquote');
		const tracker = state.createTracker(info);
		tracker.move('> ');
		tracker.shift(2);
		const body = state.containerFlow({ type: 'blockquote', children: node.children }, tracker.current());
		exit();
		const head = `> [!${node.kind.toUpperCase()}]`;
		if (!body) return head;
		return `${head}\n${body
			.split('\n')
			.map((l) => (l === '' ? '>' : `> ${l}`))
			.join('\n')}`;
	}),
	link: asHandle((node: M.Link, parent, state, info) => {
		// GFM の素の URL は素のまま書く(文言が URL のときだけ)
		const kind = (node.data as { vellisKind?: string } | undefined)?.vellisKind;
		const only = node.children.length === 1 && node.children[0]!.type === 'text' ? (node.children[0] as M.Text).value : null;
		if (kind === 'literal' && only !== null && (node.url === only || node.url === `http://${only}` || node.url === `mailto:${only}`)) {
			return only;
		}
		return (defaultLink as unknown as AnyHandle)(node as never, parent, state, info);
	}),
	// 第4段 4-4: 順序つきの項目は番号を項目ごとに(vellisNumber)。既定の書き方は「start + 何番目」で振り直してしまう
	listItem: asHandle((node: M.ListItem, parent, state, info) => {
		const number = (node.data as { vellisNumber?: number } | undefined)?.vellisNumber;
		const list = parent as M.List | undefined;
		if (number === undefined || !list || list.type !== 'list' || !list.ordered) {
			return (gfmListItem as unknown as AnyHandle)(node as never, parent, state, info);
		}
		// 既定の書き方に「この項目だけのリスト(start=番号)」を見せる。番号が 1 以下なら既定は 1 にするので、そのまま 1 を書く
		const solo = { ...list, start: number, children: [node] } as M.List;
		const text = (gfmListItem as unknown as AnyHandle)(node as never, solo as never, state, info);
		return number < 1 ? text.replace(/^1(?=[.)])/, String(number)) : text;
	}),
	break: asHandle((node: M.Break) => {
		const raw = (node.data as { vellisRaw?: string } | undefined)?.vellisRaw ?? '';
		return raw.startsWith('\\') ? '\\\n' : '  \n';
	}),
	// 行ごとのセルの数がそろっていない表は、GFM の書き出しが列を足してそろえてしまい、読み直すと見出しの
	// 列が増える(AI の表に多い=周回0 のコーパスで 44 件)。行ごとの数を保って書く
	table: asHandle((node: M.Table, parent, state, info) => {
		const aligned = (state as unknown as { options: { tablePipeAlign?: boolean } }).options.tablePipeAlign !== false;
		const gfm = aligned ? gfmTableAligned : gfmTableCompact;
		const width = node.children[0]?.children.length ?? 0;
		const ragged = node.children.some((r) => r.children.length !== width);
		if (!ragged && gfm) return (gfm as unknown as AnyHandle)(node as never, parent, state, info);
		const exit = state.enter('table');
		const cellText = (cell: M.TableCell) => {
			const ex = state.enter('tableCell');
			const s = state.containerPhrasing(cell, { before: '|', after: '|', now: { line: 1, column: 1 }, lineShift: 0 });
			ex();
			return s.replace(/(?<!\\)\|/g, '\\|');
		};
		const lines: string[] = [];
		node.children.forEach((row, r) => {
			const ex = state.enter('tableRow');
			lines.push(`| ${row.children.map(cellText).join(' | ')} |`);
			ex();
			if (r === 0) {
				const align = node.align ?? [];
				lines.push(
					`| ${row.children
						.map((_c, i) => (align[i] === 'left' ? ':-' : align[i] === 'right' ? '-:' : align[i] === 'center' ? ':-:' : '-'))
						.join(' | ')} |`,
				);
			}
		});
		exit();
		return lines.join('\n');
	}),
} as unknown as Options['handlers'];

/** 3 段目: ブロックを流儀の綴りで書き直す(改行は `eol`)。 */
export function writeBlock(n: PMNode, style: MarkdownStyle, eol: string): string {
	const text = toMarkdown({ type: 'root', children: [blockToMdast(n)] }, {
		extensions: style.tableAlign ? GFM_ALIGNED : GFM_COMPACT,
		handlers,
		bullet: style.bullet,
		bulletOther: style.bullet === '-' ? '*' : style.bullet === '*' ? '-' : '*',
		emphasis: style.emphasis,
		strong: style.strong,
		fence: style.fence,
		rule: style.rule,
		bulletOrdered: style.bulletOrdered,
		listItemIndent: style.listItemIndent,
		setext: n.type.name === 'heading' && n.attrs.setext === true,
		incrementListMarker: true,
		tablePipeAlign: style.tableAlign,
	} as Options).replace(/\n+$/, '');
	return text.replace(/\r\n|\r|\n/g, eol);
}

/** 表の区切りの行(`| --- | :-: |`)のセルの寄せ。 */
function delimiterAligns(line: string): Array<'left' | 'right' | 'center' | null> | null {
	const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
	const cells = body.split('|').map((c) => c.trim());
	if (cells.length === 0 || !cells.every((c) => /^:?-+:?$/.test(c))) return null;
	return cells.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.startsWith(':') ? 'left' : c.endsWith(':') ? 'right' : null));
}

/**
 * 3 段目で書き直した表の区切りの行を、列の数と寄せが同じなら原文の綴りのまま置く(`|---|---|` を `| - | - |` に
 * 書き換えない=周回0 の 10)。
 */
function keepDelimiterRow(text: string, node: PMNode, entry: OriginEntry | null, eol: string): string {
	if (node.type.name !== 'table' || !entry) return text;
	const original = entry.src.slice(entry.start, entry.end).split(/\r\n|\r|\n/)[1];
	if (original === undefined) return text;
	const lines = text.split(eol);
	if (lines.length < 2) return text;
	const was = delimiterAligns(original);
	const now = delimiterAligns(lines[1]!);
	if (!was || !now || was.length !== now.length || was.some((a, i) => a !== now[i])) return text;
	lines[1] = original;
	return lines.join(eol);
}

/** 3 段目の書き出し(書き直したブロック+原文の綴りを残せるところは残す)。 */
function writeStage3(node: PMNode, entry: OriginEntry | null, style: MarkdownStyle, eol: string): string {
	return keepDelimiterRow(writeBlock(node, style, eol), node, entry, eol);
}

// ---------------------------------------------------------------------------
// 形の比較(位置・綴りの属性を除く)
// ---------------------------------------------------------------------------

/** 綴りだけの属性(形の比較で見ない)。 */
const SPELLING_ATTRS = new Set(['bid', 'raw', 'setext', 'number']);
/** raw が中身そのもの(改行の綴りを除いて比べる)のノード。 */
const RAW_CONTENT = new Set(['front_matter', 'html_block', 'html_inline', 'definition']);

/** mark の集合の比較(リンクの綴り=kind は見ない)。 */
function marksEqual(a: readonly Mark[], b: readonly Mark[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const ma = a[i]!;
		const mb = b[i]!;
		if (ma.type !== mb.type) return false;
		for (const k of Object.keys(ma.attrs)) {
			if (ma.type.name === 'link' && k === 'kind') continue;
			if (ma.attrs[k] !== mb.attrs[k]) return false;
		}
	}
	return true;
}

/** 形の比較(bid・raw(綴り)・setext・リンクの kind を見ない。front_matter / html_block / html_inline / definition の raw は改行の綴りを除いて比べる)。 */
export function shapeEqual(a: PMNode, b: PMNode): boolean {
	if (a.type !== b.type) return false;
	if (a.isText) return a.text === b.text && marksEqual(a.marks, b.marks);
	if (!marksEqual(a.marks, b.marks)) return false;
	for (const k of Object.keys(a.attrs)) {
		if (k === 'bid') continue;
		const va = a.attrs[k];
		const vb = b.attrs[k];
		if (SPELLING_ATTRS.has(k) && !RAW_CONTENT.has(a.type.name)) continue;
		if (k === 'raw' && typeof va === 'string' && typeof vb === 'string') {
			if (va.replace(/\r\n|\r/g, '\n') !== vb.replace(/\r\n|\r/g, '\n')) return false;
			continue;
		}
		if (va !== vb) return false;
	}
	if (a.childCount !== b.childCount) return false;
	for (let i = 0; i < a.childCount; i++) if (!shapeEqual(a.child(i), b.child(i))) return false;
	return true;
}

// ---------------------------------------------------------------------------
// 文字の連なり(2 段目)
// ---------------------------------------------------------------------------

interface DocRun {
	text: string;
	marks: readonly Mark[];
}

function attrsWithoutBid(n: PMNode): Record<string, unknown> {
	// bid と、タスクの印(checked=2 段目で印の 1 文字を差し替える)の値は構造の指紋に入れない
	const { bid: _bid, ...rest } = n.attrs as Record<string, unknown>;
	if (n.type.name === 'list_item') rest.checked = rest.checked === null ? 'none' : 'task';
	return rest;
}

/** ブロックの中の text の連なりと、構造の指紋(textblock の種類と属性・mark の並び・葉の種類と属性)。 */
export function runsOf(block: PMNode): { runs: DocRun[]; skeleton: string } {
	const runs: DocRun[] = [];
	const sk: string[] = [];
	const visit = (n: PMNode) => {
		if (n.isTextblock) {
			sk.push(`<${n.type.name}${JSON.stringify(attrsWithoutBid(n))}>`);
			let cur: DocRun | null = null;
			n.forEach((c) => {
				if (c.isText) {
					if (cur && Mark.sameSet(cur.marks, c.marks)) cur.text += c.text!;
					else {
						cur = { text: c.text!, marks: c.marks };
						runs.push(cur);
						sk.push(`T${c.marks.map((m) => m.type.name + JSON.stringify(m.attrs)).join(',')}`);
					}
				} else {
					cur = null;
					sk.push(`L${c.type.name}${JSON.stringify(c.attrs)}${c.marks.map((m) => m.type.name).join(',')}`);
				}
			});
			sk.push('>');
			return;
		}
		sk.push(`[${n.type.name}${JSON.stringify(attrsWithoutBid(n))}`);
		n.forEach((c) => visit(c));
		sk.push(']');
	};
	visit(block);
	return { runs, skeleton: sk.join('') };
}

// ---------------------------------------------------------------------------
// origin の表
// ---------------------------------------------------------------------------

export interface OriginTable {
	byBid: Map<number, OriginEntry>;
	/** 読んだときの形の指紋(bid → skeleton) */
	skeletons: Map<number, string>;
	style: MarkdownStyle;
}

export function createOriginTable(entries: OriginEntry[], style?: MarkdownStyle): OriginTable {
	const byBid = new Map<number, OriginEntry>();
	const skeletons = new Map<number, string>();
	for (const e of entries) {
		const bid = e.node.attrs.bid as number;
		byBid.set(bid, e);
		skeletons.set(bid, runsOf(e.node).skeleton);
	}
	return { byBid, skeletons, style: style ?? detectMarkdownStyle(entries[0]?.src ?? '') };
}

// ---------------------------------------------------------------------------
// 書き出し
// ---------------------------------------------------------------------------

export type Stage = 1 | 2 | 3;

export interface Segment {
	stage: Stage;
	/** 書き出しの中での範囲 */
	start: number;
	end: number;
	/** 2 段目から 3 段目へ落ちた */
	fellBack?: boolean;
	/** 2 段目で、打った範囲をエスケープして通した */
	escaped?: boolean;
	/** 3 段目の検算に落ちた(どの綴りでも読み直しが同じ形にならなかった) */
	warn?: boolean;
}

export interface SerializeResult {
	text: string;
	segments: Segment[];
}

/** 読み直すブロックが参照している参照定義と脚注の定義(読み直しの後ろに足す)。 */
type SuffixFor = (nodes: PMNode[]) => { text: string; blocks: number };

/**
 * 参照している定義だけを足す(全部を足すと定義の多い文書で検算が 2 乗になる=周回0 で 1 本に 6 分)。
 * 定義は文書全体(リスト項目の中にも書ける)から集める。
 */
function contextSuffix(doc: PMNode, eol: string): SuffixFor {
	const defs = new Map<string, string>();
	const notes = new Set<string>();
	doc.descendants((c) => {
		if (c.type.name === 'definition') defs.set(String(c.attrs.identifier).toLowerCase(), c.attrs.raw as string);
		else if (c.type.name === 'footnote_definition') notes.add(String(c.attrs.label));
		return true;
	});
	return (nodes) => {
		const parts = new Set<string>();
		for (const n of nodes) {
			n.descendants((d) => {
				for (const m of d.marks) {
					if (m.type.name === 'link' && m.attrs.kind === 'reference') {
						const r = defs.get(String(m.attrs.identifier).toLowerCase());
						if (r) parts.add(r);
					}
				}
				if (d.type.name === 'image' && d.attrs.ref) {
					const r = defs.get(String(d.attrs.ref).toLowerCase());
					if (r) parts.add(r);
				}
				if (d.type.name === 'footnote_reference' && notes.has(String(d.attrs.label))) parts.add(`[^${d.attrs.label}]: x`);
				return true;
			});
		}
		const list = [...parts];
		return { text: list.length ? eol + eol + list.join(eol + eol) + eol : '', blocks: list.length };
	};
}

/** 差し替える文字を、段落の中の文字として mdast-util-to-markdown でエスケープする(2 段目の再試行)。 */
function escapeInline(text: string): string {
	// 前後の空白はそのまま置く(段落の先頭の空白として `&#x20;` に化けさせない。差し替えは run の中ほどに入る)
	const lead = /^[ \t]*/.exec(text)![0];
	const trail = /[ \t]*$/.exec(text.slice(lead.length))![0];
	const core = text.slice(lead.length, text.length - trail.length);
	if (core === '') return text;
	return lead + toMarkdown({ type: 'paragraph', children: [{ type: 'text', value: core }] }).replace(/\n+$/, '') + trail;
}

function tasksOf(block: PMNode): boolean[] {
	const out: boolean[] = [];
	block.descendants((n) => {
		if (n.type.name === 'list_item' && n.attrs.checked !== null) out.push(n.attrs.checked as boolean);
		return true;
	});
	return out;
}

/** 2 段目の書き出し(条件を満たさなければ null)。`escape` なら打った範囲だけをエスケープする。 */
function stage2(block: PMNode, entry: OriginEntry, origin: OriginTable, escape: boolean): { text: string; escaped: boolean } | null {
	const bid = block.attrs.bid as number;
	const { runs, skeleton } = runsOf(block);
	if (skeleton !== origin.skeletons.get(bid)) return null;
	if (runs.length !== entry.runs.length) return null;
	const isCodeBlock = block.type.name === 'code_block';
	const edits: { start: number; end: number; text: string }[] = [];
	let escaped = false;
	for (let i = 0; i < runs.length; i++) {
		const now = runs[i]!.text;
		const was: Run = entry.runs[i]!;
		if (now === was.value) continue;
		if (!was.eligible) return null;
		const isCode = isCodeBlock || was.eol !== undefined;
		if (!isCode && /[\r\n]/.test(now)) return null;
		let text = was.eol && was.eol !== '\n' ? now.replace(/\n/g, was.eol) : now;
		const inlineCode = runs[i]!.marks.some((m) => m.type.name === 'code');
		if (escape && !isCode && !inlineCode) {
			// 打った範囲(前後の共通部分を除いた真ん中)だけをエスケープする
			let p = 0;
			while (p < now.length && p < was.value.length && now[p] === was.value[p]) p++;
			let s = 0;
			while (s < now.length - p && s < was.value.length - p && now[now.length - 1 - s] === was.value[was.value.length - 1 - s]) s++;
			const typed = now.slice(p, now.length - s);
			let mid = escapeInline(typed);
			// 表のセルの | は列の区切りになる(core の mdast-util-to-markdown は逃がさない)
			if (block.type.name === 'table') mid = mid.replace(/(?<!\\)\|/g, '\\|');
			if (mid !== typed) escaped = true;
			text = now.slice(0, p) + mid + now.slice(now.length - s);
		}
		edits.push({ start: was.start, end: was.end, text });
	}
	// タスクの印(`[ ]` ⇄ `[x]`)は印の 1 文字だけ
	const checks = tasksOf(block);
	const tasks = entry.tasks ?? [];
	if (checks.length !== tasks.length) return null;
	for (let i = 0; i < checks.length; i++) {
		const was = tasks[i]!.value !== ' ';
		if (checks[i] === was) continue;
		if (tasks[i]!.start < 0) return null;
		edits.push({ start: tasks[i]!.start, end: tasks[i]!.start + 1, text: checks[i] ? 'x' : ' ' });
	}
	edits.sort((a, b) => a.start - b.start);
	const pieces: string[] = [];
	let cursor = entry.start;
	for (const e of edits) {
		pieces.push(entry.src.slice(cursor, e.start), e.text);
		cursor = e.end;
	}
	pieces.push(entry.src.slice(cursor, entry.end));
	return { text: pieces.join(''), escaped };
}

// ---------------------------------------------------------------------------
// リストの項目単位の書き直し(第4段 4-4・契約19・(C) 5)
// ---------------------------------------------------------------------------

/**
 * 項目単位で書き直すときの道具。spans は読んだときの Node → 原文の範囲(触っていない部分木は同じ Node のまま)。
 */
interface ItemContext {
	src: string;
	spans: Map<PMNode, [number, number]>;
	style: MarkdownStyle;
	eol: string;
}

/** 位置 at の行の先頭。 */
function lineStartOf(src: string, at: number): number {
	let i = at;
	while (i > 0 && src[i - 1] !== '\n' && src[i - 1] !== '\r') i--;
	return i;
}

/** 位置 at の桁までの字下げ(行の先頭からの文字を空白に。タブはそのまま)。 */
function indentAt(src: string, at: number): string {
	return src.slice(lineStartOf(src, at), at).replace(/[^\t]/g, ' ');
}

/** 2 行目からの行頭に indent を足す(空の行には足さない)。 */
function indentRest(text: string, indent: string, eol: string): string {
	if (!indent) return text;
	return text
		.split(eol)
		.map((line, i) => (i === 0 || line === '' ? line : indent + line))
		.join(eol);
}

/** 項目の印の綴り(原文の、印の先頭から最初の中身の前まで=`- ` `1. ` `- [ ] ` など)。 */
function itemPrefix(item: PMNode, ctx: ItemContext): string | null {
	const at = ctx.spans.get(item);
	const first = item.firstChild ? ctx.spans.get(item.firstChild) : undefined;
	if (!at || !first) return null;
	const prefix = ctx.src.slice(at[0], first[0]);
	return /[\r\n]/.test(prefix) ? null : prefix;
}

/** 印の綴りを、今の項目に合わせる(タスクの印・順序つきの番号)。 */
function adjustPrefix(prefix: string, item: PMNode, number: number | null): string {
	let out = prefix;
	if (number !== null) out = out.replace(/^\d{1,9}(?=[.)])/, String(number));
	const box = /^(\S+[ \t]+)\[[ xX]\]([ \t]*)/.exec(out);
	const checked = item.attrs.checked as boolean | null;
	if (box) {
		if (checked === null) out = box[1]! + out.slice(box[0].length);
		else out = `${box[1]}[${checked ? 'x' : ' '}]${box[2]}` + out.slice(box[0].length);
	} else if (checked !== null) {
		const m = /^(\S+[ \t]+)/.exec(out);
		if (m) out = `${m[1]}[${checked ? 'x' : ' '}] ` + out.slice(m[0].length);
	}
	return out;
}

/** 箇条書き・順序つきの、印の番号(順序つきでなければ null)。 */
function prefixNumber(prefix: string): number | null {
	const m = /^(\d{1,9})[.)]/.exec(prefix);
	return m ? Number(m[1]) : null;
}

/**
 * 今の子の並びを、読んだときの子の並びに対応させる。同じ Node(触っていない)はそのまま、間に挟まれた触った子は
 * 同じ間の原文の子と順に対にする(余った今の子=足した子は null・余った原文の子=消した子)。
 */
function alignChildren(cur: readonly PMNode[], orig: readonly PMNode[]): Array<PMNode | null> {
	const out: Array<PMNode | null> = cur.map(() => null);
	const origIndex = new Map<PMNode, number>();
	orig.forEach((n, i) => origIndex.set(n, i));
	const anchors: Array<[number, number]> = [];
	let lastOrig = -1;
	cur.forEach((n, ci) => {
		const oi = origIndex.get(n);
		if (oi !== undefined && oi > lastOrig) {
			out[ci] = n;
			anchors.push([ci, oi]);
			lastOrig = oi;
		}
	});
	let pc = -1;
	let po = -1;
	for (const [ci, oi] of [...anchors, [cur.length, orig.length] as [number, number]]) {
		const gap = Math.min(ci - pc - 1, oi - po - 1);
		for (let k = 0; k < gap; k++) out[pc + 1 + k] = orig[po + 1 + k]!;
		pc = ci;
		po = oi;
	}
	return out;
}

const childrenOf = (n: PMNode | null): PMNode[] => {
	const out: PMNode[] = [];
	n?.forEach((c) => out.push(c));
	return out;
};

const isList = (n: PMNode) => n.type.name === 'bullet_list' || n.type.name === 'ordered_list';

/**
 * 子の並び(項目の中身=ブロック)を書く。触っていない子は原文のまま、触った子だけを書き直す(入れ子のリストは項目単位)。
 * 子の間は、対になった原文の子どうしが原文で隣り合っていればその間の原文、そうでなければ空行と字下げ。
 */
function writeChildren(parent: PMNode, origParent: PMNode | null, ctx: ItemContext, contentIndent: string): string | null {
	const cur = childrenOf(parent);
	const orig = childrenOf(origParent);
	const pairs = alignChildren(cur, orig);
	const origIndex = new Map<PMNode, number>();
	orig.forEach((n, i) => origIndex.set(n, i));
	const sample = sampleSeparator(orig, ctx);
	const parts: string[] = [];
	let prevSpan: [number, number] | null = null;
	let prevOi = -2;
	for (let i = 0; i < cur.length; i++) {
		const child = cur[i]!;
		const counterpart = pairs[i]!;
		const span = counterpart ? ctx.spans.get(counterpart) ?? null : null;
		const oi = counterpart ? origIndex.get(counterpart) ?? -2 : -2;
		if (i > 0) {
			// 原文から間を切り出すのは、原文で隣り合っていた 2 つのときだけ(間の子を消したときに、その原文を拾わない)
			if (prevSpan && span && oi === prevOi + 1 && span[0] >= prevSpan[1]) parts.push(ctx.src.slice(prevSpan[1], span[0]));
			else parts.push(sample ?? ctx.eol + ctx.eol + contentIndent);
		}
		let text: string | null;
		if (counterpart === child && span) text = ctx.src.slice(span[0], span[1]);
		else if (isList(child) && counterpart && counterpart.type === child.type) text = writeListItems(child, counterpart, ctx, span ? indentAt(ctx.src, span[0]) : contentIndent);
		else text = reindentLike(writeBlock(child, ctx.style, ctx.eol), child, span, ctx, contentIndent);
		if (text === null) return null;
		parts.push(text);
		prevSpan = span;
		prevOi = oi;
	}
	return parts.join('');
}

/**
 * 書き直したブロックの 2 行目からの字下げ。段落・見出しで、原文と行の数が同じなら、各行は原文のその行の字下げのまま
 * (継続行が最初の行より深い項目=`- two` / `    more two` を、印の幅に揃えない)。それ以外は中身の字下げ。
 */
function reindentLike(text: string, child: PMNode, span: [number, number] | null, ctx: ItemContext, contentIndent: string): string {
	if (span && child.isTextblock && !child.type.spec.code) {
		const origLines = ctx.src.slice(span[0], span[1]).split(/\r\n|\r|\n/);
		const lines = text.split(ctx.eol);
		if (origLines.length === lines.length) {
			return lines.map((line, i) => (i === 0 || line === '' ? line : /^[ \t]*/.exec(origLines[i]!)![0] + line)).join(ctx.eol);
		}
	}
	return indentRest(text, contentIndent, ctx.eol);
}

/** 原文で隣り合う 2 つの子の間(改行と空行と字下げだけ)の見本。無ければ null。 */
function sampleSeparator(orig: readonly PMNode[], ctx: ItemContext): string | null {
	for (let i = 1; i < orig.length; i++) {
		const a = ctx.spans.get(orig[i - 1]!);
		const b = ctx.spans.get(orig[i]!);
		if (!a || !b) continue;
		const between = ctx.src.slice(a[1], b[0]);
		if (/^[ \t]*(\r\n|\r|\n)\s*$/.test(between)) return between;
	}
	return null;
}

/**
 * リストを項目単位で書く。触っていない項目は原文の切片のまま、触った項目は自分の(原文の)印の綴りと字下げで中身を
 * 書き直し、足した項目は前の項目の印の綴り(順序つきは前の番号+1。後ろは振り直さない=4-12)。消した項目は書かない。
 * 項目の間は、対になった原文の項目どうしが原文で隣り合っていればその間の原文、そうでなければ原文の項目の間の見本。
 */
function writeListItems(list: PMNode, origList: PMNode, ctx: ItemContext, indent: string): string | null {
	const cur = childrenOf(list);
	const orig = childrenOf(origList);
	const pairs = alignChildren(cur, orig);
	const origIndex = new Map<PMNode, number>();
	orig.forEach((n, i) => origIndex.set(n, i));
	// 原文の項目の間の見本(隣り合う 2 つの間=改行と空行と字下げだけ)
	const sampleSep = sampleSeparator(orig, ctx);
	const parts: string[] = [];
	let prevSpan: [number, number] | null = null;
	let prevOi = -2;
	let prevPrefix: string | null = null;
	let prevNumber: number | null = null;
	for (let i = 0; i < cur.length; i++) {
		const item = cur[i]!;
		const counterpart = pairs[i]!;
		const span = counterpart ? ctx.spans.get(counterpart) ?? null : null;
		const oi = counterpart ? origIndex.get(counterpart) ?? -2 : -2;
		if (i > 0) {
			// 原文から間を切り出すのは、原文で隣り合っていた 2 つのときだけ(間の項目を消したときに、その原文を拾わない)
			if (prevSpan && span && oi === prevOi + 1 && span[0] >= prevSpan[1]) parts.push(ctx.src.slice(prevSpan[1], span[0]));
			else parts.push(sampleSep ?? ctx.eol + (list.attrs.spread ? ctx.eol : '') + indent);
		}
		if (counterpart === item && span) {
			parts.push(ctx.src.slice(span[0], span[1]));
			prevPrefix = itemPrefix(item, ctx) ?? prevPrefix;
			prevNumber = prevPrefix ? prefixNumber(prevPrefix) : prevNumber;
			prevSpan = span;
			prevOi = oi;
			continue;
		}
		// 触った項目(原文の項目と対)はその印の綴り、足した項目は前の項目の印の綴り
		const own = counterpart ? itemPrefix(counterpart, ctx) : null;
		const base = own ?? prevPrefix;
		if (base === null) return null;
		let number: number | null = null;
		if (list.type.name === 'ordered_list') {
			const mine = own ? prefixNumber(own) : null;
			number = mine ?? (prevNumber !== null ? prevNumber + 1 : ((list.attrs.start as number | null) ?? 1));
		}
		const prefix = adjustPrefix(base, item, number);
		// 中身の字下げ: 原文の項目なら最初の子の桁、足した項目なら印の幅
		const firstSpan = counterpart?.firstChild ? ctx.spans.get(counterpart.firstChild) : undefined;
		const contentIndent = firstSpan && own === prefix ? indentAt(ctx.src, firstSpan[0]) : indent + ' '.repeat(prefix.length);
		const body = writeChildren(item, counterpart, ctx, contentIndent);
		if (body === null) return null;
		parts.push(prefix + body);
		prevPrefix = prefix;
		prevNumber = number;
		prevSpan = span;
		prevOi = oi;
	}
	return parts.join('');
}

/** トップのリストを項目単位で書く(書けなければ null)。 */
function writeListByItems(node: PMNode, entry: OriginEntry | null, style: MarkdownStyle, eol: string): string | null {
	if (!entry?.spans || entry.spans.size === 0) return null;
	if (!isList(node) || node.type !== entry.node.type) return null;
	return writeListItems(node, entry.node, { src: entry.src, spans: entry.spans, style, eol }, '');
}

/** 3 段目の綴りの替え(検算に落ちたら順に試す)。 */
function styleVariants(style: MarkdownStyle): MarkdownStyle[] {
	const out: MarkdownStyle[] = [style];
	for (const b of (['-', '*', '+'] as const).filter((x) => x !== style.bullet)) out.push({ ...style, bullet: b });
	const altEm = style.emphasis === '*' ? '_' : '*';
	const altStrong = style.strong === '*' ? '_' : '*';
	out.push({ ...style, emphasis: altEm });
	out.push({ ...style, strong: altStrong });
	out.push({ ...style, emphasis: altEm, strong: altStrong });
	out.push({ ...style, bulletOrdered: style.bulletOrdered === '.' ? ')' : '.' });
	return out;
}

interface Planned {
	node: PMNode;
	entry: OriginEntry | null;
	stage: Stage;
	text: string;
	sepBefore: string;
	fellBack: boolean;
	escaped: boolean;
	warn: boolean;
}

/** 前後のブロックと一緒に読み直して、どれも形が同じか(リストがつながる・setext になる・遅延の継続行を見つける)。 */
function checkWithNeighbors(plan: Planned[], i: number, text: string, suffixFor: SuffixFor): boolean {
	const parts: string[] = [];
	const nodes: PMNode[] = [];
	if (i > 0) {
		parts.push(plan[i - 1]!.text, plan[i]!.sepBefore);
		nodes.push(plan[i - 1]!.node);
	}
	parts.push(text);
	nodes.push(plan[i]!.node);
	if (i + 1 < plan.length) {
		parts.push(plan[i + 1]!.sepBefore, plan[i + 1]!.text);
		nodes.push(plan[i + 1]!.node);
	}
	const suffix = suffixFor(nodes);
	const back = parseMarkdownDocument(parts.join('') + suffix.text).doc;
	if (back.childCount - suffix.blocks !== nodes.length) return false;
	for (let k = 0; k < nodes.length; k++) if (!shapeEqual(withoutTrailingBreak(back.child(k)), withoutTrailingBreak(nodes[k]!))) return false;
	return true;
}

/**
 * 検算のための正規化(契約6): 文字のブロックの末尾の hard break と末尾の空白は、有っても無くても同じとみなす
 * (CommonMark は段落の末尾の hard break も末尾の空白も読まず、描画も同じ)。
 */
function withoutTrailingBreak(node: PMNode): PMNode {
	if (node.isText || node.isLeaf) return node;
	const kids: PMNode[] = [];
	node.forEach((c) => kids.push(c));
	if (node.isTextblock && !node.type.spec.code) {
		// 締め 5 周目 P2-b: 末尾の hard_break は書かないので、その前の soft_break も末尾の改行と同じ(無いのと同じ)
		while (kids.length > 0 && ['hard_break', 'soft_break'].includes(kids[kids.length - 1]!.type.name)) kids.pop();
		const last = kids[kids.length - 1];
		if (last?.isText) {
			const trimmed = last.text!.replace(/[ \t]+$/, '');
			if (trimmed !== last.text) {
				kids.pop();
				if (trimmed) kids.push(last.type.schema.text(trimmed, last.marks));
			}
		}
		return node.type.create(node.attrs, kids, node.marks);
	}
	return node.type.create(node.attrs, kids.map(withoutTrailingBreak), node.marks);
}

/** 検算の条件(前後のブロックとその書き出し・間・読み直しの後ろに足す定義)。同じなら検算の結果も同じ。 */
interface CheckContext {
	prevNode: PMNode | undefined;
	prevText: string | undefined;
	sepBefore: string;
	nextNode: PMNode | undefined;
	nextSep: string | undefined;
	nextText: string | undefined;
	suffix: string;
	suffixBlocks: number;
}

/** 検算のあとの書き出し(`Planned` のうち 2 巡目が決める欄)。 */
type Settled = Pick<Planned, 'stage' | 'text' | 'fellBack' | 'escaped' | 'warn'>;

/**
 * 触ったブロック 1 つの書き出しの控え。Node・切片(entry)・origin の表は不変なので、1 巡目の結果は
 * (Node・entry・eol)で決まり、2 巡目(検算)の結果はそれと前後の条件(`CheckContext`)で決まる。
 * 打鍵のたびに書き出すので(dirty の判定)、触っていないブロックの読み直しをここで省く。
 */
interface BlockMemo {
	entry: OriginEntry | null;
	eol: string;
	stage: Stage;
	text: string;
	check?: { context: CheckContext; settled: Settled };
}

/** origin の表(読み込み・保存・外部変更のたびに作り直す)ごとの控え。表が捨てられれば一緒に消える。 */
const blockMemos = new WeakMap<OriginTable, WeakMap<PMNode, BlockMemo>>();

function sameContext(a: CheckContext, b: CheckContext): boolean {
	return (
		a.prevNode === b.prevNode &&
		a.prevText === b.prevText &&
		a.sepBefore === b.sepBefore &&
		a.nextNode === b.nextNode &&
		a.nextSep === b.nextSep &&
		a.nextText === b.nextText &&
		a.suffix === b.suffix &&
		a.suffixBlocks === b.suffixBlocks
	);
}

/**
 * 2 巡目: 触ったブロック `plan[i]` を前後と一緒に読み直して書き出しを決める。落ちたら 2 段目のエスケープ → 3 段目 →
 * 3 段目の綴りの替え。どれも通らなければ文書の流儀の 3 段目のまま `warn`。
 */
function settleBlock(plan: Planned[], i: number, suffix: SuffixFor, origin: OriginTable, eol: string): Settled {
	const p = plan[i]!;
	const settled: Settled = { stage: p.stage, text: p.text, fellBack: false, escaped: false, warn: false };
	if (checkWithNeighbors(plan, i, p.text, suffix)) return settled;
	if (p.stage === 2 && p.entry) {
		const esc = stage2(p.node, p.entry, origin, true);
		if (esc !== null && esc.escaped && checkWithNeighbors(plan, i, esc.text, suffix)) {
			settled.text = esc.text;
			settled.escaped = true;
			return settled;
		}
	}
	if (p.stage === 2) {
		settled.fellBack = true;
		settled.stage = 3;
	}
	for (const variant of styleVariants(origin.style)) {
		const t3 = writeStage3(p.node, p.entry, variant, eol);
		if (checkWithNeighbors(plan, i, t3, suffix)) {
			settled.text = t3;
			return settled;
		}
	}
	settled.text = writeStage3(p.node, p.entry, origin.style, eol);
	settled.warn = true;
	if (import.meta.env?.DEV) console.warn('Markdown: a rewritten block does not read back the same', p.node.type.name);
	return settled;
}

/** 文書モデルを 3 段の規則で書き出す。`segments[i]` は `doc.child(i)` の書き出しの範囲と段。 */
export function serializeMarkdown(doc: PMNode, origin: OriginTable, generation: Generation, opts: { check?: boolean } = {}): SerializeResult {
	const check = opts.check ?? true;
	const eol = generation.dominantEol;
	const children: PMNode[] = [];
	doc.forEach((c) => children.push(c));
	// 系譜: bid が重なったら(split で属性が複製される)、元の Node と同一のものだけに系譜を残す
	const seen = new Map<number, number>();
	for (const c of children) {
		const b = c.attrs.bid as number | null;
		if (b !== null && b !== undefined) seen.set(b, (seen.get(b) ?? 0) + 1);
	}
	const lineage = (c: PMNode): OriginEntry | null => {
		const b = c.attrs.bid as number | null;
		if (b === null || b === undefined) return null;
		const e = origin.byBid.get(b);
		if (!e) return null;
		if ((seen.get(b) ?? 0) > 1 && e.node !== c) return null;
		return e;
	};
	let memos = blockMemos.get(origin);
	if (!memos) blockMemos.set(origin, (memos = new WeakMap()));
	// 1 巡目: 段を決めて書く
	const plan: Planned[] = [];
	let prev: OriginEntry | null = null;
	for (let i = 0; i < children.length; i++) {
		const c = children[i]!;
		const e = lineage(c);
		let sepBefore: string;
		if (i === 0) sepBefore = e && e.index === 0 ? e.src.slice(0, e.start) : generation.bom ? '\uFEFF' : '';
		else if (prev && e && prev.generation === e.generation && e.index === prev.index + 1) sepBefore = e.src.slice(prev.end, e.start);
		else sepBefore = eol + eol;
		let stage: Stage = 3;
		let text: string | null = null;
		if (e && e.node === c) {
			stage = 1;
			text = e.src.slice(e.start, e.end);
		} else {
			const memo = memos.get(c);
			if (memo && memo.entry === e && memo.eol === eol) {
				stage = memo.stage;
				text = memo.text;
			} else {
				const t2 = e ? stage2(c, e, origin, false) : null;
				if (t2 !== null) {
					stage = 2;
					text = t2.text;
				}
				// 第4段 4-4: リストは触った項目だけを書き直す(検算に落ちたら 2 巡目でリスト全体の 3 段目へ)
				if (text === null && e) text = writeListByItems(c, e, origin.style, eol);
				if (text === null) text = writeStage3(c, e, origin.style, eol);
				memos.set(c, { entry: e, eol, stage, text });
			}
		}
		plan.push({ node: c, entry: e, stage, text, sepBefore, fellBack: false, escaped: false, warn: false });
		prev = e;
	}
	// 2 巡目: 触ったブロックを前後と一緒に読み直す(`settleBlock`)。前後の条件が前の書き出しと同じなら読み直さない
	if (check) {
		let suffix: SuffixFor | null = null;
		for (let i = 0; i < plan.length; i++) {
			const p = plan[i]!;
			if (p.stage === 1) continue;
			suffix ??= contextSuffix(doc, eol);
			const before = plan[i - 1];
			const after = plan[i + 1];
			const around = suffix([before?.node, p.node, after?.node].filter((n): n is PMNode => n !== undefined));
			const context: CheckContext = {
				prevNode: before?.node,
				prevText: before?.text,
				sepBefore: p.sepBefore,
				nextNode: after?.node,
				nextSep: after?.sepBefore,
				nextText: after?.text,
				suffix: around.text,
				suffixBlocks: around.blocks,
			};
			// 1 巡目がこの Node の控えを置いている(同じ entry・eol)。検算の控えは前後の条件が同じときだけ使う
			const memo = memos.get(p.node)!;
			if (!memo.check || !sameContext(memo.check.context, context)) {
				memo.check = { context, settled: settleBlock(plan, i, suffix, origin, eol) };
			}
			Object.assign(p, memo.check.settled);
		}
	}
	// つなぐ
	const out: string[] = [];
	const segments: Segment[] = [];
	let length = 0;
	for (const p of plan) {
		out.push(p.sepBefore);
		length += p.sepBefore.length;
		const start = length;
		out.push(p.text);
		length += p.text.length;
		segments.push({ stage: p.stage, start, end: length, fellBack: p.fellBack, escaped: p.escaped, warn: p.warn });
	}
	const last = plan[plan.length - 1];
	if (last?.entry && last.entry.index === last.entry.generation.count - 1) out.push(last.entry.src.slice(last.entry.end));
	else if (generation.endsWithEol) out.push(eol);
	return { text: out.join(''), segments };
}
