/**
 * 要件#49 の受け入れテスト(docs/requirements/req-49.md)— 逆シリアライズと
 * 範囲差し替えの純関数(unit プロジェクト)
 *
 * 「閲覧専用(FR-02)撤廃の第2段」: レンダリングされた見た目のまま**ブロック1つ**を
 * 直し、そのブロックだけを Markdown へ逆シリアライズして原文の該当範囲へ差し戻す。
 * 判断は `src/markdown/edit.ts` の純関数に集め(要件#48 の `document-edit.ts` と
 * 同じ分担)、DOM も状態も持たない形で直接呼ぶ。JSDOM の要素を引数に渡すのは可。
 *
 * ## `src/markdown/edit.ts` に求める export(本テストが契約を決める)
 *
 * ```ts
 * import type { NodeMeta, SourceIndex, SourcePosition } from './types';
 *
 * /** ダブルクリックされた要素をどう扱うか(契約①③)。 *\/
 * export type EditTarget =
 *   // そのブロックだけを contenteditable にする。`el` は編集単位のブロック要素
 *   // (p / h1-h6 / li / td / th)、`meta` はその `data-vellis-node-id` の NodeMeta
 *   | { kind: 'block'; el: HTMLElement; meta: NodeMeta }
 *   // 編集不可領域(生 HTML・リスト内などの code fence・mermaid・alert タイトル・
 *   // id を持たない要素・①の対象外のブロック)。要件#48 のソース編集モードへ誘導
 *   // する。トップレベル fence は要件#49 追補b(2026-09-14・要件#52 による契約③
 *   // 改訂)で code 種別へ(code-edit.acceptance.test.ts AC-52-1 が固定)
 *   | { kind: 'source' };
 *
 * /** `target`(イベントの target 要素)から編集対象を決める。inline 要素
 *  *(strong / em / code / a …)の上なら、それを含む最寄りの編集可能ブロックへ
 *  * 繰り上げる。`index` が null(レンダー中)なら常に source。 *\/
 * export function resolveEditTarget(target: Element, index: SourceIndex | null): EditTarget;
 *
 * /** 編集後のブロック DOM を、`source.slice(meta.position.startOffset,
 *  * meta.position.endOffset)` と差し替えられる Markdown にする(契約②④)。
 *  * 末尾に改行を足さない(足すと差し替え後に空行が増える=整形になる)。
 *  * `source` は元スライス(ブロックのマーカー = `## ` / `- ` / `2. ` / `> ` /
 *  * `[!NOTE]` 行)を保つために渡す。`baseUri`(追補a(4))はレンダーに使った文書
 *  * URI で、`rewrite-uri` が書き換えた href / src を元の相対表記へ戻すために渡す。 *\/
 * export function serializeBlock(el: Element, meta: NodeMeta, source: string, baseUri?: string): string;
 *
 * /** `position.startOffset`〜`position.endOffset`(0 起点 UTF-16 code unit・end は
 *  * 排他)だけを `replacement` に置き換える。前後は byte 等価のまま(契約②⑥)。 *\/
 * export function replaceRange(source: string, position: SourcePosition, replacement: string): string;
 * ```
 *
 * ## 判定するもの(契約番号は req-49.md の①〜⑦)
 * 1. `resolveEditTarget`(契約①③ = AC-49-1/2 の判定部): 段落・見出し・リスト項目・
 *    表セル・引用段落は block、inline 要素の上はそのブロックへ繰り上げ。生 HTML・
 *    リスト内 code fence・mermaid・alert タイトル・id を持たない要素・①の対象外は
 *    source(トップレベル fence は追補b=要件#52 改訂で code へ)
 * 2. `serializeBlock`(契約②④ = AC-49-3): 強調・リンク・インラインコードを含む
 *    ブロックが構造を保ったまま Markdown へ戻る(一字一句の一致は求めない=再レンダー
 *    HTML の一致で判定)。末尾改行を足さない
 * 3. `replaceRange`(契約② = AC-49-4): 範囲だけが置き換わり、前後は byte 等価。
 *    offset は UTF-16 code unit(サロゲートペアを含む原文で `SourceIndex` の位置が
 *    そのまま使える)
 * 4. ラウンドトリップ(契約⑥ = AC-49-6/7): 編集していないブロックの Markdown は
 *    整形されず byte 等価(setext 見出し・`*   ` の余分な空白・行末空白・タブ・`+`
 *    箇条書き・`***` 罫線・末尾改行なし・CRLF)。編集したブロックは再レンダー HTML が
 *    期待結果のレンダー HTML と一致(段落・見出し・順序付き/なしリスト項目・表セル・
 *    引用段落・alert 本文段落)
 * 5. 依存とモジュール境界(契約④ = AC-49-10/11): `edit.ts` が `hast-util-to-mdast` と
 *    `mdast-util-to-markdown` を使う・追加される依存はその2つだけ・`selection.ts` /
 *    `source-index.ts` は無改変(内容の SHA-256 を固定)
 * 6. リンク・画像の原文表記(契約⑥・追補a(4) = AC-49-15): レンダリング時の
 *    `rewrite-uri`(相対 href → `file://` 絶対・相対 img src → `vellis-asset://`)の
 *    **逆写像**を通し、確定後の原文に元の相対表記がそのまま残る。再レンダー HTML の
 *    一致では内部 URI の焼き付きを検出できない(1周目の盲点)ので、**原文文字列を
 *    直接判定**する。この判定のため `serializeBlock` は第4引数 `baseUri`(レンダーに
 *    使った文書 URI)を受ける — `serializeBlock(el, meta, source, baseUri)`。
 *    1〜5 の既存呼び出し(3引数)は相対リンクを含まないのでそのまま
 * 7. 逆写像できないリンク表記(契約③⑥・追補a(7) = AC-49-18): 追補a(4) の逆写像は
 *    インラインの `](...)` 表記にしか効かない。参照リンク `[x][ref]`(定義は別行)と
 *    角括弧で囲んだ行き先 `[x](<a b.md>)` を含むブロックは `resolveEditTarget` が
 *    **source**(契約③の誘導)を返す。同じ文書のインラインリンク・装飾なしの段落は
 *    block のまま(リンクを含むブロックを一律に誘導へ回す逃げ方を塞ぐ)
 * 8. 括弧・エスケープを含む行き先(契約⑥・追補a(8) = AC-49-19): 元スライスの行き先の
 *    読み取りは CommonMark に従う ―― (a) バランスした括弧 `./a(1).md` /
 *    `images/photo(1).png` / 入れ子 `./a(b(c)).md` / 末尾の括弧 / タイトル付きを最後まで
 *    読む・(b) バックスラッシュエスケープ `./a\_b.md` / `./a\(1\).md` を解いてから
 *    写像する・(c) 戻すのは**原文の綴りそのもの**(エスケープも括弧も元のまま)。
 *    読めたものは誘導へ回さず `resolveEditTarget` は block を返し、確定後の原文に
 *    内部 URI が混入しない(6 と同じく原文文字列を直接判定する)。バランスしていない
 *    括弧は CommonMark どおり(リンクにならない / 最初の不釣り合いな `)` で閉じる)。
 *    参照リンクと角括弧付き行き先は 7 のまま source(非退行)
 * 9. 書き出しの細工が本文を書き換えない(契約⑥・追補a(9) = AC-49-20): 8(c) を実現する
 *    手段(`toMarkdown` のエスケープを迂回する差し替え札)が**行き先以外**に掛かっては
 *    ならない。札と同じ文字列が本文テキスト・リンク文言に現れるブロックを編集して
 *    確定しても、その箇所は原文のまま(行き先に化けない)。リンクが無いブロックでも同じ
 *
 * 10. 行き先は要素の原文範囲から読む(契約⑥・追補a(11) = AC-49-21): 追補a(4) の
 *     前向きに写した鍵の表は、鍵とレンダー結果の正規化が食い違う行き先(U+3000・
 *     角括弧・エスケープしたバックスラッシュ・エンティティ参照)で表に載らず、
 *     内部 URI を焼き付ける(backlog 160・161)。`a` / `img` 自身の `data-source-*`
 *     から原文スライスを採って綴りを直接読む方式では、これらは block のまま編集
 *     でき、確定後の原文も元の綴りのまま
 * 11. 同じ行き先の別の綴り(契約⑥・追補a(11) = AC-49-22): URI を鍵にした表は
 *     `[a](./x.md)` と `[b](x.md)` を1つに畳む(backlog 154)。確定後の原文で
 *     それぞれの綴りがそのまま残る
 * 12. 本文の `](` は行き先として数えない(契約③⑥・追補a(11) = AC-49-23): 数の
 *     突き合わせ判定は本文・inline code の `](` で狂い、参照リンクの誘導を逃す
 *     (backlog 162)。内部 URI を持つ要素のうち自分のスライスから行き先を
 *     読めないもの(参照リンク・生 HTML の `<img>`)が1つでもあれば source
 * 13. 札の接頭辞は一度の走査で決める(追補a(13) = AC-49-24): 札の芽 `xvellisuri` の
 *     後ろに `x` が続く病的な本文(10万文字規模)でも `serializeBlock` が1秒未満で
 *     返る(backlog 164)
 * 14. 行き先を読むのは初回レンダー基準の原文(契約⑥・追補a(11)「位置の基準」=
 *     AC-49-25): `a` / `img` の `data-source-*` は初回レンダー基準の絶対 offset なので、
 *     同じブロックを2回続けて編集すると、確定後の原文から切った窓は子の offset と
 *     対応しない(backlog 165)。この判定のため `serializeBlock` は第5引数
 *     `originSlice`(初回レンダーのブロックスライス= `index.sliceOf(meta.id)`)を
 *     受ける ―― `serializeBlock(el, meta, source, baseUri, originSlice)`。省略時は
 *     従来どおり `source` と `meta.position` から採る(単発編集では同じ値になる)ので
 *     1〜13 の既存呼び出し(3〜4引数)はそのまま
 *
 * ## 判定しないもの
 * - Viewer の contenteditable 配線・確定/破棄・⌘S・エコー抑止
 *   → src/components/Viewer.blockedit.wiring.test.ts
 * - `rebind` の offset 単位(契約⑤)→ src-tauri/tests/acceptance_req49.rs
 * - 編集中の見た目・IME・装飾付きテキストの編集後の見え方・git diff の確認・
 *   マーク再アンカーの実地確認・依存追加の事後確認
 *   → 人間ゲート(acceptance/acceptance.md 要件#49 ①〜⑥)
 */
import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from './renderer';
import { replaceRange, resolveEditTarget, serializeBlock, type EditTarget } from './edit';
import type { NodeMeta, SourceIndex, SourcePosition } from './types';

const baseUri = 'file:///home/user/notes/doc.md';

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

interface Mounted {
	html: string;
	index: SourceIndex;
	root: HTMLDivElement;
}

/** 本番パイプライン(`render`)の出力を JSDOM に載せる(alert.acceptance.test.ts の家風)。 */
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

/** 要素の `data-vellis-node-id` から NodeMeta を引く。 */
function metaOf(el: Element, index: SourceIndex): NodeMeta {
	const id = el.getAttribute('data-vellis-node-id');
	if (!id) throw new Error('data-vellis-node-id が無い');
	const meta = index.byId.get(id);
	if (!meta) throw new Error(`index に無い id: ${id}`);
	return meta;
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

/**
 * 意味等価の比較用に、レンダー HTML から位置依存の属性を落とす。
 * `data-vellis-node-id` / `data-source-*` は offset と採番に依存するので、
 * 同じ構造でも編集で長さが変わればずれる。構造を表す `data-vellis-node-type` と
 * タグ・テキストは残す。
 */
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

/** 編集の1周: DOM を直した後のブロックを逆シリアライズして原文へ差し戻す。 */
function commit(source: string, el: HTMLElement, meta: NodeMeta): string {
	return replaceRange(source, meta.position, serializeBlock(el, meta, source));
}

/** 編集可能ブロック(段落・見出し・リスト項目・表セル・引用段落)を1つずつ含む文書。
 * 末尾のリスト項目内 fence は契約③(追補b 後も source のまま)の判定用。 */
const BLOCKS_MD = [
	'# Title',
	'',
	'First **bold** paragraph.',
	'',
	'- item one',
	'- item two',
	'',
	'| A | B |',
	'| --- | --- |',
	'| a1 | b1 |',
	'',
	'> quoted paragraph',
	'',
	'```javascript',
	'const x = 1;',
	'```',
	'',
	'<div class="raw">raw html block</div>',
	'',
	'```mermaid',
	'graph TD;',
	'  A-->B;',
	'```',
	'',
	'> [!NOTE]',
	'> alert body',
	'',
	'---',
	'',
	'- listed item with fence:',
	'  ```javascript',
	'  const nested = 2;',
	'  ```',
	'',
].join('\n');

/** blockquote の外にある最初の段落(alert / 引用の段落と区別する)。 */
function firstPlainParagraph(root: ParentNode): HTMLElement {
	const p = [...root.querySelectorAll('p[data-vellis-node-type="paragraph"]')].find(
		(el) => !el.closest('blockquote'),
	);
	if (!p) throw new Error('blockquote 外の段落が無い');
	return p as HTMLElement;
}

/** alert ではない blockquote の中の段落(引用段落)。 */
function quoteParagraph(root: ParentNode): HTMLElement {
	const bq = [...root.querySelectorAll('blockquote')].find(
		(el) => !el.classList.contains('markdown-alert'),
	);
	if (!bq) throw new Error('通常の blockquote が無い');
	return q(bq, 'p[data-vellis-node-type="paragraph"]');
}

function expectBlock(t: EditTarget, el: HTMLElement, type: string): void {
	expect(t.kind).toBe('block');
	if (t.kind !== 'block') return;
	expect(t.el).toBe(el);
	expect(t.meta.type).toBe(type);
	expect(t.meta.id).toBe(el.getAttribute('data-vellis-node-id'));
}

// ---------------------------------------------------------------------------
// resolveEditTarget — 編集単位の判定(契約①③)
// ---------------------------------------------------------------------------

describe('resolveEditTarget — ①の対象ブロックは block(契約①)', () => {
	test('段落 → block(el は <p>・meta.type は paragraph)', async () => {
		const m = await mount(BLOCKS_MD);
		const p = firstPlainParagraph(m.root);
		expectBlock(resolveEditTarget(p, m.index), p, 'paragraph');
	});

	test('見出し → block(el は <h1>・meta.type は heading)', async () => {
		const m = await mount(BLOCKS_MD);
		const h1 = q(m.root, 'h1[data-vellis-node-type="heading"]');
		expectBlock(resolveEditTarget(h1, m.index), h1, 'heading');
	});

	test('リスト項目(tight)→ block(el は <li>・meta.type は listItem)', async () => {
		const m = await mount(BLOCKS_MD);
		const li = q(m.root, 'li[data-vellis-node-type="listItem"]');
		expectBlock(resolveEditTarget(li, m.index), li, 'listItem');
	});

	test('表セル → block(el は <td>・meta.type は tableCell)', async () => {
		const m = await mount(BLOCKS_MD);
		const td = q(m.root, 'td[data-vellis-node-type="tableCell"]');
		expectBlock(resolveEditTarget(td, m.index), td, 'tableCell');
	});

	test('引用段落 → block(el は blockquote 内の <p>・blockquote 自体ではない)', async () => {
		const m = await mount(BLOCKS_MD);
		const p = quoteParagraph(m.root);
		expectBlock(resolveEditTarget(p, m.index), p, 'paragraph');
	});

	test('段落内の inline 要素(<strong>)の上 → それを含む段落へ繰り上げる', async () => {
		const m = await mount(BLOCKS_MD);
		const p = firstPlainParagraph(m.root);
		const strong = q(p, 'strong');
		// inline ノードにも data-vellis-node-id は付くが、編集単位はブロック(契約①)。
		expect(strong.getAttribute('data-vellis-node-id')).toBeTruthy();
		expectBlock(resolveEditTarget(strong, m.index), p, 'paragraph');
	});
});

describe('resolveEditTarget — 編集不可領域は source(契約③)', () => {
	// 要件#49 追補b(2026-09-14・要件#52 による契約③改訂): トップレベル fence は
	// 要件#52 で code 種別へ(code-edit.acceptance.test.ts AC-52-1 が固定)。契約③に
	// 残る「リスト内 fence → source」で編集不可判定の検証力を維持する。
	test('リスト項目内の code fence(Shiki 装飾)→ source(要件#49 追補b)', async () => {
		const m = await mount(BLOCKS_MD);
		const code = q(m.root, 'li pre > code');
		expect(resolveEditTarget(code, m.index)).toEqual({ kind: 'source' });
	});

	test('リスト項目内の code fence の中の Shiki span → source(繰り上がっても listItem block にしない)', async () => {
		const m = await mount(BLOCKS_MD);
		const code = q(m.root, 'li pre > code');
		const inner = code.querySelector('span') ?? code;
		expect(resolveEditTarget(inner, m.index)).toEqual({ kind: 'source' });
	});

	test('mermaid プレースホルダ → source', async () => {
		const m = await mount(BLOCKS_MD);
		const mermaid = q(m.root, '.vellis-mermaid');
		expect(resolveEditTarget(mermaid, m.index)).toEqual({ kind: 'source' });
		// プレースホルダ内のフォールバック <pre> の上でも同じ。
		expect(resolveEditTarget(q(mermaid, 'pre'), m.index)).toEqual({ kind: 'source' });
	});

	test('alert タイトル(生成ノード=id 無し)→ source', async () => {
		const m = await mount(BLOCKS_MD);
		const title = q(m.root, 'p.markdown-alert-title');
		expect(title.hasAttribute('data-vellis-node-id')).toBe(false);
		expect(resolveEditTarget(title, m.index)).toEqual({ kind: 'source' });
	});

	test('生 HTML ブロック(rehype-raw 由来=id 無し)→ source', async () => {
		const m = await mount(BLOCKS_MD);
		const raw = q(m.root, 'div.raw');
		expect(raw.hasAttribute('data-vellis-node-id')).toBe(false);
		expect(resolveEditTarget(raw, m.index)).toEqual({ kind: 'source' });
	});

	test('id を持たない要素(本文コンテナそのもの)→ source', async () => {
		const m = await mount(BLOCKS_MD);
		expect(resolveEditTarget(m.root, m.index)).toEqual({ kind: 'source' });
	});

	test('①の対象外のブロック(<hr> = thematicBreak)→ source', async () => {
		const m = await mount(BLOCKS_MD);
		const hr = q(m.root, 'hr[data-vellis-node-type="thematicBreak"]');
		expect(resolveEditTarget(hr, m.index)).toEqual({ kind: 'source' });
	});

	test('index が null(レンダー中)→ source', async () => {
		const m = await mount(BLOCKS_MD);
		expect(resolveEditTarget(firstPlainParagraph(m.root), null)).toEqual({ kind: 'source' });
	});
});

// ---------------------------------------------------------------------------
// serializeBlock — DOM → Markdown(契約②④)
// ---------------------------------------------------------------------------

const INLINE_MD = 'Intro.\n\nHas **bold**, *em*, `code` and [link](https://example.com).\n\nOutro.\n';
const INLINE_SLICE = 'Has **bold**, *em*, `code` and [link](https://example.com).';

describe('serializeBlock — 強調・リンク・インラインコードを保つ(契約②④)', () => {
	test('未編集のブロックは各マーカーを持つ Markdown に戻る(記法の揺れは許す)', async () => {
		const m = await mount(INLINE_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', INLINE_SLICE);

		const md = serializeBlock(el, meta, INLINE_MD);

		expect(md).toMatch(/\*\*bold\*\*|__bold__/);
		expect(md).toMatch(/\*em\*|_em_/);
		expect(md).toContain('`code`');
		expect(md).toMatch(/\[link\]\(https:\/\/example\.com\/?\)/);
	});

	test('未編集のブロックは元スライスと同じ HTML にレンダーされる(構造を保つ)', async () => {
		const m = await mount(INLINE_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', INLINE_SLICE);

		await expectSameRender(serializeBlock(el, meta, INLINE_MD), INLINE_SLICE);
	});

	test('テキストだけを直した後も装飾の構造が残る', async () => {
		const m = await mount(INLINE_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', INLINE_SLICE);
		const first = el.firstChild;
		if (!first || first.nodeType !== Node.TEXT_NODE) throw new Error('先頭がテキストではない');
		first.textContent = 'Now has ';

		const md = serializeBlock(el, meta, INLINE_MD);

		expect(md).toMatch(/^Now has /);
		await expectSameRender(md, 'Now has **bold**, *em*, `code` and [link](https://example.com).');
	});

	test('装飾の中のテキストを直しても装飾が外れない', async () => {
		const m = await mount(INLINE_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', INLINE_SLICE);
		q(el, 'strong').textContent = 'strong';
		q(el, 'a').textContent = 'anchor';

		const md = serializeBlock(el, meta, INLINE_MD);

		expect(md).toMatch(/\*\*strong\*\*|__strong__/);
		expect(md).toMatch(/\[anchor\]\(https:\/\/example\.com\/?\)/);
	});

	test('プレーンな段落はテキストそのもの(末尾改行を足さない=整形しない)', async () => {
		const m = await mount('Alpha.\n\nBeta.\n');
		const { el, meta } = blockBySlice(m, 'paragraph', 'Beta.');
		el.textContent = 'Edited paragraph';

		expect(serializeBlock(el, meta, 'Alpha.\n\nBeta.\n')).toBe('Edited paragraph');
	});
});

// ---------------------------------------------------------------------------
// replaceRange — 範囲だけを置き換える(契約②)
// ---------------------------------------------------------------------------

function pos(startOffset: number, endOffset: number): SourcePosition {
	// 行・列は差し替えに使わない(offset だけが契約②の対象)。
	return { startLine: 0, startColumn: 0, startOffset, endLine: 0, endColumn: 0, endOffset };
}

describe('replaceRange — startOffset〜endOffset の丸ごと差し替え(契約②)', () => {
	const SRC = 'one\n\ntwo\n\nthree\n';
	const TWO = SRC.indexOf('two');

	test('中間ブロックの範囲だけが置き換わり、前後は byte 等価', () => {
		expect(replaceRange(SRC, pos(TWO, TWO + 3), 'TWO!')).toBe('one\n\nTWO!\n\nthree\n');
	});

	test('先頭ブロック(startOffset=0)', () => {
		expect(replaceRange(SRC, pos(0, 3), 'ONE')).toBe('ONE\n\ntwo\n\nthree\n');
	});

	test('末尾ブロック(endOffset=length・末尾改行なしの原文)', () => {
		const src = 'a\n\nb';
		expect(replaceRange(src, pos(3, 4), 'B')).toBe('a\n\nB');
	});

	test('空文字への差し替え(ブロックを空にした)は範囲だけが消える', () => {
		expect(replaceRange(SRC, pos(TWO, TWO + 3), '')).toBe('one\n\n\n\nthree\n');
	});

	test('CRLF の原文は前後の CRLF が保たれる', () => {
		const src = 'one\r\n\r\ntwo\r\n\r\nthree\r\n';
		const start = src.indexOf('two');
		expect(replaceRange(src, pos(start, start + 3), 'TWO')).toBe('one\r\n\r\nTWO\r\n\r\nthree\r\n');
	});

	test('offset は UTF-16 code unit(サロゲートペア=2)で数える', () => {
		// '😀' は 1 code point・2 code units。code point で数えると 1 つずれる。
		const src = '😀 first\n\nsecond\n';
		const start = src.indexOf('second'); // = 10(😀=2 + " first"=6 + "\n\n"=2)
		expect(start).toBe(10);
		expect(replaceRange(src, pos(start, start + 6), 'SECOND')).toBe('😀 first\n\nSECOND\n');
	});

	test('SourceIndex の position がそのまま使える(絵文字を含む前段落の後ろのブロック)', async () => {
		const src = '😀 first\n\nsecond\n\nthird\n';
		const m = await mount(src);
		const { meta } = blockBySlice(m, 'paragraph', 'second');

		expect(replaceRange(src, meta.position, 'SECOND')).toBe('😀 first\n\nSECOND\n\nthird\n');
	});
});

// ---------------------------------------------------------------------------
// ラウンドトリップ(契約⑥)
// ---------------------------------------------------------------------------

/**
 * 整形器なら書き換えるであろう書き方を集めた文書。編集するのは `Second **bold**
 * paragraph.` だけで、その外側は 1 byte も動いてはならない。
 */
const QUIRKY_MD =
	'Title\n=====\n\n' + // setext 見出し(`# Title` へ正規化しない)
	'*   spaced bullet\n' + // `*` 箇条書き+余分な空白
	'*   second bullet   \n' + // 行末空白
	'\n' +
	'Second **bold** paragraph.\n' + // ← 編集するブロック
	'\n' +
	'\tindented code\n' + // ハードタブのインデントコード
	'\n' +
	'+ plus bullet\n' + // `+` 箇条書き
	'\n' +
	'***\n' + // `***` 形の罫線
	'\n' +
	'Last line without trailing newline';
const QUIRKY_SLICE = 'Second **bold** paragraph.';

describe('ラウンドトリップ — 未編集ブロックは byte 等価(契約⑥ / AC-49-6)', () => {
	test('編集ブロックの前後の原文が 1 byte も変わらない(整形しない)', async () => {
		const m = await mount(QUIRKY_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', QUIRKY_SLICE);
		q(el, 'strong').textContent = 'strong';

		const next = commit(QUIRKY_MD, el, meta);

		const { startOffset, endOffset } = meta.position;
		const suffixLen = QUIRKY_MD.length - endOffset;
		expect(next.slice(0, startOffset)).toBe(QUIRKY_MD.slice(0, startOffset));
		expect(next.slice(next.length - suffixLen)).toBe(QUIRKY_MD.slice(endOffset));
	});

	test('CRLF の文書で段落を直しても、他の行の CRLF が LF に潰れない', async () => {
		const src = 'para one\r\n\r\npara two\r\n\r\npara three\r\n';
		const m = await mount(src);
		const { el, meta } = blockBySlice(m, 'paragraph', 'para two');
		el.textContent = 'para two edited';

		expect(commit(src, el, meta)).toBe('para one\r\n\r\npara two edited\r\n\r\npara three\r\n');
	});
});

describe('ラウンドトリップ — 編集ブロックは意味等価(契約⑥ / AC-49-7)', () => {
	test('段落(装飾入り)', async () => {
		const m = await mount(QUIRKY_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', QUIRKY_SLICE);
		q(el, 'strong').textContent = 'strong';

		await expectSameRender(commit(QUIRKY_MD, el, meta), QUIRKY_MD.replace('**bold**', '**strong**'));
	});

	test('見出し(ATX)は見出しのまま', async () => {
		const src = '## Section\n\nbody\n';
		const m = await mount(src);
		const { el, meta } = blockBySlice(m, 'heading', '## Section');
		el.textContent = 'Section edited';

		await expectSameRender(commit(src, el, meta), '## Section edited\n\nbody\n');
	});

	test('順序なしリストの項目は同じリストの項目のまま(マーカーを変えて別リストに割らない)', async () => {
		const src = '- item one\n- item two\n- item three\n';
		const m = await mount(src);
		const { el, meta } = blockBySlice(m, 'listItem', '- item two');
		el.textContent = 'item two edited';

		await expectSameRender(commit(src, el, meta), '- item one\n- item two edited\n- item three\n');
	});

	test('順序付きリストの項目は順序付きのまま(<ol> が <ul> に化けない)', async () => {
		const src = '1. one\n2. two\n3. three\n';
		const m = await mount(src);
		const { el, meta } = blockBySlice(m, 'listItem', '2. two');
		el.textContent = 'two edited';

		await expectSameRender(commit(src, el, meta), '1. one\n2. two edited\n3. three\n');
	});

	test('表セルは表のまま', async () => {
		const src = '| A | B |\n| --- | --- |\n| a1 | b1 |\n';
		const m = await mount(src);
		const td = q(m.root, 'td[data-vellis-node-type="tableCell"]');
		const meta = metaOf(td, m.index);
		td.textContent = 'a1 edited';

		await expectSameRender(commit(src, td, meta), '| A | B |\n| --- | --- |\n| a1 edited | b1 |\n');
	});

	test('引用段落は引用のまま', async () => {
		const src = '> quoted paragraph\n\nafter\n';
		const m = await mount(src);
		const p = q(m.root, 'blockquote p[data-vellis-node-type="paragraph"]');
		const meta = metaOf(p, m.index);
		p.textContent = 'quoted paragraph edited';

		await expectSameRender(commit(src, p, meta), '> quoted paragraph edited\n\nafter\n');
	});

	test('alert 本文の段落はタイトル付き alert のまま([!NOTE] マーカーを失わない)', async () => {
		// 契約③で編集不可なのは alert の**タイトル**だけで、本文段落は引用段落として
		// 編集できる。mdast の段落 position は plugins/alert.ts が消した `[!NOTE]` 行を
		// 含んだままなので、範囲を素朴に置き換えるとマーカーごと消えて alert で
		// なくなる — 意味等価が壊れる代表例。
		const src = '> [!NOTE]\n> alert body\n\nafter\n';
		const m = await mount(src);
		const p = q(m.root, 'blockquote.markdown-alert p[data-vellis-node-id]');
		const meta = metaOf(p, m.index);
		p.textContent = 'alert body edited';

		await expectSameRender(commit(src, p, meta), '> [!NOTE]\n> alert body edited\n\nafter\n');
	});
});

// ---------------------------------------------------------------------------
// 依存とモジュール境界(契約④)
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '../..');

function readRepoFile(rel: string): string {
	const path = resolve(REPO_ROOT, rel);
	expect(existsSync(path), `${rel} が存在すること`).toBe(true);
	return readFileSync(path, 'utf8');
}

function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

/** 要件#49 着手時点(package.json @ HEAD)の runtime 依存。 */
const RUNTIME_DEPS_BEFORE_REQ49 = [
	'@shikijs/rehype',
	'@tauri-apps/api',
	'@tauri-apps/plugin-dialog',
	'@tauri-apps/plugin-opener',
	'mdast-util-to-string',
	'mermaid',
	'rehype-raw',
	'rehype-sanitize',
	'rehype-stringify',
	'remark-gfm',
	'remark-parse',
	'remark-rehype',
	'three',
	'unified',
	'unist-util-visit',
];

const REQ49_DEPS = ['hast-util-to-mdast', 'mdast-util-to-markdown'];
// 追補b(2026-09-15・要件#53 契約⑧による改訂)= 要件#53 が rehype-parse 1件を追加(着手時点+2つ+#53 の1つ)。
const REQ53_DEPS = ['rehype-parse'];

describe('依存とモジュール境界(契約④ / AC-49-10・AC-49-11)', () => {
	test('新規モジュール src/markdown/edit.ts が逆シリアライズを hast-util-to-mdast + mdast-util-to-markdown で行う', () => {
		const src = readRepoFile('src/markdown/edit.ts');
		expect(src).toMatch(/from ['"]hast-util-to-mdast['"]/);
		expect(src).toMatch(/from ['"]mdast-util-to-markdown['"]/);
	});

	test('package.json の runtime 依存は着手時点+2つだけ(AC-49-11)', () => {
		const pkg = JSON.parse(readRepoFile('package.json')) as {
			dependencies: Record<string, string>;
			devDependencies: Record<string, string>;
		};
		expect(Object.keys(pkg.dependencies).sort()).toEqual(
			[...RUNTIME_DEPS_BEFORE_REQ49, ...REQ49_DEPS, ...REQ53_DEPS].sort(),
		);
		// hast/mdast 系のユーティリティが devDependencies に紛れて増えていないこと
		// (`@types/hast` / `@types/mdast` は着手前からある型定義で対象外)。
		const sneaked = Object.keys(pkg.devDependencies).filter(
			(name) => name.startsWith('hast-util-') || name.startsWith('mdast-util-'),
		);
		expect(sneaked).toEqual([]);
	});

	// 契約④「selection.ts / source-index.ts は不変」を内容の SHA-256 で固定する
	// (同種の先例は無く、本要件で導入)。要件#13 / #32 の既存テストがフルスイートで
	// 緑のままであることと合わせて AC-49-10。値は要件#49 着手時点(HEAD)の内容。
	// 後続の要件がこれらのファイルを正当に変える場合は、要件側で決めてから固定値を
	// 更新する(実装の周回で書き換えない)。
	test('src/markdown/selection.ts は無改変(SHA-256 固定)', () => {
		expect(sha256(readRepoFile('src/markdown/selection.ts'))).toBe(
			'8ee2fb364ac2f1bceb1102dcd3c370f30b449b6d0b30e5515f0d54186c2f2a03',
		);
	});

	test('src/markdown/source-index.ts は無改変(SHA-256 固定)', () => {
		expect(sha256(readRepoFile('src/markdown/source-index.ts'))).toBe(
			'38e88b46bdc617d55583c8e5d6d83c40bc083c4ebf57bc66d278ba43f99b6a01',
		);
	});
});

// ---------------------------------------------------------------------------
// リンク・画像の原文表記(契約⑥・追補a(4) / AC-49-15)
// ---------------------------------------------------------------------------

/**
 * 相対リンクと相対画像を1段落に含む文書。`render(source, baseUri)` は
 * `rewrite-uri` で href を `file:///home/user/notes/other.md`・src を
 * `vellis-asset://local/home/user/notes/images/cat.png` へ書き換えるので、
 * DOM からの素朴な逆シリアライズはその内部 URI を原文へ焼き付ける
 * (1周目の reviewer 実測)。確定後の原文には元の相対表記がそのまま残ること。
 */
const LINK_MD =
	'Intro.\n\n' +
	'See [other](./other.md) and ![cat](images/cat.png) here.\n\n' +
	'Outro.\n';
const LINK_SLICE = 'See [other](./other.md) and ![cat](images/cat.png) here.';

/** 先頭のテキストノードを書き換える(リンク・画像には触らない編集)。 */
function editLeadingText(el: HTMLElement, text: string): void {
	const first = el.firstChild;
	if (!first || first.nodeType !== Node.TEXT_NODE) throw new Error('先頭がテキストではない');
	first.textContent = text;
}

describe('serializeBlock — リンク・画像は元の相対表記のまま(契約⑥・追補a(4) / AC-49-15)', () => {
	test('レンダー結果の DOM には内部 URI が載っている(前提の確認)', async () => {
		const m = await mount(LINK_MD);
		const { el } = blockBySlice(m, 'paragraph', LINK_SLICE);
		expect(q(el, 'a').getAttribute('href')).toBe('file:///home/user/notes/other.md');
		expect(q(el, 'img').getAttribute('src')).toBe(
			'vellis-asset://local/home/user/notes/images/cat.png',
		);
	});

	test('相対リンク `[x](./y.md)` は `file://` に化けない', async () => {
		const m = await mount(LINK_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', LINK_SLICE);
		editLeadingText(el, 'Look at ');

		const md = serializeBlock(el, meta, LINK_MD, baseUri);

		expect(md).toContain('[other](./other.md)');
		expect(md).not.toContain('file://');
	});

	test('相対画像 `![x](images/y.png)` は `vellis-asset://` に化けない', async () => {
		const m = await mount(LINK_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', LINK_SLICE);
		editLeadingText(el, 'Look at ');

		const md = serializeBlock(el, meta, LINK_MD, baseUri);

		expect(md).toContain('![cat](images/cat.png)');
		expect(md).not.toContain('vellis-asset://');
	});

	test('reviewer 実測の再現: 段落を直して差し戻した原文に内部 URI が混入せず、前後は byte 等価', async () => {
		const m = await mount(LINK_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', LINK_SLICE);
		editLeadingText(el, 'Look at ');

		const next = replaceRange(LINK_MD, meta.position, serializeBlock(el, meta, LINK_MD, baseUri));

		expect(next).not.toContain('file://');
		expect(next).not.toContain('vellis-asset://');
		expect(next).toContain('[other](./other.md)');
		expect(next).toContain('![cat](images/cat.png)');
		expect(next.startsWith('Intro.\n\nLook at ')).toBe(true);
		expect(next.endsWith(' here.\n\nOutro.\n')).toBe(true);
		await expectSameRender(next, LINK_MD.replace('See ', 'Look at '));
	});

	test('リンクの文言を直しても URI は元の相対表記のまま', async () => {
		const m = await mount(LINK_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', LINK_SLICE);
		q(el, 'a').textContent = 'the other doc';

		const md = serializeBlock(el, meta, LINK_MD, baseUri);

		expect(md).toContain('[the other doc](./other.md)');
		expect(md).not.toContain('file://');
	});

	test('`./` 無しの相対パスと `../` の親相対も、書き方を変えずに残す', async () => {
		// 逆写像を「絶対 URI → base からの相対」で機械的に作ると `./` の有無や
		// `../` が正規化される。原文表記は元のまま(契約⑥は整形しない)。
		const src = 'Go [sub](sub/page.md), [up](../up.md), ![pic](./pics/a.png).\n';
		const slice = src.trimEnd();
		const m = await mount(src);
		const { el, meta } = blockBySlice(m, 'paragraph', slice);
		editLeadingText(el, 'Jump ');

		const md = serializeBlock(el, meta, src, baseUri);

		expect(md).toContain('[sub](sub/page.md)');
		expect(md).toContain('[up](../up.md)');
		expect(md).toContain('![pic](./pics/a.png)');
		expect(md).not.toMatch(/file:\/\/|vellis-asset:\/\//);
	});

	test('外部リンクと `#` フラグメントは rewrite-uri の対象外なのでそのまま', async () => {
		const src = 'Ext [e](https://example.com/p), frag [f](#sec), rel [r](./r.md).\n';
		const slice = src.trimEnd();
		const m = await mount(src);
		const { el, meta } = blockBySlice(m, 'paragraph', slice);
		editLeadingText(el, 'External ');

		const md = serializeBlock(el, meta, src, baseUri);

		expect(md).toMatch(/\[e\]\(https:\/\/example\.com\/p\/?\)/);
		expect(md).toContain('[f](#sec)');
		expect(md).toContain('[r](./r.md)');
		expect(md).not.toContain('file://');
	});

	test('リスト項目の中の相対リンクも同じ(ブロック種別に依らない)', async () => {
		const src = '- one [doc](./doc2.md)\n- two\n';
		const m = await mount(src);
		const { el, meta } = blockBySlice(m, 'listItem', '- one [doc](./doc2.md)');
		editLeadingText(el, 'first ');

		const next = replaceRange(src, meta.position, serializeBlock(el, meta, src, baseUri));

		expect(next).toBe('- first [doc](./doc2.md)\n- two\n');
	});
});

// ---------------------------------------------------------------------------
// 追補a(7)— 逆写像できないリンク表記は誘導へ回す(契約③⑥ / AC-49-18)
// ---------------------------------------------------------------------------

/**
 * 追補a(4) の逆写像はインラインの `](...)` 表記にしか効かない。参照リンク
 * `[x][ref]`(定義 `[ref]: ./other.md` は別行)と、空白を含むため角括弧で囲んだ
 * 行き先 `[x](<sub dir/z.md>)` は、レンダー結果の href が `file://` へ書き換わって
 * いるのに元スライスから写せず、確定すると内部 URI が原文へ焼き付く(2周目の
 * reviewer 実測)。要件側の決定=これらを含むブロックは**契約③の誘導**へ回す。
 *
 * 同じ文書に通常のインラインリンク `[d](./d.md)` と装飾なしの段落も置き、
 * 「リンクを含むブロックを一律に source にする」逃げ方では AC-49-15(インライン
 * リンクはその場で編集できる)が壊れることを同時に固定する。
 */
const REF_MD = [
	'# Title',
	'',
	'See [other][ref] and plain text.',
	'',
	'Angle [c](<sub dir/z.md>) here.',
	'',
	'Inline [d](./d.md) stays.',
	'',
	'Plain paragraph.',
	'',
	'- item [other][ref]',
	'',
	'[ref]: ./other.md',
	'',
].join('\n');

const REF_SLICE = 'See [other][ref] and plain text.';
const ANGLE_SLICE = 'Angle [c](<sub dir/z.md>) here.';
const INLINE_LINK_SLICE = 'Inline [d](./d.md) stays.';
const PLAIN_SLICE = 'Plain paragraph.';
const REF_ITEM_SLICE = '- item [other][ref]';

describe('resolveEditTarget — 逆写像できないリンク表記を含むブロックは source(契約③⑥・追補a(7) / AC-49-18)', () => {
	test('レンダー結果の DOM では参照リンクも角括弧の行き先も `file://` に書き換わっている(前提の確認)', async () => {
		const m = await mount(REF_MD);
		const ref = blockBySlice(m, 'paragraph', REF_SLICE);
		const angle = blockBySlice(m, 'paragraph', ANGLE_SLICE);
		expect(q(ref.el, 'a').getAttribute('href')).toBe('file:///home/user/notes/other.md');
		const angleHref = q(angle.el, 'a').getAttribute('href') ?? '';
		expect(angleHref.startsWith('file:///home/user/notes/')).toBe(true);
		expect(angleHref.endsWith('/z.md')).toBe(true);
	});

	test('参照リンク `[x][ref]` を含む段落 → source(ブロック編集に入れない)', async () => {
		const m = await mount(REF_MD);
		const { el } = blockBySlice(m, 'paragraph', REF_SLICE);
		expect(resolveEditTarget(el, m.index)).toEqual({ kind: 'source' });
	});

	test('参照リンクの <a> そのものの上 → source(段落へ繰り上げても編集不可)', async () => {
		const m = await mount(REF_MD);
		const { el } = blockBySlice(m, 'paragraph', REF_SLICE);
		expect(resolveEditTarget(q(el, 'a'), m.index)).toEqual({ kind: 'source' });
	});

	test('角括弧で囲んだ行き先 `[x](<a b.md>)` を含む段落 → source', async () => {
		const m = await mount(REF_MD);
		const { el } = blockBySlice(m, 'paragraph', ANGLE_SLICE);
		expect(resolveEditTarget(el, m.index)).toEqual({ kind: 'source' });
	});

	test('参照リンクを含むリスト項目 → source(ブロック種別に依らない)', async () => {
		const m = await mount(REF_MD);
		const { el } = blockBySlice(m, 'listItem', REF_ITEM_SLICE);
		expect(resolveEditTarget(el, m.index)).toEqual({ kind: 'source' });
	});

	test('同じ文書のインラインリンク `[d](./d.md)` の段落は block のまま(AC-49-15 の入口を塞がない)', async () => {
		const m = await mount(REF_MD);
		const { el } = blockBySlice(m, 'paragraph', INLINE_LINK_SLICE);
		expectBlock(resolveEditTarget(el, m.index), el, 'paragraph');
	});

	test('同じ文書の装飾なし段落と見出しは block のまま(定義行があるだけでは誘導しない)', async () => {
		const m = await mount(REF_MD);
		const { el } = blockBySlice(m, 'paragraph', PLAIN_SLICE);
		expectBlock(resolveEditTarget(el, m.index), el, 'paragraph');
		const h1 = q(m.root, 'h1[data-vellis-node-type="heading"]');
		expectBlock(resolveEditTarget(h1, m.index), h1, 'heading');
	});
});

/**
 * 参照リンクの他の形。CommonMark の参照リンクは full `[x][ref]` / collapsed
 * `[ref][]` / shortcut `[ref]` の3形で、画像参照 `![x][ref]` も同じ機構。いずれも
 * レンダー結果は定義行の URI を書き換えた内部 URI になり、元スライスに `](` が
 * 無いので逆写像できない=焼き付きの条件は full 形と同じ。AC-49-18 の「参照リンク
 * `[x][ref]`」を CommonMark の参照リンク全体と読んで固定する(読みが違えばこの
 * describe だけを外せるよう分けてある)。
 */
const REF_FORMS_MD = [
	'Collapsed [ref][] here.',
	'',
	'Shortcut [ref] here.',
	'',
	'Image ![pic][img] here.',
	'',
	'[ref]: ./other.md',
	'[img]: images/cat.png',
	'',
].join('\n');

describe('resolveEditTarget — 参照リンクの他の形(collapsed / shortcut / 画像参照)も source(追補a(7) / AC-49-18)', () => {
	test('レンダー結果ではいずれも内部 URI に書き換わっている(前提の確認)', async () => {
		const m = await mount(REF_FORMS_MD);
		const collapsed = blockBySlice(m, 'paragraph', 'Collapsed [ref][] here.');
		const shortcut = blockBySlice(m, 'paragraph', 'Shortcut [ref] here.');
		const image = blockBySlice(m, 'paragraph', 'Image ![pic][img] here.');
		expect(q(collapsed.el, 'a').getAttribute('href')).toBe('file:///home/user/notes/other.md');
		expect(q(shortcut.el, 'a').getAttribute('href')).toBe('file:///home/user/notes/other.md');
		expect(q(image.el, 'img').getAttribute('src')).toBe(
			'vellis-asset://local/home/user/notes/images/cat.png',
		);
	});

	test.each([
		['collapsed `[ref][]`', 'Collapsed [ref][] here.'],
		['shortcut `[ref]`', 'Shortcut [ref] here.'],
		['画像参照 `![x][ref]`', 'Image ![pic][img] here.'],
	])('%s を含む段落 → source', async (_label, slice) => {
		const m = await mount(REF_FORMS_MD);
		const { el } = blockBySlice(m, 'paragraph', slice);
		expect(resolveEditTarget(el, m.index)).toEqual({ kind: 'source' });
	});
});

// ---------------------------------------------------------------------------
// 追補a(8)— 括弧・エスケープを含む行き先も原文表記を保つ(契約⑥ / AC-49-19)
// ---------------------------------------------------------------------------

/**
 * 行き先の読み取りが CommonMark に従っていないと起きる焼き付き(3周目の reviewer
 * 実測= backlog 156)。`[a](./a(1).md)` は行き先を `./a` までしか読めず逆写像表に
 * 載らない・`[b](./a\_b.md)` はエスケープを解かずに写すので DOM の
 * `file:///…/a_b.md` と一致しない ―― どちらも**行き先の数は合う**ので追補a(7) の
 * 誘導にも掛からず、確定すると内部 URI が原文へ焼き付く(AC-49-15 と同じ
 * データ破壊のクラス。`images/photo(1).png` のような名前は現実にある)。
 *
 * 要件側の決定(追補a(8))= 読み取りを CommonMark に合わせる: (a) バランスした
 * 括弧を最後まで読む・(b) エスケープを解いてから写像する・(c) 戻すのは原文の綴り
 * そのもの。読めたものは**誘導へ回さず編集可能のまま**(block)。
 *
 * 各段落は1行なので、`blockBySlice` の鍵はその行そのもの。
 */
const PAREN_MD = [
	'Paren [a](./a(1).md) here.',
	'',
	'Photo ![shot](images/photo(1).png) here.',
	'',
	'Escaped [b](./a\\_b.md) here.',
	'',
	'EscParen [e](./a\\(1\\).md) here.',
	'',
	'Nested [n](./a(b(c)).md) here.',
	'',
	'Trailing [t](./notes(draft)) here.',
	'',
	'Titled [u](./a(1).md "t") here.',
	'',
].join('\n');

const PAREN_SLICE = 'Paren [a](./a(1).md) here.';
const PAREN_IMG_SLICE = 'Photo ![shot](images/photo(1).png) here.';
const ESCAPE_SLICE = 'Escaped [b](./a\\_b.md) here.';
const ESCAPE_PAREN_SLICE = 'EscParen [e](./a\\(1\\).md) here.';
const NESTED_SLICE = 'Nested [n](./a(b(c)).md) here.';
const TRAILING_SLICE = 'Trailing [t](./notes(draft)) here.';
const TITLED_SLICE = 'Titled [u](./a(1).md "t") here.';

describe('AC-49-19 — レンダー結果の DOM には括弧・エスケープを解いた内部 URI が載っている(前提の確認)', () => {
	test('括弧はそのまま・エスケープは解かれて絶対化されている', async () => {
		const m = await mount(PAREN_MD);
		const href = (slice: string): string =>
			q(blockBySlice(m, 'paragraph', slice).el, 'a').getAttribute('href') ?? '';
		expect(href(PAREN_SLICE)).toBe('file:///home/user/notes/a(1).md');
		expect(href(ESCAPE_SLICE)).toBe('file:///home/user/notes/a_b.md');
		expect(href(ESCAPE_PAREN_SLICE)).toBe('file:///home/user/notes/a(1).md');
		expect(href(NESTED_SLICE)).toBe('file:///home/user/notes/a(b(c)).md');
		expect(href(TRAILING_SLICE)).toBe('file:///home/user/notes/notes(draft)');
		expect(href(TITLED_SLICE)).toBe('file:///home/user/notes/a(1).md');
		expect(q(blockBySlice(m, 'paragraph', PAREN_IMG_SLICE).el, 'img').getAttribute('src')).toBe(
			'vellis-asset://local/home/user/notes/images/photo(1).png',
		);
	});
});

describe('resolveEditTarget — 括弧・エスケープを含む行き先は読めるので block(誘導へ回さない・追補a(8) / AC-49-19)', () => {
	// 「リンクの行き先に括弧やエスケープがあれば source に逃がす」実装を塞ぐ。
	// 追補a(7) の誘導対象は「原理的に戻せない表記」(参照リンク・角括弧付き)だけ。
	test.each([
		['括弧入り `[a](./a(1).md)`', PAREN_SLICE],
		['括弧入りの画像 `![x](images/photo(1).png)`', PAREN_IMG_SLICE],
		['エスケープ入り `[b](./a\\_b.md)`', ESCAPE_SLICE],
		['エスケープした括弧 `[e](./a\\(1\\).md)`', ESCAPE_PAREN_SLICE],
		['入れ子の括弧 `[n](./a(b(c)).md)`', NESTED_SLICE],
		['末尾が括弧 `[t](./notes(draft))`', TRAILING_SLICE],
		['タイトル付き `[u](./a(1).md "t")`', TITLED_SLICE],
	])('%s の段落 → block', async (_label, slice) => {
		const m = await mount(PAREN_MD);
		const { el } = blockBySlice(m, 'paragraph', slice);
		expectBlock(resolveEditTarget(el, m.index), el, 'paragraph');
	});

	test('括弧入りリンクの <a> の上でも段落へ繰り上がって block', async () => {
		const m = await mount(PAREN_MD);
		const { el } = blockBySlice(m, 'paragraph', PAREN_SLICE);
		expectBlock(resolveEditTarget(q(el, 'a'), m.index), el, 'paragraph');
	});
});

describe('serializeBlock — 括弧・エスケープを含む行き先は原文の綴りのまま(契約⑥・追補a(8) / AC-49-19)', () => {
	/** 先頭テキストを直して逆シリアライズ(リンク・画像には触らない編集)。 */
	async function edited(slice: string): Promise<string> {
		const m = await mount(PAREN_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', slice);
		editLeadingText(el, 'Edited ');
		return serializeBlock(el, meta, PAREN_MD, baseUri);
	}

	test('(a) 括弧入り `[a](./a(1).md)` は `file://` にも `\\(1\\)` にも化けない', async () => {
		const md = await edited(PAREN_SLICE);
		expect(md).toContain('[a](./a(1).md)');
		expect(md).not.toContain('file://');
		expect(md).not.toContain('\\(');
	});

	test('(a) 括弧入りの画像 `![shot](images/photo(1).png)` は `vellis-asset://` に化けない', async () => {
		const md = await edited(PAREN_IMG_SLICE);
		expect(md).toContain('![shot](images/photo(1).png)');
		expect(md).not.toContain('vellis-asset://');
	});

	test('(b)(c) エスケープ入り `[b](./a\\_b.md)` は `file://` に化けず、エスケープも原文のまま', async () => {
		const md = await edited(ESCAPE_SLICE);
		expect(md).toContain('[b](./a\\_b.md)');
		expect(md).not.toContain('file://');
		expect(md).not.toContain('a_b.md');
	});

	test('(b)(c) エスケープした括弧 `[e](./a\\(1\\).md)` は原文の綴り(エスケープ付き)のまま', async () => {
		const md = await edited(ESCAPE_PAREN_SLICE);
		expect(md).toContain('[e](./a\\(1\\).md)');
		expect(md).not.toContain('file://');
	});

	test('(a) 入れ子の括弧 `[n](./a(b(c)).md)` を最後まで読んで戻す', async () => {
		const md = await edited(NESTED_SLICE);
		expect(md).toContain('[n](./a(b(c)).md)');
		expect(md).not.toContain('file://');
	});

	test('(a) 行き先の末尾が括弧 `[t](./notes(draft))` でも閉じ括弧を取り違えない', async () => {
		const md = await edited(TRAILING_SLICE);
		expect(md).toContain('[t](./notes(draft))');
		expect(md).not.toContain('file://');
	});

	test('(a) タイトル付き `[u](./a(1).md "t")` は行き先もタイトルも原文のまま', async () => {
		const md = await edited(TITLED_SLICE);
		expect(md).toContain('[u](./a(1).md "t")');
		expect(md).not.toContain('file://');
	});

	test('reviewer 実測の再現: 括弧入り画像の段落を直して差し戻した原文は、綴りが元のままで前後は byte 等価', async () => {
		const m = await mount(PAREN_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', PAREN_IMG_SLICE);
		editLeadingText(el, 'Snap ');

		const next = replaceRange(PAREN_MD, meta.position, serializeBlock(el, meta, PAREN_MD, baseUri));

		expect(next).toBe(PAREN_MD.replace('Photo ![shot]', 'Snap ![shot]'));
	});

	test('リンクの文言を直しても括弧入りの行き先は元の綴りのまま', async () => {
		const m = await mount(PAREN_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', PAREN_SLICE);
		q(el, 'a').textContent = 'first';

		const md = serializeBlock(el, meta, PAREN_MD, baseUri);

		expect(md).toContain('[first](./a(1).md)');
		expect(md).not.toContain('file://');
	});

	test('リスト項目の中でも同じ(ブロック種別に依らない)', async () => {
		const src = '- one ![p](images/photo(1).png) and [d](./d\\_1.md)\n- two\n';
		const slice = '- one ![p](images/photo(1).png) and [d](./d\\_1.md)';
		const m = await mount(src);
		const { el, meta } = blockBySlice(m, 'listItem', slice);
		editLeadingText(el, 'first ');

		const next = replaceRange(src, meta.position, serializeBlock(el, meta, src, baseUri));

		expect(next).toBe('- first ![p](images/photo(1).png) and [d](./d\\_1.md)\n- two\n');
	});
});

/**
 * バランスしていない括弧の境界。CommonMark では `<>` で囲まない限り不釣り合いな
 * 括弧は行き先に置けない ―― 閉じが無い `[x](./a(1.md)` はリンクにならず(DOM に
 * <a> が無い)、`[y](./a)1.md)` は最初の `)` で行き先 `./a` が閉じて残りは本文。
 * 読み取りが「最後の `)` まで」のような過読みをすると後者で `./a)1.md` を行き先と
 * 誤認して表に載らず、焼き付きが再発する。ここはその過読みを塞ぐ。
 */
const UNBALANCED_MD = ['Broken [x](./a(1.md) here.', '', 'Close [y](./a)1.md) here.', ''].join(
	'\n',
);
const BROKEN_SLICE = 'Broken [x](./a(1.md) here.';
const CLOSE_SLICE = 'Close [y](./a)1.md) here.';

describe('境界 — バランスしていない括弧は CommonMark どおり(追補a(8) / AC-49-19)', () => {
	test('閉じの無い `[x](./a(1.md)` はリンクにならない(前提の確認)', async () => {
		const m = await mount(UNBALANCED_MD);
		const { el } = blockBySlice(m, 'paragraph', BROKEN_SLICE);
		expect(el.querySelector('a')).toBeNull();
		expect(el.textContent).toBe(BROKEN_SLICE);
	});

	test('リンクにならない段落は block で、確定しても内部 URI は混入せず意味等価', async () => {
		const m = await mount(UNBALANCED_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', BROKEN_SLICE);
		expectBlock(resolveEditTarget(el, m.index), el, 'paragraph');
		// この段落は <a> を含まない単一テキストノードなので、`editLeadingText`(先頭
		// ノード全体の置換)では全文が消える。先頭の語だけ差し替えて末尾を残す。
		const first = el.firstChild;
		if (!first || first.nodeType !== Node.TEXT_NODE) throw new Error('先頭がテキストではない');
		first.textContent = (first.textContent ?? '').replace('Broken ', 'Still ');

		const next = replaceRange(
			UNBALANCED_MD,
			meta.position,
			serializeBlock(el, meta, UNBALANCED_MD, baseUri),
		);

		expect(next).not.toContain('file://');
		await expectSameRender(next, UNBALANCED_MD.replace('Broken ', 'Still '));
	});

	test('`[y](./a)1.md)` は最初の `)` で閉じる(行き先 `./a`・DOM の前提の確認)', async () => {
		const m = await mount(UNBALANCED_MD);
		const { el } = blockBySlice(m, 'paragraph', CLOSE_SLICE);
		expect(q(el, 'a').getAttribute('href')).toBe('file:///home/user/notes/a');
	});

	test('`[y](./a)1.md)` を編集して確定しても `./a` のまま(過読みで焼き付かない)', async () => {
		const m = await mount(UNBALANCED_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', CLOSE_SLICE);
		expectBlock(resolveEditTarget(el, m.index), el, 'paragraph');
		editLeadingText(el, 'Shut ');

		const md = serializeBlock(el, meta, UNBALANCED_MD, baseUri);

		expect(md).toContain('[y](./a)');
		expect(md).not.toContain('file://');
		await expectSameRender(md, CLOSE_SLICE.replace('Close ', 'Shut '));
	});
});

/**
 * 追補a(7) の非退行。括弧入りの行き先を読めるようにしても、参照リンクと角括弧付きの
 * 行き先は引き続き source(AC-49-18)。同じ段落に「読める括弧入り」と「戻せない
 * 参照リンク」が混ざれば戻せない側が勝つ(数の突き合わせが括弧の読み取りで狂わない)。
 */
const MIXED_MD = [
	'Mixed [a](./a(1).md) and [o][ref] here.',
	'',
	'Angle [c](<./a (1).md>) here.',
	'',
	'Only [a](./a(1).md) here.',
	'',
	'[ref]: ./other.md',
	'',
].join('\n');

describe('非退行 — 参照リンク・角括弧付き行き先は引き続き source(追補a(7) / AC-49-18)', () => {
	test('括弧入りリンクと参照リンクが同じ段落 → source(戻せない側が勝つ)', async () => {
		const m = await mount(MIXED_MD);
		const { el } = blockBySlice(m, 'paragraph', 'Mixed [a](./a(1).md) and [o][ref] here.');
		expect(q(el, 'a:nth-of-type(2)').getAttribute('href')).toBe('file:///home/user/notes/other.md');
		expect(resolveEditTarget(el, m.index)).toEqual({ kind: 'source' });
	});

	test('角括弧で囲んだ行き先(中に括弧と空白)→ source', async () => {
		const m = await mount(MIXED_MD);
		const { el } = blockBySlice(m, 'paragraph', 'Angle [c](<./a (1).md>) here.');
		expect(resolveEditTarget(el, m.index)).toEqual({ kind: 'source' });
	});

	test('同じ文書の括弧入りリンクだけの段落は block(定義行があるだけでは誘導しない)', async () => {
		const m = await mount(MIXED_MD);
		const { el } = blockBySlice(m, 'paragraph', 'Only [a](./a(1).md) here.');
		expectBlock(resolveEditTarget(el, m.index), el, 'paragraph');
	});
});

// ---------------------------------------------------------------------------
// 追補a(9)— 書き出しの細工が本文を書き換えない(契約⑥ / AC-49-20)
// ---------------------------------------------------------------------------

/**
 * 追補a(8)(c) の実装は、`toMarkdown` が行き先の `(` `)` をエスケープするのを避ける
 * ため、書き出しの間だけ href/src を記号なしの札に差し替えて生成後に原文の綴りへ
 * 戻す。その戻しが**本文全体**に掛かると、本文に札と同じ文字列があった箇所まで
 * 行き先に化ける(4周目の reviewer 実測= `xvellisuri0x [a](./a(1).md) here.` を
 * 確定すると `./a(1).md [a](./a(1).md) here.`)。稀だが確定的なデータ破壊で、
 * AC-49-19 の修正で新たに入った退行。
 *
 * ## 札の綴りを焼き付ける判断
 * 「本文に現れ得る文字列」を表現するには札の綴りそのものが要る(実装の内部表現に
 * 依存する)。焼き付けない書き方(札を実装から export する・DOM から推定する)は
 * 実装側の改変を要するか、修正後には推定できなくなるので採らない。実装が札の綴りを
 * 変えるなら下の定数も一緒に変わるべき ―― それがこの契約の意味(札が何であれ本文を
 * 書き換えない)。綴りは src/markdown/edit.ts の `tokenFor`(`xvellisuri${n}x`・
 * n は発行順の 0 起点)に合わせる。
 *
 * 各段落は1行なので、`blockBySlice` の鍵はその行そのもの。
 */
const TOKEN_0 = 'xvellisuri0x';
const TOKEN_1 = 'xvellisuri1x';

const TOKEN_MD = [
	`${TOKEN_0} [a](./a(1).md) here.`,
	'',
	`Plain ${TOKEN_0} here.`,
	'',
	`Two [a](./a(1).md) ${TOKEN_0} and ${TOKEN_1} [b](./b\\_2.md) here.`,
	'',
	`Text [${TOKEN_0}](./a(1).md) here.`,
	'',
].join('\n');

const TOKEN_LEAD_SLICE = `${TOKEN_0} [a](./a(1).md) here.`;
const TOKEN_PLAIN_SLICE = `Plain ${TOKEN_0} here.`;
// 札はリンクの**間**のテキストノードに置く。末尾ノードは編集で丸ごと差し替えるので、
// そこに札を置くと検証対象が自分の編集で消える。
const TOKEN_TWO_SLICE = `Two [a](./a(1).md) ${TOKEN_0} and ${TOKEN_1} [b](./b\\_2.md) here.`;
const TOKEN_LINKTEXT_SLICE = `Text [${TOKEN_0}](./a(1).md) here.`;

/**
 * 末尾のテキストノードを書き換える(札を含む先頭テキストとリンクには触らない編集)。
 * `editLeadingText` は先頭ノード全体を置き換えるので、札が先頭にある段落では
 * 検証対象そのものが消えてしまう。
 */
function editTrailingText(el: HTMLElement, text: string): void {
	const last = el.lastChild;
	if (!last || last.nodeType !== Node.TEXT_NODE) throw new Error('末尾がテキストではない');
	last.textContent = text;
}

describe('serializeBlock — 札と同じ文字列が本文にあっても行き先に化けない(契約⑥・追補a(9) / AC-49-20)', () => {
	test('reviewer 実測の再現: 本文の札は残り、括弧入りの行き先も原文の綴りのまま(前後は byte 等価)', async () => {
		const m = await mount(TOKEN_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', TOKEN_LEAD_SLICE);
		expectBlock(resolveEditTarget(el, m.index), el, 'paragraph');
		editTrailingText(el, ' there.');

		const md = serializeBlock(el, meta, TOKEN_MD, baseUri);

		expect(md).toBe(`${TOKEN_0} [a](./a(1).md) there.`);
		expect(replaceRange(TOKEN_MD, meta.position, md)).toBe(
			TOKEN_MD.replace(TOKEN_LEAD_SLICE, `${TOKEN_0} [a](./a(1).md) there.`),
		);
	});

	test('リンクが無いブロック(札が1つも発行されない)でも本文の札はそのまま', async () => {
		const m = await mount(TOKEN_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', TOKEN_PLAIN_SLICE);
		expectBlock(resolveEditTarget(el, m.index), el, 'paragraph');
		// 単一テキストノードなので先頭の語だけ差し替えて札と末尾を残す。
		const first = el.firstChild;
		if (!first || first.nodeType !== Node.TEXT_NODE) throw new Error('先頭がテキストではない');
		first.textContent = (first.textContent ?? '').replace('Plain ', 'Still ');

		const md = serializeBlock(el, meta, TOKEN_MD, baseUri);

		expect(md).toBe(`Still ${TOKEN_0} here.`);
		expect(md).not.toContain('file://');
	});

	test('札が複数発行される段落(リンク2本)でも本文の 0 番・1 番の札はそのまま', async () => {
		const m = await mount(TOKEN_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', TOKEN_TWO_SLICE);
		expectBlock(resolveEditTarget(el, m.index), el, 'paragraph');
		editTrailingText(el, ' there.');

		const md = serializeBlock(el, meta, TOKEN_MD, baseUri);

		expect(md).toBe(`Two [a](./a(1).md) ${TOKEN_0} and ${TOKEN_1} [b](./b\\_2.md) there.`);
	});

	test('リンクの文言そのものが札と同じ文字列でも、文言は残り行き先だけが原文の綴りへ戻る', async () => {
		const m = await mount(TOKEN_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', TOKEN_LINKTEXT_SLICE);
		expectBlock(resolveEditTarget(el, m.index), el, 'paragraph');
		editTrailingText(el, ' there.');

		const md = serializeBlock(el, meta, TOKEN_MD, baseUri);

		expect(md).toBe(`Text [${TOKEN_0}](./a(1).md) there.`);
	});
});

/**
 * 追補a(9) の残穴(5周目の reviewer 実測)。`restoreDestinations` は生成後の Markdown で
 * `](札` の形に一致する位置だけを戻す。本文テキストの `](札)` は `toMarkdown` が `]` の
 * 直後の `(` を `\(` へ逃がすので安全だが、**エスケープを通さない構文**では `](札` が
 * そのまま残り、行き先へ化ける:
 * - code span(inline code)の中身: `` `](xvellisuri0x)` `` → `` `](./a(1).md)` ``
 * - リンク文言(label)の中: `]` は `\]` に逃がされるが直後の `(` は逃がされない
 *
 * 基準は AC-49-20 の「本文テキストに現れても、その本文はそのまま残る」そのもので、
 * 上の4件が2つの形を覆っていなかっただけ。手段(接頭辞を本文に現れない綴りへ
 * ずらす等)は固定せず、原文の全文だけを見る。
 */
const TOKEN_CODE_SLICE = `Code \`](${TOKEN_0})\` [a](./a(1).md) here.`;
const TOKEN_LABEL_SLICE = `[a\\](${TOKEN_0} more](./a(1).md) here.`;
const TOKEN_ITEM_SLICE = `- Item \`](${TOKEN_0} x\` [a](./a(1).md) here.`;

const TOKEN_CODE_MD = [TOKEN_CODE_SLICE, '', TOKEN_LABEL_SLICE, '', TOKEN_ITEM_SLICE, ''].join(
	'\n',
);

describe('serializeBlock — エスケープを通さない構文の中の `](札` も行き先に化けない(契約⑥・追補a(9) / AC-49-20)', () => {
	test('reviewer 実測の再現: code span の中身 `](札)` はそのまま残り、行き先だけが原文の綴りへ戻る', async () => {
		const m = await mount(TOKEN_CODE_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', TOKEN_CODE_SLICE);
		expectBlock(resolveEditTarget(el, m.index), el, 'paragraph');
		editTrailingText(el, ' there.');

		const md = serializeBlock(el, meta, TOKEN_CODE_MD, baseUri);

		expect(md).toBe(`Code \`](${TOKEN_0})\` [a](./a(1).md) there.`);
		expect(replaceRange(TOKEN_CODE_MD, meta.position, md)).toBe(
			TOKEN_CODE_MD.replace(TOKEN_CODE_SLICE, `Code \`](${TOKEN_0})\` [a](./a(1).md) there.`),
		);
	});

	test('reviewer 実測の再現: リンク文言の中の `\\](札 ` はそのまま残り、行き先だけが原文の綴りへ戻る', async () => {
		const m = await mount(TOKEN_CODE_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', TOKEN_LABEL_SLICE);
		expectBlock(resolveEditTarget(el, m.index), el, 'paragraph');
		editTrailingText(el, ' there.');

		const md = serializeBlock(el, meta, TOKEN_CODE_MD, baseUri);

		expect(md).toBe(`[a\\](${TOKEN_0} more](./a(1).md) there.`);
	});

	test('リスト項目の中の code span(札の後ろが空白の形 `](札 x`)でも同じ(ブロック種別に依らない)', async () => {
		const m = await mount(TOKEN_CODE_MD);
		const { el, meta } = blockBySlice(m, 'listItem', TOKEN_ITEM_SLICE);
		expectBlock(resolveEditTarget(el, m.index), el, 'listItem');
		editTrailingText(el, ' there.');

		const md = serializeBlock(el, meta, TOKEN_CODE_MD, baseUri);

		expect(md).toBe(`- Item \`](${TOKEN_0} x\` [a](./a(1).md) there.`);
		expect(md).not.toContain('file://');
	});
});

/**
 * 追補a(9) の残穴その2(6周目の reviewer 実測)。札の接頭辞は「ブロックのどこにも
 * 現れない綴り」へ伸ばして衝突を避けるが、**要素境界で割れた札**は見つからない ――
 * `hast-util-to-mdast` は `span` を unwrap する(`handlers/index.js` の `span: all`)ので、
 * DOM 上で `xvellis<span>uri0x</span>` と割れていても出力 Markdown では
 * `xvellisuri0x` に繋がり、行き先の位置に一致して本文が行き先へ化ける。
 *
 * 割れた札が入る入口は2つあり、どちらも覆う:
 * - 原文の inline HTML(`rehype-sanitize` は `span` を通す)を本番 `render` で載せた形
 * - レンダー後の DOM 編集で code span の中に `span` が挿さった形(contenteditable への
 *   ペーストでブラウザが `<span style>` を挿すのと同じ)
 *
 * 平文の `Text ](xvellis<span>uri0x</span>` は `](` が `\(` へ逃げるので無事(対象外)。
 * 基準は AC-49-20 の「本文テキストに現れても、その本文はそのまま残る」そのもので、
 * 手段(接頭辞の探索範囲を DOM のテキストまで広げる等)は固定せず、原文の全文だけを
 * 見る。inline HTML の `<span>` 自体が出力で落ちるのは unwrap による既存の挙動で、
 * この契約の対象ではない(期待値は「札が繋がったまま残る」文字列)。
 */
const TOKEN_SPAN_SLICE = `[a\\](xvellis<span>uri0x</span> more](./a(1).md) here.`;
const TOKEN_SPAN_MD = [TOKEN_SPAN_SLICE, ''].join('\n');

describe('serializeBlock — 要素境界で割れた札(`xvellis<span>uri0x</span>`)も行き先に化けない(契約⑥・追補a(9) / AC-49-20)', () => {
	test('reviewer 実測の再現: 原文の inline HTML で割れた札がリンク文言にあっても、文言は残り行き先だけが原文の綴りへ戻る', async () => {
		const m = await mount(TOKEN_SPAN_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', TOKEN_SPAN_SLICE);
		expectBlock(resolveEditTarget(el, m.index), el, 'paragraph');
		editTrailingText(el, ' there.');

		const md = serializeBlock(el, meta, TOKEN_SPAN_MD, baseUri);

		expect(md).toBe(`[a\\](${TOKEN_0} more](./a(1).md) there.`);
		expect(md).not.toContain('file://');
	});

	test('reviewer 実測の再現: DOM 編集で code span の中に span が挿さり札が割れても、code span の中身はそのまま残る', async () => {
		const m = await mount(TOKEN_CODE_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', TOKEN_CODE_SLICE);
		expectBlock(resolveEditTarget(el, m.index), el, 'paragraph');
		// ペーストでブラウザが挿す `<span>` を再現: `](xvellisuri0x)` を `](xvellis<span>uri0x)</span>` に割る。
		const code = q(el, 'code');
		expect(code.textContent).toBe(`](${TOKEN_0})`);
		code.innerHTML = '](xvellis<span>uri0x)</span>';
		editTrailingText(el, ' there.');

		const md = serializeBlock(el, meta, TOKEN_CODE_MD, baseUri);

		expect(md).toBe(`Code \`](${TOKEN_0})\` [a](./a(1).md) there.`);
		expect(replaceRange(TOKEN_CODE_MD, meta.position, md)).toBe(
			TOKEN_CODE_MD.replace(TOKEN_CODE_SLICE, `Code \`](${TOKEN_0})\` [a](./a(1).md) there.`),
		);
	});
});

// ---------------------------------------------------------------------------
// 追補a(11)— 行き先は要素の原文範囲から読む(契約⑥ / AC-49-21)
// ---------------------------------------------------------------------------

/**
 * 追補a(4) の「原文の行き先を前向きに写した鍵で DOM の href/src と突き合わせる表」
 * が持つ穴(backlog 160・161)。鍵とレンダー結果の正規化が食い違うと表に載らず、
 * しかも行き先の数は合うので追補a(7) の誘導にも掛からず、確定すると内部 URI が
 * 原文へ焼き付く ―― `./a　b.md`(U+3000)は終端判定を Unicode 空白でやると途中で
 * 切れる・`./a[1].md` は DOM で percent-encode される(`a%5B1%5D.md`)・
 * `./a\b.md`(原文は `\\` エスケープ)は `new URL` が `\` を `/` にする・
 * `./a&amp;b.md` はエンティティ解除の有無で食い違う。
 *
 * 要件側の決定(追補a(11)= 2026-09-11 由谷決定)= 突き合わせをやめ、`a` / `img`
 * 自身の `data-source-start` / `data-source-end`(要件#32 のソースマップ)から
 * 原文スライスを採って行き先の綴りを直接読む。これらの行き先は読めるので
 * **block のまま**(誘導へ回さない)であり、確定後の原文は**元の綴りのまま**。
 * AC-49-15 / AC-49-19 の行き先が引き続き保たれることは既存の describe
 * (追補a(4)(8) の節)がそのまま緑であることで判定する(本節では繰り返さない)。
 *
 * 各段落は1行なので、`blockBySlice` の鍵はその行そのもの。
 */
const SLICE_READ_MD = [
	'Wide [w](./a\u3000b.md) here.',
	'',
	'Bracket [k](./a[1].md) here.',
	'',
	'Backslash [s](./a\\\\b.md) here.',
	'',
	'Entity [e](./a&amp;b.md) here.',
	'',
	'Image ![p](images/a[1].png) here.',
	'',
].join('\n');

const WIDE_SLICE = 'Wide [w](./a\u3000b.md) here.';
const BRACKET_SLICE = 'Bracket [k](./a[1].md) here.';
const BACKSLASH_SLICE = 'Backslash [s](./a\\\\b.md) here.';
const ENTITY_SLICE = 'Entity [e](./a&amp;b.md) here.';
const BRACKET_IMG_SLICE = 'Image ![p](images/a[1].png) here.';

describe('AC-49-21 — レンダー結果の DOM では綴りが変形した内部 URI が載っている(前提の確認)', () => {
	test('href / src は内部 URI で、原文の綴り(U+3000・角括弧・バックスラッシュ・エンティティ)と食い違う', async () => {
		const m = await mount(SLICE_READ_MD);
		const href = (slice: string): string =>
			q(blockBySlice(m, 'paragraph', slice).el, 'a').getAttribute('href') ?? '';
		// percent-encode の正確な範囲はレンダー経路の実装に依るので固定せず、
		// 「内部 URI であり、原文の綴りが DOM からは読み取れない」ことだけを前提に置く
		// (この食い違いこそが追補a(4) の表を外す原因= backlog 161)。
		expect(href(WIDE_SLICE).startsWith('file://')).toBe(true);
		expect(href(WIDE_SLICE)).not.toContain('\u3000');
		expect(href(BRACKET_SLICE).startsWith('file://')).toBe(true);
		expect(href(BRACKET_SLICE)).not.toContain('a[1].md');
		expect(href(BACKSLASH_SLICE).startsWith('file://')).toBe(true);
		expect(href(BACKSLASH_SLICE)).not.toContain('\\');
		expect(href(ENTITY_SLICE).startsWith('file://')).toBe(true);
		expect(href(ENTITY_SLICE)).not.toContain('&amp;');
		const src =
			q(blockBySlice(m, 'paragraph', BRACKET_IMG_SLICE).el, 'img').getAttribute('src') ?? '';
		expect(src.startsWith('vellis-asset://')).toBe(true);
	});
});

describe('resolveEditTarget — U+3000・角括弧・エスケープ・エンティティの行き先は読めるので block(誘導へ回さない・追補a(11) / AC-49-21)', () => {
	// 「読めない綴りは source に逃がす」実装を塞ぐ。追補a(7) の誘導対象は
	// 「原理的に戻せない表記」(参照リンク・角括弧付き行き先・生 HTML)だけのまま。
	test.each([
		['ASCII 以外の空白 `[w](./a　b.md)`(U+3000)', WIDE_SLICE],
		['角括弧 `[k](./a[1].md)`', BRACKET_SLICE],
		['エスケープしたバックスラッシュ `[s](./a\\\\b.md)`', BACKSLASH_SLICE],
		['エンティティ参照 `[e](./a&amp;b.md)`', ENTITY_SLICE],
		['角括弧入りの画像 `![p](images/a[1].png)`', BRACKET_IMG_SLICE],
	])('%s の段落 → block', async (_label, slice) => {
		const m = await mount(SLICE_READ_MD);
		const { el } = blockBySlice(m, 'paragraph', slice);
		expectBlock(resolveEditTarget(el, m.index), el, 'paragraph');
	});
});

describe('serializeBlock — U+3000・角括弧・エスケープ・エンティティの行き先は原文の綴りのまま(契約⑥・追補a(11) / AC-49-21)', () => {
	/** 先頭テキストを直して逆シリアライズ(リンク・画像には触らない編集)。 */
	async function edited(slice: string): Promise<string> {
		const m = await mount(SLICE_READ_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', slice);
		editLeadingText(el, 'Edited ');
		return serializeBlock(el, meta, SLICE_READ_MD, baseUri);
	}

	test('U+3000 を含む行き先 `[w](./a　b.md)` は途中で切れず `file://` にも化けない', async () => {
		const md = await edited(WIDE_SLICE);
		expect(md).toBe('Edited [w](./a\u3000b.md) here.');
		expect(md).not.toContain('file://');
	});

	test('角括弧を含む行き先 `[k](./a[1].md)` は percent-encode された形に化けない', async () => {
		const md = await edited(BRACKET_SLICE);
		expect(md).toBe('Edited [k](./a[1].md) here.');
		expect(md).not.toContain('%5B');
		expect(md).not.toContain('file://');
	});

	test('エスケープしたバックスラッシュ `[s](./a\\\\b.md)` は `/` にも解いた形にも化けない', async () => {
		const md = await edited(BACKSLASH_SLICE);
		expect(md).toBe('Edited [s](./a\\\\b.md) here.');
		expect(md).not.toContain('a/b.md');
		expect(md).not.toContain('file://');
	});

	test('エンティティ参照 `[e](./a&amp;b.md)` は解決した `&` に化けない', async () => {
		const md = await edited(ENTITY_SLICE);
		expect(md).toBe('Edited [e](./a&amp;b.md) here.');
		expect(md).not.toContain('](./a&b.md)');
		expect(md).not.toContain('file://');
	});

	test('角括弧を含む画像 `![p](images/a[1].png)` は `vellis-asset://` に化けない', async () => {
		const md = await edited(BRACKET_IMG_SLICE);
		expect(md).toBe('Edited ![p](images/a[1].png) here.');
		expect(md).not.toContain('vellis-asset://');
	});

	test('reviewer 実測の再現(backlog 161): 角括弧の段落を直して差し戻した原文は、綴りが元のままで前後は byte 等価', async () => {
		const m = await mount(SLICE_READ_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', BRACKET_SLICE);
		editLeadingText(el, 'Edited ');

		const next = replaceRange(
			SLICE_READ_MD,
			meta.position,
			serializeBlock(el, meta, SLICE_READ_MD, baseUri),
		);

		expect(next).toBe(SLICE_READ_MD.replace('Bracket ', 'Edited '));
	});
});

// ---------------------------------------------------------------------------
// 追補a(11)— 同じ行き先の別の綴りが畳まれない(契約⑥ / AC-49-22)
// ---------------------------------------------------------------------------

/**
 * URI を鍵にした表は「同じ行き先の別の綴り」を1つに畳む(backlog 154)――
 * `[a](./x.md)` と `[b](x.md)` はどちらも `file:///home/user/notes/x.md` へ
 * 書き換わるので、表を引くと後から現れた方まで先に現れた綴りで戻される。
 * 要素ごとに自分の原文スライスから読めば1対1で対応が付き、それぞれの綴りが残る。
 */
const DUP_MD = [
	'See [a](./x.md) and [b](x.md) here.',
	'',
	'Rev [c](x.md) and [d](./x.md) here.',
	'',
].join('\n');
const DUP_SLICE = 'See [a](./x.md) and [b](x.md) here.';
const DUP_REV_SLICE = 'Rev [c](x.md) and [d](./x.md) here.';

describe('serializeBlock — 同じ行き先の別の綴りは畳まれない(契約⑥・追補a(11) / AC-49-22)', () => {
	test('レンダー結果では2本とも同じ内部 URI に書き換わっている(前提の確認)', async () => {
		const m = await mount(DUP_MD);
		const { el } = blockBySlice(m, 'paragraph', DUP_SLICE);
		const hrefs = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
		expect(hrefs).toEqual(['file:///home/user/notes/x.md', 'file:///home/user/notes/x.md']);
	});

	test('`[a](./x.md)` と `[b](x.md)` がそれぞれ元の綴りのまま残る(先の `./` 付きに揃わない= backlog 154)', async () => {
		const m = await mount(DUP_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', DUP_SLICE);
		expectBlock(resolveEditTarget(el, m.index), el, 'paragraph');
		editLeadingText(el, 'Look ');

		const md = serializeBlock(el, meta, DUP_MD, baseUri);

		expect(md).toBe('Look [a](./x.md) and [b](x.md) here.');
	});

	test('逆順(`./` 無しが先)でもそれぞれ元の綴りのまま残る', async () => {
		const m = await mount(DUP_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', DUP_REV_SLICE);
		editLeadingText(el, 'Back ');

		const md = serializeBlock(el, meta, DUP_MD, baseUri);

		expect(md).toBe('Back [c](x.md) and [d](./x.md) here.');
	});
});

// ---------------------------------------------------------------------------
// 追補a(11)— 本文の `](` は行き先として数えない(契約③⑥ / AC-49-23)
// ---------------------------------------------------------------------------

/**
 * 「戻せるか」を行き先の数と内部 URI の数の突き合わせで判定すると、本文テキストや
 * inline code の `](` が行き先として数えられ、参照リンクが同居するブロックで数が
 * 合ってしまい誘導を逃す(backlog 162)。逃した参照リンクは元スライスから写せない
 * ので、確定すると `file://` が原文へ焼き付く。要件側の決定(追補a(11))=
 * 数え上げをやめ、**内部 URI を持つ要素のうち自分の原文スライスから行き先を
 * 読めないものが1つでもあれば source**。生 HTML のインライン `<img>`
 * (rehype-raw が再パースするので `data-source-*` を持たない)もこれに当たる。
 * 参照リンク・角括弧付き行き先の誘導が保たれること(AC-49-18)は既存の
 * describe(追補a(7) の節)がそのまま緑であることで判定する。
 */
const STRAY_MD = [
	'Text ]( stray and [o][ref] here.',
	'',
	'Code `](./z.md)` and [o][ref] here.',
	'',
	'Raw <img src="./x.png"> here.',
	'',
	'Ctrl `](./z.md)` and [d](./d.md) here.',
	'',
	'[ref]: ./other.md',
	'',
].join('\n');
const STRAY_TEXT_SLICE = 'Text ]( stray and [o][ref] here.';
const STRAY_CODE_SLICE = 'Code `](./z.md)` and [o][ref] here.';
const RAW_IMG_SLICE = 'Raw <img src="./x.png"> here.';
const STRAY_CTRL_SLICE = 'Ctrl `](./z.md)` and [d](./d.md) here.';

describe('resolveEditTarget — 本文の `](` が数を合わせても参照リンクの同居は source(契約③⑥・追補a(11) / AC-49-23)', () => {
	test('参照リンクは内部 URI に書き換わり、生 HTML の <img> は data-source-* を持たない(前提の確認)', async () => {
		const m = await mount(STRAY_MD);
		const text = blockBySlice(m, 'paragraph', STRAY_TEXT_SLICE);
		expect(q(text.el, 'a').getAttribute('href')).toBe('file:///home/user/notes/other.md');
		const img = q(blockBySlice(m, 'paragraph', RAW_IMG_SLICE).el, 'img');
		expect(img.hasAttribute('data-source-start')).toBe(false);
		expect((img.getAttribute('src') ?? '').startsWith('vellis-asset://')).toBe(true);
	});

	test('本文テキストに `](` を含み参照リンクが同居する段落 → source(数え上げの抜け道を塞ぐ= backlog 162)', async () => {
		const m = await mount(STRAY_MD);
		const { el } = blockBySlice(m, 'paragraph', STRAY_TEXT_SLICE);
		expect(resolveEditTarget(el, m.index)).toEqual({ kind: 'source' });
	});

	test('inline code に `](./z.md)` を含み参照リンクが同居する段落 → source', async () => {
		const m = await mount(STRAY_MD);
		const { el } = blockBySlice(m, 'paragraph', STRAY_CODE_SLICE);
		expect(resolveEditTarget(el, m.index)).toEqual({ kind: 'source' });
	});

	test('生 HTML のインライン `<img src="./x.png">` を含む段落 → source(読めない内部 URI が1つでもあれば誘導)', async () => {
		const m = await mount(STRAY_MD);
		const { el } = blockBySlice(m, 'paragraph', RAW_IMG_SLICE);
		expect(resolveEditTarget(el, m.index)).toEqual({ kind: 'source' });
	});

	test('inline code の `](` があっても読めるインラインリンクだけなら block のまま(本文の `](` は数えない)', async () => {
		const m = await mount(STRAY_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', STRAY_CTRL_SLICE);
		expectBlock(resolveEditTarget(el, m.index), el, 'paragraph');
		editTrailingText(el, ' there.');

		const md = serializeBlock(el, meta, STRAY_MD, baseUri);

		expect(md).toBe('Ctrl `](./z.md)` and [d](./d.md) there.');
		expect(md).not.toContain('file://');
	});
});

// ---------------------------------------------------------------------------
// 追補a(13)— 札の接頭辞は入力の長さに比例する手間で決まる(AC-49-24)
// ---------------------------------------------------------------------------

/**
 * 追補a(9) の札は「ブロックのどこにも現れない綴り」まで接頭辞を伸ばして衝突を
 * 避けるが、`x` を1つずつ足しながら本文へ `includes` を掛ける素朴な実装は、
 * 札の芽 `xvellisuri` の後ろに `x` が長く続く病的な本文で入力長の二乗になる
 * (reviewer 実測=10万文字で 1.75 秒。backlog 164)。現実の文書では起きないが、
 * 確定が固まる形の遅さは残さない ―― 接頭辞決定は一度の走査(入力長に比例する
 * 手間)で行う。
 *
 * 閾値は環境差で不安定にならないよう緩く**1秒**に置く(線形なら数十 ms・二乗なら
 * 秒単位なので、この間のどこでも判別できる)。入力サイズは固定(10万文字規模)。
 * 計測は `serializeBlock` 単体(レンダーと DOM 構築は計測の外)。
 */
const PATHOLOGICAL_RUN = `xvellisuri${'x'.repeat(100_000)}`;
const PATHOLOGICAL_SLICE = `${PATHOLOGICAL_RUN} [a](./a(1).md) here.`;
const PATHOLOGICAL_MD = `${PATHOLOGICAL_SLICE}\n`;

describe('serializeBlock — 病的な本文でも接頭辞決定が入力長の二乗にならない(追補a(13) / AC-49-24)', () => {
	test(
		'`xvellisuri` + `x`×10万 の本文を含むブロックの serializeBlock が1秒未満で返る',
		async () => {
			const m = await mount(PATHOLOGICAL_MD);
			const { el, meta } = blockBySlice(m, 'paragraph', PATHOLOGICAL_SLICE);
			expectBlock(resolveEditTarget(el, m.index), el, 'paragraph');
			editTrailingText(el, ' there.');

			const t0 = performance.now();
			const md = serializeBlock(el, meta, PATHOLOGICAL_MD, baseUri);
			const elapsed = performance.now() - t0;

			expect(elapsed).toBeLessThan(1000);
			// 速くなっても結果が壊れては意味がない: 病的な走りも行き先の綴りもそのまま。
			expect(md).toBe(`${PATHOLOGICAL_RUN} [a](./a(1).md) there.`);
		},
		// 現行実装(1.75 秒)でも test timeout ではなく閾値の assert で赤になるよう、
		// テスト自体の制限時間は長めに取る。
		15_000,
	);
});

// ---------------------------------------------------------------------------
// 追補a(11)「位置の基準」— 再編集でも行き先は初回レンダーの原文から読む(契約⑥ / AC-49-25)
// ---------------------------------------------------------------------------

/**
 * 4周目の reviewer 実測(backlog 165)。`a` / `img` の `data-source-start` /
 * `data-source-end` は**初回レンダー基準の絶対 offset**なのに、行き先を読むスライスを
 * 確定後の原文(`source` と補正後の `position`)から切ると、**同じブロックを2回
 * 続けて編集**したとき ―― 1回目の確定でブロックの中身の長さが初回と変わっている
 * ため ―― 2回目の窓が子の offset と対応せず、読めなかった行き先は DOM の
 * `file://` のまま原文へ焼き付く。しかもダブルクリックの門(`hasIrreversibleLink`)は
 * `index.sliceOf`(初回レンダーのスライス)で判定するので素通りする。伸長・短縮の
 * 両方向で再現。
 *
 * 要件側の決定(追補a(11)「位置の基準」)= 行き先を読むスライスも**初回レンダー
 * 基準の原文**(`index.sliceOf(meta.id)` = 門が見るのと同じもの)から、ブロック
 * 要素自身の `data-source-start` を基準にした相対位置で採る。この判定のため
 * `serializeBlock` は第5引数 `originSlice` を受ける ――
 * `serializeBlock(el, meta, source, baseUri, originSlice)`。省略時は従来どおり
 * `source` と `meta.position` から採る(単発編集では同じ値になる)ので、既存の
 * 3〜4引数の呼び出しはそのまま。マーカーの採取と差し替え範囲は従来どおり
 * **現在の原文**から(こちらは「いま差し替える範囲」の話)。
 */
const REEDIT_MD = 'Intro [x](./a.md) tail.\n\nSecond paragraph stays.\n';
const REEDIT_SLICE = 'Intro [x](./a.md) tail.';
const REEDIT_BOTH_MD =
	'Intro [x](./a.md) and ![p](images/cat.png) tail.\n\nSecond paragraph stays.\n';
const REEDIT_BOTH_SLICE = 'Intro [x](./a.md) and ![p](images/cat.png) tail.';
const REEDIT_IMG_MD = 'Intro ![p](images/cat.png) tail.\n\nSecond paragraph stays.\n';
const REEDIT_IMG_SLICE = 'Intro ![p](images/cat.png) tail.';

/**
 * 確定1回分(Viewer の commitBlockEdit と同じ配線): 行き先は初回レンダーの
 * スライス(`index.sliceOf(meta.id)`)から読み、差し替えは現在の原文 `source` と
 * 補正後の `position` に当てる。戻り値は確定後の原文と、同じブロックの次の確定に
 * 使う補正後の meta(追補a(1) の delta 補正で endOffset だけが動く形)。
 */
function commitReedit(
	m: Mounted,
	source: string,
	el: HTMLElement,
	meta: NodeMeta,
): { next: string; meta: NodeMeta } {
	const md = serializeBlock(el, meta, source, baseUri, m.index.sliceOf(meta.id));
	const next = replaceRange(source, meta.position, md);
	const position: SourcePosition = {
		...meta.position,
		endOffset: meta.position.startOffset + md.length,
	};
	return { next, meta: { ...meta, position } };
}

describe('serializeBlock — 同じブロックの再編集でも行き先は初回レンダーの原文から読む(契約⑥・追補a(11) / AC-49-25)', () => {
	test('reviewer 実測の再現(伸長): 1回目で先頭を長くし、2回目で末尾を直しても行き先は元の綴りのまま', async () => {
		const m = await mount(REEDIT_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', REEDIT_SLICE);
		expectBlock(resolveEditTarget(el, m.index), el, 'paragraph');

		editLeadingText(el, 'A much longer intro ');
		const first = commitReedit(m, REEDIT_MD, el, meta);
		expect(first.next).toBe('A much longer intro [x](./a.md) tail.\n\nSecond paragraph stays.\n');

		editTrailingText(el, ' new tail.');
		const second = commitReedit(m, first.next, el, first.meta);

		// reviewer 実測: "A much longer intro [x](file:///home/user/notes/a.md) new tail.\n\n…"
		expect(second.next).toBe(
			'A much longer intro [x](./a.md) new tail.\n\nSecond paragraph stays.\n',
		);
		expect(second.next).not.toContain('file://');
	});

	test('短縮方向でも同じ: 1回目で先頭を縮めてから2回目で末尾を直す', async () => {
		const m = await mount(REEDIT_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', REEDIT_SLICE);

		editLeadingText(el, 'I ');
		const first = commitReedit(m, REEDIT_MD, el, meta);
		expect(first.next).toBe('I [x](./a.md) tail.\n\nSecond paragraph stays.\n');

		editTrailingText(el, ' new tail.');
		const second = commitReedit(m, first.next, el, first.meta);

		expect(second.next).toBe('I [x](./a.md) new tail.\n\nSecond paragraph stays.\n');
	});

	test('リンクと画像が同居する段落の再編集(伸長)でも両方の綴りが残る', async () => {
		const m = await mount(REEDIT_BOTH_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', REEDIT_BOTH_SLICE);

		editLeadingText(el, 'A much longer intro ');
		const first = commitReedit(m, REEDIT_BOTH_MD, el, meta);
		expect(first.next).toBe(
			'A much longer intro [x](./a.md) and ![p](images/cat.png) tail.\n\nSecond paragraph stays.\n',
		);

		editTrailingText(el, ' new tail.');
		const second = commitReedit(m, first.next, el, first.meta);

		expect(second.next).toBe(
			'A much longer intro [x](./a.md) and ![p](images/cat.png) new tail.\n\nSecond paragraph stays.\n',
		);
		expect(second.next).not.toMatch(/file:\/\/|vellis-asset:\/\//);
	});

	test('画像だけの段落の再編集(短縮)でも `vellis-asset://` に化けない', async () => {
		const m = await mount(REEDIT_IMG_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', REEDIT_IMG_SLICE);

		editLeadingText(el, 'I ');
		const first = commitReedit(m, REEDIT_IMG_MD, el, meta);
		expect(first.next).toBe('I ![p](images/cat.png) tail.\n\nSecond paragraph stays.\n');

		editTrailingText(el, ' new tail.');
		const second = commitReedit(m, first.next, el, first.meta);

		expect(second.next).toBe('I ![p](images/cat.png) new tail.\n\nSecond paragraph stays.\n');
		expect(second.next).not.toContain('vellis-asset://');
	});

	test('3回目の確定でも壊れない(補正後の位置と初回スライスの組で続けられる)', async () => {
		const m = await mount(REEDIT_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', REEDIT_SLICE);

		editLeadingText(el, 'A much longer intro ');
		const first = commitReedit(m, REEDIT_MD, el, meta);
		editTrailingText(el, ' new tail.');
		const second = commitReedit(m, first.next, el, first.meta);
		editTrailingText(el, ' third tail.');
		const third = commitReedit(m, second.next, el, second.meta);

		expect(third.next).toBe(
			'A much longer intro [x](./a.md) third tail.\n\nSecond paragraph stays.\n',
		);
	});

	test('originSlice を省略した従来の4引数の呼び方は、単発編集で従来どおり(非退行)', async () => {
		const m = await mount(REEDIT_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', REEDIT_SLICE);
		editLeadingText(el, 'Look ');

		const md = serializeBlock(el, meta, REEDIT_MD, baseUri);

		expect(md).toBe('Look [x](./a.md) tail.');
		expect(md).not.toContain('file://');
	});
});
