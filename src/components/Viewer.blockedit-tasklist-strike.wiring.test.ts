/**
 * 要件#49 追補e の受け入れテスト(docs/requirements/req-49.md「追補e」・
 * backlog 264〜267)— Viewer のブロック編集配線(component プロジェクト)
 *
 * 純関数(`serializeBlock`)の判定は src/markdown/edit-tasklist-strike.acceptance.test.ts
 * (unit 側)。ここは `Viewer.svelte` を JSDOM にマウントし、本番パイプライン(`render`)
 * の HTML と `SourceIndex` を props に渡して、**ダブルクリック→確定(ブロック外クリック)
 * → `windowState.editBuffer` / dirty** の配線を各 AC で判定する。
 * Viewer.blockedit.wiring.test.ts(AC-49-1〜31)は書き換えず、追補e 用に新設。
 *
 * ## 判定するもの
 * - **AC-49-32(契約⑥・追補e(1)(3))**: 緩いタスク項目で本文が `**bold**` で始まる段落を
 *   ダブルクリックし、何も変えずにブロック外クリック → dirty にならず editBuffer は原文の
 *   まま。末尾に文字を足して確定 → editBuffer は `- [ ] **bold** rest edited` を含み
 *   印は元の綴りのまま・dirty
 * - **AC-49-33(契約⑥・追補e(2)(3))**: 印の直後で改行した密な項目(`- [ ]\n  nl x`)と
 *   CRLF の緩い項目を、無変更の確定で dirty にならず、本文を直した確定で印・改行・字下げ・
 *   行末(`\r\n`)が元のまま(`\r` 単独の行末が残らない)
 * - **AC-49-34(契約②⑥・追補e(4))**: `Para ~~del~~ x` の段落に文字を足して確定 →
 *   例外(window の error イベント)を出さず、editBuffer に `~~del~~` のまま入り dirty。
 *   `~del~` の段落は無変更の確定で `~~del~~` に揃う
 *
 * ## 判定しないもの
 * - 逆シリアライズの中身(各ブロック種・入れ子・表セル)→ unit 側
 * - 編集中の見た目・IME → 人間ゲート
 *
 * ## スタブの設計(Viewer.blockedit.wiring.test.ts の家風)
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

const MD_URI = 'file:///Users/a/notes/tasks.md';

type Rendered = { html: string; index: SourceIndex };

/** AC-49-32: 緩いタスクリストで本文が装飾で始まる(段落の原文範囲が印を含む形)。 */
const LOOSE_DECOR_MD = [
	'# Title',
	'',
	'- [ ] **bold** rest',
	'',
	'- [x] `code` done',
	'',
	'Tail.',
	'',
].join('\n');
/** AC-49-33: 密・LF で印の直後に改行。 */
const NL_DENSE_MD = ['# Title', '', '- [ ]', '  nl x', '- [x] done', '', 'Tail.', ''].join('\n');
/** AC-49-33: 緩い・CRLF で印の直後に改行。 */
const NL_CRLF_LOOSE_MD = ['# Title', '', '- [ ]', '  nl x', '', '- [x] done', '', 'Tail.', ''].join(
	'\r\n',
);
/** AC-49-34: 取り消し線を含む段落(`~~` と 1本の `~`)。 */
const STRIKE_MD = ['# Title', '', 'Para ~~del~~ x', '', 'Single ~del~ x', '', 'Tail.', ''].join(
	'\n',
);

let renderedLooseDecor: Rendered;
let renderedNlDense: Rendered;
let renderedNlCrlfLoose: Rendered;
let renderedStrike: Rendered;

beforeAll(async () => {
	const [a, b, c, d] = await Promise.all([
		renderMarkdown(LOOSE_DECOR_MD, MD_URI),
		renderMarkdown(NL_DENSE_MD, MD_URI),
		renderMarkdown(NL_CRLF_LOOSE_MD, MD_URI),
		renderMarkdown(STRIKE_MD, MD_URI),
	]);
	renderedLooseDecor = { html: a.html, index: a.index };
	renderedNlDense = { html: b.html, index: b.index };
	renderedNlCrlfLoose = { html: c.html, index: c.index };
	renderedStrike = { html: d.html, index: d.index };
});

/** markdown 文書を windowState と Viewer の両方に載せてマウントする。 */
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

function isEditable(el: Element): boolean {
	return el.getAttribute('contenteditable') === 'true';
}

function editables(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll('[contenteditable="true"]')] as HTMLElement[];
}

/** 確定・破棄のハンドラが await を連ねても連鎖全体を確定させる。 */
async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}

/** ブロックをダブルクリックして編集に入る。 */
async function beginBlockEdit(el: HTMLElement) {
	await fireEvent.dblClick(el);
	await settle();
	expect(isEditable(el)).toBe(true);
}

/** ブロック外(見出し)をクリックして確定する。 */
async function clickOutside(container: HTMLElement) {
	const other = q(container, 'h1[data-vellis-node-type="heading"]');
	await fireEvent.mouseDown(other);
	await fireEvent.click(other);
	await settle();
}

/** ブロック末尾のテキストノードに `suffix` を足して input を発火する(末尾に打った形)。 */
async function appendText(el: HTMLElement, suffix: string) {
	const last = [...el.childNodes].reverse().find((n) => n.nodeType === Node.TEXT_NODE) as
		Text | undefined;
	if (!last) throw new Error('末尾のテキストノードが無い');
	last.data = last.data + suffix;
	await fireEvent.input(el);
}

/** `md` の中の `from`(1箇所)だけを `to` に替えた期待原文。 */
function replacedOnce(md: string, from: string, to: string): string {
	const at = md.indexOf(from);
	if (at < 0 || md.indexOf(from, at + 1) >= 0) {
		throw new Error(`期待原文の組み立てで "${from}" が一意でない`);
	}
	return md.slice(0, at) + to + md.slice(at + from.length);
}

/** 文書順の `li.task-list-item`。 */
function taskItems(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll('li.task-list-item')] as HTMLElement[];
}

/** 緩いタスク項目の段落(`li > p`)。 */
function taskParagraph(container: HTMLElement, nth: number): HTMLElement {
	const li = taskItems(container)[nth];
	if (!li) throw new Error(`タスク項目 ${nth} が無い`);
	return q(li, 'p[data-vellis-node-type="paragraph"]');
}

/** `\r` が `\n` を伴わずに現れる箇所。 */
const LONE_CR = /\r(?!\n)/;

/**
 * イベントハンドラの中で投げられた例外は JSDOM が window の `error` イベントとして
 * 報告する(テストの同期例外にはならない)。確定の配線が例外で落ちたかはここで見る。
 */
function watchWindowErrors(): { errors: ErrorEvent[]; stop: () => void } {
	const errors: ErrorEvent[] = [];
	const onError = (e: Event) => {
		errors.push(e as ErrorEvent);
		e.preventDefault();
	};
	window.addEventListener('error', onError);
	return { errors, stop: () => window.removeEventListener('error', onError) };
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
// AC-49-32 — 緩いタスク項目の印は本文の書き出しに関わらず残る(契約⑥・追補e(1)(3))
// ---------------------------------------------------------------------------

describe('Viewer — 緩いタスク項目で本文が装飾で始まる段落の確定(契約⑥・追補e(1)(3) / AC-49-32)', () => {
	it('前提の確認: 段落の先頭にチェックボックスがあり、2項目とも task-list-item', () => {
		const { container } = mountDoc(LOOSE_DECOR_MD, renderedLooseDecor);
		expect(taskItems(container)).toHaveLength(2);
		const p = taskParagraph(container, 0);
		expect(p.firstElementChild?.matches('input[type="checkbox"]')).toBe(true);
		expect(q(p, 'strong').textContent).toBe('bold');
	});

	it('(a) `- [ ] **bold** rest` の段落をダブルクリックし、何も変えずにブロック外クリック → dirty にならず原文は byte 等価', async () => {
		const { container } = mountDoc(LOOSE_DECOR_MD, renderedLooseDecor);
		await beginBlockEdit(taskParagraph(container, 0));

		await clickOutside(container);

		// 実測(2026-10-04・実装前): editBuffer が `- **bold** rest` になり dirty。
		expect(windowState.editBuffer ?? LOOSE_DECOR_MD).toBe(LOOSE_DECOR_MD);
		expect(windowState.dirty).toBe(false);
		expect(editables(container)).toEqual([]);
	});

	it('(b) 末尾に " edited" を足して確定 → editBuffer は `- [ ] **bold** rest edited`(印は元の綴り・他は byte 等価)で dirty', async () => {
		const { container } = mountDoc(LOOSE_DECOR_MD, renderedLooseDecor);
		const p = taskParagraph(container, 0);
		await beginBlockEdit(p);
		await appendText(p, ' edited');

		await clickOutside(container);

		expect(windowState.editBuffer).toBe(
			replacedOnce(LOOSE_DECOR_MD, '- [ ] **bold** rest', '- [ ] **bold** rest edited'),
		);
		expect(windowState.dirty).toBe(true);
		expect(windowState.editBuffer).not.toContain('\\[');
	});

	it('(b) `[x]` の項目(`` `code` `` 始まり)も同じ: 印 `[x]` は元の綴りのまま', async () => {
		const { container } = mountDoc(LOOSE_DECOR_MD, renderedLooseDecor);
		const p = taskParagraph(container, 1);
		await beginBlockEdit(p);
		await appendText(p, ' edited');

		await clickOutside(container);

		expect(windowState.editBuffer).toBe(
			replacedOnce(LOOSE_DECOR_MD, '- [x] `code` done', '- [x] `code` done edited'),
		);
		expect(windowState.dirty).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// AC-49-33 — 印の直後の改行が残る(契約⑥・追補e(2)(3))
// ---------------------------------------------------------------------------

describe('Viewer — 印の直後で改行したタスク項目の確定(契約⑥・追補e(2)(3) / AC-49-33)', () => {
	it('(a) 密・LF `- [ ]\\n  nl x` の li を何も変えずに確定 → dirty にならず原文は byte 等価', async () => {
		const { container } = mountDoc(NL_DENSE_MD, renderedNlDense);
		const li = taskItems(container)[0] as HTMLElement;
		expect(li.querySelector('input[type="checkbox"]')).not.toBeNull();
		await beginBlockEdit(li);

		await clickOutside(container);

		// 実測(2026-10-04・実装前): editBuffer が `- nl x` になり dirty(印が消える)。
		expect(windowState.editBuffer ?? NL_DENSE_MD).toBe(NL_DENSE_MD);
		expect(windowState.dirty).toBe(false);
	});

	it('(b) 密・LF の本文に " edited" を足して確定 → `- [ ]\\n  nl x edited`(印・改行・字下げは元のまま)で dirty', async () => {
		const { container } = mountDoc(NL_DENSE_MD, renderedNlDense);
		const li = taskItems(container)[0] as HTMLElement;
		await beginBlockEdit(li);
		await appendText(li, ' edited');

		await clickOutside(container);

		expect(windowState.editBuffer).toBe(
			replacedOnce(NL_DENSE_MD, '- [ ]\n  nl x', '- [ ]\n  nl x edited'),
		);
		expect(windowState.dirty).toBe(true);
	});

	it('(a) 緩い・CRLF `- [ ]\\r\\n  nl x` の段落を何も変えずに確定 → dirty にならず `\\r` 単独の行末が残らない', async () => {
		const { container } = mountDoc(NL_CRLF_LOOSE_MD, renderedNlCrlfLoose);
		await beginBlockEdit(taskParagraph(container, 0));

		await clickOutside(container);

		// 実測(2026-10-04・実装前): editBuffer が `- [ ]\rnl x`(`\r` 単独・字下げ落ち)になり dirty。
		const buffer = windowState.editBuffer ?? NL_CRLF_LOOSE_MD;
		expect(buffer).not.toMatch(LONE_CR);
		expect(buffer).toBe(NL_CRLF_LOOSE_MD);
		expect(windowState.dirty).toBe(false);
	});

	it('(b)(c) 緩い・CRLF の本文に " edited" を足して確定 → `- [ ]\\r\\n  nl x edited` で行末は CRLF のまま・再レンダーでタスク項目のまま', async () => {
		const { container } = mountDoc(NL_CRLF_LOOSE_MD, renderedNlCrlfLoose);
		const p = taskParagraph(container, 0);
		await beginBlockEdit(p);
		await appendText(p, ' edited');

		await clickOutside(container);

		const buffer = windowState.editBuffer ?? '';
		expect(buffer).not.toMatch(LONE_CR);
		expect(buffer).toBe(
			replacedOnce(NL_CRLF_LOOSE_MD, '- [ ]\r\n  nl x', '- [ ]\r\n  nl x edited'),
		);
		expect(windowState.dirty).toBe(true);
		const again = await renderMarkdown(buffer, MD_URI);
		const root = document.createElement('div');
		root.innerHTML = again.html;
		expect(root.querySelectorAll('li.task-list-item')).toHaveLength(2);
		expect(
			[...root.querySelectorAll('li input[type="checkbox"]')].map((i) => i.hasAttribute('checked')),
		).toEqual([false, true]);
	});
});

// ---------------------------------------------------------------------------
// AC-49-34 — 取り消し線を含むブロックを確定できる(契約②⑥・追補e(4))
// ---------------------------------------------------------------------------

describe('Viewer — 取り消し線を含む段落の確定(契約②⑥・追補e(4) / AC-49-34)', () => {
	function strikeParagraph(container: HTMLElement, text: string): HTMLElement {
		const p = [...container.querySelectorAll('p[data-vellis-node-type="paragraph"]')].find((el) =>
			(el.textContent ?? '').startsWith(text),
		);
		if (!p) throw new Error(`段落 "${text}" が無い`);
		return p as HTMLElement;
	}

	it('前提の確認: `~~del~~` も `~del~` も `del` でレンダーされている', () => {
		const { container } = mountDoc(STRIKE_MD, renderedStrike);
		expect(q(strikeParagraph(container, 'Para'), 'del').textContent).toBe('del');
		expect(q(strikeParagraph(container, 'Single'), 'del').textContent).toBe('del');
	});

	it('(b) `Para ~~del~~ x` の末尾に " more" を足して確定 → 例外を出さず editBuffer に `~~del~~` のまま入り dirty', async () => {
		const { container } = mountDoc(STRIKE_MD, renderedStrike);
		const p = strikeParagraph(container, 'Para');
		await beginBlockEdit(p);
		await appendText(p, ' more');
		const watch = watchWindowErrors();

		try {
			await clickOutside(container);
		} finally {
			watch.stop();
		}

		// 実測(2026-10-04・実装前): `serializeBlock` が ``Cannot handle unknown node `delete` ``
		// を投げ(未捕捉)、editBuffer は変わらず dirty にもならない=直した文字が黙って捨てられる。
		expect(watch.errors.map((e) => e.message)).toEqual([]);
		expect(windowState.editBuffer).toBe(
			replacedOnce(STRIKE_MD, 'Para ~~del~~ x', 'Para ~~del~~ x more'),
		);
		expect(windowState.dirty).toBe(true);
		expect(editables(container)).toEqual([]);
	});

	it('(a) `Para ~~del~~ x` を何も変えずに確定 → 例外を出さず dirty にならない', async () => {
		const { container } = mountDoc(STRIKE_MD, renderedStrike);
		await beginBlockEdit(strikeParagraph(container, 'Para'));
		const watch = watchWindowErrors();

		try {
			await clickOutside(container);
		} finally {
			watch.stop();
		}

		expect(watch.errors.map((e) => e.message)).toEqual([]);
		expect(windowState.editBuffer ?? STRIKE_MD).toBe(STRIKE_MD);
		expect(windowState.dirty).toBe(false);
	});

	it('`Single ~del~ x`(1本)を何も変えずに確定 → editBuffer では `~~del~~` に揃い、他は byte 等価', async () => {
		const { container } = mountDoc(STRIKE_MD, renderedStrike);
		await beginBlockEdit(strikeParagraph(container, 'Single'));
		const watch = watchWindowErrors();

		try {
			await clickOutside(container);
		} finally {
			watch.stop();
		}

		expect(watch.errors.map((e) => e.message)).toEqual([]);
		expect(windowState.editBuffer).toBe(
			replacedOnce(STRIKE_MD, 'Single ~del~ x', 'Single ~~del~~ x'),
		);
	});
});
