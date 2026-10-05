/**
 * 要件#49 追補g の受け入れテスト(docs/requirements/req-49.md「### 追補g」・AC-49-37)
 * — `resolveEditTarget` の判定部(unit 側)
 *
 * 追補g(2026-10-04・backlog 272・追補f(1) の拡張)= **直下のブロックが段落以外の1つだけ**の
 * リスト項目も、項目そのもの(`li`)を掴むと誘導する。追補f は「直下にブロックを2つ以上」を
 * 誘導したが、1つでも段落でなければ、逆シリアライズが中身を phrasing だけ取り出して1行に
 * 畳むので印(`#`・`>`・定義・フェンス)が戻らない(実測: `- # H` → `- H`・`- > q` → `- q`・
 * `- [x]: /u\n- b` → `- \n- b`・code fence だけの項目 → 中身がリストの外へ)。
 *
 * 判定は edit-redirect.acceptance.test.ts(追補f)と同じく本番パイプライン(`render`)の
 * HTML と `SourceIndex` を JSDOM に載せ、`resolveEditTarget` の返り値で見る。Viewer の配線は
 * src/components/Viewer.blockedit-redirect-single.wiring.test.ts。
 *
 * ## 判定するもの
 * - **AC-49-37(契約①③・追補g(1)・backlog 272)**: 見出しだけ(`- # H`)・引用だけ(`- > q`)・
 *   リンク参照の定義だけ(`- [x]: /u` に `- b` が続く形)・code fence だけ・表だけ・生 HTML だけ
 *   (`- <div>x</div>`)・子リストだけを持つ項目の外側(`- - a`)・区切り線だけ(`- ***`)の項目を、
 *   **項目そのもの**(`li`)で `resolveEditTarget` すると `source`。
 *   追補g(1) 本文が挙げる**脚注の定義だけ**の項目(`- [^1]: note`)も同じ(AC-49-37 の列挙には
 *   無いが (1) の列挙にある=「など」の範囲)。
 *   **中のブロックを直接**掴んだとき ―― 見出しの `h1`・引用の中の段落・表のセル ―― は従来どおり
 *   `block`。
 *   **回帰**: 段落1つの密な項目・段落1つの緩い項目・空の項目(`-`)・密/緩いタスク項目は
 *   従来どおり `block`(追補f(1)・AC-49-29・AC-49-35 の回帰)。
 *
 * ## 前提の固定(2026-10-04 観測)
 * - 生 HTML だけの項目 `- <div>x</div>` は、索引で listItem の直下に `html` ブロック1つを持つ
 *   (`<div>` 自体は `data-vellis-node-id` を持たないので、掴めるのは `li` だけ)
 * - リンク参照の定義だけの項目は DOM では空の `<li>` になるが、索引には `definition` が
 *   listItem の子として残る
 *
 * ## 判定しないもの
 * - 誘導後の Viewer の状態(editMode / editBuffer / dirty)→ wiring 側
 * - code fence だけの項目の `pre` の上(要件#52 の code 編集=`resolveFrozenRegion`)→ 既存
 * - `edit.ts` の SHA-256 固定(AC-53-11・AC-54-14・AC-60-20)→ 実装後に別途更新(追補g(3))
 */
import { describe, expect, test } from 'vitest';
import { render } from './renderer';
import { resolveEditTarget, type EditTarget } from './edit';
import type { NodeMeta, SourceIndex } from './types';

const baseUri = 'file:///home/user/notes/doc.md';

// ---------------------------------------------------------------------------
// フィクスチャ(edit-redirect.acceptance.test.ts の家風)
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

/** セレクタで要素を取得。無ければ理由付きで落とす。 */
function q(scope: ParentNode, selector: string): HTMLElement {
	const el = scope.querySelector(selector);
	if (!el) throw new Error(`要素が見つからない: ${selector}`);
	return el as HTMLElement;
}

function qa(scope: ParentNode, selector: string): HTMLElement[] {
	return [...scope.querySelectorAll(selector)] as HTMLElement[];
}

/** 原文スライスが `slice` に一致するブロック(type 指定)の meta を index から引く。 */
function metaBySlice(m: Mounted, type: string, slice: string): NodeMeta {
	for (const meta of m.index.byId.values()) {
		if (meta.type !== type) continue;
		if (m.index.sliceOf(meta.id) !== slice) continue;
		return meta;
	}
	throw new Error(`${type} ブロック ${JSON.stringify(slice)} が index に無い`);
}

/** 原文スライスが `slice` に一致するブロック(type 指定)を DOM と index から引く。 */
function blockBySlice(
	m: Mounted,
	type: string,
	slice: string,
): { el: HTMLElement; meta: NodeMeta } {
	const meta = metaBySlice(m, type, slice);
	return { el: q(m.root, `[data-vellis-node-id="${meta.id}"]`), meta };
}

/** リスト項目を原文スライスで引く。 */
function itemBySlice(m: Mounted, slice: string): HTMLElement {
	return blockBySlice(m, 'listItem', slice).el;
}

/** 段落を原文スライスで引く。 */
function paragraphBySlice(m: Mounted, slice: string): HTMLElement {
	return blockBySlice(m, 'paragraph', slice).el;
}

/** 索引で `parentBlockId` が `item` を指すブロックの type を列挙する(前提の確認用)。 */
function childBlockTypes(m: Mounted, item: HTMLElement): string[] {
	const id = item.getAttribute('data-vellis-node-id');
	const types: string[] = [];
	for (const meta of m.index.byId.values()) {
		if (meta.parentBlockId === id && meta.type !== 'text') types.push(meta.type);
	}
	return types;
}

function expectBlock(t: EditTarget, el: HTMLElement, type: string): void {
	expect(t.kind).toBe('block');
	if (t.kind !== 'block') return;
	expect(t.el).toBe(el);
	expect(t.meta.type).toBe(type);
	expect(t.meta.id).toBe(el.getAttribute('data-vellis-node-id'));
}

function expectSource(t: EditTarget): void {
	expect(t).toEqual({ kind: 'source' });
}

// ---------------------------------------------------------------------------
// 題材 ―― 直下のブロックが段落以外の1つだけの項目(追補g(1))
// ---------------------------------------------------------------------------

/** 見出しだけの項目(実測 `- # H` → `- H`)。 */
const HEADING_MD = '- # H\n';
const HEADING_ITEM = '- # H';
const HEADING_BLOCK = '# H';

/** 引用だけの項目(実測 `- > q` → `- q`)。 */
const QUOTE_MD = '- > q\n';
const QUOTE_ITEM = '- > q';
const QUOTE_PARA = 'q';

/** リンク参照の定義だけの項目(backlog 272 の再現 `- [x]: /u\n- b` → `- \n- b`)。 */
const DEF_MD = '- [x]: /u\n- b\n';
const DEF_ITEM = '- [x]: /u';
const DEF_SIBLING = '- b';

/** code fence だけの項目(実測: 中身が字下げを失ってリストの外へ出る)。 */
const FENCE_MD = '- ```js\n  x\n  ```\n';
const FENCE_ITEM = '- ```js\n  x\n  ```';

/** 表だけの項目。 */
const TABLE_MD = '- | A |\n  | - |\n  | 1 |\n';
const TABLE_ITEM = '- | A |\n  | - |\n  | 1 |';
const TABLE_HEAD_CELL = '| A |';
const TABLE_BODY_CELL = '| 1 |';

/** 生 HTML だけの項目(1行・複数行)。 */
const RAW_HTML_MD = '- <div>x</div>\n';
const RAW_HTML_ITEM = '- <div>x</div>';
const RAW_HTML_MULTI_MD = '- <div>\n  x\n  </div>\n';
const RAW_HTML_MULTI_ITEM = '- <div>\n  x\n  </div>';

/** 脚注の定義だけの項目(追補g(1) 本文の列挙)。定義の段落は脚注欄へ移り `<li>` は空になる。 */
const FOOTNOTE_DEF_MD = '- [^1]: note\n\nText[^1].\n';
const FOOTNOTE_DEF_ITEM = '- [^1]: note';

/** 子リストだけを持つ項目の外側(AC-49-37 の列挙。main では外側が block で、確定すると `- - a` → `- a` に潰れた)。 */
const NESTED_ONLY_MD = '- - a\n';
const NESTED_ONLY_OUTER = '- - a';
const NESTED_ONLY_INNER = '- a';

/** 区切り線だけの項目(AC-49-37 の列挙)。 */
const HR_MD = '- ***\n';
const HR_ITEM = '- ***';

// ---------------------------------------------------------------------------
// 前提の確認 ―― レンダー結果の DOM と索引(2026-10-04 観測を固定)
// ---------------------------------------------------------------------------

describe('AC-49-37 — レンダー結果の DOM と索引(前提の確認)', () => {
	test('見出しだけの項目: `<li>` の直下に `<h1>` があり、索引の直下の子は heading 1つ', async () => {
		const m = await mount(HEADING_MD);
		const li = itemBySlice(m, HEADING_ITEM);
		expect(qa(li, ':scope > h1[data-vellis-node-type="heading"]')).toHaveLength(1);
		expect(li.querySelector(':scope > p')).toBeNull();
		expect(childBlockTypes(m, li)).toEqual(['heading']);
	});

	test('引用だけの項目: `<li>` の直下に `<blockquote>`、索引の直下の子は blockquote 1つ', async () => {
		const m = await mount(QUOTE_MD);
		const li = itemBySlice(m, QUOTE_ITEM);
		expect(qa(li, ':scope > blockquote[data-vellis-node-type="blockquote"]')).toHaveLength(1);
		expect(childBlockTypes(m, li)).toEqual(['blockquote']);
	});

	test('リンク参照の定義だけの項目: DOM の `<li>` は空だが、索引の直下の子は definition 1つ', async () => {
		const m = await mount(DEF_MD);
		const li = itemBySlice(m, DEF_ITEM);
		expect(li.childNodes).toHaveLength(0);
		expect(childBlockTypes(m, li)).toEqual(['definition']);
		// 定義が成り立っている(2つ目の項目 `- b` は普通の項目)。
		expect(childBlockTypes(m, itemBySlice(m, DEF_SIBLING))).toEqual(['paragraph']);
	});

	test('code fence だけの項目: `<li>` の直下に `<pre>`、索引の直下の子は code 1つ', async () => {
		const m = await mount(FENCE_MD);
		const li = itemBySlice(m, FENCE_ITEM);
		expect(qa(li, ':scope > pre[data-vellis-node-type="code"]')).toHaveLength(1);
		expect(childBlockTypes(m, li)).toEqual(['code']);
	});

	test('表だけの項目: `<li>` の直下に `<table>`、索引の直下の子は table 1つ', async () => {
		const m = await mount(TABLE_MD);
		const li = itemBySlice(m, TABLE_ITEM);
		expect(qa(li, ':scope > table[data-vellis-node-type="table"]')).toHaveLength(1);
		expect(childBlockTypes(m, li)).toEqual(['table']);
	});

	test('生 HTML だけの項目 `- <div>x</div>`: レンダラは生 HTML ブロックとして扱う(索引の直下の子は html 1つ・`<div>` は id を持たない)', async () => {
		const m = await mount(RAW_HTML_MD);
		const li = itemBySlice(m, RAW_HTML_ITEM);
		expect(childBlockTypes(m, li)).toEqual(['html']);
		const div = q(li, ':scope > div');
		expect(div.textContent).toBe('x');
		expect(div.hasAttribute('data-vellis-node-id')).toBe(false);
		expect(li.querySelector(':scope > p')).toBeNull();
	});

	test('複数行の生 HTML だけの項目も同じく html 1つ', async () => {
		const m = await mount(RAW_HTML_MULTI_MD);
		const li = itemBySlice(m, RAW_HTML_MULTI_ITEM);
		expect(childBlockTypes(m, li)).toEqual(['html']);
	});

	test('脚注の定義だけの項目: DOM の `<li>` は空で、索引の直下の子は footnoteDefinition 1つ', async () => {
		const m = await mount(FOOTNOTE_DEF_MD);
		const li = itemBySlice(m, FOOTNOTE_DEF_ITEM);
		expect(li.childNodes).toHaveLength(0);
		expect(childBlockTypes(m, li)).toEqual(['footnoteDefinition']);
	});

	test('子リストだけを持つ項目 `- - a`: 外側の `<li>` の直下に `<ul>`、索引の直下の子は list 1つ(段落は無い)', async () => {
		const m = await mount(NESTED_ONLY_MD);
		const outer = itemBySlice(m, NESTED_ONLY_OUTER);
		const inner = itemBySlice(m, NESTED_ONLY_INNER);
		expect(outer.contains(inner)).toBe(true);
		expect(qa(outer, ':scope > ul[data-vellis-node-type="list"]')).toHaveLength(1);
		expect(outer.querySelector(':scope > p')).toBeNull();
		expect(childBlockTypes(m, outer)).toEqual(['list']);
		expect(childBlockTypes(m, inner)).toEqual(['paragraph']);
	});

	test('区切り線だけの項目 `- ***`: `<li>` の直下に `<hr>`、索引の直下の子は thematicBreak 1つ', async () => {
		const m = await mount(HR_MD);
		const li = itemBySlice(m, HR_ITEM);
		expect(qa(li, ':scope > hr[data-vellis-node-type="thematicBreak"]')).toHaveLength(1);
		expect(childBlockTypes(m, li)).toEqual(['thematicBreak']);
	});
});

// ---------------------------------------------------------------------------
// AC-49-37 — 項目そのもの(`li`)は source(契約①③・追補g(1))
// ---------------------------------------------------------------------------

describe('resolveEditTarget — 直下のブロックが段落以外の1つだけのリスト項目は、項目そのもので source(契約①③・追補g(1) / AC-49-37)', () => {
	const CASES: Array<[label: string, md: string, slice: string]> = [
		['見出しだけの項目 `- # H`', HEADING_MD, HEADING_ITEM],
		['引用だけの項目 `- > q`', QUOTE_MD, QUOTE_ITEM],
		['リンク参照の定義だけの項目 `- [x]: /u`(backlog 272 の再現)', DEF_MD, DEF_ITEM],
		['code fence だけの項目', FENCE_MD, FENCE_ITEM],
		['表だけの項目', TABLE_MD, TABLE_ITEM],
		['生 HTML だけの項目 `- <div>x</div>`', RAW_HTML_MD, RAW_HTML_ITEM],
		['複数行の生 HTML だけの項目', RAW_HTML_MULTI_MD, RAW_HTML_MULTI_ITEM],
		['脚注の定義だけの項目 `- [^1]: note`(追補g(1) 本文の列挙)', FOOTNOTE_DEF_MD, FOOTNOTE_DEF_ITEM],
	];

	test.each(CASES)('%s → source', async (_label, md, slice) => {
		const m = await mount(md);
		const li = itemBySlice(m, slice);
		expectSource(resolveEditTarget(li, m.index));
	});

	test('生 HTML だけの項目: id を持たない `<div>` の上から繰り上がっても source', async () => {
		const m = await mount(RAW_HTML_MD);
		const li = itemBySlice(m, RAW_HTML_ITEM);
		expectSource(resolveEditTarget(q(li, ':scope > div'), m.index));
	});

	test('子リストだけを持つ項目 `- - a`: 外側の `li` → source・内側の `li` は block(listItem)', async () => {
		const m = await mount(NESTED_ONLY_MD);
		expectSource(resolveEditTarget(itemBySlice(m, NESTED_ONLY_OUTER), m.index));
		const inner = itemBySlice(m, NESTED_ONLY_INNER);
		expectBlock(resolveEditTarget(inner, m.index), inner, 'listItem');
	});

	test('区切り線だけの項目 `- ***`: `li` → source(`hr` の上から繰り上がっても source)', async () => {
		const m = await mount(HR_MD);
		const li = itemBySlice(m, HR_ITEM);
		expectSource(resolveEditTarget(li, m.index));
		expectSource(resolveEditTarget(q(li, ':scope > hr'), m.index));
	});

	test('リンク参照の定義だけの項目に続く普通の項目 `- b` は block(誘導は定義の項目だけ)', async () => {
		const m = await mount(DEF_MD);
		const li = itemBySlice(m, DEF_SIBLING);
		expectBlock(resolveEditTarget(li, m.index), li, 'listItem');
	});

	test('段落以外の1つだけの項目が、段落1つの項目と同じリストに並んでいても、誘導はその項目だけ', async () => {
		const m = await mount('- a\n- # H\n- > q\n- b\n');
		expectSource(resolveEditTarget(itemBySlice(m, '- # H'), m.index));
		expectSource(resolveEditTarget(itemBySlice(m, '- > q'), m.index));
		for (const slice of ['- a', '- b']) {
			const li = itemBySlice(m, slice);
			expectBlock(resolveEditTarget(li, m.index), li, 'listItem');
		}
	});
});

// ---------------------------------------------------------------------------
// AC-49-37 — 中のブロックを直接掴んだときは従来どおり block
// ---------------------------------------------------------------------------

describe('resolveEditTarget — 中のブロックを直接掴んだときは従来どおり block(追補g(1) / AC-49-37)', () => {
	test('見出しだけの項目の `h1` → block(heading)', async () => {
		const m = await mount(HEADING_MD);
		const h1 = blockBySlice(m, 'heading', HEADING_BLOCK).el;
		expect(h1.tagName.toLowerCase()).toBe('h1');
		expectBlock(resolveEditTarget(h1, m.index), h1, 'heading');
	});

	test('引用だけの項目の中の段落 → block(paragraph)', async () => {
		const m = await mount(QUOTE_MD);
		const p = paragraphBySlice(m, QUOTE_PARA);
		expectBlock(resolveEditTarget(p, m.index), p, 'paragraph');
	});

	test('表だけの項目のセル(見出し行・本文行)→ block(tableCell)', async () => {
		const m = await mount(TABLE_MD);
		for (const slice of [TABLE_HEAD_CELL, TABLE_BODY_CELL]) {
			const cell = blockBySlice(m, 'tableCell', slice).el;
			expectBlock(resolveEditTarget(cell, m.index), cell, 'tableCell');
		}
	});
});

// ---------------------------------------------------------------------------
// AC-49-37 — 回帰: 段落1つの項目と空の項目は従来どおり block(追補f(1)・AC-49-29・35)
// ---------------------------------------------------------------------------

describe('resolveEditTarget — 回帰: 段落1つの項目・空の項目・タスク項目は block(追補g(1) / AC-49-37)', () => {
	test('段落1つの密な項目 `- a` / `- b` は block(listItem)', async () => {
		const m = await mount('- a\n- b\n');
		for (const slice of ['- a', '- b']) {
			const li = itemBySlice(m, slice);
			expect(li.querySelector(':scope > p')).toBeNull();
			expectBlock(resolveEditTarget(li, m.index), li, 'listItem');
		}
	});

	test('段落1つの緩い項目 `- a\\n\\n- b` は block(直下は `<p>` 1つ)', async () => {
		const m = await mount('- a\n\n- b\n');
		for (const slice of ['- a', '- b']) {
			const li = itemBySlice(m, slice);
			expect(qa(li, ':scope > p')).toHaveLength(1);
			expectBlock(resolveEditTarget(li, m.index), li, 'listItem');
		}
	});

	test('空の項目 `-` は block(直下のブロックが0)', async () => {
		const m = await mount('- a\n-\n- b\n');
		const empty = itemBySlice(m, '-');
		expect(empty.childNodes).toHaveLength(0);
		expectBlock(resolveEditTarget(empty, m.index), empty, 'listItem');
	});

	test('密なタスク項目 `- [ ] todo` / `- [x] done` は block(チェックボックスの上でも)', async () => {
		const m = await mount('- [ ] todo\n- [x] done\n');
		for (const slice of ['- [ ] todo', '- [x] done']) {
			const li = itemBySlice(m, slice);
			expectBlock(resolveEditTarget(li, m.index), li, 'listItem');
			expectBlock(resolveEditTarget(q(li, 'input[type="checkbox"]'), m.index), li, 'listItem');
		}
	});

	test('緩いタスク項目 `- [ ] todo\\n\\n- [x] done` は block', async () => {
		const m = await mount('- [ ] todo\n\n- [x] done\n');
		for (const slice of ['- [ ] todo', '- [x] done']) {
			const li = itemBySlice(m, slice);
			expectBlock(resolveEditTarget(li, m.index), li, 'listItem');
		}
	});
});
