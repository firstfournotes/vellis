/**
 * 要件#49 追補j の受け入れテスト(docs/requirements/req-49.md「### 追補j」・AC-49-40)
 * — Viewer の配線(component プロジェクト)
 *
 * ここは `Viewer.svelte` を JSDOM にマウントし、本番パイプライン(`render`)の HTML と
 * `SourceIndex` を props に渡して、**何も変えずに確定した(ブロック外 mousedown)とき**の
 * 振る舞いを判定する。道具は Viewer.blockedit.wiring.test.ts(AC-49-5 など)と
 * Viewer.find.wiring.test.ts(AC-54-13)に倣う。
 *
 * ## 判定するもの(AC-49-40)
 * - **(a) 閲覧から入って無変更で確定 → 閲覧へ戻る(追補j(1)(2))**: ダブルクリックで入り、
 *   何も変えずにブロック外を押すと `windowState.updateBuffer` は呼ばれず、Esc を押さなくても
 *   editMode='view'・editBuffer=null・contenteditable 無し・ソース編集の `<pre>` 無し。
 *   5 種のブロック(画像の alt に取り消し線を持つ段落・`*強調*` の段落・リスト項目・表セル・
 *   code fence)で固定
 * - **(b) 無変更の確定で原文(バッファ)は byte 等価(追補j(1))**: 別のブロックを確定済みの
 *   編集モードで、5 種のブロックを無変更で確定しても `editBuffer` は確定済みの原文のまま
 *   (`updateBuffer` の呼び出しは最初の確定の 1 回だけ)。`![~~x~~](i.png)` は逆シリアライズ
 *   すると `![x](i.png)` になる(DOM の alt が平文)ので、書き戻しが走ると byte 等価が崩れる
 * - **(c) 確定済みの編集があれば編集モードのまま(追補j(2))**: バッファ・dirty・editMode='edit'
 *   がそのまま残り、閲覧へは戻らない。そのあと別のブロックを変えて確定しても正しい範囲に当たる
 * - **(d) 1 文字でも変えれば今までどおり書き戻す(追補j(3))**: 段落・fence の 1 文字の変更で
 *   `updateBuffer` が 1 回呼ばれ、その範囲だけ差し替わる(既存の確定テストの守りと同じ向き)
 * - **(e) 検索の強調が付いたブロックでも無変更なら書き戻さない(追補j(3)・要件#54 契約④)**:
 *   検索バーで語を打ってフォールバックの `<mark>` が付いた段落を無変更で確定しても
 *   `updateBuffer` は呼ばれず、閲覧から入ったなら閲覧へ戻る・確定済みの編集があるなら
 *   バッファは byte 等価のまま。**編集に入ったあとで**検索バーを開いて語を打つ順も固定する
 *   (検索バーへフォーカスが移ると `caretInsideEditable` が偽になり、編集中のブロックに
 *   `<mark>` が張られる= `innerHTML` が控えと食い違う状態で確定する)
 *
 * ## 判定しないもの
 * - 変更ありの確定の中身(契約②・追補a〜i)→ 既存の Viewer.blockedit*.wiring / edit.acceptance
 * - fence の表示の整え直しの有無(追補j(1))→ 閲覧へ戻ると掴む前の DOM へ戻るため観測できない
 * - IME の変換中・Esc の破棄 → 既存テストで固定済み
 *
 * ## 前提の実測(2026-10-19・使い捨ての probe)
 * - `Image ![~~x~~](i.png) here.` は `resolveEditTarget` で block(誘導されない)・無変更の
 *   `serializeBlock` は `Image ![x](i.png) here.`(DIFF)
 * - `Some *強調* words.`・`- item one`・`| A `・`# Title` は無変更の逆シリアライズが byte 等価(SAME)
 *   = これらは「書き戻さない」ことを `updateBuffer` の呼び出しで判定する
 *
 * ## スタブの設計(Viewer.blockedit.wiring.test.ts / Viewer.find.wiring.test.ts の家風)
 * - $lib/ipc / @tauri-apps/plugin-opener / @tauri-apps/plugin-dialog / $lib/mermaid-mounter:
 *   モジュールモック
 * - $lib/events: menu_find の到着を写す(検索バーを出すため)
 * - scrollIntoView は JSDOM に無いので beforeEach でスタブ
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
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

// menu_find の到着を写すための $lib/events モック(Viewer.find.wiring.test.ts と同じ裏口)。
vi.mock('$lib/events', () => {
	const handlers = new Map<string, Array<(e: { payload: unknown }) => void>>();
	return {
		listen: async (event: string, handler: (e: { payload: unknown }) => void) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {
				const cur = handlers.get(event) ?? [];
				const at = cur.indexOf(handler);
				if (at >= 0) cur.splice(at, 1);
			};
		},
		__eventHandlers: handlers,
	};
});

import * as eventsModule from '$lib/events';

const menuHandlers = (
	eventsModule as unknown as {
		__eventHandlers: Map<string, Array<(e: { payload: unknown }) => void>>;
	}
).__eventHandlers;

const MENU_FIND = 'menu_find';

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const MD_URI = 'file:///Users/a/notes/unchanged.md';

/** 画像の alt の取り消し線(#656 の例)を含む段落。逆シリアライズは alt を平文にする。 */
const IMAGE_SLICE = 'Image ![~~x~~](i.png) here.';
const EM_SLICE = 'Some *強調* words.';
const ITEM_SLICE = '- item one';
const CELL_TEXT = 'a1';
const FENCE_BODY = 'const x = 1;';
const TAIL_SLICE = 'Tail.';

/**
 * 編集可能ブロック 5 種(段落 2・リスト項目・表セル・トップレベル fence)と、確定済みの
 * 編集を作るための末尾段落。先頭の `# Title` は確定用のブロック外クリック先。
 */
const MD = [
	'# Title',
	'',
	IMAGE_SLICE,
	'',
	EM_SLICE,
	'',
	ITEM_SLICE,
	'- item two',
	'',
	'| A | B |',
	'| --- | --- |',
	'| a1 | b1 |',
	'',
	'```javascript',
	FENCE_BODY,
	'```',
	'',
	TAIL_SLICE,
	'',
].join('\n');

/** 末尾段落を変えて確定したあとの原文(確定済みの編集がある状態の基準)。 */
const TAIL_EDITED = 'Tail edited.';
const MD_TAIL_EDITED = MD.replace(TAIL_SLICE, TAIL_EDITED);

let rendered: { html: string; index: SourceIndex };

beforeAll(async () => {
	const result = await renderMarkdown(MD, MD_URI);
	rendered = { html: result.html, index: result.index };
	expect(rendered.index.byId.size).toBeGreaterThan(0);
});

function mountDoc() {
	const doc: DocumentPayload = { uri: MD_URI, content: MD, modified: 1 };
	windowState.setDocument(doc);
	return render(Viewer, {
		props: {
			document: doc,
			html: rendered.html,
			index: rendered.index,
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

/** `needle` を表示テキストに含む段落。 */
function paragraphContaining(container: HTMLElement, needle: string): HTMLElement {
	const p = [...container.querySelectorAll('p[data-vellis-node-type="paragraph"]')].find((el) =>
		(el.textContent ?? '').includes(needle),
	);
	if (!p) throw new Error(`段落が見つからない: ${needle}`);
	return p as HTMLElement;
}

function imageParagraph(container: HTMLElement): HTMLElement {
	return paragraphContaining(container, 'Image');
}

function emParagraph(container: HTMLElement): HTMLElement {
	return paragraphContaining(container, '強調');
}

function tailParagraph(container: HTMLElement): HTMLElement {
	return paragraphContaining(container, 'Tail');
}

function firstListItem(container: HTMLElement): HTMLElement {
	return q(container, 'li[data-vellis-node-type="listItem"]');
}

function firstBodyCell(container: HTMLElement): HTMLElement {
	const td = [...container.querySelectorAll('td[data-vellis-node-type="tableCell"]')].find(
		(el) => (el.textContent ?? '').trim() === CELL_TEXT,
	);
	if (!td) throw new Error('表の本体セルが見つからない');
	return td as HTMLElement;
}

/** トップレベル fence の `<pre>`(中身で引く)。 */
function fencePre(container: HTMLElement): HTMLElement {
	const pre = [...container.querySelectorAll('pre')].find((el) =>
		(el.textContent ?? '').includes(FENCE_BODY),
	);
	if (!pre) throw new Error('fence の <pre> が見つからない');
	return pre as HTMLElement;
}

function isEditable(el: Element): boolean {
	return el.getAttribute('contenteditable') === 'true';
}

function editables(scope: ParentNode): HTMLElement[] {
	return [...scope.querySelectorAll('[contenteditable="true"]')] as HTMLElement[];
}

/** ソース編集モードの `<pre>`(要件#48)。無ければ null。 */
function sourcePre(container: HTMLElement): HTMLElement | null {
	return container.querySelector('pre.vellis-plaintext');
}

function marks(scope: ParentNode): HTMLElement[] {
	return [...scope.querySelectorAll('mark[data-vellis-find]')] as HTMLElement[];
}

/** 編集中の要素から `needle` を含むテキストノードを探す。 */
function textNodeContaining(el: HTMLElement, needle: string): Text {
	const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	let node = walker.nextNode();
	while (node) {
		if ((node.nodeValue ?? '').includes(needle)) return node as Text;
		node = walker.nextNode();
	}
	throw new Error('テキストノードが見つからない: ' + needle);
}

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}

/** ブロックをダブルクリックして編集に入る(契約①)。入れたことまで確かめる。 */
async function beginBlockEdit(el: HTMLElement): Promise<HTMLElement> {
	await fireEvent.dblClick(el);
	await settle();
	const list = editables(el.ownerDocument.body);
	expect(list, 'ダブルクリックで contenteditable が 1 つだけ生まれる').toHaveLength(1);
	expect(windowState.editMode).toBe('edit');
	expect(sourcePre(el.ownerDocument.body)).toBeNull();
	return list[0];
}

/** ブロック外(見出し)を押して確定する(契約②の契機= mousedown)。 */
async function clickOutside(container: HTMLElement) {
	const other = q(container, 'h1[data-vellis-node-type="heading"]');
	await fireEvent.mouseDown(other);
	await fireEvent.click(other);
	await settle();
}

/** 末尾段落を `TAIL_EDITED` に変えて確定し、確定済みの編集がある編集モードにする。 */
async function commitTailEdit(container: HTMLElement) {
	const ed = await beginBlockEdit(tailParagraph(container));
	const node = textNodeContaining(ed, TAIL_SLICE);
	node.nodeValue = (node.nodeValue as string).replace(TAIL_SLICE, TAIL_EDITED);
	await fireEvent.input(ed);
	await clickOutside(container);
	expect(windowState.editBuffer).toBe(MD_TAIL_EDITED);
	expect(windowState.dirty).toBe(true);
	expect(windowState.editMode).toBe('edit');
}

/** menu_find の到着を写す(Viewer.find.wiring.test.ts と同じ)。 */
async function emitMenuFind() {
	await settle();
	const list = [...(menuHandlers.get(MENU_FIND) ?? [])];
	expect(list.length, "Viewer が 'menu_find' を購読していること").toBeGreaterThan(0);
	for (const handler of list) handler({ payload: undefined });
	await settle();
}

async function typeQuery(container: HTMLElement, value: string) {
	const input = q(container, '[data-testid="find-input"]');
	await fireEvent.input(input, { target: { value } });
	await settle();
}

/** 閲覧へ戻っていること(追補a(2) の破棄と同じ行き先)。 */
function expectBackToView(container: HTMLElement) {
	expect(windowState.editMode).toBe('view');
	expect(windowState.editBuffer).toBeNull();
	expect(windowState.dirty).toBe(false);
	expect(editables(container)).toEqual([]);
	expect(sourcePre(container)).toBeNull();
	expect(windowState.currentDocument?.content).toBe(MD);
}

type Pick = (container: HTMLElement) => HTMLElement;

/** 無変更の確定を固定する 5 種(AC-49-40(a)(b) の列挙)。 */
const BLOCKS: Array<[string, Pick]> = [
	['画像の alt に取り消し線を持つ段落(![~~x~~](i.png))', imageParagraph],
	['*強調* の段落', emParagraph],
	['リスト項目', firstListItem],
	['表セル', firstBodyCell],
	['code fence', fencePre],
];

/** 追補j(1) の「`updateBuffer` もしない」を呼び出し回数で判定する。 */
let updateBufferSpy: MockInstance<typeof windowState.updateBuffer>;

beforeEach(() => {
	windowState.endEdit();
	windowState.clearDocument();
	menuHandlers.clear();
	Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView;
	updateBufferSpy = vi.spyOn(windowState, 'updateBuffer');
});

afterEach(() => {
	cleanup();
	updateBufferSpy.mockRestore();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC-49-40(a) — 閲覧から入って無変更で確定すると閲覧へ戻る(追補j(1)(2))
// ---------------------------------------------------------------------------

describe('AC-49-40(a) — 閲覧からダブルクリックで入り、何も変えずにブロック外を押すと updateBuffer は呼ばれず閲覧へ戻る', () => {
	it.each(BLOCKS)('%s: updateBuffer は呼ばれない・Esc なしで editMode=view・editBuffer=null', async (_label, pick) => {
		const { container } = mountDoc();
		expect(windowState.editMode).toBe('view');
		await beginBlockEdit(pick(container));

		await clickOutside(container);

		expect(updateBufferSpy).not.toHaveBeenCalled();
		expectBackToView(container);
	});

	it('画像段落: 閲覧へ戻ったブロックの表示は編集前のまま(contenteditable も mark も残らない)', async () => {
		const { container } = mountDoc();
		await settle();
		const p = imageParagraph(container);
		const before = p.outerHTML;
		await beginBlockEdit(p);

		await clickOutside(container);

		expectBackToView(container);
		expect(p.isConnected).toBe(true);
		expect(p.outerHTML).toBe(before);
	});

	it('code fence: 閲覧へ戻った <pre> の表示は掴む前(Shiki の span ごと)へ戻る', async () => {
		const { container } = mountDoc();
		await settle();
		const pre = fencePre(container);
		const before = pre.innerHTML;
		expect(before).toContain('<span');
		await beginBlockEdit(pre);

		await clickOutside(container);

		expect(updateBufferSpy).not.toHaveBeenCalled();
		expectBackToView(container);
		expect(pre.innerHTML).toBe(before);
	});

	it('閲覧へ戻ったあと、もう一度ダブルクリックすれば編集に入れる(閉じ込めも取り残しもない)', async () => {
		const { container } = mountDoc();
		await beginBlockEdit(emParagraph(container));
		await clickOutside(container);
		expectBackToView(container);

		const ed = await beginBlockEdit(emParagraph(container));
		expect(ed).toBe(emParagraph(container));
		expect(windowState.editBuffer).toBe(MD);
		expect(windowState.dirty).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC-49-40(b) — 無変更の確定で原文(バッファ)は byte 等価のまま(追補j(1))
// ---------------------------------------------------------------------------

describe('AC-49-40(b) — 確定済みの編集がある編集モードで無変更の確定をしても editBuffer は byte 等価のまま', () => {
	it.each(BLOCKS)('%s: editBuffer は確定済みの原文そのもの・updateBuffer は最初の確定の 1 回だけ', async (_label, pick) => {
		const { container } = mountDoc();
		await commitTailEdit(container);
		expect(updateBufferSpy).toHaveBeenCalledTimes(1);
		await beginBlockEdit(pick(container));

		await clickOutside(container);

		expect(windowState.editBuffer).toBe(MD_TAIL_EDITED);
		expect(updateBufferSpy).toHaveBeenCalledTimes(1);
		expect(editables(container)).toEqual([]);
	});

	it('画像段落を 2 回続けて無変更で確定しても `![~~x~~](i.png)` は原文に残る', async () => {
		const { container } = mountDoc();
		await commitTailEdit(container);

		await beginBlockEdit(imageParagraph(container));
		await clickOutside(container);
		await beginBlockEdit(imageParagraph(container));
		await clickOutside(container);

		expect(windowState.editBuffer).toBe(MD_TAIL_EDITED);
		expect(windowState.editBuffer).toContain(IMAGE_SLICE);
		expect(windowState.editBuffer).not.toContain('![x](i.png)');
		expect(updateBufferSpy).toHaveBeenCalledTimes(1);
	});

	it('閲覧から入った無変更の確定は原文に何も書かない(document.content は byte 等価・updateBuffer は呼ばれない)', async () => {
		const { container } = mountDoc();
		await beginBlockEdit(imageParagraph(container));

		await clickOutside(container);

		expect(updateBufferSpy).not.toHaveBeenCalled();
		expect(windowState.currentDocument?.content).toBe(MD);
		expect(windowState.currentDocument?.content).toContain(IMAGE_SLICE);
	});
});

// ---------------------------------------------------------------------------
// AC-49-40(c) — 確定済みの編集があるときは編集モードのまま(追補j(2))
// ---------------------------------------------------------------------------

describe('AC-49-40(c) — 確定済みの編集があるときに別のブロックを無変更で確定すると、バッファはそのまま・編集モードのまま', () => {
	it('末尾段落を確定したあと画像段落を無変更で確定: editMode=edit・dirty・editBuffer は確定済みの原文・閲覧へ戻らない', async () => {
		const { container } = mountDoc();
		await commitTailEdit(container);
		await beginBlockEdit(imageParagraph(container));

		await clickOutside(container);

		expect(windowState.editMode).toBe('edit');
		expect(windowState.dirty).toBe(true);
		expect(windowState.editBuffer).toBe(MD_TAIL_EDITED);
		expect(updateBufferSpy).toHaveBeenCalledTimes(1);
		// 編集は閉じるが、レンダリング結果のまま(ソース編集にも閲覧にも落ちない)。
		expect(editables(container)).toEqual([]);
		expect(sourcePre(container)).toBeNull();
		expect(container.querySelector('h1[data-vellis-node-type="heading"]')).not.toBeNull();
	});

	it('末尾段落を確定したあと fence を無変更で確定: editMode=edit・dirty・editBuffer はそのまま', async () => {
		const { container } = mountDoc();
		await commitTailEdit(container);
		await beginBlockEdit(fencePre(container));

		await clickOutside(container);

		expect(windowState.editMode).toBe('edit');
		expect(windowState.dirty).toBe(true);
		expect(windowState.editBuffer).toBe(MD_TAIL_EDITED);
		expect(updateBufferSpy).toHaveBeenCalledTimes(1);
		expect(editables(container)).toEqual([]);
	});

	it('無変更の確定のあとに別のブロックを変えて確定しても、正しい範囲に当たる(位置の記録を乱さない)', async () => {
		const { container } = mountDoc();
		await commitTailEdit(container);
		await beginBlockEdit(firstListItem(container));
		await clickOutside(container);
		expect(windowState.editBuffer).toBe(MD_TAIL_EDITED);

		const ed = await beginBlockEdit(emParagraph(container));
		const node = textNodeContaining(ed, 'words.');
		node.nodeValue = (node.nodeValue as string).replace('words.', 'words!');
		await fireEvent.input(ed);
		await clickOutside(container);

		expect(windowState.editBuffer).toBe(MD_TAIL_EDITED.replace(EM_SLICE, 'Some *強調* words!'));
		expect(windowState.editMode).toBe('edit');
		expect(windowState.dirty).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// AC-49-40(d) — 1 文字でも変えて確定すると今までどおり書き戻す(追補j(3))
// ---------------------------------------------------------------------------

describe('AC-49-40(d) — 1 文字でも変えて確定すると今までどおり書き戻す', () => {
	it('段落の末尾 1 文字を変えて確定: updateBuffer が 1 回呼ばれ、その範囲だけ差し替わり dirty・editMode=edit', async () => {
		const { container } = mountDoc();
		const ed = await beginBlockEdit(emParagraph(container));
		const node = textNodeContaining(ed, 'words.');
		node.nodeValue = (node.nodeValue as string).replace('words.', 'words!');
		await fireEvent.input(ed);

		await clickOutside(container);

		expect(updateBufferSpy).toHaveBeenCalledTimes(1);
		expect(windowState.editBuffer).toBe(MD.replace(EM_SLICE, 'Some *強調* words!'));
		expect(windowState.dirty).toBe(true);
		expect(windowState.editMode).toBe('edit');
		expect(editables(container)).toEqual([]);
	});

	it('画像段落の文字を 1 つ足して確定: 書き戻しが走り、alt の取り消し線は従来どおり平文になる(契約⑥=意味等価)', async () => {
		const { container } = mountDoc();
		const ed = await beginBlockEdit(imageParagraph(container));
		const node = textNodeContaining(ed, 'here.');
		node.nodeValue = (node.nodeValue as string).replace('here.', 'here!');
		await fireEvent.input(ed);

		await clickOutside(container);

		expect(updateBufferSpy).toHaveBeenCalledTimes(1);
		expect(windowState.editBuffer).toBe(MD.replace(IMAGE_SLICE, 'Image ![x](i.png) here!'));
		expect(windowState.dirty).toBe(true);
	});

	it('fence の中身を 1 文字変えて確定: updateBuffer が 1 回呼ばれ、フェンス行を残して中身だけ差し替わる', async () => {
		const { container } = mountDoc();
		const ed = await beginBlockEdit(fencePre(container));
		ed.textContent = 'const x = 2;';
		await fireEvent.input(ed);

		await clickOutside(container);

		expect(updateBufferSpy).toHaveBeenCalledTimes(1);
		expect(windowState.editBuffer).toBe(MD.replace(FENCE_BODY, 'const x = 2;'));
		expect(windowState.dirty).toBe(true);
		expect(windowState.editMode).toBe('edit');
	});
});

// ---------------------------------------------------------------------------
// AC-49-40(e) — 検索の強調が付いたブロックを無変更で確定しても書き戻さない(追補j(3))
// ---------------------------------------------------------------------------

describe('AC-49-40(e) — 検索の強調が付いたブロックを無変更で確定しても書き戻さない(要件#54 契約④)', () => {
	it('閲覧から: 検索語 "here" で強調された画像段落を無変更で確定 → updateBuffer は呼ばれず閲覧へ戻る', async () => {
		const { container } = mountDoc();
		await emitMenuFind();
		await typeQuery(container, 'here');
		const p = imageParagraph(container);
		expect(marks(p).length, '段落にフォールバックの <mark> が付いていること').toBeGreaterThan(0);

		await beginBlockEdit(p);
		await clickOutside(container);

		expect(updateBufferSpy).not.toHaveBeenCalled();
		expectBackToView(container);
	});

	it('閲覧から: 画像段落の編集中に検索バーを開いて "here" を打つ(編集中のブロックに mark が張られる)→ 無変更で確定 → updateBuffer は呼ばれず閲覧へ戻り原文は byte 等価', async () => {
		const { container } = mountDoc();
		await settle();
		const p = imageParagraph(container);
		expect(marks(p)).toEqual([]);
		const ed = await beginBlockEdit(p);
		expect(ed).toBe(p);

		// 編集中に Command + F 相当で検索バーを開き、語を打つ。フォーカスは検索バーの
		// 入力欄へ移る(= キャレットは編集面に無い)ので、ハイライトの effect は編集中の
		// ブロックにもフォールバックの <mark> を張る。場面の成立をここで固定する。
		await emitMenuFind();
		await typeQuery(container, 'here');
		expect(editables(container), '検索バーを開いても編集は畳まれない').toHaveLength(1);
		expect(editables(container)[0]).toBe(p);
		expect(isEditable(p)).toBe(true);
		expect(marks(p).length, '編集中の段落にフォールバックの <mark> が張られていること').toBeGreaterThan(0);
		expect(p.innerHTML).toContain('<mark');

		await clickOutside(container);

		expect(updateBufferSpy).not.toHaveBeenCalled();
		expectBackToView(container);
		expect(windowState.currentDocument?.content).toContain(IMAGE_SLICE);
		expect(windowState.currentDocument?.content).not.toContain('![x](i.png)');
	});

	it('確定済みの編集あり: 強調された画像段落を無変更で確定 → editBuffer は byte 等価のまま・編集モードのまま', async () => {
		const { container } = mountDoc();
		await commitTailEdit(container);
		await emitMenuFind();
		await typeQuery(container, 'here');
		const p = imageParagraph(container);
		expect(marks(p).length).toBeGreaterThan(0);

		await beginBlockEdit(p);
		await clickOutside(container);

		expect(windowState.editBuffer).toBe(MD_TAIL_EDITED);
		expect(windowState.editBuffer).not.toContain('<mark');
		expect(windowState.editBuffer).not.toContain('data-vellis-find');
		expect(updateBufferSpy).toHaveBeenCalledTimes(1);
		expect(windowState.editMode).toBe('edit');
		expect(windowState.dirty).toBe(true);
	});

	it('確定済みの編集あり: 強調された *強調* の段落を無変更で確定 → updateBuffer は増えない', async () => {
		const { container } = mountDoc();
		await commitTailEdit(container);
		await emitMenuFind();
		await typeQuery(container, 'words');
		const p = emParagraph(container);
		expect(marks(p).length).toBeGreaterThan(0);

		await beginBlockEdit(p);
		await clickOutside(container);

		expect(windowState.editBuffer).toBe(MD_TAIL_EDITED);
		expect(updateBufferSpy).toHaveBeenCalledTimes(1);
		expect(windowState.editMode).toBe('edit');
	});
});
