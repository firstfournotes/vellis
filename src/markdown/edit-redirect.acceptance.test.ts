/**
 * 要件#49 追補f の受け入れテスト(docs/requirements/req-49.md「### 追補f」・AC-49-35〜36)
 * — `resolveEditTarget` の判定部(unit 側)
 *
 * 追補f(2026-10-04・backlog 148・256・契約①③の改訂)= **逆シリアライズで戻せない形は
 * 編集させずに誘導する**。判定は edit.acceptance.test.ts と同じく本番パイプライン
 * (`render`)の HTML と `SourceIndex` を JSDOM に載せ、`resolveEditTarget` の返り値で見る。
 * Viewer の配線(ダブルクリック→ソース編集モード)は
 * src/components/Viewer.blockedit-redirect.wiring.test.ts。
 *
 * ## 判定するもの
 * - **AC-49-35(契約①③・追補f(1)(3)・backlog 148)**: **直下にブロックを2つ以上持つ
 *   リスト項目**は `source` ―― 子リストを持つ項目の親(`- parent\n  - child`)・タスク項目の
 *   親(`- [ ] todo\n  - child`)・2段落の緩い項目(`- first\n\n  second`)・段落と子リストの
 *   緩い項目(`- a\n\n  - b`)・段落に code fence / 引用 / 表が続く項目・引用の中の入れ子リスト
 *   の外側。項目の中の inline 要素の上から繰り上がっても同じ。
 *   **境界の非退行**: 子の項目・項目の中の各段落・密な項目・段落1つの緩い項目(`- a\n\n- b`)・
 *   空の項目(`-`)は従来どおり `block`。タスク項目の
 *   チェックボックスは段落の一部でブロックとして数えない(密なタスク項目は `block`)。
 *   **追補g(2) による改訂(2026-10-04・backlog 272・由谷承認)**: 追補f 当時は「見出しだけの
 *   項目(`- # H`)は従来どおり `block`」と固定していたが、追補g(1) で直下のブロックが段落以外の
 *   1つだけの項目も誘導するため、**項目そのものは `source`・中の `h1` は `block`** に書き換えた
 *   (AC-49-35 の本文は当時のまま。網羅は edit-redirect-single.acceptance.test.ts / AC-49-37)
 * - **AC-49-36(契約③・追補f(2)(3)・backlog 256)**: Vellis のレンダラが出す脚注欄
 *   (`section[data-footnotes]`)の中のブロック ―― 定義 `[^1]: First note.` の段落・複数段落の
 *   定義の各段落(戻りリンク `↩` を持たない段落も)・定義の中のリスト項目 ―― は `source`。
 *   本文の脚注参照を含む段落は従来どおり `block`(AC-49-30 の回帰)。
 *   **生 HTML で書いた `<div class="footnotes">` の中の段落は従来どおり**=現状の判定を観測
 *   して固定する(2026-10-04 観測: rehype-raw 由来の `<div>` の中でも Markdown の段落は
 *   `data-vellis-node-id` を持ち `parentBlockId === null` なので `block`)
 *
 * ## 判定しないもの
 * - 誘導後の Viewer の状態(editMode / editBuffer / dirty)→ wiring 側
 * - `edit.ts` の SHA-256 固定(AC-53-11・AC-54-14・AC-60-20)→ 実装後に別途更新(追補f(5))
 */
import { describe, expect, test } from 'vitest';
import { render } from './renderer';
import { resolveEditTarget, type EditTarget } from './edit';
import type { NodeMeta, SourceIndex } from './types';

const baseUri = 'file:///home/user/notes/doc.md';

// ---------------------------------------------------------------------------
// フィクスチャ(edit.acceptance.test.ts の家風)
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
	throw new Error(`${type} ブロック ${JSON.stringify(slice)} が index に無い`);
}

/** リスト項目を原文スライスで引く。 */
function itemBySlice(m: Mounted, slice: string): HTMLElement {
	return blockBySlice(m, 'listItem', slice).el;
}

/** 段落を原文スライスで引く。 */
function paragraphBySlice(m: Mounted, slice: string): HTMLElement {
	return blockBySlice(m, 'paragraph', slice).el;
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
// AC-49-35 — 複数のブロックを持つリスト項目は誘導する(契約①③・追補f(1))
// ---------------------------------------------------------------------------

/** 子リストを持つ項目の親(backlog 148 の再現 `- parent\n  - child`)。 */
const NESTED_MD = '- parent\n  - child\n';
const NESTED_PARENT = '- parent\n  - child';
const NESTED_CHILD = '- child';

/** タスク項目の親。チェックボックスは段落の一部で、ブロックとしては数えない。 */
const TASK_PARENT_MD = '- [ ] todo\n  - child\n';
const TASK_PARENT = '- [ ] todo\n  - child';

/** 2段落の緩い項目(backlog 148 の再現 `- first\n\n  second`)。 */
const LOOSE_TWO_MD = '- first\n\n  second\n';
const LOOSE_TWO = '- first\n\n  second';

/** 段落と子リストの緩い項目。 */
const LOOSE_LIST_MD = '- a\n\n  - b\n';
const LOOSE_LIST = '- a\n\n  - b';

/** 段落に code fence が続く項目。 */
const FENCE_MD = '- lead\n\n  ```js\n  x\n  ```\n';
const FENCE_ITEM = '- lead\n\n  ```js\n  x\n  ```';

/** 段落に引用が続く項目。 */
const QUOTE_MD = '- lead\n\n  > q\n';
const QUOTE_ITEM = '- lead\n\n  > q';

/** 段落に表が続く項目。 */
const TABLE_MD = '- lead\n\n  | A |\n  | - |\n  | 1 |\n';
const TABLE_ITEM = '- lead\n\n  | A |\n  | - |\n  | 1 |';

/** 引用の中の入れ子リスト(外側の項目のスライスは `> ` の継続を含む)。 */
const QUOTED_NESTED_MD = '> - outer\n>   - inner\n';
const QUOTED_OUTER = '- outer\n>   - inner';
const QUOTED_INNER = '- inner';

/** 項目の中の inline 要素(密な親の `<strong>` は `<li>` の直下に出る)。 */
const INLINE_PARENT_MD = '- **bold** parent\n  - child\n';
const INLINE_PARENT = '- **bold** parent\n  - child';

describe('AC-49-35 — レンダー結果の DOM(前提の確認)', () => {
	test('子リストを持つ親は `<li>` の直下にテキストと `<ul>` を持ち、親の中に子 `<li>` がある', async () => {
		const m = await mount(NESTED_MD);
		const parent = itemBySlice(m, NESTED_PARENT);
		const child = itemBySlice(m, NESTED_CHILD);
		expect(parent.contains(child)).toBe(true);
		expect(parent.querySelector(':scope > ul')).not.toBeNull();
		// 密な項目なので親の段落は `<p>` にならずテキストのまま(= ダブルクリックの target は `<li>`)。
		expect(parent.querySelector(':scope > p')).toBeNull();
	});

	test('2段落の緩い項目は `<li>` の直下に `<p>` を2つ持つ', async () => {
		const m = await mount(LOOSE_TWO_MD);
		const li = itemBySlice(m, LOOSE_TWO);
		expect(qa(li, ':scope > p[data-vellis-node-type="paragraph"]')).toHaveLength(2);
	});
});

describe('resolveEditTarget — 直下にブロックを2つ以上持つリスト項目は source(契約①③・追補f(1) / AC-49-35)', () => {
	const CASES: Array<[label: string, md: string, slice: string]> = [
		['子リストを持つ項目の親 `- parent\\n  - child`', NESTED_MD, NESTED_PARENT],
		['タスク項目の親 `- [ ] todo\\n  - child`', TASK_PARENT_MD, TASK_PARENT],
		['2段落の緩い項目 `- first\\n\\n  second`', LOOSE_TWO_MD, LOOSE_TWO],
		['段落と子リストの緩い項目 `- a\\n\\n  - b`', LOOSE_LIST_MD, LOOSE_LIST],
		['段落に code fence が続く項目', FENCE_MD, FENCE_ITEM],
		['段落に引用が続く項目', QUOTE_MD, QUOTE_ITEM],
		['段落に表が続く項目', TABLE_MD, TABLE_ITEM],
		['引用の中の入れ子リストの外側', QUOTED_NESTED_MD, QUOTED_OUTER],
	];

	test.each(CASES)('%s → source', async (_label, md, slice) => {
		const m = await mount(md);
		const li = itemBySlice(m, slice);
		expectSource(resolveEditTarget(li, m.index));
	});

	test('項目の中の inline 要素(<strong>)の上から繰り上がっても、親が複数ブロックなら source', async () => {
		const m = await mount(INLINE_PARENT_MD);
		const parent = itemBySlice(m, INLINE_PARENT);
		const strong = q(parent, ':scope > strong');
		expectSource(resolveEditTarget(strong, m.index));
	});

	test('タスク項目の親: チェックボックス(<input>)の上でも source', async () => {
		const m = await mount(TASK_PARENT_MD);
		const parent = itemBySlice(m, TASK_PARENT);
		const checkbox = q(parent, ':scope > input[type="checkbox"]');
		expectSource(resolveEditTarget(checkbox, m.index));
	});
});

describe('resolveEditTarget — 境界の非退行: 直下のブロックが1つ以下の項目と、項目の中のブロックは block(追補f(1) / AC-49-35)', () => {
	test('子の項目 `- child` は block(listItem)', async () => {
		const m = await mount(NESTED_MD);
		const child = itemBySlice(m, NESTED_CHILD);
		expectBlock(resolveEditTarget(child, m.index), child, 'listItem');
	});

	test('タスク項目の親の子 `- child` も block', async () => {
		const m = await mount(TASK_PARENT_MD);
		const child = itemBySlice(m, '- child');
		expectBlock(resolveEditTarget(child, m.index), child, 'listItem');
	});

	test('2段落の緩い項目の中の各段落は block(paragraph)', async () => {
		const m = await mount(LOOSE_TWO_MD);
		for (const slice of ['first', 'second']) {
			const p = paragraphBySlice(m, slice);
			expectBlock(resolveEditTarget(p, m.index), p, 'paragraph');
		}
	});

	test('段落と子リストの緩い項目: 中の段落と子の項目は block', async () => {
		const m = await mount(LOOSE_LIST_MD);
		const p = paragraphBySlice(m, 'a');
		expectBlock(resolveEditTarget(p, m.index), p, 'paragraph');
		const child = itemBySlice(m, '- b');
		expectBlock(resolveEditTarget(child, m.index), child, 'listItem');
	});

	test('段落に引用が続く項目: 先頭の段落と引用段落は block', async () => {
		const m = await mount(QUOTE_MD);
		const lead = paragraphBySlice(m, 'lead');
		expectBlock(resolveEditTarget(lead, m.index), lead, 'paragraph');
		const quoted = paragraphBySlice(m, 'q');
		expectBlock(resolveEditTarget(quoted, m.index), quoted, 'paragraph');
	});

	test('引用の中の入れ子リストの内側 `- inner` は block', async () => {
		const m = await mount(QUOTED_NESTED_MD);
		const inner = itemBySlice(m, QUOTED_INNER);
		expectBlock(resolveEditTarget(inner, m.index), inner, 'listItem');
	});

	test('密な項目 `- a` / `- b` は block', async () => {
		const m = await mount('- a\n- b\n');
		for (const slice of ['- a', '- b']) {
			const li = itemBySlice(m, slice);
			expectBlock(resolveEditTarget(li, m.index), li, 'listItem');
		}
	});

	test('密なタスク項目 `- [ ] todo` / `- [x] done` は block(チェックボックスはブロックとして数えない)', async () => {
		const m = await mount('- [ ] todo\n- [x] done\n');
		for (const slice of ['- [ ] todo', '- [x] done']) {
			const li = itemBySlice(m, slice);
			expectBlock(resolveEditTarget(li, m.index), li, 'listItem');
			expectBlock(resolveEditTarget(q(li, 'input[type="checkbox"]'), m.index), li, 'listItem');
		}
	});

	test('段落1つの緩い項目 `- a\\n\\n- b` は block(緩さだけでは誘導しない)', async () => {
		const m = await mount('- a\n\n- b\n');
		for (const slice of ['- a', '- b']) {
			const li = itemBySlice(m, slice);
			expect(qa(li, ':scope > p')).toHaveLength(1);
			expectBlock(resolveEditTarget(li, m.index), li, 'listItem');
		}
	});

	test('見出しだけの項目 `- # H`: 項目そのものは source・中の h1 は block(heading)(追補g(2) で改訂=backlog 272。追補f 当時は項目も block だった)', async () => {
		const m = await mount('- # H\n');
		const li = itemBySlice(m, '- # H');
		// 追補g(1): 直下のブロックが段落以外の1つだけ(heading)なので、項目そのものは誘導する。
		expectSource(resolveEditTarget(li, m.index));
		const h1 = q(li, 'h1[data-vellis-node-type="heading"]');
		expectBlock(resolveEditTarget(h1, m.index), h1, 'heading');
	});

	test('空の項目 `-` は block', async () => {
		const m = await mount('- a\n-\n- b\n');
		const empty = itemBySlice(m, '-');
		expect(empty.childNodes).toHaveLength(0);
		expectBlock(resolveEditTarget(empty, m.index), empty, 'listItem');
	});

	test('引用の中の密な項目(入れ子なし)は block', async () => {
		const m = await mount('> - only\n');
		const li = itemBySlice(m, '- only');
		expectBlock(resolveEditTarget(li, m.index), li, 'listItem');
	});
});

// ---------------------------------------------------------------------------
// AC-49-36 — 脚注の定義の中は誘導する(契約③・追補f(2))
// ---------------------------------------------------------------------------

/** backlog 256 の再現。 */
const FN_MD = 'Text[^1].\n\n[^1]: First note.\n';
const FN_BODY = 'Text[^1].';
const FN_DEF_PARA = 'First note.';

/** 複数段落の定義 ―― 戻りリンク `↩` は最後の段落にだけ付く。 */
const FN_MULTI_MD = 'Text[^1].\n\n[^1]: First para.\n\n    Second para.\n';
const FN_MULTI_FIRST = 'First para.';
const FN_MULTI_SECOND = 'Second para.';

/** 定義の中のリスト ―― 戻りリンクは `<li>` の直下に単独で付く。 */
const FN_LIST_MD = 'Text[^1].\n\n[^1]: Note.\n\n    - item one\n    - item two\n';
const FN_LIST_PARA = 'Note.';

/** 生 HTML で書いた `<div class="footnotes">`(Vellis のレンダラが出す脚注欄ではない)。 */
const RAW_FOOTNOTES_MD = 'Intro.\n\n<div class="footnotes">\n\nRaw note para.\n\n</div>\n';
const RAW_FOOTNOTES_PARA = 'Raw note para.';

/** 生 HTML で書いた `<section data-footnotes>`(追補f(2) 本文)。2026-10-04 観測: sanitize 後も
 * `data-footnotes` と `class="footnotes"` が残り、DOM の見た目は GFM の脚注欄と同じになる。
 * 中の段落は `data-vellis-node-id` を持ち `parentBlockId === null`(footnoteDefinition の子ではない)。 */
const RAW_SECTION_MD =
	'Intro.\n\n<section data-footnotes class="footnotes">\n\nRaw section para.\n\n</section>\n';
const RAW_SECTION_PARA = 'Raw section para.';

const FOOTNOTES_SECTION = 'section[data-footnotes]';
const BACKREF = 'a[data-footnote-backref]';

/** 脚注欄(`section[data-footnotes]`)の中のリスト項目。 */
function footnoteItems(m: Mounted): HTMLElement[] {
	return qa(q(m.root, FOOTNOTES_SECTION), 'li[data-vellis-node-type="listItem"]');
}

describe('AC-49-36 — レンダー結果の DOM(前提の確認)', () => {
	test('定義の段落は `section[data-footnotes]` の中にあり、id を持ち、戻りリンクを含む', async () => {
		const m = await mount(FN_MD);
		const p = paragraphBySlice(m, FN_DEF_PARA);
		expect(p.closest(FOOTNOTES_SECTION)).not.toBeNull();
		const backref = q(p, BACKREF);
		expect(backref.getAttribute('href')).toMatch(/^#user-content-fnref-/);
	});

	test('複数段落の定義: 最初の段落は戻りリンクを持たず、最後の段落だけが持つ', async () => {
		const m = await mount(FN_MULTI_MD);
		const first = paragraphBySlice(m, FN_MULTI_FIRST);
		const second = paragraphBySlice(m, FN_MULTI_SECOND);
		expect(first.closest(FOOTNOTES_SECTION)).not.toBeNull();
		expect(first.querySelector(BACKREF)).toBeNull();
		expect(second.querySelector(BACKREF)).not.toBeNull();
	});

	test('定義の中のリスト: 項目は脚注欄の中にあり、戻りリンクは項目の外に出る', async () => {
		const m = await mount(FN_LIST_MD);
		const items = footnoteItems(m);
		expect(items).toHaveLength(2);
		for (const li of items) expect(li.querySelector(BACKREF)).toBeNull();
		expect(q(m.root, FOOTNOTES_SECTION).querySelector(BACKREF)).not.toBeNull();
	});

	test('生 HTML の `<div class="footnotes">` は Vellis の脚注欄ではない(`data-footnotes` を持たない)', async () => {
		const m = await mount(RAW_FOOTNOTES_MD);
		expect(m.root.querySelector(FOOTNOTES_SECTION)).toBeNull();
		const p = paragraphBySlice(m, RAW_FOOTNOTES_PARA);
		expect(p.closest('div.footnotes')).not.toBeNull();
	});
});

describe('resolveEditTarget — 脚注の定義の中のブロックは source(契約③・追補f(2) / AC-49-36)', () => {
	test('backlog 256 の再現: 定義 `[^1]: First note.` の段落 → source', async () => {
		const m = await mount(FN_MD);
		const p = paragraphBySlice(m, FN_DEF_PARA);
		expectSource(resolveEditTarget(p, m.index));
	});

	test('定義の段落の中の戻りリンク(`a[data-footnote-backref]`)の上でも source', async () => {
		const m = await mount(FN_MD);
		const p = paragraphBySlice(m, FN_DEF_PARA);
		expectSource(resolveEditTarget(q(p, BACKREF), m.index));
	});

	test('複数段落の定義: 戻りリンクを持たない最初の段落も、持つ最後の段落も source', async () => {
		const m = await mount(FN_MULTI_MD);
		expectSource(resolveEditTarget(paragraphBySlice(m, FN_MULTI_FIRST), m.index));
		expectSource(resolveEditTarget(paragraphBySlice(m, FN_MULTI_SECOND), m.index));
	});

	test('定義の中のリスト項目(戻りリンクを含まない)→ source・定義の先頭の段落も source', async () => {
		const m = await mount(FN_LIST_MD);
		for (const li of footnoteItems(m)) expectSource(resolveEditTarget(li, m.index));
		expectSource(resolveEditTarget(paragraphBySlice(m, FN_LIST_PARA), m.index));
	});
});

describe('resolveEditTarget — 脚注の本文側と生 HTML の脚注欄は従来どおり(追補f(2) / AC-49-36)', () => {
	test('本文の脚注参照を含む段落は block(AC-49-30 の回帰)', async () => {
		const m = await mount(FN_MD);
		const p = paragraphBySlice(m, FN_BODY);
		expectBlock(resolveEditTarget(p, m.index), p, 'paragraph');
		// 脚注参照のリンクの上でも、その段落へ繰り上がる。
		const ref = q(p, 'sup[data-vellis-node-type="footnoteReference"] a');
		expectBlock(resolveEditTarget(ref, m.index), p, 'paragraph');
	});

	test('生 HTML で書いた `<div class="footnotes">` の中の段落は従来どおり block(2026-10-04 の観測を固定)', async () => {
		const m = await mount(RAW_FOOTNOTES_MD);
		const p = paragraphBySlice(m, RAW_FOOTNOTES_PARA);
		expectBlock(resolveEditTarget(p, m.index), p, 'paragraph');
	});

	test('前提の確認: 生 HTML の `<section data-footnotes>` は sanitize 後も `data-footnotes` が残り、GFM の脚注欄と同じ見た目になる(2026-10-04 観測)', async () => {
		const m = await mount(RAW_SECTION_MD);
		const section = q(m.root, FOOTNOTES_SECTION);
		expect(section.classList.contains('footnotes')).toBe(true);
		const p = paragraphBySlice(m, RAW_SECTION_PARA);
		expect(p.closest(FOOTNOTES_SECTION)).toBe(section);
		// Markdown の脚注定義ではない: 段落は footnoteDefinition の子ではなくトップレベル。
		const meta = m.index.byId.get(p.getAttribute('data-vellis-node-id') ?? '');
		expect(meta?.parentBlockId).toBeNull();
	});

	test('生 HTML で書いた `<section data-footnotes>` の中の段落は従来どおり block(DOM のセレクタだけで脚注欄と見なして誘導しない・追補f(2))', async () => {
		const m = await mount(RAW_SECTION_MD);
		const p = paragraphBySlice(m, RAW_SECTION_PARA);
		expectBlock(resolveEditTarget(p, m.index), p, 'paragraph');
	});
});
