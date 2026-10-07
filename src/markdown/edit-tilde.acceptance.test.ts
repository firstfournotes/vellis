/**
 * 要件#49 追補h の受け入れテスト(docs/requirements/req-49.md「追補h」・backlog 268)
 * — `~` のエスケープ規則(unit)= AC-49-38
 *
 * src/markdown/edit-tasklist-strike.acceptance.test.ts(AC-49-32〜34)は書き換えず、
 * 追補h 用に新設。家風は同じ: 本番パイプライン(`render`)の HTML を JSDOM に載せ、
 * `SourceIndex` の `NodeMeta` を引いて `serializeBlock` / `replaceRange` を直接呼ぶ
 * (`originSlice` も Viewer の `commitBlockEdit` と同じく `index.sliceOf(meta.id)` を渡す)。
 * Viewer の配線は判定しない(逆シリアライズの層の話)。
 *
 * ## 判定する契約と、実装に求める観測可能な振る舞い
 *
 * 契約⑥(未編集ブロック=byte 等価・編集ブロック=意味等価)・追補e(3)「何も変えずに
 * 確定すると byte 等価」に、追補h(1)(2) を重ねる:
 *
 * - **追補h(1)**: 本文の文字としての `~~`(取り消し線として読まれうる、2つ以上続く `~`)は
 *   `\~\~` と書き戻し、取り消し線の境界を変えない
 * - **追補h(2)**: 単独の `~`(`~5`・`a~b`)はエスケープしない(無変更の確定で byte 等価)
 *
 * - **AC-49-38(a)** 取り消し線の中にエスケープした `~` がある段落(`a ~~b\~~c~~ d`・
 *   `a ~~b\~\~c~~ d`)を無変更で確定 → 再レンダーの取り消し線の範囲と中身が確定前と同じ。
 *   どちらも取り消し線の中身は `b~~c`(`\~~` は「エスケープした `~`」と「閉じの `~~` と
 *   長さが合わずに文字のまま残る1本の `~`」の並び=赤確認で実測 2026-10-05)。
 *   `\~\~` の形は無変更の確定で byte 等価、`\~~` の形は `a ~~b\~\~c~~ d` と書き戻してよい
 *   (意味等価=byte 等価は求めない)。段落・密なリスト項目・表セル・見出し。
 *   (実測・実装前: `~~` の中の `\~` が落ちて `a ~~b~~c~~ d` となり、
 *   再レンダーの取り消し線が `b` だけになる=backlog 268 (a))
 * - **AC-49-38(b)** 本文に文字として `~~x~~` を打って確定 → 再レンダーで取り消し線に
 *   ならず `~~x~~` の文字が出る(原文は `\~\~x\~\~`)。原文でエスケープした `\~\~x\~\~` を
 *   無変更で確定しても同じ(byte 等価)。段落・密なリスト項目・表セル・見出し。
 *   (コードから読んだ見立て・実装前: `~~x~~` のまま書き戻されて取り消し線になる=backlog 268 (b))
 * - **AC-49-38(c)** 単独の `~` を含む段落(`約 ~5 分`・`a~b`)を無変更で確定 → byte 等価
 *   (`\~` にならない)。文字を足して確定しても単独の `~` は `~` のまま。
 * - **AC-49-38(d)** 取り消し線そのもの(`~~del~~`)は従来どおり(AC-49-34 の回帰)。
 *   取り消し線の隣に文字としての `~~x~~` を打っても、取り消し線の範囲は変わらない。
 *
 * ## 判定しないもの
 * - 1本の `~` が2つで対になる形(`~x~`・`a~b~c`)を本文に打ったとき(追補h(2) は「単独の
 *   `~` はエスケープしない」と定めるだけで、対になる1本の `~` の扱いは定めていない)
 * - ブロックの行頭の `~`(core の `mdast-util-to-markdown` の unsafe `atBreak` が `\~` に
 *   することがある=追補h より前からの書き出しの性質。`[` → `\[` と同じ扱いで byte 等価は
 *   求めず、再レンダーで `~` の文字が出ることだけを見る)
 * - Viewer の配線(ダブルクリック→確定→editBuffer / dirty)
 */
import { describe, expect, test } from 'vitest';
import { render } from './renderer';
import { replaceRange, resolveEditTarget, serializeBlock } from './edit';
import type { NodeMeta, SourceIndex } from './types';

const baseUri = 'file:///home/user/notes/doc.md';

// ---------------------------------------------------------------------------
// フィクスチャ(edit-tasklist-strike.acceptance.test.ts の家風)
// ---------------------------------------------------------------------------

interface Mounted {
	html: string;
	index: SourceIndex;
	root: HTMLDivElement;
}

/** 本番パイプライン(`render`)の出力を JSDOM に載せる。 */
async function mount(source: string): Promise<Mounted> {
	const result = await render(source, baseUri);
	const root = document.createElement('div');
	root.innerHTML = result.html;
	return { html: result.html, index: result.index, root };
}

function q(scope: ParentNode, selector: string): HTMLElement {
	const el = scope.querySelector(selector);
	if (!el) throw new Error(`要素が見つからない: ${selector}`);
	return el as HTMLElement;
}

/** 原文スライスが `slice` に一致するブロック(type 指定)を DOM と index から引く。 */
function blockBySlice(
	m: Mounted,
	type: string,
	slice: string,
): { el: HTMLElement; meta: NodeMeta } {
	for (const meta of m.index.byId.values()) {
		if (meta.type !== type) continue;
		if (m.index.sliceOf(meta.id) !== slice) continue;
		return { el: q(m.root, `[data-vellis-node-id="${meta.id}"]`), meta };
	}
	throw new Error(`${type} ブロック "${slice}" が index に無い`);
}

/** ブロックの末尾にテキストを足す(末尾のテキストノードが無ければ新しく足す=表セル)。 */
function appendAtEnd(el: HTMLElement, text: string): void {
	const last = el.lastChild;
	if (last && last.nodeType === Node.TEXT_NODE) (last as Text).data += text;
	else el.appendChild(document.createTextNode(text));
}

/**
 * 編集の1周: DOM を直した後のブロックを逆シリアライズして原文へ差し戻す。
 * `originSlice` は Viewer の `commitBlockEdit` と同じく初回レンダーのスライス。
 */
function commit(m: Mounted, source: string, el: HTMLElement, meta: NodeMeta): string {
	return replaceRange(
		source,
		meta.position,
		serializeBlock(el, meta, source, baseUri, m.index.sliceOf(meta.id)),
	);
}

/** `md` の中の `from`(1箇所)だけを `to` に替えた期待原文。 */
function replacedOnce(md: string, from: string, to: string): string {
	const at = md.indexOf(from);
	if (at < 0 || md.indexOf(from, at + 1) >= 0) {
		throw new Error(`期待原文の組み立てで "${from}" が一意でない`);
	}
	return md.slice(0, at) + to + md.slice(at + from.length);
}

/** 意味等価の比較用に、レンダー HTML から位置依存の属性を落とす。 */
function normalizeHtml(html: string): string {
	return html.replace(
		/ data-(?:vellis-node-id|source-start|source-end|source-start-line|source-end-line)="[^"]*"/g,
		'',
	);
}

/** 2つの Markdown が同じ HTML にレンダーされるか(契約⑥「意味等価」の機械判定)。 */
async function expectSameRender(actual: string, expected: string): Promise<void> {
	const [a, e] = await Promise.all([render(actual, baseUri), render(expected, baseUri)]);
	expect(normalizeHtml(a.html)).toBe(normalizeHtml(e.html));
}

/** 文書順の `del` の表示文字列(取り消し線の中身)。 */
function delTexts(root: ParentNode): string[] {
	return [...root.querySelectorAll('del')].map((d) => d.textContent ?? '');
}

/** 文書順の `del` を含むブロックの種類(取り消し線の範囲が変わっていないか)。 */
function delHolders(root: ParentNode): string[] {
	return [...root.querySelectorAll('del')].map(
		(d) =>
			d
				.closest('[data-vellis-node-type]:not([data-vellis-node-type="delete"])')
				?.getAttribute('data-vellis-node-type') ?? '',
	);
}

/** 文書の表示文字列(空白を1つに潰す)。 */
function textOf(root: ParentNode): string {
	return (root.textContent ?? '').replace(/\s+/g, ' ');
}

interface BlockCase {
	label: string;
	type: string;
	/** `blockBySlice` で引く原文スライス。 */
	slice: string;
}

// ===========================================================================
// AC-49-38(a) — 取り消し線の中の `\~` が落ちて境界が変わらない
// ===========================================================================

/**
 * 取り消し線の中にエスケープした `~` を持つブロック。AC の例 `\~~` と `\~\~`(中身は
 * どちらも `b~~c`)を、段落・密なリスト項目・表セル・見出しのそれぞれで。
 */
const ESC_IN_STRIKE_MD = [
	'# Title',
	'',
	'a ~~b\\~~c~~ d',
	'',
	'a ~~b\\~\\~c~~ d',
	'',
	'- item ~~b\\~~c~~ d',
	'- item ~~b\\~\\~c~~ d',
	'- other',
	'',
	'| A | B |',
	'| --- | --- |',
	'| ~~b\\~~c~~ | b1 |',
	'| ~~b\\~\\~c~~ | b2 |',
	'',
	'## Head ~~b\\~~c~~ here',
	'',
	'## Head ~~b\\~\\~c~~ here',
	'',
	'Tail.',
	'',
].join('\n');

/** 確定前の取り消し線の中身(文書順)。 */
const ESC_IN_STRIKE_DELS = ['b~~c', 'b~~c', 'b~~c', 'b~~c', 'b~~c', 'b~~c', 'b~~c', 'b~~c'];
const ESC_IN_STRIKE_HOLDERS = [
	'paragraph',
	'paragraph',
	'listItem',
	'listItem',
	'tableCell',
	'tableCell',
	'heading',
	'heading',
];

/** AC の例 `\~~`(取り消し線の中身は `b~~c`・byte 等価は求めない)。 */
const SINGLE_ESC_CASES: BlockCase[] = [
	{ label: '段落', type: 'paragraph', slice: 'a ~~b\\~~c~~ d' },
	{ label: '密なリスト項目', type: 'listItem', slice: '- item ~~b\\~~c~~ d' },
	{ label: '表セル', type: 'tableCell', slice: '| ~~b\\~~c~~ ' },
	{ label: '見出し', type: 'heading', slice: '## Head ~~b\\~~c~~ here' },
];

/** 取り消し線の中に文字としての `~~`(`\~\~`)がある形(中身は `b~~c`)。 */
const DOUBLE_ESC_CASES: BlockCase[] = [
	{ label: '段落', type: 'paragraph', slice: 'a ~~b\\~\\~c~~ d' },
	{ label: '密なリスト項目', type: 'listItem', slice: '- item ~~b\\~\\~c~~ d' },
	{ label: '表セル', type: 'tableCell', slice: '| ~~b\\~\\~c~~ ' },
	{ label: '見出し', type: 'heading', slice: '## Head ~~b\\~\\~c~~ here' },
];

describe('AC-49-38(a) — レンダー結果では `\\~` は取り消し線の中の文字(前提の確認)', () => {
	test('`~~b\\~~c~~` も `~~b\\~\\~c~~` も `del` で中身は `b~~c`(8 ブロックすべて)', async () => {
		const m = await mount(ESC_IN_STRIKE_MD);
		expect(delTexts(m.root)).toEqual(ESC_IN_STRIKE_DELS);
		expect(delHolders(m.root)).toEqual(ESC_IN_STRIKE_HOLDERS);
		for (const c of [...SINGLE_ESC_CASES, ...DOUBLE_ESC_CASES]) {
			const { el } = blockBySlice(m, c.type, c.slice);
			expect(resolveEditTarget(el, m.index).kind).toBe('block');
		}
	});
});

describe('serializeBlock — 取り消し線の中の `\\~~` を無変更で確定しても境界が変わらない(契約⑥・追補h(1) / AC-49-38(a))', () => {
	test.each(SINGLE_ESC_CASES)(
		'(a) $label `~~b\\~~c~~`: 何も変えずに確定 → 再レンダーの取り消し線の範囲と中身が確定前と同じ',
		async (c) => {
			const m = await mount(ESC_IN_STRIKE_MD);
			const { el, meta } = blockBySlice(m, c.type, c.slice);

			const next = commit(m, ESC_IN_STRIKE_MD, el, meta);
			const again = await mount(next);

			// 中身 `b~~c` の `~~` は `\~\~` と書き戻してよい(`a ~~b\~\~c~~ d`=意味等価)ので
			// byte 等価は求めない。見るのは取り消し線の範囲と中身。
			expect(delTexts(again.root)).toEqual(ESC_IN_STRIKE_DELS);
			expect(delHolders(again.root)).toEqual(ESC_IN_STRIKE_HOLDERS);
			await expectSameRender(next, ESC_IN_STRIKE_MD);
			// 文字としての `~~` が本文に漏れない(`~~b~~c~~ d` のような崩れ方の検知)。
			expect(textOf(again.root)).toBe(textOf(m.root));
		},
	);

	test.each(DOUBLE_ESC_CASES)(
		'(a) $label `~~b\\~\\~c~~`: 何も変えずに確定 → byte 等価(中の `~~` は `\\~\\~` のまま)・再レンダーの取り消し線が同じ',
		async (c) => {
			const m = await mount(ESC_IN_STRIKE_MD);
			const { el, meta } = blockBySlice(m, c.type, c.slice);

			// コードから読んだ見立て(実装前): `~~b~~c~~` となり、再レンダーの取り消し線が `b` だけになる。
			const next = commit(m, ESC_IN_STRIKE_MD, el, meta);

			expect(next).toBe(ESC_IN_STRIKE_MD);
			const again = await mount(next);
			expect(delTexts(again.root)).toEqual(ESC_IN_STRIKE_DELS);
			expect(delHolders(again.root)).toEqual(ESC_IN_STRIKE_HOLDERS);
		},
	);

	test('段落 `a ~~b\\~\\~c~~ d` の末尾に " more" を足して確定 → 取り消し線の中の `\\~\\~` はそのまま・本文の変更だけが入る', async () => {
		const m = await mount(ESC_IN_STRIKE_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', 'a ~~b\\~\\~c~~ d');
		appendAtEnd(el, ' more');

		const next = commit(m, ESC_IN_STRIKE_MD, el, meta);

		expect(next).toBe(replacedOnce(ESC_IN_STRIKE_MD, 'a ~~b\\~\\~c~~ d', 'a ~~b\\~\\~c~~ d more'));
		expect(delTexts((await mount(next)).root)).toEqual(ESC_IN_STRIKE_DELS);
	});
});

// ===========================================================================
// AC-49-38(b) — 本文に文字として打った `~~x~~` は取り消し線にならない
// ===========================================================================

/** 取り消し線も `~` も含まないブロック4種(ここに `~~x~~` を文字として打つ)。 */
const PLAIN_MD = [
	'# Title',
	'',
	'Tilde para',
	'',
	'- item x',
	'- other',
	'',
	'| A | B |',
	'| --- | --- |',
	'| plain cell | b1 |',
	'',
	'## Head here',
	'',
	'Tail.',
	'',
].join('\n');

interface TypedCase extends BlockCase {
	/** `~~x~~` を末尾に打って確定したときの期待スライス(`\~\~x\~\~`)。 */
	expected: string;
}

const TYPED_CASES: TypedCase[] = [
	{
		label: '段落',
		type: 'paragraph',
		slice: 'Tilde para',
		expected: 'Tilde para \\~\\~x\\~\\~',
	},
	{
		label: '密なリスト項目',
		type: 'listItem',
		slice: '- item x',
		expected: '- item x \\~\\~x\\~\\~',
	},
	{
		label: '表セル',
		type: 'tableCell',
		slice: '| plain cell ',
		expected: '| plain cell \\~\\~x\\~\\~ ',
	},
	{
		label: '見出し',
		type: 'heading',
		slice: '## Head here',
		expected: '## Head here \\~\\~x\\~\\~',
	},
];

describe('AC-49-38(b) — 取り消し線を含まない文書には `del` が無い(前提の確認)', () => {
	test('PLAIN_MD の4ブロックは block で、`del` は 0', async () => {
		const m = await mount(PLAIN_MD);
		expect(m.root.querySelectorAll('del')).toHaveLength(0);
		for (const c of TYPED_CASES) {
			const { el } = blockBySlice(m, c.type, c.slice);
			expect(resolveEditTarget(el, m.index).kind).toBe('block');
		}
	});
});

describe('serializeBlock — 本文に文字として打った `~~x~~` は `\\~\\~x\\~\\~` と書き戻し、取り消し線にならない(追補h(1) / AC-49-38(b))', () => {
	test.each(TYPED_CASES)(
		'(b) $label: 末尾に " ~~x~~" を打って確定 → 原文は `\\~\\~x\\~\\~`・他は byte 等価',
		async (c) => {
			const m = await mount(PLAIN_MD);
			const { el, meta } = blockBySlice(m, c.type, c.slice);
			appendAtEnd(el, ' ~~x~~');

			// コードから読んだ見立て(実装前): `~~x~~` のまま書き戻される(backlog 268 (b))。
			const next = commit(m, PLAIN_MD, el, meta);

			expect(next).toBe(replacedOnce(PLAIN_MD, c.slice, c.expected));
		},
	);

	test.each(TYPED_CASES)(
		'(b) $label: 確定後の原文を再レンダーしても取り消し線にならず `~~x~~` の文字が出る',
		async (c) => {
			const m = await mount(PLAIN_MD);
			const { el, meta } = blockBySlice(m, c.type, c.slice);
			appendAtEnd(el, ' ~~x~~');
			const next = commit(m, PLAIN_MD, el, meta);

			const again = await mount(next);

			expect(again.root.querySelectorAll('del')).toHaveLength(0);
			expect(textOf(again.root)).toContain(' ~~x~~');
			// 利用者が見ていた確定前の DOM と同じ文字が出る(文字が消えない・増えない)。
			expect(textOf(again.root)).toBe(textOf(m.root));
		},
	);
});

/** 原文で `~~` をエスケープして文字にしているブロック4種。 */
const ESCAPED_MD = [
	'# Title',
	'',
	'Esc \\~\\~x\\~\\~ end',
	'',
	'- item \\~\\~x\\~\\~ y',
	'- other',
	'',
	'| A | B |',
	'| --- | --- |',
	'| \\~\\~x\\~\\~ | b1 |',
	'',
	'## Head \\~\\~x\\~\\~ here',
	'',
	'Tail.',
	'',
].join('\n');

const ESCAPED_CASES: BlockCase[] = [
	{ label: '段落', type: 'paragraph', slice: 'Esc \\~\\~x\\~\\~ end' },
	{ label: '密なリスト項目', type: 'listItem', slice: '- item \\~\\~x\\~\\~ y' },
	{ label: '表セル', type: 'tableCell', slice: '| \\~\\~x\\~\\~ ' },
	{ label: '見出し', type: 'heading', slice: '## Head \\~\\~x\\~\\~ here' },
];

describe('AC-49-38(b) — レンダー結果では `\\~\\~x\\~\\~` は文字の `~~x~~`(前提の確認)', () => {
	test('ESCAPED_MD に `del` は無く、`~~x~~` の文字が4回出る', async () => {
		const m = await mount(ESCAPED_MD);
		expect(m.root.querySelectorAll('del')).toHaveLength(0);
		expect(textOf(m.root).match(/~~x~~/g)).toHaveLength(4);
		for (const c of ESCAPED_CASES) {
			const { el } = blockBySlice(m, c.type, c.slice);
			expect(resolveEditTarget(el, m.index).kind).toBe('block');
		}
	});
});

describe('serializeBlock — 原文でエスケープした `\\~\\~x\\~\\~` は無変更の確定で byte 等価・取り消し線にならない(契約⑥・追補h(1) / AC-49-38(b))', () => {
	test.each(ESCAPED_CASES)(
		'(b) $label: 何も変えずに確定 → byte 等価(`\\~\\~x\\~\\~` のまま)',
		async (c) => {
			const m = await mount(ESCAPED_MD);
			const { el, meta } = blockBySlice(m, c.type, c.slice);

			// コードから読んだ見立て(実装前): `~~x~~` になる(backlog 268 (b)「以前からの性質」)。
			expect(commit(m, ESCAPED_MD, el, meta)).toBe(ESCAPED_MD);
		},
	);

	test.each(ESCAPED_CASES)(
		'(b) $label: 末尾に " more" を足して確定 → `\\~\\~x\\~\\~` はそのまま・再レンダーでも取り消し線にならない',
		async (c) => {
			const m = await mount(ESCAPED_MD);
			const { el, meta } = blockBySlice(m, c.type, c.slice);
			appendAtEnd(el, ' more');

			const next = commit(m, ESCAPED_MD, el, meta);

			// 差し替えたブロックの範囲だけを見る(他のブロックの `\~\~x\~\~` で緑にならないように)。
			const editedSlice = next.slice(
				meta.position.startOffset,
				next.length - (ESCAPED_MD.length - meta.position.endOffset),
			);
			expect(editedSlice).toContain('\\~\\~x\\~\\~');
			expect(editedSlice).not.toContain('~~x~~');
			const again = await mount(next);
			expect(again.root.querySelectorAll('del')).toHaveLength(0);
			expect(textOf(again.root).match(/~~x~~/g)).toHaveLength(4);
		},
	);
});

// ===========================================================================
// AC-49-38(c) — 単独の `~` はエスケープしない
// ===========================================================================

/** 単独の `~` を行頭以外に含むブロック(段落・密なリスト項目・表セル・見出し)と、`~` だけの段落。 */
const LONE_MD = [
	'# Title',
	'',
	'約 ~5 分',
	'',
	'a~b',
	'',
	'x ~ y',
	'',
	'end ~',
	'',
	'~',
	'',
	'- item ~5 min',
	'- other',
	'',
	'| A | B |',
	'| --- | --- |',
	'| c~d | b1 |',
	'',
	'## Head ~5 here',
	'',
	'Tail.',
	'',
].join('\n');

const LONE_CASES: BlockCase[] = [
	{ label: '段落 `約 ~5 分`', type: 'paragraph', slice: '約 ~5 分' },
	{ label: '段落 `a~b`', type: 'paragraph', slice: 'a~b' },
	{ label: '段落 `x ~ y`', type: 'paragraph', slice: 'x ~ y' },
	{ label: '段落 `end ~`', type: 'paragraph', slice: 'end ~' },
	{ label: '密なリスト項目 `- item ~5 min`', type: 'listItem', slice: '- item ~5 min' },
	{ label: '表セル `| c~d |`', type: 'tableCell', slice: '| c~d ' },
	{ label: '見出し `## Head ~5 here`', type: 'heading', slice: '## Head ~5 here' },
];

describe('AC-49-38(c) — 単独の `~` はレンダー結果でも文字(前提の確認)', () => {
	test('LONE_MD に `del` は無く、`~` の文字が原文の数だけ出る', async () => {
		const m = await mount(LONE_MD);
		expect(m.root.querySelectorAll('del')).toHaveLength(0);
		expect(textOf(m.root).match(/~/g)).toHaveLength(8);
		for (const c of LONE_CASES) {
			const { el } = blockBySlice(m, c.type, c.slice);
			expect(resolveEditTarget(el, m.index).kind).toBe('block');
		}
	});
});

describe('serializeBlock — 単独の `~` を含むブロックは無変更の確定で byte 等価(契約⑥・追補h(2) / AC-49-38(c))', () => {
	test.each(LONE_CASES)('(c) $label: 何も変えずに確定 → byte 等価(`\\~` にならない)', async (c) => {
		const m = await mount(LONE_MD);
		const { el, meta } = blockBySlice(m, c.type, c.slice);

		const next = commit(m, LONE_MD, el, meta);

		expect(next).toBe(LONE_MD);
		expect(next).not.toContain('\\~');
	});

	test.each(LONE_CASES)(
		'(c) $label: 末尾に " more" を足して確定 → 単独の `~` は `~` のまま・本文の変更だけが入る',
		async (c) => {
			const m = await mount(LONE_MD);
			const { el, meta } = blockBySlice(m, c.type, c.slice);
			appendAtEnd(el, ' more');

			const next = commit(m, LONE_MD, el, meta);

			const edited =
				c.type === 'tableCell' ? `${c.slice}more ` : `${c.slice} more`;
			expect(next).toBe(replacedOnce(LONE_MD, c.slice, edited));
			expect(next).not.toContain('\\~');
		},
	);

	test('`~` だけの段落を何も変えずに確定 → 再レンダーで `~` の文字が出て取り消し線にならない(行頭の `~` は core の unsafe が `\\~` にすることがあるため byte 等価は求めない)', async () => {
		const m = await mount(LONE_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', '~');

		const next = commit(m, LONE_MD, el, meta);
		const again = await mount(next);

		expect(again.root.querySelectorAll('del')).toHaveLength(0);
		expect(textOf(again.root)).toBe(textOf(m.root));
		// 単独の `~` を `\~\~` のような2つ以上の形にはしない。
		expect(next).not.toContain('~~');
	});
});

// ===========================================================================
// AC-49-38(d) — 取り消し線そのものは従来どおり(AC-49-34 の回帰)
// ===========================================================================

/** 取り消し線を持つブロック(段落・密なリスト項目・表セル・見出し)。 */
const STRIKE_MD = [
	'# Title',
	'',
	'Para ~~del~~ x',
	'',
	'- item ~~a~~ b',
	'- other',
	'',
	'| A | B |',
	'| --- | --- |',
	'| ~~a1~~ | b1 |',
	'',
	'## Head ~~gone~~ here',
	'',
	'Tail.',
	'',
].join('\n');

const STRIKE_DELS = ['del', 'a', 'a1', 'gone'];

interface StrikeCase extends BlockCase {
	/** 末尾に " more" を足したときの期待スライス。 */
	edited: string;
	/** その `del` の表示文字列。 */
	del: string;
}

const STRIKE_CASES: StrikeCase[] = [
	{
		label: '段落',
		type: 'paragraph',
		slice: 'Para ~~del~~ x',
		edited: 'Para ~~del~~ x more',
		del: 'del',
	},
	{
		label: '密なリスト項目',
		type: 'listItem',
		slice: '- item ~~a~~ b',
		edited: '- item ~~a~~ b more',
		del: 'a',
	},
	{
		label: '表セル',
		type: 'tableCell',
		slice: '| ~~a1~~ ',
		edited: '| ~~a1~~ more ',
		del: 'a1',
	},
	{
		label: '見出し',
		type: 'heading',
		slice: '## Head ~~gone~~ here',
		edited: '## Head ~~gone~~ here more',
		del: 'gone',
	},
];

describe('serializeBlock — 取り消し線そのもの(`~~del~~`)は従来どおり(追補h / AC-49-38(d)=AC-49-34 の回帰)', () => {
	test.each(STRIKE_CASES)('(d) $label: 何も変えずに確定 → byte 等価', async (c) => {
		const m = await mount(STRIKE_MD);
		expect(delTexts(m.root)).toEqual(STRIKE_DELS);
		const { el, meta } = blockBySlice(m, c.type, c.slice);

		expect(commit(m, STRIKE_MD, el, meta)).toBe(STRIKE_MD);
	});

	test.each(STRIKE_CASES)(
		'(d) $label: 末尾に " more" を足して確定 → 取り消し線は `~~…~~` のまま(`\\~` にならない)・再レンダーで範囲と中身が同じ',
		async (c) => {
			const m = await mount(STRIKE_MD);
			const { el, meta } = blockBySlice(m, c.type, c.slice);
			appendAtEnd(el, ' more');

			const next = commit(m, STRIKE_MD, el, meta);

			expect(next).toBe(replacedOnce(STRIKE_MD, c.slice, c.edited));
			expect(next).toContain(`~~${c.del}~~`);
			expect(next).not.toContain('\\~');
			const again = await mount(next);
			expect(delTexts(again.root)).toEqual(STRIKE_DELS);
			expect(delHolders(again.root)).toEqual(delHolders(m.root));
		},
	);

	test('取り消し線の中の文字を直して確定 → `~~del more~~`(範囲が中の文字ごと保たれる・`\\~` にならない)', async () => {
		const m = await mount(STRIKE_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', 'Para ~~del~~ x');
		q(el, 'del').textContent = 'del more';

		const next = commit(m, STRIKE_MD, el, meta);

		expect(next).toBe(replacedOnce(STRIKE_MD, 'Para ~~del~~ x', 'Para ~~del more~~ x'));
		expect(delTexts((await mount(next)).root)).toEqual(['del more', 'a', 'a1', 'gone']);
	});

	test('取り消し線の隣に文字として " ~~x~~" を打って確定 → 取り消し線は `~~del~~` のまま・打った方は `\\~\\~x\\~\\~`・再レンダーの取り消し線は `del` だけ', async () => {
		const m = await mount(STRIKE_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', 'Para ~~del~~ x');
		appendAtEnd(el, ' ~~x~~');

		// コードから読んだ見立て(実装前): `Para ~~del~~ x ~~x~~` となり、再レンダーの取り消し線が2つになる。
		const next = commit(m, STRIKE_MD, el, meta);

		expect(next).toBe(replacedOnce(STRIKE_MD, 'Para ~~del~~ x', 'Para ~~del~~ x \\~\\~x\\~\\~'));
		const again = await mount(next);
		expect(delTexts(again.root)).toEqual(STRIKE_DELS);
		expect(textOf(again.root)).toContain('del x ~~x~~');
	});
});
