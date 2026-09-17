/**
 * 要件#53 — HTML のレンダリング済み編集(テキストノード単位)の純関数。
 *
 * 閲覧専用(FR-02)撤廃の第3段。閲覧は要件#8 の sandbox された iframe のままで、
 * **編集のときだけ** 原文から sanitize 済みの複製(=編集面)を作り、アプリの DOM
 * (Shadow DOM)へ出す。iframe・`sandbox=""`・CSP・capability は一切触らない
 * (契約①)ので、2026-09-04 の調査が前提にしていた「sandbox 緩和・ブリッジ注入・
 * CSP 見直し」は要らない。
 *
 * ここに置くのは **DOM も状態も持たない判断** だけ(要件#49 の
 * `src/markdown/edit.ts` と同じ分担)。どの要素を contenteditable にするか・
 * 確定/破棄の契機は `Viewer.svelte` の持ち場。
 *
 * ## 原文へ戻る橋 = テキストノードの原文範囲
 *
 * HTML を再シリアライズすると属性の引用符・順序・エンティティ・空白が変わって
 * byte 等価を保証できない(要件#49 の Markdown は逆シリアライズで「意味等価」が
 * 取れたが、HTML にはそれが無い)。そこで **触るのはテキストノードの原文範囲だけ**
 * にする ―― それ以外は1バイトも触らないので、契約⑦のラウンドトリップが機械的に
 * 成り立つ。
 *
 * 範囲は parse5 の `sourceCodeLocation`(rehype-parse が hast の `position` に
 * 載せる)から採る。`position.start.offset` / `end.offset` は **原文の綴りのまま**
 * を指すので、`source.slice(start, end)` は `Hello &amp; world` や `one\r\ntwo` に
 * なる(DOM 側の値はデコード・改行正規化済み)。この索引が原文へ戻る唯一の橋で、
 * DOM に `data-vellis-hid` として stamp した事実を読む形にしてある
 * (要件#49 backlog 154 の教訓=「DOM に stamp 済みの事実を読む」の継承)。
 */
import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { SKIP, visit } from 'unist-util-visit';
import type { Element, Root, RootContent } from 'hast';
import { isExternal, resolveRelative, toAssetUri } from '$lib/uri';
import { vellisSchema } from '../markdown/sanitize-schema';

/** 編集単位の要素に付く印(契約②)。値は編集面の中で一意な連番。 */
export const HID_ATTRIBUTE = 'data-vellis-hid';

/**
 * 契約④の拒否通知の文言(用語集で固定)。要素の増減を伴う編集は原文の範囲と
 * 1対1に戻せないので確定せず、タグを直すなら「Source」へ、と行き先を示す。
 */
export const STRUCTURE_CHANGED_MESSAGE = 'Structure changed — use Source to edit tags';

/**
 * 1テキストノードの原文範囲。offset は原文文字列の UTF-16 code unit(0 起点・
 * end は排他)で、`source.slice(start, end)` が**エンティティ込みの原文の綴り**に
 * なる。`childIndex` は編集面 DOM でその要素の `childNodes` の何番目か。
 */
export type TextNodeRange = { childIndex: number; start: number; end: number };

/** hid → その要素直下のテキストノードの原文範囲。 */
export type EditSurfaceIndex = Map<string, TextNodeRange[]>;

export type EditSurface = {
	/** Shadow DOM に入れる HTML(`<body>` の中身)。 */
	html: string;
	index: EditSurfaceIndex;
	/** `<head>` の `<style>` の中身(編集面へ移して効かせる=契約②)。 */
	styles: string[];
};

export type CommitResult =
	| { ok: true; source: string; index: EditSurfaceIndex }
	| { ok: false; reason: 'structure-changed' };

// ---------------------------------------------------------------------------
// sanitize のスキーマ(契約②)
// ---------------------------------------------------------------------------

type Schema = typeof defaultSchema;

function uniq<T>(items: readonly T[]): T[] {
	return [...new Set(items)];
}

/**
 * 編集面で追加で通すタグ。
 *
 * 土台の `vellisSchema`(= GitHub 由来の defaultSchema)は Markdown の出力を
 * 通すための一覧なので、素の HTML 文書が使う区画タグ(`<main>` `<nav>` …)や
 * `<style>` が入っていない。落とされた要素は **unwrap されて中身だけが残る** =
 * 見た目が崩れるので、契約③が編集単位として名指ししているタグ(`figcaption`
 * `caption` `label` `legend` `article` `aside` `header` `footer` `main` `nav`)と、
 * 文書の見た目を保つために要る `<style>` を足す。
 *
 * **足さないもの**: `script` `iframe` `object` `embed` `form` と `on*` 属性は
 * defaultSchema の既定どおり落ちる(契約②)。
 */
const EXTRA_TAG_NAMES = [
	'style',
	'article',
	'aside',
	'header',
	'footer',
	'main',
	'nav',
	'figure',
	'figcaption',
	'caption',
	'colgroup',
	'col',
	'label',
	'legend',
	'fieldset',
	'address',
	'abbr',
	'cite',
	'mark',
	'small',
	'time',
	'u',
	'dfn',
	'bdi',
	'bdo',
	'wbr',
] as const;

/**
 * 中身を丸ごと落とす(unwrap しない)要素。raw text / 表示されないものなので、
 * unwrap するとソースが本文として画面に出てしまう(契約⑤)。
 */
const STRIPPED_TAG_NAMES = [
	'script',
	'textarea',
	'template',
	'title',
	'iframe',
	'object',
	'embed',
	'noscript',
] as const;

const vellisAttributes = (vellisSchema.attributes ?? {}) as Record<string, unknown[]>;

/**
 * タグごとの `className` の **値** 制限を外す。
 *
 * Markdown 側のスキーマは `className` を `[name, ...許す値]` の形で絞っている
 * (`li` は `task-list-item` だけ・`blockquote` / `p` は `markdown-alert*` だけ)。
 * hast-util-sanitize はタグ固有の定義が当たると「空配列」を返して `*` の定義へ
 * 落ちないので、この形が残っていると文書の `class="x"` が `class=""` になる。
 * 編集面は文書の見た目を保つのが目的(契約②)なので、値の制限だけを外して
 * `*` の素の `className` に任せる。
 */
function withoutClassNameValues(definitions: readonly unknown[]): unknown[] {
	return definitions.filter(
		(definition) => !(Array.isArray(definition) && definition[0] === 'className'),
	);
}

const editAttributes: Record<string, unknown[]> = {};
for (const [tagName, definitions] of Object.entries(vellisAttributes)) {
	editAttributes[tagName] = withoutClassNameValues(definitions);
}
editAttributes['*'] = uniq([...(editAttributes['*'] ?? []), 'className', 'style']);

/**
 * 編集面用のスキーマ(契約②)。既存の `vellisSchema` は **無改変** のまま土台に
 * 使い、ここで新しい定数として足す(契約⑧・AC-53-13 が `vellisSchema` の値を固定)。
 *
 * - `clobber: []` / `clobberPrefix: ''`: `id` / `name` を `user-content-` 付きへ
 *   書き換えない。文書の CSS が `#id` で当たっているので、接頭辞を付けると
 *   見た目が崩れる(契約②「文書の見た目を保つ」)
 * - `*` に `className` と `style`: 同上。`id` は defaultSchema に元から入っている
 */
export const htmlEditSchema: Schema = {
	...vellisSchema,
	clobber: [],
	clobberPrefix: '',
	tagNames: uniq([...(vellisSchema.tagNames ?? []), ...EXTRA_TAG_NAMES]),
	strip: uniq([...(vellisSchema.strip ?? []), ...STRIPPED_TAG_NAMES]),
	attributes: editAttributes as Schema['attributes'],
};

const parser = unified().use(rehypeParse);
const sanitizer = unified().use(rehypeSanitize, htmlEditSchema);
const stringifier = unified().use(rehypeStringify);

// ---------------------------------------------------------------------------
// 編集面の生成(契約②)
// ---------------------------------------------------------------------------

/**
 * sanitize の前後で同じ要素を突き合わせる鍵。
 *
 * hast-util-sanitize は木を作り直す(ノードの同一性は残らない)が、`position` は
 * そのまま持ち越す ―― 要素の開始/終了 offset の組は文書内で一意なので、これを
 * 鍵にすれば「sanitize 前の直下の子の並び」を後から引ける。位置を持たない要素
 * (parse5 が補った `<tbody>` など)は鍵が作れない = 編集単位にしない。
 */
function positionKey(node: Element): string | null {
	const start = node.position?.start.offset;
	const end = node.position?.end.offset;
	if (start === undefined || end === undefined) return null;
	return start + ':' + end;
}

/** その要素の中身を編集させないもの(raw text / 表示されない)=契約⑤。 */
const OPAQUE_TAG_NAMES = new Set(['style', 'script', 'textarea', 'title', 'template']);

function childSignature(children: readonly RootContent[]): string {
	return children.map((child) => (child.type === 'element' ? 'e:' + child.tagName : child.type)).join('|');
}

function findElement(root: Root | Element, tagName: string): Element | null {
	let found: Element | null = null;
	visit(root, 'element', (node: Element) => {
		if (found === null && node.tagName === tagName) found = node;
	});
	return found;
}

function textOf(node: Element): string {
	return node.children.map((child) => (child.type === 'text' ? child.value : '')).join('');
}

/**
 * `source.slice(start, end)` がそのテキストノードの綴りそのものか。
 *
 * parse5 は文書末の暗黙の終了タグをまたいで文字トークンを1つのテキストノードへ
 * 束ねることがあり(`"\n</body>\n</html>\n"` が値 `"\n\n\n"` の1ノードになる)、
 * その範囲を書き換えるとタグごと消える。テキストの綴りに **マークアップの開始**
 * (`<` + 英字 / `!` / `/` / `?`)が現れることは無い(現れていればそこでトークンが
 * 切れる)ので、それを見つけたら 1対1に戻せないものとして扱う。
 */
const MARKUP_START = /<[a-zA-Z!/?]/;

function isVerbatimSpan(source: string, start: number, end: number): boolean {
	if (!(start >= 0 && end >= start && end <= source.length)) return false;
	return !MARKUP_START.test(source.slice(start, end));
}

/**
 * 相対 URL を `vellis-asset:` へ書き換え、リンクは航行しないよう `href` を
 * 退避する(契約②。`html-viewer.ts` の `retargetLinks` と同じ扱い)。
 *
 * sanitize の **後** に走らせるので、`javascript:` などの危険な URL は既に
 * 落ちている ―― 退避先は素の data 属性なので、スキーマを緩める必要が無い。
 */
function retargetAndRewrite(tree: Root, docUri: string): void {
	visit(tree, 'element', (node: Element) => {
		const props = node.properties;
		if (!props) return;
		if (node.tagName === 'img' || node.tagName === 'source') {
			const src = props.src;
			if (typeof src === 'string' && src.length > 0 && !src.startsWith('vellis-asset:') && !isExternal(src)) {
				try {
					props.src = toAssetUri(resolveRelative(docUri, src));
				} catch {
					// 解決できない URI(未対応スキーム)はそのまま置く=読めないだけ。
				}
			}
			return;
		}
		if (node.tagName === 'a' || node.tagName === 'area') {
			if (typeof props.href === 'string') {
				props['data-vellis-href'] = props.href;
				delete props.href;
			}
			if (typeof props.xlinkHref === 'string') {
				props['data-vellis-xlink-href'] = props.xlinkHref;
				delete props.xlinkHref;
			}
		}
	});
}

/**
 * 原文(現在の編集バッファ)から編集面を作る(契約②)。
 *
 * parse(位置付き)→ sanitize → hid の stamp → stringify。`<head>` は出さず、
 * その `<style>` の中身だけを `styles` で持ち出して編集面へ移す。
 */
export function buildEditSurface(source: string, docUri: string): EditSurface {
	const tree = parser.parse(source);
	const head = findElement(tree, 'head');
	const body = findElement(tree, 'body');

	const styles: string[] = [];
	if (head) {
		for (const child of head.children) {
			if (child.type === 'element' && child.tagName === 'style') styles.push(textOf(child));
		}
	}

	// `<body>` の中身だけを編集面に出す。sanitize は `html` / `head` / `body` を
	// 許可タグに持たないので、木ごと渡すと unwrap されて `<title>` の中身が本文へ
	// 混ざる ―― 先に切り出してから通す。
	const bodyRoot: Root = { type: 'root', children: body ? body.children : tree.children };

	// sanitize 前の「直下の子の並び」を控える(契約⑤の判定に使う)。
	const signatures = new Map<string, string>();
	visit(bodyRoot, 'element', (node: Element) => {
		const key = positionKey(node);
		if (key !== null) signatures.set(key, childSignature(node.children));
	});

	const clean = sanitizer.runSync(bodyRoot) as Root;
	retargetAndRewrite(clean, docUri);

	const index: EditSurfaceIndex = new Map();
	let counter = 0;
	visit(clean, 'element', (node: Element) => {
		// raw text / 表示されない要素の中身は編集させない(契約⑤)。
		if (OPAQUE_TAG_NAMES.has(node.tagName)) return SKIP;

		// sanitize で直下の子の並びが変わった要素は、原文範囲と1対1に戻せない
		// (例: `<p>a<script>x</script>b</p>` は script が落ちて a と b が DOM で
		// 1つのテキストノードに繋がる)。hid を付けないのでダブルクリックは空振り。
		const key = positionKey(node);
		const signature = key === null ? undefined : signatures.get(key);
		if (signature === undefined || signature !== childSignature(node.children)) return;

		const ranges: TextNodeRange[] = [];
		let mappable = true;
		node.children.forEach((child, childIndex) => {
			if (child.type !== 'text') return;
			const start = child.position?.start.offset;
			const end = child.position?.end.offset;
			if (start === undefined || end === undefined || !isVerbatimSpan(source, start, end)) {
				mappable = false;
				return;
			}
			ranges.push({ childIndex, start, end });
		});
		if (!mappable || ranges.length === 0) return;

		const hid = String(++counter);
		node.properties = { ...(node.properties ?? {}), [HID_ATTRIBUTE]: hid };
		index.set(hid, ranges);
	});

	return { html: stringifier.stringify(clean), index, styles };
}

// ---------------------------------------------------------------------------
// 編集単位の解決(契約③)
// ---------------------------------------------------------------------------

/**
 * 編集単位になれるタグ(契約③)。「子孫にブロック要素を含まない」ものだけが
 * 実際の編集単位で、コンテナ全体の編集は不可(要件#49 契約①の継承)。
 */
const LEAF_BLOCK_TAGS = new Set([
	'p',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'li',
	'dt',
	'dd',
	'td',
	'th',
	'pre',
	'figcaption',
	'caption',
	'summary',
	'label',
	'legend',
	'blockquote',
	'div',
	'section',
	'article',
	'aside',
	'header',
	'footer',
	'main',
	'nav',
]);

/** 「子に持っていたら葉ブロックではない」要素。 */
const BLOCK_TAGS = [
	...LEAF_BLOCK_TAGS,
	'ul',
	'ol',
	'dl',
	'table',
	'thead',
	'tbody',
	'tfoot',
	'tr',
	'colgroup',
	'figure',
	'form',
	'fieldset',
	'hr',
	'details',
	'hgroup',
	'menu',
];

const BLOCK_SELECTOR = BLOCK_TAGS.join(',');

// DOM の Element(lib.dom)と hast の Element が同名なので、別名で受ける。
type Element_ = globalThis.Element;

/** 書き戻せる編集単位か: hid を持ち(契約⑤)、ブロック要素を子孫に持たない。 */
function isEditableUnit(el: Element_ | null): boolean {
	return el !== null && el.hasAttribute(HID_ATTRIBUTE) && el.querySelector(BLOCK_SELECTOR) === null;
}

/**
 * ダブルクリックの target から編集単位の葉ブロックを解決する(契約③)。
 *
 * 押した位置から **外へ** 辿り、葉ブロックのタグが見つかればそれ。無ければ
 * テキストノードの親要素(`span` 等のインライン要素も可)。編集面のルート・
 * ブロック要素を子に持つ要素・hid を持たない要素(契約⑤)は null。
 */
export function resolveLeafBlock(target: Element_, root: Element_): HTMLElement | null {
	const chain: Element_[] = [];
	for (let el: Element_ | null = target; el !== null && el !== root; el = el.parentElement) {
		if (!root.contains(el)) break;
		chain.push(el);
	}
	for (const el of chain) {
		if (LEAF_BLOCK_TAGS.has(el.tagName.toLowerCase()) && isEditableUnit(el)) return el as HTMLElement;
	}
	for (const el of chain) {
		if (isEditableUnit(el)) return el as HTMLElement;
	}
	return null;
}

// ---------------------------------------------------------------------------
// 確定と差し替え(契約④⑦)
// ---------------------------------------------------------------------------

type ShapeChild =
	| { kind: 'text'; value: string }
	| { kind: 'other'; name: string }
	| ElementShape;

type ElementShape = { kind: 'element'; tag: string; children: ShapeChild[] };

/**
 * 編集開始時に控えるブロックの形(契約④)。要素の tagName 列と、各要素直下の
 * テキストノードの値。**値は形の比較には使わない** ―― 値が変わることが編集で、
 * 形が変わることが拒否の理由。
 */
export type BlockShape = ElementShape;

function shapeOf(node: Node): ShapeChild {
	if (node.nodeType === 3) return { kind: 'text', value: node.nodeValue ?? '' };
	if (node.nodeType === 1) return snapshotBlock(node as Element_);
	return { kind: 'other', name: node.nodeName };
}

export function snapshotBlock(el: Element_): BlockShape {
	return {
		kind: 'element',
		tag: el.tagName.toLowerCase(),
		children: [...el.childNodes].map(shapeOf),
	};
}

function sameShape(before: ShapeChild, after: ShapeChild): boolean {
	if (before.kind !== after.kind) return false;
	if (before.kind === 'text') return true; // 値の違いが編集そのもの
	if (before.kind === 'other') return before.name === (after as { name: string }).name;
	const b = before;
	const a = after as ElementShape;
	if (b.tag !== a.tag || b.children.length !== a.children.length) return false;
	for (let i = 0; i < b.children.length; i++) {
		if (!sameShape(b.children[i], a.children[i])) return false;
	}
	return true;
}

/** 契約④の最小エスケープ。それ以外の文字は生のまま(U+00A0 も `&nbsp;` に戻さない)。 */
function escapeMinimal(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

type Replacement = { start: number; end: number; text: string };

/**
 * 値が変わったテキストノードを集める。書き戻し先(索引の範囲)が無いものが
 * 1つでもあれば拒否 ―― 書けない編集を黙って落とすと、画面と原文が食い違う。
 */
function collectReplacements(
	el: Element_,
	shape: ElementShape,
	index: EditSurfaceIndex,
	out: Replacement[],
): boolean {
	const hid = el.getAttribute(HID_ATTRIBUTE);
	const ranges = hid === null ? undefined : index.get(hid);
	const nodes = [...el.childNodes];
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		const child = shape.children[i];
		if (!child) return false;
		if (node.nodeType === 3) {
			if (child.kind !== 'text') return false;
			const value = node.nodeValue ?? '';
			if (value === child.value) continue;
			const range = ranges?.find((r) => r.childIndex === i);
			if (!range) return false;
			out.push({ start: range.start, end: range.end, text: escapeMinimal(value) });
		} else if (node.nodeType === 1) {
			if (child.kind !== 'element') return false;
			if (!collectReplacements(node as Element_, child, index, out)) return false;
		}
	}
	return true;
}

/**
 * 確定後の索引を書き戻した長さの差分で位置補正する(契約④。要件#49 の
 * `recordEdit` / `currentPositionOf` と同じ考え方)。
 *
 * テキストノードの範囲は互いに重ならないので、「その範囲より前で終わった
 * 差し替え」の増減を足すだけでよい。差し替えられた範囲自身は終端だけが動く。
 */
function shiftIndex(index: EditSurfaceIndex, replacements: readonly Replacement[]): EditSurfaceIndex {
	const next: EditSurfaceIndex = new Map();
	for (const [hid, ranges] of index) {
		next.set(
			hid,
			ranges.map((range) => {
				let startDelta = 0;
				let endDelta = 0;
				for (const r of replacements) {
					const delta = r.text.length - (r.end - r.start);
					if (r.end <= range.start) {
						startDelta += delta;
						endDelta += delta;
					} else if (r.start === range.start && r.end === range.end) {
						endDelta += delta;
					}
				}
				return { childIndex: range.childIndex, start: range.start + startDelta, end: range.end + endDelta };
			}),
		);
	}
	return next;
}

/**
 * 確定(契約④⑦)。`normalize()` してから `before` と形を比べ、同じなら値が
 * 変わったテキストノードだけを原文の当該範囲へ **後ろから** 書き戻す。
 *
 * `normalize()` を先に通すのは、貼り付けや Enter の挿入が同じ位置に隣り合う
 * テキストノードを作るため ―― 束ねれば編集前と同じ形に戻る。逆に、編集で
 * 消えて空になったテキストノードは normalize が落とすので「テキストノードの
 * 数の変化」= 構造の変化として拒否される(契約④のとおり)。
 */
export function commitBlock(args: {
	source: string;
	index: EditSurfaceIndex;
	block: Element_;
	before: BlockShape;
}): CommitResult {
	const { source, index, block, before } = args;
	block.normalize();
	if (!sameShape(before, snapshotBlock(block))) return { ok: false, reason: 'structure-changed' };

	const replacements: Replacement[] = [];
	if (!collectReplacements(block, before, index, replacements)) {
		return { ok: false, reason: 'structure-changed' };
	}
	if (replacements.length === 0) return { ok: true, source, index };

	// 後ろから書き戻す = 前の差し替えの増減で後ろの範囲がずれない(契約④)。
	const ordered = [...replacements].sort((a, b) => b.start - a.start);
	let out = source;
	for (const r of ordered) out = out.slice(0, r.start) + r.text + out.slice(r.end);

	return { ok: true, source: out, index: shiftIndex(index, replacements) };
}
