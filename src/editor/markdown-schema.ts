/**
 * Markdown の編集面のスキーマ(要件#74 契約2・7・第2段の作り(案)の項目 2)。
 *
 * 最上位に来られるブロックは `bid`(ブロックの系譜の番号)を持つ。原文の切片は属性ではなく横の表
 * (`to-markdown.ts` の origin の表=bid → 原文の切片)に持つ(仮の前提=判断 1。Node の形の比較を
 * 綴りに引きずられないようにするため・split で属性が複製されるため)。
 * 描画のまま直しにくいもの(front matter・生 HTML・参照定義)は中を打てない塊(atom)で、`raw` に原文の
 * 綴りを持つ(契約7)。
 */
import { Schema, type NodeSpec, type MarkSpec } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';

const bid = { bid: { default: null as number | null } };

const tables = tableNodes({
	tableGroup: 'block',
	cellContent: 'inline*',
	cellAttributes: {
		align: {
			default: null,
			getFromDOM: (dom) => (dom as HTMLElement).style.textAlign || null,
			setDOMAttr: (value, attrs) => {
				if (value) attrs.style = `text-align: ${value}`;
			},
		},
	},
});

// prosemirror-tables の表にも bid を持たせる(持たせないと系譜が切れ、触っていない表が 3 段目で書き直される=実測)
tables.table = { ...tables.table, attrs: { ...(tables.table.attrs ?? {}), ...bid } };
// セルは `inline*`(文字のブロック)なので、素の GapCursor.valid は行の中のセルの間を gap とみなす。表の内側には gap を
// 立てない(要件#74 実機ゲート 12-8・契約20。表の前 / 後ろの gap は文書の深さ)
tables.table_row = { ...tables.table_row, allowGapCursor: false };

const nodes: Record<string, NodeSpec> = {
	doc: { content: 'block+' },
	text: { group: 'inline' },
	paragraph: {
		group: 'block',
		content: 'inline*',
		attrs: { ...bid },
		parseDOM: [{ tag: 'p' }],
		toDOM: () => ['p', 0],
	},
	heading: {
		group: 'block',
		content: 'inline*',
		defining: true,
		attrs: { ...bid, level: { default: 1 }, setext: { default: false } },
		parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
		toDOM: (n) => [`h${n.attrs.level}`, 0],
	},
	blockquote: {
		group: 'block',
		content: 'block+',
		defining: true,
		attrs: { ...bid },
		parseDOM: [{ tag: 'blockquote' }],
		toDOM: () => ['blockquote', 0],
	},
	alert: {
		group: 'block',
		content: 'block*',
		defining: true,
		attrs: { ...bid, kind: { default: 'note' } },
		toDOM: (n) => [
			'blockquote',
			{ class: `markdown-alert markdown-alert-${n.attrs.kind}` },
			['p', { class: 'markdown-alert-title', contenteditable: 'false' }, n.attrs.kind],
			['div', 0],
		],
	},
	bullet_list: {
		group: 'block',
		content: 'list_item+',
		attrs: { ...bid, spread: { default: false } },
		parseDOM: [{ tag: 'ul' }],
		toDOM: () => ['ul', 0],
	},
	ordered_list: {
		group: 'block',
		content: 'list_item+',
		attrs: { ...bid, start: { default: 1 }, spread: { default: false } },
		parseDOM: [{ tag: 'ol', getAttrs: (d) => ({ start: Number((d as HTMLElement).getAttribute('start') ?? 1) }) }],
		toDOM: (n) => ['ol', { start: n.attrs.start }, 0],
	},
	list_item: {
		content: 'block+',
		defining: true,
		// number: 順序つきの項目の、読んだときの番号(第4段 4-4=書き出しで番号を振り直さない。綴りの属性=形の比較に入れない)
		attrs: { checked: { default: null as boolean | null }, spread: { default: false }, number: { default: null as number | null } },
		parseDOM: [{ tag: 'li' }],
		toDOM: (n) => ['li', n.attrs.checked === null ? {} : { class: 'task-list-item', 'data-checked': String(n.attrs.checked) }, 0],
	},
	code_block: {
		group: 'block',
		content: 'text*',
		marks: '',
		code: true,
		defining: true,
		// 要件#74 第3段 3-1: 隣に gap cursor を立てる(文字のブロックだが中は CodeMirror の NodeView=外から文字のカーソルで入れない)
		createGapCursor: true,
		attrs: { ...bid, lang: { default: null as string | null }, meta: { default: null as string | null } },
		parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
		toDOM: (n) => ['pre', { 'data-lang': n.attrs.lang ?? '' }, ['code', 0]],
	},
	horizontal_rule: {
		group: 'block',
		attrs: { ...bid },
		parseDOM: [{ tag: 'hr' }],
		toDOM: () => ['hr'],
	},
	footnote_definition: {
		group: 'block',
		content: 'block+',
		defining: true,
		attrs: { ...bid, label: { default: '' } },
		toDOM: (n) => ['section', { class: 'footnote-definition', 'data-label': n.attrs.label }, 0],
	},
	/** front matter・生 HTML のブロック・リンク参照定義=中を打てない塊(atom)。raw は原文の綴り。 */
	front_matter: {
		group: 'block',
		atom: true,
		selectable: true,
		attrs: { ...bid, raw: { default: '' } },
		toDOM: (n) => ['div', { class: 'front-matter-chip', contenteditable: 'false' }, `Front matter · ${String(n.attrs.raw).split(/\r\n|\r|\n/).length} lines`],
	},
	html_block: {
		group: 'block',
		atom: true,
		selectable: true,
		attrs: { ...bid, raw: { default: '' } },
		toDOM: () => ['div', { class: 'vellis-raw-html', contenteditable: 'false' }],
	},
	definition: {
		group: 'block',
		atom: true,
		selectable: false,
		attrs: { ...bid, raw: { default: '' }, identifier: { default: '' }, label: { default: '' }, url: { default: '' }, title: { default: null as string | null } },
		toDOM: () => ['div', { hidden: 'hidden', 'data-vellis-definition': '' }],
	},
	...tables,
	image: {
		group: 'inline',
		inline: true,
		atom: true,
		attrs: { src: { default: '' }, alt: { default: '' }, title: { default: null as string | null }, ref: { default: null as string | null }, refType: { default: null as string | null } },
		toDOM: (n) => ['img', { src: n.attrs.src, alt: n.attrs.alt, title: n.attrs.title }],
	},
	footnote_reference: {
		group: 'inline',
		inline: true,
		atom: true,
		attrs: { label: { default: '' } },
		toDOM: (n) => ['sup', { class: 'footnote-ref' }, ['a', { href: `#fn-${n.attrs.label}` }, n.attrs.label]],
	},
	html_inline: {
		group: 'inline',
		inline: true,
		atom: true,
		attrs: { raw: { default: '' } },
		toDOM: () => ['span', { class: 'vellis-raw-html-inline', contenteditable: 'false' }],
	},
	hard_break: {
		group: 'inline',
		inline: true,
		selectable: false,
		/** 原文の綴り(`'  \n'`・`'\\\n'`。改行の綴りを含む)。 */
		attrs: { raw: { default: '  \n' } },
		parseDOM: [{ tag: 'br' }],
		toDOM: () => ['br'],
		leafText: () => '\n',
	},
	/** 段落の中の原文の改行(と次の行の字下げ)。見た目は空白 1 つ。 */
	soft_break: {
		group: 'inline',
		inline: true,
		selectable: false,
		attrs: { raw: { default: '\n' } },
		parseDOM: [{ tag: 'span.soft-break', priority: 60 }],
		toDOM: () => ['span', { class: 'soft-break' }, ' '],
		leafText: () => ' ',
	},
};

const marks: Record<string, MarkSpec> = {
	link: {
		attrs: {
			href: { default: '' },
			title: { default: null as string | null },
			/** 'inline' | 'autolink' | 'literal' | 'reference' */
			kind: { default: 'inline' },
			identifier: { default: null as string | null },
			label: { default: null as string | null },
			referenceType: { default: null as string | null },
		},
		inclusive: false,
		// 編集面どうしの貼り付け(`data-pm-slice` のある text/html)で構造を残すための読み方(契約17・項目 18)
		parseDOM: [
			{
				tag: 'a[href]',
				getAttrs: (dom) => ({ href: (dom as HTMLElement).getAttribute('href') ?? '', title: (dom as HTMLElement).getAttribute('title') }),
			},
		],
		toDOM: (m) => ['a', { href: m.attrs.href, title: m.attrs.title }, 0],
	},
	strong: { parseDOM: [{ tag: 'strong' }, { tag: 'b' }], toDOM: () => ['strong', 0] },
	em: { parseDOM: [{ tag: 'em' }, { tag: 'i' }], toDOM: () => ['em', 0] },
	strike: { parseDOM: [{ tag: 'del' }, { tag: 's' }], toDOM: () => ['del', 0] },
	// code は他の mark を締め出さない(GFM は ~~`x`~~・**`x`**・[`x`](u) を許す。締め出すと読み込みで取り消し線が落ちる=実測)
	code: { parseDOM: [{ tag: 'code' }], toDOM: () => ['code', 0] },
};

export const markdownSchema = new Schema({ nodes, marks });
