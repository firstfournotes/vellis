/**
 * 要件#73 の受け入れテスト(docs/requirements/req-73.md)— 脚注の行き来の対応
 * (AC-73-1・AC-73-2)
 *
 * 「Markdown の脚注参照 `[^1]` をクリックすると脚注の定義へ、定義の戻りリンクを
 * クリックすると参照の位置へ移動する」。実機のスクロール(契約 1・2 の可視域)は
 * E2E(AC-73-3 = tests/e2e/specs/release-smoke.e2e.ts の脚注の it)が担う。ここでは
 * `render()`(src/markdown/renderer.ts)の最終 HTML を JSDOM に流し込み、**契約 3 =
 * `href` と `id` の対応**を判定する。
 *
 * ## 判定するもの(契約番号は req-73.md の 1〜5)
 * - AC-73-1(契約 3・契約 4 の不変): `[^1]`・名前付き `[^note]`・同じ脚注の 2 回参照を
 *   含む Markdown と、`fixtures/sample.md` そのものを描画した HTML で、
 *   (a) 参照 `a[data-footnote-ref]` の `href="#X"` に対し `id="X"` の要素が**同じ文書の中に
 *       ちょうど 1 つ**あり、それが脚注欄 `section[data-footnotes]` の `li`
 *   (b) 戻りリンク `a[data-footnote-backref]` の `href="#Y"` に対し `id="Y"` の要素が
 *       ちょうど 1 つあり、それが脚注参照 `a[data-footnote-ref]`
 *   (c) 2 回参照した脚注では、2 つの参照の `id` と定義の 2 つの戻りリンクの行き先が
 *       1 対 1 で対応する(同じ参照へ 2 本とも向く・片方が宙に浮く、を塞ぐ)
 *   (d) 不変: 参照の `href` は `#user-content-fn-<label>` のまま(要件49 AC-49-30 の
 *       逆写像が依存)・戻りリンクの `href` は `#user-content-fnref-<label>…` のまま。
 *       `#user-content-user-content-…` へ寄せて対応を取る逃げ方は (d) で落ちる
 * - AC-73-2(契約 4 の不変=sanitize の規則は変えない): raw HTML の `<div id="x">` は
 *   従来どおり `id="user-content-x"`
 *
 * ## 赤/緑の設計(test-runner 向け)
 * - 2026-10-05 の実測(req-73.md「いまの状態」): 参照は `href="#user-content-fn-1"` /
 *   `id="user-content-user-content-fnref-1"`、定義は `id="user-content-user-content-fn-1"`、
 *   戻りリンクは `href="#user-content-fnref-1"`。remark-rehype が `user-content-` 付きで
 *   id を出し、rehype-sanitize の clobber が id にだけもう一度付ける。
 *   → AC-73-1 の (a)(b)(c) は「`href` の先の id を持つ要素が 0 個」で**赤**になる見込み。
 *   (d) と「aria-describedby の対応」・AC-73-2 は現状でも緑(不変のガード)。
 *
 * ## 判定しないもの
 * - クリックで `article.viewer` がスクロールするか(契約 1・2・5 後段)→ AC-73-3(E2E)
 * - 見出しアンカー(要件61)・一般の `#見出し` リンク → 要件61(先取りしない)
 * - raw HTML の `<div id="fn-1">` が脚注の定義の id と衝突する形 → 契約に規定なし(申し送り)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { render } from './renderer';

const baseUri = 'file:///home/user/notes/doc.md';

/** `fixtures/sample.md` 相当: `[^1]`・名前付き `[^note]`・同じ脚注(`[^1]`)の 2 回参照。 */
const FOOTNOTE_MD = [
	'# Doc',
	'',
	'Vellis は単一インスタンスアプリ[^1] で、IPC は Unix Domain Socket[^note] を使います。',
	'',
	'もう一度 1 番を参照する[^1]。',
	'',
	'[^1]: 複数の CLI 起動は自動的に既存ウィンドウへ転送される。',
	'[^note]: macOS / Linux で利用可能。',
	'',
].join('\n');

const SAMPLE_MD = readFileSync(resolve(__dirname, '../../fixtures/sample.md'), 'utf8');

const REF = 'sup a[data-footnote-ref]';
const BACKREF = 'a[data-footnote-backref]';
const DEF_ITEM = 'section[data-footnotes] li';

interface Mounted {
	html: string;
	root: HTMLDivElement;
}

async function mount(source: string, uri = baseUri): Promise<Mounted> {
	const result = await render(source, uri);
	const root = document.createElement('div');
	root.innerHTML = result.html;
	return { html: result.html, root };
}

function qa(scope: ParentNode, selector: string): HTMLElement[] {
	return [...scope.querySelectorAll(selector)] as HTMLElement[];
}

/** 属性を取り、無ければ理由付きで落とす(未実装時の赤の入口)。 */
function attr(el: Element, name: string): string {
	const v = el.getAttribute(name);
	if (v === null) throw new Error(`属性 ${name} が無い: ${el.outerHTML.slice(0, 120)}`);
	return v;
}

/** `href="#X"` の `X`。`#` 始まりでなければ落とす(同じ文書の中のリンクであること)。 */
function fragmentOf(el: Element): string {
	const href = attr(el, 'href');
	if (!href.startsWith('#') || href.length < 2) {
		throw new Error(`同じ文書内の # リンクでない: href="${href}"`);
	}
	return href.slice(1);
}

/** 文書(root)の中で `id` が一致する要素をすべて返す(契約 3「ちょうど 1 つ」の判定用)。 */
function byId(root: ParentNode, id: string): HTMLElement[] {
	return qa(root, '[id]').filter((el) => el.getAttribute('id') === id);
}

/**
 * 契約 3 を 1 文書ぶん判定する共通手順。失敗メッセージに href / id の実測を含めて、
 * 赤の理由(どの対応が取れていないか)が診断なしで読めるようにする。
 */
function expectFootnoteLinksResolve(m: Mounted): void {
	const refs = qa(m.root, REF);
	const backrefs = qa(m.root, BACKREF);
	expect(refs.length, '脚注参照が見つからない').toBeGreaterThan(0);
	expect(backrefs.length, '戻りリンクが見つからない').toBeGreaterThan(0);

	// (a) 参照 → 定義: href の先に id を持つ要素がちょうど 1 つ、それは脚注欄の li
	for (const ref of refs) {
		const target = fragmentOf(ref);
		const hits = byId(m.root, target);
		expect(
			hits.map((h) => h.outerHTML.slice(0, 80)),
			`参照 href="#${target}" に対応する id の要素がちょうど 1 つでない(実測 id 一覧: ${allIds(m.root).join(', ')})`,
		).toHaveLength(1);
		expect(hits[0]!.matches(DEF_ITEM), `参照 href="#${target}" の先が脚注欄の li でない`).toBe(true);
	}

	// (b) 戻りリンク → 参照: href の先に id を持つ要素がちょうど 1 つ、それは脚注参照
	for (const back of backrefs) {
		const target = fragmentOf(back);
		const hits = byId(m.root, target);
		expect(
			hits.map((h) => h.outerHTML.slice(0, 80)),
			`戻りリンク href="#${target}" に対応する id の要素がちょうど 1 つでない(実測 id 一覧: ${allIds(m.root).join(', ')})`,
		).toHaveLength(1);
		expect(hits[0]!.matches(REF), `戻りリンク href="#${target}" の先が脚注参照でない`).toBe(true);
	}

	// (c) 全体で 1 対 1: 戻りリンクの行き先の集合 == 参照の id の集合(重複なし)
	const refIds = refs.map((r) => attr(r, 'id'));
	const backTargets = backrefs.map((b) => fragmentOf(b));
	expect(new Set(refIds).size, '参照の id が重複している').toBe(refIds.length);
	expect(new Set(backTargets).size, '戻りリンクの行き先が重複している').toBe(backTargets.length);
	expect([...backTargets].sort()).toEqual([...refIds].sort());
}

function allIds(root: ParentNode): string[] {
	return qa(root, '[id]').map((el) => el.getAttribute('id') ?? '');
}

describe('AC-73-1 — 脚注参照の href と定義の id、戻りリンクの href と参照の id が同じ文書の中で対応する(契約 3)', () => {
	test('前提: 描画結果に脚注参照 3 つ(1・note・1 の再参照)と定義 2 つがある', async () => {
		const m = await mount(FOOTNOTE_MD);
		expect(qa(m.root, REF)).toHaveLength(3);
		expect(qa(m.root, DEF_ITEM)).toHaveLength(2);
		// 2 回参照された [^1] の定義には戻りリンクが 2 本、[^note] には 1 本
		expect(qa(m.root, BACKREF)).toHaveLength(3);
	});

	test('参照 → 定義・戻りリンク → 参照の対応がすべて取れている(`[^1]`・`[^note]`・2 回参照)', async () => {
		const m = await mount(FOOTNOTE_MD);
		expectFootnoteLinksResolve(m);
	});

	test('`[^1]` の参照は `#user-content-fn-1`、その先の li がある(個別の確認)', async () => {
		const m = await mount(FOOTNOTE_MD);
		const [first] = qa(m.root, REF);
		expect(attr(first!, 'href')).toBe('#user-content-fn-1');
		const hits = byId(m.root, 'user-content-fn-1');
		expect(hits, `id="user-content-fn-1" の要素(実測 id 一覧: ${allIds(m.root).join(', ')})`).toHaveLength(1);
		expect(hits[0]!.matches(DEF_ITEM)).toBe(true);
	});

	test('名前付き `[^note]` の参照は `#user-content-fn-note`、その先の li がある', async () => {
		const m = await mount(FOOTNOTE_MD);
		const ref = qa(m.root, REF).find((a) => attr(a, 'href') === '#user-content-fn-note');
		expect(ref, '`href="#user-content-fn-note"` の参照が無い').toBeDefined();
		const hits = byId(m.root, 'user-content-fn-note');
		expect(hits, `id="user-content-fn-note" の要素(実測 id 一覧: ${allIds(m.root).join(', ')})`).toHaveLength(1);
		expect(hits[0]!.matches(DEF_ITEM)).toBe(true);
	});

	test('同じ脚注の 2 回参照: 2 つの参照は同じ href で id は別、定義の 2 本の戻りリンクがそれぞれの参照へ戻る', async () => {
		const m = await mount(FOOTNOTE_MD);
		const ones = qa(m.root, REF).filter((a) => attr(a, 'href') === '#user-content-fn-1');
		expect(ones).toHaveLength(2);
		const [id1, id2] = ones.map((a) => attr(a, 'id'));
		expect(id1).not.toBe(id2);

		const def = byId(m.root, 'user-content-fn-1')[0];
		expect(def, `id="user-content-fn-1" の定義が無い(実測 id 一覧: ${allIds(m.root).join(', ')})`).toBeDefined();
		const backs = qa(def!, BACKREF);
		expect(backs).toHaveLength(2);
		expect(backs.map((b) => fragmentOf(b)).sort()).toEqual([id1!, id2!].sort());
		for (const b of backs) {
			const hits = byId(m.root, fragmentOf(b));
			expect(hits).toHaveLength(1);
			expect(hits[0]!.matches(REF)).toBe(true);
		}
	});

	test('`fixtures/sample.md`(E2E AC-73-3 と同じ文書)でも対応がすべて取れている', async () => {
		const m = await mount(SAMPLE_MD, 'file:///fixtures/sample.md');
		expect(qa(m.root, REF).length).toBeGreaterThanOrEqual(2);
		expectFootnoteLinksResolve(m);
	});

	test('文書の中の id は重複しない(`#` の先が 2 つ以上に当たらない)', async () => {
		for (const src of [FOOTNOTE_MD, SAMPLE_MD]) {
			const m = await mount(src);
			const ids = allIds(m.root);
			expect(new Set(ids).size, `重複した id: ${ids.filter((x, i) => ids.indexOf(x) !== i).join(', ')}`).toBe(ids.length);
		}
	});
});

describe('AC-73-1 — 不変(契約 4): href の形は変えない(要件49 AC-49-30 の逆写像が依存)', () => {
	test('参照の href は `#user-content-fn-<label>` の形のまま(二重前置へ寄せない)', async () => {
		const m = await mount(FOOTNOTE_MD);
		const hrefs = qa(m.root, REF).map((a) => attr(a, 'href'));
		expect(hrefs).toEqual(['#user-content-fn-1', '#user-content-fn-note', '#user-content-fn-1']);
		for (const h of hrefs) expect(h).toMatch(/^#user-content-fn-/);
	});

	test('戻りリンクの href は `#user-content-fnref-<label>…` の形のまま(再参照は `-2` 付き)', async () => {
		const m = await mount(FOOTNOTE_MD);
		const hrefs = qa(m.root, BACKREF).map((a) => attr(a, 'href'));
		expect(hrefs.sort()).toEqual(['#user-content-fnref-1', '#user-content-fnref-1-2', '#user-content-fnref-note']);
		for (const h of hrefs) expect(h).toMatch(/^#user-content-fnref-/);
	});

	test('href も id も `user-content-user-content-` を含まない', async () => {
		const m = await mount(FOOTNOTE_MD);
		expect(m.html).not.toContain('user-content-user-content-');
	});

	test('参照の aria-describedby と脚注欄見出しの id の対応は崩れない(現状の実測を固定)', async () => {
		const m = await mount(FOOTNOTE_MD);
		for (const ref of qa(m.root, REF)) {
			const described = attr(ref, 'aria-describedby');
			const hits = byId(m.root, described);
			expect(hits, `aria-describedby="${described}" に対応する id の要素`).toHaveLength(1);
			expect(hits[0]!.closest('section[data-footnotes]')).not.toBeNull();
		}
	});
});

describe('AC-73-2 — raw HTML の id は従来どおり `user-content-` 前置(契約 4: sanitize の規則は変えない)', () => {
	test('`<div id="x">` は `id="user-content-x"`', async () => {
		const m = await mount('Intro.\n\n<div id="x">\n\nraw block\n\n</div>\n');
		const div = m.root.querySelector('div[id]');
		expect(div, '<div id> が残っていない').not.toBeNull();
		expect(div!.getAttribute('id')).toBe('user-content-x');
		expect(byId(m.root, 'x')).toHaveLength(0);
	});

	test('脚注と raw HTML の id が同じ文書にあっても、raw HTML 側の前置は `user-content-` 一重のまま', async () => {
		const m = await mount(`${FOOTNOTE_MD}\n<div id="x">\n\nraw block\n\n</div>\n`);
		expect(byId(m.root, 'user-content-x')).toHaveLength(1);
		expect(byId(m.root, 'user-content-user-content-x')).toHaveLength(0);
	});

	test('inline の raw HTML `<span id="y">` も `user-content-y`', async () => {
		const m = await mount('Text <span id="y">here</span>.\n');
		const span = m.root.querySelector('span[id]');
		expect(span).not.toBeNull();
		expect(span!.getAttribute('id')).toBe('user-content-y');
	});
});
