/**
 * Markdown の読み込み(要件#74 契約2・7・15・第2段の作り(案)の項目 3・4)。純関数・DOM なし。
 *
 * 閲覧と同じ remark パイプライン(remark-parse → remark-gfm → remarkVellisAlert)の mdast から ProseMirror の
 * 文書を作り、最上位ブロックごとに origin の表の項目(原文の切片・2 段目に使う文字の連なり・タスクの印)を作る。
 *
 * - **BOM** は micromark が剥がして offset を数えない(周回0 で実測)ので、剥がしてから読み offset を足し直す
 * - **front matter** は自前で検出して剥がす(remark は `---` の後の `key: v\n---` を setext の見出しに読む)。
 *   BOM の後ろでも検出する。先頭が HTML の注釈なら検出しない(契約7 のまま)
 * - **runs**=最上位ブロックの中の「同じ mark の text が続く連なり」(インラインの葉と textblock の境目で切れる)
 *   ごとの原文の範囲。原文の切片と値が同じ(エスケープ・文字参照を含まない)ときだけ `eligible`
 * - 段落の中の改行は `soft_break`(raw=行末の空白+改行+次の行の字下げ)、hard break は `hard_break`
 *   (raw=原文の綴り)。code fence の中身は PM の中では `\n` で持ち、原文の改行の綴りを run の `eol` に持つ
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type * as M from 'mdast';
import { Fragment, Mark, type Node as PMNode } from 'prosemirror-model';

import { remarkVellisAlert } from '../markdown/plugins/alert';
import { markdownSchema as schema } from './markdown-schema';

/** 閲覧(`src/markdown/renderer.ts`)と同じ読み込みの段。 */
export const markdownProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkVellisAlert).freeze();

export interface Run {
	/** 原文(世代の src)での範囲 */
	start: number;
	end: number;
	value: string;
	eligible: boolean;
	/** code fence の中の改行の綴り(PM の中は \n) */
	eol?: string;
}

export interface Generation {
	id: number;
	src: string;
	/** この世代の最上位ブロックの数 */
	count: number;
	bom: boolean;
	dominantEol: string;
	endsWithEol: boolean;
}

export interface OriginEntry {
	node: PMNode;
	src: string;
	start: number;
	end: number;
	index: number;
	generation: Generation;
	runs: Run[];
	/** タスクの印(文書の順)。start は印の 1 文字の位置(見つからなければ -1) */
	tasks?: { start: number; value: string }[];
	/**
	 * 第4段 4-4: リストの中のノード(項目・項目の中のブロック・入れ子のリスト)の原文の範囲。読んだときの Node をそのまま
	 * 鍵にする(触っていない部分木は取引の後も同じ Node のまま=同一性で「触っていない」が分かる)。
	 */
	spans?: Map<PMNode, [number, number]>;
}

export interface ParsedMarkdown {
	doc: PMNode;
	generation: Generation;
	entries: OriginEntry[];
}

let generationCounter = 0;
let bidCounter = 0;

/** 新しいブロックの系譜の番号。 */
export function freshBid(): number {
	return ++bidCounter;
}

/** 改行コードの多いほう(数が同じなら \n)。 */
export function detectEol(src: string): string {
	let lf = 0;
	let crlf = 0;
	let cr = 0;
	for (let i = 0; i < src.length; i++) {
		const c = src.charCodeAt(i);
		if (c === 13) {
			if (src.charCodeAt(i + 1) === 10) {
				crlf++;
				i++;
			} else cr++;
		} else if (c === 10) lf++;
	}
	const max = Math.max(lf, crlf, cr);
	if (max === 0) return '\n';
	if ([lf, crlf, cr].filter((n) => n === max).length > 1) return '\n';
	return crlf === max ? '\r\n' : cr === max ? '\r' : '\n';
}

/** `from` から始まる `---` 行から次の `---` / `...` 行まで(その行の改行の手前まで)。無ければ 0。 */
export function frontMatterEnd(src: string, from: number): number {
	const open = /---[ \t]*(\r\n|\r|\n)/y;
	open.lastIndex = from;
	const m = open.exec(src);
	if (!m) return 0;
	let i = from + m[0].length;
	const line = /([^\r\n]*)(\r\n|\r|\n|$)/y;
	while (i < src.length) {
		line.lastIndex = i;
		const l = line.exec(src);
		if (!l || l[0].length === 0) break;
		if (/^(---|\.\.\.)[ \t]*$/.test(l[1]!)) return i + l[1]!.length;
		i += l[0].length;
	}
	return 0;
}

const EOL_RE = /\r\n|\r|\n/;

interface Ctx {
	src: string;
	/** mdast の offset に足す量(BOM・front matter の前置き) */
	shift: number;
	runs: Run[];
	tasks: { start: number; value: string }[];
	/** 第4段 4-4: リストの中のノードの原文の範囲 */
	spans?: Map<PMNode, [number, number]>;
}

type Positioned = { position?: { start: { offset?: number }; end: { offset?: number } } };

function span(n: Positioned, ctx: Ctx): [number, number] {
	return [(n.position?.start.offset ?? 0) + ctx.shift, (n.position?.end.offset ?? 0) + ctx.shift];
}

// ---------------------------------------------------------------------------
// インライン
// ---------------------------------------------------------------------------

interface Piece {
	node: PMNode;
	/** text のとき: 原文の範囲と eligible */
	start?: number;
	end?: number;
	eligible?: boolean;
}

function textPieces(n: M.Text, marks: readonly Mark[], ctx: Ctx, alertFirst: boolean): Piece[] {
	const out: Piece[] = [];
	if (!n.position) {
		if (n.value) out.push({ node: schema.text(n.value, marks), eligible: false, start: 0, end: 0 });
		return out;
	}
	const [s, e] = span(n, ctx);
	const slice = ctx.src.slice(s, e);
	const segs = n.value.split(EOL_RE);
	// 原文の行(改行の綴りつき)
	const lines: { text: string; at: number; eol: string }[] = [];
	const re = /([^\r\n]*)(\r\n|\r|\n|$)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(slice)) !== null) {
		lines.push({ text: m[1]!, at: s + m.index, eol: m[2]! });
		if (m[2] === '') break;
	}
	// アラートの最初の段落は、印の行(`[!NOTE]`)を除いた本文から始まる。
	if (alertFirst && lines.length === segs.length + 1) lines.shift();
	const aligned = lines.length === segs.length;
	let leadRaw = '';
	for (let i = 0; i < segs.length; i++) {
		const seg = segs[i]!;
		let start = 0;
		let end = 0;
		let eligible = false;
		if (aligned) {
			const line = lines[i]!;
			const body = i < segs.length - 1 ? line.text.replace(/[ \t]+$/, '') : line.text;
			if (body.endsWith(seg)) {
				const lead = body.length - seg.length;
				start = line.at + lead;
				end = start + seg.length;
				const leadText = body.slice(0, lead);
				const leadOk = i === 0 && !(alertFirst && lead > 0) ? lead === 0 : /^[ \t>]*$/.test(leadText);
				eligible = leadOk && ctx.src.slice(start, end) === seg;
				if (i > 0) leadRaw += leadText;
			} else if (i > 0) {
				leadRaw += (/^[ \t>]*/.exec(line.text) ?? [''])[0];
			}
		}
		if (i > 0) out.push({ node: schema.nodes.soft_break!.create({ raw: leadRaw }) });
		if (seg.length > 0) out.push({ node: schema.text(seg, marks), start, end, eligible });
		if (aligned) {
			const line = lines[i]!;
			const trail = i < segs.length - 1 ? (/[ \t]+$/.exec(line.text) ?? [''])[0] : '';
			leadRaw = trail + line.eol;
		} else leadRaw = '\n';
	}
	return out;
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr', 'area', 'base', 'col', 'embed', 'source', 'track', 'param']);

function inlinePieces(children: M.PhrasingContent[], marks: readonly Mark[], ctx: Ctx, alertFirst = false): Piece[] {
	const out: Piece[] = [];
	for (let i = 0; i < children.length; i++) {
		const c = children[i]!;
		switch (c.type) {
			case 'text':
				out.push(...textPieces(c, marks, ctx, alertFirst && i === 0));
				break;
			case 'emphasis':
				out.push(...inlinePieces(c.children, schema.marks.em!.create().addToSet(marks), ctx));
				break;
			case 'strong':
				out.push(...inlinePieces(c.children, schema.marks.strong!.create().addToSet(marks), ctx));
				break;
			case 'delete':
				out.push(...inlinePieces(c.children, schema.marks.strike!.create().addToSet(marks), ctx));
				break;
			case 'inlineCode': {
				const [s, e] = span(c, ctx);
				const slice = ctx.src.slice(s, e);
				const fence = (/^`+/.exec(slice) ?? [''])[0].length;
				const inner = slice.slice(fence, slice.length - fence);
				let start = s + fence;
				let eligible = false;
				if (inner === c.value) eligible = true;
				else if (inner === ` ${c.value} `) {
					start += 1;
					eligible = true;
				}
				if (c.value) {
					out.push({
						node: schema.text(c.value, schema.marks.code!.create().addToSet(marks)),
						start,
						end: start + c.value.length,
						eligible,
					});
				}
				break;
			}
			case 'link': {
				// GFM の素の URL(メールなど)は位置を持たないことがある(実測)=literal
				const ch = c.position ? ctx.src[span(c, ctx)[0]] : '';
				const kind = ch === '<' ? 'autolink' : ch === '[' ? 'inline' : 'literal';
				const mark = schema.marks.link!.create({ href: c.url, title: c.title ?? null, kind });
				out.push(...inlinePieces(c.children, mark.addToSet(marks), ctx));
				break;
			}
			case 'linkReference': {
				const mark = schema.marks.link!.create({
					href: '',
					kind: 'reference',
					identifier: c.identifier,
					label: c.label ?? null,
					referenceType: c.referenceType,
				});
				out.push(...inlinePieces(c.children, mark.addToSet(marks), ctx));
				break;
			}
			case 'image':
				out.push({ node: schema.nodes.image!.create({ src: c.url, alt: c.alt ?? '', title: c.title ?? null }, null, marks) });
				break;
			case 'imageReference':
				out.push({
					node: schema.nodes.image!.create({ alt: c.alt ?? '', ref: c.identifier, refType: c.referenceType }, null, marks),
				});
				break;
			case 'footnoteReference':
				out.push({ node: schema.nodes.footnote_reference!.create({ label: c.label ?? c.identifier }, null, marks) });
				break;
			case 'break': {
				const [s, e] = span(c, ctx);
				let raw = ctx.src.slice(s, e);
				if (!/(\r\n|\r|\n)$/.test(raw)) raw += (/^(\r\n|\r|\n)/.exec(ctx.src.slice(e)) ?? ['\n'])[0];
				out.push({ node: schema.nodes.hard_break!.create({ raw }, null, marks) });
				break;
			}
			case 'html': {
				// 開きタグから対応する閉じタグまでを 1 つの塊に(契約7・(ab))。無ければ単独の塊
				const open = /^<([A-Za-z][\w-]*)\b[^>]*?(\/?)>$/.exec(c.value);
				if (open && !open[2] && !VOID_TAGS.has(open[1]!.toLowerCase())) {
					const tag = open[1]!.toLowerCase();
					const opens = new RegExp(`^<${tag}\\b[^>]*[^/]>$`, 'i');
					const closes = new RegExp(`^</${tag}\\s*>$`, 'i');
					let depth = 0;
					let j = i + 1;
					for (; j < children.length; j++) {
						const d = children[j]!;
						if (d.type !== 'html') continue;
						if (opens.test(d.value)) depth++;
						else if (closes.test(d.value)) {
							if (depth === 0) break;
							depth--;
						}
					}
					if (j < children.length && c.position && children[j]!.position) {
						const [s] = span(c, ctx);
						const [, e] = span(children[j]!, ctx);
						out.push({ node: schema.nodes.html_inline!.create({ raw: ctx.src.slice(s, e) }, null, marks) });
						i = j;
						break;
					}
				}
				out.push({ node: schema.nodes.html_inline!.create({ raw: c.value }, null, marks) });
				break;
			}
			default:
				// 想定外のインライン(脚注の参照以外の拡張など)は塊として残す
				out.push({ node: schema.nodes.html_inline!.create({ raw: '' }, null, marks) });
		}
	}
	return out;
}

/** インラインの並びを PM の内容にし、runs を ctx に足す(同じ mark の text の連なり=1 run)。 */
function inlineContent(children: M.PhrasingContent[], ctx: Ctx, alertFirst = false): Fragment {
	const pieces = inlinePieces(children, Mark.none, ctx, alertFirst);
	let run: Run | null = null;
	let runMarks: readonly Mark[] | null = null;
	const nodes: PMNode[] = [];
	for (const p of pieces) {
		nodes.push(p.node);
		if (p.node.isText) {
			if (run && runMarks && Mark.sameSet(runMarks, p.node.marks)) {
				const contiguous = run.end === p.start;
				run.value += p.node.text!;
				run.end = p.end!;
				run.eligible = run.eligible && !!p.eligible && contiguous;
			} else {
				run = { start: p.start!, end: p.end!, value: p.node.text!, eligible: !!p.eligible };
				runMarks = p.node.marks;
				ctx.runs.push(run);
			}
		} else {
			run = null;
			runMarks = null;
		}
	}
	return Fragment.fromArray(nodes);
}

// ---------------------------------------------------------------------------
// ブロック
// ---------------------------------------------------------------------------

function alertKind(n: M.Blockquote): string | null {
	const cls = (n.data as { hProperties?: { className?: string[] } } | undefined)?.hProperties?.className;
	const found = cls?.find((c) => c.startsWith('markdown-alert-'));
	return found ? found.slice('markdown-alert-'.length) : null;
}

function blockNode(n: M.RootContent, ctx: Ctx, bid: number | null): PMNode {
	switch (n.type) {
		case 'paragraph':
			return schema.nodes.paragraph!.create({ bid }, inlineContent(n.children, ctx));
		case 'heading': {
			const [s] = span(n, ctx);
			const setext = !/^[ \t]*#/.test(ctx.src.slice(s, s + 8));
			return schema.nodes.heading!.create({ bid, level: n.depth, setext }, inlineContent(n.children, ctx));
		}
		case 'blockquote': {
			const kind = alertKind(n);
			if (kind) {
				// 表題の段落(位置なし=プラグインが足したもの)は読まない
				const kids = n.children.filter((c) => c.position);
				const content = kids.map((c, i) =>
					i === 0 && c.type === 'paragraph'
						? schema.nodes.paragraph!.create(null, inlineContent(c.children, ctx, true))
						: blockNode(c, ctx, null),
				);
				return schema.nodes.alert!.create({ bid, kind }, content);
			}
			return schema.nodes.blockquote!.create({ bid }, blockChildren(n.children, ctx));
		}
		case 'list': {
			const items = n.children.map((li) => {
				if (li.checked !== null && li.checked !== undefined && li.position) {
					// タスクの印の位置(`- [ ]` の空白か x)。印の切り替えはこの 1 文字だけを差し替える(AC-74-21)
					const [s] = span(li, ctx);
					const m = /^([-*+]|\d{1,9}[.)])([ \t]+)\[([ xX])\]/.exec(ctx.src.slice(s, s + 24));
					if (m) ctx.tasks.push({ start: s + m[1]!.length + m[2]!.length + 1, value: m[3]! });
					else ctx.tasks.push({ start: -1, value: '?' });
				}
				// 第4段 4-4: 順序つきの項目は読んだときの番号を覚える(書き出しで後ろの番号を振り直さない)
				let number: number | null = null;
				if (n.ordered && li.position) {
					const [s] = span(li, ctx);
					const m = /^(\d{1,9})[.)]/.exec(ctx.src.slice(s, s + 12));
					if (m) number = Number(m[1]);
				}
				const item = schema.nodes.list_item!.create(
					{ checked: li.checked ?? null, spread: li.spread ?? false, number },
					blockChildren(li.children, ctx),
				);
				if (ctx.spans && li.position) ctx.spans.set(item, span(li, ctx));
				return item;
			});
			return n.ordered
				? schema.nodes.ordered_list!.create({ bid, start: n.start ?? 1, spread: n.spread ?? false }, items)
				: schema.nodes.bullet_list!.create({ bid, spread: n.spread ?? false }, items);
		}
		case 'code': {
			const [s, e] = span(n, ctx);
			const slice = ctx.src.slice(s, e);
			const eol = (EOL_RE.exec(slice) ?? ['\n'])[0];
			const value = n.value.replace(/\r\n|\r/g, '\n');
			let run: Run = { start: 0, end: 0, value, eligible: false, eol };
			if (/^[ \t]*(`{3,}|~{3,})/.test(slice)) {
				const firstEol = slice.search(EOL_RE);
				if (firstEol >= 0) {
					const bodyStart = s + firstEol + eol.length;
					const raw = n.value;
					const ok = ctx.src.slice(bodyStart, bodyStart + raw.length) === raw;
					run = { start: bodyStart, end: bodyStart + raw.length, value, eligible: ok && raw.length > 0, eol };
				}
			}
			ctx.runs.push(run);
			return schema.nodes.code_block!.create(
				{ bid, lang: n.lang ?? null, meta: n.meta ?? null },
				value ? schema.text(value) : null,
			);
		}
		case 'thematicBreak':
			return schema.nodes.horizontal_rule!.create({ bid });
		case 'html':
			return schema.nodes.html_block!.create({ bid, raw: n.value });
		case 'definition': {
			const [s, e] = span(n, ctx);
			return schema.nodes.definition!.create({
				bid,
				raw: ctx.src.slice(s, e),
				identifier: n.identifier,
				label: n.label ?? null,
				url: n.url,
				title: n.title ?? null,
			});
		}
		case 'footnoteDefinition':
			return schema.nodes.footnote_definition!.create(
				{ bid, label: n.label ?? n.identifier },
				blockChildren(n.children as M.RootContent[], ctx),
			);
		case 'table': {
			const rows = n.children.map((row, r) =>
				schema.nodes.table_row!.create(
					null,
					row.children.map((cell, ci) =>
						(r === 0 ? schema.nodes.table_header! : schema.nodes.table_cell!).create(
							{ align: n.align?.[ci] ?? null },
							inlineContent(cell.children, ctx),
						),
					),
				),
			);
			return schema.nodes.table!.create({ bid }, rows);
		}
		default: {
			// 想定外のブロック(拡張の無い記法)は、原文の綴りのまま塊にする
			const [s, e] = span(n as Positioned, ctx);
			return schema.nodes.html_block!.create({ bid, raw: ctx.src.slice(s, e) });
		}
	}
}

function blockChildren(children: M.RootContent[], ctx: Ctx): PMNode[] {
	const out = children.map((c) => {
		const node = blockNode(c, ctx, null);
		if (ctx.spans && (c as Positioned).position) ctx.spans.set(node, span(c as Positioned, ctx));
		return node;
	});
	if (out.length === 0) out.push(schema.nodes.paragraph!.create());
	return out;
}

/**
 * 原文を読み、PM の文書と origin の表の項目を作る。`entries[i]` は `doc.child(i)` に対応し、start / end は
 * `src` の中の切片(BOM・front matter の前置きを含む offset)。
 */
export function parseMarkdownDocument(src: string): ParsedMarkdown {
	const bom = src.charCodeAt(0) === 0xfeff;
	const bodyFrom = bom ? 1 : 0;
	const fmEnd = frontMatterEnd(src, bodyFrom);
	const generation: Generation = {
		id: ++generationCounter,
		src,
		count: 0,
		bom,
		dominantEol: detectEol(src),
		endsWithEol: /(\r\n|\r|\n)$/.test(src),
	};
	const entries: OriginEntry[] = [];
	const top: PMNode[] = [];
	if (fmEnd > 0) {
		const node = schema.nodes.front_matter!.create({ bid: freshBid(), raw: src.slice(bodyFrom, fmEnd) });
		top.push(node);
		entries.push({ node, src, start: bodyFrom, end: fmEnd, index: 0, generation, runs: [] });
	}
	const parseFrom = fmEnd > 0 ? fmEnd : bodyFrom;
	const tree = markdownProcessor.runSync(markdownProcessor.parse(src.slice(parseFrom))) as M.Root;
	for (const child of tree.children) {
		const ctx: Ctx = { src, shift: parseFrom, runs: [], tasks: [], spans: child.type === 'list' ? new Map() : undefined };
		const node = blockNode(child, ctx, freshBid());
		const [s, e] = span(child, ctx);
		top.push(node);
		entries.push({ node, src, start: s, end: e, index: entries.length, generation, runs: ctx.runs, tasks: ctx.tasks, spans: ctx.spans });
	}
	if (top.length === 0) {
		// 空の文書: 置き場の段落 1 つ(原文の末尾に長さ 0 で写す)
		const node = schema.nodes.paragraph!.create({ bid: freshBid() });
		top.push(node);
		entries.push({ node, src, start: src.length, end: src.length, index: 0, generation, runs: [] });
	}
	generation.count = entries.length;
	const doc = schema.nodes.doc!.create(null, top);
	// 同一性で「触っていない」を判定するので、doc の子と項目の Node を同じものにそろえる
	doc.forEach((child, _offset, i) => {
		if (child !== entries[i]!.node) entries[i]!.node = child;
	});
	return { doc, generation, entries };
}
