/**
 * 要件#49 追補g の受け入れテスト(docs/requirements/req-49.md「### 追補g」・AC-49-37)
 * — Viewer の配線(component プロジェクト)
 *
 * 純関数(`resolveEditTarget`)の判定は src/markdown/edit-redirect-single.acceptance.test.ts
 * (unit 側)。ここは `Viewer.svelte` を JSDOM にマウントし、本番パイプライン(`render`)の
 * HTML と `SourceIndex` を props に渡して、**直下のブロックが段落以外の1つだけのリスト項目**
 * をダブルクリックしたときの誘導(要件#48 のソース編集モードへ)を判定する。道具は
 * Viewer.blockedit-redirect.wiring.test.ts(追補f)と同じ。
 *
 * ## 判定するもの
 * - **AC-49-37(契約①③・追補g(1)・backlog 272)**: 見出しだけの項目(`- # H`)・引用だけの
 *   項目(`- > q`)の `li` をダブルクリックすると、その項目は contenteditable にならず、
 *   要件#48 のソース編集モード(editMode=edit・`<pre class="vellis-plaintext" contenteditable>`
 *   に原文)へ切り替わる。原文(`document.content`)は変わらず、誘導だけで dirty にはならない。
 *   中の見出し(`h1`)をダブルクリックすると従来どおりブロック編集に入る(その `h1` だけが
 *   contenteditable・`<pre>` は出ない)。引用の中の段落も同じ
 *
 * ## 判定しないもの
 * - 判定の網羅(定義・code fence・表・生 HTML だけの項目・回帰)→ unit 側
 * - 確定済みの編集と dirty の保持(追補f(3)・追補a(3))→ Viewer.blockedit-redirect.wiring で固定済み
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

const MD_URI = 'file:///Users/a/notes/redirect-single.md';

type Rendered = { html: string; index: SourceIndex };

/** 見出しだけの項目(実測 `- # H` → `- H`)。文頭の `# Title` は確定用のブロック外クリック先。 */
const HEADING_MD = ['# Title', '', '- # Item heading', '', 'Tail.', ''].join('\n');
const ITEM_HEADING_TEXT = 'Item heading';

/** 引用だけの項目(実測 `- > q` → `- q`)。 */
const QUOTE_MD = ['# Title', '', '- > quoted', '', 'Tail.', ''].join('\n');
const QUOTED_TEXT = 'quoted';

let renderedHeading: Rendered;
let renderedQuote: Rendered;

beforeAll(async () => {
	const [heading, quote] = await Promise.all([
		renderMarkdown(HEADING_MD, MD_URI),
		renderMarkdown(QUOTE_MD, MD_URI),
	]);
	renderedHeading = { html: heading.html, index: heading.index };
	renderedQuote = { html: quote.html, index: quote.index };
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

/** 文書で唯一のリスト項目。 */
function onlyListItem(container: HTMLElement): HTMLElement {
	const items = [...container.querySelectorAll('li[data-vellis-node-type="listItem"]')];
	expect(items).toHaveLength(1);
	return items[0] as HTMLElement;
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
// AC-49-37 — 段落以外の1つだけの項目はソース編集モードへ誘導(契約①③・追補g(1))
// ---------------------------------------------------------------------------

describe('Viewer — 直下のブロックが段落以外の1つだけのリスト項目のダブルクリックはソース編集モードへ誘導(契約①③・追補g(1) / AC-49-37)', () => {
	it('前提の確認: 見出しだけの項目は `<li>` の直下に `<h1>` を持つ(`<p>` は無い)', () => {
		const { container } = mountDoc(HEADING_MD, renderedHeading);
		const li = onlyListItem(container);
		const h1 = q(li, ':scope > h1[data-vellis-node-type="heading"]');
		expect(h1.textContent).toBe(ITEM_HEADING_TEXT);
		expect(li.querySelector(':scope > p')).toBeNull();
	});

	it('前提の確認: 引用だけの項目は `<li>` の直下に `<blockquote>` を持ち、その中に段落がある', () => {
		const { container } = mountDoc(QUOTE_MD, renderedQuote);
		const li = onlyListItem(container);
		const p = q(li, ':scope > blockquote > p[data-vellis-node-type="paragraph"]');
		expect(p.textContent).toBe(QUOTED_TEXT);
	});

	it('見出しだけの項目の `li` をダブルクリック → 項目は contenteditable にならず、document.content のソース編集 <pre> が開く・原文不変・dirty にならない', async () => {
		const { container } = mountDoc(HEADING_MD, renderedHeading);
		const li = onlyListItem(container);

		await doubleClick(li);

		expect(isEditable(li)).toBe(false);
		expect(isEditable(q(li, 'h1'))).toBe(false);
		expectSourceEditing(container, HEADING_MD);
		expect(windowState.dirty).toBe(false);
		expect(windowState.currentDocument?.content).toBe(HEADING_MD);
	});

	it('引用だけの項目の `li` をダブルクリック → 項目は contenteditable にならず、ソース編集 <pre> が開く・原文不変・dirty にならない', async () => {
		const { container } = mountDoc(QUOTE_MD, renderedQuote);
		const li = onlyListItem(container);

		await doubleClick(li);

		expect(isEditable(li)).toBe(false);
		expectSourceEditing(container, QUOTE_MD);
		expect(windowState.dirty).toBe(false);
		expect(windowState.currentDocument?.content).toBe(QUOTE_MD);
	});
});

describe('Viewer — 中のブロックを直接ダブルクリックすると従来どおりブロック編集に入る(追補g(1) / AC-49-37)', () => {
	it('見出しだけの項目の `h1` をダブルクリック: その <h1> だけが contenteditable になり、ソース編集の <pre> は出ない', async () => {
		const { container } = mountDoc(HEADING_MD, renderedHeading);
		const li = onlyListItem(container);
		const h1 = q(li, ':scope > h1[data-vellis-node-type="heading"]');

		await doubleClick(h1);

		expectOnlyEditable(container, h1);
		expect(isEditable(li)).toBe(false);
		expect(sourcePre(container)).toBeNull();
	});

	it('引用だけの項目の中の段落をダブルクリック: その <p> だけが contenteditable になり、ソース編集の <pre> は出ない', async () => {
		const { container } = mountDoc(QUOTE_MD, renderedQuote);
		const li = onlyListItem(container);
		const p = q(li, ':scope > blockquote > p[data-vellis-node-type="paragraph"]');

		await doubleClick(p);

		expectOnlyEditable(container, p);
		expect(sourcePre(container)).toBeNull();
	});
});
