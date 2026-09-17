/**
 * 要件#49 の受け入れテスト(docs/requirements/req-49.md)— Viewer のブロック編集
 * 配線(component プロジェクト)
 *
 * 純関数(`src/markdown/edit.ts`)の判定は src/markdown/edit.acceptance.test.ts
 * (unit 側)。ここは `Viewer.svelte` を JSDOM にマウントし、本番パイプライン
 * (`render`)の HTML と `SourceIndex` を props に渡して、**ダブルクリック→ブロック
 * だけ contenteditable→確定/破棄→要件#48 の保存経路**の配線を判定する。
 * 要件#48 の wiring(Viewer.edit.wiring.test.ts)は書き換えず、本要件用に新設。
 *
 * ## 判定するもの(契約番号は req-49.md の①〜⑦)
 * - **AC-49-1(契約①)**: 段落・見出し・リスト項目・表セル・引用段落をダブル
 *   クリックすると**そのブロックだけ**が contenteditable="true" になる。他のブロック
 *   と `.markdown-body`(コンテナ)は contenteditable にならず、ソース編集の
 *   `<pre class="vellis-plaintext">` も出ない。inline 要素(strong)の上のダブル
 *   クリックはそれを含む段落を編集単位にする
 * - **AC-49-2(契約③)**: 生 HTML ブロック・code fence・mermaid・alert タイトル・
 *   `data-vellis-node-id` を持たない要素のダブルクリックはブロックを contenteditable
 *   にせず、**要件#48 のソース編集モード**(editMode=edit・`document.content` を
 *   `<pre class="vellis-plaintext" contenteditable>` に出す)へ誘導する。該当行への
 *   キャレット移動は任意なので判定しない
 * - **AC-49-5(契約②)**: ブロック外クリック(mousedown→click)で確定=
 *   `windowState.editBuffer` が「そのブロックの範囲だけ差し替えた原文」になり dirty。
 *   確定後はレンダリング結果が見えたまま(ソース編集の `<pre>` に落ちない)。
 *   Esc は破棄= `document.content` も dirty も動かず、ブロックの表示も元に戻る。
 *   Enter の扱いは実装裁量なので判定しない
 * - **AC-49-8(契約⑦)**: 確定で立つ dirty は要件#48 の `windowState.dirty` そのもの
 *   で、確定後は `editMode === 'edit'`(⌘S の実体 `saveCurrentEdits`(+page.svelte)
 *   と `decideFileChanged` の衝突判定はどちらも mode==='edit' で門を開ける)。
 *   ⌘S の本体 `saveDocument(uri, editBuffer)` が `save_document` を確定後の内容で
 *   呼び、成功後に dirty が消える。その保存が返す `file_changed` は ignore-echo で
 *   DOM を作り直さない。保存前の外部変更は external-conflict でバナーが出る
 *
 * ## 追補a(2026-09-11・1周目の reviewer 照合 CHANGES_REQUESTED を受けた解釈の確定)
 * - **AC-49-12(契約②⑥・追補a(1))**: 同じ文書で2ブロック以上を**続けて**編集しても、
 *   2回目以降の差し替えが正しい範囲に当たる。`NodeMeta.position` は初回レンダー時の
 *   `document.content` 基準で、Viewer の `html` / `index` props は確定後も作り直され
 *   ないので、差し替えの基準は**常に最新の `editBuffer`** でなければならない。長さが
 *   増える編集・減る編集・同じブロックの再編集・後ろを直してから前を直す順を固定
 * - **AC-49-13(契約②・追補a(2))**: Esc の破棄は**そのブロックの編集だけ**。ブロックAを
 *   確定(dirty)したあとブロックBを Esc で破棄しても、Aの編集結果と dirty が残り
 *   editMode も 'edit' のまま(閲覧へ戻らない)。編集に入る前が閲覧だった場合の Esc は
 *   従来どおり閲覧へ戻る
 * - **AC-49-14(契約②③・追補a(3))**: ブロックAを確定(dirty)したあと編集不可領域を
 *   ダブルクリックしてソース編集モードへ誘導されても、Aの編集結果と dirty が残る=
 *   `beginEdit()`(バッファを `document.content` で初期化する)を再度呼ばない。誘導後の
 *   `<pre class="vellis-plaintext">` に出る原文は差し替え後の内容
 * - **AC-49-15(契約⑥・追補a(4))**: 相対リンク `[x](./y.md)` と相対画像
 *   `![x](images/y.png)` を含むブロックを編集して確定したとき、`editBuffer` の原文に
 *   元の相対表記が残り `file://` / `vellis-asset://` が混入しない(Viewer が
 *   `document.uri` を逆写像に渡す配線)。純関数側の判定は edit.acceptance.test.ts
 *
 * ## 追補a(5)(6)(7)(2026-09-11・2周目の reviewer 照合で追加)
 * - **AC-49-16(契約②⑦・追補a(5))**: ブロックを確定したあと「編集を終える」(破棄)/
 *   ⌘E トグル / 衝突バナーの「読み直す」で閲覧へ戻ったら、**確定済み差し替えの記録も
 *   ブロック編集の印も捨てる**。そのあと別のブロックを編集して確定しても古い差分が
 *   乗らず、その後の ⌘E でソース編集の `<pre>` が開く(要件#48 契約③のトグルが退行
 *   しない)。⌘E の実体は +page.svelte の `toggleEditMode` なので、その windowState
 *   遷移(閲覧→`beginEdit` / dirty→`confirmDiscardEdits` / 非 dirty→`endEdit`)を写す
 * - **AC-49-17(契約②・追補a(6))**: ブロック編集中(非 dirty)に外部変更が apply され
 *   て再レンダー(props 差し替え=旧 DOM は切り離される)されたら、そのブロックの編集は
 *   破棄され、次の mousedown で旧位置の差し替えが走らない。外部版のブロックは新しい
 *   位置で編集・確定できる
 * - **AC-49-18(契約③⑥・追補a(7))**: 参照リンク `[x][ref]`(定義は別行)と角括弧で
 *   囲んだ行き先 `[x](<a b.md>)` を含むブロックはダブルクリックしても contenteditable
 *   にならず、AC-49-2 と同じ形でソース編集モードへ誘導される(内部 URI が原文へ
 *   焼き付かない)。同じ文書のインラインリンクの段落は AC-49-15 どおり編集に入れる
 *
 * ## 追補a(11)「位置の基準」(2026-09-11・4周目の reviewer 照合で追加)
 * - **AC-49-25(契約⑥)**: 同じブロックを**2回続けて編集して確定**しても、`editBuffer`
 *   の原文にリンク・画像の内部 URI(`file://` / `vellis-asset://`)が混入しない。子要素の
 *   `data-source-*` は初回レンダー基準の絶対 offset なので、確定時の行き先読みは
 *   `index.sliceOf(meta.id)`(初回レンダーの原文)から採る配線(`commitBlockEdit` が
 *   `serializeBlock` の第5引数 `originSlice` に渡す)。1回目で長さが増える・減るの
 *   両方向と、その後に別のブロックを編集する形(追補a(1) の delta 補正との両立)を固定
 *
 * ## 判定しないもの
 * - 逆シリアライズ・範囲差し替えの中身 → edit.acceptance.test.ts
 * - `rebind` の offset 単位 → src-tauri/tests/acceptance_req49.rs
 * - ⌘S のメニューイベント購読(+page.svelte)・編集中の見た目・IME・該当行への移動
 *   → reviewer 照合+人間ゲート(acceptance/acceptance.md 要件#49 ①〜⑥)
 *
 * ## スタブの設計(Viewer.edit.wiring.test.ts の家風)
 * - $lib/ipc / @tauri-apps/plugin-opener / @tauri-apps/plugin-dialog: モジュールモック
 * - $lib/mermaid-mounter: フィクスチャに mermaid ブロックがある(契約③の判定に要る)
 *   ので、`mountMermaid` をモックして mermaid の dynamic import を発火させない
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
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

import { invoke } from '$lib/ipc';
import { ask } from '@tauri-apps/plugin-dialog';
import { saveDocument } from '$lib/save-document';
import { confirmDiscardEdits } from '$lib/edit-guard';

const invokeMock = vi.mocked(invoke);
/** 追補a(5)の「編集を終える」/ ⌘E は dirty なら `ask` 2枚(続ける→破棄する)を通る。 */
const askMock = vi.mocked(ask);

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const MD_URI = 'file:///Users/a/notes/blocks.md';

/** 編集可能ブロック5種と編集不可領域5種を1つずつ含む文書。末尾のリスト項目内
 * fence は契約③(要件#49 追補b 後も source 誘導)の判定用。トップレベル fence は
 * 要件#52 で code 編集対象。 */
const MD = [
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
	'- listed item with fence:',
	'  ```javascript',
	'  const nested = 2;',
	'  ```',
	'',
].join('\n');

const PARAGRAPH_SLICE = 'First **bold** paragraph.';
const EDITED_TEXT = 'Edited paragraph';
/** 段落を `EDITED_TEXT` に書き換えて確定したときの原文(その範囲だけが変わる)。 */
const EXPECTED = MD.replace(PARAGRAPH_SLICE, EDITED_TEXT);

let rendered: { html: string; index: SourceIndex };

beforeAll(async () => {
	// 本番パイプラインの出力を使う(data-vellis-node-id / node-type・Shiki・mermaid
	// プレースホルダ・alert タイトル・rehype-raw の生 HTML がそのまま載る)。
	const result = await renderMarkdown(MD, MD_URI);
	rendered = { html: result.html, index: result.index };
	expect(rendered.index.byId.size).toBeGreaterThan(0);
});

function mdDoc(): DocumentPayload {
	return { uri: MD_URI, content: MD, modified: 1 };
}

/** markdown 文書を windowState と Viewer の両方に載せてマウントする。 */
function renderMarkdownDoc() {
	const doc = mdDoc();
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

function body(container: HTMLElement): HTMLElement {
	return q(container, '.markdown-body');
}

/** blockquote の外にある最初の段落。 */
function plainParagraph(container: HTMLElement): HTMLElement {
	const p = [...container.querySelectorAll('p[data-vellis-node-type="paragraph"]')].find(
		(el) => !el.closest('blockquote'),
	);
	if (!p) throw new Error('blockquote 外の段落が無い');
	return p as HTMLElement;
}

/** alert ではない blockquote の中の段落(引用段落)。 */
function quoteParagraph(container: HTMLElement): HTMLElement {
	const bq = [...container.querySelectorAll('blockquote')].find(
		(el) => !el.classList.contains('markdown-alert'),
	);
	if (!bq) throw new Error('通常の blockquote が無い');
	return q(bq, 'p[data-vellis-node-type="paragraph"]');
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

/**
 * 確定・破棄のハンドラが await を連ねても連鎖全体を確定させる
 * (Viewer.edit.wiring.test.ts の `settle` と同じ)。
 */
async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}

/** ブロックをダブルクリックして編集に入る。 */
async function beginBlockEdit(el: HTMLElement) {
	await fireEvent.dblClick(el);
	await settle();
}

/** ブロック外(別のブロック)をクリックして確定する。 */
async function clickOutside(container: HTMLElement) {
	const other = q(container, 'h1[data-vellis-node-type="heading"]');
	await fireEvent.mouseDown(other);
	await fireEvent.click(other);
	await settle();
}

/** 段落を編集中にして `EDITED_TEXT` へ書き換えた状態を返す(確定前)。 */
async function editParagraph() {
	const r = renderMarkdownDoc();
	const p = plainParagraph(r.container);
	const originalText = p.textContent;
	await beginBlockEdit(p);
	expect(isEditable(p)).toBe(true);
	p.textContent = EDITED_TEXT;
	await fireEvent.input(p);
	return { ...r, p, originalText };
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
// AC-49-1 — ダブルクリックしたブロックだけ contenteditable(契約①)
// ---------------------------------------------------------------------------

describe('Viewer — ダブルクリックしたブロックだけが contenteditable(契約①)', () => {
	it('閲覧中はどの要素も contenteditable ではない', () => {
		const { container } = renderMarkdownDoc();
		expect(editables(container)).toEqual([]);
		expect(sourcePre(container)).toBeNull();
	});

	const CASES: Array<[string, (c: HTMLElement) => HTMLElement]> = [
		['段落', plainParagraph],
		['見出し', (c) => q(c, 'h1[data-vellis-node-type="heading"]')],
		['リスト項目', (c) => q(c, 'li[data-vellis-node-type="listItem"]')],
		['表セル', (c) => q(c, 'td[data-vellis-node-type="tableCell"]')],
		['引用段落', quoteParagraph],
	];

	it.each(CASES)('%s: そのブロックだけが contenteditable="true"', async (_label, pick) => {
		const { container } = renderMarkdownDoc();
		const target = pick(container);

		await beginBlockEdit(target);

		expect(isEditable(target)).toBe(true);
		// 編集可になるのはこの1要素だけ(他のブロックもコンテナも不可=契約①)。
		expectOnlyEditable(container, target);
		expect(isEditable(body(container))).toBe(false);
		// レンダリング結果は残る(ソース編集モードへは落ちない)。
		expect(sourcePre(container)).toBeNull();
		expect(container.querySelector('h1[data-vellis-node-type="heading"]')).not.toBeNull();
	});

	it('inline 要素(strong)の上のダブルクリックは、それを含む段落が編集単位になる', async () => {
		const { container } = renderMarkdownDoc();
		const p = plainParagraph(container);
		const strong = q(p, 'strong');

		await beginBlockEdit(strong);

		expectOnlyEditable(container, p);
		expect(isEditable(strong)).toBe(false);
	});

	it('単クリックとキー入力では編集に入らない(閲覧中の誤タッチで dirty にならない)', async () => {
		const { container } = renderMarkdownDoc();
		const p = plainParagraph(container);

		await fireEvent.click(p);
		await fireEvent.keyDown(p, { key: 'a' });
		await settle();

		expect(editables(container)).toEqual([]);
		expect(windowState.dirty).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC-49-2 — 編集不可領域はソース編集モードへ誘導(契約③)
// ---------------------------------------------------------------------------

describe('Viewer — 編集不可領域のダブルクリックはソース編集モードへ誘導(契約③)', () => {
	const CASES: Array<[string, (c: HTMLElement) => HTMLElement]> = [
		['生 HTML ブロック', (c) => q(c, 'div.raw')],
		// 要件#49 追補b(2026-09-14・要件#52 による契約③改訂): トップレベル fence は
		// code 編集へ置き換わったため(Viewer.codeedit.wiring.test.ts が固定)、
		// 誘導の判定は契約③に残るリスト項目内 fence で行う。
		['リスト項目内の code fence', (c) => q(c, 'li pre > code')],
		['mermaid', (c) => q(c, '.vellis-mermaid')],
		['alert タイトル', (c) => q(c, 'p.markdown-alert-title')],
		['id を持たない要素(本文コンテナ)', body],
	];

	it.each(CASES)(
		'%s: ブロックは contenteditable にならず、document.content のソース編集 <pre> が開く',
		async (_label, pick) => {
			const { container } = renderMarkdownDoc();
			const target = pick(container);

			await beginBlockEdit(target);

			// 要件#48 のソース編集モード(Viewer.edit.wiring.test.ts「markdown のソース
			// 編集モード」と同じ形): editMode=edit・<pre contenteditable> に原文。
			expect(windowState.editMode).toBe('edit');
			expect(windowState.editBuffer).toBe(MD);
			const pre = sourcePre(container);
			expect(pre).not.toBeNull();
			expect(isEditable(pre as HTMLElement)).toBe(true);
			expect(pre?.textContent).toBe(MD);
			// レンダリング済みのブロックは編集可になっていない(残っていれば false)。
			expectOnlyEditable(container, pre as HTMLElement);
			// 誘導しただけで dirty にはならない。
			expect(windowState.dirty).toBe(false);
		},
	);
});

// ---------------------------------------------------------------------------
// AC-49-5 — 確定と破棄(契約②)
// ---------------------------------------------------------------------------

describe('Viewer — ブロック外クリックで確定・Esc で破棄(契約②)', () => {
	it('ブロック外クリックで確定: editBuffer が範囲差し替え後の原文になり dirty', async () => {
		const { container } = await editParagraph();

		await clickOutside(container);

		expect(windowState.editBuffer).toBe(EXPECTED);
		expect(windowState.dirty).toBe(true);
		// 編集は閉じる(contenteditable が残らない)。
		expect(editables(container)).toEqual([]);
	});

	it('確定後もレンダリング結果が見えたまま(ソース編集の <pre> に落ちない)', async () => {
		const { container } = await editParagraph();

		await clickOutside(container);

		expect(sourcePre(container)).toBeNull();
		expect(container.querySelector('h1[data-vellis-node-type="heading"]')).not.toBeNull();
		expect(container.querySelector('td[data-vellis-node-type="tableCell"]')).not.toBeNull();
	});

	it('確定は編集したブロックの範囲だけを変える(前後の原文は byte 等価=契約⑥)', async () => {
		const { container } = await editParagraph();

		await clickOutside(container);

		const buffer = windowState.editBuffer ?? '';
		const start = MD.indexOf(PARAGRAPH_SLICE);
		const end = start + PARAGRAPH_SLICE.length;
		expect(buffer.slice(0, start)).toBe(MD.slice(0, start));
		expect(buffer.slice(buffer.length - (MD.length - end))).toBe(MD.slice(end));
	});

	it('Esc で破棄: document.content も dirty も動かず、ブロックの表示が元に戻る', async () => {
		const { container, p, originalText } = await editParagraph();

		await fireEvent.keyDown(p, { key: 'Escape' });
		await settle();

		expect(windowState.currentDocument?.content).toBe(MD);
		expect(windowState.dirty).toBe(false);
		expect(windowState.editBuffer === null || windowState.editBuffer === MD).toBe(true);
		expect(editables(container)).toEqual([]);
		expect(sourcePre(container)).toBeNull();
		// 破棄=画面からも消える(直した文字が残ったままなら破棄になっていない)。
		expect(plainParagraph(container).textContent).toBe(originalText);
		expect(container.textContent).not.toContain(EDITED_TEXT);
	});

	it('何も変えずにブロック外クリックしても dirty にならない', async () => {
		const { container } = renderMarkdownDoc();
		await beginBlockEdit(plainParagraph(container));

		await clickOutside(container);

		expect(windowState.dirty).toBe(false);
		expect(editables(container)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// AC-49-8 — 要件#48 の保存・dirty・エコー抑止の流用(契約⑦)
// ---------------------------------------------------------------------------

describe('Viewer — 確定後の dirty は要件#48 の経路をそのまま通る(契約⑦)', () => {
	it('確定後は editMode=edit かつ dirty(⌘S の saveCurrentEdits と decideFileChanged の門が開く状態)', async () => {
		const { container } = await editParagraph();

		await clickOutside(container);

		// +page.svelte の ⌘S ハンドラ `saveCurrentEdits` は
		// `editMode === 'edit' && dirty && editBuffer !== null` でしか保存しない。
		// `decideFileChanged` の external-conflict も mode==='edit' が条件。
		expect(windowState.editMode).toBe('edit');
		expect(windowState.dirty).toBe(true);
		expect(windowState.editBuffer).toBe(EXPECTED);
	});

	it('⌘S の本体 saveDocument が確定後の内容で save_document を呼び、成功後に dirty が消える', async () => {
		const { container } = await editParagraph();
		await clickOutside(container);
		invokeMock.mockResolvedValueOnce(undefined);

		await saveDocument(MD_URI, windowState.editBuffer ?? '');

		expect(invokeMock).toHaveBeenCalledWith('save_document', {
			uri: MD_URI,
			content: EXPECTED,
		});
		expect(windowState.currentDocument?.content).toBe(EXPECTED);
		expect(windowState.dirty).toBe(false);
	});

	it('保存が返す file_changed は ignore-echo で、レンダリング DOM を作り直さない', async () => {
		const { container } = await editParagraph();
		await clickOutside(container);
		invokeMock.mockResolvedValueOnce(undefined);
		await saveDocument(MD_URI, windowState.editBuffer ?? '');
		const h1Before = q(container, 'h1[data-vellis-node-type="heading"]');

		const decision = windowState.applyFileChanged({ uri: MD_URI, content: EXPECTED, modified: 2 });
		await settle();

		expect(decision).toBe('ignore-echo');
		expect(windowState.externalChange).toBeNull();
		expect(sourcePre(container)).toBeNull();
		expect(q(container, 'h1[data-vellis-node-type="heading"]')).toBe(h1Before);
	});

	it('保存前に届いた外部変更は external-conflict でバナーが出る(編集内容を捨てない)', async () => {
		const { container } = await editParagraph();
		await clickOutside(container);

		const decision = windowState.applyFileChanged({
			uri: MD_URI,
			content: '# rewritten outside\n',
			modified: 9,
		});
		await settle();

		expect(decision).toBe('external-conflict');
		expect(windowState.editBuffer).toBe(EXPECTED);
		expect(windowState.currentDocument?.content).toBe(MD);
		expect(screen.getByTestId('external-change-banner')).toBeTruthy();
	});
});

// ===========================================================================
// 追補a(2026-09-11)— 連続編集・Esc と誘導の破棄範囲・リンク/画像の原文表記
// ===========================================================================

// ---------------------------------------------------------------------------
// 追補a のフィクスチャ
// ---------------------------------------------------------------------------

/**
 * 連続編集用: プレーンな段落3つ+編集不可領域(リスト項目内 fence。要件#49 追補b
 * 後も source 誘導)+末尾にトップレベル fence(要件#52 で code 編集対象)。段落は
 * 装飾を持たず、
 * 逆シリアライズが一字一句同じ Markdown を返す語だけで書く(記法のエスケープが
 * 混ざらないよう `*` `_` `[` `#` を避ける)ので、`editBuffer` を**文字列そのもの**で
 * 判定できる。
 */
const SEQ_MD = [
	'# Title',
	'',
	'First paragraph.',
	'',
	'Second paragraph.',
	'',
	'Third paragraph.',
	'',
	'- listed item with fence:',
	'  ```javascript',
	'  const nested = 2;',
	'  ```',
	'',
	'```javascript',
	'const x = 1;',
	'```',
	'',
].join('\n');

/**
 * リンク・画像用: 相対リンクと相対画像を1段落に含む。`MD_URI` でレンダーすると
 * href は `file:///Users/a/notes/other.md`・src は `vellis-asset://local/Users/a/notes/
 * images/cat.png` へ書き換わる(rewrite-uri)。
 */
const LINK_MD = [
	'# Title',
	'',
	'See [other](./other.md) and ![cat](images/cat.png) here.',
	'',
	'Tail.',
	'',
].join('\n');

let renderedSeq: { html: string; index: SourceIndex };
let renderedLink: { html: string; index: SourceIndex };

beforeAll(async () => {
	const [seq, link] = await Promise.all([
		renderMarkdown(SEQ_MD, MD_URI),
		renderMarkdown(LINK_MD, MD_URI),
	]);
	renderedSeq = { html: seq.html, index: seq.index };
	renderedLink = { html: link.html, index: link.index };
});

/** 任意の markdown 文書を windowState と Viewer の両方に載せてマウントする。 */
function mountDoc(content: string, r: { html: string; index: SourceIndex }) {
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

/** 文書順の段落(SEQ_MD なら [First, Second, Third])。 */
function paragraphs(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll('p[data-vellis-node-type="paragraph"]')] as HTMLElement[];
}

/** ブロックをダブルクリックして編集に入り、中身を `text` へ書き換える(確定前)。 */
async function typeInto(el: HTMLElement, text: string) {
	await beginBlockEdit(el);
	expect(isEditable(el)).toBe(true);
	el.textContent = text;
	await fireEvent.input(el);
}

/** ブロックを編集して確定する(1回分)。 */
async function editAndCommit(container: HTMLElement, el: HTMLElement, text: string) {
	await typeInto(el, text);
	await clickOutside(container);
}

/** `md` の段落 `from` を `to` へ差し替えた期待原文(その範囲だけが変わる)。 */
function replaced(md: string, ...pairs: Array<[from: string, to: string]>): string {
	return pairs.reduce((acc, [from, to]) => {
		if (!acc.includes(from)) throw new Error(`期待原文の組み立てで "${from}" が無い`);
		return acc.replace(from, to);
	}, md);
}

const P1 = 'First paragraph.';
const P2 = 'Second paragraph.';
const P3 = 'Third paragraph.';
/** 長さが増える編集。 */
const P1_LONGER = 'First paragraph, now made much longer than it was before.';
/** 長さが減る編集。 */
const P1_SHORTER = 'P1.';
const P2_EDITED = 'Second edited.';
const P2_LONGER = 'Second paragraph, extended after the first one shrank.';

// ---------------------------------------------------------------------------
// AC-49-12 — 連続編集の原文が壊れない(契約②⑥・追補a(1))
// ---------------------------------------------------------------------------

describe('Viewer — 連続編集でも差し替えは最新の原文の正しい範囲に当たる(契約②⑥・追補a(1))', () => {
	it('段落1を長くしてから段落2を直す: 両方が反映され、未編集ブロックは byte 等価(reviewer 実測の再現)', async () => {
		const { container } = mountDoc(SEQ_MD, renderedSeq);
		const [p1, p2] = paragraphs(container);

		await editAndCommit(container, p1, P1_LONGER);
		expect(windowState.editBuffer).toBe(replaced(SEQ_MD, [P1, P1_LONGER]));

		await editAndCommit(container, p2, P2_EDITED);

		// reviewer 実測: 初回レンダー時の position で差し替えると
		// "First paragraph, nSecond edited.an before.\n\nSecond paragraph.…" に壊れた。
		expect(windowState.editBuffer).toBe(replaced(SEQ_MD, [P1, P1_LONGER], [P2, P2_EDITED]));
		expect(windowState.dirty).toBe(true);
		expect(editables(container)).toEqual([]);
	});

	it('段落1を短くしてから段落2を直す: 両方が反映され、未編集ブロックは byte 等価', async () => {
		const { container } = mountDoc(SEQ_MD, renderedSeq);
		const [p1, p2] = paragraphs(container);

		await editAndCommit(container, p1, P1_SHORTER);
		await editAndCommit(container, p2, P2_LONGER);

		expect(windowState.editBuffer).toBe(replaced(SEQ_MD, [P1, P1_SHORTER], [P2, P2_LONGER]));
		expect(windowState.dirty).toBe(true);
	});

	it('同じブロックを2回直す: 2回目は1回目の結果の範囲を置き換える(古い範囲に当てない)', async () => {
		const { container } = mountDoc(SEQ_MD, renderedSeq);
		const [p1] = paragraphs(container);

		await editAndCommit(container, p1, P1_LONGER);
		await editAndCommit(container, p1, P1_SHORTER);

		expect(windowState.editBuffer).toBe(replaced(SEQ_MD, [P1, P1_SHORTER]));
		expect(windowState.dirty).toBe(true);
	});

	it('3ブロックを順に直す(増・減・増): 3つとも反映され、見出しと code fence は byte 等価', async () => {
		const { container } = mountDoc(SEQ_MD, renderedSeq);
		const [p1, p2, p3] = paragraphs(container);
		const P3_LONGER = 'Third paragraph, also touched at the end.';

		await editAndCommit(container, p1, P1_LONGER);
		await editAndCommit(container, p2, 'S2.');
		await editAndCommit(container, p3, P3_LONGER);

		const buffer = windowState.editBuffer ?? '';
		expect(buffer).toBe(replaced(SEQ_MD, [P1, P1_LONGER], [P2, 'S2.'], [P3, P3_LONGER]));
		expect(buffer.startsWith('# Title\n\n')).toBe(true);
		expect(buffer.endsWith('\n\n```javascript\nconst x = 1;\n```\n')).toBe(true);
	});

	it('後ろのブロックを直してから前のブロックを直しても両方が反映される(順序に依らない)', async () => {
		const { container } = mountDoc(SEQ_MD, renderedSeq);
		const [p1, , p3] = paragraphs(container);
		const P3_SHORTER = 'T3.';

		await editAndCommit(container, p3, P3_SHORTER);
		await editAndCommit(container, p1, P1_LONGER);

		expect(windowState.editBuffer).toBe(replaced(SEQ_MD, [P1, P1_LONGER], [P3, P3_SHORTER]));
	});

	it('2回目の確定後も画面はレンダリング結果のまま(ソース編集の <pre> に落ちない)', async () => {
		const { container } = mountDoc(SEQ_MD, renderedSeq);
		const [p1, p2] = paragraphs(container);

		await editAndCommit(container, p1, P1_LONGER);
		await editAndCommit(container, p2, P2_EDITED);

		expect(sourcePre(container)).toBeNull();
		expect(windowState.editMode).toBe('edit');
		expect(paragraphs(container)[0].textContent).toBe(P1_LONGER);
		expect(paragraphs(container)[1].textContent).toBe(P2_EDITED);
	});
});

// ---------------------------------------------------------------------------
// AC-49-13 — Esc の破棄はそのブロックだけ(契約②・追補a(2))
// ---------------------------------------------------------------------------

describe('Viewer — Esc の破棄は編集中のブロックだけで、確定済みの編集と dirty は残る(契約②・追補a(2))', () => {
	it('ブロックAを確定→ブロックBを編集→Esc: Aの編集結果と dirty が残り、閲覧へ戻らない', async () => {
		const { container } = mountDoc(SEQ_MD, renderedSeq);
		const [p1, p2] = paragraphs(container);
		await editAndCommit(container, p1, P1_LONGER);
		const afterA = replaced(SEQ_MD, [P1, P1_LONGER]);
		expect(windowState.editBuffer).toBe(afterA);
		await typeInto(p2, P2_EDITED);

		await fireEvent.keyDown(p2, { key: 'Escape' });
		await settle();

		// reviewer 実測: 現状は editBuffer=null・dirty=false・mode=view に落ちる。
		expect(windowState.editBuffer).toBe(afterA);
		expect(windowState.dirty).toBe(true);
		expect(windowState.editMode).toBe('edit');
		expect(sourcePre(container)).toBeNull();
		// Bの編集だけが破棄される(Bの表示は元に戻り、Aの表示は直したまま)。
		expect(editables(container)).toEqual([]);
		expect(paragraphs(container)[1].textContent).toBe(P2);
		expect(paragraphs(container)[0].textContent).toBe(P1_LONGER);
		expect(container.textContent).not.toContain(P2_EDITED);
	});

	it('Esc で破棄したあとも、続けて別のブロックを編集して確定できる(破棄が編集を閉じない)', async () => {
		const { container } = mountDoc(SEQ_MD, renderedSeq);
		const [p1, p2, p3] = paragraphs(container);
		await editAndCommit(container, p1, P1_LONGER);
		await typeInto(p2, P2_EDITED);
		await fireEvent.keyDown(p2, { key: 'Escape' });
		await settle();

		await editAndCommit(container, p3, 'T3.');

		expect(windowState.editBuffer).toBe(replaced(SEQ_MD, [P1, P1_LONGER], [P3, 'T3.']));
		expect(windowState.dirty).toBe(true);
	});

	it('編集に入る前が閲覧だった場合の Esc は従来どおり閲覧へ戻る(editMode=view・dirty なし)', async () => {
		const { container } = mountDoc(SEQ_MD, renderedSeq);
		const [p1] = paragraphs(container);
		expect(windowState.editMode).toBe('view');
		await typeInto(p1, P1_LONGER);

		await fireEvent.keyDown(p1, { key: 'Escape' });
		await settle();

		expect(windowState.editMode).toBe('view');
		expect(windowState.editBuffer).toBeNull();
		expect(windowState.dirty).toBe(false);
		expect(windowState.currentDocument?.content).toBe(SEQ_MD);
		expect(editables(container)).toEqual([]);
		expect(paragraphs(container)[0].textContent).toBe(P1);
	});
});

// ---------------------------------------------------------------------------
// AC-49-14 — 確定後の誘導が編集を捨てない(契約②③・追補a(3))
// ---------------------------------------------------------------------------

describe('Viewer — 確定後に編集不可領域をダブルクリックしても、確定済みの編集と dirty が残る(契約②③・追補a(3))', () => {
	// 要件#49 追補b(2026-09-14・要件#52 による契約③改訂): トップレベル fence は
	// code 編集へ置き換わったため、誘導の判定はリスト項目内 fence で行う。
	const CASES: Array<[string, (c: HTMLElement) => HTMLElement]> = [
		['リスト項目内の code fence', (c) => q(c, 'li pre > code')],
		['id を持たない要素(本文コンテナ)', body],
	];

	it.each(CASES)(
		'%s: ソース編集モードへ誘導され、<pre> の原文は差し替え後の内容で dirty のまま',
		async (_label, pick) => {
			const { container } = mountDoc(SEQ_MD, renderedSeq);
			const [p1] = paragraphs(container);
			await editAndCommit(container, p1, P1_LONGER);
			const afterA = replaced(SEQ_MD, [P1, P1_LONGER]);
			expect(windowState.dirty).toBe(true);

			await beginBlockEdit(pick(container));

			// reviewer 実測: 現状は beginEdit() が再度呼ばれ dirty=false・editBuffer が
			// document.content へ戻る。誘導はモードの切り替えだけ(追補a(3))。
			expect(windowState.editMode).toBe('edit');
			expect(windowState.editBuffer).toBe(afterA);
			expect(windowState.dirty).toBe(true);
			const pre = sourcePre(container);
			expect(pre).not.toBeNull();
			expect(isEditable(pre as HTMLElement)).toBe(true);
			expect(pre?.textContent).toBe(afterA);
			expectOnlyEditable(container, pre as HTMLElement);
			expect(windowState.currentDocument?.content).toBe(SEQ_MD);
		},
	);

	it('誘導後のソース編集モードで ⌘S の本体 saveDocument が差し替え後の内容で save_document を呼ぶ', async () => {
		const { container } = mountDoc(SEQ_MD, renderedSeq);
		const [p1] = paragraphs(container);
		await editAndCommit(container, p1, P1_LONGER);
		// 追補b: 誘導はリスト項目内 fence で(トップレベル fence は code 編集=要件#52)。
		await beginBlockEdit(q(container, 'li pre > code'));
		invokeMock.mockResolvedValueOnce(undefined);

		await saveDocument(MD_URI, windowState.editBuffer ?? '');

		expect(invokeMock).toHaveBeenCalledWith('save_document', {
			uri: MD_URI,
			content: replaced(SEQ_MD, [P1, P1_LONGER]),
		});
	});
});

// ---------------------------------------------------------------------------
// AC-49-15 — リンク・画像は原文表記を保つ(契約⑥・追補a(4))
// ---------------------------------------------------------------------------

describe('Viewer — 確定後の原文にリンク・画像の内部 URI が混入しない(契約⑥・追補a(4))', () => {
	const LINK_SLICE = 'See [other](./other.md) and ![cat](images/cat.png) here.';

	it('レンダー結果の DOM には内部 URI が載っている(前提の確認)', () => {
		const { container } = mountDoc(LINK_MD, renderedLink);
		const p = paragraphs(container)[0];
		expect(q(p, 'a').getAttribute('href')).toBe('file:///Users/a/notes/other.md');
		expect(q(p, 'img').getAttribute('src')).toBe('vellis-asset://local/Users/a/notes/images/cat.png');
	});

	it('段落の先頭テキストだけを直して確定: editBuffer に `./other.md` と `images/cat.png` が元の表記のまま残る', async () => {
		const { container } = mountDoc(LINK_MD, renderedLink);
		const p = paragraphs(container)[0];
		await beginBlockEdit(p);
		const first = p.firstChild;
		if (!first || first.nodeType !== Node.TEXT_NODE) throw new Error('先頭がテキストではない');
		first.textContent = 'Look at ';
		await fireEvent.input(p);

		await clickOutside(container);

		const buffer = windowState.editBuffer ?? '';
		expect(windowState.dirty).toBe(true);
		// reviewer 実測: `[other](file:///…/other.md)`・`![cat](vellis-asset://local/…/cat.png)`
		// が原文へ焼き付いた。再レンダー HTML は一致してしまうので、原文文字列で判定する。
		expect(buffer).not.toContain('file://');
		expect(buffer).not.toContain('vellis-asset://');
		expect(buffer).toContain('[other](./other.md)');
		expect(buffer).toContain('![cat](images/cat.png)');
		// 差し替えたのはこの段落の範囲だけ(前後は byte 等価)。
		expect(buffer.startsWith('# Title\n\nLook at ')).toBe(true);
		expect(buffer.endsWith(' here.\n\nTail.\n')).toBe(true);
		expect(buffer).not.toContain(LINK_SLICE);
	});

	it('リンクの文言を直して確定しても URI は元の相対表記のまま', async () => {
		const { container } = mountDoc(LINK_MD, renderedLink);
		const p = paragraphs(container)[0];
		await beginBlockEdit(p);
		q(p, 'a').textContent = 'the other doc';
		await fireEvent.input(p);

		await clickOutside(container);

		const buffer = windowState.editBuffer ?? '';
		expect(buffer).toContain('[the other doc](./other.md)');
		expect(buffer).toContain('![cat](images/cat.png)');
		expect(buffer).not.toMatch(/file:\/\/|vellis-asset:\/\//);
	});
});

// ===========================================================================
// 追補a(5)(6)(7)(2026-09-11・2周目の reviewer 照合で追加)— 閲覧へ戻ったら位置の
// 記録も捨てる・外部変更の再レンダーで編集中ブロックを手放す・逆写像できない
// リンク表記は誘導へ回す
// ===========================================================================

// ---------------------------------------------------------------------------
// 追補a(5)(6)(7) のフィクスチャ
// ---------------------------------------------------------------------------

/** 「読み直す」で採用される外部版(AC-49-16)。SEQ_MD とは段落の位置も長さも違う。 */
const EXT_MD = ['# Reloaded', '', 'Alpha paragraph.', '', 'Beta paragraph.', ''].join('\n');

/**
 * ブロック編集中に apply される外部版(AC-49-17)。SEQ_MD の段落1の範囲(offset
 * 9〜25)が、この原文では `Brand new conten` に当たる = 旧位置で差し替えると
 * reviewer 実測 `"# New\n\nBrFirst paragraph.that is different.\n"` の形に壊れる。
 */
const NEW_MD = ['# New', '', 'Brand new content that is different.', ''].join('\n');
const NEW_P = 'Brand new content that is different.';

/**
 * 逆写像できないリンク表記(AC-49-18)。参照リンク `[other][ref]`(定義は別行)と
 * 角括弧で囲んだ行き先 `[c](<sub dir/z.md>)`。同じ文書にインラインリンクの段落も
 * 置き、そちらは AC-49-15 どおりブロック編集に入れることを併せて固定する。
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
	'[ref]: ./other.md',
	'',
].join('\n');

let renderedExt: { html: string; index: SourceIndex };
let renderedNew: { html: string; index: SourceIndex };
let renderedRef: { html: string; index: SourceIndex };

beforeAll(async () => {
	const [ext, next, ref] = await Promise.all([
		renderMarkdown(EXT_MD, MD_URI),
		renderMarkdown(NEW_MD, MD_URI),
		renderMarkdown(REF_MD, MD_URI),
	]);
	renderedExt = { html: ext.html, index: ext.index };
	renderedNew = { html: next.html, index: next.index };
	renderedRef = { html: ref.html, index: ref.index };
});

/**
 * 「編集を終える」の破棄。dirty なので edit-guard の `ask` が2枚出る
 * (1枚目=続ける・2枚目=破棄する)。保存は走らず `endEdit()` で閲覧へ戻る。
 */
async function finishEditDiscarding() {
	askMock.mockResolvedValueOnce(true);
	askMock.mockResolvedValueOnce(false);
	await fireEvent.click(screen.getByTestId('edit-done'));
	await settle();
	expect(askMock).toHaveBeenCalledTimes(2);
	expect(invokeMock).not.toHaveBeenCalledWith('save_document', expect.anything());
}

/**
 * ⌘E(Edit メニュー)。実体は +page.svelte の `toggleEditMode` で、メニュー
 * イベントはこのテストから鳴らせない。Viewer からは windowState の遷移としてしか
 * 見えないので、その遷移をそのまま写す: 閲覧なら `beginEdit()`・編集中で dirty なら
 * `confirmDiscardEdits()`(edit-guard の `ask` 2枚)・非 dirty なら `endEdit()`。
 * 破棄のときは `ask` に続ける→破棄すると答える。
 */
async function commandE() {
	if (windowState.editMode !== 'edit') {
		windowState.beginEdit();
	} else if (windowState.dirty) {
		askMock.mockResolvedValueOnce(true);
		askMock.mockResolvedValueOnce(false);
		await confirmDiscardEdits();
	} else {
		windowState.endEdit();
	}
	await settle();
}

/**
 * ページ側の再レンダー。+page.svelte は `currentDocument` が変わるたびに
 * `renderForDisplay` → `setRenderResult` を通し、Viewer の `document` / `html` /
 * `index` props を差し替える(旧 DOM は `{@html}` ごと作り直される)。
 */
async function rerenderAs(
	rerender: ReturnType<typeof mountDoc>['rerender'],
	content: string,
	r: { html: string; index: SourceIndex },
) {
	const doc = windowState.currentDocument;
	if (!doc) throw new Error('currentDocument が無い');
	expect(doc.content).toBe(content);
	await rerender({ document: doc, html: r.html, index: r.index });
	await settle();
}

/** ソース編集の `<pre>` が `content` を載せて開いていて、他に編集可な要素が無いこと。 */
function expectSourceEditing(container: HTMLElement, content: string) {
	expect(windowState.editMode).toBe('edit');
	const pre = sourcePre(container);
	expect(pre).not.toBeNull();
	expect(isEditable(pre as HTMLElement)).toBe(true);
	expect(pre?.textContent).toBe(content);
	expectOnlyEditable(container, pre as HTMLElement);
}

// ---------------------------------------------------------------------------
// AC-49-16 — 閲覧へ戻ったら位置の記録も捨てる(契約②⑦・追補a(5))
// ---------------------------------------------------------------------------

describe('Viewer — 閲覧へ戻ったら確定済み差し替えの記録も捨てる(契約②⑦・追補a(5))', () => {
	it('段落1を確定→「編集を終える」で破棄→段落2を編集して確定: 古い差分が乗らず原文が壊れない(reviewer 実測の再現)', async () => {
		const { container } = mountDoc(SEQ_MD, renderedSeq);
		const [p1, p2] = paragraphs(container);
		await editAndCommit(container, p1, P1_LONGER);
		expect(windowState.dirty).toBe(true);

		await finishEditDiscarding();
		expect(windowState.editMode).toBe('view');
		expect(windowState.editBuffer).toBeNull();
		expect(windowState.currentDocument?.content).toBe(SEQ_MD);

		await editAndCommit(container, p2, P2_EDITED);

		// reviewer 実測: 段落1の増分(+41)が残ったまま段落2の位置へ足され、
		// "…Third paragraph.\n\n```jSecond edited. = 1;\n```\n" と code fence を壊した。
		// 破棄した段落1の編集は戻らず、段落2だけが SEQ_MD 基準で差し替わる。
		expect(windowState.editBuffer).toBe(replaced(SEQ_MD, [P2, P2_EDITED]));
		expect(windowState.dirty).toBe(true);
		expect(windowState.currentDocument?.content).toBe(SEQ_MD);
	});

	it('段落1を確定→「編集を終える」で破棄→⌘E: ソース編集の <pre> が document.content で開く(要件#48 契約③のトグルが退行しない)', async () => {
		const { container } = mountDoc(SEQ_MD, renderedSeq);
		const [p1] = paragraphs(container);
		await editAndCommit(container, p1, P1_LONGER);
		await finishEditDiscarding();
		expect(windowState.editMode).toBe('view');

		await commandE();

		// reviewer 実測: mode=edit なのに pre shown=false / html shown=true(ブロック
		// 編集の印が閲覧へ戻っても残り、ソース編集モードに入れない)。
		expectSourceEditing(container, SEQ_MD);
		expect(windowState.dirty).toBe(false);
	});

	it('段落1を確定→⌘E(破棄)→段落2を編集して確定: 古い差分が乗らない', async () => {
		const { container } = mountDoc(SEQ_MD, renderedSeq);
		const [p1, p2] = paragraphs(container);
		await editAndCommit(container, p1, P1_LONGER);

		await commandE();
		expect(askMock).toHaveBeenCalledTimes(2);
		expect(windowState.editMode).toBe('view');
		expect(windowState.editBuffer).toBeNull();

		await editAndCommit(container, p2, P2_EDITED);

		expect(windowState.editBuffer).toBe(replaced(SEQ_MD, [P2, P2_EDITED]));
		expect(windowState.dirty).toBe(true);
	});

	it('段落1を確定→⌘E(破棄)→⌘E: ソース編集の <pre> が開く', async () => {
		const { container } = mountDoc(SEQ_MD, renderedSeq);
		const [p1] = paragraphs(container);
		await editAndCommit(container, p1, P1_LONGER);
		await commandE();
		expect(windowState.editMode).toBe('view');

		await commandE();

		expectSourceEditing(container, SEQ_MD);
	});

	it('段落1を確定→衝突バナーの「読み直す」→再レンダー→⌘E: 外部版のソース編集 <pre> が開く', async () => {
		const { container, rerender } = mountDoc(SEQ_MD, renderedSeq);
		const [p1] = paragraphs(container);
		await editAndCommit(container, p1, P1_LONGER);
		expect(windowState.applyFileChanged({ uri: MD_URI, content: EXT_MD, modified: 9 })).toBe(
			'external-conflict',
		);
		await settle();

		await fireEvent.click(screen.getByTestId('external-reload'));
		await settle();
		expect(windowState.editMode).toBe('view');
		expect(windowState.editBuffer).toBeNull();
		await rerenderAs(rerender, EXT_MD, renderedExt);
		expect(q(container, 'h1[data-vellis-node-type="heading"]').textContent).toBe('Reloaded');

		await commandE();

		expectSourceEditing(container, EXT_MD);
		expect(windowState.dirty).toBe(false);
	});

	it('段落1を確定→「読み直す」→再レンダー→外部版の段落を編集して確定: 古い差分が乗らない', async () => {
		const { container, rerender } = mountDoc(SEQ_MD, renderedSeq);
		const [p1] = paragraphs(container);
		await editAndCommit(container, p1, P1_LONGER);
		windowState.applyFileChanged({ uri: MD_URI, content: EXT_MD, modified: 9 });
		await settle();
		await fireEvent.click(screen.getByTestId('external-reload'));
		await settle();
		await rerenderAs(rerender, EXT_MD, renderedExt);

		const [, beta] = paragraphs(container);
		expect(beta.textContent).toBe('Beta paragraph.');
		await editAndCommit(container, beta, 'Beta edited.');

		expect(windowState.editBuffer).toBe(replaced(EXT_MD, ['Beta paragraph.', 'Beta edited.']));
		expect(windowState.dirty).toBe(true);
		expect(windowState.currentDocument?.content).toBe(EXT_MD);
	});
});

// ---------------------------------------------------------------------------
// AC-49-17 — 外部変更でレンダーが作り直されたら編集中ブロックを手放す(契約②・追補a(6))
// ---------------------------------------------------------------------------

describe('Viewer — 外部変更が apply されて再レンダーされたら編集中ブロックを手放す(契約②・追補a(6))', () => {
	/** 段落1をブロック編集中(まだ何も打っていない=非 dirty)に外部変更が apply される。 */
	async function externalChangeWhileEditing() {
		const r = mountDoc(SEQ_MD, renderedSeq);
		const [p1] = paragraphs(r.container);
		await beginBlockEdit(p1);
		expect(isEditable(p1)).toBe(true);
		expect(windowState.dirty).toBe(false);

		// 要件#48 契約⑥: 編集中でも未変更なら apply(外部版に追従してよい)。
		expect(windowState.applyFileChanged({ uri: MD_URI, content: NEW_MD, modified: 2 })).toBe('apply');
		await rerenderAs(r.rerender, NEW_MD, renderedNew);

		// 掴んでいた段落1は切り離された旧 DOM になっている(前提の確認)。
		expect(p1.isConnected).toBe(false);
		expect(q(r.container, 'h1[data-vellis-node-type="heading"]').textContent).toBe('New');
		return r;
	}

	it('再レンダー後の最初の mousedown で旧位置の差し替えが走らない(新しい原文が壊れない=reviewer 実測の再現)', async () => {
		const { container } = await externalChangeWhileEditing();

		// 次のクリック(別のブロックへの mousedown=確定の契機)。
		const h1 = q(container, 'h1[data-vellis-node-type="heading"]');
		await fireEvent.mouseDown(h1);
		await fireEvent.click(h1);
		await settle();

		// reviewer 実測: "# New\n\nBrFirst paragraph.that is different.\n"・dirty=true。
		expect(windowState.currentDocument?.content).toBe(NEW_MD);
		expect(windowState.editBuffer ?? windowState.currentDocument?.content).toBe(NEW_MD);
		expect(windowState.dirty).toBe(false);
		// 勝手にソース編集モードへ落ちず、レンダリング結果(外部版)が見えたまま。
		expect(sourcePre(container)).toBeNull();
		expect(editables(container)).toEqual([]);
	});

	it('再レンダー後は外部版のブロックを新しい位置で編集して確定できる(旧ブロックの掴みが邪魔しない)', async () => {
		const { container } = await externalChangeWhileEditing();
		const [p] = paragraphs(container);
		expect(p.textContent).toBe(NEW_P);

		// 実機のダブルクリックは mousedown → dblclick の順で届く。
		await fireEvent.mouseDown(p);
		await fireEvent.click(p);
		await settle();
		await typeInto(p, 'Replaced.');
		await clickOutside(container);

		expect(windowState.editBuffer).toBe(replaced(NEW_MD, [NEW_P, 'Replaced.']));
		expect(windowState.dirty).toBe(true);
		expect(windowState.currentDocument?.content).toBe(NEW_MD);
	});
});

// ---------------------------------------------------------------------------
// AC-49-18 — 逆写像できないリンク表記は誘導へ回す(契約③⑥・追補a(7))
// ---------------------------------------------------------------------------

describe('Viewer — 参照リンク・角括弧の行き先を含むブロックはソース編集モードへ誘導(契約③⑥・追補a(7))', () => {
	const CASES: Array<[string, (c: HTMLElement) => HTMLElement]> = [
		['参照リンク `[other][ref]` の段落', (c) => paragraphs(c)[0]],
		['参照リンクの <a> の上', (c) => q(paragraphs(c)[0], 'a')],
		['角括弧の行き先 `[c](<sub dir/z.md>)` の段落', (c) => paragraphs(c)[1]],
	];

	it('レンダー結果の DOM では参照リンクも角括弧の行き先も内部 URI に書き換わっている(前提の確認)', () => {
		const { container } = mountDoc(REF_MD, renderedRef);
		const [ref, angle] = paragraphs(container);
		expect(q(ref, 'a').getAttribute('href')).toBe('file:///Users/a/notes/other.md');
		expect(q(angle, 'a').getAttribute('href') ?? '').toMatch(/^file:\/\/\/Users\/a\/notes\/.*z\.md$/);
	});

	it.each(CASES)(
		'%s: ブロックは contenteditable にならず、document.content のソース編集 <pre> が開く(内部 URI は焼き付かない)',
		async (_label, pick) => {
			const { container } = mountDoc(REF_MD, renderedRef);
			const target = pick(container);

			await beginBlockEdit(target);

			// AC-49-2 と同じ形の誘導(editMode=edit・<pre contenteditable> に原文)。
			expectSourceEditing(container, REF_MD);
			expect(windowState.editBuffer).toBe(REF_MD);
			expect(windowState.editBuffer).not.toMatch(/file:\/\/|vellis-asset:\/\//);
			expect(windowState.dirty).toBe(false);
		},
	);

	it('同じ文書のインラインリンク `[d](./d.md)` の段落はブロック編集に入れる(AC-49-15 の入口を塞がない)', async () => {
		const { container } = mountDoc(REF_MD, renderedRef);
		const inline = paragraphs(container)[2];
		expect(inline.textContent).toBe('Inline d stays.');

		await beginBlockEdit(inline);

		expectOnlyEditable(container, inline);
		expect(sourcePre(container)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC-49-25 — 同じブロックの再編集でも行き先の綴りが保たれる(契約⑥・追補a(11)「位置の基準」)
// ---------------------------------------------------------------------------

/**
 * 4周目の reviewer 実測(backlog 165)。`a` / `img` の `data-source-*` は初回レンダー
 * 基準の絶対 offset なのに、確定時の行き先読みを確定後の `editBuffer` のスライスから
 * 行うと、同じブロックの2回目の確定 ―― 1回目の確定でブロックの中身の長さが初回と
 * 変わっている ―― で窓がずれ、DOM の `file://` / `vellis-asset://` がそのまま原文へ
 * 書き戻される。ダブルクリックの門(`hasIrreversibleLink`)は `index.sliceOf`
 * (初回レンダーのスライス)で判定するので素通りする。伸長・短縮の両方向で再現。
 *
 * ダブルクリック→編集→ブロック外クリックで確定、の繰り返しは実際のユーザー経路
 * そのものなので、`commitBlockEdit` が `index.sliceOf(meta.id)` を `serializeBlock` の
 * 第5引数 `originSlice` に渡す配線をここで固定する。純関数側の判定は
 * edit.acceptance.test.ts(AC-49-25 の節)。
 */
describe('Viewer — 同じブロックを2回編集して確定しても内部 URI が混入しない(契約⑥・追補a(11) / AC-49-25)', () => {
	/** 編集に入って先頭テキストノードだけを書き換える(リンク・画像には触らない)。 */
	async function editLeading(p: HTMLElement, text: string) {
		await beginBlockEdit(p);
		expect(isEditable(p)).toBe(true);
		const first = p.firstChild;
		if (!first || first.nodeType !== Node.TEXT_NODE) throw new Error('先頭がテキストではない');
		first.textContent = text;
		await fireEvent.input(p);
	}

	/** 編集に入って末尾テキストノードだけを書き換える(リンク・画像には触らない)。 */
	async function editTrailing(p: HTMLElement, text: string) {
		await beginBlockEdit(p);
		expect(isEditable(p)).toBe(true);
		const last = p.lastChild;
		if (!last || last.nodeType !== Node.TEXT_NODE) throw new Error('末尾がテキストではない');
		last.textContent = text;
		await fireEvent.input(p);
	}

	it('reviewer 実測の再現(伸長): 先頭を長くして確定→末尾を直して確定 → editBuffer は元の綴りのまま', async () => {
		const { container } = mountDoc(LINK_MD, renderedLink);
		const p = paragraphs(container)[0];

		await editLeading(p, 'A much longer intro ');
		await clickOutside(container);
		expect(windowState.editBuffer).toBe(replaced(LINK_MD, ['See ', 'A much longer intro ']));

		await editTrailing(p, ' there.');
		await clickOutside(container);

		// reviewer 実測: 2回目の確定で `[other](file:///Users/a/notes/other.md)` と
		// `![cat](vellis-asset://local/Users/a/notes/images/cat.png)` が焼き付いた。
		expect(windowState.editBuffer).toBe(
			replaced(LINK_MD, ['See ', 'A much longer intro '], [' here.', ' there.']),
		);
		expect(windowState.editBuffer).not.toMatch(/file:\/\/|vellis-asset:\/\//);
		expect(windowState.dirty).toBe(true);
		expect(sourcePre(container)).toBeNull();
	});

	it('短縮方向でも同じ: 先頭を大きく縮めて確定→末尾を直して確定', async () => {
		// LINK_MD の 'See ' → 'S '(-2文字)では、ずれた窓にも `](./other.md)` が丸ごと
		// 残ってしまい現行実装でも読めてしまう(判別力なし)。リンクの前に 63 文字の
		// 前置きを置き、1回目で 61 文字縮める ―― 確定後のブロックは 54 文字なので、
		// 初回レンダー基準の相対位置(リンク= 63〜82 文字目・画像= 87〜109 文字目)は
		// 末尾を越え、`](` ごと窓の外=行き先を読めずに DOM の内部 URI が書き戻される。
		const SHRINK_LEAD = 'A very long introductory sentence that will disappear entirely ';
		const SHRINK_MD = [
			'# Title',
			'',
			`${SHRINK_LEAD}[other](./other.md) and ![cat](images/cat.png) here.`,
			'',
			'Tail.',
			'',
		].join('\n');
		const r = await renderMarkdown(SHRINK_MD, MD_URI);
		const { container } = mountDoc(SHRINK_MD, { html: r.html, index: r.index });
		const p = paragraphs(container)[0];

		await editLeading(p, 'S ');
		await clickOutside(container);
		expect(windowState.editBuffer).toBe(replaced(SHRINK_MD, [SHRINK_LEAD, 'S ']));

		await editTrailing(p, ' there.');
		await clickOutside(container);

		expect(windowState.editBuffer).toBe(
			replaced(SHRINK_MD, [SHRINK_LEAD, 'S '], [' here.', ' there.']),
		);
		expect(windowState.editBuffer).not.toMatch(/file:\/\/|vellis-asset:\/\//);
	});

	it('再編集のあとに別のブロックを編集しても壊れない(追補a(1) の delta 補正との両立)', async () => {
		const { container } = mountDoc(LINK_MD, renderedLink);
		const [linkP, tailP] = paragraphs(container);
		expect(tailP.textContent).toBe('Tail.');

		await editLeading(linkP, 'A much longer intro ');
		await clickOutside(container);
		await editTrailing(linkP, ' there.');
		await clickOutside(container);

		await editAndCommit(container, tailP, 'Tail edited.');

		expect(windowState.editBuffer).toBe(
			replaced(
				LINK_MD,
				['See ', 'A much longer intro '],
				[' here.', ' there.'],
				['Tail.', 'Tail edited.'],
			),
		);
		expect(windowState.editBuffer).not.toMatch(/file:\/\/|vellis-asset:\/\//);
		expect(windowState.dirty).toBe(true);
	});
});
