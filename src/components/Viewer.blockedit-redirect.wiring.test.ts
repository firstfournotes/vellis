/**
 * 要件#49 追補f の受け入れテスト(docs/requirements/req-49.md「### 追補f」・AC-49-35〜36)
 * — Viewer の配線(component プロジェクト)
 *
 * 純関数(`resolveEditTarget`)の判定は src/markdown/edit-redirect.acceptance.test.ts
 * (unit 側)。ここは `Viewer.svelte` を JSDOM にマウントし、本番パイプライン(`render`)
 * の HTML と `SourceIndex` を props に渡して、**ダブルクリック→ソース編集モードへの誘導**
 * (`handleDoubleClick` が `source` を受けたときの経路=要件#48 のソース編集モード)を判定する。
 * Viewer.blockedit.wiring.test.ts(既存)は AC-49-26 入れ子の3件を追補f(4) で書き換えるほかは
 * 触らず、本追補用に新設。
 *
 * ## 判定するもの
 * - **AC-49-35(契約①③・追補f(1)(3)・backlog 148)**: 子リストを持つ外側の項目・2段落の緩い
 *   項目をダブルクリックすると、その項目は contenteditable にならず、要件#48 のソース編集
 *   モード(editMode=edit・`<pre class="vellis-plaintext" contenteditable>` に原文)へ切り替わる。
 *   原文(`document.content`)は変わらず、誘導だけで dirty にはならない。先にほかのブロック
 *   (内側の項目・項目の中の段落)を確定して dirty なら、その確定と dirty は保たれ、`<pre>` に
 *   出る原文は差し替え後の内容(追補a(3) と同じ)。子の項目・項目の中の段落は従来どおり
 *   ブロック編集に入れる(非退行)
 * - **AC-49-36(契約③・追補f(2)(3)・backlog 256)**: 脚注欄の定義の段落(戻りリンク `↩` の
 *   上でも)をダブルクリックするとソース編集モードへ切り替わり、原文に
 *   `[↩](#user-content-fnref-…)` が書き込まれない。本文の脚注参照を含む段落は従来どおり
 *   ブロック編集に入れる(AC-49-30 の回帰)。先に本文を確定して dirty なら、その確定と dirty
 *   は保たれる
 *
 * ## 判定しないもの
 * - 判定の網羅(fence / 引用 / 表が続く項目・引用の中の入れ子・複数段落の定義・定義の中の
 *   リスト項目・生 HTML の `<div class="footnotes">`)→ unit 側
 * - 該当行へのキャレット移動(任意)・編集中の見た目 → reviewer 照合+人間ゲート
 *
 * ## スタブの設計(Viewer.blockedit.wiring.test.ts の家風)
 * - $lib/ipc / @tauri-apps/plugin-opener / @tauri-apps/plugin-dialog / $lib/mermaid-mounter:
 *   モジュールモック
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
	openUrl: vi.fn(async () => undefined),
	openPath: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn() }));
vi.mock('$lib/mermaid-mounter', () => ({
	mountMermaid: vi.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const MD_URI = 'file:///Users/a/notes/redirect.md';

type Rendered = { html: string; index: SourceIndex };

/** 子リストを持つ外側の項目(backlog 148 の再現)。 */
const NESTED_MD = ['# Title', '', '- outer item', '  - inner item', '', 'Tail.', ''].join('\n');
const INNER_ITEM = 'inner item';
const INNER_EDITED = 'inner EDITED';

/** 2段落の緩い項目(backlog 148 の再現)。 */
const LOOSE_TWO_MD = ['# Title', '', '- first para', '', '  second para', '', 'Tail.', ''].join('\n');
const FIRST_PARA = 'first para';
const FIRST_PARA_EDITED = 'first EDITED';

/** 脚注の定義(backlog 256 の再現)。 */
const FN_MD = ['# Title', '', 'Text with note[^1] here.', '', '[^1]: First note.', ''].join('\n');
const FN_BODY = 'Text with note[^1] here.';
const FN_BODY_EDITED = 'Edited body.';
const FN_DEF_TEXT = 'First note.';
/** 戻りリンクが Markdown のリンクとして焼き付いたときに原文へ現れる綴り(backlog 256 実測)。 */
const BAKED_BACKREF = '[↩](#user-content-fnref-';

let renderedNested: Rendered;
let renderedLooseTwo: Rendered;
let renderedFn: Rendered;

beforeAll(async () => {
	const [nested, loose, fn] = await Promise.all([
		renderMarkdown(NESTED_MD, MD_URI),
		renderMarkdown(LOOSE_TWO_MD, MD_URI),
		renderMarkdown(FN_MD, MD_URI),
	]);
	renderedNested = { html: nested.html, index: nested.index };
	renderedLooseTwo = { html: loose.html, index: loose.index };
	renderedFn = { html: fn.html, index: fn.index };
});

/** 任意の markdown 文書を windowState と Viewer の両方に載せてマウントする。 */
function mountDoc(content: string, r: Rendered) {
	const doc: DocumentPayload = { uri: MD_URI, content, modified: 1 };
	windowState.setDocument(doc);
	return render(Viewer, {
		props: {
			document: doc,
			html: r.html,
			index: r.index,
			onRequestAddMark: vi.fn(),
			onToggleMarks: vi.fn(),
			marksOpen: false,
		},
	});
}

function q(scope: ParentNode, selector: string): HTMLElement {
	const el = scope.querySelector(selector);
	if (!el) throw new Error(`要素が見つからない: ${selector}`);
	return el as HTMLElement;
}

/** 文書順のリスト項目(脚注欄の外)。 */
function listItems(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll('li[data-vellis-node-type="listItem"]')].filter(
		(el) => !el.closest('section[data-footnotes]'),
	) as HTMLElement[];
}

/** 文書順の段落(脚注欄の外)。 */
function paragraphs(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll('p[data-vellis-node-type="paragraph"]')].filter(
		(el) => !el.closest('section[data-footnotes]'),
	) as HTMLElement[];
}

/** 脚注欄(`section[data-footnotes]`)の中の定義の段落。 */
function footnoteDefParagraph(container: HTMLElement): HTMLElement {
	return q(container, 'section[data-footnotes] li p[data-vellis-node-type="paragraph"]');
}

/** contenteditable が有効か(属性なし・"false" はどちらも「無効」)。 */
function isEditable(el: Element): boolean {
	return el.getAttribute('contenteditable') === 'true';
}

function editables(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll('[contenteditable="true"]')] as HTMLElement[];
}

/** contenteditable="true" がちょうど `target` の1要素だけであること(同一性で判定)。 */
function expectOnlyEditable(container: HTMLElement, target: Element): void {
	const list = editables(container);
	expect(list).toHaveLength(1);
	expect(list[0]).toBe(target);
}

/** ソース編集モードの `<pre>`(要件#48)。無ければ null。 */
function sourcePre(container: HTMLElement): HTMLElement | null {
	return container.querySelector('pre.vellis-plaintext');
}

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}

/** ブロックをダブルクリックする(編集に入る、または誘導される)。 */
async function doubleClick(el: HTMLElement) {
	await fireEvent.dblClick(el);
	await settle();
}

/** ブロック外(見出し)をクリックして確定する。 */
async function clickOutside(container: HTMLElement) {
	const other = q(container, 'h1[data-vellis-node-type="heading"]');
	await fireEvent.mouseDown(other);
	await fireEvent.click(other);
	await settle();
}

/** ブロックをダブルクリックして編集に入り、中身を `text` へ書き換えて確定する。 */
async function editAndCommit(container: HTMLElement, el: HTMLElement, text: string) {
	await doubleClick(el);
	expect(isEditable(el)).toBe(true);
	el.textContent = text;
	await fireEvent.input(el);
	await clickOutside(container);
}

/** `md` の `from` を `to` へ差し替えた期待原文(その範囲だけが変わる)。 */
function replaced(md: string, from: string, to: string): string {
	if (!md.includes(from)) throw new Error(`期待原文の組み立てで "${from}" が無い`);
	return md.replace(from, to);
}

/**
 * ソース編集モードへ誘導されていること(要件#48 のソース編集モード・AC-49-2 と同じ形):
 * editMode=edit・`<pre class="vellis-plaintext" contenteditable>` に `content`・他に編集可な
 * 要素が無い・`editBuffer` も `content`。
 */
function expectSourceEditing(container: HTMLElement, content: string) {
	expect(windowState.editMode).toBe('edit');
	expect(windowState.editBuffer).toBe(content);
	const pre = sourcePre(container);
	expect(pre).not.toBeNull();
	expect(isEditable(pre as HTMLElement)).toBe(true);
	expect(pre?.textContent).toBe(content);
	expectOnlyEditable(container, pre as HTMLElement);
}

beforeEach(() => {
	windowState.endEdit();
	windowState.clearDocument();
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC-49-35 — 複数のブロックを持つリスト項目はソース編集モードへ誘導(契約①③・追補f(1)(3))
// ---------------------------------------------------------------------------

describe('Viewer — 複数のブロックを持つリスト項目のダブルクリックはソース編集モードへ誘導(契約①③・追補f(1) / AC-49-35)', () => {
	it('backlog 148 の再現: 子リストを持つ外側の項目をダブルクリック → 項目は contenteditable にならず、document.content のソース編集 <pre> が開く', async () => {
		const { container } = mountDoc(NESTED_MD, renderedNested);
		const [outer, inner] = listItems(container);
		expect(outer.contains(inner)).toBe(true);

		await doubleClick(outer);

		expect(isEditable(outer)).toBe(false);
		expectSourceEditing(container, NESTED_MD);
		// 誘導しただけで dirty にはならず、原文も変わらない。
		expect(windowState.dirty).toBe(false);
		expect(windowState.currentDocument?.content).toBe(NESTED_MD);
	});

	it('backlog 148 の再現: 2段落の緩い項目をダブルクリック → 項目は contenteditable にならず、ソース編集 <pre> が開く', async () => {
		const { container } = mountDoc(LOOSE_TWO_MD, renderedLooseTwo);
		const [li] = listItems(container);
		expect(li.querySelectorAll(':scope > p')).toHaveLength(2);

		await doubleClick(li);

		expect(isEditable(li)).toBe(false);
		expectSourceEditing(container, LOOSE_TWO_MD);
		expect(windowState.dirty).toBe(false);
		expect(windowState.currentDocument?.content).toBe(LOOSE_TWO_MD);
	});

	it('外側の項目のテキスト(inline 要素なし)の上のダブルクリック= target は <li> そのもの: 同じく誘導', async () => {
		const { container } = mountDoc(NESTED_MD, renderedNested);
		const [outer] = listItems(container);
		// 密な親の段落は `<p>` にならないので、テキストの上のダブルクリックは `<li>` に当たる。
		expect(outer.querySelector(':scope > p')).toBeNull();
		expect(outer.firstChild?.nodeType).toBe(Node.TEXT_NODE);

		await doubleClick(outer);

		expectSourceEditing(container, NESTED_MD);
	});
});

describe('Viewer — 誘導はモードの切り替えだけ: 確定済みのブロック編集と dirty は保たれる(契約②③・追補f(3) / AC-49-35)', () => {
	it('内側の項目を直して確定(dirty)→ 外側の項目をダブルクリック: <pre> の原文は差し替え後の内容で dirty のまま', async () => {
		const { container } = mountDoc(NESTED_MD, renderedNested);
		const [outer, inner] = listItems(container);
		await editAndCommit(container, inner, INNER_EDITED);
		const afterInner = replaced(NESTED_MD, INNER_ITEM, INNER_EDITED);
		expect(windowState.editBuffer).toBe(afterInner);
		expect(windowState.dirty).toBe(true);

		await doubleClick(outer);

		// 追補a(3) と同じ: `beginEdit()` を再度呼ばず(呼ぶとバッファが document.content へ
		// 戻って dirty が消える)、モードだけをソース編集へ切り替える。
		expectSourceEditing(container, afterInner);
		expect(windowState.dirty).toBe(true);
		expect(windowState.currentDocument?.content).toBe(NESTED_MD);
	});

	it('緩い項目の中の段落を直して確定(dirty)→ その項目をダブルクリック: 同じく差し替え後の内容で dirty のまま', async () => {
		const { container } = mountDoc(LOOSE_TWO_MD, renderedLooseTwo);
		const [li] = listItems(container);
		const first = paragraphs(container)[0];
		expect(first.textContent).toBe(FIRST_PARA);
		expect(li.contains(first)).toBe(true);
		await editAndCommit(container, first, FIRST_PARA_EDITED);
		const afterFirst = replaced(LOOSE_TWO_MD, FIRST_PARA, FIRST_PARA_EDITED);
		expect(windowState.dirty).toBe(true);

		await doubleClick(li);

		expectSourceEditing(container, afterFirst);
		expect(windowState.dirty).toBe(true);
		expect(windowState.currentDocument?.content).toBe(LOOSE_TWO_MD);
	});
});

describe('Viewer — 子の項目・項目の中の段落は従来どおりブロック編集に入れる(非退行・追補f(1) / AC-49-35)', () => {
	it('子の項目をダブルクリック: その <li> だけが contenteditable になり、ソース編集の <pre> は出ない', async () => {
		const { container } = mountDoc(NESTED_MD, renderedNested);
		const [, inner] = listItems(container);

		await doubleClick(inner);

		expectOnlyEditable(container, inner);
		expect(sourcePre(container)).toBeNull();
	});

	it('子の項目を直して確定: 原文はその項目の範囲だけが差し替わる', async () => {
		const { container } = mountDoc(NESTED_MD, renderedNested);
		const [, inner] = listItems(container);

		await editAndCommit(container, inner, INNER_EDITED);

		expect(windowState.editBuffer).toBe(replaced(NESTED_MD, INNER_ITEM, INNER_EDITED));
		expect(windowState.dirty).toBe(true);
		expect(sourcePre(container)).toBeNull();
	});

	it('緩い項目の中の段落をダブルクリック: その <p> だけが contenteditable になり、ソース編集の <pre> は出ない', async () => {
		const { container } = mountDoc(LOOSE_TWO_MD, renderedLooseTwo);
		const [first, second] = paragraphs(container);
		expect(first.textContent).toBe(FIRST_PARA);
		expect(second.textContent).toBe('second para');

		await doubleClick(second);

		expectOnlyEditable(container, second);
		expect(sourcePre(container)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC-49-36 — 脚注の定義の中はソース編集モードへ誘導(契約③・追補f(2)(3))
// ---------------------------------------------------------------------------

describe('Viewer — 脚注の定義の段落のダブルクリックはソース編集モードへ誘導(契約③・追補f(2) / AC-49-36)', () => {
	it('前提の確認: 定義の段落は脚注欄の中にあり、戻りリンク `↩`(#user-content-fnref-…)を含む', () => {
		const { container } = mountDoc(FN_MD, renderedFn);
		const def = footnoteDefParagraph(container);
		expect(def.textContent).toContain(FN_DEF_TEXT);
		expect(q(def, 'a[data-footnote-backref]').getAttribute('href')).toMatch(/^#user-content-fnref-/);
	});

	it('backlog 256 の再現: 定義の段落をダブルクリック → 段落は contenteditable にならず、document.content のソース編集 <pre> が開く・原文に戻りリンクが入らない', async () => {
		const { container } = mountDoc(FN_MD, renderedFn);
		const def = footnoteDefParagraph(container);

		await doubleClick(def);

		expect(isEditable(def)).toBe(false);
		expectSourceEditing(container, FN_MD);
		expect(windowState.editBuffer).not.toContain(BAKED_BACKREF);
		expect(windowState.dirty).toBe(false);
		expect(windowState.currentDocument?.content).toBe(FN_MD);
	});

	it('戻りリンク `↩` の上のダブルクリックでも同じく誘導される', async () => {
		const { container } = mountDoc(FN_MD, renderedFn);
		const def = footnoteDefParagraph(container);

		await doubleClick(q(def, 'a[data-footnote-backref]'));

		expect(isEditable(def)).toBe(false);
		expectSourceEditing(container, FN_MD);
	});

	it('本文を直して確定(dirty)→ 定義の段落をダブルクリック: <pre> の原文は差し替え後の内容で dirty のまま・戻りリンクは入らない', async () => {
		const { container } = mountDoc(FN_MD, renderedFn);
		const [body] = paragraphs(container);
		expect(body.textContent).toContain('Text with note');
		await editAndCommit(container, body, FN_BODY_EDITED);
		const afterBody = replaced(FN_MD, FN_BODY, FN_BODY_EDITED);
		expect(windowState.editBuffer).toBe(afterBody);
		expect(windowState.dirty).toBe(true);

		await doubleClick(footnoteDefParagraph(container));

		expectSourceEditing(container, afterBody);
		expect(windowState.editBuffer).not.toContain(BAKED_BACKREF);
		expect(windowState.dirty).toBe(true);
		expect(windowState.currentDocument?.content).toBe(FN_MD);
	});
});

describe('Viewer — 本文の脚注参照を含む段落は従来どおりブロック編集に入れる(AC-49-30 の回帰・追補f(2) / AC-49-36)', () => {
	it('本文の段落をダブルクリック: その <p> だけが contenteditable になり、ソース編集の <pre> は出ない', async () => {
		const { container } = mountDoc(FN_MD, renderedFn);
		const [body] = paragraphs(container);
		expect(body.querySelector('sup[data-vellis-node-type="footnoteReference"]')).not.toBeNull();

		await doubleClick(body);

		expectOnlyEditable(container, body);
		expect(sourcePre(container)).toBeNull();
	});

	it('脚注参照のリンクの上のダブルクリックでも、その段落がブロック編集になる', async () => {
		const { container } = mountDoc(FN_MD, renderedFn);
		const [body] = paragraphs(container);

		await doubleClick(q(body, 'sup[data-vellis-node-type="footnoteReference"] a'));

		expectOnlyEditable(container, body);
		expect(sourcePre(container)).toBeNull();
	});
});
