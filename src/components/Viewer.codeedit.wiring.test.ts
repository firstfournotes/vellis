/**
 * 要件#52 の受け入れテスト(docs/requirements/req-52.md)— Viewer の code fence
 * その場編集の配線(component プロジェクト)
 *
 * 純関数(splitCodeFence / assembleCodeFence / resolveEditTarget の code 種別)の
 * 判定は src/markdown/code-edit.acceptance.test.ts(unit 側)。ここは
 * `Viewer.svelte` を JSDOM にマウントし、本番パイプライン(`render`)の HTML と
 * `SourceIndex` を props に渡して、**ダブルクリック→素テキストの contenteditable→
 * 確定/破棄→要件#48 の保存経路**の配線を判定する。要件#49 の wiring
 * (Viewer.blockedit.wiring.test.ts)は書き換えず、本要件用に新設(家風はそこに倣う)。
 *
 * 追補a(6)(7)=2026-09-14 Codex review 反映: AC-52-11(インデント付き fence の配線)
 * と AC-52-12(閉じフェンス衝突の配線)の describe を末尾に追加(既存ケースは無改変)。
 *
 * ## 判定するもの(契約番号は req-52.md の①〜⑦)
 * - **AC-52-2(契約①)**: トップレベル code fence のダブルクリックで `<pre>` の
 *   中身が Shiki の `<span>` を含まない素テキストになり、その `<pre>`(または中の
 *   `<code>`)**だけ**が contenteditable。他ブロック・コンテナは不可で、ソース編集の
 *   `<pre class="vellis-plaintext">` にも落ちない。素テキストは原文スライスの中身
 *   (開始/終了フェンス行を除いた部分)と一致。対象外(mermaid・リスト内 fence)は
 *   従来どおりソース編集モードへ誘導(契約③の配線面)
 * - **AC-52-5(契約②)**: ブロック外 mousedown で確定= `windowState.editBuffer` が
 *   「フェンス行を残して中身だけ差し替えた原文」になり dirty。Esc は破棄=原文不変・
 *   非 dirty・`<pre>` の DOM は編集前(Shiki の span ごと)へ戻る。**Enter は確定では
 *   なく改行**(改行が1つ増え、編集は続く)。何も変えずに確定しても dirty にならない
 * - **AC-52-4 の配線面(契約②)**: 確定経路でも末尾改行の規約が効く(0個/複数→1つ・
 *   空→```json\n```)
 * - **AC-52-6(契約⑦)**: fence の前の段落を #49 経路で編集して長さを変えた(伸びる/
 *   縮む両方)あとに fence を編集しても正しい範囲が差し替わる(`currentPositionOf`
 *   経路)。同じ fence の2回目の編集も正しい
 * - **AC-52-8(契約⑤)**: 編集中の Tab はタブ文字 `\t` を挿入しフォーカスを移さない
 *   (Shift+Tab は何もしない)。HTML の貼り付けはプレーンテキストとして入り、要素が
 *   混入しない
 * - **AC-52-9(契約⑦)**: 確定で立つ dirty は要件#48 と同一の状態(editMode='edit')で、
 *   ⌘S の本体 `saveDocument` が確定後の内容で `save_document` を呼び、成功後に dirty
 *   が消える
 *
 * ## 判定しないもの
 * - フェンス3分割・組み立て・対象判定の中身 → code-edit.acceptance.test.ts
 * - IME(isComposing)・編集中の見た目・確定後に色が消える見え方・Shiki 属性の
 *   引き継ぎ方 → reviewer 照合+人間ゲート(acceptance/acceptance.md 要件#52 ①〜④)
 *
 * ## JSDOM 上の編集操作について
 * JSDOM の contenteditable には既定の編集動作が無いので、Enter の改行・Tab の
 * タブ挿入・paste のテキスト挿入は Viewer 側のハンドラが Selection/Range API で
 * 明示的に行う前提で判定する(契約⑤が「Tab はタブ文字を挿入」と**動作を規定**して
 * いるため、既定動作任せでは JSDOM でも実機でも仕様を保証できない)。
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

import { invoke } from '$lib/ipc';
import { saveDocument } from '$lib/save-document';

const invokeMock = vi.mocked(invoke);

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const MD_URI = 'file:///Users/a/notes/code.md';

const JSON_BODY = '{\n  "a": 1\n}';
const JSON_FENCE = '```json\n' + JSON_BODY + '\n```';
const INTRO = 'Intro paragraph.';

/** トップレベル fence 1つ+前後の段落+対象外(リスト内 fence・mermaid)。 */
const MD = [
	'# Code Title',
	'',
	INTRO,
	'',
	'```json',
	'{',
	'  "a": 1',
	'}',
	'```',
	'',
	'Tail paragraph.',
	'',
	'- list item',
	'',
	'  ```javascript',
	'  const y = 2;',
	'  ```',
	'',
	'```mermaid',
	'graph TD;',
	'  A-->B;',
	'```',
	'',
].join('\n');

/** 編集後の中身(末尾改行なしで入力する=規約で1つ足されて保存される)。 */
const NEW_BODY = '{\n  "a": 2,\n  "b": 3\n}';
const EXPECTED_COMMIT = MD.replace(JSON_BODY, NEW_BODY);

let rendered: { html: string; index: SourceIndex };

beforeAll(async () => {
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

/** `text` を含む `<pre>`(契約④実装前は id が無いので中身で引く)。 */
function preContaining(container: HTMLElement, text: string): HTMLElement {
	const pre = [...container.querySelectorAll('pre')].find((el) =>
		(el.textContent ?? '').includes(text),
	);
	if (!pre) throw new Error(`pre が見つからない: ${text}`);
	return pre as HTMLElement;
}

/** 対象のトップレベル json fence の <pre>。 */
function jsonPre(container: HTMLElement): HTMLElement {
	return preContaining(container, '"a"');
}

/** `text` の段落。 */
function paragraphByText(container: HTMLElement, text: string): HTMLElement {
	const p = [...container.querySelectorAll('p[data-vellis-node-type="paragraph"]')].find(
		(el) => el.textContent === text,
	);
	if (!p) throw new Error(`段落が見つからない: ${text}`);
	return p as HTMLElement;
}

function isEditable(el: Element): boolean {
	return el.getAttribute('contenteditable') === 'true';
}

function editables(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll('[contenteditable="true"]')] as HTMLElement[];
}

/** ソース編集モードの `<pre>`(要件#48)。無ければ null。 */
function sourcePre(container: HTMLElement): HTMLElement | null {
	return container.querySelector('pre.vellis-plaintext');
}

/** 確定・破棄のハンドラが await を連ねても連鎖全体を確定させる(#49 wiring の家風)。 */
async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}

async function dblClick(el: HTMLElement) {
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

/**
 * fence をダブルクリックして編集に入り、編集要素(contenteditable の <pre> または
 * その中の <code>)を返す。素テキスト化に失敗している(ソース編集モードへ落ちた等)
 * ならここで落ちる。
 */
async function beginCodeEdit(container: HTMLElement): Promise<HTMLElement> {
	const pre = jsonPre(container);
	await dblClick(pre);
	const list = editables(container);
	expect(list, 'fence のダブルクリックで contenteditable が1つだけ生まれる').toHaveLength(1);
	const ed = list[0];
	// 編集要素は fence の <pre> 自身か、その中の <code>(契約①)。
	expect(ed === pre || (ed.parentElement === pre && ed.tagName.toLowerCase() === 'code')).toBe(
		true,
	);
	return ed;
}

/** 編集要素の中身を書き換える(input イベント付き)。 */
async function typeInto(ed: HTMLElement, text: string) {
	ed.textContent = text;
	await fireEvent.input(ed);
}

/** キャレットを編集要素の末尾に置く(Tab・paste・Enter の挿入位置)。 */
function placeCaretAtEnd(el: HTMLElement) {
	const doc = el.ownerDocument;
	const range = doc.createRange();
	range.selectNodeContents(el);
	range.collapse(false);
	const sel = doc.defaultView?.getSelection();
	if (!sel) throw new Error('Selection が取れない');
	sel.removeAllRanges();
	sel.addRange(range);
}

function newlineCount(text: string): number {
	return (text.match(/\n/g) ?? []).length;
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
// AC-52-2 — 素テキスト化と contenteditable の範囲(契約①③)
// ---------------------------------------------------------------------------

describe('Viewer — fence のダブルクリックで素テキストのその場編集に入る(AC-52-2・契約①)', () => {
	it('fence の <pre> の中身が span を含まない素テキストになり、その要素だけが編集可', async () => {
		const { container } = renderMarkdownDoc();
		const pre = jsonPre(container);
		// レンダー直後は Shiki の span がある(素テキスト化の前提の確認)。
		expect(pre.querySelector('span')).not.toBeNull();

		const ed = await beginCodeEdit(container);

		// 素テキスト化: span が無くなり、テキストは原文スライスの中身と一致
		// (末尾改行は規約で1つに正規化されるため、有無どちらも許す)。
		expect(ed.querySelector('span')).toBeNull();
		expect([JSON_BODY, JSON_BODY + '\n']).toContain(ed.textContent);
		// フェンス行は素テキストに含まれない(フェンス行は編集不可=契約③)。
		expect(ed.textContent).not.toContain('```');
		// 編集可になるのはこの1要素だけ。コンテナも他ブロックも不可。
		expect(isEditable(body(container))).toBe(false);
		expect(isEditable(paragraphByText(container, INTRO))).toBe(false);
		// ソース編集モードへは落ちない(#49 契約③からの置き換え=本要件の核心)。
		expect(sourcePre(container)).toBeNull();
		expect(windowState.editBuffer === null || windowState.editBuffer === MD).toBe(true);
	});

	it('mermaid とリスト内 fence は従来どおりソース編集モードへ誘導(契約③)', async () => {
		for (const pick of [
			(c: HTMLElement) => q(c, '.vellis-mermaid'),
			(c: HTMLElement) => preContaining(c, 'const y = 2;'),
		]) {
			const { container } = renderMarkdownDoc();
			const target = pick(container);

			await dblClick(target);

			expect(windowState.editMode).toBe('edit');
			const pre = sourcePre(container);
			expect(pre).not.toBeNull();
			expect(isEditable(pre as HTMLElement)).toBe(true);
			expect(pre?.textContent).toBe(MD);
			cleanup();
			windowState.endEdit();
			windowState.clearDocument();
		}
	});
});

// ---------------------------------------------------------------------------
// AC-52-5 — 確定・破棄・Enter(契約②)
// ---------------------------------------------------------------------------

describe('Viewer — ブロック外クリックで確定・Esc で破棄・Enter は改行(AC-52-5・契約②)', () => {
	it('ブロック外クリックで確定: フェンス行を残して中身だけ差し替わり dirty', async () => {
		const { container } = renderMarkdownDoc();
		const ed = await beginCodeEdit(container);
		await typeInto(ed, NEW_BODY);

		await clickOutside(container);

		expect(windowState.editBuffer).toBe(EXPECTED_COMMIT);
		expect(windowState.dirty).toBe(true);
		expect(editables(container)).toEqual([]);
		// 確定後もレンダリング結果のまま(ソース編集の <pre> に落ちない)。
		expect(sourcePre(container)).toBeNull();
	});

	it('確定はブロックの外側を 1 byte も動かさない(契約⑥)', async () => {
		const { container } = renderMarkdownDoc();
		const ed = await beginCodeEdit(container);
		await typeInto(ed, NEW_BODY);

		await clickOutside(container);

		const buffer = windowState.editBuffer ?? '';
		const start = MD.indexOf(JSON_FENCE);
		const end = start + JSON_FENCE.length;
		expect(buffer.slice(0, start)).toBe(MD.slice(0, start));
		expect(buffer.slice(buffer.length - (MD.length - end))).toBe(MD.slice(end));
		// フェンス行そのものも byte 等価で残る。
		expect(buffer.slice(start)).toMatch(/^```json\n/);
		expect(buffer).toContain('\n```\n\nTail paragraph.');
	});

	it('Esc で破棄: 原文不変・非 dirty・<pre> の DOM は編集前(span ごと)へ戻る', async () => {
		const { container } = renderMarkdownDoc();
		const pre = jsonPre(container);
		const before = pre.innerHTML;
		const ed = await beginCodeEdit(container);
		await typeInto(ed, NEW_BODY);

		await fireEvent.keyDown(ed, { key: 'Escape' });
		await settle();

		expect(windowState.currentDocument?.content).toBe(MD);
		expect(windowState.dirty).toBe(false);
		expect(windowState.editBuffer === null || windowState.editBuffer === MD).toBe(true);
		expect(editables(container)).toEqual([]);
		expect(sourcePre(container)).toBeNull();
		// DOM 復元: Shiki のハイライト構造ごと編集前へ。
		expect(jsonPre(container).innerHTML).toBe(before);
		expect(container.textContent).not.toContain('"b": 3');
	});

	it('Enter は確定ではなく改行(改行が1つ増え、編集は続く)', async () => {
		const { container } = renderMarkdownDoc();
		const ed = await beginCodeEdit(container);
		const beforeCount = newlineCount(ed.textContent ?? '');
		placeCaretAtEnd(ed);

		await fireEvent.keyDown(ed, { key: 'Enter' });
		await settle();

		// 確定していない: 編集要素が残り、dirty も立たない。
		expect(editables(container)).toHaveLength(1);
		expect(windowState.dirty).toBe(false);
		// 改行が挿入されている。
		expect(newlineCount(ed.textContent ?? '')).toBe(beforeCount + 1);
	});

	it('何も変えずにブロック外クリックしても dirty にならない', async () => {
		const { container } = renderMarkdownDoc();
		await beginCodeEdit(container);

		await clickOutside(container);

		expect(windowState.dirty).toBe(false);
		expect(editables(container)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// AC-52-4(配線面)— 末尾改行の規約(契約②)
// ---------------------------------------------------------------------------

describe('Viewer — 確定経路でも中身の末尾は改行1つ(AC-52-4・契約②)', () => {
	it('末尾改行2つで確定しても保存される中身の末尾は改行1つ', async () => {
		const { container } = renderMarkdownDoc();
		const ed = await beginCodeEdit(container);
		await typeInto(ed, 'x\n\n');

		await clickOutside(container);

		expect(windowState.editBuffer).toBe(MD.replace(JSON_FENCE, '```json\nx\n```'));
	});

	it('空にして確定すると ```json\\n```(改行なし)', async () => {
		const { container } = renderMarkdownDoc();
		const ed = await beginCodeEdit(container);
		await typeInto(ed, '');

		await clickOutside(container);

		expect(windowState.editBuffer).toBe(MD.replace(JSON_FENCE, '```json\n```'));
	});
});

// ---------------------------------------------------------------------------
// AC-52-6 — 連続編集の位置補正(契約⑦)
// ---------------------------------------------------------------------------

describe('Viewer — 連続編集でも正しい範囲が差し替わる(AC-52-6・契約⑦)', () => {
	const LONGER = 'Intro paragraph made considerably longer for this test.';
	const SHORTER = 'Intro.';

	it.each([
		['伸びる', LONGER],
		['縮む', SHORTER],
	])(
		'前の段落を #49 経路で編集して長さが%s→fence の編集が正しい範囲に当たる',
		async (_label, replacementText) => {
			const { container } = renderMarkdownDoc();
			// 1) 段落を #49 のブロック編集で確定(長さが変わる)。
			const p = paragraphByText(container, INTRO);
			await dblClick(p);
			expect(isEditable(p)).toBe(true);
			await typeInto(p, replacementText);
			await clickOutside(container);
			const afterParagraph = MD.replace(INTRO, replacementText);
			expect(windowState.editBuffer).toBe(afterParagraph);

			// 2) 続けて fence の中身を編集して確定。
			const ed = await beginCodeEdit(container);
			await typeInto(ed, NEW_BODY);
			await clickOutside(container);

			expect(windowState.editBuffer).toBe(afterParagraph.replace(JSON_BODY, NEW_BODY));
			expect(windowState.dirty).toBe(true);
		},
	);

	it('同じ fence の2回目の編集も正しい範囲に当たる', async () => {
		const { container } = renderMarkdownDoc();
		// 1回目(長さが変わる)。
		const ed1 = await beginCodeEdit(container);
		await typeInto(ed1, NEW_BODY);
		await clickOutside(container);
		expect(windowState.editBuffer).toBe(EXPECTED_COMMIT);

		// 2回目: 確定後の素テキスト表示のままの <pre> からもう一度編集に入れる。
		const ed2 = await beginCodeEdit(container);
		await typeInto(ed2, '42');
		await clickOutside(container);

		expect(windowState.editBuffer).toBe(MD.replace(JSON_BODY, '42'));
	});
});

// ---------------------------------------------------------------------------
// AC-52-8 — Tab と貼り付け(契約⑤)
// ---------------------------------------------------------------------------

describe('Viewer — 編集中の Tab と貼り付け(AC-52-8・契約⑤)', () => {
	it('Tab はタブ文字を挿入し、フォーカスを移さない。Shift+Tab は何もしない', async () => {
		const { container } = renderMarkdownDoc();
		const ed = await beginCodeEdit(container);
		expect(ed.textContent).not.toContain('\t');
		placeCaretAtEnd(ed);
		const focusedBefore = document.activeElement;
		expect(focusedBefore).toBe(ed);

		await fireEvent.keyDown(ed, { key: 'Tab' });
		await settle();

		expect(ed.textContent).toContain('\t');
		expect(document.activeElement).toBe(ed);
		// 編集は続いている(Tab で確定・離脱しない)。
		expect(editables(container)).toHaveLength(1);

		// Shift+Tab は何もしない(契約⑤)。
		const textAfterTab = ed.textContent;
		await fireEvent.keyDown(ed, { key: 'Tab', shiftKey: true });
		await settle();
		expect(ed.textContent).toBe(textAfterTab);
		expect(document.activeElement).toBe(ed);
	});

	it('HTML の貼り付けはプレーンテキストとして入り、要素が混入しない', async () => {
		const { container } = renderMarkdownDoc();
		const ed = await beginCodeEdit(container);
		placeCaretAtEnd(ed);

		await fireEvent.paste(ed, {
			clipboardData: {
				getData: (type: string) =>
					type === 'text/plain' ? 'pasted plain text' : '<b>pasted</b> <span>rich</span>',
			},
		});
		await settle();

		expect(ed.textContent).toContain('pasted plain text');
		expect(ed.querySelector('b')).toBeNull();
		expect(ed.querySelector('span')).toBeNull();
		// 編集は続いている。
		expect(editables(container)).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// AC-52-9 — dirty と ⌘S の保存経路は要件#48 の流用(契約⑦)
// ---------------------------------------------------------------------------

describe('Viewer — 確定後の dirty と保存は要件#48 の経路(AC-52-9・契約⑦)', () => {
	it('確定後は editMode=edit かつ dirty(⌘S の saveCurrentEdits の門が開く状態)', async () => {
		const { container } = renderMarkdownDoc();
		const ed = await beginCodeEdit(container);
		await typeInto(ed, NEW_BODY);

		await clickOutside(container);

		expect(windowState.editMode).toBe('edit');
		expect(windowState.dirty).toBe(true);
		expect(windowState.editBuffer).toBe(EXPECTED_COMMIT);
	});

	it('⌘S の本体 saveDocument が確定後の内容で save_document を呼び、成功後に dirty が消える', async () => {
		const { container } = renderMarkdownDoc();
		const ed = await beginCodeEdit(container);
		await typeInto(ed, NEW_BODY);
		await clickOutside(container);
		invokeMock.mockResolvedValueOnce(undefined);

		await saveDocument(MD_URI, windowState.editBuffer ?? '');

		expect(invokeMock).toHaveBeenCalledWith('save_document', {
			uri: MD_URI,
			content: EXPECTED_COMMIT,
		});
		expect(windowState.currentDocument?.content).toBe(EXPECTED_COMMIT);
		expect(windowState.dirty).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC-52-11 — インデント付き fence の配線(追補a(6)=2026-09-14 Codex review 反映)
// ---------------------------------------------------------------------------

/** インデント付き fence の素テキスト(各行の先頭から最大2スペースを除いたもの)。 */
const IND_BODY = '{\n  "a": 1\n}';
/** 原文の中で fence の中身が占める行(インデント込みの姿)。 */
const IND_BODY_RAW = '  {\n    "a": 1\n  }';

/** 2スペースでインデントされたトップレベル fence を1つ持つ文書。 */
const IND_MD = [
	'# Indent Title',
	'',
	INTRO,
	'',
	'  ```json',
	'  {',
	'    "a": 1',
	'  }',
	'  ```',
	'',
	'Tail paragraph.',
	'',
].join('\n');

describe('Viewer — インデント付き fence の素テキストと確定(AC-52-11・追補a(6))', () => {
	let renderedIndent: { html: string; index: SourceIndex };

	beforeAll(async () => {
		const result = await renderMarkdown(IND_MD, MD_URI);
		renderedIndent = { html: result.html, index: result.index };
	});

	function renderIndentDoc() {
		const doc: DocumentPayload = { uri: MD_URI, content: IND_MD, modified: 1 };
		windowState.setDocument(doc);
		return render(Viewer, {
			props: {
				document: doc,
				html: renderedIndent.html,
				index: renderedIndent.index,
				onRequestAddMark: vi.fn(),
				onToggleMarks: vi.fn(),
				marksOpen: false,
			},
		});
	}

	/** インデント付き fence をダブルクリックして編集要素を返す。 */
	async function beginIndentEdit(container: HTMLElement): Promise<HTMLElement> {
		const pre = preContaining(container, '"a": 1');
		await dblClick(pre);
		const list = editables(container);
		expect(list, 'インデント付き fence でも contenteditable が1つだけ生まれる').toHaveLength(1);
		return list[0];
	}

	it('素テキストはインデント除去済みの中身(フェンス行を含まず、ソース編集にも落ちない)', async () => {
		const { container } = renderIndentDoc();

		const ed = await beginIndentEdit(container);

		// 各行の先頭から最大2スペースを除いた素テキスト(末尾改行は有無どちらも許す)。
		expect([IND_BODY, IND_BODY + '\n']).toContain(ed.textContent);
		expect(ed.textContent).not.toContain('```');
		expect(sourcePre(container)).toBeNull();
	});

	it('確定で空行を除く各行に2スペースが付き直り、フェンス行と外側は byte 等価', async () => {
		const { container } = renderIndentDoc();
		const ed = await beginIndentEdit(container);
		// 空行を含む中身で確定(空行にはスペースを付けない)。
		await typeInto(ed, '{\n\n  "b": 2\n}');

		await clickOutside(container);

		expect(windowState.editBuffer).toBe(IND_MD.replace(IND_BODY_RAW, '  {\n\n    "b": 2\n  }'));
		expect(windowState.dirty).toBe(true);
		// 開始フェンス行(行頭のインデント込み)と終了フェンス行は原文のまま。
		expect(windowState.editBuffer).toContain('\n  ```json\n');
		expect(windowState.editBuffer).toContain('\n  ```\n\nTail paragraph.');
	});
});

// ---------------------------------------------------------------------------
// AC-52-12 — 閉じフェンス衝突の配線(追補a(7)=2026-09-14 Codex review 反映)
// ---------------------------------------------------------------------------

describe('Viewer — 閉じフェンス衝突はフェンスを長くして保存(AC-52-12・追補a(7))', () => {
	it('中身に ``` だけの行を入れて確定 → フェンスが ````json / ```` に伸びて保存される', async () => {
		const { container } = renderMarkdownDoc();
		const ed = await beginCodeEdit(container);
		await typeInto(ed, 'a\n```\nb');

		await clickOutside(container);

		expect(windowState.editBuffer).toBe(MD.replace(JSON_FENCE, '````json\na\n```\nb\n````'));
		expect(windowState.dirty).toBe(true);
	});

	it('衝突しない中身(~~~ の行)ではフェンス行は byte 等価のまま', async () => {
		const { container } = renderMarkdownDoc();
		const ed = await beginCodeEdit(container);
		await typeInto(ed, '~~~');

		await clickOutside(container);

		expect(windowState.editBuffer).toBe(MD.replace(JSON_FENCE, '```json\n~~~\n```'));
	});
});
