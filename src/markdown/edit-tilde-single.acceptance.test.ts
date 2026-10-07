/**
 * 要件#49 追補i の受け入れテスト(docs/requirements/req-49.md「追補i」・backlog 298)
 * — 1本の `~` の対のエスケープ規則(unit)= AC-49-39
 *
 * src/markdown/edit-tilde.acceptance.test.ts(AC-49-38)は書き換えず、追補i 用に新設。
 * 家風は同じ: 本番パイプライン(`render`)の HTML を JSDOM に載せ、`SourceIndex` の
 * `NodeMeta` を引いて `serializeBlock` / `replaceRange` を直接呼ぶ(`originSlice` も
 * Viewer の `commitBlockEdit` と同じく `index.sliceOf(meta.id)` を渡す)。
 * Viewer の配線は判定しない(逆シリアライズの層の話)。
 *
 * ## 判定する契約と、実装に求める観測可能な振る舞い
 *
 * 追補h(2) は単独の `~` をエスケープしないが、GFM(remark-gfm の `singleTilde` 既定)は
 * 1本の `~` の対(`~x~`・`a~b~c`)も取り消し線にする。追補i(1): 書き戻した結果を本番と
 * 同じ構文規則で読み直し、`delete` が書き戻す前より**増えるときだけ**、本文の `~` を
 * すべて `\~` にして書き直す。増えなければ今の結果のまま(単独の `~` は `~` のまま)。
 *
 * - **AC-49-39(a)** 本文に文字として `~x~`・`a~b~c`(など1本の対を含むもの)を打って
 *   確定 → 再レンダーで取り消し線にならず、表示の文字が打った文字と同じ。段落・密な
 *   リスト項目・見出し(表セルは (d))。追補i(1) の規則どおり、そのブロックの `~` は
 *   すべて `\~` になる(`Tilde para \~x\~`・`Tilde para a\~b\~c`)。
 *   (コードから読んだ見立て・実装前: `~x~` のまま書き戻されて取り消し線になる=backlog 298)
 * - **AC-49-39(b)** 単独の `~` で取り消し線にならない原文(`約 ~5 分`・`a~b`・`~5 から
 *   ~10`)を無変更で確定 → byte 等価。追補h(2) の不変(実装前から緑=回帰の守り)。
 * - **AC-49-39(c)** 原文の1本の取り消し線(`a ~del~ b`)を無変更で確定 → 再レンダーで
 *   取り消し線の範囲と中身が同じ(`handleDelete` は `~~del~~` に揃えるので byte 等価は
 *   求めない=追補e(4) のとおり)。取り消し線の隣に文字として `~x~` を打っても、
 *   取り消し線の範囲は変わらず、打った方だけ `\~x\~` になる。
 * - **AC-49-39(d)** 表のセルの中の `~x~` も (a) と同じ。
 * - **AC-49-39(e)** AC-49-38 と既存の edit 系の受け入れテストは無改変で緑(このファイルは
 *   何も書き換えない。追補i(3) の SHA-256 固定 3 件=AC-53-11・AC-54-14・AC-60-20 は
 *   実装の後に別途更新)。
 *
 * ## 前提の実測(tasks/lessons.md「描画結果は実測してから書く」)
 *
 * 描画の前提は使い捨てのスクリプトでなく、このファイルの「前提の確認」ケースで固定する:
 * - (a) の打った文字(`~x~`・`a~b~c`・`a~~b~c~`)は、原文にそのまま書くと GFM で1本の
 *   取り消し線になる(=修正前は赤になる根拠)
 * - (b) の原文(`約 ~5 分`・`a~b`・`~5 から ~10`)は本番の `render` で取り消し線にならない
 * - AC-49-39(a) の例 `~~a~ b~` は、micromark-extension-gfm-strikethrough の規則を読む限り
 *   取り消し線にならない(`~~`(2本)は1本の閉じと長さが合わず、`a~ ` の `~` は後ろが
 *   空白で開きになれない)。(a) の「取り消し線になる文字」の例からは外し、代わりに
 *   `~~` と1本の対が混ざる `a~~b~c~`(`<del>c</del>` になる)を置いた。`~~a~ b~` は
 *   「追補h(1) の `\~\~` + 追補i(1) の増えなければそのまま」の守りとして固定する
 *
 * ## 判定しないもの
 * - ブロックの行頭の `~`(core の `mdast-util-to-markdown` の unsafe `atBreak` が `\~` に
 *   する=追補h より前からの書き出しの性質)。AC-49-38(c) と同じく byte 等価は求めず、
 *   再レンダーで `~` の文字が出ることだけを見る(`~5 から ~10` を段落の先頭に置いた形)。
 *   byte 等価は文中に置いた `所要 ~5 から ~10 分` などで固定する
 * - Viewer の配線(ダブルクリック→確定→editBuffer / dirty)
 */
import { describe, expect, test } from 'vitest';
import { render } from './renderer';
import { replaceRange, resolveEditTarget, serializeBlock } from './edit';
import type { NodeMeta, SourceIndex } from './types';

const baseUri = 'file:///home/user/notes/doc.md';

// ---------------------------------------------------------------------------
// フィクスチャ(edit-tilde.acceptance.test.ts の家風)
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
// 前提の確認 — (a) の打った文字は、原文にそのまま書くと GFM で1本の取り消し線になる
// ===========================================================================

/**
 * (a)(d) で打つ文字を、原文にそのまま(エスケープなしで)書いた文書。本番の `render`
 * が1本の `~` の対を取り消し線にすること(=修正前に赤になる根拠)をここで固定する。
 * 末尾の `~~a~ b~` は AC-49-39(a) の例だが、規則を読む限り取り消し線にならない見立て。
 */
const RAW_SINGLE_MD = [
	'# Title',
	'',
	'Tilde para ~x~',
	'',
	'Tilde para a~b~c',
	'',
	'Tilde para a~~b~c~',
	'',
	'- item x ~x~',
	'- other',
	'',
	'| A | B |',
	'| --- | --- |',
	'| plain cell ~x~ | b1 |',
	'',
	'## Head here ~x~',
	'',
	'Tilde para ~~a~ b~',
	'',
	'Tail.',
	'',
].join('\n');

describe('前提の確認 — 1本の `~` の対は本番の `render` で取り消し線になる(remark-gfm の singleTilde 既定)', () => {
	test('`~x~`・`a~b~c`・`a~~b~c~` と、リスト項目・表セル・見出しの `~x~` は、それぞれ1本の `del` になる', async () => {
		const m = await mount(RAW_SINGLE_MD);
		expect(delTexts(m.root)).toEqual(['x', 'b', 'c', 'x', 'x', 'x']);
		expect(delHolders(m.root)).toEqual([
			'paragraph',
			'paragraph',
			'paragraph',
			'listItem',
			'tableCell',
			'heading',
		]);
	});

	test('AC-49-39(a) の例 `~~a~ b~` は取り消し線にならない(2本の開きと1本の閉じは長さが合わず、`a~ ` の `~` は開きになれない)', async () => {
		const m = await mount(RAW_SINGLE_MD);
		const { el } = blockBySlice(m, 'paragraph', 'Tilde para ~~a~ b~');
		expect(el.querySelectorAll('del')).toHaveLength(0);
		expect(el.textContent).toBe('Tilde para ~~a~ b~');
	});
});

// ===========================================================================
// AC-49-39(a)(d) — 本文に文字として打った `~x~` は取り消し線にならない
// ===========================================================================

/** 取り消し線も `~` も含まないブロック4種(ここに `~x~` などを文字として打つ)。 */
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
	/** 末尾に打つ文字(先頭の空白込み)。 */
	typed: string;
	/** 打って確定したときの期待スライス(追補i(1): そのブロックの `~` はすべて `\~`)。 */
	expected: string;
}

const TYPED_SINGLE_CASES: TypedCase[] = [
	{
		label: '(a) 段落 `~x~`',
		type: 'paragraph',
		slice: 'Tilde para',
		typed: ' ~x~',
		expected: 'Tilde para \\~x\\~',
	},
	{
		label: '(a) 段落 `a~b~c`',
		type: 'paragraph',
		slice: 'Tilde para',
		typed: ' a~b~c',
		expected: 'Tilde para a\\~b\\~c',
	},
	{
		label: '(a) 段落 `a~~b~c~`(`~~` と1本の対が混ざる)',
		type: 'paragraph',
		slice: 'Tilde para',
		typed: ' a~~b~c~',
		expected: 'Tilde para a\\~\\~b\\~c\\~',
	},
	{
		label: '(a) 密なリスト項目 `~x~`',
		type: 'listItem',
		slice: '- item x',
		typed: ' ~x~',
		expected: '- item x \\~x\\~',
	},
	{
		label: '(d) 表セル `~x~`',
		type: 'tableCell',
		slice: '| plain cell ',
		typed: ' ~x~',
		expected: '| plain cell \\~x\\~ ',
	},
	{
		label: '(a) 見出し `~x~`',
		type: 'heading',
		slice: '## Head here',
		typed: ' ~x~',
		expected: '## Head here \\~x\\~',
	},
];

describe('前提の確認 — 取り消し線を含まない文書には `del` が無い', () => {
	test('PLAIN_MD の4ブロックは block で、`del` は 0', async () => {
		const m = await mount(PLAIN_MD);
		expect(m.root.querySelectorAll('del')).toHaveLength(0);
		for (const c of TYPED_SINGLE_CASES) {
			const { el } = blockBySlice(m, c.type, c.slice);
			expect(resolveEditTarget(el, m.index).kind).toBe('block');
		}
	});
});

describe('serializeBlock — 本文に文字として打った1本の `~` の対は `\\~` と書き戻し、取り消し線にならない(追補i(1) / AC-49-39(a)(d))', () => {
	test.each(TYPED_SINGLE_CASES)(
		'$label: 末尾に打って確定 → そのブロックの `~` はすべて `\\~`・他は byte 等価',
		async (c) => {
			const m = await mount(PLAIN_MD);
			const { el, meta } = blockBySlice(m, c.type, c.slice);
			appendAtEnd(el, c.typed);

			// コードから読んだ見立て(実装前): 単独の `~` はそのまま書き戻され、再レンダーで
			// 取り消し線になる(backlog 298)。
			const next = commit(m, PLAIN_MD, el, meta);

			expect(next).toBe(replacedOnce(PLAIN_MD, c.slice, c.expected));
		},
	);

	test.each(TYPED_SINGLE_CASES)(
		'$label: 確定後の原文を再レンダーしても取り消し線にならず、表示の文字が打った文字と同じ',
		async (c) => {
			const m = await mount(PLAIN_MD);
			const { el, meta } = blockBySlice(m, c.type, c.slice);
			appendAtEnd(el, c.typed);
			const next = commit(m, PLAIN_MD, el, meta);

			const again = await mount(next);

			expect(again.root.querySelectorAll('del')).toHaveLength(0);
			expect(textOf(again.root)).toContain(c.typed);
			// 利用者が見ていた確定前の DOM と同じ文字が出る(文字が消えない・増えない)。
			expect(textOf(again.root)).toBe(textOf(m.root));
		},
	);

	test('(a) 段落 `~~a~ b~`(取り消し線を生まない形): 打って確定 → `~~` だけ `\\~\\~`(追補h(1))・単独の `~` はそのまま(追補i(1) の「増えなければ今の結果のまま」)・再レンダーで取り消し線にならない', async () => {
		const m = await mount(PLAIN_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', 'Tilde para');
		appendAtEnd(el, ' ~~a~ b~');

		const next = commit(m, PLAIN_MD, el, meta);

		expect(next).toBe(replacedOnce(PLAIN_MD, 'Tilde para', 'Tilde para \\~\\~a~ b~'));
		const again = await mount(next);
		expect(again.root.querySelectorAll('del')).toHaveLength(0);
		expect(textOf(again.root)).toBe(textOf(m.root));
	});
});

// ===========================================================================
// AC-49-39(b) — 単独の `~` で取り消し線にならない原文は無変更の確定で byte 等価
// ===========================================================================

/**
 * 単独の `~` を含むが取り消し線にならないブロック。AC の例 3 つ(段落)と、
 * `~5 から ~10` を文中・密なリスト項目・表セル・見出しに置いた形。
 * `~5 から ~10` を段落の先頭に置いた形は、行頭の `~` が core の `atBreak` で
 * `\~` になりうるので byte 等価は求めない(「判定しないもの」)。
 */
const LONE_MD = [
	'# Title',
	'',
	'約 ~5 分',
	'',
	'a~b',
	'',
	'~5 から ~10',
	'',
	'所要 ~5 から ~10 分',
	'',
	'- item ~5 から ~10',
	'- other',
	'',
	'| A | B |',
	'| --- | --- |',
	'| c~d | b1 |',
	'',
	'## Head ~5 から ~10',
	'',
	'Tail.',
	'',
].join('\n');

/** LONE_MD に含まれる `~` の数(1+1+2+2+2+1+2)。 */
const LONE_TILDES = 11;

/** byte 等価を求めるケース(行頭に `~` が無い)。 */
const LONE_CASES: BlockCase[] = [
	{ label: '段落 `約 ~5 分`', type: 'paragraph', slice: '約 ~5 分' },
	{ label: '段落 `a~b`', type: 'paragraph', slice: 'a~b' },
	{ label: '段落 `所要 ~5 から ~10 分`', type: 'paragraph', slice: '所要 ~5 から ~10 分' },
	{ label: '密なリスト項目 `- item ~5 から ~10`', type: 'listItem', slice: '- item ~5 から ~10' },
	{ label: '表セル `| c~d |`', type: 'tableCell', slice: '| c~d ' },
	{ label: '見出し `## Head ~5 から ~10`', type: 'heading', slice: '## Head ~5 から ~10' },
];

describe('前提の確認 — (b) の原文は本番の `render` で取り消し線にならない(AC-49-39(b) の実測)', () => {
	test('LONE_MD に `del` は無く、`~` の文字が原文の数だけ出る', async () => {
		const m = await mount(LONE_MD);
		expect(m.root.querySelectorAll('del')).toHaveLength(0);
		expect(textOf(m.root).match(/~/g)).toHaveLength(LONE_TILDES);
		for (const c of LONE_CASES) {
			const { el } = blockBySlice(m, c.type, c.slice);
			expect(resolveEditTarget(el, m.index).kind).toBe('block');
		}
		expect(
			resolveEditTarget(blockBySlice(m, 'paragraph', '~5 から ~10').el, m.index).kind,
		).toBe('block');
	});

	test.each([
		{ label: '`約 ~5 分`', slice: '約 ~5 分', text: '約 ~5 分' },
		{ label: '`a~b`', slice: 'a~b', text: 'a~b' },
		{ label: '`~5 から ~10`', slice: '~5 から ~10', text: '~5 から ~10' },
	])('AC の例 $label は `del` を含まず、文字がそのまま出る', async (c) => {
		const m = await mount(LONE_MD);
		const { el } = blockBySlice(m, 'paragraph', c.slice);
		expect(el.querySelectorAll('del')).toHaveLength(0);
		expect(el.textContent).toBe(c.text);
	});
});

describe('serializeBlock — 単独の `~` で取り消し線にならない原文は無変更の確定で byte 等価(追補h(2)・追補i(1) / AC-49-39(b))', () => {
	test.each(LONE_CASES)('(b) $label: 何も変えずに確定 → byte 等価(`\\~` にならない)', async (c) => {
		const m = await mount(LONE_MD);
		const { el, meta } = blockBySlice(m, c.type, c.slice);

		const next = commit(m, LONE_MD, el, meta);

		expect(next).toBe(LONE_MD);
		expect(next).not.toContain('\\~');
	});

	test('(b) 段落 `~5 から ~10`(行頭の `~`): 何も変えずに確定 → 再レンダーで取り消し線にならず文字が同じ(行頭の `~` は core の atBreak が `\\~` にしうるので byte 等価は求めない)', async () => {
		const m = await mount(LONE_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', '~5 から ~10');

		const next = commit(m, LONE_MD, el, meta);
		const again = await mount(next);

		expect(again.root.querySelectorAll('del')).toHaveLength(0);
		expect(textOf(again.root)).toBe(textOf(m.root));
		// 単独の `~` を `~~` のような2つ以上の形にはしない。
		expect(next).not.toContain('~~');
	});

	test('(a) 単独の `~` を持つ段落 `約 ~5 分` の末尾に " ~x~" を打って確定 → そのブロックの `~` はすべて `\\~`(`約 \\~5 分 \\~x\\~`)・再レンダーで取り消し線にならず文字が同じ', async () => {
		const m = await mount(LONE_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', '約 ~5 分');
		appendAtEnd(el, ' ~x~');

		// コードから読んだ見立て(実装前): `約 ~5 分 ~x~` となり、再レンダーで `x` が取り消し線になる。
		const next = commit(m, LONE_MD, el, meta);

		expect(next).toBe(replacedOnce(LONE_MD, '約 ~5 分', '約 \\~5 分 \\~x\\~'));
		const again = await mount(next);
		expect(again.root.querySelectorAll('del')).toHaveLength(0);
		expect(textOf(again.root)).toBe(textOf(m.root));
	});
});

// ===========================================================================
// AC-49-39(c) — 原文の1本の取り消し線は無変更の確定で範囲と中身が同じ
// ===========================================================================

/** 1本の `~` の対で書いた取り消し線を持つブロック(段落・密なリスト項目・表セル・見出し)。 */
const SINGLE_STRIKE_MD = [
	'# Title',
	'',
	'a ~del~ b',
	'',
	'- item ~a~ b',
	'- other',
	'',
	'| A | B |',
	'| --- | --- |',
	'| ~a1~ | b1 |',
	'',
	'## Head ~gone~ here',
	'',
	'Tail.',
	'',
].join('\n');

const SINGLE_STRIKE_DELS = ['del', 'a', 'a1', 'gone'];
const SINGLE_STRIKE_HOLDERS = ['paragraph', 'listItem', 'tableCell', 'heading'];

const SINGLE_STRIKE_CASES: BlockCase[] = [
	{ label: '段落 `a ~del~ b`', type: 'paragraph', slice: 'a ~del~ b' },
	{ label: '密なリスト項目 `- item ~a~ b`', type: 'listItem', slice: '- item ~a~ b' },
	{ label: '表セル `| ~a1~ |`', type: 'tableCell', slice: '| ~a1~ ' },
	{ label: '見出し `## Head ~gone~ here`', type: 'heading', slice: '## Head ~gone~ here' },
];

describe('前提の確認 — 1本の `~` の対で書いた取り消し線は本番の `render` で `del` になる', () => {
	test('SINGLE_STRIKE_MD の `del` は4つで、中身と持ち主が原文どおり', async () => {
		const m = await mount(SINGLE_STRIKE_MD);
		expect(delTexts(m.root)).toEqual(SINGLE_STRIKE_DELS);
		expect(delHolders(m.root)).toEqual(SINGLE_STRIKE_HOLDERS);
		for (const c of SINGLE_STRIKE_CASES) {
			const { el } = blockBySlice(m, c.type, c.slice);
			expect(resolveEditTarget(el, m.index).kind).toBe('block');
		}
	});
});

describe('serializeBlock — 原文の1本の取り消し線は無変更の確定で範囲と中身が同じ(追補i(4) / AC-49-39(c))', () => {
	test.each(SINGLE_STRIKE_CASES)(
		'(c) $label: 何も変えずに確定 → 再レンダーの取り消し線の範囲と中身が確定前と同じ(`~~` に揃えてよい=意味等価)',
		async (c) => {
			const m = await mount(SINGLE_STRIKE_MD);
			const { el, meta } = blockBySlice(m, c.type, c.slice);

			const next = commit(m, SINGLE_STRIKE_MD, el, meta);
			const again = await mount(next);

			expect(delTexts(again.root)).toEqual(SINGLE_STRIKE_DELS);
			expect(delHolders(again.root)).toEqual(SINGLE_STRIKE_HOLDERS);
			await expectSameRender(next, SINGLE_STRIKE_MD);
			expect(textOf(again.root)).toBe(textOf(m.root));
			// 取り消し線そのものの印はエスケープされない(追補i(4): `handleDelete` は不変)。
			expect(next).not.toContain('\\~');
		},
	);

	test('(c) 段落 `a ~del~ b` の末尾に " more" を足して確定 → 取り消し線の範囲と中身は同じ・`\\~` にならない', async () => {
		const m = await mount(SINGLE_STRIKE_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', 'a ~del~ b');
		appendAtEnd(el, ' more');

		const next = commit(m, SINGLE_STRIKE_MD, el, meta);
		const again = await mount(next);

		expect(delTexts(again.root)).toEqual(SINGLE_STRIKE_DELS);
		expect(delHolders(again.root)).toEqual(SINGLE_STRIKE_HOLDERS);
		expect(textOf(again.root)).toBe(textOf(m.root));
		expect(next).not.toContain('\\~');
	});

	test('(c)+(a) 取り消し線 `a ~del~ b` の隣に文字として " ~x~" を打って確定 → 取り消し線は `~~del~~` のまま・打った方は `\\~x\\~`・再レンダーの取り消し線は `del` だけ', async () => {
		const m = await mount(SINGLE_STRIKE_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', 'a ~del~ b');
		appendAtEnd(el, ' ~x~');

		// コードから読んだ見立て(実装前): `a ~~del~~ b ~x~` となり、再レンダーの取り消し線が2つになる。
		const next = commit(m, SINGLE_STRIKE_MD, el, meta);

		expect(next).toBe(replacedOnce(SINGLE_STRIKE_MD, 'a ~del~ b', 'a ~~del~~ b \\~x\\~'));
		const again = await mount(next);
		expect(delTexts(again.root)).toEqual(SINGLE_STRIKE_DELS);
		expect(delHolders(again.root)).toEqual(SINGLE_STRIKE_HOLDERS);
		expect(textOf(again.root)).toContain('a del b ~x~');
		expect(textOf(again.root)).toBe(textOf(m.root));
	});
});
